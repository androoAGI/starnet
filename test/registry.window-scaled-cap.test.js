/* node test/registry.window-scaled-cap.test.js — tool output is a SHARE OF THE MODEL'S WINDOW, not a fixed count.

   The registry's per-result cap was 80,000 characters and loop.js's per-turn cap 200,000, whatever the model:
   probed at 29bb21d80, a 500 KB result on a 32k-token model left 80,288 characters visible (~63% of the window;
   three in parallel ~94%), and an 8k model got the same ~20k tokens. The reference harness sizes both from the
   window — 15% per result, 30% per turn, floors 8,000 / 16,000 characters — and so does this now
   (tools/registry.js outputBudgetFor; the host passes ctx.outputMax and limits.turnOutputMax).

   Pinned: the budget arithmetic (with its floors and ceilings), that a dispatch honours a host budget (number or
   live thunk) with head AND tail kept and the parked path named, that an unknown window is the old cap exactly,
   that the per-turn cut stays inside 30%, and that a result the turn cut shortens is now parked first. */
'use strict';
const A = require('./_assert.js');
const { makeRegistry, outputBudgetFor, outputWindowFor, OUTPUT_MAX } = require('../sidecar/tools/registry.js');
const { CHARS_PER_TOKEN } = require('../sidecar/context.js');
const { _internals } = require('../sidecar/loop.js');

const HEAD = 'HEAD-OF-OUTPUT:';
const TAIL = ':END-OF-OUTPUT exit 0';
const big = (n) => HEAD + 'x'.repeat(n - HEAD.length - TAIL.length) + TAIL;
const openCtx = (extra) => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', timeoutMs: 5000 }, extra || {});

function parker() {
  const saved = [];
  let seq = 0;
  return {
    saved,
    parkOutput: async (content, meta) => { const path = '.output/' + ((meta && meta.tool) || 'tool') + '-' + (seq++) + '.txt'; saved.push({ path, content, meta }); return { path }; }
  };
}
function regWith(text) {
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_read', scope: 'read', schema: { type: 'object', properties: { p: { type: 'string' } } }, run: async (a) => (typeof text === 'function' ? text(a) : text) });
  return reg;
}

(async () => {
  // ---- 1. THE ARITHMETIC: 15% / 30% of the window, in the estimator's characters, floored and ceilinged ----
  {
    A.eq(CHARS_PER_TOKEN, 4, 'the ruler is context.js\'s estimator ratio (4 chars/token)');
    const b32 = outputBudgetFor(32768);
    A.eq(b32.resultMax, Math.floor(32768 * 0.15 * 4), '32k window: per-result cap is 15% of the window in characters (19,660)');
    A.eq(b32.turnMax, Math.floor(32768 * 0.30 * 4), '32k window: per-turn cap is 30% of the window (39,321)');
    A.ok(b32.resultMax / CHARS_PER_TOKEN <= 0.15 * 32768, 'a 32k result budget is <= 15% of the window in tokens');
    A.ok(b32.turnMax / CHARS_PER_TOKEN <= 0.30 * 32768, 'a 32k turn budget is <= 30% of the window in tokens');
    const b8 = outputBudgetFor(8192);
    A.eq(b8.resultMax, 8000, '8k window: 15% (4,915 chars) is under the floor, so the 8,000-char floor binds');
    A.eq(b8.turnMax, 16000, '8k window: the 16,000-char per-turn floor binds');
    const huge = outputBudgetFor(1000000);
    A.eq([huge.resultMax, huge.turnMax], [OUTPUT_MAX, 200000], 'a huge window is ceilinged at the old caps (byte-identical there)');
    const cold = outputBudgetFor(0);
    A.eq([cold.known, cold.resultMax, cold.turnMax], [false, OUTPUT_MAX, 200000], 'an unknown window (cold catalog, 0) keeps the old caps exactly');
    A.eq(outputBudgetFor('garbage').resultMax, OUTPUT_MAX, 'a non-numeric window is treated as unknown');
  }

  // ---- 2. A HOST BUDGET BINDS THE DISPATCH: 500 KB on a 32k window ----
  {
    const cap = outputBudgetFor(32768).resultMax;
    const p = parker();
    const huge = big(500000);
    const r = await regWith(huge).dispatch({ id: 'c1', name: 'fs_read', args: { p: 'x' } }, openCtx({ outputMax: cap, parkOutput: p.parkOutput }));
    A.ok(r.ok, 'the read still succeeds');
    A.ok(r.content.length <= cap, 'EVERYTHING visible (head + note + tail) fits the 15% budget: ' + r.content.length + ' <= ' + cap + ' (was 80,288)');
    A.ok(r.content.length >= cap - 700, 'and the budget is used, not wasted (' + r.content.length + ')');
    A.ok(r.content.startsWith(HEAD), 'the HEAD of the output is kept');
    A.ok(r.content.endsWith(TAIL), 'the TAIL is kept — an exit line lives at the end of command output');
    A.eq(p.saved.length, 1, 'the full output was parked once');
    A.eq(p.saved[0].content.length, huge.length, 'the parked copy is the WHOLE 500 KB, taken before the clamp');
    A.ok(r.content.indexOf(p.saved[0].path) >= 0, 'the parked path is named in what the model sees');
    A.eq(r.parkedPath, p.saved[0].path, 'and rides on the result for the per-turn re-clamp');
    A.ok(/sized to this model's context window/.test(r.content), 'the note says WHY this cap is smaller than usual');
    A.eq(r.outputChars, huge.length, 'the pre-clamp size is still reported exactly');
  }

  // ---- 3. THE 8k FLOOR ----
  {
    const cap = outputBudgetFor(8192).resultMax;
    const p = parker();
    const r = await regWith(big(500000)).dispatch({ id: 'c2', name: 'fs_read', args: {} }, openCtx({ outputMax: cap, parkOutput: p.parkOutput }));
    A.ok(r.content.length <= 8000, 'an 8k-token model sees at most the 8,000-char floor (' + r.content.length + ', was 80,291)');
    A.ok(r.content.length > 7000, 'but the floor is respected — the result is not shrunk below it');
    A.ok(r.content.startsWith(HEAD) && r.content.endsWith(TAIL), 'head and tail both survive at the floor');
    A.ok(r.content.indexOf(p.saved[0].path) >= 0, 'and the parked path is still named');
  }

  // ---- 4. A LIVE THUNK — a provider fallback can change the window mid-run ----
  {
    let win = 32768;
    const ctx = openCtx({ outputMax: () => outputBudgetFor(win).resultMax, parkOutput: parker().parkOutput });
    const reg = regWith(() => big(300000));
    const a = await reg.dispatch({ id: 't1', name: 'fs_read', args: {} }, ctx);
    win = 8192;
    const b = await reg.dispatch({ id: 't2', name: 'fs_read', args: {} }, ctx);
    A.ok(a.content.length <= 19660 && a.content.length > 18000, 'the thunk is read per dispatch (32k window: ' + a.content.length + ')');
    A.ok(b.content.length <= 8000, 'and re-read after the window shrank (8k window: ' + b.content.length + ')');
    const thrower = await reg.dispatch({ id: 't3', name: 'fs_read', args: {} }, openCtx({ outputMax: () => { throw new Error('boom'); } }));
    A.ok(thrower.ok && thrower.content.length > 80000 && thrower.content.length <= 81000, 'a thunk that throws falls back to the old cap instead of failing the tool');
  }

  // ---- 5. UNKNOWN WINDOW = TODAY'S CAP, byte-for-byte shape (note additive, 70/30 split) ----
  {
    const p = parker();
    const r = await regWith(big(500000)).dispatch({ id: 'c3', name: 'fs_read', args: {} }, openCtx({ parkOutput: p.parkOutput }));
    const note = r.content.slice(Math.floor(OUTPUT_MAX * 0.7), r.content.length - (OUTPUT_MAX - Math.floor(OUTPUT_MAX * 0.7)));
    A.ok(r.content.length > OUTPUT_MAX && r.content.length <= OUTPUT_MAX + 600, 'no host budget: the 80k cap with the note ADDITIVE, as before (' + r.content.length + ')');
    A.ok(/^\n\n\[\.\.\. \d+ characters elided here by the host output cap\. Full size/.test(note), 'the old note text, in the old place, with no window wording');
    A.ok(r.content.startsWith(HEAD) && r.content.endsWith(TAIL), 'head and tail kept');
    A.ok(r.content.indexOf(p.saved[0].path) >= 0, 'parked path named');
    const zero = await regWith(big(200000)).dispatch({ id: 'c4', name: 'fs_read', args: {} }, openCtx({ outputMax: 0 }));
    A.ok(zero.content.length > OUTPUT_MAX, 'outputMax 0 means "no host budget", never "cap at zero"');
    const bigWin = await regWith(big(500000)).dispatch({ id: 'c4b', name: 'fs_read', args: {} }, openCtx({ outputMax: () => outputBudgetFor(200000).resultMax, parkOutput: parker().parkOutput }));
    A.eq(bigWin.content.length, r.content.length, 'a 200k-token window (budget = the 80k ceiling) is byte-for-byte the old result shape');
    A.ok(!/context window/.test(bigWin.content), 'and carries no window wording');
  }

  // ---- 6. A RESULT THAT FITS IS UNTOUCHED under a host budget ----
  {
    const small = 'y'.repeat(5000);
    const r = await regWith(small).dispatch({ id: 'c5', name: 'fs_read', args: {} }, openCtx({ outputMax: 8000, parkOutput: parker().parkOutput }));
    A.eq(r.content, small, 'under the budget -> byte-identical');
    A.eq(r.parkedPath, null, 'and nothing is parked');
  }

  // ---- 7. THE TOOL SEES THE BUDGET IT WILL BE HELD TO (aggregating tools fit themselves to it) ----
  {
    let seen = null;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'peek', schema: { type: 'object', properties: {} }, run: async (a, ctx) => { seen = ctx.outputMax; return 'ok'; } });
    await reg.dispatch({ id: 'p1', name: 'peek', args: {} }, openCtx({ outputMax: () => 12345 }));
    A.eq(seen, 12345, 'a thunk budget reaches the tool as a plain number');
    await reg.dispatch({ id: 'p2', name: 'peek', args: {} }, openCtx());
    A.eq(seen, OUTPUT_MAX, 'no host budget -> the tool is told the default cap');
  }

  // ---- 8. PER TURN: three parallel 500 KB reads stay inside 30% of the window ----
  for (const win of [32768, 8192]) {
    const b = outputBudgetFor(win);
    const p = parker();
    const reg = regWith(big(500000));
    const calls = [0, 1, 2].map(i => ({ id: 'k' + i, name: 'fs_read', args: { p: 'f' + i }, argsRaw: JSON.stringify({ p: 'f' + i }) }));
    const capCtx = openCtx({ outputMax: b.resultMax, parkOutput: p.parkOutput });
    const results = await _internals.executeCalls(calls, (c, ctx) => reg.dispatch(c, ctx), capCtx, () => {}, { agentId: 'a', runId: 'r', parallelSafe: () => true, turnOutputMax: b.turnMax });
    const total = results.reduce((n, r) => n + r.content.length, 0);
    A.ok(total <= b.turnMax, win + '-token window: the turn carries ' + total + ' chars <= 30% budget ' + b.turnMax + ' (was ~241k)');
    A.ok(results.every(r => r.content.startsWith(HEAD) && r.content.endsWith(TAIL)), win + ': every result keeps its head and tail after the turn cut');
    A.ok(results.every(r => r.parkedPath && r.content.indexOf(r.parkedPath) >= 0), win + ': every result still names its parked full output');
  }

  // ---- 9. THE TURN CUT PARKS WHAT IT SHORTENS. Three 15k results each fit the 32k per-result budget (so the
  //         registry parks none), but together overflow the 30% turn budget: each is now saved whole first. ----
  {
    const b = outputBudgetFor(32768);
    const p = parker();
    const reg = regWith(big(15000));
    const calls = [0, 1, 2].map(i => ({ id: 'm' + i, name: 'fs_read', args: { p: 'g' + i }, argsRaw: '{}' }));
    const results = await _internals.executeCalls(calls, (c, ctx) => reg.dispatch(c, ctx), openCtx({ outputMax: b.resultMax, parkOutput: p.parkOutput }), () => {}, { agentId: 'a', runId: 'r', parallelSafe: () => true, turnOutputMax: b.turnMax });
    A.ok(results.reduce((n, r) => n + r.content.length, 0) <= b.turnMax, 'the turn fits its budget');
    A.eq(p.saved.length, 3, 'each shortened result was parked BEFORE the cut (the old turn cut destroyed the middle unrecoverably)');
    A.ok(p.saved.every(s => s.content.length === 15000 && s.meta && s.meta.tool === 'fs_read'), 'the parked copies are whole and named for their tool');
    A.ok(results.every(r => r.turnClamped && r.content.indexOf(r.parkedPath) >= 0 && /THE FULL OUTPUT OF THIS CALL WAS SAVED/.test(r.content)), 'every squeezed result names its saved file');
    const noParker = await _internals.executeCalls(calls, (c, ctx) => reg.dispatch(c, ctx), openCtx({ outputMax: b.resultMax }), () => {}, { agentId: 'a', runId: 'r', parallelSafe: () => true, turnOutputMax: b.turnMax });
    A.ok(noParker.every(r => r.parkedPath === null && /narrow it/.test(r.content)), 'no parker wired -> the old cut, verbatim');
  }

  // ---- a window the provider NAMED (adopted into the context manager) outranks a larger catalog figure ----
  {
    const COLD = 131072;
    A.eq(outputWindowFor(200000, 100000, COLD), 100000, 'adopted 100k beats the catalog 200k');
    A.eq(outputBudgetFor(outputWindowFor(200000, 100000, COLD)).turnMax, outputBudgetFor(100000).turnMax, 'so the per-turn cap shrinks with it');
    A.eq(outputWindowFor(200000, 200000, COLD), 200000, 'no adoption: the catalog figure, unchanged');
    A.eq(outputWindowFor(32000, 200000, COLD), 32000, 'a live window never RAISES the catalog figure');
    A.eq(outputWindowFor(0, COLD, COLD), 0, 'cold catalog + the cold guess = unknown (the default caps)');
    A.eq(outputWindowFor(0, 60000, COLD), 60000, 'cold catalog + a provider-named window = that window');
    A.eq(outputWindowFor(200000, 0, COLD), 200000, 'no context manager figure: the catalog');
  }

  A.report('registry.window-scaled-cap.test');
})().catch(e => { console.log('FAIL: registry.window-scaled-cap.test threw -- ' + (e && e.stack || e)); process.exit(1); });
