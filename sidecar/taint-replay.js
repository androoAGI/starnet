/* sidecar/taint-replay.js — REPLAYED TAINT: does the context a run starts from carry untrusted content an EARLIER
   run read? (sec-taint 09-25)

   Taint (taint.js) is a property of a run's CONTEXT: once a web page, connector result or attachment has been in
   front of the model, the powers that content would need are revoked for the rest of the run. But context outlives
   a run. A recovery continuation replays its source's journaled checkpoint; an ordinary follow-up turn replays the
   stream's durable transcript (transcriptstore reconstruct / queued refresh) or the browser's own copy of it. Each
   of those used to start a fresh, UNTAINTED run in front of the very same hostile bytes.

   Two proofs, one per replay kind:
     - recovery continuation: the SOURCE run's journal records its taint (begin meta `initialTaint`, or a mid-run
       'taint' record) — run-journal.js state.taintedBy.
     - any run on a stream: the transcript rows carry the writing run's taint (transcriptstore.taintOf: identity
       match against the replayed messages, plus the replayed window of newest rows).
   The new directive (the last message) is excluded for an ordinary run: its own provenance is the caller's
   initialTaint (channel attachment / forwarded message / upstream agent output ...).

   DECAY is structural, never silent. There is no owner "clear taint" control: a run is clean again only when the
   tainted material is no longer in what it replays (a new session, or a history window that no longer reaches the
   tainted rows) — i.e. exactly when the untrusted text has actually left the context.

   UNPROVABLE = TAINTED. A source journal that cannot be read answers "taint unverifiable" (the same narrowing
   index.js recoverySourceEntryUntrusted applies to the same read); the transcript proof still runs, so a concrete
   source wins over the unverifiable reason. The caller latches a fixed reason when the proof itself throws.

   Pure given its injected stores: makeReplayedTaint({ journal, transcript }) -> ({ recovery, streamId, msgs }) ->
   reason string | null. */
'use strict';

function makeReplayedTaint(deps) {
  const journal = deps && deps.journal;
  const transcript = deps && deps.transcript;
  return function replayedTaint(o) {
    o = o || {};
    const msgs = Array.isArray(o.msgs) ? o.msgs : [];
    let journalUnreadable = '';
    if (o.recovery && o.recovery.sourceRunId && journal && typeof journal.inspect === 'function') {
      let st = null;
      try { st = journal.inspect(String(o.recovery.sourceRunId)); }
      catch (e) { journalUnreadable = 'resumed run (taint unverifiable: run journal unreadable' + (e && e.code ? ' ' + String(e.code).slice(0, 16) : '') + ')'; }
      if (st && st.taintedBy) return 'resumed run (tainted by ' + String(st.taintedBy).slice(0, 120) + ')';
    }
    if (!o.streamId || !transcript || typeof transcript.taintOf !== 'function') return journalUnreadable || null;
    const prior = (o.recovery ? msgs : msgs.slice(0, -1)).filter(m => m && m.role !== 'system');
    if (!prior.length) return journalUnreadable || null;
    const hit = transcript.taintOf(o.streamId, prior);
    return hit ? 'replayed history (tainted by ' + String(hit).slice(0, 120) + ')' : (journalUnreadable || null);
  };
}

module.exports = { makeReplayedTaint };
