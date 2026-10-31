/* sidecar/channels/fire-store.js — a channel store whose per-agent TURN HISTORY belongs to ONE fire (quick win 27), and
   whose DELIVERY LEDGER is that hub's own, in memory (channel-delivery-ledger S2).

   A line trigger, a SEND TO hand-off and a sample job (RUN ONE REAL JOB / station.test_line) are each one standalone job.
   Their hubs keep the shared channel store for chat bookkeeping, but a downstream hop replays its prior turns from
   store.loadHistory(hopKey) — and the sample hub read the REAL store there, so every test job of a line replayed the
   hand-offs of every earlier test job at that dock (paid tokens, and a stage "remembering" work it never did on this
   job). The trigger hub already wrapped the store; this is that wrapper, shared, so the two can no longer differ.

   THE LEDGER IS THE JOB'S TOO. These hubs capture their replies into the current job's record in this process, so the
   job record is their durability. On the shared ledger a reply of theirs would reach channels/delivery.json, and a later
   process (or a later fire's hub) would drain it into ANOTHER job's output; with fixed chat ids ('sample', 'trg-<id>',
   'hof-<line>') every fire shares one lane. So store.ledger answers a ledger of this wrapper's own with nothing on disk
   (store.makeEphemeralLedger()): nothing of theirs reaches delivery.json, and no other fire's hub can drain it.

     perFireStore(store, turnsFor) -> a store whose loadHistory/appendTurn/clearHistory read and write turnsFor(agentId)
       turnsFor(agentId) -> the CURRENT fire's mutable turn array for that agent ([] when no fire is running)
   Every other method is the real store's, bound to it. loadHistory hands back the last 40 turns (a copy). */
'use strict';

const FIRE_HISTORY_MAX = 40;

function perFireStore(store, turnsFor) {
  if (!store || typeof turnsFor !== 'function') throw new Error('perFireStore: a store and turnsFor(agentId) are required');
  const turns = (agentId) => { const t = turnsFor(agentId); return Array.isArray(t) ? t : []; };
  let ledger;   // made on first use: a store with no ledger (a test's fake) leaves the hub to make its own
  const jobLedger = () => {
    if (ledger === undefined) ledger = typeof store.makeEphemeralLedger === 'function' ? store.makeEphemeralLedger() : null;
    return ledger;
  };
  return new Proxy(store, {
    get: (t, k) => k === 'loadHistory' ? (agentId) => turns(agentId).slice(-FIRE_HISTORY_MAX)
      : k === 'appendTurn' ? (agentId, role, content) => { turns(agentId).push({ role: role, content: content }); }
      : k === 'clearHistory' ? () => 0
      : k === 'ledger' ? jobLedger()
      : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])
  });
}

module.exports = { perFireStore, FIRE_HISTORY_MAX };
