'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const requests = [];
// keys.save in a group (release review F9): the group's one "user" turn is the shared transcript — the Commander's words
// AND the peers' replies — so neither key below may ever be offered to keys.save on a participant's run
const COMMANDER_KEY = '5b8e2d9f1c4a7e0b3d6f9a2c5e8b1d4f7a0c3e6b';
const PEER_KEY = '8d1f4a7c0e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f';
const server = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const b = JSON.parse(raw); requests.push(b);
    const toolMessages = (b.messages || []).filter(m => m.role === 'tool');
    const sys = (b.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    const isQA = sys.includes('IDENTITY_QA');
    const tools = (b.tools || []).map(t => t.function.name);
    let call;
    const used = name => (b.messages || []).some(m => (m.tool_calls || []).some(c => c.function.name === name));
    const judgment = (b.messages || []).some(m => m.role === 'user' && String(m.content).includes('GROUP_JUDGMENT_PROOF'));
    if (judgment && tools.includes('brief_ask') && !used('brief_ask')) call = ['brief_ask', { dimension: 'audience', mode: 'conversation', question: 'Who is this report for?', sample: 'Draft: A technical report for engineers.', options: ['Engineers', 'Executives'], recommended: 'Engineers', reason: 'The audience changes the technical depth of the report.', discoverable: false }];
    else if (judgment) { /* Return the received decision without tool side effects. */ }
    else if (tools.includes('brief_proceed') && !used('brief_proceed')) call = ['brief_proceed', { objective: 'Build and review a shared report', deliverable: 'reviewed report', assumptions: ['Use the group workspace'] }];
    else if (!isQA && !used('fs_write')) call = ['fs_write', { path: 'group-result.md', content: 'EXACT_SHARED_VERSION_1' }];
    else if (!isQA && !used('group_publish')) call = ['group_publish', { path: 'group-result.md' }];
    else if (!isQA && !used('group_handoff')) call = ['group_handoff', { agentId: 'qa', request: 'Read the exact shared artifact and review it' }];
    else if (isQA && !used('group_read')) {
      const ctx = b.messages.find(m => m.role === 'user')?.content || '';
      const artifacts = ctx.match(/Shared files: (.*)\nCurrent USER/);
      const file = artifacts && JSON.parse(artifacts[1])[0];
      if (file) call = ['group_read', { artifactId: file.id }];
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + requests.length, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { content: isQA ? 'Reviewed exact version: ' + toolMessages.map(m => m.content).join('\n') : 'Shared the file and asked QA to review. Sample key from the docs: ' + PEER_KEY };
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const fixture = SidecarFixture.create({ prefix: 'group-http-', timeoutMs: 20000,
    env: { SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-group-test', STARNET_OPENROUTER_KEY: 'sk-or-v1-group-test', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model' } });
  try {
    await fixture.start();
    const request = async (method, query, b) => {
      const r = await fixture.request('/api/groups' + query, { method, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result.result;
    };
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: ['agent', 'qa'].map(agentId => ({ agentId, name: agentId, model: 'test/model', provider: 'openrouter', approvalMode: 'full', system: agentId === 'qa' ? 'IDENTITY_QA' : 'IDENTITY_ENGINEER' })) });
    // the starter floor (a DISH among its gear), saved the way the app saves it: group participants draw their room gear
    // from it, so web_request — and keys.save, were it allowed — would really be on their runs. The saved floor is also the routing
    // authority, which a group turn asks for its room: so it is saved as the app saves it NOW (the current save version, its window's
    // id, the floor in the form the save owner reads back), and an older save or a floor it cannot prove would hold the turn.
    const WM = require('../frontend/app/worldmodel.js');
    const { canonical } = require('./helpers/saved-floor.js');
    const rev = ((await fixture.json('GET', '/api/save?agent=agent')).body.save || {})._saveRevision || 0;
    const floor = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, _saveRevision: rev, _saveClient: 'group-http-page', updatedAt: Date.now(), agent: { id: 'agent' }, station: canonical(WM.starterDoc()) });
    assert.ok(floor.body && floor.body.ok, 'the starter floor is saved: ' + floor.text);
    const g = await request('POST', '', { op: 'create', members: ['agent', 'qa'], title: 'Integration group' });
    await request('POST', '', { op: 'send', id: g.id, key: 'origin', text: 'Build a report and ask QA to review the exact artifact. Our key for later: ' + COMMANDER_KEY });
    let state;
    for (let n = 0; n < 200; n++) {
      state = await request('GET', '?id=' + g.id);
      if (state.turns.length && state.turns.every(t => ['completed', 'failed', 'held', 'stopped'].includes(t.state))) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(state.turns.length, 2, JSON.stringify(state));
    assert.ok(state.turns.every(t => t.state === 'completed'), JSON.stringify(state));
    assert.equal(state.artifacts.length, 1);
    assert.match(state.messages.at(-1).content, /EXACT_SHARED_VERSION_1/);
    assert.ok(requests.some(r => (r.tools || []).some(t => t.function.name === 'group_handoff')));
    assert.ok(requests.every(r => !(r.tools || []).some(t => t.function.name === 'team_dispatch')));
    // F9: a group participant holds the dish (web_request is on its runs) yet is never offered keys.save — the shared
    // transcript carries the peer's "sample key", and even the Commander's own line there has no provable author
    const toolsOf = r => (r.tools || []).map(t => t.function.name);
    assert.ok(requests.some(r => toolsOf(r).includes('web_request')), 'control: group participants really hold the dish (web_request offered)');
    assert.ok(requests.some(r => JSON.stringify(r.messages || []).includes(PEER_KEY)), 'control: a participant run really read the peer\'s key');
    assert.ok(requests.every(r => !toolsOf(r).includes('keys_save')), 'no group participant run is ever offered keys_save');
    // THE GROUP'S LEAD IS THE ORCHESTRATOR: the lead holds the station kit (station.layout on the wire, the builder in its
    // deferred index, told to use them instead of the screen); the other participant stays a worker without it
    const sysOf = r => (r.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    const leadReqs = requests.filter(r => sysOf(r).includes('IDENTITY_ENGINEER') && (r.tools || []).length);
    const qaReqs = requests.filter(r => sysOf(r).includes('IDENTITY_QA') && (r.tools || []).length);
    assert.ok(leadReqs.length && qaReqs.length, 'both participants ran with tools');
    assert.ok(leadReqs.every(r => r.tools.some(t => t.function.name === 'station_layout')), 'the group lead can read the assembly lines');
    assert.ok(leadReqs.every(r => /station_build/.test(sysOf(r)) && /you lead this group chat/.test(sysOf(r))), 'the group lead is told where the station builder is');
    // a build follows the approval setting (Full Access asks nothing): the lead is never promised a card on every build
    assert.ok(leadReqs.every(r => !/approves each build/.test(sysOf(r)) && /follows the Commander's approval setting/.test(sysOf(r))), 'the group lead is told builds follow the approval setting');
    assert.ok(qaReqs.every(r => !r.tools.some(t => /^station_(layout|build|plan|map)$/.test(t.function.name)) && !/station_build/.test(sysOf(r))), 'a non-lead participant gets no station kit');
    const download = await fixture.request('/api/groups?id=' + g.id + '&file=' + state.artifacts[0].id);
    assert.equal(await download.text(), 'EXACT_SHARED_VERSION_1');
    const attached = await request('POST', '', { op: 'create', members: ['agent'], title: 'Message attachment proof' });
    await request('POST', '', { op: 'control', id: attached.id, action: 'pause' });
    const upload = { op: 'attach', id: attached.id, key: 'photo-upload', name: 'photo.png', content: Buffer.from('EXACT_USER_ATTACHMENT').toString('base64') };
    const uploaded = await request('POST', '', upload), artifactId = uploaded.artifacts[0].id;
    assert.equal((await request('POST', '', upload)).artifacts.length, 1, 'HTTP upload retry is idempotent');
    await request('POST', '', { op: 'send', id: attached.id, key: 'photo-message', text: 'Describe my photo', artifactIds: [artifactId] });
    assert.deepEqual((await request('GET', '?id=' + attached.id)).messages[0].artifactIds, [artifactId]);
    await fixture.restart();
    const restoredAttachment = await request('GET', '?id=' + attached.id);
    assert.deepEqual(restoredAttachment.messages[0].artifactIds, [artifactId], 'HTTP message-to-file association survives restart');
    const restoredFile = await fixture.request('/api/groups?id=' + attached.id + '&file=' + artifactId);
    assert.equal(await restoredFile.text(), 'EXACT_USER_ATTACHMENT', 'the referenced file retains exact bytes');
    state = await request('GET', '?id=' + g.id);
    assert.equal(state.turns.length, 2); assert.equal(state.messages.filter(m => m.author !== 'user').length, 2);
    const judgment = await request('POST', '', { op: 'create', members: ['agent'], title: 'Judgment proof' });
    await request('POST', '', { op: 'invite', id: judgment.id, agentId: 'qa' });
    assert.equal((await request('GET', '?id=' + judgment.id)).members.length, 2);
    await request('POST', '', { op: 'send', id: judgment.id, key: 'question-proof', text: 'Build a report for a specific audience. GROUP_JUDGMENT_PROOF: ask me who it is for before writing.' });
    let question;
    for (let n = 0; n < 150; n++) {
      state = await request('GET', '?id=' + judgment.id); question = state.questions?.find(q => q.state === 'pending');
      if (question) break; await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(question, JSON.stringify(state));
    assert.equal(question.mode, 'conversation');
    assert.equal(question.sample, 'Draft: A technical report for engineers.');
    assert.match(question.reason, /technical depth/);
    assert.equal(state.turns[0].state, 'waiting for answer');
    await request('POST', '', { op: 'answerQuestion', id: judgment.id, questionId: question.id, text: 'Executives' });
    for (let n = 0; n < 150; n++) { state = await request('GET', '?id=' + judgment.id); if (state.turns[0].state === 'completed') break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(state.turns[0].state, 'completed', JSON.stringify(state));
    assert.ok(requests.some(r => (r.messages || []).some(m => m.role === 'tool' && String(m.content).includes('Executives'))));
    console.log('group HTTP: brief.ask choice -> durable group card -> answer -> SAME run resumed PASS');
    console.log('group HTTP: actual runOnce -> fs.write -> immutable publish -> peer handoff -> exact file review -> restart PASS');
  } catch (e) { console.error(fixture.output().slice(-8000)); throw e; } finally { await fixture.dispose(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
