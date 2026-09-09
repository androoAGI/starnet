/* A real-Chromium regression for the long-running black camera feed.

   The production WebGL warp owns an offscreen canvas, so the test asks its existing debug surface
   to invoke WEBGL_lose_context on that exact context. The visible 2D feed must remain lit on the
   same page because drawCurve() falls through to its CPU warp before clearing the source frame. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (!ok) failures.push(name);
};
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const stopChild = child => new Promise(resolve => {
  if (!child || child.exitCode != null) { resolve(); return; }
  const timer = setTimeout(resolve, 3000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  try { child.kill('SIGKILL'); } catch (_) { clearTimeout(timer); resolve(); }
});

const root = mkdtempSync(join(tmpdir(), 'starnet-crt-loss-'));
const workspace = join(root, 'workspace');
const profile = join(root, 'profile');
const appPort = await freePort();
const cdpPort = await freePort();
const appUrl = `http://127.0.0.1:${appPort}/`;
materializeSeedWorkspace(workspace);
const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace });
const chrome = spawn(findChrome(), [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${cdpPort}`, '--window-size=1280,720', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

let cdp = null;
try {
  check('isolated seeded sidecar starts', await waitUp(appUrl));
  cdp = await connectCDP(cdpPort);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: appUrl });
  check('seeded station reaches the live floor', await waitDevReady(cdp, evalJS, { url: appUrl }));

  let before = null;
  for (let i = 0; i < 50; i++) {
    before = await evalJS(cdp, `typeof World !== 'undefined' && World._dbgCurveState ? World._dbgCurveState() : null`);
    if (before && before.path === 'webgl' && before.frameSum > 5) break;
    await sleep(100);
  }
  check('camera begins on a lit WebGL frame', !!before && before.path === 'webgl' && before.frameSum > 5, JSON.stringify(before));

  const timeOrigin = await evalJS(cdp, 'performance.timeOrigin');
  const trigger = await evalJS(cdp, `World._dbgLoseCurveContext ? World._dbgLoseCurveContext() : ({ok:false,reason:'missing debug hook'})`);
  check('WEBGL_lose_context is available and invoked', !!trigger && trigger.ok === true, JSON.stringify(trigger));

  let after = null;
  for (let i = 0; i < 60; i++) {
    after = await evalJS(cdp, 'World._dbgCurveState()');
    if (after && after.path === 'cpu' && after.frameSum > 5) break;
    await sleep(100);
  }
  check('same page abandons WebGL for the CPU warp', !!after && after.path === 'cpu', JSON.stringify(after));
  check('camera feed stays lit after context loss', !!after && after.frameSum > 5, JSON.stringify(after));
  check('recovery does not reload the page', await evalJS(cdp, 'performance.timeOrigin') === timeOrigin);

  const lossWarnings = diagnostics.consoleMsgs.filter(row => /WebGL context lost.*CPU fallback/i.test(row.text));
  check('one truthful context-loss fallback warning is logged', lossWarnings.length === 1, JSON.stringify(diagnostics.consoleMsgs));
  check('context loss raises no uncaught exception', diagnostics.exceptions.length === 0, JSON.stringify(diagnostics.exceptions));
} catch (error) {
  console.log('FAIL harness :: ' + (error && error.stack || error));
  failures.push('harness');
} finally {
  try { cdp?.ws.close(); } catch {}
  await Promise.all([stopChild(chrome), stopChild(sidecar)]);
  const resolvedRoot = root.replace(/\\/g, '/');
  if (resolvedRoot.startsWith(tmpdir().replace(/\\/g, '/') + '/') && /starnet-crt-loss-/.test(resolvedRoot)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) throw error; await sleep(200); }
    }
  }
}

console.log('\n=== ' + (failures.length ? 'FAILURES: ' + failures.join(', ') : 'ALL CHECKS PASSED') + ' ===');
process.exit(failures.length ? 1 : 0);
