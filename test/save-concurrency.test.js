'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeSaveStore } = require('../sidecar/savestore.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-cas-'));
const deps = { fs, pathMod: path, root, clock: { now: () => 1000 } };
try {
  let store = makeSaveStore(deps);
  const save = doc => store.save('agent', doc, { compareRevision: true });
  const baseline = { agent: { id: 'agent' }, updatedAt: 1, workstreams: [] };
  assert.equal(save(baseline).revision, 1);
  const a = structuredClone(store.load('agent')), b = structuredClone(a);
  a.updatedAt = 2; a.workstreams.push({ id: 'a', history: ['A'] });
  assert.equal(save(a).revision, 2);
  assert.equal(save(a).revision, 2, 'lost response retry is idempotent');
  b.updatedAt = 9000; b.workstreams.push({ id: 'b', history: ['B'] });
  const conflict = save(b);
  assert.equal(conflict.conflict, true, 'a fresh timestamp cannot disguise a stale read');
  assert.deepEqual(store.load('agent').workstreams, a.workstreams, 'current station remains unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, conflict.recovery))).workstreams, b.workstreams, 'conflicting work is durably recoverable');
  assert.equal(save({ ...baseline, updatedAt: 9999 }).conflict, true, 'unversioned old clients cannot bypass CAS');
  store = makeSaveStore(deps);
  assert.equal(store.load('agent')._saveRevision, 2, 'revision survives restart');
  const current = store.load('agent'); current.updatedAt = -10; current.workstreams.push({ id: 'c' });
  assert.equal(save(current).revision, 3, 'reload permits a new edit');
  assert.equal(save(current).revision, 3, 'a replay remains idempotent after server clock correction');
  console.log('save-concurrency: stale edits, durable recovery, replay, old clients and restart PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
