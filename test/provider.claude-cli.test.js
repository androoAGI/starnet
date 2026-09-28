/* node test/provider.claude-cli.test.js - the local Claude CLI provider seam (no real `claude` is spawned). */
'use strict';
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
    A.ok(built.input.indexOf('<tool_call>{"id":"c1","name":"fs.read","arguments":{"path":"a.txt"}}</tool_call>') >= 0, 'prior call rendered');
    A.ok(built.input.indexOf('<tool_result id="c1">\nmilk\n</tool_result>') >= 0, 'prior result rendered');
    const sp = _internals.makeCallSplitter();
    A.eq(sp.push('a <tool_call>not json').text + sp.end().text, 'a <tool_call>not json', 'an unclosed, unparseable block stays prose');
  }

  // F. failures are errors, never a silent empty delivery.
  {
    const { p } = make({ lines: [init('none'), result({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached' })] });
    let err = null; try { await collect(p, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && /usage limit/.test(err.message), 'CLI error result throws with its message');
    const q = make({ lines: [], code: 1, stderr: 'boom' }).p;
    err = null; try { await collect(q, { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err && /exited with code 1/.test(err.message) && /boom/.test(err.message), 'exit without a result throws with stderr');
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
    A.eq((await ok.listModels()).map(m => m.id), ['sonnet', 'opus', 'haiku'], 'signed-in CLI lists its model aliases');
    const out = make(call => ({ lines: [{ loggedIn: false }], code: 1 })).p;
    let err = null; try { await out.listModels(); } catch (e) { err = e; }
    A.ok(err && /not signed in/.test(err.message) && err.code === 'provider_not_configured', 'signed-out CLI lists nothing and says why');
    const none = makeClaudeCliProvider({ spawn: fakeSpawn({}).spawn, fs: { statSync() { throw new Error('ENOENT'); } }, env: { PATH: path.join('nowhere') }, platform: 'linux' });
    err = null; try { await none.listModels(); } catch (e) { err = e; }
    A.ok(err && /not found/.test(err.message), 'missing CLI lists nothing and says how to install it');
  }

  A.report('provider.claude-cli.test');
})().catch(e => { console.log('FAIL: provider.claude-cli.test threw -- ' + (e && e.stack || e)); process.exit(1); });
