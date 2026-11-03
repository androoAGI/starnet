'use strict';
// Actual first-run refusal while a synthetic local auth-status child is held, with the real frontend error reader.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Reg = require('../frontend/app/provider-registry.js');
let Friendly = require('../frontend/app/friendlyerror.js');
const control = process.env.CLI_ADMISSION_CONTROL_DIR || '';
if (control) {
  const filename = require.resolve('../frontend/app/friendlyerror.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(path.join(control, 'friendlyerror.js'), 'utf8'), filename); Friendly = loaded.exports;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  const deadline = Date.now() + 10000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('timed out: ' + label); await delay(20); }
}
async function scenario(mode) {
  const env = { STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_CLAUDE_CLI_PERSIST: '0', SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_QUEST_REFRESH: '0' };
  for (const profile of Reg.listProviderProfiles({ public: false })) for (const name of [...(profile.keyEnv || []), ...(profile.baseUrlEnv || [])]) {
    env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = '';
  }
  const fx = SidecarFixture.create({ prefix: 'cli-admission-' + mode + '-', env });
  const bin = path.join(fx.workspace, 'fixture-bin'), home = path.join(fx.workspace, 'home');
  const started = path.join(fx.workspace, 'status-started'), release = path.join(fx.workspace, 'release-status'), calls = path.join(fx.workspace, 'generation-calls');
  fs.mkdirSync(home); fs.mkdirSync(path.join(bin, 'node_modules/@anthropic-ai/claude-code'), { recursive: true });
  const cli = path.join(bin, 'node_modules/@anthropic-ai/claude-code/cli.js');
  fs.writeFileSync(cli, `
    const fs = require('fs'), args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    if (args.join(' ') === 'auth status') {
      fs.writeFileSync(${JSON.stringify(started)}, 'started');
      const finish = () => { if (mode === 'unavailable') console.log('not a status');
        else emit({ loggedIn: mode !== 'signed-out', authMethod: 'fixture' }); };
      if (mode !== 'pending') finish();
      else { const tick = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(tick); finish(); } }, 10); }
    } else {
      fs.appendFileSync(${JSON.stringify(calls)}, 'generation\\n');
      process.stdin.resume(); process.stdin.on('end', () => {
        emit({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
        emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'READY' } } });
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'READY', stop_reason: 'end_turn', total_cost_usd: 0,
          usage: { input_tokens: 4, output_tokens: 1 } });
      });
    }
  `);
  const shim = path.join(bin, 'claude.cmd'); fs.writeFileSync(shim, '@echo off\r\n');
  fx.env.HOME = home; fx.env.USERPROFILE = home;
  fx.env.STARNET_CLAUDE_BIN = mode === 'missing' ? path.join(home, 'not-installed.exe') : shim;
  const preload = path.join(fx.workspace, 'network-and-control.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs'), Module = require('module');
    global.fetch = async () => { throw new Error('fixture forbids network: local CLI status and generation only'); };
    ${control ? `const target = ${JSON.stringify(path.resolve(__dirname, '../sidecar/index.js'))}, saved = ${JSON.stringify(path.join(control, 'index.js'))};
    const original = Module._extensions['.js'];
    Module._extensions['.js'] = function(mod, file) { if (file !== target) return original(mod, file); mod._compile(fs.readFileSync(saved, 'utf8'), file); };` : ''}
  `);
  fx.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
  const count = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const run = () => fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: 'claude-cli', model: 'haiku', agentId: 'agent', isTask: false, reflect: false,
    messages: [{ role: 'user', content: 'Say READY.' }] }) });
  const readiness = async () => (await fx.json('GET', '/api/providers')).body.providers.find(row => row.id === 'claude-cli');
  try {
    await fx.start();
    if (mode !== 'pending') await fx.json('GET', '/api/auth/claude-cli/status');
    const refused = await run(), raw = await refused.text(), row = await readiness();
    A.eq(refused.status, 400, mode + ': readiness refusal retains the existing HTTP contract');
    A.eq(count(), 0, mode + ': refused admission makes no generation call');
    A.eq(row.unattendedReady, false, mode + ': the common readiness row remains unready');
    const status = { pending: 'unknown', unavailable: 'unavailable', missing: 'missing', 'signed-out': 'missing' }[mode];
    A.eq(row.credential.status, status, mode + ': the actual common row names the state');
    A.ok(raw.includes(row.reason), mode + ': refusal states the actual common readiness reason: ' + raw);
    const friendly = Friendly.friendlyError(new Error(raw), refused.status);
    const kinds = { pending: 'claude_cli_checking', unavailable: 'claude_cli_status_unavailable', missing: 'claude_cli_missing', 'signed-out': 'claude_cli_signed_out' };
    A.eq(friendly.kind, kinds[mode], mode + ': actual frontend reader preserves readiness meaning');
    A.eq(Friendly._internals.kindFromRaw(raw, refused.status), kinds[mode], mode + ': browser fallback classifier agrees');
    A.ok(/Claude Code/.test(friendly.userMessage) && !/API key|expired|rejected/.test(friendly.userMessage), mode + ': frontend does not invent missing/rejected API credentials');
    A.eq(friendly.action, mode === 'pending' || mode === 'unavailable' ? null : 'settings', mode + ': the remedy matches the observed local status');
    if (friendly.action === 'settings') A.eq(Friendly.actionButton(friendly).label, '▸ OPEN CLAUDE CODE', mode + ': setup opens the actual CLI card');
    if (mode === 'pending') {
      await waitFor(() => fs.existsSync(started), 'actual local status child started');
      fs.writeFileSync(release, 'release');
      const known = await fx.json('GET', '/api/auth/claude-cli/status');
      A.eq([known.body.installed, known.body.loggedIn], [true, true], 'supported bounded status resolves the synthetic local sign-in');
      const ready = await readiness();
      A.eq([ready.unattendedReady, ready.credential.status, ready.lastVerified], [true, 'unverified', null], 'local readiness is eligible without pretending remote verification');
      const accepted = await run(), stream = await accepted.text();
      A.eq(accepted.status, 200, 'a separately submitted request runs after actual status resolves');
      const terminal = stream.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.name === 'agent.run.end').pop();
      A.eq(terminal && terminal.payload.outcome, 'succeeded', 'the actual synthetic CLI run completes');
      A.eq(count(), 1, 'exactly the explicit post-readiness request generates');
    }
  } finally { fs.writeFileSync(release, 'release'); await fx.dispose(); }
}
(async () => {
  for (const mode of ['pending', 'signed-out', 'unavailable', 'missing']) await scenario(mode);
  A.report('provider-cli-admission.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
