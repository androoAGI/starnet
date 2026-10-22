/* AGENT OS — consentwait.js : the fail-closed, human-extendable consent waiter behind askHuman.

   EL-11 FIX 1c. The live consent channel await-pauses a run until a human answers a permission.prompt.
   The original inline timer auto-DENIED after CONSENT_TIMEOUT_MS unconditionally — correct for UNATTENDED
   surfaces (no browser, dead tab, silent Telegram: a forgotten prompt must never hold a run open), but a
   consent violation for a prompt that existed only on a NON-displayed session: it was denied before any
   human could possibly have seen it.

   The contract here keeps the unattended intent byte-identical and adds exactly one thing:
     · no ack        → auto-deny at timeoutMs (unchanged fail-closed floor);
     · finish.extend() — called via POST /api/consent/ack ONLY after the browser has actually RENDERED the
       prompt to a human (active consent card, or the global background toast + rail marker) — re-arms the
       deny deadline ONCE to extendMs. One-shot and bounded: an AFK human still fail-closes; never indefinite;
     · abort (disconnect) → instant deny, extension or not;
     · settles exactly once, always cleans up its map entry + timer.

   Pure + injected deps (map, signal, clock, uuid, emit) so the timing semantics are unit-testable with fake
   timers (test/consentwait.test.js) — the REAL sidecar path rides this exact module, not a copy. */
'use strict';
const { note } = require('./failopen.js');   // a failing auto-deny announcer is noted, never silent

function makeConsentWait(deps) {
  const pending = deps.pending;                 // Map: promptId -> finish(decision) (handleConsent's lookup)
  const signal = deps.signal;                   // the run's AbortController signal (disconnect → deny)
  const timeoutMs = deps.timeoutMs;             // the fail-closed floor (CONSENT_TIMEOUT_MS)
  const extendMs = deps.extendMs;               // the one-shot human-visible bound (CONSENT_ACK_EXTEND_MS)
  const uuid = deps.uuid;
  const setT = deps.setTimeoutFn || setTimeout;
  const clearT = deps.clearTimeoutFn || clearTimeout;
  const emitPrompt = deps.emitPrompt;           // (promptId) => emit the permission.prompt event
  // (promptId) => tell the run's surfaces nobody answered: a timeout or a dropped run fail-closes to deny, and the page's
  // card / CREW frame must not keep asking a question the run already stopped waiting on (sweep 2026-10-02). Its second
  // argument says which: true = the timer expired (nobody answered), false = the asker's signal aborted (it was stopped)
  const onAutoDeny = typeof deps.onAutoDeny === 'function' ? deps.onAutoDeny : null;
  /* TIMEOUT IS NOT A NO (2026-10-11). An unanswered prompt still fail-closes, but a caller may ask for the timer's
     expiry to resolve with its OWN decision word (channels pass 'timeout'; the broker maps it to a distinct denial the
     model reads as "nobody answered", never "the Commander declined") and to hear about it (onTimeout -> the chat is
     told the action did not run). An abort/disconnect stays a plain 'deny'. Absent = byte-identical to before. */
  const timeoutDecision = typeof deps.timeoutDecision === 'string' && deps.timeoutDecision ? deps.timeoutDecision : 'deny';
  /* A WITHDRAWN ASK IS NOT A NO EITHER (review 10-14). An abort (the run stopped, the page went away) or a prompt never shown
     resolves with the caller's abortDecision when it names one — the capability consent passes 'cancelled', which the broker
     keeps CLOSED but marks withdrawn, so a worker whose ask died with its run never tells the Commander "you declined".
     The finisher carries it (finish.abortDecision) for the host's own teardown. Absent = a plain 'deny', as before. */
  const abortDecision = typeof deps.abortDecision === 'string' && deps.abortDecision ? deps.abortDecision : 'deny';
  const onTimeout = typeof deps.onTimeout === 'function' ? deps.onTimeout : null;

  // ask() returns a Promise<decision string>; the registered finisher carries .extend() for the ack route.
  function ask() {
    return new Promise((resolve) => {
      const promptId = uuid();
      let settled = false, timer = null, extended = false;
      function onAbort() { autoDeny(false); }
      function onTimer() { autoDeny(true); }
      function autoDeny(expired) {
        if (settled) return;
        finish(expired ? timeoutDecision : abortDecision);
        if (onAutoDeny) { try { onAutoDeny(promptId, expired === true); } catch (e) { note('consent.autoDeny', e); } }
        if (expired && onTimeout) { try { onTimeout(promptId); } catch (e) { note('consent.onTimeout', e); } }
      }
      function finish(decision) {
        if (settled) return; settled = true;
        pending.delete(promptId);
        if (timer) clearT(timer);
        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
        resolve(decision);
      }
      // the ack: a human surface provably rendered this prompt → one bounded extension of the deny deadline.
      finish.extend = function () {
        if (settled || extended) return false;
        extended = true;
        if (timer) clearT(timer);
        timer = setT(onTimer, extendMs);
        return true;
      };
      finish.abortDecision = abortDecision;
      pending.set(promptId, finish);
      if (signal.aborted) return finish(abortDecision);   // never shown: nothing to retract
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setT(onTimer, timeoutMs);
      emitPrompt(promptId);
    });
  }
  return { ask };
}

module.exports = { makeConsentWait };
