#!/usr/bin/env node
/* Impact selection: which tests can see a change.

   fc98fb777 changed sidecar/taskbrief-tools.js and left the HTTP e2e test/ask-brief-before-approval.e2e.test.js red,
   because only the module's own fast test ran. That e2e names no module and requires none; it reaches the module only
   through the tool wire names brief_proceed and brief_ask. So selection cannot stop at "who requires the file".

   For each changed path the selector picks, from the tests on the gate lists:
     (a) tests that REQUIRE the changed module (directly, or through a test helper up to two levels deep), or name its
         full repo path;
     (b) http and e2e tests that name the module's basename or one of its route strings ('/api/...');
     (c) tests that name a TOOL NAME the changed module registers (name: 'x.y'), in dotted form and in the x_y wire
         form the model sees. Ranked by how many of the names a test uses, and capped;
     (d) a SMOKE fallback, the head of the rules tier (scripts/test-rules.mjs), which is ALWAYS included, so a change
         no rule recognises still gets the cheap rule tests and the selection is never empty.
   The map only widens. It is advisory: it never replaces test:fast / test:http.

     node scripts/tests-for-changes.mjs                  uncommitted changes (git diff --name-only HEAD + untracked)
     node scripts/tests-for-changes.mjs <base>[..<head>] git diff --name-only <base>..<head> (head defaults to HEAD)
     node scripts/tests-for-changes.mjs --files a,b      an explicit list of changed paths
     add --why to print the rules that picked each test, --run to run the selection through scripts/run-test-list.mjs */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstMarker, relativeSpecifiers, resolveSpecifier, stripComments } from './test-rules.mjs';
import { runList } from './run-test-list.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTS = ['', '.js', '.mjs', '.cjs', '/index.js'];
const WEB_NAME = /\.(?:http|e2e)\./;
const FILE_LIKE = new Set(['js', 'mjs', 'cjs', 'json', 'md', 'txt', 'png', 'jpg', 'gif', 'svg', 'css', 'html', 'ico', 'yaml', 'yml', 'toml', 'log', 'csv', 'zip', 'pdf', 'wav', 'mp3', 'mp4', 'ts']);
const RULE_NAME = /(?:^|[._\-/])(?:lint|ratchet|census|completeness)(?:[._\-]|$)/;
export const SMOKE_SIZE = 10;
export const CAP_B = 40;
export const CAP_C = 25;

const slash = p => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseName = p => posix.basename(p).replace(/\.(?:c|m)?js$/, '');

/* The routes a module serves or names: '/api/...' string literals, with path parameters cut off. */
export function routeStrings(text) {
  const out = new Set();
  const re = /['"`](\/api\/[A-Za-z0-9_\-/.]*[A-Za-z0-9_\-])/g;
  let m;
  while ((m = re.exec(String(text)))) out.add(m[1].replace(/\/+$/, ''));
  return [...out];
}

/* The tool names a module registers: name: 'x.y' (dotted), each with its wire form x_y. */
export function toolNames(text) {
  const out = new Map();
  const re = /\bname\s*:\s*(['"])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g;
  let m;
  while ((m = re.exec(stripComments(text)))) {
    const dotted = m[2];
    if (FILE_LIKE.has(dotted.split('.').pop())) continue;
    out.set(dotted, dotted.replace(/\./g, '_'));
  }
  return out;
}

const wordRe = name => new RegExp('(?<![\\w.])' + escapeRe(name) + '(?![\\w])');

/* Every repo-relative path a test can reach by require/import: its own specifiers, and those of the test helpers it
   loads (two levels). Paths come back as written, extension unresolved: the matcher tries the extensions. */
function reachable(file, text, read, depth = 2, seen = new Set()) {
  const out = new Set();
  for (const spec of relativeSpecifiers(text)) {
    const base = posix.normalize(posix.join(posix.dirname(file), spec));
    out.add(base);
    if (depth > 1 && base.startsWith('test/') && !seen.has(base)) {
      seen.add(base);
      const hit = resolveSpecifier(file, spec, read);
      if (hit) for (const p of reachable(hit.rel, hit.text, read, depth - 1, seen)) out.add(p);
    }
  }
  return out;
}

export function selectTests({ changed, tests, read, disable, smokeSize = SMOKE_SIZE, capB = CAP_B, capC = CAP_C }) {
  const off = new Set(disable || []);
  const files = [...new Set((changed || []).map(slash).filter(Boolean))];
  const cache = new Map();
  const rd = rel => { if (!cache.has(rel)) cache.set(rel, typeof read === 'function' ? read(rel) : null); return cache.get(rel); };
  const list = tests || [];
  const reasons = {};
  const add = (file, rule) => { const r = reasons[file] || (reasons[file] = []); if (!r.includes(rule)) r.push(rule); };

  // (d) smoke: the head of the rules tier, never an e2e. Rule tests by name (lint, ratchet, census, completeness)
  // lead it: they are the seconds-scale ones that guard the repo's laws. Computed first so it always leads the selection.
  const inTier = t => !WEB_NAME.test(t.file) && (typeof t.rules === 'boolean' ? t.rules : firstMarker(t.text) === null);
  const tier = list.filter(inTier);
  const smoke = [...tier.filter(t => RULE_NAME.test(t.file)), ...tier.filter(t => !RULE_NAME.test(t.file))]
    .slice(0, smokeSize).map(t => t.file);

  const reach = new Map();
  const reachOf = t => { if (!reach.has(t.file)) reach.set(t.file, reachable(t.file, t.text, rd)); return reach.get(t.file); };

  for (const changedFile of files) {
    const text = rd(changedFile);
    const isCode = /\.(?:c|m)?js$/.test(changedFile);
    // (a) requires the module, or names its full repo path
    if (!off.has('a') && isCode) {
      const noExt = changedFile.replace(/\.(?:c|m)?js$/, '');
      for (const t of list) {
        const paths = reachOf(t);
        let hit = false;
        for (const p of paths) {
          for (const ext of EXTS) if (p + ext === changedFile || (ext === '' && p === noExt)) { hit = true; break; }
          if (hit) break;
        }
        if (!hit && t.text.includes(changedFile)) hit = true;
        if (hit) add(t.file, 'a');
      }
    }
    // (b) http / e2e tests naming the basename or a route string
    if (!off.has('b') && isCode) {
      const base = baseName(changedFile);
      const needles = [];
      if (base !== 'index' && base.length >= 4) needles.push(wordRe(base));
      const routes = typeof text === 'string' ? routeStrings(text) : [];
      for (const r of routes) needles.push(new RegExp(escapeRe(r) + '(?![\\w-])'));
      if (needles.length) {
        const scored = [];
        for (const t of list) {
          if (!WEB_NAME.test(t.file)) continue;
          let n = 0;
          for (const re of needles) if (re.test(t.text)) n++;
          if (n) scored.push({ file: t.file, n });
        }
        scored.sort((x, y) => y.n - x.n);
        for (const s of scored.slice(0, capB)) add(s.file, 'b');
      }
    }
    // (c) tests naming a tool the module registers (dotted or x_y)
    if (!off.has('c') && typeof text === 'string' && isCode) {
      const names = toolNames(text);
      if (names.size) {
        const forms = [...names].map(([dotted, wire]) => [wordRe(dotted), wordRe(wire)]);
        const scored = [];
        for (const t of list) {
          let n = 0;
          for (const [d, w] of forms) if (d.test(t.text) || w.test(t.text)) n++;
          if (n) scored.push({ file: t.file, n, web: WEB_NAME.test(t.file) ? 1 : 0 });
        }
        scored.sort((x, y) => (y.n - x.n) || (y.web - x.web));
        for (const s of scored.slice(0, capC)) add(s.file, 'c');
      }
    }
  }

  const picked = new Set(smoke);
  for (const t of list) if (reasons[t.file]) picked.add(t.file);
  for (const f of smoke) add(f, 'd');
  return { selected: [...picked], reasons, smoke, changed: files };
}

/* The change list: git diff --name-only <base>..<head>, or the working tree when no base is given. */
export function changedFromGit(base, head, opts = {}) {
  const cwd = opts.cwd || ROOT;
  const git = args => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + String(r.stderr || '').trim());
    return String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  };
  if (!base) return [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];
  return git(['diff', '--name-only', base + '..' + (head || 'HEAD')]);
}

function listLines(rel, root) {
  const p = join(root, rel);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split('|')[0].trim());
}

export async function main(argv, opts = {}) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  const log = opts.log || (line => console.log(line));
  const root = opts.cwd || ROOT;
  const read = rel => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  let changed = null, range = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--files') changed = String(args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--files=')) changed = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--why' || a === '--run') continue;
    else if (a.startsWith('--')) { log('unknown option ' + a); return 1; }
    else range = a;
  }
  if (!changed) {
    const [base, head] = range ? range.split('..') : [null, null];
    try { changed = changedFromGit(base, head, { cwd: root }); }
    catch (error) { log(error.message); return 1; }
  }
  const gate = [...new Set([...listLines('test/fast.list', root), ...listLines('test/http.list', root)])];
  const tests = gate.map(file => ({ file, text: read(file) })).filter(t => typeof t.text === 'string');
  const out = selectTests({ changed, tests, read });
  if (args.includes('--run')) {
    const dir = mkdtempSync(join(opts.tmpRoot || tmpdir(), 'starnet-tests-for-changes-'));
    try {
      const listFile = join(dir, 'selected.list');
      writeFileSync(listFile, out.selected.join('\n') + '\n');
      return await (opts.run || runList)({ listFile, filters: [], label: 'tests-for-changes', log: opts.log });
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
  log('# changed: ' + (changed.length ? changed.join(', ') : '(nothing)'));
  for (const f of out.selected) log(args.includes('--why') ? f + '   [' + (out.reasons[f] || []).join(',') + ']' : f);
  return 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) process.exit(await main());
