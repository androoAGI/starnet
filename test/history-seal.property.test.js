'use strict';
/* node test/history-seal.property.test.js — INVARIANT never-lose-before-the-seal (save-history-by-reference, step S5).

   Save v7 names a run of rows the station's transcript holds instead of repeating it. The page may only do that for a row it has PROVED
   the station holds (a SEAL: the turn exactly as a successful station read returned it) and that still equals its seal field for field.
   Every other row is saved inline where it is. So at every persist, whatever the page has read, sent, lost or been told, reading the
   saved history back from the station must give exactly the history the page holds:

     · expanding the persisted document against the station (HistoryRef.expand, through the real rows route) yields exactly the page's
       live history — a row not yet sealed is inline, a sealed one is packed, one the page changed since is inline again;
     · no persist shrinks a session's reachable turns; serialize() mutates no live row;
     · an undone turn (another window's, or the page's own /undo) does not come back, and neither does a cleared one;
     · a session the page has not read back after a reload is saved verbatim; a station that does not answer changes none of it.

   Seeded sequences of  send · run-end · open (the production reconcile) · seal pass · idle passes (hydration, seal sweep) · retract by
   another window · /undo · clear · undo-clear · edit a row in place · reload · station down/up  against the PRODUCTION page modules
   (Workstreams, HistoryRef, TurnMerge, HistoryFit, chat.js's read seam and seal pass, app.js's idle passes, all lifted by name) and the
   REAL station: the real transcript store over the real segmented io, written by the production run path (test/helpers/turn-fixture.js)
   and read through the real route handlers. Both shipped trees run. HISTORY_SEAL_SEEDS (default 24, at most 400) sets the seeds, and
   SEAL_CONTROL_ROOT=<an older build's frontend/app> runs the same test against that build (the RED proof). */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const { TurnFixture } = require('./helpers/turn-fixture.js');

const ROOTS = process.env.SEAL_CONTROL_ROOT ? ['control'] : ['frontend/app', 'website/app/app'];
const SEEDS = Math.max(1, Math.min(400, Number(process.env.HISTORY_SEAL_SEEDS) || 24));
const STEPS = Math.max(10, Math.min(300, Number(process.env.HISTORY_SEAL_STEPS) || 50));
const FIRST_SEED = Number(process.env.HISTORY_SEAL_SEED) || 20261104;
const SESSIONS = ['s1', 's2', 's3'];
const OPS = ['send', 'send', 'send', 'send', 'attach', 'attach', 'deliver', 'steerRun', 'routineReturn', 'annotateKind', 'annotateKind', 'runEnd', 'open', 'open', 'open', 'sealFire', 'idle', 'idle', 'retractOther', 'undo', 'clear', 'undoClear', 'annotate', 'annotate', 'edit', 'reload', 'reload', 'down', 'up', 'persist'];
const clone = Rig.clone;
const keyOf = (s, id) => s + ':' + id;
const hasRef = h => Array.isArray(h) && h.some(el => el && typeof el.$ref === 'string');
const totals = { kindDeliverables: 0, kindSteers: 0, kindDeliveries: 0, kindsPacked: 0, kindsInline: 0, kindsResidue: 0, attachTurns: 0, attachRows: 0, attachResidue: 0, seeds: 0, persists: 0, checked: 0, packedRows: 0, packedPersists: 0, opens: 0, reloads: 0, hydrations: 0, sealPasses: 0, sweeps: 0, undone: 0, cleared: 0 };

async function runSeed(root, seed) {
  const T = Rig.tree(root), { W, HR, TM } = T;
  const rng = Rig.rng(seed), pick = list => list[Math.floor(rng() * list.length)];
  let now = 1800000000000 + (seed % 100000) * 1000, counter = 0;
  const clock = () => ++now;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-seal-prop-'));
  const fx = new TurnFixture(dir, clock, {});
  const routes = Rig.routes({ store: fx.store, dual: fx.dual, live: fx.live, isCollided: id => fx.io.isCollided(id) });
  const tp = Rig.transport(routes);
  const mintRng = Rig.rng(seed ^ 0x5eed);
  const trace = [], gone = new Set(), queue = [], cleared = new Set(), inflight = new Map();
  let lastDoc = null, boot = new Map(), pg = null, preSnapshot = null, lastClearedId = null;
  const label = () => root + ' seed ' + seed + ' [' + trace.slice(-8).join(' > ') + ']';

  // the oracle's reader of the station: not through the page's transport, so a "station down" changes what the page can read, not what the station holds
  const direct = async (streamId, rowIds) => {
    const res = { code: 0, body: null };
    await routes.handleTranscriptRows({ body: JSON.stringify({ streams: [{ streamId, rowIds }] }) }, res);
    if (res.code !== 200) throw new Error('the oracle read answered ' + res.code);
    return res.body.streams[0];
  };
  const snapshotLive = () => W.all().map(w => ({ id: w.id, hydrated: !w.historyRef, rows: clone(w.history) }));
  const make = init => Rig.page({ tree: T, tp, init, fakeTimers: true, persisted: [], beforePersist: () => { preSnapshot = JSON.stringify(snapshotLive()); },
    onPersist: json => {
      totals.persists++;
      const live = snapshotLive();
      if (preSnapshot !== null && JSON.stringify(live) !== preSnapshot) queue.push({ error: 'serialize() changed a live row', json, live, tag: label() });
      lastDoc = json;
      queue.push({ json, live, tag: label(), boot: new Map(boot) });
    } });
  const startPage = (doc) => {
    pg = make(doc);
    boot = new Map((doc.workstreams || []).map(w => [w.id, w.history]));
    inflight.clear();
  };

  // ---- the check: at one persist ------------------------------------------------------------------------------------------------
  async function verify(item) {
    totals.checked++;
    if (item.error) throw new Error(item.error);
    const doc = JSON.parse(item.json);
    for (const rec of item.live) {
      const w = doc.workstreams.find(x => x.id === rec.id);
      assert.ok(w, 'the persisted doc holds session ' + rec.id);
      if (hasRef(w.history)) { totals.packedPersists++; totals.packedRows += HR.idsOf(w.history).length; }
      if (!rec.hydrated) {
        assert.deepEqual(w.history, item.boot.get(rec.id), rec.id + ': a session whose rows were not read back is saved exactly as it was read');
        continue;
      }
      const out = await HR.expand(w.history, { streamId: rec.id, fetchRows: direct });
      assert.equal(out.malformed, 0, rec.id + ': every packed element is readable');
      assert.equal(out.doubled, 0, rec.id + ': no row is named twice');
      assert.deepEqual(out.unproven, [], rec.id + ': the station can return every row the save names (or proves it undone)');
      const packedIds = new Set(HR.idsOf(w.history));
      // a row another window undid, which this page has not been told about yet, is gone from a packed run exactly as it is gone from a reload
      const expected = rec.rows.filter(r => !(Number.isSafeInteger(r.rowId) && gone.has(keyOf(rec.id, r.rowId)) && packedIds.has(r.rowId)));
      assert.deepEqual(out.rows, expected, rec.id + ': expanding the persisted history against the station gives exactly the page\'s history');
      for (const r of out.rows) if (r.role === 'user' && Array.isArray(r.attachments) && r.attachments.length && packedIds.has(r.rowId)) totals.attachResidue++;
      /* THE ROW KINDS OF TURN IDENTITY (commit 10): a routine's return (kind delivery) is an assistant row, so it is packed like any reply and
         expands back as the page's row; a file the run wrote (kind deliverable) and a steering note (kind steer) are role-system rows, which
         the page keeps inline whatever the station holds. Either way the expansion above already equals the page's history; this holds each
         kind to its side and counts it, so the property is not vacuous for them. */
      for (const r of out.rows) {
        if (r.kind !== 'delivery' && r.kind !== 'deliverable' && r.kind !== 'steer') continue;
        if (r.kind === 'delivery') { assert.equal(r.role, 'assistant', rec.id + ': a routine return is an assistant row'); if (packedIds.has(r.rowId)) { totals.kindsPacked++; if (r.stopNote !== undefined) totals.kindsResidue++; } else totals.kindsInline++; }
        else { assert.equal(r.role, 'system', rec.id + ': a ' + r.kind + ' row is a system row'); assert.ok(!packedIds.has(r.rowId), rec.id + ': a ' + r.kind + ' row is saved where it is, never named by a reference'); totals.kindsInline++; }
      }
      for (const r of out.rows) assert.ok(!(r.rowId && gone.has(keyOf(rec.id, r.rowId)) && packedIds.has(r.rowId)), rec.id + ': an undone row is not brought back by a reference');
    }
  }
  async function drain() { while (queue.length) { const item = queue.shift(); try { await verify(item); } catch (e) { e.message = item.tag + ': ' + e.message; throw e; } } }

  // ---- the ops -------------------------------------------------------------------------------------------------------------------
  const sessionOf = () => W.get(pick(SESSIONS));
  async function finishRun(ws, ran) {
    const { result, ids, reply } = ran;
    ws.history.push(TM.ofTurn({ role: 'assistant', content: reply, ts: clock(), sourceRunId: result.runId, projectRoot: '/work/' + ws.id }, { turnId: result.turnId, sourceRunId: result.runId }));
    pg.busy.delete(ws.id); inflight.delete(ws.id);
    W.touch(ws.id);
    pg.persist();
    if (pg.hasSeal) pg.api.sealSoon(ws);
  }
  const OPFN = {
    // withFile: an ATTACHMENT TURN (attachment-rows-and-taint): the page's row keeps the file's references as residue, and the station's run path
    // writes the directive and one 'attachment' row per file (sidecar/turn-attachment.js), which the page reads back like any row
    async send(mode) {
      const withFile = mode === true;
      const ws = sessionOf();
      if (inflight.has(ws.id)) return;
      dirty.add(ws.id); cleared.delete(ws.id);
      if (W.needsHydration(ws)) { const got = await pg.api.hydrateHistory(ws, { windowMs: 20000 }); if (!got.complete) return; }   // a send waits for its rows
      counter++;
      const text = 'ask ' + counter + ' ' + pick(['alpha', 'beta', 'gamma', 'delta']) + ' ' + 'w'.repeat(Math.floor(rng() * 24));
      const reply = 'answer ' + counter + ' to ' + text.slice(0, 18);
      pg.busy.add(ws.id);
      let files = null;
      if (withFile) { const up = await fx.upload('f' + counter + '.txt', 'text/plain', 'file body ' + counter); files = [{ id: up.id, name: 'f' + counter + '.txt', path: up.path, mediaType: 'text/plain', kind: 'file' }]; }
      const pending = TM.pendingRow(Object.assign({ role: 'user', content: text, ts: clock() }, files ? { attachments: files } : null), mintRng);
      ws.history.push(pending); pg.persist();
      const ids = TM.sendIds(ws.history, { retry: false, now: clock() });
      if (tp.down) {   // the station does not answer: the failure is a row of the page's own
        ws.history.push(TM.ofTurn({ role: 'assistant', content: 'The station did not answer.', error: true, ts: clock() }, ids));
        pg.busy.delete(ws.id); pg.persist(); return;
      }
      /* the other row kinds (commit 10), left by the real run path: 'deliver' = a run that wrote a file (kind deliverable), 'steer' = a run a SEND NOW note
         steered through the real buffer and loop (kind steer, role system) */
      const runOptions = mode === 'deliver' ? { reply, files: [{ kind: 'file', path: 'out/report-' + counter + '.md' }] }
        : mode === 'steer' ? { reply, steer: [{ text: 'make it shorter ' + counter, noteId: 'sn' + counter }], lead: 'On it.', tools: 1 } : { reply };
      const result = await fx.run(Object.assign({ streamId: ws.id, agentId: 'agent', messages: [Object.assign({ role: 'user', content: text }, files ? { attachments: files } : null)] }, ids), runOptions);
      if (mode === 'deliver') totals.kindDeliverables++;
      if (mode === 'steer') totals.kindSteers++;
      if (files) { totals.attachTurns++; totals.attachRows += fx.store.history(ws.id, { limit: 2000 }).filter(r => r.kind === 'attachment' && r.attachment && r.attachment.id === files[0].id).length; }
      TM.bindStart(ws.history, result.start, result.runId, ids); pg.persist();
      const ran = { result, ids, reply };
      if (rng() < 0.25) { inflight.set(ws.id, ran); return; }   // the run is still going on the page: other things happen before it ends
      await finishRun(ws, ran);
    },
    async attach() { return OPFN.send(true); },
    async deliver() { return OPFN.send('deliver'); },
    async steerRun() { return OPFN.send('steer'); },
    // a routine hands its result back to a session (kind delivery): written by the real delivery module over the station's store; no page is connected, so
    // the page meets the row the way a reload does - when it reads the station
    async routineReturn() {
      const ws = sessionOf(); counter++;
      const out = await fx.sessionReturn(ws.id, fx.newId(), 'Routine result ' + counter, null);
      if (out.out && out.asked.length) totals.kindDeliveries++;
    },
    async runEnd() {
      const open = [...inflight.keys()]; if (!open.length) return;
      const id = pick(open); await finishRun(W.get(id), inflight.get(id));
    },
    async open() {
      const ws = sessionOf(), prev = pg.ctx.activeWs;
      dirty.add(ws.id);
      pg.open(ws.id);
      if (prev && prev.id !== ws.id && pg.hasSeal) pg.api.sealLeft(prev);
      totals.opens++;
      const heldBefore = HR.idsOf(ws.historyRef || []).concat(ws.history.map(r => r.rowId).filter(Boolean));
      const ok = await pg.api.loadServerHistory(ws, 3);
      await Rig.flush();
      if (!ok) return;
      for (const id of heldBefore) if (gone.has(keyOf(ws.id, id))) assert.equal(W.sealed(ws.id, id), null, ws.id + ': a turn another window undid is no longer kept as proven once the page has read the station');
      cleared.delete(ws.id);
      for (const r of ws.history) assert.ok(!(r.rowId && gone.has(keyOf(ws.id, r.rowId))), ws.id + ': a row another window undid is not in the conversation once the page has read it');
      pg.persist();
      // a conversation just read is proved: every row of it the station holds goes into the save as a reference, not as a copy
      const w = JSON.parse(lastDoc).workstreams.find(x => x.id === ws.id);
      const inline = w.history.filter(el => !(el && el.$ref) && pg.HR.sealable(el, ws.id) && !drifted.has(keyOf(ws.id, el.rowId)));
      assert.deepEqual(inline.map(r => r.rowId), [], ws.id + ': after a read, no row the station holds is saved inline');
    },
    async sealFire() { totals.sealPasses += pg.fire(); await Rig.flush(); },
    async idle() {
      const before = W.pendingHydration().length, packedBefore = W.pendingHydration();
      await pg.tick();
      // the rows a hydration has just read are proved by that very read: the next save names them again, with no sweep in between
      const fresh = packedBefore.filter(id => !W.needsHydration(id));
      for (const id of fresh) for (const rowId of HR.idsOf(boot.get(id) || [])) if (gone.has(keyOf(id, rowId))) assert.equal(W.sealed(id, rowId), null, id + ': a packed turn the station says is undone is no longer kept as proven once the session is read back');
      if (fresh.length) {
        pg.persist();
        for (const id of fresh) {
          const w = JSON.parse(lastDoc).workstreams.find(x => x.id === id);
          const named = new Set(HR.idsOf(boot.get(id) || []));   // (a row the save held inline stays inline until the sweep or a read proves it: the read proved only the rows the save named)
          assert.deepEqual(w.history.filter(el => !(el && el.$ref) && pg.HR.sealable(el, id) && named.has(el.rowId)).map(r => r.rowId), [], id + ': the rows a save named, read back, are saved as references again, not as copies');
        }
      }
      await pg.sweep(); totals.sweeps++;
      totals.hydrations += Math.max(0, before - W.pendingHydration().length);
      for (const ws of W.all()) {   // a session the idle pass has just read back holds exactly what its save names
        const b = boot.get(ws.id);
        if (!ws.historyRef && hasRef(b) && !readBack.has(ws.id) && !dirty.has(ws.id)) {
          readBack.add(ws.id);
          const out = await HR.expand(b, { streamId: ws.id, fetchRows: direct });
          assert.deepEqual(ws.history, out.rows, ws.id + ': a session read back holds exactly the rows its save named');
        }
      }
      await Rig.flush();
    },
    async retractOther() {
      const ws = sessionOf();
      const durable = ws.history.filter(r => Number.isSafeInteger(r.rowId) && r.rowId > 0 && !gone.has(keyOf(ws.id, r.rowId)));
      if (!durable.length) return;
      const target = durable[durable.length - 1 - Math.floor(rng() * Math.min(3, durable.length))];
      const result = fx.store.retract({ streamId: ws.id, rowIds: [target.rowId], reason: 'undo' });
      if (result.state !== 'done') return;
      for (const id of result.targets) gone.add(keyOf(ws.id, id));
      totals.undone++;
    },
    async undo() {
      const ws = sessionOf();
      if (W.needsHydration(ws) || pg.busy.has(ws.id) || !ws.history.some(r => r.role === 'user' || r.role === 'assistant')) return;
      dirty.add(ws.id);
      pg.ctx.activeWs = ws;
      const before = ws.history.map(r => r.rowId).filter(Boolean);
      await pg.api.undoCommand();
      await Rig.flush();
      const after = new Set(ws.history.map(r => r.rowId).filter(Boolean));
      for (const id of before) if (!after.has(id)) {
        gone.add(keyOf(ws.id, id)); totals.undone++;
        assert.equal(W.sealed(ws.id, id), null, ws.id + ': an undone turn is not kept as proven (its text is held in no seal)');
      }
    },
    async clear() {
      const ws = sessionOf();
      if (pg.busy.has(ws.id) || !W.hasHistory(ws)) return;
      dirty.add(ws.id);
      if (W.clearConversation(ws.id, { at: clock() })) {
        cleared.add(ws.id); lastClearedId = ws.id; totals.cleared++; pg.persist();
        const saved = JSON.parse(lastDoc).workstreams.find(x => x.id === ws.id);
        assert.deepEqual(saved.history, [], ws.id + ': a cleared conversation is saved empty (nothing of it is named or kept)');
      }
    },
    async undoClear() {
      if (W.undoLast()) {
        if (lastClearedId) { cleared.delete(lastClearedId); dirty.add(lastClearedId); }
        // an undo puts a history back as it was cleared — packed or not, replacing what the session held — so what a session nobody has read
        // back is saved as is now the history the undo gave it
        for (const w of W.serialize().workstreams) if (W.needsHydration(w.id)) boot.set(w.id, JSON.parse(JSON.stringify(w.history)));
        pg.persist();
      }
    },
    async annotate() {
      const ws = sessionOf();
      if (W.needsHydration(ws)) return;
      const rows = ws.history.filter(r => Number.isSafeInteger(r.rowId));
      if (!rows.length) return;
      dirty.add(ws.id);
      const r = pick(rows); counter++;
      const how = Math.floor(rng() * 3);
      if (how === 0) r.stopNote = 'note ' + counter;                         // a page-only field on a sealed row
      else if (how === 1) r.content = r.content + ' (edited ' + counter + ')';   // a field of the seal, changed in place
      else r.ts = r.ts + 1;                                                    // another
      drifted.add(keyOf(ws.id, r.rowId));
      pg.persist();
    },
    // a page-only field on a routine's return (kind delivery): RESIDUE on a sealed row, which the reference carries beside the id and the expansion gives back
    async annotateKind() {
      const ws = sessionOf();
      if (W.needsHydration(ws)) return;
      const rows = ws.history.filter(r => Number.isSafeInteger(r.rowId) && r.kind === 'delivery' && r.stopNote === undefined);
      if (!rows.length) return;
      dirty.add(ws.id);
      const r = pick(rows); counter++;
      r.stopNote = 'note ' + counter;
      pg.persist();
    },
    async edit() {
      const ws = sessionOf();
      if (W.needsHydration(ws)) return;
      const rows = ws.history.filter(r => Number.isSafeInteger(r.rowId));
      if (!rows.length) return;
      dirty.add(ws.id);
      const r = pick(rows); counter++;
      if (Array.isArray(r.attachments)) r.attachments.push({ id: 'att' + counter, name: 'f' + counter + '.png' });   // a nested value, mutated in place
      else r.attachments = [{ id: 'att' + counter, name: 'f' + counter + '.png' }];
      drifted.add(keyOf(ws.id, r.rowId));
      pg.persist();
    },
    async reload() {
      if (!lastDoc) return;
      totals.reloads++;
      startPage(JSON.parse(lastDoc));
      readBack.clear(); drifted.clear(); dirty.clear();
    },
    async down() { tp.down = true; },
    async up() { tp.down = false; },
    async persist() { pg.persist(); }
  };
  const readBack = new Set(), drifted = new Set(), dirty = new Set();   // dirty: sessions an op has touched since the page booted

  try {
    startPage({ workstreams: SESSIONS.map((id, i) => ({ id, title: 'Session ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history: [], runIds: [], createdAt: 1000 + i, lastActiveAt: 1000 + i, lastReadAt: 1000 + i })), activeId: 's1', generalId: 's1' });
    for (let step = 0; step < STEPS; step++) {
      const name = step < 3 ? 'send' : pick(OPS);
      trace.push(name);
      await OPFN[name]();
      await drain();
    }
    // the end: the station answers, the page reloads from its last save and reads everything back — nothing was lost on the way
    tp.down = false;
    if (lastDoc) {
      const expectation = new Map();
      const doc = JSON.parse(lastDoc);
      for (const w of doc.workstreams) { const out = await HR.expand(w.history, { streamId: w.id, fetchRows: direct }); expectation.set(w.id, out.rows); }
      startPage(doc);
      for (let i = 0; i < 6 && W.pendingHydration().length; i++) await pg.tick();
      await drain();
      assert.deepEqual(W.pendingHydration(), [], 'the idle pass reads every session back');
      for (const w of W.all()) assert.deepEqual(w.history, expectation.get(w.id) || [], w.id + ': a fresh boot reads back exactly what the last save names');
    }
    totals.seeds++;
  } catch (e) {
    e.message = root + ' seed ' + seed + ' (' + trace.join(',') + '): ' + e.message;
    throw e;
  } finally {
    try { fx.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  for (const root of ROOTS) {
    let failed = null;
    for (let i = 0; i < SEEDS && !failed; i++) {
      try { await runSeed(root, FIRST_SEED + i * 997); } catch (e) { failed = e; }
    }
    A.ok(!failed, root + ': ' + SEEDS + ' seeds of ' + STEPS + ' ops hold the property' + (failed ? ' — ' + String(failed.message).split('\n').slice(0, 14).join(' | ') : ''));
  }
  console.log('  ' + JSON.stringify(totals));
  A.ok(totals.seeds >= SEEDS, 'every seed ran to its end (' + totals.seeds + ' of ' + SEEDS * ROOTS.length + ')');
  A.ok(totals.packedPersists > 0 && totals.packedRows > 0, 'the property is not vacuous: persists really carried packed runs (' + totals.packedPersists + ' persists, ' + totals.packedRows + ' packed rows checked)');
  A.ok(totals.attachTurns > 0 && totals.attachRows === totals.attachTurns, 'attachment turns ran through the real run path, each leaving one attachment row on the station (' + totals.attachTurns + ' turns, ' + totals.attachRows + ' rows)');
  A.ok(totals.attachResidue > 0, 'and packed attachment turns expanded back with their references as residue (' + totals.attachResidue + ')');
  A.ok(totals.kindDeliverables > 0 && totals.kindSteers > 0 && totals.kindDeliveries > 0, 'the row kinds of turn identity ran through the real run and delivery paths (' + totals.kindDeliverables + ' file runs, ' + totals.kindSteers + ' steered runs, ' + totals.kindDeliveries + ' routine returns)');
  A.ok(totals.kindsResidue > 0, 'a packed routine return expanded back with its page-only field as residue (' + totals.kindsResidue + ')');
  A.ok(totals.kindsPacked > 0 && totals.kindsInline > 0, 'a routine return was packed and expanded back as the page row, and system rows (file, steer) stayed inline (' + totals.kindsPacked + ' packed, ' + totals.kindsInline + ' inline)');
  A.ok(totals.opens > 0 && totals.reloads > 0 && totals.hydrations > 0 && totals.undone > 0 && totals.cleared > 0, 'the sequences covered opens, reloads, hydrations, undos and clears');
  A.report('history-seal.property (a persisted history always expands to the page\'s history; both shipped trees)');
})().catch(e => { console.error(e); process.exit(1); });
