/* test/loop-verdict.test.js — "loop until APPROVED" (2026-08-22): the pure VERDICT parser (sidecar/routing/verdict.js)
   and the chain runner's verdict-keyed LOOP gate, driven through the REAL compiler + REAL router (same rig as
   test/chain.join-loop.test.js). Fake harness, fake clock — no provider.

   LINE-HOLD S2: a reply with NO usable VERDICT line used to read as 'revise' ("silence = round again"); it now HOLDS the job at the gate for
   a person (chain.js loopDecision, reason 'missing_verdict'), and the reviewer's brief says so. The two places that pinned the old reading
   are rewritten below. The subject is built through test/helpers/line-hold-control.js: LINE_HOLD_CONTROL=original makes it the saved
   5977d433c source (test/fixtures/line-hold-5977d433c) and those expectations must go RED there (test/line-hold.policy.test.js runs
   that control in-process too). */
'use strict';
const A = require('./_assert.js');
const subject = require('./helpers/line-hold-control.js').pick();
const V = subject.Verdict;
const { makeChainRunner } = subject.chain;
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

/* ---- 1. the parser ---- */
A.eq(V.parseVerdict('Looks fine.\nVERDICT: approved'), 'approved', 'plain last line');
A.eq(V.parseVerdict('Looks fine.\n\n**Verdict: Approved.**\n\n'), 'approved', 'markdown bold, case, trailing period, trailing blank lines');
A.eq(V.parseVerdict('- verdict — REVISE'), 'revise', 'bullet + em-dash separator');
A.eq(V.parseVerdict('> VERDICT: rejected'), 'revise', 'a synonym maps to the canonical word');
A.eq(V.parseVerdict('VERDICT: approve\nbut actually\nVERDICT: revise'), 'revise', 'the LAST verdict line wins');
A.eq(V.parseVerdict('VERDICT: approved\nline\nline\nline\nline'), null, 'a verdict buried above the tail does not count (quoting the word is not passing the work)');
A.eq(V.parseVerdict('no verdict here'), null, 'no line = null');
A.eq(V.parseVerdict('VERDICT: maybe'), null, 'an unknown word is not a verdict');
A.eq(V.parseVerdict(''), null); A.eq(V.parseVerdict(null), null);
A.ok(V.isVerdictWord('approved') && V.isVerdictWord('REVISE') && !V.isVerdictWord('code') && !V.isVerdictWord(null), 'isVerdictWord: the two words, any case; never a classifier tag');
A.ok(/"VERDICT: approved"/.test(V.verdictBrief('approved')) && /"VERDICT: revise"/.test(V.verdictBrief('approved')) && /A reply with no VERDICT line holds the work for a person\./.test(V.verdictBrief('approved')) && !/treated as/.test(V.verdictBrief('approved')), 'the reviewer brief names both words and what silence means: a hold');
A.eq(V.verdictBrief('code'), '', 'a classifier-tag gate gets no verdict brief');
// R1 (2026-09-27 audit): the VERDICT line is the gate's control signal — it is stripped from the work that leaves an approved gate
const NL = String.fromCharCode(10);
A.eq(V.stripVerdict(['Here is the post.', '', 'VERDICT: approved'].join(NL)), 'Here is the post.', 'the verdict line comes off the work');
A.eq(V.stripVerdict(['post', '**VERDICT: Approved.**', ''].join(NL)), 'post', 'dressed verdicts too');
A.eq(V.stripVerdict('no verdict'), 'no verdict', 'a text without one is unchanged');
const quoted = ['VERDICT: approved', 'line', 'line', 'line', 'line'].join(NL);
A.eq(V.stripVerdict(quoted), quoted, 'a verdict quoted above the tail is not stripped');
A.ok(/lead with the finished work itself/.test(V.verdictBrief('approved')), 'the reviewer is told its approving reply is what moves on');
// (2026-10-21) ...unless it is only the VERDICT line or a bare approval: then the work it was handed moves on as it is (chain.js bareApproval)
const BARE_PROMISE = /a reply of only the VERDICT line, or a bare approval such as "Looks good\.", passes it on exactly as you were handed it\. Any other reply is what moves on past the gate/;
A.ok(BARE_PROMISE.test(V.verdictBrief('approved', true)) && /lead with the finished work itself/.test(V.verdictBrief('approved', true)),
  'where the caller knows a bare approval hands the work on: the reviewer is told how to pass it on unchanged, and that any other reply is what moves on');
// ...and ONLY there (2026-10-21 review): a self-loop gate, a crate another gate framed and the browser's COMMS line keep the reply as it is
A.ok(!/bare approval|only the VERDICT line/.test(V.verdictBrief('approved')) && /When the work passes, your reply is what moves on past the gate: lead with the finished work itself/.test(V.verdictBrief('approved')),
  'by default the brief makes no bare-approval promise: the reply is what moves on (the trunk wording)');
A.ok(!/bare approval/.test(V.verdictBrief('approved', 'yes')), '...only a literal true makes the promise');
A.ok([V.verdictBrief('approved'), V.verdictBrief('revise'), V.verdictBrief('approved', true), V.verdictBrief('revise', true)].every(b => b.length <= 600), 'the brief fits the 600 characters handoffPrompt keeps');

// the handoff prompt carries the brief as its own paragraph, and is byte-identical without it
const base = P.handoffPrompt('req', 'writer', 'draft', 1, 'be picky');
A.eq(P.handoffPrompt('req', 'writer', 'draft', 1, 'be picky', ''), base, 'an empty verdict brief changes nothing');
A.ok(P.handoffPrompt('req', 'writer', 'draft', 1, 'be picky', V.verdictBrief('approved')).indexOf('be picky\n\nYOUR VERDICT DECIDES') > 0, 'the verdict instruction rides after the standing brief');
A.ok(P.handoffPrompt('req', 'writer', 'draft', 1, 'be picky', V.verdictBrief('approved', true)).indexOf(V.verdictBrief('approved', true) + '\n\n') > 0, '...whole, never clipped');

/* ---- 2. the gate ---- */
const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });
let T = 0; const clock = () => (T += 10);
// INBOX -> writer -> reviewer -> LOOP gate -> (done E -> publisher | back N -> writer)
function loopFloor(gateCfg, donePropOverride) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return geo(
    [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
     { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'writer' },
     { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
     Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E' }, gateCfg || {}),
     donePropOverride || { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' }],
    belts
  );
}
function rig(floor, script, opts) {
  const router = makeRouter();
  const plan = P.compileRoutingPlan(floor);
  const set = router.setPlan(plan);
  if (!set.ok) throw new Error('plan refused: ' + JSON.stringify(plan.errors));
  const log = [];
  const runAgent = async ({ agentId, text, hop, from }) => {
    log.push({ agentId, hop, from, text });
    const r = script[agentId];
    return typeof r === 'function' ? r(text, log) : (r || { text: agentId + ' output', usd: 0.01 });
  };
  const c = makeChainRunner(Object.assign({
    nextAgent: (a, ctx) => router.chainNext(a, ctx),
    stepAgent: (a, ctx) => router.chainStep(a, ctx),
    fanSiblings: (a) => router.fanSiblings(a),
    lineOfAgent: (a) => router.lineOfAgent(a),
    loopGateAfter: (a, l) => router.loopGateAfter(a, l),
    getTag: () => 'general',
    runAgent, emit: () => {}, now: clock, setTimer: () => 0
  }, opts || {}));
  return { c, router, plan, log, lineId: P.lineOf(plan, plan.bays[0].agentId) };
}
const handedText = (entry) => (entry.text.split('produced:\n')[1] || '').split('\n')[0];

(async () => {
  /* revise x2 then approved -> 3 review passes, exits on DONE, no exhaustion mark */
  {
    const verdicts = ['VERDICT: revise', 'VERDICT: revise', 'VERDICT: approved']; let n = 0;
    const R = rig(loopFloor({ maxIter: 5, when: 'approved' }), {
      writer: (t) => ({ text: 'draft ' + (t.match(/pass (\d)/) ? +t.match(/pass (\d)/)[1] + 1 : 1), usd: 0.01 }),
      reviewer: () => ({ text: 'review notes\n\n' + verdicts[n++], usd: 0.01 }),
      publisher: (t) => ({ text: 'published:' + t, usd: 0.01 })
    });
    const g = R.router.loopGateAfter('reviewer', R.lineId);
    A.ok(g && g.when === 'approved', 'router.loopGateAfter: the reviewer lane meets the verdict gate');
    A.eq(R.router.loopGateAfter('writer', R.lineId), null, 'the writer lane meets the reviewer first — no gate');
    const res = await R.c.advance({ agentId: 'writer', text: 'draft 1', originalText: 'write a post', lineId: R.lineId, runId: 'v1' });
    A.eq(res.stopped, null, 'ran to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,writer,reviewer,publisher', 'exactly 3 review passes (2 back round), then DONE');
    A.ok(!res.loopExhausted, 'approved = not exhausted');
    A.ok(!/exhausted/.test(res.text), 'the done-lane handoff carries no exhaustion mark');
    A.ok(R.log.filter(l => l.agentId === 'reviewer').every(l => /YOUR VERDICT DECIDES[\s\S]*"VERDICT: approved"/.test(l.text)), 'every reviewer turn is told to end with the verdict line');
    A.ok(R.log.filter(l => l.agentId !== 'reviewer').every(l => !/YOUR VERDICT DECIDES/.test(l.text)), 'the writer and publisher are not');
    A.ok(/\[LOOP — pass 2 of 5/.test(R.log[3].text), 're-entries are numbered');
  }
  /* never approved -> exits on DONE at MAX with the exhaustion marker */
  {
    const R = rig(loopFloor({ maxIter: 2, when: 'approved' }), {
      writer: { text: 'draft', usd: 0.01 },
      reviewer: { text: 'meh\nVERDICT: revise', usd: 0.01 },
      publisher: (t) => ({ text: t, usd: 0.01 })
    });
    const res = await R.c.advance({ agentId: 'writer', text: 'draft', originalText: 'go', lineId: R.lineId, runId: 'v2' });
    A.eq(res.stopped, null, 'ran to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,writer,reviewer,publisher', '2 passes back round, then DONE regardless');
    A.ok(res.loopExhausted === true, 'out.loopExhausted is set');
    A.ok(/^\[LOOP — exhausted: 2 passes round the gate at [\d,]+ without VERDICT: approved — leaving on DONE unapproved\]/.test(handedText(R.log[5])), 'the downstream handoff is marked EXHAUSTED (' + handedText(R.log[5]) + ')');
  }
  /* a reviewer that emits NO verdict line HOLDS the job at the gate for a person (S2: it used to read as "revise" and go round again) */
  {
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }), {
      writer: { text: 'draft', usd: 0.01 },
      reviewer: () => ({ text: 'no verdict at all', usd: 0.01 })
    });
    const res = await R.c.advance({ agentId: 'writer', text: 'draft', originalText: 'go', lineId: R.lineId, runId: 'v3a' });
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer', 'silence = held: the reviewer ran once, no writer pass, nothing after');
    A.ok(res.hold && res.hold.reason === 'missing_verdict' && res.hold.pass === 0 && res.stop && res.stop.code === 'blocked' && res.blocked === res.stopped, 'held at the gate with its reason: ' + JSON.stringify(res.hold));
    A.ok(!res.loopExhausted && !res.unapproved && res.outboxId === undefined, 'nothing went on, nothing is marked unapproved');
  }
  /* ...and a reviewer that revises, then approves, takes the passes it asked for; the DONE lane can be an OUTBOX */
  {
    let k = 0;
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }), {
      writer: { text: 'draft', usd: 0.01 },
      reviewer: () => ({ text: (++k < 2) ? 'needs work\nVERDICT: revise' : 'fine\nverdict: APPROVED', usd: 0.01 })
    });
    const res = await R.c.advance({ agentId: 'writer', text: 'draft', originalText: 'go', lineId: R.lineId, runId: 'v3' });
    A.eq(res.stopped, null, 'ran to its end (' + res.stopped + ')');
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer', 'revise = round again; approval = out');
    // R1 (2026-09-27 audit): what ships never carries the VERDICT line — the line is the gate's control signal. And (2026-10-18) an
    // approval that did not restate the work ("fine") ships THE WORK IT APPROVED: the OUTBOX product is what the channel, the
    // routine and SEND TO deliver, and a bare "fine" there was the line's whole result.
    A.ok(res.text === 'draft' && !res.loopExhausted, 'the delivered answer is the approved work, never the bare approval (' + JSON.stringify(res.text) + ')');
  }
  /* when = revise: the mirror — round while the verdict is not "revise" */
  {
    let k = 0;
    const R = rig(loopFloor({ maxIter: 4, when: 'revise' }), {
      writer: { text: 'd', usd: 0.01 }, reviewer: () => ({ text: (++k < 3) ? 'VERDICT: approved' : 'VERDICT: revise', usd: 0.01 }), publisher: { text: 'p', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'writer', text: 'd', originalText: 'w', lineId: R.lineId, runId: 'v4' });
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,writer,reviewer,publisher', 'when=revise exits the moment the verdict says revise');
  }
  /* classifier-tag loops behave exactly as before: round WHILE the tag matches */
  {
    let k = 0;
    const R = rig(loopFloor({ maxIter: 5, when: 'code' }), {
      writer: { text: 'd', usd: 0.01 }, reviewer: { text: 'VERDICT: revise', usd: 0.01 }, publisher: { text: 'p', usd: 0.01 }
    }, { getTag: (t) => (/VERDICT/.test(t) && ++k <= 2) ? 'code' : 'general' });   // the classifier sees EVERY stage's output; only the reviewer's reads as code, twice
    const res = await R.c.advance({ agentId: 'writer', text: 'd', originalText: 'w', lineId: R.lineId, runId: 'v5' });
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,writer,reviewer,publisher', 'tag=code twice = 2 passes back, then general leaves on DONE — the verdict line is ignored by a tag gate');
    A.ok(!res.loopExhausted && !/exhausted/.test(res.text), 'a tag gate that stopped matching is not exhausted');
    A.ok(R.log.filter(l => l.agentId === 'reviewer').every(l => !/YOUR VERDICT DECIDES/.test(l.text)), 'a tag gate sends no verdict brief');
  }
  /* a tag gate that matches through MAX is marked exhausted too (the `when` was never unmet) */
  {
    const R = rig(loopFloor({ maxIter: 1, when: 'code' }), { writer: { text: 'd', usd: 0.01 }, reviewer: { text: 'r', usd: 0.01 }, publisher: (t) => ({ text: t, usd: 0.01 }) }, { getTag: () => 'code' });
    const res = await R.c.advance({ agentId: 'writer', text: 'd', originalText: 'w', lineId: R.lineId, runId: 'v6' });
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,publisher');
    A.ok(res.loopExhausted && /while the output still read as code/.test(res.text), 'exhaustion mark names the tag');
  }

  /* ---- A TERSE APPROVAL HANDS ON THE WORK IT APPROVED (2026-10-18). Hops no longer replay the line's transcript (resumeSeed:false,
          10-17), so a reviewer that approves without restating the work ("Looks good.") used to hand the next stage ONLY its
          approval — a designer after researcher ▸ reviewer ▸ LOOP got no research — and a gate that ships straight out delivered
          the approval as the line's result. A reviewer that DID restate the work (R1: its fixes become the work) is unchanged. ---- */
  const RESEARCH = 'Three findings on rooftop solar:\n1. Installs grew 34% in 2025 (source: SEIA).\n2. Battery attach rates passed 50% in California.\n3. Permitting delays remain the top soft cost.';
  const upstreamOf = (entry) => (entry.text.split('produced:\n')[1] || '').split('\n\nDo YOUR part')[0];
  const outboxDone = { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 };
  {
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }), {
      writer: { text: RESEARCH, usd: 0.01 }, reviewer: { text: 'Looks good.\nVERDICT: approved', usd: 0.01 }, publisher: { text: 'the design', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'writer', text: RESEARCH, originalText: 'research rooftop solar', lineId: R.lineId, runId: 'v7' });
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,publisher', 'terse approval: approved on the first pass');
    const handed = upstreamOf(R.log.find(l => l.agentId === 'publisher'));
    A.ok(handed.indexOf(RESEARCH) >= 0, 'terse approval: the next stage is handed the work the reviewer approved (' + JSON.stringify(handed.slice(0, 120)) + ')');
    A.ok(/\nREVIEW:\nLooks good\.$/.test(handed) && !/VERDICT/.test(handed), 'terse approval: ...with the approval notes after it, never the VERDICT line');
    A.ok(!res.loopExhausted && !/exhausted/.test(handed), 'terse approval: nothing is marked exhausted');
  }
  {
    const shippedRecs = [];
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), {
      writer: { text: RESEARCH, usd: 0.01 }, reviewer: { text: 'Looks good.\nVERDICT: approved', usd: 0.01 }
    }, { lastStage: (a) => a === 'reviewer', onShipped: (r) => shippedRecs.push(r) });
    const res = await R.c.advance({ agentId: 'writer', text: RESEARCH, originalText: 'research rooftop solar', lineId: R.lineId, runId: 'v8' });
    await new Promise(r => setImmediate(r));
    A.eq(res.stopped, null, 'terse approval to the OUTBOX: ran to its end (' + res.stopped + ')');
    A.eq(res.text, RESEARCH, 'terse approval to the OUTBOX: the line delivers the approved work, never the bare approval');
    A.eq(shippedRecs.length === 1 && shippedRecs[0].text, RESEARCH, 'terse approval to the OUTBOX: SEND TO hands the next line the work too');
  }
  {
    // a SHORT work (one line) beside an approval about as long as it: the reply still does not carry the work
    const TWEET = 'Launch day: StarNet ships review gates.';
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), {
      writer: { text: TWEET, usd: 0.01 }, reviewer: { text: 'Great hook, ship it.\nVERDICT: approved', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'writer', text: TWEET, originalText: 'write a launch tweet', lineId: R.lineId, runId: 'v9' });
    A.eq(res.text, TWEET, 'a short work approved tersely ships the work (' + JSON.stringify(res.text) + ')');
  }
  {
    // the reviewer RESTATED the work with its fix applied (what the verdict brief asks for): its reply alone moves on, the work once
    const FIXED = RESEARCH.replace('34%', '34 percent') + '\n\nNotes: spelled out one unit.';
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }), {
      writer: { text: RESEARCH, usd: 0.01 }, reviewer: { text: FIXED + '\nVERDICT: approved', usd: 0.01 }, publisher: { text: 'the design', usd: 0.01 }
    });
    await R.c.advance({ agentId: 'writer', text: RESEARCH, originalText: 'research rooftop solar', lineId: R.lineId, runId: 'v10' });
    A.eq(upstreamOf(R.log.find(l => l.agentId === 'publisher')), FIXED, 'restated approval: the next stage gets the reviewer\'s version alone, minus its VERDICT line (no second copy)');
    const R2 = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), { writer: { text: RESEARCH, usd: 0.01 }, reviewer: { text: FIXED + '\nVERDICT: approved', usd: 0.01 } });
    const res2 = await R2.c.advance({ agentId: 'writer', text: RESEARCH, originalText: 'research rooftop solar', lineId: R2.lineId, runId: 'v11' });
    A.eq(res2.text, FIXED, 'restated approval to the OUTBOX: the reviewer\'s version ships, as before');
  }
  {
    // the reviewer RETURNED THE FINISHED VERSION with its corrections, reworded past half the draft's three-word runs (the Creative
    // Studio preset's own reviewer: "return the finished version (small corrections are fine)"). Its version is the work (R1): it
    // ships and moves on alone, never swapped back for the draft it corrected, and never framed as "passed on without restating it".
    const DRAFT = 'Grow Together! Join our community garden and help it flourish. Bring your curiosity and share your ideas. Everyone is welcome to take part.';
    const EDITED = 'Grow Together! Help our community garden flourish. Share your ideas and learn alongside your neighbors. Everyone is welcome to take part.';
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), {
      writer: { text: DRAFT, usd: 0.01 }, reviewer: { text: EDITED + '\nVERDICT: approved', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'writer', text: DRAFT, originalText: 'write a community garden blurb', lineId: R.lineId, runId: 'v12' });
    A.eq(res.text, EDITED, 'an edited approval to the OUTBOX: the reviewer\'s finished version ships, not the draft it corrected');
    const R2 = rig(loopFloor({ maxIter: 3, when: 'approved' }), {
      writer: { text: DRAFT, usd: 0.01 }, reviewer: { text: EDITED + '\nVERDICT: approved', usd: 0.01 }, publisher: { text: 'the design', usd: 0.01 }
    });
    await R2.c.advance({ agentId: 'writer', text: DRAFT, originalText: 'write a community garden blurb', lineId: R2.lineId, runId: 'v13' });
    A.eq(upstreamOf(R2.log.find(l => l.agentId === 'publisher')), EDITED, 'an edited approval to a dock: the next stage gets the reviewer\'s version alone, unframed');
  }
  {
    // ...and a bare approval that praises the work in approval words alone is still not the work
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), {
      writer: { text: RESEARCH, usd: 0.01 }, reviewer: { text: 'Looks good: accurate, well sourced and clearly written.\nVERDICT: approved', usd: 0.01 }
    });
    const res = await R.c.advance({ agentId: 'writer', text: RESEARCH, originalText: 'research rooftop solar', lineId: R.lineId, runId: 'v14' });
    A.eq(res.text, RESEARCH, 'a praising bare approval to the OUTBOX: the work ships, never the praise');
  }

  /* ---- A VERSION THE REVIEWER CHANGED IS THE WORK (review of the terse-approval fix, 2026-10-21). A reviewer that redacted the
          draft, corrected Chinese or Japanese prose, tightened it or translated it returns its own version with the approval: that
          version ships out of the OUTBOX (the channel reply, the routine result, SEND TO) and moves on to a dock alone, as on trunk.
          Swapping it back for the draft shipped the personal data a redacting reviewer removed. ---- */
  async function throughGate(draft, reply, runId) {
    const sent = [];
    const O = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), {
      writer: { text: draft, usd: 0.01 }, reviewer: { text: reply + '\nVERDICT: approved', usd: 0.01 }
    }, { lastStage: (a) => a === 'reviewer', onShipped: (r) => sent.push(r) });
    const res = await O.c.advance({ agentId: 'writer', text: draft, originalText: 'go', lineId: O.lineId, runId: runId + '-out' });
    await new Promise(r => setImmediate(r));
    const D = rig(loopFloor({ maxIter: 3, when: 'approved' }), {
      writer: { text: draft, usd: 0.01 }, reviewer: { text: reply + '\nVERDICT: approved', usd: 0.01 }, publisher: { text: 'the design', usd: 0.01 }
    });
    await D.c.advance({ agentId: 'writer', text: draft, originalText: 'go', lineId: D.lineId, runId: runId + '-dock' });
    const pub = D.log.find(l => l.agentId === 'publisher');
    return { outbox: res.text, sendTo: sent.length === 1 ? sent[0].text : null, dock: pub ? upstreamOf(pub) : null, dockTurn: pub ? pub.text : '' };
  }
  const changedIsTheWork = async (name, draft, reply, leaked) => {
    const g = await throughGate(draft, reply, 'v-' + name);
    A.eq(g.outbox, reply, name + ' to the OUTBOX: the reviewer\'s version ships, never the draft (' + JSON.stringify(String(g.outbox).slice(0, 80)) + ')');
    A.eq(g.sendTo, reply, name + ' to the OUTBOX: SEND TO hands on the reviewer\'s version');
    A.eq(g.dock, reply, name + ' to a dock: the next stage gets the reviewer\'s version alone, unframed');
    A.ok(!/passed the work on without restating it/.test(g.dockTurn), name + ' to a dock: never told the reviewer passed the work on without restating it');
    for (const s of leaked || []) A.ok([g.outbox, g.sendTo, g.dockTurn].every(t => String(t).indexOf(s) < 0), name + ': what moves on never carries the redacted ' + JSON.stringify(s));
  };
  const CUSTOMERS = 'Customer update: Wei Zhang (phone 555-0100) asked about his refund. Lina Park (lina@example.com) wants delivery moved to Friday. Order A1029 for Sam Ortiz ships tomorrow.';
  const CUSTOMERS_R = 'Customer update: [redacted] (phone [redacted]) asked about his refund. [redacted] ([redacted]) wants delivery moved to Friday. Order A1029 for [redacted] ships tomorrow.';
  await changedIsTheWork('a redacting reviewer', CUSTOMERS, CUSTOMERS_R, ['Wei Zhang', '555-0100', 'Lina Park', 'lina@example.com', 'Sam Ortiz']);
  const THANKS = 'Huge thanks to Wei Zhang (wei.zhang@example.com, 555-0100) for the launch help!';
  const THANKS_R = 'Huge thanks to [redacted] ([redacted], [redacted]) for the launch help!';
  await changedIsTheWork('a redacting reviewer on a one-line post', THANKS, THANKS_R, ['Wei Zhang', 'wei.zhang@example.com', '555-0100']);
  const ZH_PII = '客户张伟的电话是13800138000，他住在北京市朝阳区。李娜的邮箱是lina@example.com，她要求退款。王强的订单号是A1029，他明天取货。';
  const ZH_PII_R = '客户[已隐去]的电话是[已隐去]，他住在[已隐去]。[已隐去]的邮箱是[已隐去]，她要求退款。[已隐去]的订单号是A1029，他明天取货。';
  await changedIsTheWork('a redacting reviewer in Chinese', ZH_PII, ZH_PII_R, ['张伟', '13800138000', '朝阳区', '李娜', 'lina@example.com', '王强']);
  const ZH = '我们的社区花园欢迎每一个人，大家一起种植蔬菜和花卉。请带上你的好奇心，分享你的想法，和邻居一起学习。每个周六上午九点我们都会开放，欢迎全家参加。';
  const ZH_FIXED = '我们的社区花园欢迎每一位朋友，大家一起种植蔬菜和花卉。请带上你的好奇心，分享你的想法，和邻居们一起学习。每周六上午九点开放，欢迎全家参加。';
  await changedIsTheWork('small corrections to Chinese', ZH, ZH_FIXED);
  // one sentence with no spaces and one character corrected: a word per character, or the whole line is one word and the fix loses it
  await changedIsTheWork('a one-character correction to a one-line Chinese post', '欢迎大家本周六上午九点来社区花园一起种菜', '欢迎大家本周六上午十点来社区花园一起种菜');
  const JA = '私たちのコミュニティガーデンへようこそ。みんなで野菜と花を育てましょう。毎週土曜日の朝九時に開いています。';
  const JA_FIXED = '私たちのコミュニティガーデンへようこそ！みんなで野菜や花を育てましょう。毎週土曜の朝九時に開いています。';
  await changedIsTheWork('small corrections to Japanese', JA, JA_FIXED);
  const COPY = 'Introducing our new productivity app, FocusFlow! FocusFlow is designed to help busy professionals manage their time more effectively. With FocusFlow, you can create task lists, set reminders, and track your progress throughout the day. The app also includes a built-in Pomodoro timer that helps you stay focused on your work for 25-minute intervals, followed by short breaks. FocusFlow syncs across all of your devices, so you can access your tasks wherever you are. Whether you are working from home, at the office, or on the go, FocusFlow has you covered. Download FocusFlow today and start getting more done in less time!';
  const COPY_TIGHT = 'Meet FocusFlow, the productivity app for busy professionals. Build task lists, set reminders and track your day. A built-in Pomodoro timer keeps you on 25-minute sprints with short breaks between. Everything syncs across your devices, at home, at the office or on the road. Get FocusFlow today and do more in less time.';
  await changedIsTheWork('a tightened version', COPY, COPY_TIGHT);
  await changedIsTheWork('a translation', 'Our community garden welcomes everyone. Grow vegetables and flowers together. Open every Saturday at nine.',
    'Nuestro huerto comunitario da la bienvenida a todos. Cultiva verduras y flores en compañía. Abierto cada sábado a las nueve.');
  // ...while a BARE approval, in any script, still hands on the work it approved (2026-10-21: only the VERDICT line, or nothing but
  // approval words; one that discusses the work in its own words stays the reviewer's, below)
  const WORK_HEAD_TEXT = 'THE WORK UNDER REVIEW (what the reviewer was handed):\n';
  const approvalIsNot = async (name, draft, reply) => {
    const g = await throughGate(draft, reply, 'v-' + name);
    A.eq(g.outbox, draft, name + ' to the OUTBOX: the approved work ships, never the approval (' + JSON.stringify(String(g.outbox).slice(0, 80)) + ')');
    A.ok(String(g.dock).indexOf(WORK_HEAD_TEXT + draft + '\n\nREVIEW:\n' + reply) >= 0, name + ' to a dock: the work, then the approval as its review (' + JSON.stringify(String(g.dock).slice(0, 80)) + ')');
  };
  await approvalIsNot('a terse Chinese approval', ZH, '看起来不错，可以发布。');
  await approvalIsNot('a terse Japanese approval', JA, 'いいと思います。');
  await approvalIsNot('a terse approval of long copy', COPY, 'Looks good.');
  await approvalIsNot('a praising approval of long copy', COPY, 'Approved: concise, upbeat and specific.');
  await approvalIsNot('an approval of a one-line post', THANKS, 'Warm and specific, approved.');
  {
    // the verdict brief's way to pass the work on unchanged: only the VERDICT line. The work moves on alone (no empty review)
    const g = await throughGate(RESEARCH, '', 'v-verdict-only');
    A.ok(g.outbox === RESEARCH && g.sendTo === RESEARCH && g.dock === RESEARCH && !/VERDICT|REVIEW:/.test(g.dockTurn),
      'a reply of only the VERDICT line: the OUTBOX, SEND TO and a dock all get the work as it was handed (' + JSON.stringify(String(g.dock).slice(0, 60)) + ')');
  }
  for (const ok of ['LGTM 👍', 'Approved, ship it!', 'No changes needed.', 'Great work, thanks.', '**Looks great to me.**', 'Good to go.', '👍', '没问题，通过。', '承認します。', '좋습니다.'])
    await approvalIsNot('the bare approval ' + JSON.stringify(ok), RESEARCH, ok);

  /* ---- A REDACTION OR SUMMARY OF ANY LENGTH IS THE WORK (review of e0c1d62fd, 2026-10-21). The draft stands in only for a bare
          approval (below: review of 000e5680a); any other reply stays the reviewer's, as on trunk. The previous rule swapped a version under
          half the draft's length (a list redaction, a cut private section, a summary), a fully redacted one-liner, and a redacted one-line
          export past its word budget back for the unredacted draft, at the OUTBOX, SEND TO and a dock. ---- */
  await changedIsTheWork('a list redaction',
    'Contacts for the launch:\n- Wei Zhang, 555-0100, wei@example.com\n- Lina Park, 555-0101, lina@example.com\n- Sam Ortiz, 555-0102, sam@example.com',
    'Contacts for the launch:\n- [redacted]\n- [redacted]\n- [redacted]', ['Wei Zhang', '555-0100', 'wei@example.com', 'Lina Park', 'lina@example.com', 'Sam Ortiz']);
  await changedIsTheWork('a private section cut',
    'Launch plan: ship Friday at 9am.\n\nPrivate notes (do not share):\nWei Zhang is leaving the company next month, keep quiet.\nLina Park salary 140k, raise pending.\nSam Ortiz on medical leave until December.',
    'Launch plan: ship Friday at 9am.', ['Wei Zhang', 'leaving the company', 'salary', '140k', 'medical leave']);
  await changedIsTheWork('a heavy tightening', COPY, 'FocusFlow: tasks, reminders, a Pomodoro timer and sync everywhere. Get it today.');
  await changedIsTheWork('a fully redacted one-liner', 'Call Wei Zhang at 555-0100 about the refund.', '[redacted]', ['Wei Zhang', '555-0100']);
  await changedIsTheWork('a one-liner masked with asterisks', 'Call Wei Zhang at 555-0100 about the refund.', 'Call *** at *** about the refund.', ['Wei Zhang', '555-0100']);
  {
    // a one-line export (no line break, no sentence break) of 300 records, names and phones redacted: past any word budget, still the work
    const recs = []; for (let i = 0; i < 300; i++) recs.push('{"name":"First' + i + ' Last' + i + '","phone":"555-' + (1000 + i) + '","city":"Boston"}');
    const EXPORT = '[' + recs.join(',') + ']';
    const EXPORT_R = EXPORT.replace(/"name":"[^"]*"/g, '"name":"[redacted]"').replace(/"phone":"[^"]*"/g, '"phone":"[redacted]"');
    await changedIsTheWork('a redacted one-line export of 300 records', EXPORT, EXPORT_R, ['First0 Last0', '555-1000', 'First299 Last299', '555-1299']);
  }
  // a reply that is not a bare approval (it reuses the work's own words, or runs past a short note) stays the reviewer's, as on trunk
  await changedIsTheWork('an approval that reuses the work\'s own words', RESEARCH, 'Looks good: the three findings on rooftop solar are well sourced.');
  await changedIsTheWork('a multi-paragraph review', RESEARCH,
    'Strengths: every number is sourced and the California point is explained.\n\nMinor: you could name a county for the permitting delays.\n\nReady for the designer.');

  /* ---- ONLY A BARE APPROVAL HANDS ON THE DRAFT (review of 000e5680a, 2026-10-21). Its "plainly a short note" rule (25 words or fewer,
          one paragraph, under a third of its vocabulary from the draft) also caught the reviewer's own short finished version and its
          caveats, and swapped the draft in at the OUTBOX, SEND TO and a dock: a reworded tagline, headline or subject line, a translation
          of one sentence (or one that merges two), an approval that asks for a name or number to come out (the draft's personal data went
          out of the line) and one that withholds the work. The reviewer's reply is now the default, as on trunk; the draft stands in only
          on positive evidence (a bare approval, above). ---- */
  await changedIsTheWork('a reworded tagline', 'Fresh coffee delivered to your door every morning', 'Wake up to better brew.');
  await changedIsTheWork('a reworded headline', 'City council approves new budget for parks and libraries', 'Green spaces and books get a funding boost');
  await changedIsTheWork('a reworded subject line', 'Subject: Update on the project timeline for next quarter', 'Heads up: launch moves to March');
  await changedIsTheWork('a one-sentence Spanish translation', 'Our community garden opens every Saturday at nine.', 'Nuestro huerto comunitario abre cada sábado a las nueve.');
  await changedIsTheWork('a one-sentence Chinese translation', 'Our community garden opens every Saturday at nine.', '我们的社区花园每周六九点开放。');
  await changedIsTheWork('a translation that merges two sentences into one', 'Our garden is open to everyone. It opens every Saturday at nine.',
    'Nuestro huerto, abierto a todos, abre cada sábado a las nueve.');
  await changedIsTheWork('a discussing approval in Chinese', ZH, '很好：社区花园的介绍清楚，开放时间也写明了。');
  await changedIsTheWork('a discussing approval in Japanese', JA, '良いです。案内がわかりやすい。');
  await changedIsTheWork('an approval that discusses research in three sentences', RESEARCH,
    'The research is accurate and well sourced. All three findings are relevant and clearly stated. Approved for the designer.');
  // an approval with a caveat, or one that withholds the work: the reviewer's words move on and the draft's personal data never does
  const PII_THANKS = 'Huge thanks to Wei Zhang (555-0100) for the launch help!';
  for (const caveat of [
    'Approved, but remove his phone number before posting.', 'Good, but drop the phone number.', 'Fine once you delete the number.',
    'Strip the phone number, then ship it.', 'Take out the number and it is good to go.', 'Cut the phone number.', 'Hide his number first.',
    "Don't post this as is.", 'Do not publish the phone number.', 'Not safe to share as written.', 'We cannot share his number.',
    '可以发布，但请删掉他的电话号码。', '電話番号を消してから承認します。'])
    await changedIsTheWork('the caveat ' + JSON.stringify(caveat), PII_THANKS, caveat, ['Wei Zhang', '555-0100']);
  await changedIsTheWork('a withholding approval', 'Wei Zhang SSN 123-45-6789, lives at 12 Elm St Boston.', 'Nothing here is safe to share publicly.',
    ['Wei Zhang', '123-45-6789', '12 Elm St']);
  for (const mask of ['***', '█████', '[ ]', '___'])
    await changedIsTheWork('a reply masked as ' + JSON.stringify(mask), PII_THANKS, mask, ['Wei Zhang', '555-0100']);
  await changedIsTheWork('approval filler alone', PII_THANKS, 'This is it.', ['Wei Zhang', '555-0100']);

  /* ---- AN EXHAUSTED GATE'S FRAME IS NOT A DRAFT TO SWAP IN (review of 77b627c18, 2026-10-21). Two gates in series: gate 1 runs
          out of passes with the reviewer's REDACTED version as its last word, and its done lane feeds the editor, whose bare
          approval meets gate 2. The editor was handed the whole exhausted frame (the draft AND the redaction), so a bare approval
          there swaps nothing in — as on trunk: the unredacted draft never reaches the OUTBOX, SEND TO or a dock — and a loop-back at
          gate 2 shows the whole frame, the first reviewer's last word included. The editor is never told a bare approval passes
          the work on. ---- */
  // INBOX -> writer -> reviewer -> LOOP 1 (max 1, back: writer) -> editor -> LOOP 2 (max 2, back: writer) -> done
  function twoGateFloor(doneProp) {
    const bs = [belt(2, 4, 'E'), belt(3, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(8, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'), belt(13, 4, 'E'), belt(14, 4, 'E'), belt(15, 4, 'E'),
      belt(18, 4, 'E'), belt(19, 4, 'E'), belt(20, 4, 'E'), belt(21, 4, 'E'), belt(22, 4, 'E'),
      belt(13, 3, 'N'), belt(13, 2, 'N'), belt(13, 1, 'N'), belt(13, 0, 'W')];
    for (let x = 12; x >= 4; x--) bs.push(belt(x, 0, 'W'));
    bs.push(belt(3, 0, 'S'), belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'), belt(20, 5, 'S'), belt(20, 6, 'S'), belt(20, 7, 'W'));
    for (let x = 19; x >= 3; x--) bs.push(belt(x, 7, 'W'));
    bs.push(belt(2, 7, 'N'), belt(2, 6, 'N'), belt(2, 5, 'N'));
    return geo([{ id: 'p1', t: 'intake', x: 0, y: 3, w: 2, h: 2 },
      { id: 'p2', t: 'bay', x: 4, y: 3, w: 2, h: 2, agentId: 'writer' },
      { id: 'p3', t: 'bay', x: 9, y: 3, w: 2, h: 2, agentId: 'reviewer' },
      { id: 'p4', t: 'loop', x: 13, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 1 },
      { id: 'p5', t: 'bay', x: 16, y: 3, w: 2, h: 2, agentId: 'editor' },
      { id: 'p6', t: 'loop', x: 20, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 },
      doneProp || { id: 'p7', t: 'outbox', x: 23, y: 3, w: 2, h: 2 }], bs);
  }
  const LEAK = 'Call Jane Doe at 555-123-4567. SSN 123-45-6789. Launch is Friday.';
  const LEAK_R = 'Call [redacted] at [redacted]. Launch is Friday.\n\nStill needs a source for the date.\nVERDICT: revise';
  const leaks = (t) => /Jane Doe|555-123-4567|123-45-6789/.test(String(t));
  const exhaustedScript = (editor) => ({ writer: { text: LEAK, usd: 0.01 }, reviewer: { text: LEAK_R, usd: 0.01 }, editor, publisher: { text: 'the design', usd: 0.01 } });
  {
    const sent = [];
    const R = rig(twoGateFloor(), exhaustedScript({ text: 'Looks good.\nVERDICT: approved', usd: 0.01 }), { lastStage: (a) => a === 'editor', onShipped: (r) => sent.push(r) });
    A.ok(R.lineId === P.lineOf(R.plan, 'writer') && R.router.loopGateAfter('reviewer', R.lineId) && R.router.loopGateAfter('editor', R.lineId), 'two gates in series: the floor compiles with both gates on the writer\'s line');
    const res = await R.c.advance({ agentId: 'writer', text: LEAK, originalText: 'write the launch post', lineId: R.lineId, runId: 'v-two-gates-out' });
    await new Promise(r => setImmediate(r));
    A.eq(res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,editor', 'two gates in series: gate 1 runs out of passes, the editor reviews once');
    A.ok(res.stopped == null && /used all 1 pass without VERDICT: approved/.test(String(res.unapproved)), 'two gates in series: the job is marked unapproved (' + res.unapproved + ')');
    const ed = R.log.find(l => l.agentId === 'editor');
    A.ok(/\[LOOP — exhausted: 1 pass round the gate at [\d,]+ without VERDICT: approved — leaving on DONE unapproved\]/.test(ed.text) && /Call \[redacted\] at \[redacted\]/.test(ed.text),
      'two gates in series: the editor is handed gate 1\'s exhausted frame, the redacted version in it');
    A.ok(/YOUR VERDICT DECIDES/.test(ed.text) && !BARE_PROMISE.test(ed.text) && /your reply is what moves on past the gate/.test(ed.text),
      'two gates in series: the editor is never told a bare approval passes on what it was handed');
    A.ok(!leaks(res.text) && res.text === 'Looks good.', 'two gates in series to the OUTBOX: the unredacted draft never ships (' + JSON.stringify(res.text) + ')');
    A.ok(sent.length === 1 && !leaks(sent[0].text) && /used all 1 pass/.test(String(sent[0].unapproved)), 'two gates in series: SEND TO hands on no unredacted draft, marked unapproved');
  }
  {
    const R = rig(twoGateFloor({ id: 'p7', t: 'bay', x: 23, y: 3, w: 2, h: 2, agentId: 'publisher' }), exhaustedScript({ text: 'Looks good.\nVERDICT: approved', usd: 0.01 }));
    await R.c.advance({ agentId: 'writer', text: LEAK, originalText: 'write the launch post', lineId: R.lineId, runId: 'v-two-gates-dock' });
    const pub = R.log.find(l => l.agentId === 'publisher');
    A.ok(pub && !leaks(pub.text) && !/passed the work on without restating it/.test(pub.text), 'two gates in series to a dock: the next stage is never handed the unredacted draft');
  }
  {
    // a loop-back at gate 2: the writer sees the whole exhausted frame as the work under review, the first reviewer's last word in it
    let k = 0;
    const R = rig(twoGateFloor(), exhaustedScript(() => ({ text: (++k === 1) ? 'Needs a source.\nVERDICT: revise' : 'Looks good.\nVERDICT: approved', usd: 0.01 })));
    const res = await R.c.advance({ agentId: 'writer', text: LEAK, originalText: 'write the launch post', lineId: R.lineId, runId: 'v-two-gates-back' });
    const back = R.log.filter(l => l.agentId === 'writer').find(l => /\[LOOP — pass 1 of 2 round the gate at 20,4\]/.test(l.text));
    A.ok(!!back, 'two gates in series: gate 2 sends the work back to the writer');
    A.ok(back && back.text.indexOf(WORK_HEAD_TEXT + '[LOOP — exhausted: 1 pass round the gate at 13,4') >= 0 && /Call \[redacted\] at \[redacted\]/.test(back.text) && /REVIEW:\nNeeds a source\./.test(back.text),
      'two gates in series: the loop-back shows gate 1\'s whole frame (the reviewer\'s last word too) as what the editor was handed, then gate 2\'s review');
    A.ok(!leaks(res.text), 'two gates in series: after the loop-back the product still never carries the unredacted draft (' + JSON.stringify(res.text) + ')');
  }
  {
    // ...while a crate gate 1 PASSED ON for a bare approval still carries its work to gate 2: the editor is told so, and its bare approval ships it
    const OK_WORK = 'Launch is Friday at 9am. The release notes are in the shared folder.';
    const sent = [];
    const R = rig(twoGateFloor(), { writer: { text: OK_WORK, usd: 0.01 }, reviewer: { text: 'Looks good.\nVERDICT: approved', usd: 0.01 }, editor: { text: 'Ship it.\nVERDICT: approved', usd: 0.01 } },
      { lastStage: (a) => a === 'editor', onShipped: (r) => sent.push(r) });
    const res = await R.c.advance({ agentId: 'writer', text: OK_WORK, originalText: 'write the launch post', lineId: R.lineId, runId: 'v-two-gates-passed' });
    await new Promise(r => setImmediate(r));
    const ed = R.log.find(l => l.agentId === 'editor');
    A.ok(/passed the work on without restating it/.test(ed.text) && BARE_PROMISE.test(ed.text), 'two bare approvals in series: the editor gets gate 1\'s passed-on frame and is told a bare approval passes the work on');
    A.ok(res.text === OK_WORK && sent.length === 1 && sent[0].text === OK_WORK && !res.unapproved, 'two bare approvals in series: the approved work ships, never a frame (' + JSON.stringify(res.text) + ')');
  }

  /* ---- A SELF-LOOP GATE PROMISES NO BARE-APPROVAL PASS-ON (review of 77b627c18, 2026-10-21). A gate whose back lane re-enters the
          dock that just ran reviews no separate draft (chain.js advance: reviewed = ''), so a bare reply there IS the product. The
          dock's loop-back turn says so — the reply is what moves on — and the behaviour matches, in the agent-keyed and the
          dock-keyed runner. The reviewer of an ordinary gate is still told how to pass the work on. ---- */
  // INBOX -> refiner -> LOOP (back lane into the refiner itself) -> OUTBOX
  const selfLoopFloor = () => {
    const bs = [belt(1, 4, 'E'), belt(2, 4, 'E')];
    for (let x = 5; x <= 14; x++) bs.push(belt(x, 4, 'E'));
    bs.push(belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W'));
    for (let x = 11; x >= 6; x--) bs.push(belt(x, 1, 'W'));
    bs.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
    return geo([{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 }, { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'refiner' },
      { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', maxIter: 3, when: 'approved' }, outboxDone], bs);
  };
  const dockKeyed = (R, script) => {
    const log = [];
    const c = makeChainRunner({
      nextAgent: (a, ctx) => R.router.chainNext(a, ctx), stepAgent: (a, ctx) => R.router.chainStep(a, ctx), fanSiblings: (a) => R.router.fanSiblings(a),
      lineOfAgent: (a, d) => R.router.lineOfAgent(a, d), stepDock: (d, ctx) => R.router.chainStepDock(d, ctx), entryDockOf: (a) => R.router.entryDockOf(a),
      loopGateAfter: (a, l, d) => R.router.loopGateAfter(a, l, d), getTag: () => 'general', emit: () => {}, now: clock, setTimer: () => 0,
      runAgent: async (call) => { log.push(call); const r = script[call.agentId]; return typeof r === 'function' ? r(call.text, log) : r; }
    });
    return { c, log };
  };
  const SELF_DRAFT = 'Rooftop installs grew 34% in 2025; battery attach passed half; permits are the top soft cost.';
  for (const reply of ['Looks good.', ''])
    for (const keyed of ['agent', 'dock']) {
      const script = { refiner: { text: (reply ? reply + '\n' : '') + 'VERDICT: approved', usd: 0.01 } };
      const R = rig(selfLoopFloor(), script);
      const g = R.router.loopGateAfter('refiner', R.lineId);
      A.ok(g && g.backTo === 'refiner' && g.backDock === 'p2', 'a self-loop gate: router.loopGateAfter names the back lane\'s dock (' + JSON.stringify(g) + ')');
      const run = keyed === 'dock' ? dockKeyed(R, script) : { c: R.c, log: R.log };
      const res = await run.c.advance({ agentId: 'refiner', text: SELF_DRAFT + '\n\nOne more pass on the numbers.\nVERDICT: revise', originalText: 'polish: ' + SELF_DRAFT, lineId: R.lineId, runId: 'v-self-' + keyed + '-' + (reply ? 'bare' : 'verdict') });
      const t2 = (run.log[0] || {}).text || '';
      const label = 'a self-loop gate (' + keyed + '-keyed, ' + JSON.stringify(reply || 'VERDICT line only') + ')';
      A.eq((run.log[0] || {}).dockId || null, keyed === 'dock' ? 'p2' : null, label + ': the hop runs ' + (keyed === 'dock' ? 'at its bay' : 'by agent'));
      A.ok(/\[LOOP — pass 1 of 3/.test(t2) && /YOUR VERDICT DECIDES/.test(t2), label + ': the loop-back turn carries the verdict brief');
      A.ok(!BARE_PROMISE.test(t2) && /When the work passes, your reply is what moves on past the gate: lead with the finished work itself/.test(t2),
        label + ': ...with no bare-approval promise — the reply is what moves on');
      A.eq(res.text, reply || 'VERDICT: approved', label + ': ...and the reply is indeed what moves on (no reviewed work at a self-loop)');
    }
  {
    // the control: an ordinary gate's reviewer (agent-keyed and dock-keyed) IS told how to pass the work on, and it holds
    const script = { writer: { text: RESEARCH, usd: 0.01 }, reviewer: { text: 'Looks good.\nVERDICT: approved', usd: 0.01 } };
    for (const keyed of ['agent', 'dock']) {
      const R = rig(loopFloor({ maxIter: 3, when: 'approved' }, outboxDone), script);
      const run = keyed === 'dock' ? dockKeyed(R, script) : { c: R.c, log: R.log };
      const res = await run.c.advance({ agentId: 'writer', text: RESEARCH, originalText: 'research rooftop solar', lineId: R.lineId, runId: 'v-ordinary-' + keyed });
      A.ok(BARE_PROMISE.test(run.log.find(l => l.agentId === 'reviewer').text) && res.text === RESEARCH, 'an ordinary gate (' + keyed + '-keyed): the reviewer is told a bare approval passes the work on, and it does');
    }
  }

  /* ---- A FRAME INSIDE A JOINED CRATE (review of 524522d2c, 2026-10-22). Gate 1 sits on one branch of a split; its done lane meets
          the JOINER, so its frame is one BRANCH of the merged crate the editor reviews at gate 2. Only a frame that STARTS the crate
          was read: the editor's bare approval swapped in the whole merged crate — an exhausted gate 1's draft (the name, phone and SSN
          its reviewer redacted) went out of the OUTBOX and through SEND TO, and a passed-on gate 1's frame wrapper shipped as part of
          the product. Now the exhausted case moves the editor's reply on as on trunk, and a passed-on frame is unwrapped in place. ---- */
  // INBOX -> SPLIT -> [writer -> reviewer -> LOOP 1 (max 1, back: writer)] + [researcher] -> JOINER -> editor -> LOOP 2 (max 2, back: writer) -> done
  function joinGateFloor(doneProp) {
    const bs = [belt(2, 6, 'E'), belt(3, 6, 'E'), belt(4, 6, 'E'), belt(5, 6, 'E'), belt(6, 6, 'E'), belt(9, 6, 'E'), belt(10, 6, 'E'), belt(11, 6, 'E'),
      belt(14, 6, 'E'), belt(15, 6, 'E'), belt(16, 6, 'E'), belt(17, 6, 'E'), belt(18, 6, 'E'), belt(19, 6, 'E'), belt(20, 6, 'E'), belt(21, 6, 'E'),
      belt(24, 6, 'E'), belt(25, 6, 'E'), belt(26, 6, 'E'), belt(27, 6, 'E'), belt(28, 6, 'E')];
    bs.push(belt(16, 5, 'N'), belt(16, 4, 'N'), belt(16, 3, 'N'), belt(16, 2, 'W'));   // gate 1's back lane, into the writer's input
    for (let x = 15; x >= 7; x--) bs.push(belt(x, 2, 'W'));
    bs.push(belt(6, 2, 'S'), belt(6, 3, 'S'), belt(6, 4, 'S'), belt(6, 5, 'S'));
    for (let y = 5; y >= 1; y--) bs.push(belt(26, y, 'N'));                          // gate 2's back lane, round the top
    bs.push(belt(26, 0, 'W'));
    for (let x = 25; x >= 6; x--) bs.push(belt(x, 0, 'W'));
    for (let y = 0; y <= 5; y++) bs.push(belt(5, y, 'S'));
    bs.push(belt(3, 7, 'S'), belt(3, 8, 'S'), belt(3, 9, 'S'));                     // the split's second lane, to the researcher
    for (let x = 4; x <= 18; x++) bs.push(belt(x, 11, 'E'));
    for (let y = 11; y >= 7; y--) bs.push(belt(19, y, 'N'));                          // ...and on into the joiner from the south
    return geo([{ id: 'p1', t: 'intake', x: 0, y: 5, w: 2, h: 2 },
      { id: 'p2', t: 'splitter', x: 3, y: 6, w: 1, h: 1 },
      { id: 'p3', t: 'bay', x: 7, y: 5, w: 2, h: 2, agentId: 'writer' },
      { id: 'p4', t: 'bay', x: 12, y: 5, w: 2, h: 2, agentId: 'reviewer' },
      { id: 'p5', t: 'loop', x: 16, y: 6, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 1 },
      { id: 'p6', t: 'joiner', x: 19, y: 6, w: 1, h: 1 },
      { id: 'p7', t: 'bay', x: 22, y: 5, w: 2, h: 2, agentId: 'editor' },
      { id: 'p8', t: 'loop', x: 26, y: 6, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 2 },
      doneProp || { id: 'p9', t: 'outbox', x: 29, y: 5, w: 2, h: 2 },
      { id: 'p10', t: 'bay', x: 2, y: 10, w: 2, h: 2, agentId: 'researcher' }], bs);
  }
  const NOTES = 'Permits average 40 days in the county.';
  const joinScript = (reviewer, editor) => ({ writer: { text: LEAK, usd: 0.01 }, reviewer, researcher: { text: NOTES, usd: 0.01 }, editor, publisher: { text: 'the design', usd: 0.01 } });
  async function throughJoin(script, runId) {
    const sent = [];
    const O = rig(joinGateFloor(), script, { lastStage: (a) => a === 'editor', onShipped: (r) => sent.push(r) });
    const res = await O.c.advance({ agentId: 'writer', text: LEAK, originalText: 'write the launch post', lineId: O.lineId, runId: runId + '-out' });
    await new Promise(r => setImmediate(r));
    const D = rig(joinGateFloor({ id: 'p9', t: 'bay', x: 29, y: 5, w: 2, h: 2, agentId: 'publisher' }), script);
    await D.c.advance({ agentId: 'writer', text: LEAK, originalText: 'write the launch post', lineId: D.lineId, runId: runId + '-dock' });
    const pub = D.log.find(l => l.agentId === 'publisher');
    return { res, plan: O.plan, router: O.router, lineId: O.lineId, editorTurn: (O.log.find(l => l.agentId === 'editor') || {}).text || '',
      outbox: res.text, sendTo: sent.length === 1 ? sent[0] : null, dock: pub ? upstreamOf(pub) : null, dockTurn: pub ? pub.text : '' };
  }
  {
    // gate 1 runs out of passes with the reviewer's redacted version as its last word; the editor approves the merged crate tersely
    const g = await throughJoin(joinScript({ text: LEAK_R, usd: 0.01 }, { text: 'Looks good.\nVERDICT: approved', usd: 0.01 }), 'v-join-exhausted');
    A.eq(g.plan.errors.filter(e => !e.warn).length, 0, 'a gate inside a split branch: the floor compiles (' + JSON.stringify(g.plan.errors) + ')');
    A.ok(g.router.loopGateAfter('reviewer', g.lineId) && g.router.loopGateAfter('editor', g.lineId) && P.lineOf(g.plan, 'researcher') === g.lineId,
      'a gate inside a split branch: both gates and both branches are on the writer\'s line');
    A.eq(g.res.hops.map(h => h.agentId).join(','), 'reviewer,writer,reviewer,researcher,editor', 'a gate inside a split branch: gate 1 runs out, the researcher branch runs, the editor reviews the merged crate');
    A.ok(/^JOINED OUTPUT — 2 of 2 branches delivered/.test(upstreamOf({ text: g.editorTurn })) && /=== BRANCH 1 of 2 — reviewer ===\n\[LOOP — exhausted: 1 pass round the gate at 16,6/.test(g.editorTurn),
      'a gate inside a split branch: the editor is handed the joined crate, gate 1\'s exhausted frame inside it (not at its start)');
    A.ok(!BARE_PROMISE.test(g.editorTurn) && /your reply is what moves on past the gate/.test(g.editorTurn),
      'an exhausted frame inside a joined crate: the editor is never told a bare approval passes on what it was handed');
    A.ok(g.outbox === 'Looks good.' && !leaks(g.outbox), 'an exhausted frame inside a joined crate, to the OUTBOX: the editor\'s reply ships as on trunk, never the unredacted draft (' + JSON.stringify(String(g.outbox).slice(0, 90)) + ')');
    A.ok(g.sendTo && !leaks(g.sendTo.text) && /used all 1 pass/.test(String(g.sendTo.unapproved)), 'an exhausted frame inside a joined crate: SEND TO hands on no unredacted draft, marked unapproved');
    A.ok(g.dock === 'Looks good.' && !leaks(g.dockTurn) && !/passed the work on without restating it/.test(g.dockTurn),
      'an exhausted frame inside a joined crate, to a dock: the next stage is never handed the unredacted draft (' + JSON.stringify(String(g.dock).slice(0, 90)) + ')');
  }
  {
    // gate 1 passes the work on for a bare approval; the editor approves the merged crate tersely: the joined work ships, unwrapped
    const OK_WORK = 'Launch is Friday at 9am. The release notes are in the shared folder.';
    const script = joinScript({ text: 'Looks good.\nVERDICT: approved', usd: 0.01 }, { text: 'Ship it.\nVERDICT: approved', usd: 0.01 });
    script.writer = { text: OK_WORK, usd: 0.01 };
    const sent = [];
    const O = rig(joinGateFloor(), script, { lastStage: (a) => a === 'editor', onShipped: (r) => sent.push(r) });
    const res = await O.c.advance({ agentId: 'writer', text: OK_WORK, originalText: 'write the launch post', lineId: O.lineId, runId: 'v-join-passed-out' });
    await new Promise(r => setImmediate(r));
    const want = P.joinPayload([{ agentId: 'reviewer', text: OK_WORK }, { agentId: 'researcher', text: NOTES }], []);
    const ed = O.log.find(l => l.agentId === 'editor');
    A.ok(/=== BRANCH 1 of 2 — reviewer ===\n\[LOOP — approved round the gate at 16,6 — the reviewer passed the work on without restating it\]/.test(ed.text) && BARE_PROMISE.test(ed.text),
      'a passed-on frame inside a joined crate: the editor is handed it, and told a bare approval passes the work on');
    A.eq(res.text, want, 'a passed-on frame inside a joined crate, to the OUTBOX: the joined work ships with the frame unwrapped (no wrapper, no REVIEW part)');
    A.ok(sent.length === 1 && sent[0].text === want && !res.unapproved, 'a passed-on frame inside a joined crate: SEND TO hands on the same joined work');
    const D = rig(joinGateFloor({ id: 'p9', t: 'bay', x: 29, y: 5, w: 2, h: 2, agentId: 'publisher' }), script);
    await D.c.advance({ agentId: 'writer', text: OK_WORK, originalText: 'write the launch post', lineId: D.lineId, runId: 'v-join-passed-dock' });
    const handed = upstreamOf(D.log.find(l => l.agentId === 'publisher'));
    A.ok(handed.indexOf(WORK_HEAD_TEXT + want + '\n\nREVIEW:\nShip it.') > 0 && (handed.match(/\[LOOP — /g) || []).length === 1,
      'a passed-on frame inside a joined crate, to a dock: one frame round the joined work, never a nested one (' + JSON.stringify(handed.slice(0, 90)) + ')');
  }
  {
    // ...and a reply past the joiner that says the editor CHANGED the work is the work, never the joined crate it was handed
    const g = await throughJoin(joinScript({ text: 'Looks good.\nVERDICT: approved', usd: 0.01 }, { text: 'Done.\nVERDICT: approved', usd: 0.01 }), 'v-join-done');
    A.ok(g.outbox === 'Done.' && g.sendTo && g.sendTo.text === 'Done.' && g.dock === 'Done.', 'a changed-work reply past the joiner: the reply moves on, as on trunk (' + JSON.stringify(String(g.outbox).slice(0, 60)) + ')');
  }

  /* ---- A REPLY THAT SAYS IT CHANGED THE WORK IS NEVER A BARE APPROVAL (review of 524522d2c, 2026-10-22). "done" was an approval word
          and "changes", "edits" and "polished" approval filler, so "Done.", "Changes done." or "Edits done, looks good." swapped the
          draft the reviewer was handed back in for the version it says it changed — the OUTBOX, SEND TO and a dock got the old draft,
          its phone number included. Now any claim of a change keeps the reply, as on trunk; a real terse approval still hands the work on. ---- */
  for (const claim of ['Done.', 'All done.', 'Done, ship it.', 'Done — looks good.', 'Changes done.', 'Edits done, looks good.', 'All changes done, ready to ship.',
    'Polished and ready.', 'OK, done.', '好了。', '可以了。', '没问题了，可以发布。'])
    await changedIsTheWork('the changed-work reply ' + JSON.stringify(claim), PII_THANKS, claim);   // the reply itself moves on: the old draft (and its phone number) never does
  for (const ok of ['Looks good.', 'No changes needed.', 'No further edits needed.', 'No edits needed, ship it.', 'No changes.', 'Approved.', 'Fine as is.', 'Ship it.', '太棒了！'])
    await approvalIsNot('the real terse approval ' + JSON.stringify(ok), RESEARCH, ok);
  A.report('loop-verdict');
})();
