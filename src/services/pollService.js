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
const { ReconnectRequiredError } = require('./authManager');

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

function startPolling() {
  if (process.env.POLL_ENABLED === 'false') {
    console.log('[poll] Automatic re-sync of linked issues disabled (POLL_ENABLED=false)');
    return;
  }
  const schedule = process.env.POLL_CRON || '*/2 * * * *'; // every 2 minutes by default
  console.log(`[poll] Automatic re-sync of linked issues enabled: ${schedule}`);
  cron.schedule(schedule, pollAllProjects);
}

module.exports = { startPolling, pollAllProjects };
