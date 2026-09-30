async function api(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

// Chart colors: categorical slots 1 and 2 of the validated reference
// palette, checked against this app's white card surface (all checks pass,
// incl. colorblind separation). Text never uses these — only marks do.
const SERIES = {
  revizto_to_acc: { label: 'Revizto → ACC', color: '#2a78d6' },
  acc_to_revizto: { label: 'ACC → Revizto', color: '#eb6834' },
};
const TIMELINE_COLOR = '#2a78d6';
// What can change on an issue: the six synced fields (audit_log.field_name
// = Revizto's diff-comment keys) plus comments and attachments, in a fixed
// order with fixed colors — categorical slots 1–8 of the reference
// palette, validated as a stacked set on this app's white surface. Same
// color for a kind on both "made in" charts. Three slots are under 3:1
// against white, so these charts always carry legend totals and a table
// view (the validator's required relief).
const FIELD_SERIES = [
  { key: 'customStatus', label: 'Status', color: '#2a78d6' },
  { key: 'assignee', label: 'Assignee', color: '#eb6834' },
  { key: 'watchers', label: 'Watchers', color: '#1baf7a' },
  { key: 'priority', label: 'Priority', color: '#eda100' },
  { key: 'deadline', label: 'Due date', color: '#e87ba4' },
  { key: 'title', label: 'Title', color: '#008300' },
  { key: 'comment', label: 'Comments', color: '#4a3aa7' },
  { key: 'attachment', label: 'Attachments', color: '#e34948' },
];
// "Issues synced" by person: people take the first five categorical slots
// in account order (never by count, so a person keeps their color whatever
// the range); a sixth person on folds into "Other people"; then Auto-sync
// and Not recorded — slots 6–8, drawn as overlapping lines. All eight are
// the reference palette in its validated order (every adjacent pair passes
// for lines); three sit under 3:1 on white, so this view carries legend
// totals, a per-period tooltip and a table as relief.
const PERSON_SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER_PEOPLE = { key: 'others', label: 'Other people', color: '#008300' };
const AUTO_SYNC = { key: 'auto', label: 'Auto-sync', color: '#4a3aa7' };
const NOT_RECORDED = { key: 'unknown', label: 'Not recorded', color: '#e34948' };
// Total / By person toggle, remembered per browser (a viewer convenience).
let timelineView = (() => {
  try {
    return localStorage.getItem('dash:timelineView') === 'person' ? 'person' : 'total';
  } catch {
    return 'total';
  }
})();
let timelineState = null; // what the per-period card needs to redraw on a toggle
// Chart id prefix -> which edits it shows (audit_log.direction).
const FIELD_CHARTS = { 'fields-revizto': 'revizto_to_acc', 'fields-acc': 'acc_to_revizto' };
const INK = { primary: '#12161c', secondary: '#52514e', muted: '#6b7280', grid: '#e8ebf0', surface: '#ffffff' };
// [singular, plural] — tooltip rows read "1 attachment", "3 attachments".
const ACTION_LABELS = { field_change: ['field change', 'field changes'], comment: ['comment', 'comments'], attachment: ['attachment', 'attachments'] };
const DEFAULT_MONTHS = 3;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

let currentProjectId = '';
let loadSeq = 0;
let lastData = null; // kept so a resize can redraw without refetching

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user) return;
  document.getElementById('dash-app').classList.remove('hidden');
  _renderLegend();
  _applyPreset(DEFAULT_MONTHS);
  // Starts on the open project; "All projects" is at the top (nav.js).
  const { projects, currentProject } = e.detail;
  currentProjectId = currentProject ? String(currentProject.id) : '';
  window.fillProjectFilter(document.getElementById('dash-project-select'), projects, currentProject, (projectId) => {
    currentProjectId = projectId;
    load();
  });
  await load();
});

// ─── Dates ─────────────────────────────────────────────────────────
// Everything is in the viewer's local calendar: "YYYY-MM-DD" strings from
// the date inputs and from the server (grouped in TIME_ZONE, see
// services/dashboards.js) line up day for day.

function _ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function _parseYmd(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function _applyPreset(months) {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - months, to.getDate());
  document.getElementById('dash-from-date').value = _ymd(from);
  document.getElementById('dash-to-date').value = _ymd(to);
  _markPreset(months);
}

function _markPreset(months) {
  document.querySelectorAll('.dash-preset').forEach((b) => b.classList.toggle('active', Number(b.dataset.months) === months));
}

/** Every local day in [from, to] inclusive, as YYYY-MM-DD. */
function _daysBetween(fromValue, toValue) {
  const days = [];
  for (let d = _parseYmd(fromValue); d <= _parseYmd(toValue); d.setDate(d.getDate() + 1)) days.push(_ymd(d));
  return days;
}

// Long ranges roll up so the chart stays readable: daily up to ~6 weeks,
// weekly (Monday-start) up to ~6.5 months, monthly beyond that.
function _granularity(dayCount) {
  if (dayCount <= 45) return 'day';
  if (dayCount <= 200) return 'week';
  return 'month';
}

function _bucketKey(day, granularity) {
  if (granularity === 'day') return day;
  const d = _parseYmd(day);
  if (granularity === 'month') return day.slice(0, 7);
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return _ymd(d);
}

function _bucketLabel(key, granularity, { long = false } = {}) {
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: long ? 'numeric' : '2-digit' });
  }
  const d = _parseYmd(key);
  const short = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  if (!long) return short;
  const full = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return granularity === 'week' ? `Week of ${full}` : full;
}

/** Ordered bucket keys covering the range. */
function _buckets(days, granularity) {
  return [...new Set(days.map((d) => _bucketKey(d, granularity)))];
}

// ─── Loading ───────────────────────────────────────────────────────

async function load() {
  const fromValue = document.getElementById('dash-from-date').value;
  const toValue = document.getElementById('dash-to-date').value;
  const hint = document.getElementById('dash-date-hint');
  if (!fromValue || !toValue || _parseYmd(fromValue) > _parseYmd(toValue)) {
    hint.textContent = !fromValue || !toValue ? 'Pick both a From and a To date.' : '"From" is after "To" — pick a From date on or before the To date.';
    return;
  }
  hint.textContent = '';

  const seq = ++loadSeq;
  const body = document.getElementById('dash-body');
  body.classList.add('dash-loading'); // keep the previous render, dimmed — no layout jump

  // Local midnight of From through the end of To (sent as the start of the
  // next day, exclusive) — same convention as the Activity Log's range.
  const from = _parseYmd(fromValue);
  const to = _parseYmd(toValue);
  to.setDate(to.getDate() + 1);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), tz: TIME_ZONE });
  if (currentProjectId) params.set('projectId', currentProjectId);

  try {
    const [timeline, activity] = await Promise.all([
      api(`/api/dashboards/sync-timeline?${params}`),
      api(`/api/dashboards/activity?${params}`),
    ]);
    if (seq !== loadSeq) return;
    lastData = { timeline, activity, fromValue, toValue };
    document.getElementById('dash-error').textContent = '';
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    document.getElementById('dash-error').textContent = `Couldn't load dashboards: ${err.message}`;
  } finally {
    if (seq === loadSeq) body.classList.remove('dash-loading');
  }
}

function render() {
  if (!lastData) return;
  _hideTooltip(); // one left open would describe the chart being replaced
  const { timeline, activity, fromValue, toValue } = lastData;
  const days = _daysBetween(fromValue, toValue);
  const granularity = _granularity(days.length);
  const buckets = _buckets(days, granularity);

  // Issues synced: new links per bucket, and the running total at the end
  // of each bucket (starting from what was already linked before `from`).
  const newByBucket = new Map(buckets.map((b) => [b, 0]));
  for (const { day, linked } of timeline.days) {
    const key = _bucketKey(day, granularity);
    if (newByBucket.has(key)) newByBucket.set(key, newByBucket.get(key) + linked);
  }
  let running = timeline.beforeRange;
  const timelinePoints = buckets.map((key) => {
    running += newByBucket.get(key);
    return { key, total: running, added: newByBucket.get(key) };
  });

  // Activity: per bucket, per direction, with a per-type breakdown.
  const activityByBucket = new Map(
    buckets.map((b) => [b, { revizto_to_acc: { total: 0 }, acc_to_revizto: { total: 0 }, errors: 0 }])
  );
  for (const { day, direction, action, n } of activity.rows) {
    const bucket = activityByBucket.get(_bucketKey(day, granularity));
    if (!bucket) continue;
    if (action === 'error') {
      bucket.errors += n;
    } else if (bucket[direction]) {
      bucket[direction].total += n;
      bucket[direction][action] = (bucket[direction][action] || 0) + n;
    }
  }
  const activityPoints = buckets.map((key) => ({ key, ...activityByBucket.get(key) }));

  // Tiles
  const newInRange = timelinePoints.reduce((s, p) => s + p.added, 0);
  const changes = activityPoints.reduce((s, p) => s + p.revizto_to_acc.total + p.acc_to_revizto.total, 0);
  const errors = activityPoints.reduce((s, p) => s + p.errors, 0);
  document.getElementById('tile-linked').textContent = _fmt(timeline.total);
  document.getElementById('tile-new').textContent = _fmt(newInRange);
  document.getElementById('tile-changes').textContent = _fmt(changes);
  document.getElementById('tile-errors').textContent = _fmt(errors);

  const per = { day: 'per day', week: 'per week', month: 'per month' }[granularity];
  document.getElementById('timeline-title').textContent = `Issues synced ${per}`;
  document.getElementById('activity-sub').textContent = `Field changes, comments and attachments synced ${per}, by direction.`;
  document.getElementById('timeline-note').textContent = timeline.undated
    ? `${timeline.undated} linked issue${timeline.undated === 1 ? '' : 's'} don't have a first-synced date yet — they'll appear after the next sync cycle.`
    : 'Counts issues that are linked now. An issue that was unlinked no longer appears in its history.';

  // The same new links, split by who synced them (see PERSON_SLOTS).
  const named = (timeline.people || []).slice(0, PERSON_SLOTS.length);
  const personSeries = [
    // `short`: the first name, for a line-end label (see _renderMultiLineChart).
    ...named.map((p, i) => ({ key: p.key, label: p.name, short: String(p.name).split(/[\s@]/)[0], color: PERSON_SLOTS[i] })),
    OTHER_PEOPLE,
    AUTO_SYNC,
    NOT_RECORDED,
  ];
  const seriesOf = (who) => (who === 'auto' || who === 'unknown' || named.some((p) => p.key === who) ? who : OTHER_PEOPLE.key);
  const personByBucket = new Map(buckets.map((b) => [b, {}]));
  for (const { day, who, linked } of timeline.personDays || []) {
    const bucket = personByBucket.get(_bucketKey(day, granularity));
    if (!bucket) continue;
    const key = seriesOf(who);
    bucket[key] = (bucket[key] || 0) + linked;
    // Who's inside "Other people", for its tooltip.
    if (key === OTHER_PEOPLE.key) (bucket.otherPeople ||= {})[who] = (bucket.otherPeople[who] || 0) + linked;
  }
  const personPoints = buckets.map((key) => ({ key, ...personByBucket.get(key) }));
  const nameOf = Object.fromEntries((timeline.people || []).map((p) => [p.key, p.name]));
  timelineState = { timelinePoints, personPoints, personSeries, granularity, nameOf };

  _renderTotalChart(timelinePoints, granularity);
  _renderActivityChart(activityPoints, granularity);
  _renderTimelineTable(timelinePoints, granularity);
  _renderTimelineView();
  _renderActivityTable(activityPoints, granularity);

  // Field changes, one chart per side the edit was made on.
  for (const [prefix, direction] of Object.entries(FIELD_CHARTS)) {
    const byBucket = new Map(buckets.map((b) => [b, {}]));
    for (const { day, direction: dir, kind: field, n } of activity.fields || []) {
      if (dir !== direction) continue;
      const bucket = byBucket.get(_bucketKey(day, granularity));
      if (bucket) bucket[field] = (bucket[field] || 0) + n;
    }
    const points = buckets.map((key) => ({ key, ...byBucket.get(key) }));
    const totals = Object.fromEntries(FIELD_SERIES.map((f) => [f.key, points.reduce((s, p) => s + (p[f.key] || 0), 0)]));
    const where = direction === 'revizto_to_acc' ? 'Revizto' : 'ACC';
    document.getElementById(`${prefix}-sub`).textContent = `What people change in ${where} — fields, comments and attachments — ${per}. Totals for this range are in the legend.`;
    _renderLegendInto(`${prefix}-legend`, FIELD_SERIES.map((f) => ({ ...f, total: totals[f.key] })));
    _renderStackedChart({
      containerId: `${prefix}-chart`,
      points,
      granularity,
      series: FIELD_SERIES,
      valueOf: (p, field) => p[field] || 0,
      ariaLabel: (total) => `Changes made in ${where}, ${_fmt(total)} total`,
      emptyText: `No changes made in ${where} in this range`,
    });
    _table(
      `${prefix}-table`,
      [{ day: 'Day', week: 'Week of', month: 'Month' }[granularity], ...FIELD_SERIES.map((f) => f.label)],
      points.map((p) => [_bucketLabel(p.key, granularity, { long: granularity === 'month' }), ...FIELD_SERIES.map((f) => _fmt(p[f.key] || 0))])
    );
  }
}

function _fmt(n) {
  return Number(n).toLocaleString();
}

// ─── Shared chart geometry ─────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 16, right: 56, bottom: 28, left: 40 };
const HEIGHT = 240;

function _svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Clean y-axis max and ticks: 0 and ~4 round steps (1/2/5 × 10^n). */
function _niceTicks(max) {
  if (max <= 0) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw && Number.isInteger(s)) || Math.ceil(raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

/**
 * Frame: svg, recessive gridlines + y labels, and x labels for at most ~8
 * buckets. `padRight` widens the right margin (room for line-end labels).
 */
function _frame(container, points, granularity, yMax, { padRight = PAD.right } = {}) {
  container.innerHTML = '';
  const width = Math.max(container.clientWidth, 320);
  const svg = _svg('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img' });
  const plotW = width - PAD.left - padRight;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const { top, ticks } = _niceTicks(yMax);
  const y = (v) => PAD.top + plotH - (v / top) * plotH;

  for (const t of ticks) {
    svg.appendChild(_svg('line', { x1: PAD.left, x2: PAD.left + plotW, y1: y(t), y2: y(t), stroke: INK.grid, 'stroke-width': 1 }));
    const label = _svg('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'dash-axis' });
    label.textContent = _fmt(t);
    svg.appendChild(label);
  }

  const band = plotW / points.length;
  const xCenter = (i) => PAD.left + band * i + band / 2;
  const every = Math.ceil(points.length / 8);
  points.forEach((p, i) => {
    if (i % every !== 0 && i !== points.length - 1) return;
    if (i !== points.length - 1 && points.length - 1 - i < every / 2 && i % every === 0 && i !== 0) return; // avoid crowding the last label
    const label = _svg('text', { x: xCenter(i), y: HEIGHT - 8, 'text-anchor': 'middle', class: 'dash-axis' });
    label.textContent = _bucketLabel(p.key, granularity);
    svg.appendChild(label);
  });

  container.appendChild(svg);
  return { svg, width, plotW, plotH, y, band, xCenter };
}

// ─── Tooltip ───────────────────────────────────────────────────────

const tooltip = document.getElementById('dash-tooltip');

/** rows: [{ value, label, color? }] — value leads, label follows; built with textContent. */
function _showTooltip(evt, title, rows) {
  tooltip.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'dash-tooltip-title';
  head.textContent = title;
  tooltip.appendChild(head);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'dash-tooltip-row';
    if (r.color) {
      const key = document.createElement('span');
      key.className = 'dash-tooltip-key';
      key.style.background = r.color;
      row.appendChild(key);
    }
    const value = document.createElement('strong');
    value.textContent = r.value;
    row.appendChild(value);
    const label = document.createElement('span');
    label.textContent = ` ${r.label}`;
    row.appendChild(label);
    tooltip.appendChild(row);
  }
  tooltip.hidden = false;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let left = evt.clientX + pad;
  if (left + rect.width > window.innerWidth - 8) left = evt.clientX - rect.width - pad;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(8, evt.clientY - rect.height - pad)}px`;
}

function _hideTooltip() {
  tooltip.hidden = true;
}

// ─── Chart 1: issues synced over time (line + area wash) ───────────

/**
 * One-series line with a light wash under it, a crosshair tooltip that
 * snaps to the nearest bucket, and arrow-key stepping. `valueOf(point)`
 * is what's plotted; `label` picks the one direct label ('end' — the
 * latest value, for a running total — or 'peak'); `markers` adds a dot
 * per point (skipped when points are too dense to read as dots).
 */
function _renderLineChart({ containerId, points, granularity, valueOf, label, markers, ariaLabel, tooltipRows }) {
  const container = document.getElementById(containerId);
  const values = points.map(valueOf);
  const max = Math.max(...values, 1);
  const { svg, plotH, y, xCenter, band } = _frame(container, points, granularity, max);
  svg.setAttribute('aria-label', ariaLabel(values));

  const coords = points.map((p, i) => [xCenter(i), y(values[i])]);
  const line = coords.map(([x, yy], i) => `${i ? 'L' : 'M'}${x},${yy}`).join(' ');
  const baseY = PAD.top + plotH;
  svg.appendChild(_svg('path', { d: `${line} L${coords[coords.length - 1][0]},${baseY} L${coords[0][0]},${baseY} Z`, fill: TIMELINE_COLOR, 'fill-opacity': 0.1 }));
  svg.appendChild(_svg('path', { d: line, fill: 'none', stroke: TIMELINE_COLOR, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  const dot = ([cx, cy]) => svg.appendChild(_svg('circle', { cx, cy, r: 4, fill: TIMELINE_COLOR, stroke: INK.surface, 'stroke-width': 2 }));
  if (markers && band >= 12) coords.forEach(dot);

  if (label === 'end') {
    // End dot (2px surface ring) + the latest value beside it.
    const last = coords[coords.length - 1];
    if (!markers || band < 12) dot(last);
    const endLabel = _svg('text', { x: last[0] + 8, y: last[1] + 4, class: 'dash-end-label' });
    endLabel.textContent = _fmt(values[values.length - 1]);
    svg.appendChild(endLabel);
  } else {
    // The peak period's value, above its point.
    const peak = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
    if (values[peak] > 0) {
      const peakLabel = _svg('text', { x: coords[peak][0], y: coords[peak][1] - 10, 'text-anchor': 'middle', class: 'dash-end-label' });
      peakLabel.textContent = _fmt(values[peak]);
      svg.appendChild(peakLabel);
    }
  }

  // Crosshair: snaps to the nearest bucket; one tooltip with that bucket's numbers.
  const cross = _svg('line', { y1: PAD.top, y2: baseY, stroke: INK.muted, 'stroke-width': 1, visibility: 'hidden' });
  const hoverDot = _svg('circle', { r: 4, fill: TIMELINE_COLOR, stroke: INK.surface, 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, hoverDot);
  const hit = _svg('rect', { x: PAD.left, y: PAD.top, width: band * points.length, height: plotH, fill: 'transparent', tabindex: 0 });
  svg.appendChild(hit);

  const show = (evt, i) => {
    cross.setAttribute('x1', xCenter(i));
    cross.setAttribute('x2', xCenter(i));
    cross.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', xCenter(i));
    hoverDot.setAttribute('cy', y(values[i]));
    hoverDot.setAttribute('visibility', 'visible');
    _showTooltip(evt, _bucketLabel(points[i].key, granularity, { long: true }), tooltipRows(points[i]));
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    _hideTooltip();
  };
  let focusIndex = points.length - 1;
  hit.addEventListener('pointermove', (evt) => {
    const box = svg.getBoundingClientRect();
    focusIndex = Math.min(points.length - 1, Math.max(0, Math.floor((evt.clientX - box.left - PAD.left) / band)));
    show(evt, focusIndex);
  });
  hit.addEventListener('pointerleave', hide);
  // Keyboard: same readout as hover, arrow keys step through buckets.
  const keyShow = () => {
    const box = svg.getBoundingClientRect();
    show({ clientX: box.left + xCenter(focusIndex), clientY: box.top + y(values[focusIndex]) }, focusIndex);
  };
  hit.addEventListener('focus', keyShow);
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (evt) => {
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
    evt.preventDefault();
    focusIndex = Math.min(points.length - 1, Math.max(0, focusIndex + (evt.key === 'ArrowRight' ? 1 : -1)));
    keyShow();
  });
}

/**
 * Several lines on one frame — one per series, overlapping, each in its
 * fixed color (no area wash: overlapping washes would muddy). Same marks
 * as the single-line chart: 2px lines, dots with a 2px surface ring. The
 * crosshair tooltip lists every series' value for that bucket plus the
 * total. Up to four lines also get a first-name label at their end (nudged
 * apart so labels never overlap); past four, the legend, tooltip and table
 * carry identity.
 * series: [{ key, label, color }] (only those to draw); valueOf(point, key).
 */
function _renderMultiLineChart({ containerId, points, granularity, series, valueOf, labelOf = (p, s) => s.label, ariaLabel, emptyText }) {
  const container = document.getElementById(containerId);
  const endLabels = series.length > 0 && series.length <= 4;
  const endText = (s) => s.short || s.label; // e.g. a person's first name
  const labelRoom = endLabels ? Math.min(140, 16 + 7 * Math.max(...series.map((s) => endText(s).length))) : PAD.right;
  const max = Math.max(1, ...series.flatMap((s) => points.map((p) => valueOf(p, s.key))));
  const { svg, plotH, y, xCenter, band } = _frame(container, points, granularity, max, { padRight: Math.max(PAD.right, labelRoom) });
  const grand = series.reduce((sum, s) => sum + points.reduce((t, p) => t + valueOf(p, s.key), 0), 0);
  svg.setAttribute('aria-label', ariaLabel(grand));
  const baseY = PAD.top + plotH;

  if (!series.length) {
    const empty = _svg('text', { x: PAD.left + (band * points.length) / 2, y: HEIGHT / 2, 'text-anchor': 'middle', class: 'dash-empty' });
    empty.textContent = emptyText;
    svg.appendChild(empty);
    return;
  }

  // Drawn last-to-first, so the first series (e.g. the first person) sits
  // on top where lines overlap — they all share the zero line in quiet
  // periods. Dots only on non-zero points, so the zero line isn't a pile
  // of stacked dots; the crosshair still rings every line.
  const coordsOf = (s) => points.map((p, i) => [xCenter(i), y(valueOf(p, s.key))]);
  for (const s of [...series].reverse()) {
    const coords = coordsOf(s);
    const d = coords.map(([x, yy], i) => `${i ? 'L' : 'M'}${x},${yy}`).join(' ');
    svg.appendChild(_svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (band >= 12) {
      coords.forEach(([cx, cy], i) => {
        if (valueOf(points[i], s.key) > 0) svg.appendChild(_svg('circle', { cx, cy, r: 4, fill: s.color, stroke: INK.surface, 'stroke-width': 2 }));
      });
    }
  }

  if (endLabels) {
    // First names beside each line's last point, pushed apart vertically
    // (≥ 13px) where lines end at the same value. Text ink, not the color.
    const lastX = xCenter(points.length - 1);
    const labels = series
      .map((s) => ({ s, y: y(valueOf(points[points.length - 1], s.key)) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
    const overflow = labels.length ? labels[labels.length - 1].y - baseY : 0;
    if (overflow > 0) for (const l of labels) l.y -= overflow;
    for (const l of labels) {
      const text = _svg('text', { x: lastX + 9, y: l.y + 4, class: 'dash-end-label' });
      text.textContent = endText(l.s);
      svg.appendChild(text);
    }
  }

  // Crosshair: snaps to the nearest bucket; a ringed dot on every line and
  // one tooltip with each series' value there.
  const cross = _svg('line', { y1: PAD.top, y2: baseY, stroke: INK.muted, 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const hoverDots = series.map((s) => {
    const dot = _svg('circle', { r: 5, fill: s.color, stroke: INK.surface, 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(dot);
    return dot;
  });
  const hit = _svg('rect', { x: PAD.left, y: PAD.top, width: band * points.length, height: plotH, fill: 'transparent', tabindex: 0 });
  svg.appendChild(hit);

  const show = (evt, i) => {
    cross.setAttribute('x1', xCenter(i));
    cross.setAttribute('x2', xCenter(i));
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      hoverDots[k].setAttribute('cx', xCenter(i));
      hoverDots[k].setAttribute('cy', y(valueOf(points[i], s.key)));
      hoverDots[k].setAttribute('visibility', 'visible');
    });
    const rows = series.map((s) => ({ value: _fmt(valueOf(points[i], s.key)), label: labelOf(points[i], s), color: s.color }));
    const total = series.reduce((sum, s) => sum + valueOf(points[i], s.key), 0);
    _showTooltip(evt, _bucketLabel(points[i].key, granularity, { long: true }), [...rows, { value: _fmt(total), label: 'in total' }]);
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    for (const dot of hoverDots) dot.setAttribute('visibility', 'hidden');
    _hideTooltip();
  };
  let focusIndex = points.length - 1;
  hit.addEventListener('pointermove', (evt) => {
    const box = svg.getBoundingClientRect();
    focusIndex = Math.min(points.length - 1, Math.max(0, Math.floor((evt.clientX - box.left - PAD.left) / band)));
    show(evt, focusIndex);
  });
  hit.addEventListener('pointerleave', hide);
  const keyShow = () => {
    const box = svg.getBoundingClientRect();
    show({ clientX: box.left + xCenter(focusIndex), clientY: box.top + PAD.top + 20 }, focusIndex);
  };
  hit.addEventListener('focus', keyShow);
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (evt) => {
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
    evt.preventDefault();
    focusIndex = Math.min(points.length - 1, Math.max(0, focusIndex + (evt.key === 'ArrowRight' ? 1 : -1)));
    keyShow();
  });
}

/**
 * Total linked issues over time — a running total that starts from what
 * was already linked before the range, so each point is the true total on
 * that date, not a count restarted at the range's start.
 */
function _renderTotalChart(points, granularity) {
  _renderLineChart({
    containerId: 'total-chart',
    points,
    granularity,
    valueOf: (p) => p.total,
    label: 'end',
    markers: false,
    ariaLabel: (v) => `Total linked issues over time, from ${_fmt(v[0])} to ${_fmt(v[v.length - 1])}`,
    tooltipRows: (p) => [
      { value: _fmt(p.total), label: 'linked in total', color: TIMELINE_COLOR },
      { value: `+${_fmt(p.added)}`, label: 'newly synced' },
    ],
  });
}

/**
 * Issues newly synced per bucket (week, for the default range) — each
 * period's real count, ups and downs included. A dot per point makes each
 * value readable; the peak gets the one direct label.
 */
function _renderTimelineChart(points, granularity) {
  const unit = { day: 'day', week: 'week', month: 'month' }[granularity];
  _renderLineChart({
    containerId: 'timeline-chart',
    points,
    granularity,
    valueOf: (p) => p.added,
    label: 'peak',
    markers: true,
    ariaLabel: (v) => `Issues newly synced per ${unit}, peak ${_fmt(Math.max(...v))}`,
    tooltipRows: (p) => [
      { value: _fmt(p.added), label: 'newly synced', color: TIMELINE_COLOR },
      { value: _fmt(p.total), label: 'linked in total by then' },
    ],
  });
}

/**
 * The per-period card: the Total line (above), or — "By person" — one
 * overlapping line per person who synced issues (user's call: lines, not
 * stacked columns), with a legend of each one's total for the range (only
 * those who synced any) and the table to match.
 */
function _renderTimelineView() {
  if (!timelineState) return;
  const { timelinePoints, personPoints, personSeries, granularity, nameOf } = timelineState;
  const byPerson = timelineView === 'person';
  for (const btn of document.querySelectorAll('.dash-view-btn')) {
    const on = btn.dataset.view === timelineView;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const legend = document.getElementById('timeline-legend');
  legend.classList.toggle('hidden', !byPerson);
  if (!byPerson) {
    document.getElementById('timeline-sub').textContent = `How many issues were first synced each ${granularity}.`;
    _renderTimelineChart(timelinePoints, granularity);
    return; // _renderTimelineTable already filled its table
  }

  document.getElementById('timeline-sub').textContent = `How many issues each person synced each ${granularity} — one line per person (or auto-sync). Totals for this range are in the legend.`;
  const totals = Object.fromEntries(personSeries.map((s) => [s.key, personPoints.reduce((sum, p) => sum + (p[s.key] || 0), 0)]));
  const shown = personSeries.filter((s) => totals[s.key] > 0);
  _renderLegendInto('timeline-legend', shown.map((s) => ({ ...s, total: totals[s.key] })));
  _renderMultiLineChart({
    containerId: 'timeline-chart',
    points: personPoints,
    granularity,
    series: shown, // only those who synced any in this range; colors stay fixed per person
    valueOf: (p, key) => p[key] || 0,
    // "Other people": say who's in it for that period.
    labelOf: (p, s) =>
      s.key === OTHER_PEOPLE.key && p.otherPeople
        ? `${s.label} (${Object.keys(p.otherPeople).map((who) => nameOf[who] || 'someone').join(', ')})`
        : s.label,
    ariaLabel: (total) => `Issues synced per ${granularity} by person, ${_fmt(total)} total`,
    emptyText: 'No issues synced in this range',
  });
  _table(
    'timeline-table',
    [{ day: 'Day', week: 'Week of', month: 'Month' }[granularity], ...shown.map((s) => s.label)],
    personPoints.map((p) => [_bucketLabel(p.key, granularity, { long: granularity === 'month' }), ...shown.map((s) => _fmt(p[s.key] || 0))])
  );
}

for (const btn of document.querySelectorAll('.dash-view-btn')) {
  btn.addEventListener('click', () => {
    timelineView = btn.dataset.view;
    try {
      localStorage.setItem('dash:timelineView', timelineView);
    } catch {
      // storage blocked — the toggle still works for this visit
    }
    // Back to the totals table under the line, then the chosen view.
    _hideTooltip();
    if (timelineState) _renderTimelineTable(timelineState.timelinePoints, timelineState.granularity);
    _renderTimelineView();
  });
}

// ─── Chart 2: sync activity (stacked columns by direction) ─────────

/** A column segment: square corners, except a 4px rounded top when it's the column's data-end. */
function _segmentPath(x, yTop, w, h, roundTop) {
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${yTop + h} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yTop + h} Z`;
}

/**
 * Stacked columns, one segment per series, in the series' fixed order
 * (never re-ordered by size, so a color always means the same thing).
 * series: [{ key, label, color }]; valueOf(point, key) -> number;
 * detailRows(point, series) -> extra tooltip rows under the value.
 */
function _renderStackedChart({ containerId, points, granularity, series, valueOf, detailRows = () => [], ariaLabel, emptyText }) {
  const container = document.getElementById(containerId);
  const totals = points.map((p) => series.reduce((s, ser) => s + valueOf(p, ser.key), 0));
  const { svg, y, xCenter, band } = _frame(container, points, granularity, Math.max(...totals, 1));
  svg.setAttribute('aria-label', ariaLabel(totals.reduce((a, b) => a + b, 0)));
  const colW = Math.max(2, Math.min(24, band * 0.6));
  const GAP = 2; // surface gap between stacked segments

  points.forEach((p, i) => {
    const x = xCenter(i) - colW / 2;
    let base = 0;
    const present = series.filter((ser) => valueOf(p, ser.key) > 0);
    present.forEach((ser, k) => {
      const v = valueOf(p, ser.key);
      const yBottom = y(base) - (k > 0 ? GAP : 0);
      const yTop = y(base + v);
      const h = Math.max(1, yBottom - yTop);
      const seg = _svg('path', { d: _segmentPath(x, yTop, colW, h, k === present.length - 1), fill: ser.color, class: 'dash-bar', tabindex: 0 });
      const title = `${_bucketLabel(p.key, granularity, { long: true })} · ${ser.label}`;
      seg.setAttribute('aria-label', `${title}: ${v}`);
      const show = (evt) => _showTooltip(evt, title, [{ value: _fmt(v), label: 'synced', color: ser.color }, ...detailRows(p, ser)]);
      seg.addEventListener('pointermove', show);
      seg.addEventListener('pointerleave', _hideTooltip);
      seg.addEventListener('focus', () => {
        const box = seg.getBoundingClientRect();
        show({ clientX: box.right, clientY: box.top });
      });
      seg.addEventListener('blur', _hideTooltip);
      svg.appendChild(seg);
      base += v;
    });
  });

  if (!totals.some((t) => t > 0)) {
    const empty = _svg('text', { x: PAD.left + (band * points.length) / 2, y: HEIGHT / 2, 'text-anchor': 'middle', class: 'dash-empty' });
    empty.textContent = emptyText;
    svg.appendChild(empty);
  }
}

function _renderActivityChart(points, granularity) {
  _renderStackedChart({
    containerId: 'activity-chart',
    points,
    granularity,
    series: Object.entries(SERIES).map(([key, s]) => ({ key, ...s })),
    valueOf: (p, dir) => p[dir].total,
    detailRows: (p, ser) =>
      Object.entries(ACTION_LABELS)
        .filter(([action]) => p[ser.key][action])
        .map(([action, [one, many]]) => ({ value: _fmt(p[ser.key][action]), label: p[ser.key][action] === 1 ? one : many })),
    ariaLabel: (total) => `Sync activity by direction, ${_fmt(total)} changes total`,
    emptyText: 'No sync activity in this range',
  });
}

function _renderLegend() {
  _renderLegendInto('activity-legend', Object.values(SERIES));
}

/** items: [{ label, color, total? }] — the total, when given, is the range's count (text ink, not the series color). */
function _renderLegendInto(containerId, items) {
  const legend = document.getElementById(containerId);
  legend.innerHTML = '';
  for (const { label, color, total } of items) {
    const item = document.createElement('span');
    item.className = 'dash-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'dash-legend-swatch';
    swatch.style.background = color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(label));
    if (total != null) {
      const count = document.createElement('strong');
      count.className = 'dash-legend-total';
      count.textContent = _fmt(total);
      item.appendChild(count);
    }
    legend.appendChild(item);
  }
}

// ─── Table views (every value reachable without hovering) ──────────

function _table(containerId, headers, rows) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const r of rows) {
    const tr = tbody.insertRow();
    for (const cell of r) tr.insertCell().textContent = cell;
  }
  container.appendChild(table);
}

// Same rows under both line charts (total and per-period), since each
// chart's table should carry its own numbers without hovering.
function _renderTimelineTable(points, granularity) {
  for (const id of ['total-table', 'timeline-table']) {
    _table(
      id,
      [{ day: 'Day', week: 'Week of', month: 'Month' }[granularity], 'Newly synced', 'Total linked'],
      points.map((p) => [_bucketLabel(p.key, granularity, { long: granularity === 'month' }), _fmt(p.added), _fmt(p.total)])
    );
  }
}

function _renderActivityTable(points, granularity) {
  _table(
    'activity-table',
    [{ day: 'Day', week: 'Week of', month: 'Month' }[granularity], 'Revizto → ACC', 'ACC → Revizto', 'Errors'],
    points.map((p) => [_bucketLabel(p.key, granularity, { long: granularity === 'month' }), _fmt(p.revizto_to_acc.total), _fmt(p.acc_to_revizto.total), _fmt(p.errors)])
  );
}

// ─── Filters ───────────────────────────────────────────────────────

document.querySelectorAll('.dash-preset').forEach((btn) =>
  btn.addEventListener('click', () => {
    _applyPreset(Number(btn.dataset.months));
    load();
  })
);
for (const id of ['dash-from-date', 'dash-to-date']) {
  document.getElementById(id).addEventListener('change', () => {
    _markPreset(null); // a hand-picked range isn't one of the presets
    load();
  });
}

// Charts size to their card — redraw from the last data on resize.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});
