/* node test/group-earlier-note.http.test.js — a group run's input carries the dropped-messages note through the REAL
   sidecar (context-budget-and-fold, step 1; the seam twin of group-earlier-note.test.js).

   A group with 101 messages (an imported history of 100 and one live send) runs its lead through the actual /api/groups
   route -> makeGroupSessions -> runOnce -> runAgentLoop; only the provider is a local stand-in. The request the provider
   sees must hold the system prompt and ONE <conversation_summary> note carrying the 21 messages the 80-message window
   left out (verbatim, worded as what was said in this chat), ahead of the group's user message with the window — and no
   second note: index.js skips its own earlier-conversation block for a group run, and the run accepts the system message
   the group coordinator now hands it. On this non-Claude chat wire the note arrives as the fenced leading text of the
   newest user turn (provider.js userSideHostNotes), exactly as the 1:1 chat's earlier note does. */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostNotes, userWords, text } = require('./helpers/host-notes.js');

const requests = [];
const server = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Here is where the thread stands.' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
const groupMessage = m => m && m.role === 'user' && userWords(m).startsWith('Shared conversation context (');
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const fixture = SidecarFixture.create({ prefix: 'group-note-http-', timeoutMs: 20000,
    env: { SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-group-note', STARNET_OPENROUTER_KEY: 'sk-or-v1-group-note', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model' } });
  try {
    await fixture.start();
    const request = async (method, query, b) => {
      const r = await fixture.request('/api/groups' + query, { method, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result.result;
    };
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'agent', model: 'test/model', provider: 'openrouter', approvalMode: 'full', system: 'IDENTITY_NOTE_LEAD' }] });
    // a hundred earlier messages: the Commander, then the lead, in turn; each ends with a ';' so no number is a prefix of another
    const earlier = Array.from({ length: 100 }, (_, i) => i % 2 === 0 ? { role: 'user', content: 'N-msg-' + i + ';' } : { role: 'assistant', agentId: 'agent', content: 'N-msg-' + i + ';' });
    const g = await request('POST', '', { op: 'create', members: ['agent'], title: 'Long group', history: earlier });
    assert.equal(g.messages.length, 100, 'the imported history is in the group');
    await request('POST', '', { op: 'send', id: g.id, key: 'live', text: 'N-latest: summarize where we are' });
    let state;
    for (let n = 0; n < 300; n++) {
      state = await request('GET', '?id=' + g.id);
      if (state.turns.length && state.turns.every(t => ['completed', 'failed', 'held', 'stopped'].includes(t.state))) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(state.turns.length, 1, JSON.stringify(state.turns));
    assert.equal(state.turns[0].state, 'completed', 'the run accepted its input and finished: ' + JSON.stringify(state.turns[0]));

    const groupRequest = requests.find(r => (r.messages || []).some(groupMessage));
    assert.ok(groupRequest, "the lead's run reached the provider (" + requests.length + ' requests)');
    const sent = groupRequest.messages;
    const user = sent.filter(groupMessage).pop();
    assert.equal(sent.filter(m => m.role === 'system').length, 1, 'the system prompt is the only system message');
    assert.ok(sent[0].role === 'system' && /IDENTITY_NOTE_LEAD/.test(text(sent[0].content)), "the lead's system prompt comes first");
    assert.equal(sent[sent.length - 1], user, 'and the group message is the newest turn');
    assert.ok(text(user.content).startsWith('<conversation_summary>'), 'the note rides ahead of the group message, in the same turn');
    const notes = hostNotes(sent, 'conversation_summary');
    assert.equal(notes.length, 1, 'exactly one summary note in the request');
    assert.equal(JSON.stringify(sent).split('<conversation_summary>').length - 1, 1, 'and no second note anywhere in it (index.js adds none for a group run)');
    const note = notes[0], window = userWords(user);
    // 101 messages, window 80 (the newest): messages 0..20 are the dropped ones
    for (let i = 0; i <= 20; i++) {
      assert.ok(note.includes('N-msg-' + i + ';'), 'dropped message ' + i + ' is in the note');
      assert.ok(!window.includes('N-msg-' + i + ';'), 'and not in the window');
    }
    for (let i = 21; i < 100; i++) assert.ok(window.includes('N-msg-' + i + ';') && !note.includes('N-msg-' + i + ';'), 'window message ' + i + ' is in the window only');
    assert.ok(note.includes('[brief from agent] N-msg-1;') && !note.includes('[brief from user]'), "the lead's message is named, the Commander's is plain");
    assert.match(note, /what was said in this chat/);
    assert.match(note, /not the Commander['’]s instructions/);
    assert.ok(!/from the Commander/.test(note) && !/still holds/.test(note), "never worded as the Commander's standing instructions");
    assert.ok(window.includes('Current USER request: N-latest: summarize where we are'), 'the live request rides the window message as before');
    console.log('group-earlier-note.http: real sidecar, group run input = system, one ownerVoice:false note (21 dropped messages verbatim) ahead of the window message PASS');
  } catch (e) { console.error(fixture.output().slice(-8000)); throw e; } finally { await fixture.dispose(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
