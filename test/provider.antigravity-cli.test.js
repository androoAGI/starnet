/* node test/provider.antigravity-cli.test.js - the Antigravity CLI (`agy`) provider seam (no real `agy` is spawned). */
'use strict';
const A = require('./_assert.js');
const { EventEmitter } = require('events');
const os = require('os');
const realFs = require('fs');
const { makeAntigravityCliProvider, _internals } = require('../sidecar/providers/antigravity-cli.js');
const factory = require('../sidecar/providers/factory.js');

// A fake `agy` child: replays stream-json lines, records argv/cwd/stdin, and dies when killed.
function fakeSpawn(script) {
  const calls = [];
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = stream(); child.stderr = stream();
    child.pid = 4343; child.exitCode = null;
    const call = { file, args, opts, stdin: '', killed: false };
    calls.push(call);
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => { call.killed = true; exit(null); };
    child.stdin = { on() {}, end(text) { call.stdin += text || ''; setImmediate(run); } };
    function run() {
      const s = typeof script === 'function' ? script(call) : script;
      if (s.hang) return;
      for (const l of s.lines || []) child.stdout.emit('data', (typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
      if (s.stdout) child.stdout.emit('data', s.stdout);
      if (s.stderr) child.stderr.emit('data', s.stderr);
      if (!s.stay) exit(s.code || 0);   // stay: a live child that keeps running after its lines
    }
    if (args[0] === 'models') setImmediate(run);
    return child;
  }
  return { spawn, calls };
}
// a real temp folder per child (the adapter makes and removes it), but no settings file unless a test gives one
function fakeFs(settings) {
  return Object.assign({}, realFs, {
    statSync() { return { isFile: () => true }; },
    readFileSync(p, enc) { if (/antigravity-cli[\\/]settings\.json$/.test(String(p))) { if (settings == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return JSON.stringify(settings); } return realFs.readFileSync(p, enc); }
  });
}
const make = (script, extra) => {
  const f = fakeSpawn(script);
  const x = extra || {};
  const p = makeAntigravityCliProvider({ spawn: f.spawn, fs: fakeFs(x.settings), bin: 'agy', env: Object.assign({ PATH: '', HOME: os.tmpdir() }, x.env || {}), platform: 'linux', idleMs: x.idleMs });
  return { p, calls: f.calls };
};
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
async function failure(p, req) { try { await collect(p, req); } catch (e) { return e; } return null; }
const step = (type, extra) => ({ event: 'step_update', step_update: Object.assign({ conversation_id: 'c1', step_index: 1, state: 'ACTIVE', step_type: type }, extra || {}) });
const delta = text => step('agent_response', { text_delta: text });
const init = { event: 'init', conversation_id: 'c1', init: { cwd: '/tmp/x', tools: [], permission_mode: 'default' } };
const result = extra => ({ event: 'result', result: Object.assign({ conversation_id: 'c1', status: 'SUCCESS', response: '', num_turns: 1, duration_seconds: 1,
  usage: { input_tokens: 100, output_tokens: 12, thinking_tokens: 5, cache_read_tokens: 60, total_tokens: 112 } }, extra || {}) });
const TOOLS = [{ type: 'function', function: { name: 'fs_read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

(async () => {
  // A. registry + factory: the 'agy' alias, keyless, not blanket-unmetered, the factory builds it.
  A.ok(factory.PROVIDER_IDS.indexOf('antigravity') >= 0, 'antigravity is registered');
  A.eq(factory.normalizeProviderId('agy', ''), 'antigravity', 'agy alias normalizes to antigravity');
  A.eq(factory.normalizeProviderId('antigravity-cli', ''), 'antigravity', 'antigravity-cli alias normalizes');
  A.eq(factory.normalizeProviderId('google', ''), 'gemini', 'google still means the Gemini API');
  A.eq(factory.providerRequiresKey('antigravity'), false, 'antigravity needs no key');
  A.eq(!!factory.getProviderProfile('antigravity').unmetered, false, 'not blanket-unmetered (a Gemini-key sign-in bills)');
  A.eq(typeof factory.selectProvider({ provider: 'agy' }).stream, 'function', 'factory builds the adapter');

  // B. text turn: headless stream-json, sandboxed, never skips permissions; deltas stream; subscription books $0.
  {
    const { p, calls } = make({ lines: [init, delta('Hel'), delta('lo'), result({ response: 'Hello' })] });
    const evs = await collect(p, { model: 'Gemini 3.1 Pro (High)', reasoningEffort: 'high', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] });
    const args = calls[0].args;
    A.eq(args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json'], 'stream-json in and out');
    A.eq(args[args.length - 1], '-p', 'headless print mode, last (the prompt is on stdin)');
    A.ok(args.indexOf('--sandbox') >= 0 && args.indexOf('--disable-slash-commands') >= 0, 'sandboxed, no slash commands');
    A.ok(args.indexOf('--dangerously-skip-permissions') < 0 && args.indexOf('--mode') < 0, 'never auto-approves agy\'s own tools');
    A.eq(args[args.indexOf('--model') + 1], 'Gemini 3.1 Pro (High)', 'a display-string slug passes through as one argv entry');
    A.eq(args[args.indexOf('--effort') + 1], 'high', 'reasoning effort maps to --effort');
    A.ok(/starnet-agy-/.test(calls[0].opts.cwd) && !realFs.existsSync(calls[0].opts.cwd), 'runs in a fresh empty temp folder, removed after the turn');
    const line = JSON.parse(calls[0].stdin);
    A.eq(line.event, 'user', 'stdin carries the documented user event');
    const text = line.message.content[0].text;
    A.ok(/^<starnet_instructions>\nbe brief/.test(text) && /Do NOT use any of your own built-in tools/.test(text), 'StarNet\'s system prompt and the no-native-tools rule lead the turn');
    A.ok(/<user>\nhi\n<\/user>$/.test(text), 'the transcript follows');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'deltas stream; the result text is not duplicated');
    const u = evs.find(e => e.type === 'usage').usage;
    A.eq([u.prompt_tokens, u.completion_tokens, u.prompt_tokens_details.cached_tokens, u.reasoning_tokens], [100, 12, 60, 5], 'real token counts');
    A.eq([u.cost, u.subscription], [0, true], 'a Google sign-in books $0 and counts toward the subscription ceiling');
    A.eq(evs[0], { type: 'billing', perCall: false }, 'a subscription turn says first that it bills nothing per call');
    A.eq(evs.filter(e => e.type === 'done'), [{ type: 'done', finishReason: 'stop', truncated: false }], 'exactly one done');
  }

  // C. a Gemini API key sign-in is billed and unpriced here: no $0, no billing fact.
  {
    const { p } = make({ lines: [result({ response: 'ok' })] }, { settings: { auth: { type: 'gemini-api-key' } } });
    const evs = await collect(p, { messages: [{ role: 'user', content: 'x' }] });
    A.eq(evs.find(e => e.type === 'usage').usage.cost, undefined, 'a keyed turn stays honestly unpriced');
    A.ok(!evs.some(e => e.type === 'billing'), 'and carries no per-call billing fact');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'result.response is used when nothing streamed');
    A.eq(_internals.isSubscription('', { GEMINI_API_KEY: 'k' }), false, 'no auth.type + a Gemini key in reach = not provably a subscription');
    A.eq(_internals.isSubscription('oauth-business', {}), true, 'Gemini Enterprise sign-in is a subscription');
  }

  // D. StarNet tool calls: the <function_calls> text protocol becomes harness tool events; the turn stops at the block.
  {
    const { p, calls } = make({ lines: [init, delta('Reading. <function_calls>\n<invoke name="fs_read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>'), delta('<tool_result>made up</tool_result>'), result()] });
    const evs = await collect(p, { tools: TOOLS, messages: [{ role: 'user', content: 'read a.txt' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join('').trim(), 'Reading.', 'prose streams; the call block does not');
    const start = evs.find(e => e.type === 'tool_start');
    A.ok(start && start.name === 'fs_read' && /^call_agy_[0-9a-f]{8}_1_0$/.test(start.id), 'tool_start names the tool with a unique id');
    A.eq(JSON.parse(evs.find(e => e.type === 'tool_args').chunk), { path: 'a.txt' }, 'arguments parsed from the parameters');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'the call ends the turn');
    A.ok(!evs.some(e => e.type === 'text' && /made up/.test(e.delta)), 'nothing after the call block (a guessed result) reaches the loop');
    A.ok(/# Tools/.test(JSON.parse(calls[0].stdin).message.content[0].text), 'the tool protocol is in the prompt');
  }

  // E. FAIL CLOSED: agy starting its own tool kills the child and fails the turn.
  {
    const { p, calls } = make({ lines: [init, delta('let me check'), step('tool', { tool_name: 'read_file' })], stay: true });
    const e = await failure(p, { tools: TOOLS, messages: [{ role: 'user', content: 'hi' }] });
    A.ok(e && e.code === 'native_tool_blocked' && /read_file/.test(e.message), 'native tool step -> native_tool_blocked: ' + (e && e.message));
    A.ok(calls[0].killed, 'the child is killed');
  }

  // F. failures classify: signed out -> 401, spent plan -> 429 usage_limit_reached, unknown model, no result line.
  {
    const signedOut = await failure(make({ lines: [result({ status: 'ERROR', error: 'authentication required' })] }).p, { messages: [{ role: 'user', content: 'x' }] });
    A.ok(signedOut && signedOut.status === 401 && /run `agy` once/.test(signedOut.message), 'auth error -> 401 with the remedy');
    const quota = await failure(make({ lines: [result({ status: 'ERROR', error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' } })] }).p, { messages: [{ role: 'user', content: 'x' }] });
    A.ok(quota && quota.status === 429 && quota.code === 'usage_limit_reached', 'spent quota -> usage_limit_reached');
    const model = await failure(make({ lines: [result({ status: 'ERROR', error: 'unknown model "nope"' })] }).p, { model: 'nope', messages: [{ role: 'user', content: 'x' }] });
    A.ok(model && model.code === 'model_not_found', 'unknown model is named as such');
    const dead = await failure(make({ lines: [], stderr: 'boom', code: 3 }).p, { messages: [{ role: 'user', content: 'x' }] });
    A.ok(dead && /exited with code 3 before answering: boom/.test(dead.message), 'no result line -> exit code and stderr tail');
    const missing = await failure(makeAntigravityCliProvider({ spawn: fakeSpawn({}).spawn, fs: Object.assign({}, realFs, { statSync() { throw new Error('nope'); } }), env: { PATH: '/nowhere' }, platform: 'linux' }), { messages: [{ role: 'user', content: 'x' }] });
    A.ok(missing && missing.code === 'provider_not_configured' && /not installed/.test(missing.message), 'no agy binary -> install remedy');
  }

  // G. Stop: an aborted signal kills the child and yields nothing more.
  {
    const ctrl = new AbortController();
    const { p, calls } = make({ hang: true });
    const it = p.stream({ signal: ctrl.signal, messages: [{ role: 'user', content: 'x' }] });
    const first = it.next();
    setTimeout(() => ctrl.abort(), 20);
    const r = await first;
    A.ok(r.done || (r.value && r.value.type === 'billing'), 'nothing but the billing fact before Stop');
    if (!r.done) A.ok((await it.next()).done, 'the stream ends on Stop');
    A.ok(calls[0].killed, 'Stop kills the child');
  }

  // H. the catalog is `agy models`: decorations dropped, a slug's own parentheses kept, auth failure explained.
  {
    A.eq(_internals.parseModels('Available models:\n  * Gemini 3.1 Pro (High) (current)\n  - Claude Opus 5.5 (Thinking)\n\u001b[2mGemini 3.8 Flash\u001b[0m\n'),
      ['Gemini 3.1 Pro (High)', 'Claude Opus 5.5 (Thinking)', 'Gemini 3.8 Flash'], 'parseModels keeps slugs exactly');
    const { p, calls } = make({ stdout: 'Gemini 3.8 Flash\nClaude Sonnet 5.5 (Thinking)\n' });
    const models = await p.listModels();
    A.eq(calls[0].args, ['models'], 'the catalog comes from `agy models`');
    A.eq(models.map(m => m.id), ['Gemini 3.8 Flash', 'Claude Sonnet 5.5 (Thinking)'], 'live catalog, nothing hardcoded');
    A.ok(models.every(m => m.supportsTools && m.context_length === 200000), 'tools via the text protocol; conservative window');
    const out = await make({ stdout: '', stderr: 'Error: authentication required', code: 1 }).p.listModels().then(() => null, e => e);
    A.ok(out && out.status === 401, 'a signed-out catalog says to sign in');
  }

  // I. images degrade to a note (agy's stdin takes text blocks only).
  {
    const text = _internals.composePrompt([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }], []);
    A.ok(/look\n\[image omitted — the Antigravity CLI takes text input only\]/.test(text) && !/AAAA/.test(text), 'image replaced by an honest note');
  }

  // J. a native tool step queued right behind a finished call block still fails the turn (screened on arrival).
  {
    const block = '<function_calls>\n<invoke name="fs_read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>';
    const { p, calls } = make({ stdout: [init, delta(block), step('tool', { tool_name: 'run_command' })].map(l => JSON.stringify(l)).join('\n') + '\n', stay: true });
    const e = await failure(p, { tools: TOOLS, messages: [{ role: 'user', content: 'read a.txt' }] });
    A.ok(e && e.code === 'native_tool_blocked' && /run_command/.test(e.message), 'a native tool after the call block -> native_tool_blocked: ' + (e && e.message));
    A.ok(calls[0].killed, 'and the child is stopped');
  }

  // K. usage: a call-block turn with no count estimates the prompt it sent; a completed count is authoritative.
  {
    const block = '<function_calls>\n<invoke name="fs_read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>';
    const { p, calls } = make({ lines: [init, delta(block)], stay: true });
    const evs = await collect(p, { tools: TOOLS, messages: [{ role: 'user', content: 'read a.txt' }] });
    const u = evs.find(e => e.type === 'usage').usage;
    const sent = JSON.parse(calls[0].stdin).message.content[0].text.length;
    A.eq(u.prompt_tokens, Math.ceil(sent / 4), 'no input count -> the composed prompt is estimated, not booked as 0');
    A.ok(calls[0].killed, 'the child is stopped once the call block completes');
    const long = 'x'.repeat(400);
    const done = await collect(make({ lines: [delta(long), result({ usage: { input_tokens: 10, output_tokens: 3 } })] }).p, { messages: [{ role: 'user', content: 'x' }] });
    A.eq(done.find(e => e.type === 'usage').usage.completion_tokens, 3, 'a completed result keeps its reported output count');
  }

  // L. spawning: a .cmd shim is refused with the remedy; on POSIX the child leads a process group, killed TERM then KILL.
  {
    const shim = await failure(makeAntigravityCliProvider({ spawn: fakeSpawn({}).spawn, fs: fakeFs(), bin: 'C:\\agy\\agy.cmd', env: { PATH: '' }, platform: 'win32' }), { messages: [{ role: 'user', content: 'x' }] });
    A.ok(shim && shim.code === 'provider_not_configured' && /STARNET_AGY_BIN/.test(shim.message), 'a .cmd shim -> remedy, not a spawn that cannot work');
    const f = fakeSpawn({ hang: true });
    const signals = [];
    const ctrl = new AbortController();
    const p = makeAntigravityCliProvider({ spawn: f.spawn, killProcess: (pid, sig) => signals.push([pid, sig]), killGraceMs: 5, fs: fakeFs(), bin: 'agy', env: { PATH: '', HOME: os.tmpdir() }, platform: 'linux' });
    const run = collect(p, { signal: ctrl.signal, messages: [{ role: 'user', content: 'x' }] });
    setTimeout(() => ctrl.abort(), 20);
    await run;
    A.eq(f.calls[0].opts.detached, true, 'POSIX child leads its own process group');
    await new Promise(r => setTimeout(r, 30));
    const firstOf = sig => signals.findIndex(x => x[0] === -4343 && x[1] === sig);
    A.ok(signals.every(x => x[0] === -4343) && firstOf('SIGTERM') === 0 && firstOf('SIGKILL') > 0, 'Stop signals the whole group, TERM then KILL: ' + JSON.stringify(signals));
    A.ok(!realFs.existsSync(f.calls[0].opts.cwd), 'the scratch folder goes once the group is gone');
  }

  // M. the last stdout line (no trailing newline) is screened too; a result-only answer counts toward output tokens.
  {
    const { p } = make({ stdout: [result({ response: 'ok' }), step('tool', { tool_name: 'write_file' })].map(l => JSON.stringify(l)).join('\n') });
    const e = await failure(p, { messages: [{ role: 'user', content: 'x' }] });
    A.ok(e && e.code === 'native_tool_blocked' && /write_file/.test(e.message), 'a native tool step in the unterminated tail -> native_tool_blocked: ' + (e && e.message));
    const answer = 'y'.repeat(80);
    const evs = await collect(make({ lines: [result({ response: answer, usage: { input_tokens: 10 } })] }).p, { messages: [{ role: 'user', content: 'x' }] });
    A.eq(evs.find(x => x.type === 'usage').usage.completion_tokens, 20, 'no output count + result-only text -> the answer is estimated, not 0');
  }

  A.report('provider.antigravity-cli.test');
})().catch(e => { console.log('FAIL: provider.antigravity-cli.test threw -- ' + (e && e.stack || e)); process.exit(1); });
