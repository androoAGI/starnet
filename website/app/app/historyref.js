/* frontend/app/historyref.js — a saved history that NAMES its rows instead of repeating them (save-history-by-reference, save v7).

   The page persists every session's whole transcript inside the one save envelope, although the station's transcript already
   holds every turn the page saw it hold. Save format v7 lets a session's `history` array carry, in place of a run of
   consecutive rows the transcript PROVABLY holds, ONE element:

       { "$ref": "<first rowId, base 36>,<delta to the next rowId, base 36>,…", "res": { "<index in the run>": { …page-only fields } } }

   Every other element of `history` stays an inline row, in place, exactly as before: a local note (sys, error, stopped,
   steerEcho, foreign, truncated), a pending row (a turnId, no rowId), a legacy row (no rowId), a collision row, another stream's
   row, a row two elements both claim, and any row that is not exactly the copy the page last proved. A v6 save with its whole
   history inline therefore IS a valid v7 save: nothing is moved when a save migrates, rows are packed as they are sealed.

   THE PROOF. A row may be packed only if the page holds a SEAL for it — the exact turn object the station returned in a
   successful read, kept in page memory under keyOf(streamId, rowId) and never mutated — and the row still equals that seal field
   for field. Whatever the row holds beyond the seal is RESIDUE (typedText, attachments, stopNote, projectRoot…) and rides in
   `res`. expand(element) is the station's current copy with the residue laid over it, which is the original row. A row that
   drifted, lacks a field of its seal, or has no seal stays inline: the save gets bigger, never lossier.

   WHO PACKS. Workstreams.serialize() hands pack() every hydrated session's history with the seals the page holds (workstreams.js:
   filled by chat.js after every successful station read and by app.js's idle seal sweep). The version bump landed first so the one-way
   door (an older page refuses a v7 save) was taken before any packing existed.

   Pure, UMD (the page, its website mirror and the tests load the SAME module, as turnmerge.js): no DOM, no clock, no randomness,
   no network — the reader is injected.

     encode(ids) -> "2t,1,1" | null          the run codec: first id, then signed deltas, base 36. decode(str) -> ids | null reads
                                             only the canonical form encode writes (a malformed string is null, never a guess)
     keyOf(streamId, rowId)                  the key a seal is held under: "<streamId>:<rowId>"
     snapshotOf(turn) -> {…} | null          the copy of a station turn the page keeps as its seal (plain JSON, strings shared), null if it names no row
     isRef(el) / isStub(row) / hasRef(h)     a packed element / an exploded stub / does a history hold a packed element
     sealable(row, streamId)                 the SHAPE half of eligibility: a rowId, no collision, this stream's or none, not a kind the
                                             transcript does not own. Whether a seal matches is residueOf's
     residueOf(row, snapshot) -> {…} | null  the exact-equality rule: null unless the snapshot names this very row and every field of it
                                             is in the row, equal; else the row's other fields (JSON, deep-copied). A field that would speak for
                                             the row's identity or the format (rowId, streamId, $ref, $stub) is never residue
     pack(rows, { streamId, seal })          rows -> history: sealed rows in runs become elements, everything else is the same
                                             object in the same place. seal is a Map or a function of keyOf(), -> the snapshot or null.
                                             Existing elements and exploded stubs join the runs, so packing is idempotent and canonical
     explode(history, { streamId })          history -> rows with every element replaced by one stub per row,
                                             { streamId, rowId, …residue, $stub: true }, which sameTurn compares by key; the merge
                                             engines run on the exploded form and pack() the result back without any seal. A stub an
                                             engine leaves behind is read by expand() as the one-row element it is, never as a hollow row
     expand(history, { streamId, fetchRows }) -> Promise<{ rows, unproven, retracted, forgotten, doubled, malformed, complete, error }>
                                             every element replaced by the rows it names, from the station. fetchRows(streamId, ids)
                                             -> { turns, missing?, retracted?, forgotten? } (or an array of turns), at most MAX_IDS ids
                                             a call, asked again for only what an answer left out until a round returns nothing.
                                             A row held twice (inline and packed, or packed twice) is one row, at the first place the history names it, the page's own copy winning.
                                             An id the station cannot return and cannot prove retracted or forgotten stays in `rows` as a
                                             packed element (unproven) — it is never dropped; a proven undo/forget leaves the history; an
                                             element that cannot be read is kept as it is (malformed); a throwing reader changes nothing
     idsOf(history) / countOf(history)       the row ids the elements name / how many rows the history holds
     digestOf(rows, { isVisible })           { v, count, visible, latest: { role, text<=200 }, firstUser<=300 } — what the rail and the
                                             title logic read, so they stay truthful while a session's rows are not loaded. Taken of the
                                             rows themselves (before they are packed, or once they are loaded): a packed element adds to
                                             `count` and to nothing else */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HistoryRef = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SINCE_VERSION = 7;       // the save format that introduced the element; an older page refuses a save stamped with it
  const MAX_RUN = 1000;          // rows one element names (one hydrate request carries as many ids)
  const MAX_IDS = 1000;          // ids one fetchRows call asks for
  const MAX_ROUNDS = 32;         // asks of the station per expand, however many segments the rows are spread over
  const MAX_DEPTH = 48;          // nesting a row field may have and still be packed
  const MAX_REF_CHARS = MAX_RUN * 14;   // a base-36 id (<= 11 digits), its sign and its comma
  const DIGEST_LATEST = 200, DIGEST_FIRST = 300;
  // kinds of row the transcript does not own: the page's own notes, failures, stops, steering, other agents' lines and cut markers
  const INLINE_FLAGS = ['sys', 'error', 'stopped', 'steerEcho', 'foreign', 'truncated'];
  const ELEMENT_KEYS = new Set(['$ref', 'res']);
  // names that are the element's, its exploded stub's or the object's own, never a page-only field: residue holding one is no residue
  const RESERVED = new Set(['rowId', 'streamId', '$ref', '$stub', '__proto__']);
  const FIRST_TOKEN = /^[1-9a-z][0-9a-z]*$/;
  const DELTA_TOKEN = /^(?:0|-?[1-9a-z][0-9a-z]*)$/;
  const INDEX_KEY = /^(?:0|[1-9][0-9]{0,5})$/;
  const NOT_JSON = Symbol('not-json');

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isRowId = v => Number.isSafeInteger(v) && v > 0;
  // a plain data object of ANY realm (a vm sandbox's Object.prototype is not ours): no prototype, or the root prototype itself
  function isPlain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }
  const keyOf = (streamId, rowId) => String(streamId) + ':' + rowId;

  // ---- the run codec ----------------------------------------------------------------------------------------------------------
  function encode(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_RUN) return null;
    let out = '', prev = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!isRowId(id)) return null;
      out += (i ? ',' + (id - prev).toString(36) : id.toString(36));
      prev = id;
    }
    return out;
  }
  function decode(ref) {
    if (typeof ref !== 'string' || !ref || ref.length > MAX_REF_CHARS) return null;
    const parts = ref.split(',');
    if (parts.length > MAX_RUN) return null;
    const ids = [];
    let id = 0;
    for (let i = 0; i < parts.length; i++) {
      if (!(i ? DELTA_TOKEN : FIRST_TOKEN).test(parts[i])) return null;
      const n = parseInt(parts[i], 36);
      if (!Number.isSafeInteger(n)) return null;
      id = i ? id + n : n;
      if (!isRowId(id)) return null;
      ids.push(id);
    }
    return ids;
  }

  // ---- JSON values: deep copy and exact equality ---------------------------------------------------------------------------------
  // A copy of a JSON value, or NOT_JSON for anything a save would not carry whole: a function, symbol, bigint, Date or class instance, a
  // non-finite number, a __proto__ key, a cycle (the depth bound). undefined members are what JSON.stringify drops, so they are dropped.
  function cloneJson(v, depth) {
    if (depth > MAX_DEPTH) return NOT_JSON;
    if (v === null) return null;
    switch (typeof v) {
      case 'string': case 'boolean': return v;
      case 'number': return Number.isFinite(v) ? v : NOT_JSON;
      case 'object': {
        if (Array.isArray(v)) {
          const out = new Array(v.length);
          for (let i = 0; i < v.length; i++) { const c = v[i] === undefined ? null : cloneJson(v[i], depth + 1); if (c === NOT_JSON) return NOT_JSON; out[i] = c; }
          return out;
        }
        if (!isPlain(v)) return NOT_JSON;
        const out = {};
        for (const k of Object.keys(v)) {
          if (k === '__proto__') return NOT_JSON;
          if (v[k] === undefined) continue;
          const c = cloneJson(v[k], depth + 1);
          if (c === NOT_JSON) return NOT_JSON;
          out[k] = c;
        }
        return out;
      }
      default: return NOT_JSON;
    }
  }
  function equalJson(a, b, depth) {
    if (a === b) return true;
    if (depth > MAX_DEPTH || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!equalJson(a[i] === undefined ? null : a[i], b[i] === undefined ? null : b[i], depth + 1)) return false;
      return true;
    }
    if (!isPlain(a) || !isPlain(b)) return false;
    let n = 0;
    for (const k of Object.keys(a)) {
      if (a[k] === undefined) continue;
      n++;
      if (!own(b, k) || b[k] === undefined || !equalJson(a[k], b[k], depth + 1)) return false;
    }
    for (const k of Object.keys(b)) if (b[k] !== undefined) n--;
    return n === 0;
  }

  // The copy of a station turn the page keeps as its SEAL: a deep copy of plain JSON values (the rule a residue field follows), strings
  // shared with the original (they never change), null for anything else or a turn that names no row. The page never mutates it.
  function snapshotOf(turn) {
    if (!isPlain(turn) || !isRowId(turn.rowId)) return null;
    const copy = cloneJson(turn, 0);
    return copy === NOT_JSON ? null : copy;
  }

  // ---- eligibility ------------------------------------------------------------------------------------------------------------
  function sealable(row, streamId) {
    if (!isPlain(row) || !isRowId(row.rowId) || row.idFrom === 'collision') return false;
    if (row.streamId && row.streamId !== streamId) return false;
    if (row.role === 'system') return false;
    for (const flag of INLINE_FLAGS) if (row[flag]) return false;
    return true;
  }
  function residueOf(row, snapshot) {
    if (!isPlain(row) || !isPlain(snapshot)) return null;
    if (!isRowId(row.rowId) || snapshot.rowId !== row.rowId) return null;   // a seal that does not name this very row proves nothing
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) continue;
      if (!equalJson(row[k], snapshot[k], 0)) return null;   // a field of the seal the row lacks, or has moved off
    }
    const res = {};
    for (const k of Object.keys(row)) {
      if (row[k] === undefined || (own(snapshot, k) && snapshot[k] !== undefined)) continue;
      if (RESERVED.has(k)) return null;                      // the stream is the element's, never residue; $ref/$stub would be read as the format's own
      const c = cloneJson(row[k], 1);
      if (c === NOT_JSON) return null;
      res[k] = c;
    }
    return res;
  }

  // ---- elements and stubs ---------------------------------------------------------------------------------------------------------
  const isRef = el => isPlain(el) && own(el, '$ref') && typeof el.$ref === 'string';
  const isStub = el => isPlain(el) && el.$stub === true && isRowId(el.rowId);
  const hasRef = history => Array.isArray(history) && history.some(isRef);
  // [{ id, res }] for a readable element, null for anything else (an element is kept as it is when it cannot be read whole)
  function itemsOf(el) {
    if (!isRef(el)) return null;
    for (const k of Object.keys(el)) if (!ELEMENT_KEYS.has(k)) return null;
    const ids = decode(el.$ref);
    if (!ids) return null;
    const items = ids.map(id => ({ id, res: null }));
    if (el.res !== undefined) {
      if (!isPlain(el.res)) return null;
      for (const k of Object.keys(el.res)) {
        if (!INDEX_KEY.test(k) || Number(k) >= ids.length || !isPlain(el.res[k])) return null;
        const c = cloneJson(el.res[k], 1);
        if (c === NOT_JSON || Object.keys(c).some(f => RESERVED.has(f))) return null;   // residue never speaks for the row's identity
        if (Object.keys(c).length) items[Number(k)].res = c;
      }
    }
    return items;
  }
  // items -> elements (MAX_RUN rows an element); a run's residue is indexed from its own first row
  function elementsOf(items) {
    const out = [];
    for (let at = 0; at < items.length; at += MAX_RUN) {
      const part = items.slice(at, at + MAX_RUN), el = { $ref: encode(part.map(it => it.id)) };
      part.forEach((it, i) => { if (it.res) { el.res = el.res || {}; el.res[i] = it.res; } });
      out.push(el);
    }
    return out;
  }
  // a stub's page-only fields (everything but its id, its marker and its stream), or null if it holds something a save would not carry whole
  function stubResidue(stub) {
    const res = {};
    for (const k of Object.keys(stub)) {
      if (k === 'rowId' || k === '$stub' || k === 'streamId' || stub[k] === undefined) continue;
      if (RESERVED.has(k)) return null;
      const c = cloneJson(stub[k], 1);
      if (c === NOT_JSON) return null;
      res[k] = c;
    }
    return res;
  }
  // a stub of this stream (or of none) is a one-row element in the exploded form
  const ownStub = (el, streamId) => isStub(el) && (!el.streamId || el.streamId === streamId);
  const stubItems = stub => { const res = stubResidue(stub); return res ? [{ id: stub.rowId, res: Object.keys(res).length ? res : null }] : null; };
  const lookupOf = seal => typeof seal === 'function' ? seal : (seal && typeof seal.get === 'function' ? key => seal.get(key) : () => null);

  function pack(rows, opts) {
    const list = Array.isArray(rows) ? rows : [];
    const streamId = opts && typeof opts.streamId === 'string' ? opts.streamId : '';
    if (!streamId) return list.slice();
    const seal = lookupOf(opts.seal);
    // pass 1: how many elements claim each (stream, rowId). An id two elements claim is a collision the page cannot arbitrate, so
    // no inline row holding it packs (a stub or an element already packed stays packed: it has no inline copy to keep)
    const claims = new Map();
    const claim = k => claims.set(k, (claims.get(k) || 0) + 1);
    for (const el of list) {
      if (isRef(el)) { const ids = decode(el.$ref); if (ids) for (const id of ids) claim(keyOf(streamId, id)); }
      else if (isPlain(el) && isRowId(el.rowId) && el.idFrom !== 'collision') claim(keyOf(el.streamId || streamId, el.rowId));
    }
    // pass 2: runs of consecutive packable elements; anything else is the same object in the same place
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { for (const el of elementsOf(run)) out.push(el); run = []; } };
    for (const el of list) {
      const items = itemsOf(el);
      if (items) { for (const it of items) run.push(it); continue; }
      if (ownStub(el, streamId)) {
        const stub = stubItems(el);
        if (stub) { run.push(stub[0]); continue; }
      } else if (sealable(el, streamId) && claims.get(keyOf(streamId, el.rowId)) === 1) {
        const snapshot = seal(keyOf(streamId, el.rowId));
        const res = snapshot ? residueOf(el, snapshot) : null;
        if (res) { run.push({ id: el.rowId, res: Object.keys(res).length ? res : null }); continue; }
      }
      flush();
      out.push(el);
    }
    flush();
    return out;
  }

  function explode(history, opts) {
    const list = Array.isArray(history) ? history : [];
    const streamId = opts && typeof opts.streamId === 'string' ? opts.streamId : '';
    const out = [];
    for (const el of list) {
      const items = itemsOf(el);
      if (!items) { out.push(el); continue; }
      for (const it of items) {
        const stub = {};
        if (streamId) stub.streamId = streamId;
        stub.rowId = it.id;
        if (it.res) Object.assign(stub, it.res);   // itemsOf has already refused residue that names the row's identity
        stub.$stub = true;
        out.push(stub);
      }
    }
    return out;
  }

  function idsOf(history) {
    const out = [];
    for (const el of Array.isArray(history) ? history : []) {
      const items = itemsOf(el);
      if (items) for (const it of items) out.push(it.id);
    }
    return out;
  }
  function countOf(history) {
    let n = 0;
    for (const el of Array.isArray(history) ? history : []) { const items = itemsOf(el); n += items ? items.length : 1; }
    return n;
  }

  // ---- expand ---------------------------------------------------------------------------------------------------------------------
  async function expand(history, opts) {
    const list = Array.isArray(history) ? history : [];
    const o = opts || {};
    const streamId = typeof o.streamId === 'string' ? o.streamId : '';
    const out = { rows: [], unproven: [], retracted: [], forgotten: [], doubled: 0, malformed: 0, complete: true, error: null };
    // an element names rows; so does a stub an engine left in a history (it is one row's element, and is read the same way)
    const parsed = list.map(el => isRef(el) ? { items: itemsOf(el) } : (ownStub(el, streamId) ? { items: stubItems(el) } : null));
    if (!parsed.some(Boolean)) { out.rows = list.slice(); return out; }

    // rows the history already holds inline: the page's own copy wins over a packed duplicate, and is never asked for.
    // inlineBy: the first inline element holding each (stream, rowId)
    const inlineBy = new Map();
    list.forEach((el, i) => { if (!parsed[i] && isPlain(el) && isRowId(el.rowId) && el.idFrom !== 'collision') { const k = keyOf(el.streamId || streamId, el.rowId); if (!inlineBy.has(k)) inlineBy.set(k, i); } });
    const wanted = [], seen = new Set(inlineBy.keys());
    for (const p of parsed) {
      if (!p || !p.items) continue;
      for (const it of p.items) { const k = keyOf(streamId, it.id); if (!seen.has(k)) { seen.add(k); wanted.push(it.id); } }
    }

    // ask the station for them, again for only what a budgeted answer left out, until a round resolves nothing
    const station = new Map(), gone = new Map();
    if (wanted.length && streamId && typeof o.fetchRows === 'function') {
      let pending = wanted;
      for (let round = 0; pending.length && round < MAX_ROUNDS && !out.error; round++) {
        let progress = 0;
        for (let at = 0; at < pending.length && !out.error; at += MAX_IDS) {
          const chunk = pending.slice(at, at + MAX_IDS), asked = new Set(chunk);
          let reply;
          try { reply = await o.fetchRows(streamId, chunk); } catch (e) { out.error = String((e && e.message) || e || 'the read failed'); break; }
          if (!reply || typeof reply !== 'object') { out.error = 'the read answered nothing'; break; }
          const turns = Array.isArray(reply) ? reply : (Array.isArray(reply.turns) ? reply.turns : []);
          for (const turn of turns) {
            if (!isPlain(turn) || !asked.has(turn.rowId) || station.has(turn.rowId) || turn.idFrom === 'collision' || (turn.streamId && turn.streamId !== streamId)) continue;
            const copy = cloneJson(turn, 0);
            if (copy === NOT_JSON) continue;
            station.set(turn.rowId, copy); progress++;
          }
          if (!Array.isArray(reply)) {
            for (const [verdict, ids] of [['retracted', reply.retracted], ['forgotten', reply.forgotten]]) {
              for (const id of Array.isArray(ids) ? ids : []) if (asked.has(id) && !station.has(id) && !gone.has(id)) { gone.set(id, verdict); progress++; }
            }
          }
        }
        pending = pending.filter(id => !station.has(id) && !gone.has(id));
        if (!progress) break;
      }
    } else if (wanted.length) out.error = streamId ? 'no reader for the rows' : 'no stream to read the rows from';

    // lay the history out again, in place. A row the history names more than once (inline and packed, or packed twice) is ONE row, at
    // the first place it is named, so a packed run keeps its order; the page's own inline copy, when there is one, is the row.
    const placed = new Set();
    let waiting = [];
    const flush = () => { if (waiting.length) { for (const el of elementsOf(waiting)) out.rows.push(el); waiting = []; } };
    list.forEach((el, i) => {
      const p = parsed[i];
      if (!p) {
        if (isPlain(el) && isRowId(el.rowId) && el.idFrom !== 'collision') {
          const k = keyOf(el.streamId || streamId, el.rowId);
          if (inlineBy.get(k) === i) { if (placed.has(k)) { out.doubled++; return; } placed.add(k); }
        }
        flush(); out.rows.push(el); return;
      }
      if (!p.items) { flush(); out.rows.push(el); out.malformed++; return; }
      for (const it of p.items) {
        const k = keyOf(streamId, it.id);
        if (placed.has(k)) { out.doubled++; continue; }
        placed.add(k);
        if (inlineBy.has(k)) { flush(); out.rows.push(list[inlineBy.get(k)]); continue; }
        const turn = station.get(it.id);
        if (turn) { flush(); out.rows.push(it.res ? Object.assign({}, turn, cloneJson(it.res, 0)) : Object.assign({}, turn)); }
        else if (gone.has(it.id)) (gone.get(it.id) === 'retracted' ? out.retracted : out.forgotten).push(it.id);
        else { out.unproven.push(it.id); waiting.push(it); }
      }
    });
    flush();
    out.complete = !out.rows.some(isRef);
    return out;
  }

  // ---- the digest -------------------------------------------------------------------------------------------------------------------
  const visibleRow = r => isPlain(r) && !r.sys && !r.hidden && !r.internal && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string';
  function digestOf(rows, opts) {
    const list = Array.isArray(rows) ? rows : [];
    const isVisible = opts && typeof opts.isVisible === 'function' ? opts.isVisible : visibleRow;
    let visible = 0, firstUser = null, latest = null;
    for (const r of list) {
      if (isRef(r) || !isVisible(r)) continue;
      visible++;
      if (firstUser === null && r.role === 'user' && typeof r.content === 'string' && r.content.trim()) firstUser = r.content.slice(0, DIGEST_FIRST);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (!isRef(r) && isVisible(r) && typeof r.content === 'string' && r.content.trim()) { latest = { role: r.role, text: r.content.slice(0, DIGEST_LATEST) }; break; }
    }
    return { v: 1, count: countOf(list), visible, latest, firstUser };
  }

  return { SINCE_VERSION, MAX_RUN, MAX_IDS, encode, decode, keyOf, isRef, isStub, hasRef, sealable, snapshotOf, residueOf, pack, explode, expand, idsOf, countOf, digestOf };
});
