'use strict';
/* test/channels.consent-stamp.property.test.js — A CONSENT ASK EDITS ITS KEYBOARD EXACTLY ONCE, whoever settles it
   (channel-delivery-ledger S6; bugs 64563ad9 and 9e60dd9f).

   A permission ask can end at a tap, at the fail-closed timer, on STARNET REMOTE, at E-STOP, at a newer message or a plain
   stop, or with the process dying under it. However it ended, the four buttons must not stay live-looking: the message is
   rewritten once, with no keyboard, naming what the broker did. At trunk that stamp was one fire-and-forget edit, marked
   done before its answer was known: a 429 on it left the buttons live for good, and a crash with the ask open left them
   live with nothing that could ever stamp them. The stamp now rides the delivery ledger.

   THE STATION IS THE PRODUCTION ONE (test/helpers/channel-station-sim.js): startTelegram's own makeChannelHub and
   makeTelegramAdapter calls, lifted out of index.js, over the real store and ledger, the real prompt registry, the
   channelAskConsent slice over the real makeConsentWait, STARNET REMOTE's real approvals index, the real killAll, and a fake
   Bot API that answers an edit the way Telegram does ('message is not modified' for a stamp the message already carries).

   THE MATRIX. Every settle path × both landing orders (the keyboard's answer back before the settle, or still on its way) ×
   with and without a 429 on the first edit: exactly one edit lands, carrying no reply_markup, with the ask's words and the
   line that names the broker's decision; nothing edits it again, a late tap included; and the run got that decision.
   THE FAILURES. An answer lost, the process dying on either side of an edit or under a backoff, the message deleted, a
   refusal for good, a retry_after, failing writes, the update barrier, a reconnect, two asks in one crash, the agent bot,
   and the choice stamp, which shares this path.
   THE WALK. Seeded runs of all of that at once, over two chats, ending in one oracle.
   THE ONE EXCEPTION. A keyboard the platform took as the process died: its message id was in the answer that never came
   back, so no process can ever edit it (the same window as any Telegram part, and no design closes it). Its row states
   what is left: nothing is claimed, nothing is edited, and a late tap is told the question is no longer open.

   RED on a scratch checkout of trunk a3af8dafd: every row where the first edit is refused (each path, both landing orders),
   both crash rows, a crash before the edit lands or under its backoff, a retry_after, a refused credential, the agent bot,
   the two choice rows with a refused edit or a crash, and all 24 walk seeds. The rows with no fault are green there: since
   quick win 24 every settle stamps once when nothing goes wrong, and what was missing was the retry and the durability. */
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');
const { killAll } = require('../sidecar/halt.js');

const DM = Sim.CHATS.tgDm;
const BOT = Sim.CHATS.botDm;
const DENIED = '▸ ❌ DENIED — the action did not run';
const RESTARTED = '▸ StarNet restarted — not answered; the action did not run';

let seed = 100;
const lastLine = (t) => String(t).split('\n').pop();
const askKeyboards = (w, chat) => w.keyboards.filter(k => (!chat || k.chat === chat) && /Permission needed/.test(k.text));
const onKeyboard = (kb) => (c) => c.chat === kb.chat && c.messageId === String(kb.messageId);
const editsOf = (w, kb) => w.editCalls.filter(onKeyboard(kb));
const stampsOf = (w, kb) => w.stamps.filter(onKeyboard(kb));
const failedEvents = (w) => w.events.filter(e => e.ok === false);
// a channel.delivery about a stamp: it would carry no chunks, or call the ask's run undeliverable, which it never is
const stampEvents = (w) => w.events.filter(e => e.chunks === 0 || e.reason === 'undeliverable' || e.reason === 'redelivery-delayed');
const runOf = (w, tag) => w.runs.find(r => r.tags.indexOf(String(tag)) >= 0) || null;
function ledgerDoc(w) {
  try { return JSON.parse(w.files.get(Sim.ROOT + '/delivery.json') || 'null'); } catch (_) { return null; }
}
// what the ledger still holds of any keyboard: nothing, once everything has settled and landed
function leftOnDisk(w) {
  const d = ledgerDoc(w) || {};
  return (d.openAsks || []).map(a => 'open ' + a.id).concat((d.deliveries || []).filter(x => x.kind === 'edit').map(x => 'queued ' + x.id));
}
const openOnDisk = (w) => ((ledgerDoc(w) || {}).openAsks || []).map(a => a.id);
const tombstoned = (w, reason) => ((ledgerDoc(w) || {}).tombstones || []).filter(t => t.reason === reason).length;

async function world(fn, o) {
  const w = Sim.makeWorld(++seed, o || {});
  w.install();
  try {
    w.boot();
    await w.advance(500);
    w.current().store.saveChatRecord(Sim.OWNER, { approvals: true });
    if (w.current().bot) w.current().bot.store.saveChatRecord(Sim.OWNER, { approvals: true });
    return await fn(w);
  } finally { w.uninstall(); }
}
async function restart(w, why) {
  if (w.current().gen === w.gen) w.crash(why);
  await w.advance(0);
  w.boot();   // a fresh store and fresh hubs over the same disk, told 'up'
}
// a message whose run stops at its first tool step for the Commander's permission
function asking(w, tag) { w.plans.set(String(tag), { steps: 1, stepMs: 200, long: false, question: false, ask: true }); }
async function ask(w, chat) {
  const tag = w.inbound(chat, 'message');
  asking(w, tag);
  await w.advance(600);
  return tag;
}
// a question the run ends on: its keyboard of two choices, each a message of its own once tapped
async function question(w, chat) {
  const tag = w.inbound(chat, 'message');
  w.plans.set(String(tag), { steps: 0, stepMs: 200, long: false, question: true });
  await w.advance(1500);
  return w.keyboards.filter(k => k.chat === chat && k.tags.length).pop() || null;
}

// HOW AN ASK ENDS: each path, what the run must have got, and the line its stamp must end on
const PATHS = {
  tap: { decision: 'once', line: '▸ ✅ Allow once', settle: (w, kb) => { w.tap(kb, 0); } },
  timeout: { decision: 'timeout', line: '▸ ⌛ no answer in time — DENIED, the action did not run', settle: (w) => w.advance(121000) },
  remote: {
    decision: 'once', line: '▸ already answered in StarNet — ALLOWED (once)',
    settle: (w) => {
      const open = w.approvals.list().filter(r => r.surface === 'channel').pop();
      A.ok(!!open && w.approvals.answer(open.runId, open.promptId, 'once').ok === true, 'fixture: a paired phone answers the ask');
    }
  },
  estop: { decision: 'deny', line: DENIED, settle: (w) => { A.ok(killAll(null, w.current().tg.hub._internals.inflight) >= 1, 'fixture: E-STOP stops the run'); } },
  // a correction of the latest message takes the chat from the run it started (a plain follow-up joins the run instead)
  supersede: {
    decision: 'deny', line: DENIED,
    settle: (w) => { const e = w.inbound(DM, 'correction', { edit: w.lastTgMsg.get(DM) }); w.plans.set(e, { steps: 0, stepMs: 200, long: false, question: false }); }
  },
  stop: { decision: 'deny', line: DENIED, settle: (w) => { w.inbound(DM, 'stop', { text: 'stop', noTag: true }); } },
  crash: { decision: undefined, line: RESTARTED, settle: (w) => restart(w, 'test: the station dies with the ask open') }
};

/* THE MATRIX: one row. `late`: the keyboard's answer is still on its way when the ask settles. */
async function row(pathName, late, refused) {
  const p = PATHS[pathName];
  const name = pathName + (late ? ', the keyboard landing after the settle' : ', the keyboard landed first') + (refused ? ', the first edit refused (429)' : '');
  await world(async (w) => {
    if (late) w.holdKeyboardAnswers();
    const tag = await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    if (!kb) { A.ok(false, name + ': fixture: the ask renders a keyboard'); return; }
    const run = runOf(w, tag);
    A.ok(!!run && !run.ended && run.decision === undefined, name + ': fixture: the run is paused on the ask');
    if (refused) w.editFaults.push('429');
    await p.settle(w, kb);
    await w.advance(100);
    if (late) {
      A.eq(editsOf(w, kb).length, 0, name + ': nothing can edit a keyboard whose message is not known yet');
      w.releaseKeyboardAnswers();
    }
    await w.advance(70000);
    const stamps = stampsOf(w, kb);
    A.eq(stamps.length, 1, name + ': exactly one edit lands on the keyboard (' + editsOf(w, kb).length + ' tried)');
    A.eq(editsOf(w, kb).length, refused ? 2 : 1, name + ': and nothing edits it again');
    if (stamps[0]) {
      A.eq(stamps[0].markup, false, name + ': the edit carries no reply_markup, which is what strips the buttons');
      A.eq(lastLine(stamps[0].text), p.line, name + ': the stamp names what the broker did');
      A.ok(/^🔐 Permission needed\n/.test(stamps[0].text) && /notes\.md/.test(stamps[0].text), name + ': under the words of the ask');
    }
    A.eq(leftOnDisk(w), [], name + ': the ledger holds nothing of it any more');
    A.eq(stampEvents(w), [], name + ': a stamp says nothing new to the chat: no channel.delivery is about it');
    if (p.decision) A.eq(run.decision, p.decision, name + ': the run got that decision');
    A.eq(w.journal.get(tag + '#0') || 0, p.decision === 'once' ? 1 : 0, name + ': and the action ran only on a yes');
    const edits = editsOf(w, kb).length;
    const cb = w.tap(kb, 3);
    await w.advance(2000);
    A.eq(editsOf(w, kb).length, edits, name + ': a late tap edits nothing');
    if (pathName === 'crash') A.ok(/no longer open/.test((w.toasts.get(cb) || {}).text || ''), name + ': and is told the question is no longer open');
  });
}

/* THE FAILURES: a row that ends with one stamp, naming the broker's decision */
async function oneStamp(name, line, kb, w, tries) {
  const stamps = stampsOf(w, kb);
  A.eq(stamps.length, 1, name + ': exactly one edit lands (' + editsOf(w, kb).length + ' tried)');
  if (stamps[0]) { A.eq(stamps[0].markup, false, name + ': the buttons go'); A.eq(lastLine(stamps[0].text), line, name + ': the stamp names what happened'); }
  if (tries) A.eq(editsOf(w, kb).length, tries, name + ': edits tried');
  A.eq(leftOnDisk(w), [], name + ': the ledger holds nothing of it any more');
  A.eq(tombstoned(w, 'stamp-gave-up'), 0, name + ': and it landed: it was not given up');
  A.eq(stampEvents(w), [], name + ': no channel.delivery is about it');
}
const logged = [];
const realError = console.error;
const spyOnLog = () => { console.error = (...a) => { const l = a.join(' '); if (/could not be stamped/.test(l)) logged.push(l); }; };
const stopSpying = () => { console.error = realError; };

async function failures() {
  const REMOTE = PATHS.remote;

  // the platform made the edit and its answer was lost: the retry finds it made
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('lost');
    await REMOTE.settle(w);
    await w.advance(20000);
    await oneStamp('an edit whose answer was lost', REMOTE.line, kb, w, 2);
  });

  // the process died with the edit made and its record not yet gone: the next process finds it made
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('crashAfter');
    await REMOTE.settle(w);
    await w.advance(100);
    A.eq(w.current().gen === w.gen, false, 'fixture: the station died as the platform made the edit');
    await restart(w);
    await w.advance(40000);
    await oneStamp('a crash after the platform made the edit', REMOTE.line, kb, w, 2);
  });

  // the process died with the stamp durable and not sent: the next process sends the broker's decision, not 'restarted'
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('crashBefore');
    await REMOTE.settle(w);
    await w.advance(100);
    await restart(w);
    await w.advance(40000);
    await oneStamp('a crash before the edit reached the platform', REMOTE.line, kb, w, 2);
  });

  // ...and under the backoff of a refused edit
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('429');
    await REMOTE.settle(w);
    await w.advance(1000);
    await restart(w, 'test: the station dies while the refused stamp waits out its backoff');
    await w.advance(40000);
    await oneStamp('a crash under a refused edit\'s backoff', REMOTE.line, kb, w, 2);
  });

  // the platform's retry_after is honored, past the lane's own 5 s
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('429:30');
    await REMOTE.settle(w);
    await w.advance(29000);
    A.eq(editsOf(w, kb).length, 1, 'a 429 with retry_after 30: nothing tries again before it runs out');
    await w.advance(40000);
    await oneStamp('a 429 with retry_after 30', REMOTE.line, kb, w, 2);
  });

  // a refused credential holds the stamp with the channel, until the re-paired bot's next 'up'
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('401');
    await REMOTE.settle(w);
    await w.advance(90000);
    A.eq(stampsOf(w, kb).length, 0, 'a refused credential: fixture: the edit was refused');
    w.up();
    await w.advance(1000);
    await oneStamp('a refused credential', REMOTE.line, kb, w, 2);
  });

  // the Commander deleted the keyboard: nothing to stamp, nothing to report, nothing to retry
  await world(async (w) => {
    const tag = await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('gone');
    logged.length = 0; spyOnLog();
    await REMOTE.settle(w);
    await w.advance(90000);
    stopSpying();
    A.eq([stampsOf(w, kb).length, editsOf(w, kb).length], [0, 1], 'a deleted keyboard: one try, never retried');
    A.eq(leftOnDisk(w), [], 'a deleted keyboard: the ledger holds nothing of it any more');
    A.eq(failedEvents(w), [], 'a deleted keyboard: no event says anything failed');
    A.eq(logged, [], 'a deleted keyboard: it parks silently');
    if (ledgerDoc(w)) A.eq(tombstoned(w, 'keyboard-gone'), 1, 'a deleted keyboard: a tombstone records it');
    A.ok(w.wire.some(m => m.text.indexOf('REPLY ' + tag + ' ') === 0), 'a deleted keyboard: the run still answers');
  });

  // a refusal for good: one line on the console, and never a reply's undeliverable report
  await world(async (w) => {
    const tag = await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.editFaults.push('refused');
    logged.length = 0; spyOnLog();
    await REMOTE.settle(w);
    await w.advance(90000);
    stopSpying();
    A.eq([stampsOf(w, kb).length, editsOf(w, kb).length], [0, 1], 'a refusal for good: one try, never retried');
    A.eq(leftOnDisk(w), [], 'a refusal for good: the ledger holds nothing of it any more');
    A.eq(failedEvents(w), [], 'a refusal for good: a stamp is no reply: no event calls anything undeliverable');
    if (ledgerDoc(w)) A.eq(logged.length, 1, 'a refusal for good: said once, on the console');
    A.ok(w.wire.some(m => m.text.indexOf('REPLY ' + tag + ' ') === 0), 'a refusal for good: the run still answers');
  });

  // a stamp that is refused on and on never holds the chat's reply for good: it is left, and the reply lands
  await world(async (w) => {
    const tag = await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    for (let i = 0; i < 40; i++) w.editFaults.push('502');
    logged.length = 0; spyOnLog();
    await REMOTE.settle(w);
    await w.advance(400000);
    stopSpying();
    A.ok(w.wire.some(m => m.text.indexOf('REPLY ' + tag + ' ') === 0), 'a stamp refused on and on: the reply behind it lands');
    A.eq(leftOnDisk(w), [], 'a stamp refused on and on: it is given up');
    if (ledgerDoc(w)) {
      A.eq(editsOf(w, kb).length, 9, 'a stamp refused on and on: its bounded retries, on the lane\'s backoff');
      A.eq(logged.length, 1, 'a stamp refused on and on: said once, on the console');
    }
    A.eq(stampEvents(w), [], 'a stamp refused on and on: no event calls anything undeliverable');
  });

  // writes fail while the ask settles: no edit starts until its record is durable, and it lands once after
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.writeFault = 'EBUSY';
    await REMOTE.settle(w);
    await w.advance(2500);
    if (ledgerDoc(w)) A.eq(editsOf(w, kb).length, 0, 'writes failing: no edit starts whose record is not durable');
    w.writeFault = '';
    await w.advance(40000);
    await oneStamp('writes failing at the settle', REMOTE.line, kb, w, 1);
  });

  // writes fail as the keyboard lands: the open ask reaches the disk when they recover, and a later crash still closes it
  await world(async (w) => {
    const tag = w.inbound(DM, 'message');
    asking(w, tag);
    await w.advance(380);    // the batch window has closed and the keyboard is about to go
    w.writeFault = 'EBUSY';
    await w.advance(1000);
    const kb = askKeyboards(w, DM).pop();
    if (!kb) { A.ok(false, 'writes failing: fixture: the keyboard landed'); w.writeFault = ''; return; }
    w.writeFault = '';
    await w.advance(40000);
    await restart(w, 'test: the station dies with the ask open');
    await w.advance(40000);
    await oneStamp('writes failing as the keyboard landed, then a crash', RESTARTED, kb, w, 1);
  });

  // the update barrier: no edit starts while it is up
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.holding = true;
    await REMOTE.settle(w);
    await w.advance(3000);
    if (ledgerDoc(w)) A.eq(editsOf(w, kb).length, 0, 'the update barrier: no edit starts while it is up');
    w.holding = false;
    await w.advance(40000);
    await oneStamp('the update barrier', REMOTE.line, kb, w, 1);
  });

  // a reconnect replaces the hub in the same process: the ask is alive, so it is never stamped 'restarted'; it ends on its
  // own, and the new hub's sender carries the stamp
  await world(async (w) => {
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    w.reconnect();
    await w.advance(40000);
    A.eq(editsOf(w, kb).length, 0, 'a reconnect: a live ask is not closed by the new hub');
    A.eq(openOnDisk(w).length, ledgerDoc(w) ? 1 : 0, 'a reconnect: it stays open on the ledger');
    await w.advance(100000);
    await oneStamp('a reconnect', PATHS.timeout.line, kb, w, 1);
  });

  // one crash, two asks: the one that settled says its decision, the one still open says the restart
  await world(async (w) => {
    await ask(w, DM);
    await ask(w, BOT);
    const dm = askKeyboards(w, DM).pop(), bot = askKeyboards(w, BOT).pop();
    if (!dm || !bot) { A.ok(false, 'two asks: fixture: both keyboards landed'); return; }
    A.eq(openOnDisk(w).length, ledgerDoc(w) ? 2 : 0, 'two asks: both are open on the ledger');
    w.editFaults.push('429');
    w.tap(dm, 3);
    await w.advance(500);
    await restart(w, 'test: the station dies with one stamp waiting and one ask open');
    await w.advance(40000);
    await oneStamp('two asks: the settled one', '▸ ❌ Deny', dm, w);
    await oneStamp('two asks: the open one', RESTARTED, bot, w, 1);
  }, { bot: true });

  // the agent bot's hub runs the same path
  await world(async (w) => {
    await ask(w, BOT);
    const kb = askKeyboards(w, BOT).pop();
    if (!kb) { A.ok(false, 'the agent bot: fixture: the keyboard landed'); return; }
    w.editFaults.push('429');
    w.tap(kb, 1);
    await w.advance(20000);
    await oneStamp('the agent bot: a tap, its first edit refused', '▸ ✅ Allow for this session', kb, w, 2);
  }, { bot: true });

  // THE ONE EXCEPTION: the keyboard's answer never came back, so nothing knows its message
  await world(async (w) => {
    w.holdKeyboardAnswers();
    await ask(w, DM);
    const kb = askKeyboards(w, DM).pop();
    if (!kb) { A.ok(false, 'the window: fixture: the platform took the keyboard'); return; }
    await restart(w, 'test: the station dies as the platform takes the keyboard');
    w.releaseKeyboardAnswers();
    await w.advance(40000);
    A.eq(w.editCalls.length, 0, 'the window: a keyboard whose id died with its process cannot be edited, and nothing tries');
    A.eq(leftOnDisk(w), [], 'the window: nothing is left waiting for it');
    const cb = w.tap(kb, 0);
    await w.advance(1000);
    A.ok(/no longer open/.test((w.toasts.get(cb) || {}).text || ''), 'the window: a late tap is told the question is no longer open');
  });

  // THE CHOICE STAMP RIDES THE SAME PATH ('choice:<token>')
  await world(async (w) => {
    const kb = await question(w, DM);
    if (!kb) { A.ok(false, 'a choice: fixture: the question carries a keyboard'); return; }
    w.plans.set(String(kb.tags[0]), { steps: 0, stepMs: 200, long: false, question: false });
    w.editFaults.push('429');
    w.tap(kb, 0);
    await w.advance(20000);
    await oneStamp('a choice, its first edit refused', '▸ choose #' + kb.tags[0], kb, w, 2);
  });
  await world(async (w) => {
    const kb = await question(w, DM);
    if (!kb) { A.ok(false, 'a choice: fixture: the question carries a keyboard'); return; }
    w.plans.set(String(kb.tags[0]), { steps: 0, stepMs: 200, long: false, question: false });
    const cb = w.tap(kb, 0);
    await w.advance(3000);
    const toast = w.toasts.get(cb), stamp = stampsOf(w, kb)[0];
    A.ok(!!toast && !!stamp && toast.seq < stamp.seq, 'a choice: the tap is answered first: its spinner never waits on the edit');
    await oneStamp('a choice', '▸ choose #' + kb.tags[0], kb, w, 1);
  });
  await world(async (w) => {
    const kb = await question(w, DM);
    if (!kb) { A.ok(false, 'a choice: fixture: the question carries a keyboard'); return; }
    w.plans.set(String(kb.tags[0]), { steps: 0, stepMs: 200, long: false, question: false });
    w.editFaults.push('crashBefore');
    w.tap(kb, 0);
    await w.advance(100);
    A.eq(w.current().gen === w.gen, false, 'a choice: fixture: the station died under its stamp');
    await restart(w);
    await w.advance(40000);
    await oneStamp('a choice, the station dying under its stamp', '▸ choose #' + kb.tags[0], kb, w, 2);
    A.eq(runOf(w, kb.tags[0]) ? 1 : 0, 1, 'a choice: and it was replayed: the tap is a durable receipt');
  });
  await world(async (w) => {
    const kb = await question(w, DM);
    if (!kb) { A.ok(false, 'a choice: fixture: the question carries a keyboard'); return; }
    w.plans.set(String(kb.tags[0]), { steps: 0, stepMs: 200, long: false, question: false });
    w.editFaults.push('gone');
    w.tap(kb, 0);
    await w.advance(20000);
    A.eq([stampsOf(w, kb).length, editsOf(w, kb).length], [0, 1], 'a choice whose message is gone: one try, never retried');
    A.ok(w.wire.some(m => m.text.indexOf('REPLY ' + kb.tags[0] + ' ') === 0), 'a choice whose message is gone: the tapped choice still runs');
  });
}

/* THE WALK: asks in two chats, settled every way, with refused, lost and crashing edits, crashes, failing writes and the
   update barrier drawn at random. Every keyboard the hub learned the message of ends with exactly one edit that lands. */
const WALK_SEEDS = 24;
async function walk(walkSeed) {
  const w = Sim.makeWorld(walkSeed, { bot: true });
  const rand = Sim.rng((walkSeed * 48271 + 11) >>> 0);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const label = 'walk seed ' + walkSeed + ' (replay: node test/channels.consent-stamp.property.test.js ' + walkSeed + ')';
  const counts = { ask: 0, settle: 0, fault: 0, crash: 0 };
  let thawAt = 0, liftAt = 0, releaseAt = 0;
  w.install();
  try {
    w.boot();
    await w.advance(500);
    w.current().store.saveChatRecord(Sim.OWNER, { approvals: true });
    w.current().bot.store.saveChatRecord(Sim.OWNER, { approvals: true });
    for (let i = 0; i < 60; i++) {
      if (w.current().gen !== w.gen) { await w.advance(0); w.boot(); }
      if (w.writeFault && w.now >= thawAt) { w.writeFault = ''; w.crashFree = w.now + 35000; }
      if (w.holding && w.now >= liftAt) w.holding = false;
      if (w.kbHold && w.now >= releaseAt) w.releaseKeyboardAnswers();
      const chat = pick([DM, BOT]);
      const open = askKeyboards(w, chat).filter(k => k.gen === w.gen && !k.settled);
      const r = rand();
      if (r < 0.32) {
        if (![...w.live.values()].some(x => x.gen === w.gen && x.chat === chat)) {
          if (rand() < 0.25 && !w.kbHold) { w.holdKeyboardAnswers(); releaseAt = w.now + 200 + Math.floor(rand() * 1500); }
          asking(w, w.inbound(chat, 'message')); counts.ask++;
        }
      } else if (r < 0.6) {
        const kb = open[open.length - 1];
        if (kb) {
          kb.settled = true; counts.settle++;
          const how = pick(['tap', 'tap', 'remote', 'estop', 'stop', 'timeout']);
          if (how === 'tap') w.tap(kb, Math.floor(rand() * 4));
          else if (how === 'remote') { const row = w.approvals.list().filter(x => x.surface === 'channel').pop(); if (row) w.approvals.answer(row.runId, row.promptId, 'once'); }
          else if (how === 'estop') { killAll(null, w.current().tg.hub._internals.inflight, w.current().bot.hub._internals.inflight); }
          else if (how === 'stop') w.inbound(chat, 'stop', { text: 'stop', noTag: true });
          else await w.advance(121000);
        }
      } else if (r < 0.78) {
        w.editFaults.push(pick(['429', '429', '502', 'lost', 'crashBefore', 'crashAfter'])); counts.fault++;
      } else if (r < 0.86) {
        if (w.canCrash()) { w.crash('the walk'); counts.crash++; }
      } else if (r < 0.92) {
        if (!w.writeFault) { w.writeFault = pick(['EBUSY', 'UPDATE_MUTATIONS_FROZEN']); w.crashFree = Infinity; thawAt = w.now + 1000 + Math.floor(rand() * 3000); }
      } else if (!w.holding) {
        w.holding = true; liftAt = w.now + 1000 + Math.floor(rand() * 3000);
      }
      await w.advance(100 + Math.floor(rand() * 1500));
    }
    w.releaseKeyboardAnswers();
    await w.quiesce();
    // a replayed message asks again, and recovery replays a channel's messages one at a time, each up to its ask's 120 s
    // timer: whatever is still at it here is a LIVE ask nobody settled yet, and the oracle below is about asks that ended
    const working = () => w.live.size > 0 || ((ledgerDoc(w) || {}).receipts || []).length > 0;
    for (let i = 0; i < 400 && working(); i++) await w.advance(31000);
    for (const kb of askKeyboards(w)) {
      const stamps = stampsOf(w, kb);
      const name = label + ': keyboard ' + kb.messageId + ' in ' + kb.chat;
      if (!kb.answered) { A.eq(stamps.length, 0, name + ': its answer never came back, so nothing can have stamped it'); continue; }
      if (kb.window) { A.ok(stamps.length <= 1, name + ': in the crash window, stamped once at most'); continue; }
      A.eq(stamps.length, 1, name + ': exactly one edit lands (' + editsOf(w, kb).length + ' tried)');
      if (stamps[0]) A.eq(stamps[0].markup, false, name + ': the buttons go');
    }
    A.eq(leftOnDisk(w), [], label + ': the ledger holds nothing of any keyboard');
    for (const [k, n] of w.journal) A.ok(n <= 1, label + ': tool step ' + k + ' ran ' + n + 'x');
    return { keyboards: askKeyboards(w).length, counts: counts };
  } finally { w.uninstall(); }
}

(async () => {
  const only = Number(process.argv[2]) || 0;
  if (only) { await walk(only); A.report('channels.consent-stamp.property.test (walk seed ' + only + ')'); return; }

  for (const pathName of Object.keys(PATHS)) {
    for (const late of [false, true]) {
      if (pathName === 'crash' && late) continue;   // the keyboard's answer dies with the process: the one exception, below
      for (const refused of [false, true]) await row(pathName, late, refused);
    }
  }
  await failures();
  const drawn = { keyboards: 0, ask: 0, settle: 0, fault: 0, crash: 0 };
  for (let s = 1; s <= WALK_SEEDS; s++) {
    const r = await walk(s);
    drawn.keyboards += r.keyboards;
    for (const k of Object.keys(r.counts)) drawn[k] += r.counts[k];
  }
  A.ok(drawn.keyboards >= WALK_SEEDS * 3 && drawn.settle >= WALK_SEEDS * 2 && drawn.crash >= WALK_SEEDS, 'the walk drew what it claims: ' + JSON.stringify(drawn));
  // the same manifest the delivery property checks: this station is still the production one
  A.eq(Sim.manifestProblems(), [], 'the lifted startTelegram bag is still the production call\'s');
  A.report('channels.consent-stamp.property.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
