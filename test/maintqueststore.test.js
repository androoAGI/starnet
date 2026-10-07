/* node test/maintqueststore.test.js — the live wiring around the pure maintenance-quest generator
   (frontend/app/maintqueststore.js). Verifies the G1c slag→quest + cron-jam→quest contract end to end:
     • a cause that recurs ≥ MIN_HITS times in the live SlagLog ring mints exactly one fix-it quest; a one-off
       never nags (threshold); repeats never duplicate;
     • the quest clears (honest completion) when the cause falls back below threshold in the ring — no claim;
     • cron.skipped streaks past the jam threshold mint a jam quest + flag jammedJobs(); a clean fire/result
       clears it;
     • dismissal is permanent across reload and blocks re-minting forever;
     • THE LAW: maintenance quests never mint XP and the store never emits on U.bus — tripwire stubs throw if
       touched. Plus source-level locks on the browser wiring. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- stubs: storage, engine, live signal reads, tripwires ---------- */
global.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; }
};
global.MaintQuests = require('../frontend/app/maintquests.js');

// the mutable live SlagLog ring (World.slagPostmortems) — the mint threshold + the completion predicate read it.
let ring = [];
global.World = { slagPostmortems: () => ring.slice() };

// THE LAW tripwires: a maintenance quest must never touch XP and the store must never emit on the bus.
global.Xp = { applyEvent: () => { throw new Error('LAW VIOLATION: maintenance quests must never mint XP'); } };
global.XpStore = { onEvent: () => { throw new Error('LAW VIOLATION: maintenance quests must never feed the XP engine'); } };
const listeners = {};
global.U = {
  bus: {
    emit: () => { throw new Error('LAW VIOLATION: maintqueststore must never emit on U.bus'); },
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }
  }
};
const rerenders = [];
global.StationUI = { rerender: k => rerenders.push(k) };

const { MaintQuestStore } = require('../frontend/app/maintqueststore.js');
const diag = (reason, title, fix) => ({ reason, title: title || (reason + ' happened'), fix: fix || 'do the fix', cause: 'because' });
const skip = (jobId, reason) => (listeners['cron.skipped'] || []).forEach(fn => fn({ jobId, reason: reason || 'already-running' }));
const cronOk = (jobId) => (listeners['cron.result'] || []).forEach(fn => fn({ jobId, runId: 'r', outcome: 'ok' }));

/* ---------- init binds the cron signals (subscription only) ---------- */
MaintQuestStore.init();
A.ok((listeners['cron.skipped'] || []).length === 1, 'init subscribes to cron.skipped exactly once');
A.ok((listeners['cron.fire'] || []).length === 1 && (listeners['cron.result'] || []).length === 1, 'init subscribes to the cron clear signals');
A.eq(MaintQuestStore.quests().length, 0, 'a fresh store has no quests');

/* ---------- threshold: a ONE-OFF failure never nags ---------- */
ring = [diag('max_iters', 'looped without finishing', 'Split the task.')];
MaintQuestStore.sync();
A.eq(MaintQuestStore.quests().length, 0, 'a single post-mortem is below threshold — no quest (anti-blip)');

/* ---------- a cause that recurs ≥ MIN_HITS mints exactly one quest ---------- */
ring = [diag('max_iters', 'looped without finishing', 'Split the task.'), diag('max_iters', 'looped without finishing', 'Raise the budget.')];
MaintQuestStore.sync();
let qs = MaintQuestStore.quests();
A.eq(qs.length, 1, 'two same-cause post-mortems → one maintenance quest');
A.eq(qs[0].id, 'mq:slag:max_iters', 'keyed by the cause');
A.eq(qs[0].status, 'open', 'open until the signal clears');
A.ok(/2 runs/.test(qs[0].title), 'the title carries the recurrence count');
A.ok(rerenders.indexOf('quests') >= 0, 'an open quest-log is poked to refresh');

/* ---------- repeats never duplicate; a DIFFERENT cause gets its own quest ---------- */
ring.push(diag('max_iters'));
MaintQuestStore.sync();
A.eq(MaintQuestStore.quests().length, 1, 'more of the same cause never duplicates');
ring = ring.concat([diag('budget', 'hit the budget cap', 'Raise the budget.'), diag('budget', 'hit the budget cap', 'Split it.')]);
MaintQuestStore.sync();
A.eq(MaintQuestStore.quests().length, 2, 'a second recurring cause mints its own quest');

/* ---------- completion: the signal clearing (cause falls below threshold in the ring) flips it done ---------- */
ring = ring.filter(d => d.reason !== 'max_iters');   // clean runs pushed the max_iters failures out of the ring
MaintQuestStore.sync();
qs = MaintQuestStore.quests();
A.eq(qs.find(q => q.id === 'mq:slag:max_iters').status, 'done', 'the cleared cause flips done — the operator fixed the line (no claim)');
A.eq(qs.find(q => q.id === 'mq:slag:budget').status, 'open', 'a still-recurring cause stays open');

/* ---------- cron-jam: a repeatedly-skipped routine mints a jam quest + flags the board ---------- */
A.eq(MaintQuestStore.jammedJobs().length, 0, 'no jam yet');
skip('job-9', 'already-running'); skip('job-9', 'already-running');
A.eq(MaintQuestStore.jammedJobs().length, 0, 'two skips is below the jam threshold');
skip('job-9', 'already-running');
const jammed = MaintQuestStore.jammedJobs();
A.eq(jammed.length, 1, 'a third skip crosses the jam threshold');
A.eq(jammed[0].jobId, 'job-9', 'jammedJobs names the backed-up routine (world.js pins the amber stub off this)');
const jamQ = MaintQuestStore.quests().find(q => q.id === 'mq:cron-jam:job-9');
A.ok(jamQ && jamQ.status === 'open', 'a jammed routine mints its own maintenance quest');
A.ok(/keeps getting skipped/.test(jamQ.title), 'the jam quest names the problem');

/* ---------- a clean fire/result clears the jam ---------- */
cronOk('job-9');
A.eq(MaintQuestStore.jammedJobs().length, 0, 'a clean run clears the jam signal');
A.eq(MaintQuestStore.quests().find(q => q.id === 'mq:cron-jam:job-9').status, 'done', 'the jam quest clears when the routine drains');

/* ---------- dismissal: permanent, survives reload ---------- */
A.eq(MaintQuestStore.dismiss('mq:slag:budget'), true, 'dismissing an open fix-it takes (always dismissible)');
A.eq(MaintQuestStore.quests().some(q => q.id === 'mq:slag:budget'), false, 'a dismissed quest never re-renders');
MaintQuestStore.init();   // simulated reload
A.eq(MaintQuestStore.isDismissed('mq:slag:budget'), true, 'dismissal survives a reload');
ring = [diag('budget'), diag('budget')];
MaintQuestStore.sync();
A.eq(MaintQuestStore.quests().some(q => q.id === 'mq:slag:budget'), false, 'the same cause after reload NEVER re-mints (stop forever)');

/* ---------- an UNCHANGED recurring cause never saves + pokes (the 2026-10-07 QUEST LOG lag) ----------
   buildQuests calls sync(), and StationUI.rerender is synchronous: a sync that poked on every call re-entered the
   builder ~1,600 frames deep per poke, and the 1s tick re-armed it every second while the log was open. */
ring = [diag('error', 'errored out', 'top it up'), diag('error', 'errored out', 'top it up'), diag('error', 'errored out', 'top it up')];
MaintQuestStore.sync();
A.ok(MaintQuestStore.quests().some(q => q.id === 'mq:slag:error' && q.status === 'open'), 'three errored runs mint the fix-it quest');
rerenders.length = 0;
const savesBefore = global.localStorage.getItem('starnet.maintquests.v1');
MaintQuestStore.sync(); MaintQuestStore.sync(); MaintQuestStore.sync();
A.eq(rerenders.length, 0, 'an idle sync with the same recurring cause pokes NO rerender (was: one per sync, forever)');
A.eq(global.localStorage.getItem('starnet.maintquests.v1'), savesBefore, 'an idle sync writes nothing new');
ring.push(diag('error', 'errored out', 'top it up'));
MaintQuestStore.sync();
A.ok(rerenders.length === 1 && /4 runs/.test(MaintQuestStore.quests().find(q => q.id === 'mq:slag:error').title), 'a REAL change (a 4th failure) still pokes once');

/* ---------- a clean finish settles the failing agent's post-mortems (the ring holds only failures) ---------- */
const runEnd = p => (listeners['agent.run.end'] || []).forEach(fn => fn(p));
A.eq((listeners['agent.run.end'] || []).length, 1, 'the store listens for run ends (subscription only)');
ring = [Object.assign(diag('max_iters', 'looped without finishing', 'Split it.'), { agentId: 'a1' }),
  Object.assign(diag('max_iters', 'looped without finishing', 'Split it.'), { agentId: 'a1' })];
MaintQuestStore.sync();
A.eq(MaintQuestStore.quests().find(q => q.id === 'mq:slag:max_iters').status, 'open', 'two max_iters failures by a1 reopen the fix-it');
runEnd({ agentId: 'a2', runId: 'x', reason: 'done' });
A.eq(MaintQuestStore.quests().find(q => q.id === 'mq:slag:max_iters').status, 'open', 'ANOTHER agent finishing clean does not clear a1\'s problem');
runEnd({ agentId: 'a1', runId: 'y', reason: 'error' });
A.eq(MaintQuestStore.quests().find(q => q.id === 'mq:slag:max_iters').status, 'open', 'a failed run settles nothing');
runEnd({ agentId: 'a1', runId: 'z', reason: 'done' });
A.eq(MaintQuestStore.quests().find(q => q.id === 'mq:slag:max_iters').status, 'done', 'a1 finishing clean clears its fix-it — the line runs clean again');
A.eq(ring.length, 2, 'settling never edits the ring (the LOGBOOK still shows the history)');
ring.push(Object.assign(diag('max_iters'), { agentId: 'a1' }), Object.assign(diag('max_iters'), { agentId: 'a1' }));
MaintQuestStore.sync();
A.eq(MaintQuestStore.quests().find(q => q.id === 'mq:slag:max_iters').status, 'open', 'NEW failures after the clean run reopen it (only post-settle failures count)');

/* ---------- reset: the new-hero clean slate ---------- */
MaintQuestStore.reset();
A.eq(global.localStorage.getItem('starnet.maintquests.v1'), null, 'reset removes the self-persisted key');
A.eq(MaintQuestStore.jammedJobs().length, 0, 'reset drops the in-memory jam tally');

/* ---------- source-level locks: the browser wiring ---------- */
const qsSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/queststore.js'), 'utf8');
A.ok(/MaintQuestStore/.test(qsSrc) && /maintQuests/.test(qsSrc), 'queststore.view joins the maintenance quests into the one projection');
const stSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
A.ok(/MaintQuestStore/.test(stSrc) && /maintenance/.test(stSrc), 'stationui syncs + routes maintenance dismissals');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
A.ok(/MaintQuestStore\.init\(\)/.test(appSrc) && /MaintQuestStore\.reset\(\)/.test(appSrc), 'app.js inits + resets the generator');
const worldSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
A.ok(/slagPostmortems/.test(worldSrc), 'world.js exposes the SlagLog ring read the store consumes');
A.ok(/MaintQuestStore\.jammedJobs/.test(worldSrc), 'world.js reads jammedJobs to pin the amber JAM stub on the board');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
A.ok(/app\/maintquests\.js/.test(html) && /app\/maintqueststore\.js/.test(html), 'index.html loads the engine and the store');

A.report('maintqueststore.test');
