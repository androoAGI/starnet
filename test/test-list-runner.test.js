'use strict';
/* node test/test-list-runner.test.js — the gate runner (scripts/run-test-list.mjs) and the lists it reads.

   Manifest checks: every list parses, has no duplicate, and references only files that exist.
   Runner behaviour, driven through runList() with tiny fixture steps in a temp dir:
     R1 run-all    — a red step no longer hides the steps after it; every failure is named with its step number;
                     the run still exits non-zero and its LAST line is not the green summary.
     R2 timeout    — a hung step is killed at its bound together with the grandchild it spawned, is named by step
                     number and path, and the next step still runs.
     R3 slow list  — a step declared in the slow list gets the slow bound instead of the default one.
     R4 flaky      — a quarantined step that fails once IN ITS NAMED CASE is retried and reported in its own
                     section, and the gate stays green; one that fails twice turns the gate red; a failure outside
                     the named case, or a crash with no FAIL line, is never retried.
     R5 env        — ambient variables (provider keys, NODE_OPTIONS, STARNET_/SKYNET_ overrides, GIT_DIR) never
                     reach a step; PATH and the CI Chrome knob do; the hermetic profile beats the real APPDATA.
     R6 summary    — per-step timing lines, and a green run ends on the exact line release-preflight accepts.
     R7 shards     — K/N shards cover every step exactly once, in declared order.
     R8 interrupt  — a SIGINT during a step ends the run non-green (130, an INTERRUPTED last line release-preflight
                     rejects) and no later step starts — including when the step it lands on exits 0 by itself.
     R9 deadline   — past --deadline the current step is cut off, no later step starts, and the run still ends on a
                     failure list and an OUT OF TIME last line (not the outer wrapper's kill with no summary). */

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
    // a quarantined fixture's output is captured; keep its planted FAIL lines out of this test's own log
    const quiet = { write() { return true; } };
    const code = await runner.runList(Object.assign({ label: 'fixture', slowList: none, flakyList: none, log: l => lines.push(l), stdout: quiet, stderr: quiet }, opts));
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

    // R4 flaky quarantine, scoped to the named case
    const counter = path.join(dir, 'flaky.count');
    const flakyOnce = step('flaky-once.js',
      'const fs = require("fs"); const n = fs.existsSync(' + lit(counter) + ') ? Number(fs.readFileSync(' + lit(counter) + ', "utf8")) : 0;\n' +
      'fs.writeFileSync(' + lit(counter) + ', String(n + 1)); if (n === 0) { console.log("FAIL: Q3 precondition: raced"); console.log("FAIL: Q3: then this"); process.exit(1); }');
    const counter2 = path.join(dir, 'flaky2.count');
    const flakyTwice = step('flaky-twice.js',
      'const fs = require("fs"); const n = fs.existsSync(' + lit(counter2) + ') ? Number(fs.readFileSync(' + lit(counter2) + ', "utf8")) : 0;\n' +
      'fs.writeFileSync(' + lit(counter2) + ', String(n + 1)); console.log("FAIL: Q3: raced again"); process.exit(2);');
    const counter3 = path.join(dir, 'flaky3.count');
    const realBug = step('flaky-real-bug.js',
      'const fs = require("fs"); const n = fs.existsSync(' + lit(counter3) + ') ? Number(fs.readFileSync(' + lit(counter3) + ', "utf8")) : 0;\n' +
      'fs.writeFileSync(' + lit(counter3) + ', String(n + 1)); console.log("FAIL: Q3: the flaky case"); console.log("FAIL: S1: a real regression"); process.exit(1);');
    const flakyList = list('flaky.list', [flakyOnce + ' | Q3', flakyTwice + ' | Q3', realBug + ' | Q3', red + ' | Q3', pass1]);
    const r4 = await run({ listFile: list('r4a.list', [flakyOnce]), flakyList });
    A.eq(r4.code, 0, 'R4: a quarantined step that fails in its named case and passes on retry keeps the run green');
    A.eq(Number(fs.readFileSync(counter, 'utf8')), 2, 'R4: the quarantined step ran exactly twice');
    A.ok(/quarantined flaky steps that failed at least once/.test(r4.text) && /first attempt exit 1, passed on retry/.test(r4.text), 'R4: the retry is reported in its own section');
    A.eq(r4.last, 'fixture: OK — 1 step(s) green', 'R4: and the run still ends green');
    const r4b = await run({ listFile: list('r4b.list', [flakyTwice]), flakyList });
    A.eq(r4b.code, 2, 'R4: a quarantined step that fails twice turns the run red');
    A.eq(Number(fs.readFileSync(counter2, 'utf8')), 2, 'R4: (it was retried once)');
    A.ok(/retry exit 2 \(counted as a failure\)/.test(r4b.text) && r4b.text.includes('FAILED at step 1/1'), 'R4: and is reported as a failure');
    const r4c = await run({ listFile: list('r4c.list', [red]) });
    A.ok(!/retrying once/.test(r4c.text), 'R4: a step not on the flaky list is never retried');
    const r4d = await run({ listFile: list('r4d.list', [realBug]), flakyList });
    A.eq(r4d.code, 1, 'R4: a quarantined file that fails OUTSIDE its named case turns the run red');
    A.eq(Number(fs.readFileSync(counter3, 'utf8')), 1, 'R4: and is never retried (a real regression cannot pass on a second try)');
    A.ok(r4d.text.includes('failed outside its flaking case — not retried: FAIL: S1: a real regression'), 'R4: the line outside the case is named');
    const r4e = await run({ listFile: list('r4e.list', [red]), flakyList });
    A.eq(r4e.code, 3, 'R4: a quarantined step that crashes with no FAIL line turns the run red');
    A.ok(/not retried: it printed no FAIL line/.test(r4e.text) && !/retrying once/.test(r4e.text), 'R4: and is never retried');
    const r4f = await run({ listFile: list('r4f.list', [pass1]), flakyList });
    A.ok(r4f.text.includes('flaky list entry ' + pass1 + ' names no flaking case — it is NOT quarantined'), 'R4: an entry with no case is called out, not silently quarantined');
    A.eq(runner.flakyCaseMatch(['FAIL: stt 403: x', 'FAIL: stt degrade: y'], ['stt 403:', 'stt degrade:']).retry, true, 'R4: every FAIL line inside the cases → retry');
    A.eq(runner.flakyCaseMatch(['FAIL: stt 403: x', 'FAIL: harness threw — boom'], ['stt 403:']).retry, false, 'R4: one FAIL line outside → no retry');
    A.eq(runner.flakyCaseMatch([], ['stt 403:']).retry, false, 'R4: no FAIL line → no retry');
    A.eq(runner.flakyCaseMatch(['FAIL: Q3: x'], []).retry, false, 'R4: no case named → no retry');
    A.eq([...runner.parseFlakyEntries(['test/a.js | Q3 | Q4 ', 'test/b.js'])], [['test/a.js', ['Q3', 'Q4']], ['test/b.js', []]], 'R4: flaky entries parse into a step and its cases');
    const realFlaky = runner.parseFlakyEntries(runner.readSteps(path.join(__dirname, 'flaky.list')));
    A.ok(realFlaky.size > 0 && [...realFlaky.values()].every(cases => cases.length > 0), 'R4: every entry of test/flaky.list names its flaking case(s)');

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

    // R8 interrupt: never green, never another step — also when the interrupted step exits 0 by itself
    const asGate = text => (text + '\n').replace(/^fixture:/gm, 'run-fast-tests:');
    const hardExits = [];
    for (const [name, exitsAt, signalAt] of [['killed mid-step', 1500, 300], ['lands as the step exits 0', 700, 690]]) {
      const tag = name.replace(/\W+/g, '-');
      const marks = [1, 2, 3].map(n => path.join(dir, 'int-' + tag + '-' + n));
      const s1 = step('int-' + tag + '-1.js', 'require("fs").writeFileSync(' + lit(marks[0]) + ', "x"); setTimeout(() => process.exit(0), ' + exitsAt + ');');
      const s2 = step('int-' + tag + '-2.js', 'require("fs").writeFileSync(' + lit(marks[1]) + ', "x");');
      const s3 = step('int-' + tag + '-3.js', 'require("fs").writeFileSync(' + lit(marks[2]) + ', "x");');
      const timer = setTimeout(() => process.emit('SIGINT', 'SIGINT'), signalAt);
      const r8 = await run({ listFile: list('r8-' + tag + '.list', [s1, s2, s3]), exit: code => hardExits.push(code) });
      clearTimeout(timer);
      A.eq(r8.code, 130, 'R8 (' + name + '): an interrupted run exits 130');
      A.ok(/^fixture: INTERRUPTED by SIGINT — ran [01] of 3 step\(s\)/.test(r8.last), 'R8 (' + name + '): the last line says INTERRUPTED (' + r8.last + ')');
      A.ok(!r8.text.includes('OK —'), 'R8 (' + name + '): no green line anywhere');
      A.ok(!preflight.parseGateLog(asGate(r8.text)).ok, 'R8 (' + name + '): release-preflight does not read it as a green gate');
      A.ok(fs.existsSync(marks[0]) && !fs.existsSync(marks[1]) && !fs.existsSync(marks[2]), 'R8 (' + name + '): no step after the interrupted one started');
      A.eq(process.listenerCount('SIGINT'), 0, 'R8 (' + name + '): the run removed its signal handler');
    }
    await new Promise(r => setTimeout(r, 200));
    A.eq(hardExits, [], 'R8: the killed step reported its exit, so the hard-exit fallback never fired');

    // R9 run deadline
    const longStep = step('long.js', 'setTimeout(() => {}, 20000);');
    const never = step('never.js', 'require("fs").writeFileSync(' + lit(mark(9)) + ', "x");');
    const t9 = Date.now();
    const r9 = await run({ listFile: list('r9.list', [longStep, never]), deadlineMs: 1500, stepTimeoutMs: 20000 });
    A.eq(r9.code, 124, 'R9: a run cut short by its deadline exits 124');
    A.ok(Date.now() - t9 < 15000, 'R9: the step was cut off at the deadline, not at its own 20 s bound');
    A.ok(r9.text.includes('fixture: step 1/2 reached the run deadline after 1.5s — killing its process tree: node ' + longStep), 'R9: the cut names the step');
    A.ok(r9.text.includes('fixture: FAILED at step 1/2: node ' + longStep + ' (stopped at the run deadline after 1.5s)'), 'R9: the failure list still prints');
    A.ok(/^fixture: OUT OF TIME — the 0m02s run deadline passed after 1 of 2 step\(s\), 1 failed; not a green run$/.test(r9.last), 'R9: the last line says OUT OF TIME (' + r9.last + ')');
    A.ok(!fs.existsSync(mark(9)), 'R9: no step starts after the deadline');
    A.ok(!preflight.parseGateLog(asGate(r9.text)).ok, 'R9: release-preflight does not read it as green');
    A.eq(runner.parseArgs(['test/http.list', '--deadline=3420000', '--shard=2/4']).deadlineMs, 3420000, 'R9: --deadline parses');
    A.throws(() => runner.parseArgs(['test/http.list', '--deadline=soon']), 'R9: a malformed --deadline is rejected');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    for (const [outer, inner] of [['test:fast', 'test:fast:raw'], ['test:http', 'test:http:raw']]) {
      const wrapper = Number((/--timeout=(\d+)/.exec(pkg[outer]) || [])[1]);
      const deadline = Number((/--deadline=(\d+)/.exec(pkg[inner]) || [])[1]);
      A.ok(deadline > 0 && wrapper - deadline >= 120000, 'R9: ' + inner + ' stops at least 2 min inside the ' + outer + ' wrapper, so its summary prints (' + deadline + ' vs ' + wrapper + ')');
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('test-list-runner.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
