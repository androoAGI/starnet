'use strict';
/* node test/assert-report-exitcode.test.js — report() in test/_assert.js honours a failing exit code set before it.

   THE HOLE THIS CLOSES (56a0ed102, 2026-11-08): a test whose catch flagged a throw with process.exitCode = 1 and
   then reached report() printed "OK (n assertions)" and exited 0, because report() exited with its own count.
   forget.phone.http and forget.tool-quotes.http read green that way in the v0.15.0 gate logs. Each case below runs a
   child process that requires the real test/_assert.js (its output is captured, never echoed into the gate log):
     E1 exitCode = 1, then report() after a passing assertion -> exit 1, no OK summary, the reason named
     E2 exitCode = 1 before any assertion, then report()      -> exit 1, and it says no assertion had run
     E3 a clean child: passing assertions, then report()       -> exit 0 with its OK summary
     E4 exitCode = 0 set explicitly, then report()             -> exit 0 (only a failing code counts)
     E5 a failing assertion, then report()                     -> exit 1 (the counter path is unchanged) */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('./_assert.js');

const ASSERT = path.join(__dirname, '_assert.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-assert-report-'));

function child(name, body) {
  const file = path.join(dir, name + '.js');
  fs.writeFileSync(file, "'use strict';\nconst A = require(" + JSON.stringify(ASSERT) + ');\n' + body + '\n');
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { status: r.status, out, shown: JSON.stringify(out.slice(0, 400)) };
}

try {
  const e1 = child('e1', "A.ok(true, 'one');\nprocess.exitCode = 1;\nA.report('e1');");
  A.eq(e1.status, 1, 'E1 a child that set exitCode = 1 and then called report() exits 1 (output ' + e1.shown + ')');
  A.ok(!/OK \(\d+ assertions?\)/.test(e1.out), 'E1 report() prints no OK summary over a failing exit code (output ' + e1.shown + ')');
  A.ok(/already failed outside its assertions/.test(e1.out) && /process\.exitCode 1 before report\(\)/.test(e1.out),
    'E1 report() names why it is red (output ' + e1.shown + ')');
  A.ok(/e1: 1 problem\(s\), 1 ok/.test(e1.out), 'E1 the summary counts the exit code as one problem beside the passing assertion (output ' + e1.shown + ')');

  const e2 = child('e2', "process.exitCode = 1;\nA.report('e2');");
  A.eq(e2.status, 1, 'E2 a failing exit code before any assertion still exits 1 (output ' + e2.shown + ')');
  A.ok(/before any assertion ran/.test(e2.out), 'E2 report() says no assertion had run (output ' + e2.shown + ')');

  const e3 = child('e3', "A.ok(true, 'one');\nA.eq(2, 2, 'two');\nA.report('e3');");
  A.eq(e3.status, 0, 'E3 a clean child exits 0 (output ' + e3.shown + ')');
  A.ok(/e3: OK \(2 assertions\)/.test(e3.out), 'E3 a clean child prints its OK summary (output ' + e3.shown + ')');

  const e4 = child('e4', "A.ok(true, 'one');\nprocess.exitCode = 0;\nA.report('e4');");
  A.eq(e4.status, 0, 'E4 exitCode = 0 set explicitly is not a failure (output ' + e4.shown + ')');
  A.ok(/e4: OK \(1 assertions?\)/.test(e4.out), 'E4 prints its OK summary (output ' + e4.shown + ')');

  const e5 = child('e5', "A.ok(true, 'one');\nA.ok(false, 'planted');\nA.report('e5');");
  A.eq(e5.status, 1, 'E5 a failing assertion still exits 1 (output ' + e5.shown + ')');
  A.ok(/e5: 1 problem\(s\), 1 ok/.test(e5.out), 'E5 the counter summary is unchanged (output ' + e5.shown + ')');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

A.report('assert-report-exitcode');
