/* STARNET — the DEAD-ENGINE diagnostic fallback (2026-07-29).

   WHY THIS TEST EXISTS. A 0.7.0 user sat on "Can't reach StarNet's local service" for a day. All support ever
   received was a screenshot of that sentence — because the app's one self-service diagnostic door,
   "⧉ copy diagnostics for a bug report", fetched GET /api/diagnostics FROM THE SIDECAR. So in the exact failure
   the door is offered under, it returned nothing and the user had nothing to send. Worse, that one sentence
   cannot distinguish the two causes it might have, and they have OPPOSITE fixes:
       • the sidecar never started        -> restarting/reinstalling is right;
       • the model's reply stream dropped -> restarting is useless and the sidecar is fine.

   So the fallback report has exactly one job: make a non-technical user's paste say WHICH. These assertions pin
   that job — most importantly that an UNPROVEN probe is reported as unproven and never rendered as "down"
   (truthful telemetry: an inconclusive measurement must never be published as a conclusive one). */
'use strict';
const A = require('./_assert.js');
const Diag = require('../frontend/app/diagnostics.js');

(async () => {
  const hadWindow = typeof global.window !== 'undefined';
  const savedWindow = global.window;
  try {
    // No Tauri shell and no Harness loaded: buildLine() -> '', engineVerdict() -> null (unproven).
    global.window = {};

    /* ---- (1) the three liveness verdicts must be distinguishable, and only ONE may blame the app ----
       Assert on the `local engine:` VERDICT LINE, not the whole report: the report also carries an explanatory
       note for support that quotes the phrase "NOT REACHABLE", so whole-body matching passes/fails for the wrong
       reason. The verdict line is the single thing a reader acts on, so it is the thing worth pinning. */
    const verdictLine = (report) => {
      const line = String(report).split('\n').find(l => /^local engine:/.test(l));
      A.ok(!!line, 'the report always carries exactly one `local engine:` verdict line');
      return line || '';
    };

    const dead = await Diag.localReport({ engineAlive: false });
    A.ok(/NOT REACHABLE/.test(verdictLine(dead)), 'a proven-dead engine is reported as NOT REACHABLE');
    A.ok(!/UNPROVEN/.test(verdictLine(dead)), 'a proven-dead engine is not also hedged as unproven');

    const alive = await Diag.localReport({ engineAlive: true });
    A.ok(/REACHABLE \(GET \/api\/health answered\)/.test(verdictLine(alive)), 'a proven-alive engine says so explicitly');
    A.ok(!/NOT REACHABLE/.test(verdictLine(alive)), 'a proven-alive engine is never reported as unreachable');
    // The whole point of the report: it must tell support that a restart is the WRONG fix in this case.
    A.ok(/will NOT help/.test(alive), 'the alive report warns support that restart/reinstall cannot help');

    const unproven = await Diag.localReport({});
    A.ok(/UNPROVEN/.test(verdictLine(unproven)), 'an unanswered probe is reported UNPROVEN...');
    A.ok(!/NOT REACHABLE/.test(verdictLine(unproven)), '...and is NEVER upgraded into a claim that the engine is down');

    // The SAVE-NET gate passes no engineAlive (10-08): the verdict must come from the real probe, so a dead
    // sidecar behind a rendered gate reads NOT REACHABLE — never the REACHABLE the gate used to hardcode.
    const hadHarness = Object.prototype.hasOwnProperty.call(global, 'Harness');
    const savedHarness = global.Harness;
    try {
      global.Harness = { pingEngine: () => Promise.resolve(false) };
      const gateDead = await Diag.localReport({ kind: 'SAVE-NET · SAVE REQUEST LOST', error: 'the app loaded, but its saved-station request did not return' });
      A.ok(/NOT REACHABLE/.test(verdictLine(gateDead)), 'with no engineAlive the report measures, and a dead probe reads NOT REACHABLE');
      global.Harness = { pingEngine: () => Promise.resolve(null) };
      A.ok(/UNPROVEN/.test(verdictLine(await Diag.localReport({ kind: 'SAVE-NET · SAVE REQUEST LOST' }))), 'a timed-out probe stays UNPROVEN');
    } finally { if (hadHarness) global.Harness = savedHarness; else delete global.Harness; }

    // ---- (2) the failure text + kind ride along, so the paste identifies the fault, not just the symptom ----
    const withCtx = await Diag.localReport({ engineAlive: true, kind: 'network', error: 'terminated' });
    A.ok(/terminated/.test(withCtx), 'the raw failure text is carried into the report');
    A.ok(/network/.test(withCtx), 'the classified kind is carried into the report');

    // ---- (3) it must never carry a secret. The report reads the API ORIGIN but must not touch the token. ----
    global.window = { __STARNET_API__: 'http://127.0.0.1:53124', __STARNET_API_TOKEN__: 'supersecrettoken123456' };
    const withOrigin = await Diag.localReport({ engineAlive: false });
    A.ok(/127\.0\.0\.1:53124/.test(withOrigin), 'the loopback origin is included (a wrong/absent port is the tell)');
    A.ok(!/supersecrettoken123456/.test(withOrigin), 'the per-launch API token is NEVER in the report');

    // defence in depth: a key-shaped string in the FAILURE TEXT is redacted before it can reach a bug report.
    const leaky = await Diag.localReport({ engineAlive: false, error: 'upstream rejected sk-abcdef1234567890XYZ' });
    A.ok(!/sk-abcdef1234567890XYZ/.test(leaky), 'a key-shaped token in the failure text is redacted');
    A.ok(/\[redacted-key\]/.test(leaky), 'and is replaced with an explicit redaction marker');

    // ---- (4) it must be honest that it is the SHORT report, so support does not read absence as evidence ----
    A.ok(/fallback/i.test(dead) && /SHORTER/.test(dead), 'the report names itself a page-side fallback');

    /* ---- (5) SWALLOWED ERRORS line (2026-08-21): three honest states, never collapsed into one ----
       The Settings DIAGNOSTICS block paints Diag.formatSwallowed(report.swallowed) on open. An unreadable report
       must say unknown (not zero); a measured zero must say none recorded; pressure lists the loudest tags. */
    A.eq(Diag.formatSwallowed(null), 'swallowed errors: unknown', 'no report -> unknown, never a reassuring zero');
    A.eq(Diag.formatSwallowed({}), 'swallowed errors: unknown', 'a report predating the field -> unknown');
    A.eq(Diag.formatSwallowed({ swallowed: { present: false, total: 0, tags: [] } }), 'swallowed errors: unknown', 'present:false (tally unreadable) -> unknown');
    A.eq(Diag.formatSwallowed({ swallowed: { present: true, total: 0, tagCount: 0, tags: [] } }), 'swallowed errors: none recorded since boot', 'a measured zero says none recorded');
    const busy = Diag.formatSwallowed({ swallowed: { present: true, total: 9, tagCount: 6, tags: [
      { tag: 'aux.reflection.envelope', count: 4 }, { tag: 'b', count: 1 }, { tag: 'c', count: 1 }, { tag: 'd', count: 1 }, { tag: 'e', count: 1 }, { tag: 'f', count: 1 }] } });
    A.ok(/^swallowed errors: 9 since boot — aux\.reflection\.envelope ×4 · b ×1 · c ×1 · d ×1 · \+2 more$/.test(busy), 'pressure lists total + loudest tags, bounded with an honest "+N more": ' + busy);
  } finally {
    if (hadWindow) global.window = savedWindow; else { try { delete global.window; } catch (_) { global.window = undefined; } }
  }
  A.report('diagnostics-dead-engine.test');
})().catch(e => { console.error(e); process.exit(1); });
