'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-message-attachments-'));
let sequence = 0, api;
const deps = { fs, path, root, now: () => ++sequence, id: () => 'id' + (++sequence), log() {},
  roster: () => [{ id: 'agent', name: 'Lead' }], execute: async () => { throw Error('Paused fixture must not run'); },
  uploadFile: (name, content) => ({ name, content, hash: createHash('sha256').update(content).digest('hex') }) };
(async () => {
  try {
    api = makeGroupSessions(deps); await api.ready;
    const group = await api.create({ members: ['agent'] }); await api.control(group.id, { action: 'pause' });
    const upload = { key: 'upload-one', name: 'first.png', content: 'cGljdHVyZQ==' };
    let state = await api.attach(group.id, upload); const first = state.artifacts[0].id;
    state = await api.attach(group.id, upload); assert.equal(state.artifacts.length, 1, 'retry never duplicates an uploaded file');
    await assert.rejects(api.attach(group.id, { ...upload, content: 'b3RoZXI=' }), /does not match/);
    await api.send(group.id, { key: 'send-one', text: 'Describe this', artifactIds: [first, first] });
    state = await api.get(group.id); assert.deepEqual(state.messages[0].artifactIds, [first], 'message records its exact files');
    state = await api.attach(group.id, { key: 'upload-two', name: 'second.txt', content: 'dGV4dA==' });
    const second = state.artifacts[1].id;
    await api.send(group.id, { key: 'send-two', text: 'And this file', artifactIds: [second] });
    state = await api.get(group.id); assert.deepEqual(state.messages.map(m => m.artifactIds), [[first], [second]], 'attachments stay on their own turns');
    const branch = await api.fork(group.id, { messageId: state.messages[0].id });
    assert.deepEqual(branch.messages[0].artifactIds, [first], 'branch retains the selected message attachment');
    assert.deepEqual(branch.artifacts.map(a => a.id), [first], 'branch cannot leak a later message file into the shared shelf');
    await api.send(group.id, { key: 'send-one', text: 'Retry', artifactIds: [first] });
    assert.equal((await api.get(group.id)).messages.length, 2, 'lost send response can be retried without duplicate messages');
    const other = await api.create({ members: ['agent'] }); await api.control(other.id, { action: 'pause' });
    await assert.rejects(api.send(other.id, { key: 'cross-group', text: 'Wrong group', artifactIds: [first] }), /not in this conversation/);
    await assert.rejects(api.send(group.id, { key: 'missing', text: 'Missing', artifactIds: ['absent'] }), /not in this conversation/);
    await assert.rejects(api.send(group.id, { key: 'shape', text: 'Invalid', artifactIds: first }), /up to 20/);
    await assert.rejects(api.send(group.id, { key: 'count', text: 'Too many', artifactIds: Array(21).fill(first) }), /up to 20/);
    assert.equal((await api.get(group.id)).messages.length, 2, 'invalid attachment sends are atomic');
    api.close(); api = makeGroupSessions(deps); await api.ready;
    state = await api.get(group.id); assert.deepEqual(state.messages.map(m => m.artifactIds), [[first], [second]], 'message association survives restart');
    assert.equal((await api.attach(group.id, upload)).artifacts.length, 2, 'upload retry remains idempotent after restart');
    assert.equal((await api.file(group.id, first)).content, upload.content, 'the original attachment bytes remain available');
    await api.send(group.id, { key: 'plain', text: 'No attachment' });
    assert.equal((await api.get(group.id)).messages.at(-1).artifactIds, undefined, 'plain messages do not inherit shared files');
    state = await api.attach(group.id, { name: 'legacy.txt', content: 'bGVnYWN5' });
    assert.equal(state.artifacts.at(-1).attachmentKey, undefined, 'legacy clients can still share files without inventing a message link');
    deps.readFile = async (owner, rel) => {
      assert.equal(owner, 'agent');
      if (rel === '.attachments/missing') throw Error('File unavailable');
      return { name: 'original.txt', content: 'cHJvb2Y=', encoding: 'base64', hash: 'proof-hash', bytes: 5 };
    };
    const history = Array.from({ length: 125 }, (_, n) => ({ role: 'user', content: 'message ' + n, ts: 1000 + n }));
    history[0].attachments = [{ path: '.attachments/proof', name: 'proof.txt' }];
    history[124].attachments = [{ path: '.attachments/proof', name: 'proof.txt' }];
    const request = { id: 'converted', conversionKey: 'converted', originalAgentId: 'agent', members: ['agent'], history };
    const converted = await api.create(request);
    assert.equal(converted.messages.length, 125, 'conversion preserves the full stored transcript');
    assert.equal(converted.messages[0].at, 1000, 'historical timestamps survive');
    assert.equal(converted.artifacts.length, 1, 'repeated references share one immutable file');
    const aid = converted.artifacts[0].id;
    assert.deepEqual(converted.messages[0].artifactIds, [aid]);
    assert.deepEqual(converted.messages[124].artifactIds, [aid]);
    assert.equal((await api.file(converted.id, aid)).content, 'cHJvb2Y=');
    assert.deepEqual(await api.create(request), converted, 'lost conversion response is safe to retry');
    await assert.rejects(api.create({ ...request, id: 'bad-conversion', history: [{ role: 'user', content: 'keep me', attachments: [{ path: '.attachments/proof' }, { path: '.attachments/missing' }] }] }), /unavailable/);
    await assert.rejects(api.get('bad-conversion'), /not found/, 'failed file import creates no partial group');
    api.close(); api = makeGroupSessions(deps); await api.ready;
    assert.equal((await api.file(converted.id, aid)).content, 'cHJvb2Y=', 'imported file bytes survive restart');
    assert.deepEqual((await api.create(request)).messages[0].artifactIds, [aid], 'conversion retry survives restart');
    console.log('group-message-attachments: association, file bytes, isolation, validation, upload/send retries and restart PASS');
  } finally { api?.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
