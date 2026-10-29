'use strict';
/* node test/run-wire.parity.e2e.test.js — ONE {provider, model} pair per agent, proven at the provider (run-wire-resolver lane).

   One real sidecar, a RECORDING fake upstream that answers two providers on two paths (/custom/... = the station's custom
   endpoint, anything else = OpenRouter) and a fake Telegram Bot API. The station's Overseer runs custom / hero-model;
   `scout` is unpinned (it follows the station default), `legacy` is unpinned with the stale provider an older page stamped
   on its row, `smith` is pinned to OpenRouter / smith-model. Every entry point must reach the upstream with the SAME pair
   for the same agent:
     COMMS (/api/run with the page's pair) · Run Now · the scheduled tick · a Telegram owner DM (connected while the page's
     global wire was another agent's OpenRouter pin) and the DM after a chat /model · /v1 (the generic model and a selected
     agent) · ACP (GET /api/runtime/agent, then the bridge's /api/run body) · `starnet run` (bin/lib/cli-core.js) · the
     Live Doctor's probe, which must also name the pair and its source.
   The run rows name where each pair came from (wireSource), and Run Now says it was pressed (trigger 'manual').
   team.dispatch is covered in-process by test/run-wire.invariant.test.js: the real orchestration module, handed the
   resolveWire / providerAuth seams lifted out of runOnceCore's own makeOrchestrationTools call and executed (a scripted
   lead delegating here would add a lead tool loop and a station page to this one boot). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOST = '127.0.0.1';
const V1_KEY = 'run-wire-parity-v1-key-0123456789';

function readJson(req) {
  return new Promise(resolve => { let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } }); });
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && (p.text || p.content)) || '').join(' ') : '';

function upstream() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = String(req.url || '');
    if (url.includes('/chat/completions')) {
      const body = await readJson(req);
      const all = (body.messages || []).map(m => textOf(m && m.content)).join('\n');
      calls.push({ route: url.startsWith('/custom/') ? 'custom' : 'openrouter', model: body.model, text: all });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.includes('/models') ? { data: ['hero-model', 'smith-model', 'new-model', 'focused-pin'].map(id => ({ id, context_length: 32000, supported_parameters: ['tools', 'tool_choice'] })) } : { ok: true }));
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, calls, base: 'http://' + HOST + ':' + server.address().port })));
}

function telegramApi() {
  const sends = [], queued = [], waiters = [];
  let updateId = 0, messageId = 0;
  const respond = (res, obj) => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) { /* the poll was abandoned */ } };
  const flush = () => { while (queued.length && waiters.length) respond(waiters.shift(), { ok: true, result: [queued.shift()] }); };
  const server = http.createServer(async (req, res) => {
    const method = String(req.url || '').split('/').pop();
    const body = await readJson(req);
    if (method === 'getUpdates') {
      if (body.offset === -1) return respond(res, { ok: true, result: [] });
      if (queued.length) return respond(res, { ok: true, result: [queued.shift()] });
      waiters.push(res); req.on('close', () => { const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
      return;
    }
    if (method === 'sendMessage') { sends.push(body); return respond(res, { ok: true, result: { message_id: ++messageId } }); }
    if (method === 'deleteWebhook' || method === 'setMyCommands' || method === 'sendChatAction' || method === 'setMessageReaction') return respond(res, { ok: true, result: true });
    if (method === 'getMe') return respond(res, { ok: true, result: { id: 1, is_bot: true, username: 'parity_bot', can_read_all_group_messages: false } });
    respond(res, { ok: false, error_code: 404, description: 'unknown method' });
  });
  return new Promise(r => server.listen(0, HOST, () => r({
    server, sends, base: 'http://' + HOST + ':' + server.address().port,
    push(chatId, userId, text) { queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } }); flush(); },
    close() { while (waiters.length) respond(waiters.shift(), { ok: true, result: [] }); }
  })));
}

test('every entry point reaches the provider with the agent\'s one pair', { timeout: 240000 }, async () => {
  const up = await upstream();
  const tg = await telegramApi();
  const fixture = SidecarFixture.create({ prefix: 'run-wire-parity-', timeoutMs: 30000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_V1_MODEL: '', SKYNET_V1_MODEL: '',
    STARNET_OPENROUTER_KEY: 'sk-or-v1-parity', SKYNET_OPENROUTER_KEY: 'sk-or-v1-parity',
    STARNET_OPENROUTER_BASE: up.base + '/or/api/v1', SKYNET_OPENROUTER_BASE: up.base + '/or/api/v1',
    CUSTOM_OPENAI_KEY: 'custom-parity', CUSTOM_OPENAI_BASE_URL: up.base + '/custom/v1',
    STARNET_API_KEY: V1_KEY, SKYNET_API_KEY: V1_KEY,
    STARNET_TELEGRAM_API_BASE: tg.base, SKYNET_TELEGRAM_API_BASE: tg.base,
    STARNET_CRON_TICK_MS: '400', SKYNET_CRON_TICK_MS: '400'
  } });
  fs.writeFileSync(path.join(fixture.workspace, 'cron.armed.json'), JSON.stringify({ version: 1, armed: true }), 'utf8');
  const HERO = ['custom', 'hero-model'], SMITH = ['openrouter', 'smith-model'];
  const reached = (marker) => up.calls.filter(c => c.text.indexOf(marker) >= 0).map(c => [c.route, c.model]);
  const assertReached = (marker, want, label) => {
    const got = reached(marker);
    assert.ok(got.length > 0, label + ': the run reached the upstream (marker ' + marker + '); calls: ' + JSON.stringify(up.calls.map(c => [c.route, c.model, c.text.slice(-60)])));
    assert.ok(got.every(g => g[0] === want[0] && g[1] === want[1]), label + ': every call went out on ' + want.join(' / ') + ', got ' + JSON.stringify(got));
  };
  const until = async (pred, ms, label) => { for (let t = 0; t < ms; t += 100) { if (await pred()) return; await sleep(100); } assert.fail('timed out waiting for ' + label); };
  try {
    await fixture.start();
    // the roster as the page pushes it now: an unpinned crew row carries no provider; `legacy` is an older page's stamp
    const agents = [
      { agentId: 'agent', name: 'Overseer', system: 'You are the overseer.', provider: 'custom', model: 'hero-model' },
      { agentId: 'scout', name: 'Scout', system: 'You are the scout.', provider: '', model: '' },
      { agentId: 'legacy', name: 'Legacy', system: 'You are legacy.', provider: 'openrouter', model: '' },
      { agentId: 'smith', name: 'Smith', system: 'You are smith.', provider: 'openrouter', model: 'smith-model' }
    ];
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    const apiRun = async (body) => { const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); return { status: r.status, text: await r.text() }; };

    // ---- COMMS: the page sends its focusWire pair (the station default for an unpinned agent) ----
    for (const [id, want] of [['scout', HERO], ['legacy', HERO], ['smith', SMITH]]) {
      const r = await apiRun({ agentId: id, provider: want[0], model: want[1], messages: [{ role: 'user', content: 'COMMS_MARK_' + id }] });
      assert.equal(r.status, 200, 'COMMS run for ' + id + ': ' + r.text.slice(0, 200));
      assertReached('COMMS_MARK_' + id, want, 'COMMS ' + id);
    }
    const rows = (await fixture.json('GET', '/api/runs?agent=scout&limit=20')).body.runs || [];
    assert.ok(rows.some(r => r.provider === 'custom' && r.model === 'hero-model' && r.wireSource === 'station'), 'the COMMS run row names the station default as its source: ' + JSON.stringify(rows.map(r => [r.provider, r.model, r.wireSource])));

    // ---- Run Now: the routine's agent's pair, and the run says it was pressed ----
    const mkJob = async (spec) => { const r = await fixture.json('POST', '/api/cron', Object.assign({ schedule: 'every 30m' }, spec)); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body.job || r.body).id; };
    for (const [id, want] of [['scout', HERO], ['smith', SMITH]]) {
      const job = await mkJob({ name: 'Parity ' + id, agentId: id, prompt: 'RUNNOW_MARK_' + id });
      const r = await fixture.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job }) });
      const text = await r.text();
      assert.equal(r.status, 200, 'Run Now ' + id + ': ' + text.slice(0, 200));
      assertReached('RUNNOW_MARK_' + id, want, 'Run Now ' + id + ' (stream: ' + text.slice(0, 600) + ')');
      const start = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).find(e => e && e.name === 'agent.run.start');
      assert.equal(start && start.payload && start.payload.trigger, 'manual', 'Run Now emits trigger manual on agent.run.start');
    }
    // the routines readout shows the pair each routine runs
    const cronList = (await fixture.json('GET', '/api/cron')).body.jobs || [];
    const scoutJob = cronList.find(j => j.agentId === 'scout');
    assert.deepEqual(scoutJob && scoutJob.wire, { provider: 'custom', model: 'hero-model', source: 'station' }, 'GET /api/cron names the routine\'s resolved pair');

    // ---- the scheduled tick ----
    await mkJob({ name: 'Tick legacy', agentId: 'legacy', prompt: 'TICK_MARK_legacy', schedule: 'in 1s' });
    await until(() => reached('TICK_MARK_legacy').length > 0, 40000, 'the scheduled fire');
    assertReached('TICK_MARK_legacy', HERO, 'scheduled tick legacy');

    // ---- /v1: the generic model runs the station default; a selected agent runs its own pair ----
    const v1 = async (model, marker) => {
      const r = await fetch(fixture.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + V1_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: marker }] }), signal: AbortSignal.timeout(60000) });
      return { status: r.status, text: await r.text() };
    };
    assert.equal((await v1('starnet-agent', 'V1_MARK_generic')).status, 200);
    assertReached('V1_MARK_generic', HERO, '/v1 starnet-agent');
    assert.equal((await v1('smith', 'V1_MARK_smith')).status, 200);
    assertReached('V1_MARK_smith', SMITH, '/v1 smith');
    assert.equal((await v1('legacy', 'V1_MARK_legacy')).status, 200);
    assertReached('V1_MARK_legacy', HERO, '/v1 legacy');

    // ---- ACP: GET /api/runtime/agent, then the bridge's /api/run body ----
    const rt = (await fixture.json('GET', '/api/runtime/agent')).body;
    assert.deepEqual([rt.provider, rt.model, rt.configured, rt.wireSource], ['custom', 'hero-model', true, 'agent'], 'the runtime route reports the Overseer\'s pair and its source');
    const legacyRow = (rt.agents || []).find(a => a.agentId === 'legacy');
    assert.deepEqual(legacyRow && legacyRow.wire, { provider: 'custom', model: 'hero-model', source: 'station', followsStation: true, reasoningEffort: null }, 'each row carries its own resolved wire (and effort: none set, the provider default)');
    const acp = await apiRun({ model: rt.model, provider: rt.provider || 'openrouter', agentId: 'agent', rosterSystem: true, client: 'editor', isTask: true, messages: [{ role: 'user', content: 'ACP_MARK_hello' }] });
    assert.equal(acp.status, 200, 'ACP run: ' + acp.text.slice(0, 200));
    assertReached('ACP_MARK_hello', HERO, 'ACP');

    // ---- `starnet run` ----
    const core = require('../bin/lib/cli-core.js');
    for (const [id, want] of [['legacy', HERO], ['smith', SMITH]]) {
      const sel = core.pickAgent(rt, { agent: id });
      assert.ok(sel.ok, 'the CLI picks ' + id + ': ' + JSON.stringify(sel));
      const r = await apiRun(core.buildRunBody(sel, 'CLI_MARK_' + id, {}));
      assert.equal(r.status, 200, 'CLI run ' + id + ': ' + r.text.slice(0, 200));
      assertReached('CLI_MARK_' + id, want, 'starnet run ' + id);
    }

    // ---- a Telegram owner DM: connected while the page's global wire was another agent's OpenRouter pin ----
    const conn = await fixture.json('POST', '/api/channels/telegram/connect', { token: 'PARITYTOKEN', key: '', model: 'focused-pin', provider: 'openrouter', agentId: 'scout', system: 'You are the scout.', agentName: 'Scout' });
    assert.equal(conn.status, 200, 'Telegram connect: ' + conn.text.slice(0, 300));
    const pair = await fixture.json('POST', '/api/channels/telegram/owner/pair', {});
    assert.equal(pair.status, 200, 'owner pairing code: ' + pair.text.slice(0, 200));
    tg.push(5151, 99, '/pair ' + pair.body.code);
    await until(() => tg.sends.some(s => String(s.chat_id) === '5151' && /paired/i.test(String(s.text || ''))), 15000, 'owner paired');
    tg.push(5151, 99, 'TG_MARK_first');
    await until(() => reached('TG_MARK_first').length > 0, 30000, 'the owner DM run');
    assertReached('TG_MARK_first', HERO, 'Telegram owner DM scout (not the connect-time focused-pin)');
    // /model writes the roster; the very next DM runs it, on the station's provider
    tg.push(5151, 99, '/model new-model');
    await until(() => tg.sends.some(s => String(s.chat_id) === '5151' && /new-model/.test(String(s.text || ''))), 15000, '/model reply');
    tg.push(5151, 99, 'TG_MARK_second');
    await until(() => reached('TG_MARK_second').length > 0, 30000, 'the DM after /model');
    assertReached('TG_MARK_second', ['custom', 'new-model'], 'Telegram owner DM after /model');

    // ---- the Live Doctor probes the pair the agent's runs use, and names it ----
    const before = up.calls.length;
    const doc = await fixture.json('POST', '/api/diagnostics/live', { confirmedLiveProbes: true, agentId: 'legacy' });
    assert.equal(doc.status, 200, 'Live Doctor: ' + doc.text.slice(0, 200));
    assert.deepEqual(doc.body.report && doc.body.report.wire && [doc.body.report.wire.provider, doc.body.report.wire.model, doc.body.report.wire.source], ['custom', 'hero-model', 'station'], 'the report names the tuple and its source');
    assert.deepEqual((doc.body.report.wire.ignored || []).map(x => [x.source, x.provider]), [['agent', 'openrouter']], 'the report names the stale provider stamp it passed over (never silent)');
    const probe = up.calls.slice(before).filter(c => /Reply exactly OK\./.test(c.text)).map(c => [c.route, c.model]);
    assert.ok(probe.length === 1 && probe[0][0] === 'custom' && probe[0][1] === 'hero-model', 'the probe reached the upstream on the same pair: ' + JSON.stringify(probe));
    assert.ok(/custom \/ hero-model · the station default/.test(String(doc.body.text || '')), 'the receipt text names the pair and its source');
  } finally {
    tg.close();
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
    await new Promise(r => tg.server.close(r));
  }
});
