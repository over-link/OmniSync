/**
 * public/js/nav.js
 * Loaded first on every page. Fetches auth state once, renders the left
 * sidebar with links visible based on role, redirects non-admins away
 * from admin-only pages (/setup, /team), and dispatches an "app:ready"
 * event so each page's own script can proceed without re-fetching /auth/me.
 *
 * Client-side redirect here is a UX convenience, not the real security
 * boundary — every admin-only API route also checks server-side
 * (requireAdmin), which is what actually protects the data.
 */
const ADMIN_ONLY_PATHS = ['/setup', '/team'];

const NAV_LINKS = [
  { href: '/issues', label: 'Issues', adminOnly: false },
  { href: '/account', label: 'My Connections', adminOnly: false },
  { href: '/setup', label: 'Project Setup', adminOnly: true },
  { href: '/team', label: 'Team', adminOnly: true },
  // Mockup only — see README "Planned: multi-project workspaces". Will hold
  // license project-slot count/usage and per-project API-call tracking once
  // each project runs off its own DB.
  { href: '#', label: 'License Administration', adminOnly: true, disabled: true },
  { href: '#', label: 'Analytics', adminOnly: false, disabled: true },
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

  if (ADMIN_ONLY_PATHS.includes(path)) {
    if (!user) {
      window.location.replace('/account');
      return;
    }
    if (!isAdmin) {
      window.location.replace('/issues');
      return;
    }
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

  window.dispatchEvent(new CustomEvent('app:ready', { detail: { user, acc, revizto } }));
}

loadNav();
