/* node test/transcript.test.js — the durable per-workstream conversation transcript (P0.1).
   An in-memory io proves the behavior a daily-driver needs: a turn round-trips, the role is clamped, content
   is length-capped AND redacted on write, history() returns ONE stream's recent turns in chronological order
   capped to the limit, a bad streamId collapses to 'global', and — the headline — the on-disk log replays
   into a fresh store so a SIDECAR RESTART does not wipe the dialogue. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeTranscriptStore, projectConversation } = require('../sidecar/transcriptstore.js');

// in-memory io mirroring the host's JSONL adapter (readAll + append).
function memIo() {
  const lines = [];
  return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } };
}
let clk = 1000;
const clock = { now: () => clk };
// a redact stub shaped like the real one (scrubs sk- / Bearer tokens) so we prove redaction is applied on write.
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]');

// ---- A. append stamps ts from the clock, returns the entry, persists it ----
{
  const io = memIo();
  const s = makeTranscriptStore({ io, clock, redact });
  clk = 1111;
  const e = s.append({ streamId: 'general', agentId: 'agent', role: 'user', content: 'hello there' });
  A.eq(e.streamId, 'general', 'streamId recorded');
  A.eq(e.role, 'user', 'role recorded');
  A.eq(e.content, 'hello there', 'content recorded');
  A.eq(e.ts, 1111, 'ts stamped from injected clock');
  A.eq(s.count(), 1, 'one row');
  A.eq(io.lines.length, 1, 'appended to io');
}

// ---- B. role clamped to the known enum; unknown -> 'user' ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  A.eq(s.append({ streamId: 'x', role: 'assistant', content: 'hi' }).role, 'assistant', 'assistant role kept');
  A.eq(s.append({ streamId: 'x', role: 'tool', content: 'r' }).role, 'tool', 'tool role kept');
  A.eq(s.append({ streamId: 'x', role: 'kaboom', content: 'r' }).role, 'user', 'unknown role clamped to user');
  A.eq(s.append({ streamId: 'x', content: 'r' }).role, 'user', 'missing role defaults to user');
}

// ---- C. content is length-capped (no unbounded blob on disk) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  const e = s.append({ streamId: 'x', content: 'y'.repeat(300000) });
  A.ok(e.content.length <= 200000, 'content capped to 200000 chars');
}

// ---- D. redaction applied on write — a secret-shaped token can't be laundered into the durable file ----
{
  const io = memIo();
  const s = makeTranscriptStore({ io, clock, redact });
  const e = s.append({ streamId: 'x', content: 'my key is sk-ABCD1234EFGH5678 ok' });
  A.ok(e.content.indexOf('sk-ABCD1234') === -1, 'secret scrubbed from returned entry');
  A.ok(JSON.stringify(io.lines[0]).indexOf('sk-ABCD1234') === -1, 'secret scrubbed from the persisted line');
}

// ---- E. history(): chronological, filtered by streamId, limit keeps the MOST RECENT n ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  clk = 1; s.append({ streamId: 'A', content: 'a1' });
  clk = 2; s.append({ streamId: 'B', content: 'b1' });
  clk = 3; s.append({ streamId: 'A', content: 'a2' });
  clk = 4; s.append({ streamId: 'A', content: 'a3' });
  A.eq(s.history('A').map(r => r.content), ['a1', 'a2', 'a3'], 'stream A in chronological order');
  A.eq(s.history('B').map(r => r.content), ['b1'], 'stream B filtered');
  A.eq(s.history('A', { limit: 2 }).map(r => r.content), ['a2', 'a3'], 'limit keeps the most-recent n, chronological');
  A.eq(s.history('NONE'), [], 'unknown stream -> empty');
}

// ---- F. bad/missing streamId collapses to 'global' (matches index.js's rule) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  A.eq(s.append({ streamId: 'has spaces!', content: 'x' }).streamId, 'global', 'invalid streamId -> global');
  A.eq(s.append({ content: 'x' }).streamId, 'global', 'missing streamId -> global');
  A.eq(s.history('global').length, 2, 'both land in the global stream');
}

// ---- G. durable: a fresh store replays the on-disk log (THE restart round-trip) ----
{
  const io = memIo();
  let s = makeTranscriptStore({ io, clock, redact });
  clk = 10; s.append({ streamId: 'general', role: 'user', content: 'first message' });
  clk = 11; s.append({ streamId: 'general', role: 'assistant', content: 'first reply' });
  clk = 12; s.append({ streamId: 'general', role: 'user', content: 'second message' });
  s = makeTranscriptStore({ io, clock, redact });   // <-- simulate a SIDECAR RESTART: rebuilt from the same disk
  A.eq(s.count(), 3, 'transcript replayed into a fresh store after restart');
  A.eq(s.history('general').map(r => r.content), ['first message', 'first reply', 'second message'], 'dialogue intact + ordered after restart');
}

// ---- H. corrupt/missing log -> empty history, append still works (fail-open) ----
{
  const bad = { readAll() { throw new Error('corrupt'); }, append() {} };
  const s = makeTranscriptStore({ io: bad, clock, redact });
  A.eq(s.count(), 0, 'corrupt log -> empty');
  A.eq(s.append({ streamId: 'x', content: 'still works' }).content, 'still works', 'append still works over a corrupt log');
}

// ---- I. no redact injected -> content passes through unchanged (decoupled) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  A.eq(s.append({ streamId: 'x', content: 'plain text' }).content, 'plain text', 'works without an injected redact');
}

// ---- J. (H1.1) optional structured fields: tool_calls + tool_call_id round-trip + redaction; additive ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact: (t) => String(t).replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]') });
  const a = s.append({ streamId: 'x', role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 'fs_write', arguments: '{"k":"sk-ABCD1234EFGH"}' } }] });
  A.ok(typeof a.toolCalls === 'string' && a.toolCalls.indexOf('fs_write') !== -1, 'assistant tool_calls stored as a JSON string');
  A.ok(a.toolCalls.indexOf('sk-ABCD1234') === -1, 'secrets in tool_calls args are redacted');
  const t = s.append({ streamId: 'x', role: 'tool', content: 'ok', toolCallId: 'c1' });
  A.eq(t.toolCallId, 'c1', 'tool result carries tool_call_id');
  const plain = s.append({ streamId: 'x', role: 'user', content: 'hi' });
  A.ok(!('toolCalls' in plain) && !('toolCallId' in plain), 'no structured fields when absent (additive / byte-identical to before)');
}

// ---- K. (H1.1) appendTurns: records EVERY new turn verbatim (user, assistant+tool_call, tool-result, final) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  // a realistic OpenAI-format messages array: [prior history..., directive, assistant(tool_call), tool, assistant(final)]
  const messages = [
    { role: 'user', content: 'OLD history turn (already persisted last run)' },           // index 0 — BEFORE the boundary
    { role: 'system', content: '<recalled-memory>fence</recalled-memory>' },              // a system fence — must be skipped
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '{"p":"a.txt"}' } }] },
    { role: 'tool', content: 'file contents', tool_call_id: 'tc1' },
    { role: 'assistant', content: 'Here is the answer.' },
  ];
  const n = s.appendTurns('s1', 'agent', messages, 2);   // boundary = 2: only this run's new turns (skip the OLD history at 0)
  A.eq(n, 3, 'appended 3 turns (assistant+tool_call, tool-result, final) — system fence skipped, old history skipped');
  const h = s.history('s1');
  A.eq(h.map(r => r.role), ['assistant', 'tool', 'assistant'], 'exact roles, chronological');
  A.ok(h[0].toolCalls && h[0].toolCalls.indexOf('fs_read') !== -1, 'the assistant tool_call is captured verbatim');
  A.eq(h[1].toolCallId, 'tc1', 'the tool result keeps its tool_call_id (pairs to the call)');
  A.eq(h[2].content, 'Here is the answer.', 'the final assistant text is captured');
  A.ok(h.every(r => r.content !== 'OLD history turn (already persisted last run)'), 'pre-boundary history is NOT re-appended (no duplication)');
}

// ---- K2. appendNew survives COMPACTION — the boundary a positional fromIndex cannot express.
//      The real shape: a RESUMED session assembles a long prompt, the loop compacts mid-run (loop.js rebuilds
//      the SAME array in place and far SHORTER), and the run-end drain must still record every turn the loop
//      added. Under the old positional boundary this appended ZERO rows and said nothing — the whole run's
//      dialogue vanished, worst on exactly the long sessions most likely to compact. ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  // 1) resumed session: a long reconstructed history is the prompt the loop starts from
  const msgs = [];
  for (let i = 0; i < 102; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'prior turn ' + i });
  const boundary = msgs.length;                       // exactly what the old code captured as _txStart
  A.eq(s.markPersisted(msgs), 102, 'the assembled prompt is marked already-recorded');

  // 2) the loop adds this run's turns
  msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '{}' } }] });
  msgs.push({ role: 'tool', content: 'file contents', tool_call_id: 'tc1' });

  // 3) COMPACTION: fold the older turns and rebuild the array IN PLACE — same object, much shorter
  const kept = msgs.slice(-2);                        // keepTail
  msgs.length = 0;
  msgs.push({ role: 'system', content: '<conversation_summary>folded</conversation_summary>' });
  for (const m of kept) msgs.push(m);
  A.ok(boundary > msgs.length, 'the positional boundary now points PAST the end of the array (the bug)');
  A.eq(s.appendTurns('s1', 'a', msgs, boundary), 0, 'REGRESSION WITNESS: the old positional path silently records nothing');

  // 4) the loop finishes
  msgs.push({ role: 'assistant', content: 'Here is the answer.' });

  // 5) run-end drain: marker-keyed, so a fold cannot invalidate it
  A.eq(s.appendNew('s1', 'a', msgs), 3, 'every turn the loop added is recorded despite the compaction');
  const h = s.history('s1');
  A.eq(h.map(r => r.role), ['assistant', 'tool', 'assistant'], 'exact roles, chronological');
  A.ok(h[0].toolCalls && h[0].toolCalls.indexOf('fs_read') !== -1, 'the assistant tool_call survives verbatim');
  A.eq(h[1].toolCallId, 'tc1', 'the tool result keeps its pairing id');
  A.eq(h[2].content, 'Here is the answer.', 'the final answer reached the durable transcript');
  A.ok(h.every(r => String(r.content).indexOf('prior turn') !== 0), 'already-recorded history is never re-appended');
}

// ---- K3. the mid-run drain is IDEMPOTENT: turns folded away are recorded once, at the fold, and the run-end
//      drain adds only the remainder. This is what keeps the dialogue COMPLETE (not merely non-empty) when a
//      long run compacts — the run-end pass can only ever see what survived the fold. ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  const msgs = [{ role: 'user', content: 'the directive' }];
  s.markPersisted(msgs);                                   // the directive is recorded separately by the host
  const t1 = { role: 'assistant', content: 'step one' };
  const t2 = { role: 'assistant', content: 'step two' };
  msgs.push(t1, t2);
  // compaction is about to delete [t1]; index.js drains that slice inside summarize() before it is dropped
  A.eq(s.appendNew('s1', 'a', [t1]), 1, 'the folded slice is drained before it is deleted');
  msgs.length = 0;
  msgs.push({ role: 'system', content: '<conversation_summary>folded</conversation_summary>' }, t2);
  msgs.push({ role: 'assistant', content: 'final' });
  A.eq(s.appendNew('s1', 'a', msgs), 2, 'run-end drain adds only what was not already recorded');
  A.eq(s.history('s1').map(r => r.content), ['step one', 'step two', 'final'], 'complete dialogue, in order, no duplicates');
}

// ---- K4. the boundary marker is invisible: it never reaches disk and never rides out to a provider ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  const m = { role: 'user', content: 'hello' };
  s.markPersisted([m]);
  A.eq(JSON.stringify(m), '{"role":"user","content":"hello"}', 'marker is invisible to JSON.stringify (never sent on the wire)');
  A.eq(Object.keys(m).join(','), 'role,content', 'marker adds no enumerable key');
  A.eq(s.markPersisted([m]), 0, 'marking is idempotent');
}

// ---- L. (H1.2) reconstruct(): rebuild OpenAI-format messages incl. tool_calls/tool pairs for resume ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  s.appendTurns('s1', 'a', [
    { role: 'user', content: 'find the file' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '{}' } }] },
    { role: 'tool', content: 'contents', tool_call_id: 'tc1' },
    { role: 'assistant', content: 'Found it.' },
  ], 0);
  const m = s.reconstruct('s1');
  A.eq(m.map(x => x.role), ['user', 'assistant', 'tool', 'assistant'], 'reconstructs every prior turn in order');
  A.ok(Array.isArray(m[1].tool_calls) && m[1].tool_calls[0].function.name === 'fs_read', 'assistant tool_calls parsed back to an array');
  A.eq(m[2].tool_call_id, 'tc1', 'tool message keeps its tool_call_id (pairs to the call)');
  A.eq(m[3].content, 'Found it.', 'final assistant text reconstructed');
}
// ---- M. (H1.2) reconstruct() is pairing-safe at a truncated boundary ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  s.append({ streamId: 'x', role: 'tool', content: 'orphan result', toolCallId: 'z' });   // a tool with no preceding call (slice start)
  s.append({ streamId: 'x', role: 'user', content: 'hello' });
  s.append({ streamId: 'x', role: 'assistant', content: '', toolCalls: [{ id: 'tail', function: { name: 'x', arguments: '{}' } }] }); // results cut off the end
  const m = s.reconstruct('x');
  A.eq(m[0].role, 'user', 'a leading orphaned tool message is dropped (valid for the provider)');
  A.ok(!m[m.length - 1].tool_calls, 'a trailing assistant with cut-off results has its tool_calls stripped');
}

// ---- PER-STREAM RAM fairness: a firehose stream self-trims WITHOUT evicting a quiet stream's turns ----
{
  const io = memIo();
  const s = makeTranscriptStore({ io, clock, redact, ramPerStream: 20 });   // tiny per-stream cap for the test
  // a quiet stream logs a handful of turns FIRST (oldest in the global array)
  for (let i = 0; i < 5; i++) s.append({ streamId: 'quiet', agentId: 'a', role: 'user', content: 'q' + i });
  // then a firehose stream floods far past the per-stream cap
  for (let i = 0; i < 200; i++) s.append({ streamId: 'loud', agentId: 'a', role: 'user', content: 'L' + i });
  // the loud stream is bounded to the per-stream cap...
  A.eq(s.history('loud', { limit: 1000 }).length, 20, 'the firehose stream is bounded to ramPerStream');
  // ...but the quiet stream's turns were NOT evicted (per-stream fairness — global trim would have lost them)
  const quiet = s.history('quiet', { limit: 1000 });
  A.eq(quiet.length, 5, 'the quiet stream kept ALL its turns despite the firehose (fairness)');
  A.eq(quiet[0].content, 'q0', 'the quiet stream oldest turn survived');
  // disk kept every append; only RAM was trimmed
  A.eq(io.lines.length, 205, 'disk kept every appended turn (only RAM trimmed)');
  // the loud stream retained its NEWEST turns
  const loud = s.history('loud', { limit: 1000 });
  A.eq(loud[loud.length - 1].content, 'L199', 'the firehose kept its newest turn');
  A.eq(loud[0].content, 'L180', 'the firehose dropped only its oldest turns');
}

// ---- recovery provenance: strict drains stamp every durable row before marking the source message ----
{
  const io = memIo();
  io.appendDurable = io.append;
  const s = makeTranscriptStore({ io, clock, redact });
  const messages = [{ role: 'assistant', content: 'durable answer' }];
  A.eq(s.appendNewStrict('recovery', 'a', messages, { sourceRunId: 'run-123' }), 1, 'strict drain persists one visible turn');
  A.eq(s.history('recovery')[0].sourceRunId, 'run-123', 'durable transcript row carries opaque recovery provenance');
  A.eq(s.appendNewStrict('recovery', 'a', messages, { sourceRunId: 'run-123' }), 0, 'strict drain remains idempotent for marked messages');
}

{
  const s = makeTranscriptStore({ io: memIo(), clock });
  s.append({ streamId: 'shared', role: 'user', content: 'request A', sourceRunId: 'A' });
  s.append({ streamId: 'shared', role: 'assistant', content: 'answer A', sourceRunId: 'A' });
  for (let n = 0; n < 60; n++) s.append({ streamId: 'shared', role: 'assistant', content: 'answer B ' + n, sourceRunId: 'B' });
  A.eq(s.history('shared', { limit: 2, sourceRunId: 'A' }).map(r => r.content), ['request A', 'answer A'], 'run filter precedes limit in RAM history');
  A.eq(s.history('shared', { sourceRunId: 'missing' }).length, 0, 'unknown run never falls back to unrelated session turns');
}

// Dispatch conversation projection is durable independently of the bounded execution ledger.
{
  const io = memIo(); io.appendDurable = io.append;
  let s = makeTranscriptStore({ io, clock, redact });
  const common = { streamId: 'dispatch', agentId: 'worker', sourceRunId: 'original', dispatchState: 'pending' };
  s.append({ streamId: 'dispatch', role: 'user', content: 'legacy question' });
  s.appendStrict({ ...common, role: 'user', content: 'contracted machine instruction' });
  s.appendNewStrict('dispatch', 'worker', [{ role: 'assistant', content: 'raw invalid' }], { sourceRunId: 'original', dispatchState: 'pending' });
  s.appendNew('dispatch', 'worker', [{ role: 'assistant', content: 'repair evidence' }], { sourceRunId: 'repair', dispatchState: 'internal' });
  A.eq(projectConversation(s.history('dispatch'), () => null).map(t => t.content), ['legacy question'], 'pending and internal turn markers suppress raw output even after run ledger eviction');
  const full = 'accepted '.repeat(4000);
  s.appendStrict({ ...common, role: 'assistant', content: full, dispatchState: 'final', dispatchPrompt: 'original request', dispatchReason: 'done', taint: 'web_fetch' });
  s.append({ streamId: 'dispatch', role: 'assistant', content: 'legacy answer' });
  s = makeTranscriptStore({ io, clock, redact });
  const raw = s.history('dispatch');
  A.eq(projectConversation(raw, () => null).map(t => t.content), ['legacy question', 'original request', full, 'legacy answer'], 'restart projection retains one full accepted answer and original prompt without execution ledger');
  A.eq(projectConversation(raw, () => null).filter(t => t.dispatchState === 'final')[0].sourceRunId, 'original', 'final answer retains original dispatch identity');
  A.eq(projectConversation(raw, () => null).find(t => t.dispatchState === 'final').taint, 'web_fetch', 'accepted projection retains untrusted-output provenance after restart');
  A.ok(s.history('dispatch', { sourceRunId: 'repair' }).every(t => t.dispatchState === 'internal'), 'output-only repair append stamps exact run provenance and internal visibility');
  A.ok(raw.some(t => t.content === 'raw invalid') && raw.some(t => t.content === 'repair evidence'), 'raw history retains original and repair evidence');
  A.ok(!s.reconstruct('dispatch').some(t => t.content === full), 'display projection does not duplicate execution in reconstructed model context');
  const withoutFinal = raw.filter(t => t.dispatchState !== 'final');
  const recovered = projectConversation(withoutFinal, id => id === 'original' ? { deliveryPrompt: 'original request', dispatchDelivery: { state: 'final', reason: 'invalid-result', text: 'No completion accepted' } } : null);
  A.eq(recovered.map(t => t.content), ['legacy question', 'original request', 'legacy answer'], 'failed final projection never substitutes the run envelope or raw output');
  A.eq(projectConversation(withoutFinal, id => id === 'original' ? { dispatchDelivery: { state: 'final', reason: 'done', text: 'x'.repeat(24000) } } : null).filter(t => t.sourceRunId === 'original'), [], 'missing full projection never publishes a possibly truncated delivery preview');
  A.eq(projectConversation([{ role: 'assistant', content: 'legacy' }], () => null), [{ role: 'assistant', content: 'legacy' }], 'legacy unmarked conversations keep their existing shape');
}

// A delegated run the sidecar stopped mid-way (never finalized) keeps its directive and says it was interrupted,
// instead of the whole thread silently disappearing. Its raw partial output stays hidden.
{
  const rows = [
    { streamId: 'research', agentId: 'ada', role: 'user', content: 'Find three JWST facts', from: 'nova', sourceRunId: 'w1', dispatchState: 'pending', ts: 10 },
    { streamId: 'research', agentId: 'ada', role: 'assistant', content: 'PARTIAL RAW WORK', sourceRunId: 'w1', dispatchState: 'pending', ts: 11 },
    { streamId: 'research', agentId: 'ada', role: 'assistant', content: 'MORE PARTIAL WORK', sourceRunId: 'w1', dispatchState: 'pending', ts: 12 }
  ];
  const interrupted = projectConversation(rows, id => id === 'w1' ? { runId: 'w1', reason: 'interrupted', error: 'interrupted: StarNet stopped before this run finished; it can be continued' } : null);
  A.eq(interrupted.filter(t => !t.sys).map(t => t.content), ['Find three JWST facts'], 'an interrupted delegated run keeps its directive');
  A.eq(interrupted[0] && interrupted[0].from, 'nova', 'the directive keeps who sent it');
  const status = interrupted.filter(t => t.sys);
  A.eq(status.length, 1, 'exactly one interrupted status line is shown');
  A.ok(!!status[0] && status[0].error === true && status[0].sourceRunId === 'w1' && /interrupted/.test(status[0].content), 'the status line says the run was interrupted');
  A.ok(!interrupted.some(t => /PARTIAL/.test(t.content)), 'raw partial output of an unaccepted run is never shown');
  const noError = projectConversation(rows, () => ({ runId: 'w1', reason: 'interrupted' }));
  A.ok(noError.some(t => t.sys && /no result was accepted/.test(t.content)), 'an interrupted run with no recorded reason still says no result was accepted');
  A.eq(projectConversation(rows, () => ({ runId: 'w1', reason: 'done', dispatchDelivery: { state: 'pending' } })), [], 'a run still pending finalization stays hidden (its accepted answer may be in flight)');
  A.eq(projectConversation(rows, () => null), [], 'a run with no record stays hidden');

  // Every open re-merges the station's projection into the saved thread (desk: chat.js mergeCanonicalHistory; phone:
  // remote/host.js mergeCanonical), and the result is saved. The interrupted line must stay ONE line however often the
  // thread is opened, with or without a saved copy of the directive, and sit right under its directive.
  const fs = require('node:fs'), path = require('node:path');
  const mergeFrom = (file, header) => {
    const body = require('./helpers/turnmerge').source(header.includes('mergeCanonicalHistory') ? 'mergeCanonicalHistory' : 'mergeCanonical');
    A.ok(body.length > 0, file + ': its history merge was found');
    return new Function('return (' + body + ')')();
  };
  const merges = [['desk', mergeFrom('frontend/app/chat.js', 'function mergeCanonicalHistory(local, turns)')],
    ['phone', mergeFrom('sidecar/remote/host.js', 'function mergeCanonical(local, turns)')]];
  for (const [surface, merge] of merges) {
    for (const [label, start] of [['no saved copy', []], ['a saved directive', [{ role: 'user', content: 'Find three JWST facts', from: 'nova', ts: 10 }]]]) {
      let saved = start;
      for (let open = 1; open <= 4; open++) saved = JSON.parse(JSON.stringify(merge(saved, interrupted)));
      const lines = saved.filter(t => t.sys && /interrupted/.test(t.content));
      A.eq(lines.length, 1, surface + ', ' + label + ': four opens keep exactly one interrupted line');
      A.eq(saved.map(t => t.content), ['Find three JWST facts', interrupted[1].content], surface + ', ' + label + ': the line sits under its directive');
    }
  }
  // Once the run has an accepted answer the station stops sending the line, and the saved copy goes with it.
  const healed = merges[0][1](merges[0][1]([], interrupted), [rows[0]]);
  A.ok(!healed.some(t => t.sys), 'a saved interrupted line is not kept once the station no longer reports it');
}

// Full accepted output and the bounded execution preview have separate durability contracts.
{
  const { makeRunStore } = require('../sidecar/runstore.js');
  const { finalizeDispatchDelivery } = require('../sidecar/dispatch-delivery.js');
  const { isFinalDeliveryRow } = require('../sidecar/transcriptstore.js');
  const hash = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  const runIo = memIo(), turnIo = memIo(); let failProjection = false, failPatch = false;
  const appendRun = runIo.append; runIo.append = row => { if (failPatch && row.kind === 'dispatch-delivery') throw Error('patch failed'); appendRun(row); };
  const appendTurn = turnIo.append; turnIo.appendDurable = row => {
    if (failProjection && row.dispatchState === 'final') throw Error('projection failed');
    const saved = Object.assign({}, row, { rowId: turnIo.lines.length + 1 }); appendTurn(saved); return saved;
  };
  let runStore = makeRunStore({ io: runIo, clock }), transcriptStore = makeTranscriptStore({ io: turnIo, clock });
  const finalize = (id, text, extra) => finalizeDispatchDelivery({ runStore, transcriptStore, redact: text => text, hash }, id, { text, reason: 'done', repairRunId: 'repair', ...extra });
  runStore.record({ runId: 'original', streamId: 'S', reason: 'done', usd: 0.2, dispatchDelivery: { state: 'pending' } });
  runStore.record({ runId: 'repair', streamId: 'S', reason: 'done', usd: 0.1, dispatchDelivery: { state: 'internal' } });
  const text = JSON.stringify({ answer: 'x'.repeat(250000) + 'TAIL' });
  failProjection = true;
  A.throws(() => finalize('original', text), 'projection append failure propagates before run finalization');
  A.eq(runStore.latest('original').dispatchDelivery.state, 'pending', 'failed full projection cannot publish a final run preview');
  A.eq(turnIo.lines.length, 0, 'failed full projection leaves no accepted display row');
  runStore = makeRunStore({ io: runIo, clock }); transcriptStore = makeTranscriptStore({ io: turnIo, clock });
  A.eq(runStore.latest('original').dispatchDelivery.state, 'pending', 'restart after projection failure retains truthful pending delivery');
  failProjection = false; failPatch = true;
  A.throws(() => finalize('original', text), 'run patch failure follows durable full projection');
  A.eq(turnIo.lines.length, 1, 'first accepted full projection remains available after patch failure');
  A.eq(turnIo.lines[0].content.length, text.length, 'accepted projection exceeds old 200k cap losslessly');
  A.eq(turnIo.lines[0].textSha256, hash(text), 'projection carries full UTF-8 hash');
  runStore = makeRunStore({ io: runIo, clock }); transcriptStore = makeTranscriptStore({ io: turnIo, clock });
  transcriptStore.appendStrict({ streamId: 'S', sourceRunId: 'original', role: 'assistant', content: 'late raw row', dispatchState: 'pending' });
  failPatch = false;
  A.throws(() => finalize('original', text.slice(0, -3) + 'B"}'), 'different same-prefix answer cannot replace first accepted text after restart');
  A.throws(() => finalize('original', text, { reason: 'error' }), 'same text cannot replace first accepted reason');
  A.throws(() => finalize('original', text, { repairRunId: 'other' }), 'same text cannot replace first accepted repair identity');
  const final = finalize('original', text);
  A.eq(final.dispatchDelivery.textLength, text.length, 'run envelope carries complete character length');
  A.eq(final.dispatchDelivery.textSha256, hash(text), 'run envelope carries complete content digest');
  A.eq(final.dispatchDelivery.text.length, 24000, 'run envelope remains a bounded preview');
  A.eq(finalize('original', text).dispatchDelivery, final.dispatchDelivery, 'identical finalization is idempotent');
  A.eq(turnIo.lines.filter(t => t.dispatchState === 'final').length, 1, 'late raw rows and repeated finalization never duplicate accepted output');
  A.eq(makeRunStore({ io: runIo, clock }).latest('original').dispatchDelivery, final.dispatchDelivery, 'complete integrity metadata survives run-store restart');
  A.ok(Math.abs(runStore.all().reduce((sum, row) => sum + row.usd, 0) - 0.3) < 1e-9, 'retries and integrity metadata never duplicate spend');
  A.throws(() => finalize('repair', text), 'internal repair cannot acquire independent delivery authority');
  const unknown = makeTranscriptStore({ io: { readAll: () => [], append: () => {}, history: () => { throw Error('segment unavailable'); } }, clock });
  A.throws(() => finalizeDispatchDelivery({ runStore, transcriptStore: unknown, redact: t => t, hash }, 'original', { text, reason: 'done', repairRunId: 'repair' }), 'unreadable prior acceptance cannot become a replaceable empty history');
  const row = { streamId: 'S', sourceRunId: 'original', role: 'assistant', dispatchState: 'final', content: text, textLength: text.length, textSha256: hash(text) };
  A.ok(isFinalDeliveryRow(row, hash), 'full accepted projection integrity verifies');
  A.ok(!isFinalDeliveryRow({ ...row, dispatchReason: 'done', dispatchRepairRunId: 'repair' }, hash, { ...final.dispatchDelivery, textSha256: 'f'.repeat(64) }), 'full projection cannot disagree with finalized execution integrity');
  const redactedStore = makeTranscriptStore({ io: memIo(), clock, redact: t => t.replace(/sensitive/g, '[redacted]') });
  runStore.record({ runId: 'redacted', streamId: 'R', reason: 'done', dispatchDelivery: { state: 'pending' } });
  const redacted = finalizeDispatchDelivery({ runStore, transcriptStore: redactedStore, redact: t => t.replace(/sensitive/g, '[redacted]'), hash }, 'redacted', { text: 'answer sensitive', reason: 'done' });
  const redactedRow = redactedStore.history('R')[0];
  A.eq(redactedRow.content, 'answer [redacted]', 'finalizer stores only redacted accepted text');
  A.eq(redacted.dispatchDelivery.textLength, redactedRow.content.length, 'envelope length is computed after actual finalizer redaction');
  A.eq(redacted.dispatchDelivery.textSha256, hash(redactedRow.content), 'envelope digest exactly matches redacted stored content');
  A.ok(!isFinalDeliveryRow({ ...row, content: text.slice(0, 200000) }, hash), 'truncated modern projection fails integrity');
  A.ok(!isFinalDeliveryRow({ ...row, content: text.slice(0, -3) + 'Z"}' }, hash), 'same-length corrupted tail fails integrity');
  A.ok(!isFinalDeliveryRow({ ...row, textLength: undefined, textSha256: undefined, content: 'x'.repeat(200000) }, hash), 'historical cap-length legacy final is unproven');
  A.eq(projectConversation([{ ...row, textLength: undefined, textSha256: undefined, content: 'x'.repeat(200000) }], () => null, hash), [], 'canonical read suppresses historical truncated final rows');
  const max = 'x'.repeat(1048576);
  const maxRow = transcriptStore.appendStrict({ ...row, content: max, textLength: max.length, textSha256: hash(max) });
  A.eq(maxRow.content.length, 1048576, 'final output at supported maximum persists without truncation');
  A.throws(() => transcriptStore.appendStrict({ ...row, content: max + 'x' }), 'unsupported final size is an explicit write failure, never a silently cropped answer');
  const expanded = makeTranscriptStore({ io: memIo(), clock, redact: t => t + 'x' });
  A.throws(() => expanded.appendStrict({ ...row, content: max }), 'redaction expansion over final storage bound fails explicitly');
  const raw = transcriptStore.appendStrict({ streamId: 'S', sourceRunId: 'repair', dispatchState: 'internal', role: 'assistant', content: text });
  A.eq(raw.content.length, 200000, 'ordinary raw execution transcript retains its existing cap');
}

{
  const store = makeTranscriptStore({ io: memIo(), clock });
  store.append({ streamId: 'preview', role: 'user', content: 'Visible topic', taint: null });
  store.append({ streamId: 'preview', role: 'user', content: 'Hidden contract', dispatchState: 'pending' });
  store.append({ streamId: 'preview', role: 'user', content: 'Hidden repair', dispatchState: 'internal' });
  A.eq(store.streams()[0].preview, 'Visible topic', 'RAM preview excludes pending and internal prompts');
  store.append({ streamId: 'preview', role: 'assistant', content: 'answer', dispatchState: 'final', dispatchPrompt: 'Accepted request', taint: 'web_fetch' });
  A.eq(store.streams()[0].preview, 'Accepted request', 'RAM preview mirrors accepted projection topic');
  A.eq(store.streams()[0].previewTaint, 'web_fetch', 'RAM preview uses accepted source provenance');
  store.append({ streamId: 'preview', role: 'user', content: 'New clean topic', taint: null });
  A.eq(store.streams()[0].previewTaint, '', 'new clean visible prompt clears prior tainted preview metadata');
  A.ok(store.streams()[0].previewTaintKnown, 'new clean visible prompt retains known-clean provenance');
}
A.report('transcript.test');
