/* node test/subscription-token-apikey.e2e.test.js — the subscription usage limit never binds a BILLED Claude Code
   sign-in (review finding, 2026-10-11).

   The claude-cli adapter serves both a Claude subscription (books $0) and an API key (books the CLI's own $). The
   daily weighted-token pool exists for the first; an API-key run is governed by the $ caps it really spends against.
   Boots the real sidecar with a FAKE `claude` whose sign-in is switched by a mode file: 'sub' answers as a
   subscription (init apiKeySource 'none', total_cost_usd 0, `auth status` with a subscriptionType) and 'apikey' as an
   API key (apiKeySource 'ANTHROPIC_API_KEY', total_cost_usd 0.05, `auth status` authMethod 'api_key'). Every spawn
   is logged as main (the first spawn naming a run's marker) or aux (a post-run pass).

   Proves: subscription runs trip a 15,000 pool; once the sign-in is an API key (proven by `claude auth status`), a
   run on the SAME provider is not blocked and its post-run passes run; a booking billed in $ keeps the lane billed;
   when the sign-in is a subscription again, the pool binds again without a spawn. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const FAKE_CLI = String.raw`'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const mode = String(fs.readFileSync(process.env.FAKE_CLAUDE_MODE, 'utf8')).trim();
const log = line => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, line + '\n');
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
if (args[0] === 'auth') {
  if (args[1] === 'status') out(mode === 'apikey' ? { loggedIn: true, authMethod: 'api_key' } : { loggedIn: true, authMethod: 'claude.ai', email: 'sub@example.test', subscriptionType: 'max' });
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const marker = (input.match(/TOKKEY-[A-Z0-9]+/) || ['other'])[0];
  // the run's own call is the FIRST spawn naming its marker; a post-run pass re-reads the conversation afterwards
  const main = marker !== 'other' && !fs.readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\n').some(l => l.endsWith(' ' + marker));
  log((main ? 'main ' : 'aux ') + mode + ' ' + marker);
  out({ type: 'system', subtype: 'init', apiKeySource: mode === 'apikey' ? 'ANTHROPIC_API_KEY' : 'none', tools: [] });
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 500 };
  out({ type: 'stream_event', event: { type: 'message_start', message: { usage } } });
  const text = main && /LONG/.test(marker)
    ? ('I dug through the deploy pipeline and rebuilt the staging rollback path end to end. Here is the substantive write-up with the reasoning, the tradeoffs, and the follow-ups worth remembering. ').repeat(40)
    : 'ok, done.';
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', usage, total_cost_usd: mode === 'apikey' ? 0.05 : 0 });
});
`;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-tokkey-cli-'));
  const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  fs.writeFileSync(path.join(fakeRoot, 'claude.cmd'), '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside it
  const logFile = path.join(fakeRoot, 'calls.log'), modeFile = path.join(fakeRoot, 'mode.txt');
  fs.writeFileSync(logFile, ''); fs.writeFileSync(modeFile, 'sub');
  const setMode = m => fs.writeFileSync(modeFile, m);
  const fixture = SidecarFixture.create({ prefix: 'starnet-tokkey-', timeoutMs: 30000, env: {
    STARNET_CLAUDE_BIN: path.join(fakeRoot, 'claude.cmd'), FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_MODE: modeFile,
    SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_CURATOR: '0'   // every other post-run pass stays on: the API-key run must still get them
  } });
  const spawns = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  const settle = async () => {   // post-run passes are fire-and-forget: wait until the spawn log is quiet
    let n = -1;
    for (let i = 0; i < 40; i++) { const m = spawns().length; if (m === n) return m; n = m; await wait(1000); }
    return spawns().length;
  };
  const run = async (marker, isTask) => {
    const r = await fixture.json('POST', '/api/run', { provider: 'claude-cli', model: 'sonnet', agentId: 'tokkey-e2e', isTask: !!isTask,
      messages: [{ role: 'user', content: 'Please write it up. ' + marker }] });
    A.eq(r.status, 200, marker + ' streams through the real /api/run route');
    const evs = String(r.text).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const end = evs.filter(e => e && e.name === 'agent.run.end').pop();
    return (end && end.payload) || {};
  };
  const status = async () => (await fixture.json('GET', '/api/budget/status')).body;
  try {
    await fixture.start();
    A.eq((await fixture.json('POST', '/api/budget/caps', { perDayTokens: 15000 })).status, 200, 'daily usage limit 15,000 saved');

    // ---- subscription use trips the pool ----
    A.eq((await run('TOKKEY-SUBA')).reason, 'done', 'subscription run 1 completes');
    A.eq((await run('TOKKEY-SUBB')).reason, 'done', 'subscription run 2 completes (21,000 weighted now)');
    await settle();
    let before = spawns().length;
    const blocked = await run('TOKKEY-SUBC');
    A.eq([blocked.reason, blocked.budgetScope, blocked.budgetUnit], ['budget', 'day', 'tokens'], 'the pool is tripped for subscription use');
    A.eq(spawns().length, before, 'without a CLI call');
    A.eq((await status()).tokenPool.tripped, true, 'status: tripped');

    // ---- the sign-in becomes an API key: the same provider is NOT blocked, and its post-run passes run ----
    setMode('apikey');
    const auth = (await fixture.json('GET', '/api/auth/claude-cli/status')).body;
    A.eq([auth.loggedIn, auth.authMethod], [true, 'api_key'], 'claude auth status reports the API-key sign-in');
    before = spawns().length;
    const billed = await run('TOKKEY-LONGKEY', true);
    A.eq(billed.reason, 'done', 'an API-key run on claude-cli is not stopped by the subscription pool');
    A.eq(billed.budgetUnit, undefined, 'and carries no token stop');
    await settle();
    const after = spawns().slice(before);
    A.eq(after.filter(l => l === 'main apikey TOKKEY-LONGKEY').length, 1, 'its model call ran: ' + JSON.stringify(after));
    A.ok(after.filter(l => /^aux apikey /.test(l)).length > 0, 'and its post-run passes ran (aux spawns: ' + after.filter(l => /^aux /.test(l)).length + ')');
    const st = await status();
    A.ok(st.spentToday > 0, 'the API-key run was billed in $ (spentToday ' + st.spentToday + ')');
    A.eq((await run('TOKKEY-KEYAGAIN')).reason, 'done', 'a $-billed booking keeps the lane billed: the next API-key run proceeds too');

    // ---- back on the subscription: the pool binds again, with no spawn ----
    setMode('sub');
    A.eq((await fixture.json('GET', '/api/auth/claude-cli/status')).body.subscription, 'max', 'claude auth status reports the subscription again');
    await settle();
    before = spawns().length;
    const again = await run('TOKKEY-SUBD');
    A.eq([again.reason, again.budgetScope, again.budgetUnit], ['budget', 'day', 'tokens'], 'the subscription is governed by the pool again');
    A.eq(spawns().length, before, 'without a CLI call');
  } finally {
    await fixture.dispose();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('subscription-token-apikey.e2e.test');
})().catch((error) => {
  console.log('FAIL: subscription-token-apikey.e2e.test threw - ' + (error && error.stack || error));
  process.exit(1);
});
