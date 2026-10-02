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
const webhookHealth = require('./webhookHealth');
const licenseState = require('./licenseState');
const pairingGuard = require('./pairingGuard');
const syncPolicy = require('./syncPolicy');
const { ReconnectRequiredError, getValidAccToken, getValidReviztoToken } = require('./authManager');

// Polling hours and the daily full check, in the team's local time (all
// of today's users are on Pacific time). Outside ACTIVE hours the
// 2-minute cycle does nothing unless 24/7 polling is on (appSettings.
// isPoll247 — meant for a paid tier later). ACC's webhook for field
// changes made in ACC keeps working around the clock regardless (kept
// alive by the hourly webhook check below): a dropped ACC edit would
// otherwise be overwritten by the next full check.
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
const quietLogged = new Map(); // license id -> date its "outside working hours" line was logged
const catchUpTries = new Map(); // license id -> how many incomplete catch-up attempts so far
const CATCH_UP_ATTEMPTS = 3;

const _ids = (licenses) => licenses.map((l) => l.id);

/**
 * One 2-minute tick. Each LICENSE is decided on its own (services/syncPolicy.js):
 * its own pause switch, its own working hours and daily full check in its
 * company's timezone, and only while the license is active. The operator's
 * platform pause stops everything. Never overlaps itself — a cycle still
 * running when the next tick fires (e.g. a large project, or a full check)
 * just makes that tick a no-op.
 */
async function pollTick() {
  if (cycleRunning) {
    console.log('[poll] Previous cycle still running — skipping this tick.');
    return;
  }
  cycleRunning = true;
  try {
    await syncPolicy.copyGlobalSettingsOnce();
    await pairingGuard.refresh(); // license state changes with the calendar: keep which pairings are active current
    const licenses = await licenseState.loadAll();
    if (await appSettings.isPlatformSyncPaused()) {
      console.log('[poll] Syncing is paused for the whole platform (operator) — skipping this cycle.');
      await syncPolicy.markPaused(_ids(licenses));
      return;
    }
    const now = new Date();
    const plan = syncPolicy.planTick(licenses, now);
    await syncPolicy.markPaused([..._ids(plan.paused), ..._ids(plan.inactive)]);
    for (const l of plan.paused) console.log(`[poll] License "${l.name}": sync is paused (License Administration toggle) — skipping.`);
    for (const l of plan.inactive) console.log(`[poll] License "${l.name}": ${l.state.phase} — its syncing is paused until it is active.`);
    for (const l of plan.quiet) {
      const date = syncPolicy.localParts(l.timezone, now).date;
      if (quietLogged.get(l.id) !== date) {
        console.log(`[poll] License "${l.name}": outside polling hours (6 AM–6 PM ${l.timezone}) — paused until 6 AM. ACC webhooks still apply.`);
        quietLogged.set(l.id, date);
      }
    }
    for (const l of plan.resumed) console.log(`[poll] License "${l.name}": syncing again after a pause since ${l.paused_since.toISOString()}.`);

    // A license that was paused catches up first (this tick is a normal cycle for it,
    // with the catch-up before the push); a full check that was due for it waits for
    // the next tick.
    const resumedIds = new Set(_ids(plan.resumed));
    const catchUpSince = new Map(plan.resumed.map((l) => [l.id, l.paused_since]));
    const fullNow = plan.full.filter((l) => !resumedIds.has(l.id));
    const normalNow = [...plan.normal, ...plan.full.filter((l) => resumedIds.has(l.id))];
    if (fullNow.length) {
      console.log(`[poll] Daily full check for ${fullNow.map((l) => `"${l.name}"`).join(', ')} — re-checking every linked issue.`);
      await pollAllProjects({ full: true, licenseIds: _ids(fullNow) });
      for (const l of fullNow) await syncPolicy.markFullCheckDone(l.id, syncPolicy.localParts(l.timezone, now).date);
    }
    // A project with no license yet (legacy data awaiting npm run tenancy:repair)
    // keeps the older app-wide rules: SYNC_TIMEZONE working hours, the old switch.
    const legacy = _localNow();
    const legacyRuns = !(await appSettings.isSyncPaused()) && legacy.hour >= ACTIVE_START_HOUR && legacy.hour < ACTIVE_END_HOUR;
    let incomplete = new Set();
    if (normalNow.length || legacyRuns) {
      ({ incompleteLicenseIds: incomplete } = await pollAllProjects({ full: false, licenseIds: _ids(normalNow), includeLegacy: legacyRuns, catchUpSince }));
    }
    // Done catching up -> clear. One that couldn't finish is tried again next tick (up to
    // CATCH_UP_ATTEMPTS times, so a permanent problem can't repeat for ever).
    const finished = [];
    for (const l of plan.resumed) {
      const tries = (catchUpTries.get(l.id) || 0) + 1;
      if (incomplete.has(l.id) && tries < CATCH_UP_ATTEMPTS) {
        catchUpTries.set(l.id, tries);
        console.warn(`[poll] License "${l.name}": the catch-up was incomplete (try ${tries} of ${CATCH_UP_ATTEMPTS}) — trying again next cycle.`);
      } else {
        if (incomplete.has(l.id)) console.warn(`[poll] License "${l.name}": giving up on the catch-up after ${CATCH_UP_ATTEMPTS} tries — see the Activity Log.`);
        catchUpTries.delete(l.id);
        finished.push(l.id);
      }
    }
    await syncPolicy.clearPaused(finished);
  } catch (err) {
    console.error('[poll] Cycle failed:', err.message);
  } finally {
    cycleRunning = false;
  }
}

/**
 * Re-syncs the linked issues of the paired, active projects of `licenseIds`
 * (and, with includeLegacy, of projects that have no license yet). Passing no
 * options covers every license that may sync — the old behaviour.
 */
async function pollAllProjects({ full = false, licenseIds = null, includeLegacy = true, catchUpSince = null } = {}) {
  const incompleteLicenseIds = new Set(); // licenses whose catch-up should be tried again next tick
  // Unpaired projects (created on License Administration, not yet paired
  // on Project Setup) have nothing to sync; archived ones are parked.
  const { rows: allProjects } = await pool.query(
    'SELECT * FROM projects WHERE owner_user_id IS NOT NULL AND revizto_project_uuid IS NOT NULL AND acc_project_id IS NOT NULL AND archived_at IS NULL AND sync_active'
  );
  // Projects of a license that isn't active (expired, suspended, over its slot
  // limit, not started) are paused until it is. A project with no license yet
  // (legacy, see npm run tenancy:repair) still syncs.
  const syncing = await licenseState.syncingLicenseIds();
  const wanted = licenseIds ? new Set(licenseIds) : null;
  const projects = allProjects.filter((p) =>
    p.tenant_license_id ? syncing.has(p.tenant_license_id) && (!wanted || wanted.has(p.tenant_license_id)) : includeLegacy
  );
  for (const project of projects) {
    try {
      // One bulk look at both sides for every linked issue, shared by the
      // push and both ACC polls below, which each skip issues that
      // haven't changed since their last check (unless full).
      const snapshot = await syncService.prefetchLinkedIssues(project.owner_user_id, project);
      // The license was paused until just now: bring across what was changed in ACC
      // meanwhile (the newer side wins) BEFORE the normal push, so an older Revizto
      // state can't overwrite it.
      const since = catchUpSince?.get(project.tenant_license_id);
      if (since) {
        const { rows: ownerForCatchUp } = await pool.query('SELECT email FROM users WHERE id = $1', [project.owner_user_id]);
        const caught = await syncService.reconcileAfterPause(project.owner_user_id, project, { snapshot, since, reporterEmail: ownerForCatchUp[0]?.email });
        console.log(
          `[poll] "${project.name}": catch-up after the pause — ${caught.pulled} change(s) brought across from ACC, ${caught.reviztoWins} kept from Revizto, ${caught.errors} error(s).`
        );
        if (caught.incomplete) incompleteLicenseIds.add(project.tenant_license_id);
      }
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
      // A project that couldn't be read at all hasn't been caught up either.
      if (catchUpSince?.has(project.tenant_license_id)) incompleteLicenseIds.add(project.tenant_license_id);
    }
  }
  return { incompleteLicenseIds };
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

  // Around the clock, like ACC's webhooks themselves: re-registers or
  // re-activates any project's ACC hook ACC has dropped (webhookHealth).
  // Also once a minute after start, so a deploy repairs one right away.
  const webhookCheckSchedule = process.env.WEBHOOK_CHECK_CRON || '17 * * * *'; // hourly by default
  console.log(`[poll] ACC webhook health check enabled: ${webhookCheckSchedule}`);
  const checkWebhooks = () => webhookHealth.checkAllProjects().catch((err) => console.error('[webhook-health] Check failed:', err.message));
  cron.schedule(webhookCheckSchedule, checkWebhooks);
  setTimeout(checkWebhooks, 60 * 1000);
}

module.exports = { startPolling, pollTick, pollAllProjects, keepAccConnectionsAlive, keepReviztoConnectionsAlive };
