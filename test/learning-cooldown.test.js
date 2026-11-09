/* node test/learning-cooldown.test.js — W1.4 LEARNING-PASS COOLDOWNS: the one resolver, unit + family invariant.

   Reflection, failure review, study and thread mining each armed their window only when a proposal survived, so a pass
   whose model replied NONE fired again on the very next run (base e316231d7: four quick runs, eight one-shot passes).
   The family now closes in ONE place: sidecar/learning-cooldown.js holds the policy (NONE backoff, feedback tokens,
   new-failure-class bypass, run-end and forget order) and sidecar/index.js reads it through learningPassDue (every
   gate) and noteLearningAttempt (every pass's finally, on an attempt whose meter counted a model call). This file proves:
     1. the pure policy (scale ladder, cue words, feedback tokens spent only by an ANSWERED attempt from a run that ended
        after them, failure classes reviewed only by an answer, forget, and that a pass outliving its agent arms nothing);
     2. the composition root's real learningPassDue / noteLearningAttempt, run on a fake clock: four quick NONE runs
        attempt each pass once, a cue still reflects, a verdict landing mid-pass survives it, a verdict survives a call
        that failed (review r2), a window of 0 stays 0, study's stamp is persisted, and a reset mid-pass leaves no stamp;
     3. the family invariant over index.js: no window is armed anywhere else, every gate reads the resolver, every pass
        notes its attempt (with its run) before its meter is booked, a run's end takes its order after its cue and before
        its row exists, the one feedback write path opens the windows (and every like/dislike surface goes through it),
        and both forget paths clear every pass's stamp and in-flight guard before they forget the policy state.
   The live proofs (real sidecar, mock provider, counted calls) are test/learning-cooldown.e2e.test.js and, for the
   orderings, test/learning-cooldown.race.e2e.test.js. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { readSidecarSource, readSidecarIndex, sidecarTopLevelFunction } = require('./helpers/source.js');
const LC = require('../sidecar/learning-cooldown.js');

/* ---------- 1. the pure policy ---------- */
{
  A.eq(LC.KINDS, ['reflection', 'failure-review', 'study', 'threadmine'], 'the four learning passes, and only them');
  A.eq(LC.NONE_BACKOFF, [1, 1, 4, 10], 'reflection backs off x1, x4, x10 (3, 12, 30 min on the 3 min default)');

  // cues: an explicit preference or correction in the Commander's own words
  for (const t of ['Remember that I work in UTC', 'always use tabs', 'Never push on Fridays', 'from now on, keep it short',
    'Going forward write in British English', 'I prefer short replies', 'my preference is metric', "don't add emojis",
    'Don’t add emojis', 'please do not quote me', 'dont number the notes',
    // round 2 (review nit): the common correction phrasings the first list missed
    'Next time, use British spelling in the report.', 'In future please keep replies under 100 words.', 'In the future, cite sources.',
    'Stop adding emojis to the notes.', 'Use tabs instead of spaces in these notes.', 'From here on, metric units only.'])
    A.ok(LC.cueIn(t), 'cue: "' + t + '"');
  for (const t of ['save note 5 in the workspace root', 'inspect the station', 'the preferably cheaper option', 'a rememberable name',
    'neverland map', '', null, undefined, '   ',
    // round 2: a cue word that gives no instruction
    'Never mind, just push the fix.', 'nevermind that one', "I don't know why the test is red, can you look?", 'I do not know the answer yet'])
    A.ok(!LC.cueIn(t), 'no cue: ' + JSON.stringify(t));
  A.ok(LC.cueIn("Never mind the logs. Don't add emojis."), 'an exempt phrase does not hide a real cue in the same turn');
  A.ok(LC.cueIn('Why does the build always fail on Windows?'), 'broad on purpose: a question with a cue word still counts (a false hit costs one attempt per pass)');

  A.eq(LC.failureClass({ outcome: 'failed', failureStage: 'provider_stream', failureCode: 'format_error' }), 'failed|provider_stream|format_error', 'a failure class is outcome|stage|code');
  A.eq(LC.failureClass(null), '||', 'a failure class never throws on nothing');
  A.eq(LC.failureClass({ outcome: 'failed', failureStage: 'x'.repeat(500) }).length, 'failed|'.length + 80 + 1, 'each part is bounded');

  let t = 1000;
  const p = LC.make({ now: () => t });
  A.eq([p.scale('reflection', 'a'), p.scale('study', 'a')], [1, 1], 'a fresh agent: no backoff');
  p.noted('reflection', 'a', { replied: true, produced: false });
  A.eq(p.scale('reflection', 'a'), 1, 'one NONE: the base window');
  p.noted('reflection', 'a', { replied: true, produced: false });
  A.eq(p.scale('reflection', 'a'), 4, 'two NONEs in a row: x4');
  p.noted('reflection', 'a', { replied: false, produced: false });
  A.eq(p.scale('reflection', 'a'), 4, 'a failed call (no reply) leaves the streak as it is');
  p.noted('reflection', 'a', { replied: true });
  A.eq(p.scale('reflection', 'a'), 10, 'three NONEs: x10');
  p.noted('reflection', 'a', { replied: true });
  A.eq(p.scale('reflection', 'a'), 10, 'the ladder stops at x10 (30 min on the default)');
  A.eq(p.scale('study', 'a'), 1, 'only reflection backs off; the other windows are flat');
  A.eq(p.scale('reflection', 'b'), 1, 'per agent');
  p.noted('reflection', 'a', { replied: true, produced: true });
  A.eq([p.scale('reflection', 'a'), p.streak('a')], [1, 0], 'a kept proposal starts the ladder over');
  p.noted('study', 'a', { replied: true, produced: false });
  A.eq(p.streak('a'), 0, 'a NONE from another pass is not reflection\'s streak');
  A.eq([p.noted('scout', 'a', { replied: true }), p.noted('skill-review', 'a', {})], [false, false], 'a pass outside the family arms nothing here');

  A.eq(p.bypass('reflection', 'a', {}), '', 'no feedback: the window decides');
  A.eq(p.bypass('reflection', 'a', { cue: true }), '', 'a cue is a token the run-end opens, never a flag a caller passes');

  // FEEDBACK TOKENS: opened once, spent per pass, only by an attempt from a run that ended at or after the feedback
  p.open('a');
  for (const k of LC.KINDS) A.eq(p.bypass(k, 'a', {}), 'feedback', 'a stored like/dislike opens ' + k);
  A.eq(p.bypass('scout', 'a', {}), '', 'never for a pass outside the family');
  A.eq(p.bypass('reflection', 'b', {}), '', 'feedback opens only its own agent');
  p.ended('run-a2');
  p.noted('reflection', 'a', { runId: 'run-a2', replied: true });
  A.eq(p.bypass('reflection', 'a', {}), '', 'the token is spent by the pass\'s next attempt from a run that ended after it');
  A.eq(p.bypass('study', 'a', {}), 'feedback', '...one pass at a time: study still holds its token');
  for (const k of ['study', 'threadmine', 'failure-review']) p.noted(k, 'a', { runId: 'run-a2', replied: true });
  A.eq([LC.KINDS.map(k => p.bypass(k, 'a', {})), p.pending('a')], [['', '', '', ''], []], 'once every pass attempted, the feedback is spent');

  // THE RACE (review r1 blocker 1): a verdict lands while the rated run's own passes are still running
  const q = LC.make({ now: () => t });
  q.ended('r1');                                            // run 1 ends; its reflection and study start (a slow aux model)
  q.open('v', 'feedback');                                  // the thumbs verdict lands while they run
  A.eq(q.noted('reflection', 'v', { runId: 'r1', replied: true }), true, 'race: run 1\'s reflection ends (NONE) and arms its window');
  q.noted('study', 'v', { runId: 'r1', replied: true });
  A.eq([q.bypass('reflection', 'v', {}), q.bypass('study', 'v', {})], ['feedback', 'feedback'], 'race: a pass that was running when the verdict landed never spends it (it never read it)');
  q.ended('r2');
  q.noted('reflection', 'v', { runId: 'r2', replied: true });
  A.eq([q.bypass('reflection', 'v', {}), q.bypass('study', 'v', {})], ['', 'feedback'], 'race: run 2\'s attempt spends it, pass by pass');

  // THE CUE RACE: run B's cue lands while run A's passes still run, so B's reflection and study are held by their in-flight guard
  q.ended('rA');
  q.open('c', 'cue'); q.ended('rB');                        // B carries the cue; B's own thread mining runs
  q.noted('threadmine', 'c', { runId: 'rB', replied: true });
  A.eq(q.bypass('threadmine', 'c', {}), '', 'cue: the cue run\'s own attempt spends that pass\'s token');
  q.noted('reflection', 'c', { runId: 'rA', replied: true }); q.noted('study', 'c', { runId: 'rA', replied: true });
  A.eq([q.bypass('reflection', 'c', {}), q.bypass('study', 'c', {})], ['cue', 'cue'], 'cue: a pass held back at the cue run keeps the token: run A\'s passes ending later never spend it');
  q.ended('rC'); q.noted('reflection', 'c', { runId: 'rC', replied: true });
  A.eq(q.pending('c'), ['failure-review', 'study'], 'cue: run C\'s reflection spends its token; the passes that have not attempted since keep theirs');

  // THE FAILED ATTEMPT (review r2 blocker): a call that errored or timed out never answered, so it read nothing and uses nothing up
  const e = LC.make({ now: () => t });
  e.ended('re1'); e.open('e', 'feedback'); e.ended('re2');                 // a verdict on run 1, then run 2 ends
  A.eq(e.noted('reflection', 'e', { runId: 're2', replied: false, produced: false }), true, 'failed: an attempt whose call failed still arms its window (it went out; a timeout is billed for its prompt)');
  A.eq(e.bypass('reflection', 'e', {}), 'feedback', 'failed: ...but keeps the verdict: the model never answered, so it never read it');
  A.eq(e.streak('e'), 0, 'failed: ...and counts no NONE');
  e.ended('re3');
  e.noted('reflection', 'e', { runId: 're3', replied: true });
  A.eq([e.bypass('reflection', 'e', {}), e.streak('e')], ['', 1], 'failed: the next ANSWERED attempt uses the verdict up (and its NONE counts)');
  e.open('e', 'cue'); e.ended('re4');
  e.noted('study', 'e', { runId: 're4', replied: false });
  e.noted('study', 'e', { runId: 're4' });                                 // a caller that names no answer: the safe side
  A.eq(e.bypass('study', 'e', {}), 'cue', 'failed: a cue survives a failed call of any pass (study)');
  e.noted('study', 'e', { runId: 're4', produced: true });
  A.eq(e.bypass('study', 'e', {}), '', 'failed: a kept proposal is an answer');
  const CLS2 = 'failed|tool|exit_code';
  A.eq(e.bypass('failure-review', 'x', { failureClass: CLS2, windowMs: 300000 }), 'new-failure-class', 'fixture: a class never reviewed');
  e.noted('failure-review', 'x', { replied: false, failureClass: CLS2 });
  A.eq(e.bypass('failure-review', 'x', { failureClass: CLS2, windowMs: 300000 }), 'new-failure-class', 'failed: a failure review whose call failed leaves its class NEW (it was never reviewed)');
  e.noted('failure-review', 'x', { replied: true, failureClass: CLS2 });
  A.eq(e.bypass('failure-review', 'x', { failureClass: CLS2, windowMs: 300000 }), '', 'failed: an answered review marks it reviewed');

  // newer feedback that lands during an attempt that read older feedback survives that attempt
  q.open('n', 'cue'); q.ended('rn1'); q.open('n', 'feedback');
  q.noted('reflection', 'n', { runId: 'rn1', replied: true });
  A.eq(q.bypass('reflection', 'n', {}), 'feedback', 'a newer feedback (the verdict) that landed while the cue run\'s pass ran survives it');

  // a run the policy never saw end reads nothing new: it spends no token (and arms its window when no forget is on record)
  q.open('u');
  A.eq(q.noted('reflection', 'u', { runId: 'never-ended', replied: true }), true, 'an attempt from an unrecorded run still arms its window');
  A.eq(q.bypass('reflection', 'u', {}), 'feedback', '...but spends no feedback');
  // the run-end record is bounded (256): an attempt whose run fell out of it counts as never seen end (keeps the token)
  q.ended('old'); for (let i = 0; i < 256; i++) q.ended('fill-' + i);
  q.open('w'); q.noted('study', 'w', { runId: 'old', replied: true });
  A.eq(q.bypass('study', 'w', {}), 'feedback', 'a run-end older than the last 256 spends nothing (the safe side: one extra attempt)');

  // FORGET (review nit): an attempt whose run ended before its agent was deleted or reset arms nothing and folds nothing
  q.ended('rf1');
  q.forget('f');
  A.eq(q.noted('study', 'f', { runId: 'rf1', replied: true }), false, 'forget: a pass that outlived its agent arms no window');
  A.eq(q.noted('reflection', 'f', { runId: 'rf1', replied: true }), false, '...for any pass');
  A.eq(q.streak('f'), 0, '...and folds nothing into the fresh hero\'s policy');
  A.eq(q.noted('study', 'f', { runId: 'never-ended', replied: true }), false, '...nor does an attempt from a run never seen end, once the agent was forgotten');
  q.ended('rf2');
  A.eq(q.noted('study', 'f', { runId: 'rf2', replied: true }), true, 'forget: a run that ended after the reset arms as usual');
  A.eq(q.noted('study', 'g', { runId: 'rf1', replied: true }), true, 'forget is per agent');

  const W = 300000;
  A.eq(p.bypass('failure-review', 'f', { failureClass: 'failed|provider_stream|format_error', windowMs: W }), 'new-failure-class', 'a class never reviewed skips the window');
  p.noted('failure-review', 'f', { replied: true, failureClass: 'failed|provider_stream|format_error' });
  t += 10000;
  A.eq(p.bypass('failure-review', 'f', { failureClass: 'failed|provider_stream|format_error', windowMs: W }), '', 'the same class inside its window does not');
  A.eq(p.bypass('failure-review', 'f', { failureClass: 'failed|provider_stream|model_not_found', windowMs: W }), 'new-failure-class', 'a NEW class does');
  A.eq(p.bypass('reflection', 'f', { failureClass: 'failed|provider_stream|model_not_found', windowMs: W }), '', 'a failure class opens only the failure review');
  t += W;
  A.eq(p.bypass('failure-review', 'f', { failureClass: 'failed|provider_stream|format_error', windowMs: W }), 'new-failure-class', 'a class last reviewed a whole window ago is due again');
  for (let i = 0; i < 17; i++) p.noted('failure-review', 'g', { replied: true, failureClass: 'c' + i });
  A.eq(p.bypass('failure-review', 'g', { failureClass: 'c0', windowMs: W }), 'new-failure-class', 'the oldest of 17 classes is dropped (16 kept per agent)');
  A.eq(p.bypass('failure-review', 'g', { failureClass: 'c16', windowMs: W }), '', '...the newest is kept');

  p.open('a'); p.noted('reflection', 'a', { replied: true }); p.noted('reflection', 'a', { replied: true });
  p.forget('a'); p.forget('g');
  A.eq([p.streak('a'), p.bypass('study', 'a', {}), p.bypass('failure-review', 'g', { failureClass: 'c16', windowMs: W })], [0, '', 'new-failure-class'], 'forget drops the streak, the open feedback and the reviewed classes');

  const mod = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'learning-cooldown.js'), 'utf8');
  A.ok(!/Date\.now|new Date|process\.|require\(/.test(mod), 'the policy is pure: no clock of its own, no IO, no env');
}

/* ---------- 2. the composition root's own resolver, on a fake clock ---------- */
{
  const due = sidecarTopLevelFunction('learningPassDue');
  const note = sidecarTopLevelFunction('noteLearningAttempt');
  A.ok(due.length > 200 && note.length > 100, 'fixture: learningPassDue and noteLearningAttempt are top-level functions of the sidecar');
  const build = (memoryConfig, threadMs) => {
    let now = 1e12;
    const clock = { now: () => now };
    const maps = { lastReflectAt: new Map(), lastFailReviewAt: new Map(), lastStudyAt: new Map(), lastThreadMineAt: new Map() };
    let persisted = 0;
    const policy = LC.make({ now: () => now });
    const logs = [];
    const fns = new Function('Date', 'lastReflectAt', 'lastFailReviewAt', 'lastStudyAt', 'lastThreadMineAt', 'memoryConfig', 'THREAD_MINE_COOLDOWN_MS',
      'learningCooldown', 'persistStudyState', 'console',
      due + '\n' + note + '\nreturn { learningPassDue, noteLearningAttempt };')(
      clock, maps.lastReflectAt, maps.lastFailReviewAt, maps.lastStudyAt, maps.lastThreadMineAt, memoryConfig, threadMs,
      policy, () => { persisted++; }, { log: m => logs.push(m) });
    return Object.assign(fns, { maps, policy, logs, advance: ms => { now += ms; }, persisted: () => persisted });
  };
  const DEFAULTS = { reflectCooldownMs: 180000, failureReviewCooldownMs: 300000, studyCooldownMs: 1800000 };

  // four quick NONE runs (20 s apart) of one agent: each learning pass is attempted ONCE (base: reflection + study every run)
  const h = build(Object.assign({}, DEFAULTS), 1200000);
  const attempts = [];
  for (let run = 1; run <= 4; run++) {
    h.policy.ended('run-' + run);
    const got = ['reflection', 'study', 'threadmine'].filter(k => h.learningPassDue(k, 'agent'));
    got.forEach(k => h.noteLearningAttempt(k, 'agent', { runId: 'run-' + run, replied: true, produced: false }));
    attempts.push(got.join('+') || '-');
    h.advance(20000);
  }
  A.eq(attempts, ['reflection+study+threadmine', '-', '-', '-'], 'four quick NONE runs: every learning pass is attempted once, then held by its window');
  A.eq(h.persisted(), 1, 'study\'s attempt stamp is persisted (study.state.json), once');
  h.policy.open('agent', 'cue'); h.policy.ended('run-5');
  A.ok(h.learningPassDue('reflection', 'agent'), 'a correction cue inside the window still gets reflection');
  A.ok(h.logs.some(l => /\[learning\] reflection may spend inside its window: agent=agent \(cue\)/.test(l)), 'and the sidecar log says why (' + h.logs.join(' | ') + ')');
  A.eq(h.logs.length, 1, 'nothing is logged for a pass whose window was simply open or simply closed');

  // the NONE ladder rides the CONFIGURED window
  const r = build(Object.assign({}, DEFAULTS, { reflectCooldownMs: 5000 }), 1200000);
  r.noteLearningAttempt('reflection', 'x', { replied: true }); r.advance(6000);
  A.ok(r.learningPassDue('reflection', 'x'), 'one NONE: the configured 5 s window, nothing more');
  r.noteLearningAttempt('reflection', 'x', { replied: true }); r.advance(6000);
  A.ok(!r.learningPassDue('reflection', 'x'), 'two NONEs: x4 = 20 s, so 6 s later is still inside it');
  r.advance(14000);
  A.ok(r.learningPassDue('reflection', 'x'), '...and 20 s later it is due');

  // a window of 0 (TIME BETWEEN SUGGESTIONS 0) stays 0, whatever the streak
  const z = build(Object.assign({}, DEFAULTS, { reflectCooldownMs: 0, studyCooldownMs: 0 }), 0);
  for (let i = 0; i < 5; i++) z.noteLearningAttempt('reflection', 'z', { replied: true });
  A.ok(z.learningPassDue('reflection', 'z') && z.learningPassDue('study', 'z') && z.learningPassDue('threadmine', 'z'), 'a 0 window stays 0: the backoff multiplies, never adds');

  // failure review: one class once per window, a new class gets through, and the window is the configured one
  const f = build(Object.assign({}, DEFAULTS), 1200000);
  const CLS = 'failed|provider_stream|format_error';
  A.ok(f.learningPassDue('failure-review', 'f', { failureClass: CLS }), 'the first failure is reviewed');
  f.noteLearningAttempt('failure-review', 'f', { replied: true, failureClass: CLS });
  f.advance(10000);
  A.ok(!f.learningPassDue('failure-review', 'f', { failureClass: CLS }), 'the same class 10 s later is not');
  A.ok(f.learningPassDue('failure-review', 'f', { failureClass: 'failed|provider_stream|model_not_found' }), 'a new class 10 s later is');
  A.eq(f.maps.lastFailReviewAt.size, 1, 'the attempt armed the failure-review window');

  // a stored verdict opens the windows; a pass that was already running when it landed never spends it
  const v = build(Object.assign({}, DEFAULTS), 1200000);
  v.policy.ended('rv1');                                                   // run 1 ends, its reflection starts
  v.policy.open('v', 'feedback');                                          // the verdict lands mid-pass
  v.noteLearningAttempt('reflection', 'v', { runId: 'rv1', replied: true });
  A.ok(v.maps.lastReflectAt.has('v'), 'fixture: run 1\'s attempt armed the window');
  v.advance(1000); v.policy.ended('rv2');
  A.ok(v.learningPassDue('reflection', 'v'), 'the run after a verdict that landed mid-pass still reflects inside the window');
  v.noteLearningAttempt('reflection', 'v', { runId: 'rv2', replied: true });
  v.advance(1000); v.policy.ended('rv3');
  A.ok(!v.learningPassDue('reflection', 'v'), '...once: run 2\'s attempt spent it');
  A.ok(!v.learningPassDue('scout', 'v'), 'the resolver answers only for the four learning passes');

  // a call that FAILED (review r2 blocker): it arms its window, but uses up no verdict and reviews no failure class
  const x = build(Object.assign({}, DEFAULTS), 1200000);
  x.policy.ended('rx1'); x.noteLearningAttempt('reflection', 'x', { runId: 'rx1', replied: true });   // run 1: NONE, window armed
  x.advance(1000); x.policy.open('x', 'feedback'); x.policy.ended('rx2');                             // a verdict, then run 2 ends
  A.ok(x.learningPassDue('reflection', 'x'), 'fixture: run 2 reflects inside the window because of the verdict');
  const armedAt = x.maps.lastReflectAt.get('x');
  x.advance(1000); x.noteLearningAttempt('reflection', 'x', { runId: 'rx2', replied: false, produced: false });   // ...and its call fails
  A.ok(x.maps.lastReflectAt.get('x') > armedAt, 'a failed attempt arms its window too (it went out)');
  x.advance(1000); x.policy.ended('rx3');
  A.ok(x.learningPassDue('reflection', 'x'), 'the run after a FAILED attempt still reflects inside the window: the verdict was never read, so it was not used up');
  x.noteLearningAttempt('reflection', 'x', { runId: 'rx3', replied: true });
  x.advance(1000); x.policy.ended('rx4');
  A.ok(!x.learningPassDue('reflection', 'x'), '...once: the answered attempt used it up');
  x.noteLearningAttempt('failure-review', 'y', { runId: 'rx4', replied: false, failureClass: CLS });
  A.ok(x.maps.lastFailReviewAt.has('y'), 'fixture: the failed review armed its window');
  x.advance(1000);
  A.ok(x.learningPassDue('failure-review', 'y', { failureClass: CLS }), 'a failure review whose call failed leaves its class unreviewed: the next failure of that class inside the window is still reviewed');
  A.ok(x.logs.some(l => /\[learning\] failure-review may spend inside its window: agent=y \(new-failure-class\)/.test(l)), '...as a new failure class (the sidecar log says so)');
  x.noteLearningAttempt('failure-review', 'y', { runId: 'rx4', replied: true, failureClass: CLS });
  x.advance(1000);
  A.ok(!x.learningPassDue('failure-review', 'y', { failureClass: CLS }), '...and an answered review marks it reviewed');

  // a reset while a pass runs: the pass ends after it and arms nothing (base: a productive pass re-stamped; W1.4 r1: any)
  const g = build(Object.assign({}, DEFAULTS), 1200000);
  g.policy.ended('rg1');
  g.policy.forget('hero');
  g.noteLearningAttempt('study', 'hero', { runId: 'rg1', replied: true, produced: true });
  A.eq([g.maps.lastStudyAt.has('hero'), g.persisted()], [false, 0], 'a study that outlived a reset leaves no stamp and persists nothing (the hero\'s key never comes back)');
  g.policy.ended('rg2');
  g.noteLearningAttempt('study', 'hero', { runId: 'rg2', replied: true });
  A.eq([g.maps.lastStudyAt.has('hero'), g.persisted()], [true, 1], 'a run after the reset stamps and persists as usual');
}

/* ---------- 3. the family invariant over the composition root ---------- */
{
  const src = readSidecarSource();
  const idx = readSidecarIndex();   // index.js alone where the lock is about the host's own wiring
  const STAMPS = ['lastReflectAt', 'lastFailReviewAt', 'lastStudyAt', 'lastThreadMineAt'];
  const note = sidecarTopLevelFunction('noteLearningAttempt');
  const due = sidecarTopLevelFunction('learningPassDue');
  for (const m of STAMPS) {
    const sets = (src.match(new RegExp('\\b' + m + '\\.set\\(', 'g')) || []).length;
    A.eq(sets, 1, m + ' is armed in exactly one place');
    A.ok(new RegExp('\\b' + m + '\\.set\\(agentId, at\\)').test(note), '...noteLearningAttempt');
    A.ok(note.indexOf('if (!learningCooldown.noted(kind, agentId, r)) return;') >= 0 && note.indexOf('if (!learningCooldown.noted(') < note.indexOf(m + '.set('),
      m + ': the policy is asked first, so an attempt that outlived its agent arms nothing');
  }
  A.ok(/else if \(kind === 'study'\) \{ lastStudyAt\.set\(agentId, at\); persistStudyState\(\); \}/.test(note), 'study\'s attempt stamp is persisted, so it survives a restart');

  // the configured windows, compared in ONE place (the settings-P1 lock keeps pinning the reflection comparison)
  A.ok(/open = Date\.now\(\) - \(lastReflectAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.reflectCooldownMs \* learningCooldown\.scale\('reflection', agentId\);/.test(due), 'reflection: its configured window, times the NONE backoff');
  A.ok(/open = Date\.now\(\) - \(lastFailReviewAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.failureReviewCooldownMs;/.test(due), 'failure review: its configured window');
  A.ok(/open = Date\.now\(\) - \(lastStudyAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.studyCooldownMs;/.test(due), 'study: its configured window');
  A.ok(/open = Date\.now\(\) - \(lastThreadMineAt\.get\(agentId\) \|\| 0\) >= THREAD_MINE_COOLDOWN_MS;/.test(due), 'thread mining: its configured window');
  A.ok(due.indexOf('if (open) return true;') < due.indexOf('learningCooldown.bypass('), 'the bypass is consulted only when the window is closed');
  for (const m of STAMPS) A.eq((src.match(new RegExp('Date\\.now\\(\\) - \\(' + m + '\\.get\\(', 'g')) || []).length, 1, m + ': no second elapsed check anywhere');

  // every pass stamps its ATTEMPT in finally, with the run it learned from, read off its own meter before book() zeroes it
  for (const [fn, kind] of [['runReflection', 'reflection'], ['runFailureReview', 'failure-review'], ['runStudy', 'study'], ['runThreadMine', 'threadmine']]) {
    const body = sidecarTopLevelFunction(fn);
    A.ok(body.length > 500, fn + ' sliced');
    const fin = body.slice(body.lastIndexOf('finally {'));
    const at = fin.indexOf("if (spend.calls()) noteLearningAttempt('" + kind + "', agentId, { runId, replied, produced: kept");
    A.ok(at > 0, fn + ': its finally notes the attempt, with its runId, when its meter counted a call');
    A.ok(at < fin.indexOf('spend.book('), fn + ': ...before book() zeroes the meter');
    A.ok(!STAMPS.some(m => body.indexOf(m + '.set(') >= 0), fn + ': no window is armed on a surviving proposal any more');
    A.ok(/let replied = false, kept = false;/.test(body) && /const text = await spend\.stream\(provider, req, cost\);\s*replied = !!String\(text \|\| ''\)\.trim\(\);\s*return text;/.test(body), fn + ': a reply is what the model really answered');
    A.ok(/if \(proposals\.length\) \{\s*(?:\/\/[^\n]*\n\s*)?kept = true;/.test(body), fn + ': a surviving proposal marks the attempt productive');
  }
  A.ok(/failureClass: LearningCooldown\.failureClass\(o\)/.test(sidecarTopLevelFunction('runFailureReview')), 'the failure review notes the class it read');

  // every gate reads the one resolver, with its own kind; the run's end takes its order AFTER its own cue opened
  const core = sidecarTopLevelFunction('runOnceCore');
  const gate = name => { const g = core.indexOf('const ' + name + ' = '); return g < 0 ? '' : core.slice(g, core.indexOf(';\n', g)); };
  for (const [name, call] of [['_gateReflect', "learningPassDue('reflection', agentId)"], ['_gateFailReview', "learningPassDue('failure-review', agentId, { failureClass: _learnFailClass })"],
    ['_gateStudy', "learningPassDue('study', agentId)"], ['_gateThreadmine', "learningPassDue('threadmine', agentId)"]]) {
    const g = gate(name);
    A.ok(g.indexOf(call) > 0, name + ' reads the resolver: ' + call);
    A.ok(!/Date\.now\(\)/.test(g), name + ' keeps no elapsed check of its own');
  }
  const CUE_OPEN = "if (LearningCooldown.cueIn(commanderWords)) learningCooldown.open(agentId, 'cue');";
  const ENDED = 'learningCooldown.ended(runId);';
  A.ok(core.indexOf(CUE_OPEN) > 0, 'a cue in the Commander\'s own latest words opens the agent\'s learning windows at the run\'s end');
  A.ok(/const commanderWords = trustedLearningInput \? trustedLearningInput\.content : '';/.test(core), '...read from commanderWords, host-minted from the owner\'s own surfaces (trusted learning input), never a routine\'s or a worker\'s brief');
  A.ok(core.indexOf(CUE_OPEN) < core.indexOf(ENDED), 'the run\'s end takes its order after its own cue, so its own passes spend the cue');
  A.ok(core.indexOf(ENDED) > 0 && core.indexOf(ENDED) < core.indexOf('runStore.record({ runId, parentRunId:'), '...and before the run\'s row exists (review r2 nit): a rating, correction or KEEP THIS STYLE on this run needs the row, so it lands after that order and waits for the next run\'s passes');
  A.ok(core.indexOf(ENDED) < core.indexOf('const _gateReflect = '), '...so every pass the run-end fires reads at that order');
  A.ok(/try \{ if \(LearningCooldown\.cueIn\(commanderWords\)\) learningCooldown\.open\(agentId, 'cue'\); learningCooldown\.ended\(runId\); \} catch \(e\) \{ failNote\('learning\.cooldown', e\); \}/.test(core), '...fail-open inside the run\'s finally: a throw there never replaces the run\'s own outcome');
  A.eq((core.match(/learningCooldown\.ended\(/g) || []).length, 1, 'a run\'s end is recorded in one place');
  A.ok(/const _learnFailClass = LearningCooldown\.failureClass\(\{ outcome: _leadOc\.outcome, failureStage: execution\.failureStage\(\), failureCode: execution\.failureCode\(\) \}\);/.test(core), 'the gate\'s failure class is built from the same facts the review is handed');

  // FEEDBACK IS CRITICAL: the ONE feedback write path opens the windows for every like/dislike, and every surface goes through it
  const rec = sidecarTopLevelFunction('recordFeedbackMemory');
  const OPEN = "learningCooldown.open(agentId, 'feedback')";
  A.ok(rec.indexOf(OPEN) > 0, 'recordFeedbackMemory opens the agent\'s learning windows');
  A.ok(rec.indexOf("return { stored: false, reason: 'personalization-paused' }") < rec.indexOf(OPEN), '...never while learning is paused (nothing learns then)');
  A.ok(rec.indexOf(OPEN) < rec.indexOf('await notebookStore.update(') && rec.indexOf(OPEN) < rec.indexOf("reason: 'nothing to learn'")
    && rec.indexOf(OPEN) < rec.indexOf("reason: 'could not save'"), '...and whatever the save keeps: a verdict that adds nothing new (a wordless CLOSE, a repeated chip) or a save that fails still opens them (verdicts always bypass)');
  for (const route of ['handleGrowthRatings', 'handleGrowthRatingCorrection', 'handleTasteKeepStyle', 'handleRoutingFixSuggest'])
    A.ok(/recordFeedbackMemory\(\{/.test(sidecarTopLevelFunction(route)), route + ' stores its like/dislike through recordFeedbackMemory (so it opens the windows)');
  A.eq((src.match(/learningCooldown\.open\(/g) || []).length, 2, 'the windows open in exactly two places: a stored like/dislike and a run\'s cue');
  A.ok(/learningCooldown\.forget\(agentId\);/.test(sidecarTopLevelFunction('handleMemoryReset')), 'a memory reset forgets the policy state');
  A.eq((idx.match(/learningCooldown\.forget\(agentId\);/g) || []).length, 2, 'agent delete and memory reset both forget it');
  // a fresh hero inherits no learning window (review r2 nit: thread mining's stamp was never cleared, and every attempt arms it now)
  for (const route of ['handleMemoryReset', 'handleAgentDelete']) {
    const body = sidecarTopLevelFunction(route);
    for (const m of STAMPS.concat(['reflectingNow', 'failReviewingNow', 'studyingNow', 'threadMiningNow']))
      A.ok(body.indexOf(m + '.delete(agentId)') > 0 && body.indexOf(m + '.delete(agentId)') < body.indexOf('learningCooldown.forget(agentId);'), route + ' clears ' + m + ' before it forgets the policy state');
  }
  A.ok(/^const learningCooldown = LearningCooldown\.make\(\{ now: \(\) => Date\.now\(\) \}\);$/m.test(idx), 'the host injects the clock');
}

A.report('learning-cooldown.test');
