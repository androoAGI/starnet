/* node test/stationqueststore.test.js — the live wiring around the pure station-quest generator
   (frontend/app/stationqueststore.js). Verifies the G1b capdenied→quest contract end to end:
     • a real agent.tool_call whose capability the acting agent's room does NOT grant mints exactly one
       fix-it quest, titled from the LIVE catalog + roster (never hardcoded); repeats never duplicate;
     • a tool whose cap IS granted mints nothing; a cap NO placeable prop can grant (jukebox/Spotify —
       the OAuth story) mints nothing (the honesty guard: placement must be able to close every quest);
     • sync() resolves a gap the instant the floor grants the cap (placement = completion, no claim);
     • dismissal is permanent ACROSS RELOAD (own localStorage key) and blocks re-minting forever;
     • the old standing OUTBOX candidate is RETIRED (org P14): unattended work never mints "place a OUTBOX",
       and one an older build left open is waved off on load (never celebrated as done);
     • THE LAW: station quests never mint XP and the store never emits on U.bus — tripwire stubs throw
       if touched (the queststatestore.test.js idiom). Plus source-level locks on the browser wiring. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- stubs: storage, engines, live-floor reads, tripwires ---------- */
global.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; }
};
global.StationQuests = require('../frontend/app/stationquests.js');
global.ToolProps = require('../frontend/app/toolprops.js');   // the REAL tool→prop mapper (the signal's first hop)

// the catalog + cap maps are STUBBED (stable regardless of catalog growth); the REAL-map consistency for the
// new props is locked separately in test/g1bprops.test.js.
global.WorldModel = {
  CAP_PROP_MAP: { comms_dish: 'dish', studio: 'studio', war_intelcab: 'cabinet', core: 'notebook' },
  CAP_LABEL: { dish: 'WEB', studio: 'IMAGES', cabinet: 'FILES', notebook: 'MEMORY' }
};
global.PropSprites = {
  CATALOG: [
    { id: 'comms_dish', label: 'DISH' }, { id: 'studio', label: 'STUDIO' },
    { id: 'war_intelcab', label: 'INTEL CAB' }, { id: 'core', label: 'CORE' },
    { id: 'outbox', label: 'OUTBOX' }, { id: 'jukebox', label: 'JUKEBOX' }
  ]
};

// mutable live floor: per-agent granted caps + the station doc (for the OUTBOX candidate)
let caps = {};            // agentId -> ['dish', …]
let doc = { props: [] };
global.World = { heroCaps: id => (caps[id] || []).map(c => ({ objectType: c })), stationDoc: () => doc };
let pendingCrates = 0;
global.ReturnStore = { pendingCount: () => pendingCrates };
global.App = { agentName: id => (id === 'nova' ? 'NOVA' : null), heroId: () => 'hero' };

// THE LAW tripwires: minting/closing a station quest must never touch XP and never emit on the bus.
global.Xp = { applyEvent: () => { throw new Error('LAW VIOLATION: station quests must never mint XP'); }, compute: () => { throw new Error('LAW VIOLATION: station quests must never touch XP'); } };
global.XpStore = { onEvent: () => { throw new Error('LAW VIOLATION: station quests must never feed the XP engine'); } };
const listeners = {};
global.U = {
  bus: {
    emit: () => { throw new Error('LAW VIOLATION: stationqueststore must never emit on U.bus'); },
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }
  }
};
const rerenders = [];
global.StationUI = { invalidate: k => rerenders.push(k) };   // the render contract's background door

const { StationQuestStore } = require('../frontend/app/stationqueststore.js');
const fire = (name, agentId) => (listeners['agent.tool_call'] || []).forEach(fn => fn({ agentId, runId: 'r', callId: 'c', name }));

/* ---------- init binds the signal (subscription only) ---------- */
StationQuestStore.init();
A.ok((listeners['agent.tool_call'] || []).length === 1, 'init subscribes to agent.tool_call exactly once');
A.eq(StationQuestStore.quests().length, 0, 'a fresh store has no quests');

/* ---------- a real reach-for-the-web in a dish-less room mints THE quest ---------- */
fire('web_search', 'nova');
let qs = StationQuestStore.quests();
A.eq(qs.length, 1, 'one gap → one quest');
A.eq(qs[0].id, 'sq:nova:dish', 'keyed by (agent, capability)');
A.eq(qs[0].status, 'open', 'open until the floor really grants it');
A.ok(/NOVA reached for WEB — place a DISH/.test(qs[0].title), 'titled from the live roster + catalog: "NOVA reached for WEB — place a DISH …"');
A.ok(rerenders.indexOf('quests') >= 0, 'an open quest-log is poked to refresh');

/* ---------- repeats + granted tools + ungrantable caps mint nothing ---------- */
fire('web_fetch', 'nova');                       // same (agent, cap) via a different web tool
fire('browser.navigate', 'nova');
A.eq(StationQuestStore.quests().length, 1, 'repeat reaches for the same cap NEVER duplicate');
caps.rex = ['dish'];
fire('web_search', 'rex');
A.eq(StationQuestStore.quests().length, 1, 'a granted cap mints nothing (no gap, no quest)');
fire('spotify_play', 'nova');
A.eq(StationQuestStore.quests().length, 1, 'a cap no placeable prop grants (jukebox/OAuth) NEVER mints — placement could not close it');
fire('shell.exec', 'nova');
fire('mcp__github__search', 'nova');
A.eq(StationQuestStore.quests().length, 1, 'workbench/connector tools keep their own floor story — no mint');

/* ---------- the studio gap is a plain tool-gap through the same path ---------- */
fire('image_generate', 'nova');
qs = StationQuestStore.quests();
A.eq(qs.length, 2, 'an image tool in a studio-less room mints the studio quest');
A.ok(/NOVA reached for IMAGES — place a STUDIO/.test(qs.find(q => q.id === 'sq:nova:studio').title), 'the studio quest names the catalog prop');

/* ---------- completion: placing the prop (the floor granting the cap) closes the gap on sync ---------- */
caps.nova = ['dish'];
StationQuestStore.sync();
qs = StationQuestStore.quests();
A.eq(qs.find(q => q.id === 'sq:nova:dish').status, 'done', 'the dish landing flips the quest done — placement IS the completion signal');
A.eq(qs.find(q => q.id === 'sq:nova:studio').status, 'open', 'the studio gap stays open (its prop is not placed)');
A.eq(StationQuestStore.openCount(), 1, 'openCount tracks only live gaps');
const before = JSON.stringify(StationQuestStore.quests());
StationQuestStore.sync();
A.eq(JSON.stringify(StationQuestStore.quests()), before, 'sync is idempotent — a closed gap never re-transitions');

/* ---------- dismissal: permanent, survives reload, blocks re-minting ---------- */
A.eq(StationQuestStore.dismiss('sq:nova:studio'), true, 'dismissing an open fix-it takes (always dismissible — a suggestion, never a push)');
A.eq(StationQuestStore.quests().some(q => q.id === 'sq:nova:studio'), false, 'a dismissed quest never re-renders');
StationQuestStore.init();   // simulated app reload (re-hydrates from localStorage)
A.eq(StationQuestStore.isDismissed('sq:nova:studio'), true, 'dismissal survives a reload');
fire('image_generate', 'nova');
A.eq(StationQuestStore.quests().some(q => q.id === 'sq:nova:studio'), false, 'the same reach after reload NEVER re-mints (stop forever)');
A.eq(StationQuestStore.quests().find(q => q.id === 'sq:nova:dish').status, 'done', 'completion history survives the reload too');

/* ---------- the retired OUTBOX candidate (org P14): a station-wide pending count is no OUTBOX's work ---------- */
StationQuestStore.sync();
A.eq(StationQuestStore.quests().some(q => q.id.indexOf(':outbox') > 0), false, 'no unattended work → no OUTBOX quest');
pendingCrates = 2;
StationQuestStore.sync();
A.eq(StationQuestStore.quests().some(q => q.id.indexOf(':outbox') > 0), false, 'unattended work + no outbox placed → STILL no OUTBOX quest (away/cron/chat runs wait in DELIVERABLES › TO REVIEW, never on a chute)');
{
  // an OPEN one an older build saved is waved off on load — never flipped done (nothing was closed), never re-minted
  const saved = JSON.parse(global.localStorage.getItem('starnet.stationquests.v1'));
  saved.gaps['sq:hero:outbox'] = { agentId: 'hero', cap: 'outbox', capLabel: 'DELIVERY', propLabel: 'OUTBOX', agentLabel: 'The station', firstSeenAt: 1, lastSeenAt: 1, hits: 1, completedAt: null, dismissedAt: null };
  global.localStorage.setItem('starnet.stationquests.v1', JSON.stringify(saved));
  StationQuestStore.init();
  A.eq(StationQuestStore.quests().some(q => q.id === 'sq:hero:outbox'), false, 'a saved OPEN OUTBOX quest is retired on load');
  A.eq(StationQuestStore.isDismissed('sq:hero:outbox'), true, '…as a dismissal (it is not celebrated as done)');
  A.ok(JSON.parse(global.localStorage.getItem('starnet.stationquests.v1')).gaps['sq:hero:outbox'].dismissedAt != null, '…and the retirement is saved');
  doc = { props: [{ t: 'outbox', x: 1, y: 1 }] };
  StationQuestStore.sync();
  A.eq(StationQuestStore.quests().some(q => q.id === 'sq:hero:outbox'), false, 'placing an OUTBOX later never resurrects it');
}
const sqSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/stationqueststore.js'), 'utf8');
A.ok(!/evalOutboxCandidate/.test(sqSrc) && !/pendingCount/.test(sqSrc), 'the store no longer reads the station-wide pending count at all');

/* ---------- reset: the new-hero clean slate ---------- */
StationQuestStore.reset();
A.eq(global.localStorage.getItem('starnet.stationquests.v1'), null, 'reset removes the self-persisted key');
A.eq(StationQuestStore.quests().length, 0, 'a reset store degrades to no quests until the next init');
StationQuestStore.init();
A.eq(StationQuestStore.isDismissed('sq:nova:studio'), false, 'after reset+init, no prior Commander history remains');

/* ---------- source-level locks: the browser wiring (not node-loadable) ---------- */
const qsSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/queststore.js'), 'utf8');
A.ok(/StationQuestStore/.test(qsSrc) && /stationGaps/.test(qsSrc), 'queststore.view joins the station-gap quests into the one projection (they ride the shared QuestState fold → G1a celebration)');
const stSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
A.ok(/StationQuestStore\s*!==\s*'undefined'/.test(stSrc) && /StationQuestStore/.test(stSrc), 'stationui guards on the store being present');
A.ok(stSrc.indexOf('StationQuestStore') < stSrc.indexOf('QuestStateStore.sync()'), 'the station tick resolves gaps BEFORE the durable fold — a fresh completion celebrates the same beat');
A.ok(/station-gap/.test(stSrc), 'the quest log dismiss ✕ routes station-gap quests to their own permanent denylist');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
A.ok(/StationQuestStore\.init\(\)/.test(appSrc), 'app.js initializes the generator on enterGame');
A.ok(/StationQuestStore\.reset\(\)/.test(appSrc), 'app.js resets it on new-hero commission');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
A.ok(/app\/stationquests\.js/.test(html) && /app\/stationqueststore\.js/.test(html), 'index.html loads the engine and the store');

/* ---------- FIX 3 source-locks: a prop placement drives the resolve→fold IMMEDIATELY (not just the 1s tick) ---------- */
A.ok(/function pokeQuests\s*\(/.test(stSrc), 'stationui exposes a pokeQuests() that runs the resolve→fold sequence');
const pokeBody = stSrc.slice(stSrc.indexOf('function pokeQuests'), stSrc.indexOf('function tick'));
A.ok(pokeBody.indexOf('StationQuestStore.sync') >= 0 && pokeBody.indexOf('StationQuestStore.sync') < pokeBody.indexOf('QuestStateStore.sync'), 'pokeQuests resolves station gaps BEFORE folding — a just-closed gap celebrates on its own edge');
A.ok(/pokeQuests\b/.test(stSrc.slice(stSrc.lastIndexOf('return {'))), 'pokeQuests is on the StationUI public surface');
const buildSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');
A.ok(/StationUI\.pokeQuests/.test(buildSrc), 'the placement path (build.js) pokes the quest generators the instant a prop lands');
A.ok((buildSrc.match(/StationUI\.pokeQuests/g) || []).length >= 2, 'both hand-placement (commitPropStamp) and requisition drive the immediate poke');

A.report('stationqueststore.test');
