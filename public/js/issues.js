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
let currentProjects = [];
const SCALAR_FILTER_FIELDS = ['status', 'stampCategory', 'issueType', 'stamp', 'assignee', 'assigneeCompany', 'priority', 'isClash'];
const ARRAY_FILTER_FIELDS = ['tags', 'level', 'zone', 'room']; // fields where board items hold an array, not a single value
const ALL_FILTER_FIELDS = [...SCALAR_FILTER_FIELDS, ...ARRAY_FILTER_FIELDS];
// Each filter now holds an array of selected values (empty array = "All"),
// so multiple values can be chosen per filter at once.
let activeFilters = Object.fromEntries(ALL_FILTER_FIELDS.map((f) => [f, []]));

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
  currentProjects = projects;
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

// Matches the board's own toSentenceCase output (syncService.js), which
// title-cases every word — NOT the same casing as the raw status name
// used by the actual Revizto/ACC push logic elsewhere (that stays
// "In progress", lowercase "p", confirmed from real data — this constant
// is purely for sorting this page's already-display-cased filter values).
const CANONICAL_STATUS_ORDER = ['Open', 'In Progress', 'Solved', 'Closed'];

function sortStatusValues(values) {
  const canonical = CANONICAL_STATUS_ORDER.filter((s) => values.includes(s));
  const extra = values.filter((s) => !CANONICAL_STATUS_ORDER.includes(s)).sort();
  return [...canonical, ...extra];
}

function populateFilterOptions() {
  for (const field of ALL_FILTER_FIELDS) {
    const container = document.getElementById(`filter-${field}`);
    let values = ARRAY_FILTER_FIELDS.includes(field)
      ? [...new Set(currentBoard.flatMap((i) => i[field] || []))].sort()
      : [...new Set(currentBoard.map((i) => i[field]).filter(Boolean))].sort();
    if (field === 'status') values = sortStatusValues(values);
    // Drop selections for values no longer present in the board.
    activeFilters[field] = activeFilters[field].filter((v) => values.includes(v));
    renderMultiSelect(container, values, activeFilters[field], (updated) => {
      activeFilters[field] = updated;
      renderBoard();
    });
  }
}

document.getElementById('reset-filters-btn').addEventListener('click', () => {
  for (const field of ALL_FILTER_FIELDS) activeFilters[field] = [];
  populateFilterOptions();
  renderBoard();
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
    Object.entries(activeFilters).every(([field, selected]) => {
      if (!selected.length) return true;
      if (ARRAY_FILTER_FIELDS.includes(field)) return (i[field] || []).some((v) => selected.includes(v));
      return selected.includes(i[field]);
    })
  );

  document.getElementById('filter-issue-count').textContent = `${filtered.length} issue${filtered.length === 1 ? '' : 's'}`;

  const selectAllBar = document.getElementById('board-select-all-bar');

  if (!filtered.length) {
    rowsEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    actionsEl.classList.add('hidden');
    selectAllBar.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const hasUnlinked = filtered.some((i) => !i.linked);
  actionsEl.classList.toggle('hidden', !hasUnlinked);
  selectAllBar.classList.toggle('hidden', !hasUnlinked);

  const projectId = document.getElementById('project-select').value;
  const allowManualUnlink = !!currentProjects.find((p) => String(p.id) === String(projectId))?.allow_manual_unlink;

  rowsEl.innerHTML = filtered
    .map((i) => {
      const rowClass = i.linked ? 'board-row row-synced' : 'board-row';
      const leftMeta = `#${i.id} — ${i.title} <em>(${i.status ?? '?'})</em>`;
      const rightMeta = i.linked
        ? i.acc?.error
          ? `<span class="hint">${i.acc.error}</span>`
          : `#${i.acc.displayId ?? i.acc.id} — ${i.acc.title} <em>(${prettyStatus(i.acc.status)})</em>`
        : `<label class="link-checkbox"><input type="checkbox" value="${i.id}" /> Select to link</label>`;
      // Unlink only clears this app's own tracked link (never deletes
      // the issue in either system) — see the Setup page's Issue linking
      // toggle, which an admin has to turn on before this button appears.
      const unlinkBtn = i.linked && allowManualUnlink ? `<button type="button" class="btn secondary unlink-btn" data-id="${i.id}" title="Unlink — removes the tracked link only, doesn't delete either issue">Unlink</button>` : '';
      return `<div class="${rowClass}">
        <span>${leftMeta}</span>
        <span class="bridge-connector" aria-hidden="true">${i.linked ? '⇄' : ''}</span>
        <span>${rightMeta}</span>
        ${unlinkBtn}
      </div>`;
    })
    .join('');
  // Checkboxes above were just rebuilt from scratch (all unchecked) —
  // reset the tally/button label to match instead of showing a stale count.
  updateSelectedCount();
}

// Tallies how many of the currently-rendered "select to link" checkboxes
// are checked, and flips the button's label between Select all/Deselect
// all depending on whether every one of them already is. Only checkboxes
// for unlinked issues exist in #board-rows at all (see rightMeta above),
// and only ones matching the active filters, since renderBoard rebuilds
// the row list from `filtered` on every call — so this is naturally
// scoped to "select all in the current filtered/unfiltered list" already.
function updateSelectedCount() {
  const checkboxes = [...document.querySelectorAll('#board-rows input[type="checkbox"]')];
  const checkedCount = checkboxes.filter((cb) => cb.checked).length;
  document.getElementById('selected-count').textContent = `${checkedCount} selected`;
  document.getElementById('select-all-btn').textContent = checkboxes.length && checkedCount === checkboxes.length ? 'Deselect all' : 'Select all';
}

document.getElementById('board-rows').addEventListener('change', (e) => {
  if (e.target.matches('input[type="checkbox"]')) updateSelectedCount();
});

document.getElementById('select-all-btn').addEventListener('click', () => {
  const checkboxes = [...document.querySelectorAll('#board-rows input[type="checkbox"]')];
  const shouldCheck = !(checkboxes.length && checkboxes.every((cb) => cb.checked));
  checkboxes.forEach((cb) => (cb.checked = shouldCheck));
  updateSelectedCount();
});

document.getElementById('board-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('.unlink-btn');
  if (!btn) return;
  const reviztoId = btn.dataset.id;
  if (!confirm(`Unlink Revizto issue #${reviztoId} from its ACC issue? This only removes the tracked link — neither issue is deleted.`)) return;
  const projectId = document.getElementById('project-select').value;
  btn.disabled = true;
  btn.textContent = 'Unlinking...';
  try {
    await api(`/api/projects/${projectId}/issues/${reviztoId}/unlink`, { method: 'POST' });
    await loadBoard();
  } catch (err) {
    alert(err.data?.error || err.message);
    btn.disabled = false;
    btn.textContent = 'Unlink';
  }
});

document.getElementById('link-selected-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('project-select').value;
  const issueIds = [...document.querySelectorAll('#board-rows input[type="checkbox"]:checked')].map((cb) => cb.value);
  const resultEl = document.getElementById('link-result');
  if (!issueIds.length) {
    resultEl.textContent = 'Select at least one issue first.';
    return;
  }
  const confirmMsg = `${issueIds.length} issue${issueIds.length === 1 ? ' is' : 's are'} currently selected. Please confirm sync to ACC.`;
  if (!confirm(confirmMsg)) return;
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
