/**
 * services/pollService.js
 * Automatic re-sync of already-LINKED issues, every 2 minutes by default.
 * By default this does NOT push new/unlinked issues — that stays a
 * manual, explicit choice (the "Select issues to sync" flow). The one
 * opt-in exception is auto-sync-by-filter (Setup page,
 * project.auto_sync_enabled): if a project has that turned on with real
 * filter criteria configured, matching unlinked issues get swept in here
 * too (see syncService.autoLinkMatchingIssues) — everything else keeps
 * the "manual to link, automatic after" design.
 */
const cron = require('node-cron');
const pool = require('../db/pool');
const syncService = require('./syncService');
const appSettings = require('./appSettings');
const { ReconnectRequiredError, getValidAccToken, getValidReviztoToken } = require('./authManager');

// Polling hours and the daily full check, in the team's local time (all
// of today's users are on Pacific time). Outside ACTIVE hours the
// 2-minute cycle does nothing unless 24/7 polling is on (appSettings.
// isPoll247 — meant for a paid tier later). ACC's webhook for field
// changes made in ACC keeps working around the clock regardless: a
// dropped ACC edit would otherwise be overwritten by the next full check.
const SYNC_TIMEZONE = process.env.SYNC_TIMEZONE || 'America/Los_Angeles';
const ACTIVE_START_HOUR = 6; // 6 AM
const ACTIVE_END_HOUR = 18; // 6 PM (exclusive)
// End of the working day — the last cycle before the overnight pause
// re-checks every linked issue, ignoring change markers, as a safety net
// for anything a timestamp or count didn't reflect (see pushLinkedIssues).
const FULL_CHECK_HOUR = 18;

function _localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: SYNC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

let cycleRunning = false;
let quietLoggedForDate = null;

/**
 * One 2-minute tick: decides whether this tick is a normal changed-only
 * cycle, the day's full check, or nothing (paused / overnight). Never
 * overlaps itself — a cycle still running when the next tick fires (e.g.
 * a large project, or the full check) just makes that tick a no-op.
 */
async function pollTick() {
  if (cycleRunning) {
    console.log('[poll] Previous cycle still running — skipping this tick.');
    return;
  }
  cycleRunning = true;
  try {
    if (await appSettings.isSyncPaused()) {
      console.log('[poll] Sync is paused (Setup page toggle) — skipping this cycle.');
      return;
    }
    const { date, hour } = _localNow();
    // Due any time from 6 PM until midnight if it hasn't run today — so a
    // restart or deploy right at 6 PM doesn't lose that day's check.
    if (hour >= FULL_CHECK_HOUR && (await appSettings.getLastFullCheckDate()) !== date) {
      console.log(`[poll] Daily full check (${SYNC_TIMEZONE} ${date}) — re-checking every linked issue.`);
      await pollAllProjects({ full: true });
      await appSettings.setLastFullCheckDate(date);
      return;
    }
    const activeHours = hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR;
    if (!activeHours && !(await appSettings.isPoll247())) {
      if (quietLoggedForDate !== date) {
        console.log(`[poll] Outside polling hours (6 AM–6 PM ${SYNC_TIMEZONE}) — paused until 6 AM. ACC webhooks still apply.`);
        quietLoggedForDate = date;
      }
      return;
    }
    await pollAllProjects({ full: false });
  } catch (err) {
    console.error('[poll] Cycle failed:', err.message);
  } finally {
    cycleRunning = false;
  }
}

async function pollAllProjects({ full = false } = {}) {
  // Unpaired projects (created on License Administration, not yet paired
  // on Project Setup) have nothing to sync; archived ones are parked.
  const { rows: projects } = await pool.query(
    'SELECT * FROM projects WHERE owner_user_id IS NOT NULL AND revizto_project_uuid IS NOT NULL AND acc_project_id IS NOT NULL AND archived_at IS NULL'
  );
  for (const project of projects) {
    try {
      // One bulk look at both sides for every linked issue, shared by the
      // push and both ACC polls below, which each skip issues that
      // haven't changed since their last check (unless full).
      const snapshot = await syncService.prefetchLinkedIssues(project.owner_user_id, project);
      const results = await syncService.pushLinkedIssues(project.owner_user_id, project, { snapshot, full });
      if (results.length) {
        const errors = results.filter((r) => r.action === 'error');
        const skipped = results.filter((r) => r.action === 'skipped');
        console.log(
          `[poll] "${project.name}": ${results.length - skipped.length} changed issue(s) re-synced, ${skipped.length} unchanged skipped, ${errors.length} errors${full ? ' (full check)' : ''}`
        );
      }

      // Opt-in: only does anything if the admin turned on auto-sync-by-
      // filter for this project (see fieldMapping.getAutoSyncFilters).
      const autoLinkResults = await syncService.autoLinkMatchingIssues(project.owner_user_id, project);
      if (autoLinkResults.length) {
        const errors = autoLinkResults.filter((r) => r.action === 'error');
        console.log(`[poll] "${project.name}": ${autoLinkResults.length} issue(s) auto-linked by filter, ${errors.length} errors`);
      }

      // No webhook event exists for ACC comments (or is confirmed for
      // attachments), so both have to actively poll rather than react —
      // same cycle as the push above.
      const { rows: ownerRows } = await pool.query('SELECT email FROM users WHERE id = $1', [project.owner_user_id]);
      const reporterEmail = ownerRows[0]?.email;
      await syncService.pollAccCommentsForProject(project.owner_user_id, project, reporterEmail, { snapshot, full });
      await syncService.pollAccAttachmentsForProject(project.owner_user_id, project, reporterEmail, { snapshot, full });
    } catch (err) {
      if (err instanceof ReconnectRequiredError) {
        console.warn(`[poll] Project "${project.name}" owner needs to reconnect ${err.provider}: ${err.reason}`);
      } else {
        console.error(`[poll] Project "${project.name}" failed:`, err.message);
      }
    }
  }
}

/**
 * Proactively refreshes every ACC-connected user's token on a schedule,
 * regardless of whether they've personally used the app recently.
 * Confirmed by real testing: Autodesk revokes a refresh token after a
 * period of pure inactivity ("grant revoked due to idle timeout" on a
 * connection unused for ~3 weeks) — which would otherwise silently break
 * per-user attribution (syncService._findAccUserIdForEmail: using the
 * REAL Revizto author's own ACC connection when they have one, so ACC's
 * activity log shows them, not just a text note) for anyone who doesn't
 * happen to touch ACC-connected features often. getValidAccToken's own
 * refresh call counts as activity to Autodesk, resetting their idle
 * clock — so running this on a schedule keeps every connection alive
 * indefinitely with no other engagement required from that person. Cheap
 * and safe to run often: getValidAccToken only actually calls Autodesk
 * when the current access token (short-lived, ~1hr) has already expired,
 * so most runs for an active connection are a local no-op.
 */
async function keepAccConnectionsAlive() {
  const { rows } = await pool.query('SELECT user_id, autodesk_email FROM acc_tokens');
  for (const row of rows) {
    try {
      await getValidAccToken(row.user_id);
    } catch (err) {
      console.warn(`[poll] Could not keep ACC connection alive for ${row.autodesk_email || row.user_id} (reconnect needed):`, err.message);
    }
  }
}

/**
 * Revizto's own counterpart to keepAccConnectionsAlive above — same
 * reasoning, same mechanism, just Revizto's confirmed-activity-based
 * refresh window (~1 month per successful refresh, see reviztoAuth's
 * `refresh_expires_at` and the README's "Revizto refresh token expiry"
 * note) instead of ACC's fixed 15-day one. Before this, a Revizto
 * connection only stayed alive if the person happened to personally use
 * a Revizto-data page (e.g. Issues) often enough — someone who barely
 * touched the app but never needed to would still eventually go dead on
 * the calendar alone. This closes that gap the same way ACC's already
 * closed it: nobody should need to manually reconnect just because they
 * didn't happen to click around enough, only when something genuinely
 * goes wrong (Revizto/ACC server-side issues, a revoked grant, etc.).
 */
async function keepReviztoConnectionsAlive() {
  const { rows } = await pool.query(
    `SELECT r.user_id, u.email FROM revizto_tokens r JOIN users u ON u.id = r.user_id`
  );
  for (const row of rows) {
    try {
      await getValidReviztoToken(row.user_id);
    } catch (err) {
      console.warn(`[poll] Could not keep Revizto connection alive for ${row.email || row.user_id} (reconnect needed):`, err.message);
    }
  }
}

function startPolling() {
  if (process.env.POLL_ENABLED === 'false') {
    console.log('[poll] Automatic re-sync of linked issues disabled (POLL_ENABLED=false)');
    return;
  }
  const schedule = process.env.POLL_CRON || '*/2 * * * *'; // every 2 minutes by default
  console.log(`[poll] Automatic re-sync of linked issues enabled: ${schedule}`);
  cron.schedule(schedule, pollTick);

  const keepAliveSchedule = process.env.ACC_KEEPALIVE_CRON || '0 3 * * *'; // once daily by default
  console.log(`[poll] ACC connection keep-alive enabled: ${keepAliveSchedule}`);
  cron.schedule(keepAliveSchedule, keepAccConnectionsAlive);

  // Staggered an hour after ACC's by default, purely to avoid both large
  // batch jobs landing in the same minute — not a functional requirement.
  const reviztoKeepAliveSchedule = process.env.REVIZTO_KEEPALIVE_CRON || '0 4 * * *';
  console.log(`[poll] Revizto connection keep-alive enabled: ${reviztoKeepAliveSchedule}`);
  cron.schedule(reviztoKeepAliveSchedule, keepReviztoConnectionsAlive);
}

module.exports = { startPolling, pollTick, pollAllProjects, keepAccConnectionsAlive, keepReviztoConnectionsAlive };
