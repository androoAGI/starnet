/* node test/channels.telegram.stream.test.js — P4: the reply is written in front of you (2026-07-29).

   Until now a long answer was a typing bubble followed, thirty seconds later, by a wall of text. The reference
   harness edits the message as the model streams, and that — not any single feature — is most of why theirs
   "feels" better.

   THE INVARIANT THIS FILE EXISTS TO DEFEND, and the plan's stated acceptance bar: **exactly one complete reply,
   whatever fails.** Streaming is an optimisation layered on the existing deliver() path, never a replacement,
   so every failure mode has to converge on the same place. The tests are written as failure modes first:

     · cannot seed              -> deliver() sends normally, nothing left behind
     · an intermediate edit 429s -> skipped, the final edit still carries the whole text
     · the FINAL edit fails      -> the partial is DELETED and the reply is sent whole (never half an answer
                                    sitting immediately above the real one)
     · the reply outgrows 4096   -> streaming stops, deliver() chunks, chunk 0 replaces the streamed message
     · the run is superseded     -> the partial is deleted; it answers a question that was withdrawn
     · "message is not modified" -> a success wearing a 400

   Fakes only: no network, and an injected clock so the throttle is deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

// a store with no delivery ledger of its own: the hub keeps its replies in a private, in-memory one
function fakeStore() {
  const hist = new Map();
  return {
    loadHistory: (a) => (hist.get(a) || []).slice(),
    appendTurn: (a, role, content) => { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord: () => null, saveChatRecord: () => {}
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };

// A hub whose clock we drive by hand, recording every wire call in order.
function mkHub(opts) {
  const o = opts || {};
  const wire = [];
  let t = 0;
  let mid = 0;
  const tick = (ms) => { t += (ms == null ? 5000 : ms); };
  const hub = makeChannelHub({
    store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
    now: () => t,
    streamMinChars: o.streamMinChars == null ? 10 : o.streamMinChars,
    streamMinMs: o.streamMinMs == null ? 1000 : o.streamMinMs,
    maxMessageLength: o.maxMessageLength || 4096,
    send: (chatId, text) => {
      wire.push({ op: 'send', text: String(text) });
      if (o.sendFails) return Promise.resolve({ ok: false, error: 'blocked', retryable: false });
      return Promise.resolve({ ok: true, messageId: 'm' + (++mid) });
    },
    editMessage: (chatId, messageId, text) => {
      wire.push({ op: 'edit', id: String(messageId), text: String(text) });
      const v = o.editResult ? o.editResult(wire.filter(w => w.op === 'edit').length, String(text)) : null;
      return Promise.resolve(v || { ok: true });
    },
    deleteMessage: (chatId, messageId) => { wire.push({ op: 'delete', id: String(messageId) }); return Promise.resolve({ ok: true }); },
    streamReplies: o.streamReplies,
    runOnce: o.runOnce || (async (r) => {
      r.emit('agent.run.start', { agentId: r.agentId, runId: r.runId, trigger: 'event', model: r.model });
      for (const d of (o.deltas || ['Hello there, this is the ', 'first part of a long answer. ', 'And here is the rest of it.'])) {
        r.emit('agent.token', { agentId: r.agentId, runId: r.runId, delta: d });
        tick(o.gapMs);
        await new Promise(res => setImmediate(res));   // let the fire-and-forget edit land before the next delta
      }
      r.emit('agent.run.end', { agentId: r.agentId, runId: r.runId, reason: 'done', turns: 1, usd: 0 });
    })
  });
  return { hub, wire, tick, say: (text) => hub.onInbound({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: text || 'hi', messageId: '1', ts: 1 }) };
}

// Everything the member can actually read afterwards, in order.
function visible(wire) {
  const msgs = new Map(); const order = [];
  for (const w of wire) {
    if (w.op === 'send') { const id = 'm' + (msgs.size + 1); msgs.set(id, w.text); order.push(id); }
    else if (w.op === 'edit') { if (msgs.has(w.id)) msgs.set(w.id, w.text); }
    else if (w.op === 'delete') { msgs.delete(w.id); const i = order.indexOf(w.id); if (i >= 0) order.splice(i, 1); }
  }
  return order.filter(id => msgs.has(id)).map(id => msgs.get(id));
}

async function run() {
  const FULL = 'Hello there, this is the first part of a long answer. And here is the rest of it.';

  // ---- A. the happy path: one message, grown in place ----
  {
    const { wire, say } = mkHub({});
    await say();
    await new Promise(r => setImmediate(r));
    A.eq(wire.filter(w => w.op === 'send').length, 1, 'exactly ONE message is ever sent — the rest is edits');
    A.ok(wire.filter(w => w.op === 'edit').length >= 1, 'and it is grown by editing that message');
    A.eq(wire.filter(w => w.op === 'delete').length, 0, 'nothing needs cleaning up on the happy path');
    A.eq(visible(wire), [FULL], 'the member is left with exactly one message, holding the complete reply');
    A.eq(wire.find(w => w.op === 'send').text.length >= 10, true, 'the seed is real content, not a placeholder to be replaced later');
  }

  // ---- B. THE PLAN'S ACCEPTANCE BAR: the final text lands even when EVERY edit fails ----
  {
    const { wire, say } = mkHub({ editResult: () => ({ ok: false, error: 'Bad Request: something' }) });
    await say();
    await new Promise(r => setImmediate(r));
    A.eq(visible(wire), [FULL], 'every single edit failed and the member STILL has exactly one complete reply');
    A.eq(wire.filter(w => w.op === 'delete').length, 1, 'the stranded partial was deleted…');
    A.eq(wire.filter(w => w.op === 'send').length, 2, '…and the whole answer was sent fresh');
    const del = wire.findIndex(w => w.op === 'delete');
    const lastSend = wire.map(w => w.op).lastIndexOf('send');
    A.ok(del < lastSend, 'the delete happens BEFORE the resend — the two must never both be readable, even briefly');
  }

  // ---- C. an intermediate 429 is skipped; the final edit still carries everything ----
  {
    const { wire, say } = mkHub({ editResult: (n) => (n === 1 ? { ok: false, error: 'Too Many Requests', retryable: true, retryAfter: 1 } : { ok: true }) });
    await say();
    await new Promise(r => setImmediate(r));
    A.eq(visible(wire), [FULL], 'a rate-limited intermediate edit costs nothing — the complete reply still lands');
    A.eq(wire.filter(w => w.op === 'delete').length, 0, 'and nothing is deleted, because the final edit succeeded');
  }

  // ---- D. "message is not modified" is a success wearing a 400 ----
  {
    const { wire, say } = mkHub({ editResult: () => ({ ok: false, error: 'Bad Request: message is not modified' }) });
    await say();
    await new Promise(r => setImmediate(r));
    A.eq(wire.filter(w => w.op === 'delete').length, 0, 'we streamed the exact final text, so there is nothing stranded to delete');
    A.eq(wire.filter(w => w.op === 'send').length, 1, 'and nothing is re-sent — that would be the duplicate this whole design exists to avoid');
  }

  // ---- E. a reply that outgrows one message ----
  {
    const long = 'x'.repeat(90);
    const { wire, say } = mkHub({ maxMessageLength: 100, deltas: [long, long, long], streamMinChars: 10 });
    await say();
    await new Promise(r => setImmediate(r));
    const seen = visible(wire);
    A.eq(seen.length, 3, 'a reply past the single-message limit is chunked, exactly as before streaming existed');
    A.eq(seen.join(''), 'x'.repeat(270), 'and not one character is lost or duplicated across the chunks');
    A.eq(wire.filter(w => w.op === 'delete').length, 0, 'chunk 0 REPLACED the streamed message, so there was nothing to clean up');
    A.eq(wire.filter(w => w.op === 'send').length, 3, 'one seed reused for chunk 0, plus the two remaining chunks');
    // The real reason streaming STOPS at the limit rather than merely letting deliver() clean up after it: an
    // edit carrying more than a message can hold is a guaranteed "message is too long" 400 — a wasted call that
    // also leaves the stream believing it displayed text it never displayed.
    A.eq(wire.filter(w => w.op === 'edit' && w.text.length > 100).length, 0,
      'not one edit is ever attempted with more text than a single message can hold');
  }

  // ---- F. the run is withdrawn mid-stream ----
  {
    let released = null, runNo = 0;
    const gate = new Promise(r => { released = r; });
    const h = mkHub({
      // Distinct text per run: the withdrawn run's partial must vanish while the replacement's answer stays.
      runOnce: async (r) => {
        const mine = ++runNo;
        r.emit('agent.run.start', { agentId: r.agentId, runId: r.runId, trigger: 'event', model: r.model });
        r.emit('agent.token', { agentId: r.agentId, runId: r.runId, delta: 'answer number ' + mine + ', half way through an ans' });
        await new Promise(res => setImmediate(res));
        if (mine === 1) await gate;   // hold the first run open so a second message can supersede it
        r.emit('agent.run.end', { agentId: r.agentId, runId: r.runId, reason: 'done', turns: 1, usd: 0 });
      }
    });
    const first = h.say('a question');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    A.eq(h.wire.filter(w => w.op === 'send').length, 1, 'the partial answer is on screen');
    const second = h.say('actually, never mind');   // supersedes
    released();
    await first; await second;
    await new Promise(r => setImmediate(r));
    A.ok(h.wire.some(w => w.op === 'delete'), 'the withdrawn run\'s partial is DELETED — a half answer to a question nobody is waiting for is worse than none');
    const left = visible(h.wire);
    A.eq(left.some(t => /answer number 1/.test(t)), false, 'the withdrawn run\'s text is genuinely gone from what the member can read');
    A.eq(left.filter(t => /answer number 2/.test(t)).length, 1, 'and the replacement\'s answer is there exactly once');
  }

  // ---- G. a channel that cannot edit is byte-identical to before streaming existed ----
  {
    const plain = [];
    const hub = makeChannelHub({
      store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      send: (c, t) => { plain.push(String(t)); return Promise.resolve({ ok: true, messageId: 'x' }); },
      runOnce: async (r) => {
        r.emit('agent.run.start', { agentId: r.agentId, runId: r.runId, trigger: 'event', model: r.model });
        r.emit('agent.token', { agentId: r.agentId, runId: r.runId, delta: 'a complete answer, sent once' });
        r.emit('agent.run.end', { agentId: r.agentId, runId: r.runId, reason: 'done', turns: 1, usd: 0 });
      }
    });
    await hub.onInbound({ channel: 'discord', chatId: '900', chatType: 'dm', userId: '5', text: 'hi', messageId: '1', ts: 1 });
    A.eq(plain, ['a complete answer, sent once'], 'no editMessage/deleteMessage wired = no streaming, one send, unchanged');

    // wiring only HALF the pair must not arm it either: growing a reply with no way to clear a stranded partial
    // is precisely how a failed edit becomes a duplicate.
    const halfWire = [];
    const half = makeChannelHub({
      store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(), now: () => 0,
      send: (c, t) => { halfWire.push('send'); return Promise.resolve({ ok: true, messageId: 'x' }); },
      editMessage: () => { halfWire.push('edit'); return Promise.resolve({ ok: true }); },
      runOnce: async (r) => {
        r.emit('agent.run.start', { agentId: r.agentId, runId: r.runId, trigger: 'event', model: r.model });
        r.emit('agent.token', { agentId: r.agentId, runId: r.runId, delta: 'a long enough answer to seed a stream with' });
        r.emit('agent.run.end', { agentId: r.agentId, runId: r.runId, reason: 'done', turns: 1, usd: 0 });
      }
    });
    await half.onInbound({ channel: 'telegram', chatId: '900', chatType: 'dm', userId: '5', text: 'hi', messageId: '1', ts: 1 });
    A.eq(halfWire, ['send'], 'editMessage without deleteMessage does NOT arm streaming');
    A.eq(half._internals.streamOk, false, 'both halves of the pair are required');
  }

  // ---- H. the throttle is real, and the seed waits for something worth showing ----
  {
    const { wire, say } = mkHub({ streamMinMs: 10000, gapMs: 1, deltas: ['aaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbb', 'ccccccccccccccc'] });
    await say();
    await new Promise(r => setImmediate(r));
    A.eq(wire.filter(w => w.op === 'edit').length, 1, 'inside one throttle window the intermediate deltas are dropped — only the FINAL edit lands');

    const short = mkHub({ streamMinChars: 500, deltas: ['tiny'] });
    await short.say();
    await new Promise(r => setImmediate(r));
    A.eq(short.wire.filter(w => w.op === 'edit').length, 0, 'a reply shorter than the seed threshold never streams at all…');
    A.eq(visible(short.wire), ['tiny'], '…and is simply delivered, once, the old way');
  }

  /* ---- I. NEVER STREAM A PROTOCOL MARKER ------------------------------------------------------------------
     The reply the member reads is not always the raw buffer. A "TASK_QUESTION: …" answer is parsed, stripped and
     re-rendered as a numbered list with a keyboard under it — so streaming the buffer would put the internal
     marker on their screen for several seconds before it turned into the real thing. Caught by the real-sidecar
     buttons e2e, which is where the raw marker first showed up on the wire. */
  {
    const { wire, say } = mkHub({
      deltas: ['TASK_QUESTION: Which deployment target', ' should I use? || staging | production'],
      streamMinChars: 5
    });
    await say();
    await new Promise(r => setImmediate(r));
    // (this fake hub has no taskIntent, so the marker legitimately survives into the FINAL delivery — what must
    // never happen is it being shown EARLY, while the real reply is still being assembled)
    A.eq(wire.filter(w => w.op === 'edit').length, 0, 'a marker reply does not stream at all…');
    A.eq(wire.filter(w => w.op === 'send').length, 1, '…so the only thing on the wire is the one final delivery');
    A.eq(wire.length, 1, 'and not a single extra call was made — nothing was shown early and then corrected');

    // ordinary prose that merely contains a colon must still stream
    const ok = mkHub({ deltas: ['Right, here is what I found: the build', ' failed on the second step.'], streamMinChars: 5 });
    await ok.say();
    await new Promise(r => setImmediate(r));
    A.ok(ok.wire.filter(w => w.op === 'edit').length >= 1, 'a normal sentence with a colon in it is not mistaken for a marker');
  }

  // ---- J. streaming can be turned off, and then nothing about the old path changes ----
  {
    const { wire, say } = mkHub({ streamReplies: false });
    await say();
    await new Promise(r => setImmediate(r));
    A.eq(wire.filter(w => w.op === 'edit').length, 0, 'streamReplies:false disarms it');
    A.eq(visible(wire), [FULL], 'and the reply is delivered whole, exactly once');
  }

  A.report('channels.telegram.stream');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
