/* node test/rec-evidence.test.js — W2 of the recommendation perfection campaign: EVIDENCE EVERYWHERE.

   The audit's SECOND root cause: `internal:true` starves the generators. An internal run keeps the caller's
   prompt verbatim — right for a strict-format parse, and wrong for the three components that must GUESS what
   the Commander wants next. The First Pitch, the goal decomposition and the ongoing suggestion were reasoning
   from strictly LESS about the Commander than an ordinary task run receives: no learned topics with their
   verbatim quotes, no open threads, no verdict patterns, no recent activity, no active goal.

   This suite holds the two halves of the fix:

     1. THE EVIDENCE PACK REACHES THEM — `evidence:true` rides the browser call, the route, and runOnce, and
        appends the SAME bounded, provenance-labelled pack (commander-context.js) an ordinary task gets. And
        NOTHING ELSE about the internal path changes: no manual, no capability summary, no skills.
     2. THE SUGGEST EVIDENCE CONTRACT — the model must produce the Commander's OWN words, that quote is VETOED
        against what the station actually knows (fail-closed), only a survivor is spoken as «because you said»,
        and the ledger row finally distinguishes a real quote from the model's own rationale.

   Plus the Q3 staleness guard the earlier plan named but never wired: a pitch is never silently aimed at a
   belief the station itself would not assert. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const P = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(P(...p), 'utf8');

const Pitch = require('../frontend/app/pitch.js');
const CommanderContext = require('../sidecar/commander-context.js');
const Autopilot = require('../frontend/app/autopilot.js');
const RecQuality = require('../frontend/app/recquality.js');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   1. THE EVIDENCE PACK — composed, bounded, and honestly labelled
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
{
  const pack = CommanderContext.compose({
    dossier: 'They run a two-person studio.',
    goal: { title: 'ship the launch' },
    topics: [{ label: 'crypto prices', count: 7, evidence: ['I check prices every morning'] }],
    threads: [{ title: 'the pricing page', spec: 'rewrite the tiers' }],
    activity: ['drafted the launch email'],
    verdicts: { kinds: { recipe: { weight: 0.4, positive: 4, negative: 1 } } }
  });
  A.ok(pack.indexOf('crypto prices') >= 0, 'the pack carries the learned topics a generator was being denied');
  A.ok(pack.indexOf('I check prices every morning') >= 0, '…WITH the verbatim quote that earned the topic');
  A.ok(pack.indexOf('OPEN THREAD: the pricing page') >= 0, '…the open threads');
  A.ok(pack.indexOf('RECENT ACTIVITY: drafted the launch email') >= 0, '…the recent activity');
  A.ok(pack.indexOf('VERDICT PATTERNS') >= 0, '…and the verdict patterns');
  A.ok(pack.indexOf('<active_goal provenance="commander-confirmed">') >= 0, 'the goal is labelled as commander-confirmed');
  A.ok(/observed; weak; never override the current request/.test(pack),
    'the observed half is labelled WEAK — a generator may lean on it, never treat it as a stated belief');
  // the dossier is not duplicated when the caller's system prompt already carries it (the composer's own law)
  const dup = CommanderContext.compose({ dossier: 'They run a two-person studio.', existingSystem: 'x They run a two-person studio. y' });
  A.eq(dup.indexOf('<commander_context'), -1, 'the pack never re-injects a dossier the system prompt already holds');
  A.eq(CommanderContext.compose({}), '', 'a station that knows nothing composes NOTHING (no empty scaffolding)');
}

/* the wiring, end to end: browser flag → request body → runOnce opt → the one place it is spent.
   Source-locked because the seam is a live HTTP run, and locked at EVERY hop so a silently dropped flag
   (which would look exactly like "the model ignored the evidence") cannot pass. */
const harnessSrc = read('frontend/app/harness.js');
A.ok(/async function chat\(\{[^}]*\bevidence\b/.test(harnessSrc), 'Harness.chat accepts an evidence flag');
A.ok(/if \(evidence\) reqBody\.evidence = true;/.test(harnessSrc), '…and puts it on the request body');
const idxSrc = readSidecarSource();
A.ok(/const evidence = !!\(body && body\.evidence\);/.test(idxSrc), 'the route reads it');
A.ok(/trigger: 'directive', internal, evidence,/.test(idxSrc), '…and hands it to runOnce');
A.ok(/if \(internal && o\.evidence\) \{/.test(idxSrc), 'runOnce composes the pack ONLY for an internal run that asked');
A.ok(/const t = commanderEvidenceContext\(system \|\| ''\);/.test(idxSrc), '…through the same composer ordinary task runs use');
A.ok(/\? \(String\(system \|\| ''\) \+ evidenceBlock\)/.test(idxSrc),
  'the pack is APPENDED to the system prompt — the caller’s strict-format directive stays the last thing read');
// …and the rest of the internal path is untouched: still no manual/capability/skill dressing, still no memory fence
const sysAssign = idxSrc.slice(idxSrc.indexOf('const sys = internal'), idxSrc.indexOf('// H1.2: bulletproof resume'));
A.eq(/manualBlock|summarizeCapabilities|skillBlock/.test(sysAssign.split(': withQuests')[0]), false,
  'an internal run STILL receives no manual, capability summary or skill catalog (only the evidence it asked for)');
A.ok(/if \(!internal\) try \{\s*const stored = notebookStore\.get/.test(idxSrc),
  'the memory fence + recall-stat writes remain gated on `internal` alone — evidence buys no recall credit');

// the three generators ask for it, and nothing else does
for (const [file, label] of [['frontend/app/pitchstore.js', 'the First Pitch'],
                             ['frontend/app/goalstore.js', 'the goal decomposition'],
                             ['frontend/app/suggeststore.js', 'the ongoing suggestion']]) {
  const src = read(file);
  const calls = src.match(/Harness\.chat\(\{[^)]*internal: true[^)]*\}\)/g) || [];
  A.ok(calls.length > 0, label + ' makes an internal reason-only call');
  A.eq(calls.every(c => /evidence: true/.test(c)), true, '…and EVERY one of its generator calls asks for the evidence pack');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   2. THE SUGGEST EVIDENCE CONTRACT — the quote must be asked for, vetoed, and only then spoken
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
// the directive asks for it ONLY when the caller will veto it (the First Pitch's contract stays byte-identical)
{
  const base = { recipes: [], capabilities: [] };
  const plain = Pitch.buildDirective(base);
  A.eq(plain.indexOf('EVIDENCE:'), -1, 'the First Pitch directive is unchanged — no EVIDENCE line it would not check');
  const withEv = Pitch.buildDirective(Object.assign({ wantEvidence: true }, base));
  A.ok(withEv.indexOf('EVIDENCE:') >= 0, 'the suggestion directive asks for the Commander’s own words');
  A.ok(/quoted verbatim/.test(withEv), '…verbatim');
  A.ok(/never your own paraphrase/.test(withEv), '…never a paraphrase');
  A.ok(/write NONE/.test(withEv), '…and gives the model an HONEST way out (it is allowed to have nothing)');
  A.ok(withEv.indexOf('EVIDENCE:') < withEv.indexOf('BUILD:'), 'the format block keeps one stable field order');
}
// the parse: absent, NONE, and quote-wrapped all read honestly
{
  const mk = ev => 'PITCH: a thing\nWHY: it fits\n' + (ev == null ? '' : 'EVIDENCE: ' + ev + '\n') + 'BUILD: workflow\nGAP: your taste';
  A.eq(Pitch.parsePitch(mk(null)).evidence, '', 'no EVIDENCE line → no receipt');
  A.eq(Pitch.parsePitch(mk('NONE')).evidence, '', 'an explicit NONE → no receipt (the model saying so is honest)');
  A.eq(Pitch.parsePitch(mk('none')).evidence, '', '…case-insensitively');
  A.eq(Pitch.parsePitch(mk('“I check prices every morning”')).evidence, 'I check prices every morning',
    'surrounding quote marks are stripped — the caller owns the quoting');
  A.eq(Pitch.parsePitch(mk('I check prices every morning')).evidence, 'I check prices every morning', 'a bare quote passes through');
}
/* the VETO, proved through the real engine on the real pool shape. `grounded` is the same predicate autojobs
   uses on its GROUNDS line, so a quote must share a significant token with something the station knows. */
{
  const pool = Autopilot.flattenBeliefs({ pain: ['I lose an hour every morning on crypto prices'], goals: ['ship the studio launch'] });
  A.eq(Autopilot.grounded('I check crypto prices every morning', pool), true, 'a quote anchored in a real belief survives');
  A.eq(Autopilot.grounded('you love bicycle maintenance in Lisbon', pool), false, 'an INVENTED quote is refused');
  A.eq(Autopilot.grounded('', pool), false, 'an empty quote grounds nothing');
  A.eq(Autopilot.grounded('ship the studio launch', []), false,
    'an EMPTY POOL grounds nothing — a check that could not run has not passed (fail-closed)');
}
// …and the store spends it exactly that way (source-locked: the fire path is a live model call + DOM nudge)
const sugSrc = read('frontend/app/suggeststore.js');
const groundFn = A.fnBody(sugSrc, 'function groundQuote(raw)');
A.ok(/if \(!A \|\| !A\.grounded \|\| !A\.flattenBeliefs\) return '';/.test(groundFn), 'no veto engine → no quote (fail-closed)');
A.ok(/if \(!pool\.length\) return '';/.test(groundFn), 'no evidence pool → no quote (fail-closed)');
A.ok(/return ok \? q\.slice\(0, 200\) : '';/.test(groundFn), 'only a grounded quote is returned, bounded');
const fireBody = A.fnBody(sugSrc, 'async function fire()');
A.ok(/const groundedQuote = groundQuote\(parsed\.evidence\);/.test(fireBody), 'the fire path vetoes the model’s quote');
A.ok(/const receipt = groundedQuote \? \(' ' \+ citeLine\(groundedQuote\)\) : '';/.test(fireBody),
  'a surviving quote becomes the spoken receipt; an ungrounded one renders NOTHING');
A.ok(/\+ why \+ receipt \+ credit \+ gap/.test(fireBody), '…inside the same one-line nudge (never a second beat)');
const citeFn = A.fnBody(sugSrc, 'function citeLine(quote)');
A.ok(/Recommend\.whyLine/.test(citeFn), 'the receipt speaks the ONE grammar every other recommendation surface uses');
A.ok(/you said “/.test(citeFn), '…and «you said» is reserved for words that survived the veto');
// the ledger row now separates a real quote from model prose
A.ok(/if \(groundedQuote\) evidenceRows\.push\(\{ id: 'suggest-evidence', type: 'quote', quote: groundedQuote \}\);/.test(fireBody),
  'a grounded quote is ledgered as REAL quote-typed evidence');
A.ok(/if \(parsed\.why\) evidenceRows\.push\(\{ id: 'suggest-rationale', type: 'rationale', text: parsed\.why \}\);/.test(fireBody),
  '…beside the model’s own rationale, still typed as rationale (the W3 law holds)');
A.eq(/type: 'quote', quote: parsed\.why/.test(sugSrc), false, 'the model’s prose is NEVER quote-typed');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   3. THE Q3 STALENESS GUARD ON THE PROBE (named in the quality-loop plan, wired here)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
{
  const now = 1700000000000;
  const DAY = 86400000;
  const uRead = { dims: { goals: { weight: 1, conf: 0.2 } } };   // a poorly-corroborated dimension
  const old = RecQuality.staleness({ text: 'ship the launch', updatedAt: now - 60 * DAY }, now, uRead, 'goals');
  A.eq(old.stale, true, 'an old belief on a weakly-corroborated dimension reads STALE');
  const fresh = RecQuality.staleness({ text: 'ship the launch', updatedAt: now - 2 * DAY }, now, uRead, 'goals');
  A.eq(fresh.stale, false, '…a recent one does not');
  const noStamp = RecQuality.staleness({ text: 'ship the launch' }, now, uRead, 'goals');
  A.eq(noStamp.stale, false, 'a belief with no timestamp is never called stale (never a fabricated age)');
}
// probeTarget must CARRY the record, or the guard above can never run (it was {dim,text} only)
const usSrc = read('frontend/app/understandingstore.js');
A.ok(/return text \? \{ dim: best\.dim, text, belief \} : null;/.test(A.fnBody(usSrc, 'function probeTarget()')),
  'probeTarget carries the whole belief record — staleness is read from its own timestamps');
A.ok(/if \(st && st\.stale\) probe = null;/.test(fireBody),
  'a STALE probe target is dropped: the idea goes out un-aimed rather than aimed at a memory we would not assert');
A.ok(fireBody.indexOf('probe = null') < fireBody.indexOf('Pitch.buildDirective'),
  '…before the directive is built, so the stale belief never reaches the model at all');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   4. THE NEXT MILESTONE REACHES THE GENERATORS
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
{
  const base = { recipes: [], capabilities: [] };
  A.eq(Pitch.buildDirective(base).indexOf('NEXT unfinished milestone'), -1,
    'no goal decomposition → no milestone line (never a fabricated target)');
  A.eq(Pitch.buildDirective(Object.assign({ nextMilestone: '   ' }, base)).indexOf('NEXT unfinished milestone'), -1,
    '…and a blank one is not a milestone either');
  const d = Pitch.buildDirective(Object.assign({ nextMilestone: 'pick the launch date' }, base));
  A.ok(d.indexOf('"pick the launch date"') >= 0, 'a real next milestone reaches the model');
  A.ok(/it beats anything else you could suggest/.test(d), '…as the thing to beat, not as background');
  const long = Pitch.buildDirective(Object.assign({ nextMilestone: 'x'.repeat(500) }, base));
  A.ok(long.indexOf('x'.repeat(240)) >= 0 && long.indexOf('x'.repeat(241)) < 0, 'the milestone is bounded at 240 chars');
}
/* WHY THE MILESTONE IS A PROMPT FACT AND NOT A NEW SPINE TERM, recorded rather than left as a gap: the plan
   floated a `goalAligned` within-band modifier. Nothing in the pass produces that field — and the quality lane
   already proved (0 of 20000) what a modifier no candidate populates is worth. A term is added when a builder
   can honestly compute it; until then this fact belongs where it changes the OUTPUT, which is the directive. */
for (const [file, label] of [['frontend/app/pitchstore.js', 'the First Pitch'],
                             ['frontend/app/suggeststore.js', 'the ongoing suggestion']]) {
  const src = read(file);
  A.ok(/nextMilestone: nextMilestone\(\)/.test(src), label + ' passes the next milestone into its directive');
  A.ok(/const nx = u && u\.goal && u\.goal\.next;/.test(A.fnBody(src, 'function nextMilestone()')),
    '…read from the live understanding read, never cached or guessed');
}

A.report('rec evidence (W2)');
