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

   ATTACHMENT DECAY (attachment-rows-and-taint, 2026-11-04). The one exception to "tainted rows keep tainting" is the
   attachment's own stamp. A Commander's attachment taints a run for as long as its BYTES are in the run's context: the
   host latches taint.js ATTACHMENT_TAINT ('user attachment') exactly when attachments.expandForRun re-sent bytes
   (attachments.resentOf), which is the attaching turn and one follow-up, and never merely because a reference rode
   along in the browser's history. Rows that run writes carry the same stamp, but a row stamped with EXACTLY that string
   no longer taints a replay (transcriptStore.taintOf, EarlierConversation.taintOf): the bytes it stood for are either
   re-sent, and then the replaying run latches them again itself, or gone. Four things keep it from becoming a launder:
     - only the exact constant decays; every other stamp, an unknown one, and a legacy one with other words, still taints;
     - the stamp is the FIRST NON-ATTACHMENT source a run met (run-execution-state rowTaint): a run that held the
       attachment and then read a page, a connector or the saved file stamps its rows with that, which persists, and the
       run journal records it so a recovery continuation restores it instead of the bare attachment;
     - the bytes themselves always latch: re-sent ones, a tool re-read of .attachments/ (fs.read, fs.search,
       image_analyze, and a shell command or script that names the folder: a PDF reaches the model that way), a recalled
       row, a recovery continuation;
     - a row that STORES the expansion still taints when the replay is that very row, because replaying it replays the
       text. Two shapes (taint.js rowStoresAttachmentText): references kept with a content other than the typed words
       (11-02 up to this change), and, in 0.14.2 and every release before it, no references and no typed field at all, the
       "[Attached file: " header attachments.js writes sitting in the content. A row whose content is the typed words decays.
   What decays is only the model's own replies, written while the bytes were in front of it, once the bytes are gone. That
   residual (hostile file text steering turns 1-2, carried into turn 3 by the model's own earlier replies) is the price
   of a conversation that is clean again from the third turn; docs/DECISIONS.md records it.
   THE ROWS OF A TURN WITH FILES (S3, sidecar/turn-attachment.js). The Commander's directive row holds the typed words and is
   written clean, so the 11-02 shape above is no longer written, and each file is a role-system 'attachment' row beside it
   stamped with the bare source (a name, a path, a size and a hash: no bytes, nothing to replay, recallable by name). Readers
   show a row that kept files as its typed words plus '[attached: name]' (earlier-conversation, recall_conversation), so the
   file text of an 11-02 row reaches the model neither through the earlier-conversation note nor through a recall; only a
   server seed that replays the stored text of the 11-02 or 0.14.2 shape itself still carries bytes, and still taints.

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

/* UNVERIFIED ≠ READ. The fail-closed reasons (the unreadable journal above, and index.js's fixed 'replayed context
   (taint check failed)' latch) prove only that the earlier context could not be checked — never that outside content
   was in it. The lock stays; the refusal must say "could not verify", not "outside content was there". Matched
   anywhere in the reason, so a chained replay of such a run ('replayed history (tainted by …taint check failed)')
   keeps telling the same truth. */
function isUnverifiedTaint(reason) {
  return /taint unverifiable|taint check failed/.test(String(reason == null ? '' : reason));
}

module.exports = { makeReplayedTaint, isUnverifiedTaint };
