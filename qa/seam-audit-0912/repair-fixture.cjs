'use strict';
// Isolated UI fault adapter. Product scripts are forwarded unchanged; only storage and read IO are faulted.
const http = require('node:http');
const { makeTranscriptStore } = require('../../sidecar/transcriptstore.js');
const ts = Date.now() - 20000;
const run = { runId: 'repair-outbox-A', streamId: 'repair-shared', agentId: 'agent', reason: 'done', title: 'Repair attribution A', ts };
const transcript = makeTranscriptStore({ io: { readAll: () => [], append() {} }, clock: { now: () => ts } });
for (const [sourceRunId, role, content] of [
  ['repair-outbox-A', 'user', 'Request A: summarize the first result'],
  ['repair-outbox-A', 'assistant', 'Answer A belongs only to the first run.'],
  ['repair-outbox-B', 'user', 'Request B: unrelated work'],
  ['repair-outbox-B', 'assistant', 'Answer B must never appear in the A drawer.']
]) transcript.appendStrict({ streamId: run.streamId, agentId: 'agent', sourceRunId, role, content });
const state = { failHistory: true, failSettings: true, runReads: 0, transcriptReads: [] };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (u.pathname === '/fixture/status') return json(200, state);
  if (u.pathname === '/fixture/recover') { state.failHistory = false; state.failSettings = false; return json(200, state); }
  if (u.pathname === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`if (!localStorage.getItem('repair.fixture.seeded')) {
      localStorage.setItem('starnet.return.v1', JSON.stringify({lastSeenAt:${ts - 10000},pending:[],digested:[]}));
      localStorage.setItem('repair.fixture.seeded','1');
    }
    ${state.failSettings ? "const originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value) { if(key === 'starnet.station.v1') throw new DOMException('Controlled storage quota failure','QuotaExceededError'); return originalSet.call(this,key,value); };" : ''}`);
  }
  if (u.pathname === '/api/runs') {
    state.runReads++;
    return state.failHistory ? json(503, { error: 'Controlled history outage' }) : json(200, { runs: [run], snapshotAt: Date.now(), nextCursor: '' });
  }
  if (u.pathname === '/api/transcript' && u.searchParams.get('stream') === run.streamId) {
    const sourceRunId = u.searchParams.get('runId') || '';
    state.transcriptReads.push(sourceRunId);
    return json(200, { stream: run.streamId, turns: transcript.history(run.streamId, { limit: 50, sourceRunId }) });
  }
  const headers = { ...req.headers, host: '127.0.0.1:19427' };
  if (headers.origin) headers.origin = 'http://127.0.0.1:19427';
  const up = http.request({ hostname: '127.0.0.1', port: 19427, path: req.url, method: req.method, headers }, r => {
    if (u.pathname === '/') {
      const chunks = []; r.on('data', b => chunks.push(b)); r.on('end', () => {
        const body = Buffer.concat(chunks).toString().replace('<head>', '<head><script src="/fixture.js"></script>');
        const h = { ...r.headers }; delete h['content-length'];
        res.writeHead(r.statusCode, h); res.end(body);
      });
    } else { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
  });
  up.on('error', e => { if (!res.headersSent) json(502, { error: e.message }); else res.destroy(); });
  req.pipe(up); res.on('close', () => up.destroy());
}).listen(19429, '127.0.0.1', () => console.log('Repair storage/history fixture: 19429 -> isolated app 19427'));
