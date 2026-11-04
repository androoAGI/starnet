/* sidecar/tools/catalog.js — the DECLARED host tool catalogue (authority-census lane, 2026-10-30).

   A run registers its tools fresh (runOnceCore: every factory below, with that run's live dependencies). A readout that
   must describe the SAME decision without starting a run — GET /api/toolsets' projection, the authority census — needs
   the same declarations: name, capability, scope, impact, consent class. buildCatalog() makes them from the REAL
   factories with inert dependencies, so a declaration lives in exactly one place (the factory) and is read the same way
   by the run and by the readout. test/authority-census.test.js locks FACTORY_NAMES to the factories runOnceCore calls.

   A catalogue tool is never dispatched: its run() closes over inert dependencies and would fail. Readers use
   get / list / wireFormat only. */
'use strict';

const fs = require('fs');
const path = require('path');
const { makeRegistry } = require('./registry.js');

const noop = () => {};
const clock = { now: () => 0 };
const NO_ROOT = 'catalog-never-runs';
const INERT_STORE = Object.freeze({ store: {} });
const b = (rel) => require('./builtin/' + rel);

// [factory name as runOnceCore calls it, (registry, platform) => tools object with .register]. A factory whose
// description states a platform fact takes the catalogue's platform (gh#128 family: runtimeinfo.js hostFacts).
const FACTORIES = [
  ['makeWebTools', () => b('web.js').makeWebTools({ surface: 'autonomous', redact: s => s, resolveServiceKey: () => ({ ok: false }) })],
  ['makeConnectorTools', () => b('connectors.js').makeConnectorTools({ connectors: { list: () => [] }, serviceKeys: () => [], connectorCatalog: { get: () => null, list: () => [] }, keysCatalog: { list: () => [] } })],
  ['makeKeyTools', () => b('keys.js').makeKeyTools({ ownerTexts: () => null, save: noop, tainted: () => true })],
  ['makeStationInspectTool', () => b('station-inspect.js').makeStationInspectTool({ inspect: () => ({}) })],
  ['makeManualReadTool', () => b('manual-read.js').makeManualReadTool()],
  ['makeStationShowTool', () => b('station-show.js').makeStationShowTool({ station: {} })],
  ['makeAppTools', () => b('apps.js').makeAppTools({ apps: {}, now: clock.now, compile: () => '' })],
  ['makeBrowserTools', (registry, platform) => b('browser.js').makeBrowserTools({ session: {}, platform })],
  ['makeDesktopTools', () => b('desktop.js').makeDesktopTools({ allowRemoteDesktop: false })],
  ['makeFsTools', () => b('fs.js').makeFsTools({ fsp: fs.promises, pathMod: path, root: NO_ROOT })],
  ['makeNotebookTools', () => b('notebook.js').makeNotebookTools({ store: {} })],
  ['makeWidgetTools', () => b('widgets.js').makeWidgetTools({ store: {}, clock })],
  ['makeRecallTool', () => b('recall.js').makeRecallTool({ transcriptStore: {} })],
  ['makeSkillTools', () => b('skills.js').makeSkillTools(INERT_STORE)],   // never runs, so it scrubs nothing (the run's own passes scrubSkillsForPrompt)
  ['makeTodoTool', () => b('todo.js').makeTodoTool({ store: {} })],
  ['makeDeliverableTool', () => b('deliverable.js').makeDeliverableTool({ notes: [] })],
  ['makeToolSearchTool', (registry) => b('toolsearch.js').makeToolSearchTool({ registry })],
  ['makeCodeTools', () => b('code.js').makeCodeTools({})],
  ['makeQuestTools', () => b('quests.js').makeQuestTools({ store: {}, clock })],
  ['makeImageTools', () => b('image.js').makeImageTools({ fsp: fs.promises, pathMod: path, root: NO_ROOT })],
  ['makeVoiceTools', () => b('voice.js').makeVoiceTools({ synth: noop, fsp: fs.promises, pathMod: path, root: NO_ROOT })],
  ['makeResolveTools', () => b('resolve.js').makeResolveTools({ fsp: fs.promises, pathMod: path, root: NO_ROOT, spawn: noop, config: {} })],
  ['makeSpotifyTools', () => b('spotify.js').makeSpotifyTools({ store: {} })],
  ['makeShellTool', (registry, platform) => b('shell.js').makeShellTool({ spawn: () => { throw new Error('catalog tools never run'); }, fs, pathMod: path, root: NO_ROOT, bg: {}, platform })],
  ['makeTerminalTools', () => b('terminal.js').makeTerminalTools({ manager: {}, environment: {}, fs, pathMod: path, root: NO_ROOT, envFor: () => ({}) })],
  ['makeVerifyTool', () => b('verify.js').makeVerifyTool({ spawn: noop, fs, pathMod: path, root: NO_ROOT })],
  ['makeComputerTools', (registry, platform) => b('computer.js').makeComputerTools({ allowPhysicalInput: false, platform })],
  ['makeOrchestrationTools', () => b('orchestration.js').makeOrchestrationTools({ runOnce: noop, roster: () => ({}) })],
  ['makeStationTools', () => b('station.js').makeStationTools({ station: {}, now: clock.now })],
  ['makeStationControlTools', () => b('station-control.js').makeStationControlTools({ station: {}, route: noop, surface: 'autonomous' })],
  ['makeRoutineTools', () => b('routines.js').makeRoutineTools({ roster: () => ({}) })],
  ['makeLoopTools', () => b('loops.js').makeLoopTools({})],
  ['makeCommsTools', () => b('comms.js').makeCommsTools({ listTargets: () => [], sendTo: noop })]
];
const FACTORY_NAMES = Object.freeze(FACTORIES.map(f => f[0]));

// buildCatalog({ platform }?) -> a fresh registry holding every host tool a run registers (+ the Task Brief controls a
// briefed run adds), declared for `platform` (default: this host's, which is what a run on this machine registers).
// Fresh each call: a readout may register its room's connector tools into it without touching another reader's copy.
function buildCatalog(opts) {
  const platform = String((opts && opts.platform) || process.platform);
  const registry = makeRegistry();
  for (const [, make] of FACTORIES) make(registry, platform).register(registry);
  require('../taskbrief-tools.js').registerTaskBriefTools(registry, { get: () => null, update: noop }, { brief: {} }, { now: clock.now });
  // a declaration, never an effect: every catalogue tool refuses to run, whoever dispatches it
  for (const t of registry.list()) t.run = async () => { throw new Error('"' + t.name + '" is a catalogue declaration (tools/catalog.js) and never runs'); };
  return registry;
}

module.exports = { FACTORY_NAMES, buildCatalog };
