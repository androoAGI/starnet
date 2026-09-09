/* The same deterministic sky/ground sample functions, with scratch OffscreenCanvases.
   No station state is imported or modified. Only finished thumbnail pixels cross threads. */
'use strict';
const motion = { matches: false };
const window = { devicePixelRatio: 1, screen: {}, matchMedia: () => motion };
const document = { createElement: tag => {
  if (tag !== 'canvas') throw new Error('Backdrop samples only create canvases');
  return new OffscreenCanvas(1, 1);
} };
let loaded = false;
self.onmessage = ({ data }) => {
  const { token, id, width, height } = data;
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 256) throw new Error('Invalid sample size');
    window.devicePixelRatio = data.dpr || 1; window.screen = data.screen || {}; motion.matches = !!data.reduced;
    if (!loaded) { importScripts('terrain.js', 'spacebg.js'); loaded = true; }
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    if (Terrain.GROUNDS[id]) Terrain.paintSample(ctx, width, height, id);
    else SpaceBG.paintSample(ctx, width, height, id, 8000);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ token, bitmap }, [bitmap]);
  } catch (_) { self.postMessage({ token, failed: true }); }
};
