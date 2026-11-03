/* node test/summon-lines.test.js — SUMMON LINES + ACTIVITY TAGS (2026-10-19 … 26).
     · a delegated worker's tool steps reach the floor, but ONLY as the additive crew.tool_step event: forwarded as
       agent.tool_call/tool_result they were taken for the LEAD's own steps by every lead-side sink (0.14.1 readiness
       review R1/R4/R6/R17/R19/R25/R28/R29: doubled dashboard rows, wiped Telegram/routine replies, miscounted CLI
       receipts). The page's harness alone turns crew.tool_step back into worker steps, on U.bus;
     · a worker's tool use is never a ROOM gap: its kit is the sidecar's autonomous office, so the station-quest
       generator skips runs the harness saw arrive as delegated workers (marked BEFORE the step is re-emitted);
     · the tag tells the truth: it follows its OWN run (R9/R27), shows a cost only when one is real and priced (R18/R26),
       and goes — with every summon link to or from that agent — wherever the floor forgets the run (R24);
     · every working agent wears a small one-line tag right above its head (WORLD px, so it zooms with the room and never
       grows when the camera pulls back), and only the agent in COMMS or under the pointer gets the full card. */
'use strict';
const fs = require('fs'), path = require('path'), A = require('./_assert');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const orch = rd('sidecar/tools/builtin/orchestration.js');
const harness = rd('frontend/app/harness.js');
const quests = rd('frontend/app/stationqueststore.js');
const world = rd('frontend/app/world.js');

// 1. the forwarder — EXERCISED: lifecycle/cost pass as-is; a tool step becomes crew.tool_step, never the lead's own event
const fwd = /const FORWARD = \{([^}]*)\}/.exec(orch);
A.ok(fwd && !/'agent\.tool_call'/.test(fwd[1]) && !/'agent\.tool_result'/.test(fwd[1]) && !/'agent\.token'/.test(fwd[1]), 'FORWARD carries lifecycle + cost only: never tokens, never the lead-named tool events');
const FORWARD = Function('return {' + fwd[1] + '}')();
const makeChildEmit = Function('FORWARD', A.fnBody(orch, 'function makeChildEmit(') + '; return makeChildEmit;')(FORWARD);
(function forwarder() {
  const out = [], ctx = { runId: 'lead-1', emit: (n, p) => out.push([n, p]) };
  const ce = makeChildEmit(ctx);
  ce('agent.run.start', { agentId: 'vega', runId: 'w-1', trigger: 'directive', model: 'm' });
  ce('agent.token', { agentId: 'vega', runId: 'w-1', delta: 'hi' });
  ce('agent.tool_call', { agentId: 'vega', runId: 'w-1', callId: 'call_0', name: 'web_search', argsSummary: '{"query":"x"}' });
  ce('agent.tool_result', { agentId: 'vega', runId: 'w-1', callId: 'call_0', ok: true, isError: false, ms: 12, summary: 'BODY' });
  ce('agent.cost', { agentId: 'vega', runId: 'w-1', usd: 0.01, reconciled: true });
  const names = out.map(e => e[0]);
  A.eq(names.join(','), 'agent.run.start,crew.tool_step,crew.tool_step,agent.cost', 'the lead stream gets lifecycle, cost and crew.tool_step — no token, no agent.tool_*');
  A.ok(names.indexOf('agent.tool_call') < 0 && names.indexOf('agent.tool_result') < 0, 'a worker step can never reach a lead sink under the lead-named tool events');
  const call = out[1][1], res = out[2][1];
  A.eq([call.phase, call.name, call.runId, call.parentRunId, call.callId, call.argsSummary].join('|'), 'call|web_search|w-1|lead-1|call_0|{"query":"x"}', 'a call step carries the worker run, its lead run, the tool and its args summary');
  A.eq([res.phase, res.name, res.ok, res.ms, 'summary' in res].join('|'), 'result|web_search|true|12|false', 'a result step carries its call\'s tool name and outcome, never the result body');
  const Events = require('../shared/events.js');
  A.ok(Events.validate('crew.tool_step', call).ok && Events.validate('crew.tool_step', res).ok, 'both steps pass the contract (the run emitter drops what does not)');
})();

// 2. every lead-side sink ignores crew.tool_step (pre-lane behaviour restored by construction) — the reachable ones exercised
(function sinks() {
  const step = { name: 'crew.tool_step', payload: { agentId: 'vega', runId: 'w-1', parentRunId: 'lead-1', callId: 'call_0', name: 'web_search', phase: 'call', argsSummary: '{}' } };
  const { makeRunTracker } = require('../bin/lib/cli-core.js');
  const t = makeRunTracker();
  t.feed({ name: 'agent.run.start', payload: { agentId: 'agent', runId: 'lead-1', model: 'm' } });
  t.feed({ name: 'agent.run.start', payload: { agentId: 'vega', runId: 'w-1', model: 'w' } });
  const acts = t.feed(step);
  A.eq(acts.length + ':' + t.state.toolCalls.length, '0:0', '`starnet -p` / one-shot: a worker step is neither printed nor counted in the receipt (R19/R29)');
  A.eq(t.state.runId, 'lead-1', 'the CLI keeps the LEAD run as the one Ctrl-C / --timeout cancels (a worker run.start no longer overwrites it)');
  const { observerView } = require('../sidecar/observer.js');
  A.eq(observerView('crew.tool_step', step.payload, {}), null, '/api/observe never republishes a forwarded step (the worker\'s own tee already did: no doubled dashboard rows, R1/R25)');
  const { runTeeView } = require('../sidecar/channels/sse.js');
  A.eq(runTeeView('crew.tool_step', step.payload), null, 'the SSE tee never broadcasts it (no worker step reaches a broadcast lead\'s floor as a quest signal, R2/R7)');
  // the server reply buffers / phone / ACP / v1 sinks all branch on agent.tool_call by name: none names crew.tool_step
  // (reply-assembler.js is the reply buffer of the hub, the two drivers and the host's sinks: it does the branching for them)
  for (const f of ['sidecar/reply-assembler.js', 'sidecar/openai-compat.js', 'sidecar/acp/core.js', 'sidecar/remote/host.js']) {
    const src = rd(f);
    A.ok(/agent\.tool_call/.test(src) && !/crew\.tool_step/.test(src), f + ': resets/attributes on agent.tool_call only, so a forwarded worker step can never wipe or join the lead\'s reply (R4/R6/R17/R28)');
  }
  for (const f of ['sidecar/channels/hub.js', 'sidecar/cron-driver.js', 'sidecar/loopjob-driver.js']) {
    const src = rd(f);
    A.ok(/ssembler\.feed\(name, p\)/.test(src) && !/crew\.tool_step/.test(src), f + ': its reply buffer is the assembler, and it names no crew.tool_step of its own');
  }
})();

// 3. the page: harness turns crew.tool_step back into worker steps on U.bus, marking the run delegated FIRST
const hcase = A.fnBody(harness, "case 'crew.tool_step': {");
A.ok(hcase.indexOf('delegatedRuns.add') >= 0 && hcase.indexOf('delegatedRuns.add') < hcase.indexOf('U.bus.emit'), 'harness marks the worker run delegated before the step reaches any bus reader');
A.ok(/U\.bus\.emit\(payload\.phase === 'call' \? 'agent\.tool_call' : 'agent\.tool_result', step\)/.test(hcase), 'harness re-emits the step on U.bus only (never the lead\'s chat callbacks)');
A.ok(/isDelegatedRun: \(id\) => delegatedRuns\.has/.test(harness), 'Harness.isDelegatedRun is exported');
A.ok(/case 'agent\.tool_call': if \(runId && payload\.runId && payload\.runId !== runId\) break;/.test(harness), 'the runId gate on the lead callbacks stays as a second line of defence');

// 4. quest generator skips delegated runs, before any cap lookup
const onTool = A.fnBody(quests, 'function onToolCall(');
A.ok(onTool.indexOf('isDelegatedRun(p.runId)) return') >= 0 && onTool.indexOf('isDelegatedRun') < onTool.indexOf('capForTool'), "a worker's tool use never mints a room-gap quest");

// 5. the tag: its own run, a real cost only, gone with a forgotten run; the dispatch window belongs to the lead
A.ok(/const plateFor = p => \{[^\n]*String\(p\.runId\) === k\.runId/.test(world), 'a tag reads only its own run\'s events (R9/R27)');
for (const ev of ['agent.tool_call', 'agent.tool_result', 'cost.estimate', 'agent.cost', 'agent.run.end']) {
  A.ok(new RegExp("U\\.bus\\.on\\('" + ev.replace('.', '\\.') + "', p => \\{ const k = plateFor\\(p\\)").test(world), ev + ' updates a tag only through plateFor');
}
A.ok(/if \(p\.unpriced\) k\.unpriced = true;/.test(world) && /\(k\.usd == null \|\| k\.unpriced \|\| !\(k\.usd > 0\)\) \? ''/.test(world), 'no "$0.000": an unpriced, subscription or local run shows no cost at all (R18/R26)');
A.ok(/usd: null, est: null, unpriced: false/.test(world), 'a tag starts with NO cost (unknown, never $0)');
const rel = A.fnBody(world, 'function releaseActivity(');
A.ok(/plateByAgent\.delete\(aid\)/.test(rel) && /L\.tEnd = t/.test(rel), 'releaseActivity drops the tag and ends every link to or from the agent');
A.ok((world.match(/releaseActivity\(/g) || []).length >= 5, 'every place the floor forgets a run (TTL sweep, reconcile, outage, last run.end) releases its tag + links (R24)');
A.ok(/if \(!k\.tEnd && age > 5000 && !runStartByAgent\.has\(k\.toId\)\) k\.tEnd = now;/.test(world), 'a live link to a worker the floor no longer counts as running ends after a short grace (R24)');
const drop = A.fnBody(world, 'function dropRunFromPage(');
A.ok(/dropRun: dropRunFromPage/.test(world) && /L\.tEnd = /.test(drop) && /setTimeout\(fetchSnapshot, 1500\)/.test(drop), 'STOP mid-delegation: the lead\'s links end at once and the server\'s live-run list is asked for right away, so cancelled workers\' tags go (R24)');
A.ok(/Harness\.isDelegatedRun\(k\.runId\) && now - \(k\.taskTry \|\| 0\) > 1000\) \{ k\.taskTry = now; k\.task = workerTaskFor/.test(world), 'only a delegated worker run reads a worker-thread title as its task (R32)');
A.ok(/p\.callId === delegateCall && \(!p\.agentId \|\| p\.agentId === delegateLead\)/.test(world), 'only the LEAD\'s own result closes the dispatch window: a worker\'s colliding call_0 no longer does (R3/R31)');

// 6. look + placement (Andrew 10-26: "fantastic, perfect")
const plates = A.fnBody(world, 'function drawActivityPlates(');
A.ok(/let x = clampX\(hx - w \/ 2\), y = Math\.max\(vy0, top - H\)/.test(plates) && !/atDesk/.test(plates), 'every tag sits right above its own agent (centred over the head), never off to a desk side');
A.ok(/ACT_PLATE_FONT = "5px /.test(world), 'tags are WORLD px: they scale with the station and never grow when the camera zooms out');
A.ok(/b === hoverAgent \|\| \(chatFocusId != null && aid === chatFocusId\)/.test(plates), 'only the agent in COMMS or under the pointer gets the full card');
A.ok(plates.indexOf('crewIsAwaiting(b)') >= 0, 'a tag stands down while its agent waits on the Commander');
A.ok(/PLATES_ON && plateByAgent\.has\(aid\)\) continue;   \/\/ its ACTIVITY PLATE carries this clock/.test(world), 'one clock per run: the RUN tag stands down for a plated agent');

A.report('summon-lines');
