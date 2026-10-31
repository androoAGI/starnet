/* node test/comms-wait-line.test.js — COMMS LIVE WAIT LINE (2026-09-23, live-events lane).

   The presence card (#comms-presence) read THINKING and nothing else while the sidecar sat in its retry ladder or
   waited minutes on a slow first byte. The sidecar now emits provider.retry before each backoff and agent.waiting on
   a ~15 s heartbeat; chat.js folds them per run and renders the result in the card's existing .cp-tool slot — the
   same transient line that names the running tool (no new visual vocabulary: COMMS is already designed).

   chat.js is browser-flow (not node-loadable), so — like comms-presence.test.js — the wiring is locked on the source,
   and the two PURE pieces (foldWaitNote: event -> note, waitNoteText: note -> line) are extracted with A.fnBody and
   RUN against the event sequences the loop really emits. Truthful telemetry: every number on the line comes off an
   event (no local countdown), and the line clears the moment the run shows output, fails over or ends. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const grab = header => {
  const body = A.fnBody(src, header);
  A.ok(body && body.length < 4000, header + ' extracted (' + (body ? body.length : 0) + ' chars)');
  return body;
};
const lib = new Function(grab('function fmtElapsed(') + '\n' + grab('function foldWaitNote(') + '\n' + grab('function waitModelLabel(') + '\n' + grab('function waitNoteText(')
  + '\nreturn { fmtElapsed, foldWaitNote, waitModelLabel, waitNoteText };')();
const { foldWaitNote, waitNoteText } = lib;
const run = evs => evs.reduce((note, [name, p]) => foldWaitNote(note, name, p), null);

/* ---------- 1. the lines the Commander reads ---------- */
{
  const retry = { agentId: 'a', runId: 'r', attempt: 3, maxAttempts: 6, reason: 'overloaded', delayMs: 30000, model: 'anthropic/claude-sonnet-4.5' };
  let n = foldWaitNote(null, 'provider.retry', retry);
  A.eq(waitNoteText(n), 'retry 3/6 in 30s (overloaded) — claude-sonnet-4.5', 'retry line: rung/budget, the announced wait, the reason, then the model');
  n = foldWaitNote(n, 'agent.waiting', { runId: 'r', phase: 'retry_backoff', sinceMs: 15000, model: 'anthropic/claude-sonnet-4.5' });
  A.eq(waitNoteText(n), 'retry 3/6 in 15s (overloaded) — claude-sonnet-4.5', 'a backoff beat updates the remaining wait from the EVENT (delayMs − sinceMs)');
  n = foldWaitNote(n, 'agent.waiting', { runId: 'r', phase: 'first_byte', sinceMs: 0, model: 'anthropic/claude-sonnet-4.5' });
  A.eq(waitNoteText(n), 'waiting on claude-sonnet-4.5', 'the retry going out replaces the countdown (no stale "retry in 15s")');
  n = foldWaitNote(n, 'agent.waiting', { runId: 'r', phase: 'first_byte', sinceMs: 45000, model: 'anthropic/claude-sonnet-4.5' });
  A.eq(waitNoteText(n), 'waiting for 45s on claude-sonnet-4.5', 'a slow first byte: how long, per the heartbeat');
  n = foldWaitNote(n, 'agent.waiting', { runId: 'r', phase: 'streaming', sinceMs: 75000, model: 'anthropic/claude-sonnet-4.5' });
  A.eq(waitNoteText(n), 'waiting for 1:15 (stream open) on claude-sonnet-4.5', 'an open stream with nothing shown says so; long waits use the COMMS m:ss format');
  A.eq(foldWaitNote(n, 'agent.token', { runId: 'r', delta: 'Hello' }), null, 'the first token clears the line');
  A.eq(foldWaitNote(n, 'agent.token', { runId: 'r', delta: '' }), n, 'an empty delta shows nothing, so it clears nothing');
  for (const ev of ['agent.tool_call', 'agent.tool_result', 'provider.fallback', 'agent.run.end', 'agent.run.error']) {
    A.eq(foldWaitNote(n, ev, { runId: 'r' }), null, ev + ' ends the wait');
  }
  A.eq(foldWaitNote(n, 'agent.cost', { runId: 'r' }), n, 'unrelated events leave the note alone');
}

/* ---------- 2. edges stay honest ---------- */
A.eq(waitNoteText(run([['provider.retry', { attempt: 1, maxAttempts: 6, reason: 'server_error', delayMs: 400, model: 'm' }]])),
  'retry 1/6 in 1s (server error) — m', 'a sub-second rung reads "in 1s" (rounded up), reason made readable');
A.eq(waitNoteText(run([['provider.retry', { attempt: 2, reason: 'timeout', delayMs: 0, model: 'm' }]])),
  'retry 2 now (timeout) — m', 'no sleep wired -> "now"; no budget -> no "/N"');
A.eq(waitNoteText(run([['agent.waiting', { phase: 'retry_backoff', sinceMs: 30000, model: 'm' }]])),
  'retry backoff, 30s so far — m', 'a backoff beat with no retry seen (e.g. after a reload) claims only what it says');
A.eq(waitNoteText(run([['agent.waiting', { phase: 'first_byte', sinceMs: 15000 }]])), 'waiting for 15s on the model', 'no model named -> "the model"');
A.eq(waitNoteText(run([['agent.waiting', { phase: 'connect', sinceMs: 15000, model: 'm' }]])), 'connecting for 15s to m', 'connect phase');
A.eq(waitNoteText(null), '', 'no note -> empty line (the slot hides)');
/* #99: a local Ollama withholds its headers until the first token; the sidecar's beat names where /api/ps says the model
   sits. The line shows exactly that note after the duration, the model still last; a later beat without one drops it. */
{
  const note = '~27k-token prompt · Ollama has it 45% on GPU, 55% on CPU at a 32k window';
  let n = foldWaitNote(null, 'agent.waiting', { runId: 'r', phase: 'connect', sinceMs: 95000, model: 'aide-qwen3-8b:latest', note });
  A.eq(waitNoteText(n), 'waiting for 1:35 · ' + note + ' — aide-qwen3-8b:latest', 'the note follows the duration; the model trails');
  n = foldWaitNote(n, 'agent.waiting', { runId: 'r', phase: 'streaming', sinceMs: 110000, model: 'aide-qwen3-8b:latest' });
  A.eq(waitNoteText(n), 'waiting for 1:50 (stream open) on aide-qwen3-8b:latest', 'a beat without a note shows none (never carried over)');
  A.eq(foldWaitNote(null, 'agent.waiting', { phase: 'connect', sinceMs: 1, note: 'n'.repeat(500) }).note.length, 240, 'the note is bounded');
}
const longModel = 'x'.repeat(80);
A.ok(waitNoteText(run([['agent.waiting', { phase: 'first_byte', sinceMs: 15000, model: longModel }]])).length < 80, 'a very long model id is clipped');
/* FACTS FIRST (live browser proof 2026-09-24: the 520 px panel clipped every retry reason; 300 px showed only the model).
   Every line with numbers leads with them and ends on the model; no line ends in the clip-lookalike "…". */
for (const [evs, lead] of [
  [[['provider.retry', { attempt: 3, maxAttempts: 6, reason: 'overloaded', delayMs: 30000, model: 'anthropic/claude-sonnet-4.6' }]], 'retry 3/6 in 30s (overloaded)'],
  [[['agent.waiting', { phase: 'first_byte', sinceMs: 35000, model: 'anthropic/claude-sonnet-4.6' }]], 'waiting for 35s'],
  [[['agent.waiting', { phase: 'connect', sinceMs: 15000, model: 'anthropic/claude-sonnet-4.6' }]], 'connecting for 15s'],
  [[['agent.waiting', { phase: 'retry_backoff', sinceMs: 30000, model: 'anthropic/claude-sonnet-4.6' }]], 'retry backoff, 30s so far']
]) {
  const line = waitNoteText(run(evs));
  A.ok(line.startsWith(lead) && line.endsWith(' claude-sonnet-4.6') && !line.includes('anthropic/'), 'facts lead, the bare model id trails: ' + line);
  A.ok(!/…$/.test(line), 'no trailing ellipsis (it reads as a clip): ' + line);
}

/* ---------- 3. wiring (source lock) ---------- */
const rp = A.fnBody(src, 'function renderPresence(');
A.ok(/presenceCurTool\s*\?\s*shortName\(presenceCurTool\)\s*:\s*waitNoteText\(presenceWaitNote\(\)\)/.test(rp),
  'the presence card .cp-tool slot shows the running tool, else the wait line');
A.ok(/paused[\s\S]*waitNoteText/.test(rp), 'an approval pause still outranks the wait line');
A.ok(/classList\.toggle\('wait-note',\s*!presenceCurTool\s*&&\s*!!t\)/.test(rp), 'the wait line (never a tool name) takes the wrapping .wait-note class');
A.ok(/paused-note'\);\s*tool\.classList\.remove\('wait-note'\)/.test(rp), 'a pause drops .wait-note');
const ptl = A.fnBody(src, 'function paintToolLine(');
A.ok(/paintToolLine\(tool, t, presenceCurTool \? null : presenceWaitNote\(\)\)/.test(rp) && /waitModelLabel\(note\)/.test(ptl) && /className = 'cp-model'/.test(ptl),
  'the model id is drawn as one .cp-model token (never broken at a hyphen); a tool name stays plain text');
A.eq(lib.waitModelLabel({ model: 'meta-llama/llama-3.3-70b' }), 'llama-3.3-70b', 'vendor path dropped');
A.eq(lib.waitModelLabel({ model: 'qwen3:8b' }), 'qwen3:8b', 'a bare id is kept as is');
A.eq(lib.waitModelLabel({}), 'the model', 'no model -> "the model"');
const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'comms.css'), 'utf8');
A.ok(/#comms-presence \.cp-tool\.wait-note\s*\{[^}]*white-space:\s*normal/.test(css), 'comms.css: the wait line wraps instead of clipping its numbers');
A.ok(/\.cp-tool\.wait-note \.cp-model\s*\{[^}]*white-space:\s*nowrap[^}]*\}/.test(css) || /\.cp-tool\.wait-note \.cp-model\s*\{[\s\S]*?white-space:\s*nowrap/.test(css), 'comms.css: the model token never breaks mid-id');
// the wait line's OWN ROW (Andrew 10-31: in a narrow COMMS it sat in the gap between WORKING and the timer and stacked a word or
// two a line). A card showing a wait line wraps; the line takes the whole second row; a tool name stays inline.
A.ok(/#comms-presence:has\(> \.cp-tool\.wait-note\) \{ flex-wrap: wrap;/.test(css), 'comms.css: a card with a wait line wraps onto a second row');
A.ok(/#comms-presence > \.cp-tool\.wait-note \{ order: 3; flex: 1 0 100%; \}/.test(css), 'comms.css: the wait line comes after the time and spans the whole row');
A.ok(/#comms-presence > \.cp-tool\.wait-note::before \{ content: none; \}/.test(css), 'comms.css: on its own row the line drops the inline "· " lead');
A.ok(!/#comms-presence:not\(\.resolved\)? ?\{[^}]*flex-wrap: wrap/.test(css), 'comms.css: only a card WITH a wait line wraps (a running tool name stays on the verb\'s row)');
const pip = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'pipglass.css'), 'utf8');
A.ok(/#comms-presence:not\(\.resolved\) > \.cp-tool\.wait-note \{ padding-left: 62px; \}/.test(pip), 'pipglass.css: in glass the row starts under WORKING (the 52px meter + the 10px gap)');
A.ok(/#comms-presence:not\(\.resolved\),[\s\S]{0,140}?\{[^}]*gap: 10px;/.test(pip) && /#comms-presence:not\(\.resolved\) \.cp-dot,[\s\S]{0,140}?\{[^}]*flex: 0 0 52px;/.test(pip), '…which is where the meter (52px) and the card gap (10px) put WORKING');
const pw = A.fnBody(src, 'function presenceWaitNote(');
A.ok(/Channels\.runIdOf\(activeWs\.id\)/.test(pw), 'the line is keyed to the DISPLAYED stream\'s confirmed run id');
const ww = A.fnBody(src, 'function wireWaitNotes(');
for (const ev of ['provider.retry', 'agent.waiting', 'agent.token', 'agent.tool_call', 'agent.tool_result', 'provider.fallback', 'agent.run.end', 'agent.run.error']) {
  A.ok(ww.indexOf("'" + ev + "'") >= 0, 'wireWaitNotes listens for ' + ev);
}
A.ok(/U\.bus\.on\(/.test(ww) && /waitWired/.test(ww), 'subscribes on U.bus exactly once');
A.ok(/shown\s*===\s*rid\)\s*renderPresence\(\)/.test(ww), 'only the displayed run redraws the card');
A.ok(/waitNotes\.size\s*>\s*24/.test(ww), 'the per-run note map is bounded');
A.ok(/wireWaitNotes\(\);/.test(src.replace(/function wireWaitNotes\(/, '')), 'wireWaitNotes() is called at COMMS init');
A.ok(!/Date\.now\(\)/.test(A.fnBody(src, 'function waitNoteText(')) && !/Date\.now\(\)/.test(A.fnBody(src, 'function foldWaitNote(')),
  'no local clock: the line never extrapolates beyond what the events said');

A.report('comms-wait-line');
