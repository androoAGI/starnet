'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { desktopClient, loadDesktopClient } = require('../sidecar/mcp/google-client.js');
const { ENDPOINTS, TOOLS, makeGoogleTransport, productForUrl } = require('../sidecar/mcp/transport.google.js');
const { makeMcpClient } = require('../sidecar/mcp/client.js');
const { resolveConnectorOauthTarget } = require('../sidecar/mcp/oauth-target.js');
const catalog = require('../sidecar/mcp/catalog.js');

(async () => {
  const installed = { installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } };
  assert.equal(desktopClient(installed).tokenEndpointAuthMethod, 'none');
  assert.equal(desktopClient({ installed: { ...installed.installed, client_secret: 'native-metadata' } }).tokenEndpointAuthMethod, 'client_secret_post');
  assert.throws(() => desktopClient({ web: installed.installed }), /Desktop/);
  assert.throws(() => desktopClient({ installed: { client_id: 'bogus' } }), /invalid/);
  assert.throws(() => desktopClient({ installed: { ...installed.installed, token_uri: 'https://evil.invalid' } }), /host/);
  assert.equal(loadDesktopClient({ env: {}, readFile() { throw Error('not configured'); } }), null);
  assert.equal(loadDesktopClient({ env: { STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify(installed) }, readFile() { throw Error('must use publisher environment'); } }).clientId, installed.installed.client_id);
  assert.equal(productForUrl(ENDPOINTS.gmail + '.evil'), null);
  const legacy = resolveConnectorOauthTarget('gmail', catalog, [{ id: 'gmail', oauth: true, transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' }]);
  assert.equal(legacy.custom, false);
  assert.equal(legacy.entry.url, ENDPOINTS.gmail);
  assert.equal(resolveConnectorOauthTarget('gmail', catalog, [{ id: 'gmail', oauth: true, transport: 'http', url: 'https://custom.example/mcp' }]).custom, true);

  const examples = {
    search_messages: { query: 'from:test@example.invalid', pageToken: 'next&evil=1' }, read_message: { messageId: 'message-1' },
    read_thread: { threadId: 'thread-1' }, read_attachment: { messageId: 'message-1', attachmentId: 'attachment-1' },
    create_draft: { raw: Buffer.from('To: test@example.invalid\r\nSubject: Test\r\n\r\nHello').toString('base64url') }, send_draft: { draftId: 'draft-1' },
    list_files: { query: "name contains 'test'" }, get_file: { fileId: 'file-1' }, export_file: { fileId: 'file-1', mimeType: 'text/plain' },
    create_file: { metadata: { name: 'Test' } }, update_file: { fileId: 'file-1', metadata: { name: 'Updated' } },
    list_calendars: {}, list_events: {}, get_event: { eventId: 'event-1' }, free_busy: { timeMin: '2026-09-06T00:00:00Z', timeMax: '2026-09-07T00:00:00Z', calendarIds: ['primary'] },
    get_document: { documentId: 'document-1' }, create_document: { title: 'Test' },
    get_spreadsheet: { spreadsheetId: 'sheet-1' }, read_values: { spreadsheetId: 'sheet-1', range: "'Sheet 1'!A1:B2" },
    create_spreadsheet: { title: 'Test' }, write_values: { spreadsheetId: 'sheet-1', range: 'A1', values: [['=1+1']] }
  };
  let exercised = 0;
  for (const [product, url] of Object.entries(ENDPOINTS)) {
    const calls = [];
    const client = makeMcpClient({ timeoutMs: 1000, transport: makeGoogleTransport({ url, token: 'TEST_TOKEN', fetchImpl: async (target, opts) => {
      calls.push({ target, opts });
      assert.equal(opts.headers.Authorization, 'Bearer TEST_TOKEN');
      assert.equal(opts.redirect, 'error');
      assert.ok(!target.includes('TEST_TOKEN'));
      return new Response(JSON.stringify({ id: 'fixture', messages: [{ id: 'message-1' }] }), { headers: { 'Content-Type': 'application/json' } });
    } }) });
    await client.initialize();
    assert.equal(calls.length, 1, product + ' verifies Google before connected');
    const defs = await client.listTools();
    assert.equal(defs.length, TOOLS[product].length);
    for (const def of defs) {
      const args = def.name === 'batch_update' ? product === 'google-docs' ? { documentId: 'document-1', requests: [{ insertText: { text: 'hi', endOfSegmentLocation: {} } }] } : { spreadsheetId: 'sheet-1', requests: [{ addSheet: { properties: { title: 'New' } } }] } : examples[def.name];
      const response = await client.callTool(def.name, args);
      assert.equal(response.isError, false);
      assert.ok(calls.at(-1).target.startsWith(url));
      if (def.name === 'write_values') assert.equal(new URL(calls.at(-1).target).searchParams.get('valueInputOption'), 'RAW');
      if (def.name === 'search_messages') assert.equal(new URL(calls.at(-1).target).searchParams.get('pageToken'), 'next&evil=1');
      exercised++;
    }
    const before = calls.length;
    await assert.rejects(client.callTool('nonexistent', {}), /Unknown/);
    await assert.rejects(client.callTool(defs[0].name, { url: 'https://evil.invalid' }), /Unknown argument/);
    assert.equal(calls.length, before, 'invalid tools never reach the network');
    client.close();
  }
  for (const status of [401, 403, 429, 500]) {
    const client = makeMcpClient({ transport: makeGoogleTransport({ url: ENDPOINTS.gmail, token: 'TEST_TOKEN', fetchImpl: async () => new Response('sensitive echoed token', { status }) }), timeoutMs: 1000 });
    await assert.rejects(client.initialize(), e => e.message.includes('HTTP ' + status) && !e.message.includes('sensitive'));
    client.close();
  }
  let cleanupSignal;
  const failedCleanup = makeMcpClient({ transport: makeGoogleTransport({ url: ENDPOINTS.gmail, token: 't', fetchImpl: async (_, opts) => {
    cleanupSignal = opts.signal;
    return { ok: false, status: 401, body: { cancel() { throw new Error('private cleanup details'); } } };
  } }) });
  await assert.rejects(failedCleanup.initialize(), e => e.message.includes('HTTP 401') && !e.message.includes('private'));
  assert.equal(cleanupSignal.aborted, true, 'failed error-body cancellation aborts the request while preserving the API status');
  failedCleanup.close();
  const blocked = makeMcpClient({ timeoutMs: 1000, transport: makeGoogleTransport({ url: ENDPOINTS.gmail, token: 't', timeoutMs: 20, fetchImpl: () => new Promise(() => {}) }) });
  await assert.rejects(blocked.initialize(), /timed out/); blocked.close();
  const oversized = makeMcpClient({ timeoutMs: 1000, transport: makeGoogleTransport({ url: ENDPOINTS.gmail, token: 't', fetchImpl: async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)) }) });
  await assert.rejects(oversized.initialize(), /8 MiB/); oversized.close();
  const ui = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/connectors.js'), 'utf8');
  assert.ok(!/data-cc-oclient|enroll in the preview|placeholder="client secret"/.test(ui));
  assert.ok(ui.includes('SIGN IN WITH GOOGLE'));
  const train = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-train.yml'), 'utf8');
  assert.ok(train.includes('run: node scripts/stage-google-client.mjs\n'));
  assert.ok(!train.includes('stage-google-client.mjs --optional'));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-google-stage-'));
  try {
    fs.mkdirSync(path.join(stageRoot, 'scripts'));
    fs.mkdirSync(path.join(stageRoot, 'sidecar/mcp'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../scripts/stage-google-client.mjs'), path.join(stageRoot, 'scripts/stage-google-client.mjs'));
    fs.copyFileSync(path.join(__dirname, '../sidecar/mcp/google-client.js'), path.join(stageRoot, 'sidecar/mcp/google-client.js'));
    const stage = (raw, optional = false) => spawnSync(process.execPath, [path.join(stageRoot, 'scripts/stage-google-client.mjs'), ...(optional ? ['--optional'] : [])], {
      encoding: 'utf8', env: { ...process.env, STARNET_GOOGLE_DESKTOP_CLIENT_JSON: raw, NODE_OPTIONS: '' }
    });
    const staged = path.join(stageRoot, 'sidecar/mcp/google-client.json');
    fs.writeFileSync(staged, JSON.stringify(installed));
    assert.equal(stage(JSON.stringify(installed)).status, 0, 'deferred release succeeds even with inherited publisher configuration');
    assert.equal(fs.existsSync(staged), false, 'deferred release removes stale staged registration');
    assert.equal(stage('').status, 0, 'deferred release does not require Google registration');
    // Verify the future enabled build still enforces its registration contract.
    const clientModule = path.join(stageRoot, 'sidecar/mcp/google-client.js');
    fs.writeFileSync(clientModule, fs.readFileSync(clientModule, 'utf8').replace('const RELEASE_DEFERRED = true;', 'const RELEASE_DEFERRED = false;'));
    assert.equal(stage('').status, 1, 'public builds refuse absent registration');
    assert.equal(stage(JSON.stringify({ web: installed.installed })).status, 1, 'web secrets never enter a desktop package');
    const malformed = stage('not-json-SENSITIVE-CANARY');
    assert.equal(malformed.status, 1); assert.ok(!malformed.stderr.includes('SENSITIVE-CANARY'));
    assert.equal(stage(JSON.stringify(installed)).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(staged, 'utf8')).installed.client_id, installed.installed.client_id);
    assert.equal(fs.statSync(staged).mode & 0o444, 0o444, 'installed native metadata remains readable across OS accounts');
    assert.equal(stage('', true).status, 0);
    assert.equal(fs.existsSync(staged), false, 'internal builds cannot inherit a stale registration');
  } finally { fs.rmSync(stageRoot, { recursive: true, force: true }); }
  console.log('google-connector: PASS (native registration, legacy routing, ' + exercised + ' real MCP tool paths, validation, API errors, timeout, bounds, customer UI, release gate)');
})().catch(e => { console.error(e); process.exitCode = 1; });
