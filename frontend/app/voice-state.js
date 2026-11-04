/* STARNET — voice-state.js : what a spoken reply and the speaker ARE, as data (no audio, no DOM, no timers).

   A spoken reply is a HANDLE from the moment a turn is sent to the moment its last sentence ends. voice.js used to name
   the reply by a global counter that every teardown bumped, so ANY stop between a send and its first chunk dropped the
   whole reply with no record. This module owns the reply's lifecycle instead; voice.js owns the audio.

     replies(record)  one registry per Voice. open() a reply, offer() it each chunk, queue() the jobs a chunk became,
                      played() each one that left the speech queue, close() it when the producer is done, done() once
                      it is closed and drained, or cancel(cause). live() is the snapshot of replies not yet ended.
                      Typed events go through the injected record(reason, details), never with the reply's words:
                        reply_cancelled{reply, owner, cause, audible, queued}   once per cancelled reply
                        dropped_after_cancel{reply, cause, characters}          every chunk offered to a reply that is no
                                                                                longer open; a chunk with no reply at all
                                                                                is {reply: null, cause: 'no_reply'}
     CANCEL_CAUSES    the ONE closed vocabulary of why a reply ended early. A cause outside it is recorded as user_stop.

   States: open (taking chunks) -> closed (the producer is done) -> done (its last queued chunk left the queue), or
   cancelled{cause} from open or closed. Every reply reaches exactly ONE terminal state, and beat(r) answers true exactly
   once after it, so voice.js fires each reply's heartbeat once — a cancel included. A reply is AUDIBLE once a chunk of
   it is queued and stays so until it ends (what talking() and isReplyPending() mean); before that it is PENDING.

   The handle a producer holds is a read-only view {id, owner, agentId, state, audible, cause}. voice.js keeps its own
   per-reply synthesis pins (voice, effect chain, fail streak) on the record; this module never reads them.

     speaker(opts)    does the station speak its replies? pref is the Commander's own choice, the ONLY thing ever saved
                      (opts.key in opts.storage(), the '1'/'0' shape every build reads; absent is off). leases are the
                      sessions holding it on while they run (SPEAKER_LEASES: a room you talk to has to answer), memory
                      only, so a page that dies mid-call comes back to the last choice the Commander made. on = pref ||
                      a lease. apply(next) is its one transition: {pref} an explicit choice (saved; it ends every lease,
                      so no session's end can undo it), {lease: owner} / {release: owner} one session's hold. It answers
                      {was, on, explicit, changed}; the effects of a change are voice.js's. This is the key's one writer.
   UMD like diagnostics.js: the page gets a VoiceState global (loaded right before voice.js); node tests require it. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CANCEL_CAUSES = Object.freeze([
    'microphone_activity',   // the Commander started speaking over the call (Live VAD onset)
    'microphone_button',     // the mic button or the Live meter pressed to cut in
    'listen_start',          // a listen opened while the agent was talking
    'user_stop',             // asked to stop ('stop', 'stop speaking'), or a stop that named no cause
    'superseded',            // a new Live turn started a run that replaces this reply
    'session_rebind',        // the call moved to another session; this reply belonged to the old one
    'speaker_off',           // the speaker was turned off
    'call_end',              // the Live call ended
    'live_start',            // Local Live opened over a legacy hands-free loop
    'live_start_failed',     // Local Live failed to start
    'handsfree_off',         // the legacy hands-free loop was left
    'mic_denied',            // the microphone was refused
    'disconnect',            // DISCONNECT
    'voice_off',             // /voice off
    'session_init',          // Voice.init: another agent took the voice
    'provider_voice',        // the provider's own realtime voice took over
    'playback_blocked',      // the browser refused to play audio: every later sentence would fail too
    'no_reply'               // a chunk arrived with no open reply to take it
  ]);
  const isCancelCause = cause => CANCEL_CAUSES.indexOf(cause) >= 0;

  function replies(record) {
    const say = typeof record === 'function' ? record : function () {};
    const records = new WeakMap();   // handle -> record: a forged or foreign object is no reply
    let live = [];                   // records not yet ended, oldest first
    let lastId = 0;
    const ended = r => r.state === 'done' || r.state === 'cancelled';
    const retire = r => { live = live.filter(x => x !== r); };

    function open(opts) {
      opts = opts || {};
      const r = { id: ++lastId, owner: opts.owner == null ? null : opts.owner, agentId: opts.agentId == null ? '' : String(opts.agentId),
        state: 'open', audible: false, cause: '', queued: 0, beat: false, handle: null };
      r.handle = Object.freeze({
        get id() { return r.id; }, get owner() { return r.owner; }, get agentId() { return r.agentId; },
        get state() { return r.state; }, get audible() { return r.audible; }, get cause() { return r.cause; }
      });
      records.set(r.handle, r);
      live.push(r);
      return r;
    }
    const of = handle => (handle && typeof handle === 'object' && records.get(handle)) || null;
    // A chunk offered to r: true when r is open and takes it. Otherwise the chunk is DROPPED, typed — never in silence.
    function offer(r, text) {
      if (r && r.state === 'open') return true;
      const s = String(text == null ? '' : text);
      if (s.trim()) say('dropped_after_cancel', { reply: r ? r.id : null, cause: r && r.state === 'cancelled' ? r.cause : 'no_reply', characters: s.length });
      return false;
    }
    function queue(r, jobs) { r.audible = true; r.queued += jobs; }   // jobs joined the speech queue: AUDIBLE until it ends
    function played(r) { if (r.queued > 0) r.queued--; }              // one job of r left the queue (spoken or skipped)
    function close(r) { if (!r || r.state !== 'open') return false; r.state = 'closed'; return true; }
    // closed and drained: the reply has said everything it will say
    function done(r) { if (!r || r.state !== 'closed' || r.queued > 0) return false; r.state = 'done'; retire(r); return true; }
    function cancel(r, cause) {
      if (!r || ended(r)) return false;
      r.state = 'cancelled'; r.cause = isCancelCause(cause) ? cause : 'user_stop';
      say('reply_cancelled', { reply: r.id, owner: r.owner, cause: r.cause, audible: r.audible, queued: r.queued });
      r.queued = 0; retire(r);
      return true;
    }
    // true exactly once per reply, after it ended: the caller fires its heartbeat then, and never again
    function beat(r) { if (!r || r.beat || !ended(r)) return false; r.beat = true; return true; }
    return {
      open, of, offer, queue, played, close, done, cancel, beat,
      live: () => live.slice(),
      audible: () => live.some(r => r.audible)
    };
  }

  const SPEAKER_LEASES = Object.freeze(['handsfree', 'live']);   // the legacy hands-free loop, a Local Live call
  function speaker(opts) {
    opts = opts || {};
    let pref = false;
    try { pref = opts.storage().getItem(opts.key) === '1'; } catch (_) {}   // blocked storage reads as a first visit: off
    const leases = new Set();
    const on = () => pref || leases.size > 0;
    function apply(next) {
      next = next || {};
      const was = on(), explicit = typeof next.pref === 'boolean';
      if (explicit) {
        pref = next.pref; leases.clear();
        try { opts.storage().setItem(opts.key, pref ? '1' : '0'); } catch (_) {}   // unsaved, the choice still holds for this page
      } else if (SPEAKER_LEASES.indexOf(next.lease) >= 0) leases.add(next.lease);
      else if (SPEAKER_LEASES.indexOf(next.release) >= 0) leases.delete(next.release);
      return { was, on: on(), explicit, changed: was !== on() };
    }
    return { apply, isOn: on, state: () => ({ pref, leases: Array.from(leases), on: on() }) };
  }

  return { CANCEL_CAUSES, isCancelCause, replies, SPEAKER_LEASES, speaker };
});
