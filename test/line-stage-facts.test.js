/* node test/line-stage-facts.test.js — LINE STAGE FACTS (ops-1115 lane T4, weakness W1; contract C10: a stage's facts survive the hand-off as
   facts, no verdict is reclassified).

   A line hop collected the tool calls the person refused (`denied`) but none the Task Brief gate held, and nothing downstream read either: a
   branch whose only write was refused was joined as delivered and its prose ("Done - I wrote the file.") handed on unmarked, at a join and on a
   one-after-another hand-off alike. Now:
     1. line-runner.js: a hop's held calls (fork.js TaskIntent.isGateHeld on its agent.tool_result) are kept beside the refused ones, and the
        hop result carries the additive `refusals: { denied, held }` when either list is non-empty (denied, hopVerdict, stopCode unchanged).
     2. chain.js: the barrier part keeps `refusals` (PART_META), from a parallel batch (batchToBarrier) and from a branch that parks itself.
     3. the JOIN: after the joined verdict is read (so it cannot change), one 'Line note — ' line per part with refusals is placed under the
        crate's 'JOINED OUTPUT — …' header (never at its end: the tail is read by the verdict parser and by the passed-on frame reader), and
        the walk says how many on `out.refusals = { parts, calls }`.
   FIX ROUND 1 (review B1, B2): a held (or refused) call that the model made again and that RAN is no fact of the stage (block 3b), and a
   noted crate reads back exactly like the pure one at the next gate — a passed-on LOOP frame as the last branch still unwraps, and a
   trailing VERDICT line stays in the three-line tail (blocks 1c, 1d, 1e).
     4. the ONE-AFTER-ANOTHER hand-off: the next stage's turn carries the same note under the upstream text; the answer (out.text) and the
        draft handed on are never changed.
   Real compiler, real router, real chain runner, real hop executor; fakes only at runAgent / runOnce, injected clock and timer.
   RED at 45e7ee302 (= base 8e09831f6 for these files): blocks 1, 2 and 3 fail (no part refusals, no note, no hop refusals). The LIVENESS block
   holds there too: a clean batch hands on byte for byte what the base did (the snapshot below was taken from base), a failed branch still
   marks PARTIAL exactly, a result without `refusals` (every older producer) or with a malformed one adds nothing, no sibling call is handed
   `entry`, and the step test's `denied` is the same. */
'use strict';
const A = require('./_assert.js');
const { makeChainRunner, loopDecision, notedCrate } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const Verdict = require('../sidecar/routing/verdict.js');
const { TaskIntent } = require('../frontend/app/fork.js');

const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });
let T = 0; const clock = () => (T += 10);
const counter = () => { let i = 0; return () => 'id' + (++i); };
const NOTE = 'Line note — ';
const noteLines = t => String(t || '').split('\n').filter(l => l.startsWith(NOTE));
// the crate a stage was handed, read back out of its hand-off turn (Pipeline.handoffPrompt: "The upstream stage (x) produced:\n<crate>\n\n<ask>")
const upstreamOf = turn => { const m = /The upstream stage \([^)\n]*\) produced:\n([\s\S]*)\n\n(?:Do YOUR part|You are the LAST stage)/.exec(String(turn || '')); return m ? m[1] : null; };
// the oracle for where the join's notes go: right under the 'JOINED OUTPUT — …' header line, ahead of the first branch
const underHeader = (s, notes) => { const i = s.indexOf('\n\n'); return s.slice(0, i) + '\n\n' + notes.join('\n') + s.slice(i); };
const ctxOk = { verdict: 'approved' };
const gate = o => Object.assign({ loop: '12,4', backTo: 'drafter', max: 2, when: 'approved', next: 'publisher' }, o || {});

// INBOX -> SPLIT -> (A | B) -> JOINER -> D (the entry A is branch one; B runs after it and parks itself: the sequential branch)
function joinFloor() {
  return geo(
    [{ id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'p2', t: 'splitter', x: 3, y: 0, w: 1, h: 1 },
     { id: 'p3', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'A' },
     { id: 'p4', t: 'bay', x: 2, y: 4, w: 2, h: 2, agentId: 'B' },
     { id: 'p5', t: 'joiner', x: 9, y: 4, w: 1, h: 1 },
     { id: 'p6', t: 'bay', x: 12, y: 4, w: 2, h: 2, agentId: 'D' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'),
     belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'),
     belt(8, 0, 'S'), belt(8, 1, 'S'), belt(8, 2, 'S'), belt(8, 3, 'S'), belt(8, 4, 'E'),
     belt(4, 5, 'E'), belt(5, 5, 'E'), belt(6, 5, 'E'), belt(7, 5, 'E'), belt(8, 5, 'E'), belt(9, 5, 'N'),
     belt(9, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E')]);
}
// every barrier.deliver's newest part, copied as it was parked (the barrier is the chain runner's own object: batchToBarrier and a parking
// branch both call it through this property)
function tapParts(c) {
  const parts = [], deliver = c._barrier.deliver;
  c._barrier.deliver = function () { const r = deliver.apply(this, arguments); parts.push(JSON.parse(JSON.stringify(r.parts[r.parts.length - 1]))); return r; };
  return parts;
}
// the real verdict parser, recording every text it was asked about (the join's verdict is read from the merged payload)
function verdictSpy() {
  const seen = [];
  return { seen, getVerdict: t => { const v = Verdict.parseVerdict(t); seen.push({ text: t, v }); return v; } };
}
const calls = [];   // every runAgent call of every block (no sibling stage is ever handed `entry`)

function joinRig(bResult) {
  const router = makeRouter();
  const plan = P.compileRoutingPlan(joinFloor());
  if (!router.setPlan(plan).ok) throw new Error('plan refused');
  const log = [], spy = verdictSpy();
  const runAgent = async (call) => {
    calls.push(call); log.push(call);
    if (call.agentId === 'B') return bResult;
    return { text: call.agentId + ' output', usd: 0.01, outcome: 'succeeded', reason: 'done' };
  };
  const c = makeChainRunner({
    nextAgent: (a, ctx) => router.chainNext(a, ctx), stepAgent: (a, ctx) => router.chainStep(a, ctx),
    fanSiblings: a => router.fanSiblings(a), lineOfAgent: a => router.lineOfAgent(a),
    runAgent, emit: () => {}, now: clock, setTimer: () => 0, newId: counter(), getVerdict: spy.getVerdict
  });
  const parts = tapParts(c);
  return { c, log, parts, spy, lineId: P.lineOf(plan, plan.bays[0].agentId) };
}
async function joinRun(bResult) {
  const R = joinRig(bResult);
  const res = await R.c.advance({ agentId: 'A', text: 'alpha findings', originalText: 'research X', lineId: R.lineId, runId: 'run1' });
  return Object.assign(R, { res, dTurn: (R.log.find(l => l.agentId === 'D') || {}).text || '' });
}

// the RESEARCH SWARM blueprint: three researchers (the entry and two siblings run as ONE parallel batch) -> JOINER -> the writer (crew3)
function swarmRig(script) {
  const s = WM.create();
  A.ok(s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 14 } }).ok && s.stampBlueprint('swarm_synthesis', 32, 2).ok, 'the swarm floor is stamped');
  s.props().filter(p => p.t === 'bay').forEach((b, i) => s.assignPropAgent(b.id, 'crew' + i));
  const plan = P.compileRoutingPlan(s.projectGeometry());
  const router = makeRouter();
  if (!router.setPlan(plan).ok) throw new Error('swarm plan refused');
  const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
  const log = [], spy = verdictSpy();
  const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x), peekDock: (d, x) => router.chainPeekDock(d, x),
    entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    emit: () => {}, now: clock, setTimer: () => 0, newId: counter(), getVerdict: spy.getVerdict });
  const parts = tapParts(c);
  return { c, log, parts, spy, entry, lineId, script };
}
async function swarmRun(script) {
  const R = swarmRig(script);
  const res = await R.c.advance({ agentId: R.entry.agentId, dockId: R.entry.dockId, text: 'crew1 findings\nVERDICT: approved', originalText: 'job', lineId: R.lineId, runId: 'r1',
    runAgent: async call => { calls.push(call); R.log.push(call); return script[call.agentId] || { text: call.agentId + ' findings', usd: 0.01, outcome: 'succeeded' }; } });
  return Object.assign(R, { res, writerTurn: (R.log.find(l => l.agentId === 'crew3') || {}).text || '' });
}

// the clean swarm, as the base (45e7ee302) hands it on — taken from base by running this very rig there
const BASE_WRITER_TURN = 'PIPELINE HANDOFF — you are stage 4 of a work line on this station.\n\nThe original request was:\njob\n\nThe upstream stage (crew2) produced:\nJOINED OUTPUT — 3 of 3 branches delivered.\n\n=== BRANCH 1 of 3 — crew1 ===\ncrew1 findings\nVERDICT: approved\n\n=== BRANCH 2 of 3 — crew0 ===\ncrew0 findings\n\n=== BRANCH 3 of 3 — crew2 ===\ncrew2 findings\n\nDo YOUR part of this work and produce the output for the next stage. Your reply is all the next stage receives: hand on the whole work so far with your part done, never only your own addition. Answer with the work itself, not a description of what you would do.';
const BASE_PARTS = [
  { agentId: 'crew1', text: 'crew1 findings\nVERDICT: approved', workitemId: 'id1', dockId: 'p6', branchId: 'p6', runId: 'r1', draft: 'job', verdict: 'approved', files: [] },
  { agentId: 'crew0', text: 'crew0 findings', workitemId: 'id4', dockId: 'p5', branchId: 'p5', runId: null, draft: 'job', verdict: null, files: [] },
  { agentId: 'crew2', text: 'crew2 findings', workitemId: 'id5', dockId: 'p7', branchId: 'p7', runId: null, draft: 'job', verdict: null, files: [] }];

// a walk parked at a barrier that never releases (setTimer never fires) would let node exit with nothing said: that is a failure here
let finished = false;
process.on('exit', () => { if (!finished) { console.error('line-stage-facts.test: FAILED — a walk never settled (the test did not reach its report)'); process.exitCode = 1; } });

(async () => {
  /* ---- 1. THE JOIN: a branch whose only write was refused is not handed on as plain delivered work ---- */
  {
    // (a) the sequential branch: B runs after the entry A and parks itself at the joiner (join-probe scenario 4)
    const R = await joinRun({ text: 'Done - I wrote the file.', usd: 0.01, outcome: 'succeeded', reason: 'done', denied: ['fs.write'], refusals: { denied: ['fs.write'], held: [] } });
    const b = R.parts.find(p => p.agentId === 'B');
    A.eq(b && b.refusals, { denied: ['fs.write'], held: [] }, '1a: B\'s barrier part keeps its refused call');
    A.ok(!('refusals' in (R.parts.find(p => p.agentId === 'A') || {})), '1a: the entry\'s clean part carries no refusals key');
    const notes = noteLines(R.dTurn);
    A.eq(notes, [NOTE + 'B: 1 tool call(s) did not run (refused: fs.write); its text may describe work that did not happen.'], '1a: D\'s turn names B and the refused fs.write: ' + JSON.stringify(notes));
    A.ok(/JOINED OUTPUT — 2 of 2 branches delivered\./.test(R.dTurn) && R.dTurn.includes('Done - I wrote the file.'), '1a: the joined crate itself is unchanged (both branches, B\'s own words)');
    A.eq(R.res.refusals, { parts: 1, calls: 1 }, '1a: the walk says one part with one call that did not run');
    A.eq(R.res.stopped, null, '1a: the line still runs to its end (no verdict, stop or PARTIAL is invented)');
    A.ok(!R.res.partial, '1a: a refusal is not a PARTIAL join');
  }
  {
    // (b) the PARALLEL batch: crew2 (the last branch, ending on a verdict line) had a write refused and a shell call held
    const R = await swarmRun({ crew2: { text: 'crew2 findings\nVERDICT: approved', usd: 0.01, outcome: 'succeeded', denied: ['fs.write'], refusals: { denied: ['fs.write'], held: ['shell.exec'] } } });
    const c2 = R.parts.find(p => p.agentId === 'crew2'), c0 = R.parts.find(p => p.agentId === 'crew0');
    A.eq(c2 && c2.refusals, { denied: ['fs.write'], held: ['shell.exec'] }, '1b: the batch branch\'s barrier part keeps both facts (batchToBarrier)');
    A.ok(c0 && !('refusals' in c0), '1b: a clean sibling\'s part carries no refusals key');
    const notes = noteLines(R.writerTurn);
    A.eq(notes, [NOTE + 'crew2 (branch p7): 2 tool call(s) did not run (refused: fs.write; held: shell.exec); its text may describe work that did not happen.'],
      '1b: the writer\'s turn names crew2 and both calls: ' + JSON.stringify(notes));
    A.eq(R.res.refusals, { parts: 1, calls: 2 }, '1b: one part, two calls');
    // the verdict of the join is read from the merged payload BEFORE the note is added: it cannot change
    const joinRead = R.spy.seen.filter(x => /^JOINED OUTPUT/.test(x.text));
    A.eq(joinRead.length, 1, '1b: the join reads its verdict once');
    A.ok(joinRead.length === 1 && joinRead[0].text.indexOf(NOTE) < 0, '1b: the join\'s verdict is read from the payload without the note');
    A.eq(joinRead.length === 1 && joinRead[0].v, 'approved', '1b: the joined verdict is the one the merged branches said (approved)');
    for (const n of notes) A.ok(!/approved|revise|blocked/i.test(n) && !/^verdict/i.test(n) && !n.startsWith('[StarNet]'), '1b: the note carries no verdict word and is not a host note: ' + n);
  }
  {
    /* (c) review B2a: a gate's done lane parked a PASSED-ON frame at the joiner as the LAST branch, and that branch had a write refused.
       The note must not run into the frame's REVIEW part: a bare approval at the next verdict gate still hands on the joined work, the
       frame unwrapped in place (as on the pure crate), never the reviewer's "Looks good." */
    const W = 'The draft: rooftop installs grew 34% in 2025, battery attach passed half, permits are the top soft cost.';
    const frame = loopDecision(gate(), ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', W).text;
    A.ok(/^\[LOOP — [^\n]* the reviewer passed the work on without restating it\]/.test(frame), '1c: the branch\'s text is a passed-on frame');
    const R = await joinRun({ text: frame, usd: 0.01, outcome: 'succeeded', reason: 'done', denied: ['fs.write'], refusals: { denied: ['fs.write'], held: [] } });
    const crate = upstreamOf(R.dTurn), pure = (R.spy.seen.find(x => /^JOINED OUTPUT/.test(x.text)) || {}).text || '';
    const notes = noteLines(crate);
    A.ok(crate && /=== BRANCH 2 of 2 — B ===\n\[LOOP — /.test(crate), '1c: the frame is the LAST branch of the crate D was handed');
    A.eq(notes.length, 1, '1c: one note, for B');
    A.eq(crate, underHeader(pure, notes), '1c: the note sits under the JOINED OUTPUT header, ahead of the branches (the crate\'s tail is the frame\'s own)');
    const bare = (g, t) => loopDecision(g, ctxOk, 0, {}, 'Looks good.\nVERDICT: approved', t).text;
    const U = bare(gate({ next: null }), pure);   // the pure crate, its last branch's frame unwrapped in place
    A.ok(U !== 'Looks good.' && U.indexOf(W) > 0 && U.indexOf('without restating it]') < 0, '1c: (the pure crate unwraps: the oracle holds)');
    const out1 = bare(gate({ next: null }), crate);
    A.eq(out1, underHeader(U, notes), '1c: a bare approval out of the line hands on the joined work, the frame unwrapped, the note kept: ' + JSON.stringify(out1.slice(0, 160)));
    const toDock = bare(gate(), crate);
    A.eq(toDock, bare(gate(), pure).replace(U, underHeader(U, notes)), '1c: a bare approval to a dock hands on one frame round the joined work, never "Looks good." alone');
  }
  {
    /* (d) review B2b, through the walk: two refusing branches and a VERDICT line that is the last branch's next-to-last line. On the pure
       crate the three-line tail holds it; two notes at the END pushed it out. The noted crate reads and strips exactly like the pure one. */
    const R = await swarmRun({ crew0: { text: 'crew0 findings', usd: 0.01, outcome: 'succeeded', refusals: { denied: [], held: ['shell.exec'] } },
      crew2: { text: 'crew2 findings\nVERDICT: approved\nSources: the permit office.', usd: 0.01, outcome: 'succeeded', refusals: { denied: ['fs.write'], held: [] } } });
    const crate = upstreamOf(R.writerTurn), pure = (R.spy.seen.find(x => /^JOINED OUTPUT/.test(x.text)) || {}).text || '';
    const notes = noteLines(crate);
    A.eq(notes.length, 2, '1d: two notes (crew0 held, crew2 refused)');
    A.eq(crate, underHeader(pure, notes), '1d: both notes sit under the header');
    A.eq([Verdict.parseVerdict(crate), Verdict.parseVerdict(pure)], ['approved', 'approved'], '1d: parseVerdict reads the noted crate as the pure one');
    A.eq(Verdict.stripVerdict(crate), underHeader(Verdict.stripVerdict(pure), notes), '1d: stripVerdict takes the VERDICT line out of the noted crate as out of the pure one');
  }
  {
    // (e) review B2b, the crate shape alone: THREE notes on a crate whose last line is a VERDICT line
    const pure = P.joinPayload([{ agentId: 'a', text: 'alpha' }, { agentId: 'b', text: 'beta' }, { agentId: 'c', text: 'gamma' }, { agentId: 'd', text: 'delta\nVERDICT: approved' }], []);
    const three = ['a', 'b', 'c'].map(w => NOTE + w + ': 1 tool call(s) did not run (refused: fs.write); its text may describe work that did not happen.');
    const crate = typeof notedCrate === 'function' ? notedCrate(pure, three) : pure + '\n\n' + three.join('\n');
    A.eq(crate, underHeader(pure, three), '1e: three notes go under the header');
    A.eq(Verdict.parseVerdict(crate), Verdict.parseVerdict(pure), '1e: parseVerdict on the noted crate = on the pure one (approved)');
    A.eq(Verdict.stripVerdict(crate), underHeader(Verdict.stripVerdict(pure), three), '1e: stripVerdict leaves no VERDICT line in the work');
    A.eq(typeof notedCrate === 'function' && notedCrate(pure, []), pure, '1e: no notes, the crate byte for byte');
  }

  /* ---- 2. ONE AFTER ANOTHER: the next stage is told, under the upstream text; the answer and the draft are untouched ---- */
  {
    const log = [];
    const c = makeChainRunner({ nextAgent: a => ({ E: 'A', A: 'B' })[a] || null, now: clock, emit: () => {},
      runAgent: async call => { calls.push(call); log.push(call); return call.agentId === 'A' ? { text: 'A did the work.', usd: 0.01, outcome: 'succeeded', refusals: { denied: [], held: ['shell.exec'] } } : { text: 'B final.', usd: 0.01, outcome: 'succeeded' }; } });
    const res = await c.advance({ agentId: 'E', text: 'E brief', originalText: 'do it', runId: 's1' });
    const bCall = log.find(l => l.agentId === 'B') || {};
    const note = NOTE + 'A: 1 tool call(s) did not run (held: shell.exec); its text may describe work that did not happen.';
    A.ok(String(bCall.text).includes('A did the work.\n\n' + note), '2: B\'s turn carries A\'s text with the note under it: ' + JSON.stringify(bCall.text));
    A.eq(bCall.draft, 'A did the work.', '2: the draft handed on is A\'s answer, unchanged');
    A.eq(res.text, 'B final.', '2: the line\'s answer is B\'s own text');
    A.eq(noteLines((log.find(l => l.agentId === 'A') || {}).text), [], '2: the entry\'s hand-off to A carries no note (the entry has no hop facts)');
    // the refusing stage is the LAST one: its answer is returned byte for byte
    const c2 = makeChainRunner({ nextAgent: a => ({ E: 'A' })[a] || null, now: clock, emit: () => {},
      runAgent: async call => { calls.push(call); return { text: 'A did the work.', usd: 0.01, outcome: 'succeeded', refusals: { denied: ['fs.write'], held: [] } }; } });
    const res2 = await c2.advance({ agentId: 'E', text: 'E brief', originalText: 'do it', runId: 's2' });
    A.eq(res2.text, 'A did the work.', '2: a refusing last stage\'s answer (out.text) is not modified');
  }

  /* ---- 3. THE HOP EXECUTOR: a call the Task Brief gate held is a fact on the hop, beside the refused ones ---- */
  {
    const LR = require('../sidecar/routing/line-runner.js');
    const routine = () => ({ config: () => ({ key: 'k', model: 'm' }), system: () => 'S', station: () => null });
    const kinds = {
      channel: LR.profiles.channel({ channel: 'telegram', chatId: '42', config: () => ({ key: 'k', model: 'm' }), persona: () => 'P' }),
      schedule: LR.profiles.schedule(routine()), manual: LR.profiles.manual(routine()),
      steptest: LR.profiles.steptest({ config: () => ({ model: 'm', key: 'k' }), persona: 'P', brief: () => null, dockSystem: p => p, station: () => null, emit: () => {} })
    };
    const runWith = facts => async o => {
      const e = (n, p) => o.emit(n, Object.assign({ agentId: o.agentId, runId: o.runId }, p));
      e('agent.run.start', {});
      if (facts) {
        e('agent.tool_call', { callId: 'c1', name: 'shell_exec' });
        e('agent.tool_result', { callId: 'c1', ok: false, isError: true, summary: TaskIntent.GATE_HELD });
        e('agent.tool_call', { callId: 'c2', name: 'fs_write' });
        e('agent.tool_result', { callId: 'c2', ok: false, isError: true, summary: 'denied' });
        e('agent.tool_call', { callId: 'c3', name: 'shell_exec' });
        e('agent.tool_result', { callId: 'c3', ok: false, isError: true, summary: TaskIntent.GATE_HELD });   // the same name again: kept once
        e('agent.tool_call', { callId: 'c4', name: 'fs_read' });
        e('agent.tool_result', { callId: 'c4', ok: true, isError: false, summary: TaskIntent.GATE_HELD });   // not an error: not a held call
      } else {
        e('agent.tool_call', { callId: 'c1', name: 'fs_read' });
        e('agent.tool_result', { callId: 'c1', ok: true, isError: false, summary: 'ok' });
      }
      e('agent.run.end', { reason: 'done', outcome: 'succeeded', usd: 0 });
      return { reason: 'done', outcome: 'succeeded', text: 'Done - I ran it.', usd: 0 };
    };
    for (const [kind, profile] of Object.entries(kinds)) {
      const hop = await LR.makeLineRunner({ runOnce: runWith(true), newId: () => 'h-' + kind, now: () => 1, runRow: () => null }).hopRunner(profile)({ agentId: 'writer', text: 'work', lineId: 'L1' });
      A.eq(hop.refusals, { denied: ['fs_write'], held: ['shell_exec'] }, '3 ' + kind + ': the hop carries its refused and held calls');
      A.eq(hop.denied, ['fs_write'], '3 ' + kind + ': denied is unchanged (the step test reads it)');
      const clean = await LR.makeLineRunner({ runOnce: runWith(false), newId: () => 'c-' + kind, now: () => 1, runRow: () => null }).hopRunner(profile)({ agentId: 'writer', text: 'work', lineId: 'L1' });
      A.ok(!('refusals' in clean), '3 ' + kind + ': a clean hop carries no refusals key');
      A.eq([hop.stopCode, hop.error, hop.text], [clean.stopCode, clean.error, clean.text], '3 ' + kind + ': the refusals change no stop code, error or text');
      A.eq(hop.stopCode, null, '3 ' + kind + ': a finished run with refused calls still counts (hopVerdict unchanged)');
    }
    // bounded like denied: at most six names
    const many = Array.from({ length: 9 }, (_, i) => 'tool_' + i);
    const capped = await LR.makeLineRunner({ newId: () => 'cap', now: () => 1, runRow: () => null, runOnce: async o => {
      many.forEach((n, i) => { o.emit('agent.tool_call', { runId: o.runId, callId: 'k' + i, name: n }); o.emit('agent.tool_result', { runId: o.runId, callId: 'k' + i, isError: true, summary: TaskIntent.GATE_HELD }); });
      o.emit('agent.run.end', { runId: o.runId, reason: 'done' });
      return { reason: 'done', outcome: 'succeeded', text: 'x' };
    } }).hopRunner(kinds.schedule)({ agentId: 'writer', text: 'work' });
    A.eq(capped.refusals && capped.refusals.held.length, 6, '3: at most six held names are kept, like denied');

    /* (3b) review B1: the Task Brief gate holds a consequential call until brief_proceed and tells the model to make the same call again —
       held, then run, is the NORMAL path of a channel line hop. A call that was made again and ran is no fact of the stage: no refusals,
       no note downstream. One that never ran again still is (liveness). The real channel hop executor, then a real two-stage walk. */
    const seq = steps => async o => {
      const e = (n, p) => o.emit(n, Object.assign({ agentId: o.agentId, runId: o.runId }, p));
      e('agent.run.start', {});
      steps.forEach(([name, result], i) => {
        e('agent.tool_call', { callId: 'q' + i, name });
        e('agent.tool_result', Object.assign({ callId: 'q' + i }, result === 'held' ? { ok: false, isError: true, summary: TaskIntent.GATE_HELD }
          : result === 'denied' ? { ok: false, isError: true, summary: 'denied' } : result === 'error' ? { ok: false, isError: true, summary: 'error' } : { ok: true, isError: false, summary: 'ok' }));
      });
      e('agent.run.end', { reason: 'done', outcome: 'succeeded', usd: 0 });
      return { reason: 'done', outcome: 'succeeded', text: 'Done - I wrote the file.', usd: 0 };
    };
    const hopOf = async steps => LR.makeLineRunner({ runOnce: seq(steps), newId: () => 'b1', now: () => 1, runRow: () => null }).hopRunner(kinds.channel)({ agentId: 'writer', text: 'work', lineId: 'L1' });
    // the hop's result as stage A of E -> A -> B: what B is handed
    const handOn = async hop => {
      const log = [];
      const c = makeChainRunner({ nextAgent: a => ({ E: 'A', A: 'B' })[a] || null, now: clock, emit: () => {},
        runAgent: async call => { calls.push(call); log.push(call); return call.agentId === 'A' ? hop : { text: 'B final.', usd: 0, outcome: 'succeeded' }; } });
      await c.advance({ agentId: 'E', text: 'E brief', originalText: 'do it', runId: 'b1' });
      return noteLines((log.find(l => l.agentId === 'B') || {}).text);
    };
    const retried = await hopOf([['fs_write', 'held'], ['brief_proceed', 'ok'], ['fs_write', 'ok']]);
    A.ok(!('refusals' in retried), '3b: held, brief_proceed, the same call made again and run: no refusals key (' + JSON.stringify(retried.refusals) + ')');
    A.eq(await handOn(retried), [], '3b: ...and no note reaches the next stage');
    const never = await hopOf([['fs_write', 'held'], ['brief_proceed', 'ok'], ['fs_read', 'ok']]);
    A.eq(never.refusals, { denied: [], held: ['fs_write'] }, '3b live: a held call never made again is still a fact');
    A.eq(await handOn(never), [NOTE + 'A: 1 tool call(s) did not run (held: fs_write); its text may describe work that did not happen.'], '3b live: ...and the next stage is told');
    const twice = await hopOf([['fs_write', 'held'], ['fs_write', 'held'], ['brief_proceed', 'ok'], ['fs_write', 'ok']]);
    A.eq(twice.refusals, { denied: [], held: ['fs_write'] }, '3b: two held calls of one tool, one made again: the other still did not run');
    const failedAgain = await hopOf([['fs_write', 'held'], ['brief_proceed', 'ok'], ['fs_write', 'error']]);
    A.eq(failedAgain.refusals, { denied: [], held: ['fs_write'] }, '3b: made again but it failed: still not done');
    const ranFirst = await hopOf([['fs_write', 'ok'], ['fs_write', 'held']]);
    A.eq(ranFirst.refusals, { denied: [], held: ['fs_write'] }, '3b: a call that ran BEFORE the hold settles nothing');
    const allowed = await hopOf([['fs_write', 'denied'], ['fs_write', 'ok']]);
    A.ok(!('refusals' in allowed), '3b: a refused call made again and allowed: no refusals');
    A.eq(allowed.denied, ['fs_write'], '3b: ...while denied (the step test\'s) is unchanged');
  }

  /* ---- LIVENESS: good data from older writers and every producer still passes ---- */
  {
    // a clean parallel batch hands on byte for byte what the base did
    const R = await swarmRun({});
    A.eq(R.writerTurn, BASE_WRITER_TURN, 'live: a clean batch\'s join hand-off is byte-equal to base');
    A.eq(R.parts, BASE_PARTS, 'live: a clean batch\'s barrier parts are key-for-key the base\'s');
    A.ok(!('refusals' in R.res), 'live: a clean walk has no out.refusals');
    // an older producer (a step test's runDock, the hand-off runner, an older host): `denied` alone, no refusals — nothing is added
    const old = await joinRun({ text: 'beta findings', usd: 0.01, outcome: 'succeeded', reason: 'done', denied: ['fs.write'] });
    A.eq(noteLines(old.dTurn), [], 'live: a result with only `denied` (an older producer) adds no note');
    A.ok(!('refusals' in old.res) && !('refusals' in (old.parts.find(p => p.agentId === 'B') || {})), 'live: and no refusals anywhere');
    // a malformed refusals value is ignored, never thrown on
    for (const bad of [null, 'fs.write', { denied: 'fs.write' }, { denied: [], held: [] }, { denied: [42, ''], held: [{}] }]) {
      const m = await joinRun({ text: 'beta findings', usd: 0.01, outcome: 'succeeded', reason: 'done', refusals: bad });
      A.eq([noteLines(m.dTurn).length, m.res.stopped, 'refusals' in m.res], [0, null, false], 'live: a malformed refusals (' + JSON.stringify(bad) + ') adds nothing');
    }
    // a hard-failing branch still yields the PARTIAL header exactly, and no note
    const failed = await joinRun({ text: '', usd: 0.01, error: 'provider 429', stopCode: 'stage_failed', refusals: { denied: ['fs.write'], held: [] } });
    A.ok(failed.dTurn.includes('JOINED OUTPUT — 1 of 2 branches delivered.') && failed.dTurn.includes('=== PARTIAL: 1 branch failed and sent nothing (B failed) ==='), 'live: a failed branch is still marked PARTIAL exactly');
    A.eq(noteLines(failed.dTurn), [], 'live: a failed branch sends nothing, so no note either');
    A.eq(failed.res.partial, 'B failed', 'live: the PARTIAL reason is unchanged');
    // no stage call is ever handed `entry` (entry trust stays with the entry)
    A.ok(calls.length > 20 && calls.every(c => !('entry' in c)), 'live: no sibling or later stage call carries `entry` (' + calls.length + ' calls)');
  }

  /* ---- THE HOLD (the documented gap, tested): a job held at a reviewer's gate after a parallel join whose branch had a write refused is
     saved as a valid continuation in the EXACT saved shapes (no refusals key anywhere: the fact is in memory only), the merged work under
     review keeps its note as text, and after a restart APPROVE delivers it. The station's own store, hold proofs and hop executor (the
     line-hold rig); the refusal reaches the hop as the run's own agent.tool_result 'denied' event. ---- */
  {
    const C = require('../sidecar/routing/line-continuation.js');
    const J = require('../sidecar/routing/linejobs.js');
    const { allocated } = require('./helpers/line-accounting-host.js');
    const { makeRig } = require('./helpers/line-hold-rig.js');
    // (test/line-hold.split.test.js's floor) a planner P -> SPLIT -> A | B (one step each, run at once) -> JOINER -> LOOP gate -> OUTBOX
    const props = [{ id: 'p2', t: 'splitter', x: 7, y: 0, w: 1, h: 1 }, { id: 'p3', t: 'bay', x: 10, y: 0, w: 2, h: 2, agentId: 'A' }, { id: 'p4', t: 'bay', x: 6, y: 4, w: 2, h: 2, agentId: 'B' },
      { id: 'p5', t: 'joiner', x: 13, y: 4, w: 1, h: 1 }, { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'p0', t: 'bay', x: 2, y: 0, w: 2, h: 2, agentId: 'P' },
      { id: 'p7', t: 'loop', x: 16, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, { id: 'p8', t: 'outbox', x: 19, y: 3, w: 2, h: 2 }];
    const belts = [[5, 0, 'E'], [6, 0, 'E'], [7, 0, 'E'], [8, 0, 'E'], [9, 0, 'E'], [7, 1, 'S'], [7, 2, 'S'], [7, 3, 'S'], [12, 0, 'S'], [12, 1, 'S'], [12, 2, 'S'], [12, 3, 'S'], [12, 4, 'E'],
      [8, 5, 'E'], [9, 5, 'E'], [10, 5, 'E'], [11, 5, 'E'], [12, 5, 'E'], [13, 5, 'N'], [13, 4, 'E'], [14, 4, 'E'], [15, 4, 'E'], [1, 0, 'E'], [4, 0, 'E'], [16, 4, 'E'], [17, 4, 'E'], [18, 4, 'E']].map(([x, y, d]) => belt(x, y, d));
    const opts = { floor: { props, belts }, entry: { agentId: 'P', dockId: 'p0' }, agents: ['P', 'A', 'B'], peek: true };
    const refuseB = x => { if (x.agentId !== 'B') return; x.emit('agent.tool_call', { agentId: 'B', runId: x.runId, callId: 'w1', name: 'fs_write' }); x.emit('agent.tool_result', { agentId: 'B', runId: x.runId, callId: 'w1', ok: false, isError: true, summary: 'denied' }); };
    let threw = null;
    try {
      await allocated(async env => {
        const rig = makeRig(opts).wire(env.host);
        rig.reply = x => x.agentId + ' out';
        rig.beforeCall = refuseB;
        const ran = await rig.run({ replies: ['the plan'] });
        rig.settle(ran.job, ran.line);
        const id = ran.job.id, job0 = J.get(env.host.jobs(), id), c0 = job0 && job0.continuation;
        A.ok(ran.line.held && !ran.line.holdFailed, 'hold: the gate after the join holds the job and it is saved: ' + (ran.line.holdFailed || ''));
        const seen = c0 ? C.inspect(c0, job0) : { ok: false };
        A.ok(seen.ok, 'hold: the saved hold is a valid version 1 continuation: ' + (seen.issue && seen.issue.message));
        A.ok(c0 && String(c0.walk.product.text).includes(NOTE + 'B (branch p4): 1 tool call(s) did not run (refused: fs_write)'), 'hold: the merged work under review keeps the note as text');
        A.ok(c0 && JSON.stringify(c0).indexOf('"refusals"') < 0, 'hold: no refusals key reaches the saved record (exact saved shapes)');
        A.eq(ran.line.refusals, { parts: 1, calls: 1 }, 'hold: the walk said one part, one call');
        // RESTART: a new station over the saved file; APPROVE delivers the held work, buying nothing
        const host = env.loadHost(), r2 = makeRig(Object.assign({}, opts, { idBase: 100000, clockBase: 1001000 })).wire(host);
        r2.reply = x => x.agentId + ' out';
        const r = r2.owner(host).resume(id, { action: 'approve', token: 'tok-1', revision: c0.revision, note: '' });
        const out = await r.done, job = J.get(host.jobs(), id);
        A.eq([r2.calls.length, job.status, out.delivered, job.output === c0.walk.product.text], [0, 'delivered', true, true], 'hold: after a restart APPROVE delivers the saved work (note included), buying nothing');
        rig.dispose(); r2.dispose();
      });
    } catch (e) { threw = e; }
    A.ok(!threw, 'hold: the save, the load and the resume threw nothing: ' + (threw && threw.stack));
  }

  finished = true;
  A.report('line-stage-facts.test');
})().catch(e => { console.error(e); process.exit(1); });
