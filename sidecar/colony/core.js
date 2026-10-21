'use strict';

// Fachzustand, not a second agent runtime or conveyor router. All I/O, model
// calls, clocks, identity and human decisions are supplied by the host.
const crypto = require('node:crypto');
const { BRANDS, ROLES, PROCESSES, agents } = require('./catalog.js');
const { assertContext } = require('./boundary.js');
const Processes = require('./processes.js');
const copy = value => structuredClone(value);
const money = value => Math.round(value * 1e9) / 1e9;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function requireThat(test, code) { if (!test) fail(code); }
function string(value, max = 2000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'COLONY_INVALID_TEXT');
  return value.trim();
}
function number(value, max = 1e9) { requireThat(Number.isFinite(value) && value >= 0 && value <= max, 'COLONY_INVALID_NUMBER'); return value; }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = v => crypto.createHash('sha256').update(stable(v)).digest('hex');
function initial() {
  return { schemaVersion: 1, revision: 0, brands: copy(BRANDS), roles: Object.fromEntries(Object.entries(ROLES).map(([id, name]) => [id, { id, name, version: 3 }])),
    agents: agents(), processes: copy(PROCESSES), tasks: {}, approvals: {}, actions: {}, cases: {}, feedback: [], globalPreferences: [], metrics: [], events: [],
    configuration: { revision: 0, mappings: {}, models: {}, poolBudget: { usd: 0, tokens: 0, ms: 0 }, enabled: false }, externalActionsEnabled: false };
}
function validate(s) {
  requireThat(s && s.schemaVersion === 1 && Number.isSafeInteger(s.revision) && s.revision >= 0 &&
    s.tasks && s.approvals && s.actions && s.brands && Array.isArray(s.events) && s.externalActionsEnabled === false, 'COLONY_INVALID_STORE');
  return s;
}
function taskOf(s, id) { requireThat(Object.hasOwn(s.tasks, id), 'COLONY_TASK_NOT_FOUND'); return s.tasks[id]; }
function snapshotDigest(t) {
  return digest({ brand: t.businessUnitId, processVersion: t.processVersion, account: t.account,
    schedule: t.schedule, audience: t.audience, goal: t.goal, pins: t.pins, facts: t.facts,
    artifacts: t.artifacts, sources: t.sources, criteriaVersion: t.criteriaVersion, roleVersions: t.roleVersions,
    ...(t.contractVersion ? { contractVersion: t.contractVersion, processContract: t.processContract, inputs: t.inputs, items: t.items, stages: t.stageOutputs,
      factReconciliations: t.factReconciliations || [], testOnly: t.testOnly === true } : {}) });
}
function selections(t) { return Processes.isPins(t) ? t.pins || [] : t.items || []; }
function dimensions(t) { return ['facts', 'brand', 'complete'].concat(Processes.isPins(t) || ['social', 'site_quality'].includes(t.outputKind) ? ['visual'] : []); }
function limitKeys(t) { return t.accountingMode === 'tokens' ? ['tokens', 'ms'] : ['usd', 'tokens', 'ms']; }
function visualGapText(value) {
  const text = typeof value === 'string' ? value : value && value.text || '';
  return /(?:\bno\s+(?:(?:png|image|picture|visual|bild|artifact)s?\s+){1,4}|\bkeine?\s+(?:(?:png|bild|bilder|image|artifact)s?\s+){1,4}|(?:png|image|bild|artifact).{0,80}(?:not attached|nicht angehängt|not present|nicht vorhanden|missing|fehlt))/i.test(text);
}
function validateAssets(s, t) {
  if (t.outputKind === 'social') for (const asset of t.inputs.owned_assets) {
    const stored = s.assets?.[asset.id];
    requireThat(stored && stored.businessUnitId === t.businessUnitId && stored.account === t.account && stored.rightsConfirmed && stored.sha256 === asset.sha256, 'COLONY_ASSET_SCOPE_UNCONFIRMED');
  }
}
function quality(t) {
  const unresolvedVisualGap = (t.facts?.uncertainties || []).some(visualGapText);
  return t.formal && t.formal.digest === snapshotDigest(t) && t.formal.passed === true && t.review &&
    t.review.digest === snapshotDigest(t) && t.review.passed === true && t.review.agentId !== t.producerAgentId &&
    (!t.fixerAgentId || t.review.agentId !== t.fixerAgentId) &&
    t.review.findings.length === 0 && !unresolvedVisualGap && dimensions(t).every(k => t.review.dimensions[k] === true);
}
function reconcileRenderedEvidence(t, host) {
  if (!Processes.isPins(t) || !t.facts || !Array.isArray(t.facts.uncertainties) || !t.pins?.length || t.artifacts.length !== t.pins.length) return;
  const unresolved = [], reconciled = t.factReconciliations || [];
  for (const uncertainty of t.facts.uncertainties) {
    const text = typeof uncertainty === 'string' ? uncertainty : uncertainty.text || '';
    if (visualGapText(uncertainty)) {
      reconciled.push({ id: digest({ text, artifactVersions: t.artifacts.map(a => a.version) }), text, resolvedBy: 'host_verified_complete_artifact_set', artifactVersions: t.artifacts.map(a => a.version), at: host.now });
    } else unresolved.push(uncertainty);
  }
  t.facts.uncertainties = unresolved; t.factReconciliations = reconciled;
}
function invalidate(t) { t.formal = null; t.review = null; t.activeApproval = null; }
function nextStep(t) {
  if (t.contractVersion && !Processes.isPins(t)) {
    if (t.escalationState === 'needs_fixer') return 'fixer';
    if (t.escalationState === 'final_review') {
      if (!t.formal) return 'formal';
      if (!t.review) return 'review';
      return null;
    }
    if (t.status === 'needs_revision') return Processes.producer(t);
    for (const role of t.processRoles.filter(r => r !== 'review')) {
      if (role === 'research') { if (!t.facts) return role; }
      else if (role === Processes.producer(t)) { if (!t.items) return role; }
      else if (!t.stageOutputs[role]) return role;
    }
    if (!t.formal) return 'formal';
    if (!t.review) return 'review';
    return null;
  }
  if (t.contractVersion && t.escalationState === 'needs_fixer') return 'fixer';
  if (t.contractVersion && t.escalationState === 'final_review') {
    if (Processes.isPins(t) && (!t.artifacts.length || t.artifacts.length !== t.pins.length)) return 'design';
    if (!t.formal) return 'formal';
    if (!t.review) return 'review';
    return null;
  }
  if (t.status === 'needs_revision') return 'editorial';
  if (!t.facts) return 'research';
  if (!t.pins) return 'editorial';
  if (!t.artifacts.length || t.artifacts.length !== t.pins.length) return 'design';
  if (!t.formal) return 'formal';
  if (!t.review) return 'review';
  return null;
}
function context(s, taskId, role) {
  const t = taskOf(s, taskId), agentId = 'colony_' + t.businessUnitId + '_' + role;
  const packet = { taskId: t.id, businessUnitId: t.businessUnitId, processId: t.processId, processVersion: t.processVersion,
    criteriaVersion: t.criteriaVersion, roleVersion: t.roleVersions[role],
    goal: t.goal, account: t.account, schedule: t.schedule, audience: t.audience,
    brand: s.brands[t.businessUnitId], sources: t.sources, targets: t.targets, boards: t.boards,
    facts: role === 'research' ? null : t.facts, pins: ['design', 'review', 'fixer'].includes(role) ? t.pins : null,
    artifacts: role === 'review' ? t.artifacts : [],
    findings: t.status === 'needs_revision' && t.review?.findings?.length ? t.review.findings : (t.revisionFindings || []),
    factReconciliations: role === 'review' ? t.factReconciliations || [] : [],
    preferences: s.feedback.filter(f => f.businessUnitId === t.businessUnitId).concat(s.globalPreferences.map(f => ({ ...f, businessUnitId: t.businessUnitId }))),
    output: role === 'research' ? '{facts:[{text,sourceId}],uncertainties:[string]}' : role === 'editorial'
      ? '{pins:[{id,title,description,overlay,url,board,sourceIds:[string]}]}' : '{passed:boolean,dimensions:{facts:boolean,brand:boolean,visual:boolean,complete:boolean},findings:[{pinId,dimension,message}]}' };
  if (t.contractVersion) Object.assign(packet, {
    contractVersion: t.contractVersion,
    roleInstructions: Processes.roleBrief(t.processId, role, t.processContract)
      + (role === 'review' && t.escalationState === 'final_review' ? ' Dies ist der verpflichtende unabhängige Abschlussreview nach dem Eskalations-Fixer; jeder offene Befund blockiert die Freigabe.' : ''),
    qualityLoopStage: role === 'fixer' ? 'bounded_escalation' : role === 'review' && t.escalationState === 'final_review' ? 'post_fixer_independent_review' : role === 'review' ? 'standard_review' : 'process_stage',
    inputs: t.inputs,
    stageOutputs: t.stageOutputs, items: role !== 'research' ? t.items : null,
    currentPins: t.status === 'needs_revision' ? t.pins : null, requiredDimensions: dimensions(t),
    artifactDigest: snapshotDigest(t), output: Processes.outputContract(t, role),
    testOnly: t.testOnly === true,
    constraints: { internalOnly: true, noPublication: true, noSelfApproval: true, maxItems: Processes.isPins(t) ? Math.min(6, t.inputs.pinCount || 3) : t.outputKind === 'sequence' ? 7 : 30 }
  });
  assertContext(agentId, packet);
  return packet;
}
function sourceRows(rows, brand) {
  requireThat(Array.isArray(rows) && rows.length > 0 && rows.length <= 20, 'COLONY_SOURCES_REQUIRED');
  const seen = new Set();
  return rows.map(row => {
    requireThat(row.businessUnitId === brand && row.confirmed === true, 'COLONY_SOURCE_SCOPE_UNCONFIRMED');
    const id = string(row.id, 80); requireThat(!seen.has(id), 'COLONY_DUPLICATE_SOURCE'); seen.add(id);
    const asOf = string(row.asOf, 40); requireThat(Number.isFinite(Date.parse(asOf)), 'COLONY_SOURCE_DATE_REQUIRED');
    return { id, businessUnitId: brand, uri: string(row.uri, 1000), asOf, version: string(row.version, 80),
      excerpt: string(row.excerpt, 16000), uncertainty: typeof row.uncertainty === 'string' ? row.uncertainty.slice(0, 1000) : '', confirmed: true };
  });
}
function proposal(s, c, host) {
  const p = s.processes[c.processId]; requireThat(p && p.implemented, 'COLONY_PROCESS_NOT_CONNECTED');
  requireThat(c.businessUnitId === p.businessUnitId, 'COLONY_PROCESS_BRAND_MISMATCH');
  const sources = sourceRows(c.sources, p.businessUnitId);
  const pinsProcess = Processes.definition(p.id).kind === 'pins';
  requireThat(!pinsProcess || Array.isArray(c.targets) && c.targets.length > 0 && c.targets.length <= 30, 'COLONY_TARGETS_REQUIRED');
  const targets = (c.targets || []).map(r => {
    const url = new URL(string(r.url, 1000)); requireThat(url.protocol === 'https:' && !url.username && !url.password, 'COLONY_INVALID_TARGET');
    return { url: url.href, promise: string(r.promise, 2000) };
  });
  requireThat(!pinsProcess || Array.isArray(c.boards) && c.boards.length > 0 && c.boards.length <= 50, 'COLONY_BOARDS_REQUIRED');
  const accountingMode = c.accountingMode || s.configuration.accountingMode || 'priced';
  requireThat(['priced', 'tokens'].includes(accountingMode), 'COLONY_INVALID_ACCOUNTING_MODE');
  requireThat(accountingMode !== 'tokens' || s.configuration.accountingMode === 'tokens', 'COLONY_TOKEN_MODE_REQUIRES_OWNER_CONFIGURATION');
  const budget = { usd: number(c.budget && c.budget.usd, 50), tokens: number(c.budget && c.budget.tokens, 1000000), ms: number(c.budget && c.budget.ms, 3600000) };
  requireThat((accountingMode === 'tokens' || budget.usd > 0) && budget.tokens > 0 && budget.ms > 0, 'COLONY_BUDGET_REQUIRED');
  const t = { id: host.id, businessUnitId: p.businessUnitId, processId: p.id, processVersion: p.version, criteriaVersion: p.criteriaVersion,
    roleVersions: Object.fromEntries(Object.entries(s.roles).map(([id, r]) => [id, r.version])),
    goal: string(c.goal), account: string(c.account, 120), schedule: string(c.schedule, 120), audience: string(c.audience, 200),
    sources, targets, boards: (c.boards || []).map(b => string(b, 120)), budget,
    contractVersion: p.contractVersion, processContract: copy(Processes.definition(p.id)), outputKind: p.outputKind, producerRole: p.producerRole, processRoles: copy(p.roles), testOnly: c.testOnly === true,
    inputs: Processes.requiredInputs(p.id, { ...(c.inputs || {}), audience: c.audience, schedule: c.schedule }, requireThat, c.testOnly === true), items: null, stageOutputs: {}, accountingMode,
    maxRevisions: Math.floor(number(c.maxRevisions ?? 3, 10)), revisionRounds: 0, noProgress: 0, revisionFindings: [],
    escalationState: null, fixerAgentId: null, fixerOutputRetries: 0,
    spent: { usd: 0, tokens: 0, ms: 0, unknown: false }, status: 'queued', reason: null,
    facts: null, pins: null, artifacts: [], factReconciliations: [], formal: null, review: null, attempts: [], activeAttempt: null,
    activeApproval: null, producerAgentId: null, createdAt: host.now, updatedAt: host.now };
  validateAssets(s, t);
  if (t.inputs.metrics) requireThat(t.inputs.metrics.every(r => t.sources.some(src => src.id === r.sourceId)), 'COLONY_METRIC_SOURCE_UNKNOWN');
  s.tasks[t.id] = t; return t;
}
function reduce(input, command, host) {
  const s = copy(validate(input)), c = command;
  requireThat(host && host.id && Number.isFinite(host.now), 'COLONY_HOST_REQUIRED');
  requireThat(c.expectedRevision === s.revision, 'COLONY_REVISION_CONFLICT');
  let result;
  if (c.type === 'catalog.sync') {
    // Versioned contracts apply only to new tasks; existing task snapshots stay pinned.
    s.processes = copy(PROCESSES);
    for (const [id, name] of Object.entries(ROLES)) if (!s.roles[id]) s.roles[id] = { id, name, version: 3 };
    for (const role of Object.values(s.roles)) role.version = 3;
    for (const [id, mapping] of Object.entries(s.configuration.mappings)) if (s.processes[id] && mapping.businessUnitId === s.processes[id].businessUnitId) mapping.processVersion = s.processes[id].version;
    const templates = agents();
    for (const template of templates) {
      const existing = s.agents.find(agent => agent.id === template.id);
      if (existing) Object.assign(existing, { roleVersion: template.roleVersion, purpose: template.purpose });
      else s.agents.push(copy(template));
    }
    result = { processes: Object.keys(s.processes).length };
  } else if (c.type === 'installation.bind') {
    requireThat(c.installation && Object.keys(c.installation.mappings || {}).length === 13, 'COLONY_INVALID_INSTALLATION');
    s.configuration.mappings = copy(c.installation.mappings);
    s.configuration.installation = copy(c.installation); s.configuration.revision++;
    result = s.configuration.installation;
  } else if (c.type === 'preference.global') {
    requireThat(c.confirmedGlobal === true, 'COLONY_GLOBAL_PREFERENCE_REQUIRES_OWNER');
    const preference = { id: host.id, text: string(c.text, 1000), scope: 'global', origin: 'explicit-owner', at: host.now };
    s.globalPreferences.push(preference); result = preference;
  } else if (c.type === 'configuration.set') {
    requireThat(!Object.values(s.tasks).some(t => t.activeAttempt), 'COLONY_CONFIGURATION_RUNS_ACTIVE');
    requireThat(c.models && typeof c.models === 'object' && !Array.isArray(c.models), 'COLONY_MODELS_REQUIRED');
    const models = {};
    for (const [id, wire] of Object.entries(c.models)) {
      requireThat(s.agents.some(a => a.id === id && a.businessUnitId), 'COLONY_INVALID_AGENT');
      requireThat(Object.keys(wire).every(k => ['provider', 'model'].includes(k)), 'COLONY_NO_CREDENTIALS_IN_CONFIG');
      models[id] = { provider: string(wire.provider, 50), model: string(wire.model, 120) };
    }
    const poolBudget = { usd: number(c.poolBudget?.usd ?? 0, 500), tokens: number(c.poolBudget?.tokens ?? 0, 10000000), ms: number(c.poolBudget?.ms ?? 0, 36000000) };
    const accountingMode = c.accountingMode || s.configuration.accountingMode || 'priced';
    requireThat(['priced', 'tokens'].includes(accountingMode), 'COLONY_INVALID_ACCOUNTING_MODE');
    if (c.enabled === true) requireThat((accountingMode === 'tokens' ? ['tokens', 'ms'] : ['usd', 'tokens', 'ms']).every(k => poolBudget[k] > 0), 'COLONY_POOL_BUDGET_REQUIRED');
    s.configuration = { ...s.configuration, revision: s.configuration.revision + 1, models, poolBudget, accountingMode, enabled: c.enabled === true };
    result = s.configuration;
  } else if (c.type === 'task.create') result = proposal(s, c, host);
  else if (c.type === 'attempt.start') {
    const t = taskOf(s, c.taskId);
    requireThat(['queued', 'needs_revision'].includes(t.status) && !t.activeAttempt && !t.spent.unknown, 'COLONY_TASK_NOT_RUNNABLE');
    requireThat(t.accountingMode !== 'tokens' || s.configuration.accountingMode === 'tokens', 'COLONY_TOKEN_MODE_REQUIRES_OWNER_CONFIGURATION');
    const step = nextStep(t); requireThat(step && step !== 'formal' && !(step === 'design' && Processes.isPins(t)), 'COLONY_TECHNICAL_STEP_REQUIRED');
    const reserve = { usd: number(c.reserve && c.reserve.usd, 50), tokens: number(c.reserve && c.reserve.tokens, 1000000), ms: number(c.reserve && c.reserve.ms, 3600000) };
    requireThat(limitKeys(t).every(k => reserve[k] > 0 && t.spent[k] + reserve[k] <= t.budget[k]), 'COLONY_BUDGET_EXHAUSTED');
    if (t.status === 'needs_revision' && step === Processes.producer(t)) {
      requireThat((t.revisionRounds || 0) < (t.maxRevisions ?? 3) && (t.noProgress || 0) < 2, 'COLONY_REVISION_LIMIT');
      t.revisionRounds = (t.revisionRounds || 0) + 1; t.beforeRevision = digest(selections(t));
    }
    if (s.configuration.enabled) {
      const totals = { usd: 0, tokens: 0, ms: 0 };
      for (const other of Object.values(s.tasks)) {
        requireThat(!other.spent.unknown, 'COLONY_POOL_SPEND_UNKNOWN');
        const active = other.attempts.find(a => a.id === other.activeAttempt);
        for (const k of Object.keys(totals)) totals[k] += other.spent[k] + (active ? active.reserve[k] : 0);
      }
      requireThat((s.configuration.accountingMode === 'tokens' ? ['tokens', 'ms'] : ['usd', 'tokens', 'ms']).every(k => totals[k] + reserve[k] <= s.configuration.poolBudget[k]), 'COLONY_POOL_BUDGET_EXHAUSTED');
    }
    const running = Object.values(s.tasks).filter(x => x.activeAttempt).length;
    requireThat(running < 2, 'COLONY_CAPACITY_FULL');
    const attempt = { id: host.id, taskId: t.id, businessUnitId: t.businessUnitId, stepId: step,
      agentId: 'colony_' + t.businessUnitId + '_' + step, roleVersion: t.roleVersions[step],
      runId: c.runId ? string(c.runId, 80) : host.id, context: context(s, t.id, step), reserve,
      state: 'running', startedAt: host.now };
    t.activeAttempt = attempt.id; t.attempts.push(attempt); t.status = 'running'; result = attempt;
  } else if (c.type === 'attempt.finish') {
    const t = taskOf(s, c.taskId), a = t.attempts.find(x => x.id === c.attemptId);
    requireThat(a && a.state === 'running' && t.activeAttempt === a.id, 'COLONY_STALE_ATTEMPT');
    const usage = c.usage || {};
    const known = limitKeys(t).every(k => typeof usage[k] === 'number' && Number.isFinite(usage[k]) && usage[k] >= 0);
    const usdKnown = typeof usage.usd === 'number' && Number.isFinite(usage.usd) && usage.usd >= 0;
    for (const k of ['usd', 'tokens', 'ms']) {
      const total = t.spent[k] + (known ? k === 'usd' && !usdKnown ? 0 : number(usage[k]) : a.reserve[k]);
      t.spent[k] = k === 'usd' ? money(total) : total;
    }
    t.spent.unknown ||= !known;
    t.spent.usdUnknown ||= !usdKnown;
    a.usage = known ? copy(usage) : { unknown: true, reserved: copy(a.reserve) }; a.endedAt = host.now;
    t.activeAttempt = null; a.state = c.ok === true && known ? 'completed' : 'failed';
    if (a.state === 'failed') { t.status = 'blocked'; t.reason = c.error || 'run_failed_or_spend_unknown'; }
    else if (limitKeys(t).some(k => usage[k] > a.reserve[k] || t.spent[k] > t.budget[k])) {
      t.status = 'blocked'; t.reason = 'budget_exhausted';
    } else {
      const output = c.output;
        if (a.stepId === 'research') {
        requireThat(output && Array.isArray(output.facts) && output.facts.length > 0 && output.facts.length <= 40 && Array.isArray(output.uncertainties), 'COLONY_INVALID_FACTS');
        t.facts = { facts: output.facts.map(f => {
          requireThat(t.sources.some(x => x.id === f.sourceId), 'COLONY_UNKNOWN_FACT_SOURCE');
          return { text: string(f.text, 2000), sourceId: f.sourceId };
        }), uncertainties: output.uncertainties.map(x => string(x, 1000)).slice(0, 20) };
        t.status = 'queued';
      } else if (!Processes.isPins(t) && a.stepId !== 'review') {
        if (a.stepId === Processes.producer(t) || a.stepId === 'fixer') {
          const normalized = Processes.normalizeItems(t, output, requireThat, string);
          if (t.items) requireThat(normalized.items.every(i => t.items.some(old => old.id === i.id)) && normalized.items.length === t.items.length, 'COLONY_REVISION_ITEM_ID_CHANGED');
          t.items = normalized.items;
          if (a.stepId === 'fixer') { t.fixerAgentId = a.agentId; t.escalationState = 'final_review'; }
          else t.producerAgentId = a.agentId;
          invalidate(t); t.status = normalized.blockers.length ? 'blocked' : 'queued';
          t.reason = normalized.blockers.length ? 'missing_input: ' + normalized.blockers.join('; ').slice(0, 1000) : null;
          if (t.beforeRevision) { t.noProgress = t.beforeRevision === digest(t.items) ? t.noProgress + 1 : 0; delete t.beforeRevision; }
        } else {
          requireThat(output && Array.isArray(output.notes) && output.notes.length > 0 && output.notes.length <= 30 && Array.isArray(output.blockers), 'COLONY_INVALID_PLANNING_RESULT');
          t.stageOutputs[a.stepId] = { notes: output.notes.map(n => { requireThat(Array.isArray(n.sourceIds) && n.sourceIds.length && n.sourceIds.every(id => t.sources.some(s => s.id === id)), 'COLONY_ITEM_SOURCE'); return { subject: string(n.subject, 500), finding: string(n.finding, 4000), sourceIds: n.sourceIds }; }) };
          t.status = output.blockers.length ? 'blocked' : 'queued'; t.reason = output.blockers.length ? 'missing_input: ' + output.blockers.map(x => string(x, 500)).join('; ').slice(0, 1000) : null;
        }
      } else if (a.stepId === Processes.producer(t) || a.stepId === 'fixer') {
        requireThat(output && Array.isArray(output.pins) && output.pins.length > 0 && output.pins.length <= 6, 'COLONY_INVALID_PINS');
        if (!t.pins && t.inputs?.pinCount) requireThat(output.pins.length === t.inputs.pinCount, 'COLONY_REQUESTED_PIN_COUNT');
        const seen = new Set();
        const oldPins = t.pins || [], oldArtifacts = t.artifacts;
        const updated = output.pins.map(p => {
          const id = string(p.id, 80); requireThat(!seen.has(id), 'COLONY_DUPLICATE_PIN'); seen.add(id);
          requireThat(t.targets.some(x => x.url === p.url) && t.boards.includes(p.board), 'COLONY_PIN_TARGET_BOARD');
          requireThat(Array.isArray(p.sourceIds) && p.sourceIds.length > 0 && p.sourceIds.every(id => t.sources.some(s => s.id === id)), 'COLONY_PIN_SOURCE');
          return { id, title: string(p.title, 100), description: string(p.description, 500), overlay: string(p.overlay, 120), url: p.url, board: p.board, sourceIds: p.sourceIds };
        });
        if (oldPins.length) requireThat(updated.every(p => oldPins.some(old => old.id === p.id)), 'COLONY_REVISION_PIN_ID_CHANGED');
        t.pins = oldPins.length ? oldPins.map(old => updated.find(p => p.id === old.id) || old) : updated;
        if (a.stepId === 'fixer') { t.fixerAgentId = a.agentId; t.escalationState = 'final_review'; }
        else t.producerAgentId = a.agentId;
        if (t.beforeRevision) { t.noProgress = t.beforeRevision === digest(t.pins) ? t.noProgress + 1 : 0; delete t.beforeRevision; }
        t.artifacts = oldArtifacts.filter(art => {
          const old = oldPins.find(p => p.id === art.pinId), current = t.pins.find(p => p.id === art.pinId);
          return old && current && old.overlay === current.overlay;
        });
        t.factReconciliations = [];
        invalidate(t); t.status = 'queued';
      } else if (a.stepId === 'review') {
        requireThat(output && typeof output.passed === 'boolean' && output.dimensions && Array.isArray(output.findings) && output.findings.length <= 6, 'COLONY_INVALID_REVIEW');
        const findings = output.findings.map(f => ({ pinId: string(f.pinId, 80), dimension: string(f.dimension, 40), message: string(f.message, 400) }));
        const reviewSummary = typeof output.summary === 'string' ? output.summary.slice(0, 300) : '';
        t.review = { digest: snapshotDigest(t), passed: output.passed, dimensions: copy(output.dimensions), findings, summary: reviewSummary,
          runId: a.runId, agentId: a.agentId, roleVersion: a.roleVersion, at: host.now };
        t.status = quality(t) ? 'ready_for_approval' : 'needs_revision';
        t.reason = quality(t) ? null : 'quality_not_passed';
        if (t.status === 'ready_for_approval') { t.revisionFindings = []; t.reviewRetries = 0; t.escalationState = 'completed'; }
        t.revisionFindings = findings;
        if (t.status === 'needs_revision' && !findings.length) { t.status = 'blocked'; t.reason = 'review_missing_actionable_findings'; }
        if (t.status === 'needs_revision' && t.escalationState === 'final_review') {
          t.status = 'blocked'; t.reason = 'fixer_final_review_failed';
        } else if (t.status === 'needs_revision' && t.noProgress >= 2) {
          t.status = 'blocked'; t.reason = 'revision_without_progress';
        } else if (t.status === 'needs_revision' && t.revisionRounds >= t.maxRevisions && t.escalationState !== 'needs_fixer') {
          t.status = 'needs_revision'; t.reason = 'fixer_escalation'; t.escalationState = 'needs_fixer';
        }
        if (t.status === 'blocked') s.cases[host.id] = { id: host.id, businessUnitId: t.businessUnitId, taskId: t.id, status: 'open', trigger: t.reason, processVersion: t.processVersion, criteriaVersion: t.criteriaVersion, feedback: findings.map(f => f.message).join('; '), at: host.now };
      }
    }
    result = t;
  } else if (c.type === 'attempt.reject_output') {
    const t = taskOf(s, c.taskId), a = t.attempts.find(x => x.id === c.attemptId);
    requireThat(a && a.state === 'running' && t.activeAttempt === a.id, 'COLONY_STALE_ATTEMPT');
    const usage = c.usage || {}, known = limitKeys(t).every(k => Number.isFinite(usage[k]) && usage[k] >= 0), usdKnown = Number.isFinite(usage.usd) && usage.usd >= 0;
    for (const k of ['usd', 'tokens', 'ms']) t.spent[k] += known ? k === 'usd' && !usdKnown ? 0 : number(usage[k]) : a.reserve[k];
    t.spent.unknown ||= !known; t.spent.usdUnknown ||= !usdKnown; a.usage = known ? copy(usage) : { unknown: true, reserved: copy(a.reserve) };
    a.endedAt = host.now; a.state = 'failed'; a.error = string(c.reason, 80); t.activeAttempt = null;
    const repairable = Processes.REPAIRABLE_OUTPUT_ERRORS.has(a.error) && a.stepId !== 'review' && a.stepId !== 'fixer';
    const canRetryFixer = a.stepId === 'fixer' && (t.fixerOutputRetries || 0) < 1 && Processes.REPAIRABLE_OUTPUT_ERRORS.has(a.error);
    const canRetryReview = a.stepId === 'review' && (t.reviewRetries || 0) < 1;
    const overrun = limitKeys(t).some(k => usage[k] > a.reserve[k] || t.spent[k] > t.budget[k]);
    if (!known || overrun || !repairable && !canRetryReview && !canRetryFixer) { t.status = 'blocked'; t.reason = !known ? 'output_validation_spend_unknown' : overrun ? 'budget_exhausted' : a.error; }
    else {
      t.status = 'queued'; t.reason = 'structured_output_retry';
      if (canRetryReview) t.reviewRetries = (t.reviewRetries || 0) + 1;
      else if (canRetryFixer) { t.fixerOutputRetries = (t.fixerOutputRetries || 0) + 1; t.escalationState = 'needs_fixer'; }
      else { t.status = 'needs_revision'; t.revisionFindings = [{ pinId: '*', dimension: 'format', message: string(c.feedback, 1000) }]; }
    }
    result = t;
  } else if (c.type === 'task.package') {
    const t = taskOf(s, c.taskId); requireThat(t.status === 'queued' && !Processes.isPins(t) && nextStep(t) === 'formal' && c.verified === true, 'COLONY_NOT_FORMAL_STEP');
    requireThat(Array.isArray(c.artifacts) && c.artifacts.length > 0 && c.artifacts.every(a => a.businessUnitId === t.businessUnitId && /^[a-f0-9]{64}$/.test(a.sha256) && ['image/png', 'application/json'].includes(a.mime)), 'COLONY_INVALID_ARTIFACT');
    t.artifacts = copy(c.artifacts); result = t;
  } else if (c.type === 'asset.register') {
    requireThat(c.verified === true && c.rightsConfirmed === true && Object.hasOwn(s.brands, c.businessUnitId) && /^[a-f0-9]{64}$/.test(c.sha256), 'COLONY_ASSET_UNCONFIRMED');
    s.assets ||= {};
    result = { id: host.id, businessUnitId: c.businessUnitId, account: string(c.account, 120), sha256: c.sha256, mime: 'image/png', rightsConfirmed: true, at: host.now };
    s.assets[result.id] = result;
  } else if (c.type === 'task.design') {
    const t = taskOf(s, c.taskId); requireThat(t.status === 'queued' && nextStep(t) === 'design', 'COLONY_NOT_DESIGN_STEP');
    requireThat(Array.isArray(c.artifacts) && c.artifacts.length === t.pins.length, 'COLONY_IMAGES_REQUIRED');
    t.artifacts = c.artifacts.map(a => {
      requireThat(a.businessUnitId === t.businessUnitId && t.pins.some(p => p.id === a.pinId) && /^[a-f0-9]{64}$/.test(a.sha256) && a.mime === 'image/png', 'COLONY_INVALID_IMAGE');
      return { pinId: a.pinId, businessUnitId: a.businessUnitId, sha256: a.sha256, mime: a.mime, version: a.sha256, path: a.sha256 + '.png' };
    });
    requireThat(new Set(t.artifacts.map(a => a.pinId)).size === t.pins.length, 'COLONY_DUPLICATE_IMAGE');
    reconcileRenderedEvidence(t, host);
    invalidate(t); result = t;
  } else if (c.type === 'task.formal') {
    const t = taskOf(s, c.taskId); requireThat(t.status === 'queued' && nextStep(t) === 'formal', 'COLONY_NOT_FORMAL_STEP');
    requireThat(c.verified === true && c.digest === snapshotDigest(t), 'COLONY_FORMAL_FAILED');
    t.formal = { passed: true, digest: c.digest, at: host.now, criteriaVersion: t.criteriaVersion }; result = t;
  } else if (c.type === 'task.technical_revision') {
    const t = taskOf(s, c.taskId); requireThat(!t.activeAttempt && t.status === 'queued', 'COLONY_TASK_BUSY');
    requireThat(t.pins.some(p => p.id === c.pinId), 'COLONY_INVALID_PIN');
    t.review = { passed: false, digest: snapshotDigest(t), findings: [{ pinId: c.pinId, dimension: 'layout', message: string(c.reason, 500) }], dimensions: {}, source: 'deterministic-check' };
    t.status = 'needs_revision'; t.reason = 'technical_revision_required'; result = t;
  } else if (c.type === 'task.block') {
    const t = taskOf(s, c.taskId); requireThat(!t.activeAttempt, 'COLONY_TASK_BUSY');
    t.status = 'blocked'; t.reason = string(c.reason, 200); result = t;
  } else if (c.type === 'approval.decide') {
    const t = taskOf(s, c.taskId);
    requireThat(t.testOnly !== true, 'COLONY_TECHNICAL_TEST_NOT_APPROVABLE');
    requireThat(t.status === 'ready_for_approval' && quality(t) && c.digest === snapshotDigest(t), 'COLONY_APPROVAL_STALE_OR_UNCHECKED');
    requireThat(['approve', 'reject'].includes(c.decision), 'COLONY_INVALID_DECISION');
    requireThat(Array.isArray(c.pinIds) && c.pinIds.length > 0 && c.pinIds.every(id => selections(t).some(p => p.id === id)), 'COLONY_INVALID_SELECTION');
    const allowed = s.processes[t.processId].actions.length ? s.processes[t.processId].actions : ['accept'];
    requireThat(Array.isArray(c.actions) && c.actions.length > 0 && c.actions.every(x => allowed.includes(x)), 'COLONY_INVALID_ACTION');
    const approval = { id: host.id, taskId: t.id, businessUnitId: t.businessUnitId, account: t.account, schedule: t.schedule, audience: t.audience,
      digest: c.digest, pinIds: [...new Set(c.pinIds)], actions: [...new Set(c.actions)], decision: c.decision, actor: 'owner', at: host.now, revoked: false };
    s.approvals[approval.id] = approval; t.activeApproval = approval.id;
    t.status = c.decision === 'approve' ? 'approved' : 'needs_revision';
    const feedback = { id: host.id, businessUnitId: t.businessUnitId, taskId: t.id, digest: c.digest,
      kind: 'human', decision: c.decision, text: typeof c.feedback === 'string' ? c.feedback.slice(0, 1500) : '', at: host.now };
    s.feedback.push(feedback);
    if (c.decision === 'reject') {
      requireThat(feedback.text.length > 0, 'COLONY_REJECTION_REASON_REQUIRED');
      t.review.findings = [{ pinId: '*', dimension: 'human', message: feedback.text }];
      t.revisionFindings = copy(t.review.findings);
      s.cases[host.id] = { id: host.id, taskId: t.id, businessUnitId: t.businessUnitId, digest: c.digest, status: 'open',
        trigger: 'human_rejection_after_review', processVersion: t.processVersion, criteriaVersion: t.criteriaVersion, feedback: feedback.text, at: host.now };
    }
    result = approval;
  } else if (c.type === 'approval.revoke') {
    const a = s.approvals[c.approvalId]; requireThat(a, 'COLONY_APPROVAL_NOT_FOUND'); a.revoked = true;
    const t = taskOf(s, a.taskId); if (t.activeApproval === a.id) { t.activeApproval = null; t.status = 'ready_for_approval'; } result = a;
  } else if (c.type === 'task.change') {
    const t = taskOf(s, c.taskId); requireThat(!t.activeAttempt, 'COLONY_TASK_BUSY');
    requireThat(c.patch && Object.keys(c.patch).length > 0 && Object.keys(c.patch).every(k => ['account', 'schedule', 'audience', 'goal', 'sources', 'inputs'].includes(k)), 'COLONY_INVALID_PATCH');
    for (const [k, v] of Object.entries(c.patch)) t[k] = k === 'sources' ? sourceRows(v, t.businessUnitId) : k === 'inputs' ? Processes.requiredInputs(t.processId, v, requireThat, t.testOnly === true, t.processContract) : string(v, 2000);
    validateAssets(s, t);
    if (t.inputs?.metrics) requireThat(t.inputs.metrics.every(r => t.sources.some(src => src.id === r.sourceId)), 'COLONY_METRIC_SOURCE_UNKNOWN');
    invalidate(t); t.status = 'queued'; if (['goal', 'sources', 'inputs'].some(k => Object.hasOwn(c.patch, k))) { t.facts = null; t.pins = null; t.items = null; t.stageOutputs = {}; t.artifacts = []; t.factReconciliations = []; t.revisionRounds = 0; t.noProgress = 0; t.revisionFindings = []; }
    result = t;
  } else if (c.type === 'action.prepare') {
    const t = taskOf(s, c.taskId), a = s.approvals[c.approvalId];
    requireThat(t.testOnly !== true, 'COLONY_TECHNICAL_TEST_NOT_APPROVABLE');
    requireThat(a && a.taskId === t.id && a.decision === 'approve' && !a.revoked && a.digest === snapshotDigest(t) && quality(t), 'COLONY_ACTION_NOT_APPROVED');
    requireThat(t.activeApproval === a.id && a.actions.includes(c.action) && c.account === a.account && c.schedule === a.schedule && c.audience === a.audience, 'COLONY_ACTION_SCOPE_MISMATCH');
    requireThat(Array.isArray(c.pinIds) && c.pinIds.length > 0 && c.pinIds.every(id => a.pinIds.includes(id)), 'COLONY_ACTION_SELECTION');
    const key = digest({ brand: t.businessUnitId, account: a.account, schedule: a.schedule, audience: a.audience,
      digest: a.digest, action: c.action, pins: [...new Set(c.pinIds)].sort() });
    // A publication permission never implies a second delivery of the same object.
    const overlapping = Object.values(s.actions).find(x => x.businessUnitId === t.businessUnitId && x.account === a.account && x.digest === a.digest && x.action === c.action && x.pinIds.some(id => c.pinIds.includes(id)));
    requireThat(!overlapping, 'COLONY_ACTION_ALREADY_RECORDED_OR_UNCERTAIN');
    const action = { id: key, taskId: t.id, approvalId: a.id, businessUnitId: t.businessUnitId, account: a.account, schedule: a.schedule, audience: a.audience,
      digest: a.digest, pinIds: [...new Set(c.pinIds)], action: c.action, state: 'prepared', at: host.now, mode: 'manual' };
    s.actions[key] = action; result = action;
  } else if (c.type === 'action.uncertain' || c.type === 'action.confirm') {
    const a = s.actions[c.actionId]; requireThat(a && ['prepared', 'uncertain'].includes(a.state), 'COLONY_ACTION_NOT_PENDING');
    if (c.type === 'action.uncertain') { a.state = 'uncertain'; a.reason = string(c.reason, 500); }
    else { a.state = 'confirmed'; a.evidence = string(c.evidence, 2000); a.confirmedBy = 'owner'; a.confirmedAt = host.now; }
    result = a;
  } else if (c.type === 'recovery.scan') {
    for (const t of Object.values(s.tasks)) if (t.activeAttempt && !(c.liveAttempts || []).includes(t.activeAttempt)) {
      const a = t.attempts.find(x => x.id === t.activeAttempt);
      a.state = 'interrupted'; a.endedAt = host.now;
      t.spent.unknown = true; t.status = 'blocked'; t.reason = 'interrupted_run_reconcile_usage'; t.activeAttempt = null;
    }
    result = { scanned: true };
  } else if (c.type === 'recovery.resolve') {
    const t = taskOf(s, c.taskId); requireThat(t.status === 'blocked' && t.spent.unknown, 'COLONY_NO_INTERRUPTION');
    const a = [...t.attempts].reverse().find(x => (x.state === 'interrupted' && !x.resolution) || x.usage?.unknown);
    requireThat(a, 'COLONY_NO_UNRESOLVED_ATTEMPT');
    requireThat(c.usage && c.evidence, 'COLONY_RECOVERY_EVIDENCE_REQUIRED');
    for (const k of ['usd', 'tokens', 'ms']) {
      const total = t.spent[k] + (k === 'usd' && t.accountingMode === 'tokens' && c.usage[k] === null ? 0 : number(c.usage[k])) - (a.usage?.unknown ? a.reserve[k] : 0);
      t.spent[k] = k === 'usd' ? money(total) : total;
    }
    a.usage = copy(c.usage); a.resolution = string(c.evidence); a.resolvedBy = 'owner';
    t.spent.unknown = t.attempts.some(x => (x.state === 'interrupted' && !x.resolution) || x.usage?.unknown);
    t.status = t.spent.unknown ? 'blocked' : 'queued'; t.reason = t.spent.unknown ? 'usage_reconciliation_pending' : null; result = t;
  } else if (c.type === 'metric.record') {
    requireThat(Object.hasOwn(BRANDS, c.businessUnitId), 'COLONY_INVALID_BRAND');
    const m = { id: host.id, businessUnitId: c.businessUnitId, account: string(c.account, 120), metric: string(c.metric, 80), unit: string(c.unit, 40),
      period: string(c.period, 100), level: string(c.level, 80), source: string(c.source, 500), value: c.value === null ? null : number(c.value),
      quality: string(c.quality, 500), at: host.now };
    requireThat(!s.metrics.some(x => digest({ ...x, id: null, at: null }) === digest({ ...m, id: null, at: null })), 'COLONY_DUPLICATE_METRIC');
    s.metrics.push(m); result = m;
  } else fail('COLONY_UNKNOWN_COMMAND');
  s.revision++;
  s.events.push({ revision: s.revision, type: c.type, taskId: c.taskId || (c.type === 'task.create' ? host.id : null), at: host.now });
  // This is the durable audit, not an evicting UI history. No feedback/approval is pruned.
  return { state: s, result: copy(result) };
}
module.exports = { initial, validate, reduce, context, nextStep, snapshotDigest, quality, digest, fail, selections, dimensions, limitKeys, reconcileRenderedEvidence };
