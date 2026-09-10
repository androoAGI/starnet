'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const infoPlist = read('src-tauri/Info.plist');
const stage = read('scripts/stage-voice-deps.mjs');
const buildRs = read('src-tauri/build.rs');
const desktopCi = read('.github/workflows/desktop-build.yml');
const releaseCi = read('.github/workflows/release-train.yml');
const canary = read('scripts/update-canary.mjs');
const phase5Surface = read('scripts/phase5-surface-proof.mjs');

assert.equal(
  pkg.dependencies['ogg-opus-decoder'],
  '^1.7.3',
  'the packaged sidecar carries an in-process Telegram Ogg/Opus decoder'
);
assert.equal(pkg.overrides && pkg.overrides.sharp, '0.35.3',
  'both Transformers copies are forced onto the patched Sharp runtime');
const lockedSharp = Object.entries(lock.packages || {})
  .filter(([name]) => /(?:^|\/)node_modules\/sharp$/.test(name))
  .map(([, meta]) => meta && meta.version);
assert.ok(lockedSharp.length > 0 && lockedSharp.every(version => version === '0.35.3'),
  'the lockfile cannot restore a vulnerable Sharp below 0.35');

assert.match(
  pkg.scripts['desktop:build'],
  /prepare-node\.mjs[\s\S]*stage-voice-deps\.mjs[\s\S]*tauri build/,
  'a local desktop build stages the voice runtime before Tauri packages resources'
);
assert.equal(
  tauri.bundle.resources['voice-deps/node_modules'],
  'node_modules',
  'the staged runtime lands beside sidecar/ so ordinary Node resolution finds it'
);
assert.match(buildRs, /"voice-deps\/node_modules"/, 'Cargo treats the staged voice runtime as a shipped build input');

// WKWebView getUserMedia reaches the macOS microphone privacy boundary. Tauri merges
// src-tauri/Info.plist into the generated application bundle, and macOS refuses capture
// when this purpose string is absent. Keep the permission declaration coupled to the
// offline voice runtime so a packaged Mac build cannot silently ship a dead microphone.
assert.match(
  infoPlist,
  /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]*(?:microphone|voice)[^<]*<\/string>/i,
  'the macOS app bundle declares why StarNet requests microphone access'
);
assert.equal(tauri.bundle.macOS.hardenedRuntime, true);
assert.equal(tauri.bundle.macOS.entitlements, 'entitlements.plist');
assert.match(fs.readFileSync(path.join(root, 'src-tauri', tauri.bundle.macOS.entitlements), 'utf8'),
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/,
  'signed macOS builds authorize microphone input under hardened runtime');

for (const [name, source] of [['desktop CI', desktopCi], ['release CI', releaseCi]]) {
  assert.match(
    source,
    /prepare-node\.mjs \$\{\{ matrix\.target \}\}[\s\S]{0,160}stage-voice-deps\.mjs --target \$\{\{ matrix\.target \}\}/,
    name + ' stages the matching platform/architecture voice runtime'
  );
}
assert.match(canary, /stage-voice-deps\.mjs'\), '--target', 'win-x64'/, 'canary installers ship the same Windows voice engine');
assert.match(
  phase5Surface,
  /prepare-node\.mjs'[\s\S]*stage-voice-deps\.mjs --target win-x64'[\s\S]*tauri\) \+ ' build'/,
  'the Windows desktop evidence runner stages the native voice closure before its direct Tauri build'
);

assert.match(stage, /\^\(win\|darwin\|linux\)-\(x64\|arm64\)\$/, 'the staging script validates release target names');
assert.match(stage, /pruneOnnxBinaries\(dest\)/, 'foreign ONNX native binaries are removed from the staged closure');
assert.match(stage, /if \(!pruned\.kept\.length\)/, 'the build fails closed when no target ONNX runtime survives');
assert.match(stage, /for \(const dep of runtimeDeps\)/, 'every declared production dependency must exist in the staged tree');
assert.match(stage, /DROP_ANYWHERE = new Set\(\['onnxruntime-web', 'adm-zip'\]\)/, 'browser ONNX and the build-only ZIP downloader are not shipped in the Node sidecar bundle');
assert.match(stage, /build-only adm-zip leaked into the shipped runtime closure/, 'the build fails closed if the vulnerable postinstall-only ZIP package survives staging');
assert.match(stage, /function purgeStaleReleasePackages\(\)/, 'warm Tauri outputs are purged so removed packages cannot survive in a later installer');
assert.match(stage, /OUT === resolve\(join\(ROOT, 'src-tauri', 'voice-deps'\)\)/, 'stale-output purging is limited to the real desktop staging path');

const { isUnusedMuslSharp } = require('../scripts/lib/staged-native-packages.mjs');
assert.equal(isUnusedMuslSharp('@img', 'sharp-linuxmusl-x64', 'linux'), true, 'glibc AppImage excludes the musl addon that linuxdeploy cannot load');
assert.equal(isUnusedMuslSharp('@img', 'sharp-libvips-linuxmusl-x64', 'linux'), true, 'the unused musl libvips companion is removed too');
assert.equal(isUnusedMuslSharp('@img', 'sharp-linuxmusl-arm64', 'linux'), true, 'glibc ARM has the same libc boundary');
for (const name of ['sharp-linux-x64', 'sharp-libvips-linux-x64', 'sharp-linux-arm64', 'sharp-libvips-linux-arm64', 'sharp-libvips-dev']) {
  assert.equal(isUnusedMuslSharp('@img', name, 'linux'), false, 'required glibc and non-platform Sharp packages survive: ' + name);
}
assert.equal(isUnusedMuslSharp('unrelated', 'sharp-linuxmusl-x64', 'linux'), false, 'only the native @img scope is pruned');
for (const platform of ['darwin', 'win32']) assert.equal(isUnusedMuslSharp('@img', 'sharp-linuxmusl-x64', platform), false, 'other desktop targets retain their existing staging behavior');
console.log('desktop voice bundle tests passed');
