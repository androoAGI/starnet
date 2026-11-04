/* test/line-sendto.test.js — SEND TO: one line hands its finished work on to another (2026-10-10).

   The OUTBOX carries `sendTo` = the target INBOX's prop id — a POINTER, never a belt (belts joining two lines make one line, one
   lineId, one budget: the 10-09 P0). Locked here, on a real station and the real compiler:
     THE MODEL    — setSendTo points an OUTBOX at another line's INBOX in one undo slot; refuses this same line, a circle, a
                    non-OUTBOX and a non-INBOX in words with a floor caption; NOWHERE clears it; it survives serialize →
                    deserialize (the migrate whitelist), rides projectGeometry and lineGraph, and a deleted INBOX takes the
                    pointers into it with it (same undo). sendToChoices lists every other line, a circle disabled with its reason.
     THE COMPILER — plan.sendTo keyed by OUTBOX, rec.sendTo on the line, rec.stages / rec.maxHops / rec.name; SEND_TO_MISSING /
                    SEND_TO_SELF / SEND_TO_LOOP are warnings (the plan stays deployable); plan.hash never moves with a pointer;
                    a floor with no pointer compiles with no plan.sendTo at all.
     RUN TIME     — Pipeline.sendToOf names the target for a finished line; Pipeline.handoffInput composes the next line's job. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');

function lines(n) {
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 44; r.y2 = 44; }
  const st = WM.create(d);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = LE.placeBlueprint(st, 'research_line', { x: 8, y: 4 + i * 12 });
    if (!r.ok) throw new Error('placeBlueprint ' + JSON.stringify(r));
    const of = t => r.ids.filter(id => st.propById(id).t === t);
    out.push({ intake: of('intake')[0], bays: of('bay'), outbox: of('outbox')[0] });
  }
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  return { st, L: out };
}
const plan = st => P.compileRoutingPlan(st.projectGeometry());
const lineOf = (pl, id) => pl.lineOfProp[id];

/* ---------- THE MODEL ---------- */
{
  const { st, L: [a, b, c] } = lines(3);
  st.setPropLabel(a.intake, 'A'); st.setPropLabel(b.intake, 'B'); st.setPropLabel(c.intake, 'C');
  const p0 = plan(st);
  A.eq(p0.sendTo, undefined, 'a floor with no SEND TO compiles no plan.sendTo at all (existing floors byte-identical)');
  A.ok(p0.lines.length === 3 && p0.lines.every(l => !l.sendTo), 'three lines, none sending');
  const hash0 = p0.hash;

  const r = st.setSendTo(a.outbox, b.intake);
  A.ok(r.ok && r.sendTo === b.intake && r.toLine === lineOf(p0, b.intake) && r.name === 'LINE B', 'LINE A’s OUTBOX sends to LINE B’s INBOX — ' + JSON.stringify(r));
  A.eq(st.propById(a.outbox).sendTo, b.intake, 'the pointer is on the OUTBOX prop');
  A.ok(st.links().every(l => l.from.prop !== a.outbox && l.to.prop !== b.intake), 'no link was laid: the two lines stay two lines');
  const p1 = plan(st);
  A.eq(p1.lines.length, 3, '…still three lines after SEND TO (never fused)');
  A.eq(p1.sendTo, { [a.outbox]: { intakeId: b.intake, fromLine: lineOf(p1, a.outbox), toLine: lineOf(p1, b.intake) } }, 'plan.sendTo keyed by OUTBOX');
  const recA = p1.lines.find(l => l.lineId === lineOf(p1, a.outbox));
  A.eq(recA.sendTo, [{ outboxId: a.outbox, intakeId: b.intake, toLine: lineOf(p1, b.intake) }], 'LINE A’s record names where it sends');
  A.ok(recA.name === 'A' && typeof recA.stages === 'number' && recA.stages >= 1 && recA.maxHops === P.LINE_LIMIT_DEFAULTS.maxHops, 'the line record carries its name and stages n / max — ' + JSON.stringify({ name: recA.name, stages: recA.stages, maxHops: recA.maxHops }));
  A.eq(p1.hash, hash0, 'plan.hash never moves with a SEND TO (dispatch topology is unchanged; SPLITTER counters keep)');
  // RESTORED (final floor lane M19 / M29): e2f430f6e narrowed this to /^SEND_TO_(MISSING|SELF|LOOP)$/ so a PRIVATE FILES warning
  // could ride every default SEND TO. Exact produced files now ride the handoff as read grants, never
  // as a routing warning: a clean SEND TO is no finding at all.
  A.ok(P.ok(p1) && !p1.errors.some(e => /^SEND_TO/.test(e.code)), 'a clean SEND TO is no finding');

  // the same pointer again burns no undo slot
  const again = st.setSendTo(a.outbox, b.intake);
  A.ok(again.ok && again.sendTo === b.intake, 'the same SEND TO again answers ok');
  st.undo(); A.eq(st.propById(a.outbox).sendTo, undefined, 'ONE UNDO takes the pointer back (the repeat burned no slot)');
  st.redo(); A.eq(st.propById(a.outbox).sendTo, b.intake, 'REDO puts it back');

  // refusals
  const same = st.setSendTo(a.outbox, a.intake);
  A.ok(same.ok === false && same.error === 'SAME_LINE' && /same line/i.test(same.msg) && same.short, 'its own line’s INBOX is refused — ' + JSON.stringify(same));
  A.ok(st.setSendTo(b.outbox, c.intake).ok, 'LINE B sends to LINE C');
  const loop = st.setSendTo(c.outbox, a.intake);
  A.ok(loop.ok === false && loop.error === 'SEND_LOOP' && /circle/.test(loop.msg) && /LINE A/.test(loop.msg) && /LOOP/.test(loop.short), 'C → A would close a circle (A → B → C): refused, naming the line — ' + JSON.stringify(loop));
  A.eq(st.propById(c.outbox).sendTo, undefined, '…and nothing was written');
  const bad1 = st.setSendTo(a.bays[0], b.intake), bad2 = st.setSendTo(a.outbox, b.bays[0]);
  A.ok(bad1.error === 'BAD_TYPE' && bad2.error === 'NOT_INBOX', 'only an OUTBOX sends, only to an INBOX');
  A.eq(st.connectRefusal(a.outbox, null), null, 'the BELT tool may arm an OUTBOX now (its destination is an INBOX: SEND TO)');
  A.eq((st.connectRefusal(c.outbox, a.intake) || {}).error, 'SEND_LOOP', '…and its second click on an INBOX answers the SEND TO refusal');
  A.eq((st.connectRefusal(a.outbox, b.bays[0]) || {}).error, 'FROM_OUTBOX', '…an OUTBOX to a BAY is still no belt');
  A.eq(st.connectBelt(a.outbox, b.intake).error, 'FROM_OUTBOX', 'connectBelt still never lays a belt OUTBOX → INBOX');

  // the Workflow panel's chips
  const ch = st.sendToChoices(c.outbox);
  A.eq(ch.map(x => [x.name, x.on, x.refusal ? x.refusal.error : null]), [['LINE A', false, 'SEND_LOOP'], ['LINE B', false, 'SEND_LOOP']], 'C’s chips: A and B each close a circle — disabled with the reason');
  const chA = st.sendToChoices(a.outbox);
  A.eq(chA.map(x => [x.name, x.on, x.refusal ? x.refusal.error : null]), [['LINE B', true, null], ['LINE C', false, null]], 'A’s chips: B on, C open');

  // NOWHERE
  const nw = st.setSendTo(b.outbox, null);
  A.ok(nw.ok && st.propById(b.outbox).sendTo === undefined, 'NOWHERE clears it');
  A.ok(st.setSendTo(b.outbox, null).ok, 'NOWHERE again is ok');
  st.undo(); A.eq(st.propById(b.outbox).sendTo, c.intake, 'a second NOWHERE burned no slot: one UNDO restores B → C');
  st.redo(); A.eq(st.propById(b.outbox).sendTo, undefined, '…and REDO clears it again');
  A.ok(st.setSendTo(c.outbox, a.intake).ok, 'with B → C gone, C → A is no circle (C → A → B)');
}

/* ---------- A POINTER THE COMPILER WOULD DROP IS NEVER ACCEPTED, AND ONE IT TURNED OFF IS SAID OFF (2026-10-11 repair) ---------- */
{
  const { st, L: [a, b, c] } = lines(3);
  st.setPropLabel(b.intake, 'B'); st.setPropLabel(c.intake, 'C');
  const lone = st.addProp({ t: 'intake', x: 40, y: 40, w: 2, h: 2 }).id;
  const r1 = st.setSendTo(a.outbox, lone);
  A.ok(r1.ok === false && r1.error === 'NO_LINE' && /starts no line yet/.test(r1.msg) && r1.short === 'THAT INBOX STARTS NO LINE YET', 'an INBOX that starts no line is refused at the edit (the drop chimed green and the compiler dropped it) — ' + JSON.stringify(r1));
  const lob = st.addProp({ t: 'outbox', x: 40, y: 34, w: 2, h: 2 }).id;
  const r2 = st.setSendTo(lob, b.intake);
  A.ok(r2.ok === false && r2.error === 'NO_LINE' && /ends no line yet/.test(r2.msg), 'an OUTBOX that ends no line is refused too — ' + JSON.stringify(r2));
  A.ok(st.sendToChoices(lob).every(x => x.refusal && x.refusal.error === 'NO_LINE'), '…so its SEND TO chips are each disabled with that reason');
  // a stale pointer on an OUTBOX on no line is SAID by the compiler (it was dropped with no finding under a red arc)
  const doc = JSON.parse(JSON.stringify(st.serialize()));
  doc.props.find(p => p.id === lob).sendTo = b.intake;
  const pl = P.compileRoutingPlan(WM.deserialize(doc).projectGeometry());
  A.ok(pl.errors.some(e => e.code === 'SEND_TO_MISSING' && e.propId === lob && e.warn) && P.ok(pl), 'an OUTBOX on no line that carries a SEND TO: SEND_TO_MISSING (a warning)');
  // A belt must not disable an established handoff, even before any job has run.
  A.ok(st.setSendTo(a.outbox, b.intake).ok, 'A → B');
  const before = JSON.stringify(st.serialize());
  const fused = st.connectBelt(a.bays[a.bays.length - 1], b.bays[0]);
  A.ok(!fused.ok && fused.error === 'SEND_TO_CONFLICT', 'a BAY → BAY belt that would fuse SEND TO lines is refused');
  A.ok(JSON.stringify(st.serialize()) === before, 'refused fusion preserves the floor');
  A.ok(plan(st).sendTo[a.outbox] && !st.sendToRefusal(a.outbox, b.intake), 'the existing handoff stays effective');
  // Legacy saves can already contain that mistake: the compiler and panel still explain it.
  st.setSendTo(a.outbox, null);
  A.ok(st.connectBelt(a.bays[a.bays.length - 1], b.bays[0]).ok, 'without SEND TO an intentional join is allowed');
  const legacy = JSON.parse(JSON.stringify(st.serialize())); legacy.props.find(p => p.id === a.outbox).sendTo = b.intake;
  const old = WM.deserialize(legacy), ps = plan(old);
  A.ok(ps.errors.some(e => e.code === 'SEND_TO_SELF' && e.propId === a.outbox) && !(ps.sendTo && ps.sendTo[a.outbox]), 'legacy same-line SEND TO is still off');
  A.eq(old.sendToRefusal(a.outbox, b.intake).error, 'SAME_LINE', 'the panel can explain the legacy pointer');
  A.ok(old.setSendTo(a.outbox, null).ok && old.propById(a.outbox).sendTo === undefined, 'NOWHERE clears the legacy pointer');
}

/* ---------- PERSISTENCE + PROJECTION + LINE GRAPH ---------- */
{
  const { st, L: [a, b] } = lines(2);
  st.setSendTo(a.outbox, b.intake);
  const back = WM.deserialize(JSON.parse(JSON.stringify(st.serialize())));
  A.eq(back.propById(a.outbox).sendTo, b.intake, 'the pointer survives a save + reload (migrate whitelist)');
  const geo = st.projectGeometry();
  A.eq(geo.props.find(p => p.id === a.outbox).sendTo, b.intake, 'projectGeometry carries it to the compiler');
  const g = st.lineGraph(a.outbox);
  A.ok(g.ok && g.graph.nodes.find(n => n.id === a.outbox).sendTo === b.intake, 'lineGraph carries it (a re-laid line keeps where it sends)');
  const tidy = LE.run(st, a.outbox, 'tidy', {});
  A.ok(tidy.ok && st.propById(a.outbox).sendTo === b.intake, 'a TIDY of LINE A keeps the pointer');
  // a migrated junk value is dropped on a non-OUTBOX
  const d = JSON.parse(JSON.stringify(st.serialize()));
  d.props.find(p => p.id === a.bays[0]).sendTo = b.intake;
  A.eq(WM.deserialize(d).propById(a.bays[0]).sendTo, undefined, 'only an OUTBOX keeps a sendTo through migrate');

  // deleting the target INBOX takes the pointer with it, in the same undo slot
  st.removeProp(b.intake);
  A.eq(st.propById(a.outbox).sendTo, undefined, 'the INBOX deleted: the OUTBOX now sends nowhere');
  st.undo();
  A.ok(st.propById(b.intake) && st.propById(a.outbox).sendTo === b.intake, 'one UNDO brings back the INBOX and the pointer');
}

/* ---------- THE COMPILER'S WARNINGS ---------- */
{
  const { st, L: [a, b] } = lines(2);
  const doc = st.serialize();
  // a hand-edited / stale save: the pointer names a lone INBOX, its own line, and a circle
  const lone = { id: 'p900', t: 'intake', x: 40, y: 40, w: 2, h: 2 };
  const geoOf = mut => { const d = JSON.parse(JSON.stringify(doc)); mut(d); return WM.deserialize(d).projectGeometry(); };
  const pm = P.compileRoutingPlan(geoOf(d => { d.props.push(lone); d.props.find(p => p.id === a.outbox).sendTo = 'p900'; }));
  A.ok(pm.errors.some(e => e.code === 'SEND_TO_MISSING' && e.propId === a.outbox && e.warn) && !pm.sendTo && P.ok(pm), 'a pointer at an INBOX that starts no line: SEND_TO_MISSING, a warning, no hand-off');
  const pg = P.compileRoutingPlan(geoOf(d => { d.props.find(p => p.id === a.outbox).sendTo = 'p99999'; }));
  A.ok(pg.errors.some(e => e.code === 'SEND_TO_MISSING') && P.ok(pg), 'a pointer at a deleted INBOX: SEND_TO_MISSING');
  const ps = P.compileRoutingPlan(geoOf(d => { d.props.find(p => p.id === a.outbox).sendTo = a.intake; }));
  A.ok(ps.errors.some(e => e.code === 'SEND_TO_SELF' && e.warn) && !ps.sendTo && P.ok(ps), 'a pointer at its own line: SEND_TO_SELF');
  const pc = P.compileRoutingPlan(geoOf(d => { d.props.find(p => p.id === a.outbox).sendTo = b.intake; d.props.find(p => p.id === b.outbox).sendTo = a.intake; }));
  A.eq(pc.errors.filter(e => e.code === 'SEND_TO_LOOP').map(e => e.propId).sort(), [a.outbox, b.outbox].sort(), 'A → B → A: both pointers on the circle are SEND_TO_LOOP…');
  A.ok(!pc.sendTo && P.ok(pc) && pc.errors.filter(e => /^SEND_TO/.test(e.code)).every(e => e.warn), '…both off, and the plan stays deployable (warnings, never blockers)');
}

/* ---------- RUN TIME HELPERS ---------- */
{
  const { st, L: [a, b] } = lines(2);
  st.setSendTo(a.outbox, b.intake);
  const pl = plan(st), la = lineOf(pl, a.outbox), lb = lineOf(pl, b.intake);
  const last = a.bays[a.bays.length - 1];
  A.eq(P.sendToOf(pl, la, last), { outboxId: a.outbox, intakeId: b.intake, fromLine: la, toLine: lb }, 'sendToOf names LINE B for a job that finished on LINE A');
  A.eq(P.sendToOf(pl, lb, b.bays[0]), null, 'LINE B sends nowhere');
  A.eq(P.sendToOf(pl, null, last), null, 'no line, no hand-off (a direct order)');
  const txt = P.handoffInput({ fromName: 'research', original: 'Find three facts.', output: 'Fact 1. Fact 2. Fact 3.', files: ['C:/w/a.md', 'C:/w/a.md', ''] });
  A.ok(/^\[HAND-OFF — LINE RESEARCH finished its part/.test(txt) && /THE JOB AS IT FIRST ARRIVED:\nFind three facts\./.test(txt) && /WHAT LINE RESEARCH DELIVERED:\nFact 1\./.test(txt), 'handoffInput: who, the job, what came back — ' + JSON.stringify(txt));
  A.ok(/FILES IT MADE \(paths on this machine\):\n- C:\/w\/a\.md\n\n\[THIS LINE’S PART — /.test(txt) && (txt.match(/C:\/w\/a\.md/g) || []).length === 1, '…and each file once');
  /* R27 (live, real model, 2026-10-12): an un-instructed line handed "a two-sentence fun fact" wrote a NEW fact of its own on every
     line (A's fact → B's different fact → C's third one), so the end of the chain held none of the work that was sent on. The frame
     says what was delivered IS the work so far, and CLOSES (after the job and the work — an instruction read before the job lost to
     it on a small model) with what this line does: build on it, never start the job over; its brief, or with none hand the work on;
     the finished work itself, never a note on whether the job is done (the earlier rubber stamp). */
  const head = txt.slice(0, txt.indexOf('\n\n')), tail = txt.slice(txt.lastIndexOf('\n\n') + 2);
  A.ok(/work so far/.test(head), 'the frame opens: what was delivered is the work so far — ' + JSON.stringify(head));
  A.ok(/^\[THIS LINE’S PART — build on the work LINE RESEARCH delivered above, never start the job over/.test(tail) && /with no brief, hand that work on as the finished result/.test(tail)
    && /full finished work itself/.test(tail) && /never a note on whether the job is done\.\]$/.test(tail),
    'the frame closes with this line\'s part: build on it, never start over, the finished work — ' + JSON.stringify(tail));
  A.ok(/\[THIS LINE’S PART — build on the work the line before this one delivered above/.test(P.handoffInput({ output: 'x' })), '…naming an unnamed sender in words');
  /* BOUNDED BY ITS PARTS (runtime repair 2026-10-12): the old "< 12400" held only for a frame with no job and no closing block — every
     real hand-off carries the job, and R27's 11700 cut to meet it dropped 300 unmarked characters of the work the next line builds on.
     What was delivered is cut exactly where the job record keeps it (handedIn, 12000); the job at 4000; the whole frame is those plus
     its fixed text, with a full-size job and a long sender name present. */
  const big = P.handoffInput({ fromName: 'N'.repeat(80), original: 'o'.repeat(5000), output: 'x'.repeat(20000) });
  const back = P.parseHandoffInput(big);
  A.eq([back.output.length, back.original.length], [12000, 4000], 'the work handed on is the 12000 characters the record keeps, the job its 4000');
  A.ok(big.length > 16000 && big.length < 4000 + 12000 + 1200, 'bounded by its parts with the job present: ' + big.length);
  A.ok(P.handoffInput({ output: 'x'.repeat(20000) }).length < 12000 + 1200, 'bounded with no job too');
  A.eq(P.parseHandoffInput(P.handoffInput({ fromName: 'a', original: 'Find facts.\nTwo.', output: 'F1\n\nF2', files: ['x'] })), { fromName: 'A', original: 'Find facts.\nTwo.', output: 'F1\n\nF2' }, 'parseHandoffInput reads the frame back (the OUTBOX titles a handed-on job by the job as it first arrived)');
  A.eq(P.parseHandoffInput('[LOOP — pass 2] x'), null, '…and nothing else');
}

/* ---------- TWO OUTBOXES ON ONE LINE (2026-10-11 repair): only the jobs that land in the SENDING one ride on ---------- */
{
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 60; r.y2 = 44; }
  const st = WM.create(d);
  const add = o => { const r = st.addProp(o); if (!r.ok) throw new Error('addProp ' + JSON.stringify(r)); return r.id; };
  // a SORTING OFFICE, whose two finished lanes each ship into their OWN OUTBOX
  const so = LE.placeBlueprint(st, 'sorting_office', { x: 8, y: 4 });
  const sb = so.ids.filter(id => st.propById(id).t === 'bay');
  const [o1, o2] = so.ids.filter(id => st.propById(id).t === 'outbox');
  A.ok(o1 && o2, 'two BAYs, two OUTBOXes, one line');
  const rb = LE.placeBlueprint(st, 'research_line', { x: 8, y: 24 });
  const bIn = rb.ids.find(id => st.propById(id).t === 'intake');
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  A.ok(st.setSendTo(o1, bIn).ok, 'only the first OUTBOX sends on');
  const pl = plan(st), la = lineOf(pl, sb[0]);
  A.eq(pl.lines.find(l => l.lineId === la).outboxes.slice().sort(), [o1, o2].sort(), 'the line has both OUTBOXes');
  A.eq((P.sendToOf(pl, la, sb[0]) || {}).outboxId, o1, 'a job whose last stage ships into the SENDING OUTBOX rides on');
  A.eq(P.sendToOf(pl, la, sb[1]), null, 'a job whose last stage ships into the OTHER OUTBOX is NOT handed on (the single-sender shortcut handed it on)');
  A.eq(P.sendToOf(pl, la, sb[1], o2), null, '…nor when the chain says it landed in that OUTBOX');
  A.eq(P.sendToOf(pl, la, null, o1).outboxId, o1, 'the exact OUTBOX the chain reports decides');
  A.eq(P.sendsReachedOf(pl, la, sb[1]), [], 'sendsReachedOf: the other BAY reaches no sender');
  const r1 = {}, r2 = {};
  A.eq(P.chainStepDock(pl, sb[0], { lineId: la, reach: r1 }), null, 'a terminal dock is still terminal when the reach is asked');
  P.chainStepDock(pl, sb[1], { lineId: la, reach: r2 });
  A.ok(r1.outboxId === o1 && r2.outboxId === o2, 'ctx.reach names the OUTBOX each job lands in — ' + JSON.stringify([r1, r2]));
}
{
  // a FILTER AFTER THE LAST DOCK: one BAY ▸ FILTER ▸ two OUTBOXes, only one sending — the job's own tag picks the OUTBOX
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 60; r.y2 = 44; }
  const st = WM.create(d);
  const add = o => { const r = st.addProp(o); if (!r.ok) throw new Error('addProp ' + JSON.stringify(r)); return r.id; };
  const inA = add({ t: 'intake', x: 2, y: 4, w: 2, h: 2 }), bay = add({ t: 'bay', x: 7, y: 4, w: 2, h: 2 }), fl = add({ t: 'filter', x: 12, y: 5, w: 1, h: 1, block: false });
  const ox = add({ t: 'outbox', x: 16, y: 1, w: 2, h: 2 }), oy = add({ t: 'outbox', x: 16, y: 8, w: 2, h: 2 });
  A.ok([st.connectBelt(inA, bay), st.connectBelt(bay, fl), st.connectBelt(fl, ox), st.connectBelt(fl, oy)].every(r => r.ok), 'BAY ▸ FILTER ▸ two OUTBOXes');
  const rb = LE.placeBlueprint(st, 'research_line', { x: 8, y: 24 });
  const bIn = rb.ids.find(id => st.propById(id).t === 'intake');
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  A.ok(st.configureJunction(fl, { routes: { code: 'S' }, def: 'E' }).ok && st.setSendTo(oy, bIn).ok, 'the FILTER splits code from the rest; one OUTBOX sends on');
  const pl = plan(st), la = lineOf(pl, bay);
  A.eq(P.outboxesReached(pl, bay).slice().sort(), [ox, oy].sort(), 'the BAY’s lane can reach both OUTBOXes');
  const at = tag => { const reach = {}; P.chainStepDock(pl, bay, { lineId: la, tag, reach }); return reach.outboxId; };
  const code = at('code'), gen = at('general');
  A.ok(code && gen && code !== gen && [code, gen].sort().join() === [ox, oy].sort().join(), 'the job’s tag decides which OUTBOX it lands in — ' + JSON.stringify({ code, gen }));
  A.eq((P.sendToOf(pl, la, bay, oy) || {}).toLine, lineOf(pl, bIn), 'landed in the sending OUTBOX: handed on');
  A.eq(P.sendToOf(pl, la, bay, ox), null, 'landed in the other: not handed on (the reach walk alone picked the sender either way)');
}

/* ---------- THE WIRING: every surface reads the ONE pointer, writes it through the ONE setter ---------- */
{
  const fs = require('fs'), path = require('path');
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
  const build = src('build.js'), panel = src('workflowpanel.js'), world = src('world.js'), cmds = src('stationcommands.js'), outbox = src('windows/outbox.js'), wfw = src('windows/workflows.js');
  A.ok(/const fo = station\.propById\(connectFrom\);\s*if \(fo && fo\.t === 'outbox' && pp\.t === 'intake'\) \{ connectFrom = null; commitSendTo\(fo\.id, pid, ev\); return; \}/.test(build), 'BELT tool: the armed OUTBOX’s click on an INBOX is a SEND TO (before connectBelt is ever asked)');
  // (wave 2, build-13: the SELECT drag's SEND TO is THE HAND's — planHandGesture's 'send' plan and commitHandGesture's setSendTo; the
  //  propmove copy of it was unreachable but by a Shift let go before the release, and then sent against its own ghost)
  const plan2 = build.slice(build.indexOf('function planHandGesture('), build.indexOf('// R mid-drag: the corner turns'));
  const commit2 = build.slice(build.indexOf('function commitHandGesture('), build.indexOf('/* PICK WHAT GOES HERE'));
  A.ok(/if \(A\.t === 'outbox' && T\.t === 'intake' && typeof station\.setSendTo === 'function'\)/.test(plan2) && /return \{ ok: true, kind: 'send', to: T, why: 'SEND EVERY RESULT TO ' \+ mName\(T\.id\) \};/.test(plan2), 'SELECT: an OUTBOX dragged onto another line’s INBOX plans a SEND TO (it does not move)');
  A.ok(/else if \(plan\.kind === 'send'\) \{ res = station\.setSendTo\(d\.propId, plan\.to\.id\);/.test(commit2) && /strokeSendArc\(sendArc\(t, A, plan\.to\), col, now, 0\.95\)/.test(build), '…its release sets the SEND TO, and its ghost is the SEND TO arc + the verdict, before the drop');
  A.ok(!/intakeAt|commitSendTo/.test(build.slice(build.indexOf('function commitPropMove('), build.indexOf('function commitPaint('))), '…and a plain MOVE never sends');
  A.ok(/const r = typeof station\.setSendTo === 'function' \? station\.setSendTo\(outboxId, intakeId\) : null;/.test(build), 'one writer: station.setSendTo');
  A.ok(/drawLayer\('sendTo', \(\) => drawSendLinks\(t, now\)\);/.test(build) && /if \(!near\) continue;   \/\/ ONE-VOICE LAW/.test(build), 'build mode draws each SEND TO as an arc; its words only when you look at either end');
  A.ok(/if \(p\.t === 'outbox'\) return paintOutbox\(body, f, p\);/.test(panel) && /const r = H\.station\(\)\.setSendTo\(p\.id, b\.dataset\.sendto \|\| null\);/.test(panel) && /wf-sendwhy/.test(panel), 'the Workflow panel’s OUTBOX card: SEND TO chips (+ NOWHERE), a circle disabled with its reason inline');
  A.ok(/data-sendto="" aria-pressed="' \+ !ss \+ '">NOWHERE<\/button>/.test(panel) && /const no = typeof st\.sendToRefusal === 'function' \? st\.sendToRefusal\(o\.id, o\.sendTo\) : null;/.test(panel)
    && /' is off, so nothing is sent on — ' \+ esc\(ss\.why\)/.test(panel) && /\(sendsTo\.off \? ' · OFF' : ''\)/.test(panel), 'NOWHERE reads the doc pointer; a SEND TO the compiler has off is said OFF on the card and the tile (never "rides on")');
  // the dedupe key lives in routingKeyOf (inside the PLAN-POSTER block, where plan-poster.test.js runs it): its SEND TO part, and the poster offers under it
  A.ok(/function routingKeyOf\(plan\) \{[\s\S]*?\+ '\|' \+ JSON\.stringify\(plan\.sendTo \|\| \{\}\);\n  \}/.test(world) && /planPoster\.offer\(plan, routingKeyOf\(plan\)\)/.test(world), 'the plan poster re-posts on a SEND TO edit (outside plan.hash)');
  A.ok(/if \(p\.kind === 'handoff' && placeSendCrate\(p\)\) return;/.test(world) && /noteOutboxSink\(bx\.x, bx\.y\);/.test(world) && /fnow - c\.born >= HANDOFF_GRACE_MS/.test(world), 'the hand-off crate: held until the sending line’s crate sinks (or the grace runs out), then flown OUTBOX → INBOX');
  A.ok(/drawSendPlates\(\);/.test(world) && /const text = 'SENDS TO ' \+ \(\(station && station\.lineName \? station\.lineName\(st\.toLine\) \|\| station\.lineName\(st\.intakeId\) : null\) \|\| 'ANOTHER LINE'\);/.test(world) && /for \(const s of stat\) if \(s\.box\) taken\.push\(s\.box\);/.test(world), 'the OUTBOX plate SENDS TO LINE B, placed in the line plates’ own pass');
  A.ok(/: 'OUTBOX, then on to ' \+ to \+ ' \(SEND TO: that line’s own crew and budget work it next\)';/.test(cmds) && /out\.sendsWorkTo = /.test(cmds) && /P\.sendsReachedOf\(plan, lineId, pid\)/.test(cmds), 'station.map tells the agent where a line’s work goes after its OUTBOX — from the OUTBOX each step’s lane really ships into');
  A.ok(outbox.includes('/api/line-jobs?stream=') && outbox.includes('&runId=') && outbox.includes('lj.jobs.length === 1')
    && outbox.includes("WorkflowsWindow.openJob(resolvedJob.id, 'deliverables')") && /: 'SENT ON TO ' \+ word\(sj\.sentTo\)/.test(outbox) && /'FROM ' \+ word\(sj\.from\)/.test(outbox), 'DELIVERABLES: an exactly proved handed-on job opens in WORKFLOWS and says FROM / SENT ON TO');
  A.ok(/sj\.sentTo\.refused \? 'NOT SENT ON TO ' \+ word\(sj\.sentTo\) \+ ' — ' \+ sj\.sentTo\.refused/.test(outbox), '…and a REFUSED hand-off says NOT SENT ON TO, with why (10-11 repair)');
  A.ok(/if \(!p \|\| p\.kind !== 'handoff' \|\| !p\.workitemId \|\| !p\.lineId \|\| !p\.jobId\) return;/.test(wfw) && /handoffCrates\.set\(String\(p\.workitemId\), String\(p\.jobId\)\);/.test(wfw)
    && /loadJob\(jobId\)\.then\(job => \{\s*const run = job && job\.status === 'delivered' && job\.from \? \(job\.runs \|\| \[\]\)\[0\] : null;/.test(wfw) && /ReturnStore\.foldRow\(\{ runId: run\.runId/.test(wfw) && !/'\/api\/line-jobs\?line=' \+ encodeURIComponent\(line\) \+ '&limit=1'/.test(wfw),
    'a handed-on job’s delivered run lands in DELIVERABLES › TO REVIEW — read back from THE job the crate names (never the line’s newest record)');
  A.ok(/<span class="wfw-k">The job<\/span>/.test(wfw) && /' handed in<\/summary>/.test(wfw) && /\(typeof job\.handedIn === 'string' && job\.handedIn\) \? \{ original: job\.text, output: job\.handedIn \}/.test(wfw), 'a handed-on job shows the job as it first arrived, and what the sending line handed in (its record’s own field), apart');
  A.ok(/>Sent on to ' \+ esc\(lineWord\(job\.sentTo\)\)/.test(wfw) && /'From ' \+ esc\(lineWord\(job\.from\)\)/.test(wfw) && /'<p class="wfw-why wfw-sent warn">NOT sent on to ' \+ esc\(lineWord\(job\.sentTo\)\)/.test(wfw), 'WORKFLOWS: each result says where it came from / went on to — or that it was NOT sent on');
  A.ok(/handoffRunningHTML\(l, runningHandoff\(l\.key\)\)/.test(wfw),
    'a running hand-off is not the Commander’s sample: no "You sent", no sample STOP, never blocks sending — it has its own view');
  const runningJobSource = wfw.split('\n').find(line => line.includes('const runningJob ='));
  const chooseSample = jobs => require('node:vm').runInNewContext(runningJobSource + '\nrunningJob();', { S: { jobs } });
  const background = ['channel', 'schedule', 'trigger', 'steptest'].map(entry => ({ status: 'running', entry }));
  background.push({ status: 'running', entry: 'sendto', from: { line: 'a' } }, { status: 'paused', entry: 'sample' });
  A.eq(chooseSample(background), null, 'other live entries and paused jobs do not occupy the manual sample slot');
  A.eq(chooseSample(background.concat([{ id: 'sample', entry: 'sample', status: 'running' }])).id, 'sample', 'the actual running sample owns that slot');
  A.eq(chooseSample([{ id: 'legacy', status: 'running' }]).id, 'legacy', 'an older sample record without entry metadata still owns the slot');
  A.ok(/\(job\.from \? '' : '<button type="button" class="bb refit-primary" data-act="again"/.test(wfw) && /if \(!l \|\| !S\.job \|\| S\.job\.from\) return; S\.draft/.test(wfw), 'a handed-on job is never re-sent as a plain sample (its input is what the sending line delivered)');
}

A.report('line-sendto.test');
