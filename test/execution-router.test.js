'use strict';
const A = require('./_assert.js');
const { makeExecutionRouter } = require('../sidecar/execution-router.js');

const profiles = { legacy: 'station-gear', safe: 'safe-cell', remote: 'remote-ssh', trusted: 'trusted-project', host: 'this-computer' };
function fake(id) {
  return {
    id, backendId: id, supports: { hostileCodeSandbox: id === 'docker' },
    describe: () => ({ backend: id, availability: { state: id === 'docker' ? 'unknown' : 'ready' } }),
    ensureReady: agentId => Promise.resolve({ ok: true, backend: id, agentId }),
    cleanupAgent: (agentId, opts) => Promise.resolve({ ok: true, backend: id, agentId, opts }),
    cleanupIdle: (agentIds, opts) => Promise.resolve({ ok: true, backend: id, agentIds, opts }),
    syncWorkspace: (agentId, opts) => Promise.resolve({ ok: true, backend: id, agentId, opts }),
    invalidateAgent: agentId => ({ ok: true, backend: id, agentId }),
    workspaceRoot: agentId => id + ':root:' + agentId,
    ensureWorkspace: agentId => id + ':workspace:' + agentId,
    getCwd: agentId => id + ':cwd:' + agentId,
    rememberCwd: (agentId, cwd) => id + ':remember:' + agentId + ':' + cwd,
    execute: opts => Promise.resolve({ backend: id, opts }),
    startBackground: opts => ({ ok: true, backend: id, opts }),
    statusBackground: (agentId, bgId) => ({ backend: id, agentId, bgId }),
    readBackground: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    writeBackground: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    closeBackgroundStdin: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    killBackground: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    spawnStdio: opts => ({ backend: id, opts }),
    killAllBackground: () => 1
  };
}
const local = fake('local'), docker = fake('docker'), ssh = fake('ssh');
const router = makeExecutionRouter({
  environments: { local, docker, ssh }, defaultBackendId: 'local',
  profileForAgent: agentId => profiles[agentId] || 'station-gear'
});
let fullPower = false;
const fullPowerRouter = makeExecutionRouter({
  environments: { local, docker, ssh }, defaultBackendId: 'local',
  profileForAgent: agentId => profiles[agentId] || 'station-gear',
  forceLocalForAgent: () => fullPower
});

A.eq(router.backendId, 'local', 'legacy backendId remains the station default for old callers');
A.eq(router.backendIdFor('legacy'), 'local', 'compatibility profile follows the station default');
A.eq(router.backendIdFor('safe'), 'docker', 'Safe Cell routes to Docker immediately');
A.eq(router.backendIdFor('remote'), 'ssh', 'Remote SSH routes to SSH immediately');
A.eq(router.backendIdFor('trusted'), 'local', 'Trusted Project routes local');
A.eq(router.backendIdFor('host'), 'local', 'This Computer routes local');
A.eq(fullPowerRouter.backendIdFor('safe'), 'docker', 'restricted Safe Cell begins in Docker');
fullPower = true;
A.eq(fullPowerRouter.backendIdFor('safe'), 'local', 'Full Power immediately routes a Safe Cell agent onto this computer');
A.eq(fullPowerRouter.ensureWorkspace('remote'), 'local:workspace:remote', 'Full Power routes host work locally even when the stored profile is SSH');
fullPower = false;
A.eq(fullPowerRouter.backendIdFor('safe'), 'docker', 'revoking Full Power restores the stored profile immediately');
A.eq(router.forAgent('safe').supports.hostileCodeSandbox, true, 'authority can inspect the selected isolated environment');
A.eq(router.ensureWorkspace('safe'), 'docker:workspace:safe', 'workspace calls route by agent');
A.eq(router.getCwd('trusted'), 'local:cwd:trusted', 'cwd calls route by agent');
router.execute({ agentId: 'safe', cmd: 'x' }).then(async result => {
  A.eq(result.backend, 'docker', 'foreground execution uses the profile backend');
  A.eq(router.startBackground({ agentId: 'trusted', cmd: 'x' }).backend, 'local', 'background execution uses the profile backend');
  A.eq(router.statusBackground('safe', 'bg_1').backend, 'docker', 'background inspection uses the profile backend');
  A.eq(router.spawnStdio({ agentId: 'safe', command: 'node' }).backend, 'docker', 'stdio MCP spawn routes through the selected agent environment');
  const synced = await router.syncWorkspace('remote', { direction: 'push' });
  A.eq(synced.backend, 'ssh', 'workspace synchronization routes through the remote agent environment');
  A.eq(router.describeAgent('safe').effectiveBackend, 'docker', 'per-agent runtime truth names Docker');
  A.eq(router.describe().routing.perAgent, true, 'station execution status exposes dynamic routing');
  A.eq(router.killAllBackground(), 3, 'station halt reaches every distinct backend');

  // ---- an ASYNC backend reap (SSH) is dispatched, never an unhandledRejection (customer diagnostics 10-07) ----
  const unhandled = [];
  const onUnhandled = e => unhandled.push(String((e && e.message) || e));
  process.on('unhandledRejection', onUnhandled);
  try {
    let sshAsked = 0;
    const rejectingSsh = Object.assign(fake('ssh'), { killAllBackground: () => { sshAsked++; return Promise.reject(new Error('SSH target is not configured for agent')); } });
    const asyncRouter = makeExecutionRouter({ environments: { local: fake('local'), docker: fake('docker'), ssh: rejectingSsh }, defaultBackendId: 'local', profileForAgent: agentId => profiles[agentId] || 'station-gear' });
    A.eq(asyncRouter.killAllBackground(), 2, 'the synchronous count covers only the proven local/docker kills');
    A.eq(sshAsked, 1, 'the async backend is still asked to reap');
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    A.eq(unhandled.length, 0, 'a rejecting async reap is caught by the router, not left to the process');

    // real wiring: the actual three managers a no-SSH station registers (a sync fake hid the async shape once)
    const fs = require('fs'), os = require('os'), path = require('path');
    const { makeEnvironmentManager } = require('../sidecar/environment.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-router-'));
    try {
      const noSpawn = () => { throw new Error('a no-SSH station halt must not spawn anything'); };
      const realDeps = { spawn: noSpawn, fs, pathMod: path, root, env: {}, sshConfig: () => null };
      const real = makeExecutionRouter({
        environments: {
          local: makeEnvironmentManager(Object.assign({}, realDeps, { config: { backend: 'local' } })),
          docker: makeEnvironmentManager(Object.assign({}, realDeps, { config: { backend: 'docker' } })),
          ssh: makeEnvironmentManager(Object.assign({}, realDeps, { config: { backend: 'ssh' } }))
        },
        defaultBackendId: 'local', profileForAgent: () => 'station-gear', env: {}
      });
      let threw = null, n = null;
      try { n = real.killAllBackground(); } catch (e) { threw = e; }
      A.eq(threw, null, 'E-STOP fan-out over the real managers does not throw');
      A.eq(n, 0, 'nothing to reap on a fresh no-SSH station');
      await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
      A.eq(unhandled.length, 0, 'real local+docker+ssh managers with no SSH target: zero unhandled rejections on halt');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  } finally { process.removeListener('unhandledRejection', onUnhandled); }

  // ---- Lane C: a requested sandbox is honored or refused, never faked ----
  const noDocker = makeExecutionRouter({ environments: { local }, defaultBackendId: 'local', profileForAgent: agentId => profiles[agentId] || 'station-gear', env: {} });
  const safeRes = noDocker.resolutionFor('safe');
  A.eq(safeRes.matched, false, 'safe-cell with no docker resolves matched:false');
  A.eq(safeRes.requested, 'docker', 'resolution names the requested backend');
  A.eq(safeRes.id, 'local', 'resolution still names where the command WOULD run');
  A.ok(/Docker is not available/.test(safeRes.reason), 'resolution carries a human reason');
  A.eq(noDocker.backendIdFor('safe'), 'local', 'backendIdFor keeps returning an id for old callers');
  A.eq(noDocker.sandboxFallback, 'refuse', 'default policy is refuse');
  let refused = null;
  try { await noDocker.forAgent('safe').execute({ agentId: 'safe', cmd: 'echo hi' }); } catch (e) { refused = e; }
  A.ok(refused && refused.code === 'sandbox_unavailable', 'execute under default policy rejects sandbox_unavailable');
  A.eq(refused.requested, 'docker', 'typed error names the requested backend');
  A.eq(refused.precondition.code, 'sandbox_unavailable', 'typed error carries a tool precondition');
  A.ok(/SAFE CELL/.test(refused.message) && /Start Docker/.test(refused.message), 'copy names the profile and the fix');
  let refusedBg = null;
  try { await noDocker.startBackground({ agentId: 'safe', cmd: 'x' }); } catch (e) { refusedBg = e; }
  A.eq(refusedBg && refusedBg.code, 'sandbox_unavailable', 'background start refuses too');
  let refusedStdio = null;
  try { noDocker.spawnStdio({ agentId: 'safe', command: 'node' }); } catch (e) { refusedStdio = e; }
  A.eq(refusedStdio && refusedStdio.code, 'sandbox_unavailable', 'stdio spawn refuses synchronously');
  A.eq(noDocker.forAgent('safe').getCwd('safe'), 'local:cwd:safe', 'describe/status-class methods still answer on the refusing proxy');
  A.eq(noDocker.forAgent('safe').describe().sandboxUnavailable.requested, 'docker', 'refusing proxy describes the missing sandbox');
  const d = noDocker.describeAgent('safe');
  A.eq(d.requestedBackend, 'docker', 'describeAgent carries requestedBackend');
  A.eq(d.backendMatched, false, 'describeAgent carries backendMatched:false');
  A.ok(/Docker/.test(d.mismatchReason), 'describeAgent carries mismatchReason');
  A.eq(d.refusing, true, 'describeAgent says the router is refusing');
  A.eq(noDocker.describeAgent('trusted').backendMatched, true, 'trusted-project unaffected');
  A.eq((await noDocker.execute({ agentId: 'trusted', cmd: 'x' })).backend, 'local', 'trusted-project still executes');
  A.eq((await noDocker.execute({ agentId: 'host', cmd: 'x' })).backend, 'local', 'this-computer still executes');
  A.eq((await noDocker.execute({ agentId: 'legacy', cmd: 'x' })).backend, 'local', 'station-gear still executes');
  let refusedSsh = null;
  try { await noDocker.execute({ agentId: 'remote', cmd: 'x' }); } catch (e) { refusedSsh = e; }
  A.eq(refusedSsh && refusedSsh.requested, 'ssh', 'remote-ssh without ssh refuses the same way');
  A.eq(noDocker.describeAgent('remote').backendMatched, false, 'remote-ssh mismatch is reported');

  const allowRouter = makeExecutionRouter({ environments: { local }, defaultBackendId: 'local', profileForAgent: agentId => profiles[agentId] || 'station-gear', env: { STARNET_SANDBOX_FALLBACK: 'allow' } });
  A.eq((await allowRouter.execute({ agentId: 'safe', cmd: 'x' })).backend, 'local', 'allow policy runs the command locally');
  A.eq(allowRouter.describeAgent('safe').backendMatched, false, 'allow policy still reports backendMatched:false');
  A.eq(allowRouter.describeAgent('safe').refusing, false, 'allow policy is not refusing');

  // registered-but-unavailable docker (the real sidecar registers all three managers): the manager's own
  // availability is the truth, and a failing attempt becomes the typed refusal instead of a raw spawn error.
  const dockerState = { state: 'unknown', error: null };
  const flakyDocker = Object.assign(fake('docker'), {
    describe: () => ({ backend: 'docker', availability: dockerState }),
    execute: () => { dockerState.state = 'unavailable'; dockerState.error = 'docker: command not found'; return Promise.reject(new Error('could not create persistent Docker environment')); }
  });
  const probed = makeExecutionRouter({ environments: { local, docker: flakyDocker }, defaultBackendId: 'local', profileForAgent: agentId => profiles[agentId] || 'station-gear', env: {} });
  A.eq(probed.resolutionFor('safe').matched, true, 'an unprobed docker is trusted until it fails');
  A.eq(probed.backendIdFor('safe'), 'docker', 'and routes to docker');
  let probedErr = null;
  try { await probed.execute({ agentId: 'safe', cmd: 'x' }); } catch (e) { probedErr = e; }
  A.eq(probedErr && probedErr.code, 'sandbox_unavailable', 'a failed docker attempt surfaces as sandbox_unavailable');
  A.ok(/docker: command not found/.test(probedErr.message), 'the manager error rides in the reason');
  A.eq(probed.resolutionFor('safe').matched, false, 'after the probe the resolution reports the mismatch');
  A.eq(probed.backendIdFor('safe'), 'docker', 'a probed-unavailable docker keeps its id (docker-only gates stay honest), never local');
  A.eq(probed.describeAgent('safe').backendMatched, false, 'UI truth follows');
  dockerState.state = 'ready'; dockerState.error = null;
  A.eq(probed.resolutionFor('safe').matched, true, 'Docker coming up later is honored without a restart');
  A.report('execution-router.test');
}).catch(e => { console.error(e); process.exitCode = 1; });
