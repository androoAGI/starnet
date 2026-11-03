/* Structural continuation/decision safety, before any resume executor is enabled. */
'use strict';
const A = require('./_assert.js');
let C = require('../sidecar/routing/line-continuation.js');
if (process.env.LINE_CONTINUATION_SCHEMA_CONTROL) {
  const Module = require('node:module'), path = require('node:path');
  const owner = require.resolve('../sidecar/routing/line-continuation.js');
  const old = new Module(owner, module); old.filename = owner; old.paths = Module._nodeModulePaths(path.dirname(owner));
  old._compile(require('node:fs').readFileSync(process.env.LINE_CONTINUATION_SCHEMA_CONTROL, 'utf8'), owner); C = old.exports;
}
const { fixture, clone, digest } = require('./helpers/line-continuation.js');
const { job, continuation: held } = fixture();
A.ok(C.inspect(held, job).ok, 'complete held checkpoint validates');
const wrongDay = clone(held); wrongDay.accounting.dayReceipts[0].day++;
A.ok(!C.inspect(wrongDay, job).ok, 'a saved receipt must retain the exact observed endedAt UTC day');
for (const origin of [
  { kind: 'channel', instanceId: 'channel-instance', chatId: 'chat/fixture', senderId: 'sender@example.invalid', chatType: 'private', threadId: 'thread/one', boundAgentId: 'reviewer' },
  { kind: 'schedule', routineId: 'routine/fixture', fireRunId: 'run-entry', policyDigest: 'a'.repeat(64) },
  { kind: 'manual', routineId: 'routine/fixture', fireRunId: 'run-entry', policyDigest: 'a'.repeat(64) },
  { kind: 'trigger', triggerId: 'trigger/fixture', triggerKind: 'webhook', reservationId: 'a'.repeat(64), fingerprint: 'b'.repeat(64), sourceDigest: null },
  { kind: 'trigger', triggerId: 'trigger/fixture', triggerKind: 'folder', reservationId: null, fingerprint: null, sourceDigest: 'c'.repeat(64) },
  { kind: 'sendto', sourceJobId: 'job-sourcefixture1', sourceLineId: 'line-source', sourceOutboxId: 'outbox-source', targetIntakeId: 'intake-a', lineage: ['line-source'], depth: 1 },
  { kind: 'steptest', sessionId: 'session/fixture', sessionRevision: 2, edited: true }
]) {
  const c = clone(held); c.origin = origin;
  A.ok(C.inspect(c, Object.assign({}, job, { entry: origin.kind })).ok, origin.kind + ' origin retains actual owner reference spelling without creating permission');
  c.origin.apiKey = 'synthetic-not-allowed';
  A.ok(!C.inspect(c, Object.assign({}, job, { entry: origin.kind })).ok, origin.kind + ' origin cannot carry generic credentials/configuration');
}
A.eq(C.inspect(held, job).value, held, 'valid capture is lossless');
const large = clone(held); large.walk.product.text = 'draft\n'.repeat(5000);
A.eq(C.inspect(large, job).value.walk.product.text, large.walk.product.text, 'continuation text exceeds display preview without truncation');
A.ok(C.inspect(large, job).ok, 'bounded full draft remains executable');
for (const [name, change] of [
  ['wrong job', c => { c.binding.jobId = 'job-anotherjob'; }],
  ['wrong intake', c => { c.binding.intakeId = 'another-intake'; }],
  ['wrong stream', c => { c.binding.streamId = 'another-stream'; }],
  ['missing draft', c => { delete c.walk.product.draft; }],
  ['missing paid receipt', c => { c.accounting.runIds = []; }],
  ['lost entry spend', c => { c.accounting.entryUsd = 0; }],
  ['duplicate run', c => { c.attempts.push(clone(c.attempts[0])); }],
  ['unsafe ordinal', c => { c.attempts[0].ordinal = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative spend', c => { c.accounting.entryUsd = -1; }],
  ['changed path without new proof', c => { c.files[0].path = '/fixture/other.txt'; }],
  ['foreign file reference', c => { c.walk.product.files = [digest('other')]; }],
  ['hold missing gate', c => { c.walk.gates = []; }],
  ['hold resets pass', c => { c.hold.pass = 0; }],
  ['unknown policy', c => { c.hold.allowed.push('send'); }],
  ['saved grant flag', c => { c.restriction.ownerTrusted = true; }],
  ['saved provider key', c => { c.origin.key = 'never save a provider credential'; }],
  ['ready with unresolved attempt', c => { c.phase = 'ready'; c.hold = null; c.attempts[0].state = 'intent'; }]
]) {
  const c = clone(held); change(c);
  const read = C.inspect(c, job);
  A.ok(!read.ok, name + ' refuses executable data');
  A.eq(read.value, c, name + ' remains visible without a partial executable rewrite');
}
const future = JSON.parse('{"version":2,"__proto__":{"polluted":true},"payload":{"draft":"keep me"}}');
const opaque = C.inspect(future, job);
A.ok(!opaque.ok && !opaque.readOnly && opaque.issue.code === 'unsupported_version', 'bounded future data is opaque, not executable');
A.eq(opaque.value, future, 'future fields including prototype-spelled data survive exactly');
A.ok(Object.getPrototypeOf(opaque.value) === null && ({}).polluted === undefined, 'opaque capture cannot assign an object prototype');
const over = clone(held); over.walk.product.text = 'x'.repeat(C.MAX_BYTES);
const oversized = C.inspect(over, job);
A.ok(!oversized.ok && oversized.readOnly && oversized.value === over, 'oversized original is preserved, never clipped or rewriteable');
const deep = { version: 2 }; let leaf = deep;
for (let i = 0; i < 20; i++) { leaf.next = {}; leaf = leaf.next; }
A.ok(!C.inspect(deep, job).ok && !C.inspect(deep, job).readOnly, 'bounded deep future data can still be preserved opaquely');
let getters = 0;
const accessor = {}; Object.defineProperty(accessor, 'version', { enumerable: true, get() { getters++; return 1; } });
A.ok(C.inspect(accessor, job).readOnly && getters === 0, 'inspection never invokes a saved accessor');
const cyclic = {}; cyclic.next = cyclic;
A.ok(C.inspect(cyclic, job).readOnly, 'non-JSON cycle cannot be silently rewritten');

const split = clone(held);
split.attempts[0].branchId = 'branch-a';
split.barriers = [{ joinId: '20,4', entryRunId: 'run-entry', branchIds: ['branch-a', 'branch-b'],
  parts: [{ branchId: 'branch-a', runId: 'run-entry', workitemId: 'crate-entry', product: clone(split.walk.product) }],
  failed: [], pending: ['branch-b'], inFlight: [], at: 120, timeoutMs: 600000 }];
A.ok(C.inspect(split, job).ok, 'held branch retains an exact finished part and unfinished sibling');
const joined = clone(split);
joined.walk.product.producer = { kind: 'join', joinId: '20,4', runIds: ['run-entry'] };
joined.walk.lastHanded = 'the exact pre-split draft, not the joined prose';
joined.walk.fromTile = { x: 20, y: 4 };
joined.walk.fan = { branchIds: ['branch-a', 'branch-b'], width: 2, failed: [],
  joinKey: '20,4|run-entry', joinStep: { join: '20,4', expect: 2, timeoutMin: 10, next: { agentId: 'publisher', dockId: 'dock-publisher' } }, handed: 'pre-split draft' };
A.ok(C.inspect(joined, job).ok, 'actual join frontier, lastHanded and aggregate producer have explicit storage');
A.eq(C.inspect(joined, job).value.walk, joined.walk, 'joinStep and pre-split draft survive without reconstructing a different walk');
for (const [name, change] of [
  ['missing sibling', c => { c.barriers[0].pending = []; }],
  ['duplicate membership', c => { c.barriers[0].failed = ['branch-b']; }],
  ['foreign part run', c => { c.barriers[0].parts[0].runId = 'run-foreign'; }],
  ['other entry barrier', c => { c.barriers[0].entryRunId = 'run-foreign'; }]
]) { const c = clone(split); change(c); A.ok(!C.inspect(c, job).ok, name + ' cannot release a partial/foreign barrier'); }

const req = { token: 'decision-1', revision: 1, action: 'approve', note: 'keep the saved draft', at: 200 };
const first = C.claimDecision(held, job, req);
A.ok(!first.replayed && first.continuation.revision === 2 && first.continuation.phase === 'held', 'decision receipt advances once but dispatches nothing');
A.eq(held.decisions, [], 'claim does not mutate the caller checkpoint');
A.eq(first.receipt.hold, held.hold, 'decision history keeps the original blocked gate/reason/pass');
A.ok(C.claimDecision(first.continuation, job, req).replayed, 'lost response retry returns the same receipt');
A.throws(() => C.claimDecision(first.continuation, job, Object.assign({}, req, { note: 'changed' })), 'same token cannot buy different work');
A.throws(() => C.claimDecision(first.continuation, job, Object.assign({}, req, { token: 'decision-2' })), 'concurrent stale decision cannot claim the old cursor');
A.throws(() => C.claimDecision(first.continuation, job, Object.assign({}, req, { token: 'decision-2', revision: 2 })), 'one accepted decision already owns this hold');
const ready = clone(first.continuation); ready.revision++; ready.phase = 'ready'; ready.hold = null; ready.decisions[0].state = 'adopted';
A.ok(C.checkpoint(first.continuation, job, 2, ready).phase === 'ready', 'explicit adoption can advance the saved cursor');
const bypass = clone(held); bypass.revision++; bypass.phase = 'ready'; bypass.hold = null;
A.throws(() => C.checkpoint(held, job, 1, bypass), 'no human decision means no held-to-ready transition');
const deliveredBypass = clone(held); deliveredBypass.revision++; deliveredBypass.phase = 'terminal_pending'; deliveredBypass.hold = null;
deliveredBypass.terminal = { outcome: 'delivered', output: held.walk.product.text, usd: 0.125, runIds: ['run-entry'], stop: null };
deliveredBypass.publication = { outboxId: 'outbox-a', entryRunId: 'run-entry', terminalRunId: 'run-entry', state: 'pending', shipmentId: null, sentToJobId: null };
A.ok(C.inspect(deliveredBypass, job).ok, 'bypass control is otherwise complete terminal data');
A.throws(() => C.checkpoint(held, job, 1, deliveredBypass), 'held work cannot publish directly without the human decision');
const stopped = clone(deliveredBypass); stopped.publication = null; stopped.terminal.outcome = 'stopped';
stopped.terminal.stop = { code: 'stopped', why: 'stopped by the Commander', agentId: 'reviewer', dockId: 'dock-reviewer' };
A.ok(C.checkpoint(held, job, 1, stopped).phase === 'terminal_pending', 'owned STOP can settle held work without buying an approval or another run');
for (const [name, change] of [
  ['taint upgrade', c => { c.restriction.entryUntrusted = false; }],
  ['origin switch', c => { c.origin = { kind: 'channel', instanceId: 'bot-a', chatId: 'owner', senderId: 'owner', chatType: 'private', threadId: null, boundAgentId: null }; }],
  ['paid text replacement', c => { c.walk.entryOutput.text = 'different'; }],
  ['price erased', c => { c.attempts[0].usd = 0; c.accounting.entryUsd = 0; c.accounting.dayReceipts = []; }],
  ['gate count reset', c => { c.walk.gates[0].count = 0; c.hold.pass = 0; }]
]) { const c = clone(held); c.revision++; change(c); A.throws(() => C.checkpoint(held, job, 1, c), name + ' cannot mutate existing authority/receipts'); }
A.throws(() => C.checkpoint(held, job, 0, first.continuation), 'stale revision is refused');
A.throws(() => C.checkpoint(held, job, 1, first.continuation), 'only claimDecision may append a human receipt');
A.throws(() => C.checkpoint(null, job, 0, held), 'present-invalid null is not an absent legacy continuation');
const maxFiles = clone(held);
for (let i = 1; i < C.MAX_FILES; i++) {
  const f = Object.assign({}, maxFiles.files[0], { path: '/fixture/project/file-' + i }); f.ref = C.fileRef(f); maxFiles.files.push(f);
}
A.ok(C.inspect(maxFiles, job).ok, 'all 64 exact produced-file receipts fit');
const extraFile = Object.assign({}, maxFiles.files[0], { path: '/fixture/project/one-too-many' }); extraFile.ref = C.fileRef(extraFile); maxFiles.files.push(extraFile);
A.ok(!C.inspect(maxFiles, job).ok, '65th file refuses the whole executable checkpoint, never truncates');
const maxAttempts = clone(held);
for (let i = 2; i <= C.MAX_ATTEMPTS; i++) {
  const a = Object.assign({}, held.attempts[0], { ordinal: i, runId: 'run-' + i, workitemId: 'crate-' + i, usd: 0 });
  maxAttempts.attempts.push(a); maxAttempts.accounting.runIds.push(a.runId);
}
A.ok(C.inspect(maxAttempts, job).ok, '1024 distinct observed attempts retain their exact IDs and spend');
const extraAttempt = Object.assign({}, held.attempts[0], { ordinal: C.MAX_ATTEMPTS + 1, runId: 'run-extra', workitemId: 'crate-extra', usd: 0 });
maxAttempts.attempts.push(extraAttempt); maxAttempts.accounting.runIds.push(extraAttempt.runId);
A.ok(!C.inspect(maxAttempts, job).ok, '1025th attempt refuses without erasing old paid receipts');
const exactBytes = clone(held); exactBytes.walk.product.text = '';
exactBytes.walk.product.text = 'x'.repeat(C.MAX_BYTES - Buffer.byteLength(JSON.stringify(exactBytes)));
A.ok(C.inspect(exactBytes, job).ok && C.inspect(exactBytes, job).bytes === C.MAX_BYTES, 'exact executable byte ceiling is accepted losslessly');
exactBytes.walk.product.text += 'x';
A.ok(C.inspect(exactBytes, job).readOnly, 'one byte over the ceiling preserves original data and refuses a rewrite');
console.log('serialized fixture bytes: held=' + C.inspect(held, job).bytes + ', split=' + C.inspect(split, job).bytes + ', fullDraft=' + C.inspect(large, job).bytes);
A.report('line-continuation');
