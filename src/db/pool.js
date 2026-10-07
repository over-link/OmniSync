/**
 * db/pool.js
 * The app's Postgres access. Everything imports `pool` from here.
 *
 * Two kinds of connection (docs/multi-tenant-architecture.md, row-level security):
 *   - the ADMIN pool: the app's normal database user. In Supabase that user bypasses
 *     row-level security, so it sees every license's rows. Used for login, sessions,
 *     tokens, the poller, webhooks, migrations and anything that must look across
 *     licenses (pool.admin).
 *   - the RESTRICTED pool (RLS_MODE=on only): connections that run as the `app_rls`
 *     role, which cannot bypass RLS, with `app.license_id` set to the license the
 *     signed-in person has open. The policies in schema.sql then show only that
 *     license's rows — so a query that forgets its license filter returns nothing
 *     of another license's instead of leaking it.
 *
 * `pool.query()` / `pool.connect()` pick the restricted pool when the request is
 * inside a license scope (pool.runScoped — routes/auth.js does this once the person's
 * license is known) and the admin pool otherwise, so background jobs and everything
 * before sign-in work as before. With RLS_MODE unset or "off" (the default) nothing is
 * restricted: pool.query is exactly the old single pool.
 *
 * Restricted connections remember which license they were last set for, so an idle one
 * already set for the right license costs no extra round trip. (Session-level settings:
 * Supabase's session pooler, port 5432, keeps them for the life of the connection.)
 */
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

let RLS_ON = String(process.env.RLS_MODE || 'off').toLowerCase() === 'on'; // false again if the startup self-test fails
const ROLE = 'app_rls';

const config = () => ({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  // Supabase's session pooler allows only 15 connections in all (EMAXCONNSESSION), and a deploy
  // briefly runs the old and the new instance together — so with two pools each is small.
  max: Number(process.env.DB_POOL_MAX) || (RLS_ON ? 5 : 10),
});

const admin = new Pool(config());
admin.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
});

const restricted = RLS_ON ? new Pool(config()) : null; // (created while RLS_ON is still the configured value)
if (restricted) {
  restricted.on('error', (err) => {
    console.error('[db] Unexpected error on idle restricted client', err);
  });
}

const scope = new AsyncLocalStorage(); // { licenseId } for the request being handled

/**
 * A statement the restricted role was refused (no privilege, or a row-level security check)
 * is logged — callers that swallow errors would otherwise hide a query that needs classifying
 * (does it belong on pool.admin?). Once per distinct statement.
 */
const _denied = new Set();
function _logDenied(err, args) {
  if (err?.code !== '42501' && !/row-level security/.test(err?.message || '')) return;
  const sql = String(typeof args[0] === 'string' ? args[0] : args[0]?.text || '').replace(/\s+/g, ' ').slice(0, 140);
  if (_denied.has(sql)) return;
  _denied.add(sql);
  console.warn(`[rls] The restricted role was refused (${err.message}): ${sql}`);
}

/** A restricted connection set up for `licenseId` (role + license), ready to use. */
async function restrictedClient(licenseId) {
  const client = await restricted.connect();
  if (client.__licenseTag !== licenseId) {
    try {
      // One round trip: become the restricted role and say which license is open.
      await client.query("SELECT set_config('role', $1, false), set_config('app.license_id', $2, false)", [ROLE, String(licenseId)]);
      client.__licenseTag = licenseId;
    } catch (err) {
      client.release(err); // a connection in an unknown state is thrown away
      throw err;
    }
  }
  return client;
}

const pool = {
  /** The unrestricted pool (a real pg.Pool — also what the session store uses). */
  admin,
  /** The restricted pool, or null when RLS_MODE isn't on. */
  restricted,
  rlsOn: RLS_ON,

  /**
   * Runs fn() inside the scope of one license: every pool.query / pool.connect it
   * makes (also in what it awaits) goes through the restricted role. No-op when
   * RLS_MODE isn't on or there is no license.
   */
  runScoped(licenseId, fn) {
    if (!RLS_ON || !Number.isInteger(Number(licenseId)) || !licenseId) return fn();
    return scope.run({ licenseId: Number(licenseId) }, fn);
  },

  /** Is the current call inside a license scope? (for tests) */
  scopedLicenseId() {
    return RLS_ON ? scope.getStore()?.licenseId ?? null : null;
  },

  async query(...args) {
    const store = RLS_ON ? scope.getStore() : null;
    if (!store) return admin.query(...args);
    const client = await restrictedClient(store.licenseId);
    try {
      return await client.query(...args);
    } catch (err) {
      _logDenied(err, args);
      throw err;
    } finally {
      client.release();
    }
  },

  async connect() {
    const store = RLS_ON ? scope.getStore() : null;
    if (!store) return admin.connect();
    return restrictedClient(store.licenseId);
  },

  /**
   * Run once at startup when RLS_MODE=on: proves the restricted role works (it exists, the app's
   * user may switch to it, it can't bypass RLS, and with no license set it sees no projects).
   * If not, restricted mode is switched OFF with a loud error rather than leaving the app unable to
   * read its own data — the unrestricted pool keeps working. Returns true when restricted mode is active.
   */
  async selfTest() {
    if (!RLS_ON) return false;
    try {
      const client = await restricted.connect();
      try {
        await client.query("SELECT set_config('role', $1, false), set_config('app.license_id', '', false)", [ROLE]);
        const { rows } = await client.query("SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass, (SELECT count(*)::int FROM projects) AS projects");
        if (rows[0].u !== ROLE || rows[0].bypass || rows[0].projects !== 0) throw new Error(`unexpected state ${JSON.stringify(rows[0])}`);
        console.log('[rls] Row-level security is ON: requests inside a license run as the restricted role.');
        client.release();
        return true;
      } catch (err) {
        client.release(err);
        throw err;
      }
    } catch (err) {
      RLS_ON = false;
      pool.rlsOn = false;
      console.error(`[rls] RLS_MODE=on but the restricted role does not work (${err.message}) — running WITHOUT row-level security. Run npm run migrate, or set RLS_MODE=off.`);
      return false;
    }
  },

  on(...args) {
    return admin.on(...args);
  },

  async end() {
    await admin.end();
    if (restricted) await restricted.end();
  },
};

module.exports = pool;
