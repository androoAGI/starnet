/* node test/workspace-view.e2e.test.js — GET /view/~t/<ticket>/<agent>/<dir>/<path...>, the BROWSER window's in-app
   render of a web page an agent wrote into its workspace (frontend/app/outputbrowser.js). Boots a real sidecar on a
   scratch workspace and proves:
     - a folder-scoped view ticket serves the page RUNNABLE (text/html, script intact) under the opaque-origin sandbox
       (no allow-same-origin), no-store, no-referrer — and its relative assets in the folder tree load on the same ticket;
     - the ticket is REQUIRED and scoped: no ticket / a wrong one / the master token / an expired one / another
       folder's ticket are all 403, and a '../' out of the folder is refused;
     - dot-files and dot-folders are never served, a missing file is 404, and a directory is never listed;
     - the page's own minter (frontend/app/apiticket.js viewUrl) builds a URL this route accepts. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const T = require('../sidecar/apitickets.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const INDEX = path.join(__dirname, '..', 'sidecar', 'index.js');
const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 30000);   // a loaded multi-agent box boots slow
  });
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-view-e2e-'));
  const ws = path.join(scratch, 'ws'); fs.mkdirSync(ws);
  const agentDir = path.join(ws, 'builder');
  fs.mkdirSync(path.join(agentDir, 'site', 'css'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'site', '.git'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'site', 'index.html'), '<!doctype html><link rel="stylesheet" href="css/app.css"><h1>hi</h1><script>document.title="ran"</script>');
  fs.writeFileSync(path.join(agentDir, 'site', 'css', 'app.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(agentDir, 'site', '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(agentDir, 'site', '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(agentDir, 'notes.md'), '# private notes');
  fs.writeFileSync(path.join(agentDir, 'root.html'), '<p>root page</p>');
  // the scratch HOME/APPDATA keep this sidecar off the real station entirely
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-view-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const booted = await boot(await allocatePort(), env, 20);
  const child = booted.child;
  const B = 'http://' + HOST + ':' + booted.port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const view = (dir, now) => '/view/~t/' + T.mint(token, 'view', T.scopeView('builder', dir), { now: now || Date.now() }) + '/builder/' + (dir ? encodeURIComponent(dir) : '~') + '/';

    // (1) the page renders RUNNABLE under the sandbox
    const page = await fetch(B + view('site') + 'index.html');
    A.eq(page.status, 200, 'a view ticket serves the workspace page');
    A.ok(/text\/html/.test(page.headers.get('content-type') || ''), 'served as text/html (renders, not a download)');
    A.ok(/<script>document\.title="ran"<\/script>/.test(await page.text()), 'the page script is served intact');
    const csp = page.headers.get('content-security-policy') || '';
    A.ok(/sandbox/.test(csp) && /allow-scripts/.test(csp), 'CSP sandbox allow-scripts: scripts run');
    A.ok(!/allow-same-origin/.test(csp), 'no allow-same-origin: opaque origin, the app token/API unreachable');
    A.ok(/no-store/.test(page.headers.get('cache-control') || ''), 'no-store');
    A.eq(page.headers.get('referrer-policy'), 'no-referrer', 'the ticketed URL never rides a Referer');
    A.eq(page.headers.get('x-content-type-options'), 'nosniff', 'nosniff');

    // (2) relative assets under the folder ride the same ticket
    const css = await fetch(B + view('site') + 'css/app.css');
    A.eq(css.status, 200, 'a relative asset in a subfolder loads on the page ticket');
    A.ok(/text\/css/.test(css.headers.get('content-type') || ''), 'the asset has its real content-type');
    const head = await fetch(B + view('site') + 'index.html', { method: 'HEAD' });
    A.eq(head.status, 200, 'HEAD answers too');

    // (3) the ticket is required and scoped
    A.eq((await fetch(B + '/view/builder/site/index.html')).status, 403, 'no ticket → 403');
    A.eq((await fetch(B + '/view/~t/wrong/builder/site/index.html')).status, 403, 'a malformed ticket → 403');
    A.eq((await fetch(B + '/view/~t/' + encodeURIComponent(token) + '/builder/site/index.html')).status, 403, 'the MASTER token in the ticket slot → 403');
    const old = Date.now() - T.KINDS.view.maxTtlMs - 60000;
    A.eq((await fetch(B + view('site', old) + 'index.html')).status, 403, 'an expired ticket → 403');
    const otherFolder = '/view/~t/' + T.mint(token, 'view', T.scopeView('builder', 'elsewhere'), { now: Date.now() }) + '/builder/site/index.html';
    A.eq((await fetch(B + otherFolder)).status, 403, 'a ticket for another folder cannot open this one');
    const otherAgent = '/view/~t/' + T.mint(token, 'view', T.scopeView('someone', 'site'), { now: Date.now() }) + '/builder/site/index.html';
    A.eq((await fetch(B + otherAgent)).status, 403, 'a ticket for another agent cannot open this agent');
    const fileTicket = '/view/~t/' + T.mint(token, 'file', T.scopeFile('builder', 'site/index.html'), { now: Date.now() }) + '/builder/site/index.html';
    A.eq((await fetch(B + fileTicket)).status, 403, 'a /api/file ticket is not a view ticket');
    // fetch() would fold '..'/'%2E%2E' client-side (WHATWG URL); send the raw path so the SERVER's wall is what's tested
    const raw = p => new Promise((resolve, reject) => {
      require('http').get({ host: HOST, port: booted.port, path: p }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    A.eq(await raw(view('site') + '../notes.md'), 403, "a raw '../' out of the folder is refused");
    A.eq(await raw(view('site') + '%2E%2E/notes.md'), 403, "an encoded '../' out of the folder is refused");
    A.eq(await raw(view('site') + 'css%2F..%2F..%2Fnotes.md'), 403, "a '../' smuggled through an encoded slash is refused");

    // (4) dot-files, missing files, directories
    A.eq((await fetch(B + view('site') + '.env')).status, 403, 'a dot-file is never served');
    A.eq((await fetch(B + view('site') + '.git/config')).status, 403, 'a dot-folder is never served');
    A.eq((await fetch(B + view('site') + 'nope.html')).status, 404, 'a missing file is 404');
    A.eq((await fetch(B + view('site') + 'css')).status, 404, 'a directory is never listed');

    // (5) a page at the workspace root ('~')
    A.eq((await fetch(B + view('') + 'root.html')).status, 200, 'a root-level page renders on a root ticket');

    // (6) the page's own minter builds URLs this route accepts
    global.window = { __STARNET_API_TOKEN__: token, __STARNET_API__: '', crypto: require('node:crypto').webcrypto };
    delete require.cache[require.resolve('../frontend/app/apiticket.js')];
    const P = require('../frontend/app/apiticket.js');
    const u1 = P.viewUrl('builder', 'site/index.html');
    A.ok(/^\/view\/~t\/st1\./.test(u1) && u1.indexOf(token) < 0, 'viewUrl carries a ticket, never the master token');
    A.eq((await fetch(B + u1)).status, 200, 'a page-minted view URL opens the page');
    A.eq((await fetch(B + P.viewUrl('builder', 'root.html'))).status, 200, 'a page-minted root view URL opens the root page');
    A.eq((await fetch(B + P.viewUrl('builder', 'site\\index.html'))).status, 200, 'a Windows-style path is normalised');
    A.eq(P.viewUrl('builder', 'site/'), '', 'no file → no URL (never a directory)');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('workspace-view.e2e.test');
})().catch(e => { console.log('FAIL: workspace-view.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
