/* node test/routine-keys.e2e.test.js — real-sidecar proof that unattended runs use the key the Commander connected
   in a BROWSER page (#89), and that routines saved before 0.13.2 heal their toolset list (#58 / A3).

   Boots the actual sidecar (no env key, a mock OpenRouter) and drives the exact surfaces the reports named:
     1. Run Now with no station key -> 400 with the ONE shared sentence (names SETTINGS → AI & MODELS + the env var)
     2. legacy toolset lists written straight into cron.jobs.json ([], 'WEB & BROWSER', 'web_request', 'bogus', a
        freebies-only list) -> after a restart GET /api/cron shows them healed AND the file on disk was rewritten;
        an all-unknown list keeps the freebies-only restriction it ran with (never widened to the full grant)
     3. POST /api/providers/engine-key while the store path is blocked -> the route SAYS it failed, and Run Now is
        still refused (nothing unproven was adopted) — the write-failure path, live
     4. the same POST once the disk works -> presence-only answer; Run Now fires on the page key, and the routine
        that lost its toolsets to [] now sends web tools to the provider
     5. restart -> still runs on the page key (it round-tripped disk)
     6. restart with OPENROUTER_API_KEY in the env -> the operator's env var outranks the page copy
     7. REMOVE -> neither the main file nor its .bak keeps the key; restart without env -> refused again
   Plus the auth seam: no launch token / a foreign Origin is refused, and no route echoes the key.
   Run via `npm run test:http` (child-process boots). */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const PAGE_KEY = 'sk-or-v1-page-copy-0123456789abcdef0123456789';
const ENV_KEY = 'sk-or-v1-operator-env-0123456789abcdef012345';

function startMock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
        calls.push({ auth: String(req.headers.authorization || ''), body });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'routine ran' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' })));
}

const events = text => String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const callFor = (calls, marker) => calls.filter(c => JSON.stringify(c.body.messages || []).indexOf(marker) >= 0).pop();
const toolNames = call => ((call && call.body.tools) || []).map(t => (t && t.function && t.function.name) || '');

(async () => {
  const mock = await startMock();
  const blank = {};
  for (const n of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY']) { blank[n] = ''; blank['SKYNET_' + n] = ''; blank['STARNET_' + n] = ''; }
  const fixture = SidecarFixture.create({ prefix: 'sk-routine-keys-', env: Object.assign(blank, {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_AUX_BUDGET: '0',
    SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_DESKTOP_SHELL: '', STARNET_DESKTOP_SHELL: ''
  }) });
  const ws = fixture.workspace;
  const keysFile = path.join(ws, '.secrets', 'provider-keys.json');
  const cronFile = path.join(ws, 'cron.jobs.json');
  const engineKey = body => fixture.json('POST', '/api/providers/engine-key', body);
  const runNow = id => fixture.json('POST', '/api/cron/run', { id });
  try {
    await fixture.start();
    /* ---- 1. no station key: Run Now says the ONE sentence ---- */
    const specs = { empty: [], label: ['WEB & BROWSER'], tool: ['web_request'], unknown: ['bogus'], free: ['todo'] };
    const ids = {};
    for (const name of Object.keys(specs)) {
      const made = await fixture.json('POST', '/api/cron', { name: 'Legacy ' + name, prompt: 'ROUTINE-' + name.toUpperCase() + ' check the station news', schedule: 'every 1h', agentId: 'agent', model: 'test/model', provider: 'openrouter' });
      A.eq(made.status, 200, 'created routine ' + name);
      ids[name] = made.body && made.body.job && made.body.job.id;
    }
    const refused = await runNow(ids.empty);
    A.eq(refused.status, 400, 'Run Now with no station key is refused before any spend');
    const SENTENCE = 'no OPENROUTER API key is saved on this station for this routine — connect or re-save it under SETTINGS → AI & MODELS, or set OPENROUTER_API_KEY in the environment that starts StarNet';
    A.eq(refused.body && refused.body.error, SENTENCE, 'the refusal is the shared sentence (was "connect a OpenRouter API key to run this scheduled routine")');

    /* ---- 2. legacy toolset lists heal on load and are persisted ---- */
    await fixture.stop();
    const env = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
    for (const job of env.jobs) for (const name of Object.keys(ids)) if (job.id === ids[name]) job.enabledToolsets = name === 'free' ? ['todo'] : specs[name];
    fs.writeFileSync(cronFile, JSON.stringify(env));
    fs.mkdirSync(keysFile, { recursive: true });   // block the store path: the next save MUST fail
    await fixture.start();
    const snap = await fixture.json('GET', '/api/cron');
    const job = name => ((snap.body && snap.body.jobs) || []).find(j => j.id === ids[name]) || {};
    A.eq(job('empty').enabledToolsets, null, 'a stored [] (the broken WEB & BROWSER save) heals to no restriction');
    A.eq(job('label').enabledToolsets, ['web'], 'a stored console label heals to its family');
    A.eq(job('tool').enabledToolsets, ['web'], 'a stored tool name heals to its family');
    const unknownList = job('unknown').enabledToolsets;
    A.ok(Array.isArray(unknownList) && unknownList.length > 0 && unknownList.indexOf('web') < 0, 'an all-unknown list keeps its freebies-only restriction (dropped, never a boot failure, never widened): ' + JSON.stringify(unknownList));
    A.ok(/dropped unknown entry "bogus"/.test(String(job('unknown').lastError || '')) && /always-on tools/.test(String(job('unknown').lastError || '')), 'the ROUTINES row says what was dropped and what it still runs with: ' + job('unknown').lastError);
    A.ok(Array.isArray(job('free').enabledToolsets) && job('free').enabledToolsets.length === 1 && job('free').enabledToolsets[0] !== 'web', 'a freebies-only list stays restricted (never widened): ' + JSON.stringify(job('free').enabledToolsets));
    const disk = JSON.parse(fs.readFileSync(cronFile, 'utf8')).jobs;
    A.eq((disk.find(j => j.id === ids.empty) || {}).enabledToolsets, null, 'the repair was written back to cron.jobs.json (persisted once)');
    A.ok(/repaired routine/.test(fixture.output()), 'the boot log names the repair');

    /* ---- auth seam ---- */
    const noToken = await fetch(fixture.baseUrl + '/api/providers/engine-key', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.baseUrl }, body: JSON.stringify({ provider: 'openrouter', key: PAGE_KEY }) });
    A.eq(noToken.status, 403, 'no launch token -> refused');
    const foreign = await fixture.json('POST', '/api/providers/engine-key', { provider: 'openrouter', key: PAGE_KEY }, { headers: { Origin: 'https://evil.example' } });
    A.eq(foreign.status, 403, 'a foreign Origin -> refused');
    A.eq((await engineKey({ provider: 'codex', key: 'x' })).status, 400, 'a sign-in provider takes no key from the page');

    /* ---- 3. the write-failure path: the route says so, nothing is adopted ---- */
    const failed = await engineKey({ provider: 'openrouter', key: PAGE_KEY });
    A.eq(failed.status, 500, 'a save the disk did not prove is a failure, not a 200');
    A.ok(failed.body && failed.body.ok === false && /chat in this browser still works/.test(failed.body.error) && /routines/.test(failed.body.error), 'the failure says chat works and routines will not: ' + (failed.body && failed.body.error));
    A.ok(failed.text.indexOf(PAGE_KEY) < 0, 'the failure never echoes the key');
    const stillRefused = await runNow(ids.empty);
    A.eq(stillRefused.status, 400, 'after a failed save Run Now is STILL refused (the unproven key was not adopted)');

    /* ---- 4. a proven save: Run Now runs on the page key, with its healed toolsets ---- */
    fs.rmSync(keysFile, { recursive: true, force: true });
    const saved = await engineKey({ provider: 'openrouter', key: PAGE_KEY, keyPool: [], baseUrl: '' });
    A.eq(saved.status, 200, 'the save lands');
    A.ok(saved.body && saved.body.ok === true && saved.body.persisted === true && saved.body.keySource === 'station' && saved.body.unattendedReady === true, 'presence-only answer: ' + saved.text);
    A.ok(saved.text.indexOf(PAGE_KEY) < 0, 'the answer never echoes the key');
    A.ok(fs.readFileSync(keysFile, 'utf8').indexOf(PAGE_KEY) >= 0 && fs.readFileSync(keysFile + '.bak', 'utf8').indexOf(PAGE_KEY) >= 0, 'main and .bak hold the copy (read back before the answer)');
    const ran = await runNow(ids.empty);
    A.eq(ran.status, 200, 'Run Now now runs');
    const end = events(ran.text).filter(e => e.name === 'agent.run.end').pop();
    A.eq(end && end.payload && end.payload.reason, 'done', 'the routine run completes: ' + ran.text.slice(-300));
    const emptyCall = callFor(mock.calls, 'ROUTINE-EMPTY');
    A.eq(emptyCall && emptyCall.auth, 'Bearer ' + PAGE_KEY, 'the provider saw the key the Commander saved in the page');
    A.ok(toolNames(emptyCall).some(n => /^web_/.test(n)), 'the routine whose toolsets were lost to [] now has web tools: ' + toolNames(emptyCall).join(','));
    const labelRun = await runNow(ids.label);
    A.eq(labelRun.status, 200, 'the label routine runs');
    A.ok(toolNames(callFor(mock.calls, 'ROUTINE-LABEL')).some(n => /^web_/.test(n)), 'the WEB & BROWSER routine has its web tools');
    for (const route of ['/api/diagnostics', '/api/cron', '/api/providers']) {
      const r = await fixture.json('GET', route);
      A.ok(r.text.indexOf(PAGE_KEY) < 0, route + ' never echoes the page key');
    }

    /* ---- 5. it survives a restart ---- */
    await fixture.restart();
    mock.calls.length = 0;
    A.eq((await runNow(ids.empty)).status, 200, 'after a restart Run Now still runs');
    A.eq((callFor(mock.calls, 'ROUTINE-EMPTY') || {}).auth, 'Bearer ' + PAGE_KEY, 'on the page key loaded from disk');

    /* ---- 6. an operator env var outranks the page copy ---- */
    await fixture.restart({ OPENROUTER_API_KEY: ENV_KEY });
    mock.calls.length = 0;
    const presence = await engineKey({ provider: 'openrouter', key: PAGE_KEY });
    A.eq(presence.body && presence.body.keySource, 'environment', 'the answer says unattended runs use the env var');
    A.eq((await runNow(ids.empty)).status, 200, 'Run Now runs with the env key present');
    A.eq((callFor(mock.calls, 'ROUTINE-EMPTY') || {}).auth, 'Bearer ' + ENV_KEY, 'the operator env var wins over the page copy');

    /* ---- 7. REMOVE leaves no copy anywhere ---- */
    const removed = await engineKey({ provider: 'openrouter', key: '', keyPool: [], baseUrl: '' });
    A.ok(removed.status === 200 && removed.body.ok === true && removed.body.saved && removed.body.saved.key === false, 'REMOVE is proven: ' + removed.text);
    A.ok(fs.readFileSync(keysFile, 'utf8').indexOf(PAGE_KEY) < 0 && fs.readFileSync(keysFile + '.bak', 'utf8').indexOf(PAGE_KEY) < 0, 'neither the file nor its .bak keeps the removed key');
    await fixture.restart();
    const gone = await runNow(ids.empty);
    A.eq(gone.status, 400, 'with the copy removed and no env var, Run Now is refused again');
    A.eq(gone.body && gone.body.error, SENTENCE, 'with the same sentence');
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + fixture.output().slice(-3000));
  } finally {
    await fixture.dispose();
    mock.server.closeAllConnections && mock.server.closeAllConnections();
    await new Promise(r => mock.server.close(r));
  }
  A.report('routine-keys.e2e.test');
})();
