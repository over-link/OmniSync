/**
 * services/passwords.js
 * Password hashing and one-time password links (set-password for new or
 * pre-password accounts, reset for "forgot password").
 *
 * Hashing uses Node's built-in scrypt (a memory-hard KDF) with a random
 * per-password salt — no native dependency to build on Render. Stored as
 * "scrypt$N$r$p$salt$hash" so the cost parameters can be raised later
 * without breaking existing hashes.
 *
 * Link tokens: 32 random bytes, sent to the user's email; only a SHA-256
 * of the token is stored, so a database leak can't be replayed as links.
 * Single-use, time-limited, and issuing or using one invalidates that
 * user's other outstanding links.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const pool = require('../db/pool');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };

const MIN_LENGTH = 10;
const MAX_LENGTH = 200;

// A reset link is short-lived; a first-time "set your password" link
// (invite, or an account that predates passwords) gets longer, since
// people don't always open those right away.
const LINK_TTL_MS = { reset: 60 * 60 * 1000, set: 72 * 60 * 60 * 1000 };

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

const _sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Creates a one-time link token for `userId` ('set' or 'reset') and
 * returns the raw token (to put in the emailed URL). Any earlier unused
 * links for that user stop working — only the newest email is valid.
 */
async function createLinkToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await pool.query(
    `INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'))`,
    [userId, _sha256(token), purpose, LINK_TTL_MS[purpose]]
  );
  return token;
}

/** The still-valid link's { userId, email, purpose }, or null — doesn't use it up. */
async function lookupLinkToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT t.user_id, t.purpose, u.email FROM password_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [_sha256(token)]
  );
  return rows[0] ? { userId: rows[0].user_id, email: rows[0].email, purpose: rows[0].purpose } : null;
}

/**
 * Sets a new password via a link token, atomically using up the token.
 * `password_changed_at` also ends every existing session for that user
 * (see routes/auth.js) — a reset after a suspected compromise logs out
 * whoever else was signed in. Returns { email } or null if the link is
 * invalid, expired, or already used.
 */
async function setPasswordWithToken(token, password) {
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE password_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [_sha256(token)]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const userId = rows[0].user_id;
    const { rows: userRows } = await client.query(
      'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1 RETURNING email',
      [userId, passwordHash]
    );
    await client.query('UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    await client.query('COMMIT');
    return { email: userRows[0].email };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { validatePassword, hashPassword, verifyPassword, createLinkToken, lookupLinkToken, setPasswordWithToken, MIN_LENGTH };
