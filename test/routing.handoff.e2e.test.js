'use strict';
/* routing.handoff.e2e — SEND TO on a real sidecar (2026-10-10). LINE A's OUTBOX sends to LINE B's INBOX (a pointer on the OUTBOX,
   compiled into plan.sendTo — never a belt). A job sent down LINE A (POST /api/routing/sample with its line) delivers on A as
   always; the sidecar's handoff runner then starts LINE B's OWN job: a line-jobs record on B saying where it came from, A's record
   saying where it went, B's run rows stamped lineId B at B's bay by B's crew, and B handed the job as it arrived plus what A made.
   With the SEND TO set to nowhere, the same job stops at A. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a job that ships on LINE A rides on to LINE B by SEND TO', async () => {
  const calls = [];
  let fileProof = false, fileRequested = false;
  const server = http.createServer((req, res) => {
    if (req.url.includes('/chat/completions')) {
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const user = (body.messages || []).filter(m => m && m.role === 'user').map(m => userWords(m)).join('\n');
        const handoff = user.indexOf('[HAND-OFF') >= 0;   // (the roster's own system prompt wins over the hub persona)
        calls.push({ handoff, user, tools: (body.tools || []).map(t => t.function && t.function.name), results: (body.messages || []).filter(m => m.role === 'tool').map(m => m.content) });
        if (fileProof && !handoff && !fileRequested && user.startsWith('FILE PROOF') && body.tools && body.tools.length) {
          const settled = (body.messages || []).some(m => m.role === 'tool' && /Task Brief settled/.test(String(m.content || '')));
          const name = settled ? 'fs_write' : 'brief_proceed';
          const args = settled ? { path: 'handoff-note.txt', content: 'producer-owned file proof' }
            : { objective: 'Save handoff-note.txt', deliverable: 'the saved file and its path', success: 'the file contains producer-owned file proof' };
          fileRequested = settled;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-proof', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        const text = handoff ? 'B turned the facts into a haiku.' : 'Two facts about the moon.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: 'handoff-model', context_length: 8000 }] } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'handoff-', timeoutMs: 20000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1'
  } });
  try {
    seedActiveStation(fixture.workspace);
    await fixture.start();
    const agents = [
      { agentId: 'alpha', name: 'Alpha', system: 'Line A', provider: 'custom', model: 'handoff-model' },
      { agentId: 'beta', name: 'Beta', system: 'Line B', provider: 'custom', model: 'handoff-model' }
    ];
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    const geoOf = sendTo => ({ props: [
      { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1, label: 'A' },
      { id: 'p2', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'alpha', role: 'WRITER', brief: 'Write two short facts.' },
      Object.assign({ id: 'p3', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }, sendTo ? { sendTo } : {}),
      { id: 'p4', t: 'intake', x: 0, y: 4, w: 1, h: 1, label: 'B', limits: { maxHops: 2, maxUsdPerMessage: 0.5 } },
      { id: 'p5', t: 'bay', x: 3, y: 4, w: 1, h: 1, agentId: 'beta', role: 'WRITER', brief: 'Turn what you are handed into a haiku.' },
      { id: 'p6', t: 'outbox', x: 6, y: 4, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })).concat([1, 2, 4, 5].map(x => ({ x, y: 4, dir: 'E' }))) });
    // each floor is SAVED, then the page's hint of it is published: the station routes by what it saved
    const arm = async (geo) => (await publishFloor(fixture, floorOf(geo, { equip: ['computer', 'workbench'] }))).plan;
    const plan = await arm(geoOf('p4'));
    const LA = plan.lineOfProp.p1, LB = plan.lineOfProp.p4;
    assert.ok(LA && LB && LA !== LB, 'two lines, never fused');
    assert.deepEqual(plan.sendTo, { p3: { intakeId: 'p4', fromLine: LA, toLine: LB } });

    const sent = await fixture.json('POST', '/api/routing/sample', { line: LA, text: 'Two facts about the moon.', name: 'A' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    // (rc walk #30) the job's own answer says whether it counted in SHIPPED — and why not, only when its run rows prove it
    assert.equal(sent.body.shipped, false, 'a talk-only delivered job answers shipped:false (no SHIPPED receipt)');
    assert.equal(sent.body.shippedWhy, 'no-proven-work', '…with the proven reason: no step had a tool succeed or saved a file');
    let onB = [];
    for (let i = 0; i < 100 && !(onB.length && onB[0].status !== 'running'); i++) {
      await sleep(100);
      onB = (await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(LB))).body.jobs;
    }
    assert.equal(onB.length, 1, 'LINE B has one job: ' + JSON.stringify(onB));
    const y = (await fixture.json('GET', '/api/line-jobs/' + onB[0].id)).body.job;
    assert.equal(y.status, 'delivered', JSON.stringify({ status: y.status, error: y.error }));
    assert.deepEqual(y.from, { line: LA, jobId: sent.body.jobId, name: 'A' }, 'B’s job says it came from A’s');
    assert.equal(y.output, 'B turned the facts into a haiku.', 'B’s result is B’s');
    // the record keeps the job as it first arrived and what A handed in APART (the agent was handed the whole frame — below)
    assert.equal(y.text, 'Two facts about the moon.', 'B’s job is the job as it first arrived, never the frame');
    assert.equal(y.handedIn, 'Two facts about the moon.', 'what A handed in, whole');
    assert.ok(y.runs.length >= 1 && y.runs.every(r => r.dockId === 'p5' && r.agentId === 'beta' && r.reason === 'done'), 'B’s crew ran it at B’s bay: ' + JSON.stringify(y.runs));
    const x = (await fixture.json('GET', '/api/line-jobs/' + sent.body.jobId)).body.job;
    assert.equal(x.status, 'delivered');
    assert.equal(x.output, 'Two facts about the moon.', 'A’s result stays A’s');
    assert.deepEqual(x.sentTo, { line: LB, jobId: y.id, name: 'B' }, 'A’s job says where it went');
    // the run rows: B's stamped with B's line on B's stream (B's budget and day ledger key on that line)
    const rows = (await fixture.json('GET', '/api/runs?agent=beta&limit=20')).body;
    const runs = Array.isArray(rows) ? rows : (rows.runs || []);
    const bRow = runs.find(r => r && r.streamId === y.streamId);
    assert.ok(bRow && bRow.lineId === LB && bRow.dockId === 'p5' && bRow.reason === 'done', 'B’s run row is stamped with LINE B: ' + JSON.stringify(bRow && { lineId: bRow.lineId, dockId: bRow.dockId, streamId: bRow.streamId }));
    assert.ok(calls.some(c => c.handoff && /WHAT LINE A DELIVERED:\nTwo facts about the moon\./.test(c.user)), 'B’s agent was handed A’s result');

    assert.equal((await fixture.json('GET', '/api/routing/lines/stats?since=1')).body.lines.find(l => l.lineId === LA).shipped, 0, 'talk-only job is not proven productive work');

    // SEND TO nowhere: the same job stops at A
    await arm(geoOf(null));
    const again = await fixture.json('POST', '/api/routing/sample', { line: LA, text: 'Two more facts.', name: 'A' });
    assert.equal(again.status, 200);
    await sleep(500);
    assert.equal((await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(LB))).body.jobs.length, 1, 'nothing new on B');
    assert.equal((await fixture.json('GET', '/api/line-jobs/' + again.body.jobId)).body.job.sentTo, null);

    // the records survive a restart
    await fixture.restart();
    const after = (await fixture.json('GET', '/api/line-jobs/' + y.id)).body.job;
    assert.deepEqual(after.from, { line: LA, jobId: sent.body.jobId, name: 'A' });
    assert.equal(after.handedIn, 'Two facts about the moon.', 'what A handed in survives a restart');

    // A real relative fs.write artifact retains the producer's private workspace in the downstream prompt.
    fileProof = true;
    await arm(geoOf('p4'));
    const fileJob = await fixture.json('POST', '/api/routing/sample', { line: LA, text: 'FILE PROOF: save handoff-note.txt, then send the finished work.', name: 'A' });
    assert.equal(fileJob.status, 200, JSON.stringify(fileJob.body));
    // (review of #30) the productive case, at the route: the receipt is written before the sample answers, so a job that saved a
    // file reads shipped:true in its OWN 200 — never a "not counted in SHIPPED" beside a job SHIPPED did count
    assert.equal(fileJob.body.shipped, true, 'a job that saved a file answers shipped:true: ' + JSON.stringify({ shipped: fileJob.body.shipped, why: fileJob.body.shippedWhy }));
    assert.equal(fileJob.body.shippedWhy, undefined, '…and carries no reason word');
    let fileDownstream;
    for (let i = 0; i < 150; i++) {
      const jobs = (await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(LB))).body.jobs;
      fileDownstream = jobs.find(j => j.from && j.from.jobId === fileJob.body.jobId);
      if (fileDownstream && fileDownstream.status !== 'running') break;
      await sleep(100);
    }
    assert.ok(fileRequested, 'producer actually requested the file tool');
    const produced = path.join(fixture.workspace, 'alpha', 'handoff-note.txt');
    assert.ok(fs.existsSync(produced), 'file proof missing: ' + JSON.stringify(calls.filter(c => c.user.includes('FILE PROOF'))));
    assert.equal(fs.readFileSync(produced, 'utf8'), 'producer-owned file proof', 'real file exists in the producing workspace');
    assert.ok(fileDownstream && fileDownstream.status === 'delivered', 'file handoff reaches downstream terminal state: ' + JSON.stringify(fileDownstream));
    assert.ok(calls.some(c => c.handoff && c.user.includes(produced)), 'downstream receives the exact absolute producer path');
    assert.ok(!calls.some(c => c.handoff && c.user.includes(path.join(fixture.workspace, 'beta', 'handoff-note.txt'))), 'handoff never invents a path under the receiver');
    const shipped = async () => (await fixture.json('GET', '/api/routing/lines/stats?since=1')).body.lines.find(l => l.lineId === LA).shipped;
    assert.equal(await shipped(), 1, 'one productive completed job is one durable shipment');
    const disconnected = geoOf(null);
    disconnected.props = disconnected.props.filter(p => p.id !== 'p3');
    await arm(disconnected);
    assert.equal(await shipped(), 1, 'removing its OUTBOX cannot rewrite the previous shipment');
    await fixture.restart();
    assert.equal(await shipped(), 1, 'terminal-job receipt survives a real sidecar restart');
    // A semantic read failure is not permission to replace existing history.
    // Keep valid bytes locally, boot with an invalid envelope, then restore it
    // while the sidecar is running: the first failed read must remain retryable.
    await arm(geoOf(null));
    await fixture.stop();
    const receiptFile = path.join(fixture.workspace, 'line-shipments.json');
    const savedReceipts = fs.readFileSync(receiptFile, 'utf8');
    const invalidReceipts = JSON.stringify({ version: 1, value: { invalid: true } });
    fs.writeFileSync(receiptFile, invalidReceipts);
    await fixture.start();
    /* (runtime audit 2026-10-12) an unreadable shipment history makes SHIPPED unknown — never zero — and takes nothing else down:
       it used to answer 500, so RUNS / FAILED / $ against the cap / the bay lamps all went dark (and the page kept showing the
       last numbers it had while jobs and spend went on) */
    const unread = await fixture.json('GET', '/api/routing/lines/stats?since=1');
    assert.equal(unread.status, 200, 'the line numbers stay readable when only the shipment history is not: ' + unread.text.slice(0, 300));
    const unreadLA = unread.body.lines.find(l => l.lineId === LA);
    assert.equal(unreadLA.shipped, null, 'SHIPPED is unknown, not reported as zero shipments');
    assert.ok(/shipment history/.test(String(unread.body.shippedUnknown || '')) && unreadLA.shippedUnknown === unread.body.shippedUnknown, 'the answer and the line say why: ' + JSON.stringify(unread.body.shippedUnknown));
    assert.ok(typeof unreadLA.runs === 'number' && unreadLA.runs > 0 && typeof unreadLA.failed === 'number' && typeof unreadLA.usdToday === 'number', 'runs, failed and $ today still count: ' + JSON.stringify(unreadLA));
    assert.ok(unread.body.docks && Object.keys(unread.body.docks).length > 0, 'the bay lamps keep their last outcomes');
    const blind = await fixture.json('POST', '/api/routing/sample', { line: LA, text: 'Another short answer.', name: 'A' });
    assert.equal(blind.status, 200, 'receipt storage failure does not block actual work');
    assert.equal(blind.body.shipped, null, 'with the receipt history unreadable the job\'s answer is unknown (null), never false');
    assert.equal(blind.body.shippedWhy, undefined, '…so no reason is given');
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), invalidReceipts, 'a completed job cannot overwrite an unreadable prior history');
    fs.writeFileSync(receiptFile, savedReceipts);
    assert.equal(await shipped(), 1, 'next real stats poll retries and recovers the preserved history');

  } finally {
    await fixture.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});

/* (wave 2 review, conveyor-backend-03) SEND TO hand-offs WAITING in a line's queue when the station quits are said on their records:
   LINE B is busy with one hand-off while two more wait behind it; a graceful stop that sends NO E-STOP first (POST /api/lifecycle/quit
   on its own — what the desktop shell's ExitRequested path, stop_sidecar_gracefully, sends — and the same gracefulShutdown a SIGTERM,
   SIGINT or the IPC/CLI stop runs) drops the waiting ones through the refusal path. (The desktop tray Quit and a full window-close quit
   POST /api/halt FIRST — src-tauri drain_and_kill_sidecar — so there handleHalt had already said them as "automation is stopped
   (E-STOP)", before and after this fix; that Quit says E-STOP because it really sends one.) After the restart LINE B has ONE failed
   "not sent on" record counting both, and each sending job on LINE A reads NOT sent on, with why — they used to vanish with no record
   anywhere (A's jobs read DELIVERED with no "sent on" and no "NOT sent on"). Graceful shutdown now aborts and settles the active
   owned run before exit. A separate abrupt-kill arm below proves boot still marks an unfinalized hand-off interrupted. */
test('hand-offs waiting when the station quits are said, never lost', async () => {
  const held = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/chat/completions')) {
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const user = (body.messages || []).filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n');
        const reply = text => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
        };
        if (user.indexOf('[HAND-OFF') >= 0) { held.push(() => reply('B is still working.')); return; }   // LINE B never finishes: it stays busy
        reply('An answer from A.');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: 'handoff-model', context_length: 8000 }] } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'handoff-quit-', timeoutMs: 20000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1'
  } });
  try {
    seedActiveStation(fixture.workspace);
    await fixture.start();
    const agents = [
      { agentId: 'alpha', name: 'Alpha', system: 'Line A', provider: 'custom', model: 'handoff-model' },
      { agentId: 'beta', name: 'Beta', system: 'Line B', provider: 'custom', model: 'handoff-model' }
    ];
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    const { plan } = await publishFloor(fixture, floorOf({ props: [
      { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1, label: 'A' },
      { id: 'p2', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'alpha', role: 'WRITER', brief: 'Answer briefly.' },
      { id: 'p3', t: 'outbox', x: 6, y: 0, w: 1, h: 1, sendTo: 'p4' },
      { id: 'p4', t: 'intake', x: 0, y: 4, w: 1, h: 1, label: 'B' },
      { id: 'p5', t: 'bay', x: 3, y: 4, w: 1, h: 1, agentId: 'beta', role: 'WRITER', brief: 'Work on what you are handed.' },
      { id: 'p6', t: 'outbox', x: 6, y: 4, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })).concat([1, 2, 4, 5].map(x => ({ x, y: 4, dir: 'E' }))) }, { equip: ['computer', 'workbench'] }));
    const LA = plan.lineOfProp.p1, LB = plan.lineOfProp.p4;
    const onB = async () => (await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(LB))).body.jobs;
    const sent = [];
    for (let i = 0; i < 3; i++) {
      const r = await fixture.json('POST', '/api/routing/sample', { line: LA, text: 'Job ' + (i + 1) + ' for A.', name: 'A' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      sent.push(r.body.jobId);
      if (i === 0) { for (let k = 0; k < 100 && !held.length; k++) await sleep(50); assert.equal(held.length, 1, 'LINE B is working on the first hand-off'); }
    }
    await sleep(200);
    const before = await onB();
    assert.equal(before.length, 1, 'one hand-off runs on B, two wait behind it: ' + JSON.stringify(before.map(j => j.status)));
    assert.equal(before[0].status, 'running');
    const exited = new Promise(r => fixture.child.once('exit', r));
    assert.equal((await fixture.json('POST', '/api/lifecycle/quit')).status, 202);
    await exited;
    await fixture.stop();
    const quitJobs = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'line-jobs.json'), 'utf8')).jobs;
    const settledAtQuit = quitJobs.find(j => j.id === before[0].id);
    assert.deepEqual([settledAtQuit.status, settledAtQuit.outcome, settledAtQuit.stop && settledAtQuit.stop.code], ['stopped', 'stopped', 'stopped'],
      'graceful shutdown durably settles the owned hand-off with its typed stop before any restart');
    for (const f of held.splice(0)) f();
    await fixture.start();
    const after = await onB();
    const refused = after.find(j => j.status === 'failed');
    assert.ok(refused, 'LINE B has a record of the hand-offs that never ran: ' + JSON.stringify(after.map(j => ({ status: j.status, error: j.error }))));
    const rec = (await fixture.json('GET', '/api/line-jobs/' + refused.id)).body.job;
    assert.equal(rec.error, 'not sent on: the station stopped before this hand-off ran — send the job again', 'it says why');
    assert.equal(rec.repeats, 2, 'one record counts both waiting hand-offs');
    assert.deepEqual(rec.from && rec.from.line, LA, 'from LINE A');
    for (const id of sent.slice(1)) {
      const x = (await fixture.json('GET', '/api/line-jobs/' + id)).body.job;
      assert.ok(x.sentTo && x.sentTo.line === LB && /station stopped before this hand-off ran/.test(x.sentTo.refused || ''), 'each sending job reads NOT sent on, with why: ' + JSON.stringify(x.sentTo));
    }
    const first = (await fixture.json('GET', '/api/line-jobs/' + sent[0])).body.job;
    assert.ok(first.sentTo && first.sentTo.line === LB && !first.sentTo.refused, 'the first job was sent on (its B job ran)');
    const ran = after.find(j => j.id === first.sentTo.jobId);
    assert.deepEqual([ran && ran.status, ran && ran.outcome, ran && ran.stop && ran.stop.code], ['stopped', 'stopped', 'stopped'],
      'restart preserves the already-settled graceful stop');

    // An abrupt exit cannot run the owned finalizer. This is the distinct interrupted-at-boot contract.
    const crashSend = await fixture.json('POST', '/api/routing/sample', { line: LA, text: 'Crash-only hand-off.', name: 'A' });
    assert.equal(crashSend.status, 200, JSON.stringify(crashSend.body));
    for (let k = 0; k < 100 && !held.length; k++) await sleep(50);
    assert.equal(held.length, 1, 'the crash arm has an actual in-flight hand-off at the provider');
    const crashJobs = await onB(), crashJob = crashJobs.find(j => j.status === 'running');
    assert.ok(crashJob, 'the crash arm starts a distinct running B job');
    const beforeCrash = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'line-jobs.json'), 'utf8')).jobs.find(j => j.id === crashJob.id);
    assert.equal(beforeCrash.status, 'running', 'the unfinalized hand-off is actually durable before the abrupt exit');
    const crashed = new Promise(resolve => fixture.child.once('exit', resolve));
    fixture.child.kill('SIGKILL');
    await crashed;
    await fixture.stop();
    for (const release of held.splice(0)) release();
    await fixture.start();
    const interrupted = (await fixture.json('GET', '/api/line-jobs/' + crashJob.id)).body.job;
    assert.deepEqual([interrupted.status, interrupted.outcome], ['interrupted', 'interrupted'], 'actual abrupt death remains interrupted after boot');
    assert.match(interrupted.error, /send it again/, 'the unfinished hand-off gives the existing recovery instruction');
  } finally {
    for (const f of held.splice(0)) f();
    await fixture.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
