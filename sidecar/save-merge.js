/* sidecar/save-merge.js — merge a window's save into the station file when another window has saved past it (wave-1
   save-latch-kill; gh#153 "a desktop window plus a browser tab", #121, starnet-releases#4).

   Two windows of one station each hold the whole station and save the whole station. The station file's revision check
   (savestore compareRevision) refuses a save built on a revision another window already moved past — right, since writing
   it would drop the other window's work — and that refusal used to LATCH: every later save of the window refused, the
   banner never clearing. The first fix merged the refused save on the boot merge's rules (save-restore.js: the station the
   base, sessions added) and reloaded the window; review 10-27 found it dropped every change of that window that was not a
   session turn (the hero, the crew, settings, the floor, renames, deletes) while the notice said they were merged, made a
   new full-history "(restored copy)" every time two windows typed in one session, and reloaded windows mid-run.

   THIS IS A THREE-WAY MERGE. The window sends its whole save plus what it changed since the station last took its work
   (cloudsavecore.js mergeDelta: the base values of what changed, never the whole base again). Then, field by field:
     • a field this window did not change is the station's, with whatever another window did to it;
     • a field only this window changed is this window's;
     • a field both changed: objects merge key by key, rows with ids (the crew) row by row, a counter (lifetime usage, a
       session's cost) keeps both windows' additions, a time stamp (…At) the later one; anything else takes THIS window's
       change — the one being saved now is the newest edit of it (counted in `overrode`);
     • sessions: one this window added is added; one it deleted is deleted; one it changed is merged — its other fields as
       above, its turns: the turns this window added go after the station's (never a second copy of the conversation, and
       never twice), and a history this window rewrote (a retry, a clear, a trim) stands, with what the station added kept
       after it;
     • a session or crew row ANOTHER window deleted stays deleted; this window's changes to it cannot land, and are
       reported (`lost`) with this window's whole save kept beside the station (<agent>.save-conflict-kept-<window>.json,
       one per window, overwritten) — never dropped without a word;
     • the growth projection (stationStats + every row's stats) is taken whole from the side whose rating watermark is
       newer: the station's growth never goes back (the guard POST /api/save keeps for a plain save).
   The station file's revision check is never relaxed: the merge is computed from the station file as it is NOW and
   written on its revision (compareRevision), as `adopt-<window>`; a merge that brings nothing new writes nothing.
   Pure apart from the injected store: no clock, no fs of its own. */
'use strict';

const { deepEq } = require('../frontend/app/cloudsavecore.js');

// fields the merge itself writes (the envelope and the station-owned ones); everything else merges three-way
const OWN = new Set(['schema', 'version', 'updatedAt', '_saveRevision', '_saveClient', '_saveDirty', '_saveMerge', '_saveRestore', '_saveAdoptBy',
  'workstreams', 'deletedIds', 'forgetIds', 'stationStats']);
const TOMBS_MAX = 500;   // workstreams.js MAX_TOMBS
const CLIENT_RE = /^[A-Za-z0-9_-]{1,72}$/;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function has(o, k) { return isObj(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined; }
function list(doc) { return doc && Array.isArray(doc.workstreams) ? doc.workstreams.filter(w => isObj(w) && typeof w.id === 'string' && w.id) : []; }
function hist(w) { return Array.isArray(w && w.history) ? w.history : []; }
function fieldsOf(w) { if (!isObj(w)) return w; const o = Object.assign({}, w); delete o.history; return o; }
// an array whose every member is an object with its own unique string id (the crew): merged row by row. null otherwise.
function keyed(a) {
  if (!Array.isArray(a)) return null;
  const m = new Map();
  for (const x of a) { if (!isObj(x) || typeof x.id !== 'string' || !x.id || m.has(x.id)) return null; m.set(x.id, x); }
  return m;
}
function prefix(a, b) { let i = 0; while (i < a.length && i < b.length && deepEq(a[i], b[i])) i++; return i; }
// numeric leaves that COUNT up in each window on its own: both windows' additions are kept
function isCounter(path) { return path[0] === 'usage' || (path[0] === 'session' && path[2] === 'cost'); }
function isStamp(path) { return /At$/.test(String(path[path.length - 1] || '')); }

// the three-way merge of one value: b = this window's base, m = this window's now, s = the station's now
function merge3(b, m, s, path, ctx) {
  if (deepEq(m, b)) return s;
  if (deepEq(s, b)) return m;
  if (deepEq(m, s)) return m;
  if (typeof m === 'number' && typeof s === 'number') {
    if (typeof b === 'number' && isCounter(path)) return s + (m - b);
    if (isStamp(path)) return Math.max(m, s);
  }
  if (isObj(m) && isObj(s) && (b === undefined || isObj(b))) {
    const out = {}, bb = b || {};
    for (const k of Object.keys(s).concat(Object.keys(m).filter(k => !has(s, k)))) {
      const v = merge3(bb[k], m[k], s[k], path.concat(k), ctx);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  const km = keyed(m), ks = keyed(s), kb = b === undefined ? new Map() : keyed(b);
  if (km && ks && kb) return mergeRows(kb, m, km, s, ks, path, ctx);
  ctx.overrode.push(path.join('.'));   // both changed it: this window's change is the one being saved now — the newest
  return m;
}
function mergeRows(kb, m, km, s, ks, path, ctx) {
  const out = [];
  for (const row of s) {
    if (!km.has(row.id)) {
      if (kb.has(row.id)) { if (!deepEq(row, kb.get(row.id))) ctx.overrode.push(path.concat(row.id).join('.')); continue; }   // this window removed it
      out.push(row); continue;                                                                                              // another window's row
    }
    out.push(merge3(kb.get(row.id), km.get(row.id), row, path.concat(row.id), ctx));
  }
  for (const row of m) {
    if (ks.has(row.id)) continue;
    if (kb.has(row.id)) { if (!deepEq(row, kb.get(row.id))) ctx.lost.push({ kind: 'row', at: path.join('.'), id: row.id, name: String(row.name || row.id).slice(0, 64) }); continue; }   // another window removed it
    out.push(row);
  }
  return out;
}

/* a session's turns: B = the base's, W = this window's, S = the station's. The turns this window added go after the
   station's, never twice (a merge whose answer was lost is merged again from the same base); a history this window
   rewrote stands, with what the station added after the part they share kept after it. */
function mergeHistory(B, W, S, id, ctx) {
  if (deepEq(W, B)) return S;
  if (deepEq(S, B)) return W;
  const pw = prefix(W, B), ps = prefix(S, B);
  const tail = S.slice(ps);
  if (pw === B.length) return S.concat(W.slice(B.length).filter(t => !tail.some(x => deepEq(x, t))));
  if (ps !== B.length) ctx.overrode.push('session.' + id + '.history');
  return W.concat(tail.filter(t => !W.some(x => deepEq(x, t))));
}

// the growth projection a save carries: its watermark, its station rollup, and each agent row's stats by id
function growthOf(doc) {
  const stats = new Map();
  for (const r of [doc && doc.agent].concat(Array.isArray(doc && doc.agents) ? doc.agents : [])) {
    if (has(r, 'stats')) { const id = String(r.id || 'agent'); if (!stats.has(id)) stats.set(id, r.stats); }
  }
  return { mark: num(doc && doc.stationStats && doc.stationStats.ratingSyncAt), station: doc && doc.stationStats, stats };
}
function noStats(v) {
  if (isObj(v)) { if (!has(v, 'stats')) return v; const o = Object.assign({}, v); delete o.stats; return o; }
  if (Array.isArray(v)) return v.map(x => (isObj(x) && has(x, 'stats')) ? noStats(x) : x);
  return v;
}
function withStats(row, win, lose) {
  if (!isObj(row)) return row;
  const id = String(row.id || 'agent');
  const st = win.stats.has(id) ? win.stats.get(id) : lose.stats.get(id);
  const o = Object.assign({}, row);
  if (st !== undefined) o.stats = st; else delete o.stats;
  return o;
}

function validDelta(d) {
  return isObj(d) && Array.isArray(d.top) && Array.isArray(d.rows) && Array.isArray(d.gone)
    && d.top.every(t => isObj(t) && typeof t.k === 'string') && d.rows.every(r => isObj(r) && typeof r.id === 'string' && r.id)
    && d.gone.every(g => typeof g === 'string');
}

/* merge(station, mine, delta, opts) -> { doc, changed, added, extended, removed, overrode, lost }
   station: the station file's save; mine: this window's whole save; delta: cloudsavecore mergeDelta(base, mine).
   opts.forgotten(id, ts): the sidecar's deleted-session ledger (a new session of this window that was deleted on purpose
   elsewhere stays deleted). Inputs are not modified. */
function merge(station, mine, delta, opts) {
  const ctx = { overrode: [], lost: [] };
  const forgotten = opts && typeof opts.forgotten === 'function' ? opts.forgotten : null;
  const topD = new Map(delta.top.map(t => [t.k, t]));
  const out = {};
  const keys = Object.keys(station).concat(Object.keys(mine).filter(k => !has(station, k)));
  for (const k of keys) {
    if (OWN.has(k)) continue;
    const t = topD.get(k);
    let v;
    if (!t) v = station[k];   // this window did not change it: the station's, with whatever another window did
    else {
      const g = k === 'agent' || k === 'agents';   // the stats ride the growth projection, below
      const bv = has(t, 'b') ? t.b : undefined;
      v = merge3(g ? noStats(bv) : bv, g ? noStats(mine[k]) : mine[k], g ? noStats(station[k]) : station[k], [k], ctx);
    }
    if (v !== undefined) out[k] = v;
  }
  // the deleted-session lists: the station's, plus what this window deleted since its base
  for (const k of ['deletedIds', 'forgetIds']) {
    const st = Array.isArray(station[k]) ? station[k].filter(x => typeof x === 'string') : [];
    const t = topD.get(k);
    if (!t) { if (has(station, k)) out[k] = station[k]; continue; }
    const before = new Set(Array.isArray(t.b) ? t.b : []), seen = new Set(st);
    const add = (Array.isArray(mine[k]) ? mine[k] : []).filter(x => typeof x === 'string' && !before.has(x) && !seen.has(x));
    out[k] = st.concat(add).slice(-TOMBS_MAX);
  }
  // sessions
  const S = list(station), M = list(mine);
  const sm = new Map(S.map(w => [w.id, w])), mm = new Map(M.map(w => [w.id, w]));
  const rows = new Map(delta.rows.map(r => [r.id, r])), gone = new Set(delta.gone);
  const tombs = new Set(Array.isArray(out.deletedIds) ? out.deletedIds : []);
  const added = [], extended = [], removed = [];
  const ws = [];
  for (const s of S) {
    if (gone.has(s.id)) { removed.push(s.id); continue; }   // this window deleted it
    const m = mm.get(s.id), r = rows.get(s.id);
    if (!m || !r) { ws.push(s); continue; }                // not this window's change: the station's, as it is
    const bh = !has(r, 'b') ? [] : (Number.isInteger(r.bLen) && r.bLen >= 0 ? hist(m).slice(0, r.bLen) : hist(r.b));
    const fields = merge3(has(r, 'b') ? fieldsOf(r.b) : undefined, fieldsOf(m), fieldsOf(s), ['session', s.id], ctx);
    const row = Object.assign({}, fields, { history: mergeHistory(bh, hist(m), hist(s), s.id, ctx) });
    if (!deepEq(row, s)) extended.push(s.id);
    ws.push(row);
  }
  for (const m of M) {
    if (sm.has(m.id)) continue;
    const r = rows.get(m.id);
    if (!r) continue;                                      // unchanged here and removed by another window: it stays removed
    const deleted = has(r, 'b') || tombs.has(m.id) || !!(forgotten && forgotten(m.id, Math.max(num(m.lastActiveAt), num(m.createdAt))));
    if (deleted) {
      // another window deleted this session; what this window did in it cannot land in the station file (kept beside it)
      if (hist(m).length || has(r, 'b')) ctx.lost.push({ kind: 'session', id: m.id, name: String(m.title == null ? 'General' : m.title).slice(0, 64) });
      continue;
    }
    ws.push(m); added.push(m.id);
  }
  out.workstreams = ws;
  // the growth projection, whole, from the side whose rating watermark is newer (a tie: the station's)
  const gs = growthOf(station), gm = growthOf(mine);
  const win = gm.mark > gs.mark ? gm : gs, lose = win === gm ? gs : gm;
  if (win.station !== undefined) out.stationStats = win.station; else if (lose.station !== undefined) out.stationStats = lose.station;
  if (isObj(out.agent)) out.agent = withStats(out.agent, win, lose);
  if (Array.isArray(out.agents)) out.agents = out.agents.map(r => withStats(r, win, lose));
  const doc = Object.assign({ schema: station.schema || mine.schema, version: Math.max(num(station.version), num(mine.version)) }, out);
  const content = d => { const o = Object.assign({}, d); for (const k of ['updatedAt', '_saveRevision', '_saveClient', '_saveDirty', '_saveMerge', '_saveRestore']) delete o[k]; return o; };
  return { doc, changed: !deepEq(content(doc), content(station)), added, extended, removed, overrode: ctx.overrode, lost: ctx.lost };
}

/* write(body, deps) — POST /api/save with _saveMerge (sidecar handleSaveWrite). -> { status, body, wrote: the doc written | null }
   deps: { saveStore, agentId, now (ms), forgotten?(id, ts), cap (bytes the station file takes) }.
   Refusals say what they are (cloudsavecore mergeRefusal): a permanent one (another station, a copy from before a reset, a
   newer save format, too large) stops the window merging; `absent` sends it back to the plain save, which seeds the file;
   anything else (the file unreadable right now, the station moving mid-merge) is asked again. */
function write(body, deps) {
  const reply = (status, b, wrote) => ({ status, body: b, wrote: wrote || null });
  const delta = body && body._saveMerge;
  if (!validDelta(delta) || !CLIENT_RE.test(String(delta.by || ''))) return reply(400, { ok: false, error: 'a merge needs its _saveMerge description' });
  const by = delta.by;
  const mine = Object.assign({}, body); delete mine._saveMerge;
  const store = deps.saveStore, agentId = deps.agentId || 'agent';
  const state = store.loadState(agentId);
  if (state.status === 'unreadable') return reply(200, { ok: false, unreadable: true, error: 'the station file is unreadable right now' });
  const station = state.doc;
  if (!station) return reply(200, { ok: false, absent: true, error: 'there is no station file to merge into' });
  if (num(station.version) > num(mine.version)) return reply(200, { ok: false, newerFormat: true, error: 'the station file is a newer save format' });
  if (store.predatesReset(mine, station)) return reply(200, { ok: false, predatesReset: true, error: 'that save is from before this computer’s station was reset' });
  const founded = d => Number(d && d.agent && d.agent.createdAt);
  if (!(founded(mine) === founded(station) || (Number.isNaN(founded(mine)) && Number.isNaN(founded(station))))) return reply(200, { ok: false, otherStation: true, error: 'that save is of another station' });
  const r = merge(station, mine, delta, { forgotten: deps.forgotten });
  // what could not land is never only in this window: its whole save is kept beside the station (one copy per window)
  const kept = r.lost.length ? store.preserve(agentId, Object.assign({}, mine, { _saveClient: ('kept-' + by).slice(0, 80) })) : null;
  const answer = { merged: true, added: r.added.length, extended: r.extended.length, removed: r.removed.length, overrode: r.overrode.length,
    lost: r.lost.slice(0, 20), ...(kept ? { kept } : {}) };
  // the refused save this window left on the station when it fell behind is in the station file now: not a copy to offer back
  // (discardConflict notes its own failures: a copy that could not be removed is only left beside the station, as before)
  const settle = () => { if (!r.lost.length && typeof store.discardConflict === 'function' && CLIENT_RE.test(String(mine._saveClient || ''))) store.discardConflict(agentId, mine._saveClient); };
  if (!r.changed) { settle(); return reply(200, Object.assign({ ok: true, revision: num(station._saveRevision), updatedAt: num(station.updatedAt), unchanged: true }, answer)); }
  const doc = r.doc;
  const cap = Number(deps.cap) > 0 ? Number(deps.cap) : (16 << 20);
  if (Buffer.byteLength(JSON.stringify(doc)) > cap - (64 << 10)) return reply(200, { ok: false, tooLarge: true, error: 'the merged station would be too large to save' });
  // the station file from before is copied aside, unless the last write was this window's own merge (nothing of another
  // window's to keep since): a run of merges does not copy a multi-MiB station on every save
  const head = state.head || null;
  const backup = (head && head.client === 'adopt-' + by) ? null : store.backup(agentId, 'adopt-' + num(deps.now));
  Object.assign(doc, { updatedAt: Math.max(num(deps.now), num(station.updatedAt) + 1), _saveRevision: num(station._saveRevision), _saveClient: 'adopt-' + by, _saveDirty: false });
  const result = store.save(agentId, doc, { compareRevision: true });
  if (!result || result.ok !== true) return reply(200, { ok: false, error: result && result.conflict ? 'the station changed during the merge; try again' : 'the station refused the merge' });
  settle();
  return reply(200, Object.assign({ ok: true, revision: result.revision, updatedAt: result.updatedAt }, answer, backup ? { backup } : {}), doc);
}

module.exports = { merge, write, merge3, mergeHistory, validDelta };
