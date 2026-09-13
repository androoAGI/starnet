'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app/onboarding.js'), 'utf8');
async function quickRun(answers, stopAt, wake = false, mind = null) {
  const timers = new Map(), prompts = [], stages = [], writes = [], postures = [], beliefs = [];
  let timerId = 0, done = 0, taught = 0, context;
  const storage = new Map(), calls = [];
  context = vm.createContext({
    console, Promise, Math,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { setItem(k,v) { storage.set(k,v); }, getItem(k) { return storage.get(k) || null; }, removeItem(k) { storage.delete(k); } },
    World: {},
    Chat: { typeLine(lines, cb) { cb(); }, beginInterview() {}, endInterview() {} },
    WakeMind: require('../frontend/app/wakemind.js'),
    Harness: { configured() { return !!mind; }, chat(request) { calls.push(request.messages[0].content); return Promise.resolve(mind(request.messages[0].content)); } },
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
  for (let turn=0; turn<180; turn++) {
    const pending = [...timers]; timers.clear();
    for (const [, fn] of pending) fn();
    await Promise.resolve(); await Promise.resolve();
    if (taught || stopAt && prompts.length >= stopAt) break;
  }
  vm.runInContext('Onboarding.stop()', context);
  return { prompts, stages, writes, postures, beliefs, done, taught, storage, calls };
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
  const mind = directive => ({ text: directive.includes('THE READ')
    ? 'READ: you want help choosing the next feature.\nPURPOSE: Help choose and build useful features.\nSTACK: NONE'
    : directive.includes('THE TUESDAY')
      ? 'ACK: let’s find a useful place to start.\nASK: which project would you like to make progress on?'
      : '' });
  const live = await quickRun([
    {value:'loose'}, {value:'I want help deciding what to build.'},
    {value:'My station onboarding.'}, {value:'yes'}, {value:'wait'}
  ], null, false, mind);
  assert.equal(live.prompts[1].lines[0].text, 'what made you want to set up an agent?');
  assert.equal(live.prompts[1].customFirst, true, 'typing is available immediately');
  assert.equal(live.prompts[2].lines[0].text, 'which project would you like to make progress on?');
  assert.equal(live.prompts.filter(p => p.lines[0].text === 'which project would you like to make progress on?').length, 1, 'short path enforces budget even if model keeps asking');
  assert(live.writes.some(w => w.context && w.context.includes('My station onboarding.')), 'exact follow-up survives in context');
  assert(live.calls.some(c => c.includes('My station onboarding.')), 'next model turn sees prior answers');
  assert(!live.beliefs.some(([dim]) => dim === 'pain'), 'reason for creating an agent is not filed as pain');
  assert.equal(live.taught, 1);
  const explore = await quickRun([{value:'loose'}, {help:true}, {value:'I want to learn animation.'}, {value:'yes'}, {value:'wait'}], null, false, mind);
  assert(explore.calls.some(c => c.includes('helpRequested')), 'help action reaches model as a request for guidance');
  assert(!explore.writes.some(w => w.context === 'Help me figure that out'), 'help action is never saved as a personal fact');
  const early = await quickRun([{value:'loose'}, {value:'Just curious.'}, {value:'yes'}, {value:'wait'}], null, false,
    d => d.includes('THE TUESDAY') ? {text:'ACK: we can explore together.\nASK: NONE'} : mind(d));
  assert.equal(early.prompts.length, 4, 'ASK NONE skips unnecessary follow-ups');
  const repeated = await quickRun([{value:'deep'}, {value:'Build a game.'}, {value:'A puzzle game.'}, {value:'yes'}, {value:'wait'}], null, false, mind);
  assert.equal(repeated.prompts.filter(p => p.lines[0].text === 'which project would you like to make progress on?').length, 1, 'repeated generated questions are suppressed');
  let nextQuestion = 0;
  const deep = await quickRun([{value:'deep'}, {value:'Build a game.'}, {value:'Browser.'}, {value:'Puzzles.'}, {value:'A playable prototype.'}, {value:'yes'}, {value:'wait'}], null, false,
    d => d.includes('THE TUESDAY') ? {text:'ACK: noted.\nASK: question ' + (++nextQuestion) + '?'} : mind(d));
  assert.equal(deep.prompts.filter(p => /^question \d/.test(p.lines[0].text)).length, 3, 'deep path cannot exceed three follow-ups');
  assert(deep.calls.some(c => c.includes('A playable prototype.')), 'final answer reaches the synthesis');
  console.log('onboarding-refresh: OK (quick setup, exact answers, posture, deferred profile and cancellation)');
})().catch(error => { console.error(error); process.exitCode = 1; });
