/* Real loop + real CLI adapter; only EventEmitter children and in-memory files.
   Synthetic account rotation proves composition, not installed CLI/account behavior. */
'use strict';
const A = require('./_assert.js');
const { EventEmitter } = require('node:events');
const { makeClaudeCliProvider } = require('../sidecar/providers/claude-cli.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeEmitter } = require('../shared/emitter.js');
const events = require('../shared/events.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const tool = { type: 'function', function: { name: 'fixture_read', description: 'Read synthetic data', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const block = path => '<function_calls><invoke name="fixture_read"><parameter name="path">' + path + '</parameter></invoke></function_calls>';
const usage = n => ({ input_tokens: n * 100, cache_read_input_tokens: n * 10, output_tokens: n + 2 });
const init = source => ({ type: 'system', subtype: 'init', apiKeySource: source });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (text, n, cost, error) => ({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: !!error, result: text, usage: usage(n), total_cost_usd: cost, stop_reason: 'end_turn' });
const textIn = input => ((input && input.message && input.message.content) || []).filter(x => x.type === 'text').map(x => x.text).join('');
function fixture() {
  const trace = [], adapters = [], reads = [], releases = [];
  const bus = A.makeBus(), seq = A.collectBus(bus, events.names());
  const baseEmit = makeEmitter(bus, e => { throw e; });
  const emit = (name, payload) => { trace.push(name); baseEmit(name, payload); };
  const registry = makeRegistry();
  registry.register({ impact: 'none', name: 'fixture_read', schema: tool.function.parameters, run: async args => { reads.push(args.path); return 'fixture contents ' + args.path; } });
  let nextPid = 8100;
  function adapter(label, script, options = {}) {
    const children = [], kills = [], files = new Map(), removed = [];
    const spawn = (file, args, opts) => {
      const child = new EventEmitter();
      if (file === 'taskkill') {
        const target = children.find(c => String(c.child.pid) === args[1]);
        if (!target) throw new Error('mock taskkill may only target its own synthetic child');
        const attempt = { target, args, child }; kills.push(attempt);
        trace.push('kill:' + label);
        setImmediate(() => {
          const code = options.failFirstKill && kills.length === 1 ? 1 : 0;
          if (!code && !options.holdClose) target.close(null);
          child.emit('close', code);
        });
        return child;
      }
      if (file !== 'mock-cli') throw new Error('unapproved mock command');
      const record = { child, args, opts, inputs: [], closed: false };
      child.pid = nextPid++; child.exitCode = null; child.signalCode = null;
      const pipe = () => Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stdout = pipe(); child.stderr = pipe();
      record.close = code => {
        if (record.closed) return;
        record.closed = true; child.exitCode = code; child.signalCode = code === null ? 'SIGTERM' : null;
        child.emit('exit', code); child.emit('close', code);
      };
      record.send = row => { if (!record.closed) child.stdout.emit('data', JSON.stringify(row) + '\n'); };
      child.kill = () => { if (!options.holdClose) record.close(null); return true; };
      child.stdin = Object.assign(new EventEmitter(), {
        write(line) {
          const input = JSON.parse(line); record.inputs.push(input);
          setImmediate(() => { if (!record.closed) for (const row of script(record, record.inputs.length) || []) record.send(row); });
          return true;
        },
        end(text) { if (text) throw new Error('fixture must exercise persistence, never one-shot stdin'); }
      });
      children.push(record); return child;
    };
    const fs = { statSync: () => ({ isFile: () => true }), writeFileSync: (p, data) => files.set(p, data), unlinkSync: p => { removed.push(p); files.delete(p); } };
    const provider = makeClaudeCliProvider({ spawn, fs, bin: 'mock-cli', platform: 'win32', env: { PATH: '' }, configDir: '/synthetic/' + label, persistEndGraceMs: 50 });
    const release = provider.release;
    provider.release = runId => { releases.push([label, runId]); trace.push('release:' + label); return release(runId); };
    const row = { provider, children, kills, files, removed, label }; adapters.push(row); return row;
  }
  async function run(primary, fallbacks = [], extra = {}) {
    const ac = new AbortController();
    return runAgentLoop({ messages: [{ role: 'system', content: 'Use the granted fixture tool.' }, { role: 'user', content: 'Read a and b, then report their contents.' }],
      isTask: true, tools: [tool], provider: primary.provider, fallbacks, credKey: 'account-A', model: 'sonnet', runId: 'loop-fixture', agentId: 'fixture-agent',
      emit, cost: makeCostEngine({ priceOf: () => null }), limits: { maxIters: 6, grace: false }, signal: ac.signal,
      dispatch: (call, ctx) => registry.dispatch(call, ctx), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'fixture-agent', room: 'fixture', signal: ac.signal },
      clock: { now: () => 0 }, sleep: async () => {}, random: () => 0.5, ...extra });
  }
  const costs = () => seq.filter(e => e.name === 'agent.cost').map(e => e.payload);
  function protocolChecks() {
    for (const account of adapters) for (const child of account.children) {
      A.ok(child.args.includes('--input-format') && child.args[child.args.indexOf('--input-format') + 1] === 'stream-json', 'nonempty task/tools selected persistent stream-json');
      A.eq(child.opts.env.CLAUDE_CONFIG_DIR, '/synthetic/' + account.label, 'child account config directory is isolated');
      A.eq(child.args.slice(child.args.indexOf('--tools'), child.args.indexOf('--tools') + 2), ['--tools', ''], 'CLI built-in tools remain disabled');
      A.ok(child.args.includes('--strict-mcp-config') && child.args[child.args.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}', 'CLI MCP permissions remain closed');
    }
  }
  function endChecks(reason) {
    const ends = seq.filter(e => e.name === 'agent.run.end');
    A.eq(ends.map(e => [e.payload.runId, e.payload.reason]), [['loop-fixture', reason]], 'one correctly attributed terminal event');
    const at = trace.indexOf('agent.run.end');
    A.ok(adapters.every(a => trace.indexOf('release:' + a.label) >= 0 && trace.indexOf('release:' + a.label) < at), 'all adapters receive synchronous cleanup kickoff before run.end');
    A.eq(releases, adapters.map(a => [a.label, 'loop-fixture']), 'each adapter released exactly once by the loop');
  }
  return { adapter, run, reads, seq, costs, trace, protocolChecks, endChecks, dispose() { for (const a of adapters) for (const c of a.children) c.close(0); } };
}
(async () => {
  {
    const f = fixture();
    const a = f.adapter('A', (c, n) => { const text = n < 3 ? block(n === 1 ? 'a' : 'b') : 'The fixture contains a and b.'; return [...(n === 1 ? [init('none')] : []), delta(text), result(text, n, n * 0.25)]; });
    try {
      const out = await f.run(a);
      A.eq([out.reason, f.reads], ['done', ['a', 'b']], 'actual loop dispatches two granted reads and finishes');
      A.eq([a.children.length, a.children[0].inputs.length, a.provider.persistStats().reused], [1, 3, 2], 'three real-loop turns reuse one child');
      A.ok(textIn(a.children[0].inputs[1]).startsWith('<tool_result') && textIn(a.children[0].inputs[1]).includes('fixture contents a') && !textIn(a.children[0].inputs[1]).includes('Read a and b'), 'second loop turn is paired tool-result delta only');
      A.eq(f.costs().map(c => [c.tokensIn, c.tokensOut, c.cachedTokens, c.usd]), [[110, 3, 10, 0], [220, 4, 20, 0], [330, 5, 30, 0]], 'init-once subscription books complete per-turn usage, never cumulative dollars');
      A.eq(out.usd, 0, 'subscription run total remains zero');
      f.protocolChecks(); f.endChecks('done');
      await tick();
      A.eq([a.provider.persistStats().live, a.files.size], [false, 0], 'observed mocked close retires ownership and prompt');
    } finally { f.dispose(); }
  }
  for (const mode of ['subscription', 'metered', 'retained']) {
    const f = fixture(), hooks = [];
    const a = f.adapter('A', (c, n) => n === 1
      ? [init(mode === 'metered' ? 'ANTHROPIC_API_KEY' : 'none'), delta(block('a')), result(block('a'), 1, 0.25)]
      : [delta(block('poison')), { type: 'assistant', error: 'rate_limit' }, result('limited', 2, 0.4, true)],
      { failFirstKill: mode === 'retained', holdClose: mode === 'retained' });
    const b = f.adapter('B', (c, n) => {
      if (n === 1 && mode === 'retained') {
        A.eq([a.provider.persistStats().live, a.provider.persistStats().cleanupPending, a.provider.persistStats().cleanupFailures], [true, 1, 1], 'failed A cleanup remains owned and visible while B starts');
        A.eq([a.files.size, a.removed.length], [1, 0], 'A prompt retained until observed close');
      }
      const text = n === 1 ? block('b') : 'The fixture contains a and b.';
      return [...(n === 1 ? [init('none')] : []), delta(text), result(text, n + 2, n === 1 ? 0.5 : 0.75)];
    });
    const unused = f.adapter('unused', () => { throw new Error('unused fallback must not run'); });
    try {
      const out = await f.run(a, [{ provider: b.provider, model: 'sonnet', credKey: 'account-B', account: 'synthetic B' }, { provider: unused.provider, credKey: 'unused' }], {
        onFallback: x => hooks.push({ reason: x.reason, rotate: x.rotate, from: x.credKey, to: x.next.credKey })
      });
      A.eq([out.reason, f.reads], ['done', ['a', 'b']], mode + ': failed parsed call is never dispatched');
      A.eq(hooks, [{ reason: 'quota_exhausted', rotate: true, from: 'account-A', to: 'account-B' }], mode + ': callback owns outgoing credential and exact next account');
      A.eq(f.seq.filter(e => e.name === 'provider.fallback').map(e => [e.payload.reason, e.payload.rotate, e.payload.toAccount]), [['quota_exhausted', true, 'synthetic B']], 'one truthful account fallback');
      A.eq([a.children.length, b.children.length, unused.children.length], [1, 1, 0], 'rotation uses two separate child identities only');
      const bi = b.children[0] ? b.children[0].inputs : [];
      A.ok(textIn(bi[0]).includes('Read a and b') && textIn(bi[0]).includes('fixture contents a') && !textIn(bi[0]).includes('poison'), 'new account receives full valid history without rejected call');
      A.ok(textIn(bi[1]).startsWith('<tool_result') && textIn(bi[1]).includes('fixture contents b') && !textIn(bi[1]).includes('Read a and b'), 'B continuation reuses its own paired delta history');
      A.ok(!out.messages.some(m => (m.tool_calls || []).some(c => String(c.function.arguments).includes('poison'))), 'rejected call excluded from durable loop transcript');
      const expected = [1, 2, 3, 4].map((n, i) => [110 * n, n + 2, 10 * n, mode === 'metered' && i < 2 ? [0.25, 0.15][i] : 0]);
      A.eq(f.costs().map(c => [c.tokensIn, c.tokensOut, c.cachedTokens, Math.round(c.usd * 1e6) / 1e6]), expected, mode + ': every completed/failed attempt booked once with account-scoped cost');
      A.eq(Math.round(out.usd * 1e6) / 1e6, mode === 'metered' ? 0.4 : 0, 'run total matches settled attempt shares');
      A.eq(f.seq.filter(e => e.name === 'agent.run.error').length, 0, 'successful recovery emits no terminal error');
      // the usage-limit turn's streamed call never becomes a tool row: two rows (a, b), both real results, no failed mark
      A.eq(f.seq.filter(e => e.name === 'agent.tool_call').length, 2, mode + ': only the two dispatched calls become tool rows');
      A.eq(f.seq.filter(e => e.name === 'agent.tool_result').map(e => !!e.payload.isError), [false, false], mode + ': no tool row reads failed because of the usage limit');
      f.protocolChecks(); f.endChecks('done');
      if (mode === 'retained') {
        A.eq(a.kills.length, 2, 'run end retries A failed cleanup exactly once');
        a.provider.release('loop-fixture');
        A.eq(a.kills.length, 2, 'pending attempt prevents duplicate cleanup request');
        await tick();
        A.eq([a.provider.persistStats().live, a.files.size, b.provider.persistStats().live, b.files.size], [true, 1, false, 0], 'kill acknowledgement alone cannot release retained A ownership');
        a.children[0].close(null);
      } else await tick();
      A.eq([a.provider.persistStats().live, b.provider.persistStats().live, a.files.size, b.files.size], [false, false, 0, 0], 'only observed closes complete both account cleanups');
    } finally { f.dispose(); }
  }
  for (const tag of ['authentication_failed', 'rate_limit']) for (const terminal of ['result', 'eof']) {
    const f = fixture();
    const a = f.adapter('A', c => {
      if (terminal === 'eof') setImmediate(() => c.close(0));
      return [init('none'), { type: 'stream_event', event: { type: 'message_start', message: { usage: usage(2) } } }, delta(block('poison')), { type: 'assistant', error: tag },
        ...(terminal === 'result' ? [result('rejected', 2, 0.4, true)] : [])];
    });
    try {
      const out = await f.run(a);
      A.eq([out.reason, out.failureStage, out.failureCode], ['error', 'provider_stream', tag === 'rate_limit' ? 'quota_exhausted' : 'auth'], tag + '/' + terminal + ': observed error terminates classified through the real loop');
      A.eq(f.reads, [], 'rejected parsed call never reaches registry');
      A.eq(f.seq.filter(e => e.name === 'provider.fallback').length, 0, 'no invented fallback without another account');
      A.eq(f.seq.filter(e => e.name === 'agent.run.error').length, 1, 'one terminal error event');
      // (stall report 2026-10-13: "x" marks after a usage limit) the limited turn's streamed call is never shown as a tool
      // row, so no row can read failed; the limit itself is said once, in plain words
      A.eq(f.seq.filter(e => e.name === 'agent.tool_call' || e.name === 'agent.tool_result').length, 0, tag + '/' + terminal + ': the rejected call never becomes a tool row (no call, no failed result)');
      const said = f.seq.filter(e => e.name === 'agent.run.error').map(e => String(e.payload.message || ''));
      if (tag === 'rate_limit') A.ok(said.length === 1 && /usage limit reached/i.test(said[0]), tag + '/' + terminal + ': the limit is named once: ' + JSON.stringify(said));
      A.eq(f.costs().map(c => [c.tokensIn, c.cachedTokens, c.usd]), [[220, 20, 0]], 'available attempt input/cache and subscription zero settled exactly once');
      A.ok(f.costs()[0] && f.costs()[0].tokensOut >= 4, 'available output count preserved without inventing a billed result');
      A.eq(a.children.length, 1, 'observed error never prewarms another child');
      f.protocolChecks(); f.endChecks('error');
    } finally { f.dispose(); }
  }
  // THE SUBSCRIPTION SEATBELT on the persistent path (cache-cap lane, 2026-10-12): every reused turn books its OWN usage,
  // marked subscription, so loop.js noteSubscription counts each turn once (fresh input + output, cache re-reads 1/10).
  // usage(n): 110n in (10n cached), n+2 out -> 102n+2 a turn: 104, then 310 after turn 2 >= a 300 ceiling.
  {
    const f = fixture();
    const a = f.adapter('A', (c, n) => { const text = n < 3 ? block(n === 1 ? 'a' : 'b') : 'The fixture contains a and b.'; return [...(n === 1 ? [init('none')] : []), delta(text), result(text, n, 0)]; });
    try {
      const out = await f.run(a, [], { limits: { maxIters: 6, grace: false, maxSubscriptionTokens: 300 } });
      A.eq([out.reason, f.reads], ['budget', ['a', 'b']], 'the ceiling stops the run after turn 2 (not turn 1: no double count; not never: no lost turn)');
      A.eq([out.subscriptionTokens, out.subscriptionCapTokens, out.subscriptionModel], [310, 300, 'sonnet'], 'it names exactly the two persistent turns\' subscription tokens');
      A.eq([a.children.length, a.children[0].inputs.length, a.provider.persistStats().reused], [1, 2, 1], 'both turns rode ONE child (turn 2 was a delta)');
      A.eq(f.costs().map(c => [c.tokensIn, c.cachedTokens, c.usd]), [[110, 10, 0], [220, 20, 0]], 'one $0 booking per turn, per-turn tokens');
      f.endChecks('budget');
    } finally { f.dispose(); }
  }
  A.report('claude-cli-persist-loop.test');
})().catch(error => { console.error(error); process.exitCode = 1; });
