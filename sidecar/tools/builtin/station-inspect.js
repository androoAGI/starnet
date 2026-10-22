/* sidecar/tools/builtin/station-inspect.js — the agent's read-only view of its own harness.

   This is local telemetry, not new authority: it cannot mutate the station, reach the network,
   read files, or reveal credentials. The injected snapshot reader is the same authority used by
   the UI status routes. */
'use strict';

function makeStationInspectTool(deps) {
  deps = deps || {};
  const inspect = typeof deps.inspect === 'function' ? deps.inspect : null;
  const tool = {
    name: 'station.inspect', capability: 'stationinfo', scope: 'read', requiresConsent: false, timeoutMs: 3000,
    description: 'Inspect Agent OS itself before answering questions about the live harness: exact app/harness build, '
      + 'this run identity, scheduler health and routine count, connected MCP connectors, and recorded diagnostic '
      + 'errors. This is the authoritative current snapshot; call it instead of guessing, inventing a CLI command, '
      + 'or asking for FILES/TERMINAL. Read-only, local, consent-free, and secret-free.',
    schema: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      if (!inspect) return { content: JSON.stringify({ schemaVersion: 1, status: 'unavailable', reason: 'harness snapshot reader is not wired' }), summary: 'harness state unavailable' };
      let out;
      try { out = await inspect(ctx || {}); }
      catch (e) { out = { schemaVersion: 1, status: 'unavailable', reason: String((e && e.message) || e || 'snapshot failed') }; }
      const sections = ['build', 'runtime', 'scheduler', 'connectors', 'diagnostics'];
      const unavailable = sections.filter(name => !out || !out[name] || out[name].status !== 'confirmed');
      return {
        content: JSON.stringify(out || { schemaVersion: 1, status: 'unavailable' }),
        summary: unavailable.length ? 'harness snapshot; unavailable: ' + unavailable.join(', ') : 'harness snapshot confirmed'
      };
    }
  };
  return { tool, register(reg) { reg.register(tool); return reg; } };
}

module.exports = { makeStationInspectTool };
