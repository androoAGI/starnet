'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const util = fs.readFileSync('frontend/js/util.js', 'utf8');
const timers = [];
const ctx = vm.createContext({ AbortSignal: {}, AbortController, DOMException, setTimeout: (fn, ms) => timers.push({ fn, ms }) });
vm.runInContext(util + ';this.U = U;', ctx);
for (const ms of [0, 10000, 12000, 15000]) {
  const signal = ctx.U.timeoutSignal(ms);
  assert.equal(signal.aborted, false);
  assert.equal(timers.at(-1).ms, ms);
  timers.at(-1).fn();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'TimeoutError');
}
for (const ms of [-1, NaN, Infinity, 0.5, 2147483648]) assert.throws(() => ctx.U.timeoutSignal(ms), /Invalid request timeout/);
const sentinel = {};
ctx.AbortSignal.timeout = ms => { assert.equal(ms, 17); return sentinel; };
assert.equal(ctx.U.timeoutSignal(17), sentinel, 'native implementation remains authoritative');
// Actual transport cancellation without AbortSignal.timeout (not a fake fetch).
(async () => {
  // Execute production widget polling with the missing API, including failure and retry.
  const widgetSource = fs.readFileSync('frontend/app/widgets.js', 'utf8');
  const legacyWidgets = vm.createContext({ AbortSignal: {}, AbortController, DOMException,
    setTimeout: (fn, ms) => timers.push({ fn, ms }), gameEntered: () => true,
    feedRequest: null, insightsRequest: null, insights: null, feed: new Map(), pollFail: {}, liveRunEnds: 2, layout: { top: ['runs24'], bot: [] },
    paintAll() {}, render() {}, libraryCards() {},
    fetch: async () => ({ ok: true, json: async () => ({ widgets: [], overTime: [] }) }) });
  vm.runInContext(util, legacyWidgets);
  for (const name of ['pollFeed', 'pollInsights']) {
    const fn = widgetSource.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
    assert.ok(fn, name);
    vm.runInContext(fn[0], legacyWidgets);
    await legacyWidgets[name]();
  }
  assert.equal(legacyWidgets.pollFail.feed, false);
  assert.equal(legacyWidgets.pollFail.insights, false);
  legacyWidgets.fetch = async () => { throw new Error('offline'); };
  await legacyWidgets.pollFeed();
  assert.equal(legacyWidgets.pollFail.feed, true);
  assert.equal(legacyWidgets.feedRequest, null, 'failed polling releases its in-flight lock');
  legacyWidgets.fetch = async () => ({ ok: true, json: async () => ({ widgets: [] }) });
  await legacyWidgets.pollFeed();
  assert.equal(legacyWidgets.pollFail.feed, false, 'subsequent poll recovers');
  vm.runInContext(widgetSource.match(/  async function widgetApi\([^]*?\n  \}/)[0], legacyWidgets);
  let write;
  legacyWidgets.fetch = async (url, options) => { write = { url, options }; return { ok: true, json: async () => ({ ok: true }) }; };
  await legacyWidgets.widgetApi('/pin', { slug: 'example' });
  assert.equal(write.url, '/api/widgets/pin');
  assert.equal(write.options.method, 'POST');
  assert.equal(write.options.signal.aborted, false);
  assert.deepEqual(JSON.parse(write.options.body), { slug: 'example' });
  legacyWidgets.fetch = async () => ({ ok: false, json: async () => ({ error: 'refused' }) });
  await assert.rejects(legacyWidgets.widgetApi('/pin', { slug: 'example' }), /refused/);
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const legacy = vm.createContext({ AbortSignal: {}, AbortController, DOMException, setTimeout });
    vm.runInContext(util + ';this.U = U;', legacy);
    await assert.rejects(fetch('http://127.0.0.1:' + server.address().port, { signal: legacy.U.timeoutSignal(40) }), { name: 'TimeoutError' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // Execute the real staging function on a small tree, then load the exact
  // packaged script referenced by index.html with no engine/global API origin.
  const { stage, KEEP_INDUSTRIAL } = await import(pathToFileURL(path.resolve('scripts/stage-frontend-dist.mjs')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-mac-boot-'));
  try {
    const src = path.join(dir, 'frontend'), dest = path.join(dir, 'bundle');
    for (const name of KEEP_INDUSTRIAL) fs.mkdirSync(path.join(src, 'assets/industrial', name), { recursive: true });
    fs.copyFileSync('frontend/index.html', path.join(src, 'index.html'));
    stage({ src, dest, log() {} });
    const html = fs.readFileSync(path.join(dest, 'index.html'), 'utf8');
    assert.match(html, /<script src="\/shared\/specialties.js"><\/script>/);
    assert.ok(html.indexOf('src="/shared/specialties.js"') < html.indexOf('src="app/specialties.js"'));
    assert.ok(!html.includes("document.write('<script src="), 'boot data must not depend on the loopback API origin');
    const catalog = fs.readFileSync(path.join(dest, 'shared/specialties.js'), 'utf8');
    assert.equal(catalog, fs.readFileSync('shared/specialties.js', 'utf8'));
    const catalogContext = vm.createContext({});
    vm.runInContext(catalog, catalogContext);
    assert.ok(vm.runInContext('typeof SharedSpecialties !== "undefined"', catalogContext));
    assert.throws(() => stage({ src, dest, shared: path.join(dir, 'missing'), log() {} }), /catalog missing/);
    assert.ok(fs.existsSync(path.join(dest, 'shared/specialties.js')), 'failed source preflight preserves previous output');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Catch the whole sibling class, not only the reported widget call.
  for (const file of ['frontend/app/widgets.js', 'frontend/app/emergency-control.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!source.includes('AbortSignal.timeout('), file + ' must use the compatible deadline');
    assert.ok(source.includes('U.timeoutSignal('));
  }
  console.log('PASS Mac boot: legacy/native deadlines, real fetch cancellation, bundled catalog and sibling consumers');
})().catch(err => { console.error(err); process.exitCode = 1; });
