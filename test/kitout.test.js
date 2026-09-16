/* node test/kitout.test.js — source-level invariants for the kit-out COMPRESSION ("requisition the rest").

   tutorial.js and build.js are browser IIFEs over live DOM/canvas globals (not node-loadable), so — exactly
   like onboarding.test.js / beat-coordination.test.js — the honesty-critical wiring is locked by reading the
   source. THE INVARIANT: a requisitioned prop is a REAL placement through the same validated path as a hand
   placement (object=capability must stay honest — never a flag), and the offer only appears AFTER the
   Commander has placed one piece by hand (the first placement is the lesson; the reps are the chore). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const build = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');
const tut = fs.readFileSync(path.join(__dirname, '../frontend/app/tutorial.js'), 'utf8');

/* ---------- build.js: requisition is the REAL path, gated, and fires the same hooks ---------- */
const reqStart = build.indexOf('function requisition(');
A.ok(reqStart >= 0, 'Build.requisition exists');
const reqSeg = build.slice(reqStart, build.indexOf('\n  const api', reqStart));
A.ok(/findPlaceableTile\(/.test(reqSeg), 'requisition places at a VALIDATED tile (findPlaceableTile)');
A.ok(/station\.addProp\(/.test(reqSeg), 'requisition goes through the real station.addProp (object=capability stays honest)');
A.ok(/if\s*\(!running\s*\|\|\s*!station\)/.test(reqSeg), 'requisition refuses when REFIT is not open');
A.ok(/isEditableProp\(t\)/.test(reqSeg), 'requisition refuses editable/config props (no editor popping mid-ceremony)');
A.ok(/Tutorial\.onPropPlaced\)\s*Tutorial\.onPropPlaced\(t\)/.test(reqSeg), 'a requisitioned placement fires the SAME first-touch/kit hook as a hand placement');
A.ok(/requisition\s*[},]/.test(build.slice(build.indexOf('const api'))), 'requisition is exported on the Build api');

/* ---------- tutorial.js: the offer appears only after ONE hand placement; the runner is guarded ---------- */
A.ok(/kitNeeded\.size\s*<\s*KIT\.length[\s\S]{0,120}Build\.requisition/.test(tut),
  'the requisition offer appears only once a needed cap has been placed by hand (size < KIT.length)');
A.ok(/function runRequisition\(\)/.test(tut), 'the requisition runner exists');
const runSeg = tut.slice(tut.indexOf('function runRequisition('), tut.indexOf('function beatKitReady('));
A.ok(/if\s*\(!active\s*\|\|\s*!kitMode\s*\|\|\s*!kitNeeded\)\s*return/.test(runSeg), 'the runner bails when the tour/kit-out is over');
A.ok(/!kitNeeded\.has\(k\.grant\)\)\s*return/.test(runSeg), 'each staggered placement re-checks its grant (a hand placement mid-run is respected, no dupes)');
A.ok(/no clear floor for/.test(runSeg), 'a floor with no valid tile degrades honestly to hand placement (named, not silent)');
A.ok(/setTimeout\(/.test(runSeg), 'placements are staggered so each ✓ + chime reads');

/* ---------- the tutorial hands off to the quest log (the durable "what next" surface) ---------- */
A.ok(/⚑ QUESTS/.test(tut), 'the classic close points at the quest log by name');

/* ---------- P0: REFIT's first-run card must never stack on the tour (2026-08-03 audit) ----------
   The kit-out ALWAYS causes the first REFIT open, so an ungated showGuide() put a full-viewport modal
   over the ⚇ PROP button the tour's ring was pulsing on — teaching a different lesson underneath. */
A.ok(!/if\s*\(!hasSeen\(\)[^\n]*showGuide\(\)/.test(build)
  && /querySelector\('#refit-help'\)\.onclick = showGuide/.test(build),
  'REFIT help opens only on request, so it cannot stack over the tutorial');
A.ok(/function tutorialCoaching\(\)[\s\S]{0,200}Tutorial\.isCoaching\(\)/.test(build),
  'that gate reads Tutorial.isCoaching() (the same coordination dockglow.js uses)');
A.ok(/markSeen\(\);\s*if \(g\.parentNode\)/.test(build),
  'markSeen still fires only on DISMISS — so a deferred card is not lost, it shows on the next open');
A.ok(/g\.className = 'refit-guide refit-firstrun'/.test(build),
  'the first-run card carries its own refit-firstrun marker (the pickers/editors share .refit-guide)');
A.ok(/document\.querySelector\('#terms \.term'\) \|\| document\.querySelector\('\.refit-firstrun'\)/.test(tut),
  'showCoach defers over the first-run card too, so the deferred open does not stack card + coachmark');

/* ---------- P0: one failed first paint must not strand REFIT on a black overlay ----------
   requestAnimationFrame does not continue after an exception. The next frame must therefore be scheduled by a
   finally-owned supervisor, with a bounded retry and a fresh canonical bake/camera instead of requiring DONE +
   reopen to manufacture a new loop. */
const frameStart = build.indexOf('function frame(now)');
A.ok(frameStart >= 0, 'REFIT render frame exists');
const frameSeg = build.slice(frameStart, build.indexOf('\n  function drawGrid', frameStart));
A.ok(/try\s*\{[\s\S]*catch \(err\)[\s\S]*finally\s*\{[\s\S]*scheduleFrame\(failed\)/.test(frameSeg),
  'the REFIT frame is supervised and schedules its successor from finally even after a draw exception');
A.ok(/function scheduleFrame\(failed\)[\s\S]{0,600}Math\.min\(1000,[\s\S]{0,600}requestAnimationFrame\(frame\)/.test(build),
  'failed frames retry with bounded backoff instead of a 60fps error loop');
const recoverStart = build.indexOf('function recoverFrame(err)');
const recoverSeg = build.slice(recoverStart, build.indexOf('\n  function frame(now)', recoverStart));
A.ok(/cache = null; cacheGeo = null/.test(recoverSeg) && /bakeDirty = true/.test(recoverSeg),
  'recovery discards the suspect derived bake and rebuilds from canonical station state');
A.ok(/resize\(\); fitCamera\(\)/.test(recoverSeg),
  'recovery re-measures and re-fits the station after a first-layout race');

/* ---------- P1: the kit-out is opt-IN, so it must be opt-OUT-able at any moment ---------- */
A.ok(/function kitBail\(\)/.test(tut), 'the kit-out has a bail');
const bailSeg = tut.slice(tut.indexOf('function kitBail()'), tut.indexOf('function beatFullyEquipped('));
A.ok(/Build\.isOpen\(\)\s*&&\s*Build\.close\)\s*\{\s*Build\.close\(\);\s*return;/.test(bailSeg),
  'inside REFIT the bail just closes it — kitTick reads that as the normal exit (no double dialogue)');
A.ok(/kitClosedDuringPlace\(\)/.test(bailSeg), 'outside REFIT it lands on the same honest wired-vs-dark accounting');
A.ok(/class = 'tut-coach-bail'|className = 'tut-coach-bail'/.test(tut), 'every kit-out step renders a visible way out');
A.ok(/e\.key !== 'Escape'[\s\S]{0,200}\.refit-overlay'\)[\s\S]{0,80}#terms \.term'\)\) return;\s*kitBail\(\)/.test(tut),
  'Esc bails only when nothing else claims the key — not over REFIT, not over an open station panel');

/* ---------- P1: the tour's two closing surfaces must not cover each other ----------
   (the GEOMETRY itself is unit-tested for real in test/coach-dodge.test.js — these only lock the wiring) */
A.ok(/function dodgeBrief\(/.test(tut), 'the coachmark measures the live FIRST STEPS brief');
A.ok(/dodgeBrief\(\{ left, top, w: bw, h: bh \}, vw, vh\)/.test(tut), 'placeCoach routes its computed box through the dodge');
A.ok(/^function dodgeRect\(box, brief, vw, vh\)/m.test(tut), 'the geometry is a pure top-level fn, not trapped in the IIFE');
A.ok(/typeof module !== 'undefined' && module\.exports\) module\.exports = \{ dodgeRect\b/.test(tut),
  'and it is exported under the same browser-safe guard stationui.js uses, so the gate can run it');

A.report('kitout.test');
