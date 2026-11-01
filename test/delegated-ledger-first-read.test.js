/* node test/delegated-ledger-first-read.test.js — the DELEGATED card never says a worker stopped before the station's
   ledger has answered (live walk 10-14).

   Reopening a conversation whose crew had worked read "3 stopped" for half a second and then "all 3 done", "2 stopped ·
   1 done" for 1.7 s, and "1 stopped · 2 done" while a worker was really waiting on an approval (then "1 needs you"):
   until Overseer's first /api/overseer answer lands its snapshot is null, every row looked like a worker with no record,
   and stateOf fell through to "ended without a result".

   GENUINE: the REAL Overseer (frontend/app/overseer.js, its fetch stubbed and held/answered/failed on cue) feeds the REAL
   Delegated.batches / stateOf / lineHtml — the same path a reopened page takes — across: before the first ledger read,
   the ledger says done, the ledger says a worker is waiting on an approval, and the ledger is unreachable. */
'use strict';
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)

(async () => {
  global.document = undefined;   // neither module wires its DOMContentLoaded poll: the test drives refresh() itself
  const OVERSEER = require.resolve('../frontend/app/overseer.js');
  const freshOverseer = () => { delete require.cache[OVERSEER]; return require(OVERSEER); };

  // ---- the page: a conversation 'home' that delegated three workers in one lead run, reopened ----
  const kid = (id, agentId, extra) => Object.assign({ id, agentId, title: id + ' task', worker: true, parentStreamId: 'home', createdAt: 1000, history: [], runIds: [] }, extra || {});
  let kids = [kid('k1', 'researcher'), kid('k2', 'designer'), kid('k3', 'writer')];
  const byId = id => (id === 'home' ? { id: 'home' } : kids.find(k => k.id === id));
  global.Workstreams = { generalId: () => 'general', activeId: () => 'home', get: byId, adopt: row => byId(row.id) || row, list: () => kids };
  global.App = { agentName: id => ({ researcher: 'MIRA', designer: 'ROOK', writer: 'VEX' })[id] || id, persist() {}, refreshRail() {} };
  const pend = new Map(), busy = new Set(), runOf = new Map();
  global.Channels = { pendingOf: id => (pend.get(id) || [])[0] || null, pendingAllOf: id => pend.get(id) || [], isBusy: id => busy.has(id), runIdOf: id => runOf.get(id) || '', elapsedOf: () => 0 };

  // ---- the station: /api/overseer held, answered or failed on cue ----
  let mode = 'hold', release = null, data = null;
  const realFetch = global.fetch, realDebug = console.debug;
  console.debug = () => {};   // Overseer logs each failed poll
  global.fetch = () => {
    if (mode === 'fail') return Promise.reject(new Error('offline'));
    if (mode === 'hold') return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => data }); });
    return Promise.resolve({ ok: true, json: async () => data });
  };
  const ledger = workers => ({ threads: kids.map((k, slot) => ({ id: k.id, parentStreamId: 'home', agentId: k.agentId, leadRunId: 'lead1', call: 'c1', slot })), reviews: [], workers });
  const done = (k, i) => ({ id: 'w' + i, runId: 'r' + i, streamId: k, parentStreamId: 'home', agentId: 'x', parentRunId: 'lead1', status: 'done', reason: 'done', startedAt: 1000, completedAt: 13000, canInterrupt: false });

  const D = require('../frontend/app/delegated.js');
  const card = () => { const b = D.batches('home'); A.eq(b.length, 1, 'one card for the lead run'); return { rows: b[0].rows.map(r => D.stateOf(r, 'home', b[0].lead)), html: D._internals.lineHtml(b[0], 'home') }; };
  const sumOf = html => (/dg-line-sum[^>]*>([^<]*)</.exec(html) || [])[1];
  const claimsAnEnd = html => /stopped|ended|without a result|failed|done|delivered|starting/i.test(html.replace(/k\d task/g, ''));

  /* 1. BEFORE THE FIRST LEDGER READ: the page has reopened and its first /api/overseer read is still on its way */
  global.Overseer = freshOverseer();
  const firstRead = global.Overseer.refresh();
  A.eq(global.Overseer.snapshot(), null, 'the first ledger read has not landed');
  A.eq(global.Overseer.unreachable(), false, '…and nothing says the station is down');
  {
    const { rows, html } = card();
    A.eq(rows.map(s => [s.cls, s.live, s.unread]), [['unknown', 'checking…', 'checking'], ['unknown', 'checking…', 'checking'], ['unknown', 'checking…', 'checking']],
      'every worker reads "checking…" until the ledger answers — never stopped or ended');
    A.eq(sumOf(html), 'checking…', 'the card header says it is checking: ' + sumOf(html));
    A.ok(!claimsAnEnd(html), 'nothing on the card claims a worker stopped, ended, failed, finished or is starting');
    A.ok(/aria-expanded="false"/.test(html), 'a row never seen running opens nothing (the settled card does not spring open, then fold)');
    A.ok(/dg-lamp unknown/.test(html) && !/dg-lamp (failed|stopped|working)/.test(html), 'the plain unlit lamp: neither the failed red nor the working pulse');
  }
  // a thread's own last recorded end is not the ledger's answer either: the ledger may hold a newer run on it
  kids[1] = kid('k2', 'designer', { runIds: ['r-old'], lastRunOk: true, lastRunReason: 'done' });
  kids[2] = kid('k3', 'writer', { runIds: ['r-old3'], lastRunOk: false, lastRunReason: 'aborted' });
  A.eq(card().rows.map(s => s.live), ['checking…', 'checking…', 'checking…'], 'a recorded end (done, or stopped) waits for the ledger too');
  kids = [kid('k1', 'researcher'), kid('k2', 'designer'), kid('k3', 'writer')];
  // the lead run is still live on this page: still no "starting" — the ledger has not said the worker has not started
  busy.add('home'); runOf.set('home', 'lead1');
  A.eq(card().rows[0].live, 'checking…', 'a live lead run is not proof its worker has not started');
  busy.clear(); runOf.clear();
  // live signals the page itself holds still show at once
  pend.set('home', [{ promptId: 'p0', tool: 'fs.write', agentId: 'agent', workerStreamId: 'k3', workerRunId: 'r3' }]);
  busy.add('k1'); runOf.set('k1', 'r1');
  {
    const { rows, html } = card();
    A.eq(rows.map(s => s.cls), ['working', 'unknown', 'waiting'], 'its own live channel (working) and its own ask (needs you) show before the ledger answers');
    A.eq(sumOf(html), '1 needs you · 1 working · 1 checking', 'and the header counts only what it can prove: ' + sumOf(html));
  }
  pend.clear(); busy.clear(); runOf.clear();

  /* 2. THE LEDGER SAYS DONE: the first read lands */
  data = ledger(kids.map((k, i) => done(k.id, i + 1)));
  release(); await firstRead;
  A.ok(global.Overseer.snapshot() && global.Overseer.fresh(), 'the ledger answered and is current');
  {
    const { rows, html } = card();
    A.eq(rows.map(s => s.cls + ':' + s.live), ['done:done', 'done:done', 'done:done'], 'every worker the ledger finished reads done');
    A.eq(sumOf(html), 'all 3 done', 'the header: ' + sumOf(html));
    A.ok(!/checking|stopped/.test(html), 'no checking, no stopped');
  }
  // a foreground worker the ledger has no record for, with nothing delivered: the answered ledger now makes that provable
  A.eq(D.stateOf({ ws: kid('k4', 'researcher'), worker: null }, 'home', 'lead1').live, 'ended without a result', 'once the ledger has answered, a worker absent from it that delivered nothing says so');

  /* 3. THE LEDGER SAYS A WORKER IS WAITING ON AN APPROVAL (it runs; its ask rides the lead's consent broker) */
  mode = 'answer';
  data = ledger([done('k1', 1), done('k2', 2), { id: 'w3', runId: 'r3', streamId: 'k3', parentStreamId: 'home', agentId: 'writer', parentRunId: 'lead1', status: 'running', startedAt: Date.now() - 5000, canInterrupt: true }]);
  await global.Overseer.refresh();
  A.eq(card().rows[2].cls, 'working', 'the ledger says it is running');
  pend.set('home', [{ promptId: 'p3', tool: 'fs.write', agentId: 'agent', workerStreamId: 'k3', workerRunId: 'r3', workerAgentId: 'writer' }]);
  {
    const { rows, html } = card();
    A.eq(rows.map(s => s.cls), ['done', 'done', 'waiting'], 'the worker waiting on you reads needs you — never stopped');
    A.eq(sumOf(html), '1 needs you · 2 done', 'the header: ' + sumOf(html));
    A.ok(/aria-expanded="true"/.test(html) && /data-dg-consent="once" data-dg-ws="k3" data-dg-prompt="p3"/.test(html), 'the card opens on it with Approve once on its row');
  }
  pend.clear();

  /* 4. THE LEDGER IS UNREACHABLE */
  // 4a. a running worker, then the station stops answering: the existing guard — neither working nor stopped
  mode = 'fail';
  await global.Overseer.refresh();
  A.eq(global.Overseer.fresh(), false, 'the failed poll: the ledger is no longer current');
  {
    const { rows, html } = card();
    A.eq(rows.map(s => s.cls + ':' + s.live), ['done:done', 'done:done', 'unknown:status unknown — station unreachable'], 'finished rows stay read; the running one claims nothing');
    A.eq(sumOf(html), '1 status unknown · 2 done', 'the header: ' + sumOf(html));
    A.ok(!/data-dg-stop=/.test(html) && /aria-expanded="true"/.test(html), 'no Stop key, and the card it was open on stays open');
  }
  // 4b. a page reopened while the station is down: its FIRST read fails — it says so, never "stopped"
  global.Overseer = freshOverseer();
  await global.Overseer.refresh();
  A.eq([global.Overseer.snapshot(), global.Overseer.unreachable()], [null, true], 'the first read failed: no answer, station unreachable');
  {
    const { rows, html } = card();
    A.eq(rows.map(s => [s.cls, s.live, s.unread]), [['unknown', 'status unknown — station unreachable', 'unreachable'], ['unknown', 'status unknown — station unreachable', 'unreachable'], ['unknown', 'status unknown — station unreachable', 'unreachable']],
      'every worker reads status unknown — station unreachable');
    A.eq(sumOf(html), '3 status unknown', 'the header: ' + sumOf(html));
    A.ok(!claimsAnEnd(html) && /aria-expanded="false"/.test(html), 'nothing claims an end, and rows never seen running open nothing');
  }
  // 4c. a first read that hangs past three beats is the station not answering too
  global.Overseer = freshOverseer();
  mode = 'hold';
  const stuck = global.Overseer.refresh();
  A.eq(card().rows[0].live, 'checking…', 'a first read on its way: checking…');
  const realNow = Date.now;
  Date.now = () => realNow() + 60000;
  try { A.eq(card().rows[0].live, 'status unknown — station unreachable', 'a first read hung past three beats: station unreachable'); }
  finally { Date.now = realNow; }
  data = ledger(kids.map((k, i) => done(k.id, i + 1)));
  release(); await stuck;
  A.eq(sumOf(card().html), 'all 3 done', 'and when it lands the ledger decides');

  delete global.Overseer; delete global.Workstreams; delete global.App; delete global.Channels; delete global.document;
  global.fetch = realFetch; console.debug = realDebug;
  A.report('delegated-ledger-first-read.test');
})().catch(e => { console.error(e); process.exit(1); });
