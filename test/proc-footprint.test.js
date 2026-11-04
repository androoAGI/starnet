/* node test/proc-footprint.test.js — the attribution + validity rules of the whole-app idle measurement
   (scripts/lib/proc-footprint.mjs, 2026-10-20). The process table is copied from the shapes on the box the tools were
   built on: StarNet's tree beside SearchHost's and GoogleDriveFS's own WebView2 trees, which a name filter charged to
   StarNet. Also pins the PowerShell sampler to the same thresholds/patterns (it cannot import the module). */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const F = await import('../scripts/lib/proc-footprint.mjs');
  const T0 = '2026-10-20T08:00:00.000Z', later = s => new Date(Date.parse(T0) + s * 1000).toISOString();
  const WV = 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\155.0.4283.62\\msedgewebview2.exe';
  const UDD = '--user-data-dir="C:\\Users\\u\\AppData\\Local\\ai.skynet.harness\\EBWebView"';
  const rows = [
    { pid: 100, ppid: 4, name: 'skynet-desktop.exe', cmd: '"C:\\Users\\u\\AppData\\Local\\StarNet\\skynet-desktop.exe"', created: T0 },
    { pid: 101, ppid: 100, name: 'msedgewebview2.exe', cmd: `"${WV}" --embedded-browser-webview=1 --webview-exe-name=skynet-desktop.exe ${UDD} --noerrdialogs`, created: later(1) },
    { pid: 102, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=gpu-process --noerrdialogs ${UDD} --gpu-preferences=UAAAAAAAAADgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAA`, created: later(2) },
    { pid: 103, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=renderer --noerrdialogs ${UDD} --renderer-client-id=5`, created: later(2) },
    { pid: 104, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US ${UDD}`, created: later(2) },
    { pid: 105, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=crashpad-handler ${UDD} /prefetch:4`, created: later(2) },
    { pid: 110, ppid: 100, name: 'node.exe', cmd: '"C:\\Users\\u\\AppData\\Local\\StarNet\\node.exe" "C:\\Users\\u\\AppData\\Local\\StarNet\\sidecar\\index.js"', created: later(1) },
    { pid: 111, ppid: 110, name: 'node.exe', cmd: 'node.exe C:\\mcp\\server.js', created: later(5) },
    { pid: 112, ppid: 110, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c "git status"', created: later(6) },
    { pid: 200, ppid: 4, name: 'SearchHost.exe', cmd: 'SearchHost.exe -ServerName:CortanaUI.AppX', created: T0 },
    { pid: 300, ppid: 4, name: 'GoogleDriveFS.exe', cmd: '"C:\\Program Files\\Google\\Drive File Stream\\GoogleDriveFS.exe"', created: T0 },
  ];
  // the two foreign WebView2 trees, same exe name, same shapes, different user-data-dirs
  for (const [root, base, udd] of [[200, 201, 'C:\\Users\\u\\AppData\\Local\\Packages\\MicrosoftWindows.Client.CBS\\LocalState\\EBWebView'], [300, 301, 'C:\\Users\\u\\AppData\\Local\\Google\\DriveFS\\cef']]) {
    rows.push({ pid: base, ppid: root, name: 'msedgewebview2.exe', cmd: `"${WV}" --user-data-dir="${udd}"`, created: later(1) });
    ['gpu-process', 'renderer', 'renderer', 'utility --utility-sub-type=network.mojom.NetworkService', 'crashpad-handler'].forEach((t, i) =>
      rows.push({ pid: base + 1 + i, ppid: base, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=${t} --user-data-dir="${udd}"`, created: later(2) }));
  }

  // 1. the walk from the app's own pid: exactly StarNet's processes, none of the 2xx / 3xx WebView2 trees
  const tree = F.walkTree(rows, [100]);
  assert.deepEqual(tree.map(r => r.pid).sort((a, b) => a - b), [100, 101, 102, 103, 104, 105, 110, 111, 112]);
  assert.ok(!tree.some(r => r.pid >= 200), 'no foreign msedgewebview2 is charged to StarNet');
  assert.equal(rows.filter(r => r.name === 'msedgewebview2.exe').length, 17, 'a name filter would have charged 17 webview processes, 5 of them StarNet\'s');
  // pid reuse: an orphan whose dead parent's pid was handed to a NEWER process is not that process's child
  const reused = rows.concat([{ pid: 500, ppid: 110, name: 'old.exe', cmd: 'old.exe', created: '2026-10-19T00:00:00.000Z' }]);
  assert.ok(!F.walkTree(reused, [100]).some(r => r.pid === 500), 'a child born before its "parent" is a pid-reuse orphan');
  assert.deepEqual(F.walkTree(rows, [999]), [], 'a root that is not running walks nothing');
  assert.deepEqual(F.walkTree(rows, [102, 110]).map(r => r.pid).sort((a, b) => a - b), [102, 110, 111, 112], 'several roots');

  // 2. roles
  const role = pid => { const r = rows.find(x => x.pid === pid); return F.roleOf(r.name, r.cmd, { root: pid === 100 }); };
  assert.deepEqual([100, 101, 102, 103, 104, 105, 110, 111, 112].map(role),
    ['host', 'web-browser', 'web-gpu', 'web-renderer', 'web-util:network', 'web-crashpad', 'sidecar', 'node-child', 'shell']);
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --type=utility --utility-sub-type=storage.mojom.StorageService'), 'web-util:storage');
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --remote-debugging-port=9 --user-data-dir=C:\\x'), 'web-browser', 'the bench\'s Edge root is a browser, not a host');
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --type=gpu-process', { root: true }), 'web-gpu', 'a web process stays a web process at the root');
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --type=ppapi'), 'web-other:ppapi');
  assert.equal(F.roleOf('node.exe', 'node /repo/sidecar/index.js --idle-ab-run=x'), 'sidecar', 'forward slashes');
  assert.equal(F.roleOf('WerFault.exe', 'WerFault.exe -u'), 'other:werfault');

  // 3. the EBWebView identity check
  assert.equal(F.webviewIdentity(rows[1]).ok, true, 'the app\'s own browser child');
  const foreign = F.webviewIdentity(rows.find(r => r.pid === 201));
  assert.equal(foreign.ok, false, 'a browser child with a foreign user-data-dir is rejected');
  assert.match(foreign.reason, /ai\.skynet\.harness/);
  assert.equal(F.webviewIdentity(rows[1], { identifier: 'ai.skynet.harness.idlebench' }).ok, false, 'an isolated idlebench build must not match Andrew\'s identifier');
  const ovr = { cmd: 'msedgewebview2.exe --user-data-dir=D:\\scratch\\wv\\EBWebView' };
  assert.equal(F.webviewIdentity(ovr, { identifier: '', userDataFolder: 'D:/scratch/wv' }).ok, true, 'WEBVIEW2_USER_DATA_FOLDER override (+EBWebView leaf)');
  assert.equal(F.webviewIdentity({ cmd: 'msedgewebview2.exe' }).ok, false, 'no user-data-dir at all');

  // 4. GPU % = Task Manager's rule: per (adapter, engine type) sum, then the busiest type
  const L = 'luid_0x00000000_0x0000d1c2_phys_0';
  const g = F.gpuPct([
    { instance: `pid_102_${L}_eng_0_engtype_3D`, value: 12.5 },
    { instance: `pid_102_${L}_eng_7_engtype_3D`, value: 3.0 },
    { instance: `pid_102_${L}_eng_3_engtype_Copy`, value: 4 },
  ]);
  assert.equal(g.pct, 15.5);
  assert.equal(g.busiest, '0x00000000_0x0000d1c2|3d');
  const twoCards = F.gpuPct([
    { instance: 'pid_102_luid_0x00000000_0x0000d1c2_phys_0_eng_0_engtype_3D', value: 10 },
    { instance: 'pid_102_luid_0x00000000_0x00012ab0_phys_0_eng_0_engtype_3D', value: 9 },
  ]);
  assert.equal(twoCards.pct, 10, 'a 3D engine on one adapter never adds to the other adapter\'s');
  const byPid = F.gpuPctByPid([{ instance: `pid_102_${L}_eng_0_engtype_3D`, value: 7 }, { instance: `pid_201_${L}_eng_0_engtype_3D`, value: 50 }]);
  assert.equal(byPid[102].pct, 7); assert.equal(byPid[201].pct, 50);
  const mem = F.gpuMemByPid([{ instance: `pid_102_${L}`, path: '\\\\box\\gpu process memory(pid_102_' + L + ')\\dedicated usage', value: 23.5 * 1048576 },
    { instance: `pid_102_${L}`, path: '\\\\box\\gpu process memory(pid_102_' + L + ')\\shared usage', value: 2 * 1048576 }]);
  assert.deepEqual(mem[102], { dedicatedMB: 23.5, sharedMB: 2 });
  assert.equal(F.parseGpuInstance('not_a_gpu_instance'), null);

  // 5. CPU of one core
  assert.equal(F.cpuPctOneCore(30000, 60000), 50);
  assert.equal(F.cpuPctOneCore(5, 0), null);

  // 6. contention: the gate's 87.7% system CPU, or 0.26 GB free, is not a measurement
  assert.equal(F.preflight({ systemCpuPct: 87.7, cores: 16, freeGB: 8 }).contended, true);
  assert.equal(F.preflight({ systemCpuPct: 3, cores: 16, freeGB: 0.26 }).contended, true);
  const calm = F.preflight({ systemCpuPct: 9, treeCpuPctOneCore: 160, cores: 16, freeGB: 9 });
  assert.equal(calm.contended, false, 'our own tree is taken back out of the system CPU');
  assert.equal(calm.outsideCpuPct, -1);
  assert.equal(F.preflight({ systemCpuPct: 30, treeCpuPctOneCore: 160, cores: 16, freeGB: 9 }).contended, false, '30% system - 10% ours = 20%: the line itself is not over it');
  assert.equal(F.preflight({ systemCpuPct: 31, treeCpuPctOneCore: 160, cores: 16, freeGB: 9 }).contended, true, '31% - 10% ours = 21% outside: contended');
  assert.equal(F.preflight({ systemCpuPct: 5, cores: 16, freeGB: 9, forced: 'test gate running' }).contended, true, 'the operator can mark a run contended');

  // 7. a phase is labelled by what the page REPORTED, never by what the bench asked for
  const ok = { hasFocus: true, visibilityState: 'visible', vsyncMs: 1000 / 239.76, cameraMode: 'manual' };
  assert.equal(F.phaseValidity({ focus: 'focused', visibility: 'visible', hz: 239.76, camera: 'manual' }, ok).valid, true);
  const lie = F.phaseValidity({ focus: 'focused' }, { ...ok, hasFocus: false });
  assert.equal(lie.valid, false, 'focused with hasFocus false is INVALID');
  assert.match(lie.reasons[0], /hasFocus\(\) is false/);
  assert.equal(F.phaseValidity({ focus: 'focused' }, { ...ok, focusEmulated: true }).label, 'focused(emulated)');
  assert.equal(F.phaseValidity({ focus: 'unfocused' }, ok).valid, false, 'unfocused with hasFocus true is INVALID');
  assert.equal(F.phaseValidity({ focus: 'focused' }, [ok, { ...ok, hasFocus: false }]).valid, false, 'every observation must pass (window start and end)');
  assert.equal(F.phaseValidity({ hz: 239.76 }, { ...ok, vsyncMs: 1000 / 144 }).valid, false, 'a 144 Hz reading on the 239 Hz pass is INVALID');
  assert.equal(F.phaseValidity({ hz: 239 }, { ...ok, vsyncMs: 1000 / 239.76 }).valid, true, 'the integer Hz Windows reports is within 3%');
  assert.equal(F.phaseValidity({ visibility: 'hidden' }, ok).valid, false, 'a minimized phase must read hidden');
  assert.equal(F.phaseValidity({ camera: 'manual' }, { ...ok, cameraMode: 'auto' }).valid, false, 'the cinecam drifted the pinned camera');
  // 7b. THE STILL PACE (world.js, 2026-10-21) books rAF from a timer ~30x a second: the passive probe reads the TIMER's gaps
  // (33.3 ms on 60 Hz, 34.7 on 144, 33.4 on 239.76), never the panel's. Such an observation says why, and is not hz-checked —
  // reported in `skipped`, never silent. One that does not say why is still judged (a 30 Hz reading on a 60 Hz pass is INVALID).
  const stillObs = { ...ok, vsyncMs: 1000 / 30, hzExempt: 'the still pace is timer-booked' };
  const sv = F.phaseValidity({ focus: 'focused', hz: 60 }, [stillObs, { ...stillObs, vsyncMs: 1000 / 28.8 }]);
  assert.equal(sv.valid, true, 'a still-pace observation is not judged on the probe\'s timer-gap Hz');
  assert.deepEqual(sv.skipped, ['hz not checked: the still pace is timer-booked'], '...and the skip is reported');
  assert.equal(F.phaseValidity({ hz: 60 }, { ...ok, vsyncMs: 1000 / 30 }).valid, false, 'a 30 Hz reading without a reason stays INVALID');
  assert.equal(F.phaseValidity({ hz: 60 }, [stillObs, { ...ok, vsyncMs: 1000 / 144 }]).valid, false, 'an exempt observation never excuses the other one');
  // the still pace's draw rate: the timer fires 2 ms early, the draw lands on the first vsync at/past pace - 2
  assert.equal(F.expectedDraws(1000 / 30, 1000 / 60, 'still'), 30, 'still on 60 Hz: 30 draws/s');
  assert.equal(F.expectedDraws(1000 / 30, 1000 / 144, 'still'), 28.8, 'still on 144 Hz: 28.8 draws/s (5 vsyncs)');
  assert.equal(F.expectedDraws(1000 / 30, 1000 / 239.76, 'still'), 30, 'still on 239.76 Hz: 30.0 draws/s (8 vsyncs)');
  assert.equal(F.expectedDraws(1000 / 30, 0, 'still'), 30, 'still with no vsync known: 1000 / pace');
  assert.equal(F.expectedDraws(1000 / 60, 1000 / 144), 72, 'the visible pace keeps its half-vsync rule (60 on 144 Hz rounds to every 2nd vsync)');
  // a window's still share and what kept it moving, from renderPace's cumulative counters
  const sw = F.stillWindow({ draws: 100, stillFrames: 40, stillWhyCounts: { body: 10 } }, { draws: 400, stillFrames: 280, stillWhyCounts: { body: 50, sky: 20 } });
  assert.deepEqual(sw, { share: 0.8, draws: 300, why: { body: 40, sky: 20 } }, '240 of 300 draws still; the rest were a body (40) and the sky (20)');
  assert.equal(F.stillWindow({ draws: 5 }, { draws: 9 }), null, 'a world without the counters reports no still window');

  // 8. the verdict rule
  assert.equal(F.verdict([10, 11, 12], [5, 6, 7]).verdict, 'IMPROVED');
  assert.equal(F.verdict([10, 11, 12], [5, 6, 10.5]).verdict, 'NO VERDICT', 'overlapping ranges');
  assert.equal(F.verdict([10, 11], [5, 6]).verdict, 'NO VERDICT', 'n<3');
  assert.equal(F.verdict([10, 11, 12], [5, 6, 7], { contended: true }).verdict, 'NO VERDICT', 'a contended run');
  assert.equal(F.verdict([10, 11, 12], [13, 14, 15]).verdict, 'WORSE');
  assert.equal(F.verdict([10, 11, 12], [13, 14, 15], { lowerIsBetter: false }).verdict, 'IMPROVED');
  assert.deepEqual(F.stats([3, 1, 2, 10]), { n: 4, median: 2.5, min: 1, max: 10, mean: 4, p95: 10 });
  assert.equal(F.crossCheck(50, 46).ok, true); assert.equal(F.crossCheck(50, 40).ok, false); assert.equal(F.crossCheck(0.4, 1.5).ok, true, 'noise floor');

  // 9. summarize by role
  const sum = F.summarize([{ role: 'web-renderer', cpuPctOneCore: 30, privMB: 200 }, { role: 'web-renderer', cpuPctOneCore: 1, privMB: 50 }, { role: 'sidecar', cpuPctOneCore: 4, privMB: 120 }]);
  assert.deepEqual(sum.byRole['web-renderer'], { n: 2, cpuPctOneCore: 31, privMB: 250, wsMB: 0, gpuPct: 0, gpuDedMB: 0 });
  assert.equal(sum.total.cpuPctOneCore, 35); assert.equal(sum.total.privMB, 370);

  // 10. the hermetic sidecar env never carries the real profile or a provider key
  const base = { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\andro', APPDATA: 'C:\\Users\\andro\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\andro\\AppData\\Local',
    SKYNET_OPENROUTER_KEY: 'sk-or-real', ANTHROPIC_API_KEY: 'sk-ant-real', NODE_OPTIONS: '--require evil.js', HERMES_HOME: 'C:\\Users\\andro\\.hermes' };
  const runDir = path.join('C:', 'tmp', 'run1');
  const { env, dirs } = F.hermeticEnv({ baseEnv: base, runDir, ws: path.join(runDir, 'ws'), port: 41234 });
  for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TEMP', 'TMP', 'HERMES_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SKYNET_WORKSPACES', 'STARNET_WORKSPACES'])
    assert.ok(env[k].startsWith(runDir), k + ' lives inside the run dir (' + env[k] + ')');
  for (const k of ['SKYNET_OPENROUTER_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(env[k], undefined, k + ' never reaches the bench sidecar');
  assert.equal(env.PATH, 'C:\\bin'); assert.equal(env.SKYNET_DEV, '1'); assert.equal(env.STARNET_DEV, '1');
  assert.equal(env.SKYNET_PORT, '41234'); assert.equal(env.SKYNET_LIVE_PRICES, '0'); assert.equal(env.SKYNET_OPENROUTER_BASE, 'http://127.0.0.1:9/');
  assert.equal(dirs.length, 4); assert.ok(dirs.every(d => d.startsWith(runDir)));

  // 11. the PowerShell sampler keeps the same rules (it cannot import this module)
  const ps1 = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'perf', 'app-footprint.ps1'), 'utf8');
  assert.match(ps1, /\$ContendedCpuPct\s*=\s*20\b/); assert.match(ps1, /\$ContendedFreeGB\s*=\s*4\b/);
  for (const s of ['gpu-process', 'renderer', 'crashpad-handler', 'utility-sub-type', 'sidecar[\\\\/]+index\\.js', "'host'", 'PrivateMemorySize64', 'ParentProcessId'])
    assert.ok(ps1.includes(s), 'app-footprint.ps1 still carries ' + s);
  assert.ok(!/Stop-Process|taskkill|SetForegroundWindow|SetWindowPos/i.test(ps1.replace(/^\s*#.*$/gm, '')), 'the sampler is observe-only: no kill, no focus, no resize');

  // 12. the bench never loads a real profile or kills by name
  const bench = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'perf-idle-ab.mjs'), 'utf8');
  assert.ok(bench.includes('hermeticEnv(') && !/\.\.\.process\.env/.test(bench), 'the bench sidecar env is hermetic (never spreads process.env)');
  assert.ok(!/taskkill[^\n]*\/IM/i.test(bench) && !/Stop-Process\s+-Name/i.test(bench), 'teardown is by recorded pid, never by image name');
  assert.ok(!/getImageData|captureScreenshot/.test(bench), 'no screenshot or getImageData inside the bench');
  // 13. the bench can prove the still tier: a still observation is hz-exempt (with its reason), every row carries its still
  // window, and a still AB slice is expected from the world's vsync on the timer rule
  assert.ok(/hzExempt: s\.pace\.mode === 'still' \?/.test(bench), 'an observation taken at the still pace says why its Hz cannot be read');
  assert.ok(/still: F\.stillWindow\(/.test(bench), 'every measured window records its still share and what kept it moving');
  assert.ok(/F\.expectedDraws\(pace, mode === 'still' \? \(row\.worldVsyncHz/.test(bench), "a still AB slice is expected from the world's own vsync");
  assert.ok(/checksSkipped: v\.skipped/.test(bench), 'a skipped check is reported on the row');

  // 14. THE IDLE BUDGET (the world-idle-renderer lane: "an idle station costs close to nothing, without lowering the visible frame
  // rate"; done means the idle main thread is at most 15%). P7 judges itself with one pure verdict over its row: main thread, rAF
  // callbacks per draw, draws a second, crew settled, still share. A contended, invalid or unmeasured window is 'unjudged', never a pass.
  assert.ok(F.IDLE_BUDGET && ['idleBudgetVerdict', 'idleBudgetLine', 'pacerWindow'].every(n => typeof F[n] === 'function'), 'proc-footprint exports the P7 idle budget: IDLE_BUDGET, idleBudgetVerdict, idleBudgetLine and pacerWindow');
  assert.deepEqual(JSON.parse(JSON.stringify(F.IDLE_BUDGET)), { mainBusyPct: 15, rafPerDraw: 1.25, drawsPerS: [28, 32], stillShare: 0.95 }, 'the budget is the plan\'s five numbers: loosening one is a decision, not drift');
  const p7 = { phase: 'P7', valid: true, contended: false, mainBusyPct: 9.4, drawsPerS: 30.2, rafPerS: 36.8, rafPerDraw: 1.22, worldRafPerDraw: 1.0, skippedFrames: 0,
    still: { share: 0.99, draws: 1812, why: { blink: 12 } }, obs: [{ crewSettled: 6 }, { crewSettled: 6 }] };
  const p7Before = JSON.stringify(p7);
  const good = F.idleBudgetVerdict(p7);
  assert.equal(good.verdict, 'pass', 'a quiet, valid, uncontended window inside the budget passes');
  assert.deepEqual(good.checks.map(c => [c.name, c.ok]), [['mainBusyPct', true], ['rafPerDraw', true], ['drawsPerS', true], ['crewSettled', true], ['stillShare', true]], 'five checks, each judged');
  assert.deepEqual(good.reasons, [], 'a pass carries no reasons');
  assert.equal(JSON.stringify(p7), p7Before, 'the verdict is pure: the row is not touched');
  // each line, one at a time: only that check fails, and the reason names it and the number it wanted
  const failsOn = (over, name, want) => {
    const r = F.idleBudgetVerdict({ ...p7, ...over });
    assert.equal(r.verdict, 'fail', name + ' ' + JSON.stringify(over) + ' fails the budget');
    assert.deepEqual(r.checks.filter(c => c.ok === false).map(c => c.name), [name], 'only ' + name + ' fails');
    assert.ok(r.reasons.length === 1 && r.reasons[0].includes(name) && r.reasons[0].includes(want), 'the reason names ' + name + ' and what it wanted (' + r.reasons + ')');
  };
  failsOn({ mainBusyPct: 15.01 }, 'mainBusyPct', '<= 15%');
  failsOn({ worldRafPerDraw: 1.26 }, 'rafPerDraw', '<= 1.25');
  failsOn({ drawsPerS: 27.99 }, 'drawsPerS', '28-32');
  failsOn({ drawsPerS: 32.01 }, 'drawsPerS', '28-32');
  failsOn({ obs: [{ crewSettled: 6 }, { crewSettled: 0 }] }, 'crewSettled', '> 0');
  failsOn({ obs: [{ crewSettled: 0 }, { crewSettled: 6 }] }, 'crewSettled', '> 0');
  failsOn({ still: { share: 0.949, draws: 1812, why: { body: 92 } } }, 'stillShare', '>= 95%');
  // the lines themselves are inclusive, except "settled" which wants at least one body
  for (const edge of [{ mainBusyPct: 15 }, { worldRafPerDraw: 1.25 }, { drawsPerS: 28 }, { drawsPerS: 32 }, { still: { share: 0.95, draws: 100, why: {} } }, { obs: [{ crewSettled: 1 }, { crewSettled: 1 }] }])
    assert.equal(F.idleBudgetVerdict({ ...p7, ...edge }).verdict, 'pass', 'the line itself is inside the budget: ' + JSON.stringify(edge));
  // the rAF line judges the WORLD's own callbacks when the tree counts them (the crew clock's rides are another module's), else the page's
  const pageOnly = { ...p7, worldRafPerDraw: null, skippedFrames: null };
  assert.equal(F.idleBudgetVerdict({ ...pageOnly, rafPerDraw: 1.9 }).verdict, 'fail', 'a tree that does not count its skipped callbacks is judged on the page-wide rAF per draw (the base spin reads 3)');
  assert.equal(F.idleBudgetVerdict({ ...p7, rafPerDraw: 1.9, worldRafPerDraw: 1.0 }).verdict, 'pass', 'page-wide rAF the world does not own (crewcards.js rides) is not the world\'s spin');
  assert.equal(F.idleBudgetVerdict(p7).checks[1].note, 'world', '...and the check says which reading it judged');
  assert.equal(F.idleBudgetVerdict(pageOnly).checks[1].note, 'page');
  // NEVER A PASS without evidence: contended, invalid, validity unknown, no row, or a line that was not measured
  const unjudged = (row, re, why) => { const r = F.idleBudgetVerdict(row); assert.equal(r.verdict, 'unjudged', why); assert.ok(re.test(r.reasons.join(' | ')), why + ' (' + r.reasons + ')'); return r; };
  unjudged({ ...p7, contended: true, contendedWhy: ['system CPU outside the measured tree 41% > 20%'] }, /contended.*41%/, 'a contended box gives no verdict');
  unjudged({ ...p7, contended: true, mainBusyPct: 80 }, /contended/, 'a contended box is unjudged even when its numbers fail: a busy box\'s numbers are not evidence either way');
  unjudged({ ...p7, valid: false, invalidWhy: ['cinecam rested is false, want true'] }, /not valid.*rested is false/, 'an invalid phase gives no verdict');
  unjudged({ ...p7, valid: false, mainBusyPct: 80 }, /not valid/, 'an invalid phase is unjudged even when its numbers fail');
  unjudged({ ...p7, valid: undefined }, /validity/, 'a row that never said it was valid is not judged');
  unjudged({ ...p7, contended: undefined }, /contended/, 'a row that never said it was uncontended is not judged');
  unjudged(null, /not valid|no row/, 'no row, no verdict');
  unjudged({ ...p7, still: null }, /stillShare was not measured/, 'a window with no still readout cannot pass the still line');
  unjudged({ ...p7, obs: [{ crewSettled: 6 }, { crewSettled: null }] }, /crewSettled was not measured/, 'a tree that does not report its settled crew cannot pass the settle line');
  unjudged({ ...p7, mainBusyPct: null }, /mainBusyPct was not measured/, 'a missing reading is not a pass');
  unjudged({ ...p7, worldRafPerDraw: null, rafPerDraw: null }, /rafPerDraw was not measured/, 'no rAF reading at all is not a pass');
  assert.equal(F.idleBudgetVerdict({ ...p7, still: null, mainBusyPct: 16 }).verdict, 'fail', 'one line that is measured and over the budget is a fail, whatever else is missing');
  // the row the bench builds: pacerWindow turns two page reads into the readouts the verdict wants
  const sA = { draws: 1000, raf: { fired: 5000 }, pace: { skippedFrames: 7, dueDraws: 100, dueLate: 1 } };
  const sB = { draws: 1900, raf: { fired: 6180 }, pace: { skippedFrames: 25, dueDraws: 600, dueLate: 4 } };
  const pw = F.pacerWindow(sA, sB);
  assert.deepEqual(pw, { draws: 900, rafFired: 1180, rafPerDraw: 1.31, skippedFrames: 18, worldRafPerDraw: 1.02, dueDraws: 500, dueLate: 3 }, '900 draws drew from 1180 page callbacks (1.31 a draw), 18 of them the world\'s own skips (1.02 a draw), 3 of 500 due changes late');
  assert.equal(F.idleBudgetVerdict({ ...p7, rafPerDraw: pw.rafPerDraw, worldRafPerDraw: pw.worldRafPerDraw, skippedFrames: pw.skippedFrames }).verdict, 'pass', 'that window is inside the rAF line on the world\'s own count (the page-wide 1.31 alone would not be)');
  const old = F.pacerWindow({ draws: 10, raf: { fired: 10 }, pace: {} }, { draws: 70, raf: { fired: 190 }, pace: {} });
  assert.deepEqual(old, { draws: 60, rafFired: 180, rafPerDraw: 3, skippedFrames: null, worldRafPerDraw: null, dueDraws: null, dueLate: null }, 'a tree without the counters reports the page-wide figure only (the base spin: 3 a draw), the rest null');
  assert.equal(F.pacerWindow(sB, sB), null, 'no draws in the window, no readout');
  assert.equal(F.pacerWindow({ draws: 1 }, { draws: 9 }), null, 'a page state without the rAF probe reports nothing');
  assert.equal(F.pacerWindow(null, sB), null);
  // the one line the bench prints for P7: the verdict, then every reading with what it wanted when it failed
  const line = (row, over) => F.idleBudgetLine(F.idleBudgetVerdict({ ...row, ...over }));
  assert.match(line(p7), /^PASS :: mainBusyPct 9\.4, rafPerDraw 1, drawsPerS 30\.2, crewSettled 6, stillShare 0\.99$/, 'a pass prints its five readings');
  assert.match(line(p7, { mainBusyPct: 16.2 }), /^FAIL :: mainBusyPct 16\.2 \(want <= 15%\), rafPerDraw 1,/, 'a fail names the reading and its line');
  assert.match(line(p7, { contended: true, contendedWhy: ['forced: test gate'] }), /^UNJUDGED :: .* :: the box was contended: forced: test gate$/, 'an unjudged window says why');
  assert.match(line(p7, { still: null }), /stillShare n\/a/, 'a reading that was not taken prints n/a, not undefined');

  console.log('proc-footprint: tree walk from the app pid (no foreign webview, pid reuse refused), roles, EBWebView identity, GPU% per adapter+type, contention, phase labels, verdict, hermetic env, sampler/bench locks, the P7 idle-budget verdict — OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
