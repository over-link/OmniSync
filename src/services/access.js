/**
 * services/access.js
 * Who can see and do what — the single source of truth for roles (see
 * schema.sql "Roles"). Everything is scoped to the person's ACTIVE LICENSE
 * (docs/multi-tenant-architecture.md): each license is its own access
 * boundary, so nothing here ever reaches another license's projects or people.
 *   - license role (license_members.role in the active license):
 *     primary_license_admin (the company's account owner) / license_admin see
 *     and manage every project OF THAT LICENSE; 'member' has none.
 *   - project role (project_members.role): project_admin / standard, per
 *     project of that license. A member sees ONLY projects they've been added to.
 *
 * Everyone's effective role on a project is one rank on a single ladder,
 * so "assign up to your own role, manage only those below it" is just a
 * rank comparison.
 */
// Unrestricted on purpose: db/pool.js (row-level security) — this module looks across licenses / holds per-user secrets.
const pool = require('../db/pool').admin;
const membership = require('./membership');
const licenseState = require('./licenseState');

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
 * Everything needed to decide access for one user, in one license:
 * { userId, email, licenseId, tenantId, licenses (every license they belong
 *   to, with their role, company, phase and whether it's usable / still listed), licenseRole (or null), isLicenseAdmin,
 *   isPrimary, licenseProjectIds (Set — every project of the active license),
 *   projectRoles: Map(projectId -> 'project_admin' | 'standard'),
 *   invitedProjectCount, archivedProjectCount, unverifiedProjectIds: Set }.
 *
 * The active license is `forLicenseId` when given (someone else's access in a
 * particular license — e.g. a project's), otherwise the one they have open
 * (users.current_license_id) if they belong to it, else their first one. No
 * license at all means no access.
 *
 * projectRoles holds only projects of that license the person is invited to
 * here AND really belongs to in both Revizto and ACC (services/membership.js)
 * — an invite alone isn't access. invitedProjectCount counts every invite in
 * the license, so callers can tell "invited but not a member anywhere" from
 * "not invited"; archived projects never count (archivedProjectCount says how
 * many of their invites are to one); unverifiedProjectIds are invites whose
 * member lists couldn't be read.
 */
async function getAccess(userId, forLicenseId = null) {
  const first = await _getAccessIn(userId, forLicenseId);
  // The open license gives them nothing (not usable, no admin role, no project
  // they really belong to) but another license of theirs does: open that one
  // instead of refusing them. Only when they didn't ask for one specific license.
  const gives = (acc) => acc.licenseState?.usable !== false && (acc.isLicenseAdmin || acc.projectRoles.size);
  if (!first || forLicenseId != null || gives(first) || first.adminLimited || first.licenses.length < 2) return first;
  for (const other of first.licenses) {
    if (other.id === first.licenseId) continue;
    const candidate = await _getAccessIn(userId, other.id);
    if (candidate && gives(candidate)) {
      await pool.query('UPDATE users SET current_license_id = $2 WHERE id = $1', [userId, other.id]);
      return candidate;
    }
  }
  return first;
}

async function _getAccessIn(userId, forLicenseId) {
  const [{ rows: userRows }, { rows: licenseRows }] = await Promise.all([
    pool.query('SELECT id, email, role, current_license_id FROM users WHERE id = $1', [userId]),
    pool.query(
      `SELECT m.tenant_license_id AS license_id, m.role, l.tenant_id, l.name, t.name AS company_name, t.account_owner_user_id
       FROM license_members m
       JOIN tenant_licenses l ON l.id = m.tenant_license_id
       JOIN tenants t ON t.id = l.tenant_id
       WHERE m.user_id = $1 ORDER BY m.id`,
      [userId]
    ),
  ]);
  const user = userRows[0];
  if (!user) return null;
  const licenseStates = new Map((await licenseState.loadMany(licenseRows.map((l) => l.license_id))).map((l) => [l.id, l.state]));
  const wanted = forLicenseId != null ? Number(forLicenseId) : user.current_license_id;
  const active =
    licenseRows.find((l) => l.license_id === wanted) || (forLicenseId != null ? null : licenseRows[0]) || null;
  const licenseRole = active && active.role === 'license_admin' ? (active.account_owner_user_id === user.id ? 'primary_license_admin' : 'license_admin') : null;
  const base = {
    userId: user.id,
    email: user.email,
    licenseId: active ? active.license_id : null,
    tenantId: active ? active.tenant_id : null,
    licenses: licenseRows.map((l) => {
      const st = licenseStates.get(l.license_id);
      return { id: l.license_id, name: l.name, companyName: l.company_name, role: l.role, phase: st?.phase, usable: st?.usable !== false, visible: st ? st.visible : true, message: st?.message || null };
    }),
    licenseRole,
    isLicenseAdmin: !!licenseRole,
    isPrimary: licenseRole === 'primary_license_admin',
    licenseProjectIds: new Set(),
    projectRoles: new Map(),
    invitedProjectCount: 0,
    archivedProjectCount: 0,
    unverifiedProjectIds: new Set(),
  };
  if (!active) return base;
  // The state of the open license (services/licenseState.js). Not usable =
  // blocked, except a license over its slot limit: its license admins may still
  // manage (archive / delete) its projects to get back under the limit.
  const state = licenseStates.get(active.license_id) || null;
  base.licenseState = state;
  base.adminLimited = !!state && !state.usable && state.adminLimited && !!licenseRole;

  const [{ rows: inviteRows }, { rows: licenseProjects }] = await Promise.all([
    pool.query(
      `SELECT pm.project_id, pm.role, p.id, p.name, p.owner_user_id, p.revizto_region, p.revizto_project_uuid, p.acc_project_id, p.archived_at
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = $1 AND p.tenant_license_id = $2`,
      [userId, active.license_id]
    ),
    pool.query('SELECT id FROM projects WHERE tenant_license_id = $1', [active.license_id]),
  ]);
  base.licenseProjectIds = new Set(licenseProjects.map((r) => r.id));
  if (state && !state.usable) return base; // blocked: no project roles, nothing to open
  const memberRows = inviteRows.filter((r) => !r.archived_at); // archived: no access
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
    ...base,
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
  // The license itself is expired / suspended / not started: say so (a license
  // over its slot limit still lets its license admins in, to fix it).
  if (access.licenseState && !access.licenseState.usable) return access.adminLimited ? null : access.licenseState.message;
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
  if (access.licenseRole) return access.licenseProjectIds.has(Number(projectId)) ? access.licenseRole : null;
  return access.projectRoles.get(Number(projectId)) || null;
}

function hasProjectRole(access, projectId, minRole) {
  const role = effectiveProjectRole(access, projectId);
  return !!role && RANK[role] >= RANK[minRole];
}

/** Project ids the user can see: every project of the active license for a
 *  license admin, otherwise the ones they have a role on. Always a list. */
function accessibleProjectIds(access) {
  if (!access) return [];
  if (access.isLicenseAdmin) return [...access.licenseProjectIds];
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
