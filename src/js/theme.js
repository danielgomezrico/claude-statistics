/*
 * theme.js — light/dark theme toggle + motion-mode toggle.
 *
 * Storage keys:
 *   claude-meter.theme    = "light" | "dark"             (default: prefers-color-scheme)
 *   claude-meter.motion   = "full"  | "reduced" | "none" (default: "full")
 *
 * Classes applied to <html>:
 *   theme-light  — activates :root.theme-light overrides in theme-light.css
 *   motion-off   — kills all CSS animations/transitions (Motion: None)
 *
 * Public API:
 *   window.CM.theme.get()           → "light" | "dark"
 *   window.CM.theme.set(next)
 *   window.CM.theme.toggle()
 *   window.CM.motion.get()          → "full" | "reduced" | "none"
 *   window.CM.motion.set(next)
 *
 * Also exposes window.CB_PALETTE — Okabe-Ito ordered array for Chart.js.
 */
(function () {
  var THEME_KEY = 'claude-meter.theme';
  var MOTION_KEY = 'claude-meter.motion';

  window.CB_PALETTE = [
    '#E69F00', // orange
    '#56B4E9', // sky blue
    '#009E73', // bluish green
    '#F0E442', // yellow
    '#0072B2', // blue
    '#D55E00', // vermilion
    '#CC79A7', // reddish purple
    '#000000'  // black
  ];

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* private mode, ignore */ }
  }

  function systemTheme() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  function currentTheme() {
    var stored = safeGet(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return systemTheme();
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'light') root.classList.add('theme-light');
    else root.classList.remove('theme-light');
    updateToggleIcon(theme);
  }

  function setTheme(next) {
    if (next !== 'light' && next !== 'dark') return;
    safeSet(THEME_KEY, next);
    applyTheme(next);
  }

  function toggleTheme() {
    setTheme(currentTheme() === 'light' ? 'dark' : 'light');
  }

  function currentMotion() {
    var stored = safeGet(MOTION_KEY);
    if (stored === 'full' || stored === 'reduced' || stored === 'none') return stored;
    return 'full';
  }

  function applyMotion(mode) {
    var root = document.documentElement;
    if (mode === 'none') root.classList.add('motion-off');
    else root.classList.remove('motion-off');
    // Reduced is handled by CSS @media (prefers-reduced-motion) — nothing to toggle.
  }

  function setMotion(next) {
    if (next !== 'full' && next !== 'reduced' && next !== 'none') return;
    safeSet(MOTION_KEY, next);
    applyMotion(next);
  }

  var SUN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  var MOON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function updateToggleIcon(theme) {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.innerHTML = theme === 'light' ? MOON_SVG : SUN_SVG;
    btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    btn.setAttribute('title', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  }

  // Apply as early as possible (no FOUC even though script loads in <head>).
  applyTheme(currentTheme());
  applyMotion(currentMotion());

  // Wire toggle button when DOM is ready.
  function wire() {
    var btn = document.getElementById('themeToggle');
    if (btn) {
      updateToggleIcon(currentTheme());
      btn.addEventListener('click', toggleTheme);
    }
    // Optional motion selector (id="motionMode"), values full|reduced|none.
    var sel = document.getElementById('motionMode');
    if (sel) {
      sel.value = currentMotion();
      sel.addEventListener('change', function (e) { setMotion(e.target.value); });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.CM = window.CM || {};
  window.CM.theme = { get: currentTheme, set: setTheme, toggle: toggleTheme };
  window.CM.motion = { get: currentMotion, set: setMotion };
})();
