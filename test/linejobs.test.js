/* test/linejobs.test.js — LINE JOBS (sidecar/routing/linejobs.js, 2026-09-30): every job sent down a work line is ONE record, from
   the moment it goes out. Pure state in, state out: a record takes only the route's own verdict, keeps what the Commander changed
   because of it, names the job it re-ran, is never left "running" across a restart, and the store stays bounded. */
'use strict';
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');

let s = { jobs: [] };
/* ---------- start → finish ---------- */
let r = J.start(s, { id: 'job-aaaaaaaaaaaa', line: 'p10', name: 'Research + write', text: 'three facts about the moon', streamId: 'sample-1a2b3c4d', at: 1000 });
A.ok(r.job && r.job.status === 'running' && r.job.startedAt === 1000 && r.job.endedAt === null, 'a job goes out as running');
s = r.state;
r = J.finish(s, 'job-aaaaaaaaaaaa', { status: 'delivered', at: 4000, usd: 0.0021, output: 'The moon…', runs: [{ runId: 'r2', agentId: 'nova', dockId: 'p12', reason: 'done', usd: 0.001 }, { runId: 'r1', agentId: 'nova', dockId: 'p11', reason: 'done', usd: 0.0011 }] });
A.ok(r.job.status === 'delivered' && r.job.endedAt === 4000 && r.job.output === 'The moon…' && r.job.runs.length === 2 && r.job.usd === 0.0021, 'it settles with the route\'s own verdict, runs, output and cost');
s = r.state;
A.ok(J.finish(s, 'job-zzzzzzzzzzzz', { status: 'delivered' }).job === null, 'an unknown job is not invented');
A.ok(J.finish(s, 'job-aaaaaaaaaaaa', { status: 'perfect' }).job.status === 'interrupted', 'a status the route never gives is not kept as said');

/* ---------- notes: what the Commander changed because of the job ---------- */
r = J.note(s, 'job-aaaaaaaaaaaa', { kind: 'fix', at: 5000, dockId: 'p12', role: 'WRITER', field: 'does', text: 'Two sentences.', was: 'Write it up.', why: 'shorter' });
A.ok(r.job && r.job.notes.length === 1 && r.job.notes[0].kind === 'fix' && r.job.notes[0].was === 'Write it up.', 'a fix used is kept with what it replaced');
s = r.state;
// a step goes by its NAME (up to the 48 characters setPropLabel keeps): the note keeps all of it, never a name cut mid-word
const longName = 'Senior fact checker for science journalism ok';
A.eq(longName.length, 45, '(fixture) a 45-character step name');
A.eq(J.note(s, 'job-aaaaaaaaaaaa', { kind: 'fix', at: 5001, dockId: 'p12', role: longName, field: 'does', text: 't' }).job.notes.slice(-1)[0].role, longName, 'a step NAME is kept whole in the job\'s note (wave-2 repair: it was cut to 40)');
A.eq(J.note(s, 'job-aaaaaaaaaaaa', { kind: 'fix', at: 5002, dockId: 'p12', role: 'x'.repeat(60), field: 'does', text: 't' }).job.notes.slice(-1)[0].role.length, 48, '…and bounded at the name limit');
A.ok(J.note(s, 'job-aaaaaaaaaaaa', { kind: 'wipe' }).job === null, 'a note kind the record does not keep is refused');
for (let i = 0; i < 20; i++) s = J.note(s, 'job-aaaaaaaaaaaa', { kind: 'putback', at: 6000 + i, dockId: 'p12', text: 'x' + i }).state;
A.ok(J.get(s, 'job-aaaaaaaaaaaa').notes.length === J.MAX_NOTES && J.get(s, 'job-aaaaaaaaaaaa').notes.slice(-1)[0].text === 'x19', 'notes are bounded, newest kept');

/* ---------- a re-run names the job it re-ran; the list is newest first, per line and per stream ---------- */
s = J.start(s, { id: 'job-bbbbbbbbbbbb', line: 'p10', text: 'three facts about the moon', streamId: 'sample-5e6f7a8b', at: 7000, retryOf: 'job-aaaaaaaaaaaa' }).state;
s = J.start(s, { id: 'job-cccccccccccc', line: 'p20', text: 'other line', streamId: 'sample-99999999', at: 8000, retryOf: 'not-an-id' }).state;
const l10 = J.list(s, { line: 'p10' });
A.ok(l10.map(j => j.id).join() === 'job-bbbbbbbbbbbb,job-aaaaaaaaaaaa' && l10[0].retryOf === 'job-aaaaaaaaaaaa', 'newest first, the re-run naming the job it re-ran');
A.ok(J.get(s, 'job-cccccccccccc').retryOf === null, 'a malformed re-run reference is dropped');
A.ok(J.list(s, { stream: 'sample-1a2b3c4d' }).map(j => j.id).join() === 'job-aaaaaaaaaaaa', 'a job is found by the stream its runs rode (the OUTBOX\'s way back)');
A.ok(J.list(s).length === 3 && J.list(s, { limit: 1 }).length === 1, 'every line, or a few');
const sum = J.list(s, { line: 'p10' })[1];
A.ok(sum.steps === 2 && sum.preview === 'The moon…' && sum.notes === J.MAX_NOTES && !('output' in sum) && !('runs' in sum), 'a list row is a summary: the whole record is one GET away');

/* ---------- a restart: nothing is riding a line any more ---------- */
const b = J.boot(s, 9000);
A.ok(b.changed && J.get(b.state, 'job-bbbbbbbbbbbb').status === 'interrupted' && J.get(b.state, 'job-cccccccccccc').status === 'interrupted', 'a job left running is said as interrupted at boot');
A.ok(J.get(b.state, 'job-aaaaaaaaaaaa').status === 'delivered' && /send it again/.test(J.get(b.state, 'job-bbbbbbbbbbbb').error), '…a settled one is untouched, and the interrupted one says what to do');
A.ok(!J.boot(b.state, 9500).changed, 'a second boot changes nothing');

/* ---------- normalizing what was read from disk ---------- */
const n = J.normalizeAll({ jobs: [{ id: 'job-dddddddddddd', line: 'p1', status: 'delivered', startedAt: 2, output: 'x'.repeat(J.MAX_OUTPUT + 50) }, { id: 'bad', line: 'p1' }, { id: 'job-eeeeeeeeeeee' }, { id: 'job-dddddddddddd', line: 'p1', startedAt: 3 }, null] });
A.ok(n.jobs.length === 1 && n.jobs[0].output.length === J.MAX_OUTPUT, 'malformed and duplicate records are dropped; the output is bounded');
let big = { jobs: [] };
for (let i = 0; i < J.MAX_JOBS + 15; i++) big = J.start(big, { id: 'job-' + String(i).padStart(12, '0'), line: 'p1', text: 't', at: i }).state;
A.eq(big.jobs.length, J.MAX_JOBS + 15, 'retention never evicts a job that is still running');
for (const j of big.jobs) big = J.finish(big, j.id, { status: 'delivered', at: 1000 }).state;
big = J.start(big, { id: 'job-other0000000', line: 'quiet-line', at: 2000 }).state;
A.eq(big.jobs.length, J.MAX_JOBS, 'finished records are bounded when the next job opens');
A.ok(big.jobs.some(j => j.line === 'quiet-line'), 'a busy line cannot evict the quiet line\'s live job');
let fair = { jobs: [] };
fair = J.start(fair, { id: 'job-quiet0000000', line: 'quiet-line', at: 1 }).state;
fair = J.finish(fair, 'job-quiet0000000', { status: 'delivered', at: 2 }).state;
for (let i = 0; i < J.MAX_JOBS + 10; i++) {
  const id = 'job-' + String(i).padStart(12, '0');
  fair = J.start(fair, { id, line: 'constructor', at: i + 3 }).state;
  fair = J.finish(fair, id, { status: 'delivered', at: i + 4 }).state;
}
A.ok(fair.jobs.length === J.MAX_JOBS && fair.jobs.some(j => j.line === 'quiet-line'), 'fair retention keeps a quiet line\'s older finished record, even beside an object-property line name');
const paused = J.mark(J.start(fair, { id: 'job-paused000000', line: 'quiet-line', entry: 'steptest', at: 4000 }).state, 'job-paused000000', 'paused');
A.eq(J.get(J.boot(paused.state, 5000).state, 'job-paused000000').status, 'paused', 'boot preserves a paused step-through job for its session to reclaim');
A.ok(J.isId('job-0123456789ab') && !J.isId('job-1') && !J.isId('../etc'), 'only a real job id is a job id');

A.report('linejobs.test');
