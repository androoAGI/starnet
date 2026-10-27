'use strict';
/* test/helpers/source.js — read the sidecar's source as TEXT, wherever the code lives.

   WHY THIS EXISTS (gate-seams, 2026-10-27): ~200 source-lock tests read sidecar/index.js as text — they assert a
   call is wired, slice a route handler or a function out of it, or run an extracted function in a vm sandbox.
   Every one of them broke the moment a function moved out of the 29.6k-line index.js into its own module, even
   when the move changed no behaviour. So extracting code from index.js was effectively forbidden by the gate.

   readSidecarSource() is the whole sidecar as one text: sidecar/index.js FIRST, then every other sidecar/**.js in
   sorted path order, each preceded by a one-line marker comment naming the file. index.js going first keeps the
   old semantics wherever they still hold — the first indexOf() of anything that lives in index.js lands where it
   always did — while code moved into a module is still found. sidecarFunctionSource(name) finds one named
   function in whichever sidecar file declares it.

   WHAT CONCATENATION CHANGES, named rather than hand-waved:
   - A POSITIVE assertion (includes / match / indexOf >= 0) can now be satisfied by text in a different file. A
     lock that means "index.js does X" should slice the function or route it is about (fnBody, a handler slice)
     instead of matching the whole text.
   - A NEGATIVE assertion (doesNotMatch / !includes / indexOf < 0) now covers every sidecar file, so it fails if
     ANY module contains the pattern. That is stricter, and loud.
   - Counting assertions ("defined exactly once") count across every file.
   - An ORDERING or DISTANCE assertion (indexOf(a) < indexOf(b), |a - b| < N) compares offsets in the joined text.
     Once either anchor leaves index.js it compares file sort order instead — an anchor in a later file sorts after
     every index.js offset — and the lock goes vacuously true (or false). Slice the function both anchors live in
     first (sidecarTopLevelFunction / sidecarFunctionSource), require both anchors in the slice, then compare.
   - A conjunction (A && B) is only as strict as each half: one half matching index.js-only text does not stop the
     other half from being satisfied by a different file. Check each half on its own when you review a lock.
   readSidecarIndex() is the exact file, for a test that deliberately pins index.js's own structure (its
   'use strict', its module scope). Use it only for that, and say why at the call site.

   AUDIT MODES (for reviewing a codemod, never for a gate): STARNET_SOURCE_AUDIT=index-only makes
   readSidecarSource() return index.js alone (the old behaviour); =without-index returns every OTHER file; =empty
   returns ''. A test that still passes with index.js removed has assertions other files satisfy — review those.
   The gate runner's environment allowlist drops the variable, so a gate step always sees the full source. */

const fs = require('fs');
const path = require('path');

// Captured at load: a test that later swaps fs for an in-memory fake must not change what the source reads return.
const readFileSync = fs.readFileSync;
const readdirSync = fs.readdirSync;

const ROOT = path.resolve(__dirname, '..', '..');
const SIDECAR_DIR = path.join(ROOT, 'sidecar');
const INDEX_REL = 'sidecar/index.js';

let filesCache = null;
const textCache = new Map();

/* Directories that are never sidecar source: dependencies, dot-dirs, and the gitignored runtime workspaces a dev
   sidecar can create under sidecar/ (sidecar/workspaces and sidecar/workspaces.<name> — agents write arbitrary .js
   there, and scripts/prepare-node.mjs refuses to bundle them for the same reason). */
function isSkippedDir(name) {
  return name === 'node_modules' || name.startsWith('.') || /^workspaces(?:[.-].*)?$/i.test(name);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!isSkippedDir(entry.name)) walk(abs, out); }
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}

/** Every sidecar JavaScript file as { rel, text }: index.js first, then the rest in sorted path order. */
function sidecarSourceFiles() {
  if (!filesCache) {
    const rels = walk(SIDECAR_DIR, []).filter(rel => rel !== INDEX_REL).sort();
    filesCache = [INDEX_REL].concat(rels).map(rel => ({ rel, text: readFileSync(path.join(ROOT, rel), 'utf8') }));
  }
  return filesCache;
}

function marker(rel) {
  return '/* ---- ' + rel + ' ---- */\n';
}

function join(files) {
  return files.map(f => marker(f.rel) + f.text).join('\n');
}

/** The whole sidecar as one text (see the header for what that changes).
    options.except: sidecar paths to leave out, for a count that a test pins separately per file — e.g. "the host's
    two hop runners, wherever they live" counts everything except sidecar/channels/hub.js, whose own copy of the
    runner the test checks on its own. A path that is not a sidecar file throws, so a typo cannot silently count all. */
function readSidecarSource(options) {
  const mode = process.env.STARNET_SOURCE_AUDIT || '';
  const except = (options && options.except ? options.except.slice() : []).sort();
  const files = sidecarSourceFiles();
  for (const rel of except) if (!files.some(f => f.rel === rel)) throw new Error('readSidecarSource: except names no sidecar file: ' + rel);
  const key = mode + '|' + except.join(',');
  if (textCache.has(key)) return textCache.get(key);
  const kept = files.filter(f => !except.includes(f.rel));
  let text;
  if (mode === 'index-only') text = kept.length && kept[0].rel === INDEX_REL ? kept[0].text : '';
  else if (mode === 'without-index') text = join(kept.filter(f => f.rel !== INDEX_REL));
  else if (mode === 'empty') text = '';
  else text = join(kept);
  textCache.set(key, text);
  return text;
}

/** sidecar/index.js alone — only for a test that deliberately pins index.js's own structure. */
function readSidecarIndex() {
  return sidecarSourceFiles()[0].text;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Declarations sidecarFunctionSource understands: `function NAME(`, `async function NAME(`, `function* NAME(`,
   and `const|let|var NAME = function` / `= async function` / `= (args) => {` / `= async (args) => {` / `= arg => {`. */
function declarationRe(name) {
  const n = escapeRe(name);
  return new RegExp(
    '(?:^|[^\\w$.])((?:async\\s+)?function\\s*\\*?\\s*' + n + '\\s*\\(' +
    '|(?:const|let|var)\\s+' + n + '\\s*=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>))', 'm');
}

/** Where a named function is declared: { rel, index } (index into that file's text), or null. */
function locateSidecarFunction(name) {
  const re = declarationRe(name);
  for (const file of sidecarSourceFiles()) {
    const m = re.exec(file.text);
    if (m) return { rel: file.rel, index: m.index + m[0].indexOf(m[1]) };
  }
  return null;
}

// index of the bracket closing the one opened at `open` ('(' or '{'), skipping strings and comments; -1 if none.
function closeOf(text, open) {
  const o = text[open], c = o === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === ch) break; }
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** The source of one named sidecar function, from its declaration to its own closing brace, in whichever sidecar
    file declares it (index.js first). '' when no sidecar file declares it. An expression-bodied arrow returns its
    declaration line. Like test/_fnbody.js, this is a scanner, not a parser: a quote inside a regex character class
    can make the slice run long, so keep a length guard on what you assert about it. */
function sidecarFunctionSource(name) {
  const at = locateSidecarFunction(name);
  if (!at) return '';
  return functionSourceAt(sidecarSourceFiles().find(f => f.rel === at.rel).text, at.index, name);
}

/** The same slice over any text: the first declaration of `name` in `text`, or ''. */
function functionSourceIn(text, name) {
  const m = declarationRe(name).exec(text);
  return m ? functionSourceAt(text, m.index + m[0].indexOf(m[1]), name) : '';
}

function functionSourceAt(text, start, name) {
  const head = text.slice(start, start + 200);
  const nameEnd = start + head.indexOf(name) + name.length;
  let i = skipSpace(text, nameEnd);
  if (text[i] === '=') {                                   // const NAME = ...
    i = skipSpace(text, i + 1);
    if (text.startsWith('async', i) && !/[\w$]/.test(text[i + 5])) i = skipSpace(text, i + 5);
    if (text.startsWith('function', i)) i = text.indexOf('(', i);
  }
  if (text[i] === '(') {                                   // the parameter list, which may hold braces of its own
    const close = closeOf(text, i);
    if (close < 0) return '';
    i = skipSpace(text, close + 1);
  } else {                                                 // a bare `arg =>` parameter
    while (i < text.length && /[\w$]/.test(text[i])) i++;
    i = skipSpace(text, i);
  }
  if (text.startsWith('=>', i)) i = skipSpace(text, i + 2);
  if (text[i] !== '{') {                                   // expression-bodied arrow
    const nl = text.indexOf('\n', i);
    return text.slice(start, nl < 0 ? text.length : nl);
  }
  const end = closeOf(text, i);
  return end < 0 ? text.slice(start) : text.slice(start, end + 1);
}

/** The source of one TOP-LEVEL sidecar function (declared at column 0, `function NAME(` / `async function NAME(`),
    from its declaration through the first later line that starts with `}`, in whichever sidecar file declares it
    (index.js first). '' when no sidecar file declares it at column 0. It scans no brackets, so a quote inside a
    regex literal cannot make it run long — sidecarFunctionSource('runOnceCore') overruns to the end of index.js
    that way — and relies instead on the house layout: inside a top-level function no line starts with `}` until
    its own closing brace. Use it to slice a big host function (runOnceCore, runScoutCycle) before an ordering or
    distance assertion. */
function sidecarTopLevelFunction(name) {
  const re = new RegExp('^(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*' + escapeRe(name) + '[ \\t]*\\(', 'm');
  for (const file of sidecarSourceFiles()) {
    const m = re.exec(file.text);
    if (!m) continue;
    const close = /\n\}/.exec(file.text.slice(m.index));
    return close ? file.text.slice(m.index, m.index + close.index + 2) : '';
  }
  return '';
}

/** Which sidecar file contains a string or matches a regex (the first, index.js first), or null. For messages. */
function sidecarFileContaining(needle) {
  for (const file of sidecarSourceFiles()) {
    if (needle instanceof RegExp ? new RegExp(needle.source, needle.flags.replace('g', '')).test(file.text) : file.text.includes(needle)) return file.rel;
  }
  return null;
}

module.exports = {
  readSidecarSource,
  readSidecarIndex,
  sidecarSourceFiles,
  sidecarFunctionSource,
  sidecarTopLevelFunction,
  functionSourceIn,
  locateSidecarFunction,
  sidecarFileContaining,
  isSkippedDir,
  SIDECAR_INDEX: INDEX_REL
};
