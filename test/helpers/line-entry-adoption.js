'use strict';
const P = require('../../frontend/app/pipeline.js');
const Chain = require('../../sidecar/routing/chain.js');
const C = require('../../sidecar/routing/line-continuation.js');
const { fixture, clone } = require('./line-entry.js');
const belt = (x, y, dir) => ({ x, y, dir });
function straight() {
  return { props: [
    { id: 'intake-a', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'line-a' },
    { id: 'dock-reviewer', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'reviewer' },
    { id: 'outbox-a', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
  ], belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E')] };
}
// Same real drawn fan/join geometry as pipeline.join-loop, not a siblings flag.
function split() {
  return { props: [
    { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'line-fan' },
    { id: 'p2', t: 'splitter', x: 3, y: 0, w: 1, h: 1 },
    { id: 'p3', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'A' },
    { id: 'p4', t: 'bay', x: 2, y: 4, w: 2, h: 2, agentId: 'B' },
    { id: 'p5', t: 'joiner', x: 9, y: 4, w: 1, h: 1 },
    { id: 'p6', t: 'bay', x: 12, y: 4, w: 2, h: 2, agentId: 'D' }
  ], belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'),
    belt(3, 1, 'S'), belt(3, 2, 'S'), belt(3, 3, 'S'), belt(8, 0, 'S'), belt(8, 1, 'S'), belt(8, 2, 'S'),
    belt(8, 3, 'S'), belt(8, 4, 'E'), belt(4, 5, 'E'), belt(5, 5, 'E'), belt(6, 5, 'E'), belt(7, 5, 'E'),
    belt(8, 5, 'E'), belt(9, 5, 'N'), belt(9, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E')] };
}
function boundChain(plan, extra) {
  return Chain.makeChainRunner(Object.assign({ nextAgent: () => null,
    stepDock: (dock, ctx) => P.chainStepDock(plan, dock, ctx),
    agentOfDock: dock => P.agentOfDock(plan, dock),
    lineOfAgent: (agent, dock) => P.agentOfDock(plan, dock) === agent ? P.lineOfDock(plan, dock) : null,
    fanSiblingsDock: dock => P.fanSiblingsDock(plan, dock)
  }, extra));
}
function data() {
  const f = fixture(), plan = P.compileRoutingPlan(straight());
  f.receipt.binding.planHash = plan.hash;
  f.job.line = f.receipt.binding.lineId = P.lineOfDock(plan, 'dock-reviewer');
  const entry = f.observed();
  entry.observation.files = []; entry.observation.product.files = [];
  entry.observation.outputDigest = C.entryOutputDigest(entry.observation.product);
  return Object.assign(f, { entry, plan, chain: boundChain(plan) });
}
module.exports = { P, C, clone, straight, split, boundChain, data };
