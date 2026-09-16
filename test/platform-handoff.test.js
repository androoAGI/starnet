'use strict';
const assert = require('node:assert/strict');
const W = require('../frontend/app/workstreams.js');
const { continuationScope } = require('../sidecar/connector-continuation.js');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { readGoogleAccount, publicAccount } = require('../sidecar/mcp/account.js');
const connectorState = require('../sidecar/connectorstate.js');
const fs = require('node:fs');
const vm = require('node:vm');

(async () => {
  W.init();
  const w = W.create('Summarize inbox', { agentId: 'nova' });
  W.appendRun(w.id, 'r1');
  W.setConnectorHandoff(w.id, { connectorId: 'gmail', runId: 'r1', agentId: 'nova', toolName: 'list_messages' });
  W.init(JSON.parse(JSON.stringify(W.serialize())));
  assert.equal(W.connectorHandoff(w.id).connectorId, 'gmail', 'handoff survives serialized restart');
  W.setAgent(w.id, 'other');
  assert.equal(W.connectorHandoff(w.id), null, 'agent changes invalidate handoff');
  W.setAgent(w.id, 'nova');
  W.appendRun(w.id, 'r2');
  assert.equal(W.connectorHandoff(w.id), null, 'new work invalidates old task');
  const row = { runId: 'r1', agentId: 'nova', streamId: 'ws', reason: 'done', uncertainMutations: [] };
  assert.equal(continuationScope([row], 'r1', 'nova', 'ws'), 'run:r1');
  assert.equal(continuationScope([row, { ...row, runId: 'r2', parentRunId: 'r1' }], 'r2', 'nova', 'ws'), 'run:r1', 'successive connections retain original write scope');
  assert.throws(() => continuationScope([row], 'r1', 'other', 'ws'), /original/);
  assert.throws(() => continuationScope([row], 'r1', 'nova', 'different'), /original/);
  assert.throws(() => continuationScope([{ ...row, uncertainMutations: [{}] }], 'r1', 'nova', 'ws'), /uncertain/);
  assert.throws(() => continuationScope([], 'r1', 'nova', 'ws'), /unavailable/);
  const launches = [];
  let held = true;
  const b = makeBrowserTools({ profileWaitMs: 500, persistentProfile: { dir: '/saved', acquire: () => !held, release() {} },
    makeDriver: o => { launches.push(o); return { tabs: async () => [], close: async () => {} }; } });
  const t = b.tools.find(t => t.name === 'browser.tabs');
  const pending = t.run({}, {});
  assert.equal(launches.length, 0);
  setTimeout(() => { held = false; }, 30);
  await pending;
  assert.equal(launches[0].profileDir, '/saved', 'waiting run uses original signed-in profile');
  await b.session.close();
  held = true;
  const cancelled = makeBrowserTools({ profileWaitMs: 500, persistentProfile: { dir: '/saved', acquire: () => !held, release() {} }, makeDriver: () => { throw new Error('must not launch'); } });
  const ac = new AbortController();
  const wait = cancelled.tools.find(t => t.name === 'browser.tabs').run({}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(wait, /cancelled/);
  const timeout = makeBrowserTools({ profileWaitMs: 0, persistentProfile: { dir: '/saved', acquire: () => false, release() {} } });
  await assert.rejects(timeout.tools.find(t => t.name === 'browser.tabs').run({}, {}), /saved logins were not replaced/);
  const identityArgs = { authorizationServer: 'https://accounts.google.com', tokenEndpoint: 'https://oauth2.googleapis.com/token', accessToken: 'fixture-token', now: 1234 };
  const account = await readGoogleAccount({ ...identityArgs, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(opts.headers.Authorization, 'Bearer fixture-token');
    assert.equal(opts.redirect, 'error');
    return new Response(JSON.stringify({ sub: 'google-subject', email: 'fixture@example.com', email_verified: true }));
  } });
  assert.equal(account.email, 'fixture@example.com');
  assert.equal(account.verifiedAt, 1234);
  const saved = connectorState.withOauthEntry({}, 'gmail', { accessToken: 'fixture-token', account });
  assert.deepEqual(publicAccount(JSON.parse(JSON.stringify(saved)).oauth.byId.gmail), account, 'identity survives envelope persistence');
  assert.ok(!JSON.stringify(publicAccount(saved.oauth.byId.gmail)).includes('fixture-token'), 'public identity never exposes credential');
  assert.equal(await readGoogleAccount({ ...identityArgs, authorizationServer: 'https://other.example', fetchImpl: () => { throw new Error('must not send token'); } }), null);
  assert.equal(await readGoogleAccount({ ...identityArgs, fetchImpl: async () => new Response('{"sub":"id","email":"fake@example.com","email_verified":false}') }), null);
  assert.equal(await readGoogleAccount({ ...identityArgs, timeoutMs: 5, fetchImpl: async () => ({ ok: true, text: () => new Promise(() => {}) }) }), null, 'body stalls are bounded');
  assert.equal(await readGoogleAccount({ ...identityArgs, fetchImpl: async () => new Response('x'.repeat(9000)) }), null, 'oversized identity is rejected');
  // Execute the production continuation handler with a sleeping connector and concurrent user clicks.
  W.init();
  const cw = W.create('Idle connector task', { agentId: 'nova' }); W.appendRun(cw.id, 'idle-source');
  const handoff = { connectorId: 'gmail', agentId: 'nova', runId: 'idle-source', toolName: 'list_messages' };
  W.setConnectorHandoff(cw.id, handoff);
  const src = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
  const handler = src.slice(src.indexOf('  async function continueConnectorTask('), src.indexOf('  function offerTryAgain('));
  let refreshed = 0, dispatched = 0, connectionState = 'cached', rejected = false;
  const context = { Workstreams: W, Channels: { isBusy: () => false }, connectorContinuing: new Set(), focusVersion: 0, isComposerEngaged: () => false,
    App: { openWorkstream() {}, persist() {} }, StationUI: { notify() {} },
    Harness: { api: { get: async () => ({ connectors: [{ id: 'gmail', enabled: true, state: connectionState, authRequired: rejected, tools: ['list_messages'] }] }),
      post: async (url, body) => { assert.equal(url, '/api/connectors/refresh'); assert.equal(body.id, 'gmail'); refreshed++; connectionState = 'up'; } } },
    send: async (text, opts) => { assert.equal(opts.connectorContinuationOf, 'idle-source'); dispatched++; W.appendRun(cw.id, 'continued'); } };
  const expression = 'continueConnectorTask(' + JSON.stringify(cw.id) + ')';
  const results = await vm.runInNewContext(handler + '; Promise.all([' + expression + ',' + expression + '])', context);
  assert.equal(results[0], true); assert.equal(results[1], false);
  assert.equal(refreshed, 1, 'cached connection wakes once'); assert.equal(dispatched, 1, 'double click dispatches once');
  W.get(cw.id).runIds = ['idle-source']; W.setConnectorHandoff(cw.id, handoff); rejected = true;
  assert.equal(await vm.runInNewContext(handler + ';' + expression, context), false);
  assert.equal(dispatched, 1, 'revoked connection cannot continue');
  assert.ok(W.connectorHandoff(cw.id), 'failed recheck retains the task');
  console.log('platform-handoff.test: passed (restart, task/agent binding, write scope, contention, cancellation, timeout)');
})().catch(e => { console.error(e); process.exitCode = 1; });
