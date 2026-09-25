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

async function loadProjects() {
  const tbody = document.getElementById('license-projects');
  const { projects } = await api('/api/license/projects');
  tbody.innerHTML = '';
  document.getElementById('license-projects-empty').classList.toggle('hidden', projects.length > 0);
  for (const p of projects) {
    const tr = tbody.insertRow();
    _cell(tr, p.name);
    const pairing = tr.insertCell();
    const badge = document.createElement('span');
    badge.className = `badge badge-${p.paired ? 'success' : 'warning'}`;
    badge.textContent = p.paired ? `Paired${p.acc_project_name ? ` · ${p.acc_project_name}` : ''}` : 'Not paired yet';
    pairing.appendChild(badge);
    _cell(tr, p.owner_email || '—');
    _cell(tr, String(p.member_count));
    const actions = tr.insertCell();
    const link = document.createElement('a');
    link.href = `/setup?project=${encodeURIComponent(p.id)}`;
    link.className = 'btn secondary';
    link.textContent = p.paired ? 'Open setup' : 'Pair project';
    actions.appendChild(link);
  }
}

const newProjectForm = document.getElementById('new-project-form');
document.getElementById('new-project-btn').addEventListener('click', () => {
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
    resultEl.textContent = err.message;
  }
});

// ─── License admins ──────────────────────────────────────────────────

async function loadAdmins() {
  const tbody = document.getElementById('license-admins');
  const { admins, canManage } = await api('/api/license/admins');
  document.getElementById('add-admin-form').classList.toggle('hidden', !canManage);
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
        if (!confirm(`Remove ${a.email} as a license admin? They keep any project roles they've been given, but lose access to other projects.`)) return;
        try {
          await api(`/api/license/admins/${a.id}`, { method: 'DELETE' });
          await loadAdmins();
        } catch (err) {
          alert(err.message);
        }
      });
      actions.appendChild(btn);
    }
  }
}

document.getElementById('add-admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('add-admin-email').value.trim();
  const sendEmail = document.getElementById('add-admin-send-email').checked;
  const resultEl = document.getElementById('add-admin-result');
  if (!email) {
    resultEl.textContent = 'Enter an email.';
    return;
  }
  try {
    const { emailSent, emailError } = await api('/api/license/admins', { method: 'POST', body: JSON.stringify({ email, sendEmail }) });
    resultEl.textContent = sendEmail
      ? emailSent
        ? `Added — we emailed ${email}.`
        : `Added, but the email didn't send (${emailError}). Let them know to sign in.`
      : 'Added.';
    document.getElementById('add-admin-email').value = '';
    await loadAdmins();
  } catch (err) {
    resultEl.textContent = err.message;
  }
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
