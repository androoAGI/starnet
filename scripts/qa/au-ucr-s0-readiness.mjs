#!/usr/bin/env node
/* AU-UCR-EP-000001 Sprint S0 readiness capture and consistency check.

   capture  writes read-only inventories under qa/evidence/au-ucr-ep-000001-s0/baseline/
   check    fails closed unless the readiness package is consistent and the S0→S1
            transition stays closed pending an assigned reviewer.

   This script does not assign governance roles, does not accept the sprint, and
   does not rewrite commit cdc793ba738c688ef2493fcd196043bfb3fddd77.
*/
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = join(ROOT, 'qa', 'evidence', 'au-ucr-ep-000001-s0');
const BASELINE = join(EVIDENCE, 'baseline');
const CANONICAL = 'cdc793ba738c688ef2493fcd196043bfb3fddd77';
const GOV = '3f2dd71db76ddc89ff2dabad391665f4a381698c';

const CANONICAL_PATHS = [
  'docs/experiments/au-ucr-ep-000001/README.md',
  'docs/experiments/au-ucr-ep-000001/S0_BASELINE_AND_GATES.md',
  'docs/experiments/au-ucr-ep-000001/S0_DEPENDENCY_GRAPH.md',
  'docs/experiments/au-ucr-ep-000001/S0_EVIDENCE_CONVENTIONS.md',
  'docs/experiments/au-ucr-ep-000001/S0_FEATURE_FLAG_CONTRACT.md',
  'docs/experiments/au-ucr-ep-000001/S0_INDEPENDENT_QA_REVIEW.md',
  'docs/experiments/au-ucr-ep-000001/S0_RUBRIC_PENDING.md',
  'docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml',
  'docs/experiments/au-ucr-ep-000001/UCR_001_ACCEPTANCE_CHECKLIST.md',
  'qa/evidence/au-ucr-ep-000001-s0/README.md',
  'qa/evidence/au-ucr-ep-000001-s0/baseline-metadata.json',
  'qa/evidence/au-ucr-ep-000001-s0/worktree-snapshot.txt'
];

const AUTHORITY_MODULES = [
  'sidecar/index.js',
  'shared/events.js',
  'shared/schema.js',
  'shared/emitter.js',
  'sidecar/capability/registry.js',
  'sidecar/capability/resolve.js',
  'sidecar/permissions.js',
  'sidecar/permgrants.js',
  'sidecar/runstore.js',
  'sidecar/ledger.js',
  'sidecar/durable-store.js',
  'sidecar/workspace-lineage.js',
  'sidecar/workspace-lease.js',
  'sidecar/workspace-safety.js',
  'sidecar/routing/router.js',
  'sidecar/routing/chain.js',
  'sidecar/routing/line-stats.js',
  'sidecar/tools/builtin/station.js',
  'frontend/app/workflowpanel.js',
  'frontend/app/linewatch.js',
  'frontend/app/deliverables.js'
];

const LANE_BRANCHES = [
  'cursor/ucr-coordination-3141',
  'cursor/ucr-001-contract-3141',
  'cursor/ucr-runtime-3141',
  'cursor/ucr-governance-3141',
  'cursor/ucr-campus-3141',
  'cursor/ucr-qa-evidence-3141'
];

const CODE_ROOTS = ['sidecar', 'shared', 'frontend', 'scripts', 'test'];
const BASELINE_COUNTS = {
  'test/fast.list': 953,
  'test/http.list': 156,
  'test/customer-journeys.list': 38
};
const RUBRIC_DIMENSIONS = [
  'intent_preservation',
  'traceability',
  'lineage',
  'dependency_integrity',
  'implementation_completeness',
  'governance_preservation'
];
const CAPTURE_INPUT_PATHS = [
  ...CANONICAL_PATHS,
  ...AUTHORITY_MODULES,
  'docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml',
  'package.json',
  'scripts/qa/au-ucr-s0-readiness.mjs',
  'test/fast.list',
  'test/http.list',
  'test/customer-journeys.list'
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function gitBuffer(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 50 * 1024 * 1024 });
}

function json(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function readSteps(listFile) {
  return readFileSync(listFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function requireClean(paths) {
  const dirty = git(['status', '--porcelain=v1', '--', ...paths]).split(/\r?\n/).filter(Boolean);
  if (dirty.length) {
    throw new Error('capture requires committed input files before labeling evidence with HEAD:\n' + dirty.join('\n'));
  }
}

function walkFiles(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else if (/\.(js|mjs|cjs|ts|tsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

function flagHits() {
  const hits = [];
  for (const root of CODE_ROOTS) {
    for (const file of walkFiles(join(ROOT, root), [])) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (rel === 'scripts/qa/au-ucr-s0-readiness.mjs') continue;
      if (text.includes('STARNET_UCR_ENABLE')) hits.push(rel);
    }
  }
  return hits.sort();
}

function routeLiterals() {
  const src = readFileSync(join(ROOT, 'sidecar', 'index.js'), 'utf8');
  const found = new Set();
  const re = /["'`](\/(?:api|health)[^"'`\s]*)["'`]/g;
  let match;
  while ((match = re.exec(src))) {
    const path = match[1];
    if (path === '/api' || path === '/api/' || path.endsWith('*') || path.includes('?')) continue;
    found.add(path);
  }
  return [...found].sort();
}

function listWorktrees() {
  const records = [];
  let current = null;
  for (const line of git(['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = {};
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (current && line === 'detached') {
      current.branch = '(detached)';
    }
  }
  if (current) records.push(current);
  return records.map(record => ({
    branch: record.branch || '(unknown)',
    head: record.head || '(unknown)'
  }));
}

function currentManifestCounts() {
  return Object.fromEntries(
    Object.keys(BASELINE_COUNTS).map(path => [path, readSteps(join(ROOT, path)).length])
  );
}

function currentAuthorityModules() {
  return AUTHORITY_MODULES.map(path => {
    const full = join(ROOT, path);
    const present = existsSync(full);
    return {
      path,
      present,
      bytes: present ? statSync(full).size : 0,
      sha256: present ? sha256File(full) : null
    };
  });
}

function canonicalAuthorityModules() {
  return AUTHORITY_MODULES.map(path => {
    try {
      const content = gitBuffer(['show', CANONICAL + ':' + path]);
      return {
        path,
        present: true,
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex')
      };
    } catch {
      return {
        path,
        present: false,
        bytes: 0,
        sha256: null
      };
    }
  });
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function receiptShapeErrors(receipt, expectedGateSet) {
  const errors = [];
  const required = [
    'experiment_id',
    'sprint_id',
    'work_item_id',
    'owner_lane',
    'branch',
    'commit_tested',
    'gate_set',
    'outcome',
    'reviewer',
    'review_outcome',
    'created_at_utc'
  ];
  for (const field of required) {
    if (!Object.hasOwn(receipt, field)) errors.push('missing receipt field ' + field);
  }
  if (receipt.experiment_id !== 'AU-UCR-EP-000001') errors.push('receipt experiment_id mismatch');
  if (receipt.sprint_id !== 'S0') errors.push('receipt sprint_id mismatch');
  if (receipt.owner_lane !== 'unassigned_role_only') errors.push('receipt owner_lane mismatch');
  if (typeof receipt.branch !== 'string' || receipt.branch.length === 0) errors.push('receipt branch missing');
  if (!/^[0-9a-f]{40}$/.test(receipt.commit_tested || '')) errors.push('receipt commit_tested is not a full SHA');
  if (!sameJson(receipt.gate_set, expectedGateSet)) errors.push('receipt gate_set mismatch for ' + expectedGateSet.join(','));
  if (!['pass', 'fail', 'blocked', 'not_run'].includes(receipt.outcome)) errors.push('receipt outcome invalid');
  if (receipt.reviewer !== null && typeof receipt.reviewer !== 'string') errors.push('receipt reviewer invalid');
  if (!['not_recorded', 'accepted', 'revise', 'reject'].includes(receipt.review_outcome)) {
    errors.push('receipt review_outcome invalid');
  }
  if (typeof receipt.created_at_utc !== 'string' || Number.isNaN(Date.parse(receipt.created_at_utc))) {
    errors.push('receipt created_at_utc invalid');
  }
  return errors;
}

function capture() {
  requireClean(CAPTURE_INPUT_PATHS);
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const worktrees = listWorktrees();
  const branches = git(['branch', '-vv']);
  const localHarness = git(['rev-parse', 'feat/harness-backend']);
  const originHarness = git(['rev-parse', 'origin/feat/harness-backend']);
  const lists = currentManifestCounts();
  const modules = currentAuthorityModules();
  const routes = routeLiterals();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const hits = flagHits();
  const lanePresence = LANE_BRANCHES.map(name => ({
    branch: name,
    local: branches.split(/\r?\n/).some(line => line.includes(name)),
    owner: 'unassigned_role_only'
  }));

  writeJson(join(BASELINE, 'git-identity.json'), {
    experiment_id: 'AU-UCR-EP-000001',
    sprint_id: 'S0',
    work_item_id: 'S0-001',
    owner_lane: 'unassigned_role_only',
    branch,
    commit_tested: head,
    canonical_s0: CANONICAL,
    gov_addendum: GOV,
    authority_branch_local: { name: 'feat/harness-backend', commit: localHarness },
    authority_branch_origin: { name: 'origin/feat/harness-backend', commit: originHarness },
    gate_set: ['test:fast', 'test:http'],
    reviewer: null,
    review_outcome: 'not_recorded',
    created_at_utc: new Date().toISOString()
  });
  writeJson(join(BASELINE, 'manifest-counts.json'), {
    experiment_id: 'AU-UCR-EP-000001',
    sprint_id: 'S0',
    work_item_id: 'S0-001',
    parser: 'scripts/run-test-list.mjs readSteps (trim, drop blanks and # comments)',
    counts: lists,
    commit_tested: head
  });
  writeJson(join(BASELINE, 'authority-module-inventory.json'), {
    experiment_id: 'AU-UCR-EP-000001',
    sprint_id: 'S0',
    work_item_id: 'S0-001',
    commit_tested: head,
    modules
  });
  writeJson(join(BASELINE, 'route-gate-inventory.json'), {
    experiment_id: 'AU-UCR-EP-000001',
    sprint_id: 'S0',
    work_item_id: 'S0-001',
    commit_tested: head,
    extraction: 'string literals in sidecar/index.js matching /api or /health, excluding wildcards and query templates',
    route_count: routes.length,
    routes,
    gates: {
      'test:fast': pkg.scripts['test:fast'],
      'test:http': pkg.scripts['test:http']
    }
  });
  writeJson(join(BASELINE, 'flag-code-search.json'), {
    experiment_id: 'AU-UCR-EP-000001',
    sprint_id: 'S0',
    work_item_id: 'S0-006',
    flag: 'STARNET_UCR_ENABLE',
    default: 'OFF',
    roots: CODE_ROOTS,
    hit_count: hits.length,
    hits
  });
  writeJson(join(BASELINE, 'lane-materialization.json'), {
    experiment_id: 'AU-UCR-EP-000001',
    sprint_id: 'S0',
    work_item_id: 'S0-002',
    owner_lane: 'unassigned_role_only',
    lanes: lanePresence,
    worktrees
  });
  writeFileSync(
    join(BASELINE, 'worktree-snapshot.txt'),
    worktrees.map(worktree => `${worktree.branch} ${worktree.head.slice(0, 8)}`).join('\n') + '\n' + branches + '\n'
  );
  console.log('capture: wrote ' + relative(ROOT, BASELINE).replaceAll('\\', '/'));
  console.log('manifests ' + JSON.stringify(lists));
  console.log('authority present ' + modules.filter(m => m.present).length + '/' + modules.length);
  console.log('route literals ' + routes.length);
  console.log('flag hits ' + hits.length);
}

function fail(errors, message) {
  errors.push(message);
}

function check() {
  const errors = [];
  for (const path of CANONICAL_PATHS) {
    const committed = git(['rev-parse', CANONICAL + ':' + path]);
    const working = git(['hash-object', path]);
    if (committed !== working) fail(errors, 'canonical blob drifted: ' + path);
  }
  const govPath = 'docs/experiments/au-ucr-ep-000001/AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md';
  if (!existsSync(join(ROOT, govPath))) {
    fail(errors, 'GOV addendum missing from inherited tree');
  } else {
    const committed = git(['rev-parse', GOV + ':' + govPath]);
    const working = git(['hash-object', govPath]);
    if (committed !== working) fail(errors, 'GOV addendum blob does not match provenance commit');
  }
  const register = readFileSync(join(ROOT, 'docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml'), 'utf8');
  const owners = register.match(/owner:\s*(\S+)/g) || [];
  if (owners.length !== 6 || owners.some(line => line !== 'owner: unassigned_role_only')) {
    fail(errors, 'lane owners must remain unassigned_role_only');
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'feat/harness-backend' || branch === 'main' || branch === 'master') {
    fail(errors, 'readiness package is on an integration branch: ' + branch);
  }
  const branchList = git(['branch', '-a']);
  for (const lane of LANE_BRANCHES) {
    if (branchList.split(/\r?\n/).some(line => line.includes(lane))) {
      fail(errors, 'lane branch materialized without an assignment register: ' + lane);
    }
  }
  const required = [
    'docs/experiments/au-ucr-ep-000001/S0_RECEIPT_SCHEMA.json',
    'docs/experiments/au-ucr-ep-000001/S0_LANE_ISOLATION_ENFORCEMENT.md',
    'docs/experiments/au-ucr-ep-000001/S0_DEPENDENCY_FREEZE.json',
    'docs/experiments/au-ucr-ep-000001/S0_RUBRIC_APPROVAL_WORKFLOW.md',
    'docs/experiments/au-ucr-ep-000001/S0_OFF_PATH_INVARIANTS.md',
    'docs/experiments/au-ucr-ep-000001/UCR_001_EVIDENCE_PACKAGE.json',
    'docs/experiments/au-ucr-ep-000001/S0_QA_READINESS_GATE.json',
    'qa/evidence/au-ucr-ep-000001-s0/baseline/git-identity.json',
    'qa/evidence/au-ucr-ep-000001-s0/baseline/manifest-counts.json',
    'qa/evidence/au-ucr-ep-000001-s0/baseline/authority-module-inventory.json',
    'qa/evidence/au-ucr-ep-000001-s0/baseline/route-gate-inventory.json',
    'qa/evidence/au-ucr-ep-000001-s0/baseline/flag-code-search.json',
    'qa/evidence/au-ucr-ep-000001-s0/baseline/lane-materialization.json',
    'qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-AUTHORITY-NAMES-00.json',
    'qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json',
    'qa/evidence/au-ucr-ep-000001-s0/receipts/test-fast.json',
    'qa/evidence/au-ucr-ep-000001-s0/receipts/test-fast.log',
    'qa/evidence/au-ucr-ep-000001-s0/receipts/test-http.json',
    'qa/evidence/au-ucr-ep-000001-s0/receipts/test-http.log'
  ];
  for (const path of required) {
    if (!existsSync(join(ROOT, path))) fail(errors, 'missing ' + path);
  }
  const gate = json('docs/experiments/au-ucr-ep-000001/S0_QA_READINESS_GATE.json');
  if (gate.s1_transition !== 'closed_pending_explicit_acceptance') fail(errors, 'S1 transition must stay closed');
  if (gate.reviewer !== null || gate.review_outcome !== 'not_recorded' || gate.acceptance !== false) {
    fail(errors, 'QA gate must not record acceptance or a reviewer');
  }
  if (gate.commit_tested !== CANONICAL) fail(errors, 'QA gate must reference the canonical S0 commit');
  if (!sameJson(gate.gate_set, ['readiness-check', 'test:fast', 'test:http'])) {
    fail(errors, 'QA gate must name readiness-check, test:fast, and test:http');
  }
  const rubric = readFileSync(join(ROOT, 'docs/experiments/au-ucr-ep-000001/S0_RUBRIC_APPROVAL_WORKFLOW.md'), 'utf8');
  const missingDimensions = RUBRIC_DIMENSIONS.filter(dimension => !rubric.includes('`' + dimension + '`'));
  const rubricFrozen = /(?:frozen:\s*true|\|\s*frozen\s*\|\s*true\s*\|)/i.test(rubric);
  const approvedThresholds = rubric.match(/^\|\s*Approved thresholds\s*\|\s*([^|]+?)\s*\|$/im)?.[1]?.trim().toLowerCase();
  const thresholdsSet = /threshold:\s*[-+]?\d/i.test(rubric) || approvedThresholds !== 'none';
  const freezeRecordPending = /\|\s*Reviewer\s*\|\s*unset\s*\|/i.test(rubric)
    && /\|\s*Date \(UTC\)\s*\|\s*unset\s*\|/i.test(rubric)
    && /\|\s*frozen\s*\|\s*false\s*\|/i.test(rubric)
    && /\|\s*Approved definitions\s*\|\s*none\s*\|/i.test(rubric)
    && /\|\s*Approved thresholds\s*\|\s*none\s*\|/i.test(rubric);
  if (missingDimensions.length || thresholdsSet || rubricFrozen || !freezeRecordPending) {
    fail(errors, 'rubric workflow must keep dimensions pending');
  }
  const flag = json('qa/evidence/au-ucr-ep-000001-s0/baseline/flag-code-search.json');
  const currentFlagHits = flagHits();
  if (flag.default !== 'OFF' || flag.hit_count !== 0 || (flag.hits || []).length !== 0 || currentFlagHits.length !== 0) {
    fail(errors, 'STARNET_UCR_ENABLE must stay default OFF with no runtime hits');
  }
  const counts = json('qa/evidence/au-ucr-ep-000001-s0/baseline/manifest-counts.json');
  const liveCounts = currentManifestCounts();
  if (!sameJson(counts.counts, BASELINE_COUNTS) || !sameJson(liveCounts, BASELINE_COUNTS)) {
    fail(errors, 'manifest counts drifted from the captured baseline');
  }
  const capturedModules = json('qa/evidence/au-ucr-ep-000001-s0/baseline/authority-module-inventory.json');
  if (capturedModules.commit_tested !== CANONICAL || !sameJson(capturedModules.modules, canonicalAuthorityModules())) {
    fail(errors, 'authority module inventory does not match the canonical commit');
  }
  const capturedRoutes = json('qa/evidence/au-ucr-ep-000001-s0/baseline/route-gate-inventory.json');
  const currentRoutes = routeLiterals();
  const livePkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (
    capturedRoutes.route_count !== currentRoutes.length
    || !sameJson(capturedRoutes.routes, currentRoutes)
    || capturedRoutes.gates['test:fast'] !== livePkg.scripts['test:fast']
    || capturedRoutes.gates['test:http'] !== livePkg.scripts['test:http']
  ) {
    fail(errors, 'route or gate inventory drifted from current tree');
  }
  const receiptExpectations = [
    ['qa/evidence/au-ucr-ep-000001-s0/receipts/test-fast.json', ['test:fast']],
    ['qa/evidence/au-ucr-ep-000001-s0/receipts/test-http.json', ['test:http']]
  ];
  for (const [path, gateSet] of receiptExpectations) {
    const receipt = json(path);
    for (const error of receiptShapeErrors(receipt, gateSet)) fail(errors, path + ': ' + error);
    if (receipt.commit_tested !== CANONICAL) fail(errors, path + ': commit_tested must match canonical S0 commit');
    if (receipt.outcome !== 'fail' || receipt.reviewer !== null || receipt.review_outcome !== 'not_recorded') {
      fail(errors, path + ': receipt must remain an unaccepted failed gate observation');
    }
    if (!receipt.log || !existsSync(join(ROOT, receipt.log))) fail(errors, path + ': referenced log is missing');
    if (Date.parse(receipt.created_at_utc) > Date.parse(gate.created_at_utc)) {
      fail(errors, path + ': receipt timestamp is newer than QA gate timestamp');
    }
  }
  const pkg = json('docs/experiments/au-ucr-ep-000001/UCR_001_EVIDENCE_PACKAGE.json');
  if (pkg.execution_released === true || pkg.items.some(item => item.status === 'accepted')) {
    fail(errors, 'UCR-001 evidence package must not mark execution released or items accepted');
  }
  const authorityNames = JSON.parse(readFileSync(join(ROOT, 'qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-AUTHORITY-NAMES-00.json'), 'utf8'));
  if (authorityNames.result !== 'BLOCKED_BY_MISSING_NAMED_ASSIGNMENTS') {
    fail(errors, 'PRE_A09 authority names receipt must stay blocked by missing named assignments');
  }
  if (authorityNames.a09_submission_readiness?.role_names_populated !== true ||
      authorityNames.a09_submission_readiness?.authority_evidence_populated !== true) {
    fail(errors, 'PRE_A09 authority names and authority evidence must be populated');
  }
  if (authorityNames.a09_submission_readiness?.named_assignment_authority_complete !== false ||
      authorityNames.a09_submission_readiness?.decision_chair_receipt_present !== false ||
      authorityNames.a09_submission_readiness?.execution_release_receipt_present !== false) {
    fail(errors, 'PRE_A09 receipt must not record A09 authority, decision, or execution release');
  }
  if ((authorityNames.role_assignment_evidence || []).some(role => role.authority_to_act !== false || role.effective_assignment_found !== false)) {
    fail(errors, 'PRE_A09 role evidence must not grant action authority');
  }
  const deterministicReadiness = JSON.parse(readFileSync(join(ROOT, 'qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json'), 'utf8'));
  if (deterministicReadiness.result !== 'PASS_WITH_A09_TRANSITION_CLOSED') {
    fail(errors, 'PRE_A09 deterministic readiness receipt must pass with A09 transition closed');
  }
  if (deterministicReadiness.readiness_conclusion?.deterministic_checks_passed !== true ||
      deterministicReadiness.readiness_conclusion?.a09_decision !== 'NO_DECISION_NO_TRANSITION') {
    fail(errors, 'PRE_A09 deterministic readiness must pass without an A09 decision');
  }
  if (deterministicReadiness.readiness_conclusion?.s1_transition !== 'closed_pending_explicit_acceptance') {
    fail(errors, 'PRE_A09 deterministic readiness must keep S1 closed');
  }
  if (errors.length) {
    for (const error of errors) console.error('check: ' + error);
    return 1;
  }
  console.log('check: PACKAGE_CONSISTENT_S1_CLOSED');
  return 0;
}

const command = process.argv[2];
if (command === 'capture') capture();
else if (command === 'check') process.exit(check());
else {
  console.error('usage: node scripts/qa/au-ucr-s0-readiness.mjs <capture|check>');
  process.exit(1);
}
