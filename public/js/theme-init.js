// theme-init.js — blocking, first-party head script (CSP-safe: script-src 'self').
// Runs before the stylesheet paints so the saved theme is applied with no flash.
// Defaults to dark; index.html also ships class="dark" so a no-JS load stays dark.
try {
  const t = localStorage.getItem('binthere:theme') || 'dark';
  document.documentElement.classList.toggle('dark', t === 'dark');
  // Keep the browser chrome (mobile address bar) on the actual canvas color.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#0d1117' : '#f2f1ec';
} catch {
  /* private-mode / storage disabled — keep the dark default from index.html */
}
