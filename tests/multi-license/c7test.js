// Multi-license regression test — see tests/multi-license/README.md
// Operator console actions (chunk 7): rename a company, change its timezone / account owner, remove a license
// admin, resend an invitation, delete a license, delete a company. Throwaway schema; email is faked.
const REPO = require('path').resolve(__dirname, '../..');
const SCRATCH = __dirname;
process.chdir(REPO);
require('dotenv').config({ path: '.env' });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sign = require('cookie-signature').sign;
const pg = require('pg');
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_c7')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_c7';
const PORT = 3067;
const SECRET = process.env.SESSION_SECRET || 'test-secret';
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAILS = ['op@x.com', 'owner@a.com', 'adm2@a.com', 'adm3@a.com', 'multi@a.com', 'plain@a.com', 'ownerb@b.com', 'newbie@a.com'];

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let proc = null;
  let log = '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-'));
  const mailFile = path.join(tmp, 'mail.jsonl');
  const modeFile = path.join(tmp, 'mode');
  fs.writeFileSync(modeFile, 'off');
  const mails = () => (fs.existsSync(mailFile) ? fs.readFileSync(mailFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    await db.query(fs.readFileSync('src/db/schema.sql', 'utf8'));
    await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)');

    const mkUser = async (email, role = 'member', op = false) => (await q('INSERT INTO users(email, role, name, is_operator) VALUES ($1,$2,$3,$4) RETURNING id', [email, role, email.split('@')[0], op]))[0].id;
    const U = { op: await mkUser('op@x.com', 'member', true), owner: await mkUser('owner@a.com', 'primary_license_admin'), adm2: await mkUser('adm2@a.com', 'license_admin'), adm3: await mkUser('adm3@a.com', 'license_admin'), multi: await mkUser('multi@a.com', 'license_admin'), plain: await mkUser('plain@a.com'), ownerb: await mkUser('ownerb@b.com', 'primary_license_admin') };
    const tA = (await q("INSERT INTO tenants(name, timezone, account_owner_user_id) VALUES ('Alpha Co', 'America/Los_Angeles', $1) RETURNING id", [U.owner]))[0].id;
    const tB = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Beta Co', $1) RETURNING id", [U.ownerb]))[0].id;
    const tC = (await q("INSERT INTO tenants(name) VALUES ('Empty Co') RETURNING id"))[0].id;
    const mkLic = async (t, name) => (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at) VALUES ($1,$2,9,'2020-01-01','2035-01-01',now()) RETURNING id", [t, name]))[0].id;
    const L = { a1: await mkLic(tA, 'Alpha One'), a2: await mkLic(tA, 'Alpha Two'), a3: await mkLic(tA, 'Alpha Three (empty)'), b1: await mkLic(tB, 'Beta One') };
    const adm = (lic, u, role = 'license_admin') => q('INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,$3)', [lic, u, role]);
    await adm(L.a1, U.owner); await adm(L.a1, U.adm2); await adm(L.a1, U.multi); await adm(L.a1, U.plain, 'member');
    await adm(L.a2, U.owner); await adm(L.a2, U.multi); await adm(L.a2, U.adm3);   // multi administers two Alpha licenses
    await adm(L.a3, U.adm3);
    await adm(L.b1, U.ownerb);
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.plain, L.a3]);   // plain has a3 open but is not even a member; adm3's open license is a3
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.adm3, L.a3]);
    const mkProject = async (name, lic, t, archived) => (await q(`INSERT INTO projects(name, owner_user_id, tenant_id, tenant_license_id, archived_at) VALUES ($1,$2,$3,$4,${archived ? 'now()' : 'NULL'}) RETURNING id`, [name, U.owner, t, lic]))[0].id;
    await mkProject('PA1', L.a1, tA, false);
    await mkProject('PA2-archived', L.a2, tA, true);

    proc = spawn(process.execPath, ['-r', path.join(SCRATCH, 'preload.js'), '-r', path.join(SCRATCH, 'preload-email.js'), 'src/server.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), TEST_SCHEMA: SCHEMA, TEST_EMAILS: EMAILS.join(','), SESSION_SECRET: SECRET, NODE_ENV: 'test', TEST_MAIL_FILE: mailFile, TEST_MODE_FILE: modeFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => (log += d));
    proc.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/auth/me`); break; } catch { await wait(500); } }
    await wait(1000);

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
    const op = await session(U.op);
    const listing = async () => (await call(op, '/api/operator/companies')).body;
    const role = async (lic, u) => (await q('SELECT role FROM license_members WHERE tenant_license_id = $1 AND user_id = $2', [lic, u]))[0]?.role || null;
    const globalRole = async (u) => (await q('SELECT role FROM users WHERE id = $1', [u]))[0].role;

    // ── 0. only operators
    const nonOp = await session(U.owner);
    for (const [label, method, url, body] of [
      ['rename / timezone / owner', 'PATCH', `/api/operator/companies/${tA}`, { name: 'Hack' }],
      ['delete company', 'DELETE', `/api/operator/companies/${tC}`, { confirmName: 'Empty Co' }],
      ['delete license', 'DELETE', `/api/operator/licenses/${L.a3}`, { confirmName: 'Alpha Three (empty)' }],
      ['remove license admin', 'DELETE', `/api/operator/licenses/${L.a1}/admins/${U.adm2}`, null],
      ['resend invitation', 'POST', `/api/operator/licenses/${L.a1}/admins/${U.adm2}/resend`, {}],
    ]) {
      const r = await call(nonOp, url, { method, body });
      ok(`0. ${label}: a customer's license admin gets 403`, r.status === 403, JSON.stringify(r));
    }
    ok('0. ...and nothing changed', (await q("SELECT name FROM tenants WHERE id = $1", [tA]))[0].name === 'Alpha Co' && (await role(L.a1, U.adm2)) === 'license_admin');

    // ── 1. the listing carries what the console needs
    let l = await listing();
    const alpha = l.companies.find((c) => c.name === 'Alpha Co');
    const a1 = alpha.licenses.find((x) => x.name === 'Alpha One');
    ok('1. the listing says whether email can be sent', l.emailConfigured === false);
    ok('1. admins carry their id and whether they are the account owner', a1.admins.every((a) => a.userId && typeof a.isOwner === 'boolean') && a1.admins.find((a) => a.email === 'owner@a.com').isOwner === true && a1.admins.find((a) => a.email === 'adm2@a.com').isOwner === false, JSON.stringify(a1.admins));
    ok('1. every license carries its project count (archived ones included)', a1.projectCount === 1 && alpha.licenses.find((x) => x.name === 'Alpha Two').projectCount === 1 && alpha.licenses.find((x) => x.name.startsWith('Alpha Three')).projectCount === 0);

    // ── 2. company: rename, timezone, owner
    let r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { name: 'Alpha Holdings' } });
    ok('2. rename a company', r.status === 200 && (await q('SELECT name FROM tenants WHERE id = $1', [tA]))[0].name === 'Alpha Holdings', JSON.stringify(r));
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { name: 'beta CO' } });
    ok("2. a name another company has (any case) is refused (409)", r.status === 409, JSON.stringify(r));
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { name: 'ALPHA holdings' } });
    ok('2. changing only the capitalisation of its OWN name is fine', r.status === 200 && (await q('SELECT name FROM tenants WHERE id = $1', [tA]))[0].name === 'ALPHA holdings');
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { name: '   ' } });
    ok('2. a blank name is refused (400)', r.status === 400);
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { timezone: 'Europe/Berlin' } });
    ok('2. change the timezone', r.status === 200 && (await q('SELECT timezone FROM tenants WHERE id = $1', [tA]))[0].timezone === 'Europe/Berlin' && (await q('SELECT name FROM tenants WHERE id = $1', [tA]))[0].name === 'ALPHA holdings');
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { timezone: 'Mars/Phobos' } });
    ok('2. an invalid timezone is refused (400) and nothing changes', r.status === 400 && (await q('SELECT timezone FROM tenants WHERE id = $1', [tA]))[0].timezone === 'Europe/Berlin');
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: 'adm2@a.com' } });
    ok('2. change the account owner to a license admin of one of its licenses', r.status === 200 && (await q('SELECT account_owner_user_id AS o FROM tenants WHERE id = $1', [tA]))[0].o === U.adm2, JSON.stringify(r));
    ok('2. ...the previous owner keeps their license-admin access', (await role(L.a1, U.owner)) === 'license_admin' && (await role(L.a2, U.owner)) === 'license_admin');
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: 'plain@a.com' } });
    ok('2. a plain member cannot be made owner (400)', r.status === 400 && /license admin/.test(r.body.error), JSON.stringify(r));
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: 'ownerb@b.com' } });
    ok("2. an admin of ANOTHER company cannot be made owner (400)", r.status === 400);
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: 'nobody@nowhere.com' } });
    ok('2. an unknown email cannot be made owner (400)', r.status === 400);
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: '' } });
    ok('2. an empty owner is refused (400)', r.status === 400);
    ok('2. ...and the owner is still adm2', (await q('SELECT account_owner_user_id AS o FROM tenants WHERE id = $1', [tA]))[0].o === U.adm2);
    r = await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { name: 'Alpha Co', timezone: 'America/Los_Angeles', accountOwnerEmail: 'OWNER@a.com' } });
    ok('2. all three at once, owner email in any case', r.status === 200 && (await q('SELECT name, timezone, account_owner_user_id AS o FROM tenants WHERE id = $1', [tA]))[0].o === U.owner, JSON.stringify(r));
    r = await call(op, '/api/operator/companies/99999', { method: 'PATCH', body: { name: 'x' } });
    ok('2. an unknown company is a 404', r.status === 404);

    // ── 3. remove a license admin
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.owner}`, { method: 'DELETE' });
    ok("3. the account owner can't be removed (400, says to change the owner first)", r.status === 400 && /account owner/.test(r.body.error) && (await role(L.a1, U.owner)) === 'license_admin', JSON.stringify(r));
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.adm2}`, { method: 'DELETE' });
    ok('3. remove an admin: they become a plain member of that license', r.status === 200 && (await role(L.a1, U.adm2)) === 'member', JSON.stringify(r));
    ok("3. ...they keep their account, and the older global role is lowered (admin nowhere else)", (await q('SELECT 1 FROM users WHERE id = $1', [U.adm2])).length === 1 && (await globalRole(U.adm2)) === 'member');
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.multi}`, { method: 'DELETE' });
    ok('3. an admin of two licenses removed from one stays admin of the other', r.status === 200 && (await role(L.a1, U.multi)) === 'member' && (await role(L.a2, U.multi)) === 'license_admin' && (await globalRole(U.multi)) === 'license_admin');
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.adm2}`, { method: 'DELETE' });
    ok('3. removing someone who is no longer an admin is a 404', r.status === 404);
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.plain}`, { method: 'DELETE' });
    ok('3. a plain member is not an admin: 404, and they are unchanged', r.status === 404 && (await role(L.a1, U.plain)) === 'member');
    r = await call(op, `/api/operator/licenses/${L.b1}/admins/${U.adm3}`, { method: 'DELETE' });
    ok("3. an admin of another license is not an admin of this one: 404", r.status === 404 && (await role(L.a2, U.adm3)) === 'license_admin');
    r = await call(op, '/api/operator/licenses/99999/admins/1', { method: 'DELETE' });
    ok('3. an unknown license is a 404', r.status === 404);
    await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: 'adm3@a.com' } });
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.owner}`, { method: 'DELETE' });
    ok('3. once the owner is changed, the old owner can be removed from a license', r.status === 200 && (await role(L.a1, U.owner)) === 'member');
    await call(op, `/api/operator/companies/${tA}`, { method: 'PATCH', body: { accountOwnerEmail: 'owner@a.com' } }).catch(() => {});

    // ── 4. resend the invitation
    r = await call(op, `/api/operator/licenses/${L.a2}/admins/${U.adm3}/resend`, { method: 'POST' });
    ok("4. email not configured: 409 with a plain explanation, nothing recorded", r.status === 409 && /Email isn't set up/.test(r.body.error) && (await q("SELECT 1 FROM invites WHERE email = 'adm3@a.com'")).length === 0 && mails().length === 0, JSON.stringify(r));
    fs.writeFileSync(modeFile, 'ok');
    r = await call(op, `/api/operator/licenses/${L.a2}/admins/${U.adm3}/resend`, { method: 'POST' });
    ok('4. email configured: sent once, to that person, as a license admin', r.status === 200 && mails().length === 1 && mails()[0].toEmail === 'adm3@a.com' && mails()[0].role === 'license admin' && mails()[0].invitedByEmail === 'op@x.com', JSON.stringify([r, mails()]));
    ok('4. ...and recorded as an invitation that was sent', (await q("SELECT email_sent FROM invites WHERE email = 'adm3@a.com'")).map((x) => x.email_sent).join() === 'true');
    ok('4. ...without changing their role or anything else', (await role(L.a2, U.adm3)) === 'license_admin');
    fs.writeFileSync(modeFile, 'fail');
    r = await call(op, `/api/operator/licenses/${L.a2}/admins/${U.adm3}/resend`, { method: 'POST' });
    ok('4. a failing mail server: 502 with its message, recorded as not sent', r.status === 502 && /smtp down/.test(r.body.error) && (await q("SELECT email_sent, email_error FROM invites WHERE email = 'adm3@a.com' ORDER BY id DESC LIMIT 1"))[0].email_sent === false, JSON.stringify(r));
    r = await call(op, `/api/operator/licenses/${L.a1}/admins/${U.plain}/resend`, { method: 'POST' });
    ok('4. a member who is not an admin: 404 (this action is for license admins)', r.status === 404);
    fs.writeFileSync(modeFile, 'off');
    l = await listing();
    ok('4. the listing reports email as not configured again', l.emailConfigured === false);

    // ── 5. delete a license
    r = await call(op, `/api/operator/licenses/${L.a1}`, { method: 'DELETE', body: { confirmName: 'Alpha One' } });
    ok('5. a license with a project cannot be deleted (409, says how many)', r.status === 409 && /1 project/.test(r.body.error) && (await q('SELECT 1 FROM tenant_licenses WHERE id = $1', [L.a1])).length === 1, JSON.stringify(r));
    r = await call(op, `/api/operator/licenses/${L.a2}`, { method: 'DELETE', body: { confirmName: 'Alpha Two' } });
    ok('5. ...archived projects count too', r.status === 409 && /archived/.test(r.body.error));
    r = await call(op, `/api/operator/licenses/${L.a3}`, { method: 'DELETE', body: { confirmName: 'wrong name' } });
    ok('5. the exact name must be typed (400 otherwise)', r.status === 400 && (await q('SELECT 1 FROM tenant_licenses WHERE id = $1', [L.a3])).length === 1, JSON.stringify(r));
    r = await call(op, `/api/operator/licenses/${L.a3}`, { method: 'DELETE' });
    ok('5. no confirmation at all is refused too', r.status === 400);
    r = await call(op, `/api/operator/licenses/${L.a3}`, { method: 'DELETE', body: { confirmName: 'Alpha Three (empty)' } });
    ok('5. an empty license is deleted', r.status === 200 && (await q('SELECT 1 FROM tenant_licenses WHERE id = $1', [L.a3])).length === 0, JSON.stringify(r));
    ok('5. ...its memberships go, the people stay', (await q('SELECT 1 FROM license_members WHERE tenant_license_id = $1', [L.a3])).length === 0 && (await q('SELECT 1 FROM users WHERE id = $1', [U.adm3])).length === 1);
    ok('5. ...a person who had it open is simply left with none open (and keeps their other licenses)', (await q('SELECT current_license_id AS c FROM users WHERE id = $1', [U.adm3]))[0].c === null && (await role(L.a2, U.adm3)) === 'license_admin');
    ok('5. ...other licenses and their projects are untouched', (await q('SELECT count(*)::int n FROM projects')).length === 1 && (await q('SELECT count(*)::int n FROM projects'))[0].n === 2);
    l = await listing();
    ok('5. the listing no longer shows it', !l.companies.flatMap((c) => c.licenses).some((x) => x.name.startsWith('Alpha Three')));
    r = await call(op, `/api/operator/licenses/${L.a3}`, { method: 'DELETE', body: { confirmName: 'Alpha Three (empty)' } });
    ok('5. deleting it again is a 404', r.status === 404);

    // ── 6. delete a company
    r = await call(op, `/api/operator/companies/${tB}`, { method: 'DELETE', body: { confirmName: 'Beta Co' } });
    ok('6. a company that still has a license cannot be deleted (409)', r.status === 409 && /1 license/.test(r.body.error) && (await q('SELECT 1 FROM tenants WHERE id = $1', [tB])).length === 1, JSON.stringify(r));
    r = await call(op, `/api/operator/companies/${tC}`, { method: 'DELETE', body: { confirmName: 'empty co' } });
    ok('6. the exact name (with its capitalisation) must be typed', r.status === 400 && (await q('SELECT 1 FROM tenants WHERE id = $1', [tC])).length === 1);
    r = await call(op, `/api/operator/companies/${tC}`, { method: 'DELETE', body: { confirmName: 'Empty Co' } });
    ok('6. a company with no licenses is deleted', r.status === 200 && (await q('SELECT 1 FROM tenants WHERE id = $1', [tC])).length === 0, JSON.stringify(r));
    r = await call(op, `/api/operator/companies/${tC}`, { method: 'DELETE', body: { confirmName: 'Empty Co' } });
    ok('6. deleting it again is a 404', r.status === 404);
    // delete licenses of Beta then the company
    r = await call(op, `/api/operator/licenses/${L.b1}`, { method: 'DELETE', body: { confirmName: 'Beta One' } });
    r = await call(op, `/api/operator/companies/${tB}`, { method: 'DELETE', body: { confirmName: 'Beta Co' } });
    ok('6. ...after its licenses are deleted, a company can go', r.status === 200 && (await q('SELECT 1 FROM tenants WHERE id = $1', [tB])).length === 0, JSON.stringify(r));
    ok('6. nothing else was disturbed: Alpha, its licenses and projects are intact', (await q('SELECT count(*)::int n FROM tenant_licenses'))[0].n === 2 && (await q('SELECT count(*)::int n FROM tenants'))[0].n === 1);

    if (process.env.RLS_MODE === 'on') ok('(RLS on) the restricted role was never silently refused a query that should be classified', !log.includes('[rls] The restricted role was refused'), log.split('\n').filter((x) => x.includes('[rls] The restricted role was refused')).join('\n'));
    ok('the server logged no unhandled errors', !/Unhandled error/.test(log), log.split('\n').filter((x) => /Unhandled/.test(x)).slice(0, 3).join('\n'));
    const failed = results.filter(([, p]) => !p);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
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
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
