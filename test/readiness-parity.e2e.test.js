/* One isolated sidecar and local fixture provider. This proves application/CLI/ACP readiness wiring,
   not a real provider account, installed WebView or rendered browser. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Reg = require('../sidecar/providers/registry.js');
const { makeCache } = require('../frontend/app/provider-readiness.js');
const { functionSourceIn } = require('./helpers/source.js');
const ROOT = path.resolve(__dirname, '..');
const cli = fx => new Promise((resolve, reject) => execFile(process.execPath,
  [path.join(ROOT, 'bin/starnet.js'), 'status', '--port', String(fx.port), '--token', fx.token, '--json'],
  { cwd: ROOT, windowsHide: true, timeout: 15000, env: { ...process.env, APPDATA: fx.profile, LOCALAPPDATA: fx.profile, XDG_DATA_HOME: fx.profile } },
  (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
function page(cache) {
  const read = name => fs.readFileSync(path.join(ROOT, 'frontend/app/' + name + '.js'), 'utf8');
  const registry = { providers: { registry: Reg } };
  let selected = 'openrouter';
  const harness = new Function('SK', 'readinessCache', 'getProv', ['normalizeProviderId', 'readiness', 'configured', 'hasStoredCredential'].map(n => functionSourceIn(read('harness'), n)).join('\n') + '\nreturn { configured, readiness, hasStoredCredential };')(
    registry, cache, () => selected);
  Object.assign(harness, { getProv: () => selected, getModel: () => 'fixture-model', refreshProviderReadiness: async () => {} });
  const dock = new Function('providerRegistry', 'Harness', 'provider', ['normalizeProvider', 'providerEnabled'].map(n => functionSourceIn(read('modeldock'), n)).join('\n') + '\nreturn providerEnabled;')(Reg, harness, () => selected);
  const cta = new Function('SK', 'Harness', 'App', ['normProv', 'providerNeedsKey', 'activeProvider', 'gapOf'].map(n => functionSourceIn(read('keycta'), n)).join('\n') + '\nreturn gapOf;')(
    registry, harness, { currentAgent: () => ({ onboarded: true }) });
  const ui = read('stationui'), cardStart = ui.indexOf('      const readiness = h && h.readiness ?'), cardEnd = ui.indexOf('      const health = providerHealth[p.id];', cardStart);
  if (cardStart < 0 || cardEnd < cardStart) throw new Error('Settings readiness slice missing');
  const card = new Function('h', 'p', 'isOAuthProvider', ui.slice(cardStart, cardEnd) + '\nreturn configured;');
  const app = read('app'), wakeStart = app.indexOf('    await Harness.refreshProviderReadiness();'), wakeEnd = app.indexOf('    wakeBtnBusy(true);', wakeStart);
  if (wakeStart < 0 || wakeEnd < wakeStart) throw new Error('WAKE readiness slice missing');
  const wake = new Function('Harness', 'msg', 'return (async () => {\n' + app.slice(wakeStart, wakeEnd) + '\nreturn true; })();');
  harness.consumerParity = async (id, expected, label) => {
    selected = id;
    A.eq(dock(id), expected, label + ': ModelDock uses the common row');
    A.eq(cta() === null, expected, label + ': KeyCTA uses the common row');
    A.eq(card(harness, { id }, p => Reg.providerUsesCodex(p) || Reg.providerUsesDeviceOAuth(p)), expected, label + ': Settings card uses the common row');
    A.eq(await wake(harness, {}), expected, label + ': WAKE readiness gate uses the common row');
  };
  return harness;
}

async function acpRefusal(fx) {
  const child = spawn(process.execPath, [path.join(ROOT, 'sidecar/acp/serve.js'), '--port=' + fx.port, '--token=' + fx.token],
    { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '', seq = 0;
  const pending = new Map(), updates = [];
  child.stderr.resume();
  child.stdout.on('data', data => {
    text += data; let nl;
    while ((nl = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, nl); text = text.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.method === 'session/update') updates.push(msg.params.update);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('ACP fixture deadline')); }, 15000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'readiness-fixture', version: '1' } });
    const session = await send('session/new', { cwd: fx.workspace, mcpServers: [] });
    const response = await send('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'fixture must be refused before a run' }] });
    return { response, updates };
  } finally { child.stdin.end(); if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; } }
}
(async () => {
  let status = 200, requests = 0;
  const inferenceKeys = [];
  const server = http.createServer((req, res) => {
    requests++;
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      inferenceKeys.push(req.headers.authorization || '');
      req.resume();
      res.writeHead(status, { 'Content-Type': 'text/event-stream' });
      return res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'fixture answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/auth/key') ? { data: { label: 'fixture' } } : { data: [{ id: 'fixture-model', context_length: 128000,
      pricing: { prompt: '0.000001', completion: '0.000001' }, supported_parameters: ['tools'] }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  const env = { STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0', STARNET_DEFAULT_MODEL: 'fixture-model', SKYNET_DEFAULT_MODEL: 'fixture-model' };
  for (const p of Reg.listProviderProfiles({ public: false })) for (const name of [...(p.keyEnv || []), ...(p.baseUrlEnv || [])]) {
    env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = '';
  }
  const fx = SidecarFixture.create({ prefix: 'readiness-parity-', env });
  const preload = path.join(fx.workspace, 'fixture-fetch.cjs');
  fs.writeFileSync(preload, `const real = globalThis.fetch; globalThis.fetch = (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'error.invalid') { const error = new Error('fixture transport failure'); error.cause = new Error(String(init.headers.Authorization || '') + ' ' + u.searchParams.get('token')); return Promise.reject(error); }
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return Promise.reject(new Error('fixture forbids external traffic'));
    return real(url, init);
  };`);
  if (process.env.READINESS_CAUSE_CONTROL) fs.appendFileSync(preload, `
    const Module = require('module'), fs = require('fs'), original = Module._extensions['.js'];
    const target = ${JSON.stringify(path.join(ROOT, 'sidecar/index.js'))};
    const control = fs.readFileSync(${JSON.stringify(process.env.READINESS_CAUSE_CONTROL)}, 'utf8');
    Module._extensions['.js'] = function (mod, filename) {
      if (filename !== target) return original(mod, filename);
      const source = fs.readFileSync(filename, 'utf8');
      const a = source.indexOf('async function verifyProviderPair('), b = source.indexOf('async function providerCheckRoute(', a);
      if (a < 0 || b < 0) throw new Error('fixture control anchor missing');
      mod._compile(source.slice(0, a) + control + source.slice(b), filename);
    };
  `);
  fx.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
  fs.mkdirSync(path.join(fx.workspace, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(fx.workspace, 'codex/tokens.json'), JSON.stringify({ access_token: 'fixture-expired-token', refresh_token: 'fixture-dead-refresh',
    expires_at: 1, authDead: { reason: 'fixture sign-in expired', code: 'codex_relogin_required', at: '2026-11-03T00:00:00Z' } }));
  const cache = makeCache(), browser = page(cache);
  const read = async (id, expected, label) => {
    const providers = (await fx.json('GET', '/api/providers')).body.providers;
    const row = providers.find(p => p.id === id);
    A.ok(row && row.unattendedReady === expected, label + ': sidecar row');
    cache.accept(providers, cache.ticket());
    A.eq(browser.configured(id), expected, label + ': Harness configured matches sidecar');
    A.eq(browser.hasStoredCredential(id), row.credential.present, label + ': stored credential is distinct from usability');
    await browser.consumerParity(id, expected, label);
    const terminal = await cli(fx), item = terminal.providerReadiness.find(p => p.provider === id);
    A.eq(item.unattendedReady, expected, label + ': real CLI agrees');
    A.eq(item.credential.status, row.credential.status, label + ': real CLI names same credential state');
    return row;
  };
  const put = (key, url = baseUrl, provider = 'openrouter', keyPool = []) => fx.json('POST', '/api/providers/engine-key', { provider, key, baseUrl: url, keyPool });
  const probe = provider => fx.json('POST', '/api/providers/probe', { provider });
  try {
    await fx.start();
    A.eq((await read('openrouter', false, 'missing')).credential.status, 'missing', 'missing credential stated');
    await put('fixture-good-key');
    A.eq((await read('openrouter', true, 'unverified')).lastVerified, null, 'configuration never mints a verification date');
    A.eq((await probe('openrouter')).body.credentialVerified, true, 'real route verifies local authenticated fixture');
    A.ok((await read('openrouter', true, 'verified')).lastVerified > 0, 'verification has an actual completion time');
    status = 401;
    A.eq((await probe('openrouter')).body.status, 401, '401 rides probe result');
    A.eq((await read('openrouter', false, 'rejected')).credential.status, 'rejected', 'rejected credential gates every consumer');
    const runtime = (await fx.json('GET', '/api/runtime/agent')).body;
    A.ok(!runtime.configured && runtime.readiness.credential.status === 'rejected', 'runtime/ACP input agrees with provider row');
    const acp = await acpRefusal(fx);
    A.ok(/credential rejected/.test(JSON.stringify(acp)), 'real ACP bridge surfaces the shared rejection before inference');
    await fx.stop(); await fx.start();
    A.eq((await read('openrouter', false, 'rejected after restart')).credential.status, 'rejected', 'durable evidence readback survives real process restart');
    await put('fixture-good-key', baseUrl, 'openrouter', ['fixture-alternate']);
    const pooled = await read('openrouter', true, 'rejected primary with eligible alternate');
    A.ok(pooled.credential.status === 'rejected' && pooled.alternateCredentials.unverified === 1 && pooled.lastVerified === null,
      'primary rejection and unverified alternate availability remain separate facts');
    const refusedCaller = await fx.json('POST', '/api/run', { provider: 'openrouter', model: 'fixture-model', key: 'fixture-good-key',
      baseUrl, isTask: false, messages: [{ role: 'user', content: 'caller must not borrow station pool' }] });
    A.eq(refusedCaller.status, 400, 'explicit rejected caller key with no pool is refused');
    status = 200;
    const run = await fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', model: 'fixture-model', isTask: false, messages: [{ role: 'user', content: 'fixture hello' }] }),
      signal: AbortSignal.timeout(20000) });
    const runText = await run.text();
    A.ok(run.ok && /fixture answer/.test(runText), 'real station run can use the eligible alternate');
    A.eq(inferenceKeys, ['Bearer fixture-alternate'], 'runtime opens on the eligible alternate, never the known rejected primary');
    status = 401;
    await fx.json('POST', '/api/providers/validate', { provider: 'openrouter', key: 'fixture-alternate', baseUrl });
    const allRejected = await read('openrouter', false, 'all credential tuples rejected');
    A.eq(allRejected.alternateCredentials.rejected, 1, 'held alternate rejection is retained without poisoning unrelated candidates');
    A.eq((await read('codex', false, 'expired sign-in')).credential.status, 'expired', 'stored dead marker stays expired');
    status = 200;
    await put('', baseUrl, 'custom');
    A.eq((await read('custom', true, 'keyless local endpoint')).credential.status, 'not-required', 'no credential fabricated for local endpoint');
    A.eq((await probe('custom')).body.credentialVerified, false, 'keyless endpoint health does not authenticate a nonexistent key');
    for (const route of ['probe', 'validate']) {
      A.eq((await fx.json('POST', '/api/providers/' + route, { provider: 'unknown-fixture', key: 'bad' })).body.error, 'unknown provider', route + ' refuses unknown id');
      const candidate = 'unsaved-fixture-candidate', secret = 'endpoint-fixture-private';
      const failed = await fx.json('POST', '/api/providers/' + route, { provider: 'openrouter', key: candidate, baseUrl: 'http://error.invalid/v1?token=' + secret });
      A.ok(!failed.body.credentialVerified && !failed.text.includes(candidate) && !failed.text.includes(secret), route + ' scrubs combined transport cause and endpoint credential');
      A.ok(!fx.output().includes(candidate) && !fx.output().includes(secret), route + ' diagnostic log contains no candidate/cause secret');
    }
    const prior = cache.read('custom');
    await fx.stop(); cache.offline();
    A.ok(browser.configured('custom') && browser.readiness('custom').cached && browser.readiness('custom').lastVerified === prior.lastVerified,
      'station unreachable preserves a clearly cached previous row without inventing fresh proof');
  } finally { await fx.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  A.report('readiness seven-state application/CLI parity and rejected ACP gate (local fixtures)');
})().catch(e => { console.error(e); process.exitCode = 1; });
