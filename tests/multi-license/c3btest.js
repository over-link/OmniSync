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
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_c3b')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_c3b';
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

    // ── two licenses
    const t2 = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Company B', $1) RETURNING id", [U.adminb]))[0].id;
    const lB = (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at) VALUES ($1,'B license', 5, '2020-01-01', '2030-01-01', now()) RETURNING id", [t2]))[0].id;
    const lA = (await q('SELECT id FROM tenant_licenses WHERE tenant_id <> $1 LIMIT 1', [t2]))[0].id;
    const tA = (await q('SELECT tenant_id FROM tenant_licenses WHERE id = $1', [lA]))[0].tenant_id;
    await q('DELETE FROM license_members WHERE user_id = ANY($1)', [[U.adminb, U.memberb]]);
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin'), ($1,$3,'member')", [lB, U.adminb, U.memberb]);
    await q(`INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, revizto_license_uuid, tenant_id, tenant_license_id)
       VALUES ('PB1','rv-PB1','virginia','hub','b.accb1',$1,'LIC-B',$2,$3)`, [U.adminb, t2, lB]);
    await q("INSERT INTO project_members(project_id, user_id, role) VALUES ((SELECT id FROM projects WHERE name='PB1'),$1,'standard')", [U.memberb]);
    await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [U.adminb, 'a', 'b', exp]);
    await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [U.adminb, exp]);
    const N = (cookie, p, o) => get(3062, cookie, p, o);
    const fresh = async (k) => { C[k] = await session(U[k]); return C[k]; };
    for (const k of ['adminb', 'memberb']) await fresh(k);
    const flags = async (id) => (await q('SELECT sync_paused, poll_247, last_full_check_date::text AS lf, paused_since FROM tenant_licenses WHERE id = $1', [id]))[0];

    // ── 1. the switches are the OPEN license's
    await q("UPDATE tenant_licenses SET settings_copied_at = now()"); // (the one-time copy is tested in section 4)
    const r1 = await N(C.owner, '/api/settings/sync-paused', { method: 'POST', body: { paused: true } });
    ok("1. an A license admin pauses A's syncing", r1.status === 200 && (await flags(lA)).sync_paused === true);
    ok("1. ...and B is NOT paused by it", (await flags(lB)).sync_paused === false && (await N(C.adminb, '/api/settings/sync-paused')).body.paused === false && (await N(C.owner, '/api/settings/sync-paused')).body.paused === true);
    await N(C.adminb, '/api/settings/poll-24-7', { method: 'POST', body: { on: true } });
    ok("1. 24/7 is per license too (B on, A off)", (await flags(lB)).poll_247 === true && (await flags(lA)).poll_247 === false && (await N(C.owner, '/api/settings/poll-24-7')).body.on === false);
    ok('1. members cannot change them (403)', (await N(C.pa, '/api/settings/sync-paused', { method: 'POST', body: { paused: false } })).status === 403 && (await N(C.memberb, '/api/settings/poll-24-7', { method: 'POST', body: { on: false } })).status === 403);
    await q('UPDATE tenant_licenses SET sync_paused = false, poll_247 = false');

    // ── 2. the pure decision, per license and company timezone
    const syncPolicy = require(REPO + '/src/services/syncPolicy');
    const licenseState = require(REPO + '/src/services/licenseState');
    const zones = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Pago_Pago', 'Africa/Cairo', 'Asia/Dubai', 'Atlantic/Azores'];
    const pickZone = (pred) => zones.find((z) => pred(syncPolicy.localParts(z).hour));
    const zNormal = pickZone((h) => h >= 7 && h <= 16), zFull = pickZone((h) => h >= 18), zQuiet = pickZone((h) => h < 6);
    ok('2. (setup) found timezones in working hours, after 6 PM and before 6 AM right now', !!(zNormal && zFull && zQuiet), JSON.stringify({ zNormal, zFull, zQuiet }));
    const mk = (over = {}) => ({ id: 1, name: 'L', timezone: zNormal, sync_paused: false, poll_247: false, last_full_check_date: null, paused_since: null, state: { usable: true, phase: 'active' }, ...over });
    const today = (tz) => syncPolicy.localParts(tz).date;
    ok('2. working hours -> normal', syncPolicy.decide(mk()) === 'normal');
    ok('2. after 6 PM, full check not done today -> full', syncPolicy.decide(mk({ timezone: zFull })) === 'full');
    ok('2. after 6 PM, full check done today -> quiet (outside hours)', syncPolicy.decide(mk({ timezone: zFull, last_full_check_date: today(zFull) })) === 'quiet');
    ok('2. after 6 PM, done today, but "outside working hours" on -> normal', syncPolicy.decide(mk({ timezone: zFull, last_full_check_date: today(zFull), poll_247: true })) === 'normal');
    ok('2. before 6 AM -> quiet; with 24/7 -> normal', syncPolicy.decide(mk({ timezone: zQuiet })) === 'quiet' && syncPolicy.decide(mk({ timezone: zQuiet, poll_247: true })) === 'normal');
    ok('2. its own pause beats everything', syncPolicy.decide(mk({ sync_paused: true, timezone: zFull })) === 'paused');
    ok('2. an inactive license is paused whatever its switches say', syncPolicy.decide(mk({ state: { usable: false, phase: 'expired' } })) === 'inactive');
    ok('2. a license that was paused is reported as resumed once it can sync', syncPolicy.planTick([mk({ paused_since: new Date() })]).resumed.length === 1 && syncPolicy.planTick([mk({ paused_since: new Date(), sync_paused: true })]).resumed.length === 0);

    // ── 3. pollTick: each license by its own rules (stubbed sync work)
    const pollService = require(REPO + '/src/services/pollService');
    const syncService = require(REPO + '/src/services/syncService');
    const visits = [];
    syncService.prefetchLinkedIssues = async (uid, project) => { visits.push({ name: project.name, full: null }); return { links: [], reviztoById: new Map(), accById: new Map() }; };
    syncService.pushLinkedIssues = async (uid, project, { full }) => { const v = visits.filter((x) => x.name === project.name).pop(); if (v) v.full = !!full; return []; };
    for (const n of ['autoLinkMatchingIssues']) syncService[n] = async () => [];
    for (const n of ['pollAccCommentsForProject', 'pollAccAttachmentsForProject']) syncService[n] = async () => {};
    const tick = async () => { visits.length = 0; const l = console.log; console.log = () => {}; try { await pollService.pollTick(); } finally { console.log = l; } return visits.map((v) => v.name + (v.full ? ':full' : '')).sort().join(','); };
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [tA, zNormal]);
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [t2, zFull]);
    await q('UPDATE tenant_licenses SET last_full_check_date = NULL, paused_since = NULL, sync_paused = false, poll_247 = false');
    ok("3. A (working hours) syncs normally and B (after 6 PM) gets its daily full check", (await tick()) === 'P1,P2,PB1:full', visits.map((v) => v.name).join());
    ok("3. ...B's full-check date is recorded in ITS timezone, A's is untouched", (await flags(lB)).lf === today(zFull) && (await flags(lA)).lf === null);
    ok('3. next tick: A again; B is done for the day and outside hours (quiet) -> not visited', (await tick()) === 'P1,P2');
    await q('UPDATE tenant_licenses SET sync_paused = true WHERE id = $1', [lA]);
    ok("3. A paused: only B's own rules apply (quiet) -> nothing visited; A gets paused_since", (await tick()) === '' && (await flags(lA)).paused_since !== null);
    const since = (await flags(lA)).paused_since.toISOString();
    await tick();
    ok('3. paused_since is stamped once and not overwritten while paused', (await flags(lA)).paused_since.toISOString() === since);
    await q('UPDATE tenant_licenses SET sync_paused = false WHERE id = $1', [lA]);
    ok('3. un-pausing: A syncs again and paused_since is cleared afterwards', (await tick()) === 'P1,P2' && (await flags(lA)).paused_since === null);
    await q('UPDATE tenant_licenses SET poll_247 = true WHERE id = $1', [lB]);
    ok('3. B with "outside working hours" on is visited even after 6 PM', (await tick()) === 'P1,P2,PB1');
    await q('UPDATE tenants SET timezone = $2 WHERE id = $1', [t2, zQuiet]);
    await q('UPDATE tenant_licenses SET poll_247 = false WHERE id = $1', [lB]);
    ok('3. before 6 AM in its own timezone B sleeps while A (daytime elsewhere) syncs', (await tick()) === 'P1,P2');
    // platform pause
    const platform = require(REPO + '/src/db/platformSync');
    const ql = console.log; console.log = () => {};
    await platform.main(['pause']); const pausedState = await platform.main([]);
    console.log = ql;
    ok("3. the operator's platform pause stops EVERY license and stamps them all paused", pausedState === true && (await tick()) === '' && (await flags(lA)).paused_since !== null && (await flags(lB)).paused_since !== null);
    console.log = () => {}; await platform.main(['resume']); const runningState = await platform.main([]); console.log = ql;
    ok('3. ...and resuming brings them back', runningState === false && (await tick()) === 'P1,P2' && (await flags(lA)).paused_since === null);
    let bad = null; try { console.log = () => {}; await platform.main(['bogus']); } catch (e) { bad = e; } finally { console.log = ql; }
    ok('3. the platform command rejects anything but pause / resume', !!bad);
    await q('UPDATE license_members SET role = role'); // keep session rows valid

    // ── 4. the one-time copy of the older app-wide switches
    await q("INSERT INTO app_settings(key, value) VALUES ('sync_paused','true'), ('poll_24_7','true'), ('last_full_check_date','2026-10-01') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    await q('UPDATE tenant_licenses SET sync_paused = false, poll_247 = false, last_full_check_date = NULL, settings_copied_at = NULL WHERE id = $1', [lA]);
    await q('UPDATE tenant_licenses SET sync_paused = false, poll_247 = false, settings_copied_at = now() WHERE id = $1', [lB]);
    const ql2 = console.log; console.log = () => {};
    const copied = await syncPolicy.copyGlobalSettingsOnce();
    console.log = ql2;
    const fa = await flags(lA);
    ok('4. the older app-wide values are copied into the license that never had them', copied === 1 && fa.sync_paused === true && fa.poll_247 === true && fa.lf === '2026-10-01');
    ok("4. a license created with its settings already set (a new company's) does NOT inherit them", (await flags(lB)).sync_paused === false);
    await q('UPDATE tenant_licenses SET sync_paused = false WHERE id = $1', [lA]);
    console.log = () => {}; const again = await syncPolicy.copyGlobalSettingsOnce(); console.log = ql2;
    ok('4. running it again changes nothing (so a later toggle is never overwritten)', again === 0 && (await flags(lA)).sync_paused === false);
    await q("DELETE FROM app_settings WHERE key IN ('sync_paused','poll_24_7','last_full_check_date')");

    // ── 5. webhooks: ignored while paused (license switch or platform), processed otherwise
    const hook = async (acc) => { const before = newP.getLog().length; await fetch('http://localhost:3062/webhook/acc-v2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook: { scope: { project: acc } }, payload: { id: 'x' } }) }); await wait(1500); return newP.getLog().slice(before); };
    await q('UPDATE tenant_licenses SET sync_paused = true WHERE id = $1', [lA]);
    const w1 = await hook('acc1'), w2 = await hook('accb1');
    ok("5. a webhook for a paused license's project is ignored", /syncing is paused — ignoring/.test(w1));
    ok("5. ...but another license's webhook is not affected by it", !/syncing is paused/.test(w2) && /Received on/.test(w2), w2.slice(0, 160));
    await q('UPDATE tenant_licenses SET sync_paused = false WHERE id = $1', [lA]);
    await q("INSERT INTO app_settings(key, value) VALUES ('platform_sync_paused','true') ON CONFLICT (key) DO UPDATE SET value = 'true'");
    const w3 = await hook('accb1');
    ok('5. the operator platform pause ignores webhooks for every license', /syncing is paused — ignoring/.test(w3));
    await q("UPDATE app_settings SET value = 'false' WHERE key = 'platform_sync_paused'");
    const w4 = await hook('acc1');
    ok('5. ...and with everything off a webhook is processed as before', !/syncing is paused/.test(w4) && /Received on/.test(w4), w4.slice(0, 160));

    const noise = /blocked in test|fake 404|No matching|SMTP|\[auth\]|\[license\]|\[webhook\]|\[team\]|\[poll\]|\[http\]/;
    const unexpected = newP.getLog().split('\n').filter((l) => !noise.test(l)).join('\n');
    ok('6. the new code logged no unexpected server errors', !/error: |TypeError|ReferenceError|Unhandled/.test(unexpected), unexpected.slice(-400));
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
