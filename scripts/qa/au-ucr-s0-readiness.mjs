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

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
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

function capture() {
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const worktrees = git(['worktree', 'list']);
  const branches = git(['branch', '-vv']);
  const localHarness = git(['rev-parse', 'feat/harness-backend']);
  const originHarness = git(['rev-parse', 'origin/feat/harness-backend']);
  const lists = {
    'test/fast.list': readSteps(join(ROOT, 'test', 'fast.list')).length,
    'test/http.list': readSteps(join(ROOT, 'test', 'http.list')).length,
    'test/customer-journeys.list': readSteps(join(ROOT, 'test', 'customer-journeys.list')).length
  };
  const modules = AUTHORITY_MODULES.map(path => {
    const full = join(ROOT, path);
    const present = existsSync(full);
    return {
      path,
      present,
      bytes: present ? statSync(full).size : 0,
      sha256: present ? sha256File(full) : null
    };
  });
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
  writeFileSync(join(BASELINE, 'worktree-snapshot.txt'), worktrees + '\n' + branches + '\n');
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
  if (existsSync(join(ROOT, govPath))) {
    fail(errors, 'GOV addendum must stay on its own commit, not in this worktree tree');
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
    'qa/evidence/au-ucr-ep-000001-s0/receipts/test-fast.json',
    'qa/evidence/au-ucr-ep-000001-s0/receipts/test-http.json'
  ];
  for (const path of required) {
    if (!existsSync(join(ROOT, path))) fail(errors, 'missing ' + path);
  }
  const gate = JSON.parse(readFileSync(join(ROOT, 'docs/experiments/au-ucr-ep-000001/S0_QA_READINESS_GATE.json'), 'utf8'));
  if (gate.s1_transition !== 'closed_pending_explicit_acceptance') fail(errors, 'S1 transition must stay closed');
  if (gate.reviewer !== null || gate.review_outcome !== 'not_recorded' || gate.acceptance !== false) {
    fail(errors, 'QA gate must not record acceptance or a reviewer');
  }
  const rubric = readFileSync(join(ROOT, 'docs/experiments/au-ucr-ep-000001/S0_RUBRIC_APPROVAL_WORKFLOW.md'), 'utf8');
  const rubricFrozen = /(?:frozen:\s*true|\|\s*frozen\s*\|\s*true\s*\|)/i.test(rubric);
  const zeroThreshold = /(?:threshold:\s*0\b|\|\s*Approved thresholds\s*\|\s*0(?:\.0+)?\s*\|)/i.test(rubric);
  if (!rubric.includes('pending') || zeroThreshold || rubricFrozen) {
    fail(errors, 'rubric workflow must keep dimensions pending');
  }
  const flag = JSON.parse(readFileSync(join(ROOT, 'qa/evidence/au-ucr-ep-000001-s0/baseline/flag-code-search.json'), 'utf8'));
  if (flag.default !== 'OFF' || flag.hit_count !== 0) fail(errors, 'STARNET_UCR_ENABLE must stay default OFF with no runtime hits');
  const counts = JSON.parse(readFileSync(join(ROOT, 'qa/evidence/au-ucr-ep-000001-s0/baseline/manifest-counts.json'), 'utf8'));
  if (counts.counts['test/fast.list'] !== 953 || counts.counts['test/http.list'] !== 156) {
    fail(errors, 'manifest counts drifted from the captured baseline');
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'docs/experiments/au-ucr-ep-000001/UCR_001_EVIDENCE_PACKAGE.json'), 'utf8'));
  if (pkg.execution_released === true || pkg.items.some(item => item.status === 'accepted')) {
    fail(errors, 'UCR-001 evidence package must not mark execution released or items accepted');
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
