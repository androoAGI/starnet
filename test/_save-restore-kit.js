/* test/_save-restore-kit.js — the shared harness for the preserved-save RESTORE tests: the REAL page (frontend/app/cloudsave.js
   in a vm) -> the REAL /api/save + /api/save/conflicts handlers sliced out of sidecar/index.js -> the REAL savestore on a temp
   workspace, and the REAL boot offer + conflict banner sliced out of stationui.js. Never boots a sidecar (index.js is only
   read as text) and never touches a real station: every workspace is a fresh temp dir, removed by cleanup(). */
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
  .map(h => { const b = fnBody(indexSrc, h); A.ok(b.startsWith(h) && b.length < 6000, 'kit: sliced exactly ' + h); return b; });
const cloudsaveSrc = read('frontend/app/cloudsave.js');
const ui = read('frontend/app/stationui.js');
const dotStart = ui.indexOf('  let degradedNotified = false;');
const dotEnd = ui.indexOf('  // relative-time formatter', dotStart);
A.ok(dotStart > 0 && dotEnd > dotStart, 'kit: the shipped save-light renderer + boot offer are found in stationui.js');

const roots = [];
function workspace() { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'save-restore-kit-')); roots.push(r); return r; }
function cleanup() { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); }
const conflictFiles = root => fs.readdirSync(root).filter(n => /^agent\.save-conflict-.*\.json$/.test(n));
const turn = (role, content) => ({ role, content });
const stationDoc = over => Object.assign({
  schema: 'starnet.save', version: 6, updatedAt: 1000, _saveRevision: 0, _saveDirty: false,
  agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, agents: [], generalId: 'general', activeId: 'general', deletedIds: [],
  workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }]
}, over || {});
const receipt = (root, at) => fs.writeFileSync(path.join(root, '.fresh-start.json'), JSON.stringify({ version: 1, at: new Date(at).toISOString(), acknowledgedRoots: [], quarantine: null, moved: [] }));
// a clock for the handlers that moves `step` ms on every read, so the boot offer's time budget runs out after exactly one
// snapshot per request whatever this machine's speed (a slow, multi-MiB station, deterministically)
const steppingDate = step => { let k = 0; return { now: () => Date.now() + (k += step) }; };
// counts reads of the station file and of preserved snapshots through an fs facade
function countingFs(reads) {
  return new Proxy(fs, { get(t, k) {
    if (k === 'readFileSync') return function (f) { const n = path.basename(String(f)); if (n === 'agent.save.json') reads.station++; else if (/^agent\.save-conflict-/.test(n)) reads.snapshot++; return t.readFileSync.apply(t, arguments); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
}

// the sidecar side (one process): the real handlers over a real savestore. o.tombstones: the deleted-session ledger;
// o.fs: an fs facade; o.Date: the handlers' clock; o.clock: the store's clock ({ now }); o.realBody: requests arrive as a
// byte stream read by the REAL bounded reader (sidecar/http-body.js: its 16 MiB cap, its tooLarge error); o.noMerge: the station
// REFUSES every merge (POST /api/save/adopt answers ok:false) — a case about a conflict that STANDS (the banner, the restore,
// the boot offer): since save-latch-kill a refused save is merged in-session, so only a refused merge leaves one standing
function sidecar(root, o) {
  o = o || {};
  const store = makeSaveStore({ fs: o.fs || fs, pathMod: path, root, clock: o.clock || { now: () => Date.now() } });
  let latestRatingAt = 0;
  const realRead = o.realBody ? require('../sidecar/http-body.js').readBody : null;
  const sandbox = { saveStore: store, workspaceDegraded: false, growthRatings: { latestTs: () => latestRatingAt }, readBody: realRead ? ((req, max) => realRead(req, max)) : (async req => req.body), failNote: () => {},
    observeDeletedSessions: () => [], Date: o.Date || Date, Buffer, SaveWire: require('../sidecar/save-wire.js'),
    require: m => { if (m === './save-restore.js') return require('../sidecar/save-restore.js'); throw new Error('unexpected require ' + m); },
    publicWorkspaceLineage: () => ({ version: 1 }), URL };
  if (o.tombstones) sandbox.sessionTombstones = o.tombstones;
  const api = vm.runInNewContext("let _remoteLooksMemo = { stamp: '', looks: null };\nlet _stationEpochMemo = { stamp: '', epoch: 1 };\n" + handlers.join('\n') +
    '\n({ serveSaveLoad, handleSaveWrite, serveSaveConflicts, handleSaveConflictRestore, handleSaveAdopt })', sandbox);
  async function call(fn, req) {
    if (realRead && req && typeof req.body === 'string') req = Object.assign(require('node:stream').Readable.from([Buffer.from(req.body, 'utf8')]), { body: req.body });
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
  const c = vm.createContext({ CloudSave: cloudSave, CloudSaveCore: require('../frontend/app/cloudsavecore.js'), document, $: sel => (sel === '#save-dot' ? dot : null), notify: () => {}, Blob: function () {}, URL, store, save: () => true, setTimeout });
  const fns = vm.runInContext('(function () {' + ui.slice(dotStart, dotEnd) + '\nreturn { refreshSaveDurability, offerPreservedSaves }; })()', c);
  return {
    store, nodes,
    light() { fns.refreshSaveDurability(dot); const b = nodes.get('save-conflict-notice'); return { title: dot.title, banner: b ? b.children.map(n => n.textContent) : null }; },
    async offer() { await fns.offerPreservedSaves(); return nodes.get('save-preserved-notice') || null; }
  };
}

module.exports = { repo, workspace, cleanup, conflictFiles, turn, stationDoc, receipt, steppingDate, countingFs, sidecar, page, stationUi, makeSaveStore };
