'use strict';
const A = require('./_assert.js');
const { effectiveToolsets } = require('../sidecar/capability/effective-toolsets.js');
const row = (v, id) => v.toolsets.find(t => t.id === id);
const base = { agentId: 'nova', agent: { approvalMode: 'ask', executionProfile: 'station-gear' }, placed: [], disabled: { web: false } };
const ask = effectiveToolsets(base);
A.eq(row(ask, 'web').available, false, 'ASK respects missing placement and disabled switch');
const placed = effectiveToolsets({ ...base, placed: ['dish'], disabled: {} });
A.eq(row(placed, 'web').available, true, 'ASK plus prop grants capability');
A.eq(row(placed, 'web').consentGated, true, 'ASK retains registry consent policy');
for (const extra of [{ fullAccess: true }, { masterBypass: true }, { agent: { approvalMode: 'full', executionProfile: 'safe-cell' } }]) {
  const full = effectiveToolsets({ ...base, ...extra });
  A.eq(row(full, 'web').available, true, 'each real Full Access source overrides missing prop/disabled switch');
  A.eq(row(full, 'web').enabled, false, 'saved switch state remains inspectable');
  A.eq(row(full, 'web').switchEffective, false, 'UI cannot advertise the override as a working kill switch');
  A.eq(row(full, 'web').consentGated, false, 'Full Access does not claim asks first');
  A.eq(full.authority.filesystemLabel, 'Whole local computer', 'Full Access projects host scope independent of narrower profile');
}
for (const profile of ['safe-cell', 'remote-ssh', 'trusted-project', 'this-computer']) {
  const view = effectiveToolsets({ ...base, agent: { approvalMode: 'ask', executionProfile: profile } });
  A.eq(row(view, 'cabinet').available, true, 'profile grants cabinet without a prop: ' + profile);
  A.eq(row(view, 'cabinet').profileGranted, true, 'profile provenance disclosed: ' + profile);
  A.eq(view.authority.unrestricted, false, 'profile alone never becomes Full Access: ' + profile);
}
A.eq(effectiveToolsets({ ...base, fullAccess: true, masterBypass: true }).authority.source, 'environment', 'highest still-active override determines revoke guidance');
// Explanations must agree with the existing assigned-room model and host authority.
const Equipment = require('../frontend/app/equipmenthelp.js');
const WM = require('../frontend/app/worldmodel.js');
const station = WM.create();
station.addRoom({kind:'lab',rect:{x1:20,y1:0,x2:30,y2:10}});
for (const p of [
  {t:'war_intelcab',x:1,y:1,w:1,h:2},
  {t:'comms_dish',x:22,y:1,w:2,h:2},
  {t:'bay',x:4,y:4,w:2,h:2,agentId:'worker'},
  {t:'desk',x:25,y:5,w:2,h:1,agentId:'worker'}
]) A.ok(station.addProp(p).ok, 'explanation fixture prop fits');
const leadFiles = Equipment.inspect(station,'lead','war_intelcab');
const workerFiles = Equipment.inspect(station,'worker','war_intelcab');
A.eq(leadFiles.count,1,'unassigned lead sees the cabinet across the station');
A.eq(workerFiles.count,0,'remote bay does not grant cabinet from a different desk room');
A.ok(workerFiles.placed.includes('dish'),'worker explanation uses its desk room despite remote bay');
A.ok(!workerFiles.placed.includes('cabinet'),'no station-wide grant is invented for a room-bound worker');
const asView = (facts, extra={}) => effectiveToolsets({agentId:'worker',agent:{name:'Worker',approvalMode:'ask',executionProfile:'station-gear'},placed:facts.placed,...extra});
A.ok(Equipment.status(workerFiles,asView(workerFiles)).includes('place one matching prop'),'missing scope produces the matching next action');
A.ok(Equipment.status(workerFiles,asView(workerFiles,{fullAccess:true})).includes('No extra prop needed'),'Full Access never recommends redundant equipment');
A.ok(Equipment.status(leadFiles,asView(leadFiles,{disabled:{cabinet:false}})).includes('switched off'),'disabled toolset is not misdiagnosed as missing equipment');
A.ok(Equipment.status(workerFiles,null).includes('could not be checked'),'unavailable authority is never invented');
const PS = require('../frontend/app/propsprites.js');
for (const p of PS.CATALOG) {
  const cap = WM.capForProp(p.id), kind = Equipment.kind(p, cap);
  A.ok(['abilities','equipment','decoration'].includes(kind), 'every catalog item has one purpose: ' + p.id);
  if (cap && cap !== 'computer') A.eq(kind,'abilities','real ability never falls into decoration: ' + p.id);
  if (kind === 'decoration') A.ok(!cap && p.tier !== 'functional','decor has neither a tool grant nor a functional role: ' + p.id);
}
A.eq(Equipment.kind(PS.spec('desk'),'computer'),'equipment','desks are workstations, not one of the five tool families');
A.eq(Equipment.label({cat:'workflow',tier:'functional'},null),'WORKFLOW EQUIPMENT','routing machinery is not described as decoration');
A.eq(Equipment.kind({tier:'cosmetic'},'jukebox'),'abilities','actual grant takes priority over a legacy cosmetic category');
A.eq(Equipment.access('cabinet',asView(workerFiles)).state,'missing','equipment missing in the selected desk room is actionable');
A.eq(Equipment.access('cabinet',asView(leadFiles,{disabled:{cabinet:false}})).state,'off','placed but disabled is not reported available');
A.eq(Equipment.access('cabinet',asView(workerFiles,{fullAccess:true})).state,'available','host-granted access needs no extra prop');
A.eq(Equipment.access('cabinet',asView(workerFiles,{agent:{executionProfile:'trusted-project'}})).state,'available','profile-granted access counts without equipment');
A.eq(Equipment.access('cabinet',null).state,'unknown','failed read never implies missing equipment');
A.eq(Equipment.access('connector',asView(leadFiles)).state,'service','connection state is not inferred from generic toolsets');
const leadWeb = Equipment.inspect(station,'lead','comms_dish');
A.eq(Equipment.access('dish',asView(leadWeb,{disabled:{comms:false}})).state,'available','optional outbound messaging does not mislabel core browser access');
A.eq(JSON.stringify(WM.deserialize(station.serialize()).doc()),JSON.stringify(station.doc()),'reading explanations leaves saved station unchanged');
const { savedPlacement } = require('../sidecar/capability/saved-placement.js');
A.eq(savedPlacement({station:station.serialize()}, 'worker').map(o => o.objectType).sort(), workerFiles.placed.filter(t => t !== 'computer' && t !== 'connector').sort(), 'saved floor uses the same desk scope as equipment help');
A.ok(savedPlacement({station:station.serialize()}, 'lead').some(o => o.objectType === 'cabinet'), 'unassigned primary uses saved station gear');
const beforeSavedRead = JSON.stringify(station.serialize());
savedPlacement({station:station.serialize()}, 'worker');
A.eq(JSON.stringify(station.serialize()), beforeSavedRead, 'saved placement read is non-mutating');
A.eq(savedPlacement(null, 'worker'), [], 'no save grants nothing');
A.eq(savedPlacement({station:{props:[]}}, 'worker'), [], 'invalid save grants nothing');
const leadView = effectiveToolsets({...base, lead:true});
A.eq(row(leadView, 'orchestrator').available, true, 'interactive lead receives orchestration');
A.eq(row(leadView, 'orchestrator').placed, false, 'runtime grant does not fabricate a floor prop');
A.eq(row(leadView, 'orchestrator').grantSource, 'lead run', 'runtime grant source is explicit');
A.eq(row(effectiveToolsets({...base, lead:true, disabled:{orchestrator:false}}), 'orchestrator').available, false, 'lead grant respects family kill switch');
A.eq(row(ask, 'orchestrator').available, false, 'worker view never invents lead authority');
A.report('effective-toolsets');
