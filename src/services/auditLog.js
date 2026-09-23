/**
 * services/auditLog.js
 * Durable, queryable "who did what, when" trail — see schema.sql's
 * audit_log table for the full rationale. `record` is called from
 * syncService at each point a field change, comment, attachment,
 * link/unlink, or error actually happens; `list` backs the "Activity Log"
 * page (open to any signed-in user, not admin-gated).
 *
 * Deliberately fire-and-forget from the caller's perspective in spirit —
 * every call site wraps `record` so a logging failure (e.g. a transient
 * DB hiccup) never takes down the actual sync work it's describing. See
 * each call site in syncService.js.
 */
const pool = require('../db/pool');

async function record({
  projectId = null,
  reviztoIssueId = null,
  accIssueId = null,
  direction = null,
  action,
  fieldName = null,
  oldValue = null,
  newValue = null,
  attributedEmail = null,
  outcome = 'success',
  detail = null,
}) {
  await pool.query(
    `INSERT INTO audit_log
       (project_id, revizto_issue_id, acc_issue_id, direction, action, field_name, old_value, new_value, attributed_email, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      projectId,
      reviztoIssueId != null ? String(reviztoIssueId) : null,
      accIssueId != null ? String(accIssueId) : null,
      direction,
      action,
      fieldName,
      oldValue != null ? String(oldValue) : null,
      newValue != null ? String(newValue) : null,
      attributedEmail,
      outcome,
      detail,
    ]
  );
}

/**
 * Paginated, optionally-filtered read for the Activity Log page. `projectId`
 * filters to one project; omit for "all projects this user can see" (the
 * page itself decides what to pass — every signed-in user can read this,
 * same as the rest of the app's non-admin pages).
 */
async function list({ projectId = null, limit = 100, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (projectId) {
    params.push(projectId);
    where = `WHERE audit_log.project_id = $${params.length}`;
  }
  params.push(limit, offset);
  // acc_display_id: ACC's human-readable issue number. Rows without an
  // acc_issue_id of their own (e.g. errors) borrow it from the issue's
  // current link, if it still has one.
  const { rows } = await pool.query(
    `SELECT audit_log.*, projects.name AS project_name,
            COALESCE(own_num.display_id, linked_num.display_id) AS acc_display_id
     FROM audit_log
     LEFT JOIN projects ON projects.id = audit_log.project_id
     LEFT JOIN acc_issue_numbers own_num
       ON own_num.project_id = audit_log.project_id AND own_num.acc_issue_id = audit_log.acc_issue_id
     LEFT JOIN sync_map
       ON audit_log.acc_issue_id IS NULL AND sync_map.project_id = audit_log.project_id AND sync_map.revizto_issue_id = audit_log.revizto_issue_id
     LEFT JOIN acc_issue_numbers linked_num
       ON linked_num.project_id = sync_map.project_id AND linked_num.acc_issue_id = sync_map.acc_issue_id
     ${where}
     ORDER BY audit_log.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

module.exports = { record, list };
