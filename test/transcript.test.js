/* node test/transcript.test.js — the durable per-workstream conversation transcript (P0.1).
   An in-memory io proves the behavior a daily-driver needs: a turn round-trips, the role is clamped, content
   is length-capped AND redacted on write, history() returns ONE stream's recent turns in chronological order
   capped to the limit, a bad streamId collapses to 'global', and — the headline — the on-disk log replays
   into a fresh store so a SIDECAR RESTART does not wipe the dialogue. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

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
A.report('transcript.test');
