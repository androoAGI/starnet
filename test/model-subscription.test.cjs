'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/modeldock.js'), 'utf8');
const handler = source.slice(source.indexOf('  function openSubscription(event)'), source.indexOf('  function wire()'));
async function exercise(invoke) {
  let closed = 0, prevented = 0;
  const notices = [], calls = [];
  const context = {
    closeDock: () => closed++,
    window: invoke ? { __TAURI__: { core: { invoke: (...args) => { calls.push(args); return invoke(); } } } } : {},
    StationUI: { notify: (...args) => notices.push(args) }
  };
  vm.runInNewContext(handler + '\nthis.openAccount = openSubscription;', context);
  context.openAccount({ preventDefault: () => prevented++ });
  await new Promise(resolve => setImmediate(resolve));
  return { closed, prevented, notices, calls };
}
(async () => {
  const browser = await exercise();
  assert.equal(browser.closed, 0, 'browser leaves the native link active through navigation');
  assert.equal(browser.prevented, 0, 'browser retains native anchor navigation');
  assert.equal(browser.calls.length, 0);
  const desktop = await exercise(() => Promise.resolve());
  assert.equal(desktop.closed, 1);
  assert.equal(desktop.prevented, 1, 'desktop suppresses the unsupported webview popup');
  assert.equal(desktop.calls.length, 1);
  assert.equal(desktop.calls[0][0], 'open_external_url');
  assert.equal(desktop.calls[0][1].url, 'https://www.starnetos.com/pricing');
  assert.equal(desktop.notices.length, 0);
  const failure = await exercise(() => Promise.reject(new Error('browser unavailable')));
  assert.equal(failure.notices.length, 1, 'failed desktop launch is visible');
  assert.match(failure.notices[0][0], /www\.starnetos\.com\/pricing/);
  assert.equal(failure.notices[0][1], 'warn');
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  assert.match(html, /id="model-dock-subscription" href="https:\/\/www\.starnetos\.com\/pricing" target="_blank" rel="noopener noreferrer"/);
  console.log('model-subscription: browser navigation, desktop bridge and failure feedback passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
