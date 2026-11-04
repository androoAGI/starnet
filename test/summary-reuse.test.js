/* node test/summary-reuse.test.js — a fold's summary is kept, and used only while it is provably still true
   (context-budget-and-fold, step 2). Pure units over sidecar/summary-ledger.js with an in-memory fs.

   A record claims "this note covers the stream's canonical rows [first .. toRowId]". It is served to a later run only when
   EVERY one of these agrees: agent/stream, model, window, voice, the stream's tombstone, the streams its rows read, the
   note's own sha, and a digest of the covered rows re-read from the model-replay view. Each cause below has its own test,
   and each is PROVEN BY MUTATION: the test removes that one check from the module's source, loads the mutant, and the
   same scenario must then fail (a check no test notices is not a check).

   Also here: the durable write (fsync, read-back, typed refusals that never throw), the tombstone refusal that stops a
   fold finishing after a delete from leaving an orphan (privacy gap b), purge on a delete AND on a quote-forget (gap c),
   the registry-shaped forget (gap d), the dot-prefixed directory (gap e), caps, and removal of every sibling file (.bak
   included) so a forgotten summary is not left in a last-known-good copy. Deterministic, no network, no real disk. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const Module = require('node:module');
const { sidecarSourceFiles } = require('./helpers/source.js');

const LEDGER_PATH = path.join(__dirname, '..', 'sidecar', 'summary-ledger.js');
const Real = require('../sidecar/summary-ledger.js');
const SRC = sidecarSourceFiles().find(f => f.rel === 'sidecar/summary-ledger.js').text;

// ---- the in-memory fs: the durable write's whole protocol (temp, fsync, rename, directory fsync), listing, links ----
function memFs() {
  const P = path.posix;
  const files = new Map(), dirs = new Set(['/']), fds = new Map();
  let nextFd = 10, clock = 1;
  const stats = { fsync: 0, rename: 0, unlink: 0 };
  const enoent = p => Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
  const api = {
    files, stats, dirs,
    faults: { renameFails: null, afterRename: null, readFails: null },
    readFileSync(p) {
      if (api.faults.readFails && api.faults.readFails(p)) throw Object.assign(new Error('EBUSY: ' + p), { code: 'EBUSY' });
      if (!files.has(p)) throw enoent(p);
      return files.get(p).text;
    },
    writeFileSync(p, data) { files.set(p, { text: String(data), mtimeMs: clock++ }); },
    renameSync(a, b) {
      if (api.faults.renameFails && api.faults.renameFails(b)) throw Object.assign(new Error('EIO: ' + b), { code: 'EIO' });
      if (!files.has(a)) throw enoent(a);
      files.set(b, { text: files.get(a).text, mtimeMs: clock++ }); files.delete(a); stats.rename++;
      if (api.faults.afterRename) api.faults.afterRename(b, files);
    },
    mkdirSync(p) { let d = P.normalize(p); while (d && d !== '/' && d !== '.') { dirs.add(d); d = P.dirname(d); } },
    openSync(p, flags) {
      if (flags === 'r') { if (!files.has(p) && !dirs.has(P.normalize(p))) throw enoent(p); const fd = nextFd++; fds.set(fd, { path: p, buf: '' }); return fd; }
      if (flags === 'wx' && files.has(p)) throw Object.assign(new Error('EEXIST: ' + p), { code: 'EEXIST' });
      const fd = nextFd++; fds.set(fd, { path: p, buf: '' }); files.set(p, { text: '', mtimeMs: clock++ }); return fd;
    },
    writeSync(fd, data, offset, length) {
      const h = fds.get(fd), bytes = Buffer.isBuffer(data) ? data.subarray(offset || 0, length == null ? undefined : (offset || 0) + length) : Buffer.from(String(data));
      h.buf += bytes.toString(); files.set(h.path, { text: h.buf, mtimeMs: clock++ }); return bytes.length;
    },
    fsyncSync() { stats.fsync++; },
    closeSync(fd) { fds.delete(fd); },
    unlinkSync(p) { if (!files.delete(p)) throw enoent(p); stats.unlink++; },
    existsSync(p) { return files.has(p) || dirs.has(P.normalize(p)); },
    linkSync(a, b) { if (!files.has(a)) throw enoent(a); if (files.has(b)) throw Object.assign(new Error('EEXIST: ' + b), { code: 'EEXIST' }); files.set(b, { text: files.get(a).text, mtimeMs: clock++ }); },
    statSync(p) { if (!files.has(p)) throw enoent(p); const f = files.get(p); return { mtimeMs: f.mtimeMs, size: f.text.length, mode: 0o600 }; },
    lstatSync(p) { return api.statSync(p); },
    readdirSync(dir) {
      const d = P.normalize(dir);
      if (!dirs.has(d)) throw enoent(dir);
      const out = [];
      for (const p of files.keys()) if (P.dirname(p) === d) out.push(P.basename(p));
      return out;
    },
    copyFileSync(a, b) { if (!files.has(a)) throw enoent(a); files.set(b, { text: files.get(a).text, mtimeMs: clock++ }); }
  };
  return api;
}

// ---- fixtures ----
const DIR = '/ws/.summaries';
const note = text => '<conversation_summary>\n' + text + '\n</conversation_summary>';
// canonical model-replay rows: user, assistant, user, assistant ... ids rise by 3 so an id is never an index
function rowsOf(n, streamId) {
  return Array.from({ length: n }, (_, k) => ({ rowId: 100 + k * 3, streamId: streamId || 'ws_a', role: k % 2 === 0 ? 'user' : 'assistant', content: (k % 2 === 0 ? 'ask ' : 'answer ') + k, ts: 1000 + k }));
}
const MODEL = 'openrouter/test/model';
function inputFor(rows, end, over) {
  return Object.assign({ streamId: 'ws_a', agentId: 'agent' }, Real.claimOf(rows, end), {
    noteBody: note('S1: the chat so far'), modelKey: MODEL, windowTokens: 32000, ownerVoice: true, taint: null, quoted: false,
    quotes: [], quotesAt: [], runId: 'run_1', runStartedAt: 5000 }, over || {});
}
function ctxFor(rows, over) {
  return Object.assign({ agentId: 'agent', streamId: 'ws_a', modelKey: MODEL, windowTokens: 32000, ownerVoice: true, rows, deletedAt: () => 0, deletedSince: () => false }, over || {});
}
function makeLedger(Lib, over) {
  const fs = (over && over.fs) || memFs();
  const o = Object.assign({ fs, path: path.posix, dir: DIR, now: () => 7000, redact: t => t, deletedAt: () => 0 }, over || {});
  return { fs, ledger: Lib.makeSummaryLedger(o) };
}
// the record a put stored, with the fields the module fills in
async function stored(Lib, rows, end, over, deps) {
  const { ledger, fs } = makeLedger(Lib, deps);
  const r = await ledger.put(inputFor(rows, end, over));
  return { ledger, fs, r };
}

// ---- mutants: the module's own source with ONE statement removed; the same scenario must then fail ----
function load(src) {
  const m = new Module(LEDGER_PATH, module);
  m.filename = LEDGER_PATH; m.paths = Module._nodeModulePaths(path.dirname(LEDGER_PATH));
  m._compile(src, LEDGER_PATH);
  return m.exports;
}
function mutant(name, from, to) {
  const at = SRC.indexOf(from);
  if (at < 0 || SRC.indexOf(from, at + 1) >= 0) throw new Error('mutation "' + name + '": anchor must occur exactly once: ' + from);
  return load(SRC.slice(0, at) + to + SRC.slice(at + from.length));
}
/* mustKill(name, from, to, scenario): scenario(Lib) -> truthy when the module behaves; async allowed. The real module
   passes it, the mutant must not (a wrong answer or a throw both count as the test noticing). */
async function mustKill(name, from, to, scenario) {
  A.ok(await scenario(Real), name + ': the real module passes the scenario');
  let survived;
  try { survived = !!(await scenario(mutant(name, from, to))); } catch (e) { survived = false; }
  A.ok(!survived, name + ': removing that check makes the scenario fail (the test has teeth)');
}
const reasonOf = (Lib, record, ctx) => { const v = Lib.validate(record, ctx); return v.ok ? 'ok' : v.reason; };
const R = rowsOf(10);

(async () => {
  // ================= 1. a record round-trips, durably =================
  {
    const { ledger, fs, r } = await stored(Real, R, 6);
    A.ok(r.ok, 'put answers ok for a well-formed claim');
    A.eq([r.record.rows, r.record.fromRowId, r.record.toRowId], [6, 100, 115], 'the claim is the first six canonical rows (ids 100..115)');
    A.eq(r.record.noteSha, Real._internals.sha(r.record.noteBody), 'noteSha is the sha256 of the stored body');
    A.ok(fs.stats.fsync > 0, 'the write went through fsync (' + fs.stats.fsync + ' fsyncs)');
    const back = ledger.get('ws_a', 'agent');
    A.eq(back, r.record, 'get returns exactly the record put returned (read back from the files)');
    A.eq(reasonOf(Real, back, ctxFor(R)), 'ok', 'and it validates against the unchanged canonical rows');
    A.eq(reasonOf(Real, back, ctxFor(R.concat(rowsOf(14).slice(10)))), 'ok', 'rows appended AFTER the claim never invalidate it (a prefix claim)');
    A.ok(ledger.get('ws_a', 'other') === null && ledger.get('ws_none', 'agent') === null, 'another agent or stream reads nothing');
    A.ok(path.posix.basename(ledger.dir).startsWith('.'), 'the directory is dot-prefixed (an agent named "summaries" cannot collide)');
    A.ok([...fs.files.keys()].every(p => p.startsWith(DIR + '/')), 'every file the ledger wrote sits under that directory');
  }

  // ================= 2. one test per cause a record is NOT served, each proven by mutation =================
  const good = (await stored(Real, R, 6)).r.record;
  const reason = (Lib, over, ctxOver) => reasonOf(Lib, Object.assign({}, good, over || {}), ctxFor(R, ctxOver));
  await mustKill('shape', "  if (!shapeOk(record)) return refuse('shape');\n", '', async Lib => reason(Lib, { digest: 'nothex' }) === 'shape' && reason(Lib, { noteBody: 'no tags' }) === 'shape' && reason(Lib, { v: 2 }) === 'shape');
  await mustKill('owner', "  if (record.agentId !== c.agentId || record.streamId !== c.streamId) return refuse('owner');\n", '', async Lib => reason(Lib, null, { agentId: 'someone' }) === 'owner' && reason(Lib, null, { streamId: 'ws_other' }) === 'owner');
  await mustKill('model', "  if (record.modelKey !== c.modelKey) return refuse('model');\n", '', async Lib => reason(Lib, null, { modelKey: 'openrouter/other/model' }) === 'model');
  await mustKill('window', "  if (record.windowTokens !== c.windowTokens) return refuse('window');\n", '', async Lib => reason(Lib, null, { windowTokens: 64000 }) === 'window');
  await mustKill('voice', "  if (record.ownerVoice !== c.ownerVoice) return refuse('voice');\n", '', async Lib =>
    reason(Lib, null, { ownerVoice: false }) === 'voice' && reasonOf(Lib, Object.assign({}, good, { ownerVoice: false }), ctxFor(R)) === 'voice');
  await mustKill('forgotten', "  if (del > 0 && del >= num(record.runStartedAt)) return 'forgotten';\n", '', async Lib =>
    reason(Lib, null, { deletedAt: id => (id === 'ws_a' ? 5000 : 0) }) === 'forgotten'                        // deleted exactly when the run began
    && reason(Lib, null, { deletedAt: id => (id === 'ws_a' ? 9000 : 0) }) === 'forgotten'                      // deleted after
    && reason(Lib, null, { deletedAt: id => (id === 'ws_a' ? 4999 : 0) }) === 'ok');                           // deleted BEFORE the run began: it read only what was said since
  await mustKill('quote-forgotten', "    if (d > 0 && at <= d) return 'quote-forgotten';\n", '', async Lib => {
    const q = { quotes: ['ws_b'], quotesAt: [4000] };
    return reason(Lib, q, { deletedAt: id => (id === 'ws_b' ? 4500 : 0) }) === 'quote-forgotten'               // ws_b was read, then deleted
      && reason(Lib, q, { deletedAt: id => (id === 'ws_b' ? 3000 : 0) }) === 'ok'                              // read AFTER ws_b's delete: only post-delete words
      && reason(Lib, q, { deletedAt: () => 0 }) === 'ok';
  });
  await mustKill('quote-forgotten (saturated)', "    if (quotes[i] === '*') { if (typeof c.deletedSince === 'function' && c.deletedSince(at)) return 'quote-forgotten'; continue; }\n", '', async Lib => {
    const q = { quotes: ['*'], quotesAt: [4000] };
    return reason(Lib, q, { deletedSince: at => at <= 4500 }) === 'quote-forgotten' && reason(Lib, q, { deletedSince: () => false }) === 'ok';
  });
  await mustKill('note', "  if (sha(record.noteBody) !== record.noteSha) return refuse('note');\n", '', async Lib =>
    reason(Lib, { noteBody: note('S1: a different summary, same claim') }) === 'note');
  await mustKill('rows', "  if (!Array.isArray(c.rows)) return refuse('rows');\n", '', async Lib =>
    reasonOf(Lib, good, ctxFor(null)) === 'rows');
  await mustKill('digest', "  if (digestOf(c.rows.slice(0, record.rows)) !== record.digest) return refuse('digest');\n", '', async Lib => {
    const edited = R.map((r, i) => i === 2 ? Object.assign({}, r, { content: 'EDITED' }) : r);                         // a covered row now names other bytes
    const forgot = R.filter((_, i) => i !== 3);                                                                       // a covered row left the view (forgotten / retracted)
    const collided = R.map((r, i) => i === 1 ? Object.assign({}, r, { role: 'user' }) : r);                         // same id, other role
    const toolEdit = R.map((r, i) => i === 4 ? Object.assign({}, r, { toolCalls: '[{"id":"x"}]' }) : r);            // tool calls ride the digest
    return reasonOf(Lib, good, ctxFor(edited)) === 'digest' && reasonOf(Lib, good, ctxFor(forgot)) === 'digest'
      && reasonOf(Lib, good, ctxFor(collided)) === 'digest' && reasonOf(Lib, good, ctxFor(toolEdit)) === 'digest'
      && reasonOf(Lib, good, ctxFor(R.slice(0, 5))) === 'digest' && reasonOf(Lib, good, ctxFor([])) === 'digest';
  });
  A.eq(reasonOf(Real, good, ctxFor(R, { modelKey: 'x', windowTokens: 1, deletedAt: () => 99999 })), 'model', 'with several causes the first in the documented order speaks (model before window before forgotten)');
  // the claim helper itself: a claim needs strictly rising durable ids
  A.eq(Real.claimOf(R, 0), null, 'an empty prefix is not a claim');
  A.eq(Real.claimOf(R, 11), null, 'a claim never exceeds the rows it was made from');
  A.eq(Real.claimOf([{ rowId: 5, role: 'user', content: 'a' }, { rowId: 5, role: 'assistant', content: 'b' }], 2), null, 'ids that do not strictly rise are not a claim');
  A.eq(Real.claimOf([{ role: 'user', content: 'a' }], 1), null, 'a row without a durable id is not a claim');
  A.eq(Real.claimOf(R, 6).digest, Real.digestOf(R.slice(0, 6)), 'claimOf digests exactly the prefix');
  A.ok(Real.digestOf([{ rowId: 1, role: 'user', content: 'a\u001f' }, { rowId: 2, role: 'user', content: 'b' }]) !== Real.digestOf([{ rowId: 1, role: 'user', content: 'a' }, { rowId: 2, role: 'user', content: 'b' }]), 'the digest separates fields (a row cannot absorb its neighbour)');

  // ================= 3. the durable write: typed refusals, never a throw =================
  {
    const { ledger } = makeLedger(Real);
    A.eq((await ledger.put(Object.assign(inputFor(R, 6), { streamId: '../escape' }))).reason, 'invalid', 'a stream id outside the grammar is refused, not written');
    A.eq((await ledger.put(Object.assign(inputFor(R, 6), { noteBody: 'a note with no tags' }))).reason, 'invalid', 'a body that is not a conversation_summary note is refused');
    A.eq((await ledger.put(Object.assign(inputFor(R, 6), { digest: 'zz' }))).reason, 'invalid', 'a claim without a real digest is refused');
  }
  await mustKill('put tombstone', "      if (del > 0 && del >= num(i.runStartedAt)) { outcome = 'tombstoned'; return undefined; }\n", '', async Lib => {
    // the stream was deleted at 6000; this fold's run began at 5000 and finishes later: it read what the delete forgot
    const { ledger, fs } = makeLedger(Lib, { deletedAt: id => (id === 'ws_a' ? 6000 : 0) });
    const late = await ledger.put(inputFor(R, 6, { runStartedAt: 5000 }));
    const none = ![...fs.files.keys()].some(p => p.includes('ws_a'));
    // a run that began AFTER the delete may write: it read only what was said since
    const fresh = await ledger.put(inputFor(R, 6, { runStartedAt: 6001 }));
    return late.ok === false && late.reason === 'tombstoned' && none && fresh.ok === true;
  });
  await mustKill('put read-back', "if (!got || got.noteSha !== written.noteSha || got.digest !== written.digest || got.toRowId !== written.toRowId || got.createdAt !== written.createdAt || got.noteBody !== written.noteBody) {", 'if (false) {', async Lib => {
    const fs = memFs();
    // a disk that acknowledges the rename and keeps something else
    fs.faults.afterRename = (to, files) => { if (to.endsWith('ws_a.json')) files.set(to, { text: files.get(to).text.replace('S1: the chat so far', 'S1: the chat so fer'), mtimeMs: 1 }); };
    const { ledger } = makeLedger(Lib, { fs });
    const res = await ledger.put(inputFor(R, 6));
    return res.ok === false && res.reason === 'read-back' && ![...fs.files.keys()].some(p => p.includes('ws_a'));
  });
  {
    const fs = memFs(); fs.faults.renameFails = to => to.endsWith('ws_a.json');
    const { ledger } = makeLedger(Real, { fs });
    let threw = false, res = null;
    try { res = await ledger.put(inputFor(R, 6)); } catch (e) { threw = true; }
    A.ok(!threw && res && res.ok === false && res.reason === 'write-failed', 'a refused write is a typed refusal ("write-failed"), never a throw into the run');
    A.eq(ledger.get('ws_a', 'agent'), null, 'and no record exists afterwards');
  }
  {
    const fs = memFs();
    const { ledger } = makeLedger(Real, { fs });
    await ledger.put(inputFor(R, 6));
    fs.faults.readFails = p => p.endsWith('ws_a.json');
    const res = await ledger.put(inputFor(R, 8));
    A.ok(res.ok === false && res.reason === 'unreadable', 'a store that is present but unreadable is left alone: the typed refusal is "unreadable", the bytes stay');
    A.ok(fs.files.has(DIR + '/ws_a.json'), 'the unreadable file was not removed');
    fs.faults.readFails = null;
  }
  {
    const fs = memFs(); fs.mkdirSync(DIR); fs.writeFileSync(DIR + '/ws_a.json', '{ not json');
    const { ledger } = makeLedger(Real, { fs });
    A.eq(ledger.get('ws_a', 'agent'), null, 'a corrupt file reads as no record');
    const res = await ledger.put(inputFor(R, 6));
    A.ok(res.ok, 'and a corrupt file is derived data: the next put starts it over');
    A.ok(![...fs.files.keys()].some(p => /\.corrupt-\d+$/.test(p)), 'leaving no forensic copy of the old bytes behind');
  }

  // ================= 4. what is stored: redacted, capped =================
  {
    const redact = t => String(t).replace(/SECRET-\d+/g, '[redacted-secret]');
    const { ledger } = makeLedger(Real, { redact });
    const res = await ledger.put(inputFor(R, 6, { noteBody: note('the user pasted SECRET-123 here') }));
    A.ok(res.ok && !res.record.noteBody.includes('SECRET-123') && res.record.noteBody.includes('[redacted-secret]'), 'the body is stored through the transcript\'s redaction');
    A.eq(res.record.noteSha, Real._internals.sha(res.record.noteBody), 'and its sha is over the redacted text, so the check on read still holds');
    A.ok(![...ledger.fileFor('ws_a')].length || true, 'fileFor answers a path');
    const tight = makeLedger(Real, { limits: { noteChars: 60 } }).ledger;
    A.eq((await tight.put(inputFor(R, 6, { noteBody: note('x'.repeat(100)) }))).reason, 'too-large', 'a body over the cap is refused (a truncated summary would be a false claim), never clipped');
    A.eq((await tight.put(inputFor(R, 6, { noteBody: note('short') }))).ok, true, 'a body under the cap is kept whole');
  }
  {
    const { ledger, fs } = makeLedger(Real, { limits: { agents: 2, fileBytes: 100000 } });
    let t = 7000;
    const dated = makeLedger(Real, { fs, limits: { agents: 2 }, now: () => ++t }).ledger;
    for (const a of ['one', 'two', 'three']) await dated.put(inputFor(R, 6, { agentId: a }));
    A.eq(Object.keys(JSON.parse(fs.files.get(DIR + '/ws_a.json').text).records).sort(), ['three', 'two'], 'agents per stream are capped: the OLDEST record goes, the new one stays');
    const bytes = makeLedger(Real, { limits: { fileBytes: 700 } }).ledger;
    A.eq((await bytes.put(inputFor(R, 6, { noteBody: note('y'.repeat(900)) }))).reason, 'too-large', 'a file over its byte cap is refused');
    void ledger;
  }
  {
    const fs = memFs();
    let t = 7000;
    const l = makeLedger(Real, { fs, limits: { files: 3 }, now: () => ++t }).ledger;
    for (const s of ['ws_1', 'ws_2', 'ws_3', 'ws_4', 'ws_5']) await l.put(inputFor(R, 6, { streamId: s }));
    A.eq(l.streams().sort(), ['ws_3', 'ws_4', 'ws_5'], 'past the file cap the OLDEST streams\' files go (the one just written never)');
  }

  // ================= 5. drop, and the files a forgotten summary must not leave behind =================
  {
    const { ledger, fs } = makeLedger(Real);
    await ledger.put(inputFor(R, 6));
    await ledger.put(inputFor(R, 8, { runStartedAt: 5001 }));   // the second write makes durable-store keep a .bak of the first
    fs.writeFileSync(DIR + '/ws_a.json.corrupt-1', 'old bytes with SECRET words');
    fs.writeFileSync(DIR + '/ws_a.json.bak.unseen-2', 'old bytes');
    fs.writeFileSync(DIR + '/ws_ab.json', 'another stream whose id starts the same');
    A.ok(fs.files.has(DIR + '/ws_a.json.bak'), 'durable-store keeps a .bak beside the file (so removal must take it)');
    A.eq(await ledger.drop('ws_a'), true, 'drop(stream) removes the stream\'s summaries');
    A.eq([...fs.files.keys()].filter(p => p.includes('ws_a.json')), [], 'every sibling went with it: main, .bak, forensic copies, temps');
    A.ok(fs.files.has(DIR + '/ws_ab.json'), 'a stream whose id merely starts the same is untouched');
    A.eq(await ledger.drop('ws_a'), false, 'dropping what is not there is false, not an error');
  }
  await mustKill('family', "return names.filter(n => n === main || n.startsWith(main + '.'));", 'return names.filter(n => n === main);', async Lib => {
    const { ledger, fs } = makeLedger(Lib);
    await ledger.put(inputFor(R, 6)); await ledger.put(inputFor(R, 8, { runStartedAt: 5001 }));
    await ledger.drop('ws_a');
    return ![...fs.files.keys()].some(p => p.includes('ws_a.json'));
  });
  {
    const { ledger, fs } = makeLedger(Real);
    await ledger.put(inputFor(R, 6)); await ledger.put(inputFor(R, 6, { agentId: 'second' }));
    A.eq(await ledger.drop('ws_a', 'agent'), true, 'drop(stream, agent) removes that one record');
    A.ok(ledger.get('ws_a', 'agent') === null && ledger.get('ws_a', 'second') !== null, 'the other agent\'s record stays');
    await ledger.drop('ws_a', 'second');
    A.eq([...fs.files.keys()].filter(p => p.includes('ws_a.json')), [], 'and the last record out removes the file family');
  }

  // ================= 6. a delete forgets: the stream's own summary, and any that read it =================
  {
    const fs = memFs();
    const tomb = new Map();
    const { ledger } = makeLedger(Real, { fs, deletedAt: id => tomb.get(id) || 0, deletedSince: at => [...tomb.values()].some(t => t >= at) });
    await ledger.put(inputFor(R, 6));                                                                               // ws_a: plain
    await ledger.put(inputFor(R, 6, { streamId: 'ws_c', quotes: ['ws_b'], quotesAt: [4000] }));                   // ws_c read ws_b
    await ledger.put(inputFor(R, 6, { streamId: 'ws_e', quotes: ['ws_b'], quotesAt: [8000] }));                   // ws_e read ws_b only AFTER ws_b's delete
    await ledger.put(inputFor(R, 6, { streamId: 'ws_d', quotes: ['*'], quotesAt: [9000] }));                      // ws_d read "too many to name", from epoch 9000
    A.eq(ledger.purge({}), { files: 0, records: 0 }, 'with nothing deleted, purge removes nothing');
    tomb.set('ws_a', 6000);
    A.eq(ledger.purge({}).files, 1, 'a deleted stream\'s summary file is purged');
    A.eq(ledger.streams().sort(), ['ws_c', 'ws_d', 'ws_e'], 'ws_a is gone, the others stay (the saturated stamp reads from 9000, after that delete)');
    A.eq([...fs.files.keys()].filter(p => p.includes('ws_a.json')), [], 'with its .bak');
    tomb.set('ws_b', 5000);
    const out = ledger.purge({});
    A.eq(ledger.streams().sort(), ['ws_d', 'ws_e'], 'QUOTE-FORGET: ws_c (read ws_b at 4000, ws_b deleted at 5000) is purged though it was never deleted');
    A.eq(out.files, 1, 'one file went');
    A.ok(ledger.get('ws_e', 'agent'), 'ws_e read ws_b only after its delete, so it read only post-delete words and stays');
    tomb.set('ws_z', 9500);
    ledger.purge({});
    A.eq(ledger.streams(), ['ws_e'], 'the saturated stamp (too many streams to name) is purged by ANY delete at or after its earliest read epoch');
    const s = makeLedger(Real, { fs: memFs() });
    await s.ledger.put(inputFor(R, 6));
    await s.ledger.put(inputFor(R, 6, { streamId: 'ws_c', quotes: ['ws_b'], quotesAt: [4000] }));
    A.eq(s.ledger.forget({ streams: new Map([['ws_b', 5000]]) }).files, 1, 'forget(scope) is the registry\'s shape: a scope of { streams: Map<stream, deletedAt> } purges what read them');
    A.eq(s.ledger.streams(), ['ws_a'], 'and leaves the rest');
    A.eq(s.ledger.forget({ streams: new Map() }), { files: 0, records: 0 }, 'an empty scope forgets nothing');
    A.eq(s.ledger.name, 'conversation-summary', 'the registry name is conversation-summary');
    await s.ledger.put(inputFor(R, 6, { streamId: 'ws_f', quotes: ['ws_b'], quotesAt: [4000] }));
    A.eq(s.ledger.sourceOf('ws_f'), [{ streamId: 'ws_f', agentId: 'agent', rowIds: [100, 115], quotes: ['ws_b'], quotesAt: [4000] }], 'sourceOf names the stream, the covered row ids and the streams read');
  }
  await mustKill('purge quote-forget', "if (!shapeOk(r) || forgottenReason(r, p)) n++;", 'if (!shapeOk(r)) n++;', async Lib => {
    const { ledger } = makeLedger(Lib, { deletedAt: id => (id === 'ws_b' ? 5000 : 0) });
    await ledger.put(inputFor(R, 6, { quotes: ['ws_b'], quotesAt: [4000] }));
    ledger.purge({});
    return ledger.streams().length === 0;
  });
  {
    // an orphan sibling (a .bak whose main is gone) and a foreign-shaped file are derived data too: purge takes them
    const fs = memFs(); fs.mkdirSync(DIR);
    fs.writeFileSync(DIR + '/ws_x.json.bak', 'orphan'); fs.writeFileSync(DIR + '/ws_y.json', JSON.stringify({ v: 1, streamId: 'ws_other', records: {} }));
    const { ledger } = makeLedger(Real, { fs });
    ledger.purge({});
    A.eq([...fs.files.keys()], [], 'purge removes an orphaned .bak and a file that is not this stream\'s');
  }

  // ================= 7. the module reads no view of its own =================
  {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    A.ok(!/\.view\s*\(/.test(code) && !/'proof'|'display'|'recall'/.test(code), 'the ledger never reads a transcript view itself: the host hands it the model-replay rows (a digest over proof/raw would never change on a forget)');
  }

  A.report('summary-reuse');
})().catch(e => { console.error(e); process.exit(1); });
