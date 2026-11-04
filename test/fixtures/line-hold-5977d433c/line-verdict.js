/* line-verdict.js ? the work-line VERDICT channel, shared by page and sidecar.
   This is the existing routing/verdict parser: last recognized verdict in the last three
   nonempty lines, tolerant of case/markdown/quote prefixes. BLOCKED is a verdict, never
   a gate key. Holds, pass limits and human decisions belong to the runner, not this parser.
   Pure: no clock, IO, authority or mutable job state. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.LineVerdict = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const VERDICT_WORDS = ['approved', 'revise'];
/* BLOCKED — the THIRD canonical verdict (typed-outcomes, 2026-10-29; shared with the line-hold lane). A reviewer that answers
   VERDICT: BLOCKED is saying the work must NOT move on. It is never a gate KEY (VERDICT_WORDS stays approved | revise: a gate
   waits on one of those), so parseVerdict returning null for it made every verdict-keyed gate read it as "not approved" —
   'revise' — and, passes later, ship the work DONE unapproved (GitHub #122). A verdict-keyed gate now HOLDS it
   (chain.js loopDecision): the line stops at that gate with zero further spend and says why. */
const BLOCKED = 'blocked';
// synonyms the model may reach for; each maps to the ONE canonical word the gate compares against
const SYN = { approved: 'approved', approve: 'approved', accepted: 'approved', pass: 'approved', lgtm: 'approved',
              revise: 'revise', revision: 'revise', rejected: 'revise', reject: 'revise', 'needs-work': 'revise', 'needs_work': 'revise',
              blocked: BLOCKED, block: BLOCKED, blocker: BLOCKED, 'do-not-ship': BLOCKED, 'do_not_ship': BLOCKED };
const TAIL_LINES = 3;   // how many trailing non-empty lines may carry the verdict
/* bareLine: a line with its markdown off, anywhere in it. A model writes **VERDICT:** BLOCKED and VERDICT: `blocked` as readily as the
   plain form, and reading those as nothing sent a blocked job round again and out unapproved (GitHub #122). One underscore stays:
   needs_work is a word. VERDICT_LINE reads one word, or the one phrase of more: do not ship. */
function bareLine(line) { return line.trim().replace(/\*+|`+|__+/g, '').replace(/^[\s>\-_#]+/, '').replace(/[\s_.!]+$/, ''); }
const VERDICT_LINE = /^verdict\s*[:=\-–—]\s*([A-Za-z][A-Za-z_-]*(?:\s+not\s+ship)?)/i;

function isVerdictWord(w) { return typeof w === 'string' && VERDICT_WORDS.indexOf(w.toLowerCase()) >= 0; }

/* parseVerdict(text) -> 'approved' | 'revise' | 'blocked' | null. The LAST verdict line within the tail wins. */
function parseVerdict(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = VERDICT_LINE.exec(bareLine(tail[i]));
    if (!m) continue;
    const w = SYN[m[1].toLowerCase().replace(/\s+/g, '-')];
    if (w) return w;
  }
  return null;
}

/* heldWhy(gate) -> the sentence for a job held at a gate, the one wording every surface says it in. */
function heldWhy(gate) { return 'the reviewer at the gate ' + gate + ' answered VERDICT: blocked, so the work is held there — not sent on, not shipped'; }

/* stripVerdict(text) -> the text without its VERDICT line (the one parseVerdict reads, within the tail), for the work that
   LEAVES an approved gate: the line is the gate's control signal, not part of the work (2026-09-27 audit R1). A text with no
   verdict line comes back unchanged. Pure. */
function stripVerdict(text) {
  if (typeof text !== 'string' || !parseVerdict(text)) return text;
  const lines = text.split(/\r?\n/);
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < TAIL_LINES; i--) {
    if (!lines[i].trim()) continue;
    seen++;
    if (VERDICT_LINE.test(bareLine(lines[i]))) { lines.splice(i, 1); break; }
  }
  return lines.join('\n').replace(/\s+$/, '');
}

/* verdictBrief(when, handsOn) -> the instruction a reviewer dock receives when its lane meets a LOOP gate keyed on a
   verdict word; '' when the gate is not verdict-keyed. Prompt text only; pipeline.js handoffPrompt keeps its first 600
   characters. `handsOn` === true only when the caller KNOWS a bare approval at that gate hands on the work the reviewer was
   handed (chain.js hopTurn → bareApprovalHandsOn, the rule in chain.js bareApproval, 2026-10-21): only then does the brief offer
   it. A self-loop gate or a crate another gate framed hands on the reply as it is, and gets the plain promise that the reply
   is what moves on. All line entries use this same server-side turn composer. */
function verdictBrief(when, handsOn) {
  if (!isVerdictWord(when)) return '';
  const other = when.toLowerCase() === 'approved' ? 'revise' : 'approved';
  return 'YOUR VERDICT DECIDES THE LOOP GATE AFTER YOU: end your reply with one final line, exactly '
    + '"VERDICT: ' + when.toLowerCase() + '" when the work should leave the loop, "VERDICT: ' + other + '" when it should go '
    + 'back round, or "VERDICT: blocked" when it must stop for a person. Nothing after that line. A reply with no VERDICT line is treated as "' + other + '". '
    + (handsOn === true
      ? 'When the work passes, a reply of only the VERDICT line, or a bare approval such as "Looks good.", passes it on exactly as '
        + 'you were handed it. Any other reply is what moves on past the gate: lead with the finished work itself (with any fixes '
        + 'applied); keep notes short.'
      : 'When the work passes, your reply is what moves on past the gate: lead with the finished work itself (with any fixes '
        + 'applied), and keep review notes short.');
}

return { parseVerdict, stripVerdict, isVerdictWord, verdictBrief, heldWhy, VERDICT_WORDS, BLOCKED };

});
