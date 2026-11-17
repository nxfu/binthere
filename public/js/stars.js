// stars.js — fills the topbar GitHub badge with the repo's star count
// (deferred, first-party, CSP-safe: script-src 'self'). The number comes from
// /api/stars, the Worker's cached proxy — the page can't call api.github.com
// itself under connect-src 'self'. The last count is remembered so a repeat
// visit paints the badge with the rest of the topbar instead of widening it
// mid-read; any failure leaves the badge as a plain link to the repository.
(function () {
  const KEY = 'binthere:stars:v1';
  const link = document.getElementById('gh-link');
  const wrap = document.getElementById('gh-stars');
  const out = document.getElementById('gh-count');
  if (!link || !wrap || !out) return;

  // Four digits is the widest the topbar can spare; 1000 → "1k", 12500 → "12.5k".
  const format = function (n) {
    if (n < 1000) return String(n);
    const k = n < 10000 ? (Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(n / 1000));
    return k + 'k';
  };

  const show = function (n) {
    out.textContent = format(n);
    // The visible count is inside the labelled link, so the label has to carry
    // it too or screen readers announce the badge without its number.
    link.setAttribute('aria-label', 'binthere on GitHub — ' + n + (n === 1 ? ' star' : ' stars'));
    wrap.hidden = false;
  };

  let cached = null;
  try {
    cached = localStorage.getItem(KEY);
  } catch {
    /* storage disabled — just wait for the fetch */
  }
  if (cached && /^\d{1,9}$/.test(cached)) show(Number(cached));

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 8_000);
  window.addEventListener('pagehide', function () { controller.abort(); }, { once: true });

  fetch('/api/stars', { signal: controller.signal })
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (data) {
      if (!link.isConnected) return;
      if (!data || !Number.isInteger(data.stars) || data.stars < 0) return;
      show(data.stars);
      try {
        localStorage.setItem(KEY, String(data.stars));
      } catch {
        /* storage disabled — next load just starts from the fetch again */
      }
    })
    .catch(function () {
      /* offline, blocked, or GitHub down — keep whatever is already shown */
    })
    .finally(function () {
      clearTimeout(timer);
    });
})();
