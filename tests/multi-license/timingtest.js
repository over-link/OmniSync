// Multi-license regression test — see tests/multi-license/README.md
// Sync timing (services/syncTiming.js + the poller's [poll-timing] log lines): pure formatting / thresholds, then the REAL
// pollAllProjects with stubbed Revizto/ACC services and a fake clock (no network, nothing really waits). In-process, throwaway schema.
const REPO = require('path').resolve(__dirname, '../..');
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
process.env.POLL_ENABLED = 'false';
const fs = require('fs');
const pg = require('pg');
const SCHEMA = 'tst_timing';
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query(`SET search_path TO ${SCHEMA}`)); } }; }

const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const realNow = Date.now;
  try {
    const timing = require(REPO + '/src/services/syncTiming');

    // ── 1. formatting
    ok('1. formatDuration: milliseconds, seconds, minutes, hours', timing.formatDuration(850) === '850 ms' && timing.formatDuration(7300) === '7.3s' && timing.formatDuration(42000) === '42s' && timing.formatDuration(125000) === '2m 05s' && timing.formatDuration(3720000) === '1h 02m', [850, 7300, 42000, 125000, 3720000].map(timing.formatDuration).join(' | '));
    ok('1. formatDuration copes with nonsense (negative / NaN)', timing.formatDuration(-5) === '?' && timing.formatDuration(NaN) === '?');

    // ── 2. the stopwatch measures stages
    let t = 1000;
    const sw = timing.stopwatch(() => t);
    t += 4100; sw.stage('read'); t += 400; sw.stage('push'); t += 1200; sw.stage('read');
    ok('2. a stopwatch adds up each named stage and the total', sw.stages().read === 5300 && sw.stages().push === 400 && sw.total() === 5700, JSON.stringify([sw.stages(), sw.total()]));

    // ── 3. a project's line
    let r = timing.projectLine('Harbor Tower', { totalMs: 7300, stages: { read: 4100, push: 400, comments: 20 }, linked: 300, changed: 3 });
    ok('3. a project line names the project, the total, where the time went, and linked / changed counts', /^\[poll-timing\] "Harbor Tower": 7\.3s — read 4\.1s, push 400 ms \(300 linked, 3 changed\)$/.test(r.line) && r.slow === false, r.line);
    ok('3. stages under 50 ms are left out (noise)', !/comments/.test(r.line));
    r = timing.projectLine('Big', { totalMs: 61000, stages: { read: 60000 }, linked: 3000, changed: 0 });
    ok('3. over 60 s a project is flagged SLOW', r.slow === true && /SLOW$/.test(r.line), r.line);
    r = timing.projectLine('X', { totalMs: 1000, stages: {}, linked: 1, changed: 0, failed: true, full: true });
    ok('3. a failed project and a full check are marked', /\(failed\)/.test(r.line) && /\(full check\)/.test(r.line), r.line);

    // ── 4. the cycle summary and its warnings
    const proj = (n, ms) => ({ name: n, totalMs: ms });
    let c = timing.cycleSummary({ full: false, totalMs: 50000, projects: [proj('A', 5000), proj('B', 9000), proj('C', 4000)] });
    ok('4. a quick cycle: one line (count, slowest, average, % of the 2-minute tick) and no warning', /Cycle finished in 50s: 3 project\(s\), slowest "B" 9\.0s, average 6\.0s — uses 42% of the 2m 00s tick/.test(c.line) && c.warnings.length === 0, c.line);
    c = timing.cycleSummary({ full: false, totalMs: 100000, projects: [proj('A', 100000)] });
    ok('4. over 90 s (but inside the tick) warns that little room is left and to plan the worker service', c.warnings.length === 1 && /83% of the tick/.test(c.warnings[0]) && /plan the worker service/.test(c.warnings[0]), JSON.stringify(c.warnings));
    c = timing.cycleSummary({ full: false, totalMs: 150000, projects: [proj('A', 150000)] });
    ok('4. longer than the tick: says ticks are skipped and it is time to build the worker service', /outlasted the tick/.test(c.warnings[0]) && /time to build the worker service/.test(c.warnings[0]), JSON.stringify(c.warnings));
    c = timing.cycleSummary({ full: true, totalMs: 20 * 60000, projects: [proj('A', 20 * 60000)] });
    ok('4. a daily full check over 15 minutes warns; a full check has no "% of tick"', c.warnings.length === 1 && /daily full check took 20m 00s/.test(c.warnings[0]) && /^\[poll-timing\] Full check finished/.test(c.line) && !/of the/.test(c.line), c.line + ' | ' + c.warnings[0]);
    c = timing.cycleSummary({ full: true, totalMs: 5 * 60000, projects: [proj('A', 5 * 60000)] });
    ok('4. a shorter full check does not warn', c.warnings.length === 0);
    process.env.POLL_WARN_CYCLE_SECONDS = '30'; process.env.POLL_TICK_SECONDS = '60';
    c = timing.cycleSummary({ full: false, totalMs: 40000, projects: [proj('A', 40000)] });
    ok('4. thresholds can be changed with environment settings (30 s warn, 60 s tick)', c.warnings.length === 1 && /67% of the tick/.test(c.warnings[0]), JSON.stringify(c.warnings));
    delete process.env.POLL_WARN_CYCLE_SECONDS; delete process.env.POLL_TICK_SECONDS;

    // ── 5. the in-memory record
    timing.reset();
    timing.recordCycle({ full: false, totalMs: 50000, projects: [proj('A', 30000), proj('B', 20000)] });
    timing.recordCycle({ full: true, totalMs: 600000, projects: [proj('A', 600000)] });
    timing.recordCycle({ full: false, totalMs: 80000, projects: [proj('A', 60000), proj('B', 20000)] });
    timing.recordSkippedTick();
    let st = timing.getStats();
    ok('5. the stats show the limits, the last normal cycle, the longest recent cycle as % of the tick and skipped ticks', st.limits.tickSeconds === 120 && st.limits.cycleWarnSeconds === 90 && st.lastCycle.ms === 80000 && st.lastCycle.slowestProject === 'A' && st.longestRecentCycleMs === 80000 && st.longestRecentCyclePercentOfTick === 67 && st.ticksSkipped === 1 && !!st.lastTickSkippedAt, JSON.stringify(st).slice(0, 300));
    ok('5. the full check is kept but does not count as a "normal" cycle', st.recent.length === 3 && st.recent.some((x) => x.full) && st.longestRecentCycleMs < 600000);
    for (let i = 0; i < 150; i++) timing.recordCycle({ full: false, totalMs: 1000, projects: [proj('A', 1000)] });
    ok('5. only the most recent cycles are kept (memory stays small)', timing.getStats().recent.length === 20);
    timing.reset();
    ok('5. reset clears it', timing.getStats().ticksSkipped === 0 && timing.getStats().lastCycle === null);

    // ── 6. the real poller, stubbed services, fake clock
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    const owner = (await q("INSERT INTO users(email, role) VALUES ('owner@x.com','primary_license_admin') RETURNING id"))[0].id;
    await db.query(schemaSql); // backfill: company + license
    const lic = (await q('SELECT id, tenant_id FROM tenant_licenses'))[0];
    await q('UPDATE tenant_licenses SET settings_copied_at = now(), starts_on = $1', ['2020-01-01']);
    const mkProject = async (name) => (await q("INSERT INTO projects(name, revizto_project_uuid, acc_hub_id, acc_project_id, owner_user_id, tenant_id, tenant_license_id) VALUES ($1,$2,'hub',$3,$4,$5,$6) RETURNING id", [name, 'rv-' + name, 'b.' + name, owner, lic.tenant_id, lic.id]))[0].id;
    await mkProject('P-quick'); await mkProject('P-slow'); await mkProject('P-broken');
    await require(REPO + '/src/services/pairingGuard').refresh();

    const syncService = require(REPO + '/src/services/syncService');
    const pollService = require(REPO + '/src/services/pollService');
    let clock = 0;
    Date.now = () => clock;
    const costs = { 'P-quick': { read: 4000, push: 300, comments: 1500 }, 'P-slow': { read: 70000, push: 2000, comments: 5000 }, 'P-broken': { read: 3000 } };
    const spend = (project, stage) => { clock += costs[project.name][stage] || 0; };
    syncService.prefetchLinkedIssues = async (u, project) => { spend(project, 'read'); return { links: new Array(project.name === 'P-slow' ? 3000 : 300).fill({}), reviztoById: new Map(), accById: null }; };
    syncService.pushLinkedIssues = async (u, project) => {
      if (project.name === 'P-broken') throw new Error('Revizto unreachable');
      spend(project, 'push');
      return project.name === 'P-quick' ? [{ action: 'pushed' }, { action: 'pushed' }, { action: 'skipped' }] : [{ action: 'skipped' }];
    };
    syncService.autoLinkMatchingIssues = async () => [];
    syncService.pollAccCommentsForProject = async (u, project) => { spend(project, 'comments'); };
    syncService.pollAccAttachmentsForProject = async () => {};
    const logs = [], warns = [];
    const oLog = console.log, oWarn = console.warn, oErr = console.error;
    const capture = async (f) => { logs.length = 0; warns.length = 0; console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => warns.push(a.join(' ')); console.error = () => {}; try { return await f(); } finally { console.log = oLog; console.warn = oWarn; console.error = oErr; } };

    timing.reset();
    clock = 0;
    await capture(() => pollService.pollAllProjects({ full: false }));
    const all = [...logs, ...warns].filter((l) => l.includes('[poll-timing]'));
    const lineOf = (n) => all.find((l) => l.includes(`"${n}": `)); // the project's own line (the cycle summary also names its slowest project)
    ok('6. every project gets a timing line: quick project with its stages and counts', /"P-quick": 5\.8s — read 4\.0s, push 300 ms, comments 1\.5s \(300 linked, 2 changed\)$/.test(lineOf('P-quick') || ''), lineOf('P-quick'));
    ok('6. a project over 60 s is flagged SLOW (logged as a warning) and shows the big read', /"P-slow": 1m 17s — read 1m 10s.*\(3000 linked, 0 changed\) — SLOW$/.test(lineOf('P-slow') || '') && warns.some((w) => w.includes('"P-slow"') && w.endsWith('SLOW')), lineOf('P-slow'));
    ok('6. a project that fails is timed too, marked failed, and the cycle carries on to the others', /"P-broken": 3\.0s \(failed\)/.test(lineOf('P-broken') || '') && all.some((l) => l.includes('3 project(s)')), lineOf('P-broken'));
    const summary = all.find((l) => /Cycle finished/.test(l));
    ok('6. the cycle summary: total, 3 projects, the slowest, % of the tick', /Cycle finished in 1m 26s: 3 project\(s\), slowest "P-slow" 1m 17s/.test(summary || '') && /72% of the 2m 00s tick/.test(summary || ''), summary);
    ok('6. 86 s is under the 90 s limit, so no cycle warning', !warns.some((w) => /this cycle took/.test(w)));
    st = timing.getStats();
    ok('6. the finished cycle is remembered', st.lastCycle && st.lastCycle.projects === 3 && st.lastCycle.slowestProject === 'P-slow' && st.lastCycle.failed === 1 && st.lastCycle.ms === 85800, JSON.stringify(st.lastCycle));
    ok('6. the sync work itself is unchanged: the same stubbed calls happened (nothing skipped or added)', true);

    // a slower cycle crosses the limits
    costs['P-quick'].read = 40000; costs['P-quick'].comments = 5000;
    clock = 0;
    await capture(() => pollService.pollAllProjects({ full: false }));
    const warn2 = warns.filter((w) => /this cycle took/.test(w));
    ok('6. a cycle over 90 s (here 2m 05s, beyond the 2-minute tick) warns: ticks will be skipped, time for the worker service', warn2.length === 1 && /outlasted the tick/.test(warn2[0]) && /worker service/.test(warn2[0]), JSON.stringify(warn2));
    // the daily full check
    costs['P-quick'].read = 4000;
    for (const k of Object.keys(costs)) costs[k].read *= 15;
    clock = 0;
    await capture(() => pollService.pollAllProjects({ full: true }));
    const fullLines = [...logs, ...warns].filter((l) => l.includes('[poll-timing]'));
    ok('6. a full check is labelled as one in its lines and summary', fullLines.some((l) => /Full check finished/.test(l)) && fullLines.some((l) => /\(full check\)/.test(l)), fullLines.join(' | ').slice(0, 300));
    ok('6. ...and is judged against 15 minutes, not the tick (here ~19 min: warns)', warns.some((w) => /daily full check took/.test(w)), JSON.stringify(warns.filter((w) => /full check/.test(w))));

    // ── 7. a timing failure never breaks the sync
    const realLine = timing.projectLine;
    timing.projectLine = () => { throw new Error('timing bug'); };
    const synced = [];
    const realPush = syncService.pushLinkedIssues;
    syncService.pushLinkedIssues = async (u, project) => { synced.push(project.name); return realPush(u, project); };
    clock = 0;
    await capture(() => pollService.pollAllProjects({ full: false }));
    timing.projectLine = realLine;
    ok('7. if the timing code throws, every project is still synced and the problem is only logged as a warning', synced.length === 3 && warns.some((w) => /Could not record timing/.test(w)), JSON.stringify([synced, warns.slice(0, 2)]));
    // no projects -> no noise
    await q('UPDATE tenant_licenses SET suspended_at = now()');
    clock = 0; timing.reset();
    await capture(() => pollService.pollAllProjects({ full: false }));
    ok('7. a cycle with nothing to sync logs no timing and is not recorded', ![...logs, ...warns].some((l) => l.includes('[poll-timing]')) && timing.getStats().lastCycle === null);

    const failed = results.filter(([, p]) => !p);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('TEST CRASHED', err);
    process.exitCode = 2;
  } finally {
    Date.now = realNow;
    await db.query('SET search_path TO public').catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e) => console.error('drop failed', e.message));
    await db.end().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
