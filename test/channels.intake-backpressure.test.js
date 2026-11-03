/* node test/channels.intake-backpressure.test.js — backpressure holds back only what would start a paid run, and only in the
   chat that owes the replies (channel-delivery-ledger, review round 1).

   A chat whose replies cannot get out (its sends keep failing for the moment) owes them in its lane; past the mark its new
   messages are kept (deferred) and run in order once the lane drains: backpressure before the paid run. Two holes:
     · it held back EVERY new message, the ones that start no run too: the owner's /stop and a plain "stop" never reached
       the run that was still working and spending, a follow-up never joined it, and an overheard group line waited for a
       paid run that would never come;
     · a chat's waiting messages counted against its CHANNEL's intake cap, so a chat whose sends kept failing while its
       members kept talking filled the cap, and every other chat on that channel — the owner's healthy DM to the same bot
       — was refused at intake (and, on a platform that does not hand a refused update over again, lost).
   Now a message that starts no run is never held back, a chat's waiting messages are its own (past its share, a newer one
   is not kept and the chat is told so once), and the channel's cap counts only what is being worked on.

   Built the production way: the station Telegram hub and adapter lifted out of startTelegram (test/helpers/channel-station-
   sim.js) over the REAL channel store and delivery ledger, a fake Bot API and a scripted run host; only the platform's
   answers are scripted (a chat that is down fails every send retryably).

   RED at f52f308db: the /stop and the "stop" are deferred and the run is never aborted; the overheard lines fill the
   channel's intake and the owner's DM is refused, unanswered until the group's sends recover. */
'use strict';
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');
const { CHATS, OWNER, GROUP } = Sim;

const quick = { steps: 0, stepMs: 200, long: false, question: false };
const next = (w) => String(w.tags + 1);   // the tag the next inbound gets
const receiptOf = (chat, w) => chat + '|' + String(w.tgMsgId);   // the receipt id of the Telegram message just sent
async function boot(seed, limits) { const w = Sim.makeWorld(seed, { limits: limits }); w.install(); w.boot(); await w.advance(500); return w; }
const wired = (w, chat, re) => w.attempts.some(a => a.chat === chat && re.test(String(a.text)));

(async () => {
  /* ---- a chat that owes too much keeps its controls: /stop, "stop" and a follow-up reach the run that is working ---- */
  for (const how of ['/stop', 'stop']) {
    const w = await boot(41, { laneMaxDeliveries: 3 });
    try {
      w.down.add(CHATS.tgDm);                                   // the owner's DM: every send fails for the moment
      const tag = next(w);
      w.plans.set(tag, { steps: 3, stepMs: 30000, long: false, question: false });
      w.inbound(CHATS.tgDm, 'message');                         // a long task starts
      await w.advance(2000);
      const run = w.runs.find(r => r.tags.indexOf(tag) >= 0);
      A.ok(!!run && w.live.has(run.runId), how + ': the long task is working');
      const L = w.current().store.ledger;
      for (let i = 0; i < 3; i++) L.enqueue({ id: 'notice:old' + i, channel: 'telegram', chatId: OWNER, kind: 'notice', parts: ['an older reply ' + i] });
      L.drive(CHATS.tgDm).catch(() => {});
      await w.advance(3000);                                     // their first attempts fail (the adapter's resend included)
      A.ok(L.laneFull(CHATS.tgDm), how + ': the chat owes as many replies as its lane may hold');
      if (how === 'stop') {
        // a follow-up joins the working run, held back by nothing
        w.inbound(CHATS.tgDm, 'followup', { text: 'also note this', noTag: true });
        await w.advance(500);
        A.ok(w.steered.some(s => s.runId === run.runId && /also note this/.test(s.text)), 'stop: a follow-up while the chat owes too much still joins the working run (was: kept back with the paid runs)');
      }
      w.inbound(CHATS.tgDm, 'command', { text: how, noTag: true });
      const rid = receiptOf(CHATS.tgDm, w);
      await w.advance(1000);
      A.ok(!w.deferredIds.has(rid), how + ': its receipt was not kept back (was: deferred behind the replies the chat owes)');
      A.ok(run.abortedAt != null, how + ': the run that was working is stopped (was: it went on, and the ' + how + ' waited for the lane to drain)');
      A.ok(wired(w, CHATS.tgDm, /Stopped the run in progress/), how + ': and the chat is told so (the send is tried, though the chat is down)');
      await w.advance(5000);   // the ack's own bounded resend to a chat that is down
      A.eq(L.pending('telegram').filter(r => r.id === rid).length, 0, how + ': its receipt is settled');
    } finally { w.uninstall(); }
  }

  /* ---- one chat's backlog never closes the channel's intake on another chat ---- */
  {
    const w = await boot(43, { laneMaxDeliveries: 20, laneMaxChars: 200000, maxPendingPerChannel: 200 });
    try {
      w.down.add(CHATS.tgGroup);                                // the group's sends fail for the moment (a flood wait)
      for (let i = 0; i < 22; i++) { w.plans.set(next(w), quick); w.inbound(CHATS.tgGroup, 'message'); await w.advance(1000); }
      const L = w.current().store.ledger;
      A.ok(L.laneFull(CHATS.tgGroup), 'the group owes as many replies as its lane may hold');
      // its members keep talking: overheard lines start no run, and are never held back (each a bubble of its own: one
      // author's lines inside the 350 ms batch window are one turn, and wait for it like any batch)
      let refused = 0;
      for (let i = 0; i < 230; i++) {
        w.inbound(CHATS.tgGroup, 'observe', { text: 'just chatting ' + i, noTag: true, from: '777' });
        if (!w.lastAck) refused++;
        await w.advance(400);
      }
      await w.advance(1000);
      A.eq(refused, 0, 'every overheard group line is acknowledged (was: kept back, until they filled the channel\'s intake)');
      const waiting = L.pending('telegram').filter(r => r.chatId === GROUP);
      A.ok(waiting.every(r => /@simbot/.test(String(r.message && r.message.text))), 'no overheard line is left waiting for a run that will never come (' + waiting.length + ' waiting)');
      // the group asks for more work than it may keep waiting: past its share a newer one is not kept, and it is told once
      for (let i = 0; i < 60; i++) { w.plans.set(next(w), quick); w.inbound(CHATS.tgGroup, 'message'); await w.advance(200); }
      const kept = L.pending('telegram').filter(r => r.chatId === GROUP && r.deferred).length;
      A.ok(kept <= L.limits.deferredPerChat, 'the group keeps at most its share of waiting messages (' + kept + ' of ' + L.limits.deferredPerChat + ')');
      const told = L.deliveries(CHATS.tgGroup).filter(d => d.id.indexOf('notice:overflow:') === 0);
      A.eq(told.length, 1, 'and is told once, behind the replies it is owed, that newer ones were not kept');
      // the owner writes to the same bot in the DM, which is healthy
      const tag = next(w);
      w.plans.set(tag, quick);
      w.inbound(CHATS.tgDm, 'message');
      A.ok(w.lastAck, 'the owner\'s DM on the same bot is acknowledged (was: refused, the channel\'s intake full of the group\'s waiting lines)');
      await w.advance(16000);
      A.ok(w.wire.some(m => m.chat === CHATS.tgDm && String(m.text).split('\n')[0].indexOf('REPLY ' + tag + ' ') === 0), 'and answered within one drain, while the group is still down (was: only once the group\'s sends recovered)');
      // the group comes back: what it was owed lands, the notice once
      w.down.delete(CHATS.tgGroup);
      w.up();
      for (let i = 0; i < 40; i++) { w.redeliver(); await w.advance(31000); }
      A.eq(w.wire.filter(m => m.chat === CHATS.tgGroup && /were dropped\. Send again what still needs doing/.test(m.text)).length, 1, 'once the group is back, the notice lands once');
    } finally { w.uninstall(); }
  }

  A.report('channels.intake-backpressure.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
