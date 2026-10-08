/* sidecar/execution-router.js — per-agent execution backend routing.

   Execution profiles are per agent, while the original environment manager was selected once at boot.
   This facade keeps the manager contract intact and routes every operation by agent id, so choosing Safe
   Cell changes the next real command to Docker immediately instead of merely painting a requested backend.

   A requested sandbox is HONORED or REFUSED, never faked. resolveBackend() returns the full resolution
   ({ id, requested, matched, reason }); when the requested backend (docker for Safe Cell, ssh for Remote SSH)
   is not registered, `matched` is false. Under the default policy (STARNET_SANDBOX_FALLBACK=refuse) forAgent()
   then hands back a REFUSING proxy: describe/status/workspace methods still answer, but every execute-class
   method rejects with a typed { code:'sandbox_unavailable' } error that the tools surface as a precondition.
   STARNET_SANDBOX_FALLBACK=allow keeps the old silent-local behaviour, but describeAgent still reports
   backendMatched:false so the UI can never claim a sandbox the harness is not running.
*/
'use strict';
const { swallow } = require('./failopen.js');

function makeExecutionRouter(deps) {
  deps = deps || {};
  const environments = deps.environments || {};
  const defaultBackendId = String(deps.defaultBackendId || 'local');
  const profileForAgent = typeof deps.profileForAgent === 'function' ? deps.profileForAgent : (() => 'station-gear');
  const forceLocalForAgent = typeof deps.forceLocalForAgent === 'function' ? deps.forceLocalForAgent : (() => false);
  if (!environments[defaultBackendId]) throw new Error('execution router missing default backend "' + defaultBackendId + '"');

  const envSrc = deps.env || process.env;
  const fallbackPolicy = String(deps.sandboxFallback || envSrc.STARNET_SANDBOX_FALLBACK || envSrc.SKYNET_SANDBOX_FALLBACK || 'refuse')
    .trim().toLowerCase() === 'allow' ? 'allow' : 'refuse';

  // A registered manager is not the same as a usable one: the sidecar registers local+docker+ssh at boot
  // regardless of what the machine has. The manager's own describe().availability is the probe truth
  // (docker: runtimeStatus after the first container attempt; ssh: configuration-required / unavailable).
  function availabilityOf(backendId, agentId) {
    const env = environments[backendId];
    if (!env) return { state: 'absent', error: null };
    try {
      const d = env.describe(agentId) || {};
      const a = d.availability || {};
      return { state: String(a.state || 'unknown'), error: a.error ? String(a.error) : null };
    } catch (_) { return { state: 'unknown', error: null }; }
  }
  const UNUSABLE = { absent: true, unavailable: true, 'configuration-required': true };
  function resolveBackend(profileId, agentId) {
    profileId = String(profileId || 'station-gear');
    const want = profileId === 'safe-cell' ? 'docker' : profileId === 'remote-ssh' ? 'ssh'
      : (profileId === 'trusted-project' || profileId === 'this-computer') ? 'local' : defaultBackendId;
    const avail = availabilityOf(want, agentId);
    if (!UNUSABLE[avail.state]) return { id: want, requested: want, matched: true, reason: null, profileId, availability: avail.state };
    const reason = avail.state === 'absent'
      ? (want === 'docker' ? 'Docker is not available on this machine' : want === 'ssh' ? 'no SSH execution backend is configured' : 'the ' + want + ' execution backend is not registered')
      : avail.state === 'configuration-required'
        ? 'no SSH target is configured for this agent'
        : (want === 'docker' ? 'Docker is not available on this machine' : want === 'ssh' ? 'the SSH host is unreachable' : 'the ' + want + ' backend is unavailable')
          + (avail.error ? ' (' + avail.error + ')' : '');
    // Unregistered, or a registered sandbox under 'allow': the command would run on the default host.
    // A registered-but-unavailable sandbox under 'refuse' keeps its real id so every docker-only gate in
    // the sidecar (stdio MCP, isolation) still sees the truth; the honest proxy retries the probe on use.
    const id = (avail.state === 'absent' || fallbackPolicy === 'allow') ? defaultBackendId : want;
    return { id, requested: want, matched: false, reason, profileId, availability: avail.state };
  }
  function backendForProfile(profileId) { return resolveBackend(profileId).id; }
  function resolutionFor(agentId) {
    const id = String(agentId || 'agent');
    try {
      if (environments.local && forceLocalForAgent(id) === true) {
        return { id: 'local', requested: 'local', matched: true, reason: null, profileId: String(profileForAgent(id) || 'station-gear'), forcedLocal: true, availability: 'ready' };
      }
    } catch (_) {}
    return resolveBackend(profileForAgent(id), id);
  }
  function backendIdFor(agentId) { return resolutionFor(agentId).id; }
  function sandboxError(res) {
    const label = res.profileId === 'safe-cell' ? 'SAFE CELL' : res.profileId === 'remote-ssh' ? 'REMOTE SSH' : res.profileId;
    const fix = res.requested === 'docker' ? "Start Docker, or change the agent's execution profile."
      : res.requested === 'ssh' ? "Configure an SSH target, or change the agent's execution profile."
      : "Change the agent's execution profile.";
    const e = new Error("This agent's profile is " + label + ' but ' + res.reason + '. ' + fix + ' The command was NOT run on this computer.');
    e.code = 'sandbox_unavailable';
    e.requested = res.requested;
    e.reason = res.reason;
    e.profileId = res.profileId;
    e.precondition = { code: 'sandbox_unavailable', requiredState: res.requested + '_backend_available', requiredAction: 'start_' + res.requested + '_or_change_execution_profile' };
    return e;
  }
  // Execute-class methods: anything that would run a command (or push a workspace) on the fallback host.
  const EXECUTE_METHODS = ['execute', 'startBackground', 'spawnStdio', 'ensureReady', 'syncWorkspace'];
  const refusingCache = new Map();
  // The requested sandbox is not there at all (or would silently become the host): every execute-class
  // call rejects up front. Nothing is spawned.
  function refusingProxy(real, res) {
    const key = 'refuse|' + res.requested + '|' + res.profileId;
    if (refusingCache.has(key)) return refusingCache.get(key);
    const proxy = Object.create(real);
    // Sync methods (spawnStdio) throw; promise-returning ones reject. Nothing is ever spawned.
    for (const m of EXECUTE_METHODS) proxy[m] = m === 'spawnStdio' ? (() => { throw sandboxError(res); }) : (() => Promise.reject(sandboxError(res)));
    proxy.sandboxUnavailable = Object.freeze({ requested: res.requested, reason: res.reason, profileId: res.profileId });
    proxy.describe = (agentId) => Object.assign({}, real.describe(agentId), { sandboxUnavailable: proxy.sandboxUnavailable });
    refusingCache.set(key, proxy);
    return proxy;
  }
  // The requested sandbox IS registered (docker/ssh managers always are): let the manager try for real —
  // that is the probe — and if it fails while its own availability says unusable, surface the typed
  // refusal instead of a raw spawn error. Docker started later is honored on the next call, no restart.
  function honestProxy(real, backendId, profileId) {
    const key = 'honest|' + backendId + '|' + profileId;
    if (refusingCache.has(key)) return refusingCache.get(key);
    const proxy = Object.create(real);
    for (const m of EXECUTE_METHODS) {
      proxy[m] = function () {
        const args = Array.prototype.slice.call(arguments);
        const agentId = args[0] && typeof args[0] === 'object' ? args[0].agentId : args[0];
        const retype = e => {
          const res = resolveBackend(profileId, agentId);
          if (res.matched !== false) return e;
          const typed = sandboxError(res);
          typed.cause = e;
          return typed;
        };
        let out;
        try { out = real[m].apply(real, args); } catch (e) { throw retype(e); }
        return out && typeof out.then === 'function' ? out.catch(e => { throw retype(e); }) : out;
      };
    }
    refusingCache.set(key, proxy);
    return proxy;
  }
  // Tools ask this BEFORE checkpointing or touching cwd: a typed error when the command would run somewhere
  // other than the requested sandbox under 'refuse', else null. A registered-but-unprobed docker/ssh is
  // NOT refused here — the honest proxy must attempt it so a sandbox that comes up later is honored.
  function refusalFor(agentId) {
    const res = resolutionFor(agentId);
    if (fallbackPolicy !== 'refuse' || res.forcedLocal || res.matched !== false || res.id === res.requested) return null;
    return sandboxError(res);
  }
  function forAgent(agentId) {
    const res = resolutionFor(agentId);
    const real = environments[res.id] || environments[defaultBackendId];
    if (fallbackPolicy !== 'refuse' || res.forcedLocal || res.requested === 'local') return real;
    if (res.matched === false && res.id !== res.requested) return refusingProxy(real, res);
    if (res.requested !== 'local' && res.requested !== defaultBackendId) return honestProxy(real, res.id, res.profileId);
    return real;
  }
  function fromOpts(opts) { return forAgent(opts && opts.agentId); }
  function describeAgent(agentId) {
    const res = resolutionFor(agentId);
    const backend = forAgent(agentId);
    const effectiveBackend = String(backend.backendId || backend.id || res.id);
    return Object.assign({}, backend.describe(agentId), {
      routed: true,
      executionProfile: String(profileForAgent(String(agentId || 'agent')) || 'station-gear'),
      effectiveBackend,
      requestedBackend: res.requested,
      backendMatched: res.matched !== false,
      mismatchReason: res.matched === false ? res.reason : null,
      sandboxFallback: fallbackPolicy,
      refusing: res.matched === false && fallbackPolicy === 'refuse'
    });
  }
  function describe() {
    const base = Object.assign({}, environments[defaultBackendId].describe());
    base.routing = {
      perAgent: true,
      defaultBackend: defaultBackendId,
      availableBackends: Object.keys(environments).filter(id => environments[id]),
      sandboxFallback: fallbackPolicy
    };
    return base;
  }
  function callAgent(method, agentId, rest) {
    const env = forAgent(agentId);
    return env[method].apply(env, [agentId].concat(rest || []));
  }
  function killAllBackground(agentId) {
    if (agentId != null) return callAgent('killAllBackground', agentId, []);
    let count = 0;
    const seen = new Set();
    for (const [id, env] of Object.entries(environments)) {
      if (!env || seen.has(env) || typeof env.killAllBackground !== 'function') continue;
      seen.add(env);
      const r = env.killAllBackground();
      // an async reap (SSH round-trips) is dispatched, not proven: never counted, and its failure is a
      // tagged note — not a process-level unhandledRejection the halt/shutdown callers can't catch.
      if (r && typeof r.then === 'function') { r.then(null, swallow('execution.killAll.' + id)); continue; }
      count += Number(r) || 0;
    }
    return count;
  }

  const api = {
    id: 'router',
    supports: environments[defaultBackendId].supports,
    describe,
    describeAgent,
    backendIdFor,
    backendIdForProfile: backendForProfile,
    resolveBackend,
    resolutionFor,
    refusalFor,
    sandboxFallback: fallbackPolicy,
    forAgent,
    ensureReady: agentId => callAgent('ensureReady', agentId, []),
    cleanupAgent: (agentId, opts) => callAgent('cleanupAgent', agentId, [opts]),
    cleanupIdle: (agentIds, opts) => environments.docker && typeof environments.docker.cleanupIdle === 'function'
      ? environments.docker.cleanupIdle(agentIds, opts)
      : Promise.resolve({ ok: true, enabled: false, checked: 0, stopped: [], skipped: [] }),
    syncWorkspace: (agentId, opts) => callAgent('syncWorkspace', agentId, [opts]),
    invalidateAgent: agentId => callAgent('invalidateAgent', agentId, []),
    workspaceRoot: agentId => callAgent('workspaceRoot', agentId, []),
    ensureWorkspace: agentId => callAgent('ensureWorkspace', agentId, []),
    getCwd: agentId => callAgent('getCwd', agentId, []),
    rememberCwd: (agentId, cwd) => callAgent('rememberCwd', agentId, [cwd]),
    execute: opts => fromOpts(opts).execute(opts),
    startBackground: opts => fromOpts(opts).startBackground(opts),
    statusBackground: (agentId, bgId) => callAgent('statusBackground', agentId, [bgId]),
    readBackground: (agentId, bgId, opts) => callAgent('readBackground', agentId, [bgId, opts]),
    writeBackground: (agentId, bgId, opts) => callAgent('writeBackground', agentId, [bgId, opts]),
    closeBackgroundStdin: (agentId, bgId) => callAgent('closeBackgroundStdin', agentId, [bgId]),
    killBackground: (agentId, bgId) => callAgent('killBackground', agentId, [bgId]),
    // null when the agent's backend has no event-driven wait: the shell.bg.wait tool falls back to polling status
    waitBackground: (agentId, bgId, opts) => {
      const env = forAgent(agentId);
      return env && typeof env.waitBackground === 'function' ? env.waitBackground(agentId, bgId, opts) : null;
    },
    spawnStdio: opts => fromOpts(opts).spawnStdio(opts),
    killAllBackground,
    _environments: environments
  };
  Object.defineProperty(api, 'backendId', { enumerable: true, get: () => defaultBackendId });
  return api;
}

module.exports = { makeExecutionRouter };
