/* node test/save-empty-station-seed.test.js — bug 5c019483: an empty station file never re-seeded from the browser save,
   and the banner blamed another window.

   The bug (onboarding sweep, 2026-10-20): the workspace was wiped (dev/onboard-fresh.js restart; a deleted, moved or
   reset workspace folder; a fresh install over an old WebView profile) while the browser still held the station's save
   at _saveRevision 23. Boot resumed it from the browser copy and pushed it to "seed the server", but savestore's CAS read
   the missing station file as revision 0, so 23 !== 0 wrote a conflict snapshot and NEVER the station: every autosave was
   refused, and the banner said "Another window saved newer station changes" when no other window existed. Its "Reload
   current station" then deleted the browser copy and dropped the Commander into first-run onboarding.

   Drives the REAL path: frontend/app/cloudsave.js (vm) -> the REAL GET/POST /api/save handlers sliced out of
   sidecar/index.js -> the REAL savestore on a temp workspace, then the REAL save-light renderer from stationui.js:
     1. an empty station file is re-seeded from the browser copy at a revision no window can hold (the clock, never below
        the copy's own number + 1), no conflict, the cache marked clean, the next autosave and a reload carry on with no
        false conflict, and the save light says ONCE what happened;
     2. a NON-EMPTY station file is never overwritten by a stale copy (the normal conflict and its banner stay);
     3. a RECOVERABLE station file (main gone, .bak intact; or a main that cannot be read) is never overwritten;
     4. a RESET generation (ERASE EVERYTHING / START FRESH receipt) never takes back a station founded before the reset,
        and the banner says so instead of blaming another window; a station founded after the reset still re-seeds;
        a receipt that cannot be read, or a copy with no founding time, proves nothing and is refused;
     6. TWO WINDOWS of the lost station (review of the first fix: a seed at revision 1 made old numbers valid again): the
        first copy seeds, a stale second window frozen at revision 5 stays refused after the seeding window's autosaves
        pass 5 (it used to match and replace the newer station), after a sidecar restart too, and its banner says another
        window's copy was saved back first, never that the station file is newer; a NEWER copy that lost the race is
        told the same, and a conflict inside the re-seeded line stays the ordinary one. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fnBody } = require('./_fnbody.js');
const { makeSaveStore } = require('../sidecar/savestore.js');

const repo = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');
const indexSrc = readSidecarSource();
const handlers = ['function crewLooksOf(save)', 'function seedSaveMemos(agentId, doc)', 'function serveSaveLoad(req, res)', 'async function handleSaveWrite(req, res)',
  'function serveSaveConflicts(req, res)', 'async function handleSaveConflictRestore(req, res)',
  'function keepStationGrowth(doc, station)', 'function keepTerminalApprovals(doc, station)', 'async function handleSaveAdopt(req, res)']
  .map(h => { const b = fnBody(indexSrc, h); A.ok(b.startsWith(h) && b.length < 6000, 'sliced exactly ' + h); return b; });
const cloudsaveSrc = read('frontend/app/cloudsave.js');
const ui = read('frontend/app/stationui.js');
const dotStart = ui.indexOf('  let degradedNotified = false;');
const dotEnd = ui.indexOf('  // relative-time formatter', dotStart);
A.ok(dotStart > 0 && dotEnd > dotStart, 'the shipped save-light renderer is found in stationui.js');

const roots = [];
function workspace() { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'save-seed-')); roots.push(r); return r; }
const conflictFiles = root => fs.readdirSync(root).filter(n => n.indexOf('agent.save-conflict-') === 0);

// the sidecar side: the real /api/save handlers over a real savestore rooted at the workspace. o.noMerge: the station refuses
// every merge — a case about a conflict that STANDS (since save-latch-kill a refused save is merged in-session)
function sidecar(root, storeFs, o) {
  o = o || {};
  const saveStore = makeSaveStore({ fs: storeFs || fs, pathMod: path, root, clock: { now: () => Date.now() } });
  const api = vm.runInNewContext("let _remoteLooksMemo = { stamp: '', looks: null };\nlet _stationEpochMemo = { stamp: '', epoch: 1 };\n" + handlers.join('\n') +
    '\n({ serveSaveLoad, handleSaveWrite, serveSaveConflicts, handleSaveConflictRestore, handleSaveAdopt })', {
    saveStore, workspaceDegraded: false, growthRatings: { latestTs: () => 0 }, readBody: async req => req.body, failNote: () => {},
    observeDeletedSessions: () => [], Buffer,   // the deleted-session ledger feed every landed station save calls (qa/bugs/3e926b6a)
    require: m => { if (m === './save-restore.js') return require('../sidecar/save-restore.js'); throw new Error('unexpected require ' + m); },
    publicWorkspaceLineage: () => ({ version: 1, priorInstallEvidence: false, onboardingAllowed: true, evidence: [] }), URL
  });
  async function call(fn, req) {
    let code = 0, text = '';
    await fn(req, { writeHead: c => { code = c; }, end: b => { text = b; } });
    return { ok: code >= 200 && code < 300, status: code, json: async () => JSON.parse(text) };
  }
  return {
    saveStore,
    conflicts: () => call(api.serveSaveConflicts, { url: '/api/save/conflicts' }).then(r => r.json()),
    restore: file => call(api.handleSaveConflictRestore, { body: JSON.stringify({ file }) }).then(r => r.json()),
    fetch: (url, opts) => String(url).indexOf('/api/save/adopt') === 0 ? (o.noMerge ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: 'merge refused: this case keeps its conflict standing' }) }) : call(api.handleSaveAdopt, { body: opts.body }))   // a reopening window's unprovable save, merged
      : (opts && opts.method === 'POST')
      ? call(api.handleSaveWrite, { body: opts.body })
      : call(api.serveSaveLoad, { url: String(url) })
  };
}
// the page side: the real cloudsave.js with the browser cache as a Map
function page(host, cache) {
  const context = { console, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout, clearTimeout, AbortController,
    location: { reload() {} },
    localStorage: { getItem: k => (cache.has(k) ? cache.get(k) : null), setItem: (k, v) => cache.set(k, v), removeItem: k => cache.delete(k) },
    Save: { CURRENT: 6, load: () => JSON.parse(cache.get('starnet.save') || 'null') },
    fetch: (url, opts) => host.fetch(url, opts) };
  vm.runInNewContext(cloudsaveSrc, context);
  return context.module.exports;
}
// the real save light + conflict banner, rendered against a page's CloudSave
function saveLight(cloudSave) {
  const dot = { title: '', cls: new Set() };
  dot.classList = { add: (...k) => k.forEach(x => dot.cls.add(x)), remove: (...k) => k.forEach(x => dot.cls.delete(x)) };
  const notices = [], nodes = new Map();
  const mk = tag => ({ tag, style: {}, children: [], textContent: '', setAttribute() {}, append(...c) { this.children.push(...c); } });
  const document = { getElementById: id => nodes.get(id) || null, createElement: mk,
    body: { append(n) { if (n && n.id) nodes.set(n.id, n); } } };
  const c = vm.createContext({ CloudSave: cloudSave, document, $: sel => (sel === '#save-dot' ? dot : null), notify: (...a) => notices.push(a), Blob: function () {}, URL });
  const render = vm.runInContext('(function () {' + ui.slice(dotStart, dotEnd) + '\nreturn refreshSaveDurability; })()', c);
  return {
    render() { render(dot); const banner = nodes.get('save-conflict-notice'); return { cls: Array.from(dot.cls).join(' ') || 'plain', title: dot.title,
      banner: banner ? banner.children.map(n => n.textContent) : null, notices: notices.slice() }; }
  };
}
const browserCopy = (over) => Object.assign({
  schema: 'starnet.save', version: 6, updatedAt: 9000, _saveRevision: 23, _saveDirty: true, _saveClient: 'page-before-the-wipe',
  agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, agents: [],
  workstreams: [{ id: 'general', history: [{ role: 'user', content: 'the work from before the wipe' }] }], activeId: 'general', generalId: 'general'
}, over || {});

(async () => {
  try {
    // ================= 1. the bug: an empty station file re-seeds from the browser copy =================
    {
      const root = workspace();
      const host = sidecar(root);
      const cache = new Map([['starnet.save', JSON.stringify(browserCopy())]]);
      const p = page(host, cache);
      const resumed = await p.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(resumed && resumed.agent && resumed.agent.name, 'NOVA', '1: boot resumes the station from the browser copy');
      A.eq(p.pullOutcome(), 'empty', '1: the station file proved empty (GET /api/save -> save:null)');
      const seedClock = Date.now();
      A.eq(await p.flush({ force: true }), true, '1: the browser copy re-seeds the empty station file (was refused as a conflict)');
      const h = p.health();
      A.eq(h.conflict, null, '1: no conflict is latched — nobody else wrote this station');
      A.eq(conflictFiles(root), [], '1: no conflict snapshot was written');
      const durable = host.saveStore.load('agent');
      A.eq(durable && durable.agent && durable.agent.name, 'NOVA', '1: the station file now holds the station');
      A.eq(durable && durable.workstreams[0].history[0].content, 'the work from before the wipe', '1: with its work intact');
      const seededAt = durable && durable._saveRevision;
      A.ok(Number.isInteger(seededAt) && seededAt > 23 && seededAt >= seedClock, '1: at a revision no window of the lost file can hold: above the copy\'s 23 and at the clock (' + seededAt + ')');
      A.ok(h.seeded && h.seeded.revision === seededAt, '1: health records that this window\'s copy seeded the station file (' + JSON.stringify(h.seeded) + ')');
      const cached = JSON.parse(cache.get('starnet.save'));
      A.eq([cached._saveRevision, cached._saveDirty], [seededAt, false], '1: the browser cache is marked clean at the seeded revision');

      const light = saveLight(p).render();
      A.eq(light.banner, null, '1: no conflict banner');
      A.ok(!/another window/i.test(light.title), '1: the save light never blames another window (' + light.title + ')');
      const told = light.notices.filter(n => /station file/i.test(String(n[0])) && /missing/i.test(String(n[0])) && /this window/i.test(String(n[0])));
      A.eq(told.length, 1, '1: one notice says the station file was missing and this window\'s copy was saved back (' + JSON.stringify(light.notices) + ')');

      const next = structuredClone(cached); next.updatedAt = 9100; next._saveDirty = true;
      next.workstreams[0].history.push({ role: 'assistant', content: 'after the re-seed' });
      cache.set('starnet.save', JSON.stringify(next)); p.push(next);
      A.eq(await p.flush({ force: true }), true, '1: the next autosave lands');
      A.eq((host.saveStore.load('agent') || {})._saveRevision, seededAt + 1, '1: at the next revision, with no false conflict');

      const reloaded = page(host, cache);
      const back = await reloaded.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(reloaded.pullOutcome(), 'save', '1: a reload finds the station in the station file');
      A.eq([back && back.agent && back.agent.name, reloaded.revision(), reloaded.health().conflict], ['NOVA', seededAt + 1, null], '1: and resumes it at its revision with no conflict');
      A.eq(saveLight(reloaded).render().notices.length, 0, '1: a later page that seeded nothing says nothing');
    }

    // ================= 2. a NON-EMPTY station file is never overwritten by a stale copy =================
    {
      const root = workspace();
      const host = sidecar(root);
      const sol = browserCopy({ _saveRevision: 0, _saveDirty: false, updatedAt: 100, agent: { id: 'agent', name: 'SOL', createdAt: 4000 } });
      const solRevision = host.saveStore.save('agent', sol, { compareRevision: true }).revision;
      A.ok(Number.isInteger(solRevision) && solRevision > 23, '2: the station file holds SOL (a first save on an empty file takes the clock revision: ' + solRevision + ')');
      const before = fs.readFileSync(path.join(root, 'agent.save.json'));
      const cache = new Map([['starnet.save', JSON.stringify(browserCopy())]]);
      const p = page(host, cache);
      await p.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(await p.flush({ force: true }), false, '2: a stale copy (revision 23) is refused');
      const c = p.health().conflict;
      A.ok(c && c.conflict === true && c.revision === solRevision && !c.reset && !c.seeded && !c.reseeded && !c.ownSeed, '2: as an ordinary conflict against the station\'s revision (' + JSON.stringify(c) + ')');
      A.ok(fs.readFileSync(path.join(root, 'agent.save.json')).equals(before), '2: the station file is byte-for-byte unchanged');
      A.eq(conflictFiles(root).length, 1, '2: the refused copy is kept as a conflict snapshot');
      const light = saveLight(p).render();
      A.ok(light.cls === 'degraded' && /another window/i.test(light.title), '2: a real newer save keeps the another-window banner (' + light.title + ')');
      A.eq(light.notices.length, 0, '2: and no re-seed notice');
    }

    // ================= 3. a RECOVERABLE station file is never overwritten =================
    {
      const root = workspace();
      const host = sidecar(root);
      const sol = browserCopy({ _saveRevision: 0, _saveDirty: false, updatedAt: 100, agent: { id: 'agent', name: 'SOL', createdAt: 4000 } });
      host.saveStore.save('agent', sol, { compareRevision: true });
      host.saveStore.save('agent', Object.assign({}, sol, { updatedAt: 200, _saveRevision: 1 }), { compareRevision: true });
      const main = path.join(root, 'agent.save.json');
      fs.unlinkSync(main);   // the main is gone; its last-known-good .bak still holds SOL
      const bak = fs.readFileSync(main + '.bak');
      const fresh = sidecar(root);
      const cache = new Map([['starnet.save', JSON.stringify(browserCopy())]]);
      const p = page(fresh, cache);
      await p.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(p.pullOutcome(), 'save', '3: a station file with only its .bak is NOT empty (the pull recovers SOL)');
      A.eq(await p.flush({ force: true }), false, '3: the stale copy cannot replace the recoverable station');
      A.ok(fs.readFileSync(main + '.bak').equals(bak), '3: the .bak is byte-for-byte unchanged');
      A.eq(((fresh.saveStore.load('agent') || {}).agent || {}).name, 'SOL', '3: the station still reads as SOL');
      A.ok(!fs.existsSync(main), '3: no main was seeded from the stale copy');

      // a main that EXISTS but cannot be read this instant (locked) is not empty either
      const lockedRoot = workspace();
      fs.writeFileSync(path.join(lockedRoot, 'agent.save.json'), JSON.stringify({ version: 1, agentId: 'agent', updatedAt: 1, doc: sol }));
      const lockedFs = new Proxy(fs, { get(t, k) {
        if (k === 'readFileSync') return function (f) { if (/agent\.save\.json$/.test(String(f))) { const e = new Error('EBUSY: locked'); e.code = 'EBUSY'; throw e; } return t.readFileSync.apply(t, arguments); };
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      const lockedStore = makeSaveStore({ fs: lockedFs, pathMod: path, root: lockedRoot, clock: { now: () => Date.now() } });
      const r = lockedStore.save('agent', browserCopy(), { compareRevision: true });
      A.ok(r.ok === false && r.unreadable === true && !r.seeded, '3: a locked station file refuses the copy (' + JSON.stringify(r) + ')');
      A.eq(JSON.parse(fs.readFileSync(path.join(lockedRoot, 'agent.save.json'), 'utf8')).doc.agent.name, 'SOL', '3: and keeps its bytes');
    }

    // ================= 4. a RESET generation never takes back the station from before the reset =================
    {
      // the native ERASE EVERYTHING receipt (src-tauri fresh_start.rs): at = epoch milliseconds as a string
      const root = workspace();
      fs.writeFileSync(path.join(root, '.fresh-start.json'), JSON.stringify({ version: 1, erased: true, at: '7000', acknowledgedRoots: [], quarantine: null, moved: [] }, null, 2));
      const host = sidecar(root);
      const cache = new Map([['starnet.save', JSON.stringify(browserCopy())]]);
      const p = page(host, cache);
      await p.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(p.pullOutcome(), 'empty', '4: the erased generation\'s station file is empty');
      A.eq(await p.flush({ force: true }), false, '4: a station founded BEFORE the erase is not written back into it');
      const c = p.health().conflict;
      A.ok(c && c.conflict === true && c.reset === true && c.revision === 0, '4: the refusal says the station was reset (' + JSON.stringify(c) + ')');
      A.eq(host.saveStore.load('agent'), undefined, '4: the station file stays empty');
      A.eq(conflictFiles(root).length, 1, '4: this window\'s copy is still kept aside, never lost');
      const light = saveLight(p).render();
      A.ok(light.cls === 'degraded' && !/another window/i.test(light.title) && /reset/i.test(light.title) && /not restored/i.test(light.title),
        '4: the save light says the station was reset and the copy was not restored, never another window (' + light.title + ')');
      A.ok(light.banner && !/another window/i.test(light.banner[0]) && /reset \(erased/.test(light.banner[0]), '4: so does the banner (' + JSON.stringify(light.banner) + ')');
      A.ok(light.banner && light.banner.some(t => /fresh station/i.test(t)), '4: its reload button names the fresh station it leads to');
      A.eq(light.notices.length, 0, '4: and no re-seed notice');

      // a station founded AFTER the erase (its own station file lost later) still re-seeds
      const after = page(host, new Map([['starnet.save', JSON.stringify(browserCopy({ agent: { id: 'agent', name: 'VEGA', createdAt: 8000 } }))]]));
      await after.reconcile(browserCopy({ agent: { id: 'agent', name: 'VEGA', createdAt: 8000 } }));
      A.eq(await after.flush({ force: true }), true, '4: a station founded after the erase re-seeds the empty station file');
      A.eq(((host.saveStore.load('agent') || {}).agent || {}).name, 'VEGA', '4: as the station file\'s first revision');
      // the copy kept aside from before the erase is erased work (#101): listed, never offered back at boot, never restored
      const kept = conflictFiles(root)[0];
      const listed = await host.conflicts();
      const pre = (listed.conflicts || []).find(x => x.file === kept);
      A.ok(pre && pre.restorable === 0 && pre.predatesReset === true, '4: the pre-erase copy is never offered back (' + JSON.stringify(listed) + ')');
      const refusedRestore = await host.restore(kept);
      A.ok(refusedRestore.ok === false && refusedRestore.predatesReset === true, '4: a restore of it is refused (' + JSON.stringify(refusedRestore) + ')');
      A.eq(((host.saveStore.load('agent') || {}).agent || {}).name, 'VEGA', '4: and the fresh station is untouched');
      A.ok(!light.banner.some(t => /restore this window/i.test(t)), '4: the reset banner offers no restore (' + JSON.stringify(light.banner) + ')');

      // START FRESH through the sidecar (workspace-lineage.js startFresh): at = an ISO timestamp
      const iso = workspace();
      fs.writeFileSync(path.join(iso, '.fresh-start.json'), JSON.stringify({ version: 1, at: new Date(7000).toISOString(), acknowledgedRoots: [], quarantine: null, moved: [] }));
      const isoStore = makeSaveStore({ fs, pathMod: path, root: iso, clock: { now: () => Date.now() } });
      const before = isoStore.save('agent', browserCopy(), { compareRevision: true });
      A.ok(before.ok === false && before.reset === true, '4: START FRESH refuses a station founded before it (' + JSON.stringify(before) + ')');
      const noBirth = isoStore.save('agent', browserCopy({ agent: { id: 'agent', name: 'OLD' } }), { compareRevision: true });
      A.ok(noBirth.ok === false && noBirth.reset === true, '4: a copy with no founding time proves nothing and is refused');
      const later = isoStore.save('agent', browserCopy({ agent: { id: 'agent', name: 'VEGA', createdAt: 8000 } }), { compareRevision: true });
      A.ok(later.ok === true && later.revision > 23 && later.seeded === true, '4: a station founded after START FRESH re-seeds (' + JSON.stringify(later) + ')');

      // a receipt that cannot be read proves nothing either
      const torn = workspace();
      fs.writeFileSync(path.join(torn, '.fresh-start.json'), '{ torn');
      const tornStore = makeSaveStore({ fs, pathMod: path, root: torn, clock: { now: () => Date.now() } });
      const t = tornStore.save('agent', browserCopy({ agent: { id: 'agent', name: 'VEGA', createdAt: 8000 } }), { compareRevision: true });
      A.ok(t.ok === false && t.reset === true, '4: an unreadable reset receipt refuses the copy (' + JSON.stringify(t) + ')');
      A.eq(tornStore.load('agent'), undefined, '4: and leaves the station file empty');
    }

    // ================= 6. TWO WINDOWS of the lost station: a stale one can never match the seeded file =================
    // (a station that REFUSES the merge, so window B's conflict stands: the seed's CAS, its words and its banner. The merge a
    // refused save now gets in-session is test/save-interleave.seeded.test.js)
    {
      const root = workspace();
      const host = sidecar(root, null, { noMerge: true });
      // window A holds the newest copy (last ACK 23); window B is a stale window of the same station, frozen at revision 5
      const cacheA = new Map([['starnet.save', JSON.stringify(browserCopy({ _saveClient: 'window-a' }))]]);
      const staleCopy = () => browserCopy({ _saveRevision: 5, updatedAt: 9500, _saveClient: 'window-b',
        workstreams: [{ id: 'general', history: [{ role: 'user', content: 'the stale window\'s old world' }] }] });
      const cacheB = new Map([['starnet.save', JSON.stringify(staleCopy())]]);
      const a = page(host, cacheA), b = page(host, cacheB);
      await a.reconcile(JSON.parse(cacheA.get('starnet.save')));
      await b.reconcile(JSON.parse(cacheB.get('starnet.save')));
      A.eq([a.pullOutcome(), b.pullOutcome(), a.revision(), b.revision()], ['empty', 'empty', 23, 5], '6: both windows booted over the empty station file with their own revisions');
      A.eq(await a.flush({ force: true }), true, '6: window A\'s copy seeds the station file');
      const seededAt = a.revision();
      A.eq(await b.flush({ force: true }), false, '6: window B\'s stale copy is refused');
      const cb = b.health().conflict;
      A.ok(cb && cb.conflict === true && cb.reseeded === true && !cb.reset && cb.revision === seededAt,
        '6: as a conflict that says the station file was re-seeded from another copy (' + JSON.stringify(cb) + ')');
      A.eq(b.revision(), 5, '6: window B keeps its frozen revision (every later autosave is stamped 5)');
      // window A keeps working: four autosaves, so a revision line restarted at 1 would now hold exactly B's 5
      let work = JSON.parse(cacheA.get('starnet.save'));
      for (let i = 0; i < 4; i++) {
        work = structuredClone(work); work.updatedAt = 9100 + i; work._saveDirty = true;
        work.workstreams[0].history.push({ role: 'assistant', content: 'window A work ' + i });
        cacheA.set('starnet.save', JSON.stringify(work)); a.push(work);
        A.eq(await a.flush({ force: true }), true, '6: window A autosave ' + i + ' lands');
      }
      A.eq(a.revision(), seededAt + 4, '6: the station file moved four revisions past the seed (to ' + a.revision() + ')');
      const beforeB = fs.readFileSync(path.join(root, 'agent.save.json'));
      // window B autosaves again, still at revision 5
      const staleNext = staleCopy(); staleNext.updatedAt = 9600; cacheB.set('starnet.save', JSON.stringify(staleNext)); b.push(staleNext);
      A.eq(await b.flush({ force: true }), false, '6: window B\'s next autosave is STILL refused (it used to match revision 5 and replace the station)');
      A.ok(fs.readFileSync(path.join(root, 'agent.save.json')).equals(beforeB), '6: the station file is byte-for-byte window A\'s');
      const durable = host.saveStore.load('agent');
      A.eq(durable && durable.workstreams[0].history.slice(-1)[0].content, 'window A work 3', '6: with window A\'s latest work');
      A.ok(conflictFiles(root).some(n => fs.readFileSync(path.join(root, n), 'utf8').indexOf('the stale window\'s old world') >= 0), '6: window B\'s copy is kept aside, never lost');
      // window A is never told that another window wrote over it
      work = structuredClone(work); work.updatedAt = 9200; work.workstreams[0].history.push({ role: 'assistant', content: 'window A after B' });
      cacheA.set('starnet.save', JSON.stringify(work)); a.push(work);
      A.eq([await a.flush({ force: true }), a.health().conflict], [true, null], '6: window A\'s next autosave lands with no conflict');
      // a sidecar restart still knows where the re-seed began (it is in the station file's wrapper, not only in memory)
      const restarted = sidecar(root);
      const r = restarted.saveStore.save('agent', Object.assign(staleCopy(), { updatedAt: 9700 }), { compareRevision: true });
      A.ok(r.ok === false && r.conflict === true && r.reseeded === true, '6: after a restart the stale copy is still refused as pre-re-seed (' + JSON.stringify(r) + ')');
      // a NEWER copy than the one that seeded (last ACK 30) lost the race: refused too, and told the same
      const r30 = restarted.saveStore.save('agent', browserCopy({ _saveRevision: 30, updatedAt: 9800, _saveClient: 'window-c' }), { compareRevision: true });
      A.ok(r30.ok === false && r30.conflict === true && r30.reseeded === true, '6: a newer copy that lost the race is refused as pre-re-seed as well (' + JSON.stringify(r30) + ')');
      A.eq((restarted.saveStore.load('agent') || {}).workstreams[0].history.slice(-1)[0].content, 'window A after B', '6: and the station file still holds window A\'s latest work');
      // window B's save light and banner
      const lightB = saveLight(b).render();
      A.ok(lightB.cls === 'degraded' && !/newer/i.test(lightB.title) && /missing/i.test(lightB.title) && /another window/i.test(lightB.title) && /saved back to it first/i.test(lightB.title),
        '6: window B is told the station file was missing and another window\'s copy was saved back first, never that it is newer (' + lightB.title + ')');
      A.ok(lightB.banner && !/newer/i.test(lightB.banner[0]) && lightB.banner.some(t => /reload current station/i.test(t)), '6: so does its banner (' + JSON.stringify(lightB.banner) + ')');
      A.ok(lightB.banner.some(t => /restore this window/i.test(t)), '6: and it offers to bring this window\'s sessions into the station (' + JSON.stringify(lightB.banner) + ')');
      // a conflict from INSIDE the re-seeded line is still the ordinary another-window conflict
      const rd = restarted.saveStore.save('agent', browserCopy({ _saveRevision: seededAt + 1, updatedAt: 9950, _saveClient: 'window-d' }), { compareRevision: true });
      A.ok(rd.ok === false && rd.conflict === true && !rd.reseeded && !rd.reset, '6: a copy from inside the re-seeded line conflicts as an ordinary newer save (' + JSON.stringify(rd) + ')');
    }

    // ================= the first save of a brand-new station is unchanged =================
    {
      const root = workspace();
      fs.writeFileSync(path.join(root, '.fresh-start.json'), JSON.stringify({ version: 1, erased: true, at: '7000', acknowledgedRoots: [], quarantine: null, moved: [] }));
      const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });
      const firstClock = Date.now();
      const first = store.save('agent', browserCopy({ _saveRevision: 0, agent: { id: 'agent', name: 'NEW', createdAt: 9000 } }), { compareRevision: true });
      // review 10-23 #2: at the clock revision (a first save on an empty file), so no stale window of the station from before can match it
      A.ok(first.ok === true && first.revision >= firstClock && first.seeded === undefined, '5: a new station\'s first save (revision 0) lands at the clock revision and is not called a re-seed (' + JSON.stringify(first) + ')');
    }
  } finally {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  }
  A.report('save-empty-station-seed');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
