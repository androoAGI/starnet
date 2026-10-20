'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/app/world.js'), 'utf8');
const start = source.indexOf('  function spawnAgent(a) {');
const end = source.indexOf('  /* THE WELCOME', start);
assert.ok(start >= 0 && end > start);

function harness({ desk = true, seat = true, geometry = true, existing = false } = {}) {
  const crew = existing ? [{ agentId: 'coordinator' }] : [];
  let fallbackCalls = 0;
  const spawn = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
    crew, agent: { id: 'agent' }, geo: geometry ? {} : null, fnow: 10,
    deskPropFor: () => desk ? { id: 'desk', agentId: 'coordinator' } : null,
    deskSeat: () => seat ? { tx: 21, ty: 5 } : null,
    seatFoot: () => ({ x: 264, y: 71 }),
    workerFoot: () => { fallbackCalls++; return { x: 24, y: 24 }; },
    makeCrewBody: (id, name, color, x, y) => ({ agentId: id, name, color, px: x, py: y }),
    crewColor: () => '#fff', greetNewcomer: () => {}, U: { irnd: () => 2000 }, DATA: { SKINS: { base: {} } }
  });
  return { crew, spawn, fallbackCalls: () => fallbackCalls };
}

test('worker with an assigned desk appears at its real seat, without simulating a job', () => {
  const h = harness();
  h.spawn({ id: 'coordinator', name: 'Orchestrator' });
  assert.equal(h.crew.length, 1);
  assert.equal(h.crew[0].px, 264);
  assert.equal(h.crew[0].py, 71);
  assert.equal(h.fallbackCalls(), 0);
  assert.equal(h.crew[0].working, undefined);
});

test('deskless or unreachable-seat workers retain the previous spawn behavior', () => {
  for (const opts of [{ desk: false }, { seat: false }]) {
    const h = harness(opts);
    h.spawn({ id: 'coordinator' });
    assert.equal(h.crew[0].px, 24);
    assert.equal(h.fallbackCalls(), 1);
  }
  const h = harness({ geometry: false });
  h.spawn({ id: 'coordinator' });
  assert.equal(h.crew[0].px, 0);
  assert.equal(h.fallbackCalls(), 0);
});

test('a pre-existing pipeline body is rehydrated, not moved or duplicated', () => {
  const h = harness({ existing: true });
  h.spawn({ id: 'coordinator', name: 'Orchestrator', skin: 'base' });
  assert.equal(h.crew.length, 1);
  assert.equal(h.crew[0].name, 'Orchestrator');
  assert.equal(h.crew[0].px, undefined);
  assert.equal(h.fallbackCalls(), 0);
});
