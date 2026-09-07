'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/app/emergency-control.js', 'utf8');
const tick = () => new Promise(r => setImmediate(r));
function element() { return { textContent: '', hidden: false, disabled: false, style: {}, listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; }, setAttribute() {} }; }
function snapshot(halted) { return { halted, subsystems: Object.fromEntries(['cron', 'nightshift', 'loops'].map(k => [k, { halted }])) }; }
(async () => {
  const button = element(), label = element(), detail = element(), recovery = element(), retry = element();
  button.querySelector = s => s === 'b' ? label : detail;
  const nodes = { 'automation-stop-toggle': button, 'automation-resume': recovery, 'automation-stop-retry': retry };
  let current = snapshot(true), failRead = false, partial = false;
  const calls = [], notices = [];
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes[id], addEventListener() {}, hidden: false },
    window: { addEventListener() {} }, setInterval() {}, AbortSignal,
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
  assert.equal(label.textContent, 'RESUME AUTOMATION', 'boot reflects old persisted stops');
  assert.equal(calls.filter(c => c[1].method === 'POST').length, 0, 'hydration never resumes');
  await recovery.listeners.click();
  assert.equal(label.textContent, 'STOP AUTOMATION');
  assert.equal(recovery.style.display, 'none', 'hidden wins over .bb paint');
  assert.equal(calls.at(-1)[1].method, 'GET', 'POST success is rechecked');
  assert.deepEqual(JSON.parse(calls.find(c => c[0].endsWith('/resume'))[1].body), { confirm: true });
  assert.ok(!calls.some(c => /posture|cron\/arm|loops\/control/.test(c[0])), 'no posture or permissions mutation');
  await button.listeners.click();
  assert.equal(label.textContent, 'RESUME AUTOMATION');
  partial = true;
  await button.listeners.click();
  assert.equal(label.textContent, 'RESUME AUTOMATION');
  assert.match(detail.textContent, /Could not resume: loops/);
  assert.match(notices.at(-1), /loops/);
  failRead = true;
  await button.listeners.click();
  assert.equal(label.textContent, 'CHECK STOP STATE', 'unknown is never described as resumed');
  assert.match(detail.textContent, /Could not verify/);
  const writes = calls.filter(c => c[1].method === 'POST').length;
  await button.listeners.click();
  assert.equal(calls.filter(c => c[1].method === 'POST').length, writes, 'unknown-state retry only reads');
  console.log('PASS emergency control: hydrated recovery, explicit action, read-back, partial failure and offline truth');
})().catch(e => { console.error(e); process.exitCode = 1; });
