/* node test/learning-cooldown.test.js — W1.4 LEARNING-PASS COOLDOWNS: the one resolver, unit + family invariant.

   Reflection, failure review, study and thread mining each armed their window only when a proposal survived, so a pass
   whose model replied NONE fired again on the very next run (base e316231d7: four quick runs, eight one-shot passes).
   The family now closes in ONE place: sidecar/learning-cooldown.js holds the policy (NONE backoff, cue / verdict /
   new-failure-class bypass) and sidecar/index.js reads it through learningPassDue (every gate) and noteLearningAttempt
   (every pass's finally, on an attempt whose meter counted a model call). This file proves:
     1. the pure policy (scale ladder, bypass reasons, verdicts consumed once per pass, failure classes, forget);
     2. the composition root's real learningPassDue / noteLearningAttempt, run on a fake clock: four quick NONE runs
        attempt each pass once, a cue still reflects, a window of 0 stays 0, study's stamp is persisted;
     3. the family invariant over index.js: no window is armed anywhere else, every gate reads the resolver, every pass
        stamps its attempt before its meter is booked, verdicts and corrections open the windows, resets forget them.
   The live proof (real sidecar, mock provider, counted calls) is test/learning-cooldown.e2e.test.js. */
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
    'Don’t add emojis', 'please do not quote me', 'dont number the notes'])
    A.ok(LC.cueIn(t), 'cue: "' + t + '"');
  for (const t of ['save note 5 in the workspace root', 'inspect the station', 'the preferably cheaper option', 'a rememberable name',
    'neverland map', '', null, undefined, '   '])
    A.ok(!LC.cueIn(t), 'no cue: ' + JSON.stringify(t));

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

  A.eq(p.bypass('reflection', 'a', {}), '', 'no cue, no verdict: the window decides');
  A.eq(p.bypass('reflection', 'a', { cue: true }), 'cue', 'a cue skips the window');
  A.eq(p.bypass('study', 'a', { cue: true }), 'cue', '...for every learning pass');
  A.eq(p.bypass('scout', 'a', { cue: true }), '', 'never for a pass outside the family');
  A.eq(p.bypass('reflection', 'a', { cue: 'yes' }), '', 'only a real cue flag counts');

  p.open('a');
  for (const k of LC.KINDS) A.eq(p.bypass(k, 'a', {}), 'verdict', 'a verdict opens ' + k);
  A.eq(p.bypass('reflection', 'b', {}), '', 'a verdict opens only its own agent');
  p.noted('reflection', 'a', { replied: true });
  A.eq(p.bypass('reflection', 'a', {}), '', 'the verdict is consumed by the pass\'s next attempt');
  A.eq(p.bypass('study', 'a', {}), 'verdict', '...one pass at a time: study is still open');
  for (const k of ['study', 'threadmine', 'failure-review']) p.noted(k, 'a', { replied: true });
  A.eq(LC.KINDS.map(k => p.bypass(k, 'a', {})), ['', '', '', ''], 'once every pass attempted, the verdict is spent');

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
  A.eq([p.streak('a'), p.bypass('study', 'a', {}), p.bypass('failure-review', 'g', { failureClass: 'c16', windowMs: W })], [0, '', 'new-failure-class'], 'forget drops the streak, the open verdict and the reviewed classes');

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
    const got = ['reflection', 'study', 'threadmine'].filter(k => h.learningPassDue(k, 'agent', { cue: false }));
    got.forEach(k => h.noteLearningAttempt(k, 'agent', { replied: true, produced: false }));
    attempts.push(got.join('+') || '-');
    h.advance(20000);
  }
  A.eq(attempts, ['reflection+study+threadmine', '-', '-', '-'], 'four quick NONE runs: every learning pass is attempted once, then held by its window');
  A.eq(h.persisted(), 1, 'study\'s attempt stamp is persisted (study.state.json), once');
  A.ok(h.learningPassDue('reflection', 'agent', { cue: true }), 'a correction cue inside the window still gets reflection');
  A.ok(h.logs.some(l => /\[learning\] reflection may spend inside its window: agent=agent \(cue\)/.test(l)), 'and the sidecar log says why (' + h.logs.join(' | ') + ')');
  A.eq(h.logs.length, 1, 'nothing is logged for a pass whose window was simply open or simply closed');

  // the NONE ladder rides the CONFIGURED window
  const r = build(Object.assign({}, DEFAULTS, { reflectCooldownMs: 5000 }), 1200000);
  r.noteLearningAttempt('reflection', 'x', { replied: true }); r.advance(6000);
  A.ok(r.learningPassDue('reflection', 'x', {}), 'one NONE: the configured 5 s window, nothing more');
  r.noteLearningAttempt('reflection', 'x', { replied: true }); r.advance(6000);
  A.ok(!r.learningPassDue('reflection', 'x', {}), 'two NONEs: x4 = 20 s, so 6 s later is still inside it');
  r.advance(14000);
  A.ok(r.learningPassDue('reflection', 'x', {}), '...and 20 s later it is due');

  // a window of 0 (TIME BETWEEN SUGGESTIONS 0) stays 0, whatever the streak
  const z = build(Object.assign({}, DEFAULTS, { reflectCooldownMs: 0, studyCooldownMs: 0 }), 0);
  for (let i = 0; i < 5; i++) z.noteLearningAttempt('reflection', 'z', { replied: true });
  A.ok(z.learningPassDue('reflection', 'z', {}) && z.learningPassDue('study', 'z', {}) && z.learningPassDue('threadmine', 'z', {}), 'a 0 window stays 0: the backoff multiplies, never adds');

  // failure review: one class once per window, a new class gets through, and the window is the configured one
  const f = build(Object.assign({}, DEFAULTS), 1200000);
  const CLS = 'failed|provider_stream|format_error';
  A.ok(f.learningPassDue('failure-review', 'f', { failureClass: CLS }), 'the first failure is reviewed');
  f.noteLearningAttempt('failure-review', 'f', { replied: true, failureClass: CLS });
  f.advance(10000);
  A.ok(!f.learningPassDue('failure-review', 'f', { failureClass: CLS }), 'the same class 10 s later is not');
  A.ok(f.learningPassDue('failure-review', 'f', { failureClass: 'failed|provider_stream|model_not_found' }), 'a new class 10 s later is');
  A.eq(f.maps.lastFailReviewAt.size, 1, 'the attempt armed the failure-review window');

  // a verdict opens the windows once
  const v = build(Object.assign({}, DEFAULTS), 1200000);
  v.noteLearningAttempt('reflection', 'v', { replied: true });
  A.ok(!v.learningPassDue('reflection', 'v', {}), 'fixture: inside the window');
  v.policy.open('v');
  A.ok(v.learningPassDue('reflection', 'v', {}), 'a thumbs verdict opens the window');
  v.noteLearningAttempt('reflection', 'v', { replied: true });
  A.ok(!v.learningPassDue('reflection', 'v', {}), '...once');
  A.ok(!v.learningPassDue('scout', 'v', { cue: true }), 'the resolver answers only for the four learning passes');
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
  }
  A.ok(/else if \(kind === 'study'\) \{ lastStudyAt\.set\(agentId, at\); persistStudyState\(\); \}/.test(note), 'study\'s attempt stamp is persisted, so it survives a restart');
  A.ok(/learningCooldown\.noted\(kind, agentId, r\);/.test(note), 'every attempt reaches the policy');

  // the configured windows, compared in ONE place (the settings-P1 lock keeps pinning the reflection comparison)
  A.ok(/open = Date\.now\(\) - \(lastReflectAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.reflectCooldownMs \* learningCooldown\.scale\('reflection', agentId\);/.test(due), 'reflection: its configured window, times the NONE backoff');
  A.ok(/open = Date\.now\(\) - \(lastFailReviewAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.failureReviewCooldownMs;/.test(due), 'failure review: its configured window');
  A.ok(/open = Date\.now\(\) - \(lastStudyAt\.get\(agentId\) \|\| 0\) >= memoryConfig\.studyCooldownMs;/.test(due), 'study: its configured window');
  A.ok(/open = Date\.now\(\) - \(lastThreadMineAt\.get\(agentId\) \|\| 0\) >= THREAD_MINE_COOLDOWN_MS;/.test(due), 'thread mining: its configured window');
  A.ok(due.indexOf('if (open) return true;') < due.indexOf('learningCooldown.bypass('), 'the bypass is consulted only when the window is closed');
  for (const m of STAMPS) A.eq((src.match(new RegExp('Date\\.now\\(\\) - \\(' + m + '\\.get\\(', 'g')) || []).length, 1, m + ': no second elapsed check anywhere');

  // every pass stamps its ATTEMPT in finally, read off its own meter before book() zeroes it, and nowhere else
  for (const [fn, kind] of [['runReflection', 'reflection'], ['runFailureReview', 'failure-review'], ['runStudy', 'study'], ['runThreadMine', 'threadmine']]) {
    const body = sidecarTopLevelFunction(fn);
    A.ok(body.length > 500, fn + ' sliced');
    const fin = body.slice(body.lastIndexOf('finally {'));
    const at = fin.indexOf("if (spend.calls()) noteLearningAttempt('" + kind + "', agentId, { replied, produced: kept");
    A.ok(at > 0, fn + ': its finally stamps the attempt when its meter counted a call');
    A.ok(at < fin.indexOf('spend.book('), fn + ': ...before book() zeroes the meter');
    A.ok(!STAMPS.some(m => body.indexOf(m + '.set(') >= 0), fn + ': no window is armed on a surviving proposal any more');
    A.ok(/let replied = false, kept = false;/.test(body) && /const text = await spend\.stream\(provider, req, cost\);\s*replied = !!String\(text \|\| ''\)\.trim\(\);\s*return text;/.test(body), fn + ': a reply is what the model really answered');
    A.ok(/if \(proposals\.length\) \{\s*(?:\/\/[^\n]*\n\s*)?kept = true;/.test(body), fn + ': a surviving proposal marks the attempt productive');
  }
  A.ok(/failureClass: LearningCooldown\.failureClass\(o\)/.test(sidecarTopLevelFunction('runFailureReview')), 'the failure review notes the class it read');

  // every gate reads the one resolver, with its own kind; the cue is the Commander's own latest words only
  const core = sidecarTopLevelFunction('runOnceCore');
  const gate = name => { const g = core.indexOf('const ' + name + ' = '); return g < 0 ? '' : core.slice(g, core.indexOf(';\n', g)); };
  for (const [name, call] of [['_gateReflect', "learningPassDue('reflection', agentId, { cue: _learnCue })"], ['_gateFailReview', "learningPassDue('failure-review', agentId, { cue: _learnCue, failureClass: _learnFailClass })"],
    ['_gateStudy', "learningPassDue('study', agentId, { cue: _learnCue })"], ['_gateThreadmine', "learningPassDue('threadmine', agentId, { cue: _learnCue })"]]) {
    const g = gate(name);
    A.ok(g.indexOf(call) > 0, name + ' reads the resolver: ' + call);
    A.ok(!/Date\.now\(\)/.test(g), name + ' keeps no elapsed check of its own');
  }
  A.ok(/const _learnCue = LearningCooldown\.cueIn\(commanderWords\);/.test(core), 'the cue is read from commanderWords');
  A.ok(/const commanderWords = trustedLearningInput \? trustedLearningInput\.content : '';/.test(core), '...which is host-minted from the owner\'s own surfaces (trusted learning input), never a routine\'s or a worker\'s brief');
  A.ok(/const _learnFailClass = LearningCooldown\.failureClass\(\{ outcome: _leadOc\.outcome, failureStage: execution\.failureStage\(\), failureCode: execution\.failureCode\(\) \}\);/.test(core), 'the gate\'s failure class is built from the same facts the review is handed');
  A.ok(core.indexOf('const _learnCue = ') > core.indexOf('const _learn = ') && core.indexOf('const _learnCue = ') < core.indexOf('const _gateReflect = '), 'the cue is read before the first gate');

  // FEEDBACK IS CRITICAL: a verdict and its correction open the windows; a reset forgets the policy state
  const ratings = sidecarTopLevelFunction('handleGrowthRatings');
  A.ok(/if \(!result\.duplicate\) \{[^}]*learningCooldown\.open\(lead\.agentId \|\| 'agent'\);/.test(ratings), 'a first-time thumbs verdict opens the agent\'s learning windows');
  const corr = sidecarTopLevelFunction('handleGrowthRatingCorrection');
  A.ok(/else if \(rating && lead && !lead\.internal\) \{\s*learningCooldown\.open\(lead\.agentId \|\| 'agent'\);/.test(corr), 'a correction recorded as feedback opens them too');
  A.ok(/learningCooldown\.forget\(agentId\);/.test(sidecarTopLevelFunction('handleMemoryReset')), 'a memory reset forgets the policy state');
  A.eq((idx.match(/learningCooldown\.forget\(agentId\);/g) || []).length, 2, 'agent delete and memory reset both forget it');
  A.ok(/^const learningCooldown = LearningCooldown\.make\(\{ now: \(\) => Date\.now\(\) \}\);$/m.test(idx), 'the host injects the clock');
}

A.report('learning-cooldown.test');
