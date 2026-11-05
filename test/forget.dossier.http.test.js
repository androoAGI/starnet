'use strict';
/* node test/forget.dossier.http.test.js - THE DOSSIER BLOCK AND THE POSTURE BELIEFS FORGET A DELETED SESSION (turn identity commit 14,
   qa/bugs/3e926b6a), through a REAL hermetic sidecar (SidecarFixture) and the page's own routes.

   The Commander dossier block and the beliefs snapshot are composed by the PAGE and pushed here for the unattended runs (cron, night shift,
   scout, quest refresh). Some beliefs were learned from runs, so each push names the runs it was learned from (sourceRunIds) and whether it names
   them all (complete). The sidecar keeps that with the block, clears the block when a delete reaches one of its runs (or when it cannot say what
   it was learned from), and admits a push only by the same rule on every caller:

     (a) a complete push that names a run of a deleted session is REFUSED ({ok:true, admitted:false, reason:'source-forgotten'}) and the held block stays
     (b) a complete push that names only live runs is admitted, before and after a delete (the page's re-push after a purge must land)
     (c) a push with no provenance (an old page, a stale tab) is admitted only while no delete was made: after the first delete it is refused
         ('provenance-incomplete'); an empty block (the reset) is always admitted
     (d) the delete itself clears a block sourced from the deleted session's run, and one that cannot show its sources; a block sourced from another
         run, or from a run of an ADOPTED stamp (a delete made before the ledger's first read, I7 limit d), stays
     (e) a restored backup is a write like any other: a dossier envelope naming a forgotten run is not restored, one naming a live run is, and the
         export carries the provenance the block was kept with
     (f) the posture's beliefs snapshot: the DIAL is always written; a snapshot naming a forgotten run is refused (beliefsAdmitted:false) and answered;
         the delete drops the beliefs sourced from the deleted session's run (and the readiness verdict computed over them) and keeps the others
   RED at the previous commit for (a), (c), (d), (f): the sidecar kept the block and the beliefs with no source and admitted every push. */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const DELETED = 'ws_quokka', KEPT = 'ws_keep', ADOPTED = 'ws_old';
const RUN_GONE = 'run_gone_1', RUN_KEPT = 'run_kept_1', RUN_OLD = 'run_old_1';
const now = Date.now();
const hermeticEnv = () => {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  return Object.assign(env, { SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '' });
};
const until = async (fn, label, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 100)); } };

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-forget-dossier-', timeoutMs: 30000, env: hermeticEnv() });
  const json = (method, route, body) => fixture.json(method, route, body);
  const file = () => { try { return JSON.parse(fs.readFileSync(path.join(fixture.workspace, '_commander.dossier.json'), 'utf8')); } catch (_) { return null; } };
  const posture = async () => (await json('GET', '/api/autonomy/posture')).body;
  const push = async (block, extra) => { const r = await json('POST', '/api/dossier', Object.assign({ block }, extra || {})); A.eq(r.status, 200, 'POST /api/dossier answers'); return r.body; };
  const beliefs = (extra, runs) => Object.assign({ known: ['goals', 'style'], ready: { ok: true, reasons: [] }, beliefs: {
    goals: [{ text: 'ship the quokka tracker', weight: 'observed', updatedAt: now, createdAt: now, sourceRunId: runs[0] }],
    style: [{ text: 'prefers terse answers', weight: 'stated', updatedAt: now, createdAt: now }] } }, extra || {});
  const run = (runId, streamId, ts) => JSON.stringify({ runId, agentId: 'agent', streamId, ts, reason: 'done', directive: 'seed' });
  try {
    // the stations's runs: one in the session that will be deleted, one in the kept session, one in a session deleted BEFORE this ledger's first read
    fs.writeFileSync(path.join(fixture.workspace, 'runs.jsonl'), [run(RUN_GONE, DELETED, now - 5000), run(RUN_KEPT, KEPT, now - 4000), run(RUN_OLD, ADOPTED, now - 3000)].join('\n') + '\n');
    // the ledger's FIRST read already held ADOPTED's delete (made while Delete only hid the rail row): stamped, memory kept (I7 limit d)
    const ledger = require('../sidecar/session-tombstones.js').makeSessionTombstones({ fs, path, file: path.join(fixture.workspace, 'session-tombstones.json'),
      now: () => now - 9000 });
    ledger.observe([ADOPTED], [ADOPTED]);
    A.eq(ledger.adopted().map(e => e.id), [ADOPTED], 'setup: the ledger holds an adopted stamp');
    await fixture.start();
    let revision = 0;
    const save = async (extra) => {
      const r = await json('POST', '/api/save', Object.assign({ agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: revision,
        workstreams: [{ id: KEPT, title: 'Keep', history: [] }] }, extra));
      A.eq(r.status === 200 && r.body && r.body.ok, true, 'the save lands: ' + JSON.stringify(r.body));
      revision = (r.body && r.body.saveRevision) || revision + 1;
    };

    // ---- before any delete: a push with no provenance is admitted (nothing was ever deleted), and the block is kept with what it says ----
    const first = await push('WHAT YOU KNOW: legacy block with no provenance');
    A.eq(first.admitted, true, '(c) before any delete a push with no provenance is admitted');
    A.eq(file() && file().complete, false, '(c) ...and the block is kept as incomplete');
    const live = await push('WHAT YOU KNOW: ships the kept tracker', { sourceRunIds: [RUN_KEPT], complete: true });
    A.eq(live.admitted, true, '(b) a complete push naming a live run is admitted');
    A.eq(file() && file().sourceRunIds, [RUN_KEPT], '(b) ...and the block is kept with the runs it was learned from');
    A.eq(file().complete, true, '(b) ...and as complete');
    const sourced = await push('WHAT YOU KNOW: ships the quokka tracker; ships the kept tracker', { sourceRunIds: [RUN_GONE, RUN_KEPT], complete: true });
    A.eq(sourced.admitted, true, '(d) setup: a block learned from the quokka session\'s run is admitted while that session lives');

    // the posture: the dial plus a beliefs snapshot whose goal belief was learned from the quokka run
    const p0 = await json('POST', '/api/autonomy/posture', { posture: { initiative: 'propose', reach: 'sandbox', leashPerDay: 3 }, beliefs: beliefs({ complete: true }, [RUN_GONE]) });
    A.eq(p0.status === 200 && p0.body.beliefsAdmitted, true, '(f) setup: a complete snapshot is admitted: ' + JSON.stringify(p0.body).slice(0, 200));
    A.eq((await posture()).beliefs.known.slice().sort(), ['goals', 'style'], '(f) setup: the server holds both dimensions');

    // the adopted stamp (seeded above): nothing is purged for it, and it is not a delete the Commander made
    A.eq((await push('WHAT YOU KNOW: ships the old tracker', { sourceRunIds: [RUN_OLD], complete: true })).admitted, true, '(d) a run of an ADOPTED stamp is not forgotten (I7 limit d): its push is admitted');
    A.eq((await push('WHAT YOU KNOW: legacy block with no provenance')).admitted, true, '(c) an adopted stamp is not a delete the Commander made: a push with no provenance is still admitted');
    await push('WHAT YOU KNOW: ships the quokka tracker; ships the kept tracker', { sourceRunIds: [RUN_GONE, RUN_KEPT], complete: true });

    // ---- the Commander deletes the quokka session (the save the page sends) ----
    await save({ deletedIds: [ADOPTED, DELETED], forgetIds: [ADOPTED, DELETED] });
    await until(() => file() && file().block === '', '(d) the delete clears the block sourced from the deleted session\'s run');
    A.eq(file().block, '', '(d) the block learned from the deleted session\'s run is gone');
    await until(async () => { const b = (await posture()).beliefs; return !b || !(b.known || []).includes('goals'); }, '(f) the sourced belief leaves the snapshot');
    const after = (await posture()).beliefs;
    A.ok(after && after.known.includes('style') && !after.known.includes('goals'), '(f) the delete drops the belief learned from the deleted run and keeps the Commander\'s own: ' + JSON.stringify(after));
    A.eq((await posture()).summary.initiative, 'propose', '(f) the dial is the Commander\'s setting: a delete never touches it');

    // ---- (a) a late push naming the forgotten run ----
    const late = await push('WHAT YOU KNOW: ships the quokka tracker', { sourceRunIds: [RUN_GONE], complete: true });
    A.eq([late.ok, late.admitted, late.reason], [true, false, 'source-forgotten'], '(a) a complete push naming a forgotten run is refused and answered: ' + JSON.stringify(late));
    A.eq(file().block, '', '(a) ...and the block stays empty');
    // the refusal is counted where the diagnostics read it
    const diag = JSON.stringify((await json('GET', '/api/diagnostics')).body || {});
    A.ok(/dossier\.refused/.test(diag), '(a) the refusal is counted under dossier.refused');

    // ---- (c) a push that cannot show its sources, after a delete ----
    const stale = await push('WHAT YOU KNOW: an old page\'s block');
    A.eq([stale.admitted, stale.reason], [false, 'provenance-incomplete'], '(c) after the first delete a push with no provenance is refused');
    const partial = await push('WHAT YOU KNOW: a partial block', { sourceRunIds: [RUN_KEPT], complete: false });
    A.eq(partial.admitted, false, '(c) ...and so is one that names some of its runs but not all');
    A.eq(file().block, '', '(c) ...the block stays empty (a cleared block reads as no block until the page\'s complete re-push)');

    // ---- (b) the page's complete re-push lands ----
    const repush = await push('WHAT YOU KNOW: ships the kept tracker', { sourceRunIds: [RUN_KEPT], complete: true });
    A.eq(repush.admitted, true, '(b) the page\'s complete re-push naming only live runs is admitted after the delete');
    A.eq(file().block, 'WHAT YOU KNOW: ships the kept tracker', '(b) ...and the block is back');
    A.eq((await push('', {})).admitted, true, '(c) an empty block (the dossier turned off, the reset) is always admitted');
    await push('WHAT YOU KNOW: ships the kept tracker', { sourceRunIds: [RUN_KEPT], complete: true });

    // ---- (e) a restored backup is a write like any other ----
    const exported = await json('POST', '/api/config/export', { only: ['dossier'] });
    A.eq(exported.body.sections.dossier.sourceRunIds, [RUN_KEPT], '(e) the export carries the runs the block was learned from');
    A.eq(exported.body.sections.dossier.complete, true, '(e) ...and whether that list is whole');
    const envelope = (block, ids, complete) => ({ starnetExport: 1, exportedAt: Date.now(), app: 'StarNet', sections: { dossier: { block, sourceRunIds: ids, complete } } });
    const badRestore = await json('POST', '/api/config/import', { envelope: envelope('WHAT YOU KNOW: ships the quokka tracker', [RUN_GONE], true) });
    A.eq(badRestore.body.applied.includes('dossier'), false, '(e) a backup whose block was learned from a deleted session is not restored');
    A.ok(badRestore.body.notes.some(n => /dossier/i.test(n)), '(e) ...and the answer says why');
    const oldRestore = await json('POST', '/api/config/import', { envelope: { starnetExport: 1, sections: { dossier: { block: 'WHAT YOU KNOW: an old backup' } } } });
    A.eq(oldRestore.body.applied.includes('dossier'), false, '(e) a backup from before provenance cannot show its sources and is not restored after a delete');
    A.eq(file().block, 'WHAT YOU KNOW: ships the kept tracker', '(e) ...the held block is untouched by both');
    const goodRestore = await json('POST', '/api/config/import', { envelope: envelope('WHAT YOU KNOW: restored kept tracker', [RUN_KEPT], true) });
    A.eq(goodRestore.body.applied.includes('dossier'), true, '(e) a backup whose block names only live runs is restored');
    const reset = await json('POST', '/api/config/reset', { section: 'dossier' });
    A.eq(reset.status, 200, '(e) the reset answers');
    A.eq(file().block, '', '(e) the reset always admits the empty block');

    // ---- (f) the posture write: the dial is written, a snapshot naming a forgotten run is refused ----
    const p1 = await json('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 4 }, beliefs: beliefs({ complete: true }, [RUN_GONE]) });
    A.eq(p1.status, 200, '(f) the posture route answers');
    A.eq([p1.body.ok, p1.body.beliefsAdmitted], [true, false], '(f) a snapshot naming a forgotten run is refused and answered (beliefsAdmitted:false): ' + JSON.stringify(p1.body).slice(0, 200));
    A.eq((await posture()).summary.initiative, 'leash', '(f) ...while the dial the Commander set is written');
    A.ok(!((await posture()).beliefs || { known: [] }).known.includes('goals'), '(f) ...and the refused belief is not held');
    const p2 = await json('POST', '/api/autonomy/posture', { beliefs: beliefs({}, [RUN_KEPT]) });
    A.eq(p2.body.beliefsAdmitted, false, '(f) a snapshot that does not say it is complete is refused after a delete');
    const p3 = await json('POST', '/api/autonomy/posture', { beliefs: beliefs({ complete: true }, [RUN_KEPT]) });
    A.eq(p3.body.beliefsAdmitted, true, '(f) the page\'s complete re-push naming only live runs is admitted');
    A.eq((await posture()).beliefs.known.slice().sort(), ['goals', 'style'], '(f) ...and the snapshot is back');
    const p4 = await json('POST', '/api/autonomy/posture', { posture: { initiative: 'wait', reach: 'sandbox', leashPerDay: 3 } });
    A.eq([p4.body.ok, p4.body.beliefsAdmitted], [true, true], '(f) a dial-only write has no snapshot to refuse');

    // ---- survives a restart: the provenance is durable, the cleared block stays cleared ----
    await push('WHAT YOU KNOW: ships the kept tracker', { sourceRunIds: [RUN_KEPT], complete: true });
    await fixture.restart();
    A.eq(file().sourceRunIds, [RUN_KEPT], 'after a restart the block keeps the runs it was learned from');
    const gone2 = await push('WHAT YOU KNOW: ships the quokka tracker', { sourceRunIds: [RUN_GONE], complete: true });
    A.eq(gone2.admitted, false, 'after a restart a push naming the forgotten run is still refused (the ledger is durable)');
    A.report('forget.dossier.http');
  } finally {
    await fixture.dispose();
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
