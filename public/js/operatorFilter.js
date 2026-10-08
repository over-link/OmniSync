/**
 * public/js/operatorFilter.js
 * Finding things on the operator console: pure filter logic over the companies
 * the console already loaded (GET /api/operator/companies) — no DOM, so the
 * same file runs in the browser (window.operatorFilter) and in Node tests.
 *
 *   filterCompanies(companies, { query, status, dateField, from, to }, now)
 *     -> { companies: [{ ...company, licenses: [matching ones] }], shown, total, counts }
 *
 * query      words, ALL must appear (case-insensitive) in the license's text: company name,
 *            timezone, account owner, license name, note, status label, its admins' emails.
 * status     'all' | 'active' | 'expiring' | 'suspended' | 'expired' | 'not_started'
 *            "active" = in service (includes ones about to expire); "expiring" = active and
 *            expiring within EXPIRING_DAYS; "expired" = past its end date (greyed or hidden).
 * dateField  'expires' | 'starts' — which date the range applies to; from / to are
 *            YYYY-MM-DD, inclusive, either may be empty.
 * counts     licenses per status over the whole list (ignoring status), for the chips.
 *
 * A company with no licenses is shown only when it matches the search on its own
 * text and no status / date filter is set (so a new company can be found to add its
 * first license). "Today" is the company's own timezone date, as the server judges it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.operatorFilter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EXPIRING_DAYS = 30;

  const STATUS_LABELS = {
    active: 'Active',
    expiring: 'Expiring soon',
    suspended: 'Suspended',
    expired: 'Expired',
    not_started: 'Not started',
  };

  /** YYYY-MM-DD of `now` in `timeZone` (falls back to UTC for an unknown zone). */
  function localDate(timeZone, now) {
    let tz = timeZone;
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    } catch {
      tz = 'UTC';
    }
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  const dayNumber = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86400000);

  /** Whole days from the company's today to the license's expiry (negative once expired). */
  function daysLeft(license, company, now) {
    return dayNumber(license.expiresOn) - dayNumber(localDate(company.timezone, now));
  }

  /** The statuses a license counts as (a license can be both 'active' and 'expiring'). */
  function statusesOf(license, company, now) {
    const out = [];
    if (license.phase === 'active') {
      out.push('active');
      const left = daysLeft(license, company, now);
      if (left >= 0 && left <= EXPIRING_DAYS) out.push('expiring');
    } else if (license.phase === 'suspended') out.push('suspended');
    else if (license.phase === 'expired' || license.phase === 'gone') out.push('expired');
    else if (license.phase === 'not_started') out.push('not_started');
    return out;
  }

  function companyText(company) {
    return [company.name, company.timezone, company.accountOwnerEmail].filter(Boolean).join(' ').toLowerCase();
  }

  function licenseText(license, company, now) {
    const labels = statusesOf(license, company, now).map((s) => STATUS_LABELS[s]);
    return [companyText(company), license.name, license.note, license.startsOn, license.expiresOn, ...labels, ...(license.admins || []).map((a) => a.email)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  const words = (query) => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hasAll = (text, terms) => terms.every((t) => text.includes(t));

  function inRange(license, { dateField, from, to }) {
    if (!from && !to) return true;
    const value = dateField === 'starts' ? license.startsOn : license.expiresOn;
    return (!from || value >= from) && (!to || value <= to);
  }

  function filterCompanies(companies, filters = {}, now = new Date()) {
    const terms = words(filters.query);
    const status = filters.status || 'all';
    const dateField = filters.dateField === 'starts' ? 'starts' : 'expires';
    const range = { dateField, from: filters.from || '', to: filters.to || '' };
    const counts = { all: 0, active: 0, expiring: 0, suspended: 0, expired: 0, not_started: 0 };
    let shown = 0;
    let total = 0;
    const out = [];
    for (const company of companies) {
      const matching = [];
      for (const license of company.licenses) {
        total++;
        const statuses = statusesOf(license, company, now);
        // Counts follow the search and the date range, but not the status choice itself.
        if (hasAll(licenseText(license, company, now), terms) && inRange(license, range)) {
          counts.all++;
          for (const s of statuses) counts[s]++;
          if (status === 'all' || statuses.includes(status)) matching.push(license);
        }
      }
      const emptyCompanyShown = !company.licenses.length && status === 'all' && !range.from && !range.to && hasAll(companyText(company), terms);
      if (matching.length || emptyCompanyShown) {
        shown += matching.length;
        out.push({ ...company, licenses: matching });
      }
    }
    return { companies: out, shown, total, counts };
  }

  /** "in 12 days" / "today" / "3 days ago" for the license facts line. */
  function expiryPhrase(license, company, now = new Date()) {
    const left = daysLeft(license, company, now);
    if (left === 0) return 'expires today';
    if (left > 0) return `expires in ${left} day${left === 1 ? '' : 's'}`;
    return `expired ${-left} day${left === -1 ? '' : 's'} ago`;
  }

  return { EXPIRING_DAYS, STATUS_LABELS, localDate, daysLeft, statusesOf, filterCompanies, expiryPhrase };
});
