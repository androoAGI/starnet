/* node test/line-hold.policy.test.js — the GATE POLICY of the line-hold lane (S2): what a verdict-keyed LOOP gate does with a reply it
   cannot read, and with passes that ran out.

   THE CLASS (invariant no-verdict-holds-with-zero-spend). A verdict-keyed gate waits on approved | revise. Until 5977d433c a reply with
   NO usable VERDICT line (none, empty, a word the channel does not know) read as 'revise': five paid passes round the gate, then the
   work left on DONE marked unapproved (GitHub #122's twin of BLOCKED). Now it HOLDS, like BLOCKED, for a person: reason
   'missing_verdict', zero hops after it, at any pass, whatever the gate's lanes. Proven here over the whole family on the REAL chain runner
   over the REAL router and compiler (fake harness, fake clock, no provider):

     verdict-keyed gate (approved | revise)  x  reply (missing, malformed, empty)  x  pass the gate is on (0, 1, 5)
       x  lane wiring (esc unwired, esc to a dock, esc to an OUTBOX only, a human OUTBOX beside a downstream dock)

   and the pure rule (loopDecision) over a wider grid of replies, passes, policies and lanes. Everything the change did NOT touch is
   proven unchanged by running the ORIGINAL decision beside it: a tag gate, a no-gate line, a clean approved / revise verdict, a gate
   that sets no policy.

   THE POLICY (onSpent, compiled from the LOOP prop): absent / 'send' = a gate always ran (work goes on marked unapproved, or to the
   escalation dock); 'hold' = stop for a person with reason 'spent'; 'escalate' = the escalation lane — a dock, or an OUTBOX the lane
   only reaches (escOutbox), where the crate ENDS marked unapproved with no agent invented; with no lane to take, a hold.

   THE CONTROL. The same battery runs on the original chain.js / line-verdict.js (test/fixtures/line-hold-5977d433c, byte-exact, via
   test/helpers/line-hold-control.js) and must stay RED there, case for case: a test that cannot fail on the old code proves nothing. */
'use strict';
const A = require('./_assert.js');
const Control = require('./helpers/line-hold-control.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const LineFire = require('../sidecar/routing/line-fire.js');
const P = require('../frontend/app/pipeline.js');

const product = Control.product(), original = Control.original();
const belt = (x, y, dir) => ({ x, y, dir });
let T = 0; const clock = () => (T += 10);

/* ---- the floors: INBOX -> drafter -> reviewer -> LOOP gate (done E, back N to the drafter), wired four ways ---- */
function baseBelts() {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return belts;
}
const WIRINGS = ['esc unwired', 'esc to a dock', 'esc to an OUTBOX only', 'human OUTBOX beside a downstream dock'];
function floor(wiring, gate) {
  const belts = baseBelts();
  const props = [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
    { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
    Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 }, gate || {})];
  // the done lane: straight to an OUTBOX, or to a downstream dock (the publisher)
  props.push(wiring === 'human OUTBOX beside a downstream dock' ? { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' } : { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 });
  if (wiring !== 'esc unwired') props.find(p => p.t === 'loop').esc = 'S';
  if (wiring === 'esc to a dock') { props.push({ id: 'p9', t: 'bay', x: 14, y: 6, w: 2, h: 2, agentId: 'fixer' }); belts.push(belt(12, 5, 'S'), belt(12, 6, 'E'), belt(13, 6, 'E')); }
  if (wiring === 'esc to an OUTBOX only' || wiring === 'human OUTBOX beside a downstream dock') {
    props.push({ id: 'p7', t: 'outbox', x: 11, y: 7, w: 2, h: 2 }); belts.push(belt(12, 5, 'S'), belt(12, 6, 'S'));
  }
  return { props, belts };
}

/* walk(impl, geo, replies, o): INBOX -> drafter -> reviewer is the entry (replies[0] arrives with the job), every later reviewer turn
   answers the next reply (the last one repeats); every other dock answers 'another draft'. Returns what the walk did. */
async function walk(impl, geo, replies, o) {
  o = o || {};
  let said = 0;
  const first = replies[said++];
  const plan = P.compileRoutingPlan(geo), router = makeRouter();
  const set = router.setPlan(plan);
  if (!set.ok) throw new Error('fixture: the floor does not deploy: ' + JSON.stringify(plan.errors));
  const lineId = router.lineOriginFor('drafter', 'p2');
  const events = [], hops = [], shipped = [], notes = [];
  const c = impl.chain.makeChainRunner({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x),
    entryDockOf: a => router.entryDockOf(a), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    lastStage: (a, d) => router.chainShipsToOutbox(a, d), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), onShipped: r => shipped.push(r),
    daySpend: { spentToday: () => 0, note: (l, usd) => notes.push(usd) },
    emit: (n, p) => events.push({ n, p }), now: clock, getTag: () => o.tag || 'general', setTimer: () => 0 });
  const res = await c.advance({ agentId: 'reviewer', dockId: 'p3', text: first, originalText: 'write a post', lineId, runId: 'run-' + T, streamId: 'policy-s' + T,
    runAgent: async h => { hops.push(h.agentId); return { text: h.agentId === 'reviewer' ? replies[Math.min(said++, replies.length - 1)] : (h.agentId === 'fixer' ? 'salvaged by the fixer' : 'another draft'), usd: 0.01 }; } });
  await new Promise(r => setImmediate(r));
  return { res, hops, shipped, notes, plan, router, lineId, events, outputs: events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output') };
}

/* ---- 1. THE FAMILY: a reply the gate cannot read holds, at any pass, whatever the lanes — run on `impl`, failures collected ---- */
const REPLIES = [['missing', 'looks fine to me, ship it'], ['malformed', 'hmm\nVERDICT: maybe'], ['empty', '']];
async function noVerdictBattery(impl) {
  const fails = []; let cases = 0;
  const expect = (cond, label) => { if (!cond) fails.push(label); };
  for (const wiring of WIRINGS) for (const when of ['approved', 'revise']) for (const [kind, reply] of REPLIES) for (const k of [0, 1, 5]) {
    if (kind === 'empty' && k > 0) continue;   // an empty reply from a HOP is a failed stage (stage_empty), not a verdict question: proven in section 2
    const word = when === 'approved' ? 'revise' : 'approved';   // the verdict that sends the work round this gate
    const replies = [...Array(k).fill('not yet\nVERDICT: ' + word), reply];
    const label = [wiring, when + ' gate', kind + ' reply', 'after ' + k + ' pass' + (k === 1 ? '' : 'es')].join(' / ');
    const r = await walk(impl, floor(wiring, { when, maxIter: 6 }), replies);
    cases++;
    const res = r.res, hold = res.hold;
    expect(r.hops.length === 2 * k, label + ': ' + r.hops.length + ' hops, the ' + k + ' passes before the reply bought ' + (2 * k));   // a paid hop AFTER the reply is read is the failure
    expect(!!hold && hold.reason === 'missing_verdict' && hold.gateId === '12,4' && hold.pass === k, label + ': out.hold ' + JSON.stringify(hold));
    expect(res.stop && res.stop.code === 'blocked' && res.blocked === res.stopped && res.stopped === impl.Verdict.heldWhy('12,4', 'missing_verdict'), label + ': stopped as a hold: ' + res.stopped);
    expect(hold && hold.why === res.stopped, label + ': hold.why is the stop\'s one sentence');
    expect(!res.unapproved && !res.loopExhausted && !res.outboxId, label + ': never "went on unapproved", never an OUTBOX');
    expect(r.outputs.length === 0 && r.shipped.length === 0, label + ': nothing delivered, no SEND TO');
    expect(r.notes.length === r.hops.length, label + ': the day ledger heard of ' + r.hops.length + ' hops, not ' + r.notes.length);   // the hold itself costs nothing
  }
  return { fails, cases };
}

(async () => {
  const live = await noVerdictBattery(product);
  A.eq(live.fails, [], 'THE FAMILY on the product: every unreadable reply holds with zero spend (' + live.cases + ' cases)');
  A.ok(live.cases === 4 * 2 * 3 * 3 - 4 * 2 * 2, 'the battery really is the whole family (' + live.cases + ' cases)');

  /* ---- 2. what a HOP's empty reply does is unchanged: it is a failed stage, and buys nothing more ---- */
  for (const impl of [product, original]) {
    const r = await walk(impl, floor('esc unwired', { maxIter: 6 }), ['not yet\nVERDICT: revise', '']);
    A.eq(r.hops, ['drafter', 'reviewer'], impl.label + ': an empty hop reply stops the line after that hop');
    A.ok(r.res.stop && r.res.stop.code === 'stage_empty' && !r.res.hold, impl.label + ': as stage_empty, not a hold: ' + JSON.stringify(r.res.stop));
  }

  /* ---- 3. the pure rule over a wider grid: reply x pass x policy x lanes ---- */
  const lanesOf = [['esc unwired', {}], ['esc to a dock', { esc: 'fixer' }], ['esc to an OUTBOX only', { escOutbox: 'p7' }], ['both', { esc: 'fixer', escOutbox: 'p7' }]];
  const unreadable = [null, undefined, '', 'maybe', 'APPROVED', 'Revise', ' approved', 0, 7, {}, [], 'blocked-ish', false];
  let grid = 0;
  for (const when of ['approved', 'revise', 'APPROVED']) A.ok(product.Verdict.isVerdictWord(when), when + ' is a verdict-keyed gate (its key is read in any case, as it always was)');
  for (const when of ['approved', 'revise', 'APPROVED']) for (const verdict of unreadable) for (const n of [0, 1, 2, 5, 20]) for (const [wiring, lanes] of lanesOf) for (const onSpent of [undefined, 'send', 'hold', 'escalate', 'banana']) {
    const step = Object.assign({ loop: '12,4', when, max: 2, backTo: 'drafter', next: 'publisher' }, lanes, onSpent === undefined ? {} : { onSpent });
    const d = product.chain.loopDecision(step, { verdict, tag: 'general' }, n, { fixer: n === 20 }, 'the reviewer said this');
    grid++;
    A.ok(d.held === true && d.reason === 'missing_verdict' && d.again === false && d.target === null && d.exhausted === false, [when, JSON.stringify(verdict), 'n=' + n, wiring, onSpent].join(' / ') + ': held, not looped, not sent, not escalated');
    A.ok(d.gateId === '12,4' && d.pass === n && d.text === 'the reviewer said this' && d.why === product.Verdict.heldWhy('12,4', 'missing_verdict') && !d.outboxId, [when, JSON.stringify(verdict), n, wiring, onSpent].join(' / ') + ': gate, pass, text and sentence ride out');
  }
  A.ok(grid > 2000, 'the grid is wide (' + grid + ' decisions)');
  // BLOCKED holds as it did, with its own reason, whatever the policy
  for (const onSpent of [undefined, 'hold', 'escalate']) for (const [, lanes] of lanesOf) {
    const d = product.chain.loopDecision(Object.assign({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher', onSpent }, lanes), { verdict: 'blocked' }, 2, {}, 'no\nVERDICT: blocked');
    A.ok(d.held === true && d.reason === 'blocked' && d.why === 'the reviewer at the gate 12,4 answered VERDICT: blocked, so the work is held there — not sent on, not shipped', 'BLOCKED still holds as BLOCKED: ' + d.why);
  }

  /* ---- 4. NOTHING ELSE MOVED: the product and the original decide alike on everything that is not an unreadable verdict or a hold/escalate policy ---- */
  let same = 0;
  for (const when of ['approved', 'revise', 'code', null]) for (const n of [0, 1, 2, 3]) for (const [, lanes] of lanesOf) for (const next of ['publisher', null]) for (const reviewed of ['', 'THE DRAFT'])
    for (const onSpent of [undefined, 'send', 'banana']) for (const verdict of ['approved', 'revise', null]) {
      if (['approved', 'revise'].includes(when) && !['approved', 'revise'].includes(verdict)) continue;   // an unreadable verdict is what changed
      const step = Object.assign({ loop: '12,4', when, max: 2, backTo: 'drafter', next }, lanes, onSpent === undefined ? {} : { onSpent });
      const ctx = { verdict, tag: when === 'code' ? 'code' : 'general' };
      const a = product.chain.loopDecision(step, ctx, n, { fixer: n === 3 }, 'the reply\nVERDICT: ' + verdict, reviewed);
      const b = original.chain.loopDecision(step, ctx, n, { fixer: n === 3 }, 'the reply\nVERDICT: ' + verdict, reviewed);
      same++;
      A.eq(a, b, 'unchanged: ' + [when, 'n=' + n, JSON.stringify(lanes), next, reviewed, onSpent, verdict].join(' / '));
    }
  A.ok(same > 1000, 'the unchanged grid is wide (' + same + ' decisions)');

  /* ---- 5. onSpent THROUGH THE COMPILER: the prop field becomes the step's policy, and only when set ---- */
  {
    const plain = P.compileRoutingPlan(floor('esc to an OUTBOX only'));
    const lineId = P.lineOf(plain, 'reviewer');
    for (const [label, gate, want] of [['absent', {}, undefined], ['send', { onSpent: 'send' }, undefined], ['junk', { onSpent: 'banana' }, undefined], ['hold', { onSpent: 'hold' }, 'hold'], ['escalate', { onSpent: 'escalate' }, 'escalate']]) {
      const plan = P.compileRoutingPlan(floor('esc to an OUTBOX only', gate));
      const st = P.chainStepDock(plan, 'p3', { lineId }), ag = P.chainStep(plan, 'reviewer', { lineId });
      A.eq(plan.junctions['12,4'].onSpent, want, label + ': the junction carries it only when it is hold | escalate');
      A.eq(st.onSpent, want, label + ': the dock step carries it'); A.eq(ag.onSpent, want, label + ': and the agent reading');
      A.eq(st.escOutbox, 'p7', label + ': the OUTBOX-only escalation lane names its OUTBOX'); A.eq(ag.escOutbox, 'p7', label + ': in the agent reading too');
      A.ok(!('onSpent' in st) === (want === undefined), label + ': no key at all when unset (every older floor\'s step is what it was)');
      if (want === undefined) A.eq(plan.hash, plain.hash, label + ': an unset policy leaves the plan hash alone');
      const router = makeRouter();
      A.ok(router.setPlan(plan).ok, label + ': deploys');
      A.eq(router.loopGateAfter('reviewer', lineId).onSpent, want, label + ': router.loopGateAfter reports it');
    }
    A.ok(P.compileRoutingPlan(floor('esc to an OUTBOX only', { onSpent: 'hold' })).hash !== plain.hash, 'a gate that changes its policy is a different plan (a hold is judged against the plan it was made on)');
    // the esc lane: a dock wins, an OUTBOX-only lane is named, a missing lane names nothing
    const wired = {};
    for (const w of WIRINGS) { const pl = P.compileRoutingPlan(floor(w)); wired[w] = pl; }
    A.eq(wired['esc unwired'].gateDocks['12,4'], { backTo: 'p2', escTo: null }, 'no esc lane: no escTo, no escOutbox');
    A.eq(wired['esc to a dock'].gateDocks['12,4'], { backTo: 'p2', escTo: 'p9' }, 'esc to a dock: escTo names it, no escOutbox');
    A.eq(wired['esc to an OUTBOX only'].gateDocks['12,4'], { backTo: 'p2', escTo: null, escOutbox: 'p7' }, 'esc to an OUTBOX only: escTo stays null, escOutbox names the OUTBOX');
    A.eq(wired['esc to an OUTBOX only'].junctions['12,4'].escTo, null, 'the hashed junction is as it was (null)');
    for (const w of WIRINGS) {   // a plan persisted before the dock layer existed derives the very same gates
      const bare = Object.assign({}, wired[w]); for (const k of ['dockChains', 'gateDocks', 'bayTileToDock', 'agentOfDock', 'entryDock', 'docksOfAgent', 'reachDock', 'lineOfDock']) delete bare[k];
      A.eq(P.dockLayer(bare).gateDocks, wired[w].gateDocks, w + ': a derived dock layer reads the same gates');
    }
  }

  /* ---- 6. THE POLICY ON THE REAL CHAIN: a gate whose passes run out ---- */
  const revise = ['no\nVERDICT: revise'];
  const HOLD_WHY = product.Verdict.heldWhy('12,4', 'spent');
  {   // hold: stop for a person at the cap, nothing more bought, nothing delivered
    for (const w of WIRINGS) {
      const r = await walk(product, floor(w, { onSpent: 'hold' }), revise);
      A.eq(r.hops, ['drafter', 'reviewer', 'drafter', 'reviewer'], w + ' / hold: the two passes were paid for, nothing after');
      A.ok(r.res.hold && r.res.hold.reason === 'spent' && r.res.hold.pass === 2 && r.res.hold.gateId === '12,4' && r.res.stopped === HOLD_WHY && r.res.blocked === HOLD_WHY, w + ' / hold: held with reason spent: ' + JSON.stringify(r.res.hold));
      A.ok(!r.res.unapproved && !r.res.loopExhausted && r.outputs.length === 0 && r.shipped.length === 0 && r.notes.length === 4, w + ' / hold: nothing delivered, the ledger heard of the four hops only');
    }
  }
  {   // send (absent, or named): a gate always ran — the work goes on marked unapproved; the escalation DOCK is still taken
    for (const onSpent of [undefined, 'send']) {
      const gate = onSpent ? { onSpent } : {};
      const unwired = await walk(product, floor('esc unwired', gate), revise);
      A.ok(unwired.res.stopped === null && unwired.res.loopExhausted && /used all 2 passes without VERDICT: approved/.test(unwired.res.unapproved) && unwired.outputs.length === 1 && unwired.outputs[0].p.outboxId === 'p6', (onSpent || 'absent') + ' / unwired: on down the done lane, marked unapproved');
      const dock = await walk(product, floor('esc to a dock', gate), revise);
      A.eq(dock.hops, ['drafter', 'reviewer', 'drafter', 'reviewer', 'fixer'], (onSpent || 'absent') + ' / dock: the escalation dock runs as it always did');
      const outboxOnly = await walk(product, floor('esc to an OUTBOX only', gate), revise);
      A.ok(outboxOnly.res.stopped === null && outboxOnly.res.outboxId === 'p6' && outboxOnly.outputs.length === 1 && outboxOnly.outputs[0].p.outboxId === 'p6' && /unapproved/.test(outboxOnly.res.unapproved), (onSpent || 'absent') + ' / OUTBOX-only esc: the default policy leaves on the DONE lane, as it always did');
    }
  }
  {   // escalate
    const dock = await walk(product, floor('esc to a dock', { onSpent: 'escalate' }), revise);
    A.ok(dock.hops.join() === 'drafter,reviewer,drafter,reviewer,fixer' && dock.res.stopped === null && dock.res.text === 'salvaged by the fixer' && dock.res.loopExhausted, 'escalate / dock: the fixer has the last word');
    const ob = await walk(product, floor('esc to an OUTBOX only', { onSpent: 'escalate' }), revise);
    A.eq(ob.hops, ['drafter', 'reviewer', 'drafter', 'reviewer'], 'escalate / OUTBOX only: no hop for the escalation — no agent invented');
    A.ok(ob.res.stopped === null && ob.res.outboxId === 'p7' && ob.res.loopExhausted, 'escalate / OUTBOX only: the crate ends at the escalation OUTBOX, not the done lane\'s: ' + ob.res.outboxId);
    A.ok(/escalation OUTBOX unapproved/.test(ob.res.unapproved) && /used all 2 passes without VERDICT: approved/.test(ob.res.unapproved), 'escalate / OUTBOX only: marked unapproved, in words: ' + ob.res.unapproved);
    A.ok(ob.outputs.length === 1 && ob.outputs[0].p.outboxId === 'p7' && /unapproved/.test(ob.outputs[0].p.unapproved) && ob.outputs[0].p.agentId === 'reviewer', 'escalate / OUTBOX only: the OUTBOX row says p7 and unapproved');
    A.ok(/^\[LOOP — escalated: 2 passes round the gate at 12,4 without VERDICT: approved — sent to the escalation OUTBOX unapproved\]\nno\nVERDICT: revise$/.test(ob.res.text), 'escalate / OUTBOX only: the product keeps the reviewer\'s word under its frame: ' + JSON.stringify(ob.res.text));
    const human = await walk(product, floor('human OUTBOX beside a downstream dock', { onSpent: 'escalate' }), revise);
    A.ok(human.hops.join() === 'drafter,reviewer,drafter,reviewer' && human.res.outboxId === 'p7' && human.outputs.length === 1 && human.outputs[0].p.outboxId === 'p7', 'escalate / human OUTBOX: the publisher never runs, the crate ends at the human OUTBOX');
    const none = await walk(product, floor('esc unwired', { onSpent: 'escalate' }), revise);
    A.ok(none.hops.length === 4 && none.res.hold && none.res.hold.reason === 'spent' && none.outputs.length === 0 && none.res.stopped === HOLD_WHY, 'escalate / no esc lane: nowhere to take it — held for a person, not sent down the done lane');
    // an esc dock that already ran is no lane either: a hold, where the default policy would fall back to the done lane
    const d = product.chain.loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher', esc: 'drafter', onSpent: 'escalate' }, { verdict: 'revise' }, 2, { drafter: true }, 'x\nVERDICT: revise');
    A.ok(d.held && d.reason === 'spent', 'escalate / the escalation dock already ran: held');
    const legacy = product.chain.loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher', esc: 'drafter' }, { verdict: 'revise' }, 2, { drafter: true }, 'x\nVERDICT: revise');
    A.ok(!legacy.held && legacy.target === 'publisher' && legacy.exhausted, 'and the default policy still falls back to the done lane');
    // a tag gate runs out too, and the policy reads it the same way; with no policy it is what it was
    const tagHold = product.chain.loopDecision({ loop: '12,4', when: 'code', max: 1, backTo: 'drafter', next: 'publisher', onSpent: 'hold' }, { tag: 'code', verdict: null }, 1, {}, 'still code');
    A.ok(tagHold.held && tagHold.reason === 'spent' && tagHold.pass === 1, 'a tag gate that runs out holds when it says so');
    const tagLegacy = product.chain.loopDecision({ loop: '12,4', when: 'code', max: 1, backTo: 'drafter', next: 'publisher' }, { tag: 'code', verdict: null }, 1, {}, 'still code');
    A.ok(!tagLegacy.held && tagLegacy.exhausted && tagLegacy.target === 'publisher', 'and goes on, marked, when it does not');
  }
  {   // a clean verdict passes whatever the policy: onSpent only ever speaks when the passes ran out
    for (const onSpent of [undefined, 'hold', 'escalate']) {
      const r = await walk(product, floor('esc to an OUTBOX only', onSpent ? { onSpent } : {}), ['fine\nVERDICT: approved']);
      A.ok(r.res.stopped === null && r.hops.length === 0 && !r.res.unapproved && r.res.outboxId === 'p6' && r.outputs.length === 1, (onSpent || 'absent') + ': an approved job takes the done lane');
    }
  }
  {   // an OUTBOX-only escalation cannot end a branch of a fan-out (the joiner would wait for a part that never comes): not offered there
    const d = product.chain.loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: null, escOutbox: null, onSpent: 'escalate' }, { verdict: 'revise' }, 2, {}, 'x\nVERDICT: revise');
    A.ok(d.held && d.reason === 'spent', 'escalate with its OUTBOX withheld: held');
  }

  /* ---- 7. the step-through test stops at the same gate, with the same words, and ends at the same OUTBOX ---- */
  async function stepThrough(geo, text) {
    const plan = P.compileRoutingPlan(geo), router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'fixture: the step-through floor deploys');
    const calls = [];
    const st = makeStepTest({
      runDock: async h => { calls.push(h.agentId); return { runId: 'r' + calls.length, tools: 1, usd: 0.01, text: h.agentId === 'reviewer' ? text : 'a draft' }; },
      now: clock, getTag: () => 'general', label: a => a.toUpperCase(),
      plan: { get: () => router.getPlan(), step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
        entryDock: (line, t) => { const a = router.resolveTarget({ tag: 'general', text: t, lineId: line }); return a && router.lineOriginFor(a) === line ? a : null; },
        lineOf: a => router.lineOfAgent(a), stageBrief: a => router.stageBrief(a), loopGateAfter: (a, l) => router.loopGateAfter(a, l),
        lineLimits: l => router.lineLimits(l), shipsToOutbox: a => router.chainShipsToOutbox(a) } });
    const started = st.start({ line: P.lineOf(plan, 'drafter'), text: 'a job', pause: 'none' });
    const id = started.session.id;
    let s = null;
    for (let i = 0; i < 50; i++) { await st.settled(id); s = st.get(id).session; if (s.state !== 'running') break; }
    return { calls, s };
  }
  {
    const miss = await stepThrough(floor('esc unwired', { maxIter: 6 }), 'looks fine to me');
    A.eq(miss.calls, ['drafter', 'reviewer'], 'step-through, no verdict: it stops at the gate — no pass back');
    A.ok(miss.s.stop && miss.s.stop.code === 'blocked' && miss.s.stop.why === product.Verdict.heldWhy('12,4', 'missing_verdict'), 'step-through, no verdict: and says why: ' + JSON.stringify(miss.s.stop));
    const spentHold = await stepThrough(floor('esc unwired', { onSpent: 'hold' }), 'no\nVERDICT: revise');
    A.ok(spentHold.calls.length === 6 && spentHold.s.stop && spentHold.s.stop.code === 'blocked' && spentHold.s.stop.why === HOLD_WHY, 'step-through, a spent gate that holds: stops at the cap, with the hold\'s words: ' + spentHold.calls.join());
    const toBox = await stepThrough(floor('esc to an OUTBOX only', { onSpent: 'escalate' }), 'no\nVERDICT: revise');
    A.ok(toBox.s.outboxId === 'p7' && !toBox.s.stop && toBox.s.state === 'done', 'step-through, escalate to an OUTBOX-only lane: the session ends at that OUTBOX: ' + JSON.stringify([toBox.s.state, toBox.s.outboxId]));
  }

  /* ---- 8. THE WORDS ---- */
  {
    const V = product.Verdict;
    A.eq(V.heldWhy('g1'), 'the reviewer at the gate g1 answered VERDICT: blocked, so the work is held there — not sent on, not shipped', 'the BLOCKED sentence is byte for byte what three census and invariant tests pin');
    A.eq(V.heldWhy('g1', 'blocked'), V.heldWhy('g1'), 'blocked is the default reason');
    A.eq(V.heldWhy('g1', 'banana'), V.heldWhy('g1'), 'an unknown reason says the default, never nothing');
    const sentences = V.HOLD_REASONS.map(why => V.heldWhy('12,4', why));
    A.eq(V.HOLD_REASONS, ['blocked', 'missing_verdict', 'spent'], 'the three reasons line-continuation.js knows');
    A.eq(new Set(sentences).size, 3, 'each reason says its own thing');
    A.ok(sentences.every(s => s.length <= 400 && /so the work is held there — not sent on, not shipped$/.test(s)), 'and each fits a hold record and ends the same way');
    A.ok(/gave no usable VERDICT line/.test(V.heldWhy('12,4', 'missing_verdict')) && /used all its passes/.test(V.heldWhy('12,4', 'spent')), 'in words a person can act on');
    for (const why of V.HOLD_REASONS) A.eq(LineFire.lineStop('blocked', { loop: '12,4', reason: why }).why, V.heldWhy('12,4', why), 'the typed stop says ' + why + ' in the same sentence');
    A.ok(/the work line stopped early — the reviewer at the gate 12,4 gave no usable VERDICT line/.test(LineFire.lineStopNote({ stopped: 'x', stop: LineFire.lineStop('blocked', { loop: '12,4', reason: 'missing_verdict' }) })), 'the stop note the channel and routine print names it');
    for (const when of ['approved', 'revise']) for (const handsOn of [true, false, undefined]) {
      const b = V.verdictBrief(when, handsOn);
      A.ok(b.length <= 600, 'the brief fits the 600 characters handoffPrompt keeps: ' + b.length);
      A.ok(/A reply with no VERDICT line holds the work for a person\./.test(b) && !/treated as/.test(b), 'the brief says what silence now means (' + when + ', ' + handsOn + ')');
      A.ok(/"VERDICT: blocked" when it must stop for a person/.test(b), 'and still offers BLOCKED');
    }
    A.eq(V.verdictBrief('code'), '', 'a tag gate still gets no brief');
  }

  /* ---- 9. THE CONTROL: the original source fails the family case for case, and says the old things ---- */
  {
    const old = await noVerdictBattery(original);
    A.eq(old.cases, live.cases, 'control: the same battery ran');
    const failed = new Set(old.fails.map(f => f.split(': ')[0]));
    A.ok(failed.size === old.cases, 'control: the ORIGINAL fails every one of the ' + old.cases + ' cases of the family (it failed ' + failed.size + ')');
    const probe = await walk(original, floor('esc unwired', { maxIter: 6 }), ['looks fine to me']);
    A.ok(probe.hops.length === 12 && !probe.res.hold && /used all 6 passes without VERDICT: approved/.test(probe.res.unapproved) && probe.outputs.length === 1, 'control: the original buys six paid passes (12 hops) and delivers it unapproved — the probe the lane was opened on: ' + probe.hops.length);
    const d0 = original.chain.loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher' }, { verdict: null }, 0, {}, 'x');
    A.ok(d0.again === true && !d0.held && d0.target === 'drafter', 'control: the original reads a missing verdict as revise');
    A.ok(/treated as "revise"/.test(original.Verdict.verdictBrief('approved')) && !/holds the work/.test(original.Verdict.verdictBrief('approved')), 'control: the original brief promises "treated as revise"');
    A.eq(original.Verdict.heldWhy('12,4', 'missing_verdict'), original.Verdict.heldWhy('12,4'), 'control: the original has one sentence for every hold');
    const od = original.chain.loopDecision({ loop: '12,4', when: 'approved', max: 2, backTo: 'drafter', next: 'publisher', onSpent: 'hold' }, { verdict: 'revise' }, 2, {}, 'x\nVERDICT: revise');
    A.ok(!od.held && od.exhausted && od.target === 'publisher', 'control: the original has no onSpent');
    A.ok(original.Verdict.HOLD_REASONS === undefined, 'control: and no hold reasons');
  }
  A.report('line-hold.policy');
})().catch(e => { console.error(e); process.exit(1); });
