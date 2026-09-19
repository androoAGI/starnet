import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, waitDevReady } from '../scripts/lib/seed.mjs';
import { buildStates } from '../scripts/lib/states.mjs';
const require = createRequire(import.meta.url);
const { SidecarFixture, allocatePort } = require('../test/helpers/sidecar-fixture.js');
const out = path.resolve('.dogfood/reliability-audit');
const fixture = SidecarFixture.create({ timeoutMs: 20000, env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
const rows = [];
try {
  materializeSeedWorkspace(fixture.workspace, 'test/model'); await fixture.start();
  const port = await allocatePort();
  browser = launchChrome({ cdpPort: port, profileDir: path.join(out, 'panel-browser') });
  cdp = await connectCDP(port); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  assert.equal(await waitDevReady(cdp, evalJS, { url: fixture.baseUrl }), true);
  for (const state of buildStates()) {
    const start = diagnostics.exceptions.length;
    const driven = await evalJS(cdp, state.drive);
    await sleep(state.wait || 900);
    const observed = await evalJS(cdp, `(()=>{
      const controls=[...document.querySelectorAll('button,input,select,textarea')].filter(e=>e.offsetParent!==null);
      const native=controls.filter(e=>{const s=getComputedStyle(e);return ['rgb(255, 255, 255)','rgb(239, 239, 239)'].includes(s.backgroundColor)||s.borderColor==='rgb(118, 118, 118)';}).map(e=>e.id||e.className||e.tagName);
      return {visibleControls:controls.length,nativePaint:native};
    })()`);
    rows.push({ state: state.name, driven, ...observed, exceptions: diagnostics.exceptions.slice(start) });
  }
  fs.writeFileSync(path.join(out, 'panels-live.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows, null, 2));
  for (const row of rows) {
    assert.ok(!/NOTFOUND|ERROR/.test(String(row.driven)), 'surface reached: ' + row.state);
    assert.deepEqual(row.exceptions, [], 'no uncaught exception: ' + row.state);
    assert.deepEqual(row.nativePaint, [], 'themed controls: ' + row.state);
  }
} finally {
  if (cdp) cdp.ws.close();
  if (browser) { const exited = new Promise(resolve => browser.proc.once('exit', resolve)); browser.proc.kill(); await exited; }
  await fixture.dispose();
}
