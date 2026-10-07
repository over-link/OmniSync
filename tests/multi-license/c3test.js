// Multi-license regression test — see tests/multi-license/README.md
// Chunk 2 test, in a throwaway schema (never the live tables):
//  A. DIFFERENTIAL — the committed code (HEAD = what's deployed) and the new code run side by side on
//     identical single-license data; every GET must answer identically for every kind of user.
//  B. LEAK — a second license is added (own admins, members, projects); the new code must keep them apart.
const REPO = require('path').resolve(__dirname, '../..');
const SCRATCH = __dirname;
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const sign = require('cookie-signature').sign;
const pg = require('pg');
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_c3')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_c3';
const BASELINE = process.env.BASELINE || '9c5afd0'; // the version live on Render; set BASELINE=<commit> to compare against another
const SECRET = process.env.SESSION_SECRET || 'test-secret';
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAILS = ['owner@x.com', 'adm2@x.com', 'pa@x.com', 'std@x.com', 'outsider@x.com', 'adminb@x.com', 'memberb@x.com', 'dual@x.com'];

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const procs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oldcode-'));
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)');

    // ── seed single-license data, the legacy way (users.role + project_members), then run the backfill
    const mkUser = async (email, role) => (await q('INSERT INTO users(email, role, name) VALUES ($1, $2, $3) RETURNING id', [email, role, email.split('@')[0]]))[0].id;
    const U = {};
    U.owner = await mkUser('owner@x.com', 'primary_license_admin');
    U.adm2 = await mkUser('adm2@x.com', 'license_admin');
    for (const k of ['pa', 'std', 'outsider', 'adminb', 'memberb', 'dual']) U[k] = await mkUser(`${k}@x.com`, 'member');
    const mkProject = async (name, acc, archived = false) =>
      (await q(
        `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, revizto_license_uuid, archived_at)
         VALUES ($1, $2, 'virginia', 'hub', $3, $4, 'LIC-TEST', ${archived ? 'now()' : 'NULL'}) RETURNING id`,
        [name, 'rv-' + name, acc, U.owner]
      ))[0].id;
    const P = {};
    P.p1 = await mkProject('P1', 'b.acc1');
    P.p2 = await mkProject('P2', 'b.acc2');
    P.p4 = await mkProject('P4-archived', 'b.acc4', true);
    await q("INSERT INTO projects(name, owner_user_id) VALUES ('P3-unpaired', $1)", [U.owner]);
    await q("INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'project_admin'), ($1,$3,'standard')", [P.p1, U.pa, U.std]);
    const exp = new Date(Date.now() + 3600e3);
    await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [U.owner, 'a', 'b', exp]);
    await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [U.owner, exp]);
    for (const pid of [P.p1, P.p2]) await q("INSERT INTO audit_log(project_id, direction, action, outcome, detail, attributed_email) VALUES ($1,'revizto_to_acc','field_change','success','x','owner@x.com')", [pid]);
    await q("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id) VALUES ($1,'1','a1'), ($2,'2','a2')", [P.p1, P.p2]);
    await db.query(schemaSql); // the backfill: company #1, one license, memberships

    // ── start OLD (committed HEAD) and NEW servers
    execSync(`git archive ${BASELINE} src public package.json | tar -x -C "${tmp}"`, { cwd: REPO, shell: 'bash' });
    const nodePath = path.join(REPO, 'node_modules');
    const startServer = (cwd, port) => {
      const p = spawn(process.execPath, ['-r', path.join(SCRATCH, 'preload.js'), 'src/server.js'], {
        cwd,
        env: { ...process.env, PORT: String(port), NODE_PATH: nodePath, TEST_SCHEMA: SCHEMA, TEST_EMAILS: EMAILS.join(','), SESSION_SECRET: SECRET, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      p.stdout.on('data', (d) => (log += d));
      p.stderr.on('data', (d) => (log += d));
      p.getLog = () => log;
      procs.push(p);
      return p;
    };
    const oldP = startServer(tmp, 3061);
    const newP = startServer(REPO, 3062);
    for (const port of [3061, 3062]) {
      for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${port}/auth/me`); break; } catch { await wait(500); } }
    }
    await wait(500);

    // ── sessions (forged rows in the shared session table, signed cookies)
    const session = async (userId) => {
      const u = (await q('SELECT id, email, role, password_version FROM users WHERE id = $1', [userId]))[0];
      const sid = crypto.randomBytes(16).toString('hex');
      const sess = { cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: '/' }, userId: u.id, userEmail: u.email, role: u.role, signedInAt: Date.now(), passwordVersion: u.password_version };
      await q("INSERT INTO session(sid, sess, expire) VALUES ($1, $2, now() + interval '1 day')", [sid, sess]);
      return 'connect.sid=' + encodeURIComponent('s:' + sign(sid, SECRET));
    };
    const C = {}, CO = {};
    for (const k of ['owner', 'adm2', 'pa', 'std', 'outsider']) { C[k] = await session(U[k]); CO[k] = await session(U[k]); } // one session per server: a refusal ends the session
    const get = async (port, cookie, p, opts = {}) => {
      const r = await fetch(`http://localhost:${port}${p}`, { method: opts.method || 'GET', headers: { cookie, 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      let body = null; try { body = await r.json(); } catch { /* not json */ }
      return { status: r.status, body };
    };
    const norm = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));


    // ── second license B (own admin/member), as chunk 2's test
    const t2 = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Company B', $1) RETURNING id", [U.adminb]))[0].id;
    const lB = (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on) VALUES ($1,'B license', 2, '2020-01-01', '2030-01-01') RETURNING id", [t2]))[0].id;
    const lA = (await q('SELECT id FROM tenant_licenses WHERE tenant_id <> $1 LIMIT 1', [t2]))[0].id;
    await q('DELETE FROM license_members WHERE user_id = ANY($1)', [[U.adminb, U.memberb]]);
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin'), ($1,$3,'member'), ($1,$4,'member')", [lB, U.adminb, U.memberb, U.dual]);
    await q("UPDATE license_members SET role = 'license_admin' WHERE tenant_license_id = $1 AND user_id = $2", [lA, U.dual]);
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dual, lA]);
    const pb = (await q(
      `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, revizto_license_uuid, tenant_id, tenant_license_id)
       VALUES ('PB1','rv-PB1','virginia','hub','b.accb1',$1,'LIC-B',$2,$3) RETURNING id`, [U.adminb, t2, lB]))[0].id;
    await q("INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'standard'), ($1,$3,'standard')", [pb, U.memberb, U.dual]);
    await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [U.adminb, 'a', 'b', exp]);
    await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [U.adminb, exp]);
    const N = (cookie, p, o) => get(3062, cookie, p, o);
    const fresh = async (k) => { C[k] = await session(U[k]); return C[k]; };
    for (const k of ['adminb', 'memberb', 'dual']) await fresh(k);
    const names = (r) => (r.body?.projects || []).map((x) => x.name).sort().join(',');
    const EXPIRED = 'License has expired. Contact your administrator.', SUSPENDED = 'License is suspended. Contact your administrator.', NOLIC = "You don't have access to any license. Contact your administrator.";
    const reset = async () => { await q('UPDATE tenant_licenses SET slot_capacity = 5, expires_on = $2, suspended_at = NULL, starts_on = $3 WHERE id = $1', [lA, '2030-01-01', '2020-01-01']); await q("UPDATE tenant_licenses SET slot_capacity = 2, expires_on = '2030-01-01', suspended_at = NULL, starts_on = '2020-01-01' WHERE id = $1", [lB]); await q("UPDATE projects SET archived_at = NULL WHERE name IN ('P1','P2','P3-unpaired')"); await q("UPDATE projects SET archived_at = now() WHERE name LIKE 'Race%' OR name IN ('A-new','NewInA')"); };
    const me = async (k) => (await N(await fresh(k), '/auth/me')).body;
    const daysFromToday = async (n) => (await q("SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') AS d", [n]))[0].d;

    // ── 1. slots are per license
    await q('UPDATE tenant_licenses SET slot_capacity = 3 WHERE id = $1', [lA]); // A: P1, P2, P3-unpaired = 3 of 3
    const sumA = (await N(C.owner, '/api/license/projects')).body.summary, sumB = (await N(C.adminb, '/api/license/projects')).body.summary;
    ok('1. each license shows its own slots (A 3 of 3, B 1 of 2)', sumA.projectSlotCapacity === 3 && sumA.projectSlotsUsed === 3 && sumB.projectSlotCapacity === 2 && sumB.projectSlotsUsed === 1, JSON.stringify([sumA, sumB]));
    let r1 = await N(C.owner, '/api/projects', { method: 'POST', body: { name: 'A-new' } });
    ok('1. A is full: a new project is refused (409, no slots)', r1.status === 409 && /No available project slots/.test(r1.body.error));
    const rb1 = await N(C.adminb, '/api/projects', { method: 'POST', body: { name: 'B-new' } });
    ok("1. B still has a slot — A being full doesn't matter (200)", rb1.status === 200);
    const rb2 = await N(C.adminb, '/api/projects', { method: 'POST', body: { name: 'B-new2' } });
    ok('1. ...and B is then full by its own count (409)', rb2.status === 409);
    ok("1. A is unaffected by B's projects (still 3 of 3)", (await N(C.owner, '/api/license/projects')).body.summary.projectSlotsUsed === 3);
    const arch = await N(C.owner, `/api/license/projects/${(await q("SELECT id FROM projects WHERE name='P3-unpaired'"))[0].id}/archive`, { method: 'POST' });
    const r2 = await N(C.owner, '/api/projects', { method: 'POST', body: { name: 'A-new' } });
    ok('1. archiving frees a slot, so a project can then be created in A', arch.status === 200 && r2.status === 200);
    const unarch = await N(C.owner, `/api/license/projects/${(await q("SELECT id FROM projects WHERE name='P3-unpaired'"))[0].id}/unarchive`, { method: 'POST' });
    ok('1. unarchiving while full is refused (409)', unarch.status === 409);
    // concurrency: 1 slot free, 3 simultaneous creates -> exactly one wins
    await reset(); await q("UPDATE projects SET archived_at = now() WHERE name IN ('NewInA','A-new','P3-unpaired')"); await q('UPDATE tenant_licenses SET slot_capacity = 3 WHERE id = $1', [lA]); // P1,P2 used, 1 free
    const race = await Promise.all([1, 2, 3].map((n) => N(C.owner, '/api/projects', { method: 'POST', body: { name: 'Race' + n } })));
    ok('1. three simultaneous creates for the last slot: exactly one succeeds', race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 2, race.map((r) => r.status).join());

    // ── 2. expiry (company timezone), greyed for 30 days, then gone
    await reset();
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(0)]);
    ok('2. on its expiry day the license still works', (await N(await fresh('owner'), '/api/projects')).status === 200);
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(-1)]);
    const e1 = await me('owner'), e2 = await me('pa'), e3 = await me('std'), e4 = await me('adm2');
    ok('2. the day after: license admins AND members get "License has expired. Contact your administrator."', [e1, e2, e3, e4].every((m) => m.user === null && m.accessDenied === EXPIRED), JSON.stringify([e1, e2]));
    ok('2. ...while the other license is unaffected', (await N(C.adminb, '/api/projects')).status === 200 && (await N(C.memberb, '/api/projects')).status === 200);
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(-30)]);
    ok('2. 30 days after expiry it is still the expired message (greyed phase)', (await me('owner')).accessDenied === EXPIRED);
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(-31)]);
    ok("2. 31 days after: it is gone — the plain \"no access to any license\" message", (await me('owner')).accessDenied === NOLIC);
    ok('2. a person in two licenses is moved to the one that works when the other expires (dual: standard on B)', (await (async () => { await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dual, lA]); const r = await N(await fresh('dual'), '/api/projects'); return r.status === 200 && names(r) === 'PB1' && (await q('SELECT current_license_id FROM users WHERE id=$1', [U.dual]))[0].current_license_id === lB; })()));
    await reset();
    ok('2. renewing (a later expiry) brings it straight back', (await N(await fresh('owner'), '/api/projects')).status === 200 && (await N(await fresh('pa'), '/api/projects')).status === 200);
    await q('UPDATE tenant_licenses SET starts_on = $2 WHERE id = $1', [lA, await daysFromToday(2)]);
    ok('2. before its start date the license is blocked', (await me('owner')).accessDenied === 'License has not started yet. Contact your administrator.');

    // ── 3. suspended by the operator
    await reset(); await q('UPDATE tenant_licenses SET suspended_at = now() WHERE id = $1', [lA]);
    const s1 = await me('owner'), s2 = await me('std');
    ok('3. operator-suspended: everyone, license admins included, gets "License is suspended. Contact your administrator."', s1.accessDenied === SUSPENDED && s2.accessDenied === SUSPENDED);
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(-1)]);
    ok('3. expired AND suspended: the expiry message wins', (await me('owner')).accessDenied === EXPIRED);

    // ── 4. over the slot limit: suspended, but its license admins can get it back under
    await reset(); await q('UPDATE tenant_licenses SET slot_capacity = 1 WHERE id = $1', [lA]); // P1, P2, P3-unpaired = 3 > 1
    const o1 = await N(await fresh('owner'), '/auth/me');
    ok('4. over the limit: /auth/me tells a license admin the state (adminLimited) and keeps them signed in', o1.body.user && o1.body.license && o1.body.license.adminLimited === true && o1.body.license.message === SUSPENDED, JSON.stringify(o1.body).slice(0, 200));
    const lp = await N(C.owner, '/api/license/projects');
    ok('4. ...License Administration still works and carries the message', lp.status === 200 && lp.body.summary.license && lp.body.summary.license.message === SUSPENDED && lp.body.projects.length >= 3);
    ok('4. ...but everything else answers 403 with the message (projects, team, issues)', (await N(C.owner, '/api/projects')).status === 403 && (await N(C.owner, `/api/projects/${P.p1}/team`)).status === 403 && (await N(C.owner, `/api/projects/${P.p1}/issues-board`)).status === 403);
    ok('4. members (not admins) are stopped at the message', (await me('pa')).accessDenied === SUSPENDED);
    const a1 = await N(C.owner, `/api/license/projects/${(await q("SELECT id FROM projects WHERE name='P3-unpaired'"))[0].id}/archive`, { method: 'POST' });
    ok('4. archiving one project works (still 2 > 1: still suspended)', a1.status === 200 && (await N(C.owner, '/api/projects')).status === 403);
    const a2 = await N(C.owner, `/api/license/projects/${P.p2}/archive`, { method: 'POST' });
    ok('4. archiving down to the limit re-activates the license automatically', a2.status === 200 && (await N(await fresh('owner'), '/api/projects')).status === 200 && (await N(await fresh('pa'), '/api/projects')).status === 200);
    ok('4. an active license carries no extra "license" key on /auth/me (nothing changes for normal use)', !('license' in (await me('owner'))));

    // ── 5. all syncing is paused for an inactive license
    await reset();
    process.env.TEST_SYNC_PROJECTS = '1';
    const pollService = require(REPO + '/src/services/pollService');
    const syncService = require(REPO + '/src/services/syncService');
    const touched = new Set();
    const stub = (name, fn) => { syncService[name] = fn; };
    stub('prefetchLinkedIssues', async (uid, project) => { touched.add(project.name); return { links: [], reviztoById: new Map(), accById: null }; });
    stub('pushLinkedIssues', async () => []);
    stub('autoLinkMatchingIssues', async () => []);
    stub('pollAccCommentsForProject', async () => {});
    stub('pollAccAttachmentsForProject', async () => {});
    const run = async () => { touched.clear(); await require(REPO + '/src/services/pairingGuard').refresh() /* rows were inserted by SQL; the poll tick does this */; await pollService.pollAllProjects({ full: false }); return [...touched].sort().join(','); };
    ok('5. polling: both licenses active -> every paired project is visited', (await run()) === 'P1,P2,PB1', [...touched].join());
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(-1)]);
    ok("5. polling: A expired -> only B's project is visited", (await run()) === 'PB1');
    await reset(); await q('UPDATE tenant_licenses SET suspended_at = now() WHERE id = $1', [lB]);
    ok('5. polling: B suspended -> only A is visited', (await run()) === 'P1,P2');
    await reset(); await q('UPDATE tenant_licenses SET slot_capacity = 1 WHERE id = $1', [lA]);
    ok('5. polling: A over its limit -> A is paused', (await run()) === 'PB1');
    await reset(); await q('UPDATE projects SET tenant_license_id = NULL WHERE name = $1', ['P1']);
    ok('5. polling: a project with no license yet (legacy) still syncs', (await run()).includes('P1'));
    await q('UPDATE projects SET tenant_license_id = $2 WHERE name = $1', ['P1', lA]);
    await q('UPDATE tenant_licenses SET expires_on = $2 WHERE id = $1', [lA, await daysFromToday(-1)]);
    const hook = async () => { const before = newP.getLog().length; await fetch('http://localhost:3062/webhook/acc-v2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook: { scope: { project: 'acc1' } }, payload: { id: 'x' } }) }); await wait(1500); return newP.getLog().slice(before); };
    const hlog = await hook();
    ok("5. an ACC webhook for an expired license is ignored (logged, not processed)", /license isn't active — ignoring this delivery/.test(hlog) && !/Processing failed/.test(hlog), hlog.slice(0, 200));
    await reset();
    const hlog2 = await hook();
    ok('5. ...and for an active license it is processed as before', !/license isn't active/.test(hlog2) && /Received on/.test(hlog2), hlog2.slice(0, 200));

    ok('6. the new code logged no unexpected server errors', !/error: |TypeError|ReferenceError|Unhandled/.test(newP.getLog().split('\n').filter((l) => !/blocked in test|fake 404|No matching|SMTP|\[auth\]|\[license\]|\[webhook\]|\[team\]|\[poll\]|\[http\]/.test(l)).join('\n')), newP.getLog().slice(-500));
  } catch (err) {
    console.error('TEST ERROR', err);
    results.push(['harness', false]);
  } finally {
    for (const p of procs) p.kill();
    await db.query('SET search_path TO public').catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await db.end().catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    const failed = results.filter(([, p]) => !p);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
