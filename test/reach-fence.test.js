/* node test/reach-fence.test.js — THE REACH FENCE (2026-11-08): the pure halves of "Full Access + TRUSTED PROJECT never
   asks, never leaves the approved folders". The live run is proven by test/reach-fence.e2e.test.js (http.list). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Profiles = require('../sidecar/execution-profiles.js');
const { makeRunAuthority, runInputContext } = require('../sidecar/inputpolicy.js');
const { effectiveToolsets } = require('../sidecar/capability/effective-toolsets.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');

(async () => {
  // 1. ONE predicate: only TRUSTED PROJECT fences, and only Full Power has anything to fence
  for (const id of Profiles.VALID_IDS) {
    const fenced = id === 'trusted-project';
    A.eq(Profiles.fencesHost(id), fenced, 'fencesHost(' + id + ')');
    A.eq(Profiles.fencesHost(Profiles.resolve(id, { approvalMode: 'full' })), fenced, 'fencesHost reads a resolved profile too: ' + id);
    // REMOTE SSH (2026-10-19) keeps its Full Power on its own machine, so it never reaches this one either
    A.eq(Profiles.reachesWholeHost(Profiles.resolve(id, {}), true), !fenced && id !== 'remote-ssh', 'Full Power reaches the whole host unless fenced or remote: ' + id);
    A.eq(Profiles.reachesWholeHost(Profiles.resolve(id, {}), false), false, 'ASK never reaches the whole host: ' + id);
  }

  // 2. the run authority keeps the APPROVAL half and drops the REACH half
  const tool = (name, capability) => ({ name, capability });
  const fencedAuth = makeRunAuthority({ surface: 'autonomous', fullAccess: () => true, hostFenced: true });
  A.eq(fencedAuth.unrestrictedHost(), false, 'a fenced Full Access run is not host-wide');
  A.ok(fencedAuth.mode !== 'full-power', 'a fenced run never reports the full-power input mode: ' + fencedAuth.mode);
  A.eq(fencedAuth.project(tool('shell.exec', 'workbench')), true, 'unattended terminal stays projected without a per-routine grant (no-asking survives)');
  A.eq(fencedAuth.authorize({ name: 'shell.exec' }, tool('shell.exec', 'workbench')).ok, true, 'unattended terminal is authorized without a card');
  A.eq(fencedAuth.project(tool('computer.use', 'physical-input')), false, 'screen/input control is not projected under the fence');
  const desk = fencedAuth.authorize({ name: 'desktop.open' }, tool('desktop.open', 'visible-desktop'));
  A.eq(desk.ok, false, 'visible desktop is refused under the fence');
  A.ok(/TRUSTED PROJECT/.test(desk.reason) && /THIS COMPUTER/.test(desk.reason), 'the refusal names the reach and the way out, not "requires Full Power": ' + desk.reason);
  const bypassFenced = makeRunAuthority({ surface: 'autonomous', masterBypass: true, hostFenced: true });
  A.eq(bypassFenced.unrestrictedHost(), false, 'the station-wide bypass is fenced by a TRUSTED PROJECT reach too');
  const open = makeRunAuthority({ surface: 'autonomous', fullAccess: () => true });
  A.eq(open.unrestrictedHost(), true, 'an unfenced Full Access run stays host-wide (THIS COMPUTER unchanged)');
  A.eq(runInputContext('autonomous', true, false, fencedAuth.unrestrictedHost()).unrestrictedHost, false, 'tools receive the fenced reach in ctx');

  // 3. the toolsets readout tells the same truth as the run
  const view = effectiveToolsets({ agentId: 'forge', agent: { approvalMode: 'full', executionProfile: 'trusted-project' }, placed: [], disabled: { web: false } });
  A.eq(view.authority.unrestricted, false, 'readout: fenced Full Access is not unrestricted');
  A.eq(view.authority.fenced, true, 'readout: the fence is disclosed');
  A.ok(view.authority.filesystemLabel !== 'Whole local computer', 'readout never says "whole local computer" for a fenced agent: ' + view.authority.filesystemLabel);
  A.ok(/^FULL ACCESS/.test(view.authority.approvalLabel) && /TRUSTED PROJECT/.test(view.authority.approvalLabel), 'readout keeps the no-prompts label and names the reach: ' + view.authority.approvalLabel);
  // the fence narrows REACH, never tools: a fenced Full Power agent keeps every family, its switch overridden like any Full Power agent's
  A.eq(view.toolsets.find(t => t.id === 'web').available, true, 'a fenced Full Power agent keeps every tool family (the switch is overridden)');
  A.eq(view.toolsets.find(t => t.id === 'web').grantSource, 'Full Access', 'readout names Full Access as the tool grant');

  // 3b. the run's projection: every tool family, but no physical-desktop tool (that is reach, not capability)
  const ProjectTools = require('../sidecar/capability/project-tools.js');
  const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
  const fencedStation = ProjectTools.projectStation({ id: 'forge' }, { surface: 'autonomous' }, { lead: false },
    { connectorIds: [], unrestrictedHost: false, fullPower: true, executionProfile: Profiles.resolve('trusted-project', { approvalMode: 'full' }) }).station;
  const placedTypes = new Set(((fencedStation.rooms[fencedStation.agents.forge.room] || {}).objects || []).map(ob => ob.objectType));
  const missing = Object.keys(CAP_REGISTRY).filter(t => t !== 'builder' && t !== 'orchestrator' && !placedTypes.has(t));
  A.eq(missing, [], 'a fenced Full Power run is projected every capability family');
  const thisComputer = effectiveToolsets({ agentId: 'ultron', agent: { approvalMode: 'full', executionProfile: 'this-computer' }, placed: [] });
  A.eq(thisComputer.authority.filesystemLabel, 'Whole local computer', 'THIS COMPUTER + Full Access readout is unchanged');

  // 4. the path guard as a fenced run calls it (fullAccess/unrestrictedHost false): inside flows, outside never does unattended
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-fence-unit-'));
  try {
    const project = path.join(tmp, 'project'); const outside = path.join(tmp, 'outside');
    fs.mkdirSync(project); fs.mkdirSync(outside); fs.mkdirSync(path.join(tmp, 'ws'));
    fs.writeFileSync(path.join(project, 'a.txt'), 'in'); fs.writeFileSync(path.join(outside, 'b.txt'), 'out');
    const real = fs.realpathSync(project);
    const core = makePathTrust({ fsp, pathMod: path, roots: () => [real], workspaceRoot: path.join(tmp, 'ws'), now: () => 0 });
    const fencedOpts = { scope: 'read', surface: 'autonomous', prompt: null, agentId: 'forge', fullAccess: false, unrestrictedHost: false };
    const inside = await core.guard(path.join(project, 'a.txt'), fencedOpts);
    A.ok(inside && inside.abs, 'an approved project path flows with no prompt');
    let refused = '';
    try { await core.guard(path.join(outside, 'b.txt'), fencedOpts); } catch (e) { refused = String(e.message); }
    A.ok(/an autonomous run cannot bless a new folder/.test(refused), 'an unattended fenced run is refused outside the approved folders: ' + refused);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }

  // 5. the page and the model are told the same fence the sidecar enforces
  const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  A.ok(/function reachFencedId\(id\) \{ return id === 'trusted-project'; \}/.test(ui), 'the dossier copy keys on the same single fenced id as fencesHost');
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
  A.ok(/if \(full && String\(a\.executionProfile \|\| ''\) === 'trusted-project'\) return '\\n\\nAUTHORITY — FULL POWER INSIDE YOUR PROJECT FOLDERS/.test(app),
    'a fenced agent\'s system clause never tells it it has the whole computer');
  // …and the CLI composes the same clause from the lifted function (bin/lib/app-modules.js), which must not crash on it
  const AppModules = require('../bin/lib/app-modules.js');
  const composer = AppModules.load().composer;
  const fencedPrompt = composer.compose({ id: 'forge', name: 'FORGE', approvalMode: 'full', executionProfile: 'trusted-project' }, {});
  const hostPrompt = composer.compose({ id: 'ultron', name: 'ULTRON', approvalMode: 'full', executionProfile: 'this-computer' }, {});
  A.ok(/FULL POWER INSIDE YOUR PROJECT FOLDERS/.test(fencedPrompt) && !/authorized the whole local computer/.test(fencedPrompt), 'the CLI-composed prompt of a fenced agent carries the fenced clause');
  A.ok(/authorized the whole local computer/.test(hostPrompt), 'the CLI-composed prompt of a THIS COMPUTER agent keeps the whole-computer clause');

  A.report('reach-fence.test');
})().catch(e => { console.log('FAIL: reach-fence.test threw — ' + (e && e.stack || e)); process.exit(1); });
