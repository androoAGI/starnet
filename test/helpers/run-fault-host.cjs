'use strict';
/* test/helpers/run-fault-host.cjs — the REAL sidecar with a run fault injected at one of two seams (run-table lane).

   A control file, <workspace>/run-fault.json, arms one fault at a time; with no control file nothing is changed:
     { mode: 'throw-after-start', mark }   the agent loop announces its run (agent.run.start, exactly as loop.js does) and then
                                           THROWS, the way a host failure inside a run does: any run whose messages carry `mark`
     { mode: 'throw-in-queue', streamId }  the conversation queue (overseer.withThread) THROWS as it hands that conversation its
                                           turn, before the run begins: a failure in the queue
   Both seams are wrapped before sidecar/index.js loads (it takes runAgentLoop and makeOverseer at require time); everything
   else is the production wiring, the same pattern as spend-fault-host.cjs. Production code carries no test switch. */
const fs = require('node:fs');
const path = require('node:path');

const SIDECAR = path.resolve(__dirname, '..', '..', 'sidecar');
const control = path.join(process.env.SKYNET_WORKSPACES || process.env.STARNET_WORKSPACES || '.', 'run-fault.json');
function armed() { try { return JSON.parse(fs.readFileSync(control, 'utf8')) || {}; } catch (_) { return {}; } }

const loop = require(path.join(SIDECAR, 'loop.js'));
const realLoop = loop.runAgentLoop;
loop.runAgentLoop = async function (o) {
  const c = armed();
  if (c.mode === 'throw-after-start' && c.mark && JSON.stringify((o && o.messages) || []).includes(c.mark)) {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: o.trigger, model: o.model });
    throw new Error('injected host fault after start');
  }
  return realLoop.apply(this, arguments);
};

const Overseer = require(path.join(SIDECAR, 'overseer.js'));
const realMakeOverseer = Overseer.makeOverseer;
Overseer.makeOverseer = function () {
  const overseer = realMakeOverseer.apply(this, arguments);
  const realWithThread = overseer.withThread;
  overseer.withThread = function (id, fn) {
    return realWithThread.call(this, id, function () {
      const c = armed();
      if (c.mode === 'throw-in-queue' && c.streamId && String(id) === String(c.streamId)) throw new Error('injected fault in the conversation queue');
      return fn.apply(this, arguments);
    });
  };
  return overseer;
};

require(path.join(SIDECAR, 'index.js'));
