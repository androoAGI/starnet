/* node test/run-table.test.js — THE RUN TABLE, pure half (sidecar/run-table.js; run-table lane S1).

   The table is the one registry of every live run: index.js runOnce admits each run at its entry, ahead of the conversation
   queue, and releases it on every exit; GET /api/diagnostics checks it holds every run the older registries hold
   (test/run-registry-coverage.http.test.js drives that through the real sidecar). Here, without a host:
     1. admit/release is refcounted per runId: a second admit of a live run joins its entry, and the entry goes only with
        its last admission; a stray double release is noted and drops nothing;
     2. a run is 'queued' until it leaves its conversation queue (running());
     3. an id-less run gets an anonymous entry: counted by size() (the update drain's number), never listed, never found;
     4. live() membership, golden per surface, from the option bags each surface hands runOnce;
     5. missing() names exactly the ids the table does not hold;
     6. seeded random admit/release interleavings over shared ids always end with the table exactly matching a plain model. */
'use strict';
const A = require('./_assert.js');
const RunTable = require('../sidecar/run-table.js');

const clock = { t: 1000 };
const notes = [];
const fresh = () => RunTable.makeRunTable({ now: () => clock.t, note: (tag, e) => notes.push({ tag, message: e && e.message }) });

// ---- 1. refcounted admit/release ----
{
  const t = fresh();
  const a = t.admit(RunTable.metaOf({ runId: 'r1', agentId: 'forge', streamId: 's1', trigger: 'directive', surface: 'interactive' }));
  A.eq(t.size(), 1, 'one admitted run is one entry');
  A.ok(t.has('r1') && t.get('r1') === a.entry, 'found by its run id');
  const b = t.admit({ runId: 'r1', agentId: 'other', source: 'cron', lineId: 'L1', internal: true });
  A.ok(b.entry === a.entry, 'a second admit of a live run id joins its entry');
  A.eq(t.size(), 1, 'and adds no entry');
  A.eq([a.entry.refs, a.entry.agentId, a.entry.source, a.entry.lineId, a.entry.internal], [2, 'forge', 'interactive', 'L1', true],
    'the first admit\'s facts stand; the joiner fills only blanks, and a flag either admit knows is kept');
  a.release();
  A.ok(t.has('r1'), 'the entry stays while another admission holds it');
  A.eq(t.size(), 1, 'still counted');
  a.release();
  A.eq(notes.map(n => n.tag), ['runtable.release-twice'], 'a stray second release of one admission is noted');
  A.ok(t.has('r1') && a.entry.refs === 1, 'and drops nothing: the joiner still holds the entry');
  b.release();
  A.eq([t.has('r1'), t.get('r1'), t.size()], [false, null, 0], 'the last release removes the entry');
  const again = t.admit({ runId: 'r1' });
  A.ok(again.entry !== a.entry && again.entry.refs === 1, 'a later run reusing the id gets a fresh entry, never the released one');
  again.release();
  A.eq(t.size(), 0, 'empty again');
}

// ---- 2. queued -> running ----
{
  const t = fresh();
  const q = t.admit(RunTable.metaOf({ runId: 'q1', streamId: 'conv' }));
  A.eq(q.entry.state, 'queued', 'a run is queued until it leaves its conversation queue');
  q.running();
  A.eq(q.entry.state, 'running', 'running() marks it running');
  q.running();
  A.eq(q.entry.state, 'running', 'idempotently');
  const r = t.admit({ runId: 'r2', state: 'running' });
  A.eq(r.entry.state, 'running', 'an admit already past any queue (the overseer review) starts running');
  const late = t.admit({ runId: 'q1' });
  A.eq(late.entry.state, 'running', 'a joining admit never sends a running entry back to queued');
  q.release(); r.release(); late.release();
  q.running();
  A.eq(t.size(), 0, 'running() after release changes nothing');
}

// ---- 3. anonymous entries ----
{
  const t = fresh();
  const x = t.admit(RunTable.metaOf({ agentId: 'nightly' }));
  const y = t.admit(RunTable.metaOf({}));
  A.eq(t.size(), 2, 'two id-less runs are two live entries (the drain counts both)');
  A.ok(x.entry !== y.entry, 'never joined to each other');
  A.eq(t.live(), [], 'never listed');
  A.eq([t.has(''), t.get('')], [false, null], 'never found by an empty id');
  x.release();
  A.eq(t.size(), 1, 'released one by one');
  y.release();
  A.eq(t.size(), 0, 'and gone');
}

// ---- 4. live() membership, golden per surface ----
{
  clock.t = 5000;
  const t = fresh();
  const steer = () => [];
  // the option bags each surface hands runOnce (the fields metaOf reads), with the runsMeta row the shadow phase passes as `known`
  const surfaces = [
    ['comms', { runId: 'comms', agentId: 'agent', streamId: 'home', trigger: 'directive', surface: 'interactive' }, { source: 'interactive', startedAt: 4000 }],
    ['self-talk', { runId: 'self', agentId: 'agent', streamId: 'home', trigger: 'directive', surface: 'interactive', internal: true }, { source: 'interactive', startedAt: 4100 }],
    ['run-now', { runId: 'runnow', agentId: 'scout', trigger: 'manual', surface: 'autonomous' }, { source: 'cron', startedAt: 4200 }],
    ['scheduled', { runId: 'sched', agentId: 'scout', trigger: 'schedule', surface: 'autonomous' }, { source: 'cron' }],
    ['scheduled-unregistered', { runId: 'sched2', agentId: 'scout', trigger: 'schedule' }, null],
    ['nightshift', { runId: 'night', agentId: 'agent', trigger: 'nightshift', streamId: 'nightshift-x' }, null],
    ['loop', { runId: 'loop', agentId: 'agent', trigger: 'loop' }, { source: 'loop' }],
    ['group', { runId: 'group', agentId: 'qa', trigger: 'directive', surface: 'interactive', streamId: 'g1' }, { source: 'group' }],
    ['phone', { runId: 'phone', agentId: 'forge', trigger: 'event', streamId: 'p1' }, { source: 'remote' }],
    ['v1', { runId: 'chatcmpl-1', agentId: 'agent', trigger: 'event', surface: 'autonomous', streamId: 'v1s' }, null],
    ['v1-repair', { runId: 'chatcmpl-1-repair', agentId: 'agent', trigger: 'event', outputOnly: true }, null],
    ['hub', { runId: 'hub', agentId: 'agent', trigger: 'event', surface: 'autonomous', streamId: 'tg' }, null],
    ['hub-line', { runId: 'hubline', agentId: 'writer', trigger: 'event', lineId: 'line-1' }, null],
    ['bay', { runId: 'bay', agentId: 'writer', trigger: 'schedule', dockId: 'dock-1' }, null],
    ['fg-worker', { runId: 'fg', agentId: 'mira', parentRunId: 'comms', trigger: 'event' }, null],
    ['bg-worker', { runId: 'bg', agentId: 'sub-1', parentRunId: 'comms', steer: steer }, null],
    ['explicit', { runId: 'exp', agentId: 'agent', runSource: 'telegram', lineId: 'line-2' }, { source: 'cron' }],
    ['id-less', { agentId: 'agent', trigger: 'event' }, null]
  ];
  const handles = surfaces.map(([, o, known]) => t.admit(RunTable.metaOf(o, known)));
  t.admit({ runId: 'review', agentId: 'agent', source: 'overseer', streamId: 'home', state: 'running' });
  handles[0].running();   // the COMMS run has left its conversation queue; the rest are still waiting in theirs
  A.eq(t.size(), surfaces.length + 1, 'every admitted run is an entry, the id-less one included');
  A.eq(t.live(), [
    { runId: 'comms', agentId: 'agent', source: 'interactive', startedAt: 4000, state: 'running', streamId: 'home' },
    { runId: 'self', agentId: 'agent', source: 'interactive', startedAt: 4100, state: 'queued', streamId: 'home', internal: true },
    { runId: 'runnow', agentId: 'scout', source: 'cron', startedAt: 4200, state: 'queued' },
    { runId: 'sched', agentId: 'scout', source: 'cron', startedAt: 5000, state: 'queued' },
    { runId: 'sched2', agentId: 'scout', source: 'cron', startedAt: 5000, state: 'queued' },
    { runId: 'night', agentId: 'agent', source: 'nightshift', startedAt: 5000, state: 'queued', streamId: 'nightshift-x' },
    { runId: 'loop', agentId: 'agent', source: 'loop', startedAt: 5000, state: 'queued' },
    { runId: 'group', agentId: 'qa', source: 'group', startedAt: 5000, state: 'queued', streamId: 'g1' },
    { runId: 'phone', agentId: 'forge', source: 'remote', startedAt: 5000, state: 'queued', streamId: 'p1' },
    { runId: 'chatcmpl-1', agentId: 'agent', source: 'event', startedAt: 5000, state: 'queued', streamId: 'v1s' },
    { runId: 'hub', agentId: 'agent', source: 'event', startedAt: 5000, state: 'queued', streamId: 'tg' },
    { runId: 'hubline', agentId: 'writer', source: 'host', startedAt: 5000, state: 'queued' },
    { runId: 'bay', agentId: 'writer', source: 'host', startedAt: 5000, state: 'queued' },
    { runId: 'fg', agentId: 'mira', source: 'delegated', startedAt: 5000, state: 'queued', delegated: true },
    { runId: 'bg', agentId: 'sub-1', source: 'subagent', startedAt: 5000, state: 'queued', delegated: true },
    { runId: 'exp', agentId: 'agent', source: 'telegram', startedAt: 5000, state: 'queued' },
    { runId: 'review', agentId: 'agent', source: 'overseer', startedAt: 5000, state: 'running', streamId: 'home' }
  ], 'live(): every run with a caller id, labelled by its caller, its legacy row or its shape; never an output-only repair or an id-less run');
  A.ok(!t.live().some(r => r.runId === 'chatcmpl-1-repair') && t.has('chatcmpl-1-repair'), 'the /v1 output-only repair is held (the drain counts it) but never listed');
  A.eq(RunTable.metaOf(null), { runId: '', agentId: 'agent', source: 'event', startedAt: null, streamId: '', internal: false, outputOnly: false,
    surface: '', trigger: '', lineId: '', dockId: '', delegated: false }, 'metaOf tolerates a missing option bag');
}

// ---- 5. missing() ----
{
  const t = fresh();
  const held = ['a', 'b'].map(id => t.admit({ runId: id }));
  A.eq(t.missing(['a', 'x', '', null, 'b', 'x', 'y', undefined]), ['x', 'y'], 'missing() names the ids the table does not hold, once each, in order');
  A.eq(t.missing(new Set(['b', 'a'])), [], 'a superset leaves nothing missing (any iterable)');
  A.eq(t.missing(null), [], 'no ids, nothing missing');
  held.forEach(h => h.release());
  A.eq(t.missing(['a']), ['a'], 'a released run is missing again');
}

// ---- 6. seeded random admit/release interleavings ----
{
  let seed = 0x5eed1103;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const before = notes.length;
  let worst = '';
  for (let round = 0; round < 200 && !worst; round++) {
    const t = fresh();
    const open = [];                 // [handle, runId]
    const refs = new Map();          // the model: runId -> open admissions
    let anon = 0;
    for (let step = 0; step < 60; step++) {
      if (open.length && rnd() < 0.45) {
        const [h, id] = open.splice(Math.floor(rnd() * open.length), 1)[0];
        h.release();
        if (id) { const n = refs.get(id) - 1; if (n) refs.set(id, n); else refs.delete(id); } else anon--;
      } else {
        const id = rnd() < 0.2 ? '' : 'run-' + Math.floor(rnd() * 5);
        const h = t.admit(RunTable.metaOf({ runId: id || undefined }));
        if (rnd() < 0.5) h.running();
        open.push([h, id]);
        if (id) refs.set(id, (refs.get(id) || 0) + 1); else anon++;
      }
      const ids = ['run-0', 'run-1', 'run-2', 'run-3', 'run-4'];
      if (t.size() !== refs.size + anon) worst = 'round ' + round + ' step ' + step + ': size ' + t.size() + ' != model ' + (refs.size + anon);
      else if (ids.some(id => t.has(id) !== refs.has(id))) worst = 'round ' + round + ' step ' + step + ': membership diverged';
      else if (ids.some(id => refs.has(id) && t.get(id).refs !== refs.get(id))) worst = 'round ' + round + ' step ' + step + ': refcount diverged';
      if (worst) break;
    }
    while (!worst && open.length) open.pop()[0].release();
    if (!worst && t.size() !== 0) worst = 'round ' + round + ': ' + t.size() + ' entries left after every admission was released';
  }
  A.eq(worst, '', '200 seeded interleavings: size, membership and refcounts match the model at every step, and every table empties');
  A.eq(notes.length, before, 'with no stray release noted');
}

A.report('run-table.test');
