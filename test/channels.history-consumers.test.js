/* Actual hub and central LineRunner over the canonical Store/port. The saved-source control retains
   the old production historyFor/observeInto hooks, so it proves the consumer migration, not a missing mock. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const Source = require('./helpers/source.js');
const Port = require('../sidecar/channels/history-port.js'), View = require('../sidecar/turn-view.js');
const Kinds = require('../frontend/app/turnkinds.js'), Outcome = require('../frontend/app/runoutcome.js');
const Delivery = require('../sidecar/turn-delivery.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeRunTranscript } = require('../sidecar/transcript-run.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function owner(relative, sourceFile, overrides) {
  const filename = path.resolve(__dirname, '..', relative);
  if (!sourceFile && !overrides) return require(filename);
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = m.require.bind(m);
  m.require = name => overrides && Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name);
  m._compile(fs.readFileSync(sourceFile || filename, 'utf8'), filename); return m.exports;
}
const Runner = owner('sidecar/routing/line-runner.js', process.env.CHANNEL_HISTORY_RUNNER_SOURCE);
const Hub = owner('sidecar/channels/hub.js', process.env.CHANNEL_HISTORY_HUB_SOURCE, { '../routing/line-runner.js': Runner });
const source = Source.readSidecarSource();
// The real host construction is evaluated over its real storage owners, with only clock/secret/run-store edges supplied.
const portSource = Source.callRegion(source, 'const channelHistory = ChannelHistory.make(', '\n});');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-consumers-'));
  const channelStore = makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 100 }, timers: { setTimeout() {}, clearTimeout() {} } });
  const io = makeMemoryTranscriptIo(), store = makeTranscriptStore({ io, clock: { now: () => 100 }, hash });
  const calls = [], sends = [], events = [], notes = [], outcomes = new Map(), hubs = [];
  let readFault = false, serial = 0;
  const view = (...args) => { if (readFault) throw Error('injected strict history read failure'); return store.view(...args); };
  const scope = { ChannelHistory: Port, transcriptStore: Object.assign({}, store, { view }), channelStore, crypto,
    sessionTombstones: { deletedAt: () => 0 }, redact: value => value,
    failNote: (tag, error) => notes.push([tag, error.message]), runStore: { latest: id => outcomes.get(id) || null },
    RunOutcome: Outcome, TurnDelivery: Delivery };
  const history = new Function(...Object.keys(scope), portSource + '\nreturn channelHistory;')(...Object.values(scope));
  const append = row => store.appendStrict(Object.assign({ streamId: 'channel_telegram_42', agentId: 'writer', kind: 'turn', role: 'user', content: 'seed', taint: null }, row));
  const runOnce = async o => {
    calls.push(o);
    const kinds = Kinds.ofRun(o), turnId = o.turnId || Kinds.runTurnId(o.runId);
    const writer = makeRunTranscript({ store, streamId: o.streamId, agentId: o.agentId, runId: o.runId, turnId,
      stamp: true, rowKind: kinds.rowKind, directiveKind: kinds.directiveKind, line: kinds.line, taint: () => null });
    writer.setDirective({ text: o.messages.at(-1).content, typed: o.typedDirective, kind: kinds.directiveKind });
    writer.drain([{ role: 'assistant', content: o.agentId + ' terminal' }]);
    const done = { reason: 'done', outcome: 'succeeded', failureCode: '', text: o.agentId + ' terminal', usd: 0, turns: 1 };
    outcomes.set(o.runId, Object.assign({ runId: o.runId }, done));
    o.emit('agent.run.start', { runId: o.runId, agentId: o.agentId });
    o.emit('agent.token', { runId: o.runId, agentId: o.agentId, delta: done.text });
    o.emit('agent.run.end', Object.assign({ runId: o.runId, agentId: o.agentId }, done));
    return done;
  };
  function hub(extra) {
    const h = Hub.makeChannelHub(Object.assign({ channel: 'telegram', store: channelStore, history, textBatchWaitMs: 0,
      // Exact old production compatibility hooks, unused by the migrated hub.
      historyFor: sid => { if (readFault) throw Error('injected canonical read failure'); return store.reconstruct(sid, { limit: 100 }); },
      observeInto: (sid, agentId, text, taint) => store.append({ streamId: sid, agentId, role: 'user', content: text, taint }),
      runOnce, send: async (_chat, text) => { sends.push(text); return { ok: true }; },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'writer' }), classify: () => false, isOwner: () => true,
      newId: () => 'consumer_' + (++serial), now: () => 100,
      emit: (name, data) => events.push([name, data]) }, extra));
    hubs.push(h); return h;
  }
  const seedLegacy = (key, rows) => fs.writeFileSync(path.join(root, key + '.history.json'), JSON.stringify({ version: 1, messages: rows }));
  const msg = (text, extra) => Object.assign({ channel: 'telegram', chatId: '42', chatType: 'dm', userId: 'owner', userName: 'Owner', text, messageId: 'message_' + (++serial), ts: 10 }, extra);
  return { root, io, store, channelStore, history, calls, sends, events, notes, outcomes, append, runOnce, hub, seedLegacy, msg,
    fault() { readFault = true; }, close() { for (const h of hubs) h.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function pair(f, extra) {
  const base = Object.assign({ sourceRunId: 'seed_run', turnId: 'seed_turn_123' }, extra);
  return [f.append(Object.assign({}, base, { directive: true, content: 'historic question', typed: 'historic own words' })),
    f.append(Object.assign({}, base, { role: 'assistant', content: '', toolCalls: [{ id: 'seed_call', type: 'function', function: { name: 'read', arguments: '{}' } }] })),
    f.append(Object.assign({}, base, { role: 'tool', content: 'historic tool result', toolCallId: 'seed_call' })),
    f.append(Object.assign({}, base, { role: 'assistant', content: 'historic answer' }))];
}
(async () => {
  {
    const f = fixture();
    try {
      const rows = pair(f); f.append({ kind: 'station', role: 'assistant', content: 'PRIVATE STATION SENTINEL' });
      const h = f.hub(); await h.onInbound(f.msg('current own words'));
      A.eq(f.calls.length, 1, 'entry admits one run');
      const request = f.calls[0], messages = request?.messages || [];
      A.eq(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user'], 'entry retains the complete provider-valid tool pair');
      A.eq(messages[0]?.content, 'historic own words', 'entry uses canonical pre-expansion wording');
      A.eq(messages[1]?.tool_calls?.[0]?.id, 'seed_call', 'entry preserves tool-call identity');
      A.eq(messages[2]?.tool_call_id, 'seed_call', 'entry preserves tool-result pairing');
      A.eq((messages[View.ROW_IDS] || []).slice(0, 4).map(r => r?.rowId), rows.map(r => r.rowId), 'entry carries durable row identities through concat');
      A.eq(request?.typedDirective, 'current own words', 'entry captures exactly the member words');
      A.ok(!JSON.stringify(messages).includes('PRIVATE STATION SENTINEL'), 'station-only execution is not replayed');
      A.eq(f.channelStore.loadHistory('writer'), [], 'bound entry never mirrors into a shared agent legacy file');
      A.eq(f.channelStore.loadHistory('tg_42'), [], 'bound entry never starts a parallel legacy chat history');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seedLegacy('tg_42', [{ role: 'user', content: 'PRE-MIGRATION UNIQUE', ts: 0 }]);
      const sourceBytes = fs.readFileSync(path.join(f.root, 'tg_42.history.json'), 'utf8');
      const h = f.hub(); await h.onInbound(f.msg('first canonical turn'));
      A.ok(f.calls[0]?.messages.some(m => m.content === 'PRE-MIGRATION UNIQUE'), 'actual first inbound awaits the import');
      A.eq(f.channelStore.getChatRecord('42', { readOnly: true }).legacyImport?.state, 'done', 'actual inbound leaves a durable done marker');
      A.eq(fs.readFileSync(path.join(f.root, 'tg_42.history.json'), 'utf8'), sourceBytes, 'bound inbound preserves the legacy source bytes');
      await h.onInbound(f.msg('/new'));
      const record = f.channelStore.getChatRecord('42', { readOnly: true });
      A.ok(record.streamId !== 'channel_telegram_42' && /_n/.test(record.streamId), 'actual /new rotates the conversation');
      A.eq(record.legacyImport?.state, 'abandoned', '/new abandons import authority before the next turn');
      await h.onInbound(f.msg('after new'));
      A.ok(!JSON.stringify(f.calls.at(-1)?.messages).includes('PRE-MIGRATION UNIQUE'), 'next actual entry cannot revive imported words');
      A.ok(f.store.view('recall', 'channel_telegram_42', { complete: true }).some(r => r.content === 'PRE-MIGRATION UNIQUE'), '/new preserves old station recall');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.seedLegacy('writer', [{ role: 'user', content: 'OTHER CHAT SECRET', ts: 1 }]);
      f.fault(); const settled = [], jobs = [];
      const runner = Runner.makeLineRunner({ runOnce: f.runOnce, chain: makeChainRunner({ nextAgent: () => null }), now: () => 100, newId: () => 'held_job' });
      const h = f.hub({ lineRunner: runner, lineOriginFor: () => 'L1', onJobSettled: result => jobs.push(result) });
      await h.onInbound(f.msg('do not guess'), { onSettled: result => settled.push(result) });
      A.eq(f.calls.length, 0, 'failed strict history never starts the provider');
      A.eq(settled, [{ runId: '', ok: false }], 'failed history settles intake exactly once as undelivered');
      A.ok(f.sends.some(text => /could not read this chat.s history/.test(text)), 'history failure is visible to the member');
      A.ok(!f.sends.some(text => /OTHER CHAT SECRET/.test(text)), 'hold never borrows another agent history');
      A.eq(h._internals.inflight.size, 0, 'entry hold releases its live conversation owner');
      A.eq(runner.get('held_job'), null, 'entry hold releases the opened line job');
      A.ok(!f.events.some(([name]) => /^agent\.run\./.test(name)), 'entry hold emits no invented run');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const rows = pair(f, { kind: 'hop', line: 'L1@editor_dock', agentId: 'editor' });
      f.outcomes.set('seed_run', { reason: 'done', outcome: 'succeeded' });
      pair(f, { kind: 'hop', line: 'L1@foreign_dock', agentId: 'other', sourceRunId: 'foreign_run', turnId: 'foreign_turn_123' });
      const failedRows = pair(f, { kind: 'hop', line: 'L1@editor_dock', agentId: 'editor', sourceRunId: 'failed_run', turnId: 'failed_turn_123' });
      f.outcomes.set('failed_run', { reason: 'error', outcome: 'failed' });
      const chain = makeChainRunner({ nextAgent: () => null, stepAgent: agentId => agentId === 'writer' ? { agentId: 'editor', dockId: 'editor_dock' } : null });
      const h = f.hub({ chain, lineOriginFor: () => 'L1', resolveAgent: () => ({ agentId: 'writer', dockId: 'writer_dock' }),
        resolveRunConfig: () => ({ key: 'k', model: 'm' }), classify: () => true });
      await h.onInbound(f.msg('line task'));
      const entry = f.calls.find(o => o.agentId === 'writer'), hop = f.calls.find(o => o.agentId === 'editor');
      A.ok(!!entry && !!hop, 'actual hub routes its next stage through LineRunner');
      A.ok(!JSON.stringify(entry?.messages).includes('historic answer'), 'entry never sees private hop history');
      A.eq(hop?.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'user', 'assistant', 'user'], 'hop keeps eligible prior pairs, failed directive, ordinary entry pair and current handoff');
      A.eq((hop?.messages[View.ROW_IDS] || []).slice(0, 4).map(r => r?.rowId), rows.map(r => r.rowId), 'hop preserves row identities at the actual run boundary');
      const entryRows = f.store.view('proof', 'channel_telegram_42', { sourceRunId: entry?.runId, complete: true });
      A.eq(entryRows.map(r => [r.role, r.kind, r.line || null]), [['user', 'turn', null], ['assistant', 'turn', null]], 'actual host transcript writer stamps the ordinary entry independently of lineId');
      A.eq(hop?.messages.slice(-3, -1).map(m => m.content), ['line task', 'writer terminal'], 'finished ordinary entry remains visible under the explicit replay matrix');
      const replayIds = (hop?.messages[View.ROW_IDS] || []).map(r => r?.rowId);
      A.ok(replayIds.includes(failedRows[0].rowId) && failedRows.slice(1).every(r => !replayIds.includes(r.rowId)), 'failed hop contributes its directive but no answer or tool pair');
      const foreignIds = f.store.view('proof', 'channel_telegram_42', { sourceRunId: 'foreign_run', complete: true }).map(r => r.rowId);
      A.ok(foreignIds.every(id => !replayIds.includes(id)), 'another dock cannot enter this hop through its shared stream');
      A.eq([hop?.lineHop, hop?.lineId, hop?.dockId], [true, 'L1', 'editor_dock'], 'central hop stamps the exact canonical line/dock identity');
      A.eq(f.channelStore.getChatRecord('42').hopKeys || [], [], 'canonical hop creates no parallel hop legacy file');
    } finally { f.close(); }
  }
  {
    // A later stage inherits the chat's words, never the agent-before-it's tool traffic: replayed as the stage's own turns the provider
    // would be told the stage made calls it never made. The entry agent, replaying its own chat, keeps its pairs.
    const f = fixture();
    try {
      pair(f);   // the entry agent's earlier job in this chat: a question, a tool-call turn, its result and an answer (ordinary turns of 'writer')
      const chain = makeChainRunner({ nextAgent: () => null, stepAgent: agentId => agentId === 'writer' ? { agentId: 'editor', dockId: 'editor_dock' } : null });
      const h = f.hub({ chain, lineOriginFor: () => 'L1', resolveAgent: () => ({ agentId: 'writer', dockId: 'writer_dock' }),
        resolveRunConfig: () => ({ key: 'k', model: 'm' }), classify: () => true });
      await h.onInbound(f.msg('line task'));
      const entry = f.calls.find(o => o.agentId === 'writer'), hop = f.calls.find(o => o.agentId === 'editor');
      A.ok(!!entry && !!hop, 'actual hub routes its next stage through LineRunner');
      A.eq(entry?.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user'], 'the entry agent still replays its own tool pair');
      A.eq(hop?.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user'], 'the next stage replays the chat\'s words, earlier jobs included, and no tool-call turn or result');
      A.ok(hop?.messages.every(m => !m.tool_calls && m.role !== 'tool') && !JSON.stringify(hop?.messages).includes('historic tool result') && !JSON.stringify(hop?.messages).includes('seed_call'),
        'no tool traffic of the entry agent reaches the next stage\'s request');
      A.eq(hop?.messages.map(m => m.content).slice(0, 4), ['historic own words', 'historic answer', 'line task', 'writer terminal'], 'the prose of both jobs still does, in order');
    } finally { f.close(); }
  }
  {
    let calls = 0, acquired = 0, released = 0; const crates = [];
    const runner = Runner.makeLineRunner({ runOnce: async () => { calls++; return { text: 'must not run', reason: 'done' }; },
      liveRuns: { add: () => { acquired++; return () => { released++; }; } }, newId: () => 'refused_hop', now: () => 10 });
    const profile = Runner.profiles.channel({ channel: 'telegram', chatId: '42', config: () => ({ key: 'k', model: 'm' }), persona: () => 'P',
      history: { load: () => { const pending = Promise.reject(Error('strict replay refused')); pending.catch(() => {}); return pending; } } });
    profile.liveSource = 'history-proof'; profile.crate = { place: () => 'crate1', settle: (_h, id, ok) => crates.push([id, ok]) };
    const result = await runner.hopRunner(profile)({ agentId: 'editor', dockId: 'editor_dock', lineId: 'L1', text: 'handoff' });
    A.eq(calls, 0, 'asynchronous rejected hop replay never reaches the provider');
    A.eq([acquired, released], [1, 1], 'rejected hop replay balances the real live-owner lifetime');
    A.eq(crates, [['crate1', false]], 'rejected hop settles its crate as not delivered');
    A.eq(result.error, "this line's history could not be read", 'rejected hop reports the specific history hold');
    A.eq(result.text, '', 'rejected hop hands no fabricated answer to the next stage');
  }
  A.report('channels.history-consumers');
})().catch(error => { console.error(error); process.exitCode = 1; });
