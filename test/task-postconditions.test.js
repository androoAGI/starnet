'use strict';
const A = require('./_assert.js');
const { normalizeContract, assessPostconditions } = require('../sidecar/task-postconditions.js');
const { makeCompletionEvidence } = require('../sidecar/completion-evidence.js');

const artifact = { requirements: [{ id: 'file', type: 'artifact_exists', path: 'out/result.txt' }] };

async function main() {
  A.eq(normalizeContract(null), { contract: null, errors: [] }, 'absent contract stays absent');
  A.ok(normalizeContract({ requirements: [{ type: 'artifact_exists', path: '../escape' }] }).errors.length === 1, 'parent traversal is rejected');
  A.ok(normalizeContract({ requirements: [{ type: 'artifact_exists', path: 'C:\\escape.txt' }] }).errors.length === 1, 'absolute Windows path is rejected');
  // (run-paths review) a drive-relative name is not relative to the run's folder: it was accepted, then routed to path trust
  for (const p of ['C:foo.txt', 'c:Users/me/x', 'D:report.md']) {
    A.eq(normalizeContract({ requirements: [{ type: 'artifact_exists', path: p }] }).errors, ['pc-1: absolute paths are not allowed'], 'drive-relative ' + JSON.stringify(p) + ' is rejected');
  }
  A.eq(normalizeContract({ requirements: [{ type: 'artifact_exists', path: 'notes/a:b.txt' }] }).errors, [], 'a colon later in a relative name is still a relative name');
  A.ok(normalizeContract({ requirements: [{ id: 'x', type: 'artifact_exists', path: 'a' }, { id: 'x', type: 'artifact_exists', path: 'b' }] }).errors.length === 1, 'duplicate requirement ids are rejected');

  let r = await assessPostconditions({
    contract: artifact, reason: 'done', effectVerdict: 'mechanically_verified', artifacts: [{ kind: 'file', path: 'out/result.txt' }],
    readArtifact: async () => ({ exists: true, isFile: true })
  });
  A.eq(r.completionVerdict, 'completed_verified', 'exact touched artifact plus settled effect earns verified completion');
  A.eq(r.checks[0].status, 'passed', 'artifact check records a mechanical pass');

  r = await assessPostconditions({ contract: artifact, reason: 'done', effectVerdict: 'no_observed_effects', artifacts: [], readArtifact: async () => ({ exists: true, isFile: true }) });
  A.eq(r.completionVerdict, 'incomplete', 'pre-existing artifact cannot prove this run produced it');
  A.eq(r.checks[0].code, 'artifact_not_produced_by_run', 'failure names the missing run provenance');

  r = await assessPostconditions({
    contract: { requirements: [{ type: 'artifact_contains', path: 'out/result.txt', text: 'READY' }] },
    reason: 'done', effectVerdict: 'mechanically_verified', artifacts: [{ kind: 'file', path: 'out/result.txt' }],
    readArtifact: async () => ({ exists: true, isFile: true, contains: false })
  });
  A.eq(r.completionVerdict, 'incomplete', 'missing requested content fails completion');
  A.eq(r.checks[0].code, 'artifact_text_missing', 'content mismatch is explicit');

  const digest = 'a'.repeat(64);
  r = await assessPostconditions({
    contract: { requirements: [{ type: 'artifact_sha256', path: 'out/result.txt', sha256: digest }] },
    reason: 'done', effectVerdict: 'mechanically_verified', artifacts: [{ kind: 'file', path: 'out/result.txt' }],
    readArtifact: async () => ({ exists: true, isFile: true, sha256: 'b'.repeat(64) })
  });
  A.eq(r.completionVerdict, 'incomplete', 'digest mismatch fails completion');

  const verifyContract = { requirements: [{ type: 'verification_passed', command: 'npm test -- --runInBand' }] };
  r = await assessPostconditions({
    contract: verifyContract, reason: 'done', effectVerdict: 'no_observed_effects', artifacts: [],
    evidence: [{ kind: 'deterministic_check', strength: 'mechanical', target: 'npm   test -- --runInBand' }]
  });
  A.eq(r.completionVerdict, 'completed_verified', 'exact successful verification command proves its typed predicate');

  r = await assessPostconditions({
    contract: verifyContract, reason: 'done', effectVerdict: 'no_observed_effects', artifacts: [],
    evidence: [{ kind: 'deterministic_check', strength: 'failed', target: 'npm test -- --runInBand' }, { kind: 'deterministic_check', strength: 'mechanical', target: 'npm lint' }]
  });
  A.eq(r.completionVerdict, 'incomplete', 'failed or different verification evidence cannot be substituted');

  r = await assessPostconditions({
    contract: verifyContract, reason: 'done', effectVerdict: 'judgment_required', artifacts: [],
    evidence: [{ kind: 'deterministic_check', strength: 'mechanical', target: 'npm test -- --runInBand' }]
  });
  A.eq(r.completionVerdict, 'verification_required', 'an unresolved browser/external effect blocks whole-task completion');

  r = await assessPostconditions({
    contract: verifyContract, reason: 'done', effectVerdict: 'no_observed_effects', artifacts: [], uncertainMutations: [{ callId: 'x' }],
    evidence: [{ kind: 'deterministic_check', strength: 'mechanical', target: 'npm test -- --runInBand' }]
  });
  A.eq(r.completionVerdict, 'verification_required', 'mutation uncertainty blocks completion despite passing checks');

  r = await assessPostconditions({
    contract: verifyContract, reason: 'error', effectVerdict: 'no_observed_effects', artifacts: [],
    evidence: [{ kind: 'deterministic_check', strength: 'mechanical', target: 'npm test -- --runInBand' }]
  });
  A.eq(r.completionVerdict, 'incomplete', 'non-clean terminal cannot earn verified completion');
  A.eq((await assessPostconditions({ reason: 'done' })).completionVerdict, 'not_assessed', 'unstructured task remains honestly unassessed');
  A.eq((await assessPostconditions({ contract: { requirements: [] }, reason: 'done' })).completionVerdict, 'verification_required', 'invalid explicit contract fails closed');

  const authority = Symbol('host');
  const collector = makeCompletionEvidence({ authority });
  collector.observe({ callId: 'v1', name: 'verify.run', scope: 'execute', args: { cmd: 'npm test -- --runInBand' }, result: { ok: true, isError: false, summary: 'verify passed (5ms)' } });
  const snap = await collector.assess({ contract: verifyContract, reason: 'done', artifacts: [], uncertainMutations: [] });
  A.eq(snap.completionVerdict, 'completed_verified', 'collector binds typed assessment to recorded tool evidence');
  A.ok(snap._completionAuthority === authority, 'collector carries only the in-process authority identity');
  A.ok(JSON.stringify(snap).indexOf('_completionAuthority') < 0, 'authority identity is omitted by serialization');

  A.report('task-postconditions.test');
}

main().catch(e => { console.error(e); process.exit(1); });
