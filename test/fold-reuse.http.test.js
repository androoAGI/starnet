'use strict';
/* node test/fold-reuse.http.test.js — a long chat's fold is paid for ONCE, and its summary is reused byte for byte
   (context-budget-and-fold, step 2). Real sidecar + real /api/run + a local provider with a 32,000-token window.

   THE BURN (probed): the page re-sends the same long chat on every send, a fold lives only in that run's messages, so every
   send past the fold line summarized the same range again: 14 paid summarizer calls and 14 different note texts in the
   14 sends after the line. Now a paid fold's note is written to the stream's summary file (summary-ledger.js) with the
   canonical rows it stands for, and the next run that proves it still true uses it instead of folding.

   doneMeans A: 60 sends of ~1.1k characters, each carrying the whole history the way the page does, never reach the fold line
   (zero summarizer calls). Send 61 carries a ~20k-character paste and crosses it: ONE summarizer call. Sends 62-65 each
   carry the whole history again: still one call in total, and the <conversation_summary> note is byte-identical in all five
   (sha and length). Send 61's agent.compact says new > 0 and reused = 0; sends 62-65 carry reason 'reused' with
   reused > 0 and new = 0.
   The invalidations, on the same chat: another model re-summarizes once; a ledger that cannot be written leaves the run done
   and the next send folds again (no record, no loss); deleting the conversation through the real save route removes the
   file and every copy beside it at once, and a stale page that still holds the history meets neither the forgotten rows nor
   the stored summary. Nothing in the dialogue is ever dropped without a summary standing in for it.

   doneMeans B (context-budget-and-fold, step 4): a run at about half the window that gets HTTP 400 "invalid image data" folds
   nothing and ends format_error: the bad request is posted once, no summarizer request, no agent.compact, nothing kept for
   the chat. (The size heuristic used to read that 400 as an overflow because the prompt was over 0.4 of the window: a paid
   fold, the same bad image resent, the run dead on the same 400 - email E28.) The control beside it, on the same size: a
   request the provider refuses as too long for the window folds ONCE, is retried with the summary standing in for the older
   part, and finishes - the guard is not a blanket off switch. overflow-named-cause.test.js holds the class of phrasings. */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { bootToken } = require('./_httpToken.js');
const { hostNotes, userWords } = require('./helpers/host-notes.js');
const root = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-fold-reuse-'));
const SUMMARIES = path.join(workspace, '.summaries');
const WINDOW = 32000;
const STREAM = 'ws_long_chat_7';
const RULE = 'UNIQUE-RULE7F3A';
const BAD = 'BAD-IMAGE7C2E';     // a request carrying it is refused 400 "invalid image data"
const LONG = 'TOO-LONG5D1B';     // a request carrying it is refused 400 "exceeds the context window" until a summary stands in
const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const textOf = c => typeof c === 'string' ? c : JSON.stringify(c);
const mains = [];        // every main-call request body, in order
const mainTokens = [];   // the mock's own prompt-size estimate of each, in step with `mains`
const summaries = [];    // every summarizer request: { n, chars }
let hold = null;         // a promise the summarizer's answer waits for (the delete-mid-fold leg)
let child, base, headers;

const isSummarizer = body => Array.isArray(body.messages) && body.messages.some(m => m && m.role === 'system' && /compress an earlier slice of an agent conversation|maintain a running summary of an agent conversation/.test(textOf(m.content)));
const mock = http.createServer((req, res) => {
  if (req.url.includes('/models')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ data: ['test/model', 'test/model-b', 'test/model-small'].map(id => ({ id, context_length: id === 'test/model-small' ? 16000 : WINDOW, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) }));
  }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', async () => {
    let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
    if (!body || !Array.isArray(body.messages)) { res.writeHead(400); return res.end('{}'); }
    const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
    let reply;
    if (isSummarizer(body)) {
      const n = summaries.length + 1;
      summaries.push({ n, chars: raw.length });
      // the summary names the standing rule it was given, so a leak of the stored summary is visible as the rule's words
      reply = 'SUMMARY-' + n + (raw.includes(RULE) ? ' (keeps ' + RULE + ')' : '');
      if (hold) await hold;
    } else {
      mains.push(body); mainTokens.push(promptTokens);
      const refusal = JSON.stringify(body.messages).includes(BAD) ? 'invalid image data'
        : (JSON.stringify(body.messages).includes(LONG) && !hostNotes(body.messages, 'conversation_summary').length) ? 'This request exceeds the context window of the selected model' : '';
      if (refusal) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: refusal, type: 'invalid_request_error' } })); }
      const last = body.messages.filter(m => m.role === 'user').pop();
      reply = 'Handled: ' + (last ? userWords(last).slice(0, 60) : '');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 8, total_tokens: promptTokens + 8 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
async function boot() {
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(r => socket.close(r));
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['sidecar/index.js'], { cwd: root, env: { ...process.env, SKYNET_WORKSPACES: workspace, SKYNET_PORT: String(port), SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + mock.address().port + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-fold-reuse-fixture',
    STARNET_COMPACT_CHUNK_CHARS: '2000000', SKYNET_EDGE_TTS: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(new Error('boot timeout: ' + out.slice(-1200))), 45000); const read = d => { out += d; if (out.includes('Open in your browser:')) { clearTimeout(timer); resolve(); } }; child.stdout.on('data', read); child.stderr.on('data', read); child.once('exit', c => { clearTimeout(timer); reject(new Error('boot exit ' + c + out.slice(-1200))); }); });
  headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': await bootToken(base, base), Origin: base };
}
async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
// one send, the way the page does it: the history it holds + the new message
async function send(history, text, opts) {
  const o = opts || {}, before = mains.length, calls = summaries.length;
  const r = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', key: 'sk-or-v1-fold-reuse-fixture', model: o.model || 'test/model', streamId: o.streamId || STREAM, messages: history.concat([{ role: 'user', content: text }]) }) });
  const events = (await r.text()).split('\n').filter(Boolean).map(s => JSON.parse(s));
  const end = events.find(e => e.name === 'agent.run.end');
  A.eq(end && end.payload.reason, o.expect || 'done', (o.expect ? 'run ended ' + o.expect : 'run completed') + ': ' + text.slice(0, 24));
  const reply = events.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
  const req = mains.slice(before).find(b => b.messages.some(m => m.role === 'user' && textOf(m.content).indexOf(text) >= 0));
  A.ok(req, 'the provider saw the request: ' + text.slice(0, 24));
  const notes = req ? hostNotes(req.messages, 'conversation_summary') : [];
  return { reply, events, messages: req ? req.messages : [], notes, calls: summaries.length - calls, compacts: events.filter(e => e.name === 'agent.compact').map(e => e.payload),
    posts: mains.length - before, tokens: req ? mainTokens[mains.indexOf(req)] : 0 };
}
// ~1.1k characters of distinct, deterministic words
function words(k, chars) {
  let out = '';
  for (let i = 0; out.length < chars; i++) out += ' w' + (((k + 3) * 7919 + i * 104729) % 99991).toString(36);
  return out.slice(0, chars);
}
const entry = (k, chars) => 'Entry ' + k + ': ' + (k === 1 ? RULE + ' is the standing rule.' : '') + words(k, chars);
const noteSha = notes => notes.map(sha).join(',');

(async () => {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  try {
    await boot();
    A.ok((await fetch(base + '/api/roster', { method: 'POST', headers, body: JSON.stringify({ agents: [{ agentId: 'agent', name: 'Hero', model: 'test/model', provider: 'openrouter' }] }) }).then(r => r.json())).ok, 'roster saved');

    // ---- doneMeans A: sixty sends under the line, one paste over it, four more ----
    const history = [];
    const turn = (text, out) => history.push({ role: 'user', content: text }, { role: 'assistant', content: out.reply });
    for (let k = 1; k <= 60; k++) { const t = entry(k, 1100); const out = await send(history.slice(), t); turn(t, out); if (out.calls || out.notes.length) A.ok(false, 'send ' + k + ' is under the fold line: no summarizer call, no note'); }
    A.eq(summaries.length, 0, 'sixty sends of ~1.1k characters never reach the fold line: no summarizer call');
    A.ok(!fs.existsSync(SUMMARIES) || fs.readdirSync(SUMMARIES).length === 0, 'and nothing was kept');

    const paste = entry(61, 20000);
    const s61 = await send(history.slice(), paste); turn(paste, s61);
    A.eq(summaries.length, 1, 'send 61 crosses the line: exactly ONE paid summarizer call');
    A.eq(s61.notes.length, 1, 'its request carries one conversation_summary note');
    A.ok(s61.notes[0].includes('SUMMARY-1'), 'and it is the fold\'s summary');
    const fold = s61.compacts.filter(c => c.reason === 'context');
    A.eq(fold.length, 1, 'one fold announced itself');
    A.ok(fold[0] && fold[0].new > 0 && fold[0].reused === 0, 'send 61\'s agent.compact says new > 0 and reused = 0 (new ' + (fold[0] && fold[0].new) + ', reused ' + (fold[0] && fold[0].reused) + ')');
    const kept = fs.existsSync(SUMMARIES) ? fs.readdirSync(SUMMARIES).filter(n => /\.json$/.test(n)) : [];
    A.eq(kept, [STREAM + '.json'], 'the summary is on disk, in a dot-prefixed directory, one file for the chat');
    const readRecord = () => { try { return JSON.parse(fs.readFileSync(path.join(SUMMARIES, STREAM + '.json'), 'utf8')).records.agent; } catch (e) { return null; } };   // a missing file is a failed assertion, not a crash
    const record = readRecord() || { rows: 0, digest: '', noteBody: null };
    A.eq(record.noteBody, s61.notes[0], 'and what is on disk is exactly the note the fold sent');
    A.ok(record.rows > 0 && record.rows < history.length, 'it claims a prefix of the chat\'s rows (' + record.rows + ' of ' + history.length + ' rows so far)');
    A.ok(/^[0-9a-f]{64}$/.test(record.digest) && record.ownerVoice === true && record.windowTokens === WINDOW && record.modelKey === 'openrouter/test/model', 'with its digest, voice, window and route');

    const sha61 = noteSha(s61.notes), len61 = s61.notes[0].length;
    const reusedSends = [];
    for (let k = 62; k <= 65; k++) {
      const t = entry(k, 1100);
      const out = await send(history.slice(), t); turn(t, out);
      reusedSends.push(out);
      A.eq(out.calls, 0, 'send ' + k + ': no summarizer call');
      A.eq(out.notes.length, 1, 'send ' + k + ': the request carries one conversation_summary note');
      A.eq(noteSha(out.notes), sha61, 'send ' + k + ': the note is byte-identical to send 61\'s (sha)');
      A.eq(out.notes[0].length, len61, 'send ' + k + ': and the same length');
      const re = out.compacts.filter(c => c.reason === 'reused');
      A.eq(re.length, 1, 'send ' + k + ': one agent.compact reason "reused"');
      A.ok(re[0] && re[0].reused > 0 && re[0].new === 0, 'send ' + k + ': reused > 0 and new = 0 (reused ' + (re[0] && re[0].reused) + ', new ' + (re[0] && re[0].new) + ')');
      A.ok(re[0] && re[0].afterTokens < re[0].beforeTokens && re[0].removed > 0, 'send ' + k + ': it says what it saved (' + (re[0] && re[0].beforeTokens) + ' > ' + (re[0] && re[0].afterTokens) + ')');
      A.eq(out.compacts.filter(c => c.reason === 'context').length, 0, 'send ' + k + ': and no fold');
    }
    A.eq(summaries.length, 1, 'over sends 61-65 exactly ONE summarizer request was made');
    const doneMeansA = { sends: '61-65', summarizerCalls: summaries.length, distinctNotes: new Set([s61].concat(reusedSends).map(o => noteSha(o.notes))).size };
    // nothing was dropped without the note standing in: the exchanges the note replaced are the ones it claims
    const lastReq = reusedSends[3].messages;
    A.ok(JSON.stringify(lastReq).includes(entry(65, 1100).slice(0, 60)), 'the newest turn is in the request verbatim');
    A.ok(!JSON.stringify(lastReq).includes('Entry 30:'), 'an exchange the note replaced is no longer sent word for word');
    A.ok(JSON.stringify(lastReq).includes(RULE), 'but the standing rule still reaches the model (inside the note)');
    const reusedEvent = out => out.compacts.filter(c => c.reason === 'reused').length;
    const folded = out => out.compacts.filter(c => c.reason === 'context');
    const filesOfStream = () => fs.existsSync(SUMMARIES) && fs.statSync(SUMMARIES).isDirectory() ? fs.readdirSync(SUMMARIES).filter(n => n.startsWith(STREAM + '.')) : [];
    const recordOnDisk = () => readRecord() || {};
    let next = 66;
    const sendNext = async (opts, chars) => { const t = entry(next++, chars || 1100); const out = await send(history.slice(), t, opts); turn(t, out); return out; };

    // ---- a window that opens AFTER the claim leaves the free earlier note in place (nothing is lost either way) ----
    {
      const calls = summaries.length, t = entry(next++, 1100);
      const out = await send(history.slice(-6), t);
      turn(t, out);
      A.eq(summaries.length, calls, 'a trimmed page window: no summarizer call');
      A.eq(out.notes.length, 1, 'it still carries exactly one note');
      A.ok(out.notes[0].includes('EARLIER IN THIS CONVERSATION') && !out.notes[0].includes('SUMMARY-1'), 'the free earlier-conversation note, not the stored summary (the window opens after the claim: a gap the stored note does not cover)');
      A.eq(reusedEvent(out), 0, 'and no "reused" announcement');
      A.eq(recordOnDisk().noteBody, s61.notes[0], 'the stored summary stays for a window that does reach it');
    }

    // ---- a TRIMMED window on a small-window model: the free earlier note stands for the part the page did not send, a fold
    //      merges onto it, and the kept summary then covers that earlier part too (its claim starts at the chat's first row) ----
    {
      const small = { model: 'test/model-small' };
      const firstRow = (await (await fetch(base + '/api/transcript?stream=' + STREAM + '&limit=500', { headers })).json()).turns[0];
      const t1 = entry(next++, 1100);
      const w1 = await send(history.slice(-32), t1, small); turn(t1, w1);
      A.eq([w1.calls, folded(w1).length], [1, 1], 'a trimmed window over the fold line of a 16,000-token model folds once');
      A.eq(w1.notes.length, 1, 'into one summary note: the fold merged onto the free earlier note, it did not stack a second');
      A.ok(folded(w1)[0].reused === 0 && folded(w1)[0].new > 0, 'rows the free earlier note carried are new work for a paid fold (new ' + folded(w1)[0].new + ', reused ' + folded(w1)[0].reused + ')');
      const rec = recordOnDisk();
      A.eq([rec.modelKey, rec.windowTokens, rec.fromRowId], ['openrouter/test/model-small', 16000, firstRow.rowId], 'its record belongs to that route and window and starts at the chat\'s FIRST row, though the page sent only its newest slice');
      A.ok(rec.rows > 100 && rec.noteBody === w1.notes[0], 'and spans the rows the page did not send as well as the ones it did (' + rec.rows + ' rows; the page sent 32 messages)');
      const t2 = entry(next++, 1100);
      const w2 = await send(history.slice(-32), t2, small); turn(t2, w2);
      A.eq([w2.calls, folded(w2).length, reusedEvent(w2)], [0, 0, 1], 'the next trimmed send reuses it: the stored note replaces the free earlier note AND the window messages it covers, no call');
      A.eq(noteSha(w2.notes), noteSha(w1.notes), 'byte for byte');
    }

    // ---- another model: the summary was sized for the first one, so it is summarized once more, then reused ----
    {
      const b1 = await sendNext({ model: 'test/model-b' });
      A.eq([b1.calls, folded(b1).length, reusedEvent(b1)], [1, 1, 0], 'model B: one fold, no reuse of the other model\'s summary');
      A.ok(b1.notes[0].includes('SUMMARY-' + summaries.length), 'its note is the new summary (SUMMARY-' + summaries.length + ')');
      A.eq(recordOnDisk().modelKey, 'openrouter/test/model-b', 'and the record now belongs to model B');
      const b2 = await sendNext({ model: 'test/model-b' });
      A.eq([b2.calls, folded(b2).length, reusedEvent(b2)], [0, 0, 1], 'model B again: no call, the summary is reused');
      A.eq(noteSha(b2.notes), noteSha(b1.notes), 'byte for byte');
      const back = await sendNext({});
      A.eq([back.calls, folded(back).length, reusedEvent(back)], [1, 1, 0], 'back on the first model: summarized once more (a model change drops the stored summary)');
      const again = await sendNext({});
      A.eq([again.calls, reusedEvent(again)], [0, 1], 'and reused from then on');
    }

    // ---- an exchange the Commander UNDOES after the summary quoted it: the proof/raw views still hold its rows, the model-replay
    //      view does not, and the digest is taken over the model-replay view, so the stored summary stops reaching the model ----
    {
      const rec = recordOnDisk();
      const turns = (await (await fetch(base + '/api/transcript?stream=' + STREAM + '&limit=500', { headers })).json()).turns;
      const quoted = Array.from(new Set((rec.noteBody.match(/Entry (\d+):/g) || []).map(m => Number(m.match(/\d+/)[0])))).sort((a, b) => b - a);
      const victim = quoted.find(k => { const row = turns.find(r => r.role === 'user' && String(r.content).startsWith('Entry ' + k + ':')); return row && row.rowId <= rec.toRowId; });
      A.ok(victim > 1, 'control: the stored summary quotes a covered exchange word for word (Entry ' + victim + ')');
      const row = turns.find(r => r.role === 'user' && String(r.content).startsWith('Entry ' + victim + ':'));
      const undo = await fetch(base + '/api/turn-identity/retract', { method: 'POST', headers, body: JSON.stringify({ streamId: STREAM, turnId: row && row.turnId }) });
      A.eq(undo.status, 200, 'the Commander undoes that exchange (the real retract route)');
      A.ok(!fs.existsSync(path.join(SUMMARIES, STREAM + '.json')) || !fs.readFileSync(path.join(SUMMARIES, STREAM + '.json'), 'utf8').includes('Entry ' + victim + ':'), 'at rest, right after the undo and before any send, the kept-summary file holds none of the undone words');
      const at = history.findIndex(m => m.role === 'user' && String(m.content).startsWith('Entry ' + victim + ':'));
      history.splice(at, 2);                                   // the page drops the undone turn from what it sends
      const out = await sendNext({});
      A.eq([out.calls, folded(out).length, reusedEvent(out)], [1, 1, 0], 'the stored summary is not served: a covered row is gone from the view the digest reads, so the range is summarized again');
      A.ok(!JSON.stringify(out.messages).includes('Entry ' + victim + ':'), 'and the undone exchange\'s words are nowhere in the request (they would have been, inside the stored note)');
      A.ok(recordOnDisk().noteBody && !recordOnDisk().noteBody.includes('Entry ' + victim + ':'), 'the record on disk was replaced by one that does not quote it');
    }

    // ---- a ledger that cannot be written: the run is done, nothing is kept, the next send folds again ----
    {
      fs.rmSync(SUMMARIES, { recursive: true, force: true });
      fs.writeFileSync(SUMMARIES, 'a file where the directory should be');
      const w1 = await sendNext({});
      A.eq([w1.calls, folded(w1).length, reusedEvent(w1)], [1, 1, 0], 'unwritable ledger: the fold still stands in this run (the run completed above)');
      A.ok(fs.statSync(SUMMARIES).isFile(), 'and nothing could be kept');
      const w2 = await sendNext({});
      A.eq([w2.calls, folded(w2).length, reusedEvent(w2)], [1, 1, 0], 'the next send folds again: a lost summary costs one more fold, never dialogue');
      A.eq(w2.notes.length, 1, 'with its note in the request');
      fs.rmSync(SUMMARIES, { force: true });
      const w3 = await sendNext({});
      A.eq([w3.calls, folded(w3).length], [1, 1], 'ledger writable again: one more fold, and it is kept');
      A.eq(filesOfStream().includes(STREAM + '.json'), true, 'the record is back on disk');
      const w4 = await sendNext({});
      A.eq([w4.calls, reusedEvent(w4)], [0, 1], 'and reused');
    }

    // ---- a summary of content that read the outside world is not clean: the run that reads it is latched ----
    {
      const rec = JSON.parse(fs.readFileSync(path.join(SUMMARIES, STREAM + '.json'), 'utf8'));
      const before = (await (await fetch(base + '/api/transcript?stream=' + STREAM + '&limit=40', { headers })).json()).turns.filter(r => r.role === 'user').pop();
      A.ok(before && !before.taint, 'control: the last clean send\'s directive row carries no taint');
      rec.records.agent.taint = 'web page example.com';
      fs.writeFileSync(path.join(SUMMARIES, STREAM + '.json'), JSON.stringify(rec));
      const t1 = await sendNext({});
      A.eq([t1.calls, reusedEvent(t1)], [0, 1], 'a record carrying taint is still reused');
      const turns = (await (await fetch(base + '/api/transcript?stream=' + STREAM + '&limit=40', { headers })).json()).turns;
      const mine = turns.filter(r => r.role === 'user').pop();
      A.ok(mine && /kept summary carried content from web page example\.com/.test(String(mine.taint || '')), 'the run that read it is latched: its own rows are stamped "' + (mine && mine.taint) + '"');
    }

    // ---- a delete that lands while a fold is in flight: nothing is left behind, now or when the fold finishes ----
    {
      A.ok(filesOfStream().length > 0, 'before the delete the conversation has a kept summary on disk (' + filesOfStream().join(', ') + ')');
      let release; hold = new Promise(r => { release = r; });
      const calls = summaries.length, t = entry(next++, 1100);
      const pending = send(history.slice(), t, { model: 'test/model-b' });          // another route: nothing to reuse, so it folds, and the summarizer waits
      for (let i = 0; i < 200 && summaries.length === calls; i++) await new Promise(r => setTimeout(r, 25));
      A.eq(summaries.length, calls + 1, 'the fold is in flight (its summarizer request has arrived and waits)');
      const saved = await (await fetch(base + '/api/save', { method: 'POST', headers, body: JSON.stringify({ agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: 0,
        workstreams: [{ id: 'ws_kept_elsewhere', title: 'Another chat', history: [] }], deletedIds: [STREAM], forgetIds: [STREAM] }) })).json();
      A.ok(saved && saved.ok !== false, 'the conversation is deleted through the real save route');
      A.eq(filesOfStream(), [], 'its kept summary and every copy beside it (.bak, forensic) are gone the moment the delete returns');
      release(); hold = null;
      const out = await pending; turn(t, out);
      A.eq(filesOfStream(), [], 'and the fold that finishes AFTER the delete leaves nothing behind (the write is refused: it read what the delete forgot)');
      A.ok(fs.existsSync(SUMMARIES) ? fs.readdirSync(SUMMARIES).every(n => !n.startsWith(STREAM)) : true, 'no file of that stream anywhere in the ledger directory');
      // a stale page that still holds the whole conversation: it meets neither the forgotten rows nor the stored summary
      const calls2 = summaries.length;
      const stale = await send(history.slice(-6), entry(next++, 1100));
      A.eq(stale.notes.length, 0, 'a stale page\'s trimmed window gets no note at all: the forgotten rows are not carried and no summary is served');
      A.ok(!JSON.stringify(stale.messages).includes(RULE) && !JSON.stringify(stale.messages).includes('SUMMARY-'), 'the forgotten standing rule and every old summary are absent from the request');
      A.eq(summaries.length, calls2, 'and nothing is summarized');
      const full = await send(history.slice(), entry(next++, 1100));
      A.eq(full.calls, 1, 'a stale page that re-sends the whole conversation is folded once more from what it sent');
      A.eq(filesOfStream(), [], 'and nothing of it is kept: the conversation was deleted');
    }

    // ---- doneMeans B: a run at about half the window that gets "400 invalid image data" folds nothing and ends format_error ----
    const doneMeansB = {};
    {
      const est = msgs => Math.ceil(JSON.stringify(msgs).length / 4);          // the mock's own prompt-size estimate
      // what the sidecar adds to a request (its system prompt and notes), read off one small request on a chat of its own
      const hello = 'Calibration: how much does the sidecar add to a request?';
      const calib = await send([], hello, { streamId: 'ws_calibrate_9' });
      const overhead = calib.tokens - est([{ role: 'user', content: hello }]);
      // thirty exchanges the page carries (plenty for a fold to summarize), then one more message padded so the whole request is half the window
      const chat = [];
      for (let k = 1; k <= 30; k++) { const t = entry(300 + k, 1100); chat.push({ role: 'user', content: t }, { role: 'assistant', content: 'Handled: ' + t.slice(0, 60) }); }
      const padded = (marker, k) => { const head = marker + ' Entry ' + k + ': '; return head + words(k, Math.max(0, Math.round((WINDOW / 2 - overhead - est(chat.concat([{ role: 'user', content: head }]))) * 4))); };
      const share = tokens => Math.round(tokens / WINDOW * 100);

      const calls = summaries.length, bad = await send(chat, padded(BAD, 1), { streamId: 'ws_bad_image_9', expect: 'error' });
      const end = bad.events.find(e => e.name === 'agent.run.end'), fail = bad.events.find(e => e.name === 'agent.run.error');
      A.ok(Math.abs(bad.tokens / WINDOW - 0.5) < 0.03, 'the refused request is about half the window (' + share(bad.tokens) + '%: ' + bad.tokens + ' of ' + WINDOW + ' tokens)');
      A.eq(bad.posts, 1, 'the bad image is posted once: it is not resent');
      A.eq(summaries.length - calls, 0, 'a 400 that names its cause makes no summarizer request');
      A.eq(bad.compacts, [], 'and announces no agent.compact');
      A.eq([end && end.payload.reason, end && end.payload.failureCode], ['error', 'format_error'], 'the run ends error / format_error');
      A.ok(fail && fail.payload.failureCode === 'format_error' && fail.payload.transient === false && /invalid image data/.test(fail.payload.message), 'with the provider\'s own words, not retryable (' + (fail && fail.payload.message) + ')');
      A.ok(!fs.existsSync(path.join(SUMMARIES, 'ws_bad_image_9.json')), 'and nothing is kept for the chat');
      doneMeansB.badImage = { windowShare: share(bad.tokens), posts: bad.posts, summarizerCalls: summaries.length - calls, compacts: bad.compacts.length, end: end && end.payload.failureCode };

      // the control, same size: a request the provider refuses as too long folds ONCE and the retry finishes
      const before = summaries.length, long = await send(chat, padded(LONG, 2), { streamId: 'ws_long_request_9' });
      const folds = long.compacts.filter(c => c.reason !== 'reused');
      A.ok(Math.abs(long.tokens / WINDOW - 0.5) < 0.03, 'the control\'s refused request is the same size (' + share(long.tokens) + '%)');
      A.eq([long.posts, summaries.length - before, folds.length], [2, 1, 1], 'a genuine overflow at that size: one refusal, ONE fold, one retry');
      A.eq(hostNotes(mains[mains.length - 1].messages, 'conversation_summary').length, 1, 'the retry carries the summary that stands in for the older part');
      doneMeansB.overflowControl = { posts: long.posts, summarizerCalls: summaries.length - before, compacts: folds.length };
    }
    console.log(JSON.stringify({ sends: history.length / 2, summarizerCalls: summaries.length, noteSha: sha61.slice(0, 12), noteChars: len61, claimedRows: record.rows, doneMeansA, doneMeansB }));
  } finally { await stop(); await new Promise(r => mock.close(r)); fs.rmSync(workspace, { recursive: true, force: true }); }
  A.report('fold-reuse.http');
})().catch(e => { console.error(e); process.exit(1); });
