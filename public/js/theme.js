/**
 * public/js/theme.js
 * Light / dark theme. Loaded in <head> of every page so the saved choice is
 * applied before first paint (no flash). The choice is "system" (follow the
 * operating system — the default), "light" or "dark", kept in localStorage
 * when it's available; css/app.css does the rest through data-theme and
 * prefers-color-scheme. nav.js mounts the switch in the sidebar footer.
 */
(function () {
  const KEY = 'theme';
  const CHOICES = ['system', 'light', 'dark'];

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return CHOICES.includes(v) ? v : 'system';
    } catch {
      return 'system';
    }
  }

  function apply(choice) {
    const root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
  }

  /** The theme actually showing: 'light' or 'dark'. */
  function effective() {
    const choice = saved();
    if (choice !== 'system') return choice;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function announce() {
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: effective() } }));
  }

  function set(choice) {
    if (!CHOICES.includes(choice)) return;
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // storage blocked — the choice still applies until the page is closed
    }
    apply(choice);
    announce();
  }

  apply(saved());
  // Following the system: re-announce when the OS flips (charts redraw).
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (saved() === 'system') announce();
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

  /** Mounts the System / Light / Dark switch into `container`. */
  function mountSwitch(container) {
    const wrap = document.createElement('div');
    wrap.className = 'theme-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Colour theme');
    const buttons = CHOICES.map((choice) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice[0].toUpperCase() + choice.slice(1);
      b.dataset.choice = choice;
      b.title = choice === 'system' ? 'Match your device' : `${b.textContent} theme`;
      b.addEventListener('click', () => {
        set(choice);
        refresh();
      });
      return b;
    });
    const refresh = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.choice === saved())));
    refresh();
    window.addEventListener('themechange', refresh); // another tab / the system changed it
    wrap.append(...buttons);
    container.prepend(wrap);
  }

  window.theme = { set, saved, effective, mountSwitch };
})();
