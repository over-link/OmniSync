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
const { ReconnectRequiredError, getValidAccToken } = require('./authManager');

async function pollAllProjects() {
  const { rows: projects } = await pool.query('SELECT * FROM projects WHERE owner_user_id IS NOT NULL');
  for (const project of projects) {
    try {
      const results = await syncService.pushLinkedIssues(project.owner_user_id, project);
      if (results.length) {
        const errors = results.filter((r) => r.action === 'error');
        console.log(`[poll] "${project.name}": ${results.length} linked issue(s) re-synced, ${errors.length} errors`);
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
      await syncService.pollAccCommentsForProject(project.owner_user_id, project, reporterEmail);
      await syncService.pollAccAttachmentsForProject(project.owner_user_id, project, reporterEmail);
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

function startPolling() {
  if (process.env.POLL_ENABLED === 'false') {
    console.log('[poll] Automatic re-sync of linked issues disabled (POLL_ENABLED=false)');
    return;
  }
  const schedule = process.env.POLL_CRON || '*/2 * * * *'; // every 2 minutes by default
  console.log(`[poll] Automatic re-sync of linked issues enabled: ${schedule}`);
  cron.schedule(schedule, pollAllProjects);

  const keepAliveSchedule = process.env.ACC_KEEPALIVE_CRON || '0 3 * * *'; // once daily by default
  console.log(`[poll] ACC connection keep-alive enabled: ${keepAliveSchedule}`);
  cron.schedule(keepAliveSchedule, keepAccConnectionsAlive);
}

module.exports = { startPolling, pollAllProjects, keepAccConnectionsAlive };
