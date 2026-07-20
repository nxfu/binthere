// theme.js — wires the topbar light/dark toggle (deferred, first-party, CSP-safe).
// theme-init.js already applied the saved preference before paint; this only
// handles clicks: flip the class on <html> and persist the choice.
(function () {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  // Reflect the state theme-init.js applied before paint (it runs in <head>,
  // before the button exists, so the a11y state is set here instead).
  btn.setAttribute('aria-pressed', String(document.documentElement.classList.contains('dark')));
  btn.addEventListener('click', function () {
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    btn.setAttribute('aria-pressed', String(next === 'dark'));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = next === 'dark' ? '#0d1117' : '#f2f1ec';
    try {
      localStorage.setItem('binthere:theme', next);
    } catch {
      /* storage disabled — the toggle still works for this page load */
    }
  });
})();
