/* node test/aux-token-ceiling.e2e.test.js — issue #105, the real sidecar on a FAKE `claude` signed in with a subscription.

   Proves at the live seam: background passes spawn with the CLI's cache switch and the user's run does not; their $0 rows are
   counted in tokens; at the ceiling the passes stop while the user's run still finishes; 0 turns the ceiling off; and the
   setting survives a sidecar restart. No network, no real CLI. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LONG = ('I rebuilt the staging rollback path end to end. Here is the write-up with the reasoning and the follow-ups worth remembering. ').repeat(50);

const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
const at = args.indexOf('--system-prompt-file');
let system = '';
try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}
const main = system.includes('CEILING_E2E_IDENTITY');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ main, cacheOff: process.env.DISABLE_PROMPT_CACHING === '1' }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  const text = main ? ${JSON.stringify(LONG)} : 'nothing durable.';
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } });
});
`;

(async () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-fakeclaude-'));
  const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(fakeRoot, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  const logFile = path.join(fakeRoot, 'calls.log');
  fs.writeFileSync(logFile, '');
  const calls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

  const fixture = SidecarFixture.create({ prefix: 'sk-auxceiling-', env: {
    STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: logFile, STARNET_CLAUDE_CLI_PERSIST: '0', SKYNET_QUEST_REFRESH: '0',
    SKYNET_SKILL_CURATOR: '0', SKYNET_SKILL_REVIEW: '0'
  } });
  // one finished task on a cold agent; resolves once the fire-and-forget passes have gone quiet
  const run = async agentId => {
    const before = calls().length;
    const r = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl },
      body: JSON.stringify({ provider: 'claude-cli', model: 'haiku', agentId, isTask: true, placed: [], system: 'CEILING_E2E_IDENTITY: you are Ada.', messages: [{ role: 'user', content: 'Rebuild the staging rollback path and write up what changed and why.' }] }) });
    const events = (await r.text()).trim().split('\n').map(l => JSON.parse(l));
    let last = -1, since = Date.now();
    for (const until = Date.now() + 8000; Date.now() < until;) {
      const n = calls().length;
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= 1300) break;
      await sleep(150);
    }
    return { reason: (events.findLast(e => e.name === 'agent.run.end') || { payload: {} }).payload.reason, spawned: calls().slice(before) };
  };
  try {
    await fixture.start();
    const cfg = async () => (await fixture.request('/api/memory/config')).json();
    const post = body => fetch(fixture.baseUrl + '/api/memory/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl }, body: JSON.stringify(body) });

    const fresh = await cfg();
    A.eq([fresh.auxTokenCeiling, fresh.defaultAuxTokenCeiling, fresh.auxTokensUsed24h], [200000, 200000, 0], 'the default ceiling, and nothing used yet');

    // under the ceiling: the passes run, cacheless; the user's run keeps its cache
    const a = await run('ceiling-a');
    A.eq(a.reason, 'done', 'the run finished');
    A.ok(a.spawned.some(c => c.main), 'fixture: the user run reached the CLI');
    const passes = a.spawned.filter(c => !c.main);
    A.ok(passes.length >= 1, 'background passes ran (non-vacuous): ' + passes.length);
    A.ok(passes.every(c => c.cacheOff), 'every background pass spawned with the cache switch');
    A.ok(a.spawned.filter(c => c.main).every(c => !c.cacheOff), 'the user run keeps its cache');
    const rows = fs.readFileSync(path.join(fixture.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const auxRows = rows.filter(r => r.aux);
    A.ok(auxRows.length >= 1 && auxRows.every(r => r.subscription === true && r.usd === 0), 'their rows book $0 and name the subscription');
    A.ok(rows.filter(r => !r.aux).every(r => r.subscription !== true), 'a user run row is not an aux row');
    const used = (await cfg()).auxTokensUsed24h;
    A.eq(used, auxRows.reduce((t, r) => t + r.tokens, 0), 'the figure shown is the ledger total of those rows: ' + used);

    // at the ceiling: no pass spawns, and the user's run still finishes
    A.eq((await post({ auxTokenCeiling: 1 })).status, 200, 'the setting saves');
    const b = await run('ceiling-b');
    A.eq(b.reason, 'done', "at the ceiling the user's run still finishes");
    A.ok(b.spawned.some(c => c.main), "and it reached the CLI");
    A.eq(b.spawned.filter(c => !c.main).length, 0, 'no background pass spawned');

    // refused values leave it alone; the setting survives a restart
    for (const bad of [-1, 1.5, 'lots', null]) A.eq((await post({ auxTokenCeiling: bad })).status, 400, 'refused: ' + bad);
    A.eq((await cfg()).auxTokenCeiling, 1, 'a refused value changed nothing');
    await fixture.restart();
    A.eq((await cfg()).auxTokenCeiling, 1, 'the ceiling survives a sidecar restart');
    A.eq((await cfg()).auxTokensUsed24h, used, 'the count survives it too: it is read from the ledger');

    // 0 = off: the same run on a cold agent spends again
    A.eq((await post({ auxTokenCeiling: 0 })).status, 200, '0 saves');
    const c = await run('ceiling-c');
    A.ok(c.spawned.filter(s => !s.main).length >= 1, 'with the ceiling off the passes run again');
  } finally {
    await fixture.dispose();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('aux-token-ceiling.e2e.test');
})().catch(e => { console.log('FAIL: aux-token-ceiling.e2e.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
