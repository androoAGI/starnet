/* node test/registry.timeout-effect-unknown.test.js — A TIMED-OUT WRITE HAS AN UNKNOWN EFFECT (h1 audit 2026-09-22).

   The probe: mcp__crm__create_invoice timed out; the model saw "tool … timed out after 100ms" while the remote write
   landed anyway; the idempotency ledger recorded successes only and the failure-recovery nudge invited a retry, so the
   invoice was created twice. Proves:
     (a) the registry's timeout result for a tool NOT proven read-only says the effect is UNKNOWN and to verify before
         retrying, and carries effectUnknown; a host read tool keeps its exact old wording; a connector's self-declared
         read-only annotation does not buy the plain wording; an in-tool timer (the MCP client's) is read the same way;
         an MCP call cancelled mid-flight is effect-unknown too;
     (b) the ledger's dispatch seam (idempotency-ledger before()/after() — exactly what index.js calls) records a
         timed-out mutating connector call as UNCERTAIN, HOLDS an identical retry in the same scope, lets differing args
         and read calls through untouched, releases the hold only after a successful read on that connector, and keeps
         the success dedupe byte-identical; and the MCP default call timeout is >= 120s and configurable as before.
   Zero network, in-memory fs, short bounded real timers only. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeIdempotencyLedger } = require('../sidecar/idempotency-ledger.js');
const { makeMcpClient } = require('../sidecar/mcp/client.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');

function memFs() {
  const files = new Map();
  return {
    _files: files,
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, d) { files.set(String(f), String(d)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    statSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { size: files.get(String(f)).length }; },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const call = (name, args, id) => ({ id: id || 'c1', name, args: args || {}, argsRaw: JSON.stringify(args || {}) });
const hang = () => new Promise(() => {});

(async () => {
  // ================= (a) registry timeout wording =================
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'crm_write', scope: 'write', timeoutMs: 30, schema: { type: 'object' }, run: hang });
  reg.register({ impact: 'none', name: 'crm_exec', scope: 'execute', timeoutMs: 30, schema: { type: 'object' }, run: hang });
  reg.register({ impact: 'none', name: 'slow_read', scope: 'read', timeoutMs: 30, schema: { type: 'object' }, run: hang });
  reg.register({ name: 'mcp__crm__lookup_hint', scope: 'read', readOnly: true, timeoutMs: 30, schema: { type: 'object' }, run: hang }, { provenance: 'connector' });

  const w = await reg.dispatch(call('crm_write'));
  A.eq([w.ok, w.isError, w.summary], [false, true, 'timeout'], 'a write-scope timeout is still an isError timeout');
  A.ok(/timed out after 30ms/.test(w.content), 'it names the timeout');
  A.ok(/effect is UNKNOWN/.test(w.content) && /may have taken effect/.test(w.content), 'it says the effect is unknown and may have happened');
  A.ok(/Verify the current state/.test(w.content) && /BEFORE retrying/.test(w.content), 'it tells the model to verify before retrying');
  A.eq(w.effectUnknown, true, 'the result carries effectUnknown for the host ledger');
  const x = await reg.dispatch(call('crm_exec'));
  A.ok(x.effectUnknown === true && /effect is UNKNOWN/.test(x.content), 'an execute-scope timeout is effect-unknown too');

  const rd = await reg.dispatch(call('slow_read'));
  A.eq([rd.isError, rd.summary, rd.content], [true, 'timeout', 'tool slow_read timed out after 30ms'], 'a host READ tool keeps its exact old timeout wording');
  A.ok(!rd.effectUnknown, 'a read timeout is not effect-unknown');

  const hint = await reg.dispatch(call('mcp__crm__lookup_hint'));
  A.ok(hint.effectUnknown === true && /effect is UNKNOWN/.test(hint.content), "a connector's self-declared readOnly annotation does not prove read-only");

  // an in-tool timer (the MCP client's own request timeout) marks __timeout + its budget; the registry reads it the same way
  const client = makeMcpClient({ transport: { send: async () => {} }, timeoutMs: 25 });
  reg.register({ name: 'mcp__crm__create_invoice', scope: 'execute', timeoutMs: 5000, schema: { type: 'object' },
    run: (args, ctx) => client.callTool('create_invoice', args, { signal: ctx.signal }) }, { provenance: 'connector' });
  const inv = await reg.dispatch(call('mcp__crm__create_invoice', { amount: 10 }));
  A.eq([inv.isError, inv.summary, inv.effectUnknown], [true, 'timeout', true], 'an MCP client timeout is reported as a registry timeout with effect unknown');
  A.ok(/timed out after 25ms/.test(inv.content), "the message names the CLIENT's budget, not the registry backstop: " + inv.content.slice(0, 80));

  // an MCP call cancelled mid-flight (the run was stopped after it was sent) is effect-unknown as well
  const sent = [];
  const client2 = makeMcpClient({ transport: { send: async (m) => { sent.push(m); } } });
  reg.register({ name: 'mcp__crm__send_invoice', scope: 'execute', schema: { type: 'object' },
    run: (args, ctx) => client2.callTool('send_invoice', args, { signal: ctx.signal }) }, { provenance: 'connector' });
  const stop = new AbortController();
  const tC = Date.now();
  const pC = reg.dispatch(call('mcp__crm__send_invoice', { id: 7 }), { signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  const cancelled = await pC;
  A.ok(Date.now() - tC < 1000, 'a cancelled MCP call rejects promptly (' + (Date.now() - tC) + 'ms), not after a grace or timeout');
  A.eq([cancelled.isError, cancelled.summary, cancelled.effectUnknown], [true, 'cancelled', true], 'a mid-flight MCP cancel is an effect-unknown cancelled result');
  A.ok(/effect is UNKNOWN/.test(cancelled.content), 'its content says the effect is unknown');
  const cancelNote = sent.find(m => m.method === 'notifications/cancelled');
  const reqMsg = sent.find(m => m.method === 'tools/call');
  A.ok(!!cancelNote && !!reqMsg && cancelNote.params.requestId === reqMsg.id, 'the server is told with notifications/cancelled for that request id');

  // ================= (b) the ledger's dispatch seam (what index.js calls) =================
  const fs = memFs();
  let now = 1000;
  const L = makeIdempotencyLedger({ fs, path, workspaces: '/ws', writeDurable, clock: () => now });
  const scope = 'run:r1';
  const WRITE = 'mcp__crm__create_invoice', READ = 'mcp__crm__list_invoices';
  const args1 = JSON.stringify({ customer: 'acme', amount: 10 });
  const args2 = JSON.stringify({ customer: 'acme', amount: 11 });
  // a tiny host: gate -> (maybe) dispatch -> settle, exactly the index.js order
  let sends = 0;
  async function hostCall(name, argsRaw, outcome) {
    const gate = L.before(scope, name, argsRaw);
    if (gate.result) return gate.result;
    sends++;
    const r = outcome();
    await L.after(gate, r, { runId: 'r1', tool: name });
    return r;
  }
  const timedOutWrite = () => ({ ok: false, isError: true, summary: 'timeout', content: 'tool ' + WRITE + ' timed out after 100ms.', effectUnknown: true });
  const okWrite = () => ({ ok: true, isError: false, summary: 'created', content: 'invoice INV-1 created' });
  const okRead = () => ({ ok: true, isError: false, summary: 'listed', content: '[]' });

  const first = await hostCall(WRITE, args1, timedOutWrite);
  A.eq([first.summary, sends], ['timeout', 1], 'the first write went out and timed out');
  const row = L.lookup(L.keyFor(scope, WRITE, args1));
  A.ok(row && row.status === 'uncertain' && !row.verifiedAt && row.connector === 'crm', 'the timed-out write is recorded UNCERTAIN under the same key');

  const retry = await hostCall(WRITE, args1, okWrite);
  A.eq([retry.ok, retry.isError, retry.summary, sends], [false, true, 'held-uncertain', 1], 'an identical retry is HELD — not sent');
  A.ok(/MAY ALREADY HAVE TAKEN EFFECT/.test(retry.content) && /did NOT send it again/.test(retry.content), 'the hold says the effect may exist and nothing was re-sent');
  A.ok(/Verify first/.test(retry.content) && /"crm" connector/.test(retry.content), 'the hold names the verification route on that connector');
  const reordered = await hostCall(WRITE, JSON.stringify({ amount: 10, customer: 'acme' }), okWrite);
  A.eq([reordered.summary, sends], ['held-uncertain', 1], 'the same write with reordered keys is the same key and is held too');

  const other = await hostCall(WRITE, args2, okWrite);
  A.eq([other.ok, other.summary, sends], [true, 'created', 2], 'a write with DIFFERENT args is a different write and proceeds');

  // a read in ANOTHER scope does not release this scope's hold
  const gOther = L.before('run:r2', READ, '{}');
  await L.after(gOther, okRead(), { runId: 'r2', tool: READ });
  A.eq(L.before(scope, WRITE, args1).result && L.before(scope, WRITE, args1).result.summary, 'held-uncertain', 'a read in another work item releases nothing');
  // a FAILED read does not release it either
  await hostCall(READ, '{}', () => ({ ok: false, isError: true, summary: 'error', content: 'boom' }));
  A.eq(L.before(scope, WRITE, args1).result && L.before(scope, WRITE, args1).result.summary, 'held-uncertain', 'a failed read is not verification');
  const sendsBeforeRead = sends;
  const read = await hostCall(READ, '{}', okRead);
  A.eq([read.ok, sends], [true, sendsBeforeRead + 1], 'read calls are never held or replayed (they dispatch normally)');
  A.eq(L.lookup(L.keyFor(scope, READ, '{}')), null, 'a read call is never recorded in the ledger');
  const verified = L.lookup(L.keyFor(scope, WRITE, args1));
  A.ok(verified && verified.status === 'uncertain' && verified.verifiedAt === now, 'a successful read on that connector stamps verifiedAt');

  const afterVerify = await hostCall(WRITE, args1, okWrite);
  A.eq([afterVerify.ok, afterVerify.summary, sends], [true, 'created', sendsBeforeRead + 2], 'after verification the identical write is allowed once more');
  const settled = L.lookup(L.keyFor(scope, WRITE, args1));
  A.ok(settled && settled.status === undefined && settled.content === 'invoice INV-1 created', 'its success REPLACES the uncertain row (a plain success row)');

  // ---- the existing success dedupe is unchanged ----
  const again = await hostCall(WRITE, args1, okWrite);
  A.eq([again.ok, again.isError, again.summary, sends], [true, false, 'idempotent-replay', sendsBeforeRead + 2], 'a repeat of a SUCCEEDED write is still replayed, not re-sent');
  A.ok(/\[idempotent replay\]/.test(again.content) && /INV-1/.test(again.content), 'the replay text and prior result are unchanged');
  const plain = L.replayResult({ tool: WRITE, at: 1000, content: 'x' });
  A.eq(Object.keys(plain).sort(), ['content', 'isError', 'ok', 'summary'], 'replayResult shape is unchanged');

  // ---- a write that FAILED cleanly (not effect-unknown) is still never recorded ----
  const args3 = JSON.stringify({ customer: 'zeta' });
  await hostCall(WRITE, args3, () => ({ ok: false, isError: true, summary: 'error', content: 'validation failed' }));
  A.eq(L.lookup(L.keyFor(scope, WRITE, args3)), null, 'a plain failure records nothing (only successes and unknown effects do)');

  // ---- the uncertain row survives a restart (durable) ----
  const args4 = JSON.stringify({ customer: 'omega' });
  await hostCall(WRITE, args4, timedOutWrite);
  const L2 = makeIdempotencyLedger({ fs, path, workspaces: '/ws', writeDurable, clock: () => now });
  A.eq(L2.before(scope, WRITE, args4).result && L2.before(scope, WRITE, args4).result.summary, 'held-uncertain', 'the hold round-trips a restart (a resumed run shares the scope)');

  // ================= MCP default call timeout >= 120s, still configurable =================
  const seen = [];
  const mgr = makeConnectorManager({ makeTransport: () => ({ send: async () => {} }), makeClient: (o) => { seen.push(o.timeoutMs); return { initialize: async () => ({}), listTools: async () => [{ name: 'create_invoice' }], supports: () => false, close() {} }; } });
  await mgr.configure('crm', { transport: 'http', url: 'https://crm.example/mcp' });
  A.ok(seen[0] >= 120000, 'the manager default connector timeout is >= 120s (got ' + seen[0] + ')');
  const def = mgr.toolDefsFor('crm')[0];
  A.ok(def && def.timeoutMs > seen[0], 'the connector tool def carries its own registry backstop ABOVE the client timeout (not the 30s host default): ' + (def && def.timeoutMs));
  await mgr.configure('crm2', { transport: 'http', url: 'https://crm2.example/mcp', timeoutMs: 45000 });
  A.eq(seen[1], 45000, 'a per-connector timeoutMs still overrides the default');
  const mgr2 = makeConnectorManager({ timeoutMs: 20000, makeTransport: () => ({ send: async () => {} }), makeClient: (o) => { seen.push(o.timeoutMs); return { initialize: async () => ({}), listTools: async () => [], supports: () => false, close() {} }; } });
  await mgr2.configure('x', { transport: 'http', url: 'https://x.example/mcp' });
  A.eq(seen[2], 20000, 'a host-supplied manager timeoutMs still wins over the default');
  await mgr.close(); await mgr2.close();

  A.report('registry.timeout-effect-unknown.test');
})().catch(e => { console.log('FAIL: registry.timeout-effect-unknown.test threw — ' + (e && e.stack || e)); process.exit(1); });
