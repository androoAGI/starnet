/* sidecar/routing/verdict.js — the VERDICT channel for LOOP gates (2026-08-22).

   A reviewer dock that sits before a LOOP gate ends its output with ONE line:
       VERDICT: approved        (the crate leaves on the DONE lane)
       VERDICT: revise          (the crate goes back round)
   parseVerdict() is the ONLY reader of that line. It is deliberately tolerant of what models actually emit —
   case, markdown emphasis (**VERDICT: Approved**), a trailing period, a bullet/quote prefix, a blank line or
   two after it — and deliberately strict about WHERE: the line must be among the LAST few non-empty lines,
   so a reviewer quoting "VERDICT: approved" in its reasoning does not pass its own draft by accident.
   PURE: strings in, a word or null out. No module state, no clock. */
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
              blocked: BLOCKED, block: BLOCKED, blocker: BLOCKED, blocking: BLOCKED, 'do-not-ship': BLOCKED, 'do_not_ship': BLOCKED };
const TAIL_LINES = 3;   // how many trailing non-empty lines may carry the verdict

function isVerdictWord(w) { return typeof w === 'string' && VERDICT_WORDS.indexOf(w.toLowerCase()) >= 0; }

/* parseVerdict(text) -> 'approved' | 'revise' | 'blocked' | null. The LAST verdict line within the tail wins. */
function parseVerdict(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    // strip markdown / list / quote dressing on both ends
    const l = tail[i].replace(/^[\s>*\-_`#]+/, '').replace(/[\s*_`.!]+$/, '');
    const m = /^verdict\s*[:=\-–—]\s*([A-Za-z][A-Za-z_-]*)/i.exec(l);
    if (!m) continue;
    const w = SYN[m[1].toLowerCase().replace(/\s+/g, '-')];
    if (w) return w;
  }
  return null;
}

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
    const l = lines[i].trim().replace(/^[\s>*\-_`#]+/, '').replace(/[\s*_`.!]+$/, '');
    if (/^verdict\s*[:=\-–—]\s*[A-Za-z]/i.test(l)) { lines.splice(i, 1); break; }
  }
  return lines.join('\n').replace(/\s+$/, '');
}

/* verdictBrief(when, handsOn) -> the instruction a reviewer dock receives when its lane meets a LOOP gate keyed on a
   verdict word; '' when the gate is not verdict-keyed. Prompt text only; pipeline.js handoffPrompt keeps its first 600
   characters. `handsOn` === true only when the caller KNOWS a bare approval at that gate hands on the work the reviewer was
   handed (chain.js hopTurn → bareApprovalHandsOn, the rule in chain.js bareApproval, 2026-10-21): only then does the brief offer
   it. Everyone else — a self-loop gate, a crate another gate framed, the browser's COMMS work line (/api/routing/chain), which
   hands on the reply as it is — gets the plain promise that the reply is what moves on. */
function verdictBrief(when, handsOn) {
  if (!isVerdictWord(when)) return '';
  const other = when.toLowerCase() === 'approved' ? 'revise' : 'approved';
  return 'YOUR VERDICT DECIDES THE LOOP GATE AFTER YOU: end your reply with one final line, exactly '
    + '"VERDICT: ' + when.toLowerCase() + '" when the work should leave the loop, or "VERDICT: ' + other + '" when it should go '
    + 'back round. Nothing after that line. A reply with no VERDICT line is treated as "' + other + '". '
    + (handsOn === true
      ? 'When the work passes, a reply of only the VERDICT line, or a bare approval such as "Looks good.", passes it on exactly as '
        + 'you were handed it. Any other reply is what moves on past the gate: lead with the finished work itself (with any fixes '
        + 'applied), and keep review notes short.'
      : 'When the work passes, your reply is what moves on past the gate: lead with the finished work itself (with any fixes '
        + 'applied), and keep review notes short.');
}

module.exports = { parseVerdict, stripVerdict, isVerdictWord, verdictBrief, VERDICT_WORDS, BLOCKED };
