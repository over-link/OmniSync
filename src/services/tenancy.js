/**
 * services/tenancy.js
 * Small helpers for the multi-company tables (schema.sql "chunk 1"):
 * company -> licenses -> members -> projects. Access decisions themselves are
 * in services/access.js; this is only for WRITING membership rows so every
 * code path that brings someone in keeps license_members in step.
 *
 * Rule (docs/multi-tenant-architecture.md): a membership row exists only
 * through an explicit invite by an admin of that license - nothing here is
 * called "automatically" for people who weren't invited.
 */
const pool = require('../db/pool');

/**
 * Makes `userId` a 'member' of the license - unless they already belong to it
 * (an existing role, e.g. license admin, is never lowered or changed here).
 * `db` may be a transaction client.
 */
async function ensureMember(licenseId, userId, invitedBy = null, db = pool) {
  if (!licenseId) return;
  await db.query(
    `INSERT INTO license_members (tenant_license_id, user_id, role, invited_by) VALUES ($1, $2, 'member', $3)
     ON CONFLICT (tenant_license_id, user_id) DO NOTHING`,
    [licenseId, userId, invitedBy]
  );
}

/** Makes `userId` a license admin of the license (creating or promoting the row). */
async function setLicenseAdmin(licenseId, userId, invitedBy = null, db = pool) {
  await db.query(
    `INSERT INTO license_members (tenant_license_id, user_id, role, invited_by) VALUES ($1, $2, 'license_admin', $3)
     ON CONFLICT (tenant_license_id, user_id) DO UPDATE SET role = 'license_admin'`,
    [licenseId, userId, invitedBy]
  );
}

/** The license a project belongs to (or null). */
async function licenseOfProject(projectId, db = pool) {
  const { rows } = await db.query('SELECT tenant_license_id FROM projects WHERE id = $1', [projectId]);
  return rows[0]?.tenant_license_id ?? null;
}

/**
 * A brand-new, empty install: the very first user (the bootstrap primary
 * license admin) needs a company and a license to be the admin of. Placeholder
 * names / 5 slots / expiry as in services/licenseTerms.js; the operator
 * corrects them later. Does nothing if a company already exists.
 */
async function ensureBootstrapLicense(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bootstrap_license'))");
    const { rows: existing } = await client.query('SELECT id FROM tenants LIMIT 1');
    if (!existing.length) {
      const { rows: t } = await client.query("INSERT INTO tenants (name, account_owner_user_id) VALUES ('My company', $1) RETURNING id", [userId]);
      const { rows: l } = await client.query(
        `INSERT INTO tenant_licenses (tenant_id, name, slot_capacity, starts_on, expires_on)
         VALUES ($1, 'My license', 5, CURRENT_DATE, DATE '2027-07-15') RETURNING id`,
        [t[0].id]
      );
      await setLicenseAdmin(l[0].id, userId, null, client);
      await client.query('UPDATE users SET current_license_id = $2 WHERE id = $1', [userId, l[0].id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureMember, setLicenseAdmin, licenseOfProject, ensureBootstrapLicense };
