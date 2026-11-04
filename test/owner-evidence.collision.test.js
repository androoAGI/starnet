'use strict';
/* Real boot-known collisions and explicit demotion must never become owner activity provenance. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
let Store = require('../sidecar/transcriptstore.js');
const History = require('../sidecar/transcript-history.js'), Learning = require('../sidecar/trusted-learning.js');
const { sidecarFunctionSource } = require('./helpers/source.js');
const contextpack = require('../sidecar/contextpack.js'), CommanderContext = require('../sidecar/commander-context.js');
if (process.env.TURN_OWNER_COLLISION_CONTROL) {
  const load = (file, saved, view) => {
    const filename = require.resolve('../sidecar/' + file), mod = new Module(filename, module);
    mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    if (view) { const original = mod.require.bind(mod); mod.require = id => id === './turn-view.js' ? view : original(id); }
    mod._compile(fs.readFileSync(path.join(process.env.TURN_OWNER_COLLISION_CONTROL, saved), 'utf8'), filename); return mod.exports;
  };
  const view = load('turn-view.js', 'turn-identity-c6-view-pre-collision.js.txt');
  Store = load('transcriptstore.js', 'turn-identity-c6-store-pre-collision.js.txt', view);
}
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'owner-evidence-collision-'));
if (path.dirname(path.resolve(root)) !== temp) throw new Error('fixture directory escaped its temporary parent');
const opened = [], records = [], now = 1000;
const open = () => { const io = History.makeSegmentedTranscriptIo({ fs, path, root, segmentBytes: 65536, schedule() {}, onWarning() {} }); opened.push(io); return io; };
try {
  const seed = open();
  function row(rowId, sourceRunId, role, kind, content, extra) {
    records.push({ runId: sourceRunId, agentId: 'agent', streamId: 's', internal: false, ownerDirective: true, ts: now });
    seed.appendDurable(Object.assign({ rowId, sourceRunId, streamId: 's', agentId: 'agent', role, kind, content, ts: now, taintKnown: true }, extra));
  }
  row(7, 'collision-user-a', 'user', 'turn', 'COLLIDED_OWNER_SENTINEL first');
  row(7, 'collision-user-b', 'user', 'turn', 'COLLIDED_OWNER_SENTINEL second');
  row(8, 'collision-steer-a', 'system', 'steer', 'COLLIDED_STEER_SENTINEL first');
  row(8, 'collision-steer-b', 'system', 'steer', 'COLLIDED_STEER_SENTINEL second');
  row(9, 'demoted-user', 'user', 'turn', 'DEMOTED_OWNER_SENTINEL', { idFrom: 'collision' });
  row(10, 'demoted-steer', 'system', 'steer', 'DEMOTED_STEER_SENTINEL', { idFrom: 'collision' });
  row(11, 'valid-owner', 'user', 'turn', 'Please keep the verified reconnect request');
  seed.close();
  const io = open();
  A.ok(io.isCollided(7) && io.isCollided(8), 'real restart audit positively disavows both duplicate IDs');
  A.ok(!io.isCollided(9) && !io.isCollided(10) && !io.isCollided(11), 'explicit demotion and valid control are distinct from boot range collisions');
  const store = Store.makeTranscriptStore({ io, clock: { now: () => now }, runOf: id => records.find(run => run.runId === id), quotedMaterial: Learning.quotedMaterial });
  const owned = store.view('owner-evidence', null, { limit: 400 });
  A.eq(owned.map(item => item.rowId), [11], 'RAM owner authority rejects collided and explicitly demoted user AND steer rows');
  A.eq([...store.ownerProof([7, 8, 9, 10, 11]).keys()], [11], 'strict owner proof also rejects explicit demotion');
  A.eq(store.view('display', 's').length, 7, 'owner authority repair does not remove ordinary display evidence');
  const sandbox = { Map, Set, Date: { now: () => now }, transcriptStore: store, runView: (name, r) => r, runStore: { all: () => records }, taskBriefStore: { list: () => [] },
    TrustedLearning: Learning, contextpack, nightshiftRecentRuns: () => records, commanderGoals: { get: () => null },
    autonomyLedger: { list: () => [] }, nightshiftBeliefMap: () => ({}), Recommendation: { preferenceTallies: () => ({}) },
    nightshiftPreferenceWeights: () => ({}), stationTrackRecordLines: () => [], threadsStore: { openThreads: () => [] },
    personalizationStore: { read: () => ({ enabled: false }) }, commanderDossier: { get: () => '' }, redact: text => text,
    failNote(tag, error) { throw error; } };
  vm.createContext(sandbox);
  for (const name of ['evidenceRows', 'nightshiftContextPack', 'commanderEvidenceInputs']) vm.runInContext(sidecarFunctionSource(name), sandbox);
  const evidence = sandbox.evidenceRows({});
  A.eq(evidence.ownerRecent.map(item => item.rowId), [11], 'actual host recency snapshot cannot promote a collided key');
  const pack = sandbox.nightshiftContextPack(evidence);
  A.eq(pack.activity.map(entry => entry.src.rowId), [11], 'actual activity provenance contains only the valid control');
  A.ok(!/COLLIDED_|DEMOTED_/.test(pack.activityLines.join('\n')), 'disavowed owner wording is absent from the activity pool');
  const rendered = CommanderContext.compose(sandbox.commanderEvidenceInputs({}));
  const activity = rendered.split('\n').filter(line => line.includes('RECENT ACTIVITY:'));
  A.ok(activity.length > 0 && activity.some(line => line.includes('verified reconnect')), 'actual renderer keeps positive proven activity');
  A.ok(!/COLLIDED_|DEMOTED_/.test(activity.join('\n')), 'actual RECENT ACTIVITY cannot acquire disavowed provenance from RAM');
} finally {
  for (const io of opened) io.close();
  if (path.dirname(path.resolve(root)) !== temp) throw new Error('refusing fixture removal outside temporary parent');
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('owner-evidence.collision');
