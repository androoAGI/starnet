'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeInstallation, FILES } = require('../sidecar/colony/installation.js');
const C = require('../sidecar/colony/core.js');
const { prepare } = require('../lab/colony-authoring.cjs');
const WM = require('../frontend/app/worldmodel.js');
const { create } = require('../lab/workflow.cjs');
function fixture(t) {
  const root = fs.mkdtempSync('/tmp/opencode/colony-installation-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const st = WM.create(WM.starterDoc()), spec = require('../lab/fixtures/lifestruct.json');
  create(st, spec, new Set(spec.steps.map(s => s.agentId)));
  const doc = { schema: 'starnet.save', version: 6, _saveRevision: 4, updatedAt: 100,
    agent: { id: 'agent', name: 'Lifestruct Analyst', provider: 'custom' }, agents: [{ id: 'life_content' }, { id: 'life_review' }],
    station: st.serialize(), workstreams: [{ id: 'old-chat', messages: ['must survive'] }] };
  fs.writeFileSync(path.join(root, 'agent.save.json'), JSON.stringify({ version: 1, doc, unknownOuterField: 'keep' }));
  fs.writeFileSync(path.join(root, 'agent.roster.json'), JSON.stringify({ version: 1, agents: [{ agentId: 'agent', name: 'Original', model: 'keep/model', custom: 'keep' }] }));
  const deps = { fs, path, root, now: () => 1000, newId: () => 'installation-one' };
  const state = C.initial();
  const bind = (s, installation) => C.reduce(s, { type: 'installation.bind', expectedRevision: s.revision, installation }, { now: 1000, id: 'install-bind' }).state;
  const install = makeInstallation(deps), p = install.preview(state, prepare);
  const args = { expectedSaveRevision: p.nativeSaveRevision, expectedStateRevision: state.revision, previewDigest: p.previewDigest };
  return { root, deps, state, bind, install, args, doc };
}
test('native installation commits save/roster/routing/core together, fences stale clients and preserves profiles/history', t => {
  const r = fixture(t), original = JSON.parse(fs.readFileSync(path.join(r.root, 'agent.roster.json'))).agents[0];
  const result = r.install.install(r.state, r.args, prepare, r.bind);
  assert.equal(result.installed, true); assert.equal(Object.keys(result.mappings).length, 13);
  const saved = JSON.parse(fs.readFileSync(path.join(r.root, 'agent.save.json')));
  assert.equal(saved.unknownOuterField, 'keep'); assert.deepEqual(saved.doc.workstreams, r.doc.workstreams);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.root, 'agent.roster.json'))).agents[0], original);
  assert.equal(r.install.acceptsSave(r.doc), false); assert.equal(r.install.acceptsSave(saved.doc), true);
  assert.equal(r.install.acceptsRoster({ agents: [{ agentId: 'agent' }] }), false);
  assert.equal(r.install.acceptsPlan({ agentOfDock: {} }), false);
  assert.equal(r.install.acceptsPlan(JSON.parse(fs.readFileSync(path.join(r.root, 'routing.plan.json')))), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, 'colony/state.json'))).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, 'colony/backups/installation-one/agent.save.json'), 'utf8')).unknownOuterField, 'keep', 'the private backup holds the exact pre-install bytes');
});
test('stale preview has no side effects', t => {
  const r = fixture(t);
  assert.throws(() => r.install.install(r.state, { ...r.args, expectedSaveRevision: 3 }, prepare, r.bind), /REVISION_CONFLICT/);
  assert.equal(fs.existsSync(path.join(r.root, 'colony/installation.json')), false);
});
test('crash between representations: every mutation fenced; boot safely completes the exact durable intent', t => {
  const r = fixture(t); let fail = true;
  const faultyFs = Object.create(fs);
  faultyFs.renameSync = (from, to) => { if (fail && to === path.join(r.root, 'agent.roster.json')) { fail = false; throw new Error('injected power loss'); } return fs.renameSync(from, to); };
  const installed = makeInstallation({ ...r.deps, fs: faultyFs });
  assert.throws(() => installed.install(r.state, r.args, prepare, r.bind), /power loss/);
  assert.equal(installed.status().state, 'pending'); assert.throws(() => installed.assertReady(), /PENDING/);
  const restarted = makeInstallation(r.deps); assert.equal(restarted.recover().changed, true);
  assert.equal(restarted.status().state, 'committed'); assert.doesNotThrow(() => restarted.assertReady());
  for (const name of FILES) assert.ok(JSON.parse(fs.readFileSync(path.join(r.root, name))));
});
test('rollback refuses newer user work', t => {
  const r = fixture(t); r.install.install(r.state, r.args, prepare, r.bind);
  const file = path.join(r.root, 'agent.save.json'), updated = JSON.parse(fs.readFileSync(file));
  updated.doc.workstreams.push({ id: 'new-user-chat' }); fs.writeFileSync(file, JSON.stringify(updated));
  assert.throws(() => r.install.rollback('installation-one'), /NEWER_WORK/);
  assert.equal(JSON.parse(fs.readFileSync(file)).doc.workstreams.length, 2);
});
test('rollback without intervening work restores all exact original representations', t => {
  const r = fixture(t), original = FILES.map(name => fs.existsSync(path.join(r.root, name)) ? fs.readFileSync(path.join(r.root, name), 'utf8') : null);
  r.install.install(r.state, r.args, prepare, r.bind); r.install.rollback('installation-one');
  assert.equal(r.install.status().state, 'rolled_back');
  for (const [i, name] of FILES.entries()) assert.equal(fs.existsSync(path.join(r.root, name)) ? fs.readFileSync(path.join(r.root, name), 'utf8') : null, original[i]);
});
test('layout adoption requires matching floor and idle state; digest uses same canonical form as backend', async () => {
  const L = require('../frontend/app/colony-layout.js'), v = { b: [3, { a: 1 }], a: 'x' };
  assert.equal(await L.digest(v), C.digest(v));
  assert.equal(L.canAdopt({ beforeDigest: 'before', targetDigest: 'after', localDigest: 'locally-edited', targetCommitId: 'b', commitId: 'a', busy: false }), false);
  assert.equal(L.canAdopt({ beforeDigest: 'before', targetDigest: 'after', localDigest: 'before', targetCommitId: 'b', commitId: 'a', busy: true }), false);
  assert.equal(L.canAdopt({ beforeDigest: 'before', targetDigest: 'after', localDigest: 'before', targetCommitId: 'b', commitId: 'a', busy: false }), true);
});
