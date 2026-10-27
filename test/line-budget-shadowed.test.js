/* test/line-budget-shadowed.test.js — a SECOND INBOX's LINE BUDGET is flagged, naming the one in force (quick win 29).

   A line has ONE budget: the oldest INBOX that carries limits speaks (pipeline.js budgetIntake). A second INBOX on the same
   line could carry its own LINE BUDGET, show it in its card, and be silently ignored — the Commander raised "max stages"
   or the $ per job there and the line kept stopping at the other INBOX's numbers (memory: splitter-not-fixed-1010).
   Locked: compileRoutingPlan adds ONE warn finding on the ignored INBOX naming the INBOX whose budget is in force; it is
   advice (the plan still deploys), it never moves the budget the executor reads, and both floor-callout tables name it. */
'use strict';
const A = require('./_assert.js');
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

{
  const st = stamped('two_doors');
  const ins = st.props().filter(p => p.t === 'intake').map(p => p.id);
  A.eq(ins.length, 2, 'fixture: two doors has two INBOXes on one line');
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
  const named = st.propById(ins[0]).label;
  if (typeof named === 'string' && named.trim()) A.eq(f[0].inForceName, named.trim().slice(0, 48), 'and carries its name for the sentence');
  else A.eq(f[0].inForceName, '', 'an unnamed INBOX in force carries no name');
}

// ---- both floor-callout tables name it, and BUILD's sentence names the INBOX in force ----
{
  const { readFrontendSource } = (() => { const fs = require('fs'), path = require('path'); return { readFrontendSource: f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8') }; })();
  const build = readFrontendSource('build.js'), world = readFrontendSource('world.js');
  A.ok(/LINE_BUDGET_SHADOWED: '[^']+'/.test(build.slice(build.indexOf('const VAL_LABEL = {'), build.indexOf('};', build.indexOf('const VAL_LABEL = {')))), 'REFIT\'s VAL_LABEL names the finding');
  A.ok(/LINE_BUDGET_SHADOWED: '[^']+'/.test(world.slice(world.indexOf('const NAG_LABEL = {'), world.indexOf('};', world.indexOf('const NAG_LABEL = {')))), 'the live world\'s NAG_LABEL names it too');
  const why = build.slice(build.indexOf('function findingWhy(e)'), build.indexOf('const esc = s =>'));
  A.ok(/LINE_BUDGET_SHADOWED/.test(why) && /inForceName/.test(why), 'the hover sentence names the INBOX whose budget is in force');
}

A.report('line-budget-shadowed.test');
