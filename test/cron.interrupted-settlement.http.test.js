/* node test/cron.interrupted-settlement.http.test.js — a routine run killed between FIRE and SETTLEMENT is honestly
   abandoned on the routine itself, never left reporting the previous run's "ok" (sweep/autonomy 2026-10-20).

   THE HOLE (found live: hard-kill the sidecar while a recurring routine's model stream is open, reboot): the cron
   driver had already persisted the advanced nextRunAt (advance-before-run), the run died before markRun, and the
   boot scan wrote the run's interrupted history row WITHOUT the cronJobId its journal carries. So after the reboot:
     · GET /api/cron still said lastRunId = the PREVIOUS run, lastStatus 'ok', state 'scheduled' — the ROUTINES row
       read "last ✓ ok 1h ago · next in 1h" about a routine whose newest occurrence fired, spent and died;
     · GET /api/cron/history?id=<job> returned [] — the interrupted occurrence was invisible on its own routine.
   Now the interrupted row carries the journal's cronJobId, and the routine record names the interrupted run
   (lastRunId/lastStatus 'error'/lastReason 'interrupted') without re-arming it, counting it as a routine failure, or
   touching a routine that already settled a LATER occurrence. Real isolated sidecar, seeded journal, two boots. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootToken } = require('./_httpToken.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = ms => new Date(ms).toISOString();

function bootSidecar(port, workspaces, attempts) {
  return new Promise((resolve, reject) => {
    const appSandbox = path.join(workspaces, '_appdata');
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^(STARNET_|SKYNET_|HERMES_)/i.test(k)) delete env[k];
    Object.assign(env, {
      SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1', SKYNET_QUEST_REFRESH: '0',
      SKYNET_CLOUD_URL: '', SKYNET_CREDITS_URL: '', SKYNET_EDGE_TTS: '0', SKYNET_LIVE_PRICES: '0',
      LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
    });
    if (!path.resolve(workspaces).startsWith(path.resolve(os.tmpdir())) || port === 8787) throw new Error('refusing a non-isolated sidecar');
    const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.includes('http://' + HOST + ':' + port)) { settled = true; resolve({ child, port }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attempts > 0) resolve(allocatePort().then(next => bootSidecar(next, workspaces, attempts - 1)));
        else reject(new Error('no free sidecar port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('sidecar boot timeout:\n' + out)); } }, 15000);
  });
}
function kill(child) { return new Promise(r => { try { child.once('exit', () => r()); child.kill(); } catch (_) { r(); } setTimeout(r, 3000); }); }

const NOW = Date.now();
const PREV_AT = NOW - 2 * 3600000;        // the previous, settled occurrence
const INT_AT = NOW - 30 * 60000;          // the occurrence that fired and died
const NEXT_AT = NOW + 30 * 60000;         // advance-before-run already persisted this

function seed(ws) {
  const sched = cron.parseSchedule('every 1h', NOW);
  const base = (id, extra) => Object.assign(cronStore.makeJob({ name: id, prompt: 'Summarize the station.', schedule: sched, agentId: 'agent' }, { id, now: PREV_AT }), extra);
  const jobs = [
    // fired at INT_AT, process died before markRun — must be honestly marked interrupted
    base('hourly', { lastRunAt: iso(PREV_AT), lastRunId: 'prev-ok', lastStatus: 'ok', lastReason: 'done', nextRunAt: iso(NEXT_AT), repeat: { times: null, completed: 4 } }),
    // a LATER occurrence already settled after its old interrupted run started — must stay exactly as it is
    base('later', { lastRunAt: iso(NOW - 5 * 60000), lastRunId: 'later-ok', lastStatus: 'ok', lastReason: 'done', nextRunAt: iso(NEXT_AT) })
  ];
  fs.writeFileSync(path.join(ws, 'cron.jobs.json'), JSON.stringify({ version: 1, jobs }, null, 2));
  const dir = path.join(ws, '.run-journal');
  let tick = INT_AT;
  const j = makeRunJournal({ dir, clock: { now: () => (tick += 1000) } });
  const msgs = [{ role: 'system', content: 'Fixture system' }, { role: 'user', content: 'Summarize the station.' }];
  j.begin({ runId: 'cron-int', agentId: 'agent', streamId: 'cron-cron-int', trigger: 'schedule', model: 'test/model', provider: 'openrouter', surface: 'autonomous', userTitle: 'Summarize the station.', startedAt: INT_AT, cronJobId: 'hourly', cronJobName: 'hourly' });
  j.checkpoint('cron-int', { phase: 'initial', turn: 0, messages: msgs });
  tick = NOW - 40 * 60000;
  j.begin({ runId: 'cron-old', agentId: 'agent', streamId: 'cron-cron-old', trigger: 'schedule', model: 'test/model', provider: 'openrouter', surface: 'autonomous', userTitle: 'Summarize the station.', startedAt: NOW - 40 * 60000, cronJobId: 'later', cronJobName: 'later' });
  j.checkpoint('cron-old', { phase: 'initial', turn: 0, messages: msgs });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-interrupted-'));
  seed(ws);
  let child = null, port = 0, token = '';
  const B = () => 'http://' + HOST + ':' + port;
  const get = async route => (await fetch(B() + route, { headers: { 'X-StarNet-Token': token } })).json();
  async function until(fn, ms, label) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + label); await sleep(150); }
  }
  const jobOf = async id => ((await get('/api/cron')).jobs || []).find(x => x.id === id);
  const histOf = async id => ((await get('/api/cron/history?id=' + id + '&limit=10')).runs || []);
  try {
    // ---------------- boot 1 ----------------
    ({ child, port } = await bootSidecar(await allocatePort(), ws, 30));
    token = await bootToken(B(), B());
    const runs = await until(async () => { const h = await histOf('hourly'); return h.some(r => r.runId === 'cron-int') ? h : null; }, 10000, 'the interrupted run on its routine history').catch(() => []);
    const row = runs.find(r => r.runId === 'cron-int');
    A.ok(!!row, 'the interrupted occurrence appears in its own routine\'s history (the row carries the journal cronJobId)');
    A.eq(row && row.reason, 'interrupted', 'its history row says interrupted, not done');
    A.eq(row && row.spendUnknown, true, 'its spend is served as unknown (never as a free $0 run)');
    const job = await until(async () => { const x = await jobOf('hourly'); return x && x.lastRunId === 'cron-int' ? x : null; }, 6000, 'the routine record to name the interrupted run').catch(async () => jobOf('hourly'));
    A.eq([job.lastRunId, job.lastStatus, job.lastReason], ['cron-int', 'error', 'interrupted'], 'the routine record names the interrupted run instead of the previous run\'s ok');
    A.ok(/interrupted/.test(job.lastError || ''), 'the routine carries a plain interrupted line');
    A.eq(job.lastRunAt, iso(INT_AT), 'the routine\'s last run time is the interrupted occurrence\'s start, not the previous run');
    A.eq([job.enabled, job.nextRunAt, job.repeat && job.repeat.completed, Number(job.consecutiveFailures) || 0], [true, iso(NEXT_AT), 4, 0], 'nothing is re-armed, completed or counted toward auto-pause — the occurrence is abandoned, not retried');
    const later = await jobOf('later');
    A.eq([later.lastRunId, later.lastStatus, later.lastRunAt], ['later-ok', 'ok', iso(NOW - 5 * 60000)], 'a routine that settled a LATER occurrence is never rewritten by an older interrupted run');
    A.ok((await histOf('later')).some(r => r.runId === 'cron-old' && r.reason === 'interrupted'), 'the older interrupted run still shows on its routine history');
    await kill(child);

    // ---------------- boot 2 ----------------
    ({ child, port } = await bootSidecar(await allocatePort(), ws, 30));
    token = await bootToken(B(), B());
    await get('/api/run-recoveries');   // the listing converges history too — must stay idempotent
    await sleep(1500);
    const again = await jobOf('hourly');
    A.eq([again.lastRunId, again.lastStatus, again.lastRunAt, again.nextRunAt], ['cron-int', 'error', iso(INT_AT), iso(NEXT_AT)], 'a second boot leaves the honest record exactly as it was');
    A.eq((await histOf('hourly')).filter(r => r.runId === 'cron-int').length, 1, 'still exactly one history row for the interrupted run');
  } finally {
    try { if (child) await kill(child); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cron.interrupted-settlement.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
