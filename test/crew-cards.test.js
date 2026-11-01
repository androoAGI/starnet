/* node test/crew-cards.test.js — the CREW cards (frontend/app/crewcards.js) show only what the harness proves (sweep 2026-10-02):
   · a run the page never saw END (Stop, E-STOP, a dropped stream) does not haunt the agent's NEXT run with its clock,
     step and gold "needs your OK" frame;
   · the run clock excludes time spent waiting on the Commander (the duration law COMMS keeps with Channels.elapsedOf);
   · a question or approval that was answered, denied or expired clears the frame. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'crewcards.js'), 'utf8');

// load(startAt) or load({ frames, startAt }): a number is the clock's start (the exact-run cases), an object the frame options
function load(opts = {}) {
  const startAt = typeof opts === 'number' ? opts : (typeof opts.startAt === 'number' ? opts.startAt : 1000000);
  const L = {};
  const bus = { on: (n, f) => (L[n] = L[n] || []).push(f) };
  const emit = (n, p) => (L[n] || []).forEach(f => f(p));
  let t = startAt;
  const kids = {};
  const cl = new Set(['working']);
  const el = (c) => ({ className: c, textContent: '', after() {}, appendChild(x) { kids[x.className] = x; }, querySelector() { return null; }, setAttribute() {} });
  const name = el('crew-name'); name.querySelector = () => kids['crew-clock'] || null;
  const status = el('crew-status');
  const row = {
    dataset: { agentId: 'nova' }, _step: null,
    classList: { contains: c => cl.has(c), toggle: (c, on) => (on ? cl.add(c) : cl.delete(c)) },
    querySelector: s => s === '.crew-name' ? name : s === '.crew-status' ? status : s === '.crew-clock' ? kids['crew-clock'] : s === '.crew-step' ? row._step : null
  };
  status.after = x => { row._step = x; };
  let tick = null, nextMs = null, tid = 0;
  const timers = [], raf = [];
  const win = {};
  const ctx = {
    window: win,
    U: { bus },
    Date: { now: () => t },
    document: { readyState: 'complete', querySelectorAll: () => [row], querySelector: () => null, getElementById: () => null,
      createElement: () => ({ className: '', textContent: '', setAttribute() {} }) },
    MutationObserver: class { observe() {} },
    // the paint loop is a setTimeout chain timed to the clock's next turn; the stub keeps the latest one (advance fires it now)
    // and a real queue (frame() fires the due ones), so a page that draws frames can be stepped one frame at a time
    setTimeout: (fn, ms) => { tick = fn; nextMs = ms; const id = ++tid; timers.push({ id, fn, at: t + Math.max(0, ms) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  if (opts.frames) ctx.requestAnimationFrame = (fn) => { raf.push(fn); return raf.length; };
  vm.runInNewContext(src, ctx);
  return {
    emit, cl,
    advance(ms) { t += ms; if (tick) tick(); },
    clock: () => (kids['crew-clock'] || {}).textContent,
    step: () => (row._step || {}).textContent,
    asking: () => cl.has('asking'),
    elapsed: (runId, now = t) => win.CrewClock.elapsedForRun(runId, now),
    nextMs: () => nextMs, crewClock: () => win.CrewClock,
    // one animation frame: time moves, due timers fire, then the frame's rAF callbacks run (where the world draws its tag)
    frame(ms = 16) {
      t += ms;
      for (let guard = 0; guard < 100; guard++) {
        const due = timers.filter(x => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1); due.fn();
      }
      raf.splice(0).forEach(f => f(t));   // every callback of a frame gets the same frame timestamp
    },
    at: (ms) => { t = ms; }, now: () => t
  };
}

// 1) a stopped run (no agent.run.end ever arrives) does not haunt the next run
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r1' });
  c.emit('permission.prompt', { promptId: 'p1', agentId: 'nova', tool: 'fs.write' });
  c.advance(120000);
  A.ok(c.asking(), 'fixture: the first run is waiting on the Commander');
  c.cl.delete('working'); c.advance(1000); c.advance(9000);   // Stop: the row goes idle, the run never reports its end
  c.advance(3600000);
  c.cl.add('working');
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r2' });
  c.advance(5000);
  A.eq([c.clock(), c.step(), c.asking()], ['0:05', '', false], 'the next run starts its own clock, with no leftover step or "needs your OK"');
  A.eq(c.elapsed('r1'), null, 'idle cleanup also retires the lost run\'s exact accounting');
}
// 2) the clock excludes the wait on the Commander, then resumes
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r1' });
  c.advance(10000);
  c.emit('permission.prompt', { promptId: 'p1', agentId: 'nova', tool: 'fs.write' });
  c.advance(60000);
  A.eq([c.clock(), c.asking()], ['0:10', true], 'while it waits on you the clock holds');
  c.emit('permission.response', { promptId: 'p1', decision: 'once' });
  c.advance(5000);
  A.eq([c.clock(), c.asking()], ['0:15', false], 'answered: the frame clears and the clock resumes without the wait');
}
// 3) a short idle blip (a fresh start before .working lands) does not drop a live run
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r1' });
  c.cl.delete('working'); c.advance(2000); c.cl.add('working'); c.advance(1000);
  A.eq(c.clock(), '0:03', 'a run is kept through a brief not-working blip (8s grace)');
}

// 4) delegated clocks follow runs, even when the oldest run of the same agent ends
{
  const c = load(100000);
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.advance(60000);
  c.emit('agent.run.start', { agentId: 'nova', runId: 'b' });
  c.advance(60000);
  A.eq([c.elapsed('a'), c.elapsed('b')], [120000, 60000], 'staggered concurrent tasks each keep their own elapsed time');
  c.advance(10000); c.emit('agent.run.end', { runId: 'a' });
  A.eq([c.elapsed('a'), c.elapsed('b')], [null, 70000], 'ending the oldest run cannot reset its sibling clock');
  c.emit('agent.run.end', { runId: 'a' }); c.advance(1000);
  A.eq(c.elapsed('b'), 71000, 'a duplicate old end is harmless to the surviving run');
}

// 5) overlapping prompts count as one wait for their exact worker, never for its same-agent sibling or outer lead
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'lead', runId: 'lead' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.advance(2000); c.emit('agent.run.start', { agentId: 'nova', runId: 'b' });
  c.advance(2000);
  const p1 = { promptId: 'p1', agentId: 'lead', runId: 'lead', workerAgentId: 'nova', workerRunId: 'a' };
  const p2 = { ...p1, promptId: 'p2' };
  c.emit('permission.prompt', p1);
  c.advance(2000); c.emit('permission.prompt', p2); c.emit('permission.prompt', p1);
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  A.eq([c.elapsed('a'), c.elapsed('b'), c.elapsed('lead')], [4000, 4000, 6000], 'only the stamped worker pauses; duplicate delivery does not move its pause');
  c.advance(2000); c.emit('permission.response', { promptId: 'p1', decision: 'once' });
  A.eq([c.elapsed('a'), c.elapsed('b')], [4000, 6000], 'closing one prompt leaves the overlapping prompt paused');
  c.advance(2000); c.emit('permission.response', { promptId: 'p2', decision: 'deny' });
  c.advance(1000);
  A.eq([c.elapsed('a'), c.elapsed('b')], [5000, 9000], 'the closed union is subtracted once, only from its owner');
  c.emit('permission.prompt', p2);
  c.emit('permission.response', { promptId: 'p2', decision: 'deny' });
  c.emit('permission.response', { promptId: 'unseen', decision: 'once' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.advance(1000);
  A.eq([c.elapsed('a'), c.elapsed('b')], [6000, 10000], 'settled prompt replay, duplicate/unknown response and duplicate start cannot reset or double-charge time');
}

// 6) independent simultaneous waits and out-of-order ends retain the sibling's own open pause
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'b' });
  c.advance(1000);
  c.emit('permission.prompt', { promptId: 'pa', agentId: 'lead', workerAgentId: 'nova', workerRunId: 'a' });
  c.emit('permission.prompt', { promptId: 'pb', agentId: 'lead', workerAgentId: 'nova', workerRunId: 'b' });
  c.advance(2000); c.emit('permission.response', { promptId: 'pa', decision: 'once' });
  c.advance(3000);
  A.eq([c.elapsed('a'), c.elapsed('b')], [4000, 1000], 'one worker resumes while the other still awaits an independent answer');
  c.emit('permission.response', { promptId: 'pb', decision: 'deny', expired: true });
  c.advance(1000);
  A.eq([c.elapsed('a'), c.elapsed('b')], [5000, 2000], 'independent answer and expiry close only their recorded owners');
}
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'b' });
  c.advance(1000);
  c.emit('permission.prompt', { promptId: 'pa', agentId: 'lead', workerAgentId: 'nova', workerRunId: 'a' });
  c.advance(1000);
  c.emit('permission.prompt', { promptId: 'pb', agentId: 'lead', workerAgentId: 'nova', workerRunId: 'b' });
  c.advance(3000); c.emit('agent.run.error', { runId: 'b' });
  A.eq([c.elapsed('a'), c.elapsed('b'), c.asking()], [1000, null, true], 'the newer run ending first removes only its own open wait');
  c.emit('permission.response', { promptId: 'pb', decision: 'deny', expired: true });
  c.advance(1000); c.emit('permission.response', { promptId: 'pa', decision: 'once' });
  c.advance(2000);
  A.eq([c.elapsed('a'), c.asking()], [3000, false], 'late settlement of the ended run does not affect the surviving run\'s pause union');
  c.emit('agent.run.start', { agentId: 'nova', runId: 'c' });
  c.emit('agent.run.end', { runId: 'b' }); c.advance(1000);
  A.eq([c.elapsed('a'), c.elapsed('c')], [4000, 1000], 'a delayed old end cannot clear a new same-agent run');
}

// 7) no observed start or no proven wait owner means unavailable accounting, never an agent-based guess
{
  const c = load();
  A.eq(c.elapsed('recovered'), null, 'a run already active on reload has no page-observed start');
  c.emit('permission.prompt', { promptId: 'early', agentId: 'lead', workerAgentId: 'nova', workerRunId: 'late-start' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'late-start' });
  c.emit('permission.response', { promptId: 'early', decision: 'once' });
  A.eq(c.elapsed('late-start'), null, 'a start arriving after its wait cannot reconstruct elapsed accounting');
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'b' });
  c.emit('agent.run.start', { agentId: 'other', runId: 'other' });
  c.advance(1000);
  c.emit('permission.prompt', { promptId: 'ordinary', agentId: 'nova', runId: 'outer-is-not-a-worker-stamp' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'during-wait' });
  c.advance(1000); c.emit('permission.response', { promptId: 'ordinary', decision: 'once' });
  A.eq([c.elapsed('a'), c.elapsed('b'), c.elapsed('during-wait'), c.elapsed('other')], [null, null, null, 2000], 'an unstamped wait invalidates possible owners, not unrelated agents; closing it cannot repair the missing history');
  c.emit('agent.run.start', { agentId: 'nova', runId: 'after-wait' });
  A.eq(c.elapsed('after-wait'), 0, 'a later observed start has a fresh known clock');
  c.emit('permission.prompt', { promptId: 'missing-worker', agentId: 'lead', runId: 'other', workerAgentId: 'nova' });
  A.eq([c.elapsed('after-wait'), c.elapsed('other')], [null, 2000], 'a worker ask without workerRunId cannot borrow its outer consent run');
}
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'a' });
  c.emit('agent.run.start', { agentId: 'nova', runId: 'b' });
  c.advance(2000);
  c.emit('permission.prompt', { promptId: 'conflict', agentId: 'lead', workerAgentId: 'other', workerRunId: 'a' });
  A.eq([c.elapsed('a'), c.elapsed('b')], [null, 2000], 'a conflicting worker stamp makes that exact clock unavailable without pausing its sibling');
  c.advance(1000); c.emit('permission.response', { promptId: 'conflict', decision: 'deny' });
  A.eq([c.elapsed('a'), c.elapsed('b')], [null, 3000], 'settling a conflicting stamp cannot restore missing certainty');
}
{
  const c = load(0);
  c.emit('agent.run.start', { agentId: 'nova', runId: 'zero' });
  c.emit('permission.prompt', { promptId: 'zero-pause', agentId: 'lead', workerAgentId: 'nova', workerRunId: 'zero' });
  c.advance(1000);
  A.eq(c.elapsed('zero'), 0, 'zero is a valid start and pause timestamp');
  c.emit('permission.response', { promptId: 'zero-pause', decision: 'once' });
  c.advance(1000); c.emit('agent.run.start', { agentId: 'nova', runId: 'zero' });
  A.eq(c.elapsed('zero'), 1000, 'a repeated start retains the original start and settled wait');
  A.eq(c.elapsed('zero', NaN), null, 'invalid observation time is unavailable, not a painted zero');
}

// 8) CREW turns its second in the same frame the world's desk tag does (review of rc walk #21: a free-running 1 s interval
//    painted at the page's own phase, so the card read a second behind the tag that reads the same clock every frame)
{
  const c = load();
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r1' });
  const t0 = c.now();
  c.at(t0 + 2300); c.advance(0);                      // a paint 2.3 s into the run
  A.eq(c.clock(), '0:02', 'fixture: 2.3 s reads 0:02');
  A.eq(c.nextMs(), 700 + 1, 'with no animation frames the next paint is a timer just past the turn to 0:03 (700 ms on, +1): ' + c.nextMs());
  c.advance(c.nextMs());
  A.eq(c.clock(), '0:03', '…and the paint at that moment reads 0:03, as the world tag does');
  A.eq(c.crewClock().msToNextSecond(c.now()), 1000 - 1 + 1, 'CrewClock answers the same next turn for any other timer readout');
  c.emit('permission.prompt', { promptId: 'p1', agentId: 'nova', tool: 'fs.write' });
  A.eq(c.nextMs(), 1001, 'a wait opening re-aims the tick, and a clock held on a wait on you never turns: the loop idles at 1 s');
  // one run's own clock, by runId (a DELEGATED row names its worker's run)
  c.at(c.now() + 30000);
  A.eq(c.crewClock().elapsedOfRun('r1', c.now()), 3001, 'elapsedOfRun excludes the open wait on you: ' + c.crewClock().elapsedOfRun('r1', c.now()));
  A.eq(c.crewClock().elapsedOfRun('r-never-seen', c.now()), null, 'a run this page never saw start has no clock here (null, never 0)');
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r2' });
  c.emit('permission.response', { promptId: 'p1', decision: 'once' });
  c.at(c.now() + 5000);
  A.eq(c.crewClock().elapsedOfRun('r2', c.now()), 5000, 'a second run of the same agent keeps its own clock');
  A.eq(c.crewClock().elapsedOf('nova', c.now()), 8001, 'the agent clock (CREW) is still its oldest run');
}
// 8b) on a page that draws frames, CREW repaints IN the frame the clock turns — the frame the world's desk tag (drawn each frame
//     from this clock) turns in — and an atNextTurn readout (the DELEGATED row) repaints in that same frame
{
  const c = load({ frames: true });
  const fmt = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  c.frame(5);
  c.emit('agent.run.start', { agentId: 'nova', runId: 'r1' });
  const t0 = c.now();
  let frames = 0, mism = 0, turns = 0, last = null;
  const heard = [];
  const listen = () => c.crewClock().atNextTurn(() => { heard.push({ crew: c.clock(), world: fmt(c.now() - t0) }); });
  listen();
  for (let i = 0; i < 400; i++) {   // 400 frames of 16.7 ms ≈ 6.7 s
    c.frame(16.7);
    frames++;
    if (c.clock() !== fmt(c.now() - t0)) mism++;
    if (c.clock() !== last) { turns++; last = c.clock(); }
    if (i === 120) listen();
  }
  A.eq(mism, 0, 'CREW and the world tag never disagree on a frame (' + frames + ' frames, ' + turns + ' turns)');
  A.ok(turns >= 6, 'the clock turned every second it ran: ' + turns);
  A.ok(heard.length === 2 && heard.every(h => h.crew === h.world), 'atNextTurn fires once per ask, right after CREW paints, with CREW and the world agreeing: ' + JSON.stringify(heard));
}

// 9) the page side: every way a question/approval is settled reaches the bus
{
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  const clar = chat.slice(chat.indexOf('function clarifyRow('), chat.indexOf('function permissionRow('));
  A.ok((clar.match(/U\.bus\.emit\('permission\.response', ?\{ ?promptId: ?p\.promptId, ?decision: ?'once', ?via: ?'desk' ?\}\)/g) || []).length === 2,
    'both question paths (buttons and the conversation) announce the local desk answer on the bus');
  const idx = readSidecarSource();
  // a run's own ask on its stream; a background worker's ask (it outlives the lead's turn) on the station bus, and a
  // background worker that was STOPPED says stopped, not expired (2026-10-14)
  A.ok(/const say = detached \? chanEmit : emit;/.test(idx)
    && /onAutoDeny: \(promptId, expired\) => \{ announced = true; try \{ say\('permission\.response', \(detached && !expired\) \? \{ promptId, decision: 'deny', stopped: true \} : \{ promptId, decision: 'deny', expired: true \}\);/.test(idx),
    'a prompt that expired or lost its run is announced where its surfaces listen');
}

A.report('crew-cards');
