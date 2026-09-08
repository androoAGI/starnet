/* Real Canvas regression: projected north walls are interior receivers, but are NOT floor.
   Applying the full floor ambient to their screen coordinates produced a horizontal black band
   over both wall art and prop tops. Exercise the actual WorldLight in an isolated blank Chromium
   page, through all three supported bake representations. No sidecar or saved-world writes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { findChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const source = readFileSync(new URL('../frontend/app/worldlight.js', import.meta.url), 'utf8');
const freePort = () => new Promise((done, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(error => error ? reject(error) : done(port));
  });
});
const stopChild = child => new Promise(done => {
  if (!child || child.exitCode != null) { done(); return; }
  const timer = setTimeout(done, 3000);
  child.once('exit', () => { clearTimeout(timer); done(); });
  try { child.kill('SIGKILL'); } catch { clearTimeout(timer); done(); }
});

function probe(sourceText) {
  const WorldLight = new Function(sourceText + ';return WorldLight;')();
  const W = 80, H = 70, T = 10;
  const canvas = () => { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; return cv; };
  // Physical deck is x=20..60, y=30..60. Its visible north wall rises to y=10.
  // The small stepped corner cut belongs to the exact bake mask, not allRects.
  const receiver = new Path2D();
  receiver.rect(20, 10, 40, 20);
  receiver.rect(23, 30, 37, 3); receiver.rect(20, 33, 40, 27);
  const mask = canvas(), maskCtx = mask.getContext('2d');
  maskCtx.fillStyle = '#fff'; maskCtx.fill(receiver);
  const zoneGrid = Array(W / T * H / T).fill(null);
  for (let y = 3; y < 6; y++) for (let x = 2; x < 6; x++) zoneGrid[y * 8 + x] = 'room';
  const geo = { W, H, TILE: T, COLS: 8, ROWS: 7, zoneGrid,
    allRects: [{ x1: 2, y1: 3, x2: 5, y2: 5, z: 'room' }], chamfers: [[2, 3, 'tl']] };
  const pixel = (cv, x, y) => Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data);
  const points = { wall: [30, 20], sentinelWall: [40, 20], deck: [30, 45], sentinelDeck: [40, 45],
    void: [10, 20], corner: [21, 31], chunkLeft: [39, 20], chunkRight: [40, 20] };
  const sample = cv => Object.fromEntries(Object.entries(points).map(([name, xy]) => [name, pixel(cv, ...xy)]));
  const scene = () => {
    const cv = canvas(), g = cv.getContext('2d');
    g.fillStyle = 'rgb(60,80,100)'; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgb(140,160,180)'; g.fill(receiver);
    // Bright real raster sentinel crosses the raised wall / physical deck seam.
    g.fillStyle = 'rgb(230,190,150)'; g.fillRect(37, 17, 6, 31);
    return cv;
  };
  const chunks = [0, 40].map(x => {
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = H;
    cv.getContext('2d').drawImage(mask, -x, 0);
    return { x, y: 0, w: 40, h: H, baseCv: cv, interiorCv: cv };
  });
  const output = [];
  for (const mode of ['path', 'mask', 'chunks']) {
    const options = { width: W, height: H, tileSize: T };
    if (mode === 'chunks') options.surfaceChunks = chunks;
    else {
      options.surfaceMask = mask;
      if (mode === 'path') options.interiorPath = receiver;
      else options.interiorMask = mask;
    }
    const light = WorldLight.create({ quality: 'high', wallAmbient: .16, fixtureTint: 0, shafts: 0 });
    if (!light.setGeometry(geo, options)) throw new Error('Actual canvas lighting setup failed: ' + mode);
    const dark = canvas(), darkScene = scene(), lit = canvas(), litScene = scene();
    const darkFrame = { ambient: .82, fixtures: [], lights: [], reducedMotion: true };
    if (!light.render(dark.getContext('2d'), darkFrame)) throw new Error('Dark pass failed: ' + mode);
    light.render(darkScene.getContext('2d'), darkFrame);
    const litFrame = { ...darkFrame, fixtures: [{ x: 40, y: 45, r: 28, c: [255, 230, 200], a: .85 }] };
    light.render(lit.getContext('2d'), litFrame); light.render(litScene.getContext('2d'), litFrame);
    output.push({ mode, dark: sample(dark), darkScene: sample(darkScene), lit: sample(lit), litScene: sample(litScene),
      stats: light.stats() });
    light.dispose();
  }
  return output;
}

let chrome, cdp, profile, failed = false;
try {
  const executable = findChrome(), port = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'starnet-wall-receiver-'));
  chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  cdp = await connectCDP(port);
  const result = await evalJS(cdp, '(' + probe.toString() + ')(' + JSON.stringify(source) + ')');
  const close = (actual, expected, label, tolerance = 2) => assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: got ${actual}, expected ${expected} (+/-${tolerance})`);
  for (const row of result) {
    console.log(`${row.mode}: wall alpha=${row.dark.wall[3]}, deck alpha=${row.dark.deck[3]}, lit deck alpha=${row.lit.deck[3]}`);
    close(row.dark.wall[3], 255 * .16, row.mode + ' raised wall receives only wall ambient');
    close(row.dark.sentinelWall[3], 255 * .16, row.mode + ' projected prop top avoids heavy floor ambient');
    close(row.dark.deck[3], 255 * (.208 + .82 * .6), row.mode + ' deck keeps configured room ambient');
    assert.ok(row.lit.deck[3] < row.dark.deck[3] - 30, row.mode + ' physical deck responds to the actual fixture');
    assert.ok(row.litScene.sentinelDeck[0] > row.darkScene.sentinelDeck[0] + 30, row.mode + ' deck part of prop responds to light');
    for (const state of ['dark', 'lit']) {
      close(row[state].wall[3], 255 * .16, row.mode + ' wall exposure remains independent of a floor LOS cutoff');
      assert.equal(row[state].void[3], 0, row.mode + ' darkness/glow cannot cover empty space');
      assert.equal(row[state].corner[3], 0, row.mode + ' exact corner mask clips darkness and glow');
      assert.deepEqual(row[state + 'Scene'].void, [60, 80, 100, 255], row.mode + ' void backdrop stays unchanged');
      assert.deepEqual(row[state + 'Scene'].corner, [60, 80, 100, 255], row.mode + ' corner backdrop stays unchanged');
      for (let c = 0; c < 3; c++) {
        close(row[state + 'Scene'].sentinelWall[c], [230, 190, 150][c] * .84 + [4, 8, 18][c] * .16,
          row.mode + ' prop top is attenuated only by wall ambient');
      }
      assert.deepEqual(row[state].chunkLeft, row[state].chunkRight, row.mode + ' no mask seam at chunk boundary');
    }
  }
  for (const row of result.slice(1)) {
    assert.deepEqual(row.dark, result[0].dark, row.mode + ' darkness matches exact-path receiver');
    assert.deepEqual(row.lit, result[0].lit, row.mode + ' fixture clipping matches exact-path receiver');
  }
  console.log('worldlight-receiver: actual Canvas wall/deck separation, crossing prop, void and corners passed for path/mask/chunks');
} catch (error) { failed = true; console.error(error.stack || error); }
finally {
  try { cdp?.ws.close(); } catch {}
  await stopChild(chrome);
  if (profile) {
    const rel = relative(resolve(tmpdir()), resolve(profile));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('starnet-wall-receiver-'), 'cleanup stays inside its own test temp directory');
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) throw error; await sleep(200); }
    }
  }
}
process.exit(failed ? 1 : 0);
