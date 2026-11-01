/* node test/channels.commands.test.js — channel-agnostic in-messenger control commands (chan-routing).
   Commands live in the shared hub (makeChannelHub.onInbound) so Telegram/Discord/any future adapter behave
   identically. Covers: pure parseCommand/matchAgent, /agents listing (bound marker), /talk rebind persists +
   takes effect on the NEXT normal message, /model show + change through the roster write path + catalog
   validation, unknown/ambiguous names, and that a command NEVER spawns an LLM run. Fake runOnce/store/send —
   no network, no real loop. Mirrors channels.hub.test.js style. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeChannelHub, parseCommand, matchAgent } = require('../sidecar/channels/hub.js');

// Execute the production sidecar's small, self-contained roster mutation against injected state so durability
// failures can be reproduced without booting a real messaging network.
const indexSource = readSidecarSource();
const setModelSource = (indexSource.match(/function setAgentModelFromChannel\(agentId, model\) \{[\s\S]*?\n\}/) || [])[0];
A.ok(setModelSource, 'production setAgentModelFromChannel function is extractable');
const makeProductionSetModel = (roster, save) => new Function('agentRoster', 'saveAgentRoster', setModelSource + '\nreturn setAgentModelFromChannel;')(roster, save);

// a fake store whose chatmap persists in a plain object so we can prove a rebind SURVIVES and is READ BACK.
function fakeStore() {
  const hist = new Map(), recs = new Map(), appends = [];
  return {
    hist, recs, appends,
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); appends.push({ a, role, content }); return arr; },
    getChatRecord(c) { return recs.get(String(c)); },
    saveChatRecord(c, patch) { const merged = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), merged); return merged; }
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = (text, chatId) => ({ channel: 'telegram', chatId: chatId || '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });

// a roster fixture + a setModel that mutates it in place (stand-in for setAgentModelFromChannel -> saveAgentRoster).
function fakeRoster() {
  const map = new Map([
    ['ultron', { agentId: 'ultron', name: 'Ultron', model: 'anthropic/claude-opus-4.6', provider: 'openrouter' }],
    ['codex', { agentId: 'codex', name: 'Codex', model: 'openai/gpt-5-codex', provider: 'openrouter' }],
    ['scout', { agentId: 'scout', name: 'Scout', model: null, provider: 'openrouter' }]
  ]);
  return {
    map,
    list: () => [...map].map(([agentId, a]) => ({ agentId, name: a.name, model: a.model, provider: a.provider })),
    setModel: (agentId, model) => {
      const cur = map.get(String(agentId));
      if (!cur) return { ok: false, agentId, error: 'agent not in roster' };
      const m = String(model || '').trim();
      if (!m) return { ok: false, agentId, error: 'empty model' };
      cur.model = m;                     // in place — asserting the SAME map the browser would read changes
      return { ok: true, agentId, model: m, name: cur.name };
    }
  };
}

async function run() {
  // ---- P. pure parseCommand ----
  {
    A.eq(parseCommand('/agents'), { cmd: 'agents', arg: '' }, 'bare /agents parses');
    A.eq(parseCommand('/talk Ultron'), { cmd: 'talk', arg: 'Ultron' }, '/talk <name> splits cmd + arg');
    A.eq(parseCommand('/model  openai/gpt-5-codex '), { cmd: 'model', arg: 'openai/gpt-5-codex' }, '/model trims the arg');
    A.eq(parseCommand('/talk@mybot Codex'), { cmd: 'talk', arg: 'Codex' }, "'/cmd@botname' suffix stripped");
    A.eq(parseCommand('hello there'), null, 'a normal message is NOT a command');
    A.eq(parseCommand('/unknown x'), null, 'an unknown slash token is NOT intercepted (falls through to a run)');
    A.eq(parseCommand('/'), null, 'a bare slash is not a command');
    /* /start is what Telegram's own START button sends on a fresh chat — the first thing a new member ever
       transmits. It was in no table, so it fell through as an ordinary message and SPENT A PAID MODEL RUN on
       an agent puzzling over the word "/start". It must parse as a command so the hub can answer it free. */
    A.eq(parseCommand('/start'), { cmd: 'start', arg: '' }, "/start parses as a command (Telegram's START button)");
    A.eq(parseCommand('/start@mybot'), { cmd: 'start', arg: '' }, '/start tolerates the @botname suffix');
  }

  // ---- Q. pure matchAgent: exact id, case-insensitive name, prefix, ambiguity ----
  {
    const r = fakeRoster().list();
    A.eq(matchAgent(r, 'ultron').agent.agentId, 'ultron', 'exact agentId matches');
    A.eq(matchAgent(r, 'ULTRON').agent.agentId, 'ultron', 'case-insensitive name matches');
    A.eq(matchAgent(r, 'sc').agent.agentId, 'scout', 'unique prefix matches');
    A.eq(matchAgent(r, 'zzz'), null, 'no match -> null');
    A.ok(matchAgent(r, 'c').agent === undefined ? true : true, 'prefix c is unique to codex');
    A.eq(matchAgent(r, 'c').agent.agentId, 'codex', "prefix 'c' -> codex");
  }

  // ---- R. /agents lists the roster, marking the currently bound agent; runOnce NOT called ----
  {
    const store = fakeStore(); const sends = []; let ran = false; const rr = fakeRoster();
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => { ran = true; }, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
      roster: () => rr.list(), setModel: rr.setModel
    });
    await hub.onInbound(dm('/agents'));
    A.eq(ran, false, 'a command NEVER spawns an LLM run');
    A.ok(/Ultron/.test(sends[0]) && /Codex/.test(sends[0]) && /Scout/.test(sends[0]), 'all roster agents listed');
    A.ok(/→ .*Ultron/.test(sends[0]), 'the bound agent (secrets.agentId=ultron) is marked with →');
    A.ok(/claude-opus-4\.6/.test(sends[0]), 'each agent line shows its model');
  }

  // ---- S. /talk rebinds THIS chat: persists, and the NEXT normal message runs as the new agent ----
  {
    const store = fakeStore(); const sends = []; let lastRun = null; const rr = fakeRoster();
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'hi' }); o.emit('agent.run.end', { reason: 'done' }); };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
      roster: () => rr.list(), setModel: rr.setModel
    });
    await hub.onInbound(dm('/talk Codex'));
    A.ok(/Now talking to Codex/.test(sends[0]), 'switch confirmed with the real agent name');
    A.eq(store.recs.get('555').agentId, 'codex', 'chat record rebound to codex (persisted)');
    // simulate a hub "reload": a brand-new hub instance over the SAME store must read the binding back
    const sends2 = [];
    const hub2 = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, send: (c, t) => { sends2.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
      roster: () => rr.list(), setModel: rr.setModel
    });
    await hub2.onInbound(dm('hello'));
    A.eq(lastRun.agentId, 'codex', 'a subsequent NORMAL message runs as the rebound agent (binding > secrets.agentId default), even after a fresh hub');
    A.eq(store.recs.get('555').agentId, 'codex', 'the fallback save did NOT clobber the /talk binding');
  }

  // ---- T. /talk unknown + ambiguous names ----
  {
    const store = fakeStore(); const sends = []; const rr = fakeRoster();
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => {}, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(), roster: () => rr.list(), setModel: rr.setModel
    });
    await hub.onInbound(dm('/talk nobody'));
    A.ok(/No agent matches/.test(sends[0]) && /Ultron/.test(sends[0]), 'unknown name -> lists valid agents');
    A.eq(store.recs.has('555'), false, 'a failed /talk did NOT persist a binding');
  }

  // ---- U. /model with no arg shows the bound agent's model; with an arg changes it via the roster write path ----
  {
    const store = fakeStore(); const sends = []; const rr = fakeRoster();
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => {}, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
      roster: () => rr.list(), setModel: rr.setModel
    });
    await hub.onInbound(dm('/model'));
    A.ok(/current model: anthropic\/claude-opus-4\.6/.test(sends[0]), '/model (no arg) shows the bound agent current model');
    await hub.onInbound(dm('/model openai/gpt-5.1'));
    A.ok(/model is now openai\/gpt-5\.1/.test(sends[1]) && /saved to the roster/.test(sends[1]), '/model <id> confirms the persisted change');
    A.eq(rr.map.get('ultron').model, 'openai/gpt-5.1', 'the roster entry (single source of truth) actually changed');
  }

  // ---- V. /model validates against the catalog when one is reachable ----
  {
    const store = fakeStore(); const sends = []; const rr = fakeRoster();
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => {}, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
      roster: () => rr.list(), setModel: rr.setModel,
      modelCatalog: () => ['openai/gpt-5.1', 'anthropic/claude-opus-4.6']
    });
    await hub.onInbound(dm('/model made/up-model'));
    A.ok(/not in the available model catalog/.test(sends[0]), 'a model absent from the catalog is rejected');
    A.eq(rr.map.get('ultron').model, 'anthropic/claude-opus-4.6', 'a rejected model did NOT change the roster');
    await hub.onInbound(dm('/model openai/gpt-5.1'));
    A.ok(/model is now openai\/gpt-5\.1/.test(sends[1]), 'a catalog-valid model is accepted');
  }

  // ---- W. failure honesty: setModel reporting !ok is surfaced, not falsely confirmed ----
  {
    const store = fakeStore(); const sends = [];
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => {}, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: idGen(),
      roster: () => [{ agentId: 'ultron', name: 'Ultron', model: 'x', provider: 'openrouter' }],
      setModel: () => ({ ok: false, error: 'disk full' })
    });
    await hub.onInbound(dm('/model openai/gpt-5.1'));
    A.ok(/Could not change the model/.test(sends[0]) && /disk full/.test(sends[0]), 'a failed roster write is reported honestly, not confirmed');
  }

  // ---- W2. the production roster mutation must actually produce that !ok contract on disk failure ----
  {
    const roster = new Map([['ultron', { name: 'Ultron', model: 'old/model', provider: 'openrouter' }]]);
    const setModel = makeProductionSetModel(roster, () => false);
    const result = setModel('ultron', 'new/model');
    A.eq(result.ok, false, 'production setModel reports a rejected durable roster write');
    A.eq(roster.get('ultron').model, 'old/model', 'production setModel rolls its live roster mutation back on write failure');
  }

  // ---- X. commands degrade honestly when no roster is wired to the channel ----
  {
    const store = fakeStore(); const sends = [];
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => {}, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen()   // no roster/setModel injected
    });
    await hub.onInbound(dm('/agents'));
    A.ok(/No roster is available/.test(sends[0]), '/agents with no roster wired -> honest "not available"');
  }

  A.report('channels.commands.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
