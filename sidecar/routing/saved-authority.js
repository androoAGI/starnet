/* sidecar/routing/saved-authority.js — THE SAVED FLOOR AS THE ONE ROUTING AUTHORITY, behind a small host-agnostic interface.

   The floor the user SAVED is the only record that survives a restart, a second window and a page that never opens, so it is
   what should say which agent runs a piece of work, not the last plan a page happened to post. This module is the one reader
   of that floor for a host to build on. It wraps the strict private projection (station-store.js makeSavedFloorProjection:
   the primary file only, never the .bak, never a quarantine, never a last-good value) and adds what a host needs around it,
   and nothing else. It owns no file, clock or route: the caller injects the reads. The sidecar builds its router and its
   POST /api/routing receipt on it, always (index.js: there is no other routing authority); the line-hold lane adopts bindingOf
   and checkBinding.

     makeSavedAuthority({ read: { agentId, stamp, loadPrimaryState, hasRecoveryCopy } }) -> {
       status()             -> frozen { version:1, state, status, routingOk, identity, revision, stamp, topologyHash }
       projection()         -> the strict projection, memoized: what makeRouter({ savedProjection }) takes
       compareHint(raw)     -> frozen receipt of the exact-hint comparison, with its httpStatus 200 | 409 | 422 | 503
       require()            -> status(), or throws RoutingHeld unless the floor routes (the dispatch gate)
       bindingOf()          -> frozen { planIdentity, topologyHash, revision } of the routable floor, or throws RoutingHeld
       checkBinding(record) -> 'current' | 'stale' | 'legacy-unbound' | 'held'
       HELD_CODES           -> every status -> its typed error code (EROUTING_SAVED_<STATUS>, the router's own grammar)
     }
   read.stamp and read.loadPrimaryState are the save store's, bound to the agent (the arguments the projection already takes);
   read.hasRecoveryCopy is savestore.hasRecoveryCopy bound the same way.

   FOUR STATES. state is the class a host branches on; status is the reason it prints and the suffix of the error code.
     ok          a proved floor the compiler accepts. Routes.
     unroutable  a proved floor the compiler refuses (a loop, an orphan source, ...). Does not route; its capability, brief and
                 limit facts are still true, so a router can still read them.
     unfloored   no primary and no copy of one: a new install. Nothing to route and nothing wrong; a caller goes on as it did
                 with no plan.
     held        anything else, because the source cannot be proved right now. status says why: absent (a primary gone beside
                 a .bak or a quarantine copy), corrupt, unreadable, future, invalid, unvouched, migration-required,
                 unsupported-geometry, unstamped, unavailable or changed.
   Doubt is held: a probe that cannot tell whether a copy exists, a stat that cannot be taken, a source that is not plainly
   one of the above. Only a clean listing that shows no copy makes a missing primary unfloored.

   THE MEMO. projection() is keyed by read.stamp(): a hit is ONE stat, no read and no compile, so the router and the hint route
   can ask on every call. A moved stamp reads again. Only an ok source is ever memoized; a held one is read afresh on every
   call, and the memo is dropped the moment a read is not ok, so nothing good can be served after something bad. A read that a
   save overtook ('changed') is repeated at most twice, so a save that lands mid-read does not flap into a refusal and one that
   keeps landing is a held 'changed' rather than a loop.
   THE STAMP IS AN INVALIDATION TOKEN, NOT A DIGEST. An outside edit that leaves the file's size and mtime alone would not move
   it (cap-scope.makeSavedFloor already stands on the same assumption), and a lock that leaves the bytes alone does not move it
   either: the bytes at this stamp are still the bytes that were proved. A changed file that cannot be read is held 'unreadable'.

   THE HINT. A page posts {version:1, plan, compilerLinks} only to ask "is this exactly the saved floor?". Nothing it carries
   installs anything or appears in the receipt; identity, revision and stamp come from the saved owner alone.
     200 ok          the hint is exactly the saved floor and it routes
     422 unroutable  the hint is exactly the saved floor and the compiler refuses it
     409 pending     the hint is not the saved floor (or is not a hint), or nothing is saved yet: the page's floor is unsaved
     503 unavailable the saved floor is held

   THE BINDING. A record that names a floor carries planIdentity, 'saved-plan-v1:<sha256>': the owner's own digest of the
   compiled plan with its links, so a changed brief, capability, limit or SEND TO is a different identity at the same topology.
   The 8-hex planHash older records carry is only the topology hash (belts, sources, bays): the same topology is not the same
   floor, so it is never authority, even when it equals the current one. checkBinding says legacy-unbound for any record that
   has no exact v1 identity, whatever the floor is doing; otherwise held unless the floor routes; otherwise current on an equal
   identity and stale on any other. It answers "is this the same saved floor", and require() answers "may it run"; a caller
   that resumes work asks both, and 'current' is only ever said for a floor that routes. */
'use strict';
const { makeSavedFloorProjection, compareHintToSaved } = require('../station-store.js');
const { heldWhy } = require('./saved-hold.js');

// a save that keeps landing mid-read is read again this many times, then held 'changed'
const CHANGED_RETRIES = 2;
const IDENTITY = /^saved-plan-v1:[a-f0-9]{64}$/;
// the router's own typed-failure grammar (router.js savedFailure), so one code names a state wherever it is thrown
const codeOf = status => 'EROUTING_SAVED_' + String(status).toUpperCase().replace(/[^A-Z0-9]/g, '_');
const HELD_CODES = Object.freeze(Object.fromEntries([
  'unreadable', 'absent', 'corrupt', 'unavailable', 'unstamped', 'invalid', 'future', 'migration-required', 'unvouched',
  'unsupported-geometry', 'changed', 'unroutable', 'unfloored'
].map(status => [status, codeOf(status)])));
const HTTP = Object.freeze({ ok: 200, unroutable: 422, pending: 409, unavailable: 503 });

class RoutingHeld extends Error {
  constructor(status, state) {
    super('Saved routing authority is held: ' + status);
    this.name = 'RoutingHeld';
    this.code = codeOf(status);
    this.status = status;
    this.state = state || 'held';
    // held: a floor that cannot be proved (saved-hold.js words it); unroutable and unfloored are not holds
    if (this.state === 'held') { this.held = true; this.why = heldWhy(status); }
  }
}

// the shape the private projection gives every non-ok source, so the router reads this module's answer like its own
const nothing = status => Object.freeze({ version: 1, status, routingOk: false, plan: null, stationDoc: null, identity: null });
const UNFLOORED = nothing('unfloored');
const UNFLOORED_RECEIPT = Object.freeze({ version: 1, status: 'pending', matched: false, routingOk: false, sourceStatus: 'unfloored',
  reason: 'unfloored', identity: null, revision: null, stamp: null, httpStatus: HTTP.pending });

function makeSavedAuthority(o) {
  const read = o && o.read;
  if (!read || typeof read.hasRecoveryCopy !== 'function') throw new Error('saved authority requires the primary save owner and its recovery probe');
  const project = makeSavedFloorProjection(read);   // throws unless stamp, loadPrimaryState and the agent id are the owner's
  let memo = null;   // { stamp, value, status } of the last OK read, and only of an ok one

  // the memo, if the save has not moved since it was proved: one stat
  function hit() {
    if (!memo) return null;
    let now = '';
    try { now = String(read.stamp() || ''); }
    catch (e) { now = ''; }   // a stamp that cannot be taken is no hit; the read below holds it as unreadable
    if (now && now === memo.stamp) return memo;
    memo = null;
    return null;
  }
  function refresh() {
    let p = project();
    for (let again = 0; p.status === 'changed' && again < CHANGED_RETRIES; again++) p = project();
    return p;
  }
  function hasCopy() {
    try { return !!read.hasRecoveryCopy(); }
    catch (e) { return true; }   // doubt is held: only a clean answer of "none" makes a missing primary unfloored
  }
  function describe(p) {
    const ok = p.status === 'ok';
    const state = ok ? (p.routingOk ? 'ok' : 'unroutable') : p.status === 'unfloored' ? 'unfloored' : 'held';
    const status = ok ? state : typeof p.status === 'string' && p.status ? p.status : 'invalid';
    return Object.freeze({ version: 1, state, status, routingOk: state === 'ok',
      identity: ok ? p.identity : null, revision: ok ? p.revision : null, stamp: ok ? p.stamp : null, topologyHash: ok ? p.topologyHash : null });
  }

  function projection() {
    const h = hit();
    if (h) return h.value;
    const p = refresh();
    if (p.status === 'ok') { memo = { stamp: p.stamp, value: p, status: describe(p) }; return p; }
    memo = null;
    return p.status === 'absent' && !hasCopy() ? UNFLOORED : p;
  }
  function status() {
    const p = projection();
    return memo && memo.value === p ? memo.status : describe(p);
  }
  function requireRoutable() {
    const s = status();
    if (s.state !== 'ok') throw new RoutingHeld(s.status, s.state);
    return s;
  }
  function bindingOf() {
    const s = requireRoutable();
    return Object.freeze({ planIdentity: s.identity, topologyHash: s.topologyHash, revision: s.revision });
  }
  function checkBinding(record) {
    const claimed = record && typeof record === 'object' && !Array.isArray(record) && Object.prototype.hasOwnProperty.call(record, 'planIdentity')
      ? record.planIdentity : undefined;
    if (typeof claimed !== 'string' || !IDENTITY.test(claimed)) return 'legacy-unbound';   // the 8-hex planHash never counts
    const s = status();
    if (s.state !== 'ok') return 'held';
    return claimed === s.identity ? 'current' : 'stale';
  }
  function compareHint(raw) {
    const saved = projection();
    if (saved.status === 'unfloored') return UNFLOORED_RECEIPT;
    const receipt = compareHintToSaved(saved, raw);
    return Object.freeze(Object.assign({}, receipt, { httpStatus: HTTP[receipt.status] || HTTP.unavailable }));
  }

  return Object.freeze({ status, projection, compareHint, require: requireRoutable, bindingOf, checkBinding, HELD_CODES });
}

module.exports = { makeSavedAuthority, RoutingHeld, HELD_CODES };
