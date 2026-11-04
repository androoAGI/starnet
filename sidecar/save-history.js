/* sidecar/save-history.js — how the save engines read a saved history that holds packed runs (save-history-by-reference, save v7).

   A v7 save may hold a session's `history` as elements { "$ref", "res" } that NAME runs of rows the station's transcript holds
   (frontend/app/historyref.js). Three engines compare and combine saved histories (save-merge.js, save-restore.js and, on the
   page, cloudsavecore.js mergeDelta). They compare ELEMENTS with TurnMerge.sameTurn, and an element is not a row: a run that
   grew on one side reads as a rewritten history, and a row packed on one side and inline on the other is two different things
   (kept twice). So each engine runs its UNCHANGED algorithm on the EXPLODED history — one stub per row,
   { streamId, rowId, …residue, $stub }, which sameTurn compares by key exactly as it compares two inline rows — and packs the
   answer again:

     rowsOf(history, streamId)   the history as rows. A history with nothing packed in it is returned as it is (the same array: the
                                 engines' fast path and their identity answers are untouched); otherwise a new array, the same one for
                                 the same history (an engine asks for it more than once).
     repack(rows, streamId)      rows -> a history: stubs become elements again, everything else stays where it is. A row the result
                                 names twice (a stub beside an inline copy of the same row, or two stubs) is laid down ONCE, at the
                                 place it was first named, as the inline copy when there is one (the page's own copy wins, as in
                                 HistoryRef.expand), so a merge can never leave a row named twice in what it saves. An inline
                                 duplicate of an inline row is not touched: that is the history as the engines were given it.
     hasPacked(history)          does it name rows by reference (an element, or a stub an engine is holding)?

   Pure: no clock, no I/O. The stream a history belongs to is the id of its session. */
'use strict';
const HistoryRef = require('../frontend/app/historyref.js');

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPacked = el => HistoryRef.isRef(el) || HistoryRef.isStub(el);
function hasPacked(history) { return Array.isArray(history) && history.some(isPacked); }

const exploded = new WeakMap();   // a history array -> { id, len, rows }: one explode per history per stream (a history that grew since is read again)
function rowsOf(history, streamId) {
  const list = Array.isArray(history) ? history : [];
  if (!list.some(HistoryRef.isRef)) return list;
  const id = String(streamId == null ? '' : streamId);
  const hit = exploded.get(list);
  if (hit && hit.id === id && hit.len === list.length) return hit.rows;
  const rows = HistoryRef.explode(list, { streamId: id });
  exploded.set(list, { id, len: list.length, rows });
  return rows;
}

// an inline row that has a place in the transcript: the one a stub of the same key would be a second naming of
const keyedRow = el => isObj(el) && !isPacked(el) && Number.isSafeInteger(el.rowId) && el.rowId > 0 && el.idFrom !== 'collision';
const keyOf = (el, id) => HistoryRef.keyOf(el.streamId || id, el.rowId);

// every row of an exploded history named once: a stub whose row is held inline, or by an earlier stub, is dropped, and a stub that
// has an inline copy later in the history is replaced by that copy where the stub stood (the first place the row is named)
function namedOnce(rows, id) {
  const first = new Map();
  for (const el of rows) if (keyedRow(el)) { const k = keyOf(el, id); if (!first.has(k)) first.set(k, el); }
  const placed = new Set(), moved = new Set(), out = [];
  let changed = false;
  for (const el of rows) {
    if (HistoryRef.isStub(el)) {
      const k = keyOf(el, id);
      if (placed.has(k)) { changed = true; continue; }
      placed.add(k);
      const own = first.get(k);
      if (own) { moved.add(own); out.push(own); changed = true; } else out.push(el);
      continue;
    }
    if (moved.has(el)) { changed = true; continue; }
    if (keyedRow(el) && first.get(keyOf(el, id)) === el) placed.add(keyOf(el, id));
    out.push(el);
  }
  return changed ? out : rows;
}

function repack(rows, streamId) {
  if (!hasPacked(rows)) return rows;
  const id = String(streamId == null ? '' : streamId);
  return HistoryRef.pack(namedOnce(HistoryRef.explode(rows, { streamId: id }), id), { streamId: id });
}

module.exports = { rowsOf, repack, hasPacked, namedOnce };
