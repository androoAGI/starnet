/* node test/registry.cancel-races-deaf-tool.test.js — STOP MUST REACH A TOOL THAT IGNORES ITS SIGNAL (h1 audit 2026-09-22).

   The probe: registry.dispatch raced a tool only against its OWN timer, never against the run's abort signal — a
   signal-ignoring tool cancelled at 1s returned at 8,007ms with a normal result, holding the stopped run hostage.
   Proves: once the run signal aborts, dispatch waits at most a short grace (injectable; default 3000ms) and then
   answers for the tool — a cancelled result saying it did NOT confirm it stopped and that its effect is unknown
   (effectUnknown on non-read tools); a COOPERATIVE tool still returns its own result promptly inside the grace (the
   fast path is not slowed to the grace); no parent-signal listener is leaked; a run that is never cancelled is
   untouched. Bounded real timers only (sub-second). */
'use strict';
const A = require('./_assert.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const call = (name, id) => ({ id: id || 'c1', name, args: {}, argsRaw: '{}' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const reg = makeRegistry();
  let deafFinishedAt = 0;
  // DEAF: ignores ctx.signal entirely and finishes on its own at ~1500ms with a "normal" result.
  reg.register({ impact: 'none', name: 'deaf_write', scope: 'write', schema: { type: 'object' },
    run: async () => { await sleep(1500); deafFinishedAt = Date.now(); return 'deaf finished normally'; } });
  reg.register({ impact: 'none', name: 'deaf_read', scope: 'read', schema: { type: 'object' },
    run: async () => { await sleep(1500); return 'late read'; } });
  // COOPERATIVE: stops when its signal aborts and reports its own truthful result.
  reg.register({ impact: 'none', name: 'polite', scope: 'write', schema: { type: 'object' },
    run: (args, ctx) => new Promise(resolve => {
      const t = setTimeout(() => resolve('finished without a cancel'), 5000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(t); setTimeout(() => resolve('stopped cleanly at the signal'), 20); }, { once: true });
    }) });
  // SLOW-COOPERATIVE: honours the signal but needs longer than the grace to wind down.
  reg.register({ impact: 'none', name: 'slow_polite', scope: 'write', schema: { type: 'object' },
    run: (args, ctx) => new Promise(resolve => {
      ctx.signal.addEventListener('abort', () => setTimeout(() => resolve('wound down late'), 900), { once: true });
    }) });

  // ---- 1. a DEAF write tool: abort at 100ms, grace 300ms -> dispatch returns ~400ms with cancelled / effect unknown ----
  {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = reg.dispatch(call('deaf_write'), { signal: ac.signal, cancelGraceMs: 300 });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    const took = Date.now() - t0;
    A.ok(took >= 380 && took < 900, 'dispatch answered at abort + grace (~400ms), not when the deaf tool finished (took ' + took + 'ms)');
    A.eq(deafFinishedAt, 0, 'the deaf tool had NOT finished when dispatch answered for it');
    A.eq([r.ok, r.isError, r.summary], [false, true, 'cancelled - unconfirmed'], 'the result is an isError cancelled - unconfirmed');
    A.ok(/was cancelled/.test(r.content) && /did not confirm it stopped within 300ms/.test(r.content), 'content says it was cancelled and did not confirm it stopped: ' + r.content);
    A.ok(/may still be running/.test(r.content) && /effect is UNKNOWN/.test(r.content), 'content says it may still be running and its effect is unknown');
    A.eq(r.effectUnknown, true, 'a non-read tool carries effectUnknown for the host ledger');
    A.ok(r.content.indexOf('deaf finished normally') < 0, 'no fabricated normal result');
  }

  // ---- 2. a DEAF read tool: same bound, no effect-unknown claim for a read ----
  {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = reg.dispatch(call('deaf_read'), { signal: ac.signal, cancelGraceMs: 300 });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    A.ok(Date.now() - t0 < 900, 'a deaf read is bounded the same way');
    A.eq([r.isError, r.summary, !!r.effectUnknown], [true, 'cancelled - unconfirmed', false], 'a read is cancelled-unconfirmed without an effect-unknown flag');
    A.ok(/Treat its result as missing/.test(r.content), 'a read says its result is missing');
  }

  // ---- 3. a COOPERATIVE tool still returns ITS OWN result, promptly (well inside the grace) ----
  {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = reg.dispatch(call('polite'), { signal: ac.signal, cancelGraceMs: 3000 });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    const took = Date.now() - t0;
    A.eq([r.ok, r.content], [true, 'stopped cleanly at the signal'], "a cooperative tool's own truthful result is kept");
    A.ok(took < 600, 'the cooperative fast path is NOT slowed to the 3000ms grace (took ' + took + 'ms)');
  }

  // ---- 4. a cooperative tool that needs LONGER than the grace is answered for at the grace ----
  {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = reg.dispatch(call('slow_polite'), { signal: ac.signal, cancelGraceMs: 200 });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    A.ok(Date.now() - t0 < 700, 'the grace bounds a slow wind-down too');
    A.eq(r.summary, 'cancelled - unconfirmed', 'past the grace the host answers for it');
  }

  // ---- 5. the registry-level default grace is injectable, and absent any cancel nothing changes ----
  {
    const reg2 = makeRegistry({ cancelGraceMs: 150 });
    reg2.register({ impact: 'none', name: 'deaf', scope: 'execute', schema: { type: 'object' }, run: async () => { await sleep(1200); return 'late'; } });
    reg2.register({ impact: 'none', name: 'quick', scope: 'write', schema: { type: 'object' }, run: async () => 'ok' });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = reg2.dispatch(call('deaf'), { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    A.ok(Date.now() - t0 < 600 && r.summary === 'cancelled - unconfirmed', 'makeRegistry({ cancelGraceMs }) sets the default grace');
    // a never-cancelled run: normal result, and no abort listener left on the shared parent signal
    const parent = new AbortController();
    for (let i = 0; i < 10; i++) {
      const ok = await reg2.dispatch(call('quick', 'q' + i), { signal: parent.signal });
      if (!ok.ok) A.ok(false, 'an uncancelled call must succeed');
    }
    const { getEventListeners } = require('events');
    A.eq(getEventListeners(parent.signal, 'abort').length, 0, 'settled calls detach every parent abort listener (grace race included)');
    // an already-aborted signal is still refused at the door (unchanged)
    const dead = new AbortController(); dead.abort();
    const refused = await reg2.dispatch(call('quick'), { signal: dead.signal });
    A.eq(refused.summary, 'skipped - cancelled', 'an already-aborted run is still refused before the tool runs');
  }

  // ---- 6. the tool's OWN timeout still wins when it fires first (no double answer) ----
  {
    const reg3 = makeRegistry();
    reg3.register({ impact: 'none', name: 'hang', scope: 'write', timeoutMs: 80, schema: { type: 'object' }, run: () => new Promise(() => {}) });
    const ac = new AbortController();
    const r = await reg3.dispatch(call('hang'), { signal: ac.signal, cancelGraceMs: 5000 });
    A.eq([r.summary, r.effectUnknown], ['timeout', true], 'a per-tool timeout still resolves as a timeout (effect unknown for a write)');
  }

  await sleep(1300);   // let the deaf tools' own timers drain before exit so nothing outlives the test
  A.report('registry.cancel-races-deaf-tool.test');
})().catch(e => { console.log('FAIL: registry.cancel-races-deaf-tool.test threw — ' + (e && e.stack || e)); process.exit(1); });
