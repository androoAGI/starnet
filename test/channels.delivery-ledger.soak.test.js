/* node test/channels.delivery-ledger.soak.test.js — the delivery property (test/channels.delivery-ledger.property.test.js)
   over many more seeds, longer, with an agent bot as a fourth chat.

   The same world and the same clauses P1-P7 (test/helpers/channel-station-sim.js), seeds of 60 steps from 1001 (none
   shared with the property's), plus an agent bot lifted from startTelegramBot over makeBotScopedStore: its chat
   ('telegram:<botId>|4242') shares the station's delivery ledger through the scoped store's view, on its own lane, and
   its keyboards are tapped too.

   HOW MANY SEEDS (review round 1). The gate runs 100 (seeds 1001-1100, about 20 s here). CI's fast-gate job runs
   test/fast.list serially inside a 25-minute limit it was already within half a minute of, and the full 800 took two
   minutes or more of it; the full soak is one variable away and is what a lane burns before it lands:
     CDL_SOAK_SEEDS=800 node test/channels.delivery-ledger.soak.test.js
   (CDL_SOAK_SEEDS=<n> runs seeds 1001 to 1000+n.) Once the fast list runs in shards (agent/ci-fast-shards-1101), the gate
   can take the full count back. A failing seed prints the command that replays it:
     CDL_SOAK_SEED=<n> node test/channels.delivery-ledger.soak.test.js */
'use strict';
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');

const STEPS = 60;
const SEEDS = Number(process.env.CDL_SOAK_SEEDS) > 0 ? Math.floor(Number(process.env.CDL_SOAK_SEEDS)) : 100;
const FROM = process.env.CDL_SOAK_SEED ? Number(process.env.CDL_SOAK_SEED) : 1001;
const TO = process.env.CDL_SOAK_SEED ? Number(process.env.CDL_SOAK_SEED) : 1000 + SEEDS;

(async () => {
  const t0 = process.hrtime.bigint();
  const red = [];
  let botWire = 0, crashes = 0, windows = 0, botTaps = 0;
  const mix = { tapsTaken: 0, tapsRefused: 0, tapCrashes: 0, corrections: 0 };
  const rmix = { fired: 0, landed: 0, retried: 0, withdrawn: 0 };
  for (let seed = FROM; seed <= TO; seed++) {
    const w = Sim.makeWorld(seed, { bot: true });
    const r = await w.run(STEPS);
    botWire += w.wire.filter(m => m.chat === Sim.CHATS.botDm).length;
    crashes += w.crashes; windows += w.windows.length;
    botTaps += w.taps.filter(t => t.chat === Sim.CHATS.botDm).length;
    const m = w.mix();
    for (const k of Object.keys(mix)) mix[k] += m[k];
    const rm = w.routineMix();
    for (const k of Object.keys(rmix)) rmix[k] += rm[k];
    if (r.problems.length) red.push({ seed, problems: r.problems });
  }
  for (const s of red.slice(0, 6)) {
    console.log('  seed ' + s.seed + ' (replay: CDL_SOAK_SEED=' + s.seed + ' node test/channels.delivery-ledger.soak.test.js)');
    for (const p of s.problems.slice(0, 4)) console.log('    ' + String(p).slice(0, 400));
  }
  const runs = TO - FROM + 1;
  A.ok(runs === 1 || botWire > 0, 'fixture: the agent bot\'s chat was answered (' + botWire + ' messages on its wire)');
  A.ok(runs === 1 || (crashes > runs && windows > 0), 'fixture: crashes and window events were drawn (' + crashes + ' crashes, ' + windows + ' window events)');
  A.ok(runs === 1 || (Object.keys(mix).every(k => mix[k] > 0) && botTaps > 0), 'fixture: corrections and taps were drawn, the agent bot\'s keyboards tapped too (' + botTaps + ') ' + JSON.stringify(mix));
  A.ok(runs === 1 || (rmix.fired > 0 && rmix.landed > 0 && rmix.retried > 0 && rmix.withdrawn > 0), 'fixture: routines fired, landed, some had a part refused or cut by a crash, and some were replaced before anything of them went ' + JSON.stringify(rmix));
  A.eq(red.map(s => s.seed), [], runs + ' seeds of ' + STEPS + ' steps hold P1-P7 (' + (red[0] ? String(red[0].problems[0]).slice(0, 300) : '') + ')');
  console.log('  soak: ' + runs + ' seeds in ' + (Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1) + ' s');
  A.report('channels.delivery-ledger.soak.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
