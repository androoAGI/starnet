/* AGENT OS — recipefit.js : WHAT THIS STATION IS ACTUALLY READY TO RUN.

   The recipes tab was a MENU: 98 cards, identical for everybody, and it was on the Commander to work out
   which of them applied to their situation. That is backwards — the station already knows its own
   situation. It knows the real project folders it has been granted, which channels are connected, which
   capabilities are placed on the floor, what it has learned the Commander keeps working on, what has been
   launched before, and what is already running as a routine.

   This module turns that into OFFERS: a catalog recipe, bound to the Commander's real context, carrying
   the evidence for why it is being offered. "The Graveyard" becomes "sweep the 3 project folders you have
   granted — nothing is watching them." The catalog stops being a menu and becomes a to-do list for THIS
   station, and it re-derives itself whenever the context changes.

   ══ THE HONESTY LAW — the only rule that really matters here ══
   ⛔ AN OFFER MAY ONLY CITE WHAT THE CONTEXT ACTUALLY CONTAINS. Every `why` string is built from a counter
   that was passed in: 3 projects because ctx.projects.length === 3, "never scheduled" because no cron job
   carries that recipeId. This module NEVER guesses, never says "you probably", and never describes the
   CONTENTS of anything it was not given — it has not read inside those folders, so it may not claim there
   are four abandoned drafts in them. It may only say the folders exist and nothing is watching them. That
   distinction is the whole difference between a station that earns trust and one that makes things up,
   and it is the product's core law applied to its own recommender.

   Pure and deterministic: same ctx -> same offers, no clock, no storage, no fetch. The caller gathers the
   context (marketplace.js) and does the rendering; everything here is testable under node.

   UMD-light: a `RecipeFit` global in the browser, module.exports under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeFit = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const arr = (v) => Array.isArray(v) ? v : [];
  const str = (v) => String(v == null ? '' : v).trim();
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  /* WHAT A RECIPE NEEDS, derived from its own declared schema — never a hand-maintained list keyed by id.
     A per-recipe table would drift the moment somebody adds a catalog entry and forgets to register it,
     and the schema already carries the answer: gear says which capability it leans on, and a typed param
     says what kind of real thing it wants pointed at. */
  function needsOf(recipe) {
    const gear = arr(recipe && recipe.gear);
    const params = arr(recipe && recipe.params);
    return {
      files: gear.indexOf('cabinet') >= 0 || params.some(p => p.type === 'folder' || p.type === 'file'),
      folder: params.some(p => p.type === 'folder'),
      channel: gear.indexOf('connector') >= 0 || params.some(p => p.type === 'connector'),
      web: gear.indexOf('dish') >= 0,
      shell: gear.indexOf('workbench') >= 0,
      standing: !!(recipe && recipe.cadence)
    };
  }

  /* Is this recipe CODE work? A granted folder is not self-describing — a repo and a folder of invoices are
     both "a project" to the path grant — so without this the shelf cheerfully offered PR Sweep against a
     landing page and Client Check-In against a source tree. Both claims were technically true ("2 projects
     granted") and both were obviously wrong to a human, which is the fastest way to lose trust in a
     recommender. The recipe's own declared tag is the honest signal; `isGitRepo` from the projects API is
     the honest signal on the other side, and the two only earn each other when they agree. */
  function isCode(recipe) {
    const t = (recipe && recipe.tags) || {};
    return Number(t.code) > 0;
  }

  /* Buckets that ASSUME what kind of work the Commander does. A path grant says a folder exists; it says
     nothing about whether it holds client deliverables, invoices or a photo library. So "Client Check-In"
     pointed at an unknown folder is guessing at the Commander's profession, and being confidently wrong
     about who somebody is reads far worse than offering nothing. These need CORROBORATION — a learned
     topic, or the Commander having run this recipe before — and until then the domain-neutral recipes,
     which are valid against any folder, hold the shelf. */
  const ASSUMES_DOMAIN = ['business', 'money', 'creator'];
  function assumesDomain(recipe) { return ASSUMES_DOMAIN.indexOf(str(recipe && recipe.category)) >= 0; }

  // param keys that name a SUBJECT — the slot a learned topic can honestly fill. Matched exactly, never by
  // substring: a 'target' param on a code review wants a file, not the phrase the Commander has been reading about.
  const TOPIC_KEYS = ['topic', 'subject', 'area', 'question'];
  // param keys that name a PLACE — the slot a granted project root fills.
  const PLACE_KEYS = ['where', 'folder', 'records', 'project', 'documents', 'receipts', 'evidence'];

  /* PRE-FILL a recipe's params from real context. Returns { values, bound } where `bound` lists what was
     actually filled and from what, so the caller can show the Commander exactly what it decided for them —
     a form that silently arrives pre-filled is a form that gets launched without being read. */
  function bind(recipe, ctx) {
    const values = {}, bound = [];
    const projects = arr(ctx.projects), topics = arr(ctx.topics), channels = arr(ctx.channels);
    const project = projects[0] || null;
    const topic = topics[0] || null;
    const needs = needsOf(recipe);
    /* ⛔ A TYPED param is a promise about what the slot means; a KEY is only a guess. So a folder path may
       be bound by key ONLY when the recipe is actually about files. `promises-made` has an untyped `where`
       whose own default is "the messages on my connected channels" — matching the PLACE_KEYS list on the
       key alone silently rewrote that into a folder path and changed what the recipe does. When in doubt,
       bind nothing: an unfilled param falls back to the recipe's own default, which its author chose. */
    const mayBindPlace = !needs.channel;
    for (const p of arr(recipe && recipe.params)) {
      const key = str(p.key);
      if (!key) continue;
      const placeSlot = p.type === 'folder' || (mayBindPlace && PLACE_KEYS.indexOf(key) >= 0);
      if (placeSlot && project && str(project.root)) {
        values[key] = str(project.root);
        bound.push({ key: key, from: 'project', label: str(project.name) || str(project.root) });
        continue;
      }
      if (TOPIC_KEYS.indexOf(key) >= 0 && topic && str(topic.term)) {
        values[key] = str(topic.term);
        bound.push({ key: key, from: 'topic', label: str(topic.term) });
        continue;
      }
      if (p.type === 'connector' && channels.length && str(channels[0].label)) {
        values[key] = str(channels[0].label);
        bound.push({ key: key, from: 'channel', label: str(channels[0].label) });
      }
    }
    return { values: values, bound: bound };
  }

  /* THE EVIDENCE LINE. Every branch below is a statement about something COUNTED in ctx — nothing here
     describes the inside of a folder, the content of a message, or anything this module was not handed.
     Ordered most-specific-first so the strongest real evidence is what the Commander reads. */
  function why(recipe, ctx, n) {
    const needs = needsOf(recipe);
    const projects = arr(ctx.projects), channels = arr(ctx.channels), topics = arr(ctx.topics);
    const launched = n.launches > 0;

    if (needs.standing && launched && !n.scheduled) {
      return 'you have run this ' + n.launches + '× by hand and it is not on a schedule';
    }
    if (needs.channel && channels.length) {
      return channels.length === 1
        ? str(channels[0].label) + ' is connected and nothing reads it on a schedule'
        : plural(channels.length, 'channel') + ' connected and nothing reads them on a schedule';
    }
    if (needs.folder && projects.length) {
      /* ⛔ "nothing watches it" is only true of a STANDING recipe. It read as the reason for one-shots too —
         "Build a Feature: orbital-api is a git repo and nothing watches it" — which is nonsense, because a
         one-shot was never going to watch anything. The clause describes a GAP the recipe would fill, so it
         may only appear when the recipe actually fills it. A one-shot's honest reason is just the target. */
      const repos = projects.filter(p => p && p.git);
      const gap = needs.standing;
      if (isCode(recipe) && repos.length) {
        const name = str(repos[0].name || repos[0].root);
        if (repos.length === 1) return gap ? name + ' is a git repo and nothing watches it' : 'runs against ' + name + ', a git repo you granted';
        return gap ? plural(repos.length, 'git repo') + ' granted, and nothing watches them' : 'runs against the ' + plural(repos.length, 'git repo') + ' you granted';
      }
      const one = str(projects[0].name || projects[0].root);
      if (projects.length === 1) return gap ? 'you have granted ' + one + ' and nothing watches it' : 'runs against ' + one;
      return gap ? plural(projects.length, 'project') + ' granted, and nothing watches them' : 'runs against the ' + plural(projects.length, 'project') + ' you granted';
    }
    if (needs.web && topics.length && str(topics[0].term)) {
      return 'you keep working on ' + str(topics[0].term);
    }
    if (needs.files && projects.length) {
      return 'runs against ' + str(projects[0].name || projects[0].root);
    }
    if (launched) return 'you have run this ' + n.launches + '×';
    if (needs.standing) return 'runs on a schedule and reports what changed';
    return '';
  }

  /* SCORE an offer. Deliberately dull arithmetic over real counters — no learned weights, so the ordering
     is explainable from the evidence line the Commander can already see. Highest first, catalog order
     breaks ties so the result is stable for a fixed ctx. */
  function score(recipe, ctx, n) {
    const needs = needsOf(recipe);
    const projects = arr(ctx.projects).length, channels = arr(ctx.channels).length, topics = arr(ctx.topics).length;
    let s = 0;
    // BOUND TO A REAL NAMED THING is worth the most: that is the entire difference between this shelf and
    // the generic library sitting right below it.
    if (needs.channel && channels) s += 4;
    if (needs.folder && projects) s += 3;
    if (needs.web && topics) s += 2;
    if (needs.files && projects) s += 1;
    // a standing job the station could be running and is not
    if (needs.standing && !n.scheduled) s += 3;
    // the Commander already voted with their hands
    if (n.launches > 0) s += Math.min(2, n.launches);
    if (n.great > 0) s += 1;
    // scale the miss penalty the way rankRecipes does (-2 per miss, capped): a flat -2 let a recipe with
    // two misses survive on launch count alone, which is the Commander telling us twice and being ignored.
    if (n.miss > 0) s -= 2 * Math.min(3, n.miss);
    // UNMET NEEDS SINK IT. A connector recipe with no channel connected is an advert for a feature the
    // Commander does not have — it belongs in the library, not on a shelf claiming the station is ready.
    if (needs.channel && !channels) s -= 5;
    if (needs.folder && !projects) s -= 4;
    // a code recipe pointed at a real repo is a strong match (the DISqualifying half lives in eligible()).
    if (needs.folder && isCode(recipe) && arr(ctx.projects).some(p => p && p.git)) s += 2;
    return s;
  }

  /* HARD DISQUALIFIERS — the checks that must EXCLUDE rather than merely down-rank.
     A score penalty was the first attempt and it was wrong: PR Sweep still cleared zero on "2 folders
     granted" plus "standing job not scheduled", so it kept appearing against a landing page and a folder of
     invoices. A mismatch of KIND is not a weak match to be out-ranked — it is a card that should never have
     been printed, because the shelf's whole claim is that these are things this station is ready to run. */
  function eligible(recipe, ctx) {
    const needs = needsOf(recipe);
    if (needs.channel && !arr(ctx.channels).length) return false;   // no channel connected
    if (needs.folder && !arr(ctx.projects).length) return false;    // nowhere to point it
    // code work with nothing that is actually code
    if (needs.folder && isCode(recipe) && !arr(ctx.projects).some(p => p && p.git)) return false;
    // a domain-assuming recipe with nothing corroborating the assumption
    if (assumesDomain(recipe) && !corroborated(recipe, ctx)) return false;
    return true;
  }

  /* Does anything besides "a folder exists" point at this recipe? A learned topic that the recipe's own
     language covers, or the Commander having launched it before, both count — they are the Commander's
     own behaviour rather than our guess about them. */
  function corroborated(recipe, ctx) {
    const id = str(recipe && recipe.id);
    const u = (ctx.launches && typeof ctx.launches === 'object') ? ctx.launches[id] : null;
    const n = (u && typeof u === 'object') ? u.n : u;
    if (Number.isFinite(n) && n > 0) return true;
    const hay = (str(recipe && recipe.name) + ' ' + str(recipe && recipe.tagline) + ' ' +
      str(recipe && recipe.blurb) + ' ' + str(recipe && recipe.category)).toLowerCase();
    return arr(ctx.topics).some(t => {
      const term = str(t && t.term).toLowerCase();
      return term.length > 2 && hay.indexOf(term) >= 0;
    });
  }

  function counters(recipe, ctx) {
    const id = str(recipe && recipe.id);
    const u = (ctx.launches && typeof ctx.launches === 'object') ? ctx.launches[id] : null;
    const nRaw = (u && typeof u === 'object') ? u.n : u;
    const rated = (u && typeof u === 'object' && u.rated && typeof u.rated === 'object') ? u.rated : {};
    const scheduled = arr(ctx.scheduled).some(j => str(j && j.recipeId) === id);
    return {
      launches: Number.isFinite(nRaw) && nRaw > 0 ? Math.floor(nRaw) : 0,
      great: Number.isFinite(rated.great) ? rated.great : 0,
      miss: Number.isFinite(rated.miss) ? rated.miss : 0,
      scheduled: scheduled
    };
  }

  /* Is there enough real context to offer anything honestly? A station with no granted project, no
     connected channel and no learned topic knows NOTHING about its Commander, and a shelf claiming
     otherwise would be theatre. The caller renders the plain library instead — which is the honest state. */
  function hasContext(ctx) {
    ctx = ctx || {};
    return arr(ctx.projects).length > 0 || arr(ctx.channels).length > 0 || arr(ctx.topics).length > 0;
  }

  /* THE ENTRY POINT. offers(recipes, ctx, opts) -> [{ recipe, values, bound, why, score }]
     Excludes anything already running as a routine (it is handled — offering it again is noise) and
     anything whose score fell at or below zero (an unmet need, or a recipe the Commander rated a miss). */
  function offers(recipes, ctx, opts) {
    ctx = ctx || {};
    opts = opts || {};
    const limit = Number.isFinite(opts.limit) ? opts.limit : 4;
    if (!hasContext(ctx)) return [];
    const out = [];
    arr(recipes).forEach((r, idx) => {
      if (!r || !r.id) return;
      if (!eligible(r, ctx)) return;                 // wrong KIND of station for this recipe
      const n = counters(r, ctx);
      if (n.scheduled) return;                       // already running — not an offer
      const s = score(r, ctx, n);
      if (s <= 0) return;                            // unmet need or sunk by the Commander's own verdict
      const b = bind(r, ctx);
      const reason = why(r, ctx, n);
      if (!reason) return;                           // no honest thing to say = no card
      out.push({ recipe: r, values: b.values, bound: b.bound, why: reason, score: s, idx: idx });
    });
    out.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
    /* SPREAD THE SHELF. Scoring alone stacks near-duplicates at the top — the two halves of a matched pair
       (promises I made / what I am owed) score identically and would take both of the first two slots,
       which reads as one idea repeated and wastes a shelf that only holds a handful of cards. Cap each
       browse bucket at two, then backfill in score order if that left the shelf short. */
    const perBucket = {}, picked = [], spare = [];
    for (const o of out) {
      const b = str(o.recipe.category) || 'general';
      if ((perBucket[b] || 0) < 2) { perBucket[b] = (perBucket[b] || 0) + 1; picked.push(o); }
      else spare.push(o);
    }
    const final = picked.concat(spare).slice(0, Math.max(0, limit));
    return final.map(o => ({
      recipe: o.recipe, values: o.values, bound: o.bound, why: o.why, score: o.score
    }));
  }

  /* A one-line, fully honest summary of WHAT THE STATION LOOKED AT — rendered above the shelf so the
     Commander can audit the basis of every card below it. Truthful telemetry: if this line cannot be
     built from real counters, there is no shelf. */
  function basis(ctx) {
    ctx = ctx || {};
    const bits = [];
    const p = arr(ctx.projects).length, c = arr(ctx.channels).length, t = arr(ctx.topics).length;
    if (p) bits.push(plural(p, 'project'));
    if (c) bits.push(plural(c, 'connected channel'));
    if (t) bits.push(plural(t, 'learned topic'));
    const sch = arr(ctx.scheduled).length;
    if (sch) bits.push(plural(sch, 'routine') + ' already running');
    return bits.length ? bits.join(' · ') : '';
  }

  return { offers, basis, hasContext, needsOf, eligible, bind, why, score, TOPIC_KEYS, PLACE_KEYS };
});
