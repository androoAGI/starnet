'use strict';
/* node test/test-ports-imports.lint.test.js — every file that uses the port helpers really imports them.

   THE HOLE THIS CLOSES (2026-10-29): the test-ports conversion put
   `const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js')` inside subscription-stacking's FAKE_CLI
   template string (the fake `claude` binary's source), not at the test's own top level, so the test threw
   "allocatePort is not defined" in 0.1 s. test-ports.lint checks port SHAPES, not imports, so it stayed green.

   The law: a file under test/, dev/ or scripts/ that names allocatePort, allocatePorts or BIND_REFUSED outside
   comments must get it from a real import (helpers/ports.js, or helpers/sidecar-fixture.js which re-exports it,
   by require, import or the repo's requireRepo), and no such import may sit inside a template literal. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['test/helpers/ports.js', 'test/test-ports.lint.test.js', 'test/test-ports-imports.lint.test.js']);
const USES = /\b(allocatePorts?|BIND_REFUSED)\b/;
const IMPORT = /(require\([^)]*helpers[\\/](?:ports|sidecar-fixture)(?:\.js)?['"]\)|require\(\s*['"]\.\/(?:ports|sidecar-fixture)(?:\.js)?['"]\s*\)|from\s+['"][^'"]*helpers[\\/](?:ports|sidecar-fixture)(?:\.js)?['"]|requireRepo\([^)]*['"](?:ports|sidecar-fixture)\.js['"]\)|require\(\s*(?:path\.)?(?:join|resolve)\([^)]*,\s*['"]helpers['"]\s*,\s*['"](?:ports|sidecar-fixture)\.js['"]\s*\)\s*\))/g;

// Keep offsets: 1 means template text; 2 means a comment/ordinary quoted string, neither a real import.
function templateMask(s) {
  const inTpl = new Uint8Array(s.length);
  let i = 0, tpl = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (!tpl && c === '/' && n === '/') { const start = i; while (i < s.length && s[i] !== '\n') i++; inTpl.fill(2, start, i); continue; }
    if (!tpl && c === '/' && n === '*') { const start = i, e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; inTpl.fill(2, start, i); continue; }
    if (!tpl && (c === '"' || c === "'")) { const start = i, q = c; i++; while (i < s.length && s[i] !== q && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1; i++; inTpl.fill(2, start, i); continue; }
    if (c === '\\') { if (tpl) { inTpl[i] = 1; inTpl[i + 1] = 1; } i += 2; continue; }
    if (c === '`') { tpl = !tpl; i++; continue; }
    if (tpl) inTpl[i] = 1;
    i++;
  }
  return inTpl;
}

function check(file, src) {
  const problems = [];
  const mask = templateMask(src);
  let real = 0, m;
  IMPORT.lastIndex = 0;
  while ((m = IMPORT.exec(src))) {
    if (mask[m.index] === 1) problems.push(file + ':' + src.slice(0, m.index).split('\n').length + ' imports the port helpers INSIDE a template literal');
    else if (mask[m.index] === 0) real++;
  }
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (USES.test(code) && real === 0) problems.push(file + ' uses the port helpers with no real import');
  return problems;
}

// The law itself, on samples first.
A.eq(check('s.js', "const { allocatePort } = require('./helpers/ports.js');\nallocatePort();").length, 0, 'a top-level import passes');
A.eq(check('s.js', "const X = String.raw`\nconst { allocatePort } = require('./helpers/ports.js');\n`;\nallocatePort();").length, 2, 'the subscription-stacking shape fails twice: import in a template, and no real import');
A.eq(check('s.js', "// allocatePort() is how ports are picked\nconst x = 1;").length, 0, 'a comment mention is not a use');
A.eq(check('s.mjs', "import { allocatePorts } from '../../test/helpers/ports.js';\nawait allocatePorts(2);").length, 0, 'an ESM import passes');
A.eq(check('s.js', "const p = await require('../test/helpers/sidecar-fixture.js').allocatePort();").length, 0, 'an inline require of the fixture passes');
const constructed = "const { allocatePort } = require(join(ROOT, 'test', 'helpers', 'ports.js'));";
A.eq(check('s.mjs', constructed + '\nallocatePort();').length, 0, 'the WebKit runner imports the actual helper through its constructed repository path');
A.eq(check('s.js', 'const fake = ' + String.fromCharCode(96) + constructed + String.fromCharCode(96) + ';\nallocatePort();').length, 2, 'a constructed import inside generated source cannot satisfy the parent file');
A.eq(check('s.js', constructed.replace("'helpers'", "'other'") + '\nallocatePort();').length, 1, 'a matching basename in another directory is not the helper');
A.eq(check('s.js', '// ' + constructed + '\nallocatePort();').length, 1, 'a commented import cannot satisfy an actual use');
A.eq(check('s.js', 'const example = ' + JSON.stringify(constructed) + ';\nallocatePort();').length, 1, 'a quoted example cannot satisfy an actual use');

const files = execFileSync('git', ['ls-files', '--', 'test', 'dev', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/).filter(f => /\.(c|m)?js$/.test(f) && !SKIP.has(f.replace(/\\/g, '/')));
const found = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (!USES.test(src)) continue;
  found.push(...check(f, src));
}
A.eq(found, [], 'every file that uses the port helpers imports them for real, outside template literals');
A.report('test-ports-imports.lint.test');
