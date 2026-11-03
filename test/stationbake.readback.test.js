'use strict';

// A canvas readback may be altered by browser privacy/driver behavior. Inject it at
// the real canvas boundary, then exercise both public bake routes in both renderers.
// This verifies fault handling and drawing, not pixel fidelity of the fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(file) {
  let mode = 'clean', faultId = 257, lastRow = false;
  let previous = null;
  const warnings = [];
  const stats = { reads: 0, masks: 0, draws: 0 };
  const makeCanvas = () => {
    const cv = { width: 1, height: 1 };
    let ownerRaster = false;
    const state = { fillStyle: '' };
    const noOp = () => {};
    const g = new Proxy(state, {
      get(target, key) {
        if (key === 'canvas') return cv;
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: noOp });
        if (key === 'measureText') return () => ({ width: 1 });
        if (key === 'getImageData') return (_x, _y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          if (ownerRaster) {
            stats.reads++;
            if (mode === 'unreadable') throw new Error('synthetic readback unavailable');
            // A valid earlier column ensures invalid data cannot leave a partial mask.
            data[0] = 1; data[3] = 255;
            const i = ((lastRow ? h - 1 : 0) * w + 130) * 4;
            const id = mode === 'fault' ? faultId : 1;
            data[i] = id & 255; data[i + 1] = id >> 8; data[i + 3] = 255;
          }
          return { data, width: w, height: h };
        };
        if (key === 'createImageData') return (w, h) => {
          // The ownership mask has precisely the skirt's vertical margin.
          if (h === 72 + 88 || h === 384 + 88) stats.masks++;
          return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
        };
        if (key === 'drawImage') return () => { stats.draws++; };
        return key in target ? target[key] : noOp;
      },
      set(target, key, value) {
        if (key === 'fillStyle' && /^rgb\(1,0,0\)$/.test(value)) ownerRaster = true;
        target[key] = value; return true;
      }
    });
    cv.getContext = () => g;
    return cv;
  };
  const context = { module: { exports: {} }, document: { createElement: makeCanvas },
    U: { hash: () => 42, shade: color => color },
    console: { warn: (...args) => warnings.push(args.join(' ')) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  const api = context.module.exports;
  const COLS = 12, ROWS = 6, zoneGrid = new Array(COLS * ROWS).fill(null);
  const r = { z: 'r1', x1: 2, y1: 2, x2: 7, y2: 3 };
  const idx = (x, y) => y * COLS + x;
  for (let y = 2; y <= 3; y++) for (let x = 2; x <= 7; x++) zoneGrid[idx(x, y)] = 'r1';
  const geo = { TILE: 12, COLS, ROWS, W: 131, H: 72, origin: { tx: 0, ty: 0 },
    allRects: [r], zones: { r1: r }, ROOM_IDS: ['r1'], chamfers: [], windows: [], doorDefs: [], zoneGrid, idx,
    isCorridor: () => false, canStep: () => true, baseColorOf: () => '#30343a', nameOf: () => '',
    kindOf: () => 'hab', FLOOR_STYLES: { hull: { base: '#30343a' } } };
  return { warnings, run(route, nextMode, id = 257, atLastRow = false, reuse = false) {
    mode = nextMode; faultId = id; lastRow = atLastRow;
    stats.reads = stats.masks = stats.draws = 0;
    const result = route === 'whole' ? api.bake(geo)
      : api.bakeIncremental(geo, reuse ? previous : null, reuse ? geo.allRects : null);
    previous = result;
    assert.ok(result.baseCv || result.chunkMap, 'public bake returns drawable output');
    assert.ok(stats.reads > 0, 'injected data reached the ownership decoder');
    assert.ok(stats.draws > 0, 'fallback continues painting the station');
    return { ...stats };
  } };
}

for (const file of ['frontend/app/stationbake.js', 'frontend/agent-demo/stationbake.js']) {
  for (const route of ['whole', 'chunk']) {
    const f = fixture(file);
    const fallback = f.run(route, 'unreadable');
    const clean = f.run(route, 'clean');
    assert.ok(clean.masks > fallback.masks, file + ': valid ownership produces masks');
    for (const [id, atLastRow] of [[257, false], [65535, false], [0, false], [257, true]]) {
      const fault = f.run(route, 'fault', id, atLastRow);
      assert.deepEqual(fault, fallback, file + ': invalid ID discards the entire ownership pass');
    }
    assert.equal(f.warnings.length, 1, file + ': corrupt readback is reported without flooding each bake');
    assert.match(f.warnings[0], /ownership.*257.*fallback/i);
    assert.deepEqual(f.run(route, 'clean', 1, false, true), clean,
      file + ': a later clean bake (dirty cached chunk) recovers exact ownership');
  }
}
console.log('stationbake.readback: both renderers and bake routes survive invalid IDs and recover');
