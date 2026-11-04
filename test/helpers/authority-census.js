'use strict';
/* test/helpers/authority-census.js — the surface x origin x role x tool authority matrix (authority-census lane).

   Three things, so the snapshot, the projection and runOnce are measured by ONE instrument:
   - catalogRegistry(root): a registry holding every host tool runOnce registers, built from the REAL factories in
     <root>/sidecar with inert dependencies (nothing here spawns, fetches or reads a store). FACTORIES names them, and
     test/authority-census.test.js locks that list to the factories runOnceCore actually calls.
   - SCENARIOS: the origins that start runs (each with the call site whose flags it copies), crossed with ASK / FULL
     POWER and a few host-fact variants.
   - runOnceMatrix(root, scenario): executes <root>'s OWN runOnceCore assembly source — sliced out of sidecar/index.js
     between fixed anchors and run in a vm with the scenario's host facts — and returns what it granted, advertised,
     deferred and withheld. Run against the base tree (748b0462595) it produced the history capture,
     test/fixtures/authority-matrix.748b0462595.json. Run against the v0.14.2 merge-back it produced the snapshot,
     test/fixtures/authority-matrix.json, and against this tree it measures the runOnce that now calls
     capability/project-tools.js. In the history only the lists and the room are base-executed: cellsFromRunOnce explains
     them per tool with THIS lane's rowsOf (the base has no row classifier), so its rows are lane-derived over
     base-executed inputs (authority-census.test.js says what pins them, and how the history holds the snapshot).
   projectMatrix(root, scenario) asks capability/project-tools.js directly. All three must agree cell for cell.
   readoutPlaced(root, scenario, sctx) runs <root>'s runSlashForChannel (a channel's /tools) over the same host facts, so
   test/channel-tools-readout.test.js can hold the readout to the room runOnce resolves.

   This file never edits a source tree. It cuts index.js text — this tree's through test/helpers/source.js, another tree's
   handed in by the caller (opts.indexText) — and the cut is the lock: an anchor that moves fails loudly, it never matches
   something else. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readSidecarIndex } = require('./source');

const AGENT = 'census';
const BRIEF_TOOLS = ['brief.ask', 'brief.update', 'brief.proceed'];
const GROUP_DEFS = ['group.handoff', 'group.publish', 'group.read'];

function req(root, rel) { return require(path.join(root, rel)); }
const noop = () => {};
const clock = { now: () => 0 };

/* Every factory runOnceCore registers into its per-run registry, in its order. The census test reads runOnceCore and
   requires this list to equal the `make…(…).register(registry)` calls it finds there. */
const FACTORIES = [
  ['makeWebTools', r => req(r, 'sidecar/tools/builtin/web.js').makeWebTools({ surface: 'interactive', redact: s => s, resolveServiceKey: () => ({ ok: false }) })],
  ['makeConnectorTools', r => req(r, 'sidecar/tools/builtin/connectors.js').makeConnectorTools({ connectors: { list: () => [] }, serviceKeys: () => [], connectorCatalog: { get: () => null, list: () => [] }, keysCatalog: { list: () => [] } })],
  ['makeKeyTools', r => req(r, 'sidecar/tools/builtin/keys.js').makeKeyTools({ ownerTexts: () => null, save: noop, tainted: () => false })],
  ['makeStationInspectTool', r => req(r, 'sidecar/tools/builtin/station-inspect.js').makeStationInspectTool({ inspect: () => ({}) })],
  ['makeManualReadTool', r => req(r, 'sidecar/tools/builtin/manual-read.js').makeManualReadTool()],
  ['makeStationShowTool', r => req(r, 'sidecar/tools/builtin/station-show.js').makeStationShowTool({ station: {} })],
  ['makeAppTools', r => req(r, 'sidecar/tools/builtin/apps.js').makeAppTools({ apps: {}, now: clock.now, compile: () => '' })],
  ['makeBrowserTools', r => req(r, 'sidecar/tools/builtin/browser.js').makeBrowserTools({ session: {} })],
  ['makeDesktopTools', r => req(r, 'sidecar/tools/builtin/desktop.js').makeDesktopTools({ allowRemoteDesktop: false })],
  ['makeFsTools', r => req(r, 'sidecar/tools/builtin/fs.js').makeFsTools({ fsp: fs.promises, pathMod: path, root: 'census-root' })],
  ['makeNotebookTools', r => req(r, 'sidecar/tools/builtin/notebook.js').makeNotebookTools({ store: {} })],
  ['makeWidgetTools', r => req(r, 'sidecar/tools/builtin/widgets.js').makeWidgetTools({ store: {}, clock })],
  ['makeRecallTool', r => req(r, 'sidecar/tools/builtin/recall.js').makeRecallTool({ transcriptStore: {} })],
  ['makeSkillTools', r => req(r, 'sidecar/tools/builtin/skills.js').makeSkillTools({ store: {} })],
  ['makeTodoTool', r => req(r, 'sidecar/tools/builtin/todo.js').makeTodoTool({ store: {} })],
  ['makeDeliverableTool', r => req(r, 'sidecar/tools/builtin/deliverable.js').makeDeliverableTool({ notes: [] })],
  ['makeToolSearchTool', (r, registry) => req(r, 'sidecar/tools/builtin/toolsearch.js').makeToolSearchTool({ registry })],
  ['makeCodeTools', r => req(r, 'sidecar/tools/builtin/code.js').makeCodeTools({})],
  ['makeQuestTools', r => req(r, 'sidecar/tools/builtin/quests.js').makeQuestTools({ store: {}, clock })],
  ['makeImageTools', r => req(r, 'sidecar/tools/builtin/image.js').makeImageTools({ fsp: fs.promises, pathMod: path, root: 'census-root' })],
  ['makeVoiceTools', r => req(r, 'sidecar/tools/builtin/voice.js').makeVoiceTools({ synth: noop, fsp: fs.promises, pathMod: path, root: 'census-root' })],
  ['makeResolveTools', r => req(r, 'sidecar/tools/builtin/resolve.js').makeResolveTools({ fsp: fs.promises, pathMod: path, root: 'census-root', spawn: noop, config: {} })],
  ['makeSpotifyTools', r => req(r, 'sidecar/tools/builtin/spotify.js').makeSpotifyTools({ store: {} })],
  ['makeShellTool', r => req(r, 'sidecar/tools/builtin/shell.js').makeShellTool({ spawn: () => { throw new Error('census: never spawns'); }, fs, pathMod: path, root: 'census-root', bg: {} })],
  ['makeTerminalTools', r => req(r, 'sidecar/tools/builtin/terminal.js').makeTerminalTools({ manager: {}, environment: {}, fs, pathMod: path, root: 'census-root', envFor: () => ({}) })],
  ['makeVerifyTool', r => req(r, 'sidecar/tools/builtin/verify.js').makeVerifyTool({ spawn: noop, fs, pathMod: path, root: 'census-root' })],
  ['makeComputerTools', r => req(r, 'sidecar/tools/builtin/computer.js').makeComputerTools({ allowPhysicalInput: false })],
  ['makeOrchestrationTools', r => req(r, 'sidecar/tools/builtin/orchestration.js').makeOrchestrationTools({ runOnce: noop, roster: () => ({}) })],
  ['makeStationTools', r => req(r, 'sidecar/tools/builtin/station.js').makeStationTools({ station: {}, now: clock.now })],
  ['makeStationControlTools', r => req(r, 'sidecar/tools/builtin/station-control.js').makeStationControlTools({ station: {}, route: noop, surface: 'interactive' })],
  ['makeRoutineTools', r => req(r, 'sidecar/tools/builtin/routines.js').makeRoutineTools({ roster: () => ({}) })],
  ['makeLoopTools', r => req(r, 'sidecar/tools/builtin/loops.js').makeLoopTools({})],
  ['makeCommsTools', r => req(r, 'sidecar/tools/builtin/comms.js').makeCommsTools({ listTargets: () => [], sendTo: noop })]
];

// the run's registry: every host factory, plus the Task Brief controls (registered by runOnce while a brief is active)
function catalogRegistry(root) {
  // the production catalogue when the tree has one (tools/catalog.js, this lane); the base tree had none, and the history
  // was captured with the list above — the census test locks both lists to the factories runOnceCore calls
  if (fs.existsSync(path.join(root, 'sidecar', 'tools', 'catalog.js'))) return req(root, 'sidecar/tools/catalog.js').buildCatalog();
  const { makeRegistry } = req(root, 'sidecar/tools/registry.js');
  const registry = makeRegistry();
  for (const [, make] of FACTORIES) make(root, registry).register(registry);
  req(root, 'sidecar/taskbrief-tools.js').registerTaskBriefTools(registry, { get: () => null, update: noop }, { brief: {} }, { now: clock.now });
  return registry;
}

// one connector ('gh': a read tool and a write tool) and one approved plugin terminal ('p1'), from the REAL translators
function connectorDefs(root, ids) {
  const translate = req(root, 'sidecar/mcp/translate.js');
  const out = [];
  if (ids.indexOf('gh') >= 0) {
    for (const t of [{ name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }]) {
      out.push(translate.makeMcpToolDef({ connectorId: 'gh', label: 'GitHub', mcpTool: t, call: async () => ({ content: [] }) }));
    }
  }
  return out;
}
function groupToolDefs() {
  return GROUP_DEFS.map(name => ({ name, description: 'group turn ' + name, capability: 'compute', scope: 'read', requiresConsent: false, impact: 'none',
    schema: { type: 'object', properties: {} }, run: async () => '' }));
}

const OFFICE_FLOOR = [
  { instanceId: 'wb1', objectType: 'workbench' }, { instanceId: 'dish1x', objectType: 'dish' }, { instanceId: 'cab1x', objectType: 'cabinet' },
  { instanceId: 'nb1x', objectType: 'notebook' }, { instanceId: 'studio1x', objectType: 'studio' }, { instanceId: 'juke1x', objectType: 'jukebox' }
];
// acp/serve.js + bin/lib/cli-core.js HEADLESS_PLACED: the coding office an editor / terminal run places
const CODING_OFFICE = ['computer', 'cabinet', 'workbench', 'dish', 'notebook'].map(t => ({ objectType: t }));
const WORKER_KIT = [{ instanceId: 'wb_worker', objectType: 'workbench' }];   // orchestration.js WORKER_KIT
const BUILDER_KIT = [{ instanceId: 'builder_lent', objectType: 'builder' }];
const bay = (objects) => ({ agents: { [AGENT]: { id: AGENT, room: 'bay' } }, rooms: { bay: { id: 'bay', objects: objects.map((o, i) => Object.assign({ instanceId: 'bay_' + i }, o)) } } });

/* ORIGINS — each copies the runOnce flags of the call site named in `at` (only the fields the tool assembly reads).
   brief: the run carries a Task Brief (isTask + a taskKey, not /v1), so its internal brief controls ride the list. */
const ORIGINS = [
  { id: 'desktop.bare', at: 'index.js handleRun /api/run', o: { surface: 'interactive', lead: true, isTask: true, prompt: true, extraObjects: [] }, brief: true },
  { id: 'desktop.floor', at: 'index.js handleRun /api/run (placed props)', o: { surface: 'interactive', lead: true, isTask: true, prompt: true, extraObjects: OFFICE_FLOOR }, brief: true },
  { id: 'desktop.chat', at: 'index.js handleRun /api/run (not a task)', o: { surface: 'interactive', lead: true, isTask: false, prompt: true, extraObjects: OFFICE_FLOOR } },
  { id: 'editor', at: 'acp/serve.js + bin/lib/cli-core.js -> /api/run (coding office)', o: { surface: 'interactive', lead: true, isTask: true, prompt: true, extraObjects: CODING_OFFICE }, brief: true },
  { id: 'widget.update', at: 'index.js handleRun, streamId widget-<id>', o: { surface: 'interactive', lead: true, isTask: true, prompt: true, extraObjects: [] }, brief: true, widgetScope: 'w1' },
  { id: 'routine.schedule', at: 'cron-driver.js fire', o: { surface: 'autonomous', trigger: 'schedule', cronJobId: 'job1', isTask: true, unattendedGrants: [], enabledToolsets: null } },
  { id: 'routine.schedule.granted', at: 'cron-driver.js fire (workbench+connectors+studio ticked)', o: { surface: 'autonomous', trigger: 'schedule', cronJobId: 'job1', isTask: true, unattendedGrants: ['workbench', 'connectors', 'studio'], enabledToolsets: null } },
  { id: 'routine.schedule.toolsets', at: 'cron-driver.js fire (enabledToolsets [web])', o: { surface: 'autonomous', trigger: 'schedule', cronJobId: 'job1', isTask: true, unattendedGrants: ['workbench'], enabledToolsets: ['web'] } },
  { id: 'routine.manual', at: 'index.js Run Now (trigger manual)', o: { surface: 'autonomous', trigger: 'manual', cronJobId: 'job1', isTask: true, unattendedGrants: ['workbench'], enabledToolsets: null } },
  { id: 'routine.bay', at: 'cron-driver.js fire on a bay agent (resolveStation)', o: { surface: 'autonomous', trigger: 'schedule', cronJobId: 'job1', isTask: true, unattendedGrants: [], station: bay([{ objectType: 'workbench' }, { objectType: 'dish' }]) } },
  { id: 'routine.widget', at: 'cron-driver.js fire, job meta names a widget', o: { surface: 'autonomous', trigger: 'schedule', cronJobId: 'job1', isTask: true, unattendedGrants: [] }, widgetScope: 'w1' },
  { id: 'channel.owner', at: 'channels/hub.js entry run (owner DM, approvals off)', o: { surface: 'autonomous', floorless: true, ownerTrusted: true, channelSender: true, channelSenderOwner: true, trigger: 'event', isTask: true }, brief: true },
  { id: 'channel.owner.approvals', at: 'channels/hub.js entry run (owner DM, /approvals on)', o: { surface: 'interactive', floorless: true, ownerTrusted: true, channelSender: true, channelSenderOwner: true, trigger: 'event', isTask: true, prompt: true }, brief: true },
  { id: 'channel.guest', at: 'channels/hub.js entry run (allowed non-owner / group member)', o: { surface: 'autonomous', floorless: true, ownerTrusted: false, channelSender: true, channelSenderOwner: false, trigger: 'event', isTask: true }, brief: true },
  { id: 'channel.bay', at: 'channels/hub.js entry run on a bay (owner DM)', o: { surface: 'autonomous', floorless: true, ownerTrusted: true, channelSender: true, channelSenderOwner: true, trigger: 'event', isTask: true, station: bay([{ objectType: 'dish' }]) }, brief: true },
  { id: 'line.entry.owner', at: 'channels/hub.js entry run with lineId (owner DM starts a line)', o: { surface: 'autonomous', floorless: true, ownerTrusted: true, channelSender: true, channelSenderOwner: true, trigger: 'event', isTask: true, lineId: 'L1' }, brief: true },
  { id: 'line.hop', at: 'channels/hub.js hop run (ownerTrusted carried, bay room)', o: { surface: 'autonomous', ownerTrusted: true, channelSender: true, channelSenderOwner: true, trigger: 'event', isTask: true, lineId: 'L1', initialTaint: 'upstream agent output', station: bay([{ objectType: 'workbench' }, { objectType: 'dish' }, { objectType: 'cabinet' }]) }, brief: true },
  { id: 'line.hop.guest', at: 'channels/hub.js hop run of a non-owner entry', o: { surface: 'autonomous', ownerTrusted: false, channelSender: true, channelSenderOwner: false, trigger: 'event', isTask: true, lineId: 'L1', initialTaint: 'upstream agent output', station: bay([{ objectType: 'workbench' }, { objectType: 'dish' }]) }, brief: true },
  { id: 'worker', at: 'tools/builtin/orchestration.js team.dispatch worker run', o: { surface: 'autonomous', trigger: 'directive', isTask: true, delegatedBy: 'leadagent', extraObjects: WORKER_KIT } },
  { id: 'worker.builder', at: 'orchestration.js team.dispatch builder:true', o: { surface: 'autonomous', trigger: 'directive', isTask: true, delegatedBy: 'leadagent', extraObjects: WORKER_KIT.concat(BUILDER_KIT) } },
  { id: 'group.lead', at: 'index.js group turn (lead)', o: { surface: 'interactive', lead: true, isTask: true, prompt: true, groupTools: true, extraObjects: OFFICE_FLOOR } },
  { id: 'group.member', at: 'index.js group turn (member)', o: { surface: 'interactive', lead: false, isTask: true, prompt: true, groupTools: true, extraObjects: OFFICE_FLOOR } },
  { id: 'group.lead.bay', at: 'index.js group turn (lead in a bay room)', o: { surface: 'interactive', lead: true, isTask: true, prompt: true, groupTools: true, station: bay([{ objectType: 'dish' }]) } },
  { id: 'remote.phone', at: 'remote/host.js phone task', o: { surface: 'interactive', prompt: true, ownerTrusted: true, floorless: true, trigger: 'event', isTask: true }, brief: true },
  { id: 'remote.phone.desktop', at: 'remote/host.js phone task, native desktop control available', o: { surface: 'interactive', prompt: true, ownerTrusted: true, floorless: true, trigger: 'event', isTask: true }, brief: true, facts: { computerAvailable: true } },
  { id: 'api.v1', at: 'openai-compat.js /v1 request', o: { surface: 'autonomous', trigger: 'event', isTask: true } },
  { id: 'loop', at: 'loopjob-driver.js loop beat', o: { surface: 'autonomous', trigger: 'loop', isTask: true } },
  { id: 'routine.line.hop', at: 'index.js scheduled line hop (cron chain, bay room)', o: { surface: 'autonomous', trigger: 'schedule', isTask: true, unattendedGrants: [], initialTaint: 'upstream agent output', lineId: 'L1', station: bay([{ objectType: 'workbench' }, { objectType: 'cabinet' }]) } },
  { id: 'trigger.entry', at: 'channels/hub.js line-trigger fire (untrusted entry)', o: { surface: 'autonomous', floorless: true, trigger: 'event', isTask: true, untrustedEntry: true, initialTaint: 'trigger payload' } }
];
const POSTURES = ['ask', 'full'];
// host-fact variants, each on the desktop floor in ASK (and the one that only means something under a posture)
const VARIANTS = [
  { id: 'facts.unavailable', base: 'desktop.floor', posture: 'ask', facts: { pty: false, spotify: false, mediaRoute: false, voiceRoute: false } },
  { id: 'facts.crew', base: 'desktop.floor', posture: 'ask', facts: { crewCount: 2 } },
  { id: 'facts.direct-domain', base: 'desktop.floor', posture: 'ask', facts: { directDomain: true } },
  { id: 'facts.key-paste', base: 'desktop.floor', posture: 'ask', facts: { keyPaste: true } },
  { id: 'facts.deferral-off', base: 'desktop.floor', posture: 'ask', facts: { deferralOff: true } },
  { id: 'facts.toolset-off', base: 'desktop.floor', posture: 'ask', facts: { disabledCaps: { web: true, memory: true } } },
  { id: 'facts.toolset-off.full', base: 'desktop.floor', posture: 'full', facts: { disabledCaps: { web: true, memory: true } } },
  { id: 'facts.plugin', base: 'desktop.floor', posture: 'ask', facts: { plugin: true } },
  { id: 'facts.no-connectors', base: 'desktop.floor', posture: 'ask', facts: { connectorIds: [] } },
  { id: 'facts.profile.trusted', base: 'routine.schedule', posture: 'ask', facts: { profile: 'trusted-project' } },
  { id: 'facts.profile.trusted.desktop', base: 'desktop.bare', posture: 'ask', facts: { profile: 'trusted-project' } },
  { id: 'facts.bypass', base: 'routine.schedule', posture: 'ask', facts: { bypass: true } },
  { id: 'facts.bypass.guest', base: 'channel.guest', posture: 'ask', facts: { bypass: true } }
];

function scenarios() {
  const out = [];
  for (const origin of ORIGINS) for (const posture of POSTURES) out.push({ id: origin.id + '@' + posture, origin, posture, facts: origin.facts || {} });
  for (const v of VARIANTS) {
    const origin = ORIGINS.find(x => x.id === v.base);
    out.push({ id: v.id + '@' + v.posture, origin, posture: v.posture, facts: Object.assign({}, origin.facts || {}, v.facts) });
  }
  return out;
}

// the host facts one scenario stands on (shared by the runOnce cut and the direct projection)
function hostFacts(scenario) {
  const f = scenario.facts || {};
  return {
    connectorIds: Array.isArray(f.connectorIds) ? f.connectorIds : ['gh'],
    approvalMode: scenario.posture === 'full' ? 'full' : 'ask',
    profile: f.profile,
    bypass: f.bypass === true,
    computerAvailable: f.computerAvailable === true,
    disabledCaps: f.disabledCaps || {},
    pty: f.pty !== false, spotify: f.spotify !== false, mediaRoute: f.mediaRoute !== false, voiceRoute: f.voiceRoute !== false,
    crewCount: Number(f.crewCount) || 0,
    directDomain: f.directDomain === true,
    keyPaste: f.keyPaste === true,
    deferralOff: f.deferralOff === true,
    plugin: f.plugin === true,
    widgetScope: scenario.origin.widgetScope || '',
    brief: scenario.origin.brief === true
  };
}

// a key-shaped string in the Commander's own turn (built at run time: no key-like literal sits in the source)
function keyTexts(h) { return h.keyPaste ? ['my key ' + ['sk', 'proj', 'Ab3dE5fG7h'.repeat(4)].join('-')] : null; }

function runOnceOptions(scenario, h) {
  const o = Object.assign({ agentId: AGENT }, scenario.origin.o);
  if (o.prompt === true) o.prompt = async () => 'deny';
  if (o.groupTools === true) o.groupTools = groupToolDefs();
  if (h.plugin) o.extraObjects = (o.extraObjects || []).concat([{ instanceId: 'plug1', objectType: 'plugin', pluginId: 'p1' }]);
  return o;
}

/* ---- the runOnce cut ---------------------------------------------------------------------------------------- */
// Anchors in sidecar/index.js. Each cut is [first line, last line] inclusive, both matched on a trimmed line start.
const CUTS = [
  ['const ownerTrusted = !!o.ownerTrusted;', 'const unattendedGrants = surface === \'interactive\''],
  ['const remoteDesktopAuthorized = ownerTrusted && computerControl.available();', 'const remoteDesktopAuthorized = ownerTrusted && computerControl.available();'],
  ['const hostPowerWithheld = hostPowerWithheldFor(o);', 'const trigger = o.trigger || \'directive\';'],
  ['// ---- capabilities: each placed object IS a capability grant', '// QUEST V2 §A'],
  ['const deferredNames = ', 'const coreNames = ']
];
function cutRunOnce(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const startCore = lines.findIndex(l => /^async function runOnceCore\(o\) \{/.test(l));
  if (startCore < 0) throw new Error('census: runOnceCore not found');
  // a top-level helper the assembly calls (after the move: the room's connector/plugin registration) rides along whole
  const parts = [];
  for (const name of ['registerRoomTools']) {
    const h = lines.findIndex(l => l.indexOf('async function ' + name + '(') === 0);
    if (h < 0) continue;
    parts.push(lines.slice(h, lines.findIndex((l, k) => k > h && l === '}') + 1).join('\n'));
  }
  let from = startCore;
  for (const [a, b] of CUTS) {
    const i = lines.findIndex((l, k) => k >= from && l.trim().indexOf(a) === 0);
    if (i < 0) throw new Error('census: anchor not found: ' + a);
    const j = lines.findIndex((l, k) => k >= i && l.trim().indexOf(b) === 0);
    if (j < 0) throw new Error('census: end anchor not found: ' + b);
    // the QUEST anchor closes the cut BEFORE it; every other end anchor is part of the cut
    parts.push(lines.slice(i, b === '// QUEST V2 §A' ? j : j + 1).join('\n'));
    from = j;
  }
  return parts.join('\n');
}

// which augmentation step a stationWithObject/stationWithConnectors call in the cut is (the base has no bookkeeping):
// read off the calling line of the cut itself
function stepOfLine(text, o) {
  const t = String(text || '').trim();
  if (/unattendedGrants\.indexOf\('(?:workbench|connectors)'\)/.test(t)) return o.ownerTrusted ? 'owner-dm' : 'routine-grant';
  if (/^if \(ownerTrusted\) station = stationWithObject\(station, agentId, 'orchestrator'\)/.test(t)) return 'owner-dm';
  if (/o\.lead && Array\.isArray\(o\.groupTools\)/.test(t)) return 'group-lead';
  if (/objectType !== 'builder'/.test(t) || t === 'station = stationWithConnectors(station, agentId, connectors.ids());') return 'full-power';
  if (/executionProfile\./.test(t)) return 'execution-profile';
  return 'unknown:' + t.slice(0, 60);
}

// this tree's index.js through the source helper; another tree's (the base capture) is handed in by its caller as text
function indexSourceOf(root, opts) {
  if (opts && typeof opts.indexText === 'string') return opts.indexText;
  if (path.resolve(root) === path.resolve(__dirname, '..', '..')) return readSidecarIndex();
  throw new Error('census: pass opts.indexText to cut a tree other than this one');
}

async function runOnceMatrix(root, scenario, opts) {
  opts = opts || {};
  const cut = cutRunOnce(indexSourceOf(root, opts));
  const h = hostFacts(scenario);
  const o = runOnceOptions(scenario, h);
  const registry = catalogRegistry(root);
  const office = req(root, 'sidecar/capability/office.js');
  const inputpolicy = req(root, 'sidecar/inputpolicy.js');
  const cutLines = cut.split('\n');
  const sources = {};
  // the base names no step for the objects the office or bay started with: label them as the projection does, first
  const surface0 = o.surface === 'interactive' ? 'interactive' : 'autonomous';
  if (!o.station) {
    const officeSurface = o.floorless ? 'autonomous' : surface0;
    const lead = !!o.lead || !!o.ownerTrusted;
    const baseCount = office.composeOffice({ surface: officeSurface, lead, connectorIds: h.connectorIds }).length;
    office.composeOffice({ surface: officeSurface, lead, connectorIds: h.connectorIds, extraObjects: o.extraObjects }).forEach((ob, i) => {
      sources[ob.instanceId] = i >= baseCount ? 'placed' : ob.objectType === 'connector' ? 'connector-account' : ob.objectType === 'orchestrator' ? 'lead' : 'office';
    });
  } else {
    for (const ob of o.station.rooms.bay.objects) sources[ob.instanceId] = 'bay';
  }
  const record = (before, after, step) => {
    if (after === before) return;
    const room = after && after.agents && after.agents[AGENT] && after.rooms[after.agents[AGENT].room];
    for (const ob of ((room && room.objects) || [])) if (ob && ob.instanceId && !sources[ob.instanceId]) sources[ob.instanceId] = step;
  };
  // script line 1 is the async wrapper, so cut line k is script line k + 1
  const callerStep = () => {
    const m = /census-cut\.js:(\d+)/.exec(String(new Error().stack).split('\n').slice(2).join('\n'));
    return m ? stepOfLine(cutLines[Number(m[1]) - 2], o) : 'unknown';
  };
  const failNotes = [];
  const pluginToolsMod = req(root, 'sidecar/plugin-tools.js');
  let projectToolsMod = null;
  try { projectToolsMod = req(root, 'sidecar/capability/project-tools.js'); } catch (_) { projectToolsMod = null; }
  const ctx = {
    o, agentId: AGENT, surface: o.surface === 'interactive' ? 'interactive' : 'autonomous', isTask: !!o.isTask,
    console: { log: noop, warn: noop, error: noop }, JSON, Object, Array, Set, Map, String, Number, Boolean, Promise, RegExp, Error,
    process: { env: h.deferralOff ? { SKYNET_TOOL_SEARCH: '0' } : {} },
    // host state the cut reads
    agentRoster: { get: (id) => id === AGENT ? { agentId: AGENT, approvalMode: h.approvalMode, executionProfile: h.profile } : null, has: () => true },
    FULL_ACCESS: false, masterBypassOn: () => h.bypass,
    computerControl: { available: () => h.computerAvailable, selection: () => 'win32' },
    executionProfiles: req(root, 'sidecar/execution-profiles.js'),
    executionEnvironment: { forAgent: () => null, backendIdFor: () => 'local' },
    hostPowerWithheldFor: req(root, 'sidecar/run-origin.js').hostPowerWithheldFor,
    entryUntrusted: req(root, 'sidecar/run-origin.js').entryUntrusted,
    recoverySourceEntryUntrusted: () => false,
    makeRunAuthority: inputpolicy.makeRunAuthority, normalizeUnattendedGrants: inputpolicy.normalizeUnattendedGrants,
    enforceSyntheticOnly: inputpolicy.enforceSyntheticOnly, enforceRunAuthority: inputpolicy.enforceRunAuthority,
    enforceEnabledToolsets: inputpolicy.enforceEnabledToolsets, impactOfTool: inputpolicy.impactOfTool,
    composeOffice: (x) => { const r = office.composeOffice(x); return r; },
    stationWithObject: (s, a, t) => { const r = office.stationWithObject(s, a, t); record(s, r, callerStep()); return r; },
    stationWithConnectors: (s, a, ids) => { const r = office.stationWithConnectors(s, a, ids); record(s, r, callerStep()); return r; },
    CAP_REGISTRY: req(root, 'sidecar/capability/registry.js').CAP_REGISTRY,
    resolveTools: req(root, 'sidecar/capability/resolve.js').resolveTools,
    disabledCapsSet: () => h.disabledCaps,
    connectors: { ids: () => h.connectorIds.slice(), toolDefsForObjects: (objects) => {
      const ids = []; for (const ob of (objects || [])) if (ob && ob.objectType === 'connector' && h.connectorIds.indexOf(ob.connectorId) >= 0 && ids.indexOf(ob.connectorId) < 0) ids.push(ob.connectorId);
      return connectorDefs(root, ids);
    } },
    googleRelayGuard: () => ({ projectable: () => true }), providerId: 'openrouter', model: 'census/model',
    pluginsLoaded: { loaded: h.plugin ? [{ id: 'p1', name: 'Census Plugin', process: {} }] : [] },
    pluginLoader: { approvedRecord: async () => ({ ok: true }) },
    makePluginToolDefs: pluginToolsMod.makePluginToolDefs,
    pluginRuntime: { tools: () => [{ name: 'ping', description: 'Ping', parameters: { type: 'object', properties: {} }, readOnly: true }], callTool: async () => '' },
    registry,
    isRoutineTrigger: req(root, 'sidecar/routine-identity.js').isRoutineTrigger,
    cronJobs: [], widgetTools: { updateRunOf: () => h.widgetScope || null },
    withheldCommandTools: req(root, 'sidecar/capability/withheld.js').withheldCommandTools,
    failNote: (tag, e) => failNotes.push(tag + ': ' + ((e && e.message) || e)),
    ImageTask: { agentModelBlocker: () => null, admissionBlocker: () => null }, imageTask: false,
    emit: noop, runStartExtra: {}, studioRoute: { ok: h.mediaRoute }, skillStore: {}, skillGate: {},
    internalBriefTools: h.brief ? BRIEF_TOOLS.slice() : [],
    KeyTools: req(root, 'sidecar/tools/builtin/keys.js'),
    keyOwnerTexts: () => keyTexts(h),
    directDomainTask: h.directDomain ? { host: 'example.com' } : null,   // what the history's cut (748b0462595) reads
    // facts.direct-domain is a LEAD-SET scope now (domain-task-advisory): this tree's cut reads hostScope, the parsed onlyHost,
    // where it read the prose classification; prose is advice and moves no cell
    hostScope: h.directDomain ? { kind: 'direct-domain', host: 'example.com', source: 'lead' } : null,
    CrewDiet: req(root, 'sidecar/crew-diet.js'), ENV: () => undefined, crewCountFor: () => h.crewCount,
    planConnectorDeferral: req(root, 'sidecar/tools/builtin/toolsearch.js').planConnectorDeferral,
    CONNECTOR_DEFER: { bytes: 8192, tools: 12 },
    spotifyStore: { load: async () => h.spotify ? { refreshToken: 'census' } : {} },
    media: { voiceRouteAvailable: () => h.voiceRoute },
    unavailableTools: req(root, 'sidecar/capability/effective-toolsets.js').unavailableTools,
    terminalSessions: { available: () => h.pty },
    lastToolFootprintLog: '',
    ProjectTools: projectToolsMod
  };
  if (opts.extend) Object.assign(ctx, opts.extend);
  vm.createContext(ctx);
  const body = '(async () => {\n' + cut + '\nreturn { station, resolved, preAuthorityTools, coreNames, deferredNames: Array.from(deferredNames), userControlAuthority, widgetScope, keySaveOffered, crewless, connectorDeferral, realDesktopAuthority, '
    + 'projection: typeof projection === "undefined" ? null : projection };\n})()';
  const out = await new vm.Script(body, { filename: 'census-cut.js' }).runInContext(ctx);
  return { out, sources, registry, h, o, failNotes };
}

/* ---- a channel's /tools readout --------------------------------------------------------------------------- */
// one top-level function of an index.js text: its declaration line through the first later line that is `}` (the house layout)
function topLevelFunctionIn(text, name) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex(l => l.indexOf('function ' + name + '(') === 0 || l.indexOf('async function ' + name + '(') === 0);
  if (at < 0) throw new Error('census: ' + name + ' not found');
  return lines.slice(at, lines.findIndex((l, k) => k > at && l === '}') + 1).join('\n');
}
// the object types the room of a run holds (what /tools must list for the chat that run came from)
function roomTypesOf(station) {
  const room = station && station.agents && station.agents[AGENT] && station.rooms && station.rooms[station.agents[AGENT].room];
  return Array.from(new Set(((room && room.objects) || []).map(ob => ob && ob.objectType).filter(Boolean))).sort();
}
/* readoutPlaced(root, scenario, sctx, opts): <root>'s runSlashForChannel (and the placedTypesFrom it reads), cut out of
   index.js and run in a vm over the scenario's host facts, answering '/tools' for the slash ctx a hub hands it (sctx).
   Returns the object types it handed the /tools action. opts.indexText cuts another tree; opts.mutate(fnText) edits the
   cut (the instrument's own mutation). */
async function readoutPlaced(root, scenario, sctx, opts) {
  opts = opts || {};
  const text = indexSourceOf(root, opts);
  let fn = topLevelFunctionIn(text, 'runSlashForChannel');
  if (typeof opts.mutate === 'function') fn = opts.mutate(fn);
  const h = hostFacts(scenario);
  const o = runOnceOptions(scenario, h);
  const seen = { placed: null };
  const failNotes = [];
  let projectToolsMod = null;
  if (fs.existsSync(path.join(root, 'sidecar', 'capability', 'project-tools.js'))) projectToolsMod = req(root, 'sidecar/capability/project-tools.js');
  const ctx = {
    String, Array, Set, Object, JSON, RegExp, Error, Promise,
    sctx: Object.assign({ agentId: AGENT }, sctx || {}),
    agentRoster: { get: (id) => id === AGENT ? { agentId: AGENT, approvalMode: h.approvalMode, executionProfile: h.profile } : null },
    FULL_ACCESS: false, masterBypassOn: () => h.bypass,
    executionProfiles: req(root, 'sidecar/execution-profiles.js'),
    executionEnvironment: { backendIdFor: () => 'local' },
    hostPowerWithheldFor: req(root, 'sidecar/run-origin.js').hostPowerWithheldFor,
    ProjectTools: projectToolsMod,
    composeOffice: req(root, 'sidecar/capability/office.js').composeOffice,   // what the base readout composed itself
    router: { stationFor: () => o.station || null },
    observe: { stationFor: () => o.station || null },   // the host asked the router through its observe seam (routing/saved-seams.js) ...
    admit: { stationFor: () => o.station || null },     // ... and asks for a ROOM through admit, which throws on a hold (a room is never an observe)
    connectors: { ids: () => h.connectorIds.slice() },
    failNote: (tag, e) => failNotes.push(tag + ': ' + ((e && e.message) || e)),
    slash: { dispatch: () => ({ ok: true, directive: { type: 'server', action: 'tools', args: {} } }) },
    slashOptions: (placed) => ({ placed }),
    slashActions: { run: async (action, args, c) => { seen.placed = c.placed; return { ok: true, text: '' }; } },
    userExecRefusal: () => '', runUserExec: async () => ({ ok: false, text: '' })
  };
  vm.createContext(ctx);
  const body = topLevelFunctionIn(text, 'placedTypesFrom') + '\n' + fn + '\nrunSlashForChannel("/tools", sctx);';
  await new vm.Script(body, { filename: 'census-readout.js' }).runInContext(ctx);
  return { placed: Array.from(new Set(seen.placed || [])).sort(), failNotes };
}

/* ---- normalizing a projection into matrix cells ----------------------------------------------------------- */
function injectedOf(h, o, out, registry) {
  const injected = {};
  if (Array.isArray(o.groupTools)) for (const d of o.groupTools) injected[d.name] = 'group-turn';
  if (out.realDesktopAuthority) for (const n of ['computer.use', 'desktop.open']) injected[n] = 'desktop-lease';
  for (const n of out.preAuthorityTools.concat(out.resolved.tools)) {
    const t = registry.get(n);
    const cap = String((t && t.capability) || '');
    if (cap.indexOf('mcp:') === 0 && !injected[n]) injected[n] = 'connector';
    if (cap.indexOf('plugin:') === 0 && !injected[n]) injected[n] = 'plugin';
  }
  if (h.widgetScope) for (const n of ['widget.get', 'widget.set']) injected[n] = injected[n] || 'widget-scope';
  if (h.brief) for (const n of BRIEF_TOOLS) injected[n] = injected[n] || 'task-brief';
  return injected;
}

/* One scenario's cells: the ordered grant (resolved.tools — the order is the wire order), the ordered advertised and
   deferred wire lists, which withheld tools carry an explanation, which deferred ones are certainly unavailable, and
   one row per tool the room offered: state, impact, consent class, grant source, limiting reason, why. */
function cellsOf(p, rows) {
  const sortedRows = {};
  for (const k of Object.keys(rows).sort()) sortedRows[k] = rows[k];
  return {
    granted: p.resolved.tools.slice(),
    advertised: p.advertised.slice(),
    deferred: p.deferredWire.slice(),
    withheldExplained: Object.keys(p.resolved.withheld || {}).sort(),
    unavailable: Object.keys(p.resolved.unavailable || {}).sort(),
    rows: sortedRows
  };
}

/* The committed fixture is the same cells, packed: every tool name once (`tools`), its impact and consent class once
   (`decl` — a declaration, so it cannot differ per scenario), and per scenario the ordered lists as base-36 indexes and
   the rows grouped by identical state|source|reason|why. decodeMatrix(encodeMatrix(m)) deep-equals m. */
function encodeMatrix(matrix, meta) {
  const names = new Set();
  for (const id of Object.keys(matrix)) for (const n of Object.keys(matrix[id].rows).concat(matrix[id].granted, matrix[id].deferred)) names.add(n);
  const tools = Array.from(names).sort();
  const at = new Map(tools.map((n, i) => [n, i.toString(36)]));
  const list = a => a.map(n => at.get(n)).join(',');
  const decl = {};
  const whys = [];
  const scenariosOut = {};
  for (const id of Object.keys(matrix).sort()) {
    const m = matrix[id];
    const groups = {};
    for (const n of Object.keys(m.rows)) {
      const r = m.rows[n];
      const d = r.impact + ' ' + r.consent;
      if (decl[n] && decl[n] !== d) throw new Error('census: ' + n + ' declares two classes: ' + decl[n] + ' / ' + d);
      decl[n] = d;
      let w = '';
      if (r.why != null) { let k = whys.indexOf(r.why); if (k < 0) { whys.push(r.why); k = whys.length - 1; } w = String(k); }
      const sig = [r.state, r.source, r.reason || '', w].join('|');
      (groups[sig] = groups[sig] || []).push(n);
    }
    const rows = {};
    for (const sig of Object.keys(groups).sort()) rows[sig] = list(groups[sig].sort());
    scenariosOut[id] = { g: list(m.granted), a: list(m.advertised), d: list(m.deferred), x: list(m.withheldExplained), u: list(m.unavailable), rows };
  }
  return Object.assign({}, meta || {}, { tools, decl, whys, scenarios: scenariosOut });
}
function decodeMatrix(fx) {
  const name = s => fx.tools[parseInt(s, 36)];
  const list = s => (s ? s.split(',').map(name) : []);
  const out = {};
  for (const id of Object.keys(fx.scenarios)) {
    const s = fx.scenarios[id];
    const rows = {};
    for (const sig of Object.keys(s.rows)) {
      const [state, source, reason, w] = sig.split('|');
      for (const n of list(s.rows[sig])) {
        const [impact, consent] = fx.decl[n].split(' ');
        const r = { state, impact, consent, source };
        if (reason) r.reason = reason;
        if (w !== '') r.why = fx.whys[Number(w)];
        rows[n] = r;
      }
    }
    const sorted = {};
    for (const k of Object.keys(rows).sort()) sorted[k] = rows[k];
    out[id] = { granted: list(s.g), advertised: list(s.a), deferred: list(s.d), withheldExplained: list(s.x), unavailable: list(s.u), rows: sorted };
  }
  return out;
}

// the matrix row-set from the runOnce cut's outputs, explained by `rowsOf` (the projection module of rowsRoot)
function cellsFromRunOnce(capture, rowsRoot) {
  const { out, sources, registry, h, o } = capture;
  const isTask = !!o.isTask;
  const advertised = isTask ? out.coreNames.slice() : [];
  const deferredWire = isTask ? out.deferredNames.slice() : [];
  const p = { station: out.station, resolved: out.resolved, preAuthorityTools: out.preAuthorityTools, advertised, deferredWire,
    keySaveOffered: out.keySaveOffered, crewless: out.crewless,
    connectorDeferral: out.connectorDeferral || { deferred: [] }, sources: (out.projection && out.projection.sources) || sources,
    injected: (out.projection && out.projection.injected) || injectedOf(h, o, out, registry) };
  const { rowsOf } = req(rowsRoot, 'sidecar/capability/project-tools.js');
  const surface = o.surface === 'interactive' ? 'interactive' : 'autonomous';
  const unrestricted = !!(out.userControlAuthority && out.userControlAuthority.unrestrictedHost && out.userControlAuthority.unrestrictedHost());
  const rows = rowsOf(p, { agentId: AGENT, registry, authority: out.userControlAuthority, surface, enabledToolsets: unrestricted ? null : o.enabledToolsets, directDomain: h.directDomain, groupTurn: Array.isArray(o.groupTools) });
  return cellsOf(p, rows);
}

// the same scenario through capability/project-tools.js directly, with the facts runOnce would hand it
async function projectMatrix(root, scenario, overrides) {
  overrides = overrides || {};
  const h = hostFacts(scenario);
  const o = runOnceOptions(scenario, h);
  const registry = overrides.registry || catalogRegistry(root);
  const PT = req(root, 'sidecar/capability/project-tools.js');
  const inputpolicy = req(root, 'sidecar/inputpolicy.js');
  const runOrigin = req(root, 'sidecar/run-origin.js');
  const profiles = req(root, 'sidecar/execution-profiles.js');
  const surface = o.surface === 'interactive' ? 'interactive' : 'autonomous';
  const ownerTrusted = !!o.ownerTrusted;
  const hostPowerWithheld = runOrigin.hostPowerWithheldFor(o);
  const agentFull = !hostPowerWithheld && h.approvalMode === 'full';
  const stationBypass = !hostPowerWithheld && h.bypass;
  const unrestrictedHost = stationBypass || agentFull;
  const remoteDesktopAuthorized = ownerTrusted && h.computerAvailable;
  const unattendedGrants = surface === 'interactive' ? [] : Array.from(inputpolicy.normalizeUnattendedGrants(o.unattendedGrants));
  const executionProfile = profiles.resolve(h.profile, { approvalMode: hostPowerWithheld ? 'ask' : h.approvalMode, backendId: 'local', physicalDesktopLease: remoteDesktopAuthorized });
  const authority = inputpolicy.makeRunAuthority({ surface, isTask: !!o.isTask, environment: null, confirm: o.prompt, unattendedGrants, ownerTrusted,
    remoteDesktopAuthorized, masterBypass: stationBypass, fullAccess: () => agentFull, connectorAuthority: o.connectorAuthority });
  const origin = { surface, floorless: !!o.floorless, ownerTrusted, trigger: o.trigger || 'directive', cronJobId: o.cronJobId, isTask: !!o.isTask,
    station: o.station, extraObjects: o.extraObjects, unattendedGrants, enabledToolsets: o.enabledToolsets, groupTools: o.groupTools };
  const role = { lead: !!o.lead, delegatedBy: o.delegatedBy || '' };
  const facts = {
    registry, authority, connectorIds: h.connectorIds.slice(), disabledCaps: h.disabledCaps, unrestrictedHost,
    realDesktopAuthority: remoteDesktopAuthorized || (unrestrictedHost && h.computerAvailable), executionProfile,
    widgetScope: h.widgetScope, internalBriefTools: h.brief ? BRIEF_TOOLS.slice() : [], deferralOff: h.deferralOff,
    keySaveOffered: !!(o.isTask && keyTexts(h) && req(root, 'sidecar/tools/builtin/keys.js').hasKeyCandidate(keyTexts(h))), directDomain: h.directDomain, leanCrew: undefined, crewCount: h.crewCount,
    connectorDefer: { bytes: 8192, tools: 12 },
    availability: { mediaRoute: h.mediaRoute, voiceRoute: h.voiceRoute, ptyRuntime: h.pty }
  };
  if (Array.isArray(o.groupTools)) for (const def of o.groupTools) registry.register(def);
  const { station } = PT.projectStation({ id: AGENT }, origin, role, facts);
  const room = station.rooms[station.agents[AGENT].room];
  const connector = connectorDefs(root, (room.objects || []).filter(ob => ob && ob.objectType === 'connector' && h.connectorIds.indexOf(ob.connectorId) >= 0).map(ob => ob.connectorId).filter((v, i, a) => a.indexOf(v) === i));
  for (const def of connector) registry.register(def, { provenance: 'connector' });
  const plugin = [];
  if (h.plugin && (room.objects || []).some(ob => ob && ob.objectType === 'plugin' && ob.pluginId === 'p1')) {
    for (const def of req(root, 'sidecar/plugin-tools.js').makePluginToolDefs({ pluginId: 'p1', pluginName: 'Census Plugin', tools: [{ name: 'ping', description: 'Ping', parameters: { type: 'object', properties: {} }, readOnly: true }], call: async () => '' })) {
      registry.register(def, { provenance: 'connector' }); plugin.push(def);
    }
  }
  facts.dynamicTools = { connector, plugin };
  let p = PT.projectTools({ id: AGENT }, origin, role, facts);
  if (p.pendingFacts.indexOf('spotifyConnected') >= 0) {
    facts.availability = Object.assign({}, facts.availability, { spotifyConnected: h.spotify ? true : false });
    p = PT.projectTools({ id: AGENT }, origin, role, facts);
  }
  if (overrides.mutate) p = overrides.mutate(p, { registry, authority }) || p;
  return cellsOf(p, overrides.mutate ? PT.rowsOf(p, { agentId: AGENT, registry, authority, surface, enabledToolsets: unrestrictedHost ? null : o.enabledToolsets, directDomain: h.directDomain }) : p.rows);
}

// every difference between two matrices, one line per cell, empty when they agree
function diffMatrix(a, b) {
  const out = [];
  const ids = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
  for (const id of Array.from(ids).sort()) {
    const x = a[id], y = b[id];
    if (!x || !y) { out.push(id + ': ' + (x ? 'missing on the right' : 'missing on the left')); continue; }
    for (const k of ['granted', 'advertised', 'deferred', 'withheldExplained', 'unavailable']) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(id + ' ' + k + ': ' + JSON.stringify(x[k]) + ' != ' + JSON.stringify(y[k]));
    }
    const names = new Set(Object.keys(x.rows).concat(Object.keys(y.rows)));
    for (const n of Array.from(names).sort()) {
      if (JSON.stringify(x.rows[n]) !== JSON.stringify(y.rows[n])) out.push(id + ' ' + n + ': ' + JSON.stringify(x.rows[n]) + ' != ' + JSON.stringify(y.rows[n]));
    }
  }
  return out;
}

module.exports = { AGENT, FACTORIES, ORIGINS, POSTURES, VARIANTS, BRIEF_TOOLS, scenarios, catalogRegistry, cutRunOnce, runOnceMatrix, cellsFromRunOnce, projectMatrix, diffMatrix, encodeMatrix, decodeMatrix, hostFacts,
  readoutPlaced, roomTypesOf };
