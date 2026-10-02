/**
 * services/licenseState.js
 * What state a license is in, from its dates, its slots and its suspension
 * (docs/multi-tenant-architecture.md "License expiry" / "Over the slot limit").
 * Pure rules in evaluate(); loaders read a license with its slot usage.
 *
 *   active         usable
 *   not_started    before starts_on                    (blocked)
 *   suspended      operator suspended it (blocked) or it is over its slot limit
 *                  (blocked, but its license admins may still archive/delete
 *                  projects to get back under the limit — adminLimited)
 *   expired        up to 30 days after expires_on      (blocked, shown greyed)
 *   gone           after those 30 days                 (blocked, off every list)
 *   purgeable      90 days after expires_on            (operator may delete it)
 *
 * "Today" is the license's COMPANY timezone date. Expiry wins over suspension.
 * While a license is not active ALL syncing for its projects is paused.
 */
const pool = require('../db/pool');

const EXPIRED_GREY_DAYS = 30;
const RETENTION_DAYS = 90;

const EXPIRED_MESSAGE = 'License has expired. Contact your administrator.';
const SUSPENDED_MESSAGE = 'License is suspended. Contact your administrator.';
const NOT_STARTED_MESSAGE = 'License has not started yet. Contact your administrator.';
const NO_LICENSE_MESSAGE = "You don't have access to any license. Contact your administrator.";

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/** YYYY-MM-DD of `now` in `timeZone`. */
function localDate(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * license: { starts_on, expires_on ('YYYY-MM-DD'), slot_capacity, slots_used,
 *            suspended_at, timezone }.
 * Returns { phase, usable, visible, message, reason, adminLimited, purgeable }.
 */
function evaluate(license, now = new Date()) {
  const today = localDate(license.timezone, now);
  if (today < license.starts_on) {
    return { phase: 'not_started', usable: false, visible: true, message: NOT_STARTED_MESSAGE, reason: 'not_started', adminLimited: false, purgeable: false };
  }
  if (today > license.expires_on) {
    const gone = today > addDays(license.expires_on, EXPIRED_GREY_DAYS);
    return {
      phase: gone ? 'gone' : 'expired',
      usable: false,
      visible: !gone,
      message: gone ? NO_LICENSE_MESSAGE : EXPIRED_MESSAGE,
      reason: 'expired',
      adminLimited: false,
      purgeable: today > addDays(license.expires_on, RETENTION_DAYS),
    };
  }
  if (license.suspended_at) {
    return { phase: 'suspended', usable: false, visible: true, message: SUSPENDED_MESSAGE, reason: 'operator', adminLimited: false, purgeable: false };
  }
  if (Number(license.slots_used) > Number(license.slot_capacity)) {
    return { phase: 'suspended', usable: false, visible: true, message: SUSPENDED_MESSAGE, reason: 'over_limit', adminLimited: true, purgeable: false };
  }
  return { phase: 'active', usable: true, visible: true, message: null, reason: null, adminLimited: false, purgeable: false };
}

const LICENSE_SELECT = `
  SELECT l.id, l.tenant_id, l.name, l.slot_capacity,
         to_char(l.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
         l.suspended_at, t.timezone,
         (SELECT count(*)::int FROM projects p WHERE p.tenant_license_id = l.id AND p.archived_at IS NULL) AS slots_used
  FROM tenant_licenses l JOIN tenants t ON t.id = l.tenant_id`;

/** The license row with its slot usage and its state, or null. `db` may be a transaction client. */
async function load(licenseId, db = pool) {
  const { rows } = await db.query(`${LICENSE_SELECT} WHERE l.id = $1`, [licenseId]);
  return rows[0] ? { ...rows[0], state: evaluate(rows[0]) } : null;
}

/** The given licenses (ids) with their state. */
async function loadMany(ids, db = pool) {
  if (!ids.length) return [];
  const { rows } = await db.query(`${LICENSE_SELECT} WHERE l.id = ANY($1::int[]) ORDER BY l.id`, [ids]);
  return rows.map((r) => ({ ...r, state: evaluate(r) }));
}

/** Every license with its state. */
async function loadAll(db = pool) {
  const { rows } = await db.query(`${LICENSE_SELECT} ORDER BY l.id`);
  return rows.map((r) => ({ ...r, state: evaluate(r) }));
}

/** Set of license ids whose projects may sync right now. */
async function syncingLicenseIds() {
  return new Set((await loadAll()).filter((l) => l.state.usable).map((l) => l.id));
}

/**
 * May this project sync (poll, webhook, health check)? A project without a
 * license (legacy data not yet repaired — npm run tenancy:repair) is allowed,
 * so a gap in the new tables never halts syncing.
 */
async function projectMaySync(project) {
  if (!project || !project.tenant_license_id) return true;
  const license = await load(project.tenant_license_id);
  return !license || license.state.usable;
}

module.exports = {
  EXPIRED_GREY_DAYS,
  RETENTION_DAYS,
  EXPIRED_MESSAGE,
  SUSPENDED_MESSAGE,
  NOT_STARTED_MESSAGE,
  NO_LICENSE_MESSAGE,
  localDate,
  addDays,
  evaluate,
  load,
  loadMany,
  loadAll,
  syncingLicenseIds,
  projectMaySync,
};
