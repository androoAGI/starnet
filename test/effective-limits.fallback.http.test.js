'use strict';
/* Real station readback with persisted fallback choices. No model call is made; credentials and endpoints
 * are synthetic, and the child can reach only the synthetic server origin. Managed mismatches remain ineligible. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const IPC = 'effective-fallback-inventory-token-0123456789';
let generationPosts = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && /chat\/completions|responses|messages|\/api\/(chat|generate)/.test(req.url)) generationPosts++;
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [], balanceUsd: 10 }));
});
async function scenario(base, operator) {
  const env = { STARNET_IPC_TOKEN: IPC, STARNET_DEFAULT_MODEL: 'gpt-5.5', STARNET_DEFAULT_PROVIDER: 'codex',
    STARNET_FALLBACK_MODELS: 'environment-only-model', STARNET_CREDITS_URL: operator ? base + '/credits' : '',
    STARNET_CREDITS_ACCOUNT: 'fixture-account', STARNET_CREDITS_API_KEY: operator ? 'fixture-credit' : '', STARNET_CLOUD_URL: '',
    STARNET_BUDGET_PER_DAY: '0', STARNET_LIVE_PRICES: '0', STARNET_REFLECTION: '0', STARNET_STUDY: '0',
    STARNET_FAILURE_REVIEW: '0', STARNET_QUEST_REFRESH: '0', STARNET_THREAD_MINE: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_SCOUT: '0', STARNET_CRON_ENABLED: '0' };
  for (const key of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'KEY_POOL_OPENROUTER']) {
    env[key] = ''; env['STARNET_' + key] = ''; env['SKYNET_' + key] = '';
  }
  const f = SidecarFixture.create({ prefix: 'effective-fallback-', env });
  const entry = path.join(f.workspace, 'inventory-boot.cjs');
  fs.writeFileSync(entry, "const real = globalThis.fetch; globalThis.fetch = function(url) { const u = new URL(String((url && url.url) || url)); return u.origin === " + JSON.stringify(base) + " ? real.apply(this, arguments) : Promise.reject(new Error('inventory fixture: non-fixture transport refused')); };\nrequire(" + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ");\n");
  f.entry = entry;
  fs.mkdirSync(path.join(f.workspace, 'codex'), { recursive: true });
  const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url') + '.fixture';
  fs.writeFileSync(path.join(f.workspace, 'codex', 'tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'Bearer' }));
  async function key(value) {
    const response = await f.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC },
      body: JSON.stringify({ provider: 'openrouter', key: value, keyPool: [], baseUrl: base + '/router' }) });
    assert.equal(response.status, 200);
  }
  async function chain(models) { const result = await f.json('POST', '/api/fallback/chain', { models }); assert.equal(result.status, 200); }
  async function read(primary, expectFallback, label) {
    const response = await f.json('GET', '/api/budget/status');
    assert.equal(response.status, 200);
    const inventory = response.body.effective;
    const payer = primary === 'codex' ? 'subscription' : 'local';
    assert.deepEqual(inventory.classes.slice().sort(), (expectFallback ? [payer, 'metered'] : [payer]).sort(), label + ': exactly the eligible payer inventory');
    for (const name of ['perRun', 'maxUnpricedTokens']) {
      const row = inventory.rows.find(r => r.key === name);
      assert.equal(row.inUse.includes('metered'), expectFallback, label + ': ' + name + ' follows eligible saved fallback');
    }
    assert.ok(!inventory.classes.includes('managed'), label + ': a primary cannot borrow another payer reservation');
    return inventory.classes;
  }
  const receipts = [];
  try {
    await f.start();
    const now = Date.now();
    const saved = await f.json('POST', '/api/save', { schema: 'starnet.save', version: 6, updatedAt: now,
      _saveRevision: 0, _saveDirty: true, _saveClient: 'effective-fallback-test', agent: { id: 'agent', name: 'NOVA', createdAt: now },
      agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    assert.equal(saved.status, 200); assert.equal(saved.body.ok, true);
    for (const primary of ['codex', 'ollama']) {
      const set = await f.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
        { agentId: 'agent', name: 'NOVA', provider: primary, model: primary === 'codex' ? 'gpt-5.5' : 'fixture-local' }
      ] });
      assert.equal(set.status, 200);
      await chain(null); await key('fixture-router');
      await read(primary, false, primary + ': environment chain stays on its primary');
      await chain([]);
      await read(primary, false, primary + ': saved empty chain disables fallback');
      await chain(['fixture/fallback']); await key('');
      await read(primary, false, primary + ': missing fallback credential');
      await key('fixture-router');
      const classes = await read(primary, !operator, primary + ': saved available fallback' + (operator ? ' rejected by managed mismatch' : ''));
      receipts.push({ primary, operator, classes });
    }
    console.log(JSON.stringify({ receipts, generationPosts }));
  } finally { await f.dispose(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const base = 'http://127.0.0.1:' + server.address().port; await scenario(base, false); await scenario(base, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(generationPosts, 0, 'inventory readback performs no paid model call');
})().catch(e => { console.error(e && e.stack || e); server.close(); process.exitCode = 1; });
