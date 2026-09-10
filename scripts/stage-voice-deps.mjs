// Stage the RUNTIME node_modules that ship inside the desktop installer.
//
// WHY THIS EXISTS: the Tauri bundle carries `sidecar/`, `frontend/` and `shared/` and nothing else, so every
// npm import from the sidecar is dead in an installed build. That was fine while the sidecar was genuinely
// dependency-free; it stopped being fine when offline voice (@huggingface/transformers + kokoro-js) landed.
// Local Live could never listen in a packaged app, and no substitute engine reproduces the panel's designed
// behaviour (live level meter, interim partials, barge-in) because all three are fed by the model path.
//
// The staged tree is dropped at <resources>/node_modules — a SIBLING of sidecar/ — so Node's ordinary
// upward resolution finds it from sidecar/*.js with no NODE_PATH and no code change.
//
// The naive copy is ~764 MB because onnxruntime ships every platform's native binaries and the dev-only
// Tauri CLI sits in the same tree. This keeps the production closure, drops dev-only trees, and prunes the
// native binaries to ONE platform — the one being built.
//
//   node scripts/stage-voice-deps.mjs [--target win-x64] [--platform win32] [--arch x64] [--out <dir>] [--report]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnusedMuslSharp, isUnusedDesktopAccelerator } from './lib/staged-native-packages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const TARGET = argVal('--target', '');
const targetMatch = /^(win|darwin|linux)-(x64|arm64)$/.exec(TARGET);
if (TARGET && !targetMatch) {
  console.error('stage-voice-deps: unsupported --target ' + TARGET + ' (expected win-x64, darwin-x64, darwin-arm64, or linux-x64)');
  process.exit(1);
}
const targetPlatform = targetMatch ? ({ win: 'win32', darwin: 'darwin', linux: 'linux' })[targetMatch[1]] : process.platform;
const targetArch = targetMatch ? targetMatch[2] : process.arch;
const PLATFORM = argVal('--platform', targetPlatform);
const ARCH = argVal('--arch', targetArch);
const OUT = resolve(argVal('--out', join(ROOT, 'src-tauri', 'voice-deps')));
const SRC = join(ROOT, 'node_modules');

// Dev-only trees. The Tauri CLI is a devDependency and its native .node addon alone is 15 MB.
const DROP_TOP = new Set(['@tauri-apps', '.bin', '.package-lock.json']);

/* Packages the sidecar never reaches in Node. `onnxruntime-web` is the BROWSER backend — 222 MB across the
   two copies — and the sidecar runs the models through `onnxruntime-node`. Dropping it was not assumed:
   the Kokoro->Whisper round-trip was re-run from a simulated bundle with these removed and still passed.
   ⛔ `@img/sharp` is NOT here on purpose — transformers imports it eagerly and dropping it breaks the very
   first `import`, which is exactly how this was found. */
// adm-zip is used only by onnxruntime-node's npm postinstall downloader. The packaged app loads
// dist/index.js and an already-staged native binding; it never executes script/install*. Keep the
// build-time ZIP parser out of the shipped runtime closure.
const DROP_ANYWHERE = new Set(['onnxruntime-web', 'adm-zip']);
// Source maps are pure debug weight in a shipped bundle.
const DROP_SUFFIX = ['.map'];

function dirSize(dir) {
  let total = 0;
  const walk = d => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += statSync(p).size; } catch (_) {} }
    }
  };
  walk(dir);
  return total;
}
const mb = bytes => (bytes / 1024 / 1024).toFixed(1) + ' MB';

/* onnxruntime-node lays its native binaries out as bin / napi-vN / platform / arch, for EVERY platform it
   supports. An installer only ever runs on the platform it was built for, so the rest is dead weight — and
   it is the single biggest line item in the bundle. Prune in place, after copying, so the source tree is
   never mutated. (Written without the literal glob: a `napi-v*` followed by a slash closes this comment.) */
function pruneOnnxBinaries(root) {
  let freed = 0, kept = [];
  const walk = d => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      if (e.name === 'bin' && /onnxruntime-node$/.test(d)) {
        for (const napi of readdirSync(p, { withFileTypes: true })) {
          if (!napi.isDirectory()) continue;
          const napiDir = join(p, napi.name);
          for (const plat of readdirSync(napiDir, { withFileTypes: true })) {
            if (!plat.isDirectory()) continue;
            const platDir = join(napiDir, plat.name);
            if (plat.name !== PLATFORM) { freed += dirSize(platDir); rmSync(platDir, { recursive: true, force: true }); continue; }
            for (const arch of readdirSync(platDir, { withFileTypes: true })) {
              if (!arch.isDirectory()) continue;
              const archDir = join(platDir, arch.name);
              if (arch.name !== ARCH) { freed += dirSize(archDir); rmSync(archDir, { recursive: true, force: true }); }
              else kept.push(archDir.slice(root.length + 1));
            }
          }
        }
        continue;
      }
      walk(p);
    }
  };
  walk(root);
  return { freed, kept };
}

// Tauri's resource copy can retain files that disappeared from a later staged tree. Purge the exact
// packages this script drops from prior release-resource outputs before the bundler runs, otherwise a
// warm build can silently put a removed dependency back into the installer.
function purgeStaleReleasePackages() {
  const targetRoot = join(ROOT, 'src-tauri', 'target');
  const roots = [join(targetRoot, 'release', 'node_modules')];
  let entries = [];
  try { entries = readdirSync(targetRoot, { withFileTypes: true }); } catch (_) {}
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'release') {
      roots.push(join(targetRoot, entry.name, 'release', 'node_modules'));
    }
  }
  const removeNamed = dir => {
    let children;
    try { children = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const child of children) {
      const childPath = join(dir, child.name);
      if (!child.isDirectory()) {
        if (child.isFile() && isUnusedDesktopAccelerator(childPath, PLATFORM)) rmSync(childPath, { force: true });
        continue;
      }
      if (DROP_ANYWHERE.has(child.name) || isUnusedMuslSharp(dir.split(/[\\/]/).pop(), child.name, PLATFORM)) {
        rmSync(childPath, { recursive: true, force: true });
      } else {
        removeNamed(childPath);
      }
    }
  };
  for (const root of roots) removeNamed(root);
}

if (args.includes('--report')) {
  if (!existsSync(OUT)) { console.log('voice-deps: nothing staged at ' + OUT); process.exit(0); }
  console.log('voice-deps staged: ' + mb(dirSize(join(OUT, 'node_modules'))) + ' at ' + OUT);
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.error('stage-voice-deps: no node_modules at ' + SRC + ' — run `npm install` first.');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies || {});
if (!runtimeDeps.length) {
  console.log('stage-voice-deps: package.json declares no runtime dependencies — nothing to stage.');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
const dest = join(OUT, 'node_modules');
mkdirSync(dest, { recursive: true });

const before = dirSize(SRC);
let copied = 0;
for (const entry of readdirSync(SRC, { withFileTypes: true })) {
  if (DROP_TOP.has(entry.name)) continue;
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
  cpSync(join(SRC, entry.name), join(dest, entry.name), { recursive: true, dereference: true });
  copied++;
}
const afterCopy = dirSize(dest);
const pruned = pruneOnnxBinaries(dest);

// Drop the browser-only packages and debug maps, at any nesting depth.
let extraFreed = 0;
(function sweep(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (DROP_ANYWHERE.has(e.name) || isUnusedMuslSharp(dir.split(/[\\/]/).pop(), e.name, PLATFORM)) { extraFreed += dirSize(p); rmSync(p, { recursive: true, force: true }); continue; }
      sweep(p);
    } else if (isUnusedDesktopAccelerator(p, PLATFORM) || DROP_SUFFIX.some(s => e.name.endsWith(s))) {
      try { extraFreed += statSync(p).size; rmSync(p, { force: true }); } catch (_) {}
    }
  }
})(dest);
if (OUT === resolve(join(ROOT, 'src-tauri', 'voice-deps'))) purgeStaleReleasePackages();
const final = dirSize(dest);

// A staged tree that cannot resolve the very packages it exists for is worse than none: it would ship and
// fail at runtime exactly like the bug this replaces. Fail the BUILD here instead.
for (const dep of runtimeDeps) {
  const p = join(dest, ...dep.split('/'), 'package.json');
  if (!existsSync(p)) { console.error('stage-voice-deps: FAILED — ' + dep + ' missing from the staged tree'); process.exit(1); }
}
if (!pruned.kept.length) {
  console.error('stage-voice-deps: FAILED — no onnxruntime binary kept for ' + PLATFORM + '/' + ARCH +
    '. The bundle would ship an engine it cannot load.');
  process.exit(1);
}

if (existsSync(join(dest, 'adm-zip'))) {
  console.error('stage-voice-deps: FAILED - build-only adm-zip leaked into the shipped runtime closure.');
  process.exit(1);
}

console.log('stage-voice-deps: ' + copied + ' top-level trees -> ' + dest);
console.log('  source node_modules : ' + mb(before));
console.log('  after dev-tree drop : ' + mb(afterCopy));
console.log('  after platform prune: ' + mb(afterCopy - pruned.freed) + '  (freed ' + mb(pruned.freed) + ' of foreign binaries)');
console.log('  after browser/map cut: ' + mb(final) + '  (freed ' + mb(extraFreed) + ' more)');
for (const k of pruned.kept) console.log('  kept native         : ' + k);
