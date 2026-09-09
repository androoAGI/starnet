/* STARNET — schedpicker.js : the WHEN builder. A calendar-shaped way to say when a routine runs.

   THE PROBLEM IT REPLACES. CREATE ROUTINE asked for the schedule as one free-text field whose
   placeholder read "every 30m · 0 9 * * * · in 2h". Everything the backend can do was already there —
   sidecar/cron.js parses a full 5-field cron with a real timezone — but the only syntax a beginner
   could produce without documentation was an interval. So "every 2h / every 5h" is what people wrote,
   and "every Tuesday at 9am", which the scheduler has always supported, was effectively unreachable.

   THE SHAPE. Pick the CADENCE first (every day · certain days · monthly · on a timer · once · custom),
   then the details for that cadence — day chips, a day of the month, a clock. Never a syntax to learn.

   TWO RULES IT KEEPS.
     1. IT IS A TYPEWRITER, NOT A SCHEDULER. Every control writes a schedule STRING into the plain text
        input this widget owns (the same `#rt-sched` the form always posted) and dispatches `input`, so
        the existing server-math preview and the existing create/update paths run byte-identically. The
        picker never computes a fire time — /api/cron/preview stays the only thing that answers "when".
     2. CUSTOM IS NOT A FALLBACK, IT IS THE SAME FIELD. The CUSTOM pane simply REVEALS that text input,
        pre-filled with whatever the builder just wrote. Pick "certain days · Tue · 9:00 AM", switch to
        CUSTOM, and you are looking at `0 9 * * 2` — the power path is never removed, and the builder
        doubles as the way to learn the syntax.

   Pure-string work (build/parse/describe) lives in cronhuman.js so it can be node-tested; this file is
   the DOM half. Loads after cronhuman.js and before windows/routines.js (see index.html). */
'use strict';
(() => {
  if (typeof document === 'undefined') return;
  const CH = typeof CronHuman !== 'undefined' ? CronHuman : null;

  const MODES = [
    { id: 'daily', label: 'EVERY DAY' },
    { id: 'weekly', label: 'CERTAIN DAYS' },
    { id: 'monthly', label: 'MONTHLY' },
    { id: 'interval', label: 'ON A TIMER' },
    { id: 'once', label: 'ONCE' },
    { id: 'advanced', label: 'CUSTOM' }
  ];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => (n < 10 ? '0' : '') + n;

  // the browser's IANA zone, or '' when the runtime won't tell us. Only ever used to LABEL the clock —
  // and only when it resolves, because "your local time" is a claim the form must actually keep (the
  // create path posts this same zone with the routine, so a labelled schedule really does fire there).
  function deviceTz() {
    try { return (Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) { return ''; }
  }

  function optionsHTML(list, sel) {
    return list.map(o => '<option value="' + esc(o.v) + '"' + (String(o.v) === String(sel) ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('');
  }
  const hourOpts = () => Array.from({ length: 12 }, (_, i) => ({ v: i + 1, t: String(i + 1) }));
  const minOpts = () => Array.from({ length: 12 }, (_, i) => ({ v: i * 5, t: pad2(i * 5) }));
  const domOpts = () => Array.from({ length: 31 }, (_, i) => ({ v: i + 1, t: CH ? CH.ordinal(i + 1) : String(i + 1) }));

  /* the next 60 calendar days as YYYY-MM-DD (LOCAL dates, built off a real local Date so no UTC skew) —
     a date dropdown instead of a date field, because the picker's whole point is that nothing here has
     to be typed in a format. */
  function dateOpts(now) {
    const out = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const v = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      let t;
      if (i === 0) t = 'Today';
      else if (i === 1) t = 'Tomorrow';
      else { try { t = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (_) { t = v; } }
      out.push({ v: v, t: t });
    }
    return out;
  }

  /* html(opts) — the widget markup. opts.inputId names the text input the widget writes into (the
     ROUTINES form passes 'rt-sched' so every existing selector, test and QA journey keeps resolving).
     opts.hint overrides the CUSTOM-pane syntax line. */
  function html(opts) {
    opts = opts || {};
    const inputId = opts.inputId || '';
    const now = new Date();
    const tz = deviceTz();
    const dayChips = (CH ? CH.DAY_INITIAL : ['S', 'M', 'T', 'W', 'T', 'F', 'S']).map((ini, i) =>
      '<button type="button" class="sp-day" data-day="' + i + '" aria-pressed="false" aria-label="' +
      esc((CH ? CH.DAY_NAMES : [])[i] || 'day ' + i) + '"><span>' + esc(ini) + '</span></button>').join('');
    const timeRow =
      '<div class="sp-pane sp-time" data-show="daily weekly monthly once">' +
        '<span class="sp-lbl">at</span>' +
        '<select data-f="hour" aria-label="hour">' + optionsHTML(hourOpts(), 9) + '</select>' +
        '<span class="sp-colon">:</span>' +
        '<select data-f="minute" aria-label="minutes">' + optionsHTML(minOpts(), 0) + '</select>' +
        '<select data-f="ampm" aria-label="AM or PM">' + optionsHTML([{ v: 'AM', t: 'AM' }, { v: 'PM', t: 'PM' }], 'AM') + '</select>' +
        (tz ? '<span class="sp-tz">your time · ' + esc(tz) + '</span>' : '') +
      '</div>';
    return '<div class="sp" data-sp data-mode="daily">' +
      (opts.compact ? '<label class="sp-frequency">Repeat<select class="sp-mode-select" aria-label="Repeat">' +
        MODES.map(m => '<option value="' + m.id + '">' + esc(({ daily: 'Every day', weekly: 'Selected days', monthly: 'Every month', interval: 'Every few hours or minutes', once: 'Just once', advanced: 'Custom schedule' })[m.id]) + '</option>').join('') + '</select></label>' :
      '<div class="sp-modes" role="group" aria-label="how often it runs">' +
        MODES.map(m => '<button type="button" class="sp-mode' + (m.id === 'daily' ? ' active' : '') + '" data-mode="' +
          m.id + '" aria-pressed="' + (m.id === 'daily' ? 'true' : 'false') + '">' + esc(m.label) + '</button>').join('') +
      '</div>' ) +
      '<div class="sp-pane" data-show="weekly"><span class="sp-lbl">on</span><div class="sp-days">' + dayChips + '</div></div>' +
      '<div class="sp-pane" data-show="monthly"><span class="sp-lbl">on the</span>' +
        '<select data-f="dom" aria-label="day of the month">' + optionsHTML(domOpts(), 1) + '</select>' +
        '<span class="sp-lbl">of each month</span></div>' +
      '<div class="sp-pane" data-show="interval"><span class="sp-lbl">run every</span>' +
        '<input type="number" class="sp-num" data-f="every" min="1" max="999" step="1" value="2" aria-label="how often">' +
        // the UNIT is three visible keys, never a dropdown: "2" next to a closed select read as "every 2"
        // and the preview's "every 2 hours" surprised people (stranded-user sweep, 2026-08-22). A hidden
        // select still carries the value so f('unit') / setFromSpec keep one source of truth.
        '<div class="sp-units" role="group" aria-label="unit">' + [{ v: 'm', t: 'minutes' }, { v: 'h', t: 'hours' }, { v: 'd', t: 'days' }].map(u =>
          '<button type="button" class="sp-unit' + (u.v === 'h' ? ' on' : '') + '" data-unit="' + u.v + '" aria-pressed="' + (u.v === 'h' ? 'true' : 'false') + '">' + u.t + '</button>').join('') + '</div>' +
        '<select data-f="unit" aria-label="unit" hidden>' + optionsHTML([{ v: 'm', t: 'minutes' }, { v: 'h', t: 'hours' }, { v: 'd', t: 'days' }], 'h') + '</select></div>' +
      '<div class="sp-pane" data-show="once"><span class="sp-lbl">on</span>' +
        '<select data-f="date" aria-label="date">' + optionsHTML(dateOpts(now), dateOpts(now)[0].v) + '</select></div>' +
      timeRow +
      '<div class="sp-pane sp-adv" data-show="advanced">' +
        '<input' + (inputId ? ' id="' + esc(inputId) + '"' : '') + ' class="key-input" data-sp-input autocomplete="off" ' +
          'placeholder="every 30m · 0 9 * * 1-5 · in 2h · 2026-09-01T09:00">' +
        '<div class="sp-hint">' + esc(opts.hint || 'any schedule the scheduler understands: an interval ("every 30m"), a 5-field cron ("0 9 * * 1-5"), a delay ("in 2h") or an exact timestamp.') + '</div>' +
      '</div>' +
      '<div class="sp-note" data-sp-note hidden></div>' +
    '</div>';
  }

  /* mount(root, opts) — wire a rendered widget. Returns { value, set, focus, el }.
     opts.onChange(scheduleString) fires after every edit (the ROUTINES form uses it only for sound). */
  function mount(root, opts) {
    opts = opts || {};
    if (!root) return null;
    const el = root.matches && root.matches('[data-sp]') ? root : root.querySelector('[data-sp]');
    if (!el) return null;
    const input = el.querySelector('[data-sp-input]');
    const noteEl = el.querySelector('[data-sp-note]');
    const f = name => el.querySelector('[data-f="' + name + '"]');
    // WEEKLY seeds with TODAY's weekday: the overwhelmingly common "every Tuesday" is written by someone
    // who is thinking about it on a Tuesday, and an empty day row would be an error state on arrival.
    let days = [new Date().getDay()];
    let mode = 'daily';

    function hour24() {
      const h = parseInt(f('hour').value, 10) % 12;
      return f('ampm').value === 'PM' ? h + 12 : h;
    }
    // the UTC offset AT the selected instant, so a once-schedule crossing a DST boundary still means the
    // clock time the user picked (resolved from a real local Date — never a fixed "current" offset).
    function offsetMinutesFor(dateStr, h, m) {
      const p = String(dateStr || '').split('-');
      if (p.length !== 3) return null;
      const d = new Date(+p[0], +p[1] - 1, +p[2], h, m, 0, 0);
      return isNaN(d.getTime()) ? null : -d.getTimezoneOffset();
    }
    function spec() {
      const h = hour24(), m = parseInt(f('minute').value, 10) || 0;
      const date = f('date').value;
      return {
        mode: mode, hour: h, minute: m, days: days.slice(),
        dom: parseInt(f('dom').value, 10) || 1,
        every: parseInt(f('every').value, 10) || 0,
        unit: f('unit').value, date: date,
        offsetMinutes: offsetMinutesFor(date, h, m),
        raw: input ? input.value : ''
      };
    }

    /* The one honest-warning slot. Each note states a real consequence of the CURRENT selection — never a
       generic hint — because these are the three ways a picked schedule quietly does something other than
       what it looks like. */
    function note(sp) {
      if (mode === 'weekly' && !days.length) return { warn: true, text: 'pick at least one day — nothing is scheduled yet.' };
      if (mode === 'monthly' && sp.dom > 28) return { warn: true, text: 'months with fewer than ' + sp.dom + ' days skip this run — the ' + (CH ? CH.ordinal(sp.dom) : sp.dom) + ' does not exist in every month.' };
      if (mode === 'once') {
        const p = String(sp.date || '').split('-');
        if (p.length === 3) {
          const at = new Date(+p[0], +p[1] - 1, +p[2], sp.hour, sp.minute, 0, 0);
          if (at.getTime() <= Date.now()) return { warn: true, text: 'that time has already passed — this would run at the next scheduler tick.' };
        }
      }
      if (mode === 'interval' && sp.every > 0 && sp.unit === 'm' && sp.every < 5) return { warn: true, text: 'that is a lot of runs — each one spends tokens.' };
      return null;
    }

    // the ONLY output: write the built string into the text input and dispatch `input`, exactly as if it
    // had been typed. Everything downstream (server preview, POST /api/cron) is untouched by this widget.
    function emit(silent) {
      const sp = spec();
      const value = mode === 'advanced' ? (input ? input.value : '') : (CH ? CH.build(sp) : '');
      if (input && mode !== 'advanced' && input.value !== value) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const n = note(sp);
      if (noteEl) {
        noteEl.hidden = !n;
        noteEl.textContent = n ? n.text : '';
        noteEl.classList.toggle('warn', !!(n && n.warn));
      }
      if (!silent && typeof opts.onChange === 'function') opts.onChange(value, sp);
      return value;
    }

    function paint() {
      el.dataset.mode = mode;
      const frequency = el.querySelector('.sp-mode-select'); if (frequency) frequency.value = mode;
      el.querySelectorAll('.sp-mode').forEach(b => {
        const on = b.dataset.mode === mode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      el.querySelectorAll('.sp-pane').forEach(p => {
        p.classList.toggle('on', String(p.dataset.show || '').split(' ').indexOf(mode) >= 0);
      });
      el.querySelectorAll('.sp-day').forEach(b => {
        const on = days.indexOf(parseInt(b.dataset.day, 10)) >= 0;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const unitNow = f('unit') ? f('unit').value : 'h';
      el.querySelectorAll('.sp-unit').forEach(b => {
        const on = b.dataset.unit === unitNow;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    el.addEventListener('click', ev => {
      const mb = ev.target.closest('.sp-mode');
      if (mb) {
        mode = mb.dataset.mode || 'daily';
        paint();
        // switching INTO custom keeps whatever the builder last wrote (that is the graduation path);
        // switching out re-asserts the builder's own value over it.
        emit();
        if (mode === 'advanced' && input) input.focus();
        if (typeof opts.onPick === 'function') opts.onPick(mode);
        return;
      }
      const ub = ev.target.closest('.sp-unit');
      if (ub) { if (f('unit')) f('unit').value = ub.dataset.unit || 'h'; paint(); emit(); return; }
      const db = ev.target.closest('.sp-day');
      if (db) {
        const d = parseInt(db.dataset.day, 10);
        const i = days.indexOf(d);
        if (i >= 0) days.splice(i, 1); else days.push(d);
        paint(); emit();
      }
    });
    el.addEventListener('change', ev => {
      if (ev.target.matches('.sp-mode-select')) { mode = ev.target.value; paint(); emit(); if (mode === 'advanced' && input) input.focus(); return; }
      if (ev.target.closest('select, input[type=number]')) emit();
    });
    el.addEventListener('input', ev => { if (ev.target.closest('input[type=number]')) emit(); });

    /* set(scheduleString) — open the picker ON an existing schedule (the reschedule flow). Anything
       cronhuman can't model lands in CUSTOM holding the exact original string, so nothing is ever lost. */
    function set(scheduleString) {
      const sp = (CH ? CH.toSpec(scheduleString) : { mode: 'advanced', raw: scheduleString }) || {};
      mode = sp.mode || 'daily';
      if (sp.hour != null) {
        const h = sp.hour % 12;
        f('hour').value = String(h === 0 ? 12 : h);
        f('ampm').value = sp.hour < 12 ? 'AM' : 'PM';
        // the minute row is 5-minute granular; an odd minute (a cron someone hand-wrote) can't be shown
        // faithfully here, so that schedule stays in CUSTOM rather than being silently rounded.
        const m = sp.minute || 0;
        if (m % 5 === 0) f('minute').value = String(m); else mode = 'advanced';
      }
      if (Array.isArray(sp.days) && sp.days.length) days = sp.days.slice();
      if (sp.dom) f('dom').value = String(sp.dom);
      if (sp.every) f('every').value = String(sp.every);
      if (sp.unit) f('unit').value = sp.unit;
      // the input must hold a string the PARSER accepts, not the display verbatim. toSpec already did
      // the translation (a once-job's display "once at <iso>" becomes the bare iso in sp.raw); for the
      // builder modes the stripped display and the built string are byte-equal, so either works.
      if (input) input.value = mode === 'advanced' && sp.raw != null
        ? String(sp.raw)
        : String(scheduleString == null ? '' : scheduleString).replace(/^cron /, '');
      paint();
      emit(true);
      // always announce the seeded value, even when emit() found nothing to rewrite — the caller's
      // preview listener has to see SOMETHING or a freshly opened editor sits there with no "next fires".
      if (input) input.dispatchEvent(new Event('input', { bubbles: true }));
      return input ? input.value : '';
    }

    paint();
    emit(true);   // seed the input with the default schedule (every day, 9:00 AM) without a sound
    return {
      el: el, input: input,
      value: () => (input ? input.value : ''),
      set: set,
      mode: () => mode,
      refresh: () => emit(true)
    };
  }

  window.SchedPicker = { html: html, mount: mount, MODES: MODES };
})();
