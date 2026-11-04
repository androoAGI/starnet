/* sidecar/save-inflate.js — a saved history with every packed run replaced by the rows it names, read from the transcript NOW,
   synchronously (save-history-by-reference, save v7).

   A restored copy of a session (save-restore.js) is a NEW stream: it has no transcript of its own, and it must outlive the session
   it was copied from, so its rows are carried by value. save-restore.js is pure, so it is handed this function (opts.inflate) and
   never reads anything itself. This is the synchronous twin of HistoryRef.expand — expand is the page's async read; a restore is a
   synchronous handler over the station's own transcript store — with the same rules (test/save-history-ref.engines.test.js holds
   the two to each other):

     inflate(streamId, history) -> rows | null
       history  any mix of inline rows, packed elements { $ref, res } and exploded stubs of that stream
       rows     the same history in the same order, every packed row replaced by the transcript's copy with the page-only residue laid
                over it; a row held both inline and packed is laid down once, at the first place it is named, as the inline copy;
                a row the transcript proves undone or deleted is left out (exactly what a reload shows)
       null     a row it names can be neither returned nor proved gone, the reader failed or answered nothing, or an element could
                not be read: the caller leaves that session UNPLACED, never a silent empty copy

   makeInflate({ readRows }): readRows(streamId, rowIds) -> { turns, missing?, retracted?, forgotten? } (or an array of turns),
   synchronous, may throw; the host binds it to the transcript store's rows-by-id read (the same turns a GET returns). It is asked
   for at most HistoryRef.MAX_IDS ids a call, again for only what a budgeted answer left out, until a round resolves nothing. */
'use strict';
const HistoryRef = require('../frontend/app/historyref.js');
const { note: failNote } = require('./failopen.js');

const MAX_IDS = HistoryRef.MAX_IDS, MAX_ROUNDS = 32;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowId = v => Number.isSafeInteger(v) && v > 0;
function copyOf(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } }

function makeInflate(deps) {
  const readRows = deps && deps.readRows;
  return function inflate(streamId, history) {
    if (!Array.isArray(history)) return null;
    const id = typeof streamId === 'string' ? streamId : '';
    const list = HistoryRef.explode(history, { streamId: id });
    if (!list.some(el => HistoryRef.isStub(el) || HistoryRef.isRef(el))) return list;   // nothing is packed: nothing to read
    if (!id || typeof readRows !== 'function') return null;
    const own = el => HistoryRef.isStub(el) && (!el.streamId || el.streamId === id);
    // an element it could not read, or a stub of another stream, cannot be carried into this one
    if (list.some(el => HistoryRef.isRef(el) || (HistoryRef.isStub(el) && !own(el)))) return null;
    const keyed = el => isObj(el) && !HistoryRef.isStub(el) && rowId(el.rowId) && el.idFrom !== 'collision';
    const inline = new Map();
    for (const el of list) if (keyed(el)) { const k = HistoryRef.keyOf(el.streamId || id, el.rowId); if (!inline.has(k)) inline.set(k, el); }
    const wanted = [], seen = new Set(inline.keys());
    for (const el of list) if (own(el)) { const k = HistoryRef.keyOf(id, el.rowId); if (!seen.has(k)) { seen.add(k); wanted.push(el.rowId); } }

    const station = new Map(), gone = new Set();
    let pending = wanted;
    try {
      for (let round = 0; pending.length && round < MAX_ROUNDS; round++) {
        let progress = 0;
        for (let at = 0; at < pending.length; at += MAX_IDS) {
          const chunk = pending.slice(at, at + MAX_IDS), asked = new Set(chunk);
          const reply = readRows(id, chunk);
          if (!reply || typeof reply !== 'object') return null;
          const turns = Array.isArray(reply) ? reply : (Array.isArray(reply.turns) ? reply.turns : []);
          for (const turn of turns) {
            if (!isObj(turn) || !asked.has(turn.rowId) || station.has(turn.rowId) || turn.idFrom === 'collision' || (turn.streamId && turn.streamId !== id)) continue;
            const copy = copyOf(turn);
            if (!copy) continue;
            station.set(turn.rowId, copy); progress++;
          }
          if (!Array.isArray(reply)) {
            for (const ids of [reply.retracted, reply.forgotten]) {
              for (const one of Array.isArray(ids) ? ids : []) if (asked.has(one) && !station.has(one) && !gone.has(one)) { gone.add(one); progress++; }
            }
          }
        }
        pending = pending.filter(one => !station.has(one) && !gone.has(one));
        if (!progress) break;
      }
    } catch (e) { failNote('save.inflate.read', e); return null; }
    if (pending.length) return null;

    // lay it out again, in place: a row named more than once is ONE row, at the first place it is named, the inline copy when there is one
    const placed = new Set(), out = [];
    for (const el of list) {
      if (own(el)) {
        const k = HistoryRef.keyOf(id, el.rowId);
        if (placed.has(k)) continue;
        placed.add(k);
        if (inline.has(k)) { out.push(inline.get(k)); continue; }
        const turn = station.get(el.rowId);
        if (!turn) continue;   // proved undone or deleted: it leaves the history
        const residue = {};
        for (const f of Object.keys(el)) if (f !== 'streamId' && f !== 'rowId' && f !== '$stub') residue[f] = copyOf(el[f]);
        out.push(Object.assign(turn, residue));
        continue;
      }
      if (keyed(el)) {
        const k = HistoryRef.keyOf(el.streamId || id, el.rowId);
        if (inline.get(k) === el) { if (placed.has(k)) continue; placed.add(k); }
      }
      out.push(el);
    }
    return out;
  };
}

module.exports = { makeInflate };
