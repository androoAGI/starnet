/* node test/claude-cli-effort.e2e.test.js — WIRE THE CLAUDE-CLI EFFORT, end to end (cost audit W3.8, STARNET_CLI_EFFORT).

   The real sidecar (SidecarFixture) and a FAKE `claude` that logs the argv it is started with. One station, restarted on
   the same workspace for each value of the switch, makes the same runs:

     overseer-high     the Overseer, whose high the Commander picked (the roster row carries the pick mark)
     class-high        a specialist whose high its class wrote, the dial mirroring it in the request body
     class-nobody      the same specialist run with no effort in the body (a routine, a worker): its row's effort
     picked-max        an agent pinned to max by hand: never capped
     picked-low        an agent pinned to low by hand
     fast              an agent the Commander ran /fast on (minimal): the CLI's lowest level
     haiku45           a picked high on Haiku 4.5, which takes no effort
     sonnet46          a picked xhigh on Sonnet 4.6, which has no xhigh
     follows-station   an unpinned agent with no effort of its own, on the station's pair: the Overseer's picked high
     dial-unbacked     a body effort no marked row backs (max on an agent that follows a station picked at high)
     keep              an internal run that keeps the Commander's effort (keepEffort)
     selftalk          an internal self-talk run: the aux effort, low, whatever the switch says
   and the post-run background passes each task run starts (reflection, skill review, ...).

   THE RULE, on every spawn, in every arm: the run record and the ledger row name exactly the child's --effort, or
   'cli-default' when its argv carries none.
     off     (unset)  no main run gets --effort: the argv is the one the base commit started (checked here spelled out, and
                      against 57c741da7's own sources with this file's dump). GET /api/providers says nothing of the switch.
     picked           only the picked efforts are sent, clamped; the class-applied high and the unbacked dial stay cli-default.
     all              every run's effort is sent, clamped.
   Self-talk and the background passes run low in all three (none at all on a model that takes no effort, once the
   switch is on). POST /api/agent/model with an effort is a hand pick: the next run of that agent carries it.

   No network, no real CLI, no model spend. CLI_EFFORT_E2E_DUMP=<dir> writes each arm's spawns there. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const E = require('../sidecar/providers/effort-clamp.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MARK = 'CLI_EFFORT_PROBE';
const LONG = ('I rebuilt the staging rollback path end to end. Here is the write-up with the reasoning and the follow-ups worth remembering. ').repeat(40);
const CORRECTION = ' Next time, write up what changed before you start.';   // gives a nudge-due skill review something to learn from
const KINDS = [
  ['skill-review', /skillbase maintenance worker/], ['skill-curator', /quiet StarNet skill curator/], ['reflection', /reflecting right after finishing a task/],
  ['quest-refresh', /quest master/], ['study', /durable profile/], ['threadmine', /surface ideas/], ['scout', /recipe author|recruiter|recurring, specific work topics/]
];
const ARGV_HEAD = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence'];

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
const at = args.indexOf('--system-prompt-file');
const argv = args.map((a, i) => (at >= 0 && i === at + 1) ? '<system-prompt-file>' : a);
const log = o => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + '\\n');
log({ ev: 'start', probe, kind, model: val('--model'), effort: val('--effort'), argv, envLevel: process.env.CLAUDE_CODE_EFFORT_LEVEL || null });
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

const OPUS = 'claude-opus-5-5';
const ROSTER = [
  { agentId: 'agent', name: 'ADA', provider: 'claude-cli', model: OPUS, reasoningEffort: 'high', effortPicked: true },
  { agentId: 'engineer-1', name: 'ENGINEER', provider: 'claude-cli', model: OPUS, reasoningEffort: 'high', effortSource: 'class', role: 'specialist' },
  { agentId: 'max-1', name: 'MAXIE', provider: 'claude-cli', model: 'claude-sonnet-5-5', reasoningEffort: 'max', effortPicked: true, role: 'specialist' },
  { agentId: 'low-1', name: 'LOWE', provider: 'claude-cli', model: OPUS, reasoningEffort: 'low', effortPicked: true, role: 'specialist' },
  { agentId: 'fast-1', name: 'FASTIE', provider: 'claude-cli', model: OPUS, reasoningEffort: 'minimal', effortPicked: true, role: 'specialist' },
  { agentId: 'haiku-1', name: 'HAIKU', provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high', effortPicked: true, role: 'specialist' },
  { agentId: 's46-1', name: 'SONNET', provider: 'claude-cli', model: 'claude-sonnet-4-6', reasoningEffort: 'xhigh', effortPicked: true, role: 'specialist' },
  { agentId: 'follow-1', name: 'FOLLOWER', role: 'specialist' }
];
// [probe, request body, what the child's --effort is under off / picked / all (null = no flag: 'cli-default')]
const dial = (agentId, model, effort) => ({ agentId, isTask: true, provider: 'claude-cli', model, reasoningEffort: effort });
const PROBES = [
  ['overseer-high', dial('agent', OPUS, 'high'), [null, 'high', 'high']],
  ['class-high', dial('engineer-1', OPUS, 'high'), [null, null, 'high']],
  ['class-nobody', { agentId: 'engineer-1', isTask: true, provider: 'claude-cli', model: OPUS }, [null, null, 'high']],
  ['picked-max', dial('max-1', 'claude-sonnet-5-5', 'max'), [null, 'max', 'max']],
  ['picked-low', dial('low-1', OPUS, 'low'), [null, 'low', 'low']],
  ['fast', dial('fast-1', OPUS, 'minimal'), [null, 'low', 'low']],
  ['haiku45', dial('haiku-1', 'claude-haiku-4-5-20251001', 'high'), [null, null, null]],
  ['sonnet46', dial('s46-1', 'claude-sonnet-4-6', 'xhigh'), [null, 'max', 'max']],
  ['follows-station', { agentId: 'follow-1', isTask: true, provider: 'claude-cli', model: OPUS }, [null, 'high', 'high']],
  ['dial-unbacked', dial('follow-1', OPUS, 'max'), [null, null, 'max']],
  ['keep', { agentId: 'agent', isTask: false, internal: true, keepEffort: true, provider: 'claude-cli', model: OPUS, reasoningEffort: 'high' }, [null, 'high', 'high']],
  ['selftalk', { agentId: 'agent', isTask: false, internal: true, provider: 'claude-cli', model: OPUS, reasoningEffort: 'high' }, ['low', 'low', 'low']]
];
const MODES = ['off', 'picked', 'all'];
const effortModel = id => ({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' })[id] || id;   // the adapter's aliases

(async () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-effort-e2e-'));
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
  const dumpDir = String(process.env.CLI_EFFORT_E2E_DUMP || '').trim();

  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_|CLAUDE_CODE_)/i.test(k)) env[k] = '';
  }
  delete process.env.STARNET_CLI_EFFORT; delete process.env.SKYNET_CLI_EFFORT;   // the first arm is the switch UNSET
  delete env.STARNET_CLI_EFFORT; delete env.SKYNET_CLI_EFFORT;
  Object.assign(env, { HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: logFile, STARNET_CLAUDE_CLI_PERSIST: '0', STARNET_DEBUG_CHANNELS: '1',
    SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW_EVERY: '1', SKYNET_SKILL_CURATOR: '0', STARNET_DEFAULT_MODEL: 'haiku', SKYNET_QUEST_REFRESH: '0', STARNET_LIVE_PRICES: '0' });
  const f = SidecarFixture.create({ prefix: 'sk-cli-effort-', timeoutMs: 90000, env });
  const rowsOf = () => { try { return fs.readFileSync(path.join(f.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  // every child ended, the ledger stopped growing, and nothing new started for 1.5 s
  async function settle() {
    let last = '', since = Date.now();
    for (const until = Date.now() + 60000; Date.now() < until;) {
      const l = cliLog(), started = l.filter(c => c.ev === 'start').length, ended = l.filter(c => c.ev === 'end').length;
      const sig = started + '/' + ended + '/' + rowsOf().length;
      if (sig !== last) { last = sig; since = Date.now(); }
      else if (started === ended && Date.now() - since >= 1500) return;
      await sleep(150);
    }
    throw new Error('the claude-cli children did not settle: ' + last);
  }
  async function run(label, probe, body) {
    const r = await f.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ placed: [], system: MARK + ':' + probe + ': you are Ada.',
      messages: [{ role: 'user', content: 'Roll back the staging path and write up what changed.' + CORRECTION }] }, body)) });
    const raw = await r.text();
    A.eq(r.status, 200, label + ': fixture: /api/run opened' + (r.status === 200 ? '' : ': ' + raw.slice(0, 300)));
    const ev = raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const end = (ev.filter(e => e.name === 'agent.run.end').pop() || { payload: {} }).payload;
    A.eq(end.reason, 'done', label + ': fixture: the run finished');
    return end.runId || (ev.find(e => e.name === 'agent.run.start') || { payload: {} }).payload.runId || '';
  }
  const asSent = s => s.effort || 'cli-default';
  const one = list => Array.from(new Set(list));

  async function arm(mode) {
    const at = MODES.indexOf(mode), from = spawns().length, rowsFrom = rowsOf().length;
    await f.start(mode === 'off' ? {} : { STARNET_CLI_EFFORT: mode });
    const st = await f.json('GET', '/api/auth/claude-cli/status');
    A.eq([st.status, st.body && st.body.installed, st.body && st.body.loggedIn], [200, true, true], mode + ': fixture: the fake CLI is installed and signed in');
    A.eq((await f.json('POST', '/api/roster', { updatedAt: Date.now(), agents: ROSTER })).status, 200, mode + ': fixture: the roster (the same rows, pick marks included, in every arm)');
    const prov = await f.json('GET', '/api/providers');
    A.eq(prov.body && prov.body.cliEffort, mode === 'off' ? undefined : mode, mode + ': GET /api/providers ' + (mode === 'off' ? 'says nothing of the switch' : 'says the switch is ' + mode));
    const cat = await f.json('GET', '/api/models/claude-cli');
    const efforts = id => ((((cat.body && cat.body.models) || []).find(m => m.id === id)) || {}).reasoningEfforts;
    A.eq([efforts(OPUS), efforts('claude-sonnet-4-6'), efforts('claude-haiku-4-5-20251001')],
      mode === 'off' ? [E.CLI_FLAG_LEVELS, E.CLI_FLAG_LEVELS, E.CLI_FLAG_LEVELS] : [['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'max'], []],
      mode + ': the catalog publishes ' + (mode === 'off' ? 'the flat list, as before' : 'each model\'s own levels'));

    const ids = {};
    for (const [probe, body] of PROBES) { ids[probe] = await run(mode + ' ' + probe, probe, body); await settle(); }
    // a hand pick through the terminal's route (no page is listening): the next run of that agent carries it
    const pin = await f.json('POST', '/api/agent/model', { agentId: 'engineer-1', model: OPUS, provider: 'claude-cli', effort: 'max' });
    A.eq([pin.status, pin.body && pin.body.ok], [200, true], mode + ': fixture: POST /api/agent/model set engineer-1 to max');
    ids['terminal-pick'] = await run(mode + ' terminal-pick', 'terminal-pick', dial('engineer-1', OPUS, 'max'));
    await settle();

    const all = spawns().slice(from);
    const runs = ((await f.json('GET', '/api/runs?agent=*&limit=200')).body || {}).runs || [];
    const rows = rowsOf().slice(rowsFrom);
    await f.stop();
    if (dumpDir) { fs.mkdirSync(dumpDir, { recursive: true }); fs.writeFileSync(path.join(dumpDir, mode + '.json'), JSON.stringify(all.map(s => ({ probe: s.probe, kind: s.kind, argv: s.argv, envLevel: s.envLevel })), null, 1)); }
    if (process.env.CLI_EFFORT_E2E_DEBUG) console.error(JSON.stringify({ mode, spawns: all.map(s => [s.probe || s.kind, s.model, s.effort]), runs: runs.map(r => [r.agentId, r.runId, r.reasoningEffort]) }));

    const table = PROBES.map(([probe, body, want]) => [probe, body, want[at]]).concat([['terminal-pick', dial('engineer-1', OPUS, 'max'), mode === 'off' ? null : 'max']]);
    for (const [probe, body, want] of table) {
      const mine = all.filter(s => s.probe === probe);
      A.ok(mine.length >= 1, mode + ' ' + probe + ': fixture: the run reached the CLI');
      const sent = one(mine.map(asSent));
      A.eq(sent, [want || 'cli-default'], mode + ' ' + probe + ': the child\'s --effort (' + JSON.stringify(mine.map(s => s.effort)) + ')');
      const rec = runs.find(r => r.runId === ids[probe]) || {};
      const row = rows.find(r => !r.aux && r.runId === ids[probe]) || {};
      A.eq(rec.reasoningEffort, sent[0], mode + ' ' + probe + ': the run record names exactly what the argv carried');
      A.eq(row.reasoningEffort, sent[0], mode + ' ' + probe + ': and so does the run\'s ledger row');
      // nothing else in the argv moved: the base commit's argv, plus --effort after --model when one is sent
      const model = body.model || OPUS;
      for (const s of mine) A.eq(s.argv, ARGV_HEAD.concat(['--model', model], s.effort ? ['--effort', s.effort] : [], ['--system-prompt-file', '<system-prompt-file>']), mode + ' ' + probe + ': the argv is the base commit\'s' + (s.effort ? ' with --effort after --model' : ''));
    }
    // the background passes: low in every arm (none on a model that takes no effort, once the switch is on), and each row says so
    const aux = all.filter(s => !s.probe);
    A.ok(aux.length >= 3, mode + ': fixture: background passes reached the CLI (' + aux.length + ')');
    A.eq(aux.filter(s => s.kind === 'other').map(s => s.kind), [], mode + ': fixture: every background spawn is a known pass');
    const auxWant = s => mode === 'off' ? 'low' : (E.cliEffortFor(effortModel(s.model), 'low') || 'cli-default');
    A.eq(aux.filter(s => asSent(s) !== auxWant(s)).map(s => [s.kind, s.model, s.effort]), [], mode + ': every background pass runs at its own low, never the run\'s effort (' + JSON.stringify(one(aux.map(s => s.kind + ':' + s.model + ':' + asSent(s)))) + ')');
    A.ok(aux.some(s => asSent(s) === 'low'), mode + ': fixture: a background pass ran on a model that takes an effort');
    const auxRows = rows.filter(r => r.aux && r.provider === 'claude-cli');
    A.ok(auxRows.length >= 3, mode + ': fixture: the background passes wrote ledger rows (' + auxRows.length + ')');
    A.eq(auxRows.filter(r => ['low', 'cli-default'].indexOf(r.reasoningEffort) < 0).map(r => [r.aux, r.reasoningEffort]), [], mode + ': every background row names low (or cli-default), never the run\'s effort');
    if (mode === 'off') A.eq(one(auxRows.map(r => r.reasoningEffort)), ['low'], 'off: every background row says low, as before');
    return { all, runs, rows };
  }

  try {
    const off = await arm('off');
    // OFF, the whole arm: no main run of any kind got --effort (self-talk and the passes keep theirs)
    A.eq(one(off.all.filter(s => s.probe && s.probe !== 'selftalk').map(asSent)), ['cli-default'], 'off: no main run gets --effort, whatever the dial, the pick marks or the route it came in by');
    await arm('picked');
    await arm('all');
  } finally {
    await f.dispose();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) { /* a temp folder the OS reaps */ }
  }
  A.report('claude-cli-effort.e2e');
})().catch(e => { console.error(e); process.exit(1); });
