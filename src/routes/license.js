/**
 * routes/license.js
 * License Administration: who the license admins are (only the primary
 * license admin can change that), and every project under the license —
 * where a license admin creates a new one (POST /api/projects, then it's
 * paired on Project Setup).
 */
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../db/pool');
const { requireLicenseAdmin, requirePrimaryAdmin } = require('./auth');
const emailService = require('../services/emailService');
const access = require('../services/access');

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
    admins: rows.map((a) => ({ ...a, roleLabel: access.ROLE_LABELS[a.role], canRemove: req.access.isPrimary && a.role === 'license_admin' })),
    canManage: req.access.isPrimary,
    emailConfigured: emailService.isConfigured(),
  });
});

// Makes someone a license admin (creating their account if new — they
// create a password on first sign-in). Their project rows stay but no
// longer matter: a license admin sees every project.
router.post('/api/license/admins', requirePrimaryAdmin, async (req, res) => {
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
router.delete('/api/license/admins/:userId', requirePrimaryAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE users SET role = 'member' WHERE id = $1 AND role = 'license_admin' RETURNING id",
    [req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: "That person isn't a license admin (the primary license admin can't be removed)." });
  res.json({ ok: true });
});

// Every project under the license, with what License Administration shows:
// paired or not, the owner whose connections background sync uses, and
// how many people have been invited to it.
router.get('/api/license/projects', requireLicenseAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at, p.acc_project_name,
            (p.revizto_project_uuid IS NOT NULL AND p.acc_project_id IS NOT NULL) AS paired,
            owner.email AS owner_email,
            (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS member_count
     FROM projects p LEFT JOIN users owner ON owner.id = p.owner_user_id
     ORDER BY p.created_at DESC`
  );
  res.json({ projects: rows });
});

module.exports = router;
