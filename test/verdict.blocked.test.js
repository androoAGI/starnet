/* node test/verdict.blocked.test.js — a reviewer's VERDICT: BLOCKED holds the work at its gate (GitHub #122, typed-outcomes
   lane 2026-10-29; the durable hold and its APPROVE/resume are the line-hold lane's).

   The verdict channel knew two words, approved and revise. BLOCKED parsed as nothing, so every verdict-keyed gate read it as
   "not approved" — revise — and sent the work back round; passes later the loop ran out and the work left on the DONE lane
   unapproved, to the OUTBOX, as a product. 'blocked' is now the third canonical verdict (sidecar/routing/verdict.js BLOCKED):
   never a gate key, always a hold. Proven on the real chain runner over the real router and pipeline compiler (no provider):
   BLOCKED at the first pass, in upper case, as markdown, with a trailing line and quoted in a bullet all stop the line at the
   gate with zero further hops, say why, mark the job blocked, and deliver nothing to the OUTBOX. Fake harness, fake clock.

   Sections 4 to 8 are the matrix the issue asked for, the step-through test, and a FILTER that would carry a blocked job round its gate.

   LINE-HOLD S2: the reading of a reply the gate cannot read is the same hold. A reply with NO usable VERDICT line (none, empty, a word the
   channel does not know) used to read as 'revise' — five paid passes, then the work left on DONE unapproved (section 5 pinned that, on
   purpose). It now holds at once, like BLOCKED, with reason 'missing_verdict' (sections 3 and 5; the family is test/line-hold.policy.test.js).
   THE CONTROL: this file builds its subject through test/helpers/line-hold-control.js. LINE_HOLD_CONTROL=original makes that the saved
   5977d433c source (test/fixtures/line-hold-5977d433c) and the rewritten expectations must go RED there; the policy test runs that control in-process.

   What this does NOT do, pinned below so it stays said: a review that runs out of passes still leaves on DONE marked unapproved unless its
   gate says otherwise (onSpent: test/line-hold.policy.test.js), and a hold is a stop here — the durable hold with its APPROVE / SEND BACK is
   the next steps of the line-hold lane (the walk's out.hold says what it needs). */
'use strict';
const A = require('./_assert.js');
const Control = require('./helpers/line-hold-control.js');
const subject = Control.pick();   // the product; LINE_HOLD_CONTROL=original is the saved 5977d433c source (header)
const Verdict = subject.Verdict;
const { makeChainRunner, loopDecision, heldByBrief } = subject.chain;
const { makeRouter } = require('../sidecar/routing/router.js');
const LineFire = require('../sidecar/routing/line-fire.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const P = require('../frontend/app/pipeline.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 1. the vocabulary: blocked is canonical, never a gate key
for (const t of ['bad\nVERDICT: BLOCKED', 'bad\n**VERDICT: Blocked**', 'bad\nVERDICT: blocked.\n\n', '> VERDICT: block', '- VERDICT: blocker', 'VERDICT: DO-NOT-SHIP']) {
  A.eq(Verdict.parseVerdict(t), 'blocked', JSON.stringify(t) + ' parses as blocked');
}
A.eq(Verdict.parseVerdict('it was blocked last time\nVERDICT: approved'), 'approved', 'the word in prose is not a verdict');
// markdown anywhere in the line, the forms models really write
for (const t of ['**VERDICT:** BLOCKED', 'VERDICT: **BLOCKED**', 'VERDICT: `blocked`', '__VERDICT:__ blocked', '**VERDICT**: *blocked*', '- **VERDICT:** blocked.']) {
  A.eq(Verdict.parseVerdict('it leaks the key\n' + t), 'blocked', JSON.stringify(t) + ' parses as blocked');
}
for (const t of ['VERDICT: DO NOT SHIP', 'VERDICT: do not ship', 'verdict - do not ship until the key is gone']) A.eq(Verdict.parseVerdict(t), 'blocked', JSON.stringify(t) + ' parses as blocked');
A.eq(Verdict.parseVerdict('VERDICT: needs_work'), 'revise', 'one underscore is part of a word');
A.eq(Verdict.parseVerdict('**VERDICT:** approved'), 'approved', 'an approval in the same dress reads as one');
A.eq(Verdict.stripVerdict('the post\n\n**VERDICT:** approved'), 'the post', 'and its control line never ships as work');
A.eq(Verdict.parseVerdict('VERDICT: **not** approved'), null, 'a word the channel does not know is no verdict');
A.eq(Verdict.parseVerdict('VERDICT: Blocking issues: none'), null, 'blocking is an adjective here, not a stop');
A.ok(!Verdict.isVerdictWord('blocked') && Verdict.BLOCKED === 'blocked', 'blocked is never a gate key (a gate waits on approved | revise)');

// 2. the one loop rule: a blocked verdict holds, at any pass, whichever word the gate waits on
for (const when of ['approved', 'revise']) {
  for (const n of [0, 1, 5]) {
    const d = loopDecision({ loop: '12,4', when, max: 2, backTo: 'drafter', next: 'publisher', esc: 'fixer' }, { verdict: 'blocked' }, n, {}, 'no\nVERDICT: blocked');
    A.ok(d.held === true && d.again === false && d.target === null && !d.exhausted, when + ' gate, pass ' + n + ': held — not looped back, not sent on, not escalated');
    A.ok(/VERDICT: blocked, so the work is held/.test(d.why), 'and it says why: ' + d.why);
  }
}
// a tag-keyed gate has no verdict to read: unchanged
A.ok(!loopDecision({ loop: '12,4', when: 'urgent', max: 2, backTo: 'drafter', next: 'publisher' }, { verdict: 'blocked', tag: 'general' }, 0, {}, 'x').held, 'a tag gate is not a verdict gate');

// 3. the real chain runner: INBOX -> drafter -> reviewer -> LOOP (VERDICT: approved, 2 passes) -> OUTBOX
const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });
let T = 0; const clock = () => (T += 10);
function loopFloor(maxIter) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return geo([{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
    { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
    { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', maxIter: maxIter || 2, when: 'approved' },
    { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }], belts);
}
// the same floor with a third, escalation lane from the gate to a second OUTBOX: a human lane with no runnable agent on it
function escalationFloor() {
  const f = loopFloor();
  f.props.find(p => p.t === 'loop').esc = 'S';
  f.belts.push(belt(12, 5, 'S'), belt(12, 6, 'S'));
  f.props.push({ id: 'p7', t: 'outbox', x: 11, y: 7, w: 2, h: 2 });
  return f;
}
// a FILTER between the reviewer and its gate: code work takes the S lane to a second OUTBOX and never meets the gate
function filterFloor() {
  const f = loopFloor();
  f.props.push({ id: 'p8', t: 'filter', x: 11, y: 4, w: 1, h: 1, routes: { code: 'S' }, def: 'E' }, { id: 'p9', t: 'outbox', x: 10, y: 7, w: 2, h: 2 });
  f.belts.push(belt(11, 5, 'S'), belt(11, 6, 'S'));
  return f;
}
// `replies`: the reviewer's words, pass by pass, the first of them the reply the job arrives with
async function walk(replies, floor, tag) {
  let said = 0;
  const reviewerText = replies[said++];
  const plan = P.compileRoutingPlan(floor || loopFloor()), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'fixture: the loop-to-OUTBOX floor deploys');
  const lineId = router.lineOriginFor('drafter', 'p2');
  const events = [], hops = [], shipped = [];
  const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x),
    entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    lastStage: (a, d) => router.chainShipsToOutbox(a, d), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), onShipped: r => shipped.push(r),
    emit: (n, p) => events.push({ n, p }), now: clock, getTag: () => tag || 'general', setTimer: () => 0 });
  const res = await c.advance({ agentId: 'reviewer', dockId: 'p3', text: reviewerText, originalText: 'write a post', lineId, runId: 'run-' + T, streamId: 'sample-s' + T,
    runAgent: async h => { hops.push(h.agentId); return { text: h.agentId === 'reviewer' ? replies[Math.min(said++, replies.length - 1)] : 'another draft', usd: 0.01 }; } });
  await new Promise(r => setImmediate(r));
  return { res, hops, shipped, outputs: events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output') };
}
const run = text => walk([text]);
const count = (r, who) => r.hops.filter(h => h === who).length;
(async () => {
  for (const text of ['this must not ship: it leaks the key\nVERDICT: BLOCKED', 'leaks the key\n\n**VERDICT: blocked**\n', '- VERDICT: blocked\n(do not publish)']) {
    const r = await run(text);
    A.eq(r.hops, [], JSON.stringify(text) + ': zero further hops (no paid revise pass, no publish)');
    A.ok(/held there — not sent on, not shipped/.test(String(r.res.stopped || '')), 'the line stops at the gate and says why: ' + r.res.stopped);
    A.ok(typeof r.res.blocked === 'string' && r.res.blocked === r.res.stopped, 'the job is marked blocked');
    A.eq(r.outputs.length, 0, 'nothing reaches the OUTBOX as a product');
    A.eq(r.shipped.length, 0, 'and no SEND TO starts from it');
    A.ok(!r.res.unapproved && !r.res.loopExhausted, 'never "went on unapproved"');
    A.eq(LineFire.lineFacts(r.res).blocked, r.res.blocked, 'the routine record keeps the blocked fact');
    A.ok(/the work line stopped early — the reviewer at the gate/.test(LineFire.lineStopNote(r.res)), 'the stop note the channel and routine print names the hold');
  }
  // the same floor approves and ships as before
  const ok = await run('good\nVERDICT: approved');
  A.ok(ok.res.stopped === null && ok.outputs.length === 1 && !ok.res.blocked, 'an approved job still ships to its OUTBOX');

  // 4. BLOCKED at pass 0, 1 and 5 of a five-pass gate, on the real runner: what the passes before it bought stands, nothing after it does
  for (const n of [0, 1, 5]) {
    const r = await walk([...Array(n).fill('not yet\nVERDICT: revise'), 'stop\nVERDICT: BLOCKED'], loopFloor(5));
    A.eq(r.hops.length, n * 2, 'BLOCKED after ' + n + ' passes: no further hop');
    A.ok(r.res.blocked && r.outputs.length === 0 && !r.res.unapproved, 'BLOCKED after ' + n + ' passes: held, nothing shipped');
  }
  // the verdict that counts is the last one in the tail, and only the tail
  const blockedLast = await run('VERDICT: approved\nVERDICT: blocked');
  A.ok(blockedLast.res.blocked && blockedLast.outputs.length === 0, 'a later BLOCKED beats an earlier approval');
  const approvedLast = await run('VERDICT: blocked\nnow fixed\nVERDICT: approved');
  A.ok(!approvedLast.res.blocked && approvedLast.outputs.length === 1, 'a later approval beats an earlier BLOCKED: last word wins');
  const quotedAbove = await run('the last reviewer wrote\nVERDICT: BLOCKED\nthat is fixed\nline\nline\nVERDICT: approved');
  A.ok(!quotedAbove.res.blocked && quotedAbove.outputs.length === 1, 'BLOCKED quoted above the tail holds nothing');
  // ...and a reply whose only BLOCKED is quoted above the tail has NO verdict of its own: that is a hold too, but for what it is — no usable
  // verdict (S2) — never as the quoted BLOCKED, and never "goes round like any other" (five paid passes, the old reading)
  const quotedNoVerdict = await walk(['the last reviewer wrote\nVERDICT: BLOCKED\none\ntwo\nthree', 'ok\nVERDICT: approved']);
  A.ok(quotedNoVerdict.res.hold && quotedNoVerdict.res.hold.reason === 'missing_verdict' && count(quotedNoVerdict, 'drafter') === 0 && quotedNoVerdict.outputs.length === 0 && !quotedNoVerdict.res.unapproved,
    'with no verdict of its own the reply holds as a missing verdict: no paid pass, nothing delivered (' + JSON.stringify(quotedNoVerdict.res.hold) + ')');

  // 5. no sixth pass, and no approval by running out. A gate's maxIter counts the trips back, so five revisions, then the gate lets go.
  // THE LIMIT, on purpose, for a reviewer that keeps SAYING revise: it leaves on DONE marked unapproved, and BLOCKED is what stops it.
  {
    const r = await walk(Array(20).fill('no\nVERDICT: revise'), loopFloor(5));
    A.eq(count(r, 'drafter'), 5, 'revise: five trips back, no sixth');
    A.ok(/used all 5 passes without VERDICT: approved/.test(String(r.res.unapproved)) && r.res.loopExhausted, 'revise: never reads as approved');
    A.ok(r.outputs.length === 1 && /used all 5 passes/.test(String(r.outputs[0].p.unapproved)) && !r.res.blocked, 'revise: the OUTBOX row says unapproved');
  }
  // A reviewer that says NOTHING usable is not "revise": the gate cannot tell what it was asked, so the job HOLDS for a person at once — not one
  // paid pass, nothing delivered, not even marked unapproved (it did not go on). (S2; this section used to pin five trips back and an OUTBOX row.)
  for (const [what, reply] of [['a missing verdict', 'looks like a draft to me'], ['a malformed verdict', 'hmm\nVERDICT: maybe'], ['an empty reply', '']]) {
    const r = await walk(Array(20).fill(reply), loopFloor(5));
    A.eq(count(r, 'drafter'), 0, what + ': held at once — not one paid pass, not five');
    A.ok(r.res.hold && r.res.hold.reason === 'missing_verdict' && r.res.hold.pass === 0 && r.res.hold.gateId === '12,4', what + ': out.hold says why, where and on which pass: ' + JSON.stringify(r.res.hold));
    A.ok(typeof r.res.blocked === 'string' && r.res.blocked === r.res.stopped && /gave no usable VERDICT line, so the work is held there — not sent on, not shipped/.test(r.res.stopped), what + ': stopped as a hold, in words: ' + r.res.stopped);
    A.ok(r.outputs.length === 0 && r.shipped.length === 0 && !r.res.unapproved && !r.res.loopExhausted, what + ': nothing reaches the OUTBOX, no SEND TO, never "went on unapproved"');
    A.eq(LineFire.lineFacts(r.res).blocked, r.res.blocked, what + ': the routine record keeps the blocked fact');
  }
  // what the passes before it bought stands; nothing after it does (a reviewer that lapses, at pass 0, 1 and 4 of five)
  for (const n of [0, 1, 4]) {
    const r = await walk([...Array(n).fill('not yet\nVERDICT: revise'), 'looks fine to me'], loopFloor(5));
    A.eq(r.hops.length, n * 2, 'a lapse after ' + n + ' passes: the passes it bought stand, none after');
    A.ok(r.res.hold && r.res.hold.reason === 'missing_verdict' && r.res.hold.pass === n && r.outputs.length === 0, 'a lapse after ' + n + ' passes: held on pass ' + n);
  }

  // 6. the gate's lanes do not change a hold: an escalation lane to a human OUTBOX, wired or not, gets nothing
  for (const esc of [null, 'fixer']) {
    const d = loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: null, esc }, { verdict: 'blocked' }, 2, {}, 'x\nVERDICT: blocked');
    A.ok(d.held && d.target === null, 'at the last pass, escalation ' + (esc ? 'wired' : 'not wired') + ': held, not escalated');
  }
  for (const esc of [null, 'fixer']) {
    const d = loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: null, esc }, { verdict: null }, 2, {}, 'x');
    A.ok(d.held && d.reason === 'missing_verdict' && d.target === null, 'at the last pass, escalation ' + (esc ? 'wired' : 'not wired') + ', no verdict: held, not escalated');
  }
  const wired = await walk(['stop\nVERDICT: blocked'], escalationFloor());
  A.ok(wired.res.blocked && wired.hops.length === 0 && wired.outputs.length === 0, 'a real floor with a human OUTBOX on the escalation lane: held, nothing delivered to either OUTBOX');
  const wiredSilent = await walk(['no verdict at all'], escalationFloor());
  A.ok(wiredSilent.res.hold && wiredSilent.res.hold.reason === 'missing_verdict' && wiredSilent.hops.length === 0 && wiredSilent.outputs.length === 0, 'the same floor, a reply with no verdict: held, nothing delivered to either OUTBOX');
  // a FILTER would carry this job round the gate: the reply reads as code work, so the walk never meets the gate that reads its verdict
  const routedRound = await walk(['the key in this function leaks\nVERDICT: blocked'], filterFloor(), 'code');
  A.ok(routedRound.res.blocked && routedRound.outputs.length === 0 && routedRound.shipped.length === 0, 'told its verdict decides the gate, it is held even when a FILTER would route it past');
  const routedOk = await walk(['clean\nVERDICT: approved'], filterFloor(), 'code');
  A.ok(!routedOk.res.blocked && routedOk.outputs.length === 1, 'and an approved job still takes the FILTER as it always did');

  // 7. the step-through test ends at the same gate, and a FILTER cannot carry it past there either
  for (const [what, floor, tag, said, words] of [['at the gate', loopFloor(), 'general', 'stop\nVERDICT: blocked', /VERDICT: blocked, so the work is held/],
    ['past a FILTER', filterFloor(), 'code', 'stop\nVERDICT: blocked', /VERDICT: blocked, so the work is held/],
    ['at the gate, no verdict', loopFloor(), 'general', 'looks fine to me', /gave no usable VERDICT line, so the work is held/]]) {
    const plan = P.compileRoutingPlan(floor), router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'fixture: the step-through floor deploys');
    const calls = [];
    const st = makeStepTest({
      runDock: async h => { calls.push(h.agentId); return { runId: 'r' + calls.length, tools: 1, usd: 0.01, text: h.agentId === 'reviewer' ? said : 'a draft' }; },
      now: clock, getTag: () => tag, label: a => a.toUpperCase(),
      plan: { get: () => router.getPlan(), step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
        entryDock: (line, text) => { const a = router.resolveTarget({ tag: 'general', text, lineId: line }); return a && router.lineOriginFor(a) === line ? a : null; },
        lineOf: a => router.lineOfAgent(a), stageBrief: a => router.stageBrief(a), loopGateAfter: (a, l) => router.loopGateAfter(a, l),
        lineLimits: l => router.lineLimits(l), shipsToOutbox: a => router.chainShipsToOutbox(a) } });
    const started = st.start({ line: P.lineOf(plan, 'drafter'), text: 'a job', pause: 'none' });
    const id = started.session.id;
    let s = null;
    for (let i = 0; i < 50; i++) { await st.settled(id); s = st.get(id).session; if (s.state !== 'running') break; }
    A.eq(calls, ['drafter', 'reviewer'], what + ': the step-through stops: no pass back, nothing past it');
    A.ok(words.test(JSON.stringify(s)), what + ': and its session says why');
  }

  // 8. the reviewer is told, and the help text says what the runner does
  for (const when of ['approved', 'revise']) for (const handsOn of [true, false]) {
    const b = Verdict.verdictBrief(when, handsOn);
    A.ok(/"VERDICT: blocked" when it must stop for a person/.test(b) && b.length <= 600, 'the brief offers BLOCKED and fits the handoff: ' + when + ', ' + handsOn + ', ' + b.length);
    A.ok(/A reply with no VERDICT line holds the work for a person\./.test(b) && !/treated as/.test(b), 'and says what silence means now — a hold, not "' + (when === 'approved' ? 'revise' : 'approved') + '": ' + when + ', ' + handsOn);
  }
  const gateOf = g => () => g;
  A.eq(heldByBrief(gateOf({ loop: '1,1', when: 'approved' }), 'r', 'L', 'd', 'blocked'), Verdict.heldWhy('1,1'), 'heldByBrief: a verdict gate holds');
  A.eq(heldByBrief(gateOf({ loop: '1,1', when: 'revise' }), 'r', 'L', null, 'blocked'), Verdict.heldWhy('1,1'), 'heldByBrief: either verdict word');
  A.eq(heldByBrief(gateOf({ loop: '1,1', when: 'approved' }), 'r', 'L', 'd', 'approved'), null, 'heldByBrief: any other verdict moves on as it did');
  A.eq(heldByBrief(gateOf({ loop: '1,1', when: 'urgent' }), 'r', 'L', 'd', 'blocked'), null, 'heldByBrief: a tag gate reads no verdict');
  A.eq(heldByBrief(gateOf(null), 'r', 'L', 'd', 'blocked'), null, 'heldByBrief: with no gate on the lane there is nothing to hold at');
  A.eq(heldByBrief(null, 'r', 'L', 'd', 'blocked'), null, 'heldByBrief: a runner with no gate reader falls to the walk');
  const asked = []; heldByBrief((...a) => { asked.push(a); return null; }, 'r', 'L', 'dock7', 'blocked');
  A.eq(asked[0], ['r', 'L', 'dock7'], 'heldByBrief: asks about the bay that ran, as the brief did');
  A.ok(/VERDICT: blocked stops the job here, and so does a reply with no VERDICT line: the work is held for a person/.test(read('frontend/app/build.js')) && !/no verdict = round again/.test(read('frontend/app/build.js')), 'the gate\'s help text says what the runner does');
  A.eq(Verdict.heldWhy('1,1', 'missing_verdict'), 'the reviewer at the gate 1,1 gave no usable VERDICT line, so the work is held there — not sent on, not shipped', 'heldWhy: the missing-verdict hold has its own sentence');
  A.report('verdict.blocked.test');
})().catch(e => { console.error(e); process.exit(1); });
