/* node test/claude-cli-compact-tools.e2e.test.js — COMPACT CLAUDE-CLI TOOL TEXT, end to end (cost audit W2.2).

   The real sidecar (SidecarFixture) and a FAKE `claude` that records the --system-prompt-file and the argv it is handed.
   One station, restarted on the same workspace for each value of STARNET_CLI_COMPACT_TOOLS, sends the same two calls:
     the default task call   a Commander's first task on a fresh station (the lead alone, the starter floor, a COMMS stream)
     a crew lead call        the same task with one specialist on the roster (the crew>0 path: the team tools ride along)

   OFF (unset, and '0'): the file and the argv are byte-identical to each other. (That they are also byte-identical to the
   base commit's was checked with this same rig against 57c741da7's sources; the unit test pins the base text by hash.)
   ON ('1'): the argv is the same, and the file differs only in its tools section: the legend, and every tool's parameters
   as the signature of exactly the JSON Schema the OFF file carries (read back and compared here), or that JSON itself.
   The saving is measured and printed, and the ON size is pinned so it cannot silently regrow.

   No network, no real CLI, no model spend. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const WM = require('../frontend/app/worldmodel.js');
const Sig = require('../sidecar/providers/tool-signature.js');

const bytes = s => Buffer.byteLength(s, 'utf8');
const PERSONA = 'COMPACT_TOOLS_PROBE: you are NOVA, the station lead.';
const TASK = 'Research the three most popular open-source note-taking apps and save a short comparison table to notes/compare.md.';
/* Measured 2026-11-14 on agent/cf-cli-text (this probe's one-line persona; the tool text is the same under any persona):
     default task call  system file 77,617 -> 69,785 bytes (-7,832, -10.1%) | tool text 51,627 -> 43,095 (-16.5%) | 69 tools
     crew lead call     system file 85,621 -> 77,178 bytes (-8,443, -9.9%)  | tool text 56,379 -> 47,236 (-16.2%) | 74 tools
   Two tools keep their JSON in both (code_run, team_configure: root additionalProperties:false). The legend costs 700 bytes.
   Budgets = the ON measurement + ~0.6%. A lane that adds a tool raises them here, in the same commit, and says why. */
const ON_BUDGET = { task: { toolText: 43360 }, crew: { toolText: 47520 } };

const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
const at = args.indexOf('--system-prompt-file');
let system = '';
try { system = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : ''; } catch (_) {}
const argv = args.map((a, i) => (at >= 0 && i === at + 1) ? '<system-prompt-file>' : a);
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ system, argv }) + '\\n');
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } });
});
`;

// the tools section of a system prompt file, and its tools: [{ head: '- name: description', params }]
function toolsSection(system) {
  const from = system.indexOf('\n\n# Tools\nYou cannot execute');
  const to = system.indexOf('\n\n# Conversation\n', from);
  return (from >= 0 && to > from) ? system.slice(from + 2, to) : '';
}
const LIST = '\nAvailable tools:\n';
function toolBlocks(section) {
  const body = section.slice(section.indexOf(LIST) + LIST.length);
  const out = [];
  let head = [];
  for (const line of body.split('\n')) {
    if (line.indexOf('  parameters: ') === 0) { out.push({ head: head.join('\n'), params: line.slice('  parameters: '.length) }); head = []; }
    else head.push(line);
  }
  return { blocks: out, rest: head.join('\n'), body };
}

(async () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-compact-tools-'));
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

  // nothing from the gate's own shell reaches the station: every provider key and every STARNET_/SKYNET_ switch is blank
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  delete process.env.STARNET_CLI_COMPACT_TOOLS; delete process.env.SKYNET_CLI_COMPACT_TOOLS;   // the first arm is the switch UNSET
  delete env.STARNET_CLI_COMPACT_TOOLS; delete env.SKYNET_CLI_COMPACT_TOOLS;
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0',
    SKYNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.12.5-1587-gac98203c2-dirty',
    HOME: home, USERPROFILE: home, STARNET_CLAUDE_BIN: shim, FAKE_CLAUDE_LOG: logFile, STARNET_CLAUDE_CLI_PERSIST: '0' });
  const f = SidecarFixture.create({ prefix: 'starnet-compact-tools-', timeoutMs: 90000, env });
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  const placed = starter.map(objectType => ({ objectType }));
  const LEAD = { agentId: 'agent', system: PERSONA, name: 'NOVA', provider: 'claude-cli', model: 'claude-sonnet-5-5', role: 'orchestrator', approvalMode: 'ask', executionProfile: 'station-gear', workshop: false, skills: [], reasoningEffort: null };
  const CREW = { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'claude-cli', model: 'claude-sonnet-5-5' };
  let n = 0;
  async function call(label, roster) {
    A.eq((await f.json('POST', '/api/roster', { updatedAt: Date.now() + (++n), agents: roster })).status, 200, label + ': fixture: the roster is pushed');
    const before = cliLog().length;
    const r = await f.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      agentId: 'agent', isTask: true, placed, stationPlaced: placed, system: PERSONA, provider: 'claude-cli', model: 'claude-sonnet-5-5', streamId: 'compact-tools-' + n,
      messages: [{ role: 'user', content: TASK }] }) });
    await r.text();
    A.eq(r.status, 200, label + ': fixture: the run was accepted');
    const mains = cliLog().slice(before).filter(c => toolsSection(String(c.system)));
    A.eq(mains.length, 1, label + ': fixture: exactly one foreground CLI call carries the tools block');
    return mains[0] || { system: '', argv: [] };
  }
  async function arm(label, extra) {
    await f.start(extra);
    const st = await f.json('GET', '/api/auth/claude-cli/status');
    A.eq([st.status, st.body && st.body.installed, st.body && st.body.loggedIn], [200, true, true], label + ': fixture: the fake CLI is installed and signed in');
    const out = { task: await call(label + ' task', [LEAD]), crew: await call(label + ' crew', [LEAD, CREW]) };
    await f.stop();
    return out;
  }

  try {
    const unset = await arm('unset', {});
    const zero = await arm("'0'", { STARNET_CLI_COMPACT_TOOLS: '0' });
    const one = await arm("'1'", { STARNET_CLI_COMPACT_TOOLS: '1' });

    for (const kind of ['task', 'crew']) {
      const name = kind === 'task' ? 'the default task call' : 'a crew lead call';
      const off = unset[kind], on = one[kind];
      // ---- OFF: unset and '0' are the same bytes ----
      A.ok(bytes(off.system) > 20000, name + ': fixture: the measurement saw a real task prompt (' + bytes(off.system) + ' bytes)');
      A.ok(off.system === zero[kind].system, name + ": OFF: the system prompt file is byte-identical with the switch unset and '0'");
      A.eq(zero[kind].argv, off.argv, name + ": OFF: the CLI argv is identical with the switch unset and '0'");
      const offSection = toolsSection(off.system);
      const offTools = toolBlocks(offSection);
      A.ok(offTools.blocks.length >= 50 && offTools.rest === '', name + ': fixture: the OFF section lists the run\'s tools, one parameters line each (' + offTools.blocks.length + ')');
      A.eq(offSection.indexOf(Sig.LEGEND), -1, name + ': OFF: no legend');
      const schemas = offTools.blocks.map(b => { try { return JSON.parse(b.params); } catch (_) { return null; } });
      A.eq(offTools.blocks.filter((b, i) => !schemas[i] || JSON.stringify(schemas[i]) !== b.params).map(b => b.head.slice(0, 40)), [], name + ': OFF: every parameters line is the tool\'s JSON Schema, as JSON.stringify writes it');

      // ---- ON: the argv is the same; the file differs only in the tools section ----
      A.eq(on.argv, off.argv, name + ': ON: the CLI argv is identical');
      const want = offTools.blocks.map((b, i) => { const sig = Sig.render(schemas[i]); return b.head + '\n  parameters: ' + (sig == null ? b.params : sig); }).join('\n');
      const wantSection = offSection.slice(0, offSection.indexOf(LIST)) + '\n' + Sig.LEGEND + '\n' + LIST + want;
      A.ok(on.system === off.system.replace(offSection, wantSection), name + ': ON: the file is the OFF file with the legend added and each tool\'s parameters as the signature of the same schema (or its JSON)');
      const onSection = toolsSection(on.system);
      const onTools = toolBlocks(onSection);
      A.eq(onTools.blocks.map(b => b.head), offTools.blocks.map(b => b.head), name + ': ON: every tool, its name and its description, in the same order, verbatim');
      const kept = [], lost = [];
      onTools.blocks.forEach((b, i) => {
        if (b.params === offTools.blocks[i].params) { kept.push(b.head.split(':')[0].slice(2)); if (!Sig.why(schemas[i])) lost.push(b.head.slice(0, 40) + ': kept its JSON though the notation can say it'); return; }
        let back = null;
        try { back = Sig.parse(b.params); } catch (e) { lost.push(b.head.slice(0, 40) + ': ' + e.message); return; }
        if (!Sig.same(Sig.canonical(back), Sig.canonical(schemas[i]))) lost.push(b.head.slice(0, 40) + ': reads back as another schema');
      });
      A.eq(lost, [], name + ': ON: every signature the CLI was handed reads back as the JSON Schema the OFF file carries');
      A.ok(kept.length <= 4, name + ': ON: at most a few tools keep their JSON (' + (kept.join(', ') || 'none') + ')');

      // ---- the saving ----
      const offText = bytes(offTools.body), onText = bytes(onTools.body);
      console.log('[compact-tools] ' + name + ': system file ' + bytes(off.system) + ' -> ' + bytes(on.system) + ' bytes (-' + (bytes(off.system) - bytes(on.system)) + ', -' + (100 * (1 - bytes(on.system) / bytes(off.system))).toFixed(1)
        + '%) | tool text ' + offText + ' -> ' + onText + ' (-' + (100 * (1 - onText / offText)).toFixed(1) + '%) | legend +' + bytes(Sig.LEGEND + '\n\n') + ' | ' + onTools.blocks.length + ' tools, ' + kept.length + ' keep JSON (' + (kept.join(', ') || 'none') + ')');
      A.eq(bytes(off.system) - bytes(on.system), offText - onText - bytes(Sig.LEGEND + '\n\n'), name + ': ON: the file shrinks by exactly the tool text saved, less the legend');
      A.ok(onText <= offText * 0.9, name + ': ON: the tool text is at least 10% smaller (' + offText + ' -> ' + onText + ')');
      A.ok(onText <= ON_BUDGET[kind].toolText, name + ': ON: tool text ' + onText + ' bytes within budget ' + ON_BUDGET[kind].toolText);
    }
    A.ok(toolBlocks(toolsSection(unset.crew.system)).blocks.length > toolBlocks(toolsSection(unset.task.system)).blocks.length, 'fixture: the crew lead call carries more tools than the default task call');
  } finally {
    await f.dispose();
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) { /* a temp folder the OS reaps */ }
  }
  A.report('claude-cli-compact-tools.e2e');
})().catch(e => { console.error(e); process.exit(1); });
