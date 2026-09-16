/* node test/sightline.test.js — the 2026-08-17 world-physics pass, three reports from Andrew:

     1. "the agents seem to walk through one another"
     2. "they all go to the conveyor if one is spawned, which is not one of the idle wandering activities"
     3. "they talk to each other through walls"

   world.js is a browser IIFE (can't require under node), so this follows the repo's established
   split: the sightline WALK is a marked PURE block (both the floor test and the seam test are
   injected) extracted from the SOURCE and executed here — the shipped code is under test, not a
   copy — and the wiring around it is source-locked. The behaviours themselves live over TIME on a
   real floor, so the live proof runs through the World._dbgLos / _dbgSpacing / _dbgBeltWatch probes
   this file also locks into existence. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');

// ---- extract + execute the marked pure block from the real source ----
const BEGIN = 'LOS-PURE-GEOMETRY-BEGIN', END = 'LOS-PURE-GEOMETRY-END';
const i0 = src.indexOf(BEGIN), i1 = src.indexOf(END);
A.ok(i0 >= 0 && i1 > i0, 'world.js carries the LOS-PURE-GEOMETRY extraction markers');
const block = src.slice(src.indexOf('*/', i0) + 2, src.lastIndexOf('/*', i1));
A.ok(/function losWalk\(/.test(block), 'the marked block holds losWalk');
const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // purity is a CODE property — comments may name geo/U freely
A.ok(!/\bgeo\.|\bself\.|\bU\.|\bZones\.|\bdocument\b|\bwindow\b/.test(codeOnly), 'the block is PURE (no module state / RNG / DOM — safe to execute standalone)');
const { losWalk } = eval('(function(){' + block + '\nreturn { losWalk };})()');

/* ---- a synthetic station, in exactly the two pieces geo hands losClear ----
   zone id per tile (null = wall/void), plus canStep's rule: same zone always, different zones only
   through a registered door pair. This mirrors worldmodel.projectGeometry's zoneGrid + canStep, which
   is the whole point — the sightline must fail where WALKING already fails.

     cols 0..8   room A      col 9 WALL      cols 10..18  room B
     the wall has ONE hole at row 4 (a doorway tile belonging to A, linked to B) */
const COLS = 19, ROWS = 10;
const zone = (x, y) => {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null;
  if (x === 9) return y === 4 ? 'A' : null;   // the wall column, with one doorway tile
  return x < 9 ? 'A' : 'B';
};
const doors = new Set(['9,4>10,4', '10,4>9,4']);
const floorFn = (x, y) => zone(x, y) != null;
const stepFn = (x1, y1, x2, y2) => {
  const za = zone(x1, y1), zb = zone(x2, y2);
  if (zb == null) return false;
  if (za === zb) return true;
  return doors.has(x1 + ',' + y1 + '>' + x2 + ',' + y2);
};
const los = (ax, ay, bx, by) => losWalk(ax, ay, bx, by, floorFn, stepFn);

// ---- inside one room, you can see ----
A.ok(los(1, 1, 7, 1), 'a straight line across open floor is clear');
A.ok(los(1, 1, 7, 8), 'a diagonal across open floor is clear');
A.ok(los(3, 3, 3, 3), 'a body always sees its own tile');
A.ok(los(1, 1, 2, 1) && los(2, 1, 1, 1), 'sight is symmetric on adjacent tiles');

// ---- THE BUG: through the wall ----
A.ok(!los(8, 1, 10, 1), 'THE REPORT: two bodies one tile apart either side of a wall CANNOT see each other');
A.ok(!los(2, 7, 16, 7), 'a long line straight through the wall column is blocked');
A.ok(!los(8, 1, 10, 8), 'a diagonal that crosses the wall is blocked');
// this is the exact shape planBorderMeeting produced: each body on its OWN side of the shared edge
A.ok(!los(8, 2, 10, 2), 'the D3 border pair (own side of the shared edge) is blocked wherever that edge is wall');

// ---- but a DOORWAY is not a wall ----
A.ok(los(8, 4, 10, 4), 'straight through the doorway row, they DO see each other');
A.ok(los(9, 4, 10, 4), 'standing in the doorway sees into the next room');

// ---- a sealed room stays sealed: strip the door and the same pair goes dark ----
const sealedStep = (x1, y1, x2, y2) => (zone(x2, y2) != null && zone(x1, y1) === zone(x2, y2));
A.ok(!losWalk(8, 4, 10, 4, floorFn, sealedStep), 'a room whose boundary doors are dropped (a SEALING airlock) blocks sight, exactly as it blocks walking');

// ---- void / off-floor endpoints are never in sight ----
A.ok(!los(1, 1, 9, 1), 'a tile that is wall is not a sightline endpoint');
A.ok(!los(-1, 1, 1, 1), 'off-grid coordinates cannot see anything');
A.ok(!los(1, 1, 40, 1), 'a target outside the station is never in sight');

// ---- a single pillar occludes exactly the tiles behind it ----
const pillar = (x, y) => floorFn(x, y) && !(x === 4 && y === 4);
const pStep = (x1, y1, x2, y2) => pillar(x2, y2) && stepFn(x1, y1, x2, y2);
A.ok(!losWalk(2, 4, 7, 4, pillar, pStep), 'an unwalkable tile ON the line blocks it');
A.ok(losWalk(2, 6, 7, 6, pillar, pStep), 'a line that misses the pillar is unaffected');

/* ---- WIRING (1): a wall is a wall for every cross-body beat ---- */
A.ok(/function losClear\(ax, ay, bx, by\)/.test(src) && /return losWalk\(ax, ay, bx, by, floor, geo\.canStep\)/.test(src),
  'losClear injects the LIVE bake: zoneGrid for floor, geo.canStep for the room seams');
A.ok(/x >= 0 && y >= 0 && x < geo\.COLS && y < geo\.ROWS && geo\.zoneGrid\[geo\.idx\(x, y\)\] != null/.test(src),
  'the floor test BOUNDS-CHECKS before indexing — geo.idx is row-major with no range check, so idx(-1,y) aliases onto the previous ROW and would report void as floor');
A.ok(/typeof geo\.canStep !== 'function'\) return true;/.test(src),
  'a missing geometry shape FAILS OPEN — a geo gap must never freeze the social engine into permanent silence');
const neighbors = A.fnBody(src, 'function neighborsOf(');
A.ok(neighbors && neighbors.length < 2000, 'neighborsOf body scanned cleanly');
A.ok(/if \(!bodiesInSight\(body, other\)\) continue;/.test(neighbors),
  'the neighbour scan — the feed for the glance, the huddle, the watch and the follow — requires a wall-free sightline');
A.ok(/tileInZone\(zone, ot\.x, ot\.y\)/.test(neighbors),
  'and it still enforces containment: the sightline is an ADDITION to zone membership, never a replacement');
const border = A.fnBody(src, 'function planBorderMeeting(');
A.ok(/if \(!losClear\(ta\.x, ta\.y, tb\.x, tb\.y\)\) continue;/.test(border),
  'the BORDER meeting — which walked both bodies to their own side of a shared edge — now needs them to see across it');
A.ok(border.indexOf('borderTileFor(ra, edge') < border.indexOf('losClear(ta.x'),
  'the sightline is checked on the RESOLVED tiles, after the edge geometry — never on the bodies\' start positions');
/* The three beats that run their OWN body scan instead of neighborsOf need the sightline applied at
   their own scan — the gate on neighborsOf cannot reach them. Missing one is how a "fixed" law leaks. */
const ack = A.fnBody(src, 'function maybeAcknowledge(');
A.ok(/if \(!bodiesInSight\(me, other\)\) continue;/.test(ack),
  'the passing acknowledgement (its own scan, runs every tick) requires sightline — otherwise a body waves at someone in the next room');
const greet = A.fnBody(src, 'function greetNewcomer(');
A.ok(/if \(!bodiesInSight\(other, newBody\)\) continue;/.test(greet),
  'THE WELCOME picks a greeter that can SEE the arrival — without this planHuddle\'s gate just fails the plan and a spawn in another room gets no welcome at all');
const huddle = A.fnBody(src, 'function planHuddle(');
A.ok(/if \(!losClear\(ta\.x, ta\.y, tb\.x, tb\.y\)\) return false;/.test(huddle),
  'a huddle pair must see each other (each tile is resolved in its OWN zone, so they could straddle a wall)');

/* ---- WIRING (2): bodies are solid ----
   movementBlockers is a snapshot taken when a path is PLOTTED; nothing re-read it while the legs ran,
   which is the whole reason bodies interpenetrated. The resolve therefore has to run after movement,
   every frame, at the END of the tick — not inside any one body's stepper. */
const sep = A.fnBody(src, 'function separateBodies(');
A.ok(sep && sep.length < 5500, 'separateBodies body scanned cleanly');
A.ok(/const PERSONAL_TILES = 0\.8;/.test(src), 'personal space is UNDER one tile, so adjacent-tile beats (huddle/border/the gathering ring) are untouched by construction');
const tickFn = A.fnBody(src, 'function tick(dt, now)');
A.ok(/separateBodies\(now\);\s*if\(agent\)finishGait\(agent\);for\(const body of crew\)finishGait\(body\);\s*\}$/.test(tickFn),
  'separation is the final position change; gait measurement follows resolved displacement');
A.ok(/const anchored = b => !!\(b\.sitting \|\| b\.seated\);/.test(sep),
  'ONLY a seated body is an anchor — a social/gather exemption would skip separation for the whole walk in, which is exactly when two bodies cross (caught live by dev/bodyphysics.mjs)');
A.ok(/if \(pa && pb\) continue;/.test(sep), 'two anchored bodies are left alone rather than fought over');
A.ok(/const SEP_PASSES = 4;/.test(src) && /for \(let pass = 0; pass < SEP_PASSES; pass\+\+\)/.test(sep) && /if \(!touched\) break;/.test(sep),
  'separation RELAXES over several sweeps (one sweep leaves a pile of three short of the law) and early-outs when nothing overlapped');
const push = A.fnBody(src, 'function pushApart(');
A.ok(/if \(dx && nudgeBody\(b, dx, 0\)\) return true;/.test(push) && /if \(dy && nudgeBody\(b, 0, dy\)\) return true;/.test(push),
  'a push refused by containment falls back to sliding ALONG the obstacle — a refused push would otherwise leave the overlap forever');
A.ok(/if \(movedA && !movedB && sa === 1\) pushApart\(a, -ux \* push, -uy \* push\);/.test(sep),
  'and a partner that could not move hands its share to the one that could');
A.ok(/d2 = 1; \}   \/\/ exactly coincident: a STABLE per-pair axis, never RNG/.test(sep),
  'exactly-coincident bodies separate on a deterministic axis (invariant I3 — no RNG in the engine core)');
const nudge = A.fnBody(src, 'function nudgeBody(');
A.ok(/if \(!geo\.walkable\(t\.x, t\.y, blocked\)\) return false;/.test(nudge),
  'CONTAINMENT: a push that would leave the floor is DROPPED, never clamped — separation can put nobody in a wall');
A.ok(/const SEP_JAM_MS = 2500;/.test(src) && /seizeFromIdle\(b\);/.test(sep),
  'a walker shoved continuously (its destination taken) gives up on the leg and re-decides — no push/counter-push standoff');
A.ok(/if \(b\.goal === 'social' \|\| b\.goal === 'gather'\) \{ b\.sepSince = 0; continue; \}/.test(sep),
  'but NEVER a body mid-encounter: seizeFromIdle leaves b.social set, and encounterBroken tests exactly `social == null`, so releasing one here would half-kill the beat while it holds the single station slot');
// the claim is module-level state held by a body reference — the same shape as occupiedSeats, and the
// same leak: a body dropped by spawn()/loadStation() would hold the slot until its 45s expiry.
A.ok((src.match(/beltWatch = null;/g) || []).length >= 3,
  'the belt-watch claim is cleared on BOTH session resets (spawn + loadStation), not only lazily expired');
A.ok(/if \(!geo \|\| !geo\.zoneGrid \|\| !geo\.COLS \|\| !geo\.ROWS \|\|/.test(src),
  'the fail-open guard covers COLS/ROWS too — the bounds test reads them, and `x < undefined` is false, which would silence the whole social engine instead of failing open');

/* ---- WIRING (3): the conveyor is bounded ----
   Watching a belt was the one ambient-curiosity target with unlimited supply: the other candidate is
   capped by habituation AND by ownership, planPOI is consulted twice per idle re-decide, and every body
   runs the same engine — so laying belt to a new bay switched the candidate on for the whole crew. */
const poi = A.fnBody(src, 'function planPOI(');
A.ok(/const beltOk = now >= \(self\.beltWatchCd \|\| 0\) && !beltWatchTaken\(now\);/.test(poi),
  'the belt candidate is gated on BOTH a per-body cooldown and the station-wide single-watcher claim');
A.ok(/const inBelts = beltOk \? belts\.filter/.test(poi), 'and the gate is applied before the candidate is built, not after');
A.ok(/beltWatch = \{ body: self, until: now \+ 45000 \}; self\.beltWatchCd = now \+ U\.irnd\(BELT_WATCH_CD_MIN, BELT_WATCH_CD_MAX\);/.test(poi),
  'both are ARMED only once a watch actually commits (a failed pick must not spend the cooldown)');
A.ok(/const BELT_WATCH_CD_MIN = 180000, BELT_WATCH_CD_MAX = 360000;/.test(src), 'the per-body cooldown is minutes, not seconds — one look, then go and do something else');
const taken = A.fnBody(src, 'function beltWatchTaken(');
A.ok(/b\.goal !== 'watch' \|\| now > beltWatch\.until/.test(taken),
  'the claim is validated LAZILY against live state + an expiry, so no exit path has to remember to release it');

/* ---- the live probes: none of the three is provable from source alone ---- */
A.ok(/_dbgLos: \(ax, ay, bx, by\) => losClear\(/.test(src), 'the sightline can be asked about the REAL bake from a live soak');
A.ok(/_dbgSpacing: \(\) => \{/.test(src) && /personalPx:/.test(src), 'the closest-pair probe reports against the law\'s own threshold (min >= personalPx IS the no-overlap proof)');
A.ok(/_dbgBeltWatch: \(\) => \{/.test(src) && /watching:/.test(src), 'the belt probe names every body currently watching — a congregation is visible, not inferred');

A.report('sightline.test');
