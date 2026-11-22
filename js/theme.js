/* ============================================================================
   Theme
   Light/dark switching, persisted in localStorage.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const THEME_KEY = 'typecraft.theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* private mode */ }
  // Repaint overlays with theme-appropriate contrast.
  if (TC.state.pages.length) TC.drawOriginalOverlay();
}
function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(t);
  TC.$('themeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  TC.$('themeToggle').title = 'Toggle theme (T)';
}

  // --- exported onto TC ---
  TC.THEME_KEY = THEME_KEY;
  TC.applyTheme = applyTheme;
  TC.initTheme = initTheme;
});
