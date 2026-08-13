/**
 * services/fieldMapping.js
 * Lets admins configure Revizto <-> ACC status and issue-type mappings
 * per project. Status: "To do"/"Completed" category statuses auto-map
 * with no config needed; everything else falls back to ACC "Draft" (a
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

// Category-based auto status routing — confirmed from real docs (GET
// .../issue-workflow/settings, statuses[].category = "To do" | "Tracking"
// | "Completed"). "To do"/"Completed" always route to a fixed ACC status
// with no admin config needed, matching reviztoService.toAccIssue exactly
// — only "Tracking" (Revizto's own description: "in-progress issues...
// being worked on or investigated") needs a judgment call, since ACC has
// several statuses that could reasonably apply.
const AUTO_MAPPED_CATEGORIES = { 'To do': 'open', Completed: 'completed' };

// Reverse direction (ACC->Revizto), explicit request: these 4 ACC
// statuses have an unambiguous Revizto equivalent, so they always
// auto-map with no admin config — same treatment as the forward
// direction's "To do"/"Completed", just a flat lookup since ACC's status
// field has no category concept of its own to key off of. Uses the
// confirmed "In progress" casing (lowercase "p") from CANONICAL_STATUS_
// ORDER, not "In Progress" — Revizto's real status name is case-sensitive
// for the diff-write mechanism. Only the remaining 5 ACC statuses
// (in_review, not_approved, in_dispute, draft, pending) need admin
// mapping.
const ACC_AUTO_MAPPED_STATUSES = {
  open: 'Open',
  in_progress: 'In progress',
  completed: 'Solved',
  closed: 'Closed',
};

async function getMappingOptions(userId, project) {
  const [issues, subtypes, stampPresets, workflowSettings] = await Promise.all([
    reviztoService.getIssues(userId, project.revizto_region, project.revizto_project_uuid),
    accService.getIssueSubtypes(userId, project),
    reviztoService.getStampPresets(userId, project.revizto_region, project.revizto_project_uuid).catch(() => []),
    reviztoService.getWorkflowSettings(userId, project.revizto_region, project.revizto_project_uuid).catch(() => ({ statuses: [] })),
  ]);

  // name -> category. First non-deleted match wins if a name is somehow
  // reused across workflows with different categories — same caveat
  // already documented for the plain name->uuid map above.
  const categoryByStatusName = {};
  for (const s of workflowSettings?.statuses || []) {
    if (!s.deletedAt && !(s.name in categoryByStatusName)) categoryByStatusName[s.name] = s.category;
  }
  console.log(`[fieldMapping] Status categories for project "${project.name}":`, JSON.stringify(categoryByStatusName));

  // Every valid Revizto status name project-wide (not just in-use) — the
  // target list for the ACC->Revizto mapping dropdown below, so an admin
  // can map any real status, not only ones some issue already has.
  const allReviztoStatusNames = [...new Set((workflowSettings?.statuses || []).filter((s) => !s.deletedAt).map((s) => s.name))].sort();

  // In use on any current Revizto issue — shown from the start so an
  // admin can configure the project correctly upfront, not just after
  // issues get linked (explicit request: "things don't slip through the
  // cracks"). Same scope as the stamps list below.
  const inUseStatuses = [...new Set(issues.map((i) => reviztoService.unwrap(i.customStatusName)).filter(Boolean))];

  // Read-only informational rows — greyed out in the UI.
  const autoMappedStatuses = inUseStatuses
    .filter((s) => AUTO_MAPPED_CATEGORIES[categoryByStatusName[s]])
    .sort()
    .map((s) => ({ name: s, category: categoryByStatusName[s], accStatus: AUTO_MAPPED_CATEGORIES[categoryByStatusName[s]] }));

  // Editable rows: "Tracking" category statuses, plus (defensively) any
  // status whose category couldn't be resolved at all — those fall back
  // to the pre-category hardcoded map server-side (see toAccIssue), and
  // an admin should still be able to override that explicitly rather than
  // have no visibility into it.
  const mappableStatusNames = inUseStatuses.filter((s) => !AUTO_MAPPED_CATEGORIES[categoryByStatusName[s]]);
  const reviztoStatuses = [...mappableStatusNames].sort((a, b) => {
    const ai = CANONICAL_STATUS_ORDER.indexOf(a);
    const bi = CANONICAL_STATUS_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  // Same "in use" filter for stamps — a project can have many stamp
  // templates defined that no current issue actually uses; without this
  // filter the mapping list (and the unmapped-count warning derived from
  // it) shows every template that's ever existed, not what's real today.
  const usedStampAbbrs = new Set(issues.map((i) => reviztoService.unwrap(i.stampAbbr)).filter(Boolean));
  const reviztoStamps = reviztoService.buildStampOptions(stampPresets).filter((s) => usedStampAbbrs.has(s.value));

  // Reverse direction: split ACC's fixed 9 statuses the same way as the
  // forward direction — the 4 unambiguous ones are read-only/auto-mapped,
  // the rest need admin config.
  const autoMappedAccStatuses = Object.entries(ACC_AUTO_MAPPED_STATUSES).map(([accStatus, reviztoStatus]) => ({
    accStatus,
    reviztoStatus,
  }));
  const mappableAccStatuses = ACC_STATUS_OPTIONS.filter((s) => !ACC_AUTO_MAPPED_STATUSES[s]);

  return {
    reviztoStatuses, // editable/mappable only — Tracking (or unresolved-category) statuses in use on any current issue
    reviztoStatusesInUse: reviztoStatuses, // kept for the unmapped-warning check — same meaning now (mappable statuses actually in use)
    autoMappedStatuses, // read-only informational rows for the UI
    accStatuses: ACC_STATUS_OPTIONS, // the FULL fixed 9 — still used as dropdown target options for the Revizto->ACC "Tracking" mapping
    mappableAccStatuses, // editable rows only for the ACC->Revizto mapping UI — the 4 auto-mapped ones aren't included here
    autoMappedAccStatuses, // read-only informational rows for the ACC->Revizto mapping UI
    accSubtypes: subtypes.map((s) => ({ id: s.id, label: `${s.issueTypeTitle} > ${s.title}` })),
    reviztoStamps,
    allReviztoStatusNames, // target dropdown options for the ACC->Revizto mapping below
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

// ─── ACC->Revizto status map CRUD (the reverse direction) ────────────

async function getAccStatusMap(projectId) {
  const { rows } = await pool.query('SELECT acc_status, revizto_status FROM acc_status_map WHERE project_id = $1', [projectId]);
  return Object.fromEntries(rows.map((r) => [r.acc_status, r.revizto_status]));
}

async function saveAccStatusMap(projectId, mappings) {
  // mappings: [{ accStatus, reviztoStatus }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM acc_status_map WHERE project_id = $1', [projectId]);
    for (const m of mappings) {
      if (!m.accStatus || !m.reviztoStatus) continue;
      await client.query(
        'INSERT INTO acc_status_map (project_id, acc_status, revizto_status) VALUES ($1, $2, $3)',
        [projectId, m.accStatus, m.reviztoStatus]
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
  const [mappingOptions, savedStatusMap, savedTypeMap, savedAccStatusMap] = await Promise.all([
    getMappingOptions(userId, project),
    getStatusMap(project.id),
    getTypeMap(project.id),
    getAccStatusMap(project.id),
  ]);

  const unmappedStatuses = mappingOptions.reviztoStatusesInUse.filter((s) => !savedStatusMap[s]);
  const mappedStampAbbrs = new Set(Object.keys(savedTypeMap));
  const unmappedStamps = (mappingOptions.reviztoStamps || [])
    .filter((s) => !mappedStampAbbrs.has(s.value))
    .map((s) => s.label);
  // Only the 5 non-auto-mapped ACC statuses are candidates here — the 4
  // auto-mapped ones (open/in_progress/completed/closed) never need
  // config, so flagging them as "unmapped" would be a false warning.
  const unmappedAccStatuses = mappingOptions.mappableAccStatuses.filter((s) => !savedAccStatusMap[s]);

  return { unmappedStatuses, unmappedStamps, unmappedAccStatuses };
}

module.exports = {
  ACC_STATUS_OPTIONS,
  ACC_AUTO_MAPPED_STATUSES,
  getMappingOptions,
  getStatusMap,
  saveStatusMap,
  getAccStatusMap,
  saveAccStatusMap,
  getTypeMap,
  saveTypeMap,
  getUnmappedFields,
};
