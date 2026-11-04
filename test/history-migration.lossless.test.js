/* node test/history-migration.lossless.test.js — INVARIANT history-pack-lossless (save-history-by-reference, step S2).

   Save format v7 lets a session's `history` name a run of rows the station's transcript holds instead of repeating them
   (frontend/app/historyref.js). Packing is only worth having if it can never cost a turn: whatever the page packs must come
   back, row for row, field for field, in the same place, from the station's copy plus the page-only fields the element keeps.

   Over seeded random histories — user / assistant rows with attachments, typedText, stopNote, projectRoot; sys / error /
   stopped / steerEcho / foreign / truncated rows; pending rows (turnId, no rowId); legacy rows (no rowId); collision rows;
   duplicate rowIds; another stream's rows; and rows that DRIFTED from the copy the page last proved — a fake station that
   serves the sealed snapshots, in small budgeted answers like the real rows-by-id read:
     · pack -> JSON -> expand returns exactly the original rows, in order, none lost, none doubled;
     · a row is packed if and only if it is provable: a row that is not exactly equal to its seal (or has none), is of a kind the
       transcript does not own, has no rowId or a collision id, belongs to another stream, or shares its id with another row
       is never packed and stays inline in place;
     · an id the station will not return and cannot prove retracted or forgotten stays in the history as a packed element (never
       dropped), a proven undo/forget leaves the history, and a later full read restores the original;
     · a v6 save with its whole history inline reads as v7 deepEqual: nothing is moved at migration time. */
'use strict';
const A = require('./_assert.js');
const assert = require('node:assert');

const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; }
};
const Save = require('../frontend/app/save.js');

const deepEq = (a, b, msg) => { try { assert.deepStrictEqual(a, b); A.ok(true); } catch (e) { A.ok(false, msg + ' — ' + String(e.message).split('\n').slice(0, 8).join(' | ')); } };
const clone = v => JSON.parse(JSON.stringify(v));
const wire = v => JSON.parse(JSON.stringify(v));

// mulberry32: the same seed always builds the same histories
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let HistoryRef = null;
try { HistoryRef = require('../frontend/app/historyref.js'); } catch (e) { A.ok(false, 'frontend/app/historyref.js loads (' + String(e.message).split('\n')[0] + ')'); }

// ---- the migration half does not need the module: a v6 save reads as v7, nothing moved ---------------------------------------
const S = 's1', OTHER = 's2';
const KEY = 'starnet.save';
function scenario(seed) {
  const r = rng(seed), pick = n => Math.floor(r() * n), chance = p => r() < p;
  let rowId = 100 + pick(900), ts = 1700000000000 + seed * 1000;
  const next = () => { rowId += 1 + (chance(0.25) ? pick(7) : 0); return rowId; };
  const history = [], seals = new Map(), packable = [], drifted = [], residues = new Map();
  const key = (stream, id) => stream + ':' + id;
  const station = (role, id, extra) => Object.assign({ streamId: S, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: ++ts, content: role + ' ' + id + ' ' + 'x'.repeat(pick(40)), rowId: id },
    role === 'user' ? { turnId: 'turn-' + id.toString(36).padStart(8, 'a') } : { sourceRunId: 'run-' + (id >> 2) }, extra || null);
  const dialogue = [];
  const total = pick(32);
  for (let i = 0; i < total; i++) {
    const t = r();
    if (t < 0.52) {                                                     // a row the station holds
      const id = next();
      const snap = station(chance(0.5) ? 'user' : 'assistant', id, chance(0.2) ? { attachments: [{ id: 'att-' + id, name: 'f' + id + '.png', mime: 'image/png' }] } : null);
      const row = clone(snap), res = {};
      if (chance(0.3)) res.typedText = 'typed ' + id;
      if (chance(0.15)) res.stopNote = 'stopped early';
      if (chance(0.15)) res.projectRoot = 'C:/work/p' + pick(3);
      if (chance(0.1)) res.supersededStatus = { error: true };
      if (!snap.attachments && chance(0.2)) res.attachments = [{ id: 'page-' + id, name: 'p.txt', nested: { deep: [1, 2, { three: 3 }] } }];
      Object.assign(row, res);
      const sealed = chance(0.85);
      let drift = false;
      if (sealed && chance(0.14)) {                                    // the page's copy moved on after the seal
        drift = true;
        const how = pick(4);
        if (how === 0) row.content += ' (edited)';
        else if (how === 1) delete row.taintKnown;
        else if (how === 2 && snap.attachments) row.attachments = [{ id: 'att-' + id, name: 'renamed.png', mime: 'image/png' }];
        else row.ts += 1;
      }
      if (sealed) seals.set(key(S, id), clone(snap));
      history.push(row); dialogue.push({ row, snap, sealed, drift, id });
      packable.push(sealed && !drift);
      if (drift) drifted.push(id);
      residues.set(id, res);
    } else if (t < 0.58) {                                              // a kind the transcript does not own, even with a seal that matches
      const id = next();
      const flag = ['sys', 'error', 'stopped', 'steerEcho', 'foreign', 'truncated'][pick(6)];
      const snap = station('assistant', id, { [flag]: true });
      seals.set(key(S, id), clone(snap)); history.push(clone(snap)); packable.push(false);
    } else if (t < 0.63) { history.push({ role: 'system', sys: true, content: 'note ' + i }); packable.push(false); }
    else if (t < 0.67) { history.push({ role: 'user', content: 'pending ' + i, turnId: 'turn-' + (1000 + i).toString(36).padStart(8, 'b') }); packable.push(false); }
    else if (t < 0.71) { history.push({ role: chance(0.5) ? 'user' : 'assistant', content: 'legacy ' + i }); packable.push(false); }
    else if (t < 0.74 && dialogue.length) {                             // a row whose id the page could not claim (half the time its text is the owner's too: only the flag tells them apart)
      const d = dialogue[pick(dialogue.length)];
      history.push(Object.assign(clone(d.snap), chance(0.5) ? { idFrom: 'collision', content: 'collided ' + i } : { idFrom: 'collision' })); packable.push(false);
    } else if (t < 0.77 && dialogue.length) {                           // the same rowId twice, both exactly the sealed copy
      const d = dialogue[pick(dialogue.length)];
      history.push(clone(d.snap)); packable.push(false);
      seals.set(key(S, d.id), clone(d.snap));
    } else if (t < 0.82) {                                              // another stream's row (its own seal matches it)
      const id = dialogue.length && chance(0.5) ? dialogue[pick(dialogue.length)].id : next();
      const snap = Object.assign(station('user', id), { streamId: OTHER });
      seals.set(key(OTHER, id), clone(snap)); history.push(clone(snap)); packable.push(false);
    } else { history.push({ role: 'assistant', content: 'local ' + i, error: true }); packable.push(false); }
  }
  // the one rule the generator does not decide row by row: an id two page rows hold packs for neither
  const holders = new Map();
  history.forEach(row => { if (row.rowId > 0 && row.idFrom !== 'collision') { const k = key(row.streamId || S, row.rowId); holders.set(k, (holders.get(k) || 0) + 1); } });
  const expect = history.map((row, i) => packable[i] && holders.get(key(row.streamId || S, row.rowId)) === 1);
  return { history, seals, expect, drifted, residues };
}

// a station that serves the sealed snapshots, answering at most `perCall` rows a request like the real rows-by-id read
function stationOver(seals, opts) {
  const o = opts || {}, calls = [];
  const fetchRows = async (streamId, ids) => {
    calls.push(ids.slice());
    const turns = [], missing = [], retracted = [], forgotten = [];
    let served = 0;
    for (const id of ids) {
      if (o.retracted && o.retracted.has(id)) { retracted.push(id); continue; }
      if (o.forgotten && o.forgotten.has(id)) { forgotten.push(id); continue; }
      const snap = seals.get(streamId + ':' + id);
      if (!snap || (o.hide && o.hide.has(id)) || (o.perCall && served >= o.perCall)) { missing.push(id); continue; }
      served++; turns.push(clone(snap));
    }
    return { turns, missing, retracted, forgotten };
  };
  return { fetchRows, calls };
}

(async () => {
  // ================================================================================================================
  // 1. A v6 save with its whole history inline reads as v7, nothing moved
  // ================================================================================================================
  A.ok(Save.CURRENT >= 7, 'the history-by-reference format is save v7 or later (CURRENT ' + Save.CURRENT + ')');
  if (HistoryRef) A.ok(Save.CURRENT >= HistoryRef.SINCE_VERSION, 'a build that can write a packed element stamps a version at or past the one that introduced it');
  for (let seed = 1; seed <= 60; seed++) {
    const { history } = scenario(seed);
    const v6 = { schema: 'starnet.save', version: 6, updatedAt: 1700000000000 + seed, agent: { id: 'agent', name: 'NOVA' },
      workstreams: [{ id: S, title: 'T' + seed, titleStrong: true, history: clone(history), runIds: ['run-1'], cost: { tokens: seed, usd: 0, calls: 1 } },
        { id: 'empty', title: null, history: [] }], futureField: { keep: [seed] } };
    const raw = JSON.stringify(v6);
    mem[KEY] = raw; delete mem[Save.PRE_MIGRATE_BACKUP_KEY];
    const st = Save.loadStatus();
    const want = Object.assign(JSON.parse(raw), { version: Save.CURRENT });
    if (st.status !== 'ok') { A.ok(false, 'seed ' + seed + ': a v6 save loads (' + st.status + ')'); continue; }
    deepEq(st.doc, want, 'seed ' + seed + ': a v6 save with inline history reads as the current version, every row exactly as saved');
    A.eq(Save.fromDoc(JSON.parse(raw)).doc && Save.fromDoc(JSON.parse(raw)).doc.version, Save.CURRENT, 'seed ' + seed + ': the in-memory path stamps the current version');
  }
  // a v6 doc of every older rung still climbs the ladder to the current version
  mem[KEY] = JSON.stringify({ schema: 'starnet.save', version: 5, agent: { id: 'agent' }, workstreams: [{ id: S, history: [{ role: 'user', content: 'old' }] }] });
  const climbed = Save.loadStatus();
  A.eq([climbed.status, climbed.doc && climbed.doc.version, climbed.doc && climbed.doc.workstreams[0].titleStrong, climbed.doc && climbed.doc.workstreams[0].history], ['ok', Save.CURRENT, false, [{ role: 'user', content: 'old' }]], 'a v5 save climbs 5 -> current, its history untouched');

  if (!HistoryRef) { A.report('history-migration.lossless'); return; }
  const H = HistoryRef;

  // ================================================================================================================
  // 2. The codec: base 36 first id, then signed deltas
  // ================================================================================================================
  A.eq(H.encode([101, 102, 103]), '2t,1,1', 'three consecutive rows are "first,1,1"');
  A.eq(H.encode([105, 101, 110]), '2x,-4,9', 'a delta may be negative');
  A.eq(H.encode([7]), '7', 'one row is its id');
  A.eq(H.decode('2t,1,1'), [101, 102, 103], 'and back');
  A.eq(H.decode('2x,-4,9'), [105, 101, 110], '...with negative deltas');
  A.eq(H.decode('7'), [7], '...and the one-row run');
  {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(r() * 40), ids = [];
      for (let k = 0; k < n; k++) ids.push(1 + Math.floor(r() * (r() < 0.2 ? 9007199254740990 : 100000)));
      const s = H.encode(ids);
      if (JSON.stringify(H.decode(s)) !== JSON.stringify(ids) || H.encode(H.decode(s)) !== s) { A.ok(false, 'codec round trip failed for ' + JSON.stringify(ids)); break; }
    }
    A.ok(true, 'codec round trips 300 random runs, small ids and ids near the safe-integer limit');
  }
  for (const bad of ['', ',', '2t,', ',1', '2T', '02', '-2t', '2t,-0', '2t,01', '2t,1.5', '2t, 1', '2t,--1', 'zzzzzzzzzzzzz', '2t,zzzzzzzzzzzzz', '1,-1', '1,-5', ' 1', '1;2', 'ä', '0', '0,1', '9007199254740992', null, undefined, 5, {}, [], '1' + ',1'.repeat(H.MAX_RUN)]) {
    if (H.decode(bad) !== null) A.ok(false, 'decode refuses ' + JSON.stringify(bad) + ' (got ' + JSON.stringify(H.decode(bad)) + ')');
    else A.ok(true);
  }
  A.eq(H.encode([]), null, 'no ids encode to nothing');
  A.eq(H.encode([0]), null, 'a zero id has no row');
  A.eq(H.encode([1.5]), null, 'a fractional id has no row');
  A.eq(H.encode(Array.from({ length: H.MAX_RUN + 1 }, (_, i) => i + 1)), null, 'a run past MAX_RUN is not one element');
  A.eq(H.decode(H.encode(Array.from({ length: H.MAX_RUN }, (_, i) => i + 1))).length, H.MAX_RUN, 'a run of MAX_RUN rows is');

  // ================================================================================================================
  // 3. The element, by hand
  // ================================================================================================================
  const snapOf = (id, role, extra) => Object.assign({ streamId: S, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: 1000 + id, content: 'row ' + id, rowId: id }, extra || null);
  const sealsOf = list => new Map(list.map(row => [S + ':' + row.rowId, clone(row)]));
  {
    const rows = [snapOf(101, 'user'), snapOf(102, 'assistant'), snapOf(103, 'user')];
    const seals = sealsOf(rows);
    deepEq(H.pack(clone(rows), { streamId: S, seal: seals }), [{ $ref: '2t,1,1' }], 'three sealed consecutive rows are ONE element with no residue');
    const withRes = rows.map((r, i) => i === 1 ? Object.assign(clone(r), { typedText: 'typed', attachments: [{ id: 'a', name: 'n' }] }) : clone(r));
    deepEq(H.pack(withRes, { streamId: S, seal: seals }), [{ $ref: '2t,1,1', res: { 1: { typedText: 'typed', attachments: [{ id: 'a', name: 'n' }] } } }], 'page-only fields ride in res under the index in the run');
    A.ok(JSON.stringify(H.pack(clone(rows), { streamId: S, seal: seals })).length <= 48, 'three sealed turns cost at most 48 bytes of history');
    const mixed = [rows[0], { role: 'system', sys: true, content: 'note' }, rows[1], rows[2]].map(clone);
    deepEq(H.pack(mixed, { streamId: S, seal: seals }), [{ $ref: '2t' }, mixed[1], { $ref: '2u,1' }], 'an inline row in the middle splits the run and keeps its place');
    deepEq(H.pack(clone(rows), { streamId: S, seal: new Map() }), clone(rows), 'no seals, nothing packs');
    deepEq(H.pack(clone(rows), { streamId: S }), clone(rows), 'no seal function, nothing packs');
    deepEq(H.pack(clone(rows), {}), clone(rows), 'no stream, nothing packs');
    deepEq(H.pack(clone(rows), { streamId: S, seal: key => key === S + ':102' ? clone(rows[1]) : null }), [rows[0], { $ref: '2u' }, rows[2]].map(x => H.isRef(x) ? x : clone(x)), 'only the sealed row packs');
    const input = clone(rows);
    H.pack(input, { streamId: S, seal: seals });
    deepEq(input, rows, 'pack does not touch the rows it is given');
    deepEq(H.pack(clone(rows), { streamId: S, seal: key => seals.get(key) }), [{ $ref: '2t,1,1' }], 'a seal may be a function of the key as well as a Map');
  }
  // a long run is split at MAX_RUN rows, each element carrying its own indexes
  {
    const rows = Array.from({ length: H.MAX_RUN + 5 }, (_, i) => Object.assign(snapOf(10 + i, i % 2 ? 'assistant' : 'user'), i === H.MAX_RUN + 2 ? { typedText: 'late' } : null));
    const seals = sealsOf(rows.map(r => { const c = clone(r); delete c.typedText; return c; }));
    const packed = H.pack(rows, { streamId: S, seal: seals });
    A.eq(packed.length, 2, 'a run longer than MAX_RUN is two elements');
    A.eq(packed[1].res, { 2: { typedText: 'late' } }, 'the second element indexes from its own first row');
    A.eq(H.idsOf(packed).length, H.MAX_RUN + 5, 'both name every row');
  }
  // eligibility, one class at a time: each of these is sealed with a copy that matches, and each stays inline
  {
    const good = snapOf(201, 'user');
    const cases = {
      'exactly the seal': [good, true],
      'a row that drifted (content edited)': [Object.assign(clone(good), { content: 'edited' }), false],
      'a row missing a field of its seal': [(() => { const c = clone(good); delete c.taintKnown; return c; })(), false],
      'a row whose nested field differs': [Object.assign(clone(good), { attachments: [{ id: 'x', name: 'b' }] }), false, Object.assign(clone(good), { attachments: [{ id: 'x', name: 'a' }] })],
      'a row with extra page-only fields (residue)': [Object.assign(clone(good), { typedText: 't', stopNote: 'n' }), true],
      'a sys row': [Object.assign(clone(good), { sys: true }), false, Object.assign(clone(good), { sys: true })],
      'a system-role row': [Object.assign(clone(good), { role: 'system' }), false, Object.assign(clone(good), { role: 'system' })],
      'an error row': [Object.assign(clone(good), { error: true }), false, Object.assign(clone(good), { error: true })],
      'a stopped row': [Object.assign(clone(good), { stopped: true }), false, Object.assign(clone(good), { stopped: true })],
      'a steer echo': [Object.assign(clone(good), { steerEcho: true }), false, Object.assign(clone(good), { steerEcho: true })],
      'a foreign row': [Object.assign(clone(good), { foreign: true }), false, Object.assign(clone(good), { foreign: true })],
      'a truncated marker': [Object.assign(clone(good), { truncated: true }), false, Object.assign(clone(good), { truncated: true })],
      'a collision row': [Object.assign(clone(good), { idFrom: 'collision' }), false, Object.assign(clone(good), { idFrom: 'collision' })],
      'another stream\'s row': [Object.assign(clone(good), { streamId: OTHER }), false, Object.assign(clone(good), { streamId: OTHER })],
      'a row with no rowId': [(() => { const c = clone(good); delete c.rowId; return c; })(), false],
      'a row with a zero rowId': [Object.assign(clone(good), { rowId: 0 }), false, Object.assign(clone(good), { rowId: 0 })],
      'a row holding a $stub field': [Object.assign(clone(good), { $stub: 0 }), false],
      'a row holding a $ref field': [Object.assign(clone(good), { $ref: 'zz' }), false],
      'a row with a string rowId': [Object.assign(clone(good), { rowId: '201' }), false, Object.assign(clone(good), { rowId: '201' })],
      'a pending row (turnId, no rowId)': [{ role: 'user', content: 'sent', turnId: 'turn-aaaaaaaa' }, false],
      'a row that holds a function': [Object.assign(clone(good), { fn() {} }), false],
      'a row that holds a Date': [Object.assign(clone(good), { when: new Date(0) }), false],
      'a row that holds a non-finite number': [Object.assign(clone(good), { score: Infinity }), false],
      'a row whose own stream the seal does not name': [clone(good), false, (() => { const c = clone(good); delete c.streamId; return c; })()],
      'a row with no stream where the seal names one': [(() => { const c = clone(good); delete c.streamId; return c; })(), false, clone(good)],
      'a row the seal holds under another rowId': [clone(good), false, Object.assign(clone(good), { rowId: 999 })],
      'a seal that names no rowId at all': [clone(good), false, (() => { const c = clone(good); delete c.rowId; return c; })()],
      'a seal that is not an object': [clone(good), false, 'row 201']
    };
    for (const [name, [row, packs, seal]] of Object.entries(cases)) {
      const out = H.pack([row], { streamId: S, seal: new Map([[S + ':' + (row.rowId !== undefined ? row.rowId : good.rowId), seal || clone(good)]]) });
      if (packs) A.ok(out.length === 1 && H.isRef(out[0]), name + ': packs');
      else A.ok(out.length === 1 && out[0] === row, name + ': stays inline, the very same row');
    }
    const dup = [clone(good), clone(good)];
    deepEq(H.pack(dup, { streamId: S, seal: sealsOf([good]) }), dup, 'the same rowId twice: neither packs');
    const dupThird = [snapOf(300, 'user'), clone(good), snapOf(301, 'assistant'), clone(good)];
    deepEq(H.pack(dupThird, { streamId: S, seal: sealsOf(dupThird) }), [{ $ref: '8c' }, dupThird[1], { $ref: '8d' }, dupThird[3]], 'a duplicate keeps only its own holders inline');
    // a collision row is the page's row that could not claim the id: even when it equals the owner's sealed copy in everything but the flag
    // it is not that row, so packing it would name the id twice and the second naming would be taken for a duplicate and dropped
    const twin = [clone(good), Object.assign(clone(good), { idFrom: 'collision' })];
    deepEq(H.pack(twin, { streamId: S, seal: sealsOf([good]) }), [{ $ref: H.encode([201]) }, twin[1]], 'a collision twin of a sealed row stays inline beside the row that owns the id');
    deepEq(H.pack(twin.slice().reverse(), { streamId: S, seal: sealsOf([good]) }), [twin[1], { $ref: H.encode([201]) }], '...in whichever order they stand');
    // a seal map gone wrong (another stream's turn filed under this stream's key) proves nothing, not even for the row that matches it
    const foreignSeal = new Map([[S + ':201', Object.assign(clone(good), { streamId: OTHER })]]);
    const cross = [Object.assign(clone(good), { streamId: OTHER }), clone(good)];
    deepEq(H.pack(cross, { streamId: S, seal: foreignSeal }), cross, 'a seal that belongs to another stream packs neither the row that matches it nor the row that owns the id');
    const otherStreamSameId = [Object.assign(snapOf(401, 'user'), { streamId: OTHER }), snapOf(401, 'assistant')];
    deepEq(H.pack(otherStreamSameId, { streamId: S, seal: new Map([[S + ':401', clone(otherStreamSameId[1])], [OTHER + ':401', clone(otherStreamSameId[0])]]) }), [otherStreamSameId[0], { $ref: 'b5' }], 'the same number in another stream is another row: only this stream\'s packs');
  }

  // ================================================================================================================
  // 4. THE PROPERTY: pack -> JSON -> expand returns the original, row for row
  // ================================================================================================================
  let packedRows = 0, elements = 0, inlineRows = 0, partial = 0, withDrift = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { history, seals, expect, drifted, residues } = scenario(seed);
    const original = wire(history);
    const input = clone(history);
    const packed = H.pack(input, { streamId: S, seal: seals });
    const w = wire(packed);
    const tag = 'seed ' + seed + ': ';
    deepEq(input, history, tag + 'pack leaves its input alone');
    deepEq(w, packed, tag + 'the packed history is plain JSON (nothing is lost to a round trip)');

    // exactly the provable rows packed, in their order
    const wantIds = history.filter((_, i) => expect[i]).map(row => row.rowId);
    deepEq(H.idsOf(w), wantIds, tag + 'exactly the provable rows are packed, in order');
    for (const id of drifted) if (H.idsOf(w).includes(id) && !wantIds.includes(id)) A.ok(false, tag + 'a drifted row (' + id + ') was packed');
    const inline = w.filter(el => !H.isRef(el)), wantInline = original.filter((_, i) => !expect[i]);
    deepEq(inline, wantInline, tag + 'everything else stays inline, untouched and in order');
    A.eq(H.countOf(w), history.length, tag + 'the packed history still counts every row');

    // maximal runs: one element per run of adjacent provable rows
    let runs = 0;
    expect.forEach((e, i) => { if (e && !(i > 0 && expect[i - 1])) runs++; });
    A.eq(w.filter(H.isRef).length, runs, tag + 'one element per run of adjacent provable rows');
    // residue is the page-only fields, by index in the run
    let at = 0;
    for (const el of w) {
      if (!H.isRef(el)) continue;
      const ids = H.decode(el.$ref), want = {};
      ids.forEach((id, i) => { const res = residues.get(id); if (res && Object.keys(res).length) want[i] = wire(res); });
      deepEq(el.res || {}, want, tag + 'the element for ' + ids[0] + ' keeps exactly the page-only fields');
      at += ids.length;
    }
    packedRows += at; elements += w.filter(H.isRef).length; inlineRows += inline.length; if (drifted.length) withDrift++;

    // the station serves the seals, a few rows a request: the whole history comes back
    const perCall = 1 + (seed % 9);
    const fake = stationOver(seals, { perCall });
    const out = await H.expand(w, { streamId: S, fetchRows: fake.fetchRows });
    deepEq(out.rows, original, tag + 'expand returns the original history, row for row, in order');
    A.eq([out.unproven.length, out.retracted.length, out.forgotten.length, out.doubled, out.malformed, out.complete, out.error], [0, 0, 0, 0, 0, true, null], tag + 'nothing unproven, doubled or dropped');
    A.ok(fake.calls.every(ids => ids.length <= H.MAX_IDS), tag + 'no request asks for more than MAX_IDS ids');
    A.eq(fake.calls.flat().length >= wantIds.length, true, tag + 'every packed id was asked for');

    // pack(explode(x)) is x, and packing a packed history changes nothing
    deepEq(H.pack(H.explode(w, { streamId: S }), { streamId: S }), w, tag + 'explode then pack is the identity on a packed history');
    deepEq(H.pack(clone(w), { streamId: S, seal: seals }), w, tag + 'pack is idempotent');
    deepEq(H.explode(w).filter(r => H.isStub(r)).map(r => r.rowId), wantIds, tag + 'explode names the same rows');
    // the chain the invariant names, end to end: pack -> JSON -> explode -> expand is the original again (the engines run on the exploded form)
    const viaStubs = await H.expand(H.explode(w, { streamId: S }), { streamId: S, fetchRows: stationOver(seals, { perCall }).fetchRows });
    deepEq(viaStubs.rows, original, tag + 'explode -> expand returns the original history, row for row, in order');
    A.eq([viaStubs.unproven.length, viaStubs.doubled, viaStubs.malformed, viaStubs.complete], [0, 0, 0, true], tag + '...with nothing unproven, doubled or dropped');

    // a proven undo or forget leaves the history; an id the station will not answer for stays packed; a later read restores it
    if (wantIds.length) {
      const r = rng(seed * 31 + 5), pickSome = () => new Set(wantIds.filter(() => r() < 0.3));
      const retracted = pickSome(), forgotten = new Set([...pickSome()].filter(id => !retracted.has(id))), hide = new Set([...pickSome()].filter(id => !retracted.has(id) && !forgotten.has(id)));
      const dropped = new Set([...retracted, ...forgotten]);
      const part = await H.expand(w, { streamId: S, fetchRows: stationOver(seals, { retracted, forgotten, hide, perCall }).fetchRows });
      deepEq(part.retracted, wantIds.filter(id => retracted.has(id)), tag + 'proven undos are named');
      deepEq(part.forgotten, wantIds.filter(id => forgotten.has(id)), tag + 'proven forgets are named');
      deepEq(part.unproven, wantIds.filter(id => hide.has(id)), tag + 'unanswered ids are named');
      deepEq(H.idsOf(part.rows), wantIds.filter(id => hide.has(id)), tag + 'an unanswered id stays in the history as a packed element, in place');
      A.eq(part.complete, hide.size === 0, tag + 'complete means no packed element is left');
      const want = original.filter((row, i) => !expect[i] || (!dropped.has(row.rowId) && !hide.has(row.rowId)));
      deepEq(part.rows.filter(el => !H.isRef(el)), want, tag + 'every other row is there, exactly, in order');
      const kept = part.rows.filter(H.isRef);
      kept.forEach(el => A.ok(JSON.stringify(Object.keys(el).sort()) === JSON.stringify(el.res ? ['$ref', 'res'] : ['$ref']), tag + 'a kept element is a plain element'));
      // the residue of an unanswered row is kept with it, so the later read restores it whole
      const later = await H.expand(wire(part.rows), { streamId: S, fetchRows: stationOver(seals, { retracted, forgotten }).fetchRows });
      deepEq(later.rows, original.filter((row, i) => !expect[i] || !dropped.has(row.rowId)), tag + 'a later full read restores every unanswered row, residue and all');
      if (hide.size) partial++;
    }
  }
  A.ok(packedRows > 500 && elements > 100 && inlineRows > 500 && partial > 50 && withDrift > 30, 'the seeds exercised the property (packed ' + packedRows + ', elements ' + elements + ', inline ' + inlineRows + ', partial answers ' + partial + ', drifted histories ' + withDrift + ')');

  // ================================================================================================================
  // 5. expand, case by case
  // ================================================================================================================
  const rowsA = [snapOf(11, 'user'), snapOf(12, 'assistant'), snapOf(13, 'user'), snapOf(14, 'assistant')];
  const sealsA = sealsOf(rowsA);
  const packedA = H.pack(clone(rowsA), { streamId: S, seal: sealsA });
  deepEq(packedA, [{ $ref: 'b,1,1,1' }], 'fixture: four rows, one element');
  {
    // no element, no read
    const f = stationOver(sealsA);
    const plain = [{ role: 'user', content: 'x' }, null, 5, 'text', [1]];
    const out = await H.expand(plain, { streamId: S, fetchRows: f.fetchRows });
    deepEq(out.rows, plain, 'a history with no element comes back as it is');
    A.eq(f.calls.length, 0, '...without asking the station anything');
    A.ok(out.rows !== plain, '...in a new array');
    deepEq((await H.expand(undefined, { streamId: S, fetchRows: f.fetchRows })).rows, [], 'a missing history is empty');
  }
  {
    // the page's own copy beats a packed duplicate; two elements naming a row place it once
    const inlineTwin = Object.assign(clone(rowsA[1]), { typedText: 'page truth' });
    const f = stationOver(sealsA);
    const out = await H.expand([{ $ref: 'b,1,1,1' }, inlineTwin, { $ref: 'c,1' }], { streamId: S, fetchRows: f.fetchRows });
    deepEq(out.rows, [rowsA[0], inlineTwin, rowsA[2], rowsA[3]].map(clone).map((r, i) => i === 1 ? inlineTwin : r), 'a row held inline AND packed is one row: the inline copy, at the first place the history names it (inside the run, so the run keeps its order)');
    A.eq(out.doubled, 3, '...and the packed duplicates are counted (12 inline; 12 and 13 again in the second element)');
    deepEq(f.calls.flat(), [11, 13, 14], '...and never asked for');
    const early = await H.expand([inlineTwin, { $ref: 'b,1,1,1' }], { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    deepEq(early.rows, [inlineTwin, rowsA[0], rowsA[2], rowsA[3]], '...and when the inline copy comes first it is the row, first');
    A.eq(early.doubled, 1, '...with the packed duplicate counted');
    const twice = await H.expand([inlineTwin, clone(inlineTwin), { $ref: 'c' }], { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    A.eq(twice.rows.length, 2, "the page's own duplicates are the page's business: two inline copies stay, the packed one is dropped");
    const other = await H.expand([{ $ref: 'b' }, Object.assign(clone(rowsA[0]), { streamId: OTHER })], { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    A.eq(other.rows.length, 2, 'the same number held inline for another stream is another row');
    const collided = await H.expand([{ $ref: 'b' }, Object.assign(clone(rowsA[0]), { idFrom: 'collision' })], { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    A.eq(collided.rows.length, 2, 'a collision row is not the packed row');
  }
  {
    // what a station may answer wrongly is ignored, and the id stays packed
    const wrongStream = async () => ({ turns: [Object.assign(clone(rowsA[0]), { streamId: OTHER })], missing: [] });
    const out = await H.expand([{ $ref: 'b' }], { streamId: S, fetchRows: wrongStream });
    deepEq([out.rows, out.unproven], [[{ $ref: 'b' }], [11]], 'a row of another stream answering for the id is not the row');
    const wrongId = async () => ({ turns: [clone(rowsA[1])] });
    const out2 = await H.expand([{ $ref: 'b' }], { streamId: S, fetchRows: wrongId });
    deepEq([out2.rows, out2.unproven], [[{ $ref: 'b' }], [11]], 'a row that is not the one asked for is not the row');
    const collision = async () => ({ turns: [Object.assign(clone(rowsA[0]), { idFrom: 'collision' })] });
    const out3 = await H.expand([{ $ref: 'b' }], { streamId: S, fetchRows: collision });
    deepEq([out3.rows, out3.unproven], [[{ $ref: 'b' }], [11]], 'a collision row is not proof');
    const array = async (s, ids) => ids.map(id => sealsA.get(S + ':' + id)).filter(Boolean).map(clone);
    deepEq((await H.expand(packedA, { streamId: S, fetchRows: array })).rows, rowsA, 'a bare array of turns is an answer');
    const unknown = async () => ({ turns: [clone(rowsA[0]), clone(snapOf(999, 'user'))], retracted: [12, 5000], forgotten: [13, 5001] });
    const out4 = await H.expand(packedA, { streamId: S, fetchRows: unknown });
    deepEq([out4.rows.filter(r => !H.isRef(r)), out4.retracted, out4.forgotten, out4.unproven], [[rowsA[0]], [12], [13], [14]], 'only the ids asked for are read from an answer');
  }
  {
    // a station that fails, or answers nothing
    const boom = async () => { throw new Error('station down'); };
    const out = await H.expand(packedA, { streamId: S, fetchRows: boom });
    deepEq([out.rows, out.unproven, out.complete, out.error], [packedA, [11, 12, 13, 14], false, 'station down'], 'a read that throws leaves the history packed, whole, with the reason');
    const none = await H.expand(packedA, { streamId: S, fetchRows: async () => null });
    deepEq([none.rows, none.unproven, none.complete], [packedA, [11, 12, 13, 14], false], 'a null answer proves nothing');
    const sync = await H.expand(packedA, { streamId: S, fetchRows: (s, ids) => ({ turns: ids.map(id => clone(sealsA.get(S + ':' + id))) }) });
    deepEq(sync.rows, rowsA, 'a reader that answers at once (not a promise) works');
    const noReader = await H.expand(packedA, { streamId: S });
    deepEq([noReader.rows, noReader.unproven, noReader.complete], [packedA, [11, 12, 13, 14], false], 'no reader, nothing proven, nothing lost');
    const noStream = await H.expand(packedA, { fetchRows: stationOver(sealsA).fetchRows });
    deepEq([noStream.rows, noStream.complete], [packedA, false], 'no stream, nothing proven, nothing lost');
    // the read is asked again for only what it left out, and stops when a round returns nothing
    const f = stationOver(sealsA, { perCall: 1 });
    const slow = await H.expand(packedA, { streamId: S, fetchRows: f.fetchRows });
    deepEq([slow.rows, f.calls], [rowsA, [[11, 12, 13, 14], [12, 13, 14], [13, 14], [14]]], 'a budgeted station is asked again for only the missing ids');
    const f2 = stationOver(sealsA, { hide: new Set([12]) });
    const stuck = await H.expand(packedA, { streamId: S, fetchRows: f2.fetchRows });
    deepEq([stuck.rows, f2.calls, stuck.unproven], [[rowsA[0], { $ref: 'c' }, rowsA[2], rowsA[3]], [[11, 12, 13, 14], [12]], [12]], 'a round that returns nothing ends the asking; the id stays packed in place');
    // more ids than one request carries
    const many = Array.from({ length: H.MAX_IDS + 300 }, (_, i) => snapOf(50 + i, i % 2 ? 'assistant' : 'user'));
    const f3 = stationOver(sealsOf(many));
    const big = await H.expand(H.pack(clone(many), { streamId: S, seal: sealsOf(many) }), { streamId: S, fetchRows: f3.fetchRows });
    deepEq(big.rows, many, 'a history of MAX_IDS + 300 packed rows comes back whole');
    A.ok(f3.calls.length >= 2 && f3.calls.every(ids => ids.length <= H.MAX_IDS), 'in requests of at most MAX_IDS ids');
  }
  {
    // an element that cannot be read is kept as it is, counted, and never dropped
    const poison = JSON.parse('{"__proto__":{"polluted":true}}');
    const unreadable = [{ $ref: 'ZZ' }, { $ref: '' }, { $ref: 'b', res: [] }, { $ref: 'b', res: { 3: { a: 1 } } }, { $ref: 'b', res: { x: { a: 1 } } }, { $ref: 'b', res: { 0: 5 } },
      { $ref: 'b', res: { 0: poison } }, { $ref: 'b', extra: 1 }, { $ref: 'b', res: { 0: { fn() {} } } }, { $ref: 'b', res: { 0: { when: new Date(0) } } },
      // residue is the page's own fields: one that speaks for the row's identity, or for the format, makes the element unreadable
      { $ref: 'b', res: { 0: { rowId: 5 } } }, { $ref: 'b', res: { 0: { streamId: OTHER } } }, { $ref: 'b', res: { 0: { $stub: true } } }, { $ref: 'b', res: { 0: { $ref: 'zz' } } }];
    // a $ref that is not a string is no element at all: an inline row like any other, kept and not counted
    const junk = unreadable.concat([{ $ref: 5 }, { $ref: null, content: 'x' }]);
    const out = await H.expand(junk, { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    A.eq(out.malformed, unreadable.length, 'every unreadable element is counted');
    A.eq(out.rows.length, junk.length, '...and kept in place');
    A.ok(out.rows.every((row, i) => row === junk[i]), '...as the very same objects');
    A.eq({}.polluted, undefined, '...and nothing reached Object.prototype');
    A.eq(H.explode(junk, { streamId: S }).length, junk.length, 'explode keeps them too');
    A.eq(H.idsOf(junk), [], 'no ids are read from them');
    A.eq(H.pack(junk, { streamId: S }).length, junk.length, 'pack keeps them too');
  }

  // ================================================================================================================
  // 6. explode: stubs the engines can compare by key and pack back without a seal
  // ================================================================================================================
  {
    const history = [Object.assign(clone(rowsA[0]), { typedText: 't' }), { role: 'system', sys: true, content: 'n' }, clone(rowsA[1]), clone(rowsA[2])];
    const packed = H.pack(history, { streamId: S, seal: sealsA });
    deepEq(packed, [{ $ref: 'b', res: { 0: { typedText: 't' } } }, history[1], { $ref: 'c,1' }], 'fixture');
    const stubs = H.explode(packed, { streamId: S });
    deepEq(stubs, [{ streamId: S, rowId: 11, typedText: 't', $stub: true }, history[1], { streamId: S, rowId: 12, $stub: true }, { streamId: S, rowId: 13, $stub: true }], 'explode names each packed row by its id, with its page-only fields');
    A.ok(stubs[1] === history[1], 'an inline row is passed through as the same object');
    deepEq(H.explode(packed).map(r => r.streamId), [undefined, undefined, undefined, undefined], 'without a stream the stubs name none');
    // an engine moves a stub, adds a sealed inline row beside it: the whole result is one run again, in the order the engine left it
    const merged = [stubs[2], stubs[0], clone(rowsA[3]), stubs[3]];
    deepEq(H.pack(merged, { streamId: S, seal: sealsA }), [{ $ref: 'c,-1,3,-1', res: { 1: { typedText: 't' } } }], 'stubs and a sealed inline row pack into one run, residue on its own row');
    const stubOnly = H.pack([stubs[2], stubs[0], stubs[3]], { streamId: S });
    deepEq(stubOnly, [{ $ref: 'c,-1,2', res: { 1: { typedText: 't' } } }], 'a stub packs back without any seal, in the order it now holds');
    const out = await H.expand(stubOnly, { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    deepEq(out.rows, [rowsA[1], Object.assign(clone(rowsA[0]), { typedText: 't' }), rowsA[2]], 'and expands in that order, residue on its own row');
    // a stub an engine forgot to pack back is read as the one-row element it is: the row is not lost to a hollow stub
    const leaked = await H.expand(stubs, { streamId: S, fetchRows: stationOver(sealsA).fetchRows });
    deepEq(leaked.rows, [Object.assign(clone(rowsA[0]), { typedText: 't' }), history[1], rowsA[1], rowsA[2]], 'expand reads the stubs of an exploded history too');
    A.eq([leaked.unproven.length, leaked.doubled, leaked.malformed, leaked.complete], [0, 0, 0, true], '...with nothing unproven, doubled or malformed');
    const hollow = await H.expand(stubs, { streamId: S, fetchRows: stationOver(sealsA, { hide: new Set([12]) }).fetchRows });
    deepEq([hollow.rows.length, hollow.unproven, H.idsOf(hollow.rows)], [4, [12], [12]], '...and a stub the station cannot answer for stays in the history as a packed element, in place');
    const unreadableStub = Object.assign({}, stubs[2], { fn() {} });
    deepEq(H.pack([unreadableStub], { streamId: S }), [unreadableStub], 'a stub that holds something a save would not carry whole is left as it is');
    A.eq((await H.expand([unreadableStub], { streamId: S, fetchRows: stationOver(sealsA).fetchRows })).malformed, 1, '...and counted when it is expanded');

    // a stub of another stream cannot be packed as this one's: it stays as it is
    const alien = Object.assign({}, stubs[0], { streamId: OTHER });
    deepEq(H.pack([alien], { streamId: S }), [alien], 'a stub of another stream is left alone');
    // a stub whose id an inline sealed row also holds: the stub packs (it must), the inline row stays
    const dup = H.pack([stubs[0], clone(rowsA[0])], { streamId: S, seal: sealsA });
    deepEq(dup, [{ $ref: 'b', res: { 0: { typedText: 't' } } }, rowsA[0]], 'an inline row sharing a packed id stays inline; expand keeps the inline row');
  }

  // ================================================================================================================
  // 7. digestOf: what the rail needs to stay truthful without the rows
  // ================================================================================================================
  {
    const long = 'w'.repeat(500);
    const rows = [{ role: 'system', sys: true, content: 'note' }, { role: 'user', content: '  ' }, { role: 'user', content: 'first real ask ' + long }, { role: 'assistant', content: 'an answer', rowId: 5 },
      { role: 'assistant', content: 'hidden', hidden: true }, { role: 'user', content: 'internal', internal: true }, { role: 'assistant', content: '   ' }, { role: 'assistant', content: 'last words ' + long }, { role: 'assistant', error: true, content: 'boom', sys: true }];
    const d = H.digestOf(rows);
    A.eq(d.count, 9, 'the digest counts every row');
    A.eq(d.visible, 5, '...and the rows a reader sees (user/assistant text, not sys, hidden or internal)');
    A.eq(d.latest.role, 'assistant', 'the newest visible message is the last non-blank one');
    A.eq(d.latest.text, ('last words ' + long).slice(0, 200), '...cut to 200 characters');
    A.eq(d.firstUser, ('first real ask ' + long).slice(0, 300), 'the first user words are the first non-blank user message, cut to 300');
    deepEq(H.digestOf([]), { v: 1, count: 0, visible: 0, latest: null, firstUser: null }, 'an empty history has an empty digest');
    deepEq(H.digestOf(null), { v: 1, count: 0, visible: 0, latest: null, firstUser: null }, '...and so does no history');
    A.eq(H.digestOf(rows, { isVisible: r => r.rowId === 5 }).visible, 1, 'the page may say what it shows (TurnKinds), and the digest follows');
    A.eq(H.digestOf(rows, { isVisible: r => r.rowId === 5 }).latest.text, 'an answer', '...for the newest message too');
    A.eq(H.countOf([{ $ref: 'b,1,1' }, { role: 'user', content: 'x' }, { $ref: 'nonsense!' }]), 5, 'a packed element counts the rows it names, an unreadable one counts as one');
    A.eq(H.digestOf(packedA).count, 4, 'the digest of a packed history counts its rows');
  }

  A.report('history-migration.lossless');
})();
