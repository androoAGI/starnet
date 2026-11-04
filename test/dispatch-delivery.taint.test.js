/* node test/dispatch-delivery.taint.test.js — attachment-rows-and-taint repair: EVERY DURABLE ROW A RUN WRITES CARRIES THE ROW STAMP, AND
   THE ACCEPTED ANSWER OF A DISPATCHED WORKER IS ONE OF THEM.

   THE FAMILY. The bare attachment stamp is the one stamp that decays on replay, so it must never hide a later source: a run that held
   the attachment and then read a page or the saved file stamps what it writes with the FIRST source that is not the bare attachment
   (execution.rowTaint), and taintedBy stays the first source (the refusal wording, the relay to a lead). The transcript rows, the journal
   and a worker's inherited latch were moved to rowTaint. The run RECORD kept the first source, and a dispatched worker's accepted answer
   (the only replayable row of its run: dispatch-delivery.js finalizeDispatchDelivery, written after the run ended) was stamped from
   that record. A worker that inherited the lead's bare latch and then read the saved file or a page had its own rows stamped 'fs.read',
   but the row that is replayed, quoted by the earlier-conversation note and handed on by the delivery carried the bare attachment, which
   decays, so a later run replayed what it said unlatched.

   INVARIANT run-rows-carry-the-row-stamp.
     behaviour  through the real run store, transcript store and finalizeDispatchDelivery, with the record fields taken from the
                production source: attachment then fs.read -> the accepted answer carries 'fs.read', the earlier-conversation note and
                the store's replay latch it, and the record still says the FIRST source (OPEN 3 is unchanged); attachment only -> the bare
                stamp (and a record with no extra field); a page first -> that page; a clean worker -> no stamp; a repair run's source; a
                record from before this change -> its taintedBy
     lint       no transcript write in any sidecar module stamps from a taint it names as a FIRST source (.taintedBy) without the row
                stamp beside it (rowTaint / rowTaintedBy), and every run record that records the first source records the row stamp too

   Every behavioural leg of the attachment-then-read case, and the lint, fail on the tree before this repair. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const { makeRunStore } = require('../sidecar/runstore.js');
const { finalizeDispatchDelivery } = require('../sidecar/dispatch-delivery.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const History = require('../sidecar/transcript-history.js');
const EarlierConversation = require('../sidecar/earlier-conversation.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
const { makeRunTranscript } = require('../sidecar/transcript-run.js');
const TurnKinds = require('../frontend/app/turnkinds.js');
const { ATTACHMENT_TAINT: UA } = require('../sidecar/taint.js');
const { readSidecarSource, sidecarSourceFiles } = require('./helpers/source.js');

const idx = readSidecarSource();
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));

// the fields index.js files on a run record for what the run latched, taken from the production source and run over a real execution state
const recordFields = (() => {
  const m = /steerNotes: steerBufs\.ledgerOf\(runId\),(?: wordless: [^,]+,)? (taintedBy: execution\.taintedBy\(\) \|\| ''[^;]*?) \}\);/.exec(idx);
  if (!m) { A.ok(false, 'the run record call in index.js was found (its taint fields could not be read from the source)'); return () => ({}); }
  return execution => new Function('execution', 'return {' + m[1] + '};')(execution);
})();

function station() {
  const lines = [];
  const runIo = { readAll: () => lines.map(clone), append: row => { lines.push(clone(row)); } };
  let clk = 1000;
  const clock = { now: () => ++clk };
  const runStore = makeRunStore({ io: runIo, clock });
  const transcriptStore = makeTranscriptStore({ io: History.makeMemoryTranscriptIo(), clock });
  return { runStore, transcriptStore, lines, deps: { runStore, transcriptStore, redact: t => t, hash } };
}
/* A worker the lead dispatched into a child session: it starts with the lead's latch (initial), writes the brief (a lead's text, the
   lead's stamp), reads (latches `reads`, in order) and answers; its run record is filed the way index.js files it, then the accepted
   answer is finalized. Returns what a later run would meet. */
function dispatchRun(s, runId, o) {
  const execution = makeRunExecutionState({ initialTaint: o.initial || null });
  const turnId = TurnKinds.runTurnId(runId);
  const rt = makeRunTranscript({ store: s.transcriptStore, streamId: 'child', agentId: 'worker', runId, from: 'lead', dispatchState: 'pending', turnId: () => turnId, stamp: true,
    taint: () => execution.rowTaint() });
  const prompt = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'summarise the attached PDF' }];
  s.transcriptStore.markPersisted(prompt);
  rt.setDirective('summarise the attached PDF');
  rt.start(prompt);
  for (const source of (o.reads || [])) { execution.latchTaint(source); prompt.push({ role: 'assistant', content: 'read ' + source }); rt.drain(prompt); }
  prompt.push({ role: 'assistant', content: 'FINAL ANSWER ' + runId }); rt.drain(prompt);
  s.runStore.record(Object.assign({ runId, streamId: 'child', agentId: 'worker', reason: 'done', startedAt: 1, endedAt: 2, delegatedBy: 'lead', deliveryPrompt: 'summarise the attached PDF', dispatchDelivery: { state: 'pending' } },
    o.record === undefined ? recordFields(execution) : o.record, o.repairOf ? { repairRunId: o.repairOf } : {}));
  const done = finalizeDispatchDelivery(s.deps, runId, { text: 'FINAL ANSWER ' + runId, reason: 'done', repairRunId: o.repairOf || '' });
  const rows = s.transcriptStore.view('proof', 'child').filter(r => r.sourceRunId === runId);
  const final = rows.find(r => r.dispatchState === 'final');
  const replay = s.transcriptStore.view('model-replay', 'child', { limit: 200, shape: 'pairs', rows: true }).filter(r => r.sourceRunId === runId);
  return { execution, rows, final, replay, record: s.runStore.latest(runId), done };
}

// ---- 1. THE FINDING: the worker held the lead's attachment and then read the saved file ----
{
  const s = station();
  const r = dispatchRun(s, 'w1', { initial: UA, reads: ['fs.read'] });
  A.eq([r.execution.taintedBy(), r.execution.rowTaint()], [UA, 'fs.read'], 'fixture: the first source is the attachment, the row stamp is the read');
  A.eq(r.rows.filter(x => x.dispatchState === 'pending' && x.role === 'assistant').map(x => x.taint), ['fs.read', 'fs.read'], 'fixture: the run\'s own rows are stamped with the read');
  A.eq(r.final && r.final.taint, 'fs.read', 'the accepted answer carries the read, not the bare attachment the lead handed down');
  A.eq([r.record.taintedBy, r.record.rowTaintedBy], [UA, 'fs.read'], 'the run record keeps the FIRST source for the relay (OPEN 3 is unchanged) and records the row stamp beside it');
  A.eq(r.replay.map(x => x.role + ':' + (x.taint || '')), ['user:' + UA, 'assistant:fs.read'], 'what a later run replays from the child session: the brief (the lead\'s text, bare) and the accepted answer (the read)');
  A.eq(EarlierConversation.taintOf(r.replay), 'fs.read', 'the earlier-conversation note over them latches the read');
  A.eq(s.transcriptStore.taintOf('child', [{ role: 'assistant', content: 'FINAL ANSWER w1' }]), 'fs.read', 'and so does the store\'s replay proof');
}

// ---- 2. the other shapes ----
{
  const s = station();
  const only = dispatchRun(s, 'w2', { initial: UA });
  A.eq([only.final.taint, only.record.taintedBy, only.record.rowTaintedBy, 'rowTaintedBy' in only.record], [UA, UA, undefined, false], 'attachment only: the answer carries the bare stamp (which decays), and the record gains no field');
  A.eq(EarlierConversation.taintOf(only.replay), null, 'and replays clean');
  const page = dispatchRun(s, 'w3', { reads: ['web_fetch', 'fs.read'] });
  A.eq([page.final.taint, page.record.taintedBy, 'rowTaintedBy' in page.record], ['web_fetch', 'web_fetch', false], 'a page first: the first source is the page everywhere, and the record gains no field');
  const pageThenFile = dispatchRun(s, 'w4', { initial: 'web_fetch', reads: ['fs.read'] });
  A.eq([pageThenFile.final.taint, pageThenFile.record.taintedBy], ['web_fetch', 'web_fetch'], 'a source other than the attachment first stays first');
  const clean = dispatchRun(s, 'w5', {});
  A.eq([clean.final.taint, clean.record.taintedBy, 'rowTaintedBy' in clean.record], [undefined, undefined, false], 'a clean worker is stamped with nothing');
  const legacy = dispatchRun(s, 'w6', { reads: ['fs.read'], record: { taintedBy: 'web_fetch' } });
  A.eq(legacy.final.taint, 'web_fetch', 'a record from before this change (only the first source) is stamped with it, as before');
  const hostile = dispatchRun(s, 'w7', { initial: UA, reads: ['fs.read'], record: { taintedBy: UA, rowTaintedBy: 'fs.read\n' + 'x'.repeat(400) } });
  A.ok(typeof hostile.record.rowTaintedBy === 'string' && hostile.record.rowTaintedBy.length <= 200 && hostile.record.rowTaintedBy.indexOf('\n') < 0, 'the row stamp on a record is one bounded line, like the first source');
  // a repair run (the structured-result repair the dispatch accepted) that read something: its row stamp is the answer's
  s.runStore.record({ runId: 'rep1', streamId: 'child', agentId: 'worker', reason: 'done', dispatchDelivery: { state: 'internal' }, taintedBy: UA, rowTaintedBy: 'web_fetch' });
  const viaRepair = dispatchRun(s, 'w8', { initial: null, reads: [], repairOf: 'rep1' });
  A.eq(viaRepair.final.taint, 'web_fetch', 'a clean original answered through a repair run that read a page carries the repair\'s row stamp');
}

// ---- 3. THE LINT: no write stamps from a first source alone ----
{
  const CALL = /\btranscriptStore\.(?:append|appendStrict|appendNew|appendNewStrict)\(|\b[A-Za-z_$][\w$]*\.(?:appendStrict|appendNew|appendNewStrict)\(/g;
  const balanced = (source, at) => {   // the text of one balanced group starting at the opening bracket `at`, strings skipped
    let depth = 0, quote = '', i = at;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') { if (--depth === 0) break; }
    }
    return source.slice(at, i + 1);
  };
  const stampOf = call => {   // the expression after `taint:` up to the next comma at the call's own depth
    const m = /\btaint\s*:\s*/.exec(call);
    if (!m) return '';
    let depth = 0, quote = '', i = m.index + m[0].length;
    const start = i;
    for (; i < call.length; i++) {
      const ch = call[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '}') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
    }
    return call.slice(start, i);
  };
  const ROW_STAMP = /\browTaint\(|\browTaintedBy\b/;
  // known, reasoned exceptions: the stamp is a label built around a first source, never the bare attachment string
  const ALLOWED = [{ file: 'sidecar/index.js', snippet: "'away briefing quoting ' + String(quoted.taintedBy)", why: 'a briefing that quotes a tainted run is stamped with a prefixed label, which never equals the decaying constant' }];
  const probe = "x.appendStrict({ a: 1, taint: source.taintedBy || undefined, b: 2 });\ntranscriptStore.append({ taint: execution.rowTaint() || null, c: 3 });\ny.appendNew(m, { taint: s.rowTaintedBy || s.taintedBy, d: 4 });";
  const calls = src => [...src.matchAll(CALL)].map(m => balanced(src, m.index + m[0].length - 1));
  const flagged = src => calls(src).filter(c => /\.taintedBy\b/.test(stampOf(c)) && !ROW_STAMP.test(stampOf(c)));
  A.eq([calls(probe).length, flagged(probe).length], [3, 1], 'scanner: finds every write, flags only the one that names a first source with no row stamp');
  const reached = new Set(), offenders = [];
  for (const { rel, text: src } of sidecarSourceFiles()) {
    if (calls(src).length) reached.add(rel);
    for (const c of flagged(src)) {
      if (ALLOWED.some(a => a.file === rel && c.indexOf(a.snippet) >= 0)) continue;
      offenders.push(rel + ': ' + c.replace(/\s+/g, ' ').slice(0, 140));
    }
  }
  A.ok(['sidecar/index.js', 'sidecar/dispatch-delivery.js', 'sidecar/transcript-run.js', 'sidecar/turn-attachment.js'].every(f => reached.has(f)), 'the scan reaches every known writer: ' + [...reached].join(', '));
  A.eq(offenders, [], 'no transcript write in any sidecar module stamps from a first source (.taintedBy) without the row stamp beside it');
  // the record that holds the first source holds the row stamp too (a reader of the record must be able to stamp what it writes)
  const recordCalls = [...idx.matchAll(/runStore\.record\(/g)].map(m => balanced(idx, m.index + m[0].length - 1)).filter(c => /\btaintedBy\s*:/.test(c));
  A.ok(recordCalls.length >= 1 && recordCalls.every(c => /\browTaintedBy\s*:\s*execution\.rowTaint\(\)/.test(c)), 'every run record that records the first source also records the row stamp (execution.rowTaint())');
  A.ok(/taint: source\.rowTaintedBy \|\| source\.taintedBy \|\| \(repair && \(repair\.rowTaintedBy \|\| repair\.taintedBy\)\) \|\| undefined/.test(sidecarSourceFiles().find(f => f.rel === 'sidecar/dispatch-delivery.js').text), 'dispatch-delivery stamps the accepted answer with the record\'s row stamp first, the first source for a record that has none');
}

A.report('dispatch-delivery.taint');
