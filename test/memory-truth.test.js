/* node test/memory-truth.test.js — the MEMORY TRUTH lane (2026-10-11). A user reported: "I'm quite explicit with
   instructions. But they will randomly recall from OLD memories. Not save or update from old instructions, even when
   stated as saved." Every seam that let an older instruction beat a newer one is locked here, positive AND negative:
     1. recall lines carry their saved/updated date, and the header states "newer wins, the user's latest message wins"
     2. a correction in the Commander's PROVEN words keeps their authority; an unproven one reads "[corrected, …]"
        (proof = owner surface + untainted + their sentence holds the note's words with the same polarity)
     3. a same-subject write (Jaccard 0.3–0.6) is saved but names the notes it may replace; correcting the old one to
        the new text folds this run's fresh copy into it (one active belief, old text archived)
     4. a standing instruction in the Commander's own words defaults to every conversation, not one thread
     5. recency = when a memory was WRITTEN (recall stamps no longer keep an old belief "recent"); ties go newer
     6. receipts: notebook.write registers ITS run's save; a named run never borrows another run's receipt list,
        and COMMS shows each save once even when a run saves mid-run AND after it ends
     8. an "unhelpful" rating trust cannot absorb becomes bounded distrust that really demotes the memory
   (6 = the dossier seed and 9 = backup import live in test/dossier.test.js and test/notebookrestore.test.js.) */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeNotebookTools } = require('../sidecar/tools/builtin/notebook.js');
const { rank, renderRecall } = require('../sidecar/context.js');
const memcore = require('../sidecar/memcore.js');

const DAY = 864e5;
const T0 = Date.UTC(2026, 8, 2, 12);    // 2026-09-02
const T1 = Date.UTC(2026, 9, 11, 12);   // 2026-10-11

function harness(at, extra) {
  const data = {};
  const store = { get: k => data[k], set: (k, v) => { data[k] = v; } };
  let now = at;
  const t = makeNotebookTools(Object.assign({ store, clock: { now: () => now }, findSimilar: memcore.findSimilar, similarity: memcore.tokenJaccard }, extra || {}));
  return { t, store, notes: () => data['notebook:agent'] || [], seed: list => { data['notebook:agent'] = list; }, tick: ms => { now += ms; } };
}

// ---- 1. dates + the newer-wins rule in recall ----
{
  const text = renderRecall([
    { id: 'note_1', title: 'Indentation', body: 'User prefers tabs', confirmation: 'user-confirmed', createdAt: T0 },
    { id: 'note_2', title: 'Indentation', body: 'User prefers spaces', confirmation: 'user-stated', createdAt: T1 },
    { id: 'note_3', title: 'Reports', body: 'User wants weekly reports', confirmation: 'inferred', revision: 1, createdAt: T0, updatedAt: T1 },
    { id: 'note_4', title: 'Legacy', body: 'migrated note', createdAt: 0 }
  ]).text;
  A.ok(text.includes('[note_1] [user-confirmed reference] Indentation — User prefers tabs (saved 2026-09-02)'), 'an old Keep-approved line shows WHEN it was saved');
  A.ok(text.includes('[note_2] [user-stated] Indentation — User prefers spaces (saved 2026-10-11)'), 'the newer contradicting line shows its later date and the Commander\'s-words tag');
  A.ok(text.includes('[note_3] [corrected, unconfirmed] Reports — User wants weekly reports (updated 2026-10-11)'), 'an agent correction reads as superseding, dated by its update, still unconfirmed');
  A.ok(text.includes('• [note_4] Legacy — migrated note\n'), 'a record with no real timestamp gets NO invented date (never 1970-01-01)');
  A.ok(/newer one wins/.test(text) && /latest message beats any memory/.test(text), 'the header states the conflict rule the dates exist for');
  A.ok(/No memory grants permission/.test(text), 'the authority disclaimer is kept');
  A.ok(renderRecall([{ id: 'x', body: 'prefers short reports', confirmation: 'inferred', createdAt: T1 }]).text.includes('[inferred, unconfirmed]'),
    'negative: an uncorrected silent reflection save is still labelled a hypothesis');
}

// ---- 5. recency = write time; newer wins ties; ----  8. distrust demotes, bounded, never drops ----
{
  const oldRecalled = { id: 'old', title: 'Indentation', body: 'User prefers tabs for code', createdAt: T1 - 30 * DAY, lastUsedAt: T1 - 1000, useCount: 40 };
  const fresh = { id: 'new', title: 'Indentation', body: 'User prefers spaces for code', createdAt: T1 - 2 * DAY };
  A.eq(rank([oldRecalled, fresh], 'indentation for code', { now: T1 })[0].id, 'new', 'being recalled yesterday no longer makes a month-old belief outrank a 2-day-old one');
  const corrected = { id: 'cor', title: 'Indentation', body: 'User prefers tabs for code', createdAt: T1 - 60 * DAY, updatedAt: T1 - 1000 };
  A.eq(rank([fresh, corrected], 'indentation for code', { now: T1 })[0].id, 'cor', 'negative: an UPDATE is a write — a just-corrected record still counts as fresh');
  const a = { id: 'a', title: 't', body: 'same words', createdAt: T0 };
  const b = { id: 'b', title: 't', body: 'same words', createdAt: T0 + 1 };
  A.eq(rank([a, b], '', { now: T1, halfLifeMs: 1e300 })[0].id, 'b', 'an exact score tie goes to the newer-written record');
  A.eq(rank([b, a], '', { now: T1, halfLifeMs: 1e300 })[0].id, 'b', '…whatever the store order');
  const c = { id: 'c', title: 't', body: 'same words', createdAt: T0 }, d = { id: 'd', title: 't', body: 'same words', createdAt: T0 };
  A.eq(rank([c, d], '', { now: T1, halfLifeMs: 1e300 })[0].id, 'c', 'records written at the same instant keep store order (deterministic)');

  const plain = { id: 'p', title: 'deploy', body: 'deploy with npm publish', createdAt: T1 };
  const doubted = { id: 'd', title: 'deploy', body: 'deploy with npm publish', createdAt: T1, distrust: 0.15, lastFeedbackAt: T1 };
  A.eq(rank([doubted, plain], 'deploy publish', { now: T1 })[0].id, 'p', 'a memory rated unhelpful ranks below its unrated twin');
  A.eq(rank([doubted, plain], 'deploy publish', { now: T1 }).length, 2, 'demoted, never dropped (the relevance floor is unchanged)');
  A.eq(rank([plain, Object.assign({}, doubted, { id: 'pd', pinned: true, distrust: 1 })], 'deploy', { now: T1 })[0].id, 'pd', 'negative: a pinned record keeps its hard top');
  const strong = { id: 's', title: 'deploy ritual', body: 'deploy ritual: npm publish then tag', createdAt: T1, distrust: 50, lastFeedbackAt: T1 };
  const weak = { id: 'w', title: 'misc', body: 'deploy notes', createdAt: T1 };
  A.eq(rank([strong, weak], 'deploy ritual publish tag', { now: T1 }).map(r => r.id).join(','), 's,w', 'a corrupt distrust is clamped: the penalty is bounded and a far more relevant record still wins');
}

(async () => {
  const words = 'From now on, use spaces instead of tabs for indentation.';
  const ctxA = (extra) => Object.assign({ agentId: 'agent', runId: 'r1', streamId: 'chat-a', commanderWords: words }, extra || {});

  // ---- 2 + 4. provenance proven from the Commander's words; standing instructions go to every conversation ----
  {
    const h = harness(T1);
    const r = await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces over tabs for indentation', pinned: true }, ctxA());
    const n = h.notes()[0];
    A.eq(n.confirmation, 'user-stated', 'a note that IS the Commander\'s sentence is recorded as their words');
    A.eq(n.statedBy && n.statedBy.quote, 'From now on, use spaces instead of tabs for indentation', 'with the proving sentence kept as evidence');
    A.eq(n.scope, 'global', 'a standing instruction ("from now on") defaults to every conversation');
    A.eq(n.streamId, null, '…not pinned to the chat it was said in');
    A.ok(/Scope: every conversation/.test(r.content) && /Commander's own words/.test(r.content), 'the result says where it applies and whose words it is');
    A.eq(rank(h.notes(), 'write the parser', { now: T1, streamId: 'chat-b' }).map(x => x.id).join(','), 'note_1', 'the pinned standing order reaches a DIFFERENT chat');
  }
  {
    const h = harness(T1);
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers tabs for indentation' }, ctxA({ commanderWords: 'I hate tabs for indentation.' }));
    A.eq(h.notes()[0].confirmation, undefined, 'negative: "I hate tabs" never proves "prefers tabs" (polarity must match)');
    A.eq(h.notes()[0].scope, 'stream', '…and an unproven note keeps the thread default');
  }
  {
    const h = harness(T1);
    await h.t.writeTool.run({ title: 'UI', body: 'User prefers dark mode dashboards' }, ctxA({ commanderWords: 'Make the dashboard in dark mode.' }));
    A.eq(h.notes()[0].confirmation, undefined, 'negative: a one-off task sentence is not a stated preference');
  }
  {
    const h = harness(T1);
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces over tabs for indentation' }, ctxA({ commanderWords: '' }));
    A.eq(h.notes()[0].confirmation, undefined, 'negative: no host-attested words (a guest, a routine, a worker) = no claim');
    A.eq(h.notes()[0].scope, 'stream', '…and no widening');
  }
  {
    const h = harness(T1);
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces over tabs for indentation' }, ctxA({ connectorAuthority: { taintedBy: () => 'web_fetch example.com' } }));
    const n = h.notes()[0];
    A.ok(n.confirmation === undefined && n.taintedBy, 'negative: a tainted run can never mint user-stated (taint rules intact)');
  }
  {
    const h = harness(T1);
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces over tabs for indentation' }, ctxA({ projectRoot: 'C:/work/acme' }));
    const n = h.notes()[0];
    A.ok(n.scope === 'stream' && n.projectRoot === 'C:/work/acme' && n.confirmation === 'user-stated', 'a project session keeps its project tier (already every chat in that project)');
    const h2 = harness(T1);
    await h2.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces over tabs for indentation', scope: 'stream' }, ctxA());
    A.eq(h2.notes()[0].scope, 'stream', 'an explicit scope always wins');
  }

  // Shared vocabulary is not evidence of the same instruction. Preserve relations and qualifiers.
  for (const [said, note] of [
    ['From now on, use spaces instead of tabs for indentation.', 'User prefers tabs over spaces for indentation'],
    ['I prefer small blue buttons for the settings page.', 'User prefers large blue buttons for the settings page'],
    ['I prefer spaces, not tabs, for indentation.', 'User does not prefer spaces over tabs for indentation'],
    ['If I prefer spaces for indentation, ask me first.', 'User prefers spaces for indentation'],
    ['I prefer spaces only for Python indentation.', 'User prefers spaces for Python indentation'],
    ['I prefer spaces or tabs for indentation.', 'User prefers spaces and tabs for indentation'],
    ['I prefer spaces for indentation.', 'User always prefers spaces for indentation'],
    ['I prefer spaces for indentation.', 'User prefers spaces for indentation now'],
    ['I prefer spaces for indentation.', 'From now on, use spaces for indentation'],
    ['Someone said "I prefer spaces for indentation".', 'User prefers spaces for indentation']
  ]) {
    const h = harness(T1);
    const result = await h.t.writeTool.run({title:'Indentation',body:note,pinned:true},ctxA({commanderWords:said}));
    const n = h.notes()[0];
    A.ok(n.confirmation !== 'user-stated' && !n.statedBy, 'no user authority for an altered claim: ' + note + ' / ' + said);
    A.eq(n.scope, 'stream', 'an unproven claim is not widened across conversations');
    A.ok(!/Commander.s own words/.test(result.content), 'the save receipt does not claim the user stated the alteration');
  }

  // ---- 2. corrections: proven words keep the Commander's authority; unproven reads as a superseding inference ----
  {
    const kept = () => [{ id: 'note_1', kind: 'note', title: 'Indentation', body: 'User prefers tabs for indentation', content: 'User prefers tabs for indentation',
      confirmation: 'user-confirmed', scope: 'global', streamId: null, createdAt: T0, trust: 0.3, pinned: false }];
    const h = harness(T1); h.seed(kept());
    const r = await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces for indentation', replaceId: 'note_1', previousBody: 'User prefers tabs for indentation' },
      ctxA({ runId: 'r2', commanderWords: 'Actually I prefer spaces for indentation now.' }));
    const n = h.notes()[0];
    A.eq(n.confirmation, 'user-confirmed', 'a correction in the Commander\'s proven words keeps the confirmed status of the belief it replaces');
    A.ok(/Recorded as the Commander's own words/.test(r.content), 'and the result says so');
    A.ok(renderRecall(h.notes()).text.includes('[note_1] [user-confirmed reference] Indentation — User prefers spaces for indentation (updated 2026-10-11)'), 'recall shows the new text, confirmed, dated as an update');
    const h2 = harness(T1); h2.seed(kept());
    await h2.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces for indentation', replaceId: 'note_1', previousBody: 'User prefers tabs for indentation' }, ctxA({ runId: 'r2', commanderWords: '' }));
    A.eq(h2.notes()[0].confirmation, 'inferred', 'negative: an unproven correction is the agent\'s inference — never laundered into confirmed');
    A.ok(renderRecall(h2.notes()).text.includes('[corrected, unconfirmed]'), '…rendered as a correction, not as a fresh hypothesis');
    A.eq(h2.notes()[0].statedBy, undefined, 'the archived text\'s proof does not carry over to new text');
  }

  // ---- 3. a pair the subject key cannot read: saved, the old note named, and the correction folds the fresh copy ----
  //      (a pair it CAN read — "prefers tabs" then "prefers spaces" — supersedes at write time: test/memory-truth.table.test.js)
  {
    const h = harness(T0);
    await h.t.writeTool.run({ title: 'Drafting', body: 'User drafts posts in Notion' }, { agentId: 'agent', runId: 'r1' });
    h.tick(DAY);
    const r = await h.t.writeTool.run({ title: 'Drafting', body: 'User now drafts posts in Obsidian' }, { agentId: 'agent', runId: 'r2' });
    A.ok(/^Saved note "Drafting" \(note_2\)/.test(r.content), 'a 0.3–0.6 overlap is still SAVED (it may be a separate fact)');
    A.ok(r.content.includes('Similar notes you already hold:\n[note_1] Drafting: User drafts posts in Notion'), 'the result names the note it may contradict, with its exact text');
    A.ok(/replaceId/.test(r.content) && /folds note_2 into it/.test(r.content), 'and tells the model the supersede path');
    A.eq(h.notes().length, 2, 'nothing was deleted on the model\'s behalf');
    const f = await h.t.writeTool.run({ title: 'Drafting', body: 'User now drafts posts in Obsidian', replaceId: 'note_1', previousBody: 'User drafts posts in Notion' }, { agentId: 'agent', runId: 'r2' });
    A.eq(h.notes().length, 1, 'retiring the old note folds this run\'s fresh copy: ONE active belief');
    A.ok(h.notes()[0].id === 'note_1' && h.notes()[0].body === 'User now drafts posts in Obsidian' && h.notes()[0].history[0].body === 'User drafts posts in Notion', 'the survivor holds the new text with the old one archived');
    A.ok(/Folded note_2/.test(f.content), 'the result reports the fold');
    const u = await h.t.writeTool.run({ title: 'Deploy', body: 'staging deploys from the release branch' }, { agentId: 'agent', runId: 'r3' });
    A.ok(!/Similar notes/.test(u.content), 'negative: an unrelated save lists nothing');
  }
  {
    const h = harness(T0);
    await h.t.writeTool.run({ title: 'Drafting', body: 'User drafts posts in Notion' }, { agentId: 'agent', runId: 'r1' });
    await h.t.writeTool.run({ title: 'Drafting', body: 'User now drafts posts in Obsidian' }, { agentId: 'agent', runId: 'r2' });
    await h.t.writeTool.run({ title: 'Drafting', body: 'User now drafts posts in Obsidian', replaceId: 'note_1', previousBody: 'User drafts posts in Notion' }, { agentId: 'agent', runId: 'r3' });
    A.eq(h.notes().length, 2, 'negative: only a copy made by the SAME run is folded — another run\'s note is never deleted');
  }

  // ---- 6/7. receipts: each committed save is reported for ITS run ----
  {
    const got = [];
    const h = harness(T1, { onSaved: (aid, runId, item) => got.push({ aid, runId, item }) });
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers tabs' }, { agentId: 'agent', runId: 'r9' });
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces', replaceId: 'note_1', previousBody: 'User prefers tabs' }, { agentId: 'agent', runId: 'r9' });
    await h.t.writeTool.run({ title: 'Indentation', body: 'User prefers spaces, really' }, { agentId: 'agent', runId: 'r9' });   // near-dupe: refused
    await h.t.writeTool.run({ title: 'Other', body: 'a fixture without a run' }, { agentId: 'agent' });
    A.eq(got.length, 2, 'one receipt per committed write — none for a refused near-dupe or a run-less write');
    A.ok(got[0].runId === 'r9' && got[0].item.id === 'note_1' && got[0].item.key === 'note_1@0' && got[0].item.saved === true && got[0].item.revised === false, 'the save is registered for its own run');
    A.ok(got[1].item.key === 'note_1@1' && got[1].item.revised === true && got[1].item.content === 'User prefers spaces', 'an update is its own receipt line (new key), carrying the new text');
  }
  {
    const merged = memcore.mergeReceipts([{ id: 'note_1', key: 'note_1@0', content: 'a', saved: true }], [{ id: 'note_1', key: 'note_1@1', content: 'b', saved: true }, { id: 'prop_1', content: 'c' }]);
    A.eq(merged.map(p => p.key || p.id).join(','), 'note_1@0,note_1@1,prop_1', 'a run\'s batch merges mid-run saves with the post-run stash');
    A.eq(memcore.mergeReceipts([{ id: 'x', content: 'old' }], [{ id: 'x', content: 'new' }]).map(p => p.content).join(','), 'new', 'the same key replaces, never duplicates');
    const byRun = new Map([['prev', { agentId: 'agent', runId: 'prev', proposals: [{ id: 'note_7', saved: true }] }]]);
    const latest = new Map([['agent', 'prev']]);
    A.eq(memcore.receiptBatchFor(byRun, latest, 'agent', 'this-run'), null, 'a NAMED run with nothing registered gets nothing — never the previous run\'s list');
    A.eq(memcore.receiptBatchFor(byRun, latest, 'agent', '').runId, 'prev', 'only an un-named (legacy) fetch may fall back to the newest batch');
    A.eq(memcore.receiptBatchFor(byRun, latest, 'nova', 'prev'), null, 'negative: another agent\'s batch is never served');
  }
  {
    // source locks: the host wires the seams (idiom of beat-coordination.test)
    const idx = readSidecarSource();
    A.ok(/memcore\.receiptBatchFor\(proposalsByRun, latestProposalRun, agent, runId\)/.test(idx), 'serveProposals resolves a run\'s batch through receiptBatchFor');
    A.ok(!/const lr = latestProposalRun\.get\(agent\); batch = lr/.test(idx), 'the cross-run fallback is gone');
    A.ok(/onSaved: recordRunReceipt/.test(idx), 'notebook.write reports its saves as this run\'s receipts');
    A.ok(/memcore\.mergeReceipts\(prev && prev\.agentId === agentId \? prev\.proposals : \[\], items\)/.test(idx), 'a later stash MERGES into the run\'s batch instead of overwriting it');
    // both anchors must exist: a renamed capture call (indexOf -1) must not pass the ordering check (review tests-09)
    const captureAt = idx.indexOf("TrustedLearning.capture(messages, 'interactive-owner')");
    // the files expand in the run host (runOnceCore, run-paths review M3), which runs after handleRun captured the words
    const expandAt = idx.indexOf('messages = await attachments.expandForRun(messages, agentId');
    A.ok(idx.includes('TrustedLearning.eligible(') && idx.includes('const commanderWords = trustedLearningInput ? trustedLearningInput.content') && captureAt >= 0 && expandAt > captureAt && /ownerTrusted, commanderWords,/.test(idx),
      'commanderWords reach the tool ctx only from the owner\'s own surfaces (never a worker, a group transcript or a guest)');
    // COMMS: each save renders once per run, and a later save of the same run is not swallowed
    const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    A.ok(!/receiptRunsSeen/.test(chat), 'the once-per-run receipt gate is gone');
    const s = chat.indexOf('  function unshownReceipts(');
    A.ok(s > 0, 'chat.js defines unshownReceipts');
    const src = chat.slice(s, chat.indexOf('\n  }\n', s) + 4);
    const sb = { receiptShown: new Map() };
    vm.createContext(sb);
    vm.runInContext(src + '\nthis.unshownReceipts = unshownReceipts;', sb);
    A.eq(sb.unshownReceipts('r1', [{ id: 'note_1', key: 'note_1@0' }]).length, 1, 'a mid-run save renders');
    A.eq(sb.unshownReceipts('r1', [{ id: 'note_1', key: 'note_1@0' }, { id: 'note_2' }]).map(p => p.id).join(','), 'note_2', 'the post-run fetch renders only what is new for that run');
    A.eq(sb.unshownReceipts('r1', [{ id: 'note_1', key: 'note_1@1' }]).length, 1, 'an update of the same memory is a new line');
    A.eq(sb.unshownReceipts('r2', [{ id: 'note_1', key: 'note_1@0' }]).length, 1, 'another run starts clean');
  }

  // ---- 8. "unhelpful" on a zero-trust memory really demotes it (bounded); "helpful" pays it back first ----
  {
    const h = harness(T1);
    h.seed([{ id: 'note_1', kind: 'note', title: 'deploy', body: 'deploy with npm publish', createdAt: T1, trust: 0 },
      { id: 'note_2', kind: 'note', title: 'deploy', body: 'deploy with npm publish', createdAt: T1, trust: 0 }]);
    const r = await h.t.feedbackTool.run({ id: 'note_1', rating: 'unhelpful' }, { agentId: 'agent' });
    A.eq(h.notes()[0].trust, 0, 'trust stays clamped at 0');
    A.eq(h.notes()[0].distrust, 0.15, 'the penalty trust could not take is kept as distrust');
    A.ok(/ranks lower in recall/.test(r.content), 'the result says what the rating did');
    A.eq(rank(h.notes(), 'deploy publish', { now: T1 })[0].id, 'note_2', 'the rated memory now ranks below its twin');
    for (let i = 0; i < 10; i++) await h.t.feedbackTool.run({ id: 'note_1', rating: 'unhelpful' }, { agentId: 'agent' });
    A.eq(h.notes()[0].distrust, 1, 'distrust is bounded at 1');
    const h2 = harness(T1);
    h2.seed([{ id: 'note_1', kind: 'note', title: 'x', body: 'y', createdAt: T1, trust: 0, distrust: 0.15 }]);
    await h2.t.feedbackTool.run({ id: 'note_1', rating: 'helpful' }, { agentId: 'agent' });
    A.ok(Math.abs(h2.notes()[0].distrust - 0.075) < 1e-9 && h2.notes()[0].trust === 0, 'a helpful rating pays distrust down before trust rises');
    const h3 = harness(T1);
    h3.seed([{ id: 'note_1', kind: 'note', title: 'x', body: 'y', createdAt: T1, trust: 0.3 }]);
    await h3.t.feedbackTool.run({ id: 'note_1', rating: 'unhelpful' }, { agentId: 'agent' });
    A.ok(Math.abs(h3.notes()[0].trust - 0.15) < 1e-9 && h3.notes()[0].distrust === undefined, 'negative: a penalty trust CAN absorb stays in trust (no distrust)');
  }

  A.report('memory-truth');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
