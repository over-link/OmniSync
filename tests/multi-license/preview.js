// Preview of the multi-license UI — NOT a test. Seeds a throwaway schema (tst_preview) with two companies,
// four licenses (one expired, one suspended), a few people and projects, starts the app on PORT (default 3070)
// with all outbound HTTP faked (preload.js) and prints a session cookie per person. Nothing touches the live
// tables or any real Revizto/ACC account. Stop it with Ctrl+C: the schema is dropped.
//   node tests/multi-license/preview.js
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
{ const Orig = pg.Pool; pg.Pool = class extends Orig { constructor(c) { super(c); this.on('connect', (cl) => cl.query('SET search_path TO tst_preview')); } }; }
process.env.POLL_ENABLED = 'false';

const SCHEMA = 'tst_preview';
const PORT = process.env.PORT || 3070;
const SECRET = process.env.SESSION_SECRET || 'test-secret';
const EMAILS = ['operator@demo.test', 'amy@demo.test', 'dan@demo.test', 'bob@demo.test'];

(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  let proc;
  const cleanup = async () => {
    if (proc) proc.kill();
    await db.query('SET search_path TO public').catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.query(`CREATE SCHEMA ${SCHEMA}`);
  await db.query(`SET search_path TO ${SCHEMA}`);
  await db.query(fs.readFileSync('src/db/schema.sql', 'utf8'));
  await db.query('CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)');

  const mkUser = async (email, name, role, op = false) => (await q('INSERT INTO users(email, role, name, is_operator, license_role_verified_at) VALUES ($1,$2,$3,$4, now()) RETURNING id', [email, role, name, op]))[0].id;
  const U = {
    operator: await mkUser('operator@demo.test', 'Olivia Operator', 'member', true),
    amy: await mkUser('amy@demo.test', 'Amy Admin', 'primary_license_admin'),
    dan: await mkUser('dan@demo.test', 'Dan Dual', 'member'),
    bob: await mkUser('bob@demo.test', 'Bob Builder', 'primary_license_admin'),
    sam: await mkUser('sam@demo.test', 'Sam Support', 'member', true), // a regular operator (not primary)
  };
  await q('UPDATE users SET is_primary_operator = true WHERE id = $1', [U.operator]); // the primary operator, as set in the database
  const tA = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Acme Construction', $1) RETURNING id", [U.amy]))[0].id;
  const tB = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Beta Builders', $1) RETURNING id", [U.bob]))[0].id;
  const day = async (n) => (await q("SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date + $1::int, 'YYYY-MM-DD') AS d", [n]))[0].d;
  const mkLic = async (t, name, slots, expires, suspended = false) => (await q(`INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, starts_on, expires_on, settings_copied_at, suspended_at) VALUES ($1,$2,$3,'2020-01-01',$4,now(), ${suspended ? 'now()' : 'NULL'}) RETURNING id`, [t, name, slots, expires]))[0].id;
  await q("INSERT INTO tenants(name) VALUES ('Gamma Group (no licenses yet)')");
  const L = {
    us: await mkLic(tA, 'Acme US', 5, '2035-01-01'),
    eu: await mkLic(tA, 'Acme EU', 3, await day(12)), // expiring soon, to show the operator console's filters
    old: await mkLic(tA, 'Acme 2025 plan', 2, await day(-6)),
    sandbox: await mkLic(tA, 'Acme sandbox (empty)', 2, '2035-01-01'), // no projects: can be deleted from the operator console
    beta: await mkLic(tB, 'Beta main', 4, await day(40)),
    betaSusp: await mkLic(tB, 'Beta trial', 1, '2035-01-01', true),
  };
  const adminOf = async (lic, u) => q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin')", [lic, u]);
  const memberOf = async (lic, u) => q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'member')", [lic, u]);
  await adminOf(L.us, U.amy); await adminOf(L.eu, U.amy); await adminOf(L.old, U.amy); await adminOf(L.beta, U.bob);
  await adminOf(L.sandbox, U.amy);
  await adminOf(L.us, U.operator);                                   // the operator also administers a license, to see both sides
  await memberOf(L.us, U.dan); await memberOf(L.beta, U.dan); await memberOf(L.old, U.dan); await memberOf(L.betaSusp, U.dan);
  const T = { [L.us]: tA, [L.eu]: tA, [L.old]: tA, [L.sandbox]: tA, [L.beta]: tB, [L.betaSusp]: tB };
  const mkProject = async (name, lic, { rv = null, acc = null, accName = null } = {}) => (await q(
    `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, acc_project_name, owner_user_id, revizto_license_uuid, tenant_id, tenant_license_id)
     VALUES ($1,$2,'virginia',$3,$4,$5,$6,'LIC',$7,$8) RETURNING id`, [name, rv, acc ? 'hub' : null, acc, accName, lic === L.beta ? U.bob : U.amy, T[lic], lic]))[0].id;
  const P = {
    harbor: await mkProject('Harbor Tower', L.us, { rv: 'rv-1', acc: 'b.harbor', accName: 'Harbor Tower (ACC)' }),
    bridge: await mkProject('Riverside Bridge', L.us, { rv: 'rv-2', acc: 'b.bridge', accName: 'Riverside Bridge (ACC)' }),
    newp: await mkProject('Airport Annex (new)', L.us),
    paused: await mkProject('Harbor Tower — old copy', L.us, { rv: 'rv-9', acc: 'b.harbor', accName: 'Harbor Tower (ACC)' }),
    eu1: await mkProject('Rotterdam Depot', L.eu, { rv: 'rv-3', acc: 'b.rot', accName: 'Rotterdam (ACC)' }),
    old1: await mkProject('Legacy School', L.old, { rv: 'rv-4', acc: 'b.school', accName: 'School (ACC)' }),
    beta1: await mkProject('Beta Warehouse', L.beta, { rv: 'rv-5', acc: 'b.wh', accName: 'Warehouse (ACC)' }),
  };
  await q("INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'standard'), ($3,$2,'standard')", [P.harbor, U.dan, P.beta1]);
  const exp = new Date(Date.now() + 14 * 86400e3);
  for (const u of Object.values(U)) {
    await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [u, 'a', 'b', exp]);
    await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [u, exp]);
  }
  await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.amy, L.us]);
  await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.bob, L.beta]);
  await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dan, L.us]);
  await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.operator, L.us]);

  proc = spawn(process.execPath, ['-r', path.join(SCRATCH, 'preload.js'), '-r', path.join(SCRATCH, 'preload-pairing.js'), '-r', path.join(SCRATCH, 'preload-email.js'), 'src/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), TEST_SCHEMA: SCHEMA, TEST_EMAILS: EMAILS.join(','), SESSION_SECRET: SECRET, NODE_ENV: 'development', PUBLIC_BASE_URL: '', TEST_SMTP: 'ok', TEST_MAIL_FILE: path.join(require('os').tmpdir(), 'preview-mail.jsonl') }, // mail is faked: 'Resend invite' works and sends nothing
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const cookies = {};
  for (const [k, id] of Object.entries(U)) {
    const u = (await q('SELECT id, email, role, password_version FROM users WHERE id = $1', [id]))[0];
    const sid = crypto.randomBytes(16).toString('hex');
    const sess = { cookie: { originalMaxAge: 7 * 86400000, expires: new Date(Date.now() + 7 * 86400000).toISOString(), httpOnly: true, path: '/' }, userId: u.id, userEmail: u.email, role: u.role, signedInAt: Date.now(), passwordVersion: u.password_version };
    await q("INSERT INTO session(sid, sess, expire) VALUES ($1, $2, now() + interval '7 days')", [sid, sess]);
    cookies[k] = encodeURIComponent('s:' + sign(sid, SECRET));
  }
  fs.writeFileSync(path.join(process.env.PREVIEW_OUT || SCRATCH, 'preview-cookies.json'), JSON.stringify({ port: PORT, cookies }, null, 2));
  console.log(`\nPREVIEW READY on http://localhost:${PORT} — cookies in preview-cookies.json. Ctrl+C drops the preview schema.`);
})().catch((e) => { console.error('PREVIEW FAILED', e); process.exit(1); });
