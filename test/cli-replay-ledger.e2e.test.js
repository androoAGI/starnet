/* node test/cli-replay-ledger.e2e.test.js — THE CLAUDE CODE REPLAY LEDGER through the REAL sidecar (cost lane W3.7,
   2026-11-14). Part of test:http.

   test/claude-cli-replay-ledger.test.js locks the ledger and the adapter. This locks the wiring and the real notes: a
   hermetic sidecar (SidecarFixture: temp workspace and profile) runs a COMMS conversation on the claude-cli route against a
   FAKE `claude` (the npm-style .cmd shim beside node_modules/@anthropic-ai/claude-code/cli.js that claude-cli.js runs as
   `node cli.js`; it records its argv, its --system-prompt-file and every stdin line, and answers one line). The page's
   composed lead persona, the starter floor, a COMMS stream, each message posted with the history the page would post.

   1. SWITCH UNSET (the default): no message's first request starts with the last one, the system prompt carries no
      replay sentence, and the usage receipts say why each child was fresh and nothing about a replay.
   2. STARNET_CLI_REPLAY_LEDGER=1 (the same station, restarted): across six messages on one stream, message N+1's first
      request starts with the exact bytes of message N's first request up to its end; its newest entry carries this
      run's own run context (this run's id, and no other entry does), earlier notes sit before it; the system prompt is
      the unset one plus one fixed sentence and is the same on every message; the argv is unchanged; the receipts say
      replay hit and how many entries.
   3. The measured size of the real per-run note and the prefix-stable share, off and on, are printed.
   No real CLI, no sign-in, no inference: nothing here can spend. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const WM = require('../frontend/app/worldmodel.js');
const CLI = require('../sidecar/providers/claude-cli.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPLY = 'Done: the fake CLI answered this message.';

// the `system` the station page sends for its lead (as test/payload.budget.test.js composes it from the page's own functions)
function commsPersona() {
  const dir = path.join(__dirname, '..', 'frontend', 'app');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const FNS = ['liveAgents', 'baseIdentity', 'orchestratorClause', 'agentDocs', 'approvalClause', 'foundationClause', 'rosterClause', 'rosterRole', 'composeSystemPrompt', 'executionProfileOf'];
  const bodies = FNS.map(n => A.fnBody(app, 'function ' + n + '('));
  bodies.forEach((b, i) => A.ok(b.length > 0 && b.length < 20000, 'comms persona: app.js ' + FNS[i] + ' is sliced whole (' + b.length + ' chars)'));
  const ids = /const EXECUTION_PROFILE_IDS = \[[^\]]*\];/.exec(app);
  const ctx = { console, Specialties: require('../frontend/app/specialties.js'), agents: new Map(), DossierStore: { composeBlock: () => '' } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'personas.js'), 'utf8') + '\n;this.Personas = Personas;', ctx);
  vm.runInContext((ids ? ids[0] : '') + '\n' + bodies.join('\n') + '\nthis.__api = { agentDocs, composeSystemPrompt };', ctx);
  const lead = { id: 'agent', name: 'NOVA', role: 'orchestrator', personaId: 'composed', approvalMode: 'ask' };
  ctx.__api.agentDocs(lead);
  ctx.agents.set(lead.id, lead);
  return ctx.__api.composeSystemPrompt(lead);
}

// the fake `claude`: one child serves every stdin line it is given (the persistent path), logging each with its argv and
// system prompt file; a cache read / write on every answer so a receipt has counts to show
const FAKE_CLI = [
  "'use strict';",
  "const fs = require('fs');",
  "const args = process.argv.slice(2);",
  "const out = o => process.stdout.write(JSON.stringify(o) + '\\n');",
  "if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }",
  "if (args[0] === '--version' || args[0] === '-v') { process.stdout.write('2.1.300 (Claude Code)\\n'); process.exit(0); }",
  "const at = args.indexOf('--system-prompt-file');",
  "let system = '';",
  "try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}",
  "let buf = '', said = false;",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', d => {",
  "  buf += d; let nl;",
  "  while ((nl = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: args.map((a, i) => (at >= 0 && i === at + 1 ? '<sysfile>' : a)), system, input: line }) + '\\n');",
  "    if (!said) { said = true; out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] }); }",
  "    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: " + JSON.stringify(REPLY) + " } } });",
  "    out({ type: 'result', subtype: 'success', is_error: false, result: " + JSON.stringify(REPLY) + ", stop_reason: 'end_turn', total_cost_usd: 0,",
  "      usage: { input_tokens: 40, cache_creation_input_tokens: 700, cache_read_input_tokens: 21000, output_tokens: 9 } });",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
  ""
].join('\n');

const ASKS = [
  'Research the three most popular open-source note-taking apps and save a short comparison table to notes/compare.md.',
  'Now add a column for mobile support to that table.',
  'Which one would you pick for a team of five, and why?',
  'Summarize the table in two sentences for the weekly update.',
  'Save that summary to notes/summary.md as well.',
  'What did we decide about mobile support earlier in this conversation?'
];
const ser = blocks => JSON.stringify(blocks);
const size = blocks => Buffer.byteLength(ser(blocks));
const extendsPrev = (prev, cur) => ser(cur).startsWith(ser(prev).slice(0, -1) + ',');
function share(list) {
  let stable = 0, total = 0;
  for (let i = 1; i < list.length; i++) { total += size(list[i]); if (extendsPrev(list[i - 1], list[i])) stable += size(list[i - 1]); }
  return { stable, total, pct: total ? Math.round(1000 * stable / total) / 10 : 0 };
}

(async () => {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', SKYNET_QUEST_REFRESH: '0', STARNET_BUILD_DESCRIBE: 'v0.15.2-0-gcli-replay-e2e' });
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-replay-e2e-'));
  const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(fakeRoot, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  const cliLogFile = path.join(fakeRoot, 'calls.log');
  fs.writeFileSync(cliLogFile, '');
  const cliLog = () => fs.readFileSync(cliLogFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const home = path.join(fakeRoot, 'home');
  fs.mkdirSync(home);
  const fixture = SidecarFixture.create({ prefix: 'starnet-cli-replay-e2e-', timeoutMs: 60000,
    env: Object.assign({}, env, { HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: cliLogFile }) });
  const receiptsFile = path.join(fixture.workspace, '.usage', 'calls.jsonl');
  const receipts = () => { try { return fs.readFileSync(receiptsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  const persona = commsPersona();
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  const placed = starter.map(objectType => ({ objectType }));

  async function ready() {
    A.eq((await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', system: persona, name: 'NOVA', provider: 'claude-cli', model: 'claude-sonnet-5-5',
      role: 'orchestrator', approvalMode: 'ask', executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null }] })).status, 200, 'the lead alone on the roster');
    for (const until = Date.now() + 60000; Date.now() < until; await sleep(250)) {
      const st = await fixture.json('GET', '/api/auth/claude-cli/status');
      if (st.body && st.body.installed && st.body.loggedIn) return;
    }
    A.ok(false, 'the fake CLI is installed and signed in');
  }
  // a conversation of `count` messages on one stream: each message posted with the history the page would post
  async function converse(streamId, count) {
    const history = [], out = [];
    for (let i = 0; i < count; i++) {
      const before = cliLog().length;
      const body = { agentId: 'agent', isTask: true, placed, stationPlaced: placed, system: persona, provider: 'claude-cli', model: 'claude-sonnet-5-5', streamId,
        messages: history.concat([{ role: 'user', content: ASKS[i] }]) };
      let r = null, raw = '';
      for (let k = 0; k < 80; k++) {
        r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        raw = await r.text();
        if (!(r.status === 400 && /checking local sign-in/.test(raw))) break;
        await sleep(250);
      }
      const events = raw.split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      const start = (events.find(e => e.name === 'agent.run.start') || {}).payload || {};
      const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
      A.eq([r.status, end.reason], [200, 'done'], streamId + ' message ' + (i + 1) + ': the run streams through /api/run and finishes: ' + (r.status === 200 ? '' : raw.slice(0, 300)));
      // the run's own call: the one whose system prompt lists tools (the Task Brief intake and other side calls carry none)
      const mains = cliLog().slice(before).filter(c => String(c.system).indexOf('\n\n# Tools\nYou cannot execute anything yourself') >= 0);
      A.eq(mains.length, 1, streamId + ' message ' + (i + 1) + ': exactly one CLI call carries the tools block');
      const main = mains[0] || { input: JSON.stringify({ message: { content: [] } }), system: '', args: [] };
      out.push({ runId: String(start.runId || ''), blocks: JSON.parse(main.input).message.content, system: main.system, args: main.args });
      history.push({ role: 'user', content: ASKS[i] }, { role: 'assistant', content: REPLY });
    }
    return out;
  }
  const noteOf = text => { const m = /<run_context>[\s\S]*?<\/run_context>/.exec(text); return m ? m[0] : ''; };

  try {
    /* 1 — the switch unset */
    await fixture.start();
    await ready();
    const off = await converse('ws_replayoff1', 3);
    const offShare = share(off.map(m => m.blocks));
    A.eq(offShare.stable, 0, '1 (unset): no message\'s first request starts with the last one');
    A.ok(off.every(m => m.system.indexOf(CLI._internals.REPLAY_NOTE) < 0), '1 (unset): the system prompt carries no replay sentence');
    A.ok(off.every((m, i) => m.blocks.length === 2 * i + 1 && m.blocks.slice(0, -1).every(b => b.text.indexOf('<run_context>') < 0)), '1 (unset): history rides bare, as before: no earlier entry carries a note');
    const offRecs = receipts().filter(r => r.provider === 'claude-cli' && off.some(m => m.runId && r.runId === m.runId));
    A.ok(offRecs.length >= 3 && offRecs.every(r => typeof r.child === 'string' && r.child && !('replay' in r)), '1 (unset): each run call\'s receipt says how it was served and nothing about a replay: ' + JSON.stringify(offRecs.map(r => r.child)));
    A.ok(off.every(m => offRecs.some(r => r.runId === m.runId && r.child === 'first' && r.cacheRead === 21000 && r.cacheWrite === 700)), '1 (unset): the run\'s first call says a fresh child (first) beside its cache read and cache write');

    /* 2 — the switch on, the same station */
    await fixture.restart({ STARNET_CLI_REPLAY_LEDGER: '1' });
    await ready();
    const on = await converse('ws_replayon1', 6);
    const onShare = share(on.map(m => m.blocks));
    const notes = on.map(m => Buffer.byteLength(noteOf(m.blocks[m.blocks.length - 1].text)));
    console.log('[replay-ledger e2e] the real per-run note on a fresh station: ' + notes.join(', ') + ' bytes (messages 1-6); prefix-stable share of a first request: unset '
      + offShare.pct + '% -> on ' + onShare.pct + '% (' + onShare.stable + ' of ' + onShare.total + ' bytes)');
    A.ok(notes.every(n => n > 1000), '2: every message carries a real run-context note (' + notes.join(', ') + ' bytes)');
    for (let i = 1; i < on.length; i++) {
      A.ok(extendsPrev(on[i - 1].blocks, on[i].blocks), '2 message ' + (i + 1) + ': ITS FIRST REQUEST STARTS WITH THE EXACT BYTES OF MESSAGE ' + i + '\'S FIRST REQUEST, UP TO ITS END');
    }
    A.ok(onShare.pct > 50, '2: most of every later request is the last request, byte for byte: ' + onShare.pct + '%');
    for (let i = 0; i < on.length; i++) {
      const m = on[i], texts = m.blocks.map(b => b.text), last = texts[texts.length - 1], tag = '2 message ' + (i + 1) + ': ';
      A.ok(/^[A-Za-z0-9-]{8,}$/.test(m.runId), tag + 'the run has an id');
      A.ok(last.indexOf('Run id: ' + m.runId) > 0 && texts.slice(0, -1).every(t => t.indexOf(m.runId) < 0), tag + 'THE NEWEST ENTRY CARRIES THIS RUN\'S OWN RUN CONTEXT, and no earlier entry names this run');
      A.ok(last.lastIndexOf(ASKS[i]) > last.lastIndexOf('</run_context>'), tag + 'the Commander\'s words follow that note');
      A.eq(m.blocks.length, 2 * i + 1, tag + 'no entry is added: one block per history message plus the newest');
      A.ok(texts.every(t => !/<tool_result|<function_calls>/.test(t)), tag + 'history is prose: no tool turn is replayed');
      const earlier = on.slice(0, i).map((p, k) => texts[2 * k].indexOf('Run id: ' + p.runId) > 0);
      A.ok(earlier.every(Boolean), tag + 'each earlier user entry is the one that message was sent with (its own run id inside)');
      A.ok(m.system === on[0].system, tag + 'the system prompt is the same on every message of the stream');
      A.eq(m.args, off[0].args, tag + 'the argv is the unset one');
    }
    A.ok(on[0].system.replace(CLI._internals.REPLAY_NOTE, '') === off[0].system && on[0].system.indexOf(CLI._internals.REPLAY_NOTE) > 0, '2: the system prompt is the unset one plus the one replay sentence');
    const onRecs = receipts().filter(r => r.provider === 'claude-cli' && on.some(m => m.runId && r.runId === m.runId) && r.child === 'first');
    A.eq(on.map(m => { const r = onRecs.find(x => x.runId === m.runId) || {}; return [r.replay, r.replayed || 0]; }), [['none', 0], ['hit', 1], ['hit', 3], ['hit', 5], ['hit', 7], ['hit', 9]],
      '2: each run\'s first receipt says what the ledger did: nothing to replay on the first message, then every entry of the last request');
    A.ok(onRecs.every(r => !/Research|note-taking|run_context/.test(JSON.stringify(r))), '2: the receipts hold identifiers and counts only');
  } finally {
    await fixture.dispose();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cli-replay-ledger.e2e.test');
})().catch(e => { console.log('FAIL: cli-replay-ledger.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
