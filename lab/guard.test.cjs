'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARD = path.join(__dirname, 'guard.cjs');

test('lab process refuses model fetch, raw sockets and helper processes before I/O (offline posture)', () => {
  const script = `
    const assert = require('node:assert/strict');
    (async () => {
      await assert.rejects(fetch('https://example.invalid/model'), /LAB_OFFLINE/);
      assert.throws(() => require('node:https').get('https://example.invalid'), /LAB_OFFLINE/);
      assert.throws(() => new (require('node:net').Socket)().connect(443, 'example.invalid'), /LAB_OFFLINE/);
      assert.throws(() => require('node:child_process').execFile('anything'), /LAB_OFFLINE/);
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['--require', GUARD, '-e', script],
    { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { LAB_LIVE: '0' }) });
  assert.equal(result.status, 0, result.stderr);
});

test('the live posture lets every provider host through and names the ones it blocks', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { ALLOW_HOSTS, hostAllowed } = require(${JSON.stringify(GUARD)});
    (async () => {
      // The hosts StarNet's own provider cards talk to must be reachable, or no card can be set up.
      for (const host of ['opencode.ai', 'openrouter.ai', 'api.anthropic.com', 'api.openai.com',
        'generativelanguage.googleapis.com', 'api.x.ai', 'api.kimi.com', 'chatgpt.com', '127.0.0.1']) {
        assert.ok(hostAllowed(host), host + ' must be allowed');
      }
      // THE SIGN-IN HOSTS. A provider card names where INFERENCE goes; the sign-in goes to the vendor's AUTH host.
      // Without them the ChatGPT / Grok / Kimi sign-in cannot even start ("LAB_BLOCKED: auth.openai.com is not on
      // the allowed host list", 2026-10-20) — the card looked configured and the sign-in died.
      for (const host of ['auth.openai.com', 'auth.x.ai', 'auth.kimi.com', 'auth.kimi.ai', 'api.kimi.ai']) {
        assert.ok(hostAllowed(host), host + ' must be allowed: the device-code sign-in runs there');
      }
      assert.ok(!hostAllowed('evil.example.test'), 'an unknown host stays out');
      // A blocked host must say WHAT is allowed and HOW to widen it — not just "LAB_OFFLINE".
      assert.throws(() => fetch('https://evil.example.test/model'), /LAB_BLOCKED/);
      assert.throws(() => fetch('https://evil.example.test/model'), /LAB_ALLOW_HOSTS/);
      // An allowed host is not blocked by the guard (it fails on the network, not on the lab).
      let guardBlocked = false;
      try { await fetch('http://127.0.0.1:1/nothing'); } catch (e) { guardBlocked = /LAB_(BLOCKED|OFFLINE)/.test(String(e && e.message)); }
      assert.equal(guardBlocked, false, 'an allowed host is not blocked by the lab');
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['--require', GUARD, '-e', script],
    { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { LAB_LIVE: '1' }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the default allow list is derived from the provider registry, not hand-kept', () => {
  const { defaultAllowHosts } = require('./guard.cjs');
  const hosts = defaultAllowHosts();
  assert.ok(hosts.includes('openrouter.ai'), 'openrouter is reachable');
  assert.ok(hosts.includes('api.anthropic.com'), 'anthropic is reachable');
  assert.ok(hosts.includes('opencode.ai'), 'the lab own custom endpoint is reachable');
  assert.ok(hosts.includes('localhost'), 'a local model server is reachable');
  assert.ok(!hosts.includes('evil.example.test'), 'nothing else is');
  // The SIGN-IN hosts come from the registry too (authHosts), so a NEW provider card is reachable end to end
  // without anyone remembering to add its host to this file.
  const registry = require('../sidecar/providers/registry.js');
  for (const p of registry.listProviderProfiles({ public: false })) {
    for (const h of p.authHosts || []) assert.ok(hosts.includes(h), p.id + ' sign-in host ' + h + ' is reachable');
  }
  assert.ok(hosts.includes('auth.openai.com'), 'the ChatGPT sign-in host is reachable');
});

test('authoring adapter rejects non-local targets before requesting anything', async () => {
  const { client } = require('./workflow.cjs');
  await assert.rejects(client('https://example.invalid'), /Only a local/);
  await assert.rejects(client('http://127.0.0.1:8790/not-a-station'), /Only a local/);
});
