'use strict';
/* routing.fix-suggest.e2e — NOT RIGHT? on a real sidecar (2026-09-30, ease of use). A job ridden through a line names the BAY each
   stage ran at (so the panel can show each step's own reply), and POST /api/routing/fix-suggest turns the Commander's "what's wrong"
   into checked changes to the line's step instructions: ONE call on the station default (the Overseer's roster model and
   credential), only fixes for steps it was sent, bad input refused before any spend. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

test('fix-suggest answers checked fixes on the station default model; sample runs name their bay', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/chat/completions')) {
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const sys = String(((body.messages || []).find(m => m && m.role === 'system') || {}).content || '');
        const fix = sys.indexOf('You tune AI work lines') >= 0;
        calls.push({ model: body.model, auth: req.headers.authorization, fix });
        const text = fix
          ? 'Here:\n' + JSON.stringify({ diagnosis: 'The writer was told to write 200 words.', fixes: [
            { step: 'w', does: 'Answer in two short sentences.', hands: 'two short sentences', why: 'The writer sets the length.' },
            { step: 'not-on-this-line', does: 'ignored' }] })
          : 'Sample complete.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: 'fix-model', context_length: 8000 }] } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'fix-suggest-', timeoutMs: 20000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1'
  } });
  try {
    await fixture.start();
    const agents = [{ agentId: 'agent', name: 'Overseer', system: 'Sample', provider: 'custom', model: 'fix-model' }];
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    await publishFloor(fixture, floorOf({ props: [
      { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'w', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'agent', role: 'WRITER', brief: 'Write a 200-word digest.' },
      { id: 'o', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }));

    // a job through the line: every stage's run names the BAY it ran at
    const job = await fixture.json('POST', '/api/routing/sample', { text: 'Write about sleep.' });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    assert.ok(job.body.runs.length >= 1 && job.body.runs.every(r => r.dockId === 'w'), 'each stage names its bay: ' + JSON.stringify(job.body.runs));

    // NOT RIGHT? — bad input is refused before any model call
    calls.length = 0;
    const empty = await fixture.json('POST', '/api/routing/fix-suggest', { complaint: '  ', steps: [{ dockId: 'w', does: 'x' }] });
    assert.equal(empty.status, 400);
    assert.equal(calls.filter(c => c.fix).length, 0, 'no spend on a refused ask (post-run passes of the job above may still call: only the fix prompt counts)');

    // …and a real ask: one call on the station default, only fixes for steps it was sent
    const ask = await fixture.json('POST', '/api/routing/fix-suggest', {
      complaint: 'Too long. Two sentences please.', job: 'Write about sleep.', result: 'Sample complete.',
      steps: [{ dockId: 'w', role: 'WRITER', agent: 'OVERSEER', does: 'Write a 200-word digest.', hands: '', output: 'Sample complete.' }]
    });
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    assert.equal(ask.body.ok, true);
    assert.equal(ask.body.model, 'fix-model');
    assert.deepEqual(ask.body.fixes, [{ dockId: 'w', why: 'The writer sets the length.', does: 'Answer in two short sentences.', hands: 'two short sentences' }]);
    assert.ok(/200 words/.test(ask.body.diagnosis));
    assert.equal(calls.filter(c => c.fix).length, 1, 'exactly one model call');
    assert.ok(calls.filter(c => c.fix).every(c => c.model === 'fix-model' && c.auth === 'Bearer direct-fixture'), 'on the Overseer model and credential: ' + JSON.stringify(calls));
  } finally {
    await fixture.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
