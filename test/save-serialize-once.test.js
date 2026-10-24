/* node test/save-serialize-once.test.js — one persist serializes the save once for the cache and reuses that string
   (idle CPU piece 3, 2026-10-20).

   THE COST. Every persist burst re-serialized the WHOLE save (Andrew's: 3.75 MB) again and again: Save.write stringified it,
   CloudSave.push cloned it with parse(stringify), the debounced flush stringified it for the POST, and the ACK re-parsed the
   cache and stringified BOTH sides to compare them before stringifying again for setItem — 6 whole-save stringifies and
   2 parses, a 50-200 ms main-thread stall each time on a big station.

   NOW: Save.write hands its string to push (one parse to clone), and an ACK whose cache still holds that exact string marks
   it clean with one stringify — 3 stringifies and 1 parse. THE BYTES DO NOT CHANGE: every cache write here is compared
   against the old algorithm's output (re-implemented below from the trunk code) byte for byte.

   GENUINE (executed): the REAL App.persist (sliced from app.js with A.fnBody), the real save.js and the real cloudsave.js run
   in one vm context with a JSON that counts whole-save calls, a Map localStorage and a fake /api/save that acknowledges. So
   the wiring itself is under test — persist taking Save.takeWriteRaw() after Save.write and handing it to CloudSave.push —
   not a copy of it.

   FIX ROUND (2026-10-20): the string is dropped once its ACK has used it. It was kept in a WeakMap keyed by the pushed doc,
   which CloudSave holds as latestLocal until the next push: a second whole-save string pinned for the life of the page
   (~7.5 MB for a 3.75 MB save of two-byte text). Measured below on the real heap after a forced GC. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const BIG = 500 * 1024;
const PERSIST = A.fnBody(read('frontend/app/app.js'), '  function persist() {');
A.ok(PERSIST.length > 500 && PERSIST.length < 8000 && /Save\.write\(envelope\)/.test(PERSIST) && /CloudSave\.push\(/.test(PERSIST),
  'fixture: App.persist sliced from app.js (' + PERSIST.length + ' chars)');

/* one station: the real save.js + cloudsave.js + App.persist, with persist's own collaborators stubbed (an agent, a roster of
   one, the harness totals) and Workstreams.serialize() serving the conversations under test */
function station({ keepPosted = true } = {}) {
  let bigStringify = 0, bigParse = 0, lastBigLen = 0, ack = { ok: true, revision: 7, updatedAt: 1760000000123 }, posted = null, convs = null;
  const cache = new Map();
  const notices = [];
  const counting = {
    stringify: (...a) => { const out = JSON.stringify(...a); if (out && out.length > BIG) { bigStringify++; lastBigLen = out.length; } return out; },
    parse: (s, ...r) => { if (typeof s === 'string' && s.length > BIG) bigParse++; return JSON.parse(s, ...r); }
  };
  const ctx = vm.createContext({
    JSON: counting, console: { warn() {}, info() {}, log() {}, debug() {} }, Math, Date, Number, Object, Array, String, Promise, Error, Map, Set, WeakMap,
    setTimeout, clearTimeout, AbortController, crypto: { randomUUID: () => 'client-1' },
    module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'),
    localStorage: { getItem: k => (cache.has(k) ? cache.get(k) : null), setItem: (k, v) => cache.set(k, String(v)), removeItem: k => cache.delete(k) },
    fetch: async (url, opts) => { if (keepPosted) posted = opts && opts.body; return { ok: true, status: 200, json: async () => Object.assign({}, ack) }; },
    Harness: { totals: () => ({ tokens: 1, cost: 0, calls: 1 }), getProv: () => 'openrouter', getReasoningEffort: () => undefined },
    Workstreams: { serialize: () => convs },
    StationUI: { flashSave() {}, notify: (...a) => notices.push(a), refreshSave() {} }
  });
  vm.runInContext(read('frontend/app/save.js'), ctx, { filename: 'save.js' });
  vm.runInContext(read('frontend/app/cloudsave.js') + '\nthis.CloudSave = CloudSave;', ctx, { filename: 'cloudsave.js' });
  vm.runInContext('this.Save = Save;', ctx);
  vm.runInContext([
    "const agent = { id: 'agent', name: 'NOVA', provider: 'openrouter' }, agents = new Map([['agent', agent]]), station = null;",
    'let saveFailureNotified = false, rosterPushFailed = false;',
    'function liveAgents() { return [agent]; }',
    'function serializeAgentLite(a) { return a; }',
    'function pushRoster() {}',
    PERSIST,
    'this.persist = persist;'
  ].join('\n'), ctx, { filename: 'app.js#persist' });
  return { Save: ctx.Save, CloudSave: ctx.CloudSave, cache, posted: () => posted, setAck: a => { ack = a; },
    // App.persist as the app runs it; returns the string the cache was given (Save.write's own)
    persist: c => { convs = c; const ok = ctx.persist(); return ok ? cache.get('starnet.save') : null; },
    counts: () => ({ stringify: bigStringify, parse: bigParse }), reset: () => { bigStringify = 0; bigParse = 0; },
    lastBigLen: () => lastBigLen, notices };
}
// a ~1 MB save shaped like a real one (the workstreams carry the bulk); `text` lets a test make it two-byte
function bigConvs(n = 60, text = 'message') {
  const workstreams = Array.from({ length: n }, (_, i) => ({ id: 'ws' + i, title: 'Session ' + i, agentId: 'agent', kind: 'chat', lane: 'active',
    history: Array.from({ length: 24 }, (_, j) => ({ role: j % 2 ? 'assistant' : 'user', content: (text + ' ' + i + '.' + j + ' ').repeat(40), ts: 1000 + j })) }));
  return { workstreams, activeId: 'ws0', generalId: 'ws0' };
}
// THE OLD ACK (trunk cloudsave.js), for the byte comparison: parse the cache, compare payloads, stamp + stringify
function oldAck(cachedRaw, sentDoc, revision, body) {
  const cached = JSON.parse(cachedRaw);
  const payload = d => JSON.stringify({ ...d, _saveClient: undefined, _saveRevision: undefined });
  if (!(cached && payload(cached) === payload(sentDoc))) return cachedRaw;
  cached._saveRevision = revision; cached._saveDirty = false;
  if (Number.isFinite(body.updatedAt)) cached.updatedAt = body.updatedAt;
  return JSON.stringify(cached);
}

(async () => {
  /* one App.persist + flush + ACK on a ~1 MB save */
  {
    const s = station();
    s.reset();
    const raw = s.persist(bigConvs());
    A.ok(raw && raw.length > BIG, 'fixture: App.persist wrote a big save (' + Math.round(((raw && raw.length) || 0) / 1024) + ' KB)');
    const sent = JSON.parse(raw); sent._saveRevision = 0; sent._saveClient = 'client-1';
    const expected = oldAck(raw, sent, 7, { updatedAt: 1760000000123 });
    A.eq(await s.CloudSave.flush({ force: true }), true, 'the station acknowledges the write');
    const c = s.counts();
    A.ok(c.stringify <= 3, 'one App.persist burst stringifies the whole save at most 3 times (was 6, and 6 again if persist stops handing over the string Save.write made): ' + c.stringify);
    A.ok(c.parse <= 1, 'and parses it at most once (was 2): ' + c.parse);
    A.eq(s.cache.get('starnet.save'), expected, 'the cache bytes after the ACK are EXACTLY what the old compare path wrote');
    const landed = JSON.parse(s.cache.get('starnet.save'));
    A.ok(landed._saveDirty === false && landed._saveRevision === 7 && landed.updatedAt === 1760000000123, 'the cached save is clean, at the acknowledged revision and time');
    A.eq(JSON.stringify({ ...JSON.parse(s.posted()), _saveClient: undefined, _saveRevision: undefined }), JSON.stringify({ ...JSON.parse(raw), _saveRevision: undefined }), 'the POSTed save is the same save');
  }

  /* an ACK without updatedAt keeps the cache's own stamp — same bytes as before */
  {
    const s = station();
    s.setAck({ ok: true, revision: 3 });
    const raw = s.persist(bigConvs());
    const sent = JSON.parse(raw); sent._saveRevision = 0; sent._saveClient = 'client-1';
    const expected = oldAck(raw, sent, 3, {});
    await s.CloudSave.flush({ force: true });
    A.eq(s.cache.get('starnet.save'), expected, 'no updatedAt in the ACK: the same bytes the old path wrote');
  }

  /* the cache moved on (another window / a later write) before the ACK: the compare path decides, as before */
  {
    const s = station();
    const raw = s.persist(bigConvs());
    const other = JSON.parse(raw); other.workstreams[0].title = 'edited elsewhere';
    const otherRaw = JSON.stringify(other);
    s.cache.set('starnet.save', otherRaw);
    s.reset();
    await s.CloudSave.flush({ force: true });
    A.eq(s.cache.get('starnet.save'), otherRaw, 'a cache that holds a different save is left alone (the old compare path)');
    A.ok(s.counts().parse >= 1, 'that case still parses and compares, exactly as before');
  }

  /* a push without raw (any other caller): the old clone and the old compare path, the same bytes */
  {
    const s = station();
    const envelope = s.Save.envelope(Object.assign({ agent: { id: 'agent' } }, bigConvs()));
    const doc = s.Save.write(envelope); s.Save.takeWriteRaw();
    const raw = s.cache.get('starnet.save');
    s.CloudSave.push(doc, { cacheFailed: false });
    const sent = JSON.parse(raw); sent._saveRevision = 0; sent._saveClient = 'client-1';
    const expected = oldAck(raw, sent, 7, { updatedAt: 1760000000123 });
    await s.CloudSave.flush({ force: true });
    A.eq(s.cache.get('starnet.save'), expected, 'without raw: the old path, the same bytes');
  }

  /* a queued newer save while one is in flight: only the newest becomes clean (the existing rule) */
  {
    const s = station();
    s.persist(bigConvs());
    const first = s.CloudSave.flush({ force: true });
    const c2 = bigConvs(); c2.workstreams[1].title = 'newer';
    const raw2 = s.persist(c2);
    await first;
    A.eq(s.cache.get('starnet.save'), raw2, 'an ACK for an older save never touches the newer cached save');
    await s.CloudSave.flush({ force: true });
    const landed = JSON.parse(s.cache.get('starnet.save'));
    A.ok(landed._saveDirty === false && landed.workstreams[1].title === 'newer', 'the newest save becomes clean on its own ACK');
  }

  /* a failed POST drops the string (an outage pins no second whole-save copy): the retry takes the old compare path */
  {
    const s = station();
    const raw = s.persist(bigConvs());
    s.setAck({ ok: false, error: 'busy' });
    A.eq(await s.CloudSave.flush({ force: true }), false, 'fixture: the first attempt is refused');
    s.setAck({ ok: true, revision: 9, updatedAt: 1760000000999 });
    const sent = JSON.parse(raw); sent._saveRevision = 0; sent._saveClient = 'client-1';
    const expected = oldAck(raw, sent, 9, { updatedAt: 1760000000999 });
    s.reset();
    A.eq(await s.CloudSave.flush({ force: true }), true, 'the retry is acknowledged');
    A.ok(s.counts().parse >= 1, 'the retried doc no longer holds its string: the ACK compares the old way (a parse)');
    A.eq(s.cache.get('starnet.save'), expected, '…writing the same bytes the old path wrote');
  }

  /* Save.write keeps its contract: the doc (or null), the same bytes in the cache */
  {
    const s = station();
    const env = s.Save.envelope({ agent: { id: 'agent' } });
    const doc = s.Save.write(env);
    A.eq(s.cache.get('starnet.save'), JSON.stringify(doc), 'Save.write caches JSON.stringify(doc), as before');
    A.eq(s.Save.takeWriteRaw(), s.cache.get('starnet.save'), 'takeWriteRaw is that same string');
    A.eq(s.Save.takeWriteRaw(), null, '…handed over once');
  }

  /* A SAVE PAST THE CACHE BUDGET (a large station) is never offered to the cache, and still serializes once: Save.write's
     string goes to CloudSave (one parse to clone) and the POST stringifies it — 2 whole-save stringifies, no cache write */
  {
    const s = station();
    s.reset();
    const raw = s.persist(bigConvs(150, 'reply — note'));
    A.eq(raw, null, 'fixture: a save past the cache budget is not written to the cache');
    A.ok(s.lastBigLen() > s.Save.CACHE_MAX_CHARS, 'fixture: the save is past the budget (' + s.lastBigLen() + ' chars)');
    A.ok(s.Save.writeSkipped(), 'Save.write skipped it rather than failing it');
    A.eq(await s.CloudSave.flush({ force: true }), true, 'the station file acknowledges the oversized save');
    const c = s.counts();
    A.ok(c.stringify <= 2, 'an oversized save stringifies the whole save at most twice (Save.write + the POST): ' + c.stringify);
    A.ok(c.parse <= 1, 'and parses it at most once (the clone): ' + c.parse);
    A.eq(s.cache.has('starnet.save'), false, 'the cache was never written');
    A.ok(!!s.posted() && JSON.parse(s.posted()).workstreams.length === 150, 'the whole save was POSTed to the station file');
    A.eq(s.notices.length, 0, 'no "browser storage full" notice for a save that is simply too large to cache');
  }

  /* THE STRING IS NOT KEPT AFTER ITS ACK. Same App.persist + flush + ACK twice on a two-byte save (~6 MB as a string): once
     with persist handing CloudSave the string, once without (the control). After a forced GC — both stations still alive,
     the cache emptied — the heap may differ by far less than one copy of that string. Kept, it was +1 copy for good. */
  {
    const v8 = require('v8');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const heapAfterAck = async withRaw => {
      const s = station({ keepPosted: false });
      // the control: Save still lets go of its string, but persist hands none over (the old clone path)
      if (!withRaw) { const take = s.Save.takeWriteRaw; s.Save.takeWriteRaw = () => { take(); return null; }; }
      // this save is past the cache budget, so persist() returns no cache string: its size is the whole-save string Save.write made
      s.persist(bigConvs(150, 'reply — note'));
      const chars = s.lastBigLen();
      A.eq(await s.CloudSave.flush({ force: true }), true, (withRaw ? 'with' : 'without') + ' the string: acknowledged');
      s.cache.clear();
      for (let n = 0; n < 3; n++) { gc(); await new Promise(r => setImmediate(r)); }
      return { heap: process.memoryUsage().heapUsed, chars, s };
    };
    let control = await heapAfterAck(false);
    const controlHeap = control.heap;
    control = null;
    for (let n = 0; n < 3; n++) { gc(); await new Promise(r => setImmediate(r)); }
    const withRaw = await heapAfterAck(true);
    const rawBytes = withRaw.chars * 2;   // two-byte text: 2 bytes a char
    const extra = withRaw.heap - controlHeap;
    A.ok(withRaw.chars > 2 * 1024 * 1024, 'fixture: a two-byte save of ' + (withRaw.chars / 1048576).toFixed(1) + 'M chars');
    A.ok(extra < rawBytes / 2, 'after its ACK the whole-save string is not retained: heap +' + (extra / 1048576).toFixed(2) + ' MB against one copy of ' + (rawBytes / 1048576).toFixed(2) + ' MB');
    A.ok(withRaw.s.CloudSave, 'fixture: the station measured was still alive');
  }

  A.report('save-serialize-once.test');
})().catch(e => { console.error(e); process.exit(1); });
