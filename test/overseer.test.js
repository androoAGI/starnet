'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOverseer } = require('../sidecar/overseer.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-overseer-'));
  let serial = 0;
  const saved = { generalId: 'home', workstreams: [{ id: 'home', title: null, agentId: 'agent' }], deletedIds: [] };
  const deps = { fs, path, file: path.join(root, 'overseer.json'), now: () => ++serial,
    newId: () => 'thread_' + ++serial, sessions: () => saved, hasAgent: id => ['agent', 'researcher'].includes(id) };
  try {
    let manager = makeOverseer(deps);
    saved.workstreams[0].projectRoot = path.join(root, 'project-alpha');
    const child = manager.create({ title: 'Research', agentId: 'researcher', parentStreamId: 'home', requestId: 'create_1', projectRoot: 'untrusted-model-root' });
    assert.equal(child.parentStreamId, 'home');
    assert.equal(child.projectRoot, saved.workstreams[0].projectRoot, 'scope comes from the parent, never tool arguments');
    assert.equal(manager.create({ title: 'Research', parentStreamId: 'home', requestId: 'create_1' }).id, child.id);
    assert.throws(() => manager.create({ title: 'Research', parentStreamId: 'home' }), /already exists/);
    assert.throws(() => manager.create({ title: 'Other', parentStreamId: 'missing' }), /no such/);
    manager = makeOverseer(deps);
    assert.equal(manager.resolve(child.id).title, 'Research');
    saved.workstreams.push({ ...child, title: 'Renamed research' });
    assert.equal(manager.resolve(child.id).title, 'Renamed research');

    const workers = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'workers.json'),
      clock: { now: () => ++serial }, newId: () => 'worker_' + ++serial });
    workers.start({ leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', streamId: child.id },
      async () => ({ status: 'done', reason: 'done', result: 'Findings' }));
    await new Promise(resolve => setImmediate(resolve));
    manager.collect(workers.list()); manager.collect(workers.list());
    assert.equal(manager.snapshot().reviews.length, 1, 'completion replay must not duplicate review');
    const review = manager.snapshot().reviews[0];
    assert.equal(review.childStreamId, child.id);
    manager.patchReview(review.id, { status: 'reviewing', reviewRunId: 'review_1' });
    manager = makeOverseer(deps);
    assert.equal(manager.snapshot().reviews[0].reviewRunId, 'review_1', 'restart preserves exact review attempt');

    let release;
    const order = [];
    const first = manager.withThread('home', async () => { order.push('first'); await new Promise(r => { release = r; }); throw new Error('failed'); });
    await new Promise(resolve => setImmediate(resolve));
    const second = manager.withThread('home', async () => { order.push('second'); });
    await manager.withThread('other', async () => { order.push('other'); });
    assert.deepEqual(order, ['first', 'other']);
    const caught = assert.rejects(first, /failed/); release(); await caught; await second;
    assert.deepEqual(order, ['first', 'other', 'second']);
    manager.stopReviews();
    manager = makeOverseer(deps);
    assert.equal(manager.snapshot().paused, true, 'stop survives restart');
    assert.equal(manager.snapshot().reviews[0].status, 'cancelled');
    manager.resumeReviews();
    assert.equal(manager.snapshot().paused, false);
    assert.equal(manager.snapshot().reviews[0].status, 'cancelled', 'resuming does not replay cancelled work');
    const failedDisk = new Proxy(fs, { get(target, key) {
      if (key === 'writeSync') return () => { throw new Error('simulated full disk'); };
      return target[key];
    } });
    const failedStop = makeOverseer({ ...deps, fs: failedDisk });
    assert.throws(() => failedStop.stopReviews(), /simulated full disk/);
    assert.equal(failedStop.snapshot().paused, true, 'a failed durable stop still blocks admission in memory');
    assert.throws(() => failedStop.resumeReviews(), /simulated full disk/);
    assert.equal(failedStop.snapshot().paused, true, 'a failed resume does not silently release the emergency stop');
    saved.deletedIds.push(child.id); saved.workstreams = saved.workstreams.filter(w => w.id !== child.id);
    assert.throws(() => manager.resolve(child.id), /no such/, 'deleted threads stay deleted');
    console.log('overseer: durable identity, deduplication, restart, rename, tombstones and turn serialization PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
