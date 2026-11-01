/* node test/live.smoke.js — THE live end-to-end smoke test (real OpenRouter spend, a few ¢ at most).
   This is the one check headless tests cannot do: it proves the real wire works end to end.

   What it does (boots its OWN sidecar on an ephemeral port + isolated temp workspace, so it's one command):
     1. POST /api/run twice with the SAME large stable system prefix and a trivial task ("reply ACK").
     2. Parses the real NDJSON agent.* event stream and asserts: run.start -> token(s) -> agent.cost
        (reconciled, real usd) -> run.end{reason:done}.
     3. PROMPT CACHING proof: on the 2nd call the system prefix should be a cache HIT -> usage.cachedTokens > 0.
        (Anthropic only caches a prefix >= ~1024 tokens, so the system prompt below is deliberately padded.)
     4. LEDGER + BUDGET proof: GET /api/budget/status before/after shows runs += 2 and the day/global pools
        advanced by ~the spend.

   Requires a real key in the environment (the secret never touches the repo or a flag):
     PowerShell:  $env:SKYNET_OPENROUTER_KEY="sk-or-v1-..."; node test/live.smoke.js
     bash:        SKYNET_OPENROUTER_KEY="sk-or-v1-..." node test/live.smoke.js
   Optional:  SKYNET_SMOKE_MODEL (default anthropic/claude-sonnet-4.6 — live + caching-capable). */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const KEY = process.env.SKYNET_OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.SKYNET_SMOKE_MODEL
  || process.env.STARNET_SMOKE_MODEL
  || process.env.SKYNET_DEFAULT_MODEL
  || process.env.STARNET_DEFAULT_MODEL
  || 'anthropic/claude-sonnet-4.6';
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a deliberately LARGE, byte-stable system prefix so Anthropic actually caches it. The per-model minimum runs up
// to 4096 tokens (Opus 4.6/4.5, Haiku 4.5), so pad well past that (~6k+ tokens) — below the floor Anthropic runs
// the request UNCACHED with no error, which would make the cache assertion a false negative.
const BIG_SYSTEM = ('You are a meticulous operations assistant aboard a space station. ' +
  'Follow instructions exactly and answer with extreme concision. ').repeat(260);

function boot(port, ws, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, { SKYNET_PORT: String(port), SKYNET_WORKSPACES: ws }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {} attemptsLeft > 0 ? resolve(allocatePort().then(next => boot(next, ws, attemptsLeft - 1))) : reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout')); } }, 9000);
  });
}

// POST /api/run and fold the NDJSON event stream into a compact summary.
async function run(B, body, apiToken) {
  const res = await fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': apiToken }, body: JSON.stringify(body) });
  const text = await res.text();
  const evs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const names = evs.map(e => e.name);
  const cost = evs.filter(e => e.name === 'agent.cost').map(e => e.payload);
  const end = (evs.find(e => e.name === 'agent.run.end') || {}).payload || {};
  const errs = evs.filter(e => e.name === 'agent.run.error').map(e => e.payload && e.payload.message);
  const tokens = evs.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
  return { status: res.status, names, cost, end, errs, tokens };
}

(async () => {
  if (!KEY) { console.log('SKIP: set SKYNET_OPENROUTER_KEY to run the live smoke test (a few ¢ of real spend).'); process.exit(2); }
  console.log('live.smoke — model ' + MODEL + '\n');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-live-'));
  const { child, port } = await boot(await allocatePort(), ws, 20);
  const B = 'http://' + HOST + ':' + port;
  const apiToken = await bootToken(B, B);
  const get = async p => { const r = await fetch(B + p, { headers: { 'X-StarNet-Token': apiToken, Origin: B } }); return r.json(); };
  const body = { key: KEY, model: MODEL, system: BIG_SYSTEM, messages: [{ role: 'user', content: 'Reply with exactly one word: ACK' }], isTask: false };

  try {
    const before = await get('/api/budget/status');

    console.log('RUN 1 (cold — writes the cache):');
    const r1 = await run(B, body, apiToken);
    if (r1.errs.length) console.log('  run1 error(s): ' + r1.errs.join(' | '));
    ok(r1.names.includes('agent.run.start'), 'run1 emitted agent.run.start');
    ok(r1.names.includes('agent.cost'), 'run1 emitted a reconciled agent.cost');
    ok(r1.end.reason === 'done', 'run1 ended with reason "done" (got: ' + r1.end.reason + ')');
    const c1 = r1.cost[r1.cost.length - 1] || {};
    ok((c1.usd || 0) > 0, 'run1 reported real billed usd > 0 (got $' + (c1.usd || 0) + ')');
    ok((c1.tokensIn || 0) > 0, 'run1 reported prompt tokensIn > 0 (got ' + (c1.tokensIn || 0) + ')');
    console.log('    tokensIn=' + c1.tokensIn + ' tokensOut=' + c1.tokensOut + ' cached=' + (c1.cachedTokens || 0) + ' usd=$' + c1.usd);

    await sleep(800);
    console.log('RUN 2 (warm — should HIT the cache):');
    const r2 = await run(B, body, apiToken);
    if (r2.errs.length) console.log('  run2 error(s): ' + r2.errs.join(' | '));
    ok(r2.end.reason === 'done', 'run2 ended with reason "done"');
    const c2 = r2.cost[r2.cost.length - 1] || {};
    console.log('    tokensIn=' + c2.tokensIn + ' tokensOut=' + c2.tokensOut + ' cached=' + (c2.cachedTokens || 0) + ' usd=$' + c2.usd);
    ok((c2.cachedTokens || 0) > 0, 'PROMPT CACHING WORKS: run2 cachedTokens > 0 (got ' + (c2.cachedTokens || 0) + ')');

    const after = await get('/api/budget/status');
    ok(after.runs >= before.runs + 2, 'ledger recorded both runs (runs ' + before.runs + ' -> ' + after.runs + ')');
    ok(after.totalUsd > before.totalUsd, 'global spend advanced ($' + before.totalUsd.toFixed(6) + ' -> $' + after.totalUsd.toFixed(6) + ')');
    ok(after.day.usd > before.day.usd, 'day pool advanced by the spend');
  } catch (e) {
    fail++; console.log('  ✗ FAIL: live smoke threw — ' + (e && e.message || e));
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\nlive.smoke: ' + (fail ? (fail + ' problem(s), ' + pass + ' ok') : ('ALL GREEN (' + pass + ' checks)')));
  process.exit(fail ? 1 : 0);
})();
