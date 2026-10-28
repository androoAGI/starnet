/* node test/secret-redaction.e2e.test.js — a SHAPELESS secret the station holds never reaches the run stream,
   the transcript or diagnostics, even when something prints it verbatim.

   Security audit 2026-09-25: redact() only knew vendor shapes (sk-…, xoxb-…, JWT …). A service key the model was
   promised it would never see, a custom connector token or a prefix-less provider key rode straight into the
   NDJSON run stream, the bus and the persisted transcript the moment a tool or the model printed it. This boots a
   REAL sidecar on a scratch workspace, stores a shapeless service key, has a mock model echo it (and the
   shapeless provider key) back, and proves every surface carries [redacted-secret] instead. */
'use strict';
const http = require('node:http');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const SERVICE_KEY = 'zq7Shapeless0Service4821Canary';
const PROVIDER_KEY = 'plainProviderKey77310Canary';

(async () => {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'redaction-fixture', context_length: 32000, supported_parameters: ['tools'] }] }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = 'Printed from the env: ACME_API_KEY=' + SERVICE_KEY + ' and my own key ' + PROVIDER_KEY + ' done.';
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const fixture = SidecarFixture.create({ prefix: 'starnet-redaction-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_KEY: PROVIDER_KEY, STARNET_OPENROUTER_KEY: PROVIDER_KEY,
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_DEFAULT_MODEL: 'redaction-fixture', STARNET_DEFAULT_MODEL: 'redaction-fixture'
  } });
  try {
    await fixture.start();
    const put = await fixture.json('POST', '/api/servicekeys', { name: 'Acme API', key: SERVICE_KEY });
    A.eq(put.status, 200, 'service key stored');
    A.ok(JSON.stringify(put.body).indexOf(SERVICE_KEY) < 0, 'the upsert response never echoes the key');

    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      agentId: 'agent', provider: 'openrouter', model: 'redaction-fixture', baseUrl: base, isTask: false, streamId: 'redaction',
      messages: [{ role: 'user', content: 'say hi' }] }) });
    const stream = await r.text();
    A.eq(r.status, 200, 'the run completed (' + stream.slice(0, 200) + ')');
    A.ok(/Printed from the env/.test(stream), 'the model text reached the run stream');
    A.ok(stream.indexOf(SERVICE_KEY) < 0, 'the shapeless SERVICE key never appears in the run stream');
    A.ok(stream.indexOf(PROVIDER_KEY) < 0, 'the shapeless PROVIDER key never appears in the run stream');
    A.ok(stream.indexOf('[redacted-secret]') >= 0, 'the stream carries the redaction marker in their place');

    const tr = await fixture.request('/api/transcript?agent=agent&stream=redaction');
    const trText = await tr.text();
    A.ok(/Printed from the env/.test(trText), 'the transcript surface holds this run (the check below is not vacuous)');
    A.ok(trText.indexOf(SERVICE_KEY) < 0 && trText.indexOf(PROVIDER_KEY) < 0, 'the persisted transcript surface carries neither key');

    // THE DESK'S COPY, REDACTED BY THE SAME HAND (qw18, 10-27): COMMS posts its raw copy's turn texts before it merges the
    // read-back. The reply's raw text must come back byte-equal to the row the transcript store wrote, so the desk keys
    // the turn as ONE row — shapeless held keys included, which the page could never redact on its own.
    const stationRow = (JSON.parse(trText).turns || []).find(t => t.role === 'assistant' && /Printed from the env/.test(t.content));
    const typed = 'Printed from the env: ACME_API_KEY=' + SERVICE_KEY + ' and my own key ' + PROVIDER_KEY + ' done.';
    const red = await fixture.json('POST', '/api/transcript/redact', { texts: [typed, 'plain words'] });
    A.eq(red.status, 200, 'the desk-copy redaction route answers');
    A.ok(stationRow && red.body && Array.isArray(red.body.texts) && red.body.texts[0] === stationRow.content, 'the desk copy of the reply redacts to exactly the stored transcript row (one key, one turn)');
    A.ok(red.body && red.body.texts[1] === 'plain words', 'text with nothing secret comes back unchanged');
    A.ok(JSON.stringify(red.body).indexOf(SERVICE_KEY) < 0 && JSON.stringify(red.body).indexOf(PROVIDER_KEY) < 0, 'the route never hands a held key back');

    const diag = await fixture.json('GET', '/api/diagnostics');
    const diagText = JSON.stringify(diag.body);
    A.ok(diagText.indexOf(SERVICE_KEY) < 0 && diagText.indexOf(PROVIDER_KEY) < 0, 'the diagnostics export carries neither key');
    A.ok(JSON.stringify((await fixture.json('GET', '/api/servicekeys')).body).indexOf(SERVICE_KEY) < 0, 'the key list stays masked');
  } finally {
    await fixture.dispose();
    server.close();
  }
  A.report('secret-redaction.e2e.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
