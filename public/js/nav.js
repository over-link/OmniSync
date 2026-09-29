/**
 * public/js/nav.js
 * Loaded first on every page. Fetches auth state once, renders the left
 * sidebar (tabs shown by role, signed-in user + Sign out at the bottom),
 * redirects away from pages the user's role doesn't allow (Project Setup:
 * license admins + project admins; License Administration: license admins),
 * redirects EVERYONE away from every page except /account until they're
 * signed in with both ACC and Revizto connected, and dispatches an
 * "app:ready" event so each page's own script can proceed without
 * re-fetching /auth/me. Also owns the open project: the sidebar's
 * project switcher, shared by every page (services/currentProject.js) —
 * pages read it from app:ready's `currentProject` instead of their own
 * drop-downs.
 *
 * Client-side hiding/redirects here are a UX convenience, not the security
 * boundary — every route checks the same rules server-side
 * (routes/auth.js requireLicenseAdmin / requireProjectRole, backed by
 * services/access.js), which is what actually protects the data.
 */
const _isAdmin = (user) => !!user && (user.isLicenseAdmin || user.isAnyProjectAdmin);

const ADMIN_PAGES = {
  // Project Setup: license admins, and project admins (for their own projects).
  '/setup': _isAdmin,
  // Activity Log: the same — project admins see the projects they admin.
  '/logs': _isAdmin,
  // License Administration: license admins only.
  '/license': (user) => user.isLicenseAdmin,
};

// Pages that show one project's data — they need a project open (the
// sidebar switcher). Someone with several projects and none open yet is
// sent to My Connections to pick one first.
const PROJECT_PAGES = ['/issues', '/logs', '/setup', '/team', '/dashboards'];

// Sidebar layout (user's call, 2026-09-28): everyone's main list, then —
// for license admins and project admins — an "Admins" section, where
// Dashboards moves to for them. My Connections sits at the bottom, above
// Sign out (the footer).
const MAIN_LINKS = [
  { href: '/issues', label: 'Issues' },
  { href: '/team', label: 'Team' },
  { href: '/dashboards', label: 'Dashboards', nonAdminOnly: true },
  // Mockup only — see README "Planned: Help Center (phase 3)". Topics:
  // best practices, FAQ, video tutorials, contact support.
  { href: '#', label: 'Help Center', disabled: true },
];
const ADMIN_LINKS = [
  { href: '/license', label: 'License Administration' },
  { href: '/setup', label: 'Project Setup' },
  { href: '/logs', label: 'Activity Log' },
  { href: '/dashboards', label: 'Dashboards' },
];

/**
 * Blocking pop-up: a title, a message and buttons ({ label, className,
 * value }). Resolves with the clicked button's value (Escape = the last
 * button's). Built with textContent — messages can hold user data.
 */
function _showDialog(titleText, message, buttons, { tone = 'danger' } = {}) {
  document.getElementById('alert-dialog')?.remove();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.id = 'alert-dialog';
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.className = `modal${tone === 'neutral' ? ' modal-neutral' : ''}`;
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'alert-dialog-title');
    const title = document.createElement('h2');
    title.id = 'alert-dialog-title';
    title.textContent = titleText;
    const body = document.createElement('p');
    body.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(buttons[buttons.length - 1].value);
    };
    document.addEventListener('keydown', onKey);
    const buttonEls = buttons.map((b) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = b.className || 'btn';
      el.textContent = b.label;
      el.addEventListener('click', () => close(b.value));
      return el;
    });
    actions.append(...buttonEls);
    dialog.append(title, body, actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    buttonEls[buttonEls.length - 1].focus(); // the safe choice (OK / Cancel)
  });
}

/** Pop-up with OK. On window so page scripts can use it (account.js, setup.js). */
function showAlertDialog(titleText, message) {
  return _showDialog(titleText, message, [{ label: 'OK', value: true }]);
}
window.showAlertDialog = showAlertDialog;

/**
 * "Are you sure?" pop-up — resolves true only if the person clicks the
 * confirm button. `danger` makes the title and button red (e.g. Delete).
 */
function showConfirmDialog(titleText, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return _showDialog(
    titleText,
    message,
    [
      { label: confirmLabel, className: danger ? 'btn btn-danger' : 'btn', value: true },
      { label: 'Cancel', className: 'btn secondary', value: false },
    ],
    { tone: danger ? 'danger' : 'neutral' }
  );
}
window.showConfirmDialog = showConfirmDialog;

/**
 * "Access denied" — when sign-in is refused because the person isn't a
 * member of both the Revizto and ACC project, and when a signed-in session
 * is ended for the same reason (services/membership.js re-checks every 15
 * minutes).
 */
function showAccessDenied(message) {
  showAlertDialog('Access denied', message);
}
window.showAccessDenied = showAccessDenied;

/**
 * Opens a project on every page (saved to the account —
 * services/currentProject.js). Throws with the server's message if it
 * isn't one they can open.
 */
async function switchProject(projectId) {
  const res = await fetch('/api/me/current-project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ projectId: Number(projectId) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
}
window.switchProject = switchProject;

function _projectLabel(p) {
  return p.revizto_project_uuid && p.acc_project_id ? p.name : `${p.name} (not paired yet)`;
}

/**
 * The Project filter on Dashboards and Activity Log: "All projects" first,
 * then every project they can open, starting on the open one. It filters
 * that page only — the open project (sidebar) stays as it is (user's call,
 * 2026-09-27). onChange(projectId, or '' for all).
 */
function fillProjectFilter(select, projects, currentProject, onChange) {
  select.replaceChildren(new Option('All projects', ''));
  for (const p of projects) select.add(new Option(_projectLabel(p), p.id));
  select.value = currentProject ? String(currentProject.id) : '';
  select.addEventListener('change', () => onChange(select.value));
}
window.fillProjectFilter = fillProjectFilter;

/** The sidebar's project switcher. Built with textContent — names are user data. */
function _projectSwitcher(projects, currentProjectId) {
  const wrap = document.createElement('div');
  wrap.className = 'sidebar-project';
  const label = document.createElement('label');
  label.htmlFor = 'sidebar-project-select';
  label.textContent = 'Project';
  const select = document.createElement('select');
  select.id = 'sidebar-project-select';
  if (!currentProjectId) select.add(new Option('Select a project', ''));
  for (const p of projects) select.add(new Option(_projectLabel(p), p.id));
  select.value = currentProjectId ? String(currentProjectId) : '';
  select.title = select.selectedOptions[0]?.text || ''; // full name — the sidebar is narrow
  select.addEventListener('change', async () => {
    if (!select.value) return;
    select.disabled = true;
    try {
      await switchProject(select.value);
      window.location.reload(); // every page re-reads the open project on load
    } catch (err) {
      select.disabled = false;
      select.value = currentProjectId ? String(currentProjectId) : '';
      showAlertDialog("Couldn't switch project", err.message);
    }
  });
  wrap.append(label, select);
  return wrap;
}

async function loadNav() {
  let user = null;
  let acc = { connected: false };
  let revizto = { connected: false };
  let accessDenied = null;
  let projects = [];
  let currentProjectId = null;
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    user = data.user;
    acc = data.acc;
    revizto = data.revizto;
    accessDenied = data.accessDenied || null;
    projects = data.projects || [];
    currentProjectId = data.currentProjectId || null;
  } catch {
    // network/auth failure — treat as signed out
  }

  // Signed out just now because they're no longer a member of any of
  // their projects: carry the reason to the sign-in page and show it there.
  if (accessDenied && window.location.pathname !== '/account') {
    try {
      sessionStorage.setItem('accessDenied', accessDenied);
    } catch {
      // storage blocked — the redirect still signs them out, just without the pop-up
    }
    window.location.replace('/account');
    return;
  }
  if (!accessDenied) {
    try {
      accessDenied = sessionStorage.getItem('accessDenied');
      sessionStorage.removeItem('accessDenied');
    } catch {
      accessDenied = null;
    }
  }

  const path = window.location.pathname;
  const fullyConnected = !!user && acc.connected && revizto.connected;
  // Pages this user's role allows (see services/access.js; the server
  // enforces the same rules on every route — this only hides/redirects).
  const canSee = (href) => !ADMIN_PAGES[href] || (!!user && ADMIN_PAGES[href](user));

  // Nobody gets past My Connections until both ACC and Revizto are
  // connected — applies to everyone, admins included. /account itself is
  // always reachable regardless, since that's where connecting happens;
  // this also naturally covers "not signed in at all" for every other
  // page, since fullyConnected requires a signed-in user first.
  if (path !== '/account' && !fullyConnected) {
    window.location.replace('/account');
    return;
  }

  if (!canSee(path)) {
    window.location.replace('/issues');
    return;
  }

  // A link naming a project (e.g. License Administration's "+ New Project"
  // → /setup?project=12) opens that project, if it's one they can open.
  const linkedProjectId = Number(new URLSearchParams(window.location.search).get('project')) || null;
  if (fullyConnected && linkedProjectId && linkedProjectId !== currentProjectId && projects.some((p) => p.id === linkedProjectId)) {
    try {
      await switchProject(linkedProjectId);
      currentProjectId = linkedProjectId;
    } catch {
      // keeps the project they had open
    }
  }

  // Several projects and none open yet: pick one on My Connections first,
  // then come back here.
  if (fullyConnected && !currentProjectId && projects.length > 1 && PROJECT_PAGES.includes(path)) {
    window.location.replace(`/account?next=${encodeURIComponent(path)}`);
    return;
  }
  const currentProject = projects.find((p) => p.id === currentProjectId) || null;

  const mount = document.getElementById('sidebar-mount');
  if (mount) {
    const isAdmin = _isAdmin(user);
    const linkHtml = (l, extraClass = '') => {
      const cls = `sidebar-link${extraClass}`;
      if (l.disabled) return `<span class="${cls} disabled" title="Not built yet">${l.label}</span>`;
      // Locked until signed in with both accounts connected — only My
      // Connections, where that happens, stays open.
      if (!fullyConnected && l.href !== '/account') {
        return `<span class="${cls} disabled" title="${user ? 'Connect both Revizto and ACC first' : 'Sign in first'}">${l.label}</span>`;
      }
      const active = path === l.href ? ' active' : '';
      return `<a href="${l.href}" class="${cls}${active}">${l.label}</a>`;
    };
    const mainLinks = MAIN_LINKS.filter((l) => !(l.nonAdminOnly && isAdmin));
    const adminLinks = isAdmin ? ADMIN_LINKS.filter((l) => canSee(l.href)) : [];
    mount.innerHTML = `
      <div class="sidebar">
        <div class="sidebar-brand">Revizto <span class="bridge-glyph" aria-hidden="true">⇄</span> ACC</div>
        <nav class="sidebar-nav">
          ${mainLinks.map((l) => linkHtml(l)).join('')}
          ${
            adminLinks.length
              ? `<div class="sidebar-section" role="group" aria-labelledby="sidebar-admins-label">
                   <div class="sidebar-section-label" id="sidebar-admins-label">Admins</div>
                   ${adminLinks.map((l) => linkHtml(l, ' sidebar-sublink')).join('')}
                 </div>`
              : ''
          }
        </nav>
        <div class="sidebar-footer" id="sidebar-footer">
          ${linkHtml({ href: '/account', label: 'My Connections' }, ' sidebar-footer-link')}
        </div>
      </div>
    `;
    // The open project, under the brand — one switcher for every page.
    if (fullyConnected && projects.length) {
      mount.querySelector('.sidebar-brand').after(_projectSwitcher(projects, currentProjectId));
    }
    // Who's signed in + Sign out, bottom left of the sidebar. Built with
    // textContent — the email is user data.
    const footer = document.getElementById('sidebar-footer');
    if (user) {
      const email = document.createElement('div');
      email.className = 'sidebar-user-email';
      email.textContent = user.email;
      const badge = document.createElement('span');
      badge.className = `badge badge-${user.isLicenseAdmin || user.isAnyProjectAdmin ? 'warning' : 'neutral'}`;
      badge.textContent = user.roleLabel || user.role;
      const signOut = document.createElement('button');
      signOut.type = 'button';
      signOut.className = 'btn secondary sidebar-signout';
      signOut.textContent = 'Sign out';
      signOut.addEventListener('click', async () => {
        await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        window.location.replace('/account');
      });
      footer.append(email, badge, signOut);
    }
  }

  // Wait until every page script has run before announcing. /auth/me can
  // come back while the browser is still downloading the page's own
  // script (issues.js, loaded after nav.js and multiselect.js) — the
  // event then fired with nothing listening yet, and the page stayed
  // blank until reloaded. DOMContentLoaded fires only after all of the
  // page's ordinary <script> tags have executed.
  if (document.readyState === 'loading') {
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  // projects: every project they can open (each with my_role);
  // currentProject: the open one (null if none yet or they have none).
  window.dispatchEvent(new CustomEvent('app:ready', { detail: { user, acc, revizto, projects, currentProject } }));
  if (accessDenied) showAccessDenied(accessDenied);
}

loadNav();
