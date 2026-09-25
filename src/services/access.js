/**
 * services/access.js
 * Who can see and do what — the single source of truth for roles (see
 * schema.sql "Roles"). Two layers:
 *   - license role (users.role): primary_license_admin / license_admin see
 *     and manage every project under the license; 'member' has none.
 *   - project role (project_members.role): project_admin / standard, per
 *     project. A member sees ONLY projects they've been added to.
 *
 * Everyone's effective role on a project is one rank on a single ladder,
 * so "assign up to your own role, manage only those below it" is just a
 * rank comparison.
 */
const pool = require('../db/pool');
const membership = require('./membership');

const RANK = { standard: 1, project_admin: 2, license_admin: 3, primary_license_admin: 4 };
const LICENSE_ROLES = ['primary_license_admin', 'license_admin'];
const PROJECT_ROLES = ['project_admin', 'standard'];

const ROLE_LABELS = {
  primary_license_admin: 'Primary license admin',
  license_admin: 'License admin',
  project_admin: 'Project admin',
  standard: 'Standard',
};

const isLicenseAdminRole = (role) => LICENSE_ROLES.includes(role);

/**
 * Everything needed to decide access for one user:
 * { userId, email, licenseRole (or null), isLicenseAdmin, isPrimary,
 *   projectRoles: Map(projectId -> 'project_admin' | 'standard'),
 *   invitedProjectCount, archivedProjectCount, unverifiedProjectIds: Set }.
 *
 * projectRoles holds only projects the person is invited to here AND
 * really belongs to in both Revizto and ACC (services/membership.js) — an
 * invite alone isn't access. invitedProjectCount counts every invite, so
 * callers can tell "invited but not a member anywhere" from "not invited";
 * archived projects never count (archivedProjectCount says how many of
 * their invites are to one); unverifiedProjectIds are invites whose member
 * lists couldn't be read.
 */
async function getAccess(userId) {
  const [{ rows: userRows }, { rows: inviteRows }] = await Promise.all([
    pool.query('SELECT id, email, role FROM users WHERE id = $1', [userId]),
    pool.query(
      `SELECT pm.project_id, pm.role, p.id, p.name, p.owner_user_id, p.revizto_region, p.revizto_project_uuid, p.acc_project_id, p.archived_at
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = $1`,
      [userId]
    ),
  ]);
  const memberRows = inviteRows.filter((r) => !r.archived_at); // archived: no access
  const user = userRows[0];
  if (!user) return null;
  const licenseRole = isLicenseAdminRole(user.role) ? user.role : null;
  let projectRoles = new Map();
  let unverifiedProjectIds = new Set();
  if (!licenseRole && memberRows.length) {
    const { memberIds, unknownIds } = await membership.checkProjects(user.email, memberRows);
    // A project admin of a not-yet-paired project keeps it — pairing it is
    // their job, and there's no Revizto/ACC membership to check (or data to
    // see) until then. Pairing itself requires being a project admin in both
    // (membership.projectAdminProblems), and from then on the normal check applies.
    const pairsIt = (r) => r.role === 'project_admin' && !membership.isPaired(r);
    projectRoles = new Map(
      memberRows.filter((r) => memberIds.has(Number(r.project_id)) || pairsIt(r)).map((r) => [Number(r.project_id), r.role])
    );
    unverifiedProjectIds = unknownIds;
  }
  return {
    userId: user.id,
    email: user.email,
    licenseRole,
    isLicenseAdmin: !!licenseRole,
    isPrimary: licenseRole === 'primary_license_admin',
    projectRoles,
    invitedProjectCount: memberRows.length,
    archivedProjectCount: inviteRows.length - memberRows.length,
    unverifiedProjectIds,
  };
}

/**
 * Why this person can't use the app right now, or null if they can: a
 * license admin always can; anyone else needs at least one project they
 * really belong to (see getAccess). The message is what the sign-in page
 * shows in its pop-up.
 */
function denialMessage(access) {
  if (!access) return membership.ACCESS_DENIED_MESSAGE;
  if (access.isLicenseAdmin || access.projectRoles.size) return null;
  // Couldn't read a project's lists at all — don't tell a real member
  // they aren't one.
  if (access.unverifiedProjectIds.size) return membership.COULD_NOT_VERIFY_MESSAGE;
  // A project of theirs was archived and nothing else gives them access —
  // say that, rather than "you're not a member".
  if (access.archivedProjectCount) return membership.PROJECT_ARCHIVED_MESSAGE;
  return membership.ACCESS_DENIED_MESSAGE;
}

/**
 * The user's effective role on a project — a license admin's license role
 * outranks any project role — or null if they have no access to it.
 */
function effectiveProjectRole(access, projectId) {
  if (!access) return null;
  if (access.licenseRole) return access.licenseRole;
  return access.projectRoles.get(Number(projectId)) || null;
}

function hasProjectRole(access, projectId, minRole) {
  const role = effectiveProjectRole(access, projectId);
  return !!role && RANK[role] >= RANK[minRole];
}

/** Project ids the user can see, or null meaning "all" (license admins). */
function accessibleProjectIds(access) {
  if (!access) return [];
  if (access.isLicenseAdmin) return null;
  return [...access.projectRoles.keys()];
}

/** True if this user admins at least one project (or the license). */
function isAnyProjectAdmin(access) {
  if (!access) return false;
  if (access.isLicenseAdmin) return true;
  return [...access.projectRoles.values()].includes('project_admin');
}

/**
 * Project roles this user may give someone on `projectId` — up to and
 * including their own role, never above it: a project admin can bring in
 * fellow project admins (and standard users), a license admin either. A
 * standard user can't give roles at all.
 */
function assignableProjectRoles(access, projectId) {
  const mine = RANK[effectiveProjectRole(access, projectId)] || 0;
  if (mine < RANK.project_admin) return [];
  return PROJECT_ROLES.filter((r) => RANK[r] <= mine);
}

/**
 * Whether `access` may change or remove a member currently holding
 * `targetRole` on the project: anyone at or below your own role — so a
 * project admin can also change or remove a fellow project admin (e.g.
 * someone who's left the company) without waiting on a license admin.
 * Callers separately block changing your own role, and license admins
 * are never managed from a project (see routes/team.js).
 */
function canManageMember(access, projectId, targetRole) {
  const mine = RANK[effectiveProjectRole(access, projectId)] || 0;
  if (mine < RANK.project_admin) return false;
  return (RANK[targetRole] || 0) <= mine;
}

/** Short label for the badge next to someone's name. */
function displayRole(access) {
  if (!access) return null;
  if (access.licenseRole) return ROLE_LABELS[access.licenseRole];
  return isAnyProjectAdmin(access) ? ROLE_LABELS.project_admin : ROLE_LABELS.standard;
}

module.exports = {
  RANK,
  ROLE_LABELS,
  PROJECT_ROLES,
  LICENSE_ROLES,
  isLicenseAdminRole,
  getAccess,
  denialMessage,
  effectiveProjectRole,
  hasProjectRole,
  accessibleProjectIds,
  isAnyProjectAdmin,
  assignableProjectRoles,
  canManageMember,
  displayRole,
};
