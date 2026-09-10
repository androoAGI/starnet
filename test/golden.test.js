/* Golden change detection: a dismissed panel name cannot approve different pixels. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyFrames, goldenFrameFingerprint, dismissedFingerprints } = require('../scripts/golden.mjs');
const { fingerprintOf } = require('../scripts/qa/ledger.mjs');

// Build a signature array of a constant byte value, length SIG_W*SIG_H (64*40) so sigDiff is
// well-defined. Two constant sigs differ by |a-b| (mean-abs-diff), so we can dial the diff.
const SIG_LEN = 64 * 40;
const sig = (v) => Array.from({ length: SIG_LEN }, () => v);

// ---- A. the frame fingerprint IS the ledger's Green-Guardian golden fingerprint (one key) ----
{
  const fp = goldenFrameFingerprint('sys-rewind');
  A.eq(fp, fingerprintOf({ crew: 'Green Guardian', checkId: 'golden', subject: 'frame/sys-rewind' }),
    'goldenFrameFingerprint == the ledger fingerprint the Guardian derives for that frame (one dedup key)');
  A.eq(fp, '01c40465', 'sys-rewind maps to the real dismissed finding fingerprint 01c40465 (the actual ledger id)');
}

// ---- B. A historical panel dismissal does not bless current pixel changes ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'ingame': sig(0) } };
  const sigs = { 'sys-rewind': sig(10), 'ingame': sig(0) };       // sys-rewind diffs by 10 (>thr), ingame clean
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind')]);   // dismissed baseline
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 1, 'changed pixels require review despite a panel-name dismissal');
  A.eq(excused.length, 0, 'no automatic pixel approval from a name');
}

// ---- C. NEGATIVE PATH #1: same frame, diff, but fingerprint NOT suppressed → STILL flagged ----
{
  const golden = { states: { 'sys-rewind': sig(0) } };
  const sigs = { 'sys-rewind': sig(10) };
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed: new Set() });  // nothing dismissed
  A.eq(flagged.length, 1, 'with NO dismissed baseline, a real diff still flags (regression survives)');
  A.eq(excused.length, 0, 'nothing excused when the fingerprint is not on the baseline');
  A.eq(flagged[0].name, 'sys-rewind', 'the flagged frame is named');
}

// ---- D. NEGATIVE PATH #2: a DIFFERENT frame diffs — a suppressed sys-rewind does NOT excuse it ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'crew-roster': sig(0) } };
  const sigs = { 'sys-rewind': sig(10), 'crew-roster': sig(10) };   // BOTH diff
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind')]); // only sys-rewind is dismissed
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 2, 'both changed panels require review');
  A.eq(excused.length, 0, 'neither frame is excused by name');
}

// ---- E. NEGATIVE PATH #3: a brand-NEW frame (no baseline) flags even if some OTHER fp is dismissed ----
{
  const golden = { states: {} };                                   // no baseline at all
  const sigs = { 'brand-new-panel': sig(5) };
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind')]); // sys-rewind dismissed, unrelated
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 1, 'a new frame (new subject → new fingerprint) is NOT excused by an unrelated dismissal');
  A.eq(excused.length, 0, 'nothing excused');
  A.ok(/new state/.test(flagged[0].reason), 'the new frame is flagged as a new state');
}

// ---- F. NEGATIVE PATH #4: a frame in the baseline but MISSING this run → flagged (never excused) ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'gone': sig(0) } };
  const sigs = { 'sys-rewind': sig(0) };                            // 'gone' absent this run
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind'), goldenFrameFingerprint('gone')]);
  const { flagged } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 1, 'a missing frame flags even if its fingerprint is dismissed (no live signature to trust)');
  A.eq(flagged[0].name, 'gone', 'the missing frame is named');
  A.ok(/missing this run/.test(flagged[0].reason), 'flagged as missing this run');
}

// A fully black-to-white frame, and a new frame with the same name, cannot be hidden.
for (const states of [{ 'settings': sig(0) }, {}]) {
  const result = classifyFrames({ sigs: { settings: sig(255) }, golden: { states }, thr: 1.5,
    suppressed: new Set([goldenFrameFingerprint('settings')]) });
  A.eq(result.flagged.length, 1, 'total image replacement or missing baseline stays red');
  A.eq(result.excused.length, 0, 'old dismissal never certifies a replacement');
}

// ---- G. a clean run (no diffs) → nothing flagged, nothing excused ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'ingame': sig(0) } };
  const sigs = { 'sys-rewind': sig(0), 'ingame': sig(0) };
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed: new Set() });
  A.eq(flagged.length, 0, 'no diffs → nothing flagged');
  A.eq(excused.length, 0, 'no diffs → nothing excused');
}

// A pinned checkout must be able to read Guardian's explicitly supplied operational ledger.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-golden-ledger-'));
  const findingsDir = path.join(dir, 'findings');
  const knownFile = path.join(dir, 'KNOWN_ISSUES.md');
  fs.mkdirSync(findingsDir);
  fs.writeFileSync(path.join(findingsDir, 'dismissed.json'), JSON.stringify({
    id: 'dismissed', fingerprint: goldenFrameFingerprint('sys-rewind'), status: 'dismissed'
  }));
  fs.writeFileSync(knownFile, '# none\n');
  try {
    const suppressed = dismissedFingerprints({ findingsDir, knownFile });
    A.ok(suppressed.has(goldenFrameFingerprint('sys-rewind')), 'explicit operational ledger path supplies dismissed fingerprints to a pinned checkout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Source lock the composition root: the immutable pin cannot infer ignored operational files.
{
  const guardian = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qa', 'guardian.mjs'), 'utf8');
  A.ok(/STARNET_QA_FINDINGS_DIR/.test(guardian) && /STARNET_QA_KNOWN_FILE/.test(guardian),
    'Guardian passes operational findings + known-issues paths into the pinned golden gate');
}

// Golden frames describe stable panels, never whichever transient toast happened to overlap capture.
{
  const shoot = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'shootRun.mjs'), 'utf8');
  A.ok(/toast-stack/.test(shoot) && /remove\(\)/.test(shoot), 'shared screenshot runner clears transient toasts before each frame');
  A.ok(/World\.stop/.test(shoot) && /world-frozen/.test(shoot), 'shared screenshot runner freezes the idle world before translucent panel captures');
  A.ok(/classList\.add\('no-flicker'\)/.test(shoot), 'shared screenshot runner disables the global seven-second flicker cycle');
  A.ok(/rmSync\(PROFILE,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/.test(shoot),
    'shared screenshot runner clears its reused Chrome profile before every sweep');
  A.ok(/document\.fonts[\s\S]{0,80}document\.fonts\.ready/.test(shoot),
    'shared screenshot runner waits for the local house font before treating panel geometry as final');
  A.ok(/querySelectorAll\('\.loading'\)[\s\S]{0,500}getBoundingClientRect\(\)[\s\S]{0,500}quiet >= 3/.test(shoot),
    'shared screenshot runner requires visible loaders to clear and three stable panel-rectangle samples');
  A.ok(/layout-timeout[\s\S]{0,700}const bad[\s\S]{0,180}layout-\(\?:timeout\|settle-error\)/.test(shoot),
    'a panel that never settles fails the capture gate instead of blessing transient layout');
}

// The navigation-condense change merged ROUTINES + LOOPS behind the AUTOMATION dock entry. The
// state key and driver both follow that live navigation contract so the current AUTOMATION
// baseline cannot be orphaned behind the retired ROUTINES name.
{
  const states = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'states.mjs'), 'utf8');
  A.ok(/name: 'work-automation'[\s\S]{0,160}data-term="automation"[\s\S]{0,80}'AUTOMATION'/.test(states),
    'work-automation golden frame opens the merged AUTOMATION dock entry');
  A.ok(!/name: 'work-routines'/.test(states),
    'golden states retire the obsolete work-routines baseline key');
  A.ok(/openStableAgents[\s\S]{0,1400}SPRITES\.ensureSkin\(DATA\.DEFAULT_SKIN\)/.test(states) &&
       /name: 'crew-agents'[\s\S]{0,100}drive: openStableAgents/.test(states),
    'crew-agents waits for the seeded hero portrait instead of capturing its loading mannequin');
  A.ok(/openStableSettings[\s\S]{0,2600}Harness\.probeProvider[\s\S]{0,1800}provider-health-settled/.test(states) &&
       /name: 'sys-settings'[\s\S]{0,100}drive: openStableSettings/.test(states),
    'sys-settings settles a deterministic screenshot-only provider probe before capture');
}

// An empty notification store renders no list. The capture driver must create its fixture
// before opening the panel, and a missing list must fail rather than bless an empty frame.
{
  const vm = require('node:vm');
  const { openStableNotifs } = require('../scripts/lib/states.mjs');
  function captureNotifs(initial, broken = false) {
    let count = initial, list = null;
    const context = {
      StationUI: { notify() { count++; } },
      KeyboardEvent: function () {},
      document: {
        body: { classList: { remove() {} } },
        getElementById() { return null; }, querySelectorAll() { return []; }, dispatchEvent() {},
        querySelector(sel) {
          if (sel === '[data-term="notifs"]') return { click() { if (count && !broken) list = { innerHTML: '' }; } };
          if (sel === '.nf-list') return list;
          return null;
        }
      }
    };
    return { result: vm.runInNewContext(openStableNotifs, context), list };
  }
  const empty = captureNotifs(0), populated = captureNotifs(5);
  A.eq(empty.result, 'opened:NOTIFS', 'fresh empty notification store reaches the fixture list');
  A.eq(empty.list && empty.list.innerHTML, populated.list && populated.list.innerHTML,
    'empty and populated notification stores capture identical fixture rows');
  A.ok(!!empty.list && /Station layout saved/.test(empty.list.innerHTML), 'notification fixture is actually rendered');
  A.eq(captureNotifs(0, true).result, 'DRIVE_ERR:notification-list-missing',
    'broken notification renderer fails capture instead of producing a false green');
}

A.report('golden.test');
