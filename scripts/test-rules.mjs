#!/usr/bin/env node
/* The cheap "rules" tier of the test estate: seconds, not the 35-80 minute serial gates.

   The tier is GENERATED from test/fast.list on every run. There is no second hand-kept list (C15): a step is a rules
   step when its source, and the source of the test helpers it loads (two levels deep), does none of the things that
   make a test expensive or environment-bound:
     - require sidecar/index.js, or use child_process / spawn / exec / fork;
     - call listen( (it serves something);
     - use a sidecar fixture, desk-station, strict-upstream, findChrome / connectCDP, or helpers/ports.
   Comments are ignored. Declared slow steps (test/slow.list) and quarantined flaky steps are never in the tier.

   The tier is ADVISORY. It never replaces test:fast; it is what you run after every edit to get the cheap rule tests
   (failopen ratchet, determinism and emit lints, census tests, pure module tests) answered in seconds.

     node scripts/test-rules.mjs            run the tier (one process per step, via scripts/run-test-list.mjs)
     node scripts/test-rules.mjs --list     print the tier, one path per line
     node scripts/test-rules.mjs <text>...  run only the tier steps whose path contains <text>

   The runner is used as it is: it rejects unknown options, so the tier is handed to it as a temp list file, which is
   removed afterwards. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runList } from './run-test-list.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* name -> pattern, tried on comment-stripped text. A hit keeps the test out of the tier. */
export const MARKERS = {
  index: /\b(?:require|import)\b[^;\n]{0,120}\bsidecar\b[^;\n]{0,12}\bindex(?:\.js)?(?![\w-])/,
  childProcess: /child_process/,
  spawn: /\b(?:spawn|spawnSync|fork|execFile|execFileSync|execSync)\b/,
  listen: /\blisten\s*\(/,
  fixture: /\bSidecarFixture\b|sidecar-fixture|turn-http-fixture|\bbootSeededSidecar\b|fake-desktop-app|lib\/seed\.mjs/,
  desk: /desk-station/,
  strict: /strict-upstream/,
  chrome: /\bfindChrome\b|\bconnectCDP\b|--headless/,
  ports: /helpers\/ports|\ballocatePorts?\b/,
};

const TOKEN = /(\/\*[\s\S]*?\*\/|(?<=^|[\s;,({})])\/\/[^\n]*)|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

/* Remove comments, keeping string and template literals whole (a url's // is not a comment). Regex literals are not
   parsed; the scan is a heuristic and errs toward keeping text, which keeps a test OUT of the tier. */
export function stripComments(src) {
  return String(src).replace(TOKEN, (m, comment) => (comment ? ' ' : m));
}

/* The first marker a text hits, or null. */
export function firstMarker(text, omit) {
  const code = stripComments(text);
  for (const [name, re] of Object.entries(MARKERS)) {
    if (omit && omit.includes(name)) continue;
    if (re.test(code)) return name;
  }
  return null;
}

const SPEC = /(?:\brequire|\bimport)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)|\bfrom\s+(['"])([^'"\n]+)\3|\bimport\s+(['"])([^'"\n]+)\5/g;
export function relativeSpecifiers(text) {
  const out = [];
  const code = stripComments(text);
  let m;
  SPEC.lastIndex = 0;
  while ((m = SPEC.exec(code))) {
    const spec = m[2] || m[4] || m[6];
    if (spec && spec.startsWith('.')) out.push(spec);
  }
  return out;
}

const EXTS = ['', '.js', '.mjs', '.cjs', '/index.js'];
/* Find the file a relative specifier means, as a repo-relative path, using only the injected read(). */
export function resolveSpecifier(fromFile, spec, read) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const ext of EXTS) {
    const rel = base + ext;
    const text = read(rel);
    if (typeof text === 'string' && !/\/$/.test(rel)) return { rel, text };
  }
  return null;
}

/* Why a test is not a rules step: a marker in its own text or in a test helper it loads (up to `depth` levels).
   `memo` (optional) caches per-file scans across a whole selection: the same helpers are loaded by hundreds of tests. */
export function exclusion(file, text, read, omit, depth = 2, seen = new Set(), memo = null) {
  const m = memo || { marker: new Map(), specs: new Map(), resolved: new Map() };
  if (!m.marker.has(file)) m.marker.set(file, firstMarker(text, omit));
  const own = m.marker.get(file);
  if (own) return own;
  if (depth <= 0) return null;
  if (!m.specs.has(file)) m.specs.set(file, relativeSpecifiers(text));
  for (const spec of m.specs.get(file)) {
    if (!posix.normalize(posix.join(posix.dirname(file), spec)).startsWith('test/')) continue;   // product modules are not scanned
    const key = file + '|' + spec;
    if (!m.resolved.has(key)) m.resolved.set(key, resolveSpecifier(file, spec, read));
    const hit = m.resolved.get(key);
    if (!hit || seen.has(hit.rel) || !hit.rel.startsWith('test/')) continue;
    seen.add(hit.rel);
    const inner = exclusion(hit.rel, hit.text, read, omit, depth - 1, seen, m);
    if (inner) return inner + ' (via ' + hit.rel + ')';
  }
  return null;
}

const stepName = line => String(line).split('|')[0].trim();

/* The tier, in fast.list order. read(rel) returns a file's text or null. `omitMarkers` exists so a test can plant the
   defect "this marker is gone" and watch the exclusion fail. */
export function selectRulesTier({ fastList, read, slow, flaky, omitMarkers }) {
  const skip = new Set([...(slow || []), ...(flaky || [])].map(stepName));
  const tier = [], skipped = [], seenSteps = new Set();
  const memo = { marker: new Map(), specs: new Map(), resolved: new Map() };
  for (const raw of fastList || []) {
    const file = stepName(raw);
    if (!file || seenSteps.has(file)) continue;
    seenSteps.add(file);
    if (skip.has(file)) { skipped.push({ file, reason: 'declared slow or flaky' }); continue; }
    const text = read(file);
    if (typeof text !== 'string') { skipped.push({ file, reason: 'missing' }); continue; }
    const why = exclusion(file, text, read, omitMarkers, 2, new Set(), memo);
    if (why) skipped.push({ file, reason: why });
    else tier.push(file);
  }
  return { tier, skipped };
}

function listLines(rel, root) {
  const p = join(root, rel);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

/* The tier of a checked-out tree, read from disk. */
export function rulesTierOf(root = ROOT, reader = null) {
  const read = reader || (rel => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; });
  return selectRulesTier({
    fastList: listLines('test/fast.list', root), read,
    slow: listLines('test/slow.list', root), flaky: listLines('test/flaky.list', root),
  });
}

export async function main(argv, opts = {}) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  const log = opts.log || (line => console.log(line));
  const root = opts.cwd || ROOT;
  if (args.includes('--help') || args.includes('-h')) {
    log('usage: node scripts/test-rules.mjs [--list] [path substring filters...]');
    return 0;
  }
  const bad = args.find(a => a.startsWith('--') && a !== '--list');
  if (bad) { log('unknown option ' + bad + ' (usage: node scripts/test-rules.mjs [--list] [filters...])'); return 1; }
  const { tier } = rulesTierOf(root, opts.read || null);
  if (args.includes('--list')) { for (const f of tier) log(f); return 0; }
  const filters = args.filter(a => !a.startsWith('--'));
  const picked = filters.length ? tier.filter(f => filters.some(x => f.includes(x))) : tier;
  if (!picked.length) { log('test:rules: no rules step matches ' + filters.join(', ')); return 1; }
  const dir = mkdtempSync(join(opts.tmpRoot || tmpdir(), 'starnet-test-rules-'));
  try {
    const listFile = join(dir, 'rules.list');
    writeFileSync(listFile, picked.join('\n') + '\n');
    const run = opts.run || runList;
    return await run({ listFile, filters: [], label: 'test:rules', log: opts.log });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) process.exit(await main());
