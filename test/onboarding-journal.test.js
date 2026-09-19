'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app/onboarding.js'), 'utf8');

function fixture() {
  let resolveModel, resolveQuestion, requests = 0;
  const timers = [];
  const context = vm.createContext({
    console, Promise, Math,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    Harness: { chat() { requests++; return new Promise(resolve => { resolveModel = resolve; }); } },
    Dialogue: { say: async () => {}, node: () => new Promise(resolve => { resolveQuestion = resolve; }) }
  });
  // Exercise the actual async journal functions without the unrelated cinematic timers.
  vm.runInContext(source.replace('return { start, stop, isRunning,', `return {
    init() { epoch++; running = true; journal = { nodes: [], minds: [] }; },
    llmCall, mindWait, askNode, snapshot() { return JSON.parse(JSON.stringify(journal)); },
    start, stop, isRunning,`), context);
  const api = vm.runInContext('Onboarding', context); api.init();
  return {api, timers, model: value => resolveModel(value), question: value => resolveQuestion(value), requests: () => requests};
}

test('an adopted timeout survives a late reply and is reused after reopening', async () => {
  const f = fixture();
  const outcome = f.api.mindWait(f.api.llmCall('follow up'), JSON.parse, [], 1);
  f.timers[0](); // actual hard-cap timeout
  assert.equal(await outcome, null);
  f.model({text:'{"ask":"A late different question"}'});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.api.snapshot().minds[0].result, null);
  assert.equal(await f.api.mindWait(f.api.llmCall('follow up'), JSON.parse, [], 1), null);
  assert.equal(f.requests(), 1, 'replay neither regenerates nor adopts a late question');
});

test('completed model output is reused verbatim without another request', async () => {
  const f = fixture();
  const outcome = f.api.mindWait(f.api.llmCall('follow up'), JSON.parse, [], 100);
  f.model({text:'{"ask":"Original question"}'});
  assert.equal((await outcome).ask, 'Original question');
  assert.equal((await f.api.mindWait(f.api.llmCall('follow up'), JSON.parse, [], 100)).ask, 'Original question');
  assert.equal(f.requests(), 1);
});

test('a stopped interview cannot commit a late answer into a new interview', async () => {
  const f = fixture();
  const answer = f.api.askNode({lines:['original'], options:[]});
  const refusal = assert.rejects(answer, error => typeof error === 'symbol');
  f.api.init();
  f.question({value:'stale answer'});
  await refusal;
  assert.equal(f.api.snapshot().nodes.length, 0);
});
