/* node test/rec-one-memory.test.js — W1 of the recommendation perfection campaign: ONE MEMORY.

   The audit found the station keeping TWO recommendation memories that never spoke to each other: the durable
   cross-surface LEDGER (written by the bay/scout, study, suggest and autojobs; read by six propose-time filters)
   and the browser QUALITY EWMA (read only by the spine). This suite holds the wire between them:

     1. THE SHARED MATCH KEY — the browser's normalization is byte-for-byte the sidecar's, so a title declined on
        one side is the same key on the other. If these drift, suppression silently disagrees across the app.
     2. THE WRITE — the spine's offers become `shown` rows; the Commander's answer becomes that row's terminal
        state; the channels that mint their own rows, and the two that are not offers at all, are refused.
     3. THE READ — an explicitly declined title is matched exactly (never fuzzily), and every failure mode of the
        read leaves the station ranking as if this module did not exist.
     4. THE LEARNED PREFERENCE TERM — the ledger's own decayed weight reaches the spine, is bounded, is two-sided,
        and still cannot cross a priority band.
     5. THE WIRING — recAccept/recDecline really do reach the ledger, the pass really does drop a declined
        candidate, and the impression is recorded AFTER the card renders (source-locked: DOM flow). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const P = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(P(...p), 'utf8');
/* the async sections drive the SAME singleton (RecLedger) and the same fake clock, so they must run in
   sequence — parallel blocks interleave their inits and re-reads and assert against each other's state. */
const STEPS = [];
const PENDING = [new Promise((res, rej) => setTimeout(() => {
  STEPS.reduce((p, fn) => p.then(fn), Promise.resolve()).then(res, rej);
}, 0))];

const { RecLedger } = require('../frontend/app/recledger.js');
const Recommend = require('../frontend/app/recommend.js');
const DeclinedIndex = require('../sidecar/declinedindex.js');
const Ledger = require('../sidecar/recommendation-ledger.js');

/* a fake api: records every request and answers from a scripted queue. Every test drives the REAL module through
   its injected fetch — nothing here reaches into private state to simulate a request that never happened. */
function harness(responses) {
  const calls = [];
  let i = 0;
  const fetch = (u, init) => {
    calls.push({ u: String(u), init: init || null, body: (init && init.body) ? JSON.parse(init.body) : null });
    const r = Array.isArray(responses) ? responses[Math.min(i++, responses.length - 1)] : responses;
    if (r === 'reject') return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: r !== 'error', json: () => Promise.resolve(r && r.json ? r.json : {}) });
  };
  return { calls, fetch, posts: () => calls.filter(c => c.init && c.init.method === 'POST').map(c => c.body) };
}
let clock = 1000;
const nowFn = () => clock;

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   1. THE SHARED MATCH KEY
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const KEY_CASES = ['Draft the Q3 report', '  draft   the  Q3   report!! ', 'DRAFT — THE “Q3” REPORT.',
  'ship it', '', '   ', '!!!', 'a-b_c', 'Ünicode näme', '42'];
for (const s of KEY_CASES) {
  A.eq(RecLedger.normKey(s), DeclinedIndex.normKey(s),
    'the browser match key equals the sidecar match key for ' + JSON.stringify(s));
}
A.eq(RecLedger.normKey('Draft the Q3 report'), RecLedger.normKey('  DRAFT — the “Q3” report!! '),
  'case, punctuation and whitespace collapse to ONE key (an exact match is still an exact match after rewording nothing)');
A.eq(RecLedger.normKey('draft the q3 report') === RecLedger.normKey('draft the q4 report'), false,
  '…but two genuinely different titles are two different keys — the bar is exact, never fuzzy');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   2. THE WRITE
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
{
  const h = harness({ json: { entries: [], model: null } });
  RecLedger.init({ fetch: h.fetch, now: nowFn });

  // a channel that proposes an idea gets a row, titled with the idea and typed honestly
  const id = RecLedger.note({ kind: 'seed', title: 'summarize my inbox', why: 'you keep asking me to “summarize my inbox” (4×)' });
  A.ok(!!id, 'an offer with a title mints a ledger row');
  const rows = h.posts().filter(b => b && b.surface === 'spine');
  A.eq(rows.length, 1, 'exactly one `shown` row was posted');
  A.eq(rows[0].kind, 'seed', 'the row carries the channel as its kind (so the ledger can learn a per-kind weight)');
  A.eq(rows[0].title, 'summarize my inbox', 'the row is titled with the PROPOSAL, which is what the declined memory matches on');
  A.eq(rows[0].evidence[0].type, 'rationale',
    'the station-composed why line is typed RATIONALE, never a quote of the Commander (the W3 law, applied here)');
  A.eq(rows[0].evidence[0].quote, undefined, '…and it never lands in the quote column');
  A.eq(rows[0].target, Ledger.fingerprint('summarize my inbox'),
    'the row target is the ledger’s OWN fingerprint shape, so replay can find it later');

  // …and a verbatim-carrying channel may say so
  RecLedger.note({ kind: 'thread', title: 'automate the weekly digest', why: 'you said “I keep rebuilding this digest”', evidenceKind: 'verbatim' });
  const t = h.posts().filter(b => b && b.kind === 'thread')[0];
  A.eq(t.evidence[0].type, 'quote', 'a channel carrying the Commander’s real words may type its evidence as a quote');

  // the refusals
  const before = h.posts().length;
  A.eq(RecLedger.note({ kind: 'study', title: 'you prefer python' }), '', 'study mints its OWN rows — refused here');
  A.eq(RecLedger.note({ kind: 'suggest', title: 'an idea' }), '', 'suggest mints its OWN rows — refused here');
  A.eq(RecLedger.note({ kind: 'rate', title: 'rate this run' }), '', 'the rating is not an offer the station chose to make — refused');
  A.eq(RecLedger.note({ kind: 'memory', title: 'a belief' }), '', 'the reflection deck is not an offer either — refused');
  A.eq(RecLedger.note({ kind: 'curiosity', title: '' }), '', 'no title means no row (evidence-or-silence, applied to bookkeeping)');
  A.eq(RecLedger.note({ kind: '', title: 'orphan' }), '', 'no channel means no row');
  A.eq(RecLedger.note(null), '', 'a null candidate is not a row');
  A.eq(h.posts().length, before, '…and NONE of those refusals sent a request');

  // the verdict lands on the row the note minted, exactly once
  const seedRowId = rows[0].id;
  A.eq(RecLedger.accepted('seed'), true, 'an accept finds the seed row');
  const verdicts = h.posts().filter(b => b && b.state);
  A.eq(verdicts.length, 1, 'one verdict posted');
  A.eq(verdicts[0].id, seedRowId, '…onto the row this channel’s offer minted');
  A.eq(verdicts[0].state, 'accepted', '…with the accepted state');
  A.eq(RecLedger.accepted('seed'), false, 'the row is consumed — a second answer for the same channel records nothing');
  A.eq(h.posts().filter(b => b && b.state).length, 1, '…and sends nothing');

  // decline vs defer speak the ledger's own vocabulary
  RecLedger.note({ kind: 'routine', title: 'weekly report' });
  A.eq(RecLedger.declined('routine', true), true, 'a “not now” is recorded');
  const d1 = h.posts().filter(b => b && b.state).slice(-1)[0];
  A.eq(d1.state + '/' + d1.reason, 'deferred/wrong_time', '…as a DEFERRAL about timing, not a verdict on the thing');
  RecLedger.note({ kind: 'recruit', title: 'recruit a Researcher' });
  A.eq(RecLedger.declined('recruit', false), true, 'a plain decline is recorded');
  const d2 = h.posts().filter(b => b && b.state).slice(-1)[0];
  A.eq(d2.state + '/' + d2.reason, 'declined/wrong_thing', '…as a verdict on the thing itself');
  A.eq(RecLedger.declined('trust', false), false, 'a channel that never showed a card has nothing to answer for');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   2b. THE OUTCOME WIRE + THE IMPRESSION TTL (dead-wires lane, 2026-08-28)
   Two audit findings, one seam: spine rows never received an outcome (the ledger's replay() quality term was
   structurally zero for surface `spine`), and no writer anywhere set `expiresAt` (unanswered impressions
   depressed acceptanceRate forever). note() now declares an expiry; settle() carries the quality store's
   attributed outcomes onto the accepted row.
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
{
  const h = harness({ json: { entries: [], model: null } });
  clock = 2000;
  RecLedger.init({ fetch: h.fetch, now: nowFn });

  // the TTL: every impression declares when it stops being answerable
  RecLedger.note({ kind: 'seed', title: 'summarize my inbox', why: 'you keep asking (4×)' });
  const shown = h.posts().filter(b => b && b.surface === 'spine')[0];
  A.eq(shown.expiresAt, 2000 + RecLedger.SHOWN_TTL_MS,
    'every spine impression declares an expiry, so an ignored card lapses instead of depressing acceptance forever');
  A.eq(RecLedger.SHOWN_TTL_MS, 14 * 86400000, '…14 days, the scout draft TTL — the one existing answer to this question');

  // an accept keeps the row awaiting its outcome; the run's finish advances it
  A.eq(RecLedger.accepted('seed'), true, 'the accept is recorded (precondition)');
  A.eq(RecLedger.settle('seed', 'completed', 'run-1'), true, 'the spawned run finishing settles the row');
  const st = h.posts().filter(b => b && b.state).slice(-1)[0];
  A.eq(st.id + '/' + st.state + '/' + st.reason, shown.id + '/completed/completed',
    '…as state `completed` on the SAME row the impression minted');

  // the Commander's rating becomes outcome.quality — the number replay() folds
  A.eq(RecLedger.settle('seed', 'great', 'run-1'), true, 'a 👍 after the finish still finds the row');
  const oc = h.posts().slice(-1)[0];
  A.eq(oc.id, shown.id, 'the quality lands on the same row');
  A.eq(oc.outcome.quality, 1, 'great → +1 (the vocabulary suggeststore already posts)');
  A.eq(oc.outcome.runId, 'run-1', '…attributed to the run that earned it');
  A.eq(RecLedger.settle('seed', 'ok', 'run-1'), false, 'a rating closes the row — nothing can re-settle it');

  // ok / miss map honestly
  RecLedger.note({ kind: 'arc', title: 'decompose the goal' });
  RecLedger.accepted('arc');
  RecLedger.settle('arc', 'miss', 'run-2');
  A.eq(h.posts().slice(-1)[0].outcome.quality, -1, 'miss → −1');

  // an accept whose work never came is dropped silently — the ledger has no accepted→deferred edge, correctly
  RecLedger.note({ kind: 'routine', title: 'weekly report' });
  RecLedger.accepted('routine');
  const n0 = h.posts().length;
  A.eq(RecLedger.settle('routine', 'deferred', ''), false, 'no run inside the window → nothing to post');
  A.eq(h.posts().length, n0, '…and nothing was posted');
  A.eq(RecLedger.settle('routine', 'great', 'run-9'), false,
    '…and the row is gone, so a much-later unrelated rating can never be attributed to it');

  // the verdict path's own vocabulary is refused here, and a channel with nothing awaiting says nothing
  RecLedger.note({ kind: 'recruit', title: 'recruit a Researcher' });
  RecLedger.accepted('recruit');
  A.eq(RecLedger.settle('recruit', 'engaged', ''), false, 'engaged/declined belong to the verdict path — refused');
  A.eq(RecLedger.settle('curiosity', 'completed', ''), false, 'a channel that never had an accept has no outcome to report');
  RecLedger.note({ kind: 'curiosity', title: 'what is your stack' });
  A.eq(RecLedger.declined('curiosity', false), true, 'a declined offer… (precondition)');
  A.eq(RecLedger.settle('curiosity', 'completed', ''), false, '…never awaits an outcome');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   3. THE READ
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
STEPS.push(async () => {
  const h = harness({ json: {
    entries: [{ id: 'x1', title: 'Draft the Q3 report', state: 'declined' },
              { id: 'x2', title: 'ship the newsletter', state: 'declined' },
              { id: 'x3', title: '', state: 'declined' }],
    model: { kinds: { seed: { weight: 0.4 }, recruit: { weight: -0.6 } }, traits: { 'dim:goals': { weight: 0.2 } }, projects: {} }
  } });
  clock = 5000;
  RecLedger.init({ fetch: h.fetch, now: nowFn });
  await RecLedger.refresh(true);

  A.eq(h.calls[0].u, '/api/recommendations?state=declined&limit=250',
    'ONE request answers both questions the spine needs — the declined titles and the learned model');
  A.eq(RecLedger.isDeclined('draft the q3 report'), true, 'an explicitly declined title is a hit, normalized');
  A.eq(RecLedger.isDeclined('  DRAFT — the “Q3” REPORT!  '), true, '…through case, punctuation and spacing');
  A.eq(RecLedger.isDeclined('draft the q4 report'), false, 'a different title is NOT suppressed (a false suppression is the worse error)');
  A.eq(RecLedger.isDeclined('ship'), false, '…and a mere SUBSTRING of a declined title is not a hit either');
  A.eq(RecLedger.isDeclined(''), false, 'an empty candidate never matches');
  A.eq(RecLedger.isDeclined('   '), false, '…nor a whitespace-only one');
  A.eq(RecLedger.isDeclined(null), false, '…nor a missing one');
  A.eq(RecLedger._declinedKeys().length, 2, 'the untitled declined row contributed no phantom key');

  // the learned weight
  A.eq(RecLedger.preferenceOf('seed', ['seed']), 0.4, 'a kind the Commander has accepted reads positive');
  A.eq(RecLedger.preferenceOf('recruit', ['recruit']), -0.6, '…and one they keep declining reads negative');
  A.eq(RecLedger.preferenceOf('arc', ['arc', 'dim:goals']), 0.2, 'a kind with no history still reads its traits');
  A.eq(RecLedger.preferenceOf('nosuchkind', []), 0, 'nothing to read is 0 — never a fabricated lean');
  A.eq(RecLedger.preferenceOf('seed', ['seed', 'dim:goals']), 0.30000000000000004,
    'kind and trait weights AVERAGE, exactly as the sidecar’s preferenceFor does');

  // parity with the authority: the browser copy must agree with the module that computed the model
  const model = { kinds: { seed: { weight: 0.4 } }, traits: { 'dim:goals': { weight: 0.2 } }, projects: {} };
  A.eq(RecLedger.preferenceOf('seed', ['seed', 'dim:goals']),
    Ledger.preferenceFor(model, { kind: 'seed', traits: ['seed', 'dim:goals'] }),
    'the browser preference read equals the sidecar’s preferenceFor for the same model and candidate');

  // clamped, both ways
  RecLedger._setModelForTest({ kinds: { wild: { weight: 99 } }, traits: {}, projects: {} });
  A.eq(RecLedger.preferenceOf('wild', []), 0.75, 'a corrupt oversized weight is clamped to the ledger’s own range');
  RecLedger._setModelForTest({ kinds: { wild: { weight: -99 } }, traits: {}, projects: {} });
  A.eq(RecLedger.preferenceOf('wild', []), -0.75, '…in both directions');
  RecLedger._setModelForTest({ kinds: { wild: { weight: 'nonsense' } }, traits: {}, projects: {} });
  A.eq(RecLedger.preferenceOf('wild', []), 0, 'an unreadable weight is no reading at all');
});

// EVERY failure mode of the read leaves the station exactly as it was
STEPS.push(async () => {
  for (const [label, resp, okExpected] of [
    ['a rejected request', 'reject', false], ['a non-ok response', 'error', false],
    // an OK response with nothing in it is a SUCCESSFUL read of an empty ledger, not a failure — what matters
    // is that it neither suppresses nor leans, and that a malformed body cannot throw.
    ['a body with no entries', { json: {} }, true], ['a null body', { json: null }, true]]) {
    const h = harness(resp);
    clock += 100000;
    RecLedger.init({ fetch: h.fetch, now: nowFn });
    const ok = await RecLedger.refresh(true);
    A.eq(ok, okExpected, label + ' settles (' + okExpected + ') rather than throwing');
    A.eq(RecLedger.isDeclined('anything at all'), false, '…and suppresses nothing (fail-open)');
    A.eq(RecLedger.preferenceOf('seed', ['seed']), 0, '…and leans nowhere');
  }
  // no fetch injected and no Harness in scope: still silent, still safe
  clock += 100000;
  RecLedger.init({ now: nowFn });
  A.eq(await RecLedger.refresh(true), false, 'with no way to reach the ledger at all, the read simply fails open');
  A.eq(RecLedger.note({ kind: 'seed', title: 'x' }).indexOf('spine:seed:') === 0, true,
    '…and a write still mints its local row (the POST is fire-and-forget by contract)');
});

// the throttle: repeated reads inside the window coalesce, a forced one always goes
STEPS.push(async () => {
  const h = harness({ json: { entries: [], model: null } });
  clock = 900000;
  RecLedger.init({ fetch: h.fetch, now: nowFn });
  await RecLedger.refresh(true);
  const n = h.calls.length;
  await RecLedger.refresh();
  A.eq(h.calls.length, n, 'a second read inside the window is coalesced — a decline storm cannot flood the sidecar');
  clock += 61 * 1000;
  await RecLedger.refresh();
  A.eq(h.calls.length, n + 1, '…and past the window it reads again');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   4. THE LEARNED PREFERENCE TERM IN THE SPINE
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
A.eq(Recommend.preferenceTerm({}), 0, 'an absent preference contributes nothing');
A.eq(Recommend.preferenceTerm({ preference: null }), 0, '…so does a null one');
A.eq(Recommend.preferenceTerm({ preference: 'nonsense' }), 0, '…and an unparseable one (allowlist, not denylist)');
A.eq(Recommend.preferenceTerm({ preference: false }), 0, '…and a boolean, which Number() would have read as a hard 0');
A.eq(Recommend.preferenceTerm({ preference: 0 }), 0, 'a genuine zero is genuinely neutral');
A.eq(Recommend.preferenceTerm({ preference: 0.75 }), Recommend.PREF_MAX, 'the ledger’s maximum maps to the term’s maximum');
A.eq(Recommend.preferenceTerm({ preference: -0.75 }), -Recommend.PREF_MAX, '…and its minimum to the minimum');
A.eq(Recommend.preferenceTerm({ preference: 900 }), Recommend.PREF_MAX, 'a weight outside the ledger’s range is clamped, never scaled');
A.eq(Recommend.preferenceTerm({ preference: -900 }), -Recommend.PREF_MAX, '…both ways');

// it is TWO-SIDED, unlike strength and quality — that is the whole point, so lock it
A.ok(Recommend.preferenceTerm({ preference: 0.5 }) > 0, 'a liked kind is genuinely PROMOTED (the Commander’s yes counts)');
A.ok(Recommend.preferenceTerm({ preference: -0.5 }) < 0, '…and a disliked one demoted');

// it reorders inside a band…
{
  const base = { why: 'x' };
  const liked = Object.assign({ kind: 'recruit', preference: 0.75 }, base);
  const disliked = Object.assign({ kind: 'seed', preference: -0.75 }, base);
  A.eq(Recommend.sameBand('seed', 'recruit'), true, 'seed and recruit share a band (precondition)');
  A.ok(Recommend.score(liked) > Recommend.score(disliked),
    'a lower-ranked kind the Commander keeps saying yes to outranks a higher-ranked one they keep declining');
  A.eq(Recommend.pick([disliked, liked]).kind, 'recruit', '…and pick() really returns it');
}
// …and never across one, at any combination of every modifier at its extreme
{
  const upper = { kind: 'suggest', why: 'x' };   // strongest gentle-band kind
  const lower = { kind: 'curiosity', why: 'x' };  // weakest gentle-band kind — same band, so pick a real cross-band pair
  A.eq(Recommend.bandOf('rate') < Recommend.bandOf('suggest'), true, 'rate sits in a HIGHER band than the gentle channels');
  const weakestHigh = { kind: 'rate', why: 'x', preference: -0.75, strength: 0, quality: 0.5, declines: 99 };
  const strongestLow = { kind: 'suggest', why: 'x', preference: 0.75, streak: 99, quality: 1.25,
                         dim: 'goals' };
  const uRead = { dims: { goals: { weight: 1, conf: 0 } } };   // maximum value-of-information
  A.ok(Recommend.score(weakestHigh, uRead) > Recommend.score(strongestLow, uRead),
    'a bottomed-out candidate in a higher band still outranks a maxed-out one below it — the band wall holds with the new term');
  A.ok(2 * Recommend.MOD_CAP < Recommend.BAND_GAP_MIN, '…structurally, not by luck');
  A.ok(Recommend.PREF_MAX * 2 < Recommend.BAND_GAP_MIN, '…and the new term alone is nowhere near the wall');
  A.ok(Recommend.PREF_MAX > Recommend.RANK_STEP, '…while still being big enough to overturn a rank tie, which is its job');
  void upper; void lower;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   5. THE WIRING (source-locked: DOM flow / load order, not node-loadable)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const chatSrc = read('frontend/app/chat.js');
const accept = A.fnBody(chatSrc, 'function recAccept(channel, dim, spawnsWork, id)');
const decline = A.fnBody(chatSrc, 'function recDecline(channel, dim, deferred)');
A.ok(/RecLedger\.accepted\(channel\)/.test(accept), 'every accept reaches the one ledger (recAccept is the choke point)');
A.ok(/RecQualityStore\.noteAccept/.test(accept), '…without losing the browser quality loop');
A.ok(/RecLedger\.declined\(channel, !!deferred\)/.test(decline), 'every decline reaches the one ledger, carrying whether it was a deferral');
A.ok(/RecQualityStore\.noteDecline/.test(decline), '…without losing the browser quality loop');
A.ok(/!deferred && RecLedger\.refresh/.test(decline),
  'a real decline re-reads the shared memory (it changed what the station may propose); a deferral does not');

const pass = A.fnBody(chatSrc, 'async function recommendPass(p, phase)');
A.ok(/c\.preference = recPreferenceOf\(c\.kind, c\.dim\)/.test(pass), 'the pass attaches the learned preference to every candidate');
A.ok(/if \(recAlreadyDeclined\(c\)\) \{[^}]*continue/.test(pass), 'the pass DROPS a candidate whose exact proposal was already declined');
A.ok(pass.indexOf('const winner = Recommend.pick(live') > pass.indexOf('recAlreadyDeclined'),
  '…before the pick, so a suppressed candidate can never win the moment');
A.ok(pass.indexOf('RecLedger.note(winner)') > pass.indexOf('winner.fire()'),
  'the impression is recorded AFTER the card renders — a `shown` row for a card that never appeared is a lie');
A.ok(/if \(c === study\) study = null; if \(c === thread\) thread = null;/.test(pass),
  '…and a suppressed turn-in is not re-queued to be suppressed again next run');

// the builders that propose an IDEA carry the name of it; the ledger cannot match on a card it cannot name
for (const [fn, header] of [['arcCandidate', 'function arcCandidate(runId)'],
                            ['seedCandidate', 'function seedCandidate()'],
                            ['routineCandidate', 'function routineCandidate()'],
                            ['recruitCandidate', 'function recruitCandidate()'],
                            ['curiosityCandidate', 'function curiosityCandidate()'],
                            ['trustCandidate', 'function trustCandidate(runId)'],
                            ['threadCandidate', 'async function threadCandidate(runId, agentId)']]) {
  A.ok(/title:/.test(A.fnBody(chatSrc, header)), fn + ' carries a ledger title');
}

/* registration + init. Load ORDER does not matter here — chat.js touches RecLedger only at call time, behind
   `typeof` guards (locked below), exactly as it already does for RecQualityStore, which also loads after it. */
A.ok(read('frontend/index.html').indexOf('app/recledger.js') > 0, 'recledger.js is on the page');
A.ok(/typeof RecLedger !== 'undefined'/.test(accept) && /typeof RecLedger !== 'undefined'/.test(decline),
  'chat.js guards every RecLedger touch with a typeof check, so script order can never break a card');
A.ok(/RecLedger\.init\(\{ now: \(\) => Date\.now\(\) \}\)/.test(read('frontend/app/app.js')),
  'app.js initializes it alongside the other recommendation stores');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   6. THE LEDGER'S NEW SEAMS — declined targets, and the expiry sweep
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
STEPS.push(async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-w1-'));
  const led = Ledger.makeRecommendationLedger({ fs, path, workspaces: dir });
  const T = 1700000000000;
  await led.record({ id: 'r1', surface: 'recipe', title: 'Daily briefing', target: 'daily-briefing' }, T);
  await led.record({ id: 'r2', surface: 'recipe', title: 'Weekly digest', target: 'weekly-digest' }, T);
  await led.verdict('r1', 'declined', 'not_relevant', T + 1000);
  const texts = led.declinedTexts();
  A.ok(texts.indexOf('Daily briefing') >= 0, 'a declined row is still recognizable by its title');
  A.ok(texts.indexOf('daily-briefing') >= 0,
    '…AND by its target — a shelf decline (target = the recipe id) now reaches the shared declined index');
  A.eq(texts.indexOf('weekly-digest'), -1, 'an un-declined row contributes neither');

  // the expiry sweep: only rows that DECLARED an expiry, past it, and never answered
  await led.record({ id: 'e1', surface: 'spine', title: 'lapses unanswered', expiresAt: T + 5000 }, T);
  await led.record({ id: 'e2', surface: 'spine', title: 'answered in time', expiresAt: T + 5000 }, T);
  await led.verdict('e2', 'declined', 'wrong_thing', T + 2000);
  await led.record({ id: 'e3', surface: 'spine', title: 'declared no expiry' }, T);
  const dropped = await led.sweep(T + 10000);
  A.eq(dropped, 1, 'the sweep drops exactly the one unanswered, expired row');
  const ids = led.read().entries.map(e => e.id);
  A.eq(ids.indexOf('e1'), -1, 'the lapsed impression is gone (it was never answerable, so it may not depress acceptance)');
  A.ok(ids.indexOf('e2') >= 0, 'a row the Commander ANSWERED is kept forever — an expiry is never a verdict');
  A.ok(ids.indexOf('e3') >= 0, 'a row that declared no expiry is untouched');
  A.ok(led.declinedTexts().indexOf('answered in time') >= 0, '…and the kept decline still feeds the index');
  A.eq(await led.sweep(0), 0, 'a sweep with no clock does nothing');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   7. THE SHELVES CONSULT THE ONE MEMORY, AND EVERY SHELF CARD CAN DECLINE (source-locked: DOM flow)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const mktSrc = read('frontend/app/marketplace.js');
A.eq((mktSrc.match(/shelfDeclined\(/g) || []).length >= 6, true,   // the definition + 5 consult sites
  'the shared declined read gates the personalized shelves (FOR YOU, READY, lineup, curated, gap)');
A.ok(/Recipes\.list\(\)\.filter\(r => !shelfDeclined\(r && r\.name\)\)/.test(mktSrc),
  '…and it gates the INPUT pool, so an exclusion refills the shelf instead of shrinking it (the shelf-sink law)');
for (const fn of ['function recCardHTML(s, why, compact)', 'function forYouCardHTML(r, why)', 'function readyCardHTML(o)']) {
  A.ok(/declineGlyphHTML\(/.test(A.fnBody(mktSrc, fn)), fn + ' carries the ✕ decline affordance');
}
const glyph = A.fnBody(mktSrc, 'function declineGlyphHTML(surface, id, name)');
A.ok(/<span class="mkt-rec-decline" role="button" tabindex="0"/.test(glyph),
  'the ✕ is a span (the card is a <button>; a button may not nest one), keyboard-reachable');
A.ok(/esc\(surface\)/.test(glyph) && /esc\(id\)/.test(glyph) && /esc\(name\)/.test(glyph),
  '…and every attribute it interpolates is escaped (the W3 XSS law)');
const declFn = A.fnBody(mktSrc, 'function declineShelfItem(surface, id, name)');
A.ok(/recommendationVerdict\(surface, id, 'declined', 'not_relevant'\)/.test(declFn),
  'a shelf ✕ posts a real declined verdict onto the row this card\'s impression minted');
A.ok(/RecLedger\.refresh\) RecLedger\.refresh\(true\)/.test(declFn),
  '…and re-reads the shared memory so the spine sees the decline this session');
A.ok(/ev\.stopPropagation\(\)/.test(mktSrc.slice(mktSrc.indexOf('.mkt-rec-decline').valueOf())),
  'the ✕ click stops before the card\'s own open handler (declining is not opening)');
// the gap shelf dedups against what the shelf above already showed this paint
A.ok(/shelfShownClassIds && shelfShownClassIds\.has\(x\.s\.id\)/.test(A.fnBody(mktSrc, 'function interestGapShelfHTML()')),
  'the gap shelf never repeats the class the curated/lineup shelf just recommended (cross-shelf dedup)');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   8. ONE ASK BUDGET FOR THE OFF-SPINE BEATS (source-locked: their gates are DOM/bus flow)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
A.ok(/askBudgetSpent, spendAsk \};\s*$/m.test(chatSrc) || /setRosterStatus, askBudgetSpent, spendAsk/.test(chatSrc),
  'chat.js exports the shared budget (read + spend) for the off-spine beats');
const pitchSrc = read('frontend/app/pitchstore.js');
A.ok(/Chat\.askBudgetSpent\(\)\) return \{ go: false, reason: 'ask-budget' \}/.test(pitchSrc),
  'the First Pitch defers on a spent budget (and stays un-pitched, so it returns at a quieter moment)');
A.ok(pitchSrc.indexOf('Chat.spendAsk()') > pitchSrc.indexOf('state.pitched = true'),
  '…and spends only a pitch that actually reached the screen');
const nnSrc = read('frontend/app/nightnudge.js');
A.ok(/Chat\.askBudgetSpent && Chat\.askBudgetSpent\(\)\) return/.test(nnSrc),
  'the night-shift "review?" nudge waits on a spent budget (the drafts and the morning report still carry it)');
A.ok(/if \(Chat\.spendAsk\) Chat\.spendAsk\(\)/.test(nnSrc), '…and spends when it fires');
const qrSrc = read('frontend/app/questrefreshstore.js');
A.ok(/Chat\.askBudgetSpent === 'function'\) \? Chat\.askBudgetSpent\(\) : false/.test(qrSrc),
  'the north-star confirm routes to its ambient fallback on a spent budget');
A.ok(/if \(shown && typeof Chat\.spendAsk === 'function'\)/.test(qrSrc),
  '…and spends only a nudge that actually claimed the slot');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   9. THE EVAL SCORECARD HAS A RUNTIME CONSUMER (source-locked: route table)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const idxSrc = readSidecarSource();
A.ok(/qsplit: '\/api\/recommendations\/eval', h: handleRecommendationsEval/.test(idxSrc),
  'GET /api/recommendations/eval serves the scorecard over the REAL ledger (it had zero runtime consumers)');
A.ok(/RecommendationEval\.evaluate\(rows/.test(idxSrc), '…through the same pure evaluate() the CI script uses');
A.ok(/recommendationLedger\.sweep\(Date\.now\(\)\)/.test(idxSrc),
  'the recommendations read lapses expired un-answered rows (the scoutSweep discipline)');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   10. THE DEAD WIRES, WIRED (dead-wires lane, 2026-08-28 — source-locked: DOM/bus flow)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
// the `declines` scorer term finally has a writer: the session decline count, real declines only
A.ok(/c\.declines = recDeclinesOf\(c\.kind\)/.test(pass),
  'the pass attaches the session decline count to every candidate (the term had NO writer since the band redesign)');
A.ok(/if \(!deferred\) \{ const k = String\(channel \|\| ''\); if \(k\) sessionDeclines\.set\(k, \(sessionDeclines\.get\(k\) \|\| 0\) \+ 1\); \}/.test(decline),
  'recDecline counts a REAL decline toward it — and a deferral ("not now") is a timing signal that never does');
// the quality store forwards each attributed outcome to the durable ledger (spine rows finally get outcomes)
const rqsSrc = read('frontend/app/recqualitystore.js');
A.ok(/forward\(stamp\.channel, 'completed', runId\)/.test(A.fnBody(rqsSrc, 'function onRunEnd(p)')),
  'a clean finish of an attributed run reaches the durable ledger, not just localStorage');
A.ok(/forward\(stamp\.channel, v, String\(runId \|\| ''\)\)/.test(A.fnBody(rqsSrc, 'function noteVerdict(runId, verdict)')),
  '…and so does the Commander\'s own 👍/👌/👎 on it');
A.ok(/deps\.recLedger !== undefined\) \? deps\.recLedger : \(typeof RecLedger !== 'undefined'/.test(rqsSrc),
  'the forward is injectable for the node test and defaults to the global — no wiring step to forget');
// seed and routine answer the spine rows their cards minted (they were permanently-`shown` orphans)
A.ok(/rl\.accepted\('seed'\)/.test(read('frontend/app/seedstore.js')) && /rl\.declined\('seed', false\)/.test(read('frontend/app/seedstore.js')),
  'a seed card\'s save/wave-off answers its own ledger row');
A.ok(/rl\.accepted\('routine'\)/.test(read('frontend/app/routinenudgestore.js')) && /rl\.declined\('routine', false\)/.test(read('frontend/app/routinenudgestore.js')),
  '…and so does a routine nudge\'s');

Promise.all(PENDING).then(() => A.report('rec one memory (W1)'),
  e => { console.error(e); process.exit(1); });
