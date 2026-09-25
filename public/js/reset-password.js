// Set/reset password from an emailed link (?token=...). Deliberately not
// using nav.js — the person is signed out, and this page has no sidebar.
const token = new URLSearchParams(location.search).get('token');
const resultEl = document.getElementById('pw-result');
const form = document.getElementById('pw-form');

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showSignInLink() {
  document.getElementById('pw-signin-link').classList.remove('hidden');
}

(async () => {
  try {
    if (!token) throw new Error('This link is missing its code. Use the link from your email, or request a new one from the sign-in page.');
    const res = await fetch(`/auth/password-link?token=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    const isReset = data.purpose === 'reset';
    document.getElementById('pw-title').textContent = isReset ? 'Reset your password' : 'Set your password';
    document.getElementById('pw-sub').textContent = `For ${data.email}`;
    form.classList.remove('hidden');
    document.getElementById('pw-input').focus();
  } catch (err) {
    document.getElementById('pw-sub').textContent = err.message;
    showSignInLink();
  }
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('pw-input').value;
  const confirm = document.getElementById('pw-confirm').value;
  if (password.length < 10) {
    resultEl.textContent = 'Password must be at least 10 characters.';
    return;
  }
  if (password !== confirm) {
    resultEl.textContent = "The two passwords don't match.";
    return;
  }
  const btn = document.getElementById('pw-submit');
  btn.disabled = true;
  try {
    await post('/auth/set-password', { token, password });
    form.classList.add('hidden');
    resultEl.textContent = 'Password saved. You can now sign in with it.';
    showSignInLink();
  } catch (err) {
    resultEl.textContent = err.message;
    btn.disabled = false;
  }
});
