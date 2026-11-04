/* Versioned, host-authored continuation data for the existing LineJob owner.
   Pure validation/transitions only: no IO, clock, provider, authority grant or resume executor.
   Invalid/future data is retained opaquely. It must never become an executable partial walk. */
'use strict';
const crypto = require('node:crypto');
const RunOutcome = require('../../frontend/app/runoutcome.js');
const MAX_BYTES = 2 * 1024 * 1024, MAX_DEPTH = 16, MAX_ATTEMPTS = 1024, MAX_PARTS = 512, MAX_FILES = 64;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const text = x => typeof x === 'string';
const key = x => text(x) && /^[A-Za-z0-9_.:-]{1,120}$/.test(x);
const jobId = x => text(x) && /^job-[a-z0-9]{8,24}$/.test(x);
const tile = x => key(x) || (text(x) && /^-?\d+,-?\d+$/.test(x) && x.split(',').every(v => Number.isSafeInteger(Number(v))));
const hash = x => text(x) && /^[a-f0-9]{64}$/.test(x);
const uint = x => Number.isSafeInteger(x) && x >= 0;
const usd = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
const bool = x => typeof x === 'boolean';
const nullable = f => x => x === null || f(x);
const list = (f, max) => x => Array.isArray(x) && x.length <= max && x.every(f);
const oneOf = values => x => values.includes(x);
const record = (x, fields) => plain(x) && Object.keys(x).length === Object.keys(fields).length
  && Object.keys(fields).every(k => own(x, k) && fields[k](x[k]));
const unique = xs => new Set(xs).size === xs.length;
const node = x => record(x, { agentId: key, dockId: nullable(key) });
const point = x => record(x, { x: Number.isSafeInteger, y: Number.isSafeInteger });
const nodeId = x => x.dockId || x.agentId;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const problem = (code, message) => ({ code, message });
const DECISION_WRITE = Symbol('line decision receipt');

/* First capture JSON without invoking getters/toJSON or assigning prototype keys. The
   wider raw-depth bound is only a preservation guard: executable v1 remains depth16.
   Anything that cannot be captured losslessly stays by reference and makes the containing
   store read-only until its existing owner can resolve it. No stringify-and-truncate. */
function capture(raw) {
  let bytes = 0, depth = 0;
  const seen = new Set();
  function take(v, d) {
    depth = Math.max(depth, d);
    if (d > 128) throw problem('raw_depth', 'saved continuation is too deep to rewrite safely');
    if (v === null || bool(v)) { bytes += v === null ? 4 : v ? 4 : 5; return v; }
    if (text(v)) { bytes += Buffer.byteLength(JSON.stringify(v)); if (bytes > MAX_BYTES) throw problem('oversized', 'saved continuation exceeds the executable size bound'); return v; }
    if (typeof v === 'number' && Number.isFinite(v)) { bytes += String(v).length; return v; }
    if (!Array.isArray(v) && !plain(v)) throw problem('not_json', 'saved continuation is not plain JSON');
    if (Object.getOwnPropertySymbols(v).length) throw problem('not_json', 'saved continuation contains symbol fields');
    if (seen.has(v)) throw problem('not_json', 'saved continuation contains a cycle');
    seen.add(v);
    const a = Array.isArray(v), out = a ? [] : Object.create(null), descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = a ? Object.keys(descriptors).filter(k => k !== 'length') : Object.keys(descriptors);
    if (a && (keys.length !== v.length || keys.some((k, i) => k !== String(i)))) throw problem('not_json', 'saved continuation has non-JSON array properties');
    bytes += 2;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], desc = descriptors[k];
      if (!own(desc, 'value') || !desc.enumerable) throw problem('not_json', 'saved continuation contains an accessor or hidden field');
      bytes += (i ? 1 : 0) + (a ? 0 : Buffer.byteLength(JSON.stringify(k)) + 1);
      if (bytes > MAX_BYTES) throw problem('oversized', 'saved continuation exceeds the executable size bound');
      Object.defineProperty(out, k, { value: take(desc.value, d + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(v);
    return out;
  }
  try {
    const value = take(raw, 1);
    if (bytes > MAX_BYTES) throw problem('oversized', 'saved continuation exceeds the executable size bound');
    return { value, bytes, depth, readOnly: false };
  } catch (issue) {
    return { value: raw, bytes: null, depth, readOnly: true,
      issue: issue && issue.code ? issue : problem('not_json', 'saved continuation cannot be captured losslessly') };
  }
}

const taints = list(x => text(x) && x.length > 0 && x.length <= 160, 32);
const reference = x => text(x) && x.length > 0 && !x.includes('\0');
const filePath = reference; // full envelope is bounded; filesystem authority belongs to the host's existing path owner
// References name an exact producer/path/content receipt, not merely a mutable path.
const files = list(hash, MAX_FILES);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileRef = f => digest([f.producerRunId, f.path, f.projectRoot, f.digest, f.size]);
const heldDigest = c => digest([c.binding, c.origin, c.restriction, c.walk, c.barriers, c.accounting, c.attempts, c.files, c.hold]);
const producer = x => record(x, { kind: x => x === 'run', runId: key })
  || (record(x, { kind: x => x === 'join', joinId: tile, runIds: list(key, MAX_ATTEMPTS) }) && x.runIds.length > 0 && unique(x.runIds));
const product = x => record(x, { text, draft: text, verdict: nullable(oneOf(['approved', 'revise', 'blocked'])), files, producer, taints });
const transition = x => record(x, { kind: oneOf(['dock', 'gate', 'join', 'outbox', 'terminal']), node: nullable(node),
  gateId: nullable(tile), joinId: nullable(tile), outboxId: nullable(key), fromTile: nullable(point), via: nullable(x => x === 'back') })
  && (x.kind !== 'dock' || x.node !== null) && (x.kind !== 'gate' || x.gateId !== null)
  && (x.kind !== 'join' || x.joinId !== null) && (x.kind !== 'outbox' || x.outboxId !== null);
const part = x => record(x, { text, i: uint, k: uint }) && x.k > 0 && x.i < x.k;
const branch = x => record(x, { id: key, node, from: nullable(node), product, entry: bool, part: nullable(part) });
const gate = x => record(x, { id: tile, count: uint, max: uint }) && x.max <= 20 && x.count <= x.max;
const attempt = x => record(x, { ordinal: uint, runId: key, node, branchId: nullable(key), workitemId: key,
  state: oneOf(['intent', 'observed', 'uncertain']), inputDigest: hash, outputDigest: nullable(hash),
  usd: nullable(usd), usageMissing: bool, outcome: nullable(RunOutcome.isOutcome), at: uint, endedAt: nullable(uint) })
  && x.ordinal > 0 && (x.endedAt === null || x.endedAt >= x.at)
  && (x.state !== 'observed' || (x.usd !== null && x.outcome !== null && x.outputDigest !== null && x.endedAt !== null));
const holdRecord = x => record(x, { gateId: tile, reason: oneOf(['blocked', 'missing_verdict', 'spent']),
  why: x => text(x) && x.length > 0 && x.length <= 400, pass: uint,
  allowed: list(oneOf(['approve', 'send_back', 'stop']), 3) }) && unique(x.allowed) && x.allowed.includes('stop');
const decision = x => record(x, { token: key, revision: uint, fingerprint: hash, action: oneOf(['approve', 'send_back', 'stop']),
  note: x => text(x) && x.length <= 2000, at: uint, state: oneOf(['accepted', 'adopted', 'complete', 'refused']),
  hold: holdRecord, workDigest: hash }) && x.revision > 0 && x.hold.allowed.includes(x.action);
const originFields = {
  channel: { kind: x => x === 'channel', instanceId: reference, chatId: reference, senderId: reference, chatType: reference,
    threadId: nullable(reference), boundAgentId: nullable(key) },
  schedule: { kind: x => x === 'schedule', routineId: reference, fireRunId: key, policyDigest: hash },
  manual: { kind: x => x === 'manual', routineId: reference, fireRunId: key, policyDigest: hash },
  trigger: { kind: x => x === 'trigger', triggerId: reference, triggerKind: oneOf(['webhook', 'folder']),
    reservationId: nullable(hash), fingerprint: nullable(hash), sourceDigest: nullable(hash) },
  sample: { kind: x => x === 'sample' },
  sendto: { kind: x => x === 'sendto', sourceJobId: jobId, sourceLineId: key, sourceOutboxId: key,
    targetIntakeId: key, lineage: list(key, MAX_PARTS), depth: uint },
  steptest: { kind: x => x === 'steptest', sessionId: reference, sessionRevision: uint, edited: bool }
};
const origin = x => plain(x) && own(originFields, x.kind) && record(x, originFields[x.kind])
  && (x.kind !== 'trigger' || (x.triggerKind === 'webhook'
    ? x.reservationId !== null && x.fingerprint !== null : x.sourceDigest !== null));
const restriction = x => record(x, { entryUntrusted: bool, hostPowerWithheld: bool, taints });
const limits = x => record(x, { maxHops: x => uint(x) && x <= 24, maxUsd: usd, maxUsdPerDay: nullable(usd) });
const fileReceipt = f => record(f, { ref: hash, path: filePath, producerRunId: key, projectRoot: filePath, digest: hash, size: uint }) && f.ref === fileRef(f);
function barrier(x) {
  if (!record(x, { joinId: tile, entryRunId: key, branchIds: list(key, MAX_PARTS),
    parts: list(p => record(p, { branchId: key, runId: key, workitemId: key, product }), MAX_PARTS),
    failed: list(key, MAX_PARTS), pending: list(key, MAX_PARTS), inFlight: list(key, MAX_PARTS), at: uint, timeoutMs: uint })) return false;
  const members = x.parts.map(p => p.branchId).concat(x.failed, x.pending, x.inFlight);
  return unique(x.branchIds) && unique(members) && members.length === x.branchIds.length
    && members.every(id => x.branchIds.includes(id));
}

function invalid(v, job, depth) {
  if (!plain(v) || v.version !== 1) return problem('unsupported_version', 'saved continuation version is not supported');
  if (depth > MAX_DEPTH) return problem('depth', 'saved continuation exceeds executable nesting depth');
  const binding = x => record(x, { jobId, lineId: key, intakeId: nullable(key), streamId: x => x === '' || key(x), entryRunId: key,
    planHash: x => text(x) && /^[a-f0-9]{8}$/.test(x), dockMode: bool, entryNode: node });
  const walk = x => record(x, { current: node, next: nullable(transition), product, originalText: text,
    lastHanded: text, producerVerdict: nullable(oneOf(['approved', 'revise', 'blocked'])),
    hop: uint, loopHops: uint, visited: list(key, MAX_PARTS), gates: list(gate, MAX_PARTS), openLoops: list(tile, MAX_PARTS),
    fromTile: nullable(point), via: nullable(x => x === 'back'), entryOutput: product, branchMode: bool,
    pending: list(branch, MAX_PARTS), forced: nullable(branch),
    fan: nullable(f => record(f, { branchIds: list(key, MAX_PARTS), width: uint,
      failed: list(p => record(p, { branchId: key, why: text }), MAX_PARTS),
      joinKey: nullable(reference), joinStep: nullable(s => record(s, { join: tile, expect: uint,
        timeoutMin: x => uint(x) && x >= 1 && x <= 120, next: nullable(node) })), handed: text })),
    partial: nullable(text), unapproved: nullable(text) });
  const accounting = x => record(x, { entryUsd: usd, hopUsd: usd, runIds: list(key, MAX_ATTEMPTS),
    dayReceipts: list(r => record(r, { runId: key, day: uint, usd }), MAX_ATTEMPTS),
    limits });
  if (!record(v, { version: x => x === 1, revision: x => uint(x) && x > 0,
    phase: oneOf(['ready', 'held', 'intent', 'uncertain', 'terminal_pending', 'complete']), binding, origin,
    restriction,
    walk, barriers: list(barrier, MAX_PARTS), accounting, attempts: list(attempt, MAX_ATTEMPTS),
    files: list(fileReceipt, MAX_FILES),
    hold: nullable(holdRecord), decisions: list(decision, MAX_ATTEMPTS), activeDecision: nullable(key),
    terminal: nullable(t => record(t, { outcome: oneOf(RunOutcome.LINE_OUTCOMES), output: text, usd,
      runIds: list(key, MAX_ATTEMPTS), stop: nullable(s => record(s, { code: RunOutcome.isLineStop,
        why: x => text(x) && x.length > 0 && x.length <= 400, agentId: nullable(key), dockId: nullable(key) })) })),
    publication: nullable(p => record(p, { outboxId: key, entryRunId: key, terminalRunId: key,
      state: oneOf(['pending', 'confirmed', 'uncertain', 'suppressed']), shipmentId: nullable(key), sentToJobId: nullable(jobId) })) })) {
    return problem('schema', 'saved continuation is incomplete or contains unsupported fields');
  }
  const b = v.binding, w = v.walk, a = v.accounting;
  if (job && (b.jobId !== job.id || b.lineId !== job.line || b.intakeId !== (job.intakeId || null) || b.streamId !== job.streamId || v.origin.kind !== job.entry)) {
    return problem('binding', 'saved continuation does not belong to this exact job and admission');
  }
  if (!unique(w.visited) || !unique(w.gates.map(g => g.id)) || !unique(w.openLoops) || w.openLoops.some(id => !w.gates.some(g => g.id === id))
    || w.loopHops > w.hop || w.hop > 400 || !w.visited.includes(nodeId(b.entryNode))) return problem('walk', 'saved walk counters or membership are inconsistent');
  const branches = w.pending.concat(w.forced ? [w.forced] : []);
  if (!unique(branches.map(p => p.id)) || (w.fan && (!unique(w.fan.branchIds) || !unique(w.fan.failed.map(p => p.branchId))
    || w.fan.width !== w.fan.branchIds.length || w.fan.failed.some(p => !w.fan.branchIds.includes(p.branchId))
    || branches.some(p => !w.fan.branchIds.includes(p.id))
    || ((w.fan.joinKey === null) !== (w.fan.joinStep === null))
    || (w.fan.joinStep && w.fan.joinKey !== w.fan.joinStep.join + '|' + b.entryRunId)))) {
    return problem('branches', 'saved branch membership is inconsistent');
  }
  const partCount = w.visited.length + w.gates.length + branches.length
    + v.barriers.reduce((n, x) => n + 1 + x.branchIds.length, 0);
  if (partCount > MAX_PARTS || !unique(v.barriers.map(x => x.joinId)) || v.barriers.some(x => x.entryRunId !== b.entryRunId)) {
    return problem('barriers', 'saved barrier membership exceeds its bound or belongs to another entry');
  }
  if (!unique(v.attempts.map(x => x.runId)) || !v.attempts.every((x, i) => x.ordinal === i + 1)
    || !unique(a.runIds) || a.runIds.some(id => !v.attempts.some(x => x.runId === id && x.state === 'observed'))
    || v.attempts.some(x => x.state === 'observed' && !a.runIds.includes(x.runId))) return problem('attempts', 'saved paid-run receipts are incomplete or duplicated');
  const observed = v.attempts.filter(x => x.state === 'observed');
  if (!observed.some(x => x.runId === b.entryRunId) || a.entryUsd !== observed.filter(x => x.runId === b.entryRunId).reduce((n, x) => n + x.usd, 0)
    || a.hopUsd !== observed.filter(x => x.runId !== b.entryRunId).reduce((n, x) => n + x.usd, 0)
    || !unique(a.dayReceipts.map(x => x.runId)) || a.dayReceipts.some(r => !observed.some(x => x.runId === r.runId && x.usd === r.usd && r.day === Math.floor(x.endedAt / 86400000)))) {
    return problem('accounting', 'saved spend does not match its exact observed run receipts');
  }
  if (v.barriers.some(x => x.parts.some(p => !observed.some(a => a.runId === p.runId && a.branchId === p.branchId)
    || p.product.producer.kind !== 'run' || p.product.producer.runId !== p.runId))) return problem('barrier_receipt', 'saved barrier part is not its exact observed branch run');
  if ((v.phase === 'held') !== (v.hold !== null) || (v.hold && (!w.gates.some(g => g.id === v.hold.gateId && g.count === v.hold.pass)
    || v.attempts.some(x => x.state !== 'observed')))) return problem('hold', 'held work lacks a complete gate checkpoint');
  if ((v.phase === 'intent' || v.phase === 'uncertain') !== v.attempts.some(x => x.state !== 'observed')) return problem('intent', 'saved phase and unresolved attempts disagree');
  if (!unique(v.files.map(f => f.ref)) || v.files.some(f => !observed.some(x => x.runId === f.producerRunId))) return problem('files', 'saved files lack exact producer receipts');
  const products = [w.product, w.entryOutput].concat(branches.map(x => x.product), ...v.barriers.map(x => x.parts.map(p => p.product)));
  if (products.some(p => (p.producer.kind === 'run' ? !observed.some(x => x.runId === p.producer.runId)
    : p.producer.runIds.some(id => !observed.some(x => x.runId === id))) || !unique(p.files)
    || p.files.some(ref => !v.files.some(f => f.ref === ref)))) return problem('product', 'saved work or files lack producer provenance');
  if (!unique(v.decisions.map(x => x.token)) || v.decisions.some(x => x.revision >= v.revision)
    || v.decisions.some(x => x.fingerprint !== digest([b.jobId, x.revision, x.action, x.note]))
    || v.decisions.some(x => (x.state === 'accepted' || x.state === 'adopted') && x.token !== v.activeDecision)
    || (v.activeDecision !== null && !v.decisions.some(x => x.token === v.activeDecision && (x.state === 'accepted' || x.state === 'adopted')))) {
    return problem('decision', 'saved decision does not name its exact checkpoint');
  }
  if (v.phase === 'held' && v.activeDecision !== null) {
    const accepted = v.decisions.find(x => x.token === v.activeDecision);
    if (accepted.state !== 'accepted' || accepted.workDigest !== heldDigest(v) || !same(accepted.hold, v.hold)) return problem('decision_work', 'accepted decision no longer names the exact held work');
  }
  if (v.publication && (v.publication.entryRunId !== b.entryRunId || !observed.some(x => x.runId === v.publication.terminalRunId))) {
    return problem('publication', 'saved publication lacks the job terminal-run receipt');
  }
  if ((v.phase === 'terminal_pending' || v.phase === 'complete') !== (v.terminal !== null)) return problem('terminal', 'saved terminal phase lacks its accepted result');
  if (v.terminal && (v.terminal.outcome !== RunOutcome.lineOutcomeOf(v.terminal.stop && v.terminal.stop.code)
    || !same(v.terminal.runIds, a.runIds) || v.terminal.usd !== a.entryUsd + a.hopUsd
    || (v.terminal.outcome === 'delivered' && !v.publication))) return problem('terminal', 'saved terminal result disagrees with the existing outcome/run authority');
  if (v.publication && (!v.terminal || (v.publication.state === 'suppressed'
    ? !v.terminal.stop || !['stopped', 'station_fault'].includes(v.terminal.stop.code)
    : v.terminal.outcome !== 'delivered'))) return problem('publication', 'saved publication is neither a delivered result nor an owned stop suppression');
  if (v.phase === 'complete' && (v.activeDecision !== null || v.decisions.some(x => x.state === 'accepted' || x.state === 'adopted')
    || (v.publication && !['confirmed', 'suppressed'].includes(v.publication.state)))) return problem('complete', 'completed continuation has unsettled receipts');
  return null;
}

function inspect(raw, job) {
  const c = capture(raw);
  const issue = c.issue || invalid(c.value, job, c.depth);
  return Object.assign(c, { ok: !issue, issue });
}
function demand(raw, job) {
  const r = inspect(raw, job);
  if (!r.ok) { const e = new Error(r.issue.message); e.code = 'ELINE_CONTINUATION_' + r.issue.code.toUpperCase(); throw e; }
  return r.value;
}
/* A refused decision keeps a receipt, but only the newest MAX_REFUSED stay: a person who is refused again and again (a UI or a script retrying
   APPROVE with a new token) must never fill the receipt list, because a full list could not take the STOP that is never refused. */
const MAX_REFUSED = 16;
const droppedDecisions = (before, after) => before.decisions.filter(d => !after.decisions.some(x => x.token === d.token));
function checkpoint(raw, job, expectedRevision, next, decisionWrite) {
  const before = raw === undefined ? null : demand(raw, job), after = demand(next, job);
  if (!uint(expectedRevision) || (before ? before.revision : 0) !== expectedRevision || after.revision !== expectedRevision + 1) throw new Error('line continuation revision conflict');
  if (before) {
    const allowed = { ready: ['ready', 'held', 'intent', 'terminal_pending'], held: ['held', 'ready', 'terminal_pending'],
      intent: ['intent', 'uncertain', 'ready', 'held', 'terminal_pending'], uncertain: ['uncertain', 'ready', 'held', 'terminal_pending'],
      terminal_pending: ['terminal_pending', 'complete'], complete: [] };
    if (!allowed[before.phase].includes(after.phase)) throw new Error('line continuation phase cannot advance that way');
    for (const k of ['binding', 'origin', 'restriction']) if (!same(before[k], after[k])) throw new Error('line continuation admission cannot change');
    for (const k of ['maxHops', 'maxUsd', 'maxUsdPerDay']) if (before.accounting.limits[k] !== after.accounting.limits[k]) throw new Error('line continuation original spending ceilings cannot change');
    if (!same(before.walk.originalText, after.walk.originalText) || !same(before.walk.entryOutput, after.walk.entryOutput)) throw new Error('line continuation cannot replace its entry work');
    if (after.attempts.length < before.attempts.length || droppedDecisions(before, after).some(d => d.state !== 'refused' || decisionWrite !== DECISION_WRITE)) throw new Error('line continuation cannot discard receipts');
    if (after.attempts.slice(before.attempts.length).some(a => a.state !== 'intent')) throw new Error('a new paid attempt needs its durable intent first');
    if (after.decisions.length !== before.decisions.length - droppedDecisions(before, after).length && decisionWrite !== DECISION_WRITE) throw new Error('line decision receipts belong to claimDecision');
    for (let i = 0; i < before.attempts.length; i++) {
      const a = before.attempts[i], b = after.attempts[i];
      if (a.state === 'observed' ? !same(a, b) : ['ordinal', 'runId', 'node', 'branchId', 'workitemId', 'inputDigest', 'at'].some(k => !same(a[k], b[k]))) throw new Error('line continuation cannot replace a paid attempt');
      if (a.usd !== null && (b.usd === null || b.usd < a.usd)) throw new Error('line continuation cannot erase an observed spend floor');
    }
    for (const a of before.decisions) {
      const b = after.decisions.find(x => x.token === a.token);
      if (!b) continue; // only a refused receipt may be compacted away (checked above)
      if (Object.keys(a).filter(k => k !== 'state').some(k => !same(a[k], b[k]))
        || (['complete', 'refused'].includes(a.state) && a.state !== b.state)
        || (a.state === 'adopted' && b.state === 'accepted')) throw new Error('line continuation cannot replace a decision receipt');
    }
    if (after.walk.hop < before.walk.hop || after.walk.loopHops < before.walk.loopHops || before.walk.visited.some(k => !after.walk.visited.includes(k))
      || before.walk.gates.some(g => !after.walk.gates.some(n => n.id === g.id && n.max === g.max && n.count >= g.count))) throw new Error('line continuation cannot reset walk counters');
    if (before.phase === 'complete') throw new Error('line continuation is already complete');
    if (before.phase === 'held' && !same(before.attempts, after.attempts)) throw new Error('held work cannot buy or substitute another attempt');
    const ownedStop = after.terminal && after.terminal.stop && ['stopped', 'station_fault'].includes(after.terminal.stop.code);
    if (before.phase === 'held' && (after.phase === 'ready' || (after.phase === 'terminal_pending' && !ownedStop))) {
      const accepted = before.decisions.find(x => x.token === before.activeDecision && x.state === 'accepted'
        && (after.phase === 'ready' ? x.action !== 'stop' : x.action === 'approve'));
      if (!accepted || after.activeDecision !== accepted.token || !after.decisions.some(x => x.token === accepted.token && x.state === 'adopted')) throw new Error('line continuation has no adopted human decision');
      if (accepted.workDigest !== heldDigest(before) || !same(accepted.hold, before.hold)) throw new Error('line decision does not bind this held checkpoint');
      if (accepted.action === 'approve' && (!same(before.walk.product, after.walk.product) || before.walk.lastHanded !== after.walk.lastHanded)) throw new Error('approval cannot substitute another saved draft');
    }
    if (before.files.some(f => !after.files.some(n => same(n, f))) || before.accounting.dayReceipts.some(r => !after.accounting.dayReceipts.some(n => same(n, r)))) throw new Error('line continuation cannot discard file or spend receipts');
    if (before.terminal && !same(before.terminal, after.terminal)) {
      const rank = t => t && t.stop && (t.stop.code === 'station_fault' ? 2 : t.stop.code === 'stopped' ? 1 : 0);
      if ((job && job.endedAt != null) || (before.publication && before.publication.state === 'confirmed')
        || !after.terminal || rank(after.terminal) <= rank(before.terminal)
        || ['output', 'usd', 'runIds'].some(k => !same(before.terminal[k], after.terminal[k]))) throw new Error('line continuation cannot replace its pending result except for an owned STOP/fault');
    }
    if (before.publication) {
      const a = before.publication, b = after.publication;
      const states = { pending: ['pending', 'uncertain', 'confirmed', 'suppressed'], uncertain: ['uncertain', 'confirmed', 'suppressed'], confirmed: ['confirmed'], suppressed: ['suppressed'] };
      if (!b || ['outboxId', 'entryRunId', 'terminalRunId'].some(k => a[k] !== b[k]) || !states[a.state].includes(b.state)
        || ['shipmentId', 'sentToJobId'].some(k => a[k] !== null ? a[k] !== b[k] : b[k] !== null && b.state !== 'confirmed')) throw new Error('line continuation cannot replace or rewind publication receipts');
    }
  }
  return after;
}
function claimDecision(raw, job, request) {
  const before = demand(raw, job), r = request || {};
  if (!record(r, { token: key, revision: uint, action: oneOf(['approve', 'send_back', 'stop']), note: x => text(x) && x.length <= 2000, at: uint })) throw new Error('invalid line decision');
  const fingerprint = digest([job.id, r.revision, r.action, r.note]);
  const prior = before.decisions.find(d => d.token === r.token);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error('line decision token conflict');
    return { continuation: before, receipt: prior, replayed: true };
  }
  if (r.revision !== before.revision || before.phase !== 'held' || before.activeDecision !== null || !before.hold.allowed.includes(r.action)) throw new Error('line decision cannot claim this checkpoint');
  const receipt = { token: r.token, revision: r.revision, fingerprint, action: r.action, note: r.note, at: r.at, state: 'accepted',
    hold: before.hold, workDigest: heldDigest(before) };
  const next = Object.assign({}, before, { revision: before.revision + 1, decisions: before.decisions.concat(receipt), activeDecision: r.token });
  return { continuation: checkpoint(before, job, before.revision, next, DECISION_WRITE), receipt, replayed: false };
}
/* Mark the claimed decision refused (the job stays held at the same gate) and drop all but the newest MAX_REFUSED refused receipts. */
function refuseDecision(raw, job, token) {
  const before = demand(raw, job);
  const marked = before.decisions.map(x => x.token === token ? Object.assign({}, x, { state: 'refused' }) : x);
  let extra = marked.filter(x => x.state === 'refused').length - MAX_REFUSED;
  const decisions = marked.filter(x => !(x.state === 'refused' && x.token !== token && extra-- > 0));
  const next = Object.assign({}, before, { revision: before.revision + 1, activeDecision: null, decisions });
  return checkpoint(before, job, before.revision, next, DECISION_WRITE);
}
/* Private pre-entry receipts use the same bounded data vocabulary. They carry no
   execution permission: even a replayed intent must be reconciled by its eventual
   host adapter, and an observed result with usageMissing has unresolved cost. */
const entryInputDigest = input => digest([input.text, input.fileRefs]);
const entryOutputDigest = p => digest([p.text, p.draft, p.verdict, p.files, [p.producer.kind, p.producer.runId], p.taints]);
function canonicalEntryFact(x) {
  if (Array.isArray(x)) return x.map(canonicalEntryFact);
  if (!plain(x)) return x;
  const out = Object.create(null);
  for (const k of Object.keys(x).sort()) Object.defineProperty(out, k, { value: canonicalEntryFact(x[k]), enumerable: true });
  return out;
}
const sameEntryFact = (a, b) => same(canonicalEntryFact(a), canonicalEntryFact(b));
const ENTRY_IDENTITY = ['ledgerId', 'binding', 'origin', 'restriction', 'input', 'inputDigest', 'files', 'limits', 'at'];
const uniqueEntryFiles = rows => unique(rows.map(f => f.ref))
  && unique(rows.map(f => JSON.stringify([f.producerRunId, f.projectRoot, f.path])));
function invalidEntry(v, job, depth) {
  if (!plain(v) || v.version !== 1) return problem('unsupported_version', 'saved entry receipt version is not supported');
  if (depth > MAX_DEPTH) return problem('depth', 'saved entry receipt exceeds executable nesting depth');
  const binding = b => record(b, { jobId, lineId: key, intakeId: nullable(key), streamId: x => x === '' || key(x),
    entryRunId: key, workitemId: key, entryNode: node, planHash: x => text(x) && /^[a-f0-9]{8}$/.test(x) });
  const observation = o => record(o, { endedAt: uint, usd, usageMissing: bool, outcome: RunOutcome.isOutcome,
    product, files: list(fileReceipt, MAX_FILES), outputDigest: hash });
  if (!record(v, { version: x => x === 1, revision: x => uint(x) && x > 0,
    state: oneOf(['intent', 'uncertain', 'observed']), ledgerId: key, binding, origin, restriction,
    input: x => record(x, { text, fileRefs: files }), inputDigest: hash, files: list(fileReceipt, MAX_FILES), limits,
    at: uint, observation: nullable(observation) })) return problem('shape', 'saved entry receipt fields are invalid');
  const b = v.binding, o = v.observation;
  if (job && (b.jobId !== job.id || b.lineId !== job.line || b.intakeId !== (job.intakeId || null)
    || b.streamId !== job.streamId || v.origin.kind !== job.entry)) return problem('binding', 'saved entry receipt does not belong to this job and admission');
  if ((v.state === 'observed') !== (o !== null)) return problem('observation', 'saved entry state and observed result disagree');
  if (v.inputDigest !== entryInputDigest(v.input) || !unique(v.input.fileRefs)
    || !uniqueEntryFiles(v.files) || v.files.length !== v.input.fileRefs.length
    || v.input.fileRefs.some(ref => !v.files.some(f => f.ref === ref))) return problem('input', 'saved entry input has no exact content/file receipt');
  if (o) {
    const allFiles = v.files.concat(o.files), refs = allFiles.map(f => f.ref);
    if (o.endedAt < v.at || o.product.producer.kind !== 'run' || o.product.producer.runId !== b.entryRunId
      || o.outputDigest !== entryOutputDigest(o.product)) return problem('observation', 'saved entry result does not name its exact run, output and time');
    if (allFiles.length > MAX_FILES || !uniqueEntryFiles(allFiles) || !unique(o.product.files)
      || o.files.some(f => f.producerRunId !== b.entryRunId) || o.product.files.some(ref => !refs.includes(ref))) return problem('files', 'saved entry result lacks exact producer/file receipts');
    if (v.restriction.taints.some(t => !o.product.taints.includes(t))) return problem('taint', 'saved entry result cannot discard restrictive source taint');
  }
  return null;
}
function inspectEntry(raw, job) {
  const c = capture(raw), issue = c.issue || invalidEntry(c.value, job, c.depth);
  return Object.assign(c, { ok: !issue, issue });
}
function demandEntry(raw, job) {
  const r = inspectEntry(raw, job);
  if (!r.ok) { const e = new Error(r.issue.message); e.code = 'ELINE_ENTRY_' + r.issue.code.toUpperCase(); throw e; }
  return r.value;
}
function prepareEntry(raw, job, request) {
  const intent = demandEntry(request, job);
  if (intent.revision !== 1 || intent.state !== 'intent') throw new Error('line entry preparation requires its original intent');
  if (raw === undefined) return { receipt: intent, replayed: false };
  const prior = demandEntry(raw, job);
  if (ENTRY_IDENTITY.some(k => !sameEntryFact(prior[k], intent[k]))) throw new Error('line entry preparation conflicts with its original identity or input');
  return { receipt: prior, replayed: true }; // no reset and no dispatch permission
}
function checkpointEntry(raw, job, expectedRevision, next) {
  const before = demandEntry(raw, job), after = demandEntry(next, job);
  if (!uint(expectedRevision) || expectedRevision < 1 || !Number.isSafeInteger(expectedRevision + 1)
    || after.revision !== expectedRevision + 1) throw new Error('line entry revision conflict');
  if (before.revision === after.revision && sameEntryFact(before, after)) return { receipt: before, replayed: true };
  if (before.revision !== expectedRevision) throw new Error('line entry revision conflict');
  if (ENTRY_IDENTITY.some(k => !sameEntryFact(before[k], after[k]))) throw new Error('line entry cannot replace original identity, input or ceilings');
  const allowed = { intent: ['uncertain', 'observed'], uncertain: ['observed'], observed: [] };
  if (!allowed[before.state].includes(after.state)) throw new Error('line entry state cannot advance that way');
  return { receipt: after, replayed: false };
}
function adoptableEntry(raw, job) {
  const e = demandEntry(raw, job), o = e.observation;
  if (e.state !== 'observed' || !o || o.usageMissing || o.outcome !== 'succeeded'
    || e.files.length || o.files.length || o.product.files.length || !e.binding.entryNode.dockId) {
    throw new Error('line entry adoption requires complete successful text-only evidence at its exact dock');
  }
  return e;
}
function entryAttempt(e) {
  const o = e.observation;
  return { ordinal: 1, runId: e.binding.entryRunId, node: e.binding.entryNode, branchId: null,
    workitemId: e.binding.workitemId, state: 'observed', inputDigest: e.inputDigest,
    outputDigest: o.outputDigest, usd: o.usd, usageMissing: false, outcome: o.outcome, at: e.at, endedAt: o.endedAt };
}
function inspectEntryPair(rawEntry, rawContinuation, job) {
  const captured = capture({ entry: rawEntry, continuation: rawContinuation });
  if (captured.readOnly) return { ok: false, readOnly: true, issue: captured.issue };
  try {
    const e = adoptableEntry(captured.value.entry, job), c = demand(captured.value.continuation, job), b = e.binding;
    const expectedBinding = { jobId: b.jobId, lineId: b.lineId, intakeId: b.intakeId, streamId: b.streamId,
      entryRunId: b.entryRunId, planHash: b.planHash, dockMode: true, entryNode: b.entryNode };
    const receipt = { runId: b.entryRunId, day: Math.floor(e.observation.endedAt / 86400000), usd: e.observation.usd };
    if (!sameEntryFact(c.binding, expectedBinding) || !sameEntryFact(c.origin, e.origin)
      || !sameEntryFact(c.restriction, e.restriction) || !sameEntryFact(c.accounting.limits, e.limits)
      || !sameEntryFact(c.attempts[0], entryAttempt(e)) || !sameEntryFact(c.walk.entryOutput, e.observation.product)
      || c.walk.originalText !== e.input.text || c.accounting.entryUsd !== e.observation.usd
      || !sameEntryFact(c.accounting.dayReceipts.find(r => r.runId === b.entryRunId), receipt)) {
      throw new Error('line continuation no longer names its exact retained entry and original-day receipt');
    }
    return { ok: true, readOnly: false, entry: e, continuation: c, issue: null };
  } catch (error) {
    return { ok: false, readOnly: true, issue: problem('entry_pair', error.message) };
  }
}
function demandEntryPair(entry, continuation, job) {
  const p = inspectEntryPair(entry, continuation, job);
  if (!p.ok) throw new Error(p.issue.message);
  return p;
}
function seedEntryContinuation(raw, job, walk) {
  const e = adoptableEntry(raw, job), b = e.binding, o = e.observation;
  // The existing chain instance supplies this initial cursor. No caller-supplied
  // resume cursor, branch flag, or bookkeeping bit is an execution permission.
  if (!walk || !sameEntryFact(walk.current, b.entryNode) || !sameEntryFact(walk.product, o.product)
    || !sameEntryFact(walk.entryOutput, o.product) || walk.originalText !== e.input.text
    || walk.lastHanded !== o.product.draft || walk.producerVerdict !== o.product.verdict
    || !sameEntryFact(walk.visited, [nodeId(b.entryNode)]) || walk.next !== null || walk.hop !== 0 || walk.loopHops !== 0
    || !sameEntryFact(walk.gates, []) || !sameEntryFact(walk.openLoops, []) || walk.fromTile !== null || walk.via !== null
    || walk.branchMode !== false || !sameEntryFact(walk.pending, []) || walk.forced !== null || walk.fan !== null
    || walk.partial !== null || walk.unapproved !== null) throw new Error('line entry initializer is not the original straight-line cursor');
  const c = { version: 1, revision: 1, phase: 'ready',
    binding: { jobId: b.jobId, lineId: b.lineId, intakeId: b.intakeId, streamId: b.streamId,
      entryRunId: b.entryRunId, planHash: b.planHash, dockMode: true, entryNode: b.entryNode },
    origin: e.origin, restriction: e.restriction, walk, barriers: [],
    accounting: { entryUsd: o.usd, hopUsd: 0, runIds: [b.entryRunId],
      dayReceipts: [{ runId: b.entryRunId, day: Math.floor(o.endedAt / 86400000), usd: o.usd }], limits: e.limits },
    attempts: [entryAttempt(e)], files: [], hold: null, decisions: [], activeDecision: null, terminal: null, publication: null };
  return demandEntryPair(e, c, job).continuation;
}
module.exports = { inspect, demand, checkpoint, claimDecision, fileRef, inspectEntry, demandEntry, prepareEntry, checkpointEntry,
  adoptableEntry, inspectEntryPair, demandEntryPair, seedEntryContinuation,
  refuseDecision, MAX_REFUSED, entryInputDigest, entryOutputDigest, MAX_BYTES, MAX_DEPTH, MAX_ATTEMPTS, MAX_PARTS, MAX_FILES };
