'use strict';
/* test/cli-version.test.js — `starnet --version` names the real build in an INSTALLED app, never "dev".

   package.json is not a bundle resource (src-tauri/tauri.conf.json ships sidecar, frontend, shared, bin), so in every
   installed build the old reader fell back to "dev" — untruthful, and useless when support asks which version a user is
   on. The version is now read from what ships beside bin/: package.json in a checkout, Contents/Info.plist in the macOS
   app, the version resource of skynet-desktop.exe in a Windows install (the number the installer's GetDLLVersion reads),
   else "unknown". This copies the REAL bin/ (plus the one frontend file it loads) into scratch install layouts and runs
   `node bin/starnet.js --version` there, as a terminal would. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

const REPO = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-version-'));
function install(dir) {
  fs.cpSync(path.join(REPO, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'frontend', 'app'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'frontend', 'app', 'classify.js'), path.join(dir, 'frontend', 'app', 'classify.js'));
}
function version(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'starnet.js'), '--version'], { encoding: 'utf8', timeout: 30000 });
  return (String(r.stdout || '').trim() || String(r.stderr || '').trim());
}
// a minimal PE-like file carrying a VS_FIXEDFILEINFO block (signature 0xFEEF04BD, struct version, FileVersionMS/LS)
function fakeExe(major, minor, patch) {
  const pad = Buffer.alloc(4096, 0x41);
  const info = Buffer.alloc(52);
  info.writeUInt32LE(0xFEEF04BD, 0); info.writeUInt32LE(0x00010000, 4);
  info.writeUInt32LE(((major << 16) | minor) >>> 0, 8); info.writeUInt32LE((patch << 16) >>> 0, 12);
  return Buffer.concat([Buffer.from('MZ'), pad, info, pad]);
}

try {
  const pkg = require('../package.json').version;
  A.eq(version(REPO), 'starnet ' + pkg, 'a checkout: package.json\'s version');

  const mac = path.join(root, 'StarNet.app', 'Contents');
  install(path.join(mac, 'Resources'));
  fs.writeFileSync(path.join(mac, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>CFBundleName</key>\n  <string>StarNet</string>\n  <key>CFBundleShortVersionString</key>\n  <string>9.8.7</string>\n</dict></plist>\n');
  A.eq(version(path.join(mac, 'Resources')), 'starnet 9.8.7', 'the macOS app: the bundle\'s own Info.plist version');

  const win = path.join(root, 'StarNet');
  install(win);
  fs.writeFileSync(path.join(win, 'skynet-desktop.exe'), fakeExe(9, 8, 6));
  A.eq(version(win), 'starnet 9.8.6', 'a Windows install: skynet-desktop.exe\'s version resource');

  const bare = path.join(root, 'bare');
  install(bare);
  A.eq(version(bare), 'starnet unknown', 'nothing says which build: "unknown", never a made-up "dev"');

  // --version above ran on bin/ alone: it loads nothing from sidecar/. `starnet run` does — pickAgent resolves the run wire
  // with the station's own sidecar/run-wire.js + providers/registry.js, loaded on first use from beside bin/. Every bundle
  // ships sidecar/ there (tauri.conf.json resources), so a layout carrying those modules resolves a run, and one without
  // them is a broken install that throws, never a guessed provider.
  const tauri = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  A.ok(tauri.bundle.resources['../bin'] === 'bin' && tauri.bundle.resources['../sidecar'] === 'sidecar',
    'the bundle ships bin/ and sidecar/ side by side, so bin/lib\'s ../../sidecar requires resolve in every install');
  for (const f of ['run-wire.js', path.join('providers', 'registry.js')]) {
    fs.mkdirSync(path.dirname(path.join(win, 'sidecar', f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'sidecar', f), path.join(win, 'sidecar', f));
  }
  const rt = { provider: 'openrouter', model: 'station/default', agents: [{ agentId: 'agent', name: 'Overseer', model: 'own/pin', provider: 'openai-codex' }] };
  const sel = require(path.join(win, 'bin', 'lib', 'cli-core.js')).pickAgent(rt, {});
  A.ok(sel && sel.ok && sel.model === 'own/pin' && sel.provider === 'codex',
    'an install with sidecar/ beside bin/ resolves `starnet run`\'s wire through the station\'s alias map (' + JSON.stringify(sel) + ')');
  let missing = null;
  try { require(path.join(bare, 'bin', 'lib', 'cli-core.js')).pickAgent(rt, {}); } catch (e) { missing = e; }
  A.ok(!!missing && missing.code === 'MODULE_NOT_FOUND' && /sidecar[\\/]run-wire\.js/.test(missing.message),
    'an install missing sidecar/ fails `starnet run` loudly instead of guessing a provider');

  // the dashboard's VERSION overlay reads the same thing
  const dash = fs.readFileSync(path.join(REPO, 'bin', 'lib', 'dashboard.js'), 'utf8');
  A.ok(!/let cli = 'dev'/.test(dash) && /cliVersion\(/.test(dash), 'the dashboard\'s /version overlay uses the same reader');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('cli-version.test');
