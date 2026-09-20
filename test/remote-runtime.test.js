'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { makeSaveStore } = require('../sidecar/savestore');
const { makeHeadlessStation, makeRunStream, makeRequestClaims } = require('../sidecar/remote-runtime');

test('closing a persistent viewer keeps execution alive, with bounded output and explicit stop', () => {
  const res = new EventEmitter(), ac = new AbortController(), events = [];
  res.write = () => true; res.writableLength = 0;
  const stream = makeRunStream({ res, controller: ac, persistent: true, redact: x => x, emitRemote: (...e) => events.push(e) });
  res.emit('close');
  assert.equal(ac.signal.aborted, false);
  stream.emit('agent.run.end', { runId: 'real' });
  assert.equal(events.length, 1); assert.equal(stream.attached(), false);
  ac.abort(); assert.equal(ac.signal.aborted, true);
});
test('local mode still cancels on disconnect and a slow remote viewer is detached', () => {
  for (const persistent of [false, true]) {
    const res = new EventEmitter(), ac = new AbortController();
    res.write = () => false; res.writableLength = 2 * 1024 * 1024; res.destroy = () => { res.destroyed = true; res.emit('close'); };
    makeRunStream({ res, controller: ac, persistent, redact: x => x, emitRemote() {} }).emit('agent.token', {});
    assert.equal(ac.signal.aborted, !persistent); assert.equal(res.destroyed, true);
  }
});
test('request claims survive restart and fence duplicates and corrupt prior claims', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-claims-'));
  try {
    const id = 'request-1234567890';
    assert.equal(makeRequestClaims(dir, () => 1000).claim(id, 'run-1').ok, true);
    assert.deepEqual(makeRequestClaims(dir, () => 1000).claim(id, 'run-2'), { ok: false, runId: 'run-1' });
    fs.writeFileSync(path.join(dir, '.remote-requests', id + '.json'), '');
    assert.deepEqual(makeRequestClaims(dir, () => 1000).claim(id, 'run-3'), { ok: false, runId: null });
    assert.throws(() => makeRequestClaims(dir, () => 1000).claim('../escape', 'bad'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('headless session creation, delegation delivery and read-back use the real revision-checked store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-station-'));
  try {
    const saveStore = makeSaveStore({ fs, pathMod: path, root: dir, clock: { now: Date.now } });
    const roster = () => new Map([['agent', { agentId: 'agent', name: 'LEAD' }], ['worker', { agentId: 'worker', name: 'WORKER' }]]);
    const station = makeHeadlessStation({ now: () => 1000, saveStore, roster, runs: () => [], activeRuns: () => new Map() });
    assert.equal((await station.request('station.sessions')).ok, false);
    saveStore.save('agent', { agent: { id: 'agent' }, version: 5, updatedAt: 1, workstreams: [], _saveRevision: 0 }, { compareRevision: true });
    const created = await Promise.all(['Research', 'Build'].map(title => station.request('station.new_session', { title, agentId: 'worker' })));
    assert.ok(created.every(x => x.ok), JSON.stringify(created));
    const id = created[0].result.id;
    const delivery = { streamId: id, agentId: 'worker', runId: 'completed-run', text: 'real result', prompt: 'research this' };
    assert.equal((await station.request('station.deliver', delivery)).result.folded, true);
    assert.equal((await station.request('station.deliver', delivery)).result.folded, false);
    const read = await station.request('station.read_session', { session: 'Research' });
    assert.equal(read.result.turns.at(-1).text, 'real result');
    assert.equal((await station.request('station.new_session', { title: 'Research' })).ok, false);
    assert.equal((await station.request('station.switch_session', { session: 'Build' })).ok, false);
    assert.equal(saveStore.load('agent')._saveRevision, 4);
    const restarted = makeHeadlessStation({ now: () => 1000, saveStore, roster, runs: () => [], activeRuns: () => new Map() });
    assert.equal((await restarted.request('station.sessions')).result.count, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
