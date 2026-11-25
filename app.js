(() => {
  'use strict';

  const FIELDS = ['name', 'contact', 'status', 'meeting_day', 'meeting_time', 'frequency',
    'location', 'met_by', 'last_contact', 'next_followup', 'notes'];
  const DATE_FIELDS = ['last_contact', 'next_followup'];
  const STATUSES = ['New', 'Active', 'On hold', 'Inactive'];
  const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Varies'];
  const FREQS = ['', 'Weekly', 'Every 2 weeks', 'Monthly', 'As needed'];

  let sb = null;
  let people = [];
  let editingId = null;
  let userEmail = '';
  let logs = {};        // person_id -> [{id, note_date, body}] newest first
  let draftLogs = [];   // log entries being edited in the open dialog
  let keySeq = 0;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    if (isNaN(h)) return t;
    return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    if (!y) return d;
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function banner(msg, kind) {
    const b = $('banner');
    b.textContent = msg;
    b.className = 'show' + (kind ? ' ' + kind : '');
    if (kind === 'ok') setTimeout(() => { if (b.textContent === msg) b.className = ''; }, 4000);
  }
  const clearBanner = () => { $('banner').className = ''; };

  // ---------- Views ----------
  function showLogin() {
    $('appView').hidden = true;
    $('loginView').hidden = false;
    people = [];
  }
  async function showApp(session) {
    userEmail = session.user.email || '';
    $('loginView').hidden = true;
    $('appView').hidden = false;
    $('whoami').textContent = 'Signed in as ' + userEmail;
    await loadPeople();
  }

  // ---------- Data ----------
  function normalize(row) {
    const p = { ...row };
    FIELDS.forEach((f) => { if (p[f] == null) p[f] = ''; });
    if (p.meeting_time) p.meeting_time = String(p.meeting_time).slice(0, 5);
    return p;
  }

  async function loadPeople() {
    const [pr, lr] = await Promise.all([
      sb.from('people').select('*').order('name'),
      sb.from('person_logs').select('*')
        .order('note_date', { ascending: false }).order('created_at', { ascending: false })
    ]);
    if (pr.error) { banner('Could not load data: ' + pr.error.message, 'err'); return; }
    people = pr.data.map(normalize);
    logs = {};
    if (lr.error) {
      banner('Could not load log entries: ' + lr.error.message +
        ' (If you set this up earlier, run migration_log_entries.sql in the Supabase SQL Editor.)', 'err');
    } else {
      lr.data.forEach((l) => { (logs[l.person_id] = logs[l.person_id] || []).push(l); });
    }
    render();
  }

  async function syncLogs(personId) {
    const original = logs[personId] || [];
    const keep = draftLogs.filter((l) => l.body.trim());
    const keepIds = new Set(keep.filter((l) => l.id).map((l) => l.id));
    const removed = original.filter((o) => !keepIds.has(o.id)).map((o) => o.id);
    if (removed.length) {
      const { error } = await sb.from('person_logs').delete().in('id', removed);
      if (error) throw error;
    }
    for (const l of keep.filter((x) => x.id)) {
      const o = original.find((x) => x.id === l.id);
      if (o && (o.note_date !== l.note_date || o.body !== l.body)) {
        const { error } = await sb.from('person_logs')
          .update({ note_date: l.note_date || todayStr(), body: l.body }).eq('id', l.id);
        if (error) throw error;
      }
    }
    const added = keep.filter((l) => !l.id)
      .map((l) => ({ person_id: personId, note_date: l.note_date || todayStr(), body: l.body.trim() }));
    if (added.length) {
      const { error } = await sb.from('person_logs').insert(added);
      if (error) throw error;
    }
  }

  function toPayload(obj) {
    const out = {};
    FIELDS.forEach((f) => {
      let v = obj[f];
      v = v == null ? '' : String(v);
      if (f !== 'notes') v = v.trim();
      if (f === 'name' || f === 'status') out[f] = v || (f === 'status' ? 'New' : v);
      else out[f] = v === '' ? null : v;
    });
    return out;
  }

  // ---------- CSV (backup / import) ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  function toCSV(list) {
    const q = (v) => {
      v = String(v ?? '');
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = [FIELDS.join(',')];
    list.forEach((p) => lines.push(FIELDS.map((f) => q(p[f])).join(',')));
    return lines.join('\n') + '\n';
  }

  function exportLogsCSV() {
    const q = (v) => {
      v = String(v ?? '');
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = ['person,date,entry'];
    people.forEach((p) => (logs[p.id] || []).forEach((l) => {
      lines.push([q(p.name), q(l.note_date), q(l.body)].join(','));
    }));
    exportCSV(lines.join('\n') + '\n', 'log-entries');
  }

  function exportCSV(text, label) {
    const blob = new Blob([text || toCSV(people)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `care-tracker-${label || 'people'}-${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importCSV(file) {
    const rows = parseCSV(await file.text());
    if (rows.length < 2) { banner('That CSV has no rows to import.', 'err'); return; }
    const header = rows[0].map((h) => h.trim());
    if (!header.includes('name')) { banner('CSV must have a "name" column.', 'err'); return; }
    const records = rows.slice(1).map((r) => {
      const o = {};
      FIELDS.forEach((f) => { const i = header.indexOf(f); o[f] = i >= 0 ? (r[i] ?? '') : ''; });
      return toPayload(o);
    }).filter((o) => o.name);
    if (!records.length) { banner('No valid rows found.', 'err'); return; }
    if (!confirm(`Import ${records.length} ${records.length === 1 ? 'person' : 'people'}? They will be added to the existing list.`)) return;
    const { error } = await sb.from('people').insert(records);
    if (error) { banner('Import failed: ' + error.message, 'err'); return; }
    banner(`Imported ${records.length}.`, 'ok');
    await loadPeople();
  }

  // ---------- Render ----------
  const snip = (s) => (s.length > 200 ? s.slice(0, 200) + '…' : s);
  function latestLogHtml(p) {
    const entries = logs[p.id] || [];
    if (!entries.length) return '';
    const l = entries[0];
    const more = entries.length > 1 ? ` <span class="more">(+${entries.length - 1} earlier)</span>` : '';
    return `<div class="notes"><strong>${esc(fmtDate(l.note_date))}:</strong> ${esc(snip(l.body))}${more}</div>`;
  }

  function matches(p, q) {
    if (!q) return true;
    const hay = FIELDS.map((f) => p[f]).concat((logs[p.id] || []).map((l) => l.note_date + ' ' + l.body))
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function render() {
    const q = $('search').value.trim();
    const st = $('filterStatus').value;
    const sort = $('sortBy').value;

    const list = people.filter((p) => matches(p, q) && (!st || p.status === st));
    list.sort((a, b) => {
      if (sort === 'followup') {
        const x = a.next_followup || '9999', y = b.next_followup || '9999';
        return x.localeCompare(y) || a.name.localeCompare(b.name);
      }
      if (sort === 'updated') return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    $('count').textContent = `${list.length} of ${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    if (!list.length) {
      $('list').innerHTML = `<div class="empty">${people.length ? 'No matches.' : 'No one added yet. Press “+ Add person” to start.'}</div>`;
      return;
    }

    const today = todayStr();
    $('list').innerHTML = list.map((p) => {
      const sched = [p.meeting_day, fmtTime(p.meeting_time), p.frequency].filter(Boolean).join(' · ');
      const overdue = p.next_followup && p.next_followup < today && p.status !== 'Inactive';
      const bits = [];
      if (sched) bits.push(`<strong>Meeting:</strong> ${esc(sched)}`);
      if (p.location) bits.push(`<strong>Where:</strong> ${esc(p.location)}`);
      if (p.met_by) bits.push(`<strong>With:</strong> ${esc(p.met_by)}`);
      const dates = [];
      if (p.last_contact) dates.push(`Last contact ${esc(fmtDate(p.last_contact))}`);
      if (p.next_followup) dates.push(`<span class="${overdue ? 'overdue' : ''}">Follow up ${esc(fmtDate(p.next_followup))}${overdue ? ' (overdue)' : ''}</span>`);
      return `<div class="card" data-id="${esc(p.id)}">
        <div class="row1"><span class="name">${esc(p.name)}</span><span class="badge ${esc(p.status)}">${esc(p.status || 'No status')}</span></div>
        ${bits.length ? `<div class="meta">${bits.join(' &nbsp;|&nbsp; ')}</div>` : ''}
        ${dates.length ? `<div class="meta">${dates.join(' &nbsp;|&nbsp; ')}</div>` : ''}
        ${p.contact ? `<div class="meta">${esc(p.contact)}</div>` : ''}
        ${latestLogHtml(p)}
        ${p.notes ? `<div class="notes gen">${esc(snip(p.notes))}</div>` : ''}
      </div>`;
    }).join('');
  }

  // ---------- Person dialog ----------
  function fillSelect(sel, options, emptyLabel) {
    sel.innerHTML = options.map((o) => `<option value="${esc(o)}">${esc(o || emptyLabel || '—')}</option>`).join('');
  }

  function openPerson(id) {
    editingId = id || null;
    const form = $('personForm');
    const p = id ? people.find((x) => x.id === id) : null;
    $('dlgTitle').textContent = p ? 'Edit ' + p.name : 'Add person';
    $('deleteBtn').hidden = !p;
    FIELDS.forEach((f) => { form.elements[f].value = p ? (p[f] ?? '') : ''; });
    if (!p) form.elements.status.value = 'New';
    draftLogs = (p ? (logs[p.id] || []) : []).map((l) => ({ key: ++keySeq, id: l.id, note_date: l.note_date, body: l.body }));
    renderDraftLogs();
    $('personDlg').showModal();
    if (!p) form.elements.name.focus();
  }

  function renderDraftLogs() {
    const box = $('logList');
    if (!draftLogs.length) {
      box.innerHTML = '<div class="nolog">No entries yet. Add one to record a check-in, conversation or prayer update.</div>';
      return;
    }
    box.innerHTML = draftLogs.map((l) => `<div class="logentry" data-key="${l.key}">
      <div class="logentry-top">
        <input type="date" value="${esc(l.note_date)}" aria-label="Entry date" data-role="date">
        <button type="button" class="danger" data-role="remove">Remove</button>
      </div>
      <textarea data-role="body" aria-label="Entry text" placeholder="What happened, how they're doing, follow-ups…">${esc(l.body)}</textarea>
    </div>`).join('');
  }

  function addDraftLog() {
    draftLogs.unshift({ key: ++keySeq, id: null, note_date: todayStr(), body: '' });
    renderDraftLogs();
    const first = $('logList').querySelector('textarea');
    if (first) first.focus();
  }

  function onLogInput(e) {
    const row = e.target.closest('.logentry');
    if (!row) return;
    const l = draftLogs.find((x) => x.key === Number(row.dataset.key));
    if (!l) return;
    if (e.target.dataset.role === 'date') l.note_date = e.target.value;
    else if (e.target.dataset.role === 'body') l.body = e.target.value;
  }

  function onLogClick(e) {
    if (e.target.dataset.role !== 'remove') return;
    const row = e.target.closest('.logentry');
    const l = draftLogs.find((x) => x.key === Number(row.dataset.key));
    if (l && l.body.trim() && !confirm('Remove this entry? It is deleted when you press Save entry.')) return;
    draftLogs = draftLogs.filter((x) => x.key !== Number(row.dataset.key));
    renderDraftLogs();
  }

  async function submitPerson(e) {
    e.preventDefault();
    const form = e.target;
    const raw = {};
    FIELDS.forEach((f) => { raw[f] = form.elements[f].value; });
    const payload = toPayload(raw);
    const btn = $('savePersonBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const q = editingId
        ? sb.from('people').update(payload).eq('id', editingId)
        : sb.from('people').insert(payload);
      const { data, error } = await q.select().single();
      if (error) throw error;
      const row = normalize(data);
      const i = people.findIndex((x) => x.id === row.id);
      if (i >= 0) people[i] = row; else people.push(row);
      editingId = row.id; // so a retry after a log error updates instead of duplicating
      await syncLogs(row.id);
      await loadPeople();
      $('personDlg').close();
    } catch (err) {
      banner('Save failed: ' + (err.message || err), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save entry';
    }
  }

  async function deletePerson() {
    const p = people.find((x) => x.id === editingId);
    if (!p) return;
    if (!confirm(`Delete ${p.name}? This cannot be undone.`)) return;
    const { error } = await sb.from('people').delete().eq('id', editingId);
    if (error) { banner('Delete failed: ' + error.message, 'err'); return; }
    people = people.filter((x) => x.id !== editingId);
    delete logs[editingId];
    $('personDlg').close();
    render();
  }

  // ---------- Auth ----------
  async function login(e) {
    e.preventDefault();
    const f = e.target;
    const btn = $('loginBtn');
    btn.disabled = true;
    clearBanner();
    const { error } = await sb.auth.signInWithPassword({
      email: f.elements.email.value.trim(),
      password: f.elements.password.value
    });
    btn.disabled = false;
    if (error) banner(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message, 'err');
    else f.elements.password.value = '';
  }

  async function changePassword() {
    const pw = prompt('New password (at least 8 characters):');
    if (!pw) return;
    if (pw.length < 8) { banner('Password must be at least 8 characters.', 'err'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    $('menuDlg').close();
    if (error) banner(error.message, 'err'); else banner('Password changed.', 'ok');
  }

  // ---------- Init ----------
  function init() {
    const cfg = window.CARE_CONFIG || {};
    if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT') ||
        !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.startsWith('YOUR-')) {
      banner('Not configured yet: edit config.js with your Supabase project URL and anon key (see SETUP.md).', 'err');
      return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

    fillSelect($('filterStatus'), ['', ...STATUSES], 'All statuses');
    fillSelect($('personForm').elements.status, STATUSES);
    fillSelect($('personForm').elements.meeting_day, DAYS, '—');
    fillSelect($('personForm').elements.frequency, FREQS, '—');

    $('loginForm').addEventListener('submit', login);
    $('search').addEventListener('input', render);
    $('filterStatus').addEventListener('change', render);
    $('sortBy').addEventListener('change', render);
    $('addBtn').addEventListener('click', () => openPerson(null));
    $('list').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) openPerson(card.dataset.id);
    });
    $('personForm').addEventListener('submit', submitPerson);
    $('cancelBtn').addEventListener('click', () => $('personDlg').close());
    $('deleteBtn').addEventListener('click', deletePerson);

    $('menuBtn').addEventListener('click', () => $('menuDlg').showModal());
    $('exportBtn').addEventListener('click', () => exportCSV());
    $('exportLogsBtn').addEventListener('click', exportLogsCSV);
    $('addLogBtn').addEventListener('click', addDraftLog);
    $('logList').addEventListener('input', onLogInput);
    $('logList').addEventListener('click', onLogClick);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) { $('menuDlg').close(); await importCSV(file); }
    });
    $('pwBtn').addEventListener('click', changePassword);
    $('signOutBtn').addEventListener('click', async () => { $('menuDlg').close(); await sb.auth.signOut(); });

    sb.auth.onAuthStateChange((event, session) => {
      // Defer to avoid deadlocks inside the auth callback
      setTimeout(() => {
        if (session) {
          // Ignore token refreshes and tab-refocus sign-ins when already showing the app
          if (!$('appView').hidden && session.user.email === userEmail) return;
          clearBanner();
          showApp(session);
        } else showLogin();
      }, 0);
    });
  }

  init();
})();
