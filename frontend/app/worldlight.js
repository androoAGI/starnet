/* StarNet WorldLight — spatial illumination for the station's local pixel frame.
 * All sources are supplied by the world: this module invents no activity or fixtures.
 * setGeometry() must follow each projection/bake, including edits that move the origin.
 * render() replaces the old lightCv, fixture glow and prop emission passes. It preserves
 * the caller's world transform and canvas state. The interior path comes from the bake;
 * walls come from projectGeometry.canStep, including the actual sealed-airlock state.
 */
'use strict';

const WorldLight = (() => {
  const TAU = Math.PI * 2, EPS = 1e-7;
  const QUALITY = Object.freeze({
    high: Object.freeze({ rays: 96, mapPixels: 2400000, stampPixels: 6000000, maxSources: 512 }),
    balanced: Object.freeze({ rays: 64, mapPixels: 1200000, stampPixels: 3000000, maxSources: 384 }),
    low: Object.freeze({ rays: 40, mapPixels: 600000, stampPixels: 1500000, maxSources: 256 })
  });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finite = (v, fallback) => Number.isFinite(+v) ? +v : fallback;
  const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

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
    const x0 = light.x - light.r, x1 = light.x + light.r, y0 = light.y - light.r, y1 = light.y + light.r;
    return segments.filter(s => Math.max(s.x1, s.x2) >= x0 && Math.min(s.x1, s.x2) <= x1 &&
      Math.max(s.y1, s.y2) >= y0 && Math.min(s.y1, s.y2) <= y1);
  }

  function visibilityPolygon(light, segments, rays) {
    if (!light || !(light.r > 0)) return [];
    const local = nearbySegments(segments || [], light), angles = [], count = clamp(rays | 0 || 64, 24, 192);
    for (let i = 0; i < count; i++) angles.push(i * TAU / count);
    for (const s of local) for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const a = Math.atan2(y - light.y, x - light.x);
      for (const offset of [-0.00001, 0, 0.00001]) angles.push(((a + offset) % TAU + TAU) % TAU);
    }
    angles.sort((a, b) => a - b);
    return angles.map(angle => {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      let d = light.r;
      for (const s of local) d = Math.min(d, rayDistance(light.x, light.y, dx, dy, s));
      return { x: light.x + dx * d, y: light.y + dy * d };
    });
  }

  function visibleAt(light, x, y, segments) {
    const dx = x - light.x, dy = y - light.y, d = Math.hypot(dx, dy);
    if (d > light.r) return false;
    if (d < EPS) return true;
    for (const s of segments) if (rayDistance(light.x, light.y, dx / d, dy / d, s) < d - EPS) return false;
    return true;
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
    const a = clamp(finite(source.a, fixture ? 0.86 : 0) * finite(gain, 1) * (fixture ? finite(source.gain, 1) : 1), 0, 1);
    if (a <= 0) return null;
    return { x: +source.x, y: +source.y, r: clamp(+source.r, 1, 768), c, a, fixture: !!fixture };
  }

  function lightAt(x, y, lights, segments) {
    const rgb = [0, 0, 0]; let strongest = null, strength = 0;
    for (const l of lights) {
      if (!visibleAt(l, x, y, segments)) continue;
      const v = l.a * falloff(Math.hypot(x - l.x, y - l.y) / l.r);
      for (let i = 0; i < 3; i++) rgb[i] += l.c[i] * v;
      if (v > strength) { strength = v; strongest = l; }
    }
    return { rgb: rgb.map(v => Math.round(clamp(v, 0, 255))), strength, source: strongest };
  }

  function shadowFor(body, lights, segments) {
    const x = finite(body.x, body.px), y = finite(body.y, body.py);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const hit = lightAt(x, y, lights, segments), src = hit.source;
    const dx = src ? x - src.x : 0.35, dy = src ? y - src.y : 0.8;
    const d = Math.hypot(dx, dy) || 1, height = clamp(finite(body.height, 18), 2, 90);
    return { x, y, dx: dx / d, dy: dy / d, width: clamp(finite(body.width, 8), 2, 140),
      length: height * (src ? clamp(d / src.r, 0.15, 0.7) : 0.3),
      alpha: clamp(finite(body.opacity, 0.22) * (0.65 + hit.strength), 0, 0.42) };
  }

  function create(options) {
    options = options || {};
    let quality = QUALITY[options.quality] ? options.quality : 'high';
    let config = Object.assign({ ambient: 0.82, wallAmbient: 0.28, fixtureTint: 0.17,
      emission: 1, propLift: 0.65, atmosphere: 0.25 }, options);
    let geo = null, geometryOptions = {}, segments = [], width = 1, height = 1, ratio = 1;
    let interiorPath = null, surfaceMask = null, baseDark = null, baseGlow = null, frameDark = null, frameGlow = null;
    let fixtureKey = '', frameKey = '', fixtureLights = [], currentLights = [], stampPixels = 0, disposed = false;
    const stamps = new Map();
    const metrics = { geometryRevision: 0, staticBuilds: 0, dynamicBuilds: 0, visibilityBuilds: 0,
      frames: 0, lastBuildMs: 0, droppedSources: 0, supported: true };
    const makeCanvas = (w, h) => {
      let c;
      if (typeof options.canvasFactory === 'function') c = options.canvasFactory(w, h);
      else if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
      else if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = w; c.height = h; }
      if (!c || !c.getContext || !c.getContext('2d')) { metrics.supported = false; return null; }
      return c;
    };
    const reset = c => { const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, c.width, c.height); g.setTransform(ratio, 0, 0, ratio, 0, 0); return g; };
    const release = c => { if (c) { c.width = 1; c.height = 1; } };
    const clearStamps = () => { for (const s of stamps.values()) release(s.canvas); stamps.clear(); stampPixels = 0; };

    function setGeometry(next, opts) {
      if (disposed) return false;
      geo = next; geometryOptions = opts || {};
      width = Math.max(1, finite(geometryOptions.width, finite(geo && geo.W, 1)));
      height = Math.max(1, finite(geometryOptions.height, finite(geo && geo.H, 1)));
      ratio = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(QUALITY[quality].mapPixels / (width * height)));
      interiorPath = geometryOptions.interiorPath || null; surfaceMask = geometryOptions.surfaceMask || null;
      segments = buildSegments(geo, geometryOptions.tileSize);
      for (const c of [baseDark, baseGlow, frameDark, frameGlow]) release(c);
      const w = Math.max(1, Math.ceil(width * ratio)), h = Math.max(1, Math.ceil(height * ratio));
      baseDark = makeCanvas(w, h); baseGlow = makeCanvas(w, h); frameDark = makeCanvas(w, h); frameGlow = makeCanvas(w, h);
      clearStamps(); fixtureKey = ''; frameKey = ''; fixtureLights = []; currentLights = [];
      metrics.geometryRevision++; return metrics.supported;
    }

    function clipFloor(g) {
      if (interiorPath) { g.clip(interiorPath); return; }
      g.beginPath();
      if (geo && geo.allRects) {
        const T = finite(geometryOptions.tileSize, finite(geo.TILE, 12));
        for (const r of geo.allRects) g.rect(r.x1 * T, r.y1 * T, (r.x2 - r.x1 + 1) * T, (r.y2 - r.y1 + 1) * T);
      }
      g.clip();
    }

    const keyOf = l => l.x + ',' + l.y + ',' + l.r + ',' + l.c.join(',');
    const signature = lights => lights.map(l => keyOf(l) + ',' + Math.round(l.a * 255)).join(';');
    function stamp(light) {
      const key = keyOf(light);
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
      const polygon = visibilityPolygon(light, segments, QUALITY[quality].rays);
      metrics.visibilityBuilds++;
      g.beginPath(); polygon.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.clip();
      clipFloor(g);
      const gradient = g.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.r);
      for (const t of [0, 0.14, 0.3, 0.5, 0.7, 0.86, 1]) gradient.addColorStop(t, 'rgba(' + light.c.join(',') + ',' + falloff(t) + ')');
      g.fillStyle = gradient; g.fillRect(x, y, light.r * 2, light.r * 2);
      const result = { canvas, x, y, size: light.r * 2, pixels: size * size };
      stamps.set(key, result); stampPixels += result.pixels;
      return result;
    }

    function paint(g, lights, amount, mode) {
      g.globalCompositeOperation = mode;
      for (const l of lights) {
        const s = stamp(l); if (!s) continue;
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
      if (surfaceMask && wall > 0) {
        d.drawImage(surfaceMask, 0, 0, width, height); d.globalCompositeOperation = 'source-in';
        d.fillStyle = 'rgba(4,8,18,' + wall + ')'; d.fillRect(0, 0, width, height); d.globalCompositeOperation = 'source-over';
      }
      d.save(); clipFloor(d);
      const inside = surfaceMask ? clamp((ambient - wall) / (1 - wall), 0, 1) : ambient;
      d.fillStyle = 'rgba(5,9,22,' + inside + ')'; d.fillRect(0, 0, width, height); d.restore();
      paint(d, lights, 1, 'destination-out');
      paint(glow, lights, finite(config.fixtureTint, 0.17), 'screen');
      metrics.staticBuilds++;
    }

    function render(ctx, frame) {
      if (disposed || !geo || !ctx || !baseDark || !frameDark) return false;
      frame = frame || {}; const started = clock(), q = QUALITY[quality];
      if (Number.isFinite(+frame.ambient)) config.ambient = +frame.ambient;
      const sourceFixtures = frame.fixtures || [], sourceProps = frame.lights || [];
      const fixtures = sourceFixtures.map(s => normalizeLight(s, true, finite(frame.fixtureGain, 1))).filter(Boolean).slice(0, q.maxSources);
      const lights = sourceProps.map(s => normalizeLight(s, false, finite(frame.emission, config.emission))).filter(Boolean).slice(0, q.maxSources);
      metrics.droppedSources = Math.max(0, sourceFixtures.length - fixtures.length) + Math.max(0, sourceProps.length - lights.length);
      const fk = signature(fixtures) + '|' + config.ambient + ',' + config.wallAmbient + ',' + config.fixtureTint;
      if (fk !== fixtureKey) { rebuildStatic(fixtures); fixtureLights = fixtures; fixtureKey = fk; frameKey = ''; }
      const dk = signature(lights) + '|' + finite(config.propLift, 0.65);
      if (dk !== frameKey) {
        const d = reset(frameDark), glow = reset(frameGlow);
        d.drawImage(baseDark, 0, 0, width, height); glow.drawImage(baseGlow, 0, 0, width, height);
        paint(d, lights, finite(config.propLift, 0.65), 'destination-out'); paint(glow, lights, 1, 'screen');
        frameKey = dk; metrics.dynamicBuilds++;
      }
      currentLights = fixtureLights.concat(lights);
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
        const s = shadowFor(body, currentLights, segments); if (!s) continue;
        const nx = -s.dy * s.width / 2, ny = s.dx * s.width / 2;
        const ex = s.x + s.dx * s.length, ey = s.y + s.dy * s.length;
        const gradient = ctx.createLinearGradient(s.x, s.y, ex + 0.01, ey + 0.01);
        gradient.addColorStop(0, 'rgba(4,7,16,' + s.alpha + ')'); gradient.addColorStop(1, 'rgba(4,7,16,0)');
        ctx.fillStyle = gradient; ctx.beginPath(); ctx.moveTo(s.x + nx, s.y + ny);
        ctx.lineTo(ex + nx * 0.7, ey + ny * 0.7); ctx.lineTo(ex - nx * 0.7, ey - ny * 0.7);
        ctx.lineTo(s.x - nx, s.y - ny); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    function drawAtmosphere(ctx, frame) {
      if (!ctx || disposed || !geo || !fixtureLights.length || !(config.atmosphere > 0)) return;
      frame = frame || {}; if (frame.reducedMotion) return;
      const time = finite(frame.now, 0) * 0.00004, gain = clamp(config.atmosphere, 0, 1);
      ctx.save(); clipFloor(ctx); ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < Math.min(fixtureLights.length, 48); i++) {
        const l = fixtureLights[i];
        for (let j = 0; j < 2; j++) {
          const seed = (i * 0.61803398875 + j * 0.382) % 1;
          const x = l.x + Math.sin(time + seed * TAU) * l.r * 0.45;
          const y = l.y + (((seed + time * 0.35) % 1) - 0.5) * l.r;
          if (!visibleAt(l, x, y, segments)) continue;
          ctx.fillStyle = 'rgba(' + l.c.join(',') + ',' + gain * l.a * 0.55 + ')';
          ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
      }
      ctx.restore();
    }

    function configure(next) {
      if (!next || disposed) return;
      config = Object.assign({}, config, next);
      if (QUALITY[next.quality] && next.quality !== quality) { quality = next.quality; if (geo) setGeometry(geo, geometryOptions); }
      else { fixtureKey = ''; frameKey = ''; }
    }
    function dispose() {
      disposed = true; for (const c of [baseDark, baseGlow, frameDark, frameGlow]) release(c);
      baseDark = null; baseGlow = null; frameDark = null; frameGlow = null;
      clearStamps(); currentLights = []; fixtureLights = []; geo = null; surfaceMask = null; interiorPath = null;
    }
    return { setGeometry, render, drawGrounding, drawAtmosphere, configure, dispose,
      sample: (x, y) => lightAt(x, y, currentLights, segments),
      stats: () => Object.assign({}, metrics, { quality, width, height, resolution: +ratio.toFixed(4),
        segments: segments.length, sources: currentLights.length, cachedStamps: stamps.size,
        ambient: clamp(0.208 + finite(config.ambient, 0.82) * 0.6, 0, 0.9),
        cacheBytes: 4 * stampPixels + (baseDark ? baseDark.width * baseDark.height * 16 : 0), disposed }) };
  }
  return { create, buildSegments, visibilityPolygon, visibleAt, rayDistance, falloff, normalizeLight, lightAt, shadowFor, QUALITY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldLight;
