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

let currentBoard = [];
const SCALAR_FILTER_FIELDS = ['status', 'stampCategory', 'issueType', 'stamp', 'assignee'];
const ARRAY_FILTER_FIELDS = ['tags']; // fields where board items hold an array, not a single value
const ALL_FILTER_FIELDS = [...SCALAR_FILTER_FIELDS, ...ARRAY_FILTER_FIELDS];
let activeFilters = Object.fromEntries(ALL_FILTER_FIELDS.map((f) => [f, '']));

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user) {
    document.getElementById('signed-out-notice').classList.remove('hidden');
    return;
  }
  document.getElementById('board-app').classList.remove('hidden');
  await loadProjectOptions();
});

async function loadProjectOptions() {
  const select = document.getElementById('project-select');
  const { projects } = await api('/api/projects');
  if (!projects.length) {
    select.innerHTML = '<option value="">No projects set up yet — see Setup</option>';
    return;
  }
  select.innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  const lastProjectId = localStorage.getItem('issues:lastProjectId');
  if (lastProjectId && projects.some((p) => String(p.id) === lastProjectId)) {
    select.value = lastProjectId;
  }
  await loadBoard();
}

document.getElementById('project-select').addEventListener('change', () => {
  const projectId = document.getElementById('project-select').value;
  if (projectId) localStorage.setItem('issues:lastProjectId', projectId);
  else localStorage.removeItem('issues:lastProjectId');
  loadBoard();
});
document.getElementById('refresh-board-btn').addEventListener('click', loadBoard);

async function loadBoard() {
  const projectId = document.getElementById('project-select').value;
  const rowsEl = document.getElementById('board-rows');
  if (!projectId) return;
  rowsEl.innerHTML = 'Loading issues...';
  loadStats(projectId); // fire independently — board shouldn't wait on this
  try {
    const { board } = await api(`/api/projects/${projectId}/issues-board`);
    currentBoard = board;
    populateFilterOptions();
    renderBoard();
  } catch (err) {
    rowsEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
}

async function loadStats(projectId) {
  const revEl = document.getElementById('stat-revizto-count');
  const accEl = document.getElementById('stat-acc-count');
  const syncedEl = document.getElementById('stat-synced-count');
  const errEl = document.getElementById('stat-error-count');
  const errPill = document.getElementById('stat-error-pill');
  [revEl, accEl, syncedEl, errEl].forEach((el) => (el.textContent = '…'));
  try {
    const stats = await api(`/api/projects/${projectId}/stats`);
    revEl.textContent = stats.reviztoCount;
    accEl.textContent = stats.accCount;
    syncedEl.textContent = stats.syncedCount;
    errEl.textContent = stats.errorCount;
    errPill.classList.toggle('stat-pill-error-active', stats.errorCount > 0);
    // Native title tooltip — simplest way to let admins hover for detail
    // without a new UI component; supports multiple lines via \n.
    errPill.title = (stats.errors || []).map((e) => `#${e.reviztoIssueId}: ${e.message}`).join('\n');
  } catch {
    [revEl, accEl, syncedEl, errEl].forEach((el) => (el.textContent = '—'));
    errPill.title = '';
  }
}

// Same canonical order as the Setup page's mapping dropdown — keeps the
// two consistent. Casing note: only "In progress" is confirmed from real
// data; the others are reasonable guesses.
const CANONICAL_STATUS_ORDER = ['Open', 'In progress', 'Solved', 'Closed'];

function sortStatusValues(values) {
  const canonical = CANONICAL_STATUS_ORDER.filter((s) => values.includes(s));
  const extra = values.filter((s) => !CANONICAL_STATUS_ORDER.includes(s)).sort();
  return [...canonical, ...extra];
}

function populateFilterOptions() {
  for (const field of ALL_FILTER_FIELDS) {
    const select = document.getElementById(`filter-${field}`);
    const current = select.value;
    let values = ARRAY_FILTER_FIELDS.includes(field)
      ? [...new Set(currentBoard.flatMap((i) => i[field] || []))].sort()
      : [...new Set(currentBoard.map((i) => i[field]).filter(Boolean))].sort();
    if (field === 'status') values = sortStatusValues(values);
    select.innerHTML = '<option value="">All</option>' + values.map((v) => `<option value="${v}">${v}</option>`).join('');
    select.value = values.includes(current) ? current : '';
  }
}

ALL_FILTER_FIELDS.forEach((field) => {
  document.getElementById(`filter-${field}`).addEventListener('change', (e) => {
    activeFilters[field] = e.target.value;
    renderBoard();
  });
});

function prettyStatus(s) {
  if (!s) return s;
  const withSpaces = String(s).replace(/_/g, ' ');
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function renderBoard() {
  const rowsEl = document.getElementById('board-rows');
  const emptyEl = document.getElementById('board-empty');
  const actionsEl = document.getElementById('board-actions');

  const filtered = currentBoard.filter((i) =>
    Object.entries(activeFilters).every(([field, val]) => {
      if (!val) return true;
      if (ARRAY_FILTER_FIELDS.includes(field)) return (i[field] || []).includes(val);
      return i[field] === val;
    })
  );

  if (!filtered.length) {
    rowsEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    actionsEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const hasUnlinked = filtered.some((i) => !i.linked);
  actionsEl.classList.toggle('hidden', !hasUnlinked);

  rowsEl.innerHTML = filtered
    .map((i) => {
      const rowClass = i.linked ? 'board-row row-synced' : 'board-row';
      const leftMeta = `#${i.id} — ${i.title} <em>(${i.status ?? '?'})</em>`;
      const rightMeta = i.linked
        ? i.acc?.error
          ? `<span class="hint">${i.acc.error}</span>`
          : `#${i.acc.id} — ${i.acc.title} <em>(${prettyStatus(i.acc.status)})</em>`
        : `<label class="link-checkbox"><input type="checkbox" value="${i.id}" /> Select to link</label>`;
      return `<div class="${rowClass}">
        <span>${leftMeta}</span>
        <span class="bridge-connector" aria-hidden="true">${i.linked ? '⇄' : ''}</span>
        <span>${rightMeta}</span>
      </div>`;
    })
    .join('');
}

document.getElementById('link-selected-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('project-select').value;
  const issueIds = [...document.querySelectorAll('#board-rows input[type="checkbox"]:checked')].map((cb) => cb.value);
  const resultEl = document.getElementById('link-result');
  if (!issueIds.length) {
    resultEl.textContent = 'Select at least one issue first.';
    return;
  }
  resultEl.textContent = 'Linking & pushing...';
  try {
    const { results } = await api(`/api/projects/${projectId}/sync`, {
      method: 'POST',
      body: JSON.stringify({ issueIds }),
    });
    const errors = results.filter((r) => r.action === 'error');
    resultEl.innerHTML = errors.length
      ? `${results.length} processed, ${errors.length} errors:<br>` + errors.map((e) => `#${e.reviztoId}: ${e.error}`).join('<br>')
      : `${results.length} linked and pushed. Auto-resyncs every 2 minutes from here.`;
    await loadBoard();
  } catch (err) {
    resultEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
});
