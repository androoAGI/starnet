/* Real Canvas regression for the two-pixel hull lip at connected wall crowns.
   The reference changes only that lip back to its previous fill; fixtures never
   touch the app, sidecar or saved station. Wall dimensions/art stay unchanged. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { findChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const sharedSource = ['frontend/js/util.js', 'frontend/app/worldmodel.js', 'frontend/app/worldsurface.js']
  .map(path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')).join('\n');
const source = readFileSync(new URL('../frontend/app/stationbake.js', import.meta.url), 'utf8');
const lip = /\/\/ NORTH-LIP-CROWN-BEGIN[\s\S]*?\/\/ NORTH-LIP-CROWN-END/g;
assert.equal([...source.matchAll(lip)].length, 1, 'one bounded lip repair provides the controlled reference');
const reference = source.replace(lip, 'b.fillStyle = hullEdge(e.z); b.fillRect(X, topY - capH - 2, T, 2);');
const freePort = () => new Promise((done, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(error => error ? reject(error) : done(port));
  });
});
const stop = child => new Promise(done => {
  if (!child || child.exitCode != null) { done(); return; }
  const timer = setTimeout(done, 3000); child.once('exit', () => { clearTimeout(timer); done(); });
  try { child.kill('SIGKILL'); } catch { clearTimeout(timer); done(); }
});
function probe(current, legacy) {
  let checks = 0; const failures = [], changes = {};
  const check = (ok, name) => { checks++; if (!ok) failures.push(name); };
  const R = (z, x1, y1, x2, y2) => ({ z, x1, y1, x2, y2 });
  const J = (boundary, y, side) => ({ boundary, y, side });
  const transfer = [R('A', 0, 0, 15, 10), R('B', 20, 0, 38, 10), R('H', 16, 4, 19, 6)];
  const palettes = { A: { wallStyle: 'sterile', wallMat: 'panelled' }, B: { wallStyle: 'rust', wallMat: 'service' } };
  const fixtures = [
    { name: 'TRANSFER', rects: transfer, joins: [J(16, 4, 'left'), J(20, 4, 'right')], palettes },
    { name: 'mirrored-palettes', rects: transfer.map(r => R(r.z, 38-r.x2, r.y1, 38-r.x1, r.y2)),
      joins: [J(19, 4, 'left'), J(23, 4, 'right')],
      palettes: { A: { wallStyle: 'indigo', wallMat: 'plating' }, B: { wallStyle: 'verdant', wallMat: 'ribbed' } } },
    { name: 'same-zone-right-L', rects: [R('H', 0, 0, 15, 10), R('H', 16, 8, 24, 10)], joins: [J(16, 8, 'left')] },
    { name: 'same-zone-left-L', rects: [R('H', 9, 0, 24, 10), R('H', 0, 8, 8, 10)], joins: [J(9, 8, 'right')] },
    { name: 'same-zone-T', rects: [R('H', 10, 0, 12, 18), R('H', 0, 8, 9, 10), R('H', 13, 8, 22, 10)],
      joins: [J(10, 8, 'right'), J(13, 8, 'left')] },
    { name: 'closed-left', rects: transfer, joins: [J(20, 4, 'right')], trunk: 'B',
      seal: { x: 2, y: 2, door: 'closed' }, blocked: J(16, 4, 'left'), palettes },
    { name: 'jammed-right', rects: transfer, joins: [J(16, 4, 'left')], trunk: 'A',
      seal: { x: 22, y: 2, door: 'jammed' }, blocked: J(20, 4, 'right'), palettes },
    { name: 'disconnected', rects: [transfer[0], transfer[1], R('H', 17, 4, 18, 6)], joins: [] },
    { name: 'no-side-crown-above', rects: [R('A', 0, 4, 15, 10), R('H', 16, 4, 19, 6)], joins: [] },
    { name: 'chamfer-is-not-a-side-crown', rects: [R('A', 0, 1, 15, 10), R('H', 16, 4, 19, 6)], joins: [] },
    { name: 'chunk-boundary', rects: [R('C', 0, 0, 5, 5), ...transfer.map(r => R(r.z, r.x1+13, r.y1, r.x2+13, r.y2))],
      joins: [J(29, 4, 'left'), J(33, 4, 'right')], palettes, chunks: true }
  ];
  const make = f => {
    const doc = WorldModel.defaultDoc(1); doc.rooms = {}; doc.order = []; doc.props = []; doc.belts = {}; doc.edges = [];
    doc.meta.spawnRoomId = null; doc.meta.trunkRoomId = f.trunk || null;
    for (const r of f.rects) {
      if (!doc.rooms[r.z]) {
        doc.order.push(r.z); doc.rooms[r.z] = { id: r.z, name: '', kind: r.z === 'H' ? 'corridor' : 'hab', rects: [],
          floorStyle: 'hull', floorMat: 'alloy', wallStyle: 'hull', wallMat: 'ribbed', hullStyle: null, hullMat: null,
          floorPaint: {}, ...f.palettes?.[r.z] };
      }
      const { z, ...rect } = r; doc.rooms[z].rects.push(rect);
    }
    if (f.seal) doc.props.push({ id: 'seal', t: 'airlock', w: 1, h: 1, block: false, ...f.seal });
    return WorldModel.create(doc);
  };
  const pixels = cv => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const bands = (g, joins) => joins.map(j => ({
    x: (j.boundary-g.origin.tx)*12 + (j.side === 'left' ? 1 : -6),
    y: (j.y-g.origin.ty)*12-36, w: 5, h: 2
  }));
  const compare = (name, g, a, b, joins) => {
    const expected = new Set(), ab = pixels(a.baseCv), bb = pixels(b.baseCv);
    for (const r of bands(g, joins)) for (let y = r.y; y < r.y+r.h; y++) for (let x = r.x; x < r.x+r.w; x++) {
      expected.add(y*g.W+x);
      const i = (y*g.W+x)*4, above = ((r.y-1)*g.W+x)*4;
      check(same(ab.slice(i, i+4), ab.slice(above, above+4)), name+' continuous original side-rail colour at '+x+','+y);
      check(ab[i+3] === 255 && bb[i+3] === 255, name+' repairs existing opaque wall only at '+x+','+y);
    }
    let changed = 0, outside = 0, alpha = 0;
    for (let i = 0; i < ab.length; i += 4) {
      if (ab[i] !== bb[i] || ab[i+1] !== bb[i+1] || ab[i+2] !== bb[i+2] || ab[i+3] !== bb[i+3]) {
        changed++; if (!expected.has(i/4)) outside++;
      }
      if (ab[i+3] !== bb[i+3]) alpha++;
    }
    changes[name] = changed;
    check(changed === expected.size, name+' changes exactly '+expected.size+' original lip pixels (got '+changed+')');
    check(outside === 0, name+' leaves every pixel beyond crown intersections unchanged (got '+outside+')');
    check(alpha === 0, name+' preserves the entire wall silhouette');
    for (const layer of ['lightCv', 'interiorCv'])
      check(same(pixels(a[layer]), pixels(b[layer])), name+' preserves '+layer+' byte-for-byte');
    const shape = bake => (bake.doorOccluders || []).map(({ image, ...rect }) => rect);
    check(JSON.stringify(shape(a)) === JSON.stringify(shape(b)), name+' preserves occluder geometry');
    (a.doorOccluders || []).forEach((d, i) => check(same(pixels(d.image), pixels(b.doorOccluders[i].image)), name+' preserves occluder art '+i));
  };
  const compose = (g, baked) => {
    const result = {};
    for (const layer of ['baseCv', 'lightCv', 'interiorCv']) {
      const cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
      const ctx = cv.getContext('2d');
      for (const chunk of baked.chunkMap.values()) ctx.drawImage(chunk[layer], chunk.x, chunk.y);
      result[layer] = cv;
    }
    return result;
  };
  check(current.WALL.up === 30 && current.WALL.corUp === 30 && current.WALL.capH === 4 && current.WALL.sideCap === 5,
    'keeps the original raised-wall and crown dimensions');
  for (const f of fixtures) {
    const model = make(f), before = JSON.stringify(model.serialize()), g = model.projectGeometry();
    const passable = j => {
      const x = j.boundary-g.origin.tx, y = j.y-g.origin.ty;
      return g.canStep(x-1, y, x, y) || g.canStep(x, y, x-1, y);
    };
    for (const j of f.joins) check(passable(j), f.name+' fixture has a real open connection at '+j.boundary);
    if (f.blocked) check(!passable(f.blocked), f.name+' fixture has a genuinely sealed contact');
    const a = current.bake(g), b = legacy.bake(g);
    compare(f.name, g, a, b, f.joins);
    if (f.chunks) {
      const ca = compose(g, current.bakeIncremental(g, null, null));
      const cb = compose(g, legacy.bakeIncremental(g, null, null));
      compare(f.name+' incremental', g, ca, cb, f.joins);
      const ap = pixels(a.baseCv), cp = pixels(ca.baseCv);
      for (const r of bands(g, f.joins)) for (let y = r.y-1; y < r.y+r.h; y++) for (let x = r.x; x < r.x+r.w; x++) {
        const i = (y*g.W+x)*4;
        check(same(ap.slice(i, i+4), cp.slice(i, i+4)), 'chunk seam agrees with full bake at '+x+','+y);
      }
    }
    check(JSON.stringify(model.serialize()) === before, f.name+' leaves the station document untouched');
  }
  return { checks, failures, changes };
}
let chrome, cdp, profile, failed = false;
try {
  const port = await freePort(); profile = mkdtempSync(join(tmpdir(), 'starnet-connection-render-'));
  chrome = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--remote-debugging-port='+port, '--user-data-dir='+profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  cdp = await connectCDP(port);
  const result = await evalJS(cdp, '(()=>{'+sharedSource+'\nconst current=(()=>{'+source+';return StationBake;})();\n'+
    'const legacy=(()=>{'+reference+';return StationBake;})();\nreturn ('+probe.toString()+')(current,legacy);})()');
  assert.deepEqual(result.failures, [], result.failures.slice(0, 12).join('\n'));
  console.log('stationbake.connections: '+result.checks+' real Canvas assertions passed; '+JSON.stringify(result.changes));
} catch (error) { failed = true; console.error(error.stack || error); }
finally {
  try { cdp?.ws.close(); } catch {} await stop(chrome);
  if (profile) {
    const rel = relative(resolve(tmpdir()), resolve(profile));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('starnet-connection-render-'), 'cleanup stays inside unique test temp directory');
    for (let attempt = 0; attempt < 10; attempt++) try { rmSync(profile, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) throw error; await sleep(200); }
  }
}
process.exit(failed ? 1 : 0);
