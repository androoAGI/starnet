'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// The same pure Workstreams and station-command implementation used by the Mac,
// evaluated without a DOM, browser, canvas, timers driving a world, or renderer.
// Commands are serialized and commit through the existing revision-checked store.
function makeHeadlessStation({ saveStore, roster, runs, activeRuns, degraded = () => false }) {
  const workstreams = fs.readFileSync(path.join(__dirname, '../frontend/app/workstreams.js'), 'utf8');
  const commands = fs.readFileSync(path.join(__dirname, '../frontend/app/stationcommands.js'), 'utf8');
  let queue = Promise.resolve();
  async function execute(verb, args) {
    const saved = saveStore.load('agent');
    if (!saved?.agent) return { ok: false, error: 'Create your station on the Mac first' };
    if (degraded()) return { ok: false, error: 'Station storage requires recovery' };
    let current = saved, acknowledged = null;
    const context = vm.createContext({ console, Date, JSON, setTimeout, clearTimeout,
      document: { addEventListener() {} }, U: { bus: { on() {} } },
      App: {
        agents: () => Array.from(roster().values()).map(a => ({ ...a, id: a.agentId || a.id })),
        refreshRail() {},
        persist: () => {
          const slice = context.Workstreams.serialize();
          const result = saveStore.save('agent', { ...current, ...JSON.parse(JSON.stringify(slice)), updatedAt: Date.now() }, { compareRevision: true });
          if (!result.ok) throw new Error('Station changed concurrently; mutation was refused');
          current = saveStore.load('agent');
        }
      },
      CloudSave: { flush: async () => true, pull: async () => saveStore.load('agent') },
      // Focus is a Mac intent and requires live draft/call state. Do not guess it
      // from a cached save or let background agents steal the current view.
      Chat: { load() {}, canFocusSession: () => false },
      Channels: {
        isBusy: id => Array.from(activeRuns().values()).some(r => r.streamId === id),
        begin() {}, setRunId() {}, setStatus() {}, end() {}
      },
      fetch: async (url, options) => {
        if (url.startsWith('/api/runs')) return { ok: true, json: async () => ({ runs: runs() }) };
        if (url === '/api/station/ack') { acknowledged = JSON.parse(options.body); return { ok: true }; }
        throw new Error('Unsupported headless station request');
      }
    });
    vm.runInContext(workstreams, context, { filename: 'workstreams.js', timeout: 1000 });
    context.Workstreams.init(JSON.parse(JSON.stringify(saved)));
    const api = vm.runInContext(commands + '\n;StationCommands;', context, { filename: 'stationcommands.js', timeout: 1000 });
    await api.run(crypto.randomUUID(), verb, args || {});
    return acknowledged || { ok: false, error: 'Station command did not acknowledge' };
  }
  return {
    request(verb, args) {
      const result = queue.then(() => execute(verb, args)).catch(e => ({ ok: false, error: e.message }));
      queue = result.then(() => undefined); return result;
    },
    ack: () => false,
    inFlight: () => 0
  };
}

// A bounded stream sink is independent of the watcher. The sidecar's run maps,
// cancellation controller, durable transcripts and recovery stores keep ownership.
function makeRunStream({ res, controller, persistent, emitRemote, redact, onDisconnect }) {
  let attached = true;
  const detach = () => {
    if (!attached) return;
    attached = false;
    if (!persistent) controller.abort();
    onDisconnect?.();
  };
  res.once('close', detach);
  res.once('error', detach);
  return {
    emit(name, payload) {
      const clean = redact(payload);
      if (persistent) emitRemote(name, clean);
      if (attached && !res.destroyed && !res.writableEnded) {
        try {
          res.write(JSON.stringify({ name, payload: clean }) + '\n');
          if (res.writableLength > 1024 * 1024) { detach(); res.destroy(); }
        } catch (_) { detach(); }
      }
    },
    attached: () => attached
  };
}

// Claim request IDs before execution. Never retain prompts or credentials here.
// A crash leaves a claimed request fenced; explicit recovery creates a new ID.
function makeRequestClaims(root) {
  const dir = path.join(root, '.remote-requests');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    claim(id, runId) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(id)) throw new Error('A unique requestId is required for a remote run');
      const file = path.join(dir, id + '.json');
      let fd;
      try { fd = fs.openSync(file, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let existing = null;
        try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
        return { ok: false, runId: existing?.runId || null };
      }
      try { fs.writeFileSync(fd, JSON.stringify({ runId, createdAt: Date.now() })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      const directory = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return { ok: true, runId };
    }
  };
}
module.exports = { makeHeadlessStation, makeRunStream, makeRequestClaims };
