'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const S = require('../frontend/app/specialties.js');
const root = path.join(__dirname, '..');

const spec = S.saveCustom({ name: 'Preset context test', purpose: 'Audit', manual: 'Cite evidence', context: 'Project A\nNo approval authority', kit: ['cabinet'], skills: ['code-review'], reasoningEffort: 'high' });
assert.equal(S.get(spec.id).context, spec.context);
assert.equal(S.compose(spec).context, spec.context);
assert.equal(Object.hasOwn(S.compose({ purpose: 'Legacy', manual: 'Keep context' }), 'context'), false);
assert.equal(Object.hasOwn(S.compose({ context: '' }), 'context'), false);
const draft = S.fromAgent({ specialtyId: spec.id, docs: { context: 'Project B', purpose: 'Review', manual: 'Rules' }, skills: ['code-review'], reasoningEffort: 'high' });
assert.equal(draft.context, 'Project B');
assert.deepEqual(draft.skills, ['code-review']);
assert.deepEqual(draft.kit, ['cabinet']);
assert.equal(draft.reasoningEffort, 'high');

// Execute the real patch path against two agents: a selected specialist must be
// updated without changing the focused lead or granting authority.
const app = fs.readFileSync(path.join(root, 'frontend/app/app.js'), 'utf8');
const start = app.indexOf('  function applyAgentConfig(');
const end = app.indexOf('  // P1-6 per-agent MODEL/PROVIDER', start);
const lead = { id: 'lead', docs: { context: 'Lead context' }, role: 'orchestrator', skills: ['work-splitting'] };
const worker = { id: 'worker', docs: {}, role: 'specialist', skills: [], approvalMode: 'ask', executionProfile: 'trusted-project', model: 'existing-model' };
let pushed = 0, persisted = 0;
const sandbox = { agent: lead, agents: new Map([['lead', lead], ['worker', worker]]), agentDocs: a => a.docs, composeSystemPrompt: a => JSON.stringify(a.docs), recomposeOrchestrators() {}, pushRoster() { pushed++; }, persist() { persisted++; } };
vm.runInNewContext(app.slice(start, end) + '\nthis.apply = applyAgentConfig;', sandbox);
sandbox.apply({ ...S.compose(spec), skills: ['code-review', 'code-review', ' source-triangulation '], reasoningEffort: 'high' }, 'worker');
assert.equal(worker.docs.context, spec.context);
assert.deepEqual(Array.from(worker.skills), ['code-review', 'source-triangulation']);
assert.equal(worker.approvalMode, 'ask');
assert.equal(worker.executionProfile, 'trusted-project');
assert.equal(worker.model, 'existing-model');
assert.equal(lead.docs.context, 'Lead context');
assert.deepEqual(lead.skills, ['work-splitting']);
assert.equal(pushed, 1);
assert.equal(persisted, 1);
S.removeCustom(spec.id);
console.log('specialist-preset-context: PASS (context round-trip, legacy preservation, target isolation, authority preservation)');
