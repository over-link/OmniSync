// Multi-license regression test — see tests/multi-license/README.md
// Chunk 6 test: row-level security. In-process, throwaway schema, no network.
// Runs the REAL restricted role (app_rls) through db/pool.js with RLS_MODE=on and checks that, inside a
// license's scope, a query with NO license filter still returns / changes only that license's rows.
const REPO = require('path').resolve(__dirname, '../..');
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
process.env.POLL_ENABLED = 'false';
process.env.RLS_MODE = 'on';
const fs = require('fs');
const pg = require('pg');
const SCHEMA = 'tst_c6';
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query(`SET search_path TO ${SCHEMA}`)); } }; }

const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const throws = async (f) => { try { await f(); return null; } catch (e) { return e; } };

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let pool;
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)'); // normally made by the session store

    // ── two companies, two licenses, people, projects and their data
    const mkUser = async (email) => (await q("INSERT INTO users(email, role, name) VALUES ($1,'member',$2) RETURNING id", [email, email.split('@')[0]]))[0].id;
    const U = { a1: await mkUser('a1@x.com'), a2: await mkUser('a2@x.com'), b1: await mkUser('b1@x.com'), both: await mkUser('both@x.com'), nobody: await mkUser('nobody@x.com') };
    const tA = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Co A', $1) RETURNING id", [U.a1]))[0].id;
    const tB = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Co B', $1) RETURNING id", [U.b1]))[0].id;
    const mkLic = async (t, name) => (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at) VALUES ($1,$2,9,'2020-01-01','2035-01-01',now()) RETURNING id", [t, name]))[0].id;
    const LA = await mkLic(tA, 'A-lic'), LB = await mkLic(tB, 'B-lic');
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin'), ($1,$3,'member'), ($1,$4,'member'), ($5,$6,'license_admin'), ($5,$4,'member')", [LA, U.a1, U.a2, U.both, LB, U.b1]);
    const mkProject = async (name, lic, t) => (await q("INSERT INTO projects(name, revizto_project_uuid, acc_hub_id, acc_project_id, owner_user_id, tenant_id, tenant_license_id) VALUES ($1,$2,'hub',$3,$4,$5,$6) RETURNING id", [name, 'rv-' + name, 'b.' + name, U.a1, t, lic]))[0].id;
    const PA = await mkProject('PA', LA, tA), PB = await mkProject('PB', LB, tB);
    for (const [p, tag] of [[PA, 'a'], [PB, 'b']]) {
      await q("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id) VALUES ($1,$2,$3), ($1,$4,$5)", [p, tag + '1', 'acc-' + tag + '1', tag + '2', 'acc-' + tag + '2']);
      await q("INSERT INTO status_map(project_id, revizto_status, acc_status) VALUES ($1,'Open','open')", [p]).catch(() => {});
      await q("INSERT INTO audit_log(project_id, direction, action, outcome, detail) VALUES ($1,'revizto_to_acc','link','success',$2)", [p, 'log-' + tag]);
      await q("INSERT INTO acc_issue_numbers(project_id, acc_issue_id, display_id) VALUES ($1,$2,'1')", [p, 'acc-' + tag + '1']);
      await q("INSERT INTO auto_sync_filters(project_id, field, value) VALUES ($1,'status','Open')", [p]).catch(() => {});
      await q("INSERT INTO user_map(project_id, email, acc_autodesk_id) VALUES ($1,$2,'u')", [p, tag + '@x.com']);
      await q("INSERT INTO invite_links(code, project_id, role, created_by) VALUES ($1,$2,'standard',$3)", ['code-' + tag, p, U.a1]);
    }
    await q("INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'standard'), ($3,$4,'standard')", [PA, U.a2, PB, U.b1]);
    for (const u of [U.a1, U.b1]) {
      await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,now(),now())', [u, 'secret-a', 'secret-b']);
    }
    await q("INSERT INTO app_settings(key, value) VALUES ('probe', '1') ON CONFLICT DO NOTHING");
    await q("INSERT INTO revizto_licenses(tenant_id, revizto_license_uuid, region) VALUES ($1,'UUID-A','virginia')", [tA]);

    pool = require(REPO + '/src/db/pool');
    ok('0. (setup) the pool is in restricted mode', pool.rlsOn === true && !!pool.restricted);
    const asA = (f) => pool.runScoped(LA, f), asB = (f) => pool.runScoped(LB, f);
    const names = (rows, k = 'name') => rows.map((r) => r[k]).sort().join(',');

    // ── 1. who am I
    let r = await asA(() => pool.query("SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass, current_setting('app.license_id') AS lic"));
    ok('1. inside a license scope the query runs as app_rls, which cannot bypass RLS, with that license open', r.rows[0].u === 'app_rls' && r.rows[0].bypass === false && r.rows[0].lic === String(LA), JSON.stringify(r.rows[0]));
    r = await pool.query('SELECT current_user AS u');
    ok('1. outside any scope the app still uses its normal (unrestricted) user', r.rows[0].u !== 'app_rls');

    // ── 2. forgetting the license filter returns only the open license
    r = await asA(() => pool.query('SELECT name FROM projects'));
    ok('2. SELECT * FROM projects (no filter) in A -> only A\'s project', names(r.rows) === 'PA', names(r.rows));
    r = await asB(() => pool.query('SELECT name FROM projects'));
    ok('2. ...and in B -> only B\'s', names(r.rows) === 'PB');
    r = await pool.query('SELECT name FROM projects');
    ok('2. ...and with no scope (poller, login, operator) -> every project, as before', names(r.rows) === 'PA,PB');
    const tables = [['sync_map', 'revizto_issue_id', 'a1,a2'], ['audit_log', 'detail', 'log-a'], ['acc_issue_numbers', 'acc_issue_id', 'acc-a1'], ['user_map', 'email', 'a@x.com'], ['invite_links', 'code', 'code-a'], ['project_members', 'user_id', String(U.a2)]];
    for (const [t, col, want] of tables) {
      const rows = (await asA(() => pool.query(`SELECT ${col} FROM ${t}`))).rows;
      ok(`2. ${t} (no filter) in A -> only A's rows`, names(rows, col) === want, names(rows, col));
    }
    r = await asA(() => pool.query('SELECT name FROM tenant_licenses'));
    ok('2. tenant_licenses -> only the open license', names(r.rows) === 'A-lic');
    r = await asA(() => pool.query('SELECT name FROM tenants'));
    ok('2. tenants -> only the open license\'s company', names(r.rows) === 'Co A');
    r = await asA(() => pool.query('SELECT user_id FROM license_members'));
    ok('2. license_members -> only the open license\'s', r.rows.length === 3 && r.rows.every((x) => [U.a1, U.a2, U.both].includes(x.user_id)), JSON.stringify(r.rows));
    r = await asA(() => pool.query('SELECT email FROM users'));
    ok('2. users -> only people who belong to the open license (not B\'s admin, not someone in no license)', names(r.rows, 'email') === 'a1@x.com,a2@x.com,both@x.com', names(r.rows, 'email'));
    r = await asB(() => pool.query('SELECT email FROM users'));
    ok('2. a person in BOTH licenses shows in each; the other license\'s people never do', names(r.rows, 'email') === 'b1@x.com,both@x.com');

    // ── 3. the other license's rows can't be reached by id either
    r = await asA(() => pool.query('SELECT * FROM projects WHERE id = $1', [PB]));
    ok('3. fetching B\'s project by id from A -> nothing', r.rows.length === 0);
    r = await asA(() => pool.query("SELECT * FROM sync_map WHERE project_id = $1", [PB]));
    ok('3. fetching B\'s sync links by project id from A -> nothing', r.rows.length === 0);
    r = await asA(() => pool.query('SELECT * FROM users WHERE id = $1', [U.b1]));
    ok('3. fetching B\'s person by id from A -> nothing', r.rows.length === 0);

    // ── 4. writes into / against the other license are refused or change nothing
    r = await asA(() => pool.query("UPDATE projects SET name = 'hacked' WHERE id = $1 RETURNING id", [PB]));
    ok('4. UPDATE of B\'s project from A changes nothing', r.rowCount === 0 && (await q('SELECT name FROM projects WHERE id = $1', [PB]))[0].name === 'PB');
    r = await asA(() => pool.query('DELETE FROM projects WHERE id = $1', [PB]));
    ok('4. DELETE of B\'s project from A deletes nothing', r.rowCount === 0 && (await q('SELECT 1 FROM projects WHERE id = $1', [PB])).length === 1);
    r = await asA(() => pool.query("DELETE FROM sync_map WHERE project_id = $1", [PB]));
    ok('4. DELETE of B\'s sync links from A deletes nothing', r.rowCount === 0 && (await q('SELECT 1 FROM sync_map WHERE project_id = $1', [PB])).length === 2);
    let e = await throws(() => asA(() => pool.query("INSERT INTO projects(name, tenant_id, tenant_license_id) VALUES ('sneak', $1, $2)", [tB, LB])));
    ok('4. INSERT of a project INTO B from A is refused (row-level security)', e && /row-level security/.test(e.message), e?.message);
    e = await throws(() => asA(() => pool.query("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id) VALUES ($1,'z','z')", [PB])));
    ok('4. INSERT of a sync link onto B\'s project from A is refused', e && /row-level security/.test(e.message), e?.message);
    e = await throws(() => asA(() => pool.query("INSERT INTO audit_log(project_id, action, outcome) VALUES ($1,'link','success')", [PB])));
    ok('4. INSERT of an activity-log row for B\'s project from A is refused', e && /row-level security/.test(e.message), e?.message);
    e = await throws(() => asA(() => pool.query("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin')", [LB, U.a1])));
    ok('4. making someone a member of B from A is refused', e && /row-level security/.test(e.message), e?.message);
    r = await asA(() => pool.query("UPDATE users SET name = 'hacked' WHERE id = $1", [U.b1]));
    ok('4. renaming B\'s person from A changes nothing', r.rowCount === 0 && (await q('SELECT name FROM users WHERE id = $1', [U.b1]))[0].name === 'b1');
    r = await asA(() => pool.query("UPDATE tenant_licenses SET slot_capacity = 1 WHERE id = $1", [LB]));
    ok('4. changing B\'s license from A changes nothing', r.rowCount === 0);
    r = await asA(() => pool.query("UPDATE projects SET name = 'PA2' WHERE id = $1 RETURNING id", [PA]));
    await asA(() => pool.query("UPDATE projects SET name = 'PA' WHERE id = $1", [PA]));
    ok('4. ...while A can still change its own', r.rowCount === 1);
    r = await asA(() => pool.query("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id) VALUES ($1,'new','acc-new') RETURNING id", [PA]));
    ok('4. ...and add to its own project', r.rowCount === 1);

    // ── 5. tables the restricted role may not touch at all
    for (const t of ['acc_tokens', 'revizto_tokens', 'session', 'password_codes', 'app_settings', 'revizto_licenses']) {
      const err = await throws(() => asA(() => pool.query(`SELECT * FROM ${t}`)));
      ok(`5. ${t} is closed to the restricted role (permission denied)`, err && /permission denied/.test(err.message), err?.message);
    }
    e = await throws(() => asA(() => pool.query('SELECT * FROM invites')));
    ok('5. invitations can be written but not read back', e && /permission denied/.test(e.message), e?.message);
    r = await asA(() => pool.query("INSERT INTO invites(email, role) VALUES ('x@y.com','standard')"));
    ok('5. ...an invitation can be added', r.rowCount === 1);

    // ── 6. no license open -> nothing
    const raw = await pool.restricted.connect();
    await raw.query("SELECT set_config('role', 'app_rls', false)");
    await raw.query("SELECT set_config('app.license_id', '', false)");
    r = await raw.query('SELECT (SELECT count(*) FROM projects)::int p, (SELECT count(*) FROM sync_map)::int s, (SELECT count(*) FROM users)::int u, (SELECT count(*) FROM tenant_licenses)::int l');
    raw.release(new Error('discard')); // an unknown-state connection is thrown away
    ok('6. restricted role with NO license set sees nothing at all', JSON.stringify(r.rows[0]) === '{"p":0,"s":0,"u":0,"l":0}', JSON.stringify(r.rows[0]));

    // ── 7. scopes don't bleed into each other
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? asB : asA)(async () => {
      await new Promise((res) => setTimeout(res, Math.random() * 20));
      const rows = (await pool.query('SELECT name FROM projects')).rows;
      const again = (await pool.query('SELECT count(*)::int n FROM sync_map')).rows[0].n;
      return { want: i % 2 ? 'PB' : 'PA', got: names(rows), n: again };
    })));
    ok('7. 40 overlapping requests of two licenses each see only their own (no bleed through reused connections)', many.every((m) => m.got === m.want), JSON.stringify(many.filter((m) => m.got !== m.want).slice(0, 2)));
    const c = await asA(() => pool.connect());
    await c.query('BEGIN');
    const inTx = (await c.query('SELECT name FROM projects')).rows;
    await c.query('COMMIT');
    c.release();
    ok('7. a transaction taken inside a scope is scoped too', names(inTx) === 'PA');
    const afterB = await asB(() => pool.query('SELECT name FROM projects'));
    ok('7. ...and the connection it released is re-pointed correctly for the next license', names(afterB.rows) === 'PB');
    r = await Promise.all([asA(() => pool.query('SELECT name FROM projects')), pool.query('SELECT name FROM projects')]);
    ok('7. a scoped query and an unscoped one at the same moment each get their own answer', names(r[0].rows) === 'PA' && names(r[1].rows) === 'PA,PB');

    // ── 8. the cost of the policies
    await q("INSERT INTO sync_map(project_id, revizto_issue_id, acc_issue_id) SELECT $1, 'bulk' || g, 'acc-bulk' || g FROM generate_series(1, 20000) g", [PA]);
    const time = async (f, n = 5) => { const t0 = Date.now(); for (let i = 0; i < n; i++) await f(); return (Date.now() - t0) / n; };
    const tAdmin = await time(() => pool.query('SELECT count(*) FROM sync_map WHERE project_id = $1', [PA]));
    const tScoped = await time(() => asA(() => pool.query('SELECT count(*) FROM sync_map WHERE project_id = $1', [PA])));
    ok('8. counting 20,000 links of a project is not made much slower by the policy', tScoped < Math.max(tAdmin * 4, 400), `unrestricted ${tAdmin.toFixed(0)} ms, restricted ${tScoped.toFixed(0)} ms`);
    const tScopedUn = await time(() => asA(() => pool.query('SELECT count(*) FROM sync_map')));
    ok('8. even a full scan of 20,000 rows through the policy stays under a second', tScopedUn < 1000, `${tScopedUn.toFixed(0)} ms`);

    // ── 9. refusals are logged; the startup self-test and its fallback
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    await throws(() => asA(() => pool.query('SELECT user_id FROM acc_tokens WHERE user_id > 0')));
    await throws(() => asA(() => pool.query('SELECT user_id FROM acc_tokens WHERE user_id > 0')));
    await throws(() => asA(() => pool.query("INSERT INTO projects(name, tenant_id, tenant_license_id) VALUES ('sneak2', $1, $2)", [tB, LB])));
    console.warn = origWarn;
    const denied = warnings.filter((w) => /^\[rls\] The restricted role was refused/.test(w));
    ok('9. a statement the restricted role is refused is logged (once per distinct statement), so swallowed errors still show up', denied.length === 2 && /acc_tokens/.test(denied[0]) && /row-level security/.test(denied[1]), JSON.stringify(denied));
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    const active = await pool.selfTest();
    console.log = origLog;
    ok('9. the startup self-test passes on a correctly set-up database and says RLS is on', active === true && logs.some((l) => /Row-level security is ON/.test(l)), JSON.stringify(logs));
    // a broken restricted pool: the self-test must switch restricted mode off, loudly, not take the app down
    const realConnect = pool.restricted.connect.bind(pool.restricted);
    pool.restricted.connect = async () => ({ query: async () => { throw new Error('role "app_rls" does not exist'); }, release() {} });
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); };
    const after = await pool.selfTest();
    console.error = origErr;
    pool.restricted.connect = realConnect;
    ok('9. if the restricted role does not work the self-test switches RLS off with a loud error', after === false && pool.rlsOn === false && errs.some((e) => /running WITHOUT row-level security/.test(e)), JSON.stringify(errs));
    const fallback = await asA(() => pool.query('SELECT name FROM projects'));
    ok('9. ...and the app keeps working on the unrestricted pool (it can still read its data)', names(fallback.rows) === 'PA,PB');

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
    if (pool) await pool.end().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
