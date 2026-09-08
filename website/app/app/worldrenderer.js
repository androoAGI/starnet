/* StarNet generation II scene compositor.
 * Geometry and work state arrive from the existing model/simulation. This module owns
 * draw order, light lifecycle and measured render costs; it cannot emit harness events.
 * A renderer backend can change here without changing the station save or its mechanics.
 */
'use strict';
const WorldRenderer = (() => {
  const GENERATION = 'II';
  // Tuned in the running CRT lab: retain a visible tube while resolving material
  // highlights and sprite detail instead of smearing them into the same grey band.
  const PHOSPHOR = Object.freeze({ scan: .26, pitch: 1, fade: .18, curve: .06, vig: .20,
    over: 1.13, dust: .35, aberr: .08, grain: .06, bloom: .14 });
  const FRAME_WINDOW = 120;
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  let classic = false;
  try { classic = new URLSearchParams(location.search).get('world') === 'classic'; } catch (_) {}

  function visibleRect(camera) {
    const c = camera || {}, scale = Math.max(0.01, finite(c.scale, 1));
    return { x: -finite(c.panX, 0) / scale, y: -finite(c.panY, 0) / scale,
      w: Math.max(0, finite(c.width, 0)) / scale, h: Math.max(0, finite(c.height, 0)) / scale };
  }
  function intersects(a, b, padding) {
    const p = Math.max(0, finite(padding, 0));
    return !!(a && b && a.x + a.w + p >= b.x && a.x - p <= b.x + b.w &&
      a.y + a.h + p >= b.y && a.y - p <= b.y + b.h);
  }
  function sortedItems(items) {
    // Explicit tie ordering preserves doc-order furniture and the bed/seat half-pixel keys.
    return (items || []).map((item, index) => ({ item, index }))
      .sort((a, b) => finite(a.item.y, 0) - finite(b.item.y, 0) || a.index - b.index)
      .map(entry => entry.item);
  }
  function percentile(values, quantile) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] * 100) / 100;
  }
  function create(options) {
    options = options || {};
    let geometry = null, baked = null, lighting = null, frame = null;
    let frames = 0, rebuilds = 0, entityCount = 0, lastStart = 0, startedAt = 0;
    let elapsed = [], durations = [], lightDurations = [], lightingMs = 0;
    const push = (array, value) => { array.push(value); if (array.length > FRAME_WINDOW) array.shift(); };
    const canLight = () => !classic && typeof WorldLight !== 'undefined';
    function begin(input) {
      frame = input || {};
      startedAt = clock();
      const timestamp = finite(frame.now, startedAt);
      if (lastStart && timestamp > lastStart && timestamp - lastStart < 1000) push(elapsed, timestamp - lastStart);
      lastStart = timestamp;
      if (frame.geo !== geometry || frame.cache !== baked) {
        geometry = frame.geo; baked = frame.cache; rebuilds++;
        if (canLight()) {
          if (!lighting) lighting = WorldLight.create({ quality: 'high' });
          lighting.setGeometry(geometry, { width: baked.W, height: baked.H,
            tileSize: geometry.TILE, interiorPath: baked.interiorPath, interiorMask: baked.interiorCv, surfaceMask: baked.baseCv,
            surfaceChunks: baked.chunks });
        }
      }
      entityCount = 0;
      lightingMs = 0;
    }
    function drawBase(ctx) {
      if (baked && baked.baseCv) ctx.drawImage(baked.baseCv, 0, 0);
    }
    function drawEntities(ctx, items) {
      entityCount = (items || []).length;
      for (const item of sortedItems(items)) item.draw(ctx);
    }
    function drawGrounding(ctx, bodies) {
      if (lighting && lighting.drawGrounding) lighting.drawGrounding(ctx, bodies || []);
    }
    function drawAtmosphere(ctx, params) {
      if (!lighting || !lighting.drawAtmosphere) return false;
      lighting.drawAtmosphere(ctx, Object.assign({ now: frame.now, reducedMotion: !!frame.reducedMotion }, params || {}));
      return true;
    }
    function drawLight(ctx, lights, params) {
      if (!lighting || classic) return false;
      const t = clock();
      const rendered = lighting.render(ctx, Object.assign({ lights: lights || [], fixtures: (baked.lamps || baked.flickers || []).concat(baked.wallFixtures || []),
        now: frame.now, reducedMotion: !!frame.reducedMotion }, params || {}));
      lightingMs = clock() - t;
      return rendered;
    }
    function finish() {
      if (!frame) return;
      frames++;
      push(durations, Math.max(0, clock() - startedAt));
      push(lightDurations, lightingMs);
    }
    function stats() {
      return { generation: classic ? 'classic' : GENERATION, frames, rebuilds, entities: entityCount,
        frameIntervalMedianMs: percentile(elapsed, .5), frameIntervalP95Ms: percentile(elapsed, .95),
        renderMedianMs: percentile(durations, .5), renderP95Ms: percentile(durations, .95),
        lightingMedianMs: percentile(lightDurations, .5), samples: durations.length,
        viewport: frame ? visibleRect(frame) : null,
        lighting: lighting && lighting.stats ? lighting.stats() : null };
    }
    function dispose() {
      if (lighting && lighting.dispose) lighting.dispose();
      lighting = null; geometry = null; baked = null; frame = null;
      elapsed = []; durations = []; lightDurations = []; lastStart = 0;
    }
    return { begin, drawBase, drawEntities, drawGrounding, drawAtmosphere, drawLight, finish, stats, dispose };
  }
  return { GENERATION, PHOSPHOR, enabled: () => !classic, create, visibleRect, intersects, sortedItems, percentile };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldRenderer;
