/**
 * public/js/theme.js
 * Light / medium / dark theme. Loaded in <head> of every page so the saved
 * choice is applied before first paint (no flash). Three icon buttons in the
 * top-right corner (nav.js mounts them): a sun (light), a half-filled circle
 * (medium — a softer mid-tone) and a moon (dark). Until a choice is made the
 * app follows the device's light/dark setting; the choice is kept in
 * localStorage when it's available. css/app.css does the rest through
 * data-theme and prefers-color-scheme.
 */
(function () {
  const KEY = 'theme';
  const CHOICES = ['light', 'medium', 'dark'];

  /** The saved choice, or null when none was made (follow the device). */
  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return CHOICES.includes(v) ? v : null;
    } catch {
      return null;
    }
  }

  function apply(choice) {
    const root = document.documentElement;
    if (choice) root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
  }

  /** The theme actually showing: 'light', 'medium' or 'dark'. */
  function effective() {
    return saved() || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function announce() {
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: effective() } }));
  }

  function set(choice) {
    if (!CHOICES.includes(choice)) return;
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // storage blocked — the choice still applies until the page is closed
    }
    apply(choice);
    announce();
  }

  apply(saved());
  // Following the device: re-announce when it flips (charts redraw).
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (!saved()) announce();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
  // Another tab changed it.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      apply(saved());
      announce();
    }
  });

  const SVG_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const ICONS = {
    // sun
    light: SVG_OPEN + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    // half-filled circle
    medium: SVG_OPEN + '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
    // moon
    dark: SVG_OPEN + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  const LABELS = { light: 'Light theme', medium: 'Medium theme', dark: 'Dark theme' };

  /** Mounts the three theme buttons into `container` (top-right corner of the page). */
  function mountSwitch(container) {
    if (document.getElementById('theme-switch')) return;
    const wrap = document.createElement('div');
    wrap.id = 'theme-switch';
    wrap.className = 'theme-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Colour theme');
    const buttons = CHOICES.map((choice) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.choice = choice;
      b.innerHTML = ICONS[choice];
      b.title = LABELS[choice];
      b.setAttribute('aria-label', LABELS[choice]);
      b.addEventListener('click', () => set(choice));
      return b;
    });
    const refresh = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.choice === effective())));
    refresh();
    window.addEventListener('themechange', refresh);
    wrap.append(...buttons);
    container.appendChild(wrap);
  }

  window.theme = { set, saved, effective, mountSwitch };
})();
