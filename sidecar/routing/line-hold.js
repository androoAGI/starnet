/* sidecar/routing/line-hold.js — THE SAVED HOLD (line-hold lane, S3). Pure: no IO, no clock, no provider, no store.

   A work line that reaches a reviewer's gate and cannot go on (VERDICT: blocked, no usable VERDICT, a spent gate that holds) used to END
   there: the job settled as a terminal 'problem' and the work was gone to anyone who could still decide about it. It now PARKS. The walk
   (chain.js) reads its own live locals into the shapes of the version 1 continuation (out.holdState); this module turns that snapshot, the
   job's admission and the host's two proofs (the floor plan's hash, an exact receipt for every file the work carries) into ONE held
   continuation and has the existing validator (line-continuation.js demand) accept it before anything is written. The same LineJob keeps it
   (the host's verified writer, index.js lineJobsHold): there is no second store, and a restart finds the job as it was left.

     buildHeld(seed, line, job, origin, host) -> { ok: true, continuation } | { ok: false, reason }
        seed    the walk's seed (runLineJob): runId (the entry run) and taints; the verdicts the job ran under come with the walk's snapshot
        line    chain.advance's result of a walk that stopped at a gate: line.hold { reason, gateId, pass, why } and line.holdState
        job     the job's canonical record (id, line, intakeId, streamId, entry): the binding the validator checks the continuation against
        origin  the entry door as the H2 origin union (originOf below), or null when it does not map
        host    { planHash: the compiled floor plan's hash now, receiptFor({ path, projectRoot, producerRunId }) -> { path, projectRoot,
                digest, size } (throws when the file cannot be read) }
     It returns a refusal, never a throw, for every state this slice cannot save exactly: a gate inside a split that is still running or
     after a JOINER merged its branches (S5), a file that cannot be read, a stage that left no run receipt, an entry door that names no
     origin, an oversized crate, anything the validator rejects. The caller then ends the job the way it always did,
     with the reason said (line-runner.js) — a hold that cannot be saved exactly is never half-saved.

     originOf(job, facts) -> the H2 origin union member for job.entry, or null. `facts` are what the entry door holds (hub.js, the routine
        fires, the trigger and SEND TO runners); a door that cannot name them yields null, and the job ends as it did before this lane.
        A step-through test keeps its own paused session and is never held here.

   WHAT A HOLD COSTS: nothing. The spend of every stage already ran is in the legacy day ledger when the walk reaches the gate, so the
   saved accounting carries the entry and hop totals with an EMPTY dayReceipts list and nothing is noted again. */
'use strict';
const Continuation = require('./line-continuation.js');

const KEY = /^[A-Za-z0-9_.:-]{1,120}$/, HASH = /^[a-f0-9]{64}$/, JOB_ID = /^job-[a-z0-9]{8,24}$/;
const refuse = reason => ({ ok: false, reason: String(reason).replace(/\s+/g, ' ').trim().slice(0, 300) });
const text = x => typeof x === 'string' && x.length > 0 && !x.includes('\0');
const clip = (x, n) => String(x == null ? '' : x).slice(0, n);

function originOf(job, facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const ref = x => (x == null || typeof x === 'object') ? null : (text(String(x)) ? String(x) : null);
  const key = x => (x != null && KEY.test(String(x))) ? String(x) : null;
  const entry = job && job.entry;
  let o = null;
  if (entry === 'channel') {
    o = { kind: 'channel', instanceId: ref(f.instanceId), chatId: ref(f.chatId), senderId: ref(f.senderId), chatType: ref(f.chatType),
      threadId: ref(f.threadId), boundAgentId: key(f.boundAgentId) };
    if (o.instanceId === null || o.chatId === null || o.senderId === null || o.chatType === null) return null;
  } else if (entry === 'schedule' || entry === 'manual') {
    o = { kind: entry, routineId: ref(f.routineId), fireRunId: key(f.fireRunId), policyDigest: HASH.test(String(f.policyDigest)) ? String(f.policyDigest) : null };
    if (o.routineId === null || o.fireRunId === null || o.policyDigest === null) return null;
  } else if (entry === 'trigger') {
    const d = job && job.delivery, kind = f.triggerKind === 'folder' ? 'folder' : (f.triggerKind === 'webhook' || d) ? 'webhook' : null;
    const hash = x => HASH.test(String(x)) ? String(x) : null;
    o = { kind: 'trigger', triggerId: ref(f.triggerId || (d && d.triggerId)), triggerKind: kind,
      reservationId: kind === 'webhook' ? hash(f.reservationId || (d && d.reservationId)) : null,
      fingerprint: kind === 'webhook' ? hash(f.fingerprint || (d && d.fingerprint)) : null,
      sourceDigest: kind === 'folder' ? hash(f.sourceDigest) : null };
    if (o.triggerId === null || kind === null || (kind === 'webhook' ? o.reservationId === null || o.fingerprint === null : o.sourceDigest === null)) return null;
  } else if (entry === 'sample') {
    o = { kind: 'sample' };
  } else if (entry === 'sendto') {
    const lineage = Array.isArray(f.lineage) ? f.lineage.map(key) : null;
    o = { kind: 'sendto', sourceJobId: JOB_ID.test(String(f.sourceJobId)) ? String(f.sourceJobId) : null, sourceLineId: key(f.sourceLineId),
      sourceOutboxId: key(f.sourceOutboxId), targetIntakeId: key(f.targetIntakeId), lineage,
      depth: Number.isSafeInteger(f.depth) && f.depth >= 0 ? f.depth : null };
    if (o.sourceJobId === null || o.sourceLineId === null || o.sourceOutboxId === null || o.targetIntakeId === null || !lineage || lineage.includes(null) || o.depth === null) return null;
  }
  return o;
}

function buildHeld(seed, line, job, origin, host) {
  const s = seed || {}, h = host || {}, st = line && line.holdState, hold = line && line.hold;
  if (!st || !hold || !st.walk) return refuse('the walk left no state to save at the gate');
  if (!job || !JOB_ID.test(String(job.id || ''))) return refuse('the job has no saved record to hold the work on');
  if (!origin) return refuse('the way this job came in cannot be named for a saved hold');
  const open = st.open || {};
  if (open.pending || open.forced || open.fan || open.barriers || open.branchMode) return refuse('the gate sits inside a split that is still running, and a hold inside a split is not saved yet');
  if (open.joined) return refuse('the held work is the crate a joiner merged, and a hold after a join is not saved yet');
  if (!/^[a-f0-9]{8}$/.test(String(h.planHash))) return refuse('the floor plan has no hash to bind the hold to');
  const attempts = Array.isArray(st.attempts) ? st.attempts : [];
  if (!attempts.length || attempts.some(a => !a || !KEY.test(String(a.runId || '')))) return refuse('a stage the work went through left no run receipt, so its spend cannot be saved exactly');

  // every file the work carries gets an exact receipt (digest and size) on a run THIS job paid for (a file handed in from another job rides
  // on the entry run: chain.js snapshot); one that cannot be read exactly is a refusal
  const receipts = new Map(), receiptList = [];
  for (const f of Array.isArray(st.files) ? st.files : []) {
    if (!f.producerRunId) return refuse('a file the work carries has no run to hold its receipt');
    let got = null;
    try { got = typeof h.receiptFor === 'function' ? h.receiptFor({ path: f.path, projectRoot: f.projectRoot, producerRunId: f.producerRunId }) : null; }
    catch (e) { return refuse('a file the work carries cannot be read (' + clip((e && e.message) || e, 120) + ')'); }
    if (!got || !text(got.path) || !text(got.projectRoot) || !HASH.test(String(got.digest)) || !Number.isSafeInteger(got.size) || got.size < 0) return refuse('a file the work carries cannot be read');
    const r = { ref: '', path: got.path, producerRunId: f.producerRunId, projectRoot: got.projectRoot, digest: got.digest, size: got.size };
    r.ref = Continuation.fileRef(r);
    receipts.set(f.path, r); receiptList.push(r);
  }
  const refsOf = paths => paths.map(p => receipts.get(p) && receipts.get(p).ref);
  const taints = (Array.isArray(s.taints) ? s.taints : []).filter(t => typeof t === 'string' && t).map(t => t.slice(0, 160)).slice(0, 32);
  const product = p => ({ text: p.text, draft: p.draft, verdict: p.verdict, files: refsOf(p.files), producer: p.producer, taints: taints.slice() });
  const w = st.walk, g = st.gate || {};
  const walkProduct = product(w.product), entryOutput = product(w.entryOutput);
  if (walkProduct.files.concat(entryOutput.files).some(r => !r)) return refuse('a file the work carries has no receipt');

  const saved = attempts.map((a, i) => ({ ordinal: i + 1, runId: a.runId, node: a.node, branchId: a.branchId, workitemId: a.workitemId, state: 'observed',
    inputDigest: a.inputDigest, outputDigest: a.outputDigest, usd: a.usd, usageMissing: false, outcome: a.outcome, at: a.at, endedAt: a.endedAt }));
  const entryRunId = st.entry && st.entry.runId, sum = xs => xs.reduce((n, x) => n + x.usd, 0);
  // the spend is exactly the sum of the receipts above (the validator re-adds them); the legacy day ledger already counted every cent, so
  // dayReceipts stays empty and this hold notes nothing again
  const accounting = { entryUsd: sum(saved.filter(a => a.runId === entryRunId)), hopUsd: sum(saved.filter(a => a.runId !== entryRunId)),
    runIds: saved.map(a => a.runId), dayReceipts: [], limits: st.limits };
  const allowed = ['approve'].concat(g.backTo && hold.pass < g.max ? ['send_back'] : [], ['stop']);   // a gate with no back lane, or no pass left, cannot send the work round again
  const c = {
    version: 1, revision: 1, phase: 'held',
    binding: { jobId: job.id, lineId: job.line, intakeId: job.intakeId || null, streamId: job.streamId, entryRunId, planHash: h.planHash,
      dockMode: !!(st.entry && st.entry.dockMode), entryNode: st.entry && st.entry.node },
    origin,
    restriction: { entryUntrusted: !st.restriction || st.restriction.entryUntrusted !== false, hostPowerWithheld: !st.restriction || st.restriction.hostPowerWithheld !== false, taints },
    walk: { current: w.current, next: w.next, product: walkProduct, originalText: w.originalText, lastHanded: w.lastHanded, producerVerdict: w.producerVerdict,
      hop: w.hop, loopHops: w.loopHops, visited: w.visited, gates: w.gates, openLoops: w.openLoops, fromTile: w.fromTile, via: w.via, entryOutput,
      branchMode: false, pending: [], forced: null, fan: null, partial: w.partial, unapproved: w.unapproved },
    barriers: [], accounting, attempts: saved, files: receiptList,
    hold: { gateId: String(hold.gateId), reason: hold.reason, why: clip(hold.why, 400), pass: hold.pass, allowed },
    decisions: [], activeDecision: null, terminal: null, publication: null
  };
  try { Continuation.demand(c, job); }   // the existing validator accepts it exactly as it will be read back, or nothing is written
  catch (e) { return refuse(((e && e.message) || 'the saved hold is not valid') + (e && e.code ? ' [' + String(e.code).replace(/^ELINE_CONTINUATION_/, '').toLowerCase() + ']' : '')); }
  return { ok: true, continuation: c };
}

/* The sentence a job that COULD NOT be held ends with (line-runner.js): the old terminal blocked stop, now saying why it was not parked. */
function notHeld(why) { return 'it could not be saved as a hold (' + clip(why, 150).replace(/[.\s]+$/, '') + '), so the job ends here'; }

module.exports = { buildHeld, originOf, notHeld };
