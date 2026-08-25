/* STARNET — safety.js : the emergency-stop (E-STOP) logic, the visible topbar control + Alt+H hotkey.

   The harness autonomously spends the Commander's money and writes files, so it needs a one-click
   "stop EVERYTHING". HALT calls /api/halt — which kills every run on the sidecar (browser AND any
   messaging-hub/Telegram run) — and aborts the local streams. Degrades silently when the API isn't reachable.

   EL-11 FIX 2: error copy tells users to "press E-STOP", but after the old corner button was removed
   (it overlapped the bottom-right status cluster) the path was Alt+H ONLY and the hotkey appeared nowhere
   in the DOM — an instruction pointing at a control that didn't exist. Restored conservatively: a compact
   E-STOP instrument in the topbar's status cluster (existing chrome vocabulary, no corner overlay), which
   itself teaches the Alt+H hotkey in its title. The hotkey stays global. */
'use strict';
(function () {
  if (typeof document === 'undefined') return;

  async function halt() {
    // SERVER first — the authoritative kill-all (it reaches background / cron / night-shift / Telegram runs the
    // browser has no handle to) — THEN abort the local fetch streams. Order is load-bearing for the toast's
    // honesty: aborting locally first closed the /api/run request, whose close-handler deleted the run from the
    // server's `runs` map BEFORE /api/halt counted it — so the toast said "stopped 0 runs" while runs were in
    // fact being stopped. Counting on the server before local teardown keeps the number real; the local abort
    // still lands milliseconds later (and the server-side abort has already ended the loops' spend either way).
    // Default to UNPROVEN, not to zero. If Harness is missing from this page, or haltAll returns
    // nothing, no stop was ever attempted — and "stopped 0 runs" would be a claim about the station
    // rather than an admission about us.
    let receipt = { ok: false, halted: 0, reason: 'the harness was unavailable in this page' };
    try { if (typeof Harness !== 'undefined' && Harness.haltAll) receipt = await Harness.haltAll() || receipt; } catch (_) {}
    // Local streams are aborted either way: a server that never answered is exactly when the browser's
    // own in-flight run most needs killing.
    try { if (typeof Chat !== 'undefined' && Chat.abort) Chat.abort(); } catch (_) {}
    const n = receipt && typeof receipt.halted === 'number' ? receipt.halted : 0;
    const persistence = [
      ['nightshiftHaltPersisted', 'night shift'],
      ['cronHaltPersisted', 'routines'],
      ['loopsHaltPersisted', 'loops']
    ];
    const failed = persistence.filter(([field]) => receipt && receipt[field] === false).map(([, label]) => label);
    /* THE REQUEST'S OWN OUTCOME COMES FIRST. A halt whose request 500'd or never arrived used to render
       "HALT — stopped 0 runs" in routine `warn` chrome — visually identical to a clean stop of an idle
       station, on the one control the Commander presses when money is being spent and files written.
       Proven against a live station before the fix: an HTTP 500 and a network failure BOTH produced
       exactly {msg: 'HALT — stopped 0 runs', kind: 'warn'}.
       Only `ok === false` counts as failure: a receipt with no `ok` at all is a legacy/simulated one and
       keeps the old reading, so this stays additive to the /api/halt contract. */
    const msg = receipt && receipt.ok === false
      ? 'E-STOP FAILED — ' + (receipt.reason || 'the stop was not confirmed') +
        '. Runs may still be live: press E-STOP again, and quit StarNet if it keeps failing'
      : 'HALT — stopped ' + n + ' run' + (n === 1 ? '' : 's') + (failed.length
        ? ' now · restart protection failed for ' + failed.join(', ') + '; retry E-STOP before restarting'
        : '');
    const kind = (receipt && receipt.ok === false) || failed.length ? 'bad' : 'warn';
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(msg, kind); } catch (_) {}
    try { if (typeof SFX !== 'undefined' && SFX.alarm) SFX.alarm(); } catch (_) {}
  }
  // Alt+H is a global E-STOP — it fires even while typing (an emergency stop must never be swallowed by focus).
  window.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); halt(); }
  });

  // the visible affordance: a compact stop control seated in the topbar status cluster (#topbar .tb-status),
  // to the LEFT of the uplink/status pills so the danger control reads first. Built idempotently after the
  // chrome exists; a missing topbar (title/connect screens) just retries on the next DOM-ready pass.
  function buildEstop() {
    const cluster = document.querySelector('#topbar .tb-status');
    if (!cluster || document.getElementById('estop-btn')) return;
    const b = document.createElement('button');
    b.id = 'estop-btn';
    b.type = 'button';
    b.textContent = '⏹ E-STOP';
    b.title = 'E-STOP — kill every live run, everywhere, now (Alt+H)';
    b.setAttribute('aria-label', 'Emergency stop — halt all runs (Alt+H)');
    b.addEventListener('click', halt);
    cluster.insertBefore(b, cluster.firstChild);
  }
  if (document.readyState !== 'loading') buildEstop();
  else document.addEventListener('DOMContentLoaded', buildEstop);
})();
