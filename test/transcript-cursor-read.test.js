'use strict';
/* node test/transcript-cursor-read.test.js — INVARIANT cursor-complete-read (save-history-by-reference, step S1).

   A saved history will name its rows by id, so the station has to hand back (a) every row of a stream after a row the
   page already holds, however long the stream, and (b) exactly the rows the page names. The display read cannot: it
   returns the newest `limit` rows and the route clamps that to 500, so rows 0..699 of a 1,200-row stream are
   unreachable. Over the REAL transcript store and the REAL segmented io (a temp dir, small segments so a stream spans
   many files, segment reads counted like transcript-view.bounds.test.js):
     · pages of 500 by after-rowId return every live row exactly once, in rowId order (1,200 durable rows = three pages),
       and their concatenation is the display view of the whole stream, field for field;
     · a retracted row (undone by a retract row on another page), a hidden kind, an internal line, another stream's
       row, a deleted session's row and a live run's row are never returned by either read, and the cursor never
       passes a live run's row;
     · a dispatch run cut by a page boundary projects as it does in the whole stream;
     · rows by id come back in the order asked, never from another stream, and every id not returned is named as
       missing, retracted or forgotten; a request touches at most eight segments and asking again for the missing
       ids goes on;
     · a view that cannot be vouched for throws TRANSCRIPT_UNVOUCHED instead of answering short or empty. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js'), Dual = require('../sidecar/turn-dual.js');

const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'transcript-cursor-read-'));
if (path.dirname(path.resolve(root)) !== temp) throw new Error('fixture directory escaped its temporary parent');
const opened = [], reads = [], warnings = [], tracked = Object.create(fs);
tracked.readFileSync = (file, ...args) => { if (/segment-\d+\.jsonl$/.test(String(file))) reads.push(path.basename(String(file))); return fs.readFileSync(file, ...args); };
const open = (name, segmentBytes) => {
  const io = History.makeSegmentedTranscriptIo({ fs: tracked, path, root: path.join(root, name), segmentBytes, schedule() {}, onWarning: text => warnings.push(text) });
  opened.push(io); return io;
};
const segmentsOf = io => JSON.parse(fs.readFileSync(io._internals.manifestFile, 'utf8')).segments.length;
const DELETE_AT = 5000000;
const live = new Set();
const storeOver = io => Store.makeTranscriptStore({ io, live, deletedAt: sid => sid === 'gone' ? DELETE_AT : 0 });
const ids = rows => rows.map(r => r.rowId);
const throwsCode = (fn, code, msg) => { let failure; try { fn(); } catch (error) { failure = error; } A.eq(failure && failure.code, code, msg); };
const readOn = (readPage, size) => { const out = []; for (let at = 0, guard = 0; guard < 1000; guard++) { const page = readPage(at, size); out.push(...page.rows); at = page.last; if (!page.more) break; } return out; };

try {
  // ---- the stream: exactly 1,200 durable rows over several 64 KB segments, beside another stream's rows ----------------------
  let ts = 1000000;
  const seed = open('main', 65536);
  const s1 = [], wantLive = [], undoneIds = [], retriedIds = [];
  const put = (extra, stream) => {
    const row = seed.appendDurable(Object.assign({ streamId: stream || 's1', agentId: 'agent', role: 'user', kind: 'turn', taintKnown: true, ts: ++ts }, extra));
    if (!stream) s1.push(row);
    return row;
  };
  const retract = (target, reason) => {   // the oracle: an undone row is not shown, a retried one still is
    put({ role: 'system', kind: 'retract', targets: [target], reason, content: '' });
    if (reason === 'undo') { wantLive.splice(wantLive.indexOf(target), 1); undoneIds.push(target); } else retriedIds.push(target);
  };
  let internal, capture, station, farTarget;
  for (let i = 0; s1.length < 1200; i++) {
    if (i % 7 === 3) put({ content: 'OTHER_STREAM_' + i + ' ' + 'o'.repeat(40) }, 's2');
    if (i % 50 === 49) { const row = put({ role: 'assistant', kind: 'station', content: 'HIDDEN_STATION_' + i }); station = station || row; continue; }
    if (i === 600) { internal = put({ role: 'assistant', dispatchState: 'internal', content: 'INTERNAL_SENTINEL' }); continue; }
    if (i === 601) { capture = put({ role: 'user', kind: 'capture', content: 'CAPTURE_SENTINEL' }); continue; }
    if (i === 120 || i === 330 || i === 780) { retract(wantLive[wantLive.length - 1], 'undo'); continue; }
    if (i === 400) { retract(wantLive[wantLive.length - 1], 'retry'); continue; }
    // a retract row sits on a later page than its target: this undo (page three) names a row of page one
    if (i === 1130) { farTarget = wantLive[10]; retract(farTarget, 'undo'); continue; }
    const row = put({ role: i % 2 ? 'assistant' : 'user', content: 'row ' + i + ' ' + 'x'.repeat(60) });
    wantLive.push(row.rowId);
  }
  const s2 = [put({ content: 'OTHER_STREAM_ROW' }, 's2'), put({ content: 'OTHER_STREAM_ROW_2' }, 's2')];
  const segmentCount = (seed.close(), segmentsOf(seed));
  A.eq(s1.length, 1200, 'the stream has exactly 1,200 durable rows');
  A.eq([undoneIds.length, retriedIds.length], [4, 1], 'the fixture undoes four rows (one of them from page three) and retries one');
  A.ok(segmentCount >= 3, 'the stream spans several closed segments (' + segmentCount + ')');

  // ---- cold, so every segment read is counted ------------------------------------------------------------------------------
  const io = open('main', 65536), store = storeOver(io);
  A.eq(typeof store.pageAfter, 'function', 'the store reads a stream forward from a cursor (pageAfter)');
  A.eq(typeof store.rowsByIds, 'function', 'the store reads the rows a page names (rowsByIds)');
  if (typeof store.pageAfter !== 'function' || typeof store.rowsByIds !== 'function') throw new Error('the store has no cursor or by-id read');

  const whole = store.view('display', 's1', { limit: 5000 });
  A.eq(ids(whole), wantLive, 'the whole-stream display view is the oracle: exactly the live rows');
  const newest500 = store.view('display', 's1', { limit: 500 });
  A.ok(newest500[0].rowId > wantLive[0], 'the display read reaches only the newest 500: the oldest rows need a cursor');

  const pages = [];
  for (let after = 0, guard = 0; guard < 10; guard++) {
    reads.length = 0;
    const page = store.pageAfter('s1', after, 500);
    pages.push(Object.assign({ reads: reads.length }, page)); after = page.last;
    if (!page.more) break;
  }
  A.eq(pages.length, 3, '1,200 durable rows read by pages of 500 are three pages');
  A.eq(pages.map(p => p.last), [s1[499].rowId, s1[999].rowId, s1[1199].rowId], 'each page ends at the last durable row of its window');
  A.eq(pages.map(p => p.more), [true, true, false], 'more is true until the last window');
  A.eq(pages.flatMap(p => ids(p.rows)), wantLive, 'every live row exactly once, in rowId order');
  A.ok(pages.every(p => p.rows.length <= 500), 'a page never exceeds its limit');
  A.eq(pages.flatMap(p => p.rows), whole, 'the pages are the whole-stream display view, field for field');
  A.ok(pages.every(p => p.reads <= 9), 'a page reads at most eight segments plus the active segment for its retract context: ' + pages.map(p => p.reads));
  const everyReply = JSON.stringify(pages);
  for (const secret of ['HIDDEN_STATION_', 'OTHER_STREAM_', 'INTERNAL_SENTINEL', 'CAPTURE_SENTINEL']) A.ok(!everyReply.includes(secret), 'a cursor page never carries ' + secret);
  A.ok(pages[0].rows.length > 0 && !ids(pages[0].rows).includes(farTarget), 'a row undone by a retract row on page three is not on page one');
  A.ok(undoneIds.every(id => !pages.flatMap(p => ids(p.rows)).includes(id)), 'no undone row is on any page');
  A.ok(retriedIds.every(id => pages.flatMap(p => ids(p.rows)).includes(id)), 'a retried row (not undone) is still shown, as in the display view');

  // a cursor in the middle, near the tail, at the end, past the end, and on a stream with no rows
  const mid = store.pageAfter('s1', s1[600].rowId, 500);
  A.eq(ids(mid.rows), wantLive.filter(id => id > s1[600].rowId && id <= s1[1100].rowId), 'a mid-stream cursor returns only later rows');
  A.eq([mid.last, mid.more], [s1[1100].rowId, true], 'a mid-stream page stops 500 durable rows on');
  reads.length = 0;
  const tail = store.pageAfter('s1', s1[1150].rowId, 500);
  A.ok(reads.length <= 3 && reads.length < segmentCount, 'a cursor near the tail never reads the older segments (' + reads.length + ' of ' + segmentCount + ')');
  A.eq(ids(tail.rows), wantLive.filter(id => id > s1[1150].rowId), 'a tail cursor returns the rest');
  A.eq(tail.more, false, 'the last window has no more');
  const end = store.pageAfter('s1', s1[1199].rowId, 500);
  A.eq([end.rows, end.last, end.more], [[], s1[1199].rowId, false], 'a cursor at the newest row answers empty and stays put');
  const past = store.pageAfter('s1', 999999999, 10);
  A.eq([past.rows, past.last, past.more], [[], 999999999, false], 'a cursor past the end answers empty and stays put');
  A.eq(store.pageAfter('nobody', 0, 10), { rows: [], last: 0, more: false }, 'a stream with no rows answers empty');
  A.eq(ids(readOn((at, size) => store.pageAfter('s1', at, size), 7)), wantLive, 'pages of seven (hundreds of calls) still return every live row exactly once');
  A.eq(store.pageAfter('s1', 0, 100000).last, s1[499].rowId, 'a limit past 500 clamps at 500');
  A.eq(store.pageAfter('s1', 0).last, s1[199].rowId, 'no limit means the default 200');
  for (const bad of [-1, 1.5, '5', null, undefined, NaN]) throwsCode(() => store.pageAfter('s1', bad, 10), 'TRANSCRIPT_BAD_REQUEST', 'a cursor of ' + String(bad) + ' is refused');

  // ---- rows by id ---------------------------------------------------------------------------------------------------------
  const liveSpread = wantLive.filter((_, i) => i % 19 === 0);
  const asked = liveSpread.slice().reverse().concat([station.rowId, undoneIds[0], s2[0].rowId, 999999999, liveSpread[3], internal.rowId, capture.rowId, wantLive[500]]);
  reads.length = 0;
  const got = store.rowsByIds('s1', asked);
  const byId = new Map(whole.map(r => [r.rowId, r]));
  A.eq(ids(got.rows), Array.from(new Set(asked)).filter(id => byId.has(id)), 'the rows come back in the order asked, once each');
  A.ok(got.rows.every(r => JSON.stringify(r) === JSON.stringify(byId.get(r.rowId))), 'each row is the display view\'s row, field for field');
  A.eq(got.retracted, [undoneIds[0]], 'an undone id is named as retracted');
  A.eq(got.forgotten, [], 'nothing here is forgotten');
  A.eq(got.missing, [station.rowId, s2[0].rowId, 999999999, internal.rowId, capture.rowId], 'a hidden kind, an internal line, another stream\'s row and an unknown id are named as missing, never returned');
  const gotText = JSON.stringify(got);
  A.ok(!gotText.includes('OTHER_STREAM') && !gotText.includes('HIDDEN_STATION_') && !gotText.includes('SENTINEL'), 'no other stream\'s row and no hidden row is returned by id');
  A.ok(reads.length <= 9, 'a by-id request reads at most eight segments plus the active segment: ' + reads.length);
  A.ok(wantLive.length > 1000, 'more live rows than one by-id request may name (' + wantLive.length + ')');
  const everything = [store.rowsByIds('s1', wantLive.slice(0, 1000)), store.rowsByIds('s1', wantLive.slice(1000))];
  A.eq(everything.flatMap(part => part.rows), whole, 'asking for every live id (in requests of 1000) returns the display view');
  A.eq(everything.map(part => [part.missing, part.retracted, part.forgotten]), [[[], [], []], [[], [], []]], 'and names nothing missing');
  A.eq(store.rowsByIds('s1', []), { rows: [], missing: [], retracted: [], forgotten: [] }, 'no ids, no rows');
  const batch = store.rowsByIdsBatch([{ streamId: 's1', rowIds: [wantLive[0], s2[0].rowId] }, { streamId: 's2', rowIds: [s2[0].rowId, wantLive[0]] }]);
  A.eq([ids(batch[0].rows), batch[0].missing, ids(batch[1].rows), batch[1].missing], [[wantLive[0]], [s2[0].rowId], [s2[0].rowId], [wantLive[0]]], 'a batch answers each stream from its own rows: an id is another stream\'s row in the other');
  for (const [label, request] of [['not an array', 'x'], ['a zero id', [{ streamId: 's1', rowIds: [0] }]], ['a negative id', [{ streamId: 's1', rowIds: [-3] }]],
    ['a fractional id', [{ streamId: 's1', rowIds: [1.5] }]], ['a string id', [{ streamId: 's1', rowIds: ['7'] }]], ['no ids array', [{ streamId: 's1' }]],
    ['a bad stream id', [{ streamId: 'a b', rowIds: [1] }]], ['a numeric stream id', [{ streamId: 5, rowIds: [1] }]],
    ['more than 1000 ids', [{ streamId: 's1', rowIds: Array.from({ length: 1001 }, (_, i) => i + 1) }]],
    ['more than 1000 ids across streams', [{ streamId: 's1', rowIds: Array.from({ length: 600 }, (_, i) => i + 1) }, { streamId: 's2', rowIds: Array.from({ length: 600 }, (_, i) => i + 601) }]],
    ['more than 50 streams', Array.from({ length: 51 }, () => ({ streamId: 's1', rowIds: [1] }))]])
    throwsCode(() => store.rowsByIdsBatch(request), 'TRANSCRIPT_BAD_REQUEST', label + ' is refused');

  // ---- a deleted session is forgotten by both reads; a re-opened one shows only what is said after the delete ------------------
  const seedGone = open('gone', 65536);
  const goneOld = [1, 2, 3].map(i => seedGone.appendDurable({ streamId: 'gone', agentId: 'agent', role: 'user', kind: 'turn', taintKnown: true, ts: DELETE_AT - 100 + i, content: 'FORGOTTEN_SENTINEL_' + i }));
  const goneNew = [1, 2].map(i => seedGone.appendDurable({ streamId: 'gone', agentId: 'agent', role: 'assistant', kind: 'turn', taintKnown: true, ts: DELETE_AT + 100 + i, content: 'AFTER_DELETE_' + i }));
  seedGone.close();
  const goneStore = storeOver(open('gone', 65536));
  const gonePage = goneStore.pageAfter('gone', 0, 500);
  A.eq(gonePage.rows.map(r => r.content), ['AFTER_DELETE_1', 'AFTER_DELETE_2'], 'a deleted session\'s old rows are not on a cursor page; what is said after the delete is');
  A.eq(gonePage.last, goneNew[1].rowId, 'the cursor passes the forgotten rows');
  const goneRows = goneStore.rowsByIds('gone', ids(goneOld).concat(ids(goneNew)));
  A.eq([ids(goneRows.rows), goneRows.forgotten, goneRows.missing], [ids(goneNew), ids(goneOld), []], 'by id, the old rows are named forgotten and never returned');
  A.ok(!JSON.stringify([gonePage, goneRows]).includes('FORGOTTEN_SENTINEL'), 'no forgotten word leaves the store');

  // ---- a row that QUOTES a deleted session is forgotten, not missing: the packed-row sort of the by-id reads counts the quote term (4b-2) ----
  const seedQuote = open('quoter', 65536);
  const quoteRows = [
    { content: 'QUOTING_ROW', quotes: ['gone'], quotesAt: [DELETE_AT - 50], ts: DELETE_AT + 10 },
    { content: 'PLAIN_ROW', ts: DELETE_AT + 11 },
    { content: 'LATER_READ_ROW', quotes: ['gone'], quotesAt: [DELETE_AT + 500], ts: DELETE_AT + 12 }
  ].map(extra => seedQuote.appendDurable(Object.assign({ streamId: 'quoter', agentId: 'agent', role: 'assistant', kind: 'turn', taintKnown: true }, extra)));
  seedQuote.close();
  const quoteStore = storeOver(open('quoter', 65536));
  const quoteWant = ids(quoteRows);
  const byQuote = quoteStore.rowsByIds('quoter', quoteWant);
  A.eq([ids(byQuote.rows), byQuote.forgotten, byQuote.missing], [[quoteRows[1].rowId, quoteRows[2].rowId], [quoteRows[0].rowId], []], 'by id, a row that quotes a session deleted after the read is named forgotten (not missing), and one whose read began after the delete is the page\'s own');
  const byQuoteBatch = quoteStore.rowsByIdsBatch([{ streamId: 'quoter', rowIds: quoteWant }]);
  A.eq([byQuoteBatch[0].forgotten, byQuoteBatch[0].missing], [[quoteRows[0].rowId], []], 'the batch read sorts the same way: a packed row whose session was quote-read and then deleted comes back in forgotten, so the chat is not stuck as history-unavailable');
  A.ok(!JSON.stringify([byQuote, byQuoteBatch]).includes('QUOTING_ROW'), 'no quoting word leaves the store');

  // ---- a run still writing is not visible, and the cursor never passes it -----------------------------------------------------
  const seedRun = open('run', 65536);
  const runRows = [['a', 'done-run', 'user'], ['b1', 'live1', 'user'], ['b2', 'live1', 'assistant'], ['c', 'done-run', 'assistant']].map(([label, runId, role], i) =>
    seedRun.appendDurable({ streamId: 'run', agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: 2000 + i, sourceRunId: runId, content: 'LIVE_ROW_' + label }));
  seedRun.close();
  const runStore = storeOver(open('run', 65536));
  live.add('live1');
  const during = runStore.pageAfter('run', 0, 500);
  A.eq([during.rows.map(r => r.content), during.last, during.more], [['LIVE_ROW_a'], runRows[0].rowId, false], 'while a run writes, the page stops before its first row and the cursor stays before it');
  A.eq(runStore.rowsByIds('run', ids(runRows)).missing, [runRows[1].rowId, runRows[2].rowId], 'by id, a live run\'s rows are missing (not provably gone) while it writes');
  live.delete('live1');
  const finished = runStore.pageAfter('run', during.last, 500);
  A.eq([finished.rows.map(r => r.content), finished.last, finished.more], [['LIVE_ROW_b1', 'LIVE_ROW_b2', 'LIVE_ROW_c'], runRows[3].rowId, false], 'once it ends, reading on from the cursor returns the run\'s rows exactly once');
  A.eq(ids(runStore.rowsByIds('run', ids(runRows)).rows), ids(runRows), 'and by id they are returned');

  // ---- a dispatch run cut by a page boundary projects as it does in the whole stream -------------------------------------------
  const seedDsp = open('dispatch', 65536);
  const dsp = [
    { role: 'user', sourceRunId: 'dr1', dispatchState: 'pending', content: 'RAW_PROMPT' },
    { role: 'assistant', sourceRunId: 'dr1', dispatchState: 'pending', content: 'EXEC_SENTINEL' },
    { role: 'assistant', sourceRunId: 'dr1', dispatchState: 'final', content: 'FINAL_ANSWER', dispatchPrompt: 'PROMPT_FOR_DISPLAY' },
    { role: 'user', content: 'AFTER_THE_RUN' }
  ].map((extra, i) => seedDsp.appendDurable(Object.assign({ streamId: 'dsp', agentId: 'agent', kind: 'turn', taintKnown: true, ts: 3000 + i }, extra)));
  seedDsp.close();
  const dspStore = storeOver(open('dispatch', 65536));
  const dspWhole = dspStore.view('display', 'dsp', { limit: 100 });
  A.eq(dspWhole.map(r => r.content), ['PROMPT_FOR_DISPLAY', 'FINAL_ANSWER', 'AFTER_THE_RUN'], 'the whole stream shows the prompt as the Commander sees it and the accepted final, not the execution rows');
  for (const size of [1, 2, 3, 4]) A.eq(readOn((at, n) => dspStore.pageAfter('dsp', at, n), size), dspWhole, 'pages of ' + size + ' cut through the dispatch run and still equal the whole-stream view');
  const dspById = dspStore.rowsByIds('dsp', ids(dsp));
  A.eq([dspById.rows, dspById.missing], [dspWhole, [dsp[1].rowId]], 'by id the prompt and the final are shown as in the stream and the execution row is not returned');
  A.ok(!JSON.stringify([dspById, dspStore.pageAfter('dsp', 0, 1)]).includes('EXEC_SENTINEL'), 'an execution row never leaves the store');

  // a request loads the context of at most 16 runs: a page ends early and a by-id read names the rest missing, so a row is
  // never shown with less of its run than the whole stream gives it; asking again goes on
  const seedRuns = open('runs20', 65536);
  const runs20 = [];
  for (let r = 0; r < 20; r++) for (const [role, state, content] of [['user', 'pending', 'RAW_' + r], ['assistant', 'pending', 'EXEC_' + r], ['assistant', 'final', 'FINAL_' + r]])
    runs20.push(seedRuns.appendDurable({ streamId: 'runs20', agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: 6000 + runs20.length, sourceRunId: 'run-' + r,
      dispatchState: state, content, dispatchPrompt: 'PROMPT_' + r }));
  seedRuns.close();
  const runsStore = storeOver(open('runs20', 65536));
  const runsWhole = runsStore.view('display', 'runs20', { limit: 500 });
  A.eq(runsWhole.length, 40, 'twenty dispatch runs show a prompt and a final each');
  const runsFirst = runsStore.pageAfter('runs20', 0, 500);
  A.eq([runsFirst.rows.length, runsFirst.more, runsFirst.last], [32, true, runs20[47].rowId], 'one page loads 16 runs, ends before the 17th and says there is more');
  A.eq(readOn((at, n) => runsStore.pageAfter('runs20', at, n), 500), runsWhole, 'reading on from the cursor completes the twenty runs, exactly the whole-stream view');
  const runsAsk = runsStore.rowsByIds('runs20', ids(runs20));
  A.eq(runsAsk.rows.length, 32, 'a by-id request loads 16 runs and returns their prompts and finals');
  A.ok(runs20.slice(48).filter(r => r.dispatchState !== 'pending' || r.role === 'user').every(r => runsAsk.missing.includes(r.rowId)), 'the dispatch rows of the 17th run on are named missing, not shown without their run');
  const runsAgain = runsStore.rowsByIds('runs20', runsAsk.missing);
  A.eq(runsAsk.rows.concat(runsAgain.rows), runsWhole, 'asking again with only the missing ids returns the rest, in the whole stream\'s shape');
  A.eq(runsAgain.missing.length, 20, 'and only the twenty execution rows (never shown) stay missing');

  // a run's rows are read from its start, not from the start of the stream (the run record's time)
  const seedOld = open('dspwide', 256);
  const HOUR = 3600000, RUN_AT = 4000 + 40 * HOUR;
  for (let i = 0; i < 30; i++) seedOld.appendDurable({ streamId: 'dspwide', agentId: 'agent', role: 'user', kind: 'turn', taintKnown: true, ts: 4000 + i, content: 'old row ' + i + ' ' + 'o'.repeat(300) });
  const dspWide = [['user', 'pending', 'W_RAW'], ['assistant', 'final', 'W_FINAL']].map(([role, state, content], i) => seedOld.appendDurable({ streamId: 'dspwide', agentId: 'agent', role, kind: 'turn',
    taintKnown: true, ts: RUN_AT + i, sourceRunId: 'wide-run', dispatchState: state, content, dispatchPrompt: 'W_PROMPT' }));
  seedOld.close();
  const coldReads = hint => {
    const cold = Store.makeTranscriptStore({ io: open('dspwide', 256), live, ramPerStream: 1, runOf: hint ? () => ({ startedAt: RUN_AT }) : undefined });
    reads.length = 0;
    const answer = cold.rowsByIds('dspwide', ids(dspWide));
    return { answer, count: reads.length };
  };
  const hinted = coldReads(true), unhinted = coldReads(false);
  A.eq(hinted.answer.rows.map(r => r.content), ['W_PROMPT', 'W_FINAL'], 'a run read in a wide stream shows its prompt and final');
  A.eq(hinted.answer, unhinted.answer, 'the run record\'s start time changes what is read, never the answer');
  A.ok(hinted.count <= 9 && hinted.count < unhinted.count, 'with the run\'s start time the older segments are not read (' + hinted.count + ' reads, against ' + unhinted.count + ' without it)');

  // ---- bounded reads: a stream spread over dozens of segments --------------------------------------------------------------
  const seedWide = open('wide', 256);
  const wide = Array.from({ length: 60 }, (_, i) => seedWide.appendDurable({ streamId: 'wide', agentId: 'agent', role: i % 2 ? 'assistant' : 'user', kind: 'turn', taintKnown: true,
    ts: 4000 + i, content: 'wide row ' + i + ' ' + 'w'.repeat(300) }));
  const wideSegments = (seedWide.close(), segmentsOf(seedWide));
  const wideStore = storeOver(open('wide', 256));
  A.ok(wideSegments >= 40, 'one row to a segment: ' + wideSegments + ' segments');
  const widePaged = [];
  let wideCalls = 0, widePeak = 0;
  for (let at = 0; wideCalls < 100; wideCalls++) {
    reads.length = 0;
    const page = wideStore.pageAfter('wide', at, 500);
    widePeak = Math.max(widePeak, reads.length);
    widePaged.push(...ids(page.rows)); at = page.last;
    if (!page.more) break;
  }
  A.eq(widePaged, ids(wide), 'a stream over ' + wideSegments + ' segments reads forward completely, every row once');
  A.ok(widePeak <= 9, 'no cursor call reads more than eight segments plus the active one (peak ' + widePeak + ')');
  A.ok(wideCalls >= 5, 'a read this wide takes several bounded calls (' + (wideCalls + 1) + ')');
  let remaining = ids(wide).slice().reverse(), rounds = 0, byIdPeak = 0;
  const returned = [];
  while (remaining.length && rounds < 30) {
    reads.length = 0;
    const part = wideStore.rowsByIds('wide', remaining);
    byIdPeak = Math.max(byIdPeak, reads.length);
    returned.push(...ids(part.rows));
    A.ok(part.rows.length > 0, 'round ' + rounds + ' makes progress');
    if (!part.rows.length) break;
    remaining = part.missing; rounds++;
  }
  A.eq(returned.slice().sort((a, b) => a - b), ids(wide), 'asking again with only the missing ids returns every row of a wide stream');
  A.ok(rounds >= 2 && rounds <= 12, 'in several bounded requests (' + rounds + ')');
  A.ok(byIdPeak <= 9, 'no by-id request reads more than eight segments plus the active one (peak ' + byIdPeak + ')');

  // ---- a view that cannot be vouched for is an error, never a short or empty answer -----------------------------------------
  const unknownContext = Object.create(io);
  unknownContext.retractionsFor = () => ({ proofComplete: false, retractions: new Map() });
  throwsCode(() => storeOver(unknownContext).pageAfter('s1', 0, 10), 'TRANSCRIPT_UNVOUCHED', 'an unknown retract context refuses a cursor page');
  throwsCode(() => storeOver(unknownContext).rowsByIds('s1', wantLive.slice(0, 3)), 'TRANSCRIPT_UNVOUCHED', 'an unknown retract context refuses a by-id read');
  const incomplete = Object.create(io);
  incomplete.readByIds = () => Object.defineProperties(new Map(), { proofComplete: { value: false }, retractions: { value: new Map() } });
  throwsCode(() => storeOver(incomplete).rowsByIds('s1', wantLive.slice(0, 3)), 'TRANSCRIPT_UNVOUCHED', 'an incomplete row proof is an error, not every id missing');
  const degraded = Object.create(io);
  degraded.pageAfter = () => { throw Object.assign(new Error('degraded'), { code: 'TRANSCRIPT_UNVOUCHED' }); };
  throwsCode(() => storeOver(degraded).pageAfter('s1', 0, 10), 'TRANSCRIPT_UNVOUCHED', 'an io that cannot vouch for its disk refuses the cursor read');
  const crashing = Object.create(io);
  crashing.pageAfter = () => { throw new Error('disk on fire'); };
  throwsCode(() => storeOver(crashing).pageAfter('s1', 0, 10), 'TRANSCRIPT_UNVOUCHED', 'an io that throws is an unproven read');
  const noDisk = Store.makeTranscriptStore({ io: { readAll: () => [], append() {} } });
  throwsCode(() => noDisk.pageAfter('s1', 0, 10), 'TRANSCRIPT_UNVOUCHED', 'an io with no cursor reader refuses instead of reading the RAM mirror');
  throwsCode(() => noDisk.rowsByIds('s1', [1]), 'TRANSCRIPT_UNVOUCHED', 'an io with no row reader refuses instead of reading the RAM mirror');

  // ---- the in-memory io answers the same ----------------------------------------------------------------------------------
  const memory = History.makeMemoryTranscriptIo();
  for (let i = 0; i < 30; i++) memory.appendDurable({ streamId: 'm', agentId: 'agent', role: i % 2 ? 'assistant' : 'user', kind: 'turn', content: 'memory row ' + i, taintKnown: true, ts: 10 + i });
  const memoryStore = Store.makeTranscriptStore({ io: memory });
  const memoryPaged = readOn((at, size) => memoryStore.pageAfter('m', at, size), 7);
  A.eq(memoryPaged, memoryStore.view('display', 'm', { limit: 100 }), 'the in-memory io pages to the same rows as the display view');
  A.eq(memoryStore.rowsByIds('m', ids(memoryPaged).reverse()).rows, memoryPaged.slice().reverse(), 'and answers rows by id');
  // ---- the route's projection passes the cursor through and nothing else ------------------------------------------------------
  const dual = Dual.make({ now: () => 1, hash: text => text, save() {} }), two = [{ streamId: 'p', rowId: 3, role: 'user', content: 'a' }, { streamId: 'p', rowId: 4, role: 'assistant', content: 'b' }];
  A.eq(Object.keys(dual.project('p', two)), ['stream', 'turns', 'identity'], 'a read with no cursor has exactly the old fields');
  A.eq(JSON.stringify(dual.project('p', two, { cursor: undefined })), JSON.stringify(dual.project('p', two)), 'and the old bytes');
  A.eq(Object.keys(dual.project('p', two, { cursor: { last: 4, count: 2, more: true } })), ['stream', 'turns', 'identity', 'cursor'], 'a cursor read adds it after them');
  A.eq(dual.project('p', two, { cursor: { last: 4, count: 2, more: true, extra: 'x' } }).cursor, { last: 4, count: 2, more: true }, 'the cursor is exactly { last, count, more }');
  A.eq(dual.project('p', two, { cursor: { last: 'x', count: -1, more: 'yes' } }).cursor, { last: 0, count: 2, more: false }, 'a malformed cursor is normalised, never passed through');
  A.eq(Object.keys(dual.project('p', two, { cursor: 'nope' })), ['stream', 'turns', 'identity'], 'a cursor that is not an object is ignored');
  A.eq(warnings.filter(w => /unreadable|corrupt|degraded/.test(w)), [], 'no io warning was raised by any fixture');
} catch (error) {
  A.ok(false, 'the cursor read test threw: ' + (error && error.stack || error));
} finally {
  for (const io of opened) { try { io.close(); } catch (closeError) { console.log('close: ' + closeError.message); } }
  if (path.dirname(path.resolve(root)) !== temp) throw new Error('refusing to remove a fixture outside its temporary parent');
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('transcript-cursor-read');
