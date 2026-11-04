'use strict';
/* node test/line-hold.restart.http.test.js — A HELD JOB SURVIVES A REAL RESTART (line-hold lane, S3; invariant restart-keeps-the-hold).

   One real sidecar over a temp workspace, booted TWICE, with a local OpenAI-compatible model standing in for the provider. A work line
   (drafter -> reviewer -> LOOP gate -> OUTBOX) is sent a job whose reviewer answers VERDICT: blocked. The walk parks:

     - the job is HELD (not finished, not delivered) with its saved walk, on the very record the WORKFLOWS window reads, and the route says so;
     - a real process restart finds the same job id, the same continuation revision, the same draft, cursor and taint — and boot made ZERO
       provider calls and never turned the job into 'interrupted';
     - the DELIVERABLES library never lists it (a job waiting for a person is no finished output), while an approved job on the same line is.

   Run against the S2 tip this goes RED at the first read: the job is a terminal 'problem' with no continuation. */
const assert = require('node:assert/strict');
const http = require('node:http');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { geometry } = require('./helpers/line-hold-rig.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

const BLOCKED_REPLY = 'This is not safe to publish.\nVERDICT: blocked';
(async () => {
  const calls = [];
  let verdict = 'blocked';
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: 'draft-model', context_length: 8000 }, { id: 'review-model', context_length: 8000 }] } : { ok: true }));
    }
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw), reviewer = body.model === 'review-model';
      calls.push(body.model);
      const text = reviewer ? (verdict === 'blocked' ? BLOCKED_REPLY : 'Looks good.\nVERDICT: approved') : 'A first draft of the post.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-hold-', timeoutMs: 30000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1',
    STARNET_LIVE_PRICES: '0', STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: ''
  } });
  const api = async (method, route, body) => { const out = await fixture.json(method, route, body); return out; };
  const paid = () => calls.filter(m => m === 'draft-model' || m === 'review-model').length;
  try {
    await fixture.start();
    await api('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const agents = [{ agentId: 'drafter', name: 'Drafter', system: 'Draft.', provider: 'custom', model: 'draft-model' },
      { agentId: 'reviewer', name: 'Reviewer', system: 'Review.', provider: 'custom', model: 'review-model' }];
    assert.equal((await api('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    const geo = geometry({ maxIter: 3 });
    // the floor is SAVED, and that is what routes (the saved floor is the routing authority; a posted plan is only the page's hint of it): a console in the room gives each bay its object
    const published = await publishFloor({ json: api }, floorOf(geo), { label: 'the review line' });
    const line = published.plan.lineOfProp.p1;

    /* ---- the job parks ---- */
    const sent = await api('POST', '/api/routing/sample', { line, text: 'Write a post about the moon.', name: 'Moon post' });
    A.eq([sent.status, sent.body.ok, sent.body.outcome, sent.body.stop && sent.body.stop.code], [502, false, 'blocked', 'blocked'], 'the route says the job did not deliver: blocked');
    const id = sent.body.jobId;
    A.ok(/^job-[a-z0-9]{8,24}$/.test(String(id)), 'the answer names the durable job: ' + id);
    A.eq(paid(), 2, 'the entry stage and the reviewer ran: two paid calls');
    const first = await api('GET', '/api/line-jobs/' + id), job = first.body.job, c = job.continuation;
    A.eq([first.status, job.status, job.outcome, job.endedAt], [200, 'held', 'blocked', null], 'the record is HELD, not finished');
    A.eq([c.version, c.revision, c.phase, c.hold.reason, c.hold.pass, c.hold.allowed, c.origin.kind], [1, 1, 'held', 'blocked', 0, ['approve', 'send_back', 'stop'], 'sample'], 'a version 1 hold at the gate, first revision, from the sample door');
    A.eq([c.walk.lastHanded, c.walk.product.text, c.walk.current.agentId, c.walk.next.kind, c.restriction.taints], ['A first draft of the post.', BLOCKED_REPLY, 'reviewer', 'gate', []], 'the draft under review, the reviewer\'s word, the cursor and the taint are saved');
    A.ok(Math.abs(job.usd - (c.accounting.entryUsd + c.accounting.hopUsd)) < 1e-9 && c.accounting.dayReceipts.length === 0 && c.attempts.length === 2, 'the saved spend is the two stages\' own, noted nowhere again');
    A.eq(job.output, '', 'a held job shows no delivered output');
    const row = (await api('GET', '/api/line-jobs?line=' + encodeURIComponent(line))).body.jobs.find(j => j.id === id);
    A.eq([row.status, row.endedAt, row.hold && row.hold.reason, row.hold && row.hold.allowed, row.continuation.phase, row.steps], ['held', null, 'blocked', ['approve', 'send_back', 'stop'], 'held', 2], 'WORKFLOWS lists it as held, with what may be decided');
    // the deliverables library lists finished jobs; an approved one (the control) is there, the held one is not
    verdict = 'approved';
    const approved = await api('POST', '/api/routing/sample', { line, text: 'Write a post about the sun.', name: 'Sun post' });
    verdict = 'blocked';
    A.eq([approved.status, approved.body.ok], [200, true], 'control: the same line delivers when its reviewer approves');
    const library = await api('GET', '/api/deliverables');
    A.ok(library.text.includes('line:' + approved.body.jobId), 'control: the approved job is in the deliverables library');
    A.ok(!library.text.includes('line:' + id), 'the held job is NOT in the deliverables library: it is no finished output');

    /* ---- a real restart ---- */
    const callsBefore = calls.length;
    const saved = JSON.stringify(job);
    await fixture.restart();
    const after = await api('GET', '/api/line-jobs/' + id);
    A.eq([after.status, after.body.job.status, after.body.job.outcome, after.body.job.endedAt], [200, 'held', 'blocked', null], 'after a real restart the job is still HELD (not interrupted)');
    A.eq(JSON.stringify(after.body.job), saved, 'the job id, continuation revision, draft, cursor and taint are byte for byte the saved ones');
    A.eq(after.body.job.continuation.revision, 1, 'the continuation revision did not move');
    await new Promise(r => setTimeout(r, 1500));   // boot's own quiet window: nothing may spend while the job waits
    A.eq([calls.length, paid()], [callsBefore, 4], 'boot made zero provider calls (the held job\'s two stages and the approved control\'s two are all there is: ' + callsBefore + ' before the restart, ' + calls.length + ' after)');
    const list = (await api('GET', '/api/line-jobs?line=' + encodeURIComponent(line))).body.jobs;
    A.eq(list.filter(j => j.status === 'held').map(j => j.id), [id], 'the list after the restart: the held job is still held');
    A.eq(list.find(j => j.id === approved.body.jobId).status, 'delivered', 'and the delivered one is still delivered');
    A.ok(!(await api('GET', '/api/deliverables')).text.includes('line:' + id), 'still not a deliverable after the restart');
    A.eq([(await api('GET', '/api/line-jobs/' + id)).body.job.continuation.revision, calls.length], [1, callsBefore], 'repeated reads buy nothing and change nothing');
    A.report('line-hold.restart.http');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
