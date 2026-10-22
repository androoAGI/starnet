/* AGENT OS — verdictfollowup.js : the PURE engine for the VERDICT FOLLOW-UP (momentum loop, 2026-08-21).

   The rate-the-work beat used to end `◆ close` and `▼ missed` with the word "noted" — a dead question: the
   Commander told the station its work fell short and nothing changed. A miss is the highest-information
   moment the station ever gets about HOW this Commander wants work done, and it was thrown away.

   POPUP LAW (docs/NEXT.md 2026-08-21): a popup earns its pixels only when the answer CHANGES something
   observable. This follow-up asks ONE thing — "what missed?" — and every chip maps to a Commander Dossier
   dimension, so the answer becomes a belief that rides into every later agent's briefing (Dossier.composeBlock).
   Nothing is asked on `▲ nailed it` (nothing to learn), nothing is asked twice for one run, and "skip" writes
   nothing. PURE + node-testable (a `VerdictFollowup` global in the browser, module.exports under node); the
   DOM, the beat slot and the dossier write live in chat.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.VerdictFollowup = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // which verdicts earn a follow-up. 'great' never does — a popup after praise is exactly the "fake and
  // unprompted" texture this lane exists to remove.
  const ASK_ON = ['ok', 'miss'];

  // the chips. Each names a CAUSE in the Commander's own frame and the dossier dimension that cause informs.
  // `text` is the belief written on tap — phrased as an OBSERVED fact about how this Commander wants work
  // done (never the station's guess: the Commander chose the chip), and must read well inside a briefing.
  const CHIPS = [
    { value: 'shorter',  label: 'too long — tighter next time',    dim: 'style',    text: 'Prefers tighter, shorter deliverables — a run was rated short of the mark for running long.' },
    { value: 'deeper',   label: 'too thin — go deeper',            dim: 'style',    text: 'Wants more depth and thoroughness — a run was rated short of the mark for being too thin.' },
    { value: 'audience', label: 'wrong audience / tone',           dim: 'people',   text: 'Work landed for the wrong audience or tone — confirm who a deliverable is for before drafting.' },
    { value: 'approach', label: 'wrong approach / tools',          dim: 'stack',    text: 'Disliked the approach or tools used on a run — prefer the stack and methods named in this briefing; ask before substituting.' },
    { value: 'offgoal',  label: 'not what I asked for',            dim: 'goals',    text: 'A run drifted from the actual ask — restate the goal back before starting and stay on it.' },
    { value: 'timing',   label: 'right work, wrong timing',        dim: 'schedule', text: 'Timing mattered more than content on a run — land work when this briefing says work should land.' }
  ];
  const SKIP = { value: 'skip', label: 'skip', skip: true };

  function shouldAsk(verdict) { return ASK_ON.indexOf(String(verdict || '')) !== -1; }

  // the chip row for one verdict (a fresh array each call — callers mutate chip rows freely).
  function chips(verdict) {
    if (!shouldAsk(verdict)) return [];
    return CHIPS.map(c => ({ label: c.label, value: c.value })).concat([Object.assign({}, SKIP)]);
  }

  // turn a tapped chip into the dossier belief it writes. Returns null for skip / unknown (write nothing).
  //   value   — the chip value
  //   ctx     — { directive?: string, now?: number } — the run's directive is cited (trimmed) so the belief
  //             stays traceable to the run that taught it (truthful telemetry: every belief names its evidence).
  const CITE_CHARS = 80;
  function belief(value, ctx) {
    ctx = ctx || {};
    const c = CHIPS.find(x => x.value === value);
    if (!c) return null;
    const now = Number.isFinite(ctx.now) ? ctx.now : 0;
    let text = c.text;
    const d = String(ctx.directive || '').replace(/\s+/g, ' ').trim();
    if (d) text += ' (from: “' + (d.length > CITE_CHARS ? d.slice(0, CITE_CHARS - 1) + '…' : d) + '”)';
    return { dim: c.dim, text: text, source: 'verdict', weight: 'observed', observedAt: now > 0 ? now : null };
  }

  return { shouldAsk, chips, belief, CHIPS, ASK_ON, CITE_CHARS };
});
