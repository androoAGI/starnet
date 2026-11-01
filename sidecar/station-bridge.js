'use strict';

/* sidecar/station-bridge.js — ask the live station page to DO a station thing, and wait for its answer.
 *
 * WHY THIS EXISTS: sessions and crew are FRONTEND state. `App.openWorkstream`, `App.summonAgent`,
 * `App.selectAgent` and the workstream list all live in the page and persist through agent.save.json, while
 * agent TOOLS run here in the sidecar. So a tool that wants to open a session cannot just call a function —
 * it has to ask the page. This is that request/response channel, over the SSE hub the page already listens to.
 *
 * ⛔ THE HONESTY RULE THAT SHAPES THE WHOLE FILE: a headless run — cron, Night Shift, a channel message with
 * nobody looking at the station — has NO page attached. Every verb must then FAIL, visibly, with a reason. The
 * failure mode this design exists to prevent is a tool cheerfully reporting "opened a new session" into a
 * transcript when nothing happened, which is exactly the class of lie this product forbids. Silence times out;
 * it never resolves as success.
 *
 * Shape: emit `station.command` { id, verb, args } on the bus → the page runs it and POSTs the outcome to
 * /api/station/ack → we resolve the matching id. One in-flight map, one timeout, no retries (a retried
 * side-effect is a duplicated session).
 */

const DEFAULT_TIMEOUT_MS = 6000;

function makeStationBridge(opts) {
  opts = opts || {};
  const emit = opts.emit || (() => {});
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  // Injected so tests can drive ids without guessing. No clock here on purpose: nothing in this file needs
  // wall time, and a literal Date.now() would make the module non-deterministic for no benefit.
  const newId = opts.newId || (() => require('node:crypto').randomUUID());
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;

  const pending = new Map();   // id -> { resolve, timer, verb, at }

  /* Ask the page to run a verb. Resolves { ok:true, result } or { ok:false, error } — NEVER throws and never
     hangs: an unattended station resolves ok:false once the timeout lapses. `o.timeoutMs` gives one verb a longer wait
     (a provider key the page proves with a live call before it keeps it). */
  function request(verb, args, o) {
    const waitMs = (o && Number(o.timeoutMs)) || timeoutMs;
    const id = String(newId());
    return new Promise(resolve => {
      const settle = out => {
        const entry = pending.get(id);
        if (!entry) return;                 // already settled — a late ack for a timed-out command is dropped
        pending.delete(id);
        try { clearTimer(entry.timer); } catch (_) {}
        resolve(out);
      };
      const timer = setTimer(() => settle({
        ok: false,
        error: 'no station page answered — open StarNet to run station commands',
        verb,
        unattended: true
      }), waitMs);
      // unref so a pending command can never hold the process open at shutdown
      try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (_) {}
      pending.set(id, { resolve: settle, timer, verb });
      try {
        emit('station.command', { id, verb, args: args || {} });
      } catch (e) {
        settle({ ok: false, error: 'could not reach the station page: ' + ((e && e.message) || e), verb });
      }
    });
  }

  /* The page reporting back. Returns whether the id was still in flight, so the route can answer honestly
     rather than pretending an unknown ack mattered. */
  function ack(id, outcome) {
    const entry = pending.get(String(id || ''));
    if (!entry) return false;
    const out = outcome && typeof outcome === 'object' ? outcome : {};
    entry.resolve(out.ok
      ? { ok: true, result: out.result === undefined ? null : out.result, verb: entry.verb }
      : { ok: false, error: String(out.error || 'the station refused the command'), verb: entry.verb });
    return true;
  }

  function inFlight() { return pending.size; }

  return { request, ack, inFlight };
}

module.exports = { makeStationBridge, DEFAULT_TIMEOUT_MS };
