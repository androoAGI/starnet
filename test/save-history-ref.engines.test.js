/* node test/save-history-ref.engines.test.js — INVARIANT engines-keep-every-packed-turn (save-history-by-reference, step S3).

   A v7 save may hold a session's history as packed elements { $ref, res } naming runs of rows the station's transcript holds
   (frontend/app/historyref.js). Three engines compare and combine saved histories, and each used to compare ARRAY ELEMENTS:
   save-merge.js (a window another window saved past: three-way merge), cloudsavecore.js mergeDelta (what this window changed
   since the station took its work) and save-restore.js (a preserved window save brought back). Read element by element, a
   run that grew on one side is a REWRITTEN history, and a row packed on one side and inline on the other is two different
   elements: the merge kept both. Packing must be invisible to them: each engine runs its unchanged algorithm on the EXPLODED
   rows (one stub per row, which sameTurn compares by key) and packs the answer again.

   Over seeded random base / window / station histories, each side packing a different subset of its rows (a row packed on
   one side and inline on the other included), with residue (typedText…), sys and legacy rows:
     · the merged history, EXPANDED, is exactly what the same merge makes of the same histories held inline; no row of
       either side is lost; no row is NAMED twice in what is saved (counted on the names in the document, not on what an
       expand would make of them); no exploded stub is left in a saved history;
     · a merge whose answer is the station's or the window's hands that history back untouched (a merge that brings nothing
       new writes nothing);
     · cloudsavecore.mergeDelta counts the base's rows, not its elements (bLen), whether or not they are packed;
     · save-restore brings back the same sessions, the same turns; a restored COPY carries its rows by value (a copy is a new
       stream and must outlive the original), through an injected inflate that reads the transcript; with none, or when the
       transcript cannot return a row, the session is UNPLACED, never a silent empty copy;
   and the other half of the step:
     · the last station file an older build can read is kept ONCE, exclusively, BEFORE the first v7 replace
       (agent.save.pre-history-ref.json); when it cannot be kept the replace goes on only if the old main survives as the
       .bak, else the save is refused with the named write failure;
     · that copy follows deletes (a forgotten session is cut out of it, ~restored copies and undo rows too) and goes 30 days
       after the new format has read back, so a deleted chat never outlives its delete there;
     · sidecar/remote/host.js, UNCHANGED, still reads a packed history through the transcript. */
'use strict';
const A = require('./_assert.js');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEEDS = Math.max(1, Number(process.env.SAVE_HISTORY_REF_SEEDS) || 300);
const clone = v => JSON.parse(JSON.stringify(v));
const deepEq = (a, b, msg) => { try { assert.deepStrictEqual(a, b); A.ok(true); return true; } catch (e) { A.ok(false, msg + ' — ' + String(e.message).split('\n').slice(0, 10).join(' | ')); return false; } };
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const H = require('../frontend/app/historyref.js');
const Core = require('../frontend/app/cloudsavecore.js');
const SaveMerge = require('../sidecar/save-merge.js');
const SaveRestore = require('../sidecar/save-restore.js');
const SaveInflate = require('../sidecar/save-inflate.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const SaveWire = require('../sidecar/save-wire.js');

const SID = 'sess';
const keyOf = id => SID + ':' + id;

// ---- the station's transcript, the page's copy of a row, and a station that serves them ------------------------------------------
function turnOf(id, role, extra) {
  return Object.assign({ streamId: SID, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: 1000000 + id, content: role + ' ' + id, rowId: id },
    role === 'user' ? { turnId: 'turn-' + id.toString(36).padStart(8, 'a') } : { sourceRunId: 'run-' + (id >> 1) }, extra || null);
}
// the fake station: serves the transcript's turns, in answers of at most `perCall` rows (the real read's budget), with ids it
// holds back (hide), proves undone (retracted) or deleted (forgotten); readRows is the same station read synchronously
function stationOver(transcript, o) {
  o = o || {};
  const calls = [];
  function read(streamId, ids) {
    calls.push(ids.slice());
    const out = { turns: [], missing: [], retracted: [], forgotten: [] };
    let served = 0;
    for (const id of ids) {
      const t = streamId === SID ? transcript.get(id) : null;
      if (o.retracted && o.retracted.has(id)) { out.retracted.push(id); continue; }
      if (o.forgotten && o.forgotten.has(id)) { out.forgotten.push(id); continue; }
      if (!t || (o.hide && o.hide.has(id)) || (o.perCall && served >= o.perCall)) { out.missing.push(id); continue; }
      served++; out.turns.push(clone(t));
    }
    return out;
  }
  return { calls, readRows: (streamId, ids) => read(streamId, ids), fetchRows: async (streamId, ids) => read(streamId, ids) };
}
// what an expand makes of a saved history against that station
const expandOf = async (history, transcript, o) => (await H.expand(history, { streamId: SID, fetchRows: stationOver(transcript, o).fetchRows }));
// every (stream, row id) a saved history NAMES, counted on the names themselves: inline rows and the ids inside elements
function names(history) {
  const out = new Map();
  const add = k => out.set(k, (out.get(k) || 0) + 1);
  for (const el of history) {
    if (H.isRef(el)) { for (const id of H.decode(el.$ref) || []) add(SID + ':' + id); }
    else if (el && typeof el === 'object' && Number.isSafeInteger(el.rowId) && el.rowId > 0 && el.idFrom !== 'collision') add(String(el.streamId || SID) + ':' + el.rowId);
  }
  return out;
}
const timesNamed = history => Array.from(names(history).values()).filter(n => n > 1).length;
const stubs = history => history.filter(H.isStub).length;

// ---- a random scenario: a base, a window that moved on, a station another window moved on -----------------------------------------
function scenario(seed) {
  const r = rng(seed), pick = n => Math.floor(r() * n), chance = p => r() < p;
  let next = 10 + pick(50), local = 0;
  const transcript = new Map();
  const mint = () => {
    next += 1 + (chance(0.2) ? pick(5) : 0);
    const role = chance(0.5) ? 'user' : 'assistant';
    const t = turnOf(next, role, chance(0.12) ? { attachments: [{ id: 'att-' + next, name: 'f.png' }] } : null);
    transcript.set(next, t);
    const row = clone(t);
    if (role === 'user' && chance(0.3)) row.typedText = 'typed ' + next;          // page-only fields ride as residue
    if (chance(0.1)) row.stopNote = 'stopped early';
    return row;
  };
  const note = () => (chance(0.5) ? { role: 'assistant', content: 'status ' + (++local), sys: true } : { role: chance(0.5) ? 'user' : 'assistant', content: 'legacy ' + (++local) });
  const base = [];
  for (let i = pick(10); i > 0; i--) base.push(chance(0.18) ? note() : mint());
  const kind = pick(5);   // 0 only the station grew · 1 only the window grew · 2 both · 3 the window rewrote (a retry) · 4 the window cleared
  const news = [];        // time-ordered rows added after the base: 0 both windows hold it · 1 only the window · 2 only the station
  for (let i = 1 + pick(10); i > 0; i--) { const where = pick(3); news.push({ where, row: where !== 0 && chance(0.15) ? note() : mint() }); }
  const bw = kind === 3 ? base.slice(0, Math.max(0, base.length - 1 - pick(Math.max(1, base.length)))) : kind === 4 ? [] : base;
  const W = bw.concat(kind === 0 ? [] : news.filter(n => n.where !== 2).map(n => n.row));
  const S = base.concat(kind === 1 ? [] : news.filter(n => n.where !== 1).map(n => n.row));
  // each side packs its own subset of the rows it holds (all, most, some, none), from the seals it has. The window's seals include the
  // base's when `same` (the page keeps what it proved while it lives: the common prefix reads the same in the base and in the window);
  // otherwise it packs afresh (a reload: the base's rows may be inline where the window's are packed, and the other way round)
  const packWith = (rows, sealed) => H.pack(clone(rows), { streamId: SID, seal: k => (sealed.has(k) ? clone(transcript.get(Number(k.split(':')[1]))) : null) });
  const sealSet = (rows, keep) => { const p = [0, 0.4, 0.8, 1][pick(4)], sealed = new Set(keep || []); for (const row of rows) if (Number.isSafeInteger(row.rowId) && chance(p)) sealed.add(keyOf(row.rowId)); return sealed; };
  const sealedBase = sealSet(base), same = chance(0.5);
  const sealedWindow = same ? sealSet(W.filter(row => base.indexOf(row) < 0), sealedBase) : sealSet(W);
  return { transcript, B: base, W, S, Bp: packWith(base, sealedBase), Wp: packWith(W, sealedWindow), Sp: packWith(S, sealSet(S)), kind, same, r, pick, chance };
}

// a station save holding one session
const docOf = (history, extra) => Object.assign({ schema: 'starnet.save', version: 7, updatedAt: 5000, _saveRevision: 3, agent: { id: 'agent', name: 'NOVA', createdAt: 5000 },
  agents: [], generalId: SID, activeId: SID, deletedIds: [], workstreams: [{ id: SID, title: 'T', history }] }, extra || null);
const historyOf = doc => doc.workstreams.find(w => w.id === SID).history;

(async () => {
  // ================================================================================================================
  // 1. NAMED: the two shapes the engines read wrongly element by element
  // ================================================================================================================
  {
    const transcript = new Map();
    const T = (id, role) => { const t = turnOf(id, role || (id % 2 ? 'user' : 'assistant')); transcript.set(id, t); return t; };
    for (let i = 1; i <= 6; i++) T(i);
    const sealed = new Set([1, 2, 3, 4, 5, 6].map(keyOf));
    const packRows = ids => H.pack(ids.map(id => clone(transcript.get(id))), { streamId: SID, seal: k => (sealed.has(k) ? clone(transcript.get(Number(k.split(':')[1]))) : null) });
    const inline = ids => ids.map(id => clone(transcript.get(id)));
    const contentOf = rows => rows.map(r => r.rowId);

    // a packed run that GREW on one side: not a rewritten history
    {
      const ctx = { overrode: [], lost: [] };
      const out = SaveMerge.mergeHistory(packRows([1, 2, 3]), packRows([1, 2, 3, 4]), packRows([1, 2, 3, 5]), SID, ctx);
      const got = await expandOf(out, transcript);
      A.eq(contentOf(got.rows), [1, 2, 3, 5, 4], 'a packed run that grew in the window and in the station keeps the station\'s rows, then the window\'s: 1,2,3,5,4');
      A.eq(timesNamed(out), 0, 'and no row is named twice (a run that grew read as a rewrite kept rows 1-3 twice)');
      A.eq(ctx.overrode, [], 'and nothing is reported overridden: the window only added');
    }
    // the same row packed on one side, inline on the other
    {
      const out = SaveMerge.mergeHistory(inline([1, 2]), inline([1, 2, 3]), packRows([1, 2, 3]), SID, { overrode: [], lost: [] });
      A.eq(contentOf((await expandOf(out, transcript)).rows), [1, 2, 3], 'a row inline in the window and packed in the station is one row');
      A.eq(timesNamed(out), 0, '...named once');
      A.eq(stubs(out), 0, '...and no stub is left in the history');
    }
    // the other way round
    {
      const out = SaveMerge.mergeHistory(packRows([1, 2]), packRows([1, 2, 3]), inline([1, 2, 3]), SID, { overrode: [], lost: [] });
      A.eq(contentOf((await expandOf(out, transcript)).rows), [1, 2, 3], 'a row packed in the window and inline in the station is one row');
      A.eq(timesNamed(out), 0, '...named once');
    }
    // an inline copy that names no stream is the session's row all the same (sameTurn keys on the stream it is given)
    {
      const noStream = clone(transcript.get(3)); delete noStream.streamId;
      const out = SaveMerge.mergeHistory(inline([1, 2]), inline([1, 2]).concat([noStream]), packRows([1, 2, 3]), SID, { overrode: [], lost: [] });
      A.eq(contentOf((await expandOf(out, transcript)).rows), [1, 2, 3], 'an inline row with no stream beside the same row packed is one row');
      A.eq(timesNamed(out), 0, '...named once');
    }
    // the window's rows are kept whole when the station's history is packed and the window rewrote its own
    {
      const out = SaveMerge.mergeHistory(packRows([1, 2, 3]), packRows([1, 2, 4]), packRows([1, 2, 3, 5]), SID, { overrode: [], lost: [] });
      A.eq(contentOf((await expandOf(out, transcript)).rows), [1, 2, 4, 5], 'a window that rewrote the tail keeps its rewrite and what the station added');
    }
    // a merge whose answer is the station\'s hands the station\'s history back untouched
    {
      const s = packRows([1, 2, 3, 4]), b = packRows([1, 2, 3, 4]);
      A.ok(SaveMerge.mergeHistory(b, packRows([1, 2, 3, 4]), s, SID, { overrode: [], lost: [] }) === s, 'a window that changed nothing: the station\'s own history object comes back');
      const w = packRows([1, 2, 3, 4, 5]);
      A.ok(SaveMerge.mergeHistory(packRows([1, 2, 3, 4]), w, packRows([1, 2, 3, 4]), SID, { overrode: [], lost: [] }) === w, 'a station that changed nothing: the window\'s own history object comes back');
    }
    // a pending row (a turn id, no row id) is kept beside a packed copy of its turn: never dropped
    {
      const pending = { role: 'user', content: 'pending', turnId: 'turn-zzzzzzzz' };
      const out = SaveMerge.mergeHistory(packRows([1, 2]), packRows([1, 2]).concat([pending]), packRows([1, 2, 3]), SID, { overrode: [], lost: [] });
      const rows = (await expandOf(out, transcript)).rows;
      A.ok(rows.some(r => r.content === 'pending') && contentOf(rows.filter(r => r.rowId)).join() === '1,2,3', 'a pending row is kept (and the station\'s row too): nothing is dropped');
    }
    // mergeDelta counts the base\'s ROWS, packed or not
    {
      const base = docOf(packRows([1, 2, 3])), mine = docOf(packRows([1, 2, 3, 4]));
      const packed = Core.mergeDelta(base, mine), plain = Core.mergeDelta(docOf(inline([1, 2, 3])), docOf(inline([1, 2, 3, 4])));
      A.eq(packed.rows, plain.rows, 'a window that only added rows to a packed run sends the base WITHOUT its history and the count of base rows (bLen 3), as it would inline');
      A.eq(packed.rows[0] && packed.rows[0].bLen, 3, 'bLen counts rows (3), not elements (1)');
      const rewrote = Core.mergeDelta(docOf(packRows([1, 2, 3])), docOf(packRows([1, 2, 6])));
      A.ok(rewrote.rows[0] && rewrote.rows[0].bLen === undefined && Array.isArray(rewrote.rows[0].b.history), 'a window that rewrote a packed run sends the base whole');
    }
    // the sidecar merge, end to end, over a delta
    {
      const base = docOf(packRows([1, 2, 3])), mine = docOf(packRows([1, 2, 3, 4])), station = docOf(packRows([1, 2, 3, 5]));
      const delta = Core.mergeDelta(base, mine);
      const r = SaveMerge.merge(station, mine, delta, {});
      A.eq(contentOf((await expandOf(historyOf(r.doc), transcript)).rows), [1, 2, 3, 5, 4], 'merge(): the window\'s new row lands after the station\'s, nothing twice');
      A.eq(timesNamed(historyOf(r.doc)), 0, 'merge(): no row named twice');
      const same = SaveMerge.merge(station, docOf(packRows([1, 2, 3])), Core.mergeDelta(base, docOf(packRows([1, 2, 3]))), {});
      A.ok(!same.changed, 'merge(): a window that changed nothing brings nothing new (no write)');
    }
  }

  // ================================================================================================================
  // 2. SEEDED: packing is invisible to the merge, the delta and the restore
  // ================================================================================================================
  const started = Date.now();
  const ONLY = process.env.SAVE_HISTORY_REF_ONLY ? Number(process.env.SAVE_HISTORY_REF_ONLY) : null;
  const packedIds = h => new Set(h.filter(H.isRef).reduce((all, el) => all.concat(H.decode(el.$ref) || []), []));
  const inlineIds = h => new Set(h.filter(el => !H.isRef(el) && el.rowId).map(el => el.rowId));
  let bad = 0, firstBad = '', identity = 0, rewrote = 0, mixed = 0, ran = 0;
  for (let seed = ONLY || 1; seed <= (ONLY || SEEDS); seed++) {
    const sc = scenario(seed);
    ran++;
    const label = 'seed ' + seed + ' (kind ' + sc.kind + ')';
    const fails = [];
    const check = (cond, msg) => { if (!cond) fails.push(msg); };
    // --- save-merge.mergeHistory
    {
      const ctxP = { overrode: [], lost: [] }, ctxI = { overrode: [], lost: [] };
      const sI = clone(sc.S), wI = clone(sc.W);
      const oracle = SaveMerge.mergeHistory(clone(sc.B), wI, sI, SID, ctxI);
      const actual = SaveMerge.mergeHistory(clone(sc.Bp), clone(sc.Wp), clone(sc.Sp), SID, ctxP);
      const got = await expandOf(actual, sc.transcript);
      try { assert.deepStrictEqual(got.rows, oracle); } catch (e) { check(false, 'mergeHistory expanded differs from the inline merge: ' + JSON.stringify(got.rows.map(r => r.rowId || r.content)) + ' vs ' + JSON.stringify(oracle.map(r => r.rowId || r.content))); }
      check(timesNamed(actual) === 0, 'mergeHistory names a row twice: ' + JSON.stringify(Array.from(names(actual)).filter(e => e[1] > 1)));
      check(stubs(actual) === 0, 'mergeHistory leaves ' + stubs(actual) + ' stub(s) in the saved history');
      check(JSON.stringify(ctxP.overrode) === JSON.stringify(ctxI.overrode) && JSON.stringify(ctxP.lost) === JSON.stringify(ctxI.lost), 'mergeHistory reports differently when packed: ' + JSON.stringify([ctxP, ctxI]));
      // identity: the answer is the station\'s or the window\'s own history
      const sP = clone(sc.Sp), wP = clone(sc.Wp), bP = clone(sc.Bp);
      const a2 = SaveMerge.mergeHistory(bP, wP, sP, SID, { overrode: [], lost: [] });
      const o2 = SaveMerge.mergeHistory(clone(sc.B), clone(sc.W), sI, SID, { overrode: [], lost: [] });
      if (o2 === sI) {
        identity++;
        if (sc.same) check(a2 === sP, 'the merge answered the station\'s history but not as the station\'s own object');
        else check(JSON.stringify(a2) === JSON.stringify(sP), 'the merge answered the station\'s history but changed how it is packed');
      }
      if (sc.kind === 3) rewrote++;
      const sPacked = packedIds(sc.Sp), wPacked = packedIds(sc.Wp);
      if ([...inlineIds(sc.Wp)].some(id => sPacked.has(id)) || [...inlineIds(sc.Sp)].some(id => wPacked.has(id))) mixed++;
    }
    // --- cloudsavecore.mergeDelta + save-merge.merge over the documents
    {
      const baseP = docOf(clone(sc.Bp)), mineP = docOf(clone(sc.Wp)), stationP = docOf(clone(sc.Sp));
      const baseI = docOf(clone(sc.B)), mineI = docOf(clone(sc.W)), stationI = docOf(clone(sc.S));
      const dP = Core.mergeDelta(baseP, mineP), dI = Core.mergeDelta(baseI, mineI);
      // the delta counts ROWS: a window that kept the base's rows (packed the same way) says so as it would inline. A base packed another
      // way than the window (a reload) is sent whole, which is the larger and the safe description of the same change
      if (sc.same) try { assert.deepStrictEqual(dP.rows.map(r => ({ id: r.id, bLen: r.bLen, whole: r.b && Array.isArray(r.b.history) })), dI.rows.map(r => ({ id: r.id, bLen: r.bLen, whole: r.b && Array.isArray(r.b.history) }))); }
      catch (e) { check(false, 'mergeDelta describes the change differently when packed: ' + JSON.stringify(dP.rows.map(r => [r.bLen, !!(r.b && r.b.history)])) + ' vs ' + JSON.stringify(dI.rows.map(r => [r.bLen, !!(r.b && r.b.history)]))); }
      const rP = SaveMerge.merge(stationP, mineP, dP, {}), rI = SaveMerge.merge(stationI, mineI, dI, {});
      const hP = historyOf(rP.doc), hI = historyOf(rI.doc);
      const got = await expandOf(hP, sc.transcript);
      try { assert.deepStrictEqual(got.rows, hI); } catch (e) { check(false, 'merge() history expanded differs from the inline merge: ' + JSON.stringify(got.rows.map(r => r.rowId || r.content)) + ' vs ' + JSON.stringify(hI.map(r => r.rowId || r.content))); }
      check(timesNamed(hP) === 0, 'merge() names a row twice');
      check(stubs(hP) === 0, 'merge() leaves a stub in the saved history');
      check(rP.changed === rI.changed && JSON.stringify(rP.extended) === JSON.stringify(rI.extended), 'merge() changed/extended differ when packed: ' + JSON.stringify([rP.changed, rP.extended, rI.changed, rI.extended]));
    }
    // --- save-restore: the same sessions come back, the same turns; a copy by value
    {
      const withUndo = sc.chance(0.25);
      const cp = withUndo ? { kind: 'clear', at: 4000, rows: [{ id: SID, history: clone(sc.Bp) }] } : null;
      const cpI = withUndo ? { kind: 'clear', at: 4000, rows: [{ id: SID, history: clone(sc.B) }] } : null;
      const cur = docOf(clone(sc.Sp), cp ? { sessionUndo: cp } : null), pre = docOf(clone(sc.Wp));
      const curI = docOf(clone(sc.S), cpI ? { sessionUndo: cpI } : null), preI = docOf(clone(sc.W));
      pre.workstreams[0].lastActiveAt = preI.workstreams[0].lastActiveAt = 6000;
      const inflate = SaveInflate.makeInflate({ readRows: stationOver(sc.transcript).readRows });
      const planP = SaveRestore.plan(cur, pre, { inflate }), planI = SaveRestore.plan(curI, preI, {});
      check(JSON.stringify([planP.added, planP.extended, planP.copied, planP.unplaced]) === JSON.stringify([planI.added, planI.extended, planI.copied, planI.unplaced]),
        'restore decides differently when packed: ' + JSON.stringify([planP.added, planP.extended, planP.copied, planP.unplaced]) + ' vs ' + JSON.stringify([planI.added, planI.extended, planI.copied, planI.unplaced]));
      const nPlus = SaveRestore.restorable(cur, pre, { inflate }), nI = SaveRestore.restorable(curI, preI, {});
      check(nPlus === nI, 'restorable() counts ' + nPlus + ' sessions when packed, ' + nI + ' inline');
      for (const w of planI.doc.workstreams) {
        const p = planP.doc.workstreams.find(x => x.id === w.id);
        if (!p) { check(false, 'restore lost session ' + w.id); continue; }
        const rows = (await expandOf(p.history, sc.transcript)).rows;
        try { assert.deepStrictEqual(rows, w.history); } catch (e) { check(false, 'restore: session ' + w.id + ' expanded differs from the inline restore: ' + JSON.stringify(rows.map(r => r.rowId || r.content)) + ' vs ' + JSON.stringify(w.history.map(r => r.rowId || r.content))); }
        check(timesNamed(p.history) === 0 && stubs(p.history) === 0, 'restore: session ' + w.id + ' names a row twice or keeps a stub');
        if (planI.copied.indexOf(w.id) >= 0) check(!p.history.some(el => H.isRef(el) || H.isStub(el)), 'restore: the restored copy ' + w.id + ' still names rows by reference (a copy carries its rows by value)');
      }
      {
        const none = SaveRestore.plan(clone(cur), clone(pre), {});   // no inflate: a copy that needs one is unplaced, never empty
        for (const id of withUndo ? [] : planI.copied) {
          const needs = sc.Wp.some(H.isRef);
          if (needs) check(none.unplaced.indexOf(SID) >= 0 && none.copied.indexOf(id) < 0 && !none.doc.workstreams.some(x => x.id === id), 'restore without inflate: the copy ' + id + ' of a packed history is unplaced, not made');
          else check(none.copied.indexOf(id) >= 0, 'restore without inflate: a copy of an inline history does not need one');
        }
      }
    }
    if (fails.length) { bad++; firstBad = firstBad || (label + ': ' + fails.slice(0, 3).join(' | ')); A.ok(false, label + ': ' + fails.slice(0, 3).join(' | ') + ' (replay: SAVE_HISTORY_REF_ONLY=' + seed + ')'); if (bad > 5) break; }
  }
  A.ok(ONLY != null || (identity > 0 && rewrote > 0 && mixed > 0), 'the generator reaches the shapes it claims: answers that are the station\'s own history (' + identity + '), rewrites (' + rewrote + '), rows packed on one side and inline on the other (' + mixed + ')');
  A.eq(bad, 0, ran + ' seeded base/window/station histories, each side packing its own subset: the engines keep every row and name none twice (' + ((Date.now() - started) / 1000).toFixed(1) + ' s; ' + identity + ' answered with the station\'s own history, ' + rewrote + ' rewrites, ' + mixed + ' mixed packed/inline pairs)' + (firstBad ? ' — first: ' + firstBad : ''));

  // ================================================================================================================
  // 3. A RESTORED COPY CARRIES ITS ROWS BY VALUE
  // ================================================================================================================
  {
    const transcript = new Map();
    for (let i = 1; i <= 8; i++) transcript.set(i, turnOf(i, i % 2 ? 'user' : 'assistant'));
    const seal = k => clone(transcript.get(Number(k.split(':')[1])));
    const rows = ids => ids.map(id => clone(transcript.get(id)));
    const packed = ids => H.pack(rows(ids), { streamId: SID, seal });
    // the station and the preserved window both moved on from [1,2] in different directions: the window becomes a restored copy
    const cur = docOf(packed([1, 2, 3, 4])), pre = docOf(packed([1, 2, 5, 6]));
    pre.workstreams[0].lastActiveAt = 9000;
    const station = stationOver(transcript);
    const inflate = SaveInflate.makeInflate({ readRows: station.readRows });
    const plan = SaveRestore.plan(cur, pre, { inflate });
    A.eq(plan.copied, [SID + '~restored'], 'a diverged window is restored as a copy');
    const copy = plan.doc.workstreams.find(w => w.id === SID + '~restored');
    A.ok(copy && Array.isArray(copy.history), 'the copy holds a history');
    A.eq(copy && copy.history.map(r => r.rowId), [1, 2, 5, 6], 'the copy holds every row of the preserved window, in order');
    A.ok(copy && !copy.history.some(el => H.isRef(el) || H.isStub(el)), 'by value: no element names a row of a stream the copy is not');
    A.eq(copy && copy.history.map(r => r.content), [1, 2, 5, 6].map(id => transcript.get(id).content), 'with the station\'s copy of each row');
    A.ok(plan.doc.workstreams.find(w => w.id === SID).history.some(H.isRef), 'the station\'s own session stays packed');
    A.eq(station.calls.map(ids => ids.join()), ['1,2,5,6'], 'the transcript is asked for the rows once (a ref for rows the preserved window shares with the station is still a row to carry)');
    // with no way to read the transcript: unplaced, never an empty copy
    const none = SaveRestore.plan(cur, pre, {});
    A.eq([none.copied, none.unplaced], [[], [SID]], 'no inflate: the session is unplaced');
    A.ok(!none.doc.workstreams.some(w => /~restored/.test(w.id)), 'and no copy is made (never a silent empty one)');
    A.eq(SaveRestore.restorable(cur, pre, {}), 0, 'restorable() does not offer what plan() would leave unplaced');
    // the transcript cannot return a row of it: unplaced
    const partial = SaveRestore.plan(cur, pre, { inflate: SaveInflate.makeInflate({ readRows: stationOver(transcript, { hide: new Set([5]) }).readRows }) });
    A.eq([partial.copied, partial.unplaced], [[], [SID]], 'a row the transcript cannot return (and cannot prove gone): the session is unplaced');
    // a row the transcript proves undone or deleted is not in the copy: exactly what a reload shows
    const gone = SaveRestore.plan(cur, pre, { inflate: SaveInflate.makeInflate({ readRows: stationOver(transcript, { retracted: new Set([5]), forgotten: new Set([6]) }).readRows }) });
    A.eq(gone.doc.workstreams.find(w => w.id === SID + '~restored').history.map(r => r.rowId), [1, 2], 'rows the transcript proves undone or forgotten are left out of the copy');
    // a copy of an inline history needs no inflate
    const inl = SaveRestore.plan(docOf(rows([1, 2, 3, 4])), docOf(rows([1, 2, 5, 6])), {});
    A.eq([inl.copied, inl.unplaced], [[SID + '~restored'], []], 'an inline preserved window is restored as a copy without an inflate (as before)');
    // a session the station does not have comes back with its own id: it stays packed (same stream)
    const added = SaveRestore.plan(Object.assign(docOf([]), { workstreams: [] }), pre, {});
    A.eq(added.added, [SID], 'a session the station lacks is added');
    A.ok(added.doc.workstreams[0].history.some(H.isRef), 'under its own id the added session keeps its packed runs (the stream is the same)');
    // an extend into a restored copy slot carries the new rows by value too
    const curCopy = docOf(packed([1, 2, 3, 4]));
    curCopy.workstreams.push({ id: SID + '~restored', title: 'T (restored copy)', history: rows([1, 2, 5]) });
    const ext = SaveRestore.plan(curCopy, pre, { inflate });
    A.eq([ext.extended, ext.copied, ext.doc.workstreams.find(w => w.id === SID + '~restored').history.map(r => r.rowId)], [[SID + '~restored'], [], [1, 2, 5, 6]], 'a preserved window that continues an earlier copy extends it, by value');
  }

  // ================================================================================================================
  // 4. inflate: the synchronous twin of expand the restore reads through
  // ================================================================================================================
  {
    A.eq(typeof SaveInflate.makeInflate, 'function', 'save-inflate exports makeInflate');
    const transcript = new Map();
    for (let i = 1; i <= 40; i++) transcript.set(i, turnOf(i, i % 2 ? 'user' : 'assistant'));
    const seal = k => clone(transcript.get(Number(k.split(':')[1])));
    let bad2 = 0, first2 = '';
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed * 7919), pick = n => Math.floor(r() * n), chance = p => r() < p;
      const history = [], res = {};
      let id = 1;
      for (let i = pick(14); i > 0 && id <= 40; i--) {
        const t = r();
        if (t < 0.6) { const row = clone(transcript.get(id)); if (chance(0.3)) row.typedText = 'typed ' + id; history.push(row); id += 1 + pick(2); }
        else if (t < 0.75) history.push({ role: 'assistant', content: 'status ' + i, sys: true });
        else if (t < 0.85 && id > 2) history.push(clone(transcript.get(1 + pick(id - 1))));   // a row named again, inline
        else history.push({ role: 'user', content: 'legacy ' + i });
      }
      const sealedAll = H.pack(history.map(clone), { streamId: SID, seal });
      const o = { retracted: new Set(), forgotten: new Set(), hide: new Set(), perCall: [0, 3, 7][pick(3)] };
      for (let k = pick(3); k > 0; k--) o.retracted.add(1 + pick(40));
      for (let k = pick(3); k > 0; k--) o.forgotten.add(1 + pick(40));
      if (chance(0.25)) o.hide.add(1 + pick(40));
      const station = stationOver(transcript, o);
      const sync = SaveInflate.makeInflate({ readRows: station.readRows })(SID, sealedAll);
      const async_ = await H.expand(sealedAll, { streamId: SID, fetchRows: stationOver(transcript, o).fetchRows });
      let why = '';
      if (async_.complete && !async_.error) { try { assert.deepStrictEqual(sync, async_.rows); } catch (e) { why = 'inflate differs from expand: ' + JSON.stringify(sync && sync.map(x => x.rowId || x.content)) + ' vs ' + JSON.stringify(async_.rows.map(x => x.rowId || x.content)); } }
      else if (sync !== null) why = 'expand could not prove every row but inflate answered';
      if (why) { bad2++; first2 = first2 || ('seed ' + seed + ': ' + why); }
    }
    A.eq(bad2, 0, '120 seeded packed histories, with budgets, undone, forgotten and held-back rows: inflate answers what expand does, and answers nothing when expand cannot prove a row' + (first2 ? ' — first: ' + first2 : ''));
    const t = new Map([[1, turnOf(1, 'user')], [2, turnOf(2, 'assistant')]]);
    const run = H.pack([clone(t.get(1)), clone(t.get(2))], { streamId: SID, seal: k => clone(t.get(Number(k.split(':')[1]))) });
    A.eq(SaveInflate.makeInflate({ readRows: () => { throw new Error('the transcript is unreadable'); } })(SID, run), null, 'a reader that throws: null (the caller leaves the session unplaced)');
    A.eq(SaveInflate.makeInflate({ readRows: () => null })(SID, run), null, 'a reader that answers nothing: null');
    A.eq(SaveInflate.makeInflate({ readRows: stationOver(t).readRows })(SID, [{ role: 'user', content: 'a' }]), [{ role: 'user', content: 'a' }], 'a history with nothing packed comes back as it is, with no read');
    const wrongStream = SaveInflate.makeInflate({ readRows: () => ({ turns: [Object.assign(clone(t.get(1)), { streamId: 'other' }), clone(t.get(2))], missing: [], retracted: [], forgotten: [] }) })(SID, run);
    A.eq(wrongStream, null, 'a row of another stream in the answer is not the row asked for: null');
    const collided = SaveInflate.makeInflate({ readRows: () => ({ turns: [Object.assign(clone(t.get(1)), { idFrom: 'collision' }), clone(t.get(2))], missing: [], retracted: [], forgotten: [] }) })(SID, run);
    A.eq(collided, null, 'a collision row in the answer is not the row asked for: null');
  }

  // ================================================================================================================
  // 5. THE LAST OLDER FILE IS KEPT ONCE, BEFORE THE FIRST v7 REPLACE
  // ================================================================================================================
  const KEPT = 'agent.save.pre-history-ref.json';
  const roots = [];
  const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-pre-history-ref-')); roots.push(r); return r; };
  const DAY = 24 * 60 * 60 * 1000;
  function session(id, extra) { return Object.assign({ id, title: id, history: [{ role: 'user', content: 'hello from ' + id }] }, extra || null); }
  const env = (version, rev, over) => Object.assign({ schema: 'starnet.save', version, updatedAt: 100 + rev, _saveRevision: rev, _saveClient: 'tab1', agent: { id: 'agent', name: 'NOVA ' + version, createdAt: 5000 },
    workstreams: [session('general')] }, over || null);
  // a store over the real disk whose clock we hold, with a log of renames and a hook to make named paths fail
  function rig(root, o) {
    o = o || {};
    const ops = [];
    let failAt = null;
    const cfs = new Proxy(fs, { get(t, p) {
      if (p === 'renameSync') return function (a, b) { ops.push('rename:' + path.basename(String(b))); return t.renameSync.apply(t, arguments); };
      if (p === 'linkSync') return function (a, b) { if (o.noLinks) throw Object.assign(new Error('EPERM: no hard links'), { code: 'EPERM' }); ops.push('link:' + path.basename(String(b))); return t.linkSync.apply(t, arguments); };
      if (p === 'openSync') return function (f) { if (failAt && failAt.test(path.basename(String(f)))) throw Object.assign(new Error('ENOSPC: no space left on device, open ' + f), { code: 'ENOSPC' }); return t.openSync.apply(t, arguments); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    let now = o.start || 1700000000000;
    const store = makeSaveStore({ fs: cfs, pathMod: path, root, clock: { now: () => now } });
    return { store, ops, setNow: v => { now = v; }, now: () => now, failOn: re => { failAt = re; }, file: n => path.join(root, n) };
  }
  const slurp = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const readJson = p => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { absent: true, doc: { version: 0, agent: {}, workstreams: [], sessionUndo: { rows: [] } } });
  {
    // v6 saves keep nothing; the first v7 save keeps the v6 main, before it is replaced
    const root = tmp(), R = rig(root);
    let r = R.store.save('agent', env(6, 0), { compareRevision: true });
    A.ok(r.ok, 'a v6 save lands');
    r = R.store.save('agent', env(6, r.revision, { agent: { id: 'agent', name: 'NOVA 6 later', createdAt: 5000 } }), { compareRevision: true });
    A.ok(r.ok && !fs.existsSync(R.file(KEPT)), 'v6 saves keep nothing');
    const v6Main = fs.readFileSync(R.file('agent.save.json'), 'utf8');
    R.ops.length = 0; R.setNow(1700000000000 + 5 * DAY);
    r = R.store.save('agent', env(7, r.revision, { agent: { id: 'agent', name: 'NOVA 7', createdAt: 5000 } }), { compareRevision: true });
    A.ok(r.ok, 'the first v7 save lands');
    A.ok(fs.existsSync(R.file(KEPT)), 'the first v7 save keeps the last older station file as ' + KEPT);
    const kept = fs.existsSync(R.file(KEPT)) ? readJson(R.file(KEPT)) : null;
    A.eq(kept && kept.doc && [kept.doc.version, kept.doc.agent.name], [6, 'NOVA 6 later'], 'it holds the v6 file that was replaced');
    A.eq(kept && kept.keptAt, 1700000000000 + 5 * DAY, 'stamped with when it was kept (what the 30 days count from)');
    A.eq(kept && Object.assign({}, kept, { keptAt: undefined }) && JSON.stringify(Object.assign({}, kept, { keptAt: undefined })), JSON.stringify(Object.assign({}, JSON.parse(v6Main), { keptAt: undefined })), 'and is the old main otherwise as it was (a drop-in for a downgrade)');
    const iKept = R.ops.indexOf('rename:' + KEPT), iMain = R.ops.lastIndexOf('rename:agent.save.json');
    A.ok(iKept >= 0 && iMain > iKept, 'the copy is in place BEFORE the main is replaced (' + JSON.stringify(R.ops) + ')');
    A.eq(readJson(R.file('agent.save.json')).doc.version, 7, 'and the main is v7');
    // later v7 saves leave it alone
    const bytes = slurp(R.file(KEPT));
    R.ops.length = 0;
    for (let i = 0; i < 3; i++) { r = R.store.save('agent', env(7, r.revision, { agent: { id: 'agent', name: 'NOVA 7 again ' + i, createdAt: 5000 } }), { compareRevision: true }); A.ok(r.ok, 'a later v7 save lands'); }
    A.eq(slurp(R.file(KEPT)), bytes, 'later v7 saves leave the kept copy as it was');
    A.ok(!R.ops.includes('rename:' + KEPT), 'and never write it again (kept once)');
    A.eq(fs.readdirSync(root).filter(n => /\.tmp$/.test(n)), [], 'no temp left behind');
  }
  {
    // a station restarted between the last v6 save and the first v7 save has no memory of its own last write: the same copy
    const root = tmp(), R = rig(root);
    const r = R.store.save('agent', env(6, 0, { agent: { id: 'agent', name: 'before the restart', createdAt: 5000 } }), { compareRevision: true });
    const R2 = rig(root, { start: 1700000000000 + 9 * DAY });
    const r2 = R2.store.save('agent', env(7, r.revision), { compareRevision: true });
    A.ok(r2.ok && fs.existsSync(R2.file(KEPT)), 'a fresh store (no memory of its last write) keeps the older file too');
    A.eq(fs.existsSync(R2.file(KEPT)) && [readJson(R2.file(KEPT)).doc.agent.name, readJson(R2.file(KEPT)).keptAt], ['before the restart', 1700000000000 + 9 * DAY], 'with the file it replaced, stamped by the store\'s clock');
  }
  {
    // exclusive: a copy that is already there is never replaced
    const root = tmp(), R = rig(root);
    let r = R.store.save('agent', env(6, 0), { compareRevision: true });
    fs.writeFileSync(R.file(KEPT), 'SENTINEL: an earlier copy');
    r = R.store.save('agent', env(7, r.revision), { compareRevision: true });
    A.ok(r.ok, 'the save lands');
    A.eq(slurp(R.file(KEPT)), 'SENTINEL: an earlier copy', 'an existing kept copy is not overwritten (exclusive create)');
  }
  {
    // a station already at v7 keeps nothing; a refused save keeps nothing
    const root = tmp(), R = rig(root);
    let r = R.store.save('agent', env(7, 0), { compareRevision: true });
    r = R.store.save('agent', env(7, r.revision), { compareRevision: true });
    A.ok(r.ok && !fs.existsSync(R.file(KEPT)), 'a station that was never older keeps nothing');
    const root2 = tmp(), R2 = rig(root2);
    const first = R2.store.save('agent', env(6, 0), { compareRevision: true });
    const stale = R2.store.save('agent', env(7, first.revision + 99), { compareRevision: true });
    A.ok(!stale.ok && stale.conflict && !fs.existsSync(R2.file(KEPT)), 'a save the station refuses (a stale revision) keeps nothing');
  }
  {
    // the first v7 write may arrive as a MERGE (a window another window saved past)
    const root = tmp(), R = rig(root);
    const first = R.store.save('agent', env(6, 0), { compareRevision: true });
    const stationRev = R.store.save('agent', env(6, first.revision, { workstreams: [session('general', { history: [{ role: 'user', content: 'hello from general' }, { role: 'user', content: 'from the station' }] })] }), { compareRevision: true });
    const base = env(6, first.revision), mine = env(7, first.revision, { workstreams: [session('general', { history: [{ role: 'user', content: 'hello from general' }, { role: 'user', content: 'from the window' }] })] });
    const body = Object.assign({}, mine, { _saveMerge: Object.assign({ by: 'tab2' }, Core.mergeDelta(base, mine)) });
    const out = SaveMerge.write(body, { saveStore: R.store, agentId: 'agent', now: 1700000000000, cap: SaveWire.SAVE_BODY_MAX });
    A.ok(out.status === 200 && out.body.ok, 'the merged save lands (' + JSON.stringify(out.body) + ')');
    A.ok(stationRev.ok && fs.existsSync(R.file(KEPT)) && readJson(R.file(KEPT)).doc.version === 6, 'a first v7 write that is a merge keeps the older file too');
  }
  {
    // ...and through the real handlers (the kit slices them out of index.js: the hook is in the store, the handler is unchanged)
    const K = require('./_save-restore-kit.js');
    const root = K.workspace(), host = K.sidecar(root);
    const post = body => host.fetch('/api/save', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const a = await post(env(6, 0));
    const b = await post(env(7, a.revision));
    A.ok(a.ok && b.ok, 'POST /api/save lands a v6 save and then the first v7 save');
    A.ok(fs.existsSync(path.join(root, KEPT)) && readJson(path.join(root, KEPT)).doc.version === 6, 'POST /api/save: the first v7 save keeps the older file (handlers unchanged)');
    K.cleanup();
  }
  {
    // it cannot be kept (the disk): the replace goes on only if the old main survives as the .bak
    const root = tmp(), R = rig(root);
    let r = R.store.save('agent', env(6, 0), { compareRevision: true });
    const v6Bytes = fs.readFileSync(R.file('agent.save.json'), 'utf8');
    R.failOn(/pre-history-ref/);
    const warns = []; const warn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
    try { r = R.store.save('agent', env(7, r.revision), { compareRevision: true }); } finally { console.warn = warn; }
    A.ok(r.ok, 'the copy could not be made, the old main survives as the .bak (a hard link costs no space): the save goes on');
    A.eq(readJson(R.file('agent.save.json')).doc.version, 7, 'the main is v7');
    A.eq(fs.readFileSync(R.file('agent.save.json.bak'), 'utf8'), v6Bytes, 'and the old main is the .bak, byte for byte');
    A.ok(!fs.existsSync(R.file(KEPT)), 'no half-made copy is left');
    A.ok(warns.some(w => /pre-history-ref/.test(w) && /ENOSPC/.test(w)), 'the sidecar log names what could not be kept and why (' + JSON.stringify(warns.slice(0, 2)) + ')');
  }
  {
    const root = tmp(), R = rig(root, { noLinks: true });
    let r = R.store.save('agent', env(6, 0), { compareRevision: true });
    const v6Bytes = fs.readFileSync(R.file('agent.save.json'), 'utf8');
    R.failOn(/pre-history-ref|\.bak/);
    let thrown = null;
    try { R.store.save('agent', env(7, r.revision), { compareRevision: true }); } catch (e) { thrown = e; }
    A.ok(thrown && thrown.code === 'ENOSPC', 'nothing can hold the old main (no copy, no .bak): the save is refused with the write failure\'s own errno (' + (thrown && thrown.code) + ')');
    A.eq(fs.readFileSync(R.file('agent.save.json'), 'utf8'), v6Bytes, 'and the main is untouched: never a lossy replace');
    const named = thrown ? SaveWire.writeFailureReply(thrown) : null;
    A.eq(named && [named.status, named.body.cause], [500, 'diskFull'], 'it is the existing named failure: the disk is full');
    A.ok(!fs.existsSync(R.file(KEPT)), 'and nothing is kept');
  }

  // ================================================================================================================
  // 6. THE COPY FOLLOWS DELETES AND GOES AFTER 30 DAYS
  // ================================================================================================================
  const SECRET = 'the-deleted-conversation-secret';
  function keptWithSessions(root, R) {
    const first = R.store.save('agent', env(6, 0, { workstreams: [session('general'), session('keep'), session('gone', { history: [{ role: 'user', content: SECRET }] }),
      session('gone~restored', { history: [{ role: 'user', content: SECRET + ' restored' }] }), session('gone~restored2', { history: [{ role: 'user', content: SECRET + ' restored2' }] }),
      session('worker1', { parentStreamId: 'gone', history: [{ role: 'user', content: SECRET + ' worker' }] }), session('keep~restored', { history: [{ role: 'user', content: 'keep restored' }] })],
      sessionUndo: { kind: 'clear', at: 90, rows: [session('gone', { history: [{ role: 'user', content: SECRET + ' undo' }] }), session('keep')] } }), { compareRevision: true });
    const second = R.store.save('agent', env(7, first.revision, { workstreams: [session('general'), session('keep')] }), { compareRevision: true });
    return second;
  }
  {
    const root = tmp(), R = rig(root);
    keptWithSessions(root, R);
    A.ok(slurp(R.file(KEPT)).includes(SECRET), 'setup: the kept copy holds the conversation that is about to be deleted');
    const out = R.store.scrubKept(['gone']);
    const text = slurp(R.file(KEPT));
    A.ok(!text.includes(SECRET), 'a deleted conversation is cut out of the kept copy: its text is nowhere in it (' + JSON.stringify(out) + ')');
    const doc = readJson(R.file(KEPT));
    A.eq(doc.doc.workstreams.map(w => w.id), ['general', 'keep', 'keep~restored'], 'the sessions that were not deleted stay, ~restored copies of the deleted one and its worker threads go');
    A.eq(doc.doc.sessionUndo.rows.map(w => w.id), ['keep'], 'and so does its row in the undo checkpoint');
    A.eq(doc.keptAt, 1700000000000, 'the stamp is not moved by a scrub (30 days still count from when it was kept)');
    A.eq(fs.readdirSync(root).filter(n => /\.tmp$|\.bak$/.test(n) && /pre-history-ref/.test(n)), [], 'the rewrite is atomic and leaves no .bak or temp of the copy (a .bak would keep the deleted chat)');
    const before = slurp(R.file(KEPT));
    R.ops.length = 0;
    R.store.scrubKept(['gone']);
    R.store.scrubKept(['someone-else']);
    A.eq([slurp(R.file(KEPT)) === before, R.ops.includes('rename:' + KEPT)], [true, false], 'a scrub that finds nothing to cut does not rewrite the file');
  }
  {
    // a copy that cannot be rewritten (or read) is removed whole: a forgotten chat is never kept to keep a rollback
    const root = tmp(), R = rig(root);
    keptWithSessions(root, R);
    R.failOn(/pre-history-ref/);
    R.store.scrubKept(['gone']);
    A.ok(!fs.existsSync(R.file(KEPT)), 'a copy that cannot be rewritten is removed whole');
    R.failOn(null);
    const root2 = tmp(), R2 = rig(root2);
    keptWithSessions(root2, R2);
    fs.writeFileSync(R2.file(KEPT), '{ not json');
    R2.store.scrubKept(['gone']);
    A.ok(!fs.existsSync(R2.file(KEPT)), 'a copy that cannot be read cannot be shown to be free of it: removed whole');
    const root3 = tmp(), R3 = rig(root3);
    keptWithSessions(root3, R3);
    R3.store.scrubKept([]); R3.store.scrubKept(undefined); R3.store.scrubKept(['../etc', 7, null]);
    A.ok(fs.existsSync(R3.file(KEPT)), 'no ids, or ids that are not session ids, cut nothing');
  }
  {
    const T0 = 1700000000000;
    const root = tmp(), R = rig(root, { start: T0 });
    keptWithSessions(root, R);
    A.eq(R.store.expireKept('agent'), 'kept', 'a fresh copy is kept');
    R.setNow(T0 + 29 * DAY + 23 * 3600 * 1000);
    A.eq([R.store.expireKept('agent'), fs.existsSync(R.file(KEPT))], ['kept', true], 'just short of 30 days: kept');
    R.setNow(T0 + 30 * DAY);
    A.eq([R.store.expireKept('agent'), fs.existsSync(R.file(KEPT))], ['expired', false], '30 days after it was kept, once v7 has read back: removed');
    A.eq(R.store.expireKept('agent'), 'none', 'and nothing is left to expire');
    // not while the new format has not read back: the main is still the old one, or cannot be read
    const rootB = tmp(), RB = rig(rootB, { start: T0 });
    RB.store.save('agent', env(6, 0), { compareRevision: true });
    fs.writeFileSync(RB.file(KEPT), JSON.stringify({ version: 1, keptAt: T0, doc: env(6, 0) }));
    RB.setNow(T0 + 90 * DAY);
    A.eq([RB.store.expireKept('agent'), fs.existsSync(RB.file(KEPT))], ['kept', true], 'the main is still v6 (v7 has not read back): the rollback copy stays however old');
    const rootC = tmp(), RC = rig(rootC, { start: T0 });
    keptWithSessions(rootC, RC);
    fs.writeFileSync(RC.file('agent.save.json'), '{ torn'); try { fs.unlinkSync(RC.file('agent.save.json.bak')); } catch (_) {}
    RC.setNow(T0 + 90 * DAY);
    A.eq([RC.store.expireKept('agent'), fs.existsSync(RC.file(KEPT))], ['kept', true], 'a main that cannot be read has not read back: kept');
    // a stamp from a clock that was wrong, or none at all
    const rootD = tmp(), RD = rig(rootD, { start: T0 });
    keptWithSessions(rootD, RD);
    const k = readJson(RD.file(KEPT)); k.keptAt = T0 + 400 * DAY; fs.writeFileSync(RD.file(KEPT), JSON.stringify(k));
    A.eq([RD.store.expireKept('agent'), readJson(RD.file(KEPT)).keptAt], ['stamped', T0], 'a stamp from the future is pulled back to now (a wrong clock cannot keep it for ever)');
    delete k.keptAt; fs.writeFileSync(RD.file(KEPT), JSON.stringify(k));
    RD.setNow(T0 + 2 * DAY);
    A.eq([RD.store.expireKept('agent'), readJson(RD.file(KEPT)).keptAt], ['stamped', T0 + 2 * DAY], 'a copy with no stamp is stamped when first seen, not removed on sight');
    RD.setNow(T0 + 2 * DAY + 30 * DAY);
    A.eq([RD.store.expireKept('agent'), fs.existsSync(RD.file(KEPT))], ['expired', false], 'and goes 30 days after that');
    // every agent's copy is seen, not only the hero's (no file is left that nothing cleans up)
    const rootE = tmp(), RE = rig(rootE, { start: T0 });
    keptWithSessions(rootE, RE);
    fs.writeFileSync(RE.file('crew.save.pre-history-ref.json'), JSON.stringify(readJson(RE.file(KEPT))));
    RE.store.save('crew', env(7, 0, { agent: { id: 'crew', name: 'C', createdAt: 5000 } }), { compareRevision: true });
    RE.setNow(T0 + 31 * DAY);
    A.eq(RE.store.expireAllKept().map(x => x.join(':')).sort(), ['agent:expired', 'crew:expired'], 'expireAllKept: every agent\'s copy goes after its 30 days');
    A.eq(fs.readdirSync(rootE).filter(n => /pre-history-ref/.test(n)), [], 'and none is left');
  }

  // ================================================================================================================
  // 7. sidecar/remote/host.js, UNCHANGED, still reads a packed history through the transcript
  // ================================================================================================================
  {
    const crypto = require('node:crypto');
    const { makeRemoteHost } = require('../sidecar/remote/host.js');
    const { make } = require('../sidecar/turn-dual.js');
    let now = 100;
    const dual = make({ now: () => ++now, hash: s => crypto.createHash('sha256').update(s).digest('hex') });
    const rows = [];
    for (let i = 1; i <= 6; i++) rows.push(turnOf(i, i % 2 ? 'user' : 'assistant', { turnId: 'turn-' + i.toString(36).padStart(8, 'a'), sourceRunId: 'run-' + Math.ceil(i / 2) }));
    const seal = k => clone(rows[Number(k.split(':')[1]) - 1]);
    const packedAll = H.pack(clone(rows), { streamId: SID, seal });
    A.eq(packedAll.length, 1, 'setup: six sealed rows are one element');
    const build = history => makeRemoteHost({ now: () => ++now, roster: () => [{ agentId: 'agent' }], deskSessions: () => [{ id: SID, agentId: 'agent', title: 'packed', history, lastActiveAt: 50 }], liveRuns: () => [],
      transcript: { view: (_n, _s, options) => (options && options.op === 'streams' ? [{ streamId: SID, turns: rows.length, preview: 'row 6', lastAt: 60 }] : clone(rows)),
        cacheRetractions: (_s, ids) => ({ state: 'done', retracted: [] }), cacheRetractionsBatch: () => ({ state: 'done', retracted: [] }) },
      turnDual: dual, turnProjection: (s, r) => dual.project(s, r), redact: s => s });
    for (const [label, history] of [['fully packed', packedAll], ['packed beside inline rows', H.pack(clone(rows), { streamId: SID, seal: k => (Number(k.split(':')[1]) <= 3 ? seal(k) : null) })]]) {
      const host = build(history);
      const turns = await host.thread({ streamId: SID, limit: 50 });
      A.eq(turns.map(t => t.rowId), [1, 2, 3, 4, 5, 6], 'host.js (' + label + '): the phone reads every turn through the transcript, in order, none twice');
      A.ok(!JSON.stringify(turns).includes('$ref') && turns.every(t => typeof t.content === 'string' && t.content), 'host.js (' + label + '): a packed element is not drawn as a message');
      const list = await host.threads({ limit: 10 });
      A.ok(list.length === 1 && list[0].streamId === SID, 'host.js (' + label + '): the session is still listed (' + JSON.stringify(list.map(x => [x.streamId, x.turns])) + ')');
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'remote', 'host.js'), 'utf8');
    A.ok(!/historyref|HistoryRef|\$ref/.test(src), 'sidecar/remote/host.js is untouched by the packed history (it holds no knowledge of it: what it does with one is the isProse filter)');
  }

  // ================================================================================================================
  // 8. PRODUCTION WIRING: index.js builds the restore's inflate from the transcript store (the lines it ships, over the real store)
  // ================================================================================================================
  {
    const vm = require('node:vm');
    const crypto = require('node:crypto');
    const { readSidecarSource } = require('./helpers/source');
    const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js'), Dual = require('../sidecar/turn-dual.js');
    const src = readSidecarSource();
    const from = src.indexOf("const saveInflate = require('./save-inflate.js')"), to = src.indexOf('\nconst saveStore = makeSaveStore(', from);
    A.ok(from > 0 && to > from, 'wiring: index.js builds saveInflate just before the saveStore');
    A.ok(to > from && /\binflate: saveInflate\b/.test(src.slice(to, to + 400)), 'wiring: and hands it to the store (the restore handlers read saveStore.inflate)');
    for (const h of ['async function handleSaveConflictRestore(req, res)', 'async function handleSaveAdopt(req, res)', 'function serveSaveConflicts(req, res)']) {
      const body = A.fnBody(src, h);
      A.ok(/inflate: saveStore\.inflate/.test(body), 'wiring: ' + h.replace(/^(async )?function /, '').replace(/\(.*$/, '') + ' hands the store\'s inflate to the planner');
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-inflate-wiring-'));
    roots.push(root);
    const opened = [];
    const open = () => { const io = History.makeSegmentedTranscriptIo({ fs, path, root, segmentBytes: 1500, schedule() {}, onWarning() {} }); opened.push(io); return io; };
    try {
      // a stream of 240 rows over many small segments (one request reads at most eight), beside another stream's
      let ts = 1000000;
      const seed = open();
      const put = (io, extra, stream) => io.appendDurable(Object.assign({ streamId: stream || 's1', agentId: 'agent', role: 'user', kind: 'turn', taintKnown: true, ts: ++ts }, extra));
      const ids = [];
      for (let i = 0; i < 240; i++) {
        if (i % 9 === 4) put(seed, { content: 'other stream ' + i }, 's2');
        ids.push(put(seed, { role: i % 2 ? 'assistant' : 'user', content: 'row ' + i + ' ' + 'x'.repeat(40) }).rowId);
      }
      seed.close();
      const dual = Dual.make({ now: () => 1, hash: s => crypto.createHash('sha256').update(s).digest('hex') });
      const project = (stream, rows) => dual.project(stream, rows, { isCollided: () => false });
      const wire = store => {
        const asked = [];
        const counting = Object.assign({}, store, { rowsByIdsBatch: reqs => { asked.push(reqs.map(r => r.rowIds.length)); return store.rowsByIdsBatch(reqs); } });
        const inflate = vm.runInNewContext(src.slice(from, to) + '\nsaveInflate', { require: m => { if (m === './save-inflate.js') return SaveInflate; throw new Error('unexpected require ' + m); }, transcriptStore: counting, transcriptProjection: project });
        return { inflate, asked };
      };
      const io1 = open(), store1 = Store.makeTranscriptStore({ io: io1, live: new Set(), deletedAt: () => 0 });
      const oracle = project('s1', store1.view('display', 's1', { limit: 5000 })).turns;
      A.eq(oracle.map(t => t.rowId), ids, 'wiring: setup — the display view of the stream is all 240 rows');
      const history = H.pack(clone(oracle), { streamId: 's1', seal: k => clone(oracle.find(t => t.rowId === Number(k.split(':')[1]))) });
      A.eq(history.length, 1, 'wiring: setup — the whole stream is one packed element');
      const w1 = wire(store1);
      const rows = w1.inflate('s1', history);
      A.ok(Array.isArray(rows), 'wiring: the restore\'s inflate reads a 240-row packed history out of the real transcript (' + w1.asked.length + ' requests)');
      deepEq(rows, oracle, 'wiring: and returns exactly the turns a GET of the stream returns');
      A.ok(w1.asked.length >= 2, 'wiring: a stream over more segments than one request reads is asked again for what a request left out (' + JSON.stringify(w1.asked) + ')');
      // a stream the transcript does not hold: nothing is invented, the session is unplaced
      const other = H.pack(clone(oracle).map(t => Object.assign(t, { streamId: 's9' })), { streamId: 's9', seal: k => Object.assign(clone(oracle.find(t => t.rowId === Number(k.split(':')[1]))), { streamId: 's9' }) });
      A.eq(w1.inflate('s9', other), null, 'wiring: rows the transcript cannot return leave the session unplaced (null), not empty');
      io1.close();
      // the Commander undoes a turn: it leaves the history, as it does on a reload
      const undone = ids[100], writer = open();
      put(writer, { role: 'system', kind: 'retract', targets: [undone], reason: 'undo', content: '' });
      writer.close();
      const io2 = open(), store2 = Store.makeTranscriptStore({ io: io2, live: new Set(), deletedAt: () => 0 });
      const after = project('s1', store2.view('display', 's1', { limit: 5000 })).turns;
      A.ok(!after.some(t => t.rowId === undone) && after.length === oracle.length - 1, 'wiring: setup — the undone row is not in the display view');
      deepEq(wire(store2).inflate('s1', history), after, 'wiring: a row the transcript proves undone is left out of the copy');
      io2.close();
    } finally { for (const io of opened) { try { io.close(); } catch (_) {} } }
  }

  // ================================================================================================================
  // 9. THE HANDLERS: the adopt hands the store's inflate to the planner, and never drops a session it could not place
  // ================================================================================================================
  {
    const K = require('./_save-restore-kit.js');
    const transcript = new Map();
    for (let i = 1; i <= 8; i++) transcript.set(i, turnOf(i, i % 2 ? 'user' : 'assistant'));
    const seal = k => clone(transcript.get(Number(k.split(':')[1])));
    const packedIds = ids => H.pack(ids.map(id => clone(transcript.get(id))), { streamId: SID, seal });
    const env = (history, over) => Object.assign({ schema: 'starnet.save', version: 7, agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, generalId: 'general', activeId: 'general', deletedIds: [],
      workstreams: [{ id: 'general', title: null, history: [] }, { id: SID, title: 'T', createdAt: 1, lastActiveAt: 5, history }] }, over || null);
    for (const withInflate of [true, false]) {
      const label = withInflate ? 'with the transcript' : 'without it';
      const root = K.workspace(), host = K.sidecar(root, { inflate: withInflate ? SaveInflate.makeInflate({ readRows: stationOver(transcript).readRows }) : undefined });
      const post = (url, body) => host.fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
      const first = await post('/api/save', env(packedIds([1, 2, 3, 4]), { _saveRevision: 0, _saveClient: 'w1', updatedAt: 1000 }));
      A.ok(first.ok, 'adopt (' + label + '): the station takes a window\'s packed save');
      const stationBytes = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      // the same window comes back with its cached save, which diverged from the station's (both moved on from rows 1,2): it is the base of the merge
      const out = await post('/api/save/adopt', env(packedIds([1, 2, 5, 6]), { _saveRevision: first.revision, _saveClient: 'w1', updatedAt: 2000, _saveAdoptBy: 'w1' }));
      if (withInflate) {
        A.ok(out.ok && out.base === 'window' && out.copied === 1, 'adopt (' + label + '): the station\'s diverged conversation is carried over as a restored copy (' + JSON.stringify(Object.assign({}, out, { doc: undefined })) + ')');
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8')).doc;
        const copy = saved.workstreams.find(w => w.id === SID + '~restored');
        A.eq(copy && copy.history.map(r => r.rowId), [1, 2, 3, 4], 'adopt (' + label + '): by value, the station\'s rows');
        A.ok(saved.workstreams.find(w => w.id === SID).history.every(H.isRef), 'adopt (' + label + '): the window\'s own conversation stays packed');
      } else {
        A.ok(out.ok === false && out.unplaced === 1, 'adopt (' + label + '): the merge is refused rather than dropping a conversation it cannot carry (' + JSON.stringify(out) + ')');
        A.eq(fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8'), stationBytes, 'adopt (' + label + '): and the station file is untouched');
      }
      K.cleanup();
    }
  }

  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} }
  A.report('save-history-ref.engines');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
