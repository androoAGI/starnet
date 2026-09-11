'use strict';
// Real Codex/OpenRouter adapters and run host, synthetic credentials and loopback upstreams.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
(async () => {
  let calls = [], mode = 'text';
  const key = 'synthetic-router-fallback-key';
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      if (req.method !== 'POST') return res.end(JSON.stringify({ data: [] }));
      const body = JSON.parse(raw); calls.push({ url: req.url, model: body.model, auth: req.headers.authorization });
      if (req.url.endsWith('/responses')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Codex quota exceeded', code: 'usage_limit_reached' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = mode === 'text' ? { content: 'Fallback completed.' } : { tool_calls: [{ index: 0, id: 'cost-probe', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] };
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: mode === 'text' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 4, ...(mode === 'unpriced' ? {} : { cost: 0.012 }) } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 20000, env: {
    SKYNET_SCOUT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0',
    OPENROUTER_KEY: key, OPENROUTER_API_KEY: key, SKYNET_OPENROUTER_BASE: base + '/router',
    SKYNET_FALLBACK_MODELS: 'gpt-5.4', SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0'
  } });
  const jwt = ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url'), 'synthetic'].join('.');
  fs.mkdirSync(path.join(fixture.workspace, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(fixture.workspace, 'codex/tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'synthetic-refresh', auth_mode: 'device' }));
  async function run(extra = {}) {
    calls = [];
    const r = await fixture.json('POST', '/api/run', { provider: 'codex', model: 'gpt-5.5', baseUrl: base + '/codex', agentId: 'agent', internal: true, isTask: true, messages: [{ role: 'user', content: 'Return a short fixture acknowledgement.' }], ...extra });
    assert.equal(r.status, 200, r.text);
    return r.text.trim().split('\n').map(x => JSON.parse(x));
  }
  try {
    await fixture.start();
    const saved = await fixture.json('POST', '/api/fallback/chain', { models: ['z-ai/glm-5.3-flash'] });
    assert.equal(saved.status, 200, saved.text);
    for (let boot = 0; boot < 2; boot++) {
      if (boot) await fixture.restart();
      const events = await run();
      assert.ok(calls.some(c => c.url === '/codex/responses'), 'actual Codex quota failure');
      assert.ok(calls.some(c => c.url === '/router/chat/completions' && c.model === 'z-ai/glm-5.3-flash' && c.auth === 'Bearer ' + key), 'saved OpenRouter fallback uses its own endpoint, model and credential');
      assert.ok(!calls.some(c => c.url === '/codex/responses' && c.model.startsWith('z-ai/')), 'OpenRouter model never sent to Codex');
      assert.equal(events.findLast(e => e.name === 'agent.run.end')?.payload.reason, 'done');
      assert.ok(events.some(e => e.name === 'provider.fallback'), 'fallback emitted');
      const row = fs.readFileSync(path.join(fixture.workspace, 'ledger.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x)).findLast(x => x.model === 'z-ai/glm-5.3-flash');
      assert.equal(row.unmetered, false, 'paid fallback is not labeled as a Codex subscription run');
      assert.equal(row.usd, 0.012, 'actual OpenRouter spend retained');
    }
    await run({ fallbackModels: ['gpt-5.4'] });
    assert.ok(calls.some(c => c.url === '/codex/responses' && c.model === 'gpt-5.4'), 'explicit model override stays on primary provider');
    assert.ok(!calls.some(c => c.url.startsWith('/router/')), JSON.stringify(calls.map(c => ({ url: c.url, model: c.model }))));
    await fixture.json('POST', '/api/fallback/chain', { models: [] });
    await run(); assert.ok(calls.every(c => c.model === 'gpt-5.5'), 'saved empty disables fallback');
    await fixture.json('POST', '/api/fallback/chain', { models: null });
    await run(); assert.ok(calls.some(c => c.model === 'gpt-5.4' && c.url === '/codex/responses'), 'environment default retains primary provider');
    await fixture.json('POST', '/api/fallback/chain', { models: ['z-ai/glm-5.3-flash'] });
    fixture.env.SKYNET_BUDGET_PER_RUN = '0.005';
    await fixture.restart(); mode = 'cost';
    const capped = await run();
    assert.equal(capped.findLast(e => e.name === 'agent.run.end')?.payload.reason, 'budget', 'paid fallback activates the opted-in dollar ceiling');
    assert.equal(calls.filter(c => c.url.startsWith('/router/')).length, 1, 'no second paid turn after the cap');
    fixture.env.SKYNET_BUDGET_PER_RUN = '0'; fixture.env.SKYNET_MAX_UNPRICED_TOKENS = '10';
    await fixture.restart(); mode = 'unpriced';
    const unpriced = await run();
    assert.equal(unpriced.findLast(e => e.name === 'agent.run.end')?.payload.reason, 'budget', 'paid fallback activates the unpriced-token ceiling');
    assert.equal(calls.filter(c => c.url.startsWith('/router/')).length, 1, 'unpriced fallback is bounded');
    mode = 'text';
    fixture.env.OPENROUTER_KEY = ''; fixture.env.OPENROUTER_API_KEY = '';
    await fixture.restart();
    const missing = await run();
    assert.ok(!calls.some(c => c.url.startsWith('/router/')), 'missing OpenRouter credential cannot borrow Codex authentication');
    assert.equal(missing.findLast(e => e.name === 'agent.run.end')?.payload.reason, 'error', 'unavailable fallback leaves an honest error');
    console.log('saved-provider-fallback.e2e: PASS (real adapters, credential isolation, restart, overrides and empty/default chains)');
  } finally { await fixture.dispose(); await new Promise(r => upstream.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
