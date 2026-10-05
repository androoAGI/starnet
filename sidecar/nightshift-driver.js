/* sidecar/nightshift-driver.js — the NIGHT-SHIFT tick DRIVER (autonomy layer, NS-1), determinism-split clean.

   The orchestration half of the server-owned idle-autonomy loop: it owns the per-tick decision flow (roll the
   day → ask the pure planner whether a beat may fire → if so, take the same-agent mutex, run the ported act
   pipeline as ONE autonomous beat, record the beat + persist, log the decision to the ledger) and NOTHING
   ambient. Every dependency is INJECTED — there is NO Date.now / Math.random / new Date() / setInterval /
   setTimeout / fs / crypto here — so it passes lint-determinism.js and is headless-testable with a fake clock +
   fakes (exactly like cron-driver.js). The ambient half — the real setInterval, Date.now, the state file
   load/persist, the runOnce fire, the ledger append — lives ONLY in sidecar/index.js (the composition root).

   makeNightshiftDriver(deps) -> { applyTick(nowMs) -> {fired, binding, decision}, runInFlight:()=>bool, _internals }
     deps.getState()                 -> state            // the persisted driver state (index.js mirror)
     deps.setState(state)            -> void             // replace + PERSIST (index.js: state=…; saveState())
     deps.getPosture()               -> { actsUnattended, leashPerDay } | null   // the SERVER copy of the dial
     deps.lastActivity()             -> int ms           // lastUserActivityAt (index.js tracks it)
     deps.isHalted()                 -> bool             // the E-STOP is engaged (index.js: no live run + a halt flag)
     deps.concurrencyFree(agentId)   -> bool             // the same-agent run mutex is free for this agent
     deps.precheck({ agentId })      -> { ok, reason } | bool | undefined   // OPTIONAL (NS-2): a PURELY-LOCAL readiness/
     //   eligibility gate that needs NO model call. When present and it returns not-ok, the beat stands down BEFORE the
     //   leash is spent (the cold-leash fix) — a stand-down that no model call could have avoided must not cost budget.
     //   Absent/undefined → treated as ok (NS-1 behavior: spend at accept-time, the pipeline decides). See applyTick.
     deps.beat({ agentId, signal }) -> Promise<{ delivered, reason, title?, archetype? }>   // the ported act pipeline
     deps.newAbort()                 -> AbortController
     deps.now()                      -> int ms           // wall clock for beat-COMPLETION timestamps
     deps.ledger(entry)              -> void             // append one decision record (NS-0 ledger; a thin helper)
     deps.emit(name, payload)        -> void             // OPTIONAL: a validated emitter for a status pulse (no-op default)
     deps.agentId                    -> string           // the agent the night shift acts as (default 'agent')
     deps.awayThresholdMs, deps.beatIntervalMs -> int    // the knobs (env-tunable + a dev override in index.js)
     deps.declineRepeatMs            -> int              // OPTIONAL: re-log an UNCHANGED decline at most this often (1h)

   EDGE-TRIGGERED DECLINES (2026-10-05 audit item 5): the tick runs every ~60s and used to ledger a 'decline' EVERY
   tick — 3,111 of 3,168 live ledger rows were the same "daily limit used up", which pushed every real decision out
   of the morning report's newest-200 window. A decline is now ledgered only when its reason (binding + preSpend)
   CHANGES from the previous tick's, or once per declineRepeatMs while it holds. Nothing the status panel needs is
   lost: status reads the LIVE decision (statusDecision), never the ledger, and each logged decline carries
   heldTicks/heldBinding — how many identical ticks the PREVIOUS logged reason held for after it was written.

   ONE BEAT AT A TIME: a beat runs asynchronously (the model calls take seconds); `beatRunning` guards re-entry so
   a second tick during an in-flight beat is a clean no-op (like cron's per-job lease, but there is exactly ONE
   night-shift worker). The leash counter is incremented + persisted the moment a beat is ACCEPTED to fire (before
   the async pipeline resolves), so a crash mid-beat cannot lose the accounting and re-fire on restart. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./nightshift.js') : (root.SK && root.SK.nightshift));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).nightshiftDriver = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nightshift) {
  'use strict';

  function makeNightshiftDriver(deps) {
    const d = deps || {};
    const getState = d.getState, setState = d.setState;
    const getPosture = typeof d.getPosture === 'function' ? d.getPosture : function () { return null; };
    const lastActivity = typeof d.lastActivity === 'function' ? d.lastActivity : function () { return 0; };
    const isHalted = typeof d.isHalted === 'function' ? d.isHalted : function () { return false; };
    const concurrencyFree = typeof d.concurrencyFree === 'function' ? d.concurrencyFree : function () { return true; };
    const precheck = typeof d.precheck === 'function' ? d.precheck : null;   // NS-2: optional pre-spend local gate
    const beat = d.beat;
    const newAbort = typeof d.newAbort === 'function' ? d.newAbort : function () { return { signal: null, abort: function () {} }; };
    const now = typeof d.now === 'function' ? d.now : function () { return 0; };
    const ledger = typeof d.ledger === 'function' ? d.ledger : function () {};
    const emit = typeof d.emit === 'function' ? d.emit : function () {};
    const agentId = String(d.agentId || 'agent');
    const awayThresholdMs = d.awayThresholdMs;
    const beatIntervalMs = d.beatIntervalMs;
    const declineRepeatMs = Number.isFinite(d.declineRepeatMs) && d.declineRepeatMs >= 0 ? d.declineRepeatMs : 3600000;
    if (typeof getState !== 'function' || typeof setState !== 'function') throw new Error('nightshift-driver: getState/setState are required');
    if (typeof beat !== 'function') throw new Error('nightshift-driver: beat is required');

    let beatRunning = false;               // the one-beat-at-a-time guard (a beat's model calls take seconds)
    let currentAbort = null;               // the in-flight beat's AbortController (for the E-STOP hook)
    let lastDecline = null;                // { key, binding, at, held } — the last LOGGED decline (edge-trigger memory)

    // ledger a decline iff its reason changed since the last logged one, or the same reason has held for
    // declineRepeatMs. Returns true when written. A suppressed tick only counts toward the held tally.
    function logDecline(nowMs, entry, force) {
      const key = String(entry.binding) + '|' + (entry.preSpend ? 1 : 0);
      const fresh = force || !lastDecline || lastDecline.key !== key || !(nowMs >= lastDecline.at) || (nowMs - lastDecline.at) >= declineRepeatMs;
      if (!fresh) { lastDecline.held += 1; return false; }
      const out = Object.assign({}, entry);
      if (lastDecline && lastDecline.held > 0) { out.heldTicks = lastDecline.held; out.heldBinding = lastDecline.binding; }
      try { ledger(out); } catch (_) {}
      lastDecline = { key: key, binding: entry.binding, at: nowMs, held: 0 };
      return true;
    }

    // gather the live gate inputs the pure planner needs (posture booleans + the knobs + presence + halt).
    function gather(nowMs) {
      const posture = getPosture() || {};
      return {
        now: nowMs,
        lastUserActivityAt: Number(lastActivity()) || 0,
        actsUnattended: !!posture.actsUnattended,
        leashPerDay: Number.isFinite(posture.leashPerDay) ? posture.leashPerDay : (posture.leashPerDay != null ? Number(posture.leashPerDay) : NaN),
        halted: !!isHalted(),
        concurrencyFree: concurrencyFree(agentId) !== false,
        awayThresholdMs: awayThresholdMs, beatIntervalMs: beatIntervalMs
      };
    }

    // the pure decision over the live inputs (side-effect free — the test asserts it directly through decide()).
    function decideNow(nowMs) {
      const rolled = nightshift.rollDay(getState(), nowMs);
      return nightshift.decide(rolled, gather(nowMs));
    }

    // decideNow + the pre-spend readiness precheck folded in, for the STATUS route: when the pure gates clear but the
    // local precheck says the beat couldn't reach a model call, report binding:'readiness' (the pre-spend stand-down)
    // so status == what the tick would actually do. Side-effect free (the precheck must be a pure read). No precheck →
    // identical to decideNow. Never throws; a precheck hiccup binds `precheck-error` and stands down safely.
    function statusDecision(nowMs) {
      const decision = decideNow(nowMs);
      if (!decision.fire || !precheck) return decision;
      try {
        const pr = precheck({ agentId: agentId });
        const notOk = (pr === false) || (pr && typeof pr === 'object' && pr.ok === false);
        if (notOk) {
          const reason = (pr && typeof pr === 'object' && pr.reason) ? String(pr.reason) : 'readiness';
          return Object.assign({}, decision, { fire: false, binding: reason || 'readiness' });
        }
      } catch (_) {
        return Object.assign({}, decision, { fire: false, binding: 'precheck-error' });
      }
      return decision;
    }

    /* applyTick — ONE night-shift pass at wall-clock `nowMs`. Synchronous decision; if a beat is accepted it is
       launched (settles later) and the accounting is persisted IMMEDIATELY. Returns a small summary. Never throws
       (the host also wraps it, but each step is guarded). A tick during an in-flight beat is a no-op. */
    function applyTick(nowMs) {
      nowMs = Number.isFinite(nowMs) ? nowMs : now();

      // DAY ROLLOVER always runs (even when a beat can't fire) so the persisted counter is correct the instant a
      // new day begins — otherwise a status read at 00:01 would show yesterday's spent leash until the first fire.
      try {
        const rolled = nightshift.rollDay(getState(), nowMs);
        const cur = getState() || {};
        if (rolled.day !== cur.day || rolled.beatsUsedToday !== cur.beatsUsedToday) setState(rolled);
      } catch (_) { /* a persist hiccup must never wedge the tick */ }

      if (beatRunning) return { fired: false, binding: 'in-flight', decision: null };

      const decision = decideNow(nowMs);

      // COLD-LEASH FIX (NS-2). The pure gates (posture/present/halt/leash/cooldown/concurrency) cleared, so a beat
      // WOULD fire. But before spending a leash unit, ask the optional PURELY-LOCAL precheck whether this beat could
      // even reach a model call — the readiness/eligibility conditions the act pipeline itself checks with NO model
      // call (dossier+activity too thin → tier not hot, no eligible archetypes, no grounding). If it can't, standing
      // down here is FREE work: no model call, no draft, nothing the budget bought. So we DECLINE WITHOUT SPENDING —
      // binding 'readiness' — instead of NS-1's wart where the unit was burned on a stand-down needing no model call.
      // Anything that PASSES the precheck still spends at accept-time below (a beat that reached a model call and then
      // stood down DID cost the budget — the anti-runaway guarantee stays intact). Absent precheck → always ok.
      let preOk = true, preReason = 'readiness';
      if (decision.fire && precheck) {
        try { const pr = precheck({ agentId: agentId }); if (pr === false) { preOk = false; } else if (pr && typeof pr === 'object' && pr.ok === false) { preOk = false; preReason = String(pr.reason || 'readiness') || 'readiness'; } }
        catch (_) {
          // An unreadable safety gate is not permission for unattended work. Stand down without spending and
          // expose the failure through status + ledger so the next tick can retry it honestly.
          preOk = false;
          preReason = 'precheck-error';
        }
      }
      const fireNow = decision.fire && preOk;
      const binding = decision.fire ? (preOk ? null : preReason) : decision.binding;

      // record EVERY tick's decision — acted, or declined-with-which-gate-bound (the honest decision trail). A
      // pre-spend readiness stand-down is an honest 'decline' with binding:'readiness' (the new pre-spend decline kind).
      // Declines are final now, so ledger them immediately. A would-be beat is ledgered ONLY after its durable
      // leash/accounting write succeeds below; otherwise the morning report would claim an unaccounted act.
      if (!fireNow) {
        logDecline(nowMs, { ts: nowMs, kind: 'decline', binding: binding, agentId: agentId, beatsLeft: decision.beatsLeft, away: decision.away, preSpend: (decision.fire && !preOk) || undefined });
        return { fired: false, binding: binding, decision: decision };
      }

      // ACCEPT the beat: increment the leash + stamp lastBeatAt and PERSIST NOW (before the async pipeline
      // resolves), so a crash mid-beat cannot both spend nothing and re-fire on restart. This is the leash's
      // server-enforcement point. We are past the precheck, so this beat WILL reach a model call — spending here is
      // correct even if the pipeline then stands down (that stand-down cost a model call; anti-runaway holds).
      try { setState(nightshift.recordBeat(getState(), nowMs)); }
      catch (e) {
        logDecline(nowMs, { ts: nowMs, kind: 'decline', binding: 'persist-failed', agentId: agentId, beatsLeft: decision.beatsLeft, away: decision.away, preSpend: true }, true);
        return { fired: false, binding: 'persist-failed', decision: decision };
      }
      const beatEntry = { ts: nowMs, kind: 'beat', binding: null, agentId: agentId, beatsLeft: decision.beatsLeft, away: decision.away };
      if (lastDecline && lastDecline.held > 0) { beatEntry.heldTicks = lastDecline.held; beatEntry.heldBinding = lastDecline.binding; }
      lastDecline = null;   // a beat breaks the decline run: the next decline (e.g. cooldown) is a NEW edge and logs
      try { ledger(beatEntry); } catch (_) {}

      beatRunning = true;
      const ac = newAbort();
      currentAbort = ac;
      // NOTE: no bus event is emitted here. `nightshift.beat`/`.outcome` are NOT in the frozen event registry
      // (shared/events.js is owned + additive-only), and a war-room pulse is optional. The full decision trail
      // lives in the LEDGER (above) + GET /api/nightshift/status — the truthful-telemetry surfaces this lane owns.

      let p;
      try { p = beat({ agentId: agentId, signal: ac && ac.signal }); }
      catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(
        function (r) { finishBeat(r || {}, null); },
        function (e) { finishBeat(null, e || new Error('beat rejected')); }
      );
      return { fired: true, binding: null, decision: decision };
    }

    // record the outcome of a fired beat once it settles. The leash was already spent at accept-time (correct:
    // an autonomous ATTEMPT consumed the budget even if the pipeline stood down with no draft — that is the
    // anti-runaway guarantee; a stood-down beat still cost a model call or two). We only clear the guard + log.
    function finishBeat(result, threw) {
      beatRunning = false;
      currentAbort = null;
      const at = now();
      const delivered = !!(result && result.delivered);
      const reason = threw ? ('error: ' + ((threw && threw.message) || threw)) : (result && result.reason) || (delivered ? 'delivered' : 'stood-down');
      try { ledger({ ts: at, kind: 'outcome', agentId: agentId, delivered: delivered, reason: reason, title: (result && result.title) || null, archetype: (result && result.archetype) || null, runId: (result && result.runId) || null, artifactPaths: (result && result.artifactPaths) || null }); } catch (_) {}
    }

    // abortBeat — the E-STOP hook: abort an in-flight beat's run so a HALT stops unattended night-shift spend too.
    // The beat settles through finishBeat (guard cleared) either way. Never throws. Returns 1 if a beat was aborted.
    function abortBeat() {
      let n = 0;
      try { if (currentAbort && typeof currentAbort.abort === 'function') { currentAbort.abort(); n = 1; } } catch (_) {}
      return n;
    }

    return {
      applyTick: applyTick,
      decideNow: decideNow,
      statusDecision: statusDecision,
      runInFlight: function () { return beatRunning; },
      abortBeat: abortBeat,
      _internals: { finishBeat: finishBeat, gather: gather, lastDecline: function () { return lastDecline ? Object.assign({}, lastDecline) : null; } }
    };
  }

  return { makeNightshiftDriver: makeNightshiftDriver };
});
