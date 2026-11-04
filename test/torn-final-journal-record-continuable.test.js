/* node test/torn-final-journal-record-continuable.test.js — a torn LAST journal record stays actionable.

   Power loss mid-append leaves a partial final record: the most common crash signature. Under the fsync contract
   that record never became durable, so the hash-chain-valid prefix is as trustworthy as an intact journal. It used
   to be repaired AND made forensic-only (no resolve, no continue). Now (2026-09-22):
     A. torn final record (partial JSON, NUL fill, or garbage + newline) -> damage 'torn_tail', not forensic; the
        repair keeps a `.torn-*` forensic copy; resolve / continuation plan / prepare / start / finish all work, and
        every later record chains cleanly after the cut;
     B. a NEW process that appends before any listing adopts the file first (repair + chain position) instead of
        restarting the chain at seq 1 or gluing onto the torn bytes;
     C. an intact final record whose newline never landed is terminated, not repaired, and stays clean;
     D. mid-file damage, a complete-but-invalid final record, and bytes glued after a torn record all stay
        forensic-only (resolve refused, no continuation) with their `.corrupt-*` copy;
     E. retiring the settled run removes its `.torn-*` copy with it; `.corrupt-*` evidence is never touched.
   Real fs writer in a temp dir; injected clock; deterministic. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../sidecar/run-journal.js');
const Recovery = require('../sidecar/run-recovery.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-torn-journal-'));
let tick = 5000;
const clock = { now: () => ++tick };
const fileOf = runId => path.join(root, J._internals.runFileName(runId));
const siblings = runId => fs.readdirSync(root).filter(n => n.indexOf(J._internals.runFileName(runId) + '.') === 0).sort();
const argsRaw = '{"path":"out.txt","content":"x"}';

// A crashed run whose last durable record is a DISPATCHED mutation with no result (needs review), then a torn record.
function crashed(journal, runId) {
  journal.begin({ runId, agentId: 'agent', streamId: 'torn-stream', model: 'm' });
  journal.checkpoint(runId, { phase: 'initial', turn: 0, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'write the file' }] });
  journal.checkpointMessages(runId, { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'fs_write', arguments: argsRaw } }] }] });
  journal.toolIntent(runId, { callId: 'w1', name: 'fs.write', argsRaw, replayFingerprint: Recovery.replayFingerprint('fs.write', argsRaw), mutating: true, boundaryModel: J.DISPATCH_BOUNDARY_MODEL });
  journal.toolDispatch(runId, { callId: 'w1', name: 'fs.write', mutating: true });
}
const tornTail = '{"v":1,"runId":"x","seq":9,"ts":1,"type":"tool_res';   // a partial append: no closing brace, no newline

try {
  // ---- A. torn final record -> actionable -------------------------------------------------------------------
  {
    crashed(J.makeRunJournal({ dir: root, clock }), 'torn-a');
    fs.appendFileSync(fileOf('torn-a'), tornTail, 'utf8');
    const boot = J.makeRunJournal({ dir: root, clock });   // a restart
    const seen = boot.inspect('torn-a');
    A.eq([seen.corrupt, seen.damage, seen.forensic], [true, 'torn_tail', false], 'a torn final record is disclosed but classified torn_tail, not forensic');
    A.eq(seen.status, 'needs_review', 'the valid prefix keeps its exact recovery status');
    const listed = boot.recoverPage({ limit: 10 }).rows.find(r => r.runId === 'torn-a');
    A.ok(listed && /\.torn-r[a-f0-9]{10}$/.test(String(listed.repairedFrom || '')), 'the repair keeps a .torn-* forensic copy of the damaged bytes (its nonce carries a letter: never a numbered quarantine)');
    A.ok(fs.readFileSync(listed.repairedFrom, 'utf8').endsWith(tornTail), 'the forensic copy holds the torn bytes verbatim');
    A.eq(siblings('torn-a').filter(n => /\.corrupt/.test(n)), [], 'no .corrupt* sibling is created for a torn tail');
    A.eq(J._internals.parseRecords(fs.readFileSync(fileOf('torn-a'), 'utf8')).damage, 'none', 'the active journal is the clean valid prefix after repair');
    const resolved = boot.resolve('torn-a', { resolutionId: 'res-torn', outcomes: [{ callId: 'w1', outcome: 'happened' }] });
    A.eq(resolved.status, 'resolved', 'a torn-tail journal is resolvable in-app');
    const plan = Recovery.continuationPlan(Object.assign({}, resolved, { forensicOnly: false }));
    A.eq(plan.blockedFingerprints, [Recovery.replayFingerprint('fs.write', argsRaw)], 'its reviewed continuation plan blocks the reviewed mutation');
    const ready = boot.prepareContinuation('torn-a', { continuationId: 'cont-torn', blockedFingerprints: plan.blockedFingerprints, context: plan.context });
    A.eq(ready.continuation.state, 'ready', 'a torn-tail journal is continuable');
    boot.startContinuation('torn-a', { continuationId: 'cont-torn', continuedRunId: 'next-a' });
    const done = boot.finishContinuation('torn-a', { continuationId: 'cont-torn', continuedRunId: 'next-a', reason: 'done', transcriptAck: true });
    const reparsed = J._internals.parseRecords(fs.readFileSync(fileOf('torn-a'), 'utf8'));
    A.eq([reparsed.corrupt, reparsed.records.length], [false, done.records], 'every record written after the cut chains cleanly');
    A.eq(done.retirable, true, 'the settled source is retirable');

    // NUL-filled tail (a size-extended file whose data never landed) and garbage + newline are also torn tails
    for (const [id, tail] of [['torn-nul', '\u0000'.repeat(64)], ['torn-nl', '{torn-tail\n']]) {
      crashed(J.makeRunJournal({ dir: root, clock }), id);
      fs.appendFileSync(fileOf(id), tail, 'utf8');
      const s = J.makeRunJournal({ dir: root, clock }).inspect(id);
      A.eq([s.damage, s.forensic], ['torn_tail', false], id + ': a final unparseable line with nothing after it is a torn tail');
    }

    // ---- E. retirement removes the torn copy with the settled journal --------------------------------------
    A.eq(boot.remove('torn-a'), true, 'the settled torn-tail source retires');
    A.eq(siblings('torn-a'), [], 'its .torn-* copy retires with it');
    A.ok(!fs.existsSync(fileOf('torn-a')), 'the active journal is gone');
  }

  // ---- B. a new process appends before any listing -> adopt first ------------------------------------------
  {
    crashed(J.makeRunJournal({ dir: root, clock }), 'torn-b');
    fs.appendFileSync(fileOf('torn-b'), tornTail, 'utf8');
    const fresh = J.makeRunJournal({ dir: root, clock });   // no recoverPage/recoverAll: resolve is the first touch
    const resolved = fresh.resolve('torn-b', { resolutionId: 'res-b', outcomes: [{ callId: 'w1', outcome: 'did_not_happen' }] });
    A.eq(resolved.status, 'resolved', 'resolve on an un-listed torn journal succeeds');
    const p = J._internals.parseRecords(fs.readFileSync(fileOf('torn-b'), 'utf8'));
    A.eq([p.corrupt, p.records[p.records.length - 1].type], [false, 'resolution'], 'the resolution chains after the adopted prefix (no seq-1 restart, no glued line)');
    A.ok(siblings('torn-b').some(n => /\.torn-/.test(n)), 'adoption kept the torn bytes as a .torn-* copy');

    // an INTACT journal touched first by a new process: the chain continues at the right sequence
    const intact = J.makeRunJournal({ dir: root, clock });
    crashed(intact, 'intact-b');
    const other = J.makeRunJournal({ dir: root, clock });
    other.resolve('intact-b', { resolutionId: 'res-i', outcomes: [{ callId: 'w1', outcome: 'happened' }] });
    const q = J._internals.parseRecords(fs.readFileSync(fileOf('intact-b'), 'utf8'));
    A.eq([q.corrupt, q.records.length], [false, 6], 'a cold append to an intact journal continues its hash chain');
  }

  // ---- C. intact final record, missing newline -> terminated, not repaired ---------------------------------
  {
    crashed(J.makeRunJournal({ dir: root, clock }), 'unterminated');
    const f = fileOf('unterminated');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n$/, ''), 'utf8');
    const s = J.makeRunJournal({ dir: root, clock });
    const before = s.inspect('unterminated');
    A.eq([before.corrupt, before.damage, before.records], [false, 'none', 5], 'an intact record without its newline is not damage');
    s.resolve('unterminated', { resolutionId: 'res-u', outcomes: [{ callId: 'w1', outcome: 'happened' }] });
    const p = J._internals.parseRecords(fs.readFileSync(f, 'utf8'));
    A.eq([p.corrupt, p.records.length], [false, 6], 'the next record starts on its own line instead of gluing onto the last one');
    A.eq(siblings('unterminated'), [], 'termination rewrites nothing and leaves no forensic copy');
  }

  // ---- D. everything else stays forensic-only --------------------------------------------------------------
  {
    const cases = {
      // an unparseable line with valid-looking records after it
      'mid-file': raw => { const lines = raw.trim().split('\n'); lines.splice(3, 0, '{garbage'); return lines.join('\n') + '\n'; },
      // a complete final record whose hash does not verify
      'bad-hash': raw => { const lines = raw.trim().split('\n'); const r = JSON.parse(lines.pop()); r.hash = 'f'.repeat(64); lines.push(JSON.stringify(r)); return lines.join('\n') + '\n'; },
      // a full record glued after torn bytes (an append that never repaired the tear first)
      'glued': raw => { const lines = raw.trim().split('\n'); const last = lines.pop(); return lines.join('\n') + '\n' + tornTail + last + '\n'; }
    };
    for (const id of Object.keys(cases)) {
      crashed(J.makeRunJournal({ dir: root, clock }), id);
      fs.writeFileSync(fileOf(id), cases[id](fs.readFileSync(fileOf(id), 'utf8')), 'utf8');
      const s = J.makeRunJournal({ dir: root, clock });
      const seen = s.inspect(id);
      A.eq([seen.damage, seen.forensic], ['corrupt', true], id + ': classified corrupt and forensic');
      A.throws(() => Recovery.continuationPlan(Object.assign({}, seen, { resolution: { outcomes: [{ callId: 'w1', outcome: 'happened' }] } })), id + ': no continuation plan');
      const row = s.recoverPage({ limit: 50 }).rows.find(r => r.file === fileOf(id));
      A.ok(row && /\.corrupt-r[a-f0-9]{10}$/.test(String(row.repairedFrom || '')), id + ': repair keeps a .corrupt-* forensic copy (its nonce carries a letter)');
      // after the repair the active file parses clean: the sibling is the durable damage verdict
      const after = s.inspect(id);
      A.eq([after.corrupt, after.damage, after.forensic, after.retirable], [false, 'corrupt', true, false], id + ': the repaired prefix stays forensic on every later inspect');
      A.throws(() => s.resolve(id, { resolutionId: 'res-' + id, outcomes: [{ callId: 'w1', outcome: 'happened' }] }), id + ': resolve is refused, before and after repair');
      A.throws(() => s.prepareContinuation(id, { continuationId: 'c-' + id, mode: 'automatic' }), id + ': no continuation can be prepared');
      A.eq(s.remove(id), false, id + ': a forensic journal never retires');
      A.ok(siblings(id).some(n => /\.corrupt-/.test(n)), id + ': the .corrupt-* evidence is kept');
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

A.report('torn-final-journal-record-continuable.test');
