/* node test/turnmerge.trimmed-marker.test.js — the trimmed-history marker survives the legacy and shadow merges
   (context-budget-and-fold, step 1).

   The page caps its saved history (chat.js capHistory) and records the drop as ONE leading row,
   { role:'system', truncated:true, content:'…(N earlier turns trimmed from local history)' }. The frozen legacy merge
   (legacyMerge, byte-pinned by turnmerge.test.js as the rollback owner) keeps only user/assistant rows, so every
   reload through the legacy path erased that line and the thread read as complete (probe 11-04:
   legacyMerge([marker, user, assistant], [user, assistant]) -> [user, assistant]). legacyWithIdentity, the legacy and
   shadow path of reconcile and the phone host's, now puts the local marker back FIRST, once, byte for byte, whenever
   dialogue follows it; the frozen function is untouched. A history without the marker never gains one, two markers
   collapse to one, and a marker with nothing after it (an emptied or forgotten thread) is not kept.

   The id merge decides the marker from station evidence only (rule R7: turnmerge.test.js asserts a stale local marker
   is dropped), so there the property is the converse: never two, always first, exactly one whenever the station
   proves older turns. Shadow compares the two without calling a marker a divergence. */
'use strict';
const A = require('./_assert.js');
const M = require('../frontend/app/turnmerge.js');

const MARKER_TEXT = '…(37 earlier turns trimmed from local history)';
const marker = () => ({ role: 'system', truncated: true, content: MARKER_TEXT });
const u = (content, extra) => Object.assign({ role: 'user', content }, extra);
const a = (content, extra) => Object.assign({ role: 'assistant', content }, extra);
const json = x => JSON.stringify(x);
const markers = rows => rows.filter(r => r && r.truncated);
const dialogue = rows => rows.filter(r => r && !r.truncated);

const LOCAL = () => [u('one'), a('first answer'), u('two'), a('second answer')];
const TURN_LISTS = {
  empty: [],
  'fully matched': [u('one'), a('first answer'), u('two'), a('second answer')],
  'partly matched': [u('one'), a('first answer'), u('three'), a('third answer')],
  'longer than local': [u('zero'), a('zeroth answer'), u('one'), a('first answer'), u('two'), a('second answer'), u('four'), a('fourth answer')]
};

(async () => {
  // ---- 1. THE LEGACY PATH (legacyWithIdentity): the marker survives every turn list ----
  for (const [name, turns] of Object.entries(TURN_LISTS)) {
    const m = marker();
    const local = [m].concat(LOCAL());
    const out = M.legacyWithIdentity(local, turns);
    A.eq(markers(out).length, 1, name + ': exactly one marker');
    A.ok(out[0] === m, name + ': it is first, and the local marker itself');
    A.eq(json(out[0]), json(marker()), name + ': byte-equal to the local one');
    // the frozen merge's own answer for the same dialogue, untouched by the marker
    A.eq(json(out.slice(1)), json(M.legacyMerge(LOCAL(), turns)), name + ': the dialogue keeps its order and its bytes');
    // a history that never had one never gains one
    const plain = M.legacyWithIdentity(LOCAL(), turns);
    A.eq(markers(plain).length, 0, name + ': no marker in, no marker out');
    A.eq(json(plain), json(M.legacyMerge(LOCAL(), turns)), name + ': and the merge is the frozen merge exactly');
    // the marker is also stable under a second merge (reload after reload)
    const again = M.legacyWithIdentity(out, turns);
    A.eq(markers(again).length, 1, name + ': one marker after a second merge');
    A.eq(json(again), json(out), name + ': the settled merge is idempotent');
  }

  // ---- 2. EDGES ----
  {
    const m1 = marker(), m2 = Object.assign(marker(), { content: 'a second, stale marker' });
    const out = M.legacyWithIdentity([m1, m2].concat(LOCAL()), TURN_LISTS['fully matched']);
    A.eq(markers(out).length, 1, 'two markers collapse to one');
    A.ok(out[0] === m1, 'the leading one is the one kept');
    const mid = M.legacyWithIdentity([u('one'), marker(), a('first answer')], []);
    A.eq(markers(mid).length, 0, 'a marker that does not lead the history is not resurrected (it is the page that puts it first)');
    A.eq(M.legacyWithIdentity([marker()], TURN_LISTS.empty).length, 0, 'a marker with nothing after it is not kept');
    // an emptied thread: every dialogue row forgotten -> no stray "N earlier turns trimmed" line over nothing
    const forgotten = M.legacyWithIdentity([marker(), u('gone', { ts: 5 }), a('gone too', { ts: 6 })], [], { v: 2, streamId: 's', forgottenAt: 10, forgotten: { keys: [], runIds: [] } });
    A.eq(forgotten.length, 0, 'a forgotten thread leaves no stray marker');
    // station turns older than every local row are inserted before the local rows: the marker still leads them
    const older = M.legacyWithIdentity([marker(), u('local only')], [u('station older'), a('station older answer')]);
    A.ok(older[0].truncated && older.slice(1).map(r => r.content).join('|') === 'station older|station older answer|local only', 'the marker leads station turns the page never had');
    A.ok(!markers(M.legacyWithIdentity(undefined, [u('x')])).length && !markers(M.legacyWithIdentity(null, null)).length, 'no local history, no marker, no throw');
  }

  // ---- 3. RECONCILE (the page's path): legacy and shadow keep it, and shadow does not report it as a divergence ----
  const station = (row, rowId) => Object.assign({ streamId: 's', rowId }, row);
  const stationRows = () => [station(u('one'), 1), station(a('first answer'), 2), station(u('two'), 3), station(a('second answer'), 4)];
  const identity = (merge, extra) => Object.assign({ v: 2, streamId: 's', fromRowId: 1, liveRunIds: [], collided: [], retracted: [], forgottenAt: 0, forgotten: { keys: [], runIds: [] }, modes: { merge } }, extra);
  for (const mode of ['legacy', 'shadow']) {
    const notes = [];
    const m = marker();
    const out = await M.reconcile([m].concat(LOCAL()), { stream: 's', turns: stationRows(), identity: identity(mode) }, { note: e => notes.push(e) });
    A.eq(markers(out.rows).length, 1, 'reconcile ' + mode + ': the marker is in the merged thread');
    A.ok(out.rows[0] === m, 'reconcile ' + mode + ': first, and the local one');
    A.eq(dialogue(out.rows).length, 4, 'reconcile ' + mode + ': with the four dialogue rows after it');
    const control = [];
    await M.reconcile(LOCAL(), { stream: 's', turns: stationRows(), identity: identity(mode) }, { note: e => control.push(e) });
    A.eq(notes.filter(e => e && e.event === 'merge-divergence').length, control.filter(e => e && e.event === 'merge-divergence').length,
      'reconcile ' + mode + ': the marker adds no merge-divergence the same history without it would not have');
  }
  {
    // a station that does not speak identity at all (older stations): the same legacy merge
    const m = marker();
    const out = await M.reconcile([m].concat(LOCAL()), { stream: 's', turns: LOCAL() }, {});
    A.ok(out.rows[0] === m && markers(out.rows).length === 1, 'reconcile without identity: the marker survives');
  }
  {
    // compare() calls neither a missing nor a differently-worded marker a difference: it is presentation, not dialogue
    const rows = LOCAL();
    A.ok(M.compare([marker()].concat(rows), rows).same, 'compare: a marker on one side only is not a divergence');
    A.ok(M.compare([marker()].concat(rows), [Object.assign(marker(), { content: '… earlier turns are stored on the station' })].concat(rows)).same, 'compare: nor are two markers worded differently');
    const changed = rows.map((r, i) => i === 1 ? Object.assign({}, r, { content: 'a different answer' }) : r);
    A.ok(!M.compare([marker()].concat(rows), changed).same, 'compare: dialogue differences are still reported');
  }

  // ---- 4. THE ID MERGE decides from station evidence: never two, always first, one when the station proves older turns ----
  for (const [name, turns] of Object.entries(TURN_LISTS)) for (const hasOlder of [false, true]) {
    const station4 = turns.map((t, i) => station(t, i + 1));
    const out = M.merge([marker()].concat(LOCAL()), station4, { identity: identity('id', { hasOlder }) });
    const found = markers(out.rows);
    A.ok(found.length <= 1, 'id ' + name + (hasOlder ? ' +older' : '') + ': never two markers');
    A.ok(found.length === 0 || out.rows[0] === found[0], 'id ' + name + (hasOlder ? ' +older' : '') + ': a marker is always first');
    if (hasOlder) A.eq(found.length, 1, 'id ' + name + ' +older: exactly one marker when the station proves older turns');
    const without = M.merge(LOCAL(), station4, { identity: identity('id', { hasOlder }) });
    A.eq(markers(without.rows).length, hasOlder ? 1 : 0, 'id ' + name + (hasOlder ? ' +older' : '') + ': a history that never had a marker gains one only on station proof');
  }

  A.report('turnmerge.trimmed-marker');
})().catch(e => { console.error(e); process.exit(1); });
