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

router.post('/auth/identify', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const { rows } = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, role`,
    [email.toLowerCase().trim()]
  );
  let user = rows[0];

  // Bootstrap: if this is the very first user ever created, auto-promote
  // to admin so someone can actually access project setup and the team
  // page. Everyone after that is 'standard' unless invited as admin or
  // promoted later.
  if (user.role !== 'admin') {
    const { rows: countRows } = await pool.query('SELECT count(*) FROM users');
    if (Number(countRows[0].count) === 1) {
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
      user = { ...user, role: 'admin' };
    }
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
    acc: accTokens ? { connected: true, expiresAt: accTokens.expires_at, hubId: accTokens.default_hub_id } : { connected: false },
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
