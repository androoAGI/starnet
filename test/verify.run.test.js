/* node test/verify.run.test.js — the verify.run tool (execution-spine Commit 4), with REAL subprocesses.
   A passing check verdicts PASS; a failing one verdicts FAIL (a non-zero exit is a verdict, not a thrown error);
   the floor refuses escapes; no-cmd + no-package.json is an actionable error; verify.result fires with the
   verdict. Spawns processes → rides test:http, not the fast gate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeVerifyTool } = require('../sidecar/tools/builtin/verify.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-vr-'));
  fs.mkdirSync(path.join(root, 'a1'), { recursive: true });
  const events = [];
  const checkpoints = [];
  const tool = makeVerifyTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: (s) => s }).verifyTool;
  const ctx = {
    agentId: 'a1', runId: 'r1', emit: (n, p) => events.push({ name: n, payload: p }),
    checkpointMutation: async (candidate, label, opts) => checkpoints.push({ candidate, label, opts })
  };

  try {
    // ---- a passing check -> PASSED verdict + verify.result{passed:true} ----
    const ok = await tool.run({ cmd: 'echo tests ok && exit 0' }, ctx);
    A.ok(/✓ PASSED/.test(ok.content), 'a zero-exit check verdicts PASSED');
    A.ok(/verify passed/.test(ok.summary), 'summary says passed');
    const okEv = events.find(e => e.name === 'verify.result');
    A.ok(okEv && okEv.payload.passed === true, 'verify.result emitted with passed:true');
    A.ok(okEv.payload.added === 0 && okEv.payload.removed === 0, 'test-runner path reports a zero diagnostics delta');
    A.eq(checkpoints.length, 1, 'verify waits for a pre-execution checkpoint');
    A.eq(path.resolve(checkpoints[0].candidate), path.resolve(root, 'a1'), 'verify checkpoints the effective project cwd');
    A.eq(checkpoints[0].opts.always, true, 'verify preserves the always-checkpoint execution safety coupling');

    const tinyTool = makeVerifyTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: s => s, limits: { maxBytes: 8 } }).verifyTool;
    const capped = await tinyTool.run({ cmd: 'echo complete-verification-output' }, ctx);
    A.ok(/output truncated/.test(capped.content), 'verify preview stays bounded');
    A.ok(/complete-verification-output/.test(capped.fullContent), 'the complete verification output is recoverable without rerunning the check');

    // ---- a failing check -> FAILED verdict (a non-zero exit is a verdict, not a thrown tool error) ----
    events.length = 0;
    const bad = await tool.run({ cmd: 'exit 1' }, ctx);
    A.ok(/✗ FAILED/.test(bad.content), 'a non-zero check verdicts FAILED');
    A.ok(events.some(e => e.name === 'verify.result' && e.payload.passed === false), 'verify.result emitted with passed:false');

    // ---- the floor + actionable errors (sync throws) ----
    A.throws(() => tool.run({ cmd: 'cat ../secret' }, ctx), 'an escaping check command is refused');
    A.throws(() => tool.run({}, ctx), 'no cmd + no package.json -> actionable error');

    // ---- auto-detect: a package.json makes a bare verify.run use "npm test" (here a passing stub) ----
    fs.writeFileSync(path.join(root, 'a1', 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'exit 0' } }));
    const auto = await tool.run({ timeoutMs: 60000 }, ctx);
    A.ok(/PASSED|FAILED/.test(auto.content), 'a bare verify.run auto-detects + runs the project check');

    // The verify shortcut must enforce the same input-isolation floor as shell.exec. Otherwise
    // `verify.run npm run smoke` bypasses the shell guard and can acquire Win32 pointer lock.
    fs.mkdirSync(path.join(root, 'a1', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'a1', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a1', 'src', 'game.js'), 'canvas.requestPointerLock();\n');
    fs.writeFileSync(path.join(root, 'a1', 'scripts', 'smoke.mjs'), "import puppeteer from 'puppeteer-core';\n");
    fs.writeFileSync(path.join(root, 'a1', 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'exit 0', smoke: 'node scripts/smoke.mjs' } }));
    A.throws(() => tool.run({ cmd: 'npm run smoke' }, ctx), 'verify.run refuses browser automation that can reach native pointer lock');

    // verify.run is not a privileged alternate shell: every user-control/machine-state floor
    // from shell.exec is shared through commandSafetyRisk and runs before process creation.
    A.throws(() => tool.run({ cmd: 'shutdown /s /t 0' }, ctx), 'verify.run refuses shutdown');
    A.throws(() => tool.run({ cmd: 'start notepad' }, ctx), 'verify.run refuses visible desktop apps');
    A.throws(() => tool.run({ cmd: 'powershell -Command "Start-Process notepad"' }, ctx), 'verify.run refuses indirect desktop launchers');
    A.throws(() => tool.run({ cmd: 'python -c "import ctypes; ctypes.windll.user32.BlockInput(True)"' }, ctx), 'verify.run refuses input blocking APIs');
    A.throws(() => tool.run({ cmd: 'vite --host 0.0.0.0' }, ctx), 'verify.run refuses all-interface listeners');

    // A local shell can cd into a nested package. Safety inspection must follow the
    // actual execution cwd rather than scanning only the agent workspace root.
    const nested = path.join(root, 'a1', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(nested, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'scripts', 'smoke.mjs'), "import puppeteer from 'puppeteer-core';\n");
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({
      name: 'unsafe-nested', scripts: { test: 'node scripts/smoke.mjs' }
    }));
    // (run-paths review M5) The run's `cd` lives on its path object (ctx.paths.setShellCwd), not in environment.getCwd, so
    // the nested folder is reached the way a real run reaches it — and the fake has every method verify.run calls, so the
    // refusal asserted below is the user-control floor's, never a TypeError from a missing fake method.
    let nestedExecCalls = 0;
    const nestedEnv = {
      backendId: 'local',
      ensureWorkspace: () => path.join(root, 'a1'),
      getCwd: () => path.join(root, 'a1'),
      workspaceRoot: () => path.join(root, 'a1'),
      execute: () => { nestedExecCalls++; return Promise.resolve({ exitCode: 0, out: '', ms: 0 }); }
    };
    const nestedTool = makeVerifyTool({ fs, pathMod: path, root, environment: nestedEnv }).verifyTool;
    const RunPaths = require('../sidecar/run-paths.js');
    const nestedPaths = RunPaths.makeRunPaths(RunPaths.makeResolver({ pathMod: path, root, environment: nestedEnv }), { agentId: 'a1' });
    nestedPaths.setShellCwd(nested);
    let nestedErr = null;
    try { nestedTool.run({ cmd: 'npm test' }, { ...ctx, paths: nestedPaths }); } catch (e) { nestedErr = e; }
    A.ok(nestedErr && /refused \[user-control\]/.test(nestedErr.message), 'verify.run scans the nested project that will execute (refused [user-control]): ' + (nestedErr && nestedErr.message));
    A.eq(nestedExecCalls, 0, 'unsafe nested verification is refused before process creation');

    const project = path.join(root, 'a1', 'selected-project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
    let selectedCwd;
    const scoped = makeVerifyTool({ fs, pathMod: path, root, environment: {
      backendId: 'local', getCwd: () => path.join(root, 'a1'), ensureWorkspace: () => path.join(root, 'a1'),
      execute: o => { selectedCwd = o.cwd; return Promise.resolve({ exitCode: 0, out: 'selected project passed', ms: 1 }); }
    } }).verifyTool;
    const selected = await scoped.run({}, { ...ctx, projectRoot: project });
    A.eq(selectedCwd, project, 'registered project controls default command lookup and execution');
    A.ok(selected.content.includes('PASSED'), 'project verification passes without an explicit shell cwd workaround');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('verify.run.test');
})().catch(e => { console.log('FAIL: verify.run.test threw — ' + (e && e.stack || e)); process.exit(1); });
