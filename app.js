(() => {
  'use strict';

  if (window.__CARE_APP_INITIALIZED) return;
  window.__CARE_APP_INITIALIZED = true;

  // Fields edited directly in the form (tags are handled separately)
  const FIELDS = ['name', 'contact', 'notes'];
  const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  let sb = null;
  let people = [];
  let meetings = [];
  let meetingLogs = [];
  let meetingCancellations = [];
  let calendarReady = false;
  let editingId = null;
  let occurrenceMeeting = null;
  let occurrenceDate = null;
  let userEmail = '';
  let logs = {};        // person_id -> [{id, note_date, body}] newest first
  let draftLogs = [];   // log entries being edited in the open dialog
  let draftTags = [];   // tags being edited in the open dialog
  let keySeq = 0;
  let calendarWeekStart;
  let calendarView = 'week';

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

  // ---------- Calendar dates ----------
  const DAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  function dateFromString(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function dateToString(date) {
    return date.toISOString().slice(0, 10);
  }

  function weekStart(value) {
    const date = dateFromString(value);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    return dateToString(date);
  }

  function addDays(value, amount) {
    const date = dateFromString(value);
    date.setUTCDate(date.getUTCDate() + amount);
    return dateToString(date);
  }

  function occurrencesInWeek(meeting, start) {
    const results = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(start, offset);
      if (date < meeting.start_date) continue;
      const dayIndex = (dateFromString(date).getUTCDay() + 6) % 7;
      if (dayIndex !== DAY_INDEX[meeting.meeting_day]) continue;

      const startWeek = dateFromString(weekStart(meeting.start_date));
      const eventWeek = dateFromString(weekStart(date));
      const weeksApart = Math.round((eventWeek - startWeek) / 604800000);
      if (meeting.frequency === 'Every 2 weeks' && weeksApart % 2 !== 0) continue;
      if (meeting.frequency === 'Monthly') {
        const startDate = dateFromString(meeting.start_date);
        const eventDate = dateFromString(date);
        const ordinal = Math.floor((startDate.getUTCDate() - 1) / 7);
        const eventOrdinal = Math.floor((eventDate.getUTCDate() - 1) / 7);
        const lastWeekdayOfMonth = addDays(date, 7).slice(0, 7) !== date.slice(0, 7);
        if (eventOrdinal !== ordinal && !(ordinal === 4 && eventOrdinal === 3 && lastWeekdayOfMonth)) continue;
      }
      results.push(date);
    }
    return results;
  }

  function getPersonMeetings(personId) {
    return meetings.filter((meeting) => meeting.person_id === personId);
  }

  function hasMeeting(person) {
    return getPersonMeetings(person.id).length > 0;
  }

  function meetingStatus(p) {
    const count = getPersonMeetings(p.id).length;
    return count ? `${count} recurring ${count === 1 ? 'meeting' : 'meetings'}` : '';
  }

  function meetingDescription(meeting) {
    return [
      meeting.title,
      meeting.meeting_day,
      fmtTime(meeting.meeting_time),
      meeting.frequency
    ].filter(Boolean).join(' · ');
  }

  function personName(personId) {
    return people.find((person) => person.id === personId)?.name || 'Unknown person';
  }

  function isCancelled(meetingId, date) {
    return meetingCancellations.some((item) =>
      item.meeting_id === meetingId && item.occurrence_date === date);
  }

  // ---------- Tags ----------
  const cleanTag = (s) => String(s).trim().replace(/\s+/g, ' ').slice(0, 40);
  function parseTags(s) {
    return String(s || '').split(/[;,]/).map(cleanTag).filter(Boolean);
  }
  function addTag(t) {
    t = cleanTag(t);
    if (!t) return;
    if (!draftTags.some((x) => x.toLowerCase() === t.toLowerCase())) draftTags.push(t);
    renderTagChips();
  }
  function renderTagChips() {
    $('tagChips').innerHTML = draftTags.map((t, i) =>
      `<span class="chip">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('');
  }
  function allTags() {
    const seen = new Map();
    people.forEach((p) => (p.tags || []).forEach((t) => { if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); }));
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  function commitTagInput() {
    const inp = $('tagInput');
    parseTags(inp.value).forEach(addTag);
    inp.value = '';
  }

  // ---------- Data ----------
  function normalize(row) {
    const p = { ...row };
    FIELDS.forEach((f) => { if (p[f] == null) p[f] = ''; });
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    return p;
  }

  async function loadPeople() {
    const [pr, lr, mr, mlr, mcr] = await Promise.all([
      sb.from('people').select('*').order('name'),
      sb.from('person_logs').select('*')
        .order('note_date', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('person_meetings').select('*').order('meeting_time'),
      sb.from('meeting_logs').select('*')
        .order('occurrence_date', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('meeting_cancellations').select('*')
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
    calendarReady = !mr.error && !mlr.error && !mcr.error;
    if (!calendarReady) {
      const error = mr.error || mlr.error || mcr.error;
      banner('Calendar is not ready: ' + error.message +
        ' Run migration_calendar.sql in the Supabase SQL Editor, then reload.', 'err');
      meetings = [];
      meetingLogs = [];
      meetingCancellations = [];
    } else {
      meetings = mr.data.map((meeting) => ({
        ...meeting,
        meeting_time: String(meeting.meeting_time).slice(0, 5)
      }));
      meetingLogs = mlr.data;
      meetingCancellations = mcr.data;
    }
    render();
    renderCalendar();
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

  function buildPayload(raw, tags) {
    const out = {};
    FIELDS.forEach((f) => {
      let v = raw[f] == null ? '' : String(raw[f]);
      if (f !== 'notes') v = v.trim();
      out[f] = f === 'name' ? v : (v === '' ? null : v);
    });
    out.tags = tags;
    return out;
  }

  // ---------- CSV (backup / import) ----------
  const CSV_COLUMNS = [...FIELDS, 'tags'];

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

  const csvQ = (v) => {
    v = String(v ?? '');
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };

  function peopleCSV() {
    const lines = [CSV_COLUMNS.join(',')];
    people.forEach((p) => lines.push(CSV_COLUMNS.map((c) =>
      csvQ(c === 'tags' ? (p.tags || []).join('; ') : p[c])).join(',')));
    return lines.join('\n') + '\n';
  }

  function logsCSV() {
    const lines = ['person,date,entry,meeting'];
    people.forEach((p) => (logs[p.id] || []).forEach((l) => {
      lines.push([csvQ(p.name), csvQ(l.note_date), csvQ(l.body), ''].join(','));
    }));
    meetingLogs.forEach((log) => {
      const meeting = meetings.find((item) => item.id === log.meeting_id);
      if (meeting) lines.push([
        csvQ(personName(meeting.person_id)),
        csvQ(log.occurrence_date),
        csvQ(log.body),
        csvQ(meeting.title || meetingDescription(meeting))
      ].join(','));
    });
    return lines.join('\n') + '\n';
  }

  function meetingsCSV() {
    const lines = ['person,meeting,day,time,frequency,start_date'];
    meetings.forEach((meeting) => lines.push([
      csvQ(personName(meeting.person_id)),
      csvQ(meeting.title),
      csvQ(meeting.meeting_day),
      csvQ(meeting.meeting_time),
      csvQ(meeting.frequency),
      csvQ(meeting.start_date)
    ].join(',')));
    return lines.join('\n') + '\n';
  }

  function download(text, label) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `care-tracker-${label}-${todayStr()}.csv`;
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
    const imported = rows.slice(1).map((r) => {
      const o = {};
      CSV_COLUMNS.forEach((f) => { const i = header.indexOf(f); o[f] = i >= 0 ? (r[i] ?? '') : ''; });
      const readLegacyField = (field) => {
        const index = header.indexOf(field);
        return index >= 0 ? (r[index] || '').trim() : '';
      };
      return {
        person: buildPayload(o, parseTags(o.tags)),
        meeting: {
          meeting_day: readLegacyField('meeting_day'),
          meeting_time: readLegacyField('meeting_time'),
          frequency: readLegacyField('frequency')
        }
      };
    }).filter((record) => record.person.name);
    if (!imported.length) { banner('No valid rows found.', 'err'); return; }
    if (!confirm(`Import ${imported.length} ${imported.length === 1 ? 'person' : 'people'}? They will be added to the existing list.`)) return;
    const { data, error } = await sb.from('people').insert(imported.map((record) => record.person)).select();
    if (error) { banner('Import failed: ' + error.message, 'err'); return; }
    const importedMeetings = imported.flatMap((record, index) => {
      const { meeting_day, meeting_time, frequency } = record.meeting;
      if (!DAYS.slice(1).includes(meeting_day) || !meeting_time || !data[index]) return [];
      return [{
        person_id: data[index].id,
        title: 'Recurring meeting',
        meeting_day,
        meeting_time,
        frequency: ['Weekly', 'Every 2 weeks', 'Monthly'].includes(frequency) ? frequency : 'Weekly',
        start_date: todayStr()
      }];
    });
    if (importedMeetings.length) {
      const { error: meetingError } = await sb.from('person_meetings').insert(importedMeetings);
      if (meetingError) {
        await loadPeople();
        banner('People were imported, but recurring meetings could not be imported: ' + meetingError.message, 'err');
        return;
      }
    }
    banner(`Imported ${imported.length}.`, 'ok');
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
    const hay = [p.name, p.contact, p.notes, meetingStatus(p), (p.tags || []).join(' ')]
      .concat((logs[p.id] || []).map((l) => l.note_date + ' ' + l.body))
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function refreshFilter() {
    const sel = $('filterBy');
    const prev = sel.value;
    const tags = allTags();
    sel.innerHTML = '<option value="">All people</option>' +
      '<option value="meeting">Has recurring meeting</option>' +
      '<option value="nomeeting">No recurring meeting</option>' +
      (tags.length ? '<optgroup label="Tags">' + tags.map((t) => `<option value="tag:${esc(t)}">${esc(t)}</option>`).join('') + '</optgroup>' : '');
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
    $('tagSuggestions').innerHTML = tags.map((t) => `<option value="${esc(t)}">`).join('');
  }

  function passesFilter(p, f) {
    if (!f) return true;
    if (f === 'meeting') return hasMeeting(p);
    if (f === 'nomeeting') return !hasMeeting(p);
    if (f.startsWith('tag:')) {
      const t = f.slice(4).toLowerCase();
      return (p.tags || []).some((x) => x.toLowerCase() === t);
    }
    return true;
  }

  function render() {
    refreshFilter();
    const q = $('search').value.trim();
    const f = $('filterBy').value;
    const sort = $('sortBy').value;

    const list = people.filter((p) => matches(p, q) && passesFilter(p, f));
    list.sort((a, b) => {
      if (sort === 'updated') return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    $('count').textContent = `${list.length} of ${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    if (!list.length) {
      $('list').innerHTML = `<div class="empty">${people.length ? 'No matches.' : 'No one added yet. Press “+ Add person” to start.'}</div>`;
      return;
    }

    $('list').innerHTML = list.map((p) => {
      const status = meetingStatus(p);
      return `<div class="card" data-id="${esc(p.id)}">
        <div class="row1"><span class="name">${esc(p.name)}</span>${status ? `<span class="badge Meeting">${esc(status)}</span>` : ''}</div>
        ${p.tags.length ? `<div class="chips">${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        ${p.contact ? `<div class="meta">${esc(p.contact)}</div>` : ''}
        ${latestLogHtml(p)}
        ${p.notes ? `<div class="notes gen">${esc(snip(p.notes))}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderCalendar() {
    if (!calendarReady) {
      $('weekSchedule').innerHTML = '<div class="empty">Run the calendar migration to enable the schedule.</div>';
      $('meetingLogDetails').innerHTML = '<div class="empty">Run the calendar migration to enable meeting logs.</div>';
      return;
    }

    const weekDates = Array.from({ length: 7 }, (_, index) => addDays(calendarWeekStart, index));
    $('weekLabel').textContent = `${fmtDate(weekDates[0])} – ${fmtDate(weekDates[6])}`;
    const events = weekDates.map((date) => {
      const eventMeetings = meetings
        .filter((meeting) => occurrencesInWeek(meeting, calendarWeekStart).includes(date))
        .sort((a, b) => a.meeting_time.localeCompare(b.meeting_time));
      const activeMeetings = eventMeetings.filter((meeting) => !isCancelled(meeting.id, date));
      const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' })
        .format(dateFromString(date));
      return `<section class="calendar-day">
        <h2>${esc(dayName)} <span>${esc(fmtDate(date))}</span></h2>
        ${activeMeetings.length ? activeMeetings.map((meeting) => {
          const entryCount = meetingLogs.filter((log) =>
            log.meeting_id === meeting.id && log.occurrence_date === date).length;
          return `<article class="calendar-event">
            <button type="button" class="calendar-event-open" data-meeting-id="${esc(meeting.id)}" data-date="${date}">
              <strong>${esc(fmtTime(meeting.meeting_time))}</strong>
              <span>${esc(personName(meeting.person_id))}${meeting.title ? ` · ${esc(meeting.title)}` : ''}</span>
              <small>${entryCount ? `${entryCount} ${entryCount === 1 ? 'log' : 'logs'}` : 'No logs yet'}</small>
            </button>
            <button type="button" class="calendar-cancel" data-action="cancel" data-meeting-id="${esc(meeting.id)}" data-date="${date}" aria-label="Cancel this meeting">Cancel date</button>
          </article>`;
        }).join('') : '<p class="empty-day">No meetings</p>'}
      </section>`;
    }).join('');
    $('weekSchedule').innerHTML = `<div class="week-grid">${events}</div>`;

    const cancelled = meetingCancellations
      .filter((item) => item.occurrence_date >= weekDates[0] && item.occurrence_date <= weekDates[6])
      .sort((a, b) => a.occurrence_date.localeCompare(b.occurrence_date));
    if (cancelled.length) {
      $('weekSchedule').insertAdjacentHTML('beforeend', `<section class="cancelled-list">
        <h2>Cancelled this week</h2>
        ${cancelled.map((item) => {
          const meeting = meetings.find((candidate) => candidate.id === item.meeting_id);
          if (!meeting) return '';
          return `<div class="cancelled-event">
            <span>${esc(fmtDate(item.occurrence_date))} · ${esc(personName(meeting.person_id))} · ${esc(fmtTime(meeting.meeting_time))}${meeting.title ? ` · ${esc(meeting.title)}` : ''}</span>
            <button type="button" data-action="restore" data-meeting-id="${esc(meeting.id)}" data-date="${esc(item.occurrence_date)}">Restore</button>
          </div>`;
        }).join('')}
      </section>`);
    }

    const orderedLogs = [...meetingLogs].sort((a, b) =>
      b.occurrence_date.localeCompare(a.occurrence_date) ||
      b.created_at.localeCompare(a.created_at));
    $('meetingLogDetails').innerHTML = orderedLogs.length
      ? `<div class="grid">${orderedLogs.map((log) => {
        const meeting = meetings.find((candidate) => candidate.id === log.meeting_id);
        if (!meeting) return '';
        return `<article class="card meeting-log-card">
          <div class="row1">
            <strong>${esc(personName(meeting.person_id))}${meeting.title ? ` · ${esc(meeting.title)}` : ''}</strong>
            <span class="badge">${esc(fmtDate(log.occurrence_date))}</span>
          </div>
          <p class="meeting-log-body">${esc(log.body)}</p>
          <button type="button" data-action="open-log" data-meeting-id="${esc(meeting.id)}" data-date="${esc(log.occurrence_date)}">View meeting</button>
        </article>`;
      }).join('')}</div>`
      : '<div class="empty">No meeting logs yet. Open a meeting in the weekly schedule to add one.</div>';
  }

  function setCalendarView(view) {
    calendarView = view;
    const isWeek = view === 'week';
    $('weekSchedule').hidden = !isWeek;
    $('weekControls').hidden = !isWeek;
    $('meetingLogDetails').hidden = isWeek;
    $('weekViewBtn').classList.toggle('primary', isWeek);
    $('detailsViewBtn').classList.toggle('primary', !isWeek);
    $('weekViewBtn').setAttribute('aria-current', isWeek ? 'page' : 'false');
    $('detailsViewBtn').setAttribute('aria-current', isWeek ? 'false' : 'page');
  }

  function setMainView(view) {
    const peopleSelected = view === 'people';
    $('peopleView').hidden = !peopleSelected;
    $('calendarView').hidden = peopleSelected;
    $('peopleControls').hidden = !peopleSelected;
    $('peopleViewBtn').classList.toggle('primary', peopleSelected);
    $('calendarViewBtn').classList.toggle('primary', !peopleSelected);
    $('peopleViewBtn').setAttribute('aria-current', peopleSelected ? 'page' : 'false');
    $('calendarViewBtn').setAttribute('aria-current', peopleSelected ? 'false' : 'page');
  }

  function renderPersonMeetings(personId) {
    const personMeetings = getPersonMeetings(personId);
    $('personMeetings').innerHTML = personMeetings.length
      ? `<div class="grid">${personMeetings.map((meeting) => `<div class="person-meeting">
          <div><strong>${esc(meeting.title || 'Recurring meeting')}</strong>
            <small>${esc(meeting.meeting_day)} · ${esc(fmtTime(meeting.meeting_time))} · ${esc(meeting.frequency)}</small></div>
          <button type="button" data-action="edit-meeting" data-meeting-id="${esc(meeting.id)}">Edit</button>
        </div>`).join('')}</div>`
      : '<p class="nolog">No recurring meetings added.</p>';
  }

  function openMeeting(meetingId, personId) {
    const form = $('meetingForm');
    const meeting = meetingId ? meetings.find((item) => item.id === meetingId) : null;
    const selectedPersonId = personId || (meeting ? meeting.person_id : '');
    form.reset();
    form.elements.id.value = meeting ? meeting.id : '';
    form.elements.person_id.innerHTML = '<option value="">Choose a person</option>' +
      people.map((person) => `<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('');
    form.elements.person_id.value = selectedPersonId;
    fillSelect($('meetingDay'), DAYS, meeting ? meeting.meeting_day : '');
    form.elements.title.value = meeting ? meeting.title : '';
    form.elements.meeting_time.value = meeting ? meeting.meeting_time : '';
    form.elements.frequency.value = meeting ? meeting.frequency : 'Weekly';
    form.elements.start_date.value = meeting ? meeting.start_date : todayStr();
    $('meetingDlgTitle').textContent = meeting ? 'Edit recurring meeting' : 'Add recurring meeting';
    $('deleteMeetingBtn').hidden = !meeting;
    $('meetingDlg').showModal();
  }

  function openOccurrence(meetingId, date) {
    const meeting = meetings.find((item) => item.id === meetingId);
    if (!meeting) return;
    occurrenceMeeting = meeting;
    occurrenceDate = date;
    $('occurrenceTitle').textContent =
      `${personName(meeting.person_id)}${meeting.title ? ` · ${meeting.title}` : ''} — ${fmtDate(date)}`;
    renderOccurrenceLogs();
    $('occurrenceForm').elements.body.value = '';
    $('occurrenceDlg').showModal();
  }

  function renderOccurrenceLogs() {
    const entries = meetingLogs
      .filter((log) => log.meeting_id === occurrenceMeeting.id && log.occurrence_date === occurrenceDate)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    $('occurrenceLogs').innerHTML = entries.length
      ? `<div class="occurrence-log-list">${entries.map((log) => `<article class="logentry">
          <small>${esc(new Date(log.created_at).toLocaleString())}</small>
          <div class="meeting-log-body">${esc(log.body)}</div>
        </article>`).join('')}</div>`
      : '<p class="nolog">No logs for this meeting yet.</p>';
  }

  async function submitMeeting(e) {
    e.preventDefault();
    const form = e.target;
    const payload = {
      person_id: form.elements.person_id.value,
      title: form.elements.title.value.trim(),
      meeting_day: form.elements.meeting_day.value,
      meeting_time: form.elements.meeting_time.value,
      frequency: form.elements.frequency.value,
      start_date: form.elements.start_date.value
    };
    const id = form.elements.id.value;
    const button = $('saveMeetingBtn');
    button.disabled = true;
    try {
      const query = id
        ? sb.from('person_meetings').update(payload).eq('id', id)
        : sb.from('person_meetings').insert(payload);
      const { error } = await query;
      if (error) throw error;
      $('meetingDlg').close();
      await loadPeople();
      if (editingId) renderPersonMeetings(editingId);
      if (calendarReady) banner('Meeting saved.', 'ok');
    } catch (error) {
      banner('Could not save meeting: ' + (error.message || error), 'err');
    } finally {
      button.disabled = false;
    }
  }

  async function deleteMeeting() {
    const id = $('meetingForm').elements.id.value;
    const meeting = meetings.find((item) => item.id === id);
    if (!meeting || !confirm('Delete this recurring meeting and its meeting logs?')) return;
    const { error } = await sb.from('person_meetings').delete().eq('id', id);
    if (error) {
      banner('Could not delete meeting: ' + error.message, 'err');
      return;
    }
    $('meetingDlg').close();
    await loadPeople();
    if (editingId) renderPersonMeetings(editingId);
  }

  async function submitOccurrence(e) {
    e.preventDefault();
    if (!occurrenceMeeting || !occurrenceDate) return;
    const form = e.target;
    const body = form.elements.body.value.trim();
    if (!body) return;
    const button = $('saveOccurrenceBtn');
    button.disabled = true;
    try {
      const { data, error } = await sb.from('meeting_logs').insert({
        meeting_id: occurrenceMeeting.id,
        occurrence_date: occurrenceDate,
        body
      }).select().single();
      if (error) throw error;
      meetingLogs.unshift(data);
      form.elements.body.value = '';
      renderCalendar();
      renderOccurrenceLogs();
      banner('Meeting log added.', 'ok');
    } catch (error) {
      banner('Could not add meeting log: ' + (error.message || error), 'err');
    } finally {
      button.disabled = false;
    }
  }

  async function cancelOccurrence(meetingId, date) {
    if (!confirm(`Remove the ${fmtDate(date)} meeting from the schedule?`)) return;
    const { error } = await sb.from('meeting_cancellations')
      .insert({ meeting_id: meetingId, occurrence_date: date });
    if (error) {
      banner('Could not cancel meeting: ' + error.message, 'err');
      return;
    }
    await loadPeople();
  }

  async function restoreOccurrence(meetingId, date) {
    const { error } = await sb.from('meeting_cancellations')
      .delete().eq('meeting_id', meetingId).eq('occurrence_date', date);
    if (error) {
      banner('Could not restore meeting: ' + error.message, 'err');
      return;
    }
    await loadPeople();
  }

  // ---------- Person dialog ----------
  function fillSelect(sel, options, current) {
    const opts = options.slice();
    if (current && !opts.includes(current)) opts.push(current); // keep older values that are no longer in the list
    sel.innerHTML = opts.map((o) => `<option value="${esc(o)}">${esc(o || '—')}</option>`).join('');
    sel.value = current || '';
  }

  function openPerson(id) {
    editingId = id || null;
    const form = $('personForm');
    const p = id ? people.find((x) => x.id === id) : null;
    $('dlgTitle').textContent = p ? 'Edit ' + p.name : 'Add person';
    $('deleteBtn').hidden = !p;
    FIELDS.forEach((f) => { form.elements[f].value = p ? (p[f] ?? '') : ''; });
    draftTags = p ? [...p.tags] : [];
    $('tagInput').value = '';
    renderTagChips();
    renderPersonMeetings(p ? p.id : '');
    $('addPersonMeetingBtn').disabled = !p;
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
    commitTagInput();
    const raw = {};
    FIELDS.forEach((f) => { raw[f] = form.elements[f].value; });
    const payload = buildPayload(raw, draftTags);
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
    meetings = meetings.filter((meeting) => meeting.person_id !== editingId);
    meetingLogs = meetingLogs.filter((log) => meetings.some((meeting) => meeting.id === log.meeting_id));
    meetingCancellations = meetingCancellations.filter((item) =>
      meetings.some((meeting) => meeting.id === item.meeting_id));
    delete logs[editingId];
    $('personDlg').close();
    render();
    renderCalendar();
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
    calendarWeekStart = weekStart(todayStr());
    const cfg = window.CARE_CONFIG || {};
    if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT') ||
        !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.startsWith('YOUR-')) {
      banner('Not configured yet: edit config.js with your Supabase project URL and anon key (see SETUP.md).', 'err');
      return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

    $('loginForm').addEventListener('submit', login);
    $('peopleViewBtn').addEventListener('click', () => setMainView('people'));
    $('calendarViewBtn').addEventListener('click', () => {
      setMainView('calendar');
      renderCalendar();
    });
    $('weekViewBtn').addEventListener('click', () => setCalendarView('week'));
    $('detailsViewBtn').addEventListener('click', () => setCalendarView('details'));
    $('prevWeekBtn').addEventListener('click', () => {
      calendarWeekStart = addDays(calendarWeekStart, -7);
      renderCalendar();
    });
    $('nextWeekBtn').addEventListener('click', () => {
      calendarWeekStart = addDays(calendarWeekStart, 7);
      renderCalendar();
    });
    $('todayWeekBtn').addEventListener('click', () => {
      calendarWeekStart = weekStart(todayStr());
      renderCalendar();
    });
    $('search').addEventListener('input', render);
    $('filterBy').addEventListener('change', render);
    $('sortBy').addEventListener('change', render);
    $('addBtn').addEventListener('click', () => openPerson(null));
    $('addMeetingBtn').addEventListener('click', () => {
      if (!people.length) {
        banner('Add a person before creating a recurring meeting.', 'err');
        return;
      }
      openMeeting(null, '');
    });
    $('list').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) openPerson(card.dataset.id);
    });
    $('personForm').addEventListener('submit', submitPerson);
    $('addPersonMeetingBtn').addEventListener('click', () => {
      if (editingId) openMeeting(null, editingId);
    });
    $('personMeetings').addEventListener('click', (e) => {
      const button = e.target.closest('[data-action="edit-meeting"]');
      if (button) openMeeting(button.dataset.meetingId);
    });
    $('cancelBtn').addEventListener('click', () => $('personDlg').close());
    $('deleteBtn').addEventListener('click', deletePerson);
    $('meetingForm').addEventListener('submit', submitMeeting);
    $('cancelMeetingBtn').addEventListener('click', () => $('meetingDlg').close());
    $('deleteMeetingBtn').addEventListener('click', deleteMeeting);
    $('occurrenceForm').addEventListener('submit', submitOccurrence);
    $('cancelOccurrenceBtn').addEventListener('click', () => $('occurrenceDlg').close());
    $('weekSchedule').addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (action) {
        const { meetingId, date } = action.dataset;
        if (action.dataset.action === 'cancel') cancelOccurrence(meetingId, date);
        else if (action.dataset.action === 'restore') restoreOccurrence(meetingId, date);
        return;
      }
      const button = e.target.closest('.calendar-event-open');
      if (button) openOccurrence(button.dataset.meetingId, button.dataset.date);
    });
    $('meetingLogDetails').addEventListener('click', (e) => {
      const button = e.target.closest('[data-action="open-log"]');
      if (button) openOccurrence(button.dataset.meetingId, button.dataset.date);
    });

    // tags
    const tagInput = $('tagInput');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTagInput(); }
      else if (e.key === 'Backspace' && !tagInput.value && draftTags.length) { draftTags.pop(); renderTagChips(); }
    });
    tagInput.addEventListener('change', commitTagInput);
    tagInput.addEventListener('blur', commitTagInput);
    $('tagChips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) { draftTags.splice(Number(b.dataset.i), 1); renderTagChips(); }
    });
    $('tagField').addEventListener('click', () => tagInput.focus());

    // logs
    $('addLogBtn').addEventListener('click', addDraftLog);
    $('logList').addEventListener('input', onLogInput);
    $('logList').addEventListener('click', onLogClick);

    // menu
    $('menuBtn').addEventListener('click', () => $('menuDlg').showModal());
    $('exportBtn').addEventListener('click', () => download(peopleCSV(), 'people'));
    $('exportMeetingsBtn').addEventListener('click', () => download(meetingsCSV(), 'meetings'));
    $('exportLogsBtn').addEventListener('click', () => download(logsCSV(), 'log-entries'));
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) { $('menuDlg').close(); await importCSV(file); }
    });
    $('pwBtn').addEventListener('click', changePassword);
    $('signOutBtn').addEventListener('click', async () => { $('menuDlg').close(); await sb.auth.signOut(); });

    setMainView('people');
    setCalendarView('week');

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
(() => {
  'use strict';

  if (window.__CARE_APP_INITIALIZED) return;
  window.__CARE_APP_INITIALIZED = true;

  // Fields edited directly in the form (tags are handled separately)
  const FIELDS = ['name', 'contact', 'notes', 'meeting_day', 'meeting_time', 'frequency'];
  const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const FREQS = ['', 'Weekly', 'Every 2 weeks', 'Monthly'];

  let sb = null;
  let people = [];
  let editingId = null;
  let userEmail = '';
  let logs = {};        // person_id -> [{id, note_date, body}] newest first
  let draftLogs = [];   // log entries being edited in the open dialog
  let draftTags = [];   // tags being edited in the open dialog
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

  // ---------- Recurring-meeting status (automatic) ----------
  const hasMeeting = (p) => !!(p.meeting_day || p.meeting_time || p.frequency);
  function meetingStatus(p) {
    if (!hasMeeting(p)) return '';
    return 'Meets ' + [p.meeting_day, fmtTime(p.meeting_time), p.frequency].filter(Boolean).join(' · ');
  }

  // ---------- Tags ----------
  const cleanTag = (s) => String(s).trim().replace(/\s+/g, ' ').slice(0, 40);
  function parseTags(s) {
    return String(s || '').split(/[;,]/).map(cleanTag).filter(Boolean);
  }
  function addTag(t) {
    t = cleanTag(t);
    if (!t) return;
    if (!draftTags.some((x) => x.toLowerCase() === t.toLowerCase())) draftTags.push(t);
    renderTagChips();
  }
  function renderTagChips() {
    $('tagChips').innerHTML = draftTags.map((t, i) =>
      `<span class="chip">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('');
  }
  function allTags() {
    const seen = new Map();
    people.forEach((p) => (p.tags || []).forEach((t) => { if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); }));
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  function commitTagInput() {
    const inp = $('tagInput');
    parseTags(inp.value).forEach(addTag);
    inp.value = '';
  }

  // ---------- Data ----------
  function normalize(row) {
    const p = { ...row };
    FIELDS.forEach((f) => { if (p[f] == null) p[f] = ''; });
    if (p.meeting_time) p.meeting_time = String(p.meeting_time).slice(0, 5);
    p.tags = Array.isArray(p.tags) ? p.tags : [];
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

  function buildPayload(raw, tags) {
    const out = {};
    FIELDS.forEach((f) => {
      let v = raw[f] == null ? '' : String(raw[f]);
      if (f !== 'notes') v = v.trim();
      out[f] = f === 'name' ? v : (v === '' ? null : v);
    });
    out.tags = tags;
    return out;
  }

  // ---------- CSV (backup / import) ----------
  const CSV_COLUMNS = [...FIELDS, 'tags'];

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

  const csvQ = (v) => {
    v = String(v ?? '');
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };

  function peopleCSV() {
    const lines = [CSV_COLUMNS.join(',')];
    people.forEach((p) => lines.push(CSV_COLUMNS.map((c) =>
      csvQ(c === 'tags' ? (p.tags || []).join('; ') : p[c])).join(',')));
    return lines.join('\n') + '\n';
  }

  function logsCSV() {
    const lines = ['person,date,entry'];
    people.forEach((p) => (logs[p.id] || []).forEach((l) => {
      lines.push([csvQ(p.name), csvQ(l.note_date), csvQ(l.body)].join(','));
    }));
    return lines.join('\n') + '\n';
  }

  function download(text, label) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `care-tracker-${label}-${todayStr()}.csv`;
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
      CSV_COLUMNS.forEach((f) => { const i = header.indexOf(f); o[f] = i >= 0 ? (r[i] ?? '') : ''; });
      return buildPayload(o, parseTags(o.tags));
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
    const hay = [p.name, p.contact, p.notes, meetingStatus(p), (p.tags || []).join(' ')]
      .concat((logs[p.id] || []).map((l) => l.note_date + ' ' + l.body))
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function refreshFilter() {
    const sel = $('filterBy');
    const prev = sel.value;
    const tags = allTags();
    sel.innerHTML = '<option value="">All people</option>' +
      '<option value="meeting">Has recurring meeting</option>' +
      '<option value="nomeeting">No recurring meeting</option>' +
      (tags.length ? '<optgroup label="Tags">' + tags.map((t) => `<option value="tag:${esc(t)}">${esc(t)}</option>`).join('') + '</optgroup>' : '');
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
    $('tagSuggestions').innerHTML = tags.map((t) => `<option value="${esc(t)}">`).join('');
  }

  function passesFilter(p, f) {
    if (!f) return true;
    if (f === 'meeting') return hasMeeting(p);
    if (f === 'nomeeting') return !hasMeeting(p);
    if (f.startsWith('tag:')) {
      const t = f.slice(4).toLowerCase();
      return (p.tags || []).some((x) => x.toLowerCase() === t);
    }
    return true;
  }

  function render() {
    refreshFilter();
    const q = $('search').value.trim();
    const f = $('filterBy').value;
    const sort = $('sortBy').value;

    const list = people.filter((p) => matches(p, q) && passesFilter(p, f));
    list.sort((a, b) => {
      if (sort === 'updated') return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    $('count').textContent = `${list.length} of ${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    if (!list.length) {
      $('list').innerHTML = `<div class="empty">${people.length ? 'No matches.' : 'No one added yet. Press “+ Add person” to start.'}</div>`;
      return;
    }

    $('list').innerHTML = list.map((p) => {
      const status = meetingStatus(p);
      return `<div class="card" data-id="${esc(p.id)}">
        <div class="row1"><span class="name">${esc(p.name)}</span>${status ? `<span class="badge Meeting">${esc(status)}</span>` : ''}</div>
        ${p.tags.length ? `<div class="chips">${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        ${p.contact ? `<div class="meta">${esc(p.contact)}</div>` : ''}
        ${latestLogHtml(p)}
        ${p.notes ? `<div class="notes gen">${esc(snip(p.notes))}</div>` : ''}
      </div>`;
    }).join('');
  }

  // ---------- Person dialog ----------
  function fillSelect(sel, options, current) {
    const opts = options.slice();
    if (current && !opts.includes(current)) opts.push(current); // keep older values that are no longer in the list
    sel.innerHTML = opts.map((o) => `<option value="${esc(o)}">${esc(o || '—')}</option>`).join('');
    sel.value = current || '';
  }

  function openPerson(id) {
    editingId = id || null;
    const form = $('personForm');
    const p = id ? people.find((x) => x.id === id) : null;
    $('dlgTitle').textContent = p ? 'Edit ' + p.name : 'Add person';
    $('deleteBtn').hidden = !p;
    FIELDS.forEach((f) => { form.elements[f].value = p ? (p[f] ?? '') : ''; });
    fillSelect(form.elements.meeting_day, DAYS, p ? p.meeting_day : '');
    fillSelect(form.elements.frequency, FREQS, p ? p.frequency : '');
    $('meetingBox').open = !!(p && hasMeeting(p));
    draftTags = p ? [...p.tags] : [];
    $('tagInput').value = '';
    renderTagChips();
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
    commitTagInput();
    const raw = {};
    FIELDS.forEach((f) => { raw[f] = form.elements[f].value; });
    const payload = buildPayload(raw, draftTags);
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

    $('loginForm').addEventListener('submit', login);
    $('search').addEventListener('input', render);
    $('filterBy').addEventListener('change', render);
    $('sortBy').addEventListener('change', render);
    $('addBtn').addEventListener('click', () => openPerson(null));
    $('list').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) openPerson(card.dataset.id);
    });
    $('personForm').addEventListener('submit', submitPerson);
    $('cancelBtn').addEventListener('click', () => $('personDlg').close());
    $('deleteBtn').addEventListener('click', deletePerson);

    // tags
    const tagInput = $('tagInput');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTagInput(); }
      else if (e.key === 'Backspace' && !tagInput.value && draftTags.length) { draftTags.pop(); renderTagChips(); }
    });
    tagInput.addEventListener('change', commitTagInput);
    tagInput.addEventListener('blur', commitTagInput);
    $('tagChips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) { draftTags.splice(Number(b.dataset.i), 1); renderTagChips(); }
    });
    $('tagField').addEventListener('click', () => tagInput.focus());

    // logs
    $('addLogBtn').addEventListener('click', addDraftLog);
    $('logList').addEventListener('input', onLogInput);
    $('logList').addEventListener('click', onLogClick);

    // menu
    $('menuBtn').addEventListener('click', () => $('menuDlg').showModal());
    $('exportBtn').addEventListener('click', () => download(peopleCSV(), 'people'));
    $('exportLogsBtn').addEventListener('click', () => download(logsCSV(), 'log-entries'));
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
