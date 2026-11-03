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
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
module.exports = { check, key, dialogue, mulberry32 };
