// Operator console (platform operators only — nav.js redirects anyone else, and
// every /api/operator route checks users.is_operator server-side too).
// Everything is built with textContent: names and emails are user data.

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

const resultEl = () => document.getElementById('operator-result');

function say(message, isError = false) {
  const el = resultEl();
  el.textContent = message;
  el.className = `result-text${isError ? ' error' : ''}`;
}

/** Runs an action, then reloads the list; shows the server's message if it's refused. */
async function run(action, doneMessage) {
  try {
    await action();
    if (doneMessage) say(doneMessage);
    await loadCompanies();
  } catch (err) {
    say(err.message, true);
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function field(labelText, input) {
  const wrap = el('div', 'operator-field');
  const label = el('label', null, labelText);
  wrap.append(label, input);
  return { wrap, input };
}

function input(type, value = '', attrs = {}) {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  Object.assign(i, attrs);
  return i;
}

const PHASE_BADGES = { active: 'success', not_started: 'neutral', suspended: 'warning', expired: 'danger', gone: 'danger' };
const PHASE_LABELS = { active: 'Active', not_started: 'Not started', suspended: 'Suspended', expired: 'Expired (greyed)', gone: 'Expired (hidden)' };

function licenseCard(company, l) {
  const box = el('div', 'operator-license');
  const head = el('div', 'card-header-row');
  const title = el('h3', null, l.name);
  const badge = el('span', `badge badge-${PHASE_BADGES[l.phase] || 'neutral'}`, PHASE_LABELS[l.phase] || l.phase);
  if (l.purgeable) badge.title = 'Past the 90-day retention window — may be purged';
  title.append(' ', badge);
  head.append(title);
  box.append(head);

  const facts = el('p', 'hint', `${l.slotsUsed} of ${l.slotCapacity} project slots used · ${l.startsOn} to ${l.expiresOn} · ${l.memberCount} member${l.memberCount === 1 ? '' : 's'}${l.note ? ` · ${l.note}` : ''}`);
  box.append(facts);
  if (l.slotsUsed > l.slotCapacity) box.append(el('p', 'hint', 'Over its slot limit — suspended until projects are archived or slots are raised.'));

  // Terms: slots, start, expiry (renew), name, note.
  const form = el('form', 'operator-terms');
  form.noValidate = true;
  const name = field('License name', input('text', l.name, { maxLength: 120 }));
  const slots = field('Project slots', input('number', String(l.slotCapacity), { min: 0, max: 10000 }));
  const starts = field('Starts', input('date', l.startsOn));
  const expires = field('Expires (renew by moving this)', input('date', l.expiresOn));
  const note = field('Note (invoice / contract ref)', input('text', l.note, { maxLength: 500 }));
  const save = el('button', 'btn', 'Save terms');
  save.type = 'submit';
  form.append(name.wrap, slots.wrap, starts.wrap, expires.wrap, note.wrap, save);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(
      () =>
        api(`/api/operator/licenses/${l.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: name.input.value, slotCapacity: slots.input.value, startsOn: starts.input.value, expiresOn: expires.input.value, note: note.input.value }),
        }),
      `Saved "${name.input.value}".`
    );
  });
  box.append(form);

  // Suspend / reactivate.
  const actions = el('div', 'field-row');
  const susp = el('button', l.suspended ? 'btn' : 'btn btn-danger', l.suspended ? 'Reactivate' : 'Suspend');
  susp.type = 'button';
  susp.addEventListener('click', async () => {
    if (!l.suspended && !(await showConfirmDialog('Suspend this license?', `All syncing for "${l.name}" stops and everyone on it is told it's suspended. Nothing is deleted.`, { confirmLabel: 'Suspend', danger: true }))) return;
    run(() => api(`/api/operator/licenses/${l.id}/${l.suspended ? 'unsuspend' : 'suspend'}`, { method: 'POST' }), l.suspended ? 'Reactivated.' : 'Suspended.');
  });
  actions.append(susp);
  box.append(actions);

  // License admins (the buyer first) + invite.
  box.append(el('h4', null, 'License admins'));
  if (!l.admins.length) box.append(el('p', 'hint', 'None yet — invite the buyer below.'));
  for (const a of l.admins) {
    const owner = a.email === company.accountOwnerEmail ? ' — account owner' : '';
    box.append(el('div', 'hint', `${a.email}${owner}${a.verified ? '' : ' (pending Revizto check)'}`));
  }
  const inv = el('form', 'field-row');
  inv.noValidate = true;
  const email = input('email', '', { placeholder: 'buyer@company.com' });
  const send = input('checkbox');
  send.checked = true;
  const sendLabel = el('label', 'hint');
  sendLabel.append(send, ' email the invitation');
  const invBtn = el('button', 'btn', 'Invite as license admin');
  invBtn.type = 'submit';
  inv.append(email, sendLabel, invBtn);
  inv.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api(`/api/operator/licenses/${l.id}/admins`, { method: 'POST', body: JSON.stringify({ email: email.value, sendEmail: send.checked }) });
      say(`${email.value} is now a license admin${r.accountOwner ? ' and the account owner' : ''}.${r.emailError ? ` The email failed: ${r.emailError}` : ''}`);
    });
  });
  box.append(inv);
  return box;
}

function newLicenseForm(company) {
  const form = el('form', 'operator-terms hidden');
  form.noValidate = true;
  // Today in the COMPANY's timezone (the app judges a license's start in it) — not the browser's UTC date, which is already tomorrow on a Pacific evening.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: company.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const name = field('License name (unique in this company)', input('text', '', { maxLength: 120 }));
  const slots = field('Project slots', input('number', '5', { min: 0, max: 10000 }));
  const starts = field('Starts', input('date', today));
  const expires = field('Expires', input('date', ''));
  const note = field('Note (invoice / contract ref)', input('text', '', { maxLength: 500 }));
  const go = el('button', 'btn', 'Create license');
  go.type = 'submit';
  form.append(name.wrap, slots.wrap, starts.wrap, expires.wrap, note.wrap, go);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(
      () => api(`/api/operator/companies/${company.id}/licenses`, { method: 'POST', body: JSON.stringify({ name: name.input.value, slotCapacity: slots.input.value, startsOn: starts.input.value, expiresOn: expires.input.value, note: note.input.value }) }),
      `Created "${name.input.value}". Now invite its first license admin.`
    );
  });
  return form;
}

function companyCard(c) {
  const card = el('section', 'card');
  const head = el('div', 'card-header-row');
  head.append(el('h2', null, c.name));
  const add = el('button', 'btn secondary', '+ Add license');
  add.type = 'button';
  head.append(add);
  card.append(head);
  card.append(el('p', 'hint', `Timezone ${c.timezone} · account owner: ${c.accountOwnerEmail || 'not set yet'}`));
  const form = newLicenseForm(c);
  add.addEventListener('click', () => form.classList.toggle('hidden'));
  card.append(form);
  if (!c.licenses.length) card.append(el('p', 'hint', 'No licenses yet — add the first one.'));
  for (const l of c.licenses) card.append(licenseCard(c, l));
  return card;
}

async function loadCompanies() {
  const { companies } = await api('/api/operator/companies');
  document.getElementById('companies-empty').classList.toggle('hidden', companies.length > 0);
  document.getElementById('companies').replaceChildren(...companies.map(companyCard));
}

window.addEventListener('app:ready', async (e) => {
  if (!e.detail.user?.isOperator) return;
  document.getElementById('operator-app').classList.remove('hidden');
  const form = document.getElementById('new-company-form');
  document.getElementById('new-company-btn').addEventListener('click', () => form.classList.toggle('hidden'));
  document.getElementById('new-company-cancel').addEventListener('click', () => form.classList.add('hidden'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    run(async () => {
      await api('/api/operator/companies', { method: 'POST', body: JSON.stringify({ name: document.getElementById('new-company-name').value, timezone: document.getElementById('new-company-tz').value }) });
      document.getElementById('new-company-name').value = '';
      form.classList.add('hidden');
      say('Company created. Add its first license.');
    });
  });
  await loadCompanies().catch((err) => say(err.message, true));
});
