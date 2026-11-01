/* node test/channels.parity.test.js — CHANNEL COMMAND PARITY.

   The desktop palette has 43 commands; a phone had 6. The gap mattered because "away from the desk" is exactly
   when you need to kill a runaway run or check what a routine has spent. This covers the commands that closed
   it, and the one property that makes them trustworthy: a command the SIDECAR can answer (/usage /tools
   /routine /away) is routed through the shared slash registry, so the text on your phone is the text the
   desktop would print — never a second implementation that drifts.

   Fake runOnce/store/send — no network, no real loop, no Telegram. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub, COMMANDS, menuCommands } = require('../sidecar/channels/hub.js');

function fakeStore(seedTurns) {
  const hist = new Map(), recs = new Map();
  if (seedTurns) hist.set('ultron', seedTurns.slice());
  return {
    hist, recs, cleared: [],
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    clearHistory(a) { const n = (hist.get(a) || []).length; if (!n) return 0; hist.set(a, []); this.cleared.push(a); return n; },
    getChatRecord(c) { return recs.get(String(c)); },
    saveChatRecord(c, patch) { const m = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), m); return m; }
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = (text, chatId) => ({ channel: 'telegram', chatId: chatId || '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });
const roster = () => [{ agentId: 'ultron', name: 'Ultron', model: 'anthropic/claude-opus-4.6', provider: 'openrouter' }];

function build(over) {
  const sends = [];
  const base = {
    runOnce: async () => {}, store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
    roster: roster, now: () => 1000,
    isOwner: () => true   // the paired owner (the non-owner gate: channels.owner-gates.test.js)
  };
  const hub = makeChannelHub(Object.assign(base, over || {}));
  return { hub, sends, store: (over && over.store) || base.store };
}

(async () => {
  /* ---- the ONE table drives the parser, /help and Telegram's blue menu ---- */
  {
    const names = COMMANDS.map(c => c.command);
    for (const n of ['status', 'stop', 'new', 'usage', 'tools', 'routine', 'away', 'agents', 'talk', 'model', 'whoami', 'help'])
      A.ok(names.indexOf(n) >= 0, '/' + n + ' is in the channel command table');
    // Telegram REJECTS setMyCommands wholesale if any single entry is malformed, so every published name must
    // satisfy its grammar and every description must be non-empty and within length.
    for (const c of menuCommands()) {
      A.ok(/^[a-z0-9_]{1,32}$/.test(c.command), '/' + c.command + ' satisfies Telegram command grammar');
      A.ok(c.description.length > 0 && c.description.length <= 256, '/' + c.command + ' has a publishable description');
    }
    A.ok(menuCommands().every(c => c.command !== 'help'), '/help stays off the published menu (redundant beside it)');
    // Telegram authenticates BEFORE it validates the body — probed 2026-07-25: a correct payload and a
    // deliberately malformed one both return an identical 401 on a fake token. So the wire can NEVER tell us
    // the payload is good without a real bot token, and these local guards are the only standing proof there is.
    const menu = menuCommands();
    A.ok(menu.length <= 100, 'the published menu is within the Bot API 100-command cap (' + menu.length + ')');
    A.eq(new Set(menu.map(c => c.command)).size, menu.length, 'no duplicate command names reach setMyCommands');
    A.notThrows(() => JSON.parse(JSON.stringify(menu)), 'the menu payload round-trips as JSON');
  }

  /* ---- server-answerable commands go through the SHARED registry ---- */
  {
    const calls = [];
    const { hub, sends } = build({
      runSlash: async (input, ctx) => { calls.push({ input, ctx }); return { ok: true, title: 'Spend', lines: ['Today: $1.50.', 'All time: $42.50.'] }; }
    });
    await hub.onInbound(dm('/usage'));
    A.eq(calls[0].input, '/usage', 'the raw command line is handed to the shared registry verbatim');
    A.eq(calls[0].ctx.agentId, 'ultron', 'the bound agent rides the dispatch, so per-agent answers are scoped');
    A.eq(calls[0].ctx.ownerTrusted, false, 'ordinary control commands do not inherit owner authority');
    A.ok(/Spend/.test(sends[0]) && /Today: \$1\.50\./.test(sends[0]) && /All time/.test(sends[0]),
      'a card-shaped reply is flattened to plain text with every line preserved');
  }

  {
    const calls = [];
    const { hub } = build({
      ownerTrusted: (msg) => msg.chatType === 'dm' && msg.userId === 'u1',
      runSlash: async (input, ctx) => { calls.push({ input, ctx }); return { ok: true, text: 'ok' }; }
    });
    await hub.onInbound(dm('/tools'));
    A.eq(calls[0].ctx.ownerTrusted, true, 'admitted owner authority reaches shared slash commands such as /tools');
  }

  {
    // arguments must survive intact — /routine add is the case that would silently lose its schedule
    const calls = [];
    const { hub } = build({ runSlash: async (input) => { calls.push(input); return { ok: true, text: 'ok' }; } });
    await hub.onInbound(dm('/routine add every 30m | check the build'));
    A.eq(calls[0], '/routine add every 30m | check the build', 'the full argument string reaches the registry unmodified');
  }

  {
    // a wire-up with no slash layer must REFUSE, not answer emptily
    const { hub, sends } = build({});
    await hub.onInbound(dm('/usage'));
    A.ok(/not available on this channel/.test(sends[0]), 'no slash dep -> an honest refusal');
  }

  {
    // a throwing registry degrades to a polite line, never an unhandled rejection that eats the inbound
    const { hub, sends } = build({ runSlash: async () => { throw new Error('boom'); } });
    await hub.onInbound(dm('/tools'));
    A.ok(/Could not run \/tools/.test(sends[0]), 'a throwing registry is caught and reported');
  }

  {
    // a command must NEVER spend a model turn
    let ran = false;
    const { hub } = build({ runOnce: async () => { ran = true; }, runSlash: async () => ({ ok: true, text: 'x' }) });
    await hub.onInbound(dm('/usage'));
    await hub.onInbound(dm('/status'));
    await hub.onInbound(dm('/new'));
    A.eq(ran, false, 'control commands never spawn an LLM run');
  }

  /* ---- /stop — the reason this lane exists ---- */
  {
    const { hub, sends } = build({});
    await hub.onInbound(dm('/stop'));
    A.ok(/Nothing is running/.test(sends[0]), '/stop with no live run says so instead of pretending');
  }

  {
    // a real in-flight run: hold runOnce open, then stop it from the SAME chat
    let release = null, aborted = false;
    const runOnce = (o) => new Promise(res => {
      release = res;
      o.emit('agent.run.start', { runId: o.runId });
      o.signal.addEventListener('abort', () => { aborted = true; res(); });
    });
    const { hub, sends } = build({ runOnce, classify: () => false });
    const work = hub.onInbound(dm('do a long thing'));
    await new Promise(r => setTimeout(r, 20));           // let the run register its inflight record
    await hub.onInbound(dm('/stop'));
    A.eq(aborted, true, '/stop aborts the run this chat has in flight');
    A.ok(sends.some(t => /Stopped the run in progress/.test(t)), 'the stop is confirmed to the user');
    if (release) release();
    await work.catch(() => {});
  }

  /* ---- /new — the only way a phone can start over (no localStorage to clear) ---- */
  {
    const store = fakeStore([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    const { hub, sends } = build({ store });
    await hub.onInbound(dm('/new'));
    A.eq(store.loadHistory('ultron').length, 0, '/new empties this agent\'s stored transcript');
    A.ok(/Cleared 2 messages/.test(sends[0]), 'it reports how many turns it actually dropped');
    A.ok(/no longer remember/.test(sends[0]), 'it is explicit that memory of the conversation is gone');
  }

  {
    const { hub, sends } = build({ store: fakeStore() });
    await hub.onInbound(dm('/new'));
    A.ok(/Nothing to clear/.test(sends[0]), 'an already-empty chat says so rather than claiming a clear');
  }

  /* ---- /new must forget what the RUN replays, not just the store file (live-caught 2026-10-20, sweep/channels) ----
     A real host hands the hub historyFor (the canonical transcript stream, transcriptStore.reconstruct) and every run
     reads its history from THAT. /new cleared only the store file: it answered "I no longer remember what we
     discussed" and the very next run replayed the whole old conversation (101 messages on the wire), taint and all. */
  {
    const transcripts = new Map([['channel_telegram_555', [{ role: 'user', content: 'OLD SECRET PLAN' }, { role: 'assistant', content: 'noted the old plan' }]]]);
    const seen = [];
    const runOnce = async (o) => { seen.push({ streamId: o.streamId, messages: o.messages.map(m => String(m.content)) }); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); };
    const store = fakeStore();
    const { hub, sends } = build({ runOnce, store, historyFor: (sid) => (transcripts.get(sid) || []).slice() });
    await hub.onInbound(dm('/new'));
    A.ok(/Cleared 2 messages/.test(sends[0]) && /no longer remember/.test(sends[0]), '/new counts the turns a run would have replayed: ' + sends[0]);
    await hub.onInbound(dm('what was the plan?'));
    A.eq(seen.length, 1, 'fixture: the next message ran');
    A.ok(!seen[0].messages.some(c => /OLD SECRET PLAN|old plan/.test(c)), 'the next run after /new replays none of the forgotten conversation');
    A.ok(seen[0].streamId && seen[0].streamId !== 'channel_telegram_555', 'it runs on a fresh stream (' + seen[0].streamId + ')');
    A.ok(transcripts.get('channel_telegram_555').length === 2, 'the old transcript is kept in the station history, only no longer replayed');
  }

  {
    // clearing under a live run would strand it mid-conversation
    let release = null;
    const runOnce = (o) => new Promise(res => { release = res; o.emit('agent.run.start', { runId: o.runId }); });
    const store = fakeStore([{ role: 'user', content: 'a' }]);
    const { hub, sends } = build({ runOnce, store });
    const work = hub.onInbound(dm('long thing'));
    await new Promise(r => setTimeout(r, 20));
    await hub.onInbound(dm('/new'));
    A.ok(sends.some(t => /send \/stop first/.test(t)), '/new refuses while a run is in flight and names the fix');
    // the refused clear must not have run at all — the inbound message itself legitimately appends a turn,
    // so assert on the clear having been SKIPPED rather than on a turn count the live run is still changing.
    A.eq(store.cleared.length, 0, 'the refused clear never reached the store');
    A.ok(store.loadHistory('ultron').some(m => m.content === 'a'), 'the pre-existing transcript survives the refusal');
    if (release) release();
    await work.catch(() => {});
  }

  /* ---- /status — live state only, never a claim it cannot back ---- */
  {
    const store = fakeStore([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
    const { hub, sends } = build({ store });
    await hub.onInbound(dm('/status'));
    A.ok(/Idle — nothing running/.test(sends[0]), 'an idle chat reports idle');
    A.ok(/Ultron/.test(sends[0]), 'it names the agent this chat is bound to');
    A.ok(/3 messages remembered/.test(sends[0]), 'it reports the real stored turn count');
    A.ok(/buttons: OFF/.test(sends[0]), 'it reports the approvals state');
  }

  /* ---- /status counts what the RUN replays (quick win 23, bug 956fdecf's last half) ----
     A real host hands the hub historyFor (the canonical stream) and every run reads THAT, not the legacy store file.
     /status still counted the store file: "History: 0 messages remembered" beside a run that replayed the whole chat. */
  {
    const transcripts = new Map([['channel_telegram_555', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }]]]);
    const { hub, sends } = build({ store: fakeStore(), historyFor: (sid) => (transcripts.get(sid) || []).slice() });
    await hub.onInbound(dm('/status'));
    A.ok(/History: 4 messages remembered/.test(sends[0]), '/status counts the canonical stream the next run replays: ' + sends[0]);
    // after /new the chat moves to a fresh stream, and /status agrees that nothing is remembered
    await hub.onInbound(dm('/new'));
    await hub.onInbound(dm('/status'));
    A.ok(/History: 0 messages remembered/.test(sends[sends.length - 1]), 'after /new, /status reports the fresh stream: ' + sends[sends.length - 1]);
  }

  {
    let release = null;
    const runOnce = (o) => new Promise(res => { release = res; o.emit('agent.run.start', { runId: o.runId }); });
    const { hub, sends } = build({ runOnce, now: () => 5000 });
    const work = hub.onInbound(dm('long thing'));
    await new Promise(r => setTimeout(r, 20));
    await hub.onInbound(dm('/status'));
    A.ok(sends.some(t => /Working/.test(t)), 'a busy chat reports that it is working');
    if (release) release();
    await work.catch(() => {});
  }

  {
    // no clock injected -> say it is working, never invent an elapsed time
    let release = null;
    const runOnce = (o) => new Promise(res => { release = res; o.emit('agent.run.start', { runId: o.runId }); });
    const { hub, sends } = build({ runOnce, now: undefined });
    const work = hub.onInbound(dm('long thing'));
    await new Promise(r => setTimeout(r, 20));
    await hub.onInbound(dm('/status'));
    A.ok(sends.some(t => /Working on something right now/.test(t)), 'with no clock it claims no duration');
    A.ok(!sends.some(t => /NaN/.test(t)), 'no NaN ever reaches the user');
    if (release) release();
    await work.catch(() => {});
  }

  /* ---- Commander-defined commands reach a channel too ---- */
  {
    // A user command is not in this hub's table, so without the fallback it would be answered by the MODEL —
    // spending a turn just to say it does not understand.
    const calls = [];
    let ran = false;
    const { hub, sends } = build({
      runOnce: async () => { ran = true; },
      userCommandNames: () => ['standup'],
      runSlash: async (input, ctx) => { calls.push({ input, ctx }); return { ok: true, text: 'your standup' }; }
    });
    await hub.onInbound(dm('/standup today'));
    A.eq(ran, false, 'a user command never spawns an LLM run on a channel');
    A.eq(calls[0].input, '/standup today', 'the whole line reaches the registry');
    A.eq(calls[0].ctx.agentId, 'ultron', 'the user command is scoped to the agent this chat is bound to');
    A.eq(calls[0].ctx.ownerTrusted, false, 'ordinary channel callers do not inherit owner command authority');
    A.ok(/your standup/.test(sends[0]), 'its output is delivered');
  }

  {
    // A Commander-defined exec reaches the desktop-equivalent slash path only when the composition root admits
    // this exact direct message as the Telegram owner. The hub does not infer it from the text or chat id.
    const calls = [];
    const { hub } = build({
      userCommandNames: () => ['shellproof'],
      ownerTrusted: (msg) => msg.chatType === 'dm' && msg.userId === 'u1',
      runSlash: async (input, ctx) => { calls.push({ input, ctx }); return { ok: true, text: 'ran' }; }
    });
    await hub.onInbound(dm('/shellproof'));
    A.eq(calls[0].ctx.ownerTrusted, true, 'the admitted owner flag reaches Commander-defined commands too');
  }

  {
    // A message that merely STARTS with a slash (a path) must still reach the agent untouched.
    let ran = false;
    const { hub } = build({ runOnce: async () => { ran = true; }, userCommandNames: () => ['standup'], runSlash: async () => ({ ok: true, text: 'x' }) });
    await hub.onInbound(dm('/usr/local/bin please look at this path'));
    A.eq(ran, true, 'an ordinary message starting with a slash still reaches the model');
  }

  {
    let ran = false;
    const { hub } = build({ runOnce: async () => { ran = true; }, runSlash: async () => ({ ok: true, text: 'x' }) });
    await hub.onInbound(dm('/notacommand hello'));
    A.eq(ran, true, 'an unknown slash word is still a normal message when no user command matches');
  }

  A.report('channels.parity.test');
})();
