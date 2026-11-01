'use strict';

const A = require('./_assert.js');
const { makeRunExecutionState, toolBytesCapFor } = require('../sidecar/run-execution-state.js');

const observed = [];
const state = makeRunExecutionState({
  initialTaint: 'scheduled input',
  artifacts: { observe: value => observed.push(value), list: () => observed.slice() }
});

A.eq(state.taintedBy(), 'scheduled input', 'initial taint is explicit');
A.eq(state.latchTaint('later source'), 'scheduled input', 'taint latches the first source');
A.ok(!state.repeated('same', 1), 'new calls are not repeat-blocked');
state.recordResult('same', { isError: true }, false);
A.ok(!state.repeated('same', 1), 'one failure is within a maxRepeat of one');
state.recordResult('same', { isError: true }, false);
A.ok(state.repeated('same', 1), 'the next identical failure is blocked');
state.recordResult('same', { ok: true }, false);
A.ok(!state.repeated('same', 1), 'success clears the failure streak');
A.eq(state.toolsOk(), 1, 'successful real tools count as completed work');
state.recordResult('brief', { ok: true }, true);
A.eq(state.toolsOk(), 1, 'internal bookkeeping does not count as completed work');

let bounded = state.boundToolResult({ content: '1234' }, 6);
A.eq(bounded.content, '1234', 'output within the budget is unchanged');
bounded = state.boundToolResult({ content: '5678' }, 6);
A.ok(bounded.content.startsWith('56\n…[truncated'), 'crossing the budget truncates at the remaining payload bytes');
A.ok(state.toolBytes() > 6, 'the accounting includes the visible truncation marker');
bounded = state.boundToolResult({ content: 'later' }, 6);
A.ok(bounded.content.startsWith('[tool output omitted'), 'later output is replaced after exhaustion');
state.resetToolBytes();
A.eq(state.toolBytes(), 0, 'compaction can reset the output budget');

const receiptState = makeRunExecutionState();
receiptState.boundToolResult({ content: 'a'.repeat(90), summary: 'read 90 chars' }, 100);
const lateCommand = { content: 'test details\nPASS\n[exit 0]', summary: 'exit 0 (42ms)', parkedPath: '.output/shell.exec-run-0.txt', outputChars: 26, outputBytes: 26 };
A.ok(receiptState.willBoundToolResult(lateCommand, 100), 'a later result predicts the run-wide clip before its bytes are lost');
const receipt = receiptState.boundToolResult(lateCommand, 100);
A.ok(receipt.outputBounded, 'a clipped result is explicitly marked at the host boundary');
A.ok(/exit 0 \(42ms\)/.test(receipt.content), 'the clipped result retains the authoritative tool summary');
A.ok(/full 26-character \/ 26-byte UTF-8 output was saved/.test(receipt.content), 'the receipt reports exact pre-clamp character and byte sizes');
A.ok(/\.output\/shell\.exec-run-0\.txt/.test(receipt.content), 'the receipt points at the durable full output');
const afterReceipt = receiptState.boundToolResult({ content: 'more details', summary: 'verify passed', parkedPath: '.output/verify-run-1.txt', outputChars: 12 }, 100);
A.ok(/verify passed/.test(afterReceipt.content), 'even an exhausted run returns evidence instead of a generic suppression message');
A.ok(/verify-run-1\.txt/.test(afterReceipt.content), 'an exhausted run keeps the recovery path actionable');

// ---- the floor an exhausted budget still delivers: a receipt must never replace a result smaller than itself ----
{
  const CAP = 520000;
  const floorState = makeRunExecutionState();
  floorState.boundToolResult({ content: 'x'.repeat(CAP) }, CAP);
  A.eq(floorState.toolBytes(), CAP, 'the budget is spent');
  const tiny = { content: 'TINY_FACT\n', summary: '14 B read' };
  A.eq(floorState.willBoundToolResult(tiny, CAP), false, 'a tiny result is not predicted as clipped, so the host does not park it');
  A.eq(floorState.boundToolResult(tiny, CAP), tiny, 'a tiny result on a spent budget arrives untouched');
  const atFloor = { content: 'f'.repeat(2000), summary: 'ok' };
  A.eq(floorState.boundToolResult(atFloor, CAP).content, atFloor.content, 'exactly 2,000 characters still arrives whole');
  const overFloor = { content: 'H'.repeat(2000) + 'T'.repeat(5000), summary: 'read', parkedPath: '.output/o.txt', outputChars: 7000, outputBytes: 7000 };
  A.ok(floorState.willBoundToolResult(overFloor, CAP), 'one character over the floor is clipped');
  const clipped = floorState.boundToolResult(overFloor, CAP);
  A.ok(clipped.outputBounded && clipped.content.startsWith('H'.repeat(2000)) && !clipped.content.includes('TT'), 'a clipped result keeps exactly its head');
  A.ok(/Only the first 2000 characters are shown/.test(clipped.content) && /\.output\/o\.txt/.test(clipped.content), 'and says so, and names the saved file');
  // four floors a turn: 2,000 went to atFloor and 2,000 to the clipped head above, so 4,000 are left
  const mid = { content: 'm'.repeat(2000), summary: 'ok', parkedPath: '.output/m.txt' };
  A.eq(floorState.boundToolResult(mid, CAP).content, mid.content, 'the third floor of the turn arrives');
  A.eq(floorState.boundToolResult(mid, CAP).content, mid.content, 'the fourth does too');
  A.ok(floorState.willBoundToolResult(mid, CAP), 'the fifth is predicted as clipped, so the host parks it');
  const fifth = floorState.boundToolResult(mid, CAP);
  A.ok(fifth.outputBounded && fifth.content.startsWith('[Tool result receipt') && !fifth.content.includes('mmm'), 'and arrives as a receipt alone: one turn cannot flood a prompt the fold cannot shrink');
  A.eq(floorState.boundToolResult(tiny, CAP), tiny, 'a result no bigger than a receipt is still delivered, since it costs less than the receipt');
  floorState.startToolTurn();
  A.eq(floorState.boundToolResult(mid, CAP).content, mid.content, 'the next turn gets its floors back');
  const growth = floorState.toolBytes();
  floorState.boundToolResult(tiny, CAP);
  A.eq(floorState.toolBytes(), growth + tiny.content.length, 'a delivered floor result is still charged, so the accounting stays honest');
  const smallCap = makeRunExecutionState();
  smallCap.boundToolResult({ content: 'x'.repeat(6000) }, 6000);
  A.eq(smallCap.boundToolResult(tiny, 6000).content.startsWith('TINY_FACT'), true, 'the floor scales with the cap (100 characters at a 6,000 cap)');
  A.eq(smallCap.willBoundToolResult({ content: 'x'.repeat(101) }, 6000), true, 'and binds just above it');
  const tinyCap = makeRunExecutionState();
  tinyCap.boundToolResult({ content: 'x'.repeat(5000) }, 5000);
  A.ok(tinyCap.willBoundToolResult(tiny, 5000), 'a cap too small to spare a floor has none');
  const nearly = makeRunExecutionState();
  nearly.boundToolResult({ content: 'x'.repeat(519900) }, 520000);
  const nearlyOut = nearly.boundToolResult({ content: 'N'.repeat(5000), summary: 'read', parkedPath: '.output/n.txt' }, 520000);
  A.ok(nearlyOut.content.startsWith('N'.repeat(2000)) && /\.output\/n\.txt/.test(nearlyOut.content), 'a nearly spent budget keeps the same head, not a bare receipt');
  const reread = makeRunExecutionState();
  reread.boundToolResult({ content: 'x'.repeat(520000) }, 520000);
  const rereadOut = reread.boundToolResult({ content: 'R'.repeat(5000), summary: 'read' }, 520000, { rereadOf: '.output/a.txt' });
  A.ok(/saved file \.output\/a\.txt/.test(rereadOut.content) && /narrower range/.test(rereadOut.content) && !/could not fit or be preserved/.test(rereadOut.content), 'a re-read of a saved file says the file is safe, not that output was lost');
}

const { isParkedOutputPath } = require('../sidecar/output-artifacts.js');
A.ok(isParkedOutputPath('.output/shell.exec-run-3.txt'), 'a relative parked path is recognized');
A.ok(isParkedOutputPath('C:\\Users\\a\\workspaces\\rs\\.output\\fs.read-1.txt'), 'so is the absolute one project sessions are handed');
A.ok(!isParkedOutputPath('notes/output/a.txt') && !isParkedOutputPath('.output/sub/a.txt') && !isParkedOutputPath('a.output/b.txt') && !isParkedOutputPath(''), 'other paths are not');

A.eq(state.checkpointTurn(), 0, 'checkpoint sequence starts at zero');
A.eq(state.advanceCheckpoint(), 1, 'checkpoint sequence advances explicitly');
A.ok(!state.journalStarted(), 'journal starts false');
state.startJournal();
A.ok(state.journalStarted(), 'journal start latches true');
const journalStop = state.failJournal(new Error('disk full after tool execution'));
A.ok(state.journalFailed(), 'a journal boundary failure latches for the rest of the run');
A.ok(journalStop.isError && journalStop.control && journalStop.control.final && journalStop.control.reason === 'error',
  'journal failure returns a host-terminal error result instead of allowing a done synthesis');
A.ok(/requires review/i.test(journalStop.content), 'the model-visible result names the uncertain outcome');
state.markToolPrepared({ callId: 'mutation-1', name: 'fs.write', mutating: true });
A.eq(state.uncertainMutations(), [], 'prepared mutation is not yet uncertain');
state.markToolDispatched('mutation-1');
A.eq(state.uncertainMutations().map(x => x.callId), ['mutation-1'], 'dispatched unsettled mutation is exposed for durable telemetry');
state.markToolSettled('mutation-1');
A.eq(state.uncertainMutations(), [], 'durable result settlement clears mutation uncertainty');
A.eq(state.failureStage(), 'tool_result_persist', 'journal failure records its exact lifecycle stage');
A.eq(state.failureCode(), 'recovery-journal-failed', 'journal failure records a stable machine code');
const preDispatchState = makeRunExecutionState();
const preDispatchStop = preDispatchState.failJournal(new Error('disk full'), { beforeDispatch: true });
A.ok(/not started/i.test(preDispatchStop.content), 'pre-dispatch journal failure never implies the tool returned');
A.eq(preDispatchState.failureStage(), 'tool_dispatch_persist', 'pre-dispatch persistence has its own failure stage');
state.observeArtifact({ toolName: 'fs.write' });
A.eq(state.artifactList(), [{ toolName: 'fs.write' }], 'artifact collector is owned by the run state');

A.ok(state.consumeToolCall(2), 'first task-bounded tool call is admitted');
A.ok(state.consumeToolCall(2), 'second task-bounded tool call is admitted');
A.ok(!state.consumeToolCall(2), 'task-bounded tool calls stop at the exact cap');
A.eq(state.toolCallsStarted(), 2, 'tool-call budget counter is owned by the run state');
state.observeToolEvent('agent.tool_call', { callId: 'call-1', name: 'web_fetch' }, 100);
state.observeToolEvent('agent.tool_result', { callId: 'call-1', ok: false, isError: true, ms: 25, summary: 'x'.repeat(300) }, 125);
const trace = state.toolTraceList();
A.eq(trace[0].name, 'web_fetch', 'tool timing records the actual tool name');
A.eq(trace[0].ms, 25, 'tool timing records measured milliseconds');
A.eq(trace[0].endedAt, 125, 'tool timing derives a stable end time from the measured duration');
A.ok(trace[0].summary.length <= 240, 'tool timing summaries are bounded');
trace[0].name = 'mutated';
A.eq(state.toolTraceList()[0].name, 'web_fetch', 'tool timing snapshots cannot mutate run state');
const clocked = makeRunExecutionState({ now: () => 777 });
clocked.observeToolEvent('agent.tool_call', { callId: 'clocked', name: 'verify.run' });
A.eq(clocked.toolTraceList()[0].startedAt, 777, 'tool timing uses the injected run clock');

const clean = makeRunExecutionState();
A.eq(clean.latchTaint('browser.read'), 'browser.read', 'first runtime taint is retained');
A.eq(clean.artifactList(), [], 'missing artifact collector safely produces an empty list');
A.eq(clean.completionEvidence().completionVerdict, 'not_assessed', 'missing completion collector never fabricates a completion verdict');

const completionEvents = [];
const completionState = makeRunExecutionState({ completion: {
  observe: event => completionEvents.push(event),
  snapshot: () => ({ schemaVersion: 'starnet.completion-evidence.v1', completionVerdict: 'not_assessed', effectVerdict: 'unverified_effects', effects: [], evidence: [] })
} });
completionState.observeCompletion({ callId: 'c', name: 'fs.write' });
A.eq(completionEvents.map(x => x.callId), ['c'], 'run state owns completion evidence observation lifecycle');
A.eq(completionState.completionEvidence().effectVerdict, 'unverified_effects', 'run state exposes the collector snapshot');
completionState.recordRecoveryAttempt({ sequence: 1, stage: 'provider_stream', action: 'retry', reason: 'timeout', attempt: 1, model: 'm', delayMs: 400 });
A.eq(completionState.recoveryAttempts(), [{ sequence: 1, stage: 'provider_stream', action: 'retry', reason: 'timeout', attempt: 1, model: 'm', delayMs: 400 }], 'recovery attempts are bounded run-owned telemetry');

// ---- toolBytesCapFor: the window-scaled per-run cap must sit ABOVE the compaction threshold in bytes, so the
// fold (the one event that resets the budget via agent.compact) always fires before the cap blinds the run. The
// flat 120KB cap deadlocked on big-context models: budget exhausted at ~30k tokens while compaction waited for
// ~130k that could never arrive.
for (const window of [32000, 131072, 200000, 1000000]) {
  const cap = toolBytesCapFor(window, 120000);
  const thresholdBytes = Math.ceil(0.65 * window) * 4;   // compactAt tokens ≈ bytes/4
  A.ok(cap >= thresholdBytes, 'cap covers the 0.65 compaction threshold for a ' + window + '-token window (' + cap + ' >= ' + thresholdBytes + ')');
}
A.eq(toolBytesCapFor(0, 120000), 120000, 'unknown window -> the legacy 120KB floor binds');
A.eq(toolBytesCapFor(10000, 120000), 120000, 'a tiny window keeps the floor — the cap never shrinks below legacy');
A.eq(toolBytesCapFor(200000, 120000), 520000, 'a 200k window scales the budget to 520KB (2.6 bytes per context token)');
A.eq(toolBytesCapFor(-5, -5), 0, 'garbage inputs clamp to zero instead of NaN');

A.report('run-execution-state.test');
