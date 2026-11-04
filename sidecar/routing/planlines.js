/* sidecar/routing/planlines.js — SELF-HEAL THE LINE MAP OF A PLAN THAT PREDATES LINE IDENTITY.

   WHY THIS EXISTS. `lineOfAgent` (which physical line a dock belongs to) is compiled by
   frontend/app/pipeline.js from the floor's GEOMETRY and rides the posted RoutingPlan. The sidecar used to restore
   the last accepted plan from disk at boot (the retired routing.plan.json) so a headless service kept routing
   Telegram + cron traffic with no browser open; the posted-plan router (pure-router fixtures) still heals a plan
   it is handed the same way. A plan written BEFORE line identity existed carries no line
   map at all — and Pipeline.chainNext reads a missing map as "every dock is terminal". On a desktop that
   self-heals the moment the app opens and re-posts; on a headless/service sidecar taking channel and routine
   traffic it does not, so every multi-stage line silently ran stage one only, forever.

   WHAT IT DOES. Derives the same COMPONENTS the compiler derives — connected runs of belt tiles (4-neighbour,
   direction-blind), plus every machine that touches a run through its footprint + 1-tile ring — using only the
   geometry the stored plan already carries: `belts`, `sources.tiles`, `bays.tiles`, `dockBays` footprints,
   `unboundBays`, `outs`. Pure: no clock, no RNG, inputs never mutated (a healed plan is a shallow clone).

   WHAT IT DELIBERATELY DOES NOT DO. It does not invent a plan. A stored plan records no PROP for a junction
   (the compiler keys junctions by tile), so a junction prop id can neither join nor name a component here.
   Two consequences, both chosen:
     · a component's `lineId` is the smallest MACHINE prop id it can see, which may differ from the id a fresh
       browser compile would pick if a junction prop sorted smaller. Nothing durable compares the two — the
       chain gate compares a carried id against the SAME plan's answer, the crate marker is only read for
       presence (world.js dockLineWork), and a routine's opt-in is a flag, not a stored id. The moment a
       browser posts a real plan the compiled ids take over.
     · a junction prop whose ring BRIDGES two otherwise separate belt runs is not seen, so those runs heal as
       TWO lines rather than one. That is the safe direction: under-merging can only make a dock terminal
       (a line that did not run, visible and re-triggerable), never buy a stage the work never entered. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');

const key = (x, y) => x + ',' + y;

// every belt tile on a prop's footprint + 1-tile ring — the compiler's exact hookup rule.
function ringTiles(map, x, y, w, h) {
  const out = [];
  const pw = w || 1, ph = h || 1;
  for (let yy = y - 1; yy <= y + ph; yy++)
    for (let xx = x - 1; xx <= x + pw; xx++)
      if (map[key(xx, yy)]) out.push(key(xx, yy));
  return out;
}

/* deriveLines(plan) -> { lines, lineOfProp, lineOfAgent } computed from the stored plan's own geometry.
   Deterministic: components sorted by lineId, member props sorted, an agent takes the FIRST line that
   claims it — the same tie-breaks Pipeline.compileRoutingPlan uses. */
function deriveLines(plan) {
  const map = (plan && plan.belts) || {};
  const parent = {};
  const find = k => { let r = k; while (parent[r] !== r) r = parent[r]; let c = k; while (parent[c] !== r) { const n = parent[c]; parent[c] = r; c = n; } return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (const k in map) parent[k] = k;
  for (const k in map) {
    const p = k.split(','), x = +p[0], y = +p[1];
    for (const nk of [key(x + 1, y), key(x - 1, y), key(x, y + 1), key(x, y - 1)]) if (map[nk]) union(k, nk);
  }

  // propId -> the belt tiles it hooks onto (a prop can appear on several of the plan's lists; merge them)
  const propHits = {}, kindOf = {};
  const note = (propId, kind, tiles) => {
    if (!propId || !tiles || !tiles.length) return;
    const id = String(propId), bag = propHits[id] || (propHits[id] = []);
    for (const t of tiles) if (map[t] && bag.indexOf(t) < 0) bag.push(t);
    if (kind && !kindOf[id]) kindOf[id] = kind;
  };
  const tileKeys = rec => {
    const ts = (rec && rec.tiles && rec.tiles.length) ? rec.tiles : (rec && rec.tile ? [rec.tile] : []);
    return ts.map(t => key(t.x, t.y));
  };
  for (const s of (plan.sources || [])) note(s.propId, 'intake', tileKeys(s));
  for (const o of (plan.outs || [])) note(o.propId, 'outbox', tileKeys(o));       // one entry PER mouth — merged by propId
  for (const u of (plan.unboundBays || [])) note(u.propId, 'bay', tileKeys(u));
  for (const b of (plan.bays || [])) note(b.propId, 'bay', tileKeys(b));
  // dockBays carry the FOOTPRINT, so their hookups can be recomputed exactly (this is the same ring scan the
  // compiler runs) — that matters for a dock recorded on dockBays only (beltless docks contribute nothing).
  for (const d of (plan.dockBays || [])) note(d.propId, 'bay', ringTiles(map, d.x, d.y, d.w, d.h));

  const agentOfProp = {};
  for (const b of (plan.bays || [])) if (b.propId && b.agentId) agentOfProp[String(b.propId)] = String(b.agentId);
  for (const d of (plan.dockBays || [])) if (d.propId && d.agentId) agentOfProp[String(d.propId)] = String(d.agentId);

  const byRoot = {};
  for (const id of Object.keys(propHits)) {
    const hits = propHits[id];
    if (!hits.length) continue;                      // a beltless machine is on no line
    for (let i = 1; i < hits.length; i++) union(hits[0], hits[i]);
  }
  // re-read the roots AFTER every union (a prop can bridge two runs through its own ring)
  for (const id of Object.keys(propHits)) {
    const hits = propHits[id];
    if (!hits.length) continue;
    const r = find(hits[0]);
    const c = byRoot[r] || (byRoot[r] = { props: [], intakes: [], outboxes: [] });
    c.props.push(id);
    if (kindOf[id] === 'intake') c.intakes.push(id);
    else if (kindOf[id] === 'outbox') c.outboxes.push(id);
  }

  const comps = [];
  for (const r in byRoot) {
    const c = byRoot[r];
    if (!c.props.length) continue;
    c.props.sort(); c.intakes.sort(); c.outboxes.sort();
    c.lineId = c.props[0];
    comps.push(c);
  }
  comps.sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));

  const lines = [], lineOfProp = {}, lineOfAgent = {};
  for (const c of comps) {
    const rec = { lineId: c.lineId, propIds: c.props.slice(), intakes: c.intakes.slice(), outboxes: c.outboxes.slice(), agents: [] };
    for (const pid of c.props) lineOfProp[pid] = c.lineId;
    for (const pid of c.props) { const aid = agentOfProp[pid]; if (aid && !lineOfAgent[aid]) { lineOfAgent[aid] = c.lineId; rec.agents.push(aid); } }
    rec.agents.sort();
    lines.push(rec);
  }
  return { lines, lineOfProp, lineOfAgent };
}

/* healPlan(plan) -> the plan, or a shallow clone filling whichever DERIVABLE layer it lacks:
     · the LINE map (lines / lineOfProp / lineOfAgent) — a plan written before line identity (2026-08-07);
     · the DOCK layer (bayTileToDock / agentOfDock / docksOfAgent / dockChains / reachDock / gateDocks /
       lineOfDock / entryDock) — a plan written before multi-bay agents (2026-09-22), marked docksDerived:true.
   ⛔ The early return used to fire on `lineOfAgent` alone, which EVERY plan since 2026-08-07 carries — so a
   stored plan with no dock layer would never have been healed. A plan returns untouched only when it answers
   BOTH layers: the compiled answer is always the authority; this only fills holes. The dock layer comes from
   Pipeline.deriveDockLayer — the same helpers the compiler attaches it with — and is lossless for any plan
   compiled while DUP_AGENT was in force (one dock per agent). */
const hasLines = p => Object.prototype.hasOwnProperty.call(p, 'lineOfAgent') && p.lineOfAgent && typeof p.lineOfAgent === 'object';
function healPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const linesOk = hasLines(plan), docksOk = Pipeline.hasDockLayer(plan);
  if (linesOk && docksOk) return plan;
  let out = plan;
  if (!linesOk) {
    const d = deriveLines(plan);
    out = Object.assign({}, plan, { lines: d.lines, lineOfProp: d.lineOfProp, lineOfAgent: d.lineOfAgent, linesDerived: true });
    if (Array.isArray(plan.dockBays)) {
      out.dockBays = plan.dockBays.map(b => {
        const l = b && b.propId != null ? d.lineOfProp[String(b.propId)] : null;
        return l ? Object.assign({}, b, { lineId: l }) : b;
      });
    }
  }
  if (!docksOk) {
    const L = Pipeline.deriveDockLayer(out);
    out = Object.assign({}, out, L, { docksDerived: true });
  }
  return out;
}

module.exports = { healPlan, deriveLines, _internals: { ringTiles } };
