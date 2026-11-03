/* sidecar/autonotify.js — autonomy B4: ping the Commander over a connected channel (Telegram/Discord) when an
   AUTONOMOUS (cron) run PRODUCES WORK. Opt-in + anti-spam: ONLY a clean 'ok' outcome pings — a 'silent' run (the
   routine decided there was nothing to report; the autonomous persona carries a [SILENT] hint) or a 'failed' run
   never does. Pure + injected-deps (no IO / clock / rng) → node-testable; index.js wires the live channel send +
   the chat→agent map + the cron jobs into it.

   makeAutoNotifier({ send, chatsFor, jobName, jobAgent }) -> { onEvent(name, payload) }
     send(chatId, text, channel, about) -> Promise   // the live channel send (routed by channel); outcome -> onDelivery.
                                              // about = { jobId, runId, agentId }: whose result this ping reports
     onDelivery(jobId, {ok,error?,channel?})  // OPTIONAL per-send outcome report (durable delivery record)
     chatsFor(agentId) -> [{chatId, channel}]  // the agent's CONNECTED chats ([] if none OR opt-in off → no ping)
     jobName(jobId)    -> string               // the routine's display name (for the message)
     jobAgent(jobId)   -> agentId | null       // map a cron.result back to its agent (cron.result carries none)

   It watches ONE event: 'cron.result' {jobId,runId,outcome}. On 'ok' it composes a one-line summary (the routine
   name) and SENDS it to the agent's opted-in chats. It deliberately does NOT correlate the per-file 'deliverable'
   events: that event carries no runId, so per-run file attribution is UNSOUND under concurrent same-agent jobs
   (it would send one job's files under another's name). The honest, race-free signal is "the routine ran and
   produced a result" — outcome 'ok' (not the [SILENT] marker, not a failure). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).autonotify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the message body — honest + compact. Names the routine. Pure (the live `redact` scrub is applied at send).
  function composeMessage(name) {
    const n = String(name == null ? '' : name).trim() || 'a routine';
    return '✦ "' + n + '" ran on its own.';
  }

  function makeAutoNotifier(opts) {
    const o = opts || {};
    const send = typeof o.send === 'function' ? o.send : function () {};
    const chatsFor = typeof o.chatsFor === 'function' ? o.chatsFor : function () { return []; };
    const jobName = typeof o.jobName === 'function' ? o.jobName : function () { return 'a routine'; };
    const jobAgent = typeof o.jobAgent === 'function' ? o.jobAgent : function () { return null; };
    // DELIVERY OUTCOME (2026-07-15 audit): every send attempt reports its result — onDelivery(jobId,
    // { ok, error?, channel? }) — so a failed ping is durably recorded instead of vanishing (the old
    // behavior swallowed the rejection entirely: the routine "succeeded" but nobody was ever told).
    // Optional + injected; absent -> the pre-fix swallow, and it must never throw into the cron pipeline.
    const rawOnDelivery = typeof o.onDelivery === 'function' ? o.onDelivery : function () {};
    const onDelivery = function (jobId, result) { try { rawOnDelivery(jobId, result); } catch (_) {} };

    function onEvent(name, payload) {
      const p = payload || {};
      try {
        if (name !== 'cron.result' || p.outcome !== 'ok') return;   // ONLY a clean, work-producing run pings (anti-spam)
        const aid = jobAgent(p.jobId);
        if (!aid) return;                                            // unknown job → safe no-op
        const chats = chatsFor(aid) || [];
        if (!chats.length) return;                                   // no connected/opted-in chat → no ping
        const text = composeMessage(jobName(p.jobId));
        for (const c of chats) {
          const chatId = (c && c.chatId != null) ? c.chatId : c;     // tolerate {chatId,channel} or a bare id
          const channel = c && c.channel;
          try {
            Promise.resolve(send(chatId, text, channel, { jobId: p.jobId, runId: p.runId || '', agentId: aid })).then(
              function () { onDelivery(p.jobId, { ok: true, channel: channel }); },
              function (e) { onDelivery(p.jobId, { ok: false, error: (e && e.message) || String(e || 'send failed'), channel: channel }); }
            );
          } catch (e) { onDelivery(p.jobId, { ok: false, error: (e && e.message) || String(e || 'send threw'), channel: channel }); }
        }
      } catch (_) { /* a notification must NEVER break the cron pipeline */ }
    }

    return { onEvent: onEvent };
  }

  return { makeAutoNotifier: makeAutoNotifier, composeMessage: composeMessage };
});
