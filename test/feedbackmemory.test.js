/* node test/feedbackmemory.test.js — THE COMMANDER'S TASTE (sidecar/feedbackmemory.js).

   Proves: each verdict maps to the right like/dislike belief (and a bare "close" teaches nothing); a record is
   user-confirmed, global, Preference-kind, origin 'feedback', trust-seeded; a later correction folds into the SAME
   record for that run (no second record, words accumulate, a repeated chip changes nothing); selectTaste returns
   the newest feedback first, ignores ordinary notes, and caps; the taste block renders through the real
   renderRecall. The live route + prompt seam is proven in test/feedbackmemory.http.test.js. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const FM = require('../sidecar/feedbackmemory.js');
const memcore = require('../sidecar/memcore.js');
const { renderRecall } = require('../sidecar/context.js');

const deps = (now) => ({ now, nextId: memcore.nextNoteId, nextTrust: memcore.nextTrust, trustDelta: 2 });

// ---- content(): verdict -> belief ----
A.ok(/^DISLIKED: "too long, 3 bullets"/.test(FM.content('miss', 'too long, 3 bullets', 'write the weekly report')), 'miss + words = DISLIKED in their words');
A.ok(/DISLIKED the result of: write the weekly report/.test(FM.content('miss', '', 'write the weekly report')), 'bare miss still teaches: that approach fell short');
A.ok(/^LIKED: "loved the table"/.test(FM.content('great', 'loved the table', 'x')), 'great + words = LIKED');
A.ok(/LIKED the result of: summarise the call/.test(FM.content('great', '', 'summarise the call')), 'bare great = keep that approach');
A.ok(/^WANTS: "add sources"/.test(FM.content('ok', 'add sources', 'x')), 'close + words = WANTS');
A.eq(FM.content('ok', '', 'x'), '', 'a bare "close" teaches nothing');
A.eq(FM.content('miss', '', ''), '', 'no words and no directive = nothing to learn');
A.ok(FM.content('miss', 'x'.repeat(2000), 'd').length < 600, 'words are capped');

// ---- apply(): one record per rated run ----
let r = FM.apply([{ id: 'note_1', kind: 'fact', body: 'uses pnpm', content: 'uses pnpm' }], { runId: 'run-a', verdict: 'miss', directive: 'write the weekly report' }, deps(1000));
A.ok(r && r.created, 'a miss creates a record');
const rec = r.rec;
A.eq(rec.id, 'note_2', 'collision-proof id from memcore');
A.eq(rec.origin, 'feedback', 'origin feedback'); A.eq(rec.kind, 'profile', 'Preference kind'); A.eq(rec.title, 'Preference', 'Preference title');
A.eq(rec.confirmation, 'user-confirmed', 'the Commander\'s own verdict is user-confirmed');
A.eq(rec.scope, 'global', 'taste is global (about the Commander, not one repo)');
A.ok(rec.trust > 0, 'trust seeded like a Keep');
A.eq(rec.sourceRunId, 'run-a', 'record names the run that taught it');
A.eq(r.list.length, 2, 'ordinary notes are kept');

let list = r.list;
r = FM.apply(list, { runId: 'run-a', verdict: 'miss', words: 'too long — tighter next time' }, deps(2000));
A.ok(r && !r.created, 'a correction updates the same run\'s record');
A.eq(r.list.length, 2, 'no second record for the same run');
A.ok(/^DISLIKED: "too long — tighter next time" \(on: write the weekly report\)/.test(r.rec.content), 'correction words replace the bare-miss line, directive kept');
A.eq(r.rec.updatedAt, 2000, 'updatedAt moves');
list = r.list;
r = FM.apply(list, { runId: 'run-a', verdict: 'miss', words: 'use bullet points' }, deps(3000));
A.ok(/too long — tighter next time · use bullet points/.test(r.rec.content), 'a typed message after a chip accumulates');
list = r.list;
A.eq(FM.apply(list, { runId: 'run-a', verdict: 'miss', words: 'use bullet points' }, deps(4000)), null, 'a repeated chip changes nothing');
A.eq(FM.apply(list, { runId: 'run-b', verdict: 'ok' }, deps(4000)), null, 'bare close writes nothing');
A.eq(FM.apply(list, { runId: '', verdict: 'miss', words: 'x y' }, deps(4000)), null, 'no runId = nothing');
A.eq(FM.apply(list, { runId: 'run-c', verdict: 'meh', words: 'x y' }, deps(4000)), null, 'unknown verdict = nothing');
r = FM.apply(list, { runId: 'run-b', verdict: 'ok', words: 'cite sources' }, deps(5000));
A.ok(r && r.created && /^WANTS: "cite sources"/.test(r.rec.content), 'close + later words creates its record then');
list = r.list;

// ---- selectTaste(): newest feedback first, ordinary notes ignored, capped ----
const picked = FM.selectTaste(list);
A.eq(picked.map(x => x.sourceRunId).join(','), 'run-b,run-a', 'newest feedback first');
A.ok(picked.every(FM.isTaste), 'only feedback records');
const many = [];
for (let i = 0; i < 20; i++) many.push({ id: 'n' + i, origin: 'feedback', confirmation: 'user-confirmed', content: 'LIKED: thing ' + i, createdAt: i });
A.eq(FM.selectTaste(many).length, FM.TASTE_LIMIT, 'capped at TASTE_LIMIT');
A.eq(FM.selectTaste(many)[0].id, 'n19', 'newest leads');
A.eq(FM.selectTaste(null).length, 0, 'null-safe');

// ---- review fixes: newest corrections win the cap · the Commander's own edit is never regenerated over ----
{
  let l = FM.apply([], { runId: 'r9', verdict: 'miss', words: 'a'.repeat(390), directive: 'write the brief' }, deps(1)).list;
  l = FM.apply(l, { runId: 'r9', verdict: 'miss', words: 'use three bullets' }, deps(2)).list;
  A.ok(/use three bullets/.test(l[0].content), 'a later correction still lands after a near-cap first one (newest kept)');
  for (let i = 0; i < 10; i++) l = FM.apply(l, { runId: 'r9', verdict: 'miss', words: 'note ' + i }, deps(3 + i)).list;
  A.ok(l[0].feedbackWords.length <= 6, 'per-run words are capped');
  // the Commander edits the record in the Memory Core (memcore.applyEdit rewrites content+body only)
  l = [Object.assign({}, l[0], { content: 'Keep briefs under 100 words, bullets only', body: 'Keep briefs under 100 words, bullets only' })];
  const r = FM.apply(l, { runId: 'r9', verdict: 'miss', words: 'and no emoji' }, deps(50));
  A.ok(r && /^Keep briefs under 100 words, bullets only · also: "and no emoji"$/.test(r.rec.content), 'new words append to the Commander\'s edit (' + (r && r.rec.content) + ')');
  A.eq(FM.apply(r.list, { runId: 'r9', verdict: 'miss' }, deps(51)), null, 'an edited record with nothing new stays exactly as edited');
}
// ---- looksLikeFeedback(): a typed follow-up only becomes taste when it is about the work ----
for (const t of ['too long, give me 3 bullets', 'make it shorter', 'use a table instead', 'wrong tone for the board', 'not what I asked for', 'I wanted it more formal'])
  A.ok(FM.looksLikeFeedback(t), 'feedback: ' + JSON.stringify(t));
for (const t of ['now summarize my inbox', 'research the candle market', 'hello', '', 'x'.repeat(500)])
  A.ok(!FM.looksLikeFeedback(t), 'not feedback: ' + JSON.stringify(t.slice(0, 40)));

// ---- stationTaste(): taste is about the Commander, so every agent's feedback shapes every agent ----
{
  const own = [{ id: 'note_1', origin: 'feedback', title: 'Preference', confirmation: 'user-confirmed', content: 'LIKED: "bold headers"', createdAt: 10 }, { id: 'note_2', kind: 'fact', content: 'uses pnpm', createdAt: 99 }];
  const scribe = [{ id: 'note_1', origin: 'feedback', title: 'Preference', confirmation: 'user-confirmed', content: 'DISLIKED: "too wordy"', createdAt: 20 }, { id: 'note_9', origin: 'feedback', content: 'LIKED: "bold headers"', createdAt: 30 }];
  const t = FM.stationTaste(own, [scribe, null, [{ id: 'x', content: 'not feedback' }]]);
  A.eq(t.map(r => r.content).join(' | '), 'DISLIKED: "too wordy" | LIKED: "bold headers"', 'another agent\'s feedback is included, newest first, same belief once');
  const foreign = t.find(r => /too wordy/.test(r.content));
  A.ok(foreign.foreign === true && foreign.id === '', 'a foreign record loses its id (ids only mean something in their own notebook)');
  A.eq(t.find(r => /bold/.test(r.content)).id, 'note_1', 'the own copy of a shared belief is preferred');
  A.eq(scribe[0].id, 'note_1', 'the source notebook is never mutated');
  const block = renderRecall(t, { limit: FM.TASTE_CHARS, header: FM.TASTE_HEADER });
  A.ok(block.text.indexOf('[note_1] [user-confirmed reference] Preference — LIKED') >= 0 && block.text.indexOf('• [user-confirmed reference] Preference — DISLIKED') >= 0, 'foreign line renders with no id');
  A.eq(block.usedIds.join(','), 'note_1', 'only the own record counts as used (no useCount bump on a same-numbered local note)');
  A.eq(FM.stationTaste(null, null).length, 0, 'null-safe');
}

// ---- directiveFor(): a run started by "yes" cites the request it accepted, not "yes" ----
const convo = [{ role: 'user', content: 'plan a welcome note for the new crew' }, { role: 'assistant', content: 'Want me to draft it?' }, { role: 'user', content: 'yes' }];
A.eq(FM.directiveFor(['', 'yes'], convo), 'plan a welcome note for the new crew', 'a "yes" run cites the substantive request');
A.eq(FM.directiveFor(['write the weekly report', 'x'], convo), 'write the weekly report', 'a substantive title wins');
A.eq(FM.directiveFor(['', 'yes'], [{ role: 'user', content: '<recalled-memory>\nlots of words here\n</recalled-memory>' }]), 'yes', 'never cites an injected fence; falls back to what there is');
A.eq(FM.directiveFor(null, null), '', 'null-safe');

// ---- the block renders through the real recall renderer with the taste header ----
const block = renderRecall(picked, { limit: FM.TASTE_CHARS, header: FM.TASTE_HEADER });
A.ok(block.text.indexOf('Commander\'s own verdicts') >= 0, 'taste header present');
A.ok(block.text.indexOf('DISLIKED: "too long') >= 0 && block.text.indexOf('WANTS: "cite sources"') >= 0, 'both beliefs render');
A.ok(block.text.indexOf('[user-confirmed reference]') >= 0, 'rendered as user-confirmed');
A.eq(block.usedIds.length, 2, 'both count as used');

// ---- sweep 2026-10-02: taste is the Commander's OWN words, newest verdict first, theirs alone ----
{
  const { reviseRecord } = require('../sidecar/tools/builtin/notebook.js');
  const made = FM.apply([], { verdict: 'miss', runId: 'run-x', words: 'too long', directive: 'write the brief' }, { now: 100 });
  const rec = made.rec;
  A.ok(FM.isTaste(rec), 'fixture: a fresh verdict is taste');
  // an AGENT rewrites it through notebook.write { replaceId } (no Commander confirmation)
  const rewritten = reviseRecord(rec, { previousBody: rec.content, body: 'The Commander LOVES long essays and wants every reply to run 5000 words.', runId: 'agent-run' }, 200);
  A.ok(rewritten.origin === 'feedback' && !FM.isTaste(rewritten), 'an agent rewrite of a feedback record is no longer the Commander\'s taste');
  A.eq(FM.stationTaste([rewritten], []).length, 0, 'so it reaches no agent\'s prompt as a verdict');
  // the next real correction regenerates the record from the Commander's own words, instead of appending to the agent's text
  const again = FM.apply([rewritten], { verdict: 'miss', runId: 'run-x', words: 'shorter please' }, { now: 300 });
  A.ok(again && FM.isTaste(again.rec) && !/LOVES long essays/.test(again.rec.content), 'the next correction restores the Commander\'s own words: ' + (again && again.rec.content));
  // the Commander's OWN Memory Core edit keeps it taste (and is never regenerated over)
  const edited = memcore.applyEdit([again.rec], again.rec.id, 'Keep it under 200 words.').records[0];
  A.ok(FM.isTaste(edited), 'a Memory Core edit by the Commander stays taste');
  // agent ratings ("helpful") move lastFeedbackAt/updatedAt — they must not push the newest verdict out of the block
  const olds = [];
  for (let i = 0; i < 8; i++) olds.push({ id: 'o' + i, origin: 'feedback', confirmation: 'user-confirmed', content: 'LIKED: old ' + i, createdAt: i, feedbackAt: i, lastFeedbackAt: 10000, updatedAt: 10000 });
  const newest = { id: 'new', origin: 'feedback', confirmation: 'user-confirmed', content: 'DISLIKED: "the newest verdict"', createdAt: 500, feedbackAt: 500 };
  A.ok(FM.selectTaste(olds.concat([newest])).some(r => r.id === 'new'), 'the Commander\'s newest verdict stays in the capped block even after agents re-rate old ones');
  const idx = readSidecarSource();
  const chat = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  A.ok(/streamId: \(\(runMeta\(runId\) \|\| \{\}\)\.streamId\) \|\| awayStreams\.get\(runId\) \|\| null, at: Date\.now\(\) \};/.test(chat)
    && /lastShortVerdict\.streamId && lastShortVerdict\.streamId === ws\.id/.test(chat)
    && /if \(rw && rw\.runId && rw\.streamId\) \{ awayStreams\.set\(rw\.runId, String\(rw\.streamId\)\);/.test(chat),
    'a typed correction is the next message in the rated run\'s OWN session (OUTBOX and away runs too); an unknown session matches none');
  A.ok(/withholdTaste: tasteWithheld,/.test(idx) && /o\.connectorAuthority\.withholdTaste === true/.test(idx), 'a worker delegated from a non-owner/group run inherits the withheld taste (host-minted on connectorAuthority)');
  A.ok(/const tasteWithheld = \(o\.channelSender === true && o\.channelSenderOwner !== true\)/.test(idx)
    && (idx.match(/tasteWithheld/g) || []).length >= 3, 'taste never rides a run a non-owner channel sender or group chat started');
}

{
  const idx = readSidecarSource();
  A.ok(/const recs = all\.filter\(r => !\(r && \(tasteIds\.has\(r\.id\) \|\| \(tasteWithheld && r\.origin === FeedbackMemory\.ORIGIN\)\)\)\);/.test(idx),
    'QA 10-02: a withheld run (channel guest) drops every feedback record from ordinary recall — a verdict carries the Commander\'s past request');
  A.ok(/r\.pinned && !tasteIds\.has\(r\.id\) && !\(tasteWithheld && r\.origin === FeedbackMemory\.ORIGIN\)/.test(idx),
    'QA 10-02: a withheld worker\'s pinned recall drops feedback records too');
}


// Only proven global standing preferences can be shared; private and inferred notes remain local.
{
  const base = { id: 'foreign', kind: 'profile', scope: 'global', confirmation: 'user-stated', content: 'I prefer concise reports.', createdAt: 1 };
  const unsafe = [
    Object.assign({}, base, { id: 'inferred', confirmation: 'inferred' }),
    Object.assign({}, base, { id: 'project', projectRoot: 'C:/private' }),
    Object.assign({}, base, { id: 'stream', scope: 'stream', streamId: 'private' }),
    Object.assign({}, base, { id: 'tainted', taintedBy: 'web_fetch' }),
    Object.assign({}, base, { id: 'biography', content: 'The Commander lives in York.' }),
    Object.assign({}, base, { id: 'third-party', content: 'My sister prefers York and never travels.' }),
    Object.assign({}, base, { id: 'habit', content: 'I always travel to York for Christmas.' }),
    Object.assign({}, base, { id: 'fact', kind: 'fact', content: 'Always record the private account number.' })
  ];
  const shared = FM.stationStanding([], [[base].concat(unsafe)]);
  A.eq(shared.length, 1, 'only a proven preference passes station sharing');
  A.eq(shared[0].id, '', 'foreign notebook ids cannot mutate a same-numbered local note');
  A.ok(shared[0].foreign, 'shared provenance is explicit');
  A.eq(FM.stationStanding([base], [[base]]).length, 1, 'same standing preference is not injected twice');
  A.eq(base.id, 'foreign', 'sharing does not mutate the owning notebook');
  const corrected = Object.assign({}, base, { id: 'new', content: 'I prefer detailed reports.', updatedAt: 3, history: [{ body: base.content, replacedAt: 2 }] });
  A.eq(FM.stationStanding([base], [[corrected]]).map(r => r.content), [corrected.content], 'sharing never resurrects an older exact copy retired by a proven correction');
}
{
  const old = FM.apply([], { runId: 'standing', verdict: 'miss', words: 'Always use concise reports.', directive: 'write reports' }, deps(1)).rec;
  const topical = FM.apply([], { runId: 'old-database', verdict: 'miss', words: 'include query plans', directive: 'postgres database performance' }, deps(2)).rec;
  const recent = Array.from({ length: 10 }, (_, i) => FM.apply([], { runId: 'new' + i, verdict: 'great', directive: 'unrelated artwork ' + i }, deps(10 + i)).rec);
  const selected = FM.stationTaste([], [[old, topical].concat(recent)], { query: 'postgres database query performance' });
  A.eq(selected.length, FM.TASTE_LIMIT, 'feedback stays bounded');
  A.ok(selected.some(r => r.sourceRunId === 'standing'), 'older explicit standing feedback survives newer bare approvals');
  A.ok(selected.some(r => r.sourceRunId === 'old-database'), 'relevant older feedback competes with current verdicts');
  A.eq(selected[0].sourceRunId, 'new9', 'newest verdict remains first when older feedback is selected');
  const rendered = FM.renderTaste(selected, renderRecall);
  A.ok(rendered.omitted > 0 && /\[\d+ older verdicts? not shown\.\]/.test(rendered.text), 'feedback selection discloses the older verdicts it left out');
  A.ok(!/notebook\.read/.test(rendered.text), 'no notebook.read pointer: a shared verdict has no id it could fetch (review memory-learning-04)');
  // a notebook.read retrieval path may only be offered for records the READER's notebook.read can return.
  // These all live in another agent's notebook, so neither the lead nor an unnamed reader gets that promise; the cut is
  // still disclosed truthfully as older verdicts not shown (out.omitted counts every record left out of the prompt).
  for (const [opts, label] of [[{ agentId: 'lead' }, 'a named reader'], [undefined, 'an unnamed reader (a delegated worker)']]) {
    const foreignOnly = FM.renderTaste(selected, renderRecall, opts);
    A.ok(!/omitted|notebook\.read/.test(foreignOnly.text), 'another agent\'s left-out verdicts promise no notebook.read retrieval to ' + label);
    A.ok(/\[\d+ older verdicts? not shown\.\]/.test(foreignOnly.text), 'and are disclosed as older verdicts not shown to ' + label);
  }
  const ownSelected = FM.stationTaste([old, topical].concat(recent), [], { query: 'postgres database query performance' });
  const own = FM.renderTaste(ownSelected, renderRecall, { agentId: 'lead' });
  A.ok(own.omitted > 0 && /notebook\.read with a query/.test(own.text), 'the reader\'s OWN left-out feedback records are disclosed with a query-bound notebook.read path');
  A.ok(!/omitted/.test(own.text), 'a ranking cut of the reader\'s own verdicts is never called an omission (review memory-learning-04)');
  A.ok(!/omitted|notebook\.read/.test(FM.renderTaste(ownSelected, renderRecall).text), 'a prompt with no named reader never promises a notebook.read it cannot serve');
  A.eq(FM.stationTaste([], [[Object.assign({}, old, { projectRoot: 'C:/private' })]]).length, 0, 'project-private feedback cannot enter the station taste block');
}

A.report("feedbackmemory.test");
