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
  for (const id of ['signin-form', 'forgot-form', 'code-form']) document.getElementById(id).classList.add('hidden');
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
// "Copy invite link") through to /auth/login — only actually needed
// for a brand-new signup (an existing user signing back in ignores it
// server-side), but harmless to always include.
const inviteCode = new URLSearchParams(location.search).get('invite');

// ─── Sign-in card: three panels ─────────────────────────────────────
// signin-form (email + password), forgot-form (email → reset code), and
// code-form (code + new password), shared by first-time "create your
// password" and "forgot password".

const whoamiEl = document.getElementById('whoami');
let codeEmail = null; // the email the current code was sent to
let codePurpose = 'set'; // 'set' | 'reset' — which request "Resend code" repeats

function _showPanel(id) {
  for (const panel of ['signin-form', 'forgot-form', 'code-form']) {
    document.getElementById(panel).classList.toggle('hidden', panel !== id);
  }
}

function _showCodeForm(email, purpose, message) {
  codeEmail = email;
  codePurpose = purpose;
  document.getElementById('code-intro').textContent = message;
  for (const id of ['code-input', 'new-password-input', 'confirm-password-input']) document.getElementById(id).value = '';
  whoamiEl.textContent = '';
  _showPanel('code-form');
  document.getElementById('code-input').focus();
}

// Sign-in refused because they aren't a member of both the Revizto and
// ACC project: a blocking pop-up (nav.js showAccessDenied), not inline text.
function _showIfAccessDenied(err) {
  if (err.data?.code !== 'access_denied') return false;
  whoamiEl.textContent = '';
  window.showAccessDenied(err.message);
  return true;
}

document.getElementById('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email-input').value.trim();
  const password = document.getElementById('password-input').value;
  if (!email) {
    whoamiEl.textContent = 'Enter your email.';
    return;
  }
  const btn = document.getElementById('identify-btn');
  btn.disabled = true;
  try {
    const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, invite: inviteCode }) });
    // No password on this account yet — a code to create one was emailed.
    if (result.status === 'code_sent') {
      _showCodeForm(email, 'set', result.message);
      return;
    }
    location.reload(); // refresh sidebar too, now that we're signed in
  } catch (err) {
    document.getElementById('password-input').value = '';
    if (_showIfAccessDenied(err)) return;
    whoamiEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('forgot-toggle').addEventListener('click', () => {
  whoamiEl.textContent = '';
  document.getElementById('forgot-email-input').value = document.getElementById('email-input').value;
  _showPanel('forgot-form');
  document.getElementById('forgot-email-input').focus();
});

for (const id of ['forgot-cancel', 'code-cancel']) {
  document.getElementById(id).addEventListener('click', () => {
    whoamiEl.textContent = '';
    _showPanel('signin-form');
  });
}

async function _requestResetCode(email) {
  const result = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
  _showCodeForm(email, 'reset', result.message);
}

document.getElementById('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgot-email-input').value.trim();
  if (!email) {
    whoamiEl.textContent = 'Enter your email.';
    return;
  }
  try {
    await _requestResetCode(email);
  } catch (err) {
    whoamiEl.textContent = err.message;
  }
});

document.getElementById('code-resend').addEventListener('click', async () => {
  try {
    if (codePurpose === 'reset') {
      await _requestResetCode(codeEmail);
    } else {
      // Signing in with a blank password re-sends the create-password code.
      const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: codeEmail, password: '', invite: inviteCode }) });
      _showCodeForm(codeEmail, 'set', result.message);
    }
    whoamiEl.textContent = 'A new code is on its way (at most one per minute). Use the newest email.';
  } catch (err) {
    whoamiEl.textContent = err.message;
  }
});

document.getElementById('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('code-input').value.trim();
  const password = document.getElementById('new-password-input').value;
  const confirm = document.getElementById('confirm-password-input').value;
  if (!/^\d{6}$/.test(code)) {
    whoamiEl.textContent = 'Enter the 6-digit code from the email.';
    return;
  }
  if (password.length < 10) {
    whoamiEl.textContent = 'Password must be at least 10 characters.';
    return;
  }
  if (password !== confirm) {
    whoamiEl.textContent = "The two passwords don't match.";
    return;
  }
  const btn = document.getElementById('code-submit');
  btn.disabled = true;
  try {
    await api('/auth/verify-code', { method: 'POST', body: JSON.stringify({ email: codeEmail, code, password, invite: inviteCode }) });
    location.reload(); // signed in
  } catch (err) {
    // Password was saved, but they can't get in yet — back to sign-in.
    if (_showIfAccessDenied(err)) {
      _showPanel('signin-form');
      return;
    }
    whoamiEl.textContent = err.message;
  } finally {
    btn.disabled = false;
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
