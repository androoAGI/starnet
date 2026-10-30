/* node test/output-capture.test.js — a command's full output is captured BOUNDED (head + tail), never unbounded.

   Before: shell.js runCommand and environment.js runProcess both did `fullOut += chunk` with no cap (the
   maxBytes check only guarded the preview `out`). A chatty build or a `cat` of a huge log grew one string until
   V8's max string length (~536M chars), where `+=` throws a RangeError inside the child's 'data' listener: an
   uncaughtException that exits the whole station with every run in flight. Below that, every byte was copied
   again by stripAnsi / parseMarker / redact.

   Laws under test:
     • under the cap the capture is byte-identical to plain concatenation;
     • over the cap it keeps the first quarter and the last three quarters, drops the middle, and NAMES how many
       characters it dropped; it never splits a surrogate pair;
     • both production routes (shell.js runCommand, environment.js runProcess) are bounded, and captureFullOut:false
       still captures nothing;
     • through a REAL shell, the exit-code/cwd marker (printed last) survives the cap, so a huge output still
       reports its real exit code and cwd. */
'use strict';
const A = require('./_assert.js');
const cp = require('child_process');
const { makeFullCapture, DEFAULT_FULL_OUT_MAX } = require('../sidecar/output-capture.js');
const { runCommand, buildMarkedCmd, parseMarker } = require('../sidecar/tools/builtin/shell.js');
const { runProcess } = require('../sidecar/environment.js');

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// A fake child that streams `chunks` then closes with `code`.
function streamingSpawn(chunks, code) {
  const spawn = function () {
    const h = {}, child = { pid: 777, stdout: { on: (ev, fn) => { if (ev === 'data') child._out = fn; } }, stderr: { on() {} },
      on: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); }, kill() {}, unref() {} };
    setImmediate(() => {
      for (const c of chunks) child._out(Buffer.from(c, 'utf8'));
      (h.exit || []).forEach(f => f(code));
      (h.close || []).forEach(f => f(code));
    });
    return child;
  };
  return spawn;
}

(async () => {
  // ---- 1. under the cap: identical to concatenation ----
  {
    const cap = makeFullCapture(1000);
    const parts = ['alpha ', 'beta\n', '', null, 'gamma'];
    for (const p of parts) cap.push(p);
    A.eq(cap.value(), 'alpha beta\ngamma', 'under the cap the value is exactly the concatenation');
    A.eq(cap.elided(), 0, 'nothing elided under the cap');
  }

  // ---- 2. over the cap: head quarter + tail three quarters, the drop is named exactly ----
  {
    const cap = makeFullCapture(100);
    let all = '';
    for (let i = 0; i < 50; i++) { const s = String(i).padStart(3, '0') + '|'; cap.push(s); all += s; }
    cap.push('<<END-MARKER>>'); all += '<<END-MARKER>>';
    const v = cap.value();
    A.eq(cap.elided(), all.length - 100, 'exactly (total - max) characters are dropped');
    A.ok(v.startsWith(all.slice(0, 25)), 'the first quarter is kept verbatim');
    A.ok(v.endsWith(all.slice(-75)), 'the last three quarters are kept verbatim (the marker printed last survives)');
    A.ok(v.includes('characters of output elided here') && v.includes(String(all.length - 100)), 'the elision is named in-band with its size');
  }

  // ---- 3. never splits a surrogate pair at either edge ----
  {
    const emoji = '\u{1F600}';   // 2 UTF-16 units
    for (let max = 8; max <= 40; max++) {
      const cap = makeFullCapture(max);
      for (let i = 0; i < 30; i++) cap.push(emoji + 'a');
      A.ok(!LONE_SURROGATE.test(cap.value()), 'no lone surrogate at max=' + max);
    }
  }

  // ---- 4. a huge stream stays bounded by the default cap ----
  {
    const cap = makeFullCapture();
    const chunk = 'x'.repeat(65536);
    for (let i = 0; i < 640; i++) cap.push(chunk);   // ~42M chars, 5x the cap
    const v = cap.value();
    A.ok(v.length <= DEFAULT_FULL_OUT_MAX + 200, 'the default capture is bounded (' + v.length + ' chars for ' + (640 * 65536) + ' pushed)');
    A.eq(cap.elided(), 640 * 65536 - DEFAULT_FULL_OUT_MAX, 'the default capture names its drop');
  }

  // ---- 5. shell.js runCommand is bounded ----
  {
    const chunks = Array.from({ length: 40 }, (_, i) => 'line-' + i + '-' + 'y'.repeat(100) + '\n');
    const res = await runCommand({ spawn: streamingSpawn(chunks, 0), cmd: 'big', cwd: '.', timeoutMs: 5000, isWin: true, maxBytes: 64, fullOutMax: 1000 });
    A.ok(res.truncated, 'runCommand: the preview is truncated');
    A.ok(res.fullOut.length < 1200 && res.fullOut.length > 900, 'runCommand: fullOut is bounded by fullOutMax (' + res.fullOut.length + ')');
    A.ok(res.fullOut.startsWith('line-0-') && res.fullOut.trimEnd().endsWith('line-39-' + 'y'.repeat(100)), 'runCommand: fullOut keeps the start and the very end');
  }

  // ---- 6. environment.js runProcess is bounded; captureFullOut:false still captures nothing ----
  {
    const chunks = Array.from({ length: 40 }, (_, i) => 'row-' + i + '-' + 'z'.repeat(100) + '\n');
    const res = await runProcess({ spawn: streamingSpawn(chunks, 0), file: 'big', args: null, spawnOptions: {}, timeoutMs: 5000, maxBytes: 64, isWin: true, fullOutMax: 1000 });
    A.ok(res.fullOut.length < 1200 && res.fullOut.length > 900, 'runProcess: fullOut is bounded by fullOutMax (' + res.fullOut.length + ')');
    A.ok(res.fullOut.trimEnd().endsWith('row-39-' + 'z'.repeat(100)), 'runProcess: fullOut keeps the very end');
    const off = await runProcess({ spawn: streamingSpawn(chunks, 0), file: 'big', args: null, spawnOptions: {}, timeoutMs: 5000, maxBytes: 64, isWin: true, captureFullOut: false });
    A.eq(off.fullOut, '', 'captureFullOut:false captures nothing');
  }

  // ---- 7. REAL shell: the exit-code/cwd marker survives a capped huge output ----
  {
    const isWin = process.platform === 'win32';
    const node = JSON.stringify(process.execPath);
    const cmd = node + ' -e "process.stdout.write(\'q\'.repeat(300000)); process.exitCode = 3"';
    const res = await runCommand({ spawn: cp.spawn, cmd: buildMarkedCmd(cmd, isWin), cwd: process.cwd(), timeoutMs: 60000, isWin, maxBytes: 1000, fullOutMax: 20000 });
    const pm = parseMarker(res.fullOut);
    A.ok(res.fullOut.length < 20500, 'real shell: fullOut is capped (' + res.fullOut.length + ' chars of ~300k)');
    A.eq(pm.ec, 3, 'real shell: the real exit code is recovered from the marker past the cap');
    A.ok(!!pm.cwd, 'real shell: the cwd is recovered from the marker past the cap');
  }

  // ---- 8. the drop is REPORTED: fullOutElided rides the result; 0 under the cap ----
  {
    const big = Array.from({ length: 40 }, (_, i) => 'line-' + i + '-' + 'y'.repeat(100) + '\n');
    const over = await runCommand({ spawn: streamingSpawn(big, 0), cmd: 'big', cwd: '.', timeoutMs: 5000, isWin: true, maxBytes: 64, fullOutMax: 1000 });
    A.ok(over.fullOutElided > 3000, 'runCommand reports how much it dropped (' + over.fullOutElided + ')');
    const under = await runProcess({ spawn: streamingSpawn(['small\n'], 0), file: 'x', args: null, spawnOptions: {}, timeoutMs: 5000, maxBytes: 64, isWin: true });
    A.eq(under.fullOutElided, 0, 'runProcess reports 0 when nothing was dropped');
  }

  // ---- 9. ANSI is stripped from head and tail SEPARATELY: an escape cut at the head's edge cannot eat the tail ----
  {
    const ESC = '\u001b', BEL = '\u0007';
    const chunks = ['a'.repeat(246), ESC + ']0;build 42%' + BEL, 'b'.repeat(2000), '\nTHE-END-MARKER\n'];
    const res = await runCommand({ spawn: streamingSpawn(chunks, 1), cmd: 'x', cwd: '.', timeoutMs: 5000, isWin: true, maxBytes: 64, fullOutMax: 1000 });
    A.ok(res.fullOut.includes('THE-END-MARKER'), 'the tail (and the exit marker in it) survives an OSC sequence cut at the head boundary');
    A.ok(!res.fullOut.includes(ESC), 'no escape byte leaks into fullOut');
  }

  // ---- 10. shell.exec (production environment route) says the middle is gone, and the registry receipt does too ----
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { makeEnvironmentManager } = require('../sidecar/environment.js');
    const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-fullout-'));
    try {
      const chunk = 'z'.repeat(65536) + '\n';
      const env = makeEnvironmentManager({ spawn: streamingSpawn(Array.from({ length: 140 }, () => chunk), 0), fs, pathMod: path, root, clock: { now: () => 0 }, env: {}, config: { backend: 'local' } });
      const tools = makeShellTool({ environment: env, fs, pathMod: path, root, clock: { now: () => 0 }, platform: 'win32' });
      const out = await tools.execTool.run({ cmd: 'type huge.log' }, { agentId: 'a' });
      A.ok(out.fullContentElided > 0, 'shell.exec hands the drop count to the registry (' + out.fullContentElided + ')');
      A.ok(/characters from the middle of the output were not kept\]/.test(out.content), 'the visible trailer says the middle was not kept');

      const reg = makeRegistry();
      reg.register({ impact: 'none', name: 'big', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'preview', fullContent: 'p'.repeat(90000), fullContentElided: 12345, summary: 'ok' }) });
      reg.register({ impact: 'none', name: 'whole', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'preview', fullContent: 'w'.repeat(90000), summary: 'ok' }) });
      const park = { parkOutput: async () => ({ path: '.output/x-1.txt' }) };
      const partial = await reg.dispatch({ name: 'big', args: {} }, park);
      A.ok(/partial-output receipt: 12345 characters from the MIDDLE of this output were not kept/.test(partial.content), 'an elided capture gets a PARTIAL receipt');
      A.ok(!/do not rerun the tool merely to recover output/.test(partial.content), 'and is never told a rerun cannot recover anything');
      const whole = await reg.dispatch({ name: 'whole', args: {} }, park);
      A.ok(whole.content.endsWith('[full-output receipt: 90000 characters / 90000 UTF-8 bytes before truncation; saved once to .output/x-1.txt. Read that file in ranges; do not rerun the tool merely to recover output.]'),
        'a whole capture keeps the byte-identical full-output receipt');
      A.eq(partial.outputElided, 12345, 'the registry result carries outputElided on to the loop and the run budget');
      A.ok(!('outputElided' in whole), 'a whole capture adds no outputElided field');

      // the HOST clamp (window-scaled) must not call the kept head + tail "the full output" either
      reg.register({ impact: 'none', name: 'bigpreview', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'v'.repeat(70000), fullContent: 'p'.repeat(90000), fullContentElided: 777, summary: 'ok' }) });
      const clamped = await reg.dispatch({ name: 'bigpreview', args: {} }, Object.assign({ outputMax: 20000 }, park));
      A.ok(/THE KEPT FIRST AND LAST PARTS OF THIS OUTPUT WERE SAVED to \.output\/x-1\.txt \(the command's own capture had already dropped 777 characters/.test(clamped.content), 'the host clamp note says only the first and last parts were saved');
      A.ok(!/THE FULL OUTPUT WAS SAVED/.test(clamped.content), 'the host clamp never says the full output was saved for an elided capture');
      reg.register({ impact: 'none', name: 'bigwhole', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'v'.repeat(70000), fullContent: 'p'.repeat(90000), summary: 'ok' }) });
      const clampedWhole = await reg.dispatch({ name: 'bigwhole', args: {} }, Object.assign({ outputMax: 20000 }, park));
      A.ok(/THE FULL OUTPUT WAS SAVED to \.output\/x-1\.txt — read that file/.test(clampedWhole.content), 'a whole capture keeps the original clamp note');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  }

  // ---- 11. the per-TURN squeeze and the per-RUN budget receipt say the same ----
  {
    const { _internals: L } = require('../sidecar/loop.js');
    const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
    const long = 'q'.repeat(5000);
    const sq = L.squeeze(long, 2000, '.output/x-1.txt', 9000);
    A.ok(/THE KEPT FIRST AND LAST PARTS OF THIS OUTPUT WERE SAVED to \.output\/x-1\.txt/.test(sq) && !/THE FULL OUTPUT OF THIS CALL WAS SAVED/.test(sq), 'the turn squeeze says only the first and last parts were saved');
    A.ok(/THE FULL OUTPUT OF THIS CALL WAS SAVED to \.output\/x-1\.txt/.test(L.squeeze(long, 2000, '.output/x-1.txt')), 'a whole capture keeps the original squeeze note');
    A.ok(/kept first and last parts saved to \.output\/x-1\.txt\]$/.test(L.squeeze(long, 150, '.output/x-1.txt', 9000)), 'the short squeeze marker says it too');
    A.ok(/full output saved to \.output\/x-1\.txt\]$/.test(L.squeeze(long, 150, '.output/x-1.txt')), 'and the short marker is unchanged for a whole capture');
    const st = makeRunExecutionState({});
    const base = { content: long, summary: 'exit 0', parkedPath: '.output/x-1.txt', outputChars: 8388700, outputBytes: 8388700 };
    const bounded = st.boundToolResult(Object.assign({ outputElided: 9000 }, base), 0);
    A.ok(/The kept first and last parts of this output \(8388700 characters/.test(bounded.content) && !/do not rerun it merely to recover output/.test(bounded.content), 'the run-budget receipt says only the first and last parts were saved');
    A.ok(/The full 8388700-character \/ 8388700-byte UTF-8 output was saved/.test(st.boundToolResult(base, 0).content), 'and is unchanged for a whole capture');
  }

  // ---- 12. outputElided survives executeCalls, so the REAL turn squeeze tells the truth (both paths) ----
  {
    const { _internals: L } = require('../sidecar/loop.js');
    const calls = [{ id: 'c1', name: 'shell.exec', argsRaw: '{}' }, { id: 'c2', name: 'shell.exec', argsRaw: '{}' }];
    const dispatch = async c => c.id === 'c1'
      ? { ok: true, content: 'h'.repeat(50000), summary: 'exit 0', parkedPath: '.output/shell-1.txt', outputElided: 12345678 }
      : { ok: true, content: 'w'.repeat(50000), summary: 'exit 0', parkedPath: '.output/shell-2.txt' };
    for (const parallel of [true, false]) {
      const label = parallel ? 'parallel' : 'sequential';
      const res = await L.executeCalls(calls, dispatch, {}, () => {}, { agentId: 'a', runId: 'r', parallelSafe: () => parallel, turnOutputMax: 4000 });
      A.eq(res[0].outputElided, 12345678, label + ': executeCalls carries outputElided to the turn budget');
      A.ok(!('outputElided' in res[1]), label + ': a whole capture gets no outputElided field');
      A.ok(/THE KEPT FIRST AND LAST PARTS OF THIS OUTPUT WERE SAVED to \.output\/shell-1\.txt/.test(res[0].content) && !/THE FULL OUTPUT OF THIS CALL WAS SAVED/.test(res[0].content), label + ': the squeezed elided result says only the first and last parts were saved');
      A.ok(/THE FULL OUTPUT OF THIS CALL WAS SAVED to \.output\/shell-2\.txt/.test(res[1].content), label + ': the squeezed whole result keeps the full-output note');
    }
  }

  A.report('output-capture.test');
})().catch(e => { console.error(e); process.exit(1); });
