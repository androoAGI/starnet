#!/usr/bin/env node
/*
 * updater-key-passphrase.mjs — put a passphrase on (or change the passphrase of) the updater
 * signing key WITHOUT changing the key itself.
 *
 * Every installed StarNet trusts ONE updater public key (tauri.conf.json plugins.updater.pubkey).
 * The private key file ~/.tauri/starnet-updater.key is an rsign/minisign secret key whose secret
 * part is encrypted under a password through scrypt. Until 0.15.1 that password was empty, so
 * anyone who copied the file could sign updates every install would accept (GHSA-2hpj #7; Andrew
 * chose a passphrase on 2026-11-09). This tool re-encrypts the SAME secret key under a new
 * passphrase: same key id, same public key, so installed apps keep accepting updates.
 *
 * It never overwrites the input. It writes <key>.new, and before it exits it proves:
 *   1. the current password opened the key to exactly the key installed apps trust (key id, the
 *      stored public half, and the public key DERIVED from the secret seed all match the pubkey);
 *   2. the new file opens with the new passphrase to the same bytes and does NOT open with the
 *      old password;
 *   3. (when the repo's Tauri CLI is installed) Tauri's own signer signs a probe file with the new
 *      file and passphrase, and scripts/minisign-verify.mjs verifies that signature against the
 *      public key installed apps trust.
 * Passphrases are read from the terminal with echo off. They never appear in argv, logs or files.
 *
 * USAGE:
 *   node scripts/updater-key-passphrase.mjs [--key <file>] [--out <file>] [--pubkey <base64-or-path>]
 *   node scripts/updater-key-passphrase.mjs --check [--key <file>] [--pubkey <base64-or-path>]
 *     --check   change nothing: prove the passphrase opens the trusted key and Tauri signs with it
 *     --key     default: STARNET_UPDATER_KEY_FILE, else %USERPROFILE%/.tauri/starnet-updater.key
 *     --out     default: <key>.new (an existing file is refused, never overwritten)
 *     --pubkey  default: src-tauri/tauri.conf.json plugins.updater.pubkey
 *   Tests only: when stdin is not a terminal, STARNET_REKEY_OLD_PASSWORD and
 *   STARNET_REKEY_NEW_PASSWORD supply the two passwords.
 *
 * FORMAT (rsign2 / rust-minisign secret key, as Tauri writes it):
 *   file      = base64( "untrusted comment: rsign encrypted secret key\n" + base64(158 bytes) + "\n" )
 *   158 bytes = "Ed" | "Sc" (scrypt) | "B2" (blake2b checksum) | salt(32) | opslimit u64le
 *               | memlimit u64le | sealed(104) = keyId(8) | ed25519 secret(64 = seed 32 + public 32)
 *               | checksum(32)
 *   sealed    = plaintext XOR scrypt(password, salt, 104) with N, r, p picked from opslimit and
 *               memlimit exactly as libsodium's pickparams does (rsign's defaults give 2^15, 8, 1).
 *   The checksum sits inside the sealed part and covers the plaintext, so it carries over as is.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, scryptSync } from 'node:crypto';
import { parsePublicKey, resolvePubkeyText, verifySignature } from './minisign-verify.mjs';
import { canPromptHidden, promptHidden } from './lib/hidden-prompt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEALED_LEN = 104;
const RAW_LEN = 6 + 32 + 8 + 8 + SEALED_LEN;
const MIN_PASSPHRASE = 12;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function pickScryptParams(opslimitIn, memlimitIn) {
  // libsodium crypto_pwhash_scryptsalsa208sha256 pickparams, in BigInt so u64 limits stay exact.
  let opslimit = BigInt(opslimitIn);
  const memlimit = BigInt(memlimitIn);
  if (opslimit < 32768n) opslimit = 32768n;
  const r = 8n;
  let p;
  let nLog2;
  const firstAbove = (maxN) => {
    let n = 1n;
    for (; n < 63n; n += 1n) if ((1n << n) > maxN / 2n) break;
    return n;
  };
  if (opslimit < memlimit / 32n) {
    p = 1n;
    nLog2 = firstAbove(opslimit / (r * 4n));
  } else {
    nLog2 = firstAbove(memlimit / (r * 128n));
    let maxrp = (opslimit / 4n) / (1n << nLog2);
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  return { N: Number(1n << nLog2), r: Number(r), p: Number(p) };
}

export function parseSecretKeyFile(fileText) {
  const doc = Buffer.from(String(fileText).trim(), 'base64').toString('utf8');
  const lines = doc.split('\n');
  if (!/^untrusted comment:/i.test(lines[0] || '')) throw new Error('not a Tauri updater secret key file (no untrusted comment)');
  const keyLine = (lines[1] || '').trim();
  const raw = Buffer.from(keyLine, 'base64');
  if (raw.length !== RAW_LEN) throw new Error('secret key line decodes to ' + raw.length + ' bytes (want ' + RAW_LEN + ')');
  const sigAlg = raw.subarray(0, 2).toString('latin1');
  const kdfAlg = raw.subarray(2, 4).toString('latin1');
  const chkAlg = raw.subarray(4, 6).toString('latin1');
  if (sigAlg !== 'Ed') throw new Error('unsupported signature algorithm "' + sigAlg + '"');
  if (kdfAlg !== 'Sc') throw new Error('unsupported key protection "' + JSON.stringify(kdfAlg) + '" (want scrypt "Sc")');
  if (chkAlg !== 'B2') throw new Error('unsupported checksum algorithm "' + chkAlg + '"');
  return {
    lines,
    keyLine,
    header: raw.subarray(0, 6),
    salt: raw.subarray(6, 38),
    opslimit: raw.readBigUInt64LE(38),
    memlimit: raw.readBigUInt64LE(46),
    limits: raw.subarray(38, 54),
    sealed: raw.subarray(54, 54 + SEALED_LEN),
  };
}

function stream(password, salt, opslimit, memlimit) {
  const { N, r, p } = pickScryptParams(opslimit, memlimit);
  return scryptSync(Buffer.from(String(password), 'utf8'), salt, SEALED_LEN, { N, r, p, maxmem: 256 * N * r + 1048576 });
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function derivedPublic(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
}

// Opens the sealed part with `password` and returns the plaintext only if it is exactly the key
// `pub` describes; otherwise null (wrong password or a different key).
export function openSecretKey(parsed, password, pub) {
  const plain = xor(parsed.sealed, stream(password, parsed.salt, parsed.opslimit, parsed.memlimit));
  const keyId = plain.subarray(0, 8);
  const seed = plain.subarray(8, 40);
  const storedPublic = plain.subarray(40, 72);
  if (!keyId.equals(pub.keyId) || !storedPublic.equals(pub.publicKey)) { plain.fill(0); return null; }
  if (!derivedPublic(seed).equals(pub.publicKey)) { plain.fill(0); return null; }
  return plain;
}

export function sealSecretKey(parsed, plain, newPassword) {
  const salt = randomBytes(32);
  const sealed = xor(plain, stream(newPassword, salt, parsed.opslimit, parsed.memlimit));
  const raw = Buffer.concat([parsed.header, salt, parsed.limits, sealed]);
  const lines = parsed.lines.slice();
  lines[1] = raw.toString('base64');
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

function argValue(args, name) {
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

async function readPassword(question, envName) {
  if (canPromptHidden()) return promptHidden(question);
  if (process.env[envName] !== undefined) return process.env[envName];
  throw new Error('run this in an interactive terminal: it asks for the passphrases with echo off');
}

function tauriSignerProof(outFile, newPassword, pubkeyText) {
  const cli = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!existsSync(cli)) return { ran: false, why: 'the repo Tauri CLI is not installed (npm ci), so Tauri\'s own signer was not tried' };
  const dir = mkdtempSync(join(tmpdir(), 'starnet-rekey-proof-'));
  try {
    const probe = join(dir, 'probe.bin');
    writeFileSync(probe, randomBytes(4096));
    const env = Object.assign({}, process.env, { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: newPassword });
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    const res = spawnSync(process.execPath, [cli, 'signer', 'sign', '--private-key-path', outFile, probe],
      { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    if (res.status !== 0 || !existsSync(probe + '.sig')) {
      throw new Error('Tauri\'s signer could not sign with the new file and passphrase (exit ' + res.status + ')');
    }
    const verdict = verifySignature(readFileSync(probe), readFileSync(probe + '.sig', 'utf8'), pubkeyText);
    if (!verdict.ok) throw new Error('the probe signature does not verify against the trusted public key: ' + verdict.reason);
    return { ran: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function check(keyFile, pubkeyText, pub) {
  const parsed = parseSecretKeyFile(readFileSync(keyFile, 'utf8'));
  console.log('Updater key : ' + keyFile + ' (check only; nothing is written)');
  const password = await readPassword('Passphrase: ', 'STARNET_REKEY_OLD_PASSWORD');
  const plain = openSecretKey(parsed, password, pub);
  if (!plain) throw new Error('that passphrase does not open this file to the key installed apps trust');
  plain.fill(0);
  console.log('  ok: the passphrase opens the key installed apps trust');
  const proof = tauriSignerProof(keyFile, password, pubkeyText);
  console.log(proof.ran
    ? "  ok: Tauri's own signer signed a test file with it, and the signature verifies against the trusted key"
    : '  note: ' + proof.why);
}

async function main() {
  const args = process.argv.slice(2);
  const keyFile = resolve(argValue(args, '--key') || process.env.STARNET_UPDATER_KEY_FILE ||
    join(homedir(), '.tauri', 'starnet-updater.key'));
  const outFile = resolve(argValue(args, '--out') || keyFile + '.new');
  const pubkeyText = resolvePubkeyText(argValue(args, '--pubkey'), ROOT);
  const pub = parsePublicKey(pubkeyText);

  if (!existsSync(keyFile)) throw new Error('no updater key at ' + keyFile);
  if (args.includes('--check')) return check(keyFile, pubkeyText, pub);
  if (existsSync(outFile)) throw new Error(outFile + ' already exists; move it away first (this tool never overwrites a key file)');
  const parsed = parseSecretKeyFile(readFileSync(keyFile, 'utf8'));

  console.log('Updater key : ' + keyFile);
  console.log('Trusted key : id ' + Buffer.from(pub.keyId).reverse().toString('hex').toUpperCase() + ' (what installed apps check)');

  const oldPassword = await readPassword('Current passphrase (just press Enter if it has none): ', 'STARNET_REKEY_OLD_PASSWORD');
  const plain = openSecretKey(parsed, oldPassword, pub);
  if (!plain) throw new Error('that passphrase does not open this file to the key installed apps trust (wrong passphrase, or a different key)');
  console.log('  ok: the current passphrase opens the trusted key');

  const newPassword = await readPassword('New passphrase (at least ' + MIN_PASSPHRASE + ' characters): ', 'STARNET_REKEY_NEW_PASSWORD');
  if (Array.from(newPassword).length < MIN_PASSPHRASE) throw new Error('the new passphrase is shorter than ' + MIN_PASSPHRASE + ' characters; nothing was written');
  if (newPassword === oldPassword) throw new Error('the new passphrase is the same as the current one; nothing was written');
  if (canPromptHidden()) {
    const again = await promptHidden('Type the new passphrase again: ');
    if (again !== newPassword) throw new Error('the two entries differ; nothing was written');
  }

  const fileText = sealSecretKey(parsed, plain, newPassword);
  const reparsed = parseSecretKeyFile(fileText);
  const reopened = openSecretKey(reparsed, newPassword, pub);
  if (!reopened || !reopened.equals(plain)) throw new Error('self-check failed: the re-sealed key does not reopen to the same bytes; nothing was written');
  if (openSecretKey(reparsed, oldPassword, pub)) throw new Error('self-check failed: the old password still opens the new file; nothing was written');
  reopened.fill(0);
  plain.fill(0);

  writeFileSync(outFile, fileText, { flag: 'wx' });
  console.log('  ok: wrote ' + outFile + ' (same key, new passphrase; the old password no longer opens it)');

  try {
    const proof = tauriSignerProof(outFile, newPassword, pubkeyText);
    console.log(proof.ran
      ? '  ok: Tauri\'s own signer signed a test file with it, and the signature verifies against the trusted key'
      : '  note: ' + proof.why);
  } catch (e) {
    rmSync(outFile, { force: true });
    throw new Error(e.message + '; the new file was removed and the original key is untouched');
  }

  console.log('\nThe original key file is untouched. Next steps: docs/RELEASE_RUNBOOK.md section 4.4.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    process.stderr.write('updater-key-passphrase: ' + (e && e.message || e) + '\n');
    process.exit(1);
  });
}
