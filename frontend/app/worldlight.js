/* StarNet WorldLight — spatial illumination for the station's local pixel frame.
 * All sources are supplied by the world: this module invents no activity or fixtures.
 * setGeometry() must follow each projection/bake, including edits that move the origin.
 * prepare(frame) exposes current illumination before bodies and shadows are drawn;
 * render(ctx[, frame]) composites it later. Both preserve the caller's world transform.
 * render() replaces the old lightCv, fixture glow and prop emission passes. It preserves
 * the caller's world transform and canvas state. The interior path comes from the bake;
 * walls come from projectGeometry.canStep, including the actual sealed-airlock state.
 */
'use strict';

const WorldLight = (() => {
  const TAU = Math.PI * 2, EPS = 1e-7;
  const QUALITY = Object.freeze({
    high: Object.freeze({ rays: 96, areaSamples: 5, mapPixels: 2400000, stampPixels: 6000000, maxSources: 512 }),
    balanced: Object.freeze({ rays: 64, areaSamples: 3, mapPixels: 1200000, stampPixels: 3000000, maxSources: 384 }),
    low: Object.freeze({ rays: 40, areaSamples: 1, mapPixels: 600000, stampPixels: 1500000, maxSources: 256 })
  });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finite = (v, fallback) => Number.isFinite(+v) ? +v : fallback;
  const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  const originOf = l => ({ x: finite(l.originX, l.x), y: finite(l.originY, l.y) });

  // Contiguous boundaries become one segment, so a long wall has two ray endpoints,
  // not hundreds. Open joins and thresholds transmit light; a sealed seam does not.
  function buildSegments(geo, tileSize) {
    if (!geo || !geo.zoneGrid) return [];
    const T = Math.max(1, finite(tileSize, finite(geo.TILE, 12)));
    const cols = geo.COLS | 0, rows = geo.ROWS | 0, lines = new Map();
    const zone = (x, y) => x < 0 || y < 0 || x >= cols || y >= rows ? null : geo.zoneGrid[y * cols + x];
    const add = (axis, line, lo) => {
      const key = axis + ':' + line;
      let list = lines.get(key); if (!list) lines.set(key, list = []);
      list.push(lo);
    };
    const blocked = (x, y, nx, ny, a, b) => b == null || (a !== b &&
      !(typeof geo.canStep === 'function' && geo.canStep(x, y, nx, ny)));
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const a = zone(x, y); if (a == null) continue;
      if (zone(x - 1, y) == null) add('v', x, y);
      if (zone(x, y - 1) == null) add('h', y, x);
      if (blocked(x, y, x + 1, y, a, zone(x + 1, y))) add('v', x + 1, y);
      if (blocked(x, y, x, y + 1, a, zone(x, y + 1))) add('h', y + 1, x);
    }
    const segments = [];
    for (const [key, values] of lines) {
      values.sort((a, b) => a - b);
      const [axis, raw] = key.split(':'), line = +raw * T;
      let start = values[0], end = start + 1;
      const emit = () => segments.push(axis === 'v'
        ? { x1: line, y1: start * T, x2: line, y2: end * T }
        : { x1: start * T, y1: line, x2: end * T, y2: line });
      for (let i = 1; i < values.length; i++) {
        if (values[i] <= end) end = Math.max(end, values[i] + 1);
        else { emit(); start = values[i]; end = start + 1; }
      }
      emit();
    }
    return segments;
  }

  // Returns a ray distance, or Infinity. Collinear walls are tested explicitly: light
  // cannot travel through the end of a closed seam merely because the ray is axial.
  function rayDistance(x, y, dx, dy, s) {
    const sx = s.x2 - s.x1, sy = s.y2 - s.y1, qx = s.x1 - x, qy = s.y1 - y;
    const det = dx * sy - dy * sx;
    if (Math.abs(det) < EPS) {
      if (Math.abs(qx * dy - qy * dx) > EPS) return Infinity;
      const a = qx * dx + qy * dy, b = (s.x2 - x) * dx + (s.y2 - y) * dy;
      if (Math.max(a, b) < EPS) return Infinity;
      return Math.max(EPS, Math.min(a, b));
    }
    const t = (qx * sy - qy * sx) / det, u = (qx * dy - qy * dx) / det;
    return t > EPS && u >= -EPS && u <= 1 + EPS ? t : Infinity;
  }

  function nearbySegments(segments, light) {
    const o = originOf(light);
    const x0 = Math.min(o.x, light.x - light.r), x1 = Math.max(o.x, light.x + light.r);
    const y0 = Math.min(o.y, light.y - light.r), y1 = Math.max(o.y, light.y + light.r);
    return segments.filter(s => Math.max(s.x1, s.x2) >= x0 && Math.min(s.x1, s.x2) <= x1 &&
      Math.max(s.y1, s.y2) >= y0 && Math.min(s.y1, s.y2) <= y1);
  }

  function visibilityPolygon(light, segments, rays) {
    if (!light || !(light.r > 0)) return [];
    const o = originOf(light), reach = light.r + Math.hypot(o.x - light.x, o.y - light.y);
    const local = nearbySegments(segments || [], light), angles = [], count = clamp(rays | 0 || 64, 24, 192);
    for (let i = 0; i < count; i++) angles.push(i * TAU / count);
    for (const s of local) for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const a = Math.atan2(y - o.y, x - o.x);
      for (const offset of [-0.00001, 0, 0.00001]) angles.push(((a + offset) % TAU + TAU) % TAU);
    }
    angles.sort((a, b) => a - b);
    return angles.map(angle => {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      let d = reach;
      for (const s of local) d = Math.min(d, rayDistance(o.x, o.y, dx, dy, s));
      return { x: o.x + dx * d, y: o.y + dy * d };
    });
  }

  function visibleAt(light, x, y, segments) {
    return visibleFrom(light, x, y, segments, originOf(light));
  }

  function visibleFrom(light, x, y, segments, o) {
    if (Math.hypot(x - light.x, y - light.y) > light.r) return false;
    const dx = x - o.x, dy = y - o.y, d = Math.hypot(dx, dy);
    if (d < EPS) return true;
    for (const s of segments) if (rayDistance(o.x, o.y, dx / d, dy / d, s) < d - EPS) return false;
    return true;
  }

  function emitterOrigins(light, segments, count) {
    const center = originOf(light), radius = clamp(finite(light.softness, 0), 0, 4);
    if (!(radius > 0) || count === 1) return [center];
    const offsets = count === 3 ? [[-1, 0], [1, 0]] : [[-1, 0], [1, 0], [0, -1], [0, 1]];
    return [center].concat(offsets.map(([dx, dy]) => {
      const o = { x: center.x + dx * radius, y: center.y + dy * radius };
      // An area emitter adjacent to a wall cannot place part of its luminous
      // aperture in the next room. Retain that sample at the physical origin.
      const gate = { x: center.x, y: center.y, r: radius + 1 };
      return visibleAt(gate, o.x, o.y, segments) ? o : center;
    }));
  }

  function visibilityFraction(light, x, y, segments) {
    if (Math.hypot(x - light.x, y - light.y) > light.r) return 0;
    const origins = light.origins || emitterOrigins(light, segments, 5);
    let visible = 0;
    for (const o of origins) if (visibleFrom(light, x, y, segments, o)) visible++;
    return visible / origins.length;
  }

  // Smooth, finite reach: no hard circular edge, no infinite inverse-square tail.
  function falloff(t) {
    t = clamp(finite(t, 1), 0, 1);
    const q = 1 - t * t;
    return q * q / (1 + 3 * t * t);
  }

  function normalizeLight(source, fixture, gain) {
    if (!source || !Number.isFinite(+source.x) || !Number.isFinite(+source.y) || !(+source.r > 0)) return null;
    let c = source.c || source.color || source.rgb || (fixture ? [255, 192, 104] : [170, 215, 255]);
    if (typeof c === 'string') c = c.split(',').map(Number);
    if (!Array.isArray(c) || c.length < 3) return null;
    c = c.slice(0, 3).map(n => Math.round(clamp(finite(n, 0), 0, 255)));
    // The bake's .22 ROOM_FIXTURE_GAIN was only the highlight on top of a separate
    // .46 diffuse room cut. This replacement owns BOTH: restore that legacy source
    // to full fixture energy, while keeping explicit zero and other gains intact.
    const rawGain = finite(source.gain, 1);
    const fixturePower = fixture && Math.abs(rawGain - 0.22) < 0.000001 ? 1 : rawGain;
    const a = clamp(finite(source.a, fixture ? 0.86 : 0) * finite(gain, 1) * (fixture ? fixturePower : 1), 0, 1);
    if (a <= 0) return null;
    const light = { x: +source.x, y: +source.y, r: clamp(+source.r, 1, 768), c, a, fixture: !!fixture,
      originX: finite(source.originX, +source.x), originY: finite(source.originY, +source.y),
      softness: clamp(finite(source.softness, fixture ? 1.2 : 0.7), 0, 4), beam: null };
    // A shaft requires the supplied physical housing and its outward normal.
    // Ordinary room pools and screen emission never manufacture a visible cone.
    const b = source.beam || { x: source.emitX, y: source.emitY, dx: source.normalX, dy: source.normalY };
    const dx = finite(b.dx, 0), dy = finite(b.dy, 0), norm = Math.hypot(dx, dy);
    if (Number.isFinite(+b.x) && Number.isFinite(+b.y) && norm > EPS) {
      const reach = Math.hypot(+b.x - light.x, +b.y - light.y);
      light.beam = { x: +b.x, y: +b.y, dx: dx / norm, dy: dy / norm,
        length: clamp(finite(b.length, reach + light.r * 0.32), 1, Math.min(256, reach + light.r)),
        width: clamp(finite(b.width, light.r * 0.18), 2, 36),
        strength: clamp(finite(b.strength, 0.055), 0, 0.12) };
    }
    return light;
  }

  function lightAt(x, y, lights, segments) {
    const rgb = [0, 0, 0]; let strongest = null, strength = 0, energy = 0, dx = 0, dy = 0;
    for (const l of lights) {
      const transmission = visibilityFraction(l, x, y, segments); if (!transmission) continue;
      const v = l.a * falloff(Math.hypot(x - l.x, y - l.y) / l.r) * transmission;
      for (let i = 0; i < 3; i++) rgb[i] += l.c[i] * v;
      const o = originOf(l), d = Math.hypot(o.x - x, o.y - y);
      if (d > EPS) { dx += (o.x - x) / d * v; dy += (o.y - y) / d * v; }
      energy += v;
      if (v > strength) { strength = v; strongest = l; }
    }
    const direction = Math.hypot(dx, dy);
    // A weighted colour retains warm/cool identity when overlapping emitters would
    // saturate additive rgb to white. Direction points from the body TO the light.
    return { rgb: rgb.map(v => Math.round(clamp(v, 0, 255))), strength, source: strongest,
      color: rgb.map(v => energy > EPS ? Math.round(clamp(v / energy, 0, 255)) : 0),
      dx: direction > EPS ? dx / direction : 0, dy: direction > EPS ? dy / direction : 0,
      energy, coherence: energy > EPS ? clamp(direction / energy, 0, 1) : 0 };
  }

  function shadowFor(body, lights, segments, preparedHit) {
    const x = finite(body.x, body.px), y = finite(body.y, body.py);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const hit = preparedHit || lightAt(x, y, lights, segments), src = hit.source;
    const origin = src ? originOf(src) : null;
    const d = origin ? Math.hypot(x - origin.x, y - origin.y) : 1;
    const height = clamp(finite(body.height, 18), 2, 90), width = clamp(finite(body.width, 8), 2, 140);
    return { x, y, dx: src ? -hit.dx : 0.4, dy: src ? -hit.dy : 0.9165, width,
      length: height * (src ? clamp(d / src.r, 0.15, 0.7) * (0.35 + hit.coherence * 0.65) : 0.3),
      penumbra: clamp(width * 0.16 + height * 0.035, 0.7, 5),
      alpha: clamp(finite(body.opacity, 0.22) * (0.65 + hit.strength), 0, 0.42),
      contactAlpha: clamp(finite(body.opacity, 0.22) * 0.8, 0, 0.24) };
  }

  function create(options) {
    options = options || {};
    let quality = QUALITY[options.quality] ? options.quality : 'high';
    let config = Object.assign({ ambient: 0.82, wallAmbient: 0.28, fixtureTint: 0.17,
      emission: 1, propLift: 0.65, propTint: 1, atmosphere: 0.25, shafts: 1, sampleCacheLimit: 512 }, options);
    let geo = null, geometryOptions = {}, segments = [], width = 1, height = 1, ratio = 1;
    let interiorPath = null, interiorMask = null, surfaceMask = null, surfaceChunks = [];
    let baseDark = null, baseGlow = null, frameDark = null, frameGlow = null;
    let fixtureKey = '', frameKey = '', fixtureLights = [], currentLights = [], stampPixels = 0, disposed = false;
    let preparedFrame = null, preparedLights = [];
    const stamps = new Map(), canvasWatches = new Map(), lostCanvases = new Set(), samples = new Map();
    let sampleKey = null;
    let resourcesDirty = false, retryResourcesAt = 0;
    const metrics = { geometryRevision: 0, staticBuilds: 0, dynamicBuilds: 0, visibilityBuilds: 0,
      frames: 0, preparations: 0, beamBuilds: 0, lastBuildMs: 0, droppedSources: 0, supported: true, contextLosses: 0, contextRecoveries: 0,
      configRevision: 0, sampleCacheHits: 0, sampleCacheMisses: 0, sampleCacheEvictions: 0, sampleCacheInvalidations: 0 };
    const sampleLimit = () => clamp(Math.floor(finite(config.sampleCacheLimit, 512)), 0, 2048);
    function invalidateSamples() {
      samples.clear(); sampleKey = null; metrics.sampleCacheInvalidations++;
    }
    function sample(x, y) {
      x = +x; y = +y;
      if (disposed || !Number.isFinite(x) || !Number.isFinite(y)) return lightAt(0, 0, [], segments);
      // Exact float keys: furniture reuses its sample, while a moving body never
      // receives the value from the other side of a doorway or a rounded pixel.
      const key = x + ',' + y, cached = samples.get(key);
      if (cached) {
        samples.delete(key); samples.set(key, cached); metrics.sampleCacheHits++; return cached;
      }
      metrics.sampleCacheMisses++;
      const hit = lightAt(x, y, currentLights, segments), limit = sampleLimit();
      // Descriptors are read-only so a sprite's tint adjustment cannot poison the
      // next furniture/crew draw sharing this exact physical position.
      Object.freeze(hit.rgb); Object.freeze(hit.color); Object.freeze(hit);
      if (limit) {
        while (samples.size >= limit) { samples.delete(samples.keys().next().value); metrics.sampleCacheEvictions++; }
        samples.set(key, hit);
      }
      return hit;
    }
    function lost(c) {
      if (!lostCanvases.has(c)) { lostCanvases.add(c); metrics.contextLosses++; }
      resourcesDirty = true;
    }
    const makeCanvas = (w, h) => {
      let c;
      if (typeof options.canvasFactory === 'function') c = options.canvasFactory(w, h);
      else if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
      else if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = w; c.height = h; }
      if (!c || !c.getContext || !c.getContext('2d')) { metrics.supported = false; return null; }
      if (typeof c.addEventListener === 'function') {
        const onLost = e => { if (e && e.preventDefault) e.preventDefault(); lost(c); };
        const onRestored = () => { lostCanvases.delete(c); resourcesDirty = true; retryResourcesAt = 0; };
        c.addEventListener('contextlost', onLost); c.addEventListener('contextrestored', onRestored);
        canvasWatches.set(c, [onLost, onRestored]);
      }
      return c;
    };
    const reset = c => { const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, c.width, c.height); g.setTransform(ratio, 0, 0, ratio, 0, 0); return g; };
    const release = c => {
      if (!c) return;
      const handlers = canvasWatches.get(c);
      if (handlers && typeof c.removeEventListener === 'function') {
        c.removeEventListener('contextlost', handlers[0]); c.removeEventListener('contextrestored', handlers[1]);
      }
      canvasWatches.delete(c); lostCanvases.delete(c); c.width = 1; c.height = 1;
    };
    const clearStamps = () => { for (const s of stamps.values()) release(s.canvas); stamps.clear(); stampPixels = 0; };

    function setGeometry(next, opts) {
      if (disposed) return false;
      metrics.supported = true;
      geo = next; geometryOptions = opts || {};
      width = Math.max(1, finite(geometryOptions.width, finite(geo && geo.W, 1)));
      height = Math.max(1, finite(geometryOptions.height, finite(geo && geo.H, 1)));
      ratio = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(QUALITY[quality].mapPixels / (width * height)));
      interiorPath = geometryOptions.interiorPath || null; surfaceMask = geometryOptions.surfaceMask || null;
      interiorMask = geometryOptions.interiorMask || null;
      surfaceChunks = Array.isArray(geometryOptions.surfaceChunks) ? geometryOptions.surfaceChunks : [];
      segments = buildSegments(geo, geometryOptions.tileSize);
      for (const c of [baseDark, baseGlow, frameDark, frameGlow]) release(c);
      const w = Math.max(1, Math.ceil(width * ratio)), h = Math.max(1, Math.ceil(height * ratio));
      baseDark = makeCanvas(w, h); baseGlow = makeCanvas(w, h); frameDark = makeCanvas(w, h); frameGlow = makeCanvas(w, h);
      clearStamps(); fixtureKey = ''; frameKey = ''; fixtureLights = []; currentLights = [];
      preparedFrame = null; preparedLights = [];
      invalidateSamples();
      resourcesDirty = false; retryResourcesAt = 0; metrics.geometryRevision++; return metrics.supported;
    }

    function clipDeckFootprint(g) {
      g.beginPath();
      if (geo && geo.allRects) {
        const T = finite(geometryOptions.tileSize, finite(geo.TILE, 12));
        for (const r of geo.allRects) g.rect(r.x1 * T, r.y1 * T, (r.x2 - r.x1 + 1) * T, (r.y2 - r.y1 + 1) * T);
      }
      g.clip();
    }

    function clipFloor(g) {
      if (interiorPath) { g.clip(interiorPath); return; }
      clipDeckFootprint(g);
      // Exact bake masks below preserve the curved corner, including wall feet.
      // With geometry alone, omit corner tiles conservatively instead of lighting
      // the wedge of outer space that lies inside a rectangular room footprint.
      if (!interiorMask && !surfaceChunks.some(c => c.interiorCv) && geo && geo.chamfers && geo.chamfers.length) {
        const T = finite(geometryOptions.tileSize, finite(geo.TILE, 12)), seen = new Set();
        g.beginPath(); g.rect(0, 0, width, height);
        for (const c of geo.chamfers) {
          const key = c[0] + ',' + c[1]; if (seen.has(key)) continue; seen.add(key);
          g.rect(c[0] * T, c[1] * T, T, T);
        }
        g.clip('evenodd');
      }
    }

    const hasInteriorMask = () => !!interiorMask || surfaceChunks.some(c => c.interiorCv);
    const hasSurface = () => !!surfaceMask || surfaceChunks.some(c => c.baseCv);
    function drawChunk(g, c, image) {
      g.drawImage(image, finite(c.x, 0), finite(c.y, 0), finite(c.w, image.width), finite(c.h, image.height));
    }
    function paintFloorMask(g, bounds) {
      if (interiorMask) { g.drawImage(interiorMask, 0, 0, width, height); return; }
      for (const c of surfaceChunks) {
        if (bounds && (finite(c.x, 0) >= bounds.x + bounds.size || finite(c.y, 0) >= bounds.y + bounds.size ||
          finite(c.x, 0) + finite(c.w, c.interiorCv ? c.interiorCv.width : 0) <= bounds.x ||
          finite(c.y, 0) + finite(c.h, c.interiorCv ? c.interiorCv.height : 0) <= bounds.y)) continue;
        if (c.interiorCv) drawChunk(g, c, c.interiorCv);
        else {
          g.save(); clipFloor(g); g.fillStyle = '#fff';
          g.fillRect(finite(c.x, 0), finite(c.y, 0), finite(c.w, 0), finite(c.h, 0)); g.restore();
        }
      }
    }

    function ensureResources() {
      const inspect = c => {
        if (!c) return;
        const g = c.getContext('2d');
        if (g && typeof g.isContextLost === 'function' && g.isContextLost()) lost(c);
      };
      for (const c of [baseDark, baseGlow, frameDark, frameGlow]) inspect(c);
      for (const s of stamps.values()) inspect(s.canvas);
      if (resourcesDirty) {
        if (clock() < retryResourcesAt) return false;
        // Recreate rather than trust restored backing pixels: restoration clears
        // both raster content and canvas state while our source keys stay equal.
        metrics.contextRecoveries++; setGeometry(geo, geometryOptions);
        for (const c of [baseDark, baseGlow, frameDark, frameGlow]) inspect(c);
        if (resourcesDirty) retryResourcesAt = clock() + 250;
      }
      return !resourcesDirty && !!baseDark && !!baseGlow && !!frameDark && !!frameGlow;
    }

    const keyOf = l => l.x + ',' + l.y + ',' + l.r + ',' + l.c.join(',') + ',' + finite(l.originX, l.x) + ',' + finite(l.originY, l.y) + ',' + l.softness;
    const beamKey = l => l.beam ? Object.values(l.beam).join(',') : '';
    const signature = lights => lights.map(l => keyOf(l) + ',' + Math.round(l.a * 255) + ',' + beamKey(l)).join(';');
    function stamp(light, beamOnly) {
      if (beamOnly && (!light.beam || !(light.beam.strength > 0))) return null;
      const key = (beamOnly ? 'beam:' + beamKey(light) + ':' : '') + keyOf(light);
      const old = stamps.get(key);
      if (old) { stamps.delete(key); stamps.set(key, old); return old; }
      const size = Math.max(2, Math.min(Math.ceil(light.r * 2 * ratio), Math.floor(Math.sqrt(QUALITY[quality].stampPixels))));
      while (stamps.size && stampPixels + size * size > QUALITY[quality].stampPixels) {
        const first = stamps.keys().next().value, s = stamps.get(first);
        stamps.delete(first); stampPixels -= s.pixels; release(s.canvas);
      }
      const canvas = makeCanvas(size, size); if (!canvas) return null;
      const g = canvas.getContext('2d'), x = light.x - light.r, y = light.y - light.r;
      g.setTransform(size / (light.r * 2), 0, 0, size / (light.r * 2), -x * size / (light.r * 2), -y * size / (light.r * 2));
      const gradient = g.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r);
      for (const t of [0, 0.14, 0.3, 0.5, 0.7, 0.86, 1]) gradient.addColorStop(t, 'rgba(' + light.c.join(',') + ',' + falloff(t) + ')');
      const origins = light.origins || emitterOrigins(light, segments, QUALITY[quality].areaSamples);
      g.globalCompositeOperation = 'lighter';
      for (const o of origins) {
        const polygon = visibilityPolygon(Object.assign({}, light, { originX: o.x, originY: o.y }), segments, QUALITY[quality].rays);
        g.save(); g.globalAlpha = 1 / origins.length;
        g.beginPath(); polygon.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.clip();
        clipFloor(g);
        if (beamOnly) paintBeam(g, light);
        else { g.fillStyle = gradient; g.fillRect(x, y, light.r * 2, light.r * 2); }
        g.restore();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      if (beamOnly) {
        // Keep the visible shaft within the same finite light reach, even when
        // its projected wall housing is above the floor's visibility origin.
        g.globalCompositeOperation = 'destination-in'; g.fillStyle = gradient;
        g.fillRect(x, y, light.r * 2, light.r * 2); g.globalCompositeOperation = 'source-over';
        metrics.beamBuilds++;
      }
      metrics.visibilityBuilds++;
      if (!interiorPath && hasInteriorMask()) {
        // A small temporary stamp mask unions chunk alpha before destination-in;
        // applying chunks one at a time would erase each preceding chunk's light.
        const mask = makeCanvas(size, size);
        if (mask) {
          const m = mask.getContext('2d');
          m.setTransform(size / (light.r * 2), 0, 0, size / (light.r * 2), -x * size / (light.r * 2), -y * size / (light.r * 2));
          paintFloorMask(m, { x, y, size: light.r * 2 }); g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalCompositeOperation = 'destination-in'; g.drawImage(mask, 0, 0); g.restore(); release(mask);
        }
      }
      const result = { canvas, x, y, size: light.r * 2, pixels: size * size };
      stamps.set(key, result); stampPixels += result.pixels;
      return result;
    }

    function paintBeam(g, light) {
      const b = light.beam, ex = b.x + b.dx * b.length, ey = b.y + b.dy * b.length;
      const gradient = g.createLinearGradient(b.x, b.y, ex, ey);
      gradient.addColorStop(0, 'rgba(' + light.c.join(',') + ',' + b.strength / 3 + ')');
      gradient.addColorStop(0.35, 'rgba(' + light.c.join(',') + ',' + b.strength * 0.27 + ')');
      gradient.addColorStop(1, 'rgba(' + light.c.join(',') + ',0)'); g.fillStyle = gradient;
      for (const band of [1, 0.72, 0.46]) {
        const near = 1.7 * band, far = b.width * 0.5 * band;
        g.beginPath(); g.moveTo(b.x - b.dy * near, b.y + b.dx * near);
        g.lineTo(ex - b.dy * far, ey + b.dx * far); g.lineTo(ex + b.dy * far, ey - b.dx * far);
        g.lineTo(b.x + b.dy * near, b.y - b.dx * near); g.closePath(); g.fill();
      }
    }

    function paint(g, lights, amount, mode, beamOnly) {
      g.globalCompositeOperation = mode;
      for (const l of lights) {
        const s = stamp(l, beamOnly); if (!s) continue;
        g.globalAlpha = clamp(l.a * amount, 0, 1); g.drawImage(s.canvas, s.x, s.y, s.size, s.size);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }

    function rebuildStatic(lights) {
      const d = reset(baseDark), glow = reset(baseGlow), wall = clamp(finite(config.wallAmbient, 0.28), 0, 0.8);
      // Existing LOW/MEDIUM/HIGH room settings are .82/.72/.62. Their ordering
      // survives, with a new readable floor: .70/.64/.58 rather than crushed black.
      const ambient = clamp(0.208 + finite(config.ambient, 0.82) * 0.6, 0, 0.9);
      // The silhouette owns the exterior shade. Empty space remains transparent.
      if (hasSurface() && wall > 0) {
        if (surfaceMask) d.drawImage(surfaceMask, 0, 0, width, height);
        else for (const c of surfaceChunks) if (c.baseCv) drawChunk(d, c, c.baseCv);
        d.globalCompositeOperation = 'source-in';
        d.fillStyle = 'rgba(4,8,18,' + wall + ')'; d.fillRect(0, 0, width, height); d.globalCompositeOperation = 'source-over';
      }
      const inside = hasSurface() ? clamp((ambient - wall) / (1 - wall), 0, 1) : ambient;
      // The exact interior receiver also contains projected, raised wall faces.
      // Floor visibility stops at the physical wall plane, so no light can carve
      // the heavy deck ambient out of those faces. Keep that ambient on the deck:
      // otherwise it forms a black stripe across walls AND foreground prop tops.
      if (!interiorPath && hasInteriorMask()) {
        // Reuse an existing frame surface during the static build. No extra
        // station-sized canvas is needed for REFIT's chunked silhouette union.
        const floor = reset(frameDark); floor.save(); clipDeckFootprint(floor);
        paintFloorMask(floor); floor.restore(); floor.globalCompositeOperation = 'source-in';
        floor.fillStyle = 'rgba(5,9,22,' + inside + ')'; floor.fillRect(0, 0, width, height);
        d.drawImage(frameDark, 0, 0, width, height);
      } else {
        d.save(); clipDeckFootprint(d); clipFloor(d); d.fillStyle = 'rgba(5,9,22,' + inside + ')';
        d.fillRect(0, 0, width, height); d.restore();
      }
      paint(d, lights, 1, 'destination-out');
      paint(glow, lights, finite(config.fixtureTint, 0.17), 'screen');
      if (config.shafts > 0) paint(glow, lights, clamp(config.shafts, 0, 2), 'screen', true);
      metrics.staticBuilds++;
    }

    function prepare(frame) {
      if (disposed || !geo) return false;
      frame = frame || {}; const q = QUALITY[quality];
      if (Number.isFinite(+frame.ambient)) config.ambient = +frame.ambient;
      const sourceFixtures = frame.fixtures || [], sourceProps = frame.lights || [];
      fixtureLights = sourceFixtures.map(s => normalizeLight(s, true, finite(frame.fixtureGain, 1))).filter(Boolean).slice(0, q.maxSources);
      preparedLights = sourceProps.map(s => normalizeLight(s, false, finite(frame.emission, config.emission))).filter(Boolean).slice(0, q.maxSources);
      currentLights = fixtureLights.concat(preparedLights); preparedFrame = frame;
      for (const light of currentLights) light.origins = emitterOrigins(light, segments, q.areaSamples);
      // Sample energy must respond to even sub-byte changes. Raster map keys may
      // quantize alpha for reuse; this key deliberately retains its exact value.
      const exact = lights => lights.map(l => keyOf(l) + ',' + l.a + ',' + beamKey(l)).join(';');
      const nextSampleKey = metrics.geometryRevision + '/' + metrics.configRevision + '/' + quality + '/' + config.ambient +
        '|fixtures:' + exact(fixtureLights) + '|props:' + exact(preparedLights);
      if (nextSampleKey !== sampleKey) { invalidateSamples(); sampleKey = nextSampleKey; }
      metrics.droppedSources = Math.max(0, sourceFixtures.length - fixtureLights.length) + Math.max(0, sourceProps.length - preparedLights.length);
      metrics.preparations++; return true;
    }

    function render(ctx, frame) {
      if (disposed || !geo || !ctx) return false;
      // Retain the supplied frame through backing-store recovery, which correctly
      // invalidates all geometry-dependent caches and their normalized sources.
      const nextFrame = frame === undefined ? preparedFrame || {} : frame;
      const started = clock(); if (!ensureResources()) return false;
      prepare(nextFrame);
      const fixtures = fixtureLights, lights = preparedLights;
      const fk = signature(fixtures) + '|' + config.ambient + ',' + config.wallAmbient + ',' + config.fixtureTint + ',' + config.shafts;
      if (fk !== fixtureKey) { rebuildStatic(fixtures); fixtureKey = fk; frameKey = ''; }
      const dk = signature(lights) + '|' + finite(config.propLift, 0.65) + '|' + finite(config.propTint, 1);
      if (dk !== frameKey) {
        const d = reset(frameDark), glow = reset(frameGlow);
        d.drawImage(baseDark, 0, 0, width, height); glow.drawImage(baseGlow, 0, 0, width, height);
        paint(d, lights, finite(config.propLift, 0.65), 'destination-out'); paint(glow, lights, clamp(finite(config.propTint, 1), 0, 1), 'screen');
        frameKey = dk; metrics.dynamicBuilds++;
      }
      ctx.save();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = ratio < 1;
      ctx.drawImage(frameDark, 0, 0, width, height); ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(frameGlow, 0, 0, width, height); ctx.restore();
      metrics.frames++; metrics.lastBuildMs = +(clock() - started).toFixed(3); return true;
    }

    function drawGrounding(ctx, bodies) {
      if (disposed || !ctx || !geo) return;
      ctx.save(); clipFloor(ctx); ctx.globalCompositeOperation = 'multiply';
      for (const body of (bodies || [])) {
        const s = shadowFor(body, currentLights, segments,
          sample(finite(body.x, body.px), finite(body.y, body.py))); if (!s) continue;
        ctx.save();
        // The silhouette can spread around a foot, but never through a bulkhead.
        const polygon = visibilityPolygon({ x: s.x, y: s.y, r: s.length + s.width }, segments, 24);
        ctx.beginPath(); polygon.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.clip();
        const ex = s.x + s.dx * s.length, ey = s.y + s.dy * s.length;
        // Nested low-opacity silhouettes form a bounded penumbra without a blur
        // filter that would smear pixels or spill beyond the floor/wall masks.
        for (const band of [1, 0.55, 0]) {
          const near = s.width * 0.43 + s.penumbra * band * 0.2;
          const far = s.width * 0.34 + s.penumbra * band;
          const gradient = ctx.createLinearGradient(s.x, s.y, ex + 0.01, ey + 0.01);
          gradient.addColorStop(0, 'rgba(4,7,16,' + s.alpha / 3 + ')'); gradient.addColorStop(1, 'rgba(4,7,16,0)');
          ctx.fillStyle = gradient; ctx.beginPath(); ctx.moveTo(s.x - s.dy * near, s.y + s.dx * near);
          ctx.lineTo(ex - s.dy * far, ey + s.dx * far); ctx.lineTo(ex + s.dy * far, ey - s.dx * far);
          ctx.lineTo(s.x + s.dy * near, s.y - s.dx * near); ctx.closePath(); ctx.fill();
        }
        const contact = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.width * 0.52);
        contact.addColorStop(0, 'rgba(3,6,12,' + s.contactAlpha + ')'); contact.addColorStop(1, 'rgba(3,6,12,0)');
        ctx.fillStyle = contact; ctx.beginPath(); ctx.ellipse(s.x, s.y, s.width * 0.52, Math.max(0.65, s.width * 0.14), 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    function drawAtmosphere(ctx, frame) {
      if (!ctx || disposed || !geo || !fixtureLights.length || !(config.atmosphere > 0)) return;
      frame = frame || {}; if (frame.reducedMotion) return;
      const dust = clamp(finite(frame.dust, 1), 0, 2); if (!(dust > 0)) return;
      const time = finite(frame.now, 0) * 0.00004, gain = clamp(config.atmosphere * dust, 0, 1);
      ctx.save(); clipFloor(ctx); ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < Math.min(fixtureLights.length, 48); i++) {
        const l = fixtureLights[i];
        for (let j = 0; j < 2; j++) {
          const seed = (i * 0.61803398875 + j * 0.382) % 1;
          const x = l.x + Math.sin(time + seed * TAU) * l.r * 0.45;
          const y = l.y + (((seed + time * 0.35) % 1) - 0.5) * l.r;
          if (!visibleAt(l, x, y, segments)) continue;
          // Exact curved masks clip monolithic worlds. For chunk-only callers,
          // omit motes on corner tiles rather than risk a bright pixel in space.
          const T = finite(geometryOptions.tileSize, finite(geo.TILE, 12));
          if (!interiorPath && (geo.chamfers || []).some(c => c[0] === Math.floor(x / T) && c[1] === Math.floor(y / T))) continue;
          const intensity = falloff(Math.hypot(x - l.x, y - l.y) / l.r);
          ctx.fillStyle = 'rgba(' + l.c.join(',') + ',' + gain * l.a * 0.55 * intensity + ')';
          ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
      }
      ctx.restore();
    }

    function configure(next) {
      if (!next || disposed) return;
      config = Object.assign({}, config, next);
      metrics.configRevision++; invalidateSamples();
      if (QUALITY[next.quality] && next.quality !== quality) { quality = next.quality; if (geo) setGeometry(geo, geometryOptions); }
      else { fixtureKey = ''; frameKey = ''; }
    }
    function dispose() {
      disposed = true; for (const c of [baseDark, baseGlow, frameDark, frameGlow]) release(c);
      baseDark = null; baseGlow = null; frameDark = null; frameGlow = null;
      clearStamps(); currentLights = []; fixtureLights = []; geo = null; surfaceMask = null; interiorPath = null;
      preparedFrame = null; preparedLights = [];
      invalidateSamples();
      interiorMask = null; surfaceChunks = [];
    }
    return { setGeometry, prepare, render, drawGrounding, drawAtmosphere, configure, dispose, sample,
      stats: () => Object.assign({}, metrics, { quality, width, height, resolution: +ratio.toFixed(4),
        segments: segments.length, sources: currentLights.length, cachedStamps: stamps.size, areaSamples: QUALITY[quality].areaSamples,
        sampleCacheSize: samples.size, sampleCacheLimit: sampleLimit(),
        shafts: fixtureLights.filter(l => l.beam && l.beam.strength > 0 && config.shafts > 0).length,
        ambient: clamp(0.208 + finite(config.ambient, 0.82) * 0.6, 0, 0.9),
        cacheBytes: 4 * stampPixels + (baseDark ? baseDark.width * baseDark.height * 16 : 0), disposed }) };
  }
  return { create, buildSegments, visibilityPolygon, visibleAt, visibilityFraction, emitterOrigins,
    rayDistance, falloff, normalizeLight, lightAt, shadowFor, QUALITY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldLight;
