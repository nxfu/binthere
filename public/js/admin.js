// admin.js — owner link management page (custom fork).
//
// Talks to /api/admin/list + /api/admin/revoke + /api/admin/note with the
// owner's create token in the X-Create-Token header (same gate as
// creation). The token is kept in a module variable only — never
// localStorage/sessionStorage — so closing the tab forgets it. All server
// data (notes included) is rendered via textContent.

let token = '';

const form = document.getElementById('admin-auth');
const tokenInput = document.getElementById('admin-token');
const statusEl = document.getElementById('admin-status');
const tableWrap = document.getElementById('admin-table-wrap');
const rowsEl = document.getElementById('admin-rows');

function setStatus(text) {
  statusEl.textContent = text;
}

function fmtTime(sec) {
  if (!Number.isInteger(sec) || sec <= 0) return '—';
  return new Date(sec * 1000).toLocaleString();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: { ...(options.headers || {}), 'x-create-token': token },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || `Request failed (${res.status}).`;
    throw new Error(msg);
  }
  return data;
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

// Owner label cell: plain-text note + inline editor. The note is owner
// input echoed back by the server, so it is rendered ONLY via textContent
// (never innerHTML) — a note like "<img onerror=…>" must stay inert text.
function noteCell(p) {
  const td = document.createElement('td');
  td.className = 'admin-note';
  const show = () => {
    td.replaceChildren();
    const span = document.createElement('span');
    span.className = p.note ? 'admin-note-text' : 'admin-note-empty';
    span.textContent = p.note || '—';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn admin-note-edit';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => editNote());
    td.append(span, edit);
  };
  const editNote = () => {
    td.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 100;
    input.value = p.note || '';
    input.className = 'admin-note-input';
    input.setAttribute('aria-label', `Note for link ${p.id}`);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', show);
    save.addEventListener('click', async () => {
      save.disabled = true;
      cancel.disabled = true;
      try {
        const data = await api('/api/admin/note', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: p.id, note: input.value }),
        });
        p.note = typeof data.note === 'string' ? data.note : input.value.trim().slice(0, 100);
        show();
        setStatus('Note saved.');
      } catch (e) {
        save.disabled = false;
        cancel.disabled = false;
        setStatus(e.message || 'Could not save the note.');
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') show();
    });
    td.append(input, save, cancel);
    input.focus();
    input.select();
  };
  show();
  return td;
}

function render(pastes) {
  rowsEl.replaceChildren();
  for (const p of pastes) {
    const tr = document.createElement('tr');
    tr.append(cell(p.id, 'mono admin-id'));
    tr.append(noteCell(p));
    tr.append(cell(fmtTime(p.createdAt)));
    tr.append(cell(fmtTime(p.expiresAt)));
    tr.append(cell(`${p.viewsLeft} / ${p.viewsTotal}`));
    tr.append(cell(p.gone ? 'gone' : 'active', p.gone ? 'admin-gone' : 'admin-active'));
    const action = document.createElement('td');
    if (!p.gone) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn danger';
      btn.textContent = 'Revoke';
      btn.addEventListener('click', () => revoke(p.id, btn));
      action.append(btn);
    }
    tr.append(action);
    rowsEl.append(tr);
  }
  tableWrap.hidden = pastes.length === 0;
  setStatus(pastes.length === 0 ? 'No links yet.' : `${pastes.length} link(s).`);
}

async function load() {
  setStatus('Loading…');
  try {
    const pastes = await api('/api/admin/list');
    if (!Array.isArray(pastes)) throw new Error('Malformed response.');
    render(pastes);
  } catch (e) {
    tableWrap.hidden = true;
    setStatus(e.message || 'Could not load links.');
  }
}

async function revoke(id, btn) {
  if (!window.confirm(`Revoke link ${id}? This deletes it immediately.`)) return;
  btn.disabled = true;
  try {
    await api('/api/admin/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await load();
  } catch (e) {
    btn.disabled = false;
    setStatus(e.message || 'Revoke failed.');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  token = tokenInput.value;
  tokenInput.value = '';
  if (!token) {
    setStatus('Enter your create token first.');
    return;
  }
  load();
});
