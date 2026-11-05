/* node test/aux-token-ceiling.e2e.test.js — issue #105, the real sidecar on a FAKE `claude` signed in with a subscription, and a fake
   Ollama. On test/http.list (child-process boots). No network, no real CLI, no model spend.

   Proves at the live seam:
     - background passes spawn with the CLI's cache switch and the user's run does not, their $0 rows name the route, and a nudge-due
       skill review (the largest pass) books its row with the subscription flag;
     - at the ceiling the automatic passes stop, /api/memory/config says so, and the user's run still finishes;
     - the count is per route and windowed: another route's rows, and rows 25 hours old, count for nothing; rows 23 hours old count;
     - a local route has no ceiling; junk settings are refused; 0 is off; the setting survives a restart;
     - manual REFRESH QUESTS runs at the ceiling; the automatic look stops before it stamps its cadence.

   Waiting is event-based. With STARNET_DEBUG_CHANNELS=1 every run-end with a candidate prints an [aux-governor] line, and that line
   says what was spent or that the ceiling stopped it. After a spending line, the wait is for a pass to have started, then for every
   child to have ended and the booked rows to read the same twice. No assertion hangs on a fixed quiet window. */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LONG = ('I rebuilt the staging rollback path end to end. Here is the write-up with the reasoning and the follow-ups worth remembering. ').repeat(50);
const MARK = 'CEILING_E2E_IDENTITY';
const HOUR = 3600000;

const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
const at = args.indexOf('--system-prompt-file');
let system = '';
try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}
const main = system.includes(${JSON.stringify(MARK)});
const log = o => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + '\\n');
log({ ev: 'start', main, cacheOff: process.env.DISABLE_PROMPT_CACHING === '1' });
process.stdin.resume();
process.stdin.on('end', () => {
  const finish = () => {
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  const text = main ? ${JSON.stringify(LONG)} : 'nothing durable.';
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } });
  log({ ev: 'end' });
  };
  if (!main && Number(process.env.FAKE_AUX_DELAY_MS) > 0) setTimeout(finish, Number(process.env.FAKE_AUX_DELAY_MS));
  else finish();
});
`;

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-fakeclaude-'));
const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
const shim = path.join(fakeRoot, 'claude.cmd');
fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
const logFile = path.join(fakeRoot, 'calls.log');
fs.writeFileSync(logFile, '');
const log = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const starts = () => log().filter(c => c.ev === 'start');

// SidecarFixture leaves USERPROFILE real on Windows; these boots read no real sign-in or home directory
const home = path.join(fakeRoot, 'home');
fs.mkdirSync(home);
const COMMON = { HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: logFile, STARNET_CLAUDE_CLI_PERSIST: '0', STARNET_DEBUG_CHANNELS: '1', SKYNET_SKILL_CURATOR: '0' };
const rowsOf = f => { try { return fs.readFileSync(path.join(f.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
const seed = (f, rows) => fs.appendFileSync(path.join(f.workspace, 'ledger.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const auxRow = (provider, tokens, ageMs) => Object.assign({ runId: 'seed-' + provider + '-' + ageMs, agentId: 'seed', turns: 0, usd: 0, tokens, model: 'm', unmetered: provider !== 'claude-cli', provider, aux: 'reflection', ts: Date.now() - ageMs }, provider === 'claude-cli' ? { subscription: true } : {});
const post = (f, body) => fetch(f.baseUrl + '/api/memory/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': f.token, Origin: f.baseUrl }, body: JSON.stringify(body) });
const cfg = async f => (await f.request('/api/memory/config')).json();
// These scenarios test background token policy on an established local sign-in. Merely
// reading memory/config does not resolve the CLI's initially unknown auth state.
async function cliReady(f) {
  const actual = await f.json('GET', '/api/auth/claude-cli/status');
  A.eq([actual.status, actual.body && actual.body.installed, actual.body && actual.body.loggedIn], [200, true, true],
    'fixture: the supported bounded local check proves the fake CLI is installed and signed in');
  if (actual.status !== 200 || !actual.body || !actual.body.installed || !actual.body.loggedIn)
    throw new Error('fake CLI sign-in precondition failed: ' + JSON.stringify(actual.body));
}

async function governorLine(f, agentId, from) {
  const re = new RegExp('\\[aux-governor\\][^\\n]*agent=' + agentId + '\\b[^\\n]*');
  for (const until = Date.now() + 15000; Date.now() < until;) {
    const m = f.output().slice(from).match(re);
    if (m) return m[0];
    await sleep(100);
  }
  throw new Error('no [aux-governor] line for ' + agentId + ':\n' + f.output().slice(from).slice(-1500));
}
async function childrenDone(f, before, expectChild) {
  let lastRows = -1;
  for (const until = Date.now() + 20000; Date.now() < until;) {
    const l = log(), started = l.filter(c => c.ev === 'start').length, ended = l.filter(c => c.ev === 'end').length, rows = rowsOf(f).length;
    const passStarted = !expectChild || starts().slice(before).some(c => !c.main);
    if (passStarted && started === ended && rows === lastRows) return;
    lastRows = rows;
    await sleep(300);
  }
  throw new Error('background passes did not settle');
}
async function run(f, agentId, extra) {
  const before = starts().length, from = f.output().length;
  const r = await fetch(f.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': f.token, Origin: f.baseUrl },
    body: JSON.stringify(Object.assign({ provider: 'claude-cli', model: 'haiku', agentId, isTask: true, placed: [], system: MARK + ': you are Ada.', messages: [{ role: 'user', content: 'Rebuild the staging rollback path and write up what changed and why.' }] }, extra || {})) });
  const raw = await r.text();
  if (r.status !== 200) {
    const local = await f.json('GET', '/api/auth/claude-cli/status');
    throw new Error('/api/run admission failed: HTTP ' + r.status + ' ' + raw.slice(0, 1000) +
      '; provider=' + ((extra && extra.provider) || 'claude-cli') + '; actual local CLI status=' + JSON.stringify(local.body));
  }
  const events = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const line = await governorLine(f, agentId, from);
  const spent = Number((line.match(/ spent=(\d+)/) || [])[1] || 0);
  await childrenDone(f, before, !extra && spent > 0);
  return { reason: (events.findLast(e => e.name === 'agent.run.end') || { payload: {} }).payload.reason, line, spawned: starts().slice(before) };
}

// ---- 1. spending, the ceiling, junk settings, restart, off (CE3, CE6, LE6, the blocked field) ----
async function ceilingArm() {
  // AUX_BUDGET 0: the governor spends everything, so the toolless passes and the skill review all run on the one run under test
  const f = SidecarFixture.create({ prefix: 'sk-auxceiling-', env: Object.assign({}, COMMON, { SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW_EVERY: '1' }) });
  try {
    await f.start();
    await cliReady(f);
    const fresh = await cfg(f);
    A.eq([fresh.auxTokenCeiling, fresh.defaultAuxTokenCeiling, fresh.auxTokensUsed24h, fresh.auxTokenBlocked, fresh.auxTokenRoutes], [200000, 200000, 0, [], []], 'the default ceiling, nothing used, nothing stopped');

    const a = await run(f, 'ceiling-a');
    A.eq(a.reason, 'done', 'the run finished');
    A.ok(a.spawned.some(c => c.main), 'fixture: the user run reached the CLI');
    A.ok(a.spawned.filter(c => c.main).every(c => !c.cacheOff), 'the user run keeps its cache');
    const auxRows = rowsOf(f).filter(r => r.aux);
    A.ok(auxRows.length >= 1 && auxRows.every(r => r.subscription === true && r.usd === 0 && r.provider === 'claude-cli'), 'their rows book $0, name the subscription and name the route: ' + JSON.stringify(auxRows.map(r => [r.aux, r.subscription, r.provider])));
    A.ok(auxRows.some(r => r.aux === 'skill-review'), 'CE6: the nudge-due skill review booked its row, the flag and route included: ' + a.line);
    A.ok(a.spawned.some(c => !c.main && c.cacheOff), 'a toolless pass spawned with the cache switch');
    A.ok(a.spawned.some(c => !c.main && !c.cacheOff), 'the skill review, a tool loop, kept its cache');
    A.ok(rowsOf(f).filter(r => !r.aux).every(r => r.subscription !== true), 'a user run row is not an aux row');
    const used = (await cfg(f)).auxTokensUsed24h;
    A.eq(used, auxRows.reduce((t, r) => t + r.tokens, 0), 'the figure shown is the ledger total of those rows: ' + used);

    A.eq((await post(f, { auxTokenCeiling: 1 })).status, 200, 'the setting saves');
    const blockedCfg = await cfg(f);
    A.eq(blockedCfg.auxTokenBlocked, ['claude-cli'], 'the settings read says which route has stopped');
    A.eq(blockedCfg.auxTokenRoutes.map(r => [r.provider, r.blocked]), [['claude-cli', true]], 'and per route');
    const b = await run(f, 'ceiling-b');
    A.eq(b.reason, 'done', "at the ceiling the user's run still finishes");
    A.ok(b.spawned.some(c => c.main), 'and it reached the CLI');
    A.ok(/token ceiling reached/.test(b.line) && /DEFERRED\[/.test(b.line), 'the ceiling line is what ended the wait: ' + b.line);
    A.eq(b.spawned.filter(c => !c.main).length, 0, 'no background pass spawned');

    // CE3: the junk Number() would have read as 0 or a number
    for (const bad of [-1, 1.5, 'lots', null, '   ', '\n0', '\t0', '0x0', '1e3', [], [0], true]) A.eq((await post(f, { auxTokenCeiling: bad })).status, 400, 'refused: ' + JSON.stringify(bad));
    A.eq((await cfg(f)).auxTokenCeiling, 1, 'a refused value changed nothing');
    await f.restart();
    await cliReady(f);
    A.eq((await cfg(f)).auxTokenCeiling, 1, 'the ceiling survives a sidecar restart');
    A.eq((await cfg(f)).auxTokensUsed24h, used, 'the count survives it too: it is read from the ledger');

    A.eq((await post(f, { auxTokenCeiling: 0 })).status, 200, '0 saves');
    A.eq((await cfg(f)).auxTokenBlocked, [], '0 stops nothing');
    const c = await run(f, 'ceiling-c');
    A.ok(c.spawned.filter(s => !s.main).length >= 1, 'with the ceiling off the passes run again');
  } finally { await f.dispose(); }
}

// Concurrent foreground completions must not all spend the same remaining background headroom.
async function concurrentArm() {
  const f = SidecarFixture.create({ prefix: 'sk-auxrace-', env: Object.assign({}, COMMON, {
    SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0', FAKE_AUX_DELAY_MS: '700'
  }) });
  try {
    await f.start();
    await cliReady(f);
    A.eq((await post(f, { auxTokenCeiling: 1 })).status, 200, 'concurrent fixture ceiling saved');
    const before = starts().length;
    const responses = await Promise.all(['race-a', 'race-b', 'race-c'].map(agentId => f.json('POST', '/api/run', {
      provider: 'claude-cli', model: 'haiku', agentId, isTask: true, placed: [], system: MARK + ': you are Ada.',
      messages: [{ role: 'user', content: 'Rebuild the staging rollback path and write up what changed and why.' }]
    })));
    for (const r of responses) {
      const events = r.text.trim().split('\n').map(JSON.parse);
      A.eq(events.findLast(e => e.name === 'agent.run.end')?.payload.reason, 'done', 'concurrent user work completes without waiting for background allowance');
    }
    await childrenDone(f, before, true);
    const aux = starts().slice(before).filter(c => !c.main);
    A.eq(aux.length, 1, 'only the first automatic pass may cross the ceiling; queued passes recheck settled spend');
    A.eq(rowsOf(f).filter(r => r.aux).length, 1, 'one complete background response, one usage receipt');
  } finally { await f.dispose(); }
}

// ---- 2. the count is per route and windowed (CE5, CE10, CE11) ----
async function scopeArm() {
  const f = SidecarFixture.create({ prefix: 'sk-auxscope-', env: Object.assign({}, COMMON, { SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0' }) });
  try {
    await f.start();
    await cliReady(f);
    await f.stop();
    seed(f, [auxRow('codex', 900000, HOUR), auxRow('ollama', 900000, HOUR), auxRow('claude-cli', 900000, 25 * HOUR)]);
    await f.start();
    await cliReady(f);
    const c = await cfg(f);
    A.eq(c.auxTokenRoutes.map(r => [r.provider, r.used, r.blocked]), [['codex', 900000, true]], 'CE10: a 25-hour-old row has left the window; Ollama is not a capped route; Codex is at its own ceiling');
    const a = await run(f, 'scope-a');
    A.ok(a.spawned.some(s => !s.main), 'CE5: Codex and Ollama rows do not stop passes on a Claude sign-in: ' + a.line);
    await f.stop();
    seed(f, [auxRow('claude-cli', 900000, 23 * HOUR)]);
    await f.start();
    await cliReady(f);
    const b = await run(f, 'scope-b');
    A.eq(b.spawned.filter(s => !s.main).length, 0, 'CE11: a 23-hour-old row is still in the window');
    A.ok((await cfg(f)).auxTokenBlocked.includes('claude-cli'), 'and the settings read says so');
  } finally { await f.dispose(); }
}

// ---- 3. a local route has no ceiling (CE5, the reported Ollama failure) ----
async function ollamaArm() {
  let aux = 0, main = 0;
  const reply = (native, res, content) => native
    ? res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 4000, eval_count: 400 }) + '\n')
    : res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 4000, completion_tokens: 400, total_tokens: 4400 } }) + '\n\ndata: [DONE]\n\n');
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/api/show')) return res.end(JSON.stringify({ model_info: { 'test.context_length': 65536 }, capabilities: ['completion', 'tools'] }));
    if (req.url.endsWith('/api/ps')) return res.end('{"models":[]}');
    if (!raw) return res.end(JSON.stringify({ data: [{ id: 'local-test:latest' }] }));
    const body = JSON.parse(raw);
    if (!body.messages) { res.statusCode = 404; return res.end('{}'); }
    const isMain = body.messages.some(m => m.role === 'system' && String(m.content).includes(MARK));
    if (isMain) main++; else aux++;
    reply(req.url.endsWith('/api/chat'), res, isMain ? LONG : 'nothing durable.');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const f = SidecarFixture.create({ prefix: 'sk-auxollama-', env: Object.assign({}, COMMON, { SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0', OLLAMA_BASE_URL: baseUrl, SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '' }) });
  try {
    await f.start();
    A.eq((await post(f, { auxTokenCeiling: 1 })).status, 200, 'the lowest real ceiling');
    const ollama = { provider: 'ollama', baseUrl, model: 'local-test:latest' };
    const a = await run(f, 'local-a', ollama);
    A.eq(a.reason, 'done', 'the local run finished');
    A.ok(main >= 1, 'fixture: the run reached the fake Ollama');
    for (const until = Date.now() + 10000; aux === 0 && Date.now() < until;) await sleep(100);
    const first = aux;
    A.ok(first >= 1, 'the passes ran on the local model');
    const b = await run(f, 'local-b', ollama);
    A.eq(b.reason, 'done', 'the second local run finished');
    for (const until = Date.now() + 10000; aux === first && Date.now() < until;) await sleep(100);
    A.ok(aux > first, 'its rows, past a ceiling of 1, stopped nothing: ' + b.line);
    A.ok(!/token ceiling reached/.test(f.output()), 'the ceiling line never printed on a local route');
    A.eq((await cfg(f)).auxTokenBlocked, [], 'and the settings read reports nothing stopped');
  } finally { await f.dispose(); await new Promise(resolve => upstream.close(resolve)); }
}

// ---- 4. quest refresh: the manual press runs, the automatic look stops before its stamp (CE2) ----
async function questArm() {
  const f = SidecarFixture.create({ prefix: 'sk-auxquest-', env: Object.assign({}, COMMON, { SKYNET_SKILL_REVIEW: '0' }) });
  const status = async () => (await f.request('/api/quests/refresh')).json();
  try {
    await f.start();
    await cliReady(f);
    // A roster alone is held until the first accepted station save. Found the station through its real door:
    // an automatic quest look must remain inert on an unfounded workspace, regardless of seeded soft evidence.
    const foundedAt = Date.now();
    const founded = await f.json('POST', '/api/save', { schema: 'starnet.save', version: 6, updatedAt: foundedAt,
      _saveRevision: 0, _saveDirty: true, _saveClient: 'aux-ceiling-test',
      agent: { id: 'agent', name: 'NOVA', createdAt: foundedAt }, agents: [],
      workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    A.eq(founded.status, 200, 'the founding station save is accepted');
    A.eq(founded.body && founded.body.ok, true, 'the founding station save is durable');
    const lineage = await f.json('GET', '/api/lineage');
    A.eq(lineage.body && lineage.body.lineage && lineage.body.lineage.station && lineage.body.lineage.station.state, 'active', 'the automatic quest fixture has a founded station');
    A.eq((await f.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'NOVA', provider: 'claude-cli', model: 'haiku' }] })).status, 200, 'the station runs on the Claude sign-in');
    await f.stop();
    // the same seeds as questrefresh.e2e: the tick needs a posture that may act, and a never-cycled state is due at the boot look.
    // The first boot's look may have stamped already, so its record goes too.
    fs.writeFileSync(path.join(f.workspace, '_commander.autonomy.json'), JSON.stringify({ v: 1, posture: { v: 1, initiative: 'propose', reach: 'observe', leashPerDay: 3 }, beliefs: null }));
    fs.writeFileSync(path.join(f.workspace, '_commander.dossier.json'), JSON.stringify({ block: 'COMMANDER DOSSIER\n- Goals: grow the channel' }));
    seed(f, [auxRow('claude-cli', 900000, HOUR)]);
    for (const name of ['_station.questrefresh.json', '_station.questrefresh.json.bak']) fs.rmSync(path.join(f.workspace, name), { force: true });
    await f.start();
    await cliReady(f);
    let s = null;
    for (const until = Date.now() + 15000; Date.now() < until;) {
      s = await status();
      if ((s.ledger || []).some(e => /token ceiling/.test(e.reason || ''))) break;
      await sleep(200);
    }
    A.ok((s.ledger || []).some(e => e.outcome === 'skipped' && /token ceiling/.test(e.reason || '')), 'the automatic look says why it stopped: ' + JSON.stringify(s.ledger));
    A.eq(Number(s.lastCycleAt || 0), 0, 'a blocked look spends no cycle: the cadence was not stamped');
    const noted = (s.ledger || []).length;

    const r = await fetch(f.baseUrl + '/api/quests/refresh/run', { method: 'POST', headers: { 'X-StarNet-Token': f.token, Origin: f.baseUrl } });
    A.eq((await r.json()).started, true, 'the manual press starts at the ceiling');
    let after = null;
    for (const until = Date.now() + 15000; Date.now() < until;) {
      after = await status();
      if ((after.ledger || []).length > noted) break;
      await sleep(200);
    }
    const added = (after.ledger || []).slice(noted);
    A.ok(added.length >= 1 && !added.some(e => /token ceiling/.test(e.reason || '')), 'and the cycle really ran past the gate: ' + JSON.stringify(added));
    A.ok(Number(after.lastCycleAt || 0) > 0, 'the manual cycle stamps the cadence like any other');
  } finally { await f.dispose(); }
}

(async () => {
  try {
    await concurrentArm();
    await ceilingArm();
    await scopeArm();
    await ollamaArm();
    await questArm();
  } finally {
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('aux-token-ceiling.e2e.test');
})().catch(e => { console.log('FAIL: aux-token-ceiling.e2e.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
