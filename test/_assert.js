/* test/_assert.js — zero-dep assertion helpers + a fake U.bus, matching the
   err()-counter + process.exit(fail?1:0) convention used by the v7 headless tests.
   Each test file: run assertions, then call report() last. */
'use strict';

let fail = 0, pass = 0;
const err = m => { fail++; console.log('FAIL: ' + m); };

function ok(cond, msg) { if (cond) pass++; else err(msg || 'expected truthy value'); }

function eq(actual, expected, msg) {
  const A = JSON.stringify(actual), B = JSON.stringify(expected);
  if (A === B) pass++; else err((msg || 'eq') + ' — expected ' + B + ', got ' + A);
}

function throws(fn, msg) {
  try { fn(); err((msg || 'throws') + ' — did not throw'); }
  catch (e) { pass++; }
}

function notThrows(fn, msg) {
  try { fn(); pass++; }
  catch (e) { err((msg || 'notThrows') + ' — threw: ' + (e && e.message)); }
}

/* a fake bus mirroring frontend/js/util.js U.bus: handler throws are swallowed. */
function makeBus() {
  const h = {};
  return {
    _h: h,
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
    emit(ev, data) { (h[ev] || []).forEach(fn => { try { fn(data); } catch (e) { /* swallowed, as in U.bus */ } }); }
  };
}

/* subscribe to the given event names; returns an array filled in emit order. */
function collectBus(bus, names) {
  const log = [];
  for (const n of names) bus.on(n, payload => log.push({ name: n, payload }));
  return log;
}

/* fnBody(src, header) → the source of exactly ONE function, from its declaration to its OWN closing brace.
   Source-lock tests in this repo slice chat.js by a magic char count (`src.slice(i, i + 2600)`), which silently
   overruns into the NEXT function as bodies grow: a `why:` assertion aimed at suggestCandidate happily matched
   seedCandidate's, and deleting the line under test left the test green. Brace-count to the real end instead —
   then every lock binds the function it names, and nothing else. Quotes, template literals and comments are
   skipped so a brace inside a string or a prose comment can't end the body early.
   THE ONE CONCRETE HAZARD, named rather than hand-waved: REGEX LITERALS ARE NOT PARSED. A quote character inside
   a regex CHARACTER CLASS — `/[^']+/`, `/["']/` — opens the string-skip above, which then runs to the next
   matching quote somewhere later in the file, swallowing every brace in between. The scan does not end at the
   function's real closing brace and the returned slice RUNS LONG into whatever follows. It fails open (a longer
   body still contains everything the caller asserts) but a `!/…/.test(body)` assertion aimed at that function can
   then be satisfied — or falsified — by a NEIGHBOUR's source. So: any caller scanning a function that contains a
   quote inside a regex class MUST keep a length guard (assert the body is non-empty AND shorter than the file, or
   shorter than a sane bound) — that guard is what catches a mis-scan. This is a test helper, not a JS parser, and
   teaching it regex-vs-division would cost more than the guard. Returns '' if the header is absent. */
function fnBody(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

let reported = false;

/* 300ms, and the number is measured rather than picked. The grace below does double duty: it stops a
   stuck test hanging, AND it keeps the force-exit clear of the abort window, because a handle is only
   dangerous to exit on while it is CLOSING — once settled, process.exit() on a stably-open server is
   fine. Sweeping the crashing test at N=12 per value put that window under 50ms:
       grace=0ms -> 8/12 aborts (i.e. the original bug)   grace=50/150/300/500ms -> 0/12
   300ms is 6x the observed floor. It is not free: ~53 of 79 test:http steps and ~51 of 684 test:fast
   steps leak a handle and wait it out, so every 1s of grace costs the two gates about 100s together.
   At 2000ms that alone pushed test:http past its own 600s budget. Raise it only with evidence. */
const EXIT_GRACE_MS = Number(process.env.STARNET_TEST_EXIT_GRACE_MS || 300);

/* REPORT MUST NOT process.exit() (2026-08-25, Windows portability). It used to, and that cost two
   things beyond the obvious one.
   1. THE ABORT. Exiting hard while a spawned child's handles are still live trips libuv on Windows —
      `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` — and the
      process dies with 0xC0000409 on the line AFTER it printed OK, so the runner scores that step
      FAILED. test/update-preparation.http.test.js aborted on 7 runs in 8 and stopped `npm run test:http`
      dead at step 6/83. test:fast is ubuntu-only in CI and test:http runs in no workflow at all, so
      nothing ever saw it.
   2. THE SKIPPED CLEANUP. process.exit() inside a try SKIPS ITS finally. Every test that reported before
      its cleanup was orphaning its spawned sidecar and leaking its temp workspace on every run, on every
      platform. Draining runs those finally blocks — 38 test files have real code after report().
   The old hard exit did protect against something real: a test holding a live handle would otherwise HANG,
   which is worse than a crash. So keep that as a FALLBACK rather than dropping it. The grace timer is
   UNREF'D, and that is the whole trick — an unref'd timer cannot by itself hold the process open, so a
   clean test still exits the instant its loop empties and pays no delay at all (measured: 0ms). Only a
   genuinely stuck test reaches the timer, and it gets force-exited with the correct code instead of
   hanging the suite. */
function report(title) {
  if (reported) return;   // draining means code after report() runs; never report twice
  reported = true;
  console.log((title || 'tests') + ': ' + (fail ? (fail + ' problem(s), ' + pass + ' ok') : ('OK (' + pass + ' assertions)')));
  process.exitCode = fail ? 1 : 0;
  const grace = setTimeout(() => {
    /* Reaching here means the loop did NOT empty: this file still holds a live handle after its
       last assertion — an unkilled child, an open server or socket, a ref'd interval. It used to
       be invisible because process.exit() killed it for free. Say so instead of paying for it in
       silence: every line below is a real leak, and the step's wall clock includes this whole
       wait. Deliberately NOT the word FAIL — the assertions passed and the step stays green. */
    console.log('[slow-exit] ' + (title || 'tests') + ': held the event loop open for ' + EXIT_GRACE_MS +
                'ms after report() — a handle is leaking; force-exiting ' + (fail ? 1 : 0) + '.');
    process.exit(fail ? 1 : 0);
  }, EXIT_GRACE_MS);
  if (typeof grace.unref === 'function') grace.unref();
}

/* SILENT-EARLY-EXIT GUARD (2026-07-25). Calling report() is necessary but not sufficient: a file can EXIT
   BEFORE reaching it and still leave exit code 0, so the runner scores it green having verified nothing.
   That is not hypothetical — it happened while adding a browser test here. Node's event loop can drain
   mid-await when the only thing outstanding is an unref'd timer (the CDP client unrefs its timeout timers),
   and an un-awaited async IIFE has the same effect. Both look identical to the runner: no output, exit 0.
   So: if any assertion ran and the process leaves with a success code without report() having been called,
   turn it red and say why. A test whose asserts never finished is a failing test, not a passing one. */
process.on('exit', (code) => {
  if (reported || code !== 0) return;
  if (pass === 0 && fail === 0) return;   // a file that asserted nothing is some other lint's problem
  console.log('FAIL: the test process exited before report() was reached — ' + pass + ' assertion(s) had run.');
  console.log('      Exit code 0 here would be scored GREEN having verified nothing. Usual causes: an');
  console.log('      un-awaited async block, or the event loop draining while only unref\'d timers remain');
  console.log('      (hold it open with a setInterval for the duration of the wait).');
  process.exitCode = 1;
});

module.exports = { ok, eq, throws, notThrows, makeBus, collectBus, report, fnBody, fails: () => fail };
