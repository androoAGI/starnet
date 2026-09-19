'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeConnectorVault, FORMAT } = require('../sidecar/connector-vault.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-vault-'));
const file = path.join(root, 'state.json');
const legacy = path.join(root, 'oauth.json');
const keyHex = 'a1'.repeat(32);
const state = { version: 2, configs: [{ id: 'gmail' }], oauth: { byId: { gmail: { accessToken: 'ACCESS_CANARY', refreshToken: 'REFRESH_CANARY' } }, clients: {} } };
const make = extra => makeConnectorVault({ fs, path, keyHex, ...extra });
try {
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(file + '.bak', JSON.stringify(state));
  fs.writeFileSync(legacy, JSON.stringify(state.oauth));
  fs.writeFileSync(legacy + '.bak', JSON.stringify(state.oauth));
  const broken = make({ writeDurable() { throw Error('disk full'); } });
  assert.throws(() => broken.migrate(file, state, [legacy]));
  assert.equal(JSON.parse(fs.readFileSync(legacy)).byId.gmail.refreshToken, 'REFRESH_CANARY');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), state, 'failed migration preserves original main and legacy files');
  const vault = make();
  vault.migrate(file, state, [legacy]);
  assert.ok(!fs.existsSync(legacy) && !fs.existsSync(legacy + '.bak'));
  for (const f of [file, file + '.bak']) {
    const raw = fs.readFileSync(f, 'utf8');
    assert.equal(JSON.parse(raw).format, FORMAT);
    assert.ok(!raw.includes('CANARY') && !raw.includes(keyHex));
  }
  assert.deepEqual(make().load(file), state, 'same key opens after restart');
  const sanitize = require('../sidecar/station-recovery.js')._internals.sanitizeManagedJson;
  assert.throws(() => sanitize('connectors/state.json', fs.readFileSync(file)), /unlocked OS credential store/, 'portable backup cannot silently discard encrypted connector settings');
  const portable = sanitize('connectors/state.json', fs.readFileSync(file), { readConnectorState: () => make().load(file) });
  const portableState = JSON.parse(portable.data.toString());
  assert.equal(portableState.configs.length, state.configs.length, 'portable export keeps connector inventory');
  assert.deepEqual(portableState.oauth, { byId: {}, clients: {} }, 'portable export excludes decrypted OAuth credentials');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => vault.write(file, {}), /Invalid connector state/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  for (const supplied of ['', 'b2'.repeat(32)]) {
    const missing = make({ keyHex: supplied });
    assert.throws(() => missing.load(file), /locked/);
    assert.throws(() => missing.write(file, {}), /locked/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'wrong or absent key cannot overwrite ciphertext');
  }
  const tampered = JSON.parse(before); tampered.tag = '00'.repeat(16);
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => make().load(file), /locked/, 'authentication failure is not an empty store or silent rollback');
  fs.writeFileSync(file, '{');
  assert.deepEqual(make().load(file), state, 'torn JSON recovers encrypted backup');
  fs.writeFileSync(file, before);
  const lockedFs = Object.create(fs);
  lockedFs.readFileSync = (target, ...args) => { if (target === file) throw Object.assign(Error('busy'), { code: 'EACCES' }); return fs.readFileSync(target, ...args); };
  assert.throws(() => make({ fs: lockedFs }).load(file), /locked/, 'unreadable main cannot roll back to backup');
  const clean = { version: 2, configs: [], oauth: { byId: {}, clients: {} } };
  vault.write(file, clean, { removal: true });
  assert.deepEqual(make().load(file), clean);
  fs.unlinkSync(file);
  assert.deepEqual(make().load(file), clean, 'removal also purges recovery copy');
  const required = make({ keyHex: '', required: true });
  assert.throws(() => required.load(path.join(root, 'new.json')), /locked/);
  assert.throws(() => required.write(path.join(root, 'new.json'), state), /locked/);
  assert.ok(!fs.existsSync(path.join(root, 'new.json')), 'desktop missing key never falls back to plaintext');
  console.log('connector-vault: PASS (AES-GCM, restart, tampering, missing/wrong key, migration failure, recovery, removal, no plaintext fallback)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
