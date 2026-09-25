/**
 * routes/auth.js
 *
 * Three separate auth concerns, don't confuse them:
 *   1. App identity — who is using THIS app: email + password sign-in
 *      (services/passwords.js), with emailed 6-digit codes to create or reset
 *      a password, and sessions that end 14 days after sign-in regardless of
 *      activity.
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
const passwords = require('../services/passwords');
const emailService = require('../services/emailService');

// Everyone signs in again at least this often, however active they are —
// so access decisions (removed from the team, password reset) can't be
// outlived by a long-running session. Matches the cookie's maxAge in
// server.js; this is the server-side enforcement of it.
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The signed-in user's row if this session is still valid, else null
 * (and the session is destroyed). Invalid when: no sign-in time recorded
 * (sessions from before password sign-in existed — everyone signs in with
 * a password once), older than SESSION_MAX_AGE_MS, started before the
 * user's last password change, or the user no longer exists.
 */
async function _sessionUser(req) {
  if (!req.session.userId) return null;
  const signedInAt = req.session.signedInAt || 0;
  const { rows } = await pool.query('SELECT id, email, role, password_changed_at FROM users WHERE id = $1', [req.session.userId]);
  const user = rows[0];
  const expired =
    !user ||
    Date.now() - signedInAt > SESSION_MAX_AGE_MS ||
    (user.password_changed_at && new Date(user.password_changed_at).getTime() > signedInAt);
  if (expired) {
    await new Promise((resolve) => req.session.destroy(resolve));
    return null;
  }
  req.session.role = user.role; // keep the session's cached role current
  return user;
}

async function requireLogin(req, res, next) {
  try {
    if (!(await _sessionUser(req))) return res.status(401).json({ error: 'Your session has ended — please sign in again.' });
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await _sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Your session has ended — please sign in again.' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch (err) {
    next(err);
  }
}

// ─── 1. App identity ────────────────────────────────────────────────

/**
 * Emails a fresh 6-digit code ('set' or 'reset'). Without SMTP (local
 * dev), or if sending fails, the code is written to the server log instead
 * so an admin with log access can still get someone in — then rethrows a
 * send failure so the caller can say so rather than claim an email went out.
 */
async function _emailPasswordCode(user, purpose) {
  const code = await passwords.createCode(user.id, purpose);
  const validMinutes = passwords.CODE_TTL_MS / 60000;
  if (!emailService.isConfigured()) {
    console.warn(`[auth] SMTP not configured — ${purpose}-password code for ${user.email}: ${code}`);
    return;
  }
  try {
    await emailService.sendPasswordCodeEmail({ toEmail: user.email, code, purpose, validMinutes });
  } catch (err) {
    console.error(`[auth] Couldn't email the ${purpose}-password code to ${user.email} (${err.message}). Code: ${code}`);
    throw err;
  }
}

/** Starts a fresh session for `user` (new session id — no session fixation). */
async function _startSession(req, user) {
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.role = user.role;
  req.session.signedInAt = Date.now();
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
}

// Brute-force brake: at most FAILED_LOGIN_LIMIT wrong passwords per
// email+IP per window. In memory (resets on restart) — enough to make
// online guessing impractical without a new dependency. (Wrong codes have
// their own, stricter per-code limit — see passwords.MAX_CODE_ATTEMPTS.)
const FAILED_LOGIN_LIMIT = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const _failedLogins = new Map();

function _recentFailures(key) {
  const recent = (_failedLogins.get(key) || []).filter((t) => Date.now() - t < FAILED_LOGIN_WINDOW_MS);
  _failedLogins.set(key, recent);
  return recent;
}

// At most one code email per address per minute, whichever way it's asked for.
const _lastCodeEmail = new Map();
function _codeRecentlySent(email) {
  if (Date.now() - (_lastCodeEmail.get(email) || 0) < 60 * 1000) return true;
  _lastCodeEmail.set(email, Date.now());
  return false;
}

const CODE_SENT = `We emailed you a 6-digit code. Enter it below with your new password — it expires in ${passwords.CODE_TTL_MS / 60000} minutes.`;
const SEND_FAILED = "We couldn't send your code email just now. Try again in a few minutes, or contact your administrator.";

// Sign-in. An account with no password yet (invited, or created before
// passwords existed) is emailed a code to create one instead — owning the
// email is proven by that code, so nobody can claim an account just by
// typing its address. New accounts still need a valid invite code, except
// the very first user ever (bootstrap admin).
router.post('/auth/login', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  const password = req.body.password || '';
  const inviteCode = req.body.invite?.trim() || null;
  if (!email) return res.status(400).json({ error: 'Enter your email.' });

  const failures = _recentFailures(`${req.ip}|${email}`);
  if (failures.length >= FAILED_LOGIN_LIMIT) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes, or reset your password.' });
  }

  const { rows: existingRows } = await pool.query('SELECT id, email, role, password_hash FROM users WHERE email = $1', [email]);
  let user = existingRows[0];

  if (!user) {
    const { rows: countRows } = await pool.query('SELECT count(*) FROM users');
    const isFirstEverUser = Number(countRows[0].count) === 0;
    // Bootstrap: the very first user ever created becomes admin
    // immediately, no invite needed — otherwise nobody could ever create
    // the first invite link in the first place.
    let role = 'admin';
    if (!isFirstEverUser) {
      if (!inviteCode) {
        return res.status(403).json({ error: 'No account for this email. Ask a team admin for an invite link.' });
      }
      const { rows: linkRows } = await pool.query('SELECT role FROM invite_links WHERE code = $1 AND revoked_at IS NULL', [inviteCode]);
      if (!linkRows[0]) {
        return res.status(403).json({ error: 'This invite link is invalid or has been revoked. Ask a team admin for a new one.' });
      }
      role = linkRows[0].role;
    }
    const { rows: createdRows } = await pool.query(
      'INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id, email, role, password_hash',
      [email, role]
    );
    user = createdRows[0];
  }

  if (!user.password_hash) {
    if (!_codeRecentlySent(email)) {
      try {
        await _emailPasswordCode(user, 'set');
      } catch {
        return res.status(502).json({ error: SEND_FAILED });
      }
    }
    return res.json({ status: 'code_sent', purpose: 'set', message: CODE_SENT });
  }

  if (!(await passwords.verifyPassword(password, user.password_hash))) {
    failures.push(Date.now());
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  _failedLogins.delete(`${req.ip}|${email}`);
  await _startSession(req, user);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// "Forgot password": always the same answer whether or not the email has
// an account, so this can't be used to discover who's on the team.
router.post('/auth/forgot-password', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Enter your email.' });
  const reply = { status: 'code_sent', purpose: 'reset', message: `If that email has an account, we emailed it a 6-digit code. Enter it below with your new password — it expires in ${passwords.CODE_TTL_MS / 60000} minutes.` };
  if (_codeRecentlySent(email)) return res.json(reply);
  const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
  if (rows[0]) {
    try {
      await _emailPasswordCode(rows[0], 'reset');
    } catch {
      // Already logged with the code; same reply either way (see above).
    }
  }
  res.json(reply);
});

// Code + new password → password set, and signed in. Covers both the
// first-time 'set' flow and 'reset'.
router.post('/auth/verify-code', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  const { code, password } = req.body;
  const problem = passwords.validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });
  const { rows } = await pool.query('SELECT id, email, role FROM users WHERE email = $1', [email || '']);
  const user = rows[0];
  const result = user ? await passwords.setPasswordWithCode(user.id, code, password) : { ok: false, reason: 'invalid' };
  if (!result.ok) {
    return res.status(result.reason === 'locked' ? 429 : 400).json({
      error: result.reason === 'locked'
        ? 'Too many wrong codes. Request a new code and try again.'
        : "That code is incorrect or has expired. Check the latest email, or request a new code.",
    });
  }
  await _startSession(req, user);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/auth/me', async (req, res) => {
  const sessionUser = await _sessionUser(req);
  if (!sessionUser) return res.json({ user: null });
  const role = sessionUser.role;
  const accTokens = await tokenStore.getAccTokens(req.session.userId);
  const reviztoTokens = await tokenStore.getReviztoTokens(req.session.userId);

  // "Connected" means the refresh token is actually still usable, not
  // just "a row exists in the DB" — a row can outlive its own refresh
  // token going genuinely dead (idle past its window, or revoked
  // server-side), and until this fix this page kept showing "Connected"
  // for those regardless. Confirmed by real testing: Setup page's own
  // hub-name lookup correctly detected a dead ACC connection (a live
  // 409 "refresh token is invalid or expired" from Autodesk) while this
  // route still reported connected: true for the same account — two
  // pages disagreeing about the same account's real state. Both keepalive
  // crons (pollService.keepAccConnectionsAlive/
  // keepReviztoConnectionsAlive) keep refresh_expires_at rolling forward
  // for a healthy connection, so this only flips to false once a
  // connection has genuinely gone dead, not from routine idle time.
  const accStillValid = !!accTokens && new Date(accTokens.refresh_expires_at) > new Date();
  const reviztoStillValid = !!reviztoTokens && new Date(reviztoTokens.refresh_expires_at) > new Date();

  res.json({
    user: { id: req.session.userId, email: req.session.userEmail, role },
    acc: accStillValid
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
    revizto: reviztoStillValid
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
router.post('/auth/revizto/license', requireAdmin, async (req, res) => {
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
router.post('/auth/acc/hub', requireAdmin, async (req, res) => {
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
