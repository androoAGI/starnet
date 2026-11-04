/* node test/lint-determinism.js — fails if backend logic touches ambient time/randomness.
   Scans shared/ + sidecar/ (the dependency-injected backend) for Math.random / Date.now /
   performance.now / new Date() — these must arrive via the injected clock + rng so a run is
   reproducible (DoD #5). The browser/app shim (frontend/app/) is NOT scanned yet; it comes
   into compliance when harness.js/world.js are rewired onto the injected clock at M2/M3. */
'use strict';
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const ROOTS = ['shared', 'sidecar'];
// The Node host (sidecar/index.js) is the ambient COMPOSITION ROOT: it is the one place that
// creates the real clock/fetch/fs and INJECTS them into the otherwise-pure backend. The rule
// bans ambient time/randomness in backend LOGIC, not at the injection boundary — so the host is
// exempt by design (same intent as the not-yet-scanned frontend/app shim noted above).
const EXCLUDE = new Set(['sidecar/index.js'].map(p => path.normalize(p)));

let fail = 0;
const err = m => { fail++; console.log('FAIL: ' + m); };

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // skip agent-generated runtime scratch (sidecar/workspaces/**) and deps — they are not backend logic.
    // An agent can legitimately write nondeterministic code (e.g. a game using Math.random) into its own
    // workspace; that is output, not the DI'd harness, and must not fail the determinism gate.
    if (e.isDirectory()) { if (e.name === 'workspaces' || e.name === 'node_modules') continue; walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [];
for (const r of ROOTS) walk(path.join(base, r), files);
// frontend/app/pipeline.js is the ONE frontend module the sidecar require()s (the shared belt-graph
// routing compiler), so its determinism is backend-load-bearing — scan it even though the app shim isn't.
files.push(path.join(base, 'frontend', 'app', 'pipeline.js'));
// conveyor.js + ghostline.js promise injected-clock determinism in their contracts (replayable
// transport sim; the ghost projection's route-truth tests depend on it) — hold them to it here.
files.push(path.join(base, 'frontend', 'app', 'conveyor.js'));
files.push(path.join(base, 'frontend', 'app', 'ghostline.js'));
// turnkinds.js is required by the sidecar's transcript store and run writer (turnId grammar, row kinds, quote stamps):
// its mints take an injected rng and its time conversions an injected now
files.push(path.join(base, 'frontend', 'app', 'turnkinds.js'));
// turnmerge.js is the page's turn-id side (mint, send, bind) the tests load as a module: a mint takes an injected rng,
// a send an injected now
files.push(path.join(base, 'frontend', 'app', 'turnmerge.js'));
// The shared page/station fitter and capability decisions are pure; host reads stay injected outside it.
files.push(path.join(base, 'frontend', 'app', 'historyfit.js'));
// historyref.js is the saved-history format (pack, explode, expand, digest) the sidecar's merge engines will run through too:
// pure, no clock or randomness, and the station read is injected
files.push(path.join(base, 'frontend', 'app', 'historyref.js'));
// usertext.js is the one flattener of a message's text parts, required by the sidecar (transcript store, run directive
// capture, learning, observer): pure, no clock
files.push(path.join(base, 'frontend', 'app', 'usertext.js'));

const banned = [/\bMath\.random\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /\bnew\s+Date\s*\(\s*\)/];
const labels = ['Math.random', 'Date.now', 'performance.now', 'new Date()'];

// strip comments before scanning: blank out /* */ blocks (keep newlines for line numbers),
// then drop // line comments per line (preserving :// in URLs like https://...).
function decomment(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

for (const f of files) {
  if (EXCLUDE.has(path.relative(base, f))) continue;   // ambient composition root — exempt by design
  const src = decomment(fs.readFileSync(f, 'utf8'));
  src.split('\n').forEach((ln, i) => {
    const code = ln.replace(/(^|[^:])\/\/.*$/, '$1');
    banned.forEach((re, bi) => {
      if (re.test(code)) err(labels[bi] + ' at ' + path.relative(base, f) + ':' + (i + 1) + ' — inject clock/rng instead');
    });
  });
}

console.log('lint-determinism: scanned ' + files.length + ' file(s); ' + (fail ? (fail + ' problem(s)') : 'OK'));
process.exit(fail ? 1 : 0);
