/**
 * public/js/nav.js
 * Loaded first on every page. Fetches auth state once, renders the left
 * sidebar (tabs shown by role, signed-in user + Sign out at the bottom),
 * redirects away from pages the user's role doesn't allow (Project Setup:
 * license admins + project admins; License Administration: license admins),
 * redirects EVERYONE away from every page except /account until they're
 * signed in with both ACC and Revizto connected, and dispatches an
 * "app:ready" event so each page's own script can proceed without
 * re-fetching /auth/me.
 *
 * Client-side hiding/redirects here are a UX convenience, not the security
 * boundary — every route checks the same rules server-side
 * (routes/auth.js requireLicenseAdmin / requireProjectRole, backed by
 * services/access.js), which is what actually protects the data.
 */
const ADMIN_PAGES = {
  // Project Setup: license admins, and project admins (for their own projects).
  '/setup': (user) => user.isLicenseAdmin || user.isAnyProjectAdmin,
  // License Administration: license admins only.
  '/license': (user) => user.isLicenseAdmin,
};

const NAV_LINKS = [
  { href: '/issues', label: 'Issues' },
  { href: '/logs', label: 'Activity Log' },
  { href: '/account', label: 'My Connections' },
  { href: '/setup', label: 'Project Setup' },
  { href: '/team', label: 'Team' },
  { href: '/license', label: 'License Administration' },
  { href: '/dashboards', label: 'Dashboards' },
  // Mockup only — see README "Planned: Help Center (phase 3)". Topics:
  // best practices, FAQ, video tutorials, contact support.
  { href: '#', label: 'Help Center', disabled: true },
];

/**
 * Blocking pop-up with a title, a message and OK. On window so page
 * scripts can use it (account.js, setup.js).
 */
function showAlertDialog(titleText, message) {
  document.getElementById('alert-dialog')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'alert-dialog';
  backdrop.className = 'modal-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'alert-dialog-title');
  const title = document.createElement('h2');
  title.id = 'alert-dialog-title';
  title.textContent = titleText;
  const body = document.createElement('p');
  body.textContent = message;
  const ok = document.createElement('button');
  ok.className = 'btn';
  ok.type = 'button';
  ok.textContent = 'OK';
  ok.addEventListener('click', () => backdrop.remove());
  dialog.append(title, body, ok);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  ok.focus();
}
window.showAlertDialog = showAlertDialog;

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

async function loadNav() {
  let user = null;
  let acc = { connected: false };
  let revizto = { connected: false };
  let accessDenied = null;
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    user = data.user;
    acc = data.acc;
    revizto = data.revizto;
    accessDenied = data.accessDenied || null;
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

  const mount = document.getElementById('sidebar-mount');
  if (mount) {
    mount.innerHTML = `
      <div class="sidebar">
        <div class="sidebar-brand">Revizto <span class="bridge-glyph" aria-hidden="true">⇄</span> ACC</div>
        <nav class="sidebar-nav">
          ${NAV_LINKS.filter((l) => canSee(l.href))
            .map((l) => {
              if (l.disabled) return `<span class="sidebar-link disabled" title="Not built yet">${l.label}</span>`;
              // Locked until signed in with both accounts connected — only My
              // Connections, where that happens, stays open.
              if (!fullyConnected && l.href !== '/account') {
                return `<span class="sidebar-link disabled" title="${user ? 'Connect both Revizto and ACC first' : 'Sign in first'}">${l.label}</span>`;
              }
              const active = path === l.href ? ' active' : '';
              return `<a href="${l.href}" class="sidebar-link${active}">${l.label}</a>`;
            })
            .join('')}
        </nav>
        <div class="sidebar-footer" id="sidebar-footer"></div>
      </div>
    `;
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
    } else {
      footer.remove();
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
  window.dispatchEvent(new CustomEvent('app:ready', { detail: { user, acc, revizto } }));
  if (accessDenied) showAccessDenied(accessDenied);
}

loadNav();
