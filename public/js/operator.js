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

let emailConfigured = false; // can the server send invitation emails? (from the listing)

/**
 * "Type the name to confirm" pop-up for deletions: resolves true only if the exact name is typed and
 * Delete is clicked. (The server checks the name too.) Built with textContent — names are user data.
 */
function confirmTyped(titleText, message, expected, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const backdrop = el('div', 'modal-backdrop');
    const dialog = el('form', 'modal');
    dialog.noValidate = true;
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `Type ${expected} to confirm`);
    const label = el('label', null, `Type "${expected}" to confirm`);
    const del = el('button', 'btn btn-danger', confirmLabel);
    del.type = 'submit';
    del.disabled = true;
    const cancel = el('button', 'btn secondary', 'Cancel');
    cancel.type = 'button';
    const actions = el('div', 'modal-actions');
    actions.append(del, cancel);
    dialog.append(el('h2', null, titleText), el('p', null, message), label, input, el('p', 'result-text'), actions);
    backdrop.append(dialog);
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);
    input.addEventListener('input', () => {
      del.disabled = input.value.trim() !== expected;
    });
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim() === expected) close(true);
    });
    cancel.addEventListener('click', () => close(false));
    document.body.append(backdrop);
    input.focus();
  });
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

  const facts = el('p', 'hint', `${l.slotsUsed} of ${l.slotCapacity} project slots used · ${l.startsOn} to ${l.expiresOn} (${window.operatorFilter.expiryPhrase(l, company)}) · ${l.memberCount} member${l.memberCount === 1 ? '' : 's'}${l.note ? ` · ${l.note}` : ''}`);
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
  // Delete: only a license with no projects at all (archived ones count) — removing projects is the customer's own admins' call.
  const delLicense = el('button', 'btn btn-danger', 'Delete license');
  delLicense.type = 'button';
  if (l.projectCount > 0) {
    delLicense.disabled = true;
    delLicense.title = `It has ${l.projectCount} project${l.projectCount === 1 ? '' : 's'} (archived ones count). Its license admins must delete them on License Administration first.`;
    actions.append(delLicense, el('span', 'hint', `Can't be deleted while it has ${l.projectCount} project${l.projectCount === 1 ? '' : 's'}.`));
  } else {
    delLicense.addEventListener('click', async () => {
      if (!(await confirmTyped('Delete this license?', `"${l.name}" and its memberships are removed for good. The people keep their accounts. This can't be undone.`, l.name))) return;
      run(() => api(`/api/operator/licenses/${l.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: l.name }) }), `Deleted the license "${l.name}".`);
    });
    actions.append(delLicense);
  }
  box.append(actions);

  // License admins (the buyer first) + invite.
  box.append(el('h4', null, 'License admins'));
  if (!l.admins.length) box.append(el('p', 'hint', 'None yet — invite the buyer below.'));
  for (const a of l.admins) {
    const row = el('div', 'op-admin-row');
    row.append(el('span', 'op-admin-email', a.email));
    if (a.isOwner) row.append(el('span', 'badge badge-neutral', 'Account owner'));
    if (!a.verified) {
      const pending = el('span', 'badge badge-warning', 'Pending Revizto check');
      pending.title = 'They have not yet connected Revizto, or it has not confirmed them as a License administrator.';
      row.append(pending);
    }
    const resend = el('button', 'btn secondary op-small', 'Resend invite');
    resend.type = 'button';
    if (!emailConfigured) {
      resend.disabled = true;
      resend.title = "Email isn't set up on the server (SMTP). They can still sign in with their email address.";
    }
    resend.addEventListener('click', () => run(() => api(`/api/operator/licenses/${l.id}/admins/${a.userId}/resend`, { method: 'POST' }), `Invitation re-sent to ${a.email}.`));
    const remove = el('button', 'btn secondary op-small', 'Remove admin');
    remove.type = 'button';
    if (a.isOwner) {
      remove.disabled = true;
      remove.title = "The account owner can't be removed. Change the account owner first (Edit company).";
    }
    remove.addEventListener('click', async () => {
      if (!(await showConfirmDialog('Remove license admin?', `${a.email} will no longer be a license admin of "${l.name}". They stay on it as a plain member, and keep their account.`, { confirmLabel: 'Remove', danger: true }))) return;
      run(() => api(`/api/operator/licenses/${l.id}/admins/${a.userId}`, { method: 'DELETE' }), `${a.email} is no longer a license admin of "${l.name}".`);
    });
    row.append(resend, remove);
    box.append(row);
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

/**
 * Rename, timezone, account owner (chosen from the company's own license admins), and delete (only
 * with no licenses left). Hidden until "Edit company" is clicked.
 */
function editCompanyForm(c) {
  const full = allCompanies.find((x) => x.id === c.id) || c; // every license, not just the ones the filters show
  const form = el('form', 'operator-terms hidden');
  form.noValidate = true;
  const name = field('Company name', input('text', c.name, { maxLength: 120 }));
  const tz = field('Timezone (polling hours and each license\'s days follow it)', input('text', c.timezone));
  const admins = [...new Set(full.licenses.flatMap((l) => l.admins.map((a) => a.email)))].sort();
  const owner = document.createElement('select');
  owner.setAttribute('aria-label', 'Account owner');
  if (!admins.length) owner.add(new Option('No license admins yet', ''));
  for (const email of admins) owner.add(new Option(email, email));
  owner.value = c.accountOwnerEmail && admins.includes(c.accountOwnerEmail) ? c.accountOwnerEmail : admins[0] || '';
  owner.disabled = !admins.length;
  const ownerField = field('Account owner (must be a license admin of one of its licenses)', owner);
  const save = el('button', 'btn', 'Save company');
  save.type = 'submit';
  form.append(name.wrap, tz.wrap, ownerField.wrap, save);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { name: name.input.value, timezone: tz.input.value };
    if (owner.value && owner.value !== c.accountOwnerEmail) body.accountOwnerEmail = owner.value;
    run(() => api(`/api/operator/companies/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) }), `Saved "${name.input.value}".`);
  });
  // Delete: only once it has no licenses.
  const del = el('button', 'btn btn-danger', 'Delete company');
  del.type = 'button';
  const count = c.licenseCount ?? full.licenses.length;
  if (count > 0) {
    del.disabled = true;
    del.title = `It still has ${count} license${count === 1 ? '' : 's'} — delete them first.`;
  } else {
    del.addEventListener('click', async () => {
      if (!(await confirmTyped('Delete this company?', `"${c.name}" is removed for good. This can't be undone.`, c.name))) return;
      run(() => api(`/api/operator/companies/${c.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: c.name }) }), `Deleted the company "${c.name}".`);
    });
  }
  const dangerRow = el('div', 'field-row');
  dangerRow.append(del);
  if (count > 0) dangerRow.append(el('span', 'hint', `Can't be deleted while it has ${count} license${count === 1 ? '' : 's'}.`));
  form.append(dangerRow);
  return form;
}

function companyCard(c) {
  const card = el('section', 'card');
  const head = el('div', 'card-header-row');
  head.append(el('h2', null, c.name));
  const add = el('button', 'btn secondary', '+ Add license');
  add.type = 'button';
  const edit = el('button', 'btn secondary', 'Edit company');
  edit.type = 'button';
  const headButtons = el('div', 'field-row');
  headButtons.append(edit, add);
  head.append(headButtons);
  card.append(head);
  card.append(el('p', 'hint', `Timezone ${c.timezone} · account owner: ${c.accountOwnerEmail || 'not set yet'}`));
  const editForm = editCompanyForm(c);
  edit.addEventListener('click', () => editForm.classList.toggle('hidden'));
  card.append(editForm);
  const form = newLicenseForm(c);
  add.addEventListener('click', () => form.classList.toggle('hidden'));
  card.append(form);
  if (!c.licenses.length) card.append(el('p', 'hint', 'No licenses yet — add the first one.'));
  for (const l of c.licenses) card.append(licenseCard(c, l));
  return card;
}

// ─── Finding things (search / status / date range) ───────────────────

const FILTER_KEY = 'operatorFilters';
const STATUS_CHIPS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['expiring', `Expiring soon (${window.operatorFilter.EXPIRING_DAYS} days)`],
  ['suspended', 'Suspended'],
  ['expired', 'Expired'],
  ['not_started', 'Not started'],
];
let allCompanies = [];
let filters = { companies: [], query: '', status: 'all', dateField: 'expires', from: '', to: '' };
try {
  Object.assign(filters, JSON.parse(sessionStorage.getItem(FILTER_KEY) || '{}')); // kept across reloads of this tab
} catch {
  // storage blocked or corrupt — start with no filters
}

const filtersActive = () => !!(filters.companies.length || filters.query || filters.status !== 'all' || filters.from || filters.to);

function renderCompanies() {
  const result = window.operatorFilter.filterCompanies(allCompanies, filters);
  document.getElementById('companies-empty').classList.toggle('hidden', allCompanies.length > 0);
  document.getElementById('no-matches').classList.toggle('hidden', !allCompanies.length || result.companies.length > 0);
  document.getElementById('companies').replaceChildren(...result.companies.map(companyCard));
  // Status chips with how many licenses each would show (given the search and dates).
  const chips = document.getElementById('op-status');
  chips.replaceChildren(
    ...STATUS_CHIPS.map(([key, label]) => {
      const chip = el('button', 'op-chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(filters.status === key));
      chip.append(label, el('span', 'op-count', String(result.counts[key])));
      chip.addEventListener('click', () => {
        filters.status = key;
        saveFilters();
        renderCompanies();
      });
      return chip;
    })
  );
  const companyCount = result.companies.length; // includes a company with no licenses yet that the search found
  document.getElementById('op-summary').textContent = filtersActive()
    ? `Showing ${result.shown} of ${result.total} license${result.total === 1 ? '' : 's'} in ${companyCount} compan${companyCount === 1 ? 'y' : 'ies'}.`
    : `${result.total} license${result.total === 1 ? '' : 's'} in ${allCompanies.length} compan${allCompanies.length === 1 ? 'y' : 'ies'}.`;
}

/** The company drop-down (multi-select). Drawn once per load; it keeps its own open/closed state while ticking. */
function renderCompanyPicker() {
  const names = allCompanies.map((c) => c.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  // A company that no longer exists can't stay selected.
  filters.companies = (Array.isArray(filters.companies) ? filters.companies : []).filter((n) => names.includes(n));
  const container = document.getElementById('op-company');
  renderMultiSelect(container, names, filters.companies, (picked) => {
    filters.companies = picked;
    saveFilters();
    renderCompanies();
  });
  const toggle = container.querySelector('.ms-toggle');
  toggle.id = 'op-company-toggle';
  toggle.setAttribute('aria-label', 'Company');
}

function saveFilters() {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch {
    // storage blocked — filters just won't survive a reload
  }
}

function wireFilters() {
  const search = document.getElementById('op-search');
  const dateField = document.getElementById('op-date-field');
  const from = document.getElementById('op-from');
  const to = document.getElementById('op-to');
  search.value = filters.query;
  dateField.value = filters.dateField;
  from.value = filters.from;
  to.value = filters.to;
  const apply = () => {
    filters.query = search.value.trim();
    filters.dateField = dateField.value;
    filters.from = from.value;
    filters.to = to.value;
    saveFilters();
    renderCompanies();
  };
  for (const input of [search, dateField, from, to]) input.addEventListener('input', apply);
  document.getElementById('op-clear').addEventListener('click', () => {
    filters = { companies: [], query: '', status: 'all', dateField: 'expires', from: '', to: '' };
    renderCompanyPicker();
    search.value = '';
    dateField.value = 'expires';
    from.value = '';
    to.value = '';
    saveFilters();
    renderCompanies();
  });
}

async function loadCompanies() {
  ({ companies: allCompanies, emailConfigured } = await api('/api/operator/companies'));
  renderCompanyPicker();
  renderCompanies();
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
  wireFilters();
  await loadCompanies().catch((err) => say(err.message, true));
});
