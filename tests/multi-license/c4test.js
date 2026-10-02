// Multi-license regression test — see tests/multi-license/README.md
// Chunk 4 test, in a throwaway schema (never the live tables): the license drop-down's
// server side (/auth/me licenses, PUT /api/me/current-license, greyed licenses) and the
// operator console routes (/api/operator/*, operator-only accounts).
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
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_c4')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_c4';
const PORT = 3064;
const SECRET = process.env.SESSION_SECRET || 'test-secret';
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAILS = ['op@x.com', 'oponly@x.com', 'ownera@x.com', 'dual@x.com', 'solo@x.com', 'nolic@x.com', 'buyer@new.com', 'second@new.com'];

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let proc = null;
  let log = '';
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    await db.query(fs.readFileSync('src/db/schema.sql', 'utf8'));
    await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)');

    const mkUser = async (email, role = 'member', op = false) => (await q('INSERT INTO users(email, role, name, is_operator) VALUES ($1,$2,$3,$4) RETURNING id', [email, role, email.split('@')[0], op]))[0].id;
    const U = {};
    U.op = await mkUser('op@x.com', 'license_admin', true);       // an operator who also administers license A
    U.oponly = await mkUser('oponly@x.com', 'member', true);       // an operator with no license at all
    U.ownera = await mkUser('ownera@x.com', 'primary_license_admin');
    U.dual = await mkUser('dual@x.com');                           // member of A, B, C
    U.solo = await mkUser('solo@x.com');                           // member of A only
    U.nolic = await mkUser('nolic@x.com');                         // in no license
    const tA = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Company A', $1) RETURNING id", [U.ownera]))[0].id;
    const tB = (await q("INSERT INTO tenants(name) VALUES ('Company B') RETURNING id"))[0].id;
    const mkLic = async (t, name, starts, expires) => (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at) VALUES ($1,$2,5,$3,$4,now()) RETURNING id", [t, name, starts, expires]))[0].id;
    const daysFromToday = async (n) => (await q("SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') AS d", [n]))[0].d;
    const L = {};
    L.a = await mkLic(tA, 'A-US', '2020-01-01', '2035-01-01');
    L.b = await mkLic(tB, 'B-EU', '2020-01-01', '2035-01-01');
    L.c = await mkLic(tA, 'A-old', '2020-01-01', await daysFromToday(-5));      // expired, greyed
    L.gone = await mkLic(tA, 'A-gone', '2020-01-01', await daysFromToday(-60)); // expired > 30 days: off every list
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin'), ($1,$3,'license_admin'), ($1,$4,'member'), ($1,$5,'member')", [L.a, U.op, U.ownera, U.dual, U.solo]);
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'member'), ($3,$2,'member'), ($4,$2,'member')", [L.b, U.dual, L.c, L.gone]);
    const mkProject = async (name, lic, t) => (await q(
      `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, revizto_license_uuid, tenant_id, tenant_license_id)
       VALUES ($1,$2,'virginia','hub',$3,$4,'LIC',$5,$6) RETURNING id`, [name, 'rv-' + name, 'b.' + name, U.ownera, t, lic]))[0].id;
    const PA = await mkProject('PA', L.a, tA), PB = await mkProject('PB', L.b, tB);
    await q("INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'standard'), ($1,$3,'standard'), ($4,$2,'standard')", [PA, U.dual, U.solo, PB]);
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dual, L.a]);
    const exp = new Date(Date.now() + 3600e3); // the projects' owner is connected, so member lists can be read (faked) — as in c3test
    await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [U.ownera, 'a', 'b', exp]);
    await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [U.ownera, exp]);

    proc = spawn(process.execPath, ['-r', path.join(SCRATCH, 'preload.js'), 'src/server.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), TEST_SCHEMA: SCHEMA, TEST_EMAILS: EMAILS.join(','), SESSION_SECRET: SECRET, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => (log += d));
    proc.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/auth/me`); break; } catch { await wait(500); } }
    await wait(500);

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
    const as = async (k) => session(U[k]);
    const EXPIRED = 'License has expired. Contact your administrator.', SUSPENDED = 'License is suspended. Contact your administrator.';

    // ── 1. /auth/me lists the licenses for the drop-down
    let c = await as('dual');
    let me = (await call(c, '/auth/me')).body;
    const names = (me.licenses || []).map((l) => l.name).sort().join(',');
    ok('1. a member of A, B and an expired C sees A-US, B-EU, A-old (the 30-day-old one is gone)', names === 'A-US,A-old,B-EU', names);
    ok('1. the open license is flagged current (A-US)', me.licenses.filter((l) => l.current).map((l) => l.name).join() === 'A-US');
    const oldEntry = me.licenses.find((l) => l.name === 'A-old');
    ok('1. the expired license is listed greyed: usable false, phase expired, with its message', oldEntry && oldEntry.usable === false && oldEntry.phase === 'expired' && oldEntry.message === EXPIRED, JSON.stringify(oldEntry));
    ok('1. every entry carries its company name for the "license · company" label', me.licenses.every((l) => l.companyName) && me.licenses.find((l) => l.name === 'B-EU').companyName === 'Company B');
    me = (await call(await as('solo'), '/auth/me')).body;
    ok('1. a one-license person gets a one-entry list (the page shows no drop-down)', me.licenses.length === 1 && me.licenses[0].name === 'A-US');

    // ── 2. switching the open license
    c = await as('dual');
    let r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: L.b } });
    ok('2. switching to B (usable) works', r.status === 200 && r.body.currentLicenseId === L.b, JSON.stringify(r));
    me = (await call(c, '/auth/me')).body;
    ok('2. /auth/me now shows B current, with only B\'s projects', me.licenses.find((l) => l.current)?.name === 'B-EU' && me.projects.map((p) => p.name).join() === 'PB', JSON.stringify([me.licenses, me.projects.map((p) => p.name)]));
    r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: L.a } });
    me = (await call(c, '/auth/me')).body;
    ok('2. ...and back to A shows only A\'s projects', r.status === 200 && me.projects.map((p) => p.name).join() === 'PA');
    r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: L.c } });
    ok('2. choosing the expired license answers 409 with "License has expired…" and does not switch', r.status === 409 && r.body.error === EXPIRED && r.body.code === 'license_blocked', JSON.stringify(r));
    me = (await call(c, '/auth/me')).body;
    ok('2. the open license is unchanged after that (still A-US)', me.licenses.find((l) => l.current)?.name === 'A-US');
    r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: L.gone } });
    ok('2. a license 30+ days past expiry is a 404 (off every list)', r.status === 404, JSON.stringify(r));
    c = await as('solo');
    r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: L.b } });
    ok("2. a license they aren't a member of is a 404 (cannot probe it)", r.status === 404);
    for (const bad of ['abc', null, 0, -1, 99999]) {
      r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: bad } });
      if (r.status !== 404) ok(`2. bad license id ${JSON.stringify(bad)} is refused`, false, JSON.stringify(r));
    }
    ok('2. junk license ids are all 404', true);
    await q('UPDATE tenant_licenses SET suspended_at = now() WHERE id = $1', [L.b]);
    c = await as('dual');
    r = await call(c, '/api/me/current-license', { method: 'PUT', body: { licenseId: L.b } });
    ok('2. a suspended license answers 409 "License is suspended…"', r.status === 409 && r.body.error === SUSPENDED, JSON.stringify(r));
    me = (await call(c, '/auth/me')).body;
    const susp = me.licenses.find((l) => l.name === 'B-EU');
    ok('2. ...and is listed greyed (usable false, phase suspended)', susp && !susp.usable && susp.phase === 'suspended');
    await q('UPDATE tenant_licenses SET suspended_at = NULL WHERE id = $1', [L.b]);

    // ── 3. a license that expires while it is the open one: the person falls through to another
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dual, L.c]);
    me = (await call(await as('dual'), '/auth/me')).body;
    ok('3. open license expired but another works: they land on a usable one (not signed out)', me.user && me.licenses.find((l) => l.current)?.usable === true, JSON.stringify(me.licenses));

    // ── 4. operator console is operator-only
    const opC = await as('op');
    for (const [who, k] of [['a license admin', 'ownera'], ['a member', 'solo']]) {
      r = await call(await as(k), '/api/operator/companies');
      ok(`4. ${who} (not an operator) gets 403 on the console API`, r.status === 403, JSON.stringify(r));
    }
    r = await fetch(`http://localhost:${PORT}/api/operator/companies`);
    ok('4. a signed-out request is refused (401)', r.status === 401);
    r = await call(await as('ownera'), '/api/operator/companies', { method: 'POST', body: { name: 'Hack Co' } });
    ok('4. a non-operator cannot create a company (403)', r.status === 403 && !(await q("SELECT 1 FROM tenants WHERE name = 'Hack Co'")).length);
    r = await call(opC, '/api/operator/companies');
    ok('4. the operator lists companies with licenses (all phases, expired and gone included)', r.status === 200 && r.body.companies.length === 2 && r.body.companies.find((x) => x.name === 'Company A').licenses.length === 3, JSON.stringify(r.body).slice(0, 300));
    ok('4. the listing carries no project or issue data', !/"PA"|"PB"|rv-PA/.test(JSON.stringify(r.body)));
    ok('4. the operator page itself is served', (await fetch(`http://localhost:${PORT}/operator`)).status === 200);

    // ── 5. create company + license + invite the buyer
    r = await call(opC, '/api/operator/companies', { method: 'POST', body: { name: 'New Co', timezone: 'America/New_York' } });
    ok('5. create a company', r.status === 200 && r.body.company.timezone === 'America/New_York', JSON.stringify(r));
    const newId = r.body.company.id;
    r = await call(opC, '/api/operator/companies', { method: 'POST', body: { name: 'new co' } });
    ok('5. the same company name (any case) is refused (409)', r.status === 409);
    r = await call(opC, '/api/operator/companies', { method: 'POST', body: { name: 'Zed', timezone: 'Mars/Phobos' } });
    ok('5. a bad timezone is refused (400)', r.status === 400);
    r = await call(opC, '/api/operator/companies', { method: 'POST', body: { name: '  ' } });
    ok('5. a blank name is refused (400)', r.status === 400);
    const start = await daysFromToday(0), end = await daysFromToday(365);
    r = await call(opC, `/api/operator/companies/${newId}/licenses`, { method: 'POST', body: { name: 'New US', slotCapacity: 4, startsOn: start, expiresOn: end, note: 'INV-1' } });
    ok('5. create the first license', r.status === 200 && r.body.id, JSON.stringify(r));
    const nl = r.body.id;
    const row = (await q("SELECT slot_capacity, to_char(starts_on,'YYYY-MM-DD') s, to_char(expires_on,'YYYY-MM-DD') e, settings_copied_at, suspended_at, note FROM tenant_licenses WHERE id = $1", [nl]))[0];
    ok('5. it has its slots, dates and note, and settings_copied_at set (never inherits another company\'s pause)', row.slot_capacity === 4 && row.s === start && row.e === end && row.settings_copied_at && !row.suspended_at && row.note === 'INV-1', JSON.stringify(row));
    r = await call(opC, `/api/operator/companies/${newId}/licenses`, { method: 'POST', body: { name: 'NEW us', slotCapacity: 1, startsOn: start, expiresOn: end } });
    ok('5. a second license with the same name (any case) in that company is refused (409)', r.status === 409, JSON.stringify(r));
    r = await call(opC, `/api/operator/companies/${tB}/licenses`, { method: 'POST', body: { name: 'NEW US', slotCapacity: 1, startsOn: start, expiresOn: end } });
    ok('5. ...but the same name in a different company is fine', r.status === 200);
    r = await call(opC, `/api/operator/companies/${newId}/licenses`, { method: 'POST', body: { name: 'Bad dates', slotCapacity: 1, startsOn: end, expiresOn: start } });
    ok('5. expiry before start is refused (400)', r.status === 400);
    r = await call(opC, `/api/operator/companies/${newId}/licenses`, { method: 'POST', body: { name: 'Bad slots', slotCapacity: -2, startsOn: start, expiresOn: end } });
    ok('5. negative slots are refused (400)', r.status === 400);
    r = await call(opC, `/api/operator/companies/${newId}/licenses`, { method: 'POST', body: { name: 'Bad date', slotCapacity: 1, startsOn: '2026-02-31', expiresOn: end } });
    ok('5. an impossible date is refused (400)', r.status === 400);
    r = await call(opC, '/api/operator/companies/99999/licenses', { method: 'POST', body: { name: 'x', slotCapacity: 1, startsOn: start, expiresOn: end } });
    ok('5. a license on an unknown company is a 404', r.status === 404);

    r = await call(opC, `/api/operator/licenses/${nl}/admins`, { method: 'POST', body: { email: 'Buyer@New.com ' } });
    ok('5. invite the buyer as the first license admin', r.status === 200 && r.body.accountOwner === true, JSON.stringify(r));
    const buyer = (await q("SELECT id, role FROM users WHERE email = 'buyer@new.com'"))[0];
    const owner = (await q('SELECT account_owner_user_id FROM tenants WHERE id = $1', [newId]))[0].account_owner_user_id;
    const mem = await q('SELECT role FROM license_members WHERE tenant_license_id = $1 AND user_id = $2', [nl, buyer?.id]);
    ok('5. they become the company\'s account owner and a license admin of that license (and only that one)', owner === buyer?.id && mem[0]?.role === 'license_admin' && (await q('SELECT 1 FROM license_members WHERE user_id = $1', [buyer.id])).length === 1);
    ok('5. the invitation is recorded', (await q("SELECT 1 FROM invites WHERE email = 'buyer@new.com' AND role = 'license_admin'")).length === 1);
    r = await call(opC, `/api/operator/licenses/${nl}/admins`, { method: 'POST', body: { email: 'second@new.com' } });
    const owner2 = (await q('SELECT account_owner_user_id FROM tenants WHERE id = $1', [newId]))[0].account_owner_user_id;
    ok('5. a second admin does not replace the account owner', r.status === 200 && r.body.accountOwner === false && owner2 === buyer.id);
    r = await call(opC, `/api/operator/licenses/${nl}/admins`, { method: 'POST', body: { email: 'nope' } });
    ok('5. a bad email is refused (400)', r.status === 400);
    r = await call(opC, '/api/operator/licenses/99999/admins', { method: 'POST', body: { email: 'a@b.com' } });
    ok('5. an unknown license is a 404', r.status === 404);

    // The new buyer sees only their own license, none of A or B
    const buyerMe = (await call(await session(buyer.id), '/auth/me'));
    ok('5. the invited buyer (no connections yet) is not signed out, and sees only "New US"', buyerMe.status === 200 && buyerMe.body.user && buyerMe.body.licenses.map((l) => l.name).join() === 'New US', JSON.stringify(buyerMe.body.licenses));

    // ── 6. renew / slots / suspend
    r = await call(opC, `/api/operator/licenses/${nl}`, { method: 'PATCH', body: { slotCapacity: 9, expiresOn: await daysFromToday(730), name: 'New US (renewed)' } });
    const row2 = (await q("SELECT slot_capacity, to_char(expires_on,'YYYY-MM-DD') e, name FROM tenant_licenses WHERE id = $1", [nl]))[0];
    ok('6. change slots, renew the expiry and rename', r.status === 200 && row2.slot_capacity === 9 && row2.e === (await daysFromToday(730)) && row2.name === 'New US (renewed)', JSON.stringify(row2));
    r = await call(opC, `/api/operator/licenses/${L.b}`, { method: 'PATCH', body: { name: 'new us (renewed)' } });
    ok('6. renaming onto another license of the SAME company would clash; a different company is fine', r.status === 200);
    r = await call(opC, `/api/operator/licenses/${L.c}`, { method: 'PATCH', body: { name: 'a-us' } });
    ok('6. renaming onto a name taken in the same company is refused (409)', r.status === 409, JSON.stringify(r));
    r = await call(opC, `/api/operator/licenses/${nl}`, { method: 'PATCH', body: { expiresOn: '2000-01-01' } });
    ok('6. an expiry before the start is refused (400)', r.status === 400);
    // renew the expired A-old: it becomes usable for its members
    await call(opC, `/api/operator/licenses/${L.c}`, { method: 'PATCH', body: { expiresOn: await daysFromToday(200) } });
    me = (await call(await as('dual'), '/auth/me')).body;
    ok('6. renewing the greyed license makes it usable again in the drop-down', me.licenses.find((l) => l.name === 'A-old')?.usable === true);
    // downgrade below usage -> suspended by itself
    await call(opC, `/api/operator/licenses/${L.a}`, { method: 'PATCH', body: { slotCapacity: 0 } });
    me = (await call(await as('ownera'), '/auth/me')).body;
    ok('6. lowering slots below the projects in use suspends it (over limit), its admin is kept in, limited', me.license?.phase === 'suspended' && me.license.adminLimited === true, JSON.stringify(me.license));
    await call(opC, `/api/operator/licenses/${L.a}`, { method: 'PATCH', body: { slotCapacity: 5 } });
    r = await call(opC, `/api/operator/licenses/${L.a}/suspend`, { method: 'POST' });
    me = (await call(await as('solo'), '/auth/me'));
    ok('6. suspending by the operator blocks its members with the suspended message', r.status === 200 && me.body.user === null && me.body.accessDenied === SUSPENDED, JSON.stringify(me));
    r = await call(opC, `/api/operator/licenses/${L.a}/unsuspend`, { method: 'POST' });
    me = (await call(await as('solo'), '/auth/me')).body;
    ok('6. reactivating restores it', r.status === 200 && me.user && me.licenses[0].usable === true);
    r = await call(opC, '/api/operator/licenses/99999/suspend', { method: 'POST' });
    ok('6. suspending an unknown license is a 404', r.status === 404);
    const list = (await call(opC, '/api/operator/companies')).body.companies;
    const newCo = list.find((x) => x.name === 'New Co');
    ok('6. the console listing shows the new company, owner, slots, admins', newCo.accountOwnerEmail === 'buyer@new.com' && newCo.licenses[0].slotCapacity === 9 && newCo.licenses[0].admins.length === 2, JSON.stringify(newCo));

    // ── 7. an operator with no license of their own
    const ooC = await as('oponly');
    me = await call(ooC, '/auth/me');
    ok('7. an operator with no license stays signed in (isOperator, role label Operator)', me.status === 200 && me.body.user?.isOperator === true && me.body.user.roleLabel === 'Operator' && me.body.licenses.length === 0, JSON.stringify(me.body).slice(0, 300));
    r = await call(ooC, '/api/operator/companies');
    ok('7. ...and can use the console', r.status === 200);
    for (const p of ['/api/projects', '/api/license/projects', '/api/license/admins', `/api/projects/${PA}/team`]) {
      r = await call(ooC, p);
      ok(`7. ...but ${p} is refused (403) — no project data without a license`, r.status === 403, JSON.stringify(r));
    }
    r = await call(await as('nolic'), '/auth/me');
    ok('7. a non-operator with no license is still signed out (no user, access-denied message)', r.body.user === null && !!r.body.accessDenied, JSON.stringify(r));
    ok('7. the operator flag is not settable through any route', (await q("SELECT count(*)::int n FROM users WHERE is_operator")) [0].n === 2);

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
