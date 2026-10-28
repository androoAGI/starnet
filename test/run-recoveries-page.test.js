/* node test/run-recoveries-page.test.js — GET /api/run-recoveries no longer lists the journal directory once per row, and
   a page asking for ITS conversation's interrupted run finds it however many journals sort ahead of it.

   The bug (perf review 10-19, index.js serveRunRecoveries): (a) every row of a page listed the whole journal directory
   twice — run-journal's damage-evidence check, then the host's forensic mark — so a 100-row page over thousands of
   retained journals did ~200 full listings and parsed 100 journals; (b) the page is hash-ordered (journal file names
   are sha256(runId)) and the chat asked for the first 100 then filtered to its own conversation, so with more than 100
   journals the current conversation's interrupted run was simply not there and never offered for recovery.

   Proves with the REAL run journal over a real temp dir (an earlier "process" writes the journals, a fresh one lists
   them, as after a restart), plus the REAL host forensic mark sliced from index.js:
     (1) an unfiltered 100-row page lists the directory ONCE (was 1 + one per row), with identical damage verdicts;
     (2) a run whose journal sorts past the first page is found by { streamId, agentId }, and only that conversation's
         journals are parsed; a second ask reads no heads again;
     (3) a begin record whose title straddles a read chunk on a multi-byte character still matches;
     (4) a `.corrupt` sibling keeps a journal forensic through the shared listing, and the host mark trusts that verdict
         without listing again;
     (5) index.js passes the filters through, and the chat asks for its own conversation. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fnBody } = require('./_fnbody.js');
const { makeRunJournal, _internals: { runFileName } } = require('../sidecar/run-journal.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-recoveries-'));
try {
  // ---- an earlier process: 150 interrupted runs on other conversations ----
  const before = makeRunJournal({ dir, fs, path, clock: { now: () => 1000 } });
  const begin = (runId, streamId, agentId, title) => {
    before.begin({ runId, agentId, streamId, trigger: 'interactive', model: 'm', userTitle: title || 'task ' + runId, startedAt: 1000 });
    before.checkpoint(runId, { phase: 'initial', turn: 0, messages: [{ role: 'user', content: 'do ' + runId }] });
  };
  for (let i = 0; i < 150; i++) begin('other-' + i, 'ws-other-' + (i % 7), 'agent');
  const names = fs.readdirSync(dir).filter(n => /\.jsonl$/.test(n)).sort();
  // a target run whose journal sorts PAST the first page of 100
  let target = null;
  for (let k = 0; k < 5000 && !target; k++) { const id = 'target-' + k; if (runFileName(id) > names[110]) target = id; }
  A.ok(target, 'found a run id whose journal sorts past the first page');
  begin(target, 'ws-target', 'agent', 'the current conversation');
  const corruptId = 'other-3';
  fs.writeFileSync(path.join(dir, runFileName(corruptId) + '.corrupt-abc'), 'forensic bytes');
  // a begin record whose title puts a multi-byte character across the 64 KB read boundary
  const wide = 'wide-run';
  before.begin({ runId: wide, agentId: 'agent', streamId: 'ws-wide', trigger: 'interactive', model: 'm', userTitle: 'x'.repeat(65400) + 'λ'.repeat(200), startedAt: 1000 });

  // ---- the fresh process ----
  const c = { readdirs: 0, fullReads: 0 };
  const cfs = new Proxy(fs, { get(t, p) {
    if (p === 'readdirSync') return function () { c.readdirs++; return t.readdirSync.apply(t, arguments); };
    if (p === 'readFileSync') return function (f) { if (/\.jsonl$/.test(String(f))) c.fullReads++; return t.readFileSync.apply(t, arguments); };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  const journal = makeRunJournal({ dir, fs: cfs, path, clock: { now: () => 2000 } });
  c.readdirs = 0;

  // ---- (1) ----
  const page = journal.recoverPage({ offset: 0, limit: 100 });
  A.eq(page.rows.length, 100, 'an unfiltered page still returns 100 rows');
  A.eq(page.total, 152, 'over every journal');
  A.eq(c.readdirs, 1, 'and lists the directory once (was once more per row: 101)');
  A.ok(!page.rows.some(r => r.runId === target), 'the target run is NOT on the hash-ordered first page (the bug the chat hit)');
  const forensicRow = page.rows.find(r => r.runId === corruptId) || journal.recoverPage({ offset: 100, limit: 100 }).rows.find(r => r.runId === corruptId);
  A.ok(forensicRow && forensicRow.forensic === true, 'a `.corrupt` sibling keeps its journal forensic through the shared listing');
  const ref = journal.inspect(corruptId);
  A.eq(!!ref.forensic, true, 'the per-file evidence check agrees');

  // ---- (2) ----
  c.readdirs = 0; c.fullReads = 0;
  const mine = journal.recoverPage({ offset: 0, limit: 100, streamId: 'ws-target', agentId: 'agent' });
  A.eq(mine.rows.map(r => r.runId), [target], 'asking for the conversation finds its interrupted run');
  A.eq(mine.total, 1, 'and only that conversation\'s journals are counted');
  A.eq(c.fullReads, 1, 'only the matching journal was parsed (was 100 per page)');
  A.eq(c.readdirs, 1, 'with one directory listing');
  const opens = { n: 0 };
  const realOpen = fs.openSync;
  fs.openSync = function () { opens.n++; return realOpen.apply(fs, arguments); };
  try { journal.recoverPage({ offset: 0, limit: 100, streamId: 'ws-target', agentId: 'agent' }); }
  finally { fs.openSync = realOpen; }
  A.eq(opens.n, 0, 'a second ask reads no journal heads again (they never change)');
  A.eq(journal.recoverPage({ streamId: 'ws-target', agentId: 'someone-else' }).rows.length, 0, 'the agent filter applies too');
  // the boot walk warms the heads of journals it does not parse (settled forensic ones): a later ask opens none
  const warmed = makeRunJournal({ dir, fs: cfs, path, clock: { now: () => 3000 } });
  for (const n of fs.readdirSync(dir).filter(x => /\.jsonl$/.test(x))) warmed.warmHead(path.join(dir, n));
  opens.n = 0;
  fs.openSync = function () { opens.n++; return realOpen.apply(fs, arguments); };
  try { A.eq(warmed.recoverPage({ streamId: 'ws-target', agentId: 'agent' }).rows.map(r => r.runId), [target], 'a warmed journal set answers the ask'); }
  finally { fs.openSync = realOpen; }
  A.eq(opens.n, 0, 'without opening a single head');
  A.eq(journal.recoverPage({ streamId: 'ws-other-2' }).rows.length, page.rows.concat(journal.recoverPage({ offset: 100, limit: 100 }).rows).filter(r => r.meta.streamId === 'ws-other-2').length, 'a filtered page = the unfiltered rows of that conversation');

  // ---- (3) ----
  A.eq(journal.recoverPage({ streamId: 'ws-wide' }).rows.map(r => r.runId), [wide], 'a head split on a multi-byte character still matches');

  // ---- (4) the host forensic mark ----
  const src = readSidecarSource();
  const markFn = fnBody(src, 'function markRunRecoveryForensic(r)');
  A.ok(markFn.length > 100 && markFn.length < 2000, 'sliced the host forensic mark');
  let hostReaddirs = 0;
  const host = vm.runInNewContext('(' + markFn + ')', {
    fs: { readdirSync: (d) => { hostReaddirs++; return fs.readdirSync(d); } }, path, RUN_JOURNAL_DIR: dir,
    runJournal: { _internals: { runFileName } }
  });
  const rows = journal.recoverPage({ offset: 0, limit: 100 }).rows.map(host);
  A.eq(hostReaddirs, 0, 'the host mark does not list the directory again for rows whose evidence was read');
  const all = rows.concat(journal.recoverPage({ offset: 100, limit: 100 }).rows.map(host));
  A.eq(all.find(r => r.runId === corruptId).forensicOnly, true, 'the forensic verdict is the same');
  A.ok(all.filter(r => r.runId !== corruptId).every(r => r.forensicOnly === false), 'and no clean journal turns forensic');
  const bare = host({ runId: corruptId, file: path.join(dir, runFileName(corruptId)) });
  A.ok(bare.forensicOnly === true && hostReaddirs === 1, 'a row without folded evidence still gets the directory check');

  // ---- (5) ----
  const serve = fnBody(src, 'function serveRunRecoveries(req, res)');
  A.ok(/for \(const k of \['streamId', 'agentId'\]\)/.test(serve) && /recoverPage\(Object\.assign\(\{ offset, limit \}, filter\)\)/.test(serve), 'the route passes streamId/agentId through');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  A.ok(/Harness\.runRecoveries\(\{ streamId: ws\.id, agentId: ws\.agentId \|\| 'agent' \}\)/.test(chat), 'the chat asks for its own conversation');
  const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
  A.ok(/'\/api\/run-recoveries\?' \+ qs/.test(harness), 'the harness client sends the filter');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
A.report('run-recoveries-page.test');
