/**
 * Pre-paint theme bootstrap — runs before first paint to prevent a flash of the
 * wrong theme. Loaded as a blocking <script src> in <head> (not inline) so it
 * complies with the Content-Security-Policy `script-src 'self'` directive.
 */
(function () {
  try {
    var t = localStorage.getItem('cardboard_theme');
    var s = localStorage.getItem('cardboard_theme_manual');
    if (t === 'light' || (!s && (!window.matchMedia || !window.matchMedia('(prefers-color-scheme: dark)').matches))) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (_) { /* localStorage unavailable — fall back to default theme */ }
})();
