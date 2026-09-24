/**
 * services/appSettings.js
 * Small global (not per-project) key/value settings store. Currently just
 * one switch: pausing automatic background syncing while testing the app,
 * without needing a Render env var change/redeploy or suspending the
 * whole service. See schema.sql's app_settings table for the "why".
 */
const pool = require('../db/pool');

const SYNC_PAUSED_KEY = 'sync_paused';
// Polling runs 6 AM–6 PM (pollService) unless this is 'true'. No UI yet —
// intended to be switched on per paid tier (e.g. an "OmniSync+" plan)
// once plans exist; until then set it directly if ever needed:
//   INSERT INTO app_settings (key, value) VALUES ('poll_24_7', 'true')
//   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
const POLL_24_7_KEY = 'poll_24_7';
// Local calendar date (YYYY-MM-DD) the daily full check last ran — kept
// in the DB so a restart/deploy doesn't re-run it the same day.
const LAST_FULL_CHECK_KEY = 'last_full_check_date';

async function _get(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function _set(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function isSyncPaused() {
  return (await _get(SYNC_PAUSED_KEY)) === 'true';
}

async function setSyncPaused(paused) {
  await _set(SYNC_PAUSED_KEY, paused ? 'true' : 'false');
}

async function isPoll247() {
  return (await _get(POLL_24_7_KEY)) === 'true';
}

async function getLastFullCheckDate() {
  return _get(LAST_FULL_CHECK_KEY);
}

async function setLastFullCheckDate(date) {
  await _set(LAST_FULL_CHECK_KEY, date);
}

module.exports = { isSyncPaused, setSyncPaused, isPoll247, getLastFullCheckDate, setLastFullCheckDate };
