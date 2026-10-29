/* node test/verdict.blocked.test.js — a reviewer's VERDICT: BLOCKED holds the work at its gate (GitHub #122, typed-outcomes
   lane 2026-10-29; the durable hold and its APPROVE/resume are the line-hold lane's).

   The verdict channel knew two words, approved and revise. BLOCKED parsed as nothing, so every verdict-keyed gate read it as
   "not approved" — revise — and sent the work back round; passes later the loop ran out and the work left on the DONE lane
   unapproved, to the OUTBOX, as a product. 'blocked' is now the third canonical verdict (sidecar/routing/verdict.js BLOCKED):
   never a gate key, always a hold. Proven on the real chain runner over the real router and pipeline compiler (no provider):
   BLOCKED at the first pass, in upper case, as markdown, with a trailing line and quoted in a bullet all stop the line at the
   gate with zero further hops, say why, mark the job blocked, and deliver nothing to the OUTBOX. Fake harness, fake clock. */
'use strict';
const A = require('./_assert.js');
const Verdict = require('../sidecar/routing/verdict.js');
const { makeChainRunner, loopDecision } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const LineFire = require('../sidecar/routing/line-fire.js');
const P = require('../frontend/app/pipeline.js');

// 1. the vocabulary: blocked is canonical, never a gate key
for (const t of ['bad\nVERDICT: BLOCKED', 'bad\n**VERDICT: Blocked**', 'bad\nVERDICT: blocked.\n\n', '> VERDICT: block', '- VERDICT: blocker', 'VERDICT: DO-NOT-SHIP']) {
  A.eq(Verdict.parseVerdict(t), 'blocked', JSON.stringify(t) + ' parses as blocked');
}
A.eq(Verdict.parseVerdict('it was blocked last time\nVERDICT: approved'), 'approved', 'the word in prose is not a verdict');
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
function loopFloor() {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return geo([{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
    { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
    { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', maxIter: 2, when: 'approved' },
    { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }], belts);
}
async function run(reviewerText) {
  const plan = P.compileRoutingPlan(loopFloor()), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'fixture: the loop-to-OUTBOX floor deploys');
  const lineId = router.lineOriginFor('drafter', 'p2');
  const events = [], hops = [];
  const c = makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x),
    entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    lastStage: (a, d) => router.chainShipsToOutbox(a, d), onShipped: () => {}, emit: (n, p) => events.push({ n, p }), now: clock,
    getTag: () => 'general', setTimer: () => 0 });
  const res = await c.advance({ agentId: 'reviewer', dockId: 'p3', text: reviewerText, originalText: 'write a post', lineId, runId: 'run-' + T, streamId: 'sample-s' + T,
    runAgent: async h => { hops.push(h.agentId); return { text: h.agentId === 'reviewer' ? reviewerText : 'another draft', usd: 0.01 }; } });
  await new Promise(r => setImmediate(r));
  return { res, hops, outputs: events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output') };
}
(async () => {
  for (const text of ['this must not ship: it leaks the key\nVERDICT: BLOCKED', 'leaks the key\n\n**VERDICT: blocked**\n', '- VERDICT: blocked\n(do not publish)']) {
    const r = await run(text);
    A.eq(r.hops, [], JSON.stringify(text) + ': zero further hops (no paid revise pass, no publish)');
    A.ok(/held there — not sent on, not shipped/.test(String(r.res.stopped || '')), 'the line stops at the gate and says why: ' + r.res.stopped);
    A.ok(typeof r.res.blocked === 'string' && r.res.blocked === r.res.stopped, 'the job is marked blocked');
    A.eq(r.outputs.length, 0, 'nothing reaches the OUTBOX as a product');
    A.ok(!r.res.unapproved && !r.res.loopExhausted, 'never "went on unapproved"');
    A.eq(LineFire.lineFacts(r.res).blocked, r.res.blocked, 'the routine record keeps the blocked fact');
    A.ok(/the work line stopped early — the reviewer at the gate/.test(LineFire.lineStopNote(r.res)), 'the stop note the channel and routine print names the hold');
  }
  // the same floor approves and ships as before
  const ok = await run('good\nVERDICT: approved');
  A.ok(ok.res.stopped === null && ok.outputs.length === 1 && !ok.res.blocked, 'an approved job still ships to its OUTBOX');
  A.report('verdict.blocked.test');
})().catch(e => { console.error(e); process.exit(1); });
