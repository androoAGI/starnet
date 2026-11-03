/* node test/station-record-readers.test.js — EVERY READER READS THE STATION RECORD: no new lifecycle parser or file check.

   Whether a workspace holds a station, was erased or was reset is ONE fact, the station record, and
   sidecar/station-record.js is the one module that reads and writes it (B3: gh#123, gh#101, gh#65, bug 5451970e). Before
   it the question had five answers that disagreed: workspace-lineage's STATE_EVIDENCE allowlist (the onboarding gate,
   one rung per incident), hasStationState (the same regex, for the quest refresh), two more parsers of .fresh-start.json
   (workspace-recovery, savestore) and the terminal's own save/roster existence probe (bin/starnet.js). A fresh install
   was trapped in Recovery Mode by whichever background file matched the regex next, a torn marker refused every first
   save, and the terminal booted the station an ERASE had set aside. This source ratchet keeps the answer single, over
   sidecar/, bin/ and src-tauri/src/:
     1. the lifecycle file names ('.station.json', '.fresh-start.json') and the frozen fallback's identifiers
        (STATE_EVIDENCE, STATION_BOOKKEEPING, meaningfulEntries, hasStationState) appear only in sidecar/station-record.js,
        plus '.fresh-start.json' in src-tauri/src/fresh_start.rs, the one native writer of the legacy marker;
     2. no exists / existsSync / statSync / accessSync / lstatSync call names agent.save.json or agent.roster.json
        outside station-record.js: P1's hard proof is the module's, so no reader answers from a file probe of its own;
     3. and the readers really ask the module (a reader that stopped asking would pass 1 and 2 vacuously);
     4. and nothing writes hard proof before a station is founded: the roster file has ONE write path, saveAgentRoster, and it
        asks the live record before it writes (WAKE pushes its crew before its first save lands, so the roster was the one
        hard-proof file a WAKE cut short, or a window from before a reset, could leave behind).
   Per-file BASELINE, failopen-ratchet style: counts may only go DOWN; every row equals the on-disk count (no slack to
   spend) and a row for a file that no longer has the name fails as stale. Comments count too: deleting a mention only
   lowers a count. A Rust assert! line is a test's claim about an outcome, not a reader, and is not a probe. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { sidecarSourceFiles, sidecarFunctionSource } = require('./helpers/source.js');

const ROOT = path.resolve(__dirname, '..');
const MODULE = 'sidecar/station-record.js';
const NATIVE_WRITER = 'src-tauri/src/fresh_start.rs';

const NAMES = {
  '.station.json': /\.station\.json/g,
  '.fresh-start.json': /\.fresh-start\.json/g,
  STATE_EVIDENCE: /\bSTATE_EVIDENCE\b/g,
  STATION_BOOKKEEPING: /\bSTATION_BOOKKEEPING\b/g,
  meaningfulEntries: /\bmeaningfulEntries\b/g,
  hasStationState: /\bhasStationState\b/g
};
// the one place each name may live without a count: the module itself, and the native door's own marker name
const OWNER = { [MODULE]: Object.keys(NAMES), [NATIVE_WRITER]: ['.fresh-start.json'] };

/* AUDITED BASELINE ('<file>': { name: count }). Every file and name not listed must be CLEAN. Lower a row in the same commit
   that lowers its count; never raise one — route the reader through station-record.js instead. */
const BASELINE = {};   // none, ever again: START FRESH's file-by-file drain was the last of the fallback outside the module
const PROBE_BASELINE = {};   // existence probes of a save or roster name outside the module: none, ever again

const PROBE_CALL = /\b(?:exists|existsSync|statSync|accessSync|lstatSync)\s*\(/;
const STATION_FILE = /agent\.(?:save|roster)\.json/;
const RUST_ASSERT = /^\s*(?:debug_)?assert(?:_eq|_ne)?!\s*\(/;
function countName(text, re) { return (String(text).match(new RegExp(re.source, 'g')) || []).length; }
function countProbes(text, rust) {
  return String(text).split(/\r?\n/).filter(line => PROBE_CALL.test(line) && STATION_FILE.test(line) && !(rust && RUST_ASSERT.test(line))).length;
}

// ---- the detectors against fixtures (a ratchet whose pattern is wrong locks the wrong thing) ----
A.eq(countName("const RESET_RECEIPT = '.fresh-start.json';", NAMES['.fresh-start.json']), 1, 'detects the marker name in a string');
A.eq(countName('// read <WORKSPACES>/.station.json first', NAMES['.station.json']), 1, 'detects the record name in a comment');
A.eq(countName('if (!hasStationState({ fs })) return;', NAMES.hasStationState) + countName('const STATE_EVIDENCE_X = 1;', NAMES.STATE_EVIDENCE), 1, 'identifiers match as whole words only');
A.eq(countProbes("function hasStation(ws) { return exists(path.join(ws, 'agent.save.json')) || exists(path.join(ws, 'agent.roster.json')); }"), 1, 'detects the terminal\'s old save/roster probe');
A.eq(countProbes("if (fs.existsSync(path.join(root, 'agent.roster.json.bak'))) x();"), 1, 'detects existsSync on a roster name');
A.eq(countProbes("        if !workspaces.join(\"agent.save.json\").exists() { return; }", true), 1, 'detects a Rust .exists() probe');
A.eq(countProbes("        assert!(!workspaces.join(\"agent.save.json\").exists());", true), 0, 'a Rust assert! is a test claim, not a reader');
A.eq(countProbes("fs.writeFileSync(path.join(ws, 'agent.save.json'), body, { flag: 'wx' });"), 0, 'a write is not an existence probe');

// ---- the scanned tree: sidecar/ (through the source helper), bin/, src-tauri/src/ ----
function walk(dir, out, exts) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(abs, out, exts); }
    else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}
const files = sidecarSourceFiles().map(f => ({ rel: f.rel, text: f.text }))
  .concat(walk(path.join(ROOT, 'bin'), [], ['.js', '.mjs', '.cjs']).concat(walk(path.join(ROOT, 'src-tauri', 'src'), [], ['.rs']))
    .map(rel => ({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') })));
A.ok(files.some(f => f.rel === 'sidecar/index.js') && files.some(f => f.rel === 'bin/starnet.js') && files.some(f => f.rel === 'src-tauri/src/main.rs'), 'the scan covers the sidecar, the terminal and the desktop shell (' + files.length + ' files)');
A.ok(files.some(f => f.rel === MODULE), 'the station record module is present');

// ---- 1. names ----
const seen = {};
let over = 0;
for (const f of files) {
  for (const name of Object.keys(NAMES)) {
    if ((OWNER[f.rel] || []).includes(name)) continue;
    const n = countName(f.text, NAMES[name]);
    if (!n) continue;
    (seen[f.rel] = seen[f.rel] || {})[name] = n;
    const cap = (BASELINE[f.rel] || {})[name] || 0;
    if (n > cap) { over++; A.ok(false, f.rel + ' names ' + name + ' ' + n + ' time(s), baseline ' + cap + ' — ask sidecar/station-record.js (read(), its predicates, LIFECYCLE_FILES) instead of naming the lifecycle or its fallback'); }
  }
}
A.eq(over, 0, 'no file outside the station record module names a lifecycle file or the frozen fallback beyond its baseline');
let slack = 0;
for (const rel of Object.keys(BASELINE)) {
  for (const name of Object.keys(BASELINE[rel])) {
    const actual = (seen[rel] || {})[name] || 0;
    if (actual !== BASELINE[rel][name]) { slack++; A.ok(false, rel + ' ' + name + ': baseline ' + BASELINE[rel][name] + ' but ' + actual + ' on disk — set the row to the real count (ratchet DOWN in the same commit)'); }
  }
}
A.eq(slack, 0, 'every name baseline row equals the on-disk count (no slack, no stale rows)');

// ---- 2. existence probes of a save or roster name ----
let probesOver = 0;
const probeSeen = {};
for (const f of files) {
  if (f.rel === MODULE) continue;
  const n = countProbes(f.text, f.rel.endsWith('.rs'));
  if (!n) continue;
  probeSeen[f.rel] = n;
  if (n > (PROBE_BASELINE[f.rel] || 0)) { probesOver++; A.ok(false, f.rel + ' probes a save or roster file for existence ' + n + ' time(s) — P1 lives in station-record.js: use read(ws).station() / holdsHardProof()'); }
}
A.eq(probesOver, 0, 'no reader outside the station record module probes a save or roster file for existence');
for (const rel of Object.keys(PROBE_BASELINE)) A.eq(probeSeen[rel] || 0, PROBE_BASELINE[rel], 'probe baseline row is exact: ' + rel);

// ---- 3. the readers ask the module ----
const text = rel => (files.find(f => f.rel === rel) || { text: '' }).text;
const ASKS = /require\((?:'\.\/station-record\.js'|path\.join\(REPO, 'sidecar', 'station-record\.js'\))\)/;
for (const rel of ['sidecar/index.js', 'sidecar/workspace-lineage.js', 'sidecar/workspace-recovery.js', 'sidecar/savestore.js', 'sidecar/station-recovery.js', 'bin/starnet.js']) {
  A.ok(ASKS.test(text(rel)), rel + ' reads the station lifecycle through station-record.js');
}
// the terminal loads it on first use only: `starnet --version` runs on bin/ alone (test/cli-version.test.js)
A.eq(/^const [^\n]*require\([^\n]*station-record/m.test(text('bin/starnet.js')), false, 'bin/starnet.js never loads the record module at require time');

// ---- 4. nothing writes hard proof before a founding ----
{
  const writes = files.filter(f => f.rel.startsWith('sidecar/')).map(f => (f.text.match(/\bsaveResilient\(\s*AGENT_ROSTER_FILE\b/g) || []).length).reduce((a, b) => a + b, 0);
  A.eq(writes, 1, 'the roster file has one write path in the sidecar');
  const body = sidecarFunctionSource('saveAgentRoster') || '';
  const gate = body.indexOf('if (!stationLife.station())'), write = body.indexOf('saveResilient(AGENT_ROSTER_FILE');
  A.ok(gate > 0 && write > gate, 'and saveAgentRoster asks the live station record before it writes');
  A.ok(/onFounded:[^\n]*stationLife\.found\([^\n]*agentRosterHeld[^\n]*saveAgentRoster\(/.test(text('sidecar/index.js')), 'the founding save writes the crew held for it');
}

A.report('station-record-readers.test');
