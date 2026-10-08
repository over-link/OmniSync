// Operator-console filter test (public/js/operatorFilter.js): pure logic, no database, no browser.
//   node tests/multi-license/operatorfiltertest.js
const path = require('path');
const f = require(path.resolve(__dirname, '../../public/js/operatorFilter.js'));

const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };
const names = (r) => r.companies.flatMap((c) => c.licenses.map((l) => l.name)).sort().join(',');

// "Now" is fixed: noon UTC on 2026-10-08 (Pacific: the same day, 05:00).
const NOW = new Date('2026-10-08T12:00:00Z');
const lic = (id, name, phase, startsOn, expiresOn, extra = {}) => ({ id, name, phase, startsOn, expiresOn, slotCapacity: 5, slotsUsed: 1, memberCount: 1, note: '', admins: [], suspended: phase === 'suspended', ...extra });
const companies = [
  {
    id: 1, name: 'Acme Construction', timezone: 'America/Los_Angeles', accountOwnerEmail: 'amy@acme.com', licenses: [
      lic(1, 'Acme US', 'active', '2026-01-01', '2027-01-01', { admins: [{ email: 'amy@acme.com' }], note: 'INV-1001' }),
      lic(2, 'Acme EU', 'active', '2026-06-01', '2026-10-20', { admins: [{ email: 'eva@acme.eu' }] }), // 12 days left: expiring soon
      lic(3, 'Acme 2025 plan', 'expired', '2025-01-01', '2026-10-01'),                                    // expired a week ago
    ],
  },
  {
    id: 2, name: 'Beta Builders', timezone: 'Europe/Berlin', accountOwnerEmail: 'bob@beta.com', licenses: [
      lic(4, 'Beta main', 'active', '2026-03-01', '2026-11-07', { note: 'renewal pending' }),               // exactly 30 days left
      lic(5, 'Beta trial', 'suspended', '2026-09-01', '2026-12-31'),
      lic(6, 'Beta next year', 'not_started', '2027-02-01', '2028-02-01'),
      lic(7, 'Beta old', 'gone', '2024-01-01', '2025-01-01'),
    ],
  },
  { id: 3, name: 'Gamma Group', timezone: 'America/New_York', accountOwnerEmail: null, licenses: [] },               // a new company with no licenses yet
  { id: 4, name: 'Delta Edge', timezone: 'Asia/Tokyo', accountOwnerEmail: 'dee@delta.jp', licenses: [lic(8, 'Delta only', 'active', '2026-10-09', '2026-10-09')] }, // expires "today" in Tokyo? see below
];

// ── status
let r = f.filterCompanies(companies, {}, NOW);
ok('no filters: every license of every company, plus the empty company', r.shown === 8 && r.total === 8 && r.companies.length === 4, `${r.shown}/${r.total}/${r.companies.length}`);
ok('statusesOf: a license ending in 12 days is both active and expiring soon', JSON.stringify(f.statusesOf(companies[0].licenses[1], companies[0], NOW)) === '["active","expiring"]');
ok('statusesOf: a license ending in a year is just active', JSON.stringify(f.statusesOf(companies[0].licenses[0], companies[0], NOW)) === '["active"]');
r = f.filterCompanies(companies, { status: 'active' }, NOW);
ok('Active = every license in service (the expiring ones too)', names(r) === 'Acme EU,Acme US,Beta main,Delta only', names(r));
r = f.filterCompanies(companies, { status: 'expiring' }, NOW);
ok('Expiring soon = in service and ending within 30 days (30 days exactly counts)', names(r) === 'Acme EU,Beta main,Delta only', names(r));
r = f.filterCompanies(companies, { status: 'expired' }, NOW);
ok('Expired = past the end date, greyed or already hidden', names(r) === 'Acme 2025 plan,Beta old', names(r));
r = f.filterCompanies(companies, { status: 'suspended' }, NOW);
ok('Suspended', names(r) === 'Beta trial');
r = f.filterCompanies(companies, { status: 'not_started' }, NOW);
ok('Not started', names(r) === 'Beta next year');
ok('a status filter hides companies with nothing in it (including the empty one)', f.filterCompanies(companies, { status: 'suspended' }, NOW).companies.map((c) => c.name).join() === 'Beta Builders');

// ── counts for the chips
r = f.filterCompanies(companies, {}, NOW);
ok('chip counts over everything', JSON.stringify(r.counts) === JSON.stringify({ all: 8, active: 4, expiring: 3, suspended: 1, expired: 2, not_started: 1 }), JSON.stringify(r.counts));
r = f.filterCompanies(companies, { query: 'acme', status: 'expired' }, NOW);
ok('chip counts follow the search but ignore the chosen status', r.counts.all === 3 && r.counts.active === 2 && r.counts.expired === 1 && names(r) === 'Acme 2025 plan', JSON.stringify(r.counts));

// ── search
ok('search by company name', names(f.filterCompanies(companies, { query: 'beta' }, NOW)) === 'Beta main,Beta next year,Beta old,Beta trial');
ok('search by license name', names(f.filterCompanies(companies, { query: 'acme eu' }, NOW)) === 'Acme EU');
ok('search is case-insensitive and ignores extra spaces', names(f.filterCompanies(companies, { query: '  ACME   us ' }, NOW)) === 'Acme US');
ok('search by an admin email', names(f.filterCompanies(companies, { query: 'eva@acme.eu' }, NOW)) === 'Acme EU');
ok('search by the account owner email finds that company\'s licenses', names(f.filterCompanies(companies, { query: 'bob@beta' }, NOW)) === 'Beta main,Beta next year,Beta old,Beta trial');
ok('search by a note (invoice / contract reference)', names(f.filterCompanies(companies, { query: 'inv-1001' }, NOW)) === 'Acme US' && names(f.filterCompanies(companies, { query: 'renewal' }, NOW)) === 'Beta main');
ok('search by the status words ("suspended", "expiring")', names(f.filterCompanies(companies, { query: 'suspended' }, NOW)) === 'Beta trial' && names(f.filterCompanies(companies, { query: 'expiring' }, NOW)) === 'Acme EU,Beta main,Delta only');
ok('every word must match (AND), in any order', names(f.filterCompanies(companies, { query: 'eu acme' }, NOW)) === 'Acme EU' && names(f.filterCompanies(companies, { query: 'acme beta' }, NOW)) === '');
ok('search by a date', names(f.filterCompanies(companies, { query: '2026-10-20' }, NOW)) === 'Acme EU');
ok('a search that matches nothing shows nothing', f.filterCompanies(companies, { query: 'zzz' }, NOW).companies.length === 0);
ok('a company with no licenses is found by its name (to add its first license)', f.filterCompanies(companies, { query: 'gamma' }, NOW).companies.map((c) => c.name).join() === 'Gamma Group');
ok('...but is hidden as soon as a status or date filter is set', f.filterCompanies(companies, { query: 'gamma', status: 'active' }, NOW).companies.length === 0 && f.filterCompanies(companies, { query: 'gamma', from: '2026-01-01' }, NOW).companies.length === 0);
ok('...and it is not found by text that only a license would have', f.filterCompanies(companies, { query: 'acme eu' }, NOW).companies.every((c) => c.name !== 'Gamma Group'));

// ── date range
ok('expires from/to is inclusive at both ends', names(f.filterCompanies(companies, { from: '2026-10-20', to: '2026-11-07' }, NOW)) === 'Acme EU,Beta main');
ok('expires with only a from', names(f.filterCompanies(companies, { from: '2027-01-01' }, NOW)) === 'Acme US,Beta next year');
ok('expires with only a to', names(f.filterCompanies(companies, { to: '2025-12-31' }, NOW)) === 'Beta old');
ok('starts range (dateField = starts)', names(f.filterCompanies(companies, { dateField: 'starts', from: '2026-09-01', to: '2026-12-31' }, NOW)) === 'Beta trial,Delta only');
ok('the date range combines with the status and the search', names(f.filterCompanies(companies, { status: 'active', from: '2026-10-01', to: '2026-12-31', query: 'acme' }, NOW)) === 'Acme EU');
ok('an inverted range (from after to) matches nothing, rather than everything', f.filterCompanies(companies, { from: '2027-01-01', to: '2026-01-01' }, NOW).shown === 0);

// ── companies (the multi-select drop-down)
ok('one company picked: only its licenses', names(f.filterCompanies(companies, { companies: ['Acme Construction'] }, NOW)) === 'Acme 2025 plan,Acme EU,Acme US');
ok('several companies picked: the licenses of all of them', names(f.filterCompanies(companies, { companies: ['Acme Construction', 'Delta Edge'] }, NOW)) === 'Acme 2025 plan,Acme EU,Acme US,Delta only');
ok('no company picked (an empty list) = every company', f.filterCompanies(companies, { companies: [] }, NOW).shown === 8 && f.filterCompanies(companies, {}, NOW).shown === 8);
ok('company names match regardless of case', names(f.filterCompanies(companies, { companies: ['beta BUILDERS'] }, NOW)) === 'Beta main,Beta next year,Beta old,Beta trial');
ok('picking a company with no licenses shows it (so its first license can be added)', f.filterCompanies(companies, { companies: ['Gamma Group'] }, NOW).companies.map((c) => c.name).join() === 'Gamma Group');
ok('...unless a status or date filter is also set', f.filterCompanies(companies, { companies: ['Gamma Group'], status: 'active' }, NOW).companies.length === 0);
ok('an unknown company name shows nothing', f.filterCompanies(companies, { companies: ['Nobody Inc'] }, NOW).companies.length === 0);
r = f.filterCompanies(companies, { companies: ['Acme Construction'], status: 'expiring' }, NOW);
ok('company + status: Acme\'s expiring licenses only', names(r) === 'Acme EU', names(r));
r = f.filterCompanies(companies, { companies: ['Beta Builders'], from: '2026-12-01', to: '2026-12-31' }, NOW);
ok('company + date range', names(r) === 'Beta trial', names(r));
r = f.filterCompanies(companies, { companies: ['Acme Construction'], query: 'eu' }, NOW);
ok('company + search', names(r) === 'Acme EU', names(r));
r = f.filterCompanies(companies, { companies: ['Acme Construction', 'Beta Builders'] }, NOW);
ok('the status chip counts follow the picked companies', JSON.stringify(r.counts) === JSON.stringify({ all: 7, active: 3, expiring: 2, suspended: 1, expired: 2, not_started: 1 }), JSON.stringify(r.counts));
ok('"of N" still counts every license, so the summary reads "Showing 3 of 8"', f.filterCompanies(companies, { companies: ['Acme Construction'] }, NOW).total === 8 && f.filterCompanies(companies, { companies: ['Acme Construction'] }, NOW).shown === 3);

// ── dates are the company's own
// 2026-10-08 12:00 UTC is already 21:00 on the 8th in Tokyo; "Delta only" ends 2026-10-09 = tomorrow there.
ok('daysLeft uses the company\'s timezone (Tokyo: tomorrow = 1 day)', f.daysLeft(companies[3].licenses[0], companies[3], NOW) === 1);
const lateUtc = new Date('2026-10-08T20:00:00Z'); // already the 9th in Tokyo, still the 8th in Los Angeles
ok('...and the same moment is a different day for another company', f.daysLeft(companies[3].licenses[0], companies[3], lateUtc) === 0 && f.daysLeft(companies[0].licenses[1], companies[0], lateUtc) === 12);
ok('an unknown timezone falls back to UTC instead of crashing', f.localDate('Not/AZone', NOW) === '2026-10-08');

// ── phrases and robustness
ok('expiryPhrase', f.expiryPhrase(companies[0].licenses[1], companies[0], NOW) === 'expires in 12 days' && f.expiryPhrase(companies[0].licenses[2], companies[0], NOW) === 'expired 7 days ago' && f.expiryPhrase(companies[3].licenses[0], companies[3], lateUtc) === 'expires today');
ok('a license with no note / admins does not break search', f.filterCompanies([{ id: 9, name: 'X', timezone: 'UTC', licenses: [{ id: 99, name: 'Y', phase: 'active', startsOn: '2026-01-01', expiresOn: '2026-12-31' }] }], { query: 'y' }, NOW).shown === 1);
ok('the original data is not changed by filtering', companies[0].licenses.length === 3 && companies[1].licenses.length === 4);
ok('an empty list is fine', f.filterCompanies([], { query: 'x', status: 'active' }, NOW).total === 0);

// ── the timezone drop-down (public/js/timezones.js)
const tzs = require(path.resolve(__dirname, '../../public/js/timezones.js'));
const valid = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
ok('every offered timezone is a real IANA timezone the server will accept', tzs.NORTH_AMERICA.every((z) => valid(z.value)), tzs.NORTH_AMERICA.filter((z) => !valid(z.value)).map((z) => z.value).join());
ok('no timezone is listed twice, and every one has a label', new Set(tzs.NORTH_AMERICA.map((z) => z.value)).size === tzs.NORTH_AMERICA.length && tzs.NORTH_AMERICA.every((z) => z.label.length > 3));
ok('the default (Pacific, as before) is on the list', tzs.NORTH_AMERICA.some((z) => z.value === tzs.DEFAULT_TIMEZONE) && tzs.DEFAULT_TIMEZONE === 'America/Los_Angeles');
ok('all the mainland US zones, Alaska, Hawaii, Canada and Mexico are covered', ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Halifax', 'America/St_Johns', 'America/Regina', 'America/Mexico_City'].every((v) => tzs.NORTH_AMERICA.some((z) => z.value === v)));
ok('only North America is offered (no Europe / Asia entries)', tzs.NORTH_AMERICA.every((z) => /^(America|Pacific\/Honolulu)/.test(z.value)));
ok('options(): each choice shows its IANA name too, so the exact value is visible', tzs.options().every((o) => o.label.endsWith(o.value)));
ok('options(current): a company already on another timezone keeps it as an extra choice, so editing never changes it silently', tzs.options('Europe/Berlin').some((o) => o.value === 'Europe/Berlin' && /current/.test(o.label)) && tzs.options('Europe/Berlin').length === tzs.NORTH_AMERICA.length + 1);
ok('options(current): a zone already on the list is not duplicated', tzs.options('America/Denver').length === tzs.NORTH_AMERICA.length);

const failed = results.filter(([, p]) => !p);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
