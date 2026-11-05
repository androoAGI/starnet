'use strict';
const assert = require('node:assert/strict');
const K = require('../../frontend/app/turnkinds.js');
const dialogue = r => r && ['user', 'assistant'].includes(r.role) && !r.sys && !r.error && !r.stopped && !r.truncated && !r.foreign && !r.steerEcho;
const key = r => r && Number.isSafeInteger(r.rowId) && r.rowId > 0 ? JSON.stringify([r.streamId, r.rowId]) : null;
function check(page, response, durable, options) {
  const label = options && options.label || 'quiescent';
  const expected = response.turns.filter(dialogue).slice(-120), actual = page.ws.history.filter(dialogue);
  const expectedKeys = expected.map(key).filter(Boolean), actualKeys = actual.map(key).filter(Boolean);
  assert.deepEqual(actualKeys, expectedKeys, label + ': I1 page keys match station spine at the page cap');
  assert.equal(new Set(actualKeys).size, actualKeys.length, label + ': I1 no duplicate keys');
  const byKey = new Map(response.turns.map(r => [key(r), r]));
  for (const row of actual) {
    const id = key(row);
    if (id && byKey.has(id)) assert.equal(row.content, byKey.get(id).content, label + ': I2 canonical bytes');
    if (!row.legacy) assert.ok(id || K.isTurnId(row.turnId) || row.sourceRunId, label + ': I1b named or bound page dialogue');
  }
  // The negative control intentionally restores pre-identity pushes. Missing metadata alone is not its
  // incident assertion: require a real ordering/byte/duplicate failure under the same operation campaign.
  if (!page.legacyControl) for (const row of page.created) if (dialogue(row)) assert.ok(K.isTurnId(row.turnId) || row.sourceRunId, label + ': I1b every newly pushed page row named its turn/run');
  for (const row of actual.filter(row => !key(row) && row.idFrom !== 'collision')) {
    const answered = response.turns.some(other => dialogue(other) && other.role === 'assistant' && other.content && !other.synthId &&
      ((K.isTurnId(row.turnId) && row.turnId === other.turnId) || (!K.isTurnId(row.turnId) && row.sourceRunId && row.sourceRunId === other.sourceRunId)));
    assert.ok(!answered, label + ': I1 completed station turn leaves no extra unbound dialogue');
  }
  const directives = new Map();
  for (const row of durable || []) if (row.directive && K.isTurnId(row.turnId)) directives.set(row.turnId, (directives.get(row.turnId) || 0) + 1);
  for (const count of directives.values()) assert.equal(count, 1, label + ': I3 one durable directive per turn');
  for (const proof of page.lastMergeReport && page.lastMergeReport.healed || []) {
    if (proof.reason === 'provisional_answer') {
      assert.ok(proof.target && Number.isSafeInteger(proof.target.rowId), label + ': M6 provisional removal names an actual station row');
      assert.ok(response.turns.some(r => r.rowId === proof.target.rowId && r.role === 'assistant' && r.content && !r.sys && !r.error), label + ': M6 target is an actual answer in this read');
    }
    if (proof.reason === 'retracted' || proof.reason === 'forgotten') assert.ok(proof.proof && proof.proof.rule, label + ': M6 deletion names affirmative station proof');
  }
  return { keys: expectedKeys.length, created: page.created.length, directives: directives.size };
}
/* EVERY ROW KIND, ONE TABLE (turn identity, commit 10). The dialogue check above holds the user and assistant rows; this holds the other
   canonical kinds a run or a routine can leave in the stream, with each kind's visibility read out of TurnKinds.MATRIX rather than listed
   here: a steering note (kind steer), a file the run wrote (kind deliverable) and a routine's return (kind delivery). At a quiescent point,
   for the rows each kind has in GET /api/transcript (inside the window GET shows):
     page    the page holds exactly those rows by (stream, row id); an older row the page kept beyond GET's window may remain;
     window  the station's model-replay holds a row iff its MATRIX cell says model-replay is true, and so does the page's own window, which
             never holds an assistant message with a '[steering]' line inside it;
     display GET holds the row iff its MATRIX cell says display is true.
   `expected` is what the operations declared they made, independent of any writer: { files: [{ runId, path }], steers: [{ runId, text, noteId? }],
   returns: [{ runId, text }], attachments: [{ runId, id, path, turnId }] } (a file or a note also names the turn its run answered). A run that has left
   GET's window (no row of it is shown) is not asked about.
   THE ATTACHMENT ROW (attachment-rows-and-taint) is the fourth kind: its MATRIX cell hides it from the display GET, from the page and from both
   windows, so the table above holds it to exactly that (no row of the kind anywhere the page reads), and options.proof - the proof view of the
   stream, the one reader that still sees it - holds it to what the run made: one role-system row per declared file, at its path, stamped
   'user attachment', carrying the turn the run answered. */
const KINDS = ['steer', 'deliverable', 'delivery', 'attachment'];
function checkKinds(page, response, windows, expected, options) {
  const label = options && options.label || 'quiescent', M = K.MATRIX, turns = response.turns || [], ex = expected || {};
  const keyed = turns.filter(r => key(r));
  const floor = keyed.length ? Math.min(...keyed.map(r => r.rowId)) : Infinity;
  const inGet = runId => turns.some(r => r.sourceRunId === runId);
  const order = (a, b) => a.rowId - b.rowId;
  for (const kind of KINDS) {
    const cell = M[kind], got = turns.filter(r => r.kind === kind && key(r)).sort(order);
    const have = (page.ws.history || []).filter(r => r.kind === kind && key(r) && r.rowId >= floor).sort(order);
    assert.deepEqual(have.map(key), got.map(key), label + ': ' + kind + ' rows: the page holds the station\'s, by key');
    assert.equal(new Set(have.map(key)).size, have.length, label + ': ' + kind + ' rows: no key twice in the page');
    assert.ok(got.length === 0 || cell.display === true, label + ': ' + kind + ' rows: GET shows only what the matrix displays');
    const stationIds = new Set(windows.station.ids.filter(Boolean).map(id => JSON.stringify([id.streamId, id.rowId])));
    const pageIds = new Set(windows.page.filter(m => m && Number.isSafeInteger(m.rowId)).map(m => JSON.stringify([m.streamId || page.ws.id, m.rowId])));
    for (const row of got) {
      const wanted = cell['model-replay'] === true;
      assert.equal(stationIds.has(key(row)), wanted, label + ': ' + kind + ' row ' + row.rowId + ': the station window holds it iff the matrix replays it (' + cell['model-replay'] + ')');
      assert.equal(pageIds.has(key(row)), wanted, label + ': ' + kind + ' row ' + row.rowId + ': the page window holds it iff the matrix replays it');
    }
  }
  for (const w of [windows.station.messages, windows.page]) {
    for (const m of w) assert.ok(!(m && m.role === 'assistant' && /(^|\n)\[steering\] /.test(String(m.content))), label + ': no assistant message of a window holds a \'[steering]\' line');
  }
  for (const file of ex.files || []) {
    if (!inGet(file.runId)) continue;
    const rows = turns.filter(r => r.kind === 'deliverable' && r.sourceRunId === file.runId && r.deliverable && r.deliverable.path === file.path);
    assert.equal(rows.length, 1, label + ': file ' + JSON.stringify(file.path) + ' of ' + file.runId + ' is exactly one row, at its exact path');
    const d = rows[0].deliverable;
    assert.deepEqual([rows[0].role, d.media, d.workspace, d.root], ['system', K.mediaKindOf(file.path), 'agent', ''], label + ': the row names the file\'s media, workspace and root');
    assert.equal(rows[0].turnId, file.turnId, label + ': the file row carries the turn the run answered');
  }
  for (const note of ex.steers || []) {
    if (!inGet(note.runId)) continue;
    const rows = turns.filter(r => r.kind === 'steer' && r.sourceRunId === note.runId && r.content === note.text);
    assert.equal(rows.length, 1, label + ': the note ' + JSON.stringify(note.text) + ' of ' + note.runId + ' is exactly one steer row');
    assert.deepEqual([rows[0].role, rows[0].noteId], ['system', note.noteId], label + ': the steer row is a system row with the id the note was sent with');
    assert.equal(rows[0].turnId, note.turnId, label + ': and carries the turn the run answered');
    const ofRun = turns.filter(r => r.sourceRunId === note.runId && key(r)).sort(order), at = ofRun.indexOf(rows[0]);
    const tool = ofRun.findIndex(r => r.role === 'tool'), last = ofRun.map(r => r.role + ':' + (r.kind || '')).lastIndexOf('assistant:turn');
    assert.ok(tool >= 0 && at > tool && at < last, label + ': the steer row sits after the tool results and before the answer it shaped');
    assert.ok(windows.station.messages.some(m => m && m.role === 'user' && m.content === '[steering] ' + note.text), label + ': the station window replays it as a user \'[steering]\' line');
    assert.ok(windows.page.some(m => m && m.role === 'user' && m.content === '[steering] ' + note.text), label + ': and so does the page\'s own window');
  }
  for (const file of ex.attachments || []) {
    if (!inGet(file.runId)) continue;
    const proof = (options && options.proof) || [];
    const rows = proof.filter(r => r.kind === 'attachment' && r.sourceRunId === file.runId && r.attachment && r.attachment.id === file.id);
    assert.equal(rows.length, 1, label + ': the attachment ' + file.id + ' of ' + file.runId + ' is exactly one row in the proof view');
    assert.deepEqual([rows[0].role, rows[0].taint, rows[0].attachment.path, rows[0].turnId], ['system', 'user attachment', file.path, file.turnId],
      label + ': a system row stamped \'user attachment\', at the file\'s path, carrying the turn the run answered');
    const stamp = key(rows[0]);
    assert.ok(!turns.some(r => r.kind === 'attachment') && !(page.ws.history || []).some(r => r.kind === 'attachment'), label + ': no attachment row is in GET or in the page (the matrix hides it)');
    assert.ok(!windows.station.ids.filter(Boolean).some(id => JSON.stringify([id.streamId, id.rowId]) === stamp) && !windows.page.some(m => m && Number.isSafeInteger(m.rowId) && JSON.stringify([m.streamId || page.ws.id, m.rowId]) === stamp),
      label + ': and in neither window (' + K.MATRIX.attachment['model-replay'] + ')');
  }
  for (const back of ex.returns || []) {
    if (!inGet(back.runId)) continue;
    const rows = turns.filter(r => r.kind === 'delivery' && r.sourceRunId === back.runId);
    assert.equal(rows.length, 1, label + ': the return of ' + back.runId + ' is exactly one delivery row');
    assert.deepEqual([rows[0].role, rows[0].content, rows[0].turnId], ['assistant', back.text, K.runTurnId(back.runId)], label + ': an assistant row holding the routine\'s words');
    assert.equal(page.ws.history.filter(r => r.kind === 'delivery' && r.sourceRunId === back.runId).length, 1, label + ': the page holds the return once, folded or read');
    assert.ok(windows.station.messages.some(m => m && m.role === 'assistant' && m.content === back.text), label + ': the station window replays it');
  }
}
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
module.exports = { check, checkKinds, key, dialogue, mulberry32 };
