/**
 * routes/auth.js
 *
 * Three separate auth concerns, don't confuse them:
 *   1. App identity — who is using THIS app. Prototype-level: just an
 *      email, no password. Replace with real auth (e.g. Clerk/Auth0)
 *      before onboarding real customers — this is intentionally minimal.
 *   2. ACC connection — per-user 3-legged Autodesk OAuth (redirect flow).
 *   3. Revizto connection — per-user access-code paste flow (no redirect
 *      support on Revizto's side, per their docs).
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const accAuth = require('../services/accAuth');
const reviztoAuth = require('../services/reviztoAuth');
const tokenStore = require('../services/tokenStore');

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
  if (rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.session.role = 'admin'; // keep session cache in sync
  next();
}

// ─── 1. App identity ────────────────────────────────────────────────

// Signing back in (email already has a users row) never needs an invite
// code — this only gates brand-new account creation. Two exemptions from
// needing a code at all: the very first user ever (bootstrap admin, same
// as before) and, obviously, anyone already in `users`. Everyone else
// creating a NEW account needs a valid, non-revoked code from
// invite_links (see "Copy invite link" on the Team page) — closes what
// was previously open self-signup for anyone who found the URL.
router.post('/auth/identify', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  const inviteCode = req.body.invite?.trim() || null;
  if (!email) return res.status(400).json({ error: 'email required' });

  const { rows: existingRows } = await pool.query('SELECT id, email, role FROM users WHERE email = $1', [email]);
  let user = existingRows[0];

  if (user) {
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  } else {
    const { rows: countRows } = await pool.query('SELECT count(*) FROM users');
    const isFirstEverUser = Number(countRows[0].count) === 0;

    // Bootstrap: the very first user ever created becomes admin
    // immediately, no invite needed — otherwise nobody could ever create
    // the first invite link in the first place.
    let role = 'admin';
    if (!isFirstEverUser) {
      if (!inviteCode) {
        return res.status(403).json({ error: 'An invite link is required to sign up. Ask a team admin for one.' });
      }
      const { rows: linkRows } = await pool.query(
        'SELECT role FROM invite_links WHERE code = $1 AND revoked_at IS NULL',
        [inviteCode]
      );
      if (!linkRows[0]) {
        return res.status(403).json({ error: 'This invite link is invalid or has been revoked. Ask a team admin for a new one.' });
      }
      role = linkRows[0].role;
    }

    const { rows: createdRows } = await pool.query(
      'INSERT INTO users (email, role, last_login_at) VALUES ($1, $2, now()) RETURNING id, email, role',
      [email, role]
    );
    user = createdRows[0];
  }

  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.role = user.role;
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
  const role = userRows[0]?.role || 'standard';
  req.session.role = role;
  const accTokens = await tokenStore.getAccTokens(req.session.userId);
  const reviztoTokens = await tokenStore.getReviztoTokens(req.session.userId);
  res.json({
    user: { id: req.session.userId, email: req.session.userEmail, role },
    acc: accTokens
      ? {
          connected: true,
          // expiresAt is the short-lived ACCESS token's own ~60-min
          // expiry — kept for anything that still reads it, but
          // refreshExpiresAt (the REFRESH token's real ~15-day window,
          // matching Revizto's own refreshExpiresAt) is what the UI
          // should actually show; expiresAt alone made a perfectly
          // healthy connection look like it was expiring any minute.
          expiresAt: accTokens.expires_at,
          refreshExpiresAt: accTokens.refresh_expires_at,
          hubId: accTokens.default_hub_id,
        }
      : { connected: false },
    revizto: reviztoTokens
      ? {
          connected: true,
          refreshExpiresAt: reviztoTokens.refresh_expires_at,
          region: reviztoTokens.region,
          licenseId: reviztoTokens.license_id,
        }
      : { connected: false },
  });
});

// License ID is needed to browse "my Revizto projects" (GET /project/list)
// but not to connect — kept as a separate step so connecting stays simple.
router.post('/auth/revizto/license', requireLogin, async (req, res) => {
  const { licenseId, licenseRegion } = req.body;
  if (!licenseId) return res.status(400).json({ error: 'licenseId required' });
  const tokens = await tokenStore.getReviztoTokens(req.session.userId);
  if (!tokens) return res.status(400).json({ error: 'Connect Revizto first' });
  await tokenStore.saveReviztoLicenseId(req.session.userId, licenseId.trim(), licenseRegion);
  res.json({ ok: true });
});

// ─── 2. ACC OAuth (redirect flow) ───────────────────────────────────

// Mirrors /auth/revizto/license — the ACC hub is the equivalent "current
// context" selection that scopes the ACC project dropdown, the same way
// license scopes the Revizto project dropdown.
router.post('/auth/acc/hub', requireLogin, async (req, res) => {
  const { hubId } = req.body;
  if (!hubId) return res.status(400).json({ error: 'hubId required' });
  const tokens = await tokenStore.getAccTokens(req.session.userId);
  if (!tokens) return res.status(400).json({ error: 'Connect ACC first' });
  await tokenStore.saveAccHubId(req.session.userId, hubId.trim());
  res.json({ ok: true });
});

router.get('/auth/acc', requireLogin, (req, res) => {
  res.redirect(accAuth.getAuthUrl(String(req.session.userId)));
});

router.get('/auth/acc/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`ACC auth error: ${error}`);

  const userId = Number(state) || req.session.userId;
  if (!userId) return res.status(400).send('No user context for this callback — please log in and try again.');

  try {
    const tokens = await accAuth.exchangeCode(code);
    let profile = {};
    try {
      profile = await accAuth.getCurrentUser(tokens.access_token);
    } catch {
      // Profile lookup is best-effort — don't fail the whole connect over it.
    }
    await tokenStore.saveAccTokens(userId, {
      ...tokens,
      autodesk_user_id: profile.sub || null,
      autodesk_email: profile.email || null,
    });
    res.redirect('/?acc_connected=1');
  } catch (err) {
    console.error('[auth] ACC exchange failed:', err.response?.data || err.message);
    res.status(500).send('Failed to connect ACC. Check server logs.');
  }
});

// ─── 3. Revizto (paste access-code flow) ────────────────────────────

router.post('/auth/revizto/exchange', requireLogin, async (req, res) => {
  const { accessCode, region } = req.body;
  if (!accessCode) return res.status(400).json({ error: 'accessCode required' });

  try {
    const resolvedRegion = region || 'virginia';
    const tokens = await reviztoAuth.exchangeAccessCode(accessCode, resolvedRegion);
    await tokenStore.saveReviztoTokens(req.session.userId, { ...tokens, region: resolvedRegion });
    res.json({ ok: true, refreshExpiresAt: tokens.refresh_expires_at });
  } catch (err) {
    console.error('[auth] Revizto exchange failed:', err.response?.data || err.message);
    res.status(400).json({
      error: 'Could not exchange access code. It may have expired (15 min limit) — get a fresh one and try again.',
    });
  }
});

module.exports = { router, requireLogin, requireAdmin };
