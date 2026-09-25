const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAdmin, requireLogin } = require('./auth');
const emailService = require('../services/emailService');

const VALID_ROLES = ['admin', 'standard'];

// last_login_at is its own column (set on every sign-in, /auth/login); latest
// sync activity isn't stored separately — it's read live from audit_log,
// which already records every real action (field change/comment/
// attachment/link/unlink) traced back to a specific person. Case-
// insensitive join since email casing isn't guaranteed identical between
// what's typed at sign-in and what's resolved from Revizto/ACC member data.
//
// requireLogin (not requireAdmin) — read access to the roster/activity is
// open to any signed-in user; every route below that actually CHANGES
// something (inviting, generating/revoking a link, changing a role)
// stays requireAdmin. The Team page's own JS renders a read-only view
// (no editable role dropdown, no invite controls) for non-admins.
router.get('/api/team', requireLogin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.role, u.created_at, u.last_login_at, la.latest_activity_at
    FROM users u
    LEFT JOIN (
      SELECT LOWER(attributed_email) AS email, MAX(created_at) AS latest_activity_at
      FROM audit_log
      WHERE attributed_email IS NOT NULL
      GROUP BY LOWER(attributed_email)
    ) la ON la.email = LOWER(u.email)
    ORDER BY u.created_at ASC
  `);
  res.json({ members: rows, emailConfigured: emailService.isConfigured() });
});

router.post('/api/team/invite', requireAdmin, async (req, res) => {
  const { email, role, sendEmail } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const finalRole = VALID_ROLES.includes(role) ? role : 'standard';
  const normalizedEmail = email.toLowerCase().trim();

  // Adds (or updates the role of) the user immediately — this IS the
  // access grant. Email, if requested, is just a notification on top.
  const { rows } = await pool.query(
    `INSERT INTO users (email, role) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
     RETURNING id, email, role`,
    [normalizedEmail, finalRole]
  );
  const member = rows[0];

  let emailSent = false;
  let emailError = null;
  if (sendEmail) {
    try {
      // Just a pointer to the app — on first sign-in (password left blank)
      // they're emailed a code to create their password.
      const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await emailService.sendInviteEmail({
        toEmail: normalizedEmail,
        invitedByEmail: req.session.userEmail,
        appUrl,
        role: finalRole,
      });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
    }
  }

  await pool.query(
    'INSERT INTO invites (email, role, invited_by, email_sent, email_error) VALUES ($1, $2, $3, $4, $5)',
    [normalizedEmail, finalRole, req.session.userId, emailSent, emailError]
  );

  res.json({ member, emailSent, emailError });
});

router.patch('/api/team/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  if (Number(req.params.id) === req.session.userId && role !== 'admin') {
    return res.status(400).json({ error: "You can't demote yourself — have another admin do it." });
  }
  const { rows } = await pool.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, email, role', [req.params.id, role]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ member: rows[0] });
});

// ─── Invite links ("Copy invite link", one per role) ──────────────────
// Shareable and reusable by design — meant to be pasted into an email/
// Slack message to a whole group at once, not a single-use, single-
// recipient token. See invite_links in schema.sql and /auth/login for
// how a code is actually redeemed on signup.

router.get('/api/team/invite-links', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, code, role, created_at FROM invite_links WHERE revoked_at IS NULL ORDER BY created_at DESC'
  );
  res.json({ links: rows });
});

// Reuses an existing active link for that role if one already exists,
// rather than piling up a new one every time this is clicked — "Copy
// invite link" is meant to be idempotent from the admin's perspective.
router.post('/api/team/invite-links', requireAdmin, async (req, res) => {
  const finalRole = VALID_ROLES.includes(req.body.role) ? req.body.role : 'standard';
  const { rows: existing } = await pool.query(
    'SELECT id, code, role, created_at FROM invite_links WHERE role = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [finalRole]
  );
  if (existing[0]) return res.json({ link: existing[0] });

  const code = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    'INSERT INTO invite_links (code, role, created_by) VALUES ($1, $2, $3) RETURNING id, code, role, created_at',
    [code, finalRole, req.session.userId]
  );
  res.json({ link: rows[0] });
});

// Invalidates a link (e.g. shared with the wrong group) without deleting
// its row — a fresh "Copy invite link" click for that role generates a
// brand new code afterward, since the revoked one no longer counts as
// "existing" above.
router.post('/api/team/invite-links/:id/revoke', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE invite_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Invite link not found or already revoked' });
  res.json({ ok: true });
});

module.exports = router;
