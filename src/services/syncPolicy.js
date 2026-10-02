/**
 * services/syncPolicy.js
 * WHEN background syncing runs, per license (docs/multi-tenant-architecture.md):
 *   - the operator's PLATFORM pause stops everything (app_settings
 *     'platform_sync_paused', set with npm run platform:sync);
 *   - each license has its own "sync paused" and "sync outside working hours"
 *     switches (tenant_licenses.sync_paused / poll_247), changed by that
 *     license's admins on License Administration — never another license's;
 *   - working hours and the daily full check follow the license's COMPANY
 *     timezone (tenants.timezone);
 *   - a license that isn't active (services/licenseState.js) doesn't sync.
 * planTick() is the pure decision; the helpers keep each license's
 * paused_since up to date (the moment its syncing stopped — what the
 * catch-up after a pause is measured from).
 *
 * The older app-wide keys in app_settings ('sync_paused', 'poll_24_7',
 * 'last_full_check_date') are left alone for the previously deployed code;
 * copyGlobalSettingsOnce() copies them into the existing license(s) once, at
 * startup, so nothing changes on the day this goes live.
 */
const pool = require('../db/pool');
const appSettings = require('./appSettings');
const licenseState = require('./licenseState');

const ACTIVE_START_HOUR = 6; // 6 AM, company time
const ACTIVE_END_HOUR = 18; // 6 PM (exclusive)
const FULL_CHECK_HOUR = 18; // the day's last cycle re-checks every linked issue

/** { date: 'YYYY-MM-DD', hour } of `now` in `timeZone`. */
function localParts(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || licenseState.DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * What to do for one license this tick:
 *   'inactive' (license not active), 'paused' (its switch), 'full' (the day's
 *   full check is due), 'normal' (changed-only cycle), 'quiet' (outside working hours).
 */
function decide(license, now = new Date()) {
  if (!license.state.usable) return 'inactive';
  if (license.sync_paused) return 'paused';
  const { date, hour } = localParts(license.timezone, now);
  // Due any time from 6 PM until midnight if it hasn't run today (a restart or
  // deploy right at 6 PM doesn't lose that day's check).
  if (hour >= FULL_CHECK_HOUR && license.last_full_check_date !== date) return 'full';
  if ((hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR) || license.poll_247) return 'normal';
  return 'quiet';
}

/** Groups licenses by what to do this tick; `resumed` = syncable ones whose pause is ending. */
function planTick(licenses, now = new Date()) {
  const plan = { full: [], normal: [], paused: [], inactive: [], quiet: [], resumed: [] };
  for (const license of licenses) {
    const what = decide(license, now);
    plan[what].push(license);
    if ((what === 'full' || what === 'normal') && license.paused_since) plan.resumed.push(license);
  }
  return plan;
}

/** Stamps paused_since on licenses whose syncing just stopped (once; never overwritten while paused). */
async function markPaused(licenseIds) {
  if (!licenseIds.length) return;
  await pool.query('UPDATE tenant_licenses SET paused_since = now() WHERE id = ANY($1::int[]) AND paused_since IS NULL', [licenseIds]);
}

/** Clears paused_since once a license has synced again. */
async function clearPaused(licenseIds) {
  if (!licenseIds.length) return;
  await pool.query('UPDATE tenant_licenses SET paused_since = NULL WHERE id = ANY($1::int[])', [licenseIds]);
}

async function markFullCheckDone(licenseId, date) {
  await pool.query('UPDATE tenant_licenses SET last_full_check_date = $2 WHERE id = $1', [licenseId, date]);
}

// ─── The license's own switches ──────────────────────────────────────

const FLAGS = { sync_paused: 'sync_paused', poll_247: 'poll_247' };

async function getFlag(licenseId, flag) {
  if (!FLAGS[flag]) throw new Error('Unknown setting');
  const { rows } = await pool.query(`SELECT ${FLAGS[flag]} AS v FROM tenant_licenses WHERE id = $1`, [licenseId]);
  return !!rows[0]?.v;
}

async function setFlag(licenseId, flag, value) {
  if (!FLAGS[flag]) throw new Error('Unknown setting');
  await pool.query(`UPDATE tenant_licenses SET ${FLAGS[flag]} = $2 WHERE id = $1`, [licenseId, !!value]);
}

/**
 * Is background syncing paused for this project right now? The operator's
 * platform pause, or its license's own switch. (A project with no license yet —
 * legacy data — follows the older app-wide switch.)
 */
async function isPaused(project) {
  if (await appSettings.isPlatformSyncPaused()) return true;
  if (!project.tenant_license_id) return appSettings.isSyncPaused();
  return getFlag(project.tenant_license_id, 'sync_paused');
}

/**
 * One-time, at startup: copies the older app-wide switches and last-full-check
 * date into every license that hasn't had them copied yet (settings_copied_at
 * IS NULL — in practice the license the chunk 1 backfill made). A license
 * created later must be created with settings_copied_at set (see
 * services/tenancy.js), so it never inherits another company's pause.
 */
async function copyGlobalSettingsOnce() {
  const { rowCount } = await pool.query(
    `UPDATE tenant_licenses SET
       sync_paused = COALESCE((SELECT value = 'true' FROM app_settings WHERE key = 'sync_paused'), false),
       poll_247 = COALESCE((SELECT value = 'true' FROM app_settings WHERE key = 'poll_24_7'), false),
       last_full_check_date = (SELECT CASE WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN value::date END FROM app_settings WHERE key = 'last_full_check_date'),
       settings_copied_at = now()
     WHERE settings_copied_at IS NULL`
  );
  if (rowCount) console.log(`[poll] Copied the app-wide sync settings into ${rowCount} license(s).`);
  return rowCount;
}

module.exports = {
  ACTIVE_START_HOUR,
  ACTIVE_END_HOUR,
  FULL_CHECK_HOUR,
  localParts,
  decide,
  planTick,
  markPaused,
  clearPaused,
  markFullCheckDone,
  getFlag,
  setFlag,
  isPaused,
  copyGlobalSettingsOnce,
};
