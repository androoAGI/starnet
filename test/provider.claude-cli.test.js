/* node test/provider.claude-cli.test.js - the local Claude CLI provider seam (no real `claude` is spawned). */
'use strict';
const fs = require('fs');
const A = require('./_assert.js');
const { EventEmitter } = require('events');
const path = require('path');
const { makeClaudeCliProvider, _internals } = require('../sidecar/providers/claude-cli.js');
const factory = require('../sidecar/providers/factory.js');

// A fake `claude` child: replays stream-json lines, records argv/stdin, and dies when killed.
function fakeSpawn(script) {
  const calls = [];
  function spawn(file, args, opts) {
    const child = new EventEmitter();
    const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = stream(); child.stderr = stream();
    child.pid = 4242; child.exitCode = null;
    let stdin = '';
    child.stdin = { on() {}, end(text) { stdin += text || ''; call.stdin = stdin; setImmediate(run); } };
    const call = { file, args, opts, stdin: '', killed: false };
    calls.push(call);
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => { call.killed = true; exit(null); };
    if (file === 'taskkill') { calls.pop(); const target = calls.find(c => c.child && String(c.child.pid) === args[1]); if (target) target.child.kill(); setImmediate(() => exit(0)); return child; }
    call.child = child;
    function run() {
      const s = typeof script === 'function' ? script(call) : script;
      if (s.hang) return;
      for (const l of s.lines || []) child.stdout.emit('data', (typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
      if (s.stderr) child.stderr.emit('data', s.stderr);
      exit(s.code || 0);
    }
    if (args.indexOf('auth') >= 0) setImmediate(run);
    return child;
  }
  return { spawn, calls };
}
const fakeFs = { statSync() { return { isFile: () => true }; }, writeFileSync() {}, unlinkSync() {} };
const make = (script, extra) => {
  const f = fakeSpawn(script);
  const p = makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: fakeFs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux' }, extra || {}));
  return { p, calls: f.calls };
};
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
const init = src => ({ type: 'system', subtype: 'init', apiKeySource: src, tools: [] });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = (extra) => Object.assign({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', total_cost_usd: 0.25,
  usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 } }, extra || {});

(async () => {
  // A. registry + factory wire the new id without touching the 'claude' alias (still the Anthropic API).
  A.ok(factory.PROVIDER_IDS.indexOf('claude-cli') >= 0, 'claude-cli is registered');
  A.eq(factory.normalizeProviderId('claude-code', ''), 'claude-cli', 'claude-code alias normalizes to claude-cli');
  A.eq(factory.normalizeProviderId('claude', ''), 'anthropic', 'claude alias still means the Anthropic API');
  A.eq(factory.providerRequiresKey('claude-cli'), false, 'claude-cli needs no key');
  A.eq(!!factory.getProviderProfile('claude-cli').unmetered, false, 'claude-cli is not blanket-unmetered (API-key logins bill)');
  A.eq(typeof factory.selectProvider({ provider: 'claude-cli' }).stream, 'function', 'factory builds the adapter');

  // B. text turn: every CLI tool is disabled, deltas stream, subscription login books $0 with real tokens.
  {
    const { p, calls } = make({ lines: [init('none'), delta('Hel'), delta('lo'), result({ result: 'Hello' })] });
    const evs = await collect(p, { model: 'sonnet', reasoningEffort: 'high', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] });
    const args = calls[0].args;
    A.eq(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', ''], 'built-in CLI tools are disabled');
    A.ok(args.indexOf('--strict-mcp-config') >= 0 && args[args.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}', 'no MCP server reaches the CLI');
    A.ok(args.indexOf('--disable-slash-commands') >= 0 && args.indexOf('--no-session-persistence') >= 0, 'no skills, no session file');
    A.eq(args[args.indexOf('--model') + 1], 'sonnet', 'model is passed through');
    A.eq(args[args.indexOf('--effort') + 1], 'high', 'reasoning effort maps to --effort');
    A.ok(args.indexOf('--system-prompt-file') >= 0, 'system prompt travels in a file, not argv');
    A.eq(calls[0].stdin, 'hi', 'a single user message is sent verbatim on stdin');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas stream (result text not duplicated)');
    const usage = evs.find(e => e.type === 'usage').usage;
    A.eq([usage.prompt_tokens, usage.completion_tokens, usage.prompt_tokens_details.cached_tokens], [35, 7, 20], 'real token counts');
    A.eq(usage.cost, 0, 'subscription login books $0');
    A.eq(evs.filter(e => e.type === 'done'), [{ type: 'done', finishReason: 'stop', truncated: false }], 'exactly one done');
  }

  // C. API-key login books the CLI's own reported cost.
  {
    const { p } = make({ lines: [init('ANTHROPIC_API_KEY'), result({ result: 'ok' })] });
    const evs = await collect(p, { model: 'haiku', messages: [{ role: 'user', content: 'x' }] });
    A.eq(evs.find(e => e.type === 'usage').usage.cost, 0.25, 'API-key login books total_cost_usd');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'result text is used when no delta streamed');
  }

  // D. tool calls: blocks become harness tool events, split across deltas, prose around them preserved.
  {
    const { p } = make({ lines: [init('none'), delta('Let me look. <tool_'), delta('call>{"name":"fs.read","arguments":{"path":"a.txt"}}</tool_call>'), result()] });
    const tools = [{ type: 'function', function: { name: 'fs.read', description: 'read', parameters: { type: 'object' } } }];
    const evs = await collect(p, { model: 'sonnet', tools, messages: [{ role: 'user', content: 'read a.txt' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Let me look. ', 'prose before the call streams; the block does not');
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start && start.name, 'fs.read', 'tool_start names the tool');
    // (sweep 10-02) ids are unique across adapters: a fresh adapter per request used to restart at call_cli_1_0
    const again = await collect(make({ lines: [init('none'), delta('<tool_call>{"name":"fs.read","arguments":{"path":"b.txt"}}</tool_call>'), result()] }).p, { model: 'sonnet', tools, messages: [{ role: 'user', content: 'read b.txt' }] });
    const start2 = again.find(e => e.type === 'tool_start');
    A.ok(start && start2 && /^call_cli_[0-9a-f]{8}_1_0$/.test(start.id) && start.id !== start2.id, 'two requests never reuse a tool-call id: ' + [start && start.id, start2 && start2.id].join(' vs '));
    A.eq(JSON.parse(evs.find(e => e.type === 'tool_args').chunk), { path: 'a.txt' }, 'tool_args carry the JSON arguments');
    A.ok(evs.some(e => e.type === 'tool_done'), 'tool_done closes the call');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'a call ends the turn as tool_calls');
  }

  // E. multi-turn transcript: prior calls and results are rendered for the model.
  {
    const built = _internals.buildPrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'milk' }
    ], [{ type: 'function', function: { name: 'fs.read', parameters: {} } }]);
    A.ok(/^sys\n\n# Tools/.test(built.system), 'system prompt keeps the host system text, then the tool protocol');
    A.ok(built.input.indexOf('<function_calls>\n<invoke name="fs.read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>') >= 0, 'prior call rendered in the format the model is asked to write');
    A.ok(/<function_calls>/.test(built.system) && /write nothing more/.test(built.system), 'the tool protocol asks for the model\'s own call format and a stop after the block');
    A.ok(built.input.indexOf('<tool_result id="c1">\nmilk\n</tool_result>') >= 0, 'prior result rendered');
    A.ok(/No tools are available in this turn/.test(_internals.toolsPrompt([])), 'a toolless (chat) turn says so, so the model never improvises tool markup');
    const sp = _internals.makeCallSplitter();
    A.eq(sp.push('a <tool_call>not json').text + sp.end().text, 'a <tool_call>not json', 'an unclosed, unparseable block stays prose');
  }

  // E2. a file-sized call is ANNOUNCED while it streams (2026-10-02: "waiting for 6:15", nothing shown, while the CLI
  //     wrote a whole game into one fs_write block), never dumped as prose when it ends broken.
  {
    const sp = _internals.makeCallSplitter();
    const mid = sp.push('<tool_call>{"name": "fs_write", "arguments": {"path": "index.html", "content": "<html>');
    A.eq(mid.items.map(i => i.start || (i.text != null ? 'text' : 'body')), ['fs_write'], 'the tool name starts the call before its block closes');
    A.eq(sp.push('</html>"}}</tool_call>').items.map(i => i.closed), [true], 'the close follows as the body');
    const nested = _internals.makeCallSplitter().push('<tool_call>{"arguments": {"name": "inner", "x": 1');
    A.eq(nested.items.length, 0, 'a "name" inside the arguments never announces a call');

    const tools = [{ type: 'function', function: { name: 'fs_write', description: 'write', parameters: { type: 'object' } } }];
    const req = { model: 'opus', tools, messages: [{ role: 'user', content: 'make a game' }] };
    const ordered = await collect(make({ lines: [init('none'), delta('Building it. <tool_call>{"name":"fs_write","arguments":{"path":"a.html","content":"x"}}</tool_call>'), delta('\n<tool_call>{"name":"fs_write","arguments":{"path":"b.html","content":"y"}}</tool_call>'), result()] }).p, req);
    A.eq(ordered.filter(e => e.type !== 'usage' && e.type !== 'done').map(e => e.type), ['text', 'tool_start', 'tool_args', 'tool_done', 'tool_start', 'tool_args', 'tool_done'], 'prose then back-to-back calls keep their order');

    // a raw newline inside a string (the commonest slip in a big write) is repaired into a real call
    const raw = await collect(make({ lines: [init('none'), delta('<tool_call>{"name":"fs_write","arguments":{"path":"a.html","content":"<p>\n</p>"}}</tool_call>'), result()] }).p, req);
    const rawArgs = raw.find(e => e.type === 'tool_args');
    A.eq(rawArgs && JSON.parse(rawArgs.chunk), { path: 'a.html', content: '<p>\n</p>' }, 'a raw newline in a string is repaired, not dumped as prose');

    // the output limit cut the call off: it still reaches the loop as that call (the loop refuses a cut-off value)
    const cut = await collect(make({ lines: [init('none'), delta('<tool_call>{"name":"fs_write","arguments":{"path":"a.html","content":"<html><body>'), result({ stop_reason: 'max_tokens' })] }).p, req);
    A.ok(!cut.some(e => e.type === 'text' && /<html>/.test(e.delta)), 'a cut-off file is never pasted into the chat');
    const cutArgs = cut.find(e => e.type === 'tool_args');
    A.ok(cut.some(e => e.type === 'tool_start' && e.name === 'fs_write') && cutArgs && /^\{"path":"a.html","content":"<html><body>/.test(cutArgs.chunk), 'a cut-off call reaches the loop with its arguments as written');
  }

  // E3. THE MODEL'S OWN FORMAT + THE STOP (2026-10-02 report: a game written as <invoke name="fs_write"> blocks was
  //     pasted into the chat, nothing ran, and the model kept writing calls until it said every result came back empty).
  {
    const tools = [
      { type: 'function', function: { name: 'fs_write', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } },
      { type: 'function', function: { name: 'brief', description: 'brief', parameters: { type: 'object', properties: { objective: { type: 'string' }, assumptions: { type: 'array' }, count: { type: 'integer' } } } } }
    ];
    const req = { model: 'opus', tools, messages: [{ role: 'user', content: 'make a game' }] };
    const file = '/* game */\nconst a = "q";\nif (a < 2 && b > 1) {}\n';
    // the CLI is still generating when the block ends (no exit, no result line): only the stop can end this turn
    const nativeLines = [init('none'),
      delta('On it.\n\n<function_calls>\n<invoke name="brief">\n<parameter name="objective">A "fun" game</parameter>\n<parameter name="assumptions">["three.js", "first person"]</parameter>\n<parameter name="count">8</parameter>\n</invoke>\n<inv'),
      delta('oke name="fs_write">\n<parameter name="path">game/core.js</parameter>\n<parameter name="content">' + file + '</parameter>\n</invoke>\n</function_calls>'),
      delta('\n\n<invoke name="shell_exec">\n<parameter name="cmd">node tests/bot.js</parameter>\n</invoke>\nEvery tool result came back empty.')];
    const native = make(call => { for (const l of nativeLines) call.child.stdout.emit('data', JSON.stringify(l) + '\n'); return { hang: true }; }, { idleMs: 3000 });
    const evs = await collect(native.p, req);
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'On it.\n\n', 'only the prose before the block is shown: no call markup reaches the chat');
    A.eq(evs.filter(e => e.type === 'tool_start').map(e => e.name), ['brief', 'fs_write'], 'both calls in the block run; the guess written after it does not');
    const args = evs.filter(e => e.type === 'tool_args').map(e => JSON.parse(e.chunk));
    A.eq(args[0], { objective: 'A "fun" game', assumptions: ['three.js', 'first person'], count: 8 }, 'string values stay raw; arrays and numbers parse as JSON');
    A.eq(args[1], { path: 'game/core.js', content: file }, 'a file arrives exactly as written: quotes, < and > untouched');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'the block ends the turn as tool_calls');
    A.ok(native.calls[0].killed, 'the CLI is stopped at the end of the block instead of writing on');

    // no <function_calls> wrapper: the first thing after the call that is not another call ends the turn
    const bare = await collect(make({ lines: [init('none'), delta('<invoke name="fs_write">\n<parameter name="path">a.txt</parameter>\n<parameter name="content">hi</parameter>\n</invoke>\n\nI have to stop: every result came back empty.'), result()] }).p, req);
    A.eq([bare.filter(e => e.type === 'tool_start').length, bare.filter(e => e.type === 'text').length], [1, 0], 'a bare call runs and the guess after it is dropped');

    // the output limit cut a native call off inside its content: the value reaches the loop still open (it is refused)
    const cut = await collect(make({ lines: [init('none'), delta('<function_calls>\n<invoke name="fs_write">\n<parameter name="path">a.html</parameter>\n<parameter name="content"><html><body>'), result({ stop_reason: 'max_tokens' })] }).p, req);
    const cutArgs = cut.find(e => e.type === 'tool_args');
    A.ok(cutArgs && cutArgs.chunk === '{"path":"a.html","content":"<html><body>', 'a cut-off native call is handed over with its value open: ' + (cutArgs && cutArgs.chunk));
    A.ok(!cut.some(e => e.type === 'text'), 'a cut-off native call is never pasted into the chat');

    // a toolless (chat) turn reads no calls at all: markup there is shown as written
    const chat = await collect(make({ lines: [init('none'), delta('Use <invoke name="x"> like this.'), result()] }).p, { model: 'opus', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    A.eq(chat.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Use <invoke name="x"> like this.', 'a chat turn never turns prose into a call');
  }

  // F. failures are errors, never a silent empty delivery.
  {
    const { p } = make({ lines: [init('none'), result({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached' })] });
    let err = null; try { await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && /usage limit/.test(err.message), 'CLI error result throws with its message');
    const q = make({ lines: [], code: 1, stderr: 'boom' }).p;
    err = null; try { await collect(q, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && /exited with code 1/.test(err.message) && /boom/.test(err.message), 'exit without a result throws with stderr');
    // (sweep 2026-10-02) a FAILED turn on an API-key sign-in was still billed: its cost is reported before the error
    const billed = make({ lines: [init('user'), result({ is_error: true, subtype: 'error_during_execution', result: 'overloaded', total_cost_usd: 0.18 })] }).p;
    const seen = []; err = null;
    try { for await (const e of billed.stream({ model: 'sonnet', messages: [{ role: 'user', content: 'x' }] })) seen.push(e); } catch (e) { err = e; }
    const u = seen.find(e => e.type === 'usage');
    A.ok(err && u && u.usage.cost === 0.18 && u.usage.completion_tokens === 7, 'a failed API-key turn reports its billed cost before it throws');
  }

  // G. Stop kills the child and ends without an error or a done.
  {
    const { p, calls } = make({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const evs = await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }], signal: ac.signal });
    A.ok(calls[0].killed, 'abort kills the CLI process');
    A.eq(evs.length, 0, 'a cancelled turn emits nothing');
  }

  // H. idle watchdog kills a silent child and surfaces a timeout.
  {
    const { p, calls } = make({ hang: true }, { idleMs: 30 });
    let err = null; try { await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && err.timeout === true && calls[0].killed, 'idle timeout kills the child and throws a timeout');
  }

  // I. listModels is gated on `claude auth status`.
  {
    const ok = make(call => ({ lines: call.args.indexOf('auth') >= 0 ? [{ loggedIn: true, authMethod: 'claude.ai' }] : [] })).p;
    const listed = await ok.listModels();
    const ids = listed.map(m => m.id);
    A.eq(ids.slice(0, 7), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5[1m]', 'claude-opus-4-8', 'claude-sonnet-4-6'], 'signed-in CLI lists the named models first');
    A.ok(['opus', 'sonnet', 'haiku'].every(a => ids.indexOf(a) >= 0), 'the aliases stay listed, so a station already pinned to one keeps its model');
    A.ok(!ids.some(id => /fable/i.test(id)), 'Fable is not listed (an account without it is silently served Opus 4.8)');
    A.eq([listed.find(m => m.id === 'claude-opus-5-5[1m]').context_length, listed.find(m => m.id === 'claude-opus-5-5').context_length], [1000000, 200000], 'the 1M variants carry their real context window');
    A.eq([ok.contextLimit('claude-sonnet-5-5[1m]'), ok.contextLimit('sonnet'), ok.contextLimit('custom-m')], [1000000, 200000, 200000], 'contextLimit follows the model (and only a real [1m] suffix means 1M)');
    const out = make(call => ({ lines: [{ loggedIn: false }], code: 1 })).p;
    let err = null; try { await out.listModels(); } catch (e) { err = e; }
    A.ok(err && /not signed in/.test(err.message) && err.code === 'provider_not_configured', 'signed-out CLI lists nothing and says why');
    const none = makeClaudeCliProvider({ spawn: fakeSpawn({}).spawn, fs: { statSync() { throw new Error('ENOENT'); } }, env: { PATH: path.join('nowhere') }, platform: 'linux' });
    err = null; try { await none.listModels(); } catch (e) { err = e; }
    A.ok(err && /not installed/.test(err.message), 'missing CLI lists nothing and says how to install it');
    // (sweep 2026-10-02) macOS app opened from the Finder: bare PATH, Homebrew/npm `claude` → found, and its JS run by the station's Node
    const brewCli = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    const fsMac = { statSync(p) { if (String(p).replace(/\\/g, '/') === '/opt/homebrew/bin/claude') return { isFile: () => true }; throw new Error('ENOENT'); },
      realpathSync(p) { return String(p).replace(/\\/g, '/') === '/opt/homebrew/bin/claude' ? brewCli : p; }, writeFileSync() {}, unlinkSync() {} };
    const fsp = fakeSpawn({ lines: [{ loggedIn: true, authMethod: 'claude.ai' }], code: 0 });
    const mac = makeClaudeCliProvider({ spawn: fsp.spawn, fs: fsMac, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/me' }, platform: 'darwin' });
    try { await mac.listModels(); } catch (_) {}
    const first = fsp.calls[0];
    A.ok(first && first.file === process.execPath && String(first.args[0]).replace(/\\/g, '/') === brewCli, 'a Finder-launched Mac finds the Homebrew/npm claude and runs its cli.js with the station\'s Node: ' + JSON.stringify(first && [first.file, first.args && first.args[0]]));
  }

  // K. a lost sign-in (the CLI's real v2.1.284 shape) is an `auth` failure, never a retried `unknown`.
  {
    const lost = { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] } };
    const { p } = make({ lines: [init('none'), lost, result({ is_error: true, subtype: 'success', result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })] });
    let err = null; try { await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && err.status === 401 && /not signed in/.test(err.message), 'lost sign-in throws a 401 that says how to fix it');
    const cls = require('../sidecar/providers/errorClass.js').classifyApiError(err, {});
    A.eq(cls.reason || cls.kind || cls.class, 'auth', 'errorClass files it as auth (no ~105s retry ladder)');
  }

  // J. the CLI child never inherits station secrets, and its own auto-memory stays out of the turn.
  {
    const env = { PATH: '', STARNET_CREDITS_TOKEN: 'credits-secret', SKYNET_API_TOKEN: 'api-secret', CLAUDECODE: '1', HOME: '/h' };
    const { p, calls } = make({ lines: [init('none'), result({ result: 'ok' })] }, { env });
    await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] });
    const childEnv = calls[0].opts.env;
    A.ok(childEnv && !Object.keys(childEnv).some(k => /^(STARNET|SKYNET)_/i.test(k)), 'no STARNET_/SKYNET_ variable reaches the CLI');
    A.eq([childEnv.CLAUDECODE, childEnv.HOME, childEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY], [undefined, '/h', '1'], 'not a nested session; user env kept; auto-memory off');
  }

  // L. subscription stacking: an extra account runs as its own CLI identity; the default sign-in sets nothing.
  {
    const { p, calls } = make({ lines: [init('none'), result({ result: 'ok' })] }, { configDir: '/ws/.secrets/accounts/claude-cli/abc12345' });
    await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] });
    A.eq(calls[0].opts.env.CLAUDE_CONFIG_DIR, '/ws/.secrets/accounts/claude-cli/abc12345', 'an extra account points the CLI at its own config dir');
    const d = make({ lines: [init('none'), result({ result: 'ok' })] }, { env: { PATH: '', CLAUDE_CONFIG_DIR: '/user/own' } });
    await collect(d.p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] });
    A.eq(d.calls[0].opts.env.CLAUDE_CONFIG_DIR, '/user/own', 'the primary keeps whatever CLI identity the user already runs');
    const tagged = factory.selectProvider({ provider: 'claude-cli', configDir: '/acct' });
    A.eq(typeof tagged.stream, 'function', 'factory builds an account-bound adapter');
  }

  // M. a spent subscription (the CLI's real `error:"rate_limit"` line) is quota_exhausted: rotate, never retry it.
  {
    const spent = { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit · resets 5pm (America/Los_Angeles)" }] } };
    const { p } = make({ lines: [init('none'), spent, result({ is_error: true, subtype: 'success', result: "You've hit your limit · resets 5pm (America/Los_Angeles)" })] });
    let err = null; try { await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && err.status === 429 && /hit your limit/.test(err.message), 'a spent window throws a 429 carrying the CLI text');
    const cls = require('../sidecar/providers/errorClass.js').classifyApiError(err, {});
    A.eq([cls.reason, cls.retryable, cls.shouldRotateCredential], ['quota_exhausted', false, true], 'errorClass rotates to the next account instead of retrying');
  }

  // 10-08: a turn with an image rides the CLI's stream-json input as real image blocks (Opus 5.5 read a thumbnail live);
  // a text-only turn keeps the plain stdin byte-for-byte. image_analyze's session fallback can now use a Claude Code agent.
  {
    const png = 'iVBORw0KGgo=';
    const { p, calls } = make({ lines: [init('none'), result({ result: 'FINAL BOSS?' })] });
    const out = await collect(p, { model: 'opus', messages: [{ role: 'user', content: [{ type: 'text', text: 'What does it say?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }] });
    A.ok(calls[0].args.join(' ').includes('--input-format stream-json'), 'an image turn asks the CLI for stream-json input');
    const msg = JSON.parse(calls[0].stdin);
    A.eq([msg.type, msg.message.role], ['user', 'user'], 'stdin is one stream-json user message');
    const c = msg.message.content;
    A.eq(c[0], { type: 'text', text: 'What does it say?\n[image 1 — attached below]' }, 'the text says where the image sat');
    A.eq(c.slice(1), [{ type: 'text', text: 'Image 1:' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }], 'the picture itself is sent as an Anthropic image block');
    A.ok(out.some(e => e.type === 'text' && /FINAL BOSS/.test(e.delta)), 'the answer streams back as usual');

    const plain = make({ lines: [init('none'), result({ result: 'ok' })] });
    await collect(plain.p, { model: 'opus', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(plain.calls[0].args.indexOf('--input-format') < 0 && plain.calls[0].stdin === 'hi', 'a text-only turn is unchanged (no stream-json input)');

    // a screenshot inside a transcript, an http image, an svg the API cannot take, and the cap on old images
    const t = make({ lines: [init('none'), result({ result: 'ok' })] });
    const many = [];
    for (let k = 0; k < 22; k++) many.push({ type: 'image_url', image_url: { url: 'data:image/jpg;base64,QUJD' + k } });
    await collect(t.p, { model: 'opus', messages: [
      { role: 'user', content: 'look' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE]' }, { type: 'image_url', image_url: { url: 'https://x.test/a.png' } }, { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }].concat(many) }
    ] });
    const tc = JSON.parse(t.calls[0].stdin).message.content;
    const imgs = tc.filter(b => b.type === 'image');
    A.eq(imgs.length, 20, 'at most 20 images ride one turn (the newest)');
    A.ok(tc[0].text.includes('[earlier image no longer attached]') && !tc[0].text.includes('https://x.test/a.png'), 'an image past the cap leaves a note');
    A.ok(tc[0].text.includes('[image attachment omitted — it could not be sent to the Claude Code brain]'), 'an svg (not an API image type) is a note, never a broken block');
    A.eq(imgs[0].source.media_type, 'image/jpeg', 'image/jpg is normalized to image/jpeg');
    A.ok(tc[0].text.includes('<conversation>') && tc[0].text.includes('[image 20 — attached below]') && !tc[0].text.includes('\u0000'), 'the transcript is intact and every mark is resolved');
  }
  {
    const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');
    const p = makeClaudeCliProvider({ clock: { now: () => Date.now() } });
    A.eq(typeof p.supportsImages === 'function' ? p.supportsImages() : 'missing', true, 'the Claude Code provider reports an image channel');
    const idx = fs.readFileSync(require('path').join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
    const aux = idx.slice(idx.indexOf('const auxVisionCall = async (req) => {'), idx.indexOf('const imageTools = makeImageTools('));
    A.ok(/!auxVisionProvider\.supportsImages\(\)\) throw new Error\('no vision route/.test(aux) && aux.indexOf('supportsImages') < aux.indexOf('.stream('),
      'the aux vision route refuses a provider that cannot see images BEFORE asking it to describe one');
    A.ok(aux.includes('AbortSignal.any([ac.signal, signal])') && aux.includes('signal: callSignal'), 'QA 10-02: the aux vision call ends when its run is stopped');
    A.ok(aux.includes("ev.type === 'usage') usage = ev.usage") && aux.includes('recordMediaUsage(usage, model)') && !aux.includes("ev.type === 'done') break"), 'QA 10-02: its usage is booked like media spend (read to the end of the stream)');
  }
  // #68: the stable cacheSystemPrefix + tools sit before the CLI's dynamic boundary and the per-run block after it,
  // so a new run reads the stable part from the CLI prompt cache
  {
    const files = [];
    const fsRec = Object.assign({}, fakeFs, { writeFileSync(p, data) { files.push(data); } });
    const { p, calls } = make({ lines: [init('none'), result({ result: 'ok' })] }, { fs: fsRec });
    const prefix = 'You are the researcher.\n';
    const run = id => ({ model: 'sonnet', cacheSystemPrefix: prefix, messages: [{ role: 'system', content: prefix + '\n\n[RUNTIME]\nRun id: ' + id }, { role: 'user', content: 'hi' }] });
    await collect(p, run('r1'));
    await collect(p, run('r2'));
    const [head1, tail1] = files[0].split('\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n');
    const [head2, tail2] = files[1].split('\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n');
    A.ok(head1 && head1 === head2 && head1.startsWith('You are the researcher.') && !head1.includes('Run id'), 'the stable part before the boundary is identical across runs');
    A.ok(tail1 === '[RUNTIME]\nRun id: r1' && tail2 === '[RUNTIME]\nRun id: r2', 'the per-run block stays in the system prompt, after the boundary');
    A.ok(head1.indexOf('# Tools') > 0, 'the tool catalog sits on the stable side of the boundary');
    A.eq(calls[0].stdin, 'hi', 'the transcript on stdin is unchanged');
    const miss = _internals.buildPrompt([{ role: 'system', content: 'other system' }, { role: 'user', content: 'hi' }], [], prefix);
    const none = _internals.buildPrompt([{ role: 'system', content: 'other system' }, { role: 'user', content: 'hi' }], []);
    A.eq(miss, none, 'a prefix that does not match the system prompt leaves the prompt exactly as before');
  }
  // P. PERSISTENT SESSIONS: one live child per run on stream-json input, each step writes only its new entries.
  {
    // A fake long-lived `claude`: every stdin line is one turn, answered by script(call, turnNo, text); the child stays
    // alive until killed or its stdin ends.
    function liveSpawn(script) {
      const calls = [];
      function spawn(file, args) {
        const child = new EventEmitter();
        const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
        child.stdout = stream(); child.stderr = stream(); child.pid = 5000 + calls.length; child.exitCode = null;
        const call = { file, args, writes: [], killed: false, ended: false, child };
        calls.push(call);
        const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
        child.kill = () => { call.killed = true; exit(null); };
        if (file === 'taskkill') { calls.pop(); const t = calls.find(c => String(c.child.pid) === args[1]); if (t) t.child.kill(); setImmediate(() => exit(0)); return child; }
        let buf = '';
        child.stdin = {
          on() {},
          write(d) {
            buf += d; let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
              const msg = JSON.parse(line);
              if (msg.type === 'control_request') { call.interrupts = (call.interrupts || 0) + 1; continue; }   // the turn already ended
              const text = msg.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
              call.writes.push(text);
              const out = script(call, call.writes.length, text) || [];
              setImmediate(() => { for (const l of out) child.stdout.emit('data', JSON.stringify(l) + '\n'); });
            }
          },
          end() { call.ended = true; setImmediate(() => exit(0)); }
        };
        return child;
      }
      return { spawn, calls };
    }
    const sessions = _internals.sessions;
    const reset = () => { for (const s of sessions.slice()) _internals.retireSession(s); };
    const live = (script, extra) => {
      const f = liveSpawn(script);
      const mk = () => makeClaudeCliProvider(Object.assign({ spawn: f.spawn, fs: fakeFs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', persistent: true }, extra || {}));
      return { mk, calls: f.calls };
    };
    const tools = [{ type: 'function', function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const block = p => '<function_calls>\n<invoke name="fs_read">\n<parameter name="path">' + p + '</parameter>\n</invoke>\n</function_calls>';
    const usageOf = n => ({ input_tokens: 2, cache_creation_input_tokens: 100 * n, cache_read_input_tokens: 1000 * n, output_tokens: 10 });
    // turn 1 and 2 call a tool, turn 3 answers; the cost line is the session's running total like the real CLI's
    const steps = (call, n) => n < 3
      ? [init('ANTHROPIC_API_KEY'), delta('Reading.\n' + block('n' + n + '.md')), result({ result: '', usage: usageOf(n), total_cost_usd: 0.1 * n })]
      : [delta('All read.'), result({ result: 'All read.', usage: usageOf(n), total_cost_usd: 0.1 * n })];
    const base = [{ role: 'system', content: 'You are the archivist. P1' }, { role: 'user', content: 'read the notes' }];
    // what the loop appends after a tool turn: the assistant call (with the id the adapter emitted) and its result
    const after = (msgs, evs, out) => {
      const start = evs.find(e => e.type === 'tool_start'), args = evs.find(e => e.type === 'tool_args');
      return msgs.concat([{ role: 'assistant', content: 'Reading.\n', tool_calls: [{ id: start.id, type: 'function', function: { name: 'fs_read', arguments: args.chunk } }] },
        { role: 'tool', tool_call_id: start.id, content: out }]);
    };

    const { mk, calls } = live(steps);
    const m1 = base;
    const e1 = await collect(mk(), { model: 'sonnet', tools, messages: m1 });
    A.eq(calls.length, 1, 'P1: the first step spawns one child');
    A.ok(calls[0].args.indexOf('--input-format') >= 0 && calls[0].args[calls[0].args.indexOf('--input-format') + 1] === 'stream-json', 'P1: a live session reads stream-json');
    A.ok(calls[0].args.indexOf('--no-session-persistence') >= 0, 'P1: still no session file');
    A.eq(e1.find(e => e.type === 'done').finishReason, 'tool_calls', 'P1: the call block ends the turn as tool_calls');
    A.ok(!calls[0].killed && !calls[0].ended, 'P1: the child is NOT stopped at the end of the block: its turn ended by itself');
    A.eq(calls[0].writes[0], 'read the notes', 'P1: the first step sends the user message');
    const u1 = e1.find(e => e.type === 'usage').usage;
    A.eq([u1.prompt_tokens_details.cache_creation_tokens, u1.prompt_tokens_details.cached_tokens], [100, 1000], 'P1: the turn books its own result usage');

    const m2 = after(m1, e1, 'NOTE ONE');
    const e2 = await collect(mk(), { model: 'sonnet', tools, messages: m2 });
    A.eq(calls.length, 1, 'P2: the next step reuses the same child (a fresh adapter, as the factory builds one per request)');
    A.ok(calls[0].writes[1].startsWith('<tool_result id="') && calls[0].writes[1].indexOf('NOTE ONE') > 0, 'P2: the step sends the tool result');
    A.ok(calls[0].writes[1].indexOf('read the notes') < 0 && calls[0].writes[1].indexOf('<conversation>') < 0, 'P2: and ONLY the tool result, not the transcript again');
    const u2 = e2.find(e => e.type === 'usage').usage;
    A.ok(Math.abs(u2.cost - 0.1) < 1e-9, 'P2: an API-key turn books the difference of the running cost total, not the total');
    A.eq(u2.prompt_tokens_details.cache_creation_tokens, 200, 'P2: usage is the turn\'s own');

    const m3 = after(m2, e2, 'NOTE TWO');
    const e3 = await collect(mk(), { model: 'sonnet', tools, messages: m3 });
    A.eq(calls.length, 1, 'P3: a whole 3-step run is one child');
    A.eq(e3.filter(e => e.type === 'text').map(e => e.delta).join(''), 'All read.', 'P3: the final answer streams');
    A.eq(e3.find(e => e.type === 'done').finishReason, 'stop', 'P3: a text answer ends as stop');
    A.eq(sessions.length, 1, 'P3: the session stays pooled for the next step');

    // a user line after a text answer continues the same session
    const m4 = m3.concat([{ role: 'assistant', content: 'All read.' }, { role: 'user', content: 'thanks' }]);
    await collect(mk(), { model: 'sonnet', tools, messages: m4 });
    A.eq([calls.length, calls[0].writes[3]], [1, '<user>\nthanks\n</user>'], 'P4: a new user line after a text answer is a delta too');

    // history rewritten (compaction): never reuse, spawn fresh with the whole transcript, retire the old child
    const compacted = [m4[0], { role: 'user', content: 'summary of earlier work' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go on' }];
    await collect(mk(), { model: 'sonnet', tools, messages: compacted });
    A.eq(calls.length, 2, 'P5: a rewritten history spawns a fresh child');
    A.ok(calls[0].killed || calls[0].ended, 'P5: the stale session is retired');
    A.ok(calls[1].writes[0].startsWith('<conversation>') && calls[1].writes[0].indexOf('summary of earlier work') > 0, 'P5: the fresh child gets the whole transcript');
    reset();
  }
  {
    // the model keeps writing past its call block (no result of its own): the STOP interrupts it, the CLI answers the
    // interrupt with error_during_execution and zero usage, and the session stays; its next step is told about the cut
    const start = { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 3, cache_creation_input_tokens: 40, cache_read_input_tokens: 900, output_tokens: 1 } } } };
    const f = (call, n) => n === 1
      ? [init('ANTHROPIC_API_KEY'), start, delta('<function_calls>\n<invoke name="fs_read">\n<parameter name="path">a</parameter>\n</invoke>\n</function_calls>\n<tool_result>made up')]
      : [init('ANTHROPIC_API_KEY'), delta('ok'), result({ result: 'ok', total_cost_usd: 0.05 })];
    const onInterrupt = [delta(' and more guessing'), result({ subtype: 'error_during_execution', is_error: true, result: '',
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 })];
    const sessions = _internals.sessions;
    const tools = [{ type: 'function', function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    // a compact live fake: each stdin write is one turn answered by f()
    const calls = [];
    const spawn = (file, args) => {
      const child = new EventEmitter();
      const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
      child.stdout = stream(); child.stderr = stream(); child.pid = 6000 + calls.length; child.exitCode = null;
      const call = { args, writes: [], killed: false, child }; calls.push(call);
      const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('close', code); };
      child.kill = () => { call.killed = true; exit(null); };
      child.stdin = { on() {}, end() { setImmediate(() => exit(0)); }, write(d) {
        const msg = JSON.parse(d);
        if (msg.type === 'control_request') {
          call.interrupts = (call.interrupts || 0) + 1;
          setImmediate(() => { for (const l of onInterrupt) child.stdout.emit('data', JSON.stringify(l) + '\n'); });
          return;
        }
        const text = msg.message.content[0].text; call.writes.push(text);
        const out = f(call, call.writes.length);
        setImmediate(() => { for (const l of out) child.stdout.emit('data', JSON.stringify(l) + '\n'); });
      } };
      return child;
    };
    const mk = extra => makeClaudeCliProvider(Object.assign({ spawn, fs: fakeFs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', persistent: true }, extra || {}));
    const msgs = [{ role: 'system', content: 'P6 system' }, { role: 'user', content: 'go' }];
    const evs = await collect(mk(), { model: 'sonnet', tools, messages: msgs });
    A.eq(evs.filter(e => e.type === 'tool_start').length, 1, 'P6: the call before the guess still runs');
    A.eq([calls[0].interrupts, calls[0].killed], [1, false], 'P6: the STOP interrupts the live turn instead of killing the child');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'P6: the interrupted turn still ends as tool_calls, not as an error');
    const u6 = evs.find(e => e.type === 'usage').usage;
    A.eq(u6.prompt_tokens_details.cached_tokens, 900, 'P6: a zero-usage interrupt result books the stream\'s own input side');
    A.ok(u6.completion_tokens > 1 && u6.cost > 0, 'P6: output floored from what was written; an API-key turn is priced, not booked $0');
    A.eq(sessions.length, 1, 'P6: the interrupted session is pooled for the next step');
    const st = evs.find(e => e.type === 'tool_start'), ta = evs.find(e => e.type === 'tool_args');
    const next = msgs.concat([{ role: 'assistant', content: '', tool_calls: [{ id: st.id, type: 'function', function: { name: 'fs_read', arguments: ta.chunk } }] },
      { role: 'tool', tool_call_id: st.id, content: 'REAL' }]);
    await collect(mk(), { model: 'sonnet', tools, messages: next });
    A.eq(calls.length, 1, 'P6: the next step reuses it');
    A.ok(/^<system_note>\nYour previous reply was cut off/.test(calls[0].writes[1]) && calls[0].writes[1].indexOf('REAL') > 0,
      'P6: and is first told that what it wrote past the block was discarded');
    for (const x of sessions.slice()) _internals.retireSession(x);

    // abort mid-turn kills the child and pools nothing
    const ac = new AbortController();
    const hang = (file, args) => { const c = spawn(file, args); c.stdin.write = () => { setImmediate(() => ac.abort()); }; return c; };
    const p7 = makeClaudeCliProvider({ spawn: hang, fs: fakeFs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', persistent: true });
    await collect(p7, { model: 'sonnet', tools, messages: [{ role: 'system', content: 'P7 system' }, { role: 'user', content: 'go' }], signal: ac.signal });
    A.ok(calls[calls.length - 1].killed, 'P7: abort kills the live child');
    A.eq(sessions.length, 0, 'P7: an aborted session is not pooled');

    // STARNET_CLAUDE_CLI_PERSIST=0: exactly the one-spawn-per-turn path
    const off = make({ lines: [init('none'), result({ result: 'hi' })] }, { persistent: true, env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' } });
    await collect(off.p, { model: 'sonnet', tools, messages: [{ role: 'user', content: 'hi' }] });
    A.ok(off.calls[0].args.indexOf('--input-format') < 0 && off.calls[0].stdin === 'hi', 'P8: the kill switch restores plain stdin, one child per turn');
    A.eq(sessions.length, 0, 'P8: nothing is pooled');

    // a tool-less call (title, reflection, profile note) is one-shot: plain path, no parked child
    const plain = make({ lines: [init('none'), result({ result: 'A title' })] }, { persistent: true });
    await collect(plain.p, { model: 'haiku', messages: [{ role: 'system', content: 'title it' }, { role: 'user', content: 'chat' }] });
    A.ok(plain.calls[0].args.indexOf('--input-format') < 0 && plain.calls[0].stdin === 'chat', 'P10: a tool-less call keeps the one-shot path');
    A.eq(sessions.length, 0, 'P10: and pools nothing');

    // different model on the same conversation: separate sessions, never a cross-model reuse
    const m = [{ role: 'system', content: 'P9 system' }, { role: 'user', content: 'hi' }];
    const okSpawn = (file, args) => { const c = spawn(file, args); c.stdin.write = d => { setImmediate(() => { for (const l of [init('none'), delta('hello'), result({ result: 'hello' })]) c.stdout.emit('data', JSON.stringify(l) + '\n'); }); }; return c; };
    const mk9 = model => collect(makeClaudeCliProvider({ spawn: okSpawn, fs: fakeFs, bin: 'claude.exe', env: { PATH: '' }, platform: 'linux', persistent: true }),
      { model, tools, messages: model === 'sonnet' ? m : m.concat([{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }]) });
    const before = calls.length;
    await mk9('sonnet'); await mk9('opus');
    A.eq(calls.length - before, 2, 'P9: another model never reuses a session');
    for (const s of sessions.slice()) _internals.retireSession(s);
  }
  A.report('provider.claude-cli.test');
})().catch(e => { console.log('FAIL: provider.claude-cli.test threw -- ' + (e && e.stack || e)); process.exit(1); });
