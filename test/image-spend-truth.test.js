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
      const stopped = run('a', a)({ signal: c.signal }).then(v => { gone = v; });
      await new Promise(r => setTimeout(r, 20));
      A.eq(gone, null, 'a in turn waits for b');
      c.abort();
      await stopped;
      A.ok(/stopped while it waited/.test(gone.why), 'an abort ends the wait: ' + gone.why);
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
    {
      // #158 fallback: a plan run that moves onto a key is metered from its next image on, so the run cap holds it
      const { makeRunSpendPool } = require('../sidecar/run-spend-pool.js');
      const atCap = () => { const p = makeRunSpendPool({ capUsd: 0.25 }); p.join('f'); p.admit('f', 0, 0); p.booked('f', 0.3); return p; };
      let onPlan = true;
      const pool = atCap();
      const opts = (unmetered, extra) => Object.assign({ runId: 'f', pool, unmetered, holdMaxMs: 500, readView: () => ({ spentUsd: 0.3, maxCostUsd: Infinity }), pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null }, extra);
      const live = S.makeMediaSpendCheck(opts(() => onPlan));
      A.eq(await live(), '', 'on the plan the run cap does not apply: only the cross-run limits ask');
      live.end({ unknown: 0, charged: true });
      onPlan = false;   // onFallback: runUnmetered = runUnmetered && providerUnmetered
      const held = await live();
      A.ok(/spending limit/.test(held), 'after the fallback the same check is held to the run cap: ' + JSON.stringify(held));
      A.eq([pool.status().inFlight, pool.mediaCount().running], [0, 0], 'and the refused call leaves nothing behind');
      A.eq(await S.makeMediaSpendCheck(opts(true, { pool: atCap() }))(), '', 'a plain boolean still works (this is the value a stale copy kept)');
      A.ok(/spending limit/.test(await S.makeMediaSpendCheck(opts(false, { pool: atCap() }))()), 'and false is metered');
      const errs = [];
      const odd = await S.makeMediaSpendCheck(opts(() => { throw new Error('gone'); }, { pool: atCap(), onCheckError: e => errs.push(e.message) }))();
      A.ok(/spending limit/.test(odd) && errs.includes('gone'), 'a getter that throws reads as metered, and is noted');
      // the end reads the getter too: a metered lead's failed image must give its pool place back, or its worker's next call stays held
      const under = makeRunSpendPool({ capUsd: 5 });
      under.join('f');
      const failing = S.makeMediaSpendCheck(opts(() => false, { pool: under }));
      A.eq(await failing(), '', 'a metered call under the cap starts');
      A.eq(under.status().inFlight, 1, 'and holds its place in the pool');
      failing.end({ unknown: 0, charged: false });
      A.eq([under.status().inFlight, under.mediaCount().running], [0, 0], 'a call that ends uncharged gives its place back');
    }

    // ---- THE COUNT CAP on images whose cost is unknown, over the real pool
    {
      const make = (cap, extra) => {
        const pool = makeRunSpendPool({ capUsd: Infinity });
        pool.join('a'); pool.join('b');
        // a short hold bound unless a test sets one: a wait nobody expected ends in 500 ms and fails the next assertion, never the clock
        // (500, not less: the gate box runs loaded, and the waits these tests do expect are woken by an end about 15 ms later)
        const check = id => S.makeMediaSpendCheck(Object.assign({ runId: id, pool, unmetered: false, unknownCap: cap, holdMaxMs: 500, readView: () => ({ spentUsd: 0, maxCostUsd: Infinity }), pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null }, extra));
        return { pool, a: check('a'), b: check('b') };
      };
      const tick = () => new Promise(r => setTimeout(r, 15));
      const soon = p => Promise.race([p, new Promise(r => setTimeout(() => r('LATE'), 100))]);   // answered at once, or 'LATE'
      A.eq(S.MEDIA_UNKNOWN_COST_MAX, 10, 'the default');
      A.eq(S.makeMediaSpendCheck({ pool: makeRunSpendPool({}), unknownCap: NaN }).unknownCap, 10, 'an unset override (Number(undefined)) is the default');
      A.eq(S.makeMediaSpendCheck({ pool: makeRunSpendPool({}), unknownCap: 3 }).unknownCap, 3, 'a set one is honoured');
      // up to the cap, and at it
      {
        const { pool, a } = make(2);
        A.eq(await a(), '', 'the first starts');
        a.end({ unknown: 1, charged: true });
        A.eq(await soon(a()), '', 'the last one under the cap starts at once: a generation that ended is no longer running');
        a.end({ unknown: 1, charged: true });
        A.eq(pool.mediaCount(), { running: 0, unknown: 2 }, 'both counted');
        const refused = await a();
        A.ok(/generated 2 images whose cost is unknown/.test(refused.why) && /stops at 2 in one run/.test(refused.why), 'at the cap: refused, and says what happened: ' + refused.why);
        A.ok(/start a new run/.test(refused.todo), 'and what to do: ' + refused.todo);
        const atOnce = await soon(a());
        A.ok(atOnce !== 'LATE' && /generated 2 images whose cost is unknown/.test(atOnce.why) && !/still running/.test(atOnce.why), 'at the cap the refusal is at once, never a wait for calls that are not running: ' + JSON.stringify(atOnce));
        A.eq(pool.mediaCount().running, 0, 'a refusal takes no count');
        // over it: a parallel pair can land one past; still refused, with the true number
        pool.mediaEnd(1);
        A.ok(/generated 3 images/.test((await a()).why), 'over the cap: refused too');
        const other = S.makeMediaSpendCheck({ runId: 'b', pool, unknownCap: 2, unmetered: true, holdMaxMs: 500, readView: () => null, pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null });
        A.ok(/generated 3 images/.test((await other()).why), 'the count is the family\'s, so a worker on a plan chat is refused too');
      }
      // priced images do not count
      {
        const { pool, a } = make(1);
        A.eq(await a(), '', 'starts');
        a.end({ unknown: 0, charged: true });
        A.eq(pool.mediaCount(), { running: 0, unknown: 0 }, 'a priced image leaves no count');
        A.eq(await a(), '', 'so the next one starts');
        a.end({ unknown: 0, charged: true });
      }
      // release on failure and on cancel: a call nobody billed leaves no count and no place in the pool
      {
        const { pool, a, b } = make(1);
        A.eq(await a(), '', 'a starts');
        A.eq(pool.status().inFlight, 1, 'and is in flight');
        a.end({ unknown: 0, charged: false });
        A.eq(pool.mediaCount(), { running: 0, unknown: 0 }, 'a failed generation releases its count');
        A.eq(pool.status().inFlight, 0, 'and its place in the pool');
        A.eq(await b(), '', 'so its sibling starts, under a cap of 1');
        b.end({ unknown: 0, charged: false });
      }
      // a sibling in flight waits, never refuses, and the outcome decides
      {
        const { pool, a, b } = make(2);
        A.eq(await a(), '', 'a: one in flight');
        a.end({ unknown: 1, charged: true });
        A.eq(await a(), '', 'a: second, count 1 + running 1 = the cap');
        let said = null;
        const waiting = b().then(v => { said = v; });
        await tick();
        A.eq(said, null, 'b is under the cap with a sibling in flight: it waits, it is not refused');
        a.end({ unknown: 0, charged: false });
        await waiting;
        A.eq(said, '', 'the sibling failed, so b starts');
        said = null;
        const second = a().then(v => { said = v; });
        await tick();
        A.eq(said, null, 'and now a waits on b');
        b.end({ unknown: 1, charged: true });
        await second;
        A.ok(/generated 2 images/.test(said.why), 'b came back unknown: the cap is really reached, so a is refused now');
        A.eq(pool.mediaCount().running, 0, 'and nothing is left running');
      }
      // two workers far under the cap do not touch each other's count
      {
        const { pool, a } = make(10);
        await a(); await a();
        A.eq(pool.mediaCount(), { running: 2, unknown: 0 }, 'parallel calls of one member both count as running');
        a.end({ unknown: 1, charged: true }); a.end({ unknown: 0, charged: true });
        A.eq(pool.mediaCount(), { running: 0, unknown: 1 }, 'and each ends once');
      }
      // the wait is bounded, and the tool's own timeout is paused for exactly that long
      {
        const { a, b } = make(1, { holdMaxMs: 25 });
        A.eq(await a(), '', 'a is in flight, and stays');
        const clock = [];
        const said = await b({ holdTimeout: () => { clock.push('paused'); return () => clock.push('resumed'); } });
        A.ok(/still running after a wait of/.test(said.why) && /No limit was reached/.test(said.todo), 'a wait that outlasts its bound refuses plainly: ' + said.why + ' / ' + said.todo);
        A.eq(clock, ['paused', 'resumed'], 'the tool timeout was paused and resumed once');
        a.end({ unknown: 0, charged: false });
      }
      // a pool hold is bounded by the same timer
      {
        const pool = makeRunSpendPool({ capUsd: 5 });
        pool.join('a'); pool.join('b');
        pool.admit('a', 0, 0);   // a's model call, no price, in flight
        const said = await S.makeMediaSpendCheck({ runId: 'b', pool, unmetered: false, holdMaxMs: 25, readView: () => ({ spentUsd: 0, maxCostUsd: Infinity }), pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null })({});
        A.ok(/still running/.test(said.why), 'a pool hold on a call that never settles ends too');
        A.eq(pool.mediaCount().running, 0, 'and takes no count');
      }
      // a limit that stops an admitted call gives its place back
      {
        const pool = makeRunSpendPool({ capUsd: 5 });
        pool.join('a'); pool.join('b');
        const said = await S.makeMediaSpendCheck({ runId: 'a', pool, unmetered: false, readView: () => ({ spentUsd: 0.3, maxCostUsd: 0.3 }), pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null })();
        A.ok(/spending limit/.test(said), 'the run limit stops it');
        A.eq([pool.status().inFlight, pool.mediaCount().running], [0, 0], 'and it leaves nothing behind');
      }
      // through the tool: the provider's answer decides the count, and every end is reported
      {
        const pool = makeRunSpendPool({ capUsd: Infinity });
        pool.join('t');
        const check = S.makeMediaSpendCheck({ runId: 't', pool, unknownCap: 1, unmetered: false, holdMaxMs: 500, readView: () => null, pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null });
        const withCheck = f => tools(f, { spendStop: check, spendEnd: check.end });
        let threw = '';
        let during = null;
        try { await withCheck(async () => { during = pool.mediaCount().running; return new Response('no', { status: 500 }); }).generateTool.run({ prompt: 'a cat' }, ctx); } catch (e) { threw = e.message; }
        A.ok(threw, 'a provider failure throws');
        A.eq(during, 1, 'it held a count while it ran');
        A.eq(pool.mediaCount(), { running: 0, unknown: 0 }, 'and releases its count');
        const c = new AbortController();
        during = null;
        let cancelled = false;
        await withCheck(async () => { during = pool.mediaCount().running; c.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }).generateTool.run({ prompt: 'a cat' }, Object.assign({}, ctx, { signal: c.signal })).catch(() => { cancelled = true; });
        A.eq([during, cancelled], [1, true], 'a call cancelled mid-generation held a count and ended');
        A.eq(pool.mediaCount(), { running: 0, unknown: 0 }, 'and leaves none');
        const priced = await withCheck(answer({ cost: 0.05 })).generateTool.run({ prompt: 'a cat' }, ctx);
        A.ok(/Cost: \$0\.0500/.test(priced.content), 'a priced image');
        A.eq(pool.mediaCount(), { running: 0, unknown: 0 }, 'is no count');
        const first = await withCheck(answer(null)).generateTool.run({ prompt: 'a cat' }, ctx);
        A.ok(/StarNet stops a run at 1 of them/.test(first.content), 'an unknown image says the count: ' + first.content);
        A.eq(pool.mediaCount(), { running: 0, unknown: 1 }, 'and counts');
        let posted = 0, refused = '';
        try { await withCheck(async (...x) => { posted++; return answer(null)(...x); }).generateTool.run({ prompt: 'a cat' }, ctx); } catch (e) { refused = e.message; }
        A.eq(posted, 0, 'past the cap no request goes out');
        A.ok(/did not start: this run and its workers have generated 1 image whose/.test(refused) && /nothing was charged/.test(refused) && /start a new run/.test(refused) && !/SETTINGS/.test(refused), 'and the refusal is plain, with its own way forward: ' + refused);
        // parallel calls of one tool set never read each other's charges
        const twin = makeRunSpendPool({ capUsd: Infinity });
        twin.join('t');
        const twinCheck = S.makeMediaSpendCheck({ runId: 't', pool: twin, unknownCap: 9, unmetered: false, holdMaxMs: 500, readView: () => null, pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null });
        const both = tools(answer(null), { spendStop: twinCheck, spendEnd: twinCheck.end });
        await Promise.all([both.generateTool.run({ prompt: 'one' }, ctx), both.generateTool.run({ prompt: 'two' }, ctx)]);
        A.eq(twin.mediaCount(), { running: 0, unknown: 2 }, 'two parallel unknown images count as two, not four');
      }
    }

    // ---- THE STATION'S 24 HOURS, over the real spend log and the real pool
    {
      const { makeLedger } = require('../sidecar/ledger.js');
      const HOUR = 3600000;
      let clockNow = 10 * 24 * HOUR;
      const makeLog = (rows, extra) => makeLedger(Object.assign({ clock: { now: () => clockNow }, nextId: () => 'id' + rows.length,
        io: { readAll: () => rows.slice(), append(e) { rows.push(e); } } }, extra));
      const station = (log, limit) => S.makeMediaDayGate({ read: () => log.unknownImageWindow(), limit });
      const runOn = (log, gate, id, extra) => {
        const pool = makeRunSpendPool({ capUsd: Infinity });
        pool.join(id);
        return S.makeMediaSpendCheck(Object.assign({ runId: id, pool, unmetered: false, unknownCap: 100, dayGate: gate, holdMaxMs: 500, readView: () => null, pendingUsd: () => 0, mediaUsd: () => 0, crossRun: () => null,
          recordUnknownImage: () => log.recordUnknownImage({ runId: id, agentId: 'a' }) }, extra));
      };
      A.eq(S.MEDIA_UNKNOWN_COST_DAY_MAX, 50, 'the default');
      A.eq(S.makeMediaDayGate({ read: () => null, limit: NaN }).limit, 50, 'an unset override is the default');
      A.eq(S.makeMediaDayGate({ read: () => null, limit: 7 }).limit, 7, 'a set one is honoured');

      // at and over the limit; a second run sees the first run's count
      const rows = [];
      let log = makeLog(rows), gate = station(log, 2);
      const first = runOn(log, gate, 'run1');
      A.eq(await first(), '', 'run 1: the first image starts');
      first.end({ unknown: 1, charged: true });
      clockNow += HOUR;
      const second = runOn(log, gate, 'run2');
      A.eq(gate.state().used, 1, 'a second run sees the first run\'s count');
      A.eq(await second(), '', 'and the last one under the limit starts');
      second.end({ unknown: 1, charged: true });
      A.eq(rows.filter(r => r.aux).map(r => [r.runId, r.usd, r.unpriced, r.tokens]), [['run1', 0, true, 0], ['run2', 0, true, 0]], 'each is its own $0 row in the spend log');
      A.eq([log.runCount(), log.usdForDay(), log.health().complete], [0, 0, true], 'no run counter or dollar total reads them');
      const third = runOn(log, gate, 'run3');
      const refused = await third();
      A.ok(/recorded 2 images whose cost is unknown in the last 24 hours across all runs/.test(refused.why) && /stops at 2 in any 24 hours/.test(refused.why), 'at the limit: refused, and says why: ' + refused.why);
      A.ok(/Room comes back in about 23 hours/.test(refused.todo), 'and when room comes back (the oldest row is 1 h old): ' + refused.todo);
      A.ok(!/image model the provider/.test(refused.todo) && !/start a new run/.test(refused.todo), 'with no way round that would not work');
      const dayAtOnce = await Promise.race([runOn(log, gate, 'run3b')(), new Promise(r => setTimeout(() => r('LATE'), 100))]);
      A.ok(dayAtOnce !== 'LATE' && /recorded 2 images whose cost is unknown/.test(dayAtOnce.why) && !/still running/.test(dayAtOnce.why), 'at the day limit the refusal is at once, never a wait for calls that are not running: ' + JSON.stringify(dayAtOnce));

      // restart keeps it
      log = makeLog(rows); gate = station(log, 2);
      A.eq(gate.state().used, 2, 'a restart reads the count back from the log');
      A.ok(/recorded 2 images/.test((await runOn(log, gate, 'run4')()).why), 'and still refuses');

      // over the limit: the room is when enough have aged out, not when the first has
      log.recordUnknownImage({ runId: 'x', agentId: 'a' });
      clockNow += 2 * HOUR;
      log.recordUnknownImage({ runId: 'x', agentId: 'a' });
      const over = gate.state();
      A.eq(over.used, 4, 'over the limit (a lowered override, or parallel calls)');
      A.eq(over.roomInMs, 22 * HOUR, 'room comes back when the third oldest (2 h old now) ages out, leaving one under the limit');
      A.ok(/recorded 4 images/.test((await runOn(log, gate, 'run5')()).why), 'over: refused too');

      // aging out: strictly inside 24 hours counts
      const old = [];
      clockNow = 20 * 24 * HOUR;
      const agedLog = makeLog(old), aged = station(agedLog, 1);
      agedLog.recordUnknownImage({ runId: 'r', agentId: 'a' });
      clockNow += 24 * HOUR - 1;
      A.eq(aged.state().used, 1, 'a millisecond before 24 hours it still counts');
      A.ok(/Room comes back in about 1 minute/.test((await runOn(agedLog, aged, 'r2')()).todo), 'and room is a minute away at most');
      clockNow += 1;
      A.eq(aged.state().used, 0, 'at 24 hours it ages out');
      const after = runOn(agedLog, aged, 'r3');
      A.eq(await after(), '', 'and the next image starts');
      after.end({ unknown: 0, charged: false });

      // a sibling in another run waits, and a failed call leaves no count
      {
        const r2 = [], l2 = makeLog(r2), g2 = station(l2, 1);
        const a = runOn(l2, g2, 'a'), b = runOn(l2, g2, 'b');
        A.eq(await a(), '', 'run a is generating');
        A.eq(g2.state(), { used: 0, running: 1, limit: 1, roomInMs: 0 }, 'the station sees it running');
        let said = null;
        const waiting = b().then(v => { said = v; });
        await new Promise(r => setTimeout(r, 15));
        A.eq(said, null, 'run b, in another family, waits: it is not refused while a may still fail');
        a.end({ unknown: 0, charged: false });
        await waiting;
        A.eq(said, '', 'a failed: b starts');
        A.eq(r2.filter(r => r.aux).length, 0, 'and a left no row');
        said = null;
        const c = runOn(l2, g2, 'c');
        const third2 = c().then(v => { said = v; });
        await new Promise(r => setTimeout(r, 15));
        b.end({ unknown: 1, charged: true });
        await third2;
        A.ok(/recorded 1 image whose/.test(said.why), 'b came back unknown: the limit is really reached, so c is refused now');
        A.eq(g2.state().running, 0, 'nothing left running');
        // the wait keeps the one bound
        const r3 = [], l3 = makeLog(r3), g3 = station(l3, 1);
        const held = runOn(l3, g3, 'held');
        await held();
        const late = await runOn(l3, g3, 'late', { holdMaxMs: 25 })({});
        A.ok(/still running after a wait of/.test(late.why) && /No limit was reached/.test(late.todo), 'a sibling that never ends cannot hold it past the bound: ' + late.why);
        A.eq(g3.state().running, 1, 'and the refused call took no count');
        held.end({ unknown: 0, charged: false });
      }

      // unknown is never headroom
      {
        const broken = makeLog([], { io: { readAll() { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }, append() {} } });
        const g = station(broken, 50);
        A.eq(g.state(), { unreadable: true }, 'a log that cannot be read is not zero');
        const said = await runOn(broken, g, 'r')();
        A.ok(/could not read its spend log/.test(said.why) && /SPENDING LIMITS/.test(said.todo), 'it refuses, and says so: ' + said.why);
        A.eq(g.state().running, undefined, 'and starts nothing');
        const damaged = makeLog([], { io: { readAll: () => [], append() {}, unsettled: () => [{ runId: 'line', kind: 'damaged' }] } });
        A.eq(station(damaged, 50).state(), { unreadable: true }, 'a damaged line might have been one of these');
        const interrupted = makeLog([], { io: { readAll: () => [], append() {}, unsettled: () => [{ runId: 'crashed', agentId: 'a' }] } });
        A.eq(station(interrupted, 50).state().used, 0, 'an interrupted run leaves the log readable (its dollars are the budget\'s to refuse)');
        const failing = makeLog([], { io: { readAll: () => [], append() { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } } });
        failing.recordUnknownImage({ runId: 'r', agentId: 'a' });
        A.eq(station(failing, 50).state(), { unreadable: true }, 'a count that could not be saved would not survive a restart');
        A.eq(S.makeMediaDayGate({ read() { throw new Error('boom'); } }).state(), { unreadable: true }, 'a reader that throws');
      }

      // through the real tool
      {
        const r4 = [], l4 = makeLog(r4), g4 = station(l4, 1);
        const useRun = id => { const c = runOn(l4, g4, id); return f => tools(f, { spendStop: c, spendEnd: c.end }); };
        let threw = '';
        try { await useRun('t1')(async () => new Response('no', { status: 500 })).generateTool.run({ prompt: 'a cat' }, ctx); } catch (e) { threw = e.message; }
        A.ok(threw && r4.filter(r => r.aux).length === 0, 'a provider failure leaves no count');
        const priced = await useRun('t2')(answer({ cost: 0.05 })).generateTool.run({ prompt: 'a cat' }, ctx);
        A.ok(/Cost: \$0\.0500/.test(priced.content) && r4.filter(r => r.aux).length === 0, 'nor does a priced image');
        const unknown = await useRun('t3')(answer(null)).generateTool.run({ prompt: 'a cat' }, ctx);
        A.ok(/every run at 1 in any 24 hours/.test(unknown.content), 'the receipt says the limit: ' + unknown.content);
        A.eq(r4.filter(r => r.aux).map(r => r.runId), ['t3'], 'an unknown image is one row, under its run');
        let posted = 0, refused4 = '';
        try { await useRun('t4')(async (...x) => { posted++; return answer(null)(...x); }).generateTool.run({ prompt: 'a cat' }, ctx); } catch (e) { refused4 = e.message; }
        A.eq(posted, 0, 'at the limit no request goes out, in a new run');
        A.ok(/did not start: StarNet has recorded 1 image/.test(refused4) && /nothing was charged/.test(refused4) && /Room comes back in about 24 hours/.test(refused4) && !/SETTINGS/.test(refused4), 'and the refusal is plain: ' + refused4);
      }
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
    A.ok(/const mediaDayGate = makeMediaDayGate\(\{ read: \(\) => ledger\.unknownImageWindow\(\), limit: Number\(ENV\('IMAGE_UNKNOWN_COST_DAY_MAX'\)\) \}\);/.test(idx) && /dayGate: mediaDayGate,\s+recordUnknownImage: \(\) => ledger\.recordUnknownImage\(\{ runId, agentId \}\),/.test(idx), 'one gate for the station, over the spend log, handed to every run');
    A.ok(/spendStop: mediaSpend, spendEnd: mediaSpend\.end,/.test(idx) && /unknownCap: Number\(ENV\('IMAGE_UNKNOWN_COST_MAX'\)\)/.test(idx), 'the host answers every start, and the cap can be retuned');
    A.ok(/const mediaSpend = makeMediaSpendCheck\(\{ runId, pool: spendPool, unmetered: \(\) => runUnmetered,/.test(idx) && /if \(typeof next\.unmetered === 'boolean'\) providerUnmetered = next\.unmetered;\s+runUnmetered = runUnmetered && providerUnmetered;/.test(idx) && /crossRun: spent => governor\.admit\('media', \{ runId, agentId, spentUsd: spent, emit, receiptMeta: runReceiptMeta \}\)/.test(idx), 'the host hands the check its real pool and the one governor (an image meets the cross-run caps on every payer)');
    A.ok(!/spendPool\.admit\([^)]*pending/i.test(idx) && !/runBudget\.check\(spentUsd \+ pendingUsd/.test(idx), 'and nothing tells the pool a pending charge');
    A.ok(/if \(name === 'agent\.cost' && !providerUnmetered\) spendPool\.booked\(runId, Number\(payload\.usd\) \|\| 0\);/.test(idx), 'the one place a charge reaches the pool');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
    A.ok(/Images whose cost is unknown are not held by these dollar limits/.test(ui) && ui.includes('StarNet stops a run at ' + S.MEDIA_UNKNOWN_COST_MAX + ' of them instead, and every run at ' + S.MEDIA_UNKNOWN_COST_DAY_MAX + ' in any 24 hours') && /On a subscription chat this one does not apply/.test(ui), 'SETTINGS says plainly what the limits cannot stop');
    A.ok(/onUsage: recordMediaUsage, spendStop: mediaSpend,/.test(idx) && /drainToolCosts: \(\) => pendingMediaCosts\.splice\(0\), spendView,/.test(idx), 'runOnce wires the check and the view');
    A.ok(/ledger\.record\(\{[^\n]*unmetered: mediaFlags\.unmetered, unpriced: mediaFlags\.unpriced, usageMissing, \.\.\.generationFields\(result\)/.test(idx) && /runStore\.record\(\{[^\n]*reasoningEffort, unmetered: mediaFlags\.unmetered, unpriced: mediaFlags\.unpriced, usageMissing, spendUnknown/.test(idx), 'both actual spend writers carry the flags alongside generation receipts');
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
