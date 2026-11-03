'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js'), Dual = require('../sidecar/turn-dual.js');
let Host = require('../sidecar/remote/host.js');
if (process.env.TURN_RETRACT_PHONE_CONTROL) {
  const filename = require.resolve('../sidecar/remote/host.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(process.env.TURN_RETRACT_PHONE_CONTROL, 'utf8'), filename); Host = loaded.exports;
}
(async () => {
  for (const mode of ['legacy-cache', 'canonical']) {
    const store = Store.makeTranscriptStore({ io: History.makeMemoryTranscriptIo() });
    let bad = true, calls = 0, sequence = 0, entered, release;
    const invoked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const events = [];
    const host = Host.makeRemoteHost({ now: () => 10, newId: () => 'phone-admission-' + (++sequence), broadcast: event => events.push(event),
      roster: () => [{ agentId: 'agent' }], liveRuns: () => [], credentials: () => ({ ok: true, model: 'fixture', provider: 'custom' }),
      transcript: Object.assign({}, store, { view: (...args) => { if (bad && mode === 'canonical') throw new Error('canonical history unvouched'); return store.view(...args); } }),
      turnDual: mode === 'legacy-cache' ? Dual.make({ now: () => 10, hash: value => value, env: key => key === 'STARNET_TURNID_REPLAY' ? 'legacy' : undefined }) : undefined,
      deskSessions: () => [{ id: 's', history: bad ? [{ rowId: 999999, streamId: 's', role: 'user', content: 'UNPROVEN_CACHE' }] : [] }],
      runOnce: async o => { calls++; entered(); await gate; o.emit('agent.run.end', { runId: o.runId, reason: 'done', outcome: 'succeeded' }); }
    });
    let error;
    try { await host.send({ agentId: 'agent', streamId: 's', text: 'NEW_TYPED_INPUT', deviceId: 'device' }); } catch (caught) { error = caught; }
    A.ok(!!error, mode + ': real host refuses unproven history');
    A.eq(calls, 0, mode + ': refused history invokes no runOnce');
    A.eq(host.liveRemoteRuns(), [], mode + ': refusal publishes no phantom remote run');
    A.eq(events, [], mode + ': refusal emits no accepted lifecycle');
    bad = false;
    const accepted = await host.send({ agentId: 'agent', streamId: 's', text: 'NOW_PROVEN', deviceId: 'device' });
    await invoked;
    A.eq(host.liveRemoteRuns().map(row => row.runId), [accepted.runId], mode + ': subsequent proven history has exactly its one accepted live run');
    release(); await new Promise(resolve => setImmediate(resolve));
    A.eq(host.liveRemoteRuns(), [], mode + ': normal completion still releases accepted remote ownership');
    A.eq(events.filter(event => event.type === 'run.ended').map(event => event.outcome), ['succeeded'], mode + ': original typed outcome still reaches the terminal');
  }
  A.report('turn-retract.phone-refusal');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
