// announce.js — reveals the slim top announcement bar once per visitor and
// remembers dismissal (deferred, first-party, CSP-safe: script-src 'self').
// The bar ships hidden in index.html so a dismissed/returning visitor never
// sees a flash; this only un-hides it when the dismissal flag is absent, and
// persists the flag on close. Bump KEY's version to re-announce something new.
(function () {
  const KEY = 'binthere:announce:v1';
  const bar = document.getElementById('announce');
  if (!bar) return;

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(KEY) === '1';
  } catch {
    /* storage disabled — show it this load, just don't persist below */
  }
  if (dismissed) return;

  bar.hidden = false;

  const close = document.getElementById('announce-close');
  if (close) {
    close.addEventListener('click', function () {
      bar.hidden = true;
      try {
        localStorage.setItem(KEY, '1');
      } catch {
        /* storage disabled — it'll reappear next load, which is acceptable */
      }
    });
  }
})();
