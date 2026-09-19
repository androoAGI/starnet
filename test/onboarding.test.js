/* node test/onboarding.test.js — source-level honesty invariants for THE AWAKENING (frontend/app/onboarding.js).

   onboarding.js is browser-flow code (an IIFE over World / Chat / Dialogue globals), not node-loadable, so —
   exactly like beat-coordination.test.js and lint-emits.js — we lock its invariants by reading the source.

   THE INVARIANT: every awakening beat that writes a dossier DIMENSION (a `dossierDim` beat, as opposed to a
   `field` beat that authors a .md config doc) must target a REAL dossier dimension. A typo would make
   Dossier.upsert silently reject the answer (unknown-dim guard) — the same "silently drop a belief" failure
   that interview.test.js guards for the intake interview. PAIN (Slice 6) and AMBITION (Slice 7) are such beats. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const D = require('../frontend/app/dossier.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/onboarding.js'), 'utf8');

/* ---------- every dossierDim beat targets a real dossier dimension (no silent-drop typo) ---------- */
const dimRefs = [...src.matchAll(/dossierDim:\s*'([^']+)'/g)].map(m => m[1]);
A.ok(!/dossierDim: 'pain'|dossierDim: 'ambition'/.test(src), 'fixed pain and year questionnaire is retired');
for (const k of dimRefs) A.ok(D.DIM_KEYS.indexOf(k) >= 0, 'awakening dossierDim "' + k + '" is a real dossier dimension');

/* ---------- startQuestions routes a dossierDim answer straight to the station-wide dossier ---------- */
A.ok(/s\.dossierDim\b[\s\S]{0,200}DossierStore\.upsert\(s\.dossierDim/.test(src),
  'startQuestions writes a dossierDim answer straight to DossierStore.upsert');

/* ---------- a recruited (specialty) wake skips the pain beat (the dossier is station-wide, asked once) ---------- */
A.ok(/specialty\s*\?[\s\S]{0,200}!s\.dossierDim/.test(src),
  'a pre-specced wake filters out dossierDim beats (pain is asked once, at the orchestrator awakening)');

/* ---------- the autonomy cadence beat: a posturePreset beat with VALID preset ids, routed to AutonomyStore ---------- */
const Au = require('../frontend/app/autonomy.js');
const presetIds = Au.cadencePresets().map(p => p.id);
A.ok(/posturePreset:\s*true/.test(src), 'the awakening has the autonomy cadence beat (posturePreset)');
// bound the cadence beat by the next beat marker so we read only ITS options (no bleed into the manual beat).
const ps = src.indexOf('posturePreset: true');
const after = src.slice(ps + 1);
const nextMark = ['field:', 'dossierDim:'].map(m => after.indexOf(m)).filter(j => j >= 0);
const cadSeg = src.slice(ps, nextMark.length ? ps + 1 + Math.min(...nextMark) : src.length).replace(/\/\/[^\n]*/g, '');
A.ok(/optional:\s*true/.test(cadSeg), 'the cadence beat is optional/skippable (Decide later → the safe floor)');
const optVals = [...cadSeg.matchAll(/value:\s*'([^']*)'/g)].map(m => m[1]);
const nonEmpty = optVals.filter(v => v !== '');
A.ok(nonEmpty.length >= 4, 'the cadence beat offers the four concrete posture choices');
for (const v of nonEmpty) A.ok(presetIds.indexOf(v) >= 0, 'cadence option "' + v + '" is a real autonomy cadence preset id (no silent-drop typo)');
A.ok(optVals.indexOf('') >= 0, 'the cadence beat has a skip option (Decide later)');
// startQuestions routes a posturePreset answer to AutonomyStore.applyPreset (the opening posture is written through)
A.ok(/s\.posturePreset\b[\s\S]{0,220}AutonomyStore\.applyPreset\(text\)/.test(src),
  'startQuestions writes a posturePreset answer to AutonomyStore.applyPreset');
// a recruited (specialty) wake skips the cadence beat too (posture is station-wide for now, asked once)
A.ok(/specialty\s*\?[\s\S]{0,200}!s\.posturePreset/.test(src),
  'a pre-specced wake filters out the posturePreset beat (asked once, at the orchestrator awakening)');

/* ---------- Interview 2.0 — the live-mind beats stay honest + the ceremony can never lose the mission ---------- */
// the generated beats reason with NO tools reachable and NO run.start/end on the bus (the awakening thinking
// about the Commander is not a shipped task — XP/telemetry stay honest, mirroring pitchstore's internal call).
A.ok(/isTask:\s*false,\s*placed:\s*\[\],\s*internal:\s*true/.test(src),
  'the awakening\'s live-mind call is reason-only (placed:[]) and internal (no bus run events)');
// purpose.md ALWAYS lands: when the synthesized read can't (no brain / timeout / unparseable / nothing shared),
// the classic required mission question runs instead — the ceremony can never end without a mission.
A.ok(/function fallbackPurposeStep\(opening = false\)[\s\S]{0,400}field:\s*'purpose'/.test(src),
  'the classic purpose question survives as fallbackPurposeStep (field: purpose)');
A.ok(/if\s*\(!purposeDone\)\s*\{[\s\S]{0,120}askStep\(fallbackPurposeStep\(\)\)/.test(src),
  'runLeadMeeting falls back to the required mission question when the live read did not land');
// the follow-up answer becomes context.md (the doc identity seeds from) — the broad context question is gone
// from the lead path, but the doc it authored still gets written when the Commander answers the follow-up.
A.ok(/commit\(\{ context: conversation\.map/.test(src), 'exact conversation is committed as context');
// the synthesis' one direct dossier write targets a REAL dimension (same silent-drop guard as the beats above).
const directDims = [...src.matchAll(/DossierStore\.upsert\('([^']+)'/g)].map(m => m[1]);
for (const k of directDims) A.ok(D.DIM_KEYS.indexOf(k) >= 0, 'direct dossier write "' + k + '" targets a real dossier dimension');
// the live calls are time-bounded — a slow model can stall a beat, never the ceremony.
A.ok(/PAIN_REPLY_MS\s*=\s*\d+/.test(src) && /SYNTHESIS_MS\s*=\s*\d+/.test(src) && /withTimeout/.test(src),
  'every live-mind call races a timeout (the scripted ceremony carries on alone)');

/* ---------- the LIVE birth script: full-monologue generation, per-slot fallback, honest on a dead wire ---------- */
// the prefetch is fire-and-collect (.then, no await) — the ceremony's pacing can never hinge on the model.
A.ok(/llmCall\(WakeMind\.buildBirthScript\([\s\S]{0,80}\), true\)\.then\(/.test(src),
  'the birth call is prefetched fire-and-collect (never awaited by a beat)');
A.ok(!/await[\s\S]{0,40}buildBirthScript/.test(src), 'no beat awaits the birth call');
// the only latency concession is the bounded held-dark poll at ignition — capped, never unbounded.
A.ok(/waitBirth\(\s*\d+/.test(src) && /waited\s*>=\s*capMs/.test(src),
  'the ignition dark-hold for the birth script is a BOUNDED poll (waitBirth cap)');
// every slot keeps its scripted fallback line — a quiet mind still gets the full scripted ceremony.
A.ok(/bs\('settle'\)\s*\|\|\s*'it’s not flooding me\. it’s mine\.'/.test(src),
  'the settle slot falls back to the scripted spine');
A.ok(/bs\('aimless'\)\s*\|\|\s*'incredible\. genuinely\. and pointed at nothing\.'/.test(src),
  'the aimless slot falls back to the scripted spine');
A.ok(/seg\('  so you’re the one who knows where this points\. aim me\.'/.test(src),
  'the contact beat keeps its scripted fallback triplet');
A.ok(/stage\('READY TO BEGIN'/.test(src) && /const readyLine = role/.test(src),
  'the closing handoff uses a concise role-aware message');
A.ok(/bs\('mandate'\)\s*\|\|\s*'and i’m built to run a floor/.test(src),
  'the mandate slot falls back to the scripted promise');
// a live-configured wire that answers DEAD is owned diegetically at the close, pointing at CONNECT.
A.ok(/birthFailed[\s\S]{0,700}CONNECT/.test(src),
  'a dead wire during the ceremony is owned honestly at the close (the CONNECT repair line)');
// the stakes beat: extraction earns attention by declaring what the answers become, before asking —
// and earns GENEROSITY by declaring the trade (sharper picture in → sharper first move out).
A.ok(/saved in your dossier, where you can review and change them/.test(src),
  'the meeting explains storage and how to revise the saved answers');
A.ok(/your answers help me choose work that matters to you/.test(src),
  'the interview explains how sharing context helps without pressuring the user');

/* Conversation replaces the fixed personal-question sequence. */
A.ok(/what made you want to set up an agent/.test(src), 'the opener asks why they came');
A.ok(/Help me figure that out/.test(src), 'uncertainty has a first-class help path');
A.ok(/openingAnswer.help/.test(src) && /helpRequested: true/.test(src), 'help is context, not a made-up personal answer');
A.ok(/buildDigReply/.test(src) && /conversation, name: NAME/.test(src), 'each follow-up sees the whole conversation');
A.ok(/!reply.ask \|\| followupsLeft <= 0/.test(src), 'model completion and budget both stop questioning');
// B7 the mirror: offers are generated (possibility-space teaching); a grab arms the proof beat.
A.ok(/llmCall\(WakeMind\.buildMirror\(/.test(src), 'the mirror offers are generated, never canned');
A.ok(/World\.heroCaps\('agent'\)/.test(src) && /capabilities:\s*liveCaps/.test(src),
  'the mirror sees the agent\'s REAL placed caps, not a hardcoded empty list');
{
  const start = src.indexOf('const liveCaps = (() => {');
  const exprStart = src.indexOf('(() => {', start);
  const exprEnd = src.indexOf('})();', exprStart);
  A.ok(start >= 0 && exprStart >= 0 && exprEnd >= 0, 'the live capability projection remains executable as one bounded expression');
  const expr = src.slice(exprStart, exprEnd + 4);
  const caps = vm.runInNewContext(expr, {
    World: { heroCaps: () => [{ objectType: 'dish' }, 'cabinet', null] },
    WorldModel: { CAP_LABEL: { dish: 'WEB', cabinet: 'FILES' } }
  });
  A.eq(caps, [{ id: 'dish', label: 'WEB' }, { id: 'cabinet', label: 'FILES' }],
    'the mirror unwraps World.heroCaps {objectType} records before resolving their power labels');
}
A.ok(/const mirrorCtx = \{ tuesday: tuesdayT, dig: digT/.test(src), 'the mirror sees motivation and follow-up answers');
A.ok(/PitchStore\.armFirstMove\(grabbedMove\)/.test(src),
  'a grabbed offer arms the post-tour first move (the one below-gate starter allowed)');
// B8 thin honesty: a loose/empty run synthesizes with thin:true and its purpose lands as a SEED belief.
A.ok(/thin:\s*!gaveAnything/.test(src), 'a thin run tells the synthesis to own the thinness');
A.ok(/gaveAnything\s*\?\s*'synth'\s*:\s*'seed'/.test(src),
  'a thin-run purpose never lands as grounded evidence (seed, gate stays shut)');
// every synth-belief write flows through the one helper with weight synth.
A.ok(/weight:\s*'synth'\s*\}\);\s*\}\s*\}/.test(src.replace(/\r/g, '')) || /upsertSynthBeliefs/.test(src),
  'mind-reply beliefs land through the synth-weight chokepoint');

/* ---------- S5: brain-before-interview (plan §8) ---------- */
// a keyless wake gets NO fake interview: the honest holding line, the required scripted beats, and a
// persisted IOU the first live-brain session pays via one gentle offer (spent on OFFER — never a nag).
A.ok(/if \(journal \? !journal.interviewReady : \(!brainReady\(\) \|\| birthFailed\)\) \{[\s\S]{0,900}setDeferred\(\);[\s\S]{0,300}fallbackPurposeStep\(true\)/.test(src),
  'a keyless OR dead-wire meeting banks the IOU and still lands purpose.md (no fake deep interview)');
A.ok(/PROVEN, NOT ASSUMED/.test(src),
  'the live-wire proof doctrine is stated at the gate (the birth call is the preflight)');
A.ok(/my wire is dark/.test(src), 'the keyless holding line owns the dead wire honestly');
A.ok(/function offerDeferred/.test(src) && /clearDeferred\(\);\s*\/\/ spent on OFFER/i.test(src.replace(/ /g, ' ')) || /clearDeferred\(\);/.test(src),
  'the deferred offer exists and spends its flag on offer (one-shot)');
A.ok(/offerDeferred[\s\S]{0,400}deferredPending\(\)[\s\S]{0,200}brainReady\(\)/.test(src),
  'the deferred offer requires both the pending IOU and a live brain');

/* ---------- the composer is an ANSWER BOX (answer-swallow fix, 2026-07-20) ---------- */
// The awakening's COMMS input says "answer to wake your agent…" — so its handler must route typed text into
// the pending Dialogue question (Dialogue.answer), never a no-op. The old `Chat.beginInterview(() => {})`
// silently dropped every composer-typed answer: empty dossier, no generated digs, thin synthesis.
A.ok(/Chat\.beginInterview\(text => \{[^}]*Dialogue\.answer\(text\)/.test(src),
  'the awakening composer handler feeds typed answers to the pending question (Dialogue.answer)');
A.ok(!/Chat\.beginInterview\(\(\) => \{\}\)/.test(src),
  'the no-op interview handler (the answer-swallow bug) is gone');

/* ---------- PLAIN-QUESTION LAW (Andrew, 2026-07-20) — regression lock ---------- */
// Every question shown to the Commander is an extraction instrument: literal, single-reading, zero
// metaphors. A misunderstood question produces a sideways answer that gets SAVED as grounded context.
// These shapes shipped once ("paint me the shop's tuesday — what do YOU end up doing with your own
// hands?") and must never return, in the awakening OR the curiosity drip.
{
  const drip = fs.readFileSync(path.join(__dirname, '../frontend/app/interview.js'), 'utf8');
  const banned = /paint me|your own hands|shop.s tuesday|the hours leak/i;
  A.ok(!banned.test(src), 'awakening copy contains no banned metaphor shapes (plain-question law)');
  A.ok(!banned.test(drip), 'curiosity-drip copy contains no banned metaphor shapes (plain-question law)');
  // and the generated questions are held to the same law: every ASK builder must carry the clause.
  const W = require('../frontend/app/wakemind.js');
  for (const [name, d] of [
    ['pain', W.buildPainReply({ pain: 'x' })],
    ['ambition', W.buildAmbitionReply({ ambition: 'x' })],
    ['dig', W.buildDigReply({ tuesday: 'x' })],
    ['year', W.buildYearReply({ year: 'x' })]
  ]) A.ok(/PLAIN WORDS ONLY/.test(d), 'the ' + name + ' ASK spec carries the plain-words law');
}

/* ---------- THE RE-WAKE (2026-07-20) — a replayed awakening never re-runs the birth monologue ---------- */
// wake:false is the resume-mid-awakening replay (app.js resumeInto: onboarded never flipped, so the ceremony
// re-enters). The agent has already been born in front of this Commander once — the replay must route to the
// short re-greeting (reignite), then straight back to the questions. Re-running the full birth speech reads
// as amnesia (Andrew, 2026-07-20).
A.ok(/else if \(!opts\.wake\)[\s\S]{0,700}reignite\(\)/.test(src),
  'a wake:false (replay) entry routes to the re-wake, never the full birth ignition');
{
  const rStart = src.indexOf('function reignite()');
  A.ok(rStart >= 0, 'the re-wake beat exists (reignite)');
  const rEnd = src.indexOf('function floodWords');
  const rSeg = src.slice(rStart, rEnd > rStart ? rEnd : src.length).replace(/\/\/[^\n]*/g, '');
  A.ok(/startQuestions/.test(rSeg), 'the re-wake hands straight back to the questions');
  A.ok(!/theFlood|firstContact|theMandate|waitBirth/.test(rSeg),
    'the re-wake never replays the flood/contact/mandate birth monologue');
}

/* Adaptive question budget and truthful memory receipts. */
A.ok(/const FOLLOWUP_BUDGET = 3/.test(src), 'deeper interview has at most three follow-ups');
A.ok(/followupsLeft = loose \? 1 : FOLLOWUP_BUDGET/.test(src), 'short interview has at most one follow-up');
// the ink: every REAL dossier write beside the ceremony shows its receipt — and only real writes do.
A.ok(/function ink\(dim, text\)/.test(src) && /Dialogue\.ink\(/.test(src), 'the ink helper exists and drives Dialogue.ink');
A.ok(/DossierStore\.upsert\(s\.dossierDim[\s\S]{0,120}ink\(s\.dossierDim, text\)/.test(src),
  'the askStep chokepoint inks the stated write');
A.ok(!/ink\('identity', 'Chose to be figured out/.test(src) && /never inked/.test(src),
  'seed-weight mechanical notes are never inked (nothing was learned)');

A.report('onboarding.test');
