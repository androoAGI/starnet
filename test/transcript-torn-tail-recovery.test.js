'use strict';
/* node test/transcript-torn-tail-recovery.test.js — a torn LAST line of the append-active transcript segment is set aside, never kept as
   damage; every other damaged line still fails closed (fix-torn-1108).

   A crash, a force quit or a power cut in the middle of an append leaves the active segment ending in part of a row, with no newline.
   appendRaw never acknowledged that row (it acknowledges a row only after reading it back as a complete line), but the fragment stayed:
   every strict read of the segment failed on it (the owner proof, the retract context every displayed history asks for, a complete
   view), the next append isolated it on a line of its own (damage in the middle, for good), and the segment, once closed, was never
   vouched. One crash mid-save made "Conversation history could not be restored" permanent for every conversation in that segment.

   Held here over the REAL segmented io and store, the REAL routes sliced out of sidecar/index.js and the REAL page read seam of chat.js
   (test/helpers/seal-rig.js):
     1. at boot the fragment's bytes are kept beside the segment, byte for byte, and the segment is cut back to its last newline; strict
        reads and the proof answer; GET /api/transcript and the page restore the history (the page says so once, quietly) and a send is
        admitted; the next append starts a clean line; the segment rolls closed, is vouched, and the next boot finds no collision;
     2. NOT relaxed: a damaged line in the middle, a newline-terminated last line that does not parse, a final fragment that parses (a
        complete value, not a cut one) and a torn line in a closed segment all still fail closed, and nothing is cut or copied;
     3. the repair is safe: two io views reading at once set a fragment aside once; an append handle opened before the repair appends
        a clean line after it; a copy an interrupted repair left is reused, a different file under that name is never overwritten, and a
        segment that changes under the repair is left as it is;
     4. a delete is never surer than before: a claim the set-aside bytes name stays doubted (eachRow). */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js');

const ROOTS = ['frontend/app', 'website/app/app'];
const SEGMENT = 900;
const TORN_RE = /^segment-(\d{6})\.jsonl\.torn-(\d+)-([0-9a-f]{12})$/;
const temp = path.resolve(os.tmpdir()), base = fs.mkdtempSync(path.join(temp, 'torn-tail-recovery-'));
if (path.dirname(base) !== temp) throw new Error('fixture directory escaped its temporary parent');
const opened = [];
let dirs = 0;
const freshDir = () => path.join(base, 'd' + (++dirs));
function openIo(root, extra) {
  const warnings = [];
  const io = History.makeSegmentedTranscriptIo(Object.assign({ fs, path, root, segmentBytes: SEGMENT, schedule() {}, onWarning: m => warnings.push(m) }, extra || null));
  opened.push(io);
  return { io, warnings };
}
const keptIn = root => fs.readdirSync(root).filter(name => TORN_RE.test(name)).sort();
const segOf = (io, n) => io._internals.segFile(n == null ? io.status().activeSegment : n);
let ts = 1700000000000;
const put = (io, stream, role, content, extra) => io.appendDurable(Object.assign({ streamId: stream, agentId: 'agent', role, kind: 'turn', taintKnown: true, ts: ++ts, content },
  role === 'assistant' ? { sourceRunId: 'run-' + stream + '-' + ts } : null, extra || null));
// the first `cut` bytes of the row an append was writing when the station stopped (the store writes streamId first)
const tornRow = (stream, cut, extra) => Buffer.from(JSON.stringify(Object.assign({ streamId: stream, agentId: 'agent', role: 'assistant', kind: 'turn' }, extra || null,
  { taintKnown: true, ts: ++ts, content: 'an answer the crash cut off ' + 'w'.repeat(200), rowId: 999999 })).slice(0, cut));
const strictFails = (io, stream) => { try { io.history(stream, { strict: true, limit: 500 }); return false; } catch (_) { return true; } };
function station(io) {
  const live = new Set(), store = Store.makeTranscriptStore({ io, live, deletedAt: () => 0 });
  return { io, store, routes: Rig.routes({ store, live }) };
}
function getTranscript(st, stream) {
  const res = { code: 0, body: null };
  st.routes.serveTranscript({ url: '/api/transcript?agent=agent&stream=' + stream + '&limit=200' }, res);
  return res;
}
const record = (id, history) => ({ id, title: 'session ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: [], createdAt: 1800000000000, lastActiveAt: 1800000000000, lastReadAt: 1800000000001 });
const slice = rec => ({ workstreams: [rec], activeId: rec.id, generalId: rec.id });
// a conversation spread over closed segments and the active one, with an undo in it
function writeConversation(root) {
  const { io } = openIo(root);
  const talk = [];
  for (let i = 0; i < 10; i++) {
    talk.push(put(io, 'talk', i % 2 ? 'assistant' : 'user', (i % 2 ? 'answer ' : 'question ') + i + ' ' + 'x'.repeat(60)));
    put(io, 'other', 'user', 'another session ' + i + ' ' + 'z'.repeat(120));
  }
  const undone = talk[3];
  put(io, 'talk', 'system', '', { kind: 'retract', targets: [undone.rowId], reason: 'undo' });
  talk.push(put(io, 'talk', 'user', 'the last question before the crash'));
  io.close();
  return { talk, undone, kept: talk.filter(row => row.rowId !== undone.rowId), active: io.status().activeSegment, segments: io.status().segments.length };
}

(async () => {
  try {
    // ---- 1. a crash mid-append: the boot sets the torn line aside, and everything restores ----------------------------------------
    {
      const root = freshDir();
      const w = writeConversation(root);
      A.ok(w.segments >= 3, 'the conversation spans closed segments and the active one (' + w.segments + ')');
      const seg = path.join(root, History._internals.segmentName(w.active));
      const before = fs.readFileSync(seg);
      const fragment = tornRow('talk', 130, { attachments: [{ path: '.attachments/cut.txt' }] });
      fs.appendFileSync(seg, fragment);   // the station stopped in the middle of this append

      // the next boot (a roll target with room, so the append after the recovery lands in this same segment)
      const BOOT = { segmentBytes: 4096 };
      let { io, warnings } = openIo(root, BOOT);
      const kept = keptIn(root);
      A.eq(kept.length, 1, 'the torn line is kept in one file beside the segment');
      const m = TORN_RE.exec(kept[0] || '') || [];
      A.eq([Number(m[1]), Number(m[2])], [w.active, before.length], 'named for its segment and the byte it began at');
      A.ok(kept.length === 1 && fs.readFileSync(path.join(root, kept[0])).equals(fragment), 'its bytes are kept byte for byte');
      A.ok(fs.readFileSync(seg).equals(before), 'the segment is cut back to exactly its last complete row');
      const said = warnings.filter(x => /set aside an unfinished last line/.test(x));
      A.ok(said.length === 1 && /found at boot/.test(said[0]) && said[0].includes(kept[0]) && said[0].includes(fragment.length + ' bytes'),
        'one log line says so, with the file and the size: ' + said.join(' | '));
      A.eq(io.setAsideTails('talk').map(x => [x.file, x.segment, x.offset, x.bytes, x.streamId]), [[kept[0], w.active, before.length, fragment.length, 'talk']],
        'the io names the conversation the torn row was written for');
      A.eq(io.setAsideTails('other'), [], 'and no other conversation');
      const meta = io.status().segments.find(s => s.number === w.active);
      A.eq([meta.corruptLines, meta.bytes], [0, before.length], 'the active summary counts no damaged line and the bytes on disk');

      // strict reads and the proof answer
      A.ok(!strictFails(io, 'talk'), 'a strict read of the conversation answers');
      const proof = io.retractionsFor(w.talk.map(r => r.rowId));
      A.ok(proof.proofComplete === true && proof.retractions.get(w.undone.rowId) === 'undo', 'the retract proof is complete, and the undo still stands');
      const st = station(io);
      let error = null;
      try { st.store.view('proof', 'talk', { complete: true }); } catch (e) { error = e; }
      A.ok(!error, 'a complete view is vouched (' + (error && error.message) + ')');

      // the station's GET and the page
      const got = getTranscript(st, 'talk');
      A.eq(got.code, 200, 'GET /api/transcript answers');
      const shown = (got.body && got.body.turns || []).map(t => t.content);
      A.ok(w.kept.every(r => shown.includes(r.content)) && !shown.includes(w.undone.content), 'with every complete row, and without the undone one');
      A.eq(got.body && got.body.setAside, [{ id: kept[0], bytes: fragment.length }], 'and names the line it set aside');
      const otherGot = getTranscript(st, 'other');
      A.ok(otherGot.code === 200 && !('setAside' in otherGot.body), 'another conversation\'s reply is unchanged');
      for (const tree of ROOTS) {
        const T = Rig.tree(tree), tp = Rig.transport(st.routes);
        const p = Rig.page({ tree: T, tp, init: slice(record('talk', w.kept.map(r => ({ role: r.role, content: r.content, ts: r.ts })))) });
        A.eq(await p.load('talk'), true, tree + ': the page restores the conversation');
        A.ok(!p.events().includes('history-unavailable'), tree + ': with no "history unavailable" (' + p.events().join(',') + ')');
        const notes = () => p.notes.filter(n => /The last unfinished message was set aside/.test(n));
        A.eq(notes().length, 1, tree + ': and says once, in the station\'s quiet line, that the unfinished message was set aside');
        A.ok(!p.W.get('talk').history.some(r => /set aside/.test(String(r.content))), tree + ': the note is not saved into the history');
        await p.load('talk');
        A.eq(notes().length, 1, tree + ': not again on the next load');
        error = null;
        try { await p.api.ensureHistoryReady(p.W.get('talk'), new AbortController().signal); } catch (e) { error = e; }
        A.ok(!error, tree + ': a send is admitted (' + (error && error.message) + ')');
      }

      // a delete is never surer than before: what the kept bytes name stays doubted
      A.eq(st.store.eachRow(() => {}, { claims: ['.attachments/cut.txt', '.attachments/free.txt'] }).doubted, ['.attachments/cut.txt'],
        'the attachment the set-aside line names stays doubted, and only that one');

      // appends after the recovery start a clean line, and survive a restart
      const after = put(io, 'talk', 'assistant', 'the answer, written again after the restart');
      A.eq(fs.statSync(seg).size, before.length + Buffer.byteLength(JSON.stringify(after) + '\n'), 'the next append starts right after the last complete row: no separator, nothing glued');
      io.close();
      ({ io, warnings } = openIo(root, BOOT));
      A.ok(!warnings.some(x => /corrupt line|set aside/.test(x)), 'a restart finds nothing to isolate or set aside (' + warnings.join(' | ') + ')');
      A.eq(io.history('talk', { strict: true, limit: 500 }).slice(-1)[0].content, after.content, 'and reads the new row strictly');
      A.eq(keptIn(root), kept, 'the kept copy stays');

      // closed, the segment is vouched, and the next boot finds no id collision
      while (io.status().activeSegment === w.active) put(io, 'other', 'user', 'filler ' + 'f'.repeat(160));
      const closed = io.status().segments.find(s => s.number === w.active);
      A.ok(closed.corruptLines === 0 && closed.retracts && closed.retracts.v === 1 && typeof closed.retractsHash === 'string', 'closed, the segment carries a whole retract summary: vouched');
      A.eq(closed.bytes, fs.statSync(seg).size, 'and records the size it has');
      io.close();
      ({ io, warnings } = openIo(root, BOOT));
      A.eq(io.status().idCollisions, [], 'the next boot finds no id collision');
      A.ok(io.retractionsFor(w.talk.map(r => r.rowId)).proofComplete === true, 'and the proof is complete');
    }

    // ---- 2. NOT relaxed: every other damaged line still fails closed, and nothing is cut or copied --------------------------------
    {
      const damaged = (label, damage, o) => {
        const root = freshDir();
        let { io } = openIo(root, { segmentBytes: 64 * 1024 });
        for (let i = 0; i < 4; i++) put(io, 'talk', i % 2 ? 'assistant' : 'user', 'row ' + i);
        io.close();
        fs.appendFileSync(segOf(io), damage);
        if (o && o.more) { ({ io } = openIo(root, { segmentBytes: 64 * 1024 })); put(io, 'talk', 'user', 'a row after the damage'); io.close(); }
        const bytes = fs.readFileSync(segOf(io));
        const booted = openIo(root, { segmentBytes: 64 * 1024 });
        A.ok(fs.readFileSync(segOf(booted.io)).equals(bytes), label + ': the boot leaves the segment exactly as it was');
        A.eq(keptIn(root), [], label + ': nothing is set aside');
        A.ok(strictFails(booted.io, 'talk'), label + ': a strict read still fails');
        A.ok(booted.io.retractionsFor([1, 2]).proofComplete === false, label + ': the proof is still incomplete');
        const got = getTranscript(station(booted.io), 'talk');
        A.eq([got.code, got.body && got.body.code], [503, 'TRANSCRIPT_UNVOUCHED'], label + ': GET still answers 503 TRANSCRIPT_UNVOUCHED');
        return { root, io: booted.io, bytes };
      };
      damaged('a damaged line in the middle', '{"streamId":"talk","role":"assistant","content":"cut\n', { more: true });
      damaged('a complete last line that does not parse', '{"streamId":"talk","role":"assistant","content":"cut\n');
      const parses = damaged('a final fragment that parses (a whole value, no newline)', '{"streamId":"talk","note":"a whole value"}');
      // an append isolates it on a line of its own, exactly as before, and it stays damage
      put(parses.io, 'talk', 'user', 'after the whole value');
      const lines = fs.readFileSync(segOf(parses.io), 'utf8').split('\n');
      A.eq(lines[lines.length - 3], '{"streamId":"talk","note":"a whole value"}', 'a final fragment that parses is isolated by the next append, as before');
      A.eq(keptIn(parses.root), [], 'and is never set aside');
      A.ok(strictFails(parses.io, 'talk'), 'and still fails a strict read');

      // a torn line in a CLOSED segment stays damage
      const root = freshDir();
      const w = writeConversation(root);
      const closedNo = w.active - 1, closedSeg = path.join(root, History._internals.segmentName(closedNo));
      fs.appendFileSync(closedSeg, tornRow('talk', 60));
      const closedBytes = fs.readFileSync(closedSeg);
      const { io } = openIo(root);
      A.ok(fs.readFileSync(closedSeg).equals(closedBytes), 'a torn line in a closed segment: the boot leaves it exactly as it was');
      A.eq(keptIn(root), [], 'nothing is set aside');
      const inClosed = w.talk.filter(r => r.rowId >= io.status().segments.find(s => s.number === closedNo).minRowId && r.rowId <= io.status().segments.find(s => s.number === closedNo).maxRowId).map(r => r.rowId);
      A.ok(inClosed.length > 0 && io.retractionsFor(inClosed).proofComplete === false, 'and the proof over its rows still fails closed');
      A.eq(getTranscript(station(io), 'talk').code, 503, 'GET still answers 503');
    }

    // ---- 3. the repair is safe: readers at once, a writer's open handle, an interrupted repair, a segment that changes under it ----
    {
      const root = freshDir();
      const a = openIo(root, { segmentBytes: 64 * 1024 });
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(put(a.io, 'talk', i % 2 ? 'assistant' : 'user', 'row ' + i));   // a holds its append handle open
      const b = openIo(root, { segmentBytes: 64 * 1024 });   // a second view of the same folder
      const seg = segOf(a.io), clean = fs.readFileSync(seg);
      // an append failed and its rollback failed too: a torn line while both views run
      const first = tornRow('talk', 50);
      fs.appendFileSync(seg, first);
      const ids = rows.map(r => r.rowId);
      const pa = a.io.retractionsFor(ids), pb = b.io.retractionsFor(ids);
      A.ok(pa.proofComplete === true && pb.proofComplete === true, 'two views reading at once both prove the history');
      A.eq(keptIn(root).length, 1, 'the fragment is set aside once');
      A.ok(fs.readFileSync(seg).equals(clean), 'and the segment is cut once, back to its last complete row');
      A.eq(a.warnings.concat(b.warnings).filter(x => /set aside an unfinished/.test(x)).length, 1, 'one log line');
      // a second tear: the writer has its append handle open again, the other view repairs, then the writer appends through that handle
      rows.push(put(a.io, 'talk', 'user', 'a row after the first repair'));
      const clean2 = fs.readFileSync(seg);
      fs.appendFileSync(seg, tornRow('talk', 70));
      A.ok(!strictFails(b.io, 'talk'), 'the second view sets the new fragment aside on its read');
      A.ok(fs.readFileSync(seg).equals(clean2), 'cut back under the writer\'s open handle');
      const late = put(a.io, 'talk', 'assistant', 'appended through a handle opened before the repair');
      const text = fs.readFileSync(seg, 'utf8');
      A.ok(text === clean2.toString('utf8') + JSON.stringify(late) + '\n', 'the writer\'s row is a clean line right after the last complete row');
      A.eq(keptIn(root).length, 2, 'both fragments are kept');
      const fresh = openIo(root, { segmentBytes: 64 * 1024 });
      A.eq(fresh.io.history('talk', { strict: true, limit: 10 }).map(r => r.content), rows.map(r => r.content).concat(late.content), 'a fresh boot reads every row strictly');

      // a copy an interrupted repair left (written, then the station stopped before the cut) is reused, not doubled
      a.io.close(); b.io.close(); fresh.io.close();
      const third = tornRow('talk', 90), offset = fs.statSync(seg).size;
      fs.appendFileSync(seg, third);
      const name = History._internals.segmentName(1) + '.torn-' + offset + '-' + crypto.createHash('sha256').update(third).digest('hex').slice(0, 12);
      fs.writeFileSync(path.join(root, name), third);
      const resumed = openIo(root, { segmentBytes: 64 * 1024 });
      A.eq(keptIn(root).length, 3, 'an interrupted repair\'s copy is used as it is: one file for the fragment');
      A.eq(fs.statSync(seg).size, offset, 'and the cut is made');
      resumed.io.close();

      // a file of that name with other bytes is never overwritten: the fragment stays where it was
      const fourth = tornRow('talk', 40), at4 = fs.statSync(seg).size;
      fs.appendFileSync(seg, fourth);
      const name4 = History._internals.segmentName(1) + '.torn-' + at4 + '-' + crypto.createHash('sha256').update(fourth).digest('hex').slice(0, 12);
      fs.writeFileSync(path.join(root, name4), 'something else');
      const refused = openIo(root, { segmentBytes: 64 * 1024 });
      A.eq(fs.readFileSync(path.join(root, name4), 'utf8'), 'something else', 'a different file under the copy\'s name is never overwritten');
      A.eq(fs.statSync(seg).size, at4 + fourth.length, 'and the segment keeps the fragment');
      A.ok(refused.warnings.some(x => /could not be set aside/.test(x)), 'which the log says');
      A.ok(strictFails(refused.io, 'talk'), 'and strict reads fail on it, as before');
      refused.io.close();
      fs.rmSync(path.join(root, name4));

      // a segment that changes under the repair (another writer, between the copy and the cut) is left as it is
      let race = true;
      const racing = new Proxy(fs, { get(target, key) {
        if (key !== 'renameSync') return target[key];
        return (from, to) => { const r = target.renameSync(from, to); if (race && TORN_RE.test(path.basename(String(to)))) { race = false; target.appendFileSync(seg, 'X'); } return r; };
      } });
      const raced = openIo(root, { segmentBytes: 64 * 1024, fs: racing });
      A.ok(raced.warnings.some(x => /changed while its unfinished last line was being set aside/.test(x)), 'a segment that changed under the repair is reported');
      A.eq(fs.statSync(seg).size, at4 + fourth.length + 1, 'and left exactly as it is now: the cut is never made on bytes it did not judge');
      A.ok(!strictFails(raced.io, 'talk'), 'the next read judges it again, and sets the longer fragment aside');
      A.eq(fs.statSync(seg).size, at4, 'cut back to the last complete row');
      A.ok(keptIn(root).some(n => fs.readFileSync(path.join(root, n)).equals(Buffer.concat([fourth, Buffer.from('X')]))), 'with the bytes it judged kept');
    }
  } finally {
    for (const io of opened) { try { io.close(); } catch (_) {} }
    if (path.dirname(path.resolve(base)) !== temp) throw new Error('refusing to remove a fixture outside its temporary parent');
    fs.rmSync(base, { recursive: true, force: true });
  }
  A.report('transcript-torn-tail-recovery');
})().catch(error => { A.ok(false, error.stack); A.report('transcript-torn-tail-recovery'); });
