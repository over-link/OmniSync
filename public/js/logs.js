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

const PAGE_SIZE = 100;
let currentOffset = 0;
let currentProjectId = '';

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user) {
    document.getElementById('signed-out-notice').classList.remove('hidden');
    return;
  }
  document.getElementById('logs-app').classList.remove('hidden');
  await loadProjectOptions();
  await loadEntries({ reset: true });
});

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

  const outcomeBadge =
    entry.outcome === 'error'
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

async function loadEntries({ reset } = {}) {
  const rowsEl = document.getElementById('log-rows');
  const emptyEl = document.getElementById('log-empty');
  const loadMoreBtn = document.getElementById('log-load-more-btn');
  const loadMoreHint = document.getElementById('log-load-more-hint');

  if (reset) {
    currentOffset = 0;
    rowsEl.innerHTML = '';
  }

  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: currentOffset });
  if (currentProjectId) params.set('projectId', currentProjectId);

  loadMoreHint.textContent = 'Loading…';
  try {
    const { entries } = await api(`/api/audit-log?${params.toString()}`);
    rowsEl.insertAdjacentHTML('beforeend', entries.map(_rowHtml).join(''));
    currentOffset += entries.length;
    emptyEl.classList.toggle('hidden', currentOffset > 0);
    loadMoreBtn.classList.toggle('hidden', entries.length < PAGE_SIZE);
    loadMoreHint.textContent = '';
  } catch (err) {
    loadMoreHint.textContent = err.message;
  }
}

document.getElementById('log-project-select').addEventListener('change', (e) => {
  currentProjectId = e.target.value;
  loadEntries({ reset: true });
});

document.getElementById('log-refresh-btn').addEventListener('click', () => loadEntries({ reset: true }));
document.getElementById('log-load-more-btn').addEventListener('click', () => loadEntries({ reset: false }));
