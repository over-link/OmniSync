/**
 * public/js/nav.js
 * Loaded first on every page. Fetches auth state once, renders the left
 * sidebar with links visible based on role, redirects non-admins away
 * from admin-only pages (just /setup — /team is readable by anyone
 * signed in now, see below), redirects EVERYONE (admins included) away
 * from every page except /account until both ACC and Revizto are
 * connected, and dispatches an "app:ready" event so each page's own
 * script can proceed without re-fetching /auth/me.
 *
 * Client-side redirect here is a UX convenience, not the real security
 * boundary — every admin-only API route also checks server-side
 * (requireAdmin), which is what actually protects the data. The
 * connections gate is enforced the same way client-side only for now —
 * the app's other API routes don't currently reject an unconnected
 * user's requests server-side, so this is a UX nudge onto /account, not
 * a hard security boundary the way requireAdmin is.
 *
 * /team itself is reachable by any signed-in user — its own script
 * (team.js) renders a read-only view (no invite controls, no editable
 * role dropdown) for non-admins, matching GET /api/team's requireLogin
 * (not requireAdmin); every route that actually changes something there
 * stays requireAdmin server-side, unaffected by this.
 */
const ADMIN_ONLY_PATHS = ['/setup'];

const NAV_LINKS = [
  { href: '/issues', label: 'Issues', adminOnly: false },
  { href: '/logs', label: 'Activity Log', adminOnly: false },
  { href: '/account', label: 'My Connections', adminOnly: false },
  { href: '/setup', label: 'Project Setup', adminOnly: true },
  { href: '/team', label: 'Team', adminOnly: false },
  // Mockup only — see README "Planned: multi-project workspaces". Will hold
  // license project-slot count/usage and per-project API-call tracking once
  // each project runs off its own DB.
  { href: '#', label: 'License Administration', adminOnly: true, disabled: true },
  { href: '#', label: 'Dashboards', adminOnly: false, disabled: true },
  // Mockup only — see README "Planned: Help Center (phase 3)". Topics:
  // best practices, FAQ, video tutorials, contact support. Open to
  // everyone (not admin-gated), unlike the two entries above it.
  { href: '#', label: 'Help Center', adminOnly: false, disabled: true },
];

async function loadNav() {
  let user = null;
  let acc = { connected: false };
  let revizto = { connected: false };
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    user = data.user;
    acc = data.acc;
    revizto = data.revizto;
  } catch {
    // network/auth failure — treat as signed out
  }

  const path = window.location.pathname;
  const isAdmin = user?.role === 'admin';
  const fullyConnected = !!user && acc.connected && revizto.connected;

  // Nobody gets past My Connections until both ACC and Revizto are
  // connected — applies to everyone, admins included. /account itself is
  // always reachable regardless, since that's where connecting happens;
  // this also naturally covers "not signed in at all" for every other
  // page, since fullyConnected requires a signed-in user first.
  if (path !== '/account' && !fullyConnected) {
    window.location.replace('/account');
    return;
  }

  if (ADMIN_ONLY_PATHS.includes(path) && !isAdmin) {
    window.location.replace('/issues');
    return;
  }

  const mount = document.getElementById('sidebar-mount');
  if (mount) {
    mount.innerHTML = `
      <div class="sidebar">
        <div class="sidebar-brand">Revizto <span class="bridge-glyph" aria-hidden="true">⇄</span> ACC</div>
        <nav class="sidebar-nav">
          ${NAV_LINKS.filter((l) => !l.adminOnly || isAdmin)
            .map((l) => {
              if (l.disabled) return `<span class="sidebar-link disabled" title="Not built yet">${l.label}</span>`;
              const active = path === l.href ? ' active' : '';
              return `<a href="${l.href}" class="sidebar-link${active}">${l.label}</a>`;
            })
            .join('')}
        </nav>
        <div class="sidebar-footer">
          ${user ? `<div class="sidebar-user">${user.email}<span class="badge badge-${isAdmin ? 'warning' : 'neutral'}">${user.role}</span></div>` : ''}
        </div>
      </div>
    `;
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
}

loadNav();
