// app.js — binthere client controller. Routes between "create" and "view" based
// on the URL path (/p/<id>#<key>), drives encryption/decryption, and renders
// decrypted content via DOM construction only. The fragment key never leaves the
// browser and is never placed in a network request.

import { encryptPaste, decryptPaste, decryptContent, deriveContentKey, PasswordRequired } from './crypto.js';
import { createPaste, fetchPaste, fetchPasteMeta, consumePaste, deletePaste, ApiError } from './api.js';
import { validateHead, validatePaste, buildAAD, EXPIRE_SECONDS } from './format.js';
import { renderMarkdown } from './markdown.js';
import { looksLikeCode, highlightInto } from './highlight.js';
import { $, showView, toast, copyText, flashCopied, pill } from './ui.js';

// Module-level state referenced by helpers that may run during the top-level
// route dispatch below. Declared here (not near the timer helpers further down)
// because `let` in the temporal dead zone would throw if `status()` fired first
// and called `stopExpiryTimer()` before this line was reached — turning every
// view into a stuck "loading…" screen.
let expiryTimer = null;

// ── boot ─────────────────────────────────────────────────────────────────────
const route = location.pathname.match(/^\/p\/([^/]+)\/?$/);
if (route) {
  let id = null;
  // Malformed percent-encoding must not throw during module evaluation (it
  // would leave every view hidden — a blank page). Show a proper error instead.
  try { id = decodeURIComponent(route[1]); } catch { /* fall through */ }
  if (id !== null) initView(id);
  else status('This link is malformed — check that it was copied completely.', true);
} else {
  initCreate();
}

// ── CREATE ─────────────────────────────────────────────────────────────────
function initCreate() {
  showView('create');
  // Format is uniform now — every note is stored as plaintext and any obvious
  // source code is syntax-highlighted at view time (see renderContent).
  const fmt = 'plaintext';
  // The lock toggle only records intent ("this note needs a password"); the
  // password itself is typed in the modal shown when Create link is pressed.
  let pwRequired = false;

  const lock = $('#lock');
  if (lock) {
    lock.addEventListener('click', () => {
      pwRequired = lock.classList.toggle('active');
      lock.setAttribute('aria-pressed', String(pwRequired));
    });
  }

  const createBtn = $('#create');
  const sendTxt = createBtn.querySelector('.send-txt');
  const msg = $('#create-msg');

  const requestCreate = () => {
    if (createBtn.disabled) return;
    if (!$('#editor').value.trim()) { showMsg(msg, 'Type something first.'); $('#editor').focus(); return; }
    msg.hidden = true;
    if (pwRequired) openPasswordModal((password) => submitPaste(password));
    else submitPaste('');
  };
  createBtn.addEventListener('click', requestCreate);
  // Editor convention: Ctrl/Cmd+Enter submits without leaving the textarea.
  $('#editor').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); requestCreate(); }
  });

  // Every note is one-time view (bar:true) and auto-deletes within 24h — a
  // deliberate product choice, not a missing picker. The wire format (and the
  // CLI/API) supports the full expiry range; the web client does not expose it.
  async function submitPaste(password) {
    createBtn.disabled = true;
    const label = sendTxt ? sendTxt.textContent : '';
    if (sendTxt) sendTxt.textContent = 'Encrypting…';
    try {
      const { body, fragment } = await encryptPaste({
        text: $('#editor').value,
        password,
        fmt,
        bar: true,
        expire: '1day',
      });
      const { id, deletetoken } = await createPaste(body);
      const url = `${location.origin}/p/${id}#${fragment}`;
      // Only after the server confirmed the create: the plaintext has served its
      // purpose, so don't leave it sitting in the (now hidden) textarea. On any
      // failure it is deliberately kept — the user must not lose their note.
      $('#editor').value = '';
      showSuccess({ id, deletetoken, url, isBurn: true });
    } catch (e) {
      showMsg(msg, friendlyError(e));
      createBtn.disabled = false;
      if (sendTxt) sendTxt.textContent = label;
    }
  }
}

// ── password modal ───────────────────────────────────────────────────────────
// The single popup: "Paste password" with Cancel / Create. Calls onSubmit(pw)
// once with a non-empty password; closes on backdrop click, Escape, or cancel.
// While open, Tab is trapped inside the dialog; on close, focus returns to the
// element that opened it (a11y — the modal is aria-modal="true").
function openPasswordModal(onSubmit) {
  const scrim = $('#pw-modal');
  if (!scrim) { onSubmit(''); return; }

  const input = $('#modal-password');
  const confirmInput = $('#modal-password-confirm');
  const create = $('#pw-create');
  const cancel = $('#pw-cancel');
  const mmsg = $('#pw-modal-msg');
  const opener = document.activeElement;
  wirePeek('#modal-password', '#modal-peek');
  wirePeek('#modal-password-confirm', '#modal-peek-confirm');

  const close = () => {
    scrim.hidden = true;
    input.value = ''; // don't leave the password in the hidden DOM
    confirmInput.value = '';
    create.onclick = cancel.onclick = scrim.onclick = input.onkeydown = confirmInput.onkeydown = null;
    document.removeEventListener('keydown', onKey);
    if (opener && typeof opener.focus === 'function') opener.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    // Focus trap: cycle within the dialog's enabled, visible controls.
    const focusables = [...scrim.querySelectorAll('input, button')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || !scrim.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !scrim.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  };
  const submit = () => {
    if (!input.value) { showMsg(mmsg, 'Enter a password, or cancel.'); input.focus(); return; }
    // Practical cap, enforced VISIBLY — never via maxlength, whose silent
    // truncation could seal the note with a password the reader doesn't have.
    if (input.value.length > 128) {
      showMsg(mmsg, 'Password is too long — 128 characters max.');
      input.focus();
      return;
    }
    // A mistyped password permanently locks a one-time note (there is no safe
    // way to test it afterwards — opening the link consumes the note).
    if (input.value !== confirmInput.value) {
      showMsg(mmsg, 'Passwords do not match — repeat the same password in both fields.');
      confirmInput.focus();
      return;
    }
    const pw = input.value;
    close();
    onSubmit(pw);
  };

  create.onclick = submit;
  cancel.onclick = close;
  scrim.onclick = (e) => { if (e.target === scrim) close(); };
  input.onkeydown = confirmInput.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  document.addEventListener('keydown', onKey);

  mmsg.hidden = true;
  input.value = '';
  confirmInput.value = '';
  scrim.hidden = false;
  // Focus the dialog (not the input) so the modal is reachable and the focus
  // trap works, without painting a focus ring on the field before the user
  // has clicked or tabbed into it.
  $('#pw-modal-dialog').focus();
}

function showSuccess({ id, deletetoken, url, isBurn }) {
  showView('success');
  $('#paste-url').textContent = url;
  if (isBurn) {
    $('#success-note').textContent =
      'Anyone with this link can read the note once.';
  }
  renderQr(url);

  $('#copy-url').onclick = async () => {
    flashCopied($('#copy-url'), (await copyText(url)) ? 'copied' : 'failed');
  };
  // Both irreversible actions are two-step: opening a one-time link consumes it,
  // and delete is permanent. A stray click must not kill a note about to be shared.
  armConfirm($('#open-link'), 'Uses the one view — open?', () => { location.href = url; });
  $('#another').onclick = () => { location.href = '/'; };

  const delBtn = $('#delete-btn');
  const sMsg = $('#success-msg');
  const delLabel = delBtn.textContent;
  armConfirm(delBtn, 'Permanently delete?', async () => {
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting…';
    try {
      await deletePaste(id, deletetoken);
      showMsg(sMsg, 'This paste has been deleted.');
      toast('deleted');
      delBtn.textContent = 'Deleted';
      // The link is dead now — don't leave live-looking actions pointing at it.
      $('#open-link').disabled = true;
      $('#copy-url').disabled = true;
    } catch (e) {
      showMsg(sMsg, friendlyError(e));
      delBtn.disabled = false;
      delBtn.textContent = delLabel;
    }
  });
}

// Two-step confirmation for irreversible actions. The first activation "arms"
// the button — its label changes in place to name the destructive effect (the
// change is announced by screen readers since focus stays on the control); a
// second activation within the window confirms. Disarms on timeout or blur so
// an abandoned half-click can't linger as a landmine.
function armConfirm(btn, armedLabel, onConfirm) {
  const label = btn.textContent;
  let timer = null;
  const disarm = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    btn.textContent = label;
    btn.classList.remove('armed');
  };
  btn.onclick = () => {
    if (timer !== null) { disarm(); onConfirm(); return; }
    btn.textContent = armedLabel;
    btn.classList.add('armed');
    timer = setTimeout(disarm, 5000);
  };
  btn.onblur = disarm;
}

function renderQr(url) {
  const img = $('#qr');
  try {
    if (typeof window.qrcode !== 'function') throw new Error('qr unavailable');
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    img.src = qr.createDataURL(6, 12);
  } catch {
    img.closest('.qr')?.remove();
  }
}

// ── VIEW ─────────────────────────────────────────────────────────────────────
function initView(id) {
  // Only show the "new paste" shortcut when viewing someone's note, not on the
  // landing page (where the whole screen already is the composer).
  const newlink = $('#newlink');
  if (newlink) newlink.hidden = false;

  const fragment = location.hash.slice(1);
  if (!fragment) { status('This link is missing its decryption key.', true); return; }
  if (id[0] === 'b') initBurnView(id, fragment);
  else initNormalView(id, fragment);
}

// Normal (KV) paste: reads are idempotent, so fetch and decrypt directly.
async function initNormalView(id, fragment) {
  status('decrypting…');
  let paste;
  try { paste = await fetchPaste(id); } catch (e) { return handleReadError(e); }
  try {
    renderPaste(paste, await decryptPaste({ paste, fragment }));
  } catch (e) {
    if (e instanceof PasswordRequired) return promptPasswordNormal(paste, fragment);
    status('Could not decrypt this note. The link may be corrupted or altered.', true);
  }
}

// Burn paste: peek the head (adata + wrapped key, NO ciphertext) without
// consuming, so a password can be verified before the single destructive read.
// The paste is only consumed once we actually reveal it.
async function initBurnView(id, fragment) {
  status('checking…');
  let head;
  try { head = await fetchPasteMeta(id); } catch (e) { return handleReadError(e); }
  try {
    // Fail-closed validation of the peeked head BEFORE any key derivation, so a
    // hostile/buggy server can't demand an absurd PBKDF2 workload (adata.iter is
    // clamped) or feed malformed fields into the crypto path.
    head = validateHead(head);
  } catch {
    return status('Could not read this note — the server response was malformed.', true);
  }

  if (head.adata.kdf === 'pbkdf2-hkdf') {
    // Password-protected: prompt + verify against the wrapped key BEFORE consuming.
    promptPasswordBurn(id, fragment, head);
  } else {
    // No password: an explicit "reveal" click is the consent to burn it.
    status('This note can only be viewed once.', false, { reveal: true });
    const revealBtn = $('#reveal-burn');
    revealBtn.disabled = false;
    // When the countdown hits zero the note is gone server-side — leaving an
    // enabled Reveal pointing at a doomed 410 would be a lie. Transition to the
    // expired state immediately (status() also stops and hides the timer).
    startExpiryTimer(head.meta, () => {
      revealBtn.disabled = true;
      status('This note has expired — it can no longer be opened.', true);
    });
    revealBtn.onclick = async () => {
      revealBtn.disabled = true;
      $('#status-actions').hidden = true;
      // Verify the fragment key against the peeked wrapped key BEFORE the
      // destructive read: a truncated/corrupted link must not burn the note.
      let cek;
      try {
        cek = await deriveContentKey({ adata: head.adata, wk: head.wk, fragment });
      } catch {
        return status('Could not decrypt this note — the link may be incomplete or corrupted. The note was not opened and still exists.', true);
      }
      consumeBurn(id, head, cek);
    };
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Perform the single destructive read and render. The fragment key (and any
// password) has already been verified against the peeked head, and `cek` is the
// unwrapped content key from that verification — reused here so the password is
// never stretched (PBKDF2) twice and the consumed read cannot "fail late".
async function consumeBurn(id, head, cek) {
  status('decrypting…');
  let paste;
  try { paste = await consumePaste(id); } catch (e) { return handleReadError(e); }
  try {
    paste = validatePaste(paste);
    // Defense in depth: the consumed record must match the authenticated head we
    // verified the key against. (GCM would reject a swap anyway — the AAD and wk
    // are bound — but failing here is clearer and cheaper.)
    if (paste.wk !== head.wk || !bytesEqual(buildAAD(paste.adata), buildAAD(head.adata))) {
      throw new Error('head mismatch');
    }
    const result = await decryptContent({ adata: paste.adata, ct: paste.ct, cek });
    // The note is consumed; drop the key from the address bar so a reload or a
    // shared screenshot of the URL doesn't carry a now-useless (but real) secret.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    renderPaste(paste, result);
  } catch {
    status('Could not decrypt this note. The link may be corrupted or altered.', true);
  }
}

function promptPasswordNormal(paste, fragment) {
  wirePasswordScreen(false, async (password) => {
    renderPaste(paste, await decryptPaste({ paste, fragment, password }));
  });
}

function promptPasswordBurn(id, fragment, head) {
  wirePasswordScreen(true, async (password) => {
    // Verify the password against the peeked wrapped key WITHOUT consuming.
    // Throws PasswordRequired / DecryptError, leaving the paste intact.
    const cek = await deriveContentKey({ adata: head.adata, wk: head.wk, fragment, password });
    // Verified → the one destructive read, reusing the already-unwrapped CEK
    // (no second 310k-iteration PBKDF2 run).
    await consumeBurn(id, head, cek);
  });
}

// Shared password screen. `verify(password)` throws on a bad/empty password
// (paste untouched) and otherwise transitions the view itself.
function wirePasswordScreen(isBurn, verify) {
  showView('password');
  wirePeek('#decrypt-password', '#peek2');
  const sub = $('#password-subtitle');
  if (sub) {
    sub.textContent = isBurn
      ? 'This single-use note is password-protected. It is destroyed only once the correct password unlocks it.'
      : 'This note is protected by a password in addition to the key in the link.';
  }
  const input = $('#decrypt-password');
  const btn = $('#decrypt-btn');
  const msg = $('#password-msg');
  input.value = '';
  input.focus();

  // Guard the handler itself, not just the button: the Enter keydown path
  // bypasses `disabled`, and on a burn paste a second concurrent verify would
  // issue a second destructive read — the losing 410 could then overwrite the
  // decrypted view. Stays latched on success (verify() replaced the view).
  let inFlight = false;
  const submit = async () => {
    if (inFlight) return;
    inFlight = true;
    msg.hidden = true;
    btn.disabled = true;
    // Password key derivation (PBKDF2) takes real time — say so, like the
    // create button's "Encrypting…".
    const label = btn.textContent;
    btn.textContent = 'Decrypting…';
    try {
      await verify(input.value);
      input.value = ''; // verified — don't leave the password in the hidden DOM
    } catch (e) {
      // A GCM auth failure cannot distinguish a wrong password from a
      // corrupted/tampered link, so the message covers both honestly.
      showMsg(msg, e instanceof PasswordRequired
        ? 'Please enter a password.'
        : 'Wrong password — try again. If you are sure it is correct, the link may be corrupted or altered.');
      inFlight = false;
      btn.disabled = false;
      btn.textContent = label;
      input.focus();
    }
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

function handleReadError(e) {
  // A fetch that never reached the server (offline, DNS, blocked) is NOT the
  // same as "gone" — telling a burn-note reader their note was consumed when
  // they are merely offline would be needlessly alarming.
  if (!(e instanceof ApiError)) {
    status('Could not reach the server — check your connection and try again.', true);
  } else if (e.status === 410) {
    status('This paste has expired or was already opened.', true);
  } else {
    status('This paste has expired, was already opened, or never existed.', true);
  }
}

function renderPaste(paste, result) {
  showView('paste');

  // Notes are uniform text now; source code is auto-detected and highlighted.
  // `isCode` also covers older pastes explicitly saved with fmt:'code'.
  const isMarkdown = result.fmt === 'markdown';
  const isCode = result.fmt === 'code' || (result.fmt === 'plaintext' && looksLikeCode(result.text));

  // Pills: (code|markdown) · (one-time view). Plain text gets no kind pill —
  // it's the default and adds nothing. No expiry pill either: an opened note is
  // already consumed, so "expires in 24h" would be misleading.
  const pills = $('#paste-pills');
  pills.textContent = '';
  if (isMarkdown) pills.appendChild(pill('markdown'));
  else if (isCode) pills.appendChild(pill('code'));
  if (result.bar) pills.appendChild(pill('one-time view · now deleted', 'bad'));

  // Content (DOM construction only).
  const container = $('#paste-content');
  let showRaw = false;
  const draw = () => renderContent(container, result, isCode, showRaw);
  draw();

  const rawBtn = $('#toggle-raw');
  rawBtn.hidden = !isMarkdown;
  rawBtn.textContent = 'Raw';
  rawBtn.onclick = () => { showRaw = !showRaw; rawBtn.textContent = showRaw ? 'Rendered' : 'Raw'; draw(); };

  $('#copy-content').onclick = async () => {
    toast((await copyText(result.text)) ? 'copied to clipboard' : 'copy failed');
  };
}

function renderContent(container, result, isCode, showRaw) {
  container.textContent = '';
  if (result.fmt === 'markdown' && !showRaw) {
    const div = document.createElement('div');
    div.className = 'md';
    renderMarkdown(div, result.text);
    container.appendChild(div);
    return;
  }
  const pre = document.createElement('pre');
  pre.className = 'code';
  if (isCode) {
    // Highlight via createElement + textContent only (never innerHTML).
    const code = document.createElement('code');
    highlightInto(code, result.text);
    pre.appendChild(code);
  } else {
    pre.textContent = result.text;
  }
  container.appendChild(pre);
}

// ── shared helpers ───────────────────────────────────────────────────────────
function wirePeek(inputSel, btnSel) {
  const input = $(inputSel);
  const btn = $(btnSel);
  if (!input || !btn) return;
  // Re-wiring means a fresh entry (modal reopened, password screen shown):
  // always start masked, even if the field was left revealed last time.
  input.type = 'password';
  btn.textContent = 'show';
  btn.setAttribute('aria-label', 'Show password');
  btn.setAttribute('aria-pressed', 'false');
  btn.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'hide' : 'show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', String(show));
  };
}

// `reveal` shows the burn "reveal once" action block; callers opt in explicitly
// rather than the function sniffing the message text (which broke on rewording).
function status(message, isError = false, { reveal = false } = {}) {
  showView('status');
  // Any status transition supersedes a running countdown; the reveal branch
  // restarts it explicitly. Prevents a stale timer ticking under a later screen.
  stopExpiryTimer();
  const el = $('#status-msg');
  el.textContent = message;
  el.classList.toggle('error', isError);
  // Error states get a warning glyph + a "Create new paste" action, like the
  // reference expired screen. The burn "reveal once" prompt keeps its own action.
  const ico = $('#status-ico');
  if (ico) ico.hidden = !isError;
  const actions = $('#status-actions');
  if (actions) actions.hidden = !reveal;
  const newActions = $('#status-new');
  if (newActions) newActions.hidden = !isError;
}

// ── self-destruct countdown ──────────────────────────────────────────────────
// Shown on the burn "reveal once" screen: how long until the note auto-expires.
// Purely informational — the authoritative expiry is the DO alarm server-side;
// this is derived from the non-secret meta (created + expire) in the peeked head.
// `expiryTimer` itself is declared near the top of the module (see the boot
// section) so it is initialized before `status()` can reference it.

function stopExpiryTimer() {
  if (expiryTimer !== null) { clearInterval(expiryTimer); expiryTimer = null; }
  const box = $('#status-timer');
  if (box) { box.hidden = true; box.classList.remove('ending'); }
}

// `meta.created` (unix seconds) is set by the server on create and echoed in the
// peek response; `expire` maps to a fixed TTL. A note with no expiry (never) or
// missing created gets no timer rather than a bogus one. `onExpire` fires once
// when the countdown reaches zero (possibly synchronously, if already past).
function startExpiryTimer(meta, onExpire) {
  const box = $('#status-timer');
  const clock = $('#status-timer-clock');
  if (!box || !clock || !meta) return;
  const ttl = EXPIRE_SECONDS[meta.expire] ?? 0;
  if (ttl <= 0 || !Number.isInteger(meta.created)) return;

  const expireAt = (meta.created + ttl) * 1000;
  let expired = false;
  const render = () => {
    const left = Math.max(0, expireAt - Date.now());
    clock.textContent = formatDuration(left);
    // Pulse under ten minutes — a quiet "hurry" cue without shouting.
    box.classList.toggle('ending', left > 0 && left <= 600000);
    if (left <= 0) {
      expired = true;
      if (expiryTimer !== null) { clearInterval(expiryTimer); expiryTimer = null; }
      box.classList.remove('ending');
      if (onExpire) onExpire();
    }
  };
  box.hidden = false;
  render();
  if (!expired) expiryTimer = setInterval(render, 1000);
}

// ms → H:MM:SS (or MM:SS under an hour). Clamps at 0 (shows "expired").
function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  if (total <= 0) return 'expired';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function showMsg(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function friendlyError(e) {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'Too many pastes from your network — please wait a moment.';
    if (e.status === 413) return 'That document is too large.';
    return e.message || 'Server error. Please try again.';
  }
  if (e && /too large/.test(e.message || '')) return 'That document is too large (1 MiB max).';
  return 'Something went wrong. Please try again.';
}
