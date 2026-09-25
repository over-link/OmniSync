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

function render({ user, acc, revizto }) {
  if (!user) {
    document.getElementById('connections-section').classList.add('hidden');
    return;
  }
  // Signed in: the sign-in forms are done with.
  document.getElementById('signin-form').classList.add('hidden');
  document.getElementById('forgot-form').classList.add('hidden');
  document.getElementById('whoami').textContent = `Signed in as ${user.email}`;
  document.getElementById('connections-section').classList.remove('hidden');

  // No expiry date shown by design — both ACC and Revizto now have a
  // daily server-side keepalive cron (pollService.keepAccConnectionsAlive/
  // keepReviztoConnectionsAlive) that refreshes every connection
  // automatically regardless of personal app usage, so there's no
  // meaningful action for the user to take by any particular date; showing
  // one anyway just invited confusion ("do I need to do something?").
  // refreshExpiresAt is still returned by /auth/me and still genuinely
  // matters server-side (it's the real deadline the cron has to beat) —
  // just not something worth surfacing here as user-facing copy.
  document.getElementById('acc-status').textContent = acc.connected ? 'Connected' : 'Not connected';
  document.getElementById('acc-status').className = 'badge ' + (acc.connected ? 'badge-success' : 'badge-neutral');
  document.getElementById('acc-connect-btn').textContent = acc.connected ? 'Reconnect ACC' : 'Connect ACC';

  document.getElementById('revizto-status').textContent = revizto.connected ? 'Connected' : 'Not connected';
  document.getElementById('revizto-status').className = 'badge ' + (revizto.connected ? 'badge-success' : 'badge-neutral');
  document.getElementById('revizto-connect-btn').textContent = revizto.connected ? 'Reconnect Revizto' : 'Connect Revizto';
}

async function refreshMe() {
  const data = await api('/auth/me');
  render(data);
}

window.addEventListener('app:ready', (e) => render(e.detail));

// Carries a ?invite=<code> from a shared invite link (see Team page's
// "Copy invite link") through to /auth/identify — only actually needed
// for a brand-new signup (an existing user signing back in ignores it
// server-side), but harmless to always include.
const inviteCode = new URLSearchParams(location.search).get('invite');

document.getElementById('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email-input').value.trim();
  const password = document.getElementById('password-input').value;
  const whoamiEl = document.getElementById('whoami');
  if (!email) {
    whoamiEl.textContent = 'Enter your email.';
    return;
  }
  const btn = document.getElementById('identify-btn');
  btn.disabled = true;
  try {
    const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, invite: inviteCode }) });
    // No password on this account yet — a set-password link was emailed.
    if (result.status === 'password_link_sent') {
      whoamiEl.textContent = result.message;
      return;
    }
    location.reload(); // refresh sidebar too, now that we're signed in
  } catch (err) {
    whoamiEl.textContent = err.message;
    document.getElementById('password-input').value = '';
  } finally {
    btn.disabled = false;
  }
});

function _showForgot(show) {
  document.getElementById('signin-form').classList.toggle('hidden', show);
  document.getElementById('forgot-form').classList.toggle('hidden', !show);
  document.getElementById('whoami').textContent = '';
  if (show) {
    document.getElementById('forgot-email-input').value = document.getElementById('email-input').value;
    document.getElementById('forgot-email-input').focus();
  }
}
document.getElementById('forgot-toggle').addEventListener('click', () => _showForgot(true));
document.getElementById('forgot-cancel').addEventListener('click', () => _showForgot(false));

document.getElementById('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgot-email-input').value.trim();
  const whoamiEl = document.getElementById('whoami');
  if (!email) {
    whoamiEl.textContent = 'Enter your email.';
    return;
  }
  try {
    const { message } = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    whoamiEl.textContent = message;
  } catch (err) {
    whoamiEl.textContent = err.message;
  }
});

document.getElementById('revizto-connect-btn').addEventListener('click', () => {
  window.open('https://ws.revizto.com/login?request=accessCode', '_blank');
  document.getElementById('revizto-code-panel').classList.remove('hidden');
});

document.getElementById('revizto-submit-btn').addEventListener('click', async () => {
  const accessCode = document.getElementById('revizto-code-input').value.trim();
  const region = document.getElementById('revizto-region-input').value.trim() || 'virginia';
  const resultEl = document.getElementById('revizto-exchange-result');
  if (!accessCode) return;
  try {
    await api('/auth/revizto/exchange', { method: 'POST', body: JSON.stringify({ accessCode, region }) });
    resultEl.textContent = 'Connected ✓';
    await refreshMe();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});
