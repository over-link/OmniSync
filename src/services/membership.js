/**
 * services/membership.js
 * Is someone a real member of a paired project on BOTH sides — Revizto and
 * ACC — not just invited? Project admins and standard users only see a
 * project they've been added to here (project_members) AND that they
 * actually belong to in both tools (services/access.js applies this).
 * License admins aren't checked: they're the ones who pair projects, so
 * they must get in before any pairing exists.
 *
 * Member lists are read through each project's OWNER connection (the
 * license admin who paired it) — at sign-in the person hasn't connected
 * anything of their own yet, so their own tokens can't answer this.
 * Cached per project for MEMBER_CACHE_MS, which is also how quickly a
 * removal takes effect for someone already signed in.
 *
 * "Member" means:
 *   - Revizto (GET /project/{uuid}/team): on the team, invite accepted
 *     (invited: false) and an active license member (status 1).
 *   - ACC (Admin API project users): status 'active' ('pending' is an
 *     invite not yet accepted).
 */
const accService = require('./accService');
const reviztoService = require('./reviztoService');

const MEMBER_CACHE_MS = 15 * 60 * 1000;

const ACCESS_DENIED_MESSAGE = 'Access denied. You are not a member of both Revizto & ACC. Please contact your administrator.';
const COULD_NOT_VERIFY_MESSAGE =
  "Couldn't confirm your project membership right now — the project's Revizto or ACC connection isn't responding. Please try again later or contact your administrator.";

const REVIZTO_ACTIVE_STATUS = 1;

// Shown when someone tries to pair without Revizto License administrator
// rights on the license (Project Setup shows the same text in a pop-up).
const REVIZTO_LICENSE_ROLE_MESSAGE = 'You do not have the necessary license role in Revizto to pair projects. Please contact your license admin.';

class MembershipUnknownError extends Error {}

const _cache = new Map(); // projectId -> { at, members: { revizto: Set, acc: Set } }
const _inFlight = new Map(); // projectId -> Promise, so concurrent requests share one lookup

const _email = (e) => String(e || '').toLowerCase().trim();

function isPaired(project) {
  return !!(project.owner_user_id && project.revizto_project_uuid && project.acc_project_id);
}

async function _fetchMembers(project) {
  const ownerId = project.owner_user_id;
  const [reviztoTeam, accMembers] = await Promise.all([
    reviztoService.getProjectTeam(ownerId, project.revizto_region, project.revizto_project_uuid),
    accService.getProjectMembers(ownerId, project),
  ]);
  return {
    revizto: new Set(
      reviztoTeam.filter((m) => m.email && m.invited === false && m.status === REVIZTO_ACTIVE_STATUS).map((m) => _email(m.email))
    ),
    acc: new Set(accMembers.filter((m) => m.email && String(m.status).toLowerCase() === 'active').map((m) => _email(m.email))),
  };
}

/**
 * { revizto: Set<email>, acc: Set<email> } of real members, from cache
 * when fresh. If a refresh fails, the last known lists keep being used
 * (one bad call shouldn't lock a whole team out); with nothing cached it
 * throws MembershipUnknownError.
 */
async function _projectMembers(project) {
  const cached = _cache.get(Number(project.id));
  if (cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached.members;
  if (!_inFlight.has(Number(project.id))) {
    const lookup = _fetchMembers(project)
      .then((members) => {
        _cache.set(Number(project.id), { at: Date.now(), members });
        return members;
      })
      .catch((err) => {
        const why = err.response?.data?.message || err.message;
        if (cached) {
          console.warn(`[membership] Couldn't refresh members of "${project.name}" (${why}) — using the list from ${new Date(cached.at).toISOString()}.`);
          return cached.members;
        }
        console.warn(`[membership] Couldn't read members of "${project.name}": ${why}`);
        throw new MembershipUnknownError(why);
      })
      .finally(() => _inFlight.delete(Number(project.id)));
    _inFlight.set(Number(project.id), lookup);
  }
  return _inFlight.get(Number(project.id));
}

/**
 * Of `projects` (full rows), which ones `email` really belongs to on both
 * sides: { memberIds: Set<projectId>, unknownIds: Set<projectId> } —
 * unknown when the lists couldn't be read at all. An unpaired project
 * can't be checked and never qualifies.
 */
async function checkProjects(email, projects) {
  const target = _email(email);
  const memberIds = new Set();
  const unknownIds = new Set();
  await Promise.all(
    projects.filter(isPaired).map(async (project) => {
      try {
        const members = await _projectMembers(project);
        if (members.revizto.has(target) && members.acc.has(target)) memberIds.add(Number(project.id));
      } catch (err) {
        if (!(err instanceof MembershipUnknownError)) throw err;
        unknownIds.add(Number(project.id));
      }
    })
  );
  return { memberIds, unknownIds };
}

// Revizto project roles that count as "project admin" for the pairing
// check below. Revizto's API only gives a role's name and whether it's a
// system role, not its permissions, so this is a fixed list (user's
// choice, 2026-09-25): the two system roles plus this license's own
// "Administrate" role.
const REVIZTO_ADMIN_SYSTEM_ROLES = [1, 2]; // 1 Owner, 2 License administrator
const REVIZTO_ADMIN_ROLE_NAMES = ['administrate'];

function _isReviztoAdminRole(accessRole) {
  if (!accessRole) return false;
  return REVIZTO_ADMIN_SYSTEM_ROLES.includes(accessRole.system) || REVIZTO_ADMIN_ROLE_NAMES.includes(String(accessRole.name || '').toLowerCase().trim());
}

/**
 * Pairing check: is `email` a Revizto license administrator of the chosen
 * license, and a project admin of this Revizto project AND this ACC
 * project? Read with `userId`'s own connections (the license
 * admin doing the pairing — they had to browse both projects to pick
 * them). Returns a list of problems, empty if they qualify. An ACC 403 on
 * the member list means their ACC account can't administer the project.
 * Other lookup failures throw.
 */
async function projectAdminProblems(userId, email, { revizto_region, revizto_license_uuid, revizto_project_uuid, acc_project_id }) {
  const target = _email(email);
  const problems = [];
  const [adminLicenses, reviztoTeam, accMembers] = await Promise.all([
    reviztoService.getAdminLicenses(userId, revizto_region),
    reviztoService.getProjectTeam(userId, revizto_region, revizto_project_uuid),
    accService.getProjectMembers(userId, { acc_project_id }).catch((err) => {
      if (err.response?.status === 403) return null;
      throw err;
    }),
  ]);
  // Pairing also needs Revizto License administrator rights on the chosen
  // license (user's decision 2026-09-25), and the Revizto project has to
  // be in that license.
  if (!adminLicenses.some((l) => l.uuid === revizto_license_uuid)) {
    problems.push(REVIZTO_LICENSE_ROLE_MESSAGE);
  } else {
    const licenseProjects = await reviztoService.getProjects(userId, revizto_region, revizto_license_uuid);
    if (!licenseProjects.some((p) => p.uuid === revizto_project_uuid)) problems.push("That Revizto project isn't in the chosen license.");
  }
  const reviztoMe = reviztoTeam.find((m) => _email(m.email) === target);
  if (!reviztoMe || reviztoMe.invited !== false || reviztoMe.status !== REVIZTO_ACTIVE_STATUS) {
    problems.push(`You're not a member of this Revizto project (as ${target}).`);
  } else if (!_isReviztoAdminRole(reviztoMe.accessRole)) {
    problems.push(`Your Revizto role on this project is "${reviztoMe.accessRole?.name || 'unknown'}" — it needs to be Owner, License administrator or Administrate.`);
  }
  const accMe = (accMembers || []).find((m) => _email(m.email) === target);
  if (!accMe || String(accMe.status).toLowerCase() !== 'active') {
    problems.push(`You're not an active member of this ACC project (as ${target}).`);
  } else if (!accMe.accessLevels?.projectAdmin && !accMe.accessLevels?.accountAdmin) {
    // Project admin, or higher (ACC account admin) — still must be on the project.
    problems.push("You're not a project admin of this ACC project.");
  }
  return problems;
}

/** Drop a project's cached lists (e.g. after it's re-paired). */
function forget(projectId) {
  _cache.delete(Number(projectId));
}

module.exports = {
  ACCESS_DENIED_MESSAGE,
  COULD_NOT_VERIFY_MESSAGE,
  REVIZTO_LICENSE_ROLE_MESSAGE,
  MEMBER_CACHE_MS,
  isPaired,
  checkProjects,
  projectAdminProblems,
  forget,
};
