'use strict';
/* A BROWSER FOR COMPUTERS THAT HAVE NONE (Andrew 2026-09-30: "EVERY user should be able to use starnet's built in
   browser"). The station browser runs on the Commander's installed Chrome / Edge / Chromium. A machine with none of
   them — a fresh Mac, a minimal Linux — would otherwise get "Chromium not found". Hermes answers this with
   `agent-browser install` (it downloads Chromium); Agent OS does the same, by itself, the first time a browser is
   needed: Google's official Chrome for Testing build, from Google's own download host, into
   <workspaces>/.browsers/<version>/. Nothing is downloaded while an installed browser exists.

   One download at a time (single-flight — the same lesson as the driver's connect()); the files are unpacked into a
   temporary folder and renamed into place only when complete, so a half-finished download is never launched.
   status() is the truth the BROWSER window shows while it runs ("Setting up the browser… 42 of 150 MB").

   Pure-ish: fetch, the unpacker and the clock are injected (test/browser-install.test.js). */
const fs = require('fs');
const path = require('path');
const { pipeline: streamPipeline } = require('stream/promises');
const CP = require('./child-env.js').guardChildProcess(require('child_process'));   // tar / ditto / unzip never inherit station secrets
const { note: failNote } = require('./failopen.js');

const VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const DOWNLOAD_HOST = 'storage.googleapis.com';

// Chrome for Testing's platform names, and where the browser sits inside its zip
function platformKey(platform, arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';   // listed by Google since 2026 (checked 2026-10-01)
  return null;   // Chrome for Testing has no build here: the station says so
}
function exeInside(key) {
  if (key === 'win64' || key === 'win32') return path.join('chrome-' + key, 'chrome.exe');
  if (key === 'mac-arm64' || key === 'mac-x64') return path.join('chrome-' + key, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  return path.join('chrome-' + key, 'chrome');
}

// Unpack a zip with the tool every supported OS already has (tar.exe ships with Windows 10+; ditto with macOS).
// ASYNCHRONOUS (release review 2026-09-30): unpacking ~400 MB takes tens of seconds, and a synchronous child call
// would freeze the whole station — every request, every stream — for all of it, right during first-run setup.
function runTool(cmd, args) {
  return new Promise((resolve, reject) => {
    CP.execFile(cmd, args, { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }, err => (err ? reject(err) : resolve()));
  });
}
async function unzipWithSystem(zipFile, dest, platform) {
  const run = runTool;
  if (platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return run(fs.existsSync(tar) ? tar : 'tar', ['-xf', zipFile, '-C', dest]);
  }
  if (platform === 'darwin') return run('ditto', ['-x', '-k', zipFile, dest]);
  try { return await run('unzip', ['-q', '-o', zipFile, '-d', dest]); }
  catch (e) {
    failNote('browser-install.unzip', e);
    await run('python3', ['-m', 'zipfile', '-e', zipFile, dest]);
    // python's zipfile drops the executable bit
    const dir = fs.readdirSync(dest).map(d => path.join(dest, d)).find(d => /chrome-linux/.test(d));
    for (const f of ['chrome', 'chrome_crashpad_handler', 'chrome-wrapper', 'chrome_sandbox']) {
      try { if (dir) fs.chmodSync(path.join(dir, f), 0o755); } catch (e2) { failNote('browser-install.chmod', e2); }
    }
  }
}

function makeChromiumInstaller(deps) {
  deps = deps || {};
  const root = deps.root;
  if (!root) throw new Error('browser-install requires deps.root');
  const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const unzip = typeof deps.unzip === 'function' ? deps.unzip : unzipWithSystem;
  const F = deps.fs || fs;
  const key = platformKey(platform, arch);
  const currentFile = path.join(root, 'current.json');
  const now = typeof deps.now === 'function' ? deps.now : () => 0;   // the composition root injects the clock (no clock: no cooldown)
  // after a failed download, wait before trying again: every browser call must not start another ~150 MB download
  const retryAfterMs = deps.retryAfterMs > 0 ? deps.retryAfterMs : 10 * 60 * 1000;
  let failedAt = 0, lastError = null;

  let st = { state: 'idle', received: 0, total: 0, version: null, error: null };
  let inflight = null;

  // the browser this station downloaded earlier, if it is still whole
  function find() {
    try {
      if (!F.existsSync(currentFile)) return null;
      const cur = JSON.parse(F.readFileSync(currentFile, 'utf8'));
      const exe = cur && cur.exe ? path.join(root, String(cur.version), cur.exe) : null;
      return exe && F.existsSync(exe) ? exe : null;
    } catch (e) { failNote('browser-install.find', e); return null; }
  }
  function status() { return Object.assign({ platform: key, available: !!key }, st, find() ? { state: 'ready' } : {}); }

  async function download() {
    if (!key) throw new Error('no downloadable browser for this computer (' + platform + '/' + arch + '): install Chrome, Edge or Chromium');
    if (!fetchImpl) throw new Error('browser download unavailable: fetch is missing');
    st = { state: 'downloading', received: 0, total: 0, version: null, error: null };
    const vr = await fetchImpl(VERSIONS_URL);
    if (!vr.ok) throw new Error('could not reach the Chrome download list (HTTP ' + vr.status + ')');
    const meta = await vr.json();
    const stable = meta && meta.channels && meta.channels.Stable;
    const entry = stable && stable.downloads && Array.isArray(stable.downloads.chrome) ? stable.downloads.chrome.find(d => d.platform === key) : null;
    if (!entry || !entry.url) throw new Error('no Chrome download is listed for ' + key);
    const u = new URL(entry.url);
    if (u.protocol !== 'https:' || u.hostname !== DOWNLOAD_HOST) throw new Error('refusing a browser download from ' + u.hostname);
    const version = String(stable.version || '').replace(/[^0-9.]/g, '') || 'latest';
    st.version = version;
    F.mkdirSync(root, { recursive: true });
    const zipFile = path.join(root, 'download-' + version + '.zip');
    const stage = path.join(root, 'unpack-' + version);
    const finalDir = path.join(root, version);
    partial = [zipFile, stage];   // removed if anything below fails
    const res = await fetchImpl(u.href);
    if (!res.ok || !res.body) throw new Error('the browser download failed (HTTP ' + res.status + ')');
    st.total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
    /* pipeline, not a hand-rolled write loop: the old loop never listened for the file stream's 'error', so a
       full disk (ENOSPC) or an antivirus lock (EPERM) mid-download became an UNCAUGHT exception that exited the
       whole sidecar — and its 'drain' wait could never resolve. pipeline() rejects, destroys the stream and lets
       the cleanup below remove the partial file. */
    await streamPipeline(async function* () {
      for await (const chunk of res.body) { st.received += chunk.length; yield chunk; }
    }, F.createWriteStream(zipFile));
    if (st.total && st.received !== st.total) throw new Error('the browser download was cut short (' + st.received + ' of ' + st.total + ' bytes)');
    st.state = 'unpacking';
    F.rmSync(stage, { recursive: true, force: true });
    F.mkdirSync(stage, { recursive: true });
    await unzip(zipFile, stage, platform);
    const exeRel = exeInside(key);
    if (!F.existsSync(path.join(stage, exeRel))) throw new Error('the downloaded browser is incomplete (no ' + exeRel + ')');
    F.rmSync(finalDir, { recursive: true, force: true });
    F.renameSync(stage, finalDir);
    F.writeFileSync(currentFile, JSON.stringify({ version, exe: exeRel }, null, 2));
    try { F.rmSync(zipFile, { force: true }); } catch (e) { failNote('browser-install.cleanup', e); }
    partial = [];
    st.state = 'ready';
    return path.join(finalDir, exeRel);
  }
  let partial = [];
  function cleanPartial() {
    for (const p of partial) { try { F.rmSync(p, { recursive: true, force: true }); } catch (e) { failNote('browser-install.cleanup', e); } }
    partial = [];
  }

  // the downloaded browser's path — downloading it first if there is none (one download, however many callers)
  function ensure() {
    const have = find();
    if (have) return Promise.resolve(have);
    if (!inflight && failedAt && now() - failedAt < retryAfterMs) {
      return Promise.reject(new Error('the browser download failed a moment ago (' + lastError + ') — it is retried in a few minutes; installing Chrome, Edge or Chromium fixes it now'));
    }
    if (!inflight) {
      inflight = download()
        .then(p => { failedAt = 0; lastError = null; return p; })
        .catch(e => { cleanPartial(); failedAt = now(); lastError = String((e && e.message) || e); st.state = 'failed'; st.error = lastError; throw e; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { find, ensure, status, platformKey: key };
}

module.exports = { makeChromiumInstaller, platformKey, exeInside, VERSIONS_URL };
