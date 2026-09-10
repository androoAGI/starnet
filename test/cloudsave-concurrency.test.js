'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { makeSaveStore } = require('../sidecar/savestore.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudsave-cas-'));
const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/cloudsave.js'), 'utf8');
const base = { schema: 'starnet.save', version: 6, updatedAt: 1, agent: { id: 'agent' }, workstreams: [] };
store.save('agent', base, { compareRevision: true });
function client() {
  const cache = new Map();
  const context = { console, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout, clearTimeout, AbortController,
    localStorage: { getItem: k => cache.get(k) || null, setItem: (k,v) => cache.set(k,v), removeItem: k => cache.delete(k) },
    Save: { CURRENT: 6, load: () => JSON.parse(cache.get('starnet.save') || 'null') },
    fetch: async (url, opts) => ({ ok: true, json: async () => opts?.method === 'POST' ? store.save('agent', JSON.parse(opts.body), { compareRevision: true }) : { save: structuredClone(store.load('agent')) } }) };
  vm.runInNewContext(source, context); return context.module.exports;
}
(async () => {
  try {
    const a = client(), b = client();
    const da = await a.reconcile(null), db = await b.reconcile(null);
    da.updatedAt = 2; da._saveDirty = true; da.workstreams.push({ id: 'A' });
    a.push(da); assert.equal(await a.flush({ force: true }), true);
    db.updatedAt = 9000; db._saveDirty = true; db.workstreams.push({ id: 'B' });
    b.push(db); assert.equal(await b.flush({ force: true }), false);
    assert.equal(b.health().conflict.conflict, true);
    assert.equal(store.load('agent').workstreams[0].id, 'A');
    assert.equal(b.localSnapshot().workstreams[0].id, 'B', 'export belongs to this window, not shared localStorage');
    assert.equal((await b.flushForUpdate()).ok, false, 'update cannot hide an unresolved conflict');
    const restarted = client(); await restarted.reconcile(db);
    assert.equal(restarted.health().conflict.conflict, true, 'offline restart preserves stale edits instead of relabeling them');
    assert.equal(store.load('agent').workstreams[0].id, 'A');
    da.updatedAt = 3; da.workstreams.push({ id: 'A2' }); a.push(da);
    const first = a.flush({ force: true });
    da.updatedAt = 4; da.workstreams.push({ id: 'A3' }); a.push(da);
    const second = a.flush({ force: true });
    await first; assert.equal(await second, true, 'queued own writes use the acknowledged revision');
    assert.equal(store.load('agent').workstreams.length, 3);
    console.log('cloudsave-concurrency: two clients, conflict export, update refusal, offline restart and queued writes PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
