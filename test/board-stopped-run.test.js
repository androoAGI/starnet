/* node test/board-stopped-run.test.js — TASK-BOARD TRUTH for a run the Commander STOPPED (sweep/sessions 2026-10-20).
   A task card whose run was stopped mid-stream (run record reason 'cancelled', its reply marked stopped) read
   "FINISHED — RESULT READY" and counted as "READY TO OPEN": the stop path recorded no outcome, and the board reads an
   unrecorded outcome as done. Drives the REAL Workstreams store and the REAL board chip functions from stationui.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ Date: { now: () => 5000 } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/workstreams.js'), 'utf8'), ctx);
const Workstreams = ctx.Workstreams;
let busy = new Set();
const ui = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
// review r8: the chip is the card's last run's OUTCOME (boardEnd, RunOutcome.ofWord) — the page loads runoutcome.js before stationui.js
const RunOutcome = require('../frontend/app/runoutcome.js');
const board = vm.createContext({ Channels: { isBusy: id => busy.has(id) }, RunOutcome });
const chipSrc = A.fnBody(ui, 'function stateChip(s)'), aggSrc = A.fnBody(ui, 'function activeAggregate(items)'), endSrc = A.fnBody(ui, 'function boardEnd(s)');
A.ok(chipSrc.length > 50 && chipSrc.length < 4000 && aggSrc.length > 50 && aggSrc.length < 4000 && endSrc.length > 50 && endSrc.length < 4000, 'the real board chip functions were found');
vm.runInContext(endSrc + '\n' + chipSrc + '\n' + aggSrc + '\nthis.stateChip = stateChip; this.activeAggregate = activeAggregate;', board);

Workstreams.init({ workstreams: [{ id: 'general', title: null }], activeId: 'general', generalId: 'general' });
const t = Workstreams.create('Halted task', { kind: 'task', activate: false });
Workstreams.appendRun(t.id, 'run-1', 5000);
A.eq(Workstreams.get(t.id).lane, 'active', 'a real run advanced the task card');
busy.add(t.id);
A.ok(/RUNNING/.test(board.stateChip(Workstreams.get(t.id))), 'a live run reads RUNNING');
busy.delete(t.id);

// the stop path settles the outcome as STOPPED: no verdict either way, the terminal reason recorded
A.ok(Workstreams.noteRunEnd(t.id, 'run-1', null, 'stopped'), 'the stopped outcome is recorded on the run that owns the card');
A.eq(Workstreams.get(t.id).lastRunOk, null, 'a stop is neither a success nor a failure');
const chip = board.stateChip(Workstreams.get(t.id));
A.ok(/STOPPED/.test(chip), 'a stopped run reads STOPPED on its card');
A.ok(!/FINISHED|RESULT READY|FAILED/.test(chip), 'a stopped run never claims FINISHED or FAILED');
const agg = board.activeAggregate([Workstreams.get(t.id)]);
A.ok(/1 STOPPED/.test(agg) && !/READY TO OPEN/.test(agg), 'the IN PROGRESS header counts it as stopped, not ready');

// the outcome survives a save round-trip (restart), and the next real run clears it
Workstreams.init(Workstreams.serialize());
A.ok(/STOPPED/.test(board.stateChip(Workstreams.get(t.id))), 'the STOPPED chip survives save hydration');
Workstreams.appendRun(t.id, 'run-2', 6000);
Workstreams.noteRunEnd(t.id, 'run-2', true);
A.ok(/FINISHED/.test(board.stateChip(Workstreams.get(t.id))), 'a later completed run reads FINISHED again');

// the producer: both of chat.js's stop paths settle the outcome through noteStopReason — run the REAL helper
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const stopAt = chat.indexOf('const stopped = interrupted.has(ws.id);');
const stopBranch = stopAt < 0 ? '' : chat.slice(stopAt, chat.indexOf('} else {', stopAt));
A.ok(stopBranch.length > 0 && stopBranch.length < 3000, 'the Stop branch of the run catch was found');
A.ok(/noteStopReason\(ws, stoppedByLine\(by\), thisRunId\)/.test(stopBranch), 'the deliberate-Stop branch hands its run id to noteStopReason');
// (review 8.1: the reason is the end's outcome-aware word — an end-only refusal 'refusal', never the failure's 'error')
A.ok(/noteStopReason\(ws, stopLine, thisRunId, endWord\)/.test(chat) && /const endWord = \(endReason === 'error' && chipOc === 'refused'\) \? 'refusal' : endReason;/.test(chat),
  'the in-band stop path hands its run id and its end\'s outcome-aware word to noteStopReason');
const helper = vm.createContext({ Workstreams, RunOutcome });
vm.runInContext(A.fnBody(chat, 'function noteStopReason(') + ';this.noteStopReason = noteStopReason;', helper);
const u = Workstreams.create('Stopped from COMMS', { kind: 'task', activate: false });
Workstreams.appendRun(u.id, 'run-u', 7000);
u.history.push({ role: 'assistant', content: 'tick0 tick1', stopped: true });
helper.noteStopReason(u, 'stopped by you', 'run-u');
A.ok(/STOPPED/.test(board.stateChip(Workstreams.get(u.id))) && u.history[u.history.length - 1].stopNote === 'stopped by you', 'a Commander Stop reads STOPPED and keeps its note');
const v = Workstreams.create('Budget stop', { kind: 'task', activate: false });
Workstreams.appendRun(v.id, 'run-v', 7000);
Workstreams.noteRunEnd(v.id, 'run-v', true);                // the in-band envelope settled "completed" first
helper.noteStopReason(v, 'budget reached', 'run-v', 'budget');
A.eq([Workstreams.get(v.id).lastRunOk, Workstreams.get(v.id).lastRunReason], [null, 'budget'], 'an in-band stop keeps its own reason');
// review r8: a spending limit is no STOP and no failure — its own chip (it read "■ STOPPED — REVIEW")
const capChip = board.stateChip(Workstreams.get(v.id));
A.ok(/SPEND CAP/.test(capChip) && !/FINISHED|STOPPED|FAILED/.test(capChip), 'a budget-stopped run is not FINISHED either, and no stop: ' + capChip);
// review 7.3 / r8: a run that ASKED a question is ▲ ASKED, never ■ STOPPED, and counted apart; a refusal is its own state, never a stop
const q = Workstreams.create('Asked', { kind: 'task', activate: false });
Workstreams.appendRun(q.id, 'run-q', 7000);
Workstreams.noteRunEnd(q.id, 'run-q', null, 'asked');
const askChip = board.stateChip(Workstreams.get(q.id)), askAgg = board.activeAggregate([Workstreams.get(q.id)]);
A.ok(/ASKED/.test(askChip) && !/STOPPED|FAILED|FINISHED/.test(askChip) && /1 ASKED YOU/.test(askAgg) && !/STOPPED/.test(askAgg), 'an asked run reads ASKED and is counted apart: ' + askChip + ' / ' + askAgg);
const rf = Workstreams.create('Refused', { kind: 'task', activate: false });
Workstreams.appendRun(rf.id, 'run-r', 7000);
helper.noteStopReason(rf, 'the model declined', 'run-r', 'refusal');
const refChip = board.stateChip(Workstreams.get(rf.id));
A.ok(/REFUSED/.test(refChip) && !/STOPPED|FINISHED/.test(refChip), 'a refusal reads REFUSED, never STOPPED: ' + refChip);
// a run whose outcome was never recorded claims no FINISHED it cannot prove
const lg = Workstreams.create('Legacy', { kind: 'task', activate: false });
Workstreams.appendRun(lg.id, 'run-l', 7000);
A.ok(!/FINISHED/.test(board.stateChip(Workstreams.get(lg.id))), 'a run with no recorded outcome never reads FINISHED');

A.report('board-stopped-run.test');
