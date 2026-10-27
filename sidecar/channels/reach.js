/* sidecar/channels/reach.js — the ONE answer to "can a message go out on this channel RIGHT NOW?" for every send that
   leaves the station outside a hub's own reply path: the agent's channel.send / its file upload, a routine's chat
   delivery, the autonomous notifier's ping, and the agent's channel.targets list.

   WHY ONE GATE (quick win 22, bug a199ee3c's family): a live HANDLE is not reachability. The handle is nulled only by an
   explicit teardown, so a revoked token, a Discord 4004 or a second poller stealing the token breaks the poll loop and
   leaves the object alive — the adapter reports { state: 'error' } and that status is the only record. channel.targets
   was fixed to read the status; the sends beside it kept checking the handle alone and spent a doomed transport call
   (or a routine delivery's retry) on a channel the panel was showing as errored. Each copy of "is it connected?" was a
   place to disagree; this module is the one question.

     makeChannelReach({ liveChannelFor, channelLiveHealth }) -> { reach(channel) }
     reach(channel) -> { ok: true, live } | { ok: false, live|null, error }   never throws

   `live` is liveChannelFor's { adapter, hub }; `channelLiveHealth(channel)` is the status object whose `connected`
   already requires state 'up' AND a live handle (index.js). */
'use strict';

function makeChannelReach(deps) {
  const d = deps || {};
  if (typeof d.liveChannelFor !== 'function' || typeof d.channelLiveHealth !== 'function') {
    throw new Error('makeChannelReach: liveChannelFor and channelLiveHealth are required');
  }
  function reach(channel) {
    const name = String(channel || 'telegram');
    let live = null;
    try { live = d.liveChannelFor(channel) || null; } catch (_) { live = null; }
    if (!(live && live.adapter)) return { ok: false, live: null, error: name + ' is not connected' };
    let health = null;
    try { health = d.channelLiveHealth(channel) || null; } catch (_) { health = null; }
    if (!(health && health.connected === true)) {
      const state = health && health.state ? String(health.state) : 'down';
      return { ok: false, live: live, error: name + ' is not connected right now (' + state + ')' };
    }
    return { ok: true, live: live };
  }
  return { reach };
}

module.exports = { makeChannelReach };
