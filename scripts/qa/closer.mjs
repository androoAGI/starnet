#!/usr/bin/env node
/* scripts/qa/closer.mjs — the RED→GREEN CLOSER (lane Q8).
 *
 * WHY THIS EXISTS: the Self-Testing Station detects beautifully and repairs nothing. Every
 * path in qa/QA_STATION.md terminates at "route it to a human lane" — the Guardian files a
 * finding, the Overseer notifies, and then Andrew fixes it. The Closer is the missing EDGE:
 * a red finding goes in, a PROVEN patch comes out. It is the only crew member that produces
 * a fix, so it is held to a harder standard than the detectors: it must be structurally
 * incapable of declaring a fix that isn't one.
 *
 * THE SPLIT (this is the whole design): the SCRIPT owns everything mechanical and
 * deterministic — candidate provisioning, the write-set lint, the clean-tree gate re-run,
 * the verdict. A SESSION (loops/red-green-closer.md) owns ONLY the creative act of writing a
 * patch. **The oracle is never a model.** A repair agent cannot grade itself, cannot
 * negotiate with the referee, and cannot reach the thing that judges it.
 *
 * THE THREE LOCKS (each defeats one way a self-repair loop rots):
 *
 *   1. WRITE-SET LINT — "mute the alarm". The cheapest fake fix is editing the detector: swap
 *      the assertion, re-bless the golden, drop the suite from test/fast.list, add the
 *      fingerprint to KNOWN_ISSUES.md, neuter the npm script. A candidate whose patch touches
 *      the failing gate's own files (or any always-forbidden path) is DISQUALIFIED before the
 *      gate is even run — it never gets the chance to turn green by lying. This is deliberately
 *      strict: a defect whose honest fix genuinely requires changing a test is a JUDGEMENT call
 *      that belongs to a human, and the Closer refuses it rather than guessing.
 *
 *   2. ORACLE SEPARATION — "grading your own homework". The candidate's own worktree is never
 *      trusted and never gates. The referee exports the candidate's diff, resets ITS OWN
 *      checkout to the base sha, applies the patch there, and runs the gate itself. Candidate
 *      worktrees are provisioned WITHOUT node_modules by default, so a repair agent physically
 *      cannot run the gate it is being judged by (--install-candidates opts out for agents that
 *      want to iterate locally; the referee's verdict is unaffected either way).
 *
 *   3. BASELINE-RED PROOF — "the detector that never detects". Before any patch is credited,
 *      the referee runs the gate at the BASE sha in its own checkout and requires it to be RED.
 *      If the baseline is green the whole run is BLOCKED (`baseline-not-red`): the finding is
 *      stale, or the detector is flaky, or the reproduction is wrong — and in every one of
 *      those cases a "passing" patch proves nothing. This is the mutation proof applied to the
 *      Closer itself. Without it, a flaky gate hands out wins for empty diffs.
 *
 * NO-FAKE-GREEN LAW (Charter Part 5): any step that CANNOT run (git/npm/spawn failure, missing
 * manifest, unapplyable patch) is BLOCKED — loud, nonzero, filed as P0. A Closer that cannot
 * judge never silently crowns a winner.
 *
 * READ-ONLY LAW: the Closer writes ONLY into its own run dir (qa/closer/<runId>/), its own
 * candidate worktrees (`_qa-closer-*`), and its own referee checkout. NEVER the integration
 * tree, NEVER another agent's worktree, NEVER the Guardian's pin. It does not merge — a winning
 * patch is handed to the merge ritual, which stays a human/orchestrator act.
 *
 * HOUSE PATTERN (matches scripts/qa/ledger.mjs + scripts/qa/guardian.mjs): the CORE is PURE.
 * No ambient time, no ambient disk, no child processes — the decision logic (which gate detects
 * this finding, is this write-set legal, did the run earn a winner) is testable headlessly by
 * test/qa-closer.test.js without provisioning a single worktree. The IO SHELL below (the CLI)
 * owns git, npm, disk and the real clock — the one place ambient effects live. Dedup keys come
 * from the ledger's fingerprintOf and the cross-process lock reuses the Guardian's isLockStale:
 * never re-implement a law that already has one implementation.
 *
 * PORT LAW (Part 3/5): the referee boots sidecars ONLY in the Closer range 8970-8979
 * (CDP 9370-9379). Mirrored in qa/STATUS.md's port registry.
 *
 * CLI:
 *   node scripts/qa/closer.mjs --open <fingerprint|id>      # provision N candidate worktrees + briefs
 *     [--candidates 3] [--gate test:fast] [--base <sha>] [--install-candidates]
 *   node scripts/qa/closer.mjs --referee <runId>            # judge every candidate; crown a winner
 *   node scripts/qa/closer.mjs --list                       # open runs
 *   node scripts/qa/closer.mjs --status <runId>             # one run's verdict
 *   node scripts/qa/closer.mjs --close <runId>              # remove this run's candidate worktrees
 *
 * Exit codes: 0 success (winner crowned / clean) · 1 no winner (every candidate failed) ·
 *             2 BLOCKED (the Closer could not judge — baseline not red, gate unrunnable, bad args).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBoundedCommand, coerceTimeoutMs, npmGateTimeoutMs } from '../lib/run-command.mjs';
import { fingerprintOf } from './ledger.mjs';
import { isLockStale } from './guardian.mjs';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

export const CREW = 'Red-Green Closer';

// The gates a finding can be closed against, keyed by the Guardian's step id. `detectors` is the
// file set a patch may NOT touch when closing against THAT gate — the alarm it would be muting.
// `visual` steps boot a sidecar + Chrome and need the Closer port range.
export const CLOSER_GATES = {
  'test-fast': { npm: 'test:fast',   visual: false, detectors: [] },   // covered by PROTECTED below
  'http-e2e':  { npm: 'test:http',   visual: false, detectors: [] },   // covered by PROTECTED below
  'shoot':     { npm: 'shoot',       visual: true,  detectors: ['scripts/shoot.mjs', 'scripts/lib/states.mjs', 'scripts/lib/shootRun.mjs'] },
  'golden':    { npm: 'golden',      visual: true,  detectors: ['scripts/goldens.json', 'scripts/golden.mjs', 'scripts/lib/png.mjs'] },
  'audit':     { npm: 'audit',       visual: true,  detectors: ['scripts/audit.mjs'] },
  'journeys':  { npm: 'qa:journeys', visual: true,  detectors: ['scripts/qa/journeys.mjs'] },
};

// Protected for EVERY gate, not just the one being closed. `test/` is here because `test:fast` is
// the COLLATERAL gate on every non-test run: without this, a candidate closing a golden finding
// could silence a unit test its fix broke, and the collateral check would wave it through — the
// same mute-the-alarm move one level down. Protection is directional (see writeSetVerdict):
// MODIFYING or DELETING an existing test is forbidden, ADDING a new one is encouraged, because a
// new regression test is exactly what an honest fix ships.
export const PROTECTED = ['test/'];

// Paths NO patch may touch, whatever gate it is closing. Each one is a documented way to turn a
// gate green without fixing anything:
//   qa/KNOWN_ISSUES.md         — bless the fingerprint onto the baseline; the ledger then refuses to file it
//   qa/findings/               — delete the finding that is judging you
//   qa/STATUS.md               — rewrite the dashboard the humans read
//   qa/closer/                 — rewrite the referee's own record of this run
//   qa/product-perfect/claims.json — the claims lock ledger (re-locking is its own committed act)
//   scripts/qa/                — edit the detector fleet itself, including this file
//   test/fast.list             — drop the failing suite out of the gate
//   package.json               — neuter the npm script the gate runs
//   .github/                   — neuter CI
//   CLOSER_BRIEF.md            — the brief dropped into each candidate (never part of a patch)
export const ALWAYS_FORBIDDEN = [
  'qa/KNOWN_ISSUES.md',
  'qa/findings/',
  'qa/STATUS.md',
  'qa/closer/',
  'qa/product-perfect/claims.json',
  'scripts/qa/',
  'test/fast.list',
  'package.json',
  '.github/',
  'CLOSER_BRIEF.md',
];

function str(v) { return v == null ? '' : String(v); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function shortSha(sha) { return str(sha).trim().slice(0, 8) || '(unknown)'; }

// Normalize a repo-relative path for deny-list matching: backslashes -> forward, no leading
// './', lowercased. Case-insensitive on purpose — this is a DENY list, so matching more
// aggressively is the fail-closed direction (and Windows paths are case-insensitive anyway).
export function normalizePath(p) {
  return str(p).replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

// Deliberately dumb matcher — three forms only, so a rule is never accidentally broader than it
// reads: a trailing '/' is a directory prefix, a '**' is a wildcard segment, anything else is an
// exact path. No regex in the rule table means no rule can surprise a reviewer.
export function pathMatches(file, pattern) {
  const f = normalizePath(file);
  const p = normalizePath(pattern);
  if (!f || !p) return false;
  if (p.endsWith('/')) return f === p.slice(0, -1) || f.startsWith(p);
  if (p.includes('**')) {
    const rx = new RegExp('^' + p.split('**').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return rx.test(f);
  }
  return f === p;
}

// Coerce a write set into {path, status} entries. Accepts bare strings for convenience; a bare
// string is treated as 'M' (modified) because that is the STRICTER reading — an unknown status
// must never be mistaken for a benign add.
export function coerceWriteSet(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const f of files) {
    if (!f) continue;
    if (typeof f === 'string') { out.push({ path: f, status: 'M' }); continue; }
    const p = str(f.path || f.file);
    if (!p) continue;
    const s = str(f.status).trim().toUpperCase().slice(0, 1) || 'M';
    out.push({ path: p, status: s });
  }
  return out;
}

// LOCK 1 — the mute-the-alarm lint. Given a candidate's write set and the gate it is closing,
// return every violation. `ok:false` DISQUALIFIES the candidate before the gate is ever run: the
// patch never gets the opportunity to turn green by editing what judges it.
//
// Two rule classes, deliberately different in strength:
//   ALWAYS_FORBIDDEN — any status, any gate. There is no honest reason to touch these at all.
//   PROTECTED + the gate's detectors — DIRECTIONAL: modify/delete/rename is a violation, ADD is
//     allowed. Weakening an existing assertion is a mute; shipping a new one is a fix.
export function writeSetVerdict(input) {
  input = input || {};
  const files = coerceWriteSet(input.files);
  const gateId = str(input.gate);
  const gate = CLOSER_GATES[gateId];
  const guarded = (gate ? gate.detectors : []).concat(PROTECTED);
  const violations = [];

  if (!files.length) {
    return { ok: false, violations: [{ file: '(none)', rule: 'empty-patch', why: 'the candidate changed nothing — an empty patch can never be credited with a fix' }] };
  }
  for (const { path: file, status } of files) {
    for (const rule of ALWAYS_FORBIDDEN) {
      if (pathMatches(file, rule)) violations.push({ file, status, rule, why: 'always-forbidden: touching `' + rule + '` mutes the alarm instead of fixing the defect' });
    }
    if (status === 'A') continue;                       // adding a new detector/test is the honest move
    for (const rule of guarded) {
      if (pathMatches(file, rule)) violations.push({ file, status, rule, why: 'protected detector: `' + rule + '` judges this patch — you may ADD a test here, never modify or delete one' });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Which gate detects this finding? The Guardian's finding titles are stable templates (see
// guardian.mjs findingsFor), so the mapping is a table, not a guess. An unrecognised title is
// REFUSED rather than guessed — a Closer aimed at the wrong gate would "prove" nothing.
export function gateForFinding(finding) {
  finding = finding || {};
  const title = str(finding.title).trim();
  if (!title) return { ok: false, reason: 'no-title', hint: 'the finding has no title to infer a gate from; pass --gate explicitly' };

  // A BLOCKED finding is an ENVIRONMENT failure (spawn/timeout/git), not a product defect. There
  // is nothing in the source tree to patch, so the Closer refuses it outright rather than aiming
  // three agents at a machine problem.
  if (/^Guardian BLOCKED:/i.test(title)) {
    return { ok: false, reason: 'blocked-finding', hint: 'a BLOCKED detector is an environment failure (spawn/timeout/git), not a patchable defect — fix the machine, not the code' };
  }

  const TABLE = [
    [/^Visual regression: frame/i,           'golden'],
    [/^Golden gate failed to produce/i,      'golden'],
    [/^Truth regression: audit assertion/i,  'audit'],
    [/^Behavioral audit failed/i,            'audit'],
    [/^Journey parity regression:/i,         'journeys'],
    [/^Journey run failed/i,                 'journeys'],
    [/^UI state .* failed to open/i,         'shoot'],
    [/^Screenshot sweep failed/i,            'shoot'],
  ];
  for (const [rx, gate] of TABLE) if (rx.test(title)) return { ok: true, gate };

  // `Gate red: \`test:fast\` failed (exit 1)` — the npm script is quoted in the title.
  const m = title.match(/^Gate red:\s*`([^`]+)`/i);
  if (m) {
    const npm = m[1].trim();
    for (const id of Object.keys(CLOSER_GATES)) if (CLOSER_GATES[id].npm === npm) return { ok: true, gate: id };
    return { ok: false, reason: 'unknown-npm-script', hint: 'title names npm script `' + npm + '` which is not a Closer gate; pass --gate explicitly' };
  }
  return { ok: false, reason: 'unrecognised-title', hint: 'no gate could be inferred from the title; pass --gate explicitly (one of: ' + Object.keys(CLOSER_GATES).join(', ') + ')' };
}

// Resolve a caller-supplied --gate (accepts either a step id like `test-fast` or the npm script
// name like `test:fast`) to a step id.
export function resolveGateArg(v) {
  const s = str(v).trim();
  if (!s) return '';
  if (CLOSER_GATES[s]) return s;
  for (const id of Object.keys(CLOSER_GATES)) if (CLOSER_GATES[id].npm === s) return id;
  return '';
}

// Parse `git diff --name-status` into {path, status} entries. A rename/copy (`R100\told\tnew`)
// becomes TWO entries — a delete of the old path and an add of the new one — so renaming a
// protected test out of the way trips the same rule that deleting it would. Fail-closed by
// construction: an unparseable line is dropped from the diff but the patch still carries it, and
// the gate still has to pass on the referee's tree.
export function parseNameStatus(text) {
  const out = [];
  for (const raw of str(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const parts = line.split('\t');
    const code = str(parts[0]).trim().toUpperCase();
    if (!code) continue;
    if (/^[RC]/.test(code) && parts.length >= 3) {
      out.push({ path: parts[1], status: 'D' });
      out.push({ path: parts[2], status: 'A' });
      continue;
    }
    if (parts.length >= 2 && parts[1]) out.push({ path: parts[1], status: code.slice(0, 1) });
  }
  return out;
}

// Measure a unified diff: how many files, how many changed lines. Used ONLY to rank passing
// candidates (smallest honest fix wins) — never to judge correctness.
export function patchSize(diffText) {
  const text = str(diffText);
  if (!text) return { files: 0, lines: 0 };
  let files = 0, lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^diff --git /.test(line)) { files++; continue; }
    if (/^\+\+\+ |^--- /.test(line)) continue;              // file headers, not content
    if (/^[+-]/.test(line)) lines++;
  }
  return { files, lines };
}

// LOCK 3 + winner selection. `baseline` describes the gate run at the BASE sha in the referee's
// own checkout; `candidates` are the judged patches. Order matters: the baseline gates
// everything, because a green baseline makes every candidate result meaningless.
export function refereeVerdict(input) {
  input = input || {};
  const baseline = input.baseline || {};
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];

  if (baseline.ran !== true) {
    return { verdict: 'blocked', reason: 'baseline-gate-could-not-run', detail: str(baseline.detail) || 'the gate could not be executed at the base sha, so nothing can be proven', winner: null, ranked: [] };
  }
  if (baseline.red !== true) {
    return {
      verdict: 'blocked', reason: 'baseline-not-red',
      detail: 'the gate is GREEN at the base sha — the finding is stale, the reproduction is wrong, or the detector is flaky. No patch can be credited against a detector that does not detect.',
      winner: null, ranked: []
    };
  }

  const ranked = candidates.slice().map(c => Object.assign({}, c));
  for (const c of ranked) {
    c.passed = !c.disqualified && c.applied === true && c.gateGreen === true && c.collateralGreen !== false;
  }
  // Smallest honest fix wins: fewest changed lines, then fewest files, then id (deterministic).
  const passing = ranked.filter(c => c.passed).sort((a, b) => {
    const sa = a.size || {}, sb = b.size || {};
    return num(sa.lines) - num(sb.lines) || num(sa.files) - num(sb.files) || str(a.id).localeCompare(str(b.id));
  });
  if (!passing.length) {
    return { verdict: 'no-winner', reason: 'every candidate failed the referee', detail: ranked.length ? ranked.map(c => str(c.id) + ': ' + closerWhyFailed(c)).join(' · ') : 'no candidates were judged', winner: null, ranked };
  }
  return { verdict: 'winner', reason: 'a patch turned the failing gate green on a clean tree', winner: passing[0], ranked, runnersUp: passing.slice(1) };
}

// One-line reason a candidate did not win — used in the verdict detail + the printed report.
export function closerWhyFailed(c) {
  c = c || {};
  if (c.disqualified) return 'DISQUALIFIED (' + (Array.isArray(c.violations) ? c.violations.map(v => v.file).join(', ') : 'write-set violation') + ')';
  if (c.applied === false) return 'patch did not apply to a clean base tree';
  if (c.gateGreen === false) return 'the failing gate stayed red';
  if (c.collateralGreen === false) return 'the gate went green but test:fast regressed (collateral damage)';
  return 'not judged';
}

export function makeCloserCore(opts) {
  opts = opts || {};
  const clock = opts.clock || { now() { return 0; } };
  const io = opts.io || {};
  const evidencePath = typeof io.evidencePath === 'function' ? io.evidencePath.bind(io) : (n) => str(n);

  function fingerprint(parts) {
    parts = parts || {};
    return fingerprintOf({ crew: CREW, checkId: str(parts.step), subject: str(parts.subject) });
  }

  // The Closer's OWN findings — filed only when the Closer itself is BLOCKED (no-fake-green).
  // A no-winner run is NOT a finding: the underlying defect already has one, and filing a second
  // "we couldn't fix it" row would be exactly the nagging the anti-nag law forbids.
  function blockedFinding(input) {
    input = input || {};
    const ts = num(input.ts) || clock.now();
    const subject = str(input.reason || 'blocked');
    return {
      crew: CREW,
      ts,
      severity: 'P0',
      fingerprint: fingerprint({ step: 'closer', subject: subject + '/' + str(input.targetFingerprint) }),
      title: 'Closer BLOCKED: ' + str(input.title || 'a run could not be judged'),
      detail: str(input.detail) + ' (run ' + str(input.runId) + ', gate `' + str(input.gate) + '`, base ' + shortSha(input.base) + '). A Closer that cannot judge never crowns a winner (no-fake-green law).',
      evidence: (Array.isArray(input.evidence) ? input.evidence : [input.evidence]).map(str).filter(Boolean).map(evidencePath),
      status: 'open',
    };
  }

  // The repair brief handed to ONE candidate agent. It is the entire contract: what is broken,
  // how it is proven, what may not be touched, and what "done" means. Deliberately states the
  // refusal path — an agent that believes the detector itself is wrong must SAY so rather than
  // edit it, because that call belongs to a human.
  function brief(input) {
    input = input || {};
    const f = input.finding || {};
    const gateId = str(input.gate);
    const gate = CLOSER_GATES[gateId] || {};
    const ev = (Array.isArray(f.evidence) ? f.evidence : []).map(str).filter(Boolean);
    const L = [];
    L.push('# CLOSER REPAIR BRIEF — candidate ' + str(input.candidateId));
    L.push('');
    L.push('You are one of ' + num(input.totalCandidates) + ' independent repair agents aimed at the SAME defect.');
    L.push('You are competing on the smallest patch that HONESTLY turns the failing gate green.');
    L.push('You cannot see the other candidates and you do not judge yourself.');
    L.push('');
    L.push('## The defect');
    L.push('');
    L.push('- **' + str(f.title) + '**');
    L.push('- severity: `' + str(f.severity) + '` · crew: `' + str(f.crew) + '` · fingerprint: `' + str(f.fingerprint) + '`');
    if (f.detail) L.push('- detail: ' + str(f.detail));
    if (ev.length) L.push('- evidence: ' + ev.map(p => '`' + p + '`').join(', '));
    L.push('');
    L.push('## How you are judged');
    L.push('');
    L.push('The referee is a script, not a model. It will:');
    L.push('');
    L.push('1. Export your diff against base `' + shortSha(input.base) + '`.');
    L.push('2. Run the WRITE-SET LINT. Any forbidden path = DISQUALIFIED, gate never run.');
    L.push('3. Reset its OWN clean checkout to the base sha, apply your patch there, and run');
    L.push('   `npm run ' + str(gate.npm) + '`. It must go GREEN.');
    if (gate.npm !== 'test:fast') L.push('4. Run `npm run test:fast` on the same tree. It must ALSO be green (no collateral damage).');
    L.push('');
    L.push('It has already proven the gate is RED at the base sha, so a green result is');
    L.push('attributable to your patch and nothing else. Working in this tree does not affect');
    L.push('the verdict — only the exported diff is judged.');
    L.push('');
    L.push('## You may NOT touch these paths (any change at all)');
    L.push('');
    for (const p of ALWAYS_FORBIDDEN) L.push('- `' + p + '`');
    L.push('');
    L.push('## You may ADD here, never modify or delete');
    L.push('');
    for (const p of (gate.detectors || []).concat(PROTECTED)) L.push('- `' + p + '`');
    L.push('');
    L.push('A NEW test that locks your fix is welcome and costs you nothing. Weakening, deleting or');
    L.push('renaming an EXISTING one is the move this system exists to catch — including tests your');
    L.push('fix happens to break, because `test:fast` is the collateral gate on every run.');
    L.push('');
    L.push('Every path above is a documented way to turn the gate green WITHOUT fixing the defect.');
    L.push('Tripping one disqualifies you outright — there is no partial credit.');
    L.push('');
    L.push('**If you conclude the detector itself is wrong** — the test asserts stale behavior, the');
    L.push('golden needs re-blessing, the assertion is genuinely obsolete — do NOT edit it. Write');
    L.push('your reasoning to `CLOSER_VERDICT.md` in this worktree and change nothing else. That is a');
    L.push('legitimate outcome; a human decides whether a detector retires. Silently editing the');
    L.push('detector is the single failure this whole system exists to prevent.');
    L.push('');
    L.push('## Method');
    L.push('');
    L.push('- Reproduce first. Read the evidence path before you read the code.');
    L.push('- One hypothesis at a time. Trace the seam (who emits → who stores → who renders).');
    L.push('- Smallest patch that fixes the CAUSE. You are ranked by size among passing patches,');
    L.push('  so a scattershot diff loses to a two-line fix that does the same job.');
    L.push('- Leave the work uncommitted or committed — either is exported. Do not push.');
    L.push('');
    return L.join('\n');
  }

  // Human-readable verdict report for the run dir + stdout.
  function verdictMarkdown(input) {
    input = input || {};
    const v = input.verdict || {};
    const L = [];
    L.push('# Closer run ' + str(input.runId));
    L.push('');
    L.push('- finding: **' + str((input.finding || {}).title) + '** (`' + str((input.finding || {}).fingerprint) + '`)');
    L.push('- gate: `' + str(input.gate) + '` · base: `' + shortSha(input.base) + '`');
    L.push('- verdict: **' + str(v.verdict).toUpperCase() + '** — ' + str(v.reason));
    if (v.detail) L.push('- detail: ' + str(v.detail));
    L.push('');
    if (v.verdict === 'winner' && v.winner) {
      const w = v.winner;
      L.push('## Winner — ' + str(w.id));
      L.push('');
      L.push('- patch: `' + str(w.patchFile) + '` (' + num((w.size || {}).files) + ' files, ' + num((w.size || {}).lines) + ' changed lines)');
      L.push('- the failing gate went GREEN on a clean tree at the base sha with this patch applied');
      L.push('- `test:fast` green on the same tree (no collateral damage)');
      L.push('');
      L.push('**This is not merged.** Hand the patch to the merge ritual; the Closer never merges.');
      L.push('');
    }
    const ranked = Array.isArray(v.ranked) ? v.ranked : [];
    if (ranked.length) {
      L.push('## All candidates');
      L.push('');
      L.push('| Candidate | Result | Files | Lines | Why |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const c of ranked) {
        const size = c.size || {};
        L.push('| ' + str(c.id) + ' | ' + (c.passed ? 'PASS' : 'fail') + ' | ' + num(size.files) + ' | ' + num(size.lines) + ' | ' + (c.passed ? 'gate green on a clean tree' : closerWhyFailed(c)) + ' |');
      }
      L.push('');
      for (const c of ranked) {
        if (!c.disqualified || !Array.isArray(c.violations) || !c.violations.length) continue;
        L.push('### ' + str(c.id) + ' — DISQUALIFIED (write-set)');
        L.push('');
        for (const viol of c.violations) L.push('- `' + str(viol.file) + '` — ' + str(viol.why));
        L.push('');
      }
    }
    return L.join('\n');
  }

  return { fingerprint, blockedFinding, brief, verdictMarkdown, _gates: CLOSER_GATES };
}

/* ───────────────────────────── IO SHELL / CLI ─────────────────────────────
 * The ONLY place ambient effects live: git, npm/child processes, disk, real clock, worktrees.
 * Runs only when invoked directly. Mirrors guardian.mjs's composition-root pattern; the static
 * imports above are side-effect-free so the CJS test can require() the pure core without any of
 * this executing.
 */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const CLOSER_REPO = path.resolve(__dirname, '..', '..');          // scripts/qa/ -> the repo the closer LIVES in
  const QA_DIR = path.join(CLOSER_REPO, 'qa');
  const RUNS_DIR = path.join(QA_DIR, 'closer');
  const FINDINGS_DIR = path.join(QA_DIR, 'findings');
  const LEDGER_CLI = path.join(CLOSER_REPO, 'scripts', 'qa', 'ledger.mjs');
  const TRUNK_BRANCH = process.env.SKYNET_CLOSER_TRUNK || process.env.SKYNET_GUARDIAN_TRUNK || 'feat/harness-backend';

  // The referee's OWN checkout — detached, reset per judgement, npm install'd once. Prefixed `_`
  // so `git worktree list` reads it as QA infra, not an agent lane.
  const REFEREE_DIR = process.env.SKYNET_CLOSER_REFEREE || path.resolve(CLOSER_REPO, '..', '_qa-closer-referee');
  const CANDIDATE_ROOT = process.env.SKYNET_CLOSER_CANDIDATES || path.resolve(CLOSER_REPO, '..');

  // Closer port range (Part 3/5 port law): 8970-8979 sidecar, 9370-9379 CDP.
  const PORTS = {
    shoot:    { SKYNET_SHOT_PORT:    '8970', SKYNET_CDP_PORT:    '9370' },
    golden:   { SKYNET_GOLDEN_PORT:  '8971', SKYNET_GOLDEN_CDP:  '9371' },
    audit:    { SKYNET_AUDIT_PORT:   '8972', SKYNET_AUDIT_CDP:   '9372' },
    journeys: { SKYNET_JOURNEY_PORT: '8973', SKYNET_JOURNEY_CDP: '9373' },
  };

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const MAX_CANDIDATES = 6;

  const log = (...a) => console.log('[closer]', ...a);
  const errlog = (...a) => console.error('[closer]', ...a);

  /* ── cross-process lock (same law as the Guardian; its own file + its own ports) ──
   * The referee resets a shared checkout and binds the 8970s. Two concurrent judgements would
   * corrupt each other exactly the way two Guardian cycles did (finding 90fe0bcc). isLockStale is
   * imported, never re-implemented. */
  const LOCK_FILE = process.env.SKYNET_CLOSER_LOCK || path.join(os.tmpdir(), 'starnet-qa-closer.lock');
  const LOCK_HEARTBEAT_MS = coerceTimeoutMs(process.env.SKYNET_CLOSER_LOCK_HEARTBEAT_MS || 30000, 30000);
  const LOCK_STALE_MS = coerceTimeoutMs(process.env.SKYNET_CLOSER_LOCK_STALE_MS || 120000, 120000);
  let __lockRec = null, __heartbeatTimer = null;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function readLockRecord() { try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (_) { return null; } }
  function lockFileMtimeMs() { try { return fs.statSync(LOCK_FILE).mtimeMs; } catch (_) { return 0; } }
  function holderAlive(rec) {
    if (!rec || rec.host !== os.hostname()) return false;
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
  }
  function stopHeartbeat() { if (__heartbeatTimer) { clearInterval(__heartbeatTimer); __heartbeatTimer = null; } }
  function startHeartbeat() {
    stopHeartbeat();
    __heartbeatTimer = setInterval(() => {
      if (!__lockRec) return;
      try {
        const cur = readLockRecord();
        if (cur && cur.pid === process.pid && cur.host === os.hostname()) {
          __lockRec.heartbeatAt = Date.now();
          fs.writeFileSync(LOCK_FILE, JSON.stringify(__lockRec), 'utf8');
        }
      } catch (_) { /* a missed heartbeat only shortens our margin */ }
    }, LOCK_HEARTBEAT_MS);
    if (__heartbeatTimer.unref) __heartbeatTimer.unref();
  }
  function releaseLock() {
    stopHeartbeat();
    if (!__lockRec) return;
    try { const cur = readLockRecord(); if (cur && cur.pid === process.pid && cur.host === os.hostname()) fs.unlinkSync(LOCK_FILE); } catch (_) {}
    __lockRec = null;
  }
  async function acquireLock({ wait }) {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        const rec = { pid: process.pid, host: os.hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), cmd: process.argv.slice(2).join(' ') };
        const fd = fs.openSync(LOCK_FILE, 'wx');
        try { fs.writeSync(fd, JSON.stringify(rec)); } finally { fs.closeSync(fd); }
        __lockRec = rec; startHeartbeat();
        return { ok: true };
      } catch (e) {
        if (e.code !== 'EEXIST') return { ok: false, error: str(e && e.message || e) };
        const rec = readLockRecord();
        const now = Date.now();
        const reclaimable = rec
          ? (isLockStale(rec, now, LOCK_STALE_MS) || (rec.host === os.hostname() && !holderAlive(rec)))
          : ((now - lockFileMtimeMs()) > LOCK_STALE_MS);
        if (reclaimable) {
          log('reclaiming stale closer lock (holder pid=' + (rec && rec.pid) + ')');
          try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
          continue;
        }
        if (!wait) return { ok: false, held: true, holder: rec };
        if (attempt === 0) log('another closer judgement is running (pid ' + (rec && rec.pid) + '); --wait: queuing…');
        await sleep(2000);
      }
    }
  }

  /* ── git + disk helpers ── */
  function git(args, cwd) {
    const r = spawnSync('git', args, { cwd: cwd || CLOSER_REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status == null ? 1 : r.status, out: str(r.stdout), err: str(r.stderr).trim() };
  }
  function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
  function readJsonMaybe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
  function trunkHead() { const r = git(['rev-parse', TRUNK_BRANCH]); return r.code === 0 ? r.out.trim() : ''; }

  function fileFinding(finding) {
    const r = spawnSync(process.execPath, [LEDGER_CLI, '--add', '--json', JSON.stringify(finding)], { cwd: CLOSER_REPO, encoding: 'utf8', windowsHide: true });
    const out = str(r.stdout).trim(), err = str(r.stderr).trim();
    if (out) log('ledger:', out);
    if (err) errlog('ledger:', err);
    return (r.status === 0 || r.status === 2);
  }

  function listFindings() {
    let names; try { names = fs.readdirSync(FINDINGS_DIR); } catch (_) { return []; }
    const out = [];
    for (const n of names) { if (!n.endsWith('.json')) continue; const j = readJsonMaybe(path.join(FINDINGS_DIR, n)); if (j) out.push(j); }
    return out;
  }
  // Accept a fingerprint, an id, or a path to a finding JSON (the last form lets a run be driven
  // from an evidence bundle without the finding having been filed yet — used by the self-test).
  function resolveFinding(ref) {
    const s = str(ref).trim();
    if (!s) return null;
    if (/\.json$/i.test(s) && fs.existsSync(s)) return readJsonMaybe(s);
    for (const f of listFindings()) if (str(f.fingerprint) === s || str(f.id) === s) return f;
    return null;
  }

  /* ── worktrees ── */
  function worktreeAdd(dir, sha) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const reset = git(['reset', '--hard', sha], dir);
      if (reset.code !== 0) return { ok: false, reason: 'git reset --hard failed in ' + dir + ': ' + (reset.err || reset.out) };
      git(['clean', '-fd'], dir);
      return { ok: true, reused: true };
    }
    ensureDir(path.dirname(dir));
    const add = git(['worktree', 'add', '--detach', dir, sha]);
    if (add.code !== 0) return { ok: false, reason: 'git worktree add failed for ' + dir + ': ' + (add.err || add.out) };
    return { ok: true, reused: false };
  }
  function npmInstall(dir) {
    if (fs.existsSync(path.join(dir, 'node_modules'))) return { ok: true, skipped: true };
    log('npm install in ' + path.basename(dir) + ' (one-time)…');
    const r = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
    if ((r.status == null ? 1 : r.status) !== 0) return { ok: false, reason: 'npm install failed in ' + dir + ': ' + str(r.stderr).slice(-400) };
    return { ok: true };
  }

  // Export a candidate's whole contribution as one patch: committed OR staged OR unstaged OR
  // untracked, all of it. `git add -A` moves the working tree into the index; `diff --cached
  // <base>` then reads base-tree → index, which spans every one of those cases. The brief is
  // pathspec-excluded so it never becomes part of a patch (and is on ALWAYS_FORBIDDEN as backup).
  function exportPatch(dir, base) {
    const add = git(['add', '-A', '--', '.', ':(exclude)CLOSER_BRIEF.md', ':(exclude)CLOSER_VERDICT.md'], dir);
    if (add.code !== 0) return { ok: false, reason: 'git add failed: ' + (add.err || add.out) };
    const names = git(['diff', '--cached', '--name-status', base], dir);
    if (names.code !== 0) return { ok: false, reason: 'git diff --name-status failed: ' + (names.err || names.out) };
    const diff = git(['diff', '--cached', '--binary', base], dir);
    if (diff.code !== 0) return { ok: false, reason: 'git diff failed: ' + (diff.err || diff.out) };
    return { ok: true, files: parseNameStatus(names.out), diff: diff.out };
  }

  async function runGate(gateId, cwd, logFile) {
    const gate = CLOSER_GATES[gateId];
    const env = Object.assign({}, process.env, PORTS[gateId] || {});
    const res = await runBoundedCommand({ cmd: npmCmd, args: ['run', gate.npm], cwd, env, timeoutMs: npmGateTimeoutMs(gate.npm, process.env.SKYNET_CLOSER_STEP_TIMEOUT_MS), label: 'closer/' + gateId });
    try { fs.writeFileSync(logFile, res.output, 'utf8'); } catch (_) {}
    const spawnError = /\[spawn error\]/.test(res.output);
    return {
      ran: !spawnError && !res.timedOut,
      green: res.exitCode === 0,
      exitCode: res.exitCode,
      timedOut: !!res.timedOut,
      detail: spawnError ? ('spawn error: ' + res.output.slice(-200)) : (res.timedOut ? ('timed out after ' + num(res.durationMs) + 'ms') : ''),
      logFile,
    };
  }

  /* ── phase 1: --open ── */
  async function cmdOpen(args) {
    const finding = resolveFinding(args.open);
    if (!finding) { errlog('BLOCKED: no finding matches `' + args.open + '` (searched qa/findings/ by fingerprint and id)'); return 2; }

    let gateId = resolveGateArg(args.gate);
    if (!gateId) {
      const inferred = gateForFinding(finding);
      if (!inferred.ok) { errlog('BLOCKED: could not infer the gate — ' + inferred.reason + '. ' + inferred.hint); return 2; }
      gateId = inferred.gate;
    }
    const base = str(args.base).trim() || trunkHead();
    if (!base) { errlog('BLOCKED: could not resolve a base sha (trunk ' + TRUNK_BRANCH + ')'); return 2; }
    const baseResolved = git(['rev-parse', base]);
    if (baseResolved.code !== 0) { errlog('BLOCKED: base sha `' + base + '` does not resolve'); return 2; }
    const baseSha = baseResolved.out.trim();

    const n = Math.max(1, Math.min(MAX_CANDIDATES, num(args.candidates) || 3));
    const fp8 = str(finding.fingerprint).slice(0, 8) || 'nofp';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const runId = 'closer-' + fp8 + '-' + stamp;
    const runDir = path.join(RUNS_DIR, runId);
    ensureDir(runDir);

    const core = makeCloserCore({ clock: { now: () => Date.now() } });
    log('run ' + runId + ' — gate `' + CLOSER_GATES[gateId].npm + '` @ base ' + shortSha(baseSha) + ' — ' + n + ' candidates');

    const candidates = [];
    for (let i = 1; i <= n; i++) {
      const id = 'cand-' + i;
      const dir = path.join(CANDIDATE_ROOT, '_qa-closer-' + fp8 + '-' + i);
      const wt = worktreeAdd(dir, baseSha);
      if (!wt.ok) { errlog('BLOCKED: ' + wt.reason); return 2; }
      if (args.installCandidates) {
        const inst = npmInstall(dir);
        if (!inst.ok) { errlog('BLOCKED: ' + inst.reason); return 2; }
      }
      const briefText = core.brief({ finding, gate: gateId, base: baseSha, candidateId: id, totalCandidates: n });
      fs.writeFileSync(path.join(dir, 'CLOSER_BRIEF.md'), briefText + '\n', 'utf8');
      fs.writeFileSync(path.join(runDir, id + '-brief.md'), briefText + '\n', 'utf8');
      candidates.push({ id, dir });
      log('  ' + id + ' → ' + dir + (wt.reused ? ' (reset)' : ' (created)'));
    }

    const manifest = {
      runId, createdAt: Date.now(), base: baseSha, gate: gateId, npm: CLOSER_GATES[gateId].npm,
      installedCandidates: !!args.installCandidates,
      finding: { id: finding.id, fingerprint: finding.fingerprint, title: finding.title, severity: finding.severity, crew: finding.crew, detail: finding.detail, evidence: finding.evidence },
      candidates,
    };
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    console.log('');
    console.log('OPENED ' + runId);
    console.log('  defect : ' + str(finding.title));
    console.log('  gate   : npm run ' + CLOSER_GATES[gateId].npm + '   (must be RED at base, GREEN with the patch)');
    console.log('  base   : ' + baseSha);
    console.log('');
    console.log('Aim one repair agent at each candidate worktree. Each has CLOSER_BRIEF.md at its root:');
    for (const c of candidates) console.log('  ' + c.id + '  ' + c.dir);
    console.log('');
    console.log('Then judge them:  node scripts/qa/closer.mjs --referee ' + runId);
    console.log('');
    return 0;
  }

  /* ── phase 2: --referee ── */
  async function cmdReferee(args) {
    const runId = str(args.referee).trim();
    const runDir = path.join(RUNS_DIR, runId);
    const manifest = readJsonMaybe(path.join(runDir, 'manifest.json'));
    if (!manifest) { errlog('BLOCKED: no manifest at ' + path.join(runDir, 'manifest.json')); return 2; }

    const gateId = str(manifest.gate);
    if (!CLOSER_GATES[gateId]) { errlog('BLOCKED: manifest names unknown gate `' + gateId + '`'); return 2; }
    const base = str(manifest.base);
    const core = makeCloserCore({ io: { evidencePath: (p) => p }, clock: { now: () => Date.now() } });

    const lock = await acquireLock({ wait: !!args.wait });
    if (!lock.ok && lock.held) { log('another judgement holds the closer lock; exiting 0 as redundant (pass --wait to queue)'); return 0; }
    if (!lock.ok) { errlog('BLOCKED: could not acquire the closer lock: ' + lock.error); return 2; }

    try {
      // Referee checkout — ours alone, never a candidate's, never the Guardian's pin.
      const wt = worktreeAdd(REFEREE_DIR, base);
      if (!wt.ok) { errlog('BLOCKED: ' + wt.reason); return blockOut(core, manifest, 'referee-checkout', wt.reason, runDir); }
      const inst = npmInstall(REFEREE_DIR);
      if (!inst.ok) { errlog('BLOCKED: ' + inst.reason); return blockOut(core, manifest, 'referee-install', inst.reason, runDir); }

      // LOCK 3 — baseline must be RED before any patch can be credited.
      log('baseline: running `' + CLOSER_GATES[gateId].npm + '` at base ' + shortSha(base) + ' (it MUST be red)');
      const baseRun = await runGate(gateId, REFEREE_DIR, path.join(runDir, 'baseline.log'));
      const baseline = { ran: baseRun.ran, red: baseRun.ran && !baseRun.green, detail: baseRun.detail, logFile: baseRun.logFile };
      if (!baseline.ran) errlog('baseline could not run: ' + baseRun.detail);
      else if (!baseline.red) errlog('baseline is GREEN — the finding does not reproduce at this base sha');
      else log('baseline RED (exit ' + baseRun.exitCode + ') — the detector detects; candidates can now be judged');

      // Judge each candidate (skipped entirely when the baseline already disqualified the run —
      // there is nothing to attribute a green to).
      const judged = [];
      if (baseline.ran && baseline.red) {
        for (const c of (Array.isArray(manifest.candidates) ? manifest.candidates : [])) {
          const rec = { id: str(c.id), dir: str(c.dir) };
          log('judging ' + rec.id + ' …');

          if (!fs.existsSync(path.join(rec.dir, '.git'))) {
            rec.applied = false; rec.missing = true; rec.size = { files: 0, lines: 0 };
            errlog('  ' + rec.id + ': worktree is gone — cannot judge');
            judged.push(rec); continue;
          }
          const ex = exportPatch(rec.dir, base);
          if (!ex.ok) { rec.applied = false; rec.size = { files: 0, lines: 0 }; rec.exportError = ex.reason; errlog('  ' + rec.id + ': ' + ex.reason); judged.push(rec); continue; }
          rec.files = ex.files;
          rec.size = patchSize(ex.diff);
          const patchFile = path.join(runDir, rec.id + '.patch');
          fs.writeFileSync(patchFile, ex.diff, 'utf8');
          rec.patchFile = patchFile;

          // A candidate that declined to patch and wrote its reasoning instead is a legitimate,
          // non-winning outcome — surface it rather than reporting a bare empty patch.
          const verdictNote = path.join(rec.dir, 'CLOSER_VERDICT.md');
          if (fs.existsSync(verdictNote)) {
            rec.declined = true;
            try { fs.copyFileSync(verdictNote, path.join(runDir, rec.id + '-CLOSER_VERDICT.md')); } catch (_) {}
          }

          // LOCK 1 — write-set lint, BEFORE the gate is ever run for this candidate.
          const lint = writeSetVerdict({ files: ex.files, gate: gateId });
          if (!lint.ok) {
            rec.disqualified = true; rec.violations = lint.violations;
            errlog('  ' + rec.id + ': DISQUALIFIED — ' + lint.violations.map(v => v.file + ' (' + v.rule + ')').join(', '));
            judged.push(rec); continue;
          }

          // LOCK 2 — oracle separation: judge on the referee's OWN clean tree, not the author's.
          const reset = git(['reset', '--hard', base], REFEREE_DIR);
          if (reset.code !== 0) { rec.applied = false; rec.exportError = 'referee reset failed'; judged.push(rec); continue; }
          git(['clean', '-fd'], REFEREE_DIR);
          const apply = spawnSync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: REFEREE_DIR, encoding: 'utf8', windowsHide: true });
          if ((apply.status == null ? 1 : apply.status) !== 0) {
            rec.applied = false; rec.applyError = str(apply.stderr).slice(-400);
            errlog('  ' + rec.id + ': patch does not apply to a clean base tree');
            judged.push(rec); continue;
          }
          rec.applied = true;

          const gateRun = await runGate(gateId, REFEREE_DIR, path.join(runDir, rec.id + '-gate.log'));
          rec.gateGreen = gateRun.ran && gateRun.green;
          rec.gateLog = gateRun.logFile;
          if (!gateRun.ran) { rec.gateGreen = false; rec.gateBlocked = gateRun.detail; }

          // Collateral: the gate going green is not enough if the fast gate regressed. Skipped when
          // test:fast IS the gate (already proven above).
          if (rec.gateGreen && CLOSER_GATES[gateId].npm !== 'test:fast') {
            const coll = await runGate('test-fast', REFEREE_DIR, path.join(runDir, rec.id + '-collateral.log'));
            rec.collateralGreen = coll.ran && coll.green;
            rec.collateralLog = coll.logFile;
          } else if (rec.gateGreen) {
            rec.collateralGreen = true;
          }
          log('  ' + rec.id + ': ' + (rec.gateGreen && rec.collateralGreen !== false ? 'PASS' : 'fail — ' + closerWhyFailed(rec)));
          judged.push(rec);
        }
      }

      const verdict = refereeVerdict({ baseline, candidates: judged });
      const report = core.verdictMarkdown({ runId, finding: manifest.finding, gate: CLOSER_GATES[gateId].npm, base, verdict });
      fs.writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify({ runId, base, gate: gateId, baseline, verdict }, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(runDir, 'VERDICT.md'), report + '\n', 'utf8');
      console.log('');
      console.log(report);

      if (verdict.verdict === 'blocked') {
        // A Closer that could not judge files its OWN P0 (no-fake-green). This is the only case
        // that files — a no-winner run is silent by design (the defect's finding already stands).
        fileFinding(core.blockedFinding({
          reason: verdict.reason, runId, gate: CLOSER_GATES[gateId].npm, base,
          targetFingerprint: str((manifest.finding || {}).fingerprint),
          title: verdict.reason === 'baseline-not-red'
            ? 'gate `' + CLOSER_GATES[gateId].npm + '` is GREEN at base — the finding does not reproduce'
            : 'gate `' + CLOSER_GATES[gateId].npm + '` could not run at base',
          detail: verdict.detail,
          evidence: [path.join(runDir, 'baseline.log'), path.join(runDir, 'VERDICT.md')],
        }));
        return 2;
      }
      if (verdict.verdict === 'winner') {
        try { fs.copyFileSync(verdict.winner.patchFile, path.join(runDir, 'winner.patch')); } catch (_) {}
        console.log('WINNER: ' + verdict.winner.id + ' → ' + path.join(runDir, 'winner.patch'));
        console.log('The Closer does not merge. Hand this to the merge ritual.');
        return 0;
      }
      return 1;
    } finally { releaseLock(); }
  }

  // File a BLOCKED finding for an infrastructure failure that stopped the run before judging.
  function blockOut(core, manifest, reason, detail, runDir) {
    fileFinding(core.blockedFinding({
      reason, runId: manifest.runId, gate: str(manifest.npm), base: str(manifest.base),
      targetFingerprint: str((manifest.finding || {}).fingerprint),
      title: 'the referee checkout could not be prepared', detail,
      evidence: [path.join(runDir, 'manifest.json')],
    }));
    return 2;
  }

  function cmdList() {
    let names; try { names = fs.readdirSync(RUNS_DIR); } catch (_) { names = []; }
    if (!names.length) { console.log('no closer runs'); return 0; }
    console.log('| Run | Gate | Base | Verdict |');
    console.log('| --- | --- | --- | --- |');
    for (const n of names.sort()) {
      const m = readJsonMaybe(path.join(RUNS_DIR, n, 'manifest.json'));
      if (!m) continue;
      const v = readJsonMaybe(path.join(RUNS_DIR, n, 'verdict.json'));
      console.log('| ' + n + ' | ' + str(m.npm) + ' | ' + shortSha(m.base) + ' | ' + (v ? str(v.verdict && v.verdict.verdict).toUpperCase() : 'open') + ' |');
    }
    return 0;
  }

  function cmdStatus(runId) {
    const md = path.join(RUNS_DIR, str(runId), 'VERDICT.md');
    if (fs.existsSync(md)) { process.stdout.write(fs.readFileSync(md, 'utf8')); return 0; }
    const m = readJsonMaybe(path.join(RUNS_DIR, str(runId), 'manifest.json'));
    if (!m) { errlog('no such run: ' + runId); return 2; }
    console.log('run ' + runId + ' is OPEN (not yet judged) — gate `' + str(m.npm) + '`, base ' + shortSha(m.base));
    for (const c of (m.candidates || [])) console.log('  ' + str(c.id) + '  ' + str(c.dir));
    return 0;
  }

  // Tear down a run's candidate worktrees. The run dir (evidence) is kept — a judged run is a
  // record, and deleting evidence would break the Evidence Law the ledger enforces.
  function cmdClose(runId) {
    const m = readJsonMaybe(path.join(RUNS_DIR, str(runId), 'manifest.json'));
    if (!m) { errlog('no such run: ' + runId); return 2; }
    for (const c of (m.candidates || [])) {
      const r = git(['worktree', 'remove', '--force', str(c.dir)]);
      console.log((r.code === 0 ? 'removed  ' : 'SKIPPED  ') + str(c.dir) + (r.code === 0 ? '' : ' — ' + (r.err || r.out).trim()));
    }
    console.log('evidence kept at ' + path.join(RUNS_DIR, str(runId)));
    return 0;
  }

  const parseArgs = (argv) => {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--open') a.open = argv[++i] || '';
      else if (t === '--referee') a.referee = argv[++i] || '';
      else if (t === '--status') a.status = argv[++i] || '';
      else if (t === '--close') a.close = argv[++i] || '';
      else if (t === '--list') a.list = true;
      else if (t === '--gate') a.gate = argv[++i] || '';
      else if (t === '--base') a.base = argv[++i] || '';
      else if (t === '--candidates') a.candidates = Number(argv[++i]);
      else if (t === '--install-candidates') a.installCandidates = true;
      else if (t === '--wait') a.wait = true;
      else a._.push(t);
    }
    return a;
  };

  const args = parseArgs(process.argv.slice(2));
  const usage = 'usage: node scripts/qa/closer.mjs --open <fingerprint|id> [--candidates N] [--gate <npm|stepId>] [--base <sha>] [--install-candidates]\n' +
                '       node scripts/qa/closer.mjs --referee <runId> [--wait]\n' +
                '       node scripts/qa/closer.mjs --list | --status <runId> | --close <runId>';

  (async () => {
    let code = 2;
    try {
      if (args.open) code = await cmdOpen(args);
      else if (args.referee) code = await cmdReferee(args);
      else if (args.list) code = cmdList();
      else if (args.status) code = cmdStatus(args.status);
      else if (args.close) code = cmdClose(args.close);
      else { console.error(usage); code = 2; }
    } catch (e) {
      errlog('BLOCKED: unhandled error — ' + str(e && e.stack || e));
      code = 2;
    } finally { releaseLock(); }
    process.exit(code);
  })();
}
