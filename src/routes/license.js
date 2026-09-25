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

router.get('/license', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/license.html'));
});

router.get('/api/license/admins', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, role, last_login_at FROM users
     WHERE role IN ('primary_license_admin', 'license_admin')
     ORDER BY (role = 'primary_license_admin') DESC, email ASC`
  );
  res.json({
    // Any license admin can remove another license admin — never the
    // primary license admin, and never themselves.
    admins: rows.map((a) => ({
      ...a,
      roleLabel: access.ROLE_LABELS[a.role],
      canRemove: a.role === 'license_admin' && a.id !== req.access.userId,
    })),
    canManage: true, // every license admin can add license admins
    emailConfigured: emailService.isConfigured(),
  });
});

// Makes someone a license admin (creating their account if new — they
// create a password on first sign-in). Their project rows stay but no
// longer matter: a license admin sees every project.
router.post('/api/license/admins', requireLicenseAdmin, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
  const { rows: existing } = await pool.query('SELECT id, role FROM users WHERE email = $1', [email]);
  if (existing[0]?.role === 'primary_license_admin') return res.status(400).json({ error: "That's the primary license admin." });
  const { rows } = await pool.query(
    `INSERT INTO users (email, role) VALUES ($1, 'license_admin')
     ON CONFLICT (email) DO UPDATE SET role = 'license_admin'
     RETURNING id, email, role`,
    [email]
  );
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
  const { rows } = await pool.query(
    "UPDATE users SET role = 'member' WHERE id = $1 AND role = 'license_admin' RETURNING id",
    [req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: "That person isn't a license admin (the primary license admin can't be removed)." });
  console.log(`[license] ${req.session.userEmail} removed license admin #${req.params.userId}.`);
  res.json({ ok: true });
});

// Every project under the license, with what License Administration shows:
// paired or not, the owner whose connections background sync uses, and
// how many people have been invited to it.
router.get('/api/license/projects', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at, p.acc_project_name, p.archived_at,
            (p.revizto_project_uuid IS NOT NULL AND p.acc_project_id IS NOT NULL) AS paired,
            owner.email AS owner_email,
            (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
            (SELECT count(*)::int FROM sync_map sm WHERE sm.project_id = p.id) AS synced_count
     FROM projects p LEFT JOIN users owner ON owner.id = p.owner_user_id
     ORDER BY (p.archived_at IS NOT NULL), p.created_at DESC`
  );
  // The metric boxes at the top of License Administration. A project uses
  // a slot from the moment it's created (paired or not) until it's
  // archived or deleted (services/licenseTerms.js — placeholder terms for
  // now). Synced issues = currently linked issue pairs, the same count as
  // the Dashboards page's "Linked issues".
  res.json({
    projects: rows,
    summary: {
      projectSlotCapacity: licenseTerms.PROJECT_SLOT_CAPACITY,
      projectSlotsUsed: rows.filter((p) => !p.archived_at).length,
      licenseExpiresOn: licenseTerms.LICENSE_EXPIRES_ON,
      syncedIssues: rows.reduce((sum, p) => sum + p.synced_count, 0),
    },
  });
});

// ─── Archive / unarchive / delete (the ⋯ menu on each project row) ────

// Archive: kept as is, but not synced (poll and webhook skip it) and
// hidden from everyone but license admins. Unarchive puts it back.
router.post('/api/license/projects/:id/archive', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query('UPDATE projects SET archived_at = COALESCE(archived_at, now()) WHERE id = $1 RETURNING id, name', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  console.log(`[license] ${req.session.userEmail} archived project "${rows[0].name}".`);
  res.json({ ok: true });
});

router.post('/api/license/projects/:id/unarchive', requireLicenseAdmin, async (req, res) => {
  const { rows: existing } = await pool.query('SELECT archived_at FROM projects WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Project not found' });
  if (!existing[0].archived_at) return res.json({ ok: true }); // already active — no slot to take
  // Unarchiving takes a project slot back — refused when none are left.
  let rows;
  try {
    ({ rows } = await licenseTerms.withProjectSlot((db) =>
      db.query('UPDATE projects SET archived_at = NULL WHERE id = $1 RETURNING id, name', [req.params.id])
    ));
  } catch (err) {
    if (err instanceof licenseTerms.NoProjectSlotsError) return res.status(409).json({ error: err.message, code: err.code });
    throw err;
  }
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  console.log(`[license] ${req.session.userEmail} unarchived project "${rows[0].name}".`);
  res.json({ ok: true });
});

// Delete: removes the project from this app — its issue links, mappings,
// members and invite links go with it (ON DELETE CASCADE); Activity Log
// rows stay, without the project. Issues in Revizto and ACC are never
// touched. Its ACC webhook is unregistered first (best effort).
router.delete('/api/license/projects/:id', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, webhook_id, owner_user_id FROM projects WHERE id = $1', [req.params.id]);
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
  console.log(`[license] ${req.session.userEmail} deleted project "${project.name}".`);
  res.json({ ok: true });
});

module.exports = router;
