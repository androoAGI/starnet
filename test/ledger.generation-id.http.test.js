/* Real sidecar + fake provider transport: main and one-shot receipts persist exact provider IDs across restart.
   No live provider/network and no fabricated IDs for rows whose upstream supplied none. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const IPC = 'generation-receipt-fixture-token-0123456789';
const calls = [];
const draft = { starter: 'research_line', name: 'Trip Planner', steps: { RESEARCHER: 'Find the facts.', WRITER: 'Write the plan.' }, job: 'Plan a trip' };
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'receipt/model', context_length: 128000, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } }] })); return; }
    const body = JSON.parse(raw);
    const kind = raw.includes('You set up a work line for someone') ? 'oneshot' : 'run';
    const id = 'gen-http-' + (calls.length + 1); calls.push({ kind, id });
    const priorTool = (body.messages || []).some(m => m.role === 'tool');
    const first = kind === 'run' && !priorTool;
    const send = x => res.write('data: ' + JSON.stringify(x) + '\n\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // ID arrives before usage, as it does on real SSE. Subsequent chunks can omit it.
    send({ id, choices: [{ delta: {} }] });
    const delta = first ? { tool_calls: [{ index: 0, id: 'receipt-tool', type: 'function', function: { name: 'recall_conversation', arguments: '{"query":"receipt fixture"}' } }] }
      : { content: kind === 'oneshot' ? JSON.stringify(draft) : 'The receipt fixture is complete. No files changed.' };
    send({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.01 } });
    res.end('data: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const f = SidecarFixture.create({ prefix: 'generation-receipt-', env: {
    STARNET_IPC_TOKEN: IPC, STARNET_DEFAULT_MODEL: 'receipt/model', STARNET_OPENROUTER_BASE: base,
    STARNET_OPENROUTER_KEY: 'fixture', STARNET_BUDGET_PER_DAY: '0', STARNET_LIVE_PRICES: '0',
    STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_QUEST_REFRESH: '0',
    STARNET_THREAD_MINE: '0', STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', STARNET_SCOUT: '0', STARNET_CRON_ENABLED: '0'
  } });
  const rows = () => fs.readFileSync(path.join(f.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  // Permit only loopback fake transport. No real credential or remote endpoint can escape this fixture.
  const entry = path.join(f.workspace, 'receipt-boot.cjs');
  fs.writeFileSync(entry, "const real = globalThis.fetch; globalThis.fetch = function(url) { const u = new URL(String((url && url.url) || url)); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? real.apply(this, arguments) : Promise.reject(new Error('receipt fixture: remote transport refused')); };\nrequire(" + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ");\n");
  f.entry = entry;
  let runId, before;
  try {
    await f.start();
    const now = Date.now();
    const saved = await f.json('POST', '/api/save', { schema: 'starnet.save', version: 6, updatedAt: now,
      _saveRevision: 0, _saveDirty: true, _saveClient: 'generation-receipt-test', agent: { id: 'agent', name: 'NOVA', createdAt: now },
      agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    A.eq([saved.status, saved.body && saved.body.ok], [200, true], 'station save accepted before roster');
    A.eq((await f.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'openrouter', key: 'fixture', baseUrl: base }) })).status, 200, 'station provider points to fake');
    A.eq((await f.json('POST', '/api/roster', { updatedAt: now, agents: [{ agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: 'receipt/model' }] })).status, 200, 'station model set');
    const ran = await f.json('POST', '/api/run', { agentId: 'agent', provider: 'openrouter', model: 'receipt/model', key: 'fixture', streamId: 'receipt-run',
      messages: [{ role: 'user', content: 'Look up receipt fixture once, then report completion.' }] });
    A.eq(ran.status, 200, 'real run accepted');
    const events = String(ran.text).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const started = events.find(e => e.name === 'agent.run.start'); runId = started && started.payload.runId;
    A.ok(!!runId, 'run received host ID');
    A.eq((events.filter(e => e.name === 'agent.run.end').pop() || {}).payload.reason, 'done', 'real two-call run finishes');
    const main = rows().find(r => r.runId === runId && !r.aux);
    const mainIds = calls.filter(c => c.kind === 'run').map(c => c.id);
    A.eq(mainIds.length, 2, 'transport observed two paid attempts');
    A.eq(main && main.generationIds, mainIds, 'main durable ledger preserves exact transport IDs in order');
    A.eq(main && main.generationCount, 2, 'main receipt counts two identified calls');
    A.eq(main && main.usd, 0.02, 'main dollars unchanged');
    A.ok(main && main.usageMissing !== true, 'complete usage remains known');
    const drafted = await f.json('POST', '/api/routing/line-draft', { want: 'a line that plans trips', starters: [{ id: 'research_line', name: 'Research', purpose: 'find and write', roles: ['RESEARCHER', 'WRITER'] }] });
    A.eq([drafted.status, drafted.body && drafted.body.starter], [200, 'research_line'], 'real station one-shot returns its draft');
    const aux = rows().filter(r => /^oneshot-/.test(r.aux || '')).pop();
    A.eq(aux && aux.generationIds, calls.filter(c => c.kind === 'oneshot').map(c => c.id), 'one-shot durable row carries received ID');
    A.eq(aux && aux.generationCount, 1, 'one-shot identified-call count');
    A.eq(aux && aux.usd, 0.01, 'one-shot charge unchanged');
    before = fs.readFileSync(path.join(f.workspace, 'ledger.jsonl'), 'utf8');
    await f.stop(); await f.start();
    A.eq(fs.readFileSync(path.join(f.workspace, 'ledger.jsonl'), 'utf8'), before, 'restart leaves immutable ledger bytes unchanged');
    A.eq(rows().find(r => r.runId === runId && !r.aux).generationIds, mainIds, 'restart preserves provider reconciliation handles');
  } finally { await f.dispose(); await new Promise(resolve => server.close(resolve)); }
  A.report('ledger.generation-id.http.test');
})().catch(e => { console.error(e.stack || e); server.close(); process.exit(1); });
