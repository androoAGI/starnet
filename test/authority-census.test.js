/* node test/authority-census.test.js — the surface x origin x role x tool authority matrix, ONE projection, and declared
   impact (authority-census lane, TIER 1: zero authority change; 2026-10-30).

   WHAT IS LOCKED
   1. SNAPSHOT. test/fixtures/authority-matrix.json is the matrix captured on 748b0462595530c190acda10b703243d413939b4
      (run-wire's final tip, before this lane moved anything): 71 scenarios — every origin that starts a run (the call
      site each copies is named in test/helpers/authority-census.js ORIGINS) x ASK / FULL POWER, plus host-fact variants —
      and for each one the ordered grant, the ordered advertised and deferred wire lists, which withheld tools carry an
      explanation, which are certainly unavailable, and one row per tool the room offered: state (advertised / deferred /
      granted / withheld), impact class, consent class, grant source and limiting reason. It was captured by EXECUTING the
      base runOnceCore tool assembly — cut out of that tree's sidecar/index.js between fixed anchors and run in a vm with
      each scenario's host facts over the base's own tool factories (runOnceMatrix). Nothing was transcribed by hand.
   2. ONE PURE PROJECTION. sidecar/capability/project-tools.js projectTools(agent, origin, role, facts) is that assembly,
      moved; runOnceCore, GET /api/toolsets (its `run` preview) and a channel's /tools now ask it. This test recomputes the
      whole matrix twice — through projectTools directly, and through THIS tree's runOnceCore cut (which now calls it) —
      and requires both to equal the snapshot cell for cell. An empty diff is the whole claim: any non-empty cell is a bug
      in the move, not a policy change. Two mutations prove the instrument bites (a declaration and a runOnce source edit).
   3. THE DECLARED CATALOGUE. sidecar/tools/catalog.js — the host tools a readout projects over — is locked to the
      factories runOnceCore actually calls. (Declared impact and register()'s refusal: test/register-impact.test.js.)

   PRESERVED (A5 preserve list): FULL POWER host-wide semantics and origin withholding (channel.guest / facts.bypass.guest
   keep the unattended floor); delegated ASK worker shell policy (worker@ask: no shell.exec, terminal reads kept); per-routine
   and per-key grants (routine.schedule.granted); owner direct orchestration; run-wire's manual-routine identity
   (routine.manual: routine.notepad is a routine run); the release lane's reader narrowing is NOT applied here (terminal.read
   / status, shell.bg.read, channel.targets stay impact none on this base — pending Andrew); group/widget scope; connector
   provenance (mcp__/plugin__ tools keep external-unknown, fail closed).

   ---- TIER-2 PROPOSAL FOR ANDREW (NOT CODE: no cell below is changed by this lane) ----
   Computed by projecting the same 71 scenarios with each rule applied to a scratch copy of the projection, diffed against
   the snapshot.

   A. Spec step 6 — derive orchestrator authority from the run's ROLE (owner-DM direct keeps it; line stages and hops drop
      it; narrowing only). Exactly four cells move; nothing is gained anywhere:
        line.entry.owner@ask, line.entry.owner@full, line.hop@ask, line.hop@full each LOSE the 33 orchestrator tools —
        team.dispatch / spawn / summon / subagents / steer / interrupt / resume, routine.list / create / manage,
        session.list / create / peek / focus, task.list / create / manage, team.config / configure, station.status /
        layout / map / plan / build / make_prop / test_line / start_line / settings / control / power, loop.list /
        create / manage.
      Unchanged: channel.owner* and channel.bay (owner DM direct), remote.phone* , desktop / editor / group leads, every
      worker (already lead-less), every routine. Under FULL POWER the same 33 drop for a line role (the sweep's
      `role.lead || ownerTrusted` clause would read the role, not the ingress). Today a line stage reached through an owner
      DM can re-delegate and reconfigure the station because hub.js carries ownerTrusted into it (a5 R4).
   B. Spec step 4 — an origin table on the SAVED floor instead of the hard-coded offices (A5-Q4). Today every headless
      origin (channel.*, line.*, routine.*, loop, api.v1, trigger.entry, worker*) is handed office/composeOffice's full
      default office — computer, dish, cabinet, notebook, studio, jukebox — whatever the agent's saved floor holds: 76 tools
      in ASK, 86 when the jukebox clears (owner DM, FULL POWER). The editor / CLI copy a coding office (acp/serve.js,
      bin/lib/cli-core.js: computer, cabinet, workbench, dish, notebook) and a worker its WORKER_KIT. A saved-floor-only
      table would replace each with the agent's saved placement, so for an agent with an empty saved floor a scheduled
      routine would lose web (dish: 42 tools incl. web_request and the browser), files (cabinet: 7), memory (notebook:
      10), studio (6) and jukebox (8); the editor would lose its terminal unless a workbench is placed. Which origins
      keep which exception (CLI/editor, headless, worker, owner DM, group) is Andrew's call; the per-agent diff is the
      matrix this test prints with the rule applied.
   C. Not proposed here (OUT OF SCOPE until Andrew answers): A5-Q1 AUTO terminology, Q2/Q3 read ownership and class (the
      release lane's external-unknown readers), Q6 exact-call Always / session / Full choices. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./helpers/authority-census.js');
const { sidecarTopLevelFunction, readSidecarIndex } = require('./helpers/source');
const { IMPACTS } = require('../sidecar/inputpolicy.js');
const Catalog = require('../sidecar/tools/catalog.js');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'authority-matrix.json'), 'utf8'));
  A.eq(fixture.capturedOn, '748b0462595530c190acda10b703243d413939b4', 'the snapshot was captured on run-wire\'s final tip');
  const snapshot = C.decodeMatrix(fixture);
  const ids = C.scenarios().map(s => s.id);
  A.eq(Object.keys(snapshot).sort(), ids.slice().sort(), 'the snapshot holds every scenario the census defines (' + ids.length + ')');
  A.ok(ids.length >= 70, 'the matrix covers every origin x posture plus the host-fact variants');
  A.eq(C.diffMatrix(snapshot, C.decodeMatrix(C.encodeMatrix(snapshot, {}))), [], 'the fixture packing round-trips');

  // ---- 2. the move: the projection and this tree's runOnce both reproduce every cell ----
  const viaProjection = {}, viaRunOnce = {};
  for (const s of C.scenarios()) {
    viaProjection[s.id] = await C.projectMatrix(ROOT, s);
    const cap = await C.runOnceMatrix(ROOT, s);
    A.eq(cap.failNotes, [], s.id + ': the runOnce assembly ran without a fail-open note');
    A.ok(cap.out.projection && cap.out.projection.rows, s.id + ': this tree\'s runOnceCore decides its tools through ProjectTools.projectTools');
    viaRunOnce[s.id] = C.cellsFromRunOnce(cap, ROOT);
  }
  const d1 = C.diffMatrix(snapshot, viaProjection);
  A.eq(d1.length, 0, 'projectTools reproduces the 748b0462595 matrix: an EMPTY diff (' + d1.slice(0, 6).join(' | ') + ')');
  const d2 = C.diffMatrix(snapshot, viaRunOnce);
  A.eq(d2.length, 0, 'runOnceCore (which now calls projectTools) reproduces it too: an EMPTY diff (' + d2.slice(0, 6).join(' | ') + ')');

  // the cells that carry the preserved policy, named so a reader sees what the empty diff protects
  const cell = (id, name) => snapshot[id].rows[name] || { state: 'absent' };
  A.eq(cell('worker@ask', 'shell.exec').state, 'withheld', 'delegated ASK worker: no shell, WORKBENCH or not');
  A.eq(cell('worker@ask', 'shell.exec').reason, 'authority:workspace-process', '...withheld by the run authority, and explained');
  A.ok(/delegated by leadagent/.test(cell('worker@ask', 'shell.exec').why || ''), '...with the delegated-command-gap remedy (issue #77)');
  A.ok(['advertised', 'deferred'].indexOf(cell('worker@ask', 'terminal.read').state) >= 0, 'delegated ASK worker keeps the terminal readers (impact none on this base)');
  A.eq(cell('routine.schedule.granted@ask', 'shell.exec').state, 'advertised', 'a routine granted the terminal gets shell.exec');
  A.eq(cell('routine.schedule@ask', 'shell.exec').state, 'absent', '...and an ungranted one does not (its office has no workbench to grant one)');
  A.eq(cell('routine.bay@ask', 'shell.exec').reason, 'authority:workspace-process', '...nor does one whose bay holds a workbench: the run authority withholds it');
  A.eq(cell('routine.schedule.granted@ask', 'mcp__gh__create_issue').state, 'advertised', 'the connectors grant reaches real connector tools');
  A.eq(cell('routine.schedule@ask', 'mcp__gh__create_issue').reason, 'authority:external-unknown', '...an ungranted routine never does');
  A.eq(cell('channel.guest@full', 'shell.exec').state, 'absent', 'FULL POWER follows the owner: a channel guest on a Full Access agent has no terminal');
  A.eq(cell('facts.bypass.guest@ask', 'shell.exec').state, 'absent', '...nor under the station master bypass');
  A.eq(cell('channel.owner@ask', 'team.dispatch').state, 'deferred', 'owner DM direct keeps lead orchestration (deferred while crewless)');
  A.ok(['advertised', 'deferred'].indexOf(cell('line.hop@ask', 'team.dispatch').state) >= 0, 'a hop of an owner-DM line still holds it on this base (Tier-2 proposal A, unchanged here)');
  A.eq(cell('routine.manual@ask', 'routine.notepad').state, 'advertised', 'a Run Now routine is a routine run (run-wire\'s manual-routine identity)');
  A.eq(cell('desktop.floor@ask', 'routine.notepad').reason, 'unavailable:routine-run', '...a desk run is not');
  A.eq(cell('desktop.bare@ask', 'computer.use').state, 'absent', 'no physical input without the desktop lease');
  A.eq(cell('remote.phone.desktop@ask', 'computer.use').source, 'desktop-lease', 'the paired owner phone\'s lease is a host injection');
  A.eq(cell('group.lead@ask', 'team.dispatch').state, 'absent', 'a group turn trades team.*/session.* for its own scoped closures');
  A.eq(cell('group.lead@ask', 'group.handoff').source, 'group-turn', '...whose source is the live group turn');
  A.eq(cell('widget.update@ask', 'widget.set').source, 'widget-scope', 'the widget\'s own run gets its two widget tools');
  A.eq(cell('facts.plugin@ask', 'plugin__p1__ping').impact, 'external-unknown', 'a plugin tool keeps the connector trust class');
  A.eq(cell('desktop.floor@ask', 'channel.send').consent, 'exact:comms:execute', 'channel.send is an exact per-call confirmation');
  A.eq(cell('desktop.floor@ask', 'mcp__gh__create_issue').consent, 'broker:mcp:gh:execute', 'a real connector rides the standing-grant broker');
  A.eq(cell('desktop.floor@ask', 'terminal.read').impact, IMPACTS.NONE, 'terminal.read is impact none on this base (the release lane\'s narrowing is not applied here)');

  // ---- the instrument bites: a declaration change and a runOnce source change both show up as cells ----
  {
    const mutated = await C.projectMatrix(ROOT, C.scenarios().find(s => s.id === 'worker@ask'), {
      registry: (() => { const r = Catalog.buildCatalog(); const t = r.get('terminal.read'); t.impact = 'external-unknown'; return r; })()
    });
    const d = C.diffMatrix({ 'worker@ask': snapshot['worker@ask'] }, { 'worker@ask': mutated });
    A.ok(d.some(l => /terminal\.read/.test(l)), 'MUTATION 1 (terminal.read declared external-unknown, the release lane\'s class) is a non-empty diff on worker@ask: ' + d.slice(0, 2).join(' | '));
  }
  {
    const s = C.scenarios().find(x => x.id === 'routine.schedule.granted@ask');
    const cap = await C.runOnceMatrix(ROOT, s, { extend: { normalizeUnattendedGrants: () => new Set() } });
    const d = C.diffMatrix({ [s.id]: snapshot[s.id] }, { [s.id]: C.cellsFromRunOnce(cap, ROOT) });
    A.ok(d.some(l => /shell\.exec/.test(l)), 'MUTATION 2 (runOnce drops the routine\'s recorded grants) is a non-empty diff: ' + d.slice(0, 2).join(' | '));
  }

  // ---- 3. the declared catalogue (tools/catalog.js) is the run's: every factory runOnceCore calls, nothing else ----
  // (declared impact itself, and register()'s refusal of an undeclared host tool: test/register-impact.test.js)
  const catalog = Catalog.buildCatalog();
  A.ok(catalog.list().length >= 140, 'the declared catalogue holds every host tool a run registers (' + catalog.list().length + ')');
  {
    const res = await Catalog.buildCatalog().dispatch({ id: 'x', name: 'fs.read', args: { path: 'a' } }, {});
    A.ok(res.isError && /catalogue declaration/.test(String(res.content)), 'a catalogue tool never runs, whoever dispatches it');
  }
  // the catalogue is the run's: every factory runOnceCore calls, and nothing else
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const called = Array.from(new Set((core.match(/\bmake[A-Z][A-Za-z]*Tools?\(/g) || []).map(m => m.slice(0, -1))));
    const alternates = ['makeCuaComputerTools'];   // the cua driver's computer.use: the same declaration as makeComputerTools
    const expected = called.filter(n => alternates.indexOf(n) < 0).concat(['makeWidgetTools']).sort();
    A.eq(Catalog.FACTORY_NAMES.slice().sort(), expected, 'tools/catalog.js builds exactly the factories runOnceCore registers (+ the module-level widget tools)');
    A.ok(/widgetTools\.register\(registry\)/.test(core) && /const widgetTools = makeWidgetTools\(/.test(readSidecarIndex()), 'the widget tools are the module-level makeWidgetTools a run registers');
    A.ok(/registerTaskBriefTools\(registry, /.test(core), 'the Task Brief controls a briefed run registers are in the catalogue too');
    A.eq(C.FACTORIES.map(f => f[0]).sort(), Catalog.FACTORY_NAMES.slice().sort(), 'the base list the snapshot was captured with names the same factories');
  }

  // ---- the readouts ask the same projection ----
  {
    const idx = readSidecarIndex();   // deliberately index.js itself: these are its own wiring
    const core = sidecarTopLevelFunction('runOnceCore');
    A.ok(/let projection = ProjectTools\.projectTools\(projectionAgent, projectionOrigin, projectionRole, projectionFacts\);/.test(core), 'runOnceCore decides its tools with ProjectTools.projectTools');
    A.ok(/const deferredNames = projection\.deferredNames;/.test(core) && /const coreNames = projection\.coreNames;/.test(core), 'the wire lists are the projection\'s');
    const preview = sidecarTopLevelFunction('toolsetsPreview');
    A.ok(/ProjectTools\.projectTools\(\{ id: agentId \}, origin, role, facts\)/.test(preview) && /ToolCatalog\.buildCatalog\(\)/.test(preview)
      && /registerRoomTools\(registry, projectedStation, agentId, providerId\)/.test(preview), 'GET /api/toolsets previews a COMMS run through the same projection, catalogue and room tools');
    A.ok(/toolsetsPreview\(agentId, extraObjects, fromQuery \? 'query' : 'saved'\)/.test(sidecarTopLevelFunction('handleToolsetsList')), 'handleToolsetsList answers with that preview');
    A.ok(/ProjectTools\.projectStation\(/.test(sidecarTopLevelFunction('runSlashForChannel')), 'a channel\'s /tools reads the room from the same projection');
    A.ok(/projectionFacts\.dynamicTools = await registerRoomTools\(registry, projectedStation, agentId, providerId\);/.test(core), 'the run registers its room\'s connector/plugin tools through the one shared helper');
    A.ok(!/composeOffice\(|stationWithObject\(|enforceRunAuthority\(|withheldCommandTools\(/.test(idx), 'index.js keeps no second copy of the office, augmentation, authority or withheld assembly');
  }

  A.report('authority-census.test');
})().catch(e => { console.error('FAIL: authority-census.test threw — ' + (e && e.stack || e)); process.exit(1); });
