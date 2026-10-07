// Multi-license regression test — see tests/multi-license/README.md
// Chunk 3c test: the catch-up after a pause. In-process, throwaway schema, no network.
const REPO = require('path').resolve(__dirname, '../..');
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
process.env.POLL_ENABLED = 'false';
const fs = require('fs');
const pg = require('pg');
const SCHEMA = 'tst_c3c';
const BASELINE = process.env.BASELINE || '9c5afd0'; // the version live on Render; set BASELINE=<commit> to compare against another
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query(`SET search_path TO ${SCHEMA}`)); } }; }

const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    const owner = (await q("INSERT INTO users(email, role) VALUES ('owner@x.com','primary_license_admin') RETURNING id"))[0].id;
    await db.query(schemaSql); // backfill: company, license
    const lic = (await q('SELECT id, tenant_id FROM tenant_licenses'))[0];
    await q("UPDATE tenant_licenses SET settings_copied_at = now()");
    const proj = (await q(
      `INSERT INTO projects(name, revizto_project_uuid, acc_hub_id, acc_project_id, owner_user_id, tenant_id, tenant_license_id)
       VALUES ('PX','rv','hub','b.acc',$1,$2,$3) RETURNING id`, [owner, lic.tenant_id, lic.id]))[0];
    const project = (await q('SELECT * FROM projects WHERE id = $1', [proj.id]))[0];

    const syncService = require(REPO + '/src/services/syncService');
    const auditLog = require(REPO + '/src/services/auditLog');
    const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

    // ── 1. reconcileAfterPause itself (real code, the ACC->Revizto update stubbed)
    ok('1. (setup) the activity log accepts the catch_up action', auditLog.ACTIONS.includes('catch_up'));
    const SINCE = new Date('2026-10-02T12:00:00Z');
    const mkIssue = (n, { markerU = 'M1', markerC = 'C1', rvU = 'M1', rvC = 'C1', accAt = '2026-10-02T09:00:00.000Z' } = {}) => ({
      row: { revizto_issue_id: String(n), acc_issue_id: 'acc-' + n, last_seen_revizto_updated: markerU, last_seen_revizto_commented: markerC },
      rv: { id: n, updated: rvU, commented: rvC },
      acc: { id: 'acc-' + n, updatedAt: accAt, assignedTo: 'user-' + n, watchers: ['w' + n] },
    });
    const snapOf = (issues, accNull = false) => ({
      links: issues.map((i) => i.row),
      reviztoById: new Map(issues.filter((i) => i.rv).map((i) => [String(i.rv.id), i.rv])),
      accById: accNull ? null : new Map(issues.filter((i) => i.acc).map((i) => [i.acc.id, i.acc])),
    });
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) await q("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id, last_seen_revizto_updated, last_seen_revizto_commented) VALUES ($1,$2,$3,'M1','C1') ON CONFLICT DO NOTHING", [proj.id, String(n), 'acc-' + n]);
    const run = async (issues, opts = {}) => {
      const calls = [];
      const summary = await quiet(() => syncService.reconcileAfterPause(owner, project, { snapshot: snapOf(issues, opts.accNull), since: SINCE, reporterEmail: 'owner@x.com', pull: opts.pull || (async (u, p, payload) => { calls.push(payload); }) }));
      return { summary, calls };
    };
    const marker = async (n) => (await q('SELECT last_seen_revizto_updated AS u, last_seen_revizto_commented AS c FROM sync_map WHERE project_id=$1 AND revizto_issue_id=$2', [proj.id, String(n)]))[0];
    const catchUpRows = async () => (await q("SELECT revizto_issue_id, direction, detail FROM audit_log WHERE action='catch_up' ORDER BY id"));

    let r = await run([mkIssue(1)]);
    ok('1. nothing changed since the pause -> nothing is brought across', r.calls.length === 0 && r.summary.unchanged === 1 && !r.summary.incomplete);
    r = await run([mkIssue(2, { accAt: '2026-10-02T12:30:00.000Z' })]);
    ok('1. changed only in ACC since the pause -> brought across with the same payload a live webhook carries', r.calls.length === 1 && JSON.stringify(r.calls[0]) === JSON.stringify({ id: 'acc-2', assignedTo: 'user-2', watchers: ['w2'] }) && r.summary.pulled === 1);
    ok("1. ...and Revizto's markers are left alone (nothing to suppress)", (await marker(2)).u === 'M1');
    r = await run([mkIssue(3, { accAt: '2026-10-02T11:00:00.000Z' })]);
    ok('1. changed in ACC an hour BEFORE the pause -> not touched (it had already synced)', r.calls.length === 0);
    r = await run([mkIssue(4, { accAt: '2026-10-02T11:58:00.000Z' })]);
    ok("1. changed in ACC 2 minutes before the recorded start (inside the 3-minute margin) -> brought across", r.calls.length === 1);
    r = await run([mkIssue(5, { rvU: 'M2', accAt: '2026-10-02T09:00:00.000Z' })]);
    ok("1. changed only in Revizto -> nothing here (the normal push sends it)", r.calls.length === 0 && r.summary.unchanged === 1);

    // both changed
    r = await run([mkIssue(6, { rvU: '2026-10-02 12:10:00', rvC: 'C9', accAt: '2026-10-02T12:20:00.000Z' })]);
    ok('1. both changed, ACC is newer -> ACC is brought across', r.calls.length === 1 && r.summary.pulled === 1);
    const m6 = await marker(6);
    ok("1. ...and Revizto's markers are brought up to date, so this tick's push of the older Revizto state is skipped", m6.u === '2026-10-02 12:10:00' && m6.c === 'C9');
    r = await run([mkIssue(7, { rvU: '2026-10-02 12:40:00', accAt: '2026-10-02T12:20:00.000Z' })]);
    ok("1. both changed, Revizto is newer -> nothing brought across, markers untouched (the push will send Revizto's version)", r.calls.length === 0 && r.summary.reviztoWins === 1 && (await marker(7)).u === 'M1');
    r = await run([mkIssue(8, { rvU: 'not-a-time', accAt: '2026-10-02T12:20:00.000Z' })]);
    ok("1. both changed and Revizto's time can't be read -> Revizto wins (the safe, current behaviour)", r.calls.length === 0 && r.summary.reviztoWins === 1);
    // timezone reading: Revizto's "YYYY-MM-DD HH:MM:SS" is UTC
    r = await run([mkIssue(9, { rvU: '2026-10-02 13:00:00', accAt: '2026-10-02T13:00:30.000Z' })]);
    const r10 = await run([mkIssue(10, { rvU: '2026-10-02 13:00:00', accAt: '2026-10-02T12:59:30.000Z' })]);
    ok("1. a 30-second difference is decided correctly both ways (Revizto's clock read as UTC)", r.calls.length === 1 && r10.calls.length === 0);

    const rows = await catchUpRows();
    ok('1. the Activity Log records the conflicts (ACC newer / Revizto newer) and the plain changes', rows.some((x) => /ACC's version is newer/.test(x.detail)) && rows.some((x) => /Revizto's version is newer/.test(x.detail)) && rows.some((x) => /Changed in ACC while syncing was paused/.test(x.detail)));
    r = await run([{ row: mkIssue(11).row, rv: null, acc: mkIssue(11).acc }, { row: mkIssue(12).row, rv: mkIssue(12).rv, acc: null }]);
    ok("1. an issue missing on either side is skipped (the normal cycle's existence check handles it)", r.summary.skipped === 2 && r.calls.length === 0);
    let seen = [];
    r = await run([mkIssue(1, { accAt: '2026-10-02T12:30:00.000Z' }), mkIssue(2, { accAt: '2026-10-02T12:31:00.000Z' }), mkIssue(3, { accAt: '2026-10-02T12:32:00.000Z' })], {
      pull: async (u, p, payload) => { seen.push(payload.id); if (payload.id === 'acc-2') throw new Error('boom'); },
    });
    ok('1. one issue failing does not stop the others; the catch-up is flagged to retry', seen.join() === 'acc-1,acc-2,acc-3' && r.summary.pulled === 2 && r.summary.errors === 1 && r.summary.incomplete === true);
    ok('1. ...and the failure is on the Activity Log', (await q("SELECT 1 FROM audit_log WHERE action='error' AND acc_issue_id='acc-2' AND detail LIKE '%while syncing was paused%'")).length === 1);
    r = await run([mkIssue(1, { accAt: '2026-10-02T12:30:00.000Z' })], { accNull: true });
    ok("1. if the ACC issues couldn't be read at all, nothing is touched and it is retried", r.calls.length === 0 && r.summary.incomplete === true);

    // ── 2. pollTick: when the catch-up runs
    const pollService = require(REPO + '/src/services/pollService');
    const syncPolicy = require(REPO + '/src/services/syncPolicy');
    const order = [];
    let reconcileResult = { pulled: 0, reviztoWins: 0, errors: 0, incomplete: false };
    let prefetchThrows = false;
    syncService.prefetchLinkedIssues = async (uid, p) => { if (prefetchThrows) throw new Error('read failed'); order.push('prefetch:' + p.name); return { links: [], reviztoById: new Map(), accById: new Map() }; };
    syncService.reconcileAfterPause = async (uid, p, { since }) => { order.push('reconcile:' + p.name + ':' + (since instanceof Date)); return reconcileResult; };
    syncService.pushLinkedIssues = async (uid, p, { full }) => { order.push('push:' + p.name + (full ? ':full' : '')); return []; };
    syncService.autoLinkMatchingIssues = async () => [];
    syncService.pollAccCommentsForProject = async () => {};
    syncService.pollAccAttachmentsForProject = async () => {};
    const tick = async () => { order.length = 0; await quiet(() => pollService.pollTick()); return order.join(' | '); };
    const lic1 = async () => (await q('SELECT paused_since, last_full_check_date::text AS lf FROM tenant_licenses WHERE id = $1', [lic.id]))[0];
    const zones = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Pago_Pago', 'Africa/Cairo', 'Asia/Dubai', 'Atlantic/Azores'];
    const zNormal = zones.find((z) => { const h = syncPolicy.localParts(z).hour; return h >= 7 && h <= 16; });
    const zFull = zones.find((z) => syncPolicy.localParts(z).hour >= 18);
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [lic.tenant_id, zNormal]);
    await q('UPDATE tenant_licenses SET sync_paused = false, poll_247 = false, last_full_check_date = NULL, paused_since = NULL');

    ok('2. a license that was never paused: no catch-up, just the normal cycle', (await tick()) === 'prefetch:PX | push:PX');
    await q('UPDATE tenant_licenses SET sync_paused = true');
    await tick();
    ok('2. paused: nothing syncs and the start of the pause is recorded', (await lic1()).paused_since !== null && (await tick()) === '');
    const stamped = (await lic1()).paused_since;
    await q('UPDATE tenant_licenses SET sync_paused = false');
    const t1 = await tick();
    ok('2. on resume the catch-up runs FIRST (before the push), with the pause start, then the normal cycle', t1 === 'prefetch:PX | reconcile:PX:true | push:PX', t1);
    ok('2. ...and the pause marker is cleared once it is done', (await lic1()).paused_since === null);
    ok('2. next tick: back to the normal cycle, no second catch-up', (await tick()) === 'prefetch:PX | push:PX');

    // full check due at the moment of resuming
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [lic.tenant_id, zFull]);
    await q('UPDATE tenant_licenses SET sync_paused = true, paused_since = now() - interval \'1 hour\', last_full_check_date = NULL');
    await q('UPDATE tenant_licenses SET sync_paused = false');
    const t2 = await tick();
    ok('2. resuming when the daily full check is also due: this tick is a catch-up + NORMAL cycle (never a full push over fresh ACC edits)', t2 === 'prefetch:PX | reconcile:PX:true | push:PX', t2);
    ok("2. ...and the full check is NOT marked done, so it still runs next tick", (await lic1()).lf === null);
    const t3 = await tick();
    ok('2. the next tick does the full check', t3 === 'prefetch:PX | push:PX:full' && (await lic1()).lf === syncPolicy.localParts(zFull).date, t3);

    // incomplete catch-up is retried, then given up
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [lic.tenant_id, zNormal]);
    await q('UPDATE tenant_licenses SET sync_paused = true, last_full_check_date = NULL');
    await tick();
    await q('UPDATE tenant_licenses SET sync_paused = false');
    reconcileResult = { pulled: 0, reviztoWins: 0, errors: 1, incomplete: true };
    await tick();
    ok('2. an incomplete catch-up keeps the pause marker so it is tried again', (await lic1()).paused_since !== null);
    const t4 = await tick();
    ok('2. ...and is tried again next tick', t4.includes('reconcile:PX'));
    await tick();
    ok('2. after 3 incomplete tries it gives up and clears the marker (a permanent problem cannot repeat for ever)', (await lic1()).paused_since === null);
    reconcileResult = { pulled: 0, reviztoWins: 0, errors: 0, incomplete: false };

    // a project that can't be read counts as not caught up
    await q('UPDATE tenant_licenses SET sync_paused = true');
    await tick();
    await q('UPDATE tenant_licenses SET sync_paused = false');
    prefetchThrows = true;
    await tick();
    ok("2. a project whose issues can't be read is not marked caught up (the marker stays)", (await lic1()).paused_since !== null);
    prefetchThrows = false;
    await tick();
    ok('2. ...and once it can be read the catch-up completes and the marker clears', (await lic1()).paused_since === null);

    // platform pause
    const platform = require(REPO + '/src/db/platformSync');
    await quiet(() => platform.main(['pause']));
    await tick();
    await quiet(() => platform.main(['resume']));
    const t5 = await tick();
    ok("2. after the operator's platform pause the license catches up too", t5 === 'prefetch:PX | reconcile:PX:true | push:PX' && (await lic1()).paused_since === null, t5);

    // a second license that was never paused is not caught up
    const t2id = (await q("INSERT INTO tenants(name, timezone) VALUES ('B', $1) RETURNING id", [zNormal]))[0].id;
    const lB = (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at) VALUES ($1,'B lic',3,'2020-01-01','2030-01-01', now()) RETURNING id", [t2id]))[0].id;
    await q("INSERT INTO projects(name, revizto_project_uuid, acc_hub_id, acc_project_id, owner_user_id, tenant_id, tenant_license_id) VALUES ('PB','rvb','hub','b.accb',$1,$2,$3)", [owner, t2id, lB]);
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [lic.tenant_id, zNormal]);
    await q('UPDATE tenant_licenses SET sync_paused = true WHERE id = $1', [lic.id]);
    await tick();
    await q('UPDATE tenant_licenses SET sync_paused = false WHERE id = $1', [lic.id]);
    const t6 = await tick();
    ok("2. only the license that was paused catches up (the other one just syncs)", t6.includes('reconcile:PX:true') && !t6.includes('reconcile:PB') && t6.includes('push:PB'), t6);
  } catch (err) {
    console.error('TEST ERROR', err);
    results.push(['harness', false]);
  } finally {
    await db.query('SET search_path TO public').catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await db.end().catch(() => {});
    const failed = results.filter(([, p]) => !p);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
