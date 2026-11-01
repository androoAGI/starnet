/* test/channels.sse.test.js — the SSE fan-out that forwards channel/work-item telemetry to the
   live station HUD. Pure + headless: a "client" is any object with .write(string); we drive it
   with a fake res (no node:http, no socket). Guards the two things that matter — every client gets
   each event, and disconnected/dead clients are removed so the Set never leaks.
   ALSO (G2.1): the runTeeView egress policy for broadcast-opted server-initiated runs — every
   agent.tool_call tees NAME-ONLY (args stripped structurally), agent.token never tees. */
'use strict';
const { readSidecarSource, sidecarFunctionSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeSseHub, runTeeView, formatKeepalive } = require('../sidecar/channels/sse.js');

// Minimal WHATWG SSE message extraction for the keepalive contract: comments are ignored and
// only one or more `data:` fields produce a browser-visible MessageEvent. This is the exact seam
// behind the healthy-idle LINK DOWN escape: TCP bytes in a comment keep the socket alive, but an
// EventSource listener never learns that those bytes arrived.
function eventDataOf(frame) {
  const data = [];
  for (const line of String(frame || '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep < 0 ? line : line.slice(0, sep);
    let value = sep < 0 ? '' : line.slice(sep + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }
  return data.length ? data.join('\n') : null;
}

// Escape-first proof: the old comment is invisible to EventSource.onmessage, while the channel
// keepalive must be a harmless data frame so world.js can refresh its last-byte clock without
// synthesizing a product event on U.bus.
A.eq(eventDataOf(': ka\n\n'), null, 'an SSE comment cannot satisfy a JavaScript message listener');
const keepaliveFrame = formatKeepalive();
A.eq(eventDataOf(keepaliveFrame), '{}', 'the channel keepalive dispatches one empty JSON MessageEvent');
const keepalivePayload = JSON.parse(eventDataOf(keepaliveFrame));
A.ok(!('name' in keepalivePayload), 'the keepalive has no product-event name');
A.ok(!('payload' in keepalivePayload), 'the keepalive has no product-event payload');

// The periodic write obeys the hub's existing dead-client and memory bounds, rather than bypassing
// them with a raw res.write() in index.js.
{
  const keepaliveHub = makeSseHub();
  const frames = [];
  const live = { write: frame => { frames.push(frame); return true; } };
  keepaliveHub.add(live);
  A.eq(keepaliveHub.keepalive(live), true, 'a registered live client accepts the keepalive');
  A.eq(frames[0], keepaliveFrame, 'the hub writes the exact pure keepalive frame');

  const dead = { write: () => { throw new Error('EPIPE'); }, end: () => {}, destroy: () => {} };
  keepaliveHub.add(dead);
  A.eq(keepaliveHub.keepalive(dead), false, 'a throwing keepalive client is reported dead');
  A.eq(keepaliveHub.size(), 1, 'a throwing keepalive client is evicted');

  let ended = false, destroyed = false;
  const zombie = {
    write: () => false,
    writableLength: keepaliveHub._internals.SSE_MAX_BUFFER_BYTES + 1,
    end: () => { ended = true; },
    destroy: () => { destroyed = true; }
  };
  keepaliveHub.add(zombie);
  A.eq(keepaliveHub.keepalive(zombie), false, 'an over-buffered keepalive client is reported dead');
  A.eq(keepaliveHub.size(), 1, 'an over-buffered keepalive client is evicted');
  A.ok(ended && destroyed, 'keepalive eviction releases the zombie response buffer');
}

const hub = makeSseHub();
A.eq(hub.size(), 0, 'a fresh hub has no clients');
A.eq(hub.broadcast('queue.status', { depth: 1 }), 0, 'broadcasting to nobody reaches 0 clients');

// one registered client receives an SSE-framed event carrying the name + payload
const a = []; const ca = { write: s => a.push(s) };
const offA = hub.add(ca);
A.eq(hub.size(), 1, 'add() registers a client');
const reached = hub.broadcast('workitem.placed', { workitemId: 'W1', queueId: 'tg_42' });
A.eq(reached, 1, 'broadcast reaches the one open client');
A.eq(a.length, 1, 'the client got exactly one frame');
A.ok(a[0].startsWith('id: ') && a[0].endsWith('\n\n'), 'the frame is SSE-shaped with a replay id');
const decoded = JSON.parse(eventDataOf(a[0]));
A.ok(decoded.name === 'workitem.placed' && decoded.payload.workitemId === 'W1', 'the frame carries the event name + payload');

// fan-out: a second client also receives subsequent events
const b = []; hub.add({ write: s => b.push(s) });
hub.broadcast('queue.status', { queueId: 'tg_42', depth: 2 });
A.eq(a.length, 2, 'the first client received the second event too');
A.eq(b.length, 1, 'the second client received the second event');

// the unsubscribe returned by add() removes exactly that client (no leak)
offA();
A.eq(hub.size(), 1, 'the unsubscribe handle removes its client');
hub.broadcast('queue.status', { depth: 3 });
A.eq(a.length, 2, 'the removed client receives nothing further');

// a dead client (write throws, e.g. closed socket) is evicted on the next broadcast
hub.add({ write: () => { throw new Error('EPIPE'); } });
A.eq(hub.size(), 2, 'the throwing client is registered before the broadcast');
hub.broadcast('queue.status', { depth: 4 });
A.eq(hub.size(), 1, 'a client whose write() throws is evicted (the Set never grows unbounded)');

// a BACKPRESSURED client (write() returns false) is tolerated while its buffer is small, but evicted once the
// buffered bytes cross the ceiling — the zombie-socket memory-leak guard. write() never throws here (that's the
// separate dead-socket path above); it just returns false, so only the writableLength ceiling catches it.
{
  const hub2 = makeSseHub();
  const CEIL = hub2._internals.SSE_MAX_BUFFER_BYTES;

  // under the ceiling: kept (a healthy-ish reader that's momentarily behind is not evicted)
  let slowWrites = 0;
  const slow = { write: () => { slowWrites++; return false; }, writableLength: 1024, end: () => {}, destroy: () => {} };
  hub2.add(slow);
  const reachedSlow = hub2.broadcast('queue.status', { depth: 1 });
  A.eq(hub2.size(), 1, 'a backpressured-but-under-ceiling client is NOT evicted');
  A.eq(reachedSlow, 1, 'it still counts as reached while under the ceiling');
  A.eq(slowWrites, 1, 'the frame was written to it');

  // over the ceiling: evicted + end/destroy called so the buffer is released
  let ended = false, destroyed = false;
  const zombie = { write: () => false, writableLength: CEIL + 1, end: () => { ended = true; }, destroy: () => { destroyed = true; } };
  hub2.add(zombie);
  A.eq(hub2.size(), 2, 'the zombie is registered before the broadcast');
  const reached = hub2.broadcast('queue.status', { depth: 2 });
  A.eq(hub2.size(), 1, 'a client buffering past the ceiling is evicted');
  A.eq(reached, 1, 'the evicted zombie is NOT counted as reached (only the slow client)');
  A.ok(ended && destroyed, 'the evicted client is end()ed and destroy()ed so its write buffer is released');
}

/* ---------- G2.1: the server-initiated-run tee policy (runTeeView) ---------- */
// run lifecycle passes through whole
const startP = { agentId: 'a1', runId: 'r1', trigger: 'schedule', model: 'm' };
A.eq(runTeeView('agent.run.start', startP), startP, 'agent.run.start tees whole');
A.ok(!!runTeeView('agent.cost', { agentId: 'a1', runId: 'r1', usd: 0.01, reconciled: true }), 'agent.cost tees');
A.ok(!!runTeeView('agent.run.end', { agentId: 'a1', runId: 'r1', reason: 'done', turns: 1, usd: 0 }), 'agent.run.end tees');

// EVERY tool_call tees — not just mcp__ — but NAME-ONLY: args/argsSummary stripped structurally
const tc = runTeeView('agent.tool_call', { agentId: 'a1', runId: 'r1', callId: 'c1', name: 'fs.read', argsSummary: 'C:/secret/path.txt' });
A.ok(!!tc, 'a plain (non-mcp) tool_call is teed — G0 prop pulses fire for autonomous runs');
A.eq(tc.name, 'fs.read', 'the tool NAME is carried (the prop mapper keys on it)');
A.eq(tc.agentId, 'a1', 'agentId is carried (pulse lands on the acting agent\'s prop)');
A.eq(tc.runId, 'r1', 'runId is carried (frozen agent.tool_call schema requires it)');
A.eq(tc.callId, 'c1', 'callId is carried (the delegation window pairs call->result)');
A.ok(!('argsSummary' in tc), 'argsSummary is STRIPPED — tool arguments never ride the SSE bus');
A.eq(Object.keys(tc).sort().join(','), 'agentId,callId,name,runId', 'the tool_call view carries EXACTLY the four id fields — nothing else can leak');
const tcm = runTeeView('agent.tool_call', { agentId: 'a1', runId: 'r1', callId: 'c2', name: 'mcp__github__search', argsSummary: '{"q":"x"}' });
A.ok(tcm && tcm.name === 'mcp__github__search' && !('argsSummary' in tcm), 'mcp__ tool_calls keep pulsing their portal, now also name-only');

// the token stream NEVER tees (that noise decision stands)
A.eq(runTeeView('agent.token', { agentId: 'a1', runId: 'r1', delta: 'hello' }), null, 'agent.token is never teed');

// agent.tool_result TEES OUTCOME-ONLY (2026-07-06 audit: was dropped; now the floor can render a FAILED/denied
// tool surge for autonomous runs) — but the payload-bearing `summary` is STRIPPED structurally.
const tr = runTeeView('agent.tool_result', { agentId: 'a1', runId: 'r1', callId: 'c1', ok: false, isError: true, ms: 12, summary: 'SECRET RESULT BODY' });
A.ok(!!tr, 'agent.tool_result is now teed (outcome-only) so denied/failed calls surge red on the floor');
A.ok(!('summary' in tr), 'the tool RESULT body (summary) is STRIPPED — result payloads never ride the SSE bus');
A.eq(Object.keys(tr).sort().join(','), 'agentId,callId,isError,ms,ok,runId', 'the tool_result view carries EXACTLY the outcome fields — nothing else can leak');
A.eq(tr.isError, true, 'isError (error-kind) is carried so the floor renders the red/dim variant');

// the observability metadata events tee WHOLE (no args/result payloads in their frozen schemas)
A.ok(!!runTeeView('deliverable', { id: 'd1', agentId: 'a1', room: 'r', kind: 'html', title: 't' }), 'deliverable tees (crates land for autonomous runs)');
A.ok(!!runTeeView('agent.run.error', { agentId: 'a1', runId: 'r1', message: 'boom', transient: false }), 'agent.run.error tees (errors strobe the floor)');
A.ok(!!runTeeView('memory.write', { agentId: 'a1', runId: 'r1', id: 'm1', kind: 'fact' }), 'memory.write tees (memory pulses for autonomous runs)');
A.ok(!!runTeeView('memory.recall', { agentId: 'a1', runId: 'r1', count: 3, chars: 40 }), 'memory.recall tees');
A.ok(!!runTeeView('capdenied', { agentId: 'a1', need: 'net', reason: 'no key' }), 'capdenied tees (denials show on the floor)');

A.eq(runTeeView('agent.reasoning', { agentId: 'a1', runId: 'r1', on: true }), null, 'other run events stay off the bus');

// SOURCE GUARD (lint-emits idiom): the runOnce broadcast tee in sidecar/index.js must route through
// runTeeView — a hand-rolled tee could silently re-leak args or re-tee tokens.
{
  const fs = require('fs');
  const path = require('path');
  const src = readSidecarSource();
  const i = src.indexOf('const emit = o.broadcast');
  A.ok(i > 0, 'index.js has the broadcast-opted tee');
  const seg = src.slice(i, i + 400);
  A.ok(/runTeeView\(name,\s*payload\)/.test(seg), 'the tee routes through the runTeeView egress policy');
  A.ok(/redact\(view\)/.test(seg), 'the teed view still passes redact() as a second backstop');

  const channelEvents = sidecarFunctionSource('handleChannelEvents');
  const keepaliveAt = channelEvents.indexOf('const ka = setInterval');
  A.ok(keepaliveAt > 0, 'handleChannelEvents owns one bounded keepalive interval');
  const keepaliveSeg = channelEvents.slice(keepaliveAt, keepaliveAt + 160);
  A.ok(/sse\.keepalive\(res\)/.test(keepaliveSeg), 'the channel interval uses the tested hub keepalive path');
  A.ok(/25000/.test(keepaliveSeg), 'the existing 25-second keepalive cadence is preserved');
  A.ok(!src.includes("res.write(': ka\\n\\n')"), 'the browser-invisible SSE comment keepalive is retired');
}

/* ---- the CLIENT side of the same stream: exactly one EventSource. world.js is not node-loadable
   (canvas/rAF/DOM at module scope), so these are source locks — the same pattern the other world.js
   guards in test/ use.

   The defect that lived here: `open()` guarded only on bridgePaused: onerror nulls chanES and arms a
   retry, and resumeBridge re-opens on !chanES, so a re-entry INSIDE the backoff window (DATA › IMPORT →
   reentry → enterGame → resumeBridge) opened stream #1 and the pending timer then overwrote chanES with
   #2 — #1 never closed, its onmessage closure re-emitting every server event onto the bus forever (two
   crates per inbound message, doubled HUD notes).

   (The sub-agent helper-sprite ledger this block also used to lock was REMOVED 2026-07-30 on Andrew's
   order — the world draws no floating helper marker; the LIVE HELPERS panel is the readout.) */
{
  const fs = require('fs');
  const path = require('path');
  const world = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'world.js'), 'utf8');

  const openAt = world.indexOf('const open = () => {');
  A.ok(openAt > 0, 'world.js owns the channel-bridge open()');
  const openSeg = world.slice(openAt, world.indexOf('connOpenFn = open;', openAt));
  A.ok(/if \(chanES\) return;/.test(openSeg), 'open() refuses to create a SECOND EventSource while one is live');
  A.ok(/clearTimeout\(retryTimer\)/.test(openSeg), 'and it cancels any pending retry, so the timer cannot replace a healthy stream');
  A.ok(/retryTimer = setTimeout\(/.test(openSeg), 'the reconnect retry is a TRACKED timer, not an anonymous one');

  /* Execute the production open() closure against fake EventSources/timers. This is the exact original race:
     socket error -> retry pending -> DATA/IMPORT re-entry calls resumeBridge -> stale retry callback fires.
     Source needles alone can prove the guards exist, but only this state-machine drive proves their composition
     leaves one live stream and never orphans a second emitter. */
  const openEnd = world.indexOf('\n    };\n    connOpenFn = open;', openAt);
  A.ok(openEnd > openAt, 'the production channel-bridge open() closure is extractable for behavioral execution');
  const openSource = world.slice(openAt, openEnd + '\n    };'.length);
  let timerId = 0;
  const timers = new Map();
  const fakeSetTimeout = fn => { const id = ++timerId; timers.set(id, fn); return id; };
  const fakeClearTimeout = id => { timers.delete(id); };
  const sources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
  }
  FakeEventSource.OPEN = 1;
  const makeBridge = new Function('EventSource', 'setTimeout', 'clearTimeout', `
    let bridgePaused = false, chanES = null, retryTimer = null, backoff = 1000;
    let bridgeCursor = '', bridgeRecovering = false;
    const emitted = []; let snapshots = 0; const readyOrder = [];
    const motionWake = () => {};   // STILL (world.js): the link state is drawn on the next vsync — a no-op here
    let lastSseEventAt = 0, fnow = 0;
    const apiUrl = x => x, fetchSnapshot = () => { snapshots++; readyOrder.push('snapshot'); };
    // FIRST SHIP's own reset (world.js forgetShipBase) — the one collaborator the bridge's replay completion calls besides the snapshot
    const forgetShipBase = () => { readyOrder.push('forget-ship-base'); };
    const window = { __STARNET_API_TOKEN__: '' };
    const ApiTicket = { sseUrl: q => '/api/channels/events?' + q + '&ticket=T' + (++minted) };   // app/apiticket.js stand-in
    let minted = 0;
    const performance = { now: () => 0 };
    const U = { bus: { emit(name, payload) { emitted.push({name, payload}); } } };
    ${openSource}
    return {
      open,
      emitted, snapshots: () => snapshots, readyOrder,
      resume() { if (!chanES) open(); },
      source() { return chanES; }
    };
  `);
  const bridge = makeBridge(FakeEventSource, fakeSetTimeout, fakeClearTimeout);
  bridge.open();
  const first = bridge.source();
  A.eq(sources.length, 1, 'initial bridge open creates one EventSource');
  first.onerror();
  A.ok(first.closed && bridge.source() === null, 'an errored source closes and leaves one tracked retry');
  A.eq(timers.size, 1, 'the error arms exactly one retry timer');
  const staleRetry = Array.from(timers.values())[0];
  bridge.resume();
  const resumed = bridge.source();
  A.eq(sources.length, 2, 're-entry during backoff creates one replacement source');
  A.eq(timers.size, 0, 're-entry cancels the pending retry');
  A.ok(resumed && resumed !== first && !resumed.closed, 'the replacement is the sole live tracked source');
  staleRetry(); // adversarially invoke the already-cleared callback; open()'s live-source guard is the second belt
  A.eq(sources.length, 2, 'even a stale retry callback cannot create a second live EventSource');
  A.eq(sources.filter(s => !s.closed).length, 1, 're-entry/backoff ends with exactly ONE live EventSource');
  first.onerror();
  A.eq(bridge.source(), resumed, 'an obsolete source error cannot close its replacement');
  first.onmessage({ data: JSON.stringify({ name: 'queue.status', payload: { depth: 99 } }), lastEventId: 'a:1' });
  A.eq(bridge.emitted.length, 0, 'obsolete source messages cannot mutate the station');
  const message = { data: JSON.stringify({ name: 'queue.status', payload: { depth: 2 } }), lastEventId: 'a:2' };
  resumed.onmessage(message); resumed.onmessage(message);
  A.eq(bridge.emitted.length, 1, 'a replayed duplicate is applied only once');
  resumed.onmessage({ data: JSON.stringify({ stream: 'ready', cursor: 'a:2', reset: false }), lastEventId: 'a:2' });
  A.eq(bridge.snapshots(), 1, 'replay completion refreshes authoritative state');
  // (conveyor-final repair) FIRST SHIP's baseline reset was inlined AHEAD of the snapshot inside open()'s catch-all, so any throw in
  // it silently skipped the authoritative refresh: the snapshot comes first, then FIRST SHIP's own forgetShipBase
  A.eq(bridge.readyOrder, ['snapshot', 'forget-ship-base'], 'replay completion refreshes authoritative state FIRST, then lets FIRST SHIP re-read its counts');
  A.ok(!/shipBase\s*=|shipApplied|refreshShipBase/.test(openSource), 'the bridge reaches into no FIRST SHIP internals — one call to forgetShipBase');
  resumed.onerror(); bridge.resume();
  A.ok(bridge.source().url.includes('cursor=a%3A2'), 'a manually recreated EventSource carries the acknowledged cursor');

  const spawnAt = world.indexOf('chanQueues.clear(); serverLit.clear();');
  A.ok(spawnAt > 0, 'spawn() owns the new-agent reset block');
  A.ok(!/subLedger/.test(world), 'the retired helper-sprite ledger stays gone — no floating sub-agent marker in the world');
}

A.report('channels.sse');
