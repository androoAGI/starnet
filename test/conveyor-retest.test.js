/* test/conveyor-retest.test.js — what the 2026-09-28 end-to-end retest of the conveyor audit fixes caught (a fresh station,
   real clicks, a REVISION LOOP stamped and crewed, a hand-built split → join, one real job through the line).

   B3  — the "+" between a REVISION LOOP's two bays in the starter room passed the lane check, and the insert then refused
         NO_ROOM. canInsertBayBetween now runs the REAL insert on a throwaway copy of the floor.
   B1  — the line cards were fit-checked only when the palette rendered: an UNDO left eight cards claiming they fit.
   R3  — SCHEDULE OFF was a floor-wide flag: every INBOX said it, even a line with no schedule (that one is simply unfed).
   R3  — the station's SHIPPED pallet counted a step test ("a test is not put in the OUTBOX").
   R3  — the INBOX card posted silently under an open question in COMMS: the click read as dead.
   X1  — "sample" wording survived around the RUN ONE REAL JOB control, and the result named the agent by its id.
   R2  — the OUTBOX step note named the upstream agent by its internal id ("after AGENT").
   P1  — a split whose branches lead to bays with no agent yet listed both branches as "nowhere yet".
   P5  — "drop it ON a belt" pointed at nothing: belts now wear a dashed edge while a junction is in hand.
   B4  — the spacing advice while a dock is in hand.
   Plus: the dock WOULD-caption hangs UNDER its tile (a crewed bay's nameplate owns the space above) and never prints over a
   live plate; the FINISH card never parks over a workflow machine; the plate re-reads its numbers when REFIT hands the floor back. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const build = read('frontend/app/build.js'), world = read('frontend/app/world.js'), chat = read('frontend/app/chat.js');
const ghost = read('frontend/app/ghostline.js'), outbox = read('frontend/app/windows/outbox.js');

/* ---------- B3: the "+" dry run is the real insert ---------- */
{
  // the starter room as a fresh station has it, a REVISION LOOP stamped into it (the retest's floor)
  const s = WM.create();
  for (const [t, x, y, w, h] of [['desk', 8, 1, 2, 1], ['war_intelcab', 1, 0, 1, 2], ['gigs_servercart', 1, 9, 1, 1], ['comms_dish', 14, 0, 2, 2],
    ['workbench', 3, 1, 2, 1], ['studio', 14, 8, 2, 2], ['plant', 0, 0, 1, 1], ['plant', 17, 0, 1, 1], ['desk', 5, 1, 2, 1], ['desk', 10, 1, 2, 1]])
    s.addProp({ t, x, y, w, h, block: true });
  A.ok(s.stampBlueprint('revision_loop', 0, 3).ok, 'fixture: REVISION LOOP stamps into the starter room');
  const bays = s.props().filter(p => p.t === 'bay').sort((a, b) => a.x - b.x), inbox = s.props().find(p => p.t === 'intake');
  const doc0 = JSON.stringify(s.serialize()), undo0 = s.canUndo();
  const mid = s.canInsertBayBetween(bays[0].id, bays[1].id, { w: 2, h: 2 });
  A.ok(!mid.ok && mid.error === 'NO_ROOM', 'WRITER → REVIEWER: the lane is fine but there is no room — the dry run now says so (NO_ROOM)');
  A.ok(/Conveyors › MACHINES › BAY/.test(mid.msg), '…with the way out in its reason (the "+" tip)');
  A.ok(s.canInsertBayBetween(inbox.id, bays[0].id, { w: 2, h: 2 }).ok, 'INBOX → WRITER: room there, the "+" stays live');
  A.eq(JSON.stringify(s.serialize()), doc0, 'a dry run changes nothing on the real floor');
  A.eq(s.canUndo(), undo0, '…and burns no undo slot');
  const real = s.insertBayBetween(bays[0].id, bays[1].id, { w: 2, h: 2 });
  A.ok(!real.ok && real.error === mid.error, 'the real insert refuses exactly what the dry run refused');
  A.ok(/const insertProbe = \{ seq: -1, memo: \{\} \}/.test(read('frontend/app/worldmodel.js')) && /makeStation\(clone\(doc\)\)\.insertBayBetween\(fromId, toId, size\)/.test(read('frontend/app/worldmodel.js')), 'the dry run is the real insert on a throwaway copy, cached per floor version');
  A.ok(/const sp = propSpec\('bay'\);[\s\S]{0,160}station\.canInsertBayBetween\(fromId, toId, \{ w: sp\.w, h: sp\.h, block: sp\.blocks !== false \}\)/.test(build), 'the panel asks with the SAME bay size insertBay places');
}

/* ---------- B1: line cards stay honest as the floor changes ---------- */
{
  const fit = build.slice(build.indexOf('  function setLineTileFit(b, bp) {'), build.indexOf('  function makeRoomFor(bpId, ev) {'));
  // (phase E, 2026-09-29: the card's fit is the drawn-shape scan the ghost snaps to OR the engine's laid-out answer — a click
  // places the line either way, so the card never says NO ROOM for a line a click can place)
  A.ok(/const drawn = lineFits\(bp\.id\)/.test(fit) && /const fits = drawn \|\| !!\(laid && laid\.ok\)/.test(fit) && /b\.classList\.toggle\('nofit', !fits\)/.test(fit), 'a card reads its fit from the same scan the ghost snaps to');
  // (2026-09-30: the fit is said on the tile's own small line — its steps and size again once the drawn shape fits)
  A.ok(/if \(drawn\) \{ say\(stat \? stat\.dataset\.rest \|\| '' : ''\); if \(make\) make\.remove\(\); return; \}/.test(fit) && /if \(fits\) \{[^}]*if \(make\) make\.remove\(\);/.test(fit), 'a card that fits again sheds NO ROOM and MAKE ROOM');
  A.ok(/b\.after\(mk\)/.test(fit) && /mk\.onclick = e => makeRoomFor\(bp\.id, e\)/.test(fit), 'a card that stops fitting gains MAKE ROOM FOR IT as a sibling button');
  A.ok(/cell\.appendChild\(b\); grid\.appendChild\(cell\);\s*setLineTileFit\(b, bp\);/.test(build), 'every card is fit-checked as it renders');
  const onChange = build.slice(build.indexOf('unsub = station.onChange('), build.indexOf('unsub = station.onChange(') + 500);
  A.ok(/clearLineFields\(\);[\s\S]{0,120}scheduleLineFitSync\(\);/.test(onChange), 'every floor edit (UNDO included) re-syncs the cards on screen');
  A.ok(/for \(const b of root\.querySelectorAll\('\.refit-linetile\[data-line\]'\)\)/.test(build), '…every line card on screen');
}

/* ---------- R3: SCHEDULE OFF belongs to one line ---------- */
{
  A.ok(/function schedOffFor\(intakeId, plan\)/.test(world) && /pl\.lineOfProp\[d\] === line/.test(world), 'a waiting routine belongs to the line its dock sits on');
  A.ok(/label: schedOffFor\(p\.id\) \? 'SCHEDULE OFF — CLICK' : 'NO FEED — CLICK'/.test(world), 'each INBOX asks for ITS line (the floor-wide flag labelled every INBOX)');
  A.ok(/schedOff: !!\(feedState\.known && !feedState\.fed && schedOffFor\(ismp\.id\)\)/.test(world), 'the INBOX card offers the scheduling switch only on that line');
  A.ok(/schedOffFor: \(intakeId, plan\) => schedOffFor\(intakeId, plan\)/.test(world), 'REFIT asks with ITS plan (a line stamped this session is not in the frozen world yet)');
  A.ok(/opts\.world\.schedOffFor\(c\.intakes\[0\], valPlan\)/.test(build) && /st\.schedOff \? '② SCHEDULING IS OFF — TURN IT ON'/.test(build), 'the FINISH card says scheduling is off instead of "choose what starts this line"');
  A.ok(/\(tr\.offSchedules \|\| \[\]\)\.length \? 'SCHEDULE OFF — this line’s schedule is saved/.test(read('frontend/app/workflowpanel.js')), 'the INBOX section says SCHEDULE OFF, not "NO FEED — nothing is wired"');
  // the fact it rests on: every INBOX and every dock of a line map to the SAME line id
  const s = WM.create(), z = s.rooms()[0].rects[0];
  let ok = null;
  for (let y = z.y1; y <= z.y2 && !ok; y++) for (let x = z.x1; x <= z.x2 && !ok; x++) { const r = s.stampBlueprint('research_line', x, y); if (r.ok) ok = r; }
  A.ok(!!ok, 'fixture: RESEARCH LINE stamps');
  const plan = P.compileRoutingPlan(s.projectGeometry());
  const inb = s.props().find(p => p.t === 'intake'), docks = s.props().filter(p => p.t === 'bay');
  A.ok(!!plan.lineOfProp[inb.id] && docks.every(d => plan.lineOfProp[d.id] === plan.lineOfProp[inb.id]), 'lineOfProp puts the INBOX and each of its docks on one line');
}

/* ---------- R3: the SHIPPED pallet never counts a test; the plate re-reads on REFIT exit ---------- */
A.ok(/RunOutcome\.ofRow\(r\)\.ok : r\.reason === 'done'\) && r\.stepTest !== true &&/.test(world), 'a step-test run is never a shipment on the pallet (and only a SUCCEEDED run is one: typed-outcomes)');
A.ok(/function start\(\) \{[\s\S]{0,420}lineStatsSoon\(\);/.test(world), 'the floor coming back to life re-asks its line numbers');

/* ---------- R3 + X1: the INBOX card never answers for the Commander, and it says where it went ---------- */
{
  const sc = chat.slice(chat.indexOf('  function sampleCard(opts) {'), chat.indexOf('  /* W3 — THE DELIVERY CARD'));
  A.ok(/const sayCovered = \(\) => \{ if \(covered\(\)/.test(sc) && /under the question your agent is asking/.test(sc), 'an open question over COMMS: a notice says the card is under it');
  A.ok(/autoscroll\(\); sayCovered\(\); return;/.test(sc) && /autoscroll\(\);\s*sayCovered\(\);\s*\}$/.test(sc.trimEnd()), '…on a repeat click and on a fresh card');
  A.ok(!/Dialogue\.close\(\)/.test(sc) && !/finishPick/.test(sc), '…and it never closes or answers that question itself');
  A.ok(!/the sample is riding|sample delivered|the sample rode/.test(sc), 'no "sample" left around RUN ONE REAL JOB');
  A.ok(/'⌛ the job is riding the line…'/.test(sc) && /'✔ job delivered — ' \+ who \+ ' finished the last step'/.test(sc), 'the card says job, and who finished the last step');
  A.ok(/App\.agents\(\) \|\| \[\]\)\.find\(a => a && a\.id === whoId\)/.test(sc), '…by NAME (the seeded hero\'s id is literally "agent")');
  A.ok(/'③ RUNNING — THE JOB IS RIDING THE LINE…'/.test(build) && /'✓ DELIVERED — SEND ANOTHER'/.test(build), 'the FINISH card says job too (SEND ANOTHER, org P17), and ✓ DELIVERED like WORKFLOWS so it stays one line (org D4)');
  A.ok(build.includes(".replace('SEND ANOTHER', '<span class=\"fl-again\">SEND ANOTHER</span>')") && /\.refit-finline \.fl-step \.fl-again \{[^}]*color: var\(--ph\)/.test(read('frontend/css/refit.css')), 'SEND ANOTHER keeps a key\'s amber beside the green ✓ DELIVERED (org D8 polish)');
  A.ok(build.includes('title="${esc(sampleTip)}"><span class="fl-lbl">${esc(sampleTxt).replace(') && build.includes("SEND ANOTHER</span>')}</span></button>"),
    '③ rides ONE span inside the flex .fl-step, so the space in "✓ DELIVERED — SEND ANOTHER" never collapses beside the amber span (org g7 D1)');
  A.ok(!/use Run a sample job/.test(build) && /STEP THROUGH and SEND A REAL JOB run it for real/.test(build), 'the TEST tooltip names the modes that run for real');
}

/* ---------- R2: the step note names the agent ---------- */
A.ok(/after ' \+ String\(agentName\(hand\.from\)\)\.toUpperCase\(\)/.test(outbox), 'the OUTBOX step note says the upstream agent\'s NAME, not its id');

/* ---------- P1: a branch to a bay with no agent yet is named, never "nowhere" ---------- */
{
  A.ok(/plan\.unboundBayTile = unboundBayTile;/.test(read('frontend/app/pipeline.js')), 'the plan carries the uncrewed bays\' ring tiles (legibility, outside the hash)');
  A.ok(/if \(emptyAt\[k\]\) \{ to = 'to a BAY with no agent yet'; kind = 'bay'; dock = emptyAt\[k\]; break; \}/.test(build), 'the exit walker names a bay with no agent yet');
  A.ok(/return \{ dir: d, dock: ex\.dock \|\| null, label:/.test(build), 'each junction lane carries the dock it lands on');
  const panel = read('frontend/app/workflowpanel.js');
  A.ok(/function laneName\(f, l, arrow\)/.test(panel) && /dockLabel\(f, l\.dock\) \+ \(d\.agentId \? '' : ' \(no agent yet\)'\)/.test(panel), 'the panel names that BAY its own way ("→ BAY 2 (no agent yet)")');
  A.ok(/esc\(laneName\(f, l, true\)\)/.test(panel) && /esc\(laneName\(f, l, false\)\)/.test(panel), '…in the SPLITTER branches and the FILTER route chips');
  // the fact: an uncrewed bay's belt ring tiles are on the plan, and the hash does not move for them
  const s = WM.create(), z = s.rooms()[0].rects[0];
  let ok = null;
  for (let y = z.y1; y <= z.y2 && !ok; y++) for (let x = z.x1; x <= z.x2 && !ok; x++) { const r = s.stampBlueprint('research_line', x, y); if (r.ok) ok = r; }
  const plan0 = P.compileRoutingPlan(s.projectGeometry());
  const empty = s.props().filter(p => p.t === 'bay');
  A.ok(Object.values(plan0.unboundBayTile || {}).some(id => id === empty[0].id), 'a bay with no agent has its ring belt tiles on the plan');
}

/* ---------- B4: TOO CLOSE only when the shared tile is the bay's way in ---------- */
{
  // the retest's floor: two bays one tile apart, the BELT tool's lane going ROUND the shared column, and no INBOX at all
  const s = WM.create();
  A.ok(s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 50, y2: 14 } }).ok, 'fixture: a deck');
  const c = s.addProp({ t: 'bay', x: 33, y: 3, w: 2, h: 2, block: true }), d = s.addProp({ t: 'bay', x: 36, y: 3, w: 2, h: 2, block: true });
  A.ok(c.ok && d.ok, 'fixture: two bays with ONE empty tile between them');
  s.assignPropAgent(c.id, 'c1'); s.assignPropAgent(d.id, 'd1');
  for (const [x, y, dir] of [[34, 2, 'E'], [35, 2, 'E'], [36, 2, 'S']]) s.setBelt(x, y, dir);
  const plan = P.compileRoutingPlan(s.projectGeometry());
  const errOf = id => (plan.errors || []).filter(e => e.propId === id).map(e => e.code);
  A.eq((plan.dockChains[c.id] || {}).next, [d.id], 'the lane round the shared tile hands the first bay\'s work to the second');
  A.ok(errOf(c.id).indexOf('BAY_NOT_FED') >= 0 && errOf(c.id).indexOf('BAY_TOO_CLOSE') < 0, 'the first bay has no INBOX: it is NOT FED — never "too close" (' + errOf(c.id).join(',') + ')');
  A.eq(errOf(d.id).filter(x => /FED|CLOSE/.test(x)), [], 'the second bay is fed by the first');
  A.ok(/\(sharedRing\[k\] === 'src' \|\| \(ringOwners\[k\] \|\| \[\]\)\.length > 1\) && aimsInto\(t, b\.propId\)/.test(read('frontend/app/pipeline.js')), 'TOO CLOSE needs the shared tile to aim INTO the bay');
}

/* ---------- the loop's sentence reads as one sentence ---------- */
{
  const W = require('../frontend/app/workflowline.js');
  const s = WM.create(), z = s.rooms()[0].rects[0];
  let ok = null;
  for (let y = z.y1; y <= z.y2 && !ok; y++) for (let x = z.x1; x <= z.x2 && !ok; x++) { const r = s.stampBlueprint('revision_loop', x, y); if (r.ok) ok = r; }
  A.ok(!!ok, 'fixture: REVISION LOOP stamps');
  const bays = s.props().filter(p => p.t === 'bay').sort((a, b) => a.x - b.x);
  s.assignPropAgent(bays[0].id, 'nova'); s.assignPropAgent(bays[1].id, 'rev');
  const geo = s.projectGeometry(), plan = P.compileRoutingPlan(geo), f = W.lineFlow(plan, P.lineComponents(geo)[0], P, geo.props);
  const hands = { [bays[0].id]: 'a 200-word draft', [bays[1].id]: 'the approved draft' };
  const said = W.sentenceText(W.howItRuns(f, { nameOf: a => String(a).toUpperCase(), handsOf: id => hands[id] || null }));
  A.ok(/NOVA writes it up, handing off a 200-word draft; REV reviews it and sends it back to NOVA until it is approved \(3 tries max\), then hands off the approved draft;/.test(said), 'the reviewer\'s hand-off follows its loop clause (' + said + ')');
  A.ok(!/handing off the approved draft and sends it back/.test(said), '…never glued in front of it');
}

/* ---------- P5 + B4: what the floor says while a machine is in hand ---------- */
// (a junction held in the PROP tool or in THE HAND, 2026-10-10)
A.ok(/if \(placingProp\(\) && JUNCTION_TAG_TYPES\[propType\] && belts\.length\)/.test(build) && /const placingProp = \(\) => tool === 'prop' \|\| !!hand;/.test(build) && /ctx\.setLineDash\(\[3 \/ zoom, 2 \/ zoom\]\)/.test(build), 'a junction in hand: every belt tile wears a dashed edge (drawn geometry, never a glow)');
A.ok(/const RING_DOCK_T = \{ bay: 1, intake: 1, outbox: 1 \}/.test(build) && /'CLOSE TO THE ' \+ String\(propLabel\(near\.t\)\)\.toUpperCase\(\) \+ ' — LEAVE 2 TILES OR THEIR BELTS TOUCH'/.test(build), 'a dock in hand near another dock: the spacing advice (never a refusal)');

/* ---------- captions + the FINISH card keep off what the builder needs to see ---------- */
{
  // (2026-09-30: a caption is a PLATE — the same rect is offered to the arbiter and painted)
  A.ok(/note\(x, y, '◇ ' \+ who \+ ' WOULD RUN IT', true\)/.test(ghost) && /y: n\.below \? \(n\.y \+ 1\) \* T \+ 3 : n\.y \* T - 3 - rise - ph/.test(ghost), 'a dock caption hangs under its tile (the nameplate owns the space above)');
  A.ok(/if \(say\) \{ if \(say\(b, paintNote\.bind\(null, n, k, b\)\) !== false\) placed\.push\(b\); \} else \{ paintNote\(n, k, b\); placed\.push\(b\); \}/.test(ghost), '…and the arbiter is told where it really is (a caption it declines holds no spot, review 10-14)');
  A.ok(/ghost\.draw\(ctx, now, T, capPx, plates\.length \? \(bx, paint\) => \{ if \(onPlate\(bx\)\) return false; paint\(\); return true; \} : null, \(bx, n\) => captionInStation\(bx, n, plates\)\)/.test(world), 'on the live floor a caption never prints over a line plate, and is kept on the station (walk 10-14 #13)');
  const fitSrc = world.slice(world.indexOf('function captionInStation('), world.indexOf('function stationRoomBoxes('));
  A.ok(fitSrc.length > 200 && fitSrc.length < 4000, 'world.js has one bounded captionInStation');
  A.ok(/GhostLine\.onStation\(b, n, stationRoomBoxes\(\), T, onStage\)/.test(fitSrc), 'a caption is held inside its room, and every part of it over a room (GhostLine.onStation, shared with BUILD MODE; ui-layout-fit runs it) — never across the hull into space');
  A.ok(/\(4 - panX\) \/ scale/.test(fitSrc), '…and on the visible stage, never past its frame');
  A.ok(/nagLabelBoxes\.some\(hit\)/.test(fitSrc) && /return null;/.test(fitSrc), 'a spot on a routing callout (NO FEED — CLICK) is refused, so the caption moves to its next spot');
  A.ok(/nagLabelBoxes = labels\.map\(/.test(world), 'drawRoutingNags records where its labels landed');
  A.ok(/bayPlateBox\(d\)/.test(fitSrc), '…and never on the name plate of a bay (its agent name)');
  A.ok(/const capPx = 14 \* \(window\.devicePixelRatio \|\| 1\) \* \(\(typeof U !== 'undefined' && U\.uiZoom && U\.uiZoom\(\)\) \|\| 1\) \/ \(scale \|\| 1\);/.test(world), '…and it reads at 14px on screen whatever the zoom (never a plate twice the size of the floor\'s own nags)');
  const pos = build.slice(build.indexOf('  function positionFinCard() {'), build.indexOf('  /* the delivery-retirement hook'));
  A.ok(/const FIN_AVOID = \{ intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 \}/.test(pos) && /spots\.find\(clear\) \|\| spots\[0\]/.test(pos), 'the FINISH card takes the first spot that covers no workflow machine');
  A.ok(/'\|' \+ geoVer \+ coachKey/.test(pos), '…and moves when a machine is placed under it');
}

A.report('conveyor-retest.test');
