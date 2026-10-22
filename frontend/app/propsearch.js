/* AGENT OS — propsearch.js : PURE prop-palette search matcher.

   The REFIT palette browses 120+ props through two TIERS and ~11 category tabs. That taxonomy is
   fine when you know which drawer a thing lives in and useless when you don't — "where is the
   MUG?" costs a tier guess plus a scan of every tab. This is the flat way in: type a word, get
   every prop that matches ACROSS both tiers and every category.

   WHAT A TOKEN MAY MATCH — the rule is: anything the palette PUTS ON SCREEN for that prop.
   A word the user can read off a tile and not search by is a worse failure than no search at all.
     - the prop's label and id;
     - its category id AND the category's display label (so "workstations", the text on the tab);
     - its tier key AND the tier's display label (so "systems" finds all 29 functional props,
       even though the internal key is `functional`);
     - its GRANT word — the badge printed on the tile (COMPUTE, WEB, FILES, MEMORY, …). Supplied by
       the caller via opts.extra, because the prop -> capability map lives in the world model and
       this file stays dependency-free;
     - its `desc` — but see the ranking note; a desc hit is deliberately the weakest kind.

   Matching rules (deliberately boring — a palette filter must be predictable, not clever):
     - the query is TOKENIZED on whitespace and every token must match (AND, not OR), so
       "desk lamp" narrows rather than widening the way a raw substring search would;
     - case-insensitive, order-independent ("lamp desk" == "desk lamp").

   RANKING, in three bands, because `desc` is prose and prose matches everything:
     0. the prop's LABEL starts with the first token   — what you almost certainly meant
     1. matched on a NAME-ish field (label/id/cat/tier/grant)
     2. matched ONLY inside `desc`
   Descriptions share stock phrasing ("WORKSTATION — assign an agent here…"), so a desc hit is a
   hint, never a headline. Array#sort is stable, so catalog order (functional before cosmetic)
   survives inside every band.

   Pure + headless-safe: no DOM, no clock, no state — a catalog and a string go in, a filtered
   array comes out. Loads under require() for the unit tests exactly like toolprops.js. */
'use strict';

const PropSearch = (() => {

  /* the query, reduced to lowercase whitespace-separated tokens ([] when there's nothing to search) */
  function tokens(q) {
    if (!q || typeof q !== 'string') return [];
    return q.toLowerCase().split(/\s+/).filter(Boolean);
  }

  /* is the user actually searching? the caller uses this to tell "browsing" from "no results",
     because an empty result set and an empty query need very different UI. */
  function active(q) { return tokens(q).length > 0; }

  const str = v => (v == null ? '' : String(v));
  /* opts.catLabel / opts.tierLabel are the caller's id -> display-name lookups; opts.extra returns
     any additional visible text for a prop (the grant badge). All optional — a bare catalog still
     searches by label/id/cat/tier. A plain function third arg is read as catLabel. */
  function norm(opts) {
    if (typeof opts === 'function') return { catLabel: opts, tierLabel: null, extra: null };
    return opts || {};
  }
  const call = (fn, arg) => { if (typeof fn !== 'function') return ''; try { return str(fn(arg)); } catch (e) { return ''; } };

  /* the NAME-ish surface: everything short and identifying, as one lowercase string */
  function haystack(c, opts) {
    if (!c) return '';
    const o = norm(opts);
    const cat = str(c.cat), tier = str(c.tier);
    return [
      str(c.label), str(c.id),
      cat, call(o.catLabel, cat),
      tier, call(o.tierLabel, tier),
      call(o.extra, c),
    ].join(' ').toLowerCase();
  }

  /* the prose surface, kept separate so a desc-only hit can be ranked below every name hit */
  function descstack(c) { return c ? str(c.desc).toLowerCase() : ''; }

  /* catalog + query -> the matching entries, ranked. */
  function matchProps(catalog, q, opts) {
    const toks = tokens(q);
    if (!toks.length || !catalog || !catalog.length) return [];
    const first = toks[0];
    const hit = [];
    for (const c of catalog) {
      const name = haystack(c, opts);
      const desc = descstack(c);
      // every token must land SOMEWHERE (name or desc); the band records where they all landed
      let all = true, nameOnly = true;
      for (const t of toks) {
        const inName = name.indexOf(t) >= 0;
        if (!inName && desc.indexOf(t) < 0) { all = false; break; }
        if (!inName) nameOnly = false;
      }
      if (!all) continue;
      // a label-prefix hit only earns the top band if EVERY token was a name hit — otherwise the
      // prose token is doing the work and the result belongs with the other desc matches
      const prefix = nameOnly && str(c.label).toLowerCase().indexOf(first) === 0;
      hit.push({ c, band: prefix ? 0 : (nameOnly ? 1 : 2) });
    }
    return hit.sort((a, b) => a.band - b.band).map(h => h.c);
  }

  return { tokens, active, haystack, descstack, matchProps };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropSearch;
