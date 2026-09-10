#!/usr/bin/env node
/* scripts/qa/ready.mjs — the Self-Testing Station's READY GATE (lane EL-7).  (`npm run qa:ready`)
 *
 * WHY THIS EXISTS: session after session told Andrew "everything is in perfect standing, ready to
 * go public" while the QA station's OWN ledger showed open findings and the Green Guardian sat RED.
 * The aggregate "ready / go-public" claim was never gated on anything machine-checkable — it was a
 * vibe. This module makes it a VERDICT. One command, one answer: READY or NOT READY with a numbered
 * list of reasons and an auditable receipts block (per check: the artifact consulted, its stamp, its
 * value). Exit 0 ONLY when every check is READY.
 *
 * THE LAW IT ENFORCES (READY-GATE, docs/DECISIONS.md + .claude/skills/starnet-verify): no session,
 * report, or doc may claim StarNet is release-ready / "ready" / "go-public-able" without a fresh
 * `npm run qa:ready` receipt printed alongside the claim. Lane-level done stays lane-level.
 * Scope boundary: READY is this six-check release-readiness aggregate only. It is not exhaustive
 * product-perfection proof and must never be reported as `PRODUCT PERFECT`; that exact verdict is
 * reserved to `npm run qa:product-perfect` after its candidate-bound W0–W7 campaign passes.
 *
 * THE SIX CHECKS (each grounded in a real artifact; a check that CANNOT run is NOT READY — loud):
 *   1. ledger      — open P0/P1 findings == 0. Counted by the ledger's OWN authority
 *                    (scripts/qa/ledger.mjs openBySeverity()); we never re-parse status/severity.
 *   2. guardian    — last cycle GREEN, FRESH (<=24h), and it saw the CURRENT trunk head (no drift):
 *                    a green cycle against an old commit does not vouch for what merged since.
 *   3. journeys    — qa:journeys last run == pass, FRESH (<=24h).
 *   4. beginner    — Beginner Run last result == PASS (never STUCK/FAIL), FRESH (<=24h).
 *   5. installed   — qa/installed/last-smoke.json (written by the rc-soak lane) GREEN + FRESH (<=7d).
 *
 * NO-FAKE-GREEN LAW: a missing artifact, an unreadable stamp, a git failure, or a thrown error is
 * NOT READY with the reason stated — NEVER a silent pass. The whole point is that "ready" can only
 * be earned, never assumed.
 *
 * HOUSE PATTERN (matches ledger.mjs / guardian.mjs / beginner-run.mjs): the CORE is a set of PURE
 * functions — no ambient time, no ambient disk, no git. The host injects every artifact object + a
 * `now` clock + config, so the whole verdict logic tests headlessly (test/qa-ready.test.js) and is
 * deterministic. The IO SHELL / CLI at the foot is the ONLY place fs + git + Date.now() live (the
 * composition root). The static imports below are side-effect-free so require(esm) from the CJS test
 * works with no top-level await.
 *
 * CLI:
 *   node scripts/qa/ready.mjs            # print the verdict + receipts; exit 0 iff READY
 *   node scripts/qa/ready.mjs --json     # machine-readable verdict object on stdout, then exit
 * Env knobs (all optional): READY_MAX_STALE_MS (default 24h), READY_MAX_INSTALLED_STALE_MS (7d),
 *   READY_MAX_TRUNK_DRIFT (default 0 — the guardian must have seen the exact current trunk head),
 *   SKYNET_GUARDIAN_TRUNK (default feat/harness-backend).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeLedger } from './ledger.mjs';
import { makeBugRegister } from './bugs.mjs';
import {
  KINDS,
  classifyProvenance,
  externallyVerifyOfficialEvidence,
  normalizeOfficialEvidence,
} from './product-perfect/provenance.mjs';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULTS = Object.freeze({
  maxStaleMs: DAY_MS,               // guardian / journeys / beginner freshness window
  maxInstalledStaleMs: 7 * DAY_MS,  // installed-exe smoke is a heavier, weekly proof
  maxTrunkDrift: 0,                 // 0 = the guardian must have run on the CURRENT trunk head
});

function str(v) { return v == null ? '' : String(v); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

// Verify bytes against a receipt identity without trusting a filename or prior stat result. The IO
// shell uses this for both the supplied executable and every evidence file; tests can exercise the
// tamper behavior with in-memory bytes.
export function verifyContentIdentity(identity, contents) {
  const sha256 = str(identity && identity.sha256).trim().toLowerCase();
  const size = Number(identity && identity.size);
  if (!identity || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, error: 'receipt identity is missing or invalid' };
  }
  let bytes;
  try { bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents); }
  catch (_) { return { ok: false, error: 'file bytes are unreadable' }; }
  if (bytes.length !== size) return { ok: false, error: 'file size does not match receipt' };
  const observed = crypto.createHash('sha256').update(bytes).digest('hex');
  if (observed !== sha256) return { ok: false, error: 'file SHA-256 does not match receipt' };
  return { ok: true };
}

// Human-readable age for a receipt/reason string ("42s", "18m", "26h", "9d"). Coarse on purpose.
export function humanAge(ms) {
  const n = num(ms);
  const s = Math.round(n / 1000);
  if (s < 90) return s + 's';
  const m = Math.round(s / 60);
  if (m < 90) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

// Freshness of an ISO stamp against an injected now. Fail-CLOSED: an unparseable stamp is NOT fresh
// (a broken clock/stamp must never read as "recent" — no-fake-green).
export function freshness(stampIso, nowMs, maxStaleMs) {
  const t = Date.parse(str(stampIso));
  if (!isFinite(t)) return { ok: false, ageMs: null, reason: 'unreadable stamp time "' + str(stampIso) + '"' };
  const ageMs = num(nowMs) - t;
  if (ageMs < -5 * 60 * 1000) return { ok: false, ageMs, reason: 'future-dated by ' + humanAge(-ageMs) };
  if (ageMs > num(maxStaleMs)) return { ok: false, ageMs, reason: 'stale — ' + humanAge(ageMs) + ' old (max ' + humanAge(maxStaleMs) + ')' };
  return { ok: true, ageMs, reason: humanAge(ageMs) + ' old' };
}

const receipt = (artifact, stamp, value) => ({ artifact: str(artifact), stamp: str(stamp), value: str(value) });

// ---- CHECK 1: ledger open P0/P1 == 0 -------------------------------------------------------------
// input: { ok, counts:{P0,P1,P2}, error?, artifact? } — `counts` is the ledger's own openBySeverity().
export function checkLedger(input) {
  input = input || {};
  const artifact = input.artifact || 'qa/findings/ (via ledger.mjs)';
  if (input.error) {
    return { id: 'ledger', label: 'Ledger open P0/P1', ok: false, reason: 'could not read the ledger: ' + str(input.error), receipt: receipt(artifact, '', 'ERROR') };
  }
  const c = input.counts || {};
  const p0 = num(c.P0), p1 = num(c.P1), p2 = num(c.P2);
  const blocking = p0 + p1;
  const value = p0 + ' P0 · ' + p1 + ' P1 · ' + p2 + ' P2';
  if (blocking > 0) {
    return { id: 'ledger', label: 'Ledger open P0/P1', ok: false, reason: blocking + ' open blocking finding' + (blocking === 1 ? '' : 's') + ' (' + p0 + ' P0 · ' + p1 + ' P1) — the ledger must be clear of P0/P1', receipt: receipt(artifact, '', value) };
  }
  return { id: 'ledger', label: 'Ledger open P0/P1', ok: true, reason: 'no open P0/P1 findings', receipt: receipt(artifact, '', value) };
}

// Canonical per-bug register check. Counts must come from bugs.mjs, which owns status parsing.
export function checkBugRegister(input) {
  input = input || {};
  const artifact = input.artifact || 'qa/bugs/ (via bugs.mjs)';
  const mk = (ok, reason, value) => ({ id: 'bugs', label: 'Bug register open P0/P1', ok, reason, receipt: receipt(artifact, '', value) });
  if (input.error) return mk(false, 'could not read or validate the bug register: ' + str(input.error), 'ERROR');
  const c = input.counts || {};
  const p0 = num(c.P0), p1 = num(c.P1), p2 = num(c.P2);
  const blocking = p0 + p1;
  const value = p0 + ' P0 · ' + p1 + ' P1 · ' + p2 + ' P2';
  if (blocking > 0) {
    return mk(false, blocking + ' open blocking bug' + (blocking === 1 ? '' : 's') + ' (' + p0 + ' P0 · ' + p1 + ' P1) — qa/bugs must be clear of P0/P1', value);
  }
  return mk(true, 'no open/claimed P0/P1 bugs', value);
}

// ---- CHECK 2: guardian last cycle GREEN + fresh + saw current trunk ------------------------------
// input: { missing?, error?, stampIso, trunkHead, result, gatesRan:[], gatesSkipped:[], artifact? }
// cfg:   { nowMs, maxStaleMs, currentTrunk, trunkDrift, driftError? }
export function checkGuardian(input, cfg) {
  input = input || {}; cfg = cfg || {};
  const artifact = input.artifact || 'qa/guardian-last-cycle.json';
  const mk = (ok, reason, value, stamp) => ({ id: 'guardian', label: 'Green Guardian last cycle', ok, reason, receipt: receipt(artifact, stamp || input.stampIso || '', value) });
  if (input.missing) return mk(false, 'no guardian cycle recorded — run `npm run qa:guardian`', 'MISSING');
  if (input.error) return mk(false, 'guardian stamp unreadable: ' + str(input.error), 'ERROR');

  const result = str(input.result).toLowerCase();
  const skipped = Array.isArray(input.gatesSkipped) ? input.gatesSkipped : [];
  const ran = Array.isArray(input.gatesRan) ? input.gatesRan : [];
  const value = result.toUpperCase() + ' · ran[' + ran.join(',') + ']' + (skipped.length ? ' · SKIPPED[' + skipped.join(',') + ']' : '') + ' · @' + str(input.trunkHead).slice(0, 8);

  if (result !== 'green') return mk(false, 'last guardian cycle was ' + (result ? result.toUpperCase() : 'not GREEN'), value);
  if (skipped.length) return mk(false, 'last cycle SKIPPED gate(s) [' + skipped.join(', ') + '] — a partial (e.g. --skip-visual) cycle cannot vouch for readiness', value);

  const fresh = freshness(input.stampIso, cfg.nowMs, cfg.maxStaleMs != null ? cfg.maxStaleMs : DEFAULTS.maxStaleMs);
  if (!fresh.ok) return mk(false, 'guardian cycle ' + fresh.reason, value);

  // trunk drift: the guardian ran on input.trunkHead; the host counted how many commits current trunk
  // is ahead. A drift the host could not compute is fail-closed (no-fake-green).
  if (cfg.driftError) return mk(false, 'could not verify the guardian saw current trunk: ' + str(cfg.driftError), value);
  const drift = num(cfg.trunkDrift);
  const maxDrift = cfg.maxTrunkDrift != null ? num(cfg.maxTrunkDrift) : DEFAULTS.maxTrunkDrift;
  if (maxDrift === 0 && drift === 0 && str(input.trunkHead).toLowerCase() !== str(cfg.currentTrunk).toLowerCase()) {
    return mk(false, 'guardian has not seen the exact current trunk (' + str(input.trunkHead).slice(0, 8) + ' vs ' + str(cfg.currentTrunk).slice(0, 8) + ')', value);
  }
  if (drift > maxDrift) {
    return mk(false, 'guardian has not seen current trunk — it ran ' + drift + ' commit' + (drift === 1 ? '' : 's') + ' behind head (' + str(input.trunkHead).slice(0, 8) + ' vs ' + str(cfg.currentTrunk).slice(0, 8) + ')', value + ' behind by ' + drift);
  }
  return mk(true, 'GREEN, ' + fresh.reason + ', on current trunk (' + str(input.trunkHead).slice(0, 8) + ')', value);
}

// ---- CHECK 3: journeys last run == pass + fresh --------------------------------------------------
// input: { missing?, error?, stampIso, trunkHead, result, passed, total, artifact? }
export function checkJourneys(input, cfg) {
  input = input || {}; cfg = cfg || {};
  const artifact = input.artifact || 'qa/journeys-last-run.json';
  const mk = (ok, reason, value) => ({ id: 'journeys', label: 'Journey corps last run', ok, reason, receipt: receipt(artifact, input.stampIso || '', value) });
  if (input.missing) return mk(false, 'no journeys run recorded — run `npm run qa:journeys`', 'MISSING');
  if (input.error) return mk(false, 'journeys stamp unreadable: ' + str(input.error), 'ERROR');

  const result = str(input.result).toLowerCase();
  const value = result.toUpperCase() + ' · ' + num(input.passed) + '/' + num(input.total) + ' assertions';
  if (result !== 'pass') return mk(false, 'last journeys run was ' + (result ? result.toUpperCase() : 'not a pass'), value);
  if (input.fullSuite !== true) return mk(false, 'journeys receipt does not prove the full suite — run `npm run qa:journeys` without --only', value);
  if (!/^[0-9a-f]{40}$/i.test(str(input.trunkHead)) || str(input.trunkHead).toLowerCase() !== str(cfg.currentTrunk).toLowerCase()) {
    return mk(false, 'journeys did not run on the exact current trunk (' + (str(input.trunkHead).slice(0, 8) || 'missing') + ' vs ' + str(cfg.currentTrunk).slice(0, 8) + ')', value);
  }
  const fresh = freshness(input.stampIso, cfg.nowMs, cfg.maxStaleMs != null ? cfg.maxStaleMs : DEFAULTS.maxStaleMs);
  if (!fresh.ok) return mk(false, 'journeys run ' + fresh.reason, value);
  return mk(true, 'PASS, ' + fresh.reason, value);
}

// ---- CHECK 4: beginner run PASS (not STUCK/FAIL) + fresh -----------------------------------------
// input: { missing?, error?, stampIso, trunkHead, result, mode, totalMs, stalledStep, artifact? }
export function checkBeginner(input, cfg) {
  input = input || {}; cfg = cfg || {};
  const artifact = input.artifact || 'qa/beginner-last-run.json';
  const mk = (ok, reason, value) => ({ id: 'beginner', label: 'Beginner Run last result', ok, reason, receipt: receipt(artifact, input.stampIso || '', value) });
  if (input.missing) return mk(false, 'no Beginner Run recorded — run `npm run qa:beginner`', 'MISSING');
  if (input.error) return mk(false, 'beginner stamp unreadable: ' + str(input.error), 'ERROR');

  const result = str(input.result);
  const up = result.toUpperCase();
  const value = up + (input.mode ? ' · ' + str(input.mode) : '') + (input.totalMs != null ? ' · ' + num(input.totalMs) + 'ms' : '');
  // STUCK@<step> / FAIL / anything that isn't a clean PASS is a fresh-user-path regression (thesis-critical).
  if (up !== 'PASS') {
    const why = /^STUCK/.test(up) ? 'the fresh-user path is stuck (' + result + ')' : 'last Beginner Run result was ' + (result || 'not PASS');
    return mk(false, why, value);
  }
  if (!/^[0-9a-f]{40}$/i.test(str(input.trunkHead)) || str(input.trunkHead).toLowerCase() !== str(cfg.currentTrunk).toLowerCase()) {
    return mk(false, 'Beginner Run did not run on the exact current trunk (' + (str(input.trunkHead).slice(0, 8) || 'missing') + ' vs ' + str(cfg.currentTrunk).slice(0, 8) + ')', value);
  }
  const fresh = freshness(input.stampIso, cfg.nowMs, cfg.maxStaleMs != null ? cfg.maxStaleMs : DEFAULTS.maxStaleMs);
  if (!fresh.ok) return mk(false, 'Beginner Run ' + fresh.reason, value);
  return mk(true, 'PASS, ' + fresh.reason, value);
}

// ---- CHECK 5: installed-exe smoke stamp GREEN + fresh (<=7d) -------------------------------------
// input: installed-smoke schema v3 plus host-verified evidence/artifact flags.
export function checkInstalled(input, cfg) {
  input = input || {}; cfg = cfg || {};
  const artifact = input.artifact || 'qa/installed/last-smoke.json';
  const mk = (ok, reason, value) => ({ id: 'installed', label: 'Installed-exe smoke', ok, reason, receipt: receipt(artifact, input.stampIso || '', value) });
  // This file is written by a SIBLING lane (agent/rc-soak). Missing today is a CORRECT NOT READY.
  if (input.missing) return mk(false, 'installed app unverified — no installed-exe smoke stamp (the rc-soak runner has not written qa/installed/last-smoke.json)', 'MISSING');
  if (input.error) return mk(false, 'installed app unverified — smoke stamp unreadable: ' + str(input.error), 'ERROR');

  const result = str(input.result).toUpperCase();
  const value = result + (input.appVersion ? ' · v' + str(input.appVersion) : '') +
    (input.buildCommit ? ' · @' + str(input.buildCommit).slice(0, 8) : '') +
    (input.provenanceKind ? ' · ' + str(input.provenanceKind) : '') +
    (input.mode ? ' · ' + str(input.mode) : '');
  if (input.schemaVersion !== 3) return mk(false, 'installed app unverified — legacy or unknown receipt schema (v3 desktop proof required)', value || 'INVALID SCHEMA');
  if (result !== 'GREEN') return mk(false, 'installed app unverified — last smoke was ' + (result || 'not GREEN'), value);
  if (!str(input.appVersion).trim()) return mk(false, 'installed app unverified — receipt has no proven app version', value);
  if (input.mode !== 'desktop' || !['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'app://localhost'].includes(str(input.origin))) {
    return mk(false, 'installed app unverified — receipt did not prove a trusted packaged desktop origin', value);
  }
  if (input.buildDirty !== false) return mk(false, 'installed app unverified — packaged build is dirty or dirty state is unknown', value);
  const head = str(cfg.currentTrunk).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return mk(false, 'installed app unverified — current trunk commit is unresolved', value);
  if (str(input.expectedHead).toLowerCase() !== head || str(input.buildCommit).toLowerCase() !== head) {
    return mk(false, 'installed app unverified — tested binary source does not equal current trunk', value);
  }
  const tree = str(cfg.currentTree).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(tree)) return mk(false, 'installed app unverified — current source tree is unresolved', value);
  if (str(input.expectedTree).toLowerCase() !== tree || str(input.sourceTree).toLowerCase() !== tree) {
    return mk(false, 'installed app unverified — tested binary source tree does not equal the candidate tree', value);
  }
  if (!str(input.buildDescribe) || str(input.buildDescribe) !== str(input.sidecarHarness)) {
    return mk(false, 'installed app unverified — desktop shell and sidecar provenance disagree', value);
  }
  if (!input.artifact || !/^[0-9a-f]{64}$/i.test(str(input.artifact.sha256)) || !(Number(input.artifact.size) > 0)) {
    return mk(false, 'installed app unverified — receipt has no hashed executable artifact', value);
  }
  const runtimeSha256 = str(input.runtimeExecutable && input.runtimeExecutable.sha256).toLowerCase();
  const runtimeSize = Number(input.runtimeExecutable && input.runtimeExecutable.size);
  if (!/^[0-9a-f]{64}$/.test(runtimeSha256) || !Number.isSafeInteger(runtimeSize) || runtimeSize <= 0) {
    return mk(false, 'installed app unverified — receipt has no runtime executable identity', value);
  }
  if (runtimeSha256 !== str(input.artifact.sha256).toLowerCase() || runtimeSize !== Number(input.artifact.size)) {
    return mk(false, 'installed app unverified — supplied artifact does not equal the executable that was running', value);
  }
  const buildKind = str(input.buildKind).toLowerCase();
  const provenanceKind = str(input.provenanceKind).toLowerCase();
  if (buildKind !== KINDS.REPRODUCIBLE_SOURCE && buildKind !== KINDS.CUSTOM) {
    return mk(false, 'installed app unverified — running BuildInfo has no clean reproducible-source/custom classification', value);
  }
  const base = classifyProvenance({
    commitSha: input.buildCommit,
    sourceTree: input.sourceTree,
    dirty: input.buildDirty !== false,
    declaredKind: buildKind,
    artifact: input.artifact,
  });
  if (base.kind !== buildKind) return mk(false, 'installed app unverified — BuildInfo provenance classification is inconsistent', value);
  if (buildKind === KINDS.CUSTOM && provenanceKind !== KINDS.CUSTOM) {
    return mk(false, 'installed app unverified — an explicit custom build was relabeled', value);
  }
  if (buildKind === KINDS.REPRODUCIBLE_SOURCE && provenanceKind !== KINDS.REPRODUCIBLE_SOURCE && provenanceKind !== KINDS.OFFICIAL) {
    return mk(false, 'installed app unverified — installed provenance classification is invalid', value);
  }
  if (provenanceKind !== KINDS.OFFICIAL && input.officialEvidence != null) {
    return mk(false, 'installed app unverified — non-official receipt carries an official-evidence assertion', value);
  }
  if (provenanceKind === KINDS.OFFICIAL) {
    const official = normalizeOfficialEvidence(input.officialEvidence);
    const exactOfficial = official && official.candidateCommit === str(input.buildCommit).toLowerCase() &&
      official.sourceTree === str(input.sourceTree).toLowerCase() &&
      official.artifact.sha256 === str(input.artifact.sha256).toLowerCase() && official.artifact.size === Number(input.artifact.size);
    if (!exactOfficial || input.officialEvidenceVerified !== true) {
      return mk(false, 'installed app unverified — official label lacks externally reverified exact release evidence' + (input.officialEvidenceError ? ': ' + str(input.officialEvidenceError) : ''), value);
    }
  }
  if (input.artifactVerified !== true) return mk(false, 'installed app unverified — artifact path/hash could not be reverified' + (input.artifactError ? ': ' + str(input.artifactError) : ''), value);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidenceVerified !== true) {
    return mk(false, 'installed app unverified — evidence files are missing or unreadable' + (input.evidenceError ? ': ' + str(input.evidenceError) : ''), value);
  }
  const fresh = freshness(input.stampIso, cfg.nowMs, cfg.maxInstalledStaleMs != null ? cfg.maxInstalledStaleMs : DEFAULTS.maxInstalledStaleMs);
  if (!fresh.ok) return mk(false, 'installed app unverified — smoke ' + fresh.reason, value);
  return mk(true, 'GREEN, ' + fresh.reason, value);
}

/* Read-only, host-callable installed identity authority for W0 and other narrow gates.
 * It reads exactly one receipt, rehashes the named executable/evidence, resolves the supplied
 * candidate's source tree, and returns a standalone verdict. It does not run Guardian/Journeys,
 * mutate process state, write evidence, print, or exit.
 */
export function inspectInstalledIdentity(opts) {
  opts = opts || {};
  const repoRoot = path.resolve(str(opts.repoRoot || '.'));
  const receiptPath = path.resolve(str(opts.receiptPath || path.join(repoRoot, 'qa', 'installed', 'last-smoke.json')));
  const candidateSha = str(opts.candidateSha).trim().toLowerCase();
  const io = opts.io || fs;
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const resolveCandidateTree = typeof opts.resolveCandidateTree === 'function'
    ? opts.resolveCandidateTree
    : (sha, cwd) => {
        if (!/^[0-9a-f]{40}$/.test(sha)) return '';
        const result = spawnSync('git', ['rev-parse', sha + '^{tree}'], { cwd, encoding: 'utf8', windowsHide: true });
        return result.status === 0 ? str(result.stdout).trim().toLowerCase() : '';
      };
  let candidateTree = '';
  try { candidateTree = str(resolveCandidateTree(candidateSha, repoRoot)).trim().toLowerCase(); }
  catch (_) { candidateTree = ''; }

  let data = null;
  let input;
  try {
    if (!io.existsSync(receiptPath)) input = { missing: true };
    else data = JSON.parse(io.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    input = { error: str(error && error.message || error) };
  }

  if (data) {
    const evidence = Array.isArray(data.evidence) ? data.evidence : [];
    let evidenceProof = evidence.length ? { ok: true, error: '' } : { ok: false, error: 'no content-bound evidence files' };
    for (const entry of evidenceProof.ok ? evidence : []) {
      if (!entry || typeof entry !== 'object' || !str(entry.path)) {
        evidenceProof = { ok: false, error: 'evidence identity missing or invalid' };
        break;
      }
      const resolved = path.resolve(repoRoot, str(entry.path));
      const rel = path.relative(repoRoot, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        evidenceProof = { ok: false, error: 'evidence escapes repository: ' + str(entry.path) };
        break;
      }
      try {
        if (!io.statSync(resolved).isFile()) throw new Error('evidence is not a file');
        const proof = verifyContentIdentity(entry, io.readFileSync(resolved));
        if (!proof.ok) {
          evidenceProof = { ok: false, error: str(entry.path) + ': ' + proof.error };
          break;
        }
      } catch (error) {
        evidenceProof = { ok: false, error: 'evidence missing or unreadable: ' + str(entry.path) + ' (' + str(error && error.message || error) + ')' };
        break;
      }
    }

    let artifactProof = { ok: false, error: 'artifact path missing' };
    const artifact = data.artifact;
    if (artifact && str(artifact.path)) {
      try {
        const resolved = path.isAbsolute(str(artifact.path)) ? path.resolve(str(artifact.path)) : path.resolve(repoRoot, str(artifact.path));
        if (!io.statSync(resolved).isFile()) throw new Error('artifact path is not a file');
        artifactProof = verifyContentIdentity(artifact, io.readFileSync(resolved));
      } catch (error) {
        artifactProof = { ok: false, error: str(error && error.message || error) };
      }
    }

    let officialEvidenceVerified = false;
    let officialEvidenceError = '';
    if (str(data.provenanceKind).toLowerCase() === KINDS.OFFICIAL) {
      const external = externallyVerifyOfficialEvidence(data.officialEvidence, opts.verifyOfficialEvidence);
      const classified = classifyProvenance({
        commitSha: data.buildCommit,
        sourceTree: data.sourceTree,
        dirty: data.buildDirty !== false,
        declaredKind: data.buildKind,
        artifact: data.artifact,
        verifiedOfficialEvidence: external.capability,
      });
      officialEvidenceVerified = external.ok === true && classified.kind === KINDS.OFFICIAL;
      officialEvidenceError = external.error || (officialEvidenceVerified ? '' : 'official evidence did not match candidate/tree/artifact');
    }

    input = Object.assign({}, data, {
      artifactVerified: artifactProof.ok,
      artifactError: artifactProof.error,
      evidenceVerified: evidenceProof.ok,
      evidenceError: evidenceProof.error,
      officialEvidenceVerified,
      officialEvidenceError,
    });
  }

  input = input || { error: 'installed receipt could not be read' };
  const cfg = {
    nowMs,
    maxInstalledStaleMs: opts.maxInstalledStaleMs != null ? Number(opts.maxInstalledStaleMs) : DEFAULTS.maxInstalledStaleMs,
    currentTrunk: candidateSha,
    currentTree: candidateTree,
  };
  const check = checkInstalled(input, cfg);
  const status = check.ok ? 'PASS' : (str(input.result).toUpperCase() === 'RED' ? 'RED' : 'BLOCKED');
  return {
    ok: check.ok,
    status,
    reasons: check.ok ? [] : [check.reason],
    check,
    input,
    receiptPath,
    candidateSha,
    candidateTree,
  };
}

// Fold every check into ONE verdict. `artifacts` carries each check's already-read input; `cfg` carries
// now + windows + trunk-drift facts (all host-computed). Returns a fully auditable verdict object.
export function evaluate(artifacts, cfg) {
  artifacts = artifacts || {}; cfg = cfg || {};
  const checks = [
    checkLedger(artifacts.ledger),
    checkBugRegister(artifacts.bugs),
    checkGuardian(artifacts.guardian, cfg),
    checkJourneys(artifacts.journeys, cfg),
    checkBeginner(artifacts.beginner, cfg),
    checkInstalled(artifacts.installed, cfg),
  ];
  const failing = checks.filter(c => !c.ok);
  const ready = failing.length === 0;
  const reasons = failing.map((c, i) => (i + 1) + '. ' + c.label + ': ' + c.reason);
  return { ready, checks, reasons, failing: failing.map(c => c.id) };
}

// Render the human verdict + receipts block from an evaluate() result. Pure string builder so a test
// can assert the exact surface a session pastes into a report.
export function renderVerdict(v) {
  v = v || {};
  const lines = [];
  lines.push(v.ready ? 'READY' : 'NOT READY — ' + (v.reasons || []).length + ' reason' + ((v.reasons || []).length === 1 ? '' : 's'));
  if (!v.ready) { lines.push(''); for (const r of v.reasons) lines.push('  ' + r); }
  lines.push('');
  lines.push('receipts:');
  for (const c of (v.checks || [])) {
    const rc = c.receipt || {};
    const mark = c.ok ? 'PASS' : 'FAIL';
    lines.push('  [' + mark + '] ' + c.label);
    lines.push('        artifact: ' + str(rc.artifact));
    if (rc.stamp) lines.push('        stamp:    ' + str(rc.stamp));
    lines.push('        value:    ' + str(rc.value));
    lines.push('        → ' + str(c.reason));
  }
  return lines.join('\n');
}

/* ───────────────────────────── IO SHELL / CLI ─────────────────────────────
 * The ONLY place ambient fs + git + Date.now() live (the composition root). Runs only when invoked
 * directly. The static imports above are side-effect-free so the CJS test can require() the pure core
 * without any of this executing.
 */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(__dirname, '..', '..');              // scripts/qa/ -> repo root
  const QA_DIR = path.join(REPO, 'qa');
  const FINDINGS_DIR = path.join(QA_DIR, 'findings');
  const KNOWN_FILE = path.join(QA_DIR, 'KNOWN_ISSUES.md');
  const TRUNK_BRANCH = process.env.SKYNET_GUARDIAN_TRUNK || 'feat/harness-backend';

  const nowMs = Date.now();
  const cfg = {
    nowMs,
    maxStaleMs: Number(process.env.READY_MAX_STALE_MS) || DEFAULTS.maxStaleMs,
    maxInstalledStaleMs: Number(process.env.READY_MAX_INSTALLED_STALE_MS) || DEFAULTS.maxInstalledStaleMs,
    maxTrunkDrift: process.env.READY_MAX_TRUNK_DRIFT != null && process.env.READY_MAX_TRUNK_DRIFT !== '' ? Number(process.env.READY_MAX_TRUNK_DRIFT) : DEFAULTS.maxTrunkDrift,
  };

  const readJsonMaybe = (file) => {
    if (!fs.existsSync(file)) return { missing: true };
    try { return { data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (e) { return { error: e && e.message || String(e) }; }
  };

  // ---- CHECK 1 input: the ledger's OWN open-by-severity count (never re-parsed here) ----
  const readKnownFingerprints = () => {
    try {
      const txt = fs.readFileSync(KNOWN_FILE, 'utf8');
      const out = new Set();
      const re = /fingerprint[:=]\s*`?([0-9a-fA-F]{6,})`?/g;
      let m; while ((m = re.exec(txt))) out.add(m[1].toLowerCase());
      return out;
    } catch (_) { return new Set(); }
  };
  const ledgerInput = (() => {
    try {
      const led = makeLedger({
        strictRead: true,
        clock: { now: () => nowMs },
        io: {
          listFindings() {
            let names; try { names = fs.readdirSync(FINDINGS_DIR); } catch (e) { throw new Error('findings directory unreadable: ' + (e && e.message || e)); }
            const out = [];
            for (const n of names) {
              if (!n.endsWith('.json')) continue;
              try { out.push(JSON.parse(fs.readFileSync(path.join(FINDINGS_DIR, n), 'utf8'))); }
              catch (e) { throw new Error('finding unreadable ' + n + ': ' + (e && e.message || e)); }
            }
            return out;
          },
          knownFingerprints() { return readKnownFingerprints(); }
        }
      });
      if (typeof led.openBySeverity !== 'function') {
        return { error: 'ledger.openBySeverity() unavailable (ledger.mjs out of date)' };
      }
      const c = led.openBySeverity();
      return { ok: true, counts: { P0: c.P0, P1: c.P1, P2: c.P2 }, rows: c.rows };
    } catch (e) { return { error: e && e.message || String(e) }; }
  })();

  // ---- CHECK 2 input: the canonical per-bug register's own parser, validator and counts ----
  const bugsInput = (() => {
    try {
      const bugsDir = path.join(QA_DIR, 'bugs');
      const reg = makeBugRegister({
        io: {
          listBugs() {
            let names; try { names = fs.readdirSync(bugsDir); }
            catch (e) { throw new Error('bugs directory unreadable: ' + (e && e.message || e)); }
            return names.filter(n => n.endsWith('.md') && n !== 'README.md').sort().map(n => {
              try { return { file: n, text: fs.readFileSync(path.join(bugsDir, n), 'utf8') }; }
              catch (e) { throw new Error('bug unreadable ' + n + ': ' + (e && e.message || e)); }
            });
          },
          writeBug() { throw new Error('READY gate bug register is read-only'); },
          knownFingerprints() { return readKnownFingerprints(); },
        },
      });
      const valid = reg.validate();
      if (!valid.ok) return { error: valid.errors.join('; ') };
      const c = reg.counts();
      return { counts: { P0: c.bySeverity.P0, P1: c.bySeverity.P1, P2: c.bySeverity.P2 } };
    } catch (e) { return { error: e && e.message || String(e) }; }
  })();

  // ---- git: current trunk head + how far the guardian's cycle is BEHIND it (trunk drift) ----
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
    return { code: r.status == null ? 1 : r.status, out: str(r.stdout).trim(), err: str(r.stderr).trim() };
  };
  const headRes = git(['rev-parse', TRUNK_BRANCH]);
  const currentTrunk = headRes.code === 0 ? headRes.out : '';
  cfg.currentTrunk = currentTrunk;

  // ---- CHECK 2 input: guardian last-cycle stamp ----
  const gRead = readJsonMaybe(path.join(QA_DIR, 'guardian-last-cycle.json'));
  const guardianInput = gRead.missing ? { missing: true }
    : gRead.error ? { error: gRead.error }
    : {
        stampIso: gRead.data.stampIso, trunkHead: gRead.data.trunkHead, result: gRead.data.result,
        gatesRan: gRead.data.gatesRan, gatesSkipped: gRead.data.gatesSkipped,
      };
  // compute trunk drift only when we have both heads; fail-closed on any git error.
  if (!gRead.missing && !gRead.error) {
    if (!currentTrunk) { cfg.driftError = 'could not resolve ' + TRUNK_BRANCH + ' (' + (headRes.err || 'git rev-parse failed') + ')'; }
    else if (!guardianInput.trunkHead) { cfg.driftError = 'guardian stamp carries no trunkHead'; }
    else if (guardianInput.trunkHead === currentTrunk) { cfg.trunkDrift = 0; }
    else {
      const cnt = git(['rev-list', '--count', guardianInput.trunkHead + '..' + currentTrunk]);
      if (cnt.code !== 0) cfg.driftError = 'git rev-list failed (' + (cnt.err || 'the guardian head may not be in this repo') + ')';
      else cfg.trunkDrift = Number(cnt.out) || 0;
    }
  }

  // ---- CHECK 3/4/5 inputs ----
  const jRead = readJsonMaybe(path.join(QA_DIR, 'journeys-last-run.json'));
  const journeysInput = jRead.missing ? { missing: true } : jRead.error ? { error: jRead.error }
    : { stampIso: jRead.data.stampIso, trunkHead: jRead.data.trunkHead, result: jRead.data.result, passed: jRead.data.passed, total: jRead.data.total, fullSuite: jRead.data.fullSuite };

  const bRead = readJsonMaybe(path.join(QA_DIR, 'beginner-last-run.json'));
  const beginnerInput = bRead.missing ? { missing: true } : bRead.error ? { error: bRead.error }
    : { stampIso: bRead.data.stampIso, trunkHead: bRead.data.trunkHead, result: bRead.data.result, mode: bRead.data.mode, totalMs: bRead.data.totalMs, stalledStep: bRead.data.stalledStep };

  const installedInspection = inspectInstalledIdentity({
    repoRoot: REPO,
    receiptPath: path.join(QA_DIR, 'installed', 'last-smoke.json'),
    candidateSha: currentTrunk,
    nowMs,
    maxInstalledStaleMs: cfg.maxInstalledStaleMs,
  });
  cfg.currentTree = installedInspection.candidateTree;
  const installedInput = installedInspection.input;

  const verdict = evaluate({ ledger: ledgerInput, bugs: bugsInput, guardian: guardianInput, journeys: journeysInput, beginner: beginnerInput, installed: installedInput }, cfg);

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({
      ready: verdict.ready, reasons: verdict.reasons, failing: verdict.failing,
      checks: verdict.checks, generatedAt: new Date(nowMs).toISOString(),
      trunk: { branch: TRUNK_BRANCH, head: currentTrunk, guardianDrift: cfg.trunkDrift, driftError: cfg.driftError || null },
    }, null, 2) + '\n');
  } else {
    console.log(renderVerdict(verdict));
    console.log('');
    console.log('trunk ' + TRUNK_BRANCH + ' @ ' + (currentTrunk ? currentTrunk.slice(0, 8) : '(unresolved)') +
      (cfg.trunkDrift != null ? ' · guardian drift ' + cfg.trunkDrift : '') +
      (cfg.driftError ? ' · drift-error: ' + cfg.driftError : '') +
      ' · generated ' + new Date(nowMs).toISOString());
  }
  process.exit(verdict.ready ? 0 : 1);
}
