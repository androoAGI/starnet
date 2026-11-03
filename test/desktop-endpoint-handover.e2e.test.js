/* node test/desktop-endpoint-handover.e2e.test.js — the desktop app hands the station its saved endpoints (GitHub #137).

   #137: on the desktop app the OS keychain holds provider KEYS only; a CUSTOM base URL lived in the window's storage
   and the sidecar's memory. After any app restart (an update included) or a sidecar respawn the station had no
   endpoint, so chat worked (each run carries its baseUrl) while a scheduled routine / Run Now failed "no CUSTOM base
   URL is saved on this station for this scheduled routine".

   Review r5: the station keeps a CLOUD provider's override too (an OpenRouter-compatible proxy, a corporate gateway). The
   desktop page sends no key, so the station never sends its keychain key to the endpoint a run body names; with the
   override held for one session only, every chat after a respawn went to the provider's default until the hand-over
   landed. A respawned station now runs a cloud provider on its kept override, a body endpoint it does not use is said on
   agent.run.start, and a CUSTOM run whose endpoint it cannot use is refused with the reason.

   A REAL hermetic sidecar plus the REAL harness.js hand-over functions (lifted by source into a sandbox whose
   `invoke` does what the Rust shell's harness_store_provider_key does: the keychain only when a key is given, then
   POST /api/key with the per-launch IPC token):
     · before the hand-over a CUSTOM routine's Run Now is refused with the #137 sentence (the reproduction)
     · the boot hand-over pushes each endpoint slot WITHOUT a key (the keychain is never touched; a cleared slot goes
       as a clear) and the routine runs
     · the station KEEPS what it was handed (.secrets/provider-endpoints.json, main + .bak): a sidecar respawn runs the
       routine with no page at all, and a routine that came due while the app was closed runs in the launch catch-up,
       before any window could hand anything over
     · the page's "no answer, then an answer" re-syncs once; a cleared endpoint stays cleared across a restart and
       leaves no copy on disk
     · a browser page never uses this path (its endpoint rides the engine-key copy, #89) */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const IPC = 'desktop-endpoint-handover-ipc-token-1234567890';
const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const slice = (from, to) => {
  const a = harness.indexOf(from), b = harness.indexOf(to, a + 1);
  A.ok(a >= 0 && b > a, 'harness.js still has ' + from.trim().slice(0, 48));
  return harness.slice(a, b);
};
const helpers = slice('  function normalizeProviderId(provider) {', '  function providerNeedsKey(provider) {');
const handOver = slice('  /* #137 DESKTOP ENDPOINT HAND-OVER', '  // #62: no provider key contains whitespace');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function page(opts) {
  const store = new Map(Object.entries(opts.storage || {}));
  const invokes = [], warns = [];
  let settled = 0;
  const scope = {
    JSON, Promise, Map, Set, Array, String, Number, Object,
    DESKTOP: !!opts.desktop,
    LS: { key: 'starnet.byok.key', keyPool: 'starnet.byok.keyPool', baseUrl: 'starnet.byok.baseUrl', prov: 'starnet.byok.prov' },
    SK: { providers: { registry: require('../sidecar/providers/registry.js') } },
    readinessCache: require('../frontend/app/provider-readiness.js').makeCache(),
    refreshProviderReadiness: async () => {},
    getProv: () => 'custom',
    localStorage: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
      key: i => Array.from(store.keys())[i] || null,
      get length() { return store.size; }
    },
    invoke: async (cmd, args) => {
      invokes.push({ cmd, args: Object.assign({}, args) });
      try { return await opts.shell(cmd, args); } finally { settled++; }
    },
    // the page's /api fetch (the station's readout of the endpoints it keeps); a page with none answers nothing
    fetch: opts.fetch || (async () => { throw new Error('no station in this sandbox'); }),
    setTimeout: opts.setTimeout || setTimeout, clearTimeout: opts.clearTimeout || clearTimeout,
    console: { warn: m => warns.push(String(m)), log() {} }
  };
  const api = vm.runInNewContext(helpers + handOver + "\n({ pushDesktopEndpoints, noteStationReply, desktopEndpointsHeld, endpointHandOverSettled: typeof endpointHandOverSettled === 'function' ? endpointHandOverSettled : null })", scope);
  return { api, invokes, warns, settled: () => settled };
}

async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(25); }
  A.ok(false, 'timed out waiting: ' + label);
}

(async () => {
  // a strict loopback OpenAI-compatible upstream (the user's CUSTOM endpoint)
  const chats = [];
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      if (req.url.indexOf('/v1/models') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'local/model', context_length: 8000 }] })); }
      if (req.url.indexOf('/v1/chat/completions') !== 0) { res.writeHead(404); return res.end(); }
      chats.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ROUTINE DONE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + upstream.address().port + '/v1';

  const env = { STARNET_IPC_TOKEN: IPC, STARNET_FULL_ACCESS: '1', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '' };
  // a CLOUD provider the keychain holds a key for (seeded into the sidecar's env at spawn, as the shell does), whose endpoint
  // the Commander pointed at their own gateway. The operator-level URL can never answer (.invalid): a run that lost the
  // override fails here, on this machine, and never reaches the provider's real default.
  env.GROQ_API_KEY = 'gsk-keychain-seeded-for-this-test';
  env.GROQ_BASE_URL = 'https://groq-default-stand-in.invalid/openai/v1';
  // no ambient CUSTOM endpoint or key may stand in for the hand-over
  for (const name of ['CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY']) {
    env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = '';
  }
  const fixture = SidecarFixture.create({ prefix: 'desktop-endpoint-handover-', env });
  // the Rust shell's harness_store_provider_key (main.rs): the keychain only when a key is given; then push_provider_config
  // posts { provider, key? , baseUrl? } to /api/key with the per-launch IPC token
  const keychainWrites = [];
  const shell = async (cmd, args) => {
    if (cmd !== 'harness_store_provider_key') throw new Error('unexpected ' + cmd);
    const payload = { provider: args.provider };
    if (args.key != null) { keychainWrites.push(args.provider); payload.key = args.key; }
    if (args.baseUrl != null) payload.baseUrl = args.baseUrl;
    const r = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify(payload) });
    if (r.status !== 200) throw new Error('sidecar refused the push (HTTP ' + r.status + ')');
    return null;
  };
  try {
    await fixture.start();
    const agentId = 'routine-custom';
    A.eq((await fixture.json('POST', '/api/roster', { agents: [{ agentId, name: 'Custom', system: 'Answer briefly.', provider: 'custom', model: 'local/model' }], updatedAt: Date.now() })).status, 200, 'roster saved');
    await fixture.json('POST', '/api/cron/arm', { enabled: false });
    const made = await fixture.json('POST', '/api/cron', { name: 'Custom routine', prompt: 'Say the routine is done', schedule: 'every 1h', agentId, provider: 'custom', model: 'local/model', runsLine: false });
    A.eq(made.status, 200, 'routine created: ' + made.text);
    const jobId = made.body && made.body.job && made.body.job.id;
    const runNow = () => fixture.json('POST', '/api/cron/run', { id: jobId });
    const ranDone = r => r.status === 200 && /"name":"agent\.run\.end"[^\n]*"reason":"done"/.test(r.text);

    // the reproduction: the desktop station holds no endpoint after a launch
    const before = await runNow();
    A.eq(before.status, 400, 'a fresh desktop launch: Run Now is refused before the hand-over');
    A.ok(/no CUSTOM base URL is saved on this station/.test(String(before.body && before.body.error)), 'the refusal is the #137 sentence: ' + before.text);

    const storage = {
      'starnet.byok.prov': 'custom',
      'starnet.byok.baseUrl.custom': endpoint,
      'starnet.byok.baseUrl.ollama': 'http://192.168.1.50:11434',
      'starnet.byok.baseUrl.openai': '',              // an emptied endpoint is handed over as a clear
      'starnet.byok.baseUrl.anthropic': 'https://proxy.invalid/v1',   // a cloud provider's override: handed over and kept
      'starnet.byok.baseUrl.groq': endpoint,          // ...and one this test runs on after a respawn
      'starnet.byok.baseUrl.starnet': 'http://cloud.invalid'   // the linked account's endpoint is the sidecar's own
    };
    const stationFetch = u => fixture.request(u);
    const desk = page({ desktop: true, storage, shell, fetch: stationFetch });

    // boot hand-over
    const out = await desk.api.pushDesktopEndpoints();
    A.eq(out.map(o => o.provider).sort(), ['anthropic', 'custom', 'groq', 'ollama', 'openai'], 'the boot hand-over pushes every endpoint slot this window holds (never starnet)');
    A.ok(out.every(o => o.ok), 'every push landed');
    A.ok(desk.invokes.every(c => c.cmd === 'harness_store_provider_key' && !Object.prototype.hasOwnProperty.call(c.args, 'key')), 'no push carries a key');
    A.eq(keychainWrites.length, 0, 'the keychain is never touched by the hand-over');
    A.eq(desk.invokes.find(c => c.args.provider === 'custom').args.baseUrl, endpoint, 'the CUSTOM push carries the saved endpoint');
    A.eq((desk.invokes.find(c => c.args.provider === 'openai') || { args: {} }).args.baseUrl, '', 'a cleared slot is handed over as a clear');

    const after = await runNow();
    A.ok(ranDone(after), 'after the boot hand-over the CUSTOM routine runs to done: ' + after.text.slice(0, 400));
    A.ok(chats.length > 0, 'the routine reached the saved CUSTOM endpoint');

    // the station keeps what it was handed: URLs only, main AND .bak
    const endpointsFile = path.join(fixture.workspace, '.secrets', 'provider-endpoints.json');
    const onDisk = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
    for (const f of [endpointsFile, endpointsFile + '.bak']) {
      const saved = (() => { try { return JSON.parse(onDisk(f)); } catch (_) { return null; } })();
      A.eq(saved && saved.baseUrls, { anthropic: 'https://proxy.invalid/v1', custom: endpoint, groq: endpoint, ollama: 'http://192.168.1.50:11434' },
        path.basename(f) + ' holds every endpoint it was handed: CUSTOM, Ollama and the cloud overrides (no cleared one, never starnet)');
    }

    // #137 respawn: the respawned sidecar reads its copy back — no page, no refused fetch, no hand-over needed
    const pushesBeforeRespawn = desk.invokes.length;
    await fixture.restart();
    const respawned = await runNow();
    A.ok(ranDone(respawned), 'a respawned sidecar still has the endpoint: the CUSTOM routine runs to done: ' + respawned.text.slice(0, 300));
    A.eq(desk.invokes.length, pushesBeforeRespawn, 'with no push from any page');
    // review r5: the desktop page's chat on a cloud provider (its body names the override and no key — the keychain holds
    // it) runs on the kept override after the respawn, before any hand-over could land
    const apiRun = async (body) => {
      const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      return { status: r.status, text: await r.text() };
    };
    const startOf = text => { const line = String(text).split('\n').find(l => /"name":"agent\.run\.start"/.test(l)); try { return JSON.parse(line); } catch (_) { return null; } };
    const chatsBeforeCloud = chats.length;
    const cloud = await apiRun({ agentId, provider: 'groq', model: 'local/model', baseUrl: endpoint, messages: [{ role: 'user', content: 'CLOUD_OVERRIDE_MARK' }] });
    A.ok(cloud.status === 200 && ranDone(cloud), 'a respawned station runs a cloud provider on its kept override: ' + cloud.text.slice(0, 300));
    A.ok(chats.length > chatsBeforeCloud, '...the run reached the override, never the provider default');
    A.ok(!/"notices"/.test(cloud.text), '...and, naming the endpoint the station holds, carries no notice');
    // a script naming ANOTHER endpoint for the same provider, no key: the station's key never goes there; the run goes to
    // the kept override and agent.run.start says so, once
    const script = await apiRun({ agentId, provider: 'groq', model: 'local/model', baseUrl: 'https://script-named.invalid/v1', messages: [{ role: 'user', content: 'SCRIPT_MARK' }] });
    const scriptStart = startOf(script.text);
    A.ok(script.status === 200 && ranDone(script), 'a script\'s run on another endpoint still runs, on the kept override: ' + script.text.slice(0, 300));
    const notices = (scriptStart && ((scriptStart.payload || scriptStart.data || scriptStart).notices)) || null;
    A.ok(Array.isArray(notices) && notices.length === 1 && /^the endpoint this run named was not used \(/.test(notices[0]) && !/script-named/.test(notices[0]),
      '...and agent.run.start carries one notice that says why, without the URL: ' + JSON.stringify(scriptStart));

    // #137 launch catch-up: a routine that came due while the app was closed fires in the sidecar's boot reconcile,
    // before any window exists — it must run on the kept endpoint, never stop "no CUSTOM base URL is saved"
    A.eq((await fixture.json('POST', '/api/cron/arm', { enabled: true })).status, 200, 'the scheduler is armed');
    await fixture.stop();
    const cronFile = path.join(fixture.workspace, 'cron.jobs.json');
    const doc = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
    const job = (Array.isArray(doc.jobs) ? doc.jobs : (Array.isArray(doc) ? doc : [])).find(j => j && j.id === jobId);
    A.ok(job, 'the routine is in cron.jobs.json');
    // THE CATCH-UP'S OWN RECORD (review r1 of 1ab4e9991, Codex VD-HANDOVER-ORACLE). The Run Now before the restart left its
    // record on the routine, ok, its lastRunAt 125-200 ms before this launch, and the catch-up's own record lands only
    // 250-400 ms before fixture.start() resolves (later on a loaded box). A cron row's state is never 'running': GET
    // /api/cron says a run is in flight with inFlight:true. So the poll counts only a NEW run id with its status and
    // nothing in flight. A short run can settle between two polls, so it never has to see inFlight:true first.
    const priorRunId = (job && job.lastRunId) || '';
    A.ok(priorRunId !== '', 'the Run Now before the restart left its run id on the routine: ' + JSON.stringify(job && job.lastRunId));
    const settledAfter = (row, before) => !!(row && row.lastRunId && row.lastRunId !== before && row.lastStatus && !row.inFlight);
    const was = { id: jobId, state: 'scheduled', lastRunId: 'run-before', lastRunAt: new Date().toISOString(), lastStatus: 'ok' };
    const rowOf = over => Object.assign({}, was, over);
    A.eq([rowOf({ inFlight: true }), rowOf({}), rowOf({ inFlight: false }), rowOf({ lastRunId: 'run-catch-up', inFlight: true }), rowOf({ lastRunId: 'run-catch-up' })]
      .map(r => settledAfter(r, 'run-before')), [false, false, false, false, true],
      'the poll waits for the catch-up\'s own record: the previous one (recent, ok) never counts, in flight or not, nor a new one still in flight');
    job.nextRunAt = new Date(Date.now() - 3 * 3600e3).toISOString();   // the app was closed past the due time
    fs.writeFileSync(cronFile, JSON.stringify(doc));
    try { fs.unlinkSync(cronFile + '.bak'); } catch (_) {}
    const chatsBeforeLaunch = chats.length;
    await fixture.start();
    let launched = null, caughtUp = null;
    for (let i = 0; i < 200 && !caughtUp; i++) {
      const list = await fixture.json('GET', '/api/cron');
      launched = ((list.body && list.body.jobs) || []).find(j => j.id === jobId) || null;
      if (launched && launched.state === 'blocked_config') break;
      if (settledAfter(launched, priorRunId)) caughtUp = launched;
      else await sleep(100);
    }
    A.ok(launched && launched.state !== 'blocked_config', 'the launch catch-up is not blocked: ' + JSON.stringify(launched && { state: launched.state, lastError: launched.lastError }));
    A.ok(caughtUp, 'the launch catch-up settled its own record within the poll (a new run id, nothing in flight): ' +
      JSON.stringify(launched && { priorRunId, lastRunId: launched.lastRunId, lastStatus: launched.lastStatus, inFlight: !!launched.inFlight }));
    A.eq(caughtUp && caughtUp.lastStatus, 'ok', 'the launch catch-up ran to ok on the kept endpoint');
    A.ok(chats.length > chatsBeforeLaunch, 'and reached the CUSTOM endpoint with no page pushing anything');
    A.eq((await fixture.json('POST', '/api/cron/arm', { enabled: false })).status, 200, 'the scheduler is disarmed again');

    // ... an answer with no silence before it does not push; a silence then an answer re-syncs once
    const pushes = desk.invokes.length;
    desk.api.noteStationReply(true);
    await sleep(50);
    A.eq(desk.invokes.length, pushes, 'an ordinary answer re-pushes nothing');
    desk.api.noteStationReply(false);
    desk.api.noteStationReply(false);
    A.eq(desk.invokes.length, pushes, 'nothing is pushed while the station is silent');
    desk.api.noteStationReply(true);
    await waitFor(() => desk.settled() === pushes + 5, 'the come-back hand-over');
    A.eq(desk.invokes.length, pushes + 5, 'the first answer after a silence re-syncs each endpoint slot once');
    desk.api.noteStationReply(true);
    await sleep(50);
    A.eq(desk.invokes.length, pushes + 5, 'later answers do not push again');
    const back = await runNow();
    A.ok(ranDone(back), 'after the come-back re-sync the CUSTOM routine runs to done again');
    A.eq(keychainWrites.length, 0, 'the keychain is still untouched');

    // review r7 (m7): the station keeps an endpoint this window has NO slot for (its storage was reset, an older build pushed
    // it) — nothing on the page shows it or can change it, and the keychain key keeps going there. The station says which
    // endpoints it keeps (GET /api/runtime/agent keptEndpoints), and the hand-over clears each one this window has no slot for.
    // Review r8: the readout names the PROVIDER only (all the page reads) — a URL can carry a token in its path, a ;token=
    // parameter or an opaque scheme, which no origin+path redaction removes.
    const kept = await fixture.json('GET', '/api/runtime/agent');
    const keptOf = b => ((b && b.keptEndpoints) || []).map(e => e.provider).sort();
    A.eq(keptOf(kept.body), ['anthropic', 'custom', 'groq', 'ollama'],
      'the station reads out which providers\' endpoints it keeps: ' + JSON.stringify(kept.body && kept.body.keptEndpoints));
    A.ok(((kept.body && kept.body.keptEndpoints) || []).every(e => JSON.stringify(Object.keys(e)) === '["provider"]'), '...and nothing else about them');
    const fresh = page({ desktop: true, storage: { 'starnet.byok.baseUrl.custom': endpoint }, shell, fetch: stationFetch });
    const freshOut = await fresh.api.pushDesktopEndpoints();
    A.eq(freshOut.map(o => o.provider).sort(), ['anthropic', 'custom', 'groq', 'ollama'], 'a window with one slot hands over that slot and a clear for every other endpoint the station keeps: ' + JSON.stringify(freshOut));
    A.ok(fresh.invokes.filter(c => c.args.provider !== 'custom').every(c => c.args.baseUrl === '' && !Object.prototype.hasOwnProperty.call(c.args, 'key')), '...each a clear, with no key');
    for (const f of [endpointsFile, endpointsFile + '.bak']) {
      const saved = (() => { try { return JSON.parse(onDisk(f)); } catch (_) { return null; } })();
      A.eq(saved && saved.baseUrls, { custom: endpoint }, path.basename(f) + ' keeps only what this window shows');
    }
    A.eq(keptOf((await fixture.json('GET', '/api/runtime/agent')).body), ['custom'], 'and the readout says so');
    const redacted = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC },
      body: JSON.stringify({ provider: 'anthropic', baseUrl: 'https://user:pw@gw.invalid/v1/sk-live-PATHTOKEN/openai;token=SECRET?token=SECRET2#x' }) });
    A.eq(redacted.status, 200, 'a pushed endpoint with credentials in its URL is kept');
    const readout = await fixture.json('GET', '/api/runtime/agent');
    const shown = ((readout.body && readout.body.keptEndpoints) || []).find(e => e.provider === 'anthropic');
    A.eq(shown, { provider: 'anthropic' }, '...and read out as its provider only');
    A.ok(!/gw\.invalid|PATHTOKEN|SECRET|user:pw/.test(JSON.stringify(readout.body)), '...so no part of its URL leaves the station: ' + JSON.stringify(readout.body && readout.body.keptEndpoints));
    await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'anthropic', baseUrl: '' }) });

    // a window that CLEARED its endpoints: the station forgets them, across a restart, in both copies on disk
    const cleared = page({ desktop: true, storage: { 'starnet.byok.baseUrl.custom': '', 'starnet.byok.baseUrl.ollama': '', 'starnet.byok.baseUrl.groq': '', 'starnet.byok.baseUrl.anthropic': '' }, shell });
    A.ok((await cleared.api.pushDesktopEndpoints()).every(o => o.ok), 'the clears landed');
    await fixture.restart();
    const gone = await runNow();
    A.eq(gone.status, 400, 'a cleared CUSTOM endpoint stays cleared after a restart');
    A.ok(/no CUSTOM base URL is saved on this station/.test(String(gone.body && gone.body.error)), 'and the refusal says so: ' + gone.text);
    // review r5: with a CUSTOM key in the keychain and no endpoint on the station, the page's run names its endpoint and
    // no key: the station never sends its key there, and refuses with the reason instead of "configure the base URL"
    const pushedKey = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'custom', key: 'sk-custom-keychain-for-this-test' }) });
    A.eq(pushedKey.status, 200, 'the shell pushes a CUSTOM key (the keychain)');
    const lost = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, provider: 'custom', model: 'local/model', baseUrl: endpoint, messages: [{ role: 'user', content: 'LOST_MARK' }] }) });
    const lostText = await lost.text();
    A.eq([lost.status, lostText], [400, 'missing key/model — the station holds no CUSTOM endpoint for its saved key — re-save the base URL in SETTINGS → AI & MODELS'],
      'a CUSTOM run whose endpoint the station cannot use is refused with the reason and the door');
    // review r8 (F6): a cloud provider whose endpoint the window has not handed over yet (the 8 s wait ran out, or the hand-over
    // failed) — the station's only answer is the provider default: the run is refused for a retry, never sent there
    await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'anthropic', key: 'sk-ant-keychain-for-this-test' }) });
    const early = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, provider: 'anthropic', model: 'claude-x', baseUrl: 'https://proxy.invalid/v1', messages: [{ role: 'user', content: 'EARLY_MARK' }] }) });
    A.eq([early.status, await early.text()], [503, "the station has not received this provider's endpoint yet — retry"], 'a desktop run that outran the hand-over is refused for a retry');
    await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'anthropic', key: '' }) });
    for (const f of [endpointsFile, endpointsFile + '.bak']) {
      A.ok(!onDisk(f).includes(endpoint) && !onDisk(f).includes('192.168.1.50'), path.basename(f) + ' keeps no cleared endpoint');
    }
    A.eq(keychainWrites.length, 0, 'the keychain is never touched');

    // a failed push never rejects; it says what failed
    const broken = page({ desktop: true, storage: { 'starnet.byok.baseUrl.custom': endpoint }, shell: async () => { throw new Error('sidecar not up'); } });
    const failed = await broken.api.pushDesktopEndpoints();
    A.eq(failed, [{ provider: 'custom', ok: false }], 'a failed push resolves its failure');
    A.ok(broken.warns.some(w => /custom: could not hand the station its endpoint: sidecar not up/.test(w)), 'and is logged');

    // a browser page never takes this path
    const browser = page({ desktop: false, storage, shell });
    A.eq(await browser.api.pushDesktopEndpoints(), [], 'a browser page hands over nothing here (its copy rides /api/providers/engine-key)');
    browser.api.noteStationReply(false); browser.api.noteStationReply(true);
    await sleep(50);
    A.eq(browser.invokes.length, 0, 'a browser page never invokes the shell');

    // review r7 (m6): a run waits for an in-flight hand-over, never past 8 s — a shell command that never answers must not hold
    // every run — and the hung hand-over is let go, so the next one starts
    let fire = null;
    const hung = page({ desktop: true, storage: { 'starnet.byok.baseUrl.custom': endpoint }, shell: () => new Promise(() => {}), fetch: async () => ({ ok: false }),
      setTimeout: (fn, ms) => { fire = { fn, ms }; return 1; }, clearTimeout: () => {} });
    A.ok(typeof hung.api.endpointHandOverSettled === 'function', 'harness.js has the bounded wait a run uses (endpointHandOverSettled)');
    if (hung.api.endpointHandOverSettled) {
      hung.api.pushDesktopEndpoints();   // never settles
      await waitFor(() => hung.invokes.length === 1, 'the hung push');
      let done = false;
      const waited = hung.api.endpointHandOverSettled().then(() => { done = true; });
      await sleep(30);
      A.ok(!done && fire && fire.ms === 8000, 'a run waits on the in-flight hand-over, capped at 8 s: ' + JSON.stringify(fire && fire.ms));
      fire.fn();
      await waited;
      A.ok(done, '...and goes on when the cap fires');
      hung.api.pushDesktopEndpoints();
      await waitFor(() => hung.invokes.length === 2, 'the next hand-over');
      A.eq(hung.invokes.length, 2, 'the hung hand-over was let go: the next one starts');
      const idle = page({ desktop: true, storage: {}, shell });
      A.eq(await idle.api.endpointHandOverSettled(), undefined, 'with no hand-over in flight a run does not wait');
    }
  } finally {
    await fixture.dispose();
    await new Promise(r => upstream.close(r));
  }

  // ---- wiring the sandbox can't see ----
  const initBody = harness.slice(harness.indexOf('  async function init() {'), harness.indexOf('  /* whether a key is set'));
  A.ok(/if \(!DESKTOP\) \{ syncEngineKeysOnBoot\(\)\.then\(refreshProviderReadiness\); return; \}[^\n]*\n\s*pushDesktopEndpoints\(\)\.then\(refreshProviderReadiness\);/.test(initBody), 'a desktop boot hands its endpoints over without awaiting it and refreshes the station verdict');
  A.ok(/rawFetch\(u, withApiToken\(init, t\)\)\.then\(res => \{\s*\n\s*noteStationReply\(true\);[\s\S]{0,400}if \(!\(e && e\.name === 'AbortError'\)\) noteStationReply\(false\);[^\n]*\n\s*throw e;/.test(harness),
    'the /api fetch wrapper reports each answer and each refused connection (never a caller abort), and still rethrows');
  A.ok(/\.then\(up => \{ if \(up\) pushDesktopEndpoints\(\); return up; \}\)/.test(harness), 'ENGINE RESTART re-hands the endpoints once the sidecar is back');
  A.ok(/if \(DESKTOP && endpointHandOver\) await endpointHandOverSettled\(\);\n\s*const post = \(\) => fetch\('\/api\/run', \{/.test(harness),
    'a desktop run sent while the hand-over is in flight waits for it (bounded) before POST /api/run');
  // review r7 (m8): the page never sends a StarNet endpoint (the linked account's is the station's own)
  A.ok(/\n\s*if \(provider !== 'starnet' && getBaseUrl\(provider\)\) reqBody\.baseUrl = getBaseUrl\(provider\);/.test(harness), 'a run body carries no stray StarNet baseUrl slot');
  // review r7 (m11): the hand-over's comment says what the station keeps now (a cloud override survives a respawn too)
  A.ok(!/held for[\s*]*the session only/.test(handOver), 'the hand-over comment no longer says a cloud override is held for the session only');
  A.report('desktop-endpoint-handover.e2e.test');
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
