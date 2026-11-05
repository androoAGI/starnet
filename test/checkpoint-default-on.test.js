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
// the generic hook's condition moved into a const when its snapshot moved behind the registry gates (lane checkpoint-links;
// test/checkpoint-admission.test.js pins where it runs); the CHECKPOINTS_ENABLED key is the same expression
A.ok(/const genericCheckpoint = environmentCheckpoints && mutatesWorkspace\(c\.name\) && !preciseCheckpoint && \(CHECKPOINTS_ENABLED \|\| \/\^\(shell\|verify\)\\.\/\.test\(c\.name\)\);/.test(src), 'the generic pre-tool hook also keys off CHECKPOINTS_ENABLED');

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

    /* THE SNAPSHOT'S TIME IS THE HOST'S (2026-11-03). The snapshot ran inside fs.write's own 10 s timeout, so a cold shadow repo
       on a loaded machine (seven git spawns at 1-3 s each) spent all of it before a byte was written: the write failed "timed
       out, effect UNKNOWN" and never landed (e2e.worker-access and e2e.run-stream-pool under a gate's load, on trunk too).
       checkpointResolvedRoot holds the tool's timeout while the snapshot runs (tools/registry.js PAUSABLE DEADLINE). Driven
       through the real registry and the real fs.write, with its 10 s scaled down to TOOL_MS. */
    {
      const { makeRegistry } = require('../sidecar/tools/registry.js');
      const TOOL_MS = 400, SLOW_MS = 1200;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const read = rel => { const p = path.join(ROOT, 'cpd', rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
      const registryOf = tools => { const reg = makeRegistry(); reg.register(Object.assign({}, tools.writeTool, { timeoutMs: TOOL_MS })); return reg; };
      const write = (reg, rel, ctx) => reg.dispatch({ name: 'fs.write', args: { path: rel, content: 'held' }, id: 'w-' + rel }, Object.assign({ agentId: 'cpd', emit() {} }, ctx));

      let wroteDuringSnapshot = null;
      const slow = await write(registryOf(T), 'slow.txt', { checkpointMutation: async () => {
        await sleep(SLOW_MS); wroteDuringSnapshot = read('slow.txt') !== null; return { id: 'x', created: true };
      } });
      A.eq(slow && slow.ok, true, "a snapshot slower than fs.write's own timeout does not time the write out (" + String(slow && slow.content).slice(0, 90) + ')');
      A.eq(read('slow.txt'), 'held', 'the write lands after the slow snapshot');
      A.eq(wroteDuringSnapshot, false, 'the snapshot still finishes before a byte is written');

      // the hold is the snapshot's alone: after it the timeout runs again, and a write slower than its own timeout still times out
      const slowFsp = Object.assign({}, require('fs/promises'), { writeFile: async (...a) => { await sleep(SLOW_MS); return require('fs/promises').writeFile(...a); } });
      const late = await write(registryOf(makeFsTools({ fsp: slowFsp, pathMod: path, root: ROOT })), 'late.txt', { checkpointMutation: async () => null });
      A.ok(late && late.ok === false && /timed out after 400ms/.test(String(late.content)), "a write slower than its own timeout still times out after the snapshot's hold");
      await sleep(SLOW_MS);   // its late write settles before the next case and the cleanup

      // Stop reaches a tool whose timeout is held: the call ends within the cancel grace, and the write never lands late
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      const t0 = Date.now();
      const stopped = await write(registryOf(T), 'stopped.txt', { signal: ac.signal, cancelGraceMs: 100, checkpointMutation: async () => { await sleep(SLOW_MS); return null; } });
      const stopMs = Date.now() - t0;
      A.ok(stopped && stopped.ok === false && stopMs < SLOW_MS, 'Stop during a held snapshot ends the call without waiting for the snapshot (' + stopMs + ' ms)');
      await sleep(SLOW_MS);
      A.eq(read('stopped.txt'), null, 'the stopped write never lands late');

      // A stalled host snapshot cannot leave the deadline paused forever. Advance a fake clock instead of sleeping
      // through the two-minute host ceiling. The snapshot stays unresolved until AFTER dispatch has timed out.
      const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
      let now = 0, timerId = 0;
      const timers = new Map();
      const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
      const advance = async ms => {
        const end = now + ms;
        for (;;) {
          const next = Array.from(timers).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > end) break;
          now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
        }
        now = end; await flush();
      };
      global.setTimeout = (fn, ms, ...args) => { const id = ++timerId; timers.set(id, { at: now + Number(ms), fn: () => fn(...args) }); return id; };
      global.clearTimeout = id => timers.delete(id);
      let finishSnapshot;
      try {
        let enteredSnapshot;
        const entered = new Promise(r => { enteredSnapshot = r; });
        const snapshot = new Promise(r => { finishSnapshot = r; });
        const reg = makeRegistry({ clock: { now: () => now } });
        let finishedTool;
        const finished = new Promise(r => { finishedTool = r; });
        reg.register(Object.assign({}, T.writeTool, { timeoutMs: TOOL_MS, run: async (...args) => {
          try { return await T.writeTool.run(...args); } finally { finishedTool(); }
        } }));
        let result = null;
        const pendingWrite = write(reg, 'bounded.txt', { checkpointMutation: async () => { enteredSnapshot(); await snapshot; return null; } })
          .then(r => { result = r; return r; });
        await entered;
        await advance(120000);
        A.eq(result, null, 'the host ceiling resumes the write deadline without detaching its snapshot');
        A.eq(read('bounded.txt'), null, 'the unresolved snapshot still precedes the write');
        await advance(TOOL_MS + 1);
        A.ok(result && result.ok === false && /timed out/.test(String(result.content)), 'a stalled snapshot cannot hold the write past the host ceiling plus its own deadline');
        finishSnapshot();
        await pendingWrite;
        await finished;   // dispatch already settled at the timeout; wait for the real writer, not one event-loop turn
        A.eq(read('bounded.txt'), null, 'a snapshot settling after that deadline cannot cause a late write');
        A.eq(timers.size, 0, 'the checkpoint ceiling and tool deadline leave no timers behind');
      } finally {
        if (finishSnapshot) finishSnapshot();
        global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout;
      }
    }
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  A.report('checkpoint-default-on.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
