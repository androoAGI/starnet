/* node test/child-env.test.js — helper processes never inherit the station's secrets (audit 2026-09-25 #13).

   Plants station secrets in THIS test process's env (the desktop-injected STARNET_/SKYNET_ names, a service key
   the sidecar exported, a held secret value re-exported under an innocent name), then spawns REAL node children
   through the guarded child_process and asserts each child cannot see them while it still sees PATH, HOME and the
   user's own vars (including the user's own NPM_TOKEN — theirs, not the station's). Also pins the rule that every
   sidecar module reaching child_process goes through the guard or builds its own allowlisted env. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const CE = require('../sidecar/child-env.js');
const { sanitizeChildEnv } = require('../sidecar/environment.js');

const HELD = 'held-provider-key-CANARY-0123456789';
const PLANT = {
  SKYNET_API_TOKEN: 'api-token-CANARY-abcdef',
  STARNET_API_TOKEN: 'api-token-CANARY-abcdef',
  SKYNET_IPC_TOKEN: 'ipc-token-CANARY-abcdef',
  SKYNET_OPENAI_API_KEY: 'sk-desktop-injected-CANARY-1234',
  SKYNET_KEY_POOL_OPENROUTER: 'pool-a-CANARY-123,pool-b-CANARY-456',
  STARNET_CREDITS_TOKEN: 'credits-CANARY-7890abcd',
  SKYNET_TELEGRAM_TOKEN: '123456:telegram-CANARY-abcdefgh',
  ACME_API_KEY: 'service-key-CANARY-exported',     // a KEYS-tab service key the sidecar exported (owned name)
  INNOCENT_LOOKING: HELD,                            // a held secret value under a name that looks harmless
  NPM_TOKEN: 'npm-user-own-token-keep-me',           // the user's own credential: theirs, kept for host helpers
  MY_USER_VAR: 'user-value-keep-me'
};
for (const k of Object.keys(PLANT)) process.env[k] = PLANT[k];
if (!process.env.HOME && process.env.USERPROFILE) process.env.HOME = process.env.USERPROFILE;
CE.setStationSecretSource({ names: () => ['ACME_API_KEY'], values: () => [HELD, 'short'] });

const STRIPPED = ['SKYNET_API_TOKEN', 'STARNET_API_TOKEN', 'SKYNET_IPC_TOKEN', 'SKYNET_OPENAI_API_KEY', 'SKYNET_KEY_POOL_OPENROUTER',
  'STARNET_CREDITS_TOKEN', 'SKYNET_TELEGRAM_TOKEN', 'ACME_API_KEY', 'INNOCENT_LOOKING'];
function checkEnv(env, label) {
  const names = Object.keys(env).map(k => k.toUpperCase());
  for (const k of STRIPPED) A.ok(names.indexOf(k) < 0, label + ': ' + k + ' is stripped');
  const blob = JSON.stringify(env);
  A.ok(blob.indexOf('CANARY') < 0, label + ': no planted secret value survives anywhere in the env');
  A.ok(names.indexOf('PATH') >= 0, label + ': PATH is kept');
  A.ok(names.indexOf('HOME') >= 0 || names.indexOf('USERPROFILE') >= 0, label + ': HOME/USERPROFILE is kept');
  A.eq(env.MY_USER_VAR, 'user-value-keep-me', label + ': the user\'s own var is kept');
}

(async () => {
  // ---- the builder itself ----
  const built = CE.stationChildEnv(process.env);
  checkEnv(built, 'stationChildEnv');
  A.eq(built.NPM_TOKEN, 'npm-user-own-token-keep-me', 'stationChildEnv: the user\'s own NPM_TOKEN is kept for host helpers');
  const withCfg = CE.stationChildEnv(process.env, { SERVER_API_KEY: 'configured-for-mcp', __proto__: { polluted: 1 } });
  A.eq(withCfg.SERVER_API_KEY, 'configured-for-mcp', 'explicit config env is layered on top');
  A.ok(({}).polluted === undefined, 'config env cannot pollute Object.prototype');
  // a held value equal to a runtime var never takes PATH down
  CE.setStationSecretSource({ names: () => ['ACME_API_KEY'], values: () => [HELD, String(process.env.PATH || process.env.Path)] });
  A.ok(!!(CE.stationChildEnv(process.env).PATH || CE.stationChildEnv(process.env).Path), 'PATH survives even when a held value collides with it');
  CE.setStationSecretSource({ names: () => ['ACME_API_KEY'], values: () => [HELD] });
  // a throwing source degrades to the name rules, never a crash
  CE.setStationSecretSource({ names: () => { throw new Error('boom'); }, values: () => { throw new Error('boom'); } });
  A.notThrows(() => CE.stationChildEnv(process.env), 'a throwing source does not crash the builder');
  A.ok(!('SKYNET_API_TOKEN' in CE.stationChildEnv(process.env)), 'the name rule still strips with a broken source');
  CE.setStationSecretSource({ names: () => ['ACME_API_KEY'], values: () => [HELD] });

  // ---- REAL children through the guarded child_process, with NO env option ----
  const CP = CE.guardChildProcess(require('node:child_process'));
  const script = 'process.stdout.write(JSON.stringify(process.env))';
  const viaExecFile = await new Promise((res, rej) => CP.execFile(process.execPath, ['-e', script], { windowsHide: true }, (e, out) => e ? rej(e) : res(JSON.parse(out))));
  checkEnv(viaExecFile, 'execFile child');
  A.eq(viaExecFile.NPM_TOKEN, 'npm-user-own-token-keep-me', 'execFile child: the user\'s NPM_TOKEN is still visible');
  const viaExecFileNoOpts = await new Promise((res, rej) => CP.execFile(process.execPath, ['-e', script], (e, out) => e ? rej(e) : res(JSON.parse(out))));
  checkEnv(viaExecFileNoOpts, 'execFile(file,args,cb) child');
  const viaSpawn = await new Promise((res, rej) => {
    const c = CP.spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.on('error', rej); c.on('close', () => res(JSON.parse(out)));
  });
  checkEnv(viaSpawn, 'spawn child');
  const viaExecSync = JSON.parse(String(CP.execSync('"' + process.execPath + '" -e "' + script.replace(/"/g, '\\"') + '"', { windowsHide: true })));
  checkEnv(viaExecSync, 'execSync child');
  // an explicit env is the caller's decision and passes through untouched
  const explicit = await new Promise((res, rej) => CP.execFile(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { EXPLICIT: '1' }) }, (e, out) => e ? rej(e) : res(JSON.parse(out))));
  A.eq(explicit.EXPLICIT, '1', 'explicit env reaches the child');
  A.eq(explicit.SKYNET_API_TOKEN, PLANT.SKYNET_API_TOKEN, 'an explicit env is not rewritten by the guard');

  // ---- agent commands: sanitizeChildEnv is the shared strip PLUS the blanket secret-name strip ----
  const agent = sanitizeChildEnv(process.env);
  A.ok(JSON.stringify(agent).indexOf('CANARY') < 0, 'sanitizeChildEnv: no planted station secret survives');
  A.ok(!('INNOCENT_LOOKING' in agent), 'sanitizeChildEnv: a held value under an innocent name is stripped');
  A.ok(!('NPM_TOKEN' in agent), 'sanitizeChildEnv: agent commands stay stricter (secret-shaped user names stripped too)');
  A.eq(agent.MY_USER_VAR, 'user-value-keep-me', 'sanitizeChildEnv: ordinary user vars kept');

  // ---- wiring pin: every sidecar module reaching child_process goes through the guard, or builds an allowlisted env ----
  const SIDE = path.join(__dirname, '..', 'sidecar');
  const OWN_ENV = new Set(['child-env.js', 'tools/builtin/code.js', 'computer-control.js', 'tools/builtin/cua-runtime.js']);
  const offenders = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (d.name !== 'node_modules') walk(p); continue; }
      if (!/\.js$/.test(d.name)) continue;
      const rel = path.relative(SIDE, p).replace(/\\/g, '/');
      if (OWN_ENV.has(rel)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((ln, i) => {
        if (/require\((['"])(?:node:)?child_process\1\)/.test(ln) && !/guardChildProcess\(/.test(ln)) offenders.push(rel + ':' + (i + 1));
      });
    }
  })(SIDE);
  A.eq(offenders, [], 'every sidecar child_process require is wrapped in guardChildProcess (or builds its own allowlisted env)');
  const idx = readSidecarSource();
  A.ok(/setStationSecretSource\(\{ names: \(\) => Object\.keys\(serviceKeysOwnedEnv/.test(idx), 'index.js feeds the exported service-key names to the strip');

  for (const k of Object.keys(PLANT)) delete process.env[k];
  A.report('child-env.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
