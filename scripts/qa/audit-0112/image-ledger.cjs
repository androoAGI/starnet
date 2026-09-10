'use strict';
// Real sidecar, saved managed link, no OpenRouter key. Optional STARNET_TEST_CLOUD_ROOT
// drives the same journey through the actual cloud app/ledger with a synthetic upstream.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SidecarFixture } = require('../../../test/helpers/sidecar-fixture.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('managed images: saved credits route generates, bills, survives restart and fails honestly', { timeout: 120000 }, async () => {
  const calls = [];
  let failure = 0, noImage = false, balance = 100, deviceToken = 'fixture-device-token', account = 'fixture-account';
  let cloudApp, store, fixture;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function upstream(url, opts = {}) {
    if (String(url).includes('/models')) return json({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] });
    const body = JSON.parse(opts.body || '{}');
    const image = body.modalities?.includes('image');
    calls.push({ url: String(url), body, image, authorization: opts.headers.authorization || opts.headers.Authorization });
    if (image) {
      if (failure) return json({ error: { message: failure === 402 ? 'insufficient StarNet credits' : 'image provider unavailable' } }, failure);
      return json({ id: 'fixture-image-' + calls.length, choices: [{ message: noImage ? { content: 'No image was produced' } : { images: [{ image_url: { url: 'data:image/png;base64,' + PNG } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.02 } });
    }
    const result = (body.messages || []).some(m => m.role === 'tool');
    const delta = !body.tools?.length || result ? { content: 'The image request has finished.' } : { tool_calls: [{ index: 0, id: 'managed_image', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a blue cube', path: 'images/credits-proof.png' }) } }] };
    return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: result ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      let response;
      if (cloudApp) {
        response = await cloudApp.request(req.url, { method: req.method, headers: req.headers, ...(raw ? { body: raw } : {}) });
      } else if (req.url.includes('/balance')) response = json({ balanceUsd: balance });
      else if (/\/(debit|credit)$/.test(req.url)) response = json({ ok: true, balanceUsd: balance });
      else if (req.url.includes('/history')) response = json({ entries: [] });
      else {
        response = await upstream(req.url, { headers: req.headers, body: raw });
        if (raw && JSON.parse(raw).modalities?.includes('image') && response.ok) balance -= 0.025;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: { message: e.message } })); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cloudUrl = 'http://127.0.0.1:' + server.address().port;
  fixture = new SidecarFixture({ prefix: 'managed-image-proof-', timeoutMs: 20000, env: {
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '',
    STARNET_CLOUD_URL: cloudUrl, SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0',
    STARNET_OPENROUTER_BASE: cloudUrl + '/v1', STARNET_CUSTOM_OPENAI_BASE_URL: cloudUrl + '/v1'
  } });
  try {
    if (process.env.STARNET_TEST_CLOUD_ROOT) {
      const cloudRoot = path.resolve(process.env.STARNET_TEST_CLOUD_ROOT);
      const { createApp } = await import(pathToFileURL(path.join(cloudRoot, 'src/app.js')));
      const { makeStore } = await import(pathToFileURL(path.join(cloudRoot, 'src/store.js')));
      store = makeStore(path.join(fixture.workspace, 'proof-cloud.db'));
      let now = Date.now();
      cloudApp = createApp({ store, clock: { now: () => now }, upstream, config: { baseUrl: cloudUrl, devMode: true, openrouterKey: 'fixture-server-only-key', creditMargin: 1.25 } });
      const post = async (route, body) => (await cloudApp.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      account = (await post('/dev/grant', { email: 'image-fixture@example.test', usd: 100 })).accountId;
      const link = await post('/v1/link/start', { deviceName: 'image proof' });
      store.confirmLinkCode({ code: link.code, account, now }); now += 2000;
      deviceToken = (await post('/v1/link/poll', { code: link.code, pollSecret: link.pollSecret })).deviceToken;
      assert.ok(deviceToken);
    }
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.secrets/credits.json'), JSON.stringify({ url: cloudUrl, deviceToken, accountId: account, linkedAt: Date.now() }));
    await fixture.start();
    const run = async (agentId, provider = 'starnet') => {
      const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model: 'test/model', ...(provider === 'custom' ? { key: 'custom-conversation-key', baseUrl: cloudUrl + '/v1' } : {}), agentId, isTask: true, placed: ['studio'], messages: [{ role: 'user', content: 'Generate an image of a blue cube' }] }) });
      assert.equal(r.status, 200);
      return (await r.text()).split('\n').filter(Boolean).map(x => JSON.parse(x));
    };
    for (const round of [0, 1]) {
      if (round) {
        // Desktop adopts the file token into its keychain, then injects it on restart.
        const linkPath = path.join(fixture.workspace, '.secrets/credits.json');
        const saved = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
        delete saved.deviceToken;
        fs.writeFileSync(linkPath, JSON.stringify(saved));
        await fixture.restart({ STARNET_CREDITS_TOKEN: deviceToken });
      }
      const before = store ? store.balance(account) : balance;
      const events = await run('managed-image-' + round); fs.writeFileSync('qa/evidence/0.11.2-audit/audit-image-ledger-'+round+'.json', JSON.stringify({walletDebit:before-(store ? store.balance(account) : balance),costEvents:events.filter(e=>/cost|run.end/.test(e.name))},null,2));
      assert.equal(events.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done', JSON.stringify(events.filter(e => /error/.test(e.name))));
      assert.ok(events.some(e => e.name === 'agent.tool_result' && e.payload.ok));
      const bytes = fs.readFileSync(path.join(fixture.workspace, 'managed-image-' + round, 'images/credits-proof.png'));
      assert.equal(bytes.toString('base64'), PNG);
      assert.ok(Math.abs(before - (store ? store.balance(account) : balance) - 0.025) < 1e-6, 'exactly one image cost including cloud margin, no duplicate debit');
      const call = calls.filter(c => c.image).at(-1);
      assert.equal(call.authorization, 'Bearer ' + (cloudApp ? 'fixture-server-only-key' : deviceToken));
      assert.deepEqual(call.body.modalities, ['image', 'text']);
      const file = await fixture.request('/api/file?agent=managed-image-' + round + '&path=images%2Fcredits-proof.png');
      assert.equal(file.status, 200); assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), PNG);
    }
    if (!cloudApp) {
      const mixed = await run('mixed-image', 'custom');
      assert.equal(mixed.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done');
      assert.equal(calls.filter(c => c.image).at(-1).authorization, 'Bearer ' + deviceToken, 'provider switch still uses linked credits for media');
    }
    for (const status of [402, 503]) {
      failure = status;
      const before = store ? store.balance(account) : balance;
      const events = await run('refused-image-' + status);
      assert.notEqual(events.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done');
      assert.ok(!JSON.stringify(events).includes('connect OpenRouter'));
      assert.ok(!fs.existsSync(path.join(fixture.workspace, 'refused-image-' + status, 'images/credits-proof.png')));
      assert.equal(store ? store.balance(account) : balance, before, 'upstream refusal does not debit image cost');
    }
    failure = 0; noImage = true;
    const empty = await run('empty-image');
    assert.notEqual(empty.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done');
    assert.ok(!fs.existsSync(path.join(fixture.workspace, 'empty-image', 'images/credits-proof.png')));
    console.log('Managed image proof: credits-only PNG saved and served; restart passed; exact image debit $0.025; 402/503/no-image never done. Cloud=' + !!cloudApp);
  } finally {
    await fixture.stop();
    if (store) store.close();
    await fixture.dispose();
    server.closeAllConnections(); await new Promise(r => server.close(r));
  }
});
