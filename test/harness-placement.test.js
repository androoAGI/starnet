'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const harness = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const start = harness.indexOf('async function chat(');
const source = harness.slice(start, harness.indexOf('\n  }\n', start) + 4);
(async () => {
  let captured;
  // chat() runs alone here, so every Harness-scope name it reads is supplied: DESKTOP is true, so it reads the endpoint
  // hand-over slot too (null = no hand-over in flight, so the run must not wait on one). chat() turns ANY throw before the
  // POST into "cannot reach", so a missing name would look like the expected refusal: the capture is checked every round.
  const chat = vm.runInNewContext('(' + source + ')', {
    getModel: () => 'qwen3:14b', getProv: () => 'ollama', getKey: () => '', getReasoningEffort: () => '',
    providerNeedsKey: () => false, getBaseUrl: () => '', DESKTOP: true, DEVMODE: false,
    endpointHandOver: null,
    endpointHandOverSettled: async () => { throw new Error('a run with no hand-over in flight waited for one'); },
    fetch: async (url, opts) => { captured = JSON.parse(opts.body); throw new Error('stop after capture'); }
  });
  for (const input of [{ placed: [] }, { placed: ['cabinet'] }, {}, { workbench: true }]) {
    captured = undefined;
    await assert.rejects(chat({ agentId: 'agent', isTask: true, messages: [], ...input }), /cannot reach/);
    assert.ok(captured && typeof captured === 'object', 'the run reached its /api/run POST (' + JSON.stringify(input) + ')');
    assert.equal(Object.hasOwn(captured, 'placed'), Object.hasOwn(input, 'placed'));
    if (input.placed) assert.deepEqual(captured.placed, input.placed);
    if (input.workbench) assert.equal(captured.workbench, true);
  }
  console.log('harness-placement: OK (explicit empty, populated, omitted and legacy workbench requests)');
})().catch(e => { console.error(e); process.exitCode = 1; });
