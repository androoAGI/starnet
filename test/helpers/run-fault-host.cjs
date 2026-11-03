'use strict';
/* test/helpers/run-fault-host.cjs — the REAL sidecar with a run fault injected at one of two seams (run-table lane).

   A control file, <workspace>/run-fault.json, arms one fault at a time; with no control file nothing is changed. A loop mode
   faults the FIRST run a surface itself drives whose conversation carries `mark`, once: never a pass the host makes over that
   run's transcript afterwards (a review, a reflection: they hand the loop no isTask, or come after it). Each run it picks is
   named in <workspace>/run-fault.log ({ mark, mode, runId, agentId } per line), so a test knows the run's id on any surface:
     { mode: 'tag', mark }                 names the run, changes nothing
     { mode: 'throw-before-start', mark }  the agent loop THROWS before it announces its run: a host failure on the way into a run
     { mode: 'throw-after-start', mark }   the agent loop announces its run (agent.run.start, exactly as loop.js does) and then
                                           THROWS, the way a host failure inside a run does
     { mode: 'throw-after-cost', mark }    the REAL loop runs, and THROWS just after its first priced provider call has been booked
                                           on the run's stream (agent.cost): a host failure after money was spent
     { mode: 'throw-in-queue', streamId }  the conversation queue (overseer.withThread) THROWS as it hands that conversation its
                                           turn, before the run begins: a failure in the queue
   Both seams are wrapped before sidecar/index.js loads (it takes runAgentLoop and makeOverseer at require time); everything
   else is the production wiring, the same pattern as spend-fault-host.cjs. Production code carries no test switch. */
const fs = require('node:fs');
const path = require('node:path');

const SIDECAR = path.resolve(__dirname, '..', '..', 'sidecar');
const WORKSPACE = process.env.SKYNET_WORKSPACES || process.env.STARNET_WORKSPACES || '.';
const control = path.join(WORKSPACE, 'run-fault.json');
function armed() { try { return JSON.parse(fs.readFileSync(control, 'utf8')) || {}; } catch (_) { return {}; } }
const picked = new Set();   // marks whose run was already picked: one run per mark

const loop = require(path.join(SIDECAR, 'loop.js'));
const realLoop = loop.runAgentLoop;
loop.runAgentLoop = async function (o) {
  const c = armed();
  const own = !!c.mark && !picked.has(c.mark) && typeof (o && o.isTask) === 'boolean' && JSON.stringify((o && o.messages) || []).includes(c.mark);
  if (!own) return realLoop.apply(this, arguments);
  picked.add(c.mark);
  try { fs.appendFileSync(path.join(WORKSPACE, 'run-fault.log'), JSON.stringify({ mark: c.mark, mode: c.mode, runId: o.runId, agentId: o.agentId }) + '\n'); } catch (_) {}
  if (c.mode === 'throw-before-start') throw new Error('injected host fault before start');
  if (c.mode === 'throw-after-start') {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: o.trigger, model: o.model });
    throw new Error('injected host fault after start');
  }
  if (c.mode === 'throw-after-cost') {
    const emit = o.emit;
    let thrown = false;
    const faulty = Object.assign({}, o, { emit(name, payload) {
      const out = emit(name, payload);
      if (name === 'agent.cost' && !thrown && payload && payload.runId === o.runId) { thrown = true; throw new Error('injected host fault after a paid call'); }
      return out;
    } });
    return realLoop.call(this, faulty);
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
