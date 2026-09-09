'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/app/emergency-control.js', 'utf8');
const tick = () => new Promise(r => setImmediate(r));
function element() { return { textContent: '', hidden: false, disabled: false, style: {}, listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; }, setAttribute(k, v) { this.tip = v; } }; }
function snapshot(halted) { return { halted, subsystems: Object.fromEntries(['cron', 'nightshift', 'loops'].map(k => [k, { halted }])) }; }
(async () => {
  const recovery = element();
  const nodes = { 'automation-resume': recovery };
  let current = snapshot(true), failRead = false, partial = false;
  const calls = [], notices = [];
  let focus;
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes[id], addEventListener() {}, hidden: false },
    window: { addEventListener(k, fn) { if (k === 'focus') focus = fn; } }, setInterval() {}, AbortSignal,
    StationUI: { notify: m => notices.push(m) },
    fetch: async (path, opts) => {
      calls.push([path, opts]);
      if (opts.method === 'GET') { if (failRead) throw new Error('offline'); return { ok: true, json: async () => current }; }
      if (path.endsWith('/resume')) {
        current = snapshot(false);
        if (partial) { current.halted = true; current.subsystems.loops.halted = true; }
        return { ok: !partial, json: async () => ({ ...current, ok: !partial, errors: partial ? { loops: 'disk failed' } : {} }) };
      }
      current = snapshot(true);
      return { ok: true, json: async () => ({ cronHaltPersisted: true, nightshiftHaltPersisted: true, loopsHaltPersisted: true }) };
    }
  });
  await tick();
  assert.equal(recovery.textContent, 'RESUME AUTOMATION', 'boot reflects old persisted stops');
  assert.equal(calls.filter(c => c[1].method === 'POST').length, 0, 'hydration never resumes');
  await recovery.listeners.click();
  assert.equal(recovery.textContent, 'RESUME AUTOMATION');
  assert.equal(recovery.style.display, 'none', 'hidden wins over .bb paint');
  assert.equal(calls.at(-1)[1].method, 'GET', 'POST success is rechecked');
  assert.deepEqual(JSON.parse(calls.find(c => c[0].endsWith('/resume'))[1].body), { confirm: true });
  assert.ok(!calls.some(c => /posture|cron\/arm|loops\/control/.test(c[0])), 'no posture or permissions mutation');
  await recovery.listeners.click();
  assert.equal(calls.filter(c => c[1].method === 'POST').length, 1, 'stale recovery clicks never stop healthy automation');
  current = snapshot(true);
  await focus();
  partial = true;
  await recovery.listeners.click();
  assert.equal(recovery.textContent, 'RESUME AUTOMATION');
  assert.match(recovery.tip, /Could not resume: loops/);
  assert.match(notices.at(-1), /loops/);
  failRead = true;
  await recovery.listeners.click();
  assert.equal(recovery.textContent, 'CHECK AUTOMATION', 'unknown is never described as resumed');
  assert.match(recovery.tip, /Could not verify/);
  const writes = calls.filter(c => c[1].method === 'POST').length;
  await recovery.listeners.click();
  assert.equal(calls.filter(c => c[1].method === 'POST').length, writes, 'unknown-state retry only reads');
  assert.ok(calls.every(c => c[1].method !== 'POST' || c[0] === '/api/halt/resume'), 'recovery never calls global stop');
  console.log('PASS emergency control: hydrated recovery, explicit action, read-back, partial failure and offline truth');
})().catch(e => { console.error(e); process.exitCode = 1; });
