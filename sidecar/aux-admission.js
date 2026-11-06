'use strict';
// Automatic subscription housekeeping shares one settled-spend admission lane per provider route.
// Foreground and explicit user work never use this queue. Timers start inside work(), after admission,
// so waiting cannot truncate a useful response. A pass completes and books its usage before the next checks.
function makeAuxAdmission({ gate }) {
  const tails = new Map();
  function schedule(route, work, skipped) {
    route = String(route || '');
    const dispatch = async () => {
      const state = gate(route);
      if (state.blocked) { if (skipped) skipped(state); return false; }
      await work();
      return true;
    };
    // Local/metered routes and an explicitly disabled ceiling keep their existing concurrency.
    if (!gate(route).applies) return dispatch();
    const previous = tails.get(route) || Promise.resolve();
    const result = previous.then(dispatch);
    // A failed pass must release the lane too. Preserve its rejection for its own caller, never for the next.
    const settled = result.then(() => {}, () => {});
    tails.set(route, settled);
    settled.then(() => { if (tails.get(route) === settled) tails.delete(route); });
    return result;
  }
  return { schedule };
}
module.exports = { makeAuxAdmission };
