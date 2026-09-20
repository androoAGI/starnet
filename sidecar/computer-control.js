'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { childEnv } = require('./tools/builtin/cua-runtime.js');
const { note: failNote } = require('./failopen.js');
const VERSION = '0.28.2';
const SHA256 = '1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba';
const URL = 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v' + VERSION + '/cua-driver-rs-' + VERSION + '-windows-x86_64-binary.zip';
const exec = (file, args, options = {}) => new Promise((resolve, reject) => cp.execFile(file, args, { windowsHide: true, env: childEnv(), timeout: 15000, maxBuffer: 65536, ...options }, (e, out) => e ? reject(e) : resolve(out)));

function makeComputerControl(deps) {
  const root = path.resolve(deps.root, 'native-computer');
  const configFile = path.join(deps.root, 'computer-control.json');
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const supported = platform === 'win32' && (deps.arch || process.arch) === 'x64';
  const shell = deps.desktopShell === true;
  let config;
  try { config = deps.load(configFile) || {}; } catch { config = {}; }
  let installing = null;
  const selectedEnv = String(env.STARNET_COMPUTER_DRIVER || env.SKYNET_COMPUTER_DRIVER || '').toLowerCase();
  const locked = /^(cua|0|false|off|none)$/.test(selectedEnv);
  const selection = () => locked ? selectedEnv === 'cua' ? 'cua' : 'off'
    : ['cua', 'win32', 'off'].includes(config.backend) ? config.backend
    : /^(1|true|yes|on|win32|windows)$/.test(selectedEnv) ? 'win32' : 'off';
  const binary = () => String(env.STARNET_CUA_BINARY || path.join(root, VERSION, 'cua-driver.exe'));
  const installed = () => fs.existsSync(binary()) && fs.existsSync(path.join(path.dirname(binary()), 'cua-driver-uia.exe'));
  const available = () => shell && platform === 'win32' && (selection() === 'win32' || (selection() === 'cua' && supported && installed()));
  function status() {
    return {
      backend: selection(), supported, nativeSupported: platform === 'win32', desktopShell: shell, installed: installed(),
      customBinary: !!env.STARNET_CUA_BINARY,
      available: available(), installing: !!installing, envLocked: locked, version: VERSION,
      detail: !shell ? 'Native control requires the StarNet desktop app.'
        : !supported ? 'CUA installation currently supports Windows x64. The existing Windows driver remains available on Windows.'
        : selection() === 'off' ? 'Native control is off.'
        : selection() === 'cua' && !installed() ? 'Install CUA to use accessibility targeting.'
        : 'Driver configured. Each action checks its target and reports its actual outcome. Full Power or a paired remote-owner lease is required.'
    };
  }
  async function check() {
    const s = status();
    if (!s.installed) return { ...s, checked: false, checkDetail: 'CUA is not installed.' };
    try {
      const manifest = JSON.parse(await exec(binary(), ['manifest']));
      return { ...s, checked: manifest.binary_version === VERSION, detectedVersion: manifest.binary_version,
        checkDetail: manifest.binary_version === VERSION ? 'CUA executable responds; app permissions and target behavior are checked during use.' : 'Unsupported CUA version; install the pinned version.' };
    } catch { return { ...s, checked: false, checkDetail: 'CUA could not start. Reinstall the driver and check Windows security settings.' }; }
  }
  async function select(backend) {
    if (!['cua', 'win32', 'off'].includes(backend)) throw new Error('Choose cua, win32, or off');
    if (locked) throw new Error('Computer control is set by the launch environment');
    if (backend !== 'off' && (!shell || platform !== 'win32')) throw new Error('Native control requires the Windows desktop app');
    if (backend === 'cua') {
      if (!supported || !installed()) throw new Error('Install CUA first');
      if (!(await check()).checked) throw new Error('CUA version check failed');
    }
    const next = { version: 1, backend };
    deps.save(configFile, next);
    const stored = deps.load(configFile);
    if (stored?.backend !== backend) throw new Error('Computer setting could not be verified on disk');
    const changed = selection() !== backend;
    config = next;
    if (changed) await deps.onChange?.();
    return status();
  }
  async function install({ repair = false } = {}) {
    if (!supported || !shell) throw new Error('CUA installation requires the Windows x64 desktop app');
    if (env.STARNET_CUA_BINARY) throw new Error('CUA uses a custom binary path; manage that installation directly');
    if (installing) return installing;
    installing = (async () => {
      // Version directories and a private staging directory prevent partial
      // downloads from becoming runnable. A failed update never removes an existing driver.
      const dest = path.join(root, VERSION);
      if (installed() && !repair) {
        if (!(await check()).checked) throw new Error('Existing CUA installation failed verification');
        return status();
      }
      fs.mkdirSync(root, { recursive: true });
      const staging = path.join(root, 'staging-' + randomUUID());
      fs.mkdirSync(staging);
      const archive = path.join(staging, 'driver.zip');
      const expanded = path.join(staging, 'files');
      try {
        const response = await (deps.fetch || fetch)(URL, { signal: AbortSignal.timeout(180000) });
        if (!response.ok || !response.body) throw new Error('CUA download failed: HTTP ' + response.status);
        const hash = createHash('sha256');
        const fd = await fs.promises.open(archive, 'wx');
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 200 * 1024 * 1024) throw new Error('CUA download exceeded expected size');
            hash.update(chunk); await fd.writeFile(chunk);
          }
          await fd.sync();
        } finally { await fd.close(); }
        if (hash.digest('hex') !== SHA256) throw new Error('CUA download checksum mismatch');
        const ps = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:STARNET_CUA_ARCHIVE,$env:STARNET_CUA_EXPANDED)";
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          timeout: 60000, env: { ...childEnv(), STARNET_CUA_ARCHIVE: archive, STARNET_CUA_EXPANDED: expanded }
        });
        const manifest = JSON.parse(await exec(path.join(expanded, 'cua-driver.exe'), ['manifest']));
        if (manifest.binary_version !== VERSION || !fs.existsSync(path.join(expanded, 'cua-driver-uia.exe'))) throw new Error('CUA package verification failed');
        const backup = path.join(root, 'previous-' + randomUUID());
        let moved = false;
        if (fs.existsSync(dest)) {
          if (!repair) throw new Error('CUA installation directory already exists; choose Reinstall to repair it');
          await deps.onChange?.(); // Stop owned sessions before replacing their executable.
          fs.renameSync(dest, backup); moved = true;
        }
        try { fs.renameSync(expanded, dest); }
        catch (error) { if (moved) fs.renameSync(backup, dest); throw error; }
        // The newly verified package is already live; a locked previous folder must
        // not turn successful installation into a false failure or delete the new copy.
        if (moved && path.dirname(backup) === root) {
          try { fs.rmSync(backup, { recursive: true, force: true }); }
          catch { failNote('computer.install.previous_cleanup', 'Previous installation folder could not be removed'); }
        }
        return status();
      } finally {
        // staging is constructed beneath the fixed native-computer root, never user supplied.
        if (path.dirname(staging) === root) fs.rmSync(staging, { recursive: true, force: true });
      }
    })();
    try { await installing; } finally { installing = null; }
    return status();
  }
  return { status, check, select, install, selection, binary, available };
}
module.exports = { makeComputerControl, VERSION, SHA256, URL };
