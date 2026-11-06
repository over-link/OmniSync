/**
 * services/syncTiming.js
 * How long the background sync takes — so that "is syncing getting too slow?" is answered with numbers,
 * not guesses. Every poll cycle logs, tagged [poll-timing] (search the Render logs for that):
 *   - one line per project: total time and where it went (reading both sides, pushing changes,
 *     auto-link, comments, attachments), how many issues are linked and how many actually changed;
 *   - one line per cycle: how long it took, how many projects, the slowest one, and how much of the
 *     2-minute tick it used;
 *   - a WARNING when a threshold is crossed (the signals for "time to build the worker service"):
 *       cycle  > 90 s       (it leaves little room before the next tick; past 120 s ticks are skipped)
 *       project > 60 s      (one project that slow will hold up everything behind it)
 *       full check > 15 min (the daily re-check of every linked issue blocks other syncing meanwhile)
 *       a skipped tick      (the previous cycle was still running)
 * The last cycles are also kept in memory (getStats) for the operator console / a quick look; they
 * reset when the service restarts. Thresholds can be changed with POLL_WARN_CYCLE_SECONDS,
 * POLL_WARN_PROJECT_SECONDS, POLL_WARN_FULL_MINUTES and POLL_TICK_SECONDS. Nothing here changes what the
 * sync does; a failure in this file must never break a sync (callers wrap it).
 */
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

const limits = () => ({
  tickMs: num(process.env.POLL_TICK_SECONDS, 120) * 1000,
  cycleWarnMs: num(process.env.POLL_WARN_CYCLE_SECONDS, 90) * 1000,
  projectWarnMs: num(process.env.POLL_WARN_PROJECT_SECONDS, 60) * 1000,
  fullWarnMs: num(process.env.POLL_WARN_FULL_MINUTES, 15) * 60 * 1000,
});

const MAX_KEPT = 100;
const recent = []; // newest last
let ticksSkipped = 0;
let lastSkippedAt = null;

/** "850 ms" / "7.3s" / "2m 05s" / "1h 02m". */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Measures named stages: sw.stage('read') ... sw.stage('push') — each call closes the previous stage. */
function stopwatch(now = Date.now) {
  const startedAt = now();
  let last = startedAt;
  const stages = {};
  return {
    /** Time since the previous mark is added to `name`. */
    stage(name) {
      const t = now();
      stages[name] = (stages[name] || 0) + (t - last);
      last = t;
    },
    total: () => now() - startedAt,
    stages: () => ({ ...stages }),
  };
}

/** One project's log line, plus whether it was slow. */
function projectLine(name, { totalMs, stages, linked, changed, failed = false, full = false }) {
  const slow = totalMs > limits().projectWarnMs;
  const parts = Object.entries(stages)
    .filter(([, ms]) => ms >= 50)
    .map(([k, ms]) => `${k} ${formatDuration(ms)}`);
  const line =
    `[poll-timing] "${name}": ${formatDuration(totalMs)}${failed ? ' (failed)' : ''}${full ? ' (full check)' : ''}` +
    `${parts.length ? ` — ${parts.join(', ')}` : ''} (${linked} linked, ${changed} changed)${slow ? ' — SLOW' : ''}`;
  return { line, slow };
}

/** The end-of-cycle summary: a line, and any warnings. Pure (no logging), so it can be tested. */
function cycleSummary({ full, totalMs, projects }) {
  const lim = limits();
  const slowest = projects.reduce((a, p) => (!a || p.totalMs > a.totalMs ? p : a), null);
  const pct = Math.round((totalMs / lim.tickMs) * 100);
  const average = projects.length ? projects.reduce((s, p) => s + p.totalMs, 0) / projects.length : 0;
  const line =
    `[poll-timing] ${full ? 'Full check' : 'Cycle'} finished in ${formatDuration(totalMs)}: ${projects.length} project(s)` +
    `${slowest ? `, slowest "${slowest.name}" ${formatDuration(slowest.totalMs)}, average ${formatDuration(average)}` : ''}` +
    `${full ? '' : ` — uses ${pct}% of the ${formatDuration(lim.tickMs)} tick`}`;
  const warnings = [];
  if (!full && totalMs > lim.cycleWarnMs) {
    warnings.push(
      `[poll-timing] WARNING: this cycle took ${formatDuration(totalMs)} (${pct}% of the tick). ` +
        (totalMs >= lim.tickMs
          ? 'It outlasted the tick, so the next tick is skipped and every project waits longer: time to build the worker service.'
          : 'Little room is left before ticks start being skipped: plan the worker service.')
    );
  }
  if (full && totalMs > lim.fullWarnMs) {
    warnings.push(`[poll-timing] WARNING: the daily full check took ${formatDuration(totalMs)}. Other syncing waits while it runs: plan the worker service, or a gentler full check.`);
  }
  return { line, warnings, slowest, pct };
}

/** Remember a finished cycle (kept in memory, newest last). */
function recordCycle({ full, totalMs, projects }) {
  const slowest = projects.reduce((a, p) => (!a || p.totalMs > a.totalMs ? p : a), null);
  recent.push({ at: new Date().toISOString(), full: !!full, ms: Math.round(totalMs), projects: projects.length, slowestProject: slowest?.name || null, slowestMs: slowest ? Math.round(slowest.totalMs) : 0, failed: projects.filter((p) => p.failed).length });
  while (recent.length > MAX_KEPT) recent.shift();
}

/** A tick that did not run because the previous cycle was still going. */
function recordSkippedTick() {
  ticksSkipped++;
  lastSkippedAt = new Date().toISOString();
  return ticksSkipped;
}

/** For the operator console: the thresholds, what the recent cycles looked like and how many ticks were skipped. */
function getStats() {
  const lim = limits();
  const normal = recent.filter((c) => !c.full);
  const last = normal[normal.length - 1] || null;
  const longest = normal.reduce((m, c) => Math.max(m, c.ms), 0);
  return {
    limits: { tickSeconds: lim.tickMs / 1000, cycleWarnSeconds: lim.cycleWarnMs / 1000, projectWarnSeconds: lim.projectWarnMs / 1000, fullWarnMinutes: lim.fullWarnMs / 60000 },
    ticksSkipped,
    lastTickSkippedAt: lastSkippedAt,
    lastCycle: last,
    longestRecentCycleMs: longest,
    longestRecentCyclePercentOfTick: lim.tickMs ? Math.round((longest / lim.tickMs) * 100) : 0,
    recent: recent.slice(-20),
  };
}

/** For tests. */
function reset() {
  recent.length = 0;
  ticksSkipped = 0;
  lastSkippedAt = null;
}

module.exports = { formatDuration, stopwatch, projectLine, cycleSummary, recordCycle, recordSkippedTick, getStats, reset };
