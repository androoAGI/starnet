'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCuaComputerTools } = require('../sidecar/tools/builtin/cua-computer.js');
const { childEnv } = require('../sidecar/tools/builtin/cua-runtime.js');
const FULL = { unrestrictedHost: true, inputMode: 'full-power' };
function fixture(reply = {}) {
  const calls = []; let opened = 0, closed = 0;
  const tools = makeCuaComputerTools({ allowPhysicalInput: true, binary: 'fixture', connect: async () => {
    opened++;
    return { call: async (name, args) => { calls.push({ name, args }); return typeof reply === 'function' ? reply(name, args) : reply; }, close: async () => { closed++; } };
  }});
  return { ...tools, calls, get opened() { return opened; }, get closed() { return closed; } };
}
test('restricted and cancelled calls never start the native runtime', async () => {
  const f = fixture();
  await assert.rejects(f.useTool.run({ action: 'list_windows' }, {}), /physical input is disabled/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(f.useTool.run({ action: 'list_windows' }, { ...FULL, signal: ac.signal }), /cancelled/);
  assert.equal(f.opened, 0);
});
test('describe exposes pinned schema without starting a desktop process', async () => {
  const f = fixture();
  const result = await f.useTool.run({ action: 'describe', operation: 'click' }, FULL);
  const op = JSON.parse(result.content);
  assert.ok(op.input_schema.properties.element_token);
  assert.equal(op.input_schema.properties.session, undefined);
  assert.equal(f.opened, 0);
});
test('forwards exact semantic target and preserves ambiguous effect', async () => {
  const f = fixture({ structuredContent: { effect: 'unverifiable', delivery_mode: 'background' } });
  const parameters = { pid: 123, window_id: 456, element_token: 'observed-token', text: 'hello' };
  const out = await f.useTool.run({ action: 'type_text', parameters }, FULL);
  assert.deepEqual(f.calls, [{ name: 'type_text', args: parameters }]);
  assert.match(out.summary, /unverifiable/);
  assert.doesNotMatch(out.summary, / ok|success/);
  assert.equal(JSON.parse(out.content).delivery_mode, 'background');
  await f.close(); assert.equal(f.closed, 1);
});
test('expired sessions are discarded without replaying a mutation', async () => {
  const f = fixture({ isError: true, structuredContent: { text: 'session starnet-test has ended' } });
  await assert.rejects(f.useTool.run({ action: 'click', parameters: { pid: 1, window_id: 2, x: 3, y: 4 } }, FULL), /has ended/);
  assert.equal(f.calls.length, 1); assert.equal(f.closed, 1);
  await assert.rejects(f.useTool.run({ action: 'list_windows' }, FULL), /has ended/);
  assert.equal(f.opened, 2); await f.close();
});
test('snapshot calls are serialized and authority is checked on every call', async () => {
  let unblock; const blocked = new Promise(resolve => { unblock = resolve; });
  const f = fixture(async name => { if (name === 'get_window_state') await blocked; return { structuredContent: { effect: 'confirmed' } }; });
  const first = f.useTool.run({ action: 'get_window_state', parameters: { pid: 1 } }, FULL);
  const second = f.useTool.run({ action: 'click' }, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); unblock(); await first;
  await assert.rejects(second, /disabled/); assert.equal(f.calls.length, 1); await f.close();
});
test('timeout/cancellation closes owned connection; no silent retries', async () => {
  const f = fixture(async () => { throw new Error('request timed out'); });
  await assert.rejects(f.useTool.run({ action: 'type_text', parameters: { text: 'x' } }, FULL), /timed out/);
  assert.equal(f.calls.length, 1); assert.equal(f.closed, 1);
});
test('logical refusal stays a tool error and session overrides are rejected', async () => {
  const f = fixture({ structuredContent: { effect: 'refused', refusal: { code: 'stale_element_token' } } });
  const registry = require('../sidecar/tools/registry').makeRegistry();
  f.register(registry);
  const out = await registry.dispatch({ id: 'refusal', name: 'computer.use', args: { action: 'click', parameters: { element_token: 'stale' } } }, { ...FULL, authorize: async () => ({ ok: true }), consent: async () => ({ allow: true }) });
  assert.equal(out.isError, true); assert.match(out.content, /stale_element_token/);
  await assert.rejects(f.useTool.run({ action: 'list_windows', parameters: { session: 'other-run' } }, FULL), /owns the computer session/);
  assert.equal(f.calls.length, 1); await f.close();
});
test('transport receives no provider credentials or injected Node options', () => {
  const env = childEnv({ Path: 'system-path', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require bad', STARNET_IPC_TOKEN: 'secret' });
  assert.deepEqual(env, { Path: 'system-path', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' });
});
test('closed run cannot restart a private runtime', async () => {
  const f = fixture(); await f.close();
  await assert.rejects(f.useTool.run({ action: 'list_windows' }, FULL), /cancelled/);
  assert.equal(f.opened, 0);
});
test('per-tool cancellation reaches an in-progress driver startup', async () => {
  let starting;
  const started = new Promise(resolve => { starting = resolve; });
  let observedAbort = false;
  const tool = makeCuaComputerTools({ allowPhysicalInput: true, connect: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('startup cancelled')); }, { once: true });
    starting();
  }) });
  const ac = new AbortController();
  const pending = tool.useTool.run({ action: 'list_windows' }, { ...FULL, signal: ac.signal });
  await started; ac.abort();
  await assert.rejects(pending, /startup cancelled/);
  assert.equal(observedAbort, true); await tool.close();
});
test('real image bytes use imagewire while effect and tree remain readable', async () => {
  const imageWire = require('../sidecar/tools/builtin/imagewire').makeImageWire();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+AAAAABJRU5ErkJggg==';
  const tool = makeCuaComputerTools({ allowPhysicalInput: true, imageWire, connect: async () => ({
    call: async () => ({ structuredContent: { elements: [{ element_token: 'fresh' }] }, content: [{ type: 'image', mimeType: 'image/png', data: png }] }), close: async () => {}
  }) });
  const out = await tool.useTool.run({ action: 'get_window_state', parameters: { pid: 1 } }, FULL);
  assert.equal(out.images[0].data, png); assert.equal(JSON.parse(out.content).elements[0].element_token, 'fresh');
  assert.ok(!out.content.includes(png), 'base64 does not bloat textual evidence'); await tool.close();
});
