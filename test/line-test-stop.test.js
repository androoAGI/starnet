/* test/line-test-stop.test.js — a LINE TEST you can stop, and a crew row that says what it is (2026-09-29, handed over by the
   steptest-stuck investigation).

   1. RUN ONE REAL JOB had no stop: while the job rode the line the Workflow panel showed only a disabled "THE JOB IS RIDING
      THE LINE…", and the one way out was the station-wide E-STOP. POST /api/routing/sample/stop stops THIS station's one
      sample (the E-STOP kill scoped to the sample hub), the in-flight sample POST answers stopped:true, and the panel's
      ■ STOP says STOPPED from that answer (the end-to-end proof is test/routing.sample-stop.e2e.test.js).
   2. A line test's runs (a step test's steptest-…, a sample's sample-…) are real work whose words live in the line's TEST
      view, not the agent's COMMS — the crew row read WORKING while COMMS showed nothing, and a Commander read it as stuck.
      agent.run.start now carries streamId (additive), and the crew row names such a run LINE TEST with a tip saying where
      it shows and how it stops. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { killAll } = require('../sidecar/halt.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const sidecar = readSidecarSource(), build = read('frontend/app/build.js'), panel = read('frontend/app/workflowpanel.js'), station = read('frontend/app/stationui.js');
// a function's source, from its head to the closing brace at the head's own indent (top-level or inside an IIFE)
function fnBody(src, head) {
  const i = src.indexOf(head);
  A.ok(i >= 0, head + ' exists');
  const indent = (/^\n?( *)/.exec(head) || [, ''])[1];
  const j = src.indexOf('\n' + indent + '}\n', i);
  A.ok(j > i, head + ' closes');
  return src.slice(i, j + indent.length + 2);
}

/* ---------- 1. the sidecar: a stop for THIS sample only ---------- */
A.ok(/\{ m: 'POST', exact: '\/api\/routing\/sample\/stop', h: handleRoutingSampleStop \}/.test(sidecar), 'POST /api/routing/sample/stop is in the route table (behind the same token gate as every /api route)');
// the stop core is shared with station.test_line (a stopped lead run stops its test job): read both
const stopFn = fnBody(sidecar, '\nfunction stopSampleJob(') + fnBody(sidecar, '\nfunction handleRoutingSampleStop(');
A.ok(/if \(!sampleInFlight\) return null;[\s\S]*if \(!r\) return json\(409, \{ ok: false, error: 'no sample job is riding the line/.test(stopFn), 'nothing riding the line → 409 {ok:false,error} (never a route-miss)');
A.ok(/sampleInFlight\.stopRequested = true;/.test(stopFn), 'it marks the in-flight sample as stopped by the Commander…');
A.ok(/killAll\(null, \(sampleHub && sampleHub\._internals\) \? sampleHub\._internals\.inflight : null\)/.test(stopFn), '…and kills ONLY the sample hub\'s runs, the way E-STOP does (entry run and every chained stage)');
A.ok(!/killAll\(runs/.test(stopFn), 'it never touches the browser\'s runs or any other hub');
// the route's core moved into runSampleJob (2026-10-01) so the lead's station.test_line runs the very same job; the route
// is a thin wrapper over it
A.ok(/async function handleRoutingSample\(req, res\) \{\n  const r = await runSampleJob\(/.test(sidecar), 'POST /api/routing/sample runs runSampleJob, the one core');
const sampleFn = fnBody(sidecar, '\nasync function runSampleJob(');
A.ok(/if \(sampleInFlight\.stopRequested\) return json\(409, \{ ok: false, stopped: true, error: 'stopped before it started — nothing ran\.' \}\);[\s\S]{0,80}const t0 = Date\.now\(\);/.test(sampleFn), 'a stop that lands before the first run starts is honoured: nothing runs, nothing is spent');
// the words live in routing/sample-verdict.js since quick win 26 (one place picks the record's and the route's reason)
A.ok(/const stopped = !!sampleInFlight\.stopRequested;/.test(sampleFn) && /stoppedByUser: !!sampleInFlight\.stopRequested/.test(sampleFn) && /error: problem\.routeError/.test(sampleFn) && /stopped \? \{ stopped: true \} : null/.test(sampleFn)
  && require('../sidecar/routing/sample-verdict.js').sampleProblem({ stoppedByUser: true, onLine: true, runs: [{ reason: 'stopped' }], lineStopped: 'writer failed' }).routeError === 'stopped — you stopped this job before it reached the OUTBOX',
  'a job stopped mid-line answers stopped:true and names the stop — never "the line failed"');
A.ok(/if \(o\.streamId\) runStartExtra\.streamId = String\(o\.streamId\);/.test(sidecar), 'agent.run.start carries the run\'s streamId (additive — obj() stanzas allow it)');
{
  // the sample hub's record shape is what killAll stops: marked superseded + halted (no stale reply, no further hop)
  let aborted = 0;
  const rec = { runId: 'r1', abort: { abort: () => { aborted++; } }, superseded: false, halted: false };
  A.eq(killAll(null, new Map([['sample', rec]])), 1, 'killAll counts the sample\'s run');
  A.ok(aborted === 1 && rec.superseded === true && rec.halted === true, '…aborts it and marks it halted, so the chain goes no further');
}

/* ---------- 2. the readout: STOPPED is the server's word ---------- */
{
  const BEGIN = 'REFIT-JUNCTION-PURE-BEGIN', END = 'REFIT-JUNCTION-PURE-END';
  const a = build.indexOf(BEGIN), b = build.indexOf(END);
  A.ok(a > 0 && b > a, 'build.js keeps its pure block');
  const block = build.slice(build.indexOf('*/', a) + 2, build.lastIndexOf('/*', b));   // (the slice refit-junction-cards.test.js takes)
  const pure = new Function(block + '\nreturn { sampleResultView };')();
  const nameOf = x => ({ r: 'Researcher', w: 'Writer' })[x] || x;
  const st = pure.sampleResultView({ ok: false, stopped: true, error: 'stopped — you stopped this job before it reached the OUTBOX', runs: [{ agentId: 'r', reason: 'stopped', usd: 0.001 }], replies: [], totalUsd: 0.001, delivered: null }, 502, nameOf);
  A.ok(st.stopped === true && !st.ok && /stopped/.test(st.reason) && st.stages.join() === 'Researcher' && st.usd === 0.001, 'a stopped answer reads as STOPPED, with what ran and what it cost');
  const failed = pure.sampleResultView({ ok: false, error: 'sample job did not complete cleanly', runs: [], replies: [] }, 502, nameOf);
  A.ok(failed.stopped === false, 'a line that failed is never called stopped');
  const good = pure.sampleResultView({ ok: true, delivered: { runId: 'x' }, stopped: true, runs: [], replies: [] }, 200, nameOf);
  A.ok(good.ok && good.stopped === false, 'a job that delivered is delivered, whatever a late stop said');
}
const html = fnBody(build, '  function finSampleHTML(v) {');
A.ok(/if \(v\.stopped\) return '<div class="fl-result stopped"><div><span class="fl-result-k">STOPPED<\/span>/.test(html), 'the readout says STOPPED (not REFUSED), with RAN and COST');
A.ok(/replace\(\/\^stopped\\s\*\[—-\]\\s\*\/i, ''\)/.test(html), '…without saying "stopped" twice (the server\'s "stopped — " lead is the label\'s job)');
const stopHost = fnBody(build, '  function finStopSample() {');
A.ok(/fetch\(finApi\('\/api\/routing\/sample\/stop'\), \{ method: 'POST'/.test(stopHost) && /finSampleRes\.phase !== 'run'/.test(stopHost), 'the host stops only a job that is riding the line, through the sidecar route');
A.ok(/finSampleRes\.stopping = true;/.test(stopHost) && /undo\(/.test(stopHost), '…says STOPPING… until the POST settles, and takes that back if the stop was refused');
A.ok(/stopSample: \(\) => finStopSample\(\),/.test(build), 'the Workflow panel host offers stopSample');

/* ---------- 3. the panel: ■ STOP while the job rides ---------- */
const picker = fnBody(panel, '  function testPickerHTML(s) {');
A.ok(/mine && mine\.pending && mine\.phase === 'run' && H\.stopSample \? '<button type="button" class="bb sm" id="wf-real-stop"/.test(picker), 'RUN ONE REAL JOB shows ■ STOP only while the job rides the line (not while the line is still posting)');
A.ok(/mine\.stopping \? 'STOPPING…' : '■ STOP'/.test(picker), '…and STOPPING… until the server answers');
A.ok(/const realStop = \$\('#wf-real-stop'\); if \(realStop\) realStop\.onclick = \(\) => \{[\s\S]{0,120}H\.stopSample\(\)\.then\(/.test(panel), 'the button asks the host to stop the job');

/* ---------- 4. the crew row names a line test ---------- */
const isLine = new Function('return ' + (station.match(/const isLineTestStream = (s => [^;]+);/) || [])[1])();
A.ok(isLine('steptest-ab12') && isLine('sample-9f3c1d2e') && !isLine('ws_1234') && !isLine('') && !isLine(null), 'a line test is a steptest-… or sample-… stream, nothing else');
A.ok(/U\.bus\.on\('agent\.run\.start', p => \{ if \(p && p\.agentId\) \{ if \(p\.runId && isLineTestStream\(p\.streamId\)\) testRunIds\.set\(p\.runId, p\.agentId\);/.test(station)
  && /U\.bus\.on\('agent\.run\.end', p => \{ if \(p && p\.agentId\) \{ if \(p\.runId\) testRunIds\.delete\(p\.runId\);/.test(station), 'the crew listener keeps which live runs are line tests, from the run events');
A.ok(/else \{ runningAgents\.delete\(id\); runSeenAt\.delete\(id\); dropTestRuns\(id\); \}/.test(station) && /runningAgents\.delete\(id\); runSeenAt\.delete\(id\); dropTestRuns\(id\);   \/\/ self-heal/.test(station), '…and forgets them whenever the agent\'s run count is cleared (an end, or the world\'s self-heal)');
{
  // the real crewTick, as state-truth-overlap runs it: a line test reads LINE TEST with its tip; a mix or other work reads WORKING
  const ids = ['tester', 'worker', 'idle'];
  const rows = Object.fromEntries(ids.map(id => [id, { hidden: false, classList: { toggle() {} } }]));
  const tips = {};
  const labels = Object.fromEntries(ids.map(id => [id, { textContent: '', closest: () => rows[id], getAttribute: () => tips[id] || null, setAttribute: (k, v) => { tips[id] = v; }, removeAttribute: () => { delete tips[id]; } }]));
  const ctx = vm.createContext({
    present: ids.map(id => ({ id })), runningAgents: new Map(), runSeenAt: new Map(),
    activity: () => 'task', App: { currentAgent: () => ({ id: 'worker' }) },
    agentLive: id => id !== 'idle', crewQuery: '', lineTestOnly: id => id === 'tester',
    LINE_TEST_TIP: (station.match(/const LINE_TEST_TIP = ('[^\n]+');/) || [])[1] ? eval((station.match(/const LINE_TEST_TIP = ('[^\n]+');/) || [])[1]) : '',
    $: sel => sel.startsWith('#cs-') ? labels[sel.slice(4)] : null
  });
  vm.runInContext(A.fnBody(station, 'function crewTick()') + '\ncrewTick();', ctx);
  A.eq([labels.tester.textContent, labels.worker.textContent, labels.idle.textContent], ['ON A WORKFLOW', 'WORKING', 'IDLE'], 'a workflow job or a line test reads ON A WORKFLOW; other work WORKING; no run IDLE');
  A.ok(/WORK › AUTOMATE › WORKFLOWS/.test(tips.tester || '') && /TEST view/.test(tips.tester || '') && /STOP/.test(tips.tester || '') && !tips.worker,
    'the ON A WORKFLOW row says where it shows (the WORKFLOWS window, or a step test in the TEST view) and how it stops; the others carry no such tip');
}
{
  // lineTestOnly: only when EVERY live run of the agent is a line test
  const src = (station.match(/function lineTestOnly\(id\) \{[\s\S]*?\n  \}/) || [])[0];
  A.ok(!!src, 'lineTestOnly exists');
  const ctx = vm.createContext({ testRunIds: new Map([['r1', 'a'], ['r2', 'b']]), runningAgents: new Map([['a', 1], ['b', 2]]) });
  vm.runInContext(src, ctx);
  A.ok(vm.runInContext('lineTestOnly("a")', ctx) === true, 'an agent whose only live run is a line test reads LINE TEST');
  A.ok(vm.runInContext('lineTestOnly("b")', ctx) === false, 'an agent with a line test AND other live work reads WORKING');
  A.ok(vm.runInContext('lineTestOnly("c")', ctx) === false, 'an agent with no line test reads WORKING');
}

A.report('line-test-stop.test');
