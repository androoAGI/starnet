/* node test/nightshift-futile-beat.e2e.test.js — THE FUTILE-BEAT SKIP over a real sidecar (cost fix W1.6).

   THE DEAD END: PriorWork.veto renames a re-proposal of the newest undecided build into "Continue: <base>". When that
   undecided build is itself "Continue: <base>", workshopStore.queue refuses the identical title and the beat ends
   'duplicate-backlog' — AFTER its lead-model candidate call and a leash unit were spent. On Andrew's station 31 of 39
   beats since 10-20 ended that way, each one re-proposing the same build while it waited on his verdict.

   THE INVARIANT (fails on e316231d7, passes with the skip): a station stuck on that dead end
     · makes 0 provider calls on its next beats, leaves beatsUsedToday unchanged, and writes ONE decline row naming
       the build it waits on (binding 'awaiting-verdict'); status says the same, read from the live backlog;
     · the hold survives a restart (the stuck state is reached in one boot, the next beats run in a second one);
     · it is NOT a limit: a new message re-enables the beat at once (it makes its call, ends on the same dead end, and
       holds again), and a verdict on the waited-on build re-enables it too;
     · it holds only a beat that would BUILD (review blocker, 11-09): with the away-workshop grant turned off the next
       beat is a reason-only draft, which queues nothing and so can never be the futile one — it runs and makes its
       call, status stops claiming a build verdict is awaited, and the marker is forgotten; with the grant back on, a
       build beat re-reaches the dead end and the hold returns. (Fails on the first lane cut, dcc3843f9: every draft
       beat stood down as 'awaiting-verdict' while status said buildMode 'draft'.)

   The stuck state is reached through the real pipeline, never seeded by hand: three force-fired beats build
   "Release checklist tool", build its continuation, then collide with that continuation. Boot 1 never ticks the driver
   (an hour-long tick), so only the force-fired beats run there; boot 2 ticks every 40 ms with a 1 ms away threshold and
   a 1 ms beat interval, so every tick in which a beat may fire asks the pre-spend gate. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { userWords } = require('./helpers/host-notes.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');

const HOST = '127.0.0.1';
const ACT_MARK = '[NIGHTSHIFT_ACT]';
const TITLE = 'Release checklist tool';
const CONT = 'Continue: ' + TITLE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter: counts every chat call by kind and the bytes of each propose request (the beat's lead-model call).
const calls = { propose: 0, act: 0, other: 0, draft: 0, proposeBytes: 0 };
function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let msgs = []; try { msgs = JSON.parse(body).messages || []; } catch (_) {}
        const prompt = userWords(msgs.find(m => m && m.role === 'user'));
        const toolResults = msgs.filter(m => m && m.role === 'tool').length;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
        const tool = (id, name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage }) + '\n\n');
        };
        const text = t => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
        };
        if (prompt.indexOf(ACT_MARK) === 0) {
          // the BUILD run: write the artifact, then the manifest, under the run dir the directive names
          if (toolResults === 0) calls.act++;
          const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
          const dir = 'workshop/' + runId;
          if (toolResults === 0) tool('f1', 'fs_write', { path: dir + '/tool.py', content: 'print("checklist")\n' });
          else if (toolResults === 1) {
            const job = ((prompt.match(/^- JOB: (.+)$/m) || [])[1] || TITLE).trim();
            tool('f2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify({ v: 1, runId, agentId: 'agent', backlogId: '', title: job, kind: 'tool', summary: 'A release checklist helper.', files: [{ path: 'tool.py', bytes: 19 }], howToUse: 'Run it.', notVerified: ['not executed'] }) });
          } else text('Built it.');
        } else if (prompt.indexOf('TITLE: <a short title for the draft>') >= 0) {
          // a reason-only DRAFT beat's do call (the away-workshop grant is off): it leaves no draft, so the desk and the
          // prior work the next build beat reads stay exactly as they were
          calls.draft++;
          text('');
        } else if (/JOB:/.test(prompt) && /GROUNDS:/.test(prompt)) {
          // the beat's PROPOSE call: a model that keeps re-proposing the same build (the observed dead end)
          calls.propose++; calls.proposeBytes += body.length;
          text(['JOB: ' + TITLE, 'KIND: advance-goal', 'GROUNDS: ship the StarNet beta to 100 users', 'CONFIDENCE: high', 'SPEC: a small script that walks the release checklist'].join('\n'));
        } else { calls.other++; text('ok'); }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return { known: ['goals', 'pain', 'stack', 'ambition'], beliefs: { goals: b('ship the StarNet beta to 100 users'), pain: b('manual release notes eat my fridays'), stack: b('node and a pixel-art canvas'), ambition: b('a living agent station people watch') } };
}

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; const events = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } }
  }
  return events;
}
async function fireBeat(fx) {
  const res = await fx.request('/api/nightshift/beat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'agent' }) });
  return ((await readNdjson(res)).find(e => e.name === 'nightshift.beat.result') || {}).payload || {};
}
async function status(fx) { return (await fx.json('GET', '/api/nightshift/status')).body || {}; }
async function ledger(fx) { const b = (await fx.json('GET', '/api/autonomy/ledger')).body; return (b && Array.isArray(b.entries)) ? b.entries : []; }
const verdictHolds = (rows, since) => rows.filter(e => e && e.source === 'nightshift' && e.kind === 'decline' && e.binding === 'awaiting-verdict' && Number(e.ts) >= since);
const nsCalls = () => calls.propose + calls.act;
// the provider has been quiet for `quietMs` (every background pass a build set off has finished)
async function settle(quietMs, maxMs) {
  const until = Date.now() + (maxMs || 20000);
  let last = calls.propose + calls.act + calls.other, quietSince = Date.now();
  while (Date.now() < until) {
    await sleep(100);
    const n = calls.propose + calls.act + calls.other;
    if (n !== last) { last = n; quietSince = Date.now(); }
    else if (Date.now() - quietSince >= quietMs) return true;
  }
  return false;
}
async function until(pred, maxMs) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { if (await pred()) return true; await sleep(100); }
  return false;
}

(async () => {
  const mock = await startMock();
  const fx = SidecarFixture.create({ prefix: 'sk-futile-beat-', env: { SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-futile-fake', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_QUEST_REFRESH: '0' } });
  seedActiveStation(fx.workspace);   // the night-shift tick stands down on a workspace with no founded station
  let runId2 = '';
  try {
    // ===== BOOT 1 — reach the stuck state through the real pipeline (the driver never ticks here) =====
    await fx.start({ SKYNET_NIGHTSHIFT_TICK_MS: '3600000' });
    await fx.deskJson('POST', '/api/workshop/grant', { agentId: 'agent', on: true });
    const posture = await fx.deskJson('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 12 }, beliefs: hotBeliefs(Date.now()) });
    A.ok(posture.body && posture.body.ok === true, 'the dial is raised to build unattended');

    const b1 = await fireBeat(fx);
    A.ok(b1.reason === 'built' && b1.title === TITLE, 'beat 1 builds "' + TITLE + '" (got ' + JSON.stringify({ reason: b1.reason, title: b1.title }) + ')');
    await settle(800);
    const b2 = await fireBeat(fx);
    runId2 = String(b2.runId || '');
    A.ok(b2.reason === 'built' && b2.title === CONT && runId2, 'beat 2 re-proposes it, the veto turns that into "' + CONT + '", and the continuation is built (got ' + JSON.stringify({ reason: b2.reason, title: b2.title }) + ')');
    await settle(800);
    const b3 = await fireBeat(fx);
    A.eq(b3.reason, 'duplicate-backlog', 'beat 3 re-proposes it again: the veto names the continuation itself and the queue refuses it (the dead end)');
    const pend = (await fx.json('GET', '/api/workshop/pending?agent=agent')).body || {};
    A.ok((pend.pending || []).some(m => m.runId === runId2 && m.title === CONT), 'the continuation waits on the desk, undecided');
    A.ok(await settle(800), 'the station is quiet before the restart');

    // ===== BOOT 2 — the scheduled driver ticks every 40 ms; the next beats of the stuck station =====
    // counted from BEFORE the restart: the driver already ticks while the fixture waits for the boot to answer
    const t0 = Date.now();
    const before = { ns: nsCalls(), bytes: calls.proposeBytes, other: calls.other };
    await fx.restart({ SKYNET_NIGHTSHIFT_TICK_MS: '40', SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_BEAT_MS: '1' });
    await sleep(2500);   // ~60 ticks, every one of them past the away threshold and the cooldown
    const s1 = await status(fx);
    const rows1 = verdictHolds(await ledger(fx), t0);
    const stuckCalls = nsCalls() - before.ns;
    console.log('measure: stuck window 2.5 s (~60 eligible ticks): night-shift provider calls=' + stuckCalls + ', propose bytes=' + (calls.proposeBytes - before.bytes) + ', other calls=' + (calls.other - before.other) + ', beatsUsedToday=' + s1.beatsUsedToday + ', binding=' + s1.binding);
    A.ok(s1.active === true && s1.away === true, 'the shift is armed and the Commander is away (every gate a clock clears is clear)');
    A.eq(stuckCalls, 0, 'INVARIANT: the stuck station\'s next beats made 0 provider calls');
    A.eq(s1.beatsUsedToday, 0, 'INVARIANT: beatsUsedToday is unchanged (no leash unit was spent)');
    A.eq(rows1.length, 1, 'INVARIANT: exactly one ledger row records the skip');
    A.ok(rows1[0] && rows1[0].detail && rows1[0].detail.preSpend === true && rows1[0].detail.waitingOn === CONT && rows1[0].detail.waitingRunId === runId2,
      'the row is a pre-spend decline naming the build it waits on (got ' + JSON.stringify(rows1[0] && rows1[0].detail) + ')');
    A.eq(s1.binding, 'awaiting-verdict', 'status names the binding the tick acts on');
    A.ok(s1.waitingOn && s1.waitingOn.title === CONT && s1.waitingOn.runId === runId2, 'status names the build, read from the live backlog (got ' + JSON.stringify(s1.waitingOn) + ')');

    // ===== NOT A LIMIT (1) — a new message re-enables the beat at once =====
    const ns1 = nsCalls(), used1 = Number(s1.beatsUsedToday) || 0;
    const run = await fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sk-or-v1-futile-fake', model: 'test/model', agentId: 'agent', messages: [{ role: 'user', content: 'also add a changelog section to the release notes' }] }) });
    { const rd = run.body.getReader(); while (!(await rd.read()).done) { /* drain */ } }
    const fired = await until(async () => nsCalls() > ns1, 15000);
    A.ok(fired, 'a new message re-enabled the beat: it made its provider call');
    await until(async () => { const s = await status(fx); return !s.inFlight && s.binding === 'awaiting-verdict'; }, 15000);
    await sleep(1500);   // the re-enabled beat ended on the same dead end: no further beat may fire
    const s2 = await status(fx);
    A.eq(nsCalls() - ns1, 1, 'exactly one beat ran on the new message, then the skip held again');
    A.eq((Number(s2.beatsUsedToday) || 0) - used1, 1, 'that beat spent exactly one leash unit');
    A.eq(s2.binding, 'awaiting-verdict', 'it ended on the same dead end, so the station waits on the verdict again');

    // ===== ONLY A BUILD BEAT IS HELD — the away-workshop grant off makes the next beat a reason-only draft =====
    const stuckFile = path.join(fx.workspace, 'nightshift.stuck.json');
    const marked = () => { try { return fs.readFileSync(stuckFile, 'utf8').indexOf(runId2) >= 0; } catch (_) { return false; } };
    A.ok(marked(), 'the futile beat is remembered on disk (it names the build it collided with)');
    const all = () => calls.propose + calls.act + calls.other + calls.draft;
    const before3 = all(), draft3 = calls.draft, used3 = Number(s2.beatsUsedToday) || 0, tOff = Date.now();
    const off = (await fx.deskJson('POST', '/api/workshop/grant', { agentId: 'agent', on: false })).body || {};
    A.ok(off.ok === true, 'the Commander turns the away-workshop grant off');
    A.ok(await until(async () => all() > before3, 15000), 'with the grant off, a scheduled beat makes its call: a reason-only draft is never held as futile');
    const sDraft = await status(fx);
    A.ok(sDraft.buildMode === 'draft' && sDraft.binding !== 'awaiting-verdict' && !sDraft.waitingOn,
      'status stops claiming a build verdict is awaited while the beats run as drafts (got ' + JSON.stringify({ buildMode: sDraft.buildMode, binding: sDraft.binding, waitingOn: sDraft.waitingOn }) + ')');
    A.ok((await ledger(fx)).some(e => e && e.source === 'nightshift' && e.kind === 'note' && e.reason === 'no-workshop-grant' && Number(e.ts) >= tOff), 'that beat ran as a reason-only draft (its own ledger note says so)');
    A.ok(!marked(), 'the draft beat forgot the futile one: its last beat is no longer the futile one');
    const on = (await fx.deskJson('POST', '/api/workshop/grant', { agentId: 'agent', on: true })).body || {};
    A.ok(on.ok === true, 'the grant goes back on');
    let sRe = {};
    const reheld = await until(async () => { sRe = await status(fx); return !sRe.inFlight && sRe.binding === 'awaiting-verdict' && !!sRe.waitingOn && sRe.waitingOn.title === CONT; }, 15000);
    A.ok(reheld && marked(), 'with the grant back on, a build beat re-reaches the dead end and the hold returns, naming the same build');
    console.log('measure: grant off then on: draft do calls=' + (calls.draft - draft3) + ', leash units spent across the drafts and the re-held build beat=' + ((Number(sRe.beatsUsedToday) || 0) - used3));
    const held3 = all();
    await sleep(1500);
    A.eq(all() - held3, 0, 'and holds: no further call while nothing else changes');

    // ===== NOT A LIMIT (2) — a verdict on the waited-on build re-enables the beat =====
    const ns2 = nsCalls();
    const disc = (await fx.json('POST', '/api/workshop/decide', { agentId: 'agent', runId: runId2, decision: 'discard' })).body || {};
    A.ok(disc.ok === true, 'the Commander discards the waited-on build');
    A.ok(await until(async () => nsCalls() > ns2, 15000), 'a verdict re-enabled the beat: it made its provider call');
    const s3 = await status(fx);
    A.ok(s3.binding !== 'awaiting-verdict' && !s3.waitingOn, 'nothing is awaited once the build is decided (got ' + JSON.stringify({ binding: s3.binding, waitingOn: s3.waitingOn }) + ')');
  } finally {
    await fx.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('nightshift-futile-beat.e2e.test');
})().catch(e => { console.log('FAIL: nightshift-futile-beat.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
