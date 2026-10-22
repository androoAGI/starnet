/* AGENT OS — pure sprite-manifest load planning. Browser + CommonJS so startup budgets are testable. */
'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SpriteLoadPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function makeSpriteLoadPlan() {
  function groupTracks(sprites) {
    const grouped = {};
    for (const [key, paths] of Object.entries(sprites && typeof sprites === 'object' ? sprites : {})) {
      const dot = key.indexOf('.');
      const set = dot > 0 ? key.slice(0, dot) : '';
      if (!set || !Array.isArray(paths) || !paths.length) continue;
      (grouped[set] || (grouped[set] = [])).push([key, paths.slice()]);
    }
    return grouped;
  }

  function frameCount(tracks) {
    return (Array.isArray(tracks) ? tracks : []).reduce((n, row) => n + (Array.isArray(row[1]) ? row[1].length : 0), 0);
  }

  function initialTracks(grouped, sets) {
    const seen = new Set();
    const out = [];
    for (const set of Array.isArray(sets) ? sets : []) {
      if (!set || seen.has(set)) continue;
      seen.add(set);
      out.push(...((grouped && grouped[set]) || []));
    }
    return out;
  }

  return { groupTracks, frameCount, initialTracks };
});
