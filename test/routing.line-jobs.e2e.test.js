'use strict';
/* routing.line-jobs.e2e — WORKFLOWS on a real sidecar (2026-09-30, "the easiest conveyor system … clear as day"). A job sent down a line
   (POST /api/routing/sample with its line) is kept as ONE record from the moment it goes out: GET /api/line-jobs lists it newest
   first, GET /api/line-jobs/<id> holds the whole thing (what was asked, the route's own verdict, each step's run at its bay, what came
   out, what it cost), …/note keeps what the Commander changed because of it, a re-run names the job it re-ran, and the records
   survive a restart. SET IT UP FOR ME (POST /api/routing/line-draft) drafts a line from a description on the station default model:
   only an offered starter, bad input refused before any spend, and nothing is placed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

test('a line job is one durable record; SET IT UP FOR ME drafts only an offered line', async () => {
  const calls = [];
  let draftReply = null;
  const server = http.createServer((req, res) => {
    if (req.url.includes('/chat/completions')) {
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const sys = String(((body.messages || []).find(m => m && m.role === 'system') || {}).content || '');
        const draft = sys.indexOf('You set up a work line for someone') >= 0;
        calls.push({ model: body.model, draft, raw });
        const text = draft ? draftReply : 'Two facts about the moon.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: 'jobs-model', context_length: 8000 }] } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-jobs-', timeoutMs: 20000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1'
  } });
  try {
    await fixture.start();
    const agents = [{ agentId: 'agent', name: 'Overseer', system: 'Sample', provider: 'custom', model: 'jobs-model' }];
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    const geo = { props: [
      { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'w', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'agent', role: 'WRITER', brief: 'Write two short facts.' },
      { id: 'o', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) };
    await publishFloor(fixture, floorOf(geo));   // saved with the real save owner, then published as the page does
    const line = (Pipeline.lineComponents(geo) || [])[0].key;   // the key the WORKFLOWS window sends: the line's oldest machine

    // a job goes down the line: its record is the route's own verdict
    const sent = await fixture.json('POST', '/api/routing/sample', { line, text: 'Two facts about the moon.', name: 'Moon facts' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.match(String(sent.body.jobId), /^job-[a-z0-9]{8,24}$/, 'the answer names a valid durable job record');
    const listed = await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(line));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.jobs.length, 1);
    const sum = listed.body.jobs[0];
    assert.equal(sum.id, sent.body.jobId);
    assert.equal(sum.status, 'delivered');
    assert.equal(sum.name, 'Moon facts');
    assert.equal(sum.text, 'Two facts about the moon.');
    assert.equal(sum.steps, sent.body.runs.length);
    assert.equal(sum.streamId, sent.body.streamId, 'the OUTBOX finds it by the stream its delivered run rode');
    const whole = await fixture.json('GET', '/api/line-jobs/' + sent.body.jobId);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.job.output, sent.body.replies.join(''), 'the record keeps what the line delivered, whole');
    assert.ok(whole.body.job.runs.length >= 1 && whole.body.job.runs.every(r => r.dockId === 'w' && r.reason === 'done'), 'each step\'s run, at its bay: ' + JSON.stringify(whole.body.job.runs));
    assert.ok(Math.abs(whole.body.job.usd - sent.body.totalUsd) < 1e-9, 'what it cost is the route\'s own total');
    assert.equal((await fixture.json('GET', '/api/line-jobs?stream=' + encodeURIComponent(sent.body.streamId))).body.jobs[0].id, sent.body.jobId);

    // what the Commander changed because of it is kept on the record; anything else is refused
    const noted = await fixture.json('POST', '/api/line-jobs/' + sent.body.jobId + '/note', { kind: 'fix', dockId: 'w', role: 'WRITER', field: 'does', text: 'Answer in one sentence.', was: 'Write two short facts.', why: 'Shorter.' });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    assert.deepEqual(noted.body.job.notes.map(n => [n.kind, n.dockId, n.text, n.was]), [['fix', 'w', 'Answer in one sentence.', 'Write two short facts.']]);
    assert.equal((await fixture.json('POST', '/api/line-jobs/' + sent.body.jobId + '/note', { kind: 'delete-everything' })).status, 400);
    assert.equal((await fixture.json('GET', '/api/line-jobs/job-000000000000')).status, 404);

    // NEEDS CHANGES is the Commander's dislike of the result: it persists as taste and reaches the next run's prompt, whatever the
    // suggestion call answers (this mock answers no fixes) — it lived only in the window's memory
    const fixAsk = await fixture.json('POST', '/api/routing/fix-suggest', { jobId: sent.body.jobId, complaint: 'Far too long, and cite no sources ever.', job: 'Two facts about the moon.', result: 'x', steps: [{ dockId: 'w', role: 'WRITER', does: 'Write two short facts.', output: 'x' }] });
    assert.ok(fixAsk.body.feedbackMemory && fixAsk.body.feedbackMemory.stored === true, 'the complaint is kept as taste: ' + JSON.stringify(fixAsk.body));
    const beforeAgain = calls.length;
    // the same job again, after the change: the new record names the one it re-ran, newest first
    const again = await fixture.json('POST', '/api/routing/sample', { line, text: 'Two facts about the moon.', name: 'Moon facts', retryOf: sent.body.jobId });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.ok(calls.slice(beforeAgain).some(c => !c.draft && c.raw.indexOf('Far too long, and cite no sources ever.') >= 0), 'the next run is told what the Commander disliked');
    const both = (await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(line))).body.jobs;
    assert.deepEqual(both.map(j => j.id), [again.body.jobId, sent.body.jobId], 'newest first');
    assert.equal(both[0].retryOf, sent.body.jobId);

    // a refusal is not a job: nothing went down the line, nothing is recorded
    const refused = await fixture.json('POST', '/api/routing/sample', { line: 'no-such-line', text: 'x' });
    assert.equal(refused.status, 409);
    assert.equal((await fixture.json('GET', '/api/line-jobs')).body.jobs.length, 2);

    // SET IT UP FOR ME — bad input is refused before any model call
    const starters = [{ id: 'research_line', name: 'Research + write', purpose: 'one agent digs up sources, the next writes the answer', roles: ['RESEARCHER', 'WRITER'] },
      { id: 'front_desk', name: 'One agent', purpose: 'one agent does each job', roles: ['GENERALIST'] }];
    calls.length = 0;
    assert.equal((await fixture.json('POST', '/api/routing/line-draft', { want: '   ', starters })).status, 400);
    assert.equal(calls.filter(c => c.draft).length, 0, 'no spend on a refused ask');
    // …a real ask: one call on the station default; only an offered starter, only its roles
    draftReply = 'Sure:\n```json\n' + JSON.stringify({ starter: 'research_line', name: '"AI news digest"', steps: { researcher: 'Find this week\'s most important AI news.', WRITER: 'Write it up as a short newsletter section.', EDITOR: 'not a role of this line' }, job: 'This week in AI' }) + '\n```';
    const drafted = await fixture.json('POST', '/api/routing/line-draft', { want: 'a weekly AI news digest for my newsletter', starters });
    assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
    assert.equal(drafted.body.starter, 'research_line');
    assert.equal(drafted.body.name, 'AI news digest');
    assert.deepEqual(drafted.body.briefs, { RESEARCHER: 'Find this week\'s most important AI news.', WRITER: 'Write it up as a short newsletter section.' });
    assert.equal(drafted.body.job, 'This week in AI');
    assert.equal(drafted.body.model, 'jobs-model');
    assert.equal(calls.filter(c => c.draft).length, 1, 'exactly one model call');
    // …a line that was not offered is never trusted
    draftReply = JSON.stringify({ starter: 'mission_control', name: 'x', steps: { SORTER: 'y' }, job: 'z' });
    const offList = await fixture.json('POST', '/api/routing/line-draft', { want: 'sort my email', starters });
    assert.equal(offList.status, 502);
    assert.match(offList.body.error, /not offered/);

    // the records survive a restart
    await fixture.restart();
    const after = (await fixture.json('GET', '/api/line-jobs')).body.jobs;
    assert.deepEqual(after.map(j => [j.id, j.status]), [[again.body.jobId, 'delivered'], [sent.body.jobId, 'delivered']]);
    assert.equal((await fixture.json('GET', '/api/line-jobs/' + sent.body.jobId)).body.job.notes.length, 1);
  } finally {
    await fixture.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
