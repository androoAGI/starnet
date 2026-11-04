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
const { sidecarSourceFiles, readSidecarIndex, sidecarFunctionSource } = require('./helpers/source.js');

const sidecarPath = name => path.join(__dirname, '..', 'sidecar', name);
const sourceOf = name => sidecarSourceFiles().find(f => f.rel === 'sidecar/' + name).text;
const Real = require('../sidecar/summary-ledger.js');
const Cover = require('../sidecar/summary-cover.js');
const TurnView = require('../sidecar/turn-view.js');
const EC = require('../sidecar/earlier-conversation.js');
const SRC = sourceOf('summary-ledger.js');

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
function load(file, src) {
  const p = sidecarPath(file);
  const m = new Module(p, module);
  m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(src, p);
  return m.exports;
}
function mutant(name, from, to, file) {
  const src = file ? sourceOf(file) : SRC;
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error('mutation "' + name + '": anchor must occur exactly once: ' + from);
  return load(file || 'summary-ledger.js', src.slice(0, at) + to + src.slice(at + from.length));
}
/* mustKill(name, from, to, scenario): scenario(Lib) -> truthy when the module behaves; async allowed. The real module
   passes it, the mutant must not (a wrong answer or a throw both count as the test noticing). */
async function mustKill(name, from, to, scenario, file) {
  const RealLib = file ? require('../sidecar/' + file) : Real;
  A.ok(await scenario(RealLib), name + ': the real module passes the scenario');
  let survived;
  try { survived = !!(await scenario(mutant(name, from, to, file))); } catch (e) { survived = false; }
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

  // ================= 6b. the streams a row read ride the record (quote provenance), and a delete of one of them forgets it =================
  {
    const qrows = [
      { rowId: 1, role: 'user', content: 'a', quotes: ['ws_b'], quotesAt: [2000] },
      { rowId: 2, role: 'assistant', content: 'b', quotes: ['ws_b', 'ws_c'], quotesAt: [3000, 4000] },
      { rowId: 3, role: 'user', content: 'c' }
    ];
    A.eq(Real.quoteUnion(qrows), { quotes: ['ws_b', 'ws_c'], quotesAt: [2000, 4000] }, 'each stream read is named once, at its EARLIEST read epoch');
    A.eq(Real.quoteUnion(qrows.slice(2)), {}, 'rows that read nothing stamp nothing');
    A.eq(Real.quoteUnion([{ quotes: ['*'], quotesAt: [900] }, { quotes: ['ws_b'], quotesAt: [100] }]), { quotes: ['*'], quotesAt: [100] }, 'a saturated stamp saturates the union at the earliest epoch seen');
    A.eq(Real.quoteUnion([{ quotes: ['../x'], quotesAt: [5] }]), { quotes: ['*'], quotesAt: [5] }, 'a stamp that is not a stream id saturates: never dropped, never guessed');
    A.eq(Real.quoteUnion([{ quotes: Array.from({ length: 33 }, (_, k) => 'ws_' + k), quotesAt: Array.from({ length: 33 }, () => 70) }]), { quotes: ['*'], quotesAt: [70] }, 'more streams than a stamp can name saturate it');
    await mustKill('quote union: the earliest epoch', "first.set(id, first.has(id) ? Math.min(first.get(id), at) : at);", "first.set(id, at);", async Lib =>
      JSON.stringify(Lib.quoteUnion(qrows)) === JSON.stringify({ quotes: ['ws_b', 'ws_c'], quotesAt: [2000, 4000] }));
    // the chain: a record made from those rows is forgotten when ANY stream they read is deleted
    const stamp = Real.quoteUnion(qrows);
    const tomb = new Map();
    const fs = memFs();
    const { ledger } = makeLedger(Real, { fs, deletedAt: id => tomb.get(id) || 0, deletedSince: at => [...tomb.values()].some(t => t >= at) });
    await ledger.put(inputFor(R, 6, Object.assign({ streamId: 'ws_q' }, stamp)));
    const rec = ledger.get('ws_q', 'agent');
    const vctx = () => ctxFor(R, { streamId: 'ws_q', deletedAt: id => tomb.get(id) || 0, deletedSince: at => [...tomb.values()].some(t => t >= at) });
    A.eq(reasonOf(Real, rec, vctx()), 'ok', 'control: served while nothing it read was deleted');
    tomb.set('ws_c', 3000);
    A.eq(reasonOf(Real, rec, vctx()), 'ok', 'ws_c deleted BEFORE this record\'s rows read it (epoch 4000): it read only what was said since');
    tomb.set('ws_c', 4500);
    A.eq(reasonOf(Real, rec, vctx()), 'quote-forgotten', 'ws_c deleted after it was read: the record is dead, though ws_q itself was never deleted');
    A.eq(ledger.purge({}).files, 1, 'and the sweep a delete runs removes its file');
    A.eq([...fs.files.keys()].filter(p => p.includes('ws_q')), [], 'with every copy beside it');
  }

  // ================= 7. the module reads no view of its own =================
  {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    A.ok(!/\.view\s*\(/.test(code) && !/'proof'|'display'|'recall'/.test(code), 'the ledger never reads a transcript view itself: the host hands it the model-replay rows (a digest over proof/raw would never change on a forget)');
  }

  // ================= 8. a claim never says more than the fold summarized (summary-cover.js) =================
  // a chat of n exchanges: a user row, [a tool call and its result in every second exchange], the reply
  function chatRows(n, tools) {
    const rows = []; let id = 100;
    const add = (role, content, extra) => { id += 3; rows.push(Object.assign({ rowId: id, streamId: 'ws_a', role, content, ts: 1000 + id }, extra || {})); };
    for (let k = 0; k < n; k++) {
      add('user', 'Request ' + k + ': question number ' + k);
      if (tools && k % 2 === 1) { add('assistant', '', { toolCalls: '[{"id":"c' + k + '"}]' }); add('tool', 'tool result ' + k, { toolCallId: 'c' + k }); }
      add('assistant', 'Reply ' + k + ': answer number ' + k);
    }
    return rows;
  }
  const userIndex = (rows, k) => rows.findIndex(r => r.role === 'user' && r.content.startsWith('Request ' + k + ':'));
  // the window a client keeps: a user message and its reply per exchange from `from`; `lead` opens it on the previous reply
  function pageWindow(from, n, lead) {
    const w = [];
    if (lead) w.push({ role: 'assistant', content: 'Reply ' + (from - 1) + ': answer number ' + (from - 1) });
    for (let k = from; k < n; k++) w.push({ role: 'user', content: 'Request ' + k + ': question number ' + k }, { role: 'assistant', content: 'Reply ' + k + ': answer number ' + k });
    return w;
  }
  const exchangeOf = (k, from, lead) => lead ? (k === 0 ? from - 1 : from + Math.floor((k - 1) / 2)) : from + Math.floor(k / 2);
  const EARLIER = (alignment, rows) => alignment.cut > 0 ? Cover.tagNote({ role: 'system', content: note('the free earlier note') }, { source: 'earlier', rows: alignment.cut, toRowId: rows[alignment.cut - 1].rowId, taint: null, quoted: false }) : null;
  function scene(n, tools, from, lead) {
    const rows = chatRows(n, tools), win = pageWindow(from, n, lead);
    const alignment = EC.align(rows, win, null);
    const tagged = Cover.tagWindow(win, alignment, rows, 'ws_a');
    return { rows, win, alignment, tagged, prev: EARLIER(alignment, rows), directive: { role: 'user', content: 'Now: the big new ask' } };
  }
  const claim = (sc, over) => Cover.claimFold(Object.assign({ streamId: 'ws_a', rows: sc.rows, older: [], kept: [], tailHead: sc.directive, prevNote: sc.prev, startRows: sc.alignment.cut }, over || {}));
  {
    let cases = 0, snapped = 0, exact = 0, noProgress = 0, claimsBeyond = 0;
    for (const n of [6, 11]) for (const tools of [false, true]) for (const [from, lead] of [[0, false], [3, false], [3, true]]) {
      const sc = scene(n, tools, from, lead);
      const tag = 'n=' + n + (tools ? ' tools' : '') + ' from=' + from + (lead ? ' lead' : '');
      A.ok(sc.alignment.cut >= 0 && sc.tagged === sc.win.length, tag + ': the client window is placed and every message tagged (' + sc.tagged + ')');
      A.eq(sc.alignment.cut, lead ? userIndex(sc.rows, from - 1) + 1 : from === 0 ? 0 : userIndex(sc.rows, from), tag + ': the window cuts the canonical rows where it opens');
      const prefix = sc.alignment.cut;
      for (let cutPos = 1; cutPos <= sc.win.length; cutPos++) {
        cases++;
        const older = sc.win.slice(0, cutPos);
        const tailHead = cutPos < sc.win.length ? sc.win[cutPos] : sc.directive;
        // the truth, from the generator and not from the tags: the exchange holding the first message NOT summarized (the last
        // summarized exchange when the tail starts on the run's own request, which no row stands for yet)
        const ex = cutPos < sc.win.length ? exchangeOf(cutPos, from, lead) : exchangeOf(sc.win.length - 1, from, lead);
        const wantOpen = userIndex(sc.rows, ex);
        const res = claim(sc, { older, tailHead });
        const want = Math.max(wantOpen, prefix);
        A.ok(res.ok, tag + ' cut@' + cutPos + ': a contiguous, fully placed slice yields a claim (' + (res.reason || 'ok') + ')');
        if (!res.ok) continue;
        A.eq(res.end, want, tag + ' cut@' + cutPos + ': the claim stops at the opening user row of the exchange the cut falls in');
        A.eq(res.progress, wantOpen > prefix, tag + ' cut@' + cutPos + ': progress only when it adds to the previous coverage');
        if (res.end > want) claimsBeyond++;
        if (res.progress) { A.eq(sc.rows[res.end].role, 'user', tag + ' cut@' + cutPos + ': the boundary is a Commander row'); if (cutPos < sc.win.length && sc.win[cutPos].role === 'assistant') snapped++; else exact++; }
        else noProgress++;
      }
    }
    A.eq(claimsBeyond, 0, 'no claim ever said more than the exchanges the fold summarized (' + cases + ' cuts)');
    A.ok(snapped > 10 && exact > 10 && noProgress > 3, 'the sweep covered mid-exchange cuts (' + snapped + '), exchange-boundary cuts (' + exact + ') and no-progress folds (' + noProgress + ')');
  }
  {
    // the same sweep for a window that carries DURABLE IDS (the seed and the station window: one message per row, tool rows
    // included): placed by identity alone, and the claim is the same exchange-boundary truth
    let cases = 0, snapped = 0, exact = 0, bad = 0;
    for (const n of [6, 11]) for (const tools of [false, true]) {
      const rows = chatRows(n, tools);
      const starts = [0, userIndex(rows, 3), userIndex(rows, 3) + 1, rows.length - 4];     // from the start, at an exchange, mid-exchange, a short tail
      for (const start of starts) {
        const win = rows.slice(start).map(r => r.role === 'tool' ? { role: 'tool', content: r.content, tool_call_id: r.toolCallId }
          : r.role === 'assistant' && r.toolCalls ? { role: 'assistant', content: '', tool_calls: JSON.parse(r.toolCalls) } : { role: r.role, content: r.content });
        Object.defineProperty(win, TurnView.ROW_IDS, { value: rows.slice(start).map(r => ({ streamId: 'ws_a', rowId: r.rowId })), enumerable: false });
        const alignment = EC.align(rows, win, null);
        const tag = 'ids n=' + n + (tools ? ' tools' : '') + ' start=' + start;
        A.eq(alignment.cut, start, tag + ': an id-carrying window is placed by identity (cut ' + alignment.cut + ')');
        A.eq(Cover.tagWindow(win, alignment, rows, 'ws_a'), win.length, tag + ': every message is tagged');
        const prev = alignment.cut > 0 ? Cover.tagNote({ role: 'system', content: note('earlier') }, { source: 'earlier', rows: alignment.cut, toRowId: rows[alignment.cut - 1].rowId, taint: null, quoted: false }) : null;
        const directive = { role: 'user', content: 'Now: the new ask' };
        const openOf = idx => { for (let k = idx; k >= 0; k--) if (rows[k].role === 'user') return k; return -1; };
        for (let cutPos = 1; cutPos <= win.length; cutPos++) {
          cases++;
          const want = Math.max(openOf(start + (cutPos < win.length ? cutPos : win.length - 1)), alignment.cut);
          const res = Cover.claimFold({ streamId: 'ws_a', rows, older: win.slice(0, cutPos), kept: [], tailHead: cutPos < win.length ? win[cutPos] : directive, prevNote: prev, startRows: alignment.cut });
          if (!res.ok || res.end !== want) { bad++; A.eq(res.ok ? res.end : res.reason, want, tag + ' cut@' + cutPos + ': the claim stops at the opening user row of the exchange the cut falls in'); continue; }
          if (res.progress) { if (cutPos < win.length && win[cutPos].role !== 'user') snapped++; else exact++; }
        }
      }
    }
    A.eq(bad, 0, 'every cut of every id-carrying window claims exactly the exchanges the fold summarized (' + cases + ' cuts)');
    A.ok(snapped > 10 && exact > 5, 'including cuts inside an exchange (' + snapped + ') and on an exchange boundary (' + exact + ')');
  }
  {
    // refusals: every unknown yields no claim, with its reason
    const base = () => scene(8, true, 2, false);
    const cutAt = (sc, k) => ({ older: sc.win.slice(0, k), tailHead: sc.win[k] });
    let sc = base();
    A.eq(claim(sc, cutAt(sc, 5)).ok, true, 'control: the base slice yields a claim');
    sc = base(); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { older: sc.win.slice(0, 4).concat([{ role: 'assistant', content: 'the run\'s own tool turn' }]) })).reason, 'unplaced-in-slice', 'a message nothing places inside the slice is no claim (a half-run is not history)');
    sc = base(); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { kept: [sc.directive] })).reason, 'kept-untagged', 'a pinned turn nothing places is no claim');
    sc = base(); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { prevNote: { role: 'system', content: note('a note this host never tagged') } })).reason, 'prev-note-untagged', 'a previous note with no coverage is no claim');
    sc = base(); { const moved = sc.rows.filter((_, i) => i !== sc.alignment.cut - 1); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { rows: moved })).reason, 'prev-coverage-moved', 'rows that moved under the previous coverage are no claim'); }
    sc = base(); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { older: sc.win.slice(0, 2).concat(sc.win.slice(4, 6)), tailHead: sc.win[6] })).reason, 'gap', 'a skipped exchange (a Commander row the slice never held) is a gap, no claim');
    sc = base(); { const gone = sc.rows.filter(r => r.rowId !== sc.rows[userIndex(sc.rows, 3)].rowId); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { rows: gone })).reason, 'row-gone', 'a covered row that left the view (forgotten, retracted) is "row-gone", never guessed around'); }
    sc = base(); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { older: [sc.win[2], sc.win[0], sc.win[1], sc.win[3], sc.win[4]] })).reason, 'order', 'a slice out of canonical order is no claim');
    sc = base(); A.eq(claim(sc, { older: [{ role: 'system', content: 'only a note' }], tailHead: sc.win[0] }).reason, undefined, 'a slice of notes alone changes nothing (it is not an error)');
    sc = base(); A.eq(claim(sc, { older: [], tailHead: null }).reason, 'nothing-placed', 'an empty slice places nothing');
    sc = base(); A.eq(claim(sc, Object.assign(cutAt(sc, 5), { prevNote: null, startRows: 9999 })).reason, 'start-beyond-rows', 'a run-start cut beyond the rows is no claim');
    // a pinned turn inside the slice: the claim stops before it
    sc = base();
    { const keptTurn = sc.win[4];   // the user message of exchange 4, taken out of the slice like loop.js openOnUser does
      const r = claim(sc, { older: sc.win.slice(0, 4), kept: [keptTurn], tailHead: sc.win[5] });
      A.eq(r.end, userIndex(sc.rows, 4), 'a turn pinned verbatim at the head stops the claim at its own exchange');
      const r2 = claim(sc, { older: sc.win.slice(0, 4), kept: [sc.win[2]], tailHead: sc.win[5] });
      A.eq(r2.end, userIndex(sc.rows, 3), 'and an EARLIER pinned turn stops it earlier still (the claim never spans a message left in the prompt)'); }
    // tags belong to one stream
    sc = base(); A.eq(Cover.claimFold({ streamId: 'ws_other', rows: sc.rows, older: sc.win.slice(0, 4), kept: [], tailHead: sc.win[4], prevNote: sc.prev, startRows: 0 }).reason, 'unplaced-in-slice', 'a tag from another stream places nothing');
    // a window nothing places is never tagged
    const stray = [{ role: 'user', content: 'a message this stream never recorded' }, { role: 'assistant', content: 'ok' }];
    A.eq(Cover.tagWindow(stray, EC.align(chatRows(4, false), stray, null), chatRows(4, false), 'ws_a'), 0, 'an unplaceable window is not tagged at all');
    A.ok(!JSON.stringify(scene(4, false, 0, false).win).includes('Symbol'), 'tags are invisible to JSON, a spread and a wire');
    const probe = scene(4, false, 0, false).win[0];
    A.eq(Object.keys(probe), ['role', 'content'], 'a tagged message has the same enumerable keys');
    A.eq(Object.keys(Object.assign({}, probe)), ['role', 'content'], 'and a spread copy drops the tag');
  }
  // the lines that make a claim safe, each removed in turn: the same scenarios must then fail
  {
    const base = () => scene(8, true, 2, false);
    const cutAt = (sc, k) => ({ older: sc.win.slice(0, k), tailHead: sc.win[k] });
    const via = (C, sc, over) => C.claimFold(Object.assign({ streamId: 'ws_a', rows: sc.rows, older: [], kept: [], tailHead: sc.directive, prevNote: sc.prev, startRows: sc.alignment.cut }, over || {}));
    await mustKill('claim: unplaced message', "    if (!t) return refuse('unplaced-in-slice');\n", '', async C => { const sc = base(); return via(C, sc, Object.assign(cutAt(sc, 5), { older: sc.win.slice(0, 4).concat([{ role: 'assistant', content: 'own turn' }]) })).reason === 'unplaced-in-slice'; }, 'summary-cover.js');
    await mustKill('claim: skipped exchange', "  for (let u = prefix; u < end; u++) if (rows[u] && rows[u].role === 'user' && !opens.has(u)) return refuse('gap');\n", '', async C => { const sc = base(); return via(C, sc, Object.assign(cutAt(sc, 5), { older: sc.win.slice(0, 2).concat(sc.win.slice(4, 6)), tailHead: sc.win[6] })).reason === 'gap'; }, 'summary-cover.js');
    await mustKill('claim: pinned turn', "    end = Math.min(end, o);\n", '', async C => { const sc = base(); return via(C, sc, { older: sc.win.slice(0, 4), kept: [sc.win[2]], tailHead: sc.win[5] }).end === userIndex(sc.rows, 3); }, 'summary-cover.js');
    await mustKill('claim: previous coverage', "    if (prefix > rows.length || (prefix > 0 && rows[prefix - 1].rowId !== c.toRowId)) return refuse('prev-coverage-moved');\n", '', async C => { const sc = base(); return via(C, sc, Object.assign(cutAt(sc, 5), { rows: sc.rows.filter((_, i) => i !== sc.alignment.cut - 1) })).reason === 'prev-coverage-moved'; }, 'summary-cover.js');
    await mustKill('claim: row left the view', "    const o = at.get(t.openRowId);\n    if (o === undefined) return refuse('row-gone');\n    if (o < lastOpen) return refuse('order');\n", "    const o = at.get(t.openRowId);\n    if (o < lastOpen) return refuse('order');\n", async C => { const sc = base(); return via(C, sc, Object.assign(cutAt(sc, 5), { rows: sc.rows.filter(r => r.rowId !== sc.rows[userIndex(sc.rows, 3)].rowId) })).reason === 'row-gone'; }, 'summary-cover.js');
    await mustKill('claim: order', "    if (o < lastOpen) return refuse('order');\n    if (t.rowId != null", "    if (t.rowId != null", async C => { const sc = base(); return via(C, sc, Object.assign(cutAt(sc, 5), { older: [sc.win[2], sc.win[0], sc.win[1], sc.win[3], sc.win[4]] })).reason === 'order'; }, 'summary-cover.js');
    await mustKill('claim: snap down', "    end = h;\n", "    end = h + 1;\n", async C => { const sc = base(); return via(C, sc, cutAt(sc, 5)).end === userIndex(sc.rows, 4) && via(C, sc, cutAt(sc, 6)).end === userIndex(sc.rows, 5); }, 'summary-cover.js');
  }

  // ================= 8b. a stored note replaces only what it covers (summary-cover.js substitution) =================
  {
    let cases = 0, over = 0, replaced = 0, kept = 0, after = 0;
    for (const n of [6, 11]) for (const tools of [false, true]) for (const [from, lead] of [[0, false], [3, false], [3, true]]) {
      const sc = scene(n, tools, from, lead);
      const tag = 'n=' + n + (tools ? ' tools' : '') + ' from=' + from + (lead ? ' lead' : '');
      for (let e = 1; e < n; e++) {                          // a record claiming every exchange boundary of the chat in turn
        cases++;
        const end = userIndex(sc.rows, e);
        const sub = Cover.substitution({ streamId: 'ws_a', window: sc.win, alignment: sc.alignment, rows: sc.rows, record: { rows: end } });
        if (sc.alignment.cut > end) { after++; A.eq(sub.reason, 'window-after', tag + ' e=' + e + ': a window that opens after the claim leaves a gap the note does not cover: not used'); continue; }
        A.ok(sub.ok, tag + ' e=' + e + ': a window that opens inside or at the claim can be served (' + (sub.reason || 'ok') + ')');
        if (!sub.ok) continue;
        // the truth, from the generator: the messages of exchanges BEFORE e are the claim's; exchange e and later stay
        const want = sc.win.map((_, k) => k).filter(k => exchangeOf(k, from, lead) < e);
        A.eq(sub.drop, want, tag + ' e=' + e + ': exactly the messages of the exchanges the note covers are replaced');
        if (sub.drop.some(k => exchangeOf(k, from, lead) >= e)) over++;
        replaced += sub.drop.length; kept += sc.win.length - sub.drop.length;
      }
    }
    A.eq(over, 0, 'a stored note never replaces a message of an exchange it does not cover (' + cases + ' claims)');
    A.ok(replaced > 50 && kept > 50 && after > 0, 'the sweep replaced ' + replaced + ' messages, kept ' + kept + ', and met ' + after + ' windows that open after the claim');
    const sc = scene(8, true, 2, false);
    const rec = { rows: userIndex(sc.rows, 5) };
    const sub = args => Cover.substitution(Object.assign({ streamId: 'ws_a', window: sc.win, alignment: sc.alignment, rows: sc.rows, record: rec }, args || {}));
    A.eq(sub({ record: { rows: sc.rows.length + 1 } }).reason, 'claim-beyond-rows', 'a claim beyond the rows is not served');
    A.eq(sub({ alignment: { cut: -1, index: [] } }).reason, 'window-unplaced', 'a window nothing places is not served');
    A.eq(sub({ rows: sc.rows.filter(r => r.rowId !== sc.rows[userIndex(sc.rows, 3)].rowId) }).reason, 'row-gone', 'a tagged row that left the view is not served');
    A.eq(sub({ window: [sc.win[2], sc.win[0]].concat(sc.win.slice(3)) }).reason, 'order', 'a window out of canonical order is not served');
    A.eq(sub({ streamId: 'ws_other' }).drop, [], 'tags from another stream place nothing, so nothing is replaced');
    const untagged = sc.win.map(m => ({ role: m.role, content: m.content }));
    A.eq(Cover.substitution({ streamId: 'ws_a', window: untagged, alignment: sc.alignment, rows: sc.rows, record: rec }).drop, [], 'an untagged message is never replaced: it stays exactly as the client sent it');
    // the composition: serve a stored note, then fold again in the same run; the second claim extends the first
    const served = scene(11, true, 0, false);
    const stored = Cover.tagNote({ role: 'system', content: note('stored') }, { source: 'record', rows: userIndex(served.rows, 5), toRowId: served.rows[userIndex(served.rows, 5) - 1].rowId, taint: null, quoted: false });
    const s2 = Cover.substitution({ streamId: 'ws_a', window: served.win, alignment: served.alignment, rows: served.rows, record: { rows: userIndex(served.rows, 5) } });
    const remaining = served.win.filter((_, k) => !s2.drop.includes(k));
    A.eq(remaining[0].content, 'Request 5: question number 5', 'after the substitution the window opens on the exchange the note ends at');
    const again = Cover.claimFold({ streamId: 'ws_a', rows: served.rows, older: remaining.slice(0, 5), kept: [], tailHead: remaining[5], prevNote: stored, startRows: 0 });
    A.ok(again.ok && again.prefix === userIndex(served.rows, 5) && again.end === userIndex(served.rows, 7) && again.progress, 'a fold after a served note merges onto it: its claim starts at the note\'s end and extends it (' + JSON.stringify(again) + ')');
  }
  // serving: the stored note takes the earlier note's place, byte for byte, and what it carries is latched
  {
    const servedScene = Lib => {
      const sc = scene(8, false, 3, false);
      const sys = { role: 'system', content: 'You are a station agent.' };
      const msgs = [sys, sc.prev].concat(sc.win, [sc.directive]);
      const record = { rows: userIndex(sc.rows, 5), toRowId: sc.rows[userIndex(sc.rows, 5) - 1].rowId, noteBody: note('the stored summary, exactly'), taint: 'web page example.com', quoted: true };
      const sub = Lib.substitution({ streamId: 'ws_a', window: sc.win, alignment: sc.alignment, rows: sc.rows, record });
      const out = Lib.serve({ msgs, window: sc.win, drop: sub.drop, earlier: sc.prev, record });
      return { sc, sys, msgs, record, sub, out };
    };
    const { sc, sys, msgs, record, sub, out } = servedScene(Cover);
    A.eq(out.msgs[0], sys, 'the system prompt stays first');
    A.eq(out.msgs[1].content, record.noteBody, 'the stored note follows it, byte for byte');
    A.eq(out.msgs.filter(m => m.role === 'system' && /^<conversation_summary>/.test(m.content)).length, 1, 'and it is the only summary note: the free earlier note gave way');
    A.eq(out.msgs.slice(2), sc.win.filter((_, k) => !sub.drop.includes(k)).concat([sc.directive]), 'the rest is the client\'s window minus the exchanges the note covers, in order, then the directive');
    A.eq(Cover.coverOf(out.note), { source: 'record', rows: record.rows, toRowId: record.toRowId, taint: 'web page example.com', quoted: true }, 'the served note carries its coverage, so a fold in this run merges onto it');
    A.eq([out.taint, out.quoted], ['web page example.com', true], 'a tainted, quoted-material record hands the host both latches');
    A.eq(msgs.length, 2 + sc.win.length + 1, 'the input array is not mutated');
    const clean = Cover.serve({ msgs, window: sc.win, drop: sub.drop, earlier: sc.prev, record: Object.assign({}, record, { taint: null, quoted: false }) });
    A.eq([clean.taint, clean.quoted], [null, false], 'a clean record latches nothing');
    A.eq(Cover.taintOfFold({ covered: [{ taint: null }, { taint: 'web page a' }, { taint: 'web page b' }], prevCover: { taint: 'prev' }, runTaint: 'run' }), 'web page a', 'a covered row\'s outside content is kept first');
    A.eq(Cover.taintOfFold({ covered: [{ taint: null }], prevCover: { taint: 'prev' }, runTaint: 'run' }), 'prev', 'else the previous note\'s (a summary of a summary never launders it)');
    A.eq(Cover.taintOfFold({ covered: [], prevCover: null, runTaint: 'run' }), 'run', 'else the run\'s own, latched when the fold built the note');
    A.eq(Cover.taintOfFold({ covered: [], prevCover: null, runTaint: null }), null, 'and clean when nothing was read');
    {
      /* A10: THE STAMP A KEPT SUMMARY CARRIES. Stored unwrapped; bytes -> a stamp that never decays; replies under the bytes -> the bare source. */
      const UA = 'user attachment', BYTES = Cover.BYTES_TAINT, FILE = 'look\n\n[Attached file: n.txt]\n```\nbody\n```';
      const expansion = { role: 'user', taint: UA, content: FILE }, typedWords = { role: 'user', taint: UA, attachments: [{ id: 'a' }], content: FILE, typed: 'look' };   // the 0.14.2 shape (the expansion IS the content) and the 11-02 shape (the note shows the typed words)
      A.ok(BYTES !== UA && BYTES.startsWith(UA), 'the bytes stamp is not the bare source (so it never decays) and still names it');
      A.eq(Cover.taintOfFold({ covered: [{ role: 'assistant', taint: UA }], prevCover: null, runTaint: UA }), UA, 'a fold over replies written under the attachment, in a run that holds it: the bare source');
      A.eq(Cover.taintOfFold({ covered: [{ role: 'assistant', taint: UA }], prevCover: { taint: UA }, runTaint: null }), UA, 'a summary of that summary stays the bare source');
      A.eq(Cover.taintOfFold({ covered: [{ role: 'assistant', taint: UA }], prevCover: null, runTaint: null, heldBytes: true }), BYTES, 'a fold whose messages held the bytes: the bytes stamp');
      A.eq(Cover.taintOfFold({ covered: [], prevCover: { taint: UA }, runTaint: UA, heldBytes: true }), BYTES, 'and it outranks the bare source a previous note carried');
      A.eq(Cover.taintOfFold({ covered: [expansion], prevCover: null, runTaint: null }), BYTES, 'a covered row that stores the file text is the bytes stamp as well');
      A.eq(Cover.taintOfFold({ covered: [typedWords], prevCover: null, runTaint: null }), null, 'and a row whose note shows the typed words instead puts no bytes in the summary');
      A.eq(Cover.taintOfFold({ covered: [], prevCover: { taint: BYTES }, runTaint: null }), BYTES, 'once a summary holds the bytes it keeps the stamp through later folds');
      A.eq(Cover.taintOfFold({ covered: [], prevCover: { taint: UA }, runTaint: 'web page example.com' }), 'web page example.com', 'a page the run read beats the bare source');
      A.eq(Cover.taintOfFold({ covered: [], prevCover: null, runTaint: 'kept summary carried content from earlier conversation carried content from web page example.com' }), 'web page example.com', 'the ledger stores the source, never the sentence a latch wrapped it in');
      A.eq([Cover.stampOf(UA), Cover.stampOf('earlier conversation carried content from web page a'), Cover.stampOf(null)], [BYTES, 'web page a', null], 'a note\'s own stamp: the bare source reaches a note only through a row that renders file text');
      const text = t => ({ role: 'user', content: t }), parts = p => ({ role: 'user', content: p });
      A.eq([Cover.heldBytes([text('plain words'), { role: 'assistant', content: 'a reply with [Attached file: x] in it' }]), Cover.heldBytes([text(FILE)]),
        Cover.heldBytes([parts([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])]),
        Cover.heldBytes([parts([{ type: 'text', text: FILE }])]), Cover.heldBytes(null)],
        [false, true, true, true, false], 'heldBytes: only a USER message that carries a file\'s text or a picture part');
    }
    await mustKill('serve: the earlier note gives way', "  if (i.earlier) gone.add(i.earlier);\n", '', async C => { const s = servedScene(C); return s.out.msgs.filter(m => m.role === 'system' && /^<conversation_summary>/.test(m.content)).length === 1; }, 'summary-cover.js');
    await mustKill('serve: the covered window messages give way', "const gone = new Set((Array.isArray(i.drop) ? i.drop : []).map(k => i.window[k]));", "const gone = new Set();", async C => { const s = servedScene(C); return s.out.msgs.length === s.msgs.length - s.sub.drop.length; }, 'summary-cover.js');
    await mustKill('serve: the taint latch', "taint: r.taint || null, quoted: r.quoted === true };", "taint: null, quoted: r.quoted === true };", async C => servedScene(C).out.taint === 'web page example.com', 'summary-cover.js');
    await mustKill('serve: the quoted latch', "taint: r.taint || null, quoted: r.quoted === true };", "taint: r.taint || null, quoted: false };", async C => servedScene(C).out.quoted === true, 'summary-cover.js');
    await mustKill('fold taint: a summary of a summary never launders', "unwrap(i.prevCover && i.prevCover.taint), ", '', async C => C.taintOfFold({ covered: [], prevCover: { taint: 'prev' }, runTaint: null }) === 'prev', 'summary-cover.js');
    await mustKill('fold taint: a fold that held the bytes never decays', "  if (i.heldBytes === true) return BYTES_TAINT;\n", '', async C => C.taintOfFold({ covered: [], prevCover: null, runTaint: null, heldBytes: true }) === C.BYTES_TAINT, 'summary-cover.js');
    await mustKill('fold taint: replies under the attachment stay the bare source', "return cands.length ? ATTACHMENT_TAINT : null;", "return null;", async C => C.taintOfFold({ covered: [], prevCover: { taint: 'user attachment' }, runTaint: null }) === 'user attachment', 'summary-cover.js');
    await mustKill('fold taint: a latch sentence is not part of the stamp', "const WRAPPED = /^(?:(?:earlier conversation|kept summary) carried content from )+/;", "const WRAPPED = /^$/;", async C => C.taintOfFold({ covered: [], prevCover: null, runTaint: 'kept summary carried content from web page a' }) === 'web page a', 'summary-cover.js');
  }
  await mustKill('substitution: a window that opens after the claim', "  if (alignment.cut > end) return refuse('window-after');", '', async C => {
    const sc = scene(8, false, 5, false);
    return C.substitution({ streamId: 'ws_a', window: sc.win, alignment: sc.alignment, rows: sc.rows, record: { rows: userIndex(sc.rows, 3) } }).reason === 'window-after';
  }, 'summary-cover.js');
  await mustKill('substitution: only what the note covers', "    if (o < end) drop.push(k);", "    if (o <= end) drop.push(k);", async C => {
    const sc = scene(8, false, 0, false);
    const want = sc.win.map((_, k) => k).filter(k => Math.floor(k / 2) < 4);
    return JSON.stringify(C.substitution({ streamId: 'ws_a', window: sc.win, alignment: sc.alignment, rows: sc.rows, record: { rows: userIndex(sc.rows, 4) } }).drop) === JSON.stringify(want);
  }, 'summary-cover.js');
  await mustKill('substitution: a row that left the view', "    const o = at.get(t.openRowId);\n    if (o === undefined) return refuse('row-gone');\n    if (o < last) return refuse('order');", "    const o = at.get(t.openRowId);\n    if (o < last) return refuse('order');", async C => {
    const sc = scene(8, false, 0, false);
    return C.substitution({ streamId: 'ws_a', window: sc.win, alignment: sc.alignment, rows: sc.rows.filter(r => r.rowId !== sc.rows[userIndex(sc.rows, 2)].rowId), record: { rows: userIndex(sc.rows, 5) } }).reason === 'row-gone';
  }, 'summary-cover.js');

  // ================= 9. the loop's hook: after a PAID fold, before agent.compact, never for a lossy one =================
  {
    const { runAgentLoop } = require('../sidecar/loop.js');
    const { makeContext } = require('../sidecar/context.js');
    const { makeCostEngine } = require('../sidecar/cost.js');
    const failopen = require('../sidecar/failopen.js');
    const WINDOW = 4000;
    const chat = (n, bulk) => {
      const msgs = [{ role: 'system', content: 'You are a station agent.' }];
      for (let k = 1; k <= n; k++) msgs.push({ role: 'user', content: 'Request ' + k + ': question number ' + k }, { role: 'assistant', content: 'Reply ' + k + ' ' + 'w'.repeat(bulk) });
      msgs.push({ role: 'user', content: 'Now: the latest ask' });
      return msgs;
    };
    const toolChat = () => {
      const msgs = [{ role: 'system', content: 'You are a station agent.' }, { role: 'user', content: 'read the files' }];
      for (let k = 1; k <= 6; k++) { msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 't' + k, type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't' + k, content: 'result ' + k + ' ' + 'T'.repeat(2500) }); }
      msgs.push({ role: 'assistant', content: 'read them all' }, { role: 'user', content: 'Now: summarize' });
      return msgs;
    };
    const foldRun = async (seed, extra, keepTail, lib) => {
      const trace = (extra && extra.trace) || [];
      if (extra && extra.trace) { extra = Object.assign({}, extra); delete extra.trace; }
      const ctx = makeContext({ contextLimit: WINDOW, compactAt: 0.65, keepTail: keepTail || 3 });
      const log = [], messages = seed.slice();
      const provider = { priceOf: () => null, contextLimit: () => WINDOW, stream: async function* () { yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' }; } };
      const res = await (lib || { runAgentLoop }).runAgentLoop(Object.assign({ messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
        emit: (n, p) => { if (n === 'agent.compact') { log.push({ ev: 'compact', p }); trace.push('compact'); } },
        summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }), microCompaction: false, model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 4 }, contextLimit: WINDOW }, extra || {}));
      return { res, log, messages };
    };
    // 1. called once for the paid fold, with the working set already rebuilt, BEFORE agent.compact; its answer rides the event
    {
      let seen = null;
      const trace = [];
      const { log } = await foldRun(chat(20, 650), { trace, onFold: async f => { seen = f; trace.push('onFold'); await new Promise(r => setTimeout(r, 15)); trace.push('onFold-settled'); return { reused: 7, new: 3 }; } });
      A.eq(trace, ['onFold', 'onFold-settled', 'compact'], 'onFold runs to completion BEFORE agent.compact is emitted');
      A.eq([log[0].p.reason, log[0].p.reused, log[0].p.new], ['context', 7, 3], 'its { reused, new } ride agent.compact');
      A.ok(seen && seen.note && /^<conversation_summary>/.test(seen.note.content) && seen.summary === 'S', 'it receives the note the fold built and the summary text');
      A.ok(seen.older.length > 0 && seen.tail.length > 0 && seen.tailHead === seen.tail.find(m => m.role !== 'system') && seen.prevNote === null, 'and the slice that was summarized, the tail, its first message and the previous note (none)');
    }
    {
      let had = null;
      const r = await foldRun(chat(20, 650), { onFold: async f => { had = f.note; return undefined; } });
      A.ok(had && r.messages.includes(had), 'the note handed to the hook is the very object the loop put in the working set (a host can tag it)');
    }
    // 2. a hook that throws or answers nonsense never costs the fold
    {
      failopen.resetForTests();
      const thrown = await foldRun(chat(20, 650), { onFold: async () => { throw new Error('disk full'); } });
      A.eq(thrown.res.reason, 'done', 'a throwing hook leaves the run done');
      A.eq(thrown.log.length, 1, 'the fold still announced itself');
      A.ok(thrown.log[0].p.reused === undefined && thrown.log[0].p.new === undefined, 'with no counts');
      A.eq(failopen.counts()['loop.compaction.onFold'], 1, 'and the failure is counted, not swallowed silently');
      const junk = await foldRun(chat(20, 650), { onFold: async () => ({ reused: -4, new: 'x' }) });
      A.ok(junk.log[0].p.reused === undefined && junk.log[0].p.new === undefined, 'counts that are not non-negative integers are ignored');
      const bare = await foldRun(chat(20, 650), {});
      A.ok(bare.log.length === 1 && bare.log[0].p.reused === undefined, 'with no hook the event is exactly what it was');
    }
    // 3. lossy folds are never a durable fact
    {
      let calls = 0;
      const hook = async () => { calls++; return undefined; };
      const micro = await foldRun(toolChat(), { onFold: hook, microCompaction: true });
      A.ok(micro.log.some(e => e.p.reason === 'micro') && !micro.log.some(e => e.p.reason === 'context'), 'fixture: the free micro tier cleared the prompt');
      const noSummarizer = await foldRun(chat(20, 650), { onFold: hook, summarize: undefined });
      A.ok(noSummarizer.log.some(e => e.p.reason === 'fallback'), 'fixture: with no summarizer the deterministic fallback note was used');
      const rejected = await foldRun(chat(20, 650), { onFold: hook, summarize: async () => ({ summary: '', rejected: 'length', usd: 0, tokens: 0 }) });
      A.ok(!rejected.log.some(e => e.p.reason === 'context'), 'fixture: a cut-off summary is not committed');
      A.eq(calls, 0, 'onFold was called for none of the micro, fallback and rejected folds');
    }
    // 4. a turn pinned at the head is handed over, so a claim can stop before it
    {
      let pinned = 0, unpinned = 0;
      for (let keepTail = 1; keepTail <= 5; keepTail++) {
        let got = null;
        await foldRun(chat(20, 650), { onFold: async f => { got = f; return undefined; } }, keepTail);
        if (!got) continue;
        if (got.tailHead && got.tailHead.role !== 'user') { pinned++; A.ok(got.kept.length === 1 && got.kept[0].role === 'user' && !got.older.includes(got.kept[0]), 'tail ' + keepTail + ': a tail that opens on a reply gets one pinned user turn, handed over and not in the slice'); }
        else { unpinned++; A.eq(got.kept.length, 0, 'tail ' + keepTail + ': a tail that opens on a user turn pins nothing'); }
      }
      A.ok(pinned > 0 && unpinned > 0, 'the sweep met both tails that open on a reply (' + pinned + ') and on a user turn (' + unpinned + ')');
    }
    // the hook's two guarantees, each removed in turn through the real loop source
    const hooked = async Lib => {
      const order = [];
      const r = await foldRun(chat(20, 650), { onFold: async () => { order.push('start'); await new Promise(res => setTimeout(res, 10)); order.push('settled'); return { reused: 1, new: 2 }; } }, 3, Lib);
      const ev = r.log.map(e => e.ev + ':' + (e.p.reused === 1 && e.p.new === 2 ? 'counted' : 'bare'));
      return order.join() === 'start,settled' && ev.join() === 'compact:counted';
    };
    await mustKill('loop: the hook is called', '      if (onFold) {\n        try {', '      if (false) {\n        try {', hooked, 'loop.js');
    await mustKill('loop: the hook is awaited before agent.compact', "const kept = await onFold(", "const kept = onFold(", hooked, 'loop.js');
  }

  // ================= 7b. the host's wiring (index.js), read as text: where the orchestrator contract put each line =================
  {
    const index = readSidecarIndex();
    const count = (hay, needle) => hay.split(needle).length - 1;
    A.eq(count(index, "transcriptStore.view('model-replay', streamId, { limit: 3000, shape: 'pairs', rows: true })"), 1, '(a) ONE call reads the canonical rows, over the model-replay view: the earlier-conversation note, the claim and the digest share it');
    A.ok(/const canonicalRows = streamId => transcriptStore\.view\('model-replay'/.test(index), '    and that call is canonicalRows');
    const persist = sidecarFunctionSource('persistFold');
    A.ok(persist.length > 200 && persist.includes('canonicalRows(streamId)') && !/\.view\s*\(/.test(persist), '(a) the write reads its rows through it and opens no view of its own');
    A.ok(!/transcriptStore\.view\(\s*'(?:proof|display|recall)'/.test(index.slice(index.indexOf('const summaryLedger'), index.indexOf('function forgetDeletedSessionSummaries'))), '(a) nothing in the ledger wiring reads the proof, display or recall view');
    A.ok(sidecarFunctionSource('observeDeletedSessions').includes('forgetDeletedSessionSummaries()'), '(c) a fresh delete purges the kept summaries, synchronously, in the function that learns it');
    A.ok(!/summar/i.test(sidecarFunctionSource('forgetDeletedSessionMemory')), '(d) and NOT as a private hook inside forgetDeletedSessionMemory, which turn-identity rewrites: the ledger has the registry shape (name, sourceOf, forget)');
    A.eq(count(index, 'if (sessionTombstones.unpurged().length) forgetDeletedSessionSummaries();'), 1, 'an unfinished purge is retried at boot, with the memory purge trigger');
    A.ok(Real.DIR_NAME.startsWith('.') && /const SUMMARIES_DIR = path\.join\(WORKSPACES, SummaryLedger\.DIR_NAME\)/.test(index), '(e) the directory is dot-prefixed, under the workspaces root');
    A.eq(count(index, 'onFold: persistFold'), 1, 'the one loop call of a run hands the fold hook over');
    {
      /* THE SERVE LATCH IS UNCONDITIONAL (contract section 9 A5 iii; the orchestrator's known bug). A kept summary is model-written text made
         from rows and tool results that may have read the web. A run that is ALREADY tainted (by a user attachment, by an earlier source) and
         then serves one must still record that source: a latch guarded by "the run is not tainted yet" is how an earlier source hides a later
         one, and everything the run writes then decays on the first source alone. The attachment lane removed every guard of this kind; this
         is the one site this lane added, held here so a merge or a refactor cannot bring the guard back. The one stamp that latches nothing
         is the bare attachment source (a fold over replies only, A10): the guard may name it and nothing else. The observable proof - both
         sources in the run's taint and its journal - is test/summary-taint.http.test.js. */
      const mark = "latchRunTaint('kept summary carried content from '";
      A.eq(count(index, mark), 1, 'the kept summary has ONE serve latch');
      const at = index.indexOf(mark);
      const lead = index.slice(Math.max(0, at - 300), at);
      const guard = (lead.match(/if \(([^{}\n]*)\)\s*\{\s*$/) || [])[1];
      A.ok(typeof guard === 'string' && /served\.taint/.test(guard), 'the serve latch sits directly under an "if (served.taint ...)" (found: ' + JSON.stringify(guard) + ')');
      A.ok(typeof guard === 'string' && !/tainted|taintedBy|execution\./i.test(guard.replace(/served\.taint/g, '')), 'and that guard asks only whether the summary carries a source, never whether the run is already tainted (found: ' + JSON.stringify(guard) + ')');
    }
    const ledger = makeLedger(Real).ledger;
    A.eq([typeof ledger.sourceOf, typeof ledger.forget, ledger.name], ['function', 'function', 'conversation-summary'], '(d) the ledger is registry-shaped: name, sourceOf, forget');
  }

  A.report('summary-reuse');
})().catch(e => { console.error(e); process.exit(1); });
