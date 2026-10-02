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
let currentProjectId = null; // the open project (sidebar switcher, nav.js)
const SCALAR_FILTER_FIELDS = ['status', 'stampCategory', 'issueType', 'stamp', 'assignee', 'assigneeCompany', 'priority', 'isClash'];
const ARRAY_FILTER_FIELDS = ['tags', 'level', 'zone', 'room']; // fields where board items hold an array, not a single value
const ALL_FILTER_FIELDS = [...SCALAR_FILTER_FIELDS, ...ARRAY_FILTER_FIELDS];
// Each filter now holds an array of selected values (empty array = "All"),
// so multiple values can be chosen per filter at once.
let activeFilters = Object.fromEntries(ALL_FILTER_FIELDS.map((f) => [f, []]));

// What's typed in the search box (the Select all bar): matches the Revizto
// issue number or the title; combined with the filters above.
let searchText = '';

const PAGE_SIZE = 50;
let currentPage = 1;
// { key: 'revizto' | 'acc' | 'linked', dir: 'asc' | 'desc' } — remembered per
// browser, a viewer convenience only (see _loadSort).
let currentSort = _loadSort();
// Revizto IDs ticked for "Link & push selected". Kept outside the DOM so
// ticks survive paging — each page only renders its own 50 checkboxes.
const selectedIds = new Set();
// Every unlinked issue matching the active filters, across all pages —
// what Select all / Deselect all acts on. Refreshed by renderBoard.
let linkableIds = new Set();

function _loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem('issues:sort'));
    if (saved && ['revizto', 'acc', 'linked'].includes(saved.key) && ['asc', 'desc'].includes(saved.dir)) return saved;
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

// Numeric value to sort by, or null when there isn't one: an issue number,
// or the linked date as a timestamp. An unlinked issue has no ACC number
// or linked date; displayId can also fall back to a UUID server-side if
// ACC ever omits it.
function _sortValue(issue, key) {
  if (key === 'linked') return issue.linked && issue.linkedAt ? Date.parse(issue.linkedAt) : null;
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
  // The open project — switched with the sidebar's Project menu (nav.js).
  currentProjects = e.detail.projects;
  currentProjectId = e.detail.currentProject?.id || null;
  document.getElementById('issues-project-name').textContent = e.detail.currentProject?.name || 'No projects set up yet — see Setup';
  await loadBoard();
});

document.getElementById('refresh-board-btn').addEventListener('click', loadBoard);

async function loadBoard() {
  const projectId = currentProjectId;
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

// Does the issue match the search? "#42" / "42" find issue numbers containing
// it (so 42 also shows 142); any text finds titles containing it, ignoring case.
function _matchesSearch(issue, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (String(issue.title || '').toLowerCase().includes(q)) return true;
  const digits = q.replace(/^#/, '');
  return /^\d+$/.test(digits) && String(issue.id).includes(digits);
}

document.getElementById('issue-search').addEventListener('input', (e) => {
  searchText = e.target.value.trim();
  _resetPageAndSelection();
  renderBoard();
});

document.getElementById('reset-filters-btn').addEventListener('click', () => {
  for (const field of ALL_FILTER_FIELDS) activeFilters[field] = [];
  searchText = '';
  document.getElementById('issue-search').value = '';
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

  const filtered = currentBoard.filter(
    (i) =>
      _matchesSearch(i, searchText) &&
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
  linkableIds = new Set(filtered.filter((i) => !i.linked).map((i) => String(i.id)));
  for (const id of [...selectedIds]) if (!linkableIds.has(id)) selectedIds.delete(id);

  const selectAllGroup = document.getElementById('select-all-group');
  // The bar holds the search box too: it stays whenever the project has issues
  // (so a search with no hits can be cleared); Select all only when there's
  // something to select.
  selectAllBar.classList.toggle('hidden', !currentBoard.length);

  if (!filtered.length) {
    rowsEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    actionsEl.classList.add('hidden');
    selectAllGroup.classList.add('hidden');
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
  selectAllGroup.classList.toggle('hidden', !hasUnlinked);

  const projectId = currentProjectId;
  // Unlink button: only when the project allows it, and only for admins
  // of it (project admin or above — the server refuses anyone else).
  const openProject = currentProjects.find((p) => String(p.id) === String(projectId));
  const allowManualUnlink = !!openProject?.allow_manual_unlink && !!openProject.my_role && openProject.my_role !== 'standard';

  rowsEl.innerHTML = pageIssues
    .map((i) => {
      const rowClass = i.linked ? 'board-row row-synced' : 'board-row';
      const leftMeta = `#${i.id} — ${i.title} <em>(${i.status ?? '?'})</em>`;
      const rightMeta = i.linked
        ? i.acc?.error
          ? `<span class="hint">${i.acc.error}</span>`
          : `#${i.acc.displayId ?? i.acc.id} — ${i.acc.title} <em>(${prettyStatus(i.acc.status)})</em>`
        : `<label class="link-checkbox"><input type="checkbox" value="${i.id}"${selectedIds.has(String(i.id)) ? ' checked' : ''} /> Select to link</label>`;
      // Unlink clears this app's tracked link and closes the ACC issue
      // (the API can't delete it) — see the Setup page's Issue linking
      // toggle, which an admin has to turn on before this button appears.
      const unlinkBtn = i.linked && allowManualUnlink ? `<button type="button" class="btn secondary unlink-btn" data-id="${i.id}" data-acc="${i.acc?.displayId ?? ''}" title="Unlink — stops syncing and closes the ACC issue">Unlink</button>` : '';
      // Always render the date and actions cells (empty when not
      // applicable) so every row keeps the header's column positions.
      const linkedDate = i.linkedAt
        ? `<span class="linked-date" title="${new Date(i.linkedAt).toLocaleString()}">${new Date(i.linkedAt).toLocaleDateString()}</span>`
        : '<span class="linked-date"></span>';
      return `<div class="${rowClass}">
        <span>${leftMeta}</span>
        <span class="bridge-connector" aria-hidden="true">${i.linked ? '⇄' : ''}</span>
        <span>${rightMeta}</span>
        ${linkedDate}
        <span>${unlinkBtn}</span>
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

// Tally and Select all / Deselect all both cover every page, not just
// the one showing — the label flips to "Deselect all" once every
// linkable issue (unlinked + matching the filters) is ticked.
function updateSelectedCount() {
  const allSelected = linkableIds.size > 0 && selectedIds.size === linkableIds.size;
  document.getElementById('selected-count').textContent = `${selectedIds.size} of ${linkableIds.size} selected`;
  const selectAllBtn = document.getElementById('select-all-btn');
  selectAllBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
  selectAllBtn.disabled = !linkableIds.size;
}

document.getElementById('board-rows').addEventListener('change', (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  if (e.target.checked) selectedIds.add(e.target.value);
  else selectedIds.delete(e.target.value);
  updateSelectedCount();
});

document.getElementById('select-all-btn').addEventListener('click', () => {
  const shouldCheck = selectedIds.size < linkableIds.size;
  selectedIds.clear();
  if (shouldCheck) for (const id of linkableIds) selectedIds.add(id);
  // Sync this page's visible checkboxes; other pages pick it up from
  // selectedIds when they render.
  for (const cb of document.querySelectorAll('#board-rows input[type="checkbox"]')) cb.checked = shouldCheck;
  updateSelectedCount();
});

document.getElementById('board-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('.unlink-btn');
  if (!btn) return;
  const reviztoId = btn.dataset.id;
  const accLabel = btn.dataset.acc ? `ACC issue #${btn.dataset.acc}` : 'its ACC issue';
  const ok = await window.showConfirmDialog(
    `Unlink Revizto issue #${reviztoId} from ${accLabel}?`,
    "They stop syncing, and the ACC issue is closed. Autodesk doesn't let apps delete issues — you can delete it in ACC afterwards. The Revizto issue isn't changed.",
    { confirmLabel: 'Unlink' }
  );
  if (!ok) return;
  const projectId = currentProjectId;
  btn.disabled = true;
  btn.textContent = 'Unlinking...';
  try {
    const result = await api(`/api/projects/${projectId}/issues/${reviztoId}/unlink`, { method: 'POST' });
    await loadBoard();
    if (result.accIssueId) _showUnlinkedDialog(result);
  } catch (err) {
    window.showAlertDialog("Couldn't unlink", err.data?.error || err.message);
    btn.disabled = false;
    btn.textContent = 'Unlink';
  }
});

/**
 * After an unlink: whether the ACC issue got closed, and a link to it in
 * ACC — the only place it can be deleted. Built with textContent.
 */
function _showUnlinkedDialog({ accDisplayId, accUrl, closed, closeProblem }) {
  const label = accDisplayId ? `ACC issue #${accDisplayId}` : 'The ACC issue';
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'modal modal-neutral';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  const title = document.createElement('h2');
  title.textContent = 'Unlinked';
  const body = document.createElement('p');
  body.textContent = closed
    ? `${label} was closed. To delete it entirely, open it in ACC — Autodesk doesn't let apps delete issues.`
    : `${label} couldn't be closed (${closeProblem}), so it's still open in ACC. Open it there to close or delete it.`;
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const open = document.createElement('a');
  open.className = 'btn';
  open.href = accUrl;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open in ACC';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn secondary';
  done.textContent = 'Done';
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  done.addEventListener('click', close);
  open.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  actions.append(open, done);
  dialog.append(title, body, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  done.focus();
}

document.getElementById('link-selected-btn').addEventListener('click', async () => {
  const projectId = currentProjectId;
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
