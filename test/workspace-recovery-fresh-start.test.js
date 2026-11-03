/* Issue #101: an explicit fresh start must survive automatic legacy recovery. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const Recovery = require('../sidecar/workspace-recovery.js');
const Lineage = require('../sidecar/workspace-lineage.js');
const StationRecord = require('../sidecar/station-record.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-fresh-'));
let seq = 0;
function write(base, rel, value) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(marker) {
  const home = path.join(root, String(++seq));
  const current = path.join(home, 'active', 'workspaces');
  const legacy = path.join(home, 'StarNet', 'workspaces');
  fs.mkdirSync(current, { recursive: true });
  write(legacy, 'agent.save.json', { version: 1, agentId: 'agent', updatedAt: 1000, doc: {
    schema: 'starnet.save', version: 5, updatedAt: 1000,
    agent: { id: 'agent', name: 'OLD-STATION' }, station: { rooms: [{ id: 'old' }], props: [] }, workstreams: []
  } });
  write(legacy, '.fresh-start.json', { version: 1, acknowledgedRoots: [] });
  if (marker !== undefined) write(current, '.fresh-start.json', typeof marker === 'function' ? marker(legacy) : marker);
  const opts = { fs, path, home, platform: 'win32', workspaceRoot: current, candidateRoots: [legacy],
    auto: true, scratchRoots: [], now: () => 2000 };
  return { home, current, legacy, opts };
}
function blocked(f, code) {
  const marker = fs.readFileSync(path.join(f.current, '.fresh-start.json'));
  const source = fs.readFileSync(path.join(f.legacy, 'agent.save.json'));
  const r = Recovery.applyPendingRecovery(f.opts);
  A.eq(r.applied, false, 'automatic recovery does not import an explicitly rejected old station');
  A.eq(r.code, code, 'automatic skip reports its actual authority');
  A.eq(fs.existsSync(path.join(f.current, 'agent.save.json')), false, 'erased generation remains empty');
  A.ok(fs.readFileSync(path.join(f.current, '.fresh-start.json')).equals(marker), 'active marker stays byte-exact');
  A.ok(fs.readFileSync(path.join(f.legacy, 'agent.save.json')).equals(source), 'legacy station stays byte-exact');
  A.eq(fs.existsSync(Recovery._internals.requestFile(f.current, path)), false, 'no recovery request is minted');
  return r;
}
try {
  // every real marker carries its reset time (`at`: the native door's epoch-ms text, the old sidecar door's ISO time)
  const erased = fixture(legacy => ({ version: 1, erased: true, at: '1500', acknowledgedRoots: [legacy] }));
  blocked(erased, 'AUTO_RECOVERY_ERASED');
  blocked(erased, 'AUTO_RECOVERY_ERASED');
  A.eq(Lineage.inspectWorkspaceLineage(erased.opts).onboardingAllowed, true, 'erase still permits clean onboarding');

  // Erase acknowledges the action, even if an additional old root appears later.
  blocked(fixture({ version: 1, erased: true, at: '1500', acknowledgedRoots: [] }), 'AUTO_RECOVERY_ERASED');

  // Ordinary START FRESH only excludes the acknowledged roots, with Windows case-insensitive equality.
  blocked(fixture(legacy => ({ version: 1, erased: false, at: '1500', acknowledgedRoots: [legacy.toUpperCase()] })),
    'AUTO_RECOVERY_ACKNOWLEDGED');

  const unrelated = fixture(legacy => ({ version: 1, at: new Date(1500).toISOString(), acknowledgedRoots: [legacy + '-other'] }));
  A.eq(Recovery.applyPendingRecovery(unrelated.opts).applied, true, 'an unrelated root is not prefix-matched as acknowledged');
  A.eq(Recovery.applyPendingRecovery(fixture(undefined).opts).applied, true, 'ordinary missing-station auto recovery still works');

  // A marker with no reset time is torn (station-record.js, the one parser): its time is unknown, so it never authorizes an
  // automatic import — and an erase it names still blocks as an erase (a torn marker never weakens one).
  blocked(fixture(legacy => ({ version: 1, acknowledgedRoots: [legacy + '-other'] })), 'AUTO_RECOVERY_FRESH_MARKER_UNREADABLE');
  blocked(fixture({ version: 1, erased: true, acknowledgedRoots: [] }), 'AUTO_RECOVERY_ERASED');

  // Candidate inspection and explicit operator recovery must retain the old station as an available choice.
  const explicit = fixture(legacy => ({ version: 1, erased: true, at: '1500', acknowledgedRoots: [legacy] }));
  const inspection = Recovery.inspectCandidates(explicit.opts);
  A.eq(inspection.recoverableCount, 1, 'the marker never hides a recoverable source from explicit inspection');
  const currentMarker = fs.readFileSync(path.join(explicit.current, '.fresh-start.json'));
  Recovery.requestRecovery({ ...explicit.opts, inspection, candidateId: inspection.automaticCandidateId });
  const restored = Recovery.applyPendingRecovery(explicit.opts);
  A.eq(restored.applied, true, 'an explicit restore can supersede the erase choice');
  A.eq(restored.sourcePreserved, true, 'explicit restore retains the original source');
  A.eq(restored.rollbackRetained, true, 'explicit restore retains the erased generation too');
  const rollback = fs.readdirSync(path.dirname(explicit.current)).find(n => n.startsWith('workspaces.recovery-rollback-'));
  A.ok(rollback && fs.readFileSync(path.join(path.dirname(explicit.current), rollback, '.fresh-start.json')).equals(currentMarker),
    'the superseded erase marker is preserved in rollback');
  // the lifecycle files never travel with the copy (gh#101: the source's own marker used to replace the live choice); the
  // restored generation starts with its own record instead: active, the erase authority kept, the source acknowledged
  A.eq(fs.existsSync(path.join(explicit.current, '.fresh-start.json')), false, 'the source workspace\'s own marker is not copied into the restored generation');
  const restoredRecord = StationRecord.read({ fs, path, platform: 'win32', now: () => 2000, workspaceRoot: explicit.current });
  A.eq([restoredRecord.persisted, restoredRecord.state, restoredRecord.record.by, restoredRecord.resetAt()], [true, 'active', 'recovery', null], 'the restored generation records an active, recovered station whose saves are never refused as pre-reset');
  A.eq([restoredRecord.autoImportBlock(), restoredRecord.acknowledges(explicit.legacy)], ['erase-authority', true], 'and keeps the erase authority, with the source root acknowledged');
  A.eq(Recovery.applyPendingRecovery(explicit.opts).applied, false, 'next boot never restores over a live station');

  for (const malformed of ['{invalid', { version: 2, acknowledgedRoots: [] }, { version: 1, acknowledgedRoots: [null] }, { version: 1, erased: 'true', acknowledgedRoots: [] }]) {
    blocked(fixture(malformed), 'AUTO_RECOVERY_FRESH_MARKER_UNREADABLE');
  }
  const denied = fixture({ version: 1, erased: true, at: '1500', acknowledgedRoots: [] });
  const realRead = fs.readFileSync;
  const markerPath = path.join(denied.current, '.fresh-start.json');
  const readFs = Object.create(fs);
  readFs.readFileSync = function (p, ...args) {
    if (p === markerPath) { const e = new Error('fixture permission denied'); e.code = 'EACCES'; throw e; }
    return realRead(p, ...args);
  };
  const deniedResult = Recovery.applyPendingRecovery({ ...denied.opts, fs: readFs });
  A.eq(deniedResult.code, 'AUTO_RECOVERY_FRESH_MARKER_UNREADABLE', 'an unreadable choice fails automatic recovery closed');
  A.eq(fs.existsSync(path.join(denied.current, 'agent.save.json')), false, 'an unreadable marker never authorizes importing a station');
  A.report('workspace-recovery-fresh-start.test');
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starnet-recovery-fresh-')) {
    throw new Error('refusing cleanup outside the fixture root');
  }
  fs.rmSync(root, { recursive: true, force: true });
}
