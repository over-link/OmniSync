// Multi-license regression test — see tests/multi-license/README.md
// Chunk 5 test, in a throwaway schema (never the live tables): an ACC project can be ACTIVELY paired
// to only ONE Revizto project in the whole app (projects.sync_active + partial unique index, kept current by
// services/pairingGuard.js); expiry / archive free it; a returning pairing stays paused with a notice.
const REPO = require('path').resolve(__dirname, '../..');
const SCRATCH = __dirname;
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sign = require('cookie-signature').sign;
const pg = require('pg');
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_c5')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_c5';
const PORT = 3065;
const SECRET = process.env.SESSION_SECRET || 'test-secret';
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAILS = ['op@x.com', 'adma@x.com', 'admb@x.com'];

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let proc = null;
  let log = '';
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)');

    const mkUser = async (email, role = 'member', op = false) => (await q('INSERT INTO users(email, role, name, is_operator) VALUES ($1,$2,$3,$4) RETURNING id', [email, role, email.split('@')[0], op]))[0].id;
    const U = { op: await mkUser('op@x.com', 'member', true), adma: await mkUser('adma@x.com', 'primary_license_admin'), admb: await mkUser('admb@x.com', 'primary_license_admin') };
    const tA = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Company A', $1) RETURNING id", [U.adma]))[0].id;
    const tB = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Company B', $1) RETURNING id", [U.admb]))[0].id;
    const daysFromToday = async (n) => (await q("SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') AS d", [n]))[0].d;
    const mkLic = async (t, name, expires) => (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at) VALUES ($1,$2,20,'2020-01-01',$3,now()) RETURNING id", [t, name, expires]))[0].id;
    const L = { a1: await mkLic(tA, 'A-one', '2035-01-01'), a2: await mkLic(tA, 'A-two', '2035-01-01'), b1: await mkLic(tB, 'B-one', '2035-01-01'), old: await mkLic(tA, 'A-old', await daysFromToday(-5)) };
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin'), ($3,$2,'license_admin'), ($4,$2,'license_admin'), ($5,$6,'license_admin')", [L.a1, U.adma, L.a2, L.old, L.b1, U.admb]);
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.adma, L.a1]);
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.admb, L.b1]);
    const T = { [L.a1]: tA, [L.a2]: tA, [L.old]: tA, [L.b1]: tB };
    const mkProject = async (name, lic, { rv = null, acc = null, archived = false } = {}) => (await q(
      `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, tenant_id, tenant_license_id, archived_at)
       VALUES ($1,$2,'virginia',$3,$4,$5,$6,$7,${archived ? 'now()' : 'NULL'}) RETURNING id`, [name, rv, acc ? 'hub' : null, acc, U.adma, T[lic], lic]))[0].id;

    // ── 1. the migration's backfill: an ACC project already paired twice keeps its OLDEST active pairing
    await db.query('ALTER TABLE projects DROP COLUMN sync_active'); // back to the state before chunk 5 (this also drops the index)
    const D1 = await mkProject('D1-older', L.a1, { rv: 'rv-d1', acc: 'b.dup' });
    const D2 = await mkProject('D2-newer', L.a1, { rv: 'rv-d2', acc: 'b.dup' });
    const D3 = await mkProject('D3-archived', L.a1, { rv: 'rv-d3', acc: 'b.arch', archived: true });
    const D4 = await mkProject('D4-unpaired', L.a1);
    await db.query(schemaSql); // the migration again, as `npm run migrate` would
    const flags = Object.fromEntries((await q('SELECT id, sync_active FROM projects')).map((r) => [r.id, r.sync_active]));
    ok('1. migration: of two projects paired to one ACC project the OLDEST is active, the other paused', flags[D1] === true && flags[D2] === false, JSON.stringify(flags));
    ok('1. migration: archived and unpaired projects are not active', flags[D3] === false && flags[D4] === false);
    await db.query(schemaSql); // and re-running it changes nothing
    const flags2 = Object.fromEntries((await q('SELECT id, sync_active FROM projects')).map((r) => [r.id, r.sync_active]));
    ok('1. migrating twice changes nothing (the backfill runs only when the column is added)', JSON.stringify(flags) === JSON.stringify(flags2));
    await q('DELETE FROM projects');

    // ── data for the rest
    const P1 = await mkProject('P1', L.a1, { rv: 'rv-1', acc: 'b.X' });
    const Pold = await mkProject('Pold', L.old, { rv: 'rv-old', acc: 'b.V' }); // license expired 5 days ago
    const Parch = await mkProject('Parch', L.a1, { rv: 'rv-arch', acc: 'b.U', archived: true });
    const P2 = await mkProject('P2', L.a1);
    const P3 = await mkProject('P3', L.a1);
    const P4 = await mkProject('P4', L.a1), P5 = await mkProject('P5', L.a1);
    const PB = await mkProject('PB', L.b1);
    await q('UPDATE projects SET owner_user_id = $1 WHERE id = $2', [U.admb, PB]);

    proc = spawn(process.execPath, ['-r', path.join(SCRATCH, 'preload.js'), '-r', path.join(SCRATCH, 'preload-pairing.js'), 'src/server.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), TEST_SCHEMA: SCHEMA, TEST_EMAILS: EMAILS.join(','), SESSION_SECRET: SECRET, NODE_ENV: 'test', PUBLIC_BASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => (log += d));
    proc.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/auth/me`); break; } catch { await wait(500); } }
    // the startup refresh (after the RLS self-test, when RLS_MODE=on): wait until it has run, up to 30 s
    for (let i = 0; i < 60 && !(await q('SELECT 1 FROM projects WHERE id = $1 AND sync_active', [P1])).length; i++) await wait(500);

    const session = async (userId) => {
      const u = (await q('SELECT id, email, role, password_version FROM users WHERE id = $1', [userId]))[0];
      const sid = crypto.randomBytes(16).toString('hex');
      const sess = { cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: '/' }, userId: u.id, userEmail: u.email, role: u.role, signedInAt: Date.now(), passwordVersion: u.password_version };
      await q("INSERT INTO session(sid, sess, expire) VALUES ($1, $2, now() + interval '1 day')", [sid, sess]);
      return 'connect.sid=' + encodeURIComponent('s:' + sign(sid, SECRET));
    };
    const call = async (cookie, p, opts = {}) => {
      const r = await fetch(`http://localhost:${PORT}${p}`, { method: opts.method || 'GET', headers: { cookie, 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      let body = null; try { body = await r.json(); } catch { /* not json */ }
      return { status: r.status, body };
    };
    const adminA = async () => session(U.adma), adminB = async () => session(U.admb);
    const opC = await session(U.op);
    const active = async (id) => (await q('SELECT sync_active FROM projects WHERE id = $1', [id]))[0]?.sync_active;
    const pair = (cookie, id, name, rv, acc) => call(cookie, `/api/projects/${id}`, { method: 'PATCH', body: { name, revizto_license_uuid: 'LIC', revizto_project_uuid: rv, acc_hub_id: 'hub', acc_project_id: acc } });
    const accOf = async (id) => (await q('SELECT acc_project_id FROM projects WHERE id = $1', [id]))[0].acc_project_id;

    // ── 2. startup: which pairings are active
    ok('2. at startup the paired project in an active license is active', (await active(P1)) === true);
    ok('2. a project of an EXPIRED license is not active', (await active(Pold)) === false);
    ok('2. an archived and an unpaired project are not active', (await active(Parch)) === false && (await active(P2)) === false);

    // ── 3. the guard at pairing
    let cA = await adminA();
    let r = await pair(cA, P2, 'P2', 'rv-2', 'b.X');
    ok('3. pairing a second Revizto project to an ACC project already actively paired is refused (409), naming the license', r.status === 409 && r.body.error === 'This ACC project is already paired with a Revizto project under A-one. Archive or re-pair that one first.', JSON.stringify(r));
    ok('3. ...and nothing was saved', (await accOf(P2)) === null && (await active(P2)) === false);
    r = await pair(await adminB(), PB, 'PB', 'rv-b', 'b.X');
    ok("3. another company's attempt is refused too — and the license name is withheld", r.status === 409 && r.body.error === 'This ACC project is already paired with a Revizto project by another account. Archive or re-pair that one first.', JSON.stringify(r));
    r = await pair(cA, P2, 'P2', 'rv-2', 'b.Y');
    ok('3. a free ACC project pairs fine, and the project becomes active', r.status === 200 && (await active(P2)) === true, JSON.stringify(r));
    r = await pair(cA, P3, 'P3', 'rv-1', 'b.Z'); // the SAME Revizto project (rv-1) to a different ACC project
    ok('3. one Revizto project paired to a second, different ACC project is allowed', r.status === 200 && (await active(P3)) === true, JSON.stringify(r));
    r = await pair(cA, P1, 'P1 renamed', 'rv-1', 'b.X');
    ok('3. modifying a pairing without changing its ACC project works (it does not conflict with itself)', r.status === 200 && (await active(P1)) === true, JSON.stringify(r));
    r = await pair(cA, P1, 'P1', 'rv-1', 'b.Y');
    ok('3. re-pairing a project onto an ACC project another project holds is refused (409)', r.status === 409 && (await accOf(P1)) === 'b.X', JSON.stringify(r));
    r = await pair(cA, P1, 'P1', 'rv-1', 'b.X2');
    ok('3. re-pairing to a free ACC project moves it (and frees b.X)', r.status === 200 && (await active(P1)) === true && (await accOf(P1)) === 'b.X2');
    r = await pair(cA, P3, 'P3', 'rv-1', 'b.X');
    ok('3. ...so b.X can now be taken by another project', r.status === 200 && (await active(P3)) === true && (await active(P1)) === true);

    // ── 4. two admins saving at the same moment: exactly one wins
    const [ra, rb] = await Promise.all([pair(await adminA(), P4, 'P4', 'rv-4', 'b.W'), pair(await adminA(), P5, 'P5', 'rv-5', 'b.W')]);
    const statuses = [ra.status, rb.status].sort().join();
    const holders = (await q("SELECT id FROM projects WHERE acc_project_id = 'b.W' AND sync_active")).length;
    ok('4. a simultaneous double save: one 200 and one 409, exactly one active holder', statuses === '200,409' && holders === 1, JSON.stringify([ra, rb, holders]));
    const loser = ra.status === 409 ? P4 : P5;
    ok('4. the loser saved nothing', (await accOf(loser)) === null);

    // ── 5. create-and-pair in one go (POST) goes through the same guard
    r = await call(await adminA(), '/api/projects', { method: 'POST', body: { name: 'New paired', revizto_license_uuid: 'LIC', revizto_project_uuid: 'rv-n', acc_hub_id: 'hub', acc_project_id: 'b.X' } });
    ok('5. POST create-and-pair onto a held ACC project is refused (409) and takes no slot', r.status === 409 && !(await q("SELECT 1 FROM projects WHERE name = 'New paired'")).length, JSON.stringify(r));
    r = await call(await adminA(), '/api/projects', { method: 'POST', body: { name: 'New paired', revizto_license_uuid: 'LIC', revizto_project_uuid: 'rv-n', acc_hub_id: 'hub', acc_project_id: 'b.N' } });
    ok('5. ...a free one works and is active', r.status === 200 && (await active(r.body.project.id)) === true, JSON.stringify(r).slice(0, 200));

    // ── 6. archive frees an ACC project; unarchive of the old one then stays paused
    const holderOfX = (await q("SELECT id FROM projects WHERE acc_project_id = 'b.X' AND sync_active"))[0].id; // P3
    r = await call(await adminA(), `/api/license/projects/${holderOfX}/archive`, { method: 'POST' });
    ok('6. archiving the holder frees its ACC project', r.status === 200 && (await active(holderOfX)) === false);
    r = await pair(await adminA(), P2, 'P2', 'rv-2', 'b.X');
    ok('6. ...another project can now take it', r.status === 200 && (await active(P2)) === true, JSON.stringify(r));
    r = await call(await adminA(), `/api/license/projects/${holderOfX}/unarchive`, { method: 'POST' });
    ok('6. unarchiving the old holder works, but it stays PAUSED (the other keeps syncing)', r.status === 200 && (await active(holderOfX)) === false && (await active(P2)) === true, JSON.stringify(r));
    const list = (await call(await adminA(), '/api/projects')).body.projects;
    const paused = list.find((p) => p.id === holderOfX);
    ok('6. its project entry carries the pause notice; the active one has none', !!paused?.pairing_paused && /paused/i.test(paused.pairing_paused) && !list.find((p) => p.id === P2).pairing_paused, JSON.stringify(paused?.pairing_paused));
    const adm = (await call(await adminA(), '/api/license/projects')).body.projects;
    ok('6. License Administration flags it (pairing_paused) and not the active one', adm.find((p) => p.id === holderOfX)?.pairing_paused === true && adm.find((p) => p.id === P2)?.pairing_paused === false);
    r = await call(await adminA(), `/api/projects/${holderOfX}/sync`, { method: 'POST', body: { issueIds: ['1'] } });
    ok('6. a manual "link & push" on the paused project is refused (409 pairing_paused)', r.status === 409 && r.body.code === 'pairing_paused', JSON.stringify(r));
    r = await call(await adminA(), `/api/license/projects/${P2}`, { method: 'DELETE' });
    ok('6. deleting the active holder lets the paused one resume by itself', r.status === 200 && (await active(holderOfX)) === true, JSON.stringify(r));

    // ── 7. expiry: the same ACC project can be re-paired under a new license; a renewal does not displace it
    r = await pair(await adminA(), P5 === loser ? P5 : P4, 'repair', 'rv-new', 'b.V');
    ok('7. an ACC project paired only under an EXPIRED license can be paired under another license', r.status === 200, JSON.stringify(r));
    const newHolder = P5 === loser ? P5 : P4;
    ok('7. ...and the new pairing is the active one', (await active(newHolder)) === true && (await active(Pold)) === false);
    r = await call(opC, `/api/operator/licenses/${L.old}`, { method: 'PATCH', body: { expiresOn: await daysFromToday(300) } });
    ok('7. renewing the expired license: its old pairing comes back PAUSED, the new one keeps syncing', r.status === 200 && (await active(Pold)) === false && (await active(newHolder)) === true, JSON.stringify(r));
    await call(await adminA(), `/api/license/projects/${newHolder}/archive`, { method: 'POST' });
    ok('7. ...and resumes once the other is archived', (await active(Pold)) === true);

    // ── 8. a suspended license releases its ACC projects
    await call(opC, `/api/operator/licenses/${L.a1}/suspend`, { method: 'POST' });
    ok('8. suspending a license makes its projects inactive', (await q('SELECT count(*)::int n FROM projects WHERE tenant_license_id = $1 AND sync_active', [L.a1]))[0].n === 0);
    await call(opC, `/api/operator/licenses/${L.a1}/unsuspend`, { method: 'POST' });
    ok('8. reactivating restores them', (await q('SELECT count(*)::int n FROM projects WHERE tenant_license_id = $1 AND sync_active', [L.a1]))[0].n > 0);

    // ── 9. the database itself refuses a second active holder
    let dbRefused = false;
    try {
      const some = (await q('SELECT id, acc_project_id FROM projects WHERE sync_active LIMIT 1'))[0];
      const other = (await q('SELECT id FROM projects WHERE NOT sync_active AND id <> $1 LIMIT 1', [some.id]))[0];
      await q('UPDATE projects SET acc_project_id = $2, revizto_project_uuid = $3, sync_active = true WHERE id = $1', [other.id, some.acc_project_id, 'rv-sneak']);
    } catch (err) { dbRefused = err.code === '23505'; }
    ok('9. the partial unique index rejects a second active project on the same ACC project (even by direct SQL)', dbRefused);
    ok('9. no ACC project is held by two active projects', (await q('SELECT 1 FROM projects WHERE sync_active GROUP BY acc_project_id HAVING count(*) > 1')).length === 0);

    if (process.env.RLS_MODE === 'on') ok('(RLS on) the restricted role was never silently refused a query that should be classified', !log.includes('[rls] The restricted role was refused'), log.split('\n').filter((l) => l.includes('[rls] The restricted role was refused')).join('\n'));
    const failed = results.filter(([, p]) => !p);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (/Unhandled error/.test(log)) console.log('NOTE: server logged an unhandled error:\n' + log.split('\n').filter((l) => /Unhandled/.test(l)).slice(0, 3).join('\n'));
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('TEST CRASHED', err);
    console.error('server log:\n' + log.slice(-2000));
    process.exitCode = 2;
  } finally {
    if (proc) proc.kill();
    await db.query('SET search_path TO public').catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e) => console.error('drop failed', e.message));
    await db.end().catch(() => {});
  }
})();
