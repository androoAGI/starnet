'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory;
  else root.makeRemoteChannels = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function ({ channels, locallyDriven, changed, settled, now = Date.now }) {
  // Mirror only server-owned sessions. Locally watched NDJSON still owns its
  // callbacks, so one token never reaches the COMMS store twice.
  const owned = new Map(), ended = new Map();
  function begin(streamId, runId, startedAt) {
    if (!streamId || !runId || locallyDriven(streamId)) return false;
    if (channels.runIdOf(streamId) !== runId) {
      channels.begin(streamId, startedAt || now()); channels.setRunId(streamId, runId, startedAt || now());
    }
    owned.set(streamId, runId); return true;
  }
  function end(streamId, runId) {
    if (owned.get(streamId) !== runId) return;
    owned.delete(streamId);
    if (!locallyDriven(streamId) && channels.runIdOf(streamId) === runId) { channels.end(streamId); changed(); settled(); }
  }
  function event(name, p) {
    if (!p?.remoteStreamId || !p.remoteLeadRunId || (p.runId && p.runId !== p.remoteLeadRunId)) return;
    const id = p.remoteStreamId, runId = p.remoteLeadRunId;
    if (locallyDriven(id)) return;
    if (name === 'agent.run.end') {
      ended.set(runId, now()); if (ended.size > 200) ended.delete(ended.keys().next().value);
      end(id, runId); return;
    }
    if (!begin(id, runId)) return;
    if (name === 'agent.token') channels.appendToken(id, p.delta || '');
    else if (name === 'agent.tool_call') { channels.setAcc(id, ''); channels.addToolCall(id, p); }
    else if (name === 'agent.tool_result') { channels.addToolResult(id, p); channels.clearPending(id); }
    else if (name === 'permission.prompt') channels.setPending(id, p, now());
    changed();
  }
  function snapshot(value) {
    const live = new Set();
    for (const r of value.runs || []) {
      if ((r.source && r.source !== 'interactive') || !r.streamId || !r.runId || (ended.has(r.runId) && (value.ts || 0) <= ended.get(r.runId))) continue;
      if (begin(r.streamId, r.runId, r.startedAt)) live.add(r.runId);
    }
    for (const [id, runId] of owned) if (!live.has(runId)) end(id, runId);
    for (const p of value.prompts || []) {
      for (const [id, runId] of owned) if (runId === p.runId && !locallyDriven(id)) channels.setPending(id, p, now());
    }
    changed();
  }
  return { event, snapshot };
});
