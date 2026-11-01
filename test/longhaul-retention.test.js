/* node test/longhaul-retention.test.js — scale contracts that must stay data-preserving. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const { makeDeliverableStore } = require('../sidecar/deliverable-store.js');
const sidecarSource = readSidecarSource();

(async () => {
  // Thousands of short conversations must not defeat a per-stream-only RAM ceiling.
  const transcriptRows = Array.from({ length: 9000 }, (_, i) => ({ streamId: 's' + Math.floor(i / 3), agentId: 'agent', role: i % 3 ? 'assistant' : 'user', content: 'row ' + i, ts: i }));
  let recentOptions = null;
  const transcript = makeTranscriptStore({
    io: {
      readRecent(o) { recentOptions = o; return transcriptRows.slice(-o.globalLimit); },
      append(row) { return row; },
      history(streamId, o) { return transcriptRows.filter(r => r.streamId === streamId).slice(-o.limit); },
      search() { return [{ streamId: 's0', role: 'user', content: 'lifetime hit', ts: 1, score: 1001 }]; }
    },
    clock: { now: () => 1 }
  });
  A.eq(recentOptions.globalLimit, 3000, 'transcript boot requests a global RAM ceiling');
  A.eq(transcript.count(), 3000, '9,000 turns retain only the newest 3,000 in RAM');
  A.eq(transcript.history('s0', { limit: 3 }).length, 3, 'old stream history still reads lazily from disk IO');
  A.eq(transcript.search('s0', 'lifetime').length, 1, 'lifetime search still delegates to durable indexes');
  A.ok(/readBody\(req,\s*16\s*<<\s*20\)/.test(sidecarSource), 'save ingress retains the measured 16 MiB long-haul ceiling');

  // Journal evidence is stable and pageable; no page request deletes unresolved rows.
  const journalFiles = Array.from({ length: 1200 }, (_, i) => '/j/' + String(i).padStart(4, '0') + '.jsonl');
  const records = new Map();
  for (let i = 0; i < journalFiles.length; i++) {
    const runId = 'r' + i;
    const mem = makeRunJournal({ io: { create(_id, line) { records.set(journalFiles[i], line + '\n'); }, append() {}, read() {}, list() { return []; }, readFile() {} }, clock: { now: () => i } });
    mem.begin({ runId, agentId: 'agent' });
  }
  const journal = makeRunJournal({ io: { list() { return journalFiles.slice(); }, readFile(f) { return records.get(f); } } });
  const page = journal.recoverPage({ offset: 100, limit: 75 });
  A.eq(page.total, 1200, 'journal pagination reports every durable recovery record');
  A.eq(page.rows.length, 75, 'journal pagination reads only the requested bounded page');
  A.eq(page.offset, 100, 'journal pagination keeps a stable offset');

  // More than the old 2,000-row ceiling survives a new append and a fresh store instance.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-deliverables-'));
  try {
    const rows = Array.from({ length: 2100 }, (_, i) => ({ id: 'd' + i, agentId: 'agent', runId: 'r' + i, title: 'Deliverable ' + i, status: 'kept', files: [{ path: 'out/' + i + '.md', bytes: 1 }], createdAt: i, updatedAt: i }));
    fs.writeFileSync(path.join(root, 'deliverables.library.json'), JSON.stringify({ v: 1, rows, undo: [] }));
    const before = fs.readFileSync(path.join(root, 'deliverables.library.json'), 'utf8');
    const store = makeDeliverableStore({ fs, path, workspaces: root });
    await store.record({ id: 'd2100', agentId: 'agent', runId: 'r2100', title: 'Newest', status: 'kept', files: [] }, 2100);
    A.eq(store.list().length, 2101, 'append retains every row beyond the former 2,000 ceiling');
    A.eq(fs.readFileSync(path.join(root, 'deliverables.library.json'), 'utf8'), before, 'ordinary append does not rewrite the full legacy snapshot');
    A.ok(fs.statSync(path.join(root, 'deliverables.library.jsonl')).size > 0, 'ordinary append lands in the fsync journal');
    const reopened = makeDeliverableStore({ fs, path, workspaces: root });
    A.eq(reopened.list().length, 2101, 'snapshot plus journal replays every deliverable after restart');
    fs.appendFileSync(path.join(root, 'deliverables.library.jsonl'), '{torn');
    const repaired = makeDeliverableStore({ fs, path, workspaces: root });
    A.eq(repaired.list().length, 2101, 'a torn journal tail retains every proven prior row');
    A.ok(fs.existsSync(path.join(root, 'deliverables.library.jsonl.corrupt')), 'torn journal bytes are preserved for forensics');
    await repaired.record({ id: 'd2101', agentId: 'agent', runId: 'r2101', title: 'After repair', status: 'kept', files: [] }, 2101);
    A.eq(makeDeliverableStore({ fs, path, workspaces: root }).list().length, 2102, 'new appends remain replayable after torn-tail repair');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  A.report('longhaul-retention.test');
})().catch(e => { console.error(e); process.exit(1); });
