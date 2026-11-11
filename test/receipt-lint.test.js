'use strict';
/* node test/receipt-lint.test.js — scripts/qa/receipt-lint.mjs finds the green gate steps that printed an error.

   THE HOLE THIS CLOSES (C0-4, 2026-11-11): the gate runner scores a step by its exit code, so a test that logs a
   throw and still reaches its OK summary reads green. Small fixture logs, written to a temp dir (their text is
   never echoed into this test's own output, which a gate log would then carry):
     L1 clean          every ok step printed only its summary: exit 0, 0 false greens, every step counted
     L2 error-then-OK  an ok step printed an Error, its stack and then its OK summary: exit 1, that one step named,
                       its Error line and the frames under it one event, the steps around it clean
     L3 allow-listed   the same shape for a step the allow-list names with that text: exit 0, listed as allowed; a
                       second, unlisted error in that step still fails; an allow text no longer printed is noted
     L4 signals        an error word, a stack frame, a FAIL: line and a logged throw each count; "errors: 0",
                       "lastError:" and prose with "at" do not
     L5 boundaries     a red step's output is never charged to the ok step after it (the bug of the 0.15.0 autopsy
                       scan this lint was promoted from: "FAILED" lines did not end a step); a quarantined retry
                       lints only the scored attempt and is noted; a runner-shaped line a test prints does not end
                       the real run; a log cut short is noted
     L6 empty          a file with no step result line exits 1, never clean
     L7 allow-list     an entry with no expected text, or a step listed twice, is refused (exit 2); the shipped list
                       parses, says it is reviewed at every cut, and names only steps a gate runs
     L8 encodings      a UTF-16 log (PowerShell Tee-Object) and ANSI colour codes lint the same as plain UTF-8 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const LINT = path.join(root, 'scripts', 'qa', 'receipt-lint.mjs');

const step = (n, total, file, status) => 'run-fast-tests: step ' + n + '/' + total + ' ' + (status || 'ok') + ' 0.1s \u2014 node ' + file;
const tail = total => ['run-fast-tests: ran ' + total + ' of ' + total + ' step(s) in 0m01s', 'run-fast-tests: OK \u2014 ' + total + ' step(s) green'];
const log = lines => lines.join('\r\n') + '\r\n';

const CLEAN = log([
  '> starnet test:fast:raw',
  'a.test: OK (3 assertions)', step(1, 3, 'test/a.test.js'),
  'b.test: PASS (two things)', step(2, 3, 'test/b.test.js'),
  'c.test: OK (1 assertion)', step(3, 3, 'test/c.test.js')
].concat(tail(3)));

const ERROR_THEN_OK = log([
  'a.test: OK (3 assertions)', step(1, 3, 'test/a.test.js'),
  'Error: planted delivery was not recorded',
  '    at planted (C:\\repo\\test\\helpers\\b.js:10:5)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
  '    at async C:\\repo\\test\\b.test.js:20:3',
  'b.test: OK (2 assertions)', step(2, 3, 'test/b.test.js'),
  'c.test: OK (1 assertion)', step(3, 3, 'test/c.test.js')
].concat(tail(3)));

(async () => {
  const lint = await import(pathToFileURL(LINT).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-receipt-lint-'));
  const write = (name, text, encoding) => { const p = path.join(dir, name); fs.writeFileSync(p, text, encoding); return p; };
  const quietMain = argv => { const lines = []; const code = lint.main(argv, { log: line => lines.push(line) }); return { code, lines, text: lines.join('\n') }; };
  try {
    // L1 clean
    const clean = lint.lintLog(CLEAN, null);
    A.eq([clean.steps, clean.ok, clean.red, clean.runs, clean.falseGreens.length, clean.clean], [3, 3, 0, 1, 0, true], 'L1 a clean log: 3 ok steps, 0 false greens');
    A.eq(clean.notes, [], 'L1 a complete clean log carries no note');
    const cleanFile = write('clean.log', CLEAN);
    A.eq(quietMain([cleanFile, '--no-allow']).code, 0, 'L1 the CLI passes a clean log');

    // L2 error-then-OK
    const bad = lint.lintLog(ERROR_THEN_OK, null);
    A.eq([bad.steps, bad.ok, bad.falseGreens.length, bad.clean], [3, 3, 1, false], 'L2 one false green among 3 ok steps');
    const row = bad.falseGreens[0] || { events: [] };
    A.eq([row.position, row.step], ['2/3', 'test/b.test.js'], 'L2 the false green is the step that printed the error');
    A.eq(row.events.map(e => [e.line, e.kinds, e.frames]), [['Error: planted delivery was not recorded', ['error', 'stack'], 3]],
      'L2 the Error line and the 3 frames under it are one event');
    const badFile = write('error-then-ok.log', ERROR_THEN_OK);
    const badRun = quietMain([badFile, '--no-allow']);
    A.eq(badRun.code, 1, 'L2 the CLI fails an error-then-OK log');
    A.ok(/FALSE GREEN\s+step 2\/3\s+test\/b\.test\.js/.test(badRun.text), 'L2 the CLI names the step with its number and path');
    A.ok(/receipt-lint: FAILED/.test(badRun.lines[badRun.lines.length - 1] || ''), 'L2 the last line of a failing lint says FAILED');
    const json = quietMain([badFile, '--no-allow', '--json']);
    let parsed = null; try { parsed = JSON.parse(json.text); } catch (_) {}
    A.ok(parsed && parsed.ok === false && parsed.results[0].falseGreens[0].step === 'test/b.test.js', 'L2 --json carries the same verdict');
    const spawned = spawnSync(process.execPath, [LINT, badFile, '--no-allow'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    A.eq(spawned.status, 1, 'L2 the command exits 1 on a false green');
    const spawnedClean = spawnSync(process.execPath, [LINT, cleanFile, '--no-allow'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    A.eq(spawnedClean.status, 0, 'L2 the command exits 0 on a clean log');

    // L3 allow-listed
    const allow = lint.parseAllowList('# fixture\ntest/b.test.js | planted delivery was not recorded\ntest/c.test.js | a text c never prints\n', 'fixture.allow');
    const allowed = lint.lintLog(ERROR_THEN_OK, allow);
    A.eq([allowed.falseGreens.length, allowed.allowed.length, allowed.clean], [0, 1, true], 'L3 the allow-listed step passes and is listed as allowed');
    A.ok(allowed.notes.some(n => n.includes('test/c.test.js') && n.includes('a text c never prints')), 'L3 an allow text the log no longer prints is noted for the cut review');
    const allowFile = write('fixture.allow', 'test/b.test.js | planted delivery was not recorded\n');
    const allowRun = quietMain([badFile, '--allow=' + allowFile]);
    A.eq(allowRun.code, 0, 'L3 the CLI passes the log with the allow-list');
    A.ok(/allowed\s+step 2\/3\s+test\/b\.test\.js/.test(allowRun.text), 'L3 the CLI still lists the allowed step');
    const twoErrors = ERROR_THEN_OK.replace('b.test: OK (2 assertions)', 'TypeError: a new surprise\r\nb.test: OK (2 assertions)');
    const stillBad = lint.lintLog(twoErrors, allow);
    A.eq(stillBad.falseGreens.length, 1, 'L3 a second, unlisted error in an allow-listed step still fails');
    A.eq(((stillBad.falseGreens[0] || {}).unexplained || []).map(e => e.line), ['TypeError: a new surprise'], 'L3 only the unlisted event is charged');

    // L4 signals
    const S = lint.SIGNALS;
    A.ok(S.error('TypeError [ERR_INVALID_ARG_TYPE]: bad') && S.error('[navdock] storage blocked Error: blocked') && S.error('Error:'), 'L4 error lines count, mid-line too');
    A.ok(!S.error('errors: 0') && !S.error('lastError: none') && !S.error('ERROR_CODE: 3'), 'L4 words that only look like an error do not count');
    A.ok(S.stack('    at Array.map (<anonymous>)') && S.stack('    at node:internal/main/run_main_module:28:49') &&
      S.stack('    at Object.<anonymous> (/repo/test/x.test.js:4:1)') && S.stack('      at async Promise.all (index 0)'), 'L4 stack frames count');
    A.ok(!S.stack('it arrives at the desk (approved)') && !S.stack('  at the desk (approved)') && !S.stack('    at 3 pm'), 'L4 prose with "at" is no stack frame');
    A.ok(S.fail('FAIL: x') && S.fail('  FAIL: y') && !S.fail('nothing FAILED here'), 'L4 FAIL: lines count');
    A.ok(S.throw('[telegram] /tools threw: boom') && S.throw('Unhandled rejection: x') && !S.throw('throws nothing'), 'L4 a logged throw counts');
    A.eq(lint.signalEvents(['Error: x', '    at f (a.js:1:2)', '    at g (a.js:3:4)', 'plain line', '    at h (b.js:5:6)', 'FAIL: y']).map(e => [e.line, e.kinds, e.frames]),
      [['Error: x', ['error', 'stack'], 2], ['plain line', ['stack'], 1], ['FAIL: y', ['fail'], 0]], 'L4 frames join the line above them; a plain line opens its own event');

    // L5 boundaries
    const mixed = log([
      'FAIL: planted red', 'Error: planted red step', '    at red (/repo/test/red.test.js:1:1)',
      step(1, 4, 'test/red.test.js', 'FAILED (exit 1)'),
      'b.test: OK (1 assertion)', step(2, 4, 'test/b.test.js'),
      'FAIL: stt 403: planted flake',
      'run-fast-tests: step 3/4 failed (exit 1) in its quarantined flaky case (test/flaky.list) \u2014 retrying once: node test/flaky.test.js',
      'flaky.test: OK (4 assertions)', step(3, 4, 'test/flaky.test.js'),
      'fixture: step 7/9 ok 0.1s \u2014 node test/printed-by-a-test.js',
      'run-fast-tests: step 2/4 ok 0.1s \u2014 node test/printed-again.js',
      'd.test: OK (1 assertion)', step(4, 4, 'test/d.test.js'),
      'run-fast-tests: FAILED at step 1/4: node test/red.test.js (exit 1)',
      'run-fast-tests: FAILED \u2014 1 of 4 step(s) failed'
    ]);
    const m = lint.lintLog(mixed, null);
    A.eq([m.steps, m.ok, m.red, m.runs, m.falseGreens.length], [4, 3, 1, 1, 0], 'L5 a red step is counted red and its output is not charged to the ok step after it');
    A.eq(m.retried, [{ position: '3/4', step: 'test/flaky.test.js' }], 'L5 a quarantined retry lints only its scored attempt and is noted');
    const short = lint.lintLog(log(['a: OK (1 assertion)', step(1, 3, 'test/a.test.js'), 'b: OK (1 assertion)', step(2, 3, 'test/b.test.js')]), null);
    A.ok(short.clean && short.notes.some(n => /ends after step 2 of 3/.test(n)), 'L5 a log cut short is noted');

    // L6 empty
    A.eq([lint.lintLog('hello\nworld\n', null).steps, lint.lintLog('hello\nworld\n', null).clean], [0, false], 'L6 a log with no step result is never clean');
    A.eq(quietMain([write('empty.log', ''), '--no-allow']).code, 1, 'L6 the CLI fails an empty log');
    A.eq(quietMain([path.join(dir, 'missing.log'), '--no-allow']).code, 2, 'L6 an unreadable log is a usage error');
    A.eq(quietMain([]).code, 2, 'L6 no log named is a usage error');

    // L7 allow-list
    A.throws(() => lint.parseAllowList('test/x.test.js\n'), 'L7 an entry with no expected text is refused');
    A.throws(() => lint.parseAllowList('test/x.test.js | a\ntest/x.test.js | b\n'), 'L7 a step listed twice is refused');
    A.eq(quietMain([cleanFile, '--allow=' + write('bad.allow', 'test/x.test.js |\n')]).code, 2, 'L7 the CLI refuses a bad allow-list');
    const shippedText = fs.readFileSync(lint.DEFAULT_ALLOW, 'utf8');
    A.ok(/REVIEWED AT EVERY CUT/.test(shippedText), 'L7 the shipped allow-list says it is reviewed at every cut');
    const shipped = lint.readAllowList(lint.DEFAULT_ALLOW);
    A.eq([...shipped.keys()].sort(), ['test/channels.hub.test.js', 'test/channels.parity.test.js', 'test/nav-coach-dismiss.test.js'],
      'L7 the shipped allow-list names the three reviewed steps');
    const gated = new Set(['fast.list', 'http.list'].flatMap(name => fs.readFileSync(path.join(__dirname, name), 'utf8').split(/\r?\n/).map(l => l.trim())));
    A.ok([...shipped.keys()].every(s => gated.has(s)), 'L7 every allow-listed step is a step a gate runs');

    // L8 encodings
    const utf16 = write('utf16.log', '\ufeff' + ERROR_THEN_OK, 'utf16le');
    const u = lint.lintFile(utf16, null);
    A.eq([u.steps, u.falseGreens.length, (u.falseGreens[0] || {}).step], [3, 1, 'test/b.test.js'], 'L8 a UTF-16 log lints the same');
    const coloured = ERROR_THEN_OK.replace('Error: planted', '\x1b[31mError: planted').replace(step(2, 3, 'test/b.test.js'), '\x1b[32m' + step(2, 3, 'test/b.test.js') + '\x1b[0m');
    A.eq(lint.lintLog(coloured, null).falseGreens.length, 1, 'L8 ANSI colour codes do not hide a signal or a step line');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('receipt-lint.test');
})().catch(e => { console.log('FAIL: receipt-lint.test threw ' + (e && e.stack || e)); process.exit(1); });
