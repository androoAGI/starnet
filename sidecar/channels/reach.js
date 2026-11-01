/* sidecar/channels/reach.js — the ONE answer to "can a message go out on this channel RIGHT NOW?" for every send that
   leaves the station outside a hub's own reply path: the agent's channel.send / its file upload, a routine's chat
   delivery, the autonomous notifier's ping, a sign-in hand-off's nudge, a loop's stop notice, and the agent's
   channel.targets list (with the routine preflight).

   WHY ONE GATE (quick win 22, bug a199ee3c's family): a live HANDLE is not reachability. The handle is nulled only by an
   explicit teardown, so a revoked token, a Discord 4004 or a second poller stealing the token breaks the poll loop and
   leaves the object alive — the adapter reports { state: 'error' } and that status is the only record. channel.targets
   was fixed to read the status; the sends beside it kept checking the handle alone and spent a doomed transport call
   (or a routine delivery's retry) on a channel the panel was showing as errored. Each copy of "is it connected?" was a
   place to disagree; this module is the one question.

     makeChannelReach({ liveChannelFor, channelLiveHealth }) -> { reach(channel, opts?) }
     reach(channel)                    -> { ok: true, live, proven: true } | { ok: false, live|null, error }   never throws
     reach(channel, { attempt: true }) -> the same, and ALSO { ok: true, live, proven: false } while 'connecting'

   TWO QUESTIONS, ONE ANSWER (review of quick win 22): a CLAIM ("this chat is reachable" on channel.targets, the routine
   preflight's "connected and healthy") needs PROOF — state 'up'. A SEND ATTEMPT needs only that nothing has gone wrong:
   'connecting' is the window between a start and the first proven round trip (a Telegram long poll can hold it ~50 s
   after every boot or re-pair), no failure is known in it, and refusing there turned a likely delivery into a certain
   failure — a notifier ping lost, a routine delivery failed. A send in that window is attempted and its own SendResult is
   the truth; 'error' and 'down' (a failure the adapter actually saw) are still refused before any transport call.

   `live` is liveChannelFor's { adapter, hub }; `channelLiveHealth(channel)` is the status object whose `connected`
   already requires state 'up' AND a live handle (index.js). */
'use strict';

function makeChannelReach(deps) {
  const d = deps || {};
  if (typeof d.liveChannelFor !== 'function' || typeof d.channelLiveHealth !== 'function') {
    throw new Error('makeChannelReach: liveChannelFor and channelLiveHealth are required');
  }
  function reach(channel, opts) {
    const name = String(channel || 'telegram');
    const attempt = !!(opts && opts.attempt === true);
    let live = null;
    try { live = d.liveChannelFor(channel) || null; } catch (_) { live = null; }
    if (!(live && live.adapter)) return { ok: false, live: null, error: name + ' is not connected' };
    let health = null;
    try { health = d.channelLiveHealth(channel) || null; } catch (_) { health = null; }
    if (health && health.connected === true) return { ok: true, live: live, proven: true };
    const state = health && health.state ? String(health.state) : 'down';
    if (attempt && state === 'connecting') return { ok: true, live: live, proven: false };
    return { ok: false, live: live, error: name + ' is not connected right now (' + state + ')' };
  }
  return { reach };
}

module.exports = { makeChannelReach };
