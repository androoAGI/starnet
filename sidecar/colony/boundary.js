'use strict';
const { agentBrand } = require('./catalog.js');

// Unknown legacy/global feedback is not proof of a cross-brand preference. The
// shared set is host-approved separately; a model-authored record cannot opt in.
function scopedBrand(id, options = {}) {
  return options.legacy === false && !String(id).startsWith('colony_') ? null : agentBrand(id);
}
function sharedNotebooks(targetId, entries, options) {
  const target = scopedBrand(targetId, options);
  return (entries || []).filter(e => {
    const source = scopedBrand(e.agentId, options);
    return target ? source === target : !source;
  });
}
// Even manually addressed legacy runs may not inherit another brand's history.
function sameBrand(a, b, options) {
  const aa = scopedBrand(a, options), bb = scopedBrand(b, options);
  return aa || bb ? !!aa && aa === bb : true;
}
function assertContext(agentId, context) {
  const brand = agentBrand(agentId);
  if (!context || brand !== context.businessUnitId) throw new Error('COLONY_BRAND_MISMATCH');
  for (const s of [...(context.sources || []), ...(context.artifacts || []), ...(context.preferences || [])]) {
    if (s.businessUnitId !== brand) throw new Error('COLONY_FOREIGN_CONTEXT');
  }
  return true;
}
module.exports = { sharedNotebooks, sameBrand, assertContext, scopedBrand };
