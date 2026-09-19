'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/cloudsave.js'), 'utf8');

(async () => {
  for (const phase of ['headers', 'body']) {
    let release, signal;
    const timers = new Map(); let seq = 0;
    const context = { console, module: { exports: {} }, require, AbortController,
      setTimeout(fn, delay) { const id = ++seq; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      fetch(url, opts) {
        signal = opts.signal;
        if (phase === 'headers') return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true }) }); });
        return Promise.resolve({ ok: true, json: () => new Promise(resolve => { release = () => resolve({ ok: true }); }) });
      }
    };
    vm.runInNewContext(source, context);
    const client = context.module.exports;
    client.push({ schema: 'starnet.save', version: 5, updatedAt: 1, agent: { id: 'agent' } });
    const writing = client.flush({ force: true });
    await Promise.resolve(); await Promise.resolve();
    const deadline = [...timers.values()].find(t => t.delay === 15000);
    assert.ok(deadline, phase + ' write has a bounded persistence deadline');
    deadline.fn();
    assert.equal(await writing, false, phase + ' timeout is not success');
    assert.equal(signal.aborted, true);
    assert.equal(client.health().lastPushOkAt, 0);
    release(); await Promise.resolve(); await Promise.resolve();
    assert.equal(client.health().lastPushOkAt, 0, 'late reply cannot acknowledge expired transport');
    let retried;
    context.fetch = async (url, opts) => { retried = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; };
    assert.equal(await client.flush({ force: true }), true, 'same snapshot can retry after timeout');
    assert.equal(retried.agent.id, 'agent');
  }
  console.log('cloudsave timeout: stalled headers/body, abort, late acknowledgement and retry PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
