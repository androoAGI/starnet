/* node test/remote-routines-scheduler.test.js — the phone's routine list says when scheduling is OFF or E-STOPped (quick win 30,
   bug 96dcbade).

   The phone's SETTINGS › Routines showed every enabled routine with a live green dot and its cadence ("every day at 9am") while
   the station's scheduling was OFF or the E-STOP was engaged — the same routines the desk panel, the apps list and GET /api/cron
   report as not running. The host now reads the scheduler's own state (cronStateSnapshot enabled / halted) and marks each row
   `held`; the phone shows a live dot and cadence only for a routine that can actually fire.

   Proves: (A) the host marks rows held 'off' / 'halted' from the scheduler, and leaves them unheld when it is on; (B) index.js
   hands the host that state (its wiring block, sliced); (C) the phone renders no live dot and no cadence for a held routine. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeRemoteHost } = require('../sidecar/remote/host.js');
const { readSidecarSource } = require('./helpers/source.js');

(async () => {
  // ---- A. the host ----
  {
    let sched = { enabled: true, halted: false };
    const host = makeRemoteHost({ now: () => 1, newId: () => 'x', broadcast: () => {}, roster: () => [], liveRuns: () => [],
      routines: () => [{ id: 'j1', name: 'morning brief', agentId: 'a', enabled: true, scheduleDisplay: 'every day at 9am' }, { id: 'j2', enabled: false }],
      scheduler: () => sched });
    let rows = await host.routines();
    A.eq(rows[0].held, null, 'scheduling ON: an enabled routine is not held');
    sched = { enabled: false, halted: false };
    rows = await host.routines();
    A.eq(rows[0].held, 'off', 'scheduling OFF: every routine is held "off", whatever its own switch says');
    A.eq(rows[1].held, 'off', '…a paused one too (it could not fire either way)');
    A.eq(rows[0].enabled, true, 'the routine\'s own switch is still reported as it is (Pause / Resume acts on it)');
    sched = { enabled: true, halted: true };
    rows = await host.routines();
    A.eq(rows[0].held, 'halted', 'E-STOP engaged: held "halted"');
    const legacy = makeRemoteHost({ now: () => 1, newId: () => 'x', broadcast: () => {}, roster: () => [], liveRuns: () => [],
      routines: () => [{ id: 'j1', enabled: true }] });
    A.eq((await legacy.routines())[0].held, undefined, 'a host given no scheduler state says nothing about it (never a guessed "held")');
    const throwing = makeRemoteHost({ now: () => 1, newId: () => 'x', broadcast: () => {}, roster: () => [], liveRuns: () => [],
      routines: () => [{ id: 'j1', enabled: true }], scheduler: () => { throw new Error('boom'); } });
    A.eq((await throwing.routines())[0].held, undefined, 'an unreadable scheduler state is unknown, never "on"');
  }

  // ---- B. index.js hands the host the scheduler's own state ----
  {
    const src = readSidecarSource();
    const at = src.indexOf("const remoteHost = require('./remote/host.js').makeRemoteHost({");
    A.ok(at > 0, 'fixture: the remote host wiring is found');
    const block = src.slice(at, src.indexOf('\n});', at) + 4);
    A.ok(/scheduler: \(\) => \{[^\n]*cronStateSnapshot\(Date\.now\(\)\)[^\n]*enabled[^\n]*halted/.test(block), 'the host reads enabled AND halted from cronStateSnapshot');
  }

  // ---- C. the phone ----
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'relay', 'app', 'app.js'), 'utf8');
    const at = app.indexOf('function renderSettings(v) {');
    const fn = app.slice(at, app.indexOf('\n  function ', at + 10));
    A.ok(fn.length > 200, 'fixture: renderSettings is sliced');
    A.ok(/'dot' \+ \(j\.inFlight \? ' work' : \(j\.enabled && !j\.held\) \? ' ok' : ''\)/.test(fn), 'a held routine gets no live dot');
    A.ok(/j\.held === 'halted'/.test(fn) && /j\.held === 'off'/.test(fn), 'and its line names the E-STOP or the scheduling switch instead of a cadence');
  }

  A.report('remote-routines-scheduler.test');
})().catch(e => { A.ok(false, e && e.stack); A.report('remote-routines-scheduler.test'); });
