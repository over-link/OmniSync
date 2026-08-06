/**
 * services/syncService.js
 * Orchestrates the actual sync between one Revizto project and one ACC
 * project. sync_map now lives in Postgres instead of syncMap.json, so it
 * survives restarts and is visible from any machine/instance.
 */
const pool = require('../db/pool');
const accService = require('./accService');
const reviztoService = require('./reviztoService');
const fieldMapping = require('./fieldMapping');
const tokenStore = require('./tokenStore');

// ─── sync_map helpers ────────────────────────────────────────────────

async function getAccIdForRevizto(projectId, reviztoIssueId) {
  const { rows } = await pool.query(
    'SELECT acc_issue_id FROM sync_map WHERE project_id = $1 AND revizto_issue_id = $2',
    [projectId, String(reviztoIssueId)]
  );
  return rows[0]?.acc_issue_id || null;
}

async function getReviztoIdForAcc(projectId, accIssueId) {
  const { rows } = await pool.query(
    'SELECT revizto_issue_id FROM sync_map WHERE project_id = $1 AND acc_issue_id = $2',
    [projectId, accIssueId]
  );
  return rows[0]?.revizto_issue_id || null;
}

async function recordLink(projectId, reviztoIssueId, accIssueId) {
  await pool.query(
    `INSERT INTO sync_map (project_id, revizto_issue_id, acc_issue_id, last_synced_at, last_error, last_error_at)
     VALUES ($1, $2, $3, now(), NULL, NULL)
     ON CONFLICT (project_id, revizto_issue_id) DO UPDATE SET
       acc_issue_id = EXCLUDED.acc_issue_id, last_synced_at = now(), last_error = NULL, last_error_at = NULL`,
    [projectId, String(reviztoIssueId), accIssueId]
  );
}

async function clearSyncError(projectId, reviztoIssueId) {
  await pool.query(
    'UPDATE sync_map SET last_error = NULL, last_error_at = NULL, last_synced_at = now() WHERE project_id = $1 AND revizto_issue_id = $2',
    [projectId, String(reviztoIssueId)]
  );
}

async function recordSyncError(projectId, reviztoIssueId, message) {
  // Only meaningful for issues that are already linked (have a sync_map
  // row) — an issue that failed before ever being linked has nowhere to
  // persist the error against, and still shows the failure transiently
  // in the UI response instead.
  await pool.query(
    'UPDATE sync_map SET last_error = $3, last_error_at = now() WHERE project_id = $1 AND revizto_issue_id = $2',
    [projectId, String(reviztoIssueId), message]
  );
}

// ─── assignee resolution (email -> Autodesk user ID) ─────────────────

async function makeAssigneeResolver(userId, project) {
  const { rows: manualRows } = await pool.query(
    'SELECT email, acc_autodesk_id FROM user_map WHERE project_id = $1',
    [project.id]
  );
  const manualMap = Object.fromEntries(manualRows.map((r) => [r.email.toLowerCase(), r.acc_autodesk_id]));

  let apiMap = null;
  return async (email) => {
    const key = email.toLowerCase();
    if (manualMap[key]) return manualMap[key];
    if (!apiMap) {
      try {
        const members = await accService.getProjectMembers(userId, project);
        apiMap = {};
        for (const m of members) if (m.email && m.autodeskId) apiMap[m.email.toLowerCase()] = m.autodeskId;
      } catch (err) {
        // Construction Admin API access is separate from Issues API access
        // — a user can create issues without being able to list project
        // members. Don't let that block the issue push; just skip the
        // assignee for this run.
        console.warn('[sync] Could not look up ACC project members (skipping assignee):', err.response?.data?.detail || err.message);
        apiMap = {};
      }
    }
    return apiMap[key] || null;
  };
}

// ─── location resolution (Revizto level name -> ACC location node ID) ─

/**
 * Same lazy-fetch-once-then-cache-in-closure shape as makeAssigneeResolver:
 * fetches the project's ACC Location Breakdown Structure at most once per
 * push run, matches by node name (case-insensitive). A project with no
 * Locations tree configured, or a level name with no matching node, just
 * means locationId doesn't get set — not a failure of the push.
 */
async function makeLocationResolver(userId, project) {
  let nodesByName = null;
  return async (levelName) => {
    if (!nodesByName) {
      try {
        const nodes = await accService.getLocationNodes(userId, project);
        nodesByName = {};
        for (const n of nodes) if (n.name) nodesByName[n.name.toLowerCase()] = n.id;
        // Visible even on the success path, unlike most resolvers here —
        // this lookup was never confirmed against real ACC data, so seeing
        // "0 nodes" vs "12 nodes: Level 1, Level 2, ..." in the log is the
        // fastest way to tell "no Locations tree configured" apart from
        // "tree exists but names don't match" without guessing.
        console.log(`[sync] ACC Locations for project "${project.name}": ${nodes.length} node(s)${nodes.length ? ' — ' + nodes.map((n) => n.name).join(', ') : ''}`);
      } catch (err) {
        console.warn('[sync] Could not look up ACC locations (skipping location mapping):', err.response?.data?.detail || err.message);
        nodesByName = {};
      }
    }
    const match = nodesByName[levelName.toLowerCase()] || null;
    if (!match) {
      console.warn(`[sync] No ACC location node matches Revizto level "${levelName}" for project "${project.name}".`);
    }
    return match;
  };
}

// ─── custom attribute resolution (title -> ACC attribute definition) ──

// Only these ACC custom fields are touched by this sync — deliberately
// not looking up every custom field in the project, both to avoid noise
// and to avoid the sync reaching into fields it has no business managing.
const MANAGED_CUSTOM_FIELDS = ['Grid Intersection', 'Room', 'Tags', 'Revizto ID', 'Issue Priority'];

/**
 * Same lazy-fetch-once-then-cache-in-closure shape as makeLocationResolver,
 * restricted to MANAGED_CUSTOM_FIELDS. Also checks issue-attribute-mappings:
 * a field existing in the project does NOT mean it's usable on every issue
 * — ACC scopes each custom field to specific issue subtypes (or the whole
 * project via a "container"-level mapping), and rejects a value for a
 * field that isn't mapped to that issue's subtype (confirmed by real
 * testing: "custom attribute definition is deleted or unmapped"). Returns
 * the resolver as async (title, subtypeId) => definition | null.
 * issueContext ({ reviztoIssueId, accIssueId }) is just for logging — so
 * an "isn't mapped" warning names the specific issue to go check in ACC,
 * instead of leaving you guessing which of several linked issues it was.
 */
async function makeCustomAttributeResolver(userId, project, issueContext = {}) {
  let defsByTitle = null;
  let mappingsByAttrId = null;
  let issueTypeIdBySubtypeId = null;
  return async (title, subtypeId) => {
    if (!defsByTitle) {
      try {
        const [defs, mappings, subtypes] = await Promise.all([
          accService.getIssueAttributeDefinitions(userId, project),
          accService.getIssueAttributeMappings(userId, project),
          accService.getIssueSubtypes(userId, project),
        ]);
        // ACC lets a custom field be enabled per specific subtype OR per
        // parent issue type (which then covers all its subtypes) — need
        // this lookup to check the issueType-level case too, below.
        issueTypeIdBySubtypeId = Object.fromEntries(subtypes.map((s) => [s.id, s.issueTypeId]));
        defsByTitle = {};
        for (const d of defs) {
          if (d.title && MANAGED_CUSTOM_FIELDS.some((t) => t.toLowerCase() === d.title.toLowerCase())) {
            defsByTitle[d.title.toLowerCase()] = d;
          }
        }
        mappingsByAttrId = {};
        for (const m of mappings) {
          if (!mappingsByAttrId[m.attributeDefinitionId]) mappingsByAttrId[m.attributeDefinitionId] = [];
          mappingsByAttrId[m.attributeDefinitionId].push(m);
        }
        const found = Object.values(defsByTitle);
        // For list-type fields, show the actual option labels too — the
        // fastest way to compare against Revizto's raw value and spot a
        // naming mismatch (e.g. Revizto's "Normal" vs ACC's "Medium")
        // without another round trip.
        const describe = (d) =>
          d.dataType === 'list'
            ? `${d.title} (list: ${(d.metadata?.list?.options || []).map((o) => o.value ?? o.label).join(' / ') || 'no options found'})`
            : `${d.title} (${d.dataType})`;
        console.log(`[sync] ACC managed custom fields for project "${project.name}": ${found.length ? found.map(describe).join(', ') : 'none of ' + MANAGED_CUSTOM_FIELDS.join(', ') + ' found'}`);
      } catch (err) {
        console.warn('[sync] Could not look up ACC custom field definitions (skipping grid/room/tags/revizto-id mapping):', err.response?.data?.detail || err.message);
        defsByTitle = {};
        mappingsByAttrId = {};
        issueTypeIdBySubtypeId = {};
      }
    }
    const def = defsByTitle[title.toLowerCase()] || null;
    if (!def) {
      console.warn(`[sync] No ACC custom field named "${title}" found for project "${project.name}".`);
      return null;
    }
    const attrMappings = mappingsByAttrId[def.id] || [];
    const issueTypeId = issueTypeIdBySubtypeId[subtypeId] || null;
    const applicable = attrMappings.some(
      (m) =>
        m.mappedItemType === 'container' ||
        (m.mappedItemType === 'issueSubtype' && m.mappedItemId === subtypeId) ||
        (m.mappedItemType === 'issueType' && issueTypeId && m.mappedItemId === issueTypeId)
    );
    if (!applicable) {
      // TEMP DEBUG: the "checked in ACC" vs "still shows unmapped"
      // mismatch reported during testing means one of our assumptions
      // about mappedItemType/mappedItemId is wrong — dump the raw
      // mapping entries for this specific field so we can see the actual
      // values instead of guessing further.
      console.log(`[sync] Raw ACC mappings for "${title}" (attributeDefinitionId ${def.id}), issue subtype ${subtypeId}, issue type ${issueTypeId}:`, JSON.stringify(attrMappings));
      const { reviztoIssueId, accIssueId } = issueContext;
      const issueLabel = accIssueId
        ? `ACC issue ${accIssueId} (Revizto #${reviztoIssueId ?? '?'})`
        : `Revizto issue #${reviztoIssueId ?? '?'}`;
      console.warn(`[sync] ACC custom field "${title}" exists but isn't mapped to this issue's subtype (subtype ${subtypeId}) — skipping for ${issueLabel} in project "${project.name}".`);
      return null;
    }
    return def;
  };
}

// ─── Push: Revizto issue -> ACC (create or update) ────────────────────

async function pushIssueToAcc(userId, project, reviztoIssue) {
  const existingAccId = await getAccIdForRevizto(project.id, reviztoIssue.id);

  const subtypes = await accService.getIssueSubtypes(userId, project);
  const subtypeLookup = Object.fromEntries(subtypes.map((s) => [`${s.issueTypeTitle} > ${s.title}`, s.id]));

  const [customStatusMap, customTypeMap] = await Promise.all([
    fieldMapping.getStatusMap(project.id),
    fieldMapping.getTypeMap(project.id),
  ]);

  // customStatusName is a plain, ready-to-use string Revizto returns
  // alongside the UUID version (customStatus) — confirmed from a real raw
  // issue response. No UUID resolution needed for this.
  const reviztoStatusName = reviztoService.unwrap(reviztoIssue.customStatusName) ?? null;

  // Resolves email -> Autodesk user ID for both assignee and watchers.
  // Was disabled for a while after an earlier bug where a failure here
  // (Construction Admin API access, separate from Issues API access)
  // took down the whole push — that's fixed (see makeAssigneeResolver's
  // try/catch), so this is safe to re-enable. Still genuinely unverified
  // whether Construction Admin API requires the ACC Custom Integration
  // the same way Data Management API discovery did — if this starts
  // failing broadly, that's the first thing to check.
  const assigneeResolver = await makeAssigneeResolver(userId, project);

  // Resolves Revizto's level name to an ACC location node ID, matching
  // against the project's own configured Location Breakdown Structure.
  const locationResolver = await makeLocationResolver(userId, project);

  // Resolves a custom field title (e.g. "Grid", "Room") to its ACC
  // attribute definition ID — ACC has no native fields for these, unlike
  // level/zone. issueContext is just so an "isn't mapped" warning can name
  // this specific issue.
  const customAttributeResolver = await makeCustomAttributeResolver(userId, project, {
    reviztoIssueId: reviztoIssue.id,
    accIssueId: existingAccId,
  });

  const payload = await reviztoService.toAccIssue(reviztoIssue, {
    subtypeLookup,
    defaultSubtypeId: project.acc_default_subtype_id,
    customStatusMap,
    customTypeMap,
    reviztoStatusName,
    assigneeResolver,
    locationResolver,
    customAttributeResolver,
  });

  let accIssueId;
  if (existingAccId) {
    const updated = await accService.updateIssue(userId, project, existingAccId, payload);
    await clearSyncError(project.id, reviztoIssue.id);
    accIssueId = existingAccId;
  } else {
    const created = await accService.createIssue(userId, project, payload);
    await recordLink(project.id, reviztoIssue.id, created.id);
    accIssueId = created.id;
  }

  // Fetch comments ONCE and share between comment-push and markup-push —
  // was calling this twice per issue per cycle before, which contributed
  // to a real 429 rate-limit error hit during testing.
  let sharedComments = null;
  if (!project.revizto_project_id) {
    console.warn(`[sync] Project "${project.name}" has no numeric revizto_project_id set — skipping comment/markup sync. Set it on the Setup page.`);
  } else {
    try {
      sharedComments = await reviztoService.getIssueComments(
        userId,
        project.revizto_region,
        reviztoIssue.uuid,
        project.revizto_project_id
      );
    } catch (err) {
      console.warn(`[sync] Could not fetch comments for issue ${reviztoIssue.id} (skipping comment/markup sync):`, err.message);
    }
  }
  if (sharedComments) {
    await _pushLatestCommentToAcc(userId, project, reviztoIssue, accIssueId, sharedComments);
    await _pushMarkupImageToAcc(userId, project, reviztoIssue, accIssueId, sharedComments);
  }

  return existingAccId ? { action: 'updated', accIssue: { id: accIssueId } } : { action: 'created', accIssue: { id: accIssueId } };
}

/**
 * Pushes only the LATEST Revizto text comment to ACC, mirroring the
 * existing ACC->Revizto direction (which also only pulls the latest).
 * Skips if the same comment was already pushed last time (tracked via
 * sync_map.last_pushed_comment_uuid), so the 2-minute auto-resync doesn't
 * repost it every cycle. UNCONFIRMED: the `text` field name on a GET
 * comment response is extrapolated from the POST/write shape, not
 * confirmed from real GET response data — check if pushed comments show
 * up blank/garbled.
 */
/**
 * Uploads the Revizto issue's largest preview image (a rendered snapshot
 * of the markup, not editable vector data — no cross-platform editable
 * markup is feasible between two different systems) as an attachment on
 * the linked ACC issue. Only uploads once per issue (tracked via
 * sync_map.markup_uploaded), not on every re-sync.
 *
 * UNCONFIRMED / HIGHER RISK than most of this app: the attachment upload
 * pipeline (accService.attachImageToIssue) is built from an official
 * Autodesk tutorial but has not been tested end-to-end. Wrapped in
 * try/catch so a failure here doesn't take down the rest of the push —
 * check server logs for the real error if this doesn't work on first try.
 */
async function _pushMarkupImageToAcc(userId, project, reviztoIssue, accIssueId, comments) {
  try {
    const { rows } = await pool.query(
      'SELECT last_markup_comment_uuid FROM sync_map WHERE project_id = $1 AND revizto_issue_id = $2',
      [project.id, String(reviztoIssue.id)]
    );

    // The markup COMMENT's preview includes actual drawings — confirmed
    // from real docs ("includes all drawings that were added to it").
    // The issue's own top-level `preview` field does NOT include
    // drawings (just the base viewpoint) — only used here as a fallback
    // for issues that have no markup comment yet, so we still attach
    // something rather than nothing.
    const markupComment = reviztoService.findLatestMarkupComment(comments);

    let previewUrl, trackingId;
    if (markupComment) {
      if (markupComment.uuid === rows[0]?.last_markup_comment_uuid) return; // already uploaded this exact markup version
      previewUrl = markupComment.preview?.original;
      trackingId = markupComment.uuid;
    } else {
      if (rows[0]?.last_markup_comment_uuid) return; // already uploaded the fallback once; don't re-upload every cycle
      previewUrl = reviztoIssue.preview?.large;
      trackingId = 'fallback-issue-preview';
    }
    if (!previewUrl) return;

    await accService.attachImageToIssue(userId, project, accIssueId, previewUrl, `Revizto Issue ${reviztoIssue.id} Markup`);
    await pool.query('UPDATE sync_map SET last_markup_comment_uuid = $3 WHERE project_id = $1 AND revizto_issue_id = $2', [
      project.id,
      String(reviztoIssue.id),
      trackingId,
    ]);
  } catch (err) {
    console.warn(`[sync] Could not upload markup image for issue ${reviztoIssue.id} (skipping):`, err.message);
  }
}

async function _pushLatestCommentToAcc(userId, project, reviztoIssue, accIssueId, comments) {
  try {
    const latest = reviztoService.findLatestTextComment(comments);
    if (!latest) return;

    const { rows } = await pool.query(
      'SELECT last_pushed_comment_uuid FROM sync_map WHERE project_id = $1 AND revizto_issue_id = $2',
      [project.id, String(reviztoIssue.id)]
    );
    if (rows[0]?.last_pushed_comment_uuid === latest.uuid) return; // already pushed

    // Same ping-pong protection as the ACC->Revizto direction: a comment
    // WE pushed ACC->Revizto becomes this issue's new "latest text
    // comment," which would otherwise look like a genuine new Revizto
    // comment and get pushed right back to ACC. Mark it seen without
    // re-pushing.
    if ((latest.text || '').includes('- synced from ACC')) {
      await pool.query(
        'UPDATE sync_map SET last_pushed_comment_uuid = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
        [project.id, String(reviztoIssue.id), latest.uuid]
      );
      return;
    }

    await accService.addComment(userId, project, accIssueId, `${latest.text || ''} - synced from Revizto`);
    await pool.query(
      'UPDATE sync_map SET last_pushed_comment_uuid = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
      [project.id, String(reviztoIssue.id), latest.uuid]
    );
  } catch (err) {
    console.warn(`[sync] Could not push latest comment for issue ${reviztoIssue.id} (skipping):`, err.response?.data || err.message);
  }
}

async function pushAllOpenIssues(userId, project) {
  const issues = await reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid);
  return _pushIssueList(userId, project, issues);
}

/**
 * Push only specific Revizto issues (by ID), chosen by the user in the UI,
 * rather than everything open in the project.
 */
async function pushSelectedIssues(userId, project, issueIds) {
  const wanted = new Set(issueIds.map(String));
  const allIssues = await reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid);
  const selected = allIssues.filter((issue) => wanted.has(String(issue.id)));
  return _pushIssueList(userId, project, selected);
}

async function _pushIssueList(userId, project, issues) {
  const results = [];
  for (const issue of issues) {
    try {
      results.push({ reviztoId: issue.id, ...(await pushIssueToAcc(userId, project, issue)) });
    } catch (err) {
      const message = err.response?.data?.errors?.[0]?.detail || err.message;
      console.error(`[sync] Failed to push Revizto issue ${issue.id} to ACC:`, JSON.stringify(err.response?.data) || err.message);
      // Only persists if this issue already has a sync_map row (i.e. was
      // already linked) — a brand-new link that fails on first attempt
      // has nowhere to persist against yet, and just shows transiently.
      await recordSyncError(project.id, issue.id, message).catch(() => {});
      results.push({ reviztoId: issue.id, action: 'error', error: message });
    }
  }
  return results;
}

/**
 * Re-push every issue that's already linked (has a sync_map row) for a
 * project — this is what the 2-minute poller calls. Unlike
 * pushAllOpenIssues, this never creates new links; it only updates
 * issues the user has already chosen to link.
 */
async function pushLinkedIssues(userId, project) {
  const { rows } = await pool.query('SELECT revizto_issue_id FROM sync_map WHERE project_id = $1', [project.id]);
  if (!rows.length) return [];
  const results = [];
  for (const row of rows) {
    try {
      const issue = await reviztoService.getIssue(userId, project.revizto_region, project.revizto_project_uuid, row.revizto_issue_id);
      results.push({ reviztoId: issue.id, ...(await pushIssueToAcc(userId, project, issue)) });
    } catch (err) {
      const message = err.response?.data?.errors?.[0]?.detail || err.message;
      console.error(`[sync] Failed to re-push linked issue ${row.revizto_issue_id}:`, JSON.stringify(err.response?.data) || err.message);
      await recordSyncError(project.id, row.revizto_issue_id, message).catch(() => {});
      results.push({ reviztoId: row.revizto_issue_id, action: 'error', error: message });
    }
  }
  return results;
}

/**
 * For the two-column UI: current state of every linked issue on both
 * sides, so the person can see Revizto's version next to ACC's version.
 */
async function getLinkedIssuePairs(userId, project) {
  const { rows } = await pool.query('SELECT revizto_issue_id, acc_issue_id FROM sync_map WHERE project_id = $1', [project.id]);
  const pairs = [];
  for (const row of rows) {
    let reviztoSide = null;
    let accSide = null;
    try {
      const issue = await reviztoService.getIssue(userId, project.revizto_region, project.revizto_project_uuid, row.revizto_issue_id);
      reviztoSide = { title: issue.title?.value ?? issue.title, status: issue.status?.value ?? issue.status };
    } catch (err) {
      reviztoSide = { error: err.message };
    }
    try {
      const issue = await accService.getIssue(userId, project, row.acc_issue_id);
      accSide = { title: issue.title, status: issue.status };
    } catch (err) {
      accSide = { error: err.message };
    }
    pairs.push({ reviztoIssueId: row.revizto_issue_id, accIssueId: row.acc_issue_id, revizto: reviztoSide, acc: accSide });
  }
  return pairs;
}

// ─── Pull: ACC webhook event -> Revizto ───────────────────────────────

async function handleAccWebhook(userId, project, payload, reporterEmail) {
  // Confirmed from a real webhook delivery: payload.id is the clean ACC
  // issue ID directly. The old fallback (parsing resourceUrn by splitting
  // on '/') was actually broken — resourceUrn is colon-delimited
  // ("urn:adsk.issues:issues.issue:<id>"), so splitting on '/' returned
  // the whole URN unchanged, not the ID. Fixed the fallback to split on
  // ':' instead, in case payload.id is ever absent.
  const accIssueId = payload?.id || payload?.resourceUrn?.split(':').pop();
  if (!accIssueId) throw new Error('Webhook payload missing issue ID');

  const reviztoIssueId = await getReviztoIdForAcc(project.id, accIssueId);
  const accIssue = await accService.getIssue(userId, project, accIssueId);

  if (!reviztoIssueId) {
    // New issue created directly in ACC — not yet linked to a Revizto issue.
    // We don't auto-create in Revizto without a clear source-of-truth
    // decision (see README "Known limitations"); log and skip for now.
    console.log(`[sync] ACC issue ${accIssueId} has no linked Revizto issue — skipping pull (create-in-Revizto not yet wired up).`);
    return { action: 'skipped', reason: 'no linked Revizto issue' };
  }

  const newStatus = reviztoService.mapStatusFromAcc(accIssue.status);
  await reviztoService.updateIssueStatus(
    userId,
    project.revizto_region,
    project.revizto_project_uuid,
    reviztoIssueId,
    newStatus,
    reporterEmail
  );

  // Assignee/watchers: ACC gives us Autodesk user IDs, Revizto needs
  // emails — resolve via the same project members list already used for
  // the forward (Revizto->ACC) direction, just inverted. Wrapped in its
  // own try/catch so a resolution failure here doesn't take down the
  // status update above, which already succeeded.
  try {
    const members = await accService.getProjectMembers(userId, project);
    const emailByAutodeskId = Object.fromEntries(
      members.filter((m) => m.autodeskId && m.email).map((m) => [m.autodeskId, m.email])
    );

    const assignedToId = payload?.assignedTo;
    if (assignedToId) {
      const email = emailByAutodeskId[assignedToId];
      if (email) {
        await reviztoService.updateIssueAssignee(userId, project.revizto_region, project.revizto_project_uuid, reviztoIssueId, email, reporterEmail);
      } else {
        console.warn('[webhook] Could not resolve ACC assignee to an email (not found in project members):', assignedToId);
      }
    }

    const watcherIds = Array.isArray(payload?.watchers) ? payload.watchers : [];
    if (watcherIds.length) {
      const watcherEmails = watcherIds.map((id) => emailByAutodeskId[id]).filter(Boolean);
      if (watcherEmails.length) {
        await reviztoService.updateIssueWatchers(userId, project.revizto_region, project.revizto_project_uuid, reviztoIssueId, watcherEmails, reporterEmail);
      }
    }
  } catch (err) {
    console.warn('[webhook] Could not sync assignee/watchers back to Revizto (skipping):', err.response?.data?.message || err.message);
  }

  // Priority (ACC "Issue Priority" custom field -> Revizto's priority
  // field), the reverse direction of the Revizto->ACC mapping in
  // toAccIssue. CONFIRMED BY REAL TESTING (not the docs' implication):
  // for a list-type field, accIssue.customAttributes[].value is the raw
  // OPTION ID (e.g. "fe69a532-..."), not its display label — Revizto
  // rejected that UUID outright when sent as-is ("Invalid method
  // parameters"). Resolved back to the option's label via the same
  // definition metadata used for the forward direction, then lowercased
  // to match Revizto's own value format (its "old" value came back as
  // lowercase "minor", not ACC's title-case "Minor"). Wrapped separately
  // from assignee/watchers so a failure here doesn't block that sync.
  try {
    const priorityAttr = (accIssue.customAttributes || []).find((a) => (a.title || '').toLowerCase() === 'issue priority');
    if (priorityAttr && priorityAttr.value != null && priorityAttr.value !== '') {
      let priorityValue = priorityAttr.value;
      const defs = await accService.getIssueAttributeDefinitions(userId, project);
      const priorityDef = defs.find((d) => (d.title || '').toLowerCase() === 'issue priority');
      if (priorityDef?.dataType === 'list') {
        const options = priorityDef.metadata?.list?.options || [];
        const match = options.find((o) => o.id === priorityAttr.value);
        if (match) {
          priorityValue = String(match.value ?? match.label ?? priorityAttr.value).toLowerCase();
        } else {
          console.warn(`[webhook] ACC priority option ID "${priorityAttr.value}" not found in "Issue Priority"'s option list — sending as-is.`);
        }
      }
      await reviztoService.updateIssuePriority(
        userId,
        project.revizto_region,
        project.revizto_project_uuid,
        reviztoIssueId,
        priorityValue,
        reporterEmail
      );
    }
  } catch (err) {
    console.warn('[webhook] Could not sync priority back to Revizto (skipping):', err.response?.data?.message || err.message);
  }

  // Comment pulling from ACC happens via pollAccCommentsForProject (see
  // pollService.js), not here — accIssue.comments never populated from
  // this base GET (confirmed: comments are a separate endpoint), so this
  // block was dead code and has been removed.

  return { action: 'pulled', reviztoIssueId, newStatus };
}

/**
 * For the Issues page: every Revizto issue in the project, with its link
 * status (if linked, includes the ACC side's current title/status too),
 * plus fields the UI filters on.
 *
 * FIELD NAMES UNVERIFIED: `stamp`, `stampCategory`, `type`, and `assignee`
 * below are best-guess field paths on Revizto's raw issue object — we
 * don't have confirmed docs for these (unlike title/status/deadline, which
 * came from working code). If filters show blank/wrong values once you
 * have real data, check what field names Revizto's issue-filter response
 * actually uses and fix the `unwrap(...)` calls below accordingly.
 */
async function getIssuesBoard(userId, project) {
  const [issues, linkRows, stampPresets, reviztoTokens] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    pool.query('SELECT revizto_issue_id, acc_issue_id FROM sync_map WHERE project_id = $1', [project.id]).then((r) => r.rows),
    reviztoService.getStampPresets(userId, project.revizto_region, project.revizto_project_uuid).catch(() => []),
    tokenStore.getReviztoTokens(userId),
  ]);
  const linkMap = new Map(linkRows.map((r) => [String(r.revizto_issue_id), r.acc_issue_id]));
  const { byAbbr: stampCategoryByAbbr } = reviztoService.buildStampCategoryLookup(stampPresets);
  const stampTitleByAbbr = reviztoService.buildStampTitleLookup(stampPresets);

  // Resolve assignee email -> display name via the license's member list.
  // Uses the CALLING USER's own saved license (from their Revizto
  // connection) as the license context — assumes the project was set up
  // under that same license, which is true for the normal "browse my
  // Revizto projects" setup flow. Falls back to showing the bare email if
  // license isn't set or the person isn't found (e.g. assigned but not a
  // license member, or a different license than assumed).
  let assigneeNameByEmail = {};
  if (reviztoTokens?.license_id) {
    try {
      const members = await reviztoService.getLicenseMembers(userId, project.revizto_region, reviztoTokens.license_id);
      assigneeNameByEmail = reviztoService.buildMemberNameLookup(members);
    } catch (err) {
      console.warn('[issues-board] Could not fetch license members for assignee names:', err.response?.data?.message || err.message);
    }
  }

  const board = [];
  for (const issue of issues) {
    const accIssueId = linkMap.get(String(issue.id)) || null;
    let acc = null;
    if (accIssueId) {
      try {
        const accIssue = await accService.getIssue(userId, project, accIssueId);
        acc = { id: accIssueId, title: accIssue.title, status: accIssue.status };
      } catch (err) {
        acc = { id: accIssueId, error: err.response?.data?.detail || err.message };
      }
    }
    // customStatusName / customTypeName are plain, ready-to-display strings
    // Revizto returns alongside the UUID versions (customStatus/customType)
    // — confirmed from a real raw issue response, no resolution needed.
    const stampAbbr = reviztoService.unwrap(issue.stampAbbr) ?? null; // was incorrectly `issue.stamp` (doesn't exist)
    const assigneeEmail = reviztoService.unwrap(issue.assignee) ?? null;
    board.push({
      id: issue.id,
      title: reviztoService.unwrap(issue.title) || '(no title)',
      status: reviztoService.unwrap(issue.customStatusName) ?? null,
      issueType: reviztoService.unwrap(issue.customTypeName) ?? null,
      // Display the stamp's human-readable title, not its raw abbreviation
      // (the abbreviation is still what's used internally for type-mapping
      // matching in toAccIssue — this is display-only).
      stamp: stampAbbr ? stampTitleByAbbr[stampAbbr] || stampAbbr : null,
      stampCategory: stampAbbr ? stampCategoryByAbbr[stampAbbr] || null : null,
      // Show the resolved display name when we have one; fall back to the
      // raw email (still used as the filter's matching value either way,
      // so filtering behavior is unaffected by whether resolution worked).
      assignee: assigneeEmail ? assigneeNameByEmail[assigneeEmail.toLowerCase()] || assigneeEmail : null,
      tags: reviztoService.unwrap(issue.tags) || [],
      linked: !!accIssueId,
      acc,
    });
  }
  return board;
}

/**
 * Sync health stats for a project — issue counts on both sides, how many
 * are linked, how many linked issues currently have an unresolved sync
 * error. Open to any user (not admin-only) since this shows on the
 * Issues page for everyone, and later the Analytics page.
 */
async function getSyncStats(userId, project) {
  const [reviztoIssues, accIssues, syncRows] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    accService.getIssues(userId, project).catch(() => []),
    pool.query('SELECT last_error FROM sync_map WHERE project_id = $1', [project.id]).then((r) => r.rows),
  ]);
  const errorCount = syncRows.filter((r) => r.last_error).length;
  return {
    reviztoCount: reviztoIssues.length,
    accCount: accIssues.length,
    syncedCount: syncRows.length,
    errorCount,
  };
}

/**
 * Polling-based ACC->Revizto comment sync — no webhook event exists for
 * comments (confirmed: Autodesk's Supported Events Reference only lists
 * issue.created/updated/deleted/restored/unlinked for Construction
 * Issues, nothing comment-specific), so this has to actively check
 * rather than react to a push notification. Called on the same 2-minute
 * cycle as the existing Revizto->ACC auto-resync.
 */
async function pollAccCommentsForProject(userId, project, reporterEmail) {
  const { rows } = await pool.query(
    'SELECT revizto_issue_id, acc_issue_id, last_pulled_acc_comment_id FROM sync_map WHERE project_id = $1',
    [project.id]
  );
  for (const row of rows) {
    try {
      const comments = await accService.getIssueComments(userId, project, row.acc_issue_id);
      if (!comments.length) continue;
      const latest = comments[comments.length - 1];
      const latestId = latest.id || latest.commentId;
      // String() coercion is deliberate: ACC's comment ID is likely a
      // number, but row.last_pulled_acc_comment_id always comes back as
      // a string from the TEXT column — a strict === would silently fail
      // every single comparison (12345 !== "12345"), causing the same
      // comment to re-push every poll cycle forever.
      if (!latestId || String(latestId) === String(row.last_pulled_acc_comment_id)) continue; // nothing new

      const commentText = latest.body || latest.text || '';
      // Prevents an infinite ping-pong: a comment WE pushed Revizto->ACC
      // becomes ACC's new "latest comment," which would otherwise look
      // like a genuine new ACC comment on the next poll and get pushed
      // right back into Revizto with another tag stacked on. Mark it
      // seen (so we stop re-checking it) without re-pushing it.
      if (commentText.includes('- synced from Revizto')) {
        await pool.query(
          'UPDATE sync_map SET last_pulled_acc_comment_id = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
          [project.id, row.revizto_issue_id, latestId]
        );
        continue;
      }

      await reviztoService.addComment(
        userId,
        project.revizto_region,
        project.revizto_project_uuid,
        row.revizto_issue_id,
        `${commentText} - synced from ACC`,
        reporterEmail
      );
      await pool.query(
        'UPDATE sync_map SET last_pulled_acc_comment_id = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
        [project.id, row.revizto_issue_id, latestId]
      );
    } catch (err) {
      console.warn(`[poll] Could not check ACC comments for issue ${row.acc_issue_id} (skipping):`, err.response?.data?.detail || err.message);
    }
  }
}

module.exports = {
  pushIssueToAcc,
  pushAllOpenIssues,
  pushSelectedIssues,
  pushLinkedIssues,
  getLinkedIssuePairs,
  getIssuesBoard,
  handleAccWebhook,
  getAccIdForRevizto,
  getReviztoIdForAcc,
  recordLink,
  getSyncStats,
  pollAccCommentsForProject,
};
