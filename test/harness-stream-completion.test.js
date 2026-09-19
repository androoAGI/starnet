'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const event = (name, payload) => JSON.stringify({ name, payload });
const start = event('agent.run.start', { runId: 'lead', agentId: 'agent', model: 'test' });
const token = event('agent.token', { runId: 'lead', agentId: 'agent', delta: 'A partial reply 🌍' });
const end = (payload = {}) => event('agent.run.end', { runId: 'lead', reason: 'done', ...payload });

async function exercise(source, wire, options = {}) {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0, reads = 0, released = false;
  const emitted = [], tokens = [], resets = [];
  const reader = {
    async read() {
      if (offset >= bytes.length) {
        if (options.readError) throw options.readError;
        return { done: true };
      }
      reads++;
      const size = options.bytewise ? 1 : bytes.length;
      const value = bytes.slice(offset, offset + size); offset += size;
      return { done: false, value };
    },
    releaseLock() { released = true; }
  };
  const scope = {
    TextDecoder, console, DESKTOP: false, DEVMODE: true,
    getModel: () => 'test', getProv: () => 'openrouter', getKey: () => '',
    getReasoningEffort: () => '', getBaseUrl: () => '', providerNeedsKey: () => false,
    fetch: async () => ({ ok: true, body: { getReader: () => reader } }),
    U: { bus: { emit: (name, payload) => emitted.push({ name, payload }) } },
    totals: { calls: 0, tokens: 0, cost: 0 }, runModels: {}, internalRuns: new Set(),
    registerRun() {}, foldContextCost() {}
  };
  const first = source.indexOf('  async function chat(');
  const last = source.indexOf('  /* Read-only fetch of an agent', first);
  A.ok(first >= 0 && last > first, 'execute the complete production chat function');
  const chat = vm.runInNewContext(source.slice(first, last) + '\nchat', scope);
  let result, error;
  try {
    result = await chat({ messages: [], agentId: 'agent', internal: !!options.internal,
      onToken: d => tokens.push(d), onTerminalReset: () => resets.push(true) });
  } catch (e) { error = e; }
  return { result, error, emitted, tokens, resets, released, scope, reads };
}

(async () => {
  for (const file of ['frontend/app/harness.js', 'website/app/app/harness.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const bytewise of [false, true]) {
      const normal = await exercise(source, [start, token, end()].join('\n') + '\n', { bytewise });
      A.eq(normal.result.text, 'A partial reply 🌍', 'UTF-8 and arbitrary chunk boundaries retain all text');
      A.eq(normal.result.endReason, 'done', 'matching lead completion succeeds');
      A.ok(normal.released, 'reader is released after success');
      const tail = await exercise(source, [start, token, end({ finishReason: 'length' })].join('\n'), { bytewise });
      A.eq(tail.result.finishReason, 'length', 'undelimited final record retains output-limit status');
    }
    for (const ending of ['', end({ runId: 'worker' }), end({ runId: '' }), end({ reason: '' }), '{"name":"agent.run.end"', 'null']) {
      const cut = await exercise(source, [start, token, ending].join('\n'));
      A.ok(cut.error && /disconnected before completion/.test(cut.error.message), 'missing/malformed/foreign completion rejects');
      A.eq(cut.tokens.join(''), 'A partial reply 🌍', 'partial text already reached the caller');
      A.ok(cut.released, 'reader released after incomplete stream');
      A.eq(cut.scope.runModels.lead, undefined, 'interrupted lead metadata cleaned');
    }
    const empty = await exercise(source, '');
    A.ok(empty.error, 'empty successful HTTP body is not a completed run');
    const workerThenLead = await exercise(source, [start, token, end({ runId: 'worker' }), end()].join('\n'));
    A.eq(workerThenLead.result.endReason, 'done', 'worker completion cannot prevent a later valid lead end');
    const trailingDrop = await exercise(source, [start, token, end()].join('\n') + '\n', { readError: new Error('socket closed') });
    A.eq(trailingDrop.result.endReason, 'done', 'transport loss after a confirmed end does not undo completion');
    for (const reason of ['cancelled', 'error', 'budget', 'max_iters', 'refusal', 'empty', 'clarifying']) {
      const r = await exercise(source, [start, token, end({ reason })].join('\n'));
      A.eq(r.result.endReason, reason, 'explicit non-success end is retained: ' + reason);
    }
    const policy = await exercise(source, [start, token, end({ finishReason: 'content_filter' })].join('\n'));
    A.eq(policy.result.finishReason, 'content_filter', 'policy stop remains distinct');
    const inband = await exercise(source, event('agent.run.error', { message: 'missing credentials' }));
    A.eq(inband.result.error, 'missing credentials', 'setup error before start survives EOF');
    const foreignError = await exercise(source, [start, token, event('agent.run.error', { runId: 'worker', message: 'worker failed' })].join('\n'));
    A.ok(foreignError.error, 'worker error cannot excuse missing lead completion');
    for (const error of [new Error('socket closed'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
      const failure = await exercise(source, start + '\n' + token + '\n', { readError: error });
      A.eq(failure.error, error, 'reader errors and cancellation preserve original identity');
      A.ok(failure.released, 'reader released after thrown transport error');
    }
    const internal = await exercise(source, [start, token, end()].join('\n'), { internal: true });
    A.eq(internal.emitted.filter(e => /agent.run.(start|end)/.test(e.name)).length, 0, 'internal completion never emits task lifecycle');
    const internalCut = await exercise(source, start + '\n' + token, { internal: true });
    A.ok(internalCut.error, 'internal callers cannot consume incomplete output as a finished answer');
    A.eq(internalCut.scope.internalRuns.size, 0, 'interrupted internal metadata cleaned');
    const tool = await exercise(source, [start, token, event('agent.tool_call', { runId: 'lead', callId: 'c' }), token].join('\n'));
    A.ok(tool.error && tool.resets.length === 1, 'tool boundary preserved and interruption does not infer completion or replay');
  }
  // Execute the real COMMS failure branch: losing the response must retain the partial,
  // mark the run unsuccessful, and arm journal recovery even while another session is visible.
  for (const file of ['frontend/app/chat.js', 'website/app/app/chat.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
    const marker = '    } catch (e) {\n      const aborted';
    const first = source.indexOf(marker), last = source.indexOf('    } finally {\n      aborters.delete', first);
    A.ok(first > 0 && last > first, 'locate full COMMS transport-failure branch');
    const body = source.slice(first + '    } catch (e) {'.length, last);
    for (const active of [true, false]) {
      const ws = { id: 'original', agentId: 'agent', history: [] };
      const calls = [], interruptedStreams = new Set();
      const sandbox = { ws, acc: 'Retained partial', thisRunId: 'lead', interrupted: new Set(), interruptedStreams,
        persistPartial: (w, text) => { calls.push('partial'); w.history.push({ role: 'assistant', content: text }); },
        Harness: { pingEngine: async () => { calls.push('health'); return true; } },
        Friendly: { friendlyError: () => ({ kind: 'network', userMessage: 'Stream interrupted' }) },
        Workstreams: { noteRunEnd: (...args) => calls.push(args) },
        armReconnectWatch: () => calls.push('journal'), isActiveWs: () => active,
        activeLiveRow: { error: () => calls.push('render-error') }, resolvePresence: () => calls.push('presence'),
        offerRetry: () => calls.push('retry-control'), StationUI: { clearRunning: () => calls.push('clear') }
      };
      await vm.runInNewContext('(async function(e) {' + body + '\n})', sandbox)(new Error('stream disconnected'));
      A.eq(calls.slice(0, 2), ['partial', 'health'], 'partial output persists before asynchronous health check');
      A.ok(ws.history[1].error, 'durable interruption follows the partial answer');
      A.ok(interruptedStreams.has('original'), 'journal recovery targets the original session');
      A.ok(calls.some(x => Array.isArray(x) && x[0] === 'original' && x[1] === 'lead' && x[2] === false), 'task status cannot become delivered');
      A.eq(calls.includes('render-error'), active, 'background failure does not overwrite the active conversation');
      A.eq(calls.filter(x => x === 'journal').length, 1, 'one recovery watch, no automatic inference replay');
    }
  }
  A.report('harness-stream-completion');
})().catch(e => { console.error(e); process.exit(1); });
