/* node test/g1bprops.test.js — catalog/worldmodel consistency for G1b's two new props.

   STUDIO (feature 3 — closes the G0 dead-end where image_* tools mapped to a capability no prop granted):
   the full chain must line up end to end — catalog entry → CAP_PROP_MAP → bayObjects/heroCaps →
   the sidecar's CAP_REGISTRY.studio grants → the G0 pulse mapper. A break at ANY link (a rename, a
   dropped entry) fails here, not in a demo.

   MISSION BOARD (feature 2 — the quest log's body): functional-but-NOT-capability, in its OWN catalog
   category (the workstation-model rule) — it must grant no tools, ever. Plus source locks on the
   click-routing seam (world.js hit-test → app.js → StationUI.openTerm('quests')) and the pin feed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const readSourceText = require('./_source-text.js');

const WM = require('../frontend/app/worldmodel.js');
const PS = require('../frontend/app/propsprites.js');
const ToolProps = require('../frontend/app/toolprops.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

/* ================= STUDIO: every link of the object=capability chain ================= */
const st = PS.spec('studio');
A.ok(st, 'the catalog has a STUDIO prop');
A.eq(st.cat, 'capability', 'STUDIO lives in the CAPABILITY category (it grants a real power)');
A.eq(st.tier, 'functional', 'STUDIO is a SYSTEMS-tier prop');
A.ok(PS.has('studio'), 'STUDIO has a real draw function (the palette preview + floor render work)');
A.eq(WM.CAP_PROP_MAP.studio, 'studio', 'CAP_PROP_MAP maps the studio prop to the studio capability');
A.ok(WM.CAP_LABEL.studio, 'the studio capability has a plain power word (palette tile + Field Manual)');
A.eq(WM.grantLabelForProp('studio'), WM.CAP_LABEL.studio, 'grantLabelForProp resolves it (placement toast says the same word)');
// the sidecar side: the capability the prop grants really carries the image tools
const grants = (CAP_REGISTRY.studio || []).map(g => g.tool);
A.ok(grants.indexOf('image_generate') >= 0, 'CAP_REGISTRY.studio grants image_generate');
A.ok(grants.indexOf('image_analyze') >= 0, 'CAP_REGISTRY.studio grants image_analyze');
// the G0 pulse mapper: an image tool firing lights a prop of type studio (capPropFor matches via capForProp)
A.eq(ToolProps.toolPropType('image_generate'), 'studio', 'toolPropType(image_generate) → studio (the G0 pulse lands on the placed prop)');
A.eq(ToolProps.toolPropType('image_analyze'), 'studio', 'toolPropType(image_analyze) → studio');

// end-to-end at the model layer: a bay-bound agent's room containing a STUDIO grants the studio objectType —
// exactly what the sidecar's resolveTools consumes (and what World.heroCaps forwards as `placed`).
{
  const m = WM.create();
  const bay = m.addProp({ t: 'bay', x: 2, y: 2, w: 2, h: 2, agentId: 'a1' });
  A.ok(bay.ok, 'bay placed in the starter room');
  A.eq(m.bayObjects('a1').indexOf('studio'), -1, 'no studio placed → studio NOT granted');
  const sp = m.addProp({ t: 'studio', x: 8, y: 2, w: st.w, h: st.h });
  A.ok(sp.ok, 'studio placed in the same room');
  A.ok(m.bayObjects('a1').indexOf('studio') >= 0, 'placing the STUDIO genuinely grants the studio capability to the room\'s agent');
  A.eq(m.capForProp('studio'), 'studio', 'station.capForProp knows the studio prop (world.js capPropFor pulse targeting)');
}

/* ================= ROOM SCOPE: an empty assigned bay is not "no bay" =================
   world.js is a browser IIFE, so extract the shipped heroCaps method and execute it against the real
   WorldModel. bayObjects() returns [] both when an agent has no bay and when its assigned room is genuinely
   empty. Only the first case may use the legacy station-wide fallback. */
{
  const world = readSourceText(path.join(__dirname, '../frontend/app/world.js'));
  const begin = world.indexOf('heroCaps: (agentId) => {');
  const end = world.indexOf('\n    },\n    // STATION-WIDE gear', begin);
  A.ok(begin >= 0 && end > begin, 'the shipped World.heroCaps method is extractable');
  const method = world.slice(begin, end + '\n    }'.length).replace(/^heroCaps:\s*/, '');
  const bindHeroCaps = station => new Function('station', 'return (' + method + ');')(station);

  const m = WM.create();
  const annex = m.addRoom({ kind: 'lab', rect: { x1: 18, y1: 0, x2: 26, y2: 8 } });
  A.ok(annex.ok, 'a second capability-isolation room is placed');
  A.ok(m.addProp({ t: 'comms_dish', x: 2, y: 2, w: 1, h: 1, block: true }).ok,
    'the original room holds station-wide WEB gear');
  A.ok(m.addProp({ t: 'workbench', x: 4, y: 2, w: 2, h: 1, block: true }).ok,
    'the original room holds station-wide TERMINAL gear');
  A.ok(m.addProp({ t: 'bay', x: 20, y: 2, w: 2, h: 2, block: true, agentId: 'isolated' }).ok,
    'the isolated agent has a bay in the empty second room');

  const heroCaps = bindHeroCaps(m);
  A.eq(m.agentRoomId('isolated'), annex.id, 'the model proves the isolated agent has an assigned room');
  A.eq(m.bayObjects('isolated'), [], 'that assigned room truthfully has no capability objects');
  A.eq(heroCaps('isolated'), [], 'an empty assigned bay stays empty instead of inheriting station-wide gear');

  A.ok(m.addProp({ t: 'comms_dish', x: 23, y: 2, w: 1, h: 1, block: true }).ok,
    'WEB gear is placed inside the isolated room');
  A.eq(heroCaps('isolated'), [{ objectType: 'dish' }],
    'a bay-bound agent receives only the capability gear in its own room');
  A.ok(heroCaps('unbound').some(x => x.objectType === 'workbench'),
    'an agent with no bay keeps the legacy station-wide fallback');

  const faulted = bindHeroCaps({
    bayObjects: () => [],
    agentRoomId: () => { throw new Error('room index unavailable'); },
    doc: () => m.doc(),
    capForProp: t => m.capForProp(t)
  });
  A.eq(faulted('isolated'), [], 'an assigned-room lookup failure fails closed instead of widening reach');
}

/* ================= MISSION BOARD: functional-but-NOT-capability, own category ================= */
const mb = PS.spec('missionboard');
A.ok(mb, 'the catalog has a MISSION BOARD prop');
A.eq(mb.tier, 'functional', 'MISSION BOARD is a SYSTEMS-tier prop (it does something: projects + opens the quest log)');
A.eq(mb.cat, 'command', 'MISSION BOARD gets its OWN category (the workstation-model rule: functional-but-not-capability, never mixed into capability or cosmetics)');
A.ok(['workstation', 'workflow', 'capability', 'isolation'].indexOf(mb.cat) < 0, 'that category is none of the existing functional ones');
A.ok(PS.has('missionboard'), 'MISSION BOARD has a real draw function');
A.eq(WM.CAP_PROP_MAP.missionboard, undefined, 'MISSION BOARD grants NO capability (CAP_PROP_MAP has no entry)');
A.eq(WM.grantLabelForProp('missionboard'), null, '…and no power word (it is a projection, never a grant)');
{
  const m = WM.create();
  m.addProp({ t: 'bay', x: 2, y: 2, w: 2, h: 2, agentId: 'a1' });
  m.addProp({ t: 'missionboard', x: 8, y: 2, w: mb.w, h: mb.h });
  A.eq(m.bayObjects('a1').length, 0, 'a placed MISSION BOARD grants nothing to the room\'s agent — quests only suggest');
}

/* ================= the board's live wiring (browser flow — source locks) ================= */
const worldSrc = readSourceText(path.join(__dirname, '../frontend/app/world.js'));
A.ok(/function missionBoardAt\(/.test(worldSrc), 'world.js hit-tests the MISSION BOARD (the OUTBOX click seam, cloned)');
A.ok(/setOnMissionBoard/.test(worldSrc), 'world.js exposes the click callback');
A.ok(/setMissionPins/.test(worldSrc), 'world.js feeds the live open-quest count to the sprite (pins are real, never invented)');
const appSrc = readSourceText(path.join(__dirname, '../frontend/app/app.js'));
A.ok(/setOnMissionBoard/.test(appSrc) && /openTerm\('quests'\)/.test(appSrc), 'app.js routes the board click to the QUEST LOG panel');
const psSrc = readSourceText(path.join(__dirname, '../frontend/app/propsprites.js'));
A.ok(/setMissionPins/.test(psSrc) && /missionboard/.test(psSrc), 'propsprites carries the pin feed + the board sprite');
// The palette's category display names moved out of build.js and into propsprites.js, next to the
// catalog they describe, so propsearch.js can match on them too. Assert the DATA, not a source grep:
// a grep for /command:/ passed for the wrong reason the moment the map lived anywhere else.
const PropSprites = require('../frontend/app/propsprites.js');
A.eq(PropSprites.CAT_LABEL.command, 'COMMAND', 'the builder palette names the COMMAND category');
A.ok((PropSprites.CATS.command || []).some(c => c.id === 'missionboard'),
  'the MISSION BOARD is on the COMMAND shelf the palette renders');

A.report('g1bprops.test');
