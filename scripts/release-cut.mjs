#!/usr/bin/env node
/*
 * release-cut.mjs — one-command desktop release cutter for StarNet.
 *
 * Goes trunk -> signed NSIS installer + updater .sig + latest.json staged in release/,
 * then prints the exact upload checklist for the public GitHub Releases channel.
 *
 * WHY THIS SCRIPT EXISTS (the gotchas it encodes so a human never re-derives them):
 *
 *  1. SIGNING STALL (the reason 0.1.7 shipped with createUpdaterArtifacts:false).
 *     The updater private key at ~/.tauri/starnet-updater.key is an rsign ENCRYPTED
 *     secret key. A signer given NO password blocks on an invisible interactive prompt,
 *     and older Tauri CLIs treated an empty password in the environment as absent. Build
 *     the NSIS installer with updater-artifact generation disabled for that invocation,
 *     then sign the final installer explicitly with `tauri signer sign`. Since 0.15.1 the
 *     key has a passphrase (GHSA-2hpj #7): it comes from TAURI_SIGNING_PRIVATE_KEY_PASSWORD
 *     or, failing that, a no-echo prompt at the START of the cut (not after a 30-minute
 *     build), and reaches the signer through its environment only. With no passphrase
 *     entered the signer gets an explicit `--password=` and a passphrase-protected key
 *     fails at once with "Wrong password" instead of stalling. The private key stays in
 *     its file; neither it nor the passphrase appears in argv or logs. createUpdaterArtifacts remains TRUE in
 *     tauri.conf.json as the release-policy assertion; only this bounded build invocation
 *     is overridden because the explicit signing step produces the required .sig.
 *
 *  2. E0463 ctor_proc_macro — a cargo parallel-build race in the `ctor` proc-macro crates.
 *     We pre-build the ctor crates single-threaded before the full desktop build so the
 *     race never fires. (--pre-build-ctor, on by default.)
 *
 *  3. The endpoint is a PUBLIC GitHub Releases "latest" asset. The manifest's per-platform
 *     `url` must point at the versioned installer asset on that same release, and the
 *     signature must be the freshly-produced .sig (a .sig older than its installer is
 *     rejected downstream by the T1/T5 gates).
 *
 * USAGE:
 *   node scripts/release-cut.mjs [--notes-file RELEASE_NOTES.md] [--skip-build] [--dry-run]
 *
 * Env overrides:
 *   STARNET_UPDATER_KEY_FILE   default: %USERPROFILE%/.tauri/starnet-updater.key
 *   STARNET_RELEASES_REPO      default: androoAGI/starnet-releases
 */

import {
  copyFileSync, existsSync, mkdirSync, readFileSync,
  statSync, writeFileSync, rmSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedCommand } from './lib/run-command.mjs';
import { findVersionedNsisInstaller } from './lib/release-installer.mjs';
import { resolvePubkeyText, verifySignature } from './minisign-verify.mjs';
import { canPromptHidden, promptHidden } from './lib/hidden-prompt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argSet = new Set(args);
function argVal(name, dflt) {
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return dflt;
}

const DRY_RUN = argSet.has('--dry-run');
const SKIP_BUILD = argSet.has('--skip-build');
const PRE_BUILD_CTOR = !argSet.has('--no-pre-build-ctor');
const NOTES_FILE = argVal('--notes-file', join(ROOT, 'RELEASE_NOTES.md'));
const RELEASES_REPO = process.env.STARNET_RELEASES_REPO || 'androoAGI/starnet-releases';
const KEY_FILE = process.env.STARNET_UPDATER_KEY_FILE || join(homedir(), '.tauri', 'starnet-updater.key');
const PLATFORM = 'windows-x86_64';

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write('release-cut: ' + msg + '\n'); process.exit(1); }
function readText(f) { return readFileSync(f, 'utf8').replace(/^﻿/, ''); }
function readJson(f) { return JSON.parse(readText(f)); }
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

function tauriVersion() {
  return readJson(join(ROOT, 'src-tauri', 'tauri.conf.json')).version;
}
function cargoVersion() {
  const m = readText(join(ROOT, 'src-tauri', 'Cargo.toml')).match(/^\s*version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : '';
}
function cargoLockVersion() {
  const m = readText(join(ROOT, 'src-tauri', 'Cargo.lock')).match(/name = "skynet-desktop"\r?\nversion = "([^"]+)"/);
  return m ? m[1] : '';
}
function releaseVersions() {
  const pkg = readJson(join(ROOT, 'package.json'));
  const lock = readJson(join(ROOT, 'package-lock.json'));
  return {
    packageJson: String(pkg.version || ''),
    packageLock: String(lock.version || ''),
    packageLockRoot: String((lock.packages && lock.packages[''] && lock.packages[''].version) || ''),
    tauri: tauriVersion(),
    cargo: cargoVersion(),
    cargoLock: cargoLockVersion()
  };
}
function updaterEndpoint() {
  const conf = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'));
  const eps = conf.plugins && conf.plugins.updater && conf.plugins.updater.endpoints;
  return (eps && eps[0]) || '';
}
function createUpdaterArtifacts() {
  const conf = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'));
  return !!(conf.bundle && conf.bundle.createUpdaterArtifacts);
}

async function preflight() {
  const versions = releaseVersions();
  const version = versions.tauri;
  log('== Preflight ==');
  log('  package.json version    : ' + versions.packageJson);
  log('  package-lock version    : ' + versions.packageLock + ' (root ' + versions.packageLockRoot + ')');
  log('  tauri.conf.json version : ' + versions.tauri);
  log('  Cargo.toml version      : ' + versions.cargo);
  log('  Cargo.lock version      : ' + versions.cargoLock);
  log('  updater endpoint        : ' + updaterEndpoint());
  log('  createUpdaterArtifacts  : ' + createUpdaterArtifacts());
  log('  releases repo           : ' + RELEASES_REPO);
  log('  updater key             : ' + KEY_FILE + (existsSync(KEY_FILE) ? ' (present)' : ' (MISSING)'));

  if (!version) fail('tauri.conf.json has no version');
  const mismatched = Object.entries(versions).filter(([, value]) => value !== version);
  if (mismatched.length) {
    fail('release version pins disagree with tauri.conf.json (' + version + '): '
      + mismatched.map(([name, value]) => name + '=' + (value || '(missing)')).join(', ')
      + '. Run release:bump; never name an installer from a partial version bump.');
  }
  if (!createUpdaterArtifacts()) fail('bundle.createUpdaterArtifacts is false — the updater REQUIRES the .sig. Re-enable it.');
  const ep = updaterEndpoint();
  if (!/^https:\/\/github\.com\/.+\/releases\/latest\/download\/latest\.json$/.test(ep)) {
    fail('updater endpoint is not a GitHub Releases latest.json URL: ' + ep);
  }
  if (!SKIP_BUILD && !existsSync(KEY_FILE)) {
    fail('updater private key not found at ' + KEY_FILE + ' — cannot sign. Set STARNET_UPDATER_KEY_FILE.');
  }
  return version;
}

async function runStep(label, cmd, extraArgs, env) {
  log('\n== ' + label + ' ==');
  if (DRY_RUN) { log('  [dry-run] would run: ' + cmd + ' ' + (extraArgs || []).join(' ')); return { exitCode: 0, output: '' }; }
  const commandEnv = Object.assign({}, process.env, env || {});
  for (const [key, value] of Object.entries(commandEnv)) {
    if (value == null) delete commandEnv[key];
  }
  const res = await runBoundedCommand({
    cmd, args: extraArgs || [], cwd: ROOT, inherit: true,
    env: commandEnv,
    timeoutMs: 1800000, label
  });
  if (res.exitCode !== 0) fail(label + ' failed (exit ' + res.exitCode + ')');
  return res;
}

// The updater key passphrase: the environment first, else a no-echo prompt, else none (a key
// that has one then fails fast with "Wrong password"). Asked before the long build, never logged.
async function updaterKeyPassword() {
  const fromEnv = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (fromEnv) return fromEnv;
  if (DRY_RUN || SKIP_BUILD || !canPromptHidden()) return '';
  return promptHidden('Updater key passphrase (press Enter if the key has none): ');
}

async function main() {
  const version = await preflight();
  const keyPassword = await updaterKeyPassword();

  if (!SKIP_BUILD) {
    // Gotcha #2: pre-build the ctor proc-macro crates single-threaded to dodge the E0463 race.
    if (PRE_BUILD_CTOR) {
      await runStep('Pre-build ctor crates (E0463 race guard)', 'cargo',
        ['build', '--release', '-j', '1', '-p', 'ctor', '-p', 'ctor-proc-macro',
         '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml')],
        {}).catch(() => log('  (ctor pre-build best-effort; continuing)'));
    }
    // Do not let `tauri build` reach its interactive empty-password prompt. The final
    // installer is signed explicitly below, after NSIS has finished writing it.
    const unsignedBuildOverride = join(ROOT, 'scripts', 'release-unsigned-updater.conf.json');
    await runStep('desktop:build (NSIS; explicit updater signing follows)', 'npm',
      ['run', 'desktop:build', '--', '--config', unsignedBuildOverride], {});
  } else {
    log('\n== --skip-build: using existing artifacts ==');
  }

  // Locate the produced artifacts.
  const nsisDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const installer = DRY_RUN
    ? join(nsisDir, 'StarNet_' + version + '_x64-setup.exe')
    : findVersionedNsisInstaller(nsisDir, version);
  if (!DRY_RUN && !installer) {
    fail('expected installer not found: ' + join(nsisDir, 'StarNet_' + version + '_x64-setup.exe')
      + ' (refusing to select a stale installer for another version)');
  }

  if (!SKIP_BUILD) {
    const tauriCli = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    // A passphrase reaches the signer through its environment only (argv is visible to every
    // process on the machine). With none, the explicit `--password=` is authoritative.
    const passwordArgs = keyPassword ? [] : ['--password='];
    await runStep(keyPassword ? 'Sign updater installer (passphrase from the environment or prompt)'
      : 'Sign updater installer (no passphrase entered: explicit empty password)', 'node', [
      tauriCli, 'signer', 'sign', '--private-key-path', KEY_FILE, ...passwordArgs, installer
    ], {
      // Explicit arguments are authoritative. Legacy shells may still carry these vars;
      // inheriting them makes the CLI reject the duplicate private-key source.
      TAURI_SIGNING_PRIVATE_KEY: null,
      TAURI_SIGNING_PRIVATE_KEY_PATH: null,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPassword || null
    });
  }

  const sig = installer + '.sig';
  if (!DRY_RUN && !existsSync(sig)) {
    fail('updater signature missing: ' + sig + '\n  This is the createUpdaterArtifacts / signing-stall failure. ' +
      'Confirm the updater key file is readable and createUpdaterArtifacts:true.');
  }
  if (!DRY_RUN) {
    const sigAge = statSync(sig).mtimeMs;
    const exeAge = statSync(installer).mtimeMs;
    if (sigAge < exeAge - 1000) fail('.sig is older than the installer — stale signature. Rebuild.');

    /* CRYPTOGRAPHICALLY VERIFY THE SIGNATURE, against the pubkey every INSTALLED app trusts.
       Existence + mtime freshness say a .sig file is there and recent; they cannot say it was made with the
       right KEY. A cut with the wrong updater private key (a restored/regenerated
       ~/.tauri/starnet-updater.key, or STARNET_UPDATER_KEY_FILE pointing at a different file) passed T1
       signing, T5 public-distribution and verify-update-host completely green, published, and then hard-failed
       the update for EVERY installed app — the exact failure minisign-verify.mjs was written to prevent, and
       whose own header names this gap. The fix was wired into ONE producer (release-assemble-manifest, the CI
       train + canary) and not into this one, which is the local one-command Windows cutter the launch checklist
       says to run LAST, immediately before upload. Downstream cannot save it either: t5 only text-compares the
       manifest against the .sig, t1 checks existsSync + mtime, verify-update-host checks length > 40. */
    try {
      const pubkeyText = resolvePubkeyText(argVal('--pubkey', ''), ROOT);
      const v = verifySignature(readFileSync(installer), readText(sig), pubkeyText);
      if (!v.ok) {
        fail('UPDATER SIGNATURE DOES NOT VERIFY against the public key baked into src-tauri/tauri.conf.json:' +
          '\n  ' + v.reason +
          '\n  Publishing this would hard-fail the update for EVERY installed app.' +
          '\n  Re-sign with the release updater key (~/.tauri/starnet-updater.key or STARNET_UPDATER_KEY_FILE) and cut again.');
      }
      log('  updater signature VERIFIED against the baked pubkey (' + (v.alg || 'ed') + ')');
    } catch (e) {
      fail('could not verify the updater signature: ' + ((e && e.message) || e) +
        '\n  A cut that cannot prove its signature must not be published.');
    }
  }

  // Stage into release/ and build latest.json pointing at the GitHub Releases asset.
  const releaseDir = join(ROOT, 'release');
  mkdirSync(releaseDir, { recursive: true });
  const installerName = DRY_RUN ? ('StarNet_' + version + '_x64-setup.exe') : installer.split(/[\\/]/).pop();
  const assetBase = 'https://github.com/' + RELEASES_REPO + '/releases/download/v' + version + '/';
  const installerUrl = assetBase + installerName;

  const notes = existsSync(NOTES_FILE) ? readText(NOTES_FILE).trim()
    : 'StarNet desktop ' + version + '. See the release page for details.';

  let signature = 'DRY-RUN-NO-SIG';
  if (!DRY_RUN) {
    copyFileSync(installer, join(releaseDir, installerName));
    copyFileSync(sig, join(releaseDir, installerName + '.sig'));
    signature = readText(sig).trim();
  }

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { [PLATFORM]: { signature, url: installerUrl } }
  };
  const manifestPath = join(releaseDir, 'latest.json');
  if (!DRY_RUN) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // Checklist.
  log('\n============================================================');
  log(' RELEASE CUT COMPLETE — v' + version);
  log('============================================================');
  if (!DRY_RUN) {
    log(' Staged in release/:');
    log('   - ' + installerName + '   (sha256 ' + sha256(installer).slice(0, 16) + '...)');
    log('   - ' + installerName + '.sig');
    log('   - latest.json');
  } else {
    log(' [dry-run] no artifacts staged.');
  }
  log('');
  log(' UPLOAD CHECKLIST (publish binaries to the dedicated public releases repo):');
  log('   Repo   : https://github.com/' + RELEASES_REPO);
  log('   1. Create a GitHub Release, tag it EXACTLY:  v' + version);
  log('   2. Attach these THREE assets to that release:');
  log('        release/' + installerName);
  log('        release/' + installerName + '.sig');
  log('        release/latest.json');
  log('   3. Publish the release (not a draft — "latest/download" only resolves for published releases).');
  log('   4. The updater endpoint is:');
  log('        https://github.com/' + RELEASES_REPO + '/releases/latest/download/latest.json');
  log('      GitHub redirects "latest" to the newest published release, so no manifest edit is');
  log('      needed for the endpoint — but the installer URL inside latest.json is pinned to');
  log('      the v' + version + ' tag, so the tag MUST be exactly v' + version + '.');
  log('   5. Prove it live:  node scripts/verify-update-host.mjs');
  log('   6. Unattended update proof: launch an OLDER installed StarNet, open System -> Updates,');
  log('      confirm it sees v' + version + ', downloads, verifies the signature, and installs.');
  log('============================================================');
}

main().catch(e => fail((e && e.stack) || String(e)));
