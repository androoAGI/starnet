'use strict';
/* node test/test-list-completeness.test.js — no test file sits outside a gate, and no list points at nothing.

   THE HOLE THIS CLOSES (gate-seams, 2026-10-27): the gates run only what test/fast.list and test/http.list name.
   Nineteen *.test.js files under test/ (and five under dev/) sat on neither list, so they never ran: written,
   committed, then free to rot. Among them: the only tests of the skill registry, metrics and package format, two
   provider-rotation production-wiring proofs (credrotate.e2e, summarize-failover.e2e), the full-request consent
   proof — and kepler-showcase, which has been red since 2026-09-16 without anyone seeing it.

   Laws:
     C1 every *.test.js / *.test.mjs / *.test.cjs under test/ and dev/ is a step of test/fast.list or test/http.list
        (the two mandatory gates; a campaign list such as customer-journeys does not count on its own). A
        compatibility entry point whose only code is require() of other files is covered when what it requires is.
        UNGATED names the files that may not run, each with the reason, and must stay short;
     C2 every entry of every list under test/ is an existing file;
     C3 the runner's side lists (slow, flaky) and the campaign lists only name steps a mandatory gate runs, so a
        quarantine or a slow bound can never be the only place a step is mentioned;
     C4 no list names the same step twice. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['test', 'dev'];
const GATES = ['test/fast.list', 'test/http.list'];
const SIDE_LISTS = ['test/slow.list', 'test/flaky.list', 'test/customer-journeys.list', 'test/hermes-strengths.list'];

/* A file here is a known, explained exception — not a place to park a test that is inconvenient. Fix it and gate it. */
const UNGATED = {
  'test/kepler-showcase.test.js':
    'RED since 45fd0b096 (2026-09-16, "synchronize station before seating integration"): in the Kepler Relay preset the ' +
    'fabrication room is walkable but no longer reachable from command. The preset (dev/kepler-showcase.cjs, shipped ' +
    'as frontend/app/kepler-showcase.js) or the test needs fixing; then gate it on test/fast.list.',
  'dev/industrial-textures/projection-effects-pixels.test.cjs':
    'A QA raster generator, not a regression step: every run rewrites docs/station-remaster/projection-effects/' +
    'state-pixels.png and pixel-checks.json in the working tree, and its canvas fallback is a path on one machine.'
};

const readList = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'));

function walk(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.isFile() && /\.test\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// The files a compatibility entry point requires, when require() lines are all it contains; otherwise null.
function shimTargets(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!code.length) return null;
  const targets = [];
  for (const line of code) {
    const m = /^require\((['"])(\.{1,2}\/[^'"]+)\1\);?$/.exec(line);
    if (!m) return null;
    targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2])));
  }
  return targets;
}

const lists = fs.readdirSync(path.join(ROOT, 'test')).filter(n => n.endsWith('.list')).map(n => 'test/' + n).sort();
for (const rel of GATES.concat(SIDE_LISTS)) A.ok(lists.includes(rel), rel + ' exists');
const unknown = lists.filter(rel => !GATES.includes(rel) && !SIDE_LISTS.includes(rel));
A.eq(unknown, [], 'every list under test/ is a gate or a side list this test knows (add a new list to GATES or SIDE_LISTS)');

const gated = new Set();
for (const rel of GATES) for (const step of readList(rel)) gated.add(step);
A.ok(gated.size > 1000, 'the gates enumerate their steps (' + gated.size + ')');

// C1
const tests = [].concat(...SCAN_DIRS.map(dir => walk(dir, []))).sort();
A.ok(tests.length > 1000, 'the scan finds the test files (' + tests.length + ')');
const outside = [];
let shims = 0;
for (const rel of tests) {
  if (gated.has(rel) || UNGATED[rel]) continue;
  const targets = shimTargets(rel);
  if (targets && targets.every(t => gated.has(t))) { shims++; continue; }
  outside.push(rel + (targets ? ' (an entry point requiring ' + targets.filter(t => !gated.has(t)).join(', ') + ', which no gate runs)' : ''));
}
A.eq(outside, [], 'C1: every test file is a step of test/fast.list or test/http.list');
A.ok(shims >= 1, 'C1: compatibility entry points are recognised (' + shims + ')');
const ungated = Object.keys(UNGATED);
A.ok(ungated.length <= 3, 'C1: the UNGATED exceptions stay few (' + ungated.length + ')');
for (const rel of ungated) {
  A.ok(fs.existsSync(path.join(ROOT, rel)), 'C1: UNGATED ' + rel + ' exists (drop the entry when the file goes)');
  A.ok(!gated.has(rel), 'C1: UNGATED ' + rel + ' is not on a gate (drop the entry once it is gated)');
  A.ok(String(UNGATED[rel]).length > 60, 'C1: UNGATED ' + rel + ' says why');
}

// C2 + C4
for (const rel of lists) {
  const steps = readList(rel);
  const missing = steps.filter(step => !fs.existsSync(path.join(ROOT, step)));
  A.eq(missing, [], 'C2: ' + rel + ' names only existing files');
  const dupes = steps.filter((step, i) => steps.indexOf(step) !== i);
  A.eq(dupes, [], 'C4: ' + rel + ' names no step twice');
}

// C3
for (const rel of SIDE_LISTS) {
  const strays = readList(rel).filter(step => !gated.has(step));
  A.eq(strays, [], 'C3: every step of ' + rel + ' is run by a mandatory gate');
}
A.ok(readList('test/flaky.list').length <= 5, 'C3: the flaky quarantine stays short — fix a flake rather than listing it');

A.report('test-list-completeness.test');
