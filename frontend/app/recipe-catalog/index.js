/* STARNET — recipe-catalog/index.js : THE CATALOG AGGREGATE — every built-in recipe, from every module.

   recipes.js consumes THIS (never the individual modules) as the raw built-in array, then normalizes + freezes.
   Structure is deliberately trivial so adding a persona catalog (R4: dev.js / research.js / creator.js / ops.js)
   is a ONE-LINE add: `require`/read the module below, then drop it into the MODULES concat. Nothing else changes.

   Duplicate ids across modules are dropped (first module wins) so a stray copy-paste in a persona file can never
   silently shadow a core recipe or crash the freeze pass — it just doesn't register twice.

   UMD-light: a `RecipeCatalog` global in the browser (reads the sibling *Core globals off root); module.exports
   (the aggregated raw array) under node (requires the sibling modules). */
'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalog = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // pull each catalog module's raw array. Under node -> require; in the browser -> the global the module set.
  // Add a persona file here with ONE line: `mod('./dev.js', 'RecipeCatalogDev')` (and load its <script> before this).
  function mod(nodePath, globalName) {
    if (typeof require === 'function' && typeof module !== 'undefined') {
      try { return require(nodePath); } catch (_) { return []; }
    }
    const g = root[globalName];
    return Array.isArray(g) ? g : [];
  }

  const MODULES = [
    mod('./core.js', 'RecipeCatalogCore'),
    // R4 persona catalogs (one line each):
    mod('./dev.js', 'RecipeCatalogDev'),
    mod('./research.js', 'RecipeCatalogResearch'),
    mod('./creator.js', 'RecipeCatalogCreator'),
    mod('./ops.js', 'RecipeCatalogOps'),
    // life-domain catalogs (2026-08-03) — the buckets a person actually has, not just the five work personas:
    mod('./business.js', 'RecipeCatalogBusiness'),
    mod('./money.js', 'RecipeCatalogMoney'),
    mod('./career.js', 'RecipeCatalogCareer'),
    mod('./learn.js', 'RecipeCatalogLearn'),
    mod('./life.js', 'RecipeCatalogLife'),
    mod('./data.js', 'RecipeCatalogData'),
    mod('./writing.js', 'RecipeCatalogWriting'),
    mod('./general.js', 'RecipeCatalogGeneral'),
  ];

  // flatten + de-dup by id (first occurrence wins). The aggregate is the single built-in source recipes.js reads.
  const seen = Object.create(null), out = [];
  for (const arr of MODULES) {
    for (const r of (Array.isArray(arr) ? arr : [])) {
      if (!r || r.id == null || seen[r.id]) continue;
      seen[r.id] = true;
      out.push(r);
    }
  }
  const curated = mod('./curated.js', 'RecipeCatalogCurated');
  if (!curated.length) return out;
  const byId = new Map(out.map(r => [r.id, r]));
  const selected = new Set(curated.map(r => r.id));
  // Preserve retired ids for saved routines, old links, and forks. Only the
  // browsable/recommended library is trimmed; an old job keeps its directive.
  return curated.map(copy => {
    const original = byId.get(copy.id);
    if (!original) throw new Error('Unknown curated recipe: ' + copy.id);
    return Object.assign({}, original, copy);
  }).concat(out.filter(r => !selected.has(r.id)).map(r => Object.assign({}, r, { archived: true })));
});
