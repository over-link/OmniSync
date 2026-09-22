/**
 * services/authManager.js
 * The single place that decides "is this user's token still good, or do
 * we need to refresh it" for both ACC and Revizto. Every API call in the
 * app should go through getValidAccToken/getValidReviztoToken rather than
 * touching tokenStore or the *Auth modules directly.
 */
const tokenStore = require('./tokenStore');
const accAuth = require('./accAuth');
const reviztoAuth = require('./reviztoAuth');

class ReconnectRequiredError extends Error {
  constructor(provider, reason) {
    super(`${provider} reconnect required: ${reason}`);
    this.provider = provider;
    this.reason = reason;
  }
}

// ─── Per-user refresh lock ──────────────────────────────────────────
// Both ACC's and Revizto's refresh tokens are single-use and rotating —
// using one invalidates it and issues a new one (confirmed for ACC from
// Autodesk's own APS docs; Revizto's docs describe the same "both tokens
// rotate on refresh" shape — see reviztoAuth.js). Without this lock, two
// near-simultaneous calls for the same user that both decide a refresh
// is needed would race: both read the same about-to-be-spent
// refresh_token, one wins and gets a new one saved, the other's attempt
// (using the now-already-invalidated token) fails — permanently breaking
// a connection that was perfectly healthy a moment earlier. Confirmed
// real, not theoretical: watched exactly this happen to a genuinely
// healthy ACC connection during live testing (two overlapping requests
// for the same user, moments apart).
//
// A plain in-memory Map is enough since this app runs as a single Node
// process (not clustered) — no distributed lock needed. Keyed by
// `${provider}:${userId}`; whoever's already refreshing holds the map
// entry, everyone else just awaits the same in-flight promise instead of
// starting their own.
const _refreshLocks = new Map();

async function _withRefreshLock(key, fn) {
  const existing = _refreshLocks.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => _refreshLocks.delete(key));
  _refreshLocks.set(key, promise);
  return promise;
}

// ─── ACC ──────────────────────────────────────────────────────────

async function getValidAccToken(userId) {
  const tokens = await tokenStore.getAccTokens(userId);
  if (!tokens) throw new ReconnectRequiredError('acc', 'not connected');

  if (new Date(tokens.expires_at) > new Date()) {
    return tokens.access_token;
  }

  return _withRefreshLock(`acc:${userId}`, async () => {
    // Re-read rather than trust the `tokens` closed over above — another
    // call may have already refreshed (and rotated) this exact token
    // while this one was waiting to reach this point, in which case
    // there's a fresh access token to use and nothing left to refresh.
    const latest = (await tokenStore.getAccTokens(userId)) || tokens;
    if (new Date(latest.expires_at) > new Date()) {
      return latest.access_token;
    }
    try {
      const refreshed = await accAuth.refresh(latest.refresh_token);
      await tokenStore.saveAccTokens(userId, {
        ...refreshed,
        autodesk_user_id: latest.autodesk_user_id,
        autodesk_email: latest.autodesk_email,
      });
      return refreshed.access_token;
    } catch (err) {
      throw new ReconnectRequiredError('acc', err.response?.data?.error_description || err.message);
    }
  });
}

// ─── Revizto ──────────────────────────────────────────────────────

async function getValidReviztoToken(userId) {
  const tokens = await tokenStore.getReviztoTokens(userId);
  if (!tokens) throw new ReconnectRequiredError('revizto', 'not connected');

  if (new Date(tokens.refresh_expires_at) <= new Date()) {
    throw new ReconnectRequiredError('revizto', 'refresh token expired (~monthly) — get a new access code');
  }

  if (new Date(tokens.access_expires_at) > new Date()) {
    return tokens.access_token;
  }

  return _withRefreshLock(`revizto:${userId}`, async () => {
    // Same re-check as ACC above — someone else may have already
    // refreshed while this call waited for the lock.
    const latest = (await tokenStore.getReviztoTokens(userId)) || tokens;
    if (new Date(latest.access_expires_at) > new Date()) {
      return latest.access_token;
    }
    try {
      const refreshed = await reviztoAuth.refresh(latest.refresh_token, latest.region);
      await tokenStore.saveReviztoTokens(userId, { ...refreshed, region: latest.region });
      return refreshed.access_token;
    } catch (err) {
      // -206 or similar => refresh token itself is dead, needs a fresh access code
      await tokenStore.clearReviztoTokens(userId);
      throw new ReconnectRequiredError('revizto', err.response?.data?.message || err.message);
    }
  });
}

module.exports = { getValidAccToken, getValidReviztoToken, ReconnectRequiredError };
