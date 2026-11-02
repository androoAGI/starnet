/* #164, in the real sidecar: images whose cost is unknown are counted in the real spend log and stopped by both caps.
   index.js boots against a local stub that answers every image with no price (no usage, no cost), so each one is an
   unknown-cost image. Proves, through runOnce, ledgerIo and the file on disk:
     - each unknown-cost image writes its own image-unknown-cost row to <workspaces>/ledger.jsonl;
     - the per-run cap (10) refuses image 11 before any request reaches the stub;
     - after a real restart, the 24-hour count is read back from the file (the day limit, set to 11 here, refuses);
     - a damaged ledger line refuses images instead of reading as zero.
   Hermetic: a temp station home, temp APPDATA/LOCALAPPDATA (SidecarFixture) and a temp USERPROFILE. No real provider,
   no key, no live model call. The $ budget caps are off (STARNET_BUDGET_PER_DAY=0) so the chat itself is never stopped
   by them: what refuses here is the image count. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sse(res, chunks, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

// the chat model asks for IMAGES=<n> images in one turn, then reports; every image answer carries no price
function startStub() {
  const stub = { images: 0, toolResults: [] };
  return new Promise(resolve => {
    stub.server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        if (Array.isArray(body.modalities) && body.modalities.includes('image')) {
          stub.images++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }] }));
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const results = messages.filter(m => m && m.role === 'tool');
        if (results.length) {
          stub.toolResults = results.map(m => ({ id: m.tool_call_id, text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
          return sse(res, [{ content: 'Images done.' }]);
        }
        const n = Number((/IMAGES=(\d+)/.exec(JSON.stringify(messages)) || [])[1]) || 1;
        const calls = Array.from({ length: n }, (_, i) => ({ index: i, id: 'img' + (i + 1), type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a cube number ' + (i + 1) }) } }));
        return sse(res, [{ tool_calls: calls }], 'tool_calls');
      });
    });
    stub.server.listen(0, HOST, () => { stub.baseUrl = 'http://' + HOST + ':' + stub.server.address().port + '/api/v1'; resolve(stub); });
  });
}

async function runImages(fx, agentId, n) {
  const res = await fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: 'openrouter', key: 'stub-key', model: 'test/model', agentId, isTask: true, placed: ['studio'],
    messages: [{ role: 'user', content: 'Generate the images. IMAGES=' + n }] }) });
  A.eq(res.status, 200, 'the run streams');
  return (await res.text()).split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
const ledgerRows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const unknownRows = file => ledgerRows(file).filter(r => r.aux === 'image-unknown-cost');

(async () => {
  const started = Date.now();
  const stub = await startStub();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-image-cap-home-'));
  const noKeys = { STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '', STARNET_OPENROUTER_API_KEY: '',
    SKYNET_OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '' };
  const fx = SidecarFixture.create({ prefix: 'starnet-image-cap-', timeoutMs: 60000, env: Object.assign({}, noKeys, {
    USERPROFILE: home, HOMEPATH: home, HOME: home,
    STARNET_OPENROUTER_BASE: stub.baseUrl, SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0',
    STARNET_BUDGET_PER_DAY: '0', STARNET_BUDGET_PER_RUN: '0', STARNET_BUDGET_PER_AGENT: '0', STARNET_BUDGET_GLOBAL: '0',
    STARNET_IMAGE_UNKNOWN_COST_DAY_MAX: '11' }) });
  const ledgerFile = () => path.join(fx.workspace, 'ledger.jsonl');
  try {
    await fx.start();
    A.ok(path.resolve(fx.workspace).startsWith(path.resolve(os.tmpdir())), 'the station home is a temp folder: ' + fx.workspace);

    // ---- one run asks for 11 images at once: 10 reach the stub, the 11th is refused before any request
    const first = await runImages(fx, 'cap-run-one', 11);
    A.ok(!first.some(e => e.name === 'agent.run.error' && /budget|spend history/i.test(JSON.stringify(e.payload))), 'no dollar limit is in play');
    A.eq(stub.images, 10, 'exactly 10 image requests reached the stub');
    const results = stub.toolResults;
    A.eq(results.length, 11, 'all 11 calls answered: ' + results.length);
    const refused = results.filter(r => /did not start/.test(r.text));
    A.eq(refused.length, 1, 'one was refused: ' + refused.map(r => r.text.slice(0, 160)).join(' | '));
    A.ok(refused[0] && /this run and its workers have generated 10 images whose cost is unknown/.test(refused[0].text) && /stops at 10 in one run/.test(refused[0].text)
      && /nothing was charged/.test(refused[0].text) && /start a new run/.test(refused[0].text), 'by the per-run cap, in plain words: ' + (refused[0] && refused[0].text.slice(0, 400)));
    A.ok(results.filter(r => !/did not start/.test(r.text)).every(r => /Cost: UNKNOWN/.test(r.text) && /StarNet stops a run at 10 of them, and every run at 11 in any 24 hours/.test(r.text)), 'every image made says its cost is unknown and the counts that stop it');
    const rows1 = unknownRows(ledgerFile());
    A.eq(rows1.length, 10, 'the real ledger file holds one image-unknown-cost row per image: ' + rows1.length);
    A.ok(rows1.every(r => r.usd === 0 && r.unpriced === true && r.model === 'image' && r.agentId === 'cap-run-one' && typeof r.entryId === 'string' && r.ts > 0), 'each a $0 unpriced aux row under its run, written through ledgerIo');
    A.eq(new Set(rows1.map(r => r.runId)).size, 1, 'all under the one run');

    // ---- a real restart: the day limit (11) reads the 10 already in the file
    await fx.restart();
    const second = await runImages(fx, 'cap-run-two', 2);
    void second;
    A.eq(stub.images, 11, 'the new run made one more image (11 of 11 today), and only one');
    const dayRefused = stub.toolResults.filter(r => /did not start/.test(r.text));
    A.eq(dayRefused.length, 1, 'its second image was refused');
    A.ok(dayRefused[0] && /StarNet has recorded 11 images whose cost is unknown in the last 24 hours across all runs/.test(dayRefused[0].text) && /Room comes back in about 24 hours/.test(dayRefused[0].text),
      'by the 24-hour limit, counted from the file across the restart: ' + (dayRefused[0] && dayRefused[0].text.slice(0, 400)));
    A.eq(unknownRows(ledgerFile()).length, 11, 'and the file now holds 11');

    // ---- a damaged line: unknown is never headroom
    await fx.stop();
    fs.appendFileSync(ledgerFile(), '{"runId":"torn","agentId":"x","usd":0.5,"tok\n');
    await fx.start({ STARNET_IMAGE_UNKNOWN_COST_DAY_MAX: '50' });
    const before = stub.images;
    await runImages(fx, 'cap-run-three', 1);
    A.eq(stub.images, before, 'no image request with a damaged spend log');
    const unreadable = stub.toolResults.filter(r => /did not start/.test(r.text));
    A.ok(unreadable.length === 1 && /could not read its spend log/.test(unreadable[0].text) && /SPENDING LIMITS/.test(unreadable[0].text), 'refused, and says why: ' + (unreadable[0] && unreadable[0].text.slice(0, 300)));
  } finally {
    await fx.dispose();
    await new Promise(resolve => stub.server.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    console.log('image-unknown-cost-cap.e2e: ' + Math.round((Date.now() - started) / 1000) + ' s');
  }
  A.report('image-unknown-cost-cap.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
