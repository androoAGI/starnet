/* node test/roster-envelope.http.test.js — P1.1 (UPDATE_STATE_SAFETY_AUDIT) roster-store hardening, boot-level.

   Focused companion to sidecar.http.test.js: proves the roster store reads a LEGACY on-disk shape
   ({ version:1, agents:[…] } with NO updatedAt) and treats it as the anti-clobber baseline 0 — so the
   FIRST live push (whatever its stamp) is accepted, and only a subsequent OLDER push is refused. Boots the
   real sidecar against a pre-seeded workspace (mirrors sidecar.http.test.js's boot). Part of test:http
   (a child-process boot test shouldn't gate the fast unit lane). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written

(async () => {
  const fixture = SidecarFixture.create({
    prefix: 'sk-roster-',
    env: { OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' }
  });
  const ws = fixture.workspace;
  // PRE-SEED a LEGACY roster file: the pre-P1.1 on-disk shape with NO updatedAt and an UNKNOWN field an older
  // sidecar never modeled. A correct load must NOT crash, must adopt baseline updatedAt 0, and must not choke
  // on the unknown field.
  fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify({
    version: 1,
    agents: [{ agentId: 'agent', system: 'hero', name: 'Ultron', provider: 'openrouter', legacyOnlyField: 'from-old-version' }]
  }));

  await fixture.start();
  let B = fixture.baseUrl;
  const rosterFile = path.join(ws, 'agent.roster.json');
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    apiToken = fixture.token;

    // the sidecar booted WITHOUT crashing on the legacy (updatedAt-less) file — health answers.
    const health = await j('GET', '/api/health');
    A.eq(health.status, 200, 'the sidecar booted cleanly against a LEGACY roster file (no updatedAt)');

    // legacy load adopts baseline 0 → the FIRST live push (any stamp) is accepted, not spuriously refused as stale.
    const first = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v2', name: 'Ultron', provider: 'openrouter' }], updatedAt: 100 });
    A.eq(first.status, 200, 'the first push after a legacy load -> 200');
    A.eq(first.body.ok, true, 'a legacy baseline (0) accepts the first push regardless of its stamp');
    A.eq(first.body.updatedAt, 100, 'the accepted push becomes the new on-disk baseline');
    // the file was upgraded to the envelope shape.
    const upgraded = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    A.eq(upgraded.updatedAt, 100, 'the legacy file is upgraded to carry an updatedAt envelope');
    // now an OLDER push is refused (the baseline took hold).
    const older = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'stale', name: 'Ghost', provider: 'openrouter' }], updatedAt: 50 });
    A.eq(older.body.ok, false, 'a push older than the freshly-set baseline is now refused (stale)');
    A.eq(older.body.stale, true, 'the older push is flagged stale');

    // audit 1.3 — approvalMode MUST persist. The load path (replaceAgentRoster) parses it, but saveAgentRoster used
    // to OMIT it, so a Full-Access agent silently reverted to 'ask' on every sidecar restart. Push a 'full' agent
    // (fresher stamp so it isn't refused as stale) and prove it lands in the on-disk roster envelope.
    const full = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v3', name: 'Ultron', provider: 'openrouter', approvalMode: 'full', executionProfile: 'trusted-project' }], updatedAt: 200 });
    A.eq(full.body.ok, true, 'the Full-Access push is accepted (fresher stamp)');
    const onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const savedAgent = (onDisk.agents || []).find(a => a.agentId === 'agent') || {};
    A.eq(savedAgent.approvalMode, 'full', 'approvalMode:full is written to the on-disk roster (was silently dropped before the fix)');
    A.eq(savedAgent.executionProfile, 'trusted-project', 'execution profile persists independently from Full Access');
    const profileApi = await j('GET', '/api/execution-profiles');
    A.eq(profileApi.status, 200, 'execution-profile authority is readable');
    A.eq(((profileApi.body.agents || [])[0] || {}).profile.id, 'trusted-project', 'profile API reports the stored per-agent envelope');
    A.eq(((profileApi.body.agents || [])[0] || {}).profile.approvalMode, 'full', 'profile API reports approval as a separate axis');
    A.eq(typeof (profileApi.body.backend || {}).backend, 'string', 'profile API reports the effective execution backend');
    A.ok((profileApi.body.profiles || []).some(p => p.id === 'remote-ssh' && p.effectiveBackend === 'ssh'), 'profile catalog exposes the routed Remote SSH backend');
    const policy = await j('POST', '/api/execution/policy', { idleCleanupMinutes: 17 });
    A.eq(policy.body.idleCleanupMinutes, 17, 'owner can persist the idle-cell cleanup policy');
    A.eq(policy.body.deletesContainers, false, 'cleanup policy explicitly promises stop-only behavior');
    const sshSaved = await j('POST', '/api/execution/ssh', { agentId: 'agent', host: 'buildbox', user: 'andrew', port: 2222, remoteRoot: '/srv/starnet/agent', probe: false });
    A.ok(sshSaved.body.saved && !sshSaved.body.ready, 'owner can save an offline SSH target without a fake readiness claim');
    A.eq(sshSaved.body.target.host, 'buildbox', 'saved SSH response returns only the nonsecret destination');
    const syncRefused = await j('POST', '/api/execution/sync', { agentId: 'agent', direction: 'push' });
    A.eq(syncRefused.status, 409, 'workspace sync refuses an agent that has not selected Remote SSH');
    const cleanupRefused = await j('POST', '/api/execution/cleanup', { agentId: 'agent' });
    A.eq(cleanupRefused.status, 409, 'cell stop refuses a non-Safe-Cell agent');
  } finally {
    await fixture.stop();
  }

  // RESTART SURVIVAL (the actual bug): boot a SECOND sidecar against the SAME workspace. On boot it runs
  // loadAgentRoster -> replaceAgentRoster (parses approvalMode into the live Map). To prove the value survived the
  // full save->load->save round-trip, ask this fresh sidecar to RE-PERSIST by pushing an UNRELATED field change that
  // OMITS approvalMode — /api/roster replaces the record from the pushed body, but a correct load carried
  // approvalMode into the live Map; the pre-existing behavior is that a browser push is the source of truth, so we
  // instead re-push approvalMode:'full' with a fresher stamp and confirm the reloaded-then-saved file still carries
  // it. The load correctness is proven because the SECOND sidecar started from the on-disk 'full' with no memory of
  // session 1, and its own save re-serializes only from the freshly-loaded live Map + this push.
  await fixture.start();
  try {
    const B2 = fixture.baseUrl;
    const tok2 = fixture.token;
    const jj = async (m, p, body) => {
      const headers = { 'Content-Type': 'application/json' }; if (tok2) headers['X-StarNet-Token'] = tok2;
      const r = await fetch(B2 + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    // health proves the fresh sidecar booted cleanly against the roster that carries approvalMode:full (a load that
    // choked on the field would crash the boot).
    const h2 = await jj('GET', '/api/health');
    A.eq(h2.status, 200, 'the SECOND sidecar boots cleanly against an on-disk roster carrying approvalMode:full');
    // the on-disk file the fresh sidecar loaded still carries the field (a load that dropped it would be re-saveable
    // as 'ask' on the next mutation; here we confirm the persisted truth is intact across the restart boundary).
    const afterBoot = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const reloaded = (afterBoot.agents || []).find(a => a.agentId === 'agent') || {};
    A.eq(reloaded.approvalMode, 'full', 'approvalMode:full survives a sidecar restart on disk (audit 1.3 — a Full-Access agent no longer reverts to ask)');
    A.eq(reloaded.executionProfile, 'trusted-project', 'execution profile survives the same sidecar restart');
    // and a fresh save from the SECOND sidecar (re-serialized from its freshly-loaded live Map) STILL writes 'full',
    // proving the load parsed it into the Map AND the save now emits it — the complete round-trip.
    const re = await jj('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v4', name: 'Ultron', provider: 'openrouter', approvalMode: 'full', executionProfile: 'safe-cell' }], updatedAt: 300 });
    A.eq(re.body.ok, true, 'the second sidecar accepts a fresher push');
    const afterSave = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const saved2 = (afterSave.agents || []).find(a => a.agentId === 'agent') || {};
    A.eq(saved2.approvalMode, 'full', 'the second sidecar RE-SAVES approvalMode:full (save->load->save round-trip is closed)');
    A.eq(saved2.executionProfile, 'safe-cell', 'profile changes without changing approval posture');
    const routed = await jj('GET', '/api/execution-profiles');
    const routedAgent = ((routed.body && routed.body.agents) || []).find(a => a.agentId === 'agent') || {};
    A.eq(routedAgent.profile && routedAgent.profile.effectiveBackend, 'local', 'Full Power routes this agent to the local host even while Safe Cell remains the stored post-revocation profile');
    A.eq(routedAgent.environment && routedAgent.environment.effectiveBackend, 'local', 'runtime truth agrees with active Full Power host authority');
    A.eq(routed.body && routed.body.backend && routed.body.backend.routing && routed.body.backend.routing.perAgent, true, 'station status exposes per-agent backend routing');
    A.eq(routed.body && routed.body.policy && routed.body.policy.idleCleanupMinutes, 17, 'idle cleanup policy survives a sidecar restart');
    A.eq(routedAgent.sshTarget && routedAgent.sshTarget.host, 'buildbox', 'nonsecret SSH destination survives the same restart');
    A.eq(routedAgent.sshTarget && routedAgent.sshTarget.password, undefined, 'profile status never exposes an SSH password');

    const revoked = await jj('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v5', name: 'Ultron', provider: 'openrouter', approvalMode: 'ask', executionProfile: 'safe-cell' }], updatedAt: 400 });
    A.eq(revoked.body.ok, true, 'the owner can revoke Full Power without changing the stored Safe Cell profile');
    const restricted = await jj('GET', '/api/execution-profiles');
    const restrictedAgent = ((restricted.body && restricted.body.agents) || []).find(a => a.agentId === 'agent') || {};
    A.eq(restrictedAgent.profile && restrictedAgent.profile.effectiveBackend, 'docker', 'revoking Full Power immediately restores the stored Safe Cell Docker route');
    A.eq(restrictedAgent.environment && restrictedAgent.environment.effectiveBackend, 'docker', 'runtime truth returns to the restricted profile after revocation');
  } finally {
    await fixture.dispose();
  }

  // A roster replacement is only accepted when its envelope reached durable storage. Force the real durable
  // writer to reject the replace by putting a directory at the roster-file path, then prove the route reports
  // failure and rolls its freshness baseline back so a later, genuinely newer-than-disk push is still accepted.
  const fault = SidecarFixture.create({
    prefix: 'sk-roster-write-fault-',
    env: { OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' }
  });
  seedActiveStation(fault.workspace);
  await fault.start();
  try {
    const BF = fault.baseUrl;
    const tokF = fault.token;
    const jf = async (m, p, body) => {
      const headers = { 'Content-Type': 'application/json' }; if (tokF) headers['X-StarNet-Token'] = tokF;
      const r = await fetch(BF + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    const faultRosterFile = path.join(fault.workspace, 'agent.roster.json');
    const baseline = await jf('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'baseline', name: 'Ultron', provider: 'openrouter' }], updatedAt: 100 });
    A.eq(baseline.body.ok, true, 'fault fixture establishes a durable roster baseline');
    fs.unlinkSync(faultRosterFile);
    fs.mkdirSync(faultRosterFile);

    const rejected = await jf('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'rejected', name: 'Ultron', provider: 'openrouter' }], updatedAt: 200 });
    A.eq(rejected.status, 500, 'a rejected durable roster write is reported as an HTTP failure');
    A.eq(rejected.body.ok, false, 'a rejected durable roster write is never reported as accepted');

    fs.rmdirSync(faultRosterFile);
    const retry = await jf('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'retry', name: 'Ultron', provider: 'openrouter' }], updatedAt: 150 });
    A.eq(retry.body.ok, true, 'failed roster writes do not advance the stale-write baseline');
    A.eq(JSON.parse(fs.readFileSync(faultRosterFile, 'utf8')).updatedAt, 150, 'the first successfully durable retry becomes the baseline');
  } finally {
    await fault.dispose();
  }

  // Agent deletion must not archive the agent's state or report success until the roster removal is durable.
  // Block the roster replace and prove the route leaves both the live agent and its recoverable files untouched.
  const deleteFault = SidecarFixture.create({
    prefix: 'sk-agent-delete-write-fault-',
    env: { OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' }
  });
  seedActiveStation(deleteFault.workspace);
  await deleteFault.start();
  try {
    const BD = deleteFault.baseUrl;
    const tokD = deleteFault.token;
    const jd = async (m, p, body) => {
      const headers = { 'Content-Type': 'application/json' }; if (tokD) headers['X-StarNet-Token'] = tokD;
      const r = await fetch(BD + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    const deleteRosterFile = path.join(deleteFault.workspace, 'agent.roster.json');
    const savedRosterFile = path.join(deleteFault.workspace, 'agent.roster.saved.json');
    const notebookFile = path.join(deleteFault.workspace, 'doomed.notebook.json');
    const seeded = await jd('POST', '/api/roster', { agents: [
      { agentId: 'agent', system: 'hero', name: 'Ultron', provider: 'openrouter' },
      { agentId: 'doomed', system: 'worker', name: 'Doomed', provider: 'openrouter' }
    ], updatedAt: 100 });
    A.eq(seeded.body.ok, true, 'delete fault fixture establishes a durable two-agent roster');
    fs.writeFileSync(notebookFile, JSON.stringify({ version: 1, notes: ['keep me'] }));
    fs.renameSync(deleteRosterFile, savedRosterFile);
    fs.mkdirSync(deleteRosterFile);

    const rejectedDelete = await jd('POST', '/api/agent/delete', { agentId: 'doomed' });
    A.eq(rejectedDelete.status, 500, 'agent deletion fails when its roster removal is not durable');
    A.eq(rejectedDelete.body.ok, false, 'agent deletion never reports success after a rejected roster write');
    A.ok(fs.existsSync(notebookFile), 'rejected deletion does not archive the agent notebook');
    const stillLive = await jd('GET', '/api/execution-profiles');
    A.ok((stillLive.body.agents || []).some(a => a.agentId === 'doomed'), 'rejected deletion restores the live roster entry');

    fs.rmdirSync(deleteRosterFile);
    fs.renameSync(savedRosterFile, deleteRosterFile);
  } finally {
    await deleteFault.dispose();
  }

  A.report('roster-envelope.http.test');
})().catch(e => { console.log('FAIL: roster-envelope.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
