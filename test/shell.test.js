/* node test/shell.test.js — the WORKBENCH capability shell.exec (execution-spine Commit 3), with REAL subprocesses.

   Drives the actual tool against a real temp workspace: a command runs in the jail cwd and returns combined
   output + exit code; a non-zero exit is a RESULT (not a thrown tool error); the best-effort floor refuses
   obvious workspace escapes; the per-call timeout AND an abort signal both KILL the child; output is capped;
   the shell.exec telemetry rung carries the exit code. Spawns processes → rides test:http, not the fast gate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

const SLEEP = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 > NUL' : 'sleep 5';
// A KILLED command (timeout / abort) is an ERROR since the h1 audit (2026-09-22): tool.run REJECTS with the partial
// output + the [exit -1 — KILLED …] receipt in the message and a toolSummary naming the cause. Resolve to that error.
const killedBy = (p) => p.then(r => { throw new Error('expected a killed command to reject, got: ' + (r && r.summary)); }, e => e);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sh-'));
  const events = [];
  const shell = makeShellTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: (s) => s });
  const tool = shell.execTool;
  const ctx = (extra) => Object.assign({ agentId: 'a1', runId: 'r1', callId: 'c1', emit: (n, p) => events.push({ name: n, payload: p }) }, extra || {});

  try {
    // ---- 1. echo: exit 0 + the output comes back, and runs in the jail cwd ----
    const r1 = await tool.run({ cmd: 'echo starnet-shell-ok' }, ctx());
    A.ok(/starnet-shell-ok/.test(r1.content), 'stdout returned');
    A.ok(/\[exit 0/.test(r1.content), 'exit 0 noted in the content');
    A.ok(/exit 0/.test(r1.summary), 'summary names the exit code');

    // ---- 2. a non-zero exit is a RESULT, not a thrown tool error ----
    const r2 = await tool.run({ cmd: 'exit 3' }, ctx());
    A.ok(/\[exit 3/.test(r2.content), 'non-zero exit captured (3)');

    // ---- 3. the shell.exec telemetry rung fired with the exit code ----
    const ev = events.find(e => e.name === 'shell.exec');
    A.ok(ev && ev.payload.exitCode === 0, 'shell.exec event carries exitCode');
    A.ok(ev.payload.cwd === 'a1' && ev.payload.callId === 'c1', 'shell.exec event carries the jail label + callId (no abs path)');

    // ---- 4. the escape floor refuses obvious workspace escapes (sync throw) ----
    A.throws(() => tool.run({ cmd: 'type ..\\secret.txt' }, ctx()), 'parent (..) path refused');
    A.throws(() => tool.run({ cmd: 'cat C:\\Windows\\system32\\drivers\\etc\\hosts' }, ctx()), 'drive-absolute path refused');
    A.throws(() => tool.run({ cmd: 'cat .checkpoints/index.json' }, ctx()), 'protected control file refused');
    A.throws(() => tool.run({ cmd: '   ' }, ctx()), 'empty command refused');
    // the floor does NOT trip on git range syntax (main..HEAD) — only `..` as a path segment
    A.eq(shell._internals.escapesWorkspace('git log main..HEAD'), null, 'git range main..HEAD is NOT a floor escape');
    A.ok(shell._internals.escapesWorkspace('cat ../x') !== null, '../x IS a floor escape');
    // Windows drive-ROOT-relative (backslash-rooted, no drive letter) escapes are refused...
    A.ok(shell._internals.escapesWorkspace('type \\Users\\andro\\secret.txt') !== null, 'drive-root \\Users path IS a floor escape');
    A.ok(shell._internals.escapesWorkspace('cd \\') !== null, 'bare cd \\ (drive root) IS a floor escape');
    A.ok(shell._internals.escapesWorkspace('dir \\Windows') !== null, 'drive-root \\Windows IS a floor escape');
    // ...but option slashes and in-workspace relative backslash paths are NOT blocked (no false positives)
    A.eq(shell._internals.escapesWorkspace('robocopy src dst /S /E'), null, 'robocopy /S /E option slashes are NOT a floor escape');
    A.eq(shell._internals.escapesWorkspace('type subdir\\file.txt'), null, 'in-workspace relative backslash path is NOT a floor escape');
    A.eq(shell._internals.escapesWorkspace('mkdir foo\\bar'), null, 'relative mkdir foo\\bar is NOT a floor escape');
    A.throws(() => tool.run({ cmd: 'type \\Users\\andro\\hosts' }, ctx()), 'drive-root path refused by the tool');

    // FILES BEFORE THE SHELL (2026-10-25): a path refusal names the file tools as the way in ONLY when the host says this
    // run carries them (ctx.fileToolsOnWire), and the cwd route only where cwd may leave the workspace (the local backend)
    const refusalOf = (t, args, c) => { try { t.run(args, c); } catch (e) { return String(e && e.message); } return ''; };
    const plainRefusal = refusalOf(tool, { cmd: 'type C:\\proj\\notes.md' }, ctx());
    A.ok(/^refused: drive-absolute/.test(plainRefusal) && !/fs_read/.test(plainRefusal), 'no file tools on the wire: the refusal never names a tool the run lacks');
    const hinted = refusalOf(tool, { cmd: 'type C:\\proj\\notes.md' }, ctx({ fileToolsOnWire: true }));
    A.ok(/call fs_read \/ fs_list \/ fs_search with the full path instead/.test(hinted), 'file tools on the wire: the refusal names them as the way in');
    A.ok(!/as cwd/.test(hinted), 'no execution environment: cwd cannot leave the jail, so the cwd route is not offered');
    A.ok(/fs_read/.test(refusalOf(tool, { cmd: 'type ..\\notes.md' }, ctx({ fileToolsOnWire: true }))), 'a parent-directory refusal names the file tools too');
    A.ok(!/fs_read/.test(refusalOf(tool, { cmd: 'cat .checkpoints/index.json' }, ctx({ fileToolsOnWire: true }))), 'a protected-file refusal never points at the file tools');
    const localTool = makeShellTool({ environment: { backendIdFor: () => 'local', refusalFor: () => null } }).execTool;
    const localRefusal = refusalOf(localTool, { cmd: 'powershell -NoProfile -Command "Get-Content \'C:\\proj\\notes.md\'"' }, ctx({ fileToolsOnWire: true }));
    A.ok(/fs_read/.test(localRefusal) && /pass that folder as cwd/.test(localRefusal), 'local backend: the refusal names the file tools and the cwd route');

    // The paired Telegram owner is the person sitting at the machine: their shell may deliberately use a host
    // directory outside the agent workspace. Ordinary calls above remain jailed and screened.
    const checkpointRoots = [];
    const remote = await tool.run({ cmd: 'echo remote-owner-host-shell', cwd: root }, ctx({
      ownerTrusted: true, remoteDesktopAuthorized: true, inputMode: 'remote-owner', surface: 'interactive',
      checkpointMutation: async (candidate, label, opts) => checkpointRoots.push({ candidate, label, opts })
    }));
    A.ok(/remote-owner-host-shell/.test(remote.content), 'remote-owner shell runs from an explicit host directory');
    A.eq(checkpointRoots.length, 1, 'shell waits for one pre-execution checkpoint');
    A.eq(path.resolve(checkpointRoots[0].candidate), path.resolve(root), 'shell checkpoints the effective host cwd');
    A.eq(checkpointRoots[0].opts.always, true, 'shell execution keeps the always-checkpoint safety coupling');

    // ---- 5. output cap: a tiny maxBytes truncates ----
    const small = makeShellTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), limits: { maxBytes: 5 } }).execTool;
    const r5 = await small.run({ cmd: 'echo hello world this is long' }, ctx());
    A.ok(/truncated/.test(r5.content), 'oversized output truncated');
    A.ok(/hello world this is long/.test(r5.fullContent), 'the full shell bytes survive the intrinsic preview ceiling');
    A.ok(/\[exit 0\]$/.test(r5.fullContent), 'the recoverable shell artifact includes the real terminal exit receipt');

    /* ---- 5b. ANSI STRIP (ref-parity). npm/git/cargo/pytest emit colour whenever they think a TTY is
       attached, and the model reads the control bytes as tokens — '[32m' is billed content meaning
       "green" to nobody. Driven through a REAL child process so this proves the actual pipe, not a helper. ---- */
    const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
    /* Driven through a REAL child process reading a REAL file, so this proves the actual pipe rather than a
       helper in isolation. `type` rather than a `node -e` one-liner on purpose: the shell floor refuses
       commands that launch a native runtime, and a backslash in the command string trips the UNC-path guard —
       both would fail the test for reasons having nothing to do with ANSI. */
    // shell.exec runs in the AGENT's jail (root/<agentId>), not the root itself — `type` resolves relative
    // to that cwd, so the fixture has to land there.
    fs.mkdirSync(path.join(root, 'a1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a1', 'ansi.txt'),
      ESC + '[32mBUILD OK' + ESC + '[0m' + '\n' +
      ESC + ']0;window title' + BEL + ESC + '[2KPROGRESS' + ESC + '[1A' + '\n' +
      'array[32m] and a [0m literal' + '\n');
    const rAnsi = await tool.run({ cmd: (process.platform === 'win32' ? 'type' : 'cat') + ' ansi.txt' }, ctx());
    A.ok(rAnsi.content.indexOf('BUILD OK') >= 0, 'the actual text survives the strip');
    A.ok(rAnsi.content.indexOf(ESC) < 0, 'no raw ESC byte reaches the model');
    A.ok(!/\[32m\b|\[0m\b/.test(rAnsi.content.split('array')[0]), 'the colour codes are gone, not just the ESC');
    A.ok(rAnsi.content.indexOf('PROGRESS') >= 0, 'text between an OSC title and a cursor move survives');
    A.ok(rAnsi.content.indexOf('window title') < 0, 'the OSC payload is stripped, not left behind as prose');
    // Text that merely LOOKS like an escape must be left alone — eating real output would be worse than
    // leaving colour in.
    A.ok(rAnsi.content.indexOf('array[32m] and a [0m literal') >= 0, 'bracket text with no real ESC is NOT stripped');

    // ---- 6. the per-call timeout KILLS the child ----
    const t0 = Date.now();
    const r6 = await killedBy(tool.run({ cmd: SLEEP, timeoutMs: 600 }, ctx()));
    A.ok(/timed out/.test(r6.message) && r6.toolSummary === 'timeout', 'a slow command is killed on timeout (and reported as an error)');
    A.ok(Date.now() - t0 < 4500, 'timeout fired well before the 5s sleep would finish');

    // ---- 7. an abort signal KILLS the child ----
    const ac = new AbortController();
    const tA = Date.now();
    const p7 = tool.run({ cmd: SLEEP, timeoutMs: 10000 }, ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 200);
    const r7 = await killedBy(p7);
    A.ok(/aborted|\[exit -1/.test(r7.message) && r7.toolSummary === 'cancelled', 'aborted command is killed (and reported as cancelled)');
    A.ok(Date.now() - tA < 4500, 'abort fired well before the sleep would finish');

    // ---- 8. the timeout CEILING is 10 min by default, config-bounded, and `timeout_ms` is an accepted spelling ----
    A.eq(tool.timeoutMs, 600000 + 10000, 'the registry backstop sits 10s above the 600s default ceiling');
    const t8 = Date.now();
    const r8 = await killedBy(tool.run({ cmd: SLEEP, timeout_ms: 1200 }, ctx()));
    A.ok(/timed out after 1200ms/.test(r8.message) && Date.now() - t8 < 4500, 'timeout_ms (snake_case) drives the same kill — got ' + String(r8.message).slice(-80));
    const bounded = makeShellTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), limits: { maxTimeoutMs: 1500 } }).execTool;
    A.eq(bounded.timeoutMs, 1500 + 10000, 'limits.maxTimeoutMs bounds the registry backstop too');
    const t9 = Date.now();
    const r9 = await killedBy(bounded.run({ cmd: SLEEP, timeoutMs: 999999 }, ctx()));
    A.ok(/timed out after 1500ms/.test(r9.message) && Date.now() - t9 < 4500, 'a timeoutMs above the configured ceiling is clamped to it, never honoured');
    A.ok(/requested 999999ms is above the 1500ms ceiling/.test(r9.message), 'the clamp is stated, not silent');
    A.ok(/max 10 min/.test(tool.description) && tool.schema.properties.timeout_ms, 'the model-facing description + schema advertise the new ceiling and alias');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('shell.test');
})().catch(e => { console.log('FAIL: shell.test threw — ' + (e && e.stack || e)); process.exit(1); });
