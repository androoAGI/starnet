'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
(async () => {
  const { instrumentGaze } = await import('../scripts/lib/gaze-proof.mjs');
  const run = body => {
    const ctx = { window: {}, performance: { now: () => 10 } };
    vm.runInNewContext(instrumentGaze(`
      const bodies = [{id:'a',px:1,py:2,target:{tile:{x:2,y:2}}}, {id:'b',px:2,py:2}];
      function allBodies(){ return bodies; }
      function glanceAt(self_, otherBody, dur, now) { ${body} }
      window.invoke = () => glanceAt(bodies[0], bodies[1], 100, 10);
      window.bodies = bodies;
    `), ctx);
    return ctx.window;
  };
  const unchanged = run('self_.glance = otherBody.id; return 42;');
  assert.equal(unchanged.invoke(), 42, 'preserve original result');
  assert.equal(unchanged.bodies[0].glance, 'b', 'preserve real gaze effect');
  assert.equal(unchanged.__STARNET_GAZE_PROOF__.read().violations.length, 0, 'occupied target does not establish a movement violation');
  assert.equal(unchanged.__STARNET_GAZE_PROOF__.exercise().forced, 2, 'exercise both directions');
  for (const mutation of ['self_.px++', 'otherBody.py++', 'self_.target = {tile:{x:9,y:9}}', 'self_.pathPts = [{x:4,y:5}]', 'self_.state = "walk"']) {
    const changed = run(mutation);
    changed.invoke();
    assert.equal(changed.__STARNET_GAZE_PROOF__.read().violations.length, 1, 'detect movement: ' + mutation);
  }
  assert.throws(() => instrumentGaze('no seam'), /exactly one/);
  assert.throws(() => instrumentGaze('function glanceAt(self_, otherBody, dur, now) { function glanceAt(self_, otherBody, dur, now) {'), /exactly one/);
  console.log('audit-gaze-proof: gaze preserved; position, target, path and state mutations detected; missing/duplicate seams rejected');
})().catch(e => { console.error(e); process.exitCode = 1; });
