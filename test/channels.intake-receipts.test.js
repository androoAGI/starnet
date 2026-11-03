/* node test/channels.intake-receipts.test.js — every inbound the adapter acknowledges has a durable receipt
   (channel-delivery-ledger S3).

   The adapter tells the platform "consumed" (it advances the offset) only once the hub has written the inbound's receipt;
   a receipt that cannot be written leaves the update with the platform, which hands it over again. Two inbound kinds fell
   outside that rule. An EDIT's receipt was keyed by its message alone ('…|edited'), so a second correction of one message
   was taken for the platform handing the first one over again and never ran (probe p2 B: the "table for 7" correction).
   A CHOICE TAP had no receipt at all: the button was spent and the tap answered before anything was durable, so a crash
   while the chosen option ran lost the Commander's answer for good (p2 C), and a tap whose intake failed was acknowledged
   anyway. Now an edit is keyed by when it was made ('|edited@<edit_date>'), and a choice tap writes its receipt
   ('…|cb:<callbackId>', the option's text as its message) before it spends the button or answers the tap, through an
   onCallback that is a sync function returning a promise, so a refused write throws out to the adapter.

   Built the production way: the station Telegram hub and adapter are startTelegram's own makeChannelHub and
   makeTelegramAdapter calls, lifted out of sidecar/index.js (test/helpers/channel-station-sim.js), over the real store,
   delivery ledger, prompt registry and TaskIntent; fakes stand only at the Bot API fetch, the in-memory disk (a crash is a
   generation fence: the dead process can neither write nor send) and the scripted run host. Proves:
     A. at the instant the adapter acknowledged it, a receipt carrying exactly that inbound was on disk — for a message,
        its edit, a second edit of it, and a choice tap
     B. a second correction of one message (a new edit_date), arriving while the first correction's run works, runs
     C. a tapped choice survives a crash: it is a durable receipt while it runs; after the restart it is replayed once (no
        tool step had begun) and answered once, or (a tool step had begun) never re-run and told once; its keyboard was
        stamped once, when tapped, and the replay never stamps it again
     D. a tap whose receipt cannot be written is NOT acknowledged, answered, run or stamped, and its button is not spent:
        handed over again once the disk takes writes, it is taken and runs once (prompts.peek reads without spending)
     E. a tap's receipt never quotes a non-message: in a group its message keeps messageId '' and its answer quotes
        nothing, live or replayed after a crash
     F. a v1 edit receipt ('…|edited', no date) still replays under its own id, and so does a receipt the migration had to
        rename (a reused v1 edit id): each leaves once, and nothing replays it again
     G. telegram.js carries edit_date as editDate, and a relayed edit keeps it through the relay admission: two relayed
        corrections of one message are two receipts
   Each case runs on its own seed's world. RED at trunk a3af8dafd: A (the second edit and the tap), B, C, D, E and G
   (21 clauses). F guards the ids the migration keeps: green at trunk, which never renames one, and red on the ledger
   before this step, whose recovery replayed a renamed receipt under its message's id, so it never left. */
'use strict';
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');
const { admitRelayMessage } = require('../sidecar/channels/relay-admission.js');
const { makePromptRegistry } = require('../sidecar/channels/prompts.js');
const { normalize } = require('../sidecar/channels/telegram.js');

const DM = Sim.CHATS.tgDm;
const GROUP = Sim.CHATS.tgGroup;

// the receipts on disk now, wherever the build keeps them: the delivery ledger (delivery.json) or the v1 inbox (inbox.json)
function receiptsOnDisk(w) {
  const out = [];
  for (const [p, text] of w.files) {
    const ledger = /\/delivery\.json$/.test(p), v1 = /\/inbox\.json$/.test(p);
    if (!ledger && !v1) continue;
    let d = null;
    try { d = JSON.parse(text); } catch (_) { continue; }
    for (const r of (ledger ? d.receipts : d.items) || []) out.push({ id: String(r.id), message: r.message || {}, attempt: r.attempt || null });
  }
  return out;
}
const receiptFor = (w, text) => receiptsOnDisk(w).find(r => r.message.text === text) || null;
const runsOf = (w, tag) => w.runs.filter(r => r.tags.indexOf(String(tag)) >= 0);
// the messages in a chat that carry a run's answer for this tag (a delayed one wears a header line first)
const answersOf = (w, chat, tag) => w.wire.filter(m => m.chat === chat && m.text.split('\n').some(l => l.indexOf('REPLY ' + tag + ' ') === 0));
const tagIn = (tag) => new RegExp('#' + tag + '(?!\\d)');
function plan(w, tag, p) { w.plans.set(String(tag), Object.assign({ steps: 0, stepMs: 200, long: false, question: false }, p || {})); }

// one world per case: virtual time, the lifted station booted over an in-memory disk (`before` may seed the disk)
async function world(seed, fn, before) {
  const w = Sim.makeWorld(seed, {});
  w.install();
  try {
    if (before) before(w);
    w.boot();
    await w.advance(500);
    return await fn(w);
  } finally { w.uninstall(); }
}
async function restart(w, why) {
  w.crash(why);
  await w.advance(0);
  w.boot();   // a fresh store and fresh hubs over the same disk, told 'up'
}
// a message whose run ends by asking: the question lands with a keyboard of two choices (each 'choose #<tag>')
async function ask(w, chat) {
  const tag = w.inbound(chat, 'message');
  plan(w, tag, { question: true });
  await w.advance(1500);
  return w.keyboards.filter(k => k.chat === chat).pop() || null;
}

(async () => {
  // ---- A. at the acknowledgement, the inbound is durable: a message, its edit, a second edit, a choice tap ----
  await world(11, async (w) => {
    const seen = [];
    const check = (what, text) => seen.push({ what: what, acked: w.lastAck === true, durable: !!receiptFor(w, text) });
    const m = w.inbound(DM, 'message'); plan(w, m);
    check('a message', 'please #' + m);
    await w.advance(700);
    const mid = w.lastTgMsg.get(DM);
    const e1 = w.inbound(DM, 'correction', { edit: mid, editDate: 100 }); plan(w, e1, { steps: 2, stepMs: 1000 });
    check('its edit', 'please #' + e1);
    await w.advance(1200);
    const e2 = w.inbound(DM, 'correction', { edit: mid, editDate: 200 }); plan(w, e2);
    check('a second edit of it', 'please #' + e2);
    await w.advance(5000);
    const kb = await ask(w, DM);
    A.ok(!!kb && kb.tags.length === 2, 'fixture: a question lands with a keyboard of two choices');
    if (kb) { plan(w, kb.tags[0]); w.tap(kb, 0); check('a choice tap', 'choose #' + kb.tags[0]); }
    await w.advance(2000);
    A.eq(seen.filter(s => !s.acked).map(s => s.what), [], 'fixture: the adapter acknowledged each inbound');
    A.eq(seen.filter(s => !s.durable).map(s => s.what), [], 'A: when the adapter acknowledged each inbound, a receipt carrying exactly that inbound was already on disk');
  });

  // ---- B. a second correction of one message runs (p2 B) ----
  await world(12, async (w) => {
    const m = w.inbound(DM, 'message'); plan(w, m);
    await w.advance(700);
    const mid = w.lastTgMsg.get(DM);
    const e1 = w.inbound(DM, 'correction', { edit: mid, editDate: 100 }); plan(w, e1, { steps: 2, stepMs: 1000 });
    await w.advance(1200);
    A.eq(runsOf(w, e1).filter(r => !r.ended).length, 1, 'fixture: the first correction\'s run is still working');
    const e2 = w.inbound(DM, 'correction', { edit: mid, editDate: 200 }); plan(w, e2);
    await w.advance(6000);
    A.eq(runsOf(w, e2).length, 1, 'B: a second correction of the same message (a new edit_date) runs, once — it is not taken for a redelivery of the first');
    A.eq(answersOf(w, DM, e2).length, 1, 'B: and its answer lands once');
    A.eq(runsOf(w, e1).map(r => r.ended), ['cancelled'], 'B: the first correction\'s run was superseded by it, like any newer message');
    A.eq(receiptsOnDisk(w).map(r => r.id), [], 'B: and no receipt is left');
  });

  // ---- C. a tapped choice survives a crash (p2 C) ----
  await world(13, async (w) => {
    const kb = await ask(w, DM);
    A.ok(!!kb, 'fixture: the question carries a keyboard');
    if (!kb) return;
    const pick = kb.tags[1];
    plan(w, pick, { steps: 0 });   // begins no tool step: a crash before it answers leaves a 0-step attempt
    const cb = w.tap(kb, 1);
    A.ok(w.lastAck, 'fixture: the tap was acknowledged');
    const r = receiptFor(w, 'choose #' + pick);
    A.ok(!!r && r.id === DM + '|' + kb.messageId + '|cb:' + cb, 'C: the tapped choice is a durable receipt, keyed by the tap, while it is worked on: ' + (r ? r.id : 'no receipt'));
    await w.advance(60);
    A.eq(runsOf(w, pick).filter(x => !x.ended).length, 1, 'fixture: the choice is being worked on when the station dies');
    const stamped = w.stamps.length;
    await restart(w, 'test: the station dies while a tapped choice is worked on');
    await w.advance(4000);
    A.eq(runsOf(w, pick).map(x => x.gen), [0, 1], 'C: after the restart the choice is replayed once (its run had begun no tool step), and only once');
    A.eq(answersOf(w, DM, pick).length, 1, 'C: its answer lands once');
    A.eq(w.wire.filter(m => m.chat === DM && /running it again now/.test(m.text) && tagIn(pick).test(m.text)).length, 1, 'C: the chat is told once that it is a second go');
    A.eq([stamped, w.stamps.length], [1, 1], 'C: its keyboard was stamped once, when it was tapped, and the replay never stamps it again');
    A.eq(receiptsOnDisk(w).map(x => x.id), [], 'C: and its receipt left with its answer');
  });
  await world(14, async (w) => {
    const kb = await ask(w, DM);
    if (!kb) { A.ok(false, 'fixture: the question carries a keyboard'); return; }
    const pick = kb.tags[0];
    plan(w, pick, { steps: 1, stepMs: 1000 });   // its tool step begins (the hub marks it) and it works on
    w.tap(kb, 0);
    await w.advance(400);
    A.eq(w.journal.get(pick + '#0'), 1, 'fixture: the tapped choice began its tool step before the station died');
    await restart(w, 'test: the station dies after a tapped choice began a tool step');
    await w.advance(4000);
    A.eq(runsOf(w, pick).length, 1, 'C: a tapped choice whose run had begun a tool step is never run again after a restart');
    A.eq(w.journal.get(pick + '#0'), 1, 'C: its tool step ran once');
    A.eq(w.wire.filter(m => m.chat === DM && /NOT run again/.test(m.text) && tagIn(pick).test(m.text)).length, 1, 'C: the chat is told once that it was interrupted and not run again');
    A.eq(receiptsOnDisk(w).map(x => x.id), [], 'C: and its receipt left with that notice');
  });

  // ---- D. a tap whose receipt cannot be written is not acknowledged, and its button is not spent ----
  {
    const reg = makePromptRegistry({ newId: (() => { let n = 0; return () => 'tok' + (++n); })() });
    const e = reg.create({ kind: 'choice', chatId: '1', options: ['a', 'b'] });
    const peek = typeof reg.peek === 'function' ? (t) => reg.peek(t) : () => undefined;   // (a registry with no peek fails here, not throws)
    A.ok(peek(e.token) === e && peek(e.token) === e, 'D: prompts.peek reads what a button means without spending it');
    A.ok(reg.take(e.token) === e && peek(e.token) === null && reg.take(e.token) === null, 'D: take spends it, once');
  }
  await world(15, async (w) => {
    const kb = await ask(w, DM);
    if (!kb) { A.ok(false, 'fixture: the question carries a keyboard'); return; }
    const pick = kb.tags[0];
    plan(w, pick);
    w.writeFault = 'EBUSY';   // the disk refuses every write for now
    const cb = w.tap(kb, 0);
    const acked = w.lastAck;
    await w.advance(800);
    A.eq(acked, false, 'D: a tap whose receipt cannot be written is NOT acknowledged: the platform keeps it');
    A.eq(w.toasts.has(cb), false, 'D: nothing answered the tap (no toast claims a choice that is not durable)');
    A.eq(runsOf(w, pick).length, 0, 'D: nothing ran');
    A.eq(w.stamps.length, 0, 'D: and its keyboard is untouched');
    w.writeFault = '';
    w.redeliver();   // Telegram hands the same tap over again
    A.ok(w.taps.some(t => t.cb === cb), 'D: handed over again once the disk takes writes, the same tap is acknowledged');
    await w.advance(3000);
    A.ok(tagIn(pick).test((w.toasts.get(cb) || {}).text || ''), 'D: and answered as the choice it is: its button was never spent (' + JSON.stringify(w.toasts.get(cb) || null) + ')');
    A.eq(runsOf(w, pick).length, 1, 'D: the choice runs once');
    A.eq(answersOf(w, DM, pick).length, 1, 'D: its answer lands once');
    A.eq(w.stamps.length, 1, 'D: its keyboard is stamped once');
  });

  // ---- E. a tap's receipt never quotes a non-message ----
  await world(16, async (w) => {
    const kb = await ask(w, GROUP);
    if (!kb) { A.ok(false, 'fixture: the group question carries a keyboard'); return; }
    const q = w.wire.find(m => m.chat === GROUP && m.text.indexOf('Pick one for') >= 0);
    A.ok(!!q && !!q.replyTo && w.heard.has(GROUP + '#' + q.replyTo), 'fixture: in a group, the question quotes the message that asked it');
    const live = kb.tags[0];
    plan(w, live);
    const cb = w.tap(kb, 0);
    const r = receiptFor(w, 'choose #' + live);
    A.ok(!!r && r.id === GROUP + '|' + kb.messageId + '|cb:' + cb && r.message.messageId === '',
      'E: the tap\'s receipt is keyed by the tap and its message keeps messageId "" (no quote, no edit anchor): ' + (r ? r.id + ' messageId=' + JSON.stringify(r.message.messageId) : 'no receipt'));
    await w.advance(2000);
    A.eq(answersOf(w, GROUP, live).map(m => m.replyTo), [''], 'E: the tapped choice\'s answer quotes nothing');
    // a second question, tapped, and the station dies while the choice is worked on: the replayed answer quotes nothing too
    const kb2 = await ask(w, GROUP);
    if (!kb2) { A.ok(false, 'fixture: the second group question carries a keyboard'); return; }
    const pick = kb2.tags[1];
    plan(w, pick, { steps: 0 });
    w.tap(kb2, 1);
    await w.advance(60);
    await restart(w, 'test: the station dies while a group\'s tapped choice is worked on');
    await w.advance(4000);
    A.eq(runsOf(w, pick).map(x => x.gen), [0, 1], 'fixture: the group\'s tapped choice was replayed once after the restart');
    A.eq(answersOf(w, GROUP, pick).map(m => m.replyTo), [''], 'E: the replayed choice\'s answer quotes nothing either');
    A.eq(w.wire.filter(m => m.chat === GROUP && m.replyTo && !w.heard.has(GROUP + '#' + m.replyTo)).map(m => m.replyTo), [], 'E: nothing in the group quotes a message no member sent');
  });

  // ---- F. a v1 edit receipt, and one the migration renamed, each replay under their own id, once ----
  const v1msg = (mid, text) => ({ channel: 'telegram', chatId: Sim.OWNER, chatType: 'dm', userId: Sim.OWNER, text: text, messageId: String(mid), edited: true, ts: 1 });
  await world(17, async (w) => {
    await w.advance(2000);
    A.eq(receiptsOnDisk(w).map(r => r.id), [], 'F: a v1 edit receipt ("…|edited", no edit date) replays at boot under its own id and leaves (after a restart an edit is of nothing the hub heard: settled, unrun)');
    const store = w.current().store;
    if (store.ledger && typeof store.ledger.receive === 'function') {
      // a receipt the migration had to rename (an older build reused a v1 edit id): its message keys to another id
      const renamed = 'telegram|' + Sim.OWNER + '|6|edited#' + (Sim.T0 - 1000);
      store.ledger.receive({ id: renamed, channel: 'telegram', chatId: Sim.OWNER, message: v1msg(6, 'corrected on the older build') });
      w.up();
      await w.advance(1000);
      A.eq(receiptsOnDisk(w).map(r => r.id), [], 'F: a receipt replays under its OWN id — one the migration renamed leaves too, rather than replaying under the id its message keys to');
      await w.advance(65000);   // two turns of the 30 s recover timer
      A.eq(receiptsOnDisk(w).map(r => r.id), [], 'F: and nothing replays it again');
    } else {
      console.log('  F: this build has no delivery ledger (no renamed receipts to replay)');
    }
    A.eq(w.runs.length, 0, 'F: and those edits ran nothing');
  }, (w) => {
    w.files.set(Sim.ROOT + '/inbox.json', JSON.stringify({ version: 1, items: [{ id: 'telegram|' + Sim.OWNER + '|5|edited', channel: 'telegram', message: v1msg(5, 'a v1 correction'), ts: Sim.T0 - 2000 }] }));
  });

  // ---- G. the edit date rides from Telegram, and through the relay ----
  {
    const DMC = { id: 5, type: 'private' }, ME = { id: 5, is_bot: false, first_name: 'Ana' };
    const ed = normalize({ update_id: 1, edited_message: { message_id: 9, date: 1700000000, edit_date: 1700000123, text: 'fixed', chat: DMC, from: ME } });
    A.eq(ed.message.editDate, 1700000123, 'G: telegram.js carries an edit\'s edit_date as editDate');
    A.eq('editDate' in normalize({ update_id: 2, message: { message_id: 9, date: 1700000000, text: 'x', chat: DMC, from: ME } }).message, false, 'G: an ordinary message carries none (additive)');
  }
  await world(18, async (w) => {
    const adapter = w.current().tg.adapter, hub = w.current().tg.hub;
    const relayed = (date, text) => admitRelayMessage({ chatId: Sim.OWNER, chatType: 'dm', userId: Sim.OWNER, text: text, messageId: '77', edited: true, editDate: date }, adapter);
    const one = relayed('300', 'relayed correction one');
    A.eq(one.ok ? one.message.editDate : one.error, '300', 'G: a relayed edit keeps its edit date through the relay admission');
    const two = relayed('301', 'relayed correction two');
    if (one.ok) hub.onInbound(one.message);
    if (two.ok) hub.onInbound(two.message);
    A.ok(!!receiptFor(w, 'relayed correction one') && !!receiptFor(w, 'relayed correction two'), 'G: two relayed corrections of one message are two durable receipts');
    await w.advance(2000);
    A.eq(receiptsOnDisk(w).map(r => r.id), [], 'G: and each leaves once it is handled');
  });

  A.report('channels.intake-receipts.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
