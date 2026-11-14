/* test/helpers/claude-cli-argv.js — a fake `claude` child for the Claude Code adapter that records what each child was
   started with (argv, env), and the OFF MATRIX: every model and per-request effort the adapter can be asked for, as the
   argv it starts, the effort it says it sent and the levels it lists. test/claude-cli-effort.test.js runs the matrix on
   the lane's adapter with STARNET_CLI_EFFORT off and compares it with the same matrix recorded from the base commit. */
'use strict';
const { EventEmitter } = require('node:events');

// fakeCli(script?) -> { spawn, spawns, fs }. script(rec, n) -> { lines?, stderr?, exit? } for the child's n-th input
// (default: one 'ok' reply). spawns[i] = { args, env, inputs }.
function fakeCli(script) {
  const spawns = [];
  const init = { type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] };
  const reply = text => [init, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } }];
  const play = script || (() => ({ lines: reply('ok') }));
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const pipe = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = pipe(); child.stderr = pipe(); child.pid = 6000 + spawns.length; child.exitCode = null;
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => exit(null);
    if (file === 'taskkill') { setImmediate(() => exit(0)); return child; }
    if (args.indexOf('auth') >= 0) { setImmediate(() => { child.stdout.emit('data', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\n'); exit(0); }); return child; }
    const rec = { args: args.slice(), env: Object.assign({}, (opts && opts.env) || {}), inputs: [] };
    spawns.push(rec);
    const answer = (n, done) => setImmediate(() => {
      if (child.exitCode != null) return;
      const s = play(rec, n) || {};
      for (const l of s.lines || []) child.stdout.emit('data', JSON.stringify(l) + '\n');
      if (s.stderr) child.stderr.emit('data', s.stderr);
      if (s.exit != null) exit(s.exit); else if (done) exit(0);
    });
    child.stdin = { on() {}, write(line) { rec.inputs.push(line); answer(rec.inputs.length, false); return true; },
      end(text) { if (text) { rec.inputs.push(text); answer(rec.inputs.length, true); } else setImmediate(() => exit(0)); } };
    return child;
  }
  const fs = { statSync() { return { isFile: () => true }; }, writeFileSync() {}, unlinkSync() {} };
  return { spawn, spawns, fs, reply, init };
}
// a child's argv with its temp system-prompt path replaced by a fixed word
const argvOf = rec => rec.args.map(a => /starnet-claude-cli-/.test(String(a)) ? '<system-prompt-file>' : a);
// the --effort value in an argv, or null when it carries no such flag
const effortIn = argv => { const i = argv.indexOf('--effort'); return i >= 0 ? argv[i + 1] : null; };
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-5-5[1m]', 'opus', 'sonnet', 'haiku', 'opusplan', ''];
const EFFORTS = [undefined, '', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'HIGH', ' medium ', 'banana'];
const TOOLS = [{ type: 'function', function: { name: 'fs_read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const MESSAGES = [{ role: 'system', content: 'You are the test agent.' }, { role: 'user', content: 'go' }];

/* offMatrix(makeClaudeCliProvider, adapterOpts?) -> rows, one per model x per-request effort:
   { model, effort, argv (a one-shot child's), sent (effortAsSent), list (reasoningEfforts) }, then one row per model for a
   persistent child's argv and env keys that matter, then the catalog (listModels). adapterOpts ride every adapter built. */
async function offMatrix(makeClaudeCliProvider, adapterOpts) {
  const rows = [];
  const make = (extra) => {
    const f = fakeCli();
    const env = { PATH: '', CLAUDE_CODE_EFFORT_LEVEL: 'max' };
    const p = makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: f.fs, bin: 'claude.exe', env, platform: 'linux' }, extra || {}, adapterOpts || {}));
    return { p, f };
  };
  for (const model of MODELS) {
    for (const effort of EFFORTS) {
      const { p, f } = make({ persist: false });
      const req = { model, messages: MESSAGES };
      if (effort !== undefined) req.reasoningEffort = effort;
      await collect(p, req);
      rows.push({ model, effort: effort === undefined ? null : effort, argv: argvOf(f.spawns[0]), envLevel: f.spawns[0].env.CLAUDE_CODE_EFFORT_LEVEL || null,
        sent: p.effortAsSent(model, effort), list: p.reasoningEfforts(model) });
    }
    // the agent loop's persistent child (a turn that carries tools), with and without a per-request effort
    for (const effort of [undefined, 'low']) {
      const { p, f } = make({});
      const ac = new AbortController();
      const req = { model, messages: MESSAGES, tools: TOOLS, runId: 'run-matrix', signal: ac.signal };
      if (effort) req.reasoningEffort = effort;
      await collect(p, req);
      rows.push({ model, effort: effort || null, persistent: true, argv: argvOf(f.spawns[0]), envLevel: f.spawns[0].env.CLAUDE_CODE_EFFORT_LEVEL || null });
      p.release('run-matrix'); ac.abort();
    }
  }
  const { p } = make({ persist: false });
  rows.push({ catalog: await p.listModels() });
  return rows;
}

module.exports = { fakeCli, argvOf, effortIn, collect, offMatrix, MODELS, EFFORTS, TOOLS, MESSAGES };
