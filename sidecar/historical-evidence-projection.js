'use strict';

/**
 * Read-only projection of historical execution evidence onto existing goals/quests.
 *
 * This module deliberately never calls a quest, journey, XP, points, or ledger
 * mutation API. It consumes snapshots and returns derived evidence only.
 */
const fs = require('fs');
const path = require('path');

const DISPLAY_STATUS = 'Related work observed — not yet settled as milestone completion.';

function asArray(value) { return Array.isArray(value) ? value : []; }
function text(value) { return value == null ? '' : String(value); }
function lower(value) { return text(value).toLowerCase(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}
function normalizePath(value) {
  return text(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}
function pathWithin(candidate, root) {
  const c = normalizePath(candidate);
  const r = normalizePath(root);
  return !!c && !!r && (c === r || c.startsWith(r + '/'));
}
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`invalid_jsonl:${filePath}:${index + 1}:${error.message}`); }
  });
}
function mergeRunRows(rows) {
  const byId = new Map();
  for (const row of asArray(rows)) {
    if (!row || !row.runId) continue;
    const prior = byId.get(String(row.runId));
    if (!prior) { byId.set(String(row.runId), { ...row }); continue; }
    for (const key of ['artifacts', 'toolTrace']) {
      prior[key] = unique(asArray(prior[key]).concat(asArray(row[key])));
    }
    for (const key of ['deliveryText', 'dispatchText']) {
      if (!prior[key] && row[key]) prior[key] = row[key];
    }
    if (!prior.dispatchDelivery && row.dispatchDelivery) prior.dispatchDelivery = row.dispatchDelivery;
    for (const [key, value] of Object.entries(row)) {
      if ((prior[key] == null || prior[key] === '' || prior[key] === false) && value != null && value !== '') prior[key] = value;
    }
  }
  return [...byId.values()];
}
function runText(row) {
  return [row.title, row.deliveryText, row.dispatchText, row.dispatchDelivery && row.dispatchDelivery.text,
    row.deliverable && row.deliverable.main, ...asArray(row.artifacts).map(a => typeof a === 'string' ? a : a && a.path)]
    .map(text).join('\n');
}
function sourceKind(run) {
  if (run.cronJobId || lower(run.streamId).startsWith('cron-') || lower(run.surface) === 'scheduled') return 'routine';
  if (run.lineId || run.bayId || run.worklineId || run.conveyorId || lower(run.surface) === 'conveyor') return 'conveyor';
  return 'comms';
}
function controllerRunText(row) { return JSON.stringify(row || {}); }
function controllerValidation(task, ledger) {
  const values = [task && task.validation_status, ledger && ledger.validation && ledger.validation.outcome,
    ledger && ledger.validation, task && task.status, ledger && ledger.result].map(lower);
  if (values.some(v => v.includes('failed') || v.includes('needs_correction'))) return 'failed';
  if (values.some(v => v.includes('passed') || v === 'success' || v === 'completed')) return 'passed';
  if (values.some(v => v.includes('blocked'))) return 'blocked';
  return 'not_assessed';
}
function artifactRefs(run, task, ledger, projectRoot) {
  const refs = [];
  const add = (value, kind = 'file') => {
    if (!value) return;
    const raw = text(value);
    const resolved = path.isAbsolute(raw) ? raw : (projectRoot ? path.join(projectRoot, raw) : raw);
    refs.push({ kind, path: raw, resolvedPath: resolved, exists: fileExists(resolved) });
  };
  for (const artifact of asArray(run && run.artifacts)) add(typeof artifact === 'string' ? artifact : artifact && artifact.path, artifact && artifact.kind || 'file');
  if (run && run.deliverable) add(run.deliverable.main, run.deliverable.kind || 'deliverable');
  if (task && task.outputs_path) add(task.outputs_path, 'declared-output');
  if (ledger && ledger.deliverable) add(ledger.deliverable, 'controller-deliverable');
  return refs.filter((item, index, all) => all.findIndex(x => normalizePath(x.resolvedPath) === normalizePath(item.resolvedPath)) === index);
}
function explicitAssociation(haystack, target) {
  return lower(haystack).includes(lower(target.goalId)) || lower(haystack).includes(lower(target.milestoneId));
}
function projectAssociation(run, task, ledger, target) {
  const root = target.projectRoot;
  if (!root) return false;
  if (run && pathWithin(run.projectRoot, root)) return true;
  const output = task && task.outputs_path;
  if (output && (pathWithin(output, root) || pathWithin(path.join(root, output), root))) return true;
  return !!(ledger && (ledger.project_id === target.projectId || ledger.projectId === target.projectId));
}
function selectAssociation({ textValue, run, task, ledger, targets }) {
  const explicit = targets.filter(target => explicitAssociation(textValue, target));
  if (explicit.length === 1) return { ...explicit[0], matchType: 'explicit', confidence: 'high' };
  if (explicit.length > 1) return { matchType: 'ambiguous', confidence: 'low', candidates: explicit.map(t => ({ goalId: t.goalId, milestoneId: t.milestoneId })) };
  const candidates = targets.filter(target => projectAssociation(run, task, ledger, target));
  if (candidates.length === 1) return { ...candidates[0], matchType: 'project-or-task', confidence: 'low' };
  if (candidates.length > 1) return { matchType: 'ambiguous', confidence: 'low', candidates: candidates.map(t => ({ goalId: t.goalId, milestoneId: t.milestoneId })) };
  return { matchType: 'unrelated', confidence: 'none' };
}
function evidenceEligible(run, task, ledger, refs, targets) {
  if (targets.some(target => explicitAssociation(runText(run), target))) return true;
  if (refs.length) return true;
  if (task && (task.run_id || task.retrieval_test && task.retrieval_test.run_id)) return true;
  if (ledger && ledger.run_id) return true;
  return false;
}

/**
 * @param {object} input
 * @param {object[]} input.targets - goal/milestone targets; each has goalId, milestoneId, projectId, projectRoot
 * @param {object[]} input.runs - immutable run rows; duplicate dispatch rows are collapsed by runId
 * @param {object} input.project - project.json snapshot
 * @param {object} input.tasks - tasks.json snapshot
 * @param {object[]} input.controllerLedger - project ledger rows
 * @param {object[]} [input.researchArtifacts] - optional artifact metadata rows
 */
function projectHistoricalEvidence(input) {
  const targets = asArray(input.targets);
  const project = input.project || {};
  const tasks = asArray(input.tasks && input.tasks.tasks ? input.tasks.tasks : input.tasks);
  const ledger = asArray(input.controllerLedger);
  const runs = mergeRunRows(input.runs);
  const taskById = new Map(tasks.map(task => [String(task.task_id), task]));
  const ledgerByTask = new Map();
  for (const row of ledger) ledgerByTask.set(String(row.task_id), row);
  const projectRoot = project.root || input.projectRoot || (targets[0] && targets[0].projectRoot) || '';
  const items = [];
  const seen = new Set();

  function add(item) {
    const key = `${item.sourceType}:${item.sourceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }
  for (const run of runs) {
    const relatedTask = tasks.find(task => {
      const blob = lower(runText(run));
      return (task.run_id && blob.includes(lower(task.run_id))) ||
        (task.retrieval_test && task.retrieval_test.run_id && String(run.runId) === String(task.retrieval_test.run_id)) ||
        blob.includes(lower(task.task_id));
    });
    const task = relatedTask || null;
    const controller = task ? ledgerByTask.get(String(task.task_id)) : null;
    const refs = artifactRefs(run, task, controller, projectRoot || run.projectRoot);
    const association = selectAssociation({ textValue: runText(run), run, task, ledger: controller, targets });
    if (!evidenceEligible(run, task, controller, refs, targets)) continue;
    if (association.matchType === 'unrelated' && !pathWithin(run.projectRoot, projectRoot)) continue;
    add({
      sourceType: 'run', sourceId: String(run.runId), sourceKind: sourceKind(run), runId: String(run.runId),
      controllerTaskId: task && task.task_id || null, controllerRunId: task && (task.run_id || task.retrieval_test && task.retrieval_test.run_id) || null,
      parentRunId: run.parentRunId || null, timestamp: run.ts || run.endedAt || run.completedAt || run.startedAt || null,
      terminalReason: run.reason || null, projectRoot: run.projectRoot || null, artifacts: refs,
      validation: { completionVerdict: run.completionEvidence && run.completionEvidence.completionVerdict || 'not_assessed',
        effectVerdict: run.completionEvidence && run.completionEvidence.effectVerdict || 'not_assessed',
        controller: controllerValidation(task, controller), taskStatus: task && task.status || null },
      association, displayStatus: DISPLAY_STATUS
    });
  }
  for (const task of tasks) {
    const controller = ledgerByTask.get(String(task.task_id));
    const runId = task.run_id || task.retrieval_test && task.retrieval_test.run_id;
    const refs = artifactRefs(null, task, controller, projectRoot);
    const association = selectAssociation({ textValue: controllerRunText(task), run: null, task, ledger: controller, targets });
    if (!runId && !refs.length && !controller) continue;
    add({
      sourceType: 'controller-task', sourceId: String(task.task_id), sourceKind: 'project', runId: null,
      controllerTaskId: String(task.task_id), controllerRunId: runId || null, parentRunId: null,
      timestamp: task.completed_at || task.claimed_at || null, terminalReason: null, projectRoot,
      artifacts: refs, validation: { controller: controllerValidation(task, controller), taskStatus: task.status,
        acceptance: task.validation_status || null, retrieval: task.retrieval_test && task.retrieval_test.status || null },
      association, displayStatus: DISPLAY_STATUS
    });
  }
  items.sort((a, b) => text(b.timestamp).localeCompare(text(a.timestamp)) || a.sourceId.localeCompare(b.sourceId));
  const counts = items.reduce((out, item) => { out[item.sourceKind] = (out[item.sourceKind] || 0) + 1; return out; }, {});
  return {
    schemaVersion: 'starnet.historical-evidence-projection.v1',
    generatedAt: new Date().toISOString(), readOnly: true, displayStatus: DISPLAY_STATUS,
    targets, canonicalProgress: input.canonicalProgress || null,
    items, counts,
    safety: { canonicalMutationPerformed: false, xpAwarded: false, commanderPointsAwarded: false, historicalEventsInvented: false,
      completionSettlementPerformed: false },
    limitations: ['Associations without explicit goal/milestone context are candidates only.', 'A related artifact or successful retrieval does not settle a quest contract.', 'Canonical goal, quest, journey, XP, points, and project ledgers are not written by this projection.']
  };
}

module.exports = { DISPLAY_STATUS, mergeRunRows, projectHistoricalEvidence, readJson, readJsonl, pathWithin };
