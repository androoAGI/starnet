'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const configPath = () => path.join(os.homedir(), '.config', 'starnet-remote', 'config.json');
function checkedPort(value, fallback, minimum = 1024) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < minimum || n > 65535) throw new Error('Enter a valid port number (' + minimum + '–65535).');
  return n;
}
function connectionConfig(input) {
  const host = String(input.host || '').trim();
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(host)) {
    throw new Error('Enter an SSH alias or user@hostname, without spaces or a URL.');
  }
  const owner = Number(input.owner);
  if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Sign in with the GitHub account that owns this station.');
  const cfg = { host, owner, port: checkedPort(input.port, 8790), 'gateway-port': checkedPort(input['gateway-port'], 18791) };
  if (cfg.port === 18790) throw new Error('Port 18790 is reserved for Connection Setup.');
  if (input['ssh-port']) cfg['ssh-port'] = checkedPort(input['ssh-port'], 22, 1);
  return cfg;
}
function readConfig(file = configPath()) { return connectionConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
function writePrivateJson(value, file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const fdDir = fs.openSync(dir, 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); }
  } finally { fs.rmSync(tmp, { force: true }); }
}
function saveConfig(input, file = configPath()) {
  const cfg = connectionConfig(input); writePrivateJson(cfg, file); return cfg;
}
function identity(cfg) { return JSON.stringify([cfg.host, cfg.owner, cfg['ssh-port'] || null, cfg['gateway-port']]); }
function planConnection(input, file = configPath()) {
  const cfg = connectionConfig(input), registryFile = file + '.origins';
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    if (!registry || Array.isArray(registry) || typeof registry !== 'object' || Object.values(registry).some(n => !Number.isInteger(n) || n < 1024 || n > 65535 || n === 18790)) throw new Error('invalid');
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('The saved station origin registry is invalid. Restore its backup before switching stations.'); }
  let previous; try { previous = readConfig(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) registry[identity(previous)] = previous.port;
  const key = identity(cfg);
  if (!Object.hasOwn(registry, key)) {
    const used = new Set(Object.values(registry));
    let port = 30000;
    while (used.has(port) && port <= 65535) port++;
    if (port > 65535) throw new Error('No station origins are available.');
    registry[key] = port;
  }
  cfg.port = registry[key];
  return { cfg, registry, registryFile };
}
function saveConnection(input, file = configPath()) {
  const { cfg, registry, registryFile } = planConnection(input, file);
  // Commit the mapping first; a failed config write cannot reuse another station's origin.
  writePrivateJson(registry, registryFile);
  return saveConfig(cfg, file);
}
function sshArgs(cfg, interactive = false) {
  const out = ['-o', 'StrictHostKeyChecking=' + (interactive ? 'ask' : 'yes'), '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ConnectTimeout=12'];
  if (!interactive) out.push('-o', 'BatchMode=yes');
  if (cfg['ssh-port']) out.push('-p', String(cfg['ssh-port']));
  return out;
}
module.exports = { configPath, connectionConfig, readConfig, saveConfig, saveConnection, planConnection, checkedPort, sshArgs };
