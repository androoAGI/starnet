/* sidecar/channels/routes.js — the per-chat ROUTE BOOK: where in a conversation a hub's answer belongs.

   Moved out of channels/hub.js unchanged (channel-delivery-ledger, S1). One book per hub, made by makeChannelHub:

     makeRouteBook() -> { routes, noteRoute, beginWork, isCurrentWork, editIsCurrent, forgetThread, routeOpts, MAX_ROUTES }
       noteRoute(msg)            learn the chat's topic and the message to quote from an inbound message
       routeOpts(chatId, first)  -> { threadId?, replyTo? } | null   a send's route; first=true also spends the quote
       forgetThread(chatId, threadId?)   the topic is gone: stop aiming at it (a threadId the chat moved on from is left)
       editIsCurrent(msg)        is this edit of the last message heard in its chat?
       routes                    chatId -> { threadId, replyTo, lastMessageId }, bounded by MAX_ROUTES (oldest out)

   In memory on purpose: a route is learned again from the chat's next message. Pure: no I/O, no clock. */
'use strict';

function makeRouteBook() {
  /* ---- ROUTE: answer WHERE the question was asked -------------------------------------------------------
     Two facts arrive with an inbound message and were both thrown away: which sub-conversation it came from
     (`threadId` — a Telegram forum topic today), and which message it was (`messageId`). Without the first,
     every answer in a forum supergroup lands in **General instead of the topic the member is sitting in** —
     the last remaining case of this channel delivering to the wrong place rather than merely doing less. Without
     the second, a reply in a busy group floats loose from its question.

     Ambient per chat rather than threaded through ~40 deliver() call-sites: the route is a property of the
     CONVERSATION, so /status, a consent card and the run's answer should all land in the same topic without
     each having to know it. Bounded (MAX_ROUTES, oldest evicted) because chatIds are unbounded.

     The quote is CONSUMED on first use; the thread is not. A quote answers one specific message, so a routine
     firing six hours later must not reach back and reply to it — but it should still land in the right topic.
     Fields are neutral ({ threadId, replyTo }); only telegram.transport.js knows the Bot API's names, and the
     other four transports ignore opts they do not recognise, so their behaviour is byte-identical. */
  const MAX_ROUTES = 500;
  const routes = new Map();   // chatId -> { threadId, replyTo, lastMessageId }
  function noteRoute(msg) {
    const chatId = String(msg.chatId);
    const prior = routes.get(chatId);
    const threadId = (msg.threadId == null || msg.threadId === '') ? '' : String(msg.threadId);
    // Quoting in a DM is noise — there is only one other person and nothing to disambiguate. Groups only,
    // which is also where a detached answer actually costs the reader something.
    const replyTo = (msg.chatType === 'group' && msg.messageId != null && msg.messageId !== '') ? String(msg.messageId) : '';
    const lastMessageId = (msg.messageId == null || msg.messageId === '') ? '' : String(msg.messageId);
    routes.delete(chatId);                        // re-insert so Map iteration order is least-recently-used first
    routes.set(chatId, { threadId: threadId, replyTo: replyTo, lastMessageId: lastMessageId,
      workIntent: prior ? prior.workIntent : null });
    while (routes.size > MAX_ROUTES) { const k = routes.keys().next().value; routes.delete(k); }
  }
  // Host-private ordering proof for an awaited steer fallback. Cosmetic/status route updates
  // preserve it; only admitted work or an explicit STOP replaces it. It is never read from an
  // inbound payload or returned by routeOpts. Eviction leaves no proof, never a fresh permission.
  function beginWork(chatId) {
    const r = routes.get(String(chatId));
    if (!r) return null;
    r.workIntent = {};
    return r.workIntent;
  }
  function isCurrentWork(chatId, token) {
    const r = routes.get(String(chatId));
    return !!(token && r && r.workIntent === token);
  }

  /* IS THIS EDIT WORTH A FRESH RUN?
     Telegram now delivers `edited_message`, which closes a real gap — fixing a typo used to change nothing and
     the bot went on answering the typo. But "an edit is just another message" is too blunt: editing something
     from last week would fire a run out of nowhere, and it would be spend the member never asked for.

     The bound is the narrowest one that still fixes the case people actually hit: an edit counts only when it
     edits the LAST message we saw in that chat. Anything older is somebody tidying history, not asking again.
     No record (a fresh boot) also declines — we cannot tell an ancient edit from a fresh one, and inventing a
     run is worse than doing nothing. When it IS accepted, the supersede rule downstream does the rest: a
     correction made while the bot is still thinking aborts the stale run and re-answers the corrected text. */
  function editIsCurrent(msg) {
    const r = routes.get(String(msg.chatId));
    if (!r || !r.lastMessageId) return false;
    return String(msg.messageId || '') === r.lastMessageId;
  }
  /* The topic this chat was bound to no longer exists — the transport already saved the message by resending
     to the chat root, but the binding itself must go too, or every later send repeats that failed call and
     its retry. Dropped rather than remembered as "dead": the next inbound message re-learns the real topic. Named, only
     that topic goes: a routine's own old topic being gone says nothing about the one the chat is in now. */
  function forgetThread(chatId, threadId) {
    const r = routes.get(String(chatId));
    if (r && r.threadId && (threadId == null || r.threadId === String(threadId))) r.threadId = '';
  }
  // first=true asks for the quote as well (and spends it). Returns null when this chat has no route, so the
  // send call is byte-identical to before on every platform that never sets one.
  function routeOpts(chatId, first) {
    const r = routes.get(String(chatId));
    if (!r) return null;
    const out = {};
    if (r.threadId) out.threadId = r.threadId;
    if (first && r.replyTo) { out.replyTo = r.replyTo; r.replyTo = ''; }
    return (out.threadId || out.replyTo) ? out : null;
  }
  return { routes, noteRoute, beginWork, isCurrentWork, editIsCurrent, forgetThread, routeOpts, MAX_ROUTES };
}

module.exports = { makeRouteBook };
