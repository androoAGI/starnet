/* StarNet generation II scene compositor.
 * Geometry and work state arrive from the existing model/simulation. This module owns
 * draw order, light lifecycle and measured render costs; it cannot emit harness events.
 * A renderer backend can change here without changing the station save or its mechanics.
 */
'use strict';
const WorldRenderer = (() => {
  const GENERATION = 'II';
  // Live-compared industrial finish: deep mids, readable cool/warm equipment,
  // crisp materials, and restrained tube texture without a lifted-black veil.
  const PHOSPHOR = Object.freeze({ scan: .025, pitch: 1, fade: 0, curve: 0, vig: .06,
    over: 1.02, dust: .08, aberr: 0, grain: .04, bloom: .08, sharpen: .28, film: .12 });
  // Five-tap local contrast, bounded by the existing neighbourhood. Flat light
  // gradients stay quiet; no bright/dark ringing is introduced beyond an edge.
  const DETAIL_GLSL = `
    vec3 detailAt(vec2 uv, vec3 col) {
      if(uSharp <= 0.0) return col;
      vec3 c = texture2D(uTex, uv).rgb;
      vec3 a = texture2D(uTex, uv + vec2(uInvW, 0.0)).rgb;
      vec3 b = texture2D(uTex, uv - vec2(uInvW, 0.0)).rgb;
      vec3 d = texture2D(uTex, uv + vec2(0.0, uInvH)).rgb;
      vec3 e = texture2D(uTex, uv - vec2(0.0, uInvH)).rgb;
      vec3 lo = min(c, min(min(a,b), min(d,e)));
      vec3 hi = max(c, max(max(a,b), max(d,e)));
      vec3 span = hi-lo;
      float gate = clamp((max(span.r,max(span.g,span.b))*255.0-5.0)/20.0,0.0,1.0);
      return clamp(col + (c-(a+b+d+e)*0.25)*uSharp*gate, min(lo,col), max(hi,col));
    }
  `;
  function sharpenSample(pixels, index, width, height, amount) {
    const c = pixels[index];
    if (!(amount > 0)) return c;
    const x = index % width;
    const a = pixels[x + 1 < width ? index + 1 : index], b = pixels[x ? index - 1 : index];
    const d = pixels[index + width < width * height ? index + width : index], e = pixels[index >= width ? index - width : index];
    if (c === a && c === b && c === d && c === e) return c;
    const r=c&255,g=(c>>>8)&255,bl=(c>>>16)&255;
    const lr=Math.min(r,a&255,b&255,d&255,e&255),hr=Math.max(r,a&255,b&255,d&255,e&255);
    const lg=Math.min(g,(a>>>8)&255,(b>>>8)&255,(d>>>8)&255,(e>>>8)&255),hg=Math.max(g,(a>>>8)&255,(b>>>8)&255,(d>>>8)&255,(e>>>8)&255);
    const lb=Math.min(bl,(a>>>16)&255,(b>>>16)&255,(d>>>16)&255,(e>>>16)&255),hb=Math.max(bl,(a>>>16)&255,(b>>>16)&255,(d>>>16)&255,(e>>>16)&255);
    const gate=Math.min(1,Math.max(0,(Math.max(hr-lr,hg-lg,hb-lb)-5)/20));
    if (!gate) return c;
    const k=Math.min(.6,amount)*gate*.25;
    const rr=Math.round(Math.max(lr,Math.min(hr,r+(r*4-((a&255)+(b&255)+(d&255)+(e&255)))*k)));
    const gg=Math.round(Math.max(lg,Math.min(hg,g+(g*4-(((a>>>8)&255)+((b>>>8)&255)+((d>>>8)&255)+((e>>>8)&255)))*k)));
    const bb=Math.round(Math.max(lb,Math.min(hb,bl+(bl*4-(((a>>>16)&255)+((b>>>16)&255)+((d>>>16)&255)+((e>>>16)&255)))*k)));
    return ((c&0xff000000)|(bb<<16)|(gg<<8)|rr)>>>0;
  }
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
  /* 2.5D depth contract.
     The world remains a fast 2D canvas, but drawable items may expose an optional depth/elevation
     value. This lets tall props, raised surfaces and future vertical planes participate in one
     deterministic compositor without changing the saved WorldModel. Existing items have no depth
     field and therefore retain the exact legacy y-order.

     Supported optional fields (highest priority first):
       depthY / depth  — explicit projected depth supplied by the world layer
       z / elevation   — vertical placement expressed as a small depth correction
       y               — legacy footprint/contact line
     height is intentionally NOT added to the sort key: height changes silhouette, not where an
     object's footprint meets the ground. That distinction prevents tall props from incorrectly
     jumping in front of agents merely because they are visually high.
  */
  function depthKey(item) {
    if (!item) return 0;
    const y = finite(item.y, 0);
    const explicit = Number.isFinite(Number(item.depthY)) ? Number(item.depthY) :
      Number.isFinite(Number(item.depth)) ? Number(item.depth) : null;
    if (explicit != null) return explicit;
    const z = Number.isFinite(Number(item.z)) ? Number(item.z) :
      Number.isFinite(Number(item.elevation)) ? Number(item.elevation) : 0;
    return y + z;
  }
  function sortedItems(items) {
    // Explicit tie ordering preserves doc-order furniture and the bed/seat half-pixel keys.
    // When 2.5D metadata is present, depthKey becomes the projected ground/depth coordinate.
    return (items || []).map((item, index) => ({ item, index }))
      .sort((a, b) => depthKey(a.item) - depthKey(b.item) || finite(a.item.y, 0) - finite(b.item.y, 0) || a.index - b.index)
      .map(entry => entry.item);
  }
  /* Returns a deterministic vertical occlusion hint without changing the saved world.
     Callers can use it when a renderer has separate ground/agent/prop passes. */
  function verticalOcclusion(item) {
    if (!item) return 0;
    const h = Number.isFinite(Number(item.height)) ? Number(item.height) : 0;
    const z = Number.isFinite(Number(item.z)) ? Number(item.z) :
      Number.isFinite(Number(item.elevation)) ? Number(item.elevation) : 0;
    return Math.max(0, h + z);
  }
  function compareDepth(a, b) {
    return depthKey(a) - depthKey(b) || verticalOcclusion(a) - verticalOcclusion(b);
  }
  function percentile(values, quantile) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] * 100) / 100;
  }
  function cameraReadout(input) {
    const {geo, viewport, subject, linked, paused} = input || {};
    const state = paused ? 'paused' : linked ? 'live' : 'offline';
    let place = 'TJ OS ECOSYSTEM';
    if (geo && viewport) {
      const x = subject ? subject.px : viewport.x + viewport.w / 2;
      const y = subject ? subject.py : viewport.y + viewport.h / 2;
      const T = geo.TILE || 12, tx = Math.floor(x / T), ty = Math.floor(y / T);
      const id = tx >= 0 && ty >= 0 && tx < geo.COLS && ty < geo.ROWS ? geo.zoneGrid[ty * geo.COLS + tx] : null;
      if (!subject && viewport.w >= geo.W * .8) place = 'TJ OS ECOSYSTEM';
      else if (id != null && typeof geo.nameOf === 'function') place = geo.nameOf(id) || place;
      if (subject && subject.name) place += ' · ' + subject.name;
    }
    return { label: 'CAM · ' + place, state,
      indicator: state === 'live' ? '● LIVE' : state === 'paused' ? 'Ⅱ PAUSED' : '● OFFLINE',
      feed: state === 'live' ? 'FEED: LIVE' : state === 'paused' ? 'FEED: PAUSED' : 'FEED: RECONNECTING' };
  }
  function create(options) {
    options = options || {};
    let geometry = null, baked = null, lighting = null, frame = null, preparedLight = null, presentationFixtures = [];
    let frames = 0, rebuilds = 0, entityCount = 0, lastStart = 0, startedAt = 0;
    let elapsed = [], durations = [], lightDurations = [], lightingMs = 0;
    let depthPasses = 0, depthItems = 0, depthTallItems = 0;
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
        const projection = typeof PropRemaster !== 'undefined' && PropRemaster.isProjection();
        const fill = baked.lamps || baked.flickers || [], practical = baked.wallFixtures || [];
        // The old virtual room samples and wall lamps had equal energy. Give
        // physical housings the key light and retain a softer interior fill.
        presentationFixtures = projection ? fill.map(l => Object.assign({}, l, {
          gain: (l.gain == null || Math.abs(l.gain - .22) < .000001 ? 1 : l.gain) * .62,
          r: l.r * .90
        })).concat(practical.map(l => {
          const kind = geometry.kindOf && geometry.kindOf(l.zone);
          const rgb = kind === 'bridge' || kind === 'lab' ? '194,220,246' : kind === 'quarters' ? '255,191,119' : '255,214,157';
          return Object.assign({}, l, { rgb, r: l.r * 1.12, gain: (l.gain == null ? 1 : l.gain) * 1.5 });
        })) : fill.concat(practical);
        if (canLight()) {
          if (!lighting) lighting = WorldLight.create({ quality: 'high', wallAmbient: .16, fixtureTint: .16, propTint: .48 });
          if (typeof IndustrialTextures !== 'undefined' && IndustrialTextures.enabled() && lighting.configure)
            lighting.configure(IndustrialTextures.lighting);
          lighting.setGeometry(geometry, { width: baked.W, height: baked.H,
            tileSize: geometry.TILE, interiorPath: baked.interiorPath, interiorMask: baked.interiorCv, surfaceMask: baked.baseCv,
            surfaceChunks: baked.chunks });
        }
      }
      entityCount = 0;
      lightingMs = 0;
      preparedLight = null;
    }
    function drawBase(ctx) {
      if (baked && baked.baseCv) {
        if (typeof IndustrialTextures !== 'undefined' && IndustrialTextures.drawBase(ctx, baked.baseCv)) return;
        ctx.drawImage(baked.baseCv, 0, 0);
      }
    }
    function drawEntities(ctx, items, options) {
      const list = items || [];
      entityCount = list.length;
      const opts = options || {};
      // Default remains the established depth order. A caller that explicitly opts into
      // the 2.5D compositor gets a stable depth/height pass without changing world data.
      const ordered = opts.twoPointFiveD
        ? list.map((item, index) => ({ item, index }))
            .sort((a, b) => compareDepth(a.item, b.item) || finite(a.item.y, 0) - finite(b.item.y, 0) || a.index - b.index)
            .map(entry => entry.item)
        : sortedItems(list);
      if (opts.twoPointFiveD) {
        depthPasses++;
        depthItems += ordered.length;
        depthTallItems += ordered.reduce((n, item) => n + (verticalOcclusion(item) > 12 ? 1 : 0), 0);
      }
      for (const item of ordered) item.draw(ctx);
      return ordered.length;
    }
    function drawGrounding(ctx, bodies) {
      if (lighting && lighting.drawGrounding) lighting.drawGrounding(ctx, bodies || []);
    }
    function prepareLight(lights, params) {
      if (!lighting || classic) return false;
      preparedLight = Object.assign({ lights: lights || [], fixtures: presentationFixtures, fixtureGain: .79,
        now: frame.now, reducedMotion: !!frame.reducedMotion }, params || {});
      // Prepare before the depth pass: a CRT that stops working must stop lighting
      // its operator and casting a shadow in this very frame, including after rebake.
      if (lighting.prepare) lighting.prepare(preparedLight);
      return true;
    }
    function sampleLight(x, y) {
      return preparedLight && lighting && lighting.sample ? lighting.sample(x, y) : null;
    }
    function drawAtmosphere(ctx, params) {
      if (!lighting || !lighting.drawAtmosphere) return false;
      lighting.drawAtmosphere(ctx, Object.assign({ now: frame.now, reducedMotion: !!frame.reducedMotion }, params || {}));
      return true;
    }
    function drawLight(ctx, lights, params) {
      if (!lighting || classic) return false;
      const t = clock();
      if (!preparedLight) prepareLight(lights, params);
      const rendered = lighting.prepare ? lighting.render(ctx) : lighting.render(ctx, preparedLight);
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
        twoPointFiveD: { passes: depthPasses, items: depthItems,
          averageItems: depthPasses ? Math.round(depthItems / depthPasses) : 0,
          tallItems: depthTallItems },
        viewport: frame ? visibleRect(frame) : null,
        appearance: {
          crew: typeof SPRITES !== 'undefined' && SPRITES.bodyAppearanceStats ? SPRITES.bodyAppearanceStats() : null,
          props: typeof PropSprites !== 'undefined' && PropSprites.lightResponseStats ? PropSprites.lightResponseStats() : null
        },
        lighting: lighting && lighting.stats ? lighting.stats() : null };
    }
    function dispose() {
      if (lighting && lighting.dispose) lighting.dispose();
      lighting = null; geometry = null; baked = null; frame = null; preparedLight = null;
      elapsed = []; durations = []; lightDurations = []; lastStart = 0;
    }
    return { begin, drawBase, prepareLight, sampleLight, drawEntities, drawGrounding, drawAtmosphere, drawLight, finish, stats, dispose };
  }
  return { GENERATION, PHOSPHOR, DETAIL_GLSL, sharpenSample, enabled: () => !classic, create, cameraReadout, visibleRect, intersects, depthKey, sortedItems, verticalOcclusion, compareDepth, percentile };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldRenderer;