/* Data-only placement orientation for the fresh client. Visual modules are not dependencies. */
'use strict';
const NextOrientation = (() => {
  // These two soft-furniture/table plans predate the catalog's flat/surface flags.
  // Their footprint describes occupied deck area, so a supported side view swaps it.
  const plans = new Set(['dinertable', 'booth']);
  const normalize = r => ((Number(r) | 0) % 4 + 4) % 4;
  function facings(spec) {
    const values = spec && Array.isArray(spec.facings) ? spec.facings : [0];
    const legal = [...new Set(values.filter(r => Number.isInteger(r) && r >= 0 && r < 4))];
    return legal.length ? legal : [0];
  }
  function nextFacing(spec, current = 0, direction = 1) {
    const values = facings(spec);
    if (!spec || spec.canRotate === false || values.length === 1) return values[0];
    const index = values.indexOf(normalize(current));
    return values[((index < 0 ? 0 : index) + (direction < 0 ? -1 : 1) + values.length) % values.length];
  }
  function box(spec, rotation = 0) {
    const size = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 1;
    const w = size(spec && spec.w), h = size(spec && spec.h), r = normalize(rotation);
    const plan = spec && (spec.flat === true || spec.surface === true || plans.has(spec.id));
    return plan && (r & 1) && facings(spec).includes(r) ? { w: h, h: w } : { w, h };
  }
  const canMirror = spec => !!spec && spec.canMirror === true;
  return Object.freeze({ normalize, facings, nextFacing, box, canMirror });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = NextOrientation;
