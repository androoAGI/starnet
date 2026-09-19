'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../remote/setup-ui.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(config = null) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) {
      let value = id === 'gateway-port' ? '18791' : '';
      nodes.set(id, { get value() { return value; }, set value(next) { value = String(next); }, dataset: {}, addEventListener() {}, focus() {}, reportValidity: () => true });
    }
    return nodes.get(id);
  };
  const location = { href: '' }, timers = [];
  let state = { config, localAvailable: true, installerAvailable: true, busy: false, phase: 'idle', message: '' };
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelector: () => ({ content: 'fixture' }), querySelectorAll: () => [] },
    window: { location }, AbortController, setTimeout, clearTimeout,
    setInterval: callback => timers.push(callback),
    fetch: async url => {
      if (url === '/api/test') state = { ...state, busy: true, phase: 'working' };
      if (url === '/api/cancel') state = { ...state, busy: false, phase: 'idle' };
      return { ok: true, json: async () => state };
    }
  });
  await settle();
  return { element, location, poll: async next => { state = { ...state, ...next }; await timers[0](); await settle(); } };
}
const config = { host: 'fixture-server', owner: 42, port: 8790, 'gateway-port': 18791 };

test('first verified connection opens automatically, including a stale idle poll while checking', async () => {
  const f = await fixture();
  f.element('host').value = config.host;
  f.element('connection').onsubmit({ preventDefault() {} }); await settle();
  await f.poll({ busy: false, phase: 'idle' });
  assert.equal(f.location.href, '', 'an idle status cannot navigate or disarm the pending first setup');
  await f.poll({ config, busy: false, phase: 'connected' });
  assert.equal(f.location.href, 'starnet-connect://remote');
  f.location.href = '';
  await f.poll({});
  assert.equal(f.location.href, '', 'later polls never reopen a hidden chooser');
});

test('an existing connection stays in setup after testing and cancelled first setup cannot auto-open', async () => {
  const existing = await fixture(config);
  existing.element('connection').onsubmit({ preventDefault() {} }); await settle();
  await existing.poll({ config, busy: false, phase: 'connected' });
  assert.equal(existing.location.href, '');
  assert.equal(existing.element('open').hidden, false);
  const fresh = await fixture(); fresh.element('host').value = config.host;
  fresh.element('connection').onsubmit({ preventDefault() {} }); await settle();
  fresh.element('cancel').onclick(); await settle();
  await fresh.poll({ config, busy: false, phase: 'connected' });
  assert.equal(fresh.location.href, '');
});
