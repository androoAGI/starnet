/* node dev/claude-cli-switch-ab.js — an A/B of ONE Claude sign-in switch on the REAL `claude` CLI. It uses the machine's own
   Claude Code sign-in and draws on that plan's usage: Andrew runs it, an agent never does (an agent may run --self-test,
   which uses a fake CLI and spends nothing).

   WHAT IT ANSWERS. With a cost switch on, does a tool-using task still finish as well as with it off, and what did it
   cost? Both arms run the SAME tasks on the SAME model through the REAL sidecar (a hermetic SidecarFixture: a temp
   workspace and profile, deleted afterwards; never the real station). The switch is the only difference. The arm order
   alternates task by task, and each arm's system prompt opens with its own nonce so the arms share no cached prefix.

     node dev/claude-cli-switch-ab.js --switch STARNET_CLI_COMPACT_TOOLS --off 0 --on 1
     node dev/claude-cli-switch-ab.js --switch STARNET_CLI_EFFORT --off off --on picked --effort low --picked
     options: --model <id> (default claude-sonnet-5-5) · --effort <level> (the agent's effort, default medium) · --picked (the
       roster row carries the Commander's pick mark: what STARNET_CLI_EFFORT=picked sends) · --reps <n> (default 2) ·
       --tasks <id,id> (default all) · --out <dir> (default %TEMP%/starnet-cli-ab/<stamp>) · --self-test

   TASKS (each a handful of tool calls; the oracle reads the files the run left in the temp workspace):
     write   write a file with exact content and read it back
     edit    write a three-line file, then change all three lines to exact new values
     tally   write four small files, read them back, and write their numbers and their sum as JSON
   --self-test runs only `write`: its fake CLI knows that one task.
   METRICS per task and arm (the task run's own calls; background passes are off or not counted): success (the oracle) · model calls and tool calls · TOOL-ARGUMENT ERRORS (a tool result that
     is an error and reads like a refused argument: the number a compact tool text must not raise) and other tool errors,
     each with its text · tokens from the station's usage receipts (.usage/calls.jsonl: uncached input, cache read, cache
     write, output, reasoning) · the effort each run record names (the argv's --effort, or cli-default).
   VERDICT (printed, and written to report.json): on vs off: no task that passed off fails on, tool-argument errors not
     higher, and the input-side tokens (COMPACT_TOOLS) or the output and reasoning tokens (EFFORT) as expected.
   EXIT 0 the A/B ran · 1 it ran and on is worse (a task lost, or more argument errors) · 2 refused (bad flags, CLI not
     installed or not signed in) · 4 a station failed to start or a run broke. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');
const WM = require('../frontend/app/worldmodel.js');

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] != null && !/^--/.test(argv[i + 1]) ? argv[i + 1] : dflt; };
const has = name => argv.indexOf('--' + name) >= 0;
const SELF_TEST = has('self-test');
const SWITCH = String(flag('switch', '')).trim();
const OFF = String(flag('off', '')), ON = String(flag('on', ''));
const MODEL = String(flag('model', 'claude-sonnet-5-5')).trim();
const EFFORT = String(flag('effort', 'medium')).trim();
const PICKED = has('picked');
const REPS = Math.max(1, Math.min(10, Number(flag('reps', SELF_TEST ? 1 : 2)) || 1));
const OUT = path.resolve(flag('out', path.join(os.tmpdir(), 'starnet-cli-ab', new Date().toISOString().replace(/[:.]/g, '-'))));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const refuse = (msg) => { console.error('refused: ' + msg); process.exit(2); };
if (!/^STARNET_[A-Z0-9_]+$/.test(SWITCH)) refuse('--switch STARNET_<NAME> is required');
if (!has('off') || !has('on') || OFF === ON) refuse('--off <value> and --on <value> are required and must differ');

// ---- the tasks ----------------------------------------------------------------------------------------------------------
const nonce = () => Math.random().toString(36).slice(2, 10);
const TASKS = {
  write: n => ({
    ask: 'Write the file ab/' + n + '/note.md containing exactly these two lines:\ntoken: ' + n + '\nstatus: ready\nThen read the file back with fs_read and reply with the token line exactly as the file has it.',
    grade: (find) => { const t = find('ab/' + n + '/note.md'); return t != null && t.replace(/\r/g, '').trim() === 'token: ' + n + '\nstatus: ready'; }
  }),
  edit: n => ({
    ask: 'First write the file ab/' + n + '/config.txt containing exactly:\nname = draft\nretries = 1\nmode = slow\nThen change it so that name is ' + n + ', retries is 3 and mode is fast, keeping the same three lines and nothing else. Reply DONE when the file is right.',
    grade: (find) => { const t = find('ab/' + n + '/config.txt'); return t != null && t.replace(/\r/g, '').trim() === 'name = ' + n + '\nretries = 3\nmode = fast'; }
  }),
  tally: n => {
    const nums = [17, 4, 29, 8];
    return {
      ask: 'Write four files, ab/' + n + '/in1.txt to ab/' + n + '/in4.txt, each holding one line: "value: 17", "value: 4", "value: 29" and "value: 8" in that order. Then read all four back and write ab/' + n + '/sum.json holding a JSON object with "values" (the four numbers as an array, in file order) and "sum" (their total). Reply with the total.',
      grade: (find) => { try { const j = JSON.parse(find('ab/' + n + '/sum.json')); return JSON.stringify(j.values) === JSON.stringify(nums) && j.sum === 58; } catch (_) { return false; } }
    };
  }
};
const TASK_IDS = String(flag('tasks', SELF_TEST ? 'write' : Object.keys(TASKS).join(','))).split(',').map(s => s.trim()).filter(Boolean);
for (const id of TASK_IDS) if (!TASKS[id]) refuse('unknown task ' + id + ' (have: ' + Object.keys(TASKS).join(', ') + ')');

// ---- a fake CLI for --self-test: it does the write task by the book, so the whole pipeline is exercised for nothing -------
const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const text = (() => { try { return JSON.parse(input).message.content.map(b => b.text || '').join('\\n'); } catch (_) { return input; } })();
  const m = /Write the file (ab\\/[a-z0-9]+\\/note\\.md)[\\s\\S]*?token: ([a-z0-9]+)/.exec(text);
  const done = /<tool_result/.test(text);
  let reply = 'nothing to do.';
  if (m && !done) reply = '<function_calls>\\n<invoke name="fs_write">\\n<parameter name="path">' + m[1] + '</parameter>\\n<parameter name="content">token: ' + m[2] + '\\nstatus: ready\\n</parameter>\\n</invoke>\\n</function_calls>';
  else if (m) reply = 'token: ' + m[2];
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 } });
});
`;

const ARG_ERROR_RE = /invalid|required|must be|expected|schema|argument|parameter|not valid json|unknown (?:field|property)|NOT executed/i;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  // background passes off: the A/B measures the task's own calls. The CLI's sign-in is the user's own (their real home).
  Object.assign(env, { SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_QUEST_REFRESH: '0', STARNET_LIVE_PRICES: '0', STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1', STARNET_CLAUDE_BIN: '' });
  if (process.platform !== 'win32' && process.env.HOME) env.HOME = process.env.HOME;
  let fakeRoot = '';
  if (SELF_TEST) {
    fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-ab-fake-'));
    const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
    fs.writeFileSync(path.join(fakeRoot, 'claude.cmd'), '@echo off\r\n');
    fs.mkdirSync(path.join(fakeRoot, 'home'));
    // one-shot children: the fake answers when its stdin closes (a real run keeps the default persistent child)
    Object.assign(env, { STARNET_CLAUDE_BIN: path.join(fakeRoot, 'claude.cmd'), HOME: path.join(fakeRoot, 'home'), USERPROFILE: path.join(fakeRoot, 'home'), STARNET_CLAUDE_CLI_PERSIST: '0' });
  }
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  const placed = starter.map(objectType => ({ objectType }));

  const arms = {};
  for (const [name, value] of [['off', OFF], ['on', ON]]) {
    const f = SidecarFixture.create({ prefix: 'starnet-cli-ab-' + name + '-', timeoutMs: 120000, env: Object.assign({}, env, { [SWITCH]: value }) });
    try { await f.start(); } catch (e) { console.error('the ' + name + ' station did not start: ' + (e && e.message)); process.exit(4); }
    const st = await f.json('GET', '/api/auth/claude-cli/status');
    if (!(st.body && st.body.installed)) { await f.dispose(); refuse('Claude Code is not installed on this computer'); }
    if (!st.body.loggedIn) { await f.dispose(); refuse('Claude Code is not signed in (run `claude` and sign in first)'); }
    const row = Object.assign({ agentId: 'agent', name: 'NOVA', provider: 'claude-cli', model: MODEL, role: 'orchestrator', reasoningEffort: EFFORT }, PICKED ? { effortPicked: true } : {});
    const pushed = await f.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [row] });
    if (pushed.status !== 200) { await f.dispose(); console.error('the ' + name + ' station refused the roster: HTTP ' + pushed.status); process.exit(4); }
    arms[name] = { f, value, nonce: nonce() };
  }
  const find = (f, rel) => {   // the task's file, wherever the station put this agent's workspace
    const want = rel.split('/').join(path.sep);
    const walk = (dir, depth) => {
      if (depth > 6) return null;
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
      const direct = path.join(dir, want);
      try { if (fs.statSync(direct).isFile()) return fs.readFileSync(direct, 'utf8'); } catch (_) { /* not here */ }
      for (const d of names) { if (d.isDirectory() && d.name !== 'node_modules') { const hit = walk(path.join(dir, d.name), depth + 1); if (hit != null) return hit; } }
      return null;
    };
    return walk(f.workspace, 0);
  };
  const receipts = f => { try { return fs.readFileSync(path.join(f.workspace, '.usage', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };

  async function runTask(arm, id, rep) {
    const f = arm.f, n = nonce(), task = TASKS[id](n);
    const r = await f.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      agentId: 'agent', isTask: true, provider: 'claude-cli', model: MODEL, reasoningEffort: EFFORT, placed, stationPlaced: placed,   // no streamId: a COMMS stream would hold the tools behind its Task Brief
      system: 'A/B ' + arm.nonce + ': you are NOVA, the station lead. Work in your own workspace with relative paths.', messages: [{ role: 'user', content: task.ask }] }) });
    const raw = await r.text();
    if (r.status !== 200) throw new Error('/api/run answered HTTP ' + r.status + ': ' + raw.slice(0, 200));
    const ev = raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const of = name => ev.filter(e => e.name === name).map(e => e.payload || {});
    const end = of('agent.run.end').pop() || {};
    const names = new Map(of('agent.tool_call').map(c => [c.callId, c.name]));
    const bad = of('agent.tool_result').filter(t => t.isError || t.ok === false).map(t => ({ tool: names.get(t.callId) || '?', text: String(t.summary || '').slice(0, 300) }));
    await sleep(300);   // the last receipt lands just after the stream closes
    const used = receipts(f).filter(c => c.runId && c.runId === end.runId);   // the run's own model calls (a background pass has its own id)
    const sum = k => used.reduce((a, c) => a + (Number(c[k]) || 0), 0);
    const rec = ((((await f.json('GET', '/api/runs?agent=agent&limit=5')).body || {}).runs) || []).find(x => x.runId === end.runId) || {};
    return { task: id, rep, reason: end.reason || 'unknown', success: end.reason === 'done' && !!task.grade(rel => find(f, rel)), modelCalls: used.length, toolCalls: names.size,
      argErrors: bad.filter(b => ARG_ERROR_RE.test(b.text)), otherErrors: bad.filter(b => !ARG_ERROR_RE.test(b.text)),
      tokens: { uncachedIn: sum('uncachedIn'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), out: sum('out'), reasoning: sum('reasoning') }, effort: rec.reasoningEffort || '' };
  }

  const rows = { off: [], on: [] };
  let broke = null;
  try {
    let flip = false;
    for (const id of TASK_IDS) for (let rep = 1; rep <= REPS; rep++) {
      for (const name of (flip ? ['on', 'off'] : ['off', 'on'])) {
        const row = await runTask(arms[name], id, rep);
        rows[name].push(row);
        console.log('[' + name + ' ' + SWITCH + '=' + arms[name].value + '] ' + id + ' #' + rep + ': ' + (row.success ? 'PASS' : 'FAIL (' + row.reason + ')') + ' | ' + row.modelCalls + ' model calls, ' + row.toolCalls + ' tool calls, '
          + row.argErrors.length + ' argument errors, ' + row.otherErrors.length + ' other tool errors | in ' + row.tokens.uncachedIn + ' + read ' + row.tokens.cacheRead + ' + write ' + row.tokens.cacheWrite + ', out ' + row.tokens.out
          + ' (reasoning ' + row.tokens.reasoning + ') | effort ' + (row.effort || '?'));
        for (const b of row.argErrors) console.log('    argument error, ' + b.tool + ': ' + b.text);
      }
      flip = !flip;
    }
  } catch (e) { broke = e; }
  finally { for (const a of Object.values(arms)) await a.f.dispose(); if (fakeRoot) { try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) { /* a temp folder the OS reaps */ } } }

  const total = (list, pick) => list.reduce((a, r) => a + pick(r), 0);
  const summary = name => ({ value: arms[name].value, runs: rows[name].length, passed: rows[name].filter(r => r.success).length, argErrors: total(rows[name], r => r.argErrors.length), otherErrors: total(rows[name], r => r.otherErrors.length),
    modelCalls: total(rows[name], r => r.modelCalls), toolCalls: total(rows[name], r => r.toolCalls),
    inputSide: total(rows[name], r => r.tokens.uncachedIn + r.tokens.cacheRead + r.tokens.cacheWrite), out: total(rows[name], r => r.tokens.out), reasoning: total(rows[name], r => r.tokens.reasoning),
    efforts: Array.from(new Set(rows[name].map(r => r.effort || '?'))) });
  const off = summary('off'), on = summary('on');
  const lost = rows.off.filter((r, i) => r.success && rows.on[i] && !rows.on[i].success).map(r => r.task + ' #' + r.rep);
  const worse = lost.length > 0 || on.argErrors > off.argErrors;
  const report = { switch: SWITCH, model: MODEL, effort: EFFORT, picked: PICKED, selfTest: SELF_TEST, off, on, lost, worse, rows, error: broke ? String(broke && broke.message || broke) : null };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log('\n' + SWITCH + ' on ' + MODEL + (SELF_TEST ? ' (SELF-TEST: a fake CLI, nothing spent, no verdict about a model)' : '') + '\n  off (' + OFF + '): ' + off.passed + '/' + off.runs + ' passed | ' + off.argErrors + ' argument errors | input side ' + off.inputSide
    + ' tok, out ' + off.out + ' (reasoning ' + off.reasoning + ') | effort ' + off.efforts.join(',') + '\n  on  (' + ON + '): ' + on.passed + '/' + on.runs + ' passed | ' + on.argErrors + ' argument errors | input side ' + on.inputSide
    + ' tok, out ' + on.out + ' (reasoning ' + on.reasoning + ') | effort ' + on.efforts.join(',') + '\n  ' + (broke ? 'BROKE: ' + (broke && broke.message) : worse ? 'ON IS WORSE: ' + (lost.length ? 'lost ' + lost.join(', ') + '. ' : '') + (on.argErrors > off.argErrors ? 'more argument errors.' : '')
      : 'on is not worse on these tasks (no task lost, argument errors not higher).') + '\n  report: ' + path.join(OUT, 'report.json'));
  process.exit(broke ? 4 : worse ? 1 : 0);
})().catch(e => { console.error(e); process.exit(4); });
