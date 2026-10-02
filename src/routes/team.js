/**
 * routes/team.js
 * Per-project membership: who's on a project and with which role, invites,
 * and shareable invite links. The rules (see services/access.js): you can
 * give, change or remove roles up to your own — a project admin can add,
 * change or remove project admins and standard users (e.g. when someone
 * leaves the company), but nobody can change their own role, and license
 * admins are managed on License Administration (routes/license.js), not here.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireProjectRole } = require('./auth');
const emailService = require('../services/emailService');
const access = require('../services/access');
const syncService = require('../services/syncService');
const membership = require('../services/membership');
const tokenStore = require('../services/tokenStore');
const accService = require('../services/accService');
const webhookHealth = require('../services/webhookHealth');
const tenancy = require('../services/tenancy');

// Anyone on the project can see its team; only project admins and above
// see the controls (canInvite / canManage), and the routes below enforce it.
//
// last_login_at is its own column (set on every sign-in, /auth/login);
// latest activity is read live from audit_log for THIS project, matched
// case-insensitively since email casing isn't guaranteed identical between
// sign-in and what's resolved from Revizto/ACC member data.
router.get('/api/projects/:id/team', requireProjectRole('standard'), async (req, res) => {
  const projectId = Number(req.params.id);
  const [{ rows }, { rows: projectRows }] = await Promise.all([
    pool.query(
      `SELECT u.id, u.email, u.name AS account_name, u.last_login_at, la.latest_activity_at,
            (u.password_hash IS NULL) AS pending,
            CASE WHEN lm.role = 'license_admin' THEN (CASE WHEN t.account_owner_user_id = u.id THEN 'primary_license_admin' ELSE 'license_admin' END) ELSE pm.role END AS role,
            (lm.role = 'license_admin') AS is_license_level
     FROM users u
     LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = $1
     LEFT JOIN projects proj ON proj.id = $1
     LEFT JOIN license_members lm ON lm.user_id = u.id AND lm.tenant_license_id = proj.tenant_license_id
     LEFT JOIN tenants t ON t.id = proj.tenant_id
     LEFT JOIN (
       SELECT LOWER(attributed_email) AS email, MAX(created_at) AS latest_activity_at
       FROM audit_log WHERE attributed_email IS NOT NULL AND project_id = $1
       GROUP BY LOWER(attributed_email)
     ) la ON la.email = LOWER(u.email)
     WHERE pm.user_id IS NOT NULL OR lm.role = 'license_admin'`,
      [projectId]
    ),
    pool.query('SELECT * FROM projects WHERE id = $1', [projectId]),
  ]);
  // Their account name (asked for at sign-up); for accounts without one
  // yet, their Revizto license name; the page falls back to the email.
  const revizto = await syncService.licenseMemberNames(projectRows);
  const ownerId = projectRows[0]?.owner_user_id ?? null;
  const members = rows.map(({ account_name: accountName, ...m }) => ({
    ...m,
    name: accountName || revizto[m.email.toLowerCase()] || null,
    is_owner: m.id === ownerId, // background syncing runs on their connections
    roleLabel: access.ROLE_LABELS[m.role],
    // License admins are managed on License Administration, never here.
    canManage: !m.is_license_level && m.id !== req.session.userId && access.canManageMember(req.access, projectId, m.role),
  }));
  // License admins first, then by name (email when there's no name).
  const sortKey = (m) => (m.name || m.email).toLowerCase();
  members.sort((a, b) => b.is_license_level - a.is_license_level || sortKey(a).localeCompare(sortKey(b)));
  const assignableRoles = access.assignableProjectRoles(req.access, projectId);
  res.json({
    members,
    myRole: access.effectiveProjectRole(req.access, projectId),
    myRoleLabel: access.ROLE_LABELS[access.effectiveProjectRole(req.access, projectId)],
    assignableRoles: assignableRoles.map((r) => ({ value: r, label: access.ROLE_LABELS[r] })),
    canInvite: assignableRoles.length > 0,
    emailConfigured: emailService.isConfigured(),
  });
});

/** The role, or a 400/403 response already sent (returns null) if it's not one this person may give. */
function _checkAssignable(req, res, role) {
  if (!access.PROJECT_ROLES.includes(role)) {
    res.status(400).json({ error: 'Pick Project admin or Standard.' });
    return null;
  }
  if (!access.assignableProjectRoles(req.access, req.params.id).includes(role)) {
    res.status(403).json({ error: "You can't give someone a role above your own." });
    return null;
  }
  return role;
}

// Adds someone to the project with a role (creating their account if new —
// they create a password on first sign-in). Can't be used to change the
// role of someone at or above your own level, or of a license admin.
router.post('/api/projects/:id/team/invite', requireProjectRole('project_admin'), async (req, res) => {
  const projectId = Number(req.params.id);
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
  const role = _checkAssignable(req, res, req.body.role);
  if (!role) return;

  const { rows: existing } = await pool.query('SELECT id, role FROM users WHERE email = $1', [email]);
  const licenseId = await tenancy.licenseOfProject(projectId);
  if (existing[0]) {
    const { rows: adminHere } = await pool.query(
      "SELECT 1 FROM license_members WHERE tenant_license_id = $1 AND user_id = $2 AND role = 'license_admin'",
      [licenseId, existing[0].id]
    );
    if (adminHere.length) return res.status(400).json({ error: 'That person is a license admin — they already have access to every project.' });
  }
  if (existing[0]) {
    const { rows: current } = await pool.query('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, existing[0].id]);
    if (current[0] && !access.canManageMember(req.access, projectId, current[0].role)) {
      return res.status(403).json({ error: "They're already on this project with a role you can't change." });
    }
  }

  const { rows: userRows } = await pool.query(
    `INSERT INTO users (email, role) VALUES ($1, 'member')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [email]
  );
  const user = userRows[0];
  await tenancy.ensureMember(licenseId, user.id, req.session.userId); // an explicit invite brings them into this license
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [projectId, user.id, role, req.session.userId]
  );

  let emailSent = false;
  let emailError = null;
  if (req.body.sendEmail) {
    try {
      // Just a pointer to the app — on first sign-in (password left blank)
      // they're emailed a code to create their password.
      const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await emailService.sendInviteEmail({
        toEmail: email,
        invitedByEmail: req.session.userEmail,
        appUrl,
        role: access.ROLE_LABELS[role].toLowerCase(),
      });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
    }
  }
  await pool.query(
    'INSERT INTO invites (email, role, invited_by, email_sent, email_error, project_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [email, role, req.session.userId, emailSent, emailError, projectId]
  );
  res.json({ member: { id: user.id, email: user.email, role }, emailSent, emailError });
});

/** The target's current project role if this person may manage them, else sends an error and returns null. */
async function _manageableTarget(req, res) {
  const projectId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId)) {
    res.status(404).json({ error: "That person isn't on this project." });
    return null;
  }
  if (targetId === req.session.userId) {
    res.status(403).json({ error: "You can't change your own role." });
    return null;
  }
  const { rows } = await pool.query('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, targetId]);
  if (!rows[0]) {
    res.status(404).json({ error: "That person isn't on this project." });
    return null;
  }
  if (!access.canManageMember(req.access, projectId, rows[0].role)) {
    res.status(403).json({ error: "You can't change someone whose role is above your own." });
    return null;
  }
  return rows[0].role;
}

router.patch('/api/projects/:id/team/:userId', requireProjectRole('project_admin'), async (req, res) => {
  if ((await _manageableTarget(req, res)) === null) return;
  const role = _checkAssignable(req, res, req.body.role);
  if (!role) return;
  await pool.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [req.params.id, req.params.userId, role]);
  res.json({ ok: true, role });
});

// Removes them from this project only (their account and other projects stay).
// Never the project's owner — background syncing runs on their Revizto and
// ACC connections — until ownership is handed to someone else (below).
router.delete('/api/projects/:id/team/:userId', requireProjectRole('project_admin'), async (req, res) => {
  if ((await _manageableTarget(req, res)) === null) return;
  const { rows: ownerRows } = await pool.query(
    'SELECT u.name, u.email FROM projects p JOIN users u ON u.id = p.owner_user_id WHERE p.id = $1 AND p.owner_user_id = $2',
    [req.params.id, req.params.userId]
  );
  if (ownerRows[0]) {
    return res.status(409).json({
      error: `${ownerRows[0].name || ownerRows[0].email} owns this project — background syncing runs on their Revizto and ACC connections. Make someone else the owner first.`,
      code: 'is_owner',
    });
  }
  await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
  res.json({ ok: true });
});

/**
 * Hands the project to a new owner — whose Revizto and ACC connections
 * background syncing then runs on (webhook included). The new owner must
 * be a project admin or license admin of it, a real member of both the
 * Revizto and ACC projects, with both connections working. Any project
 * admin or above may do it (Team page → Project owner).
 */
router.post('/api/projects/:id/owner', requireProjectRole('project_admin'), async (req, res) => {
  const projectId = Number(req.params.id);
  const targetId = Number(req.body.userId);
  const { rows: projectRows } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = projectRows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.owner_user_id === targetId) return res.json({ ok: true, unchanged: true });
  const { rows: userRows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [targetId]);
  const target = userRows[0];
  if (!target) return res.status(404).json({ error: "That person isn't on this project." });
  const label = target.name || target.email;

  // A project admin or license admin of this project (for non-license
  // users, getAccess only keeps projects they really belong to in both).
  const targetAccess = await access.getAccess(targetId, project.tenant_license_id); // their access IN THIS project's license
  if (!access.hasProjectRole(targetAccess, projectId, 'project_admin')) {
    return res.status(400).json({ error: `${label} isn't a project admin of this project — make them one first.` });
  }
  if (membership.isPaired(project) && targetAccess.isLicenseAdmin) {
    const { memberIds } = await membership.checkProjects(target.email, [project]);
    if (!memberIds.has(projectId)) {
      return res.status(400).json({ error: `${label} isn't a member of both the Revizto and ACC project, so syncing couldn't run on their connections.` });
    }
  }
  const [accTokens, reviztoTokens] = await Promise.all([tokenStore.getAccTokens(targetId), tokenStore.getReviztoTokens(targetId)]);
  const live = (t) => !!t && new Date(t.refresh_expires_at) > new Date();
  if (!live(accTokens) || !live(reviztoTokens)) {
    return res.status(400).json({ error: `${label} needs both Revizto and ACC connected (My Connections) before they can own the project.` });
  }

  const previousOwnerId = project.owner_user_id;
  const { rows: updated } = await pool.query('UPDATE projects SET owner_user_id = $2 WHERE id = $1 RETURNING *', [projectId, targetId]);
  console.log(`[team] ${req.session.userEmail} made ${target.email} the owner of "${project.name}".`);

  // The ACC webhook belongs to whoever registered it — move it to the new
  // owner (the hourly check in webhookHealth would repair it otherwise).
  if (membership.isPaired(project)) {
    if (project.webhook_id && previousOwnerId) {
      await accService.deleteWebhook(previousOwnerId, project.webhook_id).catch((err) =>
        console.warn(`[team] Couldn't remove the previous owner's webhook for "${project.name}":`, err.response?.data || err.message)
      );
    }
    await webhookHealth.registerForProject(updated[0]).catch((err) =>
      console.warn(`[team] Couldn't register the new owner's webhook for "${project.name}" (the hourly check will retry):`, err.response?.data || err.message)
    );
  }
  res.json({ ok: true, owner: { id: target.id, name: target.name, email: target.email } });
});

// Emails them the invitation again (Team page → Edit users) — e.g. they
// never signed in, or lost the first email. Same email as the invite.
router.post('/api/projects/:id/team/:userId/resend-invite', requireProjectRole('project_admin'), async (req, res) => {
  const role = await _manageableTarget(req, res);
  if (role === null) return;
  if (!emailService.isConfigured()) {
    return res.status(400).json({ error: "Email isn't set up for this app, so invitations can't be sent — let them know to sign in." });
  }
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.params.userId]);
  const email = rows[0].email;
  let emailError = null;
  try {
    const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    await emailService.sendInviteEmail({ toEmail: email, invitedByEmail: req.session.userEmail, appUrl, role: access.ROLE_LABELS[role].toLowerCase() });
  } catch (err) {
    emailError = err.message;
  }
  await pool.query(
    'INSERT INTO invites (email, role, invited_by, email_sent, email_error, project_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [email, role, req.session.userId, !emailError, emailError, req.params.id]
  );
  if (emailError) return res.status(502).json({ error: `Couldn't send the email: ${emailError}` });
  res.json({ ok: true });
});

// ─── Invite links (per project, one per role) ─────────────────────────
// Shareable and reusable by design — meant to be pasted into an email/chat
// to a whole group at once. Redeeming one (routes/auth.js _applyInviteLink)
// adds the person to THIS project with the link's role, once they've proven
// the email is theirs. You can only make or revoke links for roles below yours.

router.get('/api/projects/:id/invite-links', requireProjectRole('project_admin'), async (req, res) => {
  const roles = access.assignableProjectRoles(req.access, req.params.id);
  const { rows } = await pool.query(
    `SELECT id, code, role, created_at FROM invite_links
     WHERE project_id = $1 AND revoked_at IS NULL AND role = ANY($2::text[]) ORDER BY created_at DESC`,
    [req.params.id, roles]
  );
  res.json({ links: rows.map((l) => ({ ...l, roleLabel: access.ROLE_LABELS[l.role] })) });
});

// Reuses the project's active link for that role if there is one, so
// "Copy invite link" is idempotent from the admin's point of view.
router.post('/api/projects/:id/invite-links', requireProjectRole('project_admin'), async (req, res) => {
  const role = _checkAssignable(req, res, req.body.role);
  if (!role) return;
  const { rows: existing } = await pool.query(
    `SELECT id, code, role, created_at FROM invite_links
     WHERE project_id = $1 AND role = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [req.params.id, role]
  );
  if (existing[0]) return res.json({ link: existing[0] });
  const code = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    'INSERT INTO invite_links (code, role, created_by, project_id) VALUES ($1, $2, $3, $4) RETURNING id, code, role, created_at',
    [code, role, req.session.userId, req.params.id]
  );
  res.json({ link: rows[0] });
});

router.post('/api/projects/:id/invite-links/:linkId/revoke', requireProjectRole('project_admin'), async (req, res) => {
  const roles = access.assignableProjectRoles(req.access, req.params.id);
  const { rows } = await pool.query(
    `UPDATE invite_links SET revoked_at = now()
     WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL AND role = ANY($3::text[]) RETURNING id`,
    [req.params.linkId, req.params.id, roles]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Invite link not found, already revoked, or not one you can revoke.' });
  res.json({ ok: true });
});

module.exports = router;
