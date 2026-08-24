#!/usr/bin/env node
// golden.mjs — golden-frame CHANGE DETECTION for StarNet's UI.  (`npm run golden`)
//
// The point (mission DoD #3/#4): a no-code-change re-run is all-PASS with zero human input; a real
// visual change is FLAGGED with the offending frame; and the vision model then judges ONLY the
// flagged frames — never re-judging everything every run.
//
// HOW it tolerates the always-animating floor: it doesn't pixel-diff. It reduces each frame to a
// small downscaled grayscale SIGNATURE (scripts/lib/png.mjs) and compares mean-abs-diff against a
// committed baseline (scripts/goldens.json). Local animation jitter averages out (tiny diff);
// structural change — a panel that moved, a layout break, a colour shift — spikes the diff past the
// threshold. Tune the threshold to sit above the measured animation-noise floor.
//
// Usage:
//   npm run golden:bless     # capture current UI as the baseline (scripts/goldens.json)
//   npm run golden           # capture + diff vs baseline; nonzero exit + list of CHANGED frames
//   SKYNET_GOLDEN_THRESHOLD=8 npm run golden
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runShoot } from './lib/shootRun.mjs';
import { fileSignature, sigDiff } from './lib/png.mjs';
import { makeLedger, fingerprintOf } from './qa/ledger.mjs';

const SIG_W = 64, SIG_H = 40;
// mean-abs-diff (0..255). Tuned from measured behavior: the same-state animation-noise floor is
// ~0.0–0.5 (two captures of one state differ only by the wandering agent / pulsing reactor), while
// the SMALLEST real difference between two distinct centred modals is ~2.0 and structural breaks
// (floor↔modal, full-bleed↔centred, a panel that didn't open) are 10–18. 1.5 sits above the noise
// ceiling with margin yet below the smallest real change — biased toward sensitivity (a false flag
// just makes the vision model re-look; a missed regression is the real cost).
const THRESHOLD = Number(process.env.SKYNET_GOLDEN_THRESHOLD || 1.5);
const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), 'goldens.json');
const PORT = process.env.SKYNET_GOLDEN_PORT || '8935';
const CDP_PORT = Number(process.env.SKYNET_GOLDEN_CDP || 9335);
const OUT = process.env.SKYNET_GOLDEN_DIR || join(process.cwd(), '.uigolden');
const BLESS = process.argv.includes('--bless');

// ── Dismissed/known-frame gate ──────────────────────────────────────────────
// A frame can legitimately diff forever without being a regression: `sys-rewind` is the one
// modal that doesn't full-bleed over the always-animating CRT floor, so its signature wanders
// with the animation. That noise was already TRIAGED and DISMISSED in the QA ledger (finding
// 01c40465, status "dismissed"). Re-flagging it pins the Green Guardian dashboard row RED with
// 0 open findings — the dashboard would LIE, violating the project's truthful-telemetry law.
//
// So we ask the ONE dedup/known authority (scripts/qa/ledger.mjs) which fingerprints are
// suppressed (dismissed or known), and treat a frame whose Guardian fingerprint is on that
// baseline as REVIEW-CLEAN. The fingerprint we compute here is IDENTICAL to the one the Green
// Guardian derives for a golden frame (guardianFingerprint → fingerprintOf with the Green
// Guardian crew + checkId 'golden' + subject 'frame/<name>'), so a frame the Guardian already
// filed-and-dismissed matches exactly. We DO NOT re-implement fingerprint matching — we reuse
// the ledger's suppressedFingerprints() over its real on-disk findings + KNOWN_ISSUES.md.
//
// Narrow by design: this ONLY excuses a frame whose CURRENT fingerprint is already dismissed.
// A genuinely new regression — a new frame (different subject → different fingerprint), or any
// frame that isn't on the dismissed baseline — is untouched: it still flags and still exits 3,
// so the Guardian files it through the ledger exactly as today. Fail-open: if the ledger can't
// be read, nothing is suppressed and behavior is identical to before this gate existed.
const GUARDIAN_CREW = 'Green Guardian';       // must match scripts/qa/guardian.mjs CREW
const GOLDEN_CHECK_ID = 'golden';             // must match GUARDIAN_STEPS[golden].id
export function goldenFrameFingerprint(name) {
  return fingerprintOf({ crew: GUARDIAN_CREW, checkId: GOLDEN_CHECK_ID, subject: 'frame/' + name });
}

// Build a ledger over the real qa/ dir (same io shape as ledger.mjs's own CLI) and return the
// Set of suppressed (dismissed|known) fingerprints. Fail-open to an empty Set.
export function dismissedFingerprints(options = {}) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');   // scripts/ -> repo root
    // Guardian executes this gate from an immutable pinned worktree, while ignored operational
    // findings live in the integration checkout. Accept explicit paths from that composition root;
    // a standalone golden run keeps using its own checkout. Missing/unreadable paths still fail
    // open to no suppression, so a detector can never become green because evidence vanished.
    const findingsDir = options.findingsDir || process.env.STARNET_QA_FINDINGS_DIR || join(root, 'qa', 'findings');
    const knownFile = options.knownFile || process.env.STARNET_QA_KNOWN_FILE || join(root, 'qa', 'KNOWN_ISSUES.md');
    const io = {
      listFindings() {
        let names;
        try { names = readdirSync(findingsDir); } catch (_) { return []; }
        const out = [];
        for (const n of names) {
          if (!n.endsWith('.json')) continue;
          try { out.push(JSON.parse(readFileSync(join(findingsDir, n), 'utf8'))); } catch (_) { /* skip corrupt; fail-open */ }
        }
        return out;
      },
      knownFingerprints() {
        try {
          const txt = readFileSync(knownFile, 'utf8');
          const set = new Set();
          const re = /fingerprint[:=]\s*`?([0-9a-fA-F]{6,})`?/g;
          let m;
          while ((m = re.exec(txt))) set.add(m[1].toLowerCase());
          return set;
        } catch (_) { return new Set(); }
      }
    };
    return makeLedger({ io })._internals.suppressedFingerprints();
  } catch (_) {
    return new Set();   // fail-open: no ledger access -> suppress nothing (pre-gate behavior)
  }
}

async function captureSignatures() {
  const code = await runShoot({ port: PORT, cdpPort: CDP_PORT, outDir: OUT, only: null, keep: false });
  if (code !== 0) throw new Error('capture failed (shoot exit ' + code + ') — fix `npm run shoot` first');
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const sigs = {};
  for (const s of manifest.states) {
    const p = join(OUT, s.name + '.png');
    if (existsSync(p)) sigs[s.name] = Array.from(fileSignature(p, SIG_W, SIG_H));
  }
  return sigs;
}

// ── Pure classifier (testable, no disk / no capture) ────────────────────────
// Given this run's signatures, the blessed baseline, the threshold, and the suppressed-
// fingerprint Set, decide which frames are FLAGGED (real regressions → exit 3) vs EXCUSED
// (diffed but their fingerprint is on the dismissed/known baseline → review-clean, gate stays
// green). A frame is excused ONLY when it changed AND its Guardian fingerprint is suppressed —
// so a new frame / different frame / bigger diff on a NON-dismissed frame still flags. `frameOf`
// maps a frame name to its evidence path (so the pure core stays disk-free). Deterministic:
// iterates baseline+run keys in insertion order, no ambient state.
export function classifyFrames({ sigs, golden, thr, suppressed, frameOf, onLog } = {}) {
  sigs = sigs || {};
  const states = (golden && golden.states) || {};
  const supp = suppressed instanceof Set ? suppressed : new Set(suppressed || []);
  const path = typeof frameOf === 'function' ? frameOf : (n) => n;
  const log = typeof onLog === 'function' ? onLog : () => {};
  const flagged = [];
  const excused = [];
  for (const name of Object.keys(sigs)) {
    const g = states[name];
    const fp = goldenFrameFingerprint(name);
    if (!g) {
      if (supp.has(fp)) { log(`  review-clean ${name.padEnd(16)} NEW but fingerprint ${fp} matches a dismissed/known finding — accepted`); excused.push({ name, fingerprint: fp, reason: 'new state — dismissed/known' }); continue; }
      log(`  NEW      ${name.padEnd(16)} (no golden)`); flagged.push({ name, diff: null, reason: 'new state (no golden)', frame: path(name) }); continue;
    }
    const d = sigDiff(Uint8Array.from(sigs[name]), Uint8Array.from(g));
    const changed = d > thr;
    if (changed && supp.has(fp)) {
      // Known-noisy frame: its current diff maps to a dismissed/known finding. Review-clean —
      // loud about WHY (never a silent pass), kept OUT of `flagged` so the gate stays green.
      log(`  review-clean ${name.padEnd(16)} diff=${d.toFixed(2)} (thr ${thr}) — matches dismissed finding ${fp}, known animation noise; accepted`);
      excused.push({ name, diff: +d.toFixed(2), fingerprint: fp, reason: 'diff matches dismissed/known finding ' + fp });
      continue;
    }
    log(`  ${changed ? 'CHANGED' : 'ok     '} ${name.padEnd(16)} diff=${d.toFixed(2)} (thr ${thr})`);
    if (changed) flagged.push({ name, diff: +d.toFixed(2), frame: path(name) });
  }
  // A frame in the baseline but absent this run is a real gap (never excused — no signature to fingerprint against a live diff).
  for (const name of Object.keys(states)) if (!sigs[name]) flagged.push({ name, diff: null, reason: 'missing this run' });
  return { flagged, excused };
}

async function main() {
  const sigs = await captureSignatures();

  if (BLESS) {
    // Stamp WHERE the baseline was blessed, not just when. A golden signature is a rendering of
    // this UI by one browser on one OS; a different box renders the same source differently, and
    // without provenance the diff below cannot tell "the UI regressed" from "you are not the
    // machine that blessed this". blessedOn is additive — an older baseline simply has none.
    writeFileSync(GOLDENS, JSON.stringify({
      w: SIG_W, h: SIG_H, threshold: THRESHOLD, blessedAt: new Date().toISOString(),
      blessedOn: { platform: process.platform, arch: process.arch, node: process.version },
      states: sigs
    }));
    console.log(`\nblessed ${Object.keys(sigs).length} golden signatures (thr ${THRESHOLD}) on ${process.platform}/${process.arch} → ${GOLDENS}`);
    process.exit(0);
  }

  if (!existsSync(GOLDENS)) { console.error('no baseline — run `npm run golden:bless` first'); process.exit(2); }
  const golden = JSON.parse(readFileSync(GOLDENS, 'utf8'));
  const thr = golden.threshold || THRESHOLD;
  const suppressed = dismissedFingerprints();   // dismissed|known fingerprints from the QA ledger
  console.log('');
  const { flagged, excused } = classifyFrames({
    sigs, golden, thr, suppressed,
    frameOf: (name) => join(OUT, name + '.png'),
    onLog: (line) => console.log(line),
  });

  writeFileSync(join(OUT, 'golden-report.json'), JSON.stringify({ threshold: thr, flaggedCount: flagged.length, flagged, excusedCount: excused.length, excused }, null, 2));
  if (excused.length) {
    console.log(`\n${excused.length} frame(s) diffed but matched a dismissed/known finding — review-clean, NOT a regression:`);
    excused.forEach((f) => console.log(`  ${f.name}  (${f.reason})`));
  }
  if (flagged.length) {
    console.log(`\n${flagged.length} frame(s) CHANGED beyond animation noise — the vision model should read ONLY these:`);
    flagged.forEach((f) => console.log(`  ${f.frame || f.name}  ${f.reason || 'diff=' + f.diff}`));
    /* NAME THE OTHER EXPLANATION. A pixel baseline is machine-bound, so a foreign box flags every
       frame and the line above then reads as a regression it cannot actually prove. Two signals
       separate the cases, and both are stated rather than guessed at: whether the blessing platform
       differs from this one, and whether EVERY frame moved — a real regression touches the surfaces
       it broke, a rendering difference touches all of them. The gate is NOT softened: this still
       exits 3 and still demands a human verdict. It just stops asserting the wrong cause.
       (Measured while porting the gates to Windows: a baseline blessed on another box flagged 16 of
       16 frames, and pristine trunk reproduced the same diffs to within 0.03 — so nothing had
       regressed at all.) */
    const here = process.platform + '/' + process.arch;
    const there = golden.blessedOn ? golden.blessedOn.platform + '/' + golden.blessedOn.arch : null;
    const allMoved = flagged.length === Object.keys(golden.states || {}).length;
    if (there && there !== here) {
      console.log(`\n  NOTE: this baseline was blessed on ${there}; you are on ${here}. Cross-platform`);
      console.log('        pixel drift is expected and is NOT evidence of a regression.');
    } else if (!there) {
      console.log(`\n  NOTE: this baseline carries no blessedOn stamp, so the machine that produced it is`);
      console.log(`        unknown. If it was not this one (${here}), some drift is expected.`);
    }
    if (allMoved) {
      console.log('\n  NOTE: EVERY baseline frame moved. That pattern points at the rendering environment');
      console.log('        rather than a code change — a real regression rarely touches all of them.');
    }
    if ((there && there !== here) || !there || allMoved) {
      console.log('\n  To tell them apart: re-run this gate on a pristine trunk checkout. Identical diffs');
      console.log('        mean the environment, not your change. `npm run golden:bless` re-baselines here.');
    }
    process.exit(3);
  }
  console.log('\nGOLDEN PASS — no visual regressions (every frame within the animation-noise threshold' + (excused.length ? `; ${excused.length} known-noisy frame(s) excused as dismissed` : '') + ')');
  process.exit(0);
}

// Only run the live capture-and-diff when invoked as a script (`node scripts/golden.mjs`).
// Importing this module (e.g. from test/golden.test.js) must NOT boot a sidecar — it just
// pulls in the pure classifier + fingerprint helpers. Mirrors ledger.mjs/guardian.mjs.
const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();
if (INVOKED_DIRECTLY) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
