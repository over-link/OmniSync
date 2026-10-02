/**
 * services/currentProject.js
 * The one project each person has open, shared by every page (the
 * sidebar switcher in public/js/nav.js; first picked on My Connections'
 * "Open a project"). Stored on users.current_project_id so it follows
 * them across pages, sign-ins and devices.
 *
 * Which projects they can pick from is the same list /api/projects
 * returns: license admins every (non-archived) project on the license,
 * everyone else only the ones they're a member of (services/access.js).
 */
const pool = require('../db/pool');
const access = require('./access');
const pairingGuard = require('./pairingGuard');

/** Projects this person can open, each with their role on it. */
async function listProjects(userAccess) {
  const allowed = access.accessibleProjectIds(userAccess); // a list: every project of the active license for a license admin
  const { rows } = await pool.query(
    'SELECT * FROM projects WHERE archived_at IS NULL AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY created_at DESC',
    [allowed]
  );
  return rows.map((p) => ({ ...p, my_role: access.effectiveProjectRole(userAccess, p.id), pairing_paused: pairingGuard.pausedNotice(p) }));
}

/**
 * The project list plus which one is open. The saved choice wins while
 * it's still in their list; if it isn't (never picked, access removed,
 * archived) and they have exactly one project, that one is opened and
 * saved — otherwise none, and they pick on My Connections.
 */
async function resolve(userId, userAccess) {
  const projects = await listProjects(userAccess);
  const { rows } = await pool.query('SELECT current_project_id FROM users WHERE id = $1', [userId]);
  const saved = rows[0]?.current_project_id ?? null;
  let currentProjectId = projects.some((p) => p.id === saved) ? saved : null;
  if (!currentProjectId && projects.length === 1) currentProjectId = projects[0].id;
  if (currentProjectId !== saved) {
    await pool.query('UPDATE users SET current_project_id = $2 WHERE id = $1', [userId, currentProjectId]);
  }
  return { projects, currentProjectId };
}

/** Opens `projectId` for this person; false if it isn't one they can open. */
async function set(userId, userAccess, projectId) {
  const projects = await listProjects(userAccess);
  if (!projects.some((p) => p.id === projectId)) return false;
  await pool.query('UPDATE users SET current_project_id = $2 WHERE id = $1', [userId, projectId]);
  return true;
}

module.exports = { listProjects, resolve, set };
