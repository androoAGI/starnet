/* node test/e2e.attachments.test.js — TRUE end-to-end for COMMS user attachments: boot the ACTUAL sidecar and
   (1) upload a photo via POST /api/attachments, (2) fetch it back through the jailed /api/file route, (3) drive
   a real /api/run with the attachment reference on the user turn, and assert the EXACT uploaded bytes reach the
   (mocked) provider as a base64 image_url content block. This proves the whole backend pipeline wired live —
   upload -> workspace save -> run-time expansion -> provider — not just the unit-level pieces. No real key. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const HOST = '127.0.0.1';

// a 1x1 png — real bytes, so we can assert the exact base64 round-trips upload -> disk -> expansion -> provider.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// mock OpenRouter: /models -> a minimal catalog; /chat/completions -> a short SSE completion; capture requests.
function startMockOpenRouter() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'a red pixel' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function drain(res) { const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = []; while (true) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } } return events; }

(async () => {
  const mock = await startMockOpenRouter();
  const fixture = SidecarFixture.create({ prefix: 'sk-attach-e2e-', env: { SKYNET_OPENROUTER_BASE: mock.base } });
  await fixture.start();
  const B = fixture.baseUrl;
  try {
    const token = fixture.token;
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // 1. UPLOAD a photo -> a lightweight reference; the bytes land in the agent's workspace.
    const up = await fetch(B + '/api/attachments', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'e2e', name: 'pixel.png', dataUrl: 'data:image/png;base64,' + PNG_B64 }) });
    A.eq(up.status, 200, 'POST /api/attachments -> 200');
    const ref = await up.json();
    A.ok(ref.ok && ref.kind === 'image' && /^\.attachments\/.+\.png$/.test(ref.path), 'upload returns an image reference under .attachments/ — ' + JSON.stringify(ref));

    // 2. FETCH the photo back through the jailed /api/file route (proves the thumbnail path is real + serves bytes).
    const fileRes = await fetch(B + '/api/file?agent=e2e&path=' + encodeURIComponent(ref.path), { headers: { 'X-StarNet-Token': token, Origin: B } });   // the master token rides the header, never the URL (2026-09-25)
    A.eq(fileRes.status, 200, 'GET /api/file serves the uploaded attachment');
    A.eq(String(fileRes.headers.get('content-type') || '').indexOf('image/png'), 0, 'served with an image/png content-type');
    const gotBytes = Buffer.from(await fileRes.arrayBuffer());
    A.eq(gotBytes.toString('base64'), PNG_B64, 'the served bytes are exactly the uploaded image');

    // 3. Establish prior dialogue on the same stream, then RUN with the attachment on the latest user turn.
    // The prior turn is deliberate: attachment expansion changes the latest content from a string to provider
    // blocks, and the durable title/transcript seam must not skip it and fall back to this older string turn.
    const streamId = 'attachment-e2e';
    const priorText = 'FIRST TURN about kittens';
    const priorRes = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify({
      key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', streamId,
      messages: [{ role: 'user', content: priorText }]
    }) });
    A.eq(priorRes.status, 200, 'the prior dialogue run streams 200');
    const priorEvents = await drain(priorRes);
    A.ok(priorEvents.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'the prior dialogue run completes cleanly');

    const attachmentText = 'what colour is this pixel?';
    const runRes = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify({
      key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', streamId,
      messages: [
        { role: 'user', content: priorText },
        { role: 'assistant', content: 'a red pixel' },
        { role: 'user', content: attachmentText, attachments: [{ id: ref.id, name: 'pixel.png', path: ref.path, mediaType: 'image/png', kind: 'image' }] }
      ]
    }) });
    A.eq(runRes.status, 200, 'POST /api/run (with an attachment) streams 200');
    const events = await drain(runRes);
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.eq(ends.length, 1, 'exactly one agent.run.end');
    A.eq(ends[0].payload.reason, 'done', 'the run with an attachment completes cleanly');

    // 4. ASSERT the exact uploaded image reached the provider as a base64 image_url content block.
    const req0 = mock.requests.find(r => (r.messages || []).some(m => m && m.role === 'user' && Array.isArray(m.content))) || {};
    const userMsg = (req0.messages || []).filter(m => m && m.role === 'user' && Array.isArray(m.content)).pop();
    A.ok(userMsg, 'the provider received a user turn with multi-part (array) content');
    const parts = (userMsg && userMsg.content) || [];
    A.ok(parts.some(p => p && p.type === 'text' && String(p.text).indexOf(attachmentText) >= 0), 'the typed text reached the provider');
    const imgPart = parts.find(p => p && p.type === 'image_url');
    A.ok(imgPart, 'an image_url part reached the provider');
    const url = imgPart && imgPart.image_url && imgPart.image_url.url;
    A.eq(url, 'data:image/png;base64,' + PNG_B64, 'the EXACT uploaded image bytes reached the provider as a base64 data URL');

    // 5. The durable transcript and run history must describe the attachment turn, not duplicate the prior turn.
    const trRes = await fetch(B + '/api/transcript?stream=' + encodeURIComponent(streamId) + '&agent=e2e&limit=20', {
      headers: { 'X-StarNet-Token': token, Origin: B }
    });
    A.eq(trRes.status, 200, 'GET /api/transcript reads the attachment stream');
    const transcript = await trRes.json();
    const userTurns = ((transcript && transcript.turns) || []).filter(t => t && t.role === 'user').map(t => t.content);
    A.eq(JSON.stringify(userTurns), JSON.stringify([priorText, attachmentText]), 'durable transcript preserves the attachment turn exactly once');

    const runsRes = await fetch(B + '/api/runs?agent=e2e&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } });
    A.eq(runsRes.status, 200, 'GET /api/runs reads attachment run history');
    const runs = ((await runsRes.json()).runs || []).filter(r => r.streamId === streamId);
    A.eq(runs.length, 2, 'both runs are recorded for the attachment stream');
    A.eq(runs[0].title, attachmentText, 'the attachment run title uses its own typed text');
    A.eq(runs[1].title, priorText, 'the prior run keeps its original title');

    // 5b. (run-paths review round 2) a PROJECT chat: the folder is trusted through the real /api/projects/bless, and the
    // run host expands the attachment once, naming the saved file the way this run's tools resolve it (the absolute path
    // in the private workspace, since a relative path means the project here). The provider sees one note and never
    // the raw `attachments` key.
    const fs = require('fs'), os = require('os'), path = require('path');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-attach-proj-'));
    try {
      const bless = await fetch(B + '/api/projects/bless', { method: 'POST', headers: H, body: JSON.stringify({ path: fs.realpathSync.native(proj) }) });
      const blessed = await bless.json();
      A.ok(bless.status === 200 && blessed.ok && blessed.root, 'the project folder is trusted through /api/projects/bless: ' + JSON.stringify(blessed));
      const upTxt = await fetch(B + '/api/attachments', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'e2e', name: 'brief.md', dataUrl: 'data:text/markdown;base64,' + Buffer.from('# the brief\nship it').toString('base64') }) });
      const txtRef = await upTxt.json();
      A.ok(txtRef.ok && txtRef.kind === 'file', 'a text attachment is saved: ' + JSON.stringify(txtRef));
      const before = mock.requests.length;
      const projRes = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify({
        key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', streamId: 'attachment-e2e-project', projectRoot: blessed.root,
        messages: [{ role: 'user', content: 'read the brief', attachments: [{ id: txtRef.id, name: 'brief.md', path: txtRef.path, mediaType: 'text/markdown', kind: 'file' }] }]
      }) });
      A.eq(projRes.status, 200, 'the project-chat run streams 200');
      const projEnds = (await drain(projRes)).filter(e => e.name === 'agent.run.end');
      A.ok(projEnds.length === 1 && projEnds[0].payload.reason === 'done', 'the project-chat run completes cleanly');
      const sent = mock.requests.slice(before);
      A.ok(sent.length > 0, 'the project-chat run reached the provider');
      const userTexts = sent.map(r => (r.messages || []).filter(m => m && m.role === 'user').map(m => Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('') : String(m.content || '')).join('\n'));
      const last = userTexts[userTexts.length - 1] || '';
      A.eq((last.match(/\[saved in your workspace at /g) || []).length, 1, 'exactly one "[saved in your workspace at …]" note reaches the provider: ' + last.slice(0, 300));
      const at = (/\[saved in your workspace at ([^\]]+)\]/.exec(last) || [])[1] || '';
      A.ok(path.isAbsolute(at) && at.replace(/\\/g, '/').endsWith(txtRef.path) && at.indexOf(proj) < 0, 'in a project run it names the saved file absolutely, in the private workspace: ' + at);
      A.ok(/ship it/.test(last), 'and the file\'s text is inlined');
      A.ok(sent.every(r => (r.messages || []).every(m => !(m && Object.prototype.hasOwnProperty.call(m, 'attachments')))), 'no raw attachments key reaches the provider');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }

    // 6. DELETE the attachment (composer remove-before-send) prunes the workspace file.
    const del = await fetch(B + '/api/attachments', { method: 'POST', headers: H, body: JSON.stringify({ op: 'delete', agent: 'e2e', path: ref.path }) });
    A.eq(del.status, 200, 'POST /api/attachments {op:delete} -> 200');
    const after = await fetch(B + '/api/file?agent=e2e&path=' + encodeURIComponent(ref.path), { headers: { 'X-StarNet-Token': token, Origin: B } });   // the master token rides the header, never the URL (2026-09-25)
    A.eq(after.status, 404, 'the deleted attachment is gone (404)');
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.attachments.test');
})().catch(e => { console.error(e); process.exit(1); });
