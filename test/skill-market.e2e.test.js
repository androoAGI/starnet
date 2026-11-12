/* node test/skill-market.e2e.test.js — the Skill Market end to end on the real sidecar (2026-09-29).

   Boots the REAL sidecar with test/_skill_market_fixture.js preloaded, which answers the market's own catalog URLs
   on starnetos.com from this checkout's website/ folder (the exact bytes a deploy publishes). A mock OpenRouter
   captures what the model is told. Proves, at the live seams:
     1. the catalog lists our originals as BUILT IN (bundled text == published version) and a market-only
        original as available
     2. install lands the skill in the station SKILL LIBRARY, switched on
     3. the next run's system prompt indexes it (library:<slug>) — installed means the model is told
     4. it survives a sidecar restart
     5. a download whose bytes differ from the catalog is refused and nothing installs
     6. a catalog changed under its signature is refused whole; nothing installs from it
     7. THE KILL SWITCH: the market publishes a newer signed pulled list naming the installed skill; the station's own
        background check (no request from the test) switches it off — out of the library, out of the next run's
        prompt, PULLED with the reason — and re-installing it is refused
     8. replaying the older catalog after that is refused and cannot bring the skill back
     9. uninstall takes it out of the library
   Zero real network for the catalog and the model. */
'use strict';
const A = require('./_assert.js');
const { hostText } = require('./helpers/host-notes.js');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const signing = require('../sidecar/skills/market-signing.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HOST = '127.0.0.1';
const PRELOAD = '--require ' + JSON.stringify(path.join(__dirname, '_skill_market_fixture.js').replace(/\\/g, '/'));
const TARGET = 'line-design';      // a market-only StarNet Original (needs the orchestrator)
const TAMPERED = 'routine-craft';  // served with one extra line when STARNET_TEST_MARKET_TAMPER names it

function startMock() {
  const state = { requests: [] };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        const sys = String(((body.messages || [])[0] || {}).content || '');
        // the MAIN run carries [RUNTIME] — since lean-prompt (2026-10-12) in its <run_context> system note
        state.requests.push({ sys, isMain: hostText(body.messages || []).indexOf('[RUNTIME]') >= 0 });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({
    prefix: 'sk-market-e2e-',
    env: { NODE_OPTIONS: PRELOAD, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_QUEST_REFRESH: '0' },
    timeoutMs: 20000
  });
  await fixture.start();
  const PLACED = 'orchestrator,notebook,computer,cabinet,dish';
  const market = async () => (await fixture.json('GET', '/api/skill-market?placed=' + PLACED)).body;
  const library = async () => ((await fixture.json('GET', '/api/skills?placed=' + PLACED)).body.skills || []);
  // one real run; returns the system prompt the model was sent
  const runPrompt = async (text) => {
    const start = mock.state.requests.length;
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-or-v1-market-fake', model: 'test/model', agentId: 'agent', isTask: true, placed: PLACED.split(','), messages: [{ role: 'user', content: text }] }) });
    const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }
    const main = mock.state.requests.slice(start).find(q => q.isMain);
    return { status: r.status, sys: main ? main.sys : '' };
  };
  try {
    // ---- 1. the catalog ----
    let m = await market();
    A.eq(m.ok, true, 'the market catalog loads through the real sidecar: ' + (m.error || ''));
    const by = Object.fromEntries((m.entries || []).map(e => [e.slug, e]));
    A.eq(by['feed-watch'] && by['feed-watch'].status, 'bundled', 'a bundled original reads BUILT IN (our text is exactly the published version)');
    A.eq(by[TARGET] && by[TARGET].status, 'available', 'a market-only original is available to install');
    A.eq(by[TARGET] && by[TARGET].shelf, 'originals', 'on the StarNet Originals shelf');
    A.ok(!(await library()).some(s => s.slug === TARGET), 'precondition: it is not in the library yet');

    // ---- 2. install ----
    const inst = await fixture.json('POST', '/api/skill-market/install', { slug: TARGET });
    A.eq([inst.status, inst.body.ok, inst.body.action, inst.body.enabled], [200, true, 'install', true], 'install succeeds and switches it on: ' + (inst.body.error || ''));
    let row = (await library()).find(s => s.slug === TARGET);
    A.ok(row && row.market && row.enabled && row.available, 'it is in the SKILL LIBRARY, from the market, enabled and available with the orchestrator placed');
    A.eq((await market()).entries.find(e => e.slug === TARGET).status, 'installed', 'the market card now reads installed');

    // ---- 3. the next run's prompt indexes it ----
    const run1 = await runPrompt('plan a line for my weekly research brief');
    A.eq(run1.status, 200, 'a real run streams');
    A.ok(run1.sys.indexOf('library:' + TARGET) >= 0, 'the model is told the installed skill exists (library:' + TARGET + ' in the index)');

    // ---- 4. survives a restart ----
    await fixture.restart();
    row = (await library()).find(s => s.slug === TARGET);
    A.ok(row && row.market && row.enabled, 'after a restart it is still installed and switched on');

    // ---- 4b. (sweep 2026-10-02) an UPDATE keeps the Commander's off switch (it used to silently re-enable it) ----
    A.eq((await fixture.json('POST', '/api/skills/toggle', { slug: TARGET, enabled: false })).status, 200, 'the Commander switches it off');
    const upd = await fixture.json('POST', '/api/skill-market/install', { slug: TARGET });
    A.eq([upd.body.ok, upd.body.action, upd.body.enabled], [true, 'update', false], 'updating it reports it still OFF: ' + JSON.stringify(upd.body).slice(0, 160));
    row = (await library()).find(s => s.slug === TARGET);
    A.ok(row && row.market && !row.enabled, 'and the library keeps it switched off');
    A.eq((await fixture.json('POST', '/api/skills/toggle', { slug: TARGET, enabled: true })).status, 200, 'back on for the steps below');

    // ---- 5. a download that differs from the catalog is refused ----
    await fixture.restart({ STARNET_TEST_MARKET_TAMPER: TAMPERED });
    const bad = await fixture.json('POST', '/api/skill-market/install', { slug: TAMPERED });
    A.eq(bad.body.ok, false, 'a changed file is refused');
    A.ok(/doesn't match the catalog/.test(bad.body.error || ''), 'and says why: ' + bad.body.error);
    A.ok(!(await library()).some(s => s.slug === TAMPERED), 'nothing from it reached the library');

    // ---- 6. a forged catalog ----
    await fixture.restart({ STARNET_TEST_MARKET_BADSIG: '1' });
    m = await market();
    A.eq(m.ok, false, 'a catalog changed under its signature does not load');
    A.ok(/not trusted: its signature does not match/.test(m.error || ''), 'and the market says it was not trusted: ' + m.error);
    const forged = await fixture.json('POST', '/api/skill-market/install', { slug: 'grill-me' });
    A.eq(forged.body.ok, false, 'nothing installs from a forged catalog');
    row = (await library()).find(s => s.slug === TARGET);
    A.ok(row && row.market && row.enabled, 'the skill already installed is untouched');

    // ---- 7. the kill switch ----
    const key = signing.generateKeyPair();
    const der = crypto.createPrivateKey(key.privateKeyPem).export({ format: 'der', type: 'pkcs8' }).toString('base64');
    await fixture.restart({
      STARNET_TEST_MARKET_REVOKE: TARGET, STARNET_TEST_MARKET_KEY: der, SKYNET_SKILL_MARKET_PULL_MS: '1000',
      STARNET_SKILL_MARKET_KEYS: JSON.stringify([{ id: 'test-market', publicKey: key.publicKey }])
    });
    // no market request from the test: only the station's own background check can find the pull
    const t0 = Date.now(); let off = false;
    while (Date.now() - t0 < 15000) { if (!(await library()).some(s => s.slug === TARGET)) { off = true; break; } await sleep(250); }
    A.ok(off, 'the background check switched the pulled skill off by itself (' + (Date.now() - t0) + ' ms after boot)');
    const run2 = await runPrompt('plan a line for my weekly research brief');
    A.ok(run2.sys && run2.sys.indexOf('library:' + TARGET) < 0, 'the next run is no longer told it exists');
    m = await market();
    const pulledRow = (m.entries || []).find(e => e.slug === TARGET);
    A.eq([pulledRow && pulledRow.status, pulledRow && pulledRow.pulledReason], ['pulled', 'test pull: unsafe instructions found'], 'the market shows it PULLED with the reason');
    const again = await fixture.json('POST', '/api/skill-market/install', { slug: TARGET });
    A.ok(again.body.ok === false && /was pulled from the skill market/.test(again.body.error || ''), 're-installing it is refused: ' + again.body.error);

    // ---- 8. a replayed older catalog can't bring it back ----
    await fixture.restart({ SKYNET_SKILL_MARKET_PULL_MS: '1000' });   // the fixture serves the original, older serial again
    m = await market();
    A.ok(m.ok === false && /older than one this station already saw/.test(m.error || ''), 'the older catalog is refused: ' + m.error);
    await sleep(2500);   // two background checks against the older pulled list
    A.ok(!(await library()).some(s => s.slug === TARGET), 'and the skill stays off');

    // ---- 9. uninstall ----
    const un = await fixture.json('POST', '/api/skill-market/uninstall', { slug: TARGET });
    A.eq(un.body.ok, true, 'uninstall succeeds');
    A.ok(!(await library()).some(s => s.slug === TARGET), 'and it is gone from the library');
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('skill-market.e2e.test');
})().catch(e => { console.log('FAIL: skill-market.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
