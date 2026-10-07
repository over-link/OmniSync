// Multi-license regression test — see tests/multi-license/README.md
// Issues-page speed-up test: in-process, throwaway schema, all Revizto/ACC HTTP faked (nothing leaves the machine).
//   1. fetchAllPages (services/pagedFetch.js): page order, concurrency cap, single page, errors.
//   2. reviztoService.getIssues / accService.getIssues read their pages in parallel and return the SAME list as before.
//   3. The board + stats share one read of each full list (services/issueReadCache.js); a link change, a new pairing, a
//      different person, a failure or 30 s of age each force a fresh read.
//   4. The per-issue "missing since" clean-up is one query, however many issues; the board still comes out right.
const REPO = require('path').resolve(__dirname, '../..');
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
process.env.POLL_ENABLED = 'false';
const fs = require('fs');
const pg = require('pg');
const SCHEMA = 'tst_perf';
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query(`SET search_path TO ${SCHEMA}`)); } }; }

const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  try {
    // ── 1. fetchAllPages, pure
    const { fetchAllPages } = require(REPO + '/src/services/pagedFetch');
    let inflight = 0, maxInflight = 0, calls = [];
    const mkPaged = (total, { failAt = -1, delay = () => 5 } = {}) => async (i) => {
      calls.push(i); inflight++; maxInflight = Math.max(maxInflight, inflight);
      await wait(delay(i));
      inflight--;
      if (i === failAt) throw new Error('boom ' + i);
      return { items: [`p${i}a`, `p${i}b`], totalPages: total };
    };
    let out = await fetchAllPages(mkPaged(10, { delay: (i) => (i % 3 === 0 ? 30 : 3) }));
    ok('1. ten pages come back complete and in page order, whatever order they finish in', out.length === 20 && out.every((v, k) => v === `p${Math.floor(k / 2)}${k % 2 ? 'b' : 'a'}`), out.join());
    ok('1. at most 4 pages are in flight at once (and more than 1: it is parallel)', maxInflight <= 4 && maxInflight > 1, `max ${maxInflight}`);
    calls = []; out = await fetchAllPages(mkPaged(1));
    ok('1. a one-page list costs exactly one request', calls.length === 1 && out.length === 2);
    for (const t of [0, undefined, null]) { calls = []; await fetchAllPages(mkPaged(t)); if (calls.length !== 1) ok(`1. totalPages ${t} reads one page`, false, String(calls)); }
    ok('1. an empty or unknown page count reads just the first page', true);
    let err = null; try { await fetchAllPages(mkPaged(6, { failAt: 3 })); } catch (e) { err = e; }
    ok('1. a failing page makes the whole read fail (never a silently short list)', err && /boom 3/.test(err.message));
    err = null; try { await fetchAllPages(mkPaged(6, { failAt: 0 })); } catch (e) { err = e; }
    ok('1. a failing first page fails too', err && /boom 0/.test(err.message));

    // ── setup: schema, a user with valid tokens, a project, fake HTTP
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    const owner = (await q("INSERT INTO users(email, role, name) VALUES ('owner@x.com','primary_license_admin','Owner') RETURNING id"))[0].id;
    const other = (await q("INSERT INTO users(email, role, name) VALUES ('other@x.com','license_admin','Other') RETURNING id"))[0].id;
    await db.query(schemaSql);
    const lic = (await q('SELECT id, tenant_id FROM tenant_licenses'))[0];
    const exp = new Date(Date.now() + 3600e3);
    for (const u of [owner, other]) {
      await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [u, 'a', 'b', exp]);
      await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [u, exp]);
    }
    const proj = (await q(
      `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, tenant_id, tenant_license_id)
       VALUES ('PX','rv','virginia','hub','b.acc',$1,$2,$3) RETURNING id`, [owner, lic.tenant_id, lic.id]))[0].id;
    const project = () => q('SELECT * FROM projects WHERE id = $1', [proj]).then((r) => r[0]);

    const RV_TOTAL = 650, ACC_TOTAL = 640; // 7 pages and 7 pages of 100
    const stat = { rv: 0, acc: 0, rvInflight: 0, rvMax: 0, accInflight: 0, accMax: 0, accFail: false, accNoPaging: false };
    const axios = require('axios');
    axios.defaults.adapter = async (config) => {
      const url = String(config.url || '');
      const reply = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
      const fail = (status) => { const e = new Error('fake ' + status); e.config = config; e.response = { status, data: { message: 'x' }, headers: {}, config }; throw e; };
      if (config.method === 'post' && /\/project\/rv\/issue-filter\/filter$/.test(url)) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        stat.rv++; stat.rvInflight++; stat.rvMax = Math.max(stat.rvMax, stat.rvInflight);
        await wait(15);
        stat.rvInflight--;
        const from = body.page * 100;
        const data = [];
        for (let n = from; n < Math.min(from + 100, RV_TOTAL); n++) data.push({ id: n + 1, title: `Issue ${n + 1}`, status: 'Open' });
        return reply({ result: 0, data: { data, pages: Math.ceil(RV_TOTAL / 100) } });
      }
      if (config.method === 'get' && /\/construction\/issues\/v1\/projects\/acc\/issues$/.test(url)) {
        const p = config.params || {};
        stat.acc++; stat.accInflight++; stat.accMax = Math.max(stat.accMax, stat.accInflight);
        await wait(15);
        stat.accInflight--;
        if (stat.accFail) fail(500);
        const off = Number(p.offset || 0), lim = Number(p.limit || 100);
        const results = [];
        for (let n = off; n < Math.min(off + lim, ACC_TOTAL); n++) results.push({ id: 'acc-' + (n + 1), displayId: n + 1, title: 'ACC ' + (n + 1), status: 'open', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1' });
        return reply({ results, pagination: { totalResults: ACC_TOTAL, limit: lim, offset: off } });
      }
      return fail(404);
    };

    // ── 2. the real getIssues readers
    const reviztoService = require(REPO + '/src/services/reviztoService');
    const accService = require(REPO + '/src/services/accService');
    let rvIssues = await reviztoService.getIssues(owner, 'virginia', 'rv');
    ok('2. Revizto: all 650 issues, in order, from 7 requests', rvIssues.length === 650 && rvIssues.every((x, i) => x.id === i + 1) && stat.rv === 7, `${rvIssues.length} / ${stat.rv} requests`);
    ok('2. Revizto: pages overlapped (parallel) but never more than 4 at once', stat.rvMax > 1 && stat.rvMax <= 4, `max ${stat.rvMax}`);
    let accIssues = await accService.getIssues(owner, await project());
    ok('2. ACC: all 640 issues, in order, from 7 requests', accIssues.length === 640 && accIssues.every((x, i) => x.id === 'acc-' + (i + 1)) && stat.acc === 7, `${accIssues.length} / ${stat.acc} requests`);
    ok('2. ACC: pages overlapped but never more than 4 at once', stat.accMax > 1 && stat.accMax <= 4, `max ${stat.accMax}`);

    // ── 3. the shared read cache, through the real board and stats
    const syncService = require(REPO + '/src/services/syncService');
    const issueReadCache = require(REPO + '/src/services/issueReadCache');
    // link issues 1..60 to ACC issues 1..60, and 61..63 to ACC issues that are not in ACC's list at all
    for (let n = 1; n <= 60; n++) await q("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id, acc_issue_missing_since) VALUES ($1,$2,$3, now() - interval '1 minute')", [proj, String(n), 'acc-' + n]);
    const counts = () => ({ rv: stat.rv, acc: stat.acc });
    const reset = () => { stat.rv = 0; stat.acc = 0; };
    reset(); issueReadCache.invalidate(proj);
    const [board, stats] = await quiet(async () => Promise.all([syncService.getIssuesBoard(owner, await project()), syncService.getSyncStats(owner, await project())]));
    ok('3. board + stats at the same moment: each full list is read ONCE (7 + 7 requests, not 14 + 14)', stat.rv === 7 && stat.acc === 7, JSON.stringify(counts()));
    ok('3. the board is right: 650 issues, 60 linked with their ACC numbers', board.length === 650 && board.filter((b) => b.linked).length === 60 && board[4].acc?.displayId === 5 && board[4].title === 'Issue 5', JSON.stringify(board[4]));
    ok('3. the stats are right: 650 Revizto, 640 ACC, 60 synced', stats.reviztoCount === 650 && stats.accCount === 640 && stats.syncedCount === 60, JSON.stringify(stats));
    reset(); await quiet(async () => { await syncService.getIssuesBoard(owner, await project()); await syncService.getSyncStats(owner, await project()); });
    ok('3. a reload within 30 s reads nothing again', stat.rv === 0 && stat.acc === 0, JSON.stringify(counts()));
    reset(); await quiet(async () => { await syncService.getIssuesBoard(other, await project()); });
    ok("3. a different person gets their own read (what ACC shows depends on who asks)", stat.rv === 7 && stat.acc === 7, JSON.stringify(counts()));
    reset(); await syncService.recordLink(proj, '200', 'acc-200'); // a link changes
    await quiet(async () => { await syncService.getSyncStats(owner, await project()); });
    ok('3. linking an issue clears the cache: the next view reads fresh lists', stat.rv === 7 && stat.acc === 7, JSON.stringify(counts()));
    reset(); await syncService.clearLink(proj, '200');
    await quiet(async () => { await syncService.getSyncStats(owner, await project()); });
    ok('3. so does unlinking one', stat.rv === 7 && stat.acc === 7, JSON.stringify(counts()));
    reset(); await q("UPDATE projects SET acc_project_id = 'b.acc' WHERE id = $1", [proj]);
    const realNow = Date.now; Date.now = () => realNow() + 31000;
    await quiet(async () => { await syncService.getSyncStats(owner, await project()); });
    Date.now = realNow;
    ok('3. after 30 s the lists are read again', stat.rv === 7 && stat.acc === 7, JSON.stringify(counts()));
    // a failed ACC read is not kept
    issueReadCache.invalidate(proj); reset(); stat.accFail = true;
    const failedBoard = await quiet(async () => syncService.getIssuesBoard(owner, await project()));
    ok('3. when ACC fails the board still loads (every ACC side unknown, nothing wrongly unlinked)', failedBoard.length === 650 && (await q('SELECT count(*)::int n FROM sync_map WHERE project_id = $1', [proj]))[0].n === 60);
    stat.accFail = false; reset();
    const okBoard = await quiet(async () => syncService.getIssuesBoard(owner, await project()));
    ok('3. ...and the failure was not cached: the next view reads ACC again and gets it right', stat.acc === 7 && okBoard[4].acc?.displayId === 5, JSON.stringify(counts()));

    // ── 4. the per-issue clean-up is one query
    await q("UPDATE sync_map SET acc_issue_missing_since = now() - interval '1 minute' WHERE project_id = $1", [proj]);
    issueReadCache.invalidate(proj);
    const pool = require(REPO + '/src/db/pool');
    const origQuery = pool.query.bind(pool);
    let clears = 0;
    pool.query = (sql, ...rest) => { if (typeof sql === 'string' && /SET acc_issue_missing_since = NULL/.test(sql)) clears++; return origQuery(sql, ...rest); };
    const board2 = await quiet(async () => syncService.getIssuesBoard(owner, await project()));
    pool.query = origQuery;
    ok('4. clearing "missing since" for 60 linked issues takes ONE query (it was 60)', clears === 1, `${clears} queries`);
    ok('4. ...and they really are cleared', (await q('SELECT count(*)::int n FROM sync_map WHERE project_id = $1 AND acc_issue_missing_since IS NOT NULL', [proj]))[0].n === 0);
    ok('4. the board is unchanged by the batching', board2.length === 650 && board2.filter((b) => b.linked).length === 60);
    await q("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id) VALUES ($1,'300','acc-gone')", [proj]); // linked to an ACC issue that isn't in ACC's list
    issueReadCache.invalidate(proj);
    const board3 = await quiet(async () => syncService.getIssuesBoard(owner, await project()));
    const gone = board3.find((b) => b.id === 300);
    const flagged = (await q("SELECT acc_issue_missing_since FROM sync_map WHERE project_id = $1 AND revizto_issue_id = '300'", [proj]))[0];
    ok('4. an issue linked to an ACC issue missing from the list is still handled by the grace-period guard (flagged, not unlinked)', gone?.linked === true && /Not found|confirming/.test(gone.acc?.error || '') && flagged.acc_issue_missing_since, JSON.stringify([gone, flagged]));
    ok('4. the ACC numbers and link dates were still saved', (await q('SELECT count(*)::int n FROM acc_issue_numbers WHERE project_id = $1', [proj]))[0].n === 640 && (await q('SELECT count(*)::int n FROM sync_map WHERE project_id = $1 AND linked_at IS NOT NULL', [proj]))[0].n >= 60);

    const failed = results.filter(([, p]) => !p);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('TEST CRASHED', err);
    process.exitCode = 2;
  } finally {
    await db.query('SET search_path TO public').catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e) => console.error('drop failed', e.message));
    await db.end().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
