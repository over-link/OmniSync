/**
 * services/tokenCrypto.js
 * Encrypts the stored Revizto / ACC connection tokens (acc_tokens,
 * revizto_tokens) so a copy of the database — a backup, a SQL console, a
 * leaked connection string — doesn't hand out working logins to those
 * services. Used only by services/tokenStore.js.
 *
 * AES-256-GCM, one random IV per value. Stored as
 *   enc:v1:<keyId>:<iv>:<authTag>:<ciphertext>      (base64url parts)
 * The auth data binds each value to its table, column and user id, so a
 * value copied into another user's row (or column) fails to decrypt, and any
 * tampering is detected.
 *
 * Keys live in the server's environment, never the database:
 *   TOKEN_ENCRYPTION_KEY       current key: base64 of 32 random bytes
 *   TOKEN_ENCRYPTION_OLD_KEYS  optional, comma-separated older keys (so a key
 *                              can be rotated: values name the key that made
 *                              them, and old values keep decrypting)
 *   TOKEN_ENCRYPTION_WRITE     "on" to encrypt values as they are saved.
 *                              Anything else (the default) keeps saving plain
 *                              text — so deploying this code changes nothing
 *                              until it is switched on. Reading always accepts
 *                              both forms, so switching it off again is safe.
 * Make a key with:  npm run tokens:encrypt -- --new-key
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

class TokenUnreadableError extends Error {
  constructor(reason) {
    super(`Stored token can't be read: ${reason}`);
    this.name = 'TokenUnreadableError';
  }
}

const _b64 = (buf) => buf.toString('base64url');
const _fromB64 = (s) => Buffer.from(s, 'base64url');

function _parseKey(text) {
  const key = Buffer.from(String(text).trim(), 'base64');
  if (key.length !== 32) throw new Error('A token encryption key must be 32 bytes, base64-encoded.');
  return key;
}

const _keyId = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

let _cache = { sig: null, value: null };
/** { current: { id, key } | null, byId: Map(id -> key) } from the environment. */
function _keys() {
  const sig = `${process.env.TOKEN_ENCRYPTION_KEY || ''}|${process.env.TOKEN_ENCRYPTION_OLD_KEYS || ''}`;
  if (_cache.sig === sig) return _cache.value;
  const byId = new Map();
  let current = null;
  if (process.env.TOKEN_ENCRYPTION_KEY) {
    const key = _parseKey(process.env.TOKEN_ENCRYPTION_KEY);
    current = { id: _keyId(key), key };
    byId.set(current.id, key);
  }
  for (const old of String(process.env.TOKEN_ENCRYPTION_OLD_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const key = _parseKey(old);
    byId.set(_keyId(key), key);
  }
  _cache = { sig, value: { current, byId } };
  return _cache.value;
}

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/** True when a key is configured AND TOKEN_ENCRYPTION_WRITE=on. */
function writeEnabled() {
  return process.env.TOKEN_ENCRYPTION_WRITE === 'on' && !!_keys().current;
}

/** The auth data that ties a value to where it's stored. */
const aad = (table, column, userId) => `${table}:${column}:${userId}`;

/** Encrypts `plain` with the current key. Throws if no key is configured. */
function encrypt(plain, aadText) {
  const { current } = _keys();
  if (!current) throw new Error('TOKEN_ENCRYPTION_KEY is not set.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(Buffer.from(aadText));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${PREFIX}${current.id}:${_b64(iv)}:${_b64(cipher.getAuthTag())}:${_b64(ct)}`;
}

/**
 * Plain text (an older, not yet converted value) comes back unchanged; an
 * encrypted value is decrypted. Throws TokenUnreadableError when it can't be
 * (no such key here, wrong user/column, or it was altered).
 */
function decrypt(value, aadText) {
  if (!isEncrypted(value)) return value;
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 4) throw new TokenUnreadableError('malformed value');
  const [keyId, iv, tag, ct] = parts;
  const key = _keys().byId.get(keyId);
  if (!key) throw new TokenUnreadableError(`no key ${keyId} configured`);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, _fromB64(iv));
    decipher.setAAD(Buffer.from(aadText));
    decipher.setAuthTag(_fromB64(tag));
    return Buffer.concat([decipher.update(_fromB64(ct)), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenUnreadableError('wrong key or altered value');
  }
}

/** For saving: encrypted when switched on, otherwise as given. */
const protect = (plain, aadText) => (writeEnabled() ? encrypt(plain, aadText) : plain);

const newKey = () => crypto.randomBytes(32).toString('base64');

module.exports = { PREFIX, TokenUnreadableError, isEncrypted, writeEnabled, aad, encrypt, decrypt, protect, newKey };
