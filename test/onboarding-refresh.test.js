'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app/onboarding.js'), 'utf8');
async function quickRun(answers, stopAt, wake = false) {
  const timers = new Map(), prompts = [], stages = [], writes = [], postures = [], beliefs = [];
  let timerId = 0, done = 0, taught = 0, context;
  const storage = new Map();
  context = vm.createContext({
    console, Promise, Math,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { setItem(k,v) { storage.set(k,v); }, getItem(k) { return storage.get(k) || null; }, removeItem(k) { storage.delete(k); } },
    World: {},
    Chat: { typeLine(lines, cb) { cb(); }, beginInterview() {}, endInterview() {} },
    Harness: { configured() { return false; } },
    Dialogue: {
      open() {}, close() {}, isOpen() { return false; },
      setStage(title, detail) { stages.push([title, detail]); },
      say() { return Promise.resolve(); },
      node(cfg) {
        prompts.push(cfg);
        if (prompts.length === stopAt) vm.runInContext('Onboarding.stop()', context);
        return Promise.resolve(answers.shift() || { value: '', skip: true });
      }
    },
    DossierStore: { upsert(...args) { beliefs.push(args); } },
    AutonomyStore: { applyPreset(value) { postures.push(value); } },
    opts: { name:'NOVA', wake, docs:{}, commit(patch) { writes.push(patch); }, done() { done++; }, taught() { taught++; } }
  });
  vm.runInContext(source, context);
  vm.runInContext('Onboarding.start(opts)', context);
  for (let turn=0; turn<45; turn++) {
    const pending = [...timers]; timers.clear();
    for (const [, fn] of pending) fn();
    await Promise.resolve(); await Promise.resolve();
    if (taught || stopAt && prompts.length >= stopAt) break;
  }
  vm.runInContext('Onboarding.stop()', context);
  return { prompts, stages, writes, postures, beliefs, done, taught, storage };
}
(async () => {
  const result = await quickRun([{value:'quick'}, {value:'Help me prepare weekly client updates.'}, {value:'wait'}]);
  assert.equal(result.prompts.length, 3, 'one pace choice followed by exactly two setup questions');
  assert.equal(result.writes[0].purpose, 'Help me prepare weekly client updates.');
  assert.deepEqual(result.postures, ['wait']);
  assert.deepEqual(result.beliefs, [], 'quick setup must not invent a personal profile');
  assert.equal(result.done, 1); assert.equal(result.taught, 1);
  assert(result.stages.some(([,detail]) => detail.startsWith('1 of 2')));
  assert(result.stages.some(([,detail]) => detail.startsWith('2 of 2')));
  assert(result.storage.has('starnet.interview.deferred.v1'), 'deeper profile stays available later');
  const fresh = await quickRun([{value:'quick'}, {value:'Help me build software.'}, {value:'wait'}], null, true);
  assert.equal(fresh.done, 1, 'fresh awakening reaches setup completion');
  assert.equal(fresh.taught, 1, 'fresh awakening hands off once');
  const offline = await quickRun([{value:'deep'}, {value:'Help me write.'}, {value:'wait'}]);
  assert.equal(offline.prompts.length, 3, 'offline interview falls back to purpose and posture without pretending to learn');
  assert.equal(offline.taught, 1);
  const skipped = await quickRun([{value:'quick'}, {value:'Research hard questions.'}, {value:'',skip:true}]);
  assert.deepEqual(skipped.postures, [], 'decide later preserves the existing autonomy settings');
  assert.equal(skipped.taught, 1);
  const stopped = await quickRun([{value:'quick'}, {value:'Should never be written'}], 2);
  assert.equal(stopped.writes.length, 0, 'abandoning a question does not commit its late answer');
  assert.equal(stopped.taught, 0, 'abandoned setup cannot open the tutorial');
  console.log('onboarding-refresh: OK (quick setup, exact answers, posture, deferred profile and cancellation)');
})().catch(error => { console.error(error); process.exitCode = 1; });
