// ui.js — small DOM helpers for the client. No innerHTML on user content.

export const $ = (sel, root = document) => root.querySelector(sel);

const VIEWS = ['view-create', 'view-success', 'view-password', 'view-paste', 'view-status'];

/** Show exactly one top-level view section, hide the rest. */
export function showView(name) {
  for (const id of VIEWS) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== `view-${name}`;
  }
  // Footer nav links belong to the landing page only; hide them elsewhere to
  // reduce clutter on paste/success/password/status views.
  const footLinks = document.getElementById('foot-links');
  if (footLinks) footLinks.hidden = name !== 'create';
}

/** Transient bottom toast. */
let toastTimer;
export function toast(message) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/** Copy text to the clipboard, with a legacy fallback. Returns a boolean. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'clipboard-stage';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Flash a copy button into its "copied" state briefly. */
export function flashCopied(btn, label = 'copied') {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = label;
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('copied');
  }, 1600);
}

/** Build a pill element (mono badge with a status dot). */
export function pill(text, kind) {
  const el = document.createElement('span');
  el.className = kind ? `pill ${kind}` : 'pill';
  el.textContent = text;
  return el;
}
