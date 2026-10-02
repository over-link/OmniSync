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

const SCHEMA = 'tst_c2';
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

    // ── A. differential
    const from = new Date(Date.now() - 30 * 86400e3).toISOString(), to = new Date(Date.now() + 86400e3).toISOString();
    const endpoints = (pid1, pid2) => [
      '/auth/me', '/api/projects', `/api/projects/${pid1}/team`, `/api/projects/${pid2}/team`, '/api/license/admins', '/api/license/projects', '/api/audit-log',
      `/api/dashboards/sync-timeline?from=${from}&to=${to}&tz=America/Los_Angeles`, `/api/dashboards/activity?from=${from}&to=${to}&tz=America/Los_Angeles`,
      `/api/projects/${pid1}/invite-links`, `/api/projects/${pid1}/status-map`, `/api/projects/${P.p4}/team`,
    ];
    let compared = 0; const diffs = [];
    for (const user of Object.keys(C)) {
      for (const ep of endpoints(P.p1, P.p2)) {
        const [o, n] = [await get(3061, CO[user], ep), await get(3062, C[user], ep)];
        compared++;
        for (const list of [o.body?.projects, n.body?.projects]) for (const pr of list || []) { delete pr.sync_active; delete pr.pairing_paused; } // chunk 5's two additive project fields
        if (ep === '/auth/me' && n.body) { delete n.body.licenses; if (n.body.user) delete n.body.user.isOperator; } // chunk 4's two additive /auth/me fields (the license drop-down, the operator flag)
        if (o.status !== n.status || norm(o.body) !== norm(n.body)) diffs.push(`${user} ${ep}: old ${o.status} vs new ${n.status}\n   old=${norm(o.body)?.slice(0, 200)}\n   new=${norm(n.body)?.slice(0, 200)}`);
      }
    }
    ok(`A. old and new code answer identically on ${compared} requests (5 kinds of user x ${endpoints(0, 0).length} endpoints)`, diffs.length === 0, '\n' + diffs.slice(0, 4).join('\n'));
    const sanity = await get(3062, C.owner, '/api/projects'); console.log('DEBUG owner /api/projects ->', sanity.status, JSON.stringify(sanity.body).slice(0,200), '| outsider ->', (await get(3062, C.outsider, '/api/projects')).status);
    ok('A. (sanity) the license admin really sees the projects, the outsider none', sanity.status === 200 && sanity.body.projects.length === 3 && (await get(3062, C.outsider, '/api/projects')).status === 401);

    // ── B. second license
    const t2 = (await q("INSERT INTO tenants(name, account_owner_user_id) VALUES ('Company B', $1) RETURNING id", [U.adminb]))[0].id;
    const lB = (await q("INSERT INTO tenant_licenses(tenant_id, name, slot_capacity, expires_on) VALUES ($1,'B license', 5, '2030-01-01') RETURNING id", [t2]))[0].id;
    const lA = (await q('SELECT id FROM tenant_licenses WHERE tenant_id <> $1 LIMIT 1', [t2]))[0].id;
    await q('DELETE FROM license_members WHERE user_id = ANY($1)', [[U.adminb, U.memberb]]); // new people, only in B
    await q("INSERT INTO license_members(tenant_license_id, user_id, role) VALUES ($1,$2,'license_admin'), ($1,$3,'member'), ($1,$4,'member')", [lB, U.adminb, U.memberb, U.dual]);
    await q("UPDATE license_members SET role = 'license_admin' WHERE tenant_license_id = $1 AND user_id = $2", [lA, U.dual]); // dual: admin of A, member of B
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dual, lA]);
    const pb = (await q(
      `INSERT INTO projects(name, revizto_project_uuid, revizto_region, acc_hub_id, acc_project_id, owner_user_id, revizto_license_uuid, tenant_id, tenant_license_id)
       VALUES ('PB1','rv-PB1','virginia','hub','b.accb1',$1,'LIC-B',$2,$3) RETURNING id`, [U.adminb, t2, lB]))[0].id;
    await q("INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,'standard')", [pb, U.memberb]);
    await q("INSERT INTO audit_log(project_id, direction, action, outcome, detail, attributed_email) VALUES ($1,'revizto_to_acc','field_change','success','B-ONLY','adminb@x.com')", [pb]);
    await q('INSERT INTO acc_tokens(user_id, access_token, refresh_token, expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$4)', [U.adminb, 'a', 'b', exp]);
    await q("INSERT INTO revizto_tokens(user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, region) VALUES ($1,'a','b',$2,$2,'virginia')", [U.adminb, exp]);
    for (const k of ['adminb', 'memberb', 'dual']) C[k] = await session(U[k]);
    const N = (cookie, p, o) => get(3062, cookie, p, o);
    const names = (r) => (r.body?.projects || []).map((x) => x.name).sort().join(',');

    ok('B. A-admin lists only A projects', names(await N(C.owner, '/api/projects')) === 'P1,P2,P3-unpaired');
    ok('B. B-admin lists only B projects', names(await N(C.adminb, '/api/projects')) === 'PB1');
    ok('B. B-member lists only B projects', names(await N(C.memberb, '/api/projects')) === 'PB1');
    ok("B. License Administration projects: each admin sees only their own license's", names(await N(C.owner, '/api/license/projects')).replace('P4-archived,', '') === 'P1,P2,P3-unpaired,P4-archived'.replace('P4-archived,', '') && names(await N(C.adminb, '/api/license/projects')) === 'PB1');
    const adminsA = (await N(C.owner, '/api/license/admins')).body.admins.map((a) => a.email).sort().join(',');
    const adminsB = (await N(C.adminb, '/api/license/admins')).body.admins.map((a) => a.email).sort().join(',');
    ok("B. license-admin lists are per license (A: owner, adm2, dual — B: adminb only)", adminsA === 'adm2@x.com,dual@x.com,owner@x.com' && adminsB === 'adminb@x.com', `${adminsA} | ${adminsB}`);
    ok("B. A-admin can't open B's project (404) or its team", (await N(C.owner, `/api/projects/${pb}/team`)).status === 404 && (await N(C.owner, `/api/projects/${pb}/invite-links`)).status === 404);
    ok("B. B-admin can't open A's project (404)", (await N(C.adminb, `/api/projects/${P.p1}/team`)).status === 404);
    ok("B. A-admin's team list on A's project shows A's license admins only (no adminb)", !(await N(C.owner, `/api/projects/${P.p1}/team`)).body.members.some((m) => m.email === 'adminb@x.com'));
    ok("B. B's team list shows only B's license admin + members", (await N(C.adminb, `/api/projects/${pb}/team`)).body.members.map((m) => m.email).sort().join(',') === 'adminb@x.com,memberb@x.com');
    ok("B. A-admin can't invite into B's project (404), can't change B's pairing (404)", (await N(C.owner, `/api/projects/${pb}/team/invite`, { method: 'POST', body: { email: 'sneak@x.com', role: 'standard' } })).status === 404 && (await N(C.owner, `/api/projects/${pb}`, { method: 'PATCH', body: { name: 'x', revizto_license_uuid: 'L', revizto_project_uuid: 'r', acc_hub_id: 'h', acc_project_id: 'a' } })).status === 404);
    ok("B. A-admin can't archive / unarchive / delete B's project (404)", (await N(C.owner, `/api/license/projects/${pb}/archive`, { method: 'POST' })).status === 404 && (await N(C.owner, `/api/license/projects/${pb}/unarchive`, { method: 'POST' })).status === 404 && (await N(C.owner, `/api/license/projects/${pb}`, { method: 'DELETE' })).status === 404 && (await q('SELECT archived_at FROM projects WHERE id=$1', [pb]))[0].archived_at === null);
    const logA = JSON.stringify((await N(C.owner, '/api/audit-log')).body), logB = JSON.stringify((await N(C.adminb, '/api/audit-log')).body);
    ok("B. Activity Log is per license (A's has no B-ONLY row, B's has it and nothing of A)", !logA.includes('B-ONLY') && logB.includes('B-ONLY') && !logB.includes('"project_id":' + P.p1 + ','), '');
    const dashA = (await N(C.owner, `/api/dashboards/sync-timeline?from=${from}&to=${to}&tz=UTC`)).body, dashB = (await N(C.adminb, `/api/dashboards/sync-timeline?from=${from}&to=${to}&tz=UTC`)).body;
    ok("B. Dashboards count only the open license's linked issues (A: 2, B: 0)", (dashA.totalLinked ?? dashA.linkedTotal ?? JSON.stringify(dashA)).toString().length > 0 && JSON.stringify(dashA) !== JSON.stringify(dashB), JSON.stringify(dashB).slice(0, 120));
    ok("B. a standard member of B has no license-admin powers (403)", (await N(C.memberb, '/api/license/admins')).status === 403);
    ok("B. a license admin of A (also a member of B) can't touch B's project while A is open", (await N(C.dual, "/api/projects/" + pb + "/team")).status === 404 && (await N(C.dual, '/api/license/admins')).status === 200);
    await q('UPDATE users SET current_license_id = $2 WHERE id = $1', [U.dual, lB]);
    const fb = await N(C.dual, '/api/license/admins');
    ok('B. someone whose open license gives them nothing is moved to the license that does (not signed out)', fb.status === 200 && (await q('SELECT current_license_id FROM users WHERE id = $1', [U.dual]))[0].current_license_id === lA);

    // writes land in the right license only
    const inv = await N(C.owner, '/api/license/admins', { method: 'POST', body: { email: 'newadmin@x.com' } });
    const newId = (await q("SELECT id FROM users WHERE email='newadmin@x.com'"))[0]?.id;
    const memberships = await q('SELECT tenant_license_id, role FROM license_members WHERE user_id = $1', [newId]);
    ok("B. a license admin invited in A belongs to A only (not B)", inv.status === 200 && memberships.length === 1 && memberships[0].tenant_license_id === lA && memberships[0].role === 'license_admin');
    const inv2 = await N(C.pa, `/api/projects/${P.p1}/team/invite`, { method: 'POST', body: { email: 'newmember@x.com', role: 'standard' } });
    const m2 = await q("SELECT m.tenant_license_id, m.role FROM license_members m JOIN users u ON u.id = m.user_id WHERE u.email='newmember@x.com'");
    ok('B. a project invite in A brings the person into A only, as a member', inv2.status === 200 && m2.length === 1 && m2[0].tenant_license_id === lA && m2[0].role === 'member');
    const created = await N(C.owner, '/api/projects', { method: 'POST', body: { name: 'NewInA' } });
    const np = (await q("SELECT tenant_id, tenant_license_id FROM projects WHERE name='NewInA'"))[0];
    ok('B. a project created by an A-admin belongs to A', created.status === 200 && np && np.tenant_license_id === lA);
    const rm = await N(C.owner, `/api/license/admins/${newId}`, { method: 'DELETE' });
    ok('B. removing a license admin makes them a plain member of THAT license', rm.status === 200 && (await q('SELECT role FROM license_members WHERE user_id=$1', [newId]))[0].role === 'member' && (await q('SELECT role FROM users WHERE id=$1', [newId]))[0].role === 'member');
    ok("B. the company's account owner can't be removed", (await N(C.adm2, `/api/license/admins/${U.owner}`, { method: 'DELETE' })).status === 404);
    ok('B. nobody was swept into the other license by those writes', Number((await q('SELECT count(*) FROM license_members WHERE tenant_license_id = $1', [lB]))[0].count) === 3);
    ok('B. the new code logged no server errors', !/Error|error:|at .*\.js/.test(newP.getLog().split('\n').filter((l) => !/blocked in test|fake 404|No matching|SMTP|\[auth\]|\[license\]|\[webhook\]|\[team\]/.test(l)).join('\n')), newP.getLog().slice(-400));
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
