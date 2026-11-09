/* node test/transcript-torn-tail-append.test.js — H2: an append after a TORN last line never silently loses the new row.

   A crash mid-append can leave the active transcript segment ending in a partial row with no newline. appendRaw used
   to write the next row straight after it: fragment + row became ONE unparsable line, readRows() dropped both — and
   the strict read-back had "proven" the row by parsing only its own byte range, so a run journal was retired on a
   row nobody could read back. Now: the fragment is set aside (kept beside the segment, the segment cut back to its last
   newline: test/transcript-torn-tail-recovery.test.js holds the rest of that contract), the read-back proves the row is a
   complete newline-bounded LINE of the file, and a short/stalled write throws (strict callers fail) and rolls back. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-torn-tail-'));
const ROOT = path.join(DIR, 'history');
const SEG = path.join(ROOT, 'segment-000001.jsonl');
let t = 0;
const clock = { now: () => ++t };
function open(fsImpl, warnings) {
  return makeSegmentedTranscriptIo({ fs: fsImpl || fs, path, root: ROOT, onWarning: m => { if (warnings) warnings.push(m); } });
}
// a Proxy over the real fs that overrides ONE method
function withFs(prop, impl) { return new Proxy(fs, { get(target, key) { return key === prop ? impl(target) : target[key]; } }); }

try {
  // ---- 1. torn tail → set aside, the next strict append starts a clean line and survives a restart ------------------
  {
    const warned = [];
    const store = makeTranscriptStore({ io: open(fs, warned), clock });
    store.appendStrict({ streamId: 's', agentId: 'a', role: 'user', content: 'first row' });
    const fragment = '{"streamId":"s","role":"assistant","content":"half of a ro';
    fs.appendFileSync(SEG, fragment);   // the crash-torn tail
    const proven = store.appendStrict({ streamId: 's', agentId: 'a', role: 'assistant', content: 'written after the tear' });
    A.eq(proven.content, 'written after the tear', 'the strict append reports the row it proved');
    const lines = fs.readFileSync(SEG, 'utf8').split('\n');
    A.eq(lines.length, 3, 'row, new row, trailing newline: the fragment is out of the segment, never glued to the new row');
    A.eq(JSON.parse(lines[1]).content, 'written after the tear', 'the new row is a complete line of its own');
    const kept = fs.readdirSync(ROOT).filter(n => /^segment-000001\.jsonl\.torn-\d+-[0-9a-f]{12}$/.test(n));
    A.eq(kept.length, 1, 'the fragment is kept in one file beside the segment');
    A.eq(kept.length && fs.readFileSync(path.join(ROOT, kept[0]), 'utf8'), fragment, 'byte for byte');
    A.ok(warned.some(w => /set aside an unfinished last line/.test(w)), 'one warning says the fragment was set aside, and where');
    const warnings = [];
    const reopened = makeTranscriptStore({ io: open(fs, warnings), clock });   // restart: only disk
    A.eq(reopened.history('s').map(r => r.content), ['first row', 'written after the tear'], 'after restart the new row is readable (it was lost before the fix)');
    A.ok(!warnings.some(w => /corrupt line/.test(w)), 'and the restart finds no damaged line in the segment');
    // and appending again on a clean tail adds NO extra separator
    const before = fs.statSync(SEG).size;
    const again = open();
    const row = again.appendDurable({ streamId: 's', agentId: 'a', role: 'user', content: 'x' });
    A.eq(fs.statSync(SEG).size - before, Buffer.byteLength(JSON.stringify(row) + '\n'), 'a clean tail gets no separator (byte-exact append)');
  }

  // ---- 2. the read-back proves the LINE, not just the byte range ------------------------------------------------------
  {
    fs.appendFileSync(SEG, '{"torn":');
    const size = fs.statSync(SEG).size;
    // an fs whose tail probe LIES ("the file ends in a newline"), so no separator is written: the row's own bytes
    // parse, but the line they sit on does not — exactly the old false proof.
    const lying = withFs('readSync', (real) => function (fd, buf, off, len, pos) {
      if (len === 1 && pos === size - 1) { buf[off] = 0x0a; return 1; }
      return real.readSync(fd, buf, off, len, pos);
    });
    const io = open(lying);
    A.throws(() => io.appendDurable({ streamId: 's', agentId: 'a', role: 'user', content: 'glued' }), 'a row glued onto a fragment fails the strict read-back');
    const store = makeTranscriptStore({ io, clock });
    let threw = false;
    try { store.appendStrict({ streamId: 's', agentId: 'a', role: 'user', content: 'glued again' }); } catch (_) { threw = true; }
    A.ok(threw, 'appendStrict (the path journal retirement trusts) throws instead of acknowledging it');
    A.eq(fs.statSync(SEG).size, size, 'the rejected append was rolled back to the prior byte boundary');
  }

  // ---- 3. short writes: progress is completed, a stalled write throws and rolls back ---------------------------------
  {
    const size0 = fs.statSync(SEG).size;
    let calls = 0;
    const trickle = withFs('writeSync', (real) => function (fd, buf, off, len, pos) { calls++; return real.writeSync(fd, buf, off, Math.min(len, 7), pos); });
    const row = open(trickle).appendDurable({ streamId: 's', agentId: 'a', role: 'user', content: 'arrives in 7-byte writes' });
    A.ok(calls > 3, 'a short write is continued, not mistaken for the whole row (' + calls + ' writes)');
    A.eq(row.content, 'arrives in 7-byte writes', 'the completed row is proven');
    const size1 = fs.statSync(SEG).size;
    A.ok(size1 > size0, 'bytes landed');
    let first = true;
    const stalled = withFs('writeSync', (real) => function (fd, buf, off, len, pos) {
      if (!first) return 0;
      first = false;
      return real.writeSync(fd, buf, off, Math.min(len, 5), pos);
    });
    const store = makeTranscriptStore({ io: open(stalled), clock });
    A.throws(() => store.appendStrict({ streamId: 's', agentId: 'a', role: 'user', content: 'never completes' }), 'a stalled (zero-progress) write throws for a strict caller');
    A.eq(fs.statSync(SEG).size, size1, 'the partial bytes are rolled back');
    const reopened = makeTranscriptStore({ io: open(), clock });
    A.eq(reopened.history('s').map(r => r.content).slice(-2), ['x', 'arrives in 7-byte writes'], 'the store is intact and readable after the rejected append');
  }
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}
A.report('transcript-torn-tail-append.test');
