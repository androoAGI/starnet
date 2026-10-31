/* node test/channels.delivery-ledger.soak.test.js — the delivery property (test/channels.delivery-ledger.property.test.js)
   over many more seeds, longer, with an agent bot as a fourth chat.

   The same world and the same clauses P1-P6 (test/helpers/channel-station-sim.js), 800 seeds of 60 steps (seeds 1001-1800,
   none shared with the property's), plus an agent bot lifted from startTelegramBot over makeBotScopedStore: its chat
   ('telegram:<botId>|4242') shares the station's delivery ledger through the scoped store's view, on its own lane.
   On fast.list and slow.list (it runs for over a minute). A failing seed prints the command that replays it:
     CDL_SOAK_SEED=<n> node test/channels.delivery-ledger.soak.test.js */
'use strict';
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');

const STEPS = 60;
const FROM = process.env.CDL_SOAK_SEED ? Number(process.env.CDL_SOAK_SEED) : 1001;
const TO = process.env.CDL_SOAK_SEED ? Number(process.env.CDL_SOAK_SEED) : 1800;

(async () => {
  const t0 = process.hrtime.bigint();
  const red = [];
  let botWire = 0, crashes = 0, windows = 0;
  for (let seed = FROM; seed <= TO; seed++) {
    const w = Sim.makeWorld(seed, { bot: true });
    const r = await w.run(STEPS);
    botWire += w.wire.filter(m => m.chat === Sim.CHATS.botDm).length;
    crashes += w.crashes; windows += w.windows.length;
    if (r.problems.length) red.push({ seed, problems: r.problems });
  }
  for (const s of red.slice(0, 6)) {
    console.log('  seed ' + s.seed + ' (replay: CDL_SOAK_SEED=' + s.seed + ' node test/channels.delivery-ledger.soak.test.js)');
    for (const p of s.problems.slice(0, 4)) console.log('    ' + String(p).slice(0, 400));
  }
  const runs = TO - FROM + 1;
  A.ok(runs === 1 || botWire > 0, 'fixture: the agent bot\'s chat was answered (' + botWire + ' messages on its wire)');
  A.ok(runs === 1 || (crashes > runs && windows > 0), 'fixture: crashes and window events were drawn (' + crashes + ' crashes, ' + windows + ' window events)');
  A.eq(red.map(s => s.seed), [], runs + ' seeds of ' + STEPS + ' steps hold P1-P6 (' + (red[0] ? String(red[0].problems[0]).slice(0, 300) : '') + ')');
  console.log('  soak: ' + runs + ' seeds in ' + (Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1) + ' s');
  A.report('channels.delivery-ledger.soak.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
