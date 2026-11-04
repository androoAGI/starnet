/* test/channels.multibay.test.js — a CHANNEL message down a multi-bay line (multi-bay agents, 2026-09-22).

   Drives the REAL makeChannelHub + REAL router + REAL chain runner (wired like sidecar/index.js) with a fake
   runOnce over the acceptance floor INBOX → quill@A → mira@B → quill@C → OUTBOX. Locks the hub's dock
   plumbing: resolveAgent answers { agentId, dockId }; the entry run gets bay A's brief + room; the chain seed
   carries the dock, so the line runs quill → mira → quill (3 runs) and the third run's turn carries bay C's
   brief; each hop's station is read for ITS bay and its taskKey names the bay; the crate names bay A. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const F = require('./_multibay-floor.js');

function fakeStore() {
  const hist = new Map(), recs = new Map();
  return {
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord(c) { return recs.get(String(c)); },
    saveChatRecord(c, r) { recs.set(String(c), r); }
  };
}

(async () => {
  const router = makeRouter();
  A.ok(router.setPlan(F.plan()).ok, 'the acceptance floor arms');
  const runs = [], stationAsks = [], resolved = [];
  const runOnce = async (o) => {
    runs.push({ agentId: o.agentId, system: o.system, last: o.messages[o.messages.length - 1].content, taskKey: o.taskKey || null, station: o.station || null });
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'OUT' + runs.length + ' by ' + o.agentId });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0.01 });
    return { reason: 'done', text: 'OUT' + runs.length + ' by ' + o.agentId };   // what runOnce returns: its terminal text hands on
  };
  const chain = makeChainRunner({
    nextAgent: (a, ctx) => router.chainNext(a, ctx), stepAgent: (a, ctx) => router.chainStep(a, ctx), fanSiblings: a => router.fanSiblings(a),
    stepDock: (d, ctx) => router.chainStepDock(d, ctx), fanSiblingsDock: d => router.fanSiblingsDock(d), entryDockOf: a => router.entryDockOf(a),
    stageBrief: (a, d) => router.stageBrief(a, d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), lineLimits: l => router.lineLimits(l)
  });
  const sends = [];
  let n = 0;
  const hub = makeChannelHub({
    runOnce, store: fakeStore(),
    send: (chatId, text) => { sends.push(text); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); },
    secrets: () => ({ key: 'k', model: 'm/x', configured: true }),
    classify: () => true, emit: () => {}, newId: () => 'id' + (++n),
    resolveAgent: (ctx) => router.resolveDock(ctx),
    lineOriginFor: (a, d) => router.lineOriginFor(a, d),
    stageBriefFor: (a, d) => router.stageBrief(a, d),
    resolveStation: (a, d) => { stationAsks.push(a + '@' + (d || '-')); return router.stationFor(a, d); },
    chain,
    onResolved: (info) => resolved.push(info)
  });
  await hub.onInbound({ channel: 'telegram', chatId: '777', chatType: 'dm', userId: 'u1', text: 'write about otters', messageId: '1', ts: 1 });

  A.eq(runs.map(r => r.agentId), ['quill', 'mira', 'quill'], 'THREE runs in order: quill@A, mira@B, quill@C');
  A.ok(runs[0].system.indexOf(F.BRIEF.A) >= 0, 'the entry run’s system carries bay A’s brief');
  A.ok(runs[2].last.indexOf(F.BRIEF.C) >= 0, 'the third run’s turn carries bay C’s brief');
  A.ok(runs[2].last.indexOf(F.BRIEF.A) < 0, '…not bay A’s');
  A.eq(stationAsks, ['quill@p2', 'mira@p3', 'quill@p4'], 'each run’s station is read for ITS bay (never the union)');
  A.eq(runs.slice(1).map(r => r.taskKey), ['chain:telegram:777:mira@p3', 'chain:telegram:777:quill@p4'], 'hop taskKeys name the bay');
  A.eq(resolved.length, 1, 'one resolution announced');
  A.eq(resolved[0].dockId, 'p2', 'the resolution names the entry dock (the host lands the crate at bay A)');
  A.eq(resolved[0].lineId, router.lineOfAgent('quill', 'p2'), '…and the line it entered on');
  A.eq(sends.length, 1, 'one reply delivered');
  A.ok(/^OUT3 by quill/.test(sends[0]), 'the delivered reply is bay C’s (the last stage): ' + sends[0].slice(0, 40));

  /* a bare-string resolveAgent (every pre-dock seam) still works and reads the entry dock */
  {
    const runs2 = [];
    const hub2 = makeChannelHub({
      runOnce: async (o) => { runs2.push(o.agentId); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'x' + runs2.length }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); return { reason: 'done', text: 'x' + runs2.length }; },
      store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm/x', configured: true }),
      classify: () => true, emit: () => {}, newId: () => 'j' + (++n),
      resolveAgent: (ctx) => router.resolveTarget(ctx), lineOriginFor: (a, d) => router.lineOriginFor(a, d),
      stageBriefFor: (a, d) => router.stageBrief(a, d), resolveStation: (a, d) => router.stationFor(a, d), chain
    });
    await hub2.onInbound({ channel: 'telegram', chatId: '778', chatType: 'dm', userId: 'u1', text: 'again', messageId: '2', ts: 2 });
    A.eq(runs2, ['quill', 'mira', 'quill'], 'a string resolution still runs the whole line (seed dock = entry dock)');
  }
  A.report('channels.multibay');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
