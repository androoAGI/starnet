#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const packageVersion = require('../package.json').version;
const versionPattern = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A fixture key FILE (never real key material): --dry-run only proves the key path exists and
// prints the signing command; it never signs. Without this, the test needs the operator's real
// ~/.tauri key and goes red on any CI runner (v0.6.3 train run 4). Named starnet-updater.key so
// the printed-command assertions below still see the canonical filename.
const keyDir = mkdtempSync(join(tmpdir(), 'starnet-cut-key-'));
const keyFile = join(keyDir, 'starnet-updater.key');
writeFileSync(keyFile, 'dW50-fixture-not-a-real-key\n');
const result = spawnSync(process.execPath, [
  join(ROOT, 'scripts', 'release-cut.mjs'),
  '--dry-run',
  '--no-pre-build-ctor'
], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { STARNET_UPDATER_KEY_FILE: keyFile }) });

assert.equal(result.status, 0, result.stderr || result.stdout);
const output = result.stdout + result.stderr;
assert.match(output, /desktop:build .*explicit updater signing follows/i);
assert.match(output, /--config .*release-unsigned-updater\.conf\.json/i);
assert.match(output, /signer sign --private-key-path .*starnet-updater\.key --password=/i);
assert.doesNotMatch(output, /TAURI_SIGNING_PRIVATE_KEY\s*=/,
  'the release cutter must not put raw private-key contents in its command output');
assert.match(output, new RegExp('package\\.json version\\s+: ' + versionPattern),
  'preflight proves the public package version instead of checking only Tauri/Cargo');
assert.match(output, new RegExp('package-lock version\\s+: ' + versionPattern + ' \\(root ' + versionPattern + '\\)'),
  'preflight proves both package-lock version pins');
assert.match(output, new RegExp('Cargo\\.lock version\\s+: ' + versionPattern),
  'preflight proves the app package pin in Cargo.lock');

const source = readFileSync(join(ROOT, 'scripts', 'release-cut.mjs'), 'utf8');
assert.match(source, /TAURI_SIGNING_PRIVATE_KEY:\s*null/,
  'explicit path signing must remove a legacy inline key from the child environment');
assert.match(source, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*keyPassword \|\| null/,
  'with no passphrase entered, a legacy password variable is removed from the signer environment');
assert.match(source, /const passwordArgs = keyPassword \? \[\] : \['--password='\]/,
  'a passphrase never goes on the signer command line; without one the empty password is explicit (no stall)');
assert.match(source, /const version = await preflight\(\);\s+const keyPassword = await updaterKeyPassword\(\);/,
  'the passphrase is asked before the long build, not after it');

/* GHSA-2hpj #7 (0.15.1): the updater key has a passphrase. Given through the environment, it reaches the
   signer through the environment only: the printed command has no --password and never the value. */
{
  const secret = 'fixture-passphrase-' + Date.now();
  const withPass = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'release-cut.mjs'), '--dry-run', '--no-pre-build-ctor'
  ], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, {
    STARNET_UPDATER_KEY_FILE: keyFile, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: secret }) });
  assert.equal(withPass.status, 0, withPass.stderr || withPass.stdout);
  const text = withPass.stdout + withPass.stderr;
  assert.match(text, /signer sign --private-key-path .*starnet-updater\.key \S*setup\.exe/i,
    'with a passphrase the signing command goes straight from the key path to the installer');
  assert.doesNotMatch(text, /--password/, 'no password flag when the passphrase comes from the environment');
  assert.ok(!text.includes(secret), 'the passphrase never appears in the cutter output');
}
assert.match(source, /Object\.entries\(versions\).*value !== version/,
  'the release cutter fails closed when any of the five release pins disagree');
assert.match(source, /findVersionedNsisInstaller\(nsisDir, version\)/,
  'artifact discovery is explicitly bound to the release version');
assert.match(source, /from '\.\/lib\/release-installer\.mjs'/,
  'artifact discovery uses the shared exact-version release helper');
assert.ok(!source.includes("filter(n => /-setup\\.exe$/i.test(n)).sort()"),
  'artifact discovery must never choose the lexicographically-last stale installer');
assert.match(source, /refusing to select a stale installer for another version/,
  'a missing exact-version artifact fails the cut loudly');


/* ---- THE CUT MUST CRYPTOGRAPHICALLY VERIFY ITS OWN SIGNATURE -------------------------------------
   release-cut checked only that a .sig file EXISTS and is newer than the installer. Neither says it was
   made with the right KEY. A cut with the wrong updater private key (a restored/regenerated
   ~/.tauri/starnet-updater.key, or STARNET_UPDATER_KEY_FILE pointing elsewhere) passed T1 signing, T5
   public-distribution and verify-update-host completely green, published, and then hard-failed the update
   for EVERY installed app — the exact failure minisign-verify.mjs exists to prevent, and whose own header
   names this gap. It was wired into ONE producer (release-assemble-manifest, the CI train + canary) and not
   into this one: the local one-command Windows cutter the launch checklist says to run LAST, right before
   upload. Nothing downstream catches it — t5 text-compares the manifest against the .sig, t1 checks
   existsSync + mtime, verify-update-host checks length > 40.

   The non-dry path runs a real desktop build, so this replays the exact check with REAL crypto and locks
   that the cutter performs it — and performs it BEFORE staging anything into release/. */
{
  const { makeSigner } = require('./minisign-test-signer.js');
  const { verifySignature, resolvePubkeyText } = require('../scripts/minisign-verify.mjs');

  const installerBytes = Buffer.from('MZ fake installer bytes for the wrong-key proof');
  const wrongKey = makeSigner();
  const wrongSig = wrongKey.sign(installerBytes, { fileName: 'StarNet_0.0.0_x64-setup.exe' }).sigFileContent;

  // the pubkey EVERY installed app trusts — the one release-cut now resolves by default
  const bakedPubkey = resolvePubkeyText('', ROOT);
  const bad = verifySignature(installerBytes, wrongSig, bakedPubkey);
  assert.equal(bad.ok, false, 'a signature from a DIFFERENT key must not verify against the baked pubkey');
  assert.match(String(bad.reason), /key id mismatch|different key/i, 'and the reason names the key mismatch: ' + bad.reason);

  // the same bytes signed with the MATCHING key do verify — so the gate is not simply always-fail
  const good = verifySignature(installerBytes, wrongSig, wrongKey.pubkeyDoc);
  assert.equal(good.ok, true, 'the matching key verifies (the check is real, not a blanket refusal)');

  // ...and a signature over DIFFERENT bytes is caught too (a stale .sig beside a rebuilt installer)
  const stale = verifySignature(Buffer.concat([installerBytes, Buffer.from('rebuilt')]), wrongSig, wrongKey.pubkeyDoc);
  assert.equal(stale.ok, false, 'a .sig that does not cover these exact bytes is rejected');

  // the WIRING: the cutter imports the verifier, calls it, and does so BEFORE it stages the release
  assert.match(source, /import \{[^}]*verifySignature[^}]*\} from '\.\/minisign-verify\.mjs'/,
    'release-cut imports the real verifier');
  assert.match(source, /verifySignature\(readFileSync\(installer\), readText\(sig\), pubkeyText\)/,
    'and verifies the installer bytes against the resolved pubkey');
  const verifyAt = source.indexOf('verifySignature(readFileSync(installer)');
  const stageAt = source.indexOf('copyFileSync(installer, join(releaseDir, installerName))');
  assert.ok(verifyAt > 0 && stageAt > 0, 'both the verify and the staging step are present');
  assert.ok(verifyAt < stageAt, 'the signature is verified BEFORE anything is staged into release/');
  assert.match(source, /UPDATER SIGNATURE DOES NOT VERIFY/,
    'and a mismatch fails the cut loudly rather than publishing');
}

console.log('release-cut.test: OK (non-interactive explicit signing path)');
