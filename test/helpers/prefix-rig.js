'use strict';
/* test/helpers/prefix-rig.js — the calls the PREFIX cost lanes are measured on (cost audit W3.9a-c, W2.5), captured from
   the REAL request assembly of one hermetic sidecar: a recording mock model upstream, a fake claude CLI, a temp
   workspace. No real provider, no real CLI, no stored key or sign-in.

   capture(envExtra) boots a sidecar with the given switches and returns what it sent for:
     comms     a Commander's first COMMS task on a fresh station: the page's composed lead persona, a COMMS stream, the
               starter floor, ASK approval, the lead alone on the roster.
     cartless  the same call from a floor without the SERVER CART (no notebook placed): the run that cannot call
               skill.view, so its enabled recipes ride inline.
     lead      the crew lead call: the same lead with one specialist on the roster (the full crew kit and briefing).
     worker    the first call of that specialist, dispatched by the lead (team.dispatch, approved once at the prompt).
     cli       the comms call on the claude-cli route: the --system-prompt-file, the argv and the stdin the CLI is handed.
   (cartlessCli, the cart-less call on claude-cli, is captured after those five and is measured only.)
   Each API call is { body, system, tools, raw }: the parsed request, its system text, its tools array and the request
   normalized for hashing (normalize: the run id, the Task Brief id, the clock and the temp paths of THIS boot become
   fixed words; nothing else is touched).

   The composed persona and the fake CLI follow test/payload.budget.test.js (its rows stay as they are; this rig adds the
   crew lead, the worker and the stdin/argv that file does not capture). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const A = require('../_assert.js');
const { SidecarFixture } = require('./sidecar-fixture.js');
const { userWords } = require('./host-notes.js');
const WM = require('../../frontend/app/worldmodel.js');

const HOST = '127.0.0.1';
const SWITCHES = Object.freeze(['STARNET_PREFIX_TAIL', 'STARNET_PREFIX_DOCTRINE', 'STARNET_PREFIX_RECIPES', 'STARNET_LIVE_NAMES']);
const COMMS_TASK = 'Research the three most popular open-source note-taking apps and save a short comparison table to notes/compare.md.';
const LEAD_TASK = 'PREFIX_RIG_DISPATCH: have Ada list three facts about tides, then tell me what she found.';
const WORKER_TASK = 'PREFIX_RIG_WORKER_TASK: list three facts about tides.';
const WORKER_MARK = 'PREFIX_RIG_WORKER';
const WORKER_SYSTEM = WORKER_MARK + ': You are Ada, the researcher.';
const MODEL = 'test/model';

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : String(c == null ? '' : c));
const systemOf = body => ((body && body.messages) || []).filter(m => m && m.role === 'system').map(m => text(m.content)).join('\n');
const toolNames = body => ((body && body.tools) || []).map(t => t && t.function && t.function.name);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const bytes = s => Buffer.byteLength(String(s));
// the PARTIAL list of granted tools that are not loaded yet, as the [HARNESS] block names them
const namedDeferred = sys => { const m = /These exist and you CAN use them: ([^.]*)\./.exec(String(sys)); return m ? m[1].split(', ') : []; };

/* THE COMMS PERSONA: the `system` the station page sends for its lead (frontend/app/app.js composeSystemPrompt), composed
   from the page's own functions over the real personas.js and specialties.js. */
function commsPersona() {
  const dir = path.join(__dirname, '..', '..', 'frontend', 'app');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const FNS = ['liveAgents', 'baseIdentity', 'orchestratorClause', 'agentDocs', 'approvalClause', 'foundationClause', 'rosterClause', 'rosterRole', 'composeSystemPrompt', 'executionProfileOf'];
  const bodies = FNS.map(n => A.fnBody(app, 'function ' + n + '('));
  bodies.forEach((b, i) => { if (!(b.length > 0 && b.length < 20000)) throw new Error('prefix-rig: app.js ' + FNS[i] + ' was not sliced whole (' + b.length + ' chars)'); });
  const ids = /const EXECUTION_PROFILE_IDS = \[[^\]]*\];/.exec(app);
  if (!ids) throw new Error('prefix-rig: app.js names no execution profiles');
  const ctx = { console, Specialties: require('../../frontend/app/specialties.js'), agents: new Map(), DossierStore: { composeBlock: () => '' } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'personas.js'), 'utf8') + '\n;this.Personas = Personas;', ctx);
  vm.runInContext(ids[0] + '\n' + bodies.join('\n') + '\nthis.__api = { agentDocs, composeSystemPrompt };', ctx);
  const lead = { id: 'agent', name: 'NOVA', role: 'orchestrator', personaId: 'composed', approvalMode: 'ask' };
  ctx.__api.agentDocs(lead);
  ctx.agents.set(lead.id, lead);
  return ctx.__api.composeSystemPrompt(lead);
}

/* A FAKE claude CLI: claude-cli.js runs the cli.js beside a .cmd shim; this one records its argv, the
   --system-prompt-file it was handed and its stdin, and answers one line. */
const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
if (args[0] === '--version' || args[0] === '-v') { process.stdout.write('2.1.300 (Claude Code)\\n'); process.exit(0); }
const at = args.indexOf('--system-prompt-file');
let system = '';
try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, system, stdin }) + '\\n');
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } });
});
`;

// the starter floor a fresh station boots with (worldmodel.js starterDoc): the five essentials
function starterFloor() {
  const out = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && out.indexOf(c) < 0) out.push(c); }
  return out;
}

/* The recording model. Every request with a body is kept. The lead of the dispatch ask settles its Task Brief, hands the
   worker its subtask, then answers; the worker answers. A SCRIPTED ask ('PREFIX_RIG_CALLS ' + a JSON array of
   { name, args }) makes those calls in order, one a reply, and answers 'SCRIPT DONE' after the last; a step whose tool is
   not on the wire of that request answers 'SCRIPT MISSING <name>' instead (the model was never offered it). Every other
   call answers 'ok'. */
const SCRIPT_MARK = 'PREFIX_RIG_CALLS ';
const scripted = steps => SCRIPT_MARK + JSON.stringify(steps);
function startModel() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
    if (!body) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    bodies.push({ body, raw });
    const msgs = body.messages || [];
    let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { li = i; break; }
    const words = li >= 0 ? userWords(msgs[li]) : '';
    const called = msgs.slice(li + 1).flatMap(m => (m && m.tool_calls) || []).map(t => t.function && t.function.name);
    const names = toolNames(body);
    let call = null, reply = 'ok';
    if (systemOf(body).indexOf(WORKER_MARK) >= 0) reply = 'Tides rise and fall about twice a day.';
    else if (names.length && words.indexOf('PREFIX_RIG_DISPATCH') >= 0) {
      if (names.indexOf('brief_proceed') >= 0 && called.indexOf('brief_proceed') < 0) call = { name: 'brief_proceed', args: { objective: 'Have the researcher list three facts about tides', deliverable: 'The researcher\'s three facts' } };
      else if (names.indexOf('team_dispatch') >= 0 && called.indexOf('team_dispatch') < 0) call = { name: 'team_dispatch', args: { workers: [{ agentId: 'researcher', prompt: WORKER_TASK }] } };
      else reply = 'Ada found three facts about tides.';
    } else if (names.length && words.indexOf(SCRIPT_MARK) === 0) {
      let steps = []; try { steps = JSON.parse(words.slice(SCRIPT_MARK.length)); } catch (_) { steps = []; }
      const step = steps[called.length];
      if (!step) reply = 'SCRIPT DONE';
      else if (names.indexOf(step.name) < 0) reply = 'SCRIPT MISSING ' + step.name;
      else call = { name: step.name, args: step.args || {} };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + bodies.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, bodies, port: server.address().port,
    base: 'http://' + HOST + ':' + server.address().port + '/api/v1', close: () => new Promise(done => server.close(done)) })));
}

function hermeticEnv(base, extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  // ASK approval (no Full Access): the surfaces measured are the ones a default station sends
  return Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CLOUD_URL: 'http://127.0.0.1:9',
    SKYNET_QUEST_REFRESH: '0', SKYNET_AUX_BUDGET: '0', STARNET_BUILD_DESCRIBE: 'v0.15.2-prefix-lanes',
    SKYNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-prefix-rig-fake', SKYNET_DEFAULT_MODEL: MODEL }, extra || {});
}

/* normalize — what differs between two boots of the same build, and nothing else: the run and call ids, the Task Brief
   id, the clock, and this boot's temp folders and ports. `known` are the exact strings of this boot (its workspace, its
   profile, its ports). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TODAY_RE = /Today is [A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}/g;
const CLI_PROMPT_FILE_RE = /starnet-claude-cli-\d+-\d+-[0-9a-f]+\.txt/g;
function normalize(s, known) {
  let out = String(s);
  for (const [from, to] of (known || [])) {
    if (!from) continue;
    const forms = [from, from.replace(/\\/g, '/'), from.replace(/\\/g, '\\\\')];
    for (const f of forms) out = out.split(f).join(to);
  }
  return out.replace(UUID_RE, '<ID>').replace(TODAY_RE, 'Today is <DATE>').replace(CLI_PROMPT_FILE_RE, '<SYSTEM_PROMPT_FILE>');
}

/* digests — what a golden holds for one capture: the sha256 of each call's whole normalized request, of its system text
   and of its tools array (so a difference says where it is), with their byte sizes; for claude-cli the system prompt
   file, the argv (the prompt file's own temp path named, not hashed) and the stdin. */
function digests(c) {
  const known = c.known || [];
  const out = {};
  for (const id of ['comms', 'cartless', 'lead', 'worker']) {
    const x = c[id];
    if (!x) { out[id] = null; continue; }
    const tools = JSON.stringify(x.tools);
    out[id] = { request: sha(normalize(x.raw, known)), system: sha(normalize(x.system, known)), tools: sha(tools),
      systemBytes: bytes(x.system), tools_: x.tools.length, toolBytes: bytes(tools) };
  }
  if (c.cli) {
    const args = c.cli.args.map((a, i) => c.cli.args[i - 1] === '--system-prompt-file' ? '<SYSTEM_PROMPT_FILE>' : a);
    out.cli = { system: sha(normalize(c.cli.system, known)), argv: sha(JSON.stringify(args)), stdin: sha(normalize(c.cli.stdin, known)), systemBytes: bytes(c.cli.system) };
  } else out.cli = null;
  return out;
}

function parseEvents(raw) {
  return String(raw).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// one /api/run, read as it streams: a permission prompt is approved once (the page's Approve once), as a Commander would
async function run(fixture, payload) {
  const response = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token }, body: JSON.stringify(payload) });
  if (response.status !== 200) throw new Error('prefix-rig: /api/run answered ' + response.status + ' ' + (await response.text()).slice(0, 300));
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', runId = '';
  const events = [], prompts = [];
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl); pending = pending.slice(nl + 1); if (!line.trim()) continue;
      let event = null; try { event = JSON.parse(line); } catch (_) { event = null; }
      if (!event) continue;
      events.push(event);
      if (event.name === 'agent.run.start' && !runId) runId = event.payload.runId;
      if (event.name === 'permission.prompt') {
        prompts.push(event.payload);
        const answer = await fixture.json('POST', '/api/consent', { runId, promptId: event.payload.promptId, decision: 'once' });
        if (answer.status !== 200) throw new Error('prefix-rig: consent answered ' + answer.status);
      }
    }
  }
  const end = events.filter(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === runId).pop();
  return { runId, events, prompts, end: end && end.payload };
}

async function capture(envExtra, opts) {
  opts = opts || {};
  const up = await startModel();
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-prefix-rig-cli-'));
  let fixture = null;
  try {
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
    fixture = SidecarFixture.create({ prefix: 'starnet-prefix-rig-', timeoutMs: opts.timeoutMs || 90000, env: hermeticEnv(up.base, Object.assign({
      HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: cliLogFile, STARNET_CLAUDE_CLI_PERSIST: '0' }, envExtra || {})) });
    await fixture.start();
    const known = [[fixture.workspace, '<WORKSPACE>'], [fixture.profile, '<PROFILE>'], [fakeRoot, '<CLIROOT>'],
      [HOST + ':' + up.port, '<MODEL>'], [HOST + ':' + fixture.port, '<STATION>']];
    const persona = commsPersona();
    const starter = starterFloor();
    const floor = list => list.map(objectType => ({ objectType }));
    const leadRow = { agentId: 'agent', system: persona, name: 'NOVA', provider: 'openrouter', model: MODEL, role: 'orchestrator', approvalMode: 'ask',
      executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null };
    const roster = async agents => { const r = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents }); if (r.status !== 200) throw new Error('prefix-rig: roster answered ' + r.status); };
    const task = (streamId, placed, words, extra) => run(fixture, Object.assign({ provider: 'openrouter', model: MODEL, agentId: 'agent', isTask: true, streamId,
      placed: floor(placed), stationPlaced: floor(placed), system: persona, messages: [{ role: 'user', content: words }] }, extra || {}));
    // the first request of a run that carries tools and whose newest user words are `words` (the Task Brief intake pass and
    // the scout carry none)
    const mainOf = (from, words, worker) => {
      for (const rec of up.bodies.slice(from)) {
        const b = rec.body;
        if (!Array.isArray(b.tools) || !b.tools.length) continue;
        if ((systemOf(b).indexOf(WORKER_MARK) >= 0) !== !!worker) continue;
        const users = (b.messages || []).filter(m => m && m.role === 'user');
        if (users.some(m => userWords(m).indexOf(words) >= 0)) return rec;
      }
      return null;
    };
    const call = rec => rec ? { body: rec.body, system: systemOf(rec.body), tools: rec.body.tools || [], names: toolNames(rec.body), raw: rec.raw } : null;
    const out = { persona, starter, known, up, fixture };

    // ---- comms: the lead alone on a fresh starter floor ----
    await roster([leadRow]);
    let from = up.bodies.length;
    out.commsRun = await task('prefix-rig-comms', starter, COMMS_TASK);
    out.comms = call(mainOf(from, COMMS_TASK));

    // ---- cartless: the same call from a floor without the SERVER CART ----
    from = up.bodies.length;
    out.cartlessRun = await task('prefix-rig-cartless', starter.filter(t => t !== 'notebook'), COMMS_TASK);
    out.cartless = call(mainOf(from, COMMS_TASK));

    // ---- cli: the comms call on the claude-cli route ----
    const st = await fixture.json('GET', '/api/auth/claude-cli/status');
    if (!(st.status === 200 && st.body && st.body.installed && st.body.loggedIn)) throw new Error('prefix-rig: the fake claude CLI is not installed and signed in');
    const cliBefore = cliLog().length;
    out.cliRun = await task('prefix-rig-cli', starter, COMMS_TASK, { provider: 'claude-cli', model: 'claude-sonnet-5-5' });
    const cliMains = cliLog().slice(cliBefore).filter(c => String(c.system).indexOf('\n\n# Tools\n') >= 0);
    out.cli = cliMains.length ? { system: String(cliMains[0].system), args: cliMains[0].args, stdin: String(cliMains[0].stdin || ''), calls: cliMains.length } : null;

    // ---- lead + worker: one specialist on the roster; the lead dispatches it ----
    if (opts.crew !== false) {
      await roster([leadRow, { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'openrouter', model: MODEL, system: WORKER_SYSTEM, approvalMode: 'ask' }]);
      from = up.bodies.length;
      out.leadRun = await task('prefix-rig-lead', starter, LEAD_TASK);
      out.lead = call(mainOf(from, LEAD_TASK));
      out.worker = call(mainOf(from, WORKER_TASK, true));
    }
    // ---- cartlessCli: the cart-less call on the claude-cli route. Measured only (it runs after the five the golden holds,
    //      the lead alone on the roster again), so a lane can say what it saves there.
    await roster([leadRow]);
    const cartlessCliBefore = cliLog().length;
    out.cartlessCliRun = await task('prefix-rig-cartless-cli', starter.filter(t => t !== 'notebook'), COMMS_TASK, { provider: 'claude-cli', model: 'claude-sonnet-5-5' });
    const cartlessCliMains = cliLog().slice(cartlessCliBefore).filter(c => String(c.system).indexOf('\n\n# Tools\n') >= 0);
    out.cartlessCli = cartlessCliMains.length ? { system: String(cartlessCliMains[0].system), args: cartlessCliMains[0].args, stdin: String(cartlessCliMains[0].stdin || ''), calls: cartlessCliMains.length } : null;
    // GET /api/toolsets: the TOOLSETS readout of a COMMS run on the starter floor (the same projection the run asks)
    const placedQuery = encodeURIComponent(starter.map(t => encodeURIComponent(t)).join(','));
    const view = (await fixture.json('GET', '/api/toolsets?placed=' + placedQuery)).body || {};
    out.preview = view.run || null;
    // a lane's own scenarios, on this same station, before it closes
    if (typeof opts.scenarios === 'function') {
      out.extra = await opts.scenarios({ fixture, up, task, mainOf, call, floor, starter, persona, roster, leadRow,
        bodiesFrom: from0 => up.bodies.slice(from0).map(r => r.body), mark: () => up.bodies.length });
    }
    out.close = async () => { await fixture.dispose(); await up.close(); try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {} };
    return out;
  } catch (e) {
    if (fixture) await fixture.dispose();
    await up.close();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

module.exports = { HOST, SWITCHES, COMMS_TASK, LEAD_TASK, WORKER_TASK, WORKER_MARK, MODEL, scripted, text, systemOf, toolNames, sha, bytes, namedDeferred,
  commsPersona, starterFloor, startModel, hermeticEnv, normalize, digests, parseEvents, run, capture };
