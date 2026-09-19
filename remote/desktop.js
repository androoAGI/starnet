#!/usr/bin/env node
'use strict';
// Setup has its own origin: remote station HTML cannot call local SSH/admin actions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { readConfig, sshArgs } = require('./config');
const { SetupController, createSetupServer } = require('./setup');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function terminalScript(cfg, install, archive) {
  const args = sshArgs(cfg, true).map(quote).join(' '), host = quote(cfg.host);
  const first = `ssh ${args} -t ${host}`;
  if (!install) return `#!/bin/bash\n${first} 'printf "SSH access verified.\\n"'\nprintf '\\nYou can close this window and return to StarNet.\\n'\n`;
  const remoteDir = '/tmp/starnet-setup-' + require('node:crypto').randomBytes(8).toString('hex');
  const scpArgs = cfg['ssh-port'] ? '-P ' + cfg['ssh-port'] : '';
  const job = `cd ${remoteDir} && tar -xzf server.tar.gz && if [ "$(id -u)" = 0 ]; then bash remote/install-linux.sh ${cfg.owner}; else sudo bash remote/install-linux.sh ${cfg.owner}; fi`;
  return `#!/bin/bash\nset -euo pipefail\necho 'StarNet will install a private Linux service. It will not replace a running station.'\n${first} ${quote('umask 077; mkdir ' + remoteDir)}\nscp -o StrictHostKeyChecking=yes ${scpArgs} ${quote(archive)} ${quote(cfg.host + ':' + remoteDir + '/server.tar.gz')}\n${first} ${quote(job)}\n${first} ${quote('rm -rf -- ' + remoteDir)}\nprintf '\\nInstallation complete. Return to StarNet and test the connection.\\n'\n`;
}
async function main({ port = 18790 } = {}) {
  process.umask(0o077);
  let proxy = null, closing = false, serial = 0;
  const resources = path.resolve(__dirname, '..');
  const installer = path.join(resources, 'starnet-server.tar.gz');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-desktop-'));
  function restart() {
    const id = ++serial, old = proxy; proxy = null;
    const start = () => {
      if (closing || id !== serial) return;
      proxy = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'connect'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      proxy.on('error', () => {});
    };
    if (old && old.exitCode === null && old.signalCode === null) { old.once('close', start); old.kill('SIGTERM'); } else start();
  }
  async function signIn(signal, update) {
    await new Promise((resolve, reject) => {
      const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { env: { ...process.env, GH_BROWSER: '/usr/bin/open' }, stdio: ['pipe', 'ignore', 'pipe'], signal, timeout: 180000 });
      let tail = '';
      child.stdin.on('error', () => {}); child.stdin.end('\n');
      child.stderr.on('data', data => {
        tail = (tail + data.toString()).slice(-2048);
        const match = tail.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
        if (match) update('Enter code ' + match[1] + ' at github.com/login/device. Complete sign-in in your browser.');
      });
      child.once('error', () => reject(new Error('GitHub sign-in could not start. Reinstall the desktop app.')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error('GitHub sign-in did not complete. Try again.')));
    });
  }
  async function terminal(cfg, install) {
    const file = path.join(temp, 'StarNet-' + require('node:crypto').randomBytes(6).toString('hex') + '.command');
    fs.writeFileSync(file, terminalScript(cfg, install, installer), { mode: 0o700 });
    await run('/usr/bin/open', ['-a', 'Terminal', file], { timeout: 10000 });
  }
  let config = null; try { config = readConfig(); } catch (_) {}
  const controller = new SetupController({ config, onSave: restart, signIn, terminal, installerAvailable: fs.existsSync(installer), localAvailable: process.env.STARNET_UNIFIED_DESKTOP === '1' });
  const server = createSetupServer(controller);
  server.on('error', () => { console.error('Connection Setup could not bind its private local port.'); process.exitCode = 1; stop(); });
  server.listen(port, '127.0.0.1', () => { if (config) restart(); });
  // A crashed client can restart; the supervisor remains available for configuration repair.
  const timer = setInterval(() => { if (controller.config && (!proxy || proxy.exitCode !== null || proxy.signalCode !== null)) restart(); }, 3000);
  function stop() {
    if (closing) return; closing = true; serial++; clearInterval(timer); controller.cancel();
    proxy?.kill('SIGTERM'); server.closeAllConnections(); server.close();
    fs.rmSync(temp, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 1000).unref();
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  if (process.env.STARNET_DESKTOP_STDIN_LIFETIME === '1') {
    process.stdin.resume();
    process.stdin.once('end', stop);
  }
}
if (require.main === module) main().catch(() => { console.error('Connection Setup could not start.'); process.exitCode = 1; });
module.exports = { terminalScript, main };
