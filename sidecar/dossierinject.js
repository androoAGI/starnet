/* sidecar/dossierinject.js — fold the station-wide Commander Dossier into a SERVER-COMPOSED autonomous
   persona (Commander Dossier, Phase C).

   Most runs already carry the dossier: the browser composes it into the system prompt (composeSystemPrompt),
   and that prompt rides verbatim into /api/run, into the pushed crew roster (so team.dispatch workers inherit
   it), and into a configured Telegram agent. The gap is the runs the SIDECAR composes its OWN persona for —
   chiefly CRON/scheduled runs (a hardcoded autonomous persona) — which otherwise never know who they work for.
   This appends the dossier block to such a persona so an unattended run still serves the right Commander.
   Learned state in a persona stays out of the cached prefix: runOnce splits it off (learned-tail.js).

   PURE (a `withDossier` on the SK namespace in the browser UMD shape, module.exports under node) + node-testable:
   no Date.now / Math.random / fs / network — exactly what lint-determinism.js requires of a cron-path helper. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).dossierInject = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // append the dossier block to a server-composed system prompt. Empty/whitespace block → the system is
  // returned UNCHANGED (byte-identical to a dossier-less run — the no-op invariant the cron tests rely on).
  // Idempotent: a system that already contains the block (e.g. a frontend-composed prompt) is never doubled.
  function withDossier(system, block) {
    const sys = String(system == null ? '' : system);
    const b = String(block == null ? '' : block).trim();
    if (!b) return sys;
    if (sys.indexOf(b) >= 0) return sys;   // already present — never double-append
    return sys ? (sys + '\n\n' + b) : b;
  }

  return { withDossier: withDossier };
});
