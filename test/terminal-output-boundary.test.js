/* The browser transport must distinguish provisional prose before a tool call from the one terminal answer.
   This executes the real Harness.chat NDJSON reducer; a source-text assertion would miss ordering regressions. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const storage = new Map([
  ['starnet.byok.model', 'fixture/model'],
  ['starnet.byok.prov', 'openrouter'],
  ['starnet.byok.key', 'fixture-key']
]);
const ndjson = [
  { name: 'agent.run.start', payload: { runId: 'run-terminal', agentId: 'agent', model: 'fixture/model' } },
  { name: 'agent.token', payload: { runId: 'run-terminal', delta: 'I will inspect this first.' } },
  { name: 'agent.tool_call', payload: { runId: 'run-terminal', callId: 'c1', name: 'fixture_inspect', argsSummary: '{}' } },
  { name: 'agent.tool_result', payload: { runId: 'run-terminal', callId: 'c1', ok: true, isError: false, summary: 'ok', ms: 1 } },
  { name: 'agent.token', payload: { runId: 'run-terminal', delta: 'The terminal answer appears once.' } },
  { name: 'agent.run.end', payload: { runId: 'run-terminal', agentId: 'agent', reason: 'done', turns: 2, usd: 0 } }
].map(row => JSON.stringify(row)).join('\n') + '\n';

const sandbox = {
  console, TextDecoder, TextEncoder, AbortController, URL, Headers, setTimeout, clearTimeout,
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  },
  location: { href: 'http://127.0.0.1:19191/', origin: 'http://127.0.0.1:19191' },
  U: { bus: A.makeBus() }
};
sandbox.window = sandbox;
sandbox.__STARNET_API_TOKEN__ = 'fixture-token';
sandbox.fetch = async url => {
  if (String(url) !== '/api/run') throw new Error('unexpected fetch ' + url);
  return new Response(ndjson, { headers: { 'Content-Type': 'application/x-ndjson' } });
};
vm.runInNewContext(source + '\n;globalThis.__Harness = Harness;', sandbox, { filename: 'frontend/app/harness.js' });

(async () => {
  let streamed = '', resets = 0, calls = 0;
  const result = await sandbox.__Harness.chat({
    system: 'fixture', messages: [{ role: 'user', content: 'go' }], agentId: 'agent', isTask: true,
    onToken: delta => { streamed += delta; },
    onTerminalReset: () => { streamed = ''; resets++; },
    onToolCall: () => { calls++; }
  });
  A.eq(result.text, 'The terminal answer appears once.', 'Harness.chat returns only the terminal assistant segment');
  A.eq(streamed, result.text, 'caller accumulator can reset at the authoritative tool boundary');
  A.eq(resets, 1, 'one tool turn produces one terminal-output reset');
  A.eq(calls, 1, 'tool callback still fires normally');
  A.report('terminal-output-boundary.test');
})().catch(error => { console.error(error); process.exit(1); });
