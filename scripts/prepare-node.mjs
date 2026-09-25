// Fetch the Node runtime that ships inside the desktop installer.
//
// Download-blocker A: the Tauri shell used to spawn "node" from PATH, so a
// clean machine without Node installed could not start the sidecar. Tauri
// externalBin expects the binary named with the build target triple under
// src-tauri/binaries, then copies it beside the packaged app executable.
//
// Run directly:        node scripts/prepare-node.mjs            (auto-detects the host OS/arch)
// Cross-target:        node scripts/prepare-node.mjs linux-x64  (or linux-arm64 / darwin-arm64 / darwin-x64 / win-x64)
// Override version:    SKYNET_BUNDLE_NODE=v22.23.2
//
// Windows ships Node as a bare node.exe; macOS/Linux ship a .tar.gz whose bin/node we extract via `tar`.
import { createWriteStream, mkdirSync, existsSync, rmSync, renameSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export const NODE_VERSION = process.env.SKYNET_BUNDLE_NODE || 'v22.23.2';

// the supported externalBin targets. `dist` / `sha` are paths under https://nodejs.org/dist/<version>/ ;
// `member` (archive targets) is the path INSIDE the tarball to extract as the bundled binary. ${V} = version.
const TARGETS = {
  'win-x64':      { triple: 'x86_64-pc-windows-msvc',   dist: 'win-x64/node.exe',              sha: 'win-x64/node.exe',              ext: '.exe', member: null },
  'darwin-arm64': { triple: 'aarch64-apple-darwin',     dist: 'node-${V}-darwin-arm64.tar.gz', sha: 'node-${V}-darwin-arm64.tar.gz', ext: '',     member: 'node-${V}-darwin-arm64/bin/node' },
  'darwin-x64':   { triple: 'x86_64-apple-darwin',      dist: 'node-${V}-darwin-x64.tar.gz',   sha: 'node-${V}-darwin-x64.tar.gz',   ext: '',     member: 'node-${V}-darwin-x64/bin/node' },
  'linux-x64':    { triple: 'x86_64-unknown-linux-gnu', dist: 'node-${V}-linux-x64.tar.gz',    sha: 'node-${V}-linux-x64.tar.gz',    ext: '',     member: 'node-${V}-linux-x64/bin/node' },
  'linux-arm64':  { triple: 'aarch64-unknown-linux-gnu', dist: 'node-${V}-linux-arm64.tar.gz', sha: 'node-${V}-linux-arm64.tar.gz', ext: '',     member: 'node-${V}-linux-arm64/bin/node' },
};

// host OS/arch -> a TARGETS key. Keeps the default (no-arg) behavior = "bundle for THIS machine", so a
// Windows run stays byte-identical to the original (win-x64), while a mac/linux run now works too.
export function defaultTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}`;
  throw new Error(`unsupported host platform ${platform}/${arch}; pass an explicit target (${Object.keys(TARGETS).join(', ')})`);
}

// PURE: resolve a target name -> the concrete URLs, triple, output filename, and (for archives) the member to
// extract. No I/O, so it is unit-testable. Throws on an unknown target.
export function resolveTarget(target = defaultTarget(), version = NODE_VERSION) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown target "${target}"; supported: ${Object.keys(TARGETS).join(', ')}`);
  const sub = s => s == null ? null : s.replace(/\$\{V\}/g, version);
  const base = `https://nodejs.org/dist/${version}`;
  return {
    target, version, triple: t.triple,
    distUrl: `${base}/${sub(t.dist)}`,
    shasumsUrl: `${base}/SHASUMS256.txt`,
    shasumEntry: sub(t.sha),
    // Debian installs externalBin into /usr/bin. Never replace the host's Node.
    outName: `${target.startsWith('linux-') ? 'starnet-node' : 'node'}-${t.triple}${t.ext}`,
    member: sub(t.member),       // null = bare binary (win); else extract this path from the tarball
  };
}

function fetchTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchTo(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const f = createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    }).on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timed out (no data for 60s)')));
  });
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('checksum download timed out (no data for 60s)')));
  });
}

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

// PURE: pick the expected hash for `entry` out of a SHASUMS256.txt body. Exported for testing.
export function pickSha(sumsBody, entry) {
  for (const line of sumsBody.split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (m && m[2] === entry) return m[1].toLowerCase();
  }
  throw new Error(`missing ${entry} in SHASUMS256.txt`);
}

export function cachedRuntimeMatches(file, version, expectedSha256) {
  if (!existsSync(file)) return false;
  try {
    if (readFileSync(file + '.version', 'utf8').trim() !== String(version)) return false;
    return /^[a-f0-9]{64}$/i.test(String(expectedSha256 || ''))
      && sha256(file) === String(expectedSha256).toLowerCase();
  }
  catch (_) { return false; }
}

// Build hygiene: Tauri copies the whole sidecar resource directory, including gitignored files.
// Refuse to package machine-local runtime state such as sidecar/workspaces/agent.save.json.
export function assertNoBundledRuntimeState(rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const sidecarDir = join(rootDir, 'sidecar');
  if (!existsSync(sidecarDir)) return;
  const bad = readdirSync(sidecarDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^workspaces(?:[.-].*)?$/i.test(e.name))
    .map(e => join(sidecarDir, e.name));
  if (bad.length) {
    throw new Error('refusing to build desktop bundle with runtime workspace state under sidecar: ' + bad.join(', '));
  }
}

async function main(target) {
  assertNoBundledRuntimeState();
  const r = resolveTarget(target);
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'src-tauri', 'binaries');
  const out = join(outDir, r.outName);
  mkdirSync(outDir, { recursive: true });
  let expected;
  try {
    expected = pickSha(await fetchText(r.shasumsUrl), r.shasumEntry);
  } catch (e) {
    console.error(`[prepare-node] FAILED: could not establish the official checksum for ${r.shasumEntry}: ${e.message}`);
    process.exit(1);
  }
  if (cachedRuntimeMatches(out, r.version, expected) && !process.env.SKYNET_BUNDLE_FORCE) {
    console.log(`[prepare-node] ${out} already present; skipping (set SKYNET_BUNDLE_FORCE=1 to re-fetch)`);
    return;
  }
  if (existsSync(out) && !process.env.SKYNET_BUNDLE_FORCE) {
    console.log(`[prepare-node] cached runtime is unstamped or not ${r.version}; refreshing ${out}`);
  }

  console.log(`[prepare-node] fetching Node ${r.version} (${r.target}) -> ${out}`);
  const dl = out + '.download';
  try {
    await fetchTo(r.distUrl, dl);
    const actual = sha256(dl);
    if (actual !== expected) throw new Error(`checksum mismatch for ${r.shasumEntry}: expected ${expected}, got ${actual}`);

    if (!r.member) {                         // win-x64: the download IS the binary
      rmSync(out, { force: true });
      renameSync(dl, out);
    } else {                                 // mac/linux: extract bin/node from the verified tarball via `tar`
      const exDir = join(outDir, '.extract-' + r.target);
      rmSync(exDir, { recursive: true, force: true });
      mkdirSync(exDir, { recursive: true });
      execFileSync('tar', ['-xzf', dl, '-C', exDir, r.member], { stdio: 'ignore' });
      rmSync(out, { force: true });
      renameSync(join(exDir, r.member), out);
      try { chmodSync(out, 0o755); } catch {}
      rmSync(exDir, { recursive: true, force: true });
      rmSync(dl, { force: true });
    }
    writeFileSync(out + '.version', r.version + '\n', 'utf8');
    console.log('[prepare-node] done (checksum verified; gitignored build input)');
  } catch (e) {
    try { rmSync(dl, { force: true }); } catch {}
    console.error(`[prepare-node] FAILED: ${e.message}`);
    console.error('[prepare-node] the desktop build needs this Node runtime; check connectivity, that `tar` is on PATH (mac/linux targets), or set SKYNET_BUNDLE_NODE to a valid version.');
    process.exit(1);
  }
}

// run only when executed directly (not when imported by a test). Optional CLI arg = the target.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv[2]);
}
