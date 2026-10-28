/* node test/sendto-entry-verdicts.test.js — SEND TO carries the sending job's ENTRY VERDICTS (review finding conveyor-backend-04).

   Before: every SEND TO hand-off ran the target line's job on the trigger hub, whose entryTaint made EVERY hand-off an untrusted
   entry — so a job the Commander typed into LINE A lost Full Access on LINE B (its connector / shell steps refused), while the same
   steps drawn as ONE line kept it. Now the sending job's verdicts ride the hand-off — FAIL CLOSED:
     · the channel hub stamps the chain seed with entryTrusted / hostPowerKept, POSITIVE only, from the very verdicts it ran the entry
       run and every hop under (channels/hub.js);
     · chain.js shipped() carries them onto the shipment only as a literal true;
     · handoff-runner.js puts them on the hand-off item + lineage (the weakest along A → B → C wins) and answers the target hub's
       entryUntrusted / senderWithheld hooks from them — anything missing (a routine, Run Now, a legacy shipment, a lineage without
       them, no job in hand) is untrusted entry + host power withheld.

   Locks, on a REAL compiled station (A → B → C), the REAL chain runner, the REAL handoff runner and REAL channel hubs (the target
   hub built the way index.js makeTriggerHub builds it, forwarding the two hooks); a fake runOnce reads each run's verdicts through
   run-origin.js + taint.js exactly as runOnceCore does for a Full Access agent:
     1. HUB      — the hooks only narrow; a throwing / non-boolean hook fails closed; the seed stamp mirrors the run verdicts.
     2. CHAIN    — shipped() carries the verdicts only as a literal true.
     3. RIDES ON — a Commander-typed A keeps Full Access on B and C (B's entry run = an in-line hop's verdict); a webhook-, forwarded-
                   or attachment-started A stays untrusted on B and C; a non-owner sender's A stays withheld on B and C; a legacy
                   shipment (no verdicts) and a lineage without them stay untrusted + withheld; a host that does not forward the hooks
                   keeps today's lock.
     4. NO MINT  — the verdict fields are written only by the hub's seed and the handoff runner; no other chain entry point
                   (routines, Run Now) can stamp one. */
'use strict';
const { readSidecarSource, readSidecarIndex } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');
const taint = require('../sidecar/taint.js');
const { entryUntrusted, hostPowerWithheldFor } = require('../sidecar/run-origin.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeHandoffRunner } = require('../sidecar/routing/handoff-runner.js');
const { crewedDocksOnLine } = require('../sidecar/routing/trigger-runner.js');

const root = path.resolve(__dirname, '..');
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
const SHELL = { name: 'shell.exec', capability: 'workbench', scope: 'execute' };

function memStore() {
  const hist = new Map();
  return {
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord() { return undefined; }
  };
}

// the run verdicts runOnceCore derives for a FULL ACCESS agent: hostPowerWithheld (run-origin) turns Full Access off, untrustedEntry
// (run-origin) keeps the taint lock on — read through taint.postTaintBoundary exactly as the boundary is asked (autonomous, no prompt)
function verdictsOf(o) {
  const untrusted = entryUntrusted(o), withheld = hostPowerWithheldFor(o);
  const shell = taint.postTaintBoundary(SHELL, { taintedBy: o.initialTaint || null, surface: o.surface || 'autonomous', hasPrompt: !!o.prompt, fullAccess: !withheld, untrustedEntry: untrusted });
  return { untrusted, withheld, fullAccess: !withheld, shellAllowed: shell.allow === true };
}
const pick = (r) => ({ untrusted: r.untrusted, withheld: r.withheld, fullAccess: r.fullAccess, shellAllowed: r.shellAllowed });

/* ---------- 1. HUB: the hooks narrow, never widen; the seed stamp mirrors the run verdicts ---------- */
function hubHarness(extra) {
  const runs = [], seeds = [];
  let n = 0;
  const hub = makeChannelHub(Object.assign({
    runOnce: async (o) => {
      runs.push(Object.assign({ agentId: o.agentId, initialTaint: o.initialTaint, untrustedEntry: o.untrustedEntry, channelSender: o.channelSender, channelSenderOwner: o.channelSenderOwner }, verdictsOf(o)));
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'out of ' + o.agentId });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    },
    store: memStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm/x' }),
    classify: () => true, emit: () => {}, newId: () => 'r' + (++n), bindChats: false,
    chain: { stopNote: () => '', advance: async (o) => {
      seeds.push(o);
      const a = await o.runAgent({ agentId: 'stage-two', text: 'PIPELINE HANDOFF — you are stage 2', signal: o.signal });
      return { hops: [{ agentId: 'stage-two' }], text: a.text, agentId: 'stage-two', stopped: null };
    } }
  }, extra || {}));
  return { hub, runs, seeds };
}
const msg = (text, extra) => Object.assign({ channel: 'telegram', chatId: '42', chatType: 'dm', userId: '42', text, messageId: String(Math.random()), ts: 1 }, extra || {});
// the trigger hub's shape (index.js makeTriggerHub): no chat senders, an entry taint
const TRIGGER = { channel: 'trigger', untrustedSenders: false, entryTaint: 'upstream line output' };

/* ---------- 3. the real station + chain + handoff runner + hubs ---------- */
function station() {
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 44; r.y2 = 8 + 3 * 6; }
  const st = WM.create(d);
  const L = [];
  for (let i = 0; i < 3; i++) {
    const r = LE.placeBlueprint(st, 'research_line', { x: 8, y: 4 + i * 6 });
    if (!r.ok) throw new Error('placeBlueprint ' + JSON.stringify(r));
    const of = t => r.ids.filter(id => st.propById(id).t === t);
    L.push({ intake: of('intake')[0], bays: of('bay'), outbox: of('outbox')[0] });
    st.setPropLabel(of('intake')[0], String.fromCharCode(65 + i));
  }
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  if (!st.setSendTo(L[0].outbox, L[1].intake).ok || !st.setSendTo(L[1].outbox, L[2].intake).ok) throw new Error('setSendTo');
  return { plan: P.compileRoutingPlan(st.projectGeometry()), L };
}

/* world(opts) — one fresh station run: A's entry hub of the given kind, the shared chain runner (index.js wires ONE), the handoff
   runner whose makeHub builds the target hub like index.js makeTriggerHub (opts.forward:false = a host that does not forward the
   verdict hooks — the trunk before the release-review host half). Every runOnce lands in `runs` with its verdicts. */
function world(opts) {
  const o = opts || {};
  const { plan, L } = station();
  const lineOf = id => plan.lineOfProp[id];
  const lines = { A: lineOf(L[0].intake), B: lineOf(L[1].intake), C: lineOf(L[2].intake) };
  const nameOfLine = {}; nameOfLine[lines.A] = 'A'; nameOfLine[lines.B] = 'B'; nameOfLine[lines.C] = 'C';
  const entryDock = line => crewedDocksOnLine(plan, line).sort(P.propIdCmp)[0] || null;
  const lastStage = (a, dock) => { const r = P.dockLayer(plan).dockChains[dock]; return !!(r && r.outbox && !r.deadEnd); };
  let n = 0, clock = 1000, R = null;
  const newId = () => 'id' + (++n) + 'abcdef0123456789';
  const runs = [], rowsByStream = {}, shipped = [];
  const runOnce = async (ro) => {
    clock++;
    runs.push(Object.assign({ line: nameOfLine[ro.lineId] || '?', agentId: ro.agentId, dockId: ro.dockId || null, streamId: ro.streamId || null,
      initialTaint: ro.initialTaint || null, entry: !/^upstream agent output$/.test(String(ro.initialTaint || '')) }, verdictsOf(ro)));
    if (ro.streamId) (rowsByStream[ro.streamId] = rowsByStream[ro.streamId] || []).push({ runId: ro.runId, agentId: ro.agentId, dockId: ro.dockId || null, reason: 'done', usd: 0, streamId: ro.streamId, startedAt: clock });
    ro.emit('agent.run.start', { agentId: ro.agentId, runId: ro.runId });
    ro.emit('agent.token', { agentId: ro.agentId, runId: ro.runId, delta: 'work of ' + ro.agentId });
    ro.emit('agent.run.end', { agentId: ro.agentId, runId: ro.runId, reason: 'done', turns: 1, usd: 0 });
  };
  const chain = makeChainRunner({
    nextAgent: () => null, now: () => clock, newId,
    stepDock: (dock, ctx) => P.chainStepDock(plan, dock, ctx), entryDockOf: () => null,
    lastStage,
    onShipped: (rec) => { shipped.push(rec); return R ? R.onShipped(rec) : null; }
  });
  const common = {
    runOnce, store: memStore(), classify: () => true, emit: () => {}, newId, now: () => clock, textBatchWaitMs: 0,
    chain, lineOriginFor: (agentId, dock) => (dock ? plan.lineOfProp[dock] : null) || null
  };
  // the target line's hub, built the way index.js makeTriggerHub builds it for the handoff runner (+ the host half's forwarding)
  const makeHub = (hooks) => makeChannelHub(Object.assign({}, common, {
    channel: 'trigger', maxMessageLength: 4000, agentPrefix: 'trg_', untrustedSenders: false, bindChats: false,
    send: (chatId, text) => { hooks.send(text); return Promise.resolve({ ok: true }); },
    secrets: () => ({}),
    resolveEntryRunConfig: (agentId) => hooks.entryAllowed(agentId) ? { key: 'k', model: 'm/x' } : { ok: false, error: 'no crewed dock' },
    resolveRunConfig: () => ({ key: 'k', model: 'm/x' }),
    resolveAgent: () => { const line = hooks.lineId(); const dock = line ? entryDock(line) : null; return hooks.onRouted(dock ? { agentId: plan.agentOfDock[dock], dockId: dock } : null); },
    onResolved: hooks.onResolved, onLineOutcome: hooks.onLineOutcome,
    entryTaint: 'upstream line output',
    entryUntrusted: o.forward === false ? undefined : hooks.entryUntrusted,
    senderWithheld: o.forward === false ? undefined : hooks.senderWithheld,
    streamId: () => hooks.streamId()
  }));
  R = makeHandoffRunner({
    makeHub, plan: () => plan, jobs: {}, emit: () => {}, shipsToOutbox: lastStage,
    runsFor: (sid) => rowsByStream[sid] || [], now: () => clock, newId, warn: () => {}
  });
  // A's entry hub: routes every message to LINE A's entry dock
  const aDock = entryDock(lines.A);
  const entryHub = (extra) => makeChannelHub(Object.assign({}, common, {
    send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm/x' }), bindChats: false,
    resolveAgent: () => ({ agentId: plan.agentOfDock[aDock], dockId: aDock }),
    resolveRunConfig: () => ({ key: 'k', model: 'm/x' })
  }, extra || {}));
  async function settle() {
    for (let i = 0; i < 400; i++) {
      await tick(2);
      const s = R.status();
      if (!s.lines.some(l => l.running || l.queued)) { await tick(2); if (!R.status().lines.some(l => l.running || l.queued)) return; }
    }
    throw new Error('the hand-offs never settled: ' + JSON.stringify(R.status()));
  }
  const on = (line) => runs.filter(r => r.line === line);
  return { plan, L, lines, R, runs, shipped, entryHub, settle, on, rowsByStream };
}

(async () => {
  /* ---------- 1. HUB ---------- */
  {
    // today's trigger hub (no hooks): the entry is untrusted; nothing is withheld (no chat senders); the seed says so
    const h = hubHarness(TRIGGER);
    await h.hub.onInbound(msg('[HAND-OFF] job', { channel: 'trigger' }));
    A.eq([h.runs[0].untrustedEntry, h.runs[1].untrustedEntry], [true, true], 'no hooks: an entryTaint hub keeps today\'s rule — the entry and its hop are untrusted');
    A.eq([h.seeds[0].entryTrusted, h.seeds[0].hostPowerKept], [undefined, true], '…the seed carries NO entryTrusted (the job was untrusted) and hostPowerKept (nothing was withheld)');
  }
  {
    const h = hubHarness(Object.assign({}, TRIGGER, { entryUntrusted: () => false, senderWithheld: () => false }));
    await h.hub.onInbound(msg('[HAND-OFF] job', { channel: 'trigger' }));
    A.eq([h.runs[0].untrustedEntry, h.runs[1].untrustedEntry], [undefined, undefined], 'a trusted sending job: neither the entry nor its hop is untrusted');
    A.eq(h.runs[0].initialTaint, 'upstream line output', '…but the entry still STARTS TAINTED by the upstream line\'s output, like a chain hop');
    A.eq([h.runs[0].shellAllowed, h.runs[1].shellAllowed], [true, true], '…so Full Access lifts the taint lock on both, exactly as on an in-line hop');
    A.eq([h.seeds[0].entryTrusted, h.seeds[0].hostPowerKept], [true, true], '…and the seed stamps both verdicts for the next hand-off');
  }
  {
    const h = hubHarness(Object.assign({}, TRIGGER, { entryUntrusted: () => false }));
    await h.hub.onInbound(msg('fwd', { channel: 'trigger', forwarded: true }));
    A.eq([h.runs[0].untrustedEntry, h.runs[1].untrustedEntry], [true, true], 'a trusted verdict never lifts a forwarded message\'s own untrusted entry');
    A.eq(h.seeds[0].entryTrusted, undefined, '…and the seed does not stamp it');
  }
  for (const [label, fn] of [['undefined', () => undefined], ['"false"', () => 'false'], ['0', () => 0], ['a throw', () => { throw new Error('hook bug'); }]]) {
    const h = hubHarness(Object.assign({}, TRIGGER, { entryUntrusted: fn, senderWithheld: fn }));
    await h.hub.onInbound(msg('job ' + label, { channel: 'trigger' }));
    A.eq(h.runs[0].untrustedEntry, true, 'an entryUntrusted hook answering ' + label + ' fails CLOSED: untrusted');
    A.eq([h.runs[0].channelSender, h.runs[0].channelSenderOwner, h.runs[1].channelSender, h.runs[1].channelSenderOwner], [true, false, true, false],
      'a senderWithheld hook answering ' + label + ' fails CLOSED: the entry and its hop run withheld');
    A.eq([h.seeds[0].entryTrusted, h.seeds[0].hostPowerKept], [undefined, undefined], '…and nothing is stamped for the next line (' + label + ')');
  }
  {
    // the hook only matters on an entryTaint hub: a channel hub without one ignores it (an owner's own words stay owner-origin)
    const h = hubHarness({ entryUntrusted: () => true, isOwner: () => true });
    await h.hub.onInbound(msg('please do the thing'));
    A.eq(h.runs[0].untrustedEntry, undefined, 'entryUntrusted is read only on an entryTaint hub');
    A.eq([h.seeds[0].entryTrusted, h.seeds[0].hostPowerKept], [true, true], 'the owner\'s own DM: the seed stamps a trusted entry and kept host power');
  }
  {
    const h = hubHarness({ isOwner: () => false });
    await h.hub.onInbound(msg('do it', { chatType: 'group', chatId: '-7', userId: '99' }));
    A.eq([h.runs[0].withheld, h.runs[1].withheld], [true, true], 'a non-owner sender\'s run and hop are withheld (the hub\'s own rule)');
    A.eq([h.seeds[0].entryTrusted, h.seeds[0].hostPowerKept], [true, undefined], '…its seed stamps the trusted entry but NOT kept host power');
  }
  {
    // a senderWithheld:true hub cannot be widened by its own sender rule (an owner surface still runs withheld)
    const h = hubHarness({ ownerSurface: true, senderWithheld: () => true });
    await h.hub.onInbound(msg('job'));
    A.eq([h.runs[0].withheld, h.runs[1].withheld], [true, true], 'a withheld sending job stays withheld even on an owner surface');
    A.eq(h.seeds[0].hostPowerKept, undefined, '…and is not stamped as kept');
  }

  /* ---------- 2. CHAIN: shipped() carries the verdicts only as a literal true ---------- */
  {
    const got = [];
    const c = makeChainRunner({ nextAgent: a => ({ researcher: 'writer' })[a] || null, runAgent: async ({ agentId }) => ({ text: agentId + ' work', usd: 0 }),
      lastStage: a => a === 'writer', onShipped: r => { got.push(r); }, now: () => 0 });
    const seed = (extra) => Object.assign({ agentId: 'researcher', text: 'notes', originalText: 'job', lineId: 'L1', streamId: 's', runId: 'e' }, extra);
    await c.advance(seed({ entryTrusted: true, hostPowerKept: true }));
    await c.advance(seed({ entryTrusted: 'true', hostPowerKept: 1 }));
    await c.advance(seed({}));
    A.eq([got[0].entryTrusted, got[0].hostPowerKept], [true, true], 'a seed holding both verdicts ships them');
    A.ok(!('entryTrusted' in got[1]) && !('hostPowerKept' in got[1]), 'a non-boolean "verdict" is never carried — ' + JSON.stringify(got[1]));
    A.ok(!('entryTrusted' in got[2]) && !('hostPowerKept' in got[2]), 'a seed without them (anything that never established one) ships none — ' + JSON.stringify(got[2]));
  }

  /* ---------- 3. RIDES ON ---------- */
  // (a) the Commander typed the job into LINE A (the sample route's owner surface): B and C keep Full Access
  {
    const w = world();
    await w.entryHub({ channel: 'sample', ownerSurface: true, streamId: 'sample-cmd1' }).onInbound(msg('Research Mars and publish it', { channel: 'sample', chatId: 'smp' }));
    await w.settle();
    const a = w.on('A'), b = w.on('B'), c = w.on('C');
    A.ok(a.length === 2 && b.length === 2 && c.length === 2, 'the job ran A (2 steps) → B (2 steps) → C (2 steps): ' + JSON.stringify(w.runs.map(r => r.line)));
    A.ok(w.shipped.length >= 2 && w.shipped[0].entryTrusted === true && w.shipped[0].hostPowerKept === true, 'A\'s shipment carries the Commander job\'s verdicts');
    const inLineHop = pick(a[1]);
    A.eq(inLineHop, { untrusted: false, withheld: false, fullAccess: true, shellAllowed: true }, 'an IN-LINE hop of the Commander\'s job keeps Full Access (the baseline)');
    A.eq(pick(b[0]), inLineHop, 'B\'s entry run gets the SAME verdict as an in-line hop: Full Access kept, the tainted shell step allowed');
    A.eq(b[0].initialTaint, 'upstream line output', '…while still starting tainted by the upstream line\'s output');
    A.eq(pick(b[1]), inLineHop, '…and so does B\'s own hop');
    A.eq([pick(c[0]), pick(c[1])], [inLineHop, inLineHop], 'C (handed on from B) keeps it too');
  }
  // (a') the Commander in their own Telegram DM: the same
  {
    const w = world();
    await w.entryHub({ channel: 'telegram', isOwner: () => true }).onInbound(msg('Research Mars'));
    await w.settle();
    A.ok(w.on('B').length === 2 && w.on('B').concat(w.on('C')).every(r => !r.untrusted && !r.withheld && r.shellAllowed), 'the owner\'s Telegram DM job keeps Full Access on B and C — ' + JSON.stringify(w.on('B').concat(w.on('C')).map(pick)));
  }
  // (a'') the SAME Commander job on a host that does not forward the hooks (the trunk before the host half): today's lock
  {
    const w = world({ forward: false });
    await w.entryHub({ channel: 'sample', ownerSurface: true, streamId: 'sample-nofwd' }).onInbound(msg('Research Mars', { channel: 'sample', chatId: 'smp' }));
    await w.settle();
    A.ok(w.on('B').length === 2 && w.on('B').every(r => r.untrusted && !r.shellAllowed), 'without the host forwarding the hooks, B stays under the untrusted-entry lock (the bug this fixes)');
  }
  // (b) a WEBHOOK-started A (the trigger hub's own entryTaint): untrusted on A, B and C
  {
    const w = world();
    await w.entryHub(Object.assign({}, TRIGGER, { entryTaint: 'line trigger payload', streamId: 'trg-1' })).onInbound(msg('[Line trigger] {"order":7}', { channel: 'trigger', chatId: 'trg' }));
    await w.settle();
    const all = w.on('A').concat(w.on('B'), w.on('C'));
    A.ok(w.on('B').length === 2 && w.on('C').length === 2, 'the webhook job rode on to B and C');
    A.ok(all.every(r => r.untrusted && !r.shellAllowed), 'a webhook-started job stays untrusted on EVERY line: the tainted shell step is refused despite Full Access — ' + JSON.stringify(all.map(pick)));
    A.ok(all.every(r => !r.withheld), '…and, as today, nothing is withheld (a trigger has no chat sender)');
    A.ok(w.shipped.every(s => s.entryTrusted !== true), '…and no shipment of it ever carries entryTrusted');
  }
  // (c) a FORWARDED message from the owner: untrusted on A, B and C
  {
    const w = world();
    await w.entryHub({ channel: 'telegram', isOwner: () => true }).onInbound(msg('look at this', { forwarded: true }));
    await w.settle();
    const all = w.on('A').concat(w.on('B'), w.on('C'));
    A.ok(w.on('C').length === 2 && all.every(r => r.untrusted && !r.shellAllowed), 'a forwarded-message job stays untrusted on B and C — ' + JSON.stringify(all.map(pick)));
  }
  // (d) an ATTACHMENT-started job from the owner: untrusted on A, B and C
  {
    const w = world();
    await w.entryHub({ channel: 'telegram', isOwner: () => true,
      fetchMedia: async () => ({ ok: true, buffer: Buffer.from('png') }),
      saveAttachment: (agentId, name) => ({ ok: true, id: 'att1', name, path: '.attachments/' + name, mediaType: 'image/png', kind: 'image' })
    }).onInbound(msg('what is in this?', { media: [{ kind: 'photo', name: 'p.png', mime: 'image/png', fileId: 'f1' }] }));
    await w.settle();
    const all = w.on('A').concat(w.on('B'), w.on('C'));
    A.ok(w.on('A')[0] && w.on('A')[0].initialTaint === 'channel attachment', 'the entry run was started by the attachment');
    A.ok(w.on('C').length === 2 && all.every(r => r.untrusted && !r.shellAllowed), 'an attachment-started job stays untrusted on B and C — ' + JSON.stringify(all.map(pick)));
  }
  // (e) a NON-OWNER sender's job (a group member): withheld on A, B and C
  {
    const w = world();
    await w.entryHub({ channel: 'telegram', isOwner: () => false }).onInbound(msg('do the research', { chatType: 'group', chatId: '-100', userId: '77' }));
    await w.settle();
    const all = w.on('A').concat(w.on('B'), w.on('C'));
    A.ok(w.on('B').length === 2 && w.on('C').length === 2, 'the non-owner\'s job rode on to B and C');
    A.ok(all.every(r => r.withheld && !r.fullAccess), 'a non-owner sender\'s job stays WITHHELD on every line — never gains Full Access by a hand-off — ' + JSON.stringify(all.map(pick)));
    A.ok(all.filter(r => r.initialTaint).length === 5 && all.filter(r => r.initialTaint).every(r => !r.shellAllowed), '…so every tainted step (A\'s hop, all of B and C) is refused the shell');
    A.ok(w.shipped.every(s => s.hostPowerKept !== true), '…and no shipment of it carries hostPowerKept');
  }
  // (f') a ROUTINE's shipment (index.js stamps hostPowerKept on the scheduled + Run Now seeds, never entryTrusted): untrusted, NOT withheld
  //      — exactly today's level for a routine-started hand-off, never stricter, never trusted
  {
    const w = world();
    const aLast = w.L[0].bays.slice().sort(P.propIdCmp).pop();
    const q = w.R.onShipped({ lineId: w.lines.A, agentId: w.plan.agentOfDock[aLast], dockId: aLast, outboxId: w.L[0].outbox, text: 'routine output', originalText: 'the routine', streamId: null, hostPowerKept: true });
    A.ok(q.ok, 'the routine\'s shipment is handed on — ' + JSON.stringify(q));
    await w.settle();
    const bc = w.on('B').concat(w.on('C'));
    A.ok(w.on('B').length === 2 && w.on('C').length === 2 && bc.every(r => r.untrusted && !r.withheld && !r.shellAllowed), 'a routine\'s hand-off runs untrusted but not withheld on B and C (today\'s level) — ' + JSON.stringify(bc.map(pick)));
  }
  // (f) a LEGACY shipment (no verdict fields: anything from before this change): untrusted + withheld
  {
    const w = world();
    const aLast = w.L[0].bays.slice().sort(P.propIdCmp).pop();
    const q = w.R.onShipped({ lineId: w.lines.A, agentId: w.plan.agentOfDock[aLast], dockId: aLast, outboxId: w.L[0].outbox, text: 'routine output', originalText: 'the routine', streamId: null });
    A.ok(q.ok, 'the legacy shipment is handed on — ' + JSON.stringify(q));
    await w.settle();
    const bc = w.on('B').concat(w.on('C'));
    A.ok(w.on('B').length === 2 && w.on('C').length === 2 && bc.every(r => r.untrusted && r.withheld && !r.shellAllowed), 'a shipment with no verdicts runs untrusted + withheld on B and C — ' + JSON.stringify(bc.map(pick)));
  }
  // (g) non-boolean verdicts on a shipment are not verdicts
  {
    const w = world();
    const aLast = w.L[0].bays.slice().sort(P.propIdCmp).pop();
    w.R.onShipped({ lineId: w.lines.A, agentId: w.plan.agentOfDock[aLast], dockId: aLast, outboxId: w.L[0].outbox, text: 'x', originalText: 'x', entryTrusted: 'true', hostPowerKept: 1 });
    await w.settle();
    A.ok(w.on('B').length === 2 && w.on('B').every(r => r.untrusted && r.withheld), 'entryTrusted:"true" / hostPowerKept:1 on a shipment grant nothing');
  }
  // (h) the WEAKEST verdict along the lineage wins: B's shipment claiming trust cannot outrank a lineage that never had it
  {
    const w = world();
    const bLast = w.L[1].bays.slice().sort(P.propIdCmp).pop();
    w.R._internals.lineage.set('handoff-legacyB', { lines: [w.lines.A, w.lines.B], depth: 1, original: 'the job' });   // a lineage entry without verdicts
    w.R.onShipped({ lineId: w.lines.B, agentId: w.plan.agentOfDock[bLast], dockId: bLast, outboxId: w.L[1].outbox, text: 'B out', originalText: 'x', streamId: 'handoff-legacyB', entryTrusted: true, hostPowerKept: true });
    await w.settle();
    A.ok(w.on('C').length === 2 && w.on('C').every(r => r.untrusted && r.withheld), 'a lineage without verdicts keeps C untrusted + withheld whatever B\'s shipment claims — ' + JSON.stringify(w.on('C').map(pick)));
    const w2 = world();
    w2.R._internals.lineage.set('handoff-untrB', { lines: [w2.lines.A, w2.lines.B], depth: 1, original: 'the job', entryTrusted: false, hostPowerKept: true });
    w2.R.onShipped({ lineId: w2.lines.B, agentId: w2.plan.agentOfDock[bLast], dockId: bLast, outboxId: w2.L[1].outbox, text: 'B out', originalText: 'x', streamId: 'handoff-untrB', entryTrusted: true, hostPowerKept: true });
    await w2.settle();
    A.ok(w2.on('C').length === 2 && w2.on('C').every(r => r.untrusted && !r.withheld), '…a lineage that was untrusted keeps C untrusted (and keeps what it did have)');
  }

  /* ---------- 4. NO MINT: only the hub's seed and the handoff runner write the verdicts ---------- */
  {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (/\.js$/.test(e.name) && /\b(entryTrusted|hostPowerKept)\b/.test(fs.readFileSync(p, 'utf8'))) files.push(path.relative(root, p).split(path.sep).join('/'));
      }
    })(path.join(root, 'sidecar'));
    A.eq(files.sort(), ['sidecar/channels/hub.js', 'sidecar/index.js', 'sidecar/routing/chain.js', 'sidecar/routing/handoff-runner.js'],
      'the verdict fields live ONLY in the hub (which established them), the routine seeds (hostPowerKept only), the chain (which carries them) and the handoff runner');
    // a per-file pin on purpose: the walk above already fails on any OTHER file that starts naming the verdict fields
    const idxSrc = readSidecarIndex();
    A.eq((idxSrc.match(/\bentryTrusted\b/g) || []).length, 0, 'index.js never stamps entryTrusted (a routine / Run Now entry is not the hub\'s verdict to mint)');
    A.eq((idxSrc.match(/^\s*hostPowerKept: true,/gm) || []).length, 2, 'index.js stamps hostPowerKept on exactly the two routine seeds (scheduled advanceChain + Run Now) — a routine never withholds host power');
    const hubSrc = fs.readFileSync(path.join(root, 'sidecar', 'channels', 'hub.js'), 'utf8');
    A.eq((hubSrc.match(/entryTrusted: lineEntryUntrusted \? undefined : true,/g) || []).length, 1, 'the hub stamps entryTrusted once, from the verdict its runs carry');
    A.eq((hubSrc.match(/hostPowerKept: \(runChannelSender === true && runChannelSenderOwner !== true\) \? undefined : true,/g) || []).length, 1, '…and hostPowerKept once, by run-origin\'s own withheld test');
    const chainSrc = fs.readFileSync(path.join(root, 'sidecar', 'routing', 'chain.js'), 'utf8');
    A.ok(/if \(s\.entryTrusted === true\) rec\.entryTrusted = true;\s*\n\s*if \(s\.hostPowerKept === true\) rec\.hostPowerKept = true;/.test(chainSrc), 'chain.js carries them only as a literal true');
    const hoSrc = fs.readFileSync(path.join(root, 'sidecar', 'routing', 'handoff-runner.js'), 'utf8');
    A.ok(/entryUntrusted: \(\) => !\(s\.current && s\.current\.entryTrusted === true\),/.test(hoSrc) && /senderWithheld: \(\) => !\(s\.current && s\.current\.hostPowerKept === true\),/.test(hoSrc),
      'the handoff runner\'s hooks fail closed (only a positive verdict lifts either)');
    // the HOST HALF: index.js makeTriggerHub forwards the hooks to the hub (39d51ba78). Without it every hand-off keeps today's lock.
    const idx = readSidecarSource();
    const trig = (idx.split('function makeTriggerHub(hooks) {')[1] || '').split('\n}\n')[0];
    A.ok(trig.length > 0, 'found index.js makeTriggerHub');
    A.ok(/entryUntrusted: hooks\.entryUntrusted, senderWithheld: hooks\.senderWithheld,/.test(trig), 'index.js makeTriggerHub forwards BOTH verdict hooks to the hub');
    A.ok(/makeHub: \(hooks\) => makeTriggerHub\(Object\.assign\(\{\}, hooks, \{ persona: HANDOFF_PERSONA, entryTaint: 'upstream line output' \}\)\)/.test(idx), '…and the handoff runner\'s hub passes its hooks straight through');
  }

  A.report('sendto-entry-verdicts.test');
})().catch(e => { console.error(e); process.exit(1); });
