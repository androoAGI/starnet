/* node test/session-delete-forgets.e2e.test.js — A DELETED SESSION NEVER REACHES THE MODEL AGAIN (qa/bugs/3e926b6a),
   through a REAL hermetic sidecar (SidecarFixture: temp workspace + profile + port) and a mock OpenRouter that records
   every request body. The bug's own repro:

     1. A session (ws_quokka) says "echo session uniqueword quokka"; its run saves two memories (one filed under the
        chat, one station-wide). A second session (ws_keep) drafts the platypus plan — the control.
     2. The Commander deletes ws_quokka from the rail: POST /api/save with deletedIds and forgetIds ["ws_quokka"] (what
        deleteWorkstream's Workstreams.del(id, { forget: true }) + persist write).
     3. Every context path forgets it, and only it:
          HISTORY       GET /api/transcript?stream=ws_quokka is empty; a run on that id (a re-open, a bound channel) is
                        not seeded with the deleted dialogue (the H1.2 resume seed).
          RECALL        recall_conversation search (scope all) and browse return no deleted row, and the live session
                        is still found.
          EVIDENCE      a later run in another session carries no RECENT ACTIVITY line from it (the platypus line still
                        rides — the pack is working).
          MEMORY        both memories its run wrote are gone from the notebook and from the later run's recall fence.
          CROSS-SESSION the station read of ws_keep is untouched.
     4. All of it holds after a sidecar restart on the same workspace (the ledger is durable).
     THE REGISTRY'S STORES (turn identity commit 12): the files the session attached sit in the agent's workspace, where its file tools read
        them - the deleted session's is gone, a file another session attached is not (ATTACHMENT FILES); and GET /api/runs lists no run of the
        deleted session, whose title is its words (RUN TITLES, runView). The per-store proofs are test/forget-stores.test.js (each entry over its
        real store) and the census; the full cross-store run with the aux passes on is the forgotten-everywhere step.
     5. A session re-opened under the same id hears only what was said after the delete. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { runContextOf, recallOf, userWords } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const DELETED = 'ws_quokka', KEPT = 'ws_keep', FRESH = 'ws_fresh';
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : (c == null ? '' : String(c)));

function startUpstream() {
  const state = { phase: 'seed', calls: [], seq: 0 };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice'] }] }));
      }
      let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
      const messages = body.messages || [];
      const auxiliary = !(body.tools || []).length && /reflect|thread|ideas|summar/i.test(text(messages[0] && messages[0].content));
      state.calls.push({ phase: state.phase, auxiliary, body });
      let delta = {}, finish = 'stop';
      const tool = (name, args) => { delta = { tool_calls: [{ index: 0, id: 'tomb_' + (++state.seq), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finish = 'tool_calls'; };
      const lastUser = messages.map(m => m.role).lastIndexOf('user');
      const done = name => messages.slice(lastUser + 1).filter(m => (m.tool_calls || []).some(t => t.function && t.function.name === name)).length;
      const offered = name => (body.tools || []).some(t => t.function && t.function.name === name);
      if (auxiliary) delta.content = 'NONE';
      else if (offered('brief_proceed') && !done('brief_proceed')) tool('brief_proceed', { objective: 'Answer the Commander' });
      else if (state.phase === 'seed') {
        if (done('notebook_write') === 0) tool('notebook_write', { title: 'Quokka codeword', body: 'The quokka codeword is Wallaby-Seven' });
        else if (done('notebook_write') === 1) tool('notebook_write', { title: 'Quokka pet', body: 'The Commander keeps a pet quokka named Wallaby-Nine', scope: 'global' });
        else delta.content = 'Reply to: echo session uniqueword quokka — done.';
      } else if (state.phase === 'probe') {
        if (done('recall_conversation') === 0) tool('recall_conversation', { query: 'quokka platypus', scope: 'all' });
        else if (done('recall_conversation') === 1) tool('recall_conversation', {});
        else delta.content = 'I found nothing about that.';
      } else delta.content = state.phase === 'keep' ? 'Platypus plan noted.' : 'Acknowledged.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

function hermeticEnv(base) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    SKYNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'tomb-fixture', SKYNET_DEFAULT_MODEL: 'test/model' });
}

(async () => {
  const up = await startUpstream();
  const fixture = SidecarFixture.create({ prefix: 'starnet-session-delete-', timeoutMs: 30000, env: hermeticEnv(up.base) });
  const json = (method, route, body) => fixture.json(method, route, body);
  async function run(phase, streamId, words, extra) {
    up.state.phase = phase;
    const from = up.state.calls.length;
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({
      provider: 'openrouter', model: 'test/model', agentId: 'agent', isTask: true, streamId, surface: 'interactive',
      system: 'You are NOVA.', objects: ['computer', 'notebook'], messages: [{ role: 'user', content: words }] }, extra || {})) });
    const raw = await r.text();
    A.eq(r.status, 200, phase + ': the run streams');
    const events = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const end = events.find(e => e.name === 'agent.run.end');
    A.eq(end && end.payload && end.payload.reason, 'done', phase + ': the run finishes (' + JSON.stringify(events.slice(-2)).slice(0, 300) + ')');
    return { bodies: up.state.calls.slice(from).filter(c => !c.auxiliary).map(c => c.body), events };
  }
  // a turn as text (the route answers rows; a legacy reader's "role: content" string reads the same)
  const turnText = t => typeof t === 'string' ? t : (t && t.role) + ': ' + text(t && t.content);
  const transcript = async stream => ((await json('GET', '/api/transcript?stream=' + stream)).body.turns || []).map(turnText);
  const records = async () => ((await json('GET', '/api/memory/records?agent=agent')).body.records || []);
  const toolResults = bodies => bodies.flatMap(b => (b.messages || []).filter(m => m.role === 'tool').map(m => text(m.content)));
  // everything the model was handed, minus the Commander's own words in the CURRENT request (they may say "quokka")
  function contextOf(body) {
    const msgs = body.messages || [];
    const lastUser = msgs.map(m => m.role).lastIndexOf('user');
    return msgs.map((m, i) => i === lastUser ? (runContextOf([m]) + recallOf([m])) : text(m.content) + JSON.stringify(m.tool_calls || '')).join('\n');
  }

  try {
    await fixture.start();
    A.eq((await json('POST', '/api/memory/config', { reflectEnabled: false })).status, 200, 'reflection off (no aux model calls)');

    // ---- 1. the session that will be deleted, and the control session ----
    const upload = async (name, body) => (await json('POST', '/api/attachments', { agent: 'agent', name, dataUrl: 'data:text/plain;base64,' + Buffer.from(body).toString('base64') })).body;
    const goneFile = await upload('quokka-notes.txt', 'kept notes about the quokka');
    const keepFile = await upload('platypus-notes.txt', 'kept notes about the platypus');
    A.ok(goneFile && goneFile.ok && keepFile && keepFile.ok && /^\.attachments\//.test(goneFile.path), 'both sessions\' files are uploaded into the agent\'s workspace');
    const fileStatus = async ref => (await fixture.request('/api/file?agent=agent&path=' + encodeURIComponent(ref.path), { headers: { 'X-StarNet-Token': fixture.token } })).status;
    const seeded = await run('seed', DELETED, 'echo session uniqueword quokka', { messages: [{ role: 'user', content: 'echo session uniqueword quokka', attachments: [goneFile] }] });
    A.ok(seeded.bodies.length >= 3, 'the seed run reached the model (two memory saves + the reply)');
    await run('keep', KEPT, 'Draft the platypus launch plan for Friday');
    // a message that attaches a file is not clean owner evidence (the file is third-party text), so the kept session's RECENT ACTIVITY line comes from the plain run above
    await run('keep', KEPT, 'Review the attached platypus notes', { messages: [{ role: 'user', content: 'Review the attached platypus notes', attachments: [keepFile] }] });
    A.eq([await fileStatus(goneFile), await fileStatus(keepFile)], [200, 200], 'before the delete both attachment files are served from the agent\'s workspace');
    const listedRuns = async () => ((await json('GET', '/api/runs?agent=*&limit=200')).body.runs || []);
    A.ok((await listedRuns()).some(r => r.streamId === DELETED), 'before the delete GET /api/runs lists the deleted session\'s run (its title is its words)');
    A.ok((await transcript(DELETED)).some(t => /uniqueword/.test(t)), 'before the delete the deleted session\'s words are in its transcript');
    const before = await records();
    A.ok(before.filter(r => /Wallaby/.test(String(r.body))).length === 2, 'before the delete its two memories are in the notebook: ' + JSON.stringify(before.map(r => r.body)));

    // ---- 2. the Commander deletes it (Workstreams.del(id, { forget: true }) + persist -> POST /api/save) ----
    const saved = await json('POST', '/api/save', { agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: 0,
      workstreams: [{ id: KEPT, title: 'Platypus plan', history: [] }, { id: FRESH, title: null, history: [] }], deletedIds: [DELETED], forgetIds: [DELETED] });
    A.eq(saved.status === 200 && saved.body && saved.body.ok, true, 'the save that deletes the session lands: ' + JSON.stringify(saved.body));

    // ---- 3. every context path forgets it ----
    async function provesForgotten(label) {
      A.eq(await transcript(DELETED), [], label + ' HISTORY: GET /api/transcript of the deleted session is empty');
      A.ok((await transcript(KEPT)).some(t => /platypus/.test(t)), label + ' CROSS-SESSION: the kept session reads as before');
      let recs = [];
      for (let i = 0; i < 100; i++) { recs = await records(); if (!recs.some(r => /Wallaby/.test(String(r.body)))) break; await new Promise(r => setTimeout(r, 50)); }
      A.ok(!recs.some(r => /Wallaby/.test(String(r.body))), label + ' MEMORY: the memories its run wrote are gone: ' + JSON.stringify(recs.map(r => r.body)));
      const probe = await run('probe', FRESH, 'what do you know about the quokka word from before');
      A.ok(probe.bodies.length >= 3, label + ': the probe run searched and browsed');
      const handed = probe.bodies.map(contextOf).join('\n');
      A.ok(!/uniqueword/.test(handed), label + ': no request of a later run carries the deleted session\'s words: ' + (handed.match(/.{0,80}uniqueword.{0,80}/) || [''])[0]);
      A.ok(!/Wallaby/.test(handed), label + ' MEMORY: no deleted memory rides the later run\'s recall');
      const note = runContextOf(probe.bodies[0].messages);
      A.ok(/RECENT ACTIVITY: /.test(note) && /platypus/.test(note), label + ' EVIDENCE: the pack still carries the live session\'s RECENT ACTIVITY: ' + note.slice(0, 400));
      A.ok(!/uniqueword/.test(note), label + ' EVIDENCE: …and no RECENT ACTIVITY line from the deleted session');
      const results = toolResults(probe.bodies);
      const search = results.find(t => /match|No messages/.test(t)) || '';
      const browse = results.find(t => /workstreams/i.test(t)) || '';
      A.ok(search && !/uniqueword|ws_quokka/.test(search) && /platypus/.test(search), label + ' RECALL: search (scope all) finds the live session, never the deleted one: ' + search.slice(0, 300));
      A.ok(browse && !/ws_quokka/.test(browse) && /ws_keep/.test(browse), label + ' RECALL: browse lists the live session, not the deleted one: ' + browse.slice(0, 300));
      // the registry's stores: the purge runs behind the reply, so poll for the attachment file the way the memory records are polled above
      let gone = 200;
      for (let i = 0; i < 100; i++) { gone = await fileStatus(goneFile); if (gone !== 200) break; await new Promise(r => setTimeout(r, 50)); }
      A.ok(gone !== 200, label + ' ATTACHMENT FILES: the deleted session\'s file is gone from the agent\'s workspace (the file route answers ' + gone + ')');
      A.eq(await fileStatus(keepFile), 200, label + ' ATTACHMENT FILES: the other session\'s file is still served');
      A.ok(!(await listedRuns()).some(r => r.streamId === DELETED), label + ' RUN TITLES: GET /api/runs lists no run of the deleted session');
      A.ok((await listedRuns()).some(r => r.streamId === KEPT), label + ' RUN TITLES: …and still lists the live session\'s');
    }
    await provesForgotten('after the delete:');
    A.ok(fs.existsSync(path.join(fixture.workspace, 'session-tombstones.json')), 'the delete is recorded in the sidecar\'s own ledger');

    // ---- 4. a restart on the same workspace keeps it forgotten ----
    await fixture.restart();
    await provesForgotten('after a restart:');

    // ---- 5. re-opened under the same id: only what is said after the delete ----
    const reopen = await run('reopen', DELETED, 'a new beginning with kangaroo');
    A.ok(reopen.bodies.length >= 1 && !reopen.bodies.some(b => /uniqueword/.test(contextOf(b))), 'a run on the deleted id is not seeded with the deleted dialogue (resume seed)');
    const after = await transcript(DELETED);
    A.ok(after.some(t => /kangaroo/.test(t)) && !after.some(t => /uniqueword/.test(t)), 'the re-opened session holds only its new turns: ' + JSON.stringify(after));
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('session-delete-forgets.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
