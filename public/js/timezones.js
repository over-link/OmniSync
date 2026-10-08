/**
 * public/js/timezones.js
 * The timezones the operator console offers when creating or editing a company
 * (a company's timezone decides its polling hours and when each license's days begin).
 * North America for now — US, Canada and Mexico; add more here when needed. Values are
 * IANA names, which the server validates (routes/operator.js cleanTimezone).
 * Plain data, so the same file runs in the browser (window.operatorTimezones) and in Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.operatorTimezones = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_TIMEZONE = 'America/Los_Angeles';

  // Roughly west to east. Canadian cities share the zone of the US ones (Vancouver = Pacific, Toronto = Eastern ...).
  const NORTH_AMERICA = [
    { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
    { value: 'America/Anchorage', label: 'Alaska (AKT)' },
    { value: 'America/Los_Angeles', label: 'Pacific Time (PT) — US & Canada, Tijuana' },
    { value: 'America/Denver', label: 'Mountain Time (MT) — US & Canada' },
    { value: 'America/Phoenix', label: 'Arizona (MST, no daylight saving)' },
    { value: 'America/Chicago', label: 'Central Time (CT) — US & Canada' },
    { value: 'America/Regina', label: 'Saskatchewan (CST, no daylight saving)' },
    { value: 'America/Mexico_City', label: 'Mexico City / Central Mexico (CST)' },
    { value: 'America/New_York', label: 'Eastern Time (ET) — US & Canada' },
    { value: 'America/Halifax', label: 'Atlantic Time (AT) — Canada, Bermuda' },
    { value: 'America/Puerto_Rico', label: 'Puerto Rico (AST)' },
    { value: 'America/St_Johns', label: 'Newfoundland (NT)' },
  ];

  /**
   * The choices for a drop-down. If `current` is a zone that isn't in the list (a company created
   * earlier with, say, Europe/Berlin), it is added at the end so editing never silently changes it.
   */
  function options(current) {
    const list = NORTH_AMERICA.map((z) => ({ value: z.value, label: `${z.label} — ${z.value}` }));
    if (current && !list.some((z) => z.value === current)) list.push({ value: current, label: `${current} (current)` });
    return list;
  }

  return { DEFAULT_TIMEZONE, NORTH_AMERICA, options };
});
