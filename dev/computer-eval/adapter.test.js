'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDriver, connect, unwrap, childEnv } = require('./cua-driver.js');
const { makeComputerTools } = require('../../sidecar/tools/builtin/computer.js');
const target = { pid: 123, window_id: 456 };
const fullPower = { unrestrictedHost: true, inputMode: 'full-power' };

test('process environment omits provider credentials and disables telemetry', () => {
  assert.deepEqual(childEnv({ SystemRoot: 'C:/Windows', OPENAI_API_KEY: 'secret', Path: 'bin' }),
    { SystemRoot: 'C:/Windows', Path: 'bin', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' });
});
test('missing launcher authority cannot start a daemon', async () => {
  await assert.rejects(connect({ binary: 'must-not-start' }), /Full Power/);
});
test('logical MCP errors are not converted to successful actions', () => {
  assert.throws(() => unwrap({ isError: true, content: [{ type: 'text', text: 'stale target' }] }), /stale target/);
});
test('the existing StarNet context gate still blocks restricted runs', async () => {
  let calls = 0;
  const driver = makeDriver({ data: async () => { calls++; } }, target);
  const tool = makeComputerTools({ driver, allowPhysicalInput: true }).useTool;
  await assert.rejects(tool.run({ action: 'type', text: 'no' }, {}), /Full Power/);
  assert.equal(calls, 0);
});
test('snapshot tokens are forwarded once and exact window identity is retained', async () => {
  const calls = [];
  const connection = { data: async (name, args) => {
    calls.push({ name, args });
    return name === 'get_window_state' ? { elements: [{ element_index: 7, element_token: 's00000001:7' }] } : { effect: 'unverifiable', route: 'accessibility' };
  }};
  const driver = makeDriver(connection, target);
  assert.throws(() => driver.selectElement(7), /latest observation/);
  await driver.observe(); driver.selectElement(7);
  const tool = makeComputerTools({ driver, allowPhysicalInput: true }).useTool;
  const result = await tool.run({ action: 'click' }, fullPower);
  assert.match(result.content, /unverifiable/);
  assert.deepEqual(calls[1], { name: 'click', args: { ...target, element_token: 's00000001:7' } });
  await assert.rejects(driver.perform({ action: 'click' }), /observed element/);
});
test('key and hotkey use distinct driver contracts', async () => {
  const calls = [];
  const driver = makeDriver({ data: async (name, args) => { calls.push({ name, args }); return { effect: 'unverifiable' }; } }, target);
  await driver.perform({ action: 'key', key: 'enter' });
  await driver.perform({ action: 'hotkey', keys: ['ctrl', 's'] });
  assert.equal(calls[0].name, 'press_key'); assert.equal(calls[0].args.key, 'enter');
  assert.deepEqual(calls[1].args.keys, ['ctrl', 's']);
});
test('refused structured results cannot become computer.use ok', async () => {
  const driver = makeDriver({ data: async () => ({ status: 'refused', refusal: { code: 'stale' } }) }, target);
  await assert.rejects(driver.perform({ action: 'type', text: 'test' }), /stale/);
});
test('screenshot metadata without pixels is not accepted as visual proof', async () => {
  const driver = makeDriver({ call: async () => ({ structuredContent: { width: 100 }, content: [] }) }, target);
  await assert.rejects(driver.capture(), /no screenshot/);
});
