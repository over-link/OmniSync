/**
 * services/appSettings.js
 * Small global (not per-project) key/value settings store. Currently just
 * one switch: pausing automatic background syncing while testing the app,
 * without needing a Render env var change/redeploy or suspending the
 * whole service. See schema.sql's app_settings table for the "why".
 */
const pool = require('../db/pool');

const SYNC_PAUSED_KEY = 'sync_paused';
// The OPERATOR's pause for the whole platform (npm run platform:sync) — stops
// background syncing for every license (services/syncPolicy.js).
const PLATFORM_SYNC_PAUSED_KEY = 'platform_sync_paused';
// Polling runs 6 AM–6 PM (pollService) unless this is 'true'. Switched
// on License Administration ("Sync outside working hours") — for testing
// for now; intended to become a per-paid-tier setting (e.g. an
// "OmniSync+" plan) once plans exist.
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

async function isPlatformSyncPaused() {
  return (await _get(PLATFORM_SYNC_PAUSED_KEY)) === 'true';
}

async function setPlatformSyncPaused(paused) {
  await _set(PLATFORM_SYNC_PAUSED_KEY, paused ? 'true' : 'false');
}

async function isPoll247() {
  return (await _get(POLL_24_7_KEY)) === 'true';
}

async function setPoll247(on) {
  await _set(POLL_24_7_KEY, on ? 'true' : 'false');
}

async function getLastFullCheckDate() {
  return _get(LAST_FULL_CHECK_KEY);
}

async function setLastFullCheckDate(date) {
  await _set(LAST_FULL_CHECK_KEY, date);
}

module.exports = {
  isSyncPaused,
  setSyncPaused,
  isPlatformSyncPaused,
  setPlatformSyncPaused,
  isPoll247,
  setPoll247,
  getLastFullCheckDate,
  setLastFullCheckDate,
};
