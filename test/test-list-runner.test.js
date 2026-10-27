'use strict';
/* node test/test-list-runner.test.js — the gate runner (scripts/run-test-list.mjs) and the lists it reads.

   Manifest checks: every list parses, has no duplicate, and references only files that exist.
   Runner behaviour, driven through runList() with tiny fixture steps in a temp dir:
     R1 run-all    — a red step no longer hides the steps after it; every failure is named with its step number;
                     the run still exits non-zero and its LAST line is not the green summary.
     R2 timeout    — a hung step is killed at its bound together with the grandchild it spawned, is named by step
                     number and path, and the next step still runs.
     R3 slow list  — a step declared in the slow list gets the slow bound instead of the default one.
     R4 flaky      — a quarantined step that fails once is retried and reported in its own section, and the gate
                     stays green; one that fails twice turns the gate red.
     R5 env        — ambient variables (provider keys, NODE_OPTIONS, STARNET_/SKYNET_ overrides, GIT_DIR) never
                     reach a step; PATH and the CI Chrome knob do; the hermetic profile beats the real APPDATA.
     R6 summary    — per-step timing lines, and a green run ends on the exact line release-preflight accepts.
     R7 shards     — K/N shards cover every step exactly once, in declared order. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

(async () => {
  const runner = await import(pathToFileURL(path.join(root, 'scripts', 'run-test-list.mjs')).href);
  const preflight = await import(pathToFileURL(path.join(root, 'scripts', 'release-preflight.mjs')).href);
  for (const name of ['fast.list', 'http.list']) {
    const steps = runner.readSteps(path.join(__dirname, name));
    A.ok(steps.length > 0, name + ' contains runnable steps');
    A.eq(new Set(steps).size, steps.length, name + ' contains no duplicate suite');
    A.ok(steps.every(step => fs.existsSync(path.join(root, step))), name + ' references only existing files');
  }
  const http = runner.readSteps(path.join(__dirname, 'http.list'));
  A.eq(http[0], 'test/provider-recovery.e2e.test.js', 'provider production-composition proof is part of the HTTP manifest');
  A.ok(http.includes('test/sidecar.http.test.js') && http.includes('test/openai-compat.e2e.test.js'), 'HTTP manifest retains route coverage');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-runner-test-'));
  const lit = p => JSON.stringify(p);
  const step = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, "'use strict';\n" + body + '\n'); return p; };
  const list = (name, steps) => { const p = path.join(dir, name); fs.writeFileSync(p, '# fixture\n' + steps.join('\n') + '\n'); return p; };
  const none = path.join(dir, 'none.list');
  fs.writeFileSync(none, '# nothing\n');
  const run = async (opts) => {
    const lines = [];
    const code = await runner.runList(Object.assign({ label: 'fixture', slowList: none, flakyList: none, log: l => lines.push(l) }, opts));
    return { code, lines, text: lines.join('\n'), last: lines[lines.length - 1] || '' };
  };
  try {
    // R1 run-all
    const mark = n => path.join(dir, 'ran-' + n);
    const pass1 = step('pass1.js', 'require("fs").writeFileSync(' + lit(mark(1)) + ', "x");');
    const red = step('red.js', 'process.exit(3);');
    const pass2 = step('pass2.js', 'require("fs").writeFileSync(' + lit(mark(2)) + ', "x");');
    const red2 = step('red2.js', 'process.exitCode = 1;');
    const r1 = await run({ listFile: list('r1.list', [pass1, red, pass2, red2]) });
    A.eq(r1.code, 3, 'R1: the run exits with the first failing step\'s code');
    A.ok(fs.existsSync(mark(1)) && fs.existsSync(mark(2)), 'R1: the steps after a red step still ran');
    A.ok(r1.text.includes('fixture: FAILED at step 2/4: node ' + red + ' (exit 3)'), 'R1: the first failure is named with its step number');
    A.ok(r1.text.includes('fixture: FAILED at step 4/4: node ' + red2 + ' (exit 1)'), 'R1: the second failure is named too');
    A.eq(r1.last, 'fixture: FAILED — 2 of 4 step(s) failed', 'R1: the last line counts the failures');
    A.ok(!preflight.parseGateLog(r1.text).ok, 'R1: release-preflight does not read a red run as green');

    // R2 timeout, with a grandchild that would outlive a plain kill
    const pidFile = path.join(dir, 'grandchild.pid');
    const hang = step('hang.js',
      'const { spawn } = require("child_process");\n' +
      'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n' +
      'require("fs").writeFileSync(' + lit(pidFile) + ', String(g.pid));\n' +
      'setInterval(() => {}, 1000);');
    const after = step('after.js', 'require("fs").writeFileSync(' + lit(mark(3)) + ', "x");');
    const t0 = Date.now();
    const r2 = await run({ listFile: list('r2.list', [hang, after]), stepTimeoutMs: 2500 });
    const took = Date.now() - t0;
    A.eq(r2.code, 124, 'R2: a timed-out step turns the run red with code 124');
    A.ok(took < 30000, 'R2: the hung step was cut off at its bound, not left to hang (' + took + ' ms)');
    A.ok(r2.text.includes('fixture: step 1/2 TIMED OUT after 2.5s — killing its process tree: node ' + hang), 'R2: the timeout names the step as it fires');
    A.ok(r2.text.includes('fixture: FAILED at step 1/2: node ' + hang + ' (timed out after 2.5s)'), 'R2: the summary names the hung step and why');
    A.ok(fs.existsSync(mark(3)), 'R2: the step after the hung one still ran');
    const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) { gone = !alive(gpid); if (!gone) await new Promise(r => setTimeout(r, 100)); }
    A.ok(gpid > 0 && gone, 'R2: the hung step\'s grandchild process was killed with it');
    if (!gone) { try { process.kill(gpid); } catch (_) {} }

    // R3 slow list
    const sleepy = step('sleepy.js', 'setTimeout(() => {}, 2000);');
    const r3fast = await run({ listFile: list('r3a.list', [sleepy]), stepTimeoutMs: 1000, slowTimeoutMs: 20000 });
    A.eq(r3fast.code, 124, 'R3: a 2 s step is over a 1 s default bound');
    const r3 = await run({ listFile: list('r3b.list', [sleepy]), slowList: list('slow.list', [sleepy]), stepTimeoutMs: 1000, slowTimeoutMs: 20000 });
    A.eq(r3.code, 0, 'R3: the same step passes once it is declared slow');

    // R4 flaky quarantine
    const counter = path.join(dir, 'flaky.count');
    const flakyOnce = step('flaky-once.js',
      'const fs = require("fs"); const n = fs.existsSync(' + lit(counter) + ') ? Number(fs.readFileSync(' + lit(counter) + ', "utf8")) : 0;\n' +
      'fs.writeFileSync(' + lit(counter) + ', String(n + 1)); process.exit(n === 0 ? 1 : 0);');
    const flakyList = list('flaky.list', [flakyOnce, red]);
    const r4 = await run({ listFile: list('r4a.list', [flakyOnce]), flakyList });
    A.eq(r4.code, 0, 'R4: a quarantined step that passes on retry keeps the run green');
    A.eq(Number(fs.readFileSync(counter, 'utf8')), 2, 'R4: the quarantined step ran exactly twice');
    A.ok(/quarantined flaky steps that failed at least once/.test(r4.text) && /first attempt exit 1, passed on retry/.test(r4.text), 'R4: the retry is reported in its own section');
    A.eq(r4.last, 'fixture: OK — 1 step(s) green', 'R4: and the run still ends green');
    const r4b = await run({ listFile: list('r4b.list', [red]), flakyList });
    A.eq(r4b.code, 3, 'R4: a quarantined step that fails twice turns the run red');
    A.ok(/retry exit 3 \(counted as a failure\)/.test(r4b.text) && r4b.text.includes('FAILED at step 1/1'), 'R4: and is reported as a failure');
    const r4c = await run({ listFile: list('r4c.list', [red]) });
    A.ok(!/retrying once/.test(r4c.text), 'R4: a step not on the flaky list is never retried');

    // R5 environment allowlist + hermetic profile
    const envOut = path.join(dir, 'env.json');
    const envStep = step('env.js', 'require("fs").writeFileSync(' + lit(envOut) + ', JSON.stringify(process.env));');
    const realAppData = path.join(dir, 'REAL-APPDATA');
    const parentEnv = Object.assign({}, process.env, {
      OPENROUTER_API_KEY: 'sk-or-planted', ANTHROPIC_API_KEY: 'sk-ant-planted', NODE_OPTIONS: '--require=planted',
      STARNET_WORKSPACES: 'C:/real/station', SKYNET_WORKSPACES: 'C:/real/station', GIT_DIR: 'C:/elsewhere/.git',
      APPDATA: realAppData, LOCALAPPDATA: realAppData, XDG_DATA_HOME: realAppData, SKYNET_CHROME: '/usr/local/bin/ci-chrome', CI: 'true'
    });
    const r5 = await run({ listFile: list('r5.list', [envStep]), parentEnv });
    A.eq(r5.code, 0, 'R5: the env probe step ran');
    const seen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    const keys = Object.keys(seen).map(k => k.toUpperCase());
    for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'STARNET_WORKSPACES', 'SKYNET_WORKSPACES', 'GIT_DIR']) {
      A.ok(!keys.includes(k), 'R5: the ambient ' + k + ' never reaches a step');
    }
    A.ok(keys.includes('PATH'), 'R5: PATH reaches the step');
    A.eq(seen.SKYNET_CHROME, '/usr/local/bin/ci-chrome', 'R5: the CI Chrome wrapper reaches the step');
    A.eq(seen.CI, 'true', 'R5: CI reaches the step');
    for (const k of ['APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME']) {
      A.ok(seen[k] && seen[k] !== realAppData && /starnet-gate-profile-/.test(seen[k]), 'R5: ' + k + ' is the hermetic profile, never the real one');
    }
    if (process.platform !== 'win32') A.ok(/starnet-gate-profile-/.test(seen.HOME || ''), 'R5: HOME is the hermetic profile on POSIX');
    const env = runner.buildStepEnv({ Path: 'C:/bin', ComSpec: 'cmd.exe', SystemRoot: 'C:/Windows', HOME: 'C:/Users/x', APPDATA: 'C:/real' }, 'C:/profile', 'win32');
    A.eq(env, { Path: 'C:/bin', ComSpec: 'cmd.exe', SystemRoot: 'C:/Windows', HOME: 'C:/Users/x', APPDATA: 'C:/profile', LOCALAPPDATA: 'C:/profile', XDG_DATA_HOME: 'C:/profile' },
      'R5: Windows keeps mixed-case spawn variables and the real HOME (git identity); the profile wins APPDATA');
    const posixEnv = runner.buildStepEnv({ PATH: '/bin', HOME: '/home/real' }, '/tmp/p', 'linux');
    A.eq(posixEnv.HOME, '/tmp/p', 'R5: POSIX HOME is the hermetic profile');

    // R6 per-step timing + the green summary release-preflight reads
    const r6 = await run({ listFile: list('r6.list', [pass1, pass2]) });
    A.eq(r6.code, 0, 'R6: an all-green run exits 0');
    A.ok(/^fixture: step 1\/2 ok \d+\.\ds — node /.test(r6.lines.find(l => l.startsWith('fixture: step 1/2')) || ''), 'R6: each step prints its time');
    A.ok(r6.lines.some(l => l === 'fixture: slowest steps:'), 'R6: the slowest steps are listed');
    const green = (r6.text + '\n').replace(/^fixture:/gm, 'run-fast-tests:');
    A.ok(preflight.parseGateLog(green).ok, 'R6: a green run ends on the summary line release-preflight accepts');

    // R7 shards
    const many = Array.from({ length: 11 }, (_, i) => 'test/s' + i + '.test.js');
    for (const total of [1, 2, 3, 4, 11, 12]) {
      const joined = [];
      for (let k = 1; k <= total; k++) joined.push(...runner.shardSteps(many, runner.parseShard(k + '/' + total)));
      A.eq(joined, many, 'R7: ' + total + ' shard(s) cover every step once, in order');
    }
    A.throws(() => runner.parseShard('0/4'), 'R7: shard 0 is rejected');
    A.throws(() => runner.parseShard('5/4'), 'R7: a shard past the total is rejected');
    A.throws(() => runner.parseShard('x'), 'R7: a malformed shard is rejected');
    const r7 = await run({ listFile: list('r7.list', [pass1, pass2, red]), shard: runner.parseShard('1/2') });
    A.eq(r7.code, 0, 'R7: shard 1/2 runs only its own slice');
    A.ok(r7.text.includes('fixture: shard 1/2 — 2 of 3 step(s)'), 'R7: the shard says which slice it ran');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('test-list-runner.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
