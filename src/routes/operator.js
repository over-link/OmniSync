/**
 * routes/operator.js
 * The operator console (docs/multi-tenant-architecture.md section 3a): the
 * platform team's private page for what happens after a deal is signed and
 * paid — create a company, add its licenses, invite the account owner, renew,
 * change slots, suspend. Accounts flagged users.is_operator only
 * (requireOperator); there is no billing here and NO customer issue data:
 * only names, dates, slot counts and who administers each license.
 *
 * A license created here always gets settings_copied_at, so it never inherits
 * another company's sync pause (services/syncPolicy.copyGlobalSettingsOnce).
 */
const express = require('express');
const path = require('path');
const router = express.Router();
// Unrestricted on purpose: db/pool.js (row-level security) — this module looks across licenses / holds per-user secrets.
const pool = require('../db/pool').admin;
const { requireOperator } = require('./auth');
const emailService = require('../services/emailService');
const licenseState = require('../services/licenseState');
const tenancy = require('../services/tenancy');
const pairingGuard = require('../services/pairingGuard');

router.get('/operator', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/operator.html'));
});

class BadInput extends Error {}

const cleanName = (v, what) => {
  const name = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new BadInput(`Enter the ${what}.`);
  return name;
};

const cleanDate = (v, what) => {
  const s = String(v || '');
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new BadInput(`Enter the ${what} as a date.`);
  return s;
};

const cleanSlots = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new BadInput('Project slots must be a whole number from 0 to 10000.');
  return n;
};

const cleanTimezone = (v) => {
  const tz = String(v || '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new BadInput('Enter a valid timezone, e.g. America/Los_Angeles.');
  }
  return tz;
};

/** Runs a handler, answering a bad input / duplicate name with 400 / 409. */
const guarded = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof BadInput) return res.status(400).json({ error: err.message });
    if (err.code === '23505' && /tenant_licenses_name_uq/.test(err.constraint || err.message)) {
      return res.status(409).json({ error: 'This company already has a license with that name.' });
    }
    if (err.code === '23503') return res.status(409).json({ error: "That is still in use by other records, so it can't be deleted." });
    throw err;
  }
};

// Every company with its licenses (any phase — expired ones too, for renewals
// and purges), slot usage, and who administers each.
router.get('/api/operator/companies', requireOperator, async (req, res) => {
  const [{ rows: companies }, licenses, { rows: admins }, { rows: counts }, { rows: projectCounts }] = await Promise.all([
    pool.query(
      `SELECT t.id, t.name, t.timezone, t.status, owner.email AS owner_email
       FROM tenants t LEFT JOIN users owner ON owner.id = t.account_owner_user_id ORDER BY lower(t.name), t.id`
    ),
    licenseState.loadAll(),
    pool.query(
      `SELECT m.tenant_license_id AS license_id, u.id AS user_id, u.email, (u.license_role_verified_at IS NOT NULL) AS verified,
              (t.account_owner_user_id = u.id) AS is_owner
       FROM license_members m JOIN users u ON u.id = m.user_id
       JOIN tenant_licenses l ON l.id = m.tenant_license_id JOIN tenants t ON t.id = l.tenant_id
       WHERE m.role = 'license_admin' ORDER BY u.email`
    ),
    pool.query('SELECT tenant_license_id AS license_id, count(*)::int AS members FROM license_members GROUP BY 1'),
    pool.query('SELECT tenant_license_id AS license_id, count(*)::int AS projects FROM projects WHERE tenant_license_id IS NOT NULL GROUP BY 1'),
  ]);
  const projectCount = new Map(projectCounts.map((r) => [r.license_id, r.projects])); // archived ones included
  const notes = new Map((await pool.query('SELECT id, note FROM tenant_licenses')).rows.map((r) => [r.id, r.note]));
  const memberCount = new Map(counts.map((r) => [r.license_id, r.members]));
  res.json({
    emailConfigured: emailService.isConfigured(),
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      timezone: c.timezone,
      status: c.status,
      accountOwnerEmail: c.owner_email,
      licenses: licenses
        .filter((l) => l.tenant_id === c.id)
        .map((l) => ({
          id: l.id,
          name: l.name,
          slotCapacity: l.slot_capacity,
          slotsUsed: l.slots_used,
          startsOn: l.starts_on,
          expiresOn: l.expires_on,
          suspended: !!l.suspended_at,
          phase: l.state.phase,
          message: l.state.message,
          purgeable: l.state.purgeable,
          note: notes.get(l.id) || '',
          memberCount: memberCount.get(l.id) || 0,
          projectCount: projectCount.get(l.id) || 0,
          admins: admins.filter((a) => a.license_id === l.id).map((a) => ({ userId: a.user_id, email: a.email, verified: a.verified, isOwner: !!a.is_owner })),
        })),
    })),
  });
});

// A new company — once per buyer; later purchases are new licenses on it.
router.post('/api/operator/companies', requireOperator, guarded(async (req, res) => {
  const name = cleanName(req.body.name, 'company name');
  const timezone = cleanTimezone(req.body.timezone || 'America/Los_Angeles');
  const { rows: dupe } = await pool.query('SELECT 1 FROM tenants WHERE lower(name) = lower($1)', [name]);
  if (dupe.length) return res.status(409).json({ error: 'A company with that name already exists — add the license to it instead.' });
  const { rows } = await pool.query('INSERT INTO tenants (name, timezone) VALUES ($1, $2) RETURNING id, name, timezone', [name, timezone]);
  console.log(`[operator] ${req.session.userEmail} created company "${name}".`);
  res.json({ company: rows[0] });
}));

// A license (a purchase) on a company: its own unique name, slots and term.
router.post('/api/operator/companies/:id/licenses', requireOperator, guarded(async (req, res) => {
  const name = cleanName(req.body.name, 'license name');
  const slotCapacity = cleanSlots(req.body.slotCapacity);
  const startsOn = cleanDate(req.body.startsOn, 'start date');
  const expiresOn = cleanDate(req.body.expiresOn, 'expiry date');
  if (expiresOn < startsOn) throw new BadInput('The expiry date is before the start date.');
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  const { rows: company } = await pool.query('SELECT id FROM tenants WHERE id = $1', [Number(req.params.id) || 0]);
  if (!company[0]) return res.status(404).json({ error: 'Company not found.' });
  const { rows } = await pool.query(
    `INSERT INTO tenant_licenses (tenant_id, name, slot_capacity, starts_on, expires_on, note, settings_copied_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [company[0].id, name, slotCapacity, startsOn, expiresOn, note]
  );
  console.log(`[operator] ${req.session.userEmail} created license "${name}" (#${rows[0].id}): ${slotCapacity} slots, ${startsOn} to ${expiresOn}.`);
  res.json({ id: rows[0].id });
}));

// Renew / extend, change slots, rename, move the start, edit the note. Lowering
// slots below the projects in use is allowed: the license is then suspended by
// itself until it's back under the limit (services/licenseState.js).
router.patch('/api/operator/licenses/:id', requireOperator, guarded(async (req, res) => {
  const { rows: cur } = await pool.query(
    "SELECT name, slot_capacity, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, note FROM tenant_licenses WHERE id = $1",
    [Number(req.params.id) || 0]
  );
  if (!cur[0]) return res.status(404).json({ error: 'License not found.' });
  const b = req.body;
  const next = {
    name: b.name !== undefined ? cleanName(b.name, 'license name') : cur[0].name,
    slot_capacity: b.slotCapacity !== undefined ? cleanSlots(b.slotCapacity) : cur[0].slot_capacity,
    starts_on: b.startsOn !== undefined ? cleanDate(b.startsOn, 'start date') : cur[0].starts_on,
    expires_on: b.expiresOn !== undefined ? cleanDate(b.expiresOn, 'expiry date') : cur[0].expires_on,
    note: b.note !== undefined ? String(b.note || '').trim().slice(0, 500) || null : cur[0].note,
  };
  if (next.expires_on < next.starts_on) throw new BadInput('The expiry date is before the start date.');
  await pool.query(
    'UPDATE tenant_licenses SET name = $2, slot_capacity = $3, starts_on = $4, expires_on = $5, note = $6 WHERE id = $1',
    [req.params.id, next.name, next.slot_capacity, next.starts_on, next.expires_on, next.note]
  );
  await pairingGuard.refresh(); // a renewal / lower slot limit changes which pairings are active
  console.log(`[operator] ${req.session.userEmail} changed license #${req.params.id}: ${JSON.stringify(next)}.`);
  res.json({ ok: true });
}));

const setSuspended = (suspended) => async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE tenant_licenses SET suspended_at = ${suspended ? 'COALESCE(suspended_at, now())' : 'NULL'} WHERE id = $1`,
    [Number(req.params.id) || 0]
  );
  if (!rowCount) return res.status(404).json({ error: 'License not found.' });
  await pairingGuard.refresh();
  console.log(`[operator] ${req.session.userEmail} ${suspended ? 'suspended' : 'reactivated'} license #${req.params.id}.`);
  res.json({ ok: true });
};
router.post('/api/operator/licenses/:id/suspend', requireOperator, setSuspended(true));
router.post('/api/operator/licenses/:id/unsuspend', requireOperator, setSuspended(false));

// Invites someone as a license admin of this license — the buyer, as the first
// one. If the company has no account owner yet they become it. They stay
// "pending" until their own Revizto connection proves License administrator
// (routes/auth.js _verifyLicenseRole).
router.post('/api/operator/licenses/:id/admins', requireOperator, guarded(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) throw new BadInput('Enter a valid email.');
  const { rows: lic } = await pool.query('SELECT l.id, l.name, l.tenant_id, t.account_owner_user_id FROM tenant_licenses l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = $1', [Number(req.params.id) || 0]);
  if (!lic[0]) return res.status(404).json({ error: 'License not found.' });
  const { rows } = await pool.query(
    `INSERT INTO users (email, role) VALUES ($1, 'license_admin')
     ON CONFLICT (email) DO UPDATE SET role = CASE WHEN users.role = 'member' THEN 'license_admin' ELSE users.role END,
       license_role_verified_at = CASE WHEN users.role = 'member' THEN NULL ELSE users.license_role_verified_at END,
       license_role_denied_at = CASE WHEN users.role = 'member' THEN NULL ELSE users.license_role_denied_at END
     RETURNING id, email`,
    [email]
  );
  const user = rows[0];
  await tenancy.setLicenseAdmin(lic[0].id, user.id, req.session.userId);
  let accountOwner = lic[0].account_owner_user_id === user.id;
  if (!lic[0].account_owner_user_id) {
    await pool.query('UPDATE tenants SET account_owner_user_id = $2 WHERE id = $1 AND account_owner_user_id IS NULL', [lic[0].tenant_id, user.id]);
    accountOwner = true;
  }
  let emailSent = false;
  let emailError = null;
  if (req.body.sendEmail) {
    try {
      const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await emailService.sendInviteEmail({ toEmail: email, invitedByEmail: req.session.userEmail, appUrl, role: 'license admin' });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
    }
  }
  await pool.query('INSERT INTO invites (email, role, invited_by, email_sent, email_error) VALUES ($1, $2, $3, $4, $5)', [email, 'license_admin', req.session.userId, emailSent, emailError]);
  console.log(`[operator] ${req.session.userEmail} made ${email} a license admin of license #${lic[0].id}${accountOwner ? ' (account owner)' : ''}.`);
  res.json({ ok: true, accountOwner, emailSent, emailError });
}));

// ─── Company: rename, timezone, account owner, delete ────────────────

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Rename, change the timezone (working hours and each license's day boundaries follow it),
// or change the account owner — who must already be a license admin of one of the company's
// licenses (invite them as one first), so an owner always has access to something.
router.patch('/api/operator/companies/:id', requireOperator, guarded(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT id, name, timezone, account_owner_user_id FROM tenants WHERE id = $1', [Number(req.params.id) || 0]);
  if (!cur[0]) return res.status(404).json({ error: 'Company not found.' });
  const b = req.body;
  const name = b.name !== undefined ? cleanName(b.name, 'company name') : cur[0].name;
  const timezone = b.timezone !== undefined ? cleanTimezone(b.timezone) : cur[0].timezone;
  if (name !== cur[0].name) {
    const { rows: dupe } = await pool.query('SELECT 1 FROM tenants WHERE lower(name) = lower($1) AND id <> $2', [name, cur[0].id]);
    if (dupe.length) return res.status(409).json({ error: 'Another company already has that name.' });
  }
  let ownerId = cur[0].account_owner_user_id;
  if (b.accountOwnerEmail !== undefined) {
    const email = String(b.accountOwnerEmail || '').toLowerCase().trim();
    if (!email) throw new BadInput('Choose the account owner.');
    const { rows } = await pool.query(
      `SELECT u.id FROM users u JOIN license_members m ON m.user_id = u.id AND m.role = 'license_admin'
       JOIN tenant_licenses l ON l.id = m.tenant_license_id AND l.tenant_id = $2
       WHERE u.email = $1 LIMIT 1`,
      [email, cur[0].id]
    );
    if (!rows[0]) throw new BadInput("That person isn't a license admin of any of this company's licenses. Invite them as a license admin of one first.");
    ownerId = rows[0].id;
  }
  await pool.query('UPDATE tenants SET name = $2, timezone = $3, account_owner_user_id = $4 WHERE id = $1', [cur[0].id, name, timezone, ownerId]);
  if (timezone !== cur[0].timezone) await pairingGuard.refresh(); // a license's day (start / expiry) is judged in the company's timezone
  console.log(`[operator] ${req.session.userEmail} changed company #${cur[0].id}: name "${name}", timezone ${timezone}, owner #${ownerId}.`);
  res.json({ ok: true });
}));

/** The operator must type the exact name of what they are deleting (also enforced here, not only in the page). */
function requireConfirmName(req, name) {
  if (String(req.body?.confirmName || '').trim() !== name) throw new BadInput(`Type the exact name "${name}" to confirm.`);
}

// Only a company with no licenses can go (delete its licenses first).
router.delete('/api/operator/companies/:id', requireOperator, guarded(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM tenants WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found.' });
  requireConfirmName(req, rows[0].name);
  const { rows: lic } = await pool.query('SELECT count(*)::int AS n FROM tenant_licenses WHERE tenant_id = $1', [rows[0].id]);
  if (lic[0].n) return res.status(409).json({ error: `This company still has ${lic[0].n} license${lic[0].n === 1 ? '' : 's'} — delete them first.` });
  await pool.query('DELETE FROM tenants WHERE id = $1', [rows[0].id]);
  console.log(`[operator] ${req.session.userEmail} deleted company "${rows[0].name}" (#${rows[0].id}).`);
  res.json({ ok: true });
}));

// ─── License: delete ─────────────────────────────────────────────────

// Only a license with no projects at all (archived ones count) can be deleted: projects hold the
// customer's issue links and mappings, and removing them is the customer's own license admins' call.
// Its memberships go with it; the people keep their accounts.
router.delete('/api/operator/licenses/:id', requireOperator, guarded(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM tenant_licenses WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'License not found.' });
  requireConfirmName(req, rows[0].name);
  const { rows: pr } = await pool.query('SELECT count(*)::int AS n FROM projects WHERE tenant_license_id = $1', [rows[0].id]);
  if (pr[0].n) {
    return res.status(409).json({ error: `This license still has ${pr[0].n} project${pr[0].n === 1 ? '' : 's'} (archived ones count). Its license admins must delete them on License Administration first.` });
  }
  await pool.query('DELETE FROM tenant_licenses WHERE id = $1', [rows[0].id]);
  await pairingGuard.refresh();
  console.log(`[operator] ${req.session.userEmail} deleted license "${rows[0].name}" (#${rows[0].id}).`);
  res.json({ ok: true });
}));

// ─── License admins: remove, resend the invitation ───────────────────

// Takes away license-admin rights (they stay a plain member, as when a customer's admin removes one).
// The company's account owner can't be removed — change the owner first.
router.delete('/api/operator/licenses/:id/admins/:userId', requireOperator, guarded(async (req, res) => {
  const licenseId = Number(req.params.id) || 0;
  const userId = Number(req.params.userId) || 0;
  const { rows } = await pool.query(
    `SELECT u.email, t.account_owner_user_id FROM license_members m JOIN users u ON u.id = m.user_id
     JOIN tenant_licenses l ON l.id = m.tenant_license_id JOIN tenants t ON t.id = l.tenant_id
     WHERE m.tenant_license_id = $1 AND m.user_id = $2 AND m.role = 'license_admin'`,
    [licenseId, userId]
  );
  if (!rows[0]) return res.status(404).json({ error: "That person isn't a license admin of this license." });
  if (rows[0].account_owner_user_id === userId) throw new BadInput("That person is the company's account owner. Change the account owner first, then remove them.");
  await pool.query("UPDATE license_members SET role = 'member' WHERE tenant_license_id = $1 AND user_id = $2", [licenseId, userId]);
  // The older global copy of the role: lowered only if they are no longer a license admin anywhere.
  await pool.query(
    `UPDATE users SET role = 'member' WHERE id = $1 AND role = 'license_admin'
       AND NOT EXISTS (SELECT 1 FROM license_members WHERE user_id = $1 AND role = 'license_admin')`,
    [userId]
  );
  console.log(`[operator] ${req.session.userEmail} removed ${rows[0].email} as a license admin of license #${licenseId}.`);
  res.json({ ok: true });
}));

// Sends the invitation email again (they may have lost it). Nothing else changes.
router.post('/api/operator/licenses/:id/admins/:userId/resend', requireOperator, guarded(async (req, res) => {
  const licenseId = Number(req.params.id) || 0;
  const userId = Number(req.params.userId) || 0;
  const { rows } = await pool.query(
    `SELECT u.email FROM license_members m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_license_id = $1 AND m.user_id = $2 AND m.role = 'license_admin'`,
    [licenseId, userId]
  );
  if (!rows[0]) return res.status(404).json({ error: "That person isn't a license admin of this license." });
  if (!emailService.isConfigured()) {
    return res.status(409).json({ error: "Email isn't set up on the server (SMTP), so nothing was sent. They can still sign in with their email address." });
  }
  let emailError = null;
  try {
    const appUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    await emailService.sendInviteEmail({ toEmail: rows[0].email, invitedByEmail: req.session.userEmail, appUrl, role: 'license admin' });
  } catch (err) {
    emailError = err.message;
  }
  await pool.query('INSERT INTO invites (email, role, invited_by, email_sent, email_error) VALUES ($1, $2, $3, $4, $5)', [rows[0].email, 'license_admin', req.session.userId, !emailError, emailError]);
  if (emailError) return res.status(502).json({ error: `The email couldn't be sent: ${emailError}` });
  console.log(`[operator] ${req.session.userEmail} resent the invitation to ${rows[0].email}.`);
  res.json({ ok: true });
}));

module.exports = router;
