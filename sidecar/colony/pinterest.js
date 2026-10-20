'use strict';
const { fail, digest } = require('./core.js');

// Read adapter only. No path discovery and no direct JSON writer beside the
// existing dashboard. Connection and exclusive write ownership remain explicit.
function importSnapshot(input, businessUnitId, account) {
  if (!['lifestruct', 'homestackr'].includes(businessUnitId) || input.businessUnitId !== businessUnitId || input.account !== account) fail('COLONY_DASHBOARD_SCOPE_MISMATCH');
  if (!input.revision || !Array.isArray(input.pins) || input.pins.length > 500) fail('COLONY_DASHBOARD_INVALID');
  const ids = new Set();
  const pins = input.pins.map(pin => {
    if (!pin.id || ids.has(pin.id)) fail('COLONY_DASHBOARD_DUPLICATE_ID'); ids.add(pin.id);
    // We never turn missing legacy review fields or `exported` into approval.
    return { id: String(pin.id), businessUnitId, account, revision: pin.revision || null,
      imageRevision: pin.imageRevision || null, review: pin.review || null,
      approval: pin.approval || null, history: Array.isArray(pin.history) ? structuredClone(pin.history) : [],
      externalStatus: ['provided', 'exported', 'uploaded', 'published'].includes(pin.status) ? pin.status : 'unknown',
      colonyApproval: null, needsReconciliation: true };
  });
  return { businessUnitId, account, sourceRevision: input.revision, digest: digest(input), pins, readOnly: true, connected: false };
}
module.exports = { importSnapshot };
