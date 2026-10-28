/* node test/process-fault.test.js — the fail-loud-but-safe uncaughtException policy (sidecar/process-fault.js)
   + the two Map bounds from the same audit (queueDepth delete-on-drain, devReplies LRU cap).

   The law (2026-09-03 audit): after a genuine uncaught throw the sidecar must NOT keep serving over unproven
   state while /api/health says "ok". It surfaces the fault, marks health degraded, releases locks, and exits(1)
   after a bounded delay so the shell watchdog restarts a clean process. Benign stdio EPIPE stays surface-only;
   STARNET_UNCAUGHT_KEEP_SERVING is the test-only opt-out. Section E proves it against a REAL node process. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeProcessFaultHandler, isBenign, summarize } = require('../sidecar/process-fault.js');

function harness(extra) {
  const calls = { surface: [], exits: [], scheduled: [], quiesced: 0, released: 0, logs: [] };
  const h = makeProcessFaultHandler(Object.assign({
    surface: (kind, e) => calls.surface.push([kind, e]),
    exit: code => calls.exits.push(code),
    schedule: (fn, ms) => { calls.scheduled.push({ fn, ms }); return 1; },
    quiesce: () => { calls.quiesced++; },
    release: () => { calls.released++; },
    log: m => calls.logs.push(m),
    now: () => 1234,
    delayMs: 500
  }, extra || {}));
  return { h, calls };
}

(async () => {
  // ---- security audit 2026-09-25: the fault text reaches /api/health (unauthenticated), the crash ledger and the log.
  //      It is scrubbed with the host redact() before truncation, so a credential in an error message never lands there.
  {
    const { redact } = require('../sidecar/context.js');
    const recorded = [];
    const { h, calls } = harness({ redact, breaker: { record: v => { recorded.push(v); return { tripped: false }; } } });
    const key = 'sk-or-v1-' + 'a'.repeat(40);
    h.onUncaught(new Error('fetch https://api.example/v1?api_key=plainsecret123 failed with ' + key + ' ' + 'x'.repeat(300)));
    const f = h.fault();
    A.ok(f.message.indexOf(key) < 0 && f.message.indexOf('sk-or-v1') < 0 && f.message.indexOf('plainsecret123') < 0, 'fault() (and so /api/health) carries no credential');
    A.ok(recorded.length === 1 && recorded[0].summary.indexOf('plainsecret123') < 0, 'the crash-ledger summary is scrubbed');
    A.ok(f.message.indexOf('[redacted-') >= 0, 'the redaction marker is visible, so the report stays honest');
    const { h: h2 } = harness({ redact: () => { throw new Error('redactor broke'); } });
    h2.onUncaught(new Error('token=abcdefgh1234'));
    A.ok(h2.fault().message.indexOf('abcdefgh1234') < 0, 'a failing redactor withholds the message rather than leaking it');
  }

  // ---- A. a genuine uncaught: surfaced FIRST (diagnostics ring intact), fault recorded, exit(1) scheduled after the delay ----
  {
    const { h, calls } = harness();
    const err = new Error('torn state');
    const r = h.onUncaught(err);
    A.eq(calls.surface.length, 1, 'the existing surface (log + diag ring) still runs');
    A.eq(calls.surface[0][0], 'uncaughtException', 'surfaced under the uncaughtException kind');
    A.eq(r.action, 'exit-scheduled', 'policy = exit scheduled');
    A.eq(r.delayMs, 500, 'bounded delay honoured');
    A.ok(h.fault() && h.fault().message === 'torn state', 'fault() exposes the summary for /api/health + diagnostics');
    A.eq(h.fault().at, 1234, 'fault carries the injected clock');
    A.eq(h.fault().exiting, true, 'fault says the process is exiting');
    A.eq(calls.quiesced, 1, 'background work is quiesced immediately while the degraded window is observable');
    A.eq(calls.exits.length, 0, 'exit is NOT immediate — the degraded window is observable');
    A.eq(calls.scheduled.length, 1, 'exactly one timer armed');
    A.eq(calls.scheduled[0].ms, 500, 'timer uses the configured delay');
    calls.scheduled[0].fn();
    A.eq(calls.released, 1, 'release hook (cron lock / owner claim) ran before exit');
    A.eq(calls.exits[0], 1, 'exit code 1 so the watchdog sees an unexpected exit');
  }
  // ---- B. idempotent: a second throw during the window surfaces but never re-arms or overwrites the first fault ----
  {
    const { h, calls } = harness();
    h.onUncaught(new Error('first'));
    const r2 = h.onUncaught(new Error('second'));
    A.eq(r2.action, 'already-faulted', 'second fault does not re-schedule');
    A.eq(calls.surface.length, 2, 'but it IS still surfaced');
    A.eq(calls.scheduled.length, 1, 'still one timer');
    A.eq(calls.quiesced, 1, 'second fault does not repeat the quiesce hook');
    A.eq(h.fault().message, 'first', 'first fault wins');
  }
  // ---- C. benign allowlist: stdio EPIPE / destroyed stream is surface-only, never a fault ----
  {
    const { h, calls } = harness();
    const e = new Error('write EPIPE'); e.code = 'EPIPE';
    A.eq(h.onUncaught(e).action, 'benign', 'EPIPE is benign');
    const e2 = new Error('Cannot call write after a stream was destroyed'); e2.code = 'ERR_STREAM_DESTROYED';
    A.eq(h.onUncaught(e2).action, 'benign', 'ERR_STREAM_DESTROYED is benign');
    A.eq(calls.surface.length, 2, 'both still surfaced to the diag ring');
    A.eq(h.fault(), null, 'no fault recorded');
    A.eq(calls.quiesced, 0, 'benign stream errors do not quiesce the process');
    A.eq(calls.scheduled.length, 0, 'no exit armed');
    A.eq(isBenign({ code: 'ENOENT' }), false, 'an ordinary errno is not benign');
    A.eq(isBenign(null), false, 'null is not benign');
  }
  // ---- D. test-only opt-out: keepAlive marks degraded but never exits ----
  {
    const { h, calls } = harness({ keepAlive: true });
    const r = h.onUncaught(new Error('kept'));
    A.eq(r.action, 'degraded-kept-alive', 'keepAlive path');
    A.ok(!!h.fault(), 'fault still recorded (health honestly degraded)');
    A.eq(h.fault().exiting, false, 'fault says NOT exiting');
    A.eq(calls.quiesced, 1, 'even the test-only keepAlive process is quiesced');
    A.eq(calls.scheduled.length, 0, 'no exit timer');
    A.eq(calls.exits.length, 0, 'no exit');
  }
  // ---- D2. containment: a throwing surface or release hook never masks the policy ----
  {
    const { h, calls } = harness({ surface: () => { throw new Error('surface broke'); }, quiesce: () => { throw new Error('quiesce broke'); }, release: () => { throw new Error('release broke'); } });
    A.notThrows(() => h.onUncaught(new Error('x')), 'a broken surface does not throw out of the handler');
    A.eq(calls.scheduled.length, 1, 'exit still scheduled');
    A.notThrows(() => calls.scheduled[0].fn(), 'a broken release hook does not throw');
    A.eq(calls.exits[0], 1, 'exit still happens after a broken release hook');
    A.ok(calls.logs.some(m => /quiesce hook failed/.test(m)), 'quiesce failure is logged');
    A.ok(calls.logs.some(m => /release hook failed/.test(m)), 'release failure is logged');
  }
  // ---- D3. crash-loop hold: the process stays alive only after the immediate quiesce hook ----
  {
    const breaker = { record: () => ({ tripped: true, count: 3 }), state: () => ({ tripped: true, count: 3, windowMs: 600000 }) };
    const { h, calls } = harness({ breaker });
    const r = h.onUncaught(new Error('repeatable boot fault'));
    A.eq(r.action, 'crash-loop-held', 'breaker holds the third fault instead of respawning forever');
    A.eq(calls.quiesced, 1, 'held process was quiesced before returning');
    A.eq(calls.scheduled.length, 0, 'held process does not schedule another exit');
    A.eq(calls.released, 0, 'held process keeps its ownership claims');
    A.ok(h.fault().loop && h.fault().loop.tripped, 'held fault exposes crash-loop diagnostics');
  }
  // ---- D4. summarize: one line, bounded, never throws ----
  {
    A.eq(summarize(new Error('a\n  b   c')), 'a b c', 'whitespace collapsed to one line');
    A.eq(summarize('x'.repeat(300)).length, 201, 'bounded at 200 chars + ellipsis');
    A.eq(summarize(null), 'null', 'null summarises');
    A.eq(summarize({ message: '' }), 'unknown error', 'empty message → unknown error');
  }

  // ---- E. REAL PROCESS PROOF: a child node installs the handler with real process.exit/setTimeout, throws, and exits 1 ----
  {
    const mod = path.resolve(__dirname, '..', 'sidecar', 'process-fault.js').replace(/\\/g, '/');
    const script = [
      "const { makeProcessFaultHandler } = require(" + JSON.stringify(mod) + ");",
      "let released = false;",
      "const h = makeProcessFaultHandler({ surface: (k, e) => console.error(k + ':', e && e.message), exit: c => process.exit(c), schedule: (fn, ms) => setTimeout(fn, ms), delayMs: 100, release: () => { released = true; console.error('released=true'); }, log: m => console.error('[process-fault] ' + m) });",
      "process.on('uncaughtException', e => h.onUncaught(e));",
      "const keep = setInterval(() => {}, 1000);",   // a live handle: the process would otherwise idle-exit 0 — the exit(1) must come from the policy
      "setTimeout(() => { throw new Error('child torn state'); }, 10);",
      "setTimeout(() => { console.error('STILL ALIVE'); process.exit(7); }, 3000);"   // if the policy failed to exit, this proves it loudly
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
    A.eq(r.status, 1, 'child process exited with code 1 after the uncaught throw (got ' + r.status + '); stderr=' + String(r.stderr).slice(0, 300));
    A.ok(/uncaughtException: child torn state/.test(r.stderr), 'child surfaced the fault before exiting');
    A.ok(/released=true/.test(r.stderr), 'child ran the release hook before exit');
    A.ok(!/STILL ALIVE/.test(r.stderr), 'child did NOT keep serving past the bounded delay');
  }
  // ---- E2. the same real process with the opt-out keeps running (the test suite's own safety valve) ----
  {
    const mod = path.resolve(__dirname, '..', 'sidecar', 'process-fault.js').replace(/\\/g, '/');
    const script = [
      "const { makeProcessFaultHandler } = require(" + JSON.stringify(mod) + ");",
      "const h = makeProcessFaultHandler({ surface: (k, e) => console.error(k + ':', e && e.message), exit: c => process.exit(c), keepAlive: true, delayMs: 50, log: m => console.error('[process-fault] ' + m) });",
      "process.on('uncaughtException', e => h.onUncaught(e));",
      "setTimeout(() => { throw new Error('kept alive'); }, 10);",
      "setTimeout(() => { console.error('fault=' + JSON.stringify(h.fault())); process.exit(0); }, 400);"
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
    A.eq(r.status, 0, 'keepAlive child survived the throw and exited on its own terms');
    A.ok(/"exiting":false/.test(r.stderr), 'keepAlive fault is recorded as not-exiting');
  }

  // ---- F. index.js wiring + Map bounds (source-level, mirrors the honesty asserts in sidecar.http.test.js) ----
  {
    const src = readSidecarSource();
    A.ok(/process\.on\('uncaughtException',\s*e\s*=>\s*processFault\.onUncaught\(e\)\)/.test(src), 'uncaughtException is routed through the fail-loud handler');
    A.ok(/process\.on\('unhandledRejection',\s*e\s*=>\s*surfaceProcessError\('unhandledRejection',\s*e\)\)/.test(src), 'unhandledRejection stays log-only');
    A.ok(/ENV\('UNCAUGHT_KEEP_SERVING'\)/.test(src), 'test opt-out env is honoured');
    A.ok(/const f = processFault\.fault\(\);\s*if \(f\) \{ res\.writeHead\(503/.test(src), '/api/health answers 503 while faulted');
    A.ok(/if \(rejectProcessFaultRequest\(req, res\)\) return;[\s\S]*if \(openaiCompat\.handle/.test(src), 'fault gate runs before the external /v1 compatibility API');
    A.ok(/function quiesceForProcessFault\(\)[\s\S]*killAll\(runs,[\s\S]*connectors\.close/.test(src), 'fault quiesce aborts browser and channel runs and closes background connectors');
    A.ok(/function quiesceForProcessFault\(\)[\s\S]*groupSessions\.halt/.test(src), 'fault quiesce halts group sessions');
    A.ok(/function quiesceForProcessFault\(\)[\s\S]*for \(const id of GENERIC_CHANNEL_IDS\) stopGenericChannel\(id\)/.test(src), 'fault quiesce disconnects generic channels');
    A.ok(/function quiesceForProcessFault\(\)[\s\S]*clearInterval\(livePricesRefreshTimer\)/.test(src), 'fault quiesce stops the live-price refresh timer');
    // LINE TRIGGERS are contained like E-STOP contains them (2026-09-24 security review): poll timer cleared, queues
    // dropped, trigger-hub runs killed — and the runner's halted() refuses any fire after a fault quiesced the process
    const q = A.fnBody(src, 'function quiesceForProcessFault()');
    A.ok(/contain\('triggers', \(\) => \{[\s\S]*clearInterval\(triggerPollTimer\);[\s\S]*triggerRunner\.haltAll\(\);[\s\S]*killAll\(null, \.\.\.triggerRunner\.inflights\(\)\);/.test(q), 'fault quiesce stops the folder poll, drops trigger queues and kills trigger-hub runs');
    A.ok(/let triggerPollTimer = setInterval\(/.test(src), 'the trigger poll timer is clearable');
    // (wave 2 repair, conveyor-backend-08 and its siblings) the containment is the station's OWN fault, never the Commander's E-STOP:
    // every hub run it kills is marked faulted FIRST (halt.js markFaulted), so a chat's notice, a STEP THROUGH, a hand-off and RUN ONE
    // REAL JOB name the fault — and a plain E-STOP never marks one
    A.ok(/markFaulted\(tgInflight, dcInflight, \.\.\.genericInflights, \.\.\.tgBotInflights, devInflight, stepTest \? stepTest\.inflight : null\);\s*killAll\(runs, tgInflight, dcInflight, \.\.\.genericInflights, \.\.\.tgBotInflights, devInflight, stepTest \? stepTest\.inflight : null\);/.test(q), 'fault quiesce marks the channel, dev and step-test runs faulted before it kills them');
    A.ok(/markFaulted\(\.\.\.triggerRunner\.inflights\(\)\);\s*killAll\(null, \.\.\.triggerRunner\.inflights\(\)\);/.test(q), '…the trigger runs');
    A.ok(/markFaulted\(\.\.\.handoffRunner\.inflights\(\)\); killAll\(null, \.\.\.handoffRunner\.inflights\(\)\);/.test(q), '…the hand-off runs');
    A.ok(/sampleInFlight\.stopCause = 'fault';[^\n]*markFaulted\(\(sampleHub && sampleHub\._internals\) \? sampleHub\._internals\.inflight : null\); killAll\(null,/.test(q), '…and the sample run, whose record and answer say the fault');
    const estop = A.fnBody(src, 'function handleHalt(req, res)');
    A.ok(/killAll\(runs,/.test(estop) && !/markFaulted|stopCause/.test(estop), 'the Commander\'s E-STOP marks no fault');
    const sample = A.fnBody(src, 'async function runSampleJob(readArgs)');
    A.ok(/stoppedJob \? \(sampleInFlight\.stopCause === 'fault' \? 'the station hit an internal fault and stopped this job' : 'you stopped this job'\)/.test(sample), 'the sample job record words a fault stop as the fault');
    A.ok(/\(stopped && sampleInFlight\.stopCause === 'fault'\) \? \{ error: 'stopped — the station hit an internal fault and stopped this job before it reached the OUTBOX', stoppedBy: 'fault' \} : null/.test(sample), 'the sample answer words it so too, and says stoppedBy fault');
    A.ok(/halted: \(\) => cronHalted === true \|\| processFaultQuiesced === true,/.test(src), 'the trigger runner treats a fault-quiesced process as halted');
    const bump = A.fnBody(src, 'function bumpQueue(agentId, d)');
    A.ok(/queueDepth\.delete\(agentId\)/.test(bump), 'bumpQueue deletes a drained entry (bounded Map)');
    const cap = A.fnBody(src, 'function devCaptureReply(chatId, text)');
    A.ok(/devReplies\.size > DEV_REPLIES_MAX_CHATS/.test(cap) && /devReplies\.keys\(\)\.next\(\)\.value/.test(cap), 'devReplies is LRU-capped');
    // Map-bound semantics, executed: replicate the two functions over real Maps from their own source.
    const queueDepth = new Map();
    const bumpQueueFn = new Function('queueDepth', bump + '; return bumpQueue;')(queueDepth);
    bumpQueueFn('a', +1); bumpQueueFn('b', +1); bumpQueueFn('a', -1); bumpQueueFn('b', -1); bumpQueueFn('c', -1);
    A.eq(queueDepth.size, 0, 'drained queues leave no entry (was: one entry per agentId forever)');
    bumpQueueFn('a', +1); bumpQueueFn('a', +1);
    A.eq(queueDepth.get('a'), 2, 'in-flight depth still counts');
    const devReplies = new Map();
    const captureFn = new Function('devReplies', 'DEV_REPLIES_MAX_CHATS', cap + '; return devCaptureReply;')(devReplies, 64);
    for (let i = 0; i < 100; i++) captureFn('chat' + i, 'hi');
    A.eq(devReplies.size, 64, 'devReplies capped at 64 chats');
    A.eq(devReplies.has('chat0'), false, 'oldest chat evicted');
    A.eq(devReplies.has('chat99'), true, 'newest chat kept');
    captureFn('chat36', 'again'); captureFn('chat100', 'new');
    A.eq(devReplies.has('chat36'), true, 'a re-touched chat is promoted (LRU, not FIFO)');
    A.eq(devReplies.has('chat37'), false, 'and the least-recently-used one went instead');
  }

  A.report('process-fault');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
