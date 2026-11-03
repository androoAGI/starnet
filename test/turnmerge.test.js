/* Pure cache reconciliation: affirmative identity wins; absence never erases a pending turn. */
'use strict';
const A = require('./_assert.js');
const crypto = require('crypto');
const M = require('../frontend/app/turnmerge.js');
const K = require('../frontend/app/turnkinds.js');
const frozenLegacy = require('./fixtures/merge-canonical-d5024f5a2.js');
const T = K.runTurnId('run-one'), T2 = K.runTurnId('run-two');
const U = (content, extra) => Object.assign({ role: 'user', content, turnId: T, sourceRunId: 'r1' }, extra);
const R = (content, extra) => Object.assign({ role: 'assistant', content, turnId: T, sourceRunId: 'r1' }, extra);
const station = (row, rowId) => Object.assign({ streamId: 's', rowId }, row);
const identity = extra => Object.assign({ v: 2, streamId: 's', fromRowId: 10, liveRunIds: [], collided: [], retracted: [], forgottenAt: 0, forgotten: { keys: [], runIds: [] }, modes: { merge: 'id' } }, extra);
const merge = (local, rows, extra) => M.merge(local, rows, { identity: identity(extra) });
const texts = rows => rows.map(r => r.content);
const directive = station(U('station wording', { directive: true, typed: 'station wording', ts: 20 }), 10);
const answer = station(R('accepted answer'), 11);
const frozen = x => { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(frozen); } return x; };

// Legacy is an exact move of the desk algorithm, including its oldest content-only behavior.
A.eq(crypto.createHash('sha256').update(M.legacyMerge.toString().replace('function legacyMerge', 'function mergeCanonicalHistory')).digest('hex'),
  '28bfe4fca5bbf9acb285f441a875c28e80c9ae63946a439b749e8f85b41f782a', 'legacy merge body is byte-identical to the C4 desk owner');
A.ok(K.isTurnId(T) && K.isTurnId(T2), 'fixtures use real turn ids');
A.eq(M.legacyMerge.toString().replace('function legacyMerge', 'function mergeCanonicalHistory'), frozenLegacy.toString(), 'rollback owner is exactly the frozen design baseline');
{
  // ec226657 family: a run-named saved aggregate remains beside four proven station rows. Under the
  // identity contract its prior stop status moves to the completed answer instead of duplicating prose.
  const canonical = [station({ role: 'user', content: 'write and verify', sourceRunId: 'legacy-run' }, 101),
    station({ role: 'assistant', content: 'written', sourceRunId: 'legacy-run' }, 102),
    station({ role: 'assistant', content: 'checked', sourceRunId: 'legacy-run' }, 103),
    station({ role: 'assistant', content: 'complete', sourceRunId: 'legacy-run' }, 104)];
  const five = canonical.concat([{ role: 'assistant', content: 'written checked complete', sourceRunId: 'legacy-run', stopped: true }]);
  A.eq(frozenLegacy(five, canonical).length, 5, 'frozen legacy control has the five-row duplicate');
  const repaired = process.env.TURNMERGE_LEGACY_INCIDENT_CONTROL ? frozenLegacy(five, canonical) : merge(five, canonical).rows;
  A.eq(repaired.length, 4, 'ec226657 family: the five-row legacy fixture heals to four');
  A.eq(repaired.map(r => [r.role, r.content]), canonical.map(r => [r.role, r.content]), 'healing preserves exact canonical role/content bytes');
  A.ok(repaired[3].supersededStatus && repaired[3].supersededStatus.stopped, 'prior stop evidence survives under the completed station answer');
}

// A2-ID-02: no final answer means no heal can remove partials, errors, or distinct assistant parts.
for (const rows of [[], [directive]]) {
  const local = [U('pending'), R('part one'), R('part two'), R('error', { error: true })];
  const out = merge(local, rows).rows;
  A.eq(texts(out).slice(-3), ['part one', 'part two', 'error'], 'all assistant parts and error survive without a station answer');
  A.eq(out.length, 4, 'one user plus three parts survives');
}
{
  const local = [U('raw words', { turnAt: 7, ts: 8, projectRoot: 'root', attachments: [{ id: 'a', path: 'x' }] }), R('partial'), R('failed', { stopped: true, stopNote: 'paused' })];
  const out = merge(frozen(local), frozen([answer, directive])).rows;
  A.eq(texts(out), ['station wording', 'accepted answer'], 'station rowId order and bytes win; partial and stopped fold only after answer');
  A.eq(out[1].supersededStatus, { stopped: true, stopNote: 'paused' }, 'completed turn preserves the provisional status as evidence');
  A.ok(!out[1].stopped && !out[1].error && !out[1].stopNote, 'accepted answer never inherits active stopped/error fields');
  A.eq([out[0].rowId, out[0].turnAt, out[0].projectRoot, out[0].attachments], [10, 7, 'root', [{ id: 'a', path: 'x' }]], 'binding keeps identity, original page time and presentation');
  A.eq(M.sendIds(out, { now: 100 }), { turnId: T, turnAt: 7, clientNow: 100, turnRowId: 10 }, 'resend clock retains original page time even after station timestamp replaces ts');
  A.ok(!('typedText' in out[0]), 'answered user no longer retains retry wording');
  A.eq(merge(out, [answer, directive]).rows, out, 'a settled merge is idempotent');
  const live = merge(local, [directive, answer], { liveRunIds: ['r1'] }).rows;
  A.ok(live.some(r => r.content === 'partial') && live.some(r => r.stopped), 'a live run cannot replace its provisional reply');
}
{
  const out = merge([U('raw words')], [directive]).rows[0];
  A.eq([out.content, out.typedText], ['station wording', 'raw words'], 'unanswered directive keeps station bytes plus retry-only typedText');
  A.eq(merge([out], [directive]).rows[0].typedText, 'raw words', 'repeated load keeps the same retry words');
  A.eq(merge([U('pending')], [station(U('context', { directive: false }), 9)]).rows.length, 2, 'turnId binds only the directive, never another user row');
  A.eq(merge([R('other turn', { turnId: T2 })], [answer]).rows.length, 2, 'same run does not override a present but different turnId');
  for (const flags of [{ foreign: true }, { sys: true }, { steerEcho: true }]) {
    const annotation = R('same-run annotation', flags);
    A.ok(merge([annotation], [answer]).rows.includes(annotation), 'R4 preserves local annotation rather than consuming it as a provisional reply: ' + JSON.stringify(flags));
  }
  const attachmentTwin = merge([{ role: 'user', content: 'raw typed caption', sourceRunId: 'r1' }, directive], [directive]).rows;
  A.eq([attachmentTwin.length, attachmentTwin[0].typedText], [1, 'raw typed caption'], 'legacy attachment twin retains its typed retry words even when the bound copy was saved later');
}
// Strong identity never falls through to a weaker rung; no-window and in-window orphans both survive.
{
  const rows = [station(U('old'), 2), station(U('orphan'), 12), station(R('foreign'), 10)]; rows[2].streamId = 'other';
  const out = merge(rows, [directive]);
  A.eq(out.rows.length, 4, 'all unmatched keyed rows survive alongside the station directive');
  A.eq(out.report.counts.orphan, 1, 'in-window missing key is reported without deletion');
  A.eq(merge(rows, [directive], { retracted: [2, 12, 10] }).rows.map(r => r.content), ['station wording', 'foreign'], 'retraction proof is stream-scoped');
  A.eq(merge([R('forgotten partial'), U('new', { ts: 21 })], [], { forgotten: { keys: [], runIds: ['r1'] }, forgottenAt: 20 }).rows.map(r => r.content), ['new'], 'forgotten run erases its provisional assistant but not a later pending user');
  A.eq(merge([station(U('forgotten key'), 3)], [], { forgotten: { keys: [['s', 3]], runIds: [] } }).rows.length, 0, 'explicit forgotten key is affirmative proof');
}
// H1 is user-only. H2 exact-key twins cannot multiply a station row.
{
  const bound = station(U('old bound'), 10), pending = U('optimistic');
  const out = merge([pending, bound, Object.assign({}, bound, { projectRoot: 'p' })], [directive]);
  A.eq(out.rows.length, 1, 'bound directive, optimistic twin and duplicate key heal to one row');
  A.eq(out.rows[0].projectRoot, 'p', 'duplicate-key presentation survives healing');
  A.eq(merge([R('one'), R('two'), R('err', { error: true })], []).rows.length, 3, 'H1 never drops assistant parts sharing a turn');
  A.eq(merge([station(U('one'), 1), station(U('two'), 2)], []).rows.length, 2, 'two distinct bound user rows stay distinct even with one turnId');
}
// Steers are matched by note id, or by run-scoped text FIFO; other annotations remain after their own run.
{
  const line = station({ role: 'system', sys: true, kind: 'steer', content: 'next', sourceRunId: 'r1', turnId: T, noteId: 'n' }, 12);
  const echo = { role: 'system', sys: true, steerEcho: true, sourceRunId: 'r1', content: '[steering] next' };
  const out = merge([echo, Object.assign({}, echo), Object.assign({}, echo, { sourceRunId: 'r2' }), { role: 'system', sys: true, content: 'local note', turnId: T }], [directive, line]);
  A.eq(out.rows.filter(r => r.steerEcho).length, 2, 'one legacy steer echo binds once and never across runs');
  A.ok(out.rows.findIndex(r => r.content === 'local note') > out.rows.findIndex(r => r.rowId === 12), 'local note remains after its own station turn');
  A.eq(out.rows.slice(-3).map(r => r.steerEcho ? r.sourceRunId : r.content), ['r1', 'r2', 'local note'], 'retained annotations preserve their local order at the same station anchor');
  A.eq(merge([{ role: 'system', error: true, content: 'failed', sourceRunId: 'r1' }], [{ role: 'system', synthId: 's1', sourceRunId: 'r1', content: 'station failed' }]).rows.length, 1, 'station synthetic line replaces same-run local error');
  const synthetic = R('station interrupted', { sys: true, error: true, transcriptPending: true, synthId: 'syn:interrupted:r1' });
  const interrupted = merge([U('raw'), R('partial'), R('local error', { error: true })], [directive, synthetic]).rows;
  A.ok(interrupted.some(r => r.content === 'partial'), 'real projection assistant/sys/error synthetic line cannot consume a partial as an answer');
  A.ok(!interrupted.some(r => r.content === 'local error') && interrupted.filter(r => r.synthId).length === 1, 'R5 independently folds same-run local error into one station synthetic line');
  A.eq(interrupted.find(r => r.rowId === 10).typedText, 'raw', 'synthetic status does not retire unanswered retry wording');
}
// Content-only rows bind FIFO only to other legacy rows. Collided keys carry no authority.
{
  const legacy = { role: 'user', content: 'same' };
  const rows = [station(legacy, 1), station(legacy, 2)];
  const out = merge([legacy, Object.assign({}, legacy), Object.assign({}, legacy)], rows).rows;
  A.eq(out.map(r => r.rowId || null), [1, 2, null], 'legacy FIFO binds each station row once and keeps the unmatched copy');
  A.ok(out[0].idFrom === 'content' && out[1].idFrom === 'content' && out[2].legacy, 'legacy bindings carry their provenance');
  A.eq(merge(out, rows).rows, out, 'content-bound merge is idempotent');
  A.eq(merge([legacy], [station(U('same'), 1)]).rows.length, 2, 'legacy content cannot steal a named turn');
  const collision = merge([station(U('left'), 1)], [station(U('left'), 1), station(U('right'), 1)]);
  A.eq(texts(collision.rows), ['left', 'right'], 'collided station rows keep both different byte strings and one content twin');
  A.ok(collision.rows.every(r => !r.rowId), 'no collided key lends false row identity');
  A.eq(collision.report.counts.station_rowid_collision, 2, 'each collided station row is reported');
  A.eq(collision.report.counts.local_rowid_collision, 1, 'local demotion proof is counted separately from station collisions');
  A.eq(merge(collision.rows, [station(U('left'), 1), station(U('right'), 1)]).rows, collision.rows, 'collision demotion remains stable after save and reload');
  for (const extra of [{ foreign: true }, { steerEcho: true }, { streamId: 'other' }]) {
    const local = Object.assign({}, legacy, extra);
    const kept = merge([local], [station(legacy, 1)]).rows;
    A.ok(kept.includes(local) && kept.length === 2, 'annotation or explicit other-stream local cannot content-bind: ' + JSON.stringify(extra));
  }
  const other = Object.assign(station(legacy, 1), { streamId: 'other' });
  A.eq(merge([legacy], [other]).rows.length, 2, 'local legacy row cannot bind an explicit other-stream station row');
  const foreignDirective = Object.assign({}, directive, { streamId: 'other' });
  A.eq(merge([U('pending')], [foreignDirective]).rows.length, 2, 'turnId rung cannot cross the station stream');
  A.eq(merge([{ role: 'user', content: 'typed', sourceRunId: 'r1' }, foreignDirective], [foreignDirective]).rows.length, 2, 'attachment-twin heal cannot cross the station stream');
}
{
  const many = Array.from({ length: 130 }, (_, i) => station({ role: 'user', content: String(i) }, i + 1));
  const first = merge([], many).rows;
  A.eq(first.filter(r => r.role === 'user').length, 120, 'cap retains 120 newest dialogue rows');
  A.ok(first[0].truncated && first[1].rowId === 11, 'discarded station rows prove the earlier marker');
  A.eq(merge(first, many).rows, first, 'cap and marker are stable under repeated merge');
  A.ok(!merge([{ role: 'system', truncated: true, content: 'old' }], []).rows.length, 'no affirmative older-station proof means no stale marker');
}
// Save comparison may ignore acquired merge metadata but never conflates turn-group members.
A.ok(M.sameTurn(U('raw'), station(U('stored'), 10)), 'unbound user turn matches its bound directive');
A.ok(!M.sameTurn(U('x'), R('x')), 'user and assistant of one turn remain different');
A.ok(!M.sameTurn(R('one'), R('two')), 'assistant parts do not collapse by turnId');
A.ok(!M.sameTurn(station(U('x'), 1), station(U('x'), 2)), 'different strong keys never fall through to turnId');
A.ok(!M.sameTurn(station(U('x'), 1), Object.assign(station(U('x'), 1), { streamId: 'other' })), 'strong key includes stream');
A.ok(M.sameTurn({ role: 'assistant', content: 'x', ts: 3 }, { ts: 3, content: 'x', role: 'assistant', rowId: 5, idFrom: 'content', typedText: 'x' }), 'fallback ignores only merge-acquired fields and property order');
A.eq(M.compare([station(U('old secret'), 1)], [station(U('stored'), 1)]).classes, ['bytes'], 'equal keys with changed bytes still produce a divergence');
{
  const first = { role: 'system', sys: true, content: 'local annotation' }, second = { role: 'system', sys: true, content: 'another annotation' };
  const moved = M.compare([first, second], [second, first]);
  A.eq([moved.classes, moved.onlyA, moved.onlyB], [['order'], [], []], 'idless movement is order divergence, not invented membership');
  const changed = M.compare([station(U('old'), 1), station(R('answer'), 2)], [station(R('answer'), 2), station(U('new'), 1)]);
  A.eq(changed.classes, ['bytes', 'order'], 'a reorder cannot hide changed bytes under a common durable key');
  const twin = M.merge([U('question'), U('question')], [directive], { identity: identity() });
  A.ok(twin.report.counts.directive_twin > 0 && !twin.report.classes.includes('directive_twin'), 'M6 twin proof remains a healing reason, never an unrecognized divergence class');
  A.eq(M.compare([station(U('one'), 1)], [station(U('two'), 9)]).classes, ['unexplained'], 'unknown membership differences stay unexplained');
  const copies = Array.from({ length: 65 }, (_, i) => R('partial ' + i)), completed = station(R('complete'), 44);
  const proof = M.merge(copies, [completed], { identity: identity() }).report.healed.filter(h => h.reason === 'provisional_answer');
  A.eq([proof.length, proof.every(h => h.target && h.target.rowId === 44)], [65, true], 'every removed provisional row carries its actual R4 station-key proof beyond50 rows');
  A.ok(!JSON.stringify(proof).includes('partial ') && !JSON.stringify(proof).includes('complete'), 'complete merge proof contains identities and hashes, never dialogue');
}

(async () => {
  const notes = [], legacy = [{ role: 'user', content: 'raw secret' }], s = [station({ role: 'user', content: '[redacted-token]' }, 1)];
  let asks = 0;
  const redactAsk = async rows => { asks++; A.eq(rows.length, 1, 'only unmatched legacy row reaches redaction'); return new Map([['raw secret', '[redacted-token]']]); };
  let out = await M.reconcile(legacy, { stream: 's', turns: s, identity: identity() }, { redactAsk, note: e => notes.push(e) });
  A.eq([out.rows.length, out.rows[0].content, out.rows[0].typedText, asks], [1, '[redacted-token]', 'raw secret', 1], 'legacy redaction binds station bytes and preserves retry words');
  A.ok(!JSON.stringify(notes).includes('raw secret') && !JSON.stringify(notes).includes('[redacted-token]'), 'diagnostics contain no raw or stored content');
  asks = 0;
  out = await M.reconcile([U('raw secret')], { stream: 's', turns: [directive], identity: identity() }, { redactAsk });
  A.eq(asks, 0, 'named turns never request content redaction');
  const old = await M.reconcile(legacy, { turns: s }, { redactAsk });
  A.eq(old.rows[0].content, 'raw secret', 'older station retains legacy unanswered-user behavior');
  const shadow = await M.reconcile(legacy, { turns: s, identity: identity({ modes: { merge: 'shadow' } }) }, { redactAsk });
  A.eq(shadow.rows, old.rows, 'shadow returns the legacy result');
  const current = legacy.slice();
  out = await M.reconcile(current, { turns: s, identity: identity() }, { getLocal: () => current, redactAsk: async () => { current.push(U('typed while waiting', { turnId: T2 })); return new Map([['raw secret', '[redacted-token]']]); } });
  A.ok(out.rows.some(r => r.content === 'typed while waiting'), 'async redaction cannot erase a newer local edit');
  const untouched = { role: 'user', content: 'different raw' };
  out = await M.reconcile([untouched], { turns: s, identity: identity() }, { redactAsk: async () => new Map([['different raw', 'unmatched scrubbed']]) });
  A.ok(out.rows.includes(untouched), 'an unmatched scrubbed copy returns the exact original local row');
  out = await M.reconcile(legacy, { turns: s, identity: identity({ collided: {} }) }, { note: e => notes.push(e) });
  A.eq(out.rows, M.legacyMerge(legacy, s), 'id-path failure uses legacy for this call');
  A.ok(notes.some(n => n && n.event === 'merge-fallback'), 'fallback emits a diagnostic without changing the configured mode');
  const rawCollision = { streamId: 's', rowId: 77, role: 'user', content: 'raw collision secret' };
  const collisionRows = [station({ role: 'user', content: '[redacted-token]' }, 77), station({ role: 'user', content: 'another canonical turn' }, 77)];
  let collisionAsks = 0;
  const collided = await M.reconcile([rawCollision], { turns: collisionRows, identity: identity() }, {
    redactAsk: async rows => { collisionAsks++; A.ok(rows.includes(rawCollision), 'collided redaction keeps the original local-row identity'); return new Map([['raw collision secret', '[redacted-token]']]); }
  });
  A.eq([collisionAsks, collided.rows.map(r => r.content)], [1, ['[redacted-token]', 'another canonical turn']], 'collided raw secret binds once through the real R6 redaction path');
  A.ok(collided.rows.every(r => r.rowId === undefined && r.idFrom === 'collision'), 'content binding cannot restore a collided strong key');
  A.eq(collided.rows[0].typedText, rawCollision.content, 'demotion copy preserves the latest unanswered typed retry words');
  const unmatchedCollision = await M.reconcile([rawCollision], { turns: collisionRows, identity: identity() }, {
    redactAsk: async () => new Map([['raw collision secret', 'not a station turn']])
  });
  const retainedCollision = unmatchedCollision.rows.find(r => r.content === rawCollision.content);
  A.ok(retainedCollision && retainedCollision.rowId === undefined && retainedCollision.idFrom === 'collision', 'restoring unmatched original wording cannot restore a disavowed key');
  A.report('turnmerge');
})().catch(e => { console.error(e); process.exit(1); });
