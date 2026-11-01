'use strict';
/* node test/source-helper.test.js — test/helpers/source.js, and the law that keeps source locks on it.

   Source locks read the sidecar as text. Reading sidecar/index.js directly made every behaviour-preserving
   extraction out of the 29.6k-line host a red gate, so the locks read through the helper instead
   (readSidecarSource: the whole sidecar, index.js first; sidecarFunctionSource: one function wherever it lives).

   H1 the concatenation: index.js first and byte-identical, then every other sidecar .js file in sorted order,
      each behind a marker naming it; nothing outside sidecar/.
   H2 the function locator: declarations of every supported shape, a parameter list holding braces, a string holding
      a brace, a function that lives in a module rather than index.js, and '' for a name nobody declares; and the
      column-0 slicer (sidecarTopLevelFunction) that ordering locks use on runOnceCore.
   H3 a test that swaps fs.readFileSync for a fake after loading the helper still gets the real source.
   H4 the audit modes return index.js alone / everything else / nothing, and the default is the whole sidecar.
   H5 THE LAW: no test reads sidecar/index.js as text except through the helper — a direct read would bring back
      the coupling this helper removed — including a list of paths holding index.js that is read file by file.
      (Spawning index.js as a process is fine; that is not a text read.) */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(__dirname, 'helpers', 'source.js');
const S = require(HELPER);

// H1
const files = S.sidecarSourceFiles();
const rels = files.map(f => f.rel);
A.eq(rels[0], 'sidecar/index.js', 'H1: index.js comes first');
A.eq(rels.slice(1), rels.slice(1).slice().sort(), 'H1: the other files follow in sorted path order');
A.ok(rels.every(r => r.startsWith('sidecar/') && r.endsWith('.js')), 'H1: only sidecar .js files are read');
A.ok(rels.includes('sidecar/loop.js') && rels.includes('sidecar/channels/hub.js'), 'H1: nested modules are included');
A.eq(new Set(rels).size, rels.length, 'H1: no file is read twice');
A.eq(['workspaces', 'workspaces.dev', 'Workspaces-old', 'node_modules', '.cache'].map(S.isSkippedDir), [true, true, true, true, true],
  'H1: runtime workspaces, dependencies and dot-dirs under sidecar/ are never read as source');
A.eq(['channels', 'tools', 'workspace-lineage'].map(S.isSkippedDir), [false, false, false], 'H1: real source directories are read');
A.ok(!rels.some(r => /\/workspaces(?:[.-][^/]*)?\//i.test(r)), 'H1: no file under a runtime workspace directory is in the source');
const indexText = fs.readFileSync(path.join(ROOT, 'sidecar', 'index.js'), 'utf8');   // the one sanctioned direct read: the helper's own check
A.ok(S.readSidecarIndex() === indexText, 'H1: readSidecarIndex() is index.js byte for byte');
const all = S.readSidecarSource();
A.ok(all.startsWith('/* ---- sidecar/index.js ---- */\n' + indexText), 'H1: the whole text starts with index.js behind its marker');
for (const f of files) A.ok(all.includes('/* ---- ' + f.rel + ' ---- */\n' + f.text), 'H1: ' + f.rel + ' is in the whole text behind its marker');
A.eq(all.length, files.reduce((n, f) => n + ('/* ---- ' + f.rel + ' ---- */\n').length + f.text.length, 0) + files.length - 1, 'H1: and nothing else is');
A.ok(S.readSidecarSource() === all, 'H1: repeated reads return the cached text');

// H2
const text = [
  'const a = (o = {}) => { return { k: o }; };',
  'async function b(p = { q: 1 }) { if (p) { return "}"; } }',
  'const c = v => v + 1;',
  'let d = async function (x) { return x; };',
  'const e = async x => { return x; };',
  'function* g() { yield 1; }',
  'const notIt = { h() { return 1; } };',
  'foo.bfn = 1; function bfn() { return 2; }'
].join('\n');
A.eq(S.functionSourceIn(text, 'a'), 'const a = (o = {}) => { return { k: o }; }', 'H2: an arrow whose default parameter holds braces');
A.eq(S.functionSourceIn(text, 'b'), 'async function b(p = { q: 1 }) { if (p) { return "}"; } }', 'H2: an async function with a brace inside a string');
A.eq(S.functionSourceIn(text, 'c'), 'const c = v => v + 1;', 'H2: an expression-bodied arrow returns its line');
A.eq(S.functionSourceIn(text, 'd'), 'let d = async function (x) { return x; }', 'H2: a function expression');
A.eq(S.functionSourceIn(text, 'e'), 'const e = async x => { return x; }', 'H2: an async arrow with a bare parameter');
A.eq(S.functionSourceIn(text, 'g'), 'function* g() { yield 1; }', 'H2: a generator');
A.eq(S.functionSourceIn(text, 'h'), '', 'H2: a method shorthand is not a declaration');
A.eq(S.functionSourceIn(text, 'bfn'), 'function bfn() { return 2; }', 'H2: a property assignment of the same name is not the declaration');
A.eq(S.functionSourceIn(text, 'nobody'), '', 'H2: an undeclared name gives an empty string');
const shut = S.sidecarFunctionSource('gracefulShutdown');
A.ok(shut.startsWith('function gracefulShutdown(') && shut.endsWith('}') && shut.length < 20000, 'H2: an index.js function is found and bounded');
A.eq(S.locateSidecarFunction('gracefulShutdown').rel, 'sidecar/index.js', 'H2: and located in index.js');
const elsewhere = S.locateSidecarFunction('makeBudget');
A.ok(elsewhere && elsewhere.rel !== 'sidecar/index.js', 'H2: a function declared in a module is located there (' + (elsewhere && elsewhere.rel) + ')');
const body = S.sidecarFunctionSource('makeBudget');
A.ok(/^function makeBudget\(/.test(body) && body.length < files.find(f => f.rel === elsewhere.rel).text.length, 'H2: and sliced from that module');
A.eq(S.sidecarFunctionSource('noSuchSidecarFunctionAnywhere'), '', 'H2: a name no sidecar file declares gives an empty string');
A.eq(S.sidecarFileContaining('function gracefulShutdown('), 'sidecar/index.js', 'H2: sidecarFileContaining names the file');
A.eq(S.sidecarFileContaining(/function makeBudget\(/g), elsewhere.rel, 'H2: a global regex is fine too');
// the column-0 slicer, for host functions too big or too regex-heavy for the bracket scanner
const core = S.sidecarTopLevelFunction('runOnceCore');
A.ok(core.startsWith('async function runOnceCore(') && core.endsWith('\n}') && core.length > 100000 && core.length < indexText.length / 3,
  'H2: sidecarTopLevelFunction slices runOnceCore to its own closing brace (' + core.length + ' chars)');
A.ok(core.includes('const _lineHop =') && !core.includes('async function handleConsent('), 'H2: the slice holds the body and stops before the next top-level function');
A.eq(S.sidecarTopLevelFunction('runScoutCycle'), S.sidecarFunctionSource('runScoutCycle'), 'H2: where the bracket scanner works, both slicers agree');
A.eq(S.sidecarTopLevelFunction('noSuchSidecarFunctionAnywhere'), '', 'H2: sidecarTopLevelFunction gives an empty string for an undeclared name');

// H3
{
  delete require.cache[HELPER];
  const fresh = require(HELPER);
  const real = fs.readFileSync;
  fs.readFileSync = () => 'SWAPPED-FS-SENTINEL-7c1e';
  let got;
  try { got = fresh.readSidecarSource(); } finally { fs.readFileSync = real; }
  A.ok(got && got.length === all.length && !got.includes('SWAPPED-FS-SENTINEL-7c1e'), 'H3: a later fs swap does not change what the helper reads');
}

// H4
{
  const prior = process.env.STARNET_SOURCE_AUDIT;
  const mode = m => { process.env.STARNET_SOURCE_AUDIT = m; delete require.cache[HELPER]; return require(HELPER).readSidecarSource(); };
  try {
    A.ok(mode('index-only') === indexText, 'H4: index-only is index.js alone');
    const others = mode('without-index');
    A.ok(!others.includes('/* ---- sidecar/index.js ---- */') && others.includes('/* ---- sidecar/loop.js ---- */'), 'H4: without-index drops index.js only');
    A.eq(mode('empty'), '', 'H4: empty is empty');
    A.ok(mode('') === all, 'H4: no mode is the whole sidecar');
  } finally {
    if (prior === undefined) delete process.env.STARNET_SOURCE_AUDIT; else process.env.STARNET_SOURCE_AUDIT = prior;
    delete require.cache[HELPER];
  }
}

// H5 — the law, statically, over every JavaScript file under test/
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(abs);
  }
  return out;
}
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const INDEX_PATH = String.raw`(?:['"](?:\.\.\/)?sidecar\/index\.js['"]|['"]sidecar['"]\s*,\s*['"]index\.js['"]|\b(?:SIDE|SIDECAR|SIDECAR_DIR|sidecarDir)\s*,\s*['"]index\.js['"])`;
const DIRECT = new RegExp(String.raw`readFile(?:Sync)?\s*\([^;\n]*?` + INDEX_PATH);
const esc = s => s.replace(/\$/g, String.raw`\$`);
// The three shapes a text read of index.js takes in this tree; returns what it found ([] when clean).
function directReads(code) {
  const found = [];
  if (DIRECT.test(code)) found.push('readFileSync on sidecar/index.js');
  // a local text-read helper (any function whose definition reads a file) called with the index.js path
  const defRe = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>[^;\n]*readFile|function\s+([\w$]+)\s*\([^)]*\)\s*\{[^}]*readFile/g;
  let m;
  while ((m = defRe.exec(code))) {
    const name = m[1] || m[2];
    if (new RegExp(String.raw`(?<![\w$.])` + esc(name) + String.raw`\(\s*` + INDEX_PATH + String.raw`\s*\)`).test(code)) found.push(name + "('sidecar/index.js')");
  }
  // a variable holding the index.js path, then read
  const varRe = new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:require\(['"](?:node:)?path['"]\)|path)\.(?:join|resolve)\([^)]*` + INDEX_PATH + String.raw`\s*\)`, 'g');
  while ((m = varRe.exec(code))) {
    if (new RegExp(String.raw`readFile(?:Sync)?\(\s*` + esc(m[1]) + String.raw`\b`).test(code)) found.push('readFileSync(' + m[1] + ') where ' + m[1] + ' is sidecar/index.js');
  }
  // a LIST of paths holding index.js, read file by file: `[..., 'sidecar/index.js'].map(read)`,
  // `for (const f of [...]) read(f)`, or `const FILES = [...]` then `FILES.map(read)` / `for (const f of FILES) {...}`
  // (hooks.wiring, connector-required and keys-save read index.js this way, unseen by the three shapes above)
  const helpers = [];
  for (const d of code.matchAll(defRe)) helpers.push(d[1] || d[2]);
  const reads = text => /readFile/.test(text) || helpers.some(n => new RegExp(String.raw`(?<![\w$.])` + esc(n) + String.raw`\b`).test(text));
  const arrRe = new RegExp(String.raw`\[[^\[\]]*` + INDEX_PATH + String.raw`[^\[\]]*\]`, 'g');
  while ((m = arrRe.exec(code))) {
    const start = m.index, end = start + m[0].length;
    const before = code.slice(Math.max(0, start - 160), start);
    const consumers = [];
    if (/for\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s*$/.test(before)) consumers.push(loopBody(code, end));
    consumers.push(callback(code, end));
    const held = /(?:const|let|var)\s+([\w$]+)\s*=\s*$/.exec(before);
    if (held) {
      const useRe = new RegExp(String.raw`for\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+` + esc(held[1]) + String.raw`\b|(?<![\w$.])` + esc(held[1]) + String.raw`\b`, 'g');
      for (const u of code.slice(end).matchAll(useRe)) {
        const at = end + u.index + u[0].length;
        consumers.push(u[0].startsWith('for') ? loopBody(code, at) : callback(code, at));
      }
    }
    if (consumers.some(text => text && reads(text))) { found.push('a path list holding sidecar/index.js, read file by file'); break; }
  }
  return found;
}
// the bracket closing the one at `open` ('(' or '{'), skipping quoted strings; -1 if none
function closing(code, open) {
  const o = code[open], c = o === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < code.length && code[i] !== ch; i++) if (code[i] === '\\') i++; continue; }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}
// the callback of an array method called at `at` (`.map(read)`, `.forEach(f => ...)`), or ''
function callback(code, at) {
  const m = /^\s*\.(?:map|forEach|flatMap|some|every|filter|find|reduce)\s*\(/.exec(code.slice(at));
  if (!m) return '';
  const open = at + m[0].length - 1, close = closing(code, open);
  return close < 0 ? code.slice(open) : code.slice(open, close + 1);
}
// the body of a for-of loop whose iterable ends at `at` (just before the header's closing paren), or ''
function loopBody(code, at) {
  const m = /^\s*\)\s*/.exec(code.slice(at));
  if (!m) return '';
  const start = at + m[0].length;
  if (code[start] === '{') { const close = closing(code, start); return close < 0 ? code.slice(start) : code.slice(start, close + 1); }
  const semi = code.indexOf(';', start);
  return code.slice(start, semi < 0 ? code.length : semi + 1);
}
const offenders = [];
let scanned = 0;
for (const abs of walk(__dirname, [])) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (rel === 'test/helpers/source.js' || rel === 'test/source-helper.test.js') continue;
  scanned++;
  for (const what of directReads(stripComments(fs.readFileSync(abs, 'utf8')))) offenders.push(rel + ': ' + what);
}
A.ok(scanned > 1500, 'H5: the law scans the test tree (' + scanned + ' files)');
A.eq(offenders, [], 'H5: no test reads sidecar/index.js as text except through test/helpers/source.js');

// H5 self-check: the detector sees each planted shape, and spawning index.js is not a read
[
  "const s = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');",
  "const s = require('fs').readFileSync(require('path').join(__dirname, '../sidecar/index.js'), 'utf8');",
  "const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');\nconst s = read('sidecar/index.js');",
  "function rd(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }\nconst s = rd('sidecar', 'index.js');",
  "const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');\nconst s = fs.readFileSync(INDEX, 'utf8');",
  // path lists read file by file (hooks.wiring's, connector-required's and keys-save's old shapes)
  "const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');\nconst SITES = ['sidecar/loop.js', 'sidecar/index.js'];\nconst src = SITES.map(read).join('\\n');",
  "const files = ['sidecar/manual.js', 'sidecar/index.js', 'frontend/app/marketplace.js'];\nconst bad = [];\nfor (const f of files) {\n  const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');\n}",
  "const read = rel => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', rel), 'utf8');\nfor (const rel of ['sidecar/tools/builtin/keys.js', 'sidecar/index.js'])\n  A.ok(!/X/.test(read(rel)), rel);",
  "const text = ['sidecar/a.js', 'sidecar/index.js'].map(f => fs.readFileSync(f, 'utf8')).join('');"
].forEach((code, i) => A.ok(directReads(code).length > 0, 'H5: the detector catches planted shape ' + (i + 1)));
A.eq(directReads("const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');\nspawn(process.execPath, [INDEX]);"), [], 'H5: spawning index.js is not a text read');
A.eq(directReads("const t = fs.readFileSync('x.txt', 'utf8');\nconst child = spawn(process.execPath, ['sidecar/index.js'], { cwd: root });"), [], 'H5: spawning index.js from a path list is not a text read');
A.eq(directReads("const src = fs.readFileSync('x.txt', 'utf8');\nA.ok(['sidecar/index.js', 'sidecar/b.js'].every(f => writers.has(f)), 'both write');"), [], 'H5: a path list that is only compared, never read, is not a text read');

A.report('source-helper.test');
