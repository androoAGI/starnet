/* W0 advertised-claims authority: finite inventory, source lock, live locators, and
   separate planning/terminal verdicts. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const A = require('./_assert.js');

const TEST_ONLY_LEDGER_OVERRIDE = 'TEST_ONLY_UNCOMMITTED_LEDGER_FIXTURE';

(async () => {
  const {
    buildReleaseSurface,
    discoverReleaseSurface,
    inspectClaimsAuthority,
    validateClaimsLedger
  } = await import('../scripts/qa/product-perfect/claims.mjs');

  const repoRoot = path.resolve(__dirname, '..');
  const ledgerBytes = execFileSync(
    'git',
    ['show', 'HEAD:qa/product-perfect/claims.json'],
    { cwd: repoRoot, encoding: 'buffer' }
  );
  const ledger = JSON.parse(ledgerBytes.toString('utf8'));
  const clone = value => JSON.parse(JSON.stringify(value));

  const inspected = inspectClaimsAuthority({ repoRoot });
  A.eq(inspected.planning.ok, true, 'tracked finite claims audit passes planning authority');
  A.eq(inspected.planning.status, 'PASS', 'planning status is explicitly PASS');
  A.eq(inspected.terminal.ok, false, 'open and unlabelled claims block terminal authority');
  A.eq(inspected.terminal.status, 'BLOCKED', 'terminal status is explicitly BLOCKED');
  A.eq(ledger.claims.length, 37, 'the reviewed inventory is 37 normalized material claim families');
  A.eq(new Set(ledger.claims.map(row => row.id)).size, 37, 'claim IDs are unique');
  A.ok(inspected.terminal.reasons.some(reason => /claim/i.test(reason)), 'terminal explains open claim work');
  A.ok(inspected.terminal.reasons.some(reason => /wave verdict/i.test(reason)), 'terminal explains open grep-verdict work');
  A.ok(/^[0-9a-f]{40}$/.test(inspected.candidateCommit), 'runtime authority returns the exact candidate commit');
  A.eq(inspected.candidateCommit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(), 'default inspection derives the current Git HEAD');
  A.eq(inspected.sourceCommit, ledger.releaseSurface.sourceCommit, 'runtime authority returns the accepted manifest source commit');
  A.ok(/^[0-9a-f]{64}$/.test(inspected.manifestDigest), 'runtime authority returns a deterministic manifest digest');
  A.ok(/^[0-9a-f]{64}$/.test(inspected.surfaceDigest), 'runtime authority returns a deterministic surface digest');
  A.ok(/^[0-9a-f]{64}$/.test(inspected.candidateLedgerSha256), 'runtime authority returns the raw candidate ledger SHA-256');
  A.ok(/^[0-9a-f]{64}$/.test(inspected.candidateLedgerDigest), 'runtime authority returns the canonical candidate ledger digest');
  A.eq(inspected.candidateLedgerDigest, inspected.manifestDigest, 'default manifest digest is derived from the candidate ledger blob');
  A.eq(inspected.ledgerSource, 'candidate-git-blob', 'default authority names the candidate Git blob as its ledger source');
  A.ok(inspected.candidateCommit !== inspected.sourceCommit, 'an unrelated descendant commit is allowed when every locked byte and locator stays exact');
  const inspectedAgain = inspectClaimsAuthority({ repoRoot });
  A.eq(inspectedAgain.candidateLedgerSha256, inspected.candidateLedgerSha256, 'raw candidate-ledger SHA is deterministic');
  A.eq(inspectedAgain.manifestDigest, inspected.manifestDigest, 'canonical manifest digest is deterministic');

  const equalObjectInjection = inspectClaimsAuthority({ repoRoot, ledger: clone(ledger) });
  A.eq(equalObjectInjection.planning.ok, true, 'a canonical-equal injected object cannot change candidate authority');
  A.eq(equalObjectInjection.ledgerSource, 'candidate-git-blob', 'equal object injection still uses the candidate blob');
  const equalRawInjection = inspectClaimsAuthority({ repoRoot, ledgerBytes });
  A.eq(equalRawInjection.planning.ok, true, 'raw candidate ledger bytes are accepted as an equality assertion');
  const crlfRawInjection = inspectClaimsAuthority({
    repoRoot,
    ledgerBytes: Buffer.from(ledgerBytes.toString('utf8').replace(/\n/g, '\r\n'))
  });
  A.eq(crlfRawInjection.planning.ok, false, 'line-ending changes remain a raw candidate-byte mismatch');

  const allGreenForgery = clone(ledger);
  for (const claim of allGreenForgery.claims) {
    claim.verdict = 'SHIPPED';
    claim.disposition = 'PROVEN';
    claim.liveProof = claim.liveProofRequired ? 'PROVEN' : 'NOT_REQUIRED';
  }
  for (const verdict of allGreenForgery.waveVerdicts) {
    verdict.verdict = 'SHIPPED';
    verdict.disposition = 'PROVEN';
  }
  const reproducedExploit = inspectClaimsAuthority({
    repoRoot,
    ledger: allGreenForgery,
    testOnlyLedgerOverride: TEST_ONLY_LEDGER_OVERRIDE
  });
  A.eq(reproducedExploit.planning.ok, true, 'test-only seam reproduces the formerly accepted forged manifest');
  A.eq(reproducedExploit.terminal.ok, true, 'test-only seam proves the forged statuses would otherwise turn terminal green');
  const blockedExploit = inspectClaimsAuthority({ repoRoot, ledger: allGreenForgery });
  A.eq(blockedExploit.planning.ok, false, 'production inspection rejects the all-green forged manifest');
  A.eq(blockedExploit.terminal.ok, false, 'the all-green forged manifest cannot produce terminal PASS');
  A.ok(blockedExploit.planning.reasons.some(reason => /ledger object does not match/.test(reason)), 'forged object rejection identifies candidate-ledger mismatch');
  A.eq(blockedExploit.manifestDigest, inspected.manifestDigest, 'rejected injection cannot alter the manifest digest used by production authority');

  const rawForgery = Buffer.from(ledgerBytes);
  rawForgery[rawForgery.length - 2] = rawForgery[rawForgery.length - 2] === 0x20 ? 0x21 : 0x20;
  const blockedRaw = inspectClaimsAuthority({ repoRoot, ledgerBytes: rawForgery });
  A.eq(blockedRaw.planning.ok, false, 'production inspection rejects raw ledger bytes that differ from the candidate blob');
  A.ok(blockedRaw.planning.reasons.some(reason => /ledger bytes do not match/.test(reason)), 'raw byte mismatch is explicit');

  const ambientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-claims-ambient-'));
  try {
    const ambientRepo = path.join(ambientRoot, 'repo');
    execFileSync('git', ['clone', '--shared', '--no-checkout', repoRoot, ambientRepo], { stdio: 'ignore' });
    const ambientLedger = path.join(ambientRepo, 'qa', 'product-perfect', 'claims.json');
    fs.mkdirSync(path.dirname(ambientLedger), { recursive: true });
    fs.writeFileSync(ambientLedger, JSON.stringify(allGreenForgery, null, 2));
    const ambientInspection = inspectClaimsAuthority({ repoRoot: ambientRepo });
    A.eq(ambientInspection.planning.ok, true, 'ambient working-tree ledger drift cannot replace the candidate blob');
    A.eq(ambientInspection.terminal.ok, false, 'ambient all-green drift cannot turn candidate terminal authority green');
    A.eq(ambientInspection.candidateLedgerSha256, inspected.candidateLedgerSha256, 'ambient drift preserves the exact candidate ledger SHA');
    A.eq(ambientInspection.ledgerSource, 'candidate-git-blob', 'ambient drift still reports candidate Git authority');
  } finally {
    fs.rmSync(ambientRoot, { recursive: true, force: true });
  }

  const surface = discoverReleaseSurface(repoRoot);
  A.ok(surface.length > 150, 'release surface includes all tracked frontend JS/HTML/CSS plus marketed docs');
  A.ok(surface.includes('frontend/index.html'), 'frontend HTML is source-locked');
  A.ok(surface.includes('frontend/css/app.css'), 'frontend CSS generated copy is source-locked');
  A.ok(surface.includes('README.md') && surface.includes('docs/DOWNLOAD_PAGE.md'), 'marketed docs are source-locked');
  A.eq(surface, ledger.releaseSurface.files.map(row => row.path), 'locked release path-set is complete and sorted');
  const refreshed = buildReleaseSurface(repoRoot, { candidateCommit: ledger.releaseSurface.sourceCommit });
  A.eq(refreshed.files, ledger.releaseSurface.files, 'read-only refresh helper reproduces the exact tracked file lock');
  A.eq(refreshed.pathSetSha256, ledger.releaseSurface.pathSetSha256, 'read-only refresh helper reproduces the path-set hash');
  A.eq(refreshed.sourceCommit, ledger.releaseSurface.sourceCommit, 'read-only refresh helper stamps the accepted source snapshot');

  const duplicate = clone(ledger);
  duplicate.claims[1].id = duplicate.claims[0].id;
  A.eq(validateClaimsLedger(duplicate, { repoRoot }).ok, false, 'duplicate claim IDs are rejected');

  const missingDomain = clone(ledger);
  missingDomain.claims = missingDomain.claims.filter(row => row.domain !== 'release');
  A.eq(validateClaimsLedger(missingDomain, { repoRoot }).ok, false, 'a missing required claim domain is rejected');

  const droppedFamily = clone(ledger);
  droppedFamily.claims.splice(1, 1);
  droppedFamily.expectedClaimCount = droppedFamily.claims.length;
  A.eq(validateClaimsLedger(droppedFamily, { repoRoot }).ok, false, 'a reviewed claim family cannot be silently dropped');

  const changedBytes = clone(ledger);
  changedBytes.releaseSurface.files[0].sha256 = '0'.repeat(64);
  A.eq(inspectClaimsAuthority({
    repoRoot,
    ledger: changedBytes,
    testOnlyLedgerOverride: TEST_ONLY_LEDGER_OVERRIDE
  }).planning.ok, false, 'changed reviewed bytes force re-audit');

  const addedSurface = clone(ledger);
  A.eq(inspectClaimsAuthority({
    repoRoot,
    ledger: addedSurface,
    surfacePaths: surface.concat('frontend/app/new-unreviewed-surface.js')
  }).planning.ok, false, 'new tracked release-surface paths force re-audit');

  const badLocator = clone(ledger);
  badLocator.claims[0].surfaceLocators[0].needle = '__missing_surface_copy__';
  A.eq(inspectClaimsAuthority({
    repoRoot,
    ledger: badLocator,
    testOnlyLedgerOverride: TEST_ONLY_LEDGER_OVERRIDE
  }).planning.ok, false, 'stale user-facing locator is rejected');

  const absenceClaim = ledger.claims.find(row => row.authorityChecks.some(check => check.kind === 'absent' && check.path));
  A.ok(!!absenceClaim, 'inventory contains machine-checked file absence authority');
  if (absenceClaim) {
    const check = absenceClaim.authorityChecks.find(item => item.kind === 'absent' && item.path);
    const realRead = relative => fs.readFileSync(path.join(repoRoot, relative));
    const injected = inspectClaimsAuthority({
      repoRoot,
      ledger,
      readFile: relative => relative === check.path
        ? Buffer.concat([realRead(relative), Buffer.from('\n' + check.needles[0] + '\n')])
        : realRead(relative),
      skipSurfaceHashes: true
    });
    A.eq(injected.planning.ok, false, 'an absence escape turns the planning authority red');
  }

  const handAuthored = clone(ledger);
  delete handAuthored.releaseSurface.pathSetSha256;
  A.eq(inspectClaimsAuthority({
    repoRoot,
    ledger: handAuthored,
    testOnlyLedgerOverride: TEST_ONLY_LEDGER_OVERRIDE
  }).planning.ok, false, 'hand-authored unlocked evidence is rejected');

  const fakeExperimentalLabel = clone(ledger);
  const experimental = fakeExperimentalLabel.claims.find(row => row.disposition === 'EXPERIMENTAL');
  experimental.experimentalLabel.visible = true;
  A.eq(validateClaimsLedger(fakeExperimentalLabel, { repoRoot }).ok, false, 'experimental status cannot be made terminal-visible by flipping a boolean over an absence check');

  const marketingExperimentalLabel = clone(ledger);
  const marketingExperimental = marketingExperimentalLabel.claims.find(row => row.disposition === 'EXPERIMENTAL');
  marketingExperimental.experimentalLabel = {
    visible: true,
    check: { kind: 'contains', path: 'README.md', needle: 'StarNet' }
  };
  A.eq(validateClaimsLedger(marketingExperimentalLabel, { repoRoot }).ok, false, 'marketing copy cannot impersonate a visible point-of-use experimental label');

  const nonAncestor = inspectClaimsAuthority({ repoRoot, isAncestor: () => false });
  A.eq(nonAncestor.planning.ok, false, 'a manifest source outside candidate ancestry is rejected');
  A.ok(nonAncestor.planning.reasons.some(reason => /not an ancestor/.test(reason)), 'ancestry rejection is explicit');

  const injectedMismatch = inspectClaimsAuthority({
    repoRoot,
    candidateCommit: 'f'.repeat(40)
  });
  A.eq(injectedMismatch.planning.ok, false, 'an injected candidate that cannot resolve exactly is rejected');
  A.ok(injectedMismatch.planning.reasons.some(reason => /injected candidate mismatch/.test(reason)), 'injected candidate rejection is explicit');

  const terminalRefuted = clone(ledger);
  for (const claim of terminalRefuted.claims) {
    claim.verdict = 'SHIPPED';
    claim.disposition = 'PROVEN';
    claim.liveProof = claim.liveProofRequired ? 'PROVEN' : 'NOT_REQUIRED';
  }
  for (const verdict of terminalRefuted.waveVerdicts) {
    verdict.verdict = 'SHIPPED';
    verdict.disposition = 'PROVEN';
  }
  terminalRefuted.claims[0].verdict = 'REFUTED';
  const refutedInspection = inspectClaimsAuthority({
    repoRoot,
    ledger: terminalRefuted,
    testOnlyLedgerOverride: TEST_ONLY_LEDGER_OVERRIDE
  });
  A.eq(refutedInspection.planning.ok, true, 'a truthful refuted verdict can remain planning-valid');
  A.eq(refutedInspection.terminal.ok, false, 'REFUTED/PROVEN can never satisfy terminal product authority');

  const noRefs = clone(ledger);
  noRefs.claims[0].refsChecked = ['trunk@' + 'a'.repeat(40)];
  A.eq(validateClaimsLedger(noRefs, { repoRoot }).ok, false, 'claims must record trunk, branch, and worktree searches');

  A.eq(ledger.doNotRebuild.length, 5, 'all five locked do-not-rebuild exceptions are present');
  A.eq(new Set(ledger.doNotRebuild.map(row => row.id)).size, 5, 'do-not-rebuild exception IDs are unique');
  A.ok(ledger.waveVerdicts.length >= 15, 'W2-W6 grep-verdict matrix is present');

  A.report('qa-product-perfect-claims.test');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
