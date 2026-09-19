'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeWebhookVerifier } = require('../sidecar/channels/webhook-auth.js');

(async () => {
  const records = { chat: { agentId: 'agent', channel: 'telegram', streamId: 'desktop_stream_1' } };
  const legacy = [{ role: 'user', content: 'legacy-only' }], appended = [], sends = [], runs = [];
  const store = {
    loadHistory: () => legacy.slice(), appendTurn: (_a, role, content) => appended.push({ role, content }),
    getChatRecord: id => records[id], saveChatRecord: (id, patch) => (records[id] = Object.assign({}, records[id], patch)),
    loadOutbox: () => [], pushOutbox: () => ({}), removeOutbox: () => true
  };
  const canonical = [{ role: 'user', content: 'from desktop' }, { role: 'assistant', content: 'desktop answer' }];
  const hub = makeChannelHub({
    channel: 'telegram', store, historyFor: id => id === 'desktop_stream_1' ? canonical.slice() : [],
    runOnce: async o => { runs.push(o); o.emit('agent.token', { delta: 'channel answer' }); o.emit('agent.run.end', { reason: 'done' }); },
    send: (_id, text) => { sends.push(text); return Promise.resolve({ ok: true }); },
    secrets: () => ({ configured: true, key: 'k', model: 'm', provider: 'openrouter', agentId: 'agent' }),
    classify: () => false, newId: () => 'run-one', now: () => 1
  });
  await hub.onInbound({ chatId: 'chat', userId: 'owner', chatType: 'dm', text: 'continue here' });
  A.eq(runs.length, 1, 'one inbound message starts one run');
  A.eq(runs[0].streamId, 'desktop_stream_1', 'channel run binds to the desktop workstream identity');
  A.eq(runs[0].messages.map(x => x.content), ['from desktop', 'desktop answer', 'continue here'], 'canonical transcript replaces divergent channel-only replay');
  A.eq(sends, ['channel answer'], 'one canonical run emits one final reply');
  A.eq(records.chat.streamId, 'desktop_stream_1', 'chat binding survives the ordinary record refresh');
  A.ok(appended.some(x => x.role === 'user') && appended.some(x => x.role === 'assistant'), 'legacy history remains a fallback projection');

  let now = 1700000000000;
  A.throws(() => makeWebhookVerifier({ secret: 'x'.repeat(32) }), 'webhook replay protection refuses an ambient wall clock');
  const auth = makeWebhookVerifier({ secret: 'x'.repeat(32), now: () => now, maxSkewMs: 60000 });
  const body = '{"chatId":"chat","text":"hello"}', ts = String(now), nonce = 'nonce_1234567890abcdef';
  const signature = auth.sign(ts, nonce, body);
  A.ok(auth.verify({ timestamp: ts, nonce, signature, body }).ok, 'valid signed relay lifecycle payload is admitted');
  A.eq(auth.verify({ timestamp: ts, nonce, signature, body }).code, 409, 'the same nonce cannot replay');
  A.eq(auth.verify({ timestamp: String(now - 120000), nonce: 'nonce_2234567890abcdef', signature: auth.sign(String(now - 120000), 'nonce_2234567890abcdef', body), body }).code, 401, 'stale signed payload is refused');
  A.eq(auth.verify({ timestamp: ts, nonce: 'nonce_3234567890abcdef', signature: '0'.repeat(64), body }).code, 401, 'wrong HMAC is refused');

  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  const mirror = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'chat.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/mergeCanonicalHistory/.test(chat) && /buckets\.get\(key\)/.test(chat), 'desktop reconciliation is occurrence-aware');
  const mergeBody = A.fnBody(chat, 'function mergeCanonicalHistory(local, turns)');
  const mergeCanonicalHistory = new Function(mergeBody + '; return mergeCanonicalHistory;')();
  const healed = mergeCanonicalHistory([
    { role: 'user', content: 'make the report' },
    { role: 'assistant', content: '' },
    { role: 'system', sys: true, transcriptPending: true, content: 'retrying' }
  ], [
    { role: 'user', content: 'make the report' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'report ready' }
  ]);
  A.eq(healed.filter(x => x.role === 'assistant').map(x => x.content), ['report ready'], 'canonical merge drops blank tool envelopes and keeps the final prose');
  A.ok(!healed.some(x => x.transcriptPending), 'a recovered canonical reply clears the pending transcript marker');
  A.ok(/cronSession && !busy/.test(chat) && /transcriptPending: true/.test(chat), 'settled cron sessions retry and expose a truthful pending state when output is unavailable');
  A.ok(/loadServerHistory\(activeWs, historyPin\)/.test(A.fnBody(chat, 'function load(ws)')), 'every desktop load starts the owned canonical transcript read');
  A.eq(chat, mirror, 'website mirror carries the identical continuity behavior');
  A.ok(/\/api\/channels\/handoff/.test(index) && /\/api\/channels\/webhook\//.test(index), 'authenticated handoff and relay lifecycle routes are wired');
  A.report('cross-surface-continuity.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
