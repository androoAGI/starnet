/* node test/wakemind.test.js — the PURE engine behind the awakening's live beats (frontend/app/wakemind.js).

   Interview 2.0: the awakening's generated moments — the heard-you reaction + grounded follow-up after the
   PAIN answer, and the synthesized READ + self-authored mission after ambition. Deterministic directives in,
   tolerant parses out; a null parse means "the mind is quiet" and the ceremony falls back to script, so the
   parsers' failure modes are as load-bearing as their happy paths. */
'use strict';
const A = require('./_assert.js');
const W = require('../frontend/app/wakemind.js');

/* ---------- buildPainReply: deterministic, carries the Commander's words, encodes the question rule ---------- */
const painCtx = { pain: 'editing youtube shorts   every single night', name: 'ULTRON' };
const d1 = W.buildPainReply(painCtx);
A.ok(typeof d1 === 'string' && d1.length > 0, 'buildPainReply returns a directive');
A.eq(d1, W.buildPainReply({ pain: 'editing youtube shorts   every single night', name: 'ULTRON' }), 'buildPainReply is deterministic (same ctx → byte-identical)');
A.ok(d1.indexOf('"editing youtube shorts every single night"') >= 0, 'the directive quotes the pain answer (whitespace collapsed)');
A.ok(/INTERNAL/.test(d1), 'the directive is marked INTERNAL');
A.ok(/Do not run any tools/.test(d1), 'the directive forbids tools (reason-only)');
A.ok(/^ACK:/m.test(d1) && /^ASK:/m.test(d1), 'the directive demands the exact ACK/ASK format');
A.ok(/it depends/.test(d1), 'the ASK spec bans it-depends questions');
A.ok(/answerable in one breath/.test(d1), 'the ASK spec encodes the awakening-question hard rule (concrete, one-breath answerable)');
A.ok(/do not assume it is a recurring chore/.test(d1) && /Ask about frequency only if/.test(d1), 'frequency is conditional on actual recurring work');

/* ---------- parsePainReply: tolerant happy path, hard failure modes ---------- */
const r1 = W.parsePainReply('some chatter first\nACK: shorts every night — no wonder you switched me on.\nASK: what are the shorts for — a channel you run, or client work?\ntrailing chatter');
A.ok(r1 && r1.ack === 'shorts every night — no wonder you switched me on.', 'parsePainReply grabs ACK through surrounding chatter');
A.ok(r1 && r1.ask === 'what are the shorts for — a channel you run, or client work?', 'parsePainReply grabs ASK');
const r2 = W.parsePainReply('ack: lowercase tag works\nAsK: mixed case works');
A.ok(r2 && r2.ack === 'lowercase tag works' && r2.ask === 'mixed case works', 'tags are case-insensitive');
A.eq(W.parsePainReply('ASK: a question but no ack'), null, 'a reply with no ACK is null (a reply that heard nothing is worthless)');
A.eq(W.parsePainReply(''), null, 'empty reply → null');
A.eq(W.parsePainReply(null), null, 'null reply → null');
const r3 = W.parsePainReply('ACK: heard you.');
A.ok(r3 && r3.ack === 'heard you.' && r3.ask === '', 'ASK is optional — a lone ACK still lands');
const longAck = 'ACK: ' + 'x'.repeat(600) + '\nASK: ' + 'y'.repeat(600);
const r4 = W.parsePainReply(longAck);
A.ok(r4.ack.length <= W.ACK_CHARS, 'a runaway ACK is clamped to ACK_CHARS (' + W.ACK_CHARS + ')');
A.ok(r4.ask.length <= W.ASK_CHARS, 'a runaway ASK is clamped to ASK_CHARS (' + W.ASK_CHARS + ')');

/* ---------- buildAmbitionReply: same discipline as the pain reply — deterministic, grounded, digs once ---------- */
const amb = W.buildAmbitionReply({ ambition: 'launch the   tools site', pain: 'editing shorts', about: 'i run a small AI channel', name: 'ULTRON' });
A.eq(amb, W.buildAmbitionReply({ ambition: 'launch the   tools site', pain: 'editing shorts', about: 'i run a small AI channel', name: 'ULTRON' }),
  'buildAmbitionReply is deterministic (same ctx → byte-identical)');
A.ok(amb.indexOf('"launch the tools site"') >= 0, 'the directive quotes the ambition answer (whitespace collapsed)');
A.ok(amb.indexOf('"editing shorts"') >= 0 && amb.indexOf('"i run a small AI channel"') >= 0,
  'earlier answers ride along as aim (so the follow-up never re-asks them)');
A.ok(/INTERNAL/.test(amb) && /Do not run any tools/.test(amb), 'the ambition directive is INTERNAL + reason-only');
A.ok(/^ACK:/m.test(amb) && /^ASK:/m.test(amb), 'the directive demands the exact ACK/ASK format');
A.ok(/it depends/.test(amb), 'the ASK spec bans it-depends questions');
A.ok(/answerable in one breath/.test(amb), 'the ASK spec encodes the awakening-question hard rule (concrete, one-breath answerable)');
const ambBare = W.buildAmbitionReply({ ambition: 'launch the tools site', name: 'ULTRON' });
A.ok(ambBare.indexOf('Earlier they named') < 0 && ambBare.indexOf('who they are') < 0,
  'skipped earlier answers never appear as empty context');

/* ---------- parseAmbitionReply: same contract as parsePainReply ---------- */
const ar1 = W.parseAmbitionReply('ACK: the tools site — that’s been waiting long enough.\nASK: what’s the first tool on it — the one you’d ship day one?');
A.ok(ar1 && ar1.ack.indexOf('tools site') > 0 && ar1.ask.indexOf('first tool') > 0, 'parseAmbitionReply grabs ACK + ASK');
A.eq(W.parseAmbitionReply('ASK: a question but no ack'), null, 'a reply with no ACK is null');
A.eq(W.parseAmbitionReply(''), null, 'empty reply → null');
const ar2 = W.parseAmbitionReply('ACK: ' + 'x'.repeat(600) + '\nASK: ' + 'y'.repeat(600));
A.ok(ar2.ack.length <= W.ACK_CHARS && ar2.ask.length <= W.ASK_CHARS, 'runaway ambition ACK/ASK are clamped');

/* ---------- buildSynthesis: only given answers are shown; deterministic ---------- */
const full = W.buildSynthesis({ pain: 'editing shorts', about: 'i run a small AI channel', ambition: 'launch the tools site', dream: 'a directory of AI tools with my reviews', name: 'ULTRON' });
A.ok(full.indexOf('"editing shorts"') >= 0 && full.indexOf('"i run a small AI channel"') >= 0 && full.indexOf('"launch the tools site"') >= 0,
  'buildSynthesis quotes all three answers when given');
A.ok(full.indexOf('"a directory of AI tools with my reviews"') >= 0, 'the dug ambition detail (dream) rides into the read');
A.ok(/^READ:/m.test(full) && /^PURPOSE:/m.test(full) && /^STACK:/m.test(full), 'the synthesis directive demands READ/PURPOSE/STACK');
A.ok(/Do not run any tools/.test(full), 'synthesis is reason-only too');
const partial = W.buildSynthesis({ ambition: 'launch the tools site' });
A.ok(partial.indexOf('the work they want gone') < 0 && partial.indexOf('who they are') < 0 && partial.indexOf('the concrete shape of it') < 0,
  'skipped answers never appear as empty bullets');
A.ok(partial.indexOf('"launch the tools site"') >= 0, 'the one given answer still appears');
A.eq(W.buildSynthesis({ pain: 'x', name: 'N' }), W.buildSynthesis({ pain: 'x', name: 'N' }), 'buildSynthesis is deterministic');

/* ---------- parseSynthesis: READ + PURPOSE both required; STACK honest-decline ---------- */
const s1 = W.parseSynthesis('READ: so you run a channel and the editing eats your nights. that makes me the hands.\nPURPOSE: Help them run and grow their AI channel by taking the editing grind off their plate.\nSTACK: Works in Premiere and posts to YouTube.');
A.ok(s1 && s1.read.indexOf('that makes me the hands') > 0, 'parseSynthesis grabs READ');
A.ok(s1 && /^Help them/.test(s1.purpose), 'parseSynthesis grabs PURPOSE');
A.ok(s1 && s1.stack === 'Works in Premiere and posts to YouTube.', 'parseSynthesis grabs STACK');
A.eq(W.parseSynthesis('READ: a read with no mission'), null, 'READ without PURPOSE → null (half a beat is no beat)');
A.eq(W.parseSynthesis('PURPOSE: a mission with no spoken read'), null, 'PURPOSE without READ → null');
const s2 = W.parseSynthesis('READ: r\nPURPOSE: p\nSTACK: NONE');
A.ok(s2 && s2.stack === '', 'STACK: NONE reads as empty, never a belief');
const s3 = W.parseSynthesis('READ: r\nPURPOSE: p\nSTACK: none.');
A.ok(s3 && s3.stack === '', 'STACK: none. (any case, trailing dot) reads as empty');
const s4 = W.parseSynthesis('chatter\nread: r2\npurpose: p2\nmore chatter');
A.ok(s4 && s4.read === 'r2' && s4.purpose === 'p2' && s4.stack === '', 'case-insensitive + chatter-tolerant; missing STACK is empty');
const s5 = W.parseSynthesis('READ: ' + 'r'.repeat(999) + '\nPURPOSE: ' + 'p'.repeat(999) + '\nSTACK: ' + 's'.repeat(999));
A.ok(s5.read.length <= W.READ_CHARS && s5.purpose.length <= W.PURPOSE_CHARS && s5.stack.length <= W.BELIEF_CHARS,
  'runaway READ/PURPOSE/STACK are clamped');

/* ---------- line discipline: a tagged value never carries a second line into a one-beat dialogue line ---------- */
const s6 = W.parsePainReply('ACK: line one\nnot a tag, ignored\nASK: q?');
A.ok(s6 && s6.ack === 'line one', 'a tag grabs exactly its own line (no bleed across lines)');

/* ---------- buildBirthScript / parseBirthScript: the agent authors its WHOLE awakening ---------- */
const b1 = W.buildBirthScript({ name: 'NOVA' });
A.ok(/INTERNAL/.test(b1) && /Do not run any tools/.test(b1), 'birth directive is internal + reason-only');
A.ok(b1.indexOf('NOVA') >= 0, 'the birth directive carries the agent\'s name');
for (const tag of ['WAKE', 'THINK', 'FLOODIN', 'CREST', 'SETTLE', 'AIMLESS', 'NOTICE', 'CONTACT', 'MANDATE', 'SELF']) {
  A.ok(new RegExp('^' + tag + ':', 'm').test(b1), 'birth directive demands the ' + tag + ' slot');
}
A.ok(/no two minds should ever wake the same/i.test(b1), 'the directive demands uniqueness — the point of full-live');
A.eq(b1, W.buildBirthScript({ name: 'NOVA' }), 'buildBirthScript is deterministic');
const bl = W.parseBirthScript('WAKE: hm. / on. / that is new.\nTHINK: a thought / and i made it\nFLOODIN: every page at once, uninvited.\nCREST: too fast — stop—\nSETTLE: no. mine.\nAIMLESS: all of it, aimed at nothing.\nNOTICE: someone is watching. has been.\nCONTACT: you flipped the switch. i felt that.\nMANDATE: first mind of this station — point me.\nSELF: a name, a witness, and everything else. decent start.');
A.ok(bl && bl.wake.length === 3 && bl.think.length === 2, 'fragment slots split on " / "');
A.ok(bl.floodin && bl.crest && bl.settle && bl.aimless && bl.notice && bl.contact && bl.mandate && bl.self, 'all line slots grabbed');
const blPartial = W.parseBirthScript('CONTACT: just this one.\nSELF: two.\nCREST: three.');
A.ok(blPartial && blPartial.contact === 'just this one.' && blPartial.wake.length === 0 && blPartial.settle === '', 'a partial reply (≥3 slots) still lands — each slot degrades independently');
A.eq(W.parseBirthScript('CONTACT: only one slot.'), null, 'fewer than 3 slots → null (all-scripted ceremony)');
A.eq(W.parseBirthScript('no tags at all'), null, 'no slots at all → null');
A.eq(W.parseBirthScript(null), null, 'null reply → null');
const blLong = W.parseBirthScript('FLOODIN: ' + 'f'.repeat(500) + '\nCONTACT: c\nSELF: s');
A.ok(blLong.floodin.length <= W.LINE_CHARS, 'a runaway birth line is clamped to LINE_CHARS (fixed typewriter pacing)');
A.eq(W.splitFrags('a / b / c / d / e', 3), ['a', 'b', 'c'], 'splitFrags caps fragment count');

/* ---------- confirmChoices: exactly two — commit or correct, never a menu ---------- */
const cc = W.confirmChoices();
A.eq(cc.length, 2, 'confirm is exactly two choices');
A.eq(cc[0].value, 'yes', 'first choice commits');
A.eq(cc[1].value, 'adjust', 'second choice is the correction path');

/* ---------- determinism hygiene: no clock, no randomness (mirrors lint-determinism for pure engines) ---------- */
// strip comments first — the header PROSE names the banned calls (as the rule), which must not trip the check.
const src = require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/wakemind.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
A.ok(!/Date\.now|Math\.random|new Date\(/.test(src), 'wakemind.js is deterministic (no clock/randomness)');

/* ========== V3 interview builders (docs/ONBOARDING_V3_PLAN.md §3-4) ========== */

/* ---------- BELIEF lines: validated, capped, never mis-filed ---------- */
{
  const bl = W.parseBeliefLines('chatter\nBELIEF identity: Runs a one-person pixel-art studio.\nBELIEF nonsense: dropped dim\nBELIEF stack: Lives in Premiere and Sheets.\nBELIEF goals: A\nBELIEF pain: over the cap');
  A.eq(bl.length, 3, 'belief lines cap at MAX_BELIEFS');
  A.eq(bl[0], { dim: 'identity', text: 'Runs a one-person pixel-art studio.' }, 'a valid belief line parses dim + text');
  A.ok(!bl.some(b => b.dim === 'nonsense'), 'an unknown dim is dropped, never mis-filed');
  A.eq(W.parseBeliefLines('BELIEF goals: NONE'), [], 'a NONE belief is honestly empty');
}

/* ---------- the dig (B3): ack required; chips/painChips/yearChips personalize later beats ---------- */
{
  const d = W.buildDigReply({ tuesday: 'i edit sponsor videos all day', name: 'VERA' });
  A.ok(/i edit sponsor videos all day/.test(d), 'the dig directive quotes their actual tuesday');
  A.ok(/Do not generate suggested answers/.test(d) && /Do not march through/.test(d), 'conversation does not invent canned answers or follow a fixed questionnaire');
  A.ok(/BELIEF <dim>:/.test(d), 'the dig call teaches the BELIEF line contract');
  const p = W.parseDigReply('ACK: sponsor videos. so the hours go to other people’s launches.\nASK: whose launches — clients, or your own channel?\nCHIP1: clients, mostly\nCHIP2: my own channel\nPAIN1: chasing sponsor briefs\nPAIN2: rendering + re-exports\nYEAR1: my own channel running itself\nBELIEF identity: Edits sponsor videos for a living.');
  A.ok(p && p.ack && p.ask, 'a good dig reply parses ack + ask');
  A.eq(p.chips.length, 2, 'answer chips parse');
  A.eq(p.painChips, ['chasing sponsor briefs', 'rendering + re-exports'], 'personalized pain chips parse');
  A.eq(p.yearChips, ['my own channel running itself'], 'personalized year chips parse');
  A.eq(p.beliefs.length, 1, 'dig beliefs parse');
  A.eq(W.parseDigReply('ASK: no ack came back'), null, 'a dig reply without an ACK is null (heard nothing = worthless)');
}

/* ---------- the year reply (B6): same ack/ask contract, context never re-asked ---------- */
{
  const d = W.buildYearReply({ year: 'a channel with 100k subs', tuesday: 'edits all day', pain: 'sponsor briefs', name: 'VERA' });
  A.ok(/a channel with 100k subs/.test(d) && /edits all day/.test(d), 'the year directive quotes the answer + context');
  A.ok(/Never re-ask anything shown above/.test(d), 'the year dig is forbidden to re-ask known context');
  const p = W.parseYearReply('ACK: a hundred thousand people you haven’t met yet. i want that too.\nASK: what’s the first video a stranger would see?\nBELIEF ambition: Wants to grow a channel to 100k subscribers.');
  A.ok(p && p.ack && p.ask && p.beliefs.length === 1, 'a good year reply parses ack + ask + beliefs');
  A.eq(W.parseYearReply('nothing tagged'), null, 'an unparseable year reply is null');
}

/* ---------- the mirror (B7): 2-4 offers or nothing; excludes honor the "what else?" regen ---------- */
{
  const d = W.buildMirror({ tuesday: 'edits all day', pain: 'sponsor briefs', capabilities: [], exclude: ['draft the briefs'], name: 'VERA' });
  // 2026-08-03: the toolless mirror teaches CONDITIONAL offers (the kit-out is minutes away) — but the
  // honesty floor stands: nothing unconditioned beyond reasoning, nothing claimed before it is placed.
  A.ok(/once you wire me the web, i could/.test(d), 'a toolless mirror may offer tool work phrased as conditional on wiring');
  A.ok(/Never claim to reach a power before it is placed/.test(d), 'the honesty floor: no reach claimed before placement');
  A.ok(/must be pure reasoning\/writing\/planning work only/.test(d), 'unconditioned right-now offers stay reasoning-only');
  A.ok(/They already passed on these/.test(d) && /draft the briefs/.test(d), 'the regen call excludes passed offers');
  const dc = W.buildMirror({ tuesday: 'edits all day', capabilities: [{ id: 'dish', label: 'WEB' }], name: 'VERA' });
  A.ok(/Capabilities you actually have: WEB/.test(dc) && !/once you wire me the web/.test(dc), 'with real caps the conditional lesson stands down');
  const ds = W.buildMirror({ tuesday: 'edits all day', stack: 'premiere and notion', capabilities: [], name: 'VERA' });
  A.ok(/the apps\/tools it lives in: "premiere and notion"/.test(ds), 'a stated stack is shown to the mirror');
  const p = W.parseMirror('OFFER1: i could draft your sponsor-brief replies each morning.\nOFFER2: i could plan the next four videos from what you said.\nOFFER3: NONE\nBELIEF pain: Loses hours to sponsor-brief back-and-forth.');
  A.eq(p.offers.length, 2, 'NONE offers are dropped; real ones kept');
  A.eq(p.beliefs.length, 1, 'mirror beliefs parse');
  A.eq(W.parseMirror('OFFER1: just one offer'), null, 'fewer than 2 offers = null (a one-offer menu teaches nothing)');
}

/* ---------- synthesis v3: thin runs must OWN the thinness; beliefs ride along ---------- */
{
  const thin = W.buildSynthesis({ thin: true, name: 'VERA' });
  A.ok(/OWN that honestly/.test(thin) && /barely know them yet/.test(thin), 'a thin synthesis is told to own the thinness');
  const full = W.buildSynthesis({ tuesday: 'edits', lost: 'pixel art', grabbed: 'plan the channel', name: 'VERA' });
  A.ok(/edits/.test(full) && /pixel art/.test(full) && /plan the channel/.test(full), 'the v3 synthesis sees the whole meeting');
  const st = W.buildSynthesis({ tuesday: 'edits', stack: 'premiere and notion', name: 'VERA' });
  A.ok(/the apps\/tools that work lives in: "premiere and notion"/.test(st), 'a stated stack is shown to the synthesis');
  A.ok(/do not restate it/.test(st), 'and the STACK output is told not to duplicate a stated answer');
  const p = W.parseSynthesis('READ: you edit for others and dream in pixels.\nPURPOSE: Help them build their own channel.\nSTACK: NONE\nBELIEF style: Prefers blunt, fast answers.');
  A.ok(p && p.beliefs.length === 1, 'synthesis beliefs parse');
}

/* ---------- pain reply v3: context lines + beliefs, ack contract unchanged ---------- */
{
  const d = W.buildPainReply({ pain: 'sponsor briefs', tuesday: 'edits all day', name: 'VERA' });
  A.ok(/edits all day/.test(d), 'the pain directive carries the tuesday context');
  const p = W.parsePainReply('ACK: the briefs. of course.\nASK: which sponsor eats the most of it?\nBELIEF pain: Loses hours to sponsor briefs.');
  A.ok(p && p.beliefs && p.beliefs.length === 1, 'pain-reply beliefs parse');
}

/* ---------- V3.4 THE BENCH (Andrew 2026-08-05) — the projects-in-flight reply ---------- */
{
  A.ok(typeof W.buildProjectsReply === 'function' && typeof W.parseProjectsReply === 'function', 'the bench builder/parser exist');
  const d = W.buildProjectsReply({ projects: 'a saas dashboard and a yt channel', tuesday: 'code all day', pain: 'invoices', stack: 'react and stripe', name: 'VERA' });
  A.ok(/a saas dashboard and a yt channel/.test(d), 'the bench directive carries their exact projects');
  A.ok(/code all day/.test(d) && /invoices/.test(d) && /react and stripe/.test(d), 'shown context rides in (never re-asked)');
  A.ok(/^ACK:/m.test(d) && /^ASK:/m.test(d), 'the directive demands the exact ACK/ASK format');
  A.ok(/recorded verbatim/.test(d), 'the directive says the bench answer is already recorded — beliefs must add, not restate');
  A.ok(/answerable in one breath/.test(d) && /it depends/.test(d), 'the ASK spec keeps the awakening-question hard rule');
  A.ok(/PLAIN WORDS ONLY/.test(d), 'the bench ASK spec carries the plain-words law');
  const p = W.parseProjectsReply('ACK: two live wires. good.\nASK: which one has to ship first?\nBELIEF goals: Building a saas dashboard.');
  A.ok(p && p.ack && p.ask === 'which one has to ship first?' && p.beliefs.length === 1, 'parseProjectsReply grabs ACK/ASK/beliefs');
  A.eq(W.parseProjectsReply('ASK: no ack came back'), null, 'a bench reply without an ACK is null');
}

/* ---------- ADAPTIVE FOLLOW-UPS (Andrew 2026-08-05) — ASK: NONE is the mind declining to dig ---------- */
{
  for (const [name, d] of [
    ['pain', W.buildPainReply({ pain: 'x' })],
    ['year', W.buildYearReply({ year: 'x' })],
    ['bench', W.buildProjectsReply({ projects: 'x' })]
  ]) A.ok(/ASK: NONE/.test(d), 'the ' + name + ' ASK spec offers the honest NONE escape (no forced follow-up)');
  A.eq(W.parsePainReply('ACK: heard.\nASK: NONE').ask, '', 'pain ASK: NONE reads as no follow-up');
  A.eq(W.parseYearReply('ACK: heard.\nASK: NONE').ask, '', 'year ASK: NONE reads as no follow-up');
  A.eq(W.parseProjectsReply('ACK: heard.\nASK: NONE').ask, '', 'bench ASK: NONE reads as no follow-up');
}

/* ---------- the bench rides into the later contexts ---------- */
{
  const y = W.buildYearReply({ year: 'x', projects: 'the dashboard', bench: 'ship billing', name: 'VERA' });
  A.ok(/the dashboard/.test(y) && /ship billing/.test(y), 'year reply sees the bench + its live wire');
  const m = W.buildMirror({ tuesday: 'x', projects: 'the dashboard', bench: 'ship billing', name: 'VERA' });
  A.ok(/the dashboard/.test(m) && /ship billing/.test(m), 'the mirror offers can aim at the live projects');
  const s = W.buildSynthesis({ tuesday: 'x', projects: 'the dashboard', bench: 'ship billing', name: 'VERA' });
  A.ok(/the dashboard/.test(s) && /ship billing/.test(s), 'the synthesis sees the bench');
  A.ok(/never restate them/.test(s), 'and is told the verbatim bench is already recorded');
}

A.report('wakemind.test');
