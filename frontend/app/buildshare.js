/* SHARED STATION BUILDS (community builds, phase 1 — 2026-10-07). A build file carries a station's LAYOUT and nothing
   else: rooms, floors, walls, furniture, belts and junction routing. Everything that is the Commander's own work or
   machine stays home — who owns a desk, a step's instructions and role, an Inbox's project folder and spend limits, a
   connector or plugin binding, a machine's label, the pipeline edges between agents, and player-made props (their art
   lives in this station's .userprops folder and was paid for by this Commander).

   The SAME cleaner runs on export and on import: a file someone hand-edited (or wrote to smuggle instructions into a
   line) is stripped to layout before it reaches replaceLayout, which then validates every room and prop placement.

   Pure + headless-testable (no DOM, no IO). build.js owns the download, the file picker and the apply.

     BuildShare.exportBuild(stationDoc, model, { name })  -> { text, filename, stats, dropped }
     BuildShare.readBuild(text, model, nextId)             -> { ok, error?, doc, name, stats, dropped } */
'use strict';
const BuildShare = (() => {
  const FORMAT = 'starnet.build';
  const VERSION = 1;
  const EXT = '.starnet-build.json';
  const MAX_BYTES = 2 * 1024 * 1024;
  // generous over the largest real station (MAX_SPAN 240 already bounds the footprint) — these only stop a hostile file
  // from making the importer walk millions of entries before replaceLayout ever sees it
  const LIMITS = { rooms: 120, rects: 600, props: 3000, belts: 20000, paint: 60000 };
  const COORD = 4096;
  const KEY_RE = /^-?\d{1,5},-?\d{1,5}$/;
  const TYPE_RE = /^[a-z][a-z0-9_]{0,47}$/;
  const STYLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  // per-prop LAYOUT fields copied as-is; worldmodel.migrate re-validates every one (cleanRot/cleanDoor/applyJunctionCfg)
  const PROP_LAYOUT = ['r', 'm', 'door', 'routes', 'def', 'bufferSize', 'timeoutMin', 'maxIter', 'done', 'esc', 'when', 'onSpent'];
  // per-prop WORK fields — never shared (counted so the UI can say what stayed home)
  const PROP_WORK = ['agentId', 'role', 'brief', 'hands', 'label', 'projectRoot', 'limits', 'connectorId', 'pluginId'];

  const isObj = x => x != null && typeof x === 'object' && !Array.isArray(x);
  const int = v => (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= COORD) ? v : null;
  // a room name is display text: printable, one line, the same 24-char cap renameRoom applies
  const cleanName = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const style = v => (typeof v === 'string' && STYLE_RE.test(v)) ? v : null;

  function cleanRoom(src, model) {
    if (!isObj(src) || !Array.isArray(src.rects)) return null;
    const kinds = model && model.ROOM_KINDS;
    const kind = typeof src.kind === 'string' && (!kinds || kinds[src.kind]) ? src.kind : null;
    if (!kind) return null;
    const rects = [];
    for (const r of src.rects.slice(0, 32)) {
      if (!isObj(r)) return null;
      const q = [int(r.x1), int(r.y1), int(r.x2), int(r.y2)];
      if (q.some(v => v == null)) return null;
      rects.push({ x1: q[0], y1: q[1], x2: q[2], y2: q[3] });
    }
    if (!rects.length) return null;
    const paint = {};
    if (isObj(src.floorPaint)) {
      const styles = model && model.FLOOR_STYLES;
      let n = 0;
      for (const k of Object.keys(src.floorPaint)) {
        if (++n > LIMITS.paint) break;
        const v = src.floorPaint[k];
        if (KEY_RE.test(k) && typeof v === 'string' && (!styles || styles[v])) paint[k] = v;
      }
    }
    const tier = int(src.tier);
    return {
      kind, name: cleanName(src.name, 24) || kind.toUpperCase(), rects,
      floorStyle: style(src.floorStyle), floorMat: style(src.floorMat), wallStyle: style(src.wallStyle), wallMat: style(src.wallMat),
      hullStyle: style(src.hullStyle), hullMat: style(src.hullMat), tier: tier != null && tier >= 0 && tier <= 9 ? tier : 0, floorPaint: paint
    };
  }

  /* The ONE cleaner (export + import). Returns { doc, dropped:{ made, work, rooms, props } } or { error }. Room and prop ids
     are renumbered from `nextId` (the live doc's _nid + headroom, as the presets do) so no imported id can alias an id the
     crew, an undo snapshot or a cached link still holds. */
  function cleanDoc(src, model, nextId) {
    if (!isObj(src) || !isObj(src.rooms)) return { error: 'NO_LAYOUT' };
    const order = Array.isArray(src.order) ? src.order.filter(id => typeof id === 'string') : Object.keys(src.rooms);
    if (order.length > LIMITS.rooms) return { error: 'TOO_BIG' };
    const props = Array.isArray(src.props) ? src.props : [];
    if (props.length > LIMITS.props) return { error: 'TOO_BIG' };
    let rectCount = 0;
    let n = Number.isInteger(nextId) && nextId > 0 ? nextId : 1;
    const dropped = { made: 0, work: 0, rooms: 0, props: 0 };
    const roomIds = {}, rooms = {}, outOrder = [];
    for (const rid of order) {
      const room = cleanRoom(src.rooms[rid], model);
      if (!room) { dropped.rooms++; continue; }
      rectCount += room.rects.length;
      if (rectCount > LIMITS.rects) return { error: 'TOO_BIG' };
      const id = 'r' + n++;
      roomIds[rid] = id; room.id = id; rooms[id] = room; outOrder.push(id);
    }
    if (!outOrder.length) return { error: 'NO_ROOMS' };
    const outProps = [];
    for (const p of props) {
      if (!isObj(p) || typeof p.t !== 'string') { dropped.props++; continue; }
      if (p.t.startsWith('user_')) { dropped.made++; continue; }
      const pos = [int(p.x), int(p.y), int(p.w), int(p.h)];
      if (!TYPE_RE.test(p.t) || pos.some(v => v == null)) { dropped.props++; continue; }
      const o = { id: 'p' + n++, t: p.t, x: pos[0], y: pos[1], w: Math.max(1, pos[2]), h: Math.max(1, pos[3]) };
      if (p.block === false) o.block = false;
      for (const k of PROP_LAYOUT) if (p[k] != null && (typeof p[k] !== 'object' || k === 'routes')) o[k] = p[k];
      if (PROP_WORK.some(k => p[k] != null && p[k] !== '')) dropped.work++;
      outProps.push(o);
    }
    const belts = {};
    if (isObj(src.belts)) {
      let b = 0;
      for (const k of Object.keys(src.belts)) {
        if (++b > LIMITS.belts) return { error: 'TOO_BIG' };
        const d = src.belts[k];
        if (KEY_RE.test(k) && (d === 'E' || d === 'W' || d === 'N' || d === 'S')) belts[k] = d;
      }
    }
    const meta = isObj(src.meta) ? src.meta : {};
    const nonCorridor = outOrder.find(id => rooms[id].kind !== 'corridor') || outOrder[0];
    const doc = {
      schema: 'starnet.station', version: 2, _nid: n,
      meta: {
        name: cleanName(meta.name, 40) || 'SHARED BUILD', createdAt: 0, tier: 0,
        spawnRoomId: roomIds[meta.spawnRoomId] || nonCorridor, trunkRoomId: roomIds[meta.trunkRoomId] || roomIds[meta.spawnRoomId] || nonCorridor
      },
      // links are re-derived from the belts on load (worldmodel currentLinks); pipeline edges name agents — both stay home
      rooms, order: outOrder, props: outProps, belts, edges: [], links: null
    };
    return { doc, dropped };
  }

  function statsOf(doc) {
    const rooms = doc.order.filter(id => doc.rooms[id].kind !== 'corridor').length;
    return { rooms, props: doc.props.length, belts: Object.keys(doc.belts).length, lines: doc.props.filter(p => p.t === 'intake').length, steps: doc.props.filter(p => p.t === 'bay').length };
  }
  function slug(name) { return String(name || 'station').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'station'; }

  function exportBuild(stationDoc, model, opts) {
    const name = cleanName(opts && opts.name, 40) || cleanName(stationDoc && stationDoc.meta && stationDoc.meta.name, 40) || 'MY STATION';
    const r = cleanDoc(stationDoc, model, 1);
    if (r.error) return { error: r.error };
    r.doc.meta.name = name;
    delete r.doc.meta.createdAt;   // a build has no station identity; the importer's station keeps its own
    const file = { format: FORMAT, version: VERSION, name, station: r.doc };
    return { text: JSON.stringify(file, null, 1) + '\n', filename: slug(name) + EXT, stats: statsOf(r.doc), dropped: r.dropped };
  }

  const ERRORS = {
    TOO_LARGE: 'That file is too large to be a station build.',
    NOT_JSON: 'That file is not a station build (it is not readable JSON).',
    NOT_BUILD: 'That file is not a station build.',
    NEWER: 'That build was made by a newer StarNet. Update the app to open it.',
    NO_LAYOUT: 'That build has no layout in it.',
    NO_ROOMS: 'That build has no rooms that can be built.',
    TOO_BIG: 'That build is larger than a station can be.'
  };
  function fail(code) { return { ok: false, error: code, message: ERRORS[code] || 'That build could not be read.' }; }

  function readBuild(text, model, nextId) {
    const s = String(text == null ? '' : text);
    if (s.length > MAX_BYTES) return fail('TOO_LARGE');
    let file;
    try { file = JSON.parse(s); } catch (_) { return fail('NOT_JSON'); }
    if (!isObj(file)) return fail('NOT_BUILD');
    // a plain station save (the shape replaceLayout takes) is accepted too — it goes through the same cleaner
    let src;
    if (file.format === FORMAT) {
      if (!(Number.isInteger(file.version) && file.version >= 1)) return fail('NOT_BUILD');
      if (file.version > VERSION) return fail('NEWER');
      src = file.station;
    } else if (file.schema === 'starnet.station') src = file;
    else return fail('NOT_BUILD');
    const r = cleanDoc(src, model, nextId);
    if (r.error) return fail(r.error);
    const name = cleanName(file.name, 40) || r.doc.meta.name;
    r.doc.meta.name = name;
    return { ok: true, doc: r.doc, name, stats: statsOf(r.doc), dropped: r.dropped };
  }

  return { FORMAT, VERSION, EXT, MAX_BYTES, LIMITS, cleanDoc, exportBuild, readBuild, statsOf };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BuildShare;
