/**
 * services/licenseTerms.js
 * What a license allows: how many projects (its slots) and until when, read
 * from the license's own row (tenant_licenses.slot_capacity / expires_on).
 * Projects that exist and aren't archived use a slot; creating or unarchiving
 * a project is refused when the license is full — or isn't active at all (see
 * services/licenseState.js). Each license counts and locks its own slots, so
 * two licenses never compete for them.
 *
 * DEFAULT_* are only the placeholders a brand-new install (and the chunk 1
 * backfill) start with, until the operator sets the real terms.
 */
const pool = require('../db/pool');
const licenseState = require('./licenseState');

const DEFAULT_SLOT_CAPACITY = 5;
const DEFAULT_EXPIRES_ON = '2027-07-15';

const NO_PROJECT_SLOTS_MESSAGE = 'No available project slots remain.';

class NoProjectSlotsError extends Error {
  constructor() {
    super(NO_PROJECT_SLOTS_MESSAGE);
    this.code = 'no_project_slots';
  }
}

/** The license isn't active (expired / suspended / not started): nothing can be created on it. */
class LicenseNotActiveError extends Error {
  constructor(message) {
    super(message);
    this.code = 'license_not_active';
  }
}

/**
 * Runs `fn(client)` — something that takes a slot (creating or unarchiving a
 * project) in `licenseId` — in a transaction, only if the license is active
 * and has a slot free; otherwise throws NoProjectSlotsError /
 * LicenseNotActiveError. The advisory lock (per license) makes two admins
 * clicking at the same moment take turns, so they can't both get the last slot.
 */
async function withProjectSlot(licenseId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project_slots:${licenseId}`]);
    const license = await licenseState.load(licenseId, client);
    if (!license) throw new Error('License not found.');
    if (!license.state.usable) throw new LicenseNotActiveError(license.state.message);
    if (license.slots_used >= license.slot_capacity) throw new NoProjectSlotsError();
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

/** The numbers License Administration shows for one license. */
async function summary(licenseId) {
  const license = await licenseState.load(licenseId);
  if (!license) return null;
  return {
    name: license.name,
    projectSlotCapacity: license.slot_capacity,
    projectSlotsUsed: license.slots_used,
    licenseExpiresOn: license.expires_on,
    license: { phase: license.state.phase, usable: license.state.usable, message: license.state.message, adminLimited: license.state.adminLimited },
  };
}

module.exports = {
  DEFAULT_SLOT_CAPACITY,
  DEFAULT_EXPIRES_ON,
  NO_PROJECT_SLOTS_MESSAGE,
  NoProjectSlotsError,
  LicenseNotActiveError,
  withProjectSlot,
  summary,
};
