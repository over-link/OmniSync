// License Administration (license admins only — nav.js redirects anyone
// else, and every route here checks server-side too).

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

function _cell(tr, text) {
  const td = tr.insertCell();
  td.textContent = text;
  return td;
}

function _when(value) {
  return value ? new Date(value).toLocaleString() : 'Never';
}

window.addEventListener('app:ready', async (e) => {
  const user = e.detail.user;
  if (!user || !user.isLicenseAdmin) return;
  document.getElementById('license-role-badge').textContent = user.roleLabel;
  document.getElementById('license-app').classList.remove('hidden');
  await Promise.all([loadProjects(), loadAdmins(), loadSyncEnabledSetting()]);
});

// ─── Projects ────────────────────────────────────────────────────────

let projectsLoadSeq = 0; // only the latest load draws the table

async function loadProjects() {
  const seq = ++projectsLoadSeq;
  const tbody = document.getElementById('license-projects');
  const { projects, summary } = await api('/api/license/projects');
  if (seq !== projectsLoadSeq) return; // a newer load (e.g. after an archive) is on its way
  _renderSummary(summary);
  tbody.innerHTML = '';
  document.getElementById('license-projects-empty').classList.toggle('hidden', projects.length > 0);
  for (const p of projects) {
    const tr = tbody.insertRow();
    if (p.archived_at) tr.className = 'archived';
    _cell(tr, p.name);
    const pairing = tr.insertCell();
    const badge = document.createElement('span');
    if (p.archived_at) {
      badge.className = 'badge badge-neutral';
      badge.textContent = 'Archived';
    } else {
      badge.className = `badge badge-${p.paired ? 'success' : 'warning'}`;
      badge.textContent = p.paired ? `Paired${p.acc_project_name ? ` · ${p.acc_project_name}` : ''}` : 'Not paired yet';
    }
    pairing.appendChild(badge);
    _cell(tr, p.owner_email || '—');
    _cell(tr, String(p.member_count));
    _cell(tr, p.synced_count.toLocaleString());
    const actions = tr.insertCell();
    // An archived project isn't on the other pages — unarchive it first.
    if (!p.archived_at) {
      const link = document.createElement('a');
      link.href = `/setup?project=${encodeURIComponent(p.id)}`;
      link.className = 'btn secondary';
      link.textContent = p.paired ? 'Open setup' : 'Pair project';
      actions.appendChild(link);
    }
    actions.appendChild(_projectMenu(p));
  }
}

// ─── Metric boxes at the top ─────────────────────────────────────────
// Same boxes as the Dashboards page. Capacity and expiry are placeholders
// for now (services/licenseTerms.js); slots used and synced issues are real.

let slotSummary = null; // latest summary, for the "+ New Project" check

const NO_PROJECT_SLOTS = 'No available project slots remain.';

function _showNoProjectSlots() {
  window.showAlertDialog('No project slots', NO_PROJECT_SLOTS);
}

function _renderSummary(s) {
  slotSummary = s;
  document.getElementById('tile-slots').textContent = s.projectSlotCapacity.toLocaleString();
  document.getElementById('tile-slots-used').textContent = s.projectSlotsUsed.toLocaleString();
  // "YYYY-MM-DD" as a local date (new Date('YYYY-MM-DD') would be UTC
  // midnight, which shows as the day before west of Greenwich).
  const [y, m, d] = s.licenseExpiresOn.split('-').map(Number);
  document.getElementById('tile-expires').textContent = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
  document.getElementById('tile-synced').textContent = s.syncedIssues.toLocaleString();
}

// ─── ⋯ menu: archive / unarchive / delete ────────────────────────────

let openMenu = null; // { list, button } of the menu that's open, if any

function _closeMenu() {
  if (!openMenu) return;
  openMenu.list.remove();
  openMenu.button.setAttribute('aria-expanded', 'false');
  openMenu = null;
}
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.button.contains(e.target) && !openMenu.list.contains(e.target)) _closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') _closeMenu();
});
// The menu is positioned against the window (so the table's scroll area
// can't clip it) — close it rather than let it drift when the page moves.
window.addEventListener('resize', _closeMenu);
window.addEventListener('scroll', _closeMenu, true);

function _projectMenu(p) {
  const wrap = document.createElement('div');
  wrap.className = 'row-menu';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-menu-btn';
  button.textContent = '⋯';
  button.title = 'More actions';
  button.setAttribute('aria-label', `More actions for ${p.name}`);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const wasOpen = openMenu?.button === button;
    _closeMenu();
    if (wasOpen) return;
    const list = document.createElement('div');
    list.className = 'row-menu-list';
    list.setAttribute('role', 'menu');
    const item = (label, onClick, danger = false) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `row-menu-item${danger ? ' danger' : ''}`;
      el.setAttribute('role', 'menuitem');
      el.textContent = label;
      el.addEventListener('click', () => {
        _closeMenu();
        onClick();
      });
      list.appendChild(el);
    };
    if (p.archived_at) item('Unarchive', () => _unarchiveProject(p));
    else item('Archive', () => _archiveProject(p));
    item('Delete', () => _deleteProject(p), true);
    const rect = button.getBoundingClientRect();
    list.style.top = `${rect.bottom + 4}px`;
    list.style.right = `${document.documentElement.clientWidth - rect.right}px`;
    document.body.appendChild(list);
    button.setAttribute('aria-expanded', 'true');
    openMenu = { list, button };
    list.querySelector('button').focus();
  });
  wrap.appendChild(button);
  return wrap;
}

async function _projectAction(url, method) {
  try {
    await api(url, { method });
    await loadProjects();
  } catch (err) {
    if (err.data?.code === 'no_project_slots') _showNoProjectSlots();
    else window.showAlertDialog('Something went wrong', err.message);
  }
}

async function _archiveProject(p) {
  const ok = await window.showConfirmDialog(
    `Archive "${p.name}"?`,
    'Syncing stops and the project is hidden from everyone except license admins. Nothing is deleted — you can unarchive it any time.',
    { confirmLabel: 'Archive' }
  );
  if (ok) await _projectAction(`/api/license/projects/${encodeURIComponent(p.id)}/archive`, 'POST');
}

async function _unarchiveProject(p) {
  const ok = await window.showConfirmDialog(
    `Unarchive "${p.name}"?`,
    'Syncing resumes and its members can see it again.',
    { confirmLabel: 'Unarchive' }
  );
  if (ok) await _projectAction(`/api/license/projects/${encodeURIComponent(p.id)}/unarchive`, 'POST');
}

async function _deleteProject(p) {
  const ok = await window.showConfirmDialog(
    `Delete "${p.name}"?`,
    'This permanently removes the project from this app: its pairing, issue links, field mappings, members and invite links. Issues in Revizto and ACC are not affected. This can’t be undone — archive it instead if you might need it again.',
    { confirmLabel: 'Delete project', danger: true }
  );
  if (ok) await _projectAction(`/api/license/projects/${encodeURIComponent(p.id)}`, 'DELETE');
}

const newProjectForm = document.getElementById('new-project-form');
document.getElementById('new-project-btn').addEventListener('click', () => {
  // Every slot taken — say so now rather than after they've typed a name.
  // (The server enforces it too.)
  if (slotSummary && slotSummary.projectSlotsUsed >= slotSummary.projectSlotCapacity) {
    _showNoProjectSlots();
    return;
  }
  newProjectForm.classList.remove('hidden');
  document.getElementById('new-project-name').focus();
});
document.getElementById('new-project-cancel').addEventListener('click', () => {
  newProjectForm.classList.add('hidden');
  document.getElementById('new-project-result').textContent = '';
});
newProjectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-project-name').value.trim();
  const resultEl = document.getElementById('new-project-result');
  if (!name) {
    resultEl.textContent = 'Give the project a name.';
    return;
  }
  resultEl.textContent = 'Creating…';
  try {
    const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
    // Straight to pairing it on Project Setup.
    window.location.href = `/setup?project=${encodeURIComponent(project.id)}`;
  } catch (err) {
    if (err.data?.code === 'no_project_slots') {
      resultEl.textContent = '';
      newProjectForm.classList.add('hidden');
      _showNoProjectSlots();
      await loadProjects(); // someone else may have just taken the last slot
      return;
    }
    resultEl.textContent = err.message;
  }
});

// ─── License admins ──────────────────────────────────────────────────

async function loadAdmins() {
  const tbody = document.getElementById('license-admins');
  const { admins, canManage, emailConfigured } = await api('/api/license/admins');
  inviteEmailConfigured = emailConfigured;
  document.getElementById('add-admin-row').classList.toggle('hidden', !canManage);
  tbody.innerHTML = '';
  for (const a of admins) {
    const tr = tbody.insertRow();
    _cell(tr, a.email);
    _cell(tr, a.roleLabel);
    _cell(tr, _when(a.last_login_at));
    const actions = tr.insertCell();
    if (a.canRemove) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn secondary';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        const ok = await window.showConfirmDialog(
          `Remove ${a.email} as a license admin?`,
          "They keep their account and any project roles they've been given, but lose access to every other project.",
          { confirmLabel: 'Remove', danger: true }
        );
        if (!ok) return;
        try {
          await api(`/api/license/admins/${a.id}`, { method: 'DELETE' });
          await loadAdmins();
        } catch (err) {
          window.showAlertDialog('Something went wrong', err.message);
        }
      });
      actions.appendChild(btn);
    }
  }
}

let inviteEmailConfigured = false; // from /api/license/admins

// Emails become bubbles as they're typed or pasted (js/chips.js, same as
// the Team page), so several can be added at once.
const adminChips = createEmailChipInput({
  box: document.getElementById('add-admin-chipbox'),
  list: document.getElementById('add-admin-chips'),
  input: document.getElementById('add-admin-email'),
});

// Each new license admin is emailed (when the app can send email), so they
// know to sign in.
document.getElementById('add-admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const emails = adminChips.take();
  const resultEl = document.getElementById('add-admin-result');
  if (!emails.length) {
    resultEl.textContent = 'Enter an email.';
    return;
  }
  resultEl.textContent = `Adding ${emails.length} license admin${emails.length === 1 ? '' : 's'}…`;
  const outcomes = [];
  for (const email of emails) {
    try {
      const { admin, emailSent, emailError } = await api('/api/license/admins', {
        method: 'POST',
        body: JSON.stringify({ email, sendEmail: inviteEmailConfigured }),
      });
      outcomes.push(
        !inviteEmailConfigured
          ? `${admin.email}: added — let them know to sign in.`
          : emailSent
            ? `${admin.email}: added — we emailed them.`
            : `${admin.email}: added, but the email didn't send (${emailError}). Let them know to sign in.`
      );
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
  adminChips.clear();
  await loadAdmins();
});

// ─── App-wide sync pause (moved here from Project Setup) ─────────────
// Checked = syncing enabled (normal operation), so checked still means
// "on/green" like every other toggle in the app.

function _renderSyncEnabledLabel(enabled) {
  document.getElementById('sync-enabled-label').textContent = enabled ? 'Automatic syncing — ON' : 'Automatic syncing — PAUSED';
}

async function loadSyncEnabledSetting() {
  const resultEl = document.getElementById('sync-enabled-result');
  try {
    const { paused } = await api('/api/settings/sync-paused');
    document.getElementById('sync-enabled-toggle').checked = !paused;
    _renderSyncEnabledLabel(!paused);
  } catch (err) {
    resultEl.textContent = err.message;
  }
}

document.getElementById('sync-enabled-toggle').addEventListener('change', async (e) => {
  const resultEl = document.getElementById('sync-enabled-result');
  const enabled = e.target.checked;
  try {
    await api('/api/settings/sync-paused', { method: 'POST', body: JSON.stringify({ paused: !enabled }) });
    _renderSyncEnabledLabel(enabled);
    resultEl.textContent = 'Saved ✓';
  } catch (err) {
    e.target.checked = !enabled; // revert — the save didn't take
    _renderSyncEnabledLabel(!enabled);
    resultEl.textContent = err.message;
  }
});
