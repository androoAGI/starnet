/* Turn identity rollback modes and bounded diagnostics. All clock, storage and hashing come from the host. */
'use strict';
const DEFAULTS = Object.freeze({ merge: 'id', window: 'shadow', replay: 'id', display: 'id' });
const MODES = Object.freeze({ merge: ['legacy', 'shadow', 'id'], window: ['legacy', 'shadow', 'id'], replay: ['legacy', 'id'], display: ['legacy', 'id'] });
const CLASSES = new Set(['late', 'retracted', 'forgotten', 'hidden-kind', 'idless', 'pending', 'orphan', 'foreign', 'bytes', 'secret-raw', 'key-named', 'expanded', 'marker', 'order', 'fit_boundary', 'station_rowid_collision', 'reuse_conflict', 'unvouched', 'unexplained', 'fallback']);
const TurnSoak = require('./turn-soak.js');
function make(d) {
  if (!d || typeof d.now !== 'function' || typeof d.hash !== 'function') throw new Error('turn-dual needs injected clock and hash');
  let loaded = false, saved = {};
  const counters = {}, ring = [];
  const soak = TurnSoak.make({ io: d.soak, now: d.now, note: d.failNote, classes: CLASSES });
  const valid = (surface, mode) => Object.prototype.hasOwnProperty.call(MODES, surface) && MODES[surface].includes(mode);
  const fail = (surface, error) => { if (typeof d.failNote === 'function') d.failNote('turnid.' + surface, error); };
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const value = typeof d.read === 'function' ? d.read() : null;
      const modes = value && (value.modes || value);
      if (modes && typeof modes === 'object') for (const surface of Object.keys(DEFAULTS)) if (valid(surface, modes[surface])) saved[surface] = modes[surface];
    } catch (e) { fail('modes.read', e); }
  }
  function modes() {
    load();
    const out = Object.assign({}, DEFAULTS, saved);
    for (const surface of Object.keys(DEFAULTS)) {
      const env = typeof d.env === 'function' ? d.env('STARNET_TURNID_' + surface.toUpperCase()) : undefined;
      if (valid(surface, env)) out[surface] = env;
    }
    return out;
  }
  function setMode(surface, mode) {
    if (!valid(surface, mode)) { const e = new Error('invalid turn identity surface or mode'); e.code = 'TURN_IDENTITY_MODE'; throw e; }
    load();
    const next = Object.assign({}, saved, { [surface]: mode });
    if (typeof d.save !== 'function') throw new Error('turn identity mode storage unavailable');
    d.save({ v: 1, modes: next });   // publish in memory only after durable success
    saved = next;
    return modes();
  }
  function record(surface, event) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, surface)) return;
    const e = event || {}, counts = {}, keys = {};
    for (const raw of Object.keys(e.counts || {})) {
      const name = CLASSES.has(raw) ? raw : 'unexplained', n = e.counts[raw];
      if (Number.isSafeInteger(n) && n > 0) counts[name] = (counts[name] || 0) + n;
    }
    for (const raw of Array.isArray(e.classes) ? e.classes : []) { const name = CLASSES.has(raw) ? raw : 'unexplained'; if (!counts[name]) counts[name] = 1; }
    for (const name of Object.keys(counts)) {
      counters[surface + '.' + name] = (counters[surface + '.' + name] || 0) + counts[name];
      // Keys can contain stream ids. Hash them before they enter telemetry; content is never accepted.
      if (e.keys && Array.isArray(e.keys[name])) keys[name] = e.keys[name].slice(0, 8).map(k => String(d.hash(String(k))).slice(0, 12));
    }
    const entry = { at: d.now(), surface, mode: modes()[surface], counts, keys };
    if (e.streamId) entry.stream = String(d.hash(String(e.streamId))).slice(0, 12);
    if (typeof e.runId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(e.runId)) entry.runId = e.runId;
    if (surface === 'window' && ['desk', 'phone'].includes(e.caller)) entry.caller = e.caller;
    ring.push(entry); if (ring.length > 64) ring.shift();
    soak.record(entry, e);
    // The existing failNote owner throttles warnings. Counts/classes only: never stream, key or content.
    if (Object.keys(counts).length) fail('divergence', new Error(JSON.stringify({ surface, mode: entry.mode, counts })));
  }
  function pick(surface, legacyFn, nextFn) {
    const mode = modes()[surface];
    if (!mode || mode === 'legacy') return legacyFn();
    let next;
    try { next = nextFn(); }
    catch (e) { fail(surface, e); record(surface, { classes: ['fallback'] }); return legacyFn(); }
    if (mode === 'shadow') return legacyFn();
    return next;
  }
  function status() { const mode = modes(); return { v: 2, caps: caps(mode), modes: mode, counters: Object.assign({}, counters), ring: ring.slice(-20).map(e => JSON.parse(JSON.stringify(e))), soak: soak.get() }; }
  function caps(mode) { return { window: mode.window === 'id' ? 'id' : 'shadow', windowRequired: true }; }
  function identity(streamId, rows, options) {
    const o = options || {}, list = Array.isArray(rows) ? rows : [], seen = new Set(), collided = new Set();
    const key = row => JSON.stringify([row.streamId || streamId, row.rowId]);
    const ids = list.filter(r => r && Number.isSafeInteger(r.rowId) && r.rowId > 0);
    for (const row of ids) {
      const k = key(row);
      if (seen.has(k) || row.idFrom === 'collision') collided.add(k);
      seen.add(k);
    }
    const mode = modes();
    return { v: 2, streamId, fromRowId: ids.length ? Math.min(...ids.map(r => r.rowId)) : 0,
      liveRunIds: Array.from(o.liveRunIds || []).map(String), collided: [...collided].slice(0, 50),
      retracted: (o.retracted || []).slice(0, 2000), forgottenAt: Number(o.forgottenAt) || 0,
      forgotten: { keys: (o.forgotten && o.forgotten.keys || []).slice(0, 2000), runIds: (o.forgotten && o.forgotten.runIds || []).slice(0, 200) },
      modes: mode, caps: caps(mode), hasOlder: o.hasOlder === true };
  }
  function project(streamId, rows, options) {
    const o = options || {}, list = Array.isArray(rows) ? rows : [], seen = new Set(), collided = new Set();
    const key = row => JSON.stringify([row.streamId || streamId, row.rowId]);
    for (const row of list) {
      if (!row || !Number.isSafeInteger(row.rowId) || row.rowId <= 0) continue;
      const k = key(row);
      if (seen.has(k) || row.idFrom === 'collision' || (typeof o.isCollided === 'function' && o.isCollided(row.rowId))) collided.add(k);
      seen.add(k);
    }
    // Per-row provenance carries the complete demotion proof. Only its diagnostic summary is bounded at 50 keys.
    const turns = list.map(row => row && collided.has(key(row)) ? Object.assign({}, row, { idFrom: 'collision' }) : row);
    const reply = { stream: streamId, turns, identity: identity(streamId, turns, o) };
    // A cursor read (GET ?after=) adds where it stopped, after the fields every reader already has; any other read is byte-identical.
    const c = o.cursor;
    if (c && typeof c === 'object') reply.cursor = { last: Number.isSafeInteger(c.last) && c.last >= 0 ? c.last : 0,
      count: Number.isSafeInteger(c.count) && c.count >= 0 ? c.count : turns.length, more: c.more === true };
    return reply;
  }
  return { modes, setMode, record, pick, status, identity, project, resetSoak: soak.reset };
}
module.exports = { make, DEFAULTS, MODES };
