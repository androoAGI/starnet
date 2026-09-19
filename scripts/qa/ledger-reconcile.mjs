#!/usr/bin/env node
/* scripts/qa/ledger-reconcile.mjs — LEDGER TRUTH (`npm run qa:reconcile`).
 *
 * WHY THIS EXISTS: the bug register drifts stale in the FIXED direction. An audit found ~25 of
 * 28 "open" `qa/bugs/` records already fixed on trunk, and `ledger.mjs --status` carried
 * hundreds of open Janitor rows for worktrees reaped weeks ago. A register that over-reports
 * open defects stops being a backlog authority and becomes noise: lanes re-build fixes that
 * already shipped (docs/MISTAKES.md law #2 — plan docs lie within hours; the register is a
 * plan doc too). Nobody re-reads 40 records by hand, so the re-check has to be a machine.
 *
 * WHAT IT DOES: for every record (open by default, `--all` for the closed-record audit too) and
 * every ledger finding it can map, it gathers TRUNK EVIDENCE automatically, from the record's own
 * machine-checkable anchors (scripts/qa/bugs.mjs `extractAnchors` — shared, so the validator
 * and the reconciler can never disagree about what an anchor is):
 *   (1) a fix commit the record names   -> `git merge-base --is-ancestor <sha> HEAD`
 *   (2) a test file the record names    -> does it exist, does `node <file>` pass
 *   (3) a file[:line] / code snippet    -> does the cited defect code still exist in that file
 * and for ledger findings it can map by crew + title shape (Janitor: removable worktree,
 * stranded branch, dead doc reference) it asks git/fs whether the subject still exists.
 *
 * VERDICTS (one row per record / finding):
 *   likely-fixed  — the fix commit is an ancestor, or the cited defect code is gone, or a named
 *                   test passes with the cited code gone. `confidence: hard` when BOTH a commit
 *                   (or the code being gone) AND a passing named test agree; `soft` otherwise.
 *   still-open    — a named test FAILS, or the cited defect code is still present and nothing
 *                   says it was fixed.
 *   unverifiable  — no machine-checkable anchor (the row says WHICH anchor it needs).
 *
 * THIS TOOL CLOSES NOTHING. A closure still goes through the official register flow
 * (`bugs.mjs --set <fp> --status fixed --fix <sha> --verdict "..."`) with a human reading the
 * evidence this report lays out; `--ci` only turns a stale likely-fixed row into a red gate.
 *
 * HOUSE PATTERN (ledger.mjs / bugs.mjs / janitor.mjs): the CORE is a PURE factory
 * `makeReconciler({ io, clock })` — no ambient fs/git/time; the host injects everything, so the
 * verdict logic tests headlessly and deterministically (test/ledger-reconcile.test.js). The CLI
 * at the foot is the ONLY place fs + child_process + Date live.
 *
 * io contract:
 *   listBugs()          -> [{ file, text }]          (qa/bugs/*.md)
 *   listFindings()      -> finding[]                 (qa/findings/*.json — machine-local)
 *   headSha()           -> string
 *   isAncestor(sha)     -> true | false | null       (null = sha unknown to this repo)
 *   fileExists(rel)     -> bool
 *   readFile(rel)       -> string | null
 *   runTest(rel)        -> { ok, code, ms, tail }    (node <rel>, cwd = repo root)
 *   searchCode(text)    -> [rel]                     (exact substring search over code roots)
 *   worktrees()         -> [name]                    (git worktree list, basenames)
 *   branchExists(name)  -> bool
 *   branchMerged(name)  -> true | false | null       (merged into HEAD?)
 *
 * makeReconciler({ io, clock }) -> {
 *   reconcile({ all, runTests, staleDays }) -> { head, date, records[], findings[], grandfathered[], summary }
 *   renderMarkdown(result)                  -> string
 *   ciVerdict(result, { staleDays })        -> { ok, stale[] }
 * }
 *
 * CLI:
 *   node scripts/qa/ledger-reconcile.mjs [--all] [--no-run] [--http] [--json] [--no-write]
 *                                        [--findings-dir <dir>] [--ci [--stale-days N]]
 *   Named tests run under the gate's hermetic app-data profile; suites on test/http.list are
 *   skipped (reported as "not run here") unless --http.
 *   Writes qa/digests/reconcile-<date>.md + .json (the digests convention; machine-local) unless
 *   --no-write. --json prints the JSON result to stdout instead of the markdown.
 * Exit code: 0; with --ci, 3 when a likely-fixed record is still open and older than N days
 *   (default 7), 2 when the register itself cannot be read.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeBugRegister, extractAnchors, anchorLawApplies } from './bugs.mjs';
import { isEscape } from './bug-lifecycle.mjs';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

const DAY_MS = 86400000;
const ACTIVE = new Set(['open', 'claimed']);
const VERDICTS = Object.freeze(['likely-fixed', 'still-open', 'unverifiable']);

function str(v) { return v == null ? '' : String(v); }
function trimmed(v) { return str(v).trim(); }
function normWs(s) { return str(s).replace(/\s+/g, ' ').trim(); }
function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / DAY_MS));
}

// A snippet with an ellipsis was abbreviated by the author; it can never be matched exactly and
// must not be read as "gone". A snippet bound to a TEST file is quoted coverage, not defect code.
function checkableSnippet(s) {
  if (/…|\.\.\./.test(s.text)) return false;
  if (/^test\//.test(s.file)) return false;
  return true;
}

export function makeReconciler(opts) {
  opts = opts || {};
  const io = opts.io || {};
  const clock = opts.clock || { today() { return '1970-01-01'; } };
  const call = (name, fallback) => (...args) => {
    try { return typeof io[name] === 'function' ? io[name](...args) : fallback; }
    catch (_) { return fallback; }
  };
  const listBugs = call('listBugs', []);
  const listFindings = call('listFindings', []);
  const headSha = call('headSha', '');
  const isAncestor = call('isAncestor', null);
  const fileExists = call('fileExists', false);
  const readFile = call('readFile', null);
  const runTest = call('runTest', { ok: false, code: -1, ms: 0, tail: 'io.runTest missing' });
  const searchCode = call('searchCode', []);
  const worktrees = call('worktrees', []);
  const branchExists = call('branchExists', false);
  const branchMerged = call('branchMerged', null);

  function today() {
    try { return trimmed(clock.today && clock.today()) || '1970-01-01'; }
    catch (_) { return '1970-01-01'; }
  }

  // ---- evidence gathering for one bug record -------------------------------------------------
  // Returns { verdict, confidence, evidence[], needs[] , checks:{...} }. Everything the verdict
  // rests on is spelled out in `evidence` so a human can read the row and agree or not.
  function judgeRecord(bug, o) {
    o = o || {};
    const anchors = bug.anchors || extractAnchors(bug);
    const evidence = [];
    const needs = [];
    const checks = { commits: [], tests: [], files: [], snippets: [] };

    // (1) fix commits — is each an ancestor of HEAD?
    let ancestorSha = '';
    let unknownSha = false;
    for (const sha of anchors.commits) {
      const anc = isAncestor(sha);
      checks.commits.push({ sha, ancestor: anc });
      if (anc === true) { if (!ancestorSha) ancestorSha = sha; evidence.push('fix commit ' + sha + ' is an ancestor of HEAD'); }
      else if (anc === false) evidence.push('named commit ' + sha + ' is NOT an ancestor of HEAD');
      else { unknownSha = true; evidence.push('named commit ' + sha + ' is unknown to this repo'); }
    }

    // (2) named tests — exist? pass?
    let testPass = 0, testFail = 0, testMissing = 0, regressionPass = 0;
    for (const t of anchors.tests) {
      const exists = fileExists(t);
      const isRegression = anchors.regressionTests.includes(t);
      if (!exists) { testMissing++; checks.tests.push({ file: t, exists: false, ok: null, regression: isRegression }); evidence.push('named test ' + t + ' does not exist'); continue; }
      if (o.runTests === false) { checks.tests.push({ file: t, exists: true, ok: null, regression: isRegression, skipped: true }); continue; }
      const r = runTest(t) || {};
      if (r.skipped) {
        // the host declined to run it (an http-gate suite): not evidence either way, and said so.
        checks.tests.push({ file: t, exists: true, ok: null, regression: isRegression, skipped: r.skipped });
        evidence.push('named test ' + t + ' not run here (' + r.skipped + ')');
        continue;
      }
      checks.tests.push({ file: t, exists: true, ok: !!r.ok, code: r.code, ms: r.ms, regression: isRegression, tail: str(r.tail).slice(-400) });
      if (r.ok) { testPass++; if (isRegression) regressionPass++; evidence.push((isRegression ? 'regression test ' : 'named test ') + t + ' passes'); }
      else { testFail++; evidence.push('named test ' + t + ' FAILS (exit ' + r.code + ')'); }
    }

    // (3) cited files + quoted defect code — still there?
    let fileMissing = 0, filePresent = 0;
    const seenFile = new Set();
    for (const f of anchors.files) {
      if (seenFile.has(f.file)) continue;
      seenFile.add(f.file);
      const exists = fileExists(f.file);
      checks.files.push({ file: f.file, exists });
      if (exists) filePresent++; else { fileMissing++; evidence.push('cited file ' + f.file + ' no longer exists'); }
    }
    let snipPresent = 0, snipGone = 0, snipChecked = 0;
    const fileCache = new Map();
    const textOf = (file) => {
      if (!fileCache.has(file)) { const t = readFile(file); fileCache.set(file, t == null ? null : normWs(t)); }
      return fileCache.get(file);
    };
    for (const s of anchors.snippets) {
      if (!checkableSnippet(s)) { checks.snippets.push({ text: s.text, file: s.file, present: null, skipped: true }); continue; }
      const want = normWs(s.text);
      let present = null, where = '';
      if (s.file) {
        const body = textOf(s.file);
        if (body != null) { present = body.includes(want); where = s.file; }
      }
      if (present !== true) {
        // not in the bound file (or unbound): an exact search across the code roots decides. A
        // moved line is still the same defect, so "present somewhere" beats "gone from here".
        const hits = searchCode(s.text) || [];
        if (hits.length) { present = true; where = hits[0]; }
        else if (present == null) present = false;
      }
      snipChecked++;
      checks.snippets.push({ text: s.text, file: s.file, present, where });
      if (present) snipPresent++; else snipGone++;
    }
    if (snipChecked) {
      if (snipGone && !snipPresent) evidence.push('all ' + snipGone + ' quoted defect line(s) are gone from the tree');
      else if (snipPresent && !snipGone) evidence.push('all ' + snipPresent + ' quoted line(s) are still present');
      else evidence.push(snipPresent + ' of ' + snipChecked + ' quoted line(s) still present');
    }

    // ---- the verdict -------------------------------------------------------------------------
    const hasAnchor = anchors.count > 0 || anchors.commits.length > 0;
    let verdict, confidence = '';
    if (!hasAnchor) {
      verdict = 'unverifiable';
      needs.push('a repro test path (test/x.test.js)', 'a file:line citation (sidecar/x.js:123)', 'the defective code quoted in backticks');
    } else if (testFail) {
      verdict = 'still-open';
      evidence.unshift('a named test is red on this tree');
    } else if (isEscape(bug) && !trimmed(bug.fix)) {
      verdict = 'unverifiable';
      needs.push('an explicit source-fix commit for this reported symptom; related repairs, passing baseline tests and removed files do not establish customer causality');
    } else if (ancestorSha) {
      verdict = 'likely-fixed';
      confidence = (regressionPass || (testPass && snipChecked && !snipPresent)) ? 'hard' : 'soft';
    } else if (snipChecked && !snipPresent) {
      verdict = 'likely-fixed';
      confidence = testPass ? 'hard' : 'soft';
    } else if (snipPresent) {
      verdict = 'still-open';
    } else if (fileMissing && !filePresent && !snipChecked) {
      verdict = 'likely-fixed';
      confidence = 'soft';
      evidence.push('every cited file is gone (renamed or removed) — confirm by hand');
    } else {
      // anchors exist but none discriminates (e.g. only existing-coverage tests that pass, or
      // only file citations that still exist). Say exactly what would make it decidable.
      verdict = 'unverifiable';
      if (anchors.tests.length && !anchors.regressionTests.length) needs.push('a REGRESSION test named in ## Verdict (existing coverage passing proves nothing — it passed before the fix too)');
      if (anchors.files.length && !snipChecked) needs.push('the defective code quoted in backticks so presence can be checked (a file:line alone only proves the file exists)');
      if (unknownSha) needs.push('a commit sha this repo knows (the named one resolves to nothing)');
      if (!needs.length) needs.push('a repro test path or the defective code quoted in backticks');
    }
    return { verdict, confidence, evidence, needs, checks, anchors };
  }

  // ---- evidence gathering for one LEDGER finding ---------------------------------------------
  // Findings do not carry their checkId/subject on disk, so the crew + title shape is the map.
  function judgeFinding(f, o) {
    const title = trimmed(f.title);
    const detail = str(f.detail);
    const crew = trimmed(f.crew);
    const evidence = [];
    let m;
    if (crew === 'Janitor' && (m = /^Removable worktree:\s+(\S+)/.exec(title))) {
      const name = m[1];
      const live = (worktrees() || []).map(trimmed);
      const present = live.includes(name);
      evidence.push(present ? 'worktree ' + name + ' is still registered' : 'worktree ' + name + ' is no longer registered (reaped)');
      return { verdict: present ? 'still-open' : 'likely-fixed', confidence: present ? '' : 'hard', evidence, needs: [], kind: 'removable-worktree' };
    }
    if (crew === 'Janitor' && (m = /^Stranded branch:\s+(\S+)/.exec(title))) {
      const dm = /Branch\s+(\S+)\s+has/.exec(detail);
      const branch = dm ? dm[1] : m[1];
      if (!branchExists(branch)) {
        evidence.push('branch ' + branch + ' no longer exists');
        return { verdict: 'likely-fixed', confidence: 'hard', evidence, needs: [], kind: 'stranded-branch' };
      }
      const merged = branchMerged(branch);
      if (merged === true) {
        evidence.push('branch ' + branch + ' is fully merged into HEAD');
        return { verdict: 'likely-fixed', confidence: 'hard', evidence, needs: [], kind: 'stranded-branch' };
      }
      evidence.push('branch ' + branch + ' still exists' + (merged === false ? ' with unmerged commits' : ''));
      return { verdict: 'still-open', confidence: '', evidence, needs: [], kind: 'stranded-branch' };
    }
    if (crew === 'Janitor' && (m = /^Dead doc reference:\s+(\S+)\s+cites missing\s+(\S+)/.exec(title))) {
      const doc = m[1], target = m[2];
      if (!fileExists(doc)) { evidence.push('citing doc ' + doc + ' is gone'); return { verdict: 'likely-fixed', confidence: 'hard', evidence, needs: [], kind: 'dead-doc-reference' }; }
      if (fileExists(target)) { evidence.push('cited file ' + target + ' now exists'); return { verdict: 'likely-fixed', confidence: 'hard', evidence, needs: [], kind: 'dead-doc-reference' }; }
      const body = readFile(doc);
      if (body != null && !body.includes(target)) { evidence.push(doc + ' no longer cites ' + target); return { verdict: 'likely-fixed', confidence: 'hard', evidence, needs: [], kind: 'dead-doc-reference' }; }
      evidence.push(doc + ' still cites missing ' + target);
      return { verdict: 'still-open', confidence: '', evidence, needs: [], kind: 'dead-doc-reference' };
    }
    // any other crew: treat title + detail as a record body and reuse the record judgement.
    const pseudo = { fingerprint: f.fingerprint, fix: '', sections: { Evidence: title + '\n' + detail } };
    pseudo.anchors = extractAnchors(pseudo);
    const j = judgeRecord(pseudo, o);
    if (j.verdict === 'unverifiable') {
      // a finding has no ## Verdict to name a regression in; say what its title/detail would need.
      j.needs = ['a test path (test/x.test.js) or the defective code quoted in backticks in the finding title/detail — or a crew-specific mapping in ledger-reconcile.mjs judgeFinding()'];
    }
    return Object.assign(j, { kind: 'by-anchor' });
  }

  function reconcile(o) {
    o = o || {};
    const date = today();
    const reg = makeBugRegister({ io: { listBugs, writeBug() {}, knownFingerprints() { return []; } }, clock: { today } });
    const v = reg.validate();                           // parse every file; validity is reported, never fatal
    const bugs = v.bugs;
    const records = [];
    const grandfathered = [];
    for (const b of bugs) {
      const active = ACTIVE.has(b.status);
      if (!active && !o.all) {
        // closed-record audit is cheap and always on: is the recorded fix actually on this tree?
        const anc = b.anchors.commits.length ? isAncestor(b.anchors.commits[0]) : null;
        records.push({
          fingerprint: b.fingerprint, file: b.file, title: b.title, surface: b.surface, severity: b.severity,
          status: b.status, found: b.found, ageDays: daysBetween(b.found, date), fix: b.fix,
          verdict: anc === false ? 'still-open' : (anc === true ? 'likely-fixed' : 'unverifiable'),
          confidence: anc === true ? 'hard' : '',
          evidence: anc === true ? ['fix commit ' + b.anchors.commits[0] + ' is an ancestor of HEAD']
            : anc === false ? ['recorded fix ' + b.anchors.commits[0] + ' is NOT an ancestor of HEAD — the closure is not on this tree']
            : ['fix field names no commit sha this repo knows (' + (b.fix || 'empty') + ')'],
          needs: anc == null ? ['a fix commit sha'] : [],
          audit: true
        });
        continue;
      }
      const j = judgeRecord(b, { runTests: o.runTests !== false });
      if (!anchorLawApplies(b) && b.anchors.count === 0) grandfathered.push({ fingerprint: b.fingerprint, file: b.file, found: b.found, status: b.status });
      records.push({
        fingerprint: b.fingerprint, file: b.file, title: b.title, surface: b.surface, severity: b.severity,
        status: b.status, found: b.found, ageDays: daysBetween(b.found, date), fix: b.fix,
        verdict: j.verdict, confidence: j.confidence, evidence: j.evidence, needs: j.needs,
        checks: j.checks, audit: !active
      });
    }

    const findings = [];
    const todayMs = Date.parse(date);
    for (const f of (listFindings() || [])) {
      if (!f || typeof f !== 'object') continue;
      const st = trimmed(f.status).toLowerCase() || 'open';
      if (st === 'fixed' || st === 'dismissed') continue;
      const j = judgeFinding(f, { runTests: o.runTests !== false });
      const ts = Number(f.ts) || 0;
      findings.push({
        id: str(f.id), fingerprint: str(f.fingerprint), crew: trimmed(f.crew), severity: trimmed(f.severity), title: trimmed(f.title).slice(0, 160),
        status: st, ts, ageDays: (ts && isFinite(todayMs)) ? Math.max(0, Math.floor((todayMs - ts) / DAY_MS)) : null,
        verdict: j.verdict, confidence: j.confidence, evidence: j.evidence, needs: j.needs, kind: j.kind
      });
    }

    const tally = (rows) => { const t = { 'likely-fixed': 0, 'still-open': 0, unverifiable: 0, hard: 0 }; for (const r of rows) { t[r.verdict]++; if (r.confidence === 'hard') t.hard++; } return t; };
    const openRecords = records.filter(r => !r.audit);
    const byCrew = {};
    for (const f of findings) {
      const c = byCrew[f.crew] || (byCrew[f.crew] = { 'likely-fixed': 0, 'still-open': 0, unverifiable: 0, total: 0 });
      c[f.verdict]++; c.total++;
    }
    return {
      head: headSha(), date, registerValid: v.ok, registerErrors: v.errors,
      records, findings, grandfathered,
      summary: {
        records: Object.assign({ total: openRecords.length }, tally(openRecords)),
        closedAudit: Object.assign({ total: records.length - openRecords.length }, tally(records.filter(r => r.audit))),
        findings: Object.assign({ total: findings.length }, tally(findings)),
        findingsByCrew: byCrew,
        grandfathered: grandfathered.length
      }
    };
  }

  // --ci: a likely-fixed record that is still open/claimed and older than staleDays is a red gate.
  // Findings never gate (machine-local, differ per box); they are listed for the Overseer.
  function ciVerdict(result, o) {
    o = o || {};
    const staleDays = (typeof o.staleDays === 'number' && isFinite(o.staleDays)) ? o.staleDays : 7;
    const stale = (result.records || []).filter(r => !r.audit && r.verdict === 'likely-fixed' && ACTIVE.has(r.status) && (r.ageDays == null || r.ageDays > staleDays));
    return { ok: stale.length === 0, staleDays, stale };
  }

  function renderMarkdown(r) {
    const L = [];
    const s = r.summary;
    L.push('# Ledger reconcile — ' + r.date + (r.head ? ' @ ' + r.head.slice(0, 9) : ''));
    L.push('');
    L.push('_Generated by `npm run qa:reconcile`. Verdicts are EVIDENCE, not closures: a record leaves the register only through `bugs.mjs --set ... --status fixed --fix <sha>` with a human reading the row._');
    L.push('');
    L.push('**Open records:** ' + s.records.total + ' — ' + s.records['likely-fixed'] + ' likely-fixed (' + s.records.hard + ' hard) · ' +
      s.records['still-open'] + ' still-open · ' + s.records.unverifiable + ' unverifiable' +
      (s.grandfathered ? ' · ' + s.grandfathered + ' grandfathered (anchor-less, pre-' + '2026-08-21)' : ''));
    L.push('**Closed-record audit:** ' + s.closedAudit.total + ' — ' + s.closedAudit['likely-fixed'] + ' fix on tree · ' + s.closedAudit['still-open'] + ' fix NOT on tree · ' + s.closedAudit.unverifiable + ' no sha');
    L.push('**Ledger findings (open, machine-local):** ' + s.findings.total + ' — ' + s.findings['likely-fixed'] + ' likely-fixed · ' + s.findings['still-open'] + ' still-open · ' + s.findings.unverifiable + ' unverifiable');
    if (!r.registerValid) { L.push(''); L.push('**REGISTER INVALID** — ' + r.registerErrors.length + ' violation(s); run `npm run qa:bugs:validate`.'); }
    L.push('');
    const cell = (v) => str(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const rows = r.records.filter(x => !x.audit);
    if (rows.length) {
      L.push('## Records');
      L.push('');
      L.push('| Verdict | Conf | Sev | Status | Age | Record | Evidence / what it needs |');
      L.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const x of rows.slice().sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || (b.ageDays || 0) - (a.ageDays || 0))) {
        const ev = x.verdict === 'unverifiable' ? 'needs: ' + x.needs.join('; ') : x.evidence.join('; ');
        L.push('| ' + x.verdict + ' | ' + (x.confidence || '—') + ' | ' + x.severity + ' | ' + x.status + ' | ' + (x.ageDays == null ? '—' : x.ageDays + 'd') +
          ' | [' + cell(x.fingerprint) + '](bugs/' + x.file + ') ' + cell(x.title).slice(0, 80) + ' | ' + cell(ev) + ' |');
      }
      L.push('');
    }
    const audit = r.records.filter(x => x.audit);
    if (audit.length) {
      L.push('## Closed-record audit (is the recorded fix on this tree?)');
      L.push('');
      L.push('| Verdict | Status | Fix | Record | Evidence |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const x of audit) L.push('| ' + x.verdict + ' | ' + x.status + ' | ' + cell(x.fix).slice(0, 24) + ' | ' + cell(x.fingerprint) + ' ' + cell(x.title).slice(0, 70) + ' | ' + cell(x.evidence.join('; ')) + ' |');
      L.push('');
    }
    if (r.grandfathered.length) {
      L.push('## Grandfathered (anchor-less, found before the Law 7 date)');
      L.push('');
      for (const g of r.grandfathered) L.push('- `' + g.fingerprint + '` ' + g.file + ' (found ' + g.found + ', ' + g.status + ') — back-fill a test path, file:line or quoted code');
      L.push('');
    }
    if (r.findings.length) {
      L.push('## Ledger findings');
      L.push('');
      L.push('| Crew | Total | likely-fixed | still-open | unverifiable |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const c of Object.keys(s.findingsByCrew).sort()) { const t = s.findingsByCrew[c]; L.push('| ' + c + ' | ' + t.total + ' | ' + t['likely-fixed'] + ' | ' + t['still-open'] + ' | ' + t.unverifiable + ' |'); }
      L.push('');
      L.push('| Verdict | Crew | Sev | Age | Finding | Evidence |');
      L.push('| --- | --- | --- | --- | --- | --- |');
      const sorted = r.findings.slice().sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || a.crew.localeCompare(b.crew) || (b.ageDays || 0) - (a.ageDays || 0));
      for (const f of sorted) L.push('| ' + f.verdict + ' | ' + f.crew + ' | ' + f.severity + ' | ' + (f.ageDays == null ? '—' : f.ageDays + 'd') + ' | `' + cell(f.fingerprint) + '` ' + cell(f.title).slice(0, 90) + ' | ' + cell(f.verdict === 'unverifiable' ? 'needs: ' + f.needs.join('; ') : f.evidence.join('; ')) + ' |');
      L.push('');
    }
    return L.join('\n');
  }

  return { reconcile, renderMarkdown, ciVerdict, judgeRecord, judgeFinding };
}

/* ───────────────────────────── THIN CLI WRAPPER ───────────────────────────── */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

// The real io: fs + git + node, rooted at the repo. Exported for the test's smoke of the shell
// against a throwaway git repo (the core itself is tested with a synthetic io).
export function realIo(ROOT, o) {
  o = o || {};
  const BUGS_DIR = path.join(ROOT, 'qa', 'bugs');
  const FINDINGS_DIR = o.findingsDir ? path.resolve(o.findingsDir) : path.join(ROOT, 'qa', 'findings');
  const CODE_ROOTS = ['sidecar', 'frontend', 'shared', 'scripts', 'desktop', 'loops', 'docs', 'dev', 'bin', 'src'];
  const git = (args) => {
    try { return { ok: true, out: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }; }
    catch (e) { return { ok: false, code: e.status, out: '' }; }
  };
  let branchSet = null, mergedSet = null, worktreeList = null, httpSet = null;
  const httpList = () => {
    if (!httpSet) {
      httpSet = new Set();
      try {
        for (const line of fs.readFileSync(path.join(ROOT, 'test', 'http.list'), 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
          const t = line.trim();
          if (t && !t.startsWith('#')) httpSet.add(t.replace(/\\/g, '/'));
        }
      } catch (_) { /* no list: nothing is skipped */ }
    }
    return httpSet;
  };
  const bodyCache = new Map();
  const codeFiles = (() => {
    let cache = null;
    return () => {
      if (cache) return cache;
      cache = [];
      const walk = (dir) => {
        let ents = [];
        try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const rel = dir + '/' + e.name;
          if (e.isDirectory()) walk(rel);
          else if (/\.(?:m?js|cjs|html|css|json|md|ps1|ts)$/.test(e.name)) cache.push(rel);
        }
      };
      for (const r of CODE_ROOTS) walk(r);
      return cache;
    };
  })();
  return {
    listBugs() {
      let names;
      try { names = fs.readdirSync(BUGS_DIR); } catch (_) { return []; }
      const out = [];
      for (const n of names.sort()) {
        if (!n.endsWith('.md') || n === 'README.md') continue;
        try { out.push({ file: n, text: fs.readFileSync(path.join(BUGS_DIR, n), 'utf8') }); } catch (_) { /* skip */ }
      }
      return out;
    },
    listFindings() {
      let names;
      try { names = fs.readdirSync(FINDINGS_DIR); } catch (_) { return []; }
      const out = [];
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(FINDINGS_DIR, n), 'utf8'))); } catch (_) { /* skip corrupt */ }
      }
      return out;
    },
    headSha() { return git(['rev-parse', 'HEAD']).out; },
    isAncestor(sha) {
      const r = git(['cat-file', '-e', sha + '^{commit}']);
      if (!r.ok) return null;
      const a = git(['merge-base', '--is-ancestor', sha, 'HEAD']);
      return a.ok ? true : (a.code === 1 ? false : null);
    },
    fileExists(rel) { try { return fs.statSync(path.join(ROOT, rel)).isFile(); } catch (_) { return false; } },
    readFile(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; } },
    runTest(rel) {
      // Suites on test/http.list boot real sidecars and belong to the `test:http` gate; they are
      // not run from here unless --http asks (a bare `node` of one is red for environment reasons
      // and would read as a false still-open).
      if (!o.runHttp && httpList().has(rel.replace(/\\/g, '/'))) return { ok: null, code: null, ms: 0, tail: '', skipped: 'test:http gate suite' };
      // HERMETIC PROFILE — the same isolation scripts/run-test-list.mjs gives every gate step: a
      // spawned sidecar's boot-time station recovery must never see the real per-user app-data roots.
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-reconcile-profile-'));
      const hermetic = { APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile };
      if (process.platform !== 'win32') hermetic.HOME = profile;
      const t0 = Date.now();
      let r;
      try {
        r = spawnSync(process.execPath, [rel], { cwd: ROOT, encoding: 'utf8', timeout: o.testTimeoutMs || 120000, env: Object.assign({}, process.env, hermetic), windowsHide: true });
      } finally {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
      const tail = (str(r.stdout) + '\n' + str(r.stderr)).trim().slice(-800);
      return { ok: r.status === 0, code: r.status == null ? -1 : r.status, ms: Date.now() - t0, tail };
    },
    searchCode(text) {
      const want = normWs(text);
      if (want.length < 12) return [];
      const hits = [];
      for (const rel of codeFiles()) {
        let body = bodyCache.get(rel);
        if (body === undefined) {
          try { body = normWs(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { body = null; }
          bodyCache.set(rel, body);
        }
        if (body && body.includes(want)) { hits.push(rel); if (hits.length >= 3) break; }
      }
      return hits;
    },
    worktrees() {
      // cached: `git worktree list` over 500+ registered trees is slow, and 200 findings ask.
      if (!worktreeList) {
        const r = git(['worktree', 'list', '--porcelain']);
        worktreeList = r.out.split(/\r?\n/).filter(l => l.startsWith('worktree ')).map(l => path.basename(l.slice(9).trim()));
      }
      return worktreeList.slice();
    },
    // one git call each, cached: a box with 800 branches would otherwise pay two spawns per finding.
    branchExists(name) {
      if (!branchSet) branchSet = new Set(git(['for-each-ref', 'refs/heads', '--format=%(refname:short)']).out.split(/\r?\n/).map(trimmed).filter(Boolean));
      return branchSet.has(name);
    },
    branchMerged(name) {
      if (!mergedSet) {
        const r = git(['branch', '--merged', 'HEAD', '--format=%(refname:short)']);
        mergedSet = r.ok ? new Set(r.out.split(/\r?\n/).map(trimmed).filter(Boolean)) : null;
      }
      return mergedSet ? mergedSet.has(name) : null;
    }
  };
}

if (INVOKED_DIRECTLY) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(__dirname, '..', '..');
  const DIGESTS_DIR = path.join(ROOT, 'qa', 'digests');

  const args = { staleDays: 7, write: true, run: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--all') args.all = true;
    else if (t === '--json') args.json = true;
    else if (t === '--ci') args.ci = true;
    else if (t === '--no-run') args.run = false;
    else if (t === '--http') args.http = true;
    else if (t === '--no-write') args.write = false;
    else if (t === '--stale-days') args.staleDays = Number(argv[++i]);
    else if (t === '--findings-dir') args.findingsDir = argv[++i] || '';
    else if (t === '--help' || t === '-h') {
      console.error('usage: node scripts/qa/ledger-reconcile.mjs [--all] [--no-run] [--http] [--json] [--no-write] [--findings-dir <dir>] [--ci [--stale-days N]]');
      process.exit(1);
    }
  }
  if (!isFinite(args.staleDays) || args.staleDays < 0) { console.error('[qa:reconcile] --stale-days must be a non-negative number'); process.exit(1); }

  const io = realIo(ROOT, { findingsDir: args.findingsDir, runHttp: !!args.http });
  const R = makeReconciler({ io, clock: { today: () => new Date().toISOString().slice(0, 10) } });
  let result;
  try { result = R.reconcile({ all: !!args.all, runTests: args.run }); }
  catch (e) { console.error('[qa:reconcile] could not read the register: ' + (e && e.message)); process.exit(2); }

  const md = R.renderMarkdown(result);
  if (args.write) {
    try {
      fs.mkdirSync(DIGESTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(DIGESTS_DIR, 'reconcile-' + result.date + '.md'), md + '\n', 'utf8');
      fs.writeFileSync(path.join(DIGESTS_DIR, 'reconcile-' + result.date + '.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      console.error('[qa:reconcile] wrote qa/digests/reconcile-' + result.date + '.{md,json}');
    } catch (e) { console.error('[qa:reconcile] could not write the report: ' + (e && e.message)); }
  }
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(md + '\n');

  if (args.ci) {
    const ci = R.ciVerdict(result, { staleDays: args.staleDays });
    if (!ci.ok) {
      console.error('[qa:reconcile] CI RED — ' + ci.stale.length + ' likely-fixed record(s) still open for more than ' + ci.staleDays + ' day(s):');
      for (const r of ci.stale) console.error('  - ' + r.fingerprint + ' (' + r.ageDays + 'd, ' + r.status + ') ' + r.evidence.join('; '));
      process.exitCode = 3;
    } else console.error('[qa:reconcile] CI OK — no likely-fixed record has sat open more than ' + ci.staleDays + ' day(s)');
  }
  // Let piped output drain before exit; large JSON reports can exceed the pipe buffer.
  process.exitCode = process.exitCode || 0;
}
