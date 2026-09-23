/**
 * services/httpRetry.js
 * Retries transient upstream gateway failures (502/503/504) on the shared
 * axios instance every ACC/Revizto call goes through. These come from
 * Autodesk's/Revizto's own gateways, not from anything this app sent, and
 * usually clear within seconds — but without a retry each one surfaced as
 * an issue error pill + audit row, and worse, a blip on a per-user ACC
 * push (see syncService._withAccUserFallback) silently fell back to the
 * project owner, misattributing the edit.
 *
 * Only idempotent methods are retried. A POST that times out at the
 * gateway may still have gone through upstream, and re-sending it could
 * create a duplicate ACC issue/comment/attachment. The same rule keeps
 * OAuth token refreshes (POSTs, with single-use rotating refresh tokens)
 * out of this entirely.
 */
const axios = require('axios');

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_METHODS = new Set(['get', 'head', 'put', 'patch', 'delete']);
const RETRY_DELAYS_MS = [1000, 3000];

let installed = false;

function install() {
  if (installed) return;
  installed = true;

  axios.interceptors.response.use(null, async (err) => {
    const config = err.config;
    const status = err.response?.status;
    const method = (config?.method || 'get').toLowerCase();
    if (!config || !RETRYABLE_STATUSES.has(status) || !RETRYABLE_METHODS.has(method)) throw err;

    const attempt = config.__retryAttempt || 0;
    if (attempt >= RETRY_DELAYS_MS.length) throw err;
    config.__retryAttempt = attempt + 1;

    console.warn(`[http] ${method.toUpperCase()} ${config.url} got ${status} — retrying (${attempt + 1}/${RETRY_DELAYS_MS.length})`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    return axios(config);
  });
}

module.exports = { install };
