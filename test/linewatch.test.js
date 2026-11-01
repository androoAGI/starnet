/* node test/linewatch.test.js — LINE WATCH (frontend/app/linewatch.js): the bay-lamp state machine, the crate
   card field resolver and the per-line plate text. Pure — events in, read-outs out.

   Laws under test:
     • WORKING only after agent.run.start confirms a run AT that dock (a placement alone never lights it);
     • runs pair with placements per agent, oldest first — a multi-bay agent's run lights the bay its crate named;
     • FAILED holds until the next success at that dock or an ack; seeded outcomes never overwrite a live end;
     • WAITING needs a queue the server still holds (agent busy, or a fresh placement), never forever;
     • PAUSED comes from the step-test session, on the dock that just finished;
     • the crate card shows only what the harness proved — a crate whose run has not started says so. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const LW = require('../frontend/app/linewatch.js');

const plan = { entryDock: { quill: 'bA', mira: 'bB' } };
const w = LW.create({ entryDock: a => plan.entryDock[a] || null });
const st = (d, t) => w.status(d, t).state;

// ---- idle floor ----
A.eq(st('bA', 0), 'idle', 'a bay with nothing is IDLE');

// ---- placement -> waiting (grace) -> the confirmed start -> WORKING ----
w.onEvent('workitem.placed', { workitemId: 'w1', agentId: 'quill', dockId: 'bA', lineId: 'L', kind: 'sample', preview: 'sea otters' }, 1000);
A.eq(st('bA', 1100), 'waiting', 'a fresh placement reads WAITING during the dispatch grace');
A.eq(st('bA', 1000 + LW.WAIT_GRACE_MS + 1), 'idle', 'a placement whose run never starts (agent idle) is not a queue forever');
w.onEvent('agent.run.start', { agentId: 'quill', runId: 'r1', trigger: 'event' }, 1200);
A.eq(st('bA', 1300), 'working', 'agent.run.start confirms the run -> WORKING');
A.eq(w.status('bA', 1300).runId, 'r1', 'the lamp names the run');
w.onEvent('agent.run.start', { agentId: 'quill', runId: 'r1', trigger: 'event' }, 1250);
A.eq(w.snapshot().live.bA, ['r1'], 'a duplicated start (local + SSE echo) is one run');
A.eq(w.runOfWorkitem('w1').runId, 'r1', 'the crate knows the run that picked it up');
w.onEvent('agent.cost', { agentId: 'quill', runId: 'r1', usd: 0.002, reconciled: true }, 1400);
w.onEvent('agent.cost', { agentId: 'quill', runId: 'r1', usd: 0.001, reconciled: true }, 1500);
A.ok(Math.abs(w.run('r1').usd - 0.003) < 1e-12, 'reconciled cost sums per run');

// ---- a second crate for the busy agent queues -> WAITING (no grace needed while busy) ----
w.onEvent('workitem.placed', { workitemId: 'w2', agentId: 'quill', dockId: 'bC', lineId: 'L', kind: 'chain' }, 2000);
A.eq(st('bC', 2000 + LW.WAIT_GRACE_MS + 50), 'waiting', 'a crate queued behind a busy agent reads WAITING at ITS bay');
A.eq(w.status('bC', 9000).queued, 1, 'queued count');
A.eq(st('bA', 2100), 'working', 'bay A still working');
w.onEvent('agent.run.end', { agentId: 'quill', runId: 'r1', reason: 'done', turns: 1, usd: 0.003 }, 3000);
A.eq(st('bA', 3100), 'idle', 'a clean end returns the bay to IDLE');
A.eq(w.lastOutcome('bA').reason, 'done', 'the bay remembers its last outcome');
// multi-bay: quill's NEXT run pairs with the bC crate, not bay A
w.onEvent('agent.run.start', { agentId: 'quill', runId: 'r2', trigger: 'event' }, 3200);
A.eq(st('bC', 3300), 'working', 'the multi-bay agent\'s next run lights the bay its crate named');
A.eq(st('bA', 3300), 'idle', '…and not its other bay');

// ---- failure -> FAILED holds until success or ack ----
w.onEvent('agent.run.error', { agentId: 'quill', runId: 'r2', message: 'provider answered 500' }, 3400);
w.onEvent('agent.run.end', { agentId: 'quill', runId: 'r2', reason: 'error', turns: 0, usd: 0 }, 3500);
let s = w.status('bC', 3600);
A.eq(s.state, 'failed', 'an error end turns the bay FAILED');
A.eq(s.error, 'provider answered 500', 'the failure carries the sidecar\'s own message');
A.eq(st('bC', 99999999), 'failed', 'FAILED does not time out');
A.ok(w.ack('bC'), 'a click acks the failure');
A.eq(st('bC', 3700), 'idle', 'an acked failure goes dark');
A.ok(!w.ack('bC'), 'acking twice is a no-op');
w.onEvent('workitem.placed', { workitemId: 'w3', agentId: 'mira', dockId: 'bB', kind: 'chain' }, 4000);
w.onEvent('agent.run.start', { agentId: 'mira', runId: 'r3' }, 4001);
w.onEvent('agent.run.end', { agentId: 'mira', runId: 'r3', reason: 'refusal' }, 4100);
A.eq(st('bB', 4200), 'failed', 'a refusal is a failure');
w.onEvent('workitem.placed', { workitemId: 'w4', agentId: 'mira', dockId: 'bB', kind: 'chain' }, 4300);
w.onEvent('agent.run.start', { agentId: 'mira', runId: 'r4' }, 4301);
A.eq(st('bB', 4302), 'working', 'WORKING outranks the red lamp');
w.onEvent('agent.run.end', { agentId: 'mira', runId: 'r4', reason: 'done' }, 4400);
A.eq(st('bB', 4500), 'idle', 'the next success clears FAILED');
w.onEvent('workitem.placed', { workitemId: 'w5', agentId: 'mira', dockId: 'bB', kind: 'chain' }, 4600);
w.onEvent('agent.run.start', { agentId: 'mira', runId: 'r5' }, 4601);
w.onEvent('agent.run.end', { agentId: 'mira', runId: 'r5', reason: 'cancelled' }, 4700);
A.eq(st('bB', 4800), 'idle', 'a human stop (cancelled) is not a failure');

// ---- a run with no placement (a COMMS order) lights no bay; a directive placement never names one ----
w.onEvent('workitem.placed', { workitemId: 'w6', agentId: 'mira', kind: 'directive' }, 5000);
w.onEvent('agent.run.start', { agentId: 'mira', runId: 'r6', trigger: 'directive' }, 5001);
A.eq(st('bB', 5002), 'idle', 'a direct order is not work AT the bay');
w.onEvent('agent.run.end', { agentId: 'mira', runId: 'r6', reason: 'error' }, 5003);
A.eq(st('bB', 5004), 'idle', '…and its failure never reddens the bay');
// a routed placement with no dockId falls back to the agent's entry dock (the router's own read)
w.onEvent('workitem.placed', { workitemId: 'w7', agentId: 'mira', kind: 'cron', lineId: 'L' }, 6000);
w.onEvent('agent.run.start', { agentId: 'mira', runId: 'r7', trigger: 'schedule' }, 6001);
A.eq(st('bB', 6002), 'working', 'a routine with no FIRES AT lights the entry dock');
// superseded placements leave the queue
w.onEvent('workitem.placed', { workitemId: 'w8', agentId: 'mira', dockId: 'bB', kind: 'chain' }, 6100);
w.onEvent('workitem.superseded', { workitemId: 'w8', agentId: 'mira' }, 6101);
A.ok(!(w.snapshot().pending.mira || []).length, 'a superseded crate is no longer queued');
// the snapshot reconcile stands down a run the server no longer lists
w.reconcileLive([], 6010, 15000);
A.eq(st('bB', 6011), 'working', 'a snapshot older than the run never stands a fresh run down');
w.reconcileLive([], 30000, 15000);
A.eq(st('bB', 30001), 'idle', 'a run the server no longer reports stops reading WORKING');

// ---- seeded outcomes (after a reload) ----
const w2 = LW.create();
w2.seedOutcomes({ bX: { runId: 'old1', reason: 'error', failed: true }, bY: { runId: 'old2', reason: 'done', failed: false } });
A.eq(w2.status('bX', 0).state, 'failed', 'a reload keeps the red lamp from the server\'s last outcome');
A.eq(w2.status('bY', 0).state, 'idle', 'a seeded success is idle');
w2.setAcked(['old1']);
A.eq(w2.status('bX', 0).state, 'idle', 'a remembered ack survives the reload');
w2.onEvent('workitem.placed', { workitemId: 'z', agentId: 'ada', dockId: 'bY' }, 10);
w2.onEvent('agent.run.start', { agentId: 'ada', runId: 'new' }, 11);
w2.onEvent('agent.run.end', { agentId: 'ada', runId: 'new', reason: 'budget' }, 12);
w2.seedOutcomes({ bY: { runId: 'older', reason: 'done', failed: false } });
A.eq(w2.status('bY', 13).state, 'failed', 'a stale server answer never overwrites the end this page saw');

// ---- step test: PAUSED on the dock that just finished ----
w2.setStepTest({ id: 'st1', lineId: 'L', state: 'paused', hops: [{ dockId: 'bP' }], paused: { afterHop: 0 } });
A.eq(w2.status('bP', 0).state, 'paused', 'a paused step test holds its dock PAUSED');
w2.setStepTest({ id: 'st1', state: 'done', hops: [] });
A.eq(w2.status('bP', 0).state, 'idle', 'a finished session releases it');
w2.setStepTest(null);

// ---- the crate card ----
const names = { agentName: a => ({ quill: 'QUILL', mira: 'MIRA' }[a] || a), dockName: d => ({ bA: 'WRITER · QUILL', bB: 'EDITOR · MIRA' }[d] || d), lineName: l => 'LINE ' + l, usd: n => '$' + n.toFixed(4) };
let card = LW.crateCard({ workitemId: 'q', agentId: 'quill', dockId: 'bA', lineId: 'L', kind: 'sample', preview: 'Write about otters', box: 'ore' }, Object.assign({ run: null, row: null, nowMs: 0 }, names));
A.eq(card.kind, 'INBOUND JOB', 'an inbound crate');
A.eq(card.rows.find(r => r[0] === 'ROUTE')[1], 'INBOX ▸ WRITER · QUILL', 'inbound route: INBOX to its bay');
A.eq(card.rows.find(r => r[0] === 'RUN')[1], 'not started yet — waiting at WRITER · QUILL', 'no run yet -> the card says so');
A.eq(card.actions.transcript, null, 'no run -> no transcript link');
card = LW.crateCard({ workitemId: 'q', agentId: 'mira', dockId: 'bB', fromDock: 'bA', from: 'quill', lineId: 'L', kind: 'chain', preview: 'draft', box: 'product' },
  Object.assign({ run: { runId: 'rr', agentId: 'mira', startedAt: 1000, usd: 0.0021, ended: null }, row: null, nowMs: 13500 }, names));
A.eq(card.kind, 'HANDOFF', 'a chain crate is a handoff');
A.eq(card.rows[0], ['CARRIES', 'draft'], 'a handoff crate says what it CARRIES (the upstream output preview)');
card = LW.crateCard({ outbound: true, box: 'product', agentId: 'mira', dockId: 'bB', runId: 'rh' },
  Object.assign({ run: { runId: 'rh', agentId: 'mira', preview: 'Write about otters', ended: { reason: 'done' } }, row: { runId: 'rh', reason: 'done', title: 'PIPELINE HANDOFF — you are stage 2 of a work line' }, nowMs: 0 }, names));
A.eq(card.rows[0], ['WORKED ON', 'Write about otters'], 'a hop row\'s generic handoff header never stands in for the job');
card = LW.crateCard({ workitemId: 'q', agentId: 'mira', dockId: 'bB', fromDock: 'bA', from: 'quill', lineId: 'L', kind: 'chain', preview: 'draft', box: 'product' },
  Object.assign({ run: { runId: 'rr', agentId: 'mira', startedAt: 1000, usd: 0.0021, ended: null }, row: null, nowMs: 13500 }, names));
A.eq(card.rows.find(r => r[0] === 'ROUTE')[1], 'WRITER · QUILL ▸ EDITOR · MIRA', 'handoff route: producing bay to receiving bay');
A.eq(card.rows.find(r => r[0] === 'RUN')[1], 'MIRA · WORKING 13s', 'a running crate shows its agent + elapsed');
A.eq(card.rows.find(r => r[0] === 'COST')[1], '$0.0021 so far (reconciled)', 'live reconciled cost');
A.eq(card.state, 'running');
A.eq(card.actions.transcript, { agentId: 'mira', runId: 'rr' }, 'a started run links its transcript');
card = LW.crateCard({ outbound: true, box: 'slag', agentId: 'mira', dockId: 'bB', lineId: 'L', runId: 'rf', postmortem: 'Provider down - retry later' },
  Object.assign({ run: { runId: 'rf', agentId: 'mira', error: 'mock upstream exploded (forced 500)', ended: { reason: 'error', usd: 0 } }, row: { runId: 'rf', agentId: 'mira', reason: 'error', usd: 0, durationMs: 4200, title: 'Edit the draft' }, nowMs: 0 }, names));
A.eq(card.kind, 'FAILED RUN', 'a slag crate');
A.eq(card.state, 'failed');
A.eq(card.rows.find(r => r[0] === 'WORKED ON')[1], 'Edit the draft', 'the recorded run title names the job');
A.eq(card.rows.find(r => r[0] === 'WHY')[1], 'mock upstream exploded (forced 500)', 'the sidecar\'s failure message is the reason');
A.eq(card.rows.find(r => r[0] === 'ROUTE')[1], 'EDITOR · MIRA ▸ off the line (scrap)', 'slag leaves the line');
A.ok(/FAILED \(error\) · 4\.2s/.test(card.rows.find(r => r[0] === 'RUN')[1]), 'recorded outcome + duration');
card = LW.crateCard({ outbound: true, box: 'product', agentId: 'mira', dockId: 'bB', runId: 'rd' },
  Object.assign({ run: null, row: { runId: 'rd', agentId: 'mira', reason: 'done', usd: 0.01, deliveryText: 'The otter piece, edited.' }, nowMs: 0 }, names));
A.eq(card.rows.find(r => r[0] === 'RESULT')[1], 'The otter piece, edited.', 'a finished crate shows its recorded result');
A.eq(card.rows.find(r => r[0] === 'LINE')[1], 'none — a direct order', 'no line -> said plainly');
card = LW.crateCard({ workitemId: 's', agentId: 'quill', dockId: 'bA', lineId: 'L', kind: 'sample', steptest: 'st9', preview: 'x' }, names);
A.eq(card.kind, 'STEP TEST', 'a step-test crate');
A.eq(card.actions.workflow, { lineId: 'L', dockId: 'bA', sessionId: 'st9' }, 'a step-test crate jumps to the Workflow panel');

// ---- plate + stats row text ----
A.eq(LW.plateLines(null), null, 'no server answer -> no plate (never fake zeros)');
// 2026-09-27 audit R3: step tests are real runs — the plate counts them when there were some (it said 0 RUNS after two)
A.eq(LW.plateLines({ runs: 0, tests: 2, shipped: 0, failed: 0, usdToday: 0.013, capUsdPerDay: null, medianMs: null })[0], '0 RUNS · 2 TESTS · 0 SHIPPED · 0 FAILED', 'tests are counted on the plate');
A.eq(LW.plateLines({ runs: 3, shipped: 1, failed: 1, usdToday: 0.0125, capUsdPerDay: 5, medianMs: 2500 }), ['3 RUNS · 1 SHIPPED · 1 FAILED', '$0.013 / $5.00 TODAY · ~2.5s/RUN', 'TODAY · 3 RUNS · 1 SHIPPED · 1 FAILED · $0.013 / $5.00 · ~2.5s/RUN'], 'plate text: rest line, $ line, hover line');
A.eq(LW.plateLines({ runs: 1, shipped: 0, failed: 0, usdToday: 0, capUsdPerDay: null, medianMs: null }), ['1 RUN · 0 SHIPPED · 0 FAILED', '$0.000 TODAY', 'TODAY · 1 RUN · 0 SHIPPED · 0 FAILED · $0.000 · NO DAILY CAP'], 'no cap, no timing — said, not hidden');
A.eq(LW.statsRow({ runs: 2, shipped: 0, failed: 1, usdToday: 1.5, capUsdPerDay: null, medianMs: 61000 })[3], ['$ TODAY', '$1.50 · no cap'], 'panel row $ cell');
// the $ ledger keeps the UTC day (line-stats spendDay:'utc'): said, never passed off as the local day the counts use
A.eq(LW.statsRow({ runs: 2, shipped: 0, failed: 1, usdToday: 1.5, capUsdPerDay: null, medianMs: 61000, spendDay: 'utc' })[3], ['$ TODAY (UTC)', '$1.50 · no cap'], 'a UTC-day $ is labelled (UTC) in the panel');
A.eq(LW.plateLines({ runs: 1, shipped: 1, failed: 0, usdToday: 0.5, capUsdPerDay: 5, medianMs: null, spendDay: 'utc' }), ['1 RUN · 1 SHIPPED · 0 FAILED', '$0.500 / $5.00 TODAY (UTC)', 'TODAY · 1 RUN · 1 SHIPPED · 0 FAILED · $0.500 / $5.00 (UTC DAY)'], 'the plate says the $ day is UTC');
A.eq(LW.fmtDur(61000), '1m', 'minute durations');
// ---- (sweep 2026-09-25) a run start that NAMES its bay lights THAT bay, not the agent's oldest crate's bay ----
{
  const m = LW.create({});
  m.onEvent('workitem.placed', { workitemId: 'x1', agentId: 'quill', dockId: 'bA', lineId: 'L', kind: 'trigger' }, 100);
  m.onEvent('workitem.placed', { workitemId: 'x2', agentId: 'quill', dockId: 'bC', lineId: 'L2', kind: 'trigger' }, 110);
  m.onEvent('agent.run.start', { agentId: 'quill', runId: 'rc', trigger: 'event', dockId: 'bC' }, 120);
  A.eq(m.status('bC', 130).state, 'working', 'the run that named bay C lights bay C');
  A.ok(m.status('bA', 130).state !== 'working', 'bay A (the OLDER crate) is not claimed as working');
  A.eq(m.runOfWorkitem('x2').runId, 'rc', 'the run is paired with the crate at its own bay');
  m.onEvent('workitem.placed', { workitemId: 'x3', agentId: 'mira', dockId: 'bB', kind: 'chain' }, 200);
  m.onEvent('workitem.placed', { workitemId: 'x4', agentId: 'mira', dockId: 'bB', kind: 'chain' }, 210);
  m.onEvent('agent.run.start', { agentId: 'mira', runId: 'rm', trigger: 'event', dockId: 'bB', workitemId: 'x4' }, 220);
  A.eq(m.runOfWorkitem('x4').runId, 'rm', 'a start that names its crate pairs with exactly that crate');
  A.eq(m.runOfWorkitem('x3'), null, 'not the older one');
  m.onEvent('agent.run.start', { agentId: 'quill', runId: 'ra', trigger: 'event' }, 300);
  A.eq(m.status('bA', 310).state, 'working', 'a start that names nothing still falls back to the oldest crate');
}

// ---- (sweep 2026-09-25) the SIDECAR names the bay on agent.run.start (additive fields, frozen contract intact) ----
{
  const fs = require('fs'), path = require('path');
  const src = readSidecarSource();
  const core = src.slice(src.indexOf('async function runOnceCore(o) {'));
  A.ok(/if \(o\.dockId\) runStartExtra\.dockId = String\(o\.dockId\);/.test(core) && /if \(o\.workitemId\) runStartExtra\.workitemId = String\(o\.workitemId\);/.test(core), 'runOnceCore carries the run\'s bay + crate');
  const starts = (core.slice(0, core.indexOf('\n}\n')).match(/emit\('agent\.run\.start', \{[^}]*\}\)/g) || []);
  A.ok(starts.length > 5 && starts.every(e => /\.\.\.runStartExtra/.test(e)), 'every run.start runOnceCore emits names them (' + starts.length + ')');
  const hub = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'channels', 'hub.js'), 'utf8');
  A.ok(/dockId: h\.dockId \|\| undefined, workitemId: h\.workitemId \|\| undefined/.test(hub), 'a hub line hop passes its crate id to the run');
  const ev = require('../shared/events.js');
  const v = ev.validate ? ev.validate('agent.run.start', { agentId: 'a', runId: 'r', trigger: 'event', model: 'm', dockId: 'p1', workitemId: 'w1' }) : { ok: true };
  A.ok(v === true || (v && (v.ok === true || v.valid === true)) || (Array.isArray(v) && !v.length), 'the frozen agent.run.start contract accepts the additive fields: ' + JSON.stringify(v));
}

// ---- (sweep 2026-09-25) a run the snapshot dropped still reports its REAL end: a failure lights FAILED ----
{
  const m = LW.create({});
  m.onEvent('workitem.placed', { workitemId: 'y1', agentId: 'nova', dockId: 'bA', lineId: 'L', kind: 'trigger' }, 1000);
  m.onEvent('agent.run.start', { agentId: 'nova', runId: 'ry', trigger: 'event', dockId: 'bA' }, 1010);
  m.reconcileLive([], 60000, 15000);   // a snapshot that did not list the run (e.g. mid provider-retry backoff)
  A.eq(m.status('bA', 60010).state, 'idle', '(the snapshot stood the lamp down)');
  m.onEvent('agent.run.error', { agentId: 'nova', runId: 'ry', message: 'provider 500' }, 90000);
  m.onEvent('agent.run.end', { agentId: 'nova', runId: 'ry', reason: 'error' }, 90010);
  A.eq(m.status('bA', 90020).state, 'failed', 'the run\'s REAL end still lands: the bay lamp goes FAILED');
  A.eq(m.lastOutcome('bA').runId, 'ry', 'with that run as the outcome');
}

const mid = LW.localMidnight(Date.UTC(2026, 8, 23, 15, 0, 0));
A.eq(new Date(mid).getHours() + new Date(mid).getMinutes(), 0, 'local midnight');

A.report();
