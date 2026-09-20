'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson } = require('./gateway');
const { UI_ASSETS } = require('./ui-assets');
const { connectionConfig, saveConnection, planConnection } = require('./config');
const { assertFree } = require('./cli');
const { githubUser, probeConnection } = require('./connection');

class SetupController {
  constructor({ config = null, configFile, profile = githubUser, probe = probeConnection, onSave = () => {}, signIn, terminal, installerAvailable = false, localAvailable = false } = {}) {
    Object.assign(this, { config, configFile, profile, probe, onSave, signIn, terminal, installerAvailable, localAvailable });
    this.user = null; this.job = null; this.state = { phase: 'idle', message: '' };
  }
  snapshot() { return { ...this.state, config: this.config, user: this.user, busy: !!this.job, installerAvailable: this.installerAvailable, localAvailable: this.localAvailable }; }
  launch(work) {
    if (this.job) throw new Error('A connection check is already running. Cancel it before starting another.');
    const job = new AbortController(); this.job = job;
    this.state = { phase: 'working', message: 'Preparing…' };
    const update = message => { if (this.job === job) this.state = { phase: 'working', message }; };
    Promise.resolve().then(() => work(job.signal, update)).catch(error => {
      if (this.job === job) this.state = { phase: 'error', message: error.name === 'AbortError' || error.name === 'TimeoutError' ? 'The check timed out. Your previous connection is unchanged.' : error.message };
    }).finally(() => { if (this.job === job) this.job = null; });
  }
  refreshUser() {
    this.launch(async (signal, update) => {
      update('Checking GitHub sign-in…');
      const user = await this.profile(signal); signal.throwIfAborted(); this.user = user;
      this.state = { phase: 'idle', message: 'Signed in as ' + user.login + '.' };
    });
  }
  login() {
    this.launch(async (signal, update) => {
      update('Opening GitHub sign-in…');
      await this.signIn(signal, update);
      const user = await this.profile(signal); signal.throwIfAborted(); this.user = user;
      this.state = { phase: 'idle', message: 'Signed in as ' + user.login + '.' };
    });
  }
  test(input) {
    // Reject syntax before doing any authentication or network work.
    connectionConfig({ ...input, owner: 1, port: 8790 });
    this.launch(async (signal, update) => {
      update('Checking GitHub sign-in…');
      const user = await this.profile(signal); signal.throwIfAborted(); this.user = user;
      const cfg = connectionConfig({ ...input, owner: user.id, port: 8790 });
      await this.probe(cfg, { signal, phase: update });
      signal.throwIfAborted();
      const planned = planConnection(cfg, this.configFile).cfg;
      if (planned.port !== this.config?.port) {
        try { await assertFree(planned.port); } catch (_) { throw new Error('Another app is using this station’s local port (' + planned.port + '). Close it and test again.'); }
      }
      signal.throwIfAborted();
      // No await between cancellation check and commit. Failed or cancelled probes never touch the saved connection.
      this.config = saveConnection(cfg, this.configFile);
      this.onSave(this.config);
      this.state = { phase: 'connected', message: 'Connection verified. Your station runs on ' + cfg.host + '.' };
    });
  }
  cancel() { const job = this.job; this.job = null; job?.abort(); this.state = { phase: 'idle', message: 'Check cancelled. Your saved connection is unchanged.' }; }
  async openTerminal(input, install = false) {
    if (this.job) throw new Error('Finish or cancel the current check first.');
    if (install && !this.installerAvailable) throw new Error('The server installer is missing. Reinstall the complete desktop package.');
    const user = install ? await this.profile() : null;
    const cfg = connectionConfig({ ...input, owner: user?.id || 1, port: 8790 });
    if (install && cfg['gateway-port'] !== 18791) throw new Error('New installations use gateway port 18791.');
    await this.terminal(cfg, install);
    this.state = { phase: 'idle', message: install ? 'The installer is open in Terminal. When it finishes, return here and test the connection.' : 'SSH setup is open in Terminal. Verify the server fingerprint and sign in, then return here to test.' };
  }
}
function createSetupServer(controller, { port = 18790, root = __dirname } = {}) {
  const csrf = crypto.randomBytes(32).toString('hex');
  const files = { '/': ['setup.html', 'text/html; charset=utf-8'], '/setup.js': ['setup-ui.js', 'text/javascript'], '/setup.css': ['setup.css', 'text/css'] };
  for (const file of UI_ASSETS) files['/starnet/' + file] = ['../frontend/' + file, file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'image/svg+xml'];
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Untrusted origin' });
    if (req.url === '/health' && req.method === 'GET') return send(200, { configured: !!controller.config, port: controller.config?.port || 8790 });
    if (files[req.url] && req.method === 'GET') {
      const [file, type] = files[req.url];
      try {
        let body = fs.readFileSync(path.join(root, file));
        if (req.url === '/') body = Buffer.from(body.toString().replace('__SETUP_TOKEN__', csrf));
        res.writeHead(200, { 'Content-Type': type }); return res.end(body);
      } catch (_) { return send(500, { error: 'Setup resources are missing. Reinstall the desktop app.' }); }
    }
    if (req.headers['x-starnet-setup'] !== csrf) return send(403, { error: 'Open Connection Setup again to continue.' });
    try {
      if (req.url === '/api/status' && req.method === 'GET') return send(200, controller.snapshot());
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return send(405, { error: 'Expected JSON POST' });
      const body = await readJson(req, 4096);
      switch (req.url) {
        case '/api/profile': controller.refreshUser(); break;
        case '/api/login': controller.login(); break;
        case '/api/test': controller.test(body); break;
        case '/api/cancel': controller.cancel(); break;
        case '/api/ssh': await controller.openTerminal(body); break;
        case '/api/install': await controller.openTerminal(body, true); break;
        default: return send(404, { error: 'Not found' });
      }
      send(200, controller.snapshot());
    } catch (error) { send(400, { error: error.message }); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.maxConnections = 16;
  server.on('close', () => controller.cancel());
  return server;
}
module.exports = { SetupController, createSetupServer };
