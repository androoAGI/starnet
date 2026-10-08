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
  // ---- args serialised as a JSON string (the second real-model run sent args: "{\"perDay\": 5}") ----
  {
    const s = stubs(); const t = make(s);
    const call = { action: 'budget.set', args: '{"perDay": 5}' };
    A.eq(cardFor(call), 'set your spending limits: perDay $5', 'the card reads stringified args');
    const r = await t.powerTool.run(call);
    A.ok(!refused(r) && s.routes.length === 1 && s.routes[0].body.perDay === 5, 'stringified args are parsed and saved');
    const bad = await t.powerTool.run({ action: 'budget.set', args: 'perDay five' });
    A.ok(refused(bad) && s.routes.length === 1, 'args that are not a JSON object are refused (no fields), nothing saved');
  }
  // ---- reading a section says what changes it ----
  {
    const s = stubs(); s.route = async (method, url) => ({ status: 200, json: { caps: { perDay: 0 }, unsettled: [] } });
    const t = makeStationControlTools({ station: s.station, route: s.route, surface: 'interactive' });
    const j = JSON.parse((await t.settingsTool.run({ section: 'spending' })).content);
    A.ok(Array.isArray(j.toChange) && j.toChange.some(x => /^station\.power \{"action": "budget\.set", "args": \{perRun\?/.test(x)),
      'spending carries toChange: station.power budget.set with what it takes');
    A.ok(j.toChange.some(x => /^station\.control \{"action": "fallback\.set"/.test(x)), 'and station.control fallback.set');
    A.ok(j.toChange.some(x => /settled by the Commander alone/.test(x)), 'and that an unsettled run is the Commander\'s');
    const keys = Object.keys(j); A.eq(keys[keys.length - 1], 'toChange', 'toChange comes last (a clipped answer loses the hint first)');
  }
  // ---- "pin this conversation": no session named = the run's own ----
  {
    const s = stubs(); const t = make(s);
    A.eq(cardFor({ action: 'session.pin', args: {} }), 'pin this conversation', 'the card says this conversation');
    A.eq(cardFor({ action: 'session.pin', args: { session: 'this' } }), 'pin this conversation', '"this" reads the same');
    const r = await t.controlTool.run({ action: 'session.pin', args: {} }, { streamId: 'ws_here', runId: 'r1' });
    A.ok(!refused(r), 'session.pin with no session is done');
    A.eq(s.pages[0].args, { session: 'ws_here', action: 'session.pin' }, 'the page is asked to pin the run\'s own session');
    const r2 = await t.controlTool.run({ action: 'session.pin', args: { session: 'current' } }, {});
    A.ok(refused(r2) && /name the session/.test(r2.content), 'a run with no conversation of its own must name one');
    const r3 = await t.controlTool.run({ action: 'session.rename', args: { session: 'Taxes', title: 'Taxes 2026' } }, { streamId: 'ws_here' });
    A.ok(!refused(r3) && s.pages[s.pages.length - 1].args.session === 'Taxes', 'a named session is left as named');
  }
  // ---- the section names a model reaches for first ----
  {
    const s = stubs(); s.route = async () => ({ status: 200, json: { caps: { perDay: 0 } } });
    const t = makeStationControlTools({ station: s.station, route: s.route, surface: 'interactive' });
    for (const k of ['look', 'sessions', 'agents', 'budget', 'all']) A.ok(t.settingsTool.schema.properties.section.enum.includes(k), 'section "' + k + '" is accepted');
    const look = await t.settingsTool.run({ section: 'look' });
    A.ok(!refused(look) && s.pages.some(p => p.verb === 'station.settings'), '"look" reads the page settings (crew, sessions, look)');
    A.ok(/look\.set/.test(look.content), 'and names look.set as the change');
    const all = await t.settingsTool.run({ section: 'ALL' });
    A.ok(/^station\.control \{action, args\}/.test(all.content), '"all" is the actions catalog');
    const budget = JSON.parse((await t.settingsTool.run({ section: 'budget' })).content);
    A.ok(budget['budget/status'] && Array.isArray(budget.toChange), '"budget" is the spending section');
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
    for (const k of ['place', 'target', 'id', 'window', 'page', 'section']) {
      const r = await t.run({ [k]: 'settings-spending' }, ctx);
      A.ok(/^OPEN on the Commander's screen: SETTINGS › SPENDING LIMITS/.test(r.content), 'station.show {' + k + '} opens the place');
      A.ok(/opening it is not doing it/.test(r.content), 'and says opening is not doing a change');
    }
    A.eq(s.pages.map(p => p.args.place), Array(6).fill('settings-spending'), 'the page is asked for the catalog id every time');
    const bad = await t.run({ target: 'the spending page' }, ctx);
    A.ok(/^REFUSED: there is no StarNet place "the spending page" — call it as \{place: "<id>"\}/.test(bad.content), 'free text never opens anything, and the refusal says how to call it');
    const none = await t.run({}, ctx);
    A.ok(/^REFUSED: no place was named/.test(none.content), 'no place named is refused');
    A.eq(s.pages.length, 6, 'refusals never reach the page');
  }
  A.report('station-call-shapes');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
