'use strict';
/* node test/history-upgrade-178.test.js — #178 "Conversation history could not be restored" on every session after the
   upgrade to 0.15.0.

   0.15.0 added retract rows (undo) and a proof that a row shown was never undone. A closed transcript segment carries a
   summary of the retracts it holds; a segment closed by 0.14.x has none, and "no summary" is not "no retracts". The proof
   parsed at most eight segments a call and kept what it learned only in memory, so a station with more than eight old
   segments answered GET /api/transcript with a 500 until enough reads went by, and the by-id reads (a saved history read
   back through POST /api/transcript/rows, the cached-row check POST /api/turn-identity/retractions) never learned
   anything and answered 503 for good: the page showed "history could not be restored" and held every send.

   This writes a store the way 0.14.x left it (more than eight closed segments, no retract summaries in the manifest or
   the index files, no rowId lease) and holds, through the REAL store over the REAL segmented io, the REAL route handlers
   sliced out of sidecar/index.js and the REAL page read seam of chat.js (test/helpers/seal-rig.js):
     · the very first GET after the upgrade answers 200 with the conversation, and the summaries it built are persisted;
     · the first by-id read and the first cached-row check answer too, however many segments the rows are spread over;
     · the page loads the conversation on its first read (inline 0.14 rows, rows the page already numbered, a packed
       history) and a send is admitted, never held by the proof;
     · nothing is loosened: a retract row in an old segment still hides its target, and a damaged old segment is still
       never vouched (an honest 503 with its code, not a 500, and a send that ends at once instead of waiting). */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js');

const ROOTS = ['frontend/app', 'website/app/app'];
const SEGMENT = 700;
const temp = path.resolve(os.tmpdir()), base = fs.mkdtempSync(path.join(temp, 'history-upgrade-178-'));
if (path.dirname(base) !== temp) throw new Error('fixture directory escaped its temporary parent');
const sha = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
const reads = [], tracked = Object.create(fs);
tracked.readFileSync = (file, ...args) => { if (/segment-\d+\.jsonl$/.test(String(file))) reads.push(String(file)); return fs.readFileSync(file, ...args); };
const opened = [];
const openIo = dir => { const io = History.makeSegmentedTranscriptIo({ fs: tracked, path, root: dir, segmentBytes: SEGMENT, schedule() {}, onWarning() {} }); opened.push(io); return io; };
let copies = 0;
const copyOf = src => { const dir = path.join(base, 'copy-' + (++copies)); fs.cpSync(src, dir, { recursive: true }); return dir; };

/* THE STORE AS 0.14.x LEFT IT. Three sessions written interleaved, as a station writes them, so the conversation 'talk' is
   spread over every segment. One old segment holds a retract row (a 0.15 station that was downgraded and upgraded again),
   so the proof has a real undo to keep. Then every trace of a retract summary is removed: 0.14.x wrote none. */
function writeOldStore(dir, o) {
  const io = openIo(dir);
  let ts = 1700000000000;
  const put = (stream, role, content, extra) => io.appendDurable(Object.assign({ streamId: stream, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: ++ts, content },
    role === 'assistant' ? { sourceRunId: 'run-' + stream + '-' + ts } : null, extra || null));
  const talk = [];
  let undone = null;
  for (let i = 0; i < 24; i++) {
    talk.push(put('talk', i % 2 ? 'assistant' : 'user', (i % 2 ? 'answer ' : 'question ') + i + ' ' + 'x'.repeat(60)));
    put('cron-nightly', 'assistant', 'routine report ' + i + ' ' + 'y'.repeat(160));
    put('other', 'user', 'another session ' + i + ' ' + 'z'.repeat(160));
    if (i === 6) { undone = talk[3]; put('talk', 'system', '', { kind: 'retract', targets: [undone.rowId], reason: 'undo' }); }
    if (i === 9 && o && o.damage) fs.appendFileSync(io._internals.segFile(io.status().activeSegment), '{"rowId":');   // a crash mid-append; the next row isolates it
  }
  io.close();
  const manifestFile = path.join(dir, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const meta of manifest.segments) {
    delete meta.retracts; delete meta.retractsHash;
    const idxFile = io._internals.idxFile(meta.number);
    if (!fs.existsSync(idxFile)) continue;
    const index = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    delete index.retracts;
    fs.writeFileSync(idxFile, JSON.stringify(index));
    meta.indexHash = sha(index);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  if (!(o && o.keepLease)) fs.rmSync(path.join(dir, History._internals.LEASE_FILE), { force: true });   // 0.14.x kept no rowId lease
  return { talk, undone, closed: manifest.segments.filter(meta => meta.number !== manifest.activeSegment).length, manifestFile };
}

function station(dir) {
  const io = openIo(dir), live = new Set();
  const store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  return { io, store, routes: Rig.routes({ store, live }) };
}
function getTranscript(st, stream) {
  const res = { code: 0, body: null };
  st.routes.serveTranscript({ url: '/api/transcript?agent=agent&stream=' + stream + '&limit=200' }, res);
  return res;
}
async function post(handler, body) { const res = { code: 0, body: null }; await handler({ body: JSON.stringify(body) }, res); return res; }
const record = (id, history) => ({ id, title: 'session ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: [], createdAt: 1800000000000, lastActiveAt: 1800000000000, lastReadAt: 1800000000001 });
const slice = rec => ({ workstreams: [rec], activeId: rec.id, generalId: rec.id });

(async () => {
  try {
    const oldDir = path.join(base, 'old');
    const old = writeOldStore(oldDir);
    const kept = old.talk.filter(row => row.rowId !== old.undone.rowId);
    A.ok(old.closed > 8, 'the 0.14.x store has more closed segments than one proof read used to parse: ' + old.closed);
    const oldSegments = JSON.parse(fs.readFileSync(old.manifestFile, 'utf8')).segments;
    const talkSegments = new Set(old.talk.map(row => oldSegments.find(meta => row.rowId >= meta.minRowId && row.rowId <= meta.maxRowId).number));
    A.ok(talkSegments.size > 8, 'and the conversation is spread over more than eight of them: ' + talkSegments.size);

    // ---- the station: the first read of each kind after the upgrade ------------------------------------------------------------
    {
      const st = station(copyOf(oldDir));
      reads.length = 0;
      const first = getTranscript(st, 'talk');
      A.eq(first.code, 200, 'the FIRST GET /api/transcript after the upgrade answers (it was a 500 until eight-segment reads caught up)');
      const contents = (first.body && first.body.turns || []).map(t => t.content);
      A.ok(kept.every(row => contents.includes(row.content)), 'with the whole conversation (' + contents.length + ' turns)');
      A.ok(!contents.includes(old.undone.content), 'and the turn undone in an old segment stays hidden: the one-time pass never forgets an undo');
      const persisted = JSON.parse(fs.readFileSync(path.join(st.io._internals.root, 'manifest.json'), 'utf8'));
      A.ok(persisted.segments.filter(meta => meta.number !== persisted.activeSegment).every(meta => meta.retracts && meta.retracts.v === 1 && typeof meta.retractsHash === 'string'),
        'the summaries the first read built are written to the manifest');
      const undoneSummary = persisted.segments.find(meta => meta.retracts && meta.retracts.targets.some(pair => pair[0] === old.undone.rowId));
      A.ok(!!undoneSummary, 'and the persisted summary names the undone row');
      const root = st.io._internals.root;
      st.io.close();
      const again = station(root);
      reads.length = 0;
      const proof = again.io.retractionsFor([old.talk[0].rowId, old.undone.rowId]);
      A.ok(proof.proofComplete === true && proof.retractions.get(old.undone.rowId) === 'undo' && reads.length <= 1,
        'after a restart the proof is vouched at once from the manifest, reading only the active segment (' + reads.length + ' segment reads)');
    }
    {
      const st = station(copyOf(oldDir)), ids = old.talk.map(row => row.rowId);
      // HistoryRef.expand asks again for only the ids an answer left missing, up to 32 rounds
      let ask = ids.slice(), rounds = 0, codes = [], shown = [], retracted = [];
      while (ask.length && rounds++ < 32) {
        const res = await post(st.routes.handleTranscriptRows, { agent: 'agent', streams: [{ streamId: 'talk', rowIds: ask }] });
        codes.push(res.code);
        if (res.code !== 200) break;
        const one = res.body.streams[0];
        shown = shown.concat(one.turns.map(t => t.rowId)); retracted = retracted.concat(one.retracted);
        if (one.missing.length === ask.length) break;
        ask = one.missing;
      }
      A.ok(codes.every(code => code === 200), 'the FIRST by-id read after the upgrade (a saved history read back) answers: ' + codes.join(','));
      A.eq(shown.slice().sort((a, b) => a - b), kept.map(row => row.rowId), 'and returns every row of the conversation within the page\'s rounds');
      A.eq(retracted, [old.undone.rowId], 'naming the undone row as undone, never as shown');
    }
    {
      const st = station(copyOf(oldDir));
      const res = await post(st.routes.handleTurnIdentityRetractions, { streamId: 'talk', rowIds: old.talk.map(row => row.rowId) });
      A.eq(res.code, 200, 'the FIRST cached-row check after the upgrade answers, for rows spread over ' + talkSegments.size + ' segments (it was a 503 for good)');
      A.eq(res.body && res.body.retracted, [old.undone.rowId], 'and names exactly the undone row');
      const replay = st.store.view('model-replay', 'talk', { limit: 100, shape: 'pairs' });
      A.ok(Array.isArray(replay) && replay.length > 0 && !JSON.stringify(replay).includes(old.undone.content), 'a run reads its history on the first try too, without the undone turn');
    }

    // ---- the page: the first open and the first send after the upgrade ---------------------------------------------------------
    const preDir = copyOf(oldDir), pre = station(preDir);
    const turns = getTranscript(pre, 'talk').body.turns;   // what a 0.15 page held of the conversation (rowIds, as the station returned them)
    pre.io.close();
    for (const root of ROOTS) {
      const T = Rig.tree(root);
      const pageOn = rec => { const st = station(copyOf(oldDir)), tp = Rig.transport(st.routes); return { st, tp, p: Rig.page({ tree: T, tp, init: slice(rec) }) }; };
      const sendGoes = async (p, label) => {
        let error = null;
        try { await p.api.ensureHistoryReady(p.W.get('talk'), new AbortController().signal); } catch (e) { error = e; }
        A.ok(!error, root + ': ' + label + ': a send is admitted, not held (' + (error && error.message) + ')');
      };
      {
        // the session exactly as 0.14.x saved it: inline rows, no row ids
        const { p, tp } = pageOn(record('talk', kept.map(row => ({ role: row.role, content: row.content, ts: row.ts }))));
        A.eq(await p.load('talk'), true, root + ': a 0.14.x session loads its history on the FIRST read after the upgrade');
        A.ok(tp.calls.some(c => c.path === '/api/transcript'), root + ': (through the real GET route)');
        A.ok(!p.events().includes('history-unavailable'), root + ': with no "history unavailable" on the way (' + p.events().join(',') + ')');
        await sendGoes(p, '0.14.x session');
      }
      {
        // the session as a 0.15 page held it: the station's rows, numbered, spread over every old segment, and the turn it cached
        // before that turn was undone elsewhere
        const cached = clone(turns);
        cached.splice(3, 0, { streamId: 'talk', rowId: old.undone.rowId, role: old.undone.role, content: old.undone.content, ts: old.undone.ts });
        const { p, tp } = pageOn(record('talk', cached));
        A.eq(await p.load('talk'), true, root + ': a session whose cached rows span ' + talkSegments.size + ' old segments loads on the first read');
        A.ok(!p.events().includes('history-unavailable'), root + ': with no "history unavailable" on the way (' + p.events().join(',') + ')');
        const asked = tp.calls.filter(c => c.path === '/api/turn-identity/retractions').map(c => c.body.rowIds);
        A.eq(asked, [[old.undone.rowId]], root + ': the cached-row check asks only about the row the GET did not return (the rows it returned are proved by it)');
        A.ok(!p.W.get('talk').history.some(r => r.content === old.undone.content), root + ': and the undone turn leaves the page');
        A.eq(p.W.get('talk').history.filter(r => r.role === 'user' || r.role === 'assistant').length, kept.length, root + ': every other turn stays');
        await sendGoes(p, 'numbered session');
      }
      {
        // the session as a 0.15 page SAVED it: the history held by reference (save v7), read back through POST /api/transcript/rows
        const seals = new Map(turns.map(t => [T.HR.keyOf('talk', t.rowId), clone(t)]));
        const packed = T.HR.pack(clone(turns), { streamId: 'talk', seal: k => seals.get(k) || null });
        A.ok(T.HR.hasRef(packed), root + ': (the fixture history is packed)');
        const { p, tp } = pageOn(record('talk', packed));
        A.eq(await p.load('talk'), true, root + ': a packed session reads back on the FIRST read after the upgrade');
        A.ok(tp.rowsCalls().length >= 1, root + ': (through the by-id route)');
        A.eq(p.W.get('talk').history.map(r => r.content), turns.map(t => t.content), root + ': every row is back, in order');
        await sendGoes(p, 'packed session');
      }
    }

    // ---- nothing is loosened: a damaged old segment is still never vouched -----------------------------------------------------
    {
      const damagedDir = path.join(base, 'damaged');
      writeOldStore(damagedDir, { damage: true, keepLease: true });
      const st = station(damagedDir);
      const res = getTranscript(st, 'talk');
      A.eq([res.code, res.body && res.body.code], [503, 'TRANSCRIPT_UNVOUCHED'], 'a damaged old segment still refuses the proof: an honest 503 with its code, not a 500');
      let error = null;
      try { st.store.view('display', 'talk', { limit: 200 }); } catch (e) { error = e; }
      A.eq(error && error.code, 'TRANSCRIPT_UNVOUCHED', 'and the store never treats it as "no undo there"');
      const T = Rig.tree(ROOTS[0]), tp = Rig.transport(st.routes);
      const p = Rig.page({ tree: T, tp, init: slice(record('talk', kept.map(row => ({ role: row.role, content: row.content, ts: row.ts })))) });
      A.eq(await p.load('talk'), false, 'the page does not claim a restore');
      const started = Date.now();
      let refused = null;
      try { await p.api.ensureHistoryReady(p.W.get('talk'), new AbortController().signal); } catch (e) { refused = e; }
      A.ok(refused && refused.code === 'HISTORY_UNAVAILABLE' && Date.now() - started < 5000, 'the send ends at once with the honest refusal, never held');
      A.ok(refused && /history could not be restored/.test(refused.message) && !/connection returns/.test(refused.message),
        'worded for a station that answered: it does not blame the connection (' + (refused && refused.message) + ')');
    }
  } finally {
    for (const io of opened) { try { io.close(); } catch (_) {} }
    if (path.dirname(path.resolve(base)) !== temp) throw new Error('refusing to remove a fixture outside its temporary parent');
    fs.rmSync(base, { recursive: true, force: true });
  }
  A.report('history-upgrade-178');
})().catch(error => { A.ok(false, error.stack); A.report('history-upgrade-178'); });
