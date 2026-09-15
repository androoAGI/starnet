/* node test/idle-life-regressions.test.js — proof locks for the five post-handoff audit fixes.
   Geometry behavior lives in zones.test.js; this file locks the shipped leisure decision and the
   soak/instrumentation clauses that make the live verdict truthful. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const soak = fs.readFileSync(path.join(__dirname, '../dev/idlesoak.mjs'), 'utf8');

// Extract the actual pure recent-choice predicate from the shipped browser source.
const BEGIN = 'FUN-REPEAT-PURE-BEGIN', END = 'FUN-REPEAT-PURE-END';
const i0 = world.indexOf(BEGIN), i1 = world.indexOf(END);
A.ok(i0 >= 0 && i1 > i0, 'world.js carries the FUN-REPEAT-PURE extraction markers');
const block = world.slice(world.indexOf('*/', i0) + 2, world.lastIndexOf('/*', i1));
A.ok(/function funRecentlyUsed\(/.test(block), 'the marked block holds funRecentlyUsed');
const { funRecentlyUsed } = eval('(function(){' + block + '\nreturn { funRecentlyUsed };})()');
A.eq(funRecentlyUsed('lounge', 100000, 'lounge', 99999), true, 'the same couch is marked recent during its cooldown');
A.eq(funRecentlyUsed('lounge', 100000, 'lounge', 100000), false, 'the couch becomes eligible exactly when the cooldown expires');
A.eq(funRecentlyUsed('lounge', 100000, 'arcade-1', 99999), false, 'a different leisure choice remains eligible');
A.ok(/FUN_REPEAT_MIN\s*=\s*90000[\s\S]*FUN_REPEAT_MAX\s*=\s*150000/.test(world), 'the recent-choice window lasts 90–150 seconds');
A.ok(/recent \? 0\.28 : 1/.test(world), 'a recent choice is softly penalized when real alternatives exist');
A.ok(/cands\.length === 1 && cands\[0\]\.recent/.test(world), 'a sole recent prop is still skipped instead of becoming permanent parking');

// Variety + bounded exploration: desk/check-in and leisure are not compulsory branches, while a
// long-idle body deliberately samples another room only through its stable zone and normal pathfinder.
A.ok(/if \(now < \(self\.deskVisitCd \|\| 0\)\) return false/.test(world), 'desk check-ins respect a cooldown');
A.ok(/deskVisitCd = now \+ U\.irnd\(60000, 120000\)/.test(world), 'a completed desk check-in waits 1–2 minutes before repeating');
A.ok(/function planExplore\(now\)/.test(world), 'long-idle behavior has one narrow nearby-room planner');
A.ok(/room && room !== here/.test(world), 'the exploration picker explicitly targets a different physical room');
A.ok(/!tileInZone\(zone, tx, ty\) \|\| !geo\.walkable\(tx, ty, blocked\)/.test(world), 'exploration remains inside the existing leash and walkability rules');
A.ok(/idleAge > 60000 && planExplore\(now\)/.test(world), 'another-room exploration begins only after sustained downtime');
A.ok(/exploreCd = now \+ U\.irnd\(120000, 210000\)/.test(world), 'successful exploration has a long 2–3.5 minute cooldown');
A.ok(/roamR: a \? Zones\.ROAM_RADIUS : 0/.test(world), 'deskless bodies use the same bounded radius around their stable spawn home');
A.ok(/U\.chance\(0\.65\) && planSeekDesk/.test(world), 'social need no longer makes the desk a mandatory loop stop');
A.ok(/U\.chance\(0\.55\) && planPlay/.test(world), 'stimulation can fall through to organic idle beats instead of forced prop rotation');

// Calm/purposeful tuning: no cardinal spin sequence, no rapid machine swivels, and no decor tours.
A.ok(!/\[['"]north['"],\s*['"]east['"],\s*['"]south['"],\s*['"]west['"]\]\.forEach/.test(world), 'the frantic four-direction scan sequence is gone');
A.ok(/function quirkScan\(now\)\s*\{\s*const d = lookDir\(self\);[\s\S]{0,120}startQuirk\(now,\s*['"]scan['"][\s\S]{0,80},\s*d\)/.test(world), 'a scan now chooses one meaningful direction and holds it');
A.ok(!/function scanThen\(/.test(world), 'inspect/watch arrivals no longer flick left-right-target in under a second');
A.ok(/arcade:\s*\{\s*dwell:\s*\[22000,\s*40000\],\s*fidget:\s*\[8000,\s*14000\]/.test(world), 'arcade attention no longer re-rolls every second');
A.ok(/U\.chance\(b\s*&&\s*b\.track\s*\?\s*0\.08\s*:\s*0\.25\)/.test(world), 'prop look-aways are rare instead of the dominant beat');
A.ok(/function purposefulIdleProp\(p\)/.test(world), 'deliberate idle destinations use one narrow allow-list');
A.ok(/const FUN_KINDS\s*=\s*\{[^}]*arcade[^}]*pinball[^}]*pool[^}]*bar[^}]*\}/.test(world), 'purposeful games and counters stay eligible');
A.ok(!/const FUN_KINDS\s*=\s*\{[^}]*fish/.test(world), 'passive decor watching is not in the deliberate leisure picker');
A.ok(/const use = propUse\(p\); if \(!use \|\| !purposefulIdleProp\(p\)\) continue/.test(world), 'generic prop planning rejects irrelevant catalog use rows');
A.ok(/isWorkstationProp\(p\.t\)\s*&&\s*p\.agentId\s*===\s*self\.id/.test(world), 'ambient prop inspection is limited to the body’s own desk');
A.ok(/if \(c\.kind === ['"]bar['"]\) continue/.test(world), 'a bar without a free stool is skipped rather than stared at');

// Couch/TV regression: a claimed sofa cushion is rendered as a real sit and holds for minutes.
// The SIDE_SEAT clause (recliner, 2026-08-17) is the only thing allowed to vary either line — a
// profile seat slides its anchor onto the cushion and sorts behind its sitter; a sofa must not.
A.ok(/self\.pendSeat\s*=\s*\{\s*px:\s*\(sx\s*\+\s*0\.5\)\s*\*\s*T\s*\+\s*\(side\s*\?\s*side\.dx\s*:\s*0\),\s*py:\s*\(couch\.y\s*\+\s*h\)\s*\*\s*T\s*-\s*2,\s*lift:\s*side\s*\?\s*side\.lift\s*:\s*\(Number\.isFinite\(authoredLift\)\?authoredLift:0\),behindBack:!side&&authoredLift>0\s*\}/.test(world), 'couch planning keeps floor contact and uses the calibrated perch only behind its authored back');
A.ok(/self\.useSit\s*=\s*true;\s*self\.useFace/.test(world), 'the couch plan commits to the sit pose');
A.ok(/self\.goal\s*===\s*['"]lounge['"][\s\S]{0,500}self\.sitting\s*=\s*true[\s\S]{0,300}U\.irnd\(90000,\s*180000\)/.test(world), 'TV lounging sits on the couch for 90–180 seconds');
A.ok(/sitterUse\s*&&\s*sitterUse\.kind\s*===\s*['"]couch['"]\s*&&\s*!sitterSide\s*\?\s*1\s*:\s*-1/.test(world), 'couch and stool seats retain their distinct occlusion order (a profile seat takes the stool\'s)');

// Shared bar regression: reuse planSeat and the existing seat claims; one host may gain one joiner,
// with a rare roll and a long cooldown rather than a per-frame social loop.
A.ok(/function maybeJoinBar\(now\)/.test(world), 'same-room bar companionship has one narrow planner');
A.ok(/roomOfLocalTile\(ot\.x,\s*ot\.y\)\s*!==\s*room/.test(world), 'bar joining requires the same physical room');
A.ok(/committed\.length\s*!==\s*1/.test(world), 'a bar companionship is capped at two committed sitters');
A.ok(/barJoinCd\s*=\s*now\s*\+\s*U\.irnd\(60000,\s*120000\)[\s\S]{0,180}U\.chance\(0\.35\)/.test(world), 'an eligible bar join rolls only once per 1–2 minute cooldown');
A.ok(/if\s*\(!planSeat\(now,\s*pick\.stool,\s*zone\)\)\s*return false/.test(world), 'bar joining reuses the proven seat/path/claim primitive');
A.ok(/if\s*\(maybeJoinBar\(now\)\)\s*return/.test(world), 'the idle decision ladder consults the narrow bar join planner');
A.ok(/goal\s*===\s*['"]lounge['"][\s\S]{0,100}useKind\s*===\s*['"]couch['"][\s\S]{0,100}sitting\s*&&\s*b\.seated/.test(soak), 'the live soak counts actual seated couch/TV frames');
A.ok(/barSitters\.length\s*>=\s*2[\s\S]{0,120}sharedBarSamples\+\+/.test(soak), 'the live soak counts simultaneous bar company rather than separate visits');

// Render truth: a seated body is measured from where it is drawn, and the counter is identified.
A.ok(/tileOf\(bodyPosX\(b\),\s*bodyPosY\(b\)\)/.test(world), 'facing uses the rendered body position');
A.ok(/facingCounter:\s*!!\(fp\s*&&\s*isCounterProp\(fp\)\)/.test(world), 'body snapshots identify the actual counter prop ahead');
A.ok(/if\s*\(b\.facingCounter\)\s*r\.seatFacingCounter\+\+/.test(soak), 'the soak counts counter-facing stools, not any generic prop');
A.ok(!/b\.facing\s*===\s*['"]prop['"]/.test(soak), 'the false generic-prop counter proxy is gone');

// Harness truth + cleanup: the mixed fixture really distributes destinations across both rooms,
// demands observed crossing, and no early exit can bypass finally cleanup.
A.ok(/for\s*\(let i = 0; i < 8; i\+\+\) for \(const group of spotGroups\) spots\.push\(group\[i\]\)/.test(soak), 'mixed prop spots are interleaved across rooms');
A.ok(/mixed soak requires a real second room/.test(soak), 'mixed mode refuses to grade without a second room');
A.ok(/report\.bodies\.some\(b => b\.nextDoorSamples > 0\)/.test(soak), 'mixed mode requires an observed next-room sample');
A.ok(/floor:\s*builtFloor/.test(soak), 'the report records the floor it actually graded');
A.eq((soak.match(/process\.exit\s*\(/g) || []).length, 1, 'only the final process.exit remains, after finally cleanup');
A.ok(/finally\s*\{[\s\S]*proc\.kill\(\)[\s\S]*side\.kill\(\)/.test(soak), 'Chrome and the seeded sidecar are both killed in finally');

// ---- ONE MACHINE, ONE PLAYER (2026-08-10, Andrew's live repro) ----
// Seats have real claims (occupiedSeats), but standing-use props had none: both idle pickers could
// send a second body to an arcade cabinet someone was already at, and the two stood shoulder-to-
// shoulder playing the same machine. `usingProp` is stamped at PLAN time (the moment a body commits
// to the walk), so scanning OTHER bodies' usingProp covers "using it now" AND "already on the way".
A.ok(/function propInUse\(propId\)/.test(world), 'world.js carries the standing-use occupancy predicate');
A.ok(/if \(b\.usingProp === propId\) return true/.test(world), 'the predicate reads other bodies\' PLAN-time claims (covers a body still walking over)');
A.ok(/b === self \|\| b\.unplaced\) continue/.test(world), 'a body never counts itself (or an unplaced ghost) as the occupant');
// both pickers consult it BEFORE the prop can become a candidate — the loser re-rolls, never queues
const playFn = world.slice(world.indexOf('function planPlay('), world.indexOf('function planProp('));
A.ok(/propInUse\(p\.id\)\) continue/.test(playFn), 'planPlay skips an occupied (or claimed) machine');
const propFn = world.slice(world.indexOf('function planProp('), world.indexOf('function scanNovelty('));
A.ok(/propInUse\(p\.id\)\) continue/.test(propFn), 'planProp skips it too (the tired-drive route to the same props)');

A.report('idle-life-regressions.test');
