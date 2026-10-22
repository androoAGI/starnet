/* AGENT OS — seedcredit.js : the PURE seed-callout helper (Game session, Phase G3a / Layer 6).

   Closes the mint→pitch narrative loop out loud: when the station reuses a recipe the Commander SAVED as a
   seed (an agent-authored, seedborn custom — seedstore.save marks it), the moment says so. Three call sites,
   all direct-call wiring (no new events, no new beats — a credit LINE, never a separate ask):
     • a First Pitch / ongoing suggestion that proposes a seedborn recipe appends creditForRecipe()'s line;
     • a while-away digest row whose unattended run was a saved seed's routine gets annotate()'d with the
       seed's name, and the digest label credits it.

   HONEST detection only — a credit renders when provenance genuinely links:
     1. the recipe object itself carries the durable seedborn flag (recipes.js normCustom preserves it), or
     2. a digest row's matched routine NAME equals a seedborn recipe's name (the routine was made from it), or
     3. a digest row's recorded run title matches a seedborn recipe's task TEMPLATE ({tokens} as wildcards —
        the run's title IS the filled template, so a match is real reuse, never a guess). A row that matches
        nothing gets no credit — silence over fabrication.

   PURE + node-testable (a `SeedCredit` global in the browser, module.exports under node). No DOM/clock/rng. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SeedCredit = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLE_CAP = 90;   // returns.js caps recorded titles at 90 — at/near the cap, allow a prefix match

  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const normKey = s => norm(s).toLowerCase();

  // the shared credit line — lowercase, in the agent's voice, one sentence, never a separate beat.
  function line(name) {
    const n = norm(name);
    return n ? ('built from the seed you saved — “' + n + '”.') : '';
  }

  // pitch/suggestion path: the chosen recipe object itself carries provenance. '' when not seed-born.
  function creditForRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object' || !recipe.seedborn) return '';
    return line(recipe.name);
  }

  // compile a seed task TEMPLATE into a whitespace-tolerant matcher: literal segments are regex-escaped,
  // {tokens} become non-greedy wildcards. Returns null for an empty template.
  function templateRe(task, anchorEnd) {
    const t = norm(task);
    if (!t) return null;
    const parts = t.split(/\{\w+\}/);
    const esc = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    try { return new RegExp('^' + esc.join('[\\s\\S]+?') + (anchorEnd ? '$' : ''), 'i'); } catch (_) { return null; }
  }

  // does this digest row's recorded title come from this seed's template? Exact match first; a title sitting
  // at the recorder's cap may be TRUNCATED, so a near-cap title also accepts a prefix match (never vice versa).
  function titleMatches(title, task) {
    const t = norm(title);
    if (!t) return false;
    const full = templateRe(task, true);
    if (full && full.test(t)) return true;
    if (t.length >= TITLE_CAP - 2) {
      const prefix = templateRe(task, false);
      // the truncated title is a PREFIX of the filled template — flip the test: does the template's own
      // opening literal segment start the title? Cheap + honest: compare the first literal chunk.
      const head = norm(task).split(/\{\w+\}/)[0];
      if (head && head.length >= 12 && normKey(t).indexOf(normKey(head)) === 0) return true;
      if (prefix && prefix.test(t)) return true;
    }
    return false;
  }

  // find the seedborn recipe (from a customs list) this digest row genuinely reuses, or null.
  // row = { title, routine } (a returns.js digest row); customs = Recipes.customs() copies.
  function matchSeed(row, customs) {
    if (!row || !Array.isArray(customs)) return null;
    const seeds = customs.filter(c => c && c.seedborn && norm(c.name));
    if (!seeds.length) return null;
    const rn = normKey(row.routine);
    if (rn) { const byName = seeds.find(s => normKey(s.name) === rn); if (byName) return byName; }
    for (const s of seeds) { if (titleMatches(row.title, s.task)) return s; }
    return null;
  }

  // annotate digest rows in place with .seed = the credited seed's name (rows that match nothing are left
  // untouched — the label renders no credit). Returns the rows for chaining, like Returns.matchRoutines.
  function annotate(rows, customs) {
    if (!Array.isArray(rows)) return rows || [];
    for (const r of rows) {
      const hit = matchSeed(r, customs);
      if (hit) r.seed = norm(hit.name);
    }
    return rows;
  }

  return { creditForRecipe, matchSeed, annotate, line, _titleMatches: titleMatches };
});
