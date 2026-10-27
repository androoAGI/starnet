/* test/chain.limits.test.js — LINE BUDGET: per-line limits on the chain executor (sidecar/routing/chain.js).
   Proves: limits override the constants, ceilings clamp (and say so), the global pool clamps, the daily cap
   refuses with a reason off a DURABLE ledger, and a seed with no limits runs on exactly the old defaults.
   Pure: fake floor, fake harness, injected clock, in-memory "disk" for the day ledger. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const { makeChainRunner, effectiveLimits, MAX_HOPS, MAX_CHAIN_USD } = require('../sidecar/routing/chain.js');
const { makeLineSpend, DAY_MS } = require('../sidecar/routing/line-spend.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

const harness = script => async ({ agentId }) => script[agentId] || { text: agentId + ' output', usd: 0.10 };
const line = map => a => map[a] || null;
const chain5 = { a: 'b', b: 'c', c: 'd', d: 'e', e: 'f' };   // 5 hops after the entry dock
let T = 0; const clock = () => (T += 10);

(async () => {

  /* ---- defaults preserved when no limits ride the seed ---- */
  {
    A.eq(MAX_HOPS, 6, 'the hop default is the historical constant');
    A.eq(MAX_CHAIN_USD, 2.00, 'the $ default is the historical constant');
    const c = makeChainRunner({ nextAgent: line(chain5), runAgent: harness({}), now: clock });
    const res = await c.advance({ agentId: 'a', text: 'go' });
    A.eq(res.hops.length, 5, 'no limits -> the 5-hop line runs to its end under the default 6');
    A.eq(res.stopped, null, 'and stops for no reason');
    A.eq(res.limits.maxHops, 6, 'the result reports the default hop ceiling');
    A.eq(res.limits.maxUsd, 2, 'and the default $ ceiling');
    A.eq(res.limits.maxUsdPerDay, null, 'and NO daily cap (off by default)');
  }

  /* ---- seed.limits override the constants (hops + $ per message) ---- */
  {
    const c = makeChainRunner({ nextAgent: line(chain5), runAgent: harness({}), now: clock });
    const r1 = await c.advance({ agentId: 'a', text: 'go', limits: { maxHops: 2 } });
    A.eq(r1.hops.length, 2, 'maxHops:2 runs exactly two downstream stages');
    A.eq(r1.stopped, 'the line is longer than 2 stages — raise max stages in the INBOX’s LINE BUDGET', "and says so in the ceiling's own number — and where it is raised");
    const r2 = await c.advance({ agentId: 'a', text: 'go', limits: { maxUsdPerMessage: 0.25 } });
    A.eq(r2.stopped, 'the line reached its $0.25 limit', 'maxUsdPerMessage replaces the $2.00 constant in the reason');
    A.ok(r2.hops.length < 5, 'and actually stopped the line short');
  }

  /* ---- QA 2026-10-02: each hop is told what is LEFT of the line's $ ceiling (a lower-only cap for that run) ----
     The pre-hop check alone let one own-key stage spend far past the line's limit. */
  {
    const seen = [];
    const c = makeChainRunner({ nextAgent: line({ a: 'b', b: 'c', c: 'd' }), now: clock,
      runAgent: async (call) => { seen.push([call.agentId, call.ceilingUsd]); return { text: call.agentId + ' out', usd: 0.5 }; } });
    await c.advance({ agentId: 'a', text: 'go', entryUsd: 0.25, limits: { maxUsdPerMessage: 1.5 } });
    A.eq(seen.map(x => x[0]), ['b', 'c', 'd'], 'three hops start under the line limit');
    A.ok(Math.abs(seen[0][1] - 1.25) < 1e-9, 'the first hop may spend only what the entry left (got ' + seen[0][1] + ')');
    A.ok(Math.abs(seen[1][1] - 0.75) < 1e-9, 'the next hop only what is left after that (got ' + seen[1][1] + ')');
    A.ok(Math.abs(seen[2][1] - 0.25) < 1e-9, 'and the last one only the final quarter (got ' + seen[2][1] + ')');
    // the hub's own hop runner (sidecar/channels/hub.js) also passes h.ceilingUsd; the count is the host's two cron runners
    const idx = readSidecarSource({ except: ['sidecar/channels/hub.js'] });
    A.ok(idx.includes("!(runCapUsd <= o.ceilingUsd)) runCapUsd = Math.max(0.01, o.ceilingUsd);") && idx.split('ceilingUsd: h.ceilingUsd').length - 1 === 2,
      'runOnce lowers its cap to the ceiling (never raises it), and both cron hop runners pass it');
    const hub = fs.readFileSync(require('path').join(__dirname, '..', 'sidecar', 'channels', 'hub.js'), 'utf8');
    A.ok(hub.includes('ceilingUsd: h.ceilingUsd'), 'and so does the hub hop runner');
  }

  /* ---- the injected per-line reader (the compiled plan's LINE BUDGET) is read by lineId ---- */
  {
    const c = makeChainRunner({
      nextAgent: line(chain5), runAgent: harness({}), now: clock,
      lineLimits: id => id === 'L1' ? { maxHops: 1 } : null
    });
    const onLine = await c.advance({ agentId: 'a', text: 'go', lineId: 'L1' });
    A.eq(onLine.hops.length, 1, "work on L1 runs under L1's budget");
    const direct = await c.advance({ agentId: 'a', text: 'go' });
    A.eq(direct.hops.length, 5, 'a direct order (no lineId) runs on the defaults');
    const seedWins = await c.advance({ agentId: 'a', text: 'go', lineId: 'L1', limits: { maxHops: 3 } });
    A.eq(seedWins.hops.length, 3, 'an explicit seed.limits outranks the plan reader');
  }

  /* ---- ceilings clamp and RECORD the clamp ---- */
  {
    const lim = effectiveLimits({ maxHops: 99, maxUsdPerMessage: 999, maxUsdPerDay: 9999 }, {}, null);
    A.eq(lim.maxHops, 24, 'maxHops clamps to 24');
    A.eq(lim.maxUsd, 50, 'maxUsdPerMessage clamps to $50');
    A.eq(lim.maxUsdPerDay, 500, 'maxUsdPerDay clamps to $500');
    A.eq(lim.clamped.join(','), 'maxHops>24,maxUsdPerMessage>50,maxUsdPerDay>500', 'every clamp is recorded with its reason');
    const pooled = effectiveLimits({ maxUsdPerMessage: 20, maxUsdPerDay: 30 }, {}, 5);
    A.eq(pooled.maxUsd, 5, 'a per-message limit never exceeds the global pool');
    A.eq(pooled.maxUsdPerDay, 5, 'nor does the daily one');
    A.ok(pooled.clamped.indexOf('maxUsdPerMessage>pool:5') >= 0, 'the pool clamp names the pool');
    const c = makeChainRunner({ nextAgent: line(chain5), runAgent: harness({}), now: clock, poolCap: () => 0.15 });
    const res = await c.advance({ agentId: 'a', text: 'go', limits: { maxUsdPerMessage: 10 } });
    A.eq(res.stopped, 'the line reached its $0.15 limit', 'the runner enforces the pool-clamped ceiling');
    A.eq(res.limits.clamped[0], 'maxUsdPerMessage>pool:0.15', 'and reports why the number is not the one typed');
    A.eq(effectiveLimits({ maxHops: 'garbage' }, {}, null).maxHops, 6, 'garbage input falls back to the default');
    A.eq(effectiveLimits({ clamped: ['maxHops>24'], maxHops: 24, maxUsdPerMessage: 3 }, {}, null).clamped.join(','), 'maxHops>24', "a plan's recorded clamp is carried forward, not lost on re-normalization");
  }

  /* ---- the DAILY cap: refuses with a reason, measured off a ledger that survives a "restart" ---- */
  {
    let disk = null; let now = 1000 * DAY_MS + 5000;
    const mkLedger = () => makeLineSpend({ now: () => now, load: () => disk, save: v => { disk = JSON.parse(JSON.stringify(v)); } });
    const mk = ledger => makeChainRunner({
      nextAgent: line({ a: 'b' }), runAgent: harness({ b: { text: 'b out', usd: 0.30 } }), now: clock,
      daySpend: ledger, lineLimits: id => id === 'L1' ? { maxUsdPerDay: 1.00 } : null
    });
    const c1 = mk(mkLedger());
    const r1 = await c1.advance({ agentId: 'a', text: 'go', lineId: 'L1', entryUsd: 0.20 });
    A.eq(r1.stopped, null, 'first message of the day runs ($0.20 entry + $0.30 hop = $0.50 of $1.00)');
    A.eq(disk.L1.usd, 0.5, 'the ledger holds entry + hop spend for the line, DURABLY');
    const r2 = await c1.advance({ agentId: 'a', text: 'go', lineId: 'L1', entryUsd: 0.20 });
    A.eq(r2.stopped, null, 'second message still runs ($1.00 after it — the cap is checked BEFORE the hop)');
    // "restart": a fresh runner + fresh ledger over the same disk
    const c2 = mk(mkLedger());
    const r3 = await c2.advance({ agentId: 'a', text: 'go', lineId: 'L1', entryUsd: 0.05 });
    A.eq(r3.stopped, 'the line reached its $1.00 daily limit', "after a restart the day's spend is still counted and the hop is REFUSED with a reason");
    A.eq(r3.hops.length, 0, 'and no downstream run was bought');
    A.eq(r3.text, 'go', 'the entry reply is still delivered (a chain never gates the reply)');
    const other = await c2.advance({ agentId: 'a', text: 'go', lineId: 'L2', entryUsd: 0.05 });
    A.eq(other.stopped, null, "another line is not charged for L1's day");
    const direct = await c2.advance({ agentId: 'a', text: 'go', entryUsd: 0.05 });
    A.eq(direct.stopped, null, 'a direct order has no line and no daily cap');
    now += DAY_MS;   // the day rolls
    const r4 = await mk(mkLedger()).advance({ agentId: 'a', text: 'go', lineId: 'L1', entryUsd: 0.05 });
    A.eq(r4.stopped, null, 'a new day re-zeroes the bucket and the line runs again');
    A.eq(disk.L1.usd, 0.35, "the new day's bucket holds only today's spend");
    const noCap = mk(mkLedger());
    const r5 = await noCap.advance({ agentId: 'a', text: 'go', lineId: 'L3', entryUsd: 1.50 });
    A.eq(r5.stopped, null, 'a line with no daily cap is never refused by the ledger');
  }

  /* ---- REAL compiler + REAL router: the INBOX prop's limits reach the executor by lineId ---- */
  {
    const belt = (x, y, dir) => ({ x, y, dir });
    const geo = lim => ({ props: [
      { id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1, limits: lim },
      { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }
    ], belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')] });
    const plain = P.compileRoutingPlan(geo(null)), limited = P.compileRoutingPlan(geo({ maxHops: 30, maxUsdPerMessage: 3 }));
    A.eq(plain.hash, limited.hash, 'a LINE BUDGET edit is policy, not topology — plan.hash does not move (splitter balance survives)');
    A.eq(P.lineLimitsOf(plain, 'b1'), null, 'no limits on the INBOX -> null (defaults)');
    const router = makeRouter();
    A.ok(router.setPlan(limited).ok, 'the limited plan deploys');
    const lid = router.lineOfAgent('coder');
    A.ok(lid, 'the coder dock crews a line');
    const lim = router.lineLimits(lid);
    A.eq(lim.maxHops, 24, 'router.lineLimits reads the clamped value off the plan');
    A.eq(lim.maxUsdPerMessage, 3, 'and the $ per message');
    A.eq(lim.clamped[0], 'maxHops>24', 'with the clamp reason');
    A.eq(router.lineLimits('nope'), null, 'an unknown line has no limits');
    const c = makeChainRunner({ nextAgent: () => null, runAgent: harness({}), now: clock, lineLimits: id => router.lineLimits(id) });
    const res = await c.advance({ agentId: 'coder', text: 'x', lineId: lid });
    A.eq(res.limits.maxUsd, 3, "the executor runs the line under the INBOX's budget");
  }

  A.report('chain.limits');
})();
