'use strict';
const motion = { matches: false };
const window = { devicePixelRatio: 1, screen: {}, matchMedia: () => motion };
const document = { createElement: tag => {
  if (tag !== 'canvas') throw new Error('Backdrop baking only creates canvases');
  return new OffscreenCanvas(1, 1);
} };
let loaded = false;
self.onmessage = ({ data }) => {
  const { kind, token, id, width, height } = data;
  try {
    if (!['sky', 'ground'].includes(kind) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 20000000) throw new Error('Invalid bake dimensions');
    window.devicePixelRatio = data.dpr || 1; window.screen = data.screen || {}; motion.matches = !!data.reduced;
    if (!loaded) { importScripts('spacebg.js', 'terrain.js'); loaded = true; }
    if (kind === 'ground') {
      if (!Terrain.GROUNDS[id] || !Number.isFinite(data.scale) || data.scale <= 0) throw new Error('Invalid ground');
      Terrain.setGround(id);
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
      const cam = { scale: data.scale, panX: -data.left * data.scale, panY: -data.top * data.scale };
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.panX, cam.panY);
      Terrain.draw(ctx, cam, width, height, data.station);
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ token, bitmap }, [bitmap]);
      return;
    }
    const built = SpaceBG.bake(id, width, height), transfers = [], seen = new Map();
    // THE VOID's additional animation plates are generators in the direct renderer.
    // Finish them here; generator closures cannot cross the worker boundary.
    while (built.state.nebJobs?.length) {
      let result;
      do { result = built.state.nebJobs[0].next(); } while (!result.done);
      built.state.nebPlates.push(result.value);
      built.state.nebJobs.shift();
    }
    function pack(value) {
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return seen.get(value);
      if (value instanceof OffscreenCanvas) {
        const bitmap = value.transferToImageBitmap(); seen.set(value, bitmap); transfers.push(bitmap); return bitmap;
      }
      if (ArrayBuffer.isView(value)) return value;
      const out = Array.isArray(value) ? [] : {}; seen.set(value, out);
      for (const [key, child] of Object.entries(value)) out[key] = pack(child);
      return out;
    }
    self.postMessage({ token, ...pack(built) }, transfers);
  } catch (_) { self.postMessage({ token, failed: true }); }
};
