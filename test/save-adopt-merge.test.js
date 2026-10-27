/* test/save-adopt-merge.test.js — ONE window, the station "went back" (support reports 10-15…10-25: #121, #153,
   starnet-releases#4, the androo.agi inbox). A window's save landed but its ACK never arrived; the window died (crash,
   power loss, a killed app) before its next save was sent; the reopened window resumed that next save from the browser
   cache on the old revision and was refused as ANOTHER window's change — and so was every save after it, so the station
   file froze while the window kept working. Live repro: dev/save-unclean-exit-repro.mjs.

   Drives the REAL page (frontend/app/cloudsave.js in a vm) -> the REAL /api/save, /api/save/adopt handlers sliced out of
   sidecar/index.js -> the REAL savestore on a temp workspace (test/_save-restore-kit.js). A "restart" is a new store
   process over the same files.
     a. a cache that names its window (0.14.1): that window's newer work lands as itself — no conflict, no merge;
     b. …and a cache OLDER than the head that window wrote (a cache that could not hold the newer save) gives way to the
        station file, which is resumed;
     c. a cache from 0.14.0 or earlier (no window named) is merged at boot: the window saved last is the base, the station
        file's other sessions come back into it, a session deleted in the window stays deleted, the station file is copied
        aside first, the window's growth never goes behind the station's rating watermark, and its next save lands;
     d. a station file saved AFTER the window (a terminal's approval change while the app was closed) is the base: its
        approval modes stand, the window's sessions are added, the window's whole save is kept beside it;
     e. a cache of ANOTHER station (another founding) is never merged or taken as that window's work: preserved, untouched. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const K = require('./_save-restore-kit.js');
const { workspace, turn, stationDoc, sidecar, page, conflictFiles } = K;

const titles = doc => (doc && Array.isArray(doc.workstreams) ? doc.workstreams : []).map(w => w.id);
const clone = v => JSON.parse(JSON.stringify(v));
const backups = root => fs.readdirSync(root).filter(n => /^agent\.save-before-adopt-\d+\.json$/.test(n));
// what App.persist does: the window's state, stamped with this page's revision and writer, into the cache, then queued
function persist(cs, cache, doc) {
  const d = Object.assign(clone(doc), { _saveDirty: true, _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now() });
  cache.set('starnet.save', JSON.stringify(d)); cs.push(d);
  return d;
}
const tick = () => new Promise(r => setTimeout(r, 3));
// one window (`cs`) writes a first save; then the station writes its NEXT save (the window's request whose ACK is lost) and
// the window's cache moves on to a newer edit that was never sent. Returns { root, cache, head } before the window dies.
async function lostAckThenDeath(opts) {
  const root = workspace();
  const host = sidecar(root);
  const cache = new Map(); const cs = page(host, cache);
  await cs.reconcile(null);
  const first = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'S1', history: [turn('user', 'one')] }] });
  persist(cs, cache, first); A.eq(await cs.flush({ force: true }), true, 'fixture: the first save lands');
  await tick();
  // the window's next save is written by the station, but its acknowledgement never reaches the window
  const headDoc = Object.assign(clone(first), opts && opts.headExtra ? opts.headExtra(clone(first)) : {});
  headDoc.workstreams = headDoc.workstreams.concat([{ id: 'S2', history: [turn('user', 'two')] }]);
  const head = host.saveStore.save('agent', Object.assign({}, headDoc, { _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now(), _saveDirty: true }), { compareRevision: true });
  A.ok(head.ok === true, 'fixture: the station writes the window\'s unacknowledged save');
  if (opts && opts.legacyFile) {   // a station file written by 0.14.0 or earlier: its wrapper names no writer
    const p = path.join(root, 'agent.save.json'), w = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete w.revision; delete w.client; fs.writeFileSync(p, JSON.stringify(w));
  }
  await tick();
  // …and the window's cache holds its newest edit on the revision it last heard (never sent: the window dies here)
  const newest = clone(headDoc); newest.workstreams.push({ id: 'S3', history: [turn('user', 'three')] });
  const cached = Object.assign(newest, { _saveDirty: true, _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now() }, opts && opts.cacheExtra ? opts.cacheExtra : {});
  if (opts && opts.legacy) delete cached._saveClient;
  cache.set('starnet.save', JSON.stringify(cached));
  return { root, cache, head, writer: cs.writerId() };
}

(async () => {
  try {
    // ================= a. the window that wrote the head comes back with its newer work =================
    {
      const { root, cache, head } = await lostAckThenDeath();
      const host = sidecar(root);                                   // a fresh station process: the app reopened
      const Z = page(host, cache);
      const resumed = await Z.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(titles(resumed), ['general', 'S1', 'S2', 'S3'], 'a: the reopened window resumes its newest work');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'a: no conflict — no other window wrote this station');
      A.eq(titles(host.saveStore.load('agent')), ['general', 'S1', 'S2', 'S3'], 'a: the station file now holds that work');
      A.eq(host.saveStore.load('agent')._saveRevision, head.revision + 1, 'a: as the next revision after the head the window wrote');
      A.eq(conflictFiles(root), [], 'a: nothing was preserved as a conflict');
      A.eq([Z.mergeNotice(), backups(root).length], [null, 0], 'a: and nothing needed merging');
      const next = persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'S4', history: [turn('user', 'four')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'a: the next save lands');
      A.eq(titles(host.saveStore.load('agent')), titles(next), 'a: and keeps landing');
      const cached = JSON.parse(cache.get('starnet.save'));
      A.eq([cached._saveDirty, cached._saveRevision], [false, host.saveStore.load('agent')._saveRevision], 'a: the browser cache is clean at the station revision');
    }

    // ================= b. a cache that reads OLDER than the head its own window wrote: the station file is the base =================
    // (the cache could not take the newer saves — or the clock stepped back: review 10-25 #4 — so it may still hold
    // something the station file lacks; that comes back into the station and the cache is kept whole beside it)
    {
      const { root, cache } = await lostAckThenDeath({ cacheExtra: { updatedAt: 1 } });
      const stale = JSON.parse(cache.get('starnet.save'));
      stale.workstreams = stale.workstreams.filter(w => w.id !== 'S2' && w.id !== 'S3').concat([{ id: 'S0-unsent', history: [turn('user', 'only in this cache')] }]);
      stale.agent = Object.assign({}, stale.agent, { name: 'OLD-NAME' });
      cache.set('starnet.save', JSON.stringify(stale));
      const host = sidecar(root);
      const Z = page(host, cache);
      const resumed = await Z.reconcile(stale);
      A.eq(titles(resumed), ['general', 'S1', 'S2', 'S0-unsent'], 'b: the window resumes the station file, with the cache\'s one session brought into it');
      A.eq(resumed.agent.name, 'NOVA', 'b: the station file\'s newer crew stands over the older cache');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'b: no conflict');
      A.eq(titles(host.saveStore.load('agent')), titles(resumed), 'b: the station file holds what the window resumed');
      const note = Z.mergeNotice();
      A.ok(note && note.base === 'station' && note.added === 1 && /^agent\.save-conflict-kept-\d+-/.test(String(note.kept)), 'b: reported, with the cache kept whole under its own name (' + JSON.stringify(note) + ')');
      A.eq(JSON.parse(fs.readFileSync(path.join(root, note.kept), 'utf8')).agent.name, 'OLD-NAME', 'b: nothing the cache held is lost');
      A.eq(JSON.parse(cache.get('starnet.save'))._saveDirty, false, 'b: the cache now holds the station file, clean');
    }

    // ================= c. a cache from 0.14.0 or earlier is MERGED at boot, never refused =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true, legacyFile: true,
        headExtra: d => ({ workstreams: d.workstreams.concat([{ id: 'only-on-station', history: [turn('user', 'made by a routine')] }, { id: 'deleted-in-window', history: [turn('user', 'x')] }]),
          stationStats: { ratingSyncAt: 50, xp: 70 }, agent: Object.assign({}, d.agent, { stats: { xp: 70 } }) }),
        cacheExtra: { deletedIds: ['deleted-in-window'], stationStats: { ratingSyncAt: 10, xp: 5 } } });
      const legacy = JSON.parse(cache.get('starnet.save'));
      legacy.workstreams = legacy.workstreams.filter(w => w.id !== 'only-on-station' && w.id !== 'deleted-in-window');
      legacy.agent = Object.assign({}, legacy.agent, { stats: { xp: 5 } });
      cache.set('starnet.save', JSON.stringify(legacy));
      A.ok(!('_saveClient' in legacy), 'fixture: the cache names no window (0.14.0), and neither does the station file');
      const stationBefore = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      const host = sidecar(root);
      const Z = page(host, cache);
      const resumed = await Z.reconcile(legacy);
      A.eq(titles(resumed), ['general', 'S1', 'S2', 'S3', 'only-on-station'], 'c: the window resumes its own work with the station file\'s other session brought back');
      A.ok(!titles(resumed).includes('deleted-in-window'), 'c: a session deleted in the window stays deleted');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'c: no conflict latched');
      const durable = host.saveStore.load('agent');
      A.eq(titles(durable), titles(resumed), 'c: the station file holds exactly what the window resumed');
      A.eq([durable.stationStats.ratingSyncAt, durable.agent.stats.xp], [50, 70], 'c: the station\'s growth projection never goes behind its rating watermark');
      const note = Z.mergeNotice();
      A.ok(note && note.base === 'window' && note.added === 1 && /^agent\.save-before-adopt-\d+\.json$/.test(String(note.backup)), 'c: the merge is reported: the window was the base, one session came back, where the copy is (' + JSON.stringify(note) + ')');
      A.eq(backups(root).length, 1, 'c: the station file was copied aside first');
      A.eq(fs.readFileSync(path.join(root, note.backup), 'utf8'), stationBefore, 'c: byte for byte');
      A.eq(conflictFiles(root), [], 'c: nothing was preserved as a refused save');
      const next = persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'after', history: [turn('user', 'after')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'c: the window\'s next save lands');
      A.eq(titles(host.saveStore.load('agent')), titles(next), 'c: with everything in it');
    }

    // ================= d. a station file saved AFTER the window is the base =================
    {
      const root = workspace();
      const host0 = sidecar(root);
      const cache = new Map(); const W = page(host0, cache);
      await W.reconcile(null);
      const start = stationDoc({ agents: [{ id: 'scout', name: 'SCOUT', approvalMode: 'full' }], workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }] });
      persist(W, cache, start); await W.flush({ force: true });
      // the window's last edit: cached, never sent (old build: no writer in the cache)
      const unsent = persist(W, cache, Object.assign(clone(start), { workstreams: start.workstreams.concat([{ id: 'unsent', history: [turn('user', 'mine')] }]) }));
      const legacy = Object.assign({}, unsent); delete legacy._saveClient; cache.set('starnet.save', JSON.stringify(legacy));
      await tick();
      // the app is closed; the terminal turns SCOUT's approval back to ASK (written on the save's own revision)
      const cur = host0.saveStore.load('agent');
      const patched = Object.assign(clone(cur), { updatedAt: Date.now() + 1000, _saveClient: 'approval-' + Date.now(), _saveDirty: false });
      patched.agents[0].approvalMode = 'ask';
      A.ok(host0.saveStore.save('agent', patched, { compareRevision: true }).ok, 'fixture: the terminal\'s approval change lands');
      const host = sidecar(root);
      const Z = page(host, cache);
      const resumed = await Z.reconcile(legacy);
      A.eq(resumed.agents[0].approvalMode, 'ask', 'd: the terminal\'s later approval change stands');
      A.eq(titles(resumed), ['general', 'unsent'], 'd: and the window\'s unsent session is added to it');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'd: no conflict latched');
      const note = Z.mergeNotice();
      A.ok(note && note.base === 'station' && note.added === 1 && typeof note.kept === 'string', 'd: reported with the station file as the base and where the window\'s whole save is kept (' + JSON.stringify(note) + ')');
      const kept = JSON.parse(fs.readFileSync(path.join(root, note.kept), 'utf8'));
      A.eq([kept.agents[0].approvalMode, titles(kept)], ['full', ['general', 'unsent']], 'd: the window\'s own save is kept whole beside the station');
    }

    // ================= e. a cache of ANOTHER station is never merged =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true });
      const other = JSON.parse(cache.get('starnet.save')); other.agent = { id: 'agent', name: 'SOL', createdAt: 999999 };
      cache.set('starnet.save', JSON.stringify(other));
      const before = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      const host = sidecar(root);
      const Z = page(host, cache);
      await Z.reconcile(other);
      A.eq(await Z.flush({ force: true }), false, 'e: another station\'s copy is refused');
      A.ok(Z.health().conflict && Z.health().conflict.conflict === true, 'e: as a conflict');
      A.eq(fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8'), before, 'e: the station file is untouched');
      A.eq([Z.mergeNotice(), backups(root).length], [null, 0], 'e: nothing was merged');
      A.eq(conflictFiles(root).length, 1, 'e: the copy is preserved beside the station');
    }

    // ================= f. a STALE SECOND TAB is never the base over the live one (hostile review 10-25 #2) =================
    {
      const root = workspace();
      const host0 = sidecar(root);
      const shared = new Map();                                     // two tabs of one browser share the cache
      const live = page(host0, shared), stale = page(host0, shared);
      await live.reconcile(null); await stale.reconcile(null);
      const start = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'OLD', history: [turn('user', 'old')] }] });
      persist(live, shared, start); await live.flush({ force: true });
      // the live tab renames its agent and deletes OLD
      const moved = Object.assign(clone(start), { agent: Object.assign({}, start.agent, { name: 'RENAMED' }), deletedIds: ['OLD'], workstreams: start.workstreams.filter(w => w.id !== 'OLD') });
      persist(live, shared, moved); await live.flush({ force: true });
      await tick();
      // the stale tab (still on the first save) writes the shared cache last, with one session of its own; it is refused
      const staleDoc = Object.assign(clone(start), { workstreams: start.workstreams.concat([{ id: 'stale-tab', history: [turn('user', 's')] }]) });
      persist(stale, shared, staleDoc); A.eq(await stale.flush({ force: true }), false, 'fixture: the stale tab’s save does not land as it is');
      // since save-latch-kill the refusal is merged IN-SESSION, with the station file as the base, and the stale tab re-enters
      const sm = stale.mergeNotice();
      A.eq(sm && [sm.base, sm.inSession], ['station', true], 'f: the stale tab’s refused save was merged in-session, the station file the base');
      A.eq(stale._reloads.length, 1, 'f: and the stale tab re-entered (reloaded onto the merge), never sending its own view on top');
      const host = sidecar(root);
      const Z = page(host, shared);                                  // the stale tab is reloaded
      const resumed = await Z.reconcile(JSON.parse(shared.get('starnet.save')));
      A.eq(resumed.agent.name, 'RENAMED', 'f: the live tab\'s rename stands');
      A.ok(!titles(resumed).includes('OLD'), 'f: the live tab\'s delete stands');
      A.ok(titles(resumed).includes('stale-tab'), 'f: the stale tab\'s own session is brought in');
      A.eq(host.saveStore.load('agent').agent.name, 'RENAMED', 'f: and the station file still says so');
      A.ok(titles(host.saveStore.load('agent')).includes('stale-tab') && !titles(host.saveStore.load('agent')).includes('OLD'), 'f: the station file holds the stale tab’s session and keeps the live tab’s delete');
    }

    // ================= g. the dead window's id rides ONE resend, never this page's later saves (review #3) =================
    {
      const { root, cache, writer } = await lostAckThenDeath();
      const host = sidecar(root);
      let firstPost = true;
      // the dead window is not dead after all: its own newer save lands between this page's read and its resend
      const proxy = { fetch: (u, o) => {
        if (firstPost && o && o.method === 'POST' && String(u) === '/api/save') {
          firstPost = false;
          const cur = host.saveStore.load('agent');
          const doc4 = Object.assign(clone(cur), { workstreams: cur.workstreams.concat([{ id: 'X-by-A', history: [turn('user', 'a')] }]), _saveClient: writer, updatedAt: Date.now() + 5000, _saveDirty: true });
          A.ok(host.saveStore.save('agent', doc4, { compareRevision: true }).ok, 'fixture: the first window\'s own newer save lands first');
        }
        return host.fetch(u, o);
      } };
      const Z = page(proxy, cache);
      const resumed = await Z.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(await Z.flush({ force: true }), false, 'g: the resend as the first window is refused — that window saved newer since');
      persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'Z-later', history: [turn('user', 'z')] }]) }));
      A.eq(await Z.flush({ force: true }), false, 'g: this page\'s next save is its own: refused, never passed off as the first window');
      A.ok(titles(host.saveStore.load('agent')).includes('X-by-A'), 'g: the first window\'s newer save stays in the station file');
      A.ok(conflictFiles(root).length >= 1, 'g: this page\'s work is preserved beside it');
    }

    // ================= h. the merge's answer never arrived: the page reads again and resumes the merge (review #1) =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true, legacyFile: true,
        headExtra: d => ({ workstreams: d.workstreams.concat([{ id: 'ONLY-ON-STATION', history: [turn('user', 'r')] }]) }) });
      const legacy = JSON.parse(cache.get('starnet.save')); legacy.workstreams = legacy.workstreams.filter(w => w.id !== 'ONLY-ON-STATION');
      cache.set('starnet.save', JSON.stringify(legacy));
      const host = sidecar(root);
      const proxy = { fetch: async (u, o) => {
        const r = await host.fetch(u, o);
        if (String(u) === '/api/save/adopt') throw new Error('the answer was lost');   // the merge landed; the page never hears
        return r;
      } };
      const Z = page(proxy, cache);
      const resumed = await Z.reconcile(legacy);
      A.ok(titles(resumed).includes('ONLY-ON-STATION') && titles(resumed).includes('S3'), 'h: the page resumes the merge it never heard about (' + titles(resumed) + ')');
      A.ok(Z.mergeNotice() && Z.mergeNotice().late === true, 'h: and says a merge happened');
      await Z.flush({ force: true });
      persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'after', history: [turn('user', 'after')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'h: its next save lands');
      A.ok(titles(host.saveStore.load('agent')).includes('ONLY-ON-STATION'), 'h: and the station file\'s own session is still there');
    }

    // ================= j. the resend meets a PASSING refusal: the page still continues that window's work (re-review N1) =================
    {
      const { root, cache } = await lostAckThenDeath();
      const host = sidecar(root);
      let failNext = true;
      const proxy = { fetch: async (u, o) => {
        if (failNext && o && o.method === 'POST' && String(u) === '/api/save') { failNext = false; throw new Error('the station file was locked for a moment'); }
        return host.fetch(u, o);
      } };
      const Z = page(proxy, cache);
      const resumed = await Z.reconcile(JSON.parse(cache.get('starnet.save')));
      await tick(); await tick();
      // the page saves again before the retry: the newer save replaces the refused one
      const next = persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'S4', history: [turn('user', 'four')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'j: the save that replaced the refused resend lands');
      A.eq(Z.health().conflict, null, 'j: no conflict — still one window\'s work');
      A.eq(titles(host.saveStore.load('agent')), titles(next), 'j: the station file holds all of it');
      persist(Z, cache, Object.assign(clone(next), { workstreams: next.workstreams.concat([{ id: 'S5', history: [turn('user', 'five')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'j: and the page\'s own saves land after it');
    }

    // ================= k. a lost answer from a merge that wrote nothing: asked once more (re-review N3) =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true });
      // no session the station lacks — only a crew change — so the merge brings nothing in and writes nothing
      const legacy = JSON.parse(cache.get('starnet.save')); legacy.workstreams = legacy.workstreams.filter(w => w.id !== 'S3');
      legacy.agent = Object.assign({}, legacy.agent, { name: 'RENAMED-IN-WINDOW' });
      cache.set('starnet.save', JSON.stringify(legacy));
      const host = sidecar(root);
      let adopts = 0;
      const proxy = { fetch: async (u, o) => {
        const r = await host.fetch(u, o);
        if (String(u) === '/api/save/adopt' && ++adopts === 1) throw new Error('the answer was lost');
        return r;
      } };
      const Z = page(proxy, cache);
      const resumed = await Z.reconcile(legacy);
      A.eq(adopts, 2, 'k: the merge was asked once more');
      A.eq(titles(resumed), titles(host.saveStore.load('agent')), 'k: the page resumes the station file');
      persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'after', history: [turn('user', 'after')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'k: its next save lands — not frozen');
    }

    // ================= l. a tab reopened while ANOTHER StarNet tab is live never merges under it =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true, legacyFile: true });
      class Channel extends BroadcastChannel { constructor(n) { super(n); this.unref(); } }
      const host = sidecar(root);
      const liveCache = new Map();
      const L = page(host, liveCache, { BroadcastChannel: Channel });   // a live tab of this station, already open
      await L.reconcile(null);
      const before = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      const Z = page(host, cache, { BroadcastChannel: Channel });
      await Z.reconcile(JSON.parse(cache.get('starnet.save')));
      await Z.flush({ force: true });
      A.eq([Z.mergeNotice(), backups(root).length], [null, 0], 'l: the reopened tab hears the live one and merges nothing');
      A.eq(fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8'), before, 'l: the station file is untouched');
      A.ok(conflictFiles(root).length >= 1, 'l: the reopened tab\'s save is preserved beside it, as before');
    }

    // ================= i. two pages booting on the same old cache: the second moves nothing under the first (review #5) =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true, legacyFile: true });
      const copy = new Map(cache);                                   // the app and a restored tab both read the cache at boot
      const host = sidecar(root);
      const P1 = page(host, cache), P2 = page(host, copy);
      const r1 = await P1.reconcile(JSON.parse(cache.get('starnet.save')));
      const rev1 = host.saveStore.load('agent')._saveRevision;
      await P2.reconcile(JSON.parse(copy.get('starnet.save')));
      A.eq(host.saveStore.load('agent')._saveRevision, rev1, 'i: the second page\'s merge brings nothing, so it writes nothing');
      persist(P1, cache, Object.assign(clone(r1), { workstreams: r1.workstreams.concat([{ id: 'P1-next', history: [turn('user', 'p')] }]) }));
      A.eq(await P1.flush({ force: true }), true, 'i: the first page is not frozen: its next save lands');
      A.eq(P1.health().conflict, null, 'i: with no conflict');
    }
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e));
  } finally {
    K.cleanup();
  }
  A.report('save-adopt-merge');
})();
