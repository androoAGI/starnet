/* node test/station-call-shapes.test.js — the call shapes a REAL model sends (self-driving real-model run, 2026-10-08).
   Claude Haiku 4.5, asked "set a daily spending limit of $5", sent station.control {setting: "budget.set", limit: "5",
   period: "daily"} and station.show {target: "settings-spending"}; both were turned away as invalid arguments and the run
   ended by opening the window for the Commander to do it by hand. Pins:
     • station.control / station.power read the action from action | setting | name (a KNOWN action only) and its args
       flat beside it when there is no `args` object — and the approval card reads the call the SAME way;
     • an action with named fields (budget.set, limits.set) given none of them is REFUSED, never saved as an empty patch
       that reads back as "done"; "5" / "$5" is saved as the number 5, and the card says $5;
     • a flat call keeps a field that is literally called `name` (agent.rename) as an arg;
     • an unknown or missing action is refused with the {action, args} shape and an example;
     • station.show takes the place from place | target | id | window, and still opens only catalog ids. */
'use strict';
const A = require('./_assert.js');
const { makeStationControlTools, cardFor } = require('../sidecar/tools/builtin/station-control.js');
const { makeStationShowTool } = require('../sidecar/tools/builtin/station-show.js');

function stubs() {
  const routes = [], pages = [];
  return {
    routes, pages,
    route: async (method, url, body) => { routes.push({ method, url, body }); return { status: 200, json: { ok: true } }; },
    station: { request: async (verb, args) => { pages.push({ verb, args }); return { ok: true, result: { ok: true, saved: true, agentName: 'NOVA' } }; } }
  };
}
const make = s => makeStationControlTools({ station: s.station, route: s.route, surface: 'interactive' });
const refused = r => /^REFUSED: /.test(r.content);

(async () => {
  // ---- the exact call the model sent: refused (no budget field), never a silent empty save ----
  {
    const s = stubs(); const t = make(s);
    const r = await t.powerTool.run({ setting: 'budget.set', limit: '5', period: 'daily' });
    A.ok(refused(r), 'budget.set with none of its fields is refused');
    A.ok(/perDay/.test(r.content) && /limit, period/.test(r.content), 'the refusal names the fields it takes and what it got');
    A.eq(s.routes.length, 0, 'nothing was saved');
  }
  // ---- flat args under a `setting` key: the change lands, the card says the same thing ----
  {
    const s = stubs(); const t = make(s);
    const call = { setting: 'budget.set', perDay: '$5' };
    A.eq(cardFor(call), 'set your spending limits: perDay $5', 'the card reads the flat call (and "$5" as $5)');
    const r = await t.powerTool.run(call);
    A.ok(!refused(r), 'station.power {setting: "budget.set", perDay: "$5"} is done');
    A.eq([s.routes[0].url, s.routes[0].body], ['/api/budget/caps', { perDay: 5 }], 'saved as the number 5 through the caps route');
  }
  // ---- the canonical shape still works, and still needs station.power ----
  {
    const s = stubs(); const t = make(s);
    const r = await t.controlTool.run({ action: 'budget.set', args: { perDay: 5 } });
    A.ok(refused(r) && /station\.power/.test(r.content), 'station.control still sends a cap change to station.power');
    const r2 = await t.powerTool.run({ action: 'budget.set', args: { perDay: 5 } });
    A.ok(!refused(r2), 'station.power {action, args} is done');
    A.eq(s.routes.map(x => x.body), [{ perDay: 5 }], 'only the power call saved');
  }
  // ---- a flat call keeps a field called `name` as an arg ----
  {
    const s = stubs(); const t = make(s);
    const call = { action: 'agent.rename', agent: 'nova', name: 'VEGA' };
    A.ok(/rename "nova" to "VEGA"/.test(cardFor(call)), 'the card names the new name');
    const r = await t.controlTool.run(call);
    A.ok(!refused(r), 'flat agent.rename is done');
    A.eq(s.pages[0].args, { agent: 'nova', name: 'VEGA', action: 'agent.rename' }, 'the page gets the agent and the new name');
  }
  // ---- `setting` / `name` only count when they ARE an action ----
  {
    const s = stubs(); const t = make(s);
    const r = await t.controlTool.run({ setting: 'daily budget', perDay: 5 });
    A.ok(refused(r) && /no action was named/.test(r.content) && /\{"action": "budget\.set", "args": \{"perDay": 5\}\}/.test(r.content),
      'a non-action `setting` is refused with the {action, args} shape and an example');
    A.eq(cardFor({ setting: 'daily budget' }), 'make an unknown station change (it will be refused, and nothing will change)', 'and its card says so');
    const r2 = await t.controlTool.run({ action: 'budget.raise', args: {} });
    A.ok(refused(r2) && /no station action "budget\.raise"/.test(r2.content), 'an unknown action is named in the refusal');
  }
  // ---- limits.set given none of its fields ----
  {
    const s = stubs(); const t = make(s);
    const r = await t.powerTool.run({ action: 'limits.set', args: { max: 3 } });
    A.ok(refused(r) && s.routes.length === 0, 'limits.set with none of its fields is refused, nothing saved');
  }
  // ---- station.show: target | id | window, catalog ids only ----
  {
    const s = stubs();
    const t = makeStationShowTool({ station: s.station }).tool;
    A.ok(!t.schema.required, 'station.show requires no single key name (the run reads the aliases)');
    const ctx = { streamId: 'ws1', runId: 'r1' };
    for (const k of ['place', 'target', 'id', 'window']) {
      const r = await t.run({ [k]: 'settings-spending' }, ctx);
      A.ok(/^OPEN on the Commander's screen: SETTINGS › SPENDING LIMITS/.test(r.content), 'station.show {' + k + '} opens the place');
    }
    A.eq(s.pages.map(p => p.args.place), ['settings-spending', 'settings-spending', 'settings-spending', 'settings-spending'], 'the page is asked for the catalog id every time');
    const bad = await t.run({ target: 'the spending page' }, ctx);
    A.ok(/^REFUSED: there is no StarNet place "the spending page" — call it as \{place: "<id>"\}/.test(bad.content), 'free text never opens anything, and the refusal says how to call it');
    const none = await t.run({}, ctx);
    A.ok(/^REFUSED: no place was named/.test(none.content), 'no place named is refused');
    A.eq(s.pages.length, 4, 'refusals never reach the page');
  }
  A.report('station-call-shapes');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
