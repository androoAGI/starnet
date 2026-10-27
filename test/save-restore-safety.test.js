/* node test/save-restore-safety.test.js — the preserved-save RESTORE and the reset guard are safe (review 10-23, lane
   save-restore-1023). Each case reproduces a hostile-review proof against the REAL code: frontend/app/cloudsave.js in a vm
   -> the REAL /api/save + /api/save/conflicts handlers sliced out of sidecar/index.js -> the REAL savestore on a temp
   workspace, and the REAL boot offer + conflict banner sliced out of stationui.js.

     1.  a restore never throws away the clicking window's unsaved work: a healthy window's debounced change is saved
         first (proof1); a refused save that preserved nothing stops the restore and keeps the cache and the queued save
         (proof1b, revision-agnostic); this window's own preserved copy still restores;
     2.  a stale pre-reset window can never overwrite the fresh station: every first save on an empty file takes the clock
         revision (proof6), a pre-reset copy at revision 0 is refused on the empty file, an explicit RESTORE BACKUP and a
         station founded after the reset still save, and the wire flag never reaches the station file;
     3a. the boot offer's "Not now" sticks: a watermark at that copy's time (a copy written after it is offered again);
     3c. a session the sidecar's deleted-session ledger holds is never counted or restored;
     3d. the boot offer's cost: nothing preserved reads nothing; a snapshot is read once; the station is never deep-cloned;
         the review's 3.2 MiB / 20-file scenario stays far below its 787 ms;
     5.  after a reset, a station that itself predates the receipt (a restored backup) restores its own preserved copies;
         erased work is refused and its banner never shows a Restore key;
     6.  a window's own late-acknowledged re-seed, after a restart, is never blamed on another window;
     7.  restore backups keep the newest three. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fnBody } = require('./_fnbody.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { plan } = require('../sidecar/save-restore.js');

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
A.ok(dotStart > 0 && dotEnd > dotStart, 'the shipped save-light renderer + boot offer are found in stationui.js');

const roots = [];
function workspace() { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'save-restore-safety-')); roots.push(r); return r; }
const conflictFiles = root => fs.readdirSync(root).filter(n => /^agent\.save-conflict-.*\.json$/.test(n));
const turn = (role, content) => ({ role, content });
const stationDoc = over => Object.assign({
  schema: 'starnet.save', version: 6, updatedAt: 1000, _saveRevision: 0, _saveDirty: false,
  agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, agents: [], generalId: 'general', activeId: 'general', deletedIds: [],
  workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }]
}, over || {});
const receipt = (root, at) => fs.writeFileSync(path.join(root, '.fresh-start.json'), JSON.stringify({ version: 1, at: new Date(at).toISOString(), acknowledgedRoots: [], quarantine: null, moved: [] }));

// the sidecar side: the real handlers over a real savestore. o.tombstones: the deleted-session ledger; o.fs: an fs facade
function sidecar(root, o) {
  o = o || {};
  const store = makeSaveStore({ fs: o.fs || fs, pathMod: path, root, clock: { now: () => Date.now() } });
  let latestRatingAt = 0;
  const sandbox = { saveStore: store, workspaceDegraded: false, growthRatings: { latestTs: () => latestRatingAt }, readBody: async req => req.body, failNote: () => {},
    observeDeletedSessions: () => [], Date, Buffer,
    require: m => { if (m === './save-restore.js') return require('../sidecar/save-restore.js'); throw new Error('unexpected require ' + m); },
    publicWorkspaceLineage: () => ({ version: 1 }), URL };
  if (o.tombstones) sandbox.sessionTombstones = o.tombstones;
  const api = vm.runInNewContext("let _remoteLooksMemo = { stamp: '', looks: null };\nlet _stationEpochMemo = { stamp: '', epoch: 1 };\n" + handlers.join('\n') +
    '\n({ serveSaveLoad, handleSaveWrite, serveSaveConflicts, handleSaveConflictRestore, handleSaveAdopt })', sandbox);
  async function call(fn, req) {
    let code = 0, text = '';
    await fn(req, { writeHead: c => { code = c; }, end: b => { text = b; } });
    return { ok: code >= 200 && code < 300, status: code, json: async () => JSON.parse(text) };
  }
  const host = {
    saveStore: store, api, call, setRatingAt: t => { latestRatingAt = t; },
    conflicts: (url) => call(api.serveSaveConflicts, { url: url || '/api/save/conflicts' }).then(r => r.json()),
    restore: file => call(api.handleSaveConflictRestore, { body: JSON.stringify({ file }) }).then(r => r.json()),
    fetch: (url, opts) => {
      const u = String(url);
      if (u.indexOf('/api/save/conflicts/restore') === 0) return call(api.handleSaveConflictRestore, { body: opts.body });
      if (u.indexOf('/api/save/conflicts') === 0) return call(api.serveSaveConflicts, { url: u });
      // o.noMerge: the station refuses every merge — a case about a conflict that STANDS (since save-latch-kill a refused save is
      // merged in-session, so only a refused merge leaves the conflict, its banner and its restore in place)
      if (u.indexOf('/api/save/adopt') === 0) return o.noMerge ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: 'merge refused: this case keeps its conflict standing' }) }) : call(api.handleSaveAdopt, { body: opts.body });   // a reopening window's unprovable save, merged
      return (opts && opts.method === 'POST') ? call(api.handleSaveWrite, { body: opts.body }) : call(api.serveSaveLoad, { url: u });
    }
  };
  return host;
}
// the page side: the real cloudsave.js with the browser cache as a Map
function page(host, cache, extra) {
  const reloads = [];
  const context = Object.assign({ console, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout, clearTimeout, AbortController,
    location: { reload() { reloads.push(1); } },
    localStorage: { getItem: k => (cache.has(k) ? cache.get(k) : null), setItem: (k, v) => cache.set(k, v), removeItem: k => cache.delete(k) },
    Save: { CURRENT: 6, load: () => JSON.parse(cache.get('starnet.save') || 'null') },
    fetch: (url, opts) => host.fetch(url, opts) }, extra || {});
  vm.runInNewContext(cloudsaveSrc, context);
  const cs = context.module.exports; cs._reloads = reloads;
  return cs;
}
// the real save light + conflict banner + boot offer, against a page's CloudSave and a UI store
function stationUi(cloudSave, uiStore) {
  const dot = { title: '', cls: new Set() };
  dot.classList = { add: (...k) => k.forEach(x => dot.cls.add(x)), remove: (...k) => k.forEach(x => dot.cls.delete(x)) };
  const nodes = new Map();
  const mk = tag => ({ tag, style: {}, children: [], textContent: '', setAttribute() {}, append(...c) { this.children.push(...c); }, remove() { if (this.id) nodes.delete(this.id); } });
  const document = { getElementById: id => nodes.get(id) || null, createElement: mk, body: { append(n) { if (n && n.id) nodes.set(n.id, n); } } };
  const store = uiStore || {};
  const c = vm.createContext({ CloudSave: cloudSave, document, $: sel => (sel === '#save-dot' ? dot : null), notify: () => {}, Blob: function () {}, URL, store, save: () => true });
  const fns = vm.runInContext('(function () {' + ui.slice(dotStart, dotEnd) + '\nreturn { refreshSaveDurability, offerPreservedSaves }; })()', c);
  return {
    store, nodes,
    light() { fns.refreshSaveDurability(dot); const b = nodes.get('save-conflict-notice'); return { title: dot.title, banner: b ? b.children.map(n => n.textContent) : null }; },
    async offer() { await fns.offerPreservedSaves(); return nodes.get('save-preserved-notice') || null; }
  };
}

(async () => {
  try {
    // ================= 1. a restore never throws away this window's unsaved work =================
    {
      // proof1: a healthy window with a debounced change clicks the boot offer's restore of ANOTHER window's file
      const root = workspace();
      const host = sidecar(root);
      host.saveStore.save('agent', stationDoc(), { compareRevision: true });
      const b = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'window-b',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'from-b', title: 'B work', history: [turn('user', 'b')] }] }), { compareRevision: true });
      A.ok(b.conflict === true, '1: window B\'s save was preserved as a conflict');
      const cache = new Map();
      const c = page(host, cache);
      const resumed = await c.reconcile(null);
      const typed = JSON.parse(JSON.stringify(resumed)); typed.updatedAt = Date.now(); typed._saveDirty = true;
      typed.workstreams.push({ id: 'typed-just-now', title: 'C work', history: [turn('user', 'the thing I just asked'), turn('assistant', 'the answer')] });
      cache.set('starnet.save', JSON.stringify(typed));
      c.push(typed);
      const offer = (await c.conflicts()).find(x => x.restorable > 0);
      A.ok(offer && offer.file === b.recovery, '1: the boot offer names B\'s preserved file (' + JSON.stringify(offer) + ')');
      const r = await c.restoreConflict(offer.file);
      A.ok(r && r.ok === true && r.added === 1, '1: the restore lands');
      await new Promise(res => setTimeout(res, 1400));   // the debounce would have fired by now
      const ids = host.saveStore.load('agent').workstreams.map(w => w.id);
      A.ok(ids.includes('typed-just-now') && ids.includes('from-b'), '1: the station holds this window\'s just-typed session AND the restored one (' + ids + ')');
      A.eq(c._reloads.length, 1, '1: and the window reloads onto it');
    }
    {
      // proof1b (revision-agnostic): this window's save after its conflict is refused growth-stale, which preserves nothing
      // (a station that refuses the merge: the conflict stands, so its restore is what is tested)
      const root = workspace();
      const host = sidecar(root, { noMerge: true });
      host.saveStore.save('agent', stationDoc(), { compareRevision: true });
      const cacheA = new Map();
      let newest = null, cs = null;
      const App = { persist() { if (newest) { cacheA.set('starnet.save', JSON.stringify(newest)); cs.push(newest); } } };
      cs = page(host, cacheA, { App });
      const base = await cs.reconcile(null);
      host.saveStore.save('agent', stationDoc({ _saveRevision: host.saveStore.load('agent')._saveRevision, updatedAt: 2000, _saveClient: 'window-b' }), { compareRevision: true });
      let doc = JSON.parse(JSON.stringify(base)); doc.updatedAt = Date.now(); doc._saveDirty = true;
      doc.workstreams.push({ id: 'a-1', title: 'A first', history: [turn('user', 'one')] });
      newest = doc; App.persist();
      A.eq(await cs.flush({ force: true }), false, '1b: window A\'s save is refused as a conflict');
      const own = cs.health().conflict && cs.health().conflict.recovery;
      A.ok(!!own, '1b: and preserved in its own file');
      host.setRatingAt(Date.now() + 1);   // another window rated a run: A's next save is refused growth-stale (no file written)
      doc = JSON.parse(JSON.stringify(doc)); doc.updatedAt = Date.now() + 2;
      doc.workstreams.push({ id: 'a-2', title: 'A after the conflict', history: [turn('user', 'two'), turn('assistant', 'answer two')] });
      newest = doc;
      let threw = null;
      try { await cs.restoreConflict(own); } catch (e) { threw = e.message; }
      A.ok(threw && /nothing was restored/i.test(threw) && /nothing was lost/i.test(threw), '1b: the restore stops and says why (' + threw + ')');
      A.eq(cs._reloads.length, 0, '1b: the window does not reload');
      A.ok(cacheA.has('starnet.save') && JSON.parse(cacheA.get('starnet.save')).workstreams.some(w => w.id === 'a-2'), '1b: the browser cache still holds the newest session');
      A.ok(!host.saveStore.load('agent').workstreams.some(w => w.id === 'a-1'), '1b: nothing was merged into the station');
      // the rating catches up: the same click now saves first (into its own preserved file) and restores it whole
      host.setRatingAt(0);
      const r = await cs.restoreConflict(own);
      A.ok(r && r.ok === true, '1b: once this window\'s newest save is preserved, its own restore goes ahead');
      const ids = host.saveStore.load('agent').workstreams.map(w => w.id);
      A.ok(ids.includes('a-1') && ids.includes('a-2'), '1b: and the station holds both of this window\'s sessions (' + ids + ')');
      A.eq(cs._reloads.length, 1, '1b: then the window reloads');
    }

    // ================= 2. a stale pre-reset window can never overwrite the fresh station =================
    {
      // proof6: the old station's tab S at revision R; START FRESH; a fresh station's autosaves pass R; S saves again
      const root = workspace();
      let host = sidecar(root);
      const cacheS = new Map();
      const S = page(host, cacheS);
      await S.reconcile(null);
      let docS = stationDoc({ agent: { id: 'agent', name: 'OLD', createdAt: 5000 }, updatedAt: Date.now() });
      for (let i = 0; i < 3; i++) { docS = JSON.parse(JSON.stringify(docS)); docS.updatedAt = Date.now() + i; docS.workstreams.push({ id: 'old-' + i, history: [turn('user', 'old ' + i)] }); cacheS.set('starnet.save', JSON.stringify(docS)); S.push(docS); await S.flush({ force: true }); }
      for (const n of fs.readdirSync(root)) if (n.startsWith('agent.save')) fs.unlinkSync(path.join(root, n));
      receipt(root, 7000);
      host = sidecar(root);
      const cacheS2 = new Map(cacheS); const Sb = page(host, cacheS2); await Sb.reconcile(JSON.parse(cacheS2.get('starnet.save')));
      A.eq(await Sb.flush({ force: true }), false, '2: the stale tab\'s save after the reset is refused');
      A.ok(Sb.health().conflict && Sb.health().conflict.reset === true, '2: as a reset');
      const cacheF = new Map(); const F = page(host, cacheF); await F.reconcile(null);
      const clock0 = Date.now();
      let docF = stationDoc({ agent: { id: 'agent', name: 'FRESH', createdAt: 8000 }, updatedAt: Date.now() + 20 });
      for (let i = 0; i < 3; i++) { docF = JSON.parse(JSON.stringify(docF)); docF.updatedAt = Date.now() + 30 + i; docF.workstreams.push({ id: 'fresh-' + i, history: [turn('user', 'fresh ' + i)] }); cacheF.set('starnet.save', JSON.stringify(docF)); F.push(docF); A.eq(await F.flush({ force: true }), true, '2: fresh autosave ' + i + ' lands'); }
      A.ok(F.revision() >= clock0 && F.revision() !== Sb.revision(), '2: the fresh station\'s line starts at the clock, not at 1 (' + F.revision() + ' vs the stale tab\'s ' + Sb.revision() + ')');
      A.ok(!F.health().seeded, '2: a fresh station\'s first save is not called a re-seed');
      docS = JSON.parse(JSON.stringify(docS)); docS.updatedAt = Date.now() + 50; docS._saveRevision = Sb.revision(); cacheS2.set('starnet.save', JSON.stringify(docS)); Sb.push(docS);
      A.eq(await Sb.flush({ force: true }), false, '2: the stale pre-reset tab\'s next save is still refused');
      A.eq(host.saveStore.load('agent').agent.name, 'FRESH', '2: the station is still the fresh one');
    }
    {
      // a pre-reset copy at revision 0 on the empty file of a reset generation: refused (it used to land as a first save)
      const root = workspace();
      receipt(root, 7000);
      const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });
      const zero = store.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 9000, _saveClient: 'old-page' }), { compareRevision: true });
      A.ok(zero.ok === false && zero.conflict === true && zero.reset === true, '2: a pre-reset copy at revision 0 is refused on the empty file (' + JSON.stringify(zero) + ')');
      A.eq(store.load('agent'), undefined, '2: the station file stays empty');
      A.eq(conflictFiles(root).length, 1, '2: and the copy is kept aside, never lost');
      // RESTORE BACKUP of that same old station is the Commander's choice: it lands, and the wire flag is not stored
      const host = sidecar(root);
      const cache = new Map();
      const p = page(host, cache);
      await p.reconcile(null);
      const backupDoc = stationDoc({ updatedAt: Date.now(), workstreams: [{ id: 'general', title: null, history: [turn('user', 'from the backup')] }] });
      cache.set('starnet.save', JSON.stringify(backupDoc));
      p.push(backupDoc, { restore: true });
      A.eq(await p.flush({ force: true }), true, '2: an explicit RESTORE BACKUP of a pre-reset station lands on the empty file');
      const raw = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      A.ok(raw.indexOf('_saveRestore') < 0, '2: the restore flag never reaches the station file');
      A.eq(host.saveStore.load('agent').workstreams[0].history[0].content, 'from the backup', '2: the station is the restored backup');
      const next = JSON.parse(JSON.stringify(backupDoc)); next.updatedAt = Date.now() + 5; next.workstreams[0].history.push(turn('assistant', 'later'));
      cache.set('starnet.save', JSON.stringify(next)); p.push(next);
      A.eq(await p.flush({ force: true }), true, '2: and the next ordinary autosave lands on it');
      // a station founded AFTER the receipt still takes the empty file as an ordinary first save
      const root2 = workspace();
      receipt(root2, 7000);
      const store2 = makeSaveStore({ fs, pathMod: path, root: root2, clock: { now: () => Date.now() } });
      const fresh = store2.save('agent', stationDoc({ agent: { id: 'agent', name: 'NEW', createdAt: 9000 } }), { compareRevision: true });
      A.ok(fresh.ok === true && !fresh.seeded && fresh.revision > 1, '2: a station founded after the reset saves (' + JSON.stringify(fresh) + ')');
      // no receipt: a brand-new install's first save lands as before (at the clock revision)
      const root3 = workspace();
      const store3 = makeSaveStore({ fs, pathMod: path, root: root3, clock: { now: () => 4242 } });
      const plain = store3.save('agent', stationDoc(), { compareRevision: true });
      A.ok(plain.ok === true && plain.revision === 4242 && !plain.seeded, '2: no reset, a first save lands at the clock revision (' + JSON.stringify(plain) + ')');
    }

    // ================= 3a. "Not now" sticks for that preserved file =================
    {
      const root = workspace();
      const host = sidecar(root);
      host.saveStore.save('agent', stationDoc(), { compareRevision: true });
      const pre = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'window-b',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'from-b', title: 'B', history: [turn('user', 'b')] }] }), { compareRevision: true });
      const cs = page(host, new Map());
      await cs.reconcile(null);
      const uiStore = {};
      const view = stationUi(cs, uiStore);
      const banner = await view.offer();
      A.ok(banner && /1 session/.test(banner.children[0].textContent), '3a: the boot offer shows the preserved session');
      const notNow = banner.children.find(n => n.textContent === 'Not now');
      notNow.onclick();
      A.eq(view.nodes.has('save-preserved-notice'), false, '3a: Not now closes it');
      A.ok(uiStore.preservedDismissedAt >= Math.floor(fs.statSync(path.join(root, pre.recovery)).mtimeMs), '3a: and remembers that copy\'s time (' + uiStore.preservedDismissedAt + ')');
      const again = stationUi(page(host, new Map()), uiStore);   // the next boot, same browser
      A.eq(await again.offer(), null, '3a: the next boot does not offer the dismissed copy again');
      // the same window conflicts again (its file is written again): offered again
      const when = new Date(Date.now() + 60000);
      host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1600, _saveClient: 'window-b',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'from-b', title: 'B', history: [turn('user', 'b')] }, { id: 'from-b-2', title: 'B2', history: [turn('user', 'b2')] }] }), { compareRevision: true });
      fs.utimesSync(path.join(root, pre.recovery), when, when);
      const third = stationUi(page(host, new Map()), uiStore);
      const back = await third.offer();
      A.ok(back && /2 sessions/.test(back.children[0].textContent), '3a: a copy written again after the dismissal is offered again');
    }

    // ================= 3c. a deleted session (sidecar ledger) is never counted or restored =================
    {
      const root = workspace();
      const deleted = new Set(['purged-from-save-list']);
      const host = sidecar(root, { tombstones: { deletedAt: id => (deleted.has(id) ? 123 : 0), forgotten: (id, ts) => deleted.has(id) && Number(ts) <= 123 } });
      host.saveStore.save('agent', stationDoc(), { compareRevision: true });   // its deletedIds no longer lists the session (cap / NEW AGENT)
      const pre = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'window-d',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'purged-from-save-list', title: 'Payroll', history: [turn('user', 'salaries')] }, { id: 'kept', title: 'K', history: [turn('user', 'k')] }] }), { compareRevision: true });
      const listed = await host.conflicts();
      A.eq(listed.conflicts.map(c => c.restorable), [1], '3c: the deleted session is not counted (only "kept")');
      const r = await host.restore(pre.recovery);
      A.ok(r.ok === true && r.added === 1, '3c: the restore adds one session');
      const ids = host.saveStore.load('agent').workstreams.map(w => w.id);
      A.ok(ids.includes('kept') && !ids.includes('purged-from-save-list'), '3c: and never the deleted one (' + ids + ')');
    }

    // ================= 3d. the boot offer's cost =================
    {
      const root = workspace();
      const reads = { station: 0, snapshot: 0 };
      const cfs = new Proxy(fs, { get(t, k) {
        if (k === 'readFileSync') return function (f) { const n = path.basename(String(f)); if (n === 'agent.save.json') reads.station++; else if (/^agent\.save-conflict-/.test(n)) reads.snapshot++; return t.readFileSync.apply(t, arguments); };
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      const host = sidecar(root, { fs: cfs });
      const sessions = Array.from({ length: 200 }, (_, i) => ({ id: 'ws' + i, title: 's' + i, history: [turn('user', 'q' + i), turn('assistant', 'a' + i)] }));
      const st = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }].concat(sessions) });
      host.saveStore.save('agent', st, { compareRevision: true });
      reads.station = 0; reads.snapshot = 0;
      A.eq((await host.conflicts()).conflicts, [], '3d: nothing preserved: no offer');
      A.eq([reads.station, reads.snapshot], [0, 0], '3d: and nothing read (one readdir only)');
      for (let k = 0; k < 6; k++) {
        const copy = JSON.parse(JSON.stringify(st)); copy._saveRevision = 0; copy._saveClient = 'old-' + k; copy.updatedAt = 2000 + k;
        if (k === 0) copy.workstreams.push({ id: 'only-in-the-oldest', title: 'O', history: [turn('user', 'o')] });
        const r = host.saveStore.save('agent', copy, { compareRevision: true });
        const when = new Date(Date.now() + k * 60000); fs.utimesSync(path.join(root, r.recovery), when, when);   // old-0 is the OLDEST
      }
      reads.station = 0; reads.snapshot = 0;
      let found = null, calls = 0;
      while (!found && calls < 10) { calls++; found = (await host.conflicts()).conflicts.find(c => c.restorable > 0) || null; }
      A.ok(found && found.file === 'agent.save-conflict-old-0.json' && found.restorable === 1, '3d: the oldest copy\'s session is found, newest first (' + JSON.stringify(found) + ')');
      A.eq(reads.snapshot, 6, '3d: every snapshot was read exactly once across ' + calls + ' boot request(s)');
      reads.station = 0; reads.snapshot = 0;
      const settled = await host.conflicts('/api/save/conflicts?after=' + Math.floor(found.savedAt));
      A.eq([settled.conflicts, reads.station, reads.snapshot], [[], 0, 0], '3d: settled + dismissed copies: nothing is read again');
      // the station is never deep-cloned: an untouched session is the station's own object
      const pr = plan(st, { generalId: 'general', workstreams: [{ id: 'new', history: [turn('user', 'n')] }] });
      A.ok(pr.doc.workstreams[5] === st.workstreams[5] && pr.doc !== st && pr.doc.workstreams !== st.workstreams, '3d: plan copies the station shallowly');
    }
    {
      // 3e. (why the 0.14.0 boot offer was held) a copy the station could not READ this instant — locked by an antivirus scan
      // or a backup tool: EBUSY/EACCES — still holds the lost work. It used to be settled as "nothing to bring back" and was
      // never offered again while it stayed unchanged.
      const root = workspace();
      let locked = true;
      const lfs = new Proxy(fs, { get(t, k) {
        if (k === 'readFileSync') return function (f) {
          if (locked && /^agent\.save-conflict-/.test(path.basename(String(f)))) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
          return t.readFileSync.apply(t, arguments);
        };
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      const host = sidecar(root, { fs: lfs });
      const st = stationDoc();
      host.saveStore.save('agent', st, { compareRevision: true });
      const copy = Object.assign(JSON.parse(JSON.stringify(st)), { _saveRevision: 0, _saveClient: 'closed-window', updatedAt: 3000 });
      copy.workstreams.push({ id: 'lost-work', title: 'L', history: [turn('user', 'l')] });
      const r = host.saveStore.save('agent', copy, { compareRevision: true });
      A.ok(r.conflict === true, 'fixture: a closed window\'s save is preserved beside the station');
      const busy = await host.conflicts();
      A.ok(busy.conflicts.length === 0 && !busy.more, '3e: an unreadable copy offers nothing this boot, and does not make the page ask again and again (' + JSON.stringify(busy) + ')');
      locked = false;
      const later = await host.conflicts();
      A.ok(later.conflicts.some(c => c.file === r.recovery && c.restorable === 1), '3e: once it can be read, it is offered — it was never settled (' + JSON.stringify(later) + ')');
    }
    {
      // the review's scenario: a 3.2 MiB station and 20 whole-station snapshots (it held the sidecar thread for 787 ms)
      const root = workspace();
      const host = sidecar(root);
      const sessions = Array.from({ length: 950 }, (_, i) => ({ id: 'ws' + i, title: 'session ' + i, agentId: 'agent', lane: 'active', runIds: [],
        history: [turn('user', 'q'.repeat(600) + i), turn('assistant', 'a'.repeat(1800) + i), turn('user', 'q2 ' + i), turn('assistant', 'b'.repeat(900))] }));
      const st = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }].concat(sessions) });
      host.saveStore.save('agent', st, { compareRevision: true });
      for (let k = 0; k < 20; k++) {
        const copy = JSON.parse(JSON.stringify(st)); copy._saveRevision = 0; copy._saveClient = 'old-window-' + k; copy.updatedAt = 2000 + k;
        host.saveStore.save('agent', copy, { compareRevision: true });
      }
      const t0 = process.hrtime.bigint();
      await host.conflicts();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log('  3d: GET /api/save/conflicts on a 3.2 MiB station with 20 snapshots: ' + ms.toFixed(0) + ' ms (was 787 ms)');
      A.ok(ms < 400, '3d: the boot offer stays far below the review\'s 787 ms (' + ms.toFixed(0) + ' ms)');
    }

    // ================= 5. after a reset: a restored backup's own copies restore; erased work never offers Restore =================
    {
      const root = workspace();
      receipt(root, 7000);
      const host = sidecar(root, { noMerge: true });   // a station that refuses the merge: window C's conflict stands, with its banner
      // a fresh station founded after the reset, then the Commander restores the old station's backup into it
      host.saveStore.save('agent', stationDoc({ agent: { id: 'agent', name: 'VEGA', createdAt: 8000 } }), { compareRevision: true });
      const imp = host.saveStore.save('agent', stationDoc({ _saveRevision: host.saveStore.load('agent')._saveRevision, updatedAt: 9000, _saveClient: 'import-page' }), { compareRevision: true });
      A.ok(imp.ok === true, '5: the restored backup (founded before the reset) is the station');
      // a second window of THAT station falls behind; its work is preserved
      const behind = stationDoc({ _saveRevision: 1, updatedAt: 9500, workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'new-work', title: 'After the import', history: [turn('user', 'x')] }] });
      const r = host.saveStore.save('agent', Object.assign({}, behind, { _saveClient: 'window-b' }), { compareRevision: true });
      A.ok(r.conflict === true && !r.reset && !r.predatesReset, '5: an ordinary conflict, not erased work (' + JSON.stringify(r) + ')');
      const listed = await host.conflicts();
      const row = listed.conflicts.find(c => c.file === r.recovery);
      A.ok(row && row.restorable === 1 && !row.predatesReset, '5: offered back (' + JSON.stringify(listed) + ')');
      const done = await host.restore(r.recovery);
      A.ok(done.ok === true && done.added === 1, '5: and restored (' + JSON.stringify(done) + ')');
      // the banner of such a window offers Restore
      const stale = stationDoc({ updatedAt: Date.now(), workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'more', title: 'M', history: [turn('user', 'm')] }] });
      const cacheC = new Map(); const C = page(host, cacheC); await C.reconcile(null);
      C.push(Object.assign({}, stale, { _saveRevision: 1 }));
      host.saveStore.save('agent', Object.assign({}, host.saveStore.load('agent'), { updatedAt: Date.now() + 1 }), { compareRevision: true });   // another window moves the station on
      A.eq(await C.flush({ force: true }), false, '5: window C is refused as a conflict');
      A.ok(stationUi(C).light().banner.some(t => /restore this window/i.test(t)), '5: its banner offers Restore');
    }
    {
      // erased work: a fresh station from after the reset, and a stale tab of the station from before it
      const root = workspace();
      receipt(root, 7000);
      const host = sidecar(root);
      host.saveStore.save('agent', stationDoc({ agent: { id: 'agent', name: 'VEGA', createdAt: 8000 } }), { compareRevision: true });
      const cache = new Map(); const S = page(host, cache);
      await S.reconcile(stationDoc({ _saveRevision: 3, _saveDirty: true, updatedAt: 9000, workstreams: [{ id: 'general', title: null, history: [turn('user', 'old world')] }, { id: 'old', history: [turn('user', 'o')] }] }));
      A.eq(await S.flush({ force: true }), false, '5: the pre-reset tab is refused');
      const c = S.health().conflict;
      A.ok(c && c.conflict === true && !c.reset && c.predatesReset === true, '5: and told its copy is erased work (' + JSON.stringify(c) + ')');
      const light = stationUi(S).light();
      A.ok(light.banner && !light.banner.some(t => /restore this window/i.test(t)), '5: its banner never shows a Restore key the station would refuse (' + JSON.stringify(light.banner) + ')');
      A.ok(/before this computer.s station was reset/i.test(light.title) && !/another window/i.test(light.title), '5: and says why (' + light.title + ')');
      const refused = await host.restore(c.recovery);
      A.ok(refused.ok === false && refused.predatesReset === true, '5: the station refuses that restore');
      A.eq((await host.conflicts()).conflicts.map(x => x.restorable), [0], '5: and never offers it at boot');
    }

    // ================= 6. a window's own late-acknowledged re-seed is never blamed on another window =================
    {
      const root = workspace();
      let store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });
      const seed = store.save('agent', stationDoc({ _saveRevision: 23, updatedAt: 9000, _saveClient: 'window-a' }), { compareRevision: true });
      A.ok(seed.ok === true && seed.seeded === true, '6: window A\'s copy re-seeds the empty file (its ACK is lost)');
      store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });   // sidecar restart
      // the station file's own wrapper names the window and revision of that seed (0.14.1): after the restart the store still
      // proves the head is window A's own write, so its newer save LANDS — never a conflict that freezes the station
      const own = store.save('agent', stationDoc({ _saveRevision: 23, updatedAt: 9050, _saveClient: 'window-a',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi'), turn('assistant', 'own')] }] }), { compareRevision: true });
      A.ok(own.ok === true && own.revision === seed.revision + 1, '6: after the restart window A\'s newer save lands on its own seed (' + JSON.stringify(own) + ')');
      // a station file written before 0.14.1 names no writer in its wrapper: there, after a restart, the store cannot vouch
      const main = path.join(root, 'agent.save.json'), legacy = JSON.parse(fs.readFileSync(main, 'utf8'));
      delete legacy.revision; delete legacy.client; fs.writeFileSync(main, JSON.stringify(legacy));
      store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });   // sidecar restart
      const next = store.save('agent', stationDoc({ _saveRevision: 23, updatedAt: 9100, _saveClient: 'window-a',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi'), turn('assistant', 'more')] }] }), { compareRevision: true });
      A.ok(next.ok === false && next.conflict === true && next.ownSeed === true && !next.reseeded, '6: its next save after the restart is preserved as its OWN seed, not another window\'s (' + JSON.stringify(next) + ')');
      const other = store.save('agent', stationDoc({ _saveRevision: 5, updatedAt: 9200, _saveClient: 'window-b' }), { compareRevision: true });
      A.ok(other.conflict === true && other.reseeded === true && !other.ownSeed, '6: a different window is still told another copy was saved back first');
      // the banner wording, through the real page + save light (a station that refuses the merge: the conflict stands)
      const host = sidecar(root, { noMerge: true });
      // window A's page, stamping what that window holds: its id and the pre-seed revision 23 it never heard past
      const host2 = { fetch: (url, opts) => host.fetch(url, opts && opts.body ? Object.assign({}, opts, { body: opts.body.replace(/"_saveClient":"[^"]*"/, '"_saveClient":"window-a"').replace(/"_saveRevision":\d+/, '"_saveRevision":23') }) : opts) };
      const pa = page(host2, new Map());
      pa.push(stationDoc({ updatedAt: 9300 }));
      A.eq(await pa.flush({ force: true }), false, '6: window A (page) is refused');
      const light = stationUi(pa).light();
      A.ok(/this window.s copy was saved back/i.test(light.title) && !/another window/i.test(light.title), '6: its banner says its own copy was saved back, never another window (' + light.title + ')');
    }

    // ================= 7. restore backups keep the newest three =================
    {
      const root = workspace();
      const host = sidecar(root);
      host.saveStore.save('agent', stationDoc(), { compareRevision: true });
      for (let k = 0; k < 6; k++) fs.writeFileSync(path.join(root, 'agent.save-before-restore-' + (1000 + k) + '.json'), '{}');
      fs.writeFileSync(path.join(root, 'other.save-before-restore-1.json'), '{}');
      const pre = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'window-e',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'e', history: [turn('user', 'e')] }] }), { compareRevision: true });
      const r = await host.restore(pre.recovery);
      A.ok(r.ok === true && /^agent\.save-before-restore-\d+\.json$/.test(r.backup), '7: the restore copies the station aside first');
      const kept = fs.readdirSync(root).filter(n => /^agent\.save-before-restore-/.test(n)).sort();
      A.eq(kept.length, 3, '7: only three restore backups are kept (' + kept + ')');
      A.ok(kept.includes(r.backup) && kept.includes('agent.save-before-restore-1005.json') && kept.includes('agent.save-before-restore-1004.json'), '7: the one just written and the newest older ones');
      A.ok(fs.existsSync(path.join(root, 'other.save-before-restore-1.json')), '7: another agent\'s backups are never touched');
    }
  } finally {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  }
  A.report('save-restore-safety');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
