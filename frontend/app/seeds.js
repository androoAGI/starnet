/* AGENT OS — seeds.js : the PURE engine for the SELF-GROWING SEED SHELF.

   The mint detector (mint.js) already notices when the Commander keeps asking for the same SHAPE of task and
   induces a parameterized template ("draft release notes for {input}"). This engine turns one of those raw
   candidates into a SEED PROPOSAL the agent can VOICE: a readable title, the directive template (its {input}
   token kept — that token IS the intentional gap, the one thing the Commander fills to make a run theirs), and a
   gentle, in-voice line offering to save it as a one-tap seed on the shelf.

   This is the "agents author seeds from observed patterns" move: usage → a seed the agent drafts for you → (once
   saved via Recipes.saveCustom it lands in Recipes.list(), so the First Pitch / ongoing-suggestion engines can
   then propose it too — the loop closes itself). The actual save + the mint bookkeeping live in the browser
   wiring (seedstore.js); ALL of this is pure presentation logic.

   PURE + node-testable (a `Seeds` global in the browser, module.exports under node). No Date.now / Math.random. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Seeds = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLE_CHARS = 64;   // cap a minted title so a runaway directive can't bloat the recipe name

  const clip = s => { s = String(s == null ? '' : s).trim(); return s.length > TITLE_CHARS ? s.slice(0, TITLE_CHARS - 1).replace(/\s+\S*$/, '') + '…' : s; };
  const detoken = s => String(s == null ? '' : s).replace(/\{\w+\}/g, '…');   // show the gap as an ellipsis in human-facing text
  const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  // turn one Mint candidate ({ key, count, template, hasToken, lastText }) into a seed proposal, or null if it
  // can't make a sensible one. title = the recipe NAME (gap shown as …); task = the template VERBATIM (keeps the
  // {input} token so Recipes derives a required gap param); line = the agent's gentle, in-voice offer.
  function fromCandidate(c) {
    if (!c || !c.key) return null;
    const task = String((c.template != null ? c.template : c.lastText) || '').trim();
    if (!task) return null;
    const display = clip(detoken(task)).trim();
    if (!/[a-z0-9]/i.test(display)) return null;   // a title that's only punctuation/ellipsis is no title at all
    const hasGap = !!c.hasToken;
    const count = Number.isFinite(c.count) ? c.count : 0;
    const line = '✦ you keep asking me to “' + display.toLowerCase() + '” — want me to save it as a one-tap seed on your shelf? '
      + (hasGap ? 'you’d just fill in the one blank each time.' : 'one tap and i run it.');
    return { key: c.key, title: cap1(display), task: task, hasGap: hasGap, count: count, line: line };
  }

  // the confident two-choice beat: save it, or a soft out (mirrors the pitch/suggestion register; never a menu).
  function choices() {
    return [
      { label: 'save it', value: 'save' },
      { label: 'not now', value: 'no', skip: true }
    ];
  }

  return { fromCandidate, choices, TITLE_CHARS };
});
