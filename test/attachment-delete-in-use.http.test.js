'use strict';
/* node test/attachment-delete-in-use.http.test.js - A DELETED SESSION'S UPLOADS GO, A FILE ANOTHER SESSION STILL NAMES STAYS, through a REAL
   hermetic sidecar (SidecarFixture), a mocked provider and the page's own routes (release 0.15.0 sweep).

   Two paths remove a deleted session's uploads, and both ask the one in-use proof (sidecar/forget-wiring.js namedElsewhere):
     (a) the page's own delete (frontend/app/chat.js forgetSession): POST /api/attachments { op: 'delete', agent, paths, streamId }. The page
         filters by the sessions it holds, but it cannot see a packed session's rows (save v7), so the station keeps any file that a live
         session's transcript row or a session of the save still names, and leaves the deleted session itself out;
     (b) the forget registry's pass after the save that deletes the session lands (the attachment-files entry): the files the deleted session's
         transcript rows name go, except one that a live session's row names or that a /branch copy names only in the page's save.
   RED before the fix: (a) removed every posted file, and (b) removed the branch's file (the in-use set was the RAM mirror alone). */
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const HOST = '127.0.0.1';

function startMockOpenRouter() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        req.on('data', () => {}); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'noted' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}
const hermeticEnv = () => {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  return Object.assign(env, { SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '' });
};
const until = async (fn, label, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 100)); } };

/* ONE TORN LINE CANNOT STOP THE PASS (0.15.0's late privacy review, reproduced on a real sidecar). A killed append leaves a fragment in the segment
   that holds an old chat's row, and later rows push that row out of the RAM mirror. The whole read of that chat's rows then refuses at every pass,
   because a closed segment never changes. RED before the fix: the attachment-files entry threw before it removed anything, the ledger never settled
   and every later delete's uploads waited behind it, across restarts. The page's own post is left out on purpose: an old chat's row is packed and
   not read back, so the page may hold no ref, and the pass is the net. */
async function tornLineScenario(mock) {
  const fs = require('node:fs'), path = require('node:path');
  const fixture = SidecarFixture.create({ prefix: 'starnet-attach-torn-', timeoutMs: 30000, env: Object.assign(hermeticEnv(), { SKYNET_OPENROUTER_BASE: mock.base }) });
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  try {
    await fixture.start();
    const json = (method, route, body) => fixture.json(method, route, body);
    const upload = async name => {
      const r = await json('POST', '/api/attachments', { agent: 'agent', name, dataUrl: 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64') });
      A.ok(r.status === 200 && r.body && r.body.ok, 'upload ' + name + ': ' + JSON.stringify(r.body));
      return { id: r.body.id, name, path: r.body.path, mediaType: 'text/plain', kind: 'file' };
    };
    const present = async ref => (await fetch(fixture.baseUrl + '/api/file?agent=agent&path=' + encodeURIComponent(ref.path), { headers: { 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl } })).status === 200;
    const say = async (streamId, content, files) => {
      const res = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'agent', streamId, messages: [{ role: 'user', content, attachments: files }] }) });
      A.eq(res.status, 200, 'the run in ' + streamId + ' streams 200');
      await res.text();
    };
    let revision = 0;
    const save = async (workstreams, extra) => {
      const r = await json('POST', '/api/save', Object.assign({ agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: revision, workstreams }, extra || {}));
      A.eq(r.status === 200 && r.body && r.body.ok, true, 'the save lands: ' + JSON.stringify(r.body).slice(0, 200));
      revision = (r.body && (r.body.saveRevision || r.body.revision)) || revision + 1;
    };
    // polled while the station writes: a file can vanish or be swapped under the walk, and the next poll reads it again
    const purged = id => {
      try {
        const file = walk(fixture.workspace).find(f => /session-tombstones\.json$/.test(f));
        if (!file) return false;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8')), row = ((doc && doc.value) || doc).streams[id];
        return !!row && row.at > 0 && row.purged >= row.at;
      } catch (e) { return false; }
    };
    const oldFile = await upload('old.txt');
    await say('ws_old', 'the old chat and its file', [oldFile]);
    await save([{ id: 'ws_old', title: 'Old', history: [] }]);
    await fixture.stop();
    // while it is down: the fragment at the end of the active segment (with the newline the next append isolates it with), then 3100 later rows
    // in the next segment, more than the RAM mirror holds
    const manifestFile = walk(fixture.workspace).find(f => /transcript-history-v2[\\/]manifest\.json$/.test(f));
    const hist = path.dirname(manifestFile), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const active = fs.readdirSync(hist).filter(n => /^segment-\d+\.jsonl$/.test(n)).sort().pop(), activeNo = Number(/\d+/.exec(active)[0]);
    fs.appendFileSync(path.join(hist, active), '{"streamId":"ws_noise","role":"assistant","content":"half a ro\n');
    let rowId = Math.max(Number(manifest.nextRowId) || 1, 2000), ts = Date.now();
    const lines = [];
    for (let i = 0; i < 3100; i++) lines.push(JSON.stringify({ rowId: rowId++, streamId: 'ws_busy' + (i % 6), agentId: 'agent', ts: ts++, kind: 'turn', role: i % 2 ? 'assistant' : 'user', content: 'later words ' + i, sourceRunId: 'run_busy_' + (i >> 1), taintKnown: true }));
    fs.writeFileSync(path.join(hist, 'segment-' + String(activeNo + 1).padStart(6, '0') + '.jsonl'), lines.join('\n') + '\n');
    await fixture.start();
    await save([], { forgetIds: ['ws_old'], deletedIds: ['ws_old'] });
    await until(async () => !(await present(oldFile)), 'the old chat\'s upload goes, with a torn line beside its row');
    await until(() => purged('ws_old'), 'the ledger settles for the old chat');
    A.ok(true, 'a torn line beside a deleted chat\'s row: its upload goes and the ledger settles');
    const newFile = await upload('new.txt');
    await say('ws_new', 'a new chat and its file', [newFile]);
    await save([{ id: 'ws_new', title: 'New', history: [] }], { forgetIds: ['ws_old'], deletedIds: ['ws_old'] });
    await save([], { forgetIds: ['ws_old', 'ws_new'], deletedIds: ['ws_old', 'ws_new'] });
    await until(async () => !(await present(newFile)), 'a later delete is not held behind the torn line');
    await until(() => purged('ws_new'), 'the ledger settles for the later delete too');
    A.ok(true, 'a later delete is not held behind the torn line');
    await fixture.restart();
    A.ok(!(await present(oldFile)) && !(await present(newFile)) && purged('ws_old') && purged('ws_new'), 'across a restart both files stay gone and both deletes stay settled');
  } finally {
    await fixture.dispose();
  }
}

(async () => {
  const mock = await startMockOpenRouter();
  const fixture = SidecarFixture.create({ prefix: 'starnet-attach-in-use-', timeoutMs: 30000, env: Object.assign(hermeticEnv(), { SKYNET_OPENROUTER_BASE: mock.base }) });
  try {
    await fixture.start();
    const B = fixture.baseUrl, token = fixture.token;
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const json = (method, route, body) => fixture.json(method, route, body);
    const upload = async name => {
      const r = await json('POST', '/api/attachments', { agent: 'agent', name, dataUrl: 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64') });
      A.ok(r.status === 200 && r.body && r.body.ok && /^\.attachments\//.test(r.body.path), 'upload ' + name + ': ' + JSON.stringify(r.body));
      return { id: r.body.id, name, path: r.body.path, mediaType: 'text/plain', kind: 'file' };
    };
    const present = async ref => (await fetch(B + '/api/file?agent=agent&path=' + encodeURIComponent(ref.path), { headers: { 'X-StarNet-Token': token, Origin: B } })).status === 200;
    const say = async (streamId, content, files) => {
      const res = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'agent', streamId,
        messages: [{ role: 'user', content, attachments: files }] }) });
      A.eq(res.status, 200, 'the run in ' + streamId + ' streams 200');
      await res.text();
    };
    let revision = 0;
    const save = async (workstreams, extra) => {
      const r = await json('POST', '/api/save', Object.assign({ agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: revision, workstreams }, extra || {}));
      A.eq(r.status === 200 && r.body && r.body.ok, true, 'the save lands: ' + JSON.stringify(r.body).slice(0, 200));
      revision = (r.body && (r.body.saveRevision || r.body.revision)) || revision + 1;
    };
    const page = (content, files) => ({ role: 'user', content, ts: Date.now() - 1000, attachments: files });

    const live = await upload('live.txt'), branched = await upload('branched.txt'), own = await upload('own.txt');
    await say('ws_live', 'the live file', [live]);   // a durable transcript row of a live session names live.txt
    await save([
      { id: 'ws_live', title: 'Live', history: [] },   // its row is packed in a real save; the page holds no inline copy of it
      { id: 'ws_branch', title: 'Branch', history: [page('copied from the session below', [branched])] },   // a /branch copy: the page's alone
      { id: 'ws_gone', title: 'Gone', history: [page('all three', [live, branched, own])] }
    ]);

    // (a) the page's own delete of ws_gone's uploads
    const del = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: [live.path, branched.path, own.path], streamId: 'ws_gone' });
    A.eq(del.status, 200, '(a) the session delete answers 200');
    A.eq([del.body.removed, del.body.kept, del.body.proved], [1, 2, true], '(a) one file removed, two kept, proved: ' + JSON.stringify(del.body));
    A.ok(!(await present(own)), '(a) the file only the deleted session named is gone');
    A.ok(await present(live), '(a) a file a live session\'s transcript row names stays');
    A.ok(await present(branched), '(a) a file a /branch copy names only in the page\'s save stays');
    const bad = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: [live.path] });
    A.eq(bad.status, 400, '(a) a session delete that names no session is refused');
    A.ok(await present(live), '(a) ...and removes nothing');

    // (b) the registry's pass: ws_gone2's transcript rows name its own file and both shared files; the save that deletes it lands
    const own2 = await upload('own2.txt');
    await say('ws_gone2', 'my file and the shared ones', [own2, live, branched]);
    await save([
      { id: 'ws_live', title: 'Live', history: [] },
      { id: 'ws_branch', title: 'Branch', history: [page('copied from the session below', [branched])] }
    ], { forgetIds: ['ws_gone', 'ws_gone2'], deletedIds: ['ws_gone', 'ws_gone2'] });
    await until(async () => !(await present(own2)), '(b) the deleted session\'s own file is removed by the pass');
    A.ok(await present(live), '(b) a file a live session\'s transcript row names stays');
    A.ok(await present(branched), '(b) a file a /branch copy names only in the page\'s save stays');

    // (a) again, once the only session naming the file is the one being deleted: it goes
    const last = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: [branched.path], streamId: 'ws_branch' });
    A.eq([last.body.removed, last.body.kept], [1, 0], '(a) the branch\'s own delete removes the file nothing else names: ' + JSON.stringify(last.body));
    A.ok(!(await present(branched)), '(a) ...and it is gone');

    // (a) a restored copy ("<id>~restored2", minted by sidecar/save-restore.js) is a page session too: its delete is taken, and only the copy
    // itself is left out of the proof. An id outside that grammar, and a list longer than one post takes, are refused whole
    const copyOwn = await upload('copy-own.txt');
    await save([
      { id: 'ws_live', title: 'Live', history: [] },
      { id: 'ws_live~restored2', title: 'Live (restored)', history: [page('the restored copy', [copyOwn, live])] }
    ]);
    const copy = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: [copyOwn.path, live.path], streamId: 'ws_live~restored2' });
    A.eq([copy.status, copy.body.removed, copy.body.kept, copy.body.proved], [200, 1, 1, true], '(a) a restored copy\'s delete is taken: ' + JSON.stringify(copy.body));
    A.ok(!(await present(copyOwn)) && await present(live), '(a) its own file goes; the file a live session names stays');
    const nested = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: [live.path], streamId: 'ws_live~restored~restored3' });
    A.ok(nested.status === 200 && nested.body.kept === 1 && await present(live), '(a) a copy of a copy is a page session too, and the file a live session names stays: ' + JSON.stringify(nested.body));
    A.eq((await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: [live.path], streamId: 'ws_live~other' })).status, 400, '(a) an id outside the session grammar is refused');
    const many = Array.from({ length: 501 }, (_, i) => '.attachments/' + i + '.txt');
    A.eq((await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', paths: many.concat([live.path]), streamId: 'ws_other' })).status, 400, '(a) more paths than one post takes is refused whole, never cut short');
    A.ok(await present(live), '(a) ...and removes nothing');

    // the composer's one-file delete runs the same proof (nothing left out): a fresh upload nothing names goes, and a file a live session
    // names stays, so a page built before the session delete took `paths` cannot remove it either
    const chip = await upload('chip.txt');
    const one = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', path: chip.path });
    A.ok(one.status === 200 && one.body.ok && !(await present(chip)), 'the composer\'s delete of a fresh upload removes it: ' + JSON.stringify(one.body));
    const stale = await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', path: live.path });
    A.eq([stale.status, stale.body.removed, stale.body.kept, stale.body.proved], [200, false, true, true], 'a one-file delete of a file a live session names keeps it: ' + JSON.stringify(stale.body));
    A.ok(await present(live), '...and it is still there');
    A.eq((await json('POST', '/api/attachments', { op: 'delete', agent: 'agent', path: 'notes/secret.md' })).status, 400, 'a path outside .attachments/ is refused');
    await fixture.dispose();
    await tornLineScenario(mock);
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('attachment-delete-in-use.http');
})().catch(e => { console.error(e); process.exit(1); });
