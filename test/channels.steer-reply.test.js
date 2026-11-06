/* node test/channels.steer-reply.test.js — a steered Telegram reply (bug e903a199).
   The loop echoes a folded steering note as ONE token delta, '\n[steering] <note>\n' (loop.js foldSteerNotes), and
   the NOT-applied notice at a run's end the same way. The hub buffered every delta raw, so the phone got the internal
   marker as prose with the answer before the note and the answer after it glued around it. Drives a REAL hub with a
   fake runOnce that emits exactly the loop's wire shapes. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub, joinReplyDelta } = require('../sidecar/channels/hub.js');

function fakeStore() {
  const hist = new Map();
  return {
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord() { return null; }
  };
}
const dm = (text) => ({ channel: 'telegram', chatId: '4242', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });

async function replyFor(deltas) {
  const sends = [];
  let n = 0;
  const runOnce = async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
    for (const d of deltas) {
      if (d === '<tool>') o.emit('agent.tool_call', { agentId: o.agentId, runId: o.runId, name: 'web.search' });
      else o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: d });
    }
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', usd: 0 });
  };
  const hub = makeChannelHub({
    runOnce, store: fakeStore(), send: (chatId, text) => { sends.push(text); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); },
    secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'run' + (++n)
  });
  await hub.onInbound(dm('slow task eight'));
  return sends;
}

async function run() {
  // ---- 1. the finish-line fold (the bug's own repro): answer, note, the model's paragraph break, second answer ----
  {
    const sends = await replyFor(['answer to slow task eight', '\n[steering] also add a sonnet\n', '\n\n', 'ACK[slow task eight]']);
    A.eq(sends.length, 1, 'one reply');
    A.ok(!/\[steering\]/.test(sends[0]), 'the internal [steering] marker never reaches the phone: ' + JSON.stringify(sends[0]));
    A.eq(sends[0], 'answer to slow task eight\n\n↪ also add a sonnet\n\nACK[slow task eight]',
      'both answers are kept, the note is a readable line of its own with one blank line either side');
  }
  // ---- 2. folded after a tool step: the pre-tool text was already reset; the reply opens on the note ----
  {
    const sends = await replyFor(['Let me look.', '<tool>', '\n[steering] make it shorter\n', 'Short answer.']);
    A.eq(sends, ['↪ make it shorter\n\nShort answer.'], 'no leading blank lines, no marker, the note then the answer');
  }
  // ---- 3. the NOT-applied notice at the run's end is still said, readably ----
  {
    const note = '1 steering note arrived as this run was ending and was NOT applied — send it as a new message.';
    const sends = await replyFor(['Done.', '\n[steering] ' + note + '\n']);
    A.eq(sends.length, 1, 'one reply');
    A.eq(sends[0].trim(), 'Done.\n\n↪ ' + note, 'the unapplied warning survives as its own line');
  }
  // ---- 4. ordinary deltas are untouched (byte-identical joins, a "[steering]" mid-line is just text) ----
  A.eq(joinReplyDelta('Hello ', 'Commander'), 'Hello Commander', 'plain join');
  A.eq(joinReplyDelta('a\n\n', '\n\nb'), 'a\n\n\n\nb', 'model whitespace is never collapsed outside a steer line');
  A.eq(joinReplyDelta('x', ' [steering] is a word here'), 'x [steering] is a word here', 'a delta that is not the echo shape stays prose');

  // ---- 5. a note with a line break in it (a steer posted by any client that does not flatten its note) ----
  A.eq(joinReplyDelta('answer one', '\n[steering] also add a sonnet\nand make it rhyme\n'),
    'answer one\n\n↪ also add a sonnet and make it rhyme\n\n', 'a multi-line echo is still one readable note line, never the raw marker');

  // ---- 6. TWO QUICK BUBBLES while a run works: the text batch joins them with a newline before the steer. The note
  //         goes to the run on ONE line (the rule every reader of the echo relies on — COMMS's steerWire), so the phone
  //         gets one note line between the two answers. Real hub, real text batching, the loop's exact echo shape. ----
  {
    const sends = [], steers = [];
    let n = 0, release;
    const gate = new Promise(r => { release = r; });
    const hub = makeChannelHub({
      channel: 'telegram', store: fakeStore(), textBatchWaitMs: 30,
      runOnce: async (o) => {
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'answer one' });
        await gate;
        for (const s of steers) o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: '\n[steering] ' + s.trim() + '\n' });
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: '\n\nanswer two' });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', usd: 0 });
      },
      steerRun: async (runId, text) => { steers.push(text); return { ok: true }; },
      isOwner: (m) => m.userId === 'u1', ownerTrusted: (m) => m.userId === 'u1' && m.chatType === 'dm',
      send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'run' + (++n)
    });
    const bubble = (text, id) => Object.assign(dm(text), { messageId: id });
    const first = hub.onInbound(bubble('write me a poem', '1'));
    await new Promise(r => setTimeout(r, 80));
    await Promise.all([hub.onInbound(bubble('also add a sonnet', '2')), hub.onInbound(bubble('and make it rhyme', '3'))]);
    release(); await first;
    A.eq(steers, ['also add a sonnet and make it rhyme'], 'the batched note reaches the run on one line');
    const last = sends[sends.length - 1];
    A.ok(!/\[steering\]/.test(last), 'no raw marker reaches the phone: ' + JSON.stringify(last));
    A.eq(last, 'answer one\n\n↪ also add a sonnet and make it rhyme\n\nanswer two', 'both answers, the note on its own line between them');
  }

  A.report();
}
run().catch(e => { console.error(e); process.exit(1); });
