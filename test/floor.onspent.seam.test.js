/* node test/floor.onspent.seam.test.js — A GATE'S onSpent POLICY SURVIVES THE SAVED FLOOR (line-hold lane; invariant floor-carries-gate-policy).

   A LOOP gate may say what happens when its passes run out with the work still unapproved: 'hold' (stop for a person) or 'escalate' (the
   escalation lane; an OUTBOX the lane only reaches ends the crate there, unapproved). The compiler reads it off the gate's prop
   (pipeline.js `p.onSpent`), and every test of the policy fed the compiler RAW geometry. The product never does: a floor is a world
   document (WorldModel.create), its geometry is projected from it (projectGeometry), and the station's router reads the compiled plan.
   The world model whitelists a junction's settings field by field, so the policy was stripped on load, on every save and by every
   configureJunction: the saved floor could not hold it, and the exhausted-revise half of GitHub #122 ("hold" for a person) could not be
   switched on by any floor a person could build.

   This test builds through the product path — a saved world document, WorldModel.create, projectGeometry, the compiler, a JSON round
   trip (the POST /api/routing wire), the sidecar's router — and asks the gate what it will do. It also guards the class: every list in
   the frontend that names a junction's settings (maxIter beside when) names onSpent too. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { geometry } = require('./helpers/line-hold-rig.js');

// a saved world document of the rig's review line: the gate's props, the belts and a room that holds them (the world document the app saves)
function docWith(gate) {
  const geo = geometry(gate, 'esc to an OUTBOX only');
  const doc = WM.starterDoc();
  for (const id in doc.rooms) for (const r of doc.rooms[id].rects) { r.x2 = 60; r.y2 = 30; }
  doc.props = geo.props.map(p => Object.assign({}, p, { block: undefined }));
  doc.belts = {};
  for (const b of geo.belts) doc.belts[b.x + ',' + b.y] = b.dir;
  doc.links = null;
  return doc;
}
const loopOf = st => st.props().find(p => p.t === 'loop');
const gateOf = plan => { const k = Object.keys(plan.junctions).find(x => plan.junctions[x].kind === 'loop'); return k ? plan.junctions[k] : null; };
const planOf = st => P.compileRoutingPlan(st.projectGeometry());

// 1. a saved floor that carries the policy: load, project, compile, wire, router
for (const policy of ['hold', 'escalate']) {
  const st = WM.create(docWith({ onSpent: policy, maxIter: 2 }));
  A.eq(loopOf(st).onSpent, policy, policy + ': the document loads with the gate\'s policy');
  const geoLoop = st.projectGeometry().props.find(p => p.t === 'loop');
  A.eq(geoLoop.onSpent, policy, policy + ': the geometry the compiler reads carries it');
  const plan = planOf(st);
  A.eq(gateOf(plan) && gateOf(plan).onSpent, policy, policy + ': the compiled plan\'s gate has it');
  const wire = JSON.parse(JSON.stringify(plan)), router = makeRouter();
  A.ok(router.setPlan(wire).ok, policy + ': the station accepts the plan it was posted');
  const gate = router.loopGateAfter('reviewer', null, 'p3');
  A.ok(gate && gate.onSpent === policy, policy + ': and its router, asked what the reviewer\'s gate will do, says so: ' + JSON.stringify(gate));
  const again = WM.create(st.serialize());
  A.eq(loopOf(again).onSpent, policy, policy + ': the saved document, loaded again, still has it');
  A.eq(gateOf(planOf(again)).onSpent, policy, policy + ': and compiles to it again');
}

// 2. the default stays the default: a gate that never said it compiles to the plan it always did (no field at all)
{
  const st = WM.create(docWith({ maxIter: 2 })), bare = gateOf(planOf(st));
  A.ok(bare && !('onSpent' in bare), 'a gate with no policy compiles to a gate with no onSpent field: every older floor\'s plan and hash is what it was');
  A.ok(!('onSpent' in loopOf(st)) && !('onSpent' in st.projectGeometry().props.find(p => p.t === 'loop')), 'and nothing is written for it on the prop or in the geometry');
}

// 3. only the two policies are kept: anything else on a document is dropped on load
for (const bad of ['send', 'HOLD', 'bogus', 7, true, {}, null]) {
  const st = WM.create(docWith({ onSpent: bad, maxIter: 2 }));
  A.ok(!('onSpent' in loopOf(st)), 'a document carrying onSpent ' + JSON.stringify(bad) + ' loads without it');
}

// 4. the settings path (configureJunction — the panel and the station designer both save through it)
{
  const st = WM.create(docWith({ maxIter: 2 })), id = loopOf(st).id;
  const set = st.configureJunction(id, { maxIter: 2, when: 'approved', onSpent: 'hold' });
  A.ok(set.ok && set.onSpent === 'hold', 'configureJunction says what it kept: ' + JSON.stringify(set));
  A.eq(gateOf(planOf(st)).onSpent, 'hold', 'a policy set through configureJunction compiles');
  st.configureJunction(id, { maxIter: 3, when: 'approved' });
  A.ok(!('onSpent' in loopOf(st)), 'a save that does not name the policy replaces it (settings are replaced wholesale, like every other field of the gate)');
  st.configureJunction(id, { maxIter: 3, when: 'approved', onSpent: 'escalate' });
  st.configureJunction(id, null);
  A.ok(!('onSpent' in loopOf(st)), 'and clearing the gate\'s settings clears it');
  st.configureJunction(id, { onSpent: 'bogus' });
  A.ok(!('onSpent' in loopOf(st)), 'a policy that is not one of the two is never stored');
}

// 5. the WORKFLOW panel's gate save names the policy it finds on the gate, so editing passes or the verdict never switches it off
{
  const panel = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/workflowpanel.js'), 'utf8');
  const at = panel.indexOf('const saveGate = () => {'), body = panel.slice(at, panel.indexOf('const res = H.station().configureJunction', at));
  A.ok(/cfg\.onSpent\s*=\s*p\.onSpent/.test(body), 'the panel\'s gate save carries the gate\'s policy through (it replaces the settings wholesale)');
}

// 6. a copy of the gate (the clip a COPY puts down) and the blueprint specs keep it
{
  const st = WM.create(docWith({ onSpent: 'hold', maxIter: 2 })), id = loopOf(st).id;
  const copied = st.copyLines([id]);
  A.ok(copied.ok && copied.clip.nodes.some(n => n.cfg && n.cfg.onSpent === 'hold'), 'a copied gate carries its policy in the clip');
  const pasted = st.pasteLines(copied.clip, 40, 20), twin = st.props().filter(p => p.t === 'loop' && p.id !== id);
  A.ok(pasted.ok && twin.length === 1 && twin[0].onSpent === 'hold', 'and the copy put down has it: ' + JSON.stringify(pasted).slice(0, 160));
}

// 7. the class: every list in the frontend that names a junction's settings names onSpent too (the next field cannot be dropped by a list nobody remembered)
{
  const dir = path.join(__dirname, '..', 'frontend', 'app');
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.js$/.test(e.name)) files.push(f); } })(dir);
  const lists = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // an array literal of quoted words that has 'maxIter' and 'when' in it is a list of a gate's settings
    for (const m of src.matchAll(/\[(?:\s*'[A-Za-z]+'\s*,)+\s*'[A-Za-z]+'\s*\]/g)) if (/'maxIter'/.test(m[0]) && /'when'/.test(m[0])) lists.push({ file: path.relative(dir, f).replace(/\\/g, '/'), list: m[0] });
  }
  A.ok(lists.length >= 6, 'the scan finds the settings lists (worldmodel x3, build, buildshare, stationbuilder x2): ' + lists.map(x => x.file).join(', '));
  for (const x of lists) A.ok(/'onSpent'/.test(x.list), x.file + ' names a gate\'s settings and names onSpent: ' + x.list.slice(0, 120));
}

A.report('floor.onspent.seam');
