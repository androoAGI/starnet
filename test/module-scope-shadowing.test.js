/* node test/module-scope-shadowing.test.js — NO TWO MODULE-SCOPE FUNCTIONS MAY SHARE A NAME.
 *
 * WHY THIS EXISTS: `sidecar/index.js` is CommonJS, where two `function foo()` declarations in the
 * same scope are NOT a syntax error — the LAST one silently wins for the whole module, including
 * for hoisted references written ABOVE it. That is invisible to `node --check`, invisible to a
 * diff, and invisible to any unit test that injects a fake for the shadowed function.
 *
 * It shipped once. `runGit` was declared twice: the checkpoint version `(args, opts)` at the top
 * and the night-shift/loop-harvest version `(root, args, timeoutMs)` further down. The checkpoint
 * store was constructed with `runGit: runGit` and therefore received the night-shift signature,
 * so EVERY shadow-git snapshot returned null — the undo net behind `shell.*`, `verify.*` and
 * `fs.write` was dead in the shipped app, while `checkpoint-store.test.js` stayed green because
 * it injects its own runGit. Renaming one of them is the whole fix; this test is the guard.
 *
 * The check is deliberately dumb and byte-level: a declaration at COLUMN 0 in these files is
 * module scope (house style indents every nested function). Duplicates there are the bug class.
 * Pure + zero-dep: reads source text, executes nothing. */
'use strict';
const { readSidecarIndex, sidecarSourceFiles } = require('./helpers/source');
const A = require('./_assert.js');

// The CommonJS modules big enough for a name collision to hide in.
const GUARDED = ['sidecar/index.js'];

// Returns Map<name, line[]> for every column-0 `function name(` / `async function name(`.
function moduleScopeDeclarations(src) {
  const found = new Map();
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    if (!found.has(name)) found.set(name, []);
    found.get(name).push(i + 1);
  }
  return found;
}

/* ---- the guard ---- */
// Each guarded file is scanned ON ITS OWN (module scope is per file: two modules may each own a `start()`), and read
// through test/helpers/source.js like every other sidecar text read.
for (const rel of GUARDED) {
  const file = sidecarSourceFiles().find(f => f.rel === rel);
  const src = file ? file.text : '';
  const decls = moduleScopeDeclarations(src);
  const dupes = [];
  decls.forEach((lineNos, name) => { if (lineNos.length > 1) dupes.push(name + ' @ lines ' + lineNos.join(', ')); });
  A.eq(dupes, [], rel + ' declares no module-scope function name twice (the later one would silently win)');
  A.ok(decls.size > 0, rel + ' was actually scanned (found some module-scope declarations)');
}

/* ---- the detector itself detects (so a green result above means something) ---- */
{
  const planted = [
    'function runGit(args, opts) { return 1; }',
    'const x = 1;',
    'function runGit(root, args, timeoutMs) { return 2; }',
    '  function nested(a) { return 3; }',   // indented => not module scope, must be ignored
  ].join('\n');
  const d = moduleScopeDeclarations(planted);
  A.eq((d.get('runGit') || []).length, 2, 'the detector sees a planted duplicate at column 0');
  A.eq(d.has('nested'), false, 'the detector ignores an indented (nested) declaration');
}

/* ---- the specific regression: the two runGits must still be distinct ---- */
{
  const src = readSidecarIndex();
  const decls = moduleScopeDeclarations(src);
  A.eq((decls.get('runGit') || []).length, 1, 'exactly one module-scope runGit (the night-shift one)');
  A.eq((decls.get('runGitCheckpoint') || []).length, 1, 'the checkpoint git helper keeps its own distinct name');
  A.ok(/runGit:\s*runGitCheckpoint/.test(src), 'the checkpoint store is wired to runGitCheckpoint, not to runGit');
}

A.report('module-scope-shadowing.test');
