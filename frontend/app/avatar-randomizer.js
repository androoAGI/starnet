/* STARNET — avatar-randomizer.js : pick a recruitment avatar, preferring skins the crew is not using.

   Pure + node-testable. The Recruitment Bay supplies the valid skin ids, the live roster's skin ids,
   and Math.random. Keeping roster lookup outside this helper means it never invents station state. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvatarRandomizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function pick(skinIds, usedSkinIds, random) {
    const valid = Array.from(new Set((Array.isArray(skinIds) ? skinIds : []).filter(Boolean)));
    if (!valid.length) return null;

    const used = new Set((Array.isArray(usedSkinIds) ? usedSkinIds : []).filter(Boolean));
    const unused = valid.filter(id => !used.has(id));
    const pool = unused.length ? unused : valid;
    const rng = typeof random === 'function' ? random : Math.random;
    const roll = Number(rng());
    const bounded = Number.isFinite(roll) ? Math.max(0, Math.min(0.9999999999999999, roll)) : 0;
    return pool[Math.floor(bounded * pool.length)];
  }

  return { pick };
});