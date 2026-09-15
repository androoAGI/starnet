/* StarNet reference-authored industrial materials, September 2026.
 * Image-authored albedo; geometry, lighting, seats and live activity remain owned
 * by the station renderer. The industrial set is the default; ?textures=classic
 * retains the original renderer for comparison and recovery.
 * A failed or pending asset keeps the complete existing material set visible.
 */
'use strict';
const IndustrialTextures = (() => {
  let requested = true, crateReview = false, projectionReview = false;
  try {
    const query = new URLSearchParams(location.search);
    requested = query.get('textures') !== 'classic';
    crateReview = query.get('propReview') === 'crate';
    projectionReview = query.get('textures') !== 'classic' && query.get('propReview') !== 'skins' && query.get('propSet') !== 'approved';
  } catch (_) {}
  const images = {}, failed = [];
  // Exposed to the existing CRT lab for a live, reproducible material review.
  // Values read back from the live CRT lab after the combined-room review.
  const lighting = { fixtureTint: projectionReview?.14:.04, propTint: projectionReview?.65:.48,
    propLift: projectionReview?.85:.65, ambientLift: projectionReview?.10:0,
    floorGain: projectionReview?1.04:1, wallGain: projectionReview?.86:1, contact: .28 };
  const plates = new WeakMap();
  const platePyramids = new WeakMap();
  const detailTargets = new WeakMap(), wallStrips = new Map(), materials = new Map(), emitters = new Map();
  let loaded = false;
  const floorIds = 'spine alloy plate panel tile tread soft grate hex plank turf diamond resin ceramic cargo runner treadway meshway basalt parquet rubber slotted terrazzo octile'.split(' ');
  const wallIds = 'bulkhead courses service plating ribbed panelled pipework'.split(' ');
  const names = ['floor', 'wall', 'shell', 'workstation', 'workstation-compact', 'chair-s', 'chair-e', 'chair-n',
    'tactical-table', 'console-bank', 'equipment-bay', 'deck-perimeter',
    ...floorIds.map(id => 'remaster/floors/' + id), ...wallIds.map(id => 'remaster/walls/' + id),
    'remaster/shell', 'remaster/workstation-e', 'remaster/workstation-n', 'remaster/workstation-compact-n',
    'calibration/crate'];
  // The references are already lit pictures. These measured albedo gains keep
  // the existing light simulation from applying a second exposure to the art.
  const gain = { floor: 1.25, wall: 1.65, shell: 2.05, workstation: 1.5, 'workstation-compact': 1.5,
    'chair-s': 1.3, 'chair-e': 1.3, 'chair-n': 1.3,
    'tactical-table': 1.5, 'console-bank': 1.5, 'equipment-bay': 1.5, 'deck-perimeter': 1.0,
    'calibration/crate': 1.5 };
  const ready = requested && typeof Image !== 'undefined' ? Promise.all(names.map(name => new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext('2d');
        const exposure = gain[name] || (name.includes('/floors/') ? 1.25 : name.includes('/walls/') ? 1.65 : name.endsWith('/shell') ? 2.05 : 1.5);
        ctx.filter = 'brightness(' + exposure + ')'; ctx.drawImage(img, 0, 0);
        images[name] = cv;
      } catch (_) { failed.push(name); }
      resolve();
    };
    img.onerror = () => { failed.push(name); resolve(); };
    img.src = 'assets/industrial/' + name + '.png';
  }))).then(() => {
    loaded = !failed.length;
    document.documentElement.dataset.texturePack = loaded ? 'industrial' : 'fallback';
    document.documentElement.dataset.textureRevision = loaded ? 'bridge-remaster' : 'native';
    document.documentElement.dataset.propReview = loaded && crateReview ? 'crate' : 'none';
  }) : Promise.resolve();
  const enabled = () => requested && loaded;
  const isRemaster = enabled;
  const mod = (n, d) => ((n % d) + d) % d;

  // Paint stays a real material choice. Tint is applied once to the authored
  // albedo, before lighting; the dark engraved structure survives every hue.
  function material(name, base) {
    const im = images[name];
    const gain = projectionReview ? Math.max(.65,Math.min(1.2,Number(name.includes('/floors/')?lighting.floorGain:name.includes('/walls/')?lighting.wallGain:1)||1)) : 1;
    if (!im || !base && gain===1) return im;
    const key = name + ':' + base + ':' + gain;
    if (materials.has(key)) return materials.get(key);
    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d');
    let paintGain=1;
    if (/^#[0-9a-f]{6}$/i.test(base)) {
      const rgb = parseInt(base.slice(1), 16), mean = ((rgb >> 16) + ((rgb >> 8) & 255) + (rgb & 255)) / 3;
      paintGain=Math.max(.8, Math.min(1.25, .8 + mean / 300));
    }
    g.filter='brightness('+(paintGain*gain)+')';
    g.drawImage(im, 0, 0); g.filter = 'none';
    if(base){g.globalCompositeOperation = 'color'; g.globalAlpha = .42;
    g.fillStyle = base; g.fillRect(0, 0, cv.width, cv.height);}
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    if (materials.size > 128) materials.clear();
    materials.set(key, cv); return cv;
  }

  // Tee the base painter into a denser art plate. The original canvas remains
  // the exact geometry/alpha/readback authority for lights, chunks and picking.
  // Only the final visible blit uses the denser plate; simulation units stay 12px.
  function detailContext(ctx) {
    if (!enabled()) return ctx;
    const source = ctx.canvas, scale = Math.min(6, 4096 / Math.max(source.width, source.height));
    if (scale < 1.5) return ctx;
    const cv = document.createElement('canvas'); cv.width = Math.ceil(source.width * scale); cv.height = Math.ceil(source.height * scale);
    const g = cv.getContext('2d'), transform = ctx.getTransform();
    g.scale(scale, scale); g.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    g.imageSmoothingEnabled = false;
    const paintObjects = new WeakMap();
    plates.set(source, cv);
    if (cv.addEventListener) cv.addEventListener('contextlost', () => plates.delete(source), { once: true });
    document.documentElement.dataset.textureResolution = String(scale);
    const proxy = new Proxy(ctx, {
      set(target, key, value) { target[key] = value; g[key] = paintObjects.get(value) || value; return true; },
      get(target, key) {
        const value = target[key]; if (typeof value !== 'function') return value;
        if (['getImageData', 'getTransform', 'measureText', 'isPointInPath', 'isPointInStroke', 'getContextAttributes'].includes(key)) return value.bind(target);
        if (key === 'drawImage') return (im, ...args) => {
          platePyramids.delete(cv);
          const result = target.drawImage(im, ...args), hi = plates.get(im);
          if (!hi) g.drawImage(im, ...args);
          else if (args.length === 2) g.drawImage(hi, ...args, im.width, im.height);
          else if (args.length === 4) g.drawImage(hi, ...args);
          else {
            const [sx, sy, sw, sh, ...dest] = args;
            g.drawImage(hi, sx * hi.width / im.width, sy * hi.height / im.height,
              sw * hi.width / im.width, sh * hi.height / im.height, ...dest);
          }
          return result;
        };
        if (key === 'setTransform' || key === 'resetTransform') return (...args) => {
          value.apply(target, args);
          const m = target.getTransform();
          g.setTransform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e * scale, m.f * scale);
        };
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') return (...args) => {
          const a = target[key](...args), b = g[key](...args);
          if (a && b) {
            paintObjects.set(a, b);
            for (const method of ['addColorStop', 'setTransform']) if (typeof a[method] === 'function') {
              const original = a[method].bind(a);
              a[method] = (...params) => { b[method](...params); return original(...params); };
            }
          }
          return a;
        };
        return (...args) => { platePyramids.delete(cv); const result = value.apply(target, args); g[key](...args); return result; };
      }
    });
    detailTargets.set(proxy, { g, scale });
    return proxy;
  }
  function drawBase(ctx, cv, x = 0, y = 0) {
    const hi = enabled() && plates.get(cv);
    if (!hi) return false;
    let source=hi;
    if(projectionReview && ctx.getTransform){
      // Pre-filter the authored plate in bounded half-size steps. A direct
      // six-to-one sample makes rivets and cable ribs alias at overview zoom.
      // Each level keeps the same world rectangle and premultiplied alpha.
      const m=ctx.getTransform(), density=Math.max(Math.hypot(m.a,m.b),Math.hypot(m.c,m.d));
      const target=Math.max(.25,density), baseDensity=hi.width/cv.width;
      let chain=platePyramids.get(hi);
      if(!chain){chain=[hi];platePyramids.set(hi,chain);}
      let level=0;
      while(baseDensity/Math.pow(2,level+1)>=target && level<5){
        level++;
        if(!chain[level]){
          const previous=chain[level-1],small=document.createElement('canvas');
          small.width=Math.max(1,Math.ceil(previous.width/2));small.height=Math.max(1,Math.ceil(previous.height/2));
          const sg=small.getContext('2d');sg.imageSmoothingEnabled=true;sg.imageSmoothingQuality='high';
          sg.drawImage(previous,0,0,small.width,small.height);chain.push(small);
          if(small.addEventListener)small.addEventListener('contextlost',()=>platePyramids.delete(hi),{once:true});
        }
      }
      source=chain[level];
    }
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, x, y, cv.width, cv.height); ctx.restore(); return true;
  }

  function floor(ctx, X, Y, size, tx, ty, id = 'plate', base, opts) {
    if (!enabled()) return false;
    if (opts && opts.detail === 0) return false;
    const im = material('remaster/floors/' + (floorIds.includes(id) ? id : 'plate'), base), period = 8;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, mod(tx, period) * im.width / period, mod(ty, period) * im.height / period,
      im.width / period, im.height / period, X, Y, size, size);
    ctx.restore(); return true;
  }
  function wall(ctx, X, Y, width, height, tx, id = 'bulkhead', base, opts) {
    if (!enabled()) return false;
    if (opts && opts.detail === 0) return false;
    const im = material('remaster/walls/' + (wallIds.includes(id) ? id : 'bulkhead'), base);
    // One structural bay spans four game tiles. This matches the side/corner
    // face-strip period, so the same material wraps without an extra seam.
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, mod(tx, 4) * im.width / 4, 0, im.width / 4, im.height, X, Y, width, height);
    ctx.restore(); return true;
  }
  function wallStrip(height, id = 'bulkhead', base, opts) {
    if (!enabled()) return null;
    if (opts && opts.detail === 0) return null;
    const key = [height, id, base || '', opts && opts.detail,projectionReview?lighting.wallGain:1].join(':');
    if (wallStrips.has(key)) return wallStrips.get(key);
    const im = material('remaster/walls/' + (wallIds.includes(id) ? id : 'bulkhead'), base);
    const render = scale => {
      const cv = document.createElement('canvas'); cv.width = 48 * scale; cv.height = height * scale;
      const g = cv.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, cv.width, cv.height);
      return { d: g.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
    };
    const strip = { ...render(1), x0: 0, hi: { ...render(6), scale: 6 } };
    if (wallStrips.size > 128) wallStrips.clear();
    wallStrips.set(key, strip); return strip;
  }
  function wallPatch(ctx, x, y, w, h, strip, map) {
    const target = enabled() && detailTargets.get(ctx);
    if (!target || !strip || !strip.hi) return;
    const { g, scale } = target, hi = strip.hi, step = 1 / Math.ceil(scale);
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    for (let yy = y; yy < y + h - 1e-8; yy += step) for (let xx = x; xx < x + w - 1e-8; xx += step) {
      const m = map(xx + step / 2 - .5, yy + step / 2 - .5);
      const sx = Math.floor(mod(m.a + .5, strip.w) * hi.scale);
      const sy = Math.max(0, Math.min(hi.h - 1, Math.floor(m.d * hi.scale)));
      const i = (sy * hi.w + sx) * 4, d = hi.d;
      g.fillStyle = 'rgb(' + d[i] + ',' + d[i+1] + ',' + d[i+2] + ')';
      g.fillRect(xx, yy, Math.min(step, x + w - xx), Math.min(step, y + h - yy));
    }
    g.restore();
  }
  function shell(ctx, width, height, vx, vy, topOf, base) {
    if (!enabled()) return false;
    const im = material('remaster/shell', base), period = 96;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    // Sample each column relative to its actual contour top. The geometry's
    // alpha mask and exposure pass still clip and shade the resulting cladding.
    for (let x = 0; x < width; x++) {
      const top = topOf && topOf[x] >= 0 ? topOf[x] : -vy;
      for (let y = 0; y < height;) {
        const sy = mod(y - top, period), h = Math.min(period - sy, height - y);
        ctx.drawImage(im, mod(vx + x, period) * im.width / period, sy * im.height / period,
          im.width / period, h * im.height / period, x, y, 1, h);
        y += h;
      }
      const shade = ctx.createLinearGradient(0, top, 0, top + 40);
      shade.addColorStop(0, 'rgba(0,0,0,0.12)'); shade.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = shade; ctx.fillRect(x, 0, 1, height);
    }
    ctx.restore(); return true;
  }
  function shellPlate(ctx, x, y, width, height, base) {
    if (!enabled()) return false;
    ctx.save(); ctx.imageSmoothingEnabled = true;
    for (let yy = y; yy < y + height; yy += 96) for (let xx = x; xx < x + width; xx += 96) {
      const w = Math.min(96, x + width - xx), h = Math.min(96, y + height - yy), im = material('remaster/shell', base);
      ctx.drawImage(im, 0, 0, im.width * w / 96, im.height * h / 96, xx, yy, w, h);
    }
    ctx.restore(); return true;
  }
  // Fine authored grain sits inside native casing faces, beneath their hardware.
  // It never paints lights, text, upholstery or the prop's external silhouette.
  function propPanel(ctx, x, y, w, h, base) {
    if (!enabled() || w < 4 || h < 2) return false;
    const im = material('remaster/floors/plate', base);
    ctx.save(); ctx.globalAlpha *= .34; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(im, im.width * .035, im.height * .035, im.width * .18, im.height * .18, x, y, w, h);
    ctx.restore(); return true;
  }
  function workstationFit(x, y, w, h, facing) {
    const compact = Math.max(w, h) < 30, side = facing === 'e';
    const name = side ? 'remaster/workstation-e' : facing === 'n'
      ? 'remaster/workstation' + (compact ? '-compact' : '') + '-n'
      : compact ? 'workstation-compact' : 'workstation';
    const im = images[name];
    // The side cabinet occupies 75% of the source silhouette width. Its monitor
    // overhang is real height above the walkable footprint, not a wider base.
    // The broad rear crown also overhangs its cabinet; keep the same standing height.
    const cabinetFraction = side ? .75 : facing === 'n' && !compact ? .92 : 1;
    const scale = Math.min((w + 2) / (im.width * cabinetFraction), (h + 11.5) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    return { name, im, x: x + (w - dw) / 2, y: y + h - dh, w: dw, h: dh };
  }
  // A screen's authored cyan phosphor is the only mutable part of its raster.
  // Keep the bezel, brass controls, silhouette and camera projection untouched.
  // Three front/side sources are cached once; rear views have no visible glass.
  const workstationScreens = new Map();
  function workstationScreen(fit) {
    if (workstationScreens.has(fit.name)) return workstationScreens.get(fit.name);
    const im = fit.im, g = im.getContext('2d');
    if (!g || !g.getImageData) return null;
    const data = g.getImageData(0, 0, im.width, im.height);
    const off = document.createElement('canvas'); off.width = im.width; off.height = im.height;
    const og = off.getContext('2d');
    // Canvas-less consumers retain the image path; native/browser renderers own pixels.
    if (!og || !og.putImageData || !og.createImageData) return null;
    const original = data.data, dim = og.createImageData(im.width, im.height);
    dim.data.set(original);
    let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
    for (let i = 0; i < original.length; i += 4) {
      const r = original[i], cyan = Math.min(original[i+1], original[i+2]) - r;
      if (original[i+3] < 200 || cyan < 8 || r > Math.min(original[i+1], original[i+2]) * .8) continue;
      // Dark smoked glass retains a faint etched diagram, never an emissive CRT.
      dim.data[i] = Math.min(12, r * .2 + 3);
      dim.data[i+1] = Math.min(20, original[i+1] * .055 + 7);
      dim.data[i+2] = Math.min(22, original[i+2] * .06 + 8);
      const pixel = i / 4, x = pixel % im.width, y = Math.floor(pixel / im.width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    og.putImageData(dim, 0, 0);
    const value = { off, x: x0, y: y0, w: x1-x0+1, h: y1-y0+1, frames: new Map(), original };
    workstationScreens.set(fit.name, value); return value;
  }
  function workstationSweep(screen, fit, phase) {
    if (screen.frames.has(phase)) return screen.frames.get(phase);
    const cv = document.createElement('canvas'); cv.width = screen.w; cv.height = screen.h;
    const g = cv.getContext('2d'), patch = g.createImageData(cv.width, cv.height), d = patch.data;
    for (let y = 0; y < screen.h; y++) for (let x = 0; x < screen.w; x++) {
      const source = ((screen.y+y)*fit.im.width+screen.x+x)*4, r = screen.original[source];
      const cyan = Math.min(screen.original[source+1], screen.original[source+2]) - r;
      if (screen.original[source+3] < 200 || cyan < 8 || r > Math.min(screen.original[source+1], screen.original[source+2]) * .8) continue;
      // The beam crosses only existing phosphor, so even the steep side view
      // stays in its exact screen plane. No invented work counters or code logs.
      const position = y / Math.max(1, screen.h-1);
      const distance = Math.abs(position - phase / 15);
      const beam = Math.max(0, 1 - distance / .2);
      const i = (y*screen.w+x)*4;
      d[i]=115; d[i+1]=235; d[i+2]=244; d[i+3]=Math.round(Math.min(1,cyan/100)*beam*125);
    }
    g.putImageData(patch,0,0); screen.frames.set(phase,cv); return cv;
  }
  function workstation(ctx, x, y, w, h, facing = 's', state) {
    if (!enabled()) return false;
    const fit = workstationFit(x, y, w, h, facing);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const occupied = state ? (typeof state.occupied === 'boolean' ? state.occupied : !!state.work) : true;
    const screen = facing === 'n' ? null : workstationScreen(fit);
    ctx.drawImage(!occupied && screen ? screen.off : fit.im, fit.x, fit.y, fit.w, fit.h);
    if (state && occupied && screen && screen.w > 0 && screen.h > 0 && !(state && state.still)) {
      const phase = Math.floor((Math.max(0, Number(state && state.now) || 0) % 2800) / 175);
      const patch = workstationSweep(screen, fit, phase);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha *= state && state.work ? .8 + .2*Math.min(1, Math.max(0, state.heat || 0)) : .65;
      ctx.drawImage(patch, fit.x + screen.x / fit.im.width * fit.w, fit.y + screen.y / fit.im.height * fit.h,
        screen.w / fit.im.width * fit.w, screen.h / fit.im.height * fit.h);
    }
    ctx.restore(); return true;
  }
  function workstationEmitter(x, y, w, h, facing = 's') {
    if (!enabled() || facing === 'n') return null;
    const fit = workstationFit(x, y, w, h, facing);
    if (!emitters.has(fit.name)) {
      const d = fit.im.getContext('2d').getImageData(0, 0, fit.im.width, fit.im.height).data;
      let sx = 0, sy = 0, weight = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        if (d[i+3] < 200 || g < 70 || b < 70 || r > Math.min(g, b) * .55) continue;
        const wt = Math.min(g, b) - r, pixel = i / 4;
        sx += (pixel % fit.im.width + .5) * wt; sy += (Math.floor(pixel / fit.im.width) + .5) * wt; weight += wt;
      }
      emitters.set(fit.name, weight ? { x: sx / weight / fit.im.width, y: sy / weight / fit.im.height } : null);
    }
    const p = emitters.get(fit.name); return p ? { x: fit.x + fit.w * p.x, y: fit.y + fit.h * p.y } : null;
  }
  function chair(ctx, x, y, w, h, facing = 's') {
    if (!enabled()) return false;
    const im = images['chair-' + facing], scale = Math.min(w / im.width, (h + 4) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
    ctx.restore(); return true;
  }
  // Larger command furniture has real catalog footprints. Its transparent
  // artwork is contained within that width and anchored to the floor line,
  // just like the desk; no baked room, floor, or decorative cast shadow.
  function furniture(ctx, name, x, y, w, h) {
    if (!enabled() || !images[name]) return false;
    if (name === 'deck-perimeter') {
      // Floor paint follows the actual decal rectangle, including quarter turns.
      // Its transparent middle preserves the deck texture and allows furnishings.
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(images[name], x, y, w, h); ctx.restore(); return true;
    }
    const im = images[name], rise = name === 'console-bank' ? 30 : 12;
    const scale = Math.min(w / im.width, (h + rise) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
    ctx.restore(); return true;
  }
  // One-prop review only. Its original 2x1 placement rectangle and ground line
  // remain authoritative; source aspect is never stretched to fill that rectangle.
  function crate(ctx, x, y, w, h) {
    if (!enabled() || !images['calibration/crate']) return false;
    const im = images['calibration/crate'];
    const scale = Math.min((w + 2) / im.width, (h + 10) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
    ctx.restore(); return true;
  }
  return Object.freeze({ ready, enabled, isRemaster, lighting, detailContext, drawBase, floor, wall, wallStrip, wallPatch, shell, shellPlate, propPanel, workstation, workstationEmitter, chair, crate,
    furniture,
    status: () => ({ requested, loaded, failed: failed.slice(), assets: Object.keys(images) }) });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = IndustrialTextures;
