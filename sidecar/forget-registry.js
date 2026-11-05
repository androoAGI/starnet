/* sidecar/forget-registry.js - THE ONE REGISTRY OF WHAT A DELETED SESSION LEAVES BEHIND (turn identity commits 11 and 12,
   qa/bugs/3e926b6a, 31042fab, 6e750350).

   The transcript store answers "is this ROW forgotten" (tombstone rule, quote rule, saturated rule). Everything a model can read that
   was DERIVED from a session - an interest, a staged draft, a verdict packet, a task brief, a golden, a study proposal, a deliverable
   row, a night-shift draft, a quest, an overseer thread, an attachment file - is a second copy of those words. This module is the one
   place that knows every such store, so that none of them is forgotten about:

     register({ name, sourceOf(record) -> src, forget(scope) -> number | { removed } })
                      a store that records its sources and removes what a deleted session wrote. sourceOf names the source of ONE
                      record: { streamIds, runIds, rowIds, at } (any subset; `at` = when the record was written, so a session
                      re-opened after its delete is heard again). forget runs once per delete stamp and must be idempotent.
     exempt(name, reason)
                      a store that is deliberately NOT purged, with the reason (the census test requires one of the two for every
                      durable store the sidecar writes).
     admit(src)       WRITE-TIME: false when the source of a derived write is forgotten (its session was deleted, its row is
                      unprovable, or the writing run quoted a deleted session). Every registered store calls it before it writes, so
                      an in-flight aux pass, a held verdict review or a late study proposal cannot re-create what a purge removed.
     forgotten(src)   READ-TIME belt for a record a model will read: the same test over the record's own source, adopted stamps
                      (I7 limit d: a delete made before the ledger's first read keeps its memory) never counted.
     forgetAll(scope) runs every entry's forget over a scope { streams: Map(id -> at), runIds: Set, rowIds: Set } and throws after
                      all ran when one failed, so the caller marks nothing purged and retries.
     stopLive(stamps) stops the live runs that read a deleted session (the host's existing stop path, injected).
     viewRun(record)  the run-title filter: the SAME record when it is visible, null when forgotten (see viewRun below).

   Pure over injected deps: no clock, no fs, no randomness (lint-determinism). The host wiring is sidecar/forget-wiring.js. */
'use strict';

const TurnKinds = require('../frontend/app/turnkinds.js');

// Bump when a store is registered or its forget changes: session-tombstones re-runs every non-adopted purged stamp once per bump,
// so deletes made before an upgrade stop leaking (purgedV catch-up). Adopted stamps are never re-run (I7 limit d).
const VERSION = 2;   // 2: the Commander dossier block and the beliefs snapshot are registered (commit 14)

const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,79}$/;
const REASON_MIN = 16;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toList(...parts) {
  const out = [];
  for (const p of parts) {
    if (Array.isArray(p)) { for (const x of p) if (x != null && x !== '') out.push(x); }
    else if (p != null && p !== '') out.push(p);
  }
  return out;
}

/* viewRun(r, ctx) - a run record through the forget rules. ctx = { deletedAt(streamId) -> ms, latestDeleteAt() -> ms }.
   Returns the SAME object it was given when the run is visible, and null when it is forgotten: the session it ran in was deleted at
   or after the run was filed (the tombstone rule), or it quotes a session deleted at or after the read began, or it is saturated and
   a non-adopted delete is stamped at or after its saturation (TurnKinds.quotesForgotten, the one quote rule). It never copies,
   projects or drops a field, so a run's outcome, failureCode, clarifying and title reach every reader exactly as filed; a falsy
   input comes back unchanged. */
function viewRun(r, ctx) {
  if (!r || typeof r !== 'object') return r;
  const deletedAt = ctx && typeof ctx.deletedAt === 'function' ? ctx.deletedAt : null;
  const latestDeleteAt = ctx && typeof ctx.latestDeleteAt === 'function' ? ctx.latestDeleteAt : null;
  if (deletedAt) {
    const at = num(deletedAt(r.streamId));
    if (at > 0 && num(r.ts) <= at) return null;
  }
  if (TurnKinds.quotesForgotten(r, deletedAt, latestDeleteAt)) return null;
  return r;
}

/* stampOf(raw) - a record's quote stamp in its one canonical form: { quotes, quotesAt } (up to 32 stream ids with the time each was read, or
   the saturated ['*']), {} when it quotes nothing. A stored record is read back through it, so a hand-edited or old file cannot carry a
   shape the rule would misread. */
function stampOf(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const quotes = Array.isArray(raw.quotes) ? raw.quotes : [], times = Array.isArray(raw.quotesAt) ? raw.quotesAt : [];
  const entries = [];
  quotes.forEach((id, i) => { if (typeof id === 'string' && id) entries.push({ id, at: Number.isSafeInteger(times[i]) && times[i] >= 0 ? times[i] : 0 }); });
  const stamp = TurnKinds.quoteStamp(entries);
  if (Number.isSafeInteger(raw.quotesSaturatedAt) && raw.quotesSaturatedAt >= 0) stamp.quotesSaturatedAt = raw.quotesSaturatedAt;
  return stamp;
}

/* inScope(src, scope) - does a record's source lie in a delete scope? src = { streamIds | streamId, runIds | runId, rowIds | rowId, at,
   quotes, quotesAt, quotesSaturatedAt }.
   A stream source counts when the stream was deleted at or after the record was written (a record written after the delete, from
   a re-opened session, is not the deleted session's); a run or row source counts when the scope names it; a QUOTE stamp counts by the
   one quote rule (TurnKinds.quotesForgotten): a quoted stream deleted at or after the read began, or a saturated stamp and any delete
   at or after it. */
function inScope(src, scope) {
  if (!src || typeof src !== 'object' || !scope || typeof scope !== 'object') return false;
  const streams = scope.streams instanceof Map ? scope.streams : (scope.at instanceof Map ? scope.at : null);
  const at = num(src.at);
  if (streams && ((Array.isArray(src.quotes) && src.quotes.length) || num(src.quotesSaturatedAt) > 0)) {
    let latest = 0;
    for (const w of streams.values()) if (w > latest) latest = w;
    if (TurnKinds.quotesForgotten(src, id => streams.get(String(id)) || 0, () => latest)) return true;
  }
  if (streams) {
    for (const id of toList(src.streamIds, src.streamId)) {
      const when = streams.get(String(id));
      if (when && at <= when) return true;
    }
  }
  if (scope.runIds && typeof scope.runIds.has === 'function') for (const id of toList(src.runIds, src.runId)) if (scope.runIds.has(String(id))) return true;
  if (scope.rowIds && typeof scope.rowIds.has === 'function') for (const id of toList(src.rowIds, src.rowId)) if (scope.rowIds.has(id)) return true;
  return false;
}

function make(deps) {
  const d = deps || {};
  const note = typeof d.note === 'function' ? d.note : () => {};
  const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : undefined);
  const entries = new Map();
  const exempts = new Map();
  const refused = Object.create(null);
  let admitted = 0, sealed = false;

  function register(entry) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const name = String(e.name == null ? '' : e.name);
    if (!NAME_RE.test(name)) throw new Error('forget registry: a store needs a name');
    if (typeof e.forget !== 'function') throw new Error('forget registry: ' + name + ' needs a forget(scope) function');
    if (typeof e.sourceOf !== 'function') throw new Error('forget registry: ' + name + ' needs a sourceOf(record) function (the source it records)');
    if (entries.has(name) || exempts.has(name)) throw new Error('forget registry: ' + name + ' is already registered or exempted');
    if (sealed) throw new Error('forget registry: ' + name + ' registered after the registry was sealed');
    entries.set(name, { name, sourceOf: e.sourceOf, forget: e.forget });
    return name;
  }
  function exempt(name, reason) {
    const n = String(name == null ? '' : name), why = String(reason == null ? '' : reason).trim();
    if (!NAME_RE.test(n)) throw new Error('forget registry: an exemption needs the store name');
    if (why.length < REASON_MIN) throw new Error('forget registry: ' + n + ' is exempted without a reason');
    if (entries.has(n) || exempts.has(n)) throw new Error('forget registry: ' + n + ' is already registered or exempted');
    if (sealed) throw new Error('forget registry: ' + n + ' exempted after the registry was sealed');
    exempts.set(n, why);
    return n;
  }
  // wiring is complete: every store is registered or exempted. A purge pass waits for it (a pass before it would mark deletes purged).
  function seal() { sealed = true; }

  // the verdict on ONE source. fresh = read-time belt (adopted stamps never count, no row proof); else write-time admit.
  function judge(src, fresh) {
    if (!src || typeof src !== 'object') return null;
    const at = fresh && typeof d.freshDeletedAt === 'function' ? d.freshDeletedAt : d.deletedAt;
    // the writer's own quote latch (or a record's stamp): it read a session that was deleted at or after the read
    if ((Array.isArray(src.quotes) && src.quotes.length) || num(src.quotesSaturatedAt) > 0) {
      if (TurnKinds.quotesForgotten(src, typeof at === 'function' ? at : null, d.latestDeleteAt)) return 'quotes';
    }
    for (const runId of toList(src.runIds, src.runId)) {
      let gone = false;
      try { gone = !!call(d.runForgotten, String(runId)); } catch (e) { note('forget.admit.run', e); return 'unprovable'; }
      if (gone) return 'run';
    }
    const streamIds = toList(src.streamIds, src.streamId).map(String);
    const rowIds = toList(src.rowIds, src.rowId).filter(Number.isSafeInteger);
    for (const streamId of streamIds) {
      let when = 0;
      try { when = num(call(at, streamId)); } catch (e) { note('forget.admit.stream', e); return 'unprovable'; }
      if (!fresh && typeof d.rowVerdict === 'function') {
        // a row of a stream: the store's own predicate decides (a deleted session's row, a quote-forgotten row, a row it cannot read)
        for (const rowId of rowIds) {
          let v = null;
          try { v = d.rowVerdict(streamId, rowId); } catch (e) { note('forget.admit.row', e); return 'unprovable'; }
          if (v === true) return 'stream';
          if (v !== false) return 'unprovable';
        }
        if (rowIds.length) continue;
      }
      if (when > 0 && !(num(src.at) > when)) return 'stream';
    }
    return null;
  }
  function admit(src) {
    let why = null;
    try { why = judge(src, false); } catch (e) { note('forget.admit', e); why = 'unprovable'; }
    if (!why) { admitted++; return true; }
    refused[why] = (refused[why] || 0) + 1;
    return false;
  }
  function forgotten(src) {
    try { return !!judge(src, true); } catch (e) { note('forget.belt', e); return true; }
  }

  async function forgetAll(scope) {
    const out = { ran: [], removed: {}, results: {}, failed: [], deferred: false };
    if (!sealed) { out.deferred = true; return out; }
    for (const e of Array.from(entries.values())) {
      try {
        const r = await e.forget(scope);
        out.ran.push(e.name);
        out.results[e.name] = r;
        out.removed[e.name] = r && typeof r === 'object' ? num(r.removed) : num(r);
      } catch (error) {
        out.failed.push({ name: e.name, error });
        note('forget.' + e.name, error);
      }
    }
    if (out.failed.length) {
      const err = new Error('forget registry: ' + out.failed.map(f => f.name + ' (' + String((f.error && f.error.message) || f.error) + ')').join('; '));
      err.failed = out.failed; err.result = out;
      throw err;
    }
    return out;
  }

  return {
    register, exempt, seal, admit, forgotten, forgetAll,
    ready: () => sealed,
    stopLive: stamps => (typeof d.stopLive === 'function' ? d.stopLive(stamps) : 0),
    viewRun: r => viewRun(r, d),
    names: () => Array.from(entries.keys()),
    exemptions: () => Object.fromEntries(exempts),
    entry: name => entries.get(String(name)) || null,
    stats: () => ({ admitted, refused: Object.assign({}, refused) }),
    version: VERSION
  };
}

module.exports = { VERSION, SID_RE, make, viewRun, inScope, stampOf };
