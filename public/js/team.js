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

let currentUserId = null;

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user || e.detail.user.role !== 'admin') return;
  currentUserId = e.detail.user.id;
  await loadTeam();
});

async function loadTeam() {
  const { members, emailConfigured } = await api('/api/team');
  document.getElementById('email-config-notice').textContent = emailConfigured
    ? 'Email sending is configured (SMTP).'
    : 'Email sending isn\u2019t configured yet (no SMTP_HOST/SMTP_USER/SMTP_PASS set) — "Add" still grants access immediately, it just won\u2019t send an email.';

  const rows = document.getElementById('team-rows');
  rows.innerHTML = members
    .map(
      (m) => `<tr data-id="${m.id}">
        <td>${m.email}</td>
        <td>
          <select class="role-select" ${m.id === currentUserId ? 'disabled title="Have another admin change your role"' : ''}>
            <option value="standard" ${m.role === 'standard' ? 'selected' : ''}>Standard</option>
            <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td>${new Date(m.created_at).toLocaleDateString()}</td>
        <td>${m.last_login_at ? new Date(m.last_login_at).toLocaleString() : '<span class="hint">Never</span>'}</td>
        <td>${m.latest_activity_at ? new Date(m.latest_activity_at).toLocaleString() : '<span class="hint">None yet</span>'}</td>
        <td class="role-result"></td>
      </tr>`
    )
    .join('');

  rows.querySelectorAll('.role-select').forEach((select) => {
    select.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const id = tr.dataset.id;
      const resultEl = tr.querySelector('.role-result');
      try {
        await api(`/api/team/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) });
        resultEl.textContent = 'Saved ✓';
      } catch (err) {
        resultEl.textContent = err.message;
        await loadTeam(); // revert the select to actual state
      }
    });
  });
}

document.getElementById('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('invite-email').value.trim();
  const role = document.getElementById('invite-role').value;
  const sendEmail = document.getElementById('invite-send-email').checked;
  const resultEl = document.getElementById('invite-result');
  resultEl.textContent = 'Adding...';
  try {
    const { member, emailSent, emailError } = await api('/api/team/invite', {
      method: 'POST',
      body: JSON.stringify({ email, role, sendEmail }),
    });
    let msg = `${member.email} added as ${member.role}.`;
    if (sendEmail) msg += emailSent ? ' Invite email sent.' : ` Email not sent: ${emailError}`;
    resultEl.textContent = msg;
    e.target.reset();
    await loadTeam();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});
