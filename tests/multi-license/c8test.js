// Multi-license regression test — see tests/multi-license/README.md
// Primary operator + the operator audit trail (chunk 8): the migration's backfill, who may add / remove operators,
// the guarantees that protect a primary operator, and the activity log. Throwaway schema; email is faked.
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
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_c8')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_c8';
const PORT = 3068;
const SECRET = process.env.SESSION_SECRET || 'test-secret';
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAILS = ['prime@x.com', 'second@x.com', 'third@x.com', 'cust@a.com', 'plain@x.com', 'fresh@x.com', 'fresh2@x.com', 'fresh3@x.com', 'fresh4@x.com'];

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let proc = null;
  let log = '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-'));
  const mailFile = path.join(tmp, 'mail.jsonl');
  const modeFile = path.join(tmp, 'mode');
  fs.writeFileSync(modeFile, 'off');
  const mails = () => (fs.existsSync(mailFile) ? fs.readFileSync(mailFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const schemaSql = fs.readFileSync('src/db/schema.sql', 'utf8');
    await db.query(schemaSql);
    await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)');

    const mkUser = async (email, role = 'member', op = false) => (await q('INSERT INTO users(email, role, name, is_operator) VALUES ($1,$2,$3,$4) RETURNING id', [email, role, email.split('@')[0], op]))[0].id;
    // three operators exist before the migration adds the primary flag; the lowest id must become the primary
    const U = { prime: await mkUser('prime@x.com', 'member', true), second: await mkUser('second@x.com', 'member', true), third: await mkUser('third@x.com', 'member', true), cust: await mkUser('cust@a.com', 'license_admin'), plain: await mkUser('plain@x.com') };

    // ── 0. the migration's backfill
    await db.query('ALTER TABLE users DROP COLUMN is_primary_operator'); // as before the migration
    await db.query(schemaSql);
    let flags = Object.fromEntries((await q('SELECT email, is_primary_operator AS p FROM users')).map((r) => [r.email, r.p]));
    ok('0. migration: when the column is added the LOWEST-id existing operator becomes the primary, nobody else', flags['prime@x.com'] === true && flags['second@x.com'] === false && flags['third@x.com'] === false && flags['cust@a.com'] === false, JSON.stringify(flags));
    await q("UPDATE users SET is_primary_operator = false WHERE email = 'prime@x.com'"); await q("UPDATE users SET is_primary_operator = true WHERE email = 'prime@x.com'");
    await db.query(schemaSql);
    flags = Object.fromEntries((await q('SELECT email, is_primary_operator AS p FROM users')).map((r) => [r.email, r.p]));
    ok('0. migrating again changes nothing (the backfill runs only when the column is added)', flags['prime@x.com'] === true && flags['second@x.com'] === false);
    ok('0. the audit table exists, is empty and has RLS switched on', (await q('SELECT count(*)::int n FROM operator_audit'))[0].n === 0 && (await q("SELECT relrowsecurity r FROM pg_class WHERE relname = 'operator_audit' AND relnamespace = current_schema()::regnamespace"))[0].r === true);

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
      const r = await fetch(`http://localhost:${PORT}${p}`, { method: opts.method || 'GET', headers: { cookie: cookie || '', 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
      let body = null; try { body = await r.json(); } catch { /* not json */ }
      return { status: r.status, body };
    };
    const prime = await session(U.prime), second = await session(U.second), cust = await session(U.cust);
    const isOp = async (email) => (await q('SELECT is_operator o FROM users WHERE email = $1', [email]))[0]?.o;
    const audit = async () => q('SELECT actor_email, action, detail FROM operator_audit ORDER BY id');

    // ── 1. the list: every operator can read it, only a primary can change it
    let r = await call(prime, '/api/operator/operators');
    ok('1. a primary operator sees the operators (primary first) and canManage', r.status === 200 && r.body.canManage === true && r.body.operators.map((o) => o.email).join() === 'prime@x.com,second@x.com,third@x.com' && r.body.operators[0].isPrimary === true && r.body.operators[1].isPrimary === false, JSON.stringify(r.body));
    r = await call(second, '/api/operator/operators');
    ok('1. a regular operator sees the same list but canManage is false', r.status === 200 && r.body.canManage === false && r.body.operators.length === 3);
    ok("1. a customer's license admin gets 403, a signed-out request gets 401", (await call(cust, '/api/operator/operators')).status === 403 && (await call(null, '/api/operator/operators')).status === 401);
    r = await call(prime, '/auth/me'); const r2 = await call(second, '/auth/me');
    ok('1. /auth/me tells the page who is primary (for the UI)', r.body.user.isOperator === true && r.body.user.isPrimaryOperator === true && r2.body.user.isOperator === true && r2.body.user.isPrimaryOperator === false, JSON.stringify([r.body.user, r2.body.user]));

    // ── 2. adding operators
    for (const [label, cookie] of [['a regular operator', second], ["a customer's license admin", cust]]) {
      r = await call(cookie, '/api/operator/operators', { method: 'POST', body: { email: 'plain@x.com' } });
      ok(`2. ${label} cannot add an operator (403)`, r.status === 403 && (await isOp('plain@x.com')) === false, JSON.stringify(r));
    }
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'plain@x.com' } });
    ok('2. a primary adds an existing account', r.status === 200 && r.body.created === false && (await isOp('plain@x.com')) === true, JSON.stringify(r));
    ok('2. ...as a regular operator, never a primary', (await q("SELECT is_primary_operator p FROM users WHERE email = 'plain@x.com'"))[0].p === false);
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'Fresh@X.com ', isPrimary: true, is_primary_operator: true } });
    ok('2. a brand-new email creates the account (any case) and the operator flag; asking for primary is ignored', r.status === 200 && r.body.created === true && (await isOp('fresh@x.com')) === true && (await q("SELECT is_primary_operator p, role FROM users WHERE email = 'fresh@x.com'"))[0].p === false, JSON.stringify(r));
    const before = (await audit()).length;
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'plain@x.com' } });
    ok('2. adding someone who already is an operator is a no-op (no duplicate audit row)', r.status === 200 && r.body.alreadyOperator === true && (await audit()).length === before);
    for (const bad of ['', 'nope', '   ']) {
      r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: bad } });
      if (r.status !== 400) ok(`2. bad email "${bad}" is refused (400)`, false, JSON.stringify(r));
    }
    ok('2. a blank / malformed email is refused (400)', true);
    // email: not configured -> added anyway, with a note; configured -> sent; failing -> added anyway
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'fresh2@x.com', sendEmail: true } });
    ok("2. email not set up: they are added and the answer says nothing was sent", r.status === 200 && (await isOp('fresh2@x.com')) === true && /Email isn't set up/.test(r.body.emailError) && mails().length === 0, JSON.stringify(r));
    fs.writeFileSync(modeFile, 'ok');
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'fresh3@x.com', sendEmail: true } });
    ok('2. email set up: one invitation goes to them, as a platform operator, from the primary', r.status === 200 && r.body.emailSent === true && mails().length === 1 && mails()[0].toEmail === 'fresh3@x.com' && mails()[0].role === 'platform operator' && mails()[0].invitedByEmail === 'prime@x.com', JSON.stringify([r.body, mails()]));
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'fresh4@x.com', sendEmail: false } });
    ok('2. "email them" off: nothing is sent', r.status === 200 && mails().length === 1 && (await isOp('fresh4@x.com')) === true);
    fs.writeFileSync(modeFile, 'fail');
    r = await call(prime, '/api/operator/operators', { method: 'POST', body: { email: 'plain2@x.com', sendEmail: true } });
    ok('2. a failing mail server still adds them, and says the email failed', r.status === 200 && (await isOp('plain2@x.com')) === true && /smtp down/.test(r.body.emailError), JSON.stringify(r));
    fs.writeFileSync(modeFile, 'off');
    // the new person can use the console straight away (even with no license)
    const fresh = await session((await q("SELECT id FROM users WHERE email = 'fresh@x.com'"))[0].id);
    r = await call(fresh, '/api/operator/companies');
    ok('2. a newly added operator with no license can use the console at once', r.status === 200, JSON.stringify(r));
    r = await call(fresh, '/api/operator/operators', { method: 'POST', body: { email: 'x@x.com' } });
    ok('2. ...but cannot add operators themselves (403)', r.status === 403);

    // ── 3. removing operators
    r = await call(second, `/api/operator/operators/${(await q("SELECT id FROM users WHERE email = 'third@x.com'"))[0].id}`, { method: 'DELETE' });
    ok('3. a regular operator cannot remove one (403)', r.status === 403 && (await isOp('third@x.com')) === true);
    const thirdId = (await q("SELECT id FROM users WHERE email = 'third@x.com'"))[0].id;
    const third = await session(thirdId);
    ok('3. (before) that operator can use the console', (await call(third, '/api/operator/companies')).status === 200);
    await q("INSERT INTO tenants(name) VALUES ('Keep Co')");
    r = await call(prime, `/api/operator/operators/${thirdId}`, { method: 'DELETE' });
    ok('3. a primary removes a regular operator', r.status === 200 && (await isOp('third@x.com')) === false, JSON.stringify(r));
    // (an operator with no license has nothing else to sign in to, so their session simply ends: 401; one with a license gets 403)
    r = await call(third, '/api/operator/companies');
    ok('3. ...who loses the console at their very next request (no data: 401 session ended, or 403)', [401, 403].includes(r.status) && !r.body?.companies, JSON.stringify(r));
    ok('3. ...but keeps their account', (await q('SELECT 1 FROM users WHERE id = $1', [thirdId])).length === 1);
    r = await call(prime, `/api/operator/operators/${U.prime}`, { method: 'DELETE' });
    ok('3. a primary cannot remove themselves (400, says it is changed in the database)', r.status === 400 && /database/.test(r.body.error) && (await isOp('prime@x.com')) === true, JSON.stringify(r));
    await q("UPDATE users SET is_primary_operator = true WHERE email = 'second@x.com'"); // a second primary, set in the database
    const second2 = await session(U.second);
    r = await call(second2, `/api/operator/operators/${U.prime}`, { method: 'DELETE' });
    ok('3. one primary cannot remove another primary either (400)', r.status === 400 && (await isOp('prime@x.com')) === true);
    r = await call(second2, '/api/operator/operators', { method: 'POST', body: { email: 'viaSecond@x.com' } });
    ok('3. every primary can add operators (the flag, not who is first, decides)', r.status === 200 && (await isOp('viasecond@x.com')) === true);
    await q("UPDATE users SET is_primary_operator = false WHERE email = 'second@x.com'");
    r = await call(prime, '/api/operator/operators/99999', { method: 'DELETE' });
    ok('3. an unknown id is a 404', r.status === 404);
    r = await call(prime, `/api/operator/operators/${U.cust}`, { method: 'DELETE' });
    ok("3. someone who isn't an operator is a 404, and unchanged", r.status === 404 && (await q("SELECT role FROM users WHERE email = 'cust@a.com'"))[0].role === 'license_admin');
    ok('3. there is still a primary operator (the app can never remove the last way back in)', (await q('SELECT count(*)::int n FROM users WHERE is_operator AND is_primary_operator'))[0].n >= 1);

    // ── 3b. operators set up only the FIRST license admin, and never an operator
    const co = (await call(prime, '/api/operator/companies', { method: 'POST', body: { name: 'First Admin Co' } })).body.company.id;
    const mkLicense = async (name) => (await call(prime, `/api/operator/companies/${co}/licenses`, { method: 'POST', body: { name, slotCapacity: 2, startsOn: '2020-01-01', expiresOn: '2035-01-01' } })).body.id;
    const licA = await mkLicense('Lic A'), licB = await mkLicense('Lic B');
    const invite = (cookie, lic, email) => call(cookie, `/api/operator/licenses/${lic}/admins`, { method: 'POST', body: { email } });
    const adminRows = (lic) => q("SELECT u.email FROM license_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_license_id = $1 AND m.role = 'license_admin'", [lic]);
    r = await invite(prime, licA, 'buyer@first.com');
    ok('3b. the first license admin (the buyer) can be invited, and becomes the account owner', r.status === 200 && r.body.accountOwner === true && (await adminRows(licA)).length === 1, JSON.stringify(r));
    r = await invite(prime, licA, 'another@first.com');
    ok('3b. a second one is refused (409) for a primary operator, with the reason', r.status === 409 && /already has a license admin/.test(r.body.error) && /customer's own/.test(r.body.error), JSON.stringify(r));
    r = await invite(second, licA, 'another@first.com');
    ok('3b. ...and for a regular operator', r.status === 409);
    ok('3b. a refused invite creates nothing: no account, no membership, no invitation record, no audit row', (await q("SELECT 1 FROM users WHERE email = 'another@first.com'")).length === 0 && (await adminRows(licA)).length === 1 && (await q("SELECT 1 FROM invites WHERE email = 'another@first.com'")).length === 0 && !(await audit()).some((x) => /another@first.com/.test(x.detail || '')));
    r = await invite(prime, licA, 'prime@x.com');
    ok('3b. an operator cannot add themselves to a license (409 here: it already has an admin)', r.status === 409 && (await adminRows(licA)).every((a) => a.email !== 'prime@x.com'));
    for (const [label, cookie, email] of [['a primary operator adds themselves', prime, 'prime@x.com'], ['a regular operator adds themselves', second, 'second@x.com'], ['an operator adds another operator', prime, 'plain@x.com']]) {
      r = await invite(cookie, licB, email);
      ok(`3b. ${label} as the first admin of an empty license: refused (400, operators can't be license admins)`, r.status === 400 && /Operators can't be made license admins/.test(r.body.error) && (await adminRows(licB)).length === 0, JSON.stringify(r));
    }
    ok("3b. ...and nothing changed for them: no membership of either new license", (await q('SELECT 1 FROM license_members WHERE user_id = ANY($1) AND tenant_license_id = ANY($2)', [[U.prime, U.second], [licA, licB]])).length === 0);
    r = await invite(prime, licB, 'Buyer2@First.com');
    ok('3b. a customer contact is fine as the first admin of the next license (any email case)', r.status === 200 && (await adminRows(licB)).length === 1 && r.body.accountOwner === false, JSON.stringify(r));
    // a license left with no admin can be given a new first one
    const buyer1 = (await q("SELECT id FROM users WHERE email = 'buyer@first.com'"))[0].id;
    await call(prime, `/api/operator/companies/${co}`, { method: 'PATCH', body: { accountOwnerEmail: 'buyer2@first.com' } });
    r = await call(prime, `/api/operator/licenses/${licA}/admins/${buyer1}`, { method: 'DELETE' });
    ok('3b. (setup) the first admin is removed from a license, leaving none', r.status === 200 && (await adminRows(licA)).length === 0, JSON.stringify(r));
    r = await invite(prime, licA, 'replacement@first.com');
    ok('3b. a license left with no admin can be given a new first one', r.status === 200 && (await adminRows(licA)).length === 1, JSON.stringify(r));
    r = await invite(prime, licA, 'someone.else@first.com');
    ok('3b. ...but only one', r.status === 409);

    // ── 4. the audit trail
    const rows = await audit();
    ok("4. operator management is recorded with who did it", rows.some((x) => x.action === 'operator_added' && x.actor_email === 'prime@x.com' && /fresh@x.com/.test(x.detail) && /new account/.test(x.detail)) && rows.some((x) => x.action === 'operator_removed' && /third@x.com/.test(x.detail)), JSON.stringify(rows.slice(0, 3)));
    // other operator actions are recorded too
    const cr = await call(second, '/api/operator/companies', { method: 'POST', body: { name: 'Audit Co', timezone: 'America/Chicago' } });
    const company = cr.body.company.id;
    const lr = await call(second, `/api/operator/companies/${company}/licenses`, { method: 'POST', body: { name: 'Audit One', slotCapacity: 2, startsOn: '2020-01-01', expiresOn: '2035-01-01' } });
    await call(second, `/api/operator/licenses/${lr.body.id}`, { method: 'PATCH', body: { slotCapacity: 3 } });
    await call(second, `/api/operator/licenses/${lr.body.id}/suspend`, { method: 'POST' });
    await call(second, `/api/operator/licenses/${lr.body.id}/unsuspend`, { method: 'POST' });
    await call(second, `/api/operator/licenses/${lr.body.id}`, { method: 'DELETE', body: { confirmName: 'Audit One' } });
    await call(second, `/api/operator/companies/${company}`, { method: 'DELETE', body: { confirmName: 'Audit Co' } });
    const acts = (await audit()).filter((x) => x.actor_email === 'second@x.com').map((x) => x.action);
    ok('4. company and license actions are recorded under the operator who did them', ['company_created', 'license_created', 'license_changed', 'license_suspended', 'license_reactivated', 'license_deleted', 'company_deleted'].every((a) => acts.includes(a)), acts.join());
    r = await call(prime, '/api/operator/activity');
    ok('4. the activity list is newest first and carries actor, action and a readable detail', r.status === 200 && r.body.activity.length >= 10 && r.body.activity[0].action === 'company_deleted' && r.body.activity.every((a) => a.actor && a.action && a.detail && a.at) && r.body.activity[0].id > r.body.activity[1].id, JSON.stringify(r.body.activity.slice(0, 2)));
    ok('4. a regular operator can read it too; a customer admin cannot (403)', (await call(second, '/api/operator/activity')).status === 200 && (await call(cust, '/api/operator/activity')).status === 403);
    ok('4. ?limit works and is clamped', (await call(prime, '/api/operator/activity?limit=2')).body.activity.length === 2 && (await call(prime, '/api/operator/activity?limit=99999')).body.activity.length <= 500 && (await call(prime, '/api/operator/activity?limit=abc')).status === 200);
    // an audit-table failure must never block the action itself
    await db.query('ALTER TABLE operator_audit RENAME TO operator_audit_off');
    const cr2 = await call(prime, '/api/operator/companies', { method: 'POST', body: { name: 'No Trail Co' } });
    await db.query('ALTER TABLE operator_audit_off RENAME TO operator_audit');
    ok('4. if the trail cannot be written the action still succeeds (and a warning is logged)', cr2.status === 200 && /Could not record the audit trail entry/.test(log), JSON.stringify(cr2));

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
