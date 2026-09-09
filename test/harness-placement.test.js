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
  const chat = vm.runInNewContext('(' + source + ')', {
    getModel: () => 'qwen3:14b', getProv: () => 'ollama', getKey: () => '', getReasoningEffort: () => '',
    providerNeedsKey: () => false, getBaseUrl: () => '', DESKTOP: true, DEVMODE: false,
    fetch: async (url, opts) => { captured = JSON.parse(opts.body); throw new Error('stop after capture'); }
  });
  for (const input of [{ placed: [] }, { placed: ['cabinet'] }, {}, { workbench: true }]) {
    await assert.rejects(chat({ agentId: 'agent', isTask: true, messages: [], ...input }), /cannot reach/);
    assert.equal(Object.hasOwn(captured, 'placed'), Object.hasOwn(input, 'placed'));
    if (input.placed) assert.deepEqual(captured.placed, input.placed);
    if (input.workbench) assert.equal(captured.workbench, true);
  }
  console.log('harness-placement: OK (explicit empty, populated, omitted and legacy workbench requests)');
})().catch(e => { console.error(e); process.exitCode = 1; });
