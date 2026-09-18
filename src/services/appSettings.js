/**
 * services/appSettings.js
 * Small global (not per-project) key/value settings store. Currently just
 * one switch: pausing automatic background syncing while testing the app,
 * without needing a Render env var change/redeploy or suspending the
 * whole service. See schema.sql's app_settings table for the "why".
 */
const pool = require('../db/pool');

const SYNC_PAUSED_KEY = 'sync_paused';

async function isSyncPaused() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [SYNC_PAUSED_KEY]);
  return rows[0]?.value === 'true';
}

async function setSyncPaused(paused) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SYNC_PAUSED_KEY, paused ? 'true' : 'false']
  );
}

module.exports = { isSyncPaused, setSyncPaused };
