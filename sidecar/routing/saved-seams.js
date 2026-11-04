/* sidecar/routing/saved-seams.js — HOW THE HOST ASKS THE ROUTER once the saved floor is the routing authority.

   The router (router.js, savedHost) answers from the saved floor and throws only when that floor cannot be proved right now
   (error.held === true: corrupt, unreadable, still being saved, ...). Every place the host asks the router is one of two kinds,
   and says which by the object it asks:

     admit.<reader>(...)     a DISPATCH seam: it decides whether work runs, where, as whom, or with what room. A hold is NEVER
                             swallowed here: the typed error goes up to the seam's own visible refusal (the hub's reply, a
                             routine's blocked row, Run Now's 409, the chain's refused stop). A held floor runs nothing.
     observe.<reader>(...)   a READ seam: a derived fact, a limit, a readout (line stats, the station.layout routing fact, a
                             persisted receipt, a group chat's room). A hold degrades it to what a router with no plan answers
                             (null, [] or false), so a held floor never takes a display or a save down with it.
     hold()                  the entry gate: null, or { status, why } when the saved floor is held right now. A seam that must
                             refuse BEFORE it starts anything asks this first (admit then covers a floor that goes held mid-way).

   Both objects expose the router's READERS only. The mutators (setPlan, clearPlan, setStation, clearStation) are not on either, so
   a posted plan cannot be installed through a seam; test/saved-floor-callers.census.test.js holds every router.* site in the
   sidecar to admit or observe, and holds the host to no mutator at all.
   With no authority (a pure-router fixture over the posted-plan router; the host always has one) both objects are the router
   itself: no seam changes behaviour. */
'use strict';
const { holdOf, heldWhy } = require('./saved-hold.js');
const { note: failNote } = require('../failopen.js');   // tagged fail-open: a log line that threw stays visible

// every router reader, with what it answers when it can say nothing: the posted-plan router's own answer with no plan
const EMPTY = Object.freeze({
  getPlan: () => null, hasPlan: () => false, getStation: () => null,
  resolveTarget: () => null, resolveDock: () => null,
  dockOf: () => null, entryDockOf: () => null, docksOf: () => [], agentOfDock: () => null, lineOfDock: () => null, dockRef: () => null,
  lineOfAgent: () => null, lineOriginFor: () => null, intakeReceiptFor: () => null, lineLimits: () => null,
  chainNext: () => null, chainStep: () => null, chainPeek: () => null, fanSiblings: () => [], loopGateAfter: () => null,
  chainShipsToOutbox: () => false, stationFor: () => null, stageBrief: () => null,
  chainNextDock: () => null, chainStepDock: () => null, chainPeekDock: () => null, fanSiblingsDock: () => []
});
const READERS = Object.freeze(Object.keys(EMPTY));
const MUTATORS = Object.freeze(['setPlan', 'clearPlan', 'setStation', 'clearStation']);

/* makeRouterSeams({ router, authority?, onHold? }) -> { admit, observe, hold }
   authority is routing/saved-authority.js (status()); onHold(hold, reader) is told each time an observe seam degrades. */
function makeRouterSeams(o) {
  const router = o && o.router, authority = (o && o.authority) || null;
  const onHold = o && typeof o.onHold === 'function' ? o.onHold : null;
  if (!router) throw new Error('the seams need the router');
  for (const name of READERS) if (typeof router[name] !== 'function') throw new Error('the router has no reader ' + name);
  const admit = {}, observe = {};
  for (const name of READERS) {
    admit[name] = router[name];
    observe[name] = !authority ? router[name] : function (...args) {
      try { return router[name](...args); }
      catch (e) {
        const held = holdOf(e);
        if (!held) throw e;
        if (onHold) { try { onHold(held, name); } catch (e2) { failNote('routing.saved-seams.onHold', e2); } }   // a log line must not take a read down
        return EMPTY[name]();
      }
    };
  }
  function hold() {
    if (!authority) return null;
    let s;
    try { s = authority.status(); }
    catch (_) { return { status: 'unreadable', why: heldWhy('unreadable') }; }   // an authority that cannot answer is a hold, never a pass
    return s && s.state === 'held' ? { status: s.status, why: heldWhy(s.status) } : null;
  }
  return Object.freeze({ admit: Object.freeze(admit), observe: Object.freeze(observe), hold });
}

module.exports = { makeRouterSeams, READERS, MUTATORS, EMPTY };
