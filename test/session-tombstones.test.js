/* node test/session-tombstones.test.js — A DELETED SESSION IS FORGOTTEN (qa/bugs/3e926b6a, P1 privacy).

   The Commander deletes a session from the rail. Before this fix the sidecar never learned it: the durable transcript
   kept serving the deleted words to resume, recall_conversation searched and listed them, and memories written there
   rode later prompts. This proves each context path on the real modules (temp dirs, real fs):

     1. THE LEDGER (session-tombstones.js) learns deletes from the save's deletedIds, stamps when, survives a reload,
        keeps a delete after the id leaves the page's list (a re-open, the 500 cap, NEW AGENT), restamps a second delete,
        and ignores a save that carries no list. The FIRST list it reads (the first boot of this build) is adopted:
        those deletes are forgotten from history and recall, but the memories they wrote are never purged retroactively.
     2. HISTORY — transcriptstore history/reconstruct/all forget the deleted session (in-memory io and the real
        segmented io), and a session re-opened under the same id hears only what was said after the delete. Taint is
        not forgotten: a page that still holds the deleted history and replays it still latches the run's taint.
     3. RECALL — the real recall_conversation tool's search (stream + all), browse and scroll never return a deleted row,
        and the segment index ranks among the rows it may return (a deleted session never takes a slot).
     4. MEMORY — forgetSessionMemory removes what the deleted session wrote, over the real memory-store and threads-store:
        records created there go; a record created elsewhere rolls back to its newest version from elsewhere; a rating
        verdict keeps the verdict and the Commander's words without the deleted work's quotes; pending proposals and
        open threads go; everyone else's stays.
     5. CROSS-SESSION READS — a read of the deleted session by id (station.read_session's transcript read, a worker's
        sessionContext, the away briefing's last words) comes back empty; other sessions read as before.
     6. THE HOST WIRING (sidecar/index.js, static): the store reads through the ledger, every accepted station save and
        the boot save feed it, and the run-history readers that quote titles to a model skip a deleted session's runs.
     7. WHO FORGETS: only the Commander's Delete of a conversation (the save's forgetIds). DELETE AGENT and a task
        card's remove hide rows and forget nothing: the ratings the agent-delete route adopted keep their directive and
        feedbackRef, the threads mined there stay, and those conversations read as before. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeSessionTombstones, forgetSessionMemory, _internals } = require('../sidecar/session-tombstones.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeRecallTool } = require('../sidecar/tools/builtin/recall.js');
const { makeMemoryStore, appendPending, listPending } = require('../sidecar/memory-store.js');
const { makeThreadsStore } = require('../sidecar/threads-store.js');
const { makeReplayedTaint } = require('../sidecar/taint-replay.js');
const FeedbackMemory = require('../sidecar/feedbackmemory.js');
const { reviseRecord } = require('../sidecar/tools/builtin/notebook.js');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-tomb-' + name + '-')); }
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
const clockAt = start => { let t = start; return { now: () => t, set: v => { t = v; } }; };

(async () => {
  // ---------------- 1. the ledger ----------------
  {
    const dir = temp('ledger');
    try {
      const clock = clockAt(1000);
      const file = path.join(dir, 'session-tombstones.json');
      let t = makeSessionTombstones({ fs, path, file, now: clock.now });
      A.eq(t.status(), 'absent', 'a fresh station has no ledger yet');
      A.eq(t.deletedAt('ws_a'), 0, 'a session nobody deleted has no stamp');
      A.eq(t.observe(undefined), [], 'a save with no deletedIds teaches nothing');
      A.eq(t.since(), 0, '…not even that the ledger has read a list');
      // THE FIRST LIST IS ADOPTED: these deletes were made while Delete only hid the rail row
      A.eq(t.observe(['ws_old', '../escape']), [], 'the first list the ledger reads holds no fresh delete (the first boot of this build)');
      A.eq([t.since(), t.deletedAt('ws_old')], [1000, 1000], '…but its deletes are stamped: their transcript and recall are forgotten from now on');
      A.eq(t.unpurged(), [], '…and recorded as purged: the memories they wrote are never wiped retroactively');
      A.eq(t.adopted(), [{ id: 'ws_old', at: 1000 }], 'adopted() names them');
      A.eq(t.observe(['ws_old', 'ws_a', 'ws_b', '../escape', '', null, 'ws_a']), ['ws_a', 'ws_b'], 'each valid id is stamped once; a bad id is ignored');
      A.eq(t.deletedAt('ws_a'), 1000, 'the stamp is when the sidecar learned the delete');
      A.ok(t.forgotten('ws_a', 999) && t.forgotten('ws_a', 1000) && t.forgotten('ws_a', 0), 'a row stamped at or before the delete (or unstamped) is forgotten');
      A.ok(!t.forgotten('ws_a', 1001) && !t.forgotten('ws_c', 5), 'a later row, or another session, is not');
      clock.set(2000);
      A.eq(t.observe(['ws_a', 'ws_b']), [], 'the same list again is not a new delete');
      A.eq(t.deletedAt('ws_a'), 1000, '…and keeps the first stamp');
      A.eq(t.observe('not-a-list'), [], 'a malformed list teaches nothing');
      A.ok(['ws_a', 'ws_b'].every(id => t.list().find(e => e.id === id).live), '…and never reads as "every delete was undone"');
      // the page re-opens ws_a (revive) or drops it past its 500 cap: it leaves the list, the delete stands
      clock.set(3000);
      A.eq(t.observe(['ws_b']), [], 'an id leaving the list is no new delete');
      A.eq(t.deletedAt('ws_a'), 1000, 'what was deleted stays deleted after the id leaves the page\'s list');
      // reload from disk
      t = makeSessionTombstones({ fs, path, file, now: clock.now });
      A.eq(t.status(), 'ok', 'the ledger is durable');
      A.eq([t.deletedAt('ws_a'), t.deletedAt('ws_b')], [1000, 1000], 'both stamps survive a restart');
      A.eq([t.since(), t.adopted().map(e => e.id)], [1000, ['ws_old']], 'so does the adoption: a restart never makes the old deletes fresh');
      A.eq(t.list().find(e => e.id === 'ws_a').live, false, 'ws_a is remembered as no longer in the page list');
      // the re-opened ws_a is deleted AGAIN: a fresh delete, stamped now
      clock.set(4000);
      A.eq(t.observe(['ws_b', 'ws_a']), ['ws_a'], 'a second delete of a re-opened session is a fresh delete');
      A.eq(t.deletedAt('ws_a'), 4000, '…stamped at the second delete, so what it said since the first is forgotten too');
      // NEW AGENT clears the page list: nothing is undeleted
      A.eq(t.observe([]), [], 'an empty list stamps nothing');
      A.eq([t.deletedAt('ws_a'), t.deletedAt('ws_b')], [4000, 1000], 'a reset page list never brings a deleted session back');
      // purge bookkeeping
      A.eq(t.unpurged().map(e => e.id), ['ws_b', 'ws_a'], 'every stamp starts unpurged, oldest first');
      t.markPurged([{ id: 'ws_b', at: 1000 }, { id: 'ws_a', at: 1 }]);
      A.eq(t.unpurged().map(e => e.id), ['ws_a'], 'a purge is recorded only for the stamp it ran against');
      t = makeSessionTombstones({ fs, path, file, now: clock.now });
      A.eq(t.unpurged().map(e => e.id), ['ws_a'], 'an unfinished purge is retried after a restart');
      // cap: the oldest stamps go first past MAX_STREAMS
      const many = { streams: {} };
      for (let i = 0; i < _internals.MAX_STREAMS + 5; i++) many.streams['s' + i] = { at: i + 1, live: false };
      const capped = _internals.normalizeState(many);
      A.eq(Object.keys(capped.streams).length, _internals.MAX_STREAMS, 'the ledger is bounded');
      A.ok(!capped.streams.s0 && !!capped.streams['s' + (_internals.MAX_STREAMS + 4)], '…dropping the oldest stamps first');
    } finally { remove(dir); }
  }
  // a new station's first list is empty, so every later delete is fresh; an adopted session that is re-opened and
  // deleted again is a fresh delete too (what it wrote since is purged)
  {
    const dir = temp('ledger-adopt');
    try {
      const clock = clockAt(50);
      let t = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now });
      A.eq(t.observe([]), [], 'a new station\'s first list is empty');
      A.eq(t.since(), 50, '…and it is the adopted first list all the same');
      clock.set(60);
      A.eq(t.observe(['ws_new']), ['ws_new'], 'after it, a delete is fresh');
      A.eq(t.unpurged().map(e => e.id), ['ws_new'], '…and its memory is purged');
      t = makeSessionTombstones({ fs, path, file: path.join(dir, 'upgrade.json'), now: clock.now });
      t.observe(['ws_old']);
      clock.set(70); t.observe([]);
      clock.set(80);
      A.eq(t.observe(['ws_old']), ['ws_old'], 'an adopted session re-opened and deleted again is a fresh delete');
      A.eq([t.deletedAt('ws_old'), t.adopted(), t.unpurged().map(e => e.id)], [80, [], ['ws_old']], '…restamped, no longer adopted, its memory purged');
    } finally { remove(dir); }
  }

  // ---------------- 2 + 3 + 5. history, recall, cross-session reads ----------------
  async function storePaths(label, makeIo) {
    const dir = temp('store-' + label);
    try {
      const clock = clockAt(100);
      const ledger = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now });
      ledger.observe([]);   // the boot read of a station with no earlier deletes
      const io = makeIo(dir);
      const store = makeTranscriptStore({ io, clock, deletedAt: id => ledger.deletedAt(id) });
      const say = (streamId, role, content, extra) => { clock.set(clock.now() + 10); return store.append(Object.assign({ streamId, agentId: 'agent', role, content, taint: null }, extra || {})); };
      say('ws_gone', 'user', 'echo session uniqueword quokka');
      say('ws_gone', 'assistant', 'Reply to: echo session uniqueword quokka — done.', { taint: 'web page example.com' });
      say('ws_keep', 'user', 'the platypus plan with quokka mentioned once');
      say('ws_keep', 'assistant', 'Platypus plan noted.');
      for (let i = 0; i < 12; i++) say('ws_gone', 'user', 'quokka filler line ' + i + ' quokka quokka');   // would crowd a top-N
      const before = store.search('ws_keep', 'quokka', { scope: 'all', limit: 3 });
      A.ok(before.some(h => h.streamId === 'ws_gone'), label + ': before the delete the deleted session is searchable (the bug)');

      clock.set(clock.now() + 10);
      A.eq(ledger.observe(['ws_gone']), ['ws_gone'], label + ': the page\'s save deletes ws_gone');
      clock.set(clock.now() + 10);

      // HISTORY
      A.eq(store.history('ws_gone').length, 0, label + ': history() forgets the deleted session');
      A.eq(store.reconstruct('ws_gone', { limit: 80 }).length, 0, label + ': reconstruct() (resume / a worker\'s sessionContext) hands a model nothing');
      // TAINT IS NOT FORGOTTEN: a page that still holds the deleted history (a second station page, a stale tab) and
      // replays it starts the run tainted, exactly as before the delete
      const replayed = makeReplayedTaint({ transcript: store });
      const pageCopy = [{ role: 'user', content: 'echo session uniqueword quokka' }, { role: 'assistant', content: 'Reply to: echo session uniqueword quokka — done.' }, { role: 'user', content: 'ok do it' }];
      A.eq(replayed({ streamId: 'ws_gone', msgs: pageCopy }), 'replayed history (tainted by web page example.com)', label + ': a page-held replay of the deleted session\'s tainted rows still latches taint');
      A.eq(replayed({ streamId: 'ws_keep', msgs: [{ role: 'user', content: 'the platypus plan with quokka mentioned once' }, { role: 'user', content: 'go on' }] }), null, label + ': a clean session stays clean');
      A.ok(!store.all().some(r => r.streamId === 'ws_gone'), label + ': all() (the evidence pack\'s clean owner chats) forgets it');
      A.eq(store.history('ws_keep').map(r => r.content), ['the platypus plan with quokka mentioned once', 'Platypus plan noted.'], label + ': another session reads exactly as before');

      // RECALL through the real tool
      const tool = makeRecallTool({ transcriptStore: store, ownStreamOnly: () => false }).recallTool;
      const ctx = { streamId: 'ws_fresh' };
      const all = await tool.run({ query: 'quokka', scope: 'all', limit: 10 }, ctx);
      A.ok(!/uniqueword|filler|ws_gone/.test(all.content), label + ': recall search (scope all) returns no deleted row: ' + all.content.slice(0, 200));
      A.ok(/ws_keep/.test(all.content), label + ': …and still finds the live session\'s mention');
      const top = store.search('ws_keep', 'quokka', { scope: 'all', limit: 1 });
      A.eq(top.map(h => h.streamId), ['ws_keep'], label + ': a deleted session never takes a top-N slot (12 stronger deleted rows, limit 1)');
      const local = await tool.run({ query: 'uniqueword' }, { streamId: 'ws_gone' });
      A.ok(!/uniqueword quokka/.test(local.content) && /No messages/.test(local.content), label + ': a search from the deleted session\'s own id finds nothing');
      const browse = await tool.run({}, ctx);
      A.ok(!/ws_gone/.test(browse.content) && /ws_keep/.test(browse.content), label + ': recall browse no longer lists the deleted session: ' + browse.content.slice(0, 200));
      A.ok(!store.streams({ limit: 100 }).some(s => s.streamId === 'ws_gone'), label + ': streams() drops it');
      const deletedRow = before.find(h => h.streamId === 'ws_gone');
      const scroll = await tool.run({ around: deletedRow.ts, stream: 'ws_gone' }, ctx);
      A.ok(!/uniqueword|filler/.test(scroll.content), label + ': recall scroll around a deleted moment reads nothing: ' + scroll.content.slice(0, 160));
      if (deletedRow.rowId) {
        const anchored = await tool.run({ anchor: 'tx-' + deletedRow.rowId, stream: 'ws_gone' }, ctx);
        A.ok(!/uniqueword|filler/.test(anchored.content), label + ': a stable tx- anchor to a deleted row reads nothing');
      }

      // RE-OPENED under the same id: only what is said after the delete
      say('ws_gone', 'user', 'a new beginning with kangaroo');
      say('ws_gone', 'assistant', 'Kangaroo acknowledged.');
      A.eq(store.history('ws_gone').map(r => r.content), ['a new beginning with kangaroo', 'Kangaroo acknowledged.'], label + ': a re-opened session hears only what was said after the delete');
      A.eq(store.reconstruct('ws_gone').map(m => m.role), ['user', 'assistant'], label + ': its resume replays only those turns');
      const listed = store.streams({ limit: 100 }).find(s => s.streamId === 'ws_gone');
      A.ok(listed && listed.turns === 2 && /kangaroo/.test(listed.preview), label + ': browse lists the re-opened session from its new turns only: ' + JSON.stringify(listed));
      A.ok(!/uniqueword/.test(JSON.stringify(store.search('ws_gone', 'quokka uniqueword kangaroo', { scope: 'all', limit: 50 }))), label + ': search still never returns the old turns');
      return store;
    } finally { remove(dir); }
  }
  await storePaths('ram', () => ({ readAll() { return []; }, append() {} }));
  await storePaths('segmented', dir => makeSegmentedTranscriptIo({ fs, path, root: path.join(dir, 'history'), segmentBytes: 700, recentPerStream: 4 }));

  // a stream RAM has trimmed is answered from disk: the disk answer forgets too (segmented io, tiny RAM window)
  {
    const dir = temp('store-trimmed');
    try {
      const clock = clockAt(10);
      const ledger = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now });
      const io = makeSegmentedTranscriptIo({ fs, path, root: path.join(dir, 'history'), segmentBytes: 400, recentPerStream: 2 });
      const store = makeTranscriptStore({ io, clock, deletedAt: id => ledger.deletedAt(id), ramPerStream: 2, ramMax: 4 });
      for (let i = 0; i < 9; i++) { clock.set(clock.now() + 5); store.append({ streamId: 'ws_long', role: i % 2 ? 'assistant' : 'user', content: 'secret line ' + i, taint: null }); }
      A.eq(store.history('ws_long').length, 9, 'a trimmed stream reads its full history from disk before the delete');
      clock.set(clock.now() + 5); ledger.observe(['ws_long']); clock.set(clock.now() + 5);
      A.eq(store.history('ws_long').length, 0, 'a trimmed stream\'s disk answer forgets the deleted rows too');
      const reloaded = makeTranscriptStore({ io: makeSegmentedTranscriptIo({ fs, path, root: path.join(dir, 'history'), segmentBytes: 400, recentPerStream: 2 }), clock,
        deletedAt: id => makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now }).deletedAt(id) });
      A.eq(reloaded.history('ws_long').length + reloaded.search('x', 'secret', { scope: 'all' }).length, 0, 'after a restart (fresh io + reloaded ledger) the session stays forgotten');
    } finally { remove(dir); }
  }

  // ---------------- 4. memory ----------------
  {
    const dir = temp('memory');
    try {
      const store = makeMemoryStore({ fs, path, workspaces: dir });
      const threads = makeThreadsStore({ fs, path, workspaces: dir });
      const at = 5000;
      const runs = [
        { runId: 'run_gone_1', streamId: 'ws_gone', ts: 4000 },
        { runId: 'run_gone_2', streamId: 'ws_gone', ts: 4500 },
        { runId: 'run_gone_3', streamId: 'ws_gone', ts: 4700 },
        { runId: 'run_keep', streamId: 'ws_keep', ts: 4200 },
        { runId: 'run_keep2', streamId: 'ws_keep', ts: 4300 },
        { runId: 'run_gone_after', streamId: 'ws_gone', ts: 9000 }   // a re-opened session's later run: not the deleted one
      ];
      // versions written the way notebook.write's replaceId writes them (the real reviseRecord keeps the old text in history)
      const made = (id, body, runId, createdAt) => ({ id, kind: 'note', title: 'T ' + id, body, content: body, scope: 'global', streamId: null, sourceRunId: runId, createdAt, ts: createdAt });
      const revise = (rec, body, runId, now, extra) => reviseRecord(rec, Object.assign({ previousBody: String(rec.content), body, runId }, extra || {}), now);
      // the review's case: a fact stated in the KEPT session, corrected once in the deleted one
      const deploy = revise(Object.assign(made('note_3', 'Deploys go to fly.io', 'run_keep', 100), { title: 'Deploy target', confirmation: 'user-stated', statedBy: { runId: 'run_keep', quote: 'Deploys go to fly.io' } }),
        'Deploys go to fly.io region iad', 'run_gone_2', 4500, { confirmation: 'user-stated', statedBy: { runId: 'run_gone_2', quote: 'Deploys go to fly.io region iad' } });
      const twoKept = Object.assign(revise(revise(made('note_3b', 'v0 text', 'run_keep', 100), 'v1 text', 'run_keep2', 4300), 'v2 written in the deleted chat', 'run_gone_2', 4600),
        { taintedBy: 'web page evil.example', pinned: false });   // the deleted run had read a page (notebook.write stamps it)
      const middle = revise(revise(made('note_3c', 'w0 text', 'run_keep', 100), 'w1 written in the deleted chat', 'run_gone_1', 4100), 'w2 written in the deleted chat', 'run_gone_2', 4600);
      const laterKept = revise(revise(made('note_3e', 'u0 text', 'run_keep', 100), 'u1 written in the deleted chat', 'run_gone_1', 4100), 'u2 text', 'run_keep2', 4800);
      // rating verdicts, written by the real feedback module
      const verdict = (input, now, id) => FeedbackMemory.apply([], input, { now, nextId: () => id }).rec;
      const liked = verdict({ runId: 'run_gone_1', verdict: 'great', words: 'matte, no gloss', directive: 'design the quokka landing page', ref: { files: ['quokka.html'] } }, 4100, 'note_7');
      const bare = verdict({ runId: 'run_gone_2', verdict: 'miss', directive: 'draft the quokka newsletter' }, 4600, 'note_8');
      const edited = Object.assign(verdict({ runId: 'run_gone_3', verdict: 'great', words: 'bold type', directive: 'design the quokka poster' }, 4700, 'note_9'),
        { body: 'I love bold type (on: design the quokka poster)', content: 'I love bold type (on: design the quokka poster)', feedbackEdited: true });
      const keptRating = verdict({ runId: 'run_keep', verdict: 'great', words: 'short bullets', directive: 'summarize the platypus plan' }, 4200, 'note_10');
      A.ok(/\(on: design the quokka landing page\)/.test(liked.content) && liked.feedbackRef, 'the fixture verdict quotes the rated work (the bug\'s premise)');
      await store.update('notebook:agent', () => [
        { id: 'note_1', title: 'Quokka', body: 'The quokka codeword is Wallaby-Seven', scope: 'stream', streamId: 'ws_gone', sourceRunId: 'run_gone_1', createdAt: 4000 },
        { id: 'note_2', title: 'Pet', body: 'The Commander keeps a pet quokka', scope: 'global', streamId: null, sourceRunId: 'run_gone_2', createdAt: 4500 },
        deploy, twoKept, middle,
        { id: 'note_3d', title: 'Corrected', body: 'revised in the deleted chat', scope: 'global', sourceRunId: 'run_keep', updatedSourceRunId: 'run_gone_2', revision: 1, createdAt: 100 },
        laterKept,
        { id: 'note_4', title: 'Stated', body: 'always reply tersely', scope: 'global', sourceRunId: 'run_x', confirmation: 'user-stated', statedBy: { runId: 'run_gone_1', quote: 'always reply tersely' }, createdAt: 100 },
        { id: 'note_5', title: 'Kept', body: 'The platypus plan ships Friday', scope: 'global', sourceRunId: 'run_keep', createdAt: 4200,
          history: [{ body: 'an older text the deleted chat wrote', sourceRunId: 'run_gone_1' }, { body: 'the original', sourceRunId: 'run_keep' }] },
        { id: 'note_6', title: 'After', body: 'said after the re-open', scope: 'stream', streamId: 'ws_gone', sourceRunId: 'run_gone_after', createdAt: 9000 },
        liked, bare, edited, keptRating,
        // an older verdict record this module cannot rebuild (no words list): kept as stored
        { id: 'note_11', kind: 'profile', origin: 'feedback', title: 'Preference', body: 'LIKED: "dark mode"', content: 'LIKED: "dark mode"', scope: 'global', streamId: null, sourceRunId: 'run_gone_3', confirmation: 'user-confirmed', createdAt: 4700 }
      ]);
      await store.update('notebook:scribe', () => [{ id: 'note_1', title: 'Scribe saw it', body: 'quokka relayed', scope: 'global', sourceRunId: 'run_gone_2', createdAt: 4500 }]);
      await appendPending(store, 'agent', 'run_gone_1', [{ id: 'p1', content: 'Commander SSN-shaped secret from the deleted chat' }], 4000);
      await appendPending(store, 'agent', 'run_keep', [{ id: 'p1', content: 'a pending proposal from the kept chat' }], 4200);
      await threads.add({ id: 'th_gone', title: 'Build a quokka tracker', spec: 'quokka', sourceRef: { streamId: 'ws_gone', runId: 'run_gone_1', date: 4000 } }, 4000);
      await threads.add({ id: 'th_keep', title: 'Ship the platypus plan', spec: 'platypus', sourceRef: { streamId: 'ws_keep', runId: 'run_keep', date: 4200 } }, 4200);
      await threads.add({ id: 'th_dated', title: 'Another deleted idea about wombats', spec: 'x', sourceRef: { streamId: 'ws_gone', date: 4600 } }, 4600);

      const counts = await forgetSessionMemory({ store, threads, agentIds: ['agent', 'scribe', '../bad'], deleted: [{ id: 'ws_gone', at }], runs });
      A.eq(counts, { notes: 5, revisions: 6, restored: 3, verdicts: 2, pending: 1, threads: 2,
        forgot: [{ agentId: 'agent', id: 'note_1' }, { agentId: 'agent', id: 'note_2' }, { agentId: 'agent', id: 'note_3d' }, { agentId: 'agent', id: 'note_8' }, { agentId: 'scribe', id: 'note_1' }] },
        'the purge reports what it removed, rolled back and kept, and names every removed record');
      const nb = store.get('notebook:agent');
      const rec = id => nb.find(r => r.id === id) || null;
      A.eq(nb.map(r => r.id), ['note_3', 'note_3b', 'note_3c', 'note_3e', 'note_4', 'note_5', 'note_6', 'note_7', 'note_9', 'note_10', 'note_11'],
        'only records CREATED in the deleted session go (by its runs, or filed under its stream); a record created elsewhere, the re-opened session\'s later note and the rating verdicts stay');
      // ROLL BACK, never destroy: the kept session's original text comes back
      const d = rec('note_3');
      A.eq([d.title, d.body, d.content, d.revision, d.history, 'updatedSourceRunId' in d, 'statedBy' in d, d.confirmation, d.sourceRunId, d.updatedAt],
        ['Deploy target', 'Deploys go to fly.io', 'Deploys go to fly.io', 0, [], false, false, 'inferred', 'run_keep', 100],
        'a fact stated in a kept session and corrected in the deleted one rolls back to its original text (the deleted version, its proof and its authority go)');
      const b = rec('note_3b');
      A.eq([b.body, b.revision, b.updatedSourceRunId, b.history.map(h => h.body), b.updatedAt], ['v1 text', 1, 'run_keep2', ['v0 text'], 4300], 'it rolls back to its NEWEST version from elsewhere, with that version\'s own revision and author');
      A.eq([b.taintedBy, b.pinned], ['web page evil.example', false], 'a rollback never takes a taint off');
      const c = rec('note_3c');
      A.eq([c.body, c.revision, c.history], ['w0 text', 0, []], 'every version a deleted run wrote goes, a middle one too');
      const e = rec('note_3e');
      A.eq([e.body, e.history.map(h => h.body)], ['u2 text', ['u0 text']], 'a record whose current text is from elsewhere only loses the deleted run\'s version from its history');
      A.eq([rec('note_4').body, 'statedBy' in rec('note_4'), rec('note_4').confirmation], ['always reply tersely', false, 'inferred'], 'a proof quoting the deleted session goes, and with it the stated authority it gave');
      A.eq(rec('note_5').history.map(h => h.body), ['the original'], 'a kept record loses the revision text the deleted session wrote');
      // RATING VERDICTS: the verdict and the Commander's words keep steering; what quoted the deleted work goes
      const v = rec('note_7');
      A.eq([v.content, v.body, v.feedbackVerdict, v.feedbackWords, v.feedbackDirective, 'feedbackRef' in v, v.confirmation],
        ['LIKED: "matte, no gloss"', 'LIKED: "matte, no gloss"', 'great', ['matte, no gloss'], '', false, 'user-confirmed'],
        'a like on a deleted session\'s run keeps the verdict and the Commander\'s words, without the directive or the reference to the deleted work');
      A.ok(FeedbackMemory.isTaste(v), '…and it is still taste');
      const block = FeedbackMemory.renderTaste(FeedbackMemory.selectTaste(nb), lines => ({ text: lines.map(l => l.body + ' ' + l.content).join('\n') }), { agentId: 'agent' }).text;
      A.ok(/liked: "matte, no gloss"/.test(block) && /short bullets/.test(block), 'both verdicts still ride every later prompt\'s taste block: ' + block.slice(0, 300));
      A.ok(!/quokka/.test(block), '…and no word of the deleted session does');
      A.eq([rec('note_9').content, rec('note_9').feedbackEdited], ['I love bold type', true], 'a verdict the Commander edited keeps their wording, minus the deleted work\'s directive');
      A.eq([rec('note_10').feedbackDirective, rec('note_10').content], ['summarize the platypus plan', keptRating.content], 'a verdict on a kept session\'s run is untouched');
      A.eq(rec('note_11').content, 'LIKED: "dark mode"', 'an older verdict this module cannot rebuild keeps its stored words');
      A.eq(store.get('notebook:scribe'), [], 'another agent\'s notebook loses what the deleted session\'s run wrote there');
      A.eq(listPending(store, 'agent').map(p => p.runId), ['run_keep'], 'a pending proposal from the deleted session never waits for a Keep');
      A.eq(threads.list().map(t => t.id), ['th_keep'], 'open threads mined from the deleted session are gone (by run and by stream + date)');
      A.ok(threads.isDeclined('Build a quokka tracker') === false, 'forgetting is not declining: the denylist is untouched');
      const zero = { notes: 0, revisions: 0, restored: 0, verdicts: 0, pending: 0, threads: 0, forgot: [] };
      const again = await forgetSessionMemory({ store, threads, agentIds: ['agent', 'scribe'], deleted: [{ id: 'ws_gone', at }], runs });
      A.eq(again, zero, 'the purge is idempotent (a boot retry removes nothing twice)');
      A.eq(await forgetSessionMemory({ store, threads, agentIds: ['agent'], deleted: [], runs }), zero, 'nothing deleted, nothing touched');
      // a store failure is reported, so the host records nothing as purged and retries
      let threw = false;
      try { await forgetSessionMemory({ store: { update: () => Promise.reject(new Error('disk gone')) }, agentIds: ['agent'], deleted: [{ id: 'ws_gone', at }], runs }); }
      catch (err) { threw = /disk gone/.test(err.message); }
      A.ok(threw, 'a failing store throws (the host retries the purge on the next boot)');
    } finally { remove(dir); }
  }

  // ---------------- 4b. the upgrade: deletes from before this build keep their memory ----------------
  // what the host does at boot (index.js: observe the save's list, then purge ledger.unpurged()), over the real ledger
  // and memory store: a session deleted before this build wrote a memory; the first boot must not wipe it
  {
    const dir = temp('upgrade');
    try {
      const clock = clockAt(1000);
      const ledger = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now });
      const store = makeMemoryStore({ fs, path, workspaces: dir });
      const runs = [{ runId: 'run_review', streamId: 'workshop-run_review', ts: 500 }, { runId: 'run_new', streamId: 'ws_new', ts: 1500 }];
      await store.update('notebook:agent', () => [
        { id: 'note_1', title: 'Deploy target', body: 'The Commander deploys to fly.io region iad', scope: 'global', sourceRunId: 'run_review', createdAt: 500 },
        { id: 'note_2', title: 'New', body: 'written in a session deleted after the upgrade', scope: 'global', sourceRunId: 'run_new', createdAt: 1500 }
      ]);
      A.eq(ledger.observe(['workshop-run_review']), [], 'the first boot of this build reads a delete made before it: no fresh delete');
      A.ok(ledger.forgotten('workshop-run_review', 500), '…its transcript and recall are forgotten');
      const boot = await forgetSessionMemory({ store, agentIds: ['agent'], deleted: ledger.unpurged(), runs });
      A.eq([boot.notes, store.get('notebook:agent').map(r => r.id)], [0, ['note_1', 'note_2']], '…and the memory it wrote is kept (no retroactive wipe)');
      clock.set(2000);
      A.eq(ledger.observe(['workshop-run_review', 'ws_new']), ['ws_new'], 'a delete after the upgrade is fresh');
      const later = await forgetSessionMemory({ store, agentIds: ['agent'], deleted: ledger.unpurged(), runs });
      A.eq([later.forgot, store.get('notebook:agent').map(r => r.id)], [[{ agentId: 'agent', id: 'note_2' }], ['note_1']], '…and only its memory is purged');
    } finally { remove(dir); }
  }

  // ---------------- 7. who forgets: only the Commander's Delete of a conversation ----------------
  // Review (blocking): DELETE AGENT's removeByAgent and a task card's remove put rows in deletedIds, and the sidecar
  // purged them as session deletes — stripping the ratings /api/agent/delete had just adopted into the hero's notebook
  // (their directive and DESIGN ANCHOR feedbackRef), the threads mined there, and the conversations themselves. Here
  // the real page module and the real app.js delete paths (lifted) write the save, the real ledger reads it the way
  // POST /api/save does (observeSave), the real adoptTaste moves the departing agent's ratings the way the route does,
  // and the real purge runs over what the ledger says is unpurged.
  {
    const dir = temp('who');
    try {
      const W = require('../frontend/app/workstreams.js');
      const appSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
      const deleteWorkstreamSrc = A.fnBody(appSrc, 'function deleteWorkstream(id, groupDeleted)');
      const deleteAgentSrc = A.fnBody(appSrc, 'function deleteAgent(agentId)');
      A.ok(!!deleteWorkstreamSrc && !!deleteAgentSrc, 'the page\'s rail Delete and DELETE AGENT are lifted from app.js');
      let saved = null;
      const ctx = {
        agents: new Map([['agent', { id: 'agent', role: 'orchestrator' }], ['scribe', { id: 'scribe', role: 'specialist' }]]),
        fetch: async (url) => ({ ok: url === '/api/agent/delete', json: async () => ({ ok: true }) }),
        // persist(): the station save is Object.assign({ agent, … }, Workstreams.serialize()), sent as JSON
        persist: () => { saved = JSON.parse(JSON.stringify(Object.assign({ agent: { id: 'agent' } }, W.serialize()))); }
      };
      const page = new Function('W', 'CTX', `
        const Workstreams = W;
        const agents = CTX.agents; let agent = CTX.agents.get('agent');
        const SFX = { bad() {}, close() {} };
        const StationUI = { notify() {}, setRoster() {} };
        const World = { despawnAgent() {} };
        const station = null;
        const fetch = CTX.fetch;
        function focusAgent(id) { agent = agents.get(id); }
        function loadActiveStream() {}
        function renderRail() {}
        function recomposeOrchestrators() {}
        function pushRoster() {}
        function liveAgents() { return [...agents.values()]; }
        function persist() { CTX.persist(); }
        ${deleteWorkstreamSrc}
        ${deleteAgentSrc}
        return { deleteWorkstream, deleteAgent };
      `)(W, ctx);

      W.reset();
      const bakery = W.create('Bakery landing page', { agentId: 'scribe', activate: false });   // the scribe's rated work
      const card = W.create('Order flour', { kind: 'task', activate: false });                   // a task-board card
      const diary = W.create('Private diary', { activate: false });                               // the Commander deletes this
      const worker = W.adopt({ id: 'ws_diary_worker', title: 'worker thread', worker: true, parentStreamId: diary.id, agentId: 'scribe' });
      A.ok(!!worker, 'the diary has a delegated worker thread');
      const clock = clockAt(1000);
      const ledger = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now });
      ctx.persist();
      A.eq([ledger.observeSave(saved), ledger.since()], [[], 1000], 'the first save is the adopted first read (nothing deleted yet)');

      // memory: the scribe's ratings (the real feedback module) and what the diary session wrote
      const store = makeMemoryStore({ fs, path, workspaces: dir });
      const threads = makeThreadsStore({ fs, path, workspaces: dir });
      const runs = [{ runId: 'run_bakery_1', streamId: bakery.id, ts: 1100 }, { runId: 'run_bakery_2', streamId: bakery.id, ts: 1200 },
        { runId: 'run_diary', streamId: diary.id, ts: 1300 }, { runId: 'run_diary_worker', streamId: worker.id, ts: 1350 }];
      let scribeNb = [];
      for (const input of [{ runId: 'run_bakery_1', verdict: 'great', directive: 'design the landing page for the bakery', ref: { files: ['bakery.html'], colors: ['#c84b31'] } },
        { runId: 'run_bakery_2', verdict: 'miss', words: 'too busy, fewer colours', directive: 'redo the bakery hero', ref: { files: ['bakery-hero.html'] } }]) {
        const out = FeedbackMemory.apply(scribeNb, input, { now: 1100, nextId: l => 'note_' + (l.length + 1) });
        scribeNb = out.list;
      }
      await store.update('notebook:scribe', () => scribeNb);
      await store.update('notebook:agent', () => [{ id: 'note_1', title: 'Diary', body: 'the Commander wrote about their week', scope: 'stream', streamId: diary.id, sourceRunId: 'run_diary', createdAt: 1300 },
        { id: 'note_2', title: 'Worker', body: 'the worker read the diary', scope: 'global', sourceRunId: 'run_diary_worker', createdAt: 1350 }]);
      await threads.add({ id: 'th_bakery', title: 'Add a bakery order form', spec: 'bakery', sourceRef: { streamId: bakery.id, runId: 'run_bakery_1', date: 1100 } }, 1100);
      await threads.add({ id: 'th_diary', title: 'Plan the week from the diary', spec: 'diary', sourceRef: { streamId: diary.id, runId: 'run_diary', date: 1300 } }, 1300);

      // DELETE AGENT: the route adopts the scribe's ratings into the hero's notebook, then the page removes its sessions
      clock.set(2000);
      await store.update('notebook:agent', cur => FeedbackMemory.adoptTaste(cur, store.get('notebook:scribe'), null, 'scribe') || undefined);
      const adopted = store.get('notebook:agent').filter(r => r.adoptedFrom === 'scribe');
      A.eq(adopted.map(r => r.sourceRunId), ['run_bakery_1', 'run_bakery_2'], 'the route adopted both ratings with their sourceRunId (the review\'s premise)');
      A.ok(adopted.every(r => r.feedbackRef && r.feedbackDirective), '…each with its directive and its DESIGN ANCHOR reference');
      A.eq(await page.deleteAgent('scribe'), true, 'DELETE AGENT is accepted');
      A.ok(saved.deletedIds.indexOf(bakery.id) >= 0 && !W.get(bakery.id), 'its session left the rail (deletedIds, so the row never re-forms)');
      A.ok(saved.forgetIds.indexOf(bakery.id) < 0, '…but it is not a conversation the Commander deleted (not in forgetIds)');
      A.ok(!!W.get(worker.id), '…and a worker thread it holds stays with the conversation that asked for it');
      A.eq(ledger.observeSave(saved), [], 'so the save that removes it forgets nothing');
      // a task card's remove (station.manage_task calls Workstreams.del(task.id), no forget)
      A.ok(W.del(card.id) === true, 'the task card is removed');
      ctx.persist();
      A.eq([ledger.observeSave(saved), saved.deletedIds.indexOf(card.id) >= 0, saved.forgetIds.indexOf(card.id) < 0], [[], true, true], 'a task card\'s remove hides the row and forgets nothing');
      A.eq([ledger.deletedAt(bakery.id), ledger.deletedAt(card.id)], [0, 0], 'their history and recall read as before (no stamp)');
      // the Commander's rail Delete of the diary
      clock.set(3000);
      A.eq(page.deleteWorkstream(diary.id), true, 'the Commander deletes the diary from the rail');
      A.eq(saved.forgetIds, [diary.id, worker.id], 'the rail Delete marks the conversation forgotten, and its worker thread with it');
      A.eq(ledger.observeSave(saved), [diary.id, worker.id], 'only those are fresh deletes for the sidecar');
      A.eq(ledger.unpurged().map(e => e.id).sort(), [diary.id, worker.id].sort(), '…and only their memory is due a purge');
      const before = JSON.parse(JSON.stringify(store.get('notebook:agent').filter(r => r.adoptedFrom === 'scribe')));
      const counts = await forgetSessionMemory({ store, threads, agentIds: ['agent'], deleted: ledger.unpurged(), runs });
      ledger.markPurged(ledger.unpurged());
      const nb = store.get('notebook:agent');
      A.eq(nb.filter(r => r.adoptedFrom === 'scribe'), before, 'DELETE AGENT never strips adopted taste: both ratings survive the purge byte for byte');
      A.ok(nb.filter(r => r.adoptedFrom === 'scribe').every(r => r.feedbackRef && /bakery/.test(r.feedbackDirective)), '…their feedbackRef and directive included');
      A.ok(/LIKED the result of: design the landing page for the bakery/.test(before[0].content) && /DISLIKED: "too busy, fewer colours" \(on: redo the bakery hero\)/.test(before[1].content), '…in the words the Commander rated');
      A.eq([counts.notes, nb.some(r => r.id === 'note_1'), nb.some(r => r.id === 'note_2')], [2, false, false], 'the Commander\'s Delete still forgets what the diary and its worker wrote');
      A.eq(threads.list().map(t => t.id), ['th_bakery'], 'the idea mined from the deleted agent\'s session stays open; the diary\'s goes');
      // the page lists round-trip; a revive takes the id out of both (the sidecar keeps its stamp); NEW AGENT clears both
      W.init(JSON.parse(JSON.stringify(W.serialize())));
      A.eq(W.serialize().forgetIds, [diary.id, worker.id], 'forgetIds survives a save/load round-trip');
      A.ok(!!W.adopt({ id: diary.id, title: 'reopened', revive: true }) && W.serialize().forgetIds.indexOf(diary.id) < 0, 'a deliberate re-open takes the id out of forgetIds');
      ctx.persist();
      A.eq([ledger.observeSave(saved), ledger.deletedAt(diary.id)], [[], 3000], '…and the delete stands for what was said before it');
      A.eq(W.reset() && W.serialize().forgetIds, [], 'NEW AGENT clears the page\'s list');
      // an older page that never wrote forgetIds teaches nothing after the first read
      A.eq(ledger.observeSave({ deletedIds: ['ws_from_old_page'] }), [], 'a save with deletedIds and no forgetIds stamps nothing');
      A.eq(ledger.deletedAt('ws_from_old_page'), 0, '…so a side-effect delete from an older page is never forgotten');
    } finally { remove(dir); }
  }
  // the first boot of this build reads a save from before it: deletedIds only, every delete adopted (memory kept)
  {
    const dir = temp('who-upgrade');
    try {
      const ledger = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: () => 500 });
      A.eq(ledger.observeSave({ deletedIds: ['ws_old_a', 'ws_old_b'] }), [], 'an older save (no forgetIds) is the adopted first read');
      A.eq([ledger.since(), ledger.adopted().map(e => e.id), ledger.unpurged()], [500, ['ws_old_a', 'ws_old_b'], []],
        '…its deletes are forgotten from history and recall, and the memories they wrote are never purged');
      A.eq(ledger.list().map(e => e.live), [false, false], '…none counts as a live forgetIds entry, so the next save restamps nothing');
      A.eq(ledger.observeSave({ deletedIds: ['ws_old_a', 'ws_old_b'], forgetIds: [] }), [], 'the next save is no fresh delete');
      A.eq(ledger.observeSave(null), [], 'an unreadable save teaches nothing');
    } finally { remove(dir); }
  }

  // ---------------- 6. host wiring (static: sidecar/index.js is never required here) ----------------
  {
    const src = readSidecarSource();
    const ledgerAt = src.indexOf('const sessionTombstones = SessionTombstones.makeSessionTombstones(');
    const storeAt = src.indexOf('const transcriptStore = makeTranscriptStore(');
    A.ok(ledgerAt > 0 && storeAt > ledgerAt, 'the ledger is built before the transcript store reads anything');
    A.ok(/const transcriptStore = makeTranscriptStore\(\{[^\n]*deletedAt: id => sessionTombstones\.deletedAt\(id\)/.test(src), 'the transcript store reads through the ledger');
    const saveWrite = src.slice(src.indexOf('async function handleSaveWrite('), src.indexOf('async function handleGrowthRatings('));
    A.ok(/result\.ok === true && agentId === 'agent'\) observeDeletedSessions\(body\)/.test(saveWrite), 'every accepted station save feeds the ledger');
    const observeFn = src.slice(src.indexOf('function observeDeletedSessions(save)'), src.indexOf('function observeDeletedSessions(save)') + 400);
    A.ok(/fresh = sessionTombstones\.observeSave\(save\)/.test(observeFn), '…through observeSave, so only the save\'s forgetIds is forgotten (section 7)');
    const boot = src.slice(src.indexOf("const bootSave = saveStore.loadState('agent');"), src.indexOf("const bootSave = saveStore.loadState('agent');") + 900);
    A.ok(/bootSave\.status === 'ok' \|\| bootSave\.status === 'recovered' \? bootSave\.doc : bootSave\.status === 'absent' \? \{ forgetIds: \[\], deletedIds: \[\] \} : null/.test(boot)
      && /observeDeletedSessions\(bootLists\)/.test(boot), 'the save on disk feeds the ledger at boot (a new station with no save reads as empty first lists)');
    // the page side: only the rail Delete (and station.control session.delete, which runs it) marks a conversation forgotten
    const cmds = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationcommands.js'), 'utf8');
    A.ok(/action === 'remove'\) \{\s*if \(!Workstreams\.del\(task\.id\)\)/.test(cmds), 'station.manage_task\'s remove deletes the card without forget (task.manage runs unprompted under FULL POWER)');
    A.ok(/act === 'session\.delete'[\s\S]{0,400}\(save\.forgetIds \|\| \[\]\)\.indexOf\(id\) >= 0/.test(cmds), 'station.control session.delete proves the forget landed in the save');
    const wsSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'workstreams.js'), 'utf8');
    A.ok(/w\.agentId === aid && del\(w\.id\)\)/.test(A.fnBody(wsSrc, 'function removeByAgent(agentId)') || ''), 'removeByAgent deletes without forget');
    const purge = src.slice(src.indexOf('function forgetDeletedSessionMemory()'), src.indexOf('function forgetDeletedSessionMemory()') + 1600);
    A.ok(/sessionTombstones\.unpurged\(\)/.test(purge) && /chanEmit\('memory\.forget', \{ agentId: f\.agentId, id: f\.id, reason: 'session-deleted' \}\)/.test(purge),
      'the purge runs only over unpurged deletes (an adopted one never is) and announces every removed record as memory.forget');
    A.ok(/if \(fresh\.length\) forgetDeletedSessionMemory\(\)/.test(src) && /if \(sessionTombstones\.unpurged\(\)\.length\) forgetDeletedSessionMemory\(\)/.test(src), 'a fresh delete purges memory, and an unfinished purge is retried at boot');
    const recent = src.slice(src.indexOf('function nightshiftRecentRuns()'), src.indexOf('function nightshiftContextPack('));
    A.ok(/!sessionRunForgotten\(r\)/.test(recent), 'RECENT ACTIVITY skips a deleted session\'s runs');
    const away = src.slice(src.indexOf('async function awayBriefingInputs('), src.indexOf('function tzOffsetOf('));
    A.ok(/filter\(r => !sessionRunForgotten\(r\)\)/.test(away), 'the away briefing never reports a deleted session\'s runs');
    const focus = src.slice(src.indexOf('function nightFocusInputs()'), src.indexOf('function nightFocusInputs()') + 2000);
    A.ok(/!sessionRunForgotten\(r\)/.test(focus), 'the night focus never counts a deleted session\'s titles');
  }

  A.report('session-tombstones');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
