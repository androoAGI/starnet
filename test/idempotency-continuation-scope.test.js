/* node test/idempotency-continuation-scope.test.js — a recovered continuation dedupes connector writes under the SAME work
   item its source ran under (review of quick win 31).

   A routine run (scheduled, and since quick win 31 Run Now too) is scoped 'cron:<job>:<fire>' in the idempotency ledger. Its
   recovered continuation came in with no explicit scope, so scopeFor gave it 'run:<source>' — a scope the source never wrote
   under — and a connector write the source had already completed was NOT recognised as one when the continuation re-issued
   it (the 'idempotent-replay' backstop silently missed). Now the source's resolved scope is journaled at begin, the host
   carries it from the source's journal into the continuation plan, and scopeFor prefers it.

   Proves, with the REAL run journal and the REAL ledger: (A) the journal keeps a begin meta's idempotencyScope; (B) scopeFor
   gives a continuation its source's scope, and an old journal without one still falls back to 'run:<source>'; (C) a write the
   source completed under 'cron:…' is replayed, not re-sent, when its continuation re-issues it; (D) the host wiring — runOnceCore
   journals the resolved scope, consumeRunRecoveryContinuation hands it to the plan from the SOURCE journal (never a request). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../sidecar/run-journal.js');
const { makeIdempotencyLedger, scopeFor } = require('../sidecar/idempotency-ledger.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-cont-scope-'));
const clock = { now: () => 1000 };

(async () => {
  try {
    // ---- A. the journal keeps the scope the source ran under ----
    const j = J.makeRunJournal({ dir: path.join(root, 'journal'), clock });
    j.begin({ runId: 'src-1', agentId: 'ag1', streamId: 'global', trigger: 'schedule', cronJobId: 'job7', idempotencyScope: 'cron:job7:1700000000000' });
    const state = j.inspect('src-1');
    A.eq(state.meta && state.meta.idempotencyScope, 'cron:job7:1700000000000', 'the begin record keeps the run\'s resolved idempotency scope');

    // ---- B. scopeFor: a continuation inherits it; an old journal falls back to its source run ----
    const plan = { sourceRunId: 'src-1', continuationId: 'c1', idempotencyScope: state.meta.idempotencyScope };
    A.eq(scopeFor({ runId: 'cont-1', recovery: plan }), 'cron:job7:1700000000000', 'a continuation dedupes under the work item its source ran under');
    A.eq(scopeFor({ runId: 'cont-1', recovery: { sourceRunId: 'src-1' } }), 'run:src-1', 'a journal from before the scope was recorded falls back to the source run');
    A.eq(scopeFor({ runId: 'cont-1', recovery: { sourceRunId: 'src-1', idempotencyScope: '   ' } }), 'run:src-1', 'a blank inherited scope is no scope');
    A.eq(scopeFor({ runId: 'cont-1', idempotencyScope: 'conn:x', recovery: plan }), 'conn:x', 'an explicit scope still wins');

    // ---- C. the real ledger: the source's completed write is replayed for its continuation, not sent again ----
    const L = makeIdempotencyLedger({ fs, path, workspaces: path.join(root, 'ws'), clock: () => 1000 });
    const args = JSON.stringify({ to: 'team@example.test', subject: 'digest', body: 'x' });
    const g1 = L.before(scopeFor({ runId: 'src-1', idempotencyScope: 'cron:job7:1700000000000' }), 'mcp__gmail__send_email', args);
    A.eq(g1.result, null, 'fixture: the source\'s first send goes out');
    await L.after(g1, { ok: true, isError: false, summary: 'sent', content: 'Message id 42' }, { runId: 'src-1', tool: 'mcp__gmail__send_email' });
    const g2 = L.before(scopeFor({ runId: 'cont-1', recovery: plan }), 'mcp__gmail__send_email', args);
    A.ok(!!g2.result && g2.result.summary === 'idempotent-replay', 'the continuation re-issuing the same send gets the replay, never a second email');
    const g3 = L.before(scopeFor({ runId: 'cont-1', recovery: { sourceRunId: 'src-1' } }), 'mcp__gmail__send_email', args);
    A.eq(g3.result, null, 'control: under the old \'run:<source>\' scope the same send was NOT recognised (the gap this closes)');

    // ---- D. the host wiring ----
    const core = sidecarTopLevelFunction('runOnceCore');
    const bAt = core.indexOf('runJournal.begin({');
    const begin = bAt < 0 ? '' : core.slice(bAt, core.indexOf('});', bAt));
    A.ok(begin.length > 100, 'runOnceCore\'s journal begin is sliced (' + begin.length + ' chars)');
    A.ok(/idempotencyScope: idempotencyScope \|\| ''/.test(begin), 'runOnceCore journals the scope it resolved for this run');
    const resolvedAt = core.indexOf('const idempotencyScope = idempotencyLedger.scopeFor(');
    A.ok(resolvedAt > 0 && resolvedAt < bAt, 'and resolves that scope before the begin record is written');
    const consume = sidecarTopLevelFunction('consumeRunRecoveryContinuation');
    A.ok(/current\.meta && current\.meta\.idempotencyScope/.test(consume), 'the continuation plan takes the scope from the SOURCE journal');
    A.ok(/idempotencyScope \? \{ idempotencyScope \} : \{\}/.test(consume) && !/body\.idempotencyScope|request\.idempotencyScope/.test(consume), 'and never from the request body');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('idempotency-continuation-scope.test');
})().catch(e => { console.error(e); process.exit(1); });
