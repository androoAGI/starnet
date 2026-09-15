import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchChrome, connectCDP, evalJS, sleep, capture, collectDiagnostics } from '../../scripts/lib/cdp.mjs';
const out = path.resolve('.dogfood/catalog-review'); fs.mkdirSync(out, { recursive: true });
const { proc } = launchChrome({ cdpPort: 18837, profileDir: path.join(out, 'browser-profile'), win: '1440,1100' });
let cdp;
try {
  cdp = await connectCDP(18837); const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:18836/prop-catalog-review.html?propSet=projection' });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evalJS(cdp, '!!window.PropCatalogReviewState');
    if (ready) break;
    const error = await evalJS(cdp, "document.body?.dataset.result==='error'?document.getElementById('report')?.textContent:null");
    if (error) throw Error(error); await sleep(300);
  }
  assert.ok(ready, 'Fixture did not initialize');
  await capture(cdp, out, 'first-room');
  const rooms = [], covered = new Set();
  for (let i = 0; i < 35; i++) {
    const state = await evalJS(cdp, 'window.PropCatalogReviewState');
    state.keys.forEach(k => covered.add(k));
    assert.deepEqual(state.violations, [], 'Illegal room placement'); assert.deepEqual(state.missing, [], 'Missing source art');
    assert.deepEqual(state.assetFailures, [], 'Asset loader failure'); assert.deepEqual(state.runtimeDrift, [], 'Runtime catalog drift');
    const fallback = state.mounts.filter(p => !p.authored); assert.deepEqual(fallback, [], 'Surface mount fallback');
    await evalJS(cdp, "document.getElementById('power').click()");
    assert.equal((await evalJS(cdp, 'window.PropCatalogReviewState')).powered, true);
    await evalJS(cdp, "document.getElementById('power').click()");
    rooms.push({ keys: state.keys, mounts: state.mounts.length, rendered: state.rendered });
    if (await evalJS(cdp, "document.getElementById('next').disabled")) break;
    await evalJS(cdp, "document.getElementById('next').click()");
  }
  assert.equal(covered.size, 208);
  await evalJS(cdp, "document.getElementById('search').value='mug';document.getElementById('search').dispatchEvent(new Event('input'))");
  assert.deepEqual((await evalJS(cdp, 'window.PropCatalogReviewState')).keys, ['mug:s']);
  await evalJS(cdp, "document.getElementById('power').click();document.getElementById('outlines').click()");
  assert.equal((await evalJS(cdp, 'window.PropCatalogReviewState')).powered, true);
  await capture(cdp, out, 'surface-room');
  const pixel = await evalJS(cdp, "Array.from(document.getElementById('prop-catalog-fixture').getContext('2d').getImageData(120,120,1,1).data)");
  assert.ok(pixel[3] > 0, 'Room canvas is blank');
  const receipt = { fixtureOnly: true, types: 160, directions: covered.size, states: ['idle', 'powered-fixture'], rooms, pixel, exceptions: diagnostics.exceptions, savedStationAcceptance: false };
  fs.writeFileSync(path.join(out, 'browser-receipt.json'), JSON.stringify(receipt, null, 2));
  assert.deepEqual(diagnostics.exceptions, []);
  console.log(JSON.stringify({ types: 160, directions: covered.size, rooms: rooms.length, pixel, exceptions: diagnostics.exceptions.length }));
} finally { cdp?.ws.close(); proc.kill(); }
