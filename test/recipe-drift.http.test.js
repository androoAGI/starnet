/* node test/recipe-drift.http.test.js — GET /api/recipes/drift on the real sidecar (2026-08-22).
   Seeds runs.jsonl before boot with two recipes' histories (one steady, one whose latest run regressed a check and
   changed model), then proves the route computes drift from the durable rows, narrows by recipeId, refuses a bad
   id, and is token-gated like /api/runs. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

const now = Date.now();
let k = 0;
const row = (o) => Object.assign({
  runId: 'r' + (++k), agentId: 'agent', reason: 'done', title: 'Weekly invoice', streamId: 'ws-1', ts: now - (100 - k) * 60000,
  model: 'm1', usd: 0.02, turns: 3,
  toolTrace: [{ callId: 'a', name: 'fs_write' }, { callId: 'b', name: 'mcp__gmail__send_email' }],
  completionEvidence: { schemaVersion: 'starnet.completion-evidence.v1', completionVerdict: 'completed_verified', effectVerdict: 'mechanically_verified', effects: [], evidence: [],
    contract: { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [{ id: 'sop-1', type: 'artifact_exists', path: 'out/a.md' }] },
    checks: [{ id: 'sop-1', type: 'artifact_exists', status: 'passed', code: 'artifact_exists' }] }
}, o || {});

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-drift-http-'));
  const rows = [
    row({ recipeId: 'steady-recipe' }), row({ recipeId: 'steady-recipe' }), row({ recipeId: 'steady-recipe' }),
    row({ recipeId: 'drifting-recipe' }), row({ recipeId: 'drifting-recipe' }), row({ recipeId: 'drifting-recipe' }),
    row({ recipeId: 'drifting-recipe', model: 'm2', completionEvidence: { schemaVersion: 'starnet.completion-evidence.v1', completionVerdict: 'incomplete', effectVerdict: 'judgment_required', effects: [], evidence: [],
      contract: { schemaVersion: 'starnet.task-postconditions.v1', authority: 'commander', requirements: [{ id: 'sop-1', type: 'artifact_exists', path: 'out/a.md' }] },
      checks: [{ id: 'sop-1', type: 'artifact_exists', status: 'failed', code: 'artifact_not_produced_by_run' }] } }),
    row({ recipeId: '' })   // a non-recipe run: ignored
  ];
  fs.writeFileSync(path.join(ws, 'runs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const { child, port } = await boot(await allocatePort(), { SKYNET_WORKSPACES: ws }, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const get = (u, h) => fetch(B + u, { headers: Object.assign({ 'X-StarNet-Token': token, Origin: B }, h || {}) });
    const noTok = await fetch(B + '/api/recipes/drift');
    A.ok(noTok.status === 401 || noTok.status === 403, 'the drift route is token-gated like /api/runs (' + noTok.status + ')');
    const all = await (await get('/api/recipes/drift')).json();
    A.eq(Object.keys(all.drift).sort(), ['drifting-recipe', 'steady-recipe'], 'every recipe with history is assessed; non-recipe rows ignored');
    A.eq(all.drift['steady-recipe'].status, 'steady', 'three clean runs -> steady');
    A.eq(all.drift['steady-recipe'].streak, ['pass', 'pass', 'pass'], 'streak from the durable rows');
    const d = all.drift['drifting-recipe'];
    A.eq(d.status, 'drift', 'the regressed recipe drifted');
    A.eq(d.signals.map(s => s.code).sort(), ['check_regressed', 'model_changed', 'verdict_regressed'], 'all three signals named from the durable rows');
    A.eq(d.baselineRuns, 3, 'baseline is its three good prior runs');
    A.eq(d.latestRunId, 'r7', 'latest run identified');
    const one = await (await get('/api/recipes/drift?recipeId=steady-recipe')).json();
    A.eq(one.recipeId, 'steady-recipe', 'narrowed read echoes the id');
    A.eq(one.drift.status, 'steady', 'narrowed read carries the verdict');
    const none = await (await get('/api/recipes/drift?recipeId=never-ran')).json();
    A.eq(none.drift.status, 'insufficient', 'an unknown recipe is honestly insufficient, never steady');
    const bad = await get('/api/recipes/drift?recipeId=bad%20id!');
    A.eq(bad.status, 400, 'a malformed recipeId is refused');
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('recipe-drift.http');
})().catch(e => { console.log('FAIL: recipe-drift.http threw - ' + (e && e.stack || e)); process.exit(1); });
