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
  await loadInviteLinks();
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

// ─── Chip-list email input ("Add someone") ─────────────────────────
// Paste a whole list — from a spreadsheet, Word doc, email "To:" field,
// however it's separated — and each parsed address becomes its own
// removable chip, so it's unambiguous exactly who's queued to be added
// before clicking Add, rather than a wall of raw pasted text.

// Splits on commas, semicolons, and any whitespace (newlines included) —
// covers the common paste sources: one per line, comma-separated, or
// semicolon-separated (e.g. copied straight out of an email "To:" field
// or a spreadsheet column).
function _parseEmails(raw) {
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

let pendingEmails = [];

function _renderChips() {
  document.getElementById('invite-email-chips').innerHTML = pendingEmails
    .map(
      (email, i) => `<span class="chip">${email}<button type="button" class="chip-remove" data-index="${i}" title="Remove" aria-label="Remove ${email}">&times;</button></span>`
    )
    .join('');
  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingEmails.splice(Number(btn.dataset.index), 1);
      _renderChips();
    });
  });
}

// Adds every email parsed out of `raw` as a chip, deduped against what's
// already queued (pasting the same list twice, or an email already
// added, shouldn't create a second chip for it).
function _addEmailsFromText(raw) {
  for (const email of _parseEmails(raw)) {
    if (!pendingEmails.includes(email)) pendingEmails.push(email);
  }
  _renderChips();
}

const chipInput = document.getElementById('invite-email-input');
const chipbox = document.getElementById('invite-email-chipbox');

// Paste is the main path — a whole list pasted in one go becomes chips
// immediately, with nothing left sitting in the input as raw text.
chipInput.addEventListener('paste', (e) => {
  e.preventDefault();
  _addEmailsFromText(e.clipboardData.getData('text'));
  chipInput.value = '';
});

// Typing one at a time still works — Enter, comma, or semicolon commits
// whatever's currently typed as a chip (comma/semicolon since someone
// might type "a@x.com, b@x.com" by hand rather than paste it).
chipInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
    e.preventDefault();
    if (chipInput.value.trim()) _addEmailsFromText(chipInput.value);
    chipInput.value = '';
  } else if (e.key === 'Backspace' && !chipInput.value && pendingEmails.length) {
    // Backspace on an empty input removes the last chip — standard
    // chip-input behavior, lets you quickly undo a paste/typo.
    pendingEmails.pop();
    _renderChips();
  }
});

// Anything left half-typed when focus leaves the field still gets
// captured as a chip on blur, so nothing typed is silently dropped just
// because Add was clicked without pressing Enter first.
chipInput.addEventListener('blur', () => {
  if (chipInput.value.trim()) _addEmailsFromText(chipInput.value);
  chipInput.value = '';
});

// Clicking anywhere in the chip box (not just directly on the input)
// focuses the input, matching how a real "To:" field behaves.
chipbox.addEventListener('click', (e) => {
  if (e.target === chipbox || e.target.id === 'invite-email-chips') chipInput.focus();
});

document.getElementById('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Anything still sitting in the input when Add is clicked counts too.
  if (chipInput.value.trim()) _addEmailsFromText(chipInput.value);
  chipInput.value = '';

  const emails = pendingEmails;
  const role = document.getElementById('invite-role').value;
  const resultEl = document.getElementById('invite-result');
  if (!emails.length) {
    resultEl.textContent = 'Add at least one email.';
    return;
  }

  // Always sends the notification email now (no separate opt-in checkbox
  // — "Add" is the one action) — sendInviteEmail already no-ops gracefully
  // with a clear "not sent" reason if SMTP isn't configured, same as before.
  resultEl.textContent = `Adding ${emails.length} ${emails.length === 1 ? 'person' : 'people'}...`;
  const outcomes = [];
  for (const email of emails) {
    try {
      const { member, emailSent, emailError } = await api('/api/team/invite', {
        method: 'POST',
        body: JSON.stringify({ email, role, sendEmail: true }),
      });
      outcomes.push(`${member.email}: added${emailSent ? ', email sent' : ` (email not sent: ${emailError})`}`);
    } catch (err) {
      outcomes.push(`${email}: FAILED — ${err.message}`);
    }
  }
  resultEl.innerHTML = outcomes.map((o) => `<div>${o}</div>`).join('');
  pendingEmails = [];
  _renderChips();
  await loadTeam();
});

// ─── Invite links ("Copy invite link", one per role) ──────────────────

function _inviteUrl(code) {
  return `${location.origin}/account?invite=${code}`;
}

async function _copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard API unavailable/blocked — caller falls back to showing the raw link
  }
}

async function loadInviteLinks() {
  const { links } = await api('/api/team/invite-links');
  const listEl = document.getElementById('invite-links-list');
  if (!links.length) {
    listEl.innerHTML = '<p class="hint">No active invite links yet — generate one above.</p>';
    return;
  }
  listEl.innerHTML = links
    .map(
      (l) => `<div class="invite-link-row" data-id="${l.id}">
        <span class="badge badge-${l.role === 'admin' ? 'warning' : 'neutral'}">${l.role}</span>
        <code class="invite-link-url">${_inviteUrl(l.code)}</code>
        <button type="button" class="btn secondary copy-link-btn" data-code="${l.code}">Copy</button>
        <button type="button" class="btn secondary revoke-link-btn">Revoke</button>
      </div>`
    )
    .join('');

  listEl.querySelectorAll('.copy-link-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const copied = await _copyToClipboard(_inviteUrl(btn.dataset.code));
      btn.textContent = copied ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
  });
  listEl.querySelectorAll('.revoke-link-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.invite-link-row').dataset.id;
      await api(`/api/team/invite-links/${id}/revoke`, { method: 'POST' });
      await loadInviteLinks();
    });
  });
}

document.getElementById('copy-invite-link-btn').addEventListener('click', async () => {
  const role = document.getElementById('invite-link-role').value;
  const resultEl = document.getElementById('invite-link-result');
  try {
    const { link } = await api('/api/team/invite-links', { method: 'POST', body: JSON.stringify({ role }) });
    const url = _inviteUrl(link.code);
    const copied = await _copyToClipboard(url);
    resultEl.textContent = copied ? `Copied to clipboard: ${url}` : `Link (copy failed, copy manually): ${url}`;
    await loadInviteLinks();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});
