/* test/line-budget-shadowed.test.js — a SECOND INBOX's LINE BUDGET is flagged, naming the one in force (quick win 29).

   A line has ONE budget: the oldest INBOX that carries limits speaks (pipeline.js budgetIntake). A second INBOX on the same
   line could carry its own LINE BUDGET, show it in its card, and be silently ignored — the Commander raised "max stages"
   or the $ per job there and the line kept stopping at the other INBOX's numbers (memory: splitter-not-fixed-1010).
   Locked: compileRoutingPlan adds ONE warn finding on the ignored INBOX naming the INBOX whose budget is in force; it is
   advice (the plan still deploys), it never moves the budget the executor reads, and both floor-callout tables name it.
   The hover sentence (build.js findingWhy, RUN here, not grepped) names a LABELLED INBOX by its label, and an UNNAMED one —
   the TWO DOORS starter's default, where every INBOX shows the line's name — by the LINE BUDGET numbers its card shows
   (review of quick win 29: the test only ever saw an unnamed INBOX and never ran the sentence). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');

function stamped(bpId) {
  const d = WM.starterDoc();
  for (const id in d.rooms) for (const r of d.rooms[id].rects) { r.x2 = 60; r.y2 = 30; }
  const st = WM.create(d);
  const r = LE.placeBlueprint(st, bpId, { x: 20, y: 10 });
  if (!r.ok) throw new Error('placeBlueprint ' + bpId + ' ' + JSON.stringify(r));
  for (const p of st.props()) if (p.t === 'bay' && !p.agentId) st.assignPropAgent(p.id, 'ag_' + p.id);
  return st;
}
const planOf = st => P.compileRoutingPlan(st.projectGeometry());
const shadowed = plan => plan.errors.filter(e => e.code === 'LINE_BUDGET_SHADOWED');

// BUILD's own hover sentence, run from its source: VAL_WHY + findingWhy (a pure function of the finding)
const readFrontendSource = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const build = readFrontendSource('build.js');
const findingWhy = (() => {
  const vAt = build.indexOf('const VAL_WHY = {');
  const vEnd = build.indexOf('\n  };', vAt) + 4;
  const fAt = build.indexOf('function findingWhy(e)');
  const fEnd = build.indexOf('const esc = s =>', fAt);
  if (vAt < 0 || fAt < 0 || fEnd < 0) return () => null;
  const box = {};
  vm.runInNewContext(build.slice(vAt, vEnd) + '\n' + build.slice(fAt, fEnd) + '\nthis.findingWhy = findingWhy;', box);
  return box.findingWhy;
})();

// ---- an UNNAMED INBOX in force (the TWO DOORS starter as it is placed) ----
{
  const st = stamped('two_doors');
  const ins = st.props().filter(p => p.t === 'intake').map(p => p.id);
  A.eq(ins.length, 2, 'fixture: two doors has two INBOXes on one line');
  A.eq(ins.map(id => (st.propById(id).label || '').trim()), ['', ''], 'fixture: both INBOXes are unnamed, as placed');
  A.eq(shadowed(planOf(st)).length, 0, 'no budget anywhere: no finding');
  st.setPropLimits(ins[1], { maxUsdPerMessage: 5 });
  A.eq(shadowed(planOf(st)).length, 0, 'ONE INBOX with a budget: it is in force, nothing to flag');
  st.setPropLimits(ins[0], { maxUsdPerMessage: 2, maxHops: 6 });
  const plan = planOf(st);
  const f = shadowed(plan);
  A.eq(f.length, 1, 'a second INBOX carrying its own LINE BUDGET is flagged once');
  A.eq(f[0].propId, ins[1], 'on the INBOX whose budget is NOT used');
  A.eq(f[0].inForce, ins[0], 'naming the INBOX whose LINE BUDGET is in force');
  A.eq(f[0].warn, true, 'advice, never a blocker');
  const rec = plan.lines.find(l => l.intakes.indexOf(ins[0]) >= 0);
  A.eq(f[0].lineId, rec.lineId, 'on that line');
  A.eq(rec.limits.maxUsdPerMessage, 2, 'the budget in force is unchanged: the oldest INBOX that carries one');
  A.ok(!plan.errors.some(e => !e.warn), 'the plan still deploys');
  A.eq(f[0].inForceName, '', 'an unnamed INBOX in force carries no name');
  A.eq(f[0].inForceBudget, '6 max stages after the first · $2.00 per message', 'it carries the numbers its own card shows set, in the card\'s words');
  const why = findingWhy(f[0]);
  A.ok(typeof why === 'string' && why.indexOf('6 max stages after the first · $2.00 per message') >= 0, 'the hover sentence points at the unnamed INBOX by those numbers: ' + why);
  A.ok(why.indexOf('$5.00') < 0, 'and never by the ignored INBOX\'s own numbers');
}

// ---- a LABELLED INBOX in force is named ----
{
  const st = stamped('two_doors');
  const ins = st.props().filter(p => p.t === 'intake').map(p => p.id);
  st.setPropLabel(ins[0], 'Front door');
  st.setPropLimits(ins[0], { maxHops: 4 });
  st.setPropLimits(ins[1], { maxHops: 9, maxUsdPerDay: 3 });
  const f = shadowed(planOf(st));
  A.eq(f.length, 1, 'flagged once with a named INBOX in force');
  A.eq([f[0].propId, f[0].inForce], [ins[1], ins[0]], 'on the ignored INBOX, naming the one in force');
  A.eq(f[0].inForceName, 'Front door', 'it carries the in-force INBOX\'s label');
  const why = findingWhy(f[0]);
  A.ok(typeof why === 'string' && why.indexOf('the INBOX “Front door”') >= 0, 'the hover sentence names it: ' + why);
  A.eq(findingWhy({ code: 'LINE_BUDGET_SHADOWED', propId: 'p1', warn: true }).indexOf('first INBOX on it that carries a budget') >= 0, true, 'with neither a name nor numbers it falls back to the generic sentence');
}

// ---- both floor-callout tables name it ----
{
  const world = readFrontendSource('world.js');
  A.ok(/LINE_BUDGET_SHADOWED: '[^']+'/.test(build.slice(build.indexOf('const VAL_LABEL = {'), build.indexOf('};', build.indexOf('const VAL_LABEL = {')))), 'REFIT\'s VAL_LABEL names the finding');
  A.ok(/LINE_BUDGET_SHADOWED: '[^']+'/.test(world.slice(world.indexOf('const NAG_LABEL = {'), world.indexOf('};', world.indexOf('const NAG_LABEL = {')))), 'the live world\'s NAG_LABEL names it too');
}

A.report('line-budget-shadowed.test');
