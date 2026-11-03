/* node test/channels.decision-settle.test.js — a message that ends with no reply of its own is settled where its decision is
   made, so a crash while its acknowledgement is on the wire never acts on it a second time (channel-delivery-ledger,
   review round 1).

   THE WINDOW. A follow-up steered into the working run, a slash command, a plain "stop" or /stop: each acts at once (the
   note goes into the run, the registry runs the command, the run is aborted), then sends an ephemeral acknowledgement, and
   its receipt was settled only once routeInbound resolved — after that ack was on the wire, which with the adapter's own
   resend can take ~30 s. The station dying in that window left the receipt pending with no attempt mark, and the next boot
   replayed it as a brand-new message: the follow-up ran as a task of its own (its tool steps too), "/routine add" saved
   the routine again ("/routine rm 2" would remove a second one), and a stopped task came back from the dead under the
   attempt rule. Now the receipt is settled at the decision: a command before it acts (at most once), a follow-up as soon as
   it joined the run, and a stop together with the receipts of the run it stops, in one write.

   Built the production way: the station Telegram hub and adapter lifted out of startTelegram (test/helpers/channel-station-
   sim.js) over the REAL channel store and delivery ledger; the platform takes the acknowledgement and the station dies in
   that instant (the fake Bot API's crashAfter), and a fresh process boots from the same disk.

   RED at f52f308db: the follow-up runs again as its own message, the command runs twice, the stopped task is replayed and
   told it was interrupted. Same at a3af8dafd (the window is older than the ledger). */
'use strict';
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');
const { CHATS } = Sim;

async function world(seed) { const w = Sim.makeWorld(seed, {}); w.install(); w.boot(); await w.advance(500); return w; }
const next = (w) => String(w.tags + 1);
const onWire = (w, re) => w.wire.filter(m => m.chat === CHATS.tgDm && re.test(String(m.text))).length;

(async () => {
  // ---- a follow-up joins the working run; the station dies as its ack lands ----
  {
    const w = await world(11);
    try {
      const m = next(w);
      w.plans.set(m, { steps: 3, stepMs: 2000, long: false, question: false });
      w.inbound(CHATS.tgDm, 'message');
      await w.advance(1500);                                    // its run is working on its first step
      w.faults.set(CHATS.tgDm, ['crashAfter']);                 // the next send to the chat lands, and the station dies
      const f = next(w);
      w.plans.set(f, { steps: 1, stepMs: 300, long: false, question: false });
      w.inbound(CHATS.tgDm, 'followup', { text: (t) => 'also water the plants #' + t });
      await w.advance(1500);
      A.eq(w.steered.filter(s => s.text.indexOf('#' + f) >= 0).length, 1, 'follow-up: it joined the working run');
      A.ok(w.crashes === 1 && onWire(w, /Added to the task/) === 1, 'follow-up: its ack landed, and the station died in that instant');
      w.boot();
      await w.advance(60000);
      A.eq(w.runs.filter(r => r.tags.indexOf(f) >= 0).length, 0, 'follow-up: after the restart it never runs as a message of its own (was: it ran, its tool steps too)');
      A.eq([...w.journal.keys()].filter(k => k.split('#')[0].split('+').indexOf(f) >= 0), [], 'follow-up: nothing of it is done twice');
    } finally { w.uninstall(); }
  }

  // ---- a slash command runs; the station dies as its reply lands ----
  {
    const w = await world(12);
    try {
      w.faults.set(CHATS.tgDm, ['crashAfter']);
      w.inbound(CHATS.tgDm, 'slash', { text: (t) => '/routine add every day | water the plants #' + t });
      await w.advance(1500);
      A.ok(w.crashes === 1 && w.slashCalls.length === 1, 'slash command: the registry ran it, its reply landed, and the station died in that instant');
      w.boot();
      await w.advance(60000);
      A.eq(w.slashCalls.length, 1, 'slash command: after the restart it is not run again (was: twice — a second routine, or a second one removed)');
    } finally { w.uninstall(); }
  }

  /* ---- a slash command whose settle the disk refuses: it waits, and runs once when the writes work ----
     Its receipt was written; then the disk starts refusing writes (an antivirus), before the ledger has had a write fail,
     so it cannot know yet. The settle that must come first is that first refused write: the command runs nothing then
     (its receipt stays pending), and the station dying in the span does not make it run twice. */
  {
    const w = await world(14);
    try {
      w.inbound(CHATS.tgDm, 'slash', { text: (t) => '/routine add every day | water the plants #' + t });
      w.writeFault = 'EBUSY';                                   // the receipt is on the disk; nothing after it will be
      await w.advance(1500);
      A.eq(w.slashCalls.length, 0, 'slash command, settle refused: it does not run while its settle cannot be written (was: it ran, settled only in memory)');
      w.crash('the station dies while its writes fail');
      w.writeFault = '';
      w.boot();
      await w.advance(60000);
      A.eq(w.slashCalls.length, 1, 'slash command, settle refused: once the writes work it runs, exactly once (was: twice after the restart)');
    } finally { w.uninstall(); }
  }

  // ---- "stop" and /stop: the stopped task never comes back ----
  for (const how of ['stop', '/stop']) {
    const w = await world(13);
    try {
      const m = next(w);
      w.plans.set(m, { steps: 3, stepMs: 2000, long: false, question: false });
      w.inbound(CHATS.tgDm, 'message');
      await w.advance(1500);
      w.faults.set(CHATS.tgDm, ['crashAfter']);                 // the stop's ack lands, and the station dies
      w.inbound(CHATS.tgDm, 'command', { text: how, noTag: true });
      await w.advance(1500);
      const run = w.runs.find(r => r.tags.indexOf(m) >= 0);
      A.ok(!!run && run.abortedAt != null && w.crashes === 1 && onWire(w, /Stopped the run in progress/) === 1, how + ': the task was stopped, its ack landed, and the station died in that instant');
      w.boot();
      await w.advance(60000);
      A.eq(w.runs.filter(r => r.tags.indexOf(m) >= 0).length, 1, how + ': after the restart the stopped task never runs again');
      A.eq(onWire(w, /NOT run again/), 0, how + ': nor is it told it was interrupted (was: replayed under the attempt rule: "StarNet restarted while it was working on …")');
      A.eq(onWire(w, /Nothing is running|Stopped the run in progress/), 1, how + ': and the stop itself is not replayed');
    } finally { w.uninstall(); }
  }

  A.report('channels.decision-settle.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
