/* node test/effort-truth.e2e.test.js — EFFORT TRUTH (cost lanes W1.5 + W1.12): the effort a record names is the effort the
   provider was actually given, on every path, and the background loops run low. The real sidecar (SidecarFixture), a FAKE
   `claude` that logs its argv, and a mock OpenRouter that logs each request's reasoning field. No network, no real CLI, no
   model spend.

   CLAUDE-CLI ARM. claude-cli takes an effort only per request (--effort); a main run sends none (the dock's effort is not
   wired to the CLI), so the CLI runs on its own default and the record must say 'cli-default', never the level the station
   was set to: dock high, /fast minimal, a class-high specialist, an internal run that keeps the Commander's effort. An
   internal self-talk run, every post-run pass, the nudge-due skill review and a manual quest refresh run at --effort low,
   and each record or ledger row says 'low'. The rule checked on every spawn: the record = the argv's --effort, or
   'cli-default' when the argv has none.

   OPENROUTER ARM. A high-effort run's skill review is a background tool loop: it goes out at reasoning effort low (it used to
   inherit the run's high), a /fast run's review stays at minimal (a loop is only ever lowered), the main run keeps the
   Commander's effort, and every ledger row names the effort its request carried. */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MARK = 'EFFORT_TRUTH_PROBE';
const LONG = ('I rebuilt the staging rollback path end to end. Here is the write-up with the reasoning and the follow-ups worth remembering. ').repeat(40);

// which background pass a spawn is, read from its system prompt (each pass writes its own)
const KINDS = [
  ['skill-review', /skillbase maintenance worker/], ['skill-curator', /quiet StarNet skill curator/], ['reflection', /reflecting right after finishing a task/],
  ['quest-refresh', /quest master/], ['study', /durable profile/], ['threadmine', /surface ideas/], ['scout', /recipe author|recruiter|recurring, specific work topics/]
];

const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
let system = '';
try { const p = val('--system-prompt-file'); system = p ? fs.readFileSync(p, 'utf8') : ''; } catch (_) {}
const probe = (system.match(/${MARK}:([a-z0-9-]+)/) || [])[1] || '';
const kinds = ${JSON.stringify(KINDS.map(([k, re]) => [k, re.source]))};
const kind = probe ? 'main' : ((kinds.find(([, re]) => new RegExp(re).test(system)) || ['other'])[0]);
const log = o => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + '\\n');
log({ ev: 'start', probe, kind, model: val('--model'), effort: val('--effort'), hasEffortFlag: args.indexOf('--effort') >= 0 });
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  const text = kind === 'main' ? ${JSON.stringify(LONG)} : 'nothing durable.';
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } });
  log({ ev: 'end', probe, kind });
});
`;

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-efforttruth-'));
const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
const shim = path.join(fakeRoot, 'claude.cmd');
fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
const logFile = path.join(fakeRoot, 'calls.log');
fs.writeFileSync(logFile, '');
const home = path.join(fakeRoot, 'home');
fs.mkdirSync(home);
const cliLog = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const spawns = () => cliLog().filter(c => c.ev === 'start');
const rowsOf = f => { try { return fs.readFileSync(path.join(f.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };

// every child ended, the ledger stopped growing, and nothing new started for 1.5 s
async function settleCli(f) {
  let last = '', since = Date.now();
  for (const until = Date.now() + 30000; Date.now() < until;) {
    const l = cliLog(), started = l.filter(c => c.ev === 'start').length, ended = l.filter(c => c.ev === 'end').length;
    const sig = started + '/' + ended + '/' + rowsOf(f).length;
    if (sig !== last) { last = sig; since = Date.now(); }
    else if (started === ended && Date.now() - since >= 1500) return;
    await sleep(150);
  }
  throw new Error('the claude-cli children did not settle: ' + last);
}

async function runOn(f, body) {
  const r = await f.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await r.text();
  A.eq(r.status, 200, 'fixture: /api/run opened for ' + body.agentId + (r.status === 200 ? '' : ': ' + raw.slice(0, 300)));
  const ev = raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
  return (ev.filter(e => e.name === 'agent.run.end').pop() || { payload: {} }).payload.reason;
}

const asSent = spawn => spawn.effort || 'cli-default';   // what the CLI was given: its --effort, or nothing (its own default)
const one = list => Array.from(new Set(list));

async function cliArm() {
  const f = SidecarFixture.create({ prefix: 'sk-efforttruth-cli-', timeoutMs: 60000, env: {
    HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: logFile, STARNET_CLAUDE_CLI_PERSIST: '0', STARNET_DEBUG_CHANNELS: '1',
    SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW_EVERY: '1', SKYNET_SKILL_CURATOR: '0', STARNET_DEFAULT_MODEL: 'haiku' } });
  try {
    await f.start();
    const st = await f.json('GET', '/api/auth/claude-cli/status');
    A.eq([st.status, st.body && st.body.installed, st.body && st.body.loggedIn], [200, true, true], 'fixture: the fake CLI is installed and signed in');
    const roster = await f.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'ADA', provider: 'claude-cli', model: 'haiku', reasoningEffort: null },
      { agentId: 'engineer-1', name: 'ENGINEER', provider: 'claude-cli', model: 'claude-opus-5-5', reasoningEffort: 'high', role: 'specialist' }] });
    A.eq(roster.status, 200, 'fixture: the roster runs on the Claude sign-in, with a class-high specialist');

    const base = { provider: 'claude-cli', model: 'claude-opus-5-5', placed: [], messages: [{ role: 'user', content: 'Roll back the staging path and write up what changed.' }] };
    const probes = [
      { probe: 'dock-high', body: { agentId: 'probe-high', isTask: true, reasoningEffort: 'high' } },
      { probe: 'fast', body: { agentId: 'probe-fast', isTask: true, reasoningEffort: 'minimal' } },
      { probe: 'specialist', body: { agentId: 'engineer-1', isTask: true } },
      { probe: 'keep', body: { agentId: 'probe-keep', isTask: false, internal: true, keepEffort: true, reasoningEffort: 'high' } },
      { probe: 'selftalk', body: { agentId: 'probe-self', isTask: false, internal: true, reasoningEffort: 'high' } }
    ];
    for (const p of probes) {
      const reason = await runOn(f, Object.assign({}, base, { system: MARK + ':' + p.probe + ': you are Ada.' }, p.body));
      A.eq(reason, 'done', 'fixture: the ' + p.probe + ' run finished');
      await settleCli(f);
    }

    // a manual quest refresh: it needs something to ground quests in, and a model for the standalone call (STARNET_DEFAULT_MODEL)
    const dossier = await f.json('POST', '/api/dossier', { block: 'COMMANDER DOSSIER\n- Goals: grow the channel to 10k subscribers\n- Works on: weekly video essays' });
    A.eq(dossier.body && dossier.body.admitted, true, 'fixture: the dossier is admitted as quest evidence');
    const before = spawns().length;
    const press = await f.json('POST', '/api/quests/refresh/run', {});
    A.eq(press.body && press.body.started, true, 'fixture: the manual quest refresh started');
    for (const until = Date.now() + 15000; Date.now() < until && !spawns().slice(before).some(s => s.kind === 'quest-refresh');) await sleep(150);
    await settleCli(f);

    const all = spawns();
    const runs = ((await f.json('GET', '/api/runs?agent=*&limit=100')).body || {}).runs || [];
    const rows = rowsOf(f);
    if (process.env.EFFORT_TRUTH_DEBUG) console.error(JSON.stringify({ spawns: all.map(s => [s.probe || s.kind, s.effort]), runs: runs.map(r => [r.agentId, r.reasoningEffort]), rows: rows.map(r => [r.aux || r.agentId, r.reasoningEffort]) }));

    // MAIN PATHS: the record (and the run's ledger row) = what the CLI's argv carried
    for (const p of probes) {
      const mine = all.filter(s => s.probe === p.probe);
      A.ok(mine.length >= 1, 'fixture: the ' + p.probe + ' run reached the CLI');
      const sent = one(mine.map(asSent));
      const rec = runs.find(r => r.agentId === p.body.agentId) || {};
      const row = rows.find(r => !r.aux && r.agentId === p.body.agentId) || {};
      A.eq(sent.length, 1, p.probe + ': every turn of the run was given the same effort (' + JSON.stringify(sent) + ')');
      A.eq(rec.reasoningEffort, sent[0], p.probe + ': the run record names what the CLI was given (argv ' + JSON.stringify(mine.map(s => s.effort)) + ', record ' + JSON.stringify(rec.reasoningEffort) + ')');
      A.eq(row.reasoningEffort, sent[0], p.probe + ': the run\'s ledger row names it too (' + JSON.stringify(row.reasoningEffort) + ')');
    }
    A.eq(one(all.filter(s => ['dock-high', 'fast', 'specialist', 'keep'].includes(s.probe)).map(asSent)), ['cli-default'],
      'a main run (dock high, /fast, class-high specialist, keepEffort) gets no --effort: the CLI default, recorded as cli-default, never high or minimal');
    A.eq(one(all.filter(s => s.probe === 'selftalk').map(asSent)), ['low'], 'an internal self-talk run goes out at --effort low');

    // BACKGROUND PATHS: every pass spawned at --effort low, and each pass's ledger row names the effort its spawns carried
    const aux = all.filter(s => !s.probe);
    A.ok(aux.length >= 3, 'fixture: background passes reached the CLI (' + aux.length + ')');
    A.eq(aux.filter(s => s.kind === 'other').map(s => s.kind), [], 'fixture: every background spawn is a known pass');
    A.eq(one(aux.map(asSent)), ['low'], 'every background pass spawned at --effort low (' + JSON.stringify(aux.map(s => [s.kind, s.effort])) + ')');
    for (const kind of ['skill-review', 'quest-refresh', 'reflection']) A.ok(aux.some(s => s.kind === kind), 'fixture: the ' + kind + ' pass ran');
    const auxRows = rows.filter(r => r.aux && r.provider === 'claude-cli');
    for (const kind of one(auxRows.map(r => r.aux))) {
      const sent = one(aux.filter(s => s.kind === kind).map(asSent));
      A.eq(sent.length, 1, kind + ': fixture: its spawns carried one effort (' + JSON.stringify(sent) + ')');
      A.eq(one(auxRows.filter(r => r.aux === kind).map(r => r.reasoningEffort)), sent, kind + ': its ledger row names the effort its spawn was given');
    }
    A.ok(auxRows.some(r => r.aux === 'skill-review' && r.reasoningEffort === 'low'), 'the skill review ran low and its row says so');
    A.ok(auxRows.some(r => r.aux === 'quest-refresh' && r.reasoningEffort === 'low'), 'the quest refresh ran low and its row says so');
  } finally { await f.dispose(); }
}

// ---- OPENROUTER ARM ---------------------------------------------------------------------------------------------------
function startMock() {
  const calls = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'run/model', context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const sys = ((body.messages || []).find(m => m && m.role === 'system') || {}).content;
        const sysText = typeof sys === 'string' ? sys : JSON.stringify(sys || '');
        const kind = raw.indexOf('[RUNTIME]') >= 0 ? 'main' : ((KINDS.find(([, re]) => re.test(sysText)) || ['other'])[0]);
        calls.push({ kind, effort: body.reasoning ? body.reasoning.effort || null : null });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: kind === 'main' ? LONG : 'nothing durable.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

async function openrouterArm() {
  const mock = await startMock();
  const f = SidecarFixture.create({ prefix: 'sk-efforttruth-or-', timeoutMs: 60000, env: { SKYNET_OPENROUTER_BASE: mock.base, SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1',
    SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW_EVERY: '1', SKYNET_SKILL_CURATOR: '0' } });
  const settle = async () => {
    let last = -1, since = Date.now();
    for (const until = Date.now() + 15000; Date.now() < until;) {
      const n = mock.calls.length + rowsOf(f).length;
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= 1500) return;
      await sleep(150);
    }
  };
  try {
    await f.start();
    await sleep(600);   // the mocked catalog warms: run/model reads as reasoning-capable (OpenRouter's guessed ladder, none..max)
    const runs = {};
    for (const [agentId, effort] of [['or-high', 'high'], ['or-fast', 'minimal']]) {
      const from = mock.calls.length;
      const reason = await runOn(f, { key: 'sk-or-v1-efforttruth-fake', model: 'run/model', agentId, isTask: true, reasoningEffort: effort,
        messages: [{ role: 'user', content: 'Rebuild the staging deploy rollback path and write up what changed and why' }] });
      A.eq(reason, 'done', 'fixture: the ' + agentId + ' run finished');
      await settle();
      runs[agentId] = mock.calls.slice(from);
    }
    const high = runs['or-high'], fast = runs['or-fast'];
    A.ok(high.some(c => c.kind === 'skill-review') && fast.some(c => c.kind === 'skill-review'), 'fixture: each run fired its nudge-due skill review');
    A.eq(one(high.filter(c => c.kind === 'main').map(c => c.effort)), ['high'], 'the main run keeps the Commander\'s effort (high)');
    A.eq(one(high.filter(c => c.kind === 'skill-review').map(c => c.effort)), ['low'], 'the skill review of a high run goes out at low (it used to inherit high)');
    A.eq(one(fast.filter(c => c.kind === 'skill-review').map(c => c.effort)), ['minimal'], 'the skill review of a /fast run stays at minimal: a background loop is only ever lowered');

    const recs = ((await f.json('GET', '/api/runs?agent=*&limit=50')).body || {}).runs || [];
    A.eq((recs.find(r => r.agentId === 'or-high') || {}).reasoningEffort, 'high', 'an HTTP run record still names the effort it ran on');
    const rows = rowsOf(f);
    for (const [agentId, calls] of Object.entries(runs)) {
      for (const kind of one(rows.filter(r => r.aux && r.agentId === agentId).map(r => r.aux))) {
        const wire = one(calls.filter(c => c.kind === kind).map(c => c.effort));
        A.eq(wire.length, 1, agentId + ' ' + kind + ': fixture: its requests carried one effort (' + JSON.stringify(wire) + ')');
        A.eq(one(rows.filter(r => r.aux === kind && r.agentId === agentId).map(r => r.reasoningEffort)), wire, agentId + ' ' + kind + ': its ledger row names the effort on the wire');
      }
    }
    A.ok(rows.some(r => r.aux === 'skill-review' && r.agentId === 'or-high' && r.reasoningEffort === 'low'), 'the high run\'s skill-review row says low');
  } finally { await f.dispose(); await new Promise(r => mock.server.close(r)); }
}

(async () => {
  try {
    await cliArm();
    await openrouterArm();
  } finally {
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('effort-truth.e2e.test');
})().catch(e => { console.log('FAIL: effort-truth.e2e.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
