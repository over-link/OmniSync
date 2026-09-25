async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

const PAGE_SIZE = 50;
let loadedCount = 0; // entries currently shown — the next "Load more" starts here
let currentProjectId = '';
// Bumped on every load, so a slow earlier response (e.g. a Load more
// still in flight when the dates change) can't land on the new list.
let loadSeq = 0;

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user) {
    document.getElementById('signed-out-notice').classList.remove('hidden');
    return;
  }
  document.getElementById('logs-app').classList.remove('hidden');
  await loadProjectOptions();
  await loadEntries({ reset: true });
});

// <input type="date"> gives "YYYY-MM-DD" with no timezone. Build the
// boundary in the viewer's OWN timezone (new Date(y, m, d) is local
// midnight), so "7/15 – 7/22" means 12:00 AM 7/15 through the end of
// 7/22 on their clock — `to` is sent as the start of the NEXT day and
// the server treats it as exclusive.
function _localDayStart(value, addDays = 0) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d + addDays);
}

function _dateRange() {
  const fromValue = document.getElementById('log-from-date').value;
  const toValue = document.getElementById('log-to-date').value;
  return { from: _localDayStart(fromValue), to: _localDayStart(toValue, 1), fromValue, toValue };
}

async function loadProjectOptions() {
  const select = document.getElementById('log-project-select');
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

// Internal field keys (Revizto's diff-comment keys) -> what people call them.
const FIELD_LABELS = {
  customStatus: 'Status',
  assignee: 'Assignee',
  watchers: 'Watchers',
  priority: 'Priority',
  deadline: 'Due date',
  title: 'Title',
};

function _fieldChangeHtml(entry) {
  // old_label/new_label: server-resolved display values (e.g. a status
  // name instead of Revizto's raw status UUID) — see labelAuditEntries.
  const oldRaw = entry.old_label ?? entry.old_value;
  const newRaw = entry.new_label ?? entry.new_value;
  const old = oldRaw != null ? _escape(_prettyValue(oldRaw)) : '(none)';
  const next = newRaw != null ? _escape(_prettyValue(newRaw)) : '(none)';
  const field = _escape(FIELD_LABELS[entry.field_name] || entry.field_name);
  return `<span class="log-field-change"><strong>${field}</strong>: <span class="log-old">${old}</span> → <span class="log-new">${next}</span></span>`;
}

function _prettyValue(raw) {
  // Stored as JSON.stringify'd values (see auditLog.record callers) so a
  // plain string, a null, or an array all round-trip cleanly — parse back
  // to something readable rather than showing raw JSON quoting.
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return '(none)';
    if (Array.isArray(parsed)) return parsed.length ? parsed.join(', ') : '(none)';
    return String(parsed);
  } catch {
    return raw;
  }
}

const ACTION_LABELS = {
  field_change: 'Field change',
  comment: 'Comment',
  attachment: 'Attachment',
  link: 'Linked',
  unlink: 'Unlinked',
  deleted: 'Deleted',
  error: 'Error',
};

function _rowHtml(entry) {
  const when = new Date(entry.created_at).toLocaleString();
  const project = entry.project_name || '—';
  const action = ACTION_LABELS[entry.action] || entry.action;
  const directionArrow = entry.direction === 'revizto_to_acc' ? 'Revizto → ACC' : entry.direction === 'acc_to_revizto' ? 'ACC → Revizto' : '';

  let detail;
  if (entry.action === 'field_change') {
    detail = _fieldChangeHtml(entry);
  } else if (entry.action === 'comment' || entry.action === 'attachment') {
    detail = entry.new_value ? _escape(entry.new_value.slice(0, 140)) : (entry.detail ? _escape(entry.detail) : '');
  } else {
    detail = entry.detail ? _escape(entry.detail) : '';
  }
  const subline = directionArrow ? `<div class="hint" style="margin:0;">${directionArrow}</div>` : '';

  // A linked issue deleted in Revizto or ACC (link removed) — red, and
  // called what it is rather than a generic "error".
  const outcomeBadge =
    entry.action === 'deleted'
      ? '<span class="badge badge-danger">deleted</span>'
      : entry.outcome === 'error'
        ? '<span class="badge badge-danger">error</span>'
        : '<span class="badge badge-success">ok</span>';

  const reviztoNum = entry.revizto_issue_id ? `#${_escape(entry.revizto_issue_id)}` : '—';
  const accNum = entry.acc_display_id ? `#${_escape(entry.acc_display_id)}` : '—';
  // Name from the Revizto license when known; the email stays available
  // on hover, and is shown as-is for people not on the license.
  const person = entry.attributed_name
    ? `<span title="${_escape(entry.attributed_email)}">${_escape(entry.attributed_name)}</span>`
    : entry.attributed_email ? _escape(entry.attributed_email) : '—';

  return `<div class="log-row${entry.outcome === 'error' ? ' log-row-error' : ''}">
    <span class="log-timestamp">${when}</span>
    <span>${_escape(project)}</span>
    <span>${reviztoNum}</span>
    <span>${accNum}</span>
    <span>${action}${subline}</span>
    <span>${detail}</span>
    <span>${person}</span>
    <span>${outcomeBadge}</span>
  </div>`;
}

function _escape(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// reset: start the list over (filters changed, Refresh); otherwise
// append the next PAGE_SIZE entries below what's already shown.
async function loadEntries({ reset } = {}) {
  const rowsEl = document.getElementById('log-rows');
  const emptyEl = document.getElementById('log-empty');
  const statusEl = document.getElementById('log-status');
  const hintEl = document.getElementById('log-date-hint');
  const loadMoreEl = document.getElementById('log-load-more');
  const loadMoreBtn = document.getElementById('log-load-more-btn');
  const seq = ++loadSeq;

  if (reset) {
    loadedCount = 0;
    rowsEl.innerHTML = '';
    loadMoreEl.classList.add('hidden');
  }

  const { from, to, fromValue, toValue } = _dateRange();
  if (from && to && from >= to) {
    hintEl.textContent = '"From" is after "To" — pick a From date on or before the To date.';
    rowsEl.innerHTML = '';
    emptyEl.classList.add('hidden');
    statusEl.classList.add('hidden');
    loadMoreEl.classList.add('hidden');
    return;
  }
  hintEl.textContent = '';

  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: loadedCount });
  if (currentProjectId) params.set('projectId', currentProjectId);
  if (from) params.set('from', from.toISOString());
  if (to) params.set('to', to.toISOString());
  const action = document.getElementById('log-action-select').value;
  if (action) params.set('action', action);

  if (reset) {
    statusEl.textContent = 'Loading…';
    statusEl.classList.remove('hidden');
  } else {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
  }
  try {
    const { entries, total } = await api(`/api/audit-log?${params.toString()}`);
    if (seq !== loadSeq) return; // a newer load has started since
    rowsEl.insertAdjacentHTML('beforeend', entries.map(_rowHtml).join(''));
    loadedCount += entries.length;
    statusEl.classList.add('hidden');
    emptyEl.textContent = fromValue || toValue ? 'No activity in this date range.' : 'No log entries yet.';
    emptyEl.classList.toggle('hidden', total > 0);
    // Shown whenever there's anything listed, so the count is always
    // visible; the button itself only while there's more to fetch.
    loadMoreEl.classList.toggle('hidden', total === 0);
    document.getElementById('log-shown-info').textContent = `Showing ${loadedCount} of ${total}`;
    loadMoreBtn.classList.toggle('hidden', loadedCount >= total);
  } catch (err) {
    if (seq !== loadSeq) return;
    statusEl.textContent = err.message;
    statusEl.classList.remove('hidden');
  } finally {
    if (seq === loadSeq) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
    }
  }
}

// Any change to what's being looked at starts the list over.
function _reload() {
  loadEntries({ reset: true });
}

document.getElementById('log-project-select').addEventListener('change', (e) => {
  currentProjectId = e.target.value;
  _reload();
});
document.getElementById('log-action-select').addEventListener('change', _reload);
document.getElementById('log-from-date').addEventListener('change', _reload);
document.getElementById('log-to-date').addEventListener('change', _reload);
document.getElementById('log-clear-dates-btn').addEventListener('click', () => {
  document.getElementById('log-from-date').value = '';
  document.getElementById('log-to-date').value = '';
  _reload();
});

// Refresh starts over from the top — new activity arrives there, and
// appending after it would shift every offset by the number of new rows.
document.getElementById('log-refresh-btn').addEventListener('click', _reload);
document.getElementById('log-load-more-btn').addEventListener('click', () => loadEntries({ reset: false }));
