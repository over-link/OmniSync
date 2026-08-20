/**
 * services/fieldMapping.js
 * Lets admins configure the Revizto -> ACC status and issue-type mappings
 * per project, scoped per Revizto workflow (see reviztoService.
 * resolveIssueWorkflowUuid). Status: the 4 canonical Revizto status names
 * (Open/In progress/Solved/Closed) auto-map with no config needed, in any
 * workflow; every other custom status falls back to ACC "Draft" (a
 * deliberate safeguard, not a guess) until explicitly mapped. Each
 * mapping can optionally also target an ACC "Revizto Status" custom list
 * field's specific option (acc_custom_status_option_id) — the ACC->
 * Revizto direction uses that to resolve precisely when several statuses
 * in one workflow share the same primary ACC status (see syncService.
 * handleAccWebhook). Type: an unmapped stamp falls back to the project's
 * configured default subtype, then reviztoService's STAMP_SUBTYPE_MAP
 * title-keyword matching as a last resort. Configured mappings always
 * take priority over either fallback.
 */
const pool = require('../db/pool');
const reviztoService = require('./reviztoService');
const accService = require('./accService');

// ACC's Issues API status field is a fixed enum, not project-configurable —
// this list is what the old app's working mapStatusFromAcc already used
// successfully, so treat it as confirmed rather than guessed.
const ACC_STATUS_OPTIONS = [
  'open',
  'in_progress',
  'in_review',
  'not_approved',
  'in_dispute',
  'completed',
  'closed',
  'draft',
  'pending',
];

// ─── Option lists for the mapping UI (real data, not guesses) ────────

// Kept for sort preference in the mapping dropdown — "In progress" is the
// only one of these that realistically shows up there now (it's the one
// commonly under the "Tracking" category, below); "Open"/"Solved"/
// "Closed" typically fall under "To do"/"Completed" and auto-map instead.
// CASING NOTE: only "In progress" (lowercase "p") is confirmed from real
// data — "Open"/"Solved"/"Closed" are reasonable guesses.
const CANONICAL_STATUS_ORDER = ['Open', 'In progress', 'Solved', 'Closed'];

// Reverse direction (ACC->Revizto): these 4 ACC statuses have an
// unambiguous Revizto equivalent, so they always auto-map with no admin
// config needed, in any workflow. Uses the confirmed "In progress" casing
// (lowercase "p") from CANONICAL_STATUS_ORDER, not "In Progress" —
// Revizto's real status name is case-sensitive for the diff-write
// mechanism. Every other ACC status is resolved per-workflow by
// syncService.handleAccWebhook (secondary "Revizto Status" field, then
// the workflow's own status_map rows reversed), falling back to
// reviztoService.mapStatusFromAcc's hardcoded guess only when nothing
// else resolves it.
const ACC_AUTO_MAPPED_STATUSES = {
  open: 'Open',
  in_progress: 'In progress',
  completed: 'Solved',
  closed: 'Closed',
};

// Forward direction, name-based auto-routing (reverted from an earlier
// category-based design, explicit request): the same 4 canonical Revizto
// status names always auto-map to their ACC equivalent, no admin config
// needed — just the inverse of ACC_AUTO_MAPPED_STATUSES so the two stay
// in sync from a single source of truth. Every other custom status name
// needs an explicit admin mapping.
const REVIZTO_AUTO_MAPPED_STATUSES = Object.fromEntries(
  Object.entries(ACC_AUTO_MAPPED_STATUSES).map(([accStatus, reviztoStatus]) => [reviztoStatus, accStatus])
);

// ─── "Revizto Status" secondary field matching ──────────────────────
// A project can now have SEVERAL of these ACC list fields, one per
// workflow (explicit request: one shared field's dropdown grew too long
// once several workflows' custom statuses were all mixed into it) —
// e.g. "Revizto Status - Pre Pour Checklist" only shows that workflow's
// own statuses. A bare field titled exactly "Revizto Status" (no suffix)
// still works as a fallback for any workflow that doesn't have its own
// dedicated field yet, preserving this app's original single-field setup.

function isReviztoStatusFieldTitle(title) {
  return (title || '').trim().toLowerCase().includes('revizto status');
}

// Strips the "Revizto Status" prefix and a separator (dash/colon/em-dash/
// en-dash, either side of whitespace) to get just the workflow-name
// suffix, e.g. "Revizto Status - Pre Pour Checklist" -> "pre pour checklist".
function _reviztoStatusFieldSuffix(title) {
  return (title || '')
    .trim()
    .toLowerCase()
    .replace(/^revizto status/, '')
    .replace(/^[\s\-:–—]+/, '')
    .trim();
}

/**
 * Picks the right "Revizto Status" field/attribute for a specific
 * workflow out of a list of candidates (each just needs a `.title` —
 * used for both ACC attribute DEFINITIONS, in getMappingOptions/
 * syncService's push direction, and an ACC ISSUE's customAttributes
 * entries, in syncService's pull direction). A workflow-specific match
 * (suffix equals the workflow's own label) always wins over the bare
 * "Revizto Status" fallback field.
 */
function pickReviztoStatusField(items, workflowLabel) {
  const wanted = (workflowLabel || '').trim().toLowerCase();
  const exact = items.find((it) => {
    const suffix = _reviztoStatusFieldSuffix(it.title);
    return suffix && suffix === wanted;
  });
  if (exact) return exact;
  return items.find((it) => _reviztoStatusFieldSuffix(it.title) === '') || null;
}

async function getMappingOptions(userId, project) {
  const [issues, subtypes, stampPresets, workflowSettings, attributeDefs] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    accService.getIssueSubtypes(userId, project),
    reviztoService.getStampPresets(userId, project.revizto_region, project.revizto_project_uuid).catch(() => []),
    reviztoService.getWorkflowSettings(userId, project.revizto_region, project.revizto_project_uuid).catch(() => ({ statuses: [] })),
    accService.getIssueAttributeDefinitions(userId, project).catch(() => []),
  ]);

  // Secondary status mapping targets — every ACC list field whose title
  // contains "Revizto Status" (there can be several, one per workflow —
  // see isReviztoStatusFieldTitle above). Each workflow below picks its
  // own via pickReviztoStatusField, so a workflow's dropdown only shows
  // that workflow's own field's options, not every field's options mixed
  // together.
  const statusFieldDefs = attributeDefs.filter((d) => d.dataType === 'list' && isReviztoStatusFieldTitle(d.title));
  // Diagnostic: the match between an ACC field's name-suffix and a
  // workflow's own name is EXACT (case-insensitive, trimmed) — no fuzzy
  // matching — so a real-world mismatch (extra word, singular/plural,
  // punctuation) silently falls back to "Not available" instead of
  // erroring. This is the fastest way to see the exact strings being
  // compared instead of guessing why a specific workflow didn't match.
  console.log(
    `[fieldMapping] ACC "Revizto Status" field(s) discovered for project "${project.name}": ${
      statusFieldDefs.length ? statusFieldDefs.map((d) => `"${d.title}"`).join(', ') : 'none'
    }`
  );

  // In use on any current Revizto issue (by literal current status) —
  // shown from the start so an admin can configure the project correctly
  // upfront, not just after issues get linked (explicit request: "things
  // don't slip through the cracks"). Same scope as the stamps list below.
  const inUseStatuses = [...new Set(issues.map((i) => reviztoService.unwrap(i.customStatusName)).filter(Boolean))];

  // Whole WORKFLOWS currently in use (governing at least one issue, via
  // that issue's type -> type.workflowUuid) — explicit request: once an
  // issue is flowing through a workflow, every status in it should be
  // required to map, not just whichever one an issue's CURRENT status
  // happens to be sitting in, since the issue could reach any of them.
  const inUseWorkflowUuids = new Set(
    issues
      .map((i) => reviztoService.resolveIssueWorkflowUuid(i, workflowSettings))
      .filter(Boolean)
  );
  const statusNameByUuid = new Map((workflowSettings?.statuses || []).filter((s) => !s.deletedAt).map((s) => [s.uuid, s.name]));

  const sortByCanonicalThenName = (a, b) => {
    const ai = CANONICAL_STATUS_ORDER.indexOf(a);
    const bi = CANONICAL_STATUS_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  };

  // Read-only informational rows — greyed out in the UI. Only shown when
  // actually in use (by literal current status, not just workflow), same
  // as before — no point flagging a status as "auto-mapped, here's your
  // heads up" for one nothing has actually used yet.
  const autoMappedStatuses = inUseStatuses
    .filter((s) => REVIZTO_AUTO_MAPPED_STATUSES[s])
    .sort()
    .map((s) => ({ name: s, accStatus: REVIZTO_AUTO_MAPPED_STATUSES[s] }));

  // Per-workflow grouping (explicit request: a project with multiple
  // workflows can define the SAME status name differently in each one, so
  // the mapping needs to be scoped by workflow, not flattened by name
  // like autoMappedStatuses above). Only workflows with at least one
  // non-canonical status get a group — a workflow that's 100% the 4
  // canonical names needs no admin action at all, it's fully covered by
  // the auto-mapped section.
  let workflowCounter = 0;
  const workflows = (workflowSettings?.workflows || [])
    .filter((w) => !w.deletedAt)
    .map((w) => {
      const statusNames = [...new Set((w.statuses || []).filter((s) => !s.deletedAt).map((s) => statusNameByUuid.get(s.uuid)).filter(Boolean))];
      const customStatusNames = statusNames.filter((s) => !REVIZTO_AUTO_MAPPED_STATUSES[s]);
      if (!customStatusNames.length) return null;

      // "Required" means: this workflow is in use, so every one of its
      // own statuses could be reached by some issue — not just whichever
      // one an issue's current status happens to be sitting in right now.
      // "Optional" means the workflow isn't in use by any issue yet, so
      // nothing real depends on these statuses — admins can pre-configure
      // them, but they're never flagged as a warning.
      const inUse = inUseWorkflowUuids.has(w.uuid);
      const requiredNames = inUse ? [...customStatusNames].sort(sortByCanonicalThenName) : [];
      const optionalNames = inUse ? [] : [...customStatusNames].sort(sortByCanonicalThenName);

      const resolvedLabel = reviztoService.getWorkflowLabel(w.uuid, workflowSettings);
      const label = resolvedLabel || `Custom workflow ${(workflowCounter += 1)}`;

      // This workflow's own "Revizto Status" field (see pickReviztoStatusField)
      // — null (not []) when no matching field exists in ACC yet, so the
      // Setup UI can tell "no options configured" apart from "field not
      // created" and show a clear hint instead of a silently empty dropdown.
      const statusFieldDef = pickReviztoStatusField(statusFieldDefs, label);
      console.log(`[fieldMapping] Workflow "${label}" -> "Revizto Status" field: ${statusFieldDef ? `"${statusFieldDef.title}"` : 'NO MATCH (falls back to "Not available")'}`);
      const customStatusOptions = statusFieldDef
        ? (statusFieldDef.metadata?.list?.options || [])
            .map((o) => ({ id: o.id, label: String(o.value ?? o.label ?? '') }))
            .sort((a, b) => a.label.localeCompare(b.label))
        : null;

      return { uuid: w.uuid, label, required: requiredNames, optional: optionalNames, customStatusOptions };
    })
    .filter(Boolean);

  // Same "in use" filter for stamps — a project can have many stamp
  // templates defined that no current issue actually uses; without this
  // filter the mapping list (and the unmapped-count warning derived from
  // it) shows every template that's ever existed, not what's real today.
  const usedStampAbbrs = new Set(issues.map((i) => reviztoService.unwrap(i.stampAbbr)).filter(Boolean));
  const reviztoStamps = reviztoService.buildStampOptions(stampPresets).filter((s) => usedStampAbbrs.has(s.value));

  return {
    workflows, // [{ uuid, label, required: [...names], optional: [...names], customStatusOptions: [{id,label}]|null }] — one group per in-use custom workflow
    autoMappedStatuses, // read-only informational rows for the UI — canonical names, same across every workflow
    accStatuses: ACC_STATUS_OPTIONS, // the FULL fixed 9 — dropdown target options for both required and optional rows
    accSubtypes: subtypes.map((s) => ({ id: s.id, label: `${s.issueTypeTitle} > ${s.title}` })),
    reviztoStamps,
  };
}

// ─── Status map CRUD ───────────────────────────────────────────────

/**
 * Nested { [workflowUuid]: { [reviztoStatus]: { accStatus,
 * accCustomStatusOptionId } } } — the '' bucket holds rows saved before
 * workflow scoping existed (workflow_uuid defaults to '' for those), used
 * as a fallback so pre-migration mappings keep applying instead of
 * silently disappearing (see reviztoService.toAccIssue).
 * accCustomStatusOptionId is the ACC "Revizto Status" list field's option
 * ID (nullable — most statuses only need the primary accStatus), used by
 * syncService.handleAccWebhook to resolve the ACC->Revizto direction
 * precisely when several statuses in one workflow share a primary status.
 */
async function getStatusMap(projectId) {
  const { rows } = await pool.query(
    'SELECT workflow_uuid, revizto_status, acc_status, acc_custom_status_option_id FROM status_map WHERE project_id = $1',
    [projectId]
  );
  const map = {};
  for (const r of rows) {
    (map[r.workflow_uuid] = map[r.workflow_uuid] || {})[r.revizto_status] = {
      accStatus: r.acc_status,
      accCustomStatusOptionId: r.acc_custom_status_option_id,
    };
  }
  return map;
}

async function saveStatusMap(projectId, mappings) {
  // mappings: [{ workflowUuid, reviztoStatus, accStatus, accCustomStatusOptionId }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM status_map WHERE project_id = $1', [projectId]);
    for (const m of mappings) {
      if (!m.reviztoStatus || !m.accStatus) continue;
      await client.query(
        'INSERT INTO status_map (project_id, workflow_uuid, revizto_status, acc_status, acc_custom_status_option_id) VALUES ($1, $2, $3, $4, $5)',
        [projectId, m.workflowUuid || '', m.reviztoStatus, m.accStatus, m.accCustomStatusOptionId || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Auto-sync filter CRUD ────────────────────────────────────────────

/**
 * { field: [values] } — one row per (field, value) pair, grouped back
 * into arrays. Empty object if nothing configured yet.
 */
async function getAutoSyncFilters(projectId) {
  const { rows } = await pool.query('SELECT field, value FROM auto_sync_filters WHERE project_id = $1', [projectId]);
  const filters = {};
  for (const r of rows) {
    (filters[r.field] = filters[r.field] || []).push(r.value);
  }
  return filters;
}

async function saveAutoSyncFilters(projectId, filters) {
  // filters: { field: [values] }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM auto_sync_filters WHERE project_id = $1', [projectId]);
    for (const [field, values] of Object.entries(filters || {})) {
      for (const value of values || []) {
        if (!value) continue;
        await client.query('INSERT INTO auto_sync_filters (project_id, field, value) VALUES ($1, $2, $3)', [projectId, field, value]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Type map CRUD ───────────────────────────────────────────────────

async function getTypeMap(projectId) {
  const { rows } = await pool.query('SELECT revizto_type, acc_subtype_id FROM type_map WHERE project_id = $1', [projectId]);
  return Object.fromEntries(rows.map((r) => [r.revizto_type, r.acc_subtype_id]));
}

async function saveTypeMap(projectId, mappings) {
  // mappings: [{ reviztoType, accSubtypeId }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM type_map WHERE project_id = $1', [projectId]);
    for (const m of mappings) {
      if (!m.reviztoType || !m.accSubtypeId) continue;
      await client.query(
        'INSERT INTO type_map (project_id, revizto_type, acc_subtype_id) VALUES ($1, $2, $3)',
        [projectId, m.reviztoType, m.accSubtypeId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For the Setup page's top-of-page warning: which in-use statuses/stamps
 * have no configured mapping yet. Admin-facing — this is an action item,
 * not a general stat (unlike getSyncStats, which any user can see).
 */
async function getUnmappedFields(userId, project) {
  const [mappingOptions, savedStatusMap, savedTypeMap] = await Promise.all([
    getMappingOptions(userId, project),
    getStatusMap(project.id),
    getTypeMap(project.id),
  ]);

  // Flatten every in-use workflow's required statuses, checking each
  // against that SAME workflow's saved mappings (falling back to the ''
  // legacy bucket) — a status mapped under one workflow doesn't count as
  // mapped for a different workflow's same-named status.
  const unmappedStatuses = mappingOptions.workflows.flatMap((w) =>
    w.required
      .filter((s) => !(savedStatusMap[w.uuid]?.[s]?.accStatus ?? savedStatusMap['']?.[s]?.accStatus))
      .map((s) => (mappingOptions.workflows.length > 1 ? `${s} (${w.label})` : s))
  );
  const mappedStampAbbrs = new Set(Object.keys(savedTypeMap));
  const unmappedStamps = (mappingOptions.reviztoStamps || [])
    .filter((s) => !mappedStampAbbrs.has(s.value))
    .map((s) => s.label);

  return { unmappedStatuses, unmappedStamps };
}

module.exports = {
  ACC_STATUS_OPTIONS,
  ACC_AUTO_MAPPED_STATUSES,
  REVIZTO_AUTO_MAPPED_STATUSES,
  isReviztoStatusFieldTitle,
  pickReviztoStatusField,
  getMappingOptions,
  getStatusMap,
  saveStatusMap,
  getTypeMap,
  saveTypeMap,
  getAutoSyncFilters,
  saveAutoSyncFilters,
  getUnmappedFields,
};
