'use strict';

const WorldModel = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const Save = require('../frontend/app/save.js');
const { createHash } = require('node:crypto');

// A private snapshot boundary, not a second floor compiler. Reject values that
// JSON would silently erase, and bound the walk before allocating its encoding.
// One walk makes two things. `encoded` is the KEY-SORTED encoding: it is what identity and the exact hint
// comparison are made of, so no key order can ever be authority. `data` is a frozen clone that keeps the
// caller's OWN key order, because order is input to the compiler: WorldModel and Pipeline walk belts in
// insertion order and plan.hash is taken over that order. A sorted copy (the old JSON.parse(encoded)) compiled
// a different plan than the page that drew the floor, so no hint could ever match its own saved floor.
function floorSnapshot(value) {
  let bytes = 0, nodes = 0;
  const seen = new Set();
  function text(s) {
    bytes += Buffer.byteLength(s, 'utf8');
    if (bytes > 16 * 1024 * 1024) throw new Error('saved floor projection exceeds its byte bound');
    return s;
  }
  // returns { e: the key-sorted encoding of v, c: a clone of v in v's own key order }
  function walk(v, depth) {
    if (++nodes > 500000 || depth > 48) throw new Error('saved floor projection exceeds its structural bound');
    // -0 encodes as 0, so it clones as 0: data is always what JSON.parse(encoded) would have held
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return { e: text(JSON.stringify(v)), c: v === 0 ? 0 : v };
    if (typeof v === 'string') return { e: text(JSON.stringify(v)), c: v };
    if (!v || typeof v !== 'object' || seen.has(v)) throw new Error('saved floor projection is not finite JSON');
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) throw new Error('saved floor projection is not plain JSON');
    seen.add(v);
    let encoded, clone;
    if (Array.isArray(v)) {
      const parts = [];
      clone = [];
      for (let i = 0; i < v.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(v, i)) throw new Error('saved floor projection contains a sparse array');
        const item = walk(v[i], depth + 1);
        parts.push(item.e); clone.push(item.c);
      }
      encoded = text('[') + parts.join(text(',')) + text(']');
    } else {
      const byKey = new Map();
      clone = {};
      for (const key of Object.keys(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('saved floor projection contains an accessor');
        const item = walk(descriptor.value, depth + 1);
        byKey.set(key, text(JSON.stringify(key)) + text(':') + item.e);
        // an own key even when it is named __proto__, exactly as JSON.parse made it
        Object.defineProperty(clone, key, { value: item.c, enumerable: true, writable: true, configurable: true });
      }
      encoded = text('{') + Array.from(byKey.keys()).sort().map(key => byKey.get(key)).join(text(',')) + text('}');
    }
    seen.delete(v);
    return { e: encoded, c: clone };
  }
  const top = walk(value, 0), encoded = top.e;
  if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024 * 1024) throw new Error('saved floor projection exceeds its byte bound');
  function freeze(v) { if (v && typeof v === 'object') { for (const item of Object.values(v)) freeze(item); Object.freeze(v); } return v; }
  return { encoded, data: freeze(top.c) };
}

function boundedFloorGeometry(doc) {
  // Private admission supports the same 240-tile footprint span enforced by
  // WorldModel edits. deserialize itself does not enforce that edit-time bound.
  const span = 240, tileBudget = span * span, coordinate = n => Number.isSafeInteger(n) && Math.abs(n) <= 0x3fffffff;
  const rooms = doc.rooms, props = doc.props;
  if (Object.keys(rooms).length > 256 || props.length > 2048) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, area = 0;
  for (const id of doc.order) {
    const rects = rooms[id].rects;
    if (!Array.isArray(rects) || !rects.length || rects.length > 1024) return false;
    for (const r of rects) {
      if (!r || ![r.x1, r.y1, r.x2, r.y2].every(coordinate) || r.x2 < r.x1 || r.y2 < r.y1) return false;
      minX = Math.min(minX, r.x1); minY = Math.min(minY, r.y1); maxX = Math.max(maxX, r.x2); maxY = Math.max(maxY, r.y2);
      area += (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
      if (area > tileBudget || maxX - minX + 1 > span || maxY - minY + 1 > span) return false;
    }
  }
  if (!Number.isFinite(minX)) return false;
  let propArea = 0;
  for (const p of props) {
    if (![p.x, p.y, p.w, p.h].every(coordinate) || p.w < 1 || p.h < 1 || p.w > span || p.h > span) return false;
    propArea += p.w * p.h;
    if (propArea > tileBudget) return false;
  }
  if (!doc.belts || typeof doc.belts !== 'object' || Array.isArray(doc.belts) || Object.keys(doc.belts).length > tileBudget) return false;
  for (const key of Object.keys(doc.belts)) {
    if (!/^-?\d+,-?\d+$/.test(key)) return false;
    const [x, y] = key.split(',').map(Number);
    if (![x, y].every(coordinate) || x < minX - WorldModel.MARGIN || x > maxX + WorldModel.MARGIN || y < minY - WorldModel.MARGIN || y > maxY + WorldModel.MARGIN) return false;
  }
  if (doc.links != null && (!Array.isArray(doc.links) || doc.links.length > 2048)) return false;
  if (doc.edges != null && (!Array.isArray(doc.edges) || doc.edges.length > 2048)) return false;
  return true;
}

// PRIVATE/UNWIRED: every call reads the existing primary save owner afresh.
// A caller must inspect status and routingOk; null never authorizes a fallback.
function makeSavedFloorProjection(read) {
  if (!read || typeof read.stamp !== 'function' || typeof read.loadPrimaryState !== 'function') throw new Error('saved floor projection requires the primary save owner');
  if (typeof read.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(read.agentId)) throw new Error('saved floor projection requires its exact save owner');
  const validator = makeStationStore();
  const held = status => Object.freeze({ version: 1, status, routingOk: false, plan: null, stationDoc: null, identity: null });
  return function savedFloorProjection() {
    let before, source;
    try { before = read.stamp(); source = read.loadPrimaryState(); }
    catch (_) { return held('unreadable'); }
    if (!source || source.status !== 'ok') return held(source && ['absent', 'unreadable', 'corrupt'].includes(source.status) ? source.status : 'unavailable');
    if (typeof before !== 'string' || !before) return held('unstamped');
    const w = source.wrapper, doc = w && w.doc;
    if (!w || Array.isArray(w) || typeof w !== 'object' || w.agentId !== read.agentId) return held('invalid');
    if (w.version !== 1) return held(typeof w.version === 'number' && w.version > 1 ? 'future' : 'invalid');
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !['starnet.save', 'skynet.save'].includes(doc.schema)) return held('invalid');
    if (doc.version !== Save.CURRENT) return held(typeof doc.version === 'number' && doc.version > Save.CURRENT ? 'future' : 'migration-required');
    if (!Number.isSafeInteger(w.revision) || w.revision < 1 || doc._saveRevision !== w.revision) return held('invalid');
    if (!source.head || source.head.revision !== w.revision || source.head.client !== w.client || w.client !== doc._saveClient) return held('unvouched');
    const raw = doc.station;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 'starnet.station') return held('invalid');
    // v2 is the existing WorldModel link format. Earlier documents must first
    // complete its normal durable migration; future formats are never normalized.
    if (raw.version !== 2) return held(typeof raw.version === 'number' && raw.version > 2 ? 'future' : 'migration-required');
    let original, checked, plan, stationDoc, compilerLinks, identity;
    try {
      original = floorSnapshot(raw);
      const props = original.data.props, rooms = original.data.rooms, order = original.data.order;
      if (!Array.isArray(props) || !rooms || typeof rooms !== 'object' || Array.isArray(rooms) || !Array.isArray(order)) return held('invalid');
      // Existing migration repairs missing IDs but does not reject duplicate
      // prop IDs. A stable round-trip alone cannot prove those keyed maps.
      const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 80 && !['__proto__', 'constructor', 'prototype'].includes(key);
      if (props.some(p => !p || !safeKey(p.id)) || new Set(props.map(p => p.id)).size !== props.length) return held('invalid');
      if (order.some(id => !safeKey(id) || !Object.prototype.hasOwnProperty.call(rooms, id) || !rooms[id] || rooms[id].id !== id)
          || new Set(order).size !== order.length) return held('invalid');
      if (!boundedFloorGeometry(original.data)) return held('unsupported-geometry');
      checked = validator.validateStationDoc(original.data);
      if (!checked.ok) return held('invalid');
      stationDoc = floorSnapshot(checked.doc);
      if (stationDoc.encoded !== original.encoded) return held('migration-required');
      const compiled = checked.routingPlan;
      for (const bay of compiled.bays || []) bay.objects = checked.station.bayObjects(bay.agentId, bay.propId);
      for (const bay of compiled.dockBays || []) bay.objects = checked.station.bayObjects(bay.agentId, bay.propId);
      // Pipeline's links are deliberately non-enumerable. Preserve them as an
      // explicit immutable companion rather than losing them through JSON.
      compilerLinks = floorSnapshot(compiled.links || null).data;
      const semantic = floorSnapshot({ version: 1, plan: compiled, compilerLinks });
      plan = semantic.data.plan;
      identity = 'saved-plan-v1:' + createHash('sha256').update(semantic.encoded).digest('hex');
    } catch (_) { return held('invalid'); }
    let after;
    try { after = read.stamp(); } catch (_) { return held('unreadable'); }
    if (before !== after) return held('changed');
    return Object.freeze({ version: 1, status: 'ok', stamp: after, revision: w.revision, client: source.head.client,
      routingOk: checked.routingOk, topologyHash: plan.hash, identity, plan, compilerLinks, stationDoc: stationDoc.data });
  };
}

// PRIVATE/UNWIRED: a posted plan is only a comparison hint. JSON omits the
// compiler's non-enumerable links, so callers must send that companion explicitly.
// No posted field can install a plan or supply the saved identity in the reply.
// This compares against a projection the caller already holds: routing/saved-authority.js memoizes the projection by
// the save's stamp, so a hint costs no compile there. makeSavedFloorHint below takes a fresh projection per call.
function compareHintToSaved(saved, rawHint) {
  const held = (status, reason) => Object.freeze({ version: 1, status, matched: false, routingOk: false,
    sourceStatus: saved.status, reason, identity: null, revision: null, stamp: null });
  if (saved.status !== 'ok') return held('unavailable', 'saved-floor-unavailable');
  let hint, expected;
  try {
    hint = floorSnapshot(rawHint);
    const h = hint.data;
    if (!h || Array.isArray(h) || typeof h !== 'object' || Object.keys(h).length !== 3
      || h.version !== 1 || !Object.prototype.hasOwnProperty.call(h, 'plan')
      || !Object.prototype.hasOwnProperty.call(h, 'compilerLinks')
      || !h.plan || typeof h.plan !== 'object' || Array.isArray(h.plan)) return held('pending', 'invalid-hint');
    expected = floorSnapshot({ version: 1, plan: saved.plan, compilerLinks: saved.compilerLinks });
  } catch (_) { return held('pending', 'invalid-hint'); }
  if (hint.encoded !== expected.encoded) return held('pending', 'hint-mismatch');
  return Object.freeze({ version: 1, status: saved.routingOk ? 'ok' : 'unroutable',
    matched: saved.routingOk, routingOk: saved.routingOk, sourceStatus: 'ok',
    reason: saved.routingOk ? null : 'saved-floor-unroutable', identity: saved.identity,
    revision: saved.revision, stamp: saved.stamp });
}

function makeSavedFloorHint(read) {
  const project = makeSavedFloorProjection(read);
  return function compareSavedFloorHint(rawHint) {
    return compareHintToSaved(project(), rawHint); // exactly one fresh primary-owner projection per comparison
  };
}

function makeStationStore(o) {
  o = o || {};
  const model = o.worldModel || WorldModel;
  let station = null;
  let doc = null;
  let routingPlan = null;

  function validateStationDoc(nextDoc) {
    if (!nextDoc || typeof nextDoc !== 'object' || Array.isArray(nextDoc)) return { ok: false, error: 'station document required' };
    if (nextDoc.schema && nextDoc.schema !== 'starnet.station') return { ok: false, error: 'unsupported station schema' };
    if (!nextDoc.rooms || typeof nextDoc.rooms !== 'object' || Array.isArray(nextDoc.rooms)) return { ok: false, error: 'station rooms required' };
    if (!Array.isArray(nextDoc.order) || nextDoc.order.length < 1) return { ok: false, error: 'station must contain at least one room' };
    if (!Array.isArray(nextDoc.props)) return { ok: false, error: 'station props must be an array' };
    let parsed;
    try { parsed = model.deserialize(nextDoc); } catch (e) { return { ok: false, error: (e && e.message) || 'station rejected' }; }
    if (!parsed || typeof parsed.bayObjects !== 'function' || typeof parsed.serialize !== 'function') return { ok: false, error: 'station model unavailable' };
    if (!parsed.rooms || !parsed.rooms().length) return { ok: false, error: 'station must contain at least one room' };
    const plan = Pipeline.compileRoutingPlan(parsed.projectGeometry());
    return { ok: true, station: parsed, doc: parsed.serialize(), routingPlan: plan, routingOk: Pipeline.ok(plan) };
  }

  function setStation(nextDoc) {
    const v = validateStationDoc(nextDoc);
    if (!v.ok) return { ok: false, error: v.error };
    station = v.station;
    doc = v.doc;
    routingPlan = v.routingPlan;
    return { ok: true, rooms: station.rooms().length, props: station.props().length, routingOk: v.routingOk, routingPlan };
  }

  function setSaveDoc(saveDoc) {
    if (!saveDoc || typeof saveDoc !== 'object' || Array.isArray(saveDoc)) return { ok: false, error: 'save document required' };
    if (!saveDoc.station || typeof saveDoc.station !== 'object' || Array.isArray(saveDoc.station)) return { ok: false, error: 'save document station required' };
    return setStation(saveDoc.station);
  }

  function clearStation() { station = null; doc = null; routingPlan = null; return { ok: true, cleared: true }; }
  function hasStation() { return !!station; }
  function getStation() { return doc; }
  function getRoutingPlan() { return routingPlan; }
  // (multi-bay) dockId = the bay the run is at; the station model resolves that bay's room (or the agent's desk room)
  function bayObjects(agentId, dockId) { return station ? station.bayObjects(agentId, dockId) : null; }

  return { validateStationDoc, setStation, setSaveDoc, clearStation, hasStation, getStation, getRoutingPlan, bayObjects };
}

module.exports = { makeStationStore, makeSavedFloorProjection, makeSavedFloorHint, compareHintToSaved };
