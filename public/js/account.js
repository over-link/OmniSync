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
  document.getElementById('whoami').textContent = `Signed in as ${user.email}`;
  document.getElementById('connections-section').classList.remove('hidden');

  document.getElementById('acc-status').textContent = acc.connected ? `Connected (expires ${new Date(acc.expiresAt).toLocaleString()})` : 'Not connected';
  document.getElementById('acc-status').className = 'badge ' + (acc.connected ? 'badge-success' : 'badge-neutral');
  document.getElementById('acc-connect-btn').textContent = acc.connected ? 'Reconnect ACC' : 'Connect ACC';

  document.getElementById('revizto-status').textContent = revizto.connected
    ? `Connected (reconnect by ${new Date(revizto.refreshExpiresAt).toLocaleDateString()})`
    : 'Not connected';
  document.getElementById('revizto-status').className = 'badge ' + (revizto.connected ? 'badge-success' : 'badge-neutral');
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

document.getElementById('identify-btn').addEventListener('click', async () => {
  const email = document.getElementById('email-input').value.trim();
  const whoamiEl = document.getElementById('whoami');
  if (!email) return;
  try {
    await api('/auth/identify', { method: 'POST', body: JSON.stringify({ email, invite: inviteCode }) });
    await refreshMe();
    location.reload(); // refresh sidebar too, now that we're signed in
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
