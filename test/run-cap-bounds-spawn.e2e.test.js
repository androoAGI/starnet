'use strict';
/* node test/run-cap-bounds-spawn.e2e.test.js — bug d3a76db3: the PER RUN dollar cap does not bound team.spawn workers.

   SETTINGS › SPENDING LIMITS says PER RUN is a "Hard ceiling for a single agent run". With PER RUN at $0.05, one
   Commander request whose lead answered its first turn with team.spawn of 4 clones spent $0.24: the lead $0.08 and
   four workers $0.04 each. Every spawned worker started with its OWN full PER RUN ceiling, and nothing charged
   worker spend against the lead's run, so the lead also took a second paid turn past its cap and ended "done".

   Against the REAL sidecar (child-process boot, hermetic profile) and a mock OpenRouter that bills every model call
   $0.04 (usage.cost), this proves the workers draw from — and are stopped by — the lead run's cap:
     1. PER RUN $0.05: the lead + its workers together spend at most the cap plus ONE in-flight call ($0.09), the
        workers that would have passed it stop with reason 'budget', and the lead stops 'budget' (scope run, $0.05
        cap) instead of paying for another turn. The ledger (/api/budget/status) agrees with the run rows.
     2. PER RUN $1 (room for everything): all four workers run and the lead finishes 'done' — the shared cap never
        refuses work that fits inside it. (This fixture bills every call alike; MIXED call costs — a $0.18 spawning
        turn with $0.02 clones under a $0.50 cap — are proven through the real loop in test/run-spend-pool.test.js.)
   In test/http.list (boots a sidecar). */
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostText } = require('./helpers/host-notes.js');

const CALL_USD = 0.04;   // what every model call costs in this fixture (OpenRouter-style usage.cost)
const CAP_USD = 0.05;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function agentIdFrom(messages) {
  const m = hostText(messages || []).match(/Agent id:\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

function startMock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      return;
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { body = {}; }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const agentId = agentIdFrom(messages);
      const main = Array.isArray(body.tools) && body.tools.length > 0;   // a run turn (an aux pass carries no tools)
      const kind = !main ? 'aux' : agentId === 'agent' ? (messages.some(m => m && m.role === 'tool') ? 'lead+' : 'lead') : (/^sub-/.test(agentId) ? 'worker' : 'other');
      calls.push(kind);
      const usd = (kind === 'aux' || kind === 'other') ? 0 : CALL_USD;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const usage = { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, cost: usd };
      if (kind === 'lead') {
        const tasks = [1, 2, 3, 4].map(i => ({ prompt: 'research part ' + i + ' of the market brief', label: 'part ' + i }));
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'spawn_1', type: 'function', function: { name: 'team_spawn', arguments: JSON.stringify({ tasks }) } }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
      } else {
        const text = kind === 'lead+' ? 'Here is the combined brief.' : kind === 'worker' ? 'Part researched.' : 'ok';
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' })));
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({ prefix: 'starnet-runcap-spawn-', timeoutMs: 30000, env: {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_BUDGET_PER_RUN: String(CAP_USD), STARNET_BUDGET_PER_RUN: String(CAP_USD),
    SKYNET_BUDGET_PER_WORKER: '', STARNET_BUDGET_PER_WORKER: '',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1',   // team.spawn is consent-gated; this run is headless
    SKYNET_AUX_BUDGET: '0', SKYNET_QUEST_REFRESH: '0'
  } });
  // never let the sidecar resolve the real user profile (the fixture leaves USERPROFILE alone on Windows)
  fixture.env.USERPROFILE = fixture.profile; fixture.env.HOME = fixture.profile;
  const run = async (label) => {
    mock.calls.length = 0;
    const r = await fixture.json('POST', '/api/run', { key: 'sk-or-v1-runcap-fake', model: 'test/model', agentId: 'agent', isTask: true,
      messages: [{ role: 'user', content: 'split the market brief into four parts and research them in parallel (' + label + ')' }] });
    assert.equal(r.status, 200, label + ': /api/run streamed');
    const events = r.text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    // let the spawned workers' run rows and the ledger settle
    for (let i = 0; i < 40 && events.filter(e => e.name === 'agent.run.end' && /^sub-/.test(e.payload.agentId || '')).length < 4; i++) await sleep(50);
    const ends = events.filter(e => e.name === 'agent.run.end');
    const lead = ends.filter(e => e.payload.agentId === 'agent').at(-1);
    const workers = ends.filter(e => /^sub-/.test(e.payload.agentId || ''));
    assert.ok(lead, label + ': the lead run ended with a terminal event\n' + r.text.slice(-2000));
    const sum = ends.filter(e => e.payload.agentId === 'agent' || /^sub-/.test(e.payload.agentId || '')).reduce((t, e) => t + (Number(e.payload.usd) || 0), 0);
    console.log('  ' + label + ': lead=' + lead.payload.reason + (lead.payload.budgetScope ? '/' + lead.payload.budgetScope + ' cap=' + lead.payload.budgetCapUsd : '') + ' $' + lead.payload.usd
      + ' workers=[' + workers.map(w => w.payload.reason + ' $' + w.payload.usd).join(', ') + '] total=$' + sum.toFixed(4) + ' calls=' + JSON.stringify(mock.calls));
    return { lead: lead.payload, workers: workers.map(w => w.payload), sum, calls: mock.calls.slice(), events };
  };
  try {
    await fixture.start();

    // ---- 1. a $0.05 PER RUN cap bounds the lead AND every worker it spawns ----
    const r1 = await run('cap-0.05');
    assert.ok(r1.calls.includes('lead'), 'the lead made its spawning turn');
    assert.ok(r1.events.some(e => e.name === 'agent.tool_call' && /^team[._]spawn$/.test((e.payload && e.payload.name) || '')), 'the lead called team.spawn');
    assert.ok(r1.sum <= CAP_USD + CALL_USD + 1e-9, 'the lead and its workers together spend at most the cap plus one in-flight call: $' + r1.sum.toFixed(4) + ' (was $0.24)');
    assert.ok(r1.calls.filter(k => k === 'worker').length <= 1, 'only the worker call the cap had room for was made: ' + JSON.stringify(r1.calls));
    assert.ok(!r1.calls.includes('lead+'), 'the lead paid for no further turn once its run cap was spent: ' + JSON.stringify(r1.calls));
    assert.equal(r1.lead.reason, 'budget', 'the lead stops at its PER RUN cap, not "done" past it (got ' + r1.lead.reason + ')');
    assert.equal(r1.lead.budgetScope, 'run', 'the stop names the per-RUN cap');
    assert.equal(r1.lead.budgetCapUsd, CAP_USD, 'the stop carries the $0.05 cap the Commander set');
    assert.ok(r1.workers.some(w => w.reason === 'budget'), 'the workers past the cap stop with reason budget: ' + JSON.stringify(r1.workers.map(w => w.reason)));
    assert.ok(r1.workers.filter(w => w.reason === 'budget').every(w => w.budgetScope === 'run' && w.budgetCapUsd === CAP_USD), 'a stopped worker names the lead run\'s $0.05 cap');
    const st = await fixture.json('GET', '/api/budget/status');
    const dayUsd = st.body && st.body.day && st.body.day.usd;
    assert.ok(typeof dayUsd === 'number' && dayUsd <= CAP_USD + CALL_USD + 1e-9, 'the ledger agrees: today\'s spend $' + dayUsd + ' stays within the cap plus one call');

    // ---- 2. a cap with room for everything never refuses the work ----
    // $0.05 -> $1 raises the PER RUN limit, so it is confirmed at the desk (GHSA-2hpj spend routes)
    const asked = await fixture.json('POST', '/api/budget/caps', { perRun: 1 });
    assert.deepEqual([asked.status, asked.body && asked.body.code], [403, 'desk_confirm_required'], 'raising the per-run cap to $1 asks the desk first');
    const save = await fixture.deskJson('POST', '/api/budget/caps', { perRun: 1 });
    assert.equal(save.status, 200, 'saving a $1 per-run cap succeeds once it is confirmed');
    const r2 = await run('cap-1');
    assert.equal(r2.workers.length, 4, 'all four workers ran');
    assert.ok(r2.workers.every(w => w.reason === 'done'), 'every worker finished: ' + JSON.stringify(r2.workers.map(w => w.reason)));
    assert.equal(r2.lead.reason, 'done', 'the lead finished its synthesis turn');
    assert.ok(r2.calls.includes('lead+'), 'the lead took its synthesis turn');
    assert.ok(Math.abs(r2.sum - 6 * CALL_USD) < 1e-9, 'the family spent exactly its six calls: $' + r2.sum.toFixed(4));
    console.log('run-cap-bounds-spawn: OK — a $0.05 run cap bounds team.spawn workers; a roomy cap runs them all');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output tail ---\n' + String(fixture.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await fixture.dispose();
    mock.server.closeAllConnections();
    await new Promise(r => mock.server.close(r));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
