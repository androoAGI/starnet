/* test/line-hop-stop.test.js — STOP on one step of a running line stops the LINE (sweep 2026-10-02).

   The desk screen / HUD STOP now reaches a line's hop runs (they gained stop handles). A stopped run keeps the text it had already
   written and ends 'cancelled' with no error, and the hop runners (channel hub, scheduled routine, Run-Now) handed that back as a
   finished answer: routing/chain.js passed the half-written reply to the NEXT stage, which kept spending. A hop that ended
   cancelled now returns an error, so the chain stops there and keeps the last good answer. Drives the real makeChannelHub. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

function fakeStore() {
  const hist = new Map();
  return { loadHistory: a => (hist.get(a) || []).slice(), appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord: () => undefined };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = text => ({ channel: 'telegram', chatId: '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });

(async () => {
  const hops = [];
  const runOnce = async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
    if (o.agentId === 'analyst') {   // stopped mid-answer
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'half of an analys' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 1, usd: 0.01 });
      return;
    }
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: o.agentId + ' says hi' });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
  };
  // the chain contract (routing/chain.js): a hop with an error stops the line; only a clean hop hands on
  const chain = {
    stopNote: r => (r && r.stopped ? '\n\n⚠ the work line stopped early — ' + r.stopped + '.' : ''),
    advance: async (o) => {
      const out = { hops: [], text: o.text, agentId: o.agentId, stopped: null };
      for (const agentId of ['analyst', 'editor']) {
        const r = await o.runAgent({ agentId, text: out.text, signal: o.signal });
        hops.push({ agentId, r });
        if (r.error || !String(r.text || '').trim()) { out.stopped = agentId + (r.error ? ' failed: ' + r.error : ' returned nothing'); return out; }
        out.hops.push({ agentId }); out.text = r.text; out.agentId = agentId;
      }
      return out;
    }
  };
  const sends = [];
  const hub = makeChannelHub({ runOnce, store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm1' }); },
    secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: () => {}, newId: idGen(), chain });
  await hub.onInbound(dm('analyse our suppliers'));
  const analyst = hops.find(h => h.agentId === 'analyst');
  A.ok(analyst && analyst.r.error === 'stopped by you', 'a hop that ended cancelled reports it was stopped: ' + JSON.stringify(analyst && analyst.r));
  A.ok(!hops.some(h => h.agentId === 'editor'), 'the next stage never runs on the half-written answer');
  A.ok(sends.length === 1 && /stopped early — analyst failed: stopped by you/.test(sends[0]), 'the reply says the line stopped there: ' + JSON.stringify(sends));

  // the scheduled routine's and Run-Now's hop runners carry the same rule
  // the host's two runners wherever they live (the hub's own copy is the one driven above)
  const idx = readSidecarSource({ except: ['sidecar/channels/hub.js'] });
  A.eq((idx.match(/if \(name === 'agent\.run\.end' && p && p\.reason === 'cancelled'\) hs\.stopped = true;/g) || []).length, 2, 'both index.js hop runners notice a stopped hop');
  // (worded by hopStoppedSaid: "stopped by you", or the station's fault when the process-fault quiesce stopped it)
  A.eq((idx.match(/error: hs\.errMsg \|\| \(hs\.stopped \? hopStoppedSaid\(\) : null\)/g) || []).length, 2, '…and return it as an error, so the chain stops');

  A.report('line-hop-stop.test');
})().catch(e => { console.error(e); process.exit(1); });
