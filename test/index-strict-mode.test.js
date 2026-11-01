/* node test/index-strict-mode.test.js — sidecar/index.js really runs in strict mode.

   A merge (f3c77c454, 2026-07-29) left a stray object-literal line in FRONT of the header comment:
   `botUsername: () => ...,/* sidecar/index.js ...`. That parses as a labelled comma expression, so the
   `'use strict'` below the comment stopped being a directive and the whole 28k-line host ran in sloppy mode
   for months. In sloppy mode an undeclared assignment silently creates a global: `finalCompletionEvidence`
   (assigned in runOnceCore, never declared) became ONE process-wide slot shared by every concurrent run, so an
   overlapping run could stamp another run's completion verdict on its agent.run.end + durable runStore row.

   Laws under test (compile only — index.js is not loadable, requiring it boots a real sidecar):
     • the 'use strict' directive is live: the module body, compiled the way Node's CJS wrapper does, rejects
       strict-only syntax;
     • finalCompletionEvidence is a per-run local of runOnceCore, and the settle path never reads it unset. */
'use strict';
const { readSidecarIndex } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const src = readSidecarIndex();

function compiles(body) {
  try { new vm.Script('(function (exports, require, module, __filename, __dirname) {' + body + '\n})', { filename: 'index.js' }); return null; }
  catch (e) { return e; }
}

// The module compiles as-is (the CJS wrapper allows its top-level returns).
A.eq(compiles(src), null, 'sidecar/index.js compiles inside the CJS wrapper');

// `var eval` is legal sloppy JS and a SyntaxError only under a live 'use strict' directive.
const probe = compiles(src + '\n;var eval;');
A.ok(probe instanceof SyntaxError && /strict mode/i.test(probe.message), 'the use-strict directive is live (strict-only syntax is rejected): ' + (probe && probe.message));

// Nothing but comments/whitespace may precede the directive.
const lead = src.replace(/^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*/, '');
A.ok(lead.startsWith("'use strict';"), "the first statement of sidecar/index.js is 'use strict';");

// finalCompletionEvidence: declared per run inside runOnceCore, and defaulted before the settle path reads it.
// The range is runOnceCore's own: from its header to the first column-0 `}` (A.fnBody's brace scan runs past it on
// this file's regex literals, so it cannot bound the check).
const start = src.indexOf('\nasync function runOnceCore(o) {');
const end = start < 0 ? -1 : src.indexOf('\n}\n', start);
A.ok(start > 0 && end > start && (end - start) < src.length / 4, 'found runOnceCore\'s own range (' + (end - start) + ' chars)');
const core = src.slice(start, end);
A.eq((src.match(/^[ \t]*(?:let|var|const) finalCompletionEvidence\b/gm) || []).length, 1,'finalCompletionEvidence is declared exactly once (no module-scope copy)');
A.ok(/\n  let finalCompletionEvidence = null;/.test(core), 'finalCompletionEvidence is a function-level local of runOnceCore (per run)');
const DEFAULT = 'if (!finalCompletionEvidence) finalCompletionEvidence = execution.completionEvidence();';
const at = core.indexOf(DEFAULT);
const fin = at < 0 ? -1 : core.lastIndexOf('\n  } finally {', at);
A.ok(fin > 0 && /^\n  \} finally \{\s*(\/\/[^\n]*\s*)*$/.test(core.slice(fin, at)), 'the settle `finally` defaults it FIRST to this run\'s own evidence when the run threw before the postconditions pass');
A.ok(at > 0 && at < core.indexOf("completionVerdict: 'not_assessed', effectVerdict: finalCompletionEvidence.effectVerdict"), 'the default lands before the settle path reads it');

A.report('index-strict-mode.test');
