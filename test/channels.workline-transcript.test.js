/* node test/channels.workline-transcript.test.js — regression guard for the FABRICATED TURN (fix df3fdcf3).

   THE DEFECT. When a Commander draws belts downstream of an entry dock, hub.js runs the whole work line and
   the reply that leaves is the LAST stage's. But it also wrote that delivered text into the ENTRY DOCK's
   transcript, so SCOUT's history recorded the EDITOR's final paragraph as its own assistant turn —
   byte-identical to the editor's. Stage one never said it, and on the very next message the dock would
   replay that history as if it had. That is a fabricated turn in the one system whose core law is truthful
   telemetry, and it was found by running a real 4-stage graph, not by a test.

   An agent's transcript records what THAT agent said. Each hop already persists its own output under its own
   id, and the delivering stage's transcript holds the delivered text, so the entry dock must get back what
   IT actually produced.

   This drives the real makeChannelHub with a fake runOnce/store/chain (the harness from
   channels.hub.test.js) so the assertion is on persisted TURNS, not on source text — the bug was a
   value being written to the wrong key, which a grep cannot see. Verified red against df3fdcf3^1. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

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

const SCOUT_SAID = 'SCOUT: three candidate suppliers, two with lead times under a week.';
const ANALYST_SAID = 'ANALYST: supplier B is the only one under budget at volume.';
const EDITOR_SAID = 'EDITOR: Go with supplier B — cheapest at volume and ships in four days.';

// a runOnce that answers differently per agent, so an identical transcript is provably a COPY
function runOnceFor(byAgent) {
  return async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
    const said = byAgent[o.agentId];
    if (said) o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: said });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    return { reason: 'done', text: said || '' };   // what runOnce returns: a stage hands on its terminal text (line-runner.js)
  };
}

// a fake work line: entry dock -> analyst -> editor, each hop a real runAgent() call so hops persist
// their own turns exactly as the live chain executor makes them
function threeStageChain(sends) {
  return {
    stopNote: () => '',
    advance: async (o) => {
      const a = await o.runAgent({ agentId: 'analyst', text: o.text, signal: o.signal });
      const e = await o.runAgent({ agentId: 'editor', text: a.text, signal: o.signal });
      return { hops: [{ agentId: 'analyst' }, { agentId: 'editor' }], text: e.text, agentId: 'editor', stopped: null };
    }
  };
}

async function run() {
  /* ---- 0. A LINE IS HANDED WHAT THE MEMBER ACTUALLY ASKED (token-burn audit 2026-10-17). Hops no longer replay the chat stream,
          so the chain's original ask is the only place a downstream stage meets the quoted message a reply points at (or a
          captionless voice note's transcript). The edit marker names a message the stage never saw: it stays out. ---- */
  {
    let handed = null;
    const hub = makeChannelHub({
      runOnce: runOnceFor({ tg_555: SCOUT_SAID }), store: fakeStore(),
      send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      chain: { stopNote: () => '', advance: async (o) => { handed = o.originalText; return { hops: [], text: SCOUT_SAID, agentId: 'tg_555', stopped: null }; } }
    });
    const first = dm('summarise this for the team');
    first.replyTo = { text: 'QUOTED: Q3 revenue rose 14% on the new tier.', userName: 'Dana' };
    await hub.onInbound(first);
    A.ok(typeof handed === 'string' && handed.indexOf('QUOTED: Q3 revenue rose 14% on the new tier.') >= 0, 'a reply\'s quoted message reaches the line');
    handed = null;
    const msg = dm('summarize this for the team');   // the member edits their latest message (same messageId)
    msg.replyTo = first.replyTo;
    msg.edited = true;
    await hub.onInbound(msg);
    A.ok(typeof handed === 'string' && handed.indexOf('QUOTED: Q3 revenue rose 14% on the new tier.') >= 0 && handed.indexOf('summarize this for the team') >= 0,
      'the line is handed the quoted message AND the member\'s words, as the entry run read them');
    A.ok(handed.indexOf('the previous message was edited') < 0, 'the edit marker (a message the stage never saw) stays out of the line\'s ask');
  }

  /* ---- A. THE DEFECT: the entry dock records ITS OWN text, never the delivered one ---- */
  {
    const sends = []; const store = fakeStore(); const events = [];
    const hub = makeChannelHub({
      runOnce: runOnceFor({ tg_555: SCOUT_SAID, analyst: ANALYST_SAID, editor: EDITOR_SAID }),
      store,
      send: (chatId, text) => { sends.push({ chatId, text }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      secrets: () => ({ key: 'k', model: 'anthropic/claude-sonnet-4.6' }),
      classify: () => false, emit: (n, p) => events.push({ n, p }), newId: idGen(),
      chain: threeStageChain(sends)
    });
    await hub.onInbound(dm('who should we buy from?'));

    // the DELIVERED reply is still the last stage's — the fix must not change what the user receives
    A.eq(sends.length, 1, 'one reply is delivered for the whole line');
    A.eq(sends[0].text, EDITOR_SAID, 'the delivered reply is the LAST stage\'s text');

    const dock = store.hist.get('tg_555') || [];
    const dockAssistant = dock.filter(t => t.role === 'assistant').map(t => t.content);
    A.eq(dockAssistant, [SCOUT_SAID], 'the ENTRY DOCK\'s transcript holds what IT said, not the delivered text');
    A.ok(dockAssistant.indexOf(EDITOR_SAID) < 0, 'the editor\'s paragraph is NOT fabricated into the dock\'s history');

    // each hop still owns its own output — under its per-CHAT hop key (sec-taint 09-25: hop history is keyed by
    // chat lineage, never by the bare agentId every chat of that agent would share)
    const keyOf = (said) => { const hit = store.appends.find(x => x.role === 'assistant' && x.content === said && x.a !== 'tg_555'); return hit ? hit.a : ''; };
    const analystKey = keyOf(ANALYST_SAID), editorKey = keyOf(EDITOR_SAID);
    A.ok(/^hop_[0-9a-f]{32}$/.test(analystKey) && /^hop_[0-9a-f]{32}$/.test(editorKey) && analystKey !== editorKey,
      'each hop persists under its own per-chat hop key, not the bare agentId');
    A.eq((store.hist.get(analystKey) || []).filter(t => t.role === 'assistant').map(t => t.content), [ANALYST_SAID],
      'the analyst\'s transcript holds the analyst\'s own output');
    A.eq((store.hist.get(editorKey) || []).filter(t => t.role === 'assistant').map(t => t.content), [EDITOR_SAID],
      'the delivering stage\'s transcript holds the delivered text');

    // the original symptom, stated directly: three stages had three IDENTICAL transcripts
    const all = ['tg_555', analystKey, editorKey].map(id =>
      (store.hist.get(id) || []).filter(t => t.role === 'assistant').map(t => t.content).join('|'));
    A.eq(new Set(all).size, 3, 'all three stages have DISTINCT assistant turns (they were byte-identical)');
  }

  /* ---- B. the replay consequence: the dock's NEXT turn must not carry the editor's words ---- */
  {
    const store = fakeStore(); let secondRunMessages = null;
    let call = 0;
    const runOnce = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      if (o.agentId === 'tg_555') { call++; if (call === 2) secondRunMessages = o.messages.slice(); }
      const said = { tg_555: SCOUT_SAID, analyst: ANALYST_SAID, editor: EDITOR_SAID }[o.agentId];
      if (said) o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: said });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      chain: threeStageChain([])
    });
    await hub.onInbound(dm('who should we buy from?'));
    await hub.onInbound(dm('and the lead time?'));

    A.ok(secondRunMessages, 'the dock ran a second time');
    const replayed = secondRunMessages.filter(m => m.role === 'assistant').map(m => m.content);
    A.ok(replayed.indexOf(EDITOR_SAID) < 0,
      'the dock does NOT replay the editor\'s paragraph as its own prior turn on the next message');
    A.ok(replayed.indexOf(SCOUT_SAID) >= 0, 'the dock DOES replay what it actually said');
  }

  /* ---- C. no work line: the plain path is unchanged (the dock's reply IS the delivered one) ---- */
  {
    const sends = []; const store = fakeStore();
    const hub = makeChannelHub({
      runOnce: runOnceFor({ tg_777: SCOUT_SAID }), store,
      send: (chatId, text) => { sends.push({ chatId, text }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen()
      // no chain injected at all
    });
    await hub.onInbound(dm('hello', '777'));
    A.eq(sends[0].text, SCOUT_SAID, 'with no work line the dock\'s own text is delivered');
    A.eq((store.hist.get('tg_777') || []).filter(t => t.role === 'assistant').map(t => t.content), [SCOUT_SAID],
      'with no work line the dock records that same text — the normal path is untouched');
  }

  /* ---- D. a chain that yields NO hops must also leave the dock's own turn alone ---- */
  {
    const sends = []; const store = fakeStore();
    const hub = makeChannelHub({
      runOnce: runOnceFor({ tg_888: SCOUT_SAID }), store,
      send: (chatId, text) => { sends.push({ chatId, text }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      chain: { stopNote: () => '', advance: async () => ({ hops: [], text: '', agentId: null, stopped: null }) }
    });
    await hub.onInbound(dm('hello', '888'));
    A.eq((store.hist.get('tg_888') || []).filter(t => t.role === 'assistant').map(t => t.content), [SCOUT_SAID],
      'an empty line leaves the dock\'s own assistant turn as the dock\'s own text');
    A.eq(sends[0].text, SCOUT_SAID, 'an empty line delivers the dock\'s own text');
  }

  A.report('channels.workline-transcript');
}

run().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
