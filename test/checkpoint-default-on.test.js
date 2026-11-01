'use strict';
const { readSidecarSource } = require('./helpers/source');
/* Lane C5 — the checkpoint rollback net is ON by default. STARNET_CHECKPOINTS=0 / SKYNET_CHECKPOINTS=0 opts
   out; fail-open semantics are untouched. The env parser is lifted VERBATIM out of sidecar/index.js so this
   asserts the shipped function, and the dispatch hook is checked structurally for fs.write coverage. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const src = readSidecarSource();

const m = /function checkpointsEnabledFromEnv\(raw\) \{[\s\S]*?\n\}\n/.exec(src);
A.ok(m, 'index.js defines checkpointsEnabledFromEnv');
const enabled = new Function(m[0] + 'return checkpointsEnabledFromEnv;')();
A.eq(enabled(undefined), true, 'no env var → checkpoints ON');
A.eq(enabled(''), true, 'empty env var → ON');
A.eq(enabled('1'), true, '1 → ON');
A.eq(enabled('true'), true, 'true → ON');
A.eq(enabled('0'), false, '0 → opt out');
A.eq(enabled('false'), false, 'false → opt out');
A.eq(enabled('off'), false, 'off → opt out');
A.eq(enabled('NO'), false, 'NO → opt out (case-insensitive)');
A.ok(/const CHECKPOINTS_ENABLED = checkpointsEnabledFromEnv\(ENV\('CHECKPOINTS'\)\);/.test(src), 'the flag is computed from STARNET_/SKYNET_CHECKPOINTS through ENV()');

// fs.write rides the PRECISE path: fs.js calls ctx.checkpointMutation(base,'fs mutation',{resolvedRoot:true}) with
// no `always`, so that snapshot happens iff CHECKPOINTS_ENABLED — now true with no env var set.
const fsSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'fs.js'), 'utf8');
A.ok(/ctx\.checkpointMutation\(base, 'fs mutation', \{ resolvedRoot: true \}\)/.test(fsSrc), 'fs writers snapshot through checkpointMutation without always:true');
A.ok(/if \(!CHECKPOINTS_ENABLED && !\(opts2 && opts2\.always === true\)\) return null;/.test(src), 'checkpointMutation gates on CHECKPOINTS_ENABLED (default-on) unless always:true');
A.ok(/catch \(_\) \{\}/.test(fsSrc.slice(fsSrc.indexOf("ctx.checkpointMutation(base, 'fs mutation'") - 20, fsSrc.indexOf("ctx.checkpointMutation(base, 'fs mutation'") + 120)), 'fs snapshot stays fail-open');
A.ok(/if \(environmentCheckpoints && mutatesWorkspace\(c\.name\) && !preciseCheckpoint && \(CHECKPOINTS_ENABLED \|\| \/\^\(shell\|verify\)\\.\/\.test\(c\.name\)\)\)/.test(src), 'the generic pre-tool hook also keys off CHECKPOINTS_ENABLED');
A.report('checkpoint-default-on.test');
