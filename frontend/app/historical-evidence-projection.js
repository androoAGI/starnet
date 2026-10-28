/* STARNET — read-only historical evidence projection browser adapter.
 *
 * The authoritative projection is produced from immutable evidence snapshots by
 * the host/controller. This adapter only exposes those already-associated rows
 * to GoalStore; it never discovers by topic/title and never writes progression.
 */
'use strict';
(function (root) {
  let snapshot = null;
  let provider = null;
  function rows(target) {
    const source = snapshot || (typeof provider === 'function' ? provider(target) : null) || root.__STARNET_HISTORICAL_EVIDENCE__;
    if (!source || !Array.isArray(source.items)) return [];
    return source.items.filter(item => item && item.readOnly !== false).map(item => ({
      goalId: item.association && item.association.goalId || item.goalId || null,
      milestoneId: item.association && item.association.milestoneId || item.milestoneId || null,
      runId: item.runId || null,
      controllerRunId: item.controllerRunId || null,
      controllerExecutionId: item.controllerExecutionId || null,
      title: item.title || item.sourceId || item.runId || item.controllerTaskId || 'historical work',
      displayStatus: item.displayStatus || 'Related work observed — not yet settled as milestone completion.',
      artifacts: Array.isArray(item.artifacts) ? item.artifacts.slice() : [],
      validation: item.validation || null,
      timestamp: item.timestamp || null,
      sourceKind: item.sourceKind || null,
      readOnly: true,
      completion: false
    }));
  }
  root.HistoricalEvidenceProjection = {
    rows,
    // Test/host seam: replace the immutable read snapshot only; no persistence or progression mutation.
    setSnapshot: value => { snapshot = value && typeof value === 'object' ? value : null; },
    setProvider: fn => { provider = typeof fn === 'function' ? fn : null; },
    clear: () => { snapshot = null; provider = null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
