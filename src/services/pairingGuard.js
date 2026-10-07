/**
 * services/pairingGuard.js
 * One ACC project can be ACTIVELY fed by only ONE Revizto project in the whole
 * app (docs/multi-tenant-architecture.md "Licenses may share a Revizto license,
 * but an ACC project can only be fed by ONE Revizto project"): two sources
 * writing into one place would create duplicates. One Revizto project paired
 * with several ACC projects is fine.
 *
 * "Active" = projects.sync_active: the project is paired, not archived and its
 * license is usable (services/licenseState.js). A partial unique index on
 * (acc_project_id) WHERE sync_active makes a second active pairing impossible in
 * the database itself, even from two admins saving at once. Because license
 * state changes with the calendar, refresh() re-evaluates the flag (every poll
 * tick, at startup, and after anything that changes pairing / archive / license
 * terms). When two projects want the same ACC project the one that is already
 * active keeps it; the other stays paused ("pairing_paused") with a notice,
 * nothing is deleted, and it resumes by itself once the other is archived,
 * re-paired, deleted or its license ends. So after a license expires, the same
 * ACC project can be re-paired under the new license.
 *
 * All writers take one global advisory lock, so checks and flips never race.
 */
// Unrestricted on purpose: db/pool.js (row-level security) — this module looks across licenses / holds per-user secrets.
const pool = require('../db/pool').admin;
const licenseState = require('./licenseState');

const LOCK_KEY = 'pairing_guard';

class AccProjectAlreadyPairedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'acc_project_already_paired';
  }
}

const alreadyPairedMessage = (licenseName) =>
  licenseName
    ? `This ACC project is already paired with a Revizto project under ${licenseName}. Archive or re-pair that one first.`
    : 'This ACC project is already paired with a Revizto project by another account. Archive or re-pair that one first.';

/** Takes the guard lock for the rest of the transaction `db` is in. */
async function lock(db) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
}

/**
 * Re-evaluates projects.sync_active for every project. Call inside a
 * transaction that holds the lock (use refresh() for a standalone one).
 */
async function refreshLocked(db) {
  const usable = (await licenseState.loadAll(db)).filter((l) => l.state.usable).map((l) => l.id);
  const { rows } = await db.query(
    `SELECT id, acc_project_id, sync_active FROM projects
     WHERE revizto_project_uuid IS NOT NULL AND acc_project_id IS NOT NULL AND archived_at IS NULL
       AND (tenant_license_id IS NULL OR tenant_license_id = ANY($1::int[]))
     ORDER BY id`,
    [usable]
  );
  // One winner per ACC project: the one already active keeps it, else the oldest.
  const winners = new Map();
  for (const r of rows) {
    const cur = winners.get(r.acc_project_id);
    if (!cur || (r.sync_active && !cur.sync_active)) winners.set(r.acc_project_id, r);
  }
  const winnerIds = [...winners.values()].map((r) => r.id);
  await db.query('UPDATE projects SET sync_active = false WHERE sync_active AND NOT (id = ANY($1::int[]))', [winnerIds]);
  await db.query('UPDATE projects SET sync_active = true WHERE NOT sync_active AND id = ANY($1::int[])', [winnerIds]);
}

/** Standalone refresh (its own transaction + lock). */
async function refresh() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lock(client);
    await refreshLocked(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Throws AccProjectAlreadyPairedError if another project actively holds `accProjectId`. */
async function assertFree(db, accProjectId, tenantId, excludeProjectId = null) {
  if (!accProjectId) return;
  const { rows } = await db.query(
    `SELECT p.tenant_id, l.name AS license_name FROM projects p LEFT JOIN tenant_licenses l ON l.id = p.tenant_license_id
     WHERE p.acc_project_id = $1 AND p.sync_active AND p.id IS DISTINCT FROM $2 LIMIT 1`,
    [accProjectId, excludeProjectId]
  );
  if (rows[0]) throw new AccProjectAlreadyPairedError(alreadyPairedMessage(rows[0].tenant_id === tenantId ? rows[0].license_name : null));
}

/**
 * Runs `save(db)` (an INSERT/UPDATE that pairs project `projectId` — null for a
 * new one — with `accProjectId`) under the guard: stale flags refreshed, the
 * ACC project checked free, then the flags refreshed again. Throws
 * AccProjectAlreadyPairedError, also when the database's unique index catches a
 * race the check didn't.
 */
async function savePairing({ projectId = null, accProjectId, tenantId }, save, db = null) {
  const own = !db;
  const client = db || (await pool.connect());
  try {
    if (own) await client.query('BEGIN');
    await lock(client);
    await refreshLocked(client);
    await assertFree(client, accProjectId, tenantId, projectId);
    const result = await save(client);
    await refreshLocked(client);
    if (own) await client.query('COMMIT');
    return result;
  } catch (err) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && /projects_acc_active_uq/.test(err.constraint || err.message)) throw new AccProjectAlreadyPairedError(alreadyPairedMessage(null));
    throw err;
  } finally {
    if (own) client.release();
  }
}

/**
 * The notice for a project that is paired, not archived, in a usable license —
 * but paused because another project holds its ACC project. null otherwise.
 */
function pausedNotice(project, licenseUsable = true) {
  if (!project.revizto_project_uuid || !project.acc_project_id || project.archived_at || project.sync_active || !licenseUsable) return null;
  return 'Syncing is paused: this ACC project is also paired with another Revizto project, which keeps syncing. Archive or re-pair one of the two.';
}

module.exports = { AccProjectAlreadyPairedError, alreadyPairedMessage, lock, refresh, refreshLocked, assertFree, savePairing, pausedNotice };
