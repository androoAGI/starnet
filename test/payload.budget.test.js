/* node test/payload.budget.test.js — the PER-CALL PAYLOAD BUDGET (w2 footprint, 2026-09-22).

   Every model call re-sends the system prompt and every advertised tool schema. Nothing guarded that growth: a
   Hermes-parity audit measured StarNet at 34,867 system chars + 47 tools per call on a working floor, against
   13,595 + 25 for Hermes on the same machine. This test builds the layouts that matter from the REAL request
   bytes a private sidecar sends to a fake model, prints what it measured so growth is visible in review, and pins
   an upper budget with headroom:

     default-new-install  the floor a fresh station boots with (WorldModel.starterDoc() -> World.heroCaps), the
                          interactive LEAD run, ASK approval, no connectors, no media/Spotify credentials.
     fully-granted-floor  the same station with the master bypass on: every CAP_REGISTRY object is materialized.
     lead-with-crew       the default floor again with ONE specialist on the roster (the crew>0 lead path).
     comms-task           the call a Commander's first COMMS task sends on a fresh station: the page's composed lead persona,
                          a COMMS stream, the starter floor. It also pins prefixBytes, the system + tool-schema bytes.
     claude-cli           that same call on the claude-cli route: the bytes of the --system-prompt-file (tools ride it as text).
     comms-task + switch  that call and its claude-cli twin from a station booted with ONE prefix-lane switch on (LANE_BUDGET):
                          the ON state of a lane that ships off, so it cannot regrow unseen before its A/B.

   A budget failure is a REVIEW prompt, not a bug report: if the growth is intended, raise the budget in the same
   commit and say why. Also re-asserts the chat-diet law: a non-task turn carries NO tools on the wire. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const WM = require('../frontend/app/worldmodel.js');
const { hostNotes, userWords } = require('./helpers/host-notes.js');

const MARK = 'PAYLOAD_BUDGET_PROBE';
const HOST = '127.0.0.1';
/* Measured 2026-09-23 (agent/w2-footprint, node-pty loadable, no media key, no Spotify token):
     default-new-install  36,924 system chars | 76 tools | 57,315 tool bytes   (before this lane: 36,575 | 78 | 59,452)
     fully-granted-floor  37,173 system chars | 76 tools | 57,315 tool bytes   (before this lane: 36,883 | 86 | 61,556)
   Budgets carry ~6% headroom. Biggest default-floor sections: INSTALLED SKILLS ~12.4K, operator manual ~9.3K,
   [HARNESS] ~7.0K, [ORCHESTRATION] ~4.3K, FINISH THE JOB ~2.6K.
   Re-measured 2026-09-23 on the wave-2 integration tree (trunk 0ea1bbb71 + all three wave-2 lanes): both layouts
   36,967 / 37,188 system chars | 79 tools | 60,931 tool bytes. The +3 tools / +3.6 KB is the STUDIO DaVinci Resolve edit
   bay (resolve_timeline_file / resolve_status / resolve_control, eefd36fe8) that landed on trunk after the measurement
   above — intended growth, so the tool budgets were raised here with the same ~6% headroom.
   PROMPT DIET 2026-09-23 (agent/w3-prompt-diet, progressive disclosure — nothing removed, moved one tool call away):
     default-new-install  36,929 -> 23,174 system chars | 79 -> 80 tools | 60,931 -> 61,626 tool bytes
     fully-granted-floor  37,188 -> 23,395 system chars | 79 -> 80 tools | 60,931 -> 61,626 tool bytes
   INSTALLED SKILLS ~12.4K -> ~1.1K (one index line per offered recipe; skill.view serves the exact body by its
   library:<slug> name) and the operator manual ~9.3K -> ~6.3K (orientation + every behaviour rule stay inline; the
   navigation / props / troubleshooting reference sections are a TOC served verbatim by manual.read). The +1 tool /
   +695 B is manual.read plus skill.view's description naming installed recipes; the tool budgets above still hold.
   The system budgets drop to the new measurement + ~6% so the diet cannot silently regrow.
   STEP-IN 2026-09-30: browser.need_human is advertised on every run with a browser (it is the way out of a login /
   2FA / CAPTCHA wall, so it is never deferred): 84 tools | 64,918 tool bytes. Intended growth; the byte budget moves
   to 65,300 (measurement + ~0.6%: the earlier headroom is spent, so the next tool owes a diet, not another raise).
   STATION BUILDER 2026-09-30: the lead's one-line pointer to the deferred builder ("to change the floor, tool_search
   \"station builder\" and claim only what station.build reports") replaces the old "configured in the station UI"
   sentence, and the three deferred builder tools are named in the deferred index: 24,606 / 24,827 system chars on the
   APPS trunk (7854c4241). Intended growth; the system budgets move by 50 (measurement + ~0.2%).
   STATION BUILDER 2026-10-01: station.test_line (the lead sends a test job down a line it built) and station.start_line
   (it sets what starts a line) join the deferred index: ", station_test_line, station_start_line" = +39. Note what else moves this number: the prompt carries the harness build id
   (git describe), whose length changes as other lanes add tags. It took trunk from 24,795 to 24,833 on the floor
   with no prompt change (038a62983). Measured 24,612 + 39 / 24,833 + 39; the system budgets move by 50 again.
   PINNED BUILD ID 2026-10-03: the run's build id is now a fixed release-shaped label (STARNET_BUILD_DESCRIBE below), so a
   tag elsewhere can never move this number again (an archive tag took the floor to 24,902 with no prompt change).
   10-06 ISSUE BATCH (#77, already on trunk e5e95c76b): team_dispatch's description now says where a worker's relative
   files land in a project-scoped conversation and why an ASK-mode worker has no shell (+570), image tools name the
   absolute location (+~130): trunk measured 65,999 tool bytes, over the 65,300 budget, and the HTTP gate went red.
   Intended growth: the byte budget moves to 66,100. station.status (#55) is DEFERRED for exactly this reason — it
   adds no schema, only ", station_status" (+16) to the deferred index: 24,694 / 24,915. System budgets move by 50.
   THE LENT BUILDER 2026-10-11: team_dispatch takes builder:true on a worker (a delegated Build Manager gets the lead's
   station.map/plan/build for one job) — the schema field (+29) and one sentence saying what it lends (+121): trunk
   measured 66,073, the lane 66,223. Intended growth, kept to that one sentence (the limits ride the worker's own
   note and the planner's refusals, not this schema): the byte budget moves to 66,250.
   LEAN PROMPT 2026-10-12 (agent/lean-prompt-1012) — RATCHET DOWN. This probe's lead has no crew (no roster), so the
   ZERO-CREW DIET applies: team.summon stays advertised, the other 8 team_* tools are deferred (named in [HARNESS],
   found by tool_search) and [ORCHESTRATION] shrinks to the recruit line + the crew-independent station/session rules.
   Measured base 04ce1fcb8 -> lane: default-new-install 24,672 -> 21,265 system chars | 84 -> 76 tools | 66,238 -> 58,822
   tool bytes; fully-granted-floor 24,893 -> 21,486 | 84 -> 76 | 66,238 -> 58,822. (systemChars sums EVERY system-role
   message, so the per-run <run_context> note the CACHE-STABLE PREFIX moved out of the system prompt is still counted
   here: this custom model keeps it a system message.) Budgets = measurement + ~0.3% (the date line varies in length).
   LEAN PROMPT REVIEW 2026-10-12: the diet deferred working capabilities. A crewless lead now defers ONLY team.dispatch
   and the background-worker controls; team.spawn (clones need no crew) and team.config / team.configure (its own
   Dossier) stay advertised with their SPAWN and CREW CONFIGURATION briefing lines. Since 1765d0a2c the run-context note
   rides the newest user message on this non-Claude wire, so systemChars now adds the user-side host notes explicitly
   (same quantity as before: every host-authored prompt char re-sent per call). Measured: both floors 79 tools / 61,298
   tool bytes; 22,069 / 22,290 chars (1,961 of them the note). Still below base 04ce1fcb8 (84 / 66,238 / 24,672).
   LEAD WITH CREW 2026-10-12: both layouts above are crewless, so the crew>0 path (which the diet must leave untouched)
   had no ratchet. lead-with-crew = the starter floor with ONE specialist on the roster: 84 tools / 66,238 tool bytes
   (exactly base's tool payload; tools/bytes pinned at the base budgets 84 / 66,250) and 25,006 chars (1,961 of them
   the note; the full [ORCHESTRATION] briefing with YOUR TEAM). System budget = measurement + ~0.3%.
   THE DELIVERABLE IS A THING TO OPEN 2026-10-14 (rc walk #41): the YOUR TEAM line now tells a lead with crew to name the
   deliverable as ready to open on its card, never a bare list of file names or an offer to fetch it (+196 chars, only on
   the crew>0 path; the crewless floors are unchanged). Intended growth: lead-with-crew measured 25,202 on the 0.13.5
   candidate with both lanes merged, so its system budget moves to 25,280 (measurement + ~0.3%).
   CREW IN THIS CHAT 2026-10-14 (rc walk: "bring two crew in" / "add them into this chat" went to team.dispatch): the
   [ORCHESTRATION] seat line (station.control group.add, never team.dispatch) and the steer in team_dispatch / team_summon's
   descriptions are paid for by tightening the SPAWN and YOUR TEAM lines and team_dispatch's own wording — no budget moved.
   Measured: default 22,093 | fully 22,314 | crew 25,261 system chars; 61,334 / 61,334 / 66,164 tool bytes (review round:
   the seat line quotes "add them into this chat", paid for by a shorter team.steer clause).
   THE SHELL THAT RUNS 2026-10-17 (#128): shell_exec's description said "On Windows this uses cmd.exe; wrap PowerShell
   cmdlets with …" on every machine, and Linux models tried powershell first. The description now names no shell (one
   string for every agent and machine, so it cannot know) and points at a per-agent Shell line in [RUNTIME], which
   follows the EFFECTIVE execution backend (local cmd.exe / /bin/sh, Docker or SSH sh). Measured on Windows (the longest
   line, it carries the PowerShell wrapper): 61,331 -> 61,266 tool bytes, 22,092 / 22,313 / 25,260 -> 22,234 / 22,455 /
   25,402 system chars (+142, all in the per-run note, never the cached prefix). Intended move: system budgets +142, tool
   budgets -65, so each keeps its previous headroom.
   FILES BEFORE THE SHELL 2026-10-25 (gpt-5.6-luna read a named project with dir / Select-String / type on v0.14.0): the
   work-discipline block now opens with "read, list and search files with fs_read / fs_list / fs_search, full paths
   included, not shell_exec", and fs_read / fs_list say they take a full path. Paid for in place by dropping the shell
   listing diagnostic and folding the Bash-style /c sentence into the cwd rule: trunk 29e8ce01c 22,232 / 22,453 / 25,400
   chars, 61,266 / 66,096 bytes -> 22,243 / 22,464 / 25,411, 61,278 / 66,108. No budget moved.
   PAYLOAD DIET 2026-10-28 (agent/payload-diet-1028) — RATCHET DOWN, nothing removed. The tool budgets had 4 / 74 bytes of
   headroom, so wave 2's new tools owed a diet first. 39 tool texts are tightened in place: what a description repeated
   from its own parameter descriptions (or from its enum) is said once (connectors.list query/scope, notebook.write
   scope/pinned/correction, voice_generate voice/style/path, routine.manage's by-name rule, todo's status list,
   deliverable_note's kind list), JSON-quoted argument examples become key:value (fs.search, fs.read, fs.edit, fs.list,
   quest.update op:start …), "Optional" goes where the required list already says it, and em dashes (3 bytes each on the
   wire) become plain punctuation. Every safety, consent, approval and impact rule, every spend limit, every receipt /
   "never accepted as done" / "say saved only after" rule stays, and every string a test pins still matches (no test
   edited); no parameter name, type, required list or enum moved. Measured base ab5fa2c98 -> lane: default-new-install
   and fully-granted-floor 61,281 -> 58,272 tool bytes (-3,009, -4.9%), lead-with-crew 66,111 -> 63,021 (-3,090); system
   chars unchanged at 22,229 / 22,450 / 25,397; 79 / 79 / 84 tools. Tool-byte budgets = measurement + ~0.6% so the diet
   cannot silently regrow: a lane that adds a tool raises them here, in the same commit, and says why.
   DORMANT FOLLOW-UP CONTROLS 2026-11-08 (agent/dormant-controls, cost audit W1.3): RATCHET DOWN, nothing removed. The
   controls for things a run has not started (terminal.status / read / write / resize / interrupt / stop, shell.bg.read /
   write / kill / wait, routine.manage, loop.manage, task.manage; shell.bg.status too where shell.exec is off the wire)
   stay granted and named in the [HARNESS] deferred list, where tool_search finds them, but leave the wire until a live
   terminal, background process, routine, loop or task card exists. The starter's result reveals them on the next call
   (capability/followups.js). Measured trunk e316231d7 -> lane: default-new-install and fully-granted-floor 79 -> 66 tools,
   58,343 -> 50,990 tool bytes; lead-with-crew 84 -> 71, 63,246 -> 55,893; system chars unchanged (22,226 / 22,447 /
   25,394). Tool-byte budgets = measurement + ~0.6%.
   THE COMMS TASK CALL (same lane): the rows above probe with a one-line system and no COMMS stream, so none of them is the
   call a Commander's first COMMS task really sends. comms-task is that call (composed lead persona, COMMS stream, starter
   floor, an OpenRouter key on the mock): 95,184 -> 87,340 fixed-prefix bytes (system 29,774 unchanged; 83 -> 70 tools,
   65,410 -> 57,566 tool bytes, of which -491 is brief_ask saying its per-question field descriptions once). prefixBytes'
   budget is the cost audit's target, 87,500; the others are measurement + ~0.3% (chars) / ~0.6% (tool bytes). claude-cli
   sends the same call as one --system-prompt-file: 91,700 -> 84,558 bytes, budget measurement + ~0.3%.
   THE BRIEF IN THE SAME RESPONSE, STACKED 2026-11-09 (agent/cost-stack: W1.2 brief-same-response on top of W1.3). W1.2 tells
   the lead to send brief_proceed in the SAME response as its first write, listed first, so a consequential task message no
   longer pays one extra full-context request to settle the Task Brief. Its words ride only the comms-task call (the probe
   rows above carry neither the COMMS persona nor the Task Brief tools): the fork.js Task Brief doctrine +121 system chars,
   brief_proceed's description +111 tool bytes. Each lane was green alone (W1.2's tree has no comms-task row); stacked,
   comms-task measured 32,140 chars / 57,677 tool bytes / 87,572 prefix bytes against 32,115 / 57,900 / 87,500. Intended
   growth: +232 bytes a call buys back a whole request per consequential message. The comms-task system and prefix budgets
   move by exactly that growth (+121, +232), so each keeps W1.3's headroom; the prefix now sits 72 bytes over the audit's
   87,500, for a later prefix diet to win back. claude-cli 84,558 -> 84,790 bytes and lead-with-crew 55,893 -> 56,033 tool
   bytes (W1.11: team.subagents' wait and timeoutMs) stay inside their budgets.
   THE REACH FENCE 2026-11-08 (agent/fullaccess-fence-1108): the operator manual's APPROVAL paragraph gains one clause
   (+63 chars, "a TRUSTED PROJECT reach keeps it to approved project folders"), first drafted at +244 and cut back because
   every agent pays it on every call; the fenced agent's own approval clause carries the rest. Measured 22,289 /
   22,510 / 25,457 system chars; tools and tool bytes unchanged. Intended growth: the system budgets move by 60.  Stacked on the cost stack 2026-11-13 (0.15.2 candidate): its +60 system chars / +63 prefix bytes ride the HEAD budgets. THE PRODUCT PHOTO LOCK (agent/product-lock-1109) in the same candidate: image_generate's product argument, +327 tool bytes on comms-task (57,677 -> 58,004) and claude-cli 84,790 -> 85,174 bytes with the fence; each budget = measurement + the headroom it had before (223 / 160 / 20).
   */
const BUDGET = {
  'default-new-install': { systemChars: 22342, tools: 66, toolBytes: 51300 },
  'fully-granted-floor': { systemChars: 22562, tools: 66, toolBytes: 51300 },
  'lead-with-crew': { systemChars: 25482, tools: 71, toolBytes: 56230 },
  'comms-task': { systemChars: 32296, tools: 70, toolBytes: 58227, prefixBytes: 88122 }
};
// the comms-task call on the claude-cli route, where the tool schemas are text inside the system prompt file (bytes)
const CLI_BUDGET = { systemBytes: 85194 };
/* THE PREFIX LANES, EACH ON ALONE (cost audit W3.9; every switch is OFF by default, so the rows above are what ships).
   One more hermetic station per switch sends the comms-task call again, on the model wire and on claude-cli, and each row
   is that call's own ratchet: the measurement plus the comms-task row's headroom (tool bytes +223, fixed prefix +160,
   claude-cli +20; system chars as the comms-task row unless the lane moves them). A row comes in with its lane and is
   only ever tightened. */
const LANE_BUDGET = {
  // W3.9a, the specialist tail off the wire (3 Resolve tools, 2 widget tools, skill.write): 70 -> 64 tools, 58,004 -> 51,283
  // tool bytes, 87,962 -> 81,241 prefix bytes (the six names move from the live list to the not-loaded list: system
  // unchanged); claude-cli 85,174 -> 78,777
  STARNET_PREFIX_TAIL: { systemChars: 32296, tools: 64, toolBytes: 51506, prefixBytes: 81401, cliBytes: 78797 }
};

/* THE COMMS PERSONA: the `system` the station page sends for its lead (frontend/app/app.js composeSystemPrompt), composed
   from the page's own functions over the real personas.js and specialties.js, so the comms-task rows measure the prompt a
   Commander's first COMMS task really ships, persona included (a persona edit moves them, as it moves the real call). */
function commsPersona() {
  const dir = path.join(__dirname, '..', 'frontend', 'app');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const FNS = ['liveAgents', 'baseIdentity', 'orchestratorClause', 'agentDocs', 'approvalClause', 'foundationClause', 'rosterClause', 'rosterRole', 'composeSystemPrompt', 'executionProfileOf'];
  const bodies = FNS.map(n => A.fnBody(app, 'function ' + n + '('));
  bodies.forEach((b, i) => A.ok(b.length > 0 && b.length < 20000, 'comms persona: app.js ' + FNS[i] + ' is sliced whole (' + b.length + ' chars)'));
  const ids = /const EXECUTION_PROFILE_IDS = \[[^\]]*\];/.exec(app);
  A.ok(!!ids, 'comms persona: app.js names its execution profiles');
  const ctx = { console, Specialties: require('../frontend/app/specialties.js'), agents: new Map(), DossierStore: { composeBlock: () => '' } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'personas.js'), 'utf8') + '\n;this.Personas = Personas;', ctx);
  vm.runInContext((ids ? ids[0] : '') + '\n' + bodies.join('\n') + '\nthis.__api = { agentDocs, composeSystemPrompt };', ctx);
  const lead = { id: 'agent', name: 'NOVA', role: 'orchestrator', personaId: 'composed', approvalMode: 'ask' };
  ctx.__api.agentDocs(lead);
  ctx.agents.set(lead.id, lead);
  return ctx.__api.composeSystemPrompt(lead);
}
const COMMS_TASK = 'Research the three most popular open-source note-taking apps and save a short comparison table to notes/compare.md.';

/* A FAKE claude CLI (the aux-token-ceiling pattern): claude-cli.js runs the cli.js beside a .cmd shim; this one records the
   --system-prompt-file it was handed and answers one line. No real CLI, no sign-in, no inference. */
const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
if (args[0] === '--version' || args[0] === '-v') { process.stdout.write('2.1.300 (Claude Code)\\n'); process.exit(0); }
const at = args.indexOf('--system-prompt-file');
let system = '';
try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ system }) + '\\n');
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } });
});
`;

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : String(c == null ? '' : c));
// one captured request -> the numbers this ratchet pins. prefixBytes is the FIXED PREFIX every call of the run re-sends:
// the UTF-8 bytes of its system messages plus its tool schemas, exactly as they sit on the wire.
function shape(b) {
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const system = (b.messages || []).filter(m => m.role === 'system');
  // every system-role message PLUS the host notes that ride user-side (the per-run <run_context> note is the fenced
  // leading text of the newest user message on this non-Claude wire since 1765d0a2c): host-authored prompt text is
  // re-sent on every call wherever the wire puts it, so the ratchet keeps counting it
  const noteChars = hostNotes((b.messages || []).filter(m => m.role === 'user')).reduce((n, t) => n + t.length, 0);
  const toolBytes = tools.length ? Buffer.byteLength(JSON.stringify(tools)) : 0;
  return {
    systemChars: system.reduce((n, m) => n + text(m.content).length, 0) + noteChars,
    noteChars,
    tools: tools.length,
    toolBytes,
    prefixBytes: system.reduce((n, m) => n + Buffer.byteLength(text(m.content)), 0) + toolBytes
  };
}

(async () => {
  const bodies = [];
  const all = [];   // every model request (the comms-task row carries the real persona, not the MARK)
  const llm = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const system = (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    all.push(body);
    if (system.indexOf(MARK) >= 0) bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => llm.listen(0, HOST, r));
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0' });
  // the prompt carries the harness build id: pinned to a release-shaped label so the measurement is the PROMPT, not whichever
  // tag `git describe` finds nearest this checkout (an archive/<lane>-<sha> tag added 13 chars and failed the gate, 10-03)
  env.STARNET_BUILD_DESCRIBE = 'v0.12.5-1587-gac98203c2-dirty';
  const fixture = SidecarFixture.create({ prefix: 'starnet-payload-budget-', timeoutMs: 20000, env });
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  async function measure(isTask) {
    bodies.length = 0;
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'custom', baseUrl: 'http://' + HOST + ':' + llm.address().port + '/v1', key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask,
      placed: starter.map(objectType => ({ objectType })), stationPlaced: starter.map(objectType => ({ objectType })),
      system: MARK + ': payload budget probe.', messages: [{ role: 'user', content: 'Summarize what you can do.' }] }) });
    A.eq(r.status, 200, 'run accepted');
    await r.text();
    A.eq(bodies.length, 1, 'exactly one foreground model call');
    return shape(bodies[0] || { messages: [] });
  }
  let comms = null, fakeRoot = '';
  try {
    await fixture.start();
    A.eq(starter.slice().sort(), ['cabinet', 'dish', 'notebook', 'studio', 'workbench'], 'the starter floor is the five essentials (worldmodel.js starterDoc)');
    const measured = {};
    measured['default-new-install'] = await measure(true);
    const chat = await measure(false);
    A.eq(chat.tools, 0, 'chat diet: a non-task turn carries NO tools on the wire');
    // FULL BYPASS on is confirmed at the desk (GHSA-2hpj #1): the code this station printed, as the person types it
    A.eq((await fixture.deskJson('POST', '/api/permissions/bypass', { on: true })).status, 200, 'master bypass on (every capability object materialized)');
    measured['fully-granted-floor'] = await measure(true);
    // lead-with-crew: the starter floor again (bypass off), now with ONE specialist on the roster, so the crew>0 path —
    // which the zero-crew diet must leave byte-identical — keeps its own ratchet
    A.eq((await fixture.json('POST', '/api/permissions/bypass', { on: false })).status, 200, 'master bypass off again (the starter floor)');
    A.eq((await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'NOVA', provider: 'custom', model: 'fixture-model' },
      { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'custom', model: 'fixture-model' }] })).status, 200, 'one specialist on the roster');
    measured['lead-with-crew'] = await measure(true);
    await fixture.dispose();

    /* THE COMMS TASK CALL (cost audit W1.3): the rows above probe with a one-line system and no COMMS stream. This one is the
       call a Commander's first COMMS task really sends on a fresh station: the page's composed lead persona as `system`, the
       lead alone on the roster as the page posts it, a streamId (a COMMS stream: the Task Brief tools ride it), the starter
       floor and a real task. A second hermetic sidecar, so the rows above stay exactly as they were; it also carries a FAKE
       claude CLI, and the same call on the claude-cli route pins the --system-prompt-file it hands the CLI (on that wire the
       tool schemas are text inside the system prompt). */
    fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-payload-cli-'));
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
    // SidecarFixture leaves USERPROFILE real on Windows; this boot reads no real sign-in or home directory. An OpenRouter key
    // is set (a fake one, on the mock) because a station that runs COMMS tasks has a provider: the cost audit measured that way.
    const commsEnv = Object.assign({}, env, {
      HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: cliLogFile, STARNET_CLAUDE_CLI_PERSIST: '0',
      SKYNET_OPENROUTER_BASE: 'http://' + HOST + ':' + llm.address().port + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', SKYNET_DEFAULT_MODEL: 'test/model',
      STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', SKYNET_QUEST_REFRESH: '0' });
    comms = SidecarFixture.create({ prefix: 'starnet-payload-comms-', timeoutMs: 20000, env: commsEnv });
    await comms.start();
    const persona = commsPersona();
    A.ok(persona.length > 3000 && persona.indexOf('NOVA') >= 0, 'comms persona: the composed lead persona (' + persona.length + ' chars)');
    A.eq((await comms.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', system: persona, name: 'NOVA', provider: 'custom', model: 'fixture-model',
      role: 'orchestrator', approvalMode: 'ask', executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null }] })).status, 200, 'the lead alone on the roster');
    const placed = starter.map(objectType => ({ objectType }));
    const commsRun = async extra => {
      const r = await comms.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({
        agentId: 'agent', isTask: true, placed, stationPlaced: placed, system: persona, messages: [{ role: 'user', content: COMMS_TASK }] }, extra)) });
      const raw = await r.text();
      A.eq(r.status, 200, 'comms run accepted (' + extra.provider + ')');
      return raw;
    };
    all.length = 0;
    await commsRun({ provider: 'custom', baseUrl: 'http://' + HOST + ':' + llm.address().port + '/v1', key: 'fixture-key', model: 'fixture-model', streamId: 'payload-comms-1' });
    // the run's other request is the Task Brief intake pass, which carries no tools
    const mains = all.filter(b => Array.isArray(b.tools) && b.tools.length);
    A.eq(mains.length, 1, 'comms-task: exactly one foreground model call carries the tools');
    const main = mains[0] || { messages: [] };
    const mainSystem = (main.messages || []).filter(m => m.role === 'system');
    A.ok(mainSystem.length === 1 && text(mainSystem[0].content).indexOf(persona) === 0, 'comms-task: the call opens with the composed COMMS persona');
    A.ok((main.tools || []).some(t => t && t.function && t.function.name === 'brief_proceed'), 'comms-task: a COMMS stream run (the Task Brief tools ride it)');
    A.eq(userWords((main.messages || []).filter(m => m.role === 'user').pop()), COMMS_TASK, 'comms-task: the Commander\'s task is the newest user message');
    measured['comms-task'] = shape(main);
    // the same first COMMS task on the claude-cli route
    const st = await comms.json('GET', '/api/auth/claude-cli/status');
    A.eq([st.status, st.body && st.body.installed, st.body && st.body.loggedIn], [200, true, true], 'claude-cli: the fake CLI is installed and signed in');
    const cliBefore = cliLog().length;
    await commsRun({ provider: 'claude-cli', model: 'claude-sonnet-5-5', streamId: 'payload-comms-2' });
    const cliMains = cliLog().slice(cliBefore).filter(c => String(c.system).indexOf('\n\n# Tools\n') >= 0);
    A.eq(cliMains.length, 1, 'claude-cli: exactly one foreground CLI call carries the tools block');
    const cliSystem = cliMains.length ? String(cliMains[0].system) : '';
    A.ok(cliSystem.indexOf(persona) === 0, 'claude-cli: the system prompt file opens with the composed COMMS persona');
    const cliBytes = Buffer.byteLength(cliSystem);

    /* THE PREFIX LANES, EACH ON ALONE: the same two calls from a station booted with that one switch on (one station at a
       time: the comms station above is done). */
    await comms.dispose(); comms = null;
    const laneMeasured = {};
    for (const lane of Object.keys(LANE_BUDGET)) {
      const floorObjects = (LANE_BUDGET[lane].floor || starter).map(objectType => ({ objectType }));
      comms = SidecarFixture.create({ prefix: 'starnet-payload-lane-', timeoutMs: 20000, env: Object.assign({}, commsEnv, { [lane]: '1' }) });
      await comms.start();
      A.eq((await comms.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', system: persona, name: 'NOVA', provider: 'custom', model: 'fixture-model',
        role: 'orchestrator', approvalMode: 'ask', executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null }] })).status, 200, lane + ': the lead alone on the roster');
      const laneRun = async extra => {
        const r = await comms.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({
          agentId: 'agent', isTask: true, placed: floorObjects, stationPlaced: floorObjects, system: persona, messages: [{ role: 'user', content: COMMS_TASK }] }, extra)) });
        await r.text();
        A.eq(r.status, 200, lane + ': comms run accepted (' + extra.provider + ')');
      };
      all.length = 0;
      await laneRun({ provider: 'custom', baseUrl: 'http://' + HOST + ':' + llm.address().port + '/v1', key: 'fixture-key', model: 'fixture-model', streamId: 'payload-lane-' + lane + '-1' });
      const laneMains = all.filter(b => Array.isArray(b.tools) && b.tools.length);
      A.eq(laneMains.length, 1, lane + ': exactly one foreground model call carries the tools');
      const laneSt = await comms.json('GET', '/api/auth/claude-cli/status');
      A.eq([laneSt.status, laneSt.body && laneSt.body.installed, laneSt.body && laneSt.body.loggedIn], [200, true, true], lane + ': the fake CLI is installed and signed in');
      const laneBefore = cliLog().length;
      await laneRun({ provider: 'claude-cli', model: 'claude-sonnet-5-5', streamId: 'payload-lane-' + lane + '-2' });
      const laneCli = cliLog().slice(laneBefore).filter(c => String(c.system).indexOf('\n\n# Tools\n') >= 0);
      A.eq(laneCli.length, 1, lane + ': exactly one foreground CLI call carries the tools block');
      laneMeasured[lane] = Object.assign(shape(laneMains[0] || { messages: [] }), { cliBytes: Buffer.byteLength(laneCli.length ? String(laneCli[0].system) : '') });
      await comms.dispose(); comms = null;
    }

    for (const id of Object.keys(BUDGET)) {
      const m = measured[id], b = BUDGET[id];
      console.log('[payload] ' + id + ': system ' + m.systemChars + ' chars (budget ' + b.systemChars + '; of which user-side notes ' + m.noteChars + ') | ' + m.tools + ' tools (budget ' + b.tools + ') | '
        + m.toolBytes + ' tool bytes (budget ' + b.toolBytes + ') | fixed prefix ' + m.prefixBytes + ' bytes' + (b.prefixBytes ? ' (budget ' + b.prefixBytes + ')' : ''));
      A.ok(m.systemChars <= b.systemChars, id + ': system prompt ' + m.systemChars + ' chars within budget ' + b.systemChars);
      A.ok(m.tools <= b.tools, id + ': ' + m.tools + ' advertised tools within budget ' + b.tools);
      A.ok(m.toolBytes <= b.toolBytes, id + ': ' + m.toolBytes + ' tool-schema bytes within budget ' + b.toolBytes);
      if (b.prefixBytes) A.ok(m.prefixBytes <= b.prefixBytes, id + ': fixed prefix ' + m.prefixBytes + ' bytes (system + tool schemas) within budget ' + b.prefixBytes);
      A.ok(m.tools > 10 && m.systemChars > 5000, id + ': the measurement saw a real task payload (not an empty request)');
    }
    console.log('[payload] claude-cli: system prompt file ' + cliBytes + ' bytes (budget ' + CLI_BUDGET.systemBytes + ')');
    A.ok(cliBytes <= CLI_BUDGET.systemBytes, 'claude-cli: system prompt file ' + cliBytes + ' bytes within budget ' + CLI_BUDGET.systemBytes);
    A.ok(cliBytes > 20000, 'claude-cli: the measurement saw a real task prompt (persona, harness and tools block)');
    for (const lane of Object.keys(LANE_BUDGET)) {
      const m = laneMeasured[lane], b = LANE_BUDGET[lane];
      console.log('[payload] comms-task + ' + lane + '=1: system ' + m.systemChars + ' chars (budget ' + b.systemChars + ') | ' + m.tools + ' tools (budget ' + b.tools + ') | '
        + m.toolBytes + ' tool bytes (budget ' + b.toolBytes + ') | fixed prefix ' + m.prefixBytes + ' bytes (budget ' + b.prefixBytes + ') | claude-cli ' + m.cliBytes + ' bytes (budget ' + b.cliBytes + ')');
      A.ok(m.systemChars <= b.systemChars, lane + ' on: system prompt ' + m.systemChars + ' chars within budget ' + b.systemChars);
      A.ok(m.tools <= b.tools, lane + ' on: ' + m.tools + ' advertised tools within budget ' + b.tools);
      A.ok(m.toolBytes <= b.toolBytes, lane + ' on: ' + m.toolBytes + ' tool-schema bytes within budget ' + b.toolBytes);
      A.ok(m.prefixBytes <= b.prefixBytes, lane + ' on: fixed prefix ' + m.prefixBytes + ' bytes (system + tool schemas) within budget ' + b.prefixBytes);
      A.ok(m.cliBytes <= b.cliBytes, lane + ' on: claude-cli system prompt file ' + m.cliBytes + ' bytes within budget ' + b.cliBytes);
      A.ok(m.tools > 10 && m.systemChars > 5000 && m.cliBytes > 20000, lane + ' on: the measurement saw a real task payload (not an empty request)');
    }
  } finally {
    await fixture.dispose();
    if (comms) await comms.dispose();
    if (fakeRoot) { try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {} }
    await new Promise(r => llm.close(r));
  }
  A.report('payload.budget');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
