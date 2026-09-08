/* StarNet NEXT: independent orbital sanctuary architecture and illumination.
 * Raw station documents, 32px tiles, world-pixel camera centers. No legacy art or renderer.
 */
'use strict';
const NextScene = (() => {
  const TILE = 32, WALL = 48, CHUNK = 512, TAU = Math.PI * 2;
  const num = (v, d = 0) => Number.isFinite(+v) ? +v : d;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const key = (x, y) => x + ',' + y;
  const hash = (x, y, seed = 0) => { let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed; n = Math.imul(n ^ n >>> 13, 1274126177); return (n ^ n >>> 16) >>> 0; };
  const rgba = (c, a) => 'rgba(' + c.join(',') + ',' + a + ')';
  const tint = (c, n) => 'rgb(' + c.map(v => Math.round(clamp(v + n, 0, 255))).join(',') + ')';
  const DIR = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
  const documentOf = s => s && typeof s.doc === 'function' ? s.doc() : s || {};
  const tileAt = (x, y) => ({ x: Math.floor(x / TILE), y: Math.floor(y / TILE) });
  const PALETTE = {
    ceramic: { floor: [91, 107, 107], seam: '#35454a', accent: '#baa185', wall: '#a7b5aa' },
    sanctuary: { floor: [99, 111, 100], seam: '#374b43', accent: '#c0a884', wall: '#bac0a9', botanical: true },
    copper: { floor: [108, 99, 84], seam: '#49463e', accent: '#c59b73', wall: '#b9b5a2' },
    graphite: { floor: [75, 91, 97], seam: '#293e47', accent: '#94b1ad', wall: '#a3b5b1' },
    enamel: { floor: [119, 132, 120], seam: '#52605a', accent: '#c5b58e', wall: '#c3c9b4' }
  };
  // Persisted finish IDs are a document contract. These are freshly authored
  // sanctuary pigments; no old texture, palette code or material painter is loaded.
  const STYLE_COLORS = Object.freeze({
    hull: [94, 108, 110], corridor: [74, 87, 92], cobalt: [75, 104, 143], rust: [136, 102, 80],
    sterile: [125, 137, 130], crimson: [145, 89, 91], verdant: [95, 128, 107], ember: [155, 99, 66],
    amber: [151, 132, 77], moss: [119, 127, 85], teal: [72, 131, 137], indigo: [96, 101, 153],
    violet: [126, 103, 153], orchid: [149, 103, 133], walnut: [123, 96, 73], oak: [149, 122, 87],
    ash: [122, 123, 109], fern: [83, 126, 83], meadow: [124, 141, 88], bone: [181, 177, 151],
    white: [193, 196, 185], onyx: [44, 53, 61]
  });
  const MATERIALS = Object.freeze({ spine: [4, 3], alloy: [4, 3], plate: [2, 2], panel: [4, 1], tile: [1, 1], tread: [2, 2],
    soft: [3, 2], grate: [1, 1], hex: [1, 1], plank: [5, 1], turf: [0, 0], diamond: [1, 1], resin: [0, 0],
    ceramic: [3, 3], cargo: [3, 2], runner: [2, 2], treadway: [3, 2], meshway: [3, 3] });
  const KIND_MATERIAL = { hab: 'spine', bridge: 'panel', lab: 'tile', factory: 'tread', quarters: 'soft', storage: 'tread', corridor: 'spine' };
  function material(room, tx, ty) {
    const name = String(room && (room.name || room.title) || '').toLowerCase(), kind = room && room.kind;
    let base = PALETTE.ceramic;
    if (/garden|botan|sanctuary|greenhouse|habitat/.test(name) || kind === 'quarters' || kind === 'hab') base = PALETTE.sanctuary;
    else if (kind === 'factory' || kind === 'storage') base = PALETTE.copper;
    else if (kind === 'lab') base = PALETTE.enamel;
    else if (kind === 'bridge' || kind === 'corridor') base = PALETTE.graphite;
    const override = Number.isFinite(tx) && Number.isFinite(ty) && room && room.floorPaint && room.floorPaint[key(tx, ty)];
    const style = STYLE_COLORS[override] ? override : room && STYLE_COLORS[room.floorStyle] ? room.floorStyle : null;
    const recipe = room && MATERIALS[room.floorMat] ? room.floorMat : KIND_MATERIAL[kind] || 'plate';
    const floor = style ? STYLE_COLORS[style] : base.floor;
    return Object.assign({}, base, { floor, style, recipe, seam: style ? tint(floor, -43) : base.seam });
  }
  function project(station) {
    const doc = documentOf(station), tiles = new Map(), rooms = new Map(), rectangles = [], source = doc.rooms || {};
    for (const id of Array.isArray(doc.order) ? doc.order : Object.keys(source)) {
      const room = source[id]; if (!room) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of Array.isArray(room.rects) ? room.rects : []) {
        const ax = Math.floor(num(r.x1, num(r.x))), ay = Math.floor(num(r.y1, num(r.y)));
        const bx = Math.floor(num(r.x2, ax + num(r.w, 1) - 1)), by = Math.floor(num(r.y2, ay + num(r.h, 1) - 1));
        if (bx < ax || by < ay) continue;
        if ((bx - ax + 1) * (by - ay + 1) > 250000) throw new Error('Room exceeds scene tile budget');
        rectangles.push({ x: ax * TILE, y: ay * TILE, w: (bx - ax + 1) * TILE, h: (by - ay + 1) * TILE });
        for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
          if (tiles.size >= 250000 && !tiles.has(key(x, y))) throw new Error('Station exceeds scene tile budget');
          tiles.set(key(x, y), { x, y, room: id });
        }
        x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, bx); y1 = Math.max(y1, by);
      }
      if (x0 !== Infinity) rooms.set(id, { id, room, x0, y0, x1, y1, palette: material(room) });
    }
    const sealed = new Set();
    for (const p of doc.props || []) if (p.t === 'airlock' && (p.door === 'closed' || p.door === 'jammed')) {
      const t = tiles.get(key(Math.floor(num(p.x)), Math.floor(num(p.y))));
      if (t && t.room !== (doc.meta && doc.meta.trunkRoomId)) sealed.add(t.room);
    }
    const model = { doc, tiles, rooms, rectangles, sealed, edges: [], fixtures: [], chunkTiles: new Map() }, seen = new Set();
    for (const t of tiles.values()) {
      const cid = key(Math.floor(t.x * TILE / CHUNK), Math.floor(t.y * TILE / CHUNK));
      if (!model.chunkTiles.has(cid)) model.chunkTiles.set(cid, []); model.chunkTiles.get(cid).push(t);
      for (const [side, d] of Object.entries(DIR)) {
        const adjacent = tiles.get(key(t.x + d[0], t.y + d[1]));
        if (adjacent && (adjacent.room === t.room || (!sealed.has(t.room) && !sealed.has(adjacent.room)))) continue;
        const vertical = side === 'e' || side === 'w';
        const line = vertical ? t.x + (side === 'e' ? 1 : 0) : t.y + (side === 's' ? 1 : 0), along = vertical ? t.y : t.x;
        const eid = (vertical ? 'v' : 'h') + line + ':' + along; if (seen.has(eid)) continue; seen.add(eid);
        const e = { x: t.x, y: t.y, side, room: t.room, exterior: !adjacent, vertical, line, along }; model.edges.push(e);
        if (side === 'n' && !adjacent && ((t.x % 4 + 4) % 4 === 1)) model.fixtures.push({ x: (t.x + .5) * TILE, y: t.y * TILE + 3,
          r: TILE * 5, color: [146, 210, 222], strength: .30, kind: 'window', edge: e });
      }
    }
    // Architectural light discs have visible housings. Their constant light says
    // nothing about task activity; live emissions are supplied separately by the client.
    for (const room of rooms.values()) {
      const narrow = room.room.kind === 'corridor', step = narrow ? 4 : 5;
      for (let y = room.y0 + Math.min(2, Math.floor((room.y1 - room.y0) / 2)); y <= room.y1; y += step)
        for (let x = room.x0 + Math.min(2, Math.floor((room.x1 - room.x0) / 2)); x <= room.x1; x += step) {
          const t = tiles.get(key(x, y)); if (!t || t.room !== room.id) continue;
          model.fixtures.push({ x: (x + .5) * TILE, y: (y + .5) * TILE, r: TILE * (narrow ? 4.2 : 5.4),
            color: room.palette.botanical ? [242, 221, 166] : [255, 216, 165], strength: narrow ? .67 : .79, kind: 'floor', room: room.id });
        }
    }
    return model;
  }
  function bounds(station) {
    const m = station && station.tiles instanceof Map ? station : project(station);
    if (!m.tiles.size) return { x: -160, y: -120, width: 320, height: 240, cx: 0, cy: 0, minTx: 0, minTy: 0, maxTx: -1, maxTy: -1 };
    let minTx = Infinity, minTy = Infinity, maxTx = -Infinity, maxTy = -Infinity;
    for (const t of m.tiles.values()) { minTx = Math.min(minTx, t.x); minTy = Math.min(minTy, t.y); maxTx = Math.max(maxTx, t.x); maxTy = Math.max(maxTy, t.y); }
    const x = minTx * TILE - 24, y = minTy * TILE - WALL - 24;
    const width = (maxTx - minTx + 1) * TILE + 48, height = (maxTy - minTy + 1) * TILE + WALL + 64;
    return { x, y, width, height, cx: x + width / 2, cy: y + height / 2, minTx, minTy, maxTx, maxTy };
  }
  function canCross(m, ax, ay, bx, by) {
    const a = m.tiles.get(key(ax, ay)), b = m.tiles.get(key(bx, by));
    return !!a && !!b && (a.room === b.room || (!m.sealed.has(a.room) && !m.sealed.has(b.room)));
  }
  function rayLength(m, x, y, angle, reach) {
    let tx = Math.floor(x / TILE), ty = Math.floor(y / TILE); if (!m.tiles.has(key(tx, ty))) return 0;
    const dx = Math.cos(angle), dy = Math.sin(angle), sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
    const stepx = Math.abs(dx) < 1e-9 ? Infinity : TILE / Math.abs(dx), stepy = Math.abs(dy) < 1e-9 ? Infinity : TILE / Math.abs(dy);
    let nx = Math.abs(dx) < 1e-9 ? Infinity : ((tx + (sx > 0 ? 1 : 0)) * TILE - x) / dx;
    let ny = Math.abs(dy) < 1e-9 ? Infinity : ((ty + (sy > 0 ? 1 : 0)) * TILE - y) / dy;
    for (let guard = 0; guard < 4096; guard++) {
      const distance = Math.min(nx, ny); if (distance >= reach) return reach;
      if (Math.abs(nx - ny) < 1e-7) {
        if (!canCross(m, tx, ty, tx + sx, ty) || !canCross(m, tx, ty, tx, ty + sy) ||
          !canCross(m, tx + sx, ty, tx + sx, ty + sy) || !canCross(m, tx, ty + sy, tx + sx, ty + sy)) return Math.max(0, distance - .03);
        tx += sx; ty += sy; nx += stepx; ny += stepy;
      } else if (nx < ny) { if (!canCross(m, tx, ty, tx + sx, ty)) return Math.max(0, nx - .03); tx += sx; nx += stepx; }
      else { if (!canCross(m, tx, ty, tx, ty + sy)) return Math.max(0, ny - .03); ty += sy; ny += stepy; }
    }
    return 0;
  }
  function visible(m, s, x, y) {
    if (Math.hypot(x - s.x, y - s.y) > s.r) return false;
    const ox = num(s.originX, s.x), oy = num(s.originY, s.y), d = Math.hypot(x - ox, y - oy);
    return rayLength(m, ox, oy, Math.atan2(y - oy, x - ox), d + .01) >= d;
  }
  function visibility(m, s, detail = 72) {
    const ox = num(s.originX, s.x), oy = num(s.originY, s.y), reach = s.r + Math.hypot(ox - s.x, oy - s.y), angles = new Set();
    for (let i = 0; i < detail; i++) angles.add(i * TAU / detail);
    for (const e of m.edges) {
      const p = e.vertical ? [e.line * TILE, e.along * TILE, e.line * TILE, (e.along + 1) * TILE]
        : [e.along * TILE, e.line * TILE, (e.along + 1) * TILE, e.line * TILE];
      for (let i = 0; i < 4; i += 2) if (Math.hypot(p[i] - ox, p[i + 1] - oy) <= reach + TILE) {
        const a = Math.atan2(p[i + 1] - oy, p[i] - ox); angles.add((a + TAU - .0001) % TAU); angles.add((a + TAU + .0001) % TAU);
      }
    }
    return [...angles].sort((a, b) => a - b).map(a => { const d = rayLength(m, ox, oy, a, reach); return { x: ox + Math.cos(a) * d, y: oy + Math.sin(a) * d }; });
  }

  function create(canvas, options = {}) {
    const ctx = canvas.getContext('2d'), chunks = new Map(), polygons = new Map();
    let model, priorStation, priorRevision, disposed = false, frames = 0, geometryBuilds = 0, chunkBuilds = 0, lightBuilds = 0, frameMs = 0, latestLights = [], latestCamera;
    const makeCanvas = (w, h) => { if (options.canvasFactory) return options.canvasFactory(w, h); const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const release = c => { c.width = c.height = 1; };
    function reset(station, revision) {
      for (const c of chunks.values()) for (const v of [c.floor, c.shade, c.glow]) release(v);
      chunks.clear(); polygons.clear(); model = project(station); priorStation = station; priorRevision = revision; geometryBuilds++;
    }
    function floorTile(g, t) {
      const p = material(model.rooms.get(t.room).room, t.x, t.y), x = t.x * TILE, y = t.y * TILE;
      const pitch = MATERIALS[p.recipe], mx = pitch[0] ? ((t.x % pitch[0]) + pitch[0]) % pitch[0] : -1, my = pitch[1] ? ((t.y % pitch[1]) + pitch[1]) % pitch[1] : -1;
      const h = hash(Math.floor(t.x / (pitch[0] || 4)), Math.floor(t.y / (pitch[1] || 4)), 193);
      g.fillStyle = tint(p.floor, h % 7 - 3); g.fillRect(x, y, TILE, TILE);
      if (my === 0) { g.fillStyle = p.seam; g.fillRect(x, y, TILE, 2); g.fillStyle = tint(p.floor, 13); g.fillRect(x + 1, y + 2, TILE - 1, 1); }
      if (mx === 0) { g.fillStyle = p.seam; g.fillRect(x, y, 2, TILE); g.fillStyle = tint(p.floor, 8); g.fillRect(x + 2, y + 2, 1, TILE - 2); }
      if (p.recipe === 'plate' && mx === 0 && my === 0) {
        g.fillStyle = tint(p.floor, -16); g.fillRect(x + 6, y + 7, 10, 2); g.fillStyle = p.accent; g.fillRect(x + 6, y + 6, 8, 1);
        g.fillStyle = '#425153'; g.fillRect(x + 6, y + 12, 2, 2); g.fillStyle = '#b6bca2'; g.fillRect(x + 6, y + 12, 1, 1);
      }
      const line = (x1, y1, x2, y2, color, width = 1) => { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
      if (p.recipe === 'spine') {
        if (mx === 0) { g.fillStyle = tint(p.floor, -31); g.fillRect(x + 5, y, 5, TILE); g.fillStyle = p.accent; g.fillRect(x + 6, y + 7, 1, 15); }
        if (my === 0 && mx === 2) { g.fillStyle = tint(p.floor, -23); g.fillRect(x + 8, y + 5, 16, 2); }
      } else if (p.recipe === 'alloy') {
        if (my === 0) { g.fillStyle = tint(p.floor, 17); g.fillRect(x + 3, y + 4, TILE - 3, 2); }
        g.fillStyle = tint(p.floor, 5); g.fillRect(x + 6 + h % 5, y + 16, 14, 1);
        if (mx === 0 && my === 0) { g.fillStyle = tint(p.floor, -30); g.fillRect(x + 6, y + 8, 3, 3); }
      } else if (p.recipe === 'panel') {
        g.fillStyle = tint(p.floor, -18); g.fillRect(x, y + 27, TILE, 3); g.fillStyle = tint(p.floor, 9); g.fillRect(x, y + 26, TILE, 1);
        if (mx === 0) { g.fillStyle = p.accent; g.fillRect(x + 5, y + 6, 7, 2); }
      } else if (p.recipe === 'tile' || p.recipe === 'ceramic') {
        g.fillStyle = tint(p.floor, p.recipe === 'tile' ? 8 : 4); g.fillRect(x + 5, y + 5, 9, 1);
        if (p.recipe === 'ceramic' && mx === 1 && my === 1) { g.fillStyle = tint(p.floor, -8); g.fillRect(x + 14, y + 14, 4, 4); g.fillStyle = tint(p.floor, 10); g.fillRect(x + 15, y + 15, 2, 2); }
      } else if (p.recipe === 'tread' || p.recipe === 'treadway') {
        for (const [dx, dy] of [[8, 10], [21, 23]]) { line(x + dx - 4, y + dy + 2, x + dx + 4, y + dy - 2, tint(p.floor, -24), 3); line(x + dx - 4, y + dy + 1, x + dx + 4, y + dy - 3, tint(p.floor, 13)); }
        if (p.recipe === 'treadway' && mx === 0) { g.fillStyle = p.accent; g.fillRect(x + 5, y, 2, TILE); }
      } else if (p.recipe === 'soft') {
        for (let i = 0; i < 5; i++) { const n = hash(t.x, t.y, i * 31); g.fillStyle = tint(p.floor, i & 1 ? 6 : -6); g.fillRect(x + 5 + n % 23, y + 5 + (n >>> 5) % 23, 2, 1); }
        if (mx === 0 && my === 0) { g.fillStyle = tint(p.floor, -17); g.fillRect(x + 4, y + 4, 2, 2); }
      } else if (p.recipe === 'grate' || p.recipe === 'meshway') {
        g.fillStyle = tint(p.floor, -33); g.fillRect(x + 4, y + 4, 24, 24);
        if (p.recipe === 'grate') for (let i = 0; i < 4; i++) { g.fillStyle = tint(p.floor, 5); g.fillRect(x + 5 + i * 6, y + 5, 3, 22); g.fillStyle = tint(p.floor, 20); g.fillRect(x + 5 + i * 6, y + 5, 1, 22); }
        else for (let i = 0; i < 4; i++) { g.fillStyle = tint(p.floor, 3); g.fillRect(x + 5, y + 6 + i * 6, 22, 2); g.fillStyle = tint(p.floor, -4); g.fillRect(x + 6 + i * 6, y + 5, 2, 22); }
      } else if (p.recipe === 'hex' || p.recipe === 'diamond') {
        const points = p.recipe === 'hex' ? [[16, 3], [29, 10], [29, 23], [16, 30], [3, 23], [3, 10]] : [[16, 4], [28, 16], [16, 28], [4, 16]];
        g.fillStyle = tint(p.floor, p.recipe === 'hex' ? 6 : -13); g.beginPath(); points.forEach(([dx, dy], i) => i ? g.lineTo(x + dx, y + dy) : g.moveTo(x + dx, y + dy)); g.closePath(); g.fill();
        line(x + points[0][0], y + points[0][1], x + points[1][0], y + points[1][1], tint(p.floor, 17));
      } else if (p.recipe === 'plank') {
        for (let i = 0; i < 2; i++) { const n = hash(t.x, t.y, 53 + i); g.fillStyle = tint(p.floor, i ? 7 : -9); g.fillRect(x + 4 + n % 8, y + 9 + i * 12, 12 + (n >>> 6) % 9, 1); }
        if (mx === 0) { g.fillStyle = tint(p.floor, -26); g.fillRect(x + 5, y + 7, 1, 2); g.fillRect(x + 5, y + 24, 1, 2); }
      } else if (p.recipe === 'turf') {
        for (let i = 0; i < 7; i++) { const n = hash(t.x, t.y, i * 17), px = x + 3 + n % 24, py = y + 5 + (n >>> 6) % 22; g.fillStyle = tint(p.floor, i & 1 ? -11 : 12); g.fillRect(px, py - 3, 2, 5); g.fillRect(px - 2, py - 1, 5, 2); }
      } else if (p.recipe === 'resin') {
        g.fillStyle = tint(p.floor, 5); g.fillRect(x + 3, y + 9, 23, 1); g.fillStyle = tint(p.floor, 2); g.fillRect(x + 8, y + 10, 20, 1);
      } else if (p.recipe === 'cargo') {
        if (mx === 0) { g.fillStyle = tint(p.floor, -29); g.fillRect(x + 4, y, 6, TILE); g.fillStyle = p.accent; g.fillRect(x + 5, y + 5, 4, 2); g.fillRect(x + 5, y + 24, 4, 2); }
        else if (my === 0) { g.fillStyle = tint(p.floor, -30); g.fillRect(x + 13, y + 11, 8, 8); g.fillStyle = tint(p.floor, 6); g.fillRect(x + 15, y + 13, 4, 4); }
      } else if (p.recipe === 'runner') {
        const offset = mx === 0 ? 5 : 25; g.fillStyle = tint(p.floor, -20); g.fillRect(x + offset, y, 2, TILE); g.fillStyle = p.accent; g.fillRect(x + offset + 2, y, 1, TILE);
      }
      for (const [side, d] of Object.entries(DIR)) if (!model.tiles.has(key(t.x + d[0], t.y + d[1]))) {
        g.fillStyle = 'rgba(10,25,29,.24)';
        if (side === 'n') g.fillRect(x, y, TILE, 8); if (side === 's') g.fillRect(x, y + TILE - 4, TILE, 4);
        if (side === 'w') g.fillRect(x, y, 5, TILE); if (side === 'e') g.fillRect(x + TILE - 5, y, 5, TILE);
      }
    }
    function clipFloor(g) { g.beginPath(); for (const r of model.rectangles) g.rect(r.x, r.y, r.w, r.h); g.clip(); }
    function belt(g, x, y, direction, now, active) {
      const d = DIR[direction] || DIR.e; g.save(); g.translate((x + .5) * TILE, (y + .5) * TILE); g.rotate(Math.atan2(d[1], d[0]));
      g.fillStyle = '#15282d'; g.fillRect(-16, -11, 32, 22); g.fillStyle = '#8a8571'; g.fillRect(-16, -11, 32, 2); g.fillRect(-16, 9, 32, 2);
      g.fillStyle = '#c4b28c'; g.fillRect(-16, -11, 32, 1); g.fillStyle = '#30494c'; g.fillRect(-16, -8, 32, 16);
      const offset = active ? Math.floor(now * .025) % 8 : 0;
      for (let i = -20 + offset; i < 16; i += 8) { const a = Math.max(-16, i); g.fillStyle = '#4d6360'; g.fillRect(a, -7, Math.min(3, 16 - a), 14); g.fillStyle = '#1d373b'; g.fillRect(a, -7, 1, 14); }
      g.fillStyle = '#bbae81'; g.beginPath(); g.moveTo(-3, -3); g.lineTo(2, 0); g.lineTo(-3, 3); g.lineTo(-1, 0); g.closePath(); g.fill(); g.restore();
    }
    function getChunk(id) {
      let c = chunks.get(id);
      if (c && [c.floor, c.shade, c.glow].some(v => { const g = v.getContext('2d'); return g.isContextLost && g.isContextLost(); })) { for (const v of [c.floor, c.shade, c.glow]) release(v); chunks.delete(id); c = null; }
      if (c) { chunks.delete(id); chunks.set(id, c); return c; }
      const [cx, cy] = id.split(',').map(Number), x = cx * CHUNK, y = cy * CHUNK;
      c = { x, y, floor: makeCanvas(CHUNK, CHUNK), shade: makeCanvas(CHUNK, CHUNK), glow: makeCanvas(CHUNK, CHUNK), lightKey: '' };
      const g = c.floor.getContext('2d'); g.setTransform(1, 0, 0, 1, -x, -y); g.imageSmoothingEnabled = false;
      for (const t of model.chunkTiles.get(id) || []) floorTile(g, t);
      for (const s of model.fixtures) if (s.kind === 'floor' && s.x >= x && s.x < x + CHUNK && s.y >= y && s.y < y + CHUNK) {
        g.fillStyle = '#283d3d'; g.fillRect(s.x - 6, s.y - 3, 12, 6); g.fillStyle = '#bda883'; g.fillRect(s.x - 5, s.y - 3, 10, 1);
        g.fillStyle = '#efe2b6'; g.fillRect(s.x - 3, s.y - 1, 6, 2); g.fillStyle = '#54635b'; g.fillRect(s.x - 5, s.y + 2, 10, 1);
      }
      chunks.set(id, c); chunkBuilds++; return c;
    }
    function polygon(s, detail) {
      const id = [s.x, s.y, s.r, num(s.originX, s.x), num(s.originY, s.y), detail].join(','); if (polygons.has(id)) return polygons.get(id);
      const p = visibility(model, s, detail); polygons.set(id, p); if (polygons.size > 500) polygons.delete(polygons.keys().next().value); return p;
    }
    function illuminate(c, sources, quality) {
      const local = sources.filter(s => s.x + s.r > c.x && s.x - s.r < c.x + CHUNK && s.y + s.r > c.y && s.y - s.r < c.y + CHUNK);
      const signature = quality + local.map(s => [s.x, s.y, s.r, s.strength.toFixed(3), s.color.join(','), s.originX, s.originY].join(':')).join('|');
      if (c.lightKey === signature) return;
      const shade = c.shade.getContext('2d'), glow = c.glow.getContext('2d');
      for (const g of [shade, glow]) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, CHUNK, CHUNK); }
      shade.fillStyle = 'rgba(5,19,26,.44)'; shade.fillRect(0, 0, CHUNK, CHUNK); for (const g of [shade, glow]) g.setTransform(1, 0, 0, 1, -c.x, -c.y);
      for (const s of local) {
        const points = polygon(s, quality === 'low' ? 36 : 72);
        for (const [g, mode, strength] of [[shade, 'destination-out', s.strength], [glow, 'screen', s.strength * .20]]) {
          g.save(); g.beginPath(); points.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.clip();
          const gradient = g.createRadialGradient(s.x, s.y, 1, s.x, s.y, s.r);
          for (const [stop, v] of [[0, 1], [.25, .75], [.52, .38], [.78, .09], [1, 0]]) gradient.addColorStop(stop, rgba(s.color, strength * v));
          g.globalCompositeOperation = mode; g.fillStyle = gradient; g.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
          if (mode === 'screen' && s.kind === 'window') {
            // A north viewport throws a faint widening shaft down onto the deck.
            // It shares the source's visibility polygon and the exact floor mask.
            const shaft = g.createLinearGradient(s.x, s.y, s.x + 24, s.y + 116);
            shaft.addColorStop(0, rgba(s.color, .085)); shaft.addColorStop(.5, rgba(s.color, .033)); shaft.addColorStop(1, rgba(s.color, 0));
            g.fillStyle = shaft; g.beginPath(); g.moveTo(s.x - 8, s.y); g.lineTo(s.x + 8, s.y); g.lineTo(s.x + 50, s.y + 116); g.lineTo(s.x - 2, s.y + 116); g.closePath(); g.fill();
          }
          g.restore();
        }
      }
      for (const g of [shade, glow]) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(c.floor, 0, 0); g.globalCompositeOperation = 'source-over'; }
      c.lightKey = signature; lightBuilds++;
    }
    function background(g, w, h, camera, now, still) {
      const gradient = g.createLinearGradient(0, 0, w, h); gradient.addColorStop(0, '#081b26'); gradient.addColorStop(.55, '#0b1d29'); gradient.addColorStop(1, '#152d39'); g.fillStyle = gradient; g.fillRect(0, 0, w, h);
      const px = w * .84 - camera.x * .022, py = h * 1.22 - camera.y * .016, r = Math.max(w, h) * .51;
      const air = g.createRadialGradient(px, py, r * .96, px, py, r * 1.09); air.addColorStop(0, 'rgba(72,134,153,.35)'); air.addColorStop(.42, 'rgba(75,146,165,.15)'); air.addColorStop(1, 'rgba(59,126,150,0)');
      g.fillStyle = air; g.beginPath(); g.arc(px, py, r * 1.09, 0, TAU); g.fill();
      const planet = g.createRadialGradient(px - r * .44, py - r * .65, r * .05, px, py, r); planet.addColorStop(0, '#395661'); planet.addColorStop(.5, '#233d49'); planet.addColorStop(1, '#0e2837'); g.fillStyle = planet; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      for (let i = 0; i < 150; i++) {
        const n = hash(i, 73, 1937), depth = i % 3 + 1;
        const x = ((n % 9973) / 9973 * w * 1.2 - camera.x * .012 * depth + w * 4) % (w * 1.2);
        const y = (((n >>> 12) % 7919) / 7919 * h * 1.2 - camera.y * .010 * depth + h * 4) % (h * 1.2);
        if (Math.hypot(x - px, y - py) < r) continue;
        const alpha = (.20 + n % 7 * .075) * (still ? 1 : .94 + Math.sin(now * .00035 + i) * .06);
        g.fillStyle = rgba(i % 7 === 0 ? [189, 212, 206] : [111, 160, 175], alpha); const size = i % 41 === 0 ? 2 : 1; g.fillRect(Math.round(x), Math.round(y), size, size);
      }
    }
    function wall(g, e) {
      const p = model.rooms.get(e.room).palette, x = e.x * TILE, y = e.y * TILE;
      if (e.side === 'n') {
        g.fillStyle = '#182b32'; g.fillRect(x - 1, y - WALL, TILE + 2, WALL + 3); g.fillStyle = p.wall; g.fillRect(x, y - WALL, TILE, 6);
        g.fillStyle = '#d4d7be'; g.fillRect(x + 1, y - WALL, TILE - 2, 1); g.fillStyle = '#6f817a'; g.fillRect(x, y - WALL + 6, TILE, 3);
        const glazing = e.exterior && ((e.x % 4 + 4) % 4 === 1 || (e.x % 4 + 4) % 4 === 2);
        g.fillStyle = glazing ? '#46616a' : '#84958a'; g.fillRect(x + 2, y - 38, TILE - 4, 31);
        if (glazing) {
          const glass = g.createLinearGradient(x, y - 37, x + 24, y - 9); glass.addColorStop(0, '#31596a'); glass.addColorStop(1, '#0c2536'); g.fillStyle = glass; g.fillRect(x + 5, y - 36, 22, 26);
          g.fillStyle = 'rgba(168,220,222,.22)'; g.fillRect(x + 6, y - 35, 19, 1); g.fillRect(x + 6, y - 34, 1, 20); g.fillStyle = '#7ba3ab'; g.fillRect(x + 11, y - 30, 1, 1); g.fillRect(x + 20, y - 18, 1, 1);
          g.fillStyle = 'rgba(119,172,177,.16)'; g.beginPath(); g.moveTo(x + 19, y - 35); g.lineTo(x + 25, y - 35); g.lineTo(x + 10, y - 10); g.lineTo(x + 5, y - 10); g.closePath(); g.fill();
        } else {
          g.fillStyle = '#50685f'; g.fillRect(x + 6, y - 34, 20, 22); g.fillStyle = '#a8b7a5'; g.fillRect(x + 7, y - 34, 18, 1); g.fillStyle = '#768e7f'; g.fillRect(x + 9, y - 30, 14, 15);
          if (hash(e.x, e.y) % 5 === 0) { g.fillStyle = '#243d40'; g.fillRect(x + 10, y - 25, 12, 7); g.fillStyle = '#a1b7a1'; for (let i = 0; i < 4; i++) g.fillRect(x + 11 + i * 3, y - 24, 1, 5); }
        }
        g.fillStyle = '#b0ae8e'; g.fillRect(x + 2, y - 7, TILE - 4, 3); g.fillStyle = '#3b4b46'; g.fillRect(x, y - 4, TILE, 4); g.fillStyle = '#ac9875'; g.fillRect(x + 3, y - 3, TILE - 6, 1); g.fillStyle = '#1a3033'; g.fillRect(x, y, TILE, 2);
        g.fillStyle = '#c0c4a9'; g.fillRect(x, y - WALL + 9, 3, WALL - 17); g.fillStyle = '#6c8074'; g.fillRect(x + 3, y - WALL + 9, 2, WALL - 17);
      } else if (e.side === 's') {
        const sy = y + TILE; g.fillStyle = '#132a33'; g.fillRect(x - 1, sy + 4, TILE + 2, 24); g.fillStyle = '#7a9387'; g.fillRect(x, sy - 5, TILE, 12);
        g.fillStyle = p.wall; g.fillRect(x, sy - 5, TILE, 5); g.fillStyle = '#d0d1b7'; g.fillRect(x + 1, sy - 5, TILE - 2, 1); g.fillStyle = '#3d5958'; g.fillRect(x + 3, sy + 7, TILE - 6, 15);
        g.fillStyle = '#526d65'; g.fillRect(x + 4, sy + 8, TILE - 8, 4); g.fillStyle = '#a89a74'; g.fillRect(x + 3, sy + 6, TILE - 6, 1); g.fillStyle = '#142d33'; g.fillRect(x + 8, sy + 16, 16, 4); g.fillStyle = '#74938c'; g.fillRect(x + 10, sy + 17, 12, 1); g.fillStyle = '#8caa9b'; g.fillRect(x, sy + 4, 3, 18);
      } else {
        const sx = e.side === 'e' ? x + TILE : x, left = e.side === 'w'; g.fillStyle = '#193039'; g.fillRect(sx + (left ? -17 : -3), y - 8, 20, TILE + 12);
        g.fillStyle = '#5f7b71'; g.fillRect(sx + (left ? -14 : 0), y - 8, 14, TILE + 8); g.fillStyle = p.wall; g.fillRect(sx + (left ? -10 : 0), y - 8, 10, TILE + 5); g.fillStyle = '#d0d4ba'; g.fillRect(sx + (left ? -2 : 0), y - 8, 2, TILE + 5);
        g.fillStyle = '#8b997e'; g.fillRect(sx + (left ? -10 : 8), y + 5, 2, 16); g.fillStyle = '#223b3e'; g.fillRect(sx + (left ? -13 : 12), y + 8, 2, 10); g.fillStyle = '#b5a17c'; g.fillRect(sx + (left ? -9 : 5), y + 7, 3, 2);
      }
      if (p.botanical && e.side === 'n' && hash(e.x, e.y, 55) % 7 === 0) {
        g.fillStyle = '#384f44'; g.fillRect(x + 7, y - 9, 18, 9); g.fillStyle = '#9eaa89'; g.fillRect(x + 6, y - 10, 20, 3);
        for (let i = 0; i < 7; i++) { const n = hash(i, e.x, e.y), px = x + 9 + n % 13, py = y - 12 - (n >>> 6) % 16; g.fillStyle = i & 1 ? '#668c63' : '#94aa7b'; g.fillRect(px, py, 3, 9); g.fillRect(px - 2, py + 2, 6, 3); g.fillStyle = '#bdc292'; g.fillRect(px, py, 1, 5); }
      }
    }
    function grounding(g, x, y, w, h) {
      let best, force = 0;
      for (const s of latestLights) { const d = Math.hypot(x - s.x, y - s.y), energy = s.strength * Math.max(0, 1 - d / s.r); if (energy > force && visible(model, s, x, y)) { force = energy; best = s; } }
      const dx = best ? x - best.x : 12, dy = best ? y - best.y : 20, d = Math.hypot(dx, dy) || 1, length = Math.min(h * .65, 28);
      const ex = x + dx / d * length, ey = y + dy / d * length, nx = -dy / d * w / 2, ny = dx / d * w / 2;
      const gradient = g.createLinearGradient(x, y, ex + .01, ey + .01); gradient.addColorStop(0, 'rgba(6,19,24,.36)'); gradient.addColorStop(1, 'rgba(6,19,24,0)');
      g.save(); clipFloor(g);
      g.fillStyle = gradient; g.beginPath(); g.moveTo(x + nx, y + ny); g.lineTo(ex + nx * .8, ey + ny * .8); g.lineTo(ex - nx * .8, ey - ny * .8); g.lineTo(x - nx, y - ny); g.closePath(); g.fill();
      g.fillStyle = 'rgba(5,20,23,.25)'; g.beginPath(); g.ellipse(x, y + 1, w * .47, Math.min(6, w * .16), 0, 0, TAU); g.fill();
      g.restore();
    }
    const selectedId = s => typeof s === 'string' ? s : s && (s.id || s.agentId || s.propId);
    function draw(frame = {}, art = {}) {
      if (disposed) return false; const started = typeof performance !== 'undefined' ? performance.now() : 0;
      if (!model || frame.station !== priorStation || frame.revision !== priorRevision) reset(frame.station, frame.revision);
      const width = Math.max(1, num(frame.width, canvas.clientWidth || 1000)), height = Math.max(1, num(frame.height, canvas.clientHeight || 700));
      const dpr = clamp(num(frame.dpr, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1), 1, 2);
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
      const b = bounds(model), camera = Object.assign({ x: b.cx, y: b.cy, zoom: 1 }, frame.camera || {}); camera.zoom = clamp(num(camera.zoom, 1), .12, 4); latestCamera = camera;
      const now = num(frame.now), still = !!frame.reducedMotion;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; background(ctx, width, height, camera, now, still);
      ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * (width / 2 - camera.x * camera.zoom), dpr * (height / 2 - camera.y * camera.zoom)); ctx.imageSmoothingEnabled = false;
      const vx = camera.x - width / camera.zoom / 2 - 96, vy = camera.y - height / camera.zoom / 2 - 96, vw = width / camera.zoom + 192, vh = height / camera.zoom + 192;
      const inView = (x, y, w = 0, h = 0) => x + w >= vx && y + h >= vy && x <= vx + vw && y <= vy + vh;
      latestLights = model.fixtures.concat((frame.lights || []).filter(s => Number.isFinite(+s.x) && Number.isFinite(+s.y) && +s.r > 0).map(s => ({ x: +s.x, y: +s.y, r: clamp(+s.r, 1, 640),
        color: s.color || s.c || [166, 220, 229], strength: clamp(num(s.strength, num(s.a)), 0, 1), originX: num(s.originX, +s.x), originY: num(s.originY, +s.y) })));
      const visibleChunks = [];
      for (const id of model.chunkTiles.keys()) { const [cx, cy] = id.split(',').map(Number); if (!inView(cx * CHUNK, cy * CHUNK, CHUNK, CHUNK)) continue; const c = getChunk(id); illuminate(c, latestLights, frame.quality || 'high'); visibleChunks.push(c); ctx.drawImage(c.floor, c.x, c.y); }
      for (const [position, v] of Object.entries(model.doc.belts || {})) {
        const [x, y] = position.split(',').map(Number); if (!model.tiles.has(key(x, y)) || !inView(x * TILE, y * TILE, TILE, TILE)) continue;
        const active = !still && frame.flowingBelts && (frame.flowingBelts instanceof Set ? frame.flowingBelts.has(position) : frame.flowingBelts.includes(position)); belt(ctx, x, y, typeof v === 'string' ? v : v.dir, now, !!active);
      }
      const agents = Array.isArray(frame.agents) ? frame.agents : [], props = Array.isArray(frame.props) ? frame.props : model.doc.props || [], active = new Set(agents.filter(a => a.working).map(a => a.id)), items = [];
      for (const p of props) {
        const x = num(p.x) * TILE, y = num(p.y) * TILE, w = num(p.w, 1) * TILE, h = num(p.h, 1) * TILE; if (!inView(x - 16, y - 64, w + 32, h + 80)) continue;
        grounding(ctx, x + w / 2, y + h - 3, Math.max(16, w * .7), 38);
        items.push({ y: y + h, draw: () => { if (art.drawProp) art.drawProp(ctx, p, now, { working: active.has(p.agentId), selected: selectedId(frame.selection) === p.id, tileSize: TILE }); } });
      }
      for (const a of agents) { const x = num(a.x) * TILE, y = num(a.y) * TILE; if (!inView(x - 20, y - 72, 40, 80)) continue; grounding(ctx, x, y, 19, 45); items.push({ y, draw: () => { if (art.drawAgent) art.drawAgent(ctx, a, now); } }); }
      for (const e of model.edges) if (inView(e.x * TILE - 20, e.y * TILE - WALL, TILE + 40, TILE + WALL + 36)) items.push({ y: (e.side === 'n' ? e.y : e.y + 1) * TILE + (e.side === 's' ? .5 : -.5), draw: () => wall(ctx, e) });
      items.sort((a, b) => a.y - b.y); for (const i of items) i.draw();
      for (const c of visibleChunks) { ctx.drawImage(c.shade, c.x, c.y); ctx.globalCompositeOperation = 'screen'; ctx.drawImage(c.glow, c.x, c.y); ctx.globalCompositeOperation = 'source-over'; }
      if (!still && num(frame.dust, 1) > 0) {
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < Math.min(model.fixtures.length, 80); i++) { const s = model.fixtures[i]; if (!inView(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2)) continue;
          const t = now * .00003, seed = hash(i, 25) % 1000 / 1000, x = s.x + Math.sin(seed * TAU + t) * 36, y = s.y + ((seed + t * .3) % 1 - .5) * 70;
          if (visible(model, s, x, y)) { ctx.fillStyle = rgba(s.color, Math.min(1, num(frame.dust, 1)) * .25); ctx.fillRect(Math.round(x), Math.round(y), 1, 1); }
        } ctx.globalCompositeOperation = 'source-over';
      }
      const selection = selectedId(frame.selection), prop = props.find(p => p.id === selection), agent = agents.find(a => a.id === selection);
      if (prop || agent) { ctx.strokeStyle = '#e4d2a5'; ctx.lineWidth = 1.5 / camera.zoom;
        if (prop) ctx.strokeRect(num(prop.x) * TILE - 2, num(prop.y) * TILE - 2, num(prop.w, 1) * TILE + 4, num(prop.h, 1) * TILE + 4);
        else { ctx.beginPath(); ctx.ellipse(agent.x * TILE, agent.y * TILE + 2, 15, 6, 0, 0, TAU); ctx.stroke(); }
      }
      if (frame.preview) { const preview = frame.preview; ctx.fillStyle = preview.valid === false ? 'rgba(211,112,92,.22)' : 'rgba(164,206,174,.18)'; ctx.strokeStyle = preview.valid === false ? '#d4876d' : '#c0d7ae'; ctx.lineWidth = 1 / camera.zoom;
        for (const r of preview.rects || [preview]) { const x = num(r.x, num(r.x1)) * TILE, y = num(r.y, num(r.y1)) * TILE;
          const w = num(r.w, num(r.x2, num(r.x1)) - num(r.x1) + 1) * TILE, h = num(r.h, num(r.y2, num(r.y1)) - num(r.y1) + 1) * TILE; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); }
      }
      // Evict only after the frame has consumed every referenced image.
      while (chunks.size > 72) { const id = chunks.keys().next().value, c = chunks.get(id); for (const v of [c.floor, c.shade, c.glow]) release(v); chunks.delete(id); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); frames++; frameMs = typeof performance !== 'undefined' ? +(performance.now() - started).toFixed(2) : 0; return true;
    }
    return { draw, bounds: station => bounds(station || model || priorStation), tileAt,
      stats: () => ({ frames, geometryBuilds, chunkBuilds, lightBuilds, chunks: chunks.size, polygons: polygons.size, tiles: model ? model.tiles.size : 0, lights: latestLights.length, camera: latestCamera, frameMs, disposed }),
      dispose() { disposed = true; for (const c of chunks.values()) for (const v of [c.floor, c.shade, c.glow]) release(v); chunks.clear(); polygons.clear(); latestLights = []; } };
  }
  return { create, project, bounds, tileAt, canCross, rayLength, visibility, visible, material, STYLE_COLORS, MATERIALS, TILE, WALL };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = NextScene;
