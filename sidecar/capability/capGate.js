/* sidecar/capability/capGate.js — enforcement helpers over a resolved capability set.
   canAgentUse(resolved, toolName) — is this tool granted right now?
   attenuate(resolved, allowedSubset) — a delegated worker's tools = resolved ∩ subset (never the
     union; monotonic attenuation makes the room layout a hard authority ceiling).
   makeCapCtx(resolved, extra) — builds the capCtx the loop/dispatch consume: canRun() is the
     COMPUTE GATE (a model turn needs a computer in the room); canUse(call) gates each tool. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.capability = root.SK.capability || {}).capGate = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function canAgentUse(resolved, toolName) {
    if (!resolved) return { ok: false, reason: 'no resolved capabilities' };
    if (resolved.tools.indexOf(toolName) >= 0) return { ok: true };
    return { ok: false, reason: 'no capability for ' + toolName + (resolved.room ? ' in room ' + resolved.room : '') };
  }

  function attenuate(resolved, allowedSubset) {
    const allow = allowedSubset instanceof Set ? allowedSubset : new Set(allowedSubset || []);
    // `deferred` is filtered by the SAME subset as `tools`, and that is load-bearing: it is the list
    // tool.search offers, so an unfiltered copy would let a delegated worker discover — and be told it may now
    // call — a tool the gate then denies. Monotonic attenuation has to hold for what the agent can FIND, not
    // just for what it may run.
    return Object.assign({}, resolved, {
      tools: resolved.tools.filter(t => allow.has(t)),
      deferred: (resolved.deferred || []).filter(t => allow.has(t))
    });
  }

  function makeCapCtx(resolved, extra) {
    return Object.assign({
      agentId: resolved.agentId,
      room: resolved.room,
      canRun: () => !!resolved.hasCompute,
      computeReason: 'no compute capability — place a computer in the room',
      canUse: (call) => canAgentUse(resolved, call.name),
      approvalRules: resolved.approvalRules,
      deferred: resolved.deferred || [],   // granted-but-unadvertised names; tool.search searches exactly this
      unavailable: resolved.unavailable || {},   // deferred names the host PROVED cannot work this run -> { why, enable }; tool.search says so
      withheld: resolved.withheld || {}   // floor-granted names the run authority removed this run -> { why, enable } (issue #77); tool.search says so
    }, extra || {});
  }

  return { canAgentUse, attenuate, makeCapCtx };
});
