/* node test/subscription-token-pool.e2e.test.js — the SUBSCRIPTION usage limit, end to end (2026-10-11).

   A Claude Code subscription run books $0, so before this lane every $ guard (the day/agent/global pools, the per-run
   cap, the aux-pass caps) and the unpriced-token seatbelt were blind to it: background use was unbounded. Boots the real
   sidecar with STARNET_CLAUDE_BIN pointing at a FAKE `claude` (the subscription-stacking pattern: an npm-style .cmd shim
   beside node_modules/@anthropic-ai/claude-code/cli.js). The fake signs in as a subscription (init apiKeySource 'none')
   and every turn reports 1,000 uncached + 2,000 cache-write + 30,000 cache-read input and 500 output tokens
   = 10,500 WEIGHTED tokens. Every spawn is logged.

   Proves, through the real routes: a bad limit is refused (400); a saved daily limit of 15,000 lets runs through while
   under it, /api/budget/status reports the weighted use as an estimate, and the run that finds the pool reached ends
   'budget' / scope 'day' / budgetUnit 'tokens' / budgetCapTokens 15,000 WITHOUT spawning the CLI (and no post-run pass
   spawns either); RESUME { scope:'dayTokens' } lets the next run proceed; 0 turns the limit off; a restart keeps the
   saved limit and the ledger's tokens; and the per-run ceiling (SKYNET_MAX_UNBILLED_TOKENS, or a saved perRunTokens that wins over it, applied live) stops a
   looping run. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const FAKE_CLI = String.raw`'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const logFile = process.env.FAKE_CLAUDE_LOG;
const log = line => fs.appendFileSync(logFile, line + '\n');
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
if (args[0] === 'auth') {
  if (args[1] === 'status') out({ loggedIn: true, authMethod: 'claude.ai', email: 'sub@example.test', subscriptionType: 'max' });
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const marker = (input.match(/TOKPOOL-[A-Z0-9]+/) || ['other'])[0];
  log('spawn ' + marker);
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 500 };
  out({ type: 'stream_event', event: { type: 'message_start', message: { usage } } });
  const text = /LOOP/.test(marker)
    ? 'checking <tool_call>{"name":"station_inspect","arguments":{}}</tool_call>'
    : 'answered ' + marker;
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', usage, total_cost_usd: 0 });
});
`;
const PER_TURN = 1000 + 2 * 2000 + 0.1 * 30000 + 5 * 500;   // 10,500

function makeFakeClaude(root) {
  const pkg = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(root, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  return shim;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-tokpool-cli-'));
  const logFile = path.join(fakeRoot, 'calls.log');
  fs.writeFileSync(logFile, '');
  const fixture = SidecarFixture.create({ prefix: 'starnet-tokpool-', timeoutMs: 30000, env: {
    STARNET_CLAUDE_BIN: makeFakeClaude(fakeRoot), FAKE_CLAUDE_LOG: logFile,
    SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SCOUT: '0', SKYNET_THREAD_MINE: '0',
    SKYNET_MAX_UNBILLED_TOKENS: '15000'   // the per-run ceiling: one turn (10,500) passes, a second crosses it
  } });
  const spawns = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  const run = async (marker, extra) => {
    const r = await fixture.json('POST', '/api/run', Object.assign({ provider: 'claude-cli', model: 'sonnet', agentId: 'tokpool-e2e', internal: true, isTask: false,
      messages: [{ role: 'user', content: 'Say hi. ' + marker }] }, extra || {}));
    A.eq(r.status, 200, marker + ' streams through the real /api/run route');
    const evs = String(r.text).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const end = evs.filter(e => e && e.name === 'agent.run.end').pop();
    return (end && end.payload) || {};
  };
  const status = async () => (await fixture.json('GET', '/api/budget/status')).body;
  const caps = async (body) => fixture.json('POST', '/api/budget/caps', body);
  try {
    await fixture.start();

    // ---- the pool ships OFF; status says what it is ----
    let st = await status();
    A.ok(st.tokenPool && st.tokenPool.estimate === true, 'status carries tokenPool, labelled an estimate');
    A.eq([st.tokenPool.perDayTokens, st.tokenPool.envDefault, st.tokenPool.window, st.tokenPool.perRunTokens], [0, 0, 'rolling-24h', 15000], 'off by default; rolling 24 h; the per-run ceiling is reported (from SKYNET_MAX_UNBILLED_TOKENS)');
    A.eq([st.tokenPool.lane, st.tokenPool.envDefaults], [true, { perDayTokens: 0, perRunTokens: 15000 }], 'Claude Code is present, so the row shows; env defaults are reported');
    A.eq(st.tokenPool.weights, { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 }, 'the weights are published with the figure');

    // ---- validation: bad patches are refused, nothing half-applies ----
    A.eq((await caps({ perDayTokens: -5 })).status, 400, 'a negative limit is refused');
    A.eq((await caps({ perDayTokens: 1.5 })).status, 400, 'a fractional limit is refused');
    A.eq((await caps({ perDayTokens: 'lots' })).status, 400, 'a non-number is refused');
    A.eq((await caps({})).status, 400, 'an empty body still answers the "no cap fields" 400');
    const mixed = await caps({ perDayTokens: 15000, perRun: -1 });
    A.eq(mixed.status, 400, 'a bad $ value refuses the whole body');
    A.eq((await status()).tokenPool.perDayTokens, 0, '...and the token half was NOT applied');

    // ---- set the daily limit ----
    const set = await caps({ perDayTokens: 15000 });
    A.eq(set.status, 200, 'perDayTokens 15000 saves');
    A.eq([set.body.tokenPool.perDayTokens, set.body.tokenPool.saved], [15000, { perDayTokens: 15000 }], 'the echo shows the saved limit');
    A.eq(set.body.caps.perDay, 25, 'the $ caps are untouched by a token-only save');
    A.ok(fs.existsSync(path.join(fixture.workspace, 'budget-tokens.json')), 'persisted in its own protected file');

    // ---- run 1 + run 2 proceed while under the limit ----
    const r1 = await run('TOKPOOL-ONE');
    A.eq(r1.reason, 'done', 'run 1 completes under the limit');
    A.eq(spawns().filter(l => l === 'spawn TOKPOOL-ONE').length, 1, 'run 1 made one CLI call');
    st = await status();
    A.ok(st.tokenPool.usedToday >= PER_TURN, 'status reports the weighted use (>= 10,500): ' + st.tokenPool.usedToday);
    A.eq(st.tokenPool.tripped, false, 'not tripped yet');
    A.eq(st.spentToday, 0, 'and the $ ledger still says $0 — the subscription billed nothing');
    const ledgerRows = fs.readFileSync(path.join(fixture.workspace, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    A.ok(ledgerRows.some(r => r.runId && r.weightedTokens === PER_TURN && r.usd === 0), 'the run\'s ledger row carries weightedTokens');

    // keep running until the pool is reached (run 2 takes it to 21,000 with aux passes off)
    let blocked = null, blockedMarker = '';
    for (let i = 2; i <= 4 && !blocked; i++) {
      const marker = 'TOKPOOL-R' + i;
      const before = spawns().length;
      const end = await run(marker);
      if (end.reason === 'budget') { blocked = end; blockedMarker = marker; A.eq(spawns().length, before, 'the blocked run spawned nothing'); }
      else A.eq(end.reason, 'done', marker + ' completes while under the limit');
    }
    A.ok(blocked, 'a later run finds the pool reached');
    A.eq(blockedMarker, 'TOKPOOL-R3', 'it is the third run (10,500 + 10,500 >= 15,000)');
    A.eq([blocked.reason, blocked.budgetScope, blocked.budgetUnit, blocked.budgetCapTokens], ['budget', 'day', 'tokens', 15000], 'it ends budget / day / tokens at the 15,000 cap');
    A.ok(blocked.budgetTokens >= 15000, 'and names the weighted use: ' + blocked.budgetTokens);
    A.eq(blocked.budgetCapUsd, undefined, 'no $ figure is claimed for a token stop');
    const settled = spawns().length;
    await wait(1500);   // post-run passes are fire-and-forget: give any that would have fired the time to spawn
    A.eq(spawns().length, settled, 'no post-run pass spawned after the pool was reached');
    st = await status();
    A.eq([st.tokenPool.tripped, st.tokenPool.resumable, st.tokenPool.cap], [true, true, 15000], 'status says the pool is tripped and resumable');

    // ---- RESUME grants session headroom ----
    const resumed = await fixture.json('POST', '/api/budget/resume', { scope: 'dayTokens' });
    A.eq([resumed.status, resumed.body.resumed, resumed.body.cap], [200, 'dayTokens', 30000], 'resume dayTokens grants one more base limit');
    const r4 = await run('TOKPOOL-AFTERRESUME');
    A.eq(r4.reason, 'done', 'the next run proceeds after RESUME');
    A.eq(spawns().filter(l => l === 'spawn TOKPOOL-AFTERRESUME').length, 1, 'and called the CLI');

    // ---- 0 = off ----
    A.eq((await caps({ perDayTokens: 0 })).status, 200, 'perDayTokens 0 saves');
    st = await status();
    A.eq([st.tokenPool.perDayTokens, st.tokenPool.cap, st.tokenPool.tripped], [0, 0, false], 'the pool is off');
    A.eq((await run('TOKPOOL-UNLIMITED')).reason, 'done', 'an off pool never stops a run');
    A.eq((await fixture.json('POST', '/api/budget/resume', { scope: 'dayTokens' })).status, 409, 'resuming an off pool is a 409');

    // ---- the per-run ceiling stops a looping run (SKYNET_MAX_UNBILLED_TOKENS=15000) ----
    const loop = await run('TOKPOOL-LOOP', { isTask: true });
    A.eq([loop.reason, loop.budgetScope, loop.budgetUnit, loop.budgetCapTokens], ['budget', 'run', 'tokens', 15000], 'a looping subscription run ends budget / run / tokens at the per-run ceiling');
    A.eq(spawns().filter(l => l === 'spawn TOKPOOL-LOOP').length, 2, 'it stopped before a third CLI call (21,000 >= 15,000)');
    // a SAVED per-run ceiling beats the env default and applies to the next run without a restart
    const perRun = await caps({ perRunTokens: 40000 });
    A.eq([perRun.status, perRun.body.tokenPool.perRunTokens, perRun.body.tokenPool.saved.perRunTokens], [200, 40000, 40000], 'perRunTokens 40000 saves and reads back');
    const loop2 = await run('TOKPOOL-LOOPB', { isTask: true });
    A.eq([loop2.reason, loop2.budgetScope, loop2.budgetUnit, loop2.budgetCapTokens], ['budget', 'run', 'tokens', 40000], 'the next looping run stops at the saved ceiling');
    A.eq(spawns().filter(l => l === 'spawn TOKPOOL-LOOPB').length, 4, 'after four CLI calls (42,000 >= 40,000)');
    A.eq((await caps({ perRunTokens: null })).body.tokenPool.perRunTokens, 15000, 'clearing it falls back to the env default');

    // ---- restart keeps the saved limit and the ledger's tokens ----
    A.eq((await caps({ perDayTokens: 15000 })).status, 200, 're-save 15000 before the restart');
    const usedBefore = (await status()).tokenPool.usedToday;
    await fixture.restart();
    st = await status();
    A.eq([st.tokenPool.perDayTokens, st.tokenPool.saved], [15000, { perDayTokens: 15000 }], 'the saved limit survives a restart');
    A.ok(st.tokenPool.usedToday >= usedBefore && usedBefore >= 4 * PER_TURN, 'the ledger\'s weighted tokens survive a restart: ' + usedBefore + ' -> ' + st.tokenPool.usedToday);
    A.eq(st.tokenPool.tripped, true, 'RESUME headroom was session-only: the pool reads tripped again');
    const before = spawns().length;
    const again = await run('TOKPOOL-AFTERRESTART');
    A.eq([again.reason, again.budgetScope, again.budgetUnit], ['budget', 'day', 'tokens'], 'after the restart the limit still binds');
    A.eq(spawns().length, before, 'without a CLI call');
  } finally {
    await fixture.dispose();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('subscription-token-pool.e2e.test');
})().catch((error) => {
  console.log('FAIL: subscription-token-pool.e2e.test threw - ' + (error && error.stack || error));
  process.exit(1);
});
