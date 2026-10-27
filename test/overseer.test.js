'use strict';
const { readSidecarSource } = require('./helpers/source');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOverseer, isCoordinatorRun } = require('../sidecar/overseer.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');

(async () => {
  assert.equal(isCoordinatorRun({ agentId: 'agent', surface: 'interactive', lead: true }), true, 'COMMS orchestrator opts into automatic follow-through');
  assert.equal(isCoordinatorRun({ agentId: 'custom_researcher', surface: 'interactive', lead: true }), false, 'specialists keep existing behavior');
  assert.equal(isCoordinatorRun({ agentId: 'agent', surface: 'autonomous', lead: true }), false, 'scheduled work keeps existing behavior');
  assert.equal(isCoordinatorRun({ agentId: 'agent', surface: 'interactive', lead: true, floorless: true }), false, 'channel approvals do not opt external conversations in');
  assert.equal(isCoordinatorRun({ agentId: 'agent', surface: 'autonomous', lead: true, syntheticTrigger: true }), true, 'already-admitted orchestration can follow through');
  assert.equal(isCoordinatorRun({ agentId: 'agent', surface: 'interactive', lead: true, internal: true }), false, 'internal helper requests do not coordinate the crew');

  /* station.read_session as the OVERSEER answers it (org P29-sys review): the interactive lead's session.peek reaches
     overseerStation, never the page handler, so a goal-loop step (a user-role turn the Commander never typed) must read as
     the station's 'Goal step: <goal>' HERE too, from transcript rows and from the saved-history fallback alike. */
  {
    const { readSessionTurns } = require('../sidecar/overseer.js');
    const GL = require('../frontend/app/goalloop.js');
    const sent = GL.continuationPrompt(GL.create('ship the landing page', { now: 1 }));
    const rows = [
      { role: 'user', content: 'set up the launch' },
      { role: 'user', content: sent },
      { role: 'user', content: '[Continuing toward your standing goal]\nGoal: old goal\n\nContinue working toward this goal. ' },
      { role: 'tool', content: 'ignored' },
      { role: 'assistant', content: 'Drafted the hero.' }
    ];
    const read = readSessionTurns(rows, []);
    assert.deepEqual(read.map(t => t.speaker), ['user', 'station', 'station', 'assistant'], 'goal steps (current + pre-org-pass head) read as the station, never as the Commander');
    assert.equal(read[1].text, 'Goal step: ship the landing page', 'the step names its goal, never the internal continuation prompt');
    assert.equal(read[1].sys, true, 'flagged as a station line');
    assert.equal(read[2].text, 'Goal step: old goal', 'an old saved step too');
    assert.ok(!read.some(t => /Continue working toward this goal|\[Continuing toward/.test(t.text)), 'no continuation prompt text reaches the reading lead');
    assert.equal(read[0].text, 'set up the launch', 'the Commander\'s own words are untouched');
    // the saved workstream history fallback (no transcript rows yet) reads the same way, and a delegated brief keeps its speaker
    const fb = readSessionTurns([], [
      { role: 'user', content: 'hidden', hidden: true },
      { role: 'user', content: sent },
      { role: 'user', from: 'agent', content: '[Continuing toward your session goal]\nGoal: not a step\n\nContinue working toward this goal. ' },
      { role: 'assistant', content: 'ok' }
    ]);
    assert.deepEqual(fb.map(t => [t.speaker, t.text.slice(0, 20)]), [['station', 'Goal step: ship the '], ['user', '[Continuing toward y'], ['assistant', 'ok']],
      'the saved-history fallback labels the step too; a delegated brief (m.from) keeps its own speaker; hidden turns stay out');
    assert.equal(sent, GL.continuationPrompt(GL.create('ship the landing page', { now: 1 })), 'what the goal loop sends the model for its own continuation is unchanged');
    // and overseerStation's read_session is wired through it (sidecar/index.js is never required here: it boots a sidecar)
    const idx = readSidecarSource();
    const at = idx.indexOf("if (verb === 'station.read_session') {");
    const block = at >= 0 ? idx.slice(at, idx.indexOf('return stationBridge.request(verb, args);', at)) : '';
    assert.ok(/readSessionTurns\(\s*transcriptStore\.history\(w\.id, \{[^}]*\}\), w\.history\)/.test(block) && !/speaker: m\.role/.test(block),
      'overseerStation answers read_session through readSessionTurns (no raw speaker: m.role mapping left)');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-overseer-'));
  let serial = 0;
  const saved = { generalId: 'home', workstreams: [{ id: 'home', title: null, agentId: 'agent' }], deletedIds: [] };
  const deps = { fs, path, file: path.join(root, 'overseer.json'), now: () => ++serial,
    newId: () => 'thread_' + ++serial, sessions: () => saved, hasAgent: id => ['agent', 'researcher'].includes(id) };
  try {
    let manager = makeOverseer(deps);
    const projectRoot = path.join(root, 'workspace-home');
    assert.equal(manager.projectHome(projectRoot, 'Workspace', false), null, 'read does not create a conversation');
    const project = manager.projectHome(projectRoot, 'Workspace', true);
    assert.equal(manager.projectHome(projectRoot, 'Renamed folder', true).id, project.id, 'reopening reuses the project conversation');
    manager = makeOverseer(deps);
    assert.equal(manager.projectHome(projectRoot, 'Workspace', true).id, project.id, 'project identity survives restart');
    assert.equal(manager.resolve(project.id).projectHome, true);
    const otherProject = manager.projectHome(path.join(root, 'other-project'), 'Other project', true);
    assert.notEqual(project.id, otherProject.id, 'different projects do not share conversation identity');
    saved.workstreams[0].projectRoot = path.join(root, 'project-alpha');
    const child = manager.create({ title: 'Research', agentId: 'researcher', parentStreamId: 'home', requestId: 'create_1', projectRoot: 'untrusted-model-root' });
    assert.equal(child.parentStreamId, 'home');
    assert.equal(child.projectRoot, saved.workstreams[0].projectRoot, 'scope comes from the parent, never tool arguments');
    assert.equal(manager.create({ title: 'Research', parentStreamId: 'home', requestId: 'create_1' }).id, child.id);
    assert.throws(() => manager.create({ title: 'Research', parentStreamId: 'home' }), /already exists/);
    assert.throws(() => manager.create({ title: 'Other', parentStreamId: 'missing' }), /no such/);
    manager = makeOverseer(deps);
    assert.equal(manager.resolve(child.id).title, 'Research');
    saved.workstreams.push({ ...child, title: 'Renamed research' });
    assert.equal(manager.resolve(child.id).title, 'Renamed research');

    const workers = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'workers.json'),
      clock: { now: () => ++serial }, newId: () => 'worker_' + ++serial });
    workers.start({ leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', streamId: child.id },
      async () => ({ status: 'done', reason: 'done', result: 'Findings' }));
    await new Promise(resolve => setImmediate(resolve));
    manager.collect(workers.list()); manager.collect(workers.list());
    manager.collect([{ ...workers.list()[0], id: 'specialist-work', runId: 'specialist-run', leadId: 'researcher' }]);
    assert.equal(manager.snapshot().reviews.length, 1, 'completion replay must not duplicate review');
    const review = manager.snapshot().reviews[0];
    assert.equal(review.childStreamId, child.id);
    manager.patchReview(review.id, { status: 'reviewing', reviewRunId: 'review_1' });
    manager = makeOverseer(deps);
    assert.equal(manager.snapshot().reviews[0].reviewRunId, 'review_1', 'restart preserves exact review attempt');

    let release;
    const order = [];
    const first = manager.withThread('home', async () => { order.push('first'); await new Promise(r => { release = r; }); throw new Error('failed'); });
    await new Promise(resolve => setImmediate(resolve));
    const second = manager.withThread('home', async () => { order.push('second'); });
    await manager.withThread('other', async () => { order.push('other'); });
    assert.deepEqual(order, ['first', 'other']);
    const caught = assert.rejects(first, /failed/); release(); await caught; await second;
    assert.deepEqual(order, ['first', 'other', 'second']);
    manager.stopReviews();
    manager = makeOverseer(deps);
    assert.equal(manager.snapshot().paused, true, 'stop survives restart');
    assert.equal(manager.snapshot().reviews[0].status, 'cancelled');
    manager.resumeReviews();
    assert.equal(manager.snapshot().paused, false);
    assert.equal(manager.snapshot().reviews[0].status, 'cancelled', 'resuming does not replay cancelled work');
    let diskFull = true;
    const failedDisk = new Proxy(fs, { get(target, key) {
      if (key === 'writeSync' && diskFull) return () => { throw new Error('simulated full disk'); };
      return target[key];
    } });
    const failedStop = makeOverseer({ ...deps, fs: failedDisk });
    const stoppedWorker = { ...workers.list()[0], runId: 'stop-during-disk-failure' };
    assert.throws(() => failedStop.stopReviews([stoppedWorker]), /simulated full disk/);
    assert.equal(failedStop.snapshot().paused, true, 'a failed durable stop still blocks admission in memory');
    assert.throws(() => failedStop.resumeReviews(), /simulated full disk/);
    assert.equal(failedStop.snapshot().paused, true, 'a failed resume does not silently release the emergency stop');
    diskFull = false;
    failedStop.resumeReviews();
    failedStop.collect([stoppedWorker]);
    assert.equal(failedStop.snapshot().reviews.find(r => r.workerRunId === stoppedWorker.runId).status, 'cancelled', 'storage recovery cannot resurrect a stopped worker');
    assert.equal(makeOverseer(deps).snapshot().reviews.find(r => r.workerRunId === stoppedWorker.runId).status, 'cancelled', 'recovered cancellation survives restart');
    const corruptPath = path.join(root, 'corrupt-overseer.json');
    fs.writeFileSync(corruptPath, '{broken');
    const unavailable = makeOverseer({ ...deps, file: corruptPath });
    assert.equal(unavailable.snapshot().paused, true, 'corrupt optional state disables coordination without crashing app boot');
    assert.match(unavailable.snapshot().error, /unavailable/);
    unavailable.resumeReviews();
    assert.throws(() => unavailable.create({ title: 'No overwrite', parentStreamId: 'home' }), /unavailable/);
    assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{broken', 'damaged state is retained for recovery');
    saved.deletedIds.push(child.id); saved.workstreams = saved.workstreams.filter(w => w.id !== child.id);
    assert.throws(() => manager.resolve(child.id), /no such/, 'deleted threads stay deleted');
    // a brand-new conversation the page has not saved yet: its delegating run files it, then its worker threads
    assert.throws(() => manager.create({ title: 'Too early', parentStreamId: 'ws_fresh', agentId: 'researcher' }), /no such session/);
    const fresh = manager.ensure({ id: 'ws_fresh', title: '', agentId: 'agent', projectRoot: '' });
    assert.equal(fresh.id, 'ws_fresh', 'the asking run files its own conversation');
    assert.equal(manager.create({ title: 'Scan competitors', parentStreamId: 'ws_fresh', agentId: 'researcher', requestId: 'r:c:0' }).parentStreamId, 'ws_fresh', 'so the first ask in a new chat still gets its worker threads');
    assert.equal(manager.ensure({ id: 'ws_fresh', agentId: 'agent' }).id, 'ws_fresh', 'filing it again is a no-op');
    const workerRow = manager.create({ title: 'Worker thread', parentStreamId: 'ws_fresh', agentId: 'researcher', requestId: 'r:c:1', worker: true });
    const madeRow = manager.create({ title: 'A session the agent opened', parentStreamId: 'ws_fresh', agentId: 'agent', requestId: 'r:made' });
    const snap = manager.snapshot().threads;
    assert.equal(snap.find(t => t.id === workerRow.id).worker, true, 'a delegated worker thread is marked a worker');
    assert.equal(snap.find(t => t.id === madeRow.id).worker, false, 'a session.create session is not (it keeps its own row on the page)');
    // review seams-09: a worker's requestId is '<leadRunId>:<call>:<slot>'. The delegation card keeps each dispatch
    // call's workers together by `call`, so two calls in one lead run never interleave their rows.
    const secondCall = manager.create({ title: 'Second call worker', parentStreamId: 'ws_fresh', agentId: 'researcher', requestId: 'lead1:c9:1', worker: true });
    const colonTitle = manager.create({ title: 'Q3: plan', parentStreamId: 'ws_fresh', agentId: 'agent', requestId: 'lead1:Q3: plan' });
    const calls = manager.snapshot().threads;
    assert.equal(calls.find(t => t.id === workerRow.id).call, 'c', 'a worker thread carries its dispatch call');
    assert.equal(calls.find(t => t.id === secondCall.id).call, 'c9', 'each dispatch call is its own segment');
    assert.equal(calls.find(t => t.id === secondCall.id).slot, 1, 'the slot is still the last segment');
    assert.equal(calls.find(t => t.id === secondCall.id).leadRunId, 'lead1');
    assert.equal(calls.find(t => t.id === madeRow.id).call, '', 'a session.create thread (<leadRunId>:<title>) has no call');
    assert.equal(calls.find(t => t.id === colonTitle.id).call, '', 'a colon in a session title is never read as a dispatch call');
    saved.workstreams.push({ id: 'ws_fresh', title: 'Launch prep', agentId: 'agent' });
    assert.equal(manager.resolve('ws_fresh').title, 'Launch prep', 'once the page saves it, the page copy wins');
    assert.throws(() => manager.ensure({ id: child.id, agentId: 'agent' }), /no such session/, 'a deleted conversation is never brought back');

    // COST + GROWTH (review threads-backend-07). A routine that delegates the same ask every day used to load and
    // parse the whole save file twice per taken title; filing a worker now costs one load whatever the repeats.
    {
      let loads = 0, now = 1000;
      const page = { generalId: 'home', workstreams: [{ id: 'home', title: 'Home', agentId: 'agent' }], deletedIds: [] };
      const cdeps = { fs, path, file: path.join(root, 'overseer-cost.json'), now: () => now,
        newId: () => 'ws_cost_' + ++serial, sessions: () => { loads++; return JSON.parse(JSON.stringify(page)); },
        hasAgent: id => ['agent', 'researcher'].includes(id), reviewRetentionMs: 1000 };
      const ov = makeOverseer(cdeps);
      const file = (title, n) => ov.create({ parentStreamId: 'home', agentId: 'researcher', requestId: 'lead' + n + ':team.dispatch:0', title, worker: true, uniqueTitle: true });
      loads = 0;
      assert.equal(file('Summarize my inbox', 1).title, 'Summarize my inbox');
      assert.equal(loads, 1, 'filing a worker thread loads the save once');
      for (let n = 2; n <= 5; n++) file('Summarize my inbox', n);
      loads = 0;
      const sixth = file('Summarize my inbox', 6);
      assert.equal(sixth.title, 'Summarize my inbox (6)', 'a repeated ask counts up to a free title');
      assert.equal(loads, 1, 'a repeated title still costs one save load, not one per taken title');
      assert.equal(ov.create({ parentStreamId: 'home', agentId: 'researcher', requestId: 'plain-worker', title: 'Summarize my inbox', worker: true }).title, 'Summarize my inbox (7)', 'a worker thread picks a free title even without uniqueTitle (the production caller passes none)');
      assert.throws(() => ov.create({ parentStreamId: 'home', agentId: 'researcher', title: 'Home' }), /already exists/, 'a session the Commander sees still refuses a taken title');
      const long = 'x'.repeat(80);
      file(long, 7);
      assert.equal(file(long, 8).title, 'x'.repeat(76) + ' (2)', 'a suffix fits inside the 80-char title instead of being cut off');
      for (let n = 2; n <= 99; n++) page.workstreams.push({ id: 'page_' + n, title: 'Weekly scan (' + n + ')', agentId: 'agent' });
      page.workstreams.push({ id: 'page_1', title: 'Weekly scan', agentId: 'agent' });
      const a = file('Weekly scan', 9), b = file('Weekly scan', 10);
      assert.match(a.title, /^Weekly scan · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'past 99 the time it was asked names it');
      assert.notEqual(a.title, b.title, 'two such workers in the same second still both get a thread');
      // a thread the Commander deleted is dropped from overseer.json the next time a thread is filed
      page.deletedIds.push(sixth.id);
      file('After delete', 11);
      assert.ok(!JSON.parse(fs.readFileSync(cdeps.file, 'utf8')).value.threads.some(t => t.id === sixth.id), 'deleted thread rows do not pile up in overseer.json');
      assert.throws(() => ov.ensure({ id: sixth.id, agentId: 'agent' }), /no such session/, 'a pruned deleted conversation is still never brought back');
      // settled reports whose workers the registry no longer holds stop growing overseer.json; covered work is never re-reported
      const worker = (id, runId) => ({ id, runId, generation: 1, leadId: 'agent', agentId: 'researcher', parentStreamId: 'home', parentRunId: 'lead_' + id, streamId: 'home', status: 'done', completedAt: now });
      ov.collect([worker('w_old', 'run_old'), worker('w_kept', 'run_kept')]);
      for (const r of ov.snapshot().reviews) ov.patchReview(r.id, { status: 'done' });
      assert.equal(ov.snapshot().reviews.length, 2);
      now += 5000;
      ov.collect([worker('w_kept', 'run_kept')]);
      assert.deepEqual(ov.snapshot().reviews.map(r => r.workerRunId), ['run_kept'], 'an old settled report whose worker is gone is dropped; one whose worker is still listed is kept');
      ov.collect([worker('w_kept', 'run_kept')]);
      assert.equal(ov.snapshot().reviews.length, 1, 'a kept report still covers its worker (no second report)');
    }
    // WIRING (review threads-backend-07 follow-up): the production caller is sidecar/index.js childThread. Run ITS code
    // (sliced from the source, never required: requiring index.js boots a sidecar) against a counted save, so the
    // saving reaches the place workers are actually filed.
    {
      const src = readSidecarSource();
      const at = src.indexOf('childThread: ');
      assert.ok(at > 0, 'index.js still files workers through childThread');
      const body = require('./_assert.js').fnBody(src.slice(at, at + 4000), '(a) => {');
      assert.ok(body.length > 40 && body.length < 4000 && /overseer\.create\(/.test(body), 'childThread body found');
      let loads = 0, now = 5000;
      const page = { generalId: 'home', workstreams: [{ id: 'home', title: 'Home', agentId: 'agent' }], deletedIds: [] };
      const ov = makeOverseer({ fs, path, file: path.join(root, 'overseer-wiring.json'), now: () => now,
        newId: () => 'ws_wire_' + ++serial, sessions: () => { loads++; return JSON.parse(JSON.stringify(page)); },
        hasAgent: id => ['agent', 'researcher'].includes(id) });
      const childThread = new Function('o', 'agentId', 'overseer', 'return ' + body)({ streamId: 'home', sessionTitle: 'Home' }, 'agent', ov);
      const ask = n => childThread({ parentStreamId: 'home', agentId: 'researcher', requestId: 'wire' + n + ':team.dispatch:0', projectRoot: '', title: 'Daily digest' });
      loads = 0; ask(1);
      const firstCost = loads;
      for (let n = 2; n <= 20; n++) ask(n);
      loads = 0;
      assert.equal(ask(21).title, 'Daily digest (21)', 'the 21st repeat of an ask counts up to a free title');
      assert.equal(loads, firstCost, 'the 21st repeat of an ask costs the same save loads as the first, not one more per day');
      for (let n = 22; n <= 99; n++) page.workstreams.push({ id: 'page_wire_' + n, title: 'Daily digest (' + n + ')', agentId: 'agent' });
      const x = ask(100), y = ask(101);
      assert.ok(x && y && x.title !== y.title, 'two same-titled workers in the same second both get a thread');
    }
    assert.equal(require('./_assert.js').fails(), 0, 'shared assertion helpers have no pending failures');
    console.log('overseer: durable identity, deduplication, restart, rename, tombstones and turn serialization PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
