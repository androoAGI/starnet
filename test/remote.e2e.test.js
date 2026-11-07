/* node test/remote.e2e.test.js — StarNet Remote phase 1 against a REAL booted sidecar.

   A mock provider plays the model (zero spend). The phone is relay/app/phone-client.js, the WebCrypto-only
   client a phone browser runs. What this proves, in order:
     1. Remote is OFF by default: no LAN door, pairing refused, and /api/remote is behind the desk token.
     2. The desk switches it on; a phone pairs with a one-time code over the LAN door and opens a sealed session.
     3. The phone starts a real task. The run asks to run a shell command; the approval reaches the phone as an
        event; the phone approves ONCE; the run finishes and its reply is in the conversation.
     4. A phone cannot grant ALWAYS / FULL ACCESS.
     5. A run is DETACHED: the phone disconnects mid-run, the run still finishes, and the reply is there on reconnect.
     6. A DESKTOP run's approval is answerable from the phone, and the desk stream learns it was answered.
     7. The LAN door serves no /api route; revoke cuts a phone off at once.
     8. Across a restart: Remote stays on, the station key and the paired phone persist, and the phone reconnects.
     9. SESSION PARITY: a session that exists on the desk (in the station save) is in the phone's list with its
        title and history; a phone turn sent into it runs WITH that history and lands under the same session id;
        phone-started runs are listed for the desk to adopt (GET /api/remote/recent).
    10. THE STATION PICTURE: the desk page hands over a still (POST /api/remote/view); the phone reads it with the
        `view` verb, which is also what tells the desk a phone is looking; each agent's portrait is its own sprite.
    11. NOTIFICATIONS: the phone reads the station's push key, subscribes, and a push it cannot deliver is reported
        as not sent (never as sent). */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
// the run-context note is the leading text of the newest user message on a non-Claude chat wire: match the Commander's own words
const { userWords } = require('./helpers/host-notes.js');
const Phone = require('../relay/app/phone-client.js');

const HOST = '127.0.0.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, ms, label) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return; await sleep(30); } throw new Error('timed out waiting for ' + label); }
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, HOST, () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

/* The model: each task is a tiny script keyed on the LAST user message.
     "remote shell proof"   -> brief_proceed, then shell_exec (needs approval), then "REMOTE_SHELL_DONE"
     "desk shell proof"     -> same shape for a desktop /api/run, answering "DESK_SHELL_DONE"
     "slow reply"           -> holds the stream open until release(), then "SLOW_DONE"
     anything else          -> "OK" */
function startMockModel() {
  const gate = { held: null, release() { const r = gate.held; gate.held = null; if (r) r(); } };
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
        requests.push(parsed);
        const msgs = parsed.messages || [];
        const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
        const text = lastUser ? userWords(lastUser) : '';
        const after = msgs.slice(msgs.lastIndexOf(lastUser) + 1);
        const tools = after.filter(m => m && m.role === 'tool');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const call = (id, name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        };
        const say = async (answer, hold) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 3) } }] }) + '\n\n');
          if (hold) await new Promise(r => { gate.held = r; });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(3) } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        };
        const shellScript = (tag, done) => {
          if (tools.length === 0) return call('b_' + tag, 'brief_proceed', { objective: 'Run the ' + tag + ' proof' });
          if (!tools.some(m => /SHELL_OK_/.test(JSON.stringify(m))) && tools.length < 3) return call('s_' + tag, 'shell_exec', { cmd: 'echo SHELL_OK_' + tag + '> ' + tag + '-proof.txt && ' + (process.platform === 'win32' ? 'type ' : 'cat ') + tag + '-proof.txt' });
          return say(done);
        };
        if (/remote shell proof/i.test(text)) return shellScript('remote', 'REMOTE_SHELL_DONE');
        if (/desk shell proof/i.test(text)) return shellScript('desk', 'DESK_SHELL_DONE');
        if (/slow reply/i.test(text)) return say('SLOW_DONE', true);
        // session parity: did the run receive the desk session's earlier turns?
        if (/what is the code word/i.test(text)) return say(msgs.some(m => /HELIX/.test(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))) ? 'CODEWORD_HELIX_SEEN' : 'NO_CONTEXT');
        return say('OK');
      });
    });
    server.listen(0, HOST, () => resolve({ server, gate, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const llm = await startMockModel();
  const lanPort = await freePort();
  const fx = new SidecarFixture({ prefix: 'sn-remote-e2e-', timeoutMs: 15000, env: {
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-remote-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-remote-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    STARNET_REMOTE_PORT: String(lanPort), STARNET_REMOTE_LAN: '1', STARNET_REMOTE_RELAY: 'off',
    STARNET_REMOTE_PUSH_HOSTS: '127.0.0.1'
  } });
  // Seed the same durable markers the dispatch host writes, then use the real sealed phone routes.
  const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
  const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
  const hash = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  let stamp = 100;
  const seedIo = makeSegmentedTranscriptIo({ fs, path, root: path.join(fx.workspace, 'transcript-history-v2') });
  const seeded = makeTranscriptStore({ io: seedIo, clock: { now: () => ++stamp } });
  const accepted = '{"answer":"PHONE_ACCEPTED"}';
  // A pre-fix desk save can outlive the rejected execution and must not reintroduce it on merge.
  const staleDispatchSession = { id: 'dispatch_phone', title: 'Research', agentId: 'forge', conversationMode: 'direct', lastActiveAt: 0,
    history: [{ role: 'user', content: 'Research request', sourceRunId: 'phone_original', ts: 99 },
      { role: 'assistant', content: 'RAW_REJECTED_SAVED_DESK', sourceRunId: 'phone_original', ts: 100 }] };
  const saveWithSessions = workstreams => fx.json('POST', '/api/save', { schema: 'starnet.save', version: 6,
    agent: { id: 'agent', name: 'ULTRON', createdAt: 1 }, workstreams });
  const append = (streamId, sourceRunId, dispatchState, role, content, extra) => seeded.appendStrict({ streamId, sourceRunId, dispatchState, role, content, agentId: 'forge', ...extra });
  append('dispatch_phone', 'phone_original', 'pending', 'user', 'RAW_CONTRACT_PROMPT');
  append('dispatch_phone', 'phone_original', 'pending', 'assistant', 'RAW_INVALID_OUTPUT');
  append('dispatch_phone', 'phone_repair', 'internal', 'user', '[STRUCTURED RESULT REPAIR] INTERNAL_REPAIR_PROMPT');
  append('dispatch_phone', 'phone_repair', 'internal', 'assistant', 'INTERNAL_REPAIR_REPLY');
  append('dispatch_phone', 'phone_original', 'final', 'assistant', accepted, { dispatchPrompt: 'Research request', dispatchReason: 'done', dispatchRepairRunId: 'phone_repair', textLength: accepted.length, textSha256: hash(accepted) });
  append('dispatch_phone', 'phone_repair', 'internal', 'user', '[STRUCTURED RESULT REPAIR] LATE_INTERNAL_PROMPT');
  seeded.appendStrict({ streamId: 'pending_phone', agentId: 'forge', role: 'user', content: 'Pending user request' });
  append('pending_phone', 'phone_pending', 'pending', 'assistant', 'PENDING_RAW_OUTPUT');
  append('pending_phone', 'phone_pending_repair', 'internal', 'user', '[STRUCTURED RESULT REPAIR] PENDING_INTERNAL_PROMPT');
  // The saved desk cache is a display copy. Canonical replay reads the host's durable
  // transcript, as it does for a real completed desk turn; seed that same authority.
  const deskHistory = [
    seeded.appendStrict({ streamId: 'ws_desk_launch', agentId: 'forge', sourceRunId: 'desk_helix', turnId: 'desk_helix_turn_001', kind: 'turn', role: 'user', content: 'remember the code word is HELIX' }),
    seeded.appendStrict({ streamId: 'ws_desk_launch', agentId: 'forge', sourceRunId: 'desk_helix', turnId: 'desk_helix_turn_001', kind: 'turn', role: 'assistant', content: 'Noted. The code word is HELIX.' })
  ];
  seedIo.close(); // publish the final seed index before the real host owns this directory
  async function checkDispatchPhone(phone, phase, preview) {
    const thread = await phone.call('thread', { streamId: 'dispatch_phone' });
    A.eq(thread.ok, true, phase + ': phone reads accepted dispatch thread');
    A.eq(thread.data.filter(t => t.content === accepted).length, 1, phase + ': phone displays accepted answer exactly once');
    A.ok(!/RAW_CONTRACT|RAW_INVALID|RAW_REJECTED|INTERNAL_REPAIR|LATE_INTERNAL/.test(JSON.stringify(thread.data)), phase + ': phone thread excludes raw and repair evidence');
    const pending = await phone.call('thread', { streamId: 'pending_phone' });
    A.eq(pending.data.map(t => t.content), ['Pending user request'], phase + ': pending raw answer and repair prompt stay out of phone history');
    const listed = await phone.call('threads', { limit: 100 });
    A.eq(listed.data.find(t => t.streamId === 'dispatch_phone').preview, preview, phase + ': phone preview follows visible conversation topic');
    A.eq(listed.data.find(t => t.streamId === 'pending_phone').preview, 'Pending user request', phase + ': pending repair cannot overwrite phone preview');
    console.log('phone projection proof: ' + JSON.stringify({ phase, acceptedCount: thread.data.filter(t => t.content === accepted).length, rawEvidenceVisible: /RAW_CONTRACT|RAW_INVALID|RAW_REJECTED|INTERNAL_REPAIR|LATE_INTERNAL/.test(JSON.stringify(thread.data)), pendingContents: pending.data.map(t => t.content), preview: listed.data.find(t => t.streamId === 'dispatch_phone').preview }));
  }
  const lan = 'http://' + HOST + ':' + lanPort;
  let client = null;
  const deskEvents = [];
  try {
    await fx.start();

    // 1. off by default, and the desk switch is behind the desk token
    const noTok = await fetch(fx.baseUrl + '/api/remote', { headers: { Origin: fx.baseUrl } });
    A.ok(noTok.status === 401 || noTok.status === 403, '/api/remote needs the desk token (got ' + noTok.status + ')');
    const off = await fx.json('GET', '/api/remote');
    A.eq(off.body.enabled, false, 'Remote is off by default');
    A.eq(off.body.listening, false, 'nothing listens on the LAN by default');
    A.eq((await fx.json('POST', '/api/remote/pair', {})).status, 409, 'pairing is refused while Remote is off');
    let lanClosed = false; try { await fetch(lan + '/remote/v1/info', { signal: AbortSignal.timeout(1500) }); } catch (_) { lanClosed = true; }
    A.ok(lanClosed, 'the LAN door is closed while Remote is off');

    const roster = await fx.json('POST', '/api/roster', { agents: [{ agentId: 'forge', name: 'FORGE', system: 'You are FORGE, a builder.', model: 'test/model' }] });
    A.eq(roster.status, 200, 'roster saved');
    const persistedDispatch = await saveWithSessions([staleDispatchSession]);
    A.ok(persistedDispatch.status === 200 && persistedDispatch.body.ok, 'pre-fix saved dispatch history persisted');

    // 2. switch on, pair, open a sealed session
    const on = await fx.json('POST', '/api/remote/enable', { on: true });
    A.eq(on.body.enabled, true, 'Remote switched on');
    A.eq(on.body.port, lanPort, 'the LAN door opened on the configured port');
    const pr = await fx.json('POST', '/api/remote/pair', { name: 'Test phone' });
    A.eq(pr.status, 200, 'pairing code issued');
    A.ok(/^[A-Z2-9]{8}$/.test(pr.body.code), 'code shape');
    const blob = JSON.parse(Buffer.from(pr.body.pairBlob.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    A.eq(blob.c, pr.body.code, 'the pairing blob carries the code for the QR');
    A.ok(pr.body.pairUrl === null || /\/remote\/app\/#pair=/.test(pr.body.pairUrl), 'the pair URL keeps the secret in the fragment');

    const key = await Phone.makeDeviceKey();
    const paired = await Phone.pair({ base: lan, pairingId: pr.body.pairingId, code: pr.body.code, name: 'Test phone', key });
    A.ok(/^dev_/.test(paired.deviceId), 'phone paired over the LAN door');
    const st = await fx.json('GET', '/api/remote');
    A.eq(st.body.devices.length, 1, 'the desk lists the paired phone');
    A.eq(st.body.devices[0].name, 'Test phone', 'with its name');

    client = Phone.connect({ base: lan, deviceId: paired.deviceId, stationPub: pr.body.stationPub, key });
    const status = await client.call('status');
    A.eq(status.ok, true, 'status over the sealed channel');
    A.ok(status.data.agents.some(a => a.agentId === 'forge' && a.state === 'idle'), 'the phone sees FORGE idle');

    const events = [];
    client.onEvent(e => events.push(e));
    const listening = client.listen();
    await waitUntil(async () => (await fx.json('GET', '/api/remote')).body.connected.some(c => c.live), 5000, 'phone event stream attached');

    await checkDispatchPhone(client, 'before restart', 'Research request');
    const beforeContinuation = llm.requests.length;
    const followDispatch = await client.call('send', { agentId: 'forge', streamId: 'dispatch_phone', text: 'Continue the accepted phone result' });
    A.eq(followDispatch.ok, true, 'phone can continue a finalized dispatch conversation');
    await waitUntil(() => events.some(e => e.type === 'run.ended' && e.runId === followDispatch.data.runId), 20000, 'phone dispatch continuation');
    const continuationEnd = events.find(e => e.type === 'run.ended' && e.runId === followDispatch.data.runId);
    A.eq([continuationEnd.outcome, continuationEnd.error], ['succeeded', null], 'the accepted phone continuation actually succeeds');
    // Locate this owned action by its observed transport window. Chat role projection may combine adjacent
    // user turns, leaving host notes in the middle; exact flattened userWords equality is not an identity.
    const continuationRequests = llm.requests.slice(beforeContinuation);
    A.eq(continuationRequests.length, 1, 'the continuation makes exactly one real synthetic-provider request');
    const contextRequest = continuationRequests[0];
    if (!contextRequest) throw new Error('phone continuation reached no provider: ' + JSON.stringify(continuationEnd));
    const newestInput = [...contextRequest.messages].reverse().find(m => m.role === 'user');
    const newestWords = userWords(newestInput);
    A.ok(newestWords === 'Continue the accepted phone result' || newestWords.endsWith('\n\nContinue the accepted phone result'),
      'the current phone input remains the newest complete user text after role projection');
    A.ok(contextRequest && contextRequest.messages.some(m => m.role === 'assistant' && m.content === accepted), 'phone send context contains the accepted answer');
    A.ok(!/RAW_CONTRACT|RAW_INVALID|RAW_REJECTED|INTERNAL_REPAIR|LATE_INTERNAL/.test(JSON.stringify(contextRequest.messages)), 'phone send context excludes raw output and repair instructions');

    // 3. a real task from the phone, with an approval answered on the phone
    const sent = await client.call('send', { agentId: 'forge', text: 'remote shell proof' });
    A.eq(sent.ok, true, 'send accepted: ' + JSON.stringify(sent));
    const runId = sent.data.runId, streamId = sent.data.streamId;
    await waitUntil(() => events.some(e => e.type === 'approval.opened' && e.approval.runId === runId), 20000, 'approval event on the phone');
    const ap = events.find(e => e.type === 'approval.opened' && e.approval.runId === runId).approval;
    A.eq(ap.surface, 'remote', 'the approval is marked as a phone run');
    A.eq(ap.tool, 'shell.exec', 'the approval names the tool');
    A.ok(/SHELL_OK_remote/.test(ap.argsSummary), 'the approval shows what will run');

    // 4. no standing grants from a phone
    const always = await client.call('decide', { runId, promptId: ap.promptId, decision: 'always' });
    A.eq(always.ok, false, 'a phone cannot grant ALWAYS');
    const full = await client.call('decide', { runId, promptId: ap.promptId, decision: 'full' });
    A.eq(full.ok, false, 'a phone cannot grant FULL ACCESS');
    const seen = await client.call('seen', { runId, promptId: ap.promptId });
    A.eq(seen.data.extended, true, 'showing it to a human earns the one extension');
    const once = await client.call('decide', { runId, promptId: ap.promptId, decision: 'once' });
    A.eq(once.ok, true, 'approve once from the phone');
    await waitUntil(() => events.some(e => e.type === 'run.ended' && e.runId === runId), 30000, 'run end on the phone');
    const ended = events.find(e => e.type === 'run.ended' && e.runId === runId);
    A.eq(ended.error, null, 'the run ended without error: ' + JSON.stringify(ended));
    A.ok(events.some(e => e.type === 'run.tool' && e.runId === runId && e.name === 'shell_exec'), 'the phone saw the step');
    A.ok(events.some(e => e.type === 'run.step' && e.runId === runId && e.ok), 'and that the step succeeded');
    const th = await client.call('thread', { streamId });
    A.ok(th.data.some(t => t.role === 'user' && /remote shell proof/.test(t.content)), 'the conversation holds the phone message');
    A.ok(th.data.some(t => t.role === 'assistant' && /REMOTE_SHELL_DONE/.test(t.content)), 'and the agent reply');
    const files = await client.call('fetch', { agentId: 'forge', path: 'remote-proof.txt' });
    A.eq(files.ok, true, 'the phone can read the file the run wrote: ' + JSON.stringify(files).slice(0, 200));
    A.ok(files.ok && /SHELL_OK_remote/.test(Buffer.from(files.data.data, 'base64').toString('utf8')), 'with its real contents');
    A.eq((await client.call('fetch', { agentId: 'forge', path: '../../.secrets/remote.json' })).ok, false, 'the file jail holds from a phone');

    // 5. detached: the phone drops mid-run; the run still finishes
    const slow = await client.call('send', { agentId: 'forge', text: 'slow reply', streamId });
    A.eq(slow.ok, true, 'slow task accepted');
    await waitUntil(() => !!llm.gate.held, 20000, 'model holding the slow reply');
    client.close();
    await Promise.race([listening, sleep(1000)]);
    await waitUntil(async () => !(await fx.json('GET', '/api/remote')).body.connected.some(c => c.live), 5000, 'phone stream detached');
    llm.gate.release();
    const client2 = Phone.connect({ base: lan, deviceId: paired.deviceId, stationPub: pr.body.stationPub, key });
    await waitUntil(async () => { const t = await client2.call('thread', { streamId }); return t.data.some(x => x.role === 'assistant' && /SLOW_DONE/.test(x.content)); }, 20000, 'slow reply after reconnect');
    A.ok(true, 'a run started from the phone finished while the phone was gone, and the reply was there on reconnect');
    client = client2;

    // 6. a DESKTOP run's approval, answered from the phone
    const deskReq = fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ key: 'sk-or-v1-remote-fake', model: 'test/model', agentId: 'forge', isTask: true, placed: [{ objectType: 'computer' }, { objectType: 'workbench' }], messages: [{ role: 'user', content: 'desk shell proof' }] }) });
    const deskDone = deskReq.then(async (r) => {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { deskEvents.push(JSON.parse(line)); } catch (_) {} } }
    });
    let deskAp = null;
    await waitUntil(async () => { const l = await client.call('approvals'); deskAp = l.data.find(x => x.surface === 'desk'); return !!deskAp; }, 20000, 'desk approval visible on the phone');
    A.eq(deskAp.agentId, 'forge', 'the desk approval names its agent');
    const deskOnce = await client.call('decide', { runId: deskAp.runId, promptId: deskAp.promptId, decision: 'once' });
    A.eq(deskOnce.ok, true, 'the phone approves a desktop run');
    await deskDone;
    A.ok(deskEvents.some(e => e.name === 'permission.response' && e.payload.promptId === deskAp.promptId && e.payload.decision === 'once'), 'the desk stream is told the prompt was answered');
    A.ok(deskEvents.some(e => e.name === 'agent.token' && /DESK_SHELL_DONE|SHELL_DONE/.test(JSON.stringify(e.payload))) || deskEvents.some(e => /DESK_SHELL_DONE/.test(JSON.stringify(e))), 'the desktop run finished after the phone approved it');
    A.eq((await client.call('approvals')).data.length, 0, 'nothing left waiting');

    // 9. session parity with the desk
    const saved = await fx.json('POST', '/api/save', { schema: 'starnet.save', version: 6, _saveRevision: persistedDispatch.body.revision, agent: { id: 'agent', name: 'ULTRON', createdAt: 1 },
      workstreams: [staleDispatchSession,
        { id: 'ws_desk_launch', title: 'Launch plan', agentId: 'forge', conversationMode: 'direct', lane: 'active', kind: 'chat', archived: false, lastActiveAt: Date.now() - 5000,
          history: deskHistory },
        { id: 'ws_desk_blank', title: null, agentId: 'forge', conversationMode: 'direct', lane: 'active', kind: 'chat', archived: false, lastActiveAt: Date.now() - 9000, history: [] },
        { id: 'ws_desk_archived', title: 'Old', agentId: 'forge', conversationMode: 'direct', archived: true, lastActiveAt: Date.now() - 100, history: [{ role: 'user', content: 'x' }] }
      ] });
    A.ok(saved.status === 200 && saved.body && saved.body.ok !== false, 'a desk save with sessions is stored: ' + JSON.stringify(saved.body).slice(0, 160));
    const tl = await client.call('threads', { limit: 50 });
    if (!tl.ok) console.log('desk cache proof diagnostic', JSON.stringify({ seed: deskHistory, proof: await fx.json('POST', '/api/turn-identity/retractions', { streamId: 'ws_desk_launch', rowIds: deskHistory.map(row => row.rowId) }), transcript: await fx.json('GET', '/api/transcript?agent=forge&stream=ws_desk_launch&limit=50') }));
    A.eq(tl.ok, true, 'canonical desk cache identities are proved by the real host: ' + JSON.stringify(tl.error || ''));
    const deskRow = tl.data.find(t => t.streamId === 'ws_desk_launch');
    A.ok(!!deskRow, 'the desk session is in the phone list');
    A.eq(deskRow && deskRow.title, 'Launch plan', 'with the desk title');
    A.eq(deskRow && deskRow.turns, 2, 'and its turn count');
    A.ok(!tl.data.some(t => t.streamId === 'ws_desk_blank'), 'an untouched blank desk session is not listed');
    A.ok(!tl.data.some(t => t.streamId === 'ws_desk_archived'), 'an archived desk session is not listed');
    A.ok(tl.data.some(t => t.streamId === streamId && t.source === 'phone'), 'a phone-started conversation is listed too');
    const dh = await client.call('thread', { streamId: 'ws_desk_launch' });
    A.eq(dh.data.map(t => t.role), ['user', 'assistant'], 'the phone reads the desk session history');
    const cont = await client.call('send', { agentId: 'forge', text: 'what is the code word', streamId: 'ws_desk_launch' });
    A.eq(cont.ok && cont.data.streamId, 'ws_desk_launch', 'the phone continues the desk session under its own id');
    // (this client has no event stream attached: read the conversation until the reply is there)
    let dh2 = null;
    await waitUntil(async () => { dh2 = await client.call('thread', { streamId: 'ws_desk_launch' }); return dh2.data.some(t => t.role === 'assistant' && /CODEWORD|NO_CONTEXT/.test(t.content)); }, 30000, 'continued desk session reply');
    A.ok(dh2.data.some(t => t.role === 'assistant' && /CODEWORD_HELIX_SEEN/.test(t.content)), 'the run had the desk session history: ' + JSON.stringify(dh2.data.slice(-2)).slice(0, 200));
    A.eq(dh2.data.filter(t => /remember the code word/.test(t.content)).length, 1, 'earlier turns are not duplicated');
    A.eq(dh2.data.filter(t => t.role === 'user' && /what is the code word/.test(t.content)).length, 1, 'the phone turn is there once');
    const recent = await fx.json('GET', '/api/remote/recent');
    A.ok(recent.body.runs.some(r => r.runId === cont.data.runId && r.streamId === 'ws_desk_launch' && r.live === false && r.endedAt), 'the desk can see the phone run and its session');
    A.ok(recent.body.runs.some(r => r.streamId === streamId && /remote shell proof|slow reply/.test(r.title)), 'and the phone-started conversation, titled with what was said');
    const tr = await fx.json('GET', '/api/transcript?agent=forge&stream=ws_desk_launch&limit=50');
    A.ok((tr.body.turns || []).some(t => t.role === 'assistant' && /CODEWORD_HELIX_SEEN/.test(String(t.content))), 'the turn is in the station transcript under the desk session id (the desk merges it on open)');

    // 10. the station picture
    const want0 = await fx.json('GET', '/api/remote/view');
    A.eq([want0.body.enabled, want0.body.at], [true, null], 'the desk is told Remote is on and that the station has no picture yet');
    const noPic = await client.call('view', {});
    A.ok(noPic.ok && noPic.data.none === true, 'a phone asking before any picture exists is told there is none');
    const want1 = await fx.json('GET', '/api/remote/view');
    A.eq(want1.body.want, true, 'and its asking is what makes the desk start drawing');
    const pic = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(3000, 9)]);
    const bad = await fx.json('POST', '/api/remote/view', { w: 640, h: 480, data: Buffer.from('not a picture').toString('base64') });
    A.eq(bad.status, 400, 'the station refuses something that is not a picture');
    const putPic = await fx.json('POST', '/api/remote/view', { w: 640, h: 480, bodies: [{ agentId: 'forge', x: 320, y: 200 }], data: pic.toString('base64') });
    A.ok(putPic.status === 200 && putPic.body.ok, 'the desk page hands over a still: ' + JSON.stringify(putPic.body).slice(0, 120));
    const got = await client.call('view', {});
    A.eq([got.data.w, got.data.h, got.data.mime, got.data.eof], [640, 480, 'image/webp', true], 'the phone reads it over the sealed channel');
    A.ok(Buffer.from(got.data.data, 'base64').equals(pic), 'byte for byte');
    A.eq(got.data.bodies, [{ agentId: 'forge', x: 320, y: 200 }], 'with where the crew stood');
    A.ok(got.data.now >= got.data.at, 'and the clocks to work out its age');
    const again = await client.call('view', { have: got.data.at });
    A.eq(again.data.same, true, 'an unchanged picture is not sent twice');
    const face = await client.call('portrait', { agentId: 'forge' });
    A.ok(face.ok && face.data.mime === 'image/png' && Buffer.from(face.data.data, 'base64').toString('latin1', 1, 4) === 'PNG', 'the portrait of an agent is a real sprite from the shipped art');
    const crewPut = await fx.json('POST', '/api/remote/view/crew', { bodies: [{ agentId: 'forge', key: 'approved_robot.walk.south', idx: 1, x: 100, y: 50, w: 6, h: 18, walking: true }] });
    A.ok(crewPut.status === 200 && crewPut.body.ok, 'the desk page streams where the crew are');
    const withCrew = await client.call('view', {});
    A.eq(withCrew.data.crew && withCrew.data.crew.bodies.map(b => b.key), ['approved_robot.walk.south'], 'a phone opening the picture gets the crew positions with it');
    const trk = await client.call('sprite', { key: 'approved_robot.walk.south' });
    A.ok(trk.ok && trk.data.frames.length >= 4, 'and the drawings to show them walking');
    const act = await client.call('activity', { limit: 10 });
    A.ok(act.ok && Array.isArray(act.data.live) && act.data.done.some(r => r.streamId === 'ws_desk_launch' && r.state === 'done'), 'ACTIVITY lists the finished desk-session task: ' + JSON.stringify(act.data.done.map(r => r.title)).slice(0, 160));
    const stl = await client.call('status');
    A.ok(stl.data.agents.every(a => typeof a.skin === 'string'), 'status says how each agent looks');

    // 11. notifications
    const pk = await client.call('pushKey');
    A.ok(pk.ok && /^[A-Za-z0-9_-]{80,90}$/.test(pk.data.key) && pk.data.on === false, 'the phone reads the station push key; not subscribed yet');
    const nodeCrypto = require('crypto');
    const ecdh = nodeCrypto.createECDH('prime256v1'); ecdh.generateKeys();
    const bsub = { endpoint: 'https://127.0.0.1:9/push/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: nodeCrypto.randomBytes(16).toString('base64url') } };
    A.eq((await client.call('pushOn', { endpoint: 'http://127.0.0.1:9/x', keys: bsub.keys })).ok, false, 'a plain-http push address is refused');
    A.eq((await client.call('pushOn', { endpoint: 'https://evil.example/collect', keys: bsub.keys })).ok, false, 'a push address that is not a real push service is refused');
    A.eq((await client.call('pushOn', bsub)).ok, true, 'the phone subscribes');
    A.eq((await client.call('pushKey')).data.on, true, 'and the station says so');
    const tp = await client.call('pushTest');
    A.eq(tp.ok, false, 'a push that cannot be delivered is reported as not sent: ' + JSON.stringify(tp).slice(0, 120));
    A.eq((await client.call('pushOff')).ok, true, 'the phone unsubscribes');
    A.eq((await client.call('pushKey')).data.on, false, 'and it is off');

    // 7. the LAN door is not the API; revoke cuts a phone off
    A.eq((await fetch(lan + '/api/remote')).status, 404, 'the LAN door serves no /api route');
    A.eq((await fetch(lan + '/')).status, 404, 'nor the station page');

    // a second phone, to carry through the restart
    const pr2 = await fx.json('POST', '/api/remote/pair', { name: 'Tablet' });
    const key2 = await Phone.makeDeviceKey();
    const paired2 = await Phone.pair({ base: lan, pairingId: pr2.body.pairingId, code: pr2.body.code, name: 'Tablet', key: key2 });

    const rv = await fx.json('POST', '/api/remote/revoke', { deviceId: paired.deviceId });
    A.eq(rv.status, 200, 'revoke');
    let cut = false; try { await client.call('status'); } catch (_) { cut = true; }
    A.ok(cut, 'the revoked phone is cut off at once');
    let hello = false; try { await Phone.connect({ base: lan, deviceId: paired.deviceId, stationPub: pr.body.stationPub, key }).call('status'); } catch (e) { hello = /unknown device/.test(e.message); }
    A.ok(hello, 'and cannot say hello again');

    // 8. restart: switch, station key and paired phone persist; the door reopens
    const raw = fs.readFileSync(path.join(fx.workspace, '.secrets', 'remote.json'), 'utf8');
    A.ok(raw.indexOf(key2.publicRaw) >= 0 && raw.indexOf(key.publicRaw) < 0, 'on disk: the kept phone, not the revoked one');
    await fx.restart();
    const after = await fx.json('GET', '/api/remote');
    A.eq(after.body.enabled, true, 'Remote is still on after a restart');
    A.eq(after.body.listening, true, 'the LAN door reopened on boot');
    A.eq(after.body.devices.map(d => d.name), ['Tablet'], 'the paired phone survived the restart');
    const c3 = Phone.connect({ base: lan, deviceId: paired2.deviceId, stationPub: pr2.body.stationPub, key: key2 });
    A.eq((await c3.call('status')).ok, true, 'the phone reconnects after a restart with the same station key');

    await checkDispatchPhone(c3, 'after restart', 'Continue the accepted phone result');
    const restartText = 'Continue the accepted phone result after restart';
    const restartFollow = await c3.call('send', { agentId: 'forge', streamId: 'dispatch_phone', text: restartText });
    A.eq(restartFollow.ok, true, 'phone resumes the saved dispatch session after restart');
    await waitUntil(async () => (await fx.json('GET', '/api/remote/recent')).body.runs.some(r => r.runId === restartFollow.data.runId && r.live === false), 20000, 'post-restart dispatch continuation');
    const restartedContext = llm.requests.find(r => (r.messages || []).some(m => m.role === 'user' && userWords(m) === restartText));
    A.eq(restartedContext && restartedContext.messages.filter(m => m.role === 'assistant' && m.content === accepted).length, 1, 'post-restart provider receives accepted answer once');
    A.ok(!/RAW_CONTRACT|RAW_INVALID|RAW_REJECTED|INTERNAL_REPAIR|LATE_INTERNAL/.test(JSON.stringify(restartedContext && restartedContext.messages)), 'post-restart provider receives no rejected saved answer');
    console.log('phone saved-history follow-up proof: ' + JSON.stringify({ phase: 'after restart', acceptedCount: restartedContext.messages.filter(m => m.content === accepted).length, savedRejectedVisible: /RAW_REJECTED/.test(JSON.stringify(restartedContext.messages)) }));

    // 12. E-STOP reaches a phone run: while it works it is on the station's run list (a reconnect keeps the agent
    //     working on the floor), and the halt aborts it and counts it
    const held = await c3.call('send', { agentId: 'forge', text: 'slow reply' });
    A.eq(held.ok, true, 'a held phone task started');
    await waitUntil(() => !!llm.gate.held, 20000, 'model holding the phone task');
    const snap = await fx.json('GET', '/api/state/snapshot');
    A.ok(snap.body.runs.some(r => r.runId === held.data.runId && r.agentId === 'forge' && r.source === 'remote'), 'the phone run is in the station snapshot: ' + JSON.stringify(snap.body.runs).slice(0, 200));
    const halt = await fx.json('POST', '/api/halt', {});
    A.ok(halt.status === 200 && halt.body.halted >= 1, 'E-STOP counts the phone run: ' + JSON.stringify(halt.body).slice(0, 160));
    await waitUntil(async () => (await fx.json('GET', '/api/remote/recent')).body.runs.some(r => r.runId === held.data.runId && r.live === false), 10000, 'phone run ended by E-STOP');
    A.ok(!(await fx.json('GET', '/api/state/snapshot')).body.runs.some(r => r.runId === held.data.runId), 'and it is off the run list');
    llm.gate.release();

    const offAgain = await fx.json('POST', '/api/remote/enable', { on: false });
    A.eq(offAgain.body.listening, false, 'switching off closes the door');
    let shut = false; try { await c3.call('status'); } catch (_) { shut = true; }
    A.ok(shut, 'and ends live phone sessions');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + '\n--- desk events ---\n' + deskEvents.map(x => x.name + ' ' + JSON.stringify(x.payload).slice(0, 200)).join('\n') + '\n--- sidecar output tail ---\n' + String(fx.output ? fx.output() : '').slice(-3000));
  } finally {
    try { client && client.close(); } catch (_) {}
    await fx.dispose();
    llm.server.close();
  }
  A.report('remote e2e');
})();
