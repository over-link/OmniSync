/**
 * services/webhookSignature.js
 * Checks that a call to /webhook/acc really came from Autodesk.
 *
 * Autodesk's scheme (APS Webhooks "How to verify payload signature"): you
 * register a secret token for the app (POST /webhooks/v1/tokens), and every
 * delivery then carries an `X-Adsk-Signature` header: HMAC-SHA1 of the RAW
 * request body, keyed with that token, hex-encoded, written "sha1hash=<hex>".
 * It must be computed on the raw bytes — re-serialising the parsed JSON gives a
 * different hash. WEBHOOK_SECRET in the environment is that token.
 *
 * WEBHOOK_SIGNATURE_MODE (default "log") controls what a bad or missing
 * signature does, so rolling this out can't break live syncing:
 *   off     - no checking at all (the old behaviour)
 *   log     - check and log the result, but still process the delivery
 *   enforce - ignore deliveries that don't verify (still answered 200, so
 *             Autodesk doesn't treat the hook as failing and disable it)
 */
const crypto = require('crypto');

const MODES = ['off', 'log', 'enforce'];

function mode() {
  const m = String(process.env.WEBHOOK_SIGNATURE_MODE || 'log').toLowerCase();
  return MODES.includes(m) ? m : 'log';
}

/** The expected header value ("sha1hash=<hex>") for a raw body. */
function sign(rawBody, secret) {
  return `sha1hash=${crypto.createHmac('sha1', secret).update(rawBody).digest('hex')}`;
}

/**
 * 'valid' | 'invalid' | 'missing-header' | 'no-secret' | 'no-body'.
 * Accepts the header with or without the "sha1hash=" prefix; compared in
 * constant time.
 */
function check(rawBody, header, secret) {
  if (!secret) return 'no-secret';
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return 'no-body';
  if (!header) return 'missing-header';
  const expected = sign(rawBody, secret);
  const given = String(header).trim().toLowerCase();
  const normalised = given.startsWith('sha1hash=') ? given : `sha1hash=${given}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(normalised);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

/**
 * What to do with an incoming delivery: { proceed: boolean, result }.
 * Logs the outcome (never the secret or the signature itself).
 */
function decide(req) {
  const m = mode();
  if (m === 'off') return { proceed: true, result: 'off' };
  const result = check(req.rawBody, req.get('x-adsk-signature'), process.env.WEBHOOK_SECRET);
  if (result === 'valid') {
    console.log('[webhook] Signature verified.');
    return { proceed: true, result };
  }
  if (m === 'enforce') {
    console.warn(`[webhook] Ignoring a delivery on ${req.path}: signature check failed (${result}).`);
    return { proceed: false, result };
  }
  console.warn(`[webhook] Signature check did not pass (${result}) — processing anyway (WEBHOOK_SIGNATURE_MODE=log).`);
  return { proceed: true, result };
}

module.exports = { mode, sign, check, decide };
