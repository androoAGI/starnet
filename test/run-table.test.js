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
     6. seeded random admit/release interleavings over shared ids always end with the table exactly matching a plain model;
     11. (S3) the entry owns its run's stop from admission: a queued turn is stoppable by its id, a delegated worker or an id-less
        run never is, and stopAll counts only fresh joined stops (a run another kill already reached is not counted twice). */
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
    ['v1', { runId: 'chatcmpl-1', agentId: 'agent', trigger: 'event', surface: 'autonomous', streamId: 'v1s', taskSource: 'api' }, null],
    ['v1-repair', { runId: 'chatcmpl-1-repair', agentId: 'agent', trigger: 'event', outputOnly: true, taskSource: 'api' }, null],
    // a channel hub hands its channel as taskSource (channels/hub.js): the snapshot named hub runs by it, every Telegram bot 'telegram'
    ['hub', { runId: 'hub', agentId: 'agent', trigger: 'event', surface: 'autonomous', streamId: 'tg', taskSource: 'telegram' }, null],
    ['hub-bot', { runId: 'hubbot', agentId: 'mira', trigger: 'event', surface: 'autonomous', taskSource: 'telegram:bot7' }, null],
    ['hub-slack', { runId: 'hubslack', agentId: 'agent', trigger: 'event', surface: 'autonomous', taskSource: 'slack' }, null],
    ['hub-line', { runId: 'hubline', agentId: 'writer', trigger: 'event', lineId: 'line-1', taskSource: 'trigger' }, null],
    ['plain-event', { runId: 'plain', agentId: 'agent', trigger: 'event' }, null],
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
    { runId: 'chatcmpl-1', agentId: 'agent', source: 'api', startedAt: 5000, state: 'queued', streamId: 'v1s' },
    { runId: 'hub', agentId: 'agent', source: 'telegram', startedAt: 5000, state: 'queued', streamId: 'tg' },
    { runId: 'hubbot', agentId: 'mira', source: 'telegram', startedAt: 5000, state: 'queued' },
    { runId: 'hubslack', agentId: 'agent', source: 'slack', startedAt: 5000, state: 'queued' },
    { runId: 'hubline', agentId: 'writer', source: 'host', startedAt: 5000, state: 'queued' },
    { runId: 'plain', agentId: 'agent', source: 'event', startedAt: 5000, state: 'queued' },
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

/* ===================== S2: ONE TERMINAL EMITTER ===================== */
const RunOutcome = require('../frontend/app/runoutcome.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');
const recorder = () => { const ev = []; const emit = (n, p) => { ev.push([n, p]); }; emit.ev = ev; return emit; };
const count = (ev, name, runId) => ev.filter(([n, p]) => n === name && p && p.runId === runId).length;

// ---- 7. guard / finish: one start, one end, the observed floor, other runs untouched ----
{
  const t = fresh();
  const before = notes.length;
  const h = t.admit({ runId: 'lead', agentId: 'agent' });
  const chain = recorder();
  const emit = h.entry.guard(chain);
  emit('agent.run.start', { agentId: 'agent', runId: 'lead', trigger: 'directive', model: 'm' });
  emit('agent.run.start', { agentId: 'agent', runId: 'lead', trigger: 'directive', model: 'm' });
  emit('agent.run.start', { agentId: 'w', runId: 'worker', trigger: 'delegated', model: 'm' });
  emit('agent.cost', { agentId: 'agent', runId: 'lead', usd: 0.25, tokensIn: 10, tokensOut: 4, reconciled: true });
  emit('agent.cost', { agentId: 'w', runId: 'worker', usd: 9, tokensIn: 1, tokensOut: 1, reconciled: true });
  emit('agent.cost', { agentId: 'agent', runId: 'lead', usd: 'NaN', reconciled: true });
  emit('agent.run.end', { agentId: 'w', runId: 'worker', reason: 'done', turns: 1, usd: 9 });
  emit('agent.run.end', { agentId: 'agent', runId: 'lead', reason: 'done', turns: 1, usd: 0.25 });
  emit('agent.run.end', { agentId: 'agent', runId: 'lead', reason: 'error', turns: 1, usd: 0.25 });
  A.eq([count(chain.ev, 'agent.run.start', 'lead'), count(chain.ev, 'agent.run.end', 'lead')], [1, 1], 'guard: the run\'s first start and first end pass; the repeats are dropped');
  A.eq(chain.ev.filter(([, p]) => p.runId === 'lead' && p.reason).map(([, p]) => p.reason), ['done'], 'guard: the end that passed is the first one');
  A.eq([count(chain.ev, 'agent.run.start', 'worker'), count(chain.ev, 'agent.run.end', 'worker'), count(chain.ev, 'agent.cost', 'worker')], [1, 1, 1], 'guard: a forwarded worker\'s events pass untouched');
  A.eq([h.entry.started, h.entry.ended, h.entry.usd, h.entry.tokens, h.entry.called], [true, true, 0.25, 14, true], 'guard: the run\'s own agent.cost is its observed floor (a worker\'s is not; a non-number books nothing)');
  A.eq(notes.slice(before).map(n => n.tag), ['runtable.duplicate-start', 'runtable.duplicate-end'], 'guard: each dropped repeat is noted');
  A.eq(h.entry.settle(new Error('late'), { emit: recorder() }), false, 'settle: an ended run is never ended again');
  h.release();
  const quiet = t.admit({ runId: 'quiet' });
  const q = quiet.entry.guard(recorder());
  q('agent.run.start', { agentId: 'agent', runId: 'quiet', trigger: 'directive', model: 'm' });
  A.eq(quiet.entry.called, false, 'guard: a start alone is no sign the model was called');
  q('cost.estimate', { agentId: 'agent', runId: 'quiet', usd: 0.1, tokens: 3 });
  A.eq([quiet.entry.called, quiet.entry.usd], [true, 0], 'guard: a usage estimate says a call went out, and books nothing');
  quiet.release();
}

// ---- 8. settle: THE BELT ----
{
  const t = fresh();
  const before = notes.length;
  // started, never ended: the run's error words and one end through its bound chain, at its observed floor, stamped there
  const a = t.admit({ runId: 'thrown', agentId: 'forge' });
  const chainA = recorder();
  const ga = a.entry.guard(RunOutcome.sink(chainA));
  ga('agent.run.start', { agentId: 'forge', runId: 'thrown', trigger: 'directive', model: 'm' });
  ga('agent.cost', { agentId: 'forge', runId: 'thrown', usd: 0.00014, tokensIn: 5, tokensOut: 3, reconciled: true });
  const callerA = recorder();
  A.eq(a.entry.settle(new Error('injected host fault'), { emit: callerA, trigger: 'directive', model: 'm' }), true, 'settle: a started run left unended is ended');
  A.eq(chainA.ev.slice(2), [
    ['agent.run.error', { agentId: 'forge', runId: 'thrown', message: 'sidecar failure: injected host fault', transient: false, failureCode: 'no_terminal_outcome' }],
    ['agent.run.end', { agentId: 'forge', runId: 'thrown', reason: 'error', turns: 0, usd: 0.00014, outcome: 'failed', failureCode: 'no_terminal_outcome' }]
  ], 'settle: the run\'s own error words and one end, through its own chain, stamped, at the spend its stream booked');
  A.eq(callerA.ev, [], 'settle: nothing doubles onto the caller\'s sink (the chain already reaches it)');
  A.eq(a.entry.settle(new Error('again'), { emit: callerA }), false, 'settle: once');
  // never started: the balanced receipt on the caller's sink only
  const b = t.admit({ runId: 'queued', agentId: 'mira' });
  const callerB = recorder();
  A.eq(b.entry.settle(new Error('injected fault in the conversation queue'), { emit: RunOutcome.sink(callerB), trigger: 'event', model: 'test/model' }), true, 'settle: a run that never started gets its receipt');
  A.eq(callerB.ev, [
    ['agent.run.start', { agentId: 'mira', runId: 'queued', trigger: 'event', model: 'test/model' }],
    ['agent.run.error', { agentId: 'mira', runId: 'queued', message: 'sidecar failure: injected fault in the conversation queue', transient: false, failureCode: 'no_terminal_outcome' }],
    ['agent.run.end', { agentId: 'mira', runId: 'queued', reason: 'error', turns: 0, usd: 0, outcome: 'failed', failureCode: 'no_terminal_outcome' }]
  ], 'settle: a never-started run\'s receipt is balanced, on its caller\'s sink, stamped');
  // never started with no caller sink (the overseer review's floor-only case), and an anonymous run: nothing
  const c = t.admit({ runId: 'review' });
  A.eq(c.entry.settle(new Error('x'), null), false, 'settle: a never-started run with no caller sink lights nothing (the floor never lights a run that never ran)');
  const d = t.admit({ agentId: 'agent' });
  A.eq(d.entry.settle(new Error('x'), { emit: recorder() }), false, 'settle: an anonymous run (no id to pair a receipt) gets nothing');
  // a sink that throws is noted, never thrown into the caller's finally
  const e = t.admit({ runId: 'brittle' });
  A.notThrows(() => e.entry.settle(new Error('x'), { emit: () => { throw new Error('sink down'); } }), 'settle: never throws');
  A.eq(notes.slice(before).map(n => n.tag), ['runtable.settle'], 'settle: a failing sink is noted');
  // handleRun's own receipt (a throw before runOnce began), as the base wrote it: start, error, end stamped
  const base = recorder();
  const thrownErr = { agentId: 'agent', runId: 'r-x', message: 'sidecar failure: boom', transient: false, failureCode: RunOutcome.NO_TERMINAL };
  base('agent.run.start', { agentId: 'agent', runId: 'r-x', trigger: 'directive', model: String('m' || '') });
  base('agent.run.error', thrownErr);
  base('agent.run.end', RunOutcome.stamp({ agentId: 'agent', runId: 'r-x', reason: 'error', turns: 0, usd: 0 }, thrownErr));
  const now = recorder();
  RunTable.thrownReceipt(RunOutcome.sink(now), { agentId: 'agent', runId: 'r-x', trigger: 'directive', model: 'm' }, new Error('boom'), false);
  A.eq(JSON.stringify(now.ev), JSON.stringify(base.ev), 'thrownReceipt: byte for byte the receipt handleRun\'s catch wrote at the base');
  A.eq(RunTable.NO_TERMINAL, RunOutcome.NO_TERMINAL, 'the belt\'s code is RunOutcome\'s no_terminal_outcome');
  [a, b, c, d, e].forEach(x => x.release());
}

// ---- 9. refuseRun: every up-front refusal in runOnceCore, byte for byte the triple it hand-wrote at the base ----
{
  const CORE = sidecarTopLevelFunction('runOnceCore').replace(/\r\n/g, '\n');
  const declAt = CORE.indexOf('  const refuse = (r, startModel) => ');
  const DECL = declAt < 0 ? '' : CORE.slice(declAt, CORE.indexOf('\n', declAt));
  A.ok(/RunTable\.refuseRun\(emit, \{ agentId, runId, trigger, model: /.test(DECL), 'fixture: runOnceCore\'s refuse() is sliced');
  // the call the site makes now: from its marker, the first refuse( and its balanced parentheses
  function callAt(marker) {
    const at = CORE.indexOf(marker);
    const from = at < 0 ? -1 : CORE.indexOf('refuse(', at);
    if (from < 0) return '';
    let depth = 0, i = from + 'refuse'.length;
    for (; i < CORE.length; i++) {
      const ch = CORE[i];
      if (ch === '/' && CORE[i + 1] === '/') i = CORE.indexOf('\n', i);   // a comment line inside the call (its apostrophes are not quotes)
      else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (!depth) break; }
      else if (ch === "'" || ch === '"' || ch === '`') { const q = ch; for (i++; i < CORE.length && CORE[i] !== q; i++) if (CORE[i] === '\\') i++; }
    }
    const message = CORE.slice(at, from).match(/\bconst message = [^\n]+;/);   // the line-budget site hoists its private result's shared wording
    return (message ? message[0] + '\n' : '') + CORE.slice(from, i + 1) + ';';
  }
  const NAMES = ['RunTable', 'emit', 'agentId', 'runId', 'trigger', 'model', 'runStartExtra', 'o', 'e', 'scan', 'checked', 'lim', 'concurrencyGate', 'refusal', 'agentModelBlocker', 'imageBlocker', 'ref', 'saved', 'providerId', 'oauthLabel'];
  const scope = x => Object.assign({ RunTable, agentId: 'forge', runId: 'r-ref', trigger: 'schedule', model: 'test/model', runStartExtra: { dockId: 'bay-1', workitemId: 'wi-1' },
    o: { noAgent: false }, e: Object.assign(new Error('boom'), { reloginRequired: true }), scan: { error: 'blocked: an instruction in the output' }, checked: { wakeAgent: false, output: '' },
    lim: { maxUsdPerDay: 2 }, concurrencyGate: { max: () => 3 }, refusal: null, agentModelBlocker: 'Model unavailable for agent chat', imageBlocker: 'Image task blocked: this agent has no STUDIO.',
    ref: 'weekly-digest', saved: null, providerId: 'ollama', oauthLabel: () => 'Grok (xAI)' }, x || {});
  const now = (marker, x) => { const s = scope(x); const out = recorder(); s.emit = out; new Function(...NAMES, DECL + '\n' + callAt(marker))(...NAMES.map(k => s[k])); return out.ev; };
  // THE BASE TRIPLES, literally as 0b8441064's runOnceCore wrote them (the expressions copied from that tree)
  const was = (fn, x) => { const s = scope(x); const out = recorder(); fn(out, s); return out.ev; };
  const BASE = [
    ['if (lim.maxUsdPerDay != null', {}, (emit, { agentId, runId, trigger, model, runStartExtra, o, lim }) => {
      emit('agent.run.start', { agentId, runId, trigger, model: o.noAgent ? '' : model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false,
        message: 'The line reached its $' + lim.maxUsdPerDay.toFixed(2) + ' daily limit — raise its LINE BUDGET or try again tomorrow.' });
      emit('agent.run.end', { agentId, runId, reason: 'budget', turns: 0, usd: 0 }); }],
    ['try { checked = await executeCronScript(', {}, (emit, { agentId, runId, trigger, model, runStartExtra, o, e }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model: o.noAgent ? '' : model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: (e && e.message) || String(e), failureCode: 'routine_script_failed' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ['const scan = cronGuard.scanAssembled(', {}, (emit, { agentId, runId, trigger, model, runStartExtra, o, scan }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model: o.noAgent ? '' : model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: scan.error, failureCode: 'routine_script_blocked' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ['if (o.noAgent || checked.wakeAgent === false) {', { o: { noAgent: true }, checked: { wakeAgent: true, output: 'the script said so' } }, (emit, { agentId, runId, trigger, runStartExtra, checked }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model: '', ...runStartExtra });
      emit('agent.token', { agentId, runId, delta: (!checked.wakeAgent || !checked.output) ? '[SILENT]' : checked.output });
      emit('agent.run.end', { agentId, runId, reason: 'done', turns: 0, usd: 0 }); }],
    ['if (o.noAgent || checked.wakeAgent === false) {', { checked: { wakeAgent: false, output: '' } }, (emit, { agentId, runId, trigger, runStartExtra, checked }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model: '', ...runStartExtra });
      emit('agent.token', { agentId, runId, delta: (!checked.wakeAgent || !checked.output) ? '[SILENT]' : checked.output });
      emit('agent.run.end', { agentId, runId, reason: 'done', turns: 0, usd: 0 }); }],
    ['} else if (o.noAgent) {', { o: { noAgent: true } }, (emit, { agentId, runId, trigger, runStartExtra }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model: '', ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: 'script-only routine has no script', failureCode: 'routine_script_missing' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ['if (!agentLifecycle.canStart(agentId)) {', {}, (emit, { agentId, runId, trigger, model, runStartExtra }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: true, message: 'This agent is being deleted and cannot start new work.', failureCode: 'agent_deleting' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ['if (!concurrencyGate.tryEnter(agentId)) {', {}, (emit, { agentId, runId, trigger, model, runStartExtra, concurrencyGate }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: true, message: 'Too many agents are working at once (limit ' + concurrencyGate.max() + '). Wait for one to finish, or raise STARNET_MAX_CONCURRENT_AGENTS.', failureCode: 'concurrency_limit' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ...[{ exhausted: true, balanceUsd: 0 }, { exhausted: true, held: { counted: true, runs: 2, usd: 3 }, balanceUsd: 0 }, { linkRefused: true }, {}].map(m => (
      ['const refusal = budgetCaps.managedRefusalMessage(', { refusal: require('../sidecar/budgetcaps.js').managedRefusalMessage(m) }, (emit, { agentId, runId, trigger, model, runStartExtra, refusal }) => {
        emit('agent.run.start', { agentId, runId, trigger, model, ...runStartExtra });
        emit('agent.run.error', { agentId, runId, transient: refusal.transient, reason: 'billing', message: refusal.message, failureCode: refusal.code });
        emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }])),
    ['if (agentModelBlocker) {', {}, (emit, { agentId, runId, trigger, model, runStartExtra, agentModelBlocker }) => {
      emit('agent.run.start', { agentId, runId, trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: agentModelBlocker, failureCode: 'model_unsuitable' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ['if (imageBlocker) {', {}, (emit, { agentId, runId, trigger, model, runStartExtra, imageBlocker }) => {
      emit('agent.run.start', { agentId, runId, trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: imageBlocker, failureCode: 'image_route_blocked' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ["resolved.tools.indexOf('skill.view') < 0) {", {}, (emit, { agentId, runId, trigger, model, runStartExtra }) => {
      emit('agent.run.start', { agentId, runId, trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: 'This routine requires saved skills, but its per-job toolset/station does not grant skill.view.', failureCode: 'routine_skill_unavailable' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ...[{ saved: null }, { saved: { id: 'weekly-digest' } }].map(x => (
      ['const verdict = saved ? skillGate.verify(saved) : null;', x, (emit, { agentId, runId, trigger, model, runStartExtra, ref, saved }) => {
        emit('agent.run.start', { agentId, runId, trigger, model, ...runStartExtra });
        emit('agent.run.error', { agentId, runId, transient: false, message: !saved ? ('Required routine skill "' + ref + '" no longer exists.') : ('Required routine skill "' + ref + '" is withheld by the skill guard.'), failureCode: !saved ? 'routine_skill_missing' : 'routine_skill_withheld' });
        emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }])),
    ...[Object.assign(new Error('Sign in with ChatGPT again'), { reloginRequired: true }), new Error('token endpoint 503')].map(err => (
      ['try { codexToken = await ensureCodexAccessToken(); }', { e: err }, (emit, { agentId, runId, trigger, model, runStartExtra, e }) => {
        emit('agent.run.start', { agentId, runId, trigger: trigger, model, ...runStartExtra });
        emit('agent.run.error', { agentId, runId, transient: !(e && e.reloginRequired), message: 'ChatGPT sign-in needed: ' + ((e && e.message) || e), failureCode: 'auth' });
        emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }])),
    ['try { oauthToken = await ensureOAuthAccessToken(providerId); }', {}, (emit, { agentId, runId, trigger, model, runStartExtra, e, providerId, oauthLabel }) => {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: !(e && e.reloginRequired), message: oauthLabel(providerId) + ' sign-in needed: ' + ((e && e.message) || e), failureCode: 'auth' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }],
    ...['ollama', 'openrouter'].map(p => (
      ['if (isTask && provider.supportsTools(model) === false) {', { providerId: p }, (emit, { agentId, runId, trigger, model, runStartExtra, providerId }) => {
        emit('agent.run.start', { agentId, runId, trigger: trigger, model, ...runStartExtra });
        emit('agent.run.error', { agentId, runId, transient: false, message: 'The model "' + model + '" does not support tool calls, so it can\'t run tasks. '
          + (providerId === 'ollama' ? 'Pick an installed model that lists "tools" (run `ollama show <model>` to check), or pull one, e.g. `ollama pull qwen3:8b`.'
            : 'Pick a tool-capable model (e.g. anthropic/claude-sonnet-4.6 or openai/gpt-4o) on the connect screen.'), failureCode: 'model_no_tools' });
        emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }])),
    ["runJournal.checkpoint(runId, { phase: 'initial'", { e: new Error('ENOSPC: no space left on device') }, (emit, { agentId, runId, trigger, model, runStartExtra, e }) => {
      emit('agent.run.start', { agentId, runId, trigger, model, ...runStartExtra });
      emit('agent.run.error', { agentId, runId, transient: false, message: 'Run could not start safely because its recovery journal could not be persisted: ' + String((e && e.message) || e), failureCode: 'checkpoint_failed' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 }); }]
  ];
  const sites = new Set();
  for (const [marker, x, base] of BASE) {
    sites.add(marker);
    let got;
    try { got = now(marker, x); } catch (err) { got = [['threw', String(err && err.message)]]; }
    A.eq(JSON.stringify(got), JSON.stringify(was(base, x)), 'refuseRun golden: "' + marker.slice(0, 48) + '" ' + JSON.stringify(x).slice(0, 60) + ' emits byte for byte the base triple');
  }
  A.eq(sites.size, 16, 'refuseRun golden: all sixteen up-front receipt sites of runOnceCore are pinned');
  A.eq([(CORE.match(/\bemit\('agent\.run\.start'/g) || []).length, (CORE.match(/\bemit\('agent\.run\.end', \{ agentId, runId, reason: '\w+', turns: 0, usd: 0 \}\)/g) || []).length], [0, 0],
    'runOnceCore hand-writes no start and no receipt end any more: each goes through refuse() (the loop\'s own pass through loopEmit)');
  // the queued receipt (runOnce, CANCELLED WHILE QUEUED) as the base wrote it, now through refuseRun, stamped on the caller's sink only
  const out = recorder();
  RunTable.refuseRun(RunOutcome.sink(out), { agentId: 'agent', runId: 'q-1', trigger: 'directive', model: '' }, { reason: 'cancelled' });
  A.eq(out.ev, [['agent.run.start', { agentId: 'agent', runId: 'q-1', trigger: 'directive', model: '' }],
    ['agent.run.end', { agentId: 'agent', runId: 'q-1', reason: 'cancelled', turns: 0, usd: 0, outcome: RunOutcome.ofEnd({ reason: 'cancelled' }, null).outcome }]],
    'refuseRun: the queued receipt is the base start/end, now outcome-stamped');
}

// ---- 10. seeded random interleavings of start / end / error / cost / duplicate / child / settle over concurrent runs ----
{
  let seed = 0x7ab1e5e2;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  let worst = '';
  for (let round = 0; round < 300 && !worst; round++) {
    const t = fresh();
    const runs = ['a', 'b', 'c'].map(id => {
      const h = t.admit({ runId: id, agentId: 'agent' });
      const chain = recorder(), caller = recorder();
      return { id, h, chain, caller, emit: rnd() < 0.85 ? h.entry.guard(chain) : null, childSent: 0, settled: false };   // some never reach their chain (a throw in the queue)
    });
    for (let step = 0; step < 40; step++) {
      const r = pick(runs);
      if (!r.emit) continue;   // a settled run keeps getting events: a late start or end after the belt must still be dropped
      const op = pick(['start', 'start', 'end', 'error', 'cost', 'child', 'child']);
      if (op === 'child') { r.emit(pick(['agent.run.start', 'agent.run.end', 'agent.cost']), { agentId: 'w', runId: r.id + '-worker', usd: 1, reason: 'done', turns: 1 }); r.childSent++; }
      else if (op === 'start') { r.emit('agent.run.start', { agentId: 'agent', runId: r.id, trigger: 'directive', model: 'm' }); r.began = true; }
      else if (op === 'end') { if (r.began) r.emit('agent.run.end', { agentId: 'agent', runId: r.id, reason: 'done', turns: 1, usd: 0 }); }   // every producer starts its run before it ends it (the loop, a receipt, the belt)
      else if (op === 'error') r.emit('agent.run.error', { agentId: 'agent', runId: r.id, message: 'x', transient: false });
      else r.emit('agent.cost', { agentId: 'agent', runId: r.id, usd: 0.5, tokensIn: 1, tokensOut: 1, reconciled: true });
      const s = count(r.chain.ev, 'agent.run.start', r.id), e = count(r.chain.ev, 'agent.run.end', r.id);
      if (s > 1 || e > 1) worst = 'round ' + round + ' step ' + step + ': run ' + r.id + ' saw ' + s + ' starts and ' + e + ' ends';
      if (rnd() < 0.08) { r.h.entry.settle(new Error('thrown'), { emit: r.caller, trigger: 'directive', model: 'm' }); r.settled = true; }
      if (worst) break;
    }
    for (const r of runs) {
      if (worst) break;
      r.h.entry.settle(new Error('thrown'), { emit: r.caller, trigger: 'directive', model: 'm' });
      const starts = count(r.chain.ev, 'agent.run.start', r.id) + count(r.caller.ev, 'agent.run.start', r.id);
      const ends = count(r.chain.ev, 'agent.run.end', r.id) + count(r.caller.ev, 'agent.run.end', r.id);
      const child = r.chain.ev.filter(([, p]) => p.runId === r.id + '-worker').length;
      if (starts !== 1 || ends !== 1) worst = 'round ' + round + ': run ' + r.id + ' ended with ' + starts + ' starts and ' + ends + ' ends';
      else if (count(r.chain.ev, 'agent.run.start', r.id) && count(r.caller.ev, 'agent.run.end', r.id)) worst = 'round ' + round + ': run ' + r.id + ' started on its chain but ended on its caller\'s sink';
      else if (child !== r.childSent) worst = 'round ' + round + ': run ' + r.id + ' forwarded ' + child + ' of ' + r.childSent + ' worker events';
      r.h.release();
    }
    if (!worst && t.size() !== 0) worst = 'round ' + round + ': the table kept ' + t.size() + ' entries';
  }
  A.eq(worst, '', '300 seeded interleavings: never a second start or end, every run ends exactly once (its chain if it started there, else its caller\'s sink), and a worker\'s events pass untouched');
}

// ---- 11. STOPS (S3): the entry owns its run's stop from admission; stopAll counts only fresh aborts ----
{
  const t = fresh();
  // a COMMS turn still queued behind its conversation: joined at admission, so a stop by its id reaches it before it runs
  const owner = new AbortController();
  const queued = t.admit(RunTable.metaOf({ runId: 'q', agentId: 'agent', streamId: 'home', trigger: 'directive', surface: 'interactive' }));
  const qSig = queued.join(owner.signal);
  A.ok(qSig !== owner.signal && !qSig.aborted, 'join: the run signal is its owner\'s joined with its entry\'s stop');
  A.ok(t.stoppable('q') && queued.entry.state === 'queued', 'a turn still waiting in its queue is stoppable by its id');
  A.eq(queued.join(owner.signal), owner.signal, 'one admission joins once (a second join hands the signal back)');
  // a /v1 run with no owner signal of its own, a hub run, a delegated worker, an id-less run, an early-site admission
  const v1 = t.admit(RunTable.metaOf({ runId: 'v1', agentId: 'agent', trigger: 'event', taskSource: 'api' }));
  const v1Sig = v1.join(undefined);
  A.ok(v1Sig && v1Sig === v1.entry.stopper.signal, 'a run with no signal of its own runs on its entry\'s stop alone');
  const hubOwner = new AbortController();
  const hub = t.admit(RunTable.metaOf({ runId: 'hub', agentId: 'agent', trigger: 'event', taskSource: 'telegram' }));
  const hubSig = hub.join(hubOwner.signal);
  const bgOwner = new AbortController();
  const bg = t.admit(RunTable.metaOf({ runId: 'bg', agentId: 'sub', parentRunId: 'q', steer: () => [] }));
  A.eq(bg.join(bgOwner.signal), bgOwner.signal, 'a delegated worker is never joined: its manager owns its stop');
  const fg = t.admit(RunTable.metaOf({ runId: 'fg', agentId: 'mira', parentRunId: 'q' }));
  const fgOwner = new AbortController();
  A.eq(fg.join(fgOwner.signal), fgOwner.signal, 'nor a foreground worker');
  const anon = t.admit(RunTable.metaOf({ agentId: 'agent' }));
  const anonOwner = new AbortController();
  A.eq(anon.join(anonOwner.signal), anonOwner.signal, 'an id-less run is never joined: nothing can name it');
  const early = t.admit({ runId: 'beat', agentId: 'agent', source: 'nightshift', state: 'running' });
  A.ok(!t.stoppable('bg') && !t.stoppable('fg') && !t.stoppable('beat') && !t.stoppable('nope'), 'stoppable: only an entry holding a stop');
  A.eq(t.stop('bg', 'cancel'), false, 'a stop by a delegated worker\'s id stops nothing and says so');
  A.eq(t.stop('nope', 'cancel'), false, 'nor by an id the table does not hold');
  // stop by id
  A.eq(t.stop('q', 'cancel'), true, 'stop(q) reaches the queued turn');
  A.ok(qSig.aborted && !owner.signal.aborted, 'its run signal is aborted (the queue reads it), its owner\'s is not touched');
  // E-STOP's order: the owner kills first (the hub record), then stopAll: only the runs no other kill reached are counted
  hubOwner.abort();
  A.ok(hubSig.aborted, 'the hub owner\'s kill reaches the run through its joined signal');
  A.eq(t.stopAll('estop'), 1, 'stopAll counts only the run no kill had reached (/v1): the hub run and the stopped turn are not counted twice');
  A.ok(v1Sig.aborted && bgOwner.signal.aborted === false && anonOwner.signal.aborted === false && fgOwner.signal.aborted === false, 'it aborts every stop it holds and nothing it does not');
  A.eq(t.stopAll('estop'), 0, 'a second E-STOP counts nothing that is already stopped');
  // The table owns the counting rule; the retired standalone helper is no longer a second oracle.
  const t2 = fresh();
  const own2 = new AbortController();
  const a2 = t2.admit(RunTable.metaOf({ runId: 'a2', agentId: 'agent' })); a2.join(own2.signal);
  const b2 = t2.admit(RunTable.metaOf({ runId: 'b2', agentId: 'agent' })); b2.join(undefined);
  own2.abort();
  A.eq(t2.stopAll('estop'), 1, 'the table counts the one joined run its owner did not already abort');
  a2.release(); b2.release();
  // An interactive owner AND its joined core count once across E-STOP's two table phases.
  const t3 = fresh();
  const ac = new AbortController();
  const early3 = t3.admit({ runId: 'r', agentId: 'agent' }, { signal: ac.signal, stop: () => ac.abort() });
  const both = t3.admit(RunTable.metaOf({ runId: 'r', agentId: 'agent' })); both.join(ac.signal);
  A.eq(t3.stopOwners('estop') + t3.stopAll('estop'), 1, 'an owned run with a joined core is counted once across the two phases');
  early3.release(); both.release();
  // the stop goes with the last joined admission; a later run under the same id gets a fresh one
  const t4 = fresh();
  const first = t4.admit({ runId: 'line', agentId: 'agent', source: 'cron' });     // Run Now's early admission: no stop of its own
  const hop1 = t4.admit(RunTable.metaOf({ runId: 'line', agentId: 'agent' }));
  const s1 = hop1.join(undefined);
  const nested = t4.admit(RunTable.metaOf({ runId: 'line', agentId: 'agent' }));
  const s2 = nested.join(new AbortController().signal);
  A.ok(t4.stoppable('line') && hop1.entry.joins === 2, 'two live admissions under one id share its one stop');
  hop1.release();
  A.ok(t4.stoppable('line'), 'the stop stays while a joined admission lives');
  nested.release();
  A.ok(!t4.stoppable('line') && t4.has('line'), 'and goes with the last one; the early admission still holds the entry');
  A.ok(!s1.aborted && !s2.aborted, 'releasing aborts nothing');
  const hop2 = t4.admit(RunTable.metaOf({ runId: 'line', agentId: 'agent' }));
  const s3 = hop2.join(undefined);
  A.ok(s3 !== s1 && !s3.aborted && t4.stoppable('line'), 'a later run under the same id gets a fresh stop');
  hop2.release(); first.release();
  A.eq(t4.size(), 0, 'and the entry goes with its last admission');
  // a stop that throws is noted, not counted, and never stops the rest
  const t5 = fresh();
  const bad = t5.admit(RunTable.metaOf({ runId: 'bad', agentId: 'agent' })); bad.join(undefined);
  const good = t5.admit(RunTable.metaOf({ runId: 'good', agentId: 'agent' })); const goodSig = good.join(undefined);
  bad.entry.stopper.abort = () => { throw new Error('boom'); };
  notes.length = 0;
  A.eq(t5.stopAll('fault'), 1, 'one throwing stop is not counted and never stops the rest');
  A.ok(goodSig.aborted, 'the rest are stopped');
  A.eq(notes.map(n => n.tag), ['runtable.stop.fault'], 'the throw is noted under its cause');
  A.eq(t5.stop('bad', 'cancel'), true, 'a stop by id of a stop that throws still says a run was there');
  A.eq(notes.map(n => n.tag), ['runtable.stop.fault', 'runtable.stop.cancel'], 'and notes it');
  for (const h of [queued, v1, hub, bg, fg, anon, early]) h.release();
  A.eq(t.size(), 0, 'every entry goes with its admission, stopped or not');
}

// Early admissions retain their OWN host stop until that exact admission releases it. A phone stop
// has bookkeeping beyond AbortController.abort; a nested core stop must not replace that callback.
{
  const notes = [], t = RunTable.makeRunTable({ now: () => 1, note: (tag, error) => notes.push({ tag, error }) });
  const host = new AbortController(); let phoneStops = 0;
  const early = t.admit({ runId: 'phone', agentId: 'agent', source: 'remote' }, {
    signal: host.signal, stop: () => { phoneStops++; host.abort(); }
  });
  A.ok(t.owned('phone') && t.ownerLive('phone') && t.stoppable('phone'), 'early host work is owned/live/stoppable before a core exists');
  const core = t.admit({ runId: 'phone', agentId: 'agent' });
  const joined = core.join(host.signal);
  A.eq(t.stopAll('estop'), 1, 'host plus core counts as one freshly stopped run');
  A.eq(phoneStops, 1, 'phone owner bookkeeping receives E-STOP');
  A.ok(host.signal.aborted && joined.aborted, 'both owner and nested core stop');
  A.ok(t.owned('phone') && !t.ownerLive('phone'), 'abort retains ownership but ends owner liveness');
  A.eq(t.stopAll('estop'), 0, 'a repeated stop adds no fresh count');
  early.release();
  A.ok(!t.owned('phone') && t.stoppable('phone'), 'releasing outer owner retains the still-held core controller');
  core.release();
  A.eq(t.size(), 0, 'last release removes the stopped run');

  const a = new AbortController(), b = new AbortController();
  const old = t.admit({ runId: 'shared' }, { signal: a.signal, stop: () => a.abort() });
  const newer = t.admit({ runId: 'shared' }, { signal: b.signal, stop: () => b.abort() });
  old.release();
  A.ok(t.ownerLive('shared'), 'older lease release cannot remove a newer owner registration');
  t.stop('shared', 'cancel');
  A.ok(!a.signal.aborted && b.signal.aborted, 'stop reaches only the retained admission');
  newer.release();
  const replacement = new AbortController();
  const generation = t.admit({ runId: 'shared' }, { signal: replacement.signal, stop: () => replacement.abort() });
  old.release();
  A.ok(t.ownerLive('shared') && !replacement.signal.aborted, 'stale repeated release cannot affect a reused run id');
  generation.release();

  const good = new AbortController();
  const broken = t.admit({ runId: 'fault' }, { stop: () => { throw new Error('owner stop fault'); } });
  const survivor = t.admit({ runId: 'fault' }, { signal: good.signal, stop: () => good.abort() });
  A.eq(t.stopAll('fault'), 1, 'one throwing owner does not hide a successful stop of the same run');
  A.ok(good.signal.aborted, 'other owner stop still runs');
  A.ok(notes.some(n => n.tag === 'runtable.stop.fault'), 'owner stop failure remains observable');
  A.eq(t.stopAll('fault'), 0, 'a still-throwing owner plus an already-stopped sibling is no fresh stop');
  broken.release(); survivor.release();
  A.eq(t.size(), 0, 'faulting stops do not strand admissions');
}

// Group admission preserves the old metadata owner's lifetime, not every run known to the table.
{
  const t = fresh();
  const unrelated = ['api', 'telegram', 'delegated', 'interactive', 'cron'].map((source, i) =>
    t.admit({ runId: 'unrelated-' + i, agentId: 'forge', source, delegated: source === 'delegated' }));
  A.eq(t.groupBusy('forge'), false, 'API, hub, delegated and even familiar source names do not imply group backpressure');
  const truthy = t.admit({ runId: 'truthy', agentId: 'forge', blocksGroup: 'true' });
  A.eq(t.groupBusy('forge'), false, 'only the explicit boolean admission fact blocks a group');
  truthy.release();

  const metadata = { runId: 'owned-group-busy', agentId: 'forge', source: 'cron', blocksGroup: true };
  const owner = new AbortController();
  const outer = t.admit(metadata, { signal: owner.signal, stop: () => owner.abort() });
  const core = t.admit({ runId: metadata.runId, agentId: 'forge' });
  A.ok(t.groupBusy('forge') && !t.groupBusy('mira'), 'a flagged admission blocks only its agent while its unflagged core joins');
  metadata.blocksGroup = false;
  core.release();
  A.ok(t.groupBusy('forge'), 'unflagged core release and caller metadata mutation cannot steal the captured owner fact');
  const tail = t.admit({ runId: metadata.runId, agentId: 'forge' });
  t.stop(metadata.runId, 'cancel');
  A.ok(!t.ownerLive(metadata.runId) && t.groupBusy('forge'), 'close/abort defers the group through physical unwind instead of the old immediate metadata deletion');
  outer.entry.finish({ runId: metadata.runId, reason: 'cancelled' });
  A.ok(t.groupBusy('forge'), 'terminal emission alone does not release the still-held admission');
  outer.release();
  A.ok(t.has(metadata.runId) && !t.groupBusy('forge'), 'an unflagged tail may keep the entry alive without keeping group backpressure');
  tail.release();

  const first = t.admit({ runId: 'shared-group-busy', agentId: 'forge', blocksGroup: true });
  const second = t.admit({ runId: 'shared-group-busy', agentId: 'forge', blocksGroup: true });
  const joined = t.admit({ runId: 'shared-group-busy', agentId: 'forge' });
  first.release(); first.release();
  A.ok(t.groupBusy('forge'), 'releasing one flagged admission twice cannot consume another flagged lease');
  second.release();
  A.ok(t.has('shared-group-busy') && !t.groupBusy('forge'), 'the final flagged release clears group backpressure before an unrelated joined tail');
  joined.release();
  const replacement = t.admit({ runId: 'shared-group-busy', agentId: 'forge', blocksGroup: true });
  second.release();
  A.ok(t.groupBusy('forge'), 'an old generation repeated release cannot clear a reused id admission');
  replacement.release();

  const late = t.admit({ runId: 'late-group-busy', agentId: 'forge' });
  const lateFlag = t.admit({ runId: 'late-group-busy', agentId: 'forge', blocksGroup: true });
  A.ok(t.groupBusy('forge'), 'a flagged join to an existing entry counts immediately');
  late.release();
  A.ok(t.groupBusy('forge'), 'the earlier unflagged admission cannot clear the later flagged join');
  lateFlag.release();
  const anon = t.admit({ agentId: 'forge', blocksGroup: true });
  A.ok(t.groupBusy('forge'), 'an explicitly flagged anonymous admission still belongs to its agent');
  anon.release();
  for (const h of unrelated) h.release();
  A.ok(!t.groupBusy('forge') && t.size() === 0, 'every flagged fact goes with its own admission and leaves no busy state');
}

// S5 preserves the host's two stop phases: registered-owner attempts first, still-fresh joined cores last.
// A loop's separate diagnostic and a manual cron's old owner/lease overlap are not redefined by this API.
{
  const notes = [], t = RunTable.makeRunTable({ note: (tag, error) => notes.push({ tag, error }) });
  const leases = [], calls = {};
  const own = (id, ac, effect) => {
    const h = t.admit({ runId: id, agentId: id }, { signal: ac.signal, stop: () => {
      calls[id] = (calls[id] || 0) + 1;
      if (effect) effect();
      ac.abort();
    } });
    leases.push(h); return h;
  };
  const core = (id, ac) => { const h = t.admit({ runId: id, agentId: id }); leases.push(h); return h.join(ac && ac.signal); };
  const interactive = new AbortController(); own('interactive', interactive); const interactiveSignal = core('interactive', interactive);
  const scheduled = new AbortController(), scheduledSignal = core('scheduled', scheduled);
  const loop = new AbortController(); own('loop-context', loop);
  const group = new AbortController(); own('group', group); core('group', group);
  group.abort();   // group.halt precedes the legacy owner phase in the host
  let phoneState = 'running';
  const phone = new AbortController(); own('phone', phone, () => { phoneState = 'stopped'; }); core('phone', phone);
  const hub = new AbortController(), hubSignal = core('hub', hub);
  const apiSignal = core('api-only');
  const sharedA = new AbortController(), sharedB = new AbortController();
  own('shared', sharedA); own('shared', sharedB);
  leases.push(t.admit({ runId: 'throwing-owner' }, { stop: () => { throw new Error('owner stop failed'); } }));
  const already = new AbortController(); already.abort(); own('already-stopped', already);

  A.eq(t.stopOwners('estop'), 7, 'owner phase counts each registered entry once, including already stopped and throwing owners');
  A.ok(interactiveSignal.aborted && loop.signal.aborted && phone.signal.aborted, 'owner phase reaches interactive core, pre-core loop and phone work');
  A.eq(phoneState, 'stopped', 'phone owner bookkeeping is preserved, not replaced by core-controller abort');
  A.eq([calls.group, calls['already-stopped']], [1, 1], 'prior group or owner abort never skips the registered owner callback');
  A.ok(sharedA.signal.aborted && sharedB.signal.aborted && calls.shared === 2, 'two registrations under one id both stop while their entry counts once');
  A.ok(!scheduledSignal.aborted && !hubSignal.aborted && !apiSignal.aborted, 'owner phase leaves ownerless scheduled, hub and API core stops to their own phases');
  A.eq(notes.map(n => n.tag), ['runtable.stop.estop'], 'a throwing owner is noted without stopping the remaining attempts');

  // Their real owners abort these in the host's intervening subsystem phases. No new snapshot/registry is needed.
  scheduled.abort(); hub.abort(); loop.abort();
  A.eq(t.stopAll('estop'), 1, 'final phase counts only the previously untouched API run, not the owner or subsystem stops');
  A.ok(apiSignal.aborted && scheduledSignal.aborted && hubSignal.aborted, 'every joined signal is stopped after the final phase');
  A.eq(t.stopAll('estop'), 0, 'repeated final phase counts no fresh aborts, even though idempotent owner callbacks run again');
  A.eq(t.stopOwners('estop'), 7, 'legacy owner-attempt count remains membership based until the exact admissions release');
  for (const h of leases) h.release();
  A.eq([t.stopOwners('estop'), t.stopAll('estop'), t.size()], [0, 0, 0], 'released owners and cores leave no stop attempts or sticky state');
}

A.report('run-table.test');
