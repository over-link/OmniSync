/**
 * routes/license.js
 * License Administration: who the license admins are (any license admin
 * can add or remove the others — not the primary, and not themselves), and
 * every project under the license —
 * where a license admin creates a new one (POST /api/projects, then it's
 * paired on Project Setup).
 */
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../db/pool');
const { requireLicenseAdmin } = require('./auth');
const emailService = require('../services/emailService');
const access = require('../services/access');
const accService = require('../services/accService');
const membership = require('../services/membership');
const licenseTerms = require('../services/licenseTerms');
const syncService = require('../services/syncService');
const tenancy = require('../services/tenancy');
const pairingGuard = require('../services/pairingGuard');

router.get('/license', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/license.html'));
});

/**
 * { [email]: name } from the Revizto licenses this app's projects are on
 * (syncService.licenseMemberNames — cached a few minutes) — the fallback
 * for accounts without a name of their own (users.name, asked at
 * sign-up). With neither, the page shows their email.
 */
async function _peopleNames(licenseId) {
  const { rows: projects } = await pool.query('SELECT * FROM projects WHERE owner_user_id IS NOT NULL AND tenant_license_id = $1', [licenseId]);
  return syncService.licenseMemberNames(projects);
}

router.get('/api/license/admins', requireLicenseAdmin, async (req, res) => {
  // The license admins OF THIS LICENSE (the open one) — never another license's.
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name AS account_name,
            CASE WHEN t.account_owner_user_id = u.id THEN 'primary_license_admin' ELSE 'license_admin' END AS role,
            u.last_login_at,
            (t.account_owner_user_id IS DISTINCT FROM u.id AND u.license_role_verified_at IS NULL) AS pending,
            (t.account_owner_user_id IS DISTINCT FROM u.id AND u.license_role_verified_at IS NULL AND u.license_role_denied_at IS NOT NULL) AS role_denied
     FROM license_members m
     JOIN users u ON u.id = m.user_id
     JOIN tenant_licenses l ON l.id = m.tenant_license_id
     JOIN tenants t ON t.id = l.tenant_id
     WHERE m.tenant_license_id = $1 AND m.role = 'license_admin'
     ORDER BY (t.account_owner_user_id = u.id) DESC, u.email ASC`,
    [req.access.licenseId]
  );
  const names = await _peopleNames(req.access.licenseId);
  res.json({
    // Any license admin can remove another license admin — never the
    // primary license admin, and never themselves.
    admins: rows.map(({ account_name: accountName, ...a }) => ({
      ...a,
      // Shown instead of the email: their account name, else their Revizto name.
      name: accountName || names[a.email.toLowerCase()] || null,
      roleLabel: access.ROLE_LABELS[a.role],
      canRemove: a.role === 'license_admin' && a.id !== req.access.userId,
    })),
    canManage: true, // every license admin can add license admins
    emailConfigured: emailService.isConfigured(),
  });
});

// Makes someone a license admin (creating their account if new — they
// create a password on first sign-in). No check here: they show as pending
// until they've signed in and connected Revizto, when the app confirms a
// License administrator (or above) license role (routes/auth.js _verifyLicenseRole).
// Their project rows stay but no longer matter: a license admin sees every
// project.
router.post('/api/license/admins', requireLicenseAdmin, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
  // accounts are global (one email, many licenses): looked up / created on the unrestricted pool — db/pool.js
  const { rows: existing } = await pool.admin.query('SELECT id, role FROM users WHERE email = $1', [email]);
  if (existing[0]) {
    const { rows: owner } = await pool.query('SELECT 1 FROM tenants WHERE id = $1 AND account_owner_user_id = $2', [req.access.tenantId, existing[0].id]);
    if (owner.length || existing[0].role === 'primary_license_admin') return res.status(400).json({ error: "That's the primary license admin." });
  }
  const { rows } = await pool.admin.query(
    `INSERT INTO users (email, role) VALUES ($1, 'license_admin')
     ON CONFLICT (email) DO UPDATE SET role = 'license_admin',
       license_role_verified_at = CASE WHEN users.role = 'license_admin' THEN users.license_role_verified_at END,
       license_role_denied_at = CASE WHEN users.role = 'license_admin' THEN users.license_role_denied_at END
     RETURNING id, email, role`,
    [email]
  );
  // The membership in THIS license (users.role above is the older, global copy
  // kept in step until it's retired).
  await tenancy.setLicenseAdmin(req.access.licenseId, rows[0].id, req.session.userId);
  let emailSent = false;
  let emailError = null;
  if (req.body.sendEmail) {
    try {
      const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await emailService.sendInviteEmail({ toEmail: email, invitedByEmail: req.session.userEmail, appUrl, role: 'license admin' });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
    }
  }
  await pool.query(
    'INSERT INTO invites (email, role, invited_by, email_sent, email_error) VALUES ($1, $2, $3, $4, $5)',
    [email, 'license_admin', req.session.userId, emailSent, emailError]
  );
  res.json({ admin: rows[0], emailSent, emailError });
});

// Takes away license admin — they keep their account and any project roles
// they'd been given, but lose access to projects they weren't invited to.
router.delete('/api/license/admins/:userId', requireLicenseAdmin, async (req, res) => {
  if (Number(req.params.userId) === Number(req.access.userId)) {
    return res.status(400).json({ error: "You can't remove yourself as a license admin — ask another license admin." });
  }
  // Back to a plain member of THIS license (never the company's account owner).
  const { rows } = await pool.query(
    `UPDATE license_members m SET role = 'member'
     FROM tenant_licenses l JOIN tenants t ON t.id = l.tenant_id
     WHERE l.id = m.tenant_license_id AND m.tenant_license_id = $2 AND m.user_id = $1 AND m.role = 'license_admin'
       AND t.account_owner_user_id IS DISTINCT FROM m.user_id
     RETURNING m.user_id`,
    [req.params.userId, req.access.licenseId]
  );
  if (!rows[0]) return res.status(404).json({ error: "That person isn't a license admin (the primary license admin can't be removed)." });
  // The older global copy: lowered only if they're no longer a license admin anywhere.
  // (looks across ALL licenses, so it runs on the unrestricted pool — a restricted one would only see this license's memberships)
  await pool.admin.query(
    `UPDATE users SET role = 'member' WHERE id = $1 AND role = 'license_admin'
       AND NOT EXISTS (SELECT 1 FROM license_members WHERE user_id = $1 AND role = 'license_admin')`,
    [req.params.userId]
  );
  console.log(`[license] ${req.session.userEmail} removed license admin #${req.params.userId}.`);
  res.json({ ok: true });
});

// Every project under the license, with what License Administration shows:
// paired or not, the owner whose connections background sync uses, and
// how many people have been invited to it.
router.get('/api/license/projects', requireLicenseAdmin, async (req, res) => {
  const [{ rows }, names] = await Promise.all([
    pool.query(
      `SELECT p.id, p.name, p.created_at, p.acc_project_name, p.archived_at,
            (p.revizto_project_uuid IS NOT NULL AND p.acc_project_id IS NOT NULL) AS paired,
            (p.revizto_project_uuid IS NOT NULL AND p.acc_project_id IS NOT NULL AND p.archived_at IS NULL AND NOT p.sync_active) AS pairing_paused,
            owner.email AS owner_email, owner.name AS owner_account_name,
            (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
            (SELECT count(*)::int FROM sync_map sm WHERE sm.project_id = p.id) AS synced_count
     FROM projects p LEFT JOIN users owner ON owner.id = p.owner_user_id
     WHERE p.tenant_license_id = $1
     ORDER BY (p.archived_at IS NOT NULL), p.created_at DESC`,
      [req.access.licenseId]
    ),
    _peopleNames(req.access.licenseId),
  ]);
  for (const p of rows) {
    p.owner_name = p.owner_account_name || (p.owner_email ? names[p.owner_email.toLowerCase()] || null : null);
    delete p.owner_account_name;
  }
  // The metric boxes at the top of License Administration. A project uses
  // a slot from the moment it's created (paired or not) until it's
  // archived or deleted (services/licenseTerms.js — placeholder terms for
  // now). Synced issues = currently linked issue pairs, the same count as
  // the Dashboards page's "Linked issues".
  const terms = await licenseTerms.summary(req.access.licenseId);
  res.json({
    projects: rows,
    summary: {
      projectSlotCapacity: terms.projectSlotCapacity,
      projectSlotsUsed: terms.projectSlotsUsed,
      licenseExpiresOn: terms.licenseExpiresOn,
      syncedIssues: rows.reduce((sum, p) => sum + p.synced_count, 0),
      ...(terms.license.usable ? {} : { license: terms.license }),
    },
  });
});

// ─── Archive / unarchive / delete (the ⋯ menu on each project row) ────

// Archive: kept as is, but not synced (poll and webhook skip it) and
// hidden from everyone but license admins. Unarchive puts it back.
router.post('/api/license/projects/:id/archive', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query('UPDATE projects SET archived_at = COALESCE(archived_at, now()) WHERE id = $1 AND tenant_license_id = $2 RETURNING id, name', [req.params.id, req.access.licenseId]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  await pairingGuard.refresh(); // frees its ACC project for another pairing
  console.log(`[license] ${req.session.userEmail} archived project "${rows[0].name}".`);
  res.json({ ok: true });
});

router.post('/api/license/projects/:id/unarchive', requireLicenseAdmin, async (req, res) => {
  const { rows: existing } = await pool.query('SELECT archived_at FROM projects WHERE id = $1 AND tenant_license_id = $2', [req.params.id, req.access.licenseId]);
  if (!existing[0]) return res.status(404).json({ error: 'Project not found' });
  if (!existing[0].archived_at) return res.json({ ok: true }); // already active — no slot to take
  // Unarchiving takes a project slot back — refused when none are left.
  let rows;
  try {
    ({ rows } = await licenseTerms.withProjectSlot(req.access.licenseId, (db) =>
      db.query('UPDATE projects SET archived_at = NULL WHERE id = $1 RETURNING id, name', [req.params.id])
    ));
  } catch (err) {
    if (err instanceof licenseTerms.NoProjectSlotsError || err instanceof licenseTerms.LicenseNotActiveError) return res.status(409).json({ error: err.message, code: err.code });
    throw err;
  }
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  await pairingGuard.refresh(); // back in service — unless another project now holds its ACC project (then it stays paused, with a notice)
  console.log(`[license] ${req.session.userEmail} unarchived project "${rows[0].name}".`);
  res.json({ ok: true });
});

// Delete: removes the project from this app — its issue links, mappings,
// members and invite links go with it (ON DELETE CASCADE); Activity Log
// rows stay, without the project. Issues in Revizto and ACC are never
// touched. Its ACC webhook is unregistered first (best effort).
router.delete('/api/license/projects/:id', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, webhook_id, owner_user_id FROM projects WHERE id = $1 AND tenant_license_id = $2', [req.params.id, req.access.licenseId]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.webhook_id) {
    try {
      await accService.deleteWebhook(project.owner_user_id || req.session.userId, project.webhook_id);
    } catch (err) {
      console.warn(`[license] Couldn't unregister the ACC webhook of "${project.name}" (deleting anyway):`, err.response?.data || err.message);
    }
  }
  await pool.query('DELETE FROM projects WHERE id = $1', [project.id]);
  membership.forget(project.id);
  await pairingGuard.refresh();
  console.log(`[license] ${req.session.userEmail} deleted project "${project.name}".`);
  res.json({ ok: true });
});

module.exports = router;
