/* StarNet — authored station materials.
 *
 * Pure, deterministic pixel painters. The renderer owns the cached station/chunk
 * canvases; this module owns their surface art. It never reads clock, room names,
 * telemetry, or camera state. Physical tile coordinates keep the same floor in
 * place when a build edit grows the station's local coordinate frame.
 *
 * paintFloorTile(ctx, material, base, X, Y, tile, worldTx, worldTy, {detail})
 * paintWallTile(ctx, material, base, X, Y, tile, height, tileX, {detail})
 *   -> true when painted; false for walls requiring the existing specialized art.
 * paint(ctx, geo, {viewport, detail, trim}) paints the complete floor in bake coords.
 * bake(geo, {viewport, canvasFactory, detail, trim}) returns a cached-floor plate.
 *
 * Wall recipes own only the face. The geometry renderer still owns the crown,
 * silhouette, windows, occlusion and light masks, including curved/side-wall
 * sampling of these same recipes. No emissive/status hardware is invented here.
 */
'use strict';

const WorldSurface = (() => {
  const VERSION = 2;
  const CELL = 12;
  const MATERIALS = Object.freeze([
    'spine', 'alloy', 'plate', 'panel', 'tile', 'tread', 'soft', 'grate', 'hex',
    'plank', 'turf', 'diamond', 'resin', 'ceramic', 'cargo', 'runner', 'treadway', 'meshway'
  ]);
  const WALLS = Object.freeze(['bulkhead', 'courses', 'service', 'plating', 'ribbed', 'panelled', 'pipework']);
  const materialSet = new Set(MATERIALS), wallSet = new Set(WALLS);
  const palettes = new Map();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mod = (v, n) => ((v % n) + n) % n;
  const detailOf = opts => clamp(Number.isFinite(opts && opts.detail) ? opts.detail : 1, 0, 1.5);
  const validColor = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >>> 16, (n >>> 8) & 255, n & 255]; };
  const hex = c => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const blend = (a, b, t) => hex(a.map((v, i) => v + (b[i] - v) * t));
  function hash(x, y, seed) {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
  }

  // Warm highlights and cool recesses share the selected paint's hue. The small
  // tone range belongs to the albedo; broad light modelling belongs to WorldLight.
  function palette(base, detail = 1) {
    base = validColor(base) ? base.toLowerCase() : '#3a3b41';
    detail = clamp(Number.isFinite(detail) ? detail : 1, 0, 1.5);
    const key = base + '|' + detail;
    if (palettes.has(key)) return palettes.get(key);
    const c = rgb(base);
    const light = [206, 213, 210].map((v, i) => Math.max(v, c[i] + (255 - c[i]) * 0.72));
    const warm = [204, 187, 154].map((v, i) => Math.max(v, c[i] + (255 - c[i]) * 0.5));
    const dark = [7, 13, 23].map((v, i) => Math.min(v, c[i] * 0.7));
    const p = Object.freeze({
      base, field: blend(c, light, 0.025 * detail), raised: blend(c, light, 0.055 * detail),
      shade: blend(c, dark, 0.14 * detail), recess: blend(c, dark, 0.34 * detail),
      deep: blend(c, dark, 0.57 * detail), edge: blend(c, light, 0.15 * detail),
      metal: blend(c, light, 0.23 * detail), warm: blend(c, warm, 0.16 * detail),
      soft: blend(c, dark, 0.06 * detail), fine: blend(c, light, 0.07 * detail)
    });
    if (palettes.size >= 512) palettes.clear();
    palettes.set(key, p);
    return p;
  }

  // All artwork uses a 12px authoring grid. Clipped integer fills retain the
  // pixel scale even in material swatches with a different displayed tile size.
  function brush(ctx, X, Y, width, height = width) {
    const sx = width / CELL, sy = height / CELL;
    return (x, y, w, h, color) => {
      const x0 = Math.max(0, Math.round(x * sx)), y0 = Math.max(0, Math.round(y * sy));
      const x1 = Math.min(width, Math.round((x + w) * sx)), y1 = Math.min(height, Math.round((y + h) * sy));
      if (x1 <= x0 || y1 <= y0) return;
      ctx.fillStyle = color; ctx.fillRect(X + x0, Y + y0, x1 - x0, y1 - y0);
    };
  }
  function bolt(p, x, y, pal) {
    p(x, y, 2, 2, pal.recess); p(x, y, 1, 1, pal.metal);
  }
  function floorPanel(p, pal, wx, wy, w, h, opts = {}) {
    const row = Math.floor(wy / h), stagger = opts.stagger && mod(row, 2) ? w / 2 : 0;
    const lx = mod(wx + stagger, w), ly = mod(wy, h);
    const panelX = Math.floor((wx + stagger) / w), seed = hash(panelX, row, 31);
    p(0, 0, CELL, CELL, seed % 3 === 0 ? pal.raised : pal.field);
    // One physical plate, with a recessed gasket and a turned upper lip. The
    // opposite edges fall into the joint; large faces stay quiet between them.
    // All four edges belong to this same world-anchored panel, including clips.
    p(-lx, -ly, w, 1, pal.recess);
    p(1 - lx, 1 - ly, w - 2, 1, pal.edge);
    p(-lx, -ly, 1, h, pal.recess);
    p(1 - lx, 2 - ly, 1, h - 2, pal.fine);
    p(2 - lx, h - 2 - ly, w - 3, 1, pal.shade);
    p(1 - lx, h - 1 - ly, w - 1, 1, pal.recess);
    p(w - 2 - lx, 2 - ly, 1, h - 4, pal.soft);
    p(w - 1 - lx, 1 - ly, 1, h - 2, pal.recess);
    if (opts.bolts) {
      bolt(p, 3 - lx, 3 - ly, pal);
      bolt(p, w - 5 - lx, h - 5 - ly, pal);
    }
    return { lx, ly, seed, panelX, row };
  }

  function paintFloorTile(ctx, material, base, X, Y, tile, worldTx, worldTy, opts) {
    const mat = materialSet.has(material) ? material : 'plate';
    const size = Math.max(1, Math.round(tile || CELL)), d = detailOf(opts);
    const pal = palette(base, d), p = brush(ctx, X, Y, size);
    const tx = Math.floor(worldTx || 0), ty = Math.floor(worldTy || 0), wx = tx * CELL, wy = ty * CELL;
    p(0, 0, CELL, CELL, pal.base);
    if (!d) return true;

    if (mat === 'plank') {
      for (let row = 0; row < 2; row++) {
        const gy = ty * 2 + row, shift = mod(gy, 3) * 17, lx = mod(wx + shift, 48);
        const seed = hash(Math.floor((wx + shift) / 48), gy, 71), y = row * 6;
        p(0, y, CELL, 6, seed % 3 === 0 ? pal.raised : pal.field);
        p(0, y, CELL, 1, pal.recess); p(0, y + 1, CELL, 1, pal.fine);
        p(-lx, y, 1, 6, pal.recess); p(1 - lx, y + 1, 1, 4, pal.fine);
        p((seed >>> 8) % 5 - 2, y + 3, 7, 1, pal.soft);
        if (seed % 5 === 0) p(7, y + 4, 4, 1, pal.fine);
        if (lx > 16 && lx < 28 && seed % 7 === 2) {
          p(5, y + 3, 3, 1, pal.recess); p(4, y + 4, 5, 1, pal.shade);
        }
      }
      return true;
    }
    if (mat === 'turf') {
      p(0, 0, CELL, CELL, pal.shade);
      // Cluster silhouettes, rather than uniformly scattered bright pixels.
      for (let i = 0; i < 5; i++) {
        const n = hash(tx, ty, 180 + i), x = n % 12, y = (n >>> 9) % 12;
        p(x - 2, y, 5, 2, pal.base); p(x, y - 2, 2, 4, pal.field);
        p(x + 1, y - 1, 3, 1, pal.raised); p(x - 1, y + 2, 3, 1, pal.recess);
      }
      return true;
    }
    if (mat === 'grate' || mat === 'meshway') {
      p(0, 0, CELL, CELL, pal.deep);
      for (let i = 0; i < CELL; i += 4) {
        p(i, 0, 2, CELL, pal.shade); p(i, 0, 1, CELL, pal.edge);
        p(0, i, CELL, 1, pal.recess); p(0, i + 1, CELL, 1, pal.fine);
      }
      if (mat === 'meshway') {
        const lx = mod(wx, 24), ly = mod(wy, 24);
        p(-lx, 0, 3, CELL, pal.base); p(-lx, 0, 1, CELL, pal.edge);
        p(0, -ly, CELL, 3, pal.base); p(0, 2 - ly, CELL, 1, pal.recess);
      }
      return true;
    }
    if (mat === 'hex') {
      p(0, 0, CELL, CELL, pal.field);
      // Integer, staggered hexagons. Every segment is clipped locally, so the
      // lattice crosses chunk and zone boundaries without an edge artifact.
      for (let rx = Math.floor(wx / 9) - 1; rx <= Math.floor((wx + 12) / 9); rx++) {
        const ox = rx * 9 - wx, shift = mod(rx, 2) * 4;
        for (let ry = Math.floor((wy - shift) / 8) - 1; ry <= Math.floor((wy + 12 - shift) / 8); ry++) {
          const oy = ry * 8 + shift - wy;
          p(ox + 3, oy, 6, 1, pal.recess); p(ox + 4, oy + 1, 4, 1, pal.fine);
          for (let k = 0; k < 3; k++) {
            p(ox + 2 - k, oy + k + 1, 1, 1, pal.recess);
            p(ox + 9 + k, oy + k + 1, 1, 1, pal.recess);
            p(ox + k, oy + 4 + k, 1, 1, pal.recess);
            p(ox + 11 - k, oy + 4 + k, 1, 1, pal.recess);
          }
          p(ox + 3, oy + 7, 6, 1, pal.shade);
        }
      }
      return true;
    }
    if (mat === 'diamond') {
      p(0, 0, CELL, CELL, pal.field);
      for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
        const x = ix * 6 + mod(iy, 2) * 2, y = iy * 6 + 1;
        p(x, y + 2, 2, 1, pal.shade); p(x + 1, y + 1, 2, 1, pal.edge);
        p(x + 2, y, 2, 1, pal.fine); p(x + 3, y + 1, 1, 1, pal.recess);
      }
      return true;
    }
    if (mat === 'resin') {
      const block = hash(Math.floor(tx / 3), Math.floor(ty / 3), 101);
      p(0, 0, CELL, CELL, block % 3 ? pal.field : pal.raised);
      if (mod(ty, 3) === 0) p(0, 0, CELL, 1, pal.soft);
      if (mod(tx, 3) === 0) p(0, 0, 1, CELL, pal.soft);
      // A shallow clearcoat roll-off spans a whole poured slab. It is a
      // material finish, never a reflected object or an invented light source.
      const lx = mod(wx, 36), ly = mod(wy, 36);
      p(3 - lx, 3 - ly, 29, 2, pal.raised);
      p(5 - lx, 5 - ly, 24, 1, pal.fine);
      if (hash(tx, ty, 102) % 13 === 2) p(2, 8, 6, 1, pal.fine);
      return true;
    }

    const w = mat === 'spine' ? 36 : mat === 'tile' ? 12 : 24;
    const h = mat === 'panel' ? 12 : mat === 'tile' ? 12 : 24;
    const q = floorPanel(p, pal, wx, wy, w, h, { stagger: mat === 'panel', bolts: mat === 'alloy' || mat === 'cargo' });
    const lx = q.lx, ly = q.ly;
    if (mat === 'spine') {
      // Main deck: a narrow recessed service channel every three tiles, with
      // a quiet 32px walking plate. No inspection-hatch confetti in the field.
      p(32 - lx, 0, 4, CELL, pal.recess); p(32 - lx, 0, 1, CELL, pal.fine);
      for (let y = -ly + 4; y < CELL; y += 6) p(34 - lx, y, 2, 1, pal.shade);
      if (q.row % 3 === 0) p(4 - lx, 4 - ly, 6, 1, pal.warm);
    } else if (mat === 'alloy') {
      p(4 - lx, 3 - ly, 14, 2, pal.raised);
      p(5 - lx, 5 - ly, 11, 1, pal.fine);
      p(3 - lx, 20 - ly, 8, 1, pal.soft);
      p(21 - lx, 4 - ly, 1, 13, pal.shade);
    } else if (mat === 'plate') {
      // Wear stays at a panel's service edge instead of becoming floor noise.
      if (q.seed % 5 === 1) {
        p(4 - lx, h - 5 - ly, 7, 1, pal.soft);
        p(6 - lx, h - 4 - ly, 4, 1, pal.fine);
      }
    } else if (mat === 'panel') {
      p(3 - lx, 8 - ly, 14, 1, pal.soft); p(20 - lx, 4 - ly, 2, 1, pal.recess);
    } else if (mat === 'tile' || mat === 'ceramic') {
      p(2 - lx, 2 - ly, w - 3, h - 3, mod(q.panelX + q.row, 2) ? pal.raised : pal.field);
      p(2 - lx, 2 - ly, w - 4, 1, pal.edge);
      p(w - 2 - lx, 3 - ly, 1, h - 4, pal.shade);
      p(3 - lx, h - 2 - ly, w - 5, 1, pal.shade);
      if (mat === 'ceramic') {
        p(4 - lx, 4 - ly, 12, 2, pal.raised);
        p(5 - lx, 6 - ly, 9, 1, pal.fine);
      }
    } else if (mat === 'tread' || mat === 'treadway') {
      for (let i = 0; i < 2; i++) {
        const y = 3 + i * 6;
        p(3, y, 3, 1, pal.edge); p(6, y + 1, 3, 1, pal.edge);
        p(3, y + 1, 3, 1, pal.recess); p(6, y + 2, 3, 1, pal.recess);
      }
      if (mat === 'treadway') {
        p(2 - lx, 0, 2, CELL, pal.shade); p(20 - lx, 0, 2, CELL, pal.shade);
      }
    } else if (mat === 'cargo') {
      p(3 - lx, 3 - ly, 5, 2, pal.shade); p(3 - lx, 3 - ly, 5, 1, pal.warm);
      p(16 - lx, 20 - ly, 5, 2, pal.shade); p(17 - lx, 20 - ly, 4, 1, pal.fine);
    } else if (mat === 'soft') {
      p(0, 0, CELL, CELL, pal.base);
      if (ly === 0) for (let x = 1; x < CELL; x += 4) p(x, 0, 2, 1, pal.shade);
      if (lx === 0) for (let y = 2; y < CELL; y += 4) p(0, y, 1, 2, pal.shade);
      if (hash(tx, ty, 901) % 3 === 1) p(3, 5, 5, 1, pal.soft);
    } else if (mat === 'runner') {
      p(2 - lx, 0, 20, CELL, pal.shade);
      p(3 - lx, 0, 1, CELL, pal.warm); p(20 - lx, 0, 1, CELL, pal.warm);
      for (let y = 3; y < CELL; y += 4) p(6 - lx, y, 12, 1, pal.soft);
    }
    return true;
  }

  function paintWallTile(ctx, material, base, X, Y, tile, height, tileX, opts) {
    if (!wallSet.has(material)) return false;
    const w = Math.max(1, Math.round(tile || CELL)), h = Math.max(1, Math.round(height || 30));
    const d = detailOf(opts), pal = palette(base, d), scale = w / CELL;
    const wx = Math.floor(tileX || 0) * CELL;
    // The face's structural depth is measured in real pixels, while its along-
    // wall rhythm shares the floor's 12px authoring grid.
    const p = (x, y, rw, rh, color) => {
      const x0 = clamp(Math.round(x * scale), 0, w), y0 = clamp(Math.round(y), 0, h);
      const x1 = clamp(Math.round((x + rw) * scale), 0, w), y1 = clamp(Math.round(y + rh), 0, h);
      if (x1 <= x0 || y1 <= y0) return;
      ctx.fillStyle = color; ctx.fillRect(X + x0, Y + y0, x1 - x0, y1 - y0);
    };
    p(0, 0, CELL, h, pal.shade);
    if (!d) return true;
    const belt = Math.max(5, Math.round(h * 0.64)), foot = Math.max(belt + 2, h - 5);
    // Four-tile period also matches the geometry renderer's face-strip cache:
    // its side/corner sampling must see the same frame as the straight face.
    const lx = mod(wx, material === 'panelled' ? 48 : 24);
    // Three value bands make the wall read as vertical construction. Large
    // recessed bays provide room for the occasional rail or service fitting.
    p(0, 0, CELL, 1, pal.deep); p(0, 1, CELL, 2, pal.recess); p(0, 3, CELL, 2, pal.edge);
    p(0, 5, CELL, belt - 5, pal.shade);
    p(0, 5, CELL, 1, pal.fine);                       // crown undercut catches a narrow rim
    // The dado is a vertical material face, not a second broad cast shadow.
    // Keep its narrow joint while letting the existing shade tone carry the bay.
    p(0, belt, CELL, h - belt, pal.shade);
    p(0, belt, CELL, 1, pal.recess); p(0, belt + 1, CELL, 1, pal.soft);
    p(0, foot, CELL, h - foot, pal.shade);
    p(0, foot, CELL, 1, pal.edge);
    p(0, foot + 1, CELL, 1, pal.base);                // bevelled kick-plate nose
    p(0, h - 2, CELL, 1, pal.recess); p(0, h - 1, CELL, 1, pal.deep);

    if (material === 'courses') {
      for (let y = 7, row = 0; y < foot; y += 6, row++) {
        const cx = mod(wx + mod(row, 2) * 12, 24);
        p(0, y, CELL, 1, pal.deep); p(0, y + 1, CELL, 1, pal.fine);
        p(-cx, y + 1, 1, 5, pal.recess);
        p(1 - cx, y + 2, 1, 3, pal.soft);
      }
    } else if (material === 'ribbed') {
      for (let x = 1; x < CELL; x += 4) {
        p(x, 6, 2, Math.max(1, belt - 7), pal.recess);
        p(x, 6, 1, Math.max(1, belt - 7), pal.fine);
        p(x + 2, 6, 1, Math.max(1, belt - 7), pal.soft);
      }
    } else if (material === 'pipework') {
      for (const y of [Math.round(h * 0.26), Math.round(h * 0.46)]) {
        p(0, y + 2, CELL, 2, pal.deep); p(0, y, CELL, 3, pal.base);
        p(0, y, CELL, 1, pal.metal);
        p(0, y + 2, CELL, 1, pal.shade);
        p(7 - lx, y - 1, 2, 5, pal.recess); p(7 - lx, y - 1, 1, 4, pal.fine);
      }
    } else {
      const pitch = material === 'panelled' ? 48 : 24;
      p(3 - lx, 7, pitch - 6, Math.max(1, belt - 9), pal.recess);
      p(4 - lx, 8, pitch - 8, Math.max(1, belt - 11), pal.base);
      p(4 - lx, 8, pitch - 8, 1, pal.fine);
      p(5 - lx, 9, pitch - 10, 2, pal.raised);
      p(4 - lx, 9, 1, Math.max(1, belt - 13), pal.soft);
      p(pitch - 5 - lx, 9, 1, Math.max(1, belt - 12), pal.shade);
      p(5 - lx, belt - 4, pitch - 10, 1, pal.shade);
      p(4 - lx, belt - 3, pitch - 8, 1, pal.deep);
      if (material === 'service') {
        for (let y = belt + 4; y < foot - 1; y += 3) p(4 - lx, y, 15, 1, pal.deep);
        p(16 - lx, 10, 3, 6, pal.deep); p(16 - lx, 10, 1, 5, pal.warm);
      } else if (material === 'bulkhead') {
        p(7 - lx, belt + 4, 10, Math.max(1, foot - belt - 6), pal.deep);
        p(8 - lx, belt + 5, 8, Math.max(1, foot - belt - 8), pal.recess);
        p(8 - lx, belt + 4, 8, 1, pal.shade);
      } else if (material === 'plating') {
        p(5 - lx, 10, 3, 1, pal.fine); p(17 - lx, belt - 5, 2, 2, pal.recess);
      }
    }
    // Uprights support the crown. Kept continuous through the dado and toe so
    // neighboring panels look attached to one structure at near and far zoom.
    if (material !== 'courses' && material !== 'ribbed') {
      p(-lx, 3, 3, h - 4, pal.deep); p(1 - lx, 4, 2, h - 6, pal.base);
      p(1 - lx, 4, 1, h - 6, pal.edge);
      p(1 - lx, 7, 1, 1, pal.metal); p(1 - lx, h - 5, 1, 1, pal.metal);
      // Flat gussets tie the existing upright into the dado. Their silhouette
      // stays inside the face and repeats with the renderer's four-tile strip.
      p(2 - lx, belt - 2, 2, 4, pal.deep);
      p(2 - lx, belt - 2, 2, 1, pal.fine);
    }
    return true;
  }

  function zoneAt(geo, x, y) {
    if (x < 0 || y < 0 || x >= geo.COLS || y >= geo.ROWS) return null;
    const z = geo.zoneGrid[geo.idx ? geo.idx(x, y) : y * geo.COLS + x];
    return z == null ? null : z;
  }
  function edgeKind(geo, x, y, nx, ny) {
    const a = zoneAt(geo, x, y), b = zoneAt(geo, nx, ny);
    if (a == null) return 'void';
    if (a === b) return 'inside';
    if (b == null) return 'wall';
    if (geo.canStep && (geo.canStep(x, y, nx, ny) || geo.canStep(nx, ny, x, y))) return 'open';
    return 'wall';
  }
  function materialOf(geo, z) {
    const value = geo.matOf && geo.matOf(z);
    if (materialSet.has(value)) return value;
    const kinds = { hab: 'spine', corridor: 'spine', bridge: 'panel', lab: 'tile', factory: 'tread', storage: 'tread', quarters: 'soft' };
    return kinds[geo.kindOf && geo.kindOf(z)] || 'plate';
  }
  function planFixtures(geo, opts = {}) {
    if (!geo || !geo.zoneGrid) return [];
    const T = geo.TILE || CELL, ox = geo.origin && geo.origin.tx || 0, oy = geo.origin && geo.origin.ty || 0;
    const limit = clamp(Number.isFinite(opts.maxFixtures) ? Math.floor(opts.maxFixtures) : 96, 0, 128);
    if (!limit) return [];
    const up = clamp(Number.isFinite(opts.wallUp) ? Math.round(opts.wallUp) : 30, 0, 64);
    const corUp = clamp(Number.isFinite(opts.corUp) ? Math.round(opts.corUp) : up, 0, 64);
    const chamfers = new Set((geo.chamfers || []).map(c => c[0] + ',' + c[1]));
    const output = [];
    const solidNorth = (x, y, z) => {
      if (z == null || zoneAt(geo, x, y - 1) != null || chamfers.has(x + ',' + y)) return false;
      const mat = geo.wallMatOf ? geo.wallMatOf(z) : 'bulkhead';
      // Windows and natural/timber walls retain their specialized art. A sealed
      // room seam also stays untouched: its short interior face has no tall crown.
      return wallSet.has(mat);
    };
    const floorAnchor = (x, y, z) => {
      // The north wall's visible face ends inside its first tile. Put the light
      // sample on clear deck below that face, moving past furniture if necessary.
      for (let dy = 1; dy <= 3; dy++) {
        const ny = y + dy;
        if (zoneAt(geo, x, ny) !== z) break;
        if (geo.canStep && !geo.canStep(x, ny - 1, x, ny)) break;
        if (!geo.walkable || geo.walkable(x, ny)) return { tx: x, ty: ny };
      }
      return null;
    };
    for (let y = 0; y < geo.ROWS && output.length < limit; y++) {
      for (let x = 0; x < geo.COLS && output.length < limit; x++) {
        const z = zoneAt(geo, x, y);
        if (!solidNorth(x, y, z)) continue;
        const start = x;
        while (x + 1 < geo.COLS && zoneAt(geo, x + 1, y) === z && solidNorth(x + 1, y, z)) x++;
        const end = x, length = end - start + 1, corridor = !!(geo.isCorridor && geo.isCorridor(z));
        const rise = corridor ? corUp : up;
        if (length < (corridor ? 8 : 3) || rise < 12) continue;
        const candidates = [], inset = length > 4 ? 1 : 0;
        for (let tx = start + inset; tx <= end - inset; tx++) {
          const anchor = floorAnchor(tx, y, z);
          if (anchor) candidates.push({ tx, anchor });
        }
        if (!candidates.length) continue;
        // Pitch is fixed in the signed physical tile frame. A bounds expansion
        // therefore does not slide the existing lamps or their illumination.
        let selected = candidates.filter(c => mod(c.tx + ox, 6) === 3);
        if (corridor) selected = [];  // one practical fixture, only on a long hall
        if (!selected.length) selected = [candidates[Math.floor(candidates.length / 2)]];
        for (const c of selected) {
          if (output.length >= limit) break;
          const fixtureX = c.tx * T + Math.floor(T / 2), fixtureY = y * T - rise + 6;
          if (fixtureX < 5 || fixtureY < 2 || fixtureX + 5 > geo.W || fixtureY + 6 > geo.H) continue;
          // Tall faces can project into a narrow gap between stacked rooms.
          // Never paint a late fixture over another room's existing deck, nor
          // emit light for housing clipped completely beyond the cached plate.
          let occluded = false;
          for (let row = Math.floor((fixtureY - 2) / T); row <= Math.floor((fixtureY + 5) / T); row++) {
            if (zoneAt(geo, c.tx, row) != null) { occluded = true; break; }
          }
          if (occluded) continue;
          const kind = geo.kindOf && geo.kindOf(z);
          const rgb = kind === 'lab' ? '215,232,246' : '255,222,179';
          output.push({
            id: 'wall:' + (c.tx + ox) + ',' + (y + oy), kind: 'wall-fixture', zone: z,
            x: c.anchor.tx * T + T / 2, y: c.anchor.ty * T + T / 2,
            r: T * (corridor ? 4.5 : 6.5), rgb, gain: corridor ? 0.64 : 0.82,
            fixtureX, fixtureY, tileX: c.tx, tileY: y,
            emitX: fixtureX, emitY: fixtureY + 2.5, normalX: 0, normalY: 1,
            base: geo.wallBaseOf ? geo.wallBaseOf(z) : '#3a3b41'
          });
        }
      }
    }
    return output;
  }
  function paintFixtures(ctx, geo, opts = {}) {
    const fixtures = planFixtures(geo, opts), v = opts.viewport;
    if (!ctx) return fixtures;
    for (const f of fixtures) {
      const x = f.fixtureX, y = f.fixtureY;
      // Culling affects paint only. Every chunk receives the same source list,
      // including lamps beyond its edge whose light can still fall inside it.
      if (v && (x + 5 <= v.x || x - 5 >= v.x + v.w || y + 6 <= v.y || y - 2 >= v.y + v.h)) continue;
      const p = palette(f.base, detailOf(opts));
      const mark = (dx, dy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x + dx, y + dy, w, h); };
      mark(-2, -2, 4, 2, p.deep);                         // bolted saddle under crown
      mark(-1, -2, 2, 1, p.shade);
      mark(-4, 1, 9, 5, p.deep);                         // housing casts a hard shadow
      mark(-5, 1, 1, 3, p.recess); mark(4, 1, 1, 3, p.recess);
      mark(-4, 0, 8, 4, p.base); mark(-4, 0, 8, 1, p.metal);
      mark(-2, 0, 4, 1, p.edge);                        // angled top instead of a flat bright box
      mark(-3, 1, 6, 2, p.deep);
      const lens = f.rgb === '215,232,246' ? '#d7e8f6' : '#ffdeb3';
      mark(-3, 2, 6, 1, lens);                            // the actual visible emitter
      mark(-3, 3, 6, 1, p.warm);                        // down-facing reflector lip
      mark(-4, 1, 1, 1, p.edge); mark(3, 1, 1, 1, p.edge);
      mark(-4, 3, 1, 2, p.shade); mark(3, 3, 1, 2, p.shade);
      mark(-2, 4, 4, 1, p.recess);                      // recessed underside leaves the lens readable
    }
    return fixtures;
  }
  function paintTrim(ctx, geo, x, y, base, detail) {
    const T = geo.TILE || CELL, p = brush(ctx, x * T, y * T, T), pal = palette(base, detail);
    const n = edgeKind(geo, x, y, x, y - 1) === 'wall', s = edgeKind(geo, x, y, x, y + 1) === 'wall';
    const w = edgeKind(geo, x, y, x - 1, y) === 'wall', e = edgeKind(geo, x, y, x + 1, y) === 'wall';
    if (n) { p(0, 0, CELL, 2, pal.deep); p(0, 2, CELL, 1, pal.shade); }
    if (w) { p(0, 0, 2, CELL, pal.recess); p(2, 0, 1, CELL, pal.fine); }
    if (e) { p(10, 0, 2, CELL, pal.recess); p(9, 0, 1, CELL, pal.soft); }
    // The camera looks from the south: no invented visible inner south face.
    if (s) p(0, 11, CELL, 1, pal.soft);
  }
  function paint(ctx, geo, opts = {}) {
    if (!ctx || !geo || !geo.zoneGrid) return { tiles: 0, materials: [] };
    const T = geo.TILE || CELL, v = opts.viewport || { x: 0, y: 0, w: geo.W, h: geo.H };
    const x0 = clamp(Math.floor(v.x / T), 0, geo.COLS), y0 = clamp(Math.floor(v.y / T), 0, geo.ROWS);
    const x1 = clamp(Math.ceil((v.x + v.w) / T), 0, geo.COLS), y1 = clamp(Math.ceil((v.y + v.h) / T), 0, geo.ROWS);
    const ox = geo.origin && geo.origin.tx || 0, oy = geo.origin && geo.origin.ty || 0;
    const d = detailOf(opts), mats = new Set(); let tiles = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const z = zoneAt(geo, x, y); if (z == null) continue;
      const mat = materialOf(geo, z), base = geo.baseColorOf ? geo.baseColorOf(z, x, y) : '#3a3b41';
      paintFloorTile(ctx, mat, base, x * T, y * T, T, x + ox, y + oy, opts);
      if (opts.trim !== false) paintTrim(ctx, geo, x, y, base, d);
      mats.add(mat); tiles++;
    }
    return { tiles, materials: Array.from(mats) };
  }
  function makeCanvas(w, h, factory) {
    let cv;
    if (factory) cv = factory(w, h);
    else if (typeof OffscreenCanvas !== 'undefined') cv = new OffscreenCanvas(w, h);
    else if (typeof document !== 'undefined') cv = document.createElement('canvas');
    else throw new Error('WorldSurface.bake requires a canvasFactory outside a browser');
    cv.width = w; cv.height = h; return cv;
  }
  function bake(geo, opts = {}) {
    const v = opts.viewport || { x: 0, y: 0, w: geo.W, h: geo.H };
    const baseCv = makeCanvas(Math.max(1, Math.ceil(v.w)), Math.max(1, Math.ceil(v.h)), opts.canvasFactory);
    const ctx = baseCv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.save(); ctx.translate(-v.x, -v.y);
    const stats = paint(ctx, geo, { ...opts, viewport: v });
    ctx.restore();
    return { baseCv, W: geo.W, H: geo.H, origin: geo.origin, viewport: v, stats };
  }
  const invalidate = () => palettes.clear();
  return Object.freeze({ VERSION, MATERIALS, WALLS, palette, hash, materialOf, zoneAt, edgeKind,
    paintFloorTile, paintWallTile, planFixtures, paintFixtures, paintTrim, paint, bake, invalidate });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WorldSurface;
