/* Durable turn-window comparison evidence. No ambient clock, file access or version lookup. */
'use strict';
const path = require('node:path');
const INTERVAL = 60000;
const SUBS = ['secret-raw', 'key-named', 'expanded', 'marker', 'unexplained'];
const count = n => Number.isSafeInteger(n) && n >= 0;
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = x => JSON.parse(JSON.stringify(x));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
const fields = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(k => own(value, k));
function valid(value, classes) {
  if (!fields(value, ['v', 'resetAt', 'resetReason', 'writeFailures', 'releases', 'agg']) || value.v !== 1 || !count(value.resetAt) || !['new', 'reset'].includes(value.resetReason) ||
      !count(value.writeFailures) || !Array.isArray(value.releases) || value.releases.length > 8 || !object(value.agg)) return false;
  const version = s => typeof s === 'string' && s.length <= 128;
  if (!value.releases.every(r => fields(r, ['app', 'harness', 'buildSha', 'firstAt', 'lastAt', 'boots']) && version(r.app) && version(r.harness) && version(r.buildSha) &&
    count(r.firstAt) && count(r.lastAt) && r.lastAt >= r.firstAt && count(r.boots))) return false;
  for (const [app, groups] of Object.entries(value.agg)) {
    if (!version(app) || !object(groups)) return false;
    for (const [key, r] of Object.entries(groups)) {
      if (!/^(merge\.(legacy|shadow|id)|window\.(legacy|shadow|id)|replay\.(legacy|id)|display\.(legacy|id))\.(desk|phone|-)$/.test(key) ||
          (!key.startsWith('window.') && !key.endsWith('.-')) || !fields(r, ['compared', 'byClass', 'bytesBySub', 'fitBoundaryMaxDepth', 'degraded', 'firstAt', 'lastAt']) || !count(r.compared) ||
          !object(r.byClass) || !Object.entries(r.byClass).every(([k, n]) => classes.has(k) && count(n)) ||
          !fields(r.bytesBySub, SUBS) || !Object.values(r.bytesBySub).every(count) ||
          !count(r.fitBoundaryMaxDepth) || !fields(r.degraded, ['compared', 'unexplained']) || !count(r.degraded.compared) || !count(r.degraded.unexplained) ||
          !count(r.firstAt) || !count(r.lastAt) || r.lastAt < r.firstAt) return false;
    }
  }
  return true;
}
function make(d) {
  const io = d.io;
  let state = 'untouched', status = '', since = 0, readAt = 0, lastWrite = null, version = null, ledger = null;
  let held = {}, bootAt = 0, bootCounted = false, dirty = false, urgent = false;
  const file = io && typeof io.dir === 'string' ? path.join(io.dir, 'turn-identity.soak.json') : '';
  const note = (tag, e) => { if (typeof d.note === 'function') d.note('turn.soak.' + tag, e); };
  function fresh(at, reason) { return { v: 1, resetAt: at, resetReason: reason, writeFailures: 0, releases: [], agg: {} }; }
  function openVersion(at) {
    if (version) return;
    bootAt = at;
    let v = {};
    try { v = io && typeof io.version === 'function' ? io.version() || {} : {}; }
    catch (error) { note('version', error); }
    version = Object.fromEntries(['app', 'harness', 'buildSha'].map(k => [k, typeof v[k] === 'string' ? v[k].slice(0, 128) : '']));
  }
  function boot(at) {
    if (bootCounted) return;
    let r = ledger.releases.find(x => x.app === version.app && x.harness === version.harness && x.buildSha === version.buildSha);
    if (!r) { r = Object.assign({}, version, { firstAt: bootAt, lastAt: at, boots: 0 }); ledger.releases.push(r); }
    r.firstAt = Math.min(r.firstAt, bootAt); r.lastAt = Math.max(r.lastAt, at); r.boots++;
    ledger.releases.sort((a, b) => a.lastAt - b.lastAt); ledger.releases = ledger.releases.slice(-8);
    bootCounted = true; dirty = true;
  }
  function mergeGroups(into, groups) {
    for (const [app, entries] of Object.entries(groups)) {
      if (!own(into, app)) put(into, app, {});
      for (const [key, r] of Object.entries(entries)) {
        if (!own(into[app], key)) { put(into[app], key, clone(r)); continue; }
        const out = into[app][key]; out.compared += r.compared;
        for (const name of Object.keys(r.byClass)) out.byClass[name] = (out.byClass[name] || 0) + r.byClass[name];
        for (const name of SUBS) out.bytesBySub[name] = (out.bytesBySub[name] || 0) + (r.bytesBySub[name] || 0);
        out.fitBoundaryMaxDepth = Math.max(out.fitBoundaryMaxDepth, r.fitBoundaryMaxDepth);
        out.degraded.compared += r.degraded.compared; out.degraded.unexplained += r.degraded.unexplained;
        out.firstAt = Math.min(out.firstAt, r.firstAt); out.lastAt = Math.max(out.lastAt, r.lastAt);
      }
    }
  }
  function touch(at) {
    if (!io) return;
    openVersion(at);
    if (state === 'open' || state === 'blocked' || (state === 'retrying' && at - readAt < INTERVAL)) return;
    let result;
    readAt = at;
    try { result = io.read(file); } catch (error) { result = { status: 'unreadable', err: error }; }
    const nextStatus = result && result.status || 'unreadable';
    if (nextStatus === 'absent' || (nextStatus === 'ok' && valid(result.value, d.classes))) {
      ledger = nextStatus === 'absent' ? fresh(at, 'new') : clone(result.value);
      state = 'open'; status = 'ok'; boot(at); mergeGroups(ledger.agg, held); held = {}; dirty = true;
      return;
    }
    const next = nextStatus === 'unreadable' ? 'retrying' : 'blocked';
    if (state !== next || status !== nextStatus) { since = at; note(nextStatus, new Error('turn soak ledger ' + nextStatus)); }
    state = next; status = nextStatus;
    if (state === 'blocked') { held = {}; urgent = false; }
  }
  function flush(at, force) {
    if (state !== 'open' || !dirty || (!force && lastWrite !== null && at - lastWrite < INTERVAL)) return;
    // Count failed attempts only on an open ledger, and retain updates for a later successful write.
    lastWrite = at;
    try { io.save(file, clone(ledger)); dirty = false; urgent = false; }
    catch (error) { ledger.writeFailures++; note('write', error); }
  }
  function record(entry, event) {
    if (!io) return;
    const at = entry.at; touch(at);
    if (state === 'blocked') return;
    const counts = entry.counts, bytes = count(counts.bytes) ? counts.bytes : 0;
    const subs = Object.fromEntries(SUBS.map(k => [k, 0]));
    let explained = 0;
    for (const name of SUBS.slice(0, 4)) { subs[name] = Math.min(bytes - explained, count(counts[name]) ? counts[name] : 0); explained += subs[name]; }
    subs.unexplained = bytes - explained;
    const depth = counts.fit_boundary ? (count(event.fitBoundaryDepth) ? event.fitBoundaryDepth : 6) : 0;
    const row = { compared: 1, byClass: Object.assign({}, counts), bytesBySub: subs, fitBoundaryMaxDepth: depth,
      degraded: { compared: event.degraded === true ? 1 : 0, unexplained: event.degraded === true && (counts.unexplained || subs.unexplained) ? 1 : 0 }, firstAt: at, lastAt: at };
    const key = entry.surface + '.' + entry.mode + '.' + (entry.surface === 'window' ? entry.caller || '-' : '-');
    // Caller-less fallback diagnostics have their own '-' bucket; they never count as desk comparisons.
    const groups = {}; put(groups, version.app, { [key]: row });
    mergeGroups(state === 'open' ? ledger.agg : held, groups);
    dirty = true; urgent = urgent || !!counts.unexplained || !!counts.order || subs.unexplained > 0 || depth > 5;
    flush(at, urgent);
  }
  function get() {
    if (!io) return { state: 'blocked', status: 'unconfigured', since: 0 };
    const at = d.now(); touch(at); flush(at, urgent);
    return state === 'open' ? Object.assign({ state }, clone(ledger)) : { state, status, since };
  }
  function reset() {
    const at = d.now(); touch(at);
    if (!io || state === 'retrying') throw Object.assign(new Error('turn soak ledger is unreadable'), { code: 'TURN_SOAK_UNAVAILABLE' });
    const next = fresh(at, 'reset');
    // Explicit reset is the sole authorization to replace blocked evidence. Publish only after durable success.
    next.releases.push(Object.assign({}, version, { firstAt: at, lastAt: at, boots: 1 }));
    try { io.save(file, clone(next)); } catch (error) {
      if (state === 'open') { ledger.writeFailures++; dirty = true; }
      note('write', error); throw error;
    }
    ledger = next; state = 'open'; status = 'ok'; held = {}; dirty = false; urgent = false;
    bootCounted = true; bootAt = at; lastWrite = at;
    return Object.assign({ state }, clone(ledger));
  }
  return { record, get, reset };
}
module.exports = { make, valid };
