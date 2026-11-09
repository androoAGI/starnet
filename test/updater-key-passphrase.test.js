#!/usr/bin/env node
'use strict';
/* GHSA-2hpj #7 (0.15.1): the updater signing key gets a passphrase. scripts/updater-key-passphrase.mjs
   re-seals the SAME key (same key id, same public key, so every installed app keeps accepting updates)
   under a new passphrase, writes <key>.new, never overwrites, and proves the result with Tauri's own
   signer. This locks the format math (libsodium pickparams), the refusals, and, when the repo's Tauri
   CLI is installed, real interop on a key Tauri itself generated for this test. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'scripts', 'updater-key-passphrase.mjs');
const CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const { pickScryptParams, parseSecretKeyFile, openSecretKey, sealSecretKey } = require(TOOL);
const { parsePublicKey, resolvePubkeyText } = require('../scripts/minisign-verify.mjs');

// 1. scrypt parameters exactly as libsodium's crypto_pwhash_scryptsalsa208sha256 picks them
assert.deepEqual(pickScryptParams(1048576n, 33554432n), { N: 32768, r: 8, p: 1 }, 'rsign defaults (what Tauri writes)');
assert.deepEqual(pickScryptParams(524288, 16777216), { N: 16384, r: 8, p: 1 }, 'libsodium interactive limits');
assert.deepEqual(pickScryptParams(33554432, 1073741824), { N: 1048576, r: 8, p: 1 }, 'libsodium sensitive limits');
assert.deepEqual(pickScryptParams(100000, 1073741824), { N: 2048, r: 8, p: 1 }, 'ops-bound branch');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-rekey-test-'));
const haveTauri = fs.existsSync(CLI);
const keyFile = path.join(dir, 'starnet-updater.key');
let pubText;

try {
  if (haveTauri) {
    const gen = spawnSync(process.execPath, [CLI, 'signer', 'generate', '--ci', '-w', keyFile],
      { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { CI: 'true' }), timeout: 120000 });
    assert.equal(gen.status, 0, 'Tauri generated a fixture key: ' + (gen.stderr || gen.stdout));
    pubText = fs.readFileSync(keyFile + '.pub', 'utf8');
  } else {
    // Same format built here (Tauri's checksum is not this tool's concern; its Tauri proof is skipped without the CLI).
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const keyId = crypto.randomBytes(8);
    const limits = Buffer.alloc(16);
    limits.writeBigUInt64LE(1048576n, 0);
    limits.writeBigUInt64LE(33554432n, 8);
    const skeleton = {
      lines: ['untrusted comment: rsign encrypted secret key', '', ''],
      header: Buffer.from('EdScB2', 'latin1'), limits, opslimit: 1048576n, memlimit: 33554432n,
    };
    fs.writeFileSync(keyFile, sealSecretKey(skeleton, Buffer.concat([keyId, seed, pub, Buffer.alloc(32)]), ''));
    pubText = 'untrusted comment: minisign public key (test)\n' + Buffer.concat([Buffer.from('Ed'), keyId, pub]).toString('base64') + '\n';
    fs.writeFileSync(keyFile + '.pub', pubText);
  }
  const pub = parsePublicKey(pubText);
  const original = fs.readFileSync(keyFile);
  const NEW = 'fixture passphrase ' + crypto.randomBytes(6).toString('hex');

  const run = (extra, env) => spawnSync(process.execPath, [TOOL, '--key', keyFile, '--pubkey', keyFile + '.pub'].concat(extra || []), {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
    env: Object.assign({}, process.env, { STARNET_REKEY_OLD_PASSWORD: '', STARNET_REKEY_NEW_PASSWORD: NEW }, env || {}),
  });

  // 2. the happy path: same key, new passphrase, original untouched, passphrase never printed
  const ok = run();
  const okText = ok.stdout + ok.stderr;
  assert.equal(ok.status, 0, okText);
  assert.match(okText, /ok: the current passphrase opens the trusted key/);
  assert.match(okText, /old password no longer opens it/);
  if (haveTauri) assert.match(okText, /Tauri's own signer signed a test file with it, and the signature verifies against the trusted key/);
  assert.ok(!okText.includes(NEW), 'the passphrase never appears in the output');
  assert.ok(fs.readFileSync(keyFile).equals(original), 'the original key file is untouched');
  const before = openSecretKey(parseSecretKeyFile(original.toString('utf8')), '', pub);
  const resealed = parseSecretKeyFile(fs.readFileSync(keyFile + '.new', 'utf8'));
  const after = openSecretKey(resealed, NEW, pub);
  assert.ok(before && after && after.equals(before), 'the new file holds the very same secret key');
  assert.equal(openSecretKey(resealed, '', pub), null, 'the old (empty) password no longer opens the new file');
  assert.ok(!resealed.salt.equals(parseSecretKeyFile(original.toString('utf8')).salt), 'a fresh salt');

  if (haveTauri) {
    const probe = path.join(dir, 'probe.bin');
    fs.writeFileSync(probe, crypto.randomBytes(512));
    const empty = spawnSync(process.execPath, [CLI, 'signer', 'sign', '--private-key-path', keyFile + '.new', '--password=', probe],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
        env: Object.assign({}, process.env, { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: undefined }) });
    assert.notEqual(empty.status, 0, 'Tauri refuses the re-sealed key with an empty password');
    assert.match(empty.stdout + empty.stderr, /Wrong password/i, 'and says so at once (no stall)');
  }

  // --check changes nothing and proves the new passphrase (and only it) opens the new file
  const checkRun = (password) => spawnSync(process.execPath, [TOOL, '--check', '--key', keyFile + '.new', '--pubkey', keyFile + '.pub'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    env: Object.assign({}, process.env, { STARNET_REKEY_OLD_PASSWORD: password }),
  });
  const checked = checkRun(NEW);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /ok: the passphrase opens the key installed apps trust/);
  if (haveTauri) assert.match(checked.stdout, /Tauri's own signer signed a test file/);
  assert.equal(checkRun('').status, 1, '--check refuses the old empty password on the new file');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['probe.bin', 'starnet-updater.key', 'starnet-updater.key.new', 'starnet-updater.key.pub'].filter(f => haveTauri || f !== 'probe.bin'),
    '--check wrote nothing');

  // 3. refusals: nothing is written
  const again = run();
  assert.equal(again.status, 1);
  assert.match(again.stderr, /never overwrites a key file/);

  const shortOut = path.join(dir, 'short.key');
  const short = run(['--out', shortOut], { STARNET_REKEY_NEW_PASSWORD: 'too short' });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /shorter than 12 characters; nothing was written/);
  assert.ok(!fs.existsSync(shortOut));

  const wrongOut = path.join(dir, 'wrong.key');
  const wrong = run(['--out', wrongOut], { STARNET_REKEY_OLD_PASSWORD: 'not the password' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not open this file to the key installed apps trust/);
  assert.ok(!fs.existsSync(wrongOut));

  const otherOut = path.join(dir, 'other.key');
  const other = spawnSync(process.execPath, [TOOL, '--key', keyFile, '--out', otherOut, '--pubkey', resolvePubkeyText('', ROOT)], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    env: Object.assign({}, process.env, { STARNET_REKEY_OLD_PASSWORD: '', STARNET_REKEY_NEW_PASSWORD: NEW }),
  });
  assert.equal(other.status, 1, 'a key that is not the one installed apps trust is refused');
  assert.match(other.stderr, /does not open this file to the key installed apps trust/);
  assert.ok(!fs.existsSync(otherOut));

  console.log('updater-key-passphrase.test: OK (' + (haveTauri ? 'real Tauri key + Tauri signer interop' : 'JS-built key; Tauri CLI not installed') + ')');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
