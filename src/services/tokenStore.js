/**
 * services/tokenStore.js
 * DB-backed token storage, per user. This is the fix for the old app's
 * two problems: ACC tokens living in an in-memory JS object (gone on
 * restart, not shared across machines), and Revizto tokens living in a
 * local revizto-tokens.json file (tied to one disk).
 *
 * The token values themselves are encrypted at rest when
 * TOKEN_ENCRYPTION_WRITE=on (services/tokenCrypto.js); this file is the ONLY
 * place that reads or writes them. A value that can't be decrypted (missing
 * key, altered) makes that connection read as "not connected", so the person
 * is simply asked to reconnect.
 */
// Unrestricted on purpose: db/pool.js (row-level security) — this module looks across licenses / holds per-user secrets.
const pool = require('../db/pool').admin;
const tokenCrypto = require('./tokenCrypto');

const _acc = (column, userId) => tokenCrypto.aad('acc_tokens', column, userId);
const _revizto = (column, userId) => tokenCrypto.aad('revizto_tokens', column, userId);

/** The row with its two token fields decrypted, or null if they can't be. */
function _open(row, table, aadFor) {
  if (!row) return null;
  try {
    return {
      ...row,
      access_token: tokenCrypto.decrypt(row.access_token, aadFor('access_token', row.user_id)),
      refresh_token: tokenCrypto.decrypt(row.refresh_token, aadFor('refresh_token', row.user_id)),
    };
  } catch (err) {
    if (!(err instanceof tokenCrypto.TokenUnreadableError)) throw err;
    console.error(`[tokens] ${table} for user ${row.user_id}: ${err.message} — treating as not connected (they need to reconnect).`);
    return null;
  }
}

// ─── ACC / Autodesk tokens ──────────────────────────────────────────

async function getAccTokens(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM acc_tokens WHERE user_id = $1',
    [userId]
  );
  return _open(rows[0], 'acc_tokens', _acc);
}

async function saveAccTokens(userId, { access_token, refresh_token, expires_at, refresh_expires_at, autodesk_user_id, autodesk_email }) {
  await pool.query(
    `INSERT INTO acc_tokens (user_id, access_token, refresh_token, expires_at, refresh_expires_at, autodesk_user_id, autodesk_email, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       autodesk_user_id = COALESCE(EXCLUDED.autodesk_user_id, acc_tokens.autodesk_user_id),
       autodesk_email = COALESCE(EXCLUDED.autodesk_email, acc_tokens.autodesk_email),
       updated_at = now()`,
    [
      userId,
      tokenCrypto.protect(access_token, _acc('access_token', userId)),
      tokenCrypto.protect(refresh_token, _acc('refresh_token', userId)),
      expires_at,
      refresh_expires_at,
      autodesk_user_id || null,
      autodesk_email || null,
    ]
  );
}

async function saveAccHubId(userId, hubId) {
  await pool.query('UPDATE acc_tokens SET default_hub_id = $2, updated_at = now() WHERE user_id = $1', [userId, hubId]);
}

// ─── Revizto tokens ─────────────────────────────────────────────────

async function getReviztoTokens(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM revizto_tokens WHERE user_id = $1',
    [userId]
  );
  return _open(rows[0], 'revizto_tokens', _revizto);
}

async function saveReviztoTokens(userId, { access_token, refresh_token, access_expires_at, refresh_expires_at, region }) {
  await pool.query(
    `INSERT INTO revizto_tokens (user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'virginia'), now())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       access_expires_at = EXCLUDED.access_expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       region = COALESCE($6, revizto_tokens.region),
       updated_at = now()`,
    [
      userId,
      tokenCrypto.protect(access_token, _revizto('access_token', userId)),
      tokenCrypto.protect(refresh_token, _revizto('refresh_token', userId)),
      access_expires_at,
      refresh_expires_at,
      region || null,
    ]
  );
}

async function saveReviztoLicenseId(userId, licenseId, licenseRegion) {
  await pool.query(
    'UPDATE revizto_tokens SET license_id = $2, license_region = $3, updated_at = now() WHERE user_id = $1',
    [userId, licenseId, licenseRegion || null]
  );
}

async function clearReviztoTokens(userId) {
  await pool.query('DELETE FROM revizto_tokens WHERE user_id = $1', [userId]);
}

module.exports = {
  getAccTokens,
  saveAccTokens,
  saveAccHubId,
  getReviztoTokens,
  saveReviztoTokens,
  saveReviztoLicenseId,
  clearReviztoTokens,
};
