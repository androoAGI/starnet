'use strict';
const { readSidecarSource } = require('./helpers/source');
/* node test/overseer-idle-cost.test.js — THE IDLE OVERSEER READS NO SAVE (idle-cpu piece 2, 2026-10-19).
   The 2 s tick and GET /api/halt read `paused` and `reviews` through snapshot(), which also built every thread from a full
   parse of the page's save: two parses a tick (~20 ms at a real 3.8 MB station, ~86k parses a day) and two per /api/halt
   poll. GENUINE: sidecar/overseer.js's in-memory accessors answer what snapshot() would, with no save read.
   SOURCE-LOCKED: the tick and haltStatus() call no snapshot(). Never requires sidecar/index.js (it boots a sidecar). */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOverseer } = require('../sidecar/overseer.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-overseer-idle-'));
const clone = v => JSON.parse(JSON.stringify(v));
const page = { generalId: 'home', workstreams: [{ id: 'home', title: null, agentId: 'agent' }, { id: 'side', title: 'Side work', agentId: 'agent' }], deletedIds: [] };
let clock = 1000;
const worker = (id, o) => Object.assign({ id, runId: id + '_run', leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', parentRunId: 'lead1',
  streamId: 'thread_' + id, status: 'done', completedAt: clock, generation: 1 }, o || {});

try {
  // ── (a) the accessors read no save, and say exactly what snapshot() says ──
  {
    let loads = 0;
    const m = makeOverseer({ fs, path, file: path.join(root, 'a.json'), now: () => clock,
      newId: (() => { let n = 0; return () => 'thread_' + (++n); })(), sessions: () => { loads++; return clone(page); },
      hasAgent: id => ['agent', 'researcher'].includes(id) });
    m.create({ title: 'Research', parentStreamId: 'home', agentId: 'researcher', worker: true, requestId: 'lead1:0:1' });
    m.collect([worker('w1')]);
    A.eq(m.reviews().length, 1, 'fixture: one settled worker filed one report');
    const id = m.reviews()[0].id;
    const agree = label => {
      const s = m.snapshot();
      A.eq(m.paused(), s.paused, label + ': paused() === snapshot().paused');
      A.eq(m.reviews(), s.reviews, label + ': reviews() === snapshot().reviews');
      A.eq(m.review(id), s.reviews.find(r => r.id === id) || null, label + ': review(id) === that snapshot row');
      A.eq(m.error(), s.error || '', label + ': error() === snapshot().error || \'\'');
    };
    agree('normal');
    loads = 0;
    for (let i = 0; i < 50; i++) { m.paused(); m.reviews(); m.review(id); m.error(); }
    A.eq(loads, 0, 'fifty rounds of paused()/reviews()/review()/error() load the page\'s save zero times');
    A.eq(m.review('nope'), null, 'an unknown review id is null');
    // a caller can never edit the overseer's own rows through what it was handed
    m.reviews()[0].status = 'tampered'; m.review(id).status = 'tampered';
    A.eq(m.review(id).status, 'pending', 'reviews() and review() hand out copies');
    m.stopReviews([]);
    agree('after stopReviews()');
    A.eq([m.paused(), m.review(id).status], [true, 'cancelled'], 'E-STOP pauses and cancels, read from RAM');
    loads = 0; m.paused(); m.reviews(); m.review(id); m.error();
    A.eq(loads, 0, 'still no save read after the E-STOP');
    m.resumeReviews();
    agree('after resumeReviews()');
  }
  {
    const corrupt = path.join(root, 'corrupt.json');
    fs.writeFileSync(corrupt, '{broken');
    let loads = 0;
    const m = makeOverseer({ fs, path, file: corrupt, now: () => clock, newId: () => 'x', sessions: () => { loads++; return clone(page); }, hasAgent: () => true });
    A.eq([m.paused(), m.reviews(), m.review('any'), /unavailable/.test(m.error())], [true, [], null, true], 'a damaged overseer.json reads paused, no reviews, its error');
    A.eq([m.paused(), m.reviews(), m.error()], [m.snapshot().paused, m.snapshot().reviews, m.snapshot().error || ''], 'exactly what snapshot() says for it');
    A.eq(loads, 0, 'and reads no save for any of it');
  }

  // ── (b) source pins: the tick and the halt picture read the accessors, never snapshot() ──
  {
    const idx = readSidecarSource();
    const tick = A.fnBody(idx, 'async function tickOverseer');
    const halt = A.fnBody(idx, 'function haltStatus');
    A.ok(tick.length > 1000 && tick.length < 20000, 'tickOverseer located (' + tick.length + ' chars)');
    A.ok(halt.length > 100 && halt.length < 2000, 'haltStatus located (' + halt.length + ' chars)');
    A.ok(!tick.includes('overseer.snapshot('), 'the 2 s tick never builds a snapshot (each one parsed the whole save)');
    A.ok(!halt.includes('overseer.snapshot('), 'GET /api/halt never builds a snapshot');
    A.ok(/overseer\.paused\(\)/.test(tick) && /for \(let review of overseer\.reviews\(\)\)/.test(tick), 'the tick reads paused() and reviews()');
    A.ok(halt.includes('overseer: { halted: overseer.paused(), error: overseer.error() }'), 'haltStatus reads paused() and error() (same keys, same values)');
  }

  // ── (c) GET /api/overseer's thread list is memoized by the save's stamp ──
  {
    const file = path.join(root, 'c.json');
    let reads = 0, token = 'save-1', race = false;
    const doc = clone(page);
    const base = { fs, path, file, now: () => clock, newId: (() => { let n = 0; return () => 'thread_' + (++n); })(),
      hasAgent: id => ['agent', 'researcher'].includes(id) };
    const m = makeOverseer(Object.assign({}, base, {
      sessions: () => { throw new Error('the memoized overseer reads through sessionsRead'); },
      sessionsRead: () => { reads++; const out = { doc: clone(doc), stamp: token }; if (race) token = 'moved-' + reads; return out; },
      sessionsStamp: () => token }));
    m.create({ title: 'Research', parentStreamId: 'home', agentId: 'researcher', worker: true, requestId: 'lead1:0:1' });
    m.collect([worker('w1')]);
    reads = 0;
    for (let i = 0; i < 20; i++) m.snapshot();
    A.eq(reads, 1, 'twenty snapshots of an unchanged save parse it once (was twenty)');
    const plain = makeOverseer(Object.assign({}, base, { sessions: () => clone(doc) }));
    A.eq(JSON.stringify(m.snapshot()), JSON.stringify(plain.snapshot()), 'the memoized snapshot is byte-identical to the unmemoized one');
    A.ok(m.snapshot().threads.some(w => w.worker === true && w.leadRunId === 'lead1' && w.call === '0' && w.slot === 1), 'projected fields intact');
    // a caller can never edit the memo through what it was handed
    const handed = m.snapshot();
    handed.threads[0].title = 'tampered'; handed.threads.length = 0;
    A.ok(m.snapshot().threads.length === 3 && m.snapshot().threads[0].title !== 'tampered', 'snapshot rows are copies of the memo');
    const listedRow = m.resolveListed('side'); listedRow.title = 'tampered';
    A.eq(m.resolveListed('side').title, 'Side work', 'resolveListed hands out a copy too');
    reads = 0;
    doc.workstreams[1].title = 'Renamed'; token = 'save-2';
    A.eq(m.snapshot().threads.find(w => w.id === 'side').title, 'Renamed', 'a new save stamp re-reads: the rename shows');
    A.eq(reads, 1, 'one read for the changed save');
    m.snapshot(); A.eq(reads, 1, 'and none after it');
    m.patchReview(m.reviews()[0].id, { error: 'Connect the overseer provider to review this result.' });
    m.snapshot(); A.eq(reads, 2, 'a new overseer state (patchReview) re-reads');
    m.create({ title: 'Another', parentStreamId: 'home', agentId: 'researcher' });
    reads = 0;
    A.ok(m.snapshot().threads.some(w => w.title === 'Another'), 'a thread filed by create() is listed at once');
    A.eq(reads, 1, 'create() (a new state) re-reads');
    // a save that moves while it is being read is never adopted
    token = 'save-3'; race = true; reads = 0;
    m.snapshot(); race = false; m.snapshot();
    A.eq(reads, 2, 'a stamp that moved between the read and the check is not memoized: the next call reads again');
    m.snapshot(); A.eq(reads, 2, 'and the clean read after it is');
    // an unclean read (absent, locked, corrupt, recovered) stamps '' and is never memoized
    let unclean = 0;
    const u = makeOverseer(Object.assign({}, base, { file: path.join(root, 'c2.json'),
      sessionsRead: () => { unclean++; return { doc: clone(doc), stamp: '' }; }, sessionsStamp: () => '' }));
    for (let i = 0; i < 5; i++) u.snapshot();
    A.eq(unclean, 5, 'an unclean read is read afresh on every call, exactly as before');
    // resolveListed answers what resolve() answers, and refuses what it refuses
    const r1 = m.resolve('Renamed'), r2 = m.resolveListed('Renamed');
    A.eq([r2.id, r2.title, r2.agentId, !!r2.projectRoot, r2.worker], [r1.id, r1.title, r1.agentId, !!r1.projectRoot, r1.worker === true], 'resolveListed finds the same conversation as resolve()');
    A.throws(() => m.resolveListed('ws_gone'), 'an unknown conversation still throws (the tick cancels its report)');
    let threw = '';
    try { m.resolveListed('ws_gone'); } catch (e) { threw = e.message; }
    A.eq(threw, 'no such session', 'with resolve()\'s own message');
  }
  // the real wiring: savestore stamp + loadStamped, as sidecar/index.js hands them to makeOverseer
  {
    const { makeSaveStore } = require('../sidecar/savestore.js');
    const dir = path.join(root, 'ws'); fs.mkdirSync(dir);
    let t = 5000;
    const store = makeSaveStore({ fs, pathMod: path, root: dir, clock: { now: () => ++t } });
    const doc = Object.assign(clone(page), { updatedAt: 1 });
    A.eq(store.save('agent', doc).ok, true, 'fixture: a save on disk');
    let reads = 0;
    const m = makeOverseer({ fs, path, file: path.join(root, 'wired.json'), now: () => clock, newId: () => 'thread_x', hasAgent: () => true,
      sessions: () => store.load('agent') || {},
      sessionsRead: () => { reads++; const r = store.loadStamped('agent'); return { doc: r.doc || {}, stamp: r.stamp }; },
      sessionsStamp: () => store.stamp('agent') });
    for (let i = 0; i < 20; i++) m.snapshot();
    A.eq(reads, 1, 'a real save: twenty polls, one parse');
    store.save('agent', Object.assign(clone(doc), { updatedAt: 2, workstreams: doc.workstreams.concat([{ id: 'third', title: 'Third', agentId: 'agent' }]) }));
    A.ok(m.snapshot().threads.some(w => w.id === 'third'), 'a page save shows on the very next poll');
    A.eq(reads, 2, 'with exactly one more parse');
    const idx = readSidecarSource();
    A.ok(idx.includes("sessionsRead: () => { const r = saveStore.loadStamped('agent'); return { doc: r.doc || {}, stamp: r.stamp }; },")
      && idx.includes("sessionsStamp: () => saveStore.stamp('agent'),"), 'sidecar/index.js hands the overseer exactly this wiring');
    const tick = A.fnBody(idx, 'async function tickOverseer');
    const outer = tick.indexOf('overseer.resolveListed(review.parentStreamId)'), lock = tick.indexOf('await overseer.withThread(parent.id');
    A.ok(outer > 0 && lock > outer, 'the tick\'s pre-check reads the listed rows (no parse per pending review per tick)');
    A.ok(tick.indexOf('parent = overseer.resolve(review.parentStreamId)', lock) > lock, 'and the lock re-resolves afresh before a paid run');
  }

  // ── (d) savestore's stamp, against a real temp dir ──
  {
    const { makeSaveStore } = require('../sidecar/savestore.js');
    const dir = path.join(root, 'stamp'); fs.mkdirSync(dir);
    let t = 9000;
    const store = makeSaveStore({ fs, pathMod: path, root: dir, clock: { now: () => ++t } });
    const main = path.join(dir, 'agent.save.json');
    A.eq(store.stamp('agent'), '', 'no save file: stamp is \'\'');
    A.eq(store.loadStamped('agent'), { doc: undefined, stamp: '' }, 'absent: loadStamped = load() (undefined), stamp \'\'');
    const seen = new Set();
    for (let i = 1; i <= 4; i++) {
      store.save('agent', { updatedAt: i, workstreams: [], n: i });
      const s = store.stamp('agent');
      A.ok(s && !seen.has(s), 'save #' + i + ' moves the stamp (' + s + ')');
      seen.add(s);
    }
    const ok = store.loadStamped('agent');
    A.eq(ok.doc, store.load('agent'), 'ok: loadStamped().doc is exactly load()');
    A.eq(ok.stamp, store.stamp('agent'), 'ok: stamped with the save it read');
    // an outside edit: a different size moves it; a same-size rewrite moves it by its mtime
    const before = store.stamp('agent');
    const raw = fs.readFileSync(main, 'utf8');
    fs.writeFileSync(main, raw.replace('"n":4', '"n":44'));
    A.ok(store.stamp('agent') !== before, 'an outside edit of another size moves the stamp');
    const mid = store.stamp('agent');
    const st = fs.statSync(main);
    fs.writeFileSync(main, raw.replace('"n":4', '"n":45'));
    fs.utimesSync(main, st.atime, new Date(st.mtimeMs + 2000));
    A.eq(fs.statSync(main).size, st.size, 'fixture: same-size outside rewrite');
    A.ok(store.stamp('agent') !== mid, 'a same-size outside rewrite moves the stamp (mtime)');
    // an in-process save moves it even where the file system would not (constant stat: coarse mtime, no file id)
    const flat = { mtimeNs: 1n, size: 10n, ino: 0n };
    const still = makeSaveStore({ fs: Object.assign({}, fs, { statSync: () => flat }), pathMod: path, root: dir, clock: { now: () => ++t } });
    const s0 = still.stamp('agent');
    still.save('agent', { updatedAt: 100, workstreams: [] });
    A.ok(s0 && still.stamp('agent') !== s0, 'this process\'s own save always moves the stamp');
    const noStat = makeSaveStore({ fs: Object.assign({}, fs, { statSync: undefined }), pathMod: path, root: dir, clock: { now: () => ++t } });
    A.eq(noStat.stamp('agent'), '', 'no statSync: stamp \'\' (never memoized)');
    const oldStat = makeSaveStore({ fs: Object.assign({}, fs, { statSync: () => ({ mtimeMs: 1, size: 10 }) }), pathMod: path, root: dir, clock: { now: () => ++t } });
    A.eq(oldStat.stamp('agent'), '', 'a stat without ns mtime: stamp \'\' (a constant stamp would never move)');
    // locked (EBUSY): load() is undefined, and nothing is stamped
    const busy = makeSaveStore({ fs: Object.assign({}, fs, { readFileSync: (f, enc) => {
      if (String(f) === main) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
      return fs.readFileSync(f, enc); } }), pathMod: path, root: dir, clock: { now: () => ++t } });
    A.eq([busy.loadStamped('agent'), busy.load('agent')], [{ doc: undefined, stamp: '' }, undefined], 'locked: loadStamped = load() (undefined), stamp \'\'');
    // corrupt main, clean .bak: recovered, the .bak's doc, never stamped
    const good = JSON.parse(fs.readFileSync(main + '.bak', 'utf8'));
    fs.writeFileSync(main, '{torn');
    const rec = store.loadStamped('agent');
    A.eq(rec.stamp, '', 'recovered from .bak: stamp \'\'');
    A.eq(rec.doc, good.doc, 'recovered: the .bak\'s doc');
    A.eq(rec.doc, store.load('agent'), 'recovered: exactly load()');
    // corrupt main, no .bak: undefined, never stamped
    const dir2 = path.join(root, 'stamp2'); fs.mkdirSync(dir2);
    const lone = makeSaveStore({ fs, pathMod: path, root: dir2, clock: { now: () => ++t } });
    fs.writeFileSync(path.join(dir2, 'agent.save.json'), '{torn');
    A.eq(lone.loadStamped('agent'), { doc: undefined, stamp: '' }, 'corrupt, nothing to recover: undefined, stamp \'\'');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('overseer-idle-cost');
