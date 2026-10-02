/**
 * db/repairTenancy.js
 * Fills in what the older app version couldn't: people and projects created
 * AFTER the chunk 1 migration but BEFORE the license-aware code was deployed
 * have no license membership / license. Run after deploying, once:
 *
 *   npm run tenancy:repair              DRY RUN — only reports what it would do
 *   npm run tenancy:repair -- --apply   does it
 *
 * Deliberately narrow: it only acts when there is EXACTLY ONE license (so
 * "which license?" has one possible answer). With several licenses it refuses
 * and changes nothing — memberships then come only from explicit invites.
 *   - a project with no license  -> the license (and its company)
 *   - a user with no membership   -> a member of the license (a license admin
 *     if their older users.role says so); their open license is set
 * Never touches anything that already has a value. Safe to run repeatedly.
 */
require('dotenv').config();
const pool = require('./pool');

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const { rows: licenses } = await pool.query('SELECT id, tenant_id FROM tenant_licenses');
  if (licenses.length !== 1) {
    console.log(`${licenses.length} licenses exist — this repair only runs with exactly one. Nothing changed.`);
    return null;
  }
  const { id: licenseId, tenant_id: tenantId } = licenses[0];
  const { rows: orphanProjects } = await pool.query('SELECT id, name FROM projects WHERE tenant_license_id IS NULL OR tenant_id IS NULL');
  const { rows: orphanUsers } = await pool.query(
    'SELECT u.id, u.email, u.role FROM users u WHERE NOT EXISTS (SELECT 1 FROM license_members m WHERE m.user_id = u.id)'
  );
  const { rows: noOpen } = await pool.query(
    'SELECT u.id FROM users u WHERE u.current_license_id IS NULL AND EXISTS (SELECT 1 FROM license_members m WHERE m.user_id = u.id)'
  );
  console.log(
    `${apply ? 'Repairing' : 'Dry run'}: ${orphanProjects.length} project(s) without a license, ${orphanUsers.length} user(s) without a membership, ${noOpen.length} member(s) without an open license.`
  );
  for (const p of orphanProjects) console.log(`  project #${p.id} "${p.name}" -> license ${licenseId}`);
  for (const u of orphanUsers) console.log(`  ${u.email} -> ${['primary_license_admin', 'license_admin'].includes(u.role) ? 'license admin' : 'member'}`);
  if (apply) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE projects SET tenant_id = $1, tenant_license_id = $2 WHERE tenant_license_id IS NULL OR tenant_id IS NULL', [tenantId, licenseId]);
      await client.query(
        `INSERT INTO license_members (tenant_license_id, user_id, role)
         SELECT $1, u.id, CASE WHEN u.role IN ('primary_license_admin', 'license_admin') THEN 'license_admin' ELSE 'member' END
         FROM users u WHERE NOT EXISTS (SELECT 1 FROM license_members m WHERE m.user_id = u.id)
         ON CONFLICT (tenant_license_id, user_id) DO NOTHING`,
        [licenseId]
      );
      await client.query(
        'UPDATE users u SET current_license_id = $1 WHERE u.current_license_id IS NULL AND EXISTS (SELECT 1 FROM license_members m WHERE m.user_id = u.id)',
        [licenseId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    console.log('Done.');
  } else if (orphanProjects.length || orphanUsers.length || noOpen.length) {
    console.log('Nothing was changed. Add --apply to fix.');
  } else {
    console.log('Nothing to repair.');
  }
  return { projects: orphanProjects.length, users: orphanUsers.length, noOpen: noOpen.length };
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[tenancy] Repair failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
