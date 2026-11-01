/* node test/agent-lifecycle.test.js — deterministic per-agent lifecycle coordination. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeWorkspaceLease } = require('../sidecar/workspace-lease.js');
const { makeAgentLifecycle } = require('../sidecar/agent-lifecycle.js');

(async () => {
  let active = 0;
  const lease = makeWorkspaceLease({ waitMs: 1000, now: () => 1 });
  const life = makeAgentLifecycle({ workspaceLease: lease, isActive: () => active > 0 });

  // Restore/autonomy-style mutations serialize through the same workspace lease as run tools.
  const runLease = await lease.acquire('a', 'run-1');
  A.eq(runLease.ok, true, 'active mutation holds workspace lease');
  let mutationAcquired = false;
  const mutationP = life.acquireMutation('a', 'restore-1').then(x => { mutationAcquired = x.ok; return x; });
  await Promise.resolve();
  A.eq(mutationAcquired, false, 'lifecycle mutation waits behind active workspace mutation');
  lease.release('a', 'run-1');
  const mutation = await mutationP;
  A.eq(mutation.ok, true, 'lifecycle mutation acquires after active mutation drains');
  mutation.release();

  // Deletion safely rejects an agent with active runs.
  active = 1;
  const refused = await life.beginDelete('a', 'delete-1');
  A.eq(refused.active, true, 'active agent deletion is rejected');
  A.eq(life.canStart('a'), true, 'rejected deletion leaves future runs enabled');
  active = 0;

  // Once deletion reserves the lifecycle, new runs and late non-run writes cannot enter.
  const deleting = await life.beginDelete('a', 'delete-2');
  A.eq(deleting.ok, true, 'idle agent deletion reserves the lifecycle');
  A.eq(life.canStart('a'), false, 'new run admission is blocked during archive');
  const lateWrite = await life.acquireMutation('a', 'autowrite-late');
  A.eq(lateWrite.deleting, true, 'late autonomy/restore write is rejected during archive');
  deleting.finish();
  A.eq(life.canStart('a'), true, 'finishing archive releases lifecycle reservation');

  // Source wiring guard: all three routes use the policy and run admission observes deletion.
  const source = readSidecarSource();
  A.ok(/agentLifecycle\.acquireMutation\(agentId,\s*operationId\)[\s\S]{0,900}checkpointStore\.restore/.test(source),
    'checkpoint restore acquires the lifecycle mutation lease');
  A.ok(/handleAutonomyWrite[\s\S]{0,2600}agentLifecycle\.acquireMutation\(agentId,\s*sessionKey\)/.test(source),
    'autonomy write acquires the lifecycle mutation lease');
  A.ok(/handleAgentDelete[\s\S]{0,1400}agentLifecycle\.beginDelete/.test(source),
    'agent deletion reserves the lifecycle before archive');
  A.ok(/agentLifecycle\.canStart\(agentId\)[\s\S]{0,900}concurrencyGate\.tryEnter/.test(source),
    'run admission rejects work while deletion is reserved');
  A.ok(/checkpointMutation:\s*async[\s\S]{0,1800}checkpointStore\.snapshot\(agentId,[\s\S]{0,500}workTree: workTree/.test(source),
    'run context snapshots the resolved mutation root instead of assuming the agent jail');
  A.ok(/preciseCheckpoint[\s\S]{0,900}environmentCheckpoints && mutatesWorkspace[\s\S]{0,200}!preciseCheckpoint/.test(source),
    'generic checkpoint hook defers fs, shell.exec, and verify.run to their precise-root boundary');
  A.ok(/checkpointMutation:\s*async[\s\S]{0,500}supports\.checkpoints === false\) return null/.test(source),
    'precise checkpoint hook honors the selected backend capability instead of snapshotting an unrelated local tree');

  const rewind = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'rewind.js'), 'utf8');
  A.ok(/s\.workTree[\s\S]{0,260}PROJECT ROOT/.test(rewind),
    'restore UI identifies external project-root snapshots explicitly');
  A.ok(/data-root=/.test(rewind) && /rolls back <b>' \+ esc\(root\)/.test(rewind),
    'restore confirmation names the exact root whose files will change');
  A.ok(/restoreAvailable/.test(rewind) && /PROJECT ACCESS REVOKED/.test(rewind),
    'restore UI blocks a project restore whose path grant is no longer active');

  // Browser deletion is server-first: lifecycle refusal and transport failures preserve every local surface.
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
  const deleteSource = A.fnBody(appSource, 'function deleteAgent(agentId)');
  A.ok(deleteSource && deleteSource.length < 6000, 'deleteAgent source is extracted exactly');
  A.ok(deleteSource.indexOf("fetch('/api/agent/delete'") < deleteSource.indexOf('agents.delete(id)'),
    'server authorization precedes the local roster mutation');

  function deletionHarness(fetchImpl) {
    const events = [];
    class TrackedMap extends Map {
      delete(id) { events.push('agents.delete:' + id); return super.delete(id); }
    }
    const hero = { id: 'agent', role: 'orchestrator' };
    const scout = { id: 'scout', role: 'specialist' };
    const agents = new TrackedMap([[hero.id, hero], [scout.id, scout]]);
    const ctx = {
      agents,
      agent: scout,
      events,
      fetch: (...args) => { events.push('fetch'); return fetchImpl(...args); },
      World: { despawnAgent: id => events.push('despawn:' + id) },
      station: {
        propsByAgent: id => [{ id: 'bay-' + id }],
        assignPropAgent: (id, agentId) => events.push('unbind:' + id + ':' + agentId)
      },
      Workstreams: { removeByAgent: id => events.push('streams.remove:' + id) },
      StationUI: { setRoster: roster => events.push('roster:' + roster.map(a => a.id).join(',')) }
    };
    const remove = new Function('CTX', `
      const agents = CTX.agents;
      let agent = CTX.agent;
      const fetch = CTX.fetch;
      const World = CTX.World;
      const station = CTX.station;
      const Workstreams = CTX.Workstreams;
      const StationUI = CTX.StationUI;
      function liveAgents() { return [...agents.values()]; }
      function focusAgent(id) { CTX.events.push('focus:' + id); agent = agents.get(id); }
      function recomposeOrchestrators() { CTX.events.push('recompose'); }
      function renderRail() { CTX.events.push('rail'); }
      function pushRoster() { CTX.events.push('pushRoster'); return Promise.resolve(true); }
      function persist() { CTX.events.push('persist'); }
      ${deleteSource}
      return deleteAgent;
    `)(ctx);
    return { remove, agents, events };
  }

  const deletionResponse = (ok, body) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
  for (const [name, fetchImpl] of [
    ['active-agent refusal', () => deletionResponse(false, { error: 'agent-active' })],
    ['malformed success response', () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) })],
    ['network failure', () => Promise.reject(new Error('offline'))]
  ]) {
    const browser = deletionHarness(fetchImpl);
    A.eq(await browser.remove('scout'), false, name + ' returns false');
    A.ok(browser.agents.has('scout'), name + ' preserves the roster');
    A.eq(browser.events, ['fetch'], name + ' causes no local lifecycle mutation');
  }

  const accepted = deletionHarness(() => deletionResponse(true, { ok: true }));
  A.eq(await accepted.remove('scout'), true, 'accepted deletion returns true');
  A.ok(!accepted.agents.has('scout'), 'accepted deletion removes the specialist');
  A.ok(accepted.events.indexOf('fetch') < accepted.events.indexOf('agents.delete:scout'), 'fetch completes before local removal');
  A.ok(accepted.events.includes('focus:agent'), 'focused deletion hands COMMS to the hero');
  A.ok(accepted.events.includes('despawn:scout'), 'accepted deletion removes the floor body');
  A.ok(accepted.events.includes('unbind:bay-scout:'), 'accepted deletion clears station bindings');
  A.ok(accepted.events.includes('streams.remove:scout'), 'accepted deletion retires bound workstreams');
  A.ok(accepted.events.includes('persist'), 'accepted deletion persists the surviving state');

  // Backend-initiated recruitment must not acknowledge a worker whose roster push failed or was refused.
  const summonSource = A.fnBody(appSource, 'async function summonForRequest(ev)');
  A.ok(summonSource && summonSource.length < 5000, 'summonForRequest source is extracted exactly');

  function recruitmentHarness(rosterResult) {
    const events = [];
    const ctx = {
      rosterResult,
      events,
      station: {
        propsByAgent: id => { events.push('props:' + id); return [{ id: 'desk-1', t: 'desk', x: 2, y: 3 }]; },
        capForProp: t => t === 'desk' ? 'computer' : '',
        roomAt: () => 'bridge',
        roomById: () => ({ name: 'BRIDGE' })
      }
    };
    const summon = new Function('CTX', `
      const Specialties = { get: () => null };
      const station = CTX.station;
      let lastRosterPush = CTX.rosterResult;
      function summonAgent(spec, opts) {
        CTX.events.push('summon:' + opts.activate + ':' + opts.desk);
        return { id: 'scout-2' };
      }
      ${summonSource}
      return summonForRequest;
    `)(ctx);
    return { summon, events };
  }

  const refusedRecruitment = recruitmentHarness(Promise.resolve(false));
  A.eq(await refusedRecruitment.summon({ name: 'Scout' }), null, 'resolved-false roster refusal produces a failure acknowledgement');
  A.eq(refusedRecruitment.events, ['summon:false:true'], 'roster refusal does not read a desk for a worker it cannot report');

  const rejectedRecruitment = recruitmentHarness(Promise.reject(new Error('offline')));
  A.eq(await rejectedRecruitment.summon({ name: 'Scout' }), null, 'rejected roster push produces a failure acknowledgement');
  A.eq(rejectedRecruitment.events, ['summon:false:true'], 'transport failure does not continue through the success path');

  const acceptedRecruitment = recruitmentHarness(Promise.resolve(true));
  A.eq(await acceptedRecruitment.summon({ name: 'Scout' }), { agentId: 'scout-2', desk: 'BRIDGE' }, 'accepted roster push returns the registered worker');
  A.eq(acceptedRecruitment.events, ['summon:false:true', 'props:scout-2'], 'success reads back the seeded workstation after registration');

  A.report('agent-lifecycle');
})().catch(e => { console.log('FAIL: agent-lifecycle threw - ' + (e && e.stack || e)); process.exit(1); });
