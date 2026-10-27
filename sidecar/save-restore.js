/* sidecar/save-restore.js — bring a preserved window save's sessions back into the station (support report 2026-10-21).

   A refused save leaves the window's whole station beside the station file (<agent>.save-conflict-<client>.json).
   Nothing in the app could bring that work back: "Reload current station" drops it from view and "Download" only
   exports it. This restores its SESSIONS into the current station and never takes anything away:

     • a session the station does not have is added, unless it was deleted on purpose: the station's deletedIds, or the
       sidecar's own uncapped deleted-session ledger passed in as opts.forgotten(id, ts) (session-tombstones.js forgotten:
       true when the session was deleted at or after `ts`). The ledger is TIME-SCOPED like every other reader of it: a
       session revived after its delete (Workstreams.adopt revive keeps the ledger's stamp by design) is deleted only for
       what it held up to the delete, and a session the station holds live is never "deleted" (review 10-23 r2 #3);
     • a session the preserved save continued (the station's turns are the start of its turns) gets ONLY the missing
       turns appended; every other field of the station's session (title, archived, pinned, lane, runIds, deliverables …)
       stays exactly as the station has it (review 10-23 #3b);
     • a station session that is EMPTY is not "behind" a preserved copy with turns when it may have been cleared (a Clear
       empties the history and stamps lastActiveAt): it is left alone unless it was never active since it was created, or
       the preserved copy was active in it after the station last was;
     • the station's clear checkpoint (sessionUndo, kind 'clear': the cleared turns and WHEN) is time-scoped too: what a
       preserved copy held when that session was cleared never comes back, but turns it added AFTER the clear do — the
       cleared turns are stripped off the front and only the rest is appended or copied (review 10-23 r2 #2);
     • a session both sides changed differently is kept as it is, and the preserved one is added beside it as a
       "(restored copy)", so no turn from either side is lost;
     • everything else — the roster, the floor, settings, the station's other sessions — stays the station's.

   The preserved save's General stream is the station's General (a window that booted without the station minted
   its own id for it), so it is compared with the station's General, never added as a second one.

   Pure: no I/O, no clock. plan(current, preserved, opts) -> { doc, added, extended, copied } where doc is a new station
   save (the input objects are not modified; the station is copied shallowly, never deep-cloned) and the three lists hold
   session ids. restorable(current, preserved, opts) counts the same sessions without building a doc (review 10-23 #3d:
   the boot offer runs it on a multi-MiB station). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.saveRestore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COPY_SUFFIX = '~restored';
  const COPY_MAX = 20;   // restored copies of one session: ~restored … ~restored20

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function list(doc) { return doc && Array.isArray(doc.workstreams) ? doc.workstreams.filter(w => w && typeof w === 'object' && typeof w.id === 'string' && w.id) : []; }
  function hist(w) { return Array.isArray(w && w.history) ? w.history : []; }
  // one turn equal to another: the common shape (role + string content) without a stringify, anything else by its JSON
  function sameTurn(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return JSON.stringify(a) === JSON.stringify(b);
    if (a.role !== b.role) return false;
    if (typeof a.content === 'string' && typeof b.content === 'string' && a.content !== b.content) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  // the first `shorter.length` turns of `longer` are `shorter`
  function startsWith(longer, shorter) {
    if (shorter.length > longer.length) return false;
    for (let i = 0; i < shorter.length; i++) if (!sameTurn(longer[i], shorter[i])) return false;
    return true;
  }
  // how many leading turns two histories share
  function sharedPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && sameTurn(a[i], b[i])) i++;
    return i;
  }
  // the station's own clear checkpoint (Workstreams sessionUndo, kind 'clear'): id -> { at, history } of each session it
  // cleared. A checkpoint without a time proves nothing about later activity: every copy counts as from before it.
  function clearedRows(doc) {
    const cp = doc && doc.sessionUndo;
    const out = new Map();
    if (cp && typeof cp === 'object' && cp.kind === 'clear' && Array.isArray(cp.rows)) {
      const at = num(cp.at) > 0 ? num(cp.at) : Infinity;
      for (const r of cp.rows) if (r && typeof r.id === 'string') out.set(r.id, { at, history: hist(r) });
    }
    return out;
  }
  // the newest moment a preserved session is known to have been worked in (what the deleted-session ledger is compared with)
  function activity(w) { return Math.max(num(w && w.lastActiveAt), num(w && w.createdAt)); }

  /* what one preserved session does to the station: null (nothing) or { kind: 'add'|'extend'|'copy', ... }. `ctx` holds the
     station's index and deleted predicates. Never modifies its inputs. */
  function decide(raw, ctx) {
    const id = ctx.mapId(raw.id);
    const have = ctx.byId.get(id);
    if (!have) return ctx.deleted(id, activity(raw)) ? null : { kind: 'add', id };
    const mine = hist(have);
    let theirs = hist(raw);
    const cleared = ctx.cleared.get(id);
    if (cleared) {
      // the Commander cleared this session at cleared.at: what the preserved copy held then stays cleared. Only a copy
      // that was active in it AFTER the clear has anything to bring back, and only the turns past the cleared ones.
      if (!(num(raw.lastActiveAt) > cleared.at)) return null;
      theirs = theirs.slice(sharedPrefix(theirs, cleared.history));
      if (!theirs.length) return null;
    }
    if (startsWith(mine, theirs)) return null;                                          // the same, or the station has more
    if (mine.length === 0) {
      // an EMPTY station session may have been cleared on purpose (Clear stamps lastActiveAt). It takes the preserved turns
      // only when it provably never was active since it was created, or the preserved copy was active in it AFTER the
      // station last was (a checkpointed clear was handled above: `theirs` holds only what came after it)
      const born = Number(have.createdAt), touched = Number(have.lastActiveAt);
      const untouched = born > 0 && touched > 0 && touched <= born;
      if (!cleared && !(untouched || Number(raw.lastActiveAt) > Number(have.lastActiveAt || 0))) return null;
      return { kind: 'extend', id, have, more: theirs };
    }
    if (startsWith(theirs, mine)) return { kind: 'extend', id, have, more: theirs.slice(mine.length) };
    /* BOTH SIDES CHANGED IT DIFFERENTLY: the preserved one is kept beside it as a restored copy. A copy an earlier restore or
       merge made is CONTINUED when this one continues it, and left alone when it already holds this one (a second restore of
       the same save brings nothing twice); a session that diverged AGAIN gets the next copy (~restored2, ~restored3, …).
       save-latch-kill: a refused save is now merged in-session, so a session two windows keep writing (General) diverges
       again and again — a second divergence used to stay out of the station, only in the copy kept beside it (and pruned).
       A copy the Commander deleted stays deleted: that slot is never refilled, and nothing past it is added. */
    for (let n = 1; n <= COPY_MAX; n++) {
      const copyId = id + COPY_SUFFIX + (n > 1 ? String(n) : '');
      const copy = ctx.byId.get(copyId);
      if (!copy) return ctx.deleted(copyId, activity(raw)) ? null : { kind: 'copy', id, have, copyId, history: theirs };
      const ch = hist(copy);
      if (startsWith(ch, theirs)) return null;                                          // that copy already holds it
      if (startsWith(theirs, ch)) return { kind: 'extend', id: copyId, have: copy, more: theirs.slice(ch.length) };
    }
    return null;
  }
  function context(current, preserved, opts) {
    const stationList = list(current);
    const byId = new Map(stationList.map(w => [w.id, w]));
    const deletedIds = new Set(Array.isArray(current && current.deletedIds) ? current.deletedIds : []);
    const forgotten = opts && typeof opts.forgotten === 'function' ? opts.forgotten : null;
    const fromGeneral = preserved && preserved.generalId, toGeneral = current && current.generalId;
    return {
      stationList, byId, toGeneral, cleared: clearedRows(current),
      mapId: id => (fromGeneral && toGeneral && id === fromGeneral) ? toGeneral : id,
      // only ever asked about a session the station does NOT hold live
      deleted: (id, ts) => deletedIds.has(id) || !!(forgotten && forgotten(id, ts))
    };
  }

  function plan(current, preserved, opts) {
    const ctx = context(current, preserved, opts);
    const doc = Object.assign({}, current || {});
    const out = ctx.stationList.slice();
    const at = new Map(out.map((w, i) => [w.id, i]));
    const added = [], extended = [], copied = [];
    for (const raw of list(preserved)) {
      const d = decide(raw, ctx);
      if (!d) continue;
      if (d.kind === 'add') {
        const w = Object.assign({}, raw, { id: d.id });
        if (w.parentStreamId) w.parentStreamId = ctx.mapId(w.parentStreamId);
        if (w.title == null && w.id !== ctx.toGeneral) w.title = 'Restored session';   // a null title means General
        out.push(w); ctx.byId.set(w.id, w); at.set(w.id, out.length - 1); added.push(w.id);
      } else if (d.kind === 'extend') {
        // the station's session with the missing turns appended: every station-side field stays as the station has it
        const w = Object.assign({}, d.have, { history: hist(d.have).concat(d.more) });
        out[at.get(d.id)] = w; ctx.byId.set(d.id, w); extended.push(d.id);
      } else {
        const w = Object.assign({}, raw, { id: d.copyId, history: d.history, title: String(d.have.title || raw.title || 'General').slice(0, 64) + ' (restored copy)' });
        if (w.parentStreamId) w.parentStreamId = ctx.mapId(w.parentStreamId);
        out.push(w); ctx.byId.set(d.copyId, w); at.set(d.copyId, out.length - 1); copied.push(d.copyId);
      }
    }
    doc.workstreams = out;
    return { doc, added, extended, copied };
  }

  // how many sessions plan() would bring back — what a notice may honestly offer. Builds nothing.
  function restorable(current, preserved, opts) {
    const ctx = context(current, preserved, opts);
    let n = 0;
    for (const raw of list(preserved)) {
      const d = decide(raw, ctx);
      if (!d) continue;
      n++;
      // a later preserved session with the same id (or the copy's id) sees this one as present, exactly as plan() does
      if (d.kind === 'add') ctx.byId.set(d.id, raw);
      else if (d.kind === 'copy') ctx.byId.set(d.copyId, raw);
      else ctx.byId.set(d.id, { history: hist(d.have).concat(d.more) });
    }
    return n;
  }

  return { plan, restorable, COPY_SUFFIX };
});
