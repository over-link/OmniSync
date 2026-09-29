// Team: members of one project at a time, with their role. Anyone on the
// project can see it; project admins and above get the invite/role/remove
// controls — adding, changing and removing people up to their own role,
// never themselves (enforced server-side in
// routes/team.js — the page just doesn't offer what would be refused).

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

let projectId = null;
let myUserId = null;
let assignableRoles = []; // [{ value, label }]

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user) return;
  myUserId = e.detail.user.id;
  // The open project — switched with the sidebar's Project menu (nav.js).
  const project = e.detail.currentProject;
  const nameEl = document.getElementById('team-project-name');
  if (!project) {
    document.getElementById('team-no-projects').classList.remove('hidden');
    nameEl.closest('.card').classList.add('hidden');
    return;
  }
  nameEl.textContent = project.name;
  await selectProject(String(project.id));
});

async function selectProject(id) {
  projectId = id;
  document.getElementById('invite-result').textContent = '';
  document.getElementById('invite-link-result').textContent = '';
  await loadTeam();
}

function _cell(tr, text) {
  const td = tr.insertCell();
  td.textContent = text;
  return td;
}

function _when(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

// Fills a role picker, starting on Standard (the usual role to give —
// user's call, 2026-09-28) when it's one of the choices.
function _fillRoleSelect(select, roles) {
  select.innerHTML = '';
  for (const r of roles) select.add(new Option(r.label, r.value));
  if (roles.some((r) => r.value === 'standard')) select.value = 'standard';
}

let members = []; // latest /team answer's members
const selectedIds = new Set(); // members ticked for Edit users
let emailConfigured = false;

function _label(m) {
  return m.name || m.email;
}

// Why someone can't be ticked (the server refuses the same).
function _notManageableReason(m, myId) {
  if (m.is_license_level) return 'License admins are managed on License Administration.';
  if (m.id === myId) return "You can't change your own role.";
  return 'Their role is above yours.';
}

async function loadTeam() {
  const data = await api(`/api/projects/${projectId}/team`);
  assignableRoles = data.assignableRoles;
  members = data.members;
  emailConfigured = data.emailConfigured;

  const myRole = document.getElementById('team-my-role');
  myRole.textContent = `You: ${data.myRoleLabel}`;
  myRole.classList.remove('hidden');

  const canInvite = data.canInvite;
  document.getElementById('add-someone-card').classList.toggle('hidden', !canInvite);
  document.getElementById('invite-link-card').classList.toggle('hidden', !canInvite);
  document.getElementById('members-card').classList.remove('hidden');
  if (canInvite) {
    _fillRoleSelect(document.getElementById('invite-role'), assignableRoles);
    _fillRoleSelect(document.getElementById('invite-link-role'), assignableRoles);
    _fillRoleSelect(document.getElementById('edit-users-role'), assignableRoles);
    document.getElementById('email-config-notice').textContent = emailConfigured
      ? "They'll get an email; on first sign-in they create a password with an emailed code."
      : "Email isn't configured, so no invite email goes out — let them know to sign in.";
    await loadInviteLinks();
  }

  // Admins: a checkbox per person they can manage, plus Select all and
  // Edit users. Ticks survive a reload of the list (e.g. after a change)
  // for people still on the project.
  isTeamAdmin = canInvite;
  const manageable = members.filter((m) => m.canManage);
  for (const id of [...selectedIds]) if (!manageable.some((m) => m.id === id)) selectedIds.delete(id);
  document.getElementById('members-toolbar').classList.toggle('hidden', !canInvite);
  document.getElementById('col-check-head').classList.toggle('hidden', !canInvite);
  _renderMembers();
}

// ─── Sorting (column headers) ───────────────────────────────────────
// null = the server's order (license admins first, then by name). The
// choice is remembered per browser — a viewer convenience only.
const SORT_KEYS = ['name', 'role', 'signin', 'activity'];
const DATE_KEYS = ['signin', 'activity'];
const ROLE_ORDER = ['primary_license_admin', 'license_admin', 'project_admin', 'standard'];
let memberSort = _loadMemberSort();

function _loadMemberSort() {
  try {
    const saved = JSON.parse(localStorage.getItem('team:sort'));
    if (saved && SORT_KEYS.includes(saved.key) && ['asc', 'desc'].includes(saved.dir)) return saved;
  } catch {
    // nothing saved, or storage blocked
  }
  return null;
}

function _sortValue(m, key) {
  if (key === 'name') return _label(m).toLowerCase();
  if (key === 'role') return ROLE_ORDER.indexOf(m.role);
  const when = key === 'signin' ? (m.pending ? null : m.last_login_at) : m.latest_activity_at;
  return when ? new Date(when).getTime() : null;
}

function _sortedMembers() {
  if (!memberSort) return members;
  const { key, dir } = memberSort;
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a, b) => _sortValue(a, 'name').localeCompare(_sortValue(b, 'name'));
  return [...members].sort((a, b) => {
    const av = _sortValue(a, key);
    const bv = _sortValue(b, key);
    // Never signed in / no activity: always last, whichever direction.
    if (av == null || bv == null) return av == null && bv == null ? byName(a, b) : av == null ? 1 : -1;
    const diff = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return diff * sign || byName(a, b);
  });
}

function _renderSortIndicators() {
  for (const btn of document.querySelectorAll('.team-table .sort-btn')) {
    const active = memberSort?.key === btn.dataset.sort;
    btn.querySelector('.sort-arrow').textContent = active ? (memberSort.dir === 'asc' ? '▲' : '▼') : '';
    btn.closest('th').setAttribute('aria-sort', active ? (memberSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
}

for (const btn of document.querySelectorAll('.team-table .sort-btn')) {
  btn.title = `Sort by ${btn.textContent.trim().toLowerCase()}`;
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    // Same column: flip. New column: A→Z / top role first, or newest first for dates.
    memberSort = memberSort?.key === key
      ? { key, dir: memberSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: DATE_KEYS.includes(key) ? 'desc' : 'asc' };
    try {
      localStorage.setItem('team:sort', JSON.stringify(memberSort));
    } catch {
      // storage blocked — sort still works for this visit
    }
    _renderMembers();
  });
}

let isTeamAdmin = false; // from the last loadTeam (canInvite)

function _renderMembers() {
  const canInvite = isTeamAdmin;
  _renderSortIndicators();
  const tbody = document.getElementById('team-rows');
  tbody.innerHTML = '';
  for (const m of _sortedMembers()) {
    const tr = tbody.insertRow();
    tr.dataset.id = m.id;
    if (canInvite) {
      const checkCell = tr.insertCell();
      checkCell.className = 'check-cell';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'member-check';
      box.setAttribute('aria-label', `Select ${_label(m)}`);
      if (m.canManage) {
        box.checked = selectedIds.has(m.id);
        box.addEventListener('change', () => {
          if (box.checked) selectedIds.add(m.id);
          else selectedIds.delete(m.id);
          _syncSelection();
        });
      } else {
        box.disabled = true;
        box.title = _notManageableReason(m, myUserId);
      }
      checkCell.appendChild(box);
    }
    // Name (email on hover), or the email when there's no name yet.
    const nameCell = _cell(tr, _label(m));
    nameCell.className = 'person-cell';
    if (m.name) nameCell.title = m.email;
    if (m.pending) {
      const note = document.createElement('span');
      note.className = 'pending-note';
      note.textContent = "Invited — hasn't signed in yet";
      nameCell.appendChild(note);
    }
    const roleCell = tr.insertCell();
    const badge = document.createElement('span');
    badge.className = `badge badge-${m.role === 'standard' ? 'neutral' : 'warning'}`;
    badge.textContent = m.roleLabel;
    roleCell.appendChild(badge);
    _cell(tr, m.pending ? 'Not yet' : _when(m.last_login_at));
    _cell(tr, _when(m.latest_activity_at));
  }
  _syncSelection();
}

// ─── Selection + Edit users panel ───────────────────────────────────

function _selectedMembers() {
  return members.filter((m) => selectedIds.has(m.id));
}

// Keeps the row highlights, Select all, the Edit users button and (if
// open) the panel in step with what's ticked.
function _syncSelection() {
  const manageable = members.filter((m) => m.canManage);
  for (const tr of document.querySelectorAll('#team-rows tr')) tr.classList.toggle('selected', selectedIds.has(Number(tr.dataset.id)));
  const all = document.getElementById('select-all-members');
  all.disabled = manageable.length === 0;
  all.checked = manageable.length > 0 && selectedIds.size === manageable.length;
  all.indeterminate = selectedIds.size > 0 && selectedIds.size < manageable.length;
  const editBtn = document.getElementById('edit-users-btn');
  editBtn.disabled = selectedIds.size === 0;
  editBtn.textContent = selectedIds.size ? `Edit users (${selectedIds.size})` : 'Edit users';
  _renderPanel();
}

document.getElementById('select-all-members').addEventListener('change', (e) => {
  selectedIds.clear();
  if (e.target.checked) for (const m of members) if (m.canManage) selectedIds.add(m.id);
  for (const box of document.querySelectorAll('.member-check:not(:disabled)')) box.checked = e.target.checked;
  _syncSelection();
});

const panel = document.getElementById('edit-users-panel');

function _renderPanel() {
  if (panel.classList.contains('hidden')) return;
  const selected = _selectedMembers();
  document.getElementById('edit-users-count').textContent = selected.length
    ? `${selected.length} ${selected.length === 1 ? 'person' : 'people'} selected — tick more in the list to add them.`
    : 'Tick people in the list to edit them.';
  const list = document.getElementById('edit-users-list');
  list.replaceChildren(
    ...selected.map((m) => {
      const li = document.createElement('li');
      li.textContent = `${_label(m)} · ${m.roleLabel}`;
      if (m.name) li.title = m.email;
      return li;
    })
  );
  for (const id of ['edit-users-apply-role', 'edit-users-resend', 'edit-users-remove']) document.getElementById(id).disabled = !selected.length;
  document.getElementById('edit-users-resend').disabled = !selected.length || !emailConfigured;
  document.getElementById('edit-users-resend-hint').textContent = emailConfigured
    ? 'Emails them the invitation to this project again.'
    : "Email isn't set up for this app, so invitations can't be sent — let them know to sign in.";
}

document.getElementById('edit-users-btn').addEventListener('click', () => {
  panel.classList.remove('hidden');
  document.getElementById('edit-users-result').textContent = '';
  _renderPanel();
  document.getElementById('edit-users-close').focus();
});

function _closePanel() {
  panel.classList.add('hidden');
  document.getElementById('edit-users-btn').focus();
}
document.getElementById('edit-users-close').addEventListener('click', _closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panel.classList.contains('hidden') && !document.querySelector('.modal-backdrop')) _closePanel();
});

// Runs one request per selected person, then shows a line for each.
async function _forEachSelected(button, doOne, doneText) {
  const resultEl = document.getElementById('edit-users-result');
  const selected = _selectedMembers();
  button.disabled = true;
  resultEl.textContent = 'Working…';
  const lines = [];
  for (const m of selected) {
    try {
      await doOne(m);
      lines.push(`${_label(m)}: ${doneText}`);
    } catch (err) {
      lines.push(`${_label(m)}: not done — ${err.message}`);
    }
  }
  resultEl.replaceChildren(...lines.map((line) => Object.assign(document.createElement('div'), { textContent: line })));
  button.disabled = false;
  await loadTeam();
}

document.getElementById('edit-users-apply-role').addEventListener('click', (e) => {
  const select = document.getElementById('edit-users-role');
  const role = select.value;
  const label = select.selectedOptions[0].text;
  _forEachSelected(
    e.currentTarget,
    (m) => api(`/api/projects/${projectId}/team/${m.id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    `now ${label}`
  );
});

document.getElementById('edit-users-resend').addEventListener('click', (e) => {
  _forEachSelected(e.currentTarget, (m) => api(`/api/projects/${projectId}/team/${m.id}/resend-invite`, { method: 'POST' }), 'invitation sent');
});

document.getElementById('edit-users-remove').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const selected = _selectedMembers();
  const who = selected.length === 1 ? _label(selected[0]) : `${selected.length} people`;
  const ok = await window.showConfirmDialog(`Remove ${who} from this project?`, "Their account and other projects aren't affected.", {
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  await _forEachSelected(button, (m) => api(`/api/projects/${projectId}/team/${m.id}`, { method: 'DELETE' }), 'removed from this project');
});

// ─── Chip-list email input ("Add someone") ─────────────────────────
// Paste a whole list and each address becomes its own removable bubble
// (public/js/chips.js, shared with License Administration).
const inviteChips = createEmailChipInput({
  box: document.getElementById('invite-email-chipbox'),
  list: document.getElementById('invite-email-chips'),
  input: document.getElementById('invite-email-input'),
});

document.getElementById('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const emails = inviteChips.take();
  const role = document.getElementById('invite-role').value;
  const resultEl = document.getElementById('invite-result');
  if (!emails.length) {
    resultEl.textContent = 'Add at least one email.';
    return;
  }
  resultEl.textContent = `Adding ${emails.length} ${emails.length === 1 ? 'person' : 'people'}...`;
  const outcomes = [];
  for (const email of emails) {
    try {
      const { member, emailSent, emailError } = await api(`/api/projects/${projectId}/team/invite`, {
        method: 'POST',
        body: JSON.stringify({ email, role, sendEmail: true }),
      });
      outcomes.push(`${member.email}: added${emailSent ? ', email sent' : ` (email not sent: ${emailError})`}`);
    } catch (err) {
      outcomes.push(`${email}: not added — ${err.message}`);
    }
  }
  resultEl.innerHTML = '';
  for (const line of outcomes) {
    const div = document.createElement('div');
    div.textContent = line;
    resultEl.appendChild(div);
  }
  inviteChips.clear();
  await loadTeam();
});

// ─── Invite links (per project, one per role) ────────────────────────

function _inviteUrl(code) {
  return `${location.origin}/account?invite=${code}`;
}

async function _copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard unavailable/blocked — caller shows the raw link
  }
}

async function loadInviteLinks() {
  const { links } = await api(`/api/projects/${projectId}/invite-links`);
  const listEl = document.getElementById('invite-links-list');
  listEl.innerHTML = '';
  if (!links.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No active invite links for this project yet — generate one above.';
    listEl.appendChild(p);
    return;
  }
  for (const l of links) {
    const row = document.createElement('div');
    row.className = 'invite-link-row';
    const badge = document.createElement('span');
    badge.className = `badge badge-${l.role === 'standard' ? 'neutral' : 'warning'}`;
    badge.textContent = l.roleLabel;
    const url = document.createElement('code');
    url.className = 'invite-link-url';
    url.textContent = _inviteUrl(l.code);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      const copied = await _copyToClipboard(_inviteUrl(l.code));
      copy.textContent = copied ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn secondary';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      await api(`/api/projects/${projectId}/invite-links/${l.id}/revoke`, { method: 'POST' });
      await loadInviteLinks();
    });
    row.append(badge, url, copy, revoke);
    listEl.appendChild(row);
  }
}

document.getElementById('copy-invite-link-btn').addEventListener('click', async () => {
  const role = document.getElementById('invite-link-role').value;
  const resultEl = document.getElementById('invite-link-result');
  try {
    const { link } = await api(`/api/projects/${projectId}/invite-links`, { method: 'POST', body: JSON.stringify({ role }) });
    const url = _inviteUrl(link.code);
    const copied = await _copyToClipboard(url);
    resultEl.textContent = copied ? `Copied to clipboard: ${url}` : `Link (copy failed, copy manually): ${url}`;
    await loadInviteLinks();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});
