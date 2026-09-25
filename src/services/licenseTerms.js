/**
 * services/licenseTerms.js
 * What the license allows: how many projects, and until when. Projects
 * that exist and aren't archived use a slot; the count can never go over
 * the capacity (creating or unarchiving a project is refused when it's
 * full — see withProjectSlot).
 *
 * PLACEHOLDERS until the real license terms are wired up (user's numbers,
 * 2026-09-25).
 */
const pool = require('../db/pool');

const PROJECT_SLOT_CAPACITY = 5;
const LICENSE_EXPIRES_ON = '2027-07-15';

const NO_PROJECT_SLOTS_MESSAGE = 'No available project slots remain.';

class NoProjectSlotsError extends Error {
  constructor() {
    super(NO_PROJECT_SLOTS_MESSAGE);
    this.code = 'no_project_slots';
  }
}

async function projectSlotsUsed(db = pool) {
  const { rows } = await db.query('SELECT count(*)::int AS used FROM projects WHERE archived_at IS NULL');
  return rows[0].used;
}

/**
 * Runs `fn(client)` — something that takes a slot (creating or unarchiving
 * a project) — in a transaction, only if a slot is free; otherwise throws
 * NoProjectSlotsError. The advisory lock makes two admins clicking at the
 * same moment take turns, so they can't both get the last slot.
 */
async function withProjectSlot(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('project_slots'))");
    if ((await projectSlotsUsed(client)) >= PROJECT_SLOT_CAPACITY) throw new NoProjectSlotsError();
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  PROJECT_SLOT_CAPACITY,
  LICENSE_EXPIRES_ON,
  NO_PROJECT_SLOTS_MESSAGE,
  NoProjectSlotsError,
  projectSlotsUsed,
  withProjectSlot,
};
