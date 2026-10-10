/* node test/subscription-stacking.e2e.test.js — Claude Code subscription stacking, end to end.

   Boots the real sidecar with STARNET_CLAUDE_BIN pointing at a FAKE `claude` (an npm-style .cmd shim beside
   node_modules/@anthropic-ai/claude-code/cli.js, which claude-cli.js runs as `node cli.js`). The fake answers
   by CLI identity: the default sign-in (no CLAUDE_CONFIG_DIR) is out of allowance — the CLI's real
   `error:"rate_limit"` shape — and every extra account answers normally.

   Proves: POST /api/auth/claude-cli/add creates an account and signs it in through `claude auth login` in its own
   config dir; /accounts lists both sign-ins; a run on the spent primary rotates to account 2 inside the SAME run
   (provider.fallback names toAccount); the next run starts straight on account 2 (the primary is cooling); and
   /remove signs the account out through the CLI and deletes its folder. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

const FAKE_CLI = String.raw`'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || '';
const who = dir ? path.basename(dir) : 'primary';
const log = line => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, line + '\n');
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
if (args[0] === 'auth') {
  log(who + ' auth ' + args[1]);
  if (args[1] === 'status') out({ loggedIn: true, authMethod: 'claude.ai', email: who + '@example.test', subscriptionType: 'max' });
  process.exit(0);
}
// a persistent session (--input-format stream-json) answers each stdin line as a turn and stays alive; plain text
// input answers once stdin ends
const streaming = args.indexOf('--input-format') >= 0;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  input += d;
  if (!streaming) return;
  let nl;
  while ((nl = input.indexOf('\n')) >= 0) { const line = input.slice(0, nl); input = input.slice(nl + 1); if (line.trim()) turn(line); }
});
process.stdin.on('end', () => { if (!streaming) turn(input); });
function turn(input) {
  const marker = (input.match(/STACK-E2E-[A-Z]+/) || ['?'])[0];
  log(who + ' run ' + marker);
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  const usage = { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 };
  if (who === 'primary') {
    const text = "You've hit your limit · resets 5pm (America/Los_Angeles)";
    out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: text, usage, total_cost_usd: 0 });
    return;
  }
  const text = 'answered by ' + who;
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', usage, total_cost_usd: 0 });
}
`;

function makeFakeClaude(root) {
  const pkg = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(root, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  return shim;
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const onData = (data) => {
      output += data.toString();
      if (!settled && output.includes(`http://${HOST}:${port}`)) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(output)) {
        settled = true;
        try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + output)); } }, 15000);
  });
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-stacking-'));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-fakeclaude-'));
  const logFile = path.join(fakeRoot, 'calls.log');
  fs.writeFileSync(logFile, '');
  const { child, port } = await boot(9010 + (process.pid % 30), {
    SKYNET_WORKSPACES: workspace,
    STARNET_CLAUDE_BIN: makeFakeClaude(fakeRoot),
    FAKE_CLAUDE_LOG: logFile,
    SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0'
  }, 20);
  const B = `http://${HOST}:${port}`;
  const calls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  try {
    const token = await bootToken(B, B);
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = async (p, body) => (await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json();
    const get = async (p) => (await fetch(B + p, { headers: H })).json();

    // 1. add a second account: a new CLI identity, signed in through `claude auth login` in ITS config dir
    const added = await post('/api/auth/claude-cli/add');
    A.eq(added.status, 'connected', 'the new account finishes its own sign-in');
    A.ok(/^[a-f0-9]{8,32}$/.test(added.account || ''), 'the add answers the new account id');
    const acctDir = path.join(workspace, '.secrets', 'accounts', 'claude-cli', added.account);
    A.ok(fs.existsSync(path.join(acctDir, 'account.json')), 'the account lives under WORKSPACES/.secrets/accounts/claude-cli/');
    A.ok(calls().includes(added.account + ' auth login'), 'the login ran as the NEW identity, not the default sign-in');

    const list = await get('/api/auth/claude-cli/accounts');
    A.eq(list.accounts.map(a => [a.label, a.primary, a.loggedIn, a.email]),
      [['account 1', true, true, 'primary@example.test'], ['account 2', false, true, added.account + '@example.test']],
      '/accounts lists both sign-ins, each from its own `claude auth status`');
    A.eq(list.max, 8, 'at most 8 sign-ins');

    // 2. a run on the spent primary rotates to account 2 inside the same run
    const run = async (marker) => {
      const r = await fetch(B + '/api/run', { method: 'POST', headers: H,
        body: JSON.stringify({ provider: 'claude-cli', model: 'sonnet', agentId: 'stacking-e2e', isTask: false, messages: [{ role: 'user', content: marker }] }) });
      A.eq(r.status, 200, marker + ' streams through the real /api/run route');
      return await r.text();
    };
    const first = await run('STACK-E2E-FIRST');
    A.eq(calls().filter(l => / run STACK-E2E-FIRST$/.test(l)), ['primary run STACK-E2E-FIRST', added.account + ' run STACK-E2E-FIRST'],
      'first run: the default sign-in hits its limit, account 2 answers');
    A.ok(/provider\.fallback/.test(first) && /"toAccount":"account 2"/.test(first) && /"reason":"quota_exhausted"/.test(first),
      'provider.fallback says the run moved to account 2 because the allowance was spent');
    A.ok(first.includes('answered by ' + added.account), 'the run finished with account 2\'s answer');

    // 3. the next run starts straight on account 2: the spent primary is cooling
    const second = await run('STACK-E2E-SECOND');
    A.eq(calls().filter(l => / run STACK-E2E-SECOND$/.test(l)), [added.account + ' run STACK-E2E-SECOND'], 'second run opens on the warm account, no wasted call');
    A.ok(!/provider\.fallback/.test(second), 'no failover needed on the second run');
    const cooled = (await get('/api/auth/claude-cli/accounts')).accounts[0];
    A.ok(cooled.coolingUntil > Date.now() + 50 * 60 * 1000, 'the spent primary cools for the full hour (no reset time was stated)');

    // 4. remove: the CLI signs that identity out, the folder goes, the list shrinks
    const removed = await post('/api/auth/claude-cli/remove', { account: added.account });
    A.eq([removed.ok, removed.signedOut], [true, true], 'remove signs out through the CLI and deletes the account');
    A.ok(calls().includes(added.account + ' auth logout'), 'logout ran as that identity');
    A.ok(!fs.existsSync(acctDir), 'the account folder is gone');
    A.eq((await get('/api/auth/claude-cli/accounts')).accounts.length, 1, 'only the default sign-in remains');
    A.eq((await post('/api/auth/claude-cli/remove', { account: added.account })).code, 'account_not_found', 'a second remove finds nothing');
    A.eq((await post('/api/auth/claude-cli/start', { account: '../../x' })).code, 'account_not_found', 'a forged account id reaches no folder');
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('subscription-stacking.e2e.test');
})().catch((error) => {
  console.log('FAIL: subscription-stacking.e2e.test threw - ' + (error && error.stack || error));
  process.exit(1);
});
