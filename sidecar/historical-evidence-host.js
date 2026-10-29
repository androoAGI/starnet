'use strict';

// Read-only host adapter for Phase A. It exposes only provenance already present
// on immutable run/deliverable records; it never infers associations or mutates stores.
const DISPLAY_STATUS = 'Related work observed — not yet settled as milestone completion.';

function text(v) { return v == null ? '' : String(v); }
function array(v) { return Array.isArray(v) ? v : []; }
function exactAssociation(row) {
  const a = row && row.association && row.association;
  const goalId = text(row && (row.goalId || (a && a.goalId))).trim();
  const milestoneId = text(row && (row.milestoneId || (a && a.milestoneId))).trim();
  return goalId && milestoneId ? { goalId, milestoneId } : null;
}
function readOnlyItem(row, sourceType) {
  const association = exactAssociation(row);
  if (!association) return null;
  const runId = text(row.runId).trim() || null;
  const controllerExecutionId = text(row.controllerExecutionId || row.controllerRunId).trim() || null;
  if (!runId && !controllerExecutionId) return null;
  return {
    association, goalId: association.goalId, milestoneId: association.milestoneId,
    sourceType: sourceType || row.sourceType || 'run', sourceKind: row.sourceKind || 'comms',
    runId, controllerRunId: text(row.controllerRunId).trim() || null,
    controllerExecutionId, title: row.title || row.sourceId || runId || controllerExecutionId,
    status: row.status || row.reason || 'unknown', displayStatus: DISPLAY_STATUS,
    artifacts: array(row.artifacts).slice(), validation: row.validation || null,
    timestamp: row.timestamp || row.ts || row.endedAt || row.completedAt || row.startedAt || null,
    readOnly: true, completion: false
  };
}
function makeHistoricalEvidenceHost(deps) {
  deps = deps || {};
  return {
    async snapshot() {
      const items = [];
      const seen = new Set();
      const add = (row, kind) => {
        const item = readOnlyItem(row, kind);
        if (!item) return;
        const key = `${item.sourceType}:${item.runId || item.controllerExecutionId}`;
        if (seen.has(key)) return;
        seen.add(key); items.push(item);
      };
      let runs = [];
      let deliverables = [];
      try { runs = array(deps.readRuns && deps.readRuns()); } catch (_) { runs = []; }
      try { deliverables = array(await Promise.resolve(deps.readDeliverables && deps.readDeliverables())); } catch (_) { deliverables = []; }
      runs.forEach(row => add(row, 'run'));
      deliverables.forEach(row => add(row, 'deliverable'));
      return { schemaVersion: 'starnet.historical-evidence-projection.v1', generatedAt: new Date().toISOString(), readOnly: true, items, displayStatus: DISPLAY_STATUS,
        safety: { canonicalMutationPerformed: false, xpAwarded: false, commanderPointsAwarded: false, historicalEventsInvented: false, completionSettlementPerformed: false } };
    }
  };
}
module.exports = { DISPLAY_STATUS, makeHistoricalEvidenceHost, exactAssociation, readOnlyItem };
