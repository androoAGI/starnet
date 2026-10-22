/* AGENT OS — journeystore.js: QuerySpine projection for /api/journey.
   The sidecar owns every claim. QuerySpine owns GET dedupe/polling/freshness/error truth; this citizen
   performs explicit Commander writes and projects proven evolution into the world. */
'use strict';
const JourneyStore = (() => {
  let seeded = false, lastStage = 0, stop = null, lastJourney = null, lastSig = null;
  let epochFn = () => 1;

  function epoch() { try { return Math.max(1, Math.floor(Number(epochFn()) || 1)); } catch (_) { return 1; } }
  function spine() { return (typeof QuerySpine !== 'undefined' && QuerySpine) ? QuerySpine : null; }

  function state() {
    const q = spine();
    if (!q || !q.state) return { hasData: false, data: undefined, stale: true, error: { message: 'journey query unavailable' }, pending: false };
    try { return q.state('journey'); }
    catch (_) { return { hasData: false, data: undefined, stale: true, error: { message: 'journey query unavailable' }, pending: false }; }
  }

  /* A CHANGE SIGNATURE, not object identity. The journey arrives from a fresh JSON.parse on every poll, so
     `journey === lastJourney` was NEVER true for polled data — only for a same-object re-apply. With the
     journey query polling every 4s, that made apply() re-render the QUEST LOG every 4 seconds forever, which
     is what "the quest log is constantly flashing" was: the panel's whole innerHTML rebuilt on a timer, on
     data that had not changed. Comparing the SERIALIZED value fixes it at the source, and a re-render still
     happens the instant anything in the journey really moves. */
  function signatureOf(journey) {
    try { return JSON.stringify(journey); } catch (_) { return null; }   // unserializable → null → always treated as changed
  }

  function apply(journey) {
    if (!journey || typeof journey !== 'object') return false;
    if (journey === lastJourney) return true;
    const sig = signatureOf(journey);
    const unchanged = sig !== null && sig === lastSig;
    lastJourney = journey;
    lastSig = sig;
    if (unchanged) return true;   // same journey, new object — nothing to repaint
    const prior = lastStage;
    lastStage = Math.max(0, Number(journey.evolution && journey.evolution.stage) | 0);
    try { if (typeof Topbar !== 'undefined' && Topbar._paintXp) Topbar._paintXp(); } catch (_) {}
    try { document.body.dataset.journeyStage = String(lastStage); } catch (_) {}
    if (seeded && lastStage > prior) {
      try { if (typeof SFX === 'object' && SFX.milestone) SFX.milestone(); } catch (_) {}
      // NO StationUI.notify (notification diet): the sting + the quest-log rerender below carry the evolution.
    }
    seeded = true;
    try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false); } catch (_) {}
    return true;
  }

  function observe(snap) {
    const envelope = snap && snap.hasData && snap.data;
    if (envelope && envelope.ok && envelope.journey) apply(envelope.journey);
    try { if (typeof Topbar !== 'undefined' && Topbar._paintXp) Topbar._paintXp(); } catch (_) {}
  }
  function publish(journey) {
    const q = spine();
    if (q && q.update) {
      try {
        q.update('journey', { ok: true, journey });
        if (!stop) apply(journey);
        return true;
      } catch (_) {}
    }
    return apply(journey);
  }

  async function refetch(force) {
    const q = spine();
    if (!q) return status();
    try {
      const snap = await (force && q.refresh ? q.refresh('journey') : q.get('journey'));
      observe(snap);
    } catch (_) { /* QuerySpine retains last-good and publishes stale/error metadata */ }
    return status();
  }

  async function post(body) {
    try {
      const payload = Object.assign({}, body || {});
      if (payload.epoch == null || (typeof payload.epoch === 'string' && !payload.epoch.trim()) || !Number.isFinite(Number(payload.epoch))) payload.epoch = epoch();
      const res = await fetch('/api/journey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await res.json().catch(() => null);
      if (j && j.journey) publish(j.journey);
      return j || { ok: false, error: 'journey response unavailable' };
    } catch (_) { return { ok: false, error: 'journey service unavailable' }; }
  }

  function init(opts) {
    opts = opts || {};
    epochFn = typeof opts.epoch === 'function' ? opts.epoch : () => Number(opts.epoch) || 1;
    if (stop) { try { stop(); } catch (_) {} stop = null; }
    seeded = false; lastStage = 0; lastJourney = null; lastSig = null;
    const q = spine();
    if (q && q.subscribe) {
      try { stop = q.subscribe('journey', observe); return; } catch (_) {}
    }
    refetch(true);
  }
  function sync(force) { return refetch(force === true); }
  function status() {
    const snap = state(), envelope = snap && snap.hasData && snap.data;
    return envelope && envelope.ok && envelope.journey ? envelope.journey : null;
  }
  function createMetric(d) { return post(Object.assign({ op: 'metric.create' }, d || {})); }
  function registerGoal(d) { return post(Object.assign({}, d || {}, { op: 'goal.register' })); }
  function confirmGoal(d) { return post(Object.assign({}, d || {}, { op: 'goal.confirm' })); }
  function updateMetric(id, current, note) { return post({ op: 'metric.update', id: String(id || ''), current: Number(current), note: String(note || '') }); }
  function retireMetric(id) { return post({ op: 'metric.retire', id: String(id || '') }); }
  function suppress(agentId, domain) { return post({ op: 'adaptation.suppress', agentId, domain }); }
  function resume(agentId, domain) { return post({ op: 'adaptation.resume', agentId, domain }); }
  function reset(nextEpoch) {
    seeded = false; lastStage = 0; lastJourney = null; lastSig = null;
    const q = spine(); if (q && q.invalidate) { try { q.invalidate('journey'); } catch (_) {} }
    return post({ op: 'journey.reset', epoch: Math.max(1, Math.floor(Number(nextEpoch) || epoch())) });
  }
  function noteMilestone(d) {
    d = Object.assign({}, d || {});
    if (!d.domain && typeof Journey !== 'undefined' && Journey.domainOf) d.domain = Journey.domainOf((d.milestoneText || '') + ' ' + (d.goalText || ''));
    d.op = 'milestone.complete';
    return post(d);
  }
  return { init, sync, status, state, registerGoal, confirmGoal, createMetric, updateMetric, retireMetric, suppress, resume, reset, noteMilestone, _apply: publish };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { JourneyStore };
