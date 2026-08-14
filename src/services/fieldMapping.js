/**
 * services/fieldMapping.js
 * Lets admins configure the Revizto -> ACC status and issue-type mappings
 * per project (ACC -> Revizto status has no admin UI — see
 * ACC_AUTO_MAPPED_STATUSES/mapStatusFromAcc). Status: the 4 canonical
 * Revizto status names (Open/In progress/Solved/Closed) auto-map with no
 * config needed; every other custom status falls back to ACC "Draft" (a
 * deliberate safeguard, not a guess) until explicitly mapped. Type: an
 * unmapped stamp falls back to the project's configured default subtype,
 * then reviztoService's STAMP_SUBTYPE_MAP title-keyword matching as a
 * last resort. Configured mappings always take priority over either
 * fallback.
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
// config (no UI for this direction at all — see README). Uses the
// confirmed "In progress" casing (lowercase "p") from CANONICAL_STATUS_
// ORDER, not "In Progress" — Revizto's real status name is case-sensitive
// for the diff-write mechanism. Only the remaining 5 ACC statuses
// (in_review, not_approved, in_dispute, draft, pending) fall back to
// reviztoService.mapStatusFromAcc's hardcoded guess.
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

async function getMappingOptions(userId, project) {
  const [issues, subtypes, stampPresets, workflowSettings] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    accService.getIssueSubtypes(userId, project),
    reviztoService.getStampPresets(userId, project.revizto_region, project.revizto_project_uuid).catch(() => []),
    reviztoService.getWorkflowSettings(userId, project.revizto_region, project.revizto_project_uuid).catch(() => ({ statuses: [] })),
  ]);

  // Every status name still valid within some currently-active workflow —
  // needed for the "optional" tier below, so an admin can pre-configure a
  // status before any real issue uses it. NOT the flat project-wide
  // settings.statuses list alone: that can retain status names no longer
  // attached to any real workflow (confirmed by real testing — a plain
  // `!deletedAt` filter on the flat list still showed deleted custom
  // statuses). Cross-references each workflow's own valid-status UUIDs
  // against the flat list for names, the same pattern already proven in
  // _resolveStatusUuidForIssue.
  const validStatusUuids = new Set(
    (workflowSettings?.workflows || [])
      .filter((w) => !w.deletedAt)
      .flatMap((w) => (w.statuses || []).filter((s) => !s.deletedAt).map((s) => s.uuid))
  );
  const allDefinedStatusNames = [
    ...new Set((workflowSettings?.statuses || []).filter((s) => !s.deletedAt && validStatusUuids.has(s.uuid)).map((s) => s.name)),
  ];

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
  const types = workflowSettings?.types || [];
  const inUseWorkflowUuids = new Set(
    issues
      .map((i) => i.customType?.value)
      .filter(Boolean)
      .map((typeUuid) => types.find((t) => t.uuid === typeUuid)?.workflowUuid)
      .filter(Boolean)
  );
  const statusNameByUuid = new Map((workflowSettings?.statuses || []).filter((s) => !s.deletedAt).map((s) => [s.uuid, s.name]));
  const requiredFromWorkflows = new Set();
  for (const w of workflowSettings?.workflows || []) {
    if (w.deletedAt || !inUseWorkflowUuids.has(w.uuid)) continue;
    for (const s of w.statuses || []) {
      if (s.deletedAt) continue;
      const name = statusNameByUuid.get(s.uuid);
      if (name) requiredFromWorkflows.add(name);
    }
  }
  // Union with the literal in-use statuses too, as a safety net for any
  // issue whose type/workflow didn't resolve above (e.g. no customType
  // set) — same fallback reasoning as _resolveStatusUuidForIssue.
  const requiredStatusNames = new Set([...requiredFromWorkflows, ...inUseStatuses]);

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

  // Editable, required rows: every other custom status in requiredStatusNames
  // (in use directly, or belonging to a workflow that's in use). Unmapped
  // ones are highlighted red and flagged — they still sync (defaulting to
  // ACC "Draft" as a safeguard, see toAccIssue).
  const mappableStatusNames = [...requiredStatusNames].filter((s) => !REVIZTO_AUTO_MAPPED_STATUSES[s]);
  const reviztoStatuses = mappableStatusNames.sort(sortByCanonicalThenName);

  // Editable, optional rows: statuses that exist in a workflow but that
  // workflow isn't in use by any current issue yet — admins can
  // pre-configure these, but they're never flagged red/warned since
  // nothing real depends on them yet. Once a real issue starts using that
  // workflow, all of its statuses move into reviztoStatuses above on the
  // next load (same underlying status_map row still applies either way —
  // this is purely a visibility/urgency distinction, not a different
  // storage or push mechanism).
  const optionalStatusNames = allDefinedStatusNames.filter((s) => !requiredStatusNames.has(s) && !REVIZTO_AUTO_MAPPED_STATUSES[s]);
  const optionalStatuses = optionalStatusNames.sort(sortByCanonicalThenName);

  // Same "in use" filter for stamps — a project can have many stamp
  // templates defined that no current issue actually uses; without this
  // filter the mapping list (and the unmapped-count warning derived from
  // it) shows every template that's ever existed, not what's real today.
  const usedStampAbbrs = new Set(issues.map((i) => reviztoService.unwrap(i.stampAbbr)).filter(Boolean));
  const reviztoStamps = reviztoService.buildStampOptions(stampPresets).filter((s) => usedStampAbbrs.has(s.value));

  return {
    reviztoStatuses, // editable/mappable, required — custom statuses in use on any current issue
    reviztoStatusesInUse: reviztoStatuses, // kept for the unmapped-warning check — same meaning now (mappable statuses actually in use)
    optionalStatuses, // editable, optional — defined in a workflow but not used by any issue yet; never warned/highlighted
    autoMappedStatuses, // read-only informational rows for the UI
    accStatuses: ACC_STATUS_OPTIONS, // the FULL fixed 9 — dropdown target options for both required and optional rows
    accSubtypes: subtypes.map((s) => ({ id: s.id, label: `${s.issueTypeTitle} > ${s.title}` })),
    reviztoStamps,
  };
}

// ─── Status map CRUD ───────────────────────────────────────────────

async function getStatusMap(projectId) {
  const { rows } = await pool.query('SELECT revizto_status, acc_status FROM status_map WHERE project_id = $1', [projectId]);
  return Object.fromEntries(rows.map((r) => [r.revizto_status, r.acc_status]));
}

async function saveStatusMap(projectId, mappings) {
  // mappings: [{ reviztoStatus, accStatus }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM status_map WHERE project_id = $1', [projectId]);
    for (const m of mappings) {
      if (!m.reviztoStatus || !m.accStatus) continue;
      await client.query(
        'INSERT INTO status_map (project_id, revizto_status, acc_status) VALUES ($1, $2, $3)',
        [projectId, m.reviztoStatus, m.accStatus]
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

  const unmappedStatuses = mappingOptions.reviztoStatusesInUse.filter((s) => !savedStatusMap[s]);
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
  getMappingOptions,
  getStatusMap,
  saveStatusMap,
  getTypeMap,
  saveTypeMap,
  getUnmappedFields,
};
