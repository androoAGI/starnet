'use strict';
const { readSidecarSource } = require('./helpers/source');
/* node test/overseer-batch.test.js — ONE REPORT PER HAND-OFF (2026-10-11, version B).
   GENUINE: sidecar/overseer.js freshReviews groups the workers one lead run sent out and reviews them together once
   they have all settled; a straggler past the ceiling gets the finished part reported and one follow-up of its own;
   a pre-batching '<runId>:review' row still covers its worker (an upgrade never re-reviews history); E-STOP covers an
   incomplete hand-off. SOURCE-LOCKED: the tick runs every member and the report prompt asks for one report. */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOverseer } = require('../sidecar/overseer.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-overseer-batch-'));
let clock = 1000;
const saved = { generalId: 'home', workstreams: [{ id: 'home', title: null, agentId: 'agent' }], deletedIds: [] };
const mk = (file, extra) => makeOverseer(Object.assign({ fs, path, file: path.join(root, file), now: () => clock,
  newId: (() => { let n = 0; return () => 'thread_' + (++n); })(), sessions: () => saved, hasAgent: id => ['agent', 'researcher', 'writer'].includes(id),
  reportCeilingMs: 5000 }, extra || {}));
const worker = (id, o) => Object.assign({ id, runId: id + '_run', leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', parentRunId: 'lead1',
  streamId: 'thread_' + id, status: 'running', completedAt: 0, generation: 1 }, o || {});

try {
  {
    const m = mk('a.json');
    const w1 = worker('w1', { status: 'done', completedAt: clock }), w2 = worker('w2', { agentId: 'writer' });
    m.collect([w1, w2]);
    A.eq(m.snapshot().reviews.length, 0, 'one worker of a hand-off finished: no report yet (its crewmate is still working)');
    w2.status = 'done'; w2.completedAt = ++clock;
    m.collect([w1, w2]); m.collect([w1, w2]);
    const rows = m.snapshot().reviews;
    A.eq(rows.length, 1, 'both finished: ONE report row for the hand-off, never one per worker (and replays do not duplicate it)');
    A.eq(rows[0].members.map(x => x.workerId).join(','), 'w1,w2', 'the row names every worker of the hand-off');
    A.eq(rows[0].workerRunIds.join(','), 'w1_run,w2_run', 'and covers each worker generation');
    A.eq(rows[0].workerId, 'w1', 'its single-worker fields name the first member (older readers keep working)');
    A.eq(m.membersOf(rows[0]).length, 2, 'membersOf reads a batch row');
    A.eq(m.membersOf({ workerId: 'x', workerRunId: 'x_run', childStreamId: 's' })[0].streamId, 's', 'and a pre-batching row as its one worker');
  }
  {
    const m = mk('b.json');
    const w1 = worker('w1', { status: 'done', completedAt: clock }), w2 = worker('w2');
    clock += 5001;
    m.collect([w1, w2]);
    let rows = m.snapshot().reviews;
    A.eq(rows.length, 1, 'a straggler past the ceiling never holds the report: the finished part is reported');
    A.eq(rows[0].workerRunIds.join(','), 'w1_run', 'only the finished worker is covered');
    A.eq(rows[0].waitingOn.map(x => x.workerId).join(','), 'w2', 'and the report knows who is still working');
    m.patchReview(rows[0].id, { status: 'reviewing', reviewRunId: 'partial-report' });
    w2.status = 'done'; w2.completedAt = ++clock;
    m.collect([w1, w2]);
    rows = m.snapshot().reviews;
    A.eq(rows.length, 2, 'the straggler gets ONE follow-up report when it settles');
    A.ok(rows[1].followUp === true && rows[1].workerRunIds.join(',') === 'w2_run', 'a follow-up, about the straggler only');
  }
  {
    let active = true;
    const m = mk('late-dispatch.json', { isRunActive: id => active && id === 'lead1' });
    const first = worker('first', { status: 'done', completedAt: clock });
    m.collect([first]);
    clock += 9000; m.collect([first]);
    A.eq(m.snapshot().reviews.length, 0, 'even a fast worker past the ceiling waits until its lead finishes assigning work');
    const second = worker('second', { status: 'done', completedAt: clock });
    active = false; m.collect([first, second]);
    A.eq(m.snapshot().reviews.length, 1, 'two dispatch calls in one lead turn produce one report');
    A.eq(m.snapshot().reviews[0].members.map(x => x.workerId).join(','), 'first,second', 'that report covers both calls');
  }
  {
    const m = mk('queued-report.json');
    const first = worker('first', { status: 'done', completedAt: clock }), second = worker('second');
    clock += 5001; m.collect([first, second]);
    const id = m.snapshot().reviews[0].id;
    second.status = 'done'; second.completedAt = ++clock;
    const current = m.refreshReview(id, [first, second]);
    A.eq(current.members.length, 2, 'acquiring the conversation lock refreshes the report with a straggler that finished while queued');
    A.eq(current.waitingOn.length, 0, 'the finished straggler is never described as still working');
    m.collect([first, second]);
    A.eq(m.snapshot().reviews.length, 1, 'refresh covers the absorbed result, so no redundant follow-up appears');
    const restored = mk('queued-report.json');
    A.eq(restored.snapshot().reviews[0].members.length, 2, 'the refreshed batch survives a coordinator restart');
    m.patchReview(id, { status: 'done' });
    A.eq(m.refreshReview(id, [first]).members.length, 2, 'a completed report cannot be rewritten by later registry changes');
  }
  {
    const m = mk('credential-wait.json');
    const first = worker('first', { status: 'done', completedAt: clock }), second = worker('second');
    clock += 5001; m.collect([first, second]);
    second.status = 'error'; second.completedAt = ++clock;
    m.collect([first, second]);
    A.eq(m.snapshot().reviews.length, 1, 'a report waiting for provider access absorbs newly settled workers');
    A.eq(m.snapshot().reviews[0].members.length, 2, 'credential recovery reports both outcomes together');
  }
  {
    // a station upgraded mid-flight: its old per-worker row covers that worker
    const old = worker('old', { status: 'done', completedAt: clock });
    fs.writeFileSync(path.join(root, 'd.json'), JSON.stringify({ version: 1, value: { threads: [], reviews: [{ id: 'old_run:review', parentStreamId: 'home', workerId: 'old', workerRunId: 'old_run', status: 'done', reviewRunId: 'r0', error: '' }] } }));
    // a 1 ms retention makes the old row past its keep window, so only its listed worker can keep it
    const m2 = mk('d.json', { reviewRetentionMs: 1 });
    clock += 10;
    m2.collect([old]);
    A.eq(m2.snapshot().reviews.length, 1, 'a pre-batching review row covers its worker: an upgrade never re-reviews history');
    A.eq((m2.snapshot().reviews[0] || {}).id, 'old_run:review', 'an expired old row is kept while its worker is listed (never dropped and re-reviewed)');
    m2.collect([]);
    A.eq(m2.snapshot().reviews.length, 0, 'once its worker has left the registry, the expired old row is dropped');
  }
  {
    const m = mk('e.json');
    const w1 = worker('w1', { status: 'done', completedAt: clock }), w2 = worker('w2'), gone = worker('w3', { status: 'interrupted', completedAt: clock, cancelledBy: 'parent' });
    m.stopReviews([w1, w2, gone]);
    const rows = m.snapshot().reviews;
    A.eq(rows.length, 1, 'E-STOP files the finished part of an incomplete hand-off (never a worker cancelled with its lead)');
    A.eq(rows[0].status, 'cancelled', 'and cancels it: the Commander stopped everything');
    A.eq(rows[0].members.map(x => x.workerId).join(','), 'w1', 'only the finished worker is filed; the worker cancelled with its lead is never folded in');
    A.eq(rows[0].waitingOn.map(x => x.workerId).join(','), 'w2', 'the still-running worker is named as waiting, and the parent-cancelled one is not');
  }
  {
    const m = mk('f.json');
    const solo = worker('s1', { parentRunId: '', status: 'error', completedAt: clock });
    m.collect([solo]);
    A.eq(m.snapshot().reviews.length, 1, 'a worker with no lead run is its own hand-off');
  }
  {
    const idx = readSidecarSource();
    const tick = idx.slice(idx.indexOf('async function tickOverseer'), idx.indexOf('const overseerTimer'));
    A.ok(/overseer\.membersOf\(r\)/.test(tick) && /const instruction = delegatedReportPrompt\(members, waiting, review\.followUp === true\)/.test(tick), 'the tick reviews every worker of the hand-off in one run');
    const prompt = idx.slice(idx.indexOf('function delegatedReportPrompt'), idx.indexOf('async function tickOverseer'));
    A.ok(/^function delegatedReportPrompt[\s\S]*'Review the background work you delegated for this conversation\. '/.test(prompt)
      && /ONE short report for the whole request, never one message per worker/.test(prompt)
      && /commanderDirections/.test(prompt) && /status: w\.status/.test(prompt), 'the report prompt asks NOVA for one report naming each worker (and keeps the fields the overseer providers key on)');
    const orch = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'orchestration.js'), 'utf8');
    A.ok(/parentStreamId: args\.background && deps\.coordinateResults === true/.test(orch), 'a FOREGROUND team.spawn clone is never reported a second time');
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
A.report('overseer-batch.test');
