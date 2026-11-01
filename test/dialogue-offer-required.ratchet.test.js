/* node test/dialogue-offer-required.ratchet.test.js — EVERY PANEL OVER COMMS IS AN OFFER, EXCEPT THE ONES THAT ARE THE CONVERSATION
   (wave-1 B8 comms-owner-arbiter, gh#158).

   The Dialogue panel can cover the whole of COMMS, message box included. gh#158 was one module (the first-task hand-off) opening
   it with no offer, so nothing could hand COMMS back. The audit counted the panel's openers; two more mid-game ones (the First
   Pitch, the routine proposals) did the same. This ratchet scans every frontend/ script for `Dialogue.open(` and classifies each
   call by the owner kind the arbiter gives it (dialogue.js OWNER_RULES):
     offer    — passes `offer: { notNow, stepAside }`: ends above the message box, steps aside for the Commander. REQUIRED for
                every opener, with both ways out;
     tour     — tour:true / owner:'tour': the opt-in quick tour (yields a session pick). Allowed only in tutorial.js;
     ceremony — neither: the FIRST-RUN awakening, which IS the conversation. Allowed only in onboarding.js, and only for the
                awakening's own two beats (startQuestions, closeOut). The deferred interview (offerDeferred) runs mid-game on a
                returning station, so it is an offer (review 10-27: it was counted as the awakening and held all three).
   The two allowances are a RATCHET: a count may only go down. A new non-offer opener anywhere fails; a ceremony or tour beat that
   becomes an offer fails too, until its allowance is lowered here so it can never come back. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// THE RATCHET — lower only. Each entry: file → how many non-offer openers of that kind it may keep, and why.
const CEREMONY_ALLOWANCE = { 'frontend/app/onboarding.js': 2 };   // the first-run awakening: its interview (startQuestions) and its close-out beat (closeOut)
// tutorial.js: firstCommand's classic beat and QUICK TOUR 1 are tour:true; the two kit-out beats are owner:'tour'
const TOUR_ALLOWANCE = { 'frontend/app/tutorial.js': 4 };

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p, out); }
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
// is index i inside a // line comment or a /* block comment */ ? (strings that hold comment markers are rare in this tree; a
// mis-call here can only HIDE a site, and the total-count check below catches a site that vanished)
function inComment(src, i) {
  const lineStart = src.lastIndexOf('\n', i - 1) + 1;
  const before = src.slice(lineStart, i);
  if (/(^|[^:\\'"])\/\//.test(before)) return true;
  const open = src.lastIndexOf('/*', i), close = src.lastIndexOf('*/', i);
  return open >= 0 && open > close;
}
// the argument text of the call starting at the '(' at index p: paren-matched, skipping string literals
function argsAt(src, p) {
  let depth = 0;
  for (let i = p; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; for (i++; i < src.length; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === q) break; } continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(p + 1, i); }
  }
  return src.slice(p + 1);
}
function kindOf(args) {
  if (/\boffer\s*:/.test(args)) return 'offer';
  if (/\btour\s*:\s*true\b/.test(args) || /\bowner\s*:\s*'tour'/.test(args)) return 'tour';
  return 'ceremony';
}

const sites = [];
for (const file of walk(path.join(ROOT, 'frontend'), [])) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel === 'frontend/app/dialogue.js') continue;   // the panel itself
  const src = fs.readFileSync(file, 'utf8');
  const re = /\bDialogue\.open\(/g; let m;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) continue;
    const args = argsAt(src, m.index + m[0].length - 1);
    const line = src.slice(0, m.index).split('\n').length;
    sites.push({ file: rel, line, args: args.replace(/\s+/g, ' ').slice(0, 220), kind: kindOf(args) });
  }
}

A.ok(sites.length >= 9, 'the scan finds the panel’s openers (' + sites.length + '): ' + sites.map(s => s.file.replace('frontend/app/', '') + ':' + s.line + ' ' + s.kind).join(', '));

// 1. every offer carries both of its ways out
for (const s of sites.filter(x => x.kind === 'offer'))
  A.ok(/\bnotNow\s*:/.test(s.args) && /\bstepAside\s*:/.test(s.args), s.file + ':' + s.line + ' opens an offer with both ways out (notNow + stepAside): ' + s.args);

// 2. non-offer openers only where the ratchet allows them, never more
for (const [kind, allow] of [['ceremony', CEREMONY_ALLOWANCE], ['tour', TOUR_ALLOWANCE]]) {
  const byFile = {};
  for (const s of sites.filter(x => x.kind === kind)) (byFile[s.file] = byFile[s.file] || []).push(s.line);
  for (const [file, lines] of Object.entries(byFile)) {
    const n = allow[file] || 0;
    A.ok(lines.length <= n, kind + ' openers in ' + file + ': ' + lines.length + ' (allowed ' + n + ') at lines ' + lines.join(', ') +
      ' — a panel opened mid-game must pass offer: { notNow, stepAside } so it steps aside for the Commander (gh#158)');
  }
  for (const [file, n] of Object.entries(allow)) {
    const have = (byFile[file] || []).length;
    A.ok(have >= n, 'the ' + kind + ' allowance for ' + file + ' is ' + n + ' but only ' + have + ' remain: lower it to ' + have + ' so the ratchet tightens');
  }
}

// 3. the mid-game openers the audit named are offers now (pitchstore.js ×2, autojobstore.js, the goal path in chat.js)
for (const file of ['frontend/app/pitchstore.js', 'frontend/app/autojobstore.js', 'frontend/app/chat.js']) {
  const mine = sites.filter(s => s.file === file);
  A.ok(mine.length >= 1 && mine.every(s => s.kind === 'offer'), file + ': every opener is an offer (' + mine.map(s => s.line + ' ' + s.kind).join(', ') + ')');
}
A.eq(sites.filter(s => s.file === 'frontend/app/pitchstore.js').length, 2, 'pitchstore.js opens two panels (the First Pitch, the first-task hand-off), both offers');
// the awakening's two ceremony beats are exactly its first-run openers; the deferred interview (mid-game) is the offer
{
  const onb = fs.readFileSync(path.join(ROOT, 'frontend/app/onboarding.js'), 'utf8');
  const spanOf = header => { const at = onb.indexOf(header); const body = A.fnBody(onb, header); return at < 0 ? [0, -1] : [onb.slice(0, at).split('\n').length, onb.slice(0, at + body.length).split('\n').length]; };
  const within = (s, sp) => s.line >= sp[0] && s.line <= sp[1];
  const mine = sites.filter(s => s.file === 'frontend/app/onboarding.js');
  const deferred = spanOf('  function offerDeferred(opts) {'), questions = spanOf('  async function startQuestions() {'), close = spanOf('  async function closeOut() {');
  A.ok(deferred[1] > deferred[0] && questions[1] > questions[0] && close[1] > close[0], 'onboarding.js offerDeferred, startQuestions and closeOut sliced');
  A.eq(mine.filter(s => within(s, deferred)).map(s => s.kind), ['offer'], 'the deferred interview opens as an OFFER (it runs mid-game on a returning station)');
  A.eq(mine.filter(s => s.kind === 'ceremony').map(s => within(s, questions) ? 'startQuestions' : within(s, close) ? 'closeOut' : 'elsewhere:' + s.line), ['startQuestions', 'closeOut'], 'the only ceremony openers are the first-run awakening’s own two beats');
}

// 4. the classifier itself (so a refactor of the scan cannot quietly pass everything)
A.eq(kindOf(" { name, offer: { notNow: () => 1, stepAside: () => 2 } } "), 'offer', 'kindOf: an offer');
A.eq(kindOf(" { name: agentName, tour: true } "), 'tour', 'kindOf: a tour page');
A.eq(kindOf(" { name: agentName, owner: 'tour' } "), 'tour', 'kindOf: a kit-out beat');
A.eq(kindOf(' { name: NAME } '), 'ceremony', 'kindOf: the awakening');
A.ok(inComment('a /* Dialogue.open({ offer }) */ b', 5) && inComment('x // Dialogue.open(', 5) && !inComment("x; Dialogue.open(", 3), 'inComment: comment mentions are not openers');

A.report('dialogue-offer-required.ratchet');
