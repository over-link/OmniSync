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
let assignableRoles = []; // [{ value, label }]

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user) return;
  const { projects } = await api('/api/projects');
  const select = document.getElementById('team-project-select');
  if (!projects.length) {
    document.getElementById('team-no-projects').classList.remove('hidden');
    select.closest('.card').classList.add('hidden');
    return;
  }
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  let saved = null;
  try {
    saved = localStorage.getItem('team:lastProjectId');
  } catch {
    // storage blocked — just start on the first project
  }
  if (saved && projects.some((p) => String(p.id) === saved)) select.value = saved;
  await selectProject(select.value);
});

document.getElementById('team-project-select').addEventListener('change', (e) => {
  try {
    localStorage.setItem('team:lastProjectId', e.target.value);
  } catch {
    // storage blocked — selection still works for this visit
  }
  selectProject(e.target.value);
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

function _fillRoleSelect(select, roles) {
  select.innerHTML = '';
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.value;
    opt.textContent = r.label;
    select.appendChild(opt);
  }
}

async function loadTeam() {
  const data = await api(`/api/projects/${projectId}/team`);
  assignableRoles = data.assignableRoles;

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
    document.getElementById('email-config-notice').textContent = data.emailConfigured
      ? "They'll get an email; on first sign-in they create a password with an emailed code."
      : "Email isn't configured, so no invite email goes out — let them know to sign in.";
    await loadInviteLinks();
  }

  const tbody = document.getElementById('team-rows');
  tbody.innerHTML = '';
  for (const m of data.members) {
    const tr = tbody.insertRow();
    _cell(tr, m.email);
    const roleCell = tr.insertCell();
    if (m.canManage && assignableRoles.length) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Role for ${m.email}`);
      _fillRoleSelect(select, assignableRoles);
      select.value = m.role;
      select.addEventListener('change', async () => {
        try {
          await api(`/api/projects/${projectId}/team/${m.id}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
        } catch (err) {
          alert(err.message);
          select.value = m.role;
        }
      });
      roleCell.appendChild(select);
    } else {
      const badge = document.createElement('span');
      badge.className = `badge badge-${m.role === 'standard' ? 'neutral' : 'warning'}`;
      badge.textContent = m.roleLabel;
      roleCell.appendChild(badge);
    }
    _cell(tr, _when(m.last_login_at));
    _cell(tr, _when(m.latest_activity_at));
    const actions = tr.insertCell();
    if (m.canManage) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn secondary';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.email} from this project? Their account and other projects aren't affected.`)) return;
        try {
          await api(`/api/projects/${projectId}/team/${m.id}`, { method: 'DELETE' });
          await loadTeam();
        } catch (err) {
          alert(err.message);
        }
      });
      actions.appendChild(btn);
    }
  }
}

// ─── Chip-list email input ("Add someone") ─────────────────────────
// Paste a whole list — from a spreadsheet, Word doc, email "To:" field,
// however it's separated — and each parsed address becomes its own
// removable chip, so it's unambiguous exactly who's queued to be added.

// Splits on commas, semicolons, and any whitespace (newlines included).
function _parseEmails(raw) {
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

let pendingEmails = [];

function _renderChips() {
  const list = document.getElementById('invite-email-chips');
  list.innerHTML = '';
  pendingEmails.forEach((email, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = email; // pasted text — never as HTML
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${email}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      pendingEmails.splice(i, 1);
      _renderChips();
    });
    chip.appendChild(remove);
    list.appendChild(chip);
  });
}

// Adds every email parsed out of `raw` as a chip, deduped against what's
// already queued.
function _addEmailsFromText(raw) {
  for (const email of _parseEmails(raw)) {
    if (!pendingEmails.includes(email)) pendingEmails.push(email);
  }
  _renderChips();
}

const chipInput = document.getElementById('invite-email-input');
const chipbox = document.getElementById('invite-email-chipbox');

chipInput.addEventListener('paste', (e) => {
  e.preventDefault();
  _addEmailsFromText(e.clipboardData.getData('text'));
  chipInput.value = '';
});

// Enter, comma, or semicolon commits what's typed; Backspace on an empty
// input removes the last chip.
chipInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
    e.preventDefault();
    if (chipInput.value.trim()) _addEmailsFromText(chipInput.value);
    chipInput.value = '';
  } else if (e.key === 'Backspace' && !chipInput.value && pendingEmails.length) {
    pendingEmails.pop();
    _renderChips();
  }
});

// Anything left half-typed still becomes a chip when focus leaves.
chipInput.addEventListener('blur', () => {
  if (chipInput.value.trim()) _addEmailsFromText(chipInput.value);
  chipInput.value = '';
});

chipbox.addEventListener('click', (e) => {
  if (e.target === chipbox || e.target.id === 'invite-email-chips') chipInput.focus();
});

document.getElementById('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (chipInput.value.trim()) _addEmailsFromText(chipInput.value);
  chipInput.value = '';

  const emails = pendingEmails;
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
  pendingEmails = [];
  _renderChips();
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
