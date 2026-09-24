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

const PAGE_SIZE = 50;
let currentPage = 1;
// { key: 'revizto' | 'acc', dir: 'asc' | 'desc' } — remembered per
// browser, a viewer convenience only (see _loadSort).
let currentSort = _loadSort();
// Revizto IDs ticked for "Link & push selected". Kept outside the DOM so
// ticks survive paging — each page only renders its own 50 checkboxes.
const selectedIds = new Set();

function _loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem('issues:sort'));
    if (saved && ['revizto', 'acc'].includes(saved.key) && ['asc', 'desc'].includes(saved.dir)) return saved;
  } catch {
    // unreadable/blocked storage — fall through to the default
  }
  return { key: 'revizto', dir: 'asc' };
}

function _saveSort() {
  try {
    localStorage.setItem('issues:sort', JSON.stringify(currentSort));
  } catch {
    // storage blocked — sort still works for this visit
  }
}

// Numeric issue number to sort by, or null when there isn't one (an
// unlinked issue has no ACC number; displayId can also fall back to a
// UUID server-side if ACC ever omits it).
function _sortValue(issue, key) {
  const raw = key === 'acc' ? (issue.linked && !issue.acc?.error ? issue.acc?.displayId : null) : issue.id;
  const n = Number(raw);
  return raw == null || Number.isNaN(n) ? null : n;
}

function _sortIssues(issues) {
  const { key, dir } = currentSort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => {
    const av = _sortValue(a, key);
    const bv = _sortValue(b, key);
    // Issues with no number (e.g. not linked yet, when sorting by ACC)
    // always go last, whichever direction — not first on descending.
    if (av == null && bv == null) return (a.id - b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  });
}

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
  _resetPageAndSelection();
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
      _resetPageAndSelection();
      renderBoard();
    });
  }
}

document.getElementById('reset-filters-btn').addEventListener('click', () => {
  for (const field of ALL_FILTER_FIELDS) activeFilters[field] = [];
  _resetPageAndSelection();
  populateFilterOptions();
  renderBoard();
});

// A different set of matching issues — start back on page 1 and drop
// selections, same as the old behavior where every filter change rebuilt
// the list with nothing ticked (so a hidden issue can't be linked by accident).
function _resetPageAndSelection() {
  currentPage = 1;
  selectedIds.clear();
}

document.querySelectorAll('.sort-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    currentSort = currentSort.key === key ? { key, dir: currentSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    _saveSort();
    currentPage = 1;
    renderBoard();
  })
);

document.getElementById('page-prev-btn').addEventListener('click', () => {
  currentPage -= 1;
  renderBoard();
  document.querySelector('.board-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('page-next-btn').addEventListener('click', () => {
  currentPage += 1;
  renderBoard();
  document.querySelector('.board-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  _renderSortIndicators();

  // Drop selections that are no longer linkable (just linked, or gone
  // after a refresh) so the tally and "Link & push" match what's real.
  const linkableIds = new Set(filtered.filter((i) => !i.linked).map((i) => String(i.id)));
  for (const id of [...selectedIds]) if (!linkableIds.has(id)) selectedIds.delete(id);

  if (!filtered.length) {
    rowsEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    actionsEl.classList.add('hidden');
    selectAllBar.classList.add('hidden');
    _renderPager(0, 0);
    return;
  }
  emptyEl.classList.add('hidden');

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  // Clamp — e.g. linking/unlinking or a refresh can shrink the list out
  // from under the page you were on.
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageIssues = _sortIssues(filtered).slice(pageStart, pageStart + PAGE_SIZE);
  _renderPager(filtered.length, totalPages);

  const hasUnlinked = filtered.some((i) => !i.linked);
  actionsEl.classList.toggle('hidden', !hasUnlinked);
  selectAllBar.classList.toggle('hidden', !hasUnlinked);

  const projectId = document.getElementById('project-select').value;
  const allowManualUnlink = !!currentProjects.find((p) => String(p.id) === String(projectId))?.allow_manual_unlink;

  rowsEl.innerHTML = pageIssues
    .map((i) => {
      const rowClass = i.linked ? 'board-row row-synced' : 'board-row';
      const leftMeta = `#${i.id} — ${i.title} <em>(${i.status ?? '?'})</em>`;
      const rightMeta = i.linked
        ? i.acc?.error
          ? `<span class="hint">${i.acc.error}</span>`
          : `#${i.acc.displayId ?? i.acc.id} — ${i.acc.title} <em>(${prettyStatus(i.acc.status)})</em>`
        : `<label class="link-checkbox"><input type="checkbox" value="${i.id}"${selectedIds.has(String(i.id)) ? ' checked' : ''} /> Select to link</label>`;
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
  updateSelectedCount();
}

function _renderSortIndicators() {
  document.querySelectorAll('.sort-btn').forEach((btn) => {
    const active = btn.dataset.sort === currentSort.key;
    btn.querySelector('.sort-arrow').textContent = active ? (currentSort.dir === 'asc' ? '▲' : '▼') : '';
    btn.setAttribute('aria-sort', active ? (currentSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function _renderPager(total, totalPages) {
  const pager = document.getElementById('board-pager');
  // Only worth showing once there's more than one page.
  pager.classList.toggle('hidden', totalPages <= 1);
  if (totalPages <= 1) return;
  const first = (currentPage - 1) * PAGE_SIZE + 1;
  const last = Math.min(currentPage * PAGE_SIZE, total);
  document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages} · ${first}–${last} of ${total}`;
  document.getElementById('page-prev-btn').disabled = currentPage <= 1;
  document.getElementById('page-next-btn').disabled = currentPage >= totalPages;
}

// Tally counts every selected issue across ALL pages (selectedIds), while
// Select all / Deselect all acts on just the checkboxes on this page —
// the label flips to "Deselect all" once every one of them is ticked.
function updateSelectedCount() {
  const checkboxes = [...document.querySelectorAll('#board-rows input[type="checkbox"]')];
  const pageAllChecked = checkboxes.length && checkboxes.every((cb) => cb.checked);
  document.getElementById('selected-count').textContent = `${selectedIds.size} selected`;
  const selectAllBtn = document.getElementById('select-all-btn');
  selectAllBtn.textContent = pageAllChecked ? 'Deselect all on page' : 'Select all on page';
  // Other pages can still have unlinked issues when this one has none.
  selectAllBtn.disabled = !checkboxes.length;
}

document.getElementById('board-rows').addEventListener('change', (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  if (e.target.checked) selectedIds.add(e.target.value);
  else selectedIds.delete(e.target.value);
  updateSelectedCount();
});

document.getElementById('select-all-btn').addEventListener('click', () => {
  const checkboxes = [...document.querySelectorAll('#board-rows input[type="checkbox"]')];
  const shouldCheck = !(checkboxes.length && checkboxes.every((cb) => cb.checked));
  for (const cb of checkboxes) {
    cb.checked = shouldCheck;
    if (shouldCheck) selectedIds.add(cb.value);
    else selectedIds.delete(cb.value);
  }
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
  const issueIds = [...selectedIds]; // across every page, not just this one
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
