/**
 * db/checkTenancy.js
 * READ-ONLY report on the multi-company groundwork (schema.sql "chunk 1"):
 * run with  npm run tenancy:check  after `npm run migrate`. Changes nothing.
 * Exit code 1 if something is inconsistent.
 */
require('dotenv').config();
const pool = require('./pool');

async function scalar(sql) {
  const { rows } = await pool.query(sql);
  return Number(Object.values(rows[0])[0]);
}

async function main() {
  const problems = [];
  const report = {
    companies: await scalar('SELECT count(*) FROM tenants'),
    licenses: await scalar('SELECT count(*) FROM tenant_licenses'),
    reviztoLicenses: await scalar('SELECT count(*) FROM revizto_licenses'),
    users: await scalar('SELECT count(*) FROM users'),
    licenseMembers: await scalar('SELECT count(*) FROM license_members'),
    projects: await scalar('SELECT count(*) FROM projects'),
  };
  const noLicense = await scalar('SELECT count(*) FROM projects WHERE tenant_license_id IS NULL OR tenant_id IS NULL');
  const noMember = await scalar('SELECT count(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM license_members m WHERE m.user_id = u.id)');
  const mismatch = await scalar(
    'SELECT count(*) FROM projects p JOIN tenant_licenses l ON l.id = p.tenant_license_id WHERE l.tenant_id <> p.tenant_id'
  );
  const adminsLost = await scalar(
    `SELECT count(*) FROM users u WHERE u.role IN ('primary_license_admin','license_admin')
       AND NOT EXISTS (SELECT 1 FROM license_members m WHERE m.user_id = u.id AND m.role = 'license_admin')`
  );
  const unbound = await scalar('SELECT count(DISTINCT revizto_license_uuid) FROM projects WHERE revizto_license_uuid IS NOT NULL')
    - (await scalar('SELECT count(*) FROM revizto_licenses'));
  // Chunk 5: an ACC project paired from two non-archived projects (only one may sync).
  const doublePaired = await scalar(
    `SELECT count(*) FROM (SELECT acc_project_id FROM projects WHERE revizto_project_uuid IS NOT NULL AND acc_project_id IS NOT NULL AND archived_at IS NULL
       GROUP BY acc_project_id HAVING count(*) > 1) d`
  );
  if (report.users && !report.companies) problems.push('users exist but there is no company yet (run the migration)');
  if (noLicense) problems.push(`${noLicense} project(s) have no company/license`);
  if (noMember) problems.push(`${noMember} user(s) belong to no license`);
  if (mismatch) problems.push(`${mismatch} project(s) point at a license of a different company`);
  if (adminsLost) problems.push(`${adminsLost} existing license admin(s) are not license admins in the new tables`);
  if (unbound > 0) problems.push(`${unbound} Revizto license(s) used by projects are not recorded`);
  if (doublePaired) console.log(`NOTE: ${doublePaired} ACC project(s) are paired from more than one project — the migration keeps the oldest syncing and pauses the rest.`);
  console.log('Multi-company groundwork:', JSON.stringify(report));
  if (problems.length) {
    console.log('PROBLEMS:');
    for (const p of problems) console.log(' - ' + p);
    process.exitCode = 1;
  } else {
    console.log('Consistent.');
  }
}

main()
  .catch((err) => {
    console.error('[tenancy] Check failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
