/* node test/loop.image-eviction.test.js — OLD SCREENSHOTS AGE OUT OF WHAT IS SENT.

   Tool screenshots enter the conversation as image_url user turns (loop.js SCREENSHOTS AS PIXELS) and were never
   evicted: every capture rode every later request for the rest of the run (~1,500 tokens each). Now only the
   newest TOOL_IMAGE_KEEP (default 2) capture turns stay as pixels in the REQUEST; each older one is replaced by a
   one-line placeholder naming what was dropped (how many images, which tool, which turn).

   It is a VIEW, never an edit: `messages` (what the durable transcript, the run journal and compaction read)
   keeps every capture exactly as pushed, so the durable transcript is unaffected — checked here by draining the
   run's messages through the real transcript store. */
'use strict';
const A = require('./_assert.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

// a distinct valid 1x1 PNG per capture is overkill; distinct base64 TAILS identify each capture in the request
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const shotData = (n) => PNG.slice(0, -4) + 'AAA' + String.fromCharCode(65 + n) + '==';   // stays base64-shaped
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });

// `n` turns that each take one screenshot, then a final answer
function shotsFixture(n, usage) {
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push([{ type: 'tool_start', index: 0, id: 's' + i, name: 'browser_screenshot' },
      { type: 'tool_args', index: 0, chunk: JSON.stringify({ n: i }) }]
      .concat(usage ? [{ type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 5 } }] : [], [{ type: 'done', finishReason: 'tool_calls' }]));
  }
  turns.push([{ type: 'text', delta: 'done looking' }, { type: 'done', finishReason: 'stop' }]);
  return { turns };
}
async function run(o) {
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  const replay = makeReplayProvider(shotsFixture(o.shots, !!o.context));
  const requests = [];
  // snapshot each request: with nothing to evict req.messages IS the live working array, which keeps growing
  const provider = Object.assign({}, replay, { stream: (req) => { requests.push(req.messages.slice()); return replay.stream(req); } });
  const reg = makeRegistry();
  reg.register({ impact: 'none',
    name: 'browser_screenshot', schema: { type: 'object', properties: { n: { type: 'number' } } },
    run: async (a) => ({ content: 'Screenshot ' + a.n + ' saved to shots/' + a.n + '.png', summary: 'shot', images: [{ mime: 'image/png', data: shotData(a.n) }] })
  });
  const messages = (o.prefix || []).concat([{ role: 'user', content: 'look at the page' }]);
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: [],
    limits: Object.assign({ maxIters: 20, grace: false }, o.limits || {}),
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), toolImages: true, context: o.context
  });
  return { res, requests, messages };
}
const pixelTurns = (msgs) => msgs.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p && p.type === 'image_url'));
const placeholders = (msgs) => msgs.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.indexOf('[earlier screen capture removed from view') === 0);
const shotIds = (msgs) => pixelTurns(msgs).map(m => m.content.find(p => p.type === 'image_url').image_url.url.slice(-3, -2)).join('');

(async () => {
  // ---- 1. FIVE CAPTURES: the final request carries only the newest TWO as pixels ----
  {
    const { res, requests, messages } = await run({ shots: 5 });
    A.eq(res.reason, 'done', 'the run completes');
    A.eq(requests.length, 6, 'six model calls (5 screenshot turns + the answer)');
    const last = requests[5];
    A.eq(pixelTurns(last).length, 2, 'the last request carries pixels for only 2 capture turns (it carried 5)');
    A.eq(shotIds(last), 'DE', 'and they are the NEWEST two (captures 3 and 4)');
    const ph = placeholders(last);
    A.eq(ph.length, 3, 'the 3 older captures became placeholders, in place');
    A.ok(ph.every(m => /1 image \(image\/png, ~1 KB\) returned by browser_screenshot on turn \d/.test(m.content)), 'each placeholder names WHAT was dropped: count, type, size, tool, turn');
    A.ok(/Take a new screenshot/.test(ph[0].content), 'and tells the model how to get the screen back');
    A.eq(last.length, messages.length - 1, 'the request has exactly the working-history shape minus the final answer (nothing dropped or added)');
    A.ok(last.every((m, i) => m.role === messages[i].role), 'message roles and order are unchanged — tool pairing is untouched');
    // the view is monotone: once evicted, a capture's placeholder is identical on every later request (prompt cache)
    A.eq(placeholders(requests[4])[0].content, ph[0].content, 'an evicted capture\'s placeholder is byte-stable across turns');
    A.eq(pixelTurns(requests[2]).length, 2, 'with two captures so far nothing is evicted yet');
    A.eq(placeholders(requests[2]).length, 0, '(no placeholder before the third capture)');

    // THE DURABLE RECORD IS UNAFFECTED: the loop's messages keep every capture, as pushed
    A.eq(pixelTurns(messages).length, 5, 'the working history still holds all five capture turns (a view, never an edit)');
    A.eq(shotIds(messages), 'ABCDE', 'with their pixels intact');
    const rows = [];
    const store = makeTranscriptStore({ io: { readAll: () => [], append: (r) => rows.push(r) }, clock: { now: () => 1 } });
    store.appendNew('s1', 'a', res.messages);
    const shotRows = rows.filter(r => r.role === 'user' && /BEGIN EXTERNAL SCREEN CAPTURE/.test(r.content));
    A.eq(shotRows.length, 5, 'the transcript records all five capture turns');
    A.ok(!rows.some(r => /removed from view/.test(r.content)), 'and never a placeholder — the durable transcript is exactly what it was');
  }

  // ---- 2. KNOBS: keep 1 / keep 0 / eviction off ----
  {
    const one = await run({ shots: 4, limits: { toolImageKeep: 1 } });
    A.eq(pixelTurns(one.requests[4]).length, 1, 'limits.toolImageKeep: 1 keeps one capture as pixels');
    A.ok(/Only the 1 most recent screen capture stays visible/.test(placeholders(one.requests[4])[0].content), 'the placeholder states the real keep count');
    const none = await run({ shots: 3, limits: { toolImageKeep: 0 } });
    A.eq(pixelTurns(none.requests[3]).length, 0, 'toolImageKeep: 0 sends no pixels at all (text-only view)');
    const off = await run({ shots: 4, limits: { toolImageKeep: false } });
    A.eq(pixelTurns(off.requests[4]).length, 4, 'toolImageKeep: false disables eviction (every capture rides, the old behavior)');
  }

  // ---- 3. ONLY TOOL CAPTURES AGE OUT: the Commander's own attached image is the directive, never evicted ----
  {
    const attachment = { role: 'user', content: [{ type: 'text', text: 'here is the mockup' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] };
    const { requests } = await run({ shots: 4, prefix: [attachment] });
    const last = requests[requests.length - 1];
    A.ok(last[0] === attachment, 'the Commander attachment rides untouched (same object) in every request');
    A.eq(pixelTurns(last).length, 3, 'attachment + the newest two captures carry pixels');
  }

  // ---- 4. NO CAPTURES -> the request IS the working array (byte-identical for every ordinary run) ----
  {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
    A.ok(_internals.evictStaleScreenshots(msgs, 2) === msgs, 'no capture turns -> the same array object is returned');
    const caps = [0, 1, 2].map(i => ({ role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE — x]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] }));
    A.ok(_internals.evictStaleScreenshots(caps.slice(0, 2), 2) !== null && _internals.evictStaleScreenshots(caps.slice(0, 2), 2).length === 2, 'two captures under keep=2 -> unchanged');
    const v = _internals.evictStaleScreenshots(caps, 2);
    A.ok(v !== caps && caps[0].content.length === 2, 'eviction builds a NEW array and never mutates the originals');
    A.ok(typeof v[0].content === 'string' && v[1] === caps[1] && v[2] === caps[2], 'only the stale capture is replaced; newer ones are the same objects');
    A.ok(/returned by|screen capture removed/.test(v[0].content) && /1 image/.test(v[0].content), 'without run metadata the placeholder still names the dropped image');
  }

  // ---- 5. THE LOOP'S OWN ESTIMATES MEASURE WHAT IS SENT. Compaction (and the overflow classifier) estimate the
  //         prompt through context.estimateMessages; now that an image is charged ~1,500 tokens, counting captures
  //         the provider never receives would skew every fold decision. The loop hands the manager the same view. ----
  {
    const seen = [];
    const imagesIn = (msgs) => msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'image_url').length : 0), 0);
    const context = {
      estimateMessages: (msgs) => { seen.push(imagesIn(msgs)); return 1000; },   // flat: the fold never "shrinks", so history is untouched
      shouldCompact: () => true, thresholdTokens: () => 0,
      planCompaction: (h) => ({ older: h.slice(0, 1), tail: h.slice(1) })
    };
    const { res, messages } = await run({ shots: 5, context });
    A.eq(res.reason, 'done', 'the run completes with a context manager attached');
    A.ok(seen.length >= 4, 'the manager was asked to estimate the prompt on later turns (' + seen.length + ' calls)');
    A.ok(Math.max.apply(null, seen) <= 2, 'every estimate saw at most the 2 images actually sent (max seen ' + Math.max.apply(null, seen) + ', messages hold ' + imagesIn(messages) + ')');
  }

  A.report('loop.image-eviction.test');
})().catch(e => { console.log('FAIL: loop.image-eviction.test threw -- ' + (e && e.stack || e)); process.exit(1); });
