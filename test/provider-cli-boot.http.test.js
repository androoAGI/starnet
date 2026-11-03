/* Real fixture sidecar + fake local CLI child + fake channel transport. No real account or network. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Reg = require('../sidecar/providers/registry.js');
const ROOT = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(loggedIn, envOnly) {
  const env = { STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '' };
  for (const p of Reg.listProviderProfiles({ public: false })) for (const name of [...(p.keyEnv || []), ...(p.baseUrlEnv || [])]) {
    env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = '';
  }
  const fx = SidecarFixture.create({ prefix: 'readiness-cli-boot-', env });
  const marker = path.join(fx.workspace, 'channel-started.txt');
  const calls = path.join(fx.workspace, 'cli-status-calls.txt');
  const cli = path.join(fx.workspace, 'fixture-bin/node_modules/@anthropic-ai/claude-code/cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `
    const fs = require('fs');
    if (process.argv.slice(2).join(' ') !== 'auth status') throw new Error('fixture forbids inference/login');
    fs.appendFileSync(${JSON.stringify(calls)}, 'status\\n');
    setTimeout(() => { console.log(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: 'fixture' })); }, 180);
  `);
  fx.env.STARNET_CLAUDE_BIN = path.join(fx.workspace, 'fixture-bin/claude.cmd');
  const preload = path.join(fx.workspace, 'fixture-preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    globalThis.fetch = async () => { throw new Error('fixture forbids external traffic'); };
    require(${JSON.stringify(path.join(ROOT, 'sidecar/channels/slack.js'))}).makeSlackAdapter = opts => ({
      connect() { fs.writeFileSync(${JSON.stringify(marker)}, 'started'); opts.onStatus({ state: 'up' }); },
      disconnect() {}, send: async () => ({ ok: true })
    });
  `);
  if (process.env.READINESS_CLI_BOOT_CONTROL) fs.appendFileSync(preload, `
    const Module = require('module'), original = Module._extensions['.js'];
    const target = ${JSON.stringify(path.join(ROOT, 'sidecar/index.js'))};
    Module._extensions['.js'] = function (mod, filename) {
      if (filename !== target) return original(mod, filename);
      const source = fs.readFileSync(filename, 'utf8');
      if (!source.includes('await prepareChannelProviderReadiness();')) throw new Error('fixture control anchor missing');
      mod._compile(source.replace('await prepareChannelProviderReadiness();', '/* previous boot: no wait for local status */'), filename);
    };
  `);
  if (process.env.READINESS_CLI_ENV_CONTROL) fs.appendFileSync(preload, `
    const Module = require('module'), original = Module._extensions['.js'];
    const target = ${JSON.stringify(path.join(ROOT, 'sidecar/index.js'))};
    const control = fs.readFileSync(${JSON.stringify(process.env.READINESS_CLI_ENV_CONTROL)}, 'utf8');
    Module._extensions['.js'] = function (mod, filename) {
      if (filename !== target) return original(mod, filename);
      const source = fs.readFileSync(filename, 'utf8');
      const a = source.indexOf('async function prepareChannelProviderReadiness()'), b = source.indexOf('// OAuth subscriptions: stored tokens', a);
      mod._compile(source.slice(0, a) + control + source.slice(b), filename);
    };
  `);
  fx.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
  fs.mkdirSync(path.join(fx.workspace, 'channels'), { recursive: true });
  if (envOnly) {
    fx.env.STARNET_SLACK_TOKEN = 'xoxb-fixture xapp-fixture';
    fx.env.STARNET_DEFAULT_MODEL = 'sonnet';
    fs.writeFileSync(path.join(fx.workspace, 'agent.roster.json'), JSON.stringify({ version: 1, agents: [{ agentId: 'agent', provider: 'claude-cli', model: 'sonnet', name: 'Fixture' }] }));
  } else fs.writeFileSync(path.join(fx.workspace, 'channels/secrets.json'), JSON.stringify({ slack: {
    enabled: true, token: 'xoxb-fixture xapp-fixture', provider: 'claude-cli', model: 'sonnet', agentId: 'agent'
  } }));
  try {
    await fx.start();
    let row;
    for (let i = 0; i < 80; i++) {
      row = (await fx.json('GET', '/api/providers')).body.providers.find(p => p.id === 'claude-cli');
      if (row.credential.status !== 'unknown') break;
      await delay(25);
    }
    A.eq(row.unattendedReady, loggedIn, 'fresh headless CLI resolves automatically: ' + loggedIn);
    A.eq(row.lastVerified, null, 'local status never becomes remote verification: ' + loggedIn);
    A.eq(fs.existsSync(marker), loggedIn, (envOnly ? 'env channel following the CLI roster' : 'saved channel') + ' admission waits for actual local status: ' + loggedIn);
    A.eq(fs.readFileSync(calls, 'utf8').trim().split(/\n/).length, 1, 'boot and diagnostics share one local status child: ' + loggedIn);
    A.ok(!fx.output().includes('auto-start failed'), 'boot channel path has no hidden startup failure: ' + loggedIn);
  } finally { await fx.dispose(); }
}
(async () => {
  await check(true);
  await check(false);
  await check(true, true);
  A.report('provider CLI headless boot admission (fixture identity only)');
})().catch(e => { console.error(e); process.exitCode = 1; });
