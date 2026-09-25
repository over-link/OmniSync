/**
 * services/passwords.js
 * Password hashing, and the emailed 6-digit codes that prove someone owns
 * an email before they can set a password on it — first-time "create
 * your password" (invited, or an account from before passwords existed)
 * and "forgot password" both use the same code flow, entirely on the
 * sign-in page.
 *
 * Hashing uses Node's built-in scrypt (a memory-hard KDF) with a random
 * per-password salt — no native dependency to build on Render. Stored as
 * "scrypt$N$r$p$salt$hash" so the cost parameters can be raised later
 * without breaking existing hashes.
 *
 * Codes: 6 random digits, emailed; only an HMAC of the code is stored.
 * Short-lived (CODE_TTL_MS), single-use, locked after MAX_CODE_ATTEMPTS
 * wrong guesses (so 6 digits can't be brute-forced in the window), and a
 * newly issued code voids that user's earlier ones.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const pool = require('../db/pool');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };

const MIN_LENGTH = 10;
const MAX_LENGTH = 200;

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

/** Returns an error message if the password isn't acceptable, else null. */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  if (password.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

// Keyed with the session secret, so a leaked table alone can't be used to
// work backwards from the stored value to the code.
function _codeHash(userId, code) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-secret').update(`${userId}:${code}`).digest('hex');
}

/**
 * Issues a new 6-digit code for `userId` ('set' or 'reset') and returns
 * it (to email). Voids any earlier unused code for that user.
 */
async function createCode(userId, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query('UPDATE password_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await pool.query(
    `INSERT INTO password_codes (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'))`,
    [userId, _codeHash(userId, code), purpose, CODE_TTL_MS]
  );
  return code;
}

/**
 * Checks `code` against the user's current code and, if it's right, sets
 * the new password and uses the code up — atomically. A wrong code
 * counts an attempt; the code stops working after MAX_CODE_ATTEMPTS.
 * `password_changed_at` also ends every existing session for that user
 * (see routes/auth.js). Returns { ok: true } or { ok: false, reason }
 * where reason is 'invalid' (wrong/expired/no code) or 'locked'.
 */
async function setPasswordWithCode(userId, code, password) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, code_hash, attempts FROM password_codes
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId]
    );
    const current = rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    if (current.attempts >= MAX_CODE_ATTEMPTS) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'locked' };
    }
    const given = Buffer.from(_codeHash(userId, String(code || '').trim()), 'hex');
    if (!crypto.timingSafeEqual(given, Buffer.from(current.code_hash, 'hex'))) {
      await client.query('UPDATE password_codes SET attempts = attempts + 1 WHERE id = $1', [current.id]);
      await client.query('COMMIT');
      return { ok: false, reason: current.attempts + 1 >= MAX_CODE_ATTEMPTS ? 'locked' : 'invalid' };
    }
    await client.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [userId, await hashPassword(password)]);
    await client.query('UPDATE password_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { validatePassword, hashPassword, verifyPassword, createCode, setPasswordWithCode, MIN_LENGTH, CODE_TTL_MS };
