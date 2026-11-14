/* node test/slim-note.e2e.test.js — THE SLIM PER-RUN NOTE through the REAL sidecar (cost lane, 2026-11-14). Part of test:http.

   Every message a person sends starts a run, and the run's first request carries the host's <run_context> note beside the
   newest user turn. It is new on every message, so no cache ever reads it, on any route. Measured on a fresh station it
   was 2.4 to 3.1 KB a message, of which about 1.5 KB was text whose bytes are the same on every message, and the
   commander evidence listed each recent ask twice. STARNET_SLIM_NOTE=1 (sidecar/slim-note.js; off by default) states a
   recent ask once and moves the paragraphs that never change to the end of the system prompt's cached prefix, which every
   provider reads from cache. test/slim-note.test.js locks the pure halves; this locks the bytes on the wire.

   One hermetic station (SidecarFixture: temp workspace and profile, ASK approval, the page's composed lead persona, the
   starter floor) runs the same script twice, switch unset and switch on, against a recording mock (Anthropic Messages,
   Chat Completions) and a fake `claude`:
     fresh    8 messages of one COMMS chat on the Anthropic wire, nothing saved yet
     chat     a turn that is not a task (no tools on the wire)
     wires    one task message on a plain chat wire and one on a Claude chat wire (the other note placements)
     cli      the claude-cli route: argv, --system-prompt-file and stdin, then the same chat sent with a shorter window
     crew     a lead that dispatches a crew member: the lead's first request and the worker's first request
     seeded   8 messages on the station once it has a dossier, a goal, saved skills, memories, a verdict and a quest

   1. UNSET IS THE BASE, BYTE FOR BYTE. Every one of those requests, with run ids, dates and temp paths masked, hashes to
      what the base commit sent (test/fixtures/slim-note-base.json: recorded from the base's own sources, see RE-RECORD).
   2. ON: THE NOTE. Per message, fresh and seeded: the note is smaller by the moved paragraphs; a recent ask is listed
      once; every line the unset note carried is still in the request (in the note, or in the system prompt, two lines
      re-pointed at their block); recalled memory, the Commander's verdicts and the learned tail ride the newest run
      exactly as before. Sizes before and after are printed.
   3. ON: THE SYSTEM PROMPT. The cached prefix (cacheSystemPrefix, the first system block on the Anthropic wire) is the
      unset one plus the moved paragraphs, and nothing after it changed; prefix, whole system prompt and tool list are
      byte-identical from message to message, fresh and seeded (a moved paragraph never makes the cached prefix change
      per message); the share of a first request a prefix cache can read is printed, before and after.
   4. EVERY ROUTE. The chat turn, both chat wires, the claude-cli system file and stdin, the lead with crew and its worker
      differ from unset only by those moves.
   5. THE CONVERSATION SUMMARY ON CLAUDE-CLI (the lane's third finding, not fixed, pinned here). A <conversation_summary>
      rides the CLI system file after the dynamic boundary. It is the same bytes while the window starts on the same
      turn, and when it changes the transcript's first block has changed with it: the conversation behind it is new
      bytes wherever the summary sits.

   RE-RECORD the base fixture ONLY from the base's own sources: with the lane's sidecar files replaced by
   `git show <base>:<path>`, run `node test/slim-note.e2e.test.js --record <base sha>`, then restore the lane's files.
   SLIM_NOTE_DUMP=<file> writes both arms' requests as captured (the evidence behind the numbers printed).
   No real CLI, no sign-in, no inference: nothing here can spend. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostNotes, lastUserWords, userWords } = require('./helpers/host-notes.js');
const WM = require('../frontend/app/worldmodel.js');

const HOST = '127.0.0.1';
const FIXTURE = path.join(__dirname, 'fixtures', 'slim-note-base.json');
const RECORD = process.argv.indexOf('--record');
const REPLY = 'Done: the mock answered this message.';
const WORKER_MARK = 'You are Ada, the station researcher.';
const WORKER_MODEL = 'anthropic/claude-slim-note-test';   // a Claude id: the Claude projection and cache split on a chat wire
const WORKER_TASK = 'SLIM_WORKER_TASK: list three facts about tide tables.';
const DISPATCH_ASK = 'SLIM_DISPATCH: have the researcher list three facts about tide tables, then report back.';
const DOSSIER = 'WHAT YOU KNOW ABOUT YOUR COMMANDER (the station has learned this — honor it; if anything here is wrong, the Commander will correct it):\n'
  + '- Goals: ship the team wiki migration before the end of the quarter; keep the weekly update under one page\n'
  + '- Style: short answers first, tables over prose, no emojis\n'
  + '- Stack: Markdown notes in a git repo, Obsidian on desktop, a small Node toolchain';
const TASTE = 'The Commander disliked a past summary: too long. Keep summaries to two sentences.';
const ASKS = [
  'Research the three most popular open-source note-taking apps and save a short comparison table to notes/compare.md.',
  'Now add a column for mobile support to that table.',
  'Which one would you pick for a team of five, and why?',
  'Summarize the table in two sentences for the team wiki.',
  'Save that summary to notes/summary.md as well.',
  'What did we decide about mobile support earlier in this conversation?',
  'Draft a short email to the team announcing the pick.',
  'Make the email friendlier and add a line about the migration date.'
];
const SEEDED_ASKS = [
  'Build a comparison table of three wiki engines for the migration.',
  'Add a row for hosting cost to that table.',
  'Which engine fits a team of five with two phone-only users?',
  'Write the weekly update about the wiki pick.',
  'Shorten the weekly update to three bullets.',
  'What is still open before the migration date?',
  'Draft the announcement email for the team.',
  'Make the announcement friendlier and name the migration date.'
];
const CLI_ASKS = [
  'List three risks of moving the wiki during a release week.',
  'Rank those risks by how likely they are.',
  'Which risk should we handle first, and how?',
  'Write that plan as a short checklist.',
  'Add an owner column to the checklist.',
  'Who owns the first item, again?',
  'Turn the checklist into a message for the team channel.'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const bytes = s => Buffer.byteLength(String(s == null ? '' : s));
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : '');
// the system prompt and its cached prefix, on the Anthropic wire (body.system) and on a chat wire (messages[0])
const systemParts = b => b.system !== undefined ? b.system : ((b.messages[0] && b.messages[0].role === 'system') ? b.messages[0].content : '');
const systemOf = b => text(systemParts(b));
const cachedPrefixOf = b => { const c = systemParts(b); return Array.isArray(c) && c.length > 1 && c[0] && c[0].cache_control ? String(c[0].text || '') : ''; };
const noteOf = b => hostNotes(b.messages, 'run_context').join('\n');
const otherNotesOf = b => hostNotes(b.messages).filter(n => n.indexOf('<run_context>') !== 0);

// the `system` the station page sends for its lead (as test/payload.budget.test.js composes it from the page's own functions)
function commsPersona(dossierBlock) {
  const dir = path.join(__dirname, '..', 'frontend', 'app');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const FNS = ['liveAgents', 'baseIdentity', 'orchestratorClause', 'agentDocs', 'approvalClause', 'foundationClause', 'rosterClause', 'rosterRole', 'composeSystemPrompt', 'executionProfileOf'];
  const bodies = FNS.map(n => A.fnBody(app, 'function ' + n + '('));
  bodies.forEach((b, i) => { if (!(b.length > 0 && b.length < 20000)) throw new Error('comms persona: app.js ' + FNS[i] + ' was not sliced whole (' + b.length + ' chars)'); });
  const ids = /const EXECUTION_PROFILE_IDS = \[[^\]]*\];/.exec(app);
  const ctx = { console, Specialties: require('../frontend/app/specialties.js'), agents: new Map(), DossierStore: { composeBlock: () => dossierBlock || '' } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'personas.js'), 'utf8') + '\n;this.Personas = Personas;', ctx);
  vm.runInContext((ids ? ids[0] : '') + '\n' + bodies.join('\n') + '\nthis.__api = { agentDocs, composeSystemPrompt };', ctx);
  const lead = { id: 'agent', name: 'NOVA', role: 'orchestrator', personaId: 'composed', approvalMode: 'ask' };
  ctx.__api.agentDocs(lead);
  ctx.agents.set(lead.id, lead);
  return ctx.__api.composeSystemPrompt(lead);
}

// the recording mock: Anthropic Messages when the body has `system`, Chat Completions otherwise; the lead of the crew
// route settles its brief and dispatches the researcher, everything else answers one line
function startUpstream() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: ['test/model', WORKER_MODEL].map(id => ({ id, context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) }));
    }
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
    if (!body) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.system !== undefined) {
      return res.end('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: REPLY } }) + '\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
    }
    const msgs = body.messages || [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { li = i; break; }
    const words = li >= 0 ? userWords(msgs[li]) : '';
    const called = msgs.slice(li + 1).flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
    let call = null;
    if (tools.length && words.indexOf('SLIM_DISPATCH') === 0 && systemOf(body).indexOf(WORKER_MARK) < 0) {
      if (tools.some(t => t.function && t.function.name === 'brief_proceed') && called.indexOf('brief_proceed') < 0) call = { name: 'brief_proceed', args: { objective: 'Delegate the subtask to the researcher', deliverable: 'The researcher\'s answer' } };
      else if (called.indexOf('team_dispatch') < 0) call = { name: 'team_dispatch', args: { workers: [{ agentId: 'researcher', prompt: WORKER_TASK }] } };
    }
    if (call) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + call.name, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, bodies, root: 'http://' + HOST + ':' + server.address().port })));
}

// the fake `claude`: one child serves every stdin line it is given, logging each with its argv and system prompt file
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

/* ---- one arm: the whole script on one new station ---- */
async function arm(label, extraEnv) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  const up = await startUpstream();
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-slim-note-cli-'));
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
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CLOUD_URL: 'http://127.0.0.1:9', SKYNET_QUEST_REFRESH: '0', STARNET_BUILD_DESCRIBE: 'v0.15.2-0-gslim-note-e2e',
    SKYNET_OPENROUTER_BASE: up.root + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-slim-note-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: cliLogFile }, extraEnv || {});
  const fixture = SidecarFixture.create({ prefix: 'starnet-slim-note-', timeoutMs: 120000, env });
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  const placed = starter.map(objectType => ({ objectType }));
  const persona = commsPersona('');
  const seededPersona = commsPersona(DOSSIER);
  const wires = {
    anthropic: { provider: 'anthropic', baseUrl: up.root + '/v1', key: 'fixture-key', model: 'claude-slim-note-test' },
    custom: { provider: 'custom', baseUrl: up.root + '/v1', key: 'fixture-key', model: 'fixture-model' },
    orClaude: { provider: 'openrouter', model: WORKER_MODEL },
    orChat: { provider: 'openrouter', model: 'test/model' },
    cli: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }
  };
  const rosterLead = sys => ({ agentId: 'agent', system: sys, name: 'NOVA', provider: 'openrouter', model: 'test/model', role: 'orchestrator', approvalMode: 'ask',
    executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null });
  const post = async (label2, route, body) => {
    const r = await fixture.json('POST', route, body);
    if (r.status !== 200) throw new Error(label + ': ' + label2 + ' -> ' + r.status + ' ' + String(r.text).slice(0, 300));
    return r.body;
  };

  // one message through /api/run, read as a stream: a consent card is answered once, as the Commander at the page would
  async function send(o) {
    const fromHttp = up.bodies.length, fromCli = cliLog().length;
    const body = Object.assign({ agentId: 'agent', isTask: o.isTask !== false, placed, stationPlaced: placed, system: o.system || persona, streamId: o.streamId,
      messages: (o.history || []).concat([{ role: 'user', content: o.ask }]) }, wires[o.wire]);
    let r = null;
    for (let k = 0; k < 120; k++) {
      r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 400) break;
      const refusal = await r.text();
      if (!/checking local sign-in/.test(refusal)) throw new Error(label + ': run refused: ' + refusal.slice(0, 300));
      await sleep(250);
    }
    if (r.status !== 200) throw new Error(label + ': run not accepted (' + r.status + ')');
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', runId = '', end = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.name === 'agent.run.start' && !runId && ev.payload && ev.payload.agentId === 'agent') runId = ev.payload.runId;
        if (ev.name === 'agent.run.end' && ev.payload && ev.payload.agentId === 'agent') end = ev.payload;
        if (ev.name === 'permission.prompt') await fixture.json('POST', '/api/consent', { runId: ev.payload.runId || runId, promptId: ev.payload.promptId, decision: 'once' });
      }
    }
    if (!end || end.reason !== 'done') throw new Error(label + ': ' + o.streamId + ' "' + o.ask.slice(0, 40) + '" did not finish: ' + JSON.stringify(end));
    if (o.wire === 'cli') {
      // the run's own call: the one whose system prompt lists tools (the Task Brief intake and other side calls carry none)
      const mains = cliLog().slice(fromCli).filter(c => String(c.system).indexOf('\n\n# Tools\nYou cannot execute anything yourself') >= 0);
      if (mains.length !== 1) throw new Error(label + ': ' + mains.length + ' CLI calls carry the tools block for "' + o.ask.slice(0, 40) + '"');
      return { runId, args: mains[0].args, system: mains[0].system, input: mains[0].input, blocks: JSON.parse(mains[0].input).message.content };
    }
    const sysHead = (o.system || persona).slice(0, 80);
    const mine = up.bodies.slice(fromHttp);
    // the run's first request: this agent's system prompt, and the Commander's words as the newest user turn
    const mains = mine.filter(b => systemOf(b).indexOf(sysHead) === 0 && lastUserWords(b.messages).trim() === o.ask && (o.isTask === false || (Array.isArray(b.tools) && b.tools.length > 0)));
    if (mains.length < 1) throw new Error(label + ': no request carries "' + o.ask.slice(0, 40) + '" (' + mine.length + ' upstream calls)');
    const worker = mine.find(b => systemOf(b).indexOf(WORKER_MARK) === 0 && Array.isArray(b.tools) && b.tools.length > 0) || null;
    return { runId, body: mains[0], worker, calls: mine.length };
  }
  async function converse(wire, streamId, asks, system) {
    const history = [], out = [];
    for (const ask of asks) {
      out.push(await send({ wire, streamId, ask, history, system }));
      history.push({ role: 'user', content: ask }, { role: 'assistant', content: REPLY });
    }
    return out;
  }

  try {
    await fixture.start();
    await post('roster', '/api/roster', { updatedAt: Date.now(), agents: [rosterLead(persona)] });
    for (const until = Date.now() + 90000; ; await sleep(250)) {
      const st = await fixture.json('GET', '/api/auth/claude-cli/status');
      if (st.body && st.body.installed && st.body.loggedIn) break;
      if (Date.now() > until) throw new Error(label + ': the fake CLI never read as installed and signed in');
    }
    const cap = { label, workspace: fixture.workspace, home, root: up.root };
    cap.fresh = await converse('anthropic', 'ws_slim_fresh', ASKS);
    cap.chat = await send({ wire: 'anthropic', streamId: 'ws_slim_chat', ask: 'hello there, how are you today?', isTask: false });
    cap.custom = await send({ wire: 'custom', streamId: 'ws_slim_custom', ask: 'Write a two-line summary of what a wiki is.' });
    cap.orClaude = await send({ wire: 'orClaude', streamId: 'ws_slim_orclaude', ask: 'Name two things a good wiki page needs.' });
    // the claude-cli route: four messages with the whole history, then the same chat with a window that starts later
    cap.cli = await converse('cli', 'ws_slim_cli', CLI_ASKS.slice(0, 4));
    const turns = k => [{ role: 'user', content: CLI_ASKS[k] }, { role: 'assistant', content: REPLY }];
    const win = (from, to) => { let h = []; for (let k = from; k < to; k++) h = h.concat(turns(k)); return h; };
    cap.cliWindow = [
      await send({ wire: 'cli', streamId: 'ws_slim_cli', ask: CLI_ASKS[4], history: win(2, 4) }),   // the window opens on message 3: messages 1-2 are summarized
      await send({ wire: 'cli', streamId: 'ws_slim_cli', ask: CLI_ASKS[5], history: win(2, 5) }),   // the same opening turn
      await send({ wire: 'cli', streamId: 'ws_slim_cli', ask: CLI_ASKS[6], history: win(3, 6) })    // the window moved by one exchange
    ];
    // the crew route: the researcher joins the roster, the lead dispatches it
    await post('roster with crew', '/api/roster', { updatedAt: Date.now(), agents: [rosterLead(persona),
      { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'openrouter', model: WORKER_MODEL, system: WORKER_MARK + ' You research and report plainly.' }] });
    cap.crew = await send({ wire: 'orChat', streamId: 'ws_slim_crew', ask: DISPATCH_ASK });
    if (!cap.crew.worker) throw new Error(label + ': the dispatch never reached the worker (' + cap.crew.calls + ' upstream calls)');
    await post('roster without crew', '/api/roster', { updatedAt: Date.now(), agents: [rosterLead(seededPersona)] });
    // the seeded station: what a station that has been used holds
    await post('dossier', '/api/dossier', { block: DOSSIER });
    await post('goal', '/api/goals', { goal: { title: 'Finish the team wiki migration', text: 'Finish the team wiki migration', milestones: [] } });
    for (const s of [
      { name: 'comparison-table', summary: 'How to build a comparison table the Commander likes: criteria as columns, one row per option', body: 'Step 1. List the criteria.\nStep 2. One row per option.\nStep 3. Save as Markdown.' },
      { name: 'weekly-update', summary: 'Format for the weekly team update: three bullets, one risk, one ask', body: 'Step 1. Three bullets.\nStep 2. One risk.\nStep 3. One ask.' },
      { name: 'wiki-page-move', summary: 'Steps to move a page to the new wiki without breaking links', body: 'Step 1. Copy.\nStep 2. Redirect.\nStep 3. Check links.' }
    ]) await post('skill ' + s.name, '/api/agent-skills/manage', Object.assign({ agentId: 'agent', action: 'create' }, s));
    const day = 86400000, now = Date.now();
    await post('notebook', '/api/notebook/restore', { agent: 'agent', notes: [
      { id: 'note_seed1', title: 'Team size', body: 'The team is five people; two of them work only from phones, so mobile support matters.', ts: now - day },
      { id: 'note_seed2', title: 'Notes location', body: 'Comparison tables and summaries live under notes/ in the wiki repo.', ts: now - 2 * day },
      { id: 'note_seed3', title: 'Email tone', body: 'Team emails should be friendly and under 120 words.', ts: now - 3 * day },
      { id: 'note_seed4', title: 'Migration date', body: 'The wiki migration is planned for the first Monday of December.', ts: now - 4 * day },
      // the Commander's verdict on past work (feedbackmemory.js): it rides every run in its own block
      { id: 'note_seed5', kind: 'profile', title: 'Preference', body: TASTE, content: TASTE, scope: 'global', streamId: null, projectRoot: null, sourceRunId: 'seed-run-1',
        confirmation: 'user-confirmed', authority: 'reference-only', origin: 'feedback', feedbackVerdict: 'miss', feedbackWords: 'too long', feedbackDirective: 'Summarize the table',
        feedbackGenerated: TASTE, createdAt: now - day, ts: now - day, updatedAt: now - day, lastFeedbackAt: now - day, feedbackAt: now - day, lastUsedAt: null, useCount: 0, trust: 0, pinned: false }
    ] });
    await post('quest', '/api/quests/mint', { title: 'Publish the wiki engine recommendation to the team', contract: { type: 'attest', key: '' }, domain: 'research',
      groundedIn: 'the Commander is choosing a wiki engine for a team of five' });
    cap.seeded = await converse('anthropic', 'ws_slim_seeded', SEEDED_ASKS, seededPersona);
    return cap;
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ---- what differs from one boot (or one day) to the next, masked: run and brief ids, today's date, every calendar day
   (a memory's saved day, a verdict's day), the app version, temp paths, the mock's port ---- */
function masker(cap) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = [];
  for (const p of [cap.workspace, cap.home, os.tmpdir()]) {
    if (!p) continue;
    for (const v of [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\'), p.replace(/\\/g, '\\\\\\\\')]) if (paths.indexOf(v) < 0) paths.push(v);
  }
  paths.sort((a, b) => b.length - a.length);
  const pathRes = paths.map(p => new RegExp(esc(p), 'gi'));
  return s => {
    let t = String(s);
    for (const re of pathRes) t = t.replace(re, '<path>');
    return t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
      .replace(/Today is [A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4} \(/g, 'Today is <date> (')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<day>')
      .replace(/StarNet app version at run start: [^\\\n"]+/g, 'StarNet app version at run start: <version>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/starnet-slim-note-[A-Za-z0-9_-]+/g, 'starnet-slim-note-<tmp>');
  };
}
// every request of an arm, in script order, as { id, sha, bytes, parts } over its masked bytes
function requestsOf(cap) {
  const mask = masker(cap);
  const out = [];
  const httpReq = (id, body) => {
    const parts = { system: sha(mask(JSON.stringify(systemParts(body)))), tools: sha(mask(JSON.stringify(body.tools || null))),
      messages: (body.messages || []).map(m => sha(mask(JSON.stringify(m)))) };
    const whole = mask(JSON.stringify(body));
    out.push({ id, sha: sha(whole), bytes: bytes(whole), parts });
  };
  const cliReq = (id, c) => {
    const args = mask(JSON.stringify(c.args)), system = mask(c.system), input = mask(c.input);
    out.push({ id, sha: sha(args + '\u0000' + system + '\u0000' + input), bytes: bytes(system) + bytes(input),
      parts: { args: sha(args), system: sha(system), blocks: c.blocks.map(b => sha(mask(JSON.stringify(b)))) } });
  };
  cap.fresh.forEach((m, i) => httpReq('fresh message ' + (i + 1) + ' (anthropic)', m.body));
  httpReq('chat turn (anthropic)', cap.chat.body);
  httpReq('task on a plain chat wire (custom)', cap.custom.body);
  httpReq('task on a Claude chat wire (openrouter)', cap.orClaude.body);
  cap.cli.forEach((m, i) => cliReq('claude-cli message ' + (i + 1), m));
  cap.cliWindow.forEach((m, i) => cliReq('claude-cli shorter window ' + (i + 1), m));
  httpReq('lead with crew (openrouter)', cap.crew.body);
  httpReq('crew worker (openrouter)', cap.crew.worker);
  cap.seeded.forEach((m, i) => httpReq('seeded message ' + (i + 1) + ' (anthropic)', m.body));
  return out;
}

// what a prefix cache can read of a first request: the bytes it shares, from the start, with the last message's first
// request (tools, then system, then messages, cache markers left out: they move, the content does not)
function flat(body) {
  const strip = v => JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x));
  return strip(body.tools || []) + '\u0000' + systemOf(body) + '\u0000' + (body.messages || []).map(strip).join('\u0000');
}
function prefixShare(list) {
  let stable = 0, total = 0;
  for (let i = 1; i < list.length; i++) {
    const a = Buffer.from(flat(list[i - 1].body)), b = Buffer.from(flat(list[i].body));
    let n = 0; const max = Math.min(a.length, b.length);
    while (n < max && a[n] === b[n]) n++;
    stable += n; total += b.length;
  }
  return { stable, total, uncached: total - stable, pct: total ? Math.round(10000 * stable / total) / 100 : 0 };
}
const lines = s => String(s).split('\n').map(l => l.trim()).filter(Boolean);
const activity = note => lines(note).filter(l => l.indexOf('- RECENT ACTIVITY: ') === 0).map(l => l.slice('- RECENT ACTIVITY: '.length));
const bare = a => a.replace(/^"(.*)"( \([^)]*\))?$/, '$1$2');   // a quoted chat line as its words

(async () => {
  if (RECORD >= 0) {
    const from = process.argv[RECORD + 1];
    if (!from || /^-/.test(from)) throw new Error('--record needs the base commit the sources are from');
    const cap = await arm('record', {});
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({
      about: 'sha256 of every first request test/slim-note.e2e.test.js drives, as the BASE commit sends it with STARNET_SLIM_NOTE unset (run ids, dates, temp paths and ports masked). '
        + 'The lane must send exactly these with the switch off. Re-record only from the base\'s own sources (see the test header).',
      recordedFrom: from, platform: process.platform, requests: requestsOf(cap) }, null, 1) + '\n');
    console.log('[slim-note e2e] recorded ' + requestsOf(cap).length + ' requests from ' + from + ' (' + process.platform + ')');
    return;
  }

  const off = await arm('unset', {});
  const on = await arm('on', { STARNET_SLIM_NOTE: '1' });
  if (process.env.SLIM_NOTE_DUMP) fs.writeFileSync(process.env.SLIM_NOTE_DUMP, JSON.stringify({ off, on }));   // both arms' requests as captured: the evidence behind the numbers printed
  const SlimNote = require('../sidecar/slim-note.js');
  const QuestInject = require('../sidecar/questinject.js');
  const RuntimeInfo = require('../sidecar/runtimeinfo.js');
  const RuntimeSkills = require('../sidecar/skills/runtime.js');
  const FeedbackMemory = require('../sidecar/feedbackmemory.js');
  const LearnedTail = require('../sidecar/learned-tail.js');

  /* 1 — unset is the base */
  const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const mine = requestsOf(off);
  if (base.platform !== process.platform) {
    console.log('[slim-note e2e] the base fixture was recorded on ' + base.platform + '; this is ' + process.platform + ' (shell line and host words differ), so the byte comparison with the base is skipped here');
  } else {
    A.eq(mine.map(r => r.id), base.requests.map(r => r.id), '1: the script drives the requests the base fixture holds');
    for (let i = 0; i < Math.min(mine.length, base.requests.length); i++) {
      const got = mine[i], want = base.requests[i];
      let where = '';
      if (got.sha !== want.sha) {
        for (const k of Object.keys(want.parts)) {
          const a = got.parts[k], b = want.parts[k];
          if (Array.isArray(b)) { for (let j = 0; j < Math.max(b.length, (a || []).length); j++) if ((a || [])[j] !== b[j]) { where += ' ' + k + '[' + j + ']'; break; } }
          else if (a !== b) where += ' ' + k;
        }
      }
      A.ok(got.sha === want.sha, '1 (unset): ' + want.id + ' IS THE BASE REQUEST, BYTE FOR BYTE (' + got.bytes + ' bytes, base ' + want.bytes + (where ? '; differs in' + where : '') + ')');
    }
  }

  /* 2 + 3 — the note and the system prompt, fresh and seeded */
  const questGuide = QuestInject.split(QuestInject._internals.MINT_ONLY).guide;
  const firstSkill = RuntimeSkills.composeIndex([], { emptyGuide: true, canManage: true }).text.trim();
  const runtimeGuide = RuntimeInfo.splitGuide(RuntimeInfo.runtimeIdentityBlock({ now: 1 })).guide;
  // what leaves the note: the paragraphs as the unset note carried them, each with the blank line or newline that joined it
  const QI = QuestInject._internals;
  const answerLine = runtimeGuide.replace('answer from the [RUNTIME] block of this run\'s context note', 'answer from this block');
  const left = {
    fresh: bytes('\n\n' + firstSkill) + bytes('\n\n' + QI.MINT_DOCTRINE) + bytes('\n' + answerLine),                                   // the first-skill line, the doctrine after "no open quests", the runtime line
    seeded: bytes(QI.HEADER + '\n\n' + QI.MINT_DOCTRINE) - bytes(QI.LIST_HEAD) + bytes('\n' + answerLine)                               // the how-to and doctrine, less the list's one-line head, and the runtime line
  };
  for (const [name, asks, moved] of [['fresh', ASKS, [firstSkill, questGuide, runtimeGuide]], ['seeded', SEEDED_ASKS, [questGuide, runtimeGuide]]]) {
    const a = off[name], b = on[name];
    const sizes = { off: a.map(m => bytes(noteOf(m.body))), on: b.map(m => bytes(noteOf(m.body))) };
    const shareOff = prefixShare(a), shareOn = prefixShare(b);
    console.log('[slim-note e2e] ' + name + ' station, the per-run note in bytes, messages 1-8: unset ' + sizes.off.join(', ') + ' -> on ' + sizes.on.join(', ')
      + ' (mean ' + Math.round(sizes.off.reduce((x, y) => x + y, 0) / 8) + ' -> ' + Math.round(sizes.on.reduce((x, y) => x + y, 0) / 8) + ')');
    console.log('[slim-note e2e] ' + name + ' station, what a prefix cache can read of a first request (messages 2-8): unset ' + shareOff.pct + '% (' + shareOff.uncached
      + ' bytes not read) -> on ' + shareOn.pct + '% (' + shareOn.uncached + ' bytes not read); system prompt ' + bytes(systemOf(a[0].body)) + ' -> ' + bytes(systemOf(b[0].body)) + ' bytes');
    const stable = '\n\n' + moved.join('\n\n');
    // a conversation's first message with the cached prefix warm: what follows the prefix anchor is all a cache cannot read
    const afterAnchor = m => bytes(systemOf(m.body)) - bytes(cachedPrefixOf(m.body)) + bytes(JSON.stringify(m.body.messages, (k, v) => (k === 'cache_control' ? undefined : v)));
    console.log('[slim-note e2e] ' + name + ' station, message 1: cached prefix ' + bytes(cachedPrefixOf(a[0].body)) + ' -> ' + bytes(cachedPrefixOf(b[0].body)) + ' bytes; what follows its anchor (the tail, the note, the words) '
      + afterAnchor(a[0]) + ' -> ' + afterAnchor(b[0]) + ' bytes');
    A.ok(afterAnchor(a[0]) - afterAnchor(b[0]) >= bytes(noteOf(a[0].body)) - bytes(noteOf(b[0].body)), '3 ' + name + ' message 1: with the prefix warm, a new conversation\'s first request has at least the note\'s saving fewer bytes after the prefix anchor ('
      + afterAnchor(a[0]) + ' -> ' + afterAnchor(b[0]) + ')');
    for (let i = 0; i < 8; i++) {
      const tag = '2 ' + name + ' message ' + (i + 1) + ': ', x = a[i].body, y = b[i].body;
      const nx = noteOf(x), ny = noteOf(y), sx = systemOf(x), sy = systemOf(y);
      A.ok(nx && ny && ny.indexOf('Run id: ' + b[i].runId) > 0 && ny.indexOf('<task_brief id="tb_' + b[i].runId + '"') > 0, tag + 'the note still carries this run\'s id and its Task Brief');
      A.ok(lastUserWords(y.messages).trim() === asks[i] && y.messages[y.messages.length - 1].role === 'user', tag + 'the request still ends on the Commander\'s words');
      // a recent ask is listed once
      const ax = activity(nx), ay = activity(ny);
      const repeats = ax.filter(l => !ay.some(m => m === l)).reduce((n, l) => n + bytes('\n\n- RECENT ACTIVITY: ' + l), 0);   // the lines the unset note carried a second time
      A.eq(bytes(nx) - bytes(ny), left[name] + repeats, tag + 'THE NOTE IS SMALLER BY EXACTLY THE MOVED PARAGRAPHS' + (repeats ? ' AND THE REPEATED ASKS' : '') + ' (' + bytes(nx) + ' -> ' + bytes(ny) + ' bytes)');
      A.eq(ay.filter((l, k) => ay.findIndex(m => bare(m) === bare(l)) !== k), [], tag + 'no recent ask is listed twice');
      A.ok(ax.every(l => ay.some(m => bare(m) === bare(l))), tag + 'every recent ask the unset note names is still named: ' + JSON.stringify(ax.filter(l => !ay.some(m => bare(m) === bare(l)))));
      A.ok(ay.length <= 6 && ay.every(l => l.length <= 180), tag + 'the recent activity keeps its own bounds (6 lines of 180 characters)');
      // nothing the model read is gone: every line of the unset note is in the note or in the system prompt
      const mask = masker(off), maskOn = masker(on);
      const here = maskOn(ny) + '\n' + maskOn(sy);
      const lost = lines(mask(nx)).filter(l => {
        if (here.indexOf(l) >= 0) return false;
        if (l.indexOf('- RECENT ACTIVITY: "') === 0) return !ay.some(m => maskOn(bare(m)) === bare(l.slice('- RECENT ACTIVITY: '.length)));   // the same ask, kept as its task line
        if (l.indexOf('MINTING — ') === 0) return here.indexOf(l.replace('NO matching open quest above', 'NO matching open quest in that block')) < 0;
        if (l === answerLine) return here.indexOf(runtimeGuide) < 0;
        return true;
      });
      A.eq(lost, [], tag + 'EVERY LINE OF THE UNSET NOTE IS STILL IN THE REQUEST (the note or the system prompt)');
      // the other host notes: recalled memory and the Commander's verdicts ride the newest run, unchanged
      A.eq(otherNotesOf(y).map(maskOn), otherNotesOf(x).map(mask), tag + 'recalled memory and every other host note are the unset bytes');
      // 3: the system prompt
      const px = cachedPrefixOf(x), py = cachedPrefixOf(y), t3 = '3 ' + name + ' message ' + (i + 1) + ': ';
      A.ok(px && py === px + stable, t3 + 'THE CACHED PREFIX IS THE UNSET ONE PLUS THE MOVED PARAGRAPHS (it closes with them)');
      A.ok(py === cachedPrefixOf(b[0].body), t3 + 'THE CACHED PREFIX IS BYTE-IDENTICAL FROM MESSAGE TO MESSAGE with the switch on');
      A.ok(sy === systemOf(b[0].body), t3 + 'so is the whole system prompt');
      A.eq(JSON.stringify(y.tools), JSON.stringify(b[0].body.tools), t3 + 'and the tool list');
      A.ok(sy === px + stable + sx.slice(px.length), t3 + 'everything after the cached prefix (service keys, the Task Brief doctrine, FINISH THE JOB) is the unset bytes');
      A.ok(JSON.stringify(y.system.map(p => p.cache_control || null)) === JSON.stringify(x.system.map(p => p.cache_control || null)), t3 + 'the cache anchors on the system blocks are the unset ones');
      A.eq(JSON.stringify(y.tools), JSON.stringify(x.tools), t3 + 'the tool list is the unset one');
    }
    A.ok(shareOn.uncached < shareOff.uncached, '3 ' + name + ': fewer bytes of a first request are outside what a prefix cache reads (' + shareOff.uncached + ' -> ' + shareOn.uncached + ')');
  }
  // fresh: the unset note opens with the first-skill paragraph and lists an ask twice; on, neither
  A.ok(noteOf(off.fresh[0].body).indexOf(firstSkill) > 0 && noteOf(on.fresh[0].body).indexOf('SAVED AGENT SKILLS') < 0, '2 fresh: the first-skill paragraph left the note');
  A.eq([activity(noteOf(off.fresh[2].body)).length, activity(noteOf(on.fresh[2].body)).length], [4, 2], '2 fresh message 3: two earlier asks, listed twice each when unset and once each when on');
  A.ok(bytes(noteOf(on.fresh[0].body)) < 1200, '2 fresh message 1: the note is under 1,200 bytes, about 300 tokens (' + bytes(noteOf(on.fresh[0].body)) + ')');
  // seeded: the skill index, the quest list, the learned tail and the verdicts stay beside the message
  for (let i = 0; i < 8; i++) {
    const n = noteOf(on.seeded[i].body), tag = '2 seeded message ' + (i + 1) + ': ';
    A.ok(n.indexOf('## SAVED AGENT SKILLS (mandatory)') > 0 && n.indexOf('- comparison-table -- ') > 0 && n.indexOf('- wiki-page-move -- ') > 0, tag + 'the saved-skill index and its mandatory line stay in the note');
    A.ok(n.indexOf(QuestInject._internals.LIST_HEAD + '\n\n- [') > 0 && n.indexOf('Publish the wiki engine recommendation to the team') > 0, tag + 'the open quest is listed in the note');
    A.ok(n.indexOf(LearnedTail.TAIL_GUARD) > 0 && n.indexOf('- Style: short answers first, tables over prose, no emojis') > 0, tag + 'THE LEARNED TAIL RIDES THE NEWEST RUN');
    A.ok(otherNotesOf(on.seeded[i].body).join('\n').indexOf(FeedbackMemory.TASTE_HEADER) >= 0 && otherNotesOf(on.seeded[i].body).join('\n').indexOf('Keep summaries to two sentences') > 0, tag + 'THE COMMANDER\'S VERDICT RIDES THE NEWEST RUN');
    A.ok(systemOf(on.seeded[i].body).indexOf('Keep summaries to two sentences') < 0 && systemOf(on.seeded[i].body).indexOf('- Style: short answers first') < 0, tag + 'nothing learned moved into the system prompt');
  }

  /* 4 — every other route */
  // where the on system prompt holds `want` that the unset one does not, when everything else is the unset prompt byte for
  // byte; -1 when it is not exactly that
  const movedAt = (sx, sy, want) => { const at = sy.indexOf(want); return at >= 0 && sy.slice(0, at) + sy.slice(at + want.length) === sx ? at : -1; };
  const three = '\n\n' + [firstSkill, questGuide, runtimeGuide].join('\n\n');
  A.eq(systemOf(on.chat.body), systemOf(off.chat.body) + '\n\n' + runtimeGuide, '4 chat turn: the system prompt gains the one runtime line, at its end, and nothing else');
  A.ok(!(on.chat.body.tools && on.chat.body.tools.length) && noteOf(on.chat.body).indexOf('[RUNTIME]') > 0 && noteOf(on.chat.body).indexOf('Run id: ' + on.chat.runId) > 0, '4 chat turn: no tools on the wire, and the note still carries the runtime block');
  A.eq(bytes(noteOf(off.chat.body)) - bytes(noteOf(on.chat.body)), bytes('\n' + answerLine), '4 chat turn: the note is smaller by that line (' + bytes(noteOf(off.chat.body)) + ' -> ' + bytes(noteOf(on.chat.body)) + ' bytes)');
  for (const [id, x, y] of [['plain chat wire', off.custom.body, on.custom.body], ['Claude chat wire', off.orClaude.body, on.orClaude.body], ['lead with crew', off.crew.body, on.crew.body]]) {
    const at = movedAt(systemOf(x), systemOf(y), three);
    A.ok(at > 0 && systemOf(y).indexOf('\n\nTASK CONTEXT — LISTEN BEFORE YOU BUILD:') > at, '4 ' + id + ': the system prompt gains the three moved paragraphs, ahead of its per-conversation tail, and nothing else');
    A.ok(bytes(noteOf(y)) < bytes(noteOf(x)) - 1300, '4 ' + id + ': the note is smaller (' + bytes(noteOf(x)) + ' -> ' + bytes(noteOf(y)) + ' bytes)');
    A.eq(JSON.stringify(y.tools), JSON.stringify(x.tools), '4 ' + id + ': the tool list is the unset one');
  }
  A.ok(cachedPrefixOf(off.orClaude.body) && cachedPrefixOf(on.orClaude.body) === cachedPrefixOf(off.orClaude.body) + three, '4 Claude chat wire: the cached prefix on the wire is the unset one plus the moved paragraphs');
  // the worker: its own note loses the same paragraphs, its task context (the lead's brief and evidence) arrives whole
  const wx = off.crew.worker, wy = on.crew.worker;
  const wMoved = cachedPrefixOf(wy).slice(cachedPrefixOf(wx).length);
  A.ok(cachedPrefixOf(wx) && cachedPrefixOf(wy).indexOf(cachedPrefixOf(wx)) === 0 && wMoved.slice(-runtimeGuide.length) === runtimeGuide && three.indexOf(wMoved) >= 0,
    '4 crew worker: the cached prefix on the wire is the unset one plus moved paragraphs only: ' + JSON.stringify(wMoved.slice(0, 60)));
  A.ok(movedAt(systemOf(wx), systemOf(wy), wMoved) === cachedPrefixOf(wx).length, '4 crew worker: and the rest of its system prompt is the unset bytes');
  A.ok(noteOf(wy).indexOf('[TASK CONTEXT]') > 0 && noteOf(wy).indexOf('<task_brief id="tb_' + on.crew.runId + '"') > 0 && noteOf(wy).indexOf('ORIGINAL REQUEST: ' + DISPATCH_ASK) > 0,
    '4 crew worker: the [TASK CONTEXT] block still carries the lead turn\'s Task Brief and request');
  A.ok(bytes(noteOf(wy)) < bytes(noteOf(wx)), '4 crew worker: the note is smaller (' + bytes(noteOf(wx)) + ' -> ' + bytes(noteOf(wy)) + ' bytes)');
  // claude-cli: the argv is the unset one, the system file gains the paragraphs in its static part (before the tools and the
  // dynamic boundary), its dynamic part is the unset bytes, stdin loses them
  for (let i = 0; i < off.cli.length; i++) {
    const x = off.cli[i], y = on.cli[i], tag = '4 claude-cli message ' + (i + 1) + ': ';
    A.eq(y.args, x.args, tag + 'the argv is the unset one');
    const cut = s => s.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    A.ok(cut(x.system) > 0 && y.system.slice(cut(y.system)) === x.system.slice(cut(x.system)), tag + 'the system file\'s dynamic part (after the boundary) is the unset one');
    A.ok(y.system === on.cli[0].system, tag + 'the system file is byte-identical from message to message');
    const at = movedAt(x.system, y.system, three);
    A.ok(at > 0 && at < y.system.indexOf('\n\n# Tools\n') && at < cut(y.system), tag + 'the system file is the unset one plus the moved paragraphs, in its static part ahead of the tools');
    A.eq(y.blocks.length, x.blocks.length, tag + 'stdin holds the same blocks');
    const lx = x.blocks[x.blocks.length - 1].text, ly = y.blocks[y.blocks.length - 1].text;
    A.ok(bytes(ly) < bytes(lx) - 1300 && ly.indexOf('Run id: ' + y.runId) > 0 && ly.lastIndexOf(CLI_ASKS[i]) > ly.lastIndexOf('</run_context>'), tag + 'the newest stdin block is smaller, carries this run\'s id, and ends on the Commander\'s words (' + bytes(lx) + ' -> ' + bytes(ly) + ' bytes)');
  }

  /* 5 — the conversation summary on claude-cli */
  for (const [label, cap] of [['unset', off], ['on', on]]) {
    const [w1, w2, w3] = cap.cliWindow, tag = '5 (' + label + '): ';
    const summaryOf = s => { const m = /<conversation_summary>[\s\S]*?<\/conversation_summary>/.exec(s); return m ? m[0] : ''; };
    const boundary = s => s.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    A.ok(cap.cli.every(m => !summaryOf(m.system)) && cap.cli.every(m => m.blocks.every(b => b.text.indexOf('<conversation_summary>') < 0)), tag + 'a chat sent whole carries no summary');
    A.ok(summaryOf(w1.system) && w1.system.indexOf(summaryOf(w1.system)) > boundary(w1.system) && w1.blocks.every(b => b.text.indexOf('<conversation_summary>') < 0),
      tag + 'a shorter window: the summary of the dropped turns rides the SYSTEM FILE, after the dynamic boundary, and no stdin block');
    A.ok(summaryOf(w1.system).indexOf(CLI_ASKS[0]) > 0 && summaryOf(w1.system).indexOf(CLI_ASKS[1]) > 0 && summaryOf(w1.system).indexOf(CLI_ASKS[2]) < 0, tag + 'it carries the Commander\'s dropped messages verbatim, and only those');
    A.ok(w2.system === w1.system && w2.blocks[0].text === w1.blocks[0].text, tag + 'the window opens on the same turn: THE SAME SUMMARY, the same system file, the same first block');
    A.ok(summaryOf(w3.system) !== summaryOf(w2.system) && summaryOf(w3.system).indexOf(CLI_ASKS[2]) > 0, tag + 'the window moved: the summary changed (it now carries the turn that left)');
    A.ok(w3.system.replace(summaryOf(w3.system), '') === w2.system.replace(summaryOf(w2.system), ''), tag + 'and nothing else in the system file did');
    A.ok(w3.blocks[0].text !== w2.blocks[0].text, tag + 'AND THE TRANSCRIPT\'S FIRST BLOCK CHANGED WITH IT: the conversation behind the summary is new bytes wherever the summary sits');
    if (label === 'unset') {
      const dyn = w1.system.slice(boundary(w1.system));
      console.log('[slim-note e2e] claude-cli, a window that starts later: the summary is ' + bytes(summaryOf(w1.system)) + ' bytes of a ' + bytes(dyn) + '-byte dynamic block ('
        + bytes(w1.system) + '-byte system file); it changed on 1 of 2 later messages, the one whose window moved');
    }
  }

  // the switch's own sizes, from the pure module the host calls
  A.ok(SlimNote.on('1') && !SlimNote.on('0') && !SlimNote.on(undefined), 'the switch: 1 is on, 0 and unset are off');
  A.report('slim-note.e2e.test');
})().catch(e => { console.log('FAIL: slim-note.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
