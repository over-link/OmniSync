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
  await loadProjectOptions();
  await load();
});

async function loadProjectOptions() {
  const select = document.getElementById('dash-project-select');
  try {
    const { projects } = await api('/api/projects');
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    }
  } catch (err) {
    console.warn('Could not load project list for filter:', err.message);
  }
}

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
  document.getElementById('activity-sub').textContent = `Field changes, comments and attachments synced ${per}, by direction.`;
  document.getElementById('timeline-note').textContent = timeline.undated
    ? `${timeline.undated} linked issue${timeline.undated === 1 ? '' : 's'} don't have a first-synced date yet — they'll appear after the next sync cycle.`
    : 'Counts issues that are linked now. An issue that was unlinked no longer appears in its history.';

  _renderTimelineChart(timelinePoints, granularity);
  _renderActivityChart(activityPoints, granularity);
  _renderTimelineTable(timelinePoints, granularity);
  _renderActivityTable(activityPoints, granularity);
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

/** Frame: svg, recessive gridlines + y labels, and x labels for at most ~8 buckets. */
function _frame(container, points, granularity, yMax) {
  container.innerHTML = '';
  const width = Math.max(container.clientWidth, 320);
  const svg = _svg('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img' });
  const plotW = width - PAD.left - PAD.right;
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

function _renderTimelineChart(points, granularity) {
  const container = document.getElementById('timeline-chart');
  const max = Math.max(...points.map((p) => p.total), 1);
  const { svg, plotH, y, xCenter, band } = _frame(container, points, granularity, max);
  svg.setAttribute('aria-label', `Linked issues over time, from ${_fmt(points[0].total)} to ${_fmt(points[points.length - 1].total)}`);

  const coords = points.map((p, i) => [xCenter(i), y(p.total)]);
  const line = coords.map(([x, yy], i) => `${i ? 'L' : 'M'}${x},${yy}`).join(' ');
  const baseY = PAD.top + plotH;
  svg.appendChild(_svg('path', { d: `${line} L${coords[coords.length - 1][0]},${baseY} L${coords[0][0]},${baseY} Z`, fill: TIMELINE_COLOR, 'fill-opacity': 0.1 }));
  svg.appendChild(_svg('path', { d: line, fill: 'none', stroke: TIMELINE_COLOR, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // End dot (2px surface ring) + the one direct label: the current value.
  const [ex, ey] = coords[coords.length - 1];
  svg.appendChild(_svg('circle', { cx: ex, cy: ey, r: 4, fill: TIMELINE_COLOR, stroke: INK.surface, 'stroke-width': 2 }));
  const endLabel = _svg('text', { x: ex + 8, y: ey + 4, class: 'dash-end-label' });
  endLabel.textContent = _fmt(points[points.length - 1].total);
  svg.appendChild(endLabel);

  // Crosshair: snaps to the nearest bucket; one tooltip with that bucket's numbers.
  const cross = _svg('line', { y1: PAD.top, y2: baseY, stroke: INK.muted, 'stroke-width': 1, visibility: 'hidden' });
  const hoverDot = _svg('circle', { r: 4, fill: TIMELINE_COLOR, stroke: INK.surface, 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, hoverDot);
  const hit = _svg('rect', { x: PAD.left, y: PAD.top, width: band * points.length, height: plotH, fill: 'transparent', tabindex: 0 });
  svg.appendChild(hit);

  const show = (evt, i) => {
    const p = points[i];
    cross.setAttribute('x1', xCenter(i));
    cross.setAttribute('x2', xCenter(i));
    cross.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', xCenter(i));
    hoverDot.setAttribute('cy', y(p.total));
    hoverDot.setAttribute('visibility', 'visible');
    _showTooltip(evt, _bucketLabel(p.key, granularity, { long: true }), [
      { value: _fmt(p.total), label: 'linked issues', color: TIMELINE_COLOR },
      { value: `+${_fmt(p.added)}`, label: 'newly synced' },
    ]);
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
    show({ clientX: box.left + xCenter(focusIndex), clientY: box.top + y(points[focusIndex].total) }, focusIndex);
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

// ─── Chart 2: sync activity (stacked columns by direction) ─────────

/** A column segment: square corners, except a 4px rounded top when it's the column's data-end. */
function _segmentPath(x, yTop, w, h, roundTop) {
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${yTop + h} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yTop + h} Z`;
}

function _renderActivityChart(points, granularity) {
  const container = document.getElementById('activity-chart');
  const totals = points.map((p) => p.revizto_to_acc.total + p.acc_to_revizto.total);
  const { svg, y, xCenter, band } = _frame(container, points, granularity, Math.max(...totals, 1));
  svg.setAttribute('aria-label', `Sync activity by direction, ${_fmt(totals.reduce((a, b) => a + b, 0))} changes total`);
  const colW = Math.max(2, Math.min(24, band * 0.6));
  const GAP = 2; // surface gap between stacked segments

  points.forEach((p, i) => {
    const x = xCenter(i) - colW / 2;
    let base = 0;
    const order = ['revizto_to_acc', 'acc_to_revizto'].filter((dir) => p[dir].total > 0);
    order.forEach((dir, k) => {
      const v = p[dir].total;
      const yBottom = y(base) - (k > 0 ? GAP : 0);
      const yTop = y(base + v);
      const h = Math.max(1, yBottom - yTop);
      const seg = _svg('path', { d: _segmentPath(x, yTop, colW, h, k === order.length - 1), fill: SERIES[dir].color, class: 'dash-bar', tabindex: 0 });
      seg.setAttribute('aria-label', `${_bucketLabel(p.key, granularity, { long: true })}: ${v} ${SERIES[dir].label}`);
      const breakdown = Object.entries(ACTION_LABELS)
        .filter(([action]) => p[dir][action])
        .map(([action, [one, many]]) => ({ value: _fmt(p[dir][action]), label: p[dir][action] === 1 ? one : many }));
      const show = (evt) => _showTooltip(evt, `${_bucketLabel(p.key, granularity, { long: true })} · ${SERIES[dir].label}`, [
        { value: _fmt(v), label: 'synced', color: SERIES[dir].color },
        ...breakdown,
      ]);
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
    empty.textContent = 'No sync activity in this range';
    svg.appendChild(empty);
  }
}

function _renderLegend() {
  const legend = document.getElementById('activity-legend');
  for (const { label, color } of Object.values(SERIES)) {
    const item = document.createElement('span');
    item.className = 'dash-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'dash-legend-swatch';
    swatch.style.background = color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(label));
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

function _renderTimelineTable(points, granularity) {
  _table(
    'timeline-table',
    [{ day: 'Day', week: 'Week of', month: 'Month' }[granularity], 'Newly synced', 'Total linked'],
    points.map((p) => [_bucketLabel(p.key, granularity, { long: granularity === 'month' }), _fmt(p.added), _fmt(p.total)])
  );
}

function _renderActivityTable(points, granularity) {
  _table(
    'activity-table',
    [{ day: 'Day', week: 'Week of', month: 'Month' }[granularity], 'Revizto → ACC', 'ACC → Revizto', 'Errors'],
    points.map((p) => [_bucketLabel(p.key, granularity, { long: granularity === 'month' }), _fmt(p.revizto_to_acc.total), _fmt(p.acc_to_revizto.total), _fmt(p.errors)])
  );
}

// ─── Filters ───────────────────────────────────────────────────────

document.getElementById('dash-project-select').addEventListener('change', (e) => {
  currentProjectId = e.target.value;
  load();
});
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
