/* sidecar/unattended-admission.js — may an unattended beat spend a model call right now? (cost fix W1.6, slice 1)

   THE FUTILE BEAT. A night-shift build beat proposes, and PriorWork.veto renames a re-proposal of the newest undecided
   build into "Continue: <base>". When that undecided build is itself "Continue: <base>", workshopStore.queue refuses the
   identical title and the beat ends 'duplicate-backlog' — after its lead-model candidate call and a leash unit were
   spent. Nothing it read has changed by the next beat, so the next beat proposes the same thing and ends the same way:
   31 of 39 beats on Andrew's station between 10-20 and 11-08, one undecided build re-proposed 23 times.

   THE RULE (one resolver; the host only gathers):
     · settle(seen, result, now) after every beat: a build beat that ended 'duplicate-backlog' against a BUILT,
       undecided backlog item is remembered as { fp: what that beat read, runId/backlogId of the build it collided
       with }. Any other outcome — a delivery, a different stand-down, a throw, a reason-only draft beat — forgets it.
     · decide({ stuck, builds, fp, waiting, desk }) before the next beat spends anything: hold ('awaiting-verdict')
       only while the next beat would BUILD (only a build beat queues a job, so only a build beat can end on the dead
       end — a reason-only draft is never held), the fingerprint of everything it would read is the one the futile
       beat read, the build it collided with is still undecided in the live backlog, AND the desk still lists that
       build. Any change re-admits at once: a new message, a verdict, a new task or thread, a commit, a steer, a dial,
       grant, persona or model change. It is not a limit — nothing counts, nothing expires on a clock, and a beat the
       Commander fires by hand never asks.
     · fingerprint(parts) — a stable digest of the parts the host gathers (sorted keys, no clock), so the beat and
       the pre-spend gate compare the same thing. It holds ids and a hash only, never session text.

   PURE: no clock, rng or fs — `now` is injected; node's crypto only hashes. */
'use strict';

const crypto = require('crypto');

const AWAITING_VERDICT = 'awaiting-verdict';
const DEAD_END = 'duplicate-backlog';

// a canonical JSON: object keys sorted at every depth, so two equal part bags always hash alike.
function canonical(v) {
  if (v === undefined || typeof v === 'function') return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined && typeof v[k] !== 'function')
    .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function fingerprint(parts) {
  return crypto.createHash('sha256').update(canonical(parts || {}), 'utf8').digest('hex');
}

const str = v => (v == null ? '' : String(v));

/* settle — what to remember after a beat. seen: { fp } read before the beat; result: the beat's result (null when it
   threw, or for a reason-only draft beat, which queues nothing). Returns the marker to keep, or null to forget.
   result.waitingOn is set by the build beat only when the queue refused its job because a BUILT item with that title is
   still undecided: that, and only that, is a verdict awaited. */
function settle(seen, result, now) {
  const r = result || {};
  const w = r.waitingOn;
  if (r.reason !== DEAD_END || !w || !str(w.runId) || !seen || !str(seen.fp)) return null;
  return { fp: str(seen.fp), runId: str(w.runId), backlogId: str(w.backlogId), at: Number.isFinite(now) ? now : 0 };
}

/* decide — admit, or hold while nothing has changed since the futile beat.
     stuck:   the settled marker (or null)
     builds:  the next beat would BUILD (the dial builds unattended AND the away-workshop grant is on). A reason-only
              draft queues nothing, so it can never end on the dead end: it is never held. Only `true` holds.
     fp:      the fingerprint of what a beat would read now
     waiting: the live backlog row the marker names, { title, runId } — null when it is no longer there (decided)
     desk:    the desk still lists that build (its deliverable is on disk). A build the Commander cannot find on the desk
              is not one they can give a verdict on, so the hold never claims it. Only `true` holds.
   An unproven reading of any of them admits: the hold is asserted only on what the host proved.
   -> { admit: true, changed? } | { admit: false, binding: 'awaiting-verdict', why: { title, runId } } */
function decide(inp) {
  const i = inp || {};
  const s = i.stuck;
  if (!s || !str(s.fp) || !str(s.runId)) return { admit: true };
  if (i.builds !== true) return { admit: true, changed: 'mode' };
  if (str(i.fp) !== str(s.fp)) return { admit: true, changed: 'inputs' };
  const w = i.waiting;
  if (!w || str(w.runId) !== str(s.runId)) return { admit: true, changed: 'verdict' };
  if (i.desk !== true) return { admit: true, changed: 'desk' };
  return { admit: false, binding: AWAITING_VERDICT, why: { title: str(w.title).slice(0, 200), runId: str(w.runId) } };
}

/* ======================================================================================================================
   W3.1 — THE UNATTENDED HOLD (cost fix W3.1, approved 2026-11-08: ON by default, for AUTONOMOUS work only).

   WHO STARTED THE RUN is the whole key. A start is unattended when no person asked for it at that moment:
     'nightshift'  an away-shift beat the night-shift driver fires
     'routine'     a routine's scheduled fire (a routine the Commander armed is still unattended when it fires)
     'loop'        a standing loop's tick
     'workshop'    an away build: the away-workshop routine's shift, and the build a FREE plan chains into
   A message, Run Now, a beat or a shift fired by hand: a person started it, and nothing here ever holds or delays it.

   THE WINDOW RESERVE. A subscription says how much of each window is used on every call (sub-usage.js). An unattended
   start is held while EVERY live sign-in on its route has a window at or above THRESHOLDS.windowPct whose reset is still
   ahead, read within THRESHOLDS.staleMs: the last ~10% is the user's. A run rotates to the next sign-in when one is spent,
   so a sign-in with room, or with no reading, admits. A reading that is missing, stale, or past its reset never holds: the
   hold is asserted only on a reading the harness holds, and it names that reading, its source and the reset.

   THE RAIL. The weighted tokens unattended work spent in the trailing THRESHOLDS.railMs since the last RESUME, on routes
   that may sign in (a metered key has its dollar caps, a local model costs nothing): at THRESHOLDS.railTokens unattended
   starts pause. The weight is input-equivalent, the per-run subscription seatbelt's own weighing (loop.js): fresh input,
   cache writes and output at full weight, a cache re-read at 1/10. RESUME (re-arming the posture) starts a fresh count.

   NO BURST. A held start is dropped or declined, never queued: after the reset (or RESUME) the next start comes on its
   normal schedule. Nothing a person started counts toward a hold.

   Pure like the rest of this file: `now` is injected; Date only formats a given instant. */

const WINDOW_RESERVE = 'window-reserve';
const UNATTENDED_RAIL = 'unattended-rail';
const ORIGINS = Object.freeze(['nightshift', 'routine', 'loop', 'workshop']);
// the ONE table: every check reads it (the host's switches only override the two lines, through thresholds())
const THRESHOLDS = Object.freeze({ windowPct: 90, staleMs: 12 * 3600000, railTokens: 2000000, railMs: 24 * 3600000 });

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const acct = a => (!a || a === 'primary') ? 'primary' : String(a);
function isUnattended(origin) { return typeof origin === 'string' && ORIGINS.indexOf(origin) >= 0; }

// the switches: a number sets a line, 0 or 'off' turns it off, anything else keeps the default
function thresholds(over) {
  const o = over || {};
  const pick = (v, d, max) => {
    if (v == null || String(v).trim() === '') return d;
    const s = String(v).trim().toLowerCase();
    if (s === 'off') return 0;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : d;
  };
  return Object.freeze(Object.assign({}, THRESHOLDS, { windowPct: pick(o.windowPct, THRESHOLDS.windowPct, 100), railTokens: pick(o.railTokens, THRESHOLDS.railTokens, 1e12) }));
}

// a usage receipt's weight in input-equivalent tokens (reasoning is inside `out`, never added twice)
function weigh(r) {
  if (!r || r.usageMissing) return 0;
  const n = v => (isNum(v) && v > 0 ? v : 0);
  return n(r.uncachedIn) + n(r.cacheWrite) + n(r.cacheRead) / 10 + n(r.out);
}

/* windowReading — the reading that holds, or null. readings: one per live sign-in on the route's provider,
   [{ account, source, entry: { windows: [{ id, label, usedPct, resetsAt }], seenAt } | null }]. A sign-in is full while any
   of its windows is at or above the line with its reset ahead (the one that frees it LAST binds it); the route is held only
   when every sign-in is full, and the hold names the sign-in whose reset frees one FIRST. */
function windowReading(provider, readings, now, t) {
  const list = Array.isArray(readings) ? readings : [];
  if (!list.length || !isNum(now)) return null;
  let first = null;
  for (const r of list) {
    const e = r && r.entry;
    if (!e || !isNum(e.seenAt) || !Array.isArray(e.windows)) return null;   // a sign-in with no reading may have room
    const age = now - e.seenAt;
    if (!(age >= 0 && age <= t.staleMs)) return null;                       // stale, or read on another clock: unproven
    let bind = null;
    for (const w of e.windows) {
      if (!w || !isNum(w.usedPct) || !isNum(w.resetsAt) || w.usedPct < t.windowPct || w.resetsAt <= now) continue;
      if (!bind || w.resetsAt > bind.resetsAt) bind = w;
    }
    if (!bind) return null;                                                 // this sign-in has room
    if (!first || bind.resetsAt < first.w.resetsAt) first = { account: r.account, source: r.source, w: bind, seenAt: e.seenAt };
  }
  return { provider: str(provider), account: acct(first.account), window: str(first.w.label || first.w.id), usedPct: first.w.usedPct,
    resetsAt: first.w.resetsAt, seenAt: first.seenAt, source: str(first.source) };
}

/* railTally — unattended work's weighted tokens since max(now - railMs, resumedAt) (`from`), the oldest call the count
   holds (`first`), and when the count would fall back under the rail with nothing new (a held station adds nothing: the
   rows only age out). receipts: usage receipts (usage-receipts.js) already narrowed to the routes the rail counts; only
   those with an unattended origin count. */
function railTally(receipts, now, resumedAt, t) {
  const from = Math.max(now - t.railMs, isNum(resumedAt) ? resumedAt : -Infinity);
  const rows = [];
  let tokens = 0, first = null;
  for (const r of (Array.isArray(receipts) ? receipts : [])) {
    if (!r || !isUnattended(r.origin) || !isNum(r.at) || r.at <= from || r.at > now) continue;
    const w = weigh(r);
    if (w > 0) { rows.push([r.at, w]); tokens += w; if (first == null || r.at < first) first = r.at; }
  }
  let liftsAt = null;
  if (t.railTokens > 0 && tokens >= t.railTokens) {
    rows.sort((a, b) => a[0] - b[0]);
    let left = tokens;
    for (const [at, w] of rows) { left -= w; if (left < t.railTokens) { liftsAt = at + t.railMs; break; } }
  }
  return { tokens: Math.round(tokens), from: Number.isFinite(from) ? from : null, first, liftsAt };
}

/* admit — THE admission check every unattended starter asks before it spends.
     origin      who started the run (ORIGINS = unattended; anything else is a person: always admitted)
     provider    the route's provider id; signIn: the route may sign in (the rail counts and holds only those)
     readings    windowReading's input; rail: railTally's result; now; thresholds (THRESHOLDS or thresholds(...))
   -> { admit: true } | { admit: false, binding: 'window-reserve', why: { provider, account, window, usedPct, resetsAt, seenAt, source } }
                      | { admit: false, binding: 'unattended-rail', why: { tokens, limit, since, liftsAt } }
   `since` is the oldest call the count holds: like every field of a hold it stays the same while nothing changes, so a
   hold is ledgered once, not once per tick. */
function admit(inp) {
  const i = inp || {};
  if (!isUnattended(i.origin)) return { admit: true };
  const t = i.thresholds || THRESHOLDS;
  if (t.windowPct > 0) {
    const w = windowReading(i.provider, i.readings, i.now, t);
    if (w) return { admit: false, binding: WINDOW_RESERVE, why: w };
  }
  const rail = i.rail || {};
  if (t.railTokens > 0 && i.signIn === true && isNum(rail.tokens) && rail.tokens >= t.railTokens) {
    return { admit: false, binding: UNATTENDED_RAIL, why: { tokens: Math.round(rail.tokens), limit: t.railTokens,
      since: isNum(rail.first) ? rail.first : isNum(rail.from) ? rail.from : null, liftsAt: isNum(rail.liftsAt) ? rail.liftsAt : null } };
  }
  return { admit: true };
}

const utc = ms => (isNum(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'an unknown time');
const short = n => (n >= 1e6 ? (Math.round(n / 1e5) / 10) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));

// the hold in words: stable for the length of one hold (absolute times only), so an edge-triggered row is written once
function say(d, t) {
  if (!d || d.admit !== false || !d.why) return '';
  const w = d.why, th = t || THRESHOLDS;
  if (d.binding === WINDOW_RESERVE) {
    return w.provider + '’s ' + w.window + ' window is ' + w.usedPct + '% used (read ' + utc(w.seenAt) + ' from the ' + w.source + '): the last '
      + Math.max(0, 100 - th.windowPct) + '% is kept for you, so unattended work waits until it resets at ' + utc(w.resetsAt);
  }
  if (d.binding === UNATTENDED_RAIL) {
    return 'unattended work used ' + short(w.tokens) + ' weighted tokens since ' + utc(w.since) + ' (the rail is ' + short(w.limit)
      + '): it is paused until you re-arm autonomy' + (isNum(w.liftsAt) ? ', or until ' + utc(w.liftsAt) : '');
  }
  return '';
}

/* tokensPerStart — the weighted tokens one start of `origin`/`ref` spent (an away-shift beat, a routine's fire), the mean
   over its newest `last` starts (default 10) on the receipts. `exclude`: the starts still running (one id, an array, or
   anything with has(): a Set, a Map) — a start not finished is not a start's cost yet. null when none is recorded. */
function tokensPerStart(receipts, q) {
  const o = q || {};
  const x = o.exclude;
  const running = x == null || x === '' ? () => false
    : typeof x.has === 'function' ? s => x.has(s)
    : Array.isArray(x) ? s => x.indexOf(s) >= 0
    : s => s === str(x);
  const by = new Map();
  for (const r of (Array.isArray(receipts) ? receipts : [])) {
    if (!r || r.origin !== o.origin || str(r.ref) !== str(o.ref) || !str(r.start) || running(str(r.start))) continue;
    const s = by.get(r.start) || { tokens: 0, at: 0 };
    s.tokens += weigh(r);
    s.at = Math.max(s.at, isNum(r.at) ? r.at : 0);
    by.set(r.start, s);
  }
  const list = Array.from(by.values()).sort((a, b) => b.at - a.at).slice(0, o.last > 0 ? o.last : 10);
  if (!list.length) return null;
  return { tokens: Math.round(list.reduce((s, x) => s + x.tokens, 0) / list.length), starts: list.length };
}

module.exports = { fingerprint, settle, decide, canonical, AWAITING_VERDICT, DEAD_END,
  WINDOW_RESERVE, UNATTENDED_RAIL, ORIGINS, THRESHOLDS, isUnattended, thresholds, weigh, windowReading, railTally, admit, say, tokensPerStart };
