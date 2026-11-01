/* node test/hudmode.test.js
   Locks HUD MODE (frontend/app/hudmode.js + src-tauri/src/hud_mode.rs):
     · the deck's feed model states only what the harness proved — the /api/state/snapshot is the
       authority on what is running, events only enrich it, and nothing is claimed before the first
       snapshot lands;
     · the page wiring (button, stylesheet, script) and the station windows staying reachable;
     · the desktop wiring: module, managed state, commands, the tray's HUD Mode / Open StarNet paths,
       and the HUD's restore floor mirroring the main window's builder. */
'use strict';
const { readSidecarSource, sidecarFunctionSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const H = require('../frontend/app/hudmode.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const names = { agent: { name: 'NOVA', color: '#4af' }, researcher: { name: 'ORION', color: '#4c8' } };
const who = id => names[id] || null;
const T0 = 1_800_000_000_000;

// ---- HUD QA 2026-09-30: controls only where they work, truthful endings ----
{
  const f = H.createFeed();
  H.applySnapshot(f, { runs: [
    { runId: 'r-com', agentId: 'agent', startedAt: T0 - 5000, stoppable: true },
    { runId: 'r-line', agentId: 'researcher', startedAt: T0 - 9000, source: 'host', stoppable: false },
    { runId: 'r-old', agentId: 'agent', startedAt: T0 - 1000 }
  ], prompts: [], queues: [] }, T0);
  const by = id => H.workItems({ feed: f, now: T0 }).find(x => x.runId === id);
  const st = [{ id: 's1', runIds: ['r9'], history: [{ role: 'user', content: 'Go' }, { role: 'assistant', sourceRunId: 'r9', content: 'Part one.\n[steering] Also list the biggest files\nPart two.' }] }];
  A.eq(H.replyOfRun('r9', 's1', st), 'Part one.\n\nPart two.', 'a direction echoed into the reply is never shown as the agent\'s result');
  A.eq(H.replyOfRun('r9', 's1', [{ id: 's1', history: [{ role: 'assistant', sourceRunId: 'r9', content: '\n[steering] 1 steering note arrived as this run was ending and was NOT applied\n' }] }]), '', 'a reply that is only steering echoes is no reply');
  A.ok(by('r-com').canStop && by('r-com').canSteer, 'a run the station can stop offers STOP and a direction');
  A.ok(!by('r-line').canStop && !by('r-line').canSteer, 'a work-line step /api/cancel cannot reach offers neither (no "Stop requested." for a stop that never happens)');
  A.ok(by('r-old').canStop, 'an older station that does not say keeps the controls');
  // quick win 12: the card reads /api/cancel's own answer — a stop that found no live run never reads "Stop requested."
  A.eq(H.commandReceipt('stop', 'run', { ok: true, stopped: false }), 'Nothing to stop: this run had already ended.', 'a cancel that stopped nothing says so');
  A.eq(H.commandReceipt('stop', 'run', { ok: true, stopped: true }), 'Stop requested.', 'a cancel that reached a live run is a stop request');
  A.eq(H.commandReceipt('stop', 'run', null), 'Stop requested.', 'an older station that does not say keeps the old line');
  A.eq(H.commandReceipt('stop', 'worker', { ok: true, stopped: false }), 'Stop requested.', 'a worker interrupt is answered by its own route, unchanged');
  A.eq(H.commandReceipt('steer', 'run', { ok: true }), 'Direction sent. The agent takes it before its next step.', 'a direction keeps its receipt');
  const workers = [
    { id: 'w1', agentId: 'researcher', status: 'stale', prompt: 'Dig up the docs', completedAt: T0 - 1000 },
    { id: 'w2', agentId: 'researcher', status: 'refused', prompt: 'Do the thing', completedAt: T0 - 2000 },
    { id: 'w3', agentId: 'researcher', status: 'weird', prompt: 'Other', completedAt: T0 - 3000 },
    { id: 'w4', agentId: 'researcher', status: 'stale', reason: 'stalled: no progress for 450s — the liveness check stopped this worker (threshold 420s)', prompt: 'Hung on a tool', completedAt: T0 - 500 }
  ];
  const items = H.workItems({ feed: H.createFeed(), workers, now: T0 });
  const w = id => items.find(x => x.workerId === id);
  A.eq([w('w1').state, w('w1').status], ['fault', 'Lost when the station restarted'], 'a worker lost to a restart is a fault, not "done"');
  A.eq([w('w2').state, w('w2').status], ['fault', 'Refused'], 'a refused worker is a fault');
  A.eq([w('w3').state, w('w3').status], ['stopped', 'Ended (weird)'], 'an ending the HUD does not know is never painted done');
  A.eq([w('w4').state, w('w4').status], ['fault', 'Stopped: made no progress'], 'a worker the liveness check stopped is never blamed on a restart that did not happen');
  const js = fs.readFileSync(path.join(ROOT, 'frontend/app/hudmode.js'), 'utf8');
  A.ok(!js.includes('No result was recorded') && js.includes("'Its reply isn’t shown here.'") && js.includes("'Its reply is in the conversation.'"),
    'a finished card with no reply on this page says where the reply is, never that there was none');
  A.ok(js.includes("setText(v.clock, down ? 'NO LINK'") && js.includes("v.node.dataset.state = down ? 'fault' : tile.state;"), 'the widget stops its clocks and says NO LINK when the station stops answering');
  A.ok(js.includes('if (S.followId === id && S.followKey === key && cameraOn(id)) return;'), 'a follow the world could not take (or dropped) is retried, never marked done');
  A.ok(js.includes("if (S.busy) { S.exitAfter = true;") && js.includes("invoke('starnet_hud_status').then(v => (v && v.active ? invoke('starnet_hud_set', { active: false }) : null))") && js.includes('else exit(); };'),
    'leaving is never dropped: during entry it runs right after, and a page that lost the HUD still hands the window back');
  A.ok(js.includes('holdToMove(open); holdToMove(rows);') && js.includes('cur.startDragging()') && js.includes("invoke('plugin:window|start_dragging', { label: 'main' })") && js.includes('if (!justMoved()) setView(\'activity\');'),
    'the agent cam moves: hold the picture or a row and drag the window; a press that does not move stays a click');
  A.ok(fs.readFileSync(path.join(ROOT, 'src-tauri/capabilities/default.json'), 'utf8').includes('core:window:allow-start-dragging'), 'the window may start an OS drag');
  {
    // the header drags from ANY part of the title, the session name included (org P26 put it in a child span). Tauri 2's
    // drag.js isDragRegion rule, verbatim in shape: a bare attribute drags only when the press lands ON that element,
    // 'deep' drags from its whole subtree, a clickable with no attribute blocks.
    const isDragRegion = (composedPath) => {
      for (const n of composedPath) {
        const attr = n.attrs['data-tauri-drag-region'];
        if (n.clickable && attr === undefined) return false;
        if (attr === undefined) continue;
        if (attr === 'false') return false;
        if (attr === 'deep') return true;
        if (attr === '' || attr === 'true') return n === composedPath[0];
      }
      return false;
    };
    const titleAttr = (/S\.els\.title\.setAttribute\('data-tauri-drag-region', '([^']*)'\)/.exec(js) || [])[1];
    const h3Attr = (/S\.els\.h3\.setAttribute\('data-tauri-drag-region', '([^']*)'\)/.exec(js) || [])[1];
    const h3 = { attrs: { 'data-tauri-drag-region': h3Attr } }, title = { attrs: { 'data-tauri-drag-region': titleAttr } };
    const name = { attrs: {} }, key = { attrs: {}, clickable: true };
    A.ok(isDragRegion([name, title, h3]), 'a press on the session name in the HUD header moves the window');
    A.ok(isDragRegion([title, h3]) && isDragRegion([h3]), '…as does the word COMMS and the empty header');
    A.ok(!isDragRegion([key, h3]), 'a header key stays a click (the h3 is not deep)');
    A.eq(h3Attr, '', 'the h3 keeps the bare (self-only) attribute');
  }
  // quick win 12: /api/cancel also reaches a run holding a runOnce stop handle (a routine hop, a line step, a hub run), so
  // the snapshot offers STOP on exactly the runs it can stop — no more, no fewer
  const snap = sidecarFunctionSource('handleStateSnapshot');
  A.ok(snap.length > 500 && snap.length < 20000, 'one bounded handleStateSnapshot');
  A.ok(snap.includes('row.stoppable = runs.has(runId) || runStopHandles.has(runId);') && snap.includes("source: 'host', stoppable: runs.has(runId) || runStopHandles.has(runId) }"),
    'the snapshot says which runs /api/cancel can reach, a stop-handle run included (additive)');
  const cancel = sidecarFunctionSource('handleCancel');
  A.ok(cancel.includes('runStopHandles.get(String(runId))') && cancel.includes('stopped: !!(ac || kc)'), 'the same two maps /api/cancel stops through, and it says whether it stopped one');
  const world = fs.readFileSync(path.join(ROOT, 'frontend/app/world.js'), 'utf8');
  A.ok(world.includes('function cameraState()') && world.includes('function restoreCamera(st)') && world.includes('cameraState, restoreCamera,'), 'the world hands a borrowed camera back exactly');
  const rs = fs.readFileSync(path.join(ROOT, 'src-tauri/src/hud_mode.rs'), 'utf8');
  A.ok(rs.includes('rect = Some(unfolded_rect(r, g.unfolded_w, h));') && rs.includes('let back = station_rect_back('), 'the HUD never walks off-screen on exit, and the station never comes back on a monitor that is gone');
}

// ---- nothing asserted before the first snapshot ----
{
  const f = H.createFeed();
  const v = H.view(f, who, T0);
  A.eq(v.summary.text, '…', 'no snapshot yet and nothing seen: the deck claims neither IDLE nor WORKING');
  A.eq(v.live.length, 0, 'no rows invented');
}

// ---- a run the page watched: start → tool → tool result → tokens → end ----
{
  const f = H.createFeed();
  H.onRunStart(f, { agentId: 'agent', runId: 'r1', trigger: 'directive', model: 'm' }, T0);
  let v = H.view(f, who, T0 + 1000);
  A.eq(v.summary, { text: '1 WORKING', tone: 'live' }, 'a watched run.start counts as working');
  A.eq([v.live[0].name, v.live[0].step, v.live[0].elapsed], ['NOVA', 'RUNNING', '1s'], 'row names the agent, the honest step, the clock');
  H.onToolCall(f, { agentId: 'agent', runId: 'r1', callId: 'c1', name: 'mcp__github__create_issue' }, T0 + 2000);
  A.eq(H.view(f, who, T0 + 2000).live[0].step, 'GITHUB::CREATE.ISSUE', 'tool in flight is named (CAM-HUD spelling)');
  A.eq(H.onToolResult(f, { agentId: 'agent', runId: 'r1', callId: 'other' }, T0 + 2100), false, 'another call\'s result does not clear this tool');
  A.eq(H.onToolResult(f, { agentId: 'agent', runId: 'r1', callId: 'c1' }, T0 + 2200), true, 'its own result clears it');
  A.eq(H.view(f, who, T0 + 2200).live[0].step, 'RUNNING', 'back with the model: the row stops naming a finished tool');
  A.eq(H.onToken(f, { agentId: 'agent', runId: 'r1', delta: 'Hel' }, T0 + 2300), true, 'first token flips the row');
  A.eq(H.onToken(f, { agentId: 'agent', runId: 'r1', delta: 'lo' }, T0 + 2400), false, 'later tokens change nothing (no re-render per delta)');
  A.eq(H.view(f, who, T0 + 2400).live[0].step, 'WRITING REPLY', 'streaming text is a provable step');
  H.onRunEnd(f, { agentId: 'agent', runId: 'r1', reason: 'done', turns: 2, usd: 0 }, T0 + 3000);
  v = H.view(f, who, T0 + 4000);
  A.eq(v.live.length, 0, 'run.end removes the live row');
  A.eq([v.recent[0].name, v.recent[0].text, v.recent[0].ago], ['NOVA', 'DONE', 'just now'], 'the finish is shown as recent');
  A.eq(H.view(f, who, T0 + 16 * 60 * 1000).recent.length, 0, 'a finish older than the recent window leaves');
}

// ---- the snapshot is the authority ----
{
  const f = H.createFeed();
  // a run the page never saw start (a routine, a channel message, a run from before the HUD opened)
  A.ok(H.applySnapshot(f, { ts: T0, runs: [{ runId: 'cron1', agentId: 'researcher', startedAt: T0 - 65_000, source: 'cron' }], prompts: [], queues: [{ agentId: 'researcher', depth: 2 }] }, T0), 'snapshot applies');
  let v = H.view(f, who, T0);
  A.eq([v.live[0].name, v.live[0].elapsed, v.live[0].queued], ['ORION', '1m 05s', 2], 'unseen server run appears with the server\'s start clock and queue depth');
  // a permission prompt pending on it
  H.applySnapshot(f, { runs: [{ runId: 'cron1', agentId: 'researcher', startedAt: T0 - 65_000 }], prompts: [{ runId: 'cron1', agentId: 'researcher', promptId: 'p' }], queues: [] }, T0 + 4000);
  v = H.view(f, who, T0 + 4000);
  A.eq([v.summary.text, v.live[0].step, v.live[0].waiting], ['1 NEEDS YOU', 'NEEDS YOUR OK', true], 'a pending prompt is the headline');
  // a lost run.end: the snapshot stops listing the run → it is gone
  H.applySnapshot(f, { runs: [], prompts: [], queues: [] }, T0 + 8000);
  v = H.view(f, who, T0 + 8000);
  A.eq([v.live.length, v.summary.text], [0, 'STATION IDLE'], 'a confirmed run the snapshot drops is not kept alive by a stale event');
  // an event-only run survives a short grace (snapshot older than its run.start), then must be confirmed
  H.onRunStart(f, { agentId: 'agent', runId: 'fresh', trigger: 'directive', model: 'm' }, T0 + 9000);
  H.applySnapshot(f, { runs: [], prompts: [], queues: [] }, T0 + 10_000);
  A.eq(H.view(f, who, T0 + 10_000).live.length, 1, 'a just-started run is not dropped by a snapshot that predates it');
  H.applySnapshot(f, { runs: [], prompts: [], queues: [] }, T0 + 20_000);
  A.eq(H.view(f, who, T0 + 20_000).live.length, 0, 'an event-only run the snapshot never confirms expires');
  // failures are shown as what they are
  A.eq(H.applySnapshot(f, null, T0), false, 'a non-snapshot is refused');
  H.snapshotFailed(f);
  A.eq(H.view(f, who, T0 + 21_000).summary, { text: 'NO LINK', tone: 'bad' }, 'a failing snapshot poll reads NO LINK, never IDLE');
}

// ---- recent rows: one per run, the asks stand out, unknown agents degrade honestly ----
{
  const f = H.createFeed();
  H.onRunStart(f, { agentId: 'agent', runId: 'e1', trigger: 'schedule', model: 'm' }, T0);
  A.eq(H.view(f, who, T0).live[0].trigger, 'ROUTINE', 'a scheduled run is labelled a routine');
  H.onRunError(f, { agentId: 'agent', runId: 'e1', message: 'boom', transient: false }, T0 + 10);
  H.onRunEnd(f, { agentId: 'agent', runId: 'e1', reason: 'error', turns: 1, usd: 0 }, T0 + 20);
  let v = H.view(f, who, T0 + 30);
  A.eq(v.recent.length, 1, 'run.error then run.end{error} for one run is ONE recent row');
  A.eq([v.recent[0].text, v.recent[0].tone], ['FAULT', 'bad'], 'a fault reads as one');
  H.onRunEnd(f, { agentId: 'researcher', runId: 'q1', reason: 'clarifying', turns: 1, usd: 0 }, T0 + 40);
  v = H.view(f, who, T0 + 50);
  A.eq([v.recent[0].name, v.recent[0].text, v.recent[0].tone], ['ORION', 'ASKED YOU', 'ask'], 'an agent that ended by asking a question is flagged for the Commander');
  H.onRunStart(f, { agentId: 'ghost-agent-9', runId: 'g1', trigger: 'directive', model: 'm' }, T0);
  A.eq(H.view(f, who, T0).live[0].name, 'GHOST-AGEN', 'an agent missing from the roster shows its id, not a made-up name');
  for (let i = 0; i < 9; i++) H.onRunStart(f, { agentId: 'agent', runId: 'm' + i, trigger: 'directive', model: 'm' }, T0 + i);
  v = H.view(f, who, T0 + 100);
  A.eq([v.live.length, v.more], [5, 5], 'live rows cap at five and fold the rest into +N MORE');
  A.ok(f.recent.length <= 12, 'recent list is bounded');
}

// ---- ACTIVITY: every piece of work on the station, each once, in the order a glance needs ----
{
  const agents = [{ id: 'agent', name: 'Nova', color: '#4af' }, { id: 'researcher', name: 'Orion' }, { id: 'coder', name: 'Vex' }];
  const streams = [
    { id: 'ws1', agentId: 'agent', title: 'General', runIds: ['live1'], history: [{ role: 'user', content: 'Summarise   today\'s   inbox' }] },
    { id: 'ws2', agentId: 'researcher', title: 'ORION', runIds: ['old1'], history: [
      { role: 'user', content: 'Find three papers' },
      { role: 'assistant', content: 'Found them.', sourceRunId: 'old1' },
      { role: 'assistant', content: 'Links below.', sourceRunId: 'old1' },
      { role: 'assistant', content: 'boom', sourceRunId: 'old1', error: true }
    ] }
  ];
  const f = H.createFeed();
  H.applySnapshot(f, { runs: [
    { runId: 'live1', agentId: 'agent', startedAt: T0 - 30_000, source: 'interactive', streamId: 'ws1' },
    { runId: 'cron1', agentId: 'researcher', startedAt: T0 - 90_000, source: 'cron' },
    { runId: 'self1', agentId: 'agent', startedAt: T0 - 1000, source: 'interactive', internal: true },
    { runId: 'wrun1', agentId: 'coder', startedAt: T0 - 5000, source: 'subagent' }
  ], prompts: [{ runId: 'cron1', agentId: 'researcher', promptId: 'p1' }], queues: [] }, T0);
  H.onToolCall(f, { agentId: 'agent', runId: 'live1', callId: 'c1', name: 'web_search' }, T0);
  const workers = [
    { id: 'w1', runId: 'wrun1', agentId: 'coder', status: 'running', working: true, canInterrupt: true, generation: 2, prompt: 'Fix the flaky test', startedAt: T0 - 5000, steerHistory: [{ status: 'applied', text: 'use the fixture' }] },
    { id: 'w0', runId: 'wrun0', agentId: 'coder', status: 'interrupted', prompt: 'Old job', completedAt: T0 - 60_000, artifacts: [{ path: 'C:/x/notes.md' }] },
    { id: 'wOld', runId: 'wrunOld', agentId: 'coder', status: 'done', prompt: 'Ancient', completedAt: T0 - 13 * 3_600_000 }
  ];
  const finished = [
    { runId: 'old1', agentId: 'researcher', reason: 'done', title: 'Find three papers', streamId: 'ws2', endedAt: T0 - 120_000, toolTrace: [{ callId: 'a', name: 'web_search' }, { callId: 'b', name: 'web_search' }, { callId: 'c', name: 'mcp__github__get_issue' }] },
    { runId: 'self0', agentId: 'agent', reason: 'done', title: 'Assistant reply (context only)', internal: true, endedAt: T0 - 10_000 },
    { runId: 'wrun0', agentId: 'coder', reason: 'cancelled', title: 'dup of the worker', endedAt: T0 - 60_000 },
    { runId: 'live1', agentId: 'agent', reason: 'done', title: 'stale row of a live run', endedAt: T0 - 1 },
    { runId: 'ask1', agentId: 'agent', reason: 'done', clarifying: true, deliveryText: 'Which account?', title: 'Pay the bill', endedAt: T0 - 30_000 },
    { runId: 'test1', agentId: 'agent', reason: 'done', stepTest: true, endedAt: T0 - 5 }
  ];
  const items = H.workItems({ feed: f, workers, finished, agents, streams, now: T0 });
  A.eq(items.map(x => x.key), ['run:cron1', 'done:ask1', 'run:live1', 'worker:w1', 'worker:w0', 'done:old1'],
    'needs-you first (a prompt, a question left for you), then working oldest-first, then finished newest-first; self-talk, step tests, stale and old work left out; every run once');
  const [cron, ask, live, worker, stopped, old] = items;
  A.eq([cron.state, cron.status, cron.task, cron.name, cron.time], ['ask', 'Needs your OK', 'Scheduled routine', 'ORION', '1m 30s'], 'a routine waiting on a permission prompt');
  A.eq([live.state, live.status, live.task, live.streamId, live.canSteer, live.canStop], ['live', 'Using WEB.SEARCH', 'Summarise today\'s inbox', 'ws1', true, true],
    'a live run names its tool and the Commander\'s own words from the conversation that owns it; it can be steered and stopped');
  A.eq([worker.kind, worker.status, worker.task, worker.canSteer, worker.generation, worker.directions], ['worker', 'Working', 'Fix the flaky test', true, 2, ['Direction applied: use the fixture']],
    'a delegated worker is its ledger record, with its steer history');
  A.eq([old.state, old.status, old.time, old.result, old.tools], ['done', 'Completed', '2m ago', 'Found them.\n\nLinks below.', ['WEB.SEARCH', 'GITHUB::GET.ISSUE']],
    'a finished run shows what it said (its own transcript rows, error markers left out) and each tool once');
  A.eq([ask.state, ask.status, ask.result], ['ask', 'Asked you a question', 'Which account?'], 'a run that ended on a question reads as one');
  A.eq([stopped.state, stopped.status, stopped.outputs, stopped.canStop], ['stopped', 'Stopped', ['notes.md'], false], 'a stopped worker keeps its outputs and loses its hands');
  A.eq(H.workItems({ feed: H.createFeed(), now: T0 }), [], 'nothing on the station: no cards');
  const lone = H.createFeed();
  H.applySnapshot(lone, { runs: [{ runId: 'tg', agentId: 'ghost', startedAt: T0, source: 'telegram' }], prompts: [], queues: [] }, T0);
  A.eq(H.workItems({ feed: lone, now: T0 }).map(x => [x.name, x.task]), [['GHOST', 'Message from Telegram']], 'no conversation on this page: the run says where it came from, under the agent\'s id');
  // the summary line
  A.eq(H.feedSummary(items, f, true), { text: '2 NEED YOU · 2 WORKING', tone: 'ask' }, 'summary counts what needs you and what is working');
  A.eq(H.feedSummary([], H.createFeed(), null), { text: '…', tone: 'dim' }, 'before the first answer: nothing claimed');
  A.eq(H.feedSummary([], f, false), { text: 'NO LINK', tone: 'bad' }, 'a failing history poll is said');
  const quiet = H.createFeed(); H.applySnapshot(quiet, { runs: [], prompts: [], queues: [] }, T0);
  A.eq(H.feedSummary([old], quiet, true), { text: 'ALL QUIET', tone: 'dim' }, 'finished work only: all quiet');
  A.eq(H.oneLine('a  b\n c', 40), 'a b c', 'one line');
}

// ---- WIDGET: one tile per agent at work, the clock ----
{
  const it = (agentId, state, sortAt, status) => ({ agentId, name: agentId.toUpperCase(), color: '', state, sortAt, status });
  const agents = [{ id: 'agent', name: 'Nova', color: '#4af' }, { id: 'researcher', name: 'Orion' }];
  let p = H.widgetTiles([it('agent', 'live', T0 - 5000, 'Working'), it('agent', 'live', T0 - 9000, 'Using WEB.SEARCH'), it('researcher', 'ask', T0 - 1000, 'Needs your OK'), it('coder', 'done', T0, 'Completed')], 'agent', agents);
  A.eq(p.tiles.map(x => [x.agentId, x.state, x.startedAt, x.step, x.working]), [['researcher', 'ask', T0 - 1000, 'Needs your OK', true], ['agent', 'live', T0 - 9000, 'Using WEB.SEARCH', true]],
    'one tile per agent with work under way: needs-you first, each agent\'s longest-running work, finished work never a tile');
  p = H.widgetTiles(['a', 'b', 'c', 'd', 'e'].map((a, i) => it(a, 'live', T0 - i * 1000, 'Working')), 'a', agents);
  A.eq([p.tiles.length, p.more], [3, 2], 'at most three tiles, the rest counted');
  p = H.widgetTiles([it('agent', 'done', T0 - 60_000, 'Completed')].map(x => Object.assign(x, { time: '1m ago' })), 'agent', agents);
  A.eq(p.tiles.map(x => [x.name, x.working, x.state, x.step]), [['NOVA', false, 'idle', 'Completed · 1m ago']], 'nothing under way: the agent on the line, idle, with its last finish');
  A.eq(H.widgetTiles([], 'nobody', []).tiles, [], 'no roster, no tile');
  A.eq([H.fmtClock(42_000), H.fmtClock(725_000), H.fmtClock(3_723_000), H.fmtClock(-1)], ['0:42', '12:05', '1:02:03', ''], 'run clock');
}

// ---- small formatters + prefs ----
A.eq(H.toolLabel('web_search'), 'WEB.SEARCH', 'tool label');
A.eq(H.toolLabel(''), '', 'no tool, no label');
A.eq([H.fmtElapsed(59_000), H.fmtElapsed(61_000), H.fmtElapsed(3_723_000)], ['59s', '1m 01s', '1h 02m'], 'elapsed clock');
A.eq([H.fmtAgo(10_000), H.fmtAgo(5 * 60_000), H.fmtAgo(2 * 3_600_000)], ['just now', '5m ago', '2h ago'], 'ago words');
{
  const mem = new Map();
  const store = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  A.eq(H.readPrefs(store), { pinned: true, rect: null, widget: null }, 'defaults: pinned, no remembered rect or widget size');
  H.writePrefs(store, { pinned: false, rect: { x: 10, y: 20, w: 400, h: 640 }, widget: { w: 520, h: 410 } });
  A.eq(H.readPrefs(store), { pinned: false, rect: { x: 10, y: 20, w: 400, h: 640 }, widget: { w: 520, h: 410 } }, 'prefs round-trip, the widget size the Commander chose included');
  mem.set('starnet.hud', '{not json');
  A.eq(H.readPrefs(store), { pinned: true, rect: null, widget: null }, 'corrupt prefs read as defaults');
  A.eq(H.readPrefs({ getItem() { throw new Error('blocked'); } }), { pinned: true, rect: null, widget: null }, 'blocked storage reads as defaults');
}

// ---- page wiring ----
{
  const html = read('frontend/index.html');
  A.ok(/<button id="comms-hud" type="button" hidden[^>]*>HUD<\/button><\/span><\/h3>/.test(html), 'COMMS header carries the HUD button (hidden until hudmode.js wires it)');
  A.ok(/btn\.hidden = !tauriCore\(root\);/.test(read('frontend/app/hudmode.js')), 'the header button is offered only where a window can stay on top (the desktop shell)');
  A.ok(html.indexOf('<link rel="stylesheet" href="css/hudmode.css">') > html.indexOf('css/comms-layout.css'), 'hudmode.css loads after comms-layout.css');
  A.ok(html.indexOf('<script src="app/hudmode.js"></script>') > html.indexOf('<script src="app/chatresize.js"></script>'), 'hudmode.js loads after chatresize.js');
  const css = read('frontend/css/hudmode.css');
  const hide = /html body\.hud-mode #screen-game\.active > :is\(([^)]*)\) \{ display: none !important; \}/.exec(css);
  A.ok(!!hide, 'HUD hides an explicit list of station regions');
  const hidden = hide ? hide[1].split(',').map(s => s.trim()) : [];
  for (const id of ['#topbar', '#left', '#stage-wrap', '#bottombar']) A.ok(hidden.includes(id), 'HUD hides ' + id);
  A.ok(!hidden.includes('#terms') && !hidden.includes('#chat-panel'), 'station windows (#terms) and COMMS stay reachable in the HUD');
  A.ok(/html body\.hud-mode\.sn-chrome #sn-titlebar \{ display: none !important; \}/.test(css), 'the MAXIMIZE titlebar is not offered on a corner panel');
  const glass = read('frontend/app/glass-demo.js');
  A.ok(/const shown = r => \(r && r\.width > 0 && r\.height > 0 \? r : null\);/.test(glass) && /shown\(rect\(document\.querySelector\('#bottombar'\)\)\)/.test(glass),
    'docked sheets ignore a hidden bar instead of seating at a negative top');
  const js = read('frontend/app/hudmode.js');
  A.ok(/World\.stop\(\)/.test(js) && /World\.start\(\)/.test(js), 'the world renderer stops in the HUD and resumes on exit');
  const has = (src, ...parts) => parts.every(p => src.includes(p));
  A.ok(has(js, "fetch('/api/state/snapshot'"), 'live work is the authoritative run snapshot');
  A.ok(has(js, "get('/api/subagents')", "get('/api/runs?agent=*&limit=40')"), 'delegated and finished work are the worker ledger and the run history');
  A.ok(has(js, "'/api/subagents/steer'", "'/api/subagents/interrupt'", "'/api/run/steer'", "'/api/cancel'"),
    'every card can be steered and stopped through the routes the station already has');
  A.ok(has(js, 'App.openWorkstream(mine[0].id)', 'Workstreams.get(sid)'), 'OPEN CONVERSATION goes to the conversation that owns the work, else the agent\'s own (never rebinds the blank thread on screen)');
  A.ok(has(js, "S.view = 'widget';", "classList.toggle('hud-view-widget', small)", "setView('activity')"), 'the HUD opens SMALL on the widget, and a click opens ACTIVITY');
  A.ok(has(js, 'World.lockBody(id, fr.zoom, { seatAt: fr.seatAt })', 'if (small) worldStart(true); else { worldStop();', 'World.setFrameCap(capped ? WIDGET_FRAME_MS : 0)') && !js.includes('SPRITES.drawBody'),
    'the widget is the REAL station (the world renderer, its camera following the agent), never a staged scene; the world runs only while the widget shows it');
  A.ok(css.includes('#screen-game.active > #stage-wrap {') && css.includes('#stage-wrap .cam-hud { display: none !important; }'), 'the widget shows the world alone: no camera frame, no station controls');
  A.ok(css.includes('body:not(.hud-mode) #chat-panel .hud-ctl { display: none !important; }'), 'back in the full station the COMMS header shows none of the HUD controls');
  A.ok(css.includes('grid-template-rows: minmax(120px, 1fr) auto;') && !/#stage-wrap \{[^}]*width: 300px/.test(css), 'the widget picture fills its window (no fixed 300x190 box)');
  A.ok(js.includes("root.addEventListener('resize', onWindowResize);") && js.includes('S.widgetUser = { w, h }') && js.includes('S.widgetUser = prefs.widget || null;') && js.includes('|| S.widgetUser) return;'),
    'a size the Commander drags the widget to is kept (no auto-fit fights it) and remembered');
  A.ok(js.includes('if (e && e.isTrusted === false) return;'), 'the HUD\'s own synthetic resize (after a view change) is never mistaken for the Commander sizing the widget');
  A.ok(js.includes('World.setOverlays(!capped)'), 'the widget turns the in-world readouts off, and the station gets them back');
  A.ok(js.includes('World.lockBody(id, fr.zoom, { seatAt: fr.seatAt })') && js.includes('function widgetFraming()') && js.includes('World.restoreCamera(S.stationCam)') && js.includes('keepStationCamera();'), 'the widget frames its agent closer (a seated one with its desk in view) and gives the station its zoom back');
  A.ok(js.includes('return { zoom: WIDGET_ZOOM, seatAt:') && !js.includes('Math.min(1.33'), 'a bigger agent cam shows more station, never a bigger agent (Andrew: "WAY TOO BIG")');
  const w2 = read('frontend/app/world.js');
  A.ok(w2.includes('const fy = (camLock.seatAt && (lb.seated || lb.sitting)) ? camLock.seatAt : 0.56;') && w2.includes('function lockBody(id, zoom, opts)'), 'World.lockBody takes an optional seated framing (omitted = 0.56 for every body)');
  A.ok(read('frontend/app/world.js').includes('sc: clampz(zoom > 0 ? zoom : Math.max(scale, 3), MINZ, MAXZ)'), 'World.lockBody takes an optional zoom (omitted = the station rule)');
  const world = read('frontend/app/world.js');
  A.ok(world.includes('function setOverlays(on) { overlaysOn = on !== false; }') && world.includes('    if (overlaysOn) {\n    drawRunClocks(now);') && world.includes('setOverlays, setCinecamIdle'),
    'World.setOverlays gates the in-world readout block (default on: the station frame is unchanged)');
  A.ok(has(read('src-tauri/src/hud_mode.rs'), 'width: Option<f64>', 'fn folded_width', 'keep_right'), 'the desktop window hugs the widget in width too, keeping its corner');
  A.ok(has(js, "el('section', 'project-home hud-activity')", "el('details', 'ph-card')"), 'ACTIVITY is the project activity feed markup (so it wears the project feed\'s glass)');
  A.ok(!css.includes('#chat-panel > h3 { display: none') && !css.includes('#chat-input {'), 'COMMS keeps its designed header and composer inside the HUD');
  A.ok(!/background: var\(--ph\)\s*;/.test(css) && !css.includes('0 0 0 2px var(--ph-dim)'), 'no retired CRT chrome: no solid phosphor bar, no phosphor ring');
  {
    // Andrew 09-30: the HUD wears the NEWEST glass — the Workflow panel / Build Library sheet, keys and cards
    const glass = css.slice(css.indexOf('THE NEW GLASS'));
    A.ok(glass.length > 1000 && has(glass,
      'html body.hud-mode #chat-panel {\n  border: 1px solid var(--hud-edge); border-radius: 12px;',
      'backdrop-filter: blur(18px)',
      "html body.hud-mode #chat-panel::before, html body.hud-mode #chat-panel::after { display: none; }",
      'background: none; border: 0; border-bottom: 1px solid var(--hud-edge)'),
      'the HUD is one 12px frosted sheet with a plain header over a hairline — no striped strip, no CRT corner brackets');
    A.ok(/\.hud-ctl \.btn \{[^}]*min-height: 34px;[^}]*border-radius: 8px;/.test(glass) && /\.ph-controls \.btn \{[^}]*min-height: 36px;[^}]*border-radius: 8px;/.test(glass),
      'the HUD keys are the Build Library glass key (8px, 34-36px tall), not the old 3px chip');
    A.ok(/#hud-activity \.ph-card \{[^}]*border-radius: 10px;/.test(glass) && glass.includes('.ph-agent::before') && glass.includes('var(--hud-lamp)'),
      'each piece of work is a 10px glass card with a housed status lamp');
    A.ok(!/font(-size)?: 1[0-3]px/.test(glass), 'nothing in the new glass reads under 14px');
    A.ok(glass.includes(':is(#chat-status, #chat-elapsed) { display: none !important; }'), 'the HUD header never squeezes its keys out of the window');
    A.ok(js.includes("el('button', 'btn', 'AGENT CAM')") && !js.includes("'btn', 'SMALL')"), 'the key that shrinks the HUD says where it goes: AGENT CAM (Andrew 09-30: not SMALL)');
  }
  const side = readSidecarSource();
  A.ok(has(side, "source: 'interactive', streamId: streamId || '', internal: internal }", 'if (meta && meta.internal) row.internal = true;') && has(js, 'r.internal || workerRuns.has'),
    'live self-talk is marked by the sidecar and never shown as the Commander\'s work');
}

// ---- desktop wiring ----
{
  const main = read('src-tauri/src/main.rs');
  const hud = read('src-tauri/src/hud_mode.rs');
  A.ok(/\nmod hud_mode;\n/.test(main), 'hud_mode module is declared');
  A.ok(/app\.manage\(hud_mode::HudState::default\(\)\);/.test(main), 'HUD state is managed');
  A.ok(/starnet_set_close_to_tray,\s*hud_mode::starnet_hud_status,\s*hud_mode::starnet_hud_set,\s*hud_mode::starnet_hud_pin,\s*hud_mode::starnet_hud_fold\s*\]\)/.test(main),
    'HUD commands are registered after the lifecycle commands');
  A.ok(/MenuItem::with_id\(app, "lifecycle_hud", "HUD Mode", true, None::<&str>\)\?;/.test(main), 'tray offers HUD Mode');
  A.ok(/Menu::with_items\(app, &\[&open_item, &hud_item, &status_item, &sep, &pause_item, &quit_item\]\)/.test(main), 'HUD Mode sits under Open StarNet');
  A.ok(/"lifecycle_open" => \{\s*hud_mode::request\(app, false\);\s*show_main_window\(app\);\s*\}/.test(main), 'Open StarNet hands a HUD back to the full station');
  A.ok(/"lifecycle_hud" => \{\s*show_main_window\(app\);\s*hud_mode::request\(app, true\);\s*\}/.test(main), 'HUD Mode reveals the window and asks the page to fold');
  A.eq((main.match(/WebviewWindowBuilder::new\(/g) || []).length, 1, 'still exactly one window builder: the HUD is the main window, not a second one');
  A.ok(/\.min_inner_size\(960\.0, 600\.0\)/.test(main) && /const MAIN_MIN_W: f64 = 960\.0;/.test(hud) && /const MAIN_MIN_H: f64 = 600\.0;/.test(hud),
    'leaving the HUD restores the main window\'s real minimum size');
  A.ok(/pub\(crate\) const HUD_EVENT: &str = "starnet-hud";/.test(hud) && /const TAURI_EVENT = 'starnet-hud';/.test(read('frontend/app/hudmode.js')),
    'tray event name matches on both sides');
  A.ok(/win\.set_always_on_top\(false\);\s*let _ = win\.set_min_size\(Some\(LogicalSize::new\(MAIN_MIN_W, MAIN_MIN_H\)\)\);/.test(hud), 'exit unpins before restoring the station floor');
  const fsCmd = main.slice(main.indexOf('fn starnet_toggle_fullscreen('), main.indexOf('fn starnet_toggle_fullscreen(') + 500);
  A.ok(/^fn starnet_toggle_fullscreen\(app: AppHandle\) -> Result<bool, String> \{[\s\S]*?if hud_mode::is_active\(&app\) \{\s*return Ok\(false\);\s*\}\s*let win = app/.test(fsCmd),
    'F11 cannot blow the pinned HUD up to fullscreen (checked before the window is touched)');
  const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
  A.ok(!caps.permissions.some(p => /always-on-top|set-size|set-position/.test(String(p))), 'the renderer gets no new raw window powers; the shell owns HUD geometry');
}

A.report();
