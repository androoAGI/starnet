/* node test/line-hold.e2e.http.test.js — HOLD, RESTART, DECIDE, DELIVER, ON A REAL STATION (line-hold lane, S4; invariants
   approve-resumes-from-the-cursor, one-decision-wins, resume-rechecks-authority).

   One real sidecar over a temp workspace, with a local OpenAI-compatible model standing in for the provider. The work line is
   drafter -> reviewer -> LOOP gate -> PUBLISHER -> OUTBOX. A job whose reviewer answers VERDICT: blocked parks (S3). Then, through the
   routes the WORKFLOWS window uses:

     - a real restart finds the job still held and buys nothing; APPROVE (POST /api/line-jobs/<id>/decision) runs the PUBLISHER stage
       once from the saved cursor, the job DELIVERS once, the deliverables library lists it, and a duplicate POST buys no provider call;
       a second restart changes nothing;
     - SEND BACK carries the person's note to the drafter (pass 2 of the gate), the reviewer approves, the publisher delivers;
     - DELETE on a held job is STOP: finished 'stopped', nothing bought;
     - E-STOP engaged: the decision is refused (409) with the reason, the job stays held, nothing is bought.

   Run against the S3 tip this goes RED at the first decision: the route does not exist. */
const assert = require('node:assert/strict');
const http = require('node:http');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { geometry, AFTER } = require('./helpers/line-hold-rig.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

const BLOCKED_REPLY = 'This is not safe to publish.\nVERDICT: blocked';
(async () => {
  const calls = [];   // { model, prompt } for every provider call
  let verdict = 'blocked', draft = 'A first draft of the post.';
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('/models') ? { data: ['draft-model', 'review-model', 'publish-model'].map(id => ({ id, context_length: 8000 })) } : { ok: true }));
    }
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw), last = (body.messages || []).slice(-1)[0] || {};
      calls.push({ model: body.model, prompt: String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) });
      const text = body.model === 'review-model' ? (verdict === 'blocked' ? BLOCKED_REPLY : 'Looks good.\nVERDICT: approved')
        : body.model === 'publish-model' ? 'The post is live: ' + 'published once.' : draft;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-hold-e2e-', timeoutMs: 40000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1',
    STARNET_LIVE_PRICES: '0', STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: ''
  } });
  const api = (method, route, body) => fixture.json(method, route, body);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const paid = () => calls.length, models = from => calls.slice(from).map(c => c.model);
  const job = async id => (await api('GET', '/api/line-jobs/' + id)).body.job;
  const until = async (id, pred, what) => {
    for (let i = 0; i < 160; i++) { const j = await job(id); if (pred(j)) return j; await sleep(125); }
    { const z = await job(id); throw new Error('timed out waiting for ' + what + ': ' + JSON.stringify({ status: z.status, stop: z.stop, error: z.error, runs: z.runs && z.runs.map(r => [r.agentId, r.reason, r.outcome, r.failureCode]), term: z.continuation && z.continuation.terminal })); }
  };
  try {
    await fixture.start();
    await api('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const agents = [{ agentId: 'drafter', name: 'Drafter', system: 'Draft.', provider: 'custom', model: 'draft-model' },
      { agentId: 'reviewer', name: 'Reviewer', system: 'Review.', provider: 'custom', model: 'review-model' },
      { agentId: 'publisher', name: 'Publisher', system: 'Publish.', provider: 'custom', model: 'publish-model' }];
    const crew = async () => assert.equal((await api('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);   // the page pushes its crew when it connects
    await crew();
    const geo = geometry({ maxIter: 3 }, AFTER);
    // the floor is SAVED, and that is what routes (the saved floor is the routing authority; a posted plan is only the page's hint of it): a console in the room gives each bay its object
    const published = await publishFloor({ json: api }, floorOf(geo), { label: 'the review line' });
    const line = published.plan.lineOfProp.p1;
    const send = async text => { const r = await api('POST', '/api/routing/sample', { line, text, name: 'Post' }); return r.body.jobId; };
    const decide = (id, body) => api('POST', '/api/line-jobs/' + id + '/decision', body);

    /* ---- hold, restart, APPROVE, delivered once ---- */
    const id = await send('Write a post about the moon.');
    let j = await job(id);
    A.eq([j.status, j.continuation.phase, j.continuation.hold.allowed, paid()], ['held', 'held', ['approve', 'send_back', 'stop'], 2], 'the job parks held after the entry stage and the reviewer');
    await fixture.restart();
    j = await job(id);
    const saved = j.continuation.walk.lastHanded;
    A.eq([j.status, paid(), saved], ['held', 2, draft], 'after a real restart: still held, the draft is saved, boot bought nothing');
    // the crew cannot run the next stage right now (the saved floor now brings the station up routing with no page, so it is the PUBLISHER's model that is missing, as when a
    // crew has not loaded or a credential is lost): the station cannot vouch that the next stage can run, so it refuses the decision
    assert.equal((await api('POST', '/api/roster', { agents: agents.map(a => a.agentId === 'publisher' ? Object.assign({}, a, { model: '' }) : a), updatedAt: Date.now() })).status, 200);
    const early = await decide(id, { action: 'approve', token: 'tok-early', revision: j.continuation.revision, note: '' });
    j = await job(id);
    A.eq([early.status, early.body.refused, /cannot run now/.test(early.body.error), j.status, j.resumeRefused && j.resumeRefused.token, paid()], [409, true, true, 'held', 'tok-early', 2], 'before the crew loads the decision is refused with the reason, nothing is bought, the job stays held');
    await crew();
    const revision = j.continuation.revision;
    const before = paid();
    const d1 = await decide(id, { action: 'approve', token: 'tok-approve-1', revision, note: '' });
    A.eq([d1.status, d1.body.ok, d1.body.running], [202, true, true], 'APPROVE is claimed and carried on: 202');
    j = await until(id, x => x.status === 'delivered', 'the delivery');
    A.eq([j.outcome, models(before), j.output], ['delivered', ['publish-model'], 'The post is live: published once.'], 'the PUBLISHER stage ran once from the saved cursor; its answer is the delivery');
    A.ok(calls[before].prompt.includes(saved) && !calls[before].prompt.includes('VERDICT: blocked'), 'it was handed the saved draft and not the reviewer\'s block');
    const c = j.continuation;
    A.eq([c.phase, c.publication.state, c.decisions.map(d => [d.token, d.action, d.state]), c.activeDecision, c.accounting.dayReceipts.length, c.attempts.length], ['complete', 'confirmed', [['tok-early', 'approve', 'refused'], ['tok-approve-1', 'approve', 'complete']], null, 0, 3], 'the saved record is complete: the refused decision stays history, the decision done, the publication confirmed, the new stage recorded');
    A.ok((await api('GET', '/api/deliverables')).text.includes('line:' + id), 'the delivered job is in the deliverables library now');
    const dup = await decide(id, { action: 'approve', token: 'tok-approve-1', revision, note: '' });
    await sleep(800);
    A.eq([dup.status, dup.body.replayed, dup.body.receipt.token, paid()], [200, true, 'tok-approve-1', before + 1], 'a duplicate POST is the saved receipt and buys no provider call');
    const other = await decide(id, { action: 'approve', token: 'tok-approve-2', revision, note: '' });
    A.eq([other.status, paid()], [409, before + 1], 'another decision on the finished job is refused');
    await fixture.restart();
    const after = await job(id);
    await sleep(1200);
    A.eq([after.status, JSON.stringify(after), paid()], ['delivered', JSON.stringify(j), before + 1], 'a second restart: delivered, byte for byte, nothing re-run');

    /* ---- STOP: DELETE on a held job ---- */
    await crew();
    const stopId = await send('Write a post about the sun.');
    const before2 = paid();
    const del = await api('DELETE', '/api/line-jobs/' + stopId);
    j = await job(stopId);
    A.eq([del.status, del.body.ok, j.status, j.outcome, j.stop.code, j.output, paid()], [200, true, 'stopped', 'stopped', 'stopped', '', before2], 'DELETE on a held job is STOP: finished stopped, nothing bought');
    A.eq(j.continuation.decisions.map(d => [d.action, d.state]), [['stop', 'complete']], 'as a claimed STOP decision');
    const del2 = await api('DELETE', '/api/line-jobs/' + stopId);
    A.eq([del2.status, paid()], [200, before2], 'a second DELETE changes nothing');
    const stop2Id = await send('Write a post about the wind.');
    const before2b = paid();
    const postStop = await api('POST', '/api/line-jobs/' + stop2Id + '/stop', {});
    j = await job(stop2Id);
    A.eq([postStop.status, postStop.body.ok, j.status, j.stop.code, paid()], [200, true, 'stopped', 'stopped', before2b], 'POST …/stop is DELETE for a client that only posts: on a held job it is the STOP decision');
    const stopDone = await api('POST', '/api/line-jobs/' + id + '/stop', {});
    A.eq([stopDone.status, stopDone.body.stopRequested, (await job(id)).status, paid()], [200, false, 'delivered', before2b], 'on a finished job it asks for nothing and changes nothing');

    /* ---- SEND BACK twice: the note reaches the drafter, the pass count moves on, a second block is a SECOND hold on the same job,
       and the next SEND BACK goes round once more under the same cap until the reviewer approves and the publisher delivers ---- */
    const backId = await send('Write a post about the stars.');
    j = await job(backId);
    A.eq([j.status, j.continuation.hold.pass, j.continuation.walk.gates.map(g => [g.count, g.max])], ['held', 0, [[0, 3]]], 'held at pass 0 of a gate of 3');
    const before3 = paid();
    draft = 'A second draft of the post.';
    const sb1 = await decide(backId, { action: 'send_back', token: 'tok-back-1', revision: j.continuation.revision, note: 'make it shorter' });
    A.eq([sb1.status, sb1.body.ok], [202, true], 'SEND BACK is claimed and carried on');
    j = await until(backId, x => x.status === 'held' && x.continuation.revision > 1 && x.continuation.hold.pass === 1, 'the second hold');
    A.eq(models(before3), ['draft-model', 'review-model'], 'the drafter and the reviewer ran again, once each');
    A.ok(calls[before3].prompt.includes('make it shorter') && calls[before3].prompt.includes('pass 1 of 3') && calls[before3].prompt.includes('A first draft of the post.'), 'the drafter was handed the note of the person, the work under review and "pass 1 of 3"');
    A.eq([j.continuation.walk.gates.map(g => [g.count, g.max]), j.continuation.walk.lastHanded, j.continuation.attempts.length, j.continuation.decisions.map(d => [d.token, d.state]), j.continuation.activeDecision],
      [[[1, 3]], 'A second draft of the post.', 4, [['tok-back-1', 'complete']], null], 'held AGAIN on the same job: pass 1 of the same cap of 3, the new draft under review, every stage recorded, the first decision complete');
    const before3b = paid();
    verdict = 'approved'; draft = 'A third draft of the post.';
    const sb2 = await decide(backId, { action: 'send_back', token: 'tok-back-2', revision: j.continuation.revision, note: 'and friendlier' });
    A.eq([sb2.status, sb2.body.ok], [202, true], 'the second hold takes its own decision');
    j = await until(backId, x => x.status === 'delivered', 'the delivery');
    A.eq(models(before3b), ['draft-model', 'review-model', 'publish-model'], 'the drafter, the reviewer and the publisher ran once each, in order');
    A.ok(calls[before3b].prompt.includes('and friendlier') && calls[before3b].prompt.includes('pass 2 of 3'), 'the second note and "pass 2 of 3": the count moved on, the cap did not reset');
    A.eq([j.output, j.continuation.decisions.map(d => d.state), j.continuation.attempts.length], ['The post is live: published once.', ['complete', 'complete'], 7], 'delivered, both decisions complete, every stage recorded');
    verdict = 'blocked'; draft = 'A first draft of the post.';

    /* ---- E-STOP: the decision is refused, the job stays held ---- */
    const estopId = await send('Write a post about the sea.');
    j = await job(estopId);
    const before4 = paid();
    assert.equal((await api('POST', '/api/halt', {})).status, 200);
    const refused = await decide(estopId, { action: 'approve', token: 'tok-estop-1', revision: j.continuation.revision, note: '' });
    j = await job(estopId);
    A.eq([refused.status, refused.body.ok, refused.body.refused, /E-STOP is engaged/.test(refused.body.error), j.status, j.resumeRefused && j.resumeRefused.token, paid()],
      [409, false, true, true, 'held', 'tok-estop-1', before4], 'E-STOP engaged: refused (409), the reason is the answer, the job stays held, nothing bought');
    const stopThrough = await decide(estopId, { action: 'stop', token: 'tok-estop-2', revision: j.continuation.revision, note: '' });
    A.eq([stopThrough.status, (await job(estopId)).status, paid()], [200, 'stopped', before4], 'STOP still works under E-STOP: it buys nothing');
    A.report('line-hold.e2e.http');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
