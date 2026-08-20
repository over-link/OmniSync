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

/**
 * True when an ACC API error means "this issue no longer exists" —
 * confirmed by real testing that a deleted-in-ACC issue's GET/PATCH
 * returns 403 Forbidden, NOT 404 Not Found as would normally be expected
 * (ACC's Construction Issues API apparently reports a nonexistent issue
 * ID as an access error rather than a not-found one). Checked in both
 * places that self-heal a missing ACC issue by clearing the stale link —
 * pushIssueToAcc and getIssuesBoard — rather than erroring on it forever.
 */
function _isAccIssueGoneError(err) {
  const status = err.response?.status;
  return status === 404 || status === 403;
}

/**
 * Removes the link between a Revizto issue and its ACC counterpart —
 * this app's own bookkeeping row only, never the actual issue in either
 * system. Used by the automatic self-heal in pushIssueToAcc/getIssuesBoard
 * (the ACC issue was deleted outside this app — see _isAccIssueGoneError)
 * and by the admin-gated manual "Unlink" action on the Issues page (see
 * projects.allow_manual_unlink).
 */
async function clearLink(projectId, reviztoIssueId) {
  await pool.query('DELETE FROM sync_map WHERE project_id = $1 AND revizto_issue_id = $2', [projectId, String(reviztoIssueId)]);
}

/**
 * The user-facing manual unlink action (see routes: POST /api/projects/
 * :id/issues/:reviztoIssueId/unlink) — clears the link, then posts a
 * best-effort notification comment on BOTH sides so neither side is left
 * silently wondering why sync stopped, same idea as the existing
 * deadline-change/markup-upload comments. Comment failures never block
 * the unlink itself — the link is already gone at that point regardless.
 */
async function unlinkIssue(userId, project, reviztoIssueId, reporterEmail) {
  const accIssueId = await getAccIdForRevizto(project.id, reviztoIssueId);
  await clearLink(project.id, reviztoIssueId);
  if (!accIssueId) return; // wasn't actually linked — nothing to notify

  try {
    await accService.addComment(userId, project, accIssueId, `Unlinked from Revizto issue #${reviztoIssueId} in Revizto ⇄ ACC Sync${reporterEmail ? ` by ${reporterEmail}` : ''}.`);
  } catch (err) {
    console.warn(`[sync] Could not post unlink notice to ACC issue ${accIssueId} (skipping):`, err.response?.data || err.message);
  }
  try {
    await reviztoService.addComment(
      userId,
      project.revizto_region,
      project.revizto_project_uuid,
      reviztoIssueId,
      `Unlinked from ACC issue #${accIssueId} in Revizto ⇄ ACC Sync${reporterEmail ? ` by ${reporterEmail}` : ''}.`,
      reporterEmail
    );
  } catch (err) {
    console.warn(`[sync] Could not post unlink notice to Revizto issue ${reviztoIssueId} (skipping):`, err.response?.data || err.message);
  }
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
// "Revizto Status" is handled separately by makeReviztoStatusFieldResolver
// below, not through this exact-title list — a project can have several
// such fields (one per workflow), not just one fixed title.
const MANAGED_CUSTOM_FIELDS = ['Grid Intersection', 'Room', 'Tags', 'Revizto ID', 'Issue Priority'];

// Revizto returns many categorical fields (status, stamp, tags, etc.) in
// ALL CAPS. Display as Title Case for readability — first letter of EACH
// word capitalized, rest lowercase. Per-word (not just the string's first
// character) because multi-word values like a stamp category "01 DESIGN"
// need every word's first letter capitalized ("01 Design"), not just the
// string's very first character (a naive single-capitalization pass
// turned that into "01 design" — confirmed by real testing). Display-only:
// applied once here so the Issues board and its filter dropdowns (which
// read straight off these board fields) automatically stay consistent
// with each other. Never fed back into the actual Revizto/ACC push logic,
// which always compares against raw unwrap()'d values separately.
function toSentenceCase(s) {
  if (!s) return s;
  return s
    .split(' ')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

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

/**
 * Resolves the ACC "Revizto Status" list field for a SPECIFIC workflow —
 * unlike the other managed custom fields above (Grid/Room/Tags/etc,
 * always exactly one field, matched by an exact fixed title), a project
 * can now have SEVERAL of these fields, one per workflow (e.g. "Revizto
 * Status - Pre Pour Checklist"), so each workflow's dropdown only shows
 * that workflow's own statuses instead of one huge project-wide list —
 * see fieldMapping.pickReviztoStatusField for the matching rule. Kept
 * separate from makeCustomAttributeResolver (whose contract is "one
 * field per exact title") rather than overloading it. Same lazy-fetch-
 * once and subtype-applicability check as that function, since ACC scopes
 * each custom field to specific issue subtypes.
 */
async function makeReviztoStatusFieldResolver(userId, project) {
  let statusFieldDefs = null;
  let mappingsByAttrId = null;
  let issueTypeIdBySubtypeId = null;
  return async (workflowLabel, subtypeId) => {
    if (!statusFieldDefs) {
      try {
        const [defs, mappings, subtypes] = await Promise.all([
          accService.getIssueAttributeDefinitions(userId, project),
          accService.getIssueAttributeMappings(userId, project),
          accService.getIssueSubtypes(userId, project),
        ]);
        issueTypeIdBySubtypeId = Object.fromEntries(subtypes.map((s) => [s.id, s.issueTypeId]));
        statusFieldDefs = defs.filter((d) => d.dataType === 'list' && fieldMapping.isReviztoStatusFieldTitle(d.title));
        mappingsByAttrId = {};
        for (const m of mappings) {
          if (!mappingsByAttrId[m.attributeDefinitionId]) mappingsByAttrId[m.attributeDefinitionId] = [];
          mappingsByAttrId[m.attributeDefinitionId].push(m);
        }
        console.log(`[sync] ACC "Revizto Status" field(s) for project "${project.name}": ${statusFieldDefs.length ? statusFieldDefs.map((d) => d.title).join(', ') : 'none found'}`);
      } catch (err) {
        console.warn('[sync] Could not look up ACC "Revizto Status" field definitions (skipping secondary status mapping):', err.response?.data?.detail || err.message);
        statusFieldDefs = [];
        mappingsByAttrId = {};
        issueTypeIdBySubtypeId = {};
      }
    }

    const def = fieldMapping.pickReviztoStatusField(statusFieldDefs, workflowLabel);
    if (!def) return null;

    const attrMappings = mappingsByAttrId[def.id] || [];
    const issueTypeId = issueTypeIdBySubtypeId[subtypeId] || null;
    const applicable = attrMappings.some(
      (m) =>
        m.mappedItemType === 'container' ||
        (m.mappedItemType === 'issueSubtype' && m.mappedItemId === subtypeId) ||
        (m.mappedItemType === 'issueType' && issueTypeId && m.mappedItemId === issueTypeId)
    );
    if (!applicable) {
      console.warn(`[sync] ACC field "${def.title}" exists but isn't mapped to this issue's subtype — skipping secondary status for this push.`);
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

  const [customStatusMap, customTypeMap, workflowSettings] = await Promise.all([
    fieldMapping.getStatusMap(project.id),
    fieldMapping.getTypeMap(project.id),
    reviztoService.getWorkflowSettings(userId, project.revizto_region, project.revizto_project_uuid),
  ]);

  // customStatusName is a plain, ready-to-use string Revizto returns
  // alongside the UUID version (customStatus) — confirmed from a real raw
  // issue response. No UUID resolution needed for this.
  const reviztoStatusName = reviztoService.unwrap(reviztoIssue.customStatusName) ?? null;

  // Which workflow governs THIS issue (via its type), so the status
  // mapping lookup below can be scoped to it — two different workflows
  // can define a same-named custom status that should map differently.
  const workflowUuid = reviztoService.resolveIssueWorkflowUuid(reviztoIssue, workflowSettings);
  const workflowLabel = workflowUuid ? reviztoService.getWorkflowLabel(workflowUuid, workflowSettings) : null;

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

  // Separate resolver for the "Revizto Status" field family (see
  // makeReviztoStatusFieldResolver) — a project can have several of
  // these, one per workflow, unlike customAttributeResolver's other
  // fields which are always exactly one fixed title.
  const reviztoStatusFieldResolver = await makeReviztoStatusFieldResolver(userId, project);

  const { payload, statusNeedsMapping, typeNeedsMapping } = await reviztoService.toAccIssue(reviztoIssue, {
    subtypeLookup,
    defaultSubtypeId: project.acc_default_subtype_id,
    customStatusMap,
    customTypeMap,
    reviztoStatusName,
    workflowUuid,
    workflowLabel,
    autoMappedStatuses: fieldMapping.REVIZTO_AUTO_MAPPED_STATUSES,
    assigneeResolver,
    locationResolver,
    customAttributeResolver,
    reviztoStatusFieldResolver,
  });

  let accIssueId;
  if (existingAccId) {
    try {
      await accService.updateIssue(userId, project, existingAccId, payload);
      accIssueId = existingAccId;
    } catch (err) {
      if (!_isAccIssueGoneError(err)) throw err;
      // The linked ACC issue no longer exists (e.g. deleted directly in
      // ACC, outside this app) — self-heal by clearing the stale link
      // (same treatment as getIssuesBoard's read-path handling of the
      // same error) rather than silently re-creating a replacement issue
      // in ACC on the app's own initiative — explicit request: an admin
      // who deliberately deleted issues in ACC wants them to show up as
      // unlinked and ready to review/relink deliberately, not have this
      // app recreate them automatically on the next poll cycle.
      console.warn(`[sync] ACC issue ${existingAccId} no longer exists (${err.response?.status}) — auto-unlinking Revizto issue ${reviztoIssue.id}.`);
      await clearLink(project.id, reviztoIssue.id);
      return { action: 'unlinked', reason: `ACC issue ${existingAccId} no longer exists` };
    }
  } else {
    const created = await accService.createIssue(userId, project, payload);
    await recordLink(project.id, reviztoIssue.id, created.id);
    accIssueId = created.id;
  }

  // Tracking-category status and/or stamp with no admin mapping
  // configured (defaulted to ACC "Open" / the project's default subtype
  // in toAccIssue) — surfaces on both the Setup page mapping-warnings and
  // the Issues page error pill/hover, since this reuses the same
  // sync_map.last_error column as genuine push failures.
  const mappingWarnings = [];
  if (statusNeedsMapping) {
    mappingWarnings.push(`Status "${reviztoStatusName}" has no ACC mapping configured — defaulted to Draft.`);
  }
  if (typeNeedsMapping) {
    mappingWarnings.push('Issue type/stamp has no ACC mapping configured — defaulted to the project\'s default ACC issue type.');
  }
  if (mappingWarnings.length) {
    await recordSyncError(project.id, reviztoIssue.id, `${mappingWarnings.join(' ')} Configure it on the Setup page.`);
  } else {
    await clearSyncError(project.id, reviztoIssue.id);
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

/**
 * Resolves a Revizto member's email to their display name via the
 * license's member list, for tagging who actually wrote a comment/
 * attachment when syncing it to the other platform. Only a fallback for
 * when the richer `author` object (firstname/lastname, present on real
 * comment data — confirmed) isn't available; useful specifically when
 * that person has no account on the other side, so the "reporter"/system
 * account alone wouldn't say who it really came from. Falls back to the
 * bare email if no license/member match is found either.
 */
async function _resolveReviztoAuthorName(userId, project, email) {
  if (!email) return null;
  try {
    const reviztoTokens = await tokenStore.getReviztoTokens(userId);
    if (!reviztoTokens?.license_id) return email;
    const members = await reviztoService.getLicenseMembers(userId, project.revizto_region, reviztoTokens.license_id);
    const nameByEmail = reviztoService.buildMemberNameLookup(members);
    return nameByEmail[email.toLowerCase()] || email;
  } catch (err) {
    console.warn(`[sync] Could not resolve Revizto author name for ${email} (using email):`, err.message);
    return email;
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
    // re-pushing. Also covers the auto-posted "Deadline changed via ACC
    // sync" comment (see handleAccWebhook) — deliberately kept as its own
    // exact phrase, not tagged with "- synced from ACC", so it stays
    // readable in Revizto; this second check is what keeps it a one-time
    // post instead of also getting echoed back into ACC. Same treatment
    // for the "Attachment added via ACC sync" comment from
    // pollAccAttachmentsForProject.
    // "Attachment added via ACC sync" now gets a "by <name>" suffix
    // appended (see pollAccAttachmentsForProject), so this needs a prefix
    // check rather than exact equality to still recognize it.
    const isAutoPostedComment = latest.text === 'Deadline changed via ACC sync' || (latest.text || '').startsWith('Attachment added via ACC sync');
    if ((latest.text || '').includes('- synced from ACC') || isAutoPostedComment) {
      await pool.query(
        'UPDATE sync_map SET last_pushed_comment_uuid = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
        [project.id, String(reviztoIssue.id), latest.uuid]
      );
      return;
    }

    // `author` (confirmed from a real comment: {firstname, lastname,
    // email, ...}) is richer than `reporter` (bare email) and needs no
    // extra API call — preferred when present, with the license-lookup
    // helper as a fallback for older/edge-case comments that might lack it.
    const authorFromObject = [latest.author?.firstname, latest.author?.lastname].filter(Boolean).join(' ') || null;
    const authorName = authorFromObject || (await _resolveReviztoAuthorName(userId, project, latest.reporter));
    const attribution = authorName ? ` by ${authorName}` : '';
    await accService.addComment(userId, project, accIssueId, `${latest.text || ''} - synced from Revizto${attribution}`);
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

/**
 * Resolves what Revizto status an ACC status/custom-field change should
 * produce, respecting the issue's own workflow (a project can have
 * several, and different workflows can map the same ACC primary status
 * to different Revizto statuses — see the Setup page's per-workflow
 * Status mapping panel). Returns either { targetStatusName } — apply this
 * to Revizto — or { ambiguous: true, reason } when nothing resolves it
 * precisely enough to trust; the caller then defaults ACC's primary
 * status back to "draft" rather than guessing.
 *
 * Resolution order:
 *  1. ACC's "Revizto Status" custom list field (admin-mapped 1:1 to an
 *     exact Revizto status per workflow) — always wins outright when set,
 *     since it's precise by construction. If no explicit status_map row
 *     covers the selected option, falls back to an exact name match
 *     against this workflow's own status names (same zero-config idea as
 *     the 4 canonical statuses — a custom status whose name already
 *     matches an ACC option needs no admin mapping at all). Only when
 *     NEITHER resolves it is it treated as ambiguous, so a real mistake
 *     (wrong option, stale from a different workflow) doesn't get masked
 *     by a primary-status guess.
 *  2. No secondary selection: the primary ACC status, but only trusted
 *     when exactly one of this workflow's mapped statuses targets it —
 *     multiple matches is exactly the scenario the secondary field exists
 *     to disambiguate, so that's ambiguous too. Zero matches falls back
 *     to the pre-existing hardcoded guess (mapStatusFromAcc), unchanged.
 */
async function _resolveReviztoStatusFromAcc(userId, project, accIssue, reviztoIssueId) {
  const [reviztoIssue, workflowSettings, statusMap] = await Promise.all([
    reviztoService.getIssue(userId, project.revizto_region, project.revizto_project_uuid, reviztoIssueId),
    reviztoService.getWorkflowSettings(userId, project.revizto_region, project.revizto_project_uuid),
    fieldMapping.getStatusMap(project.id),
  ]);
  const workflowUuid = reviztoService.resolveIssueWorkflowUuid(reviztoIssue, workflowSettings);
  const workflowLabel = workflowUuid ? reviztoService.getWorkflowLabel(workflowUuid, workflowSettings) : null;
  const workflowMap = { ...(statusMap[''] || {}), ...(statusMap[workflowUuid] || {}) };

  // A project can have several "Revizto Status*" fields on the issue, one
  // per workflow (e.g. "Revizto Status - Pre Pour Checklist") — pick the
  // one that belongs to THIS issue's workflow, same matching rule as the
  // push direction (fieldMapping.pickReviztoStatusField).
  const statusAttrs = (accIssue.customAttributes || []).filter((a) => fieldMapping.isReviztoStatusFieldTitle(a.title));
  const secondaryAttr = fieldMapping.pickReviztoStatusField(statusAttrs, workflowLabel);
  const secondaryOptionId = secondaryAttr && secondaryAttr.value != null && secondaryAttr.value !== '' ? secondaryAttr.value : null;
  if (secondaryOptionId) {
    const match = Object.entries(workflowMap).find(([, v]) => v.accCustomStatusOptionId === secondaryOptionId);
    if (match) return { targetStatusName: match[0] };

    const attributeDefs = await accService.getIssueAttributeDefinitions(userId, project);
    const statusFieldDefs = attributeDefs.filter((d) => d.dataType === 'list' && fieldMapping.isReviztoStatusFieldTitle(d.title));
    const statusFieldDef = fieldMapping.pickReviztoStatusField(statusFieldDefs, workflowLabel);
    const selectedOption = statusFieldDef?.metadata?.list?.options?.find((o) => o.id === secondaryOptionId);
    const selectedLabel = selectedOption ? String(selectedOption.value ?? selectedOption.label ?? '').trim().toLowerCase() : null;
    if (selectedLabel) {
      const nameMatch = reviztoService
        .getWorkflowStatusNames(workflowUuid, workflowSettings)
        .find((n) => n.trim().toLowerCase() === selectedLabel);
      if (nameMatch) return { targetStatusName: nameMatch };
    }

    return { ambiguous: true, reason: `ACC "${secondaryAttr.title}" selection doesn't match any mapped status for this issue's workflow.` };
  }

  const candidates = new Set(
    Object.entries(workflowMap)
      .filter(([, v]) => v.accStatus === accIssue.status)
      .map(([name]) => name)
  );
  if (fieldMapping.ACC_AUTO_MAPPED_STATUSES[accIssue.status]) {
    candidates.add(fieldMapping.ACC_AUTO_MAPPED_STATUSES[accIssue.status]);
  }
  if (candidates.size === 1) return { targetStatusName: [...candidates][0] };
  if (candidates.size > 1) {
    return {
      ambiguous: true,
      reason: `ACC status "${accIssue.status}" is mapped from multiple Revizto statuses in this issue's workflow (${[...candidates].join(', ')}) — set ACC's "Revizto Status" field to the correct one.`,
    };
  }
  return { targetStatusName: reviztoService.mapStatusFromAcc(accIssue.status) };
}

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

  // See _resolveReviztoStatusFromAcc for the full resolution order
  // (secondary "Revizto Status" field, then per-workflow primary-status
  // reverse lookup, then the hardcoded guess). Ambiguous/unresolvable
  // cases don't guess — they default ACC's primary status back to
  // "draft" (skip if already there, to avoid a redundant self-triggered
  // webhook) and leave Revizto's own status untouched, since the app
  // doesn't know which one was actually intended.
  const resolution = await _resolveReviztoStatusFromAcc(userId, project, accIssue, reviztoIssueId);
  if (resolution.ambiguous) {
    if (accIssue.status !== 'draft') {
      await accService.updateIssue(userId, project, accIssueId, { status: 'draft' });
    }
    await recordSyncError(project.id, reviztoIssueId, `${resolution.reason} Configure it on the Setup page.`);
  } else {
    const statusResult = await reviztoService.updateIssueStatus(
      userId,
      project.revizto_region,
      project.revizto_project_uuid,
      reviztoIssueId,
      resolution.targetStatusName,
      reporterEmail
    );
    if (statusResult && statusResult.ok === false) {
      await recordSyncError(project.id, reviztoIssueId, `${statusResult.reason} Configure a status mapping on the Setup page.`);
    } else {
      await clearSyncError(project.id, reviztoIssueId);
    }
  }

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
          console.warn(`[webhook] ACC priority option ID "${priorityAttr.value}" not found in "Issue Priority"'s option list (${options.length} option(s): ${JSON.stringify(options)}) — sending as-is.`);
        }
      } else {
        // Previously fell through here silently with no log at all —
        // looked identical to a successful text-field pass-through, which
        // made a real failure (couldn't find the definition, or its
        // dataType wasn't "list" as expected) indistinguishable from
        // "working as intended" in the logs.
        console.warn(`[webhook] Could not resolve "Issue Priority" definition/dataType for value resolution (found definition: ${JSON.stringify(priorityDef) || 'none'}) — sending raw value "${priorityAttr.value}" as-is.`);
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

  // Due date (ACC's dueDate -> Revizto's deadline), the reverse of the
  // Revizto->ACC direction (reviztoService.formatDateForAcc). UNCONFIRMED:
  // assumes accIssue.dueDate on the GET response is the same date-only
  // string format used when writing it (never independently confirmed for
  // GET specifically — same category of assumption as the ACC comments
  // GET shape, flagged elsewhere in this file). Wrapped separately so a
  // failure here doesn't block status/assignee/priority above.
  try {
    if (accIssue.dueDate) {
      // updateIssueDeadline returns null on a no-op (date unchanged) — only
      // post the explanatory comment when a real change was made, not on
      // every webhook delivery where the date happens to already match.
      const changed = await reviztoService.updateIssueDeadline(
        userId,
        project.revizto_region,
        project.revizto_project_uuid,
        reviztoIssueId,
        accIssue.dueDate,
        reporterEmail
      );
      if (changed) {
        await reviztoService.addComment(
          userId,
          project.revizto_region,
          project.revizto_project_uuid,
          reviztoIssueId,
          'Deadline changed via ACC sync',
          reporterEmail
        );
      }
    }
  } catch (err) {
    console.warn('[webhook] Could not sync due date back to Revizto (skipping):', err.response?.data?.message || err.message);
  }

  // Comment pulling from ACC happens via pollAccCommentsForProject (see
  // pollService.js), not here — accIssue.comments never populated from
  // this base GET (confirmed: comments are a separate endpoint), so this
  // block was dead code and has been removed.

  return { action: 'pulled', reviztoIssueId, newStatus };
}

/**
 * Shared lookups needed to compute a Revizto issue's filterable fields
 * (see _buildFilterableFields below) — fetched once per project/user and
 * reused across every issue, rather than once per issue. Used by both
 * getIssuesBoard (the Issues page) and autoLinkMatchingIssues (auto-sync
 * filter matching), so the two stay consistent with each other by
 * construction instead of by convention.
 */
async function _loadFilterableFieldLookups(userId, project) {
  const [stampPresets, reviztoTokens] = await Promise.all([
    reviztoService.getStampPresets(userId, project.revizto_region, project.revizto_project_uuid).catch(() => []),
    tokenStore.getReviztoTokens(userId),
  ]);
  const { byAbbr: stampCategoryByAbbr } = reviztoService.buildStampCategoryLookup(stampPresets);
  const stampTitleByAbbr = reviztoService.buildStampTitleLookup(stampPresets);

  // Resolve assignee email -> display name/company via the license's
  // member list. Uses the CALLING USER's own saved license (from their
  // Revizto connection) as the license context — assumes the project was
  // set up under that same license, which is true for the normal "browse
  // my Revizto projects" setup flow. Falls back to showing the bare email
  // if license isn't set or the person isn't found (e.g. assigned but not
  // a license member, or a different license than assumed).
  let assigneeNameByEmail = {};
  let assigneeCompanyByEmail = {};
  if (reviztoTokens?.license_id) {
    try {
      const members = await reviztoService.getLicenseMembers(userId, project.revizto_region, reviztoTokens.license_id);
      assigneeNameByEmail = reviztoService.buildMemberNameLookup(members);
      assigneeCompanyByEmail = reviztoService.buildMemberCompanyLookup(members);
    } catch (err) {
      console.warn('[sync] Could not fetch license members for assignee names (skipping):', err.response?.data?.message || err.message);
    }
  }

  return { stampCategoryByAbbr, stampTitleByAbbr, assigneeNameByEmail, assigneeCompanyByEmail };
}

/**
 * Computes a single Revizto issue's filterable fields — the same set the
 * Issues page filters on (status, stamp, priority, level, etc.) and that
 * auto-sync filter rules match against. Deliberately excludes `id`/
 * `title`/`linked`/`acc`, which only getIssuesBoard needs.
 *
 * FIELD NAMES UNVERIFIED: `stamp`, `stampCategory`, `type`, and `assignee`
 * below are best-guess field paths on Revizto's raw issue object — we
 * don't have confirmed docs for these (unlike title/status/deadline, which
 * came from working code). If filters show blank/wrong values once you
 * have real data, check what field names Revizto's issue-filter response
 * actually uses and fix the `unwrap(...)` calls below accordingly.
 */
function _buildFilterableFields(issue, { stampCategoryByAbbr, stampTitleByAbbr, assigneeNameByEmail, assigneeCompanyByEmail }) {
  // customStatusName / customTypeName are plain, ready-to-display strings
  // Revizto returns alongside the UUID versions (customStatus/customType)
  // — confirmed from a real raw issue response, no resolution needed.
  const stampAbbr = reviztoService.unwrap(issue.stampAbbr) ?? null; // was incorrectly `issue.stamp` (doesn't exist)
  const assigneeEmail = reviztoService.unwrap(issue.assignee) ?? null;
  // priority/level/zone use the same field paths already confirmed and
  // used in toAccIssue (level/zone need additionalFields: 'appendClashAndLocationFields',
  // already requested by getIssues). `type` is Revizto's clash indicator
  // (1 = nonclash issue, 3 = clash issue, confirmed from Revizto docs) —
  // not to be confused with customType/customTypeName (the issue-type stamp).
  // Rendered as a label (not a raw boolean) so it slots into the same
  // scalar string-equality filter mechanism as status/stamp/etc.
  // Capitalized for display only — the raw lowercase value from Revizto
  // is still what's sent to ACC's "Issue Priority" custom field elsewhere
  // (reviztoService.toAccIssue), so that matching logic is untouched.
  const rawPriority = reviztoService.unwrap(issue.priority) || null;
  const priority = rawPriority ? rawPriority.charAt(0).toUpperCase() + rawPriority.slice(1) : null;
  const levels = issue.clashAndLocationFields?.level || [];
  const zones = issue.clashAndLocationFields?.zone || [];
  const rooms = issue.clashAndLocationFields?.room || [];
  const isClash = issue.type === 3 ? 'Clash' : issue.type === 1 ? 'Non-clash' : null;
  return {
    status: toSentenceCase(reviztoService.unwrap(issue.customStatusName) ?? null),
    issueType: toSentenceCase(reviztoService.unwrap(issue.customTypeName) ?? null),
    // Display the stamp's human-readable title, not its raw abbreviation
    // (the abbreviation is still what's used internally for type-mapping
    // matching in toAccIssue — this is display-only).
    stamp: toSentenceCase(stampAbbr ? stampTitleByAbbr[stampAbbr] || stampAbbr : null),
    stampCategory: toSentenceCase(stampAbbr ? stampCategoryByAbbr[stampAbbr] || null : null),
    // Show the resolved display name when we have one; fall back to the
    // raw email (still used as the filter's matching value either way,
    // so filtering behavior is unaffected by whether resolution worked).
    // Not sentence-cased — this is a real person's name, not a category.
    assignee: assigneeEmail ? assigneeNameByEmail[assigneeEmail.toLowerCase()] || assigneeEmail : null,
    // Company is a top-level field on the license member entity (a
    // sibling of `user`, confirmed from real Revizto docs). Not
    // sentence-cased — real company names, same reasoning as assignee.
    assigneeCompany: assigneeEmail ? assigneeCompanyByEmail[assigneeEmail.toLowerCase()] || null : null,
    tags: (reviztoService.unwrap(issue.tags) || []).map(toSentenceCase),
    priority,
    level: levels.map(toSentenceCase),
    zone: zones.map(toSentenceCase),
    room: rooms.map(toSentenceCase),
    isClash,
  };
}

/**
 * For the Issues page: every Revizto issue in the project, with its link
 * status (if linked, includes the ACC side's current title/status too),
 * plus fields the UI filters on.
 */
async function getIssuesBoard(userId, project) {
  const [issues, linkRows, lookups] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    pool.query('SELECT revizto_issue_id, acc_issue_id FROM sync_map WHERE project_id = $1', [project.id]).then((r) => r.rows),
    _loadFilterableFieldLookups(userId, project),
  ]);
  const linkMap = new Map(linkRows.map((r) => [String(r.revizto_issue_id), r.acc_issue_id]));

  const board = [];
  for (const issue of issues) {
    const accIssueId = linkMap.get(String(issue.id)) || null;
    let acc = null;
    let linked = !!accIssueId;
    if (accIssueId) {
      try {
        const accIssue = await accService.getIssue(userId, project, accIssueId);
        // displayId is ACC's own human-readable issue number (confirmed
        // from real docs — distinct from `id`, the internal UUID used for
        // API calls). Shown in the UI instead of the UUID; falls back to
        // the UUID if displayId is ever missing rather than showing blank.
        acc = { id: accIssueId, displayId: accIssue.displayId ?? accIssueId, title: accIssue.title, status: accIssue.status };
      } catch (err) {
        if (_isAccIssueGoneError(err)) {
          // Clear the stale link instead of showing a permanent error
          // row — this is a read-only display query, so unlike
          // pushIssueToAcc there's no push happening to re-create the ACC
          // issue from; it just reverts to "unlinked" so the Issues page
          // offers it up to be relinked normally (manually, or by
          // auto-sync-by-filter on the next poll).
          await clearLink(project.id, issue.id);
          linked = false;
        } else {
          acc = { id: accIssueId, error: err.response?.data?.detail || err.message };
        }
      }
    }
    board.push({
      id: issue.id,
      title: reviztoService.unwrap(issue.title) || '(no title)',
      ..._buildFilterableFields(issue, lookups),
      linked,
      acc,
    });
  }
  return board;
}

// Fields where a board item holds an array, not a single value — same
// split as the Issues page's own ARRAY_FILTER_FIELDS (public/js/issues.js),
// kept in sync manually since one's server-side and one's client-side.
const AUTO_SYNC_ARRAY_FIELDS = new Set(['tags', 'level', 'zone', 'room']);

// Same combination semantics as the Issues page's own filters: every
// configured field must match (AND), and a field matches if the issue's
// value is one of that field's selected values (OR within the field). A
// field with no selected values imposes no constraint.
function _matchesAutoSyncFilters(fields, filters) {
  return Object.entries(filters).every(([field, selected]) => {
    if (!selected || !selected.length) return true;
    if (AUTO_SYNC_ARRAY_FIELDS.has(field)) return (fields[field] || []).some((v) => selected.includes(v));
    return selected.includes(fields[field]);
  });
}

/**
 * Auto-links (and pushes) any currently-unlinked Revizto issue matching a
 * project's admin-configured auto-sync filter criteria (Setup page) —
 * opt-in, off by default (project.auto_sync_enabled). Runs on the same
 * 2-minute poll cycle as the existing auto-resync (see pollService.js),
 * so this continuously sweeps: brand-new issues, issues edited to newly
 * match, AND any pre-existing unlinked backlog that already matched
 * before the rule was turned on — no special-casing between "new" and
 * "existing" issues (explicit request).
 *
 * No filter VALUES configured at all (even with the toggle on) is treated
 * as "nothing to do," not "match everything" — an auto-link-everything
 * toggle would be a much bigger, more surprising behavior change than
 * what was actually asked for (selective filtering, not a blanket switch
 * that undoes the "manual to link" design entirely).
 */
async function autoLinkMatchingIssues(userId, project) {
  if (!project.auto_sync_enabled) return [];
  const filters = await fieldMapping.getAutoSyncFilters(project.id);
  const hasAnyFilterValue = Object.values(filters).some((values) => values && values.length);
  if (!hasAnyFilterValue) return [];

  const [issues, linkRows, lookups] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    pool.query('SELECT revizto_issue_id FROM sync_map WHERE project_id = $1', [project.id]).then((r) => r.rows),
    _loadFilterableFieldLookups(userId, project),
  ]);
  const linkedIds = new Set(linkRows.map((r) => String(r.revizto_issue_id)));
  const unlinkedMatches = issues.filter((issue) => {
    if (linkedIds.has(String(issue.id))) return false;
    return _matchesAutoSyncFilters(_buildFilterableFields(issue, lookups), filters);
  });
  if (!unlinkedMatches.length) return [];

  console.log(`[auto-sync] "${project.name}": ${unlinkedMatches.length} unlinked issue(s) match the auto-sync filter — linking now.`);
  return _pushIssueList(userId, project, unlinkedMatches);
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
    pool.query('SELECT revizto_issue_id, last_error FROM sync_map WHERE project_id = $1', [project.id]).then((r) => r.rows),
  ]);
  const errorRows = syncRows.filter((r) => r.last_error);
  return {
    reviztoCount: reviztoIssues.length,
    accCount: accIssues.length,
    syncedCount: syncRows.length,
    errorCount: errorRows.length,
    // Per-issue detail for the Issues page's error pill hover — kept
    // separate from errorCount (which alone is enough for most callers)
    // so the count itself doesn't change shape for anything relying on it.
    errors: errorRows.map((r) => ({ reviztoIssueId: r.revizto_issue_id, message: r.last_error })),
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
/**
 * Resolves an ACC autodeskId (the `createdBy` field on comments and
 * attachments — confirmed via real testing) to a display name, for
 * tagging who actually posted a comment/attachment when syncing it into
 * Revizto. `.name` on getProjectMembers' member objects is confirmed from
 * a real response (e.g. "Edgar Perez"); firstName/lastName and email are
 * kept as fallbacks in case a member record is ever missing it. Returns
 * null (not the autodeskId) on failure so callers can skip attribution
 * cleanly rather than tagging a comment with a meaningless ID string.
 */
async function _resolveAccAuthorName(userId, project, autodeskId) {
  if (!autodeskId) return null;
  try {
    const members = await accService.getProjectMembers(userId, project);
    const member = members.find((m) => m.autodeskId === autodeskId);
    if (!member) return null;
    return member.name || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || null;
  } catch (err) {
    console.warn(`[poll] Could not resolve ACC author name for ${autodeskId} (skipping attribution):`, err.message);
    return null;
  }
}

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

      const authorName = await _resolveAccAuthorName(userId, project, latest.createdBy);
      const attribution = authorName ? ` by ${authorName}` : '';
      await reviztoService.addComment(
        userId,
        project.revizto_region,
        project.revizto_project_uuid,
        row.revizto_issue_id,
        `${commentText} - synced from ACC${attribution}`,
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

/**
 * Polling-based ACC->Revizto attachment sync — same reasoning as
 * pollAccCommentsForProject: attachment additions aren't confirmed to
 * fire the issue.updated webhook event, so this actively checks rather
 * than relying on one. Only pushes the single latest attachment, matching
 * the "latest only" pattern already used for comments and markup. Images
 * (.png/.jpg/.jpeg) go over as a real Revizto markup update; anything
 * else (PDFs, etc.) goes over as a plain file attachment comment, since
 * Revizto's markup mechanism only accepts those three image types.
 */
async function pollAccAttachmentsForProject(userId, project, reporterEmail) {
  const { rows } = await pool.query(
    'SELECT revizto_issue_id, acc_issue_id, last_pulled_acc_attachment_id FROM sync_map WHERE project_id = $1',
    [project.id]
  );
  for (const row of rows) {
    try {
      // Confirmed by real testing: attachments do NOT come back inline on
      // the base issue GET (always empty), same as comments — needs the
      // dedicated endpoint instead.
      const attachments = await accService.getIssueAttachments(userId, project, row.acc_issue_id);
      if (!attachments.length) continue;

      const latest = attachments[attachments.length - 1];
      const latestId = latest.attachmentId || latest.id;
      if (!latestId || String(latestId) === String(row.last_pulled_acc_attachment_id)) continue; // nothing new

      const displayName = latest.displayName || latest.fileName || '';
      // Ping-pong guard: an image WE pushed Revizto->ACC (see
      // _pushMarkupImageToAcc) is attached with this exact display name
      // pattern — without this check, it would look like a genuine new
      // ACC attachment on the next poll and get imported right back into
      // Revizto as a "new" one.
      if (displayName.startsWith('Revizto Issue ')) {
        await pool.query(
          'UPDATE sync_map SET last_pulled_acc_attachment_id = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
          [project.id, row.revizto_issue_id, latestId]
        );
        continue;
      }

      // TEMP DEBUG: labeled steps so a failure pinpoints exactly which
      // leg (ACC download, Revizto upload, or the follow-up comment)
      // actually broke, instead of a bare "Internal Server Error" that
      // could come from any of the three.
      console.log(`[poll] [step 1: download] "${displayName}" from ACC for Revizto issue #${row.revizto_issue_id}`);
      let buffer, contentType;
      try {
        ({ buffer, contentType } = await accService.downloadAttachmentFile(userId, latest.storageUrn));
      } catch (err) {
        throw new Error(`[step 1: download from ACC] status ${err.response?.status}: ${JSON.stringify(err.response?.data) || err.message}`);
      }
      console.log(`[poll] [step 1 done] downloaded ${buffer.length} bytes, contentType=${contentType}`);

      const fileName = displayName || `attachment-${latestId}`;

      // Single plain file attachment for everything, images included — a
      // markup-type upload was tried and confirmed working at the API
      // level, but it landed as a broken reference in Revizto's UI
      // (clicking the thumbnail said "selected issue does not have a
      // screenshot") rather than a clean, openable image. A plain file
      // attachment is a single real object with no such gap.
      console.log(`[poll] [step 2: upload to Revizto] "${fileName}" for Revizto issue #${row.revizto_issue_id} (file)`);
      try {
        await reviztoService.addAttachment(
          userId,
          project.revizto_region,
          project.revizto_project_uuid,
          row.revizto_issue_id,
          buffer,
          fileName,
          reporterEmail,
          { asMarkup: false }
        );
      } catch (err) {
        throw new Error(`[step 2: upload to Revizto] status ${err.response?.status}: ${JSON.stringify(err.response?.data) || err.message}`);
      }
      console.log('[poll] [step 2 done]');

      console.log('[poll] [step 3: post explanatory comment]');
      try {
        const authorName = await _resolveAccAuthorName(userId, project, latest.createdBy);
        await reviztoService.addComment(
          userId,
          project.revizto_region,
          project.revizto_project_uuid,
          row.revizto_issue_id,
          authorName ? `Attachment added via ACC sync by ${authorName}` : 'Attachment added via ACC sync',
          reporterEmail
        );
      } catch (err) {
        throw new Error(`[step 3: post comment] status ${err.response?.status}: ${JSON.stringify(err.response?.data) || err.message}`);
      }
      console.log('[poll] [step 3 done]');

      await pool.query(
        'UPDATE sync_map SET last_pulled_acc_attachment_id = $3 WHERE project_id = $1 AND revizto_issue_id = $2',
        [project.id, row.revizto_issue_id, latestId]
      );
    } catch (err) {
      console.warn(`[poll] Could not check ACC attachments for issue ${row.acc_issue_id} (skipping):`, err.response?.data?.detail || err.message);
    }
  }
}

module.exports = {
  pushIssueToAcc,
  pushAllOpenIssues,
  pushSelectedIssues,
  pushLinkedIssues,
  autoLinkMatchingIssues,
  getLinkedIssuePairs,
  getIssuesBoard,
  handleAccWebhook,
  getAccIdForRevizto,
  getReviztoIdForAcc,
  recordLink,
  clearLink,
  unlinkIssue,
  getSyncStats,
  pollAccCommentsForProject,
  pollAccAttachmentsForProject,
};
