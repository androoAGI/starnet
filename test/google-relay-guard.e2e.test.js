'use strict';
/* Real sidecar proof that RESTRICTED Google data never reaches StarNet Managed (the credits relay):
   a live Gmail connector (synthetic Google) is offered to an own-key run and returns mail content; on a
   StarNet Managed run the same agent is NOT offered Gmail tools, and the replayed Gmail result arrives at
   the relay as the withheld notice — never the mail body. No real Google account, cloud or model is used.
   The same proof runs for Gmail over an APP PASSWORD (IMAP, no OAuth) against a fake local IMAP server
   (test/helpers/fake-gmail.js, routed in by test/fixtures/gmail-imap-preload.cjs). */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { ENDPOINTS } = require('../sidecar/mcp/transport.google.js');
const { WITHHELD } = require('../sidecar/mcp/google-relay-guard.js');
const imapGmail = require('../sidecar/mcp/transport.gmail-imap.js');
const { mcpToolName } = require('../sidecar/mcp/translate.js');
const { startFakeImap } = require('./helpers/fake-gmail.js');

const MAIL = 'Synthetic message for acceptance testing.';   // what the synthetic Gmail returns (google-signin-preload.cjs)
const GMAIL_READ = 'mcp__gmail__read_message';
const IMAP_MAIL = 'the quarterly numbers are attached';        // a snippet the fake IMAP server returns
const IMAP_LIST = mcpToolName('gmail-app-password', 'list_recent');
const IMAP_PASS = 'abcdefghijklmnop';
let nextTool = GMAIL_READ;                                       // which tool the fake own-key model calls next

(async () => {
  const relay = [], custom = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) return res.end(JSON.stringify({ balanceUsd: 100 }));
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (/\/(debit|credit)$/.test(req.url)) return res.end(JSON.stringify({ ok: true, balanceUsd: 100 }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    const isCustom = req.url.startsWith('/custom/');
    (isCustom ? custom : relay).push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const toolNames = (body.tools || []).map(t => t.function && t.function.name);
    const answered = (body.messages || []).some(m => m.role === 'tool');
    const delta = isCustom && toolNames.includes(nextTool) && !answered
      ? { tool_calls: [{ index: 0, id: nextTool === GMAIL_READ ? 'mail1' : 'imap1', type: 'function', function: { name: nextTool, arguments: JSON.stringify(nextTool === GMAIL_READ ? { messageId: 'message-1' } : { maxResults: 5 }) } }] }
      : { content: 'Done.' };
    const finish = delta.tool_calls ? 'tool_calls' : 'stop';
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cloud = 'http://127.0.0.1:' + server.address().port;
  const fakeImap = await startFakeImap({ user: 'me@example.com', pass: IMAP_PASS });
  const fixture = new SidecarFixture({ prefix: 'google-relay-guard-', timeoutMs: 30000, env: {
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CLOUD_URL: cloud, STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    OPENROUTER_API_KEY: '', OPENROUTER_KEY: '', SKYNET_AUX_BUDGET: '0', SKYNET_FULL_ACCESS: '1',
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    STARNET_TEST_FAKE_IMAP_PORT: String(fakeImap.port),
    NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'fixtures/google-signin-preload.cjs').replace(/\\/g, '/')) +
      ' --require=' + JSON.stringify(path.join(__dirname, 'fixtures/gmail-imap-preload.cjs').replace(/\\/g, '/'))
  } });
  const secrets = path.join(fixture.workspace, '.secrets/credits.json');
  fs.mkdirSync(path.dirname(secrets), { recursive: true });
  fs.writeFileSync(secrets, JSON.stringify({ url: cloud, deviceToken: 'fixture-linked-token', accountId: 'fixture-account', linkedAt: Date.now() }));
  const state = path.join(fixture.workspace, 'connectors/state.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ version: 2,
    configs: [{ id: 'gmail', label: 'Gmail', url: ENDPOINTS.gmail, transport: 'http', oauth: true, enabled: true, googleApi: true },
      { id: 'gmail-app-password', label: 'Gmail (app password)', url: imapGmail.ENDPOINT, transport: 'http', enabled: true, token: 'me@example.com:' + IMAP_PASS }],
    oauth: { clients: {}, byId: { gmail: { accessToken: 'GOOGLE_ACCESS_TEST', refreshToken: 'GOOGLE_REFRESH_TEST', expiresAt: Date.now() + 3600e3,
      tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: '123456-starnettest.apps.googleusercontent.com',
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' } } } }));
  const run = async (provider, messages, extra) => {
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({
      provider, model: 'test/model', agentId: 'mailer', isTask: true, placed: [{ objectType: 'connector', connectorId: 'gmail' }, { objectType: 'connector', connectorId: 'gmail-app-password' }], messages }, extra || {})) });
    assert.equal(r.status, 200);
    return (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  };
  const names = b => (b.tools || []).map(t => t.function && t.function.name);
  try {
    await fixture.start();
    let row;
    for (let i = 0; i < 50; i++) {
      row = (await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'gmail');
      if (row && row.state === 'up') break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(row && row.state, 'up', 'the Gmail connector is live: ' + JSON.stringify(row && { state: row.state, detail: row.detail }));
    let apRow;
    for (let i = 0; i < 50; i++) {
      apRow = (await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'gmail-app-password');
      if (apRow && apRow.state === 'up') break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(apRow && apRow.state, 'up', 'the app-password Gmail connector logged in to the fake IMAP server: ' + JSON.stringify(apRow && { state: apRow.state, detail: apRow.detail }));
    assert.ok(!JSON.stringify((await fixture.json('GET', '/api/connectors')).body).includes(IMAP_PASS), 'the connector list never carries the app password');

    // 1. own-key run: Gmail is offered and returns mail content into the conversation
    const own = await run('custom', [{ role: 'user', content: 'Read my latest mail' }], { baseUrl: cloud + '/custom/v1', key: 'fixture-custom-key' });
    assert.ok(custom.some(b => names(b).includes(GMAIL_READ)), 'an own-key run is offered Gmail');
    const result = own.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'mail1');
    assert.ok(result && result.payload.ok, 'Gmail read_message ran: ' + JSON.stringify(result && result.payload).slice(0, 200));
    assert.ok(custom.some(b => JSON.stringify(b.messages).includes(MAIL)), 'the own-key provider received the mail (the user chose it)');

    // 2. StarNet Managed run carrying that history: no Gmail tools, and the mail body is withheld
    const history = [
      { role: 'user', content: 'Read my latest mail' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'mail1', type: 'function', function: { name: GMAIL_READ, arguments: '{"messageId":"message-1"}' } }] },
      { role: 'tool', tool_call_id: 'mail1', content: MAIL },
      { role: 'user', content: 'Now summarize it' }
    ];
    const before = relay.length;
    const managed = await run('starnet', history);
    assert.equal(managed.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done', JSON.stringify(managed.filter(e => /error/.test(e.name))));
    const sent = relay.slice(before).filter(b => Array.isArray(b.messages));
    assert.ok(sent.length > 0, 'the managed run reached the relay');
    for (const b of sent) {
      assert.ok(!names(b).some(n => /^mcp__gmail__/.test(n)), 'StarNet Managed is never offered Gmail tools');
      assert.ok(!JSON.stringify(b).includes(MAIL), 'the mail body never reaches the StarNet relay');
    }
    assert.ok(sent.some(b => JSON.stringify(b.messages).includes('never sent to StarNet Managed')), 'the relay sees the withheld notice in its place');

    // 3. the same proof for Gmail over an APP PASSWORD (IMAP): own-key reads mail, StarNet Managed never sees it
    nextTool = IMAP_LIST;
    const ownImap = await run('custom', [{ role: 'user', content: 'List my inbox' }], { baseUrl: cloud + '/custom/v1', key: 'fixture-custom-key' });
    assert.ok(custom.some(b => names(b).includes(IMAP_LIST)), 'an own-key run is offered app-password Gmail');
    const imapResult = ownImap.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'imap1');
    assert.ok(imapResult && imapResult.payload.ok, 'list_recent ran over IMAP: ' + JSON.stringify(imapResult && imapResult.payload).slice(0, 300));
    assert.ok(custom.some(b => JSON.stringify(b.messages).includes(IMAP_MAIL)), 'the own-key provider received the mail (the user chose it)');
    assert.ok(!JSON.stringify(ownImap).includes(IMAP_PASS), 'the app password never appears in run events');
    const imapHistory = [
      { role: 'user', content: 'List my inbox' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'imap1', type: 'function', function: { name: IMAP_LIST, arguments: '{"maxResults":5}' } }] },
      { role: 'tool', tool_call_id: 'imap1', content: 'Hi, ' + IMAP_MAIL + ' in the shared sheet.' },
      { role: 'user', content: 'Now summarize it' }
    ];
    const beforeImap = relay.length;
    const managedImap = await run('starnet', imapHistory);
    assert.equal(managedImap.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done', JSON.stringify(managedImap.filter(e => /error/.test(e.name))));
    const sentImap = relay.slice(beforeImap).filter(b => Array.isArray(b.messages));
    assert.ok(sentImap.length > 0, 'the managed run reached the relay');
    for (const b of sentImap) {
      assert.ok(!names(b).some(n => /^mcp__gmail-app-password__/.test(n)), 'StarNet Managed is never offered app-password Gmail tools');
      assert.ok(!JSON.stringify(b).includes(IMAP_MAIL), 'IMAP mail content never reaches the StarNet relay');
      assert.ok(!JSON.stringify(b).includes(IMAP_PASS), 'the app password never reaches the StarNet relay');
    }
    assert.ok(sentImap.some(b => JSON.stringify(b.messages).includes('never sent to StarNet Managed')), 'the relay sees the withheld notice in its place');
    console.log('google-relay-guard.e2e: PASS (own-key run reads Gmail; StarNet Managed gets no Gmail tools and only the withheld notice; same for app-password Gmail over IMAP)');
  } finally { await fakeImap.close(); await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
