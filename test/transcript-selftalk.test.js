/* node test/transcript-selftalk.test.js — THE STATION'S SELF-TALK IS NOT THE COMMANDER'S WORDS (bug 4dee26ba).

   The quiet title call (its prompt is the session's substantive user messages plus 200 characters of the reply), the
   goal judge, pitch, autopilot and every other reason-only internal call run with no workstream, so the sidecar filed
   their prompt and reply in the shared 'global' stream as ordinary user/assistant rows. recall_conversation then quoted
   them back as "you said …", and because they live in 'global' a DELETED session's opening lines survived there (the
   session tombstone filters by stream). This proves, on the real modules (temp dirs, real fs):

     1. WRITE — runOnce stamps a streamless internal run's rows dispatchState 'internal' on both transcript writers
        (static: the run-end append path and makeRunTranscript), and a stream-bound run keeps its exact stamp.
     2. READ — search (stream + all, in-memory and segmented io), the recall tool, and scroll never return an
        'internal' row; a real 'global' row is still found. Nothing is deleted: the rows stay on disk.
     3. ALREADY WRITTEN — rows a 0.13.5 station filed in 'global' before the stamp existed (the title prompt's
        "Assistant reply (context only):" tail, an "INTERNAL —" directive, the goal judge's prompt) are skipped by the
        same readers; the same words in a named session are the Commander's and are still found. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeTranscriptStore, projectConversation } = require('../sidecar/transcriptstore.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeRecallTool } = require('../sidecar/tools/builtin/recall.js');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-selftalk-' + name + '-')); }
const clockAt = start => { let t = start; return { now: () => t, set: v => { t = v; } }; };

(async () => {
  // ---------------- 1. WRITE: the host stamps streamless self-talk 'internal' ----------------
  {
    const src = readSidecarSource();
    const rule = src.match(/const transcriptState = \(o\.dispatchDelivery && o\.dispatchDelivery\.state\) \|\| \(internal && !o\.streamId \? 'internal' : undefined\);/);
    A.ok(!!rule, 'runOnce names ONE transcript state: the dispatch envelope\'s, else \'internal\' for streamless self-talk');
    const mk = src.indexOf('const runTranscript = makeRunTranscript({');
    A.ok(mk > 0 && rule && rule.index < mk && /dispatchState: transcriptState,/.test(src.slice(mk, mk + 400)), 'makeRunTranscript writes with that state');
    const endAt = src.indexOf("if (title && !retryDirective && !o.syntheticTrigger && !runTranscript.directiveWritten()) transcriptStore.append(");
    const endPath = endAt > 0 ? src.slice(endAt, endAt + 900) : '';
    A.ok(/content: title,[^\n]*dispatchState: transcriptState \}\);/.test(endPath), 'the run-end directive append writes with that state');
    A.ok(/transcriptStore\.appendNew\(o\.streamId, agentId, result\.messages, \{[^\n]*dispatchState: transcriptState \}\);/.test(endPath), 'the run-end turn append writes with that state');
    A.ok(!/dispatchState: o\.dispatchDelivery && o\.dispatchDelivery\.state/.test(endPath), 'no run-end writer keeps the envelope-only state');
  }

  // ---------------- 2 + 3. READ: search / recall / scroll skip self-talk ----------------
  async function readers(label, makeIo) {
    const dir = temp(label);
    try {
      const clock = clockAt(100);
      const store = makeTranscriptStore({ io: makeIo(dir), clock });
      const say = (streamId, role, content, extra) => { clock.set(clock.now() + 10); return store.append(Object.assign({ streamId, agentId: 'agent', role, content, taint: null }, extra || {})); };
      // what a 0.14.0 station writes for the quiet title call: both rows stamped internal (streamless → 'global')
      say(undefined, 'user', 'Plan the zebrafish aquarium rebuild\n\nAssistant reply (context only): Sure — zebrafish tanks need', { dispatchState: 'internal' });
      say(undefined, 'assistant', 'Zebrafish Aquarium Rebuild', { dispatchState: 'internal' });
      // what a 0.13.5 station already wrote: the same self-talk, unstamped, in 'global'
      say('global', 'user', 'Fix the walrus invoice export\n\nAssistant reply (context only): The walrus export fails because');
      say('global', 'user', 'INTERNAL — SELF-DIRECTED WORK. The Commander is away. Do not run any tools. walrus backlog');
      say('global', 'user', 'Goal:\nship the walrus importer\n\nAgent\'s most recent response:\nwalrus done\n\nIs the goal satisfied — done or continue?');
      // the Commander's own words: a real global row, and a named session that quotes the same shapes
      say('global', 'user', 'remember the walrus password rotation');
      say('ws_named', 'user', 'INTERNAL — walrus memo I wrote myself');
      say('ws_named', 'user', 'zebrafish tank notes for the named session');

      const allHits = store.search('ws_named', 'zebrafish walrus', { scope: 'all', limit: 50 });
      const said = allHits.map(h => h.content);
      A.ok(!said.some(c => /context only|Zebrafish Aquarium Rebuild|SELF-DIRECTED|Is the goal satisfied/.test(c)), label + ': search (scope all) returns no self-talk row: ' + JSON.stringify(said));
      A.ok(said.includes('remember the walrus password rotation'), label + ': a real global row is still found');
      A.ok(said.includes('INTERNAL — walrus memo I wrote myself') && said.includes('zebrafish tank notes for the named session'), label + ': a named session\'s words are the Commander\'s and are still found');
      const globalHits = store.search(undefined, 'walrus zebrafish', { limit: 50 }).map(h => h.content);
      A.eq(globalHits, ['remember the walrus password rotation'], label + ': search of the global stream itself finds only the real row');

      const tool = makeRecallTool({ transcriptStore: store, ownStreamOnly: () => false }).recallTool;
      const recalled = await tool.run({ query: 'zebrafish walrus', scope: 'all', limit: 20 }, { streamId: 'ws_named' });
      A.ok(!/context only|Aquarium Rebuild|SELF-DIRECTED|Is the goal satisfied/.test(recalled.content), label + ': recall_conversation never quotes self-talk as "you said": ' + recalled.content.slice(0, 300));
      A.ok(/password rotation/.test(recalled.content), label + ': …and still recalls the real global row');

      const realRow = store.search(undefined, 'password rotation', { limit: 1 })[0];
      const scroll = await tool.run({ around: realRow.ts, stream: 'global', limit: 20 }, { streamId: 'ws_named' });
      A.ok(/password rotation/.test(scroll.content) && !/context only|Aquarium Rebuild|SELF-DIRECTED|Is the goal satisfied/.test(scroll.content), label + ': scroll around a real global moment skips the self-talk beside it: ' + scroll.content.slice(0, 300));

      // never deleted: the rows stay on disk and in the raw stream read
      A.eq(store.history('global', { limit: 50 }).length, 6, label + ': every global row is still stored (filtering, not deletion)');
      // COMMS display already hides stamped rows (projectConversation); the stamp makes new self-talk vanish there too
      A.eq(projectConversation(store.history('global', { limit: 50 })).filter(r => r.dispatchState === 'internal').length, 0, label + ': the conversation projection shows no stamped self-talk');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  await readers('ram', () => ({ readAll() { return []; }, append() {} }));
  await readers('segmented', dir => makeSegmentedTranscriptIo({ fs, path, root: path.join(dir, 'history'), segmentBytes: 600, recentPerStream: 3 }));

  // ---------------- 4. BROWSE: the 'global' listing never previews self-talk ----------------
  // A 0.13.5 title prompt / goal judge whose basis is a long first message: the segment summary cuts the preview at
  // 160 characters, so the marker that names it self-talk is gone from the cut text. The listing must still not quote
  // it — not even a DELETED session's opening line — and must still preview a real Commander row.
  async function browse(label, makeIo, legacy, reply) {
    const dir = temp('browse-' + label);
    try {
      const clock = clockAt(100);
      const deleted = {};
      const store = makeTranscriptStore({ io: makeIo(dir), clock, deletedAt: id => deleted[id] || 0 });
      const say = (streamId, role, content, extra) => { clock.set(clock.now() + 10); return store.append(Object.assign({ streamId, agentId: 'agent', role, content, taint: null }, extra || {})); };
      const opening = 'I need help drafting the letter to my landlord about the mold in the bedroom and the rent I withheld in March, please keep this private between us and do not mention my employer';
      A.ok(opening.length > 160, label + ': the basis is longer than the summary preview');
      say('global', 'user', 'remember the walrus password rotation');            // the Commander's own global words
      say('ws_secret', 'user', opening);
      // pre-stamp self-talk: the prompt AND its reply, one run id, no dispatchState (what a 0.13.5 station filed)
      say('global', 'user', legacy(opening), { sourceRunId: 'run_legacy_selftalk' });
      const replyRow = say('global', 'assistant', reply, { sourceRunId: 'run_legacy_selftalk' });
      say('global', 'assistant', 'the walrus rotation is due Friday, mold aside', { sourceRunId: 'run_real_global' });   // a real reply
      deleted.ws_secret = clock.now() + 1;                                         // the session is deleted
      // REPLIES: the title / the goal judge's verdict restating the goal never come back from recall, nor scroll
      const replies = st => {
        const hits = st.search('ws_other', 'landlord mold letter rent withheld', { scope: 'all', limit: 50 }).map(h => h.content);
        A.ok(!hits.some(c => /landlord/i.test(c)), label + ': search (scope all) never returns the legacy self-talk reply: ' + JSON.stringify(hits));
        A.ok(hits.includes('the walrus rotation is due Friday, mold aside'), label + ': a real global reply is still found: ' + JSON.stringify(hits));
        const win = st.around('global', replyRow.ts, { window: 10 }).map(r => r.content);
        A.ok(!win.some(c => /landlord/i.test(c)) && win.includes('remember the walrus password rotation'), label + ': scroll around it skips the reply and keeps the real rows: ' + JSON.stringify(win));
      };
      replies(store);
      if (!/^ram/.test(label)) {
        // after a restart, with the prompt row no longer in RAM (the reply's run is known only from disk)
        const reopened = makeTranscriptStore({ io: makeIo(dir), clock, deletedAt: id => deleted[id] || 0, ramPerStream: 1 });
        A.ok(!reopened.history('global', { limit: 1 }).some(r => r.sourceRunId === 'run_legacy_selftalk' && r.role === 'user'), label + ': the reopened store does not hold the prompt in RAM');
        replies(reopened);
      }
      clock.set(clock.now() + 100);
      say(undefined, 'user', 'other basis\n\nAssistant reply (context only): x', { dispatchState: 'internal' });   // new self-talk
      say(undefined, 'assistant', 'Other Title', { dispatchState: 'internal' });

      const g = store.streams({ limit: 20 }).find(s => s.streamId === 'global');
      A.ok(g && !/landlord|Goal:/.test(g.preview), label + ': the global listing never previews the self-talk prompt: ' + JSON.stringify(g && g.preview));
      A.eq(g && g.preview, 'remember the walrus password rotation', label + ': it previews the newest real Commander row');
      A.ok(!store.streams({ limit: 20 }).some(s => s.streamId === 'ws_secret'), label + ': the deleted session is not listed');
      const tool = makeRecallTool({ transcriptStore: store, ownStreamOnly: () => false }).recallTool;
      const listing = (await tool.run({}, { streamId: 'ws_other' })).content;
      A.ok(!/landlord|mold/.test(listing), label + ': recall browse never quotes the deleted session\'s opening line: ' + listing);
      A.ok(/\[global\][^\n]*walrus password rotation/.test(listing), label + ': recall browse lists global with the real row: ' + listing);

      // a long real global row reads exactly as the summary always cut it (160 characters, whitespace collapsed)
      const long = 'Please   keep a running list of every invoice\nwe send to the walrus importer, ' + 'x'.repeat(200);
      say('global', 'user', long);
      const g2 = store.streams({ limit: 20 }).find(s => s.streamId === 'global');
      A.eq(g2 && g2.preview, long.replace(/\s+/g, ' ').trim().slice(0, 160), label + ': an ordinary global preview is unchanged');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const titlePrompt = basis => basis + '\n\nAssistant reply (context only): Sure, here is a draft of the letter';
  const goalPrompt = basis => 'Goal:\n' + basis + '\n\nAgent\'s most recent response:\nDraft done.\n\nIs the goal satisfied — done or continue?';
  const segIo = dir => makeSegmentedTranscriptIo({ fs, path, root: path.join(dir, 'history'), segmentBytes: 600, recentPerStream: 3 });
  const titleReply = 'Landlord Mold Letter Withheld Rent';
  const goalReply = 'continue — the letter to the landlord about the mold and the withheld rent is not drafted yet';
  await browse('ram-title', () => ({ readAll() { return []; }, append() {} }), titlePrompt, titleReply);
  await browse('ram-goal', () => ({ readAll() { return []; }, append() {} }), goalPrompt, goalReply);
  await browse('segmented-title', segIo, titlePrompt, titleReply);
  await browse('segmented-goal', segIo, goalPrompt, goalReply);

  A.report('transcript-selftalk');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
