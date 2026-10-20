'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('lab process refuses model fetch, raw sockets and helper processes before I/O', () => {
  const script = `
    const assert = require('node:assert/strict');
    (async () => {
      await assert.rejects(fetch('https://example.invalid/model'), /LAB_OFFLINE/);
      assert.throws(() => require('node:https').get('https://example.invalid'), /LAB_OFFLINE/);
      assert.throws(() => new (require('node:net').Socket)().connect(443, 'example.invalid'), /LAB_OFFLINE/);
      assert.throws(() => require('node:child_process').execFile('anything'), /LAB_OFFLINE/);
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'guard.cjs'), '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('authoring adapter rejects non-local targets before requesting anything', async () => {
  const { client } = require('./workflow.cjs');
  await assert.rejects(client('https://example.invalid'), /Only a local/);
  await assert.rejects(client('http://127.0.0.1:8790/not-a-station'), /Only a local/);
});
