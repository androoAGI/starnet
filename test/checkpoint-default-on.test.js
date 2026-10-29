'use strict';
const { readSidecarSource, sidecarSourceFiles, sidecarFunctionSource, functionSourceIn, locateSidecarFunction } = require('./helpers/source');
/* Lane C5 — the checkpoint rollback net is ON by default. STARNET_CHECKPOINTS=0 / SKYNET_CHECKPOINTS=0 opts
   out; fail-open semantics are untouched. The env parser is lifted VERBATIM out of sidecar/index.js so this
   asserts the shipped function, and the dispatch hook is checked structurally for fs.write coverage. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

// fs.write rides the PRECISE path: ctx.checkpointMutation(base,'fs mutation',{resolvedRoot:true}) with no `always`,
// so that snapshot happens iff CHECKPOINTS_ENABLED — now true with no env var set. The call moved with the
// containment proof out of fs.js into sidecar/run-paths.js (checkpointResolvedRoot, run-paths lane 2026-10-28);
// fs.js's resolveInside hands each write's own { scope, ctx } to that resolver.
const cprAt = locateSidecarFunction('checkpointResolvedRoot');
A.eq(cprAt && cprAt.rel, 'sidecar/run-paths.js', 'the fs mutation snapshot is declared in run-paths.js (checkpointResolvedRoot)');
const cpr = sidecarFunctionSource('checkpointResolvedRoot');
A.ok(cpr.length > 0 && cpr.length < 1200, 'checkpointResolvedRoot slices to its own body (' + cpr.length + ' chars)');
A.ok(/ctx\.checkpointMutation\(base, 'fs mutation', \{ resolvedRoot: true \}\)/.test(cpr) && !/always/.test(cpr), 'fs writers snapshot through checkpointMutation without always:true');
A.ok(/if \(!CHECKPOINTS_ENABLED && !\(opts2 && opts2\.always === true\)\) return null;/.test(src), 'checkpointMutation gates on CHECKPOINTS_ENABLED (default-on) unless always:true');
A.ok(/try \{ await ctx\.checkpointMutation\(base, 'fs mutation', \{ resolvedRoot: true \}\); \} catch \(e\) \{ failNote\('runpaths\.checkpoint', e\); \}/.test(cpr), 'fs snapshot stays fail-open');
const fsFile = sidecarSourceFiles().find(f => f.rel === 'sidecar/tools/builtin/fs.js');
const fsInside = fsFile ? functionSourceIn(fsFile.text, 'resolveInside') : '';
A.ok(fsInside.length > 0 && fsInside.length < 2000 && (fsInside.match(/resolver\.resolveFor\([^;]*Object\.assign\(\{\}, opts, /g) || []).length === 2,
  "fs.js's resolveInside hands every write's { scope, ctx } to run-paths' resolveFor (both branches)");
A.ok(/if \(environmentCheckpoints && mutatesWorkspace\(c\.name\) && !preciseCheckpoint && \(CHECKPOINTS_ENABLED \|\| \/\^\(shell\|verify\)\\.\/\.test\(c\.name\)\)\)/.test(src), 'the generic pre-tool hook also keys off CHECKPOINTS_ENABLED');

// ---- the same two facts, driven through the real fs.write tool ----
(async () => {
  const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
  const failopen = require('../sidecar/failopen.js');
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-checkpoint-default-')));
  try {
    const T = makeFsTools({ fsp: require('fs/promises'), pathMod: path, root: ROOT });
    const asked = [];
    await T.writeTool.run({ path: 'a.txt', content: 'one' }, { agentId: 'cpd', checkpointMutation: async (base, label, opts) => { asked.push({ base, label, opts }); } });
    A.eq(asked.length, 1, 'fs.write asks for one snapshot before it writes');
    A.eq(asked[0] && asked[0].label, 'fs mutation', 'the snapshot is labelled "fs mutation"');
    A.eq(asked[0] && asked[0].opts, { resolvedRoot: true }, 'the snapshot carries resolvedRoot:true and no always:true');
    A.eq(asked[0] && path.resolve(asked[0].base), path.join(ROOT, 'cpd'), "the snapshot binds to the agent's resolved workspace");
    const before = failopen.counts()['runpaths.checkpoint'] || 0;
    const warn0 = console.warn;
    let err = null;
    console.warn = () => {};
    try {
      await T.writeTool.run({ path: 'b.txt', content: 'two' }, { agentId: 'cpd', checkpointMutation: async () => { throw new Error('snapshot store unavailable'); } });
    } catch (e) { err = e; } finally { console.warn = warn0; }
    A.eq(err && err.message, null, 'a failing snapshot never blocks the write');
    A.eq(fs.existsSync(path.join(ROOT, 'cpd', 'b.txt')) ? fs.readFileSync(path.join(ROOT, 'cpd', 'b.txt'), 'utf8') : null, 'two', 'the write lands after a failed snapshot');
    A.eq((failopen.counts()['runpaths.checkpoint'] || 0) - before, 1, 'the failed snapshot leaves a runpaths.checkpoint note (fail-open, never silent)');
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  A.report('checkpoint-default-on.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
