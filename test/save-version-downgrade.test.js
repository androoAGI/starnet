/* node test/save-version-downgrade.test.js — INVARIANT older-build-refuses-v7 (save-history-by-reference, step S2).

   Save format v7 lets a session's `history` hold a packed element ({ "$ref": "…", "res": {…} }) that names a run of rows the
   station's transcript holds. A page that does not know the element would draw it as an empty message, and its next persist
   would write that back over the real history. The only defence an older page has is its forward-version guard: a save
   whose version is past its own CURRENT is refused and left byte for byte untouched. So the guard only protects if THIS build
   stamps every save it writes past the last build that cannot read the element.

   The "older build" here is test/fixtures/save-v6-frozen.js: frontend/app/save.js as it stood at f607b0c39 (CURRENT = 6), the
   page every v6 install runs today. Its CloudSave is this build's cloudsave.js run against the frozen Save: the forward-version
   code in cloudsave.js did not change in this step, and it takes its ceiling from the Save global. Over every shape of
   envelope this build writes (bare, all-inline history, packed history):
     · the frozen Save says 'future' with the version, hands back no doc, and the cache bytes are untouched (no write at all,
       no pre-migrate backup minted);
     · the frozen CloudSave answers its local or remote copy with the future sentinel and posts nothing;
     · this build reads the v6 doc that same frozen page wrote as v7, field for field, nothing moved;
     · cloudsave.js's own ceiling (with Save loaded, and the fallback literal without it) is exactly Save.CURRENT;
     · the station holds the same line from its side: sidecar/save-merge.js answers a merge from a page of an older format with
       newerFormat and writes nothing. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

// ---- a browser cache that counts every write, so "untouched" means no setItem/removeItem at all -------------------------------
const mem = {};
let writes = 0;
const storage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { writes++; mem[k] = String(v); },
  removeItem: k => { writes++; delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; }
};
global.localStorage = storage;
const KEY = 'starnet.save';
const put = raw => { storage.clear(); mem[KEY] = raw; writes = 0; };   // a seed, not a write the code under test made

const Save = require('../frontend/app/save.js');             // THIS build
const Frozen = require('./fixtures/save-v6-frozen.js');      // the page every v6 install runs today
const cloudSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/cloudsave.js'), 'utf8');
const Core = require('../frontend/app/cloudsavecore.js');

// cloudsave.js in its own context with the Save global it should read its ceiling from (or none: the load-order fallback),
// a recording fetch, and this cache
function cloudsaveOver(SaveGlobal, fetchImpl) {
  const ctx = { console, module: { exports: {} }, require: () => Core, setTimeout, clearTimeout, AbortController, localStorage: storage, fetch: fetchImpl };
  if (SaveGlobal) ctx.Save = SaveGlobal;
  vm.runInNewContext(cloudSrc, ctx);
  return ctx.module.exports;
}
const deepEq = (a, b, msg) => { try { assert.deepStrictEqual(a, b); A.ok(true); } catch (e) { A.ok(false, msg + ' — ' + String(e.message).split('\n').slice(0, 6).join(' | ')); } };

(async () => {
  // ---- 0. this build is past the frozen one: the whole guard rests on this number --------------------------------------------
  A.eq(Frozen.CURRENT, 6, 'the frozen page is the v6 build');
  A.ok(Save.CURRENT > Frozen.CURRENT, 'this build stamps its saves past the last build that cannot read a packed element (CURRENT ' + Save.CURRENT + ' vs ' + Frozen.CURRENT + ')');
  A.ok(Save.CURRENT >= 7, 'the history-by-reference format is v7 or later');
  A.ok(Save.envelope({}).version > Frozen.CURRENT, 'every envelope this build writes is stamped past the frozen page');

  // ---- the envelopes this build writes: bare, all-inline history, packed history ----------------------------------------------
  const agent = { id: 'agent', name: 'NOVA' };
  const rows = [
    { streamId: 's1', rowId: 101, role: 'user', content: 'hello', turnId: 'turn-aaaaaaaa' },
    { streamId: 's1', rowId: 102, role: 'assistant', content: 'hi, Commander', sourceRunId: 'run-1' },
    { streamId: 's1', rowId: 103, role: 'user', content: 'and again' }
  ];
  const variants = { 'bare agent': { agent }, 'all-inline history': { agent, workstreams: [{ id: 's1', history: rows.map(r => Object.assign({}, r)) }] } };
  let HistoryRef = null;
  try { HistoryRef = require('../frontend/app/historyref.js'); } catch (e) { A.ok(false, 'frontend/app/historyref.js loads (' + String(e.message).split('\n')[0] + ')'); }
  if (HistoryRef) {
    const sealed = new Map(rows.map(r => [HistoryRef.keyOf('s1', r.rowId), JSON.parse(JSON.stringify(r))]));
    const packed = HistoryRef.pack(rows.map(r => Object.assign({ typedText: 'typed ' + r.rowId }, r)), { streamId: 's1', seal: key => sealed.get(key) || null });
    A.ok(packed.length === 1 && HistoryRef.isRef(packed[0]), 'the fixture history packs into one element');
    variants['packed history'] = { agent, workstreams: [{ id: 's1', history: packed }, { id: 's2', history: [{ role: 'system', sys: true, content: 'a local note' }] }] };
  }

  for (const [name, state] of Object.entries(variants)) {
    const doc = Save.envelope(state);
    const raw = JSON.stringify(doc);
    put(raw);

    // the frozen page: refuses, names the version, hands back nothing, and writes nothing
    const st = Frozen.loadStatus();
    A.eq(st.status, 'future', name + ': the older page refuses this build\'s save');
    A.eq(st.version, doc.version, name + ': ...naming the version it cannot read');
    A.eq(st.doc, null, name + ': ...handing back no doc to adopt or re-save');
    A.eq(storage.getItem(KEY), raw, name + ': the cache bytes are untouched');
    A.eq(writes, 0, name + ': the older page made no write at all (no re-stamp, no pre-migrate backup)');
    A.eq(storage.getItem(Frozen.PRE_MIGRATE_BACKUP_KEY), null, name + ': no pre-migrate backup was minted from a save it refused');
    A.eq(Frozen.load(), null, name + ': load() hands no legacy caller a doc');
    A.ok(Frozen.isFuture(), name + ': isFuture()');
    A.eq(Frozen.fromDoc(JSON.parse(raw)).status, 'future', name + ': the in-memory path (a station copy) refuses it too');
    A.eq(writes, 0, name + ': still no write after every older-page read');

    // this build reads its own envelope back as it is
    const own = Save.loadStatus();
    A.eq(own.status, 'ok', name + ': this build reads its own save');
    deepEq(own.doc, JSON.parse(raw), name + ': ...field for field');

    // the older page's CloudSave: the local copy is newer than it can read -> sentinel before any network call
    const calls = [];
    const refuse = async (url, init) => { calls.push({ url: String(url), method: String((init && init.method) || 'GET') }); return { ok: true, status: 200, json: async () => ({ save: JSON.parse(raw) }) }; };
    const old = cloudsaveOver(Frozen, refuse);
    const outLocal = await old.reconcile(JSON.parse(raw));
    A.ok(old.isFutureSentinel(outLocal), name + ': the older CloudSave answers a newer local copy with the future sentinel');
    A.eq(outLocal && outLocal.version, doc.version, name + ': ...carrying the version');
    A.eq(calls.length, 0, name + ': ...before any network call');
    A.eq(storage.getItem(KEY), raw, name + ': ...and the cache is untouched');
    A.eq(writes, 0, name + ': ...with no write');

    // ...and a newer copy ON THE STATION (this page is still a v6 one) is never adopted, never overwritten
    const v6 = Frozen.envelope({ agent: { id: 'agent', name: 'OLDPAGE' } });
    const v6raw = JSON.stringify(v6);
    put(v6raw);
    calls.length = 0;
    const old2 = cloudsaveOver(Frozen, refuse);
    const outRemote = await old2.reconcile(JSON.parse(v6raw));
    A.ok(old2.isFutureSentinel(outRemote), name + ': the older CloudSave answers a newer station copy with the future sentinel');
    A.eq(calls.filter(c => c.method !== 'GET').length, 0, name + ': ...and posts nothing (' + calls.map(c => c.method).join(',') + ')');
    A.eq(storage.getItem(KEY), v6raw, name + ': ...the older page\'s own cache is not overwritten by the newer save');
    A.eq(writes, 0, name + ': ...with no write');
  }

  // ---- 1. a v6 doc the frozen page wrote: this build reads it as v7, nothing moved ---------------------------------------------
  {
    const history = rows.map(r => Object.assign({}, r)).concat([
      { role: 'system', sys: true, content: 'a note' },
      { role: 'user', content: 'sent, not yet answered', turnId: 'turn-bbbbbbbb' },
      { role: 'assistant', content: 'a partial', stopped: true, stopNote: 'stopped' }
    ]);
    const v6 = Frozen.envelope({ agent, workstreams: [{ id: 's1', title: 'Old', titleStrong: true, history, runIds: ['run-1'] }], settings: { theme: 'amber' }, someFutureField: { keep: [1, 2] } });
    A.eq(v6.version, 6, 'the frozen page writes v6');
    const raw6 = JSON.stringify(v6);
    put(raw6);
    const st = Save.loadStatus();
    A.eq([st.status, st.version], ['ok', Save.CURRENT], 'this build accepts a v6 save');
    deepEq(st.doc, Object.assign(JSON.parse(raw6), { version: Save.CURRENT }), 'a v6 save reads as the current version with every field and every history row exactly as saved');
    A.eq(storage.getItem(KEY), raw6, 'the load-time migration leaves the stored bytes untouched');
    A.eq(storage.getItem(Save.PRE_MIGRATE_BACKUP_KEY), raw6, 'the browser keeps the raw v6 bytes as the recovery copy');
    deepEq(Save.fromDoc(JSON.parse(raw6)).doc, Object.assign(JSON.parse(raw6), { version: Save.CURRENT }), 'the in-memory path agrees');
  }

  // ---- 2. cloudsave.js's own ceiling IS Save.CURRENT, with Save loaded and without it (the load-order fallback) ----------------
  {
    const at = version => ({ schema: 'starnet.save', version, updatedAt: 1, agent: { id: 'agent' } });
    const nothing = async () => { throw new Error('no network in this check'); };
    const withSave = cloudsaveOver({ CURRENT: Save.CURRENT }, nothing), without = cloudsaveOver(null, nothing), frozenCloud = cloudsaveOver(Frozen, nothing);
    A.eq([withSave._isFutureSave(at(Save.CURRENT)), withSave._isFutureSave(at(Save.CURRENT + 1))], [false, true], 'with Save loaded the ceiling is Save.CURRENT');
    A.eq([without._isFutureSave(at(Save.CURRENT)), without._isFutureSave(at(Save.CURRENT + 1))], [false, true], 'without Save the fallback literal is Save.CURRENT');
    A.eq([frozenCloud._isFutureSave(at(Frozen.CURRENT)), frozenCloud._isFutureSave(at(Save.CURRENT))], [false, true], 'the older page\'s ceiling is its own CURRENT, so this build\'s save is past it');
  }

  // ---- 3. the station holds the same line from its side: a merge from a page of an older format is refused, nothing is written -----
  {
    const SaveMerge = require('../sidecar/save-merge.js');
    const stationDoc = { schema: 'starnet.save', version: Save.CURRENT, updatedAt: 10, _saveRevision: 3, agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, workstreams: [] };
    const reads = [];
    const saveStore = { loadState: id => { reads.push(id); return { status: 'ok', doc: stationDoc }; } };
    const oldPage = Frozen.envelope({ agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, _saveMerge: { by: 'w-old', top: [], rows: [], gone: [] } });
    A.eq(oldPage.version, Frozen.CURRENT, 'fixture: the older page stamps its own format');
    // a station that did not refuse would go on to merge into a file this fake does not have: that is a failure of the line, not a crash
    let out;
    try { out = SaveMerge.write(oldPage, { saveStore, agentId: 'agent', now: 100 }); }
    catch (e) { out = { status: 0, body: { ok: false, merged: 'went on to merge (' + String(e && e.message).slice(0, 60) + ')' }, wrote: null }; }
    A.eq([out.status, out.body.ok, out.body.newerFormat], [200, false, true], 'the station answers an older page\'s merge with newerFormat, not a merge' + (out.body.merged ? ' — ' + out.body.merged : ''));
    A.eq([out.wrote, reads], [null, ['agent']], '...having written nothing');
  }

  A.report('save-version-downgrade');
})();
