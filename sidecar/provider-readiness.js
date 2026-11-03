/* Credential evidence, never credential custody. The store supplies exact pairs; only their one-way
   binding and adapter verdicts survive here. Complete unverified configurations remain runnable. */
'use strict';
function makeProviderReadiness(o) {
  const rows = Object.create(null), staged = new Map();
  let dirty = false;
  const now = o.now, digest = o.digest;
  const saved = o.load ? o.load() : null;
  if (saved && saved.version === 1 && saved.providers) for (const [id, r] of Object.entries(saved.providers)) {
    if (r && /^[a-f0-9]{64}$/.test(r.bind || '') && ['verified', 'rejected', 'unverified'].includes(r.status)) {
      rows[id] = { bind: r.bind, status: r.status, lastVerified: r.status === 'verified' && Number.isFinite(r.lastVerified) ? r.lastVerified : null,
        httpStatus: Number(r.httpStatus) || 0, endpointState: 'unknown' };
    }
  }
  const binding = (id, key, url) => digest(JSON.stringify([id, String(key || ''), String(url || '').trim().replace(/\/+$/, '')]));
  const keySlot = (id, key) => id + '@key/' + digest(String(key || ''));
  function save() {
    dirty = true;
    try { if (!o.save || o.save({ version: 1, providers: rows }) !== false) dirty = false; }
    catch (_) { return false; }   // dirty stays set; expose the failed write and retry the live verdict
    return !dirty;
  }
  function sync(id, key, url) {
    const bind = binding(id, key, url), before = rows[id];
    if (before && before.bind === bind) { if (dirty) save(); return before; }
    const proof = staged.get(id + ':' + bind);
    const row = { bind, status: 'unverified', lastVerified: null, httpStatus: 0, endpointState: 'unknown' };
    if (proof && now() - proof.at < 300000) Object.assign(row, proof.row);
    staged.delete(id + ':' + bind);
    rows[id] = row;
    if (before || proof) save();
    return row;
  }
  function evidence(id, key, url) {
    const r = rows[id];
    return r && r.bind === binding(id, key, url) ? Object.assign({}, r) : { status: 'unverified', lastVerified: null, endpointState: 'unknown' };
  }
  function ticket(id, key, url) { return rows[id] && rows[id].bind === binding(id, key, url) ? rows[id] : undefined; }
  function syncPairs(id, pairs) {
    const kept = new Set();
    for (const pair of pairs) {
      const slot = keySlot(id, pair.key); kept.add(slot); sync(slot, pair.key, pair.url);
    }
    let removed = false;
    for (const slot of Object.keys(rows)) if (slot.startsWith(id + '@key/') && !kept.has(slot)) { delete rows[slot]; removed = true; }
    if (removed) save();
  }
  function note(id, key, url, result, ticket) {
    const bind = binding(id, key, url), current = rows[id];
    // A response that began against the active pair cannot land after rotation (including rotate-back).
    if (ticket && current !== ticket) return false;
    const active = current && current.bind === bind;
    if (!active && !result.credentialVerified) return false;
    const r = active ? current : { bind, status: 'unverified', lastVerified: null };
    r.endpointState = result.reachable ? 'reachable' : 'unreachable';
    r.httpStatus = Number(result.httpStatus) || 0;
    if (result.credentialVerified === true) { r.status = 'verified'; r.lastVerified = now(); }
    else if (result.status === 'rejected') { r.status = 'rejected'; r.lastVerified = null; }
    // A network failure, malformed 200 or public catalog cannot erase a previous credential verdict.
    if (active) save();
    else {
      if (staged.size >= 32) staged.delete(staged.keys().next().value);
      staged.set(id + ':' + bind, { at: now(), row: r });
    }
    return !dirty;
  }
  function project(input) {
    const e = evidence(input.slot || input.id, input.key, input.url);
    const status = input.credentialStatus || (input.expired ? 'expired' : (!input.present && input.required ? 'missing' : e.status));
    const alternateReady = !!(input.alternates && input.alternates.eligible);
    const ready = !!input.materialReady && (status !== 'rejected' || alternateReady) && status !== 'expired';
    return { provider: input.id, configured: ready, unattendedReady: ready, persisted: !dirty,
      ...(dirty ? { persistenceError: 'connection check is not saved; after restart the previous check may return' } : {}),
      credential: { present: !!input.present, required: !!input.required, status: !input.required && !input.present ? 'not-required' : status },
      endpoint: { configured: !!input.endpointConfigured, status: e.endpointState },
      lastVerified: status === 'verified' ? e.lastVerified : null,
      ...(input.alternates ? { alternateCredentials: input.alternates } : {}),
      reason: input.reason || (status === 'rejected' ? (alternateReady ? 'primary credential rejected; alternate available' : 'credential rejected') : status === 'expired' ? 'sign-in expired; reconnect' :
        !input.endpointConfigured ? 'endpoint missing' : !ready ? 'credential missing' : status === 'verified' ? 'verified' : 'unverified'),
      ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}) };
  }
  return { sync, syncPairs, keySlot, ticket, evidence, note, project,
    accepted: (id, key, url) => evidence(id, key, url).status !== 'rejected' };
}
module.exports = { makeProviderReadiness };
