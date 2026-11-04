/* test/guidedline.test.js — guided workflows Phase 1+2 headless contract (2026-08-05).

   Under lock:
     1. ROLES: every blueprint BAY carries a `role` resolvable in WorldModel.BAY_ROLES (placard
        copy + a summon class); non-bay machines carry none.
     2. A stamped bay's prop carries the role; it SURVIVES the serialize/deserialize round-trip
        (the migrate() prop whitelist) and rides projectGeometry to the renderers. Binding an
        agent does not strip it (role is provenance, not a gate).
     3. Hand-placed bays have no role (roles are blueprint meaning, not a bay default).
     4. LINE COMPONENTS (Pipeline.lineComponents): a stamped line groups into ONE component with
        the saved INBOX's stable key, correct machine membership, and a `tiles` set
        that contains its belt tiles (the delivery-retirement hit-test). Two separate lines are
        two components. Checklist derivation: crew-left = unbound bays of the component, in
        lockstep with the compiled plan's UNBOUND_BAY warns, and reaches zero when crewed. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');

/* ---- 1. catalog: role-carrying bays, resolvable roles ---- */
A.ok(WM.BAY_ROLES && typeof WM.BAY_ROLES === 'object', 'BAY_ROLES catalog ships');
for (const bp of WM.BLUEPRINTS) {
  for (const s of bp.props) {
    if (s.t === 'bay') {
      A.ok(typeof s.role === 'string' && s.role, bp.id + ': every blueprint bay carries a role');
      const ri = WM.bayRoleInfo(s.role);
      A.ok(ri && typeof ri.desc === 'string' && ri.desc, bp.id + ': role ' + s.role + ' resolves to placard copy');
      A.ok(typeof ri.cls === 'string' && ri.cls, bp.id + ': role ' + s.role + ' names a summon class');
    } else {
      A.ok(!s.role, bp.id + ': non-bay machine ' + s.t + ' carries no role');
    }
  }
}
A.eq(WM.bayRoleInfo('NOT_A_ROLE'), null, 'an unknown role resolves to null (data, not a throw)');

/* ---- the summon classes are REAL Specialties ids (the creation seam resolves them) ---- */
{
  const Specialties = require('../frontend/app/specialties.js');
  const seen = {};
  for (const r in WM.BAY_ROLES) {
    const cls = WM.BAY_ROLES[r].cls;
    if (seen[cls]) continue; seen[cls] = 1;
    A.ok(Specialties.get(cls), 'role class "' + cls + '" exists in the Specialties catalog');
  }
}

function freshFloor() {
  const s = WM.create();
  const r = s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 59, y2: 14 } });
  A.ok(r.ok, 'test deck placed');
  return s;
}

/* ---- 2. stamp -> prop.role; save round-trip; geometry projection; binding keeps it ---- */
{
  const s = freshFloor();
  const res = s.stampBlueprint('research_line', 32, 2);
  A.ok(res.ok, 'research_line stamps');
  const bays = s.props().filter(p => p.t === 'bay');
  A.eq(bays.length, 2, 'two bays stamped');
  A.eq(bays[0].role, 'RESEARCHER', 'first bay stamps as RESEARCHER');
  A.eq(bays[1].role, 'WRITER', 'second bay stamps as WRITER');
  A.ok(s.props().filter(p => p.t !== 'bay').every(p => !p.role), 'intake/outbox stamp roleless');

  // geometry carries it to the renderers (REFIT callouts + world nags read geo.props)
  const geo = s.projectGeometry();
  const gb = geo.props.filter(p => p.t === 'bay');
  A.ok(gb.length === 2 && gb[0].role === 'RESEARCHER' && gb[1].role === 'WRITER', 'projectGeometry emits role');

  // binding does NOT strip the role (provenance, never a gate)
  A.ok(s.assignPropAgent(bays[0].id, 'crew0').ok, 'bay binds');
  A.eq(s.propById(bays[0].id).role, 'RESEARCHER', 'role survives binding');

  // save round-trip: the migrate() whitelist keeps `role`
  const back = WM.deserialize(s.serialize());
  const b2 = back.props().filter(p => p.t === 'bay');
  A.eq(b2[0].role, 'RESEARCHER', 'role survives serialize/deserialize (bay 1)');
  A.eq(b2[1].role, 'WRITER', 'role survives serialize/deserialize (bay 2)');
  A.eq(b2[0].agentId, 'crew0', 'binding also survives (whitelist untouched)');
}

/* ---- 3. hand-placed bays carry no role ---- */
{
  const s = freshFloor();
  const r = s.addProp({ t: 'bay', x: 32, y: 2, w: 2, h: 2 });
  A.ok(r.ok, 'hand bay places');
  A.ok(!s.props().find(p => p.t === 'bay').role, 'a hand-placed bay has no role');
}

/* ---- 4. line components + checklist derivation ---- */
{
  const s = freshFloor();
  A.ok(s.stampBlueprint('research_line', 32, 2).ok, 'line 1 stamps');
  let geo = s.projectGeometry();
  let comps = P.lineComponents(geo);
  A.eq(comps.length, 1, 'one stamped line = one component');
  const c = comps[0];
  A.eq(c.props.length, 4, 'component holds all four machines');
  A.eq(c.bays.length, 2, 'component sees both bays');
  A.eq(c.intakes.length, 1, 'component sees the intake');
  A.eq(c.outboxes.length, 1, 'component sees the outbox');
  A.eq(c.beltCount, 9, 'component counts every belt tile');
  const inbox = s.propById(c.intakes[0]);
  A.ok(typeof inbox.lineId === 'string' && inbox.lineId.length > 0, 'the stamped INBOX has a saved line identity');
  A.eq([c.key, c.intakeId], [inbox.lineId, inbox.id], 'component identity belongs to its saved INBOX');
  A.ok(c.bays.every(b => b.role), 'component bays carry their roles');

  // tiles set contains a known belt tile (the delivery-retirement hit-test contract).
  // Stamp origin (32,2) world -> local via geo.origin; belt at world (34,3) = bp belt (2,1).
  const o = geo.origin;
  A.ok(c.tiles[(34 - o.tx) + ',' + (3 - o.ty)], 'tiles set holds the line\'s belt tiles (local frame)');

  // crew-left derives in lockstep with the compiled plan's UNBOUND_BAY warns
  let plan = P.compileRoutingPlan(geo);
  const unboundWarns = plan.errors.filter(e => e.code === 'UNBOUND_BAY').length;
  const crewLeft = c.bays.filter(b => !b.agentId).length;
  A.eq(crewLeft, 2, 'fresh stamp: two docks to crew');
  A.eq(crewLeft, unboundWarns, 'component crew-left == compiled UNBOUND_BAY warns');

  // bind one -> 1 left; bind both -> 0 and the plan agrees
  const bayIds = c.bays.map(b => b.propId);
  A.ok(s.assignPropAgent(bayIds[0], 'crewA').ok, 'dock 1 crews');
  geo = s.projectGeometry(); comps = P.lineComponents(geo);
  A.eq(comps[0].bays.filter(b => !b.agentId).length, 1, 'one dock left after first crew');
  A.ok(s.assignPropAgent(bayIds[1], 'crewB').ok, 'dock 2 crews');
  geo = s.projectGeometry(); comps = P.lineComponents(geo); plan = P.compileRoutingPlan(geo);
  A.eq(comps[0].bays.filter(b => !b.agentId).length, 0, 'zero docks left when fully crewed');
  A.eq(plan.errors.filter(e => e.code === 'UNBOUND_BAY').length, 0, 'plan agrees: no UNBOUND_BAY warns');

  // key stability: crewing the docks did not change the line's identity
  A.eq(comps[0].key, c.key, 'line key is stable across crewing edits');

  // two separate lines = two components, deterministic order
  A.ok(s.stampBlueprint('ship_out', 32, 10).ok, 'line 2 stamps');
  comps = P.lineComponents(s.projectGeometry());
  A.eq(comps.length, 2, 'two stamped lines = two components');
  A.ok(comps[0].key < comps[1].key, 'components sort by key (deterministic)');

  // a bare belt scribble (no machine) is NOT a line
  A.ok(s.setBelt(31, 8, 'E').ok && s.setBelt(32, 8, 'E').ok, 'stray belts laid');
  A.eq(P.lineComponents(s.projectGeometry()).length, 2, 'machine-less belt runs are not lines');
}

A.report('guidedline');
