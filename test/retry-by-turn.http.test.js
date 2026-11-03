'use strict';
/* node test/retry-by-turn.http.test.js — a retry or resend of a turn reuses that turn's ONE directive, found by its turnId
   (turn identity, commit 3; closes b30c1c8e).

   Real sidecar + real POST /api/run against a local mock provider (no money spent). The page names every turn with a turnId
   and posts it back on a retry (retryOf) with the row's time pair (turnAt + clientNow); the station finds the directive
   by turnId (transcriptstore.findTurn) and reuses it when the words match key-blind, else it answers under its own id
   ('r' + runId) and nothing is refused (Q21: re-key). Legs:
     1. PROOF b30c1c8e: a pasted key, saved by keys.save, then a retry of that turn: ONE directive row (trunk: 2 user rows,
        because the old check compared the stored, key-named text with the request's redacted text byte for byte)
     2. a repeated retry plus a restart: still one row; the echo names the same directive rowId
     3. the same turnId with different words: a second directive under 'r' + runId, the first one stays
     4. the same turnId from another agent: re-keyed at the early read, the turn keeps one directive
     5. an internal run that supplies a turnId echoes its own 'r' + runId and writes nothing under that turnId
     6. controls: the same turnId in another stream writes that stream's own row; equal words under two turnIds are two turns
     7. skewed clients (A2-ID-04-R), on streams seeded on disk before a restart: (a) desk +24 h and +15 min clocks over a
        6000-row window: re-keyed, turn.reuse.horizon counted, one directive; (b) the same through the real remote gateway
        and phone host (bridged in-process to this station's /api/run); (c) two phone sends of one fresh turn: one directive;
        (d) control: a fresh turn with the client 24 h ahead is absent and keeps its id; (e) control: turnAt without
        clientNow is unknown, re-keyed; (f) control recording the Q38 residual: a station clock stepped 60 min forward lets
        a resend file a second directive under the same turnId
     8. a degraded boot (the transcript root replaced by a plain file): the resend is admitted under 'r' + runId, the
        provider is called, and after the root is back the turn still holds one directive */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const TurnKinds = require('../frontend/app/turnkinds.js');

const PASTE = '7d1e9b3c5a2f4e6d8b0a1c3e5f7a9b2d4c6e8f01';
const KEY_WORDS = 'here is my saleshandy api key ' + PASTE + ' - send my email campaign';
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
const mint = () => TurnKinds.mintTurnId(() => crypto.randomInt(0, 0x100000000) / 0x100000000);   // a desk-shaped turnId

const seen = [];
function sse(res, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish || 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const toolNames = body => (Array.isArray(body.tools) ? body.tools : []).map(t => t && t.function && t.function.name).filter(Boolean);
const mock = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    seen.push(body);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
    const ask = lastUser >= 0 ? userWords(msgs[lastUser]) : '';
    const results = msgs.slice(lastUser + 1).filter(m => m && m.role === 'tool').map(m => m.tool_call_id);
    // a session run holds keys.save until its Task Brief is settled (TaskBriefPolicy.canMutate): settle it, then save
    if (/saleshandy/i.test(ask) && toolNames(body).indexOf('keys_save') >= 0 && results.indexOf('ks_1') < 0) {
      if (toolNames(body).indexOf('brief_proceed') >= 0 && results.indexOf('bp_1') < 0) {
        return sse(res, { tool_calls: [{ index: 0, id: 'bp_1', type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify({ objective: 'send the email campaign', deliverable: 'the campaign sent', assumptions: ['the pasted key is for Saleshandy'] }) } }] }, 'tool_calls');
      }
      return sse(res, { tool_calls: [{ index: 0, id: 'ks_1', type: 'function', function: { name: 'keys_save', arguments: JSON.stringify({ service: 'Saleshandy' }) } }] }, 'tool_calls');
    }
    return sse(res, { content: 'Done.' });
  });
});

let fx;
const parse = text => String(text || '').split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
async function run(streamId, words, extra) {
  const before = seen.length;
  const body = Object.assign({ model: 'test/model', provider: 'openrouter', key: 'sk-or-v1-retry-turn-fixture', agentId: 'agent', isTask: true, placed: ['dish'], streamId, messages: [{ role: 'user', content: words }] }, extra || {});
  const r = await fx.json('POST', '/api/run', body);
  const events = typeof r.body === 'string' ? parse(r.body) : [];
  const start = (events.find(e => e.name === 'agent.run.start' && e.payload && !e.payload.parentRunId) || {}).payload || {};
  const end = events.filter(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === start.runId).pop();
  return { status: r.status, events, start, runId: start.runId || '', end: end && end.payload, upstream: seen.length - before };
}
async function users(stream) { const r = await fx.json('GET', '/api/transcript?stream=' + stream); return (r.body && r.body.turns || []).filter(row => row.role === 'user'); }
// every row on disk (the window GET /api/transcript serves stops at 500; the skewed streams hold 6000)
function diskRows(stream) {
  const root = path.join(fx.workspace, 'transcript-history-v2');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root).filter(f => /^segment-\d{6}\.jsonl$/.test(f)); } catch (_) { return out; }
  for (const f of names) for (const line of fs.readFileSync(path.join(root, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row = null; try { row = JSON.parse(line); } catch (_) { continue; }
    if (row && row.streamId === stream) out.push(row);
  }
  return out;
}
const directives = (stream, turnId) => diskRows(stream).filter(r => r.role === 'user' && r.directive === true && r.turnId === turnId);
const ofTurn = (stream, turnId) => diskRows(stream).filter(r => r.turnId === turnId);
function tagCount(tag) {
  let n = 0;
  const re = /\[failopen\] ([^\s]+) \(x(\d+)\)/g;
  let m; while ((m = re.exec(fx.output()))) if (m[1] === tag) n = Math.max(n, Number(m[2]));
  return n;
}

// seed a stream on disk while the station is stopped: T's directive (and its run's reply) at `at`, then `count` rows of the
// same stream spread from `from` to `to`, none of them T's
function seedStream(stream, T, words, at, count, from, to) {
  const quick = Object.create(fs);
  quick.fsyncSync = () => {};   // thousands of rows: the write path is real, only the disk flush is skipped
  const io = makeSegmentedTranscriptIo({ fs: quick, path, root: path.join(fx.workspace, 'transcript-history-v2') });
  const runId = 'seed-' + stream;
  io.appendDurable({ streamId: stream, agentId: 'agent', role: 'user', content: words, ts: at, turnId: T, directive: true, sourceRunId: runId });
  io.appendDurable({ streamId: stream, agentId: 'agent', role: 'assistant', content: 'Seeded answer.', ts: at + 1000, turnId: T, sourceRunId: runId });
  for (let k = 0; k < count; k++) {
    io.appendDurable({ streamId: stream, agentId: 'agent', role: k % 2 ? 'assistant' : 'user', content: 'filler ' + k, ts: Math.round(from + (to - from) * k / (count - 1)), sourceRunId: 'filler-' + Math.floor(k / 2) });
  }
  io.close();
}

(async () => {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const orBase = 'http://127.0.0.1:' + mock.address().port + '/api/v1';
  fx = SidecarFixture.create({ prefix: 'retry-by-turn-', timeoutMs: 30000, env: {
    SKYNET_OPENROUTER_BASE: orBase, STARNET_OPENROUTER_BASE: orBase,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-retry-turn-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-retry-turn-fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0', SKYNET_FULL_ACCESS: '1',
    SKYNET_EDGE_TTS: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0'
  } });
  try {
    await fx.start();
    A.eq((await fx.json('POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Hero', model: 'test/model', provider: 'openrouter' }, { agentId: 'other', name: 'Ivy', model: 'test/model', provider: 'openrouter' }] })).status, 200, 'fixture: roster saved');

    // ---- 1. PROOF b30c1c8e: a pasted key saved by keys.save, then a retry of that turn ----
    const S = 'turn-main', T1 = mint();
    const t0 = Date.now();
    const r1 = await run(S, KEY_WORDS, { turnId: T1, turnAt: t0, clientNow: t0 });
    A.eq(r1.status, 200, 'fixture: the paste run streams');
    const saved = r1.events.find(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'ks_1');
    A.ok(saved && saved.payload.ok, 'fixture: keys.save saved the pasted key');
    const r2 = await run(S, KEY_WORDS, { turnId: T1, retryOf: T1, retryUserRunId: r1.runId, turnAt: t0, clientNow: Date.now() });
    A.eq(r2.status, 200, 'fixture: the retry streams');
    A.ok(r2.upstream >= 1, 'fixture: the retry reached the provider');
    A.eq((await users(S)).length, 1, 'one directive row for T (a retry after keys.save reuses the turn\'s directive)');
    A.eq(directives(S, T1).length, 1, 'the one directive row is T\'s');
    A.eq([r1.start.turnId, r2.start.turnId], [T1, T1], 'both run.starts echo T');
    // (the paste run's own start names no row: its directive is held until the key is saved, so it is written after run.start)
    const row1 = directives(S, T1)[0] || {};
    A.ok(Number.isSafeInteger(row1.rowId) && r2.start.directiveRowId === row1.rowId, 'the retry\'s run.start names that directive row (' + row1.rowId + ' / ' + r2.start.directiveRowId + ')');
    A.ok(diskRows(S).every(x => String(x.content || '').indexOf(PASTE) < 0), 'no row of the stream holds the pasted key');
    // the page's scrubbed copy of the same words (COMMS swapped the paste for its KEYS name) is the same turn too
    const scrubbed = (await fx.json('POST', '/api/servicekeys/scrub', { texts: [KEY_WORDS] })).body.texts[0];
    A.ok(scrubbed !== KEY_WORDS && scrubbed.indexOf(PASTE) < 0, 'fixture: the page scrub names the saved key');
    const r2b = await run(S, scrubbed, { turnId: T1, retryOf: T1, retryUserRunId: r1.runId, turnAt: t0, clientNow: Date.now() });
    A.eq([r2b.start.turnId, (await users(S)).length], [T1, 1], 'a retry with the scrubbed words reuses the same directive');

    // ---- 2. a repeated retry plus a restart ----
    await fx.restart();
    const r3 = await run(S, KEY_WORDS, { turnId: T1, retryOf: T1, retryUserRunId: r1.runId, turnAt: t0, clientNow: Date.now(), turnRowId: row1.rowId });
    A.eq([r3.status, r3.start.turnId, r3.start.directiveRowId], [200, T1, row1.rowId], 'after a restart the retry still names T and its directive row');
    A.eq((await users(S)).length, 1, 'a repeated retry plus a restart keeps one user row');
    A.eq(directives(S, T1).length, 1, 'and one directive under T');

    // ---- 3. the same turnId, different words ----
    const r4 = await run(S, 'DIFFERENT WORDS under an old turn id', { turnId: T1, retryOf: T1, turnAt: t0, clientNow: Date.now() });
    const own4 = TurnKinds.runTurnId(r4.runId);
    A.eq(r4.start.turnId, own4, 'different words under T are answered as a new turn: run.start echoes \'r\' + runId');
    A.eq(directives(S, own4).length, 1, 'a second directive is filed under \'r\' + runId');
    A.eq(directives(S, T1).length, 1, 'T keeps its one directive (not retracted, not doubled)');
    A.eq((await users(S)).length, 2, 'the stream holds both turns');
    A.ok(tagCount('turn.reuse.conflict.input') >= 1, 'the input conflict is counted (turn.reuse.conflict.input)');

    // ---- 4. the same turnId from another agent ----
    const S4 = 'turn-agents', T4 = mint();
    const r5 = await run(S4, 'list the open invoices', { turnId: T4, turnAt: Date.now(), clientNow: Date.now() });
    A.eq(r5.start.turnId, T4, 'fixture: a fresh turn keeps its id');
    const r6 = await run(S4, 'list the open invoices', { agentId: 'other', turnId: T4, retryOf: T4, turnAt: Date.now(), clientNow: Date.now() });
    const own6 = TurnKinds.runTurnId(r6.runId);
    A.eq(r6.start.turnId, own6, 'another agent naming T is re-keyed at the early read');
    A.eq([directives(S4, T4).length, directives(S4, own6).length], [1, 1], 'T keeps one directive; the other agent\'s is its own');
    A.eq((directives(S4, own6)[0] || {}).agentId, 'other', 'the re-keyed directive is the other agent\'s');
    A.ok(tagCount('turn.reuse.conflict.agent') >= 1, 'the agent conflict is counted (turn.reuse.conflict.agent)');

    // ---- 5. an internal run that supplies a turnId ----
    const T5 = mint();
    const r7 = await run(S4, 'internal self-talk words', { internal: true, turnId: T5, turnAt: Date.now(), clientNow: Date.now() });
    A.eq([r7.status, r7.start.turnId], [200, TurnKinds.runTurnId(r7.runId)], 'an internal run echoes its own \'r\' + runId');
    A.eq(ofTurn(S4, T5).length, 0, 'and writes nothing under the turnId it supplied');
    A.ok(tagCount('turn.id-ignored') >= 1, 'the ignored id is counted (turn.id-ignored)');

    // ---- 6. controls ----
    const r8 = await run('turn-elsewhere', KEY_WORDS.replace(PASTE, 'no key here'), { turnId: T1, retryOf: T1, turnAt: t0, clientNow: Date.now() });
    A.eq([r8.start.turnId, directives('turn-elsewhere', T1).length, (await users('turn-elsewhere')).length], [T1, 1, 1], 'control: T named in another stream files that stream\'s own row');
    const Ta = mint(), Tb = mint();
    await run('turn-twins', 'same words twice', { turnId: Ta, turnAt: Date.now(), clientNow: Date.now() });
    await run('turn-twins', 'same words twice', { turnId: Tb, turnAt: Date.now(), clientNow: Date.now() });
    A.eq((await users('turn-twins')).length, 2, 'control: equal words under two turnIds are two turns');

    // ---- 7. skewed clients over seeded 6000-row windows ----
    await fx.stop();
    const now0 = Date.now();
    const SK = 'turn-skew', TK = mint(), SKW = 'SKEW: summarize the quarterly numbers';
    seedStream(SK, TK, SKW, now0 - 30 * MINUTE, 6000, now0 - 29 * MINUTE, now0 - 11 * MINUTE);
    const SF = 'turn-step', TF = mint(), SFW = 'STEP: draft the board letter';
    seedStream(SF, TF, SFW, now0 - 90 * MINUTE, 6000, now0 - 89 * MINUTE, now0 - 71 * MINUTE);
    await fx.start();   // the restart also stands in for the lost in-process state
    A.eq([directives(SK, TK).length, diskRows(SK).length], [1, 6002], 'fixture: the skewed stream holds T\'s directive under 6000 newer rows');
    // (a) desk, client clock +24 h, 30 min elapsed
    let n = Date.now();
    const a1 = await run(SK, SKW, { turnId: TK, retryOf: TK, turnAt: (n - 30 * MINUTE) + 24 * HOUR, clientNow: n + 24 * HOUR });
    A.eq(a1.start.turnId, TurnKinds.runTurnId(a1.runId), '(a) +24 h client: the station cannot place T in its 5000-row read and re-keys (\'r\' + runId)');
    A.eq(directives(SK, TK).length, 1, '(a) T still holds exactly one directive');
    A.eq(tagCount('turn.reuse.horizon'), 1, '(a) turn.reuse.horizon = 1');
    n = Date.now();
    const a2 = await run(SK, SKW, { turnId: TK, retryOf: TK, turnAt: (n - 30 * MINUTE) + 15 * MINUTE, clientNow: n + 15 * MINUTE });
    A.eq([a2.start.turnId, directives(SK, TK).length, tagCount('turn.reuse.horizon')], [TurnKinds.runTurnId(a2.runId), 1, 2], '(a) +15 min client: the same');
    // (b) + (c) the phone: the real gateway and the real phone host, bridged to this station's /api/run
    const { makeGateway } = require('../sidecar/remote/gateway.js');
    const { makeRemoteHost } = require('../sidecar/remote/host.js');
    const bridged = [];
    const host = makeRemoteHost({
      now: () => Date.now(), newId: () => crypto.randomUUID(), broadcast: () => {},
      roster: () => [{ agentId: 'agent', name: 'Hero' }],
      credentials: () => ({ ok: true, key: 'sk-or-v1-retry-turn-fixture', model: 'test/model', provider: 'openrouter', system: '' }),
      transcript: require('../sidecar/transcriptstore.js').makeTranscriptStore({ io: require('../sidecar/transcript-history.js').makeMemoryTranscriptIo() }),
      classify: () => true, askConsent: async () => 'deny', phoneAsksFirst: () => false,
      // the host's runOnce, carried to the station's run host: the host's station-clock turnAt rides as a pair with this clock
      runOnce: o => { const p = run(o.streamId, o.messages[o.messages.length - 1].content, { turnId: o.turnId, turnAt: o.turnAt, clientNow: o.turnAt === undefined ? undefined : Date.now(), turnRowId: o.turnRowId }); bridged.push(p); return p; }
    });
    const gw = makeGateway({ host, approvals: { size: () => 0, list: () => [] }, now: () => Date.now() });
    const phone = async args => { const before = bridged.length; const r = await gw.call({ verb: 'send', args }, { deviceId: 'dev-1' }); for (let i = 0; i < 400 && bridged.length === before; i++) await new Promise(res => setTimeout(res, 5)); return { reply: r, run: await bridged[bridged.length - 1] }; };
    n = Date.now();
    const b1 = await phone({ agentId: 'agent', text: SKW, streamId: SK, turnId: TK, turnAt: (n - 30 * MINUTE) + 24 * HOUR, clientNow: n + 24 * HOUR });
    A.ok(b1.reply.ok, '(b) fixture: the gateway accepted the send: ' + JSON.stringify(b1.reply));
    A.eq([b1.run.start.turnId, directives(SK, TK).length, tagCount('turn.reuse.horizon')], [TurnKinds.runTurnId(b1.run.runId), 1, 3], '(b) phone through the gateway: re-keyed, T keeps one directive, horizon counted');
    const SC = 'turn-phone', TC = mint(), p0 = Date.now() + 24 * HOUR;
    const c1 = await phone({ agentId: 'agent', text: 'PHONE: book the venue', streamId: SC, turnId: TC, turnAt: p0, clientNow: p0 });
    const c2 = await phone({ agentId: 'agent', text: 'PHONE: book the venue', streamId: SC, turnId: TC, turnAt: p0, clientNow: p0 + 5000 });
    A.eq([c1.run.start.turnId, c2.run.start.turnId], [TC, TC], '(c) two phone sends of one turn both answer it');
    A.eq(directives(SC, TC).length, 1, '(c) phone idempotency: two gateway sends of a fresh turn reuse ONE directive');
    A.ok(Number.isSafeInteger(c1.run.start.directiveRowId) && c2.run.start.directiveRowId === c1.run.start.directiveRowId, '(c) the resend names the first send\'s directive row');
    // (d) control: a fresh turn, client 24 h ahead, turnAt = clientNow
    const TD = mint(); n = Date.now();
    const d1 = await run(SK, 'SKEW: a brand new question', { turnId: TD, turnAt: n + 24 * HOUR, clientNow: n + 24 * HOUR });
    A.eq([d1.start.turnId, directives(SK, TD).length, tagCount('turn.reuse.horizon')], [TD, 1, 3], '(d) control: a fresh turn is absent and keeps its id (no horizon count)');
    // (e) control: turnAt without clientNow
    const e1 = await run(SK, SKW, { turnId: TK, retryOf: TK, turnAt: Date.now() - 30 * MINUTE });
    A.eq([e1.start.turnId, directives(SK, TK).length, tagCount('turn.reuse.horizon')], [TurnKinds.runTurnId(e1.runId), 1, 4], '(e) control: a turnAt without clientNow is unknown, re-keyed, T untouched');
    // (f) control recording the Q38 residual: the station clock stepped 60 min forward after T's rows
    n = Date.now();
    const f1 = await run(SF, SFW, { turnId: TF, retryOf: TF, turnAt: n - 30 * MINUTE, clientNow: n });
    A.eq([f1.start.turnId, directives(SF, TF).length], [TF, 2], '(f) control (Q38 residual, shipped): a forward clock step lets rung 4 answer absent; T gets a second directive');

    // ---- 8. a degraded boot ----
    await fx.stop();
    const root = path.join(fx.workspace, 'transcript-history-v2');
    fs.renameSync(root, root + '.held');
    fs.writeFileSync(root, 'not a directory', 'utf8');
    const upBefore = seen.length;
    let g1 = null;
    try {
      await fx.start();
      g1 = await run(S, KEY_WORDS, { turnId: T1, retryOf: T1, retryUserRunId: r1.runId, turnAt: t0, clientNow: Date.now() });
    } catch (e) { A.ok(false, '8: the degraded boot ran: ' + ((e && e.message) || e).slice(0, 400)); }
    await fx.stop();
    fs.rmSync(root, { force: true });   // the plain file (never a directory, never a junction)
    fs.renameSync(root + '.held', root);
    if (g1) {
      A.eq([g1.status, g1.start.turnId], [200, TurnKinds.runTurnId(g1.runId)], '8: on a degraded boot the resend is admitted under \'r\' + runId');
      A.ok(seen.length > upBefore, '8: zero upstream calls refused (the provider was called)');
    }
    await fx.start();
    A.eq(directives(S, T1).length, 1, '8: after the root is back T still holds one directive');
    console.log('retry-by-turn: keys.save retry, restart, input and agent conflicts, internal, controls, skewed clients, phone and degraded boot ran');
  } catch (e) {
    A.ok(false, 'threw: ' + ((e && e.stack) || e));
  } finally {
    try { await fx.dispose(); } catch (_) {}
    mock.close();
  }
  A.report('retry-by-turn.http');
})();
