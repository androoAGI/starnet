/* node test/line-jobs.held-visible.test.js — A JOB WAITING FOR A PERSON IS NEVER CUT FROM A LIST (line-hold lane; invariant held-job-stays-reachable).

   A held job is kept until somebody decides it (retain never trims it), but the only way a person finds it is the job list the WORKFLOWS
   window reads: GET /api/line-jobs?limit=100 is the newest 100 rows by start time, so a hold used to fall out of the page after 100 later
   jobs on any line, and out of a line-scoped read the same way. Nothing else names it (no event, no NEEDS-YOU row), and an undecided hold
   counts toward MAX_HELD, so a busy station stranded its own reviews and then stopped holding anything.

   The family, on the station's own store (a real hold from the real walk, then a busy station of ordinary jobs after it): for every count
   of later jobs the held job is on the first page the window loads, on its line's page, and on a page of one row; it stays newest-first; a
   page of ordinary jobs is still bounded by its limit (the hold rides beside them, never in place of one); and an exact identity read (a
   stream, a run) is never widened by a hold that is not that identity. */
'use strict';
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');
const { makeRig } = require('./helpers/line-hold-rig.js');

const later = (st, line, n, from) => {
  for (let i = 0; i < n; i++) {
    const id = 'job-' + String(100000000 + from + i), at = 5000 + from + i;
    st = J.start(st, { id, line, text: 'job ' + (from + i), streamId: 's' + (from + i), at, entry: 'channel' }).state;
    st = J.finish(st, id, { status: 'delivered', outcome: 'delivered', at: at + 1, usd: 0.01, output: 'ok', runs: [], stop: null, error: '' }).state;
  }
  return st;
};

(async () => {
  const rig = makeRig({});
  const ran = await rig.run({ replies: ['not safe\nVERDICT: blocked'] });
  rig.settle(ran.job, ran.line);
  const base = rig.state(), held = J.get(base, ran.job.id);
  A.ok(held && held.status === 'held' && held.continuation.phase === 'held', 'a real hold from the real walk: the job is held');
  const other = rig.lineId + '-elsewhere';

  for (const n of [0, 1, 7, 8, 9, 99, 100, 101, 250]) {
    const st = later(base, held.line, n, 0), tag = n + ' later jobs: ';
    const ids = rows => rows.map(r => r.id);
    const page = J.list(st, { limit: 100 }), mine = J.list(st, { line: held.line, limit: 100 }), one = J.list(st, { limit: 1 });
    A.eq(ids(page).filter(id => id === held.id).length, 1, tag + 'the held job is on the first page the window loads, once');
    A.eq(ids(mine).filter(id => id === held.id).length, 1, tag + 'and on its own line\'s page');
    A.ok(ids(one).includes(held.id), tag + 'and a page of one row carries it beside the newest job');
    const row = page.find(r => r.id === held.id);
    A.ok(row && row.status === 'held' && row.hold && row.hold.reason === 'blocked' && row.hold.allowed.includes('stop') && row.endedAt === null, tag + 'as a held row, with why it waits and what may be decided');
    A.ok(page.every((r, i) => i === 0 || page[i - 1].startedAt >= r.startedAt), tag + 'the page is still newest first');
    A.eq(page.filter(r => r.status !== 'held').length, Math.min(100, n), tag + 'ordinary rows are still bounded by the limit: the hold rides beside them, never in place of one');
    A.eq(one.filter(r => r.status !== 'held').length, Math.min(1, n), tag + 'the newest ordinary job is still the one a page of one row names');
    A.eq(ids(J.list(st, { line: other, limit: 100 })), [], tag + 'a line it is not on never lists it');
    A.eq(ids(J.list(st, { stream: 's-not-its-stream', limit: 2 })), [], tag + 'an exact stream read is never widened by a hold on another stream');
    A.eq(ids(J.list(st, { stream: held.streamId, limit: 2 })), [held.id], tag + 'while its own stream finds it');
    A.eq(ids(J.list(st, { stream: held.streamId, runId: 'not-a-member', limit: 1 })), [], tag + 'and an exact run read that is not one of its runs finds nothing');
  }

  // two undecided holds on one line, a busy station after both: each is on the global page and on the line's page
  {
    const rig2 = makeRig({ idBase: 700, clockBase: 90000 });
    const ran2 = await rig2.run({ replies: ['no\nVERDICT: blocked'] });
    rig2.settle(ran2.job, ran2.line);
    const mate = J.get(rig2.state(), ran2.job.id);
    let st = J.normalizeAll(JSON.parse(JSON.stringify({ jobs: later(base, held.line, 3, 0).jobs.concat([mate]) })));
    st = later(st, held.line, 120, 400);
    A.eq(J.list(st, { limit: 100 }).filter(r => r.status === 'held').map(r => r.id).sort(), [held.id, mate.id].sort(), 'two undecided holds, 120 jobs after both: both are on the page');
    A.ok(J.list(st, { line: held.line, limit: 100 }).filter(r => r.status === 'held').length === 2, 'and both on the line\'s page');
    rig2.dispose();
  }

  // the control: a hold that was decided (finished) is an ordinary job again and ages out of a page like one
  {
    const st = later(base, held.line, 130, 0), j = JSON.parse(JSON.stringify(J.get(st, held.id)));
    j.status = 'stopped'; j.outcome = 'stopped'; j.endedAt = 6000; delete j.continuation; delete j.stop;
    const decided = J.normalizeAll(JSON.parse(JSON.stringify({ jobs: st.jobs.map(x => x.id === held.id ? j : x) })));
    A.ok(!J.list(decided, { limit: 100 }).some(r => r.id === held.id), 'control: once decided it is bounded by the limit like any other job');
  }

  rig.dispose();
  A.report('line-jobs.held-visible');
})().catch(e => { console.error(e && e.stack || e); A.ok(false, 'threw: ' + (e && e.message)); A.report('line-jobs.held-visible'); });
