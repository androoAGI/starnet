/* node test/image-spend-truth.test.js — #164, the truth first. An image with no provider figure and no catalog price booked
   $0 and read as a run that cost nothing, and image_generate started whatever the run had already spent. Now:
   a run at a limit never sends the request; a known cost and an unknown one each read as what they are in the tool's
   receipt; and both spend rows mark an unpriced image, so no reader folds it as a proven $0. No price is invented anywhere,
   and one image can still pass a limit that has room left, because its price is not known in advance.
   Zero network: an injected fetch. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const S = require('../sidecar/spend.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const answer = usage => async () => new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: PNG } }] } }], ...(usage ? { usage } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json' } });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-image-spend-'));
  const engine = makeCostEngine();
  const tools = (fetchImpl, extra) => makeImageTools(Object.assign({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root, fetchImpl,
    // index.js recordMediaUsage: the media route has no catalog, so anything without a provider figure is unpriced
    onUsage: (u, m) => { const c = engine.reconcile(u, m); c.unpriced = !c.providerCost; return c; } }, extra));
  const ctx = { agentId: 'agent' };
  try {
    // ---- a run at its limit never starts a generation
    let posts = 0;
    const counting = async (...a) => { posts++; return answer({ cost: 0.05 })(...a); };
    let refused = '';
    try { await tools(counting, { spendStop: () => 'this run has spent $0.35 of its $0.35 spending limit' }).generateTool.run({ prompt: 'a cat' }, ctx); } catch (e) { refused = e.message; }
    A.ok(/did not start: this run has spent \$0\.35 of its \$0\.35 spending limit/.test(refused) && /nothing was charged/.test(refused), 'the refusal says why and that nothing was charged: ' + refused);
    A.eq(posts, 0, 'no request went out');
    // the ChatGPT plan is flat-rate: it books nothing, so a dollar limit is not its gate
    let asked = 0;
    const codex = tools(async () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'image_generation_call', result: PNG.split(',')[1] }] } }) + '\n\n', { status: 200 }),
      { openrouter: { protocol: 'codex-responses', getToken: async () => 'tok' }, spendStop: () => { asked++; return 'stop'; } });
    await codex.generateTool.run({ prompt: 'a cat' }, ctx);
    A.eq(asked, 0, 'a plan render is not stopped by a dollar limit');

    // ---- a known cost, an unknown one
    const known = await tools(answer({ cost: 0.067 })).generateTool.run({ prompt: 'a cat' }, ctx);
    A.ok(/Cost: \$0\.0670 \(the provider's figure\), counted toward the spending limits/.test(known.content), 'a provider figure is quoted: ' + known.content);
    for (const usage of [null, { prompt_tokens: 5, completion_tokens: 5 }]) {
      const unknown = await tools(answer(usage)).generateTool.run({ prompt: 'a cat' }, ctx);
      A.ok(/Cost: UNKNOWN\./.test(unknown.content) && /adds nothing to the spending limits/.test(unknown.content) && /cannot stop images like this one/.test(unknown.content) && /Do not describe it as free/.test(unknown.content), 'no figure reads as unknown: ' + unknown.content);
      A.ok(!/\$0(?:\.0+)?\b/.test(unknown.content), 'and never as $0: ' + unknown.content);
    }
    const plain = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root, fetchImpl: answer({ cost: 1 }) }).generateTool.run({ prompt: 'a cat' }, ctx);
    A.ok(!/Cost:/.test(plain.content), 'with no booking host, nothing is claimed');

    // ---- the verdict
    A.eq(S.mediaSpendStop({ spentUsd: 0.1, pendingUsd: 0.1, capUsd: 0.35 }), '', 'room left: it may start');
    A.ok(/\$0\.35 of its \$0\.35/.test(S.mediaSpendStop({ spentUsd: 0.3, pendingUsd: 0.05, capUsd: 0.35 })), 'an undrained image in the same turn counts');
    A.eq(S.mediaSpendStop({ spentUsd: 9, capUsd: Infinity }), '', 'no per-run limit');
    A.ok(/day spending limit is reached \(\$2\.00 of \$2\.00\)/.test(S.mediaSpendStop({ spentUsd: 0, verdict: { scope: 'day', usd: 2, cap: 2 } })), 'the cross-run answer names its limit');
    A.ok(/can.t be checked/.test(S.mediaSpendStop({ verdict: { unknown: true } })), 'limits that cannot be checked stop it, as they stop a model call');

    // ---- the host's check, over the REAL pool (index.js hands it these same parts)
    const { makeRunSpendPool } = require('../sidecar/run-spend-pool.js');
    const family = (cap, overrides) => {
      const pool = makeRunSpendPool({ capUsd: cap });
      pool.join('a'); pool.join('b');
      const run = (id, state) => S.makeMediaSpendCheck(Object.assign({ runId: id, pool, unmetered: false,
        readView: () => ({ spentUsd: state.spent, maxCostUsd: state.max == null ? Infinity : state.max }),
        pendingUsd: () => state.pending, mediaUsd: () => state.spent + state.pending, crossRun: () => null }, overrides));
      return { pool, run };
    };
    {
      // the review's numbers: two $0.20 images in one turn under a $0.50 cap
      const { pool, run } = family(0.5);
      const a = { spent: 0, pending: 0 }, check = run('a', a);
      A.eq(await check(), '', 'the first image starts');
      a.pending = 0.2;
      A.eq(await check(), '', 'the second image starts: $0.20 of $0.50');
      a.pending = 0.4;
      A.eq(pool.status().spentUsd, 0, 'the pool was told nothing the loop has not booked');
      pool.booked('a', 0.2); pool.booked('a', 0.2); a.spent = 0.4; a.pending = 0;
      A.eq(Number(pool.status().spentUsd.toFixed(6)), 0.4, 'the drained charges count once: $0.40, was $0.60');
      A.eq(await check(), '', 'and a third may still start');
      a.pending = 0.1;
      A.ok(/run spending limit is reached \(\$0\.50 of \$0\.50\)/.test(await check()), 'a pending charge reaching the family cap stops the next one, read-only: pool still says ' + pool.status().spentUsd);
    }
    {
      // two workers under a real cap: the second waits for the first, and neither is refused
      const { pool, run } = family(5);
      const a = { spent: 0, pending: 0 }, b = { spent: 0, pending: 0 };
      A.eq(await run('a', a)(), '', 'worker a starts');
      let answered = null;
      const waiting = run('b', b)().then(v => { answered = v; });
      await new Promise(r => setTimeout(r, 20));
      A.eq(answered, null, 'worker b waits while a\'s image is in flight: it has no price, so it counts as a call');
      pool.booked('a', 0.2);
      await waiting;
      A.eq(answered, '', 'and starts once it settled: nobody was refused');
      // the same wait ends when the run is aborted
      const c = new AbortController();
      let gone = null;
      const stopped = run('a', a)(c.signal).then(v => { gone = v; });
      await new Promise(r => setTimeout(r, 20));
      A.eq(gone, null, 'a in turn waits for b');
      c.abort();
      await stopped;
      A.ok(/stopped while it waited/.test(gone), 'an abort ends the wait: ' + gone);
    }
    {
      // a day limit's answer withdraws the generation; a subscription chat asks with media dollars only
      const { pool } = family(5);
      const asked = [];
      const day = S.makeMediaSpendCheck({ runId: 'a', pool, unmetered: false, readView: () => ({ spentUsd: 0.1, maxCostUsd: Infinity }), pendingUsd: () => 0.05, mediaUsd: () => 0.15, crossRun: s => { asked.push(s); return { scope: 'day', usd: 2, cap: 2 }; } });
      A.ok(/day spending limit/.test(await day()), 'the day limit stops it');
      A.eq(asked.map(n => Number(n.toFixed(6))), [0.15], 'with what the run booked plus what is pending');
      A.eq(pool.status().inFlight, 0, 'and it is not left in flight, holding the family');
      const planAsked = [];
      const plan = S.makeMediaSpendCheck({ runId: 'p', pool, unmetered: true, readView: () => ({ spentUsd: 3.5, maxCostUsd: Infinity }), pendingUsd: () => 0.05, mediaUsd: () => 0.25, crossRun: s => { planAsked.push(s); return null; } });
      A.eq(await plan(), '', 'a subscription chat with no per-run limit: only the cross-run limits can stop it');
      A.eq(planAsked, [0.25], 'and they hear media dollars, never the plan\'s token estimate');
      const broken = S.makeMediaSpendCheck({ runId: 'q', pool, unmetered: true, readView: () => null, pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => { throw new Error('ledger down'); } });
      A.ok(/can.t be checked/.test(await broken()), 'limits that cannot be read stop it');
    }

    // ---- the rows
    A.eq(S.mediaRunFlags({ runUnmetered: false, mediaUsd: 0, mediaUnpriced: 1, runUnpriced: false }), { unmetered: false, unpriced: true }, 'an unpriced image on a metered run marks the row');
    A.eq(S.mediaRunFlags({ runUnmetered: true, mediaUsd: 0, mediaUnpriced: 1 }), { unmetered: true, unpriced: true }, 'a subscription run stays one, and the row still marks the image');
    A.eq(S.mediaRunFlags({ runUnmetered: true, mediaUsd: 0.2, mediaUnpriced: 0 }), { unmetered: false, unpriced: false }, 'a priced image on a plan run is real dollars, as before');
    // the review's row: a plan run on gpt-6.1-sol with one unknown image
    {
      const { foldInsights } = require('../sidecar/insights.js');
      const flags = S.mediaRunFlags({ runUnmetered: true, mediaUsd: 0, mediaUnpriced: 1 });
      const fold = foldInsights([Object.assign({ agentId: 'a', model: 'gpt-6.1-sol', usd: 0, tokens: 90000, promptTokens: 60000, completionTokens: 30000, reason: 'done', at: 1 }, flags)], { now: 2 });
      const row = (fold.byModel || fold.models || [])[0] || {};
      A.eq([row.spendLabel, row.unmeteredRuns, row.unmeteredTokens], ['subscription / unmetered', 1, 90000], 'it still folds as a plan run: ' + JSON.stringify(row));
      A.eq(fold.unmeteredRuns, 1, 'in the totals too');
    }
    // /api/runs hands the recap this flag: the run store keeps it, on both kinds of row
    {
      const runstore = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'runstore.js'), 'utf8');
      A.ok(/e\.unpriced === true \? \{ unpriced: true \}/.test(runstore), 'the run row keeps unpriced');
    }
    A.eq(S.mediaRunFlags({ runUnmetered: true, mediaUsd: 0, mediaUnpriced: 0 }), { unmetered: true, unpriced: false }, 'a plain subscription run is unchanged');
    A.eq(S.mediaRunFlags({ runUnmetered: false, mediaUsd: 0.1, mediaUnpriced: 0, runUnpriced: true }), { unmetered: false, unpriced: true }, 'unpriced chat tokens keep their flag');

    // ---- the seam: the loop's own figures reach the host, live
    const view = {}, pending = [];
    let during = null;
    const provider = { async *stream() {
      if (view.calls++) { yield { type: 'done', finishReason: 'stop' }; return; }
      yield { type: 'tool_start', index: 0, id: 't', name: 'image_generate' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { cost: 0.01 } };
      yield { type: 'done', finishReason: 'tool_calls' };
    } };
    view.calls = 0;
    await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit: () => {}, cost: makeCostEngine(), model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 3, maxCostUsd: 0.35 },
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' }, drainToolCosts: () => pending.splice(0), spendView: view,
      dispatch: async () => { during = view.read(); return { ok: true, content: 'ok', summary: 'ok' }; } });
    A.eq(during, { spentUsd: 0.01, maxCostUsd: 0.35 }, 'a tool mid-turn reads what the run has booked and its limit');

    // ---- the host wiring and the page's words, source-locked (runOnceCore cannot run here)
    const idx = require('./helpers/source').readSidecarSource();
    A.ok(/const mediaSpend = makeMediaSpendCheck\(\{ runId, pool: spendPool, unmetered: providerUnmetered,/.test(idx) && /crossRun: spent => budget\.check\(runId, agentId, spent, Date\.now\(\), emit, runReceiptMeta\)/.test(idx), 'the host hands the check its real pool and budget');
    A.ok(!/spendPool\.admit\([^)]*pending/i.test(idx) && !/runBudget\.check\(spentUsd \+ pendingUsd/.test(idx), 'and nothing tells the pool a pending charge');
    A.ok(/if \(name === 'agent\.cost' && !providerUnmetered\) spendPool\.booked\(runId, Number\(payload\.usd\) \|\| 0\);/.test(idx), 'the one place a charge reaches the pool');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
    A.ok(/Images whose cost is unknown are not limited/.test(ui) && /On a subscription chat this one does not apply/.test(ui), 'SETTINGS says plainly what the limits cannot stop');
    A.ok(/onUsage: recordMediaUsage, spendStop: mediaSpend,/.test(idx) && /drainToolCosts: \(\) => pendingMediaCosts\.splice\(0\), spendView,/.test(idx), 'runOnce wires the check and the view');
    A.ok(/unmetered: mediaFlags\.unmetered, unpriced: mediaFlags\.unpriced, usageMissing \}\); \} catch/.test(idx) && /reasoningEffort, unmetered: mediaFlags\.unmetered, unpriced: mediaFlags\.unpriced, usageMissing, spendUnknown/.test(idx), 'both spend rows carry the flags');
    const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    const start = chat.indexOf('function fmtRecapCost'), fn = chat.slice(start, chat.indexOf('function fmtBytes', start));
    const recap = new Function('U', fn + '; return fmtRecapCost;')({ usd: n => '$' + n.toFixed(2) });
    A.eq(recap({ usd: 0, unpriced: true }), 'cost unknown', 'the run recap never reads an unknown image as nothing');
    A.eq(recap({ usd: 0.3, unpriced: true }), 'at least $0.30 (some cost unknown)', 'and never as a whole figure');
    A.eq(recap({ usd: 0.3 }), '$0.30', 'a known figure is unchanged');
    A.eq(recap({ unmetered: true, usd: 0, unpriced: true }), 'subscription, image cost unknown', 'a plan run stays a plan run, and says what it does not know');
    A.eq(recap({ unmetered: true, usd: 0 }), 'subscription', 'a plain plan run is unchanged');
    A.eq(recap({ usd: 0 }), '', 'a free run still shows nothing');
    const image = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'image.js'), 'utf8');
    A.ok(/Default model: DEFAULT_IMAGE_MODEL below, google\/gemini-3\.1-flash-image/.test(image) && /const DEFAULT_IMAGE_MODEL\s+= 'google\/gemini-3\.1-flash-image'/.test(image), 'the header comment names the real default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.report('image-spend-truth.test');
})().catch(e => { console.log('FAIL: image-spend-truth.test threw -- ' + (e && e.stack || e)); process.exit(1); });
