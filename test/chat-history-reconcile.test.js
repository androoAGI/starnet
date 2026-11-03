/* Multi-turn live replies are a local aggregate; the durable transcript stores
   each provider turn separately. Reload must not replay both copies. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const merge = new Function('return (' + require('./helpers/turnmerge').source('mergeCanonicalHistory') + ')')();
const user = { role: 'user', content: 'Write and verify', sourceRunId: 'run-1' };
const first = { role: 'assistant', content: 'Written.', sourceRunId: 'run-1', rowId: 2 };
const last = { role: 'assistant', content: 'Checked.', sourceRunId: 'run-1', rowId: 3 };
const turns = [user, first, last];
const aggregate = { role: 'assistant', content: 'Written.Checked.', ts: 4 };
const contents = rows => rows.map(r => r.content);
A.eq(contents(merge([user, aggregate], turns)), contents(turns), 'legacy local aggregate is represented once by its exact durable turns');
A.eq(contents(merge([user, first, last, aggregate], turns)), contents(turns), 'a previously duplicated saved history heals on reload');
A.eq(contents(merge([user, { ...aggregate, sourceRunId: 'run-1' }], turns)), contents(turns), 'explicit run identity deduplicates new completed replies');
A.eq(merge([user, { ...aggregate, sourceRunId: 'run-2' }], turns).length, 4, 'identical prose from another run is not discarded');
A.eq(merge([{ role: 'user', content: user.content }, aggregate], turns).length, 4, 'unattributed legacy prose is preserved when run identity is unknown');
A.eq(merge([user, aggregate], [user, first]).length, 3, 'a partially committed transcript cannot erase the aggregate tail');
A.eq(merge([user, { ...aggregate, stopped: true }], turns).length, 4, 'stopped output and its recovery marker survive');
A.eq(merge([user, { ...aggregate, error: true }], turns).length, 4, 'local error evidence survives');
A.eq(merge([user, { ...aggregate, attachments: [{ name: 'proof.png' }] }], turns).length, 4, 'local attachment metadata is not thrown away');
A.eq(merge([user, { ...aggregate, content: 'Written.\nChecked.' }], turns).length, 4, 'similar prose with different bytes is not guessed equivalent');
A.eq(contents(merge([user, aggregate], [])), [user.content, aggregate.content], 'unreachable canonical history retains all local prose');
// A RUN-NAMED aggregate differs from its durable turns only by harness bytes (rc walk 2026-10-14): the break streamed after a
// hidden Task Brief step, and the choice marker the chat strips before saving. A reload showed that reply twice.
{
  const ask = { role: 'user', content: 'tagline please', sourceRunId: 'run-9' };
  const t1 = { role: 'assistant', content: 'Got it. One more thing:', sourceRunId: 'run-9', rowId: 4 };
  const t2 = { role: 'assistant', content: 'Let me update my understanding first:', sourceRunId: 'run-9', rowId: 6 };
  const t3 = { role: 'assistant', content: 'Now, one quick question:\n\nTASK_QUESTION: which tone? || warm | dry', sourceRunId: 'run-9', rowId: 8 };
  const saved = { role: 'assistant', content: 'Got it. One more thing:\n\nLet me update my understanding first:\n\nNow, one quick question:', sourceRunId: 'run-9', ts: 9 };
  A.eq(contents(merge([ask, t1, t2, t3, saved], [ask, t1, t2, t3])), contents([ask, t1, t2, t3]), 'a run-named aggregate with turn breaks and a stripped marker is the same reply (shown once)');
  A.eq(merge([ask, { ...saved, sourceRunId: undefined }], [ask, t1, t2, t3]).length, 5, 'without its run named, the exact-bytes rule still holds');
  A.eq(merge([ask, { ...saved, content: saved.content + ' And more.' }], [ask, t1, t2, t3]).length, 5, 'a run-named row with different words is never folded');
  const boldSaved = { ...saved, content: 'Got it. One more thing:\n\nLet me update my understanding first:\n\nIs it:' };
  const boldLast = { ...t3, content: 'Is it:\n\n**FORK: which tone?** || warm | dry' };
  A.eq(merge([ask, t1, t2, boldLast, boldSaved], [ask, t1, t2, boldLast]).length, 4, 'a bold-wrapped marker is a harness byte too');
  // the marker grammar's one case rule and its list-number decoration (fork.js MARKER_KEY): what the chat strips, the merge sets aside
  const Fork = require('../frontend/app/fork.js');
  for (const marker of ['1. TASK_QUESTION: which tone? || warm | dry', 'Fork: which tone? || warm | dry', 'task_question: which tone? || warm | dry']) {
    const last = { ...t3, content: 'Now, one quick question:\n\n' + marker };
    const kept = { ...saved, content: 'Got it. One more thing:\n\nLet me update my understanding first:\n\n' + Fork.stripMarkers(last.content) };
    A.eq(merge([ask, t1, t2, last, kept], [ask, t1, t2, last]).length, 4, 'a reload shows the reply once when its marker was ' + JSON.stringify(marker.slice(0, 20)));
  }
  // a lowercase "fork:" is prose, never a marker: neither side drops it, so a reply whose words differ is never folded
  const prose = { ...t3, content: 'const fork: Fork = a || b' };
  const lost = { ...saved, content: 'Got it. One more thing:\n\nLet me update my understanding first:\n\nconst' };
  A.eq(merge([ask, t1, t2, prose, lost], [ask, t1, t2, prose]).length, 5, 'a lowercase "fork: … ||" line is words, not a harness byte');
}
const repeated = [{ role: 'user', content: 'again' }, { role: 'user', content: 'again' }];
A.eq(merge(repeated, repeated).length, 2, 'occurrence queues keep intentional repeated messages');
const original = JSON.stringify([user, aggregate, turns]);
merge([user, aggregate], turns);
A.eq(JSON.stringify([user, aggregate, turns]), original, 'reconciliation never mutates either history input');
// A saved rejected reply must not outlive its authoritative accepted dispatch result.
const visible = { role: 'user', content: 'Visible request', sourceRunId: 'original', ts: 99 };
const accepted = { role: 'assistant', content: '{"answer":"ACCEPTED_PHONE"}', sourceRunId: 'original', streamId: 'chat', agentId: 'mira', dispatchState: 'final', dispatchReason: 'done', textLength: 27, textSha256: 'b4098cf3864c07184e055f1cce6af581dff243492fb8de76e244b89005b5dcc1', rowId: 12, ts: 101 };
const rejected = { role: 'assistant', content: 'RAW_REJECTED', sourceRunId: 'original', ts: 100 };
const finalTurns = [visible, accepted];
A.eq(contents(merge([visible, rejected], finalTurns)), [visible.content, accepted.content], 'canonical final supersedes saved rejected output from the exact run');
const savedStatus = { role: 'system', sys: true, sourceRunId: 'original', content: 'Worker stopped', stopped: true };
const unrelated = { role: 'assistant', sourceRunId: 'other', content: 'Unrelated result' };
const saved = [visible, { ...rejected, attachments: [{ name: 'proof.png' }], projectRoot: 'project-a', ownerAgentId: 'mira', taint: 'external' }, savedStatus, { ...rejected, attachments: [{ name: 'proof.png' }, { name: 'report.txt' }], error: true }, unrelated];
const before = JSON.stringify([saved, finalTurns]);
const healed = merge(saved, finalTurns);
A.eq(contents(healed), [visible.content, accepted.content, savedStatus.content, unrelated.content], 'duplicate rejected copies heal in place without moving status or unrelated output');
A.eq(healed[1].attachments.map(a => a.name).sort(), ['proof.png', 'report.txt'], 'attachments from every replaced copy survive once');
A.eq([healed[1].projectRoot, healed[1].ownerAgentId, healed[1].taint, healed[1].supersededStatus.error], ['project-a', 'mira', 'external', true], 'local ownership, taint and superseded error evidence survive');
A.eq([healed[1].rowId, healed[1].ts, healed[1].textLength, healed[1].textSha256, healed[1].dispatchState], [12, 101, 27, accepted.textSha256, 'final'], 'canonical content identity and integrity metadata win');
A.eq(merge(JSON.parse(JSON.stringify(healed)), finalTurns), healed, 'saved/reloaded history remains stable after healing');
A.eq(JSON.stringify([saved, finalTurns]), before, 'final reconciliation does not mutate saved or canonical input');
for (const outsider of [
  { ...rejected, sourceRunId: 'foreign' },
  { ...rejected, sourceRunId: undefined },
  { ...rejected, agentId: 'another-agent' },
  { ...rejected, streamId: 'another-chat' }
]) {
  const result = merge([visible, outsider], finalTurns);
  A.ok(result.some(r => r.content === rejected.content), 'prose without compatible explicit run ownership is preserved');
}
A.ok(merge([visible, rejected], [visible, { ...accepted, dispatchState: 'pending' }]).some(r => r.content === rejected.content), 'an unfinalized dispatch cannot replace saved prose');
const foreignTwin = { ...unrelated, content: accepted.content };
const twins = merge([visible, foreignTwin, rejected], finalTurns);
A.eq(twins.filter(r => r.role === 'assistant').map(r => r.sourceRunId), ['other', 'original'], 'identical foreign prose cannot consume the accepted dispatch slot');
A.eq(twins.filter(r => r.sourceRunId === 'original' && r.role === 'assistant').length, 1, 'accepted result appears once even with a foreign text twin');
const ordinaryTwin = { ...accepted, sourceRunId: 'other', dispatchState: undefined, rowId: 10 };
const canonicalTwins = merge([visible, rejected], [visible, ordinaryTwin, accepted]);
A.eq(canonicalTwins.filter(r => r.role === 'assistant').map(r => r.sourceRunId), ['other', 'original'], 'ordinary canonical prose cannot consume the reserved final slot');
A.eq(merge([visible, { ...rejected, taint: 'external' }], [visible, { ...accepted, taint: null }])[1].taint, 'external', 'an empty canonical taint never clears a saved taint');
A.ok(!healed[1].error && !healed[1].stopped, 'accepted answer is not rendered as a stale failure or excluded from follow-up');
const stoppedFinal = merge([visible, { ...rejected, stopped: true, stopNote: 'old attempt stopped' }], finalTurns)[1];
A.eq(stoppedFinal.supersededStatus, { stopped: true, stopNote: 'old attempt stopped' }, 'prior stop evidence remains separate from accepted answer status');
A.ok(!stoppedFinal.stopped && !stoppedFinal.stopNote, 'accepted answer does not offer a stale stop retry');
const phoneSource = fs.readFileSync(path.join(__dirname, '../sidecar/remote/host.js'), 'utf8');
A.ok(/TurnMerge\.reconcile\(/.test(source) && /TurnMerge\.merge\(/.test(phoneSource) && !/const finals = new Map\(/.test(source + phoneSource), 'desk and phone delegate to the shared owner and hold no merge body');
A.report('chat-history-reconcile.test');
