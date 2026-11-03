'use strict';
/* Real persisted dispatch rows -> real API -> actual provider replay, before and after restart.
   Dispatch execution/validation itself is covered by e2e.dispatch-session; this fixture isolates C6's read boundary. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createHash } = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const UserText = require('../frontend/app/usertext.js');
const textOf = message => UserText.flatten(message && message.content, UserText.OPENAI);
const hash = text => createHash('sha256').update(text).digest('hex');
const requests = [], prompt = 'ACCEPTED_BRIEF repair the reconnect sequence', answer = 'ACCEPTED_FINAL reconnect repair completed';
const server = http.createServer((request, response) => {
  let raw = ''; request.on('data', chunk => { raw += chunk; }); request.on('end', () => {
    if (request.method !== 'POST') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); return; }
    requests.push(JSON.parse(raw)); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'CONTINUATION_ANSWER' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'dispatch-replay-', env: {
    STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_TURNID_REPLAY: process.env.TURN_DISPATCH_REPLAY_CONTROL === 'legacy' ? 'legacy' : 'id'
  } });
  try {
    const io = makeSegmentedTranscriptIo({ fs, path, root: path.join(fixture.workspace, 'transcript-history-v2'), schedule() {}, onWarning() {} });
    const store = makeTranscriptStore({ io, hash, clock: { now: () => 1000 } });
    const append = extra => store.appendStrict(Object.assign({ streamId: 'dispatch-replay', agentId: 'agent', sourceRunId: 'accepted-run',
      role: 'user', kind: 'turn', taint: null }, extra));
    append({ content: 'RAW_EXECUTION_SENTINEL prompt', typed: 'STALE_TYPED_SENTINEL', dispatchState: 'pending' });
    append({ role: 'assistant', content: 'RAW_EXECUTION_SENTINEL answer', dispatchState: 'pending' });
    append({ role: 'assistant', content: answer, dispatchState: 'final', dispatchPrompt: prompt, dispatchReason: 'done',
      textLength: answer.length, textSha256: hash(answer) });
    append({ sourceRunId: 'unaccepted-run', content: 'UNACCEPTED_SENTINEL prompt', dispatchState: 'pending' });
    append({ sourceRunId: 'unaccepted-run', role: 'assistant', content: 'UNACCEPTED_SENTINEL answer', dispatchState: 'pending' });
    append({ sourceRunId: 'repair-run', role: 'assistant', kind: 'station', content: 'REPAIR_SENTINEL', dispatchState: 'internal' });
    io.close();
    await fixture.start();
    for (const phase of ['before', 'after']) {
      if (phase === 'after') await fixture.restart();
      const marker = 'OWNER_CONTINUATION_' + phase;
      const response = await fixture.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent',
        streamId: 'dispatch-replay', isTask: false, messages: [{ role: 'user', content: marker }] });
      A.eq(response.status, 200, phase + ': actual continuation succeeds');
      const events = String(response.body).trim().split('\n').filter(Boolean).map(JSON.parse);
      A.ok(events.some(event => event.name === 'agent.run.end'), phase + ': actual run terminates');
      const body = requests.filter(item => (item.messages || []).some(message => textOf(message).includes(marker))).pop();
      A.ok(!!body, phase + ': provider received the continuation');
      const messages = body && body.messages || [];
      A.eq(messages.filter(message => message.role === 'user' && textOf(message).includes(prompt)).length, 1, phase + ': accepted prompt replays once');
      A.eq(messages.filter(message => message.role === 'assistant' && textOf(message).includes(answer)).length, 1, phase + ': verified final replays once');
      A.ok(!messages.some(message => /RAW_EXECUTION_SENTINEL|STALE_TYPED_SENTINEL|UNACCEPTED_SENTINEL|REPAIR_SENTINEL/.test(textOf(message))), phase + ': raw, stale typed, unaccepted and internal repair text never reach the provider');
      const diagnostic = await fixture.json('GET', '/api/transcript?stream=dispatch-replay&view=model-replay');
      A.eq(diagnostic.status, 200, phase + ': actual diagnostic projection succeeds');
      A.eq(diagnostic.body.turns.filter(row => row.displayOf === 'final').map(row => row.content), [prompt], phase + ': diagnostic preserves accepted prompt identity');
      A.ok(diagnostic.body.turns.every(row => Number.isSafeInteger(row.rowId) && row.rowId > 0), phase + ': projection carries durable source IDs');
    }
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  A.report('dispatch-replay.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
