'use strict';
// Real sealed phone -> remote host -> provider loop. Only the provider transport is controlled.
const A = require('./_assert.js');
const { TurnHttpFixture } = require('./helpers/turn-http-fixture.js');
const UserText = require('../frontend/app/usertext.js');
const words = m => UserText.flatten(m && m.content, UserText.OPENAI);
(async () => {
  const fx = new TurnHttpFixture('window-phone', () => 0.3);
  try {
    await fx.start();
    await fx.seedRows([
      { streamId: 's', agentId: 'agent', role: 'user', content: 'PHONE_CANONICAL_OWNER', turnId: 'phone_window_seed_001', directive: true, kind: 'turn', ts: 1000 },
      { streamId: 's', agentId: 'agent', role: 'assistant', content: 'PHONE_CANONICAL_ANSWER', turnId: 'phone_window_seed_001', kind: 'turn', ts: 1001 }
    ]);
    const previous = (await fx.json('GET', '/api/save?agent=agent')).save;
    const saved = await fx.json('POST', '/api/save', { schema: 'starnet.save', version: 6, _saveRevision: previous._saveRevision,
      updatedAt: Math.max(Date.now(), previous.updatedAt + 1), agent: { id: 'agent', createdAt: 1, name: 'TURN' },
      workstreams: [{ id: 's', agentId: 'agent', title: 'Window phone', history: [
        { role: 'assistant', content: 'PHONE_DESK_WARNING_ONLY', error: true, ts: 1002 }
      ] }] });
    A.eq(saved.ok, true, 'the fixture writes on the current save revision');
    const persisted = (await fx.json('GET', '/api/save?agent=agent')).save;
    A.ok(persisted.workstreams[0].history.some(r => r.content === 'PHONE_DESK_WARNING_ONLY'), 'saved local annotation is actually durable before the phone sends');
    A.ok((await fx.phoneCall('thread', { streamId: 's', limit: 100 })).some(r => r.content === 'PHONE_DESK_WARNING_ONLY'), 'phone display merge actually includes the local annotation');
    const run = async text => {
      const before = fx.requests.length, sent = await fx.phoneSend(text), requests = fx.requests.slice(before);
      const own = requests.filter(request => request.messages.some(m => m.role === 'user' && words(m).includes(text)));
      A.ok(own.length > 0, 'phone ' + text + ' reaches the actual provider with its current input');
      return { sent, requests: own, contains: text => own.some(request => request.messages.some(m => words(m).includes(text))) };
    };
    const shadow = await run('PHONE_SHADOW_INPUT');
    A.ok(shadow.contains('PHONE_CANONICAL_ANSWER') && shadow.contains('PHONE_DESK_WARNING_ONLY'), 'shadow uses the existing merged phone history, including its local annotation');
    let status = await fx.json('GET', '/api/turn-identity');
    let entry = status.ring.find(r => r.surface === 'window' && r.runId === shadow.sent.runId);
    A.eq([entry?.caller, entry?.mode], ['phone', 'shadow'], 'phone comparison belongs to window.shadow.phone');
    A.eq(status.ring.some(r => r.surface === 'window' && r.runId === shadow.sent.runId && r.caller === 'desk'), false, 'runOnce does not misclassify a phone run as an eligible desk window');
    await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: 'id' });
    const id = await run('PHONE_ID_INPUT');
    A.ok(id.contains('PHONE_CANONICAL_ANSWER') && !id.contains('PHONE_DESK_WARNING_ONLY'), 'ID uses model-replay prose and excludes the desk warning at the provider boundary');
    status = await fx.json('GET', '/api/turn-identity');
    entry = status.ring.find(r => r.surface === 'window' && r.runId === id.sent.runId);
    A.eq([entry?.caller, entry?.mode], ['phone', 'id'], 'ID comparison retains phone caller attribution');
    A.eq(status.modes.replay, 'id', 'window switch leaves the independent replay mode unchanged');
    const groups = Object.values(status.soak.agg).flatMap(app => Object.entries(app));
    A.eq(groups.filter(([key]) => key === 'window.shadow.phone').reduce((n, [, row]) => n + row.compared, 0), 1, 'exactly one shadow phone comparison is durable');
    A.eq(groups.filter(([key]) => key.endsWith('.desk')).reduce((n, [, row]) => n + row.compared, 0), 0, 'phone sends cannot inflate the desk soak denominator');
    await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: 'legacy' });
    const legacy = await run('PHONE_LEGACY_INPUT');
    A.ok(legacy.contains('PHONE_DESK_WARNING_ONLY'), 'legacy explicitly retains the existing phone window');
    status = await fx.json('GET', '/api/turn-identity');
    A.eq(status.ring.some(r => r.surface === 'window' && r.runId === legacy.sent.runId), false, 'legacy phone does not claim a comparison');
    A.ok(!JSON.stringify(status.soak).includes('PHONE_'), 'durable evidence contains no phone content');
  } finally { await fx.dispose(); }
  A.report('turn-window.phone.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
