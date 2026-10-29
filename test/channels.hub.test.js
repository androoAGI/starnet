/* node test/channels.hub.test.js — the messaging bridge: inbound -> runOnce -> streamed reply (C5).
   Fake runOnce/store/send (no network, no real loop). Covers: reply assembled from agent.token deltas,
   user+assistant persisted, channel.inbound/delivery telemetry, error/capdenied surfacing, long-reply
   chunking, not-configured guard, surface:'autonomous' + task classification, and abort-on-new-message. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub, chunkText, endNote } = require('../sidecar/channels/hub.js');

function fakeStore() {
  const hist = new Map(), recs = new Map(), appends = [];
  return {
    hist, recs, appends,
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); appends.push({ a, role, content }); return arr; },
    getChatRecord(c) { return recs.get(String(c)); }
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = (text, chatId) => ({ channel: 'telegram', chatId: chatId || '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });
// yield the event loop until pred() is true (or a bounded number of macrotask ticks elapse — never hangs the suite).
async function waitFor(pred, ticks) {
  for (let i = 0; i < (ticks || 200); i++) { if (pred()) return; await new Promise(r => setTimeout(r, 0)); }
  throw new Error('waitFor: predicate never became true');
}

async function run() {
  // ---- A. happy path: tokens -> reply -> send; user+assistant persisted; inbound/delivery emitted ----
  {
    const sends = [], events = []; const store = fakeStore(); let lastRun = null;
    const runOnce = async (o) => {
      lastRun = o;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Hello ' });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Commander' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (chatId, text) => { sends.push({ chatId, text }); return Promise.resolve({ ok: true, messageId: 'm' + (sends.length) }); },
      secrets: () => ({ key: 'k', model: 'anthropic/claude-sonnet-4.6' }), classify: () => false,
      emit: (n, p) => events.push({ n, p }), newId: idGen()
    });
    await hub.onInbound(dm('hi'));
    A.eq(sends, [{ chatId: '555', text: 'Hello Commander' }], 'reply assembled from token deltas, sent once');
    A.eq(store.hist.get('tg_555'), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello Commander' }], 'user + assistant turns persisted');
    A.eq(lastRun.agentId, 'tg_555', 'chatId -> tg_<chatId> agentId');
    A.eq(lastRun.surface, 'autonomous', 'headless chat runs autonomous (no live consent prompt)');
    A.eq(lastRun.messages, [{ role: 'user', content: 'hi' }], 'messages replayed (prior history + new user turn)');
    A.ok(events.some(e => e.n === 'channel.inbound' && e.p.agentId === 'tg_555' && e.p.kind === 'dm'), 'channel.inbound emitted');
    A.ok(events.some(e => e.n === 'channel.delivery' && e.p.ok === true && e.p.chunks === 1 && e.p.reason === 'done'), 'channel.delivery ok=true');
  }

  // ---- A2. ingress authority is passed only when the composition root identifies this exact message as owner DM ----
  {
    const store = fakeStore(); const seen = [];
    const runOnce = async (o) => {
      seen.push(o.ownerTrusted);
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' });
    };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false,
      ownerTrusted: (msg) => msg.channel === 'telegram' && msg.chatType === 'dm' && msg.userId === 'owner', newId: idGen()
    });
    await hub.onInbound(Object.assign(dm('owner request', 'owner-chat'), { userId: 'owner' }));
    await hub.onInbound(dm('ordinary request', 'guest-chat'));
    A.eq(seen, [true, false], 'only the admitted owner DM carries trusted remote-control authority into runOnce');
  }

  // ---- B. prior history is replayed; isTask=true adds the task suffix to the system prompt ----
  {
    const store = fakeStore(); store.hist.set('tg_9', [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'sure' }]);
    let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen() });
    await hub.onInbound(dm('research foo', '9'));
    A.eq(lastRun.isTask, true, 'classify -> isTask');
    A.ok(/task/i.test(lastRun.system), 'task suffix added to system when isTask');
    A.eq(lastRun.messages.length, 3, 'history (2) + new user turn replayed');
    A.eq(lastRun.messages[2], { role: 'user', content: 'research foo' }, 'newest user turn last');
  }

  // ---- B1. "yes" to the agent's offer is a task: the hub re-asks the REAL classifier with the agent's last reply ----
  {
    const { isTaskDirective } = require('../frontend/app/classify.js');
    const runs = [];
    const runOnce = async (o) => { runs.push(o); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const store = fakeStore();
    store.hist.set('tg_31', [{ role: 'user', content: 'plan the welcome note' }, { role: 'assistant', content: 'Here is the plan. Want me to draft it?' }]);
    store.hist.set('tg_32', [{ role: 'user', content: 'thanks for that' }, { role: 'assistant', content: 'Any time. Anything else?' }]);
    const hub = makeChannelHub({ runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: isTaskDirective, newId: idGen() });
    await hub.onInbound(dm('yes please', '31'));
    A.eq(runs[0].isTask, true, '"yes please" after "want me to draft it?" runs as a task');
    A.ok(/task/i.test(runs[0].system), '…with the task prompt');
    await hub.onInbound(dm('yes', '32'));
    A.eq(runs[1].isTask, false, '"yes" after a plain question stays chat');
  }

  // ---- B2. configured agentId + system: runs as the SAME app agent (shared memory) with its real prompt ----
  {
    const store = fakeStore(); let lastRun = null; const sends = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'hi' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm', agentId: 'agent', system: 'You are ULTRON, the Commander\'s agent.' }), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('hey'));
    A.eq(lastRun.agentId, 'agent', 'configured agentId used verbatim (same as the app -> shared notebook/memory/workspace)');
    A.ok(lastRun.system.indexOf('You are ULTRON, the Commander\'s agent.') === 0, 'the REAL composed system prompt is used, not the default persona');
    A.eq((store.hist.get('agent') || []).length, 2, 'history stored under the shared agentId');
    A.eq(store.hist.has('tg_555'), false, 'did NOT create a separate tg_<chatId> agent');
  }

  // ---- B3. a STRING persona (or none) is the run's persona — never a function's source text ----
  // Live-caught on the wire 2026-10-20 (sweep/channels): every station-bot run with no configured system prompt reached
  // the provider with a system prompt that began "() => p" — the persona fallback's factory was never invoked, so the
  // run got the source text of an arrow function instead of TELEGRAM_PERSONA / DISCORD_PERSONA / the default persona.
  {
    const runs = [];
    const runOnce = async (o) => { runs.push(o); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); };
    const mk = (persona) => makeChannelHub(Object.assign({ runOnce, store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() }, persona === undefined ? {} : { persona }));
    await mk('You are the TELEGRAM persona.').onInbound(dm('hello'));
    A.ok(runs[0].system.indexOf('You are the TELEGRAM persona.') === 0, 'a string persona opens the system prompt: ' + JSON.stringify(runs[0].system.slice(0, 40)));
    await mk(undefined).onInbound(dm('hello'));
    A.ok(runs[1].system.indexOf('You are the Commander\'s AI agent') === 0, 'no persona -> the default persona: ' + JSON.stringify(runs[1].system.slice(0, 40)));
    A.ok(runs.every(r => !/=>/.test(r.system.slice(0, 20))), 'no run is handed function source as its persona');
  }

  // ---- B3. Codex OAuth config: no API key is required, but provider must reach runOnce ----
  {
    const store = fakeStore(); let lastRun = null; const sends = [];
    const runOnce = async (o) => {
      lastRun = o;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'codex-ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ provider: 'codex', model: 'gpt-5.3-codex', agentId: 'agent' }),
      classify: () => false, newId: idGen()
    });
    await hub.onInbound(dm('hi'));
    A.eq(sends, ['codex-ok'], 'Codex Telegram config runs without an API key');
    A.eq(lastRun.provider, 'codex', 'provider=codex passed into runOnce');
    A.eq(lastRun.key, '', 'Codex run does not receive an API key placeholder');
    A.eq(lastRun.reasoningEffort, 'low', 'Codex channel default reasoning effort is low');
  }

  // ---- C. error / capdenied surfaced; assistant turn NOT persisted on error ----
  {
    const store = fakeStore(); const sends = [];
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: 'boom', transient: false }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('hi'));
    A.eq(sends, ['⚠ boom'], 'run error surfaced to the chat');
    A.eq((store.hist.get('tg_555') || []).filter(m => m.role === 'assistant').length, 0, 'no assistant turn persisted on error');
  }

  // ---- D. endReason != done appends a note ----
  {
    const store = fakeStore(); const sends = [];
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'partial' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'max_iters', turns: 16, usd: 0.1 }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen() });
    await hub.onInbound(dm('do it'));
    A.ok(/partial/.test(sends[0]) && /continue/.test(sends[0]), 'max_iters reply carries the partial + a continue hint');
  }

  // ---- E. long reply chunked to maxMessageLength; channel.delivery.chunks reflects it ----
  {
    const store = fakeStore(); const sends = [], events = [];
    const big = 'wordone wordtwo wordthree wordfour wordfive wordsix';   // 50 chars, spaces to break on
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: big }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, maxMessageLength: 20, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: (n, p) => events.push({ n, p }), newId: idGen() });
    await hub.onInbound(dm('hi'));
    A.ok(sends.length >= 3, 'reply split into multiple <=20-char messages');
    A.ok(sends.every(s => s.length <= 20), 'every chunk within the length limit');
    A.eq(sends.join(''), big, 'chunks concatenate back to the full reply (no chars lost at breaks)');
    const del = events.find(e => e.n === 'channel.delivery');
    A.eq(del.p.chunks, sends.length, 'delivery chunk count matches');
  }

  // ---- F. not configured (no key/model) -> friendly connect message; runOnce NOT called ----
  {
    const store = fakeStore(); const sends = []; let ran = false;
    const hub = makeChannelHub({ runOnce: async () => { ran = true; }, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({}), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('hi'));
    A.eq(ran, false, 'runOnce not called when unconfigured');
    A.ok(/Messaging tab/.test(sends[0]), 'tells the user to connect in the app');
  }

  // ---- G. one run per chat: a new message ABORTS the in-flight run; only the latest is answered ----
  {
    const store = fakeStore(); const sends = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      if (call === 1) {   // first run parks until aborted by the second message
        await new Promise(res => { if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 0, usd: 0 });
        return;
      }
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'second-reply' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const p1 = hub.onInbound(dm('first'));   // parks
    await hub.onInbound(dm('second'));         // aborts the first, runs + delivers
    await p1;                                  // first unwinds: superseded -> no delivery
    // 2026-10-11: superseded, never SILENT — a one-line notice that the earlier task stopped, then the newer reply; no stale partial
    A.eq(sends.length, 2, 'the stop notice + the latest reply');
    A.ok(/Stopped the earlier task/.test(sends[0]), 'the chat is told the earlier task was stopped for the newer message');
    A.eq(sends[1], 'second-reply', 'only the latest message is answered (first run superseded, no partial sent)');
  }

  // ---- H. onStatus -> channel.connect; pure helpers ----
  {
    const events = [];
    const hub = makeChannelHub({ runOnce: async () => {}, store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), emit: (n, p) => events.push({ n, p }), newId: idGen() });
    hub.onStatus({ state: 'up' });
    hub.onStatus({ state: 'error', detail: '401' });
    A.ok(events.some(e => e.n === 'channel.connect' && e.p.state === 'up'), 'status up -> channel.connect up');
    A.ok(events.some(e => e.n === 'channel.connect' && e.p.state === 'error' && e.p.detail === '401'), 'status error surfaced');
    A.eq(chunkText('abc', 10), ['abc'], 'short text -> single chunk');
    A.eq(chunkText('', 10), [], 'empty text -> no chunks');
    A.ok(endNote('max_iters').indexOf('continue') !== -1, 'endNote(max_iters) hints continue');
    A.eq(endNote('done'), endNote('done'), 'endNote deterministic');
  }

  // ---- I. construction guards ----
  {
    A.throws(() => makeChannelHub({ store: fakeStore(), send: () => {} }), 'missing runOnce throws');
    A.throws(() => makeChannelHub({ runOnce: async () => {}, send: () => {} }), 'missing store throws');
    A.throws(() => makeChannelHub({ runOnce: async () => {}, store: fakeStore() }), 'missing send throws');
  }

  // ---- J. Phase B routing: resolveAgent picks the agent; getTag threads the tag; null falls back ----
  {
    const store = fakeStore(); let lastRun = null; const tags = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      getTag: (text) => { tags.push(text); return /code/.test(text) ? 'code' : 'general'; },
      resolveAgent: (ctx) => ctx.tag === 'code' ? 'coder' : null
    });
    await hub.onInbound(dm('write code please'));
    A.eq(lastRun.agentId, 'coder', 'a routed message fires the bay-bound agent (not tg_<chatId>)');
    A.eq(tags[0], 'write code please', 'getTag receives the message text (the FILTER routing key)');
    A.eq((store.hist.get('coder') || []).length, 2, 'transcript stored under the routed agent');
    await hub.onInbound(dm('just chatting', '777'));
    A.eq(lastRun.agentId, 'tg_777', 'resolveAgent -> null falls back to tg_<chatId> (real work never stalls)');
  }

  // ---- J2. ONE-RESOLVER LAW: onResolved fires with the ROUTED agent, synchronously, never for /commands ----
  {
    const store = fakeStore(); const resolved = [];
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }),
      secrets: () => ({ key: 'k', model: 'm', agentId: 'overseer' }), classify: (t) => /research/.test(t), newId: idGen(),
      getTag: (t) => (/research/.test(t) ? 'research' : 'general'),
      resolveAgent: (ctx) => ctx.tag === 'research' ? 'researcher' : null,
      roster: () => [{ agentId: 'overseer', name: 'Overseer', model: 'm' }],
      onResolved: (info) => resolved.push(Object.assign({}, info))
    });
    const p = hub.onInbound(dm('research the market'));
    A.eq(resolved.length, 1, 'onResolved fired in onInbound\'s first synchronous slice (before any await)');
    A.eq(resolved[0].agentId, 'researcher', 'onResolved carries the FLOOR-ROUTED agent — the same one the run executes as');
    A.eq(resolved[0].chatId, '555', 'onResolved carries the chatId');
    A.eq(resolved[0].text, 'research the market', 'onResolved carries the message text (crate preview source)');
    A.eq(resolved[0].isTask, true, 'onResolved carries isTask=true for a task directive (the host places a crate only then)');
    await p;
    await hub.onInbound(dm('plain chat'));
    A.eq(resolved.length, 2, 'a second real message fires it again');
    A.eq(resolved[1].agentId, 'overseer', 'unrouted message resolves to the configured agent — same fallback the run uses');
    A.eq(resolved[1].isTask, false, 'pure chat resolves with isTask=false — BELT IS WORK-ONLY, "hello" puts nothing on the floor');
    await hub.onInbound(dm('/agents'));
    A.eq(resolved.length, 2, 'a /command NEVER fires onResolved — no phantom crate for control chatter');
  }

  // ---- J3. floor routing must NOT clobber an explicit /talk binding (B4 persist guard) ----
  {
    const store = fakeStore(); const saves = [];
    store.saveChatRecord = (chatId, rec) => { saves.push({ chatId: String(chatId), rec }); store.recs.set(String(chatId), rec); };
    store.recs.set('555', { agentId: 'overseer', channel: 'telegram' });   // the user's explicit /talk choice
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      resolveAgent: () => 'researcher'   // the floor routes EVERY message elsewhere
    });
    await hub.onInbound(dm('do the thing'));
    A.eq(saves.length, 0, 'floor-routed resolution did NOT overwrite the explicit binding');
    A.eq(store.recs.get('555').agentId, 'overseer', 'the chat still belongs to the agent the user chose');
    // an UNBOUND chat still records the resolved agent (the notifier needs some chat for that agent)
    await hub.onInbound(dm('hello', '777'));
    A.eq(saves.length, 1, 'unbound chat -> binding persisted');
    A.eq(saves[0], { chatId: '777', rec: { agentId: 'researcher', channel: 'telegram', streamId: 'channel_telegram_777' } }, 'unbound chat records the resolved agent (and its canonical stream, from the first message)');
  }

  /* ---- J4. WORK BELONGS TO A LINE (Andrew's ruling, 2026-08-07) ----
     "each conveyor system built has a purpose and a different workflow — the conveyor system should
     visually run ONLY when the specific workflow is running."

     Wired with the REAL router + the REAL chain runner over a REAL compiled THREE-stage floor, because the
     whole point is that one compiled plan decides for every surface. Two messages:
       · one the FLOOR routed in through the line's INBOX  -> the whole line runs;
       · one BOUND to a MID-LINE dock the door does not feed -> nothing triggered that workflow, so it
         answers there and stops, and the provider is never called for the stage after it (asserted by run
         count, not by absence of text).
     The origin test is "did it ride in through this line's door?", never "was it addressed?" — see the
     lineOriginOf note in pipeline.js for why a chat's persisted binding cannot answer that question. */
  {
    const Pipeline = require('../frontend/app/pipeline.js');
    const { makeRouter } = require('../sidecar/routing/router.js');
    const { makeChainRunner } = require('../sidecar/routing/chain.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' },
              { id: 'b3', t: 'bay', x: 10, y: 0, w: 1, h: 1, agentId: 'editor' },
              { id: 'o', t: 'outbox', x: 13, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'),
              belt(8, 0, 'E'), belt(9, 0, 'E'), belt(11, 0, 'E'), belt(12, 0, 'E')]
    });
    const router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'the three-stage floor deploys');
    A.eq(plan.reach.researcher, true, 'the INBOX feeds the entry dock');
    A.ok(!plan.reach.writer, 'and does NOT feed the mid-line dock — only the researcher hands work to it');

    const ranAgents = [];   // EVERY provider-buying run, entry dock and hops alike
    const runOnce = async (o) => {
      ranAgents.push(o.agentId);
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' output' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const chain = makeChainRunner({ nextAgent: (a, ctx) => router.chainNext(a, ctx), now: () => 0 });
    const store = fakeStore();
    store.saveChatRecord = () => {};
    store.recs.set('bound', { agentId: 'writer', channel: 'telegram' });   // a chat addressed at a MID-LINE stage
    const sends = [];
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      resolveAgent: (ctx) => router.resolveTarget(ctx), chain: chain,
      lineOriginFor: (agentId) => router.lineOriginFor(agentId),   // the EXACT seam index.js injects into every hub
      resolveRunConfig: () => ({ key: 'k', model: 'm', ok: true })
    });

    // (a) the LINE'S OWN TRIGGER: a channel message the belts walk from the INBOX to the entry dock
    await hub.onInbound(dm('research the competitors', 'open'));
    A.eq(ranAgents, ['researcher', 'writer', 'editor'], 'work that rode in through the door runs the WHOLE line');
    A.ok(/editor output/.test(sends[sends.length - 1].t), "and the LAST stage's answer is what leaves the station");

    // (a2) the SAME chat again, now carrying the binding the hub auto-saved: still the line's own work
    ranAgents.length = 0;
    store.recs.set('open', { agentId: 'researcher', channel: 'telegram' });
    await hub.onInbound(dm('research the competitors', 'open'));
    A.eq(ranAgents, ['researcher', 'writer', 'editor'], "the hub's own bookkeeping binding must not stop a channel driving its line");

    // (b) A MID-LINE STAGE, ADDRESSED DIRECTLY: no door feeds it, so nothing triggered that workflow
    ranAgents.length = 0;
    await hub.onInbound(dm('research the competitors', 'bound'));
    A.eq(ranAgents, ['writer'], 'an order aimed at a mid-line dock runs EXACTLY ONE run — nothing downstream');
    A.eq(ranAgents.indexOf('editor'), -1, 'PROVIDER CALLS for the later dock: zero — no money spent past the agent asked');
    A.ok(/writer output/.test(sends[sends.length - 1].t), "and the agent's own answer is what leaves");
    A.ok(!/work line stopped/.test(sends[sends.length - 1].t), 'no "the line stopped early" note — it was never a line run');
  }

  // ---- K. two chats routed to the SAME agent do NOT cross-cancel (supersede keyed by chatId, not agentId) ----
  {
    const store = fakeStore(); const sends = []; const parks = {};
    const runOnce = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      await new Promise(res => { parks[o.runId] = res; if (o.signal.aborted) res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'reply' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(), resolveAgent: () => 'shared'
    });
    const pa = hub.onInbound(dm('from-A', 'A'));   // chat A -> agent 'shared'
    const pb = hub.onInbound(dm('from-B', 'B'));   // chat B -> the SAME agent 'shared'
    for (const id in parks) parks[id]();           // release both in-flight runs
    await Promise.all([pa, pb]);
    A.eq(sends.length, 2, 'both chats got a reply — neither superseded the other despite sharing an agent');
    A.ok(sends.some(s => s.c === 'A') && sends.some(s => s.c === 'B'), 'each reply went back to its own chat');
  }

  // ---- G. a THROWING injected secrets() degrades to a logged error + polite reply, not an unhandled rejection ----
  {
    const store = fakeStore(); const sends = [];
    const runOnce = async () => { throw new Error('should never run'); };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => { throw new Error('secrets store hiccup'); }, classify: () => false, newId: idGen()
    });
    await hub.onInbound(dm('hi'));   // must NOT reject
    A.eq(sends.length, 1, 'one polite reply sent when secrets() throws');
    A.ok(/could not read the channel configuration/i.test(sends[0]), 'polite failure reply, no run started');
  }

  // ---- H. a THROWING injected rosterFn() inside a /command degrades to a polite reply (Discord passes it through) ----
  {
    const store = fakeStore(); const sends = [];
    const runOnce = async () => { throw new Error('should never run'); };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      roster: () => { throw new Error('roster read failed'); }
    });
    await hub.onInbound(dm('/agents'));   // a control command that reads the roster; must NOT reject
    A.eq(sends.length, 1, 'one polite reply sent when rosterFn() throws');
    A.ok(/could not read the agent roster/i.test(sends[0]), 'polite roster-failure reply');
  }

  // ---- L. supersede-race retry: the host's transient "already running a task" refusal (same-agent workspace
  // mutex) is RETRIED with backoff so the user's message is never silently dropped; a real reply eventually lands. --
  {
    const store = fakeStore(); const sends = []; const slept = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      if (call === 1) {   // first attempt loses the workspace-mutex race -> transient refusal (verbatim host text)
        o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, transient: true, message: 'That agent is already running a task. Wait for it to finish before starting another — one run at a time per agent (they share a workspace).' });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'error', turns: 0, usd: 0 });
        return;
      }
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'took over' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      sleep: (ms) => { slept.push(ms); return Promise.resolve(); }   // fake: instant, records the backoff schedule
    });
    await hub.onInbound(dm('take over please'));
    A.eq(call, 2, 'the supersede-race refusal was retried exactly once (2nd attempt succeeded)');
    A.eq(slept.length, 1, 'exactly one backoff wait before the successful retry');
    A.ok(slept[0] > 0, 'backoff waited a positive amount (the aborted run\'s slot needs time to free)');
    A.eq(sends.length, 1, 'the user got ONE reply, not the internal mutex refusal');
    A.eq(sends[0].t, 'took over', 'the reply is the successful retry\'s real answer');
    A.ok(!/already running a task/i.test(sends[0].t), 'the raw host mutex message never reaches the user');
  }

  // ---- L2. exhausted supersede-retry -> an HONEST "still busy" reply (message not lost, user can resend). Also
  // proves the backoff is BOUNDED (does not loop forever) and grows (exponential). ----
  {
    const store = fakeStore(); const sends = []; const slept = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, transient: true, message: 'That agent is already running a task. Wait for it to finish before starting another — one run at a time per agent (they share a workspace).' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'error', turns: 0, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      supersedeRetries: 3, supersedeBackoffMs: 100, sleep: (ms) => { slept.push(ms); return Promise.resolve(); }
    });
    await hub.onInbound(dm('never frees'));
    A.eq(call, 4, 'bounded: 1 initial + exactly 3 retries, then it gives up (no infinite loop)');
    A.eq(slept, [100, 200, 400], 'exponential backoff schedule (100·2^n) across the 3 retries');
    A.eq(sends.length, 1, 'exactly one reply on exhaustion');
    A.ok(/still busy/i.test(sends[0]) && /again/i.test(sends[0]), 'honest "still busy — try again" reply on exhausted retries');
    A.ok(!/already running a task/i.test(sends[0]), 'never leaks the internal mutex message even on exhaustion');
    A.eq((store.hist.get('tg_555') || []).filter(m => m.role === 'assistant').length, 0, 'no assistant turn persisted on exhaustion');
  }

  // ---- L3. OTHER error classes are NOT retried (only the workspace-mutex race is) — a hard error and the DISTINCT
  // 'too many agents' cap refusal both surface immediately, once. ----
  {
    // a NON-transient hard error: surface it verbatim, zero retries.
    const store = fakeStore(); const sends = []; const slept = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, transient: false, message: 'boom' });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      sleep: (ms) => { slept.push(ms); return Promise.resolve(); }
    });
    await hub.onInbound(dm('hi'));
    A.eq(call, 1, 'a hard (non-transient) error is NOT retried');
    A.eq(slept.length, 0, 'no backoff for a non-retryable error');
    A.eq(sends, ['⚠ boom'], 'the hard error surfaces verbatim, once');
  }
  {
    // a DIFFERENT transient (the 'too many agents' concurrency cap) is NOT the workspace-mutex race -> not retried.
    const store = fakeStore(); const sends = []; const slept = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, transient: true, message: 'Too many agents are working at once (limit 6). Wait for one to finish, or raise STARNET_MAX_CONCURRENT_AGENTS.' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'error', turns: 0, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      sleep: (ms) => { slept.push(ms); return Promise.resolve(); }
    });
    await hub.onInbound(dm('hi'));
    A.eq(call, 1, 'a DIFFERENT transient (concurrency cap) is NOT retried — only the workspace-mutex race is');
    A.eq(slept.length, 0, 'no backoff for the unrelated transient');
    A.ok(/Too many agents/.test(sends[0]), 'the distinct transient surfaces its own message, once');
  }

  // ---- L4. a message that arrives DURING the backoff supersedes the retry -> the retry bails (newer run owns the
  // chat), and the pure classifier isSupersedeRaceRefusal only fires on the exact class. ----
  {
    const { isSupersedeRaceRefusal } = require('../sidecar/channels/hub.js');
    A.eq(isSupersedeRaceRefusal(true, 'That agent is already running a task. …'), true, 'classifier: transient + phrase -> true');
    A.eq(isSupersedeRaceRefusal(false, 'That agent is already running a task. …'), false, 'classifier: non-transient never matches (transient flag required)');
    A.eq(isSupersedeRaceRefusal(true, 'Too many agents are working at once'), false, 'classifier: the concurrency-cap transient is a different class');
    A.eq(isSupersedeRaceRefusal(true, ''), false, 'classifier: empty message -> false');
    A.eq(isSupersedeRaceRefusal(true, null), false, 'classifier: null message -> false (no throw)');

    // Scenario: the first message's run hits a GENUINE mutex-race refusal (NOT yet superseded) and enters backoff.
    // While it is parked in sleep(), a second message arrives, supersedes it, and runs its own reply. The parked
    // retry must then BAIL after the backoff (its record is now superseded) instead of firing a stale extra run.
    const store = fakeStore(); const sends = []; let releaseSleep = null; const sleepEntered = [];
    let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      if (call === 1) {
        // first run: instant mutex-race refusal (transient), no supersede yet -> the hub enters backoff sleep.
        o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, transient: true, message: 'That agent is already running a task. (they share a workspace).' });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'error', turns: 0, usd: 0 });
        return;
      }
      // any later run (the second message's) delivers a normal reply.
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'newest reply' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      sleep: () => { const p = new Promise(r => { releaseSleep = r; }); sleepEntered.push(1); return p; }
    });
    const p1 = hub.onInbound(dm('first'));   // refuses (call 1), then parks in the backoff sleep
    await waitFor(() => sleepEntered.length === 1);   // the first run is now parked in backoff
    A.eq(sends.length, 0, 'nothing delivered yet — the first run is mid-backoff, not given up');
    const p2 = hub.onInbound(dm('second'));   // supersedes the parked retry AND runs its own reply (call 2)
    await p2;
    releaseSleep();                           // let the first run\'s backoff resolve — it must see superseded and bail
    await p1;
    A.eq(call, 2, 'the superseded retry did NOT fire a stale extra run after the backoff');
    A.eq(sends.length, 1, 'only the newest message is answered');
    A.eq(sends[0].t, 'newest reply', 'the delivered reply is the newest run\'s, not a stale retry');
  }

  // ---- M. MEDIA ingest: a photo/video message downloads, stores, and rides the run as attachments ----
  {
    const store = fakeStore(); let lastRun = null; const saved = [], fetched = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'seen' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      fetchMedia: (it) => { fetched.push(it.fileId); return Promise.resolve({ ok: true, buffer: Buffer.from('BYTES-' + it.fileId) }); },
      saveAttachment: (agentId, name, dataUrl) => { saved.push({ agentId, name, dataUrl }); const img = /^data:image\//.test(dataUrl); return Promise.resolve({ ok: true, id: 'id-' + name, name, path: '.attachments/' + name, mediaType: img ? 'image/jpeg' : 'video/mp4', kind: img ? 'image' : 'file' }); },
      expandAttachments: (messages, agentId) => {
        // stand-in for expandUserAttachments: turn the ref'd turn into blocks (image block per image ref)
        return Promise.resolve(messages.map(m => (m.attachments ? { role: m.role, content: [{ type: 'text', text: m.content }].concat(m.attachments.filter(a => a.kind === 'image').map(a => ({ type: 'image_url', image_url: { url: 'expanded:' + a.name } }))) } : m)));
      }
    });
    const msg = dm('watch this', '77');
    msg.media = [
      { kind: 'video', fileId: 'v1', name: 'demo.mp4', mime: 'video/mp4', size: 1000 },
      { kind: 'photo', fileId: 't1', name: 'video-preview-frame.jpg', mime: 'image/jpeg', size: 50 }
    ];
    await hub.onInbound(msg);
    A.eq(fetched, ['v1', 't1'], 'both media items downloaded');
    A.eq(saved.map(s => s.agentId), ['tg_77', 'tg_77'], 'stored in the RESOLVED agent\'s workspace');
    A.ok(/^data:video\/mp4;base64,/.test(saved[0].dataUrl), 'video bytes stored as a typed data URL');
    const turn = store.appends.find(x => x.role === 'user');
    A.ok(/watch this/.test(turn.content) && /demo\.mp4/.test(turn.content) && /\.attachments\//.test(turn.content), 'persisted user turn = caption + honest media notes with saved paths');
    A.ok(/preview-frame\.jpg is a still frame from the video/.test(turn.content), 'video+frame cross-reference note present');
    const last = lastRun.messages[lastRun.messages.length - 1];
    A.ok(Array.isArray(last.content) && last.content.some(b => b.type === 'image_url' && /expanded:video-preview-frame\.jpg/.test(b.image_url.url)), 'run message carries the EXPANDED image block (the model can SEE the frame)');
    A.eq('attachments' in last, false, 'no raw attachments field leaks to the provider after expansion');
  }

  // ---- M1b. (run-paths review M3 + round 2) wired as the host wires it: the hub hands the references to runOnce UNEXPANDED
  // (the run host expands them once the run's root is final, placing a stored name absolutely only for a project run), the
  // stored turn names the saved file by its JAIL-RELATIVE name (that text is replayed to the model, in group chats too, so
  // it never carries a host path), and a reply that echoes the absolute spelling reaches the chat without the host part ----
  {
    const store = fakeStore(); let lastRun = null; const sent = [];
    const echo = '/station/workspaces/tg_79/.attachments/take.ogg';
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Saved at ' + echo + ' and C:/Station/WORKSPACES/tg_79/shots/s.png.' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sent.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      fetchMedia: () => Promise.resolve({ ok: true, buffer: Buffer.from('OGG') }),
      saveAttachment: (agentId, name) => Promise.resolve({ ok: true, id: 'id-' + name, name, path: '.attachments/' + name, mediaType: 'audio/ogg', kind: 'file' }),
      expandAttachments: (messages) => messages,
      hostPathPrefixes: () => ['/station/workspaces', 'C:\\Station\\workspaces']
    });
    const msg = dm('listen', '79'); msg.media = [{ kind: 'audio', fileId: 'a1', name: 'take.ogg', mime: 'audio/ogg', size: 3 }];
    await hub.onInbound(msg);
    const turn = store.appends.find(x => x.role === 'user');
    A.ok(turn && turn.content.indexOf('saved to .attachments/take.ogg in your workspace') >= 0 && turn.content.indexOf('/station/') < 0, 'round 2: the stored turn names the saved file jail-relative, never by host path: ' + (turn && turn.content));
    const last = lastRun.messages[lastRun.messages.length - 1];
    A.ok(Array.isArray(last.attachments) && last.attachments[0].path === '.attachments/take.ogg', 'M3: the references reach runOnce unexpanded, for the run host to place');
    const reply = sent.join('\n');
    // round 3: the root becomes a readable placeholder (deleting it mangled "cd <root>\alpha && npm test" to "cd  && npm test")
    A.ok(reply.indexOf('Saved at <workspace>/tg_79/.attachments/take.ogg and <workspace>/tg_79/shots/s.png.') >= 0 && !/station/i.test(reply), 'the chat never sees the host path a reply echoed: ' + JSON.stringify(reply));
    // and the host wires it so: no durable-path hook names the stored turn absolutely, and every hub gets the ONE scrub
    // (the full wiring lock, every surface and every hub, is test/host-path-scrub.test.js section 5)
    const { readSidecarSource } = require('./helpers/source');
    const host = readSidecarSource();
    A.ok(!/attachmentPath\s*:/.test(host) && !/function attachmentDurablePath\(/.test(host), 'round 2: no host hook names a stored turn\'s file by its absolute path');
    A.ok((host.match(/scrubOutbound: scrubOutbound/g) || []).length >= 4 && !/hostPathPrefixes: \(\) =>/.test(host), 'round 3: the host\'s hubs take the one scrub, not a per-hub prefix list');
  }

  // ---- M2. media-only message (no caption) is still admitted; download failure degrades to an honest note ----
  {
    const store = fakeStore(); let lastRun = null; const sends = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      fetchMedia: () => Promise.resolve({ ok: false, error: 'file too large (999 bytes)' }),
      saveAttachment: () => Promise.resolve({ ok: true }), expandAttachments: (m) => Promise.resolve(m)
    });
    const msg = dm('', '78'); msg.media = [{ kind: 'photo', fileId: 'p1', name: 'photo.jpg', mime: 'image/jpeg', size: 100 }];
    await hub.onInbound(msg);
    A.ok(lastRun, 'media-only message (empty text) still runs — no silent drop');
    const last = lastRun.messages[lastRun.messages.length - 1];
    A.ok(/could not download the photo/.test(String(last.content)) && /file too large/.test(String(last.content)), 'failed download becomes an honest note the model reads');
    A.eq(sends.length, 1, 'the agent still replies');
  }

  // ---- M3. media without wiring (no fetchMedia/saveAttachment) degrades honestly, never drops the message ----
  {
    const store = fakeStore(); let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const msg = dm('here', '79'); msg.media = [{ kind: 'video', fileId: 'v1', name: 'a.mp4', mime: 'video/mp4', size: 10 }];
    await hub.onInbound(msg);
    const last = lastRun.messages[lastRun.messages.length - 1];
    A.ok(/media ingest is not wired/.test(String(last.content)), 'unwired channel says so instead of pretending');
  }

  // ---- M4. oversized media item is refused with a note BEFORE any download ----
  {
    const store = fakeStore(); let lastRun = null; const fetched = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      fetchMedia: (it) => { fetched.push(it.fileId); return Promise.resolve({ ok: true, buffer: Buffer.from('x') }); },
      saveAttachment: () => Promise.resolve({ ok: true, id: 'i', name: 'n', path: '.attachments/n', mediaType: 'image/jpeg', kind: 'image' }),
      expandAttachments: (m) => Promise.resolve(m)
    });
    const msg = dm('big one', '80'); msg.media = [{ kind: 'video', fileId: 'huge', name: 'big.mp4', mime: 'video/mp4', size: 50 * 1024 * 1024 }];
    await hub.onInbound(msg);
    A.eq(fetched, [], 'oversized item never downloaded');
    const last = lastRun.messages[lastRun.messages.length - 1];
    A.ok(/too large to ingest/.test(String(last.content)), 'oversized item noted honestly');
  }

  // ---- M5. ALBUM batching: N media_group parts -> ONE merged run (no supersede storm) ----
  {
    const store = fakeStore(); const runs = []; const saved = [];
    const runOnce = async (o) => { runs.push(o); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'saw them' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      albumWaitMs: 1, sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      fetchMedia: (it) => Promise.resolve({ ok: true, buffer: Buffer.from('B' + it.fileId) }),
      saveAttachment: (agentId, name, dataUrl) => { saved.push(name); return Promise.resolve({ ok: true, id: 'i' + name, name, path: '.attachments/' + name, mediaType: 'image/jpeg', kind: 'image' }); },
      expandAttachments: (m) => Promise.resolve(m)
    });
    const part = (n, text) => { const m = dm(text || '', '90'); m.mediaGroupId = 'alb1'; m.media = [{ kind: 'photo', fileId: 'p' + n, name: 'photo' + n + '.jpg', mime: 'image/jpeg', size: 10 }]; return m; };
    // three parts arrive in a burst (caption on the SECOND part, as Telegram does)
    const p1 = hub.onInbound(part(1));
    const p2 = hub.onInbound(part(2, 'my three photos'));
    const p3 = hub.onInbound(part(3));
    await Promise.all([p1, p2, p3]);
    A.eq(runs.length, 1, 'one album = ONE run (no supersede storm)');
    A.eq(saved.sort(), ['photo1.jpg', 'photo2.jpg', 'photo3.jpg'], 'all three photos ingested into the one turn');
    const last = runs[0].messages[runs[0].messages.length - 1];
    A.ok(/my three photos/.test(JSON.stringify(last.content)), 'the album caption rides the merged turn');
    A.ok(last.attachments === undefined || last.attachments.length === 3, 'merged turn carries all refs');
    // a NON-album message still flows exactly as before (no debounce added)
    await hub.onInbound(dm('plain', '91'));
    A.eq(runs.length, 2, 'plain message unaffected by album machinery');
  }

  // ---- M6. two different albums (or chats) never merge into each other ----
  {
    const store = fakeStore(); const runs = [];
    const runOnce = async (o) => { runs.push(o.agentId); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'x' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      albumWaitMs: 1,
      fetchMedia: () => Promise.resolve({ ok: true, buffer: Buffer.from('b') }),
      saveAttachment: (a, n) => Promise.resolve({ ok: true, id: n, name: n, path: '.attachments/' + n, mediaType: 'image/jpeg', kind: 'image' }),
      expandAttachments: (m) => Promise.resolve(m)
    });
    const mk = (chat, gid) => { const m = dm('', chat); m.mediaGroupId = gid; m.media = [{ kind: 'photo', fileId: 'f', name: 'p.jpg', mime: 'image/jpeg', size: 1 }]; return m; };
    await Promise.all([hub.onInbound(mk('95', 'g1')), hub.onInbound(mk('96', 'g1')), hub.onInbound(mk('95', 'g2'))]);
    A.eq(runs.length, 3, 'same groupId in different chats + different groups in one chat = separate runs');
  }

  // ---- T1. typing indicator: chatAction refreshed while the run is in flight, ceased before delivery ----
  {
    const store = fakeStore(); const typed = []; const sends = [];
    const runOnce = async (o) => {
      await new Promise(r => setTimeout(r, 40));   // a "slow" run: several refresh intervals long
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'done!' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      chatAction: (chatId) => { typed.push(chatId); return Promise.resolve({ ok: true }); }, typingRefreshMs: 250
    });
    await hub.onInbound(dm('slow one', '70'));
    A.ok(typed.length >= 1, 'typing action fired at least once during the run');
    A.eq(typed[0], '70', 'typing action targets the inbound chat');
    A.eq(sends, ['done!'], 'reply still delivered normally');
    const after = typed.length;
    await new Promise(r => setTimeout(r, 30));
    A.eq(typed.length, after, 'typing refreshes CEASE once the reply is out (no lingering bubble)');
  }

  // ---- T2. typing degrades honestly: a non-retryable failure = ONE probe, no hammering; /commands never type ----
  {
    const store = fakeStore(); const typed = [];
    const runOnce = async (o) => {
      await new Promise(r => setTimeout(r, 20));
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      chatAction: () => { typed.push(1); return Promise.resolve({ ok: false, error: 'typing not supported on this channel', retryable: false }); }, typingRefreshMs: 1
    });
    await hub.onInbound(dm('hi', '71'));
    A.eq(typed.length, 1, 'unsupported channel probed exactly once per run');
    typed.length = 0;
    await hub.onInbound(dm('/help', '71'));
    A.eq(typed.length, 0, 'a control command never lights the typing bubble (no run happens)');
  }

  // ---- V. E-STOP is not a supersede: the chat is TOLD it was stopped on purpose ----------------------
  // Both set `superseded` so the stale partial is abandoned, but they mean opposite things about what happens
  // next: a supersede has a newer message already running its replacement, an E-STOP has nothing coming. On a
  // phone — no floor, no browser, no other signal — the shared silent return made a deliberate stop
  // byte-identical to a crashed bot, while /stop typed in the same chat answers "Stopped the run in progress."
  {
    const { killAll } = require('../sidecar/halt.js');
    const store = fakeStore(); const sends = [];
    const runOnce = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'half an answ' });
      await new Promise(res => { if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 0, usd: 0 });
    };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const parked = hub.onInbound(dm('do the long thing'));
    await new Promise(r => setTimeout(r, 10));
    const aborted = killAll(null, hub._internals.inflight);   // exactly what handleHalt does
    A.eq(aborted, 1, 'E-STOP aborted the one in-flight channel run');
    await parked;
    A.ok(!sends.some(s => /half an answ/.test(s)), 'the stale partial is still abandoned');
    A.ok(sends.some(s => /E-STOP/.test(s)), 'the chat is TOLD the run was stopped from the station');
    A.eq(sends.filter(s => /E-STOP/.test(s)).length, 1, 'the stop notice is delivered exactly once');
  }

  // ---- V1. THE STATION'S OWN FAULT is not an E-STOP (wave 2 repair, conveyor-backend-08): the process-fault containment marks the
  // runs it kills `faulted` first, so the chat is told the station hit a fault — never that someone pressed an E-STOP ----------------
  {
    const { killAll, markFaulted } = require('../sidecar/halt.js');
    const store = fakeStore(); const sends = [];
    const runOnce = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      await new Promise(res => { if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 0, usd: 0 });
    };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const parked = hub.onInbound(dm('do the long thing'));
    await new Promise(r => setTimeout(r, 10));
    markFaulted(hub._internals.inflight);
    A.eq(killAll(null, hub._internals.inflight), 1, 'fault: the containment aborted the one in-flight channel run');
    await parked;
    A.eq(sends.filter(s => /internal fault/.test(s)).length, 1, 'fault: the chat is told once that the station hit a fault — ' + JSON.stringify(sends));
    A.ok(!sends.some(s => /E-STOP/.test(s)), 'fault: never "E-STOP was pressed"');
  }

  // ---- V2. a supersede by a NEWER message is NOT silent (2026-10-11), but never says E-STOP either --------
  {
    const store = fakeStore(); const sends = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      if (call === 1) {
        o.emit('agent.token', { delta: 'stale partial' });
        await new Promise(res => { if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
        return;
      }
      o.emit('agent.token', { delta: 'second-reply' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const p1 = hub.onInbound(dm('first'));
    await hub.onInbound(dm('second'));
    await p1;
    A.ok(!sends.some(x => /stale partial/.test(x)), 'no stale partial');
    A.ok(!sends.some(x => /E-STOP/.test(x)), 'a newer message is not an E-STOP');
    A.eq(sends.filter(x => /Stopped the earlier task/.test(x)).length, 1, 'the earlier task stop is said exactly once');
    A.eq(sends[sends.length - 1], 'second-reply', 'the newer message is answered');
  }

  // ---- W. quick plain-text bubbles become one thought; commands/media stay exact ---------------------
  {
    const store = fakeStore(); const runs = []; const resolved = [];
    const runOnce = async (o) => {
      runs.push(o);
      o.emit('agent.token', { delta: 'batched' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      textBatchWaitMs: 1, sleep: () => new Promise(r => setTimeout(r, 0)), onResolved: info => resolved.push(info)
    });
    const p1 = hub.onInbound(dm('first bubble', 'batch'));
    const p2 = hub.onInbound(dm('second bubble', 'batch'));
    const p3 = hub.onInbound(dm('third bubble', 'batch'));
    await Promise.all([p1, p2, p3]);
    A.eq(runs.length, 1, 'three quick plain-text bubbles produce one run, not a supersede storm');
    A.eq(runs[0].messages[runs[0].messages.length - 1].content, 'first bubble\nsecond bubble\nthird bubble', 'the single turn preserves bubble order with clear newlines');
    A.eq(resolved.length, 1, 'one batch resolves once, so host work telemetry also stays singular');
    await hub.onInbound(dm('/help', 'batch'));
    A.eq(runs.length, 1, 'a command bypasses text batching and does not reach the model');
    const media = dm('caption', 'batch'); media.media = [{ kind: 'photo', fileId: 'p', name: 'p.jpg', mime: 'image/jpeg', size: 1 }];
    await hub.onInbound(media);
    A.eq(runs.length, 2, 'a media turn bypasses text batching and keeps its existing delivery path');
  }

  // ---- X. 2026-10-11 ("they start a task and then stop repeatedly with no explanation"): a follow-up sent while the
  //         chat's run is working JOINS that run through the host's steer seam instead of killing it ----------------
  const parkedRun = (log) => async (o) => {
    log.push(o.runId);
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
    if (log.length === 1) {   // the first run works until released (or aborted)
      await new Promise(res => { log.release = res; if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
      if (o.signal.aborted) { o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 0, usd: 0 }); return; }
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'page built, and it is blue' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 2, usd: 0 });
      return;
    }
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'second-reply' });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
  };
  {
    const store = fakeStore(); const sends = []; const runs = []; const steers = [];
    const hub = makeChannelHub({ runOnce: parkedRun(runs), store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      steerRun: (runId, text) => { steers.push({ runId, text }); return { ok: true }; } });
    const p1 = hub.onInbound(dm('build the landing page'));
    await waitFor(() => runs.length === 1 && typeof runs.release === 'function');
    await hub.onInbound(dm('also make it blue'));
    A.eq(steers, [{ runId: 'run1', text: 'also make it blue' }], 'the follow-up was steered into the RUNNING task');
    A.ok(/Added to the task that is already running/.test(sends[0] || ''), 'the chat is told the follow-up joined the running task');
    A.ok(store.appends.some(x => x.role === 'user' && x.content === 'also make it blue'), 'the follow-up is in the transcript');
    runs.release();
    await p1;
    A.eq(runs.length, 1, 'no second run: the task was NOT killed and restarted');
    A.eq(sends[sends.length - 1], 'page built, and it is blue', 'the running task finished and delivered');
    A.ok(!sends.some(x => /Stopped the earlier task/.test(x)), 'nothing was stopped, so nothing says it was');
  }
  {
    // a refused steer (no live loop to read it) falls back to the supersede path — which now SAYS so
    const store = fakeStore(); const sends = []; const runs = [];
    const hub = makeChannelHub({ runOnce: parkedRun(runs), store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      steerRun: () => ({ ok: false, status: 404 }) });
    const p1 = hub.onInbound(dm('build the landing page'));
    await waitFor(() => runs.length === 1);
    await hub.onInbound(dm('also make it blue'));
    await p1;
    A.eq(runs.length, 2, 'a refused steer starts the newer run');
    A.ok(sends.some(x => /Stopped the earlier task/.test(x)), 'the earlier task\'s stop is announced, never silent');
  }
  {
    // 409: the running task already FINISHED its work (its reply is settling) — it must deliver, never be aborted
    const store = fakeStore(); const sends = []; const runs = [];
    const hub = makeChannelHub({ runOnce: parkedRun(runs), store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      steerRun: () => ({ ok: false, status: 409 }) });
    const p1 = hub.onInbound(dm('build the landing page'));
    await waitFor(() => runs.length === 1 && typeof runs.release === 'function');
    const p2 = hub.onInbound(dm('also make it blue'));
    await waitFor(() => runs.length === 2);
    runs.release();
    await Promise.all([p1, p2]);
    A.ok(sends.includes('page built, and it is blue'), 'the finished task still delivered its answer');
    A.ok(sends.includes('second-reply'), 'and the newer message was answered too');
    A.ok(!sends.some(x => /Stopped the earlier task/.test(x)), 'nothing was stopped, so nothing says it was');
  }
  {
    // a plain "stop" from the owner while the task runs IS /stop: no supersede notice, no paid model run on the word
    // "stop" (review voice-remote-channels-04)
    const store = fakeStore(); const runs = []; const steers = []; const sends = [];
    const hub = makeChannelHub({ runOnce: parkedRun(runs), store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      isOwner: () => true, steerRun: (runId, text) => { steers.push(text); return { ok: true }; } });
    const p1 = hub.onInbound(dm('build the landing page'));
    await waitFor(() => runs.length === 1);
    await hub.onInbound(dm('stop'));
    await p1;
    A.eq(steers.length, 0, 'a plain "stop" never rides into the running task as an instruction');
    A.eq(runs.length, 1, 'a plain "stop" starts no model run of its own');
    A.ok(sends.includes('Stopped the run in progress.'), 'it answers exactly like /stop: ' + JSON.stringify(sends));
    A.ok(!sends.some(x => /Stopped the earlier task/.test(x)), 'never framed as a newer request to handle');
  }
  for (const [ownerIs, label] of [[false, 'a non-owner direct-chat "stop"'], [true, 'the owner\'s "stop" in a group']]) {
    // only the owner's DIRECT-chat stop is /stop; anything else still stops the run through the supersede path
    const store = fakeStore(); const runs = []; const steers = []; const sends = [];
    const hub = makeChannelHub({ runOnce: parkedRun(runs), store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      isOwner: () => ownerIs, steerRun: (runId, text) => { steers.push(text); return { ok: true }; } });
    const asGroup = (m) => (ownerIs ? Object.assign(m, { chatType: 'group', userName: 'Bo' }) : m);
    const p1 = hub.onInbound(asGroup(dm('build the landing page')));
    await waitFor(() => runs.length === 1);
    await hub.onInbound(asGroup(dm('stop')));
    await p1;
    A.eq(steers.length, 0, label + ' never rides into the running task as an instruction');
    A.ok(!sends.includes('Stopped the run in progress.'), label + ' is not the owner\'s /stop: ' + JSON.stringify(sends));
    A.eq(runs.length, 2, label + ' takes the supersede path (the earlier run stops, the message runs)');
  }
  for (const [label, second] of [
    ['a non-owner "stop"', dm('stop')],
    ['a group message', Object.assign(dm('also make it blue'), { chatType: 'group', userName: 'Ana' })],
    ['a forwarded message', Object.assign(dm('also make it blue'), { forwarded: true, forwardFrom: 'someone' })]
  ]) {
    const store = fakeStore(); const runs = []; const steers = [];
    const hub = makeChannelHub({ runOnce: parkedRun(runs), store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen(),
      steerRun: (runId, text) => { steers.push(text); return { ok: true }; } });
    const p1 = hub.onInbound(Object.assign(dm('build the landing page'), second.chatType === 'group' ? { chatType: 'group', userName: 'Bo' } : {}));
    await waitFor(() => runs.length === 1);
    await hub.onInbound(second);
    await p1;
    A.eq(steers.length, 0, label + ' never rides into the running task as an instruction');
  }

  // ---- Y. every non-clean END says what happened, in words -------------------------------------------------------
  const endWith = async (endPayload, extra) => {
    const sends = [];
    const runOnce = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      for (let i = 0; i < ((extra && extra.tools) || 0); i++) {
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'writing it now' });
        o.emit('agent.tool_call', { agentId: o.agentId, runId: o.runId, callId: 'c' + i, name: 'fs_write' });
        o.emit('agent.tool_result', { agentId: o.agentId, runId: o.runId, callId: 'c' + i, ok: true, isError: false });
      }
      if (extra && extra.token) o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: extra.token });
      if (extra && extra.error) o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: extra.error, transient: false });
      o.emit('agent.run.end', Object.assign({ agentId: o.agentId, runId: o.runId, turns: 1, usd: 0 }, endPayload));
    };
    const hub = makeChannelHub({ runOnce, store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('go'));
    return sends.join('\n');
  };
  {
    const empty = await endWith({ reason: 'empty' });
    A.ok(/empty reply, so nothing was done/.test(empty) && /continue/.test(empty), 'an empty end says what happened and what to do: ' + empty);
    A.ok(!/\(no reply\)|stopped: empty/.test(empty), 'never the raw "(no reply) (stopped: empty)"');
    // a tool already ran (the file IS written), then the model went silent: never "nothing was done" (review threads-backend-03)
    const emptyAfterTools = await endWith({ reason: 'empty' }, { tools: 2 });
    A.ok(!/nothing was done/.test(emptyAfterTools) && /2 tool steps/.test(emptyAfterTools) && /may already have made changes/.test(emptyAfterTools) && /^⚠ The model/.test(emptyAfterTools),
      'an empty end after tool steps says they ran: ' + emptyAfterTools);
    A.ok(/\/model/.test(emptyAfterTools), 'the channel copy still names its /model door: ' + emptyAfterTools);
    const cut = await endWith({ reason: 'done', finishReason: 'length' }, { token: 'half of the ans' });
    A.ok(/half of the ans/.test(cut) && /output limit/.test(cut), 'a provider-cut reply carries a cut-short note (finishReason is no longer ignored): ' + cut);
    const clean = await endWith({ reason: 'done' }, { token: 'all done' });
    A.eq(clean, 'all done', 'a clean reply gets no note');
    const unpriced = await endWith({ reason: 'budget', budgetScope: 'run', unpricedModel: 'x/mystery', unpricedTokens: 2000001, unpricedCapTokens: 2000000 }, { token: 'partial' });
    A.ok(/2,000,000-token safety ceiling/.test(unpriced) && /does not change this/.test(unpriced) && !/raise it in the app under SETTINGS › SPENDING LIMITS/.test(unpriced), 'the unpriced TOKEN ceiling is named as itself, not a $ cap to raise: ' + unpriced);
    A.ok(!/\)\.\)/.test(unpriced) && /SKYNET_MODEL_PRICES\.\)$/.test(unpriced), 'the unpriced note ends cleanly, never "…).)" (review voice-remote-channels-12): ' + unpriced);
    const subscription = await endWith({ reason: 'budget', budgetScope: 'run', subscriptionModel: 'claude-opus', subscriptionCapTokens: 2000000 }, { token: 'partial' });
    A.ok(/2,000,000-token per-run ceiling/.test(subscription) && /Runtime limits/.test(subscription), 'the subscription TOKEN ceiling names its real lever: ' + subscription);
    A.ok(!/\)\.\)/.test(subscription) && /STARNET_MAX_SUBSCRIPTION_TOKENS\.\)$/.test(subscription), 'the subscription note ends cleanly, never "…).)": ' + subscription);
    const cancelled = await endWith({ reason: 'cancelled' }, { token: 'partial' });
    A.ok(/stopped from the StarNet app/.test(cancelled), 'a station-side cancel says who stopped it: ' + cancelled);
    const stuck = await endWith({ reason: 'error' }, { error: 'loop guard: fs_read failed 3 times with identical arguments — stopping a stuck loop' });
    A.ok(/got stuck repeating one step: fs_read failed 3 times/.test(stuck), 'a loop-guard stop leads with what happened in plain words: ' + stuck);
  }

  A.report('channels.hub.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
