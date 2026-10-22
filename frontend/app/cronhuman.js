/* AGENT OS — cronhuman.js : the pure schedule TRANSLATOR every routine surface speaks through.

   WHY THIS EXISTS. sidecar/cron.js is the authority on WHEN a routine fires, and it is deliberately
   terse about SAYING it: a cron schedule's own display string is literally `cron 0 9 * * 2`. That is
   a fine audit string and a terrible sentence — and until now the CREATE ROUTINE form asked a
   beginner to TYPE that syntax from scratch (the placeholder taught "every 30m · 0 9 * * * · in 2h",
   so the reachable-without-docs vocabulary collapsed to intervals: every 2h, every 5h). "Every
   Tuesday at 9am" was expressible and unreachable. This module is the two-way translation:

     build(spec)          — a picker's state  ->  a schedule string sidecar/cron.js already parses
     toSpec(schedule)     — a schedule string ->  picker state (so an existing routine opens correctly)
     describeDisplay(str) — cron.js's display ->  plain English ("every Tuesday at 9:00 AM")

   IT INVENTS NO SYNTAX. build() only ever emits the three forms the backend parser accepts — a
   5-field numeric cron, `every <N><m|h|d>`, or an absolute ISO instant — so a schedule that came out
   of the picker can never fail to parse server-side. The server stays the authority on the actual
   fire times; the picker never computes one.

   HONESTY RULE (this is the load-bearing one). describe* returns null for ANY expression shape it
   cannot state exactly — multi-time schedules, month restrictions, the cron day-of-month/day-of-week
   OR case — and every caller falls back to printing the raw expression. A label that GUESSES when a
   routine runs is strictly worse than a cryptic one: the panel's whole promise is that the station
   never claims a fire time it cannot prove.

   PURE + node-testable (no Date.now, no DOM, no clock reads): the browser gets a `CronHuman` global,
   node gets module.exports. Locked by test/cron-human.test.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CronHuman = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  function intOr(v, lo, hi, dflt) {
    const n = typeof v === 'number' ? Math.floor(v) : parseInt(String(v == null ? '' : v).trim(), 10);
    return (isFinite(n) && n >= lo && n <= hi) ? n : dflt;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 24h -> the wall-clock a human reads. 0 -> "12:00 AM", 12 -> "12:00 PM".
  function time12(h, m) {
    h = intOr(h, 0, 23, 0); m = intOr(m, 0, 59, 0);
    return (h % 12 === 0 ? 12 : h % 12) + ':' + pad2(m) + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function ordinal(n) {
    const v = n % 100, s = ['th', 'st', 'nd', 'rd'];
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  // 0..6, deduped and ascending. A cron dow of 7 means Sunday (cron.js: sevenAsSunday), so it folds to 0.
  function normDays(days) {
    const out = [];
    (Array.isArray(days) ? days : []).forEach(d => {
      let n = intOr(d, 0, 7, -1);
      if (n === 7) n = 0;
      if (n >= 0 && out.indexOf(n) < 0) out.push(n);
    });
    return out.sort((a, b) => a - b);
  }

  /* ============================== BUILD — picker state -> schedule string ==============================
     spec: { mode, hour, minute, days[], dom, every, unit, date, offsetMinutes, raw }
     Returns '' (never a fallback schedule) when the state is incomplete — an empty schedule reads as
     "not set yet" everywhere downstream, whereas quietly substituting a default would schedule work the
     user never asked for. */
  function build(spec) {
    spec = spec || {};
    const mode = String(spec.mode || 'daily');
    if (mode === 'advanced') return String(spec.raw == null ? '' : spec.raw).trim();
    const h = intOr(spec.hour, 0, 23, 9), m = intOr(spec.minute, 0, 59, 0);
    if (mode === 'daily') return m + ' ' + h + ' * * *';
    if (mode === 'weekly') {
      const days = normDays(spec.days);
      if (!days.length) return '';                        // no day picked yet — NOT a silent daily
      if (days.length === 7) return m + ' ' + h + ' * * *';
      return m + ' ' + h + ' * * ' + days.join(',');
    }
    if (mode === 'monthly') return m + ' ' + h + ' ' + intOr(spec.dom, 1, 31, 1) + ' * *';
    if (mode === 'interval') {
      const unit = /^[mhd]$/.test(String(spec.unit || '')) ? String(spec.unit) : 'h';
      const n = intOr(spec.every, 1, 9999, 0);
      return n ? ('every ' + n + unit) : '';
    }
    if (mode === 'once') {
      const date = String(spec.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
      return date + 'T' + pad2(h) + ':' + pad2(m) + ':00' + offsetSuffix(spec.offsetMinutes);
    }
    return '';
  }

  /* The caller's UTC offset AT the chosen instant, e.g. "-04:00" / "+05:30" / "Z" (minutes EAST of UTC).
     A once-schedule is an absolute instant, so this suffix is what makes "9:00 AM on Tuesday" mean the
     user's 9:00 — an offsetless ISO would be read against the SIDECAR HOST's clock, which is exactly the
     kind of silent timezone lie this panel exists not to tell. Null/NaN -> '' (host-local), which the
     picker never emits; it always resolves a real offset from a real local Date. */
  function offsetSuffix(offsetMinutes) {
    const n = Number(offsetMinutes);
    if (offsetMinutes == null || !isFinite(n)) return '';
    if (Math.round(n) === 0) return 'Z';
    const r = Math.round(n), a = Math.abs(r);
    return (r > 0 ? '+' : '-') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }

  /* ============================== DESCRIBE — schedule string -> English ============================== */

  /* One cron field -> { all:true, step } for a wildcard (`*` / `*` with a step) or { all:false, values:[…] }
     for an explicit set. null = a shape we refuse to describe (names, L/W/#, stepped ranges). Mirrors the
     subset sidecar/cron.js actually parses; anything richer falls back to the raw expression upstream. */
  function field(tok, lo, hi) {
    const s = String(tok == null ? '' : tok).trim();
    if (s === '*') return { all: true, step: 1 };
    let m = s.match(/^\*\/(\d+)$/);
    if (m) { const st = parseInt(m[1], 10); return st > 0 ? { all: true, step: st } : null; }
    const vals = [];
    for (const part of s.split(',')) {
      if (/^\d+$/.test(part)) {
        const n = parseInt(part, 10);
        if (n < lo || n > hi) return null;
        vals.push(n); continue;
      }
      const r = part.match(/^(\d+)-(\d+)$/);
      if (r) {
        const a = parseInt(r[1], 10), b = parseInt(r[2], 10);
        if (a < lo || b > hi || a > b) return null;
        for (let i = a; i <= b; i++) vals.push(i);
        continue;
      }
      return null;
    }
    if (!vals.length) return null;
    const uniq = vals.filter((v, i) => vals.indexOf(v) === i).sort((a, b) => a - b);
    return { all: false, values: uniq, step: 1 };
  }

  // "every Tuesday" / "every weekday" / "every Mon, Wed & Fri"
  function dayPhrase(days) {
    const d = normDays(days);
    if (!d.length || d.length === 7) return 'every day';
    if (d.join(',') === '1,2,3,4,5') return 'every weekday';
    if (d.join(',') === '0,6') return 'every weekend day';
    if (d.length === 1) return 'every ' + DAY_NAMES[d[0]];
    const names = d.map(x => DAY_ABBR[x]);
    return 'every ' + names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  }

  /* A 5-field cron expression -> plain English, or null when we can't say it exactly. */
  function describeExpr(expr) {
    const parts = String(expr == null ? '' : expr).trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const mi = field(parts[0], 0, 59), hr = field(parts[1], 0, 23),
      dom = field(parts[2], 1, 31), mon = field(parts[3], 1, 12), dow = field(parts[4], 0, 7);
    if (!mi || !hr || !dom || !mon || !dow) return null;
    if (!mon.all || mon.step !== 1) return null;          // month-restricted: rare, and we won't guess at it
    const domAll = dom.all && dom.step === 1, dowAll = dow.all && dow.step === 1;

    // sub-daily shapes: "every 15 minutes", "every 6 hours"
    if (mi.all && hr.all && domAll && dowAll) {
      if (hr.step > 1) return null;                       // "*/15 */6 * * *" — a burst pattern, not a cadence
      return mi.step > 1 ? ('every ' + mi.step + ' minutes') : 'every minute';
    }
    if (!mi.all && mi.values.length === 1 && hr.all && domAll && dowAll) {
      const at = mi.values[0] ? ' at :' + pad2(mi.values[0]) : '';
      return (hr.step > 1 ? 'every ' + hr.step + ' hours' : 'every hour') + at;
    }
    if (mi.all || hr.all) return null;                    // any other wildcard mix — say nothing rather than guess
    if (mi.values.length !== 1 || hr.values.length !== 1) return null;   // multi-time schedules: not ours to phrase

    const at = ' at ' + time12(hr.values[0], mi.values[0]);
    if (domAll && dowAll) return 'every day' + at;
    if (domAll) return dayPhrase(dow.values) + at;
    if (dowAll) return dom.values.length === 1 ? ('the ' + ordinal(dom.values[0]) + ' of every month' + at) : null;
    return null;   // BOTH day fields restricted = cron's OR semantics ("the 1st OR any Monday") — too subtle to phrase
  }

  // "30m" / "6h" / "1d" (the tail of cron.js's interval display) -> "every 30 minutes"
  function describeInterval(rest) {
    const m = String(rest == null ? '' : rest).trim().match(/^(\d+)([mhd])$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const word = m[2] === 'm' ? 'minute' : m[2] === 'h' ? 'hour' : 'day';
    return n === 1 ? ('every ' + word) : ('every ' + n + ' ' + word + 's');
  }

  // an absolute instant -> "once — Thu, Aug 14 at 9:00 AM". opts.tz renders it in a named zone (the
  // panel passes the browser's), absent = the runtime's own zone. Unparseable -> null (caller shows the raw).
  function describeOnce(iso, opts) {
    const t = Date.parse(String(iso || ''));
    if (isNaN(t)) return null;
    try {
      const locale = (opts && opts.locale) || 'en-US', tz = (opts && opts.tz) || undefined;
      // date and time formatted separately and joined with "at" — one combined format renders
      // "Tue, Sep 1, 9:00 AM", where the comma before the clock reads as another date part.
      const day = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(t);
      const clock = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(t);
      return 'once — ' + day + ' at ' + clock;
    } catch (_) { return null; }
  }

  /* The one entry point the UI calls: cron.js's OWN display string (job.scheduleDisplay, or a
     /api/cron/preview `display`) -> English, falling back to the exact input whenever we can't do better.
     Never throws, never returns null — a caller can always render the result verbatim. */
  function describeDisplay(display, opts) {
    const s = String(display == null ? '' : display).trim();
    if (!s) return '';
    if (s.indexOf('cron ') === 0) return describeExpr(s.slice(5)) || s;
    if (s.indexOf('once at ') === 0) return describeOnce(s.slice(8), opts) || s;
    if (s.indexOf('every ') === 0) return describeInterval(s.slice(6)) || s;
    return s;
  }

  /* ============================== TO-SPEC — schedule string -> picker state ==============================
     The inverse of build(), best-effort: it lets the picker OPEN on the mode that actually describes an
     existing routine (reschedule) instead of dumping the user into raw-cron mode. Anything it can't model
     round-trips as { mode:'advanced', raw } — which is lossless, since advanced mode IS the raw string. */
  function toSpec(schedule) {
    let s = String(schedule == null ? '' : schedule).trim();
    if (!s) return { mode: 'daily', hour: 9, minute: 0 };
    // accept cron.js's DISPLAY strings as well as raw schedules, so a caller can hand us a job's
    // scheduleDisplay verbatim. The prefixes are stripped down to something the parser accepts again —
    // 'once at <iso>' must become '<iso>', or "advanced" would be pre-filled with an unparseable string.
    if (s.indexOf('cron ') === 0) s = s.slice(5);
    else if (s.indexOf('once at ') === 0) return { mode: 'advanced', raw: s.slice(8).trim() };
    const iv = s.match(/^every\s+(\d+)\s*([mhd])$/i);
    if (iv) return { mode: 'interval', every: parseInt(iv[1], 10), unit: iv[2].toLowerCase() };
    const parts = s.split(/\s+/);
    if (parts.length === 5) {
      const mi = field(parts[0], 0, 59), hr = field(parts[1], 0, 23),
        dom = field(parts[2], 1, 31), mon = field(parts[3], 1, 12), dow = field(parts[4], 0, 7);
      if (mi && hr && dom && mon && dow && !mi.all && !hr.all && mon.all && mon.step === 1 &&
        mi.values.length === 1 && hr.values.length === 1) {
        const base = { hour: hr.values[0], minute: mi.values[0] };
        const domAll = dom.all && dom.step === 1, dowAll = dow.all && dow.step === 1;
        if (domAll && dowAll) return Object.assign({ mode: 'daily' }, base);
        if (domAll) return Object.assign({ mode: 'weekly', days: normDays(dow.values) }, base);
        if (dowAll && dom.values.length === 1) return Object.assign({ mode: 'monthly', dom: dom.values[0] }, base);
      }
    }
    return { mode: 'advanced', raw: s };
  }

  return {
    build: build, toSpec: toSpec,
    describeExpr: describeExpr, describeDisplay: describeDisplay, describeOnce: describeOnce,
    dayPhrase: dayPhrase, time12: time12, ordinal: ordinal, offsetSuffix: offsetSuffix,
    DAY_NAMES: DAY_NAMES, DAY_ABBR: DAY_ABBR, DAY_INITIAL: DAY_INITIAL
  };
});
