'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeComputerControl } = require('../sidecar/computer-control.js');
function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-computer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stored; let stopped = 0;
  const api = makeComputerControl({ root, platform: 'win32', arch: 'x64', desktopShell: true,
    env: { STARNET_COMPUTER_DRIVER: '1' }, load: () => stored, save: (_, value) => { stored = value; },
    onChange: () => { stopped++; }, ...extra });
  return { api, root, get stopped() { return stopped; } };
}
test('classic remains default, off persists and closes active CUA sessions', async t => {
  const f = setup(t); assert.equal(f.api.selection(), 'win32'); assert.equal(f.api.available(), true);
  await f.api.select('off'); assert.equal(f.api.available(), false); assert.equal(f.stopped, 1);
  await f.api.select('off'); assert.equal(f.stopped, 1);
  await f.api.select('win32'); assert.equal(f.api.available(), true);
});
test('missing CUA cannot be selected or advertised as available', async t => {
  const { api } = setup(t, { env: { STARNET_COMPUTER_DRIVER: 'cua' } });
  assert.equal(api.available(), false); assert.equal(api.status().installed, false);
  await assert.rejects(api.select('win32'), /launch environment/);
});
test('unsupported hosts do not launch or install native input', async t => {
  const { api } = setup(t, { platform: 'linux', desktopShell: false });
  assert.equal(api.available(), false);
  await assert.rejects(api.install(), /Windows x64/);
  await assert.rejects(api.select('cua'), /Windows desktop/);
});
test('failed persistence leaves runtime selection unchanged', async t => {
  const { api } = setup(t, { save: () => { throw new Error('disk full'); } });
  await assert.rejects(api.select('off'), /disk full/); assert.equal(api.selection(), 'win32');
});
test('readback mismatch never claims settings were saved', async t => {
  const { api } = setup(t, { load: () => ({}), save: () => {} });
  await assert.rejects(api.select('off'), /verified on disk/); assert.equal(api.selection(), 'win32');
});
test('bad downloads are rejected before extraction and staging is removed', async t => {
  const { api, root } = setup(t, { fetch: async () => new Response('corrupt archive') });
  await assert.rejects(api.install(), /checksum mismatch/);
  assert.equal(api.status().installed, false); assert.equal(api.status().installing, false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'native-computer')), []);
});
test('a failed repair preserves the previously installed bytes', async t => {
  const { api, root } = setup(t, { fetch: async () => new Response('corrupt archive') });
  const dir = path.join(root, 'native-computer', '0.28.2'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cua-driver.exe'), 'previous driver');
  fs.writeFileSync(path.join(dir, 'cua-driver-uia.exe'), 'previous helper');
  await assert.rejects(api.install({ repair: true }), /checksum mismatch/);
  assert.equal(fs.readFileSync(path.join(dir, 'cua-driver.exe'), 'utf8'), 'previous driver');
  assert.equal(api.status().installed, true);
});
