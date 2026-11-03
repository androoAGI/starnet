/* node test/ledger-reconcile.test.js — LEDGER TRUTH (scripts/qa/ledger-reconcile.mjs).

   The core is fed a SYNTHETIC io (no git, no disk, no child processes) so every verdict path is
   asserted deterministically: likely-fixed (hard + soft), still-open (red test / cited code still
   present), unverifiable (no anchor / non-discriminating anchors), the closed-record audit, the
   Janitor finding mappings, and the --ci staleness exit. The anchor-required register law (Law 7)
   is asserted through the same register core the CLI uses. A final smoke drives the REAL io shell
   against a throwaway git repo in the scratch tmpdir so `isAncestor`/`branchMerged`/`worktrees`
   are proven against actual git, never just mocked, then runs the REAL CLI rooted at that repo (a
   byte copy of its module graph under the repo's scripts/qa/) for its exit codes, --json and
   --no-write, in seconds. Only the bad-argument check runs the CLI where it lives: it exits before
   any scan. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const A = require('./_assert.js');
const { makeReconciler, realIo } = require('../scripts/qa/ledger-reconcile.mjs');
const { makeBugRegister } = require('../scripts/qa/bugs.mjs');

const TODAY = '2026-08-21';
const clock = { today: () => TODAY };

// ---- fixtures: bug records rendered through the real register so the parse path is the real one
function record(reg, over) {
  const res = reg.create({ title: over.title, surface: over.surface || 'world', severity: over.severity || 'P2', found: over.found || '2026-07-28', slug: over.slug });
  if (!res.ok || res.status !== 'created') throw new Error('fixture: ' + res.reason);
  const bug = res.bug;
  bug.status = over.status || 'open';
  bug.fix = over.fix || '';
  bug.sections = Object.assign({ Symptom: 'it lies', Repro: '1. boot 2. look', Evidence: 'see log', Verdict: '' }, over.sections || {});
  return { file: bug.file, text: reg.render(bug), bug };
}
const scratchReg = makeBugRegister({ io: { listBugs: () => [], writeBug() {}, knownFingerprints: () => [] }, clock });

// A synthetic world: which shas are ancestors, which files exist with what text, which tests pass.
function world(spec) {
  spec = spec || {};
  const files = spec.files || {};
  const log = { tests: [], searches: [] };
  return {
    log,
    io: {
      listBugs: () => (spec.bugs || []).map(b => ({ file: b.file, text: b.text })),
      listFindings: () => (spec.findings || []).slice(),
      headSha: () => 'feedface0',
      isAncestor: (sha) => (spec.ancestors || {})[sha] == null ? null : !!(spec.ancestors || {})[sha],
      fileExists: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
      readFile: (rel) => Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null,
      runTest: (rel) => { log.tests.push(rel); const ok = !!(spec.pass || {})[rel]; return { ok, code: ok ? 0 : 1, ms: 1, tail: ok ? 'OK' : 'FAIL: x' }; },
      searchCode: (text) => { log.searches.push(text); return Object.keys(files).filter(f => files[f].replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' '))); },
      worktrees: () => (spec.worktrees || []).slice(),
      branchExists: (n) => (spec.branches || []).includes(n),
      branchMerged: (n) => (spec.merged || {})[n] == null ? null : !!(spec.merged || {})[n]
    }
  };
}
const rowOf = (res, fp) => res.records.find(r => r.fingerprint === fp);

// ---- A. likely-fixed HARD: fix commit is an ancestor AND the Verdict-named regression passes ----
{
  const r = record(scratchReg, {
    title: 'tooltip ghost card', slug: 'tooltip-ghost', status: 'open', fix: 'f4d03511',
    sections: { Evidence: '`frontend/app/tooltip.js:136` opens with `if (!anchor) return;`', Verdict: 'Fixed in f4d03511; regression test/tooltip-pending.test.js.' }
  });
  const w = world({ bugs: [r], ancestors: { f4d03511: true }, files: { 'frontend/app/tooltip.js': 'function x(){ if (pending) clearTimeout(t); }', 'test/tooltip-pending.test.js': '' }, pass: { 'test/tooltip-pending.test.js': true } });
  const R = makeReconciler({ io: w.io, clock });
  const res = R.reconcile();
  const row = rowOf(res, r.bug.fingerprint);
  A.eq(row.verdict, 'likely-fixed', 'ancestor commit -> likely-fixed');
  A.eq(row.confidence, 'hard', 'commit + passing regression = hard');
  A.ok(row.evidence.some(e => /fix commit f4d03511 is an ancestor/.test(e)), 'evidence names the commit');
  A.ok(row.evidence.some(e => /regression test test\/tooltip-pending\.test\.js passes/.test(e)), 'evidence names the regression');
  A.ok(row.evidence.some(e => /quoted defect line\(s\) are gone/.test(e)), 'the quoted defect line is reported gone');
  A.eq(row.ageDays, 24, 'age is measured from found to the injected today');
  A.eq(res.summary.records, { total: 1, 'likely-fixed': 1, 'still-open': 0, unverifiable: 0, hard: 1 }, 'summary tallies the one open record');
  A.eq(w.log.tests, ['test/tooltip-pending.test.js'], 'exactly the named test was run');
}

// ---- B. likely-fixed SOFT: no commit, the quoted defect code is gone, no test agrees ----
{
  const r = record(scratchReg, {
    title: 'penalize inert', slug: 'penalize-inert', surface: 'providers',
    sections: { Evidence: '`sidecar/index.js:10579` builds the pool with `.filter(s => s && s !== runKey)` so the primary is stripped.' }
  });
  const w = world({ bugs: [r], files: { 'sidecar/index.js': 'const pool = keys.filter(Boolean); // primary now ordered by credPool' } });
  const res = makeReconciler({ io: w.io, clock }).reconcile();
  const row = rowOf(res, r.bug.fingerprint);
  A.eq(row.verdict, 'likely-fixed', 'quoted defect code gone -> likely-fixed');
  A.eq(row.confidence, 'soft', 'no test agrees -> soft');
  A.ok(w.log.searches.length >= 1, 'a miss in the bound file falls back to a repo-wide search before calling it gone');
}

// ---- C. still-open: the quoted defect code is still present ----
{
  const r = record(scratchReg, {
    title: 'penalize still inert', slug: 'penalize-still', surface: 'providers',
    sections: { Evidence: '`sidecar/index.js:10579` builds the pool with `.filter(s => s && s !== runKey)`.' }
  });
  const w = world({ bugs: [r], files: { 'sidecar/index.js': 'const pool = keys.map(trim).filter(s => s && s !== runKey);' } });
  const row = rowOf(makeReconciler({ io: w.io, clock }).reconcile(), r.bug.fingerprint);
  A.eq(row.verdict, 'still-open', 'cited code still present -> still-open');
  A.ok(row.evidence.some(e => /still present/.test(e)), 'evidence says the line is still there');
}

// ---- D. still-open: a named test is RED, even though a commit claims the fix ----
{
  const r = record(scratchReg, {
    title: 'red regression', slug: 'red-regression', fix: 'abc1234',
    sections: { Evidence: 'repro: test/red.test.js', Verdict: 'landed in abc1234' }
  });
  const w = world({ bugs: [r], ancestors: { abc1234: true }, files: { 'test/red.test.js': '' }, pass: {} });
  const row = rowOf(makeReconciler({ io: w.io, clock }).reconcile(), r.bug.fingerprint);
  A.eq(row.verdict, 'still-open', 'a red named test outranks an ancestor commit');
  A.ok(row.evidence.some(e => /FAILS \(exit 1\)/.test(e)), 'evidence carries the exit code');
}

// ---- E. unverifiable: no anchor at all, and the row says what it needs ----
{
  const r = record(scratchReg, { title: 'prose only', slug: 'prose-only', sections: { Evidence: 'Saw it twice on the dev box, screenshot attached.' } });
  const w = world({ bugs: [r] });
  const res = makeReconciler({ io: w.io, clock }).reconcile();
  const row = rowOf(res, r.bug.fingerprint);
  A.eq(row.verdict, 'unverifiable', 'no anchor -> unverifiable');
  A.eq(row.needs.length, 3, 'the row lists the three anchor kinds it could carry');
  A.eq(res.grandfathered.length, 1, 'an anchor-less record found before the law is listed as grandfathered');
  A.eq(res.grandfathered[0].fingerprint, r.bug.fingerprint, '...by fingerprint');
}

// ---- F. unverifiable: anchors exist but none discriminates (existing coverage passes; file:line only) ----
{
  const r = record(scratchReg, {
    title: 'coverage only', slug: 'coverage-only',
    sections: { Evidence: 'Existing coverage: test/cover.test.js passes vacuously. See sidecar/loop.js:621.' }
  });
  const w = world({ bugs: [r], files: { 'test/cover.test.js': '', 'sidecar/loop.js': 'x' }, pass: { 'test/cover.test.js': true } });
  const row = rowOf(makeReconciler({ io: w.io, clock }).reconcile(), r.bug.fingerprint);
  A.eq(row.verdict, 'unverifiable', 'a passing pre-existing test + a bare file:line prove nothing');
  A.ok(row.needs.some(n => /REGRESSION test named in ## Verdict/.test(n)), 'it asks for a regression test');
  A.ok(row.needs.some(n => /quoted in backticks/.test(n)), 'it asks for the quoted defect code');
}

// ---- G. --no-run leaves tests unexecuted and reports them skipped ----
{
  const r = record(scratchReg, { title: 'skip run', slug: 'skip-run', fix: 'abc1234', sections: { Verdict: 'abc1234; test/skip.test.js' } });
  const w = world({ bugs: [r], ancestors: { abc1234: true }, files: { 'test/skip.test.js': '' }, pass: { 'test/skip.test.js': true } });
  const res = makeReconciler({ io: w.io, clock }).reconcile({ runTests: false });
  const row = rowOf(res, r.bug.fingerprint);
  A.eq(w.log.tests, [], 'runTests:false never spawns a test');
  A.eq(row.checks.tests[0].skipped, true, 'the skipped test is marked as such');
  A.eq(row.verdict, 'likely-fixed', 'the commit alone still decides');
  A.eq(row.confidence, 'soft', '...but only softly without the test');
}

// ---- G2. a host that DECLINES to run a test (http-gate suite) is not evidence either way ----
{
  const r = record(scratchReg, { title: 'http suite', slug: 'http-suite', fix: 'abc1234', sections: { Verdict: 'abc1234; regression test/x.http.test.js' } });
  const w = world({ bugs: [r], ancestors: { abc1234: true }, files: { 'test/x.http.test.js': '' } });
  w.io.runTest = () => ({ ok: null, code: null, ms: 0, tail: '', skipped: 'test:http gate suite' });
  const row = rowOf(makeReconciler({ io: w.io, clock }).reconcile(), r.bug.fingerprint);
  A.eq(row.verdict, 'likely-fixed', 'the commit still decides');
  A.eq(row.confidence, 'soft', 'a skipped regression cannot make it hard');
  A.eq(row.checks.tests[0].skipped, 'test:http gate suite', 'the skip reason is recorded');
  A.ok(row.evidence.some(e => /not run here \(test:http gate suite\)/.test(e)), 'the row says the test was not run here');
}

// ---- H. closed-record audit: a fixed record whose fix is NOT on this tree is flagged ----
{
  const good = record(scratchReg, { title: 'closed good', slug: 'closed-good', status: 'fixed', fix: 'aaaaaaa1', sections: { Verdict: 'done' } });
  const bad = record(scratchReg, { title: 'closed bad', slug: 'closed-bad', status: 'fixed', fix: 'bbbbbbb2', sections: { Verdict: 'done' } });
  const nosha = record(scratchReg, { title: 'closed nosha', slug: 'closed-nosha', status: 'fixed', fix: 'layer removed 2026-07-30', sections: { Verdict: 'done' } });
  const w = world({ bugs: [good, bad, nosha], ancestors: { aaaaaaa1: true, bbbbbbb2: false } });
  const res = makeReconciler({ io: w.io, clock }).reconcile();
  A.eq(res.summary.records.total, 0, 'closed records are not counted as open records');
  A.eq(res.summary.closedAudit, { total: 3, 'likely-fixed': 1, 'still-open': 1, unverifiable: 1, hard: 1 }, 'closed audit tallies on-tree / off-tree / no-sha');
  A.eq(rowOf(res, bad.bug.fingerprint).verdict, 'still-open', 'a fix that is not an ancestor is flagged still-open');
  A.ok(rowOf(res, bad.bug.fingerprint).evidence[0].includes('NOT an ancestor'), 'the audit row says why');
  A.eq(w.log.tests, [], 'the audit never runs tests (cheap by design)');
  A.ok(/Closed-record audit/.test(makeReconciler({ io: w.io, clock }).renderMarkdown(res)), 'the markdown carries the audit table');
}

// ---- I. Janitor finding mappings: worktree reaped / branch gone / branch merged / doc fixed ----
{
  const findings = [
    { id: 'a', fingerprint: 'f1', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-07-19'), title: 'Removable worktree: reaped-lane (branch merged + clean)', detail: '', evidence: ['x'] },
    { id: 'b', fingerprint: 'f2', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-07-19'), title: 'Removable worktree: live-lane (branch merged + clean)', detail: '', evidence: ['x'] },
    { id: 'c', fingerprint: 'f3', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-08-01'), title: 'Stranded branch: gone (3 ahead, idle 9d)', detail: 'Branch agent/gone has 3 unmerged', evidence: ['x'] },
    { id: 'd', fingerprint: 'f4', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-08-01'), title: 'Stranded branch: merged-now (3 ahead, idle 9d)', detail: 'Branch agent/merged-now has 3 unmerged', evidence: ['x'] },
    { id: 'e', fingerprint: 'f5', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-08-01'), title: 'Stranded branch: still-stranded (3 ahead, idle 9d)', detail: 'Branch agent/still-stranded has 3 unmerged', evidence: ['x'] },
    { id: 'f', fingerprint: 'f6', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-08-01'), title: 'Dead doc reference: docs/a.md cites missing sidecar/gone.js', detail: '', evidence: ['x'] },
    { id: 'g', fingerprint: 'f7', crew: 'Janitor', severity: 'P2', status: 'open', ts: Date.parse('2026-08-01'), title: 'Dead doc reference: docs/b.md cites missing sidecar/nope.js', detail: '', evidence: ['x'] },
    { id: 'h', fingerprint: 'f8', crew: 'Perfectionist', severity: 'P2', status: 'open', ts: Date.parse('2026-07-07'), title: 'UPDATE CENTER dock item has NO machine coverage', detail: 'no test', evidence: ['x'] },
    { id: 'i', fingerprint: 'f9', crew: 'Janitor', severity: 'P2', status: 'fixed', ts: 1, title: 'Removable worktree: already-fixed (branch merged + clean)', detail: '', evidence: ['x'] }
  ];
  const w = world({
    findings,
    worktrees: ['live-lane'],
    branches: ['agent/merged-now', 'agent/still-stranded'],
    merged: { 'agent/merged-now': true, 'agent/still-stranded': false },
    files: { 'docs/a.md': 'see sidecar/other.js now', 'docs/b.md': 'see sidecar/nope.js' }
  });
  const res = makeReconciler({ io: w.io, clock }).reconcile();
  const by = {}; for (const f of res.findings) by[f.fingerprint] = f;
  A.eq(res.findings.length, 8, 'a fixed finding is skipped; the rest are judged');
  A.eq(by.f1.verdict, 'likely-fixed', 'a reaped worktree is likely-fixed');
  A.eq(by.f1.confidence, 'hard', '...with hard confidence (git says it is gone)');
  A.eq(by.f2.verdict, 'still-open', 'a still-registered worktree is still-open');
  A.eq(by.f3.verdict, 'likely-fixed', 'a deleted branch is likely-fixed');
  A.eq(by.f4.verdict, 'likely-fixed', 'a now-merged branch is likely-fixed');
  A.eq(by.f5.verdict, 'still-open', 'a branch with unmerged commits is still-open');
  A.eq(by.f6.verdict, 'likely-fixed', 'a doc that no longer cites the missing file is likely-fixed');
  A.eq(by.f7.verdict, 'still-open', 'a doc still citing a missing file is still-open');
  A.eq(by.f8.verdict, 'unverifiable', 'a Perfectionist finding with no anchor is unverifiable');
  A.ok(/crew-specific mapping/.test(by.f8.needs[0]), 'its needs text is finding-shaped, not record-shaped');
  A.eq(by.f1.ageDays, 33, 'finding age is measured from ts to the injected today');
  A.eq(res.summary.findingsByCrew.Janitor, { 'likely-fixed': 4, 'still-open': 3, unverifiable: 0, total: 7 }, 'per-crew tally');
  const md = makeReconciler({ io: w.io, clock }).renderMarkdown(res);
  A.ok(/\| Janitor \| 7 \| 4 \| 3 \| 0 \|/.test(md), 'the markdown carries the per-crew table');
}

// ---- J. --ci: a likely-fixed record still open past N days is red; fresh or closed ones are not ----
{
  const stale = record(scratchReg, { title: 'stale fixed', slug: 'stale-fixed', found: '2026-08-01', fix: 'abc1234', sections: { Verdict: 'abc1234' } });
  const fresh = record(scratchReg, { title: 'fresh fixed', slug: 'fresh-fixed', found: '2026-08-18', fix: 'abc1234', sections: { Verdict: 'abc1234' } });
  const open = record(scratchReg, { title: 'truly open', slug: 'truly-open', found: '2026-07-01', sections: { Evidence: '`sidecar/x.js` has `if (a == b) return;`' } });
  const w = world({ bugs: [stale, fresh, open], ancestors: { abc1234: true }, files: { 'sidecar/x.js': 'if (a == b) return;' } });
  const R = makeReconciler({ io: w.io, clock });
  const res = R.reconcile();
  const ci = R.ciVerdict(res, { staleDays: 7 });
  A.eq(ci.ok, false, 'one stale likely-fixed record turns CI red');
  A.eq(ci.stale.map(r => r.fingerprint), [stale.bug.fingerprint], 'only the 20-day-old likely-fixed record is stale (the 3-day one and the still-open one are not)');
  A.eq(R.ciVerdict(res, { staleDays: 30 }).ok, true, 'a wider window is green');
  A.eq(R.ciVerdict(res).staleDays, 7, 'the default window is 7 days');
  A.eq(R.ciVerdict(res, { staleDays: 0 }).stale.length, 2, 'N=0 flags every likely-fixed open record');
}

// ---- K. Law 7 through the register core: a new anchor-less record cannot be filed validly ----
{
  const io = { files: [], listBugs() { return this.files.slice(); }, writeBug(file, text) { this.files.push({ file, text }); }, knownFingerprints: () => [] };
  const reg = makeBugRegister({ io, clock });
  const res = reg.create({ title: 'new prose bug', surface: 'world' });          // found = TODAY (law applies)
  A.eq(res.status, 'created', 'create still scaffolds (the gate is validate, wired into test:fast)');
  const bug = res.bug;
  bug.sections = { Symptom: 's', Repro: '1. do it', Evidence: 'Saw it. No artifact path, no test, no code.', Verdict: '' };
  io.files = [{ file: bug.file, text: reg.render(bug) }];
  const v = reg.validate();
  A.eq(v.ok, false, 'an anchor-less record found today fails validate');
  A.ok(v.errors.some(e => /no machine-checkable anchor/.test(e)), 'the error names the anchor law');
  bug.sections.Evidence = 'Repro: test/new-prose.test.js (red on trunk).';
  io.files = [{ file: bug.file, text: reg.render(bug) }];
  A.eq(reg.validate().ok, true, 'naming a repro test satisfies it');
  // and the reconciler can now say something about it
  const w = world({ bugs: io.files, files: {} });
  const row = rowOf(makeReconciler({ io: w.io, clock }).reconcile(), bug.fingerprint);
  A.eq(row.verdict, 'unverifiable', 'a named test that does not exist yet is not evidence either way');
  A.ok(row.evidence.some(e => /does not exist/.test(e)), '...and the row says the test file is missing');
}

// ---- L. the REAL io shell against a throwaway git repo (isAncestor / branchMerged / worktrees / runTest) ----
{
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // The CLI's module graph, copied from the repository into the fixture at the same relative paths: the entry file,
  // then every file it reaches by a relative static or dynamic import (`from './x.mjs'`, `import './x.mjs'`,
  // `import('../x.mjs')`). Read and written as text, not copyFileSync, so a mutation preload that wraps
  // fs.readFileSync reaches the copy. A file the graph misses fails the CLI run with ERR_MODULE_NOT_FOUND, which the
  // exit-0 check prints. Returns the copied paths, entry first.
  const copyModuleGraph = (repo, fixture, entryRel) => {
    const copied = [];
    const visit = (rel) => {
      if (copied.includes(rel)) return;
      copied.push(rel);
      const text = fs.readFileSync(path.join(repo, rel), 'utf8');
      fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
      fs.writeFileSync(path.join(fixture, rel), text);
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])(\.\.?\/[^'"\r\n]+)\1/gm)) {
        visit(path.posix.join(path.posix.dirname(rel), m[2]));
      }
    };
    visit(entryRel);
    return copied;
  };
  let root = null;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-reconcile-'));
    git(root, ['init', '-q', '-b', 'trunk']);
    git(root, ['config', 'user.email', 't@example.com']);
    git(root, ['config', 'user.name', 'T']);
    fs.mkdirSync(path.join(root, 'sidecar'));
    fs.mkdirSync(path.join(root, 'test'));
    fs.mkdirSync(path.join(root, 'qa', 'bugs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sidecar', 'x.js'), 'module.exports = 1; // if (a == b) return;\n');
    fs.writeFileSync(path.join(root, 'test', 'green.test.js'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(root, 'test', 'red.test.js'), 'process.exit(1);\n');
    fs.writeFileSync(path.join(root, 'test', 'http.list'), '# gate\ntest/red.test.js\n');
    fs.writeFileSync(path.join(root, 'test', 'env.test.js'), "process.exit(process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.includes('starnet-reconcile-profile-') ? 0 : 1);\n");
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    git(root, ['branch', 'agent/merged']);
    git(root, ['checkout', '-q', '-b', 'agent/ahead']);
    fs.writeFileSync(path.join(root, 'ahead.txt'), 'x');
    git(root, ['add', 'ahead.txt']);
    git(root, ['commit', '-q', '-m', 'ahead']);
    const aheadSha = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', 'trunk']);
    const wt = path.join(root, 'wt-live');
    git(root, ['worktree', 'add', '-q', wt, 'agent/merged']);

    const io = realIo(root);
    A.eq(io.headSha(), base, 'headSha reads the real HEAD');
    A.eq(io.isAncestor(base), true, 'HEAD is its own ancestor');
    A.eq(io.isAncestor(aheadSha), false, 'a commit on another branch is not an ancestor');
    A.eq(io.isAncestor('0123456789abcdef'), null, 'an unknown sha is null, not false');
    A.eq(io.branchExists('agent/merged'), true, 'branchExists sees a real branch');
    A.eq(io.branchExists('agent/nope'), false, '...and not a missing one');
    A.eq(io.branchMerged('agent/merged'), true, 'a branch at HEAD is merged');
    A.eq(io.branchMerged('agent/ahead'), false, 'a branch with its own commit is not');
    A.ok(io.worktrees().includes('wt-live'), 'worktrees lists the added worktree by basename');
    A.eq(io.fileExists('sidecar/x.js'), true, 'fileExists reads the tree');
    A.eq(io.searchCode('if (a == b) return;'), ['sidecar/x.js'], 'searchCode finds an exact substring under the code roots');
    A.eq(io.runTest('test/green.test.js').ok, true, 'runTest runs a real node file (green)');
    A.eq(io.runTest('test/red.test.js').skipped, 'test:http gate suite', 'a suite on test/http.list is skipped, not run');
    A.eq(realIo(root, { runHttp: true }).runTest('test/red.test.js').code, 1, '--http runs it and reports the red exit code');
    A.eq(io.runTest('test/env.test.js').ok, true, 'a test runs under the hermetic app-data profile (LOCALAPPDATA is a scratch dir)');

    // one stale likely-fixed record on disk (found 2026-07-01, fixed by the fixture's HEAD): the core judges it through
    // realIo(root) below, and the CLI must exit 3 on it under --ci.
    const reg = makeBugRegister({ io: { listBugs: () => [], writeBug() {}, knownFingerprints: () => [] }, clock });
    const rec = record(reg, { title: 'stale on disk', slug: 'stale-on-disk', found: '2026-07-01', fix: base, sections: { Verdict: 'fixed in ' + base + '; regression test/green.test.js' } });
    fs.writeFileSync(path.join(root, 'qa', 'bugs', rec.file), rec.text);
    // the verdict, through the core over realIo(root) with the injected clock (the CLI dates by the real clock, so the
    // exact age is asserted here); the CLI below is held to its arg, exit and --json surface.
    const R = makeReconciler({ io: realIo(root), clock });
    const res = R.reconcile();
    const row = res.records[0];
    A.eq(row.verdict, 'likely-fixed', 'real git: the fix commit is an ancestor');
    A.eq(row.confidence, 'hard', 'real node: the regression passes -> hard');
    A.eq(R.ciVerdict(res, { staleDays: 7 }).ok, false, 'real clock-free ci: 51 days open -> red');

    // THE CLI, ON THE FIXTURE (R9). The CLI roots itself at path.resolve(its dir, '..', '..'), so run where it lives it
    // scans this whole repository: 389 bug records and 2549 code files at 0b8441064, which took 318-543 s on a loaded
    // box and hit the 300 s spawnSync timeout (ETIMEDOUT), only to check this surface. A byte copy of its module graph
    // under the fixture's scripts/qa/ runs the same entry code rooted at the fixture, in seconds, and its JSON can be
    // held to the fixture's HEAD and its one record, which a run over the repository could never pass.
    const repo = path.resolve(__dirname, '..');
    const graph = copyModuleGraph(repo, root, 'scripts/qa/ledger-reconcile.mjs');
    A.ok(graph.includes('scripts/qa/bugs.mjs') && graph.includes('scripts/qa/bug-lifecycle.mjs'), 'the copy follows the entry file\'s imports (copied: ' + graph.join(', ') + ')');
    // realpath, as Node does for the main module, so INVOKED_DIRECTLY (import.meta.url against argv[1]) holds even
    // where the tmpdir sits behind a link (macOS /var -> /private/var).
    const cli = fs.realpathSync(path.join(root, 'scripts', 'qa', 'ledger-reconcile.mjs'));
    const runCli = (args) => spawnSync(process.execPath, [cli].concat(args), { cwd: root, encoding: 'utf8', timeout: 60000 });
    const why = (r) => ' (spawn error: ' + (r.error ? r.error.message : 'none') + '; stderr: ' + String(r.stderr).slice(0, 300) + ')';
    const run = runCli(['--no-write', '--no-run', '--json', '--ci', '--stale-days', '99999']);
    A.eq(run.status, 0, 'the CLI exits 0 under --ci with an absurd stale window' + why(run));
    let parsed = null;
    try { parsed = JSON.parse(run.stdout); } catch (_) { parsed = null; }
    A.ok(parsed && Array.isArray(parsed.records) && parsed.summary, '--json prints the result object');
    const recs = parsed && Array.isArray(parsed.records) ? parsed.records : [];
    A.ok(parsed && parsed.head === base && recs.length === 1 && recs[0].fingerprint === rec.bug.fingerprint,
      '--json judges the fixture alone: its HEAD and its one record (head ' + (parsed ? parsed.head : 'none') + ', ' + recs.length + ' record(s))');
    const red = runCli(['--no-write', '--no-run', '--ci']);
    A.eq(red.status, 3, '--ci with the default 7-day window exits 3 on the stale record' + why(red));
    A.ok(String(red.stderr).includes('CI RED') && String(red.stderr).includes(rec.bug.fingerprint), '...and names it on stderr: CI RED and its fingerprint' + why(red));
    A.ok(String(red.stdout).startsWith('# '), 'without --json, stdout is the markdown report');
    A.eq(fs.existsSync(path.join(root, 'qa', 'digests')), false, '--no-write writes no digest');
    // the real entry point, where it lives: a bad window is refused before any scan, so this costs one node start.
    const bad = spawnSync(process.execPath, [path.join(repo, 'scripts', 'qa', 'ledger-reconcile.mjs'), '--stale-days', '-1'], { cwd: repo, encoding: 'utf8', timeout: 60000 });
    A.eq(bad.status, 1, 'a negative --stale-days is refused with exit 1');
    A.ok(String(bad.stderr).includes('--stale-days must be a non-negative number'), '...with its message (stderr: ' + String(bad.stderr).slice(0, 200) + ')');
  } catch (e) {
    A.ok(false, 'real-git smoke threw: ' + (e && e.message));
  } finally {
    if (root) { try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' }); } catch (_) { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  }
}

A.report('ledger-reconcile.test');
