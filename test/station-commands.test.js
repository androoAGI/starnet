/* node test/station-commands.test.js — the PAGE half of the station bridge, run for real.

   stationcommands.js is a browser IIFE, but it is self-contained: it touches only Workstreams / App / Chat /
   U / fetch. So it is loaded here in a vm with the REAL workstreams.js underneath it and the page bridges
   stubbed. That means station.deliver is exercised against genuine session records — the fold, the append,
   the idempotency and the refusals are proven against the same code the app runs, not a paraphrase of it.

   What this exists to stop: delegation used to be agent-addressed only, so a run the Commander asked to
   happen in "research" was filed wherever the lead happened to be. These two verbs are how a session target
   becomes real — station.sessions is what a name is resolved against, station.deliver is what the Commander
   actually sees. Both must refuse loudly rather than half-succeed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'frontend', 'app', 'stationcommands.js');
const src = fs.readFileSync(SRC, 'utf8');

// Boot a fresh page: real Workstreams, stub bridges. Returns the module surface plus what the page recorded.
function boot(opts) {
  opts = opts || {};
  delete require.cache[require.resolve('../frontend/app/workstreams.js')];
  delete require.cache[require.resolve('../frontend/app/channels.js')];
  const Workstreams = require('../frontend/app/workstreams.js');
  const Channels = require('../frontend/app/channels.js');
  Workstreams.reset();
  Channels.reset();
  const page = { rail: 0, persisted: 0, loaded: [], delivered: [], repainted: 0, acks: [], save: null };
  const sandbox = {
    TurnMerge: require('./helpers/turnmerge').TurnMerge,
    Workstreams, Channels,
    GoalLoop: require('../frontend/app/goalloop.js'),   // the shared goal-step predicate (org P29-sys wiring)
    App: {
      refreshRail: () => page.rail++,
      persist: () => { page.persisted++; page.save = JSON.parse(JSON.stringify(Workstreams.serialize())); },
      agents: opts.agents || (() => [])
    },
    CloudSave: {
      flush: async () => opts.saveFails ? false : true,
      pull: async () => opts.readBackFails ? null : page.save
    },
    Delegated: { repaint: () => page.repainted++ },
    Chat: { deliverTurns: (ws, turns) => page.delivered.push({ id: ws.id, turns }), load: ws => page.loaded.push(ws.id), canFocusSession: opts.canFocusSession || (() => true), hydrateHistory: opts.hydrateHistory },
    U: opts.U || { bus: { on: () => {} } },
    VoiceLive: opts.voiceLive,
    fetch: async (url, init) => {
      if (opts.reads) opts.reads.push({ url: String(url), deadline: !!(init && init.signal) });
      // opts.hang(url): a read the sidecar accepts and never answers — only its signal (if it has one) ends it
      if (opts.hang && opts.hang(String(url))) return new Promise((_res, rej) => { if (init && init.signal) init.signal.addEventListener('abort', () => rej(init.signal.reason || new Error('aborted'))); });
      if (String(url).indexOf('/api/runs') === 0) return { ok: true, json: async () => ({ runs: opts.runs || [] }) };
      if (String(url).indexOf('/api/transcript') === 0) return { ok: opts.transcriptUnavailable !== true, json: async () => ({ turns: opts.deliveryTurns || [] }) };
      page.acks.push(JSON.parse(init.body)); return { ok: true };
    },
    document: { addEventListener: () => {} },
    console, setTimeout, clearTimeout, Date, JSON
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // a top-level `const` is NOT a property of the context object (the same reason the module probes App/Chat by
  // bare identifier rather than window.App), so take the module as the script's completion value.
  const S = vm.runInContext(src + '\n;StationCommands;', sandbox, { filename: 'stationcommands.js' });
  // VoiceLive is probed by bare identifier too — expose a setter so a test can stand in a live call
  const setVoiceLive = (v) => { sandbox.VoiceLive = v; };
  return { S, W: Workstreams, C: Channels, page, setVoiceLive };
}
// run a verb through the module's real dispatch path (the same one U.bus drives) and read the ack it posted
async function call(env, verb, args) {
  await env.S.run('cmd-' + env.page.acks.length, verb, args);
  return env.page.acks[env.page.acks.length - 1];
}

(async () => {

// ---- station.sessions: the list a session NAME is resolved against ----
{
  const env = boot();
  const r1 = env.W.create('research');
  env.W.create('Billing rewrite');
  const out = await call(env, 'station.sessions', {});
  A.eq(out.ok, true, 'the page can list its sessions');
  const titles = out.result.sessions.map(s => s.title);
  A.ok(titles.indexOf('research') >= 0, 'a named session is listed by its real title');
  A.ok(titles.indexOf('General') >= 0, 'the untitled home stream is listed under the name the UI shows it by');
  A.eq(out.result.activeId, r1 && out.result.sessions.find(s => s.active).id, 'the active session is flagged');
  A.ok(out.result.sessions.every(s => s.id && s.agentId), 'every row carries the id and agent a dispatch needs');
}

// ---- station.deliver from a ROUTINE names its session as sessionId (cron delivery) — it must land (10-01 live bug) ----
{
  const env = boot();
  const ws = env.W.create('news');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.deliver', { sessionId: ws.id, agentId: 'agent', runId: 'cron-run-1', prompt: 'daily AI news', text: 'top stories…' });
  A.eq(out.ok, true, 'a routine result addressed by sessionId is delivered');
  A.eq(out.result.session, 'news', 'into the session the routine was made in');
}

// ---- a routine's return is a row the station wrote BEFORE it asked the page (turn identity, commit 10): the page row is keyed at once ----
{
  const env = boot();
  const ws = env.W.create('news');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.deliver', { sessionId: ws.id, streamId: ws.id, agentId: 'agent', runId: 'cron-run-7', prompt: 'daily AI news', text: 'top stories…', rowId: 4242, turnId: 'rcron-run-7' });
  A.eq(out.ok, true, 'the return is folded');
  const row = env.W.get(ws.id).history.find(r => r.role === 'assistant');
  A.eq([row.rowId, row.turnId, row.streamId, row.sourceRunId], [4242, 'rcron-run-7', ws.id, 'cron-run-7'], 'the spliced page row carries the station row\'s id, its turn, its stream and its run: it is the same row as the station\'s, not a twin to be matched later');
  const again = await call(env, 'station.deliver', { sessionId: ws.id, streamId: ws.id, agentId: 'agent', runId: 'cron-run-7', text: 'top stories…', rowId: 4242, turnId: 'rcron-run-7' });
  A.eq([again.ok, again.result.reason, env.W.get(ws.id).history.filter(r => r.role === 'assistant').length], [true, 'already delivered', 1], 'a retry of the same return folds nothing twice');
  // no row ids (a worker's delivery, an older sidecar) keeps today's shape exactly
  const plain = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-9', text: 'worker words' });
  const wrow = env.W.get(ws.id).history.find(r => r.content === 'worker words');
  A.eq(['rowId' in wrow, 'turnId' in wrow], [false, false], 'a delivery that names no row adds no identity');
  A.ok(plain.ok, 'and still folds');
  // a session the page can only find by its TITLE is another stream: the station's row id there would name a stranger's row, so only the turn is taken
  const other = env.W.create('Recap');
  const byTitle = await call(env, 'station.deliver', { sessionId: 'ws_gone_away', streamId: 'ws_gone_away', sessionTitle: 'Recap', agentId: 'agent', runId: 'cron-run-8', text: 'found by title', rowId: 77, turnId: 'rcron-run-8' });
  const trow = env.W.get(other.id).history.find(r => r.content === 'found by title');
  A.eq([byTitle.ok, byTitle.result.resolvedBy, trow && trow.rowId, trow && trow.turnId, trow && trow.streamId], [true, 'title', undefined, 'rcron-run-8', other.id], 'resolved by title: no row id from another stream, the turn id and this session\'s own stream');
}

// ---- station.deliver: the worker's answer lands in the session the Commander named ----
{
  const env = boot();
  const ws = env.W.create('research');
  env.W.switch(env.W.generalId());          // the Commander is looking at General, not research
  const before = env.page.rail;
  const out = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', prompt: 'summarise X', text: 'X in three points…' });
  A.eq(out.ok, true, 'the fold succeeded');
  A.eq(out.result.session, 'research', 'and reports which session it went into');
  const h = env.W.get(ws.id).history;
  A.eq(h.length, 2, 'two turns: the framing marker and the real answer');
  A.eq(h[0].sys, true, 'the delegated instruction is a sys marker, not a user turn the Commander never typed');
  A.ok(/delegated to researcher/.test(h[0].content), 'the marker names who it went to');
  A.eq(h[1].role, 'assistant', "the worker's answer is real dialogue");
  A.eq(h[1].content, 'X in three points…', 'delivered verbatim');
  A.eq(h[1].agentId, 'researcher', 'attributed to the WORKER, so renderHistory names the right speaker');
  A.ok(env.W.get(ws.id).runIds.indexOf('run-1') >= 0, 'the run is filed onto that session');
  A.eq(env.W.get(ws.id).lane, 'active', 'a real run advances the lane (hybrid-honest)');
  A.ok(env.W.unread(ws.id), 'the rail flags it unread — the Commander has genuinely not seen this yet');
  A.ok(env.page.rail > before && env.page.persisted > 0, 'the rail re-renders and the save is written');
  A.eq(env.page.loaded.length, 0, 'a session that is NOT open is not force-rendered');
}

// ---- a result names a session the way the rail does: an untitled non-General session is a "New session", never "General" ----
// (rc walk 2026-10-13: the rail read "General" twice; the station results kept saying "General" for a fresh untitled session,
// so the lead could report work "in General" that the rail filed under "New session")
{
  const env = boot();
  const blank = env.W.startSession({ reuseActive: false });
  A.eq(blank.title, null, 'a + NEW session starts untitled');
  const dlv = await call(env, 'station.deliver', { streamId: blank.id, agentId: 'researcher', runId: 'untitled-1', prompt: 'look into X', text: 'X, done.' });
  A.eq(dlv.ok && dlv.result.session, 'New session', 'a delivery into an untitled session names it "New session": ' + JSON.stringify(dlv.result));
  const again = await call(env, 'station.deliver', { streamId: blank.id, agentId: 'researcher', runId: 'untitled-1', text: 'X, done.' });
  A.eq(again.result.reason === 'already delivered' && again.result.session, 'New session', '…and so does the already-delivered answer');
  const start = await call(env, 'station.dispatch_start', { streamId: blank.id, runId: 'untitled-2' });
  A.eq(start.ok && start.result.session, 'New session', 'dispatch start names it the same');
  const end = await call(env, 'station.dispatch_end', { streamId: blank.id, runId: 'untitled-2' });
  A.eq(end.ok && end.result.session, 'New session', 'dispatch end names it the same');
  const read = await call(env, 'station.read_session', { session: blank.id });
  A.eq(read.ok && read.result.title, 'New session', 'reading it by id names it the same');
  const home = await call(env, 'station.deliver', { streamId: env.W.generalId(), agentId: 'researcher', runId: 'home-1', text: 'Y, done.' });
  A.eq(home.result.session, 'General', 'the General home is still "General"');
  const listed = (await call(env, 'station.sessions', {})).result.sessions.find(s => s.id === blank.id);
  A.ok(listed && listed.title !== 'General', 'the session list never calls the untitled session "General"');
  A.ok(!/\btitle \|\| 'General'|title != null \? \w+\.title : 'General'/.test(src), 'no station result falls back to "General" for an untitled session');
}

// A foreground worker's text is not proof of completion: keep the actual terminal reason live and after recovery.
for (const reason of ['done', 'budget', 'max_iters', 'aborted', 'error']) {
  const env = boot();
  const worker = env.W.adopt({ id: 'worker-outcome', title: 'Worker outcome', agentId: 'researcher', worker: true, parentStreamId: env.W.generalId() });
  await call(env, 'station.deliver', { streamId: worker.id, agentId: 'researcher', runId: 'outcome-' + reason, text: 'The recorded work so far.', reason });
  A.eq(worker.lastRunReason, reason, 'live worker delivery preserves ' + reason);
  A.eq(worker.lastRunOk, reason === 'done', 'only a completed worker is successful: ' + reason);
  env.W.init(JSON.parse(JSON.stringify(env.W.serialize())));
  A.eq(env.W.get(worker.id).lastRunReason, reason, 'worker outcome survives page restart: ' + reason);
}
{
  const env = boot({ runs: [{ runId: 'partial-run', streamId: 'partial-worker', sessionTitle: 'Partial worker',
    agentId: 'researcher', reason: 'max_iters', deliveryText: 'Partial findings.', ts: 1000 }] });
  const worker = env.W.adopt({ id: 'partial-worker', title: 'Partial worker', worker: true, parentStreamId: env.W.generalId() });
  await call(env, 'station.deliver', { streamId: worker.id, runId: 'partial-run', text: 'Partial findings.' });
  A.eq(worker.lastRunReason, '', 'a legacy delivery without outcome never guesses completion');
  A.eq(await env.S.reconcile(worker.id), 0, 'learning an outcome does not duplicate an already delivered answer');
  A.eq(worker.lastRunReason, 'max_iters', 'recovery heals an older delivery that lost its iteration-limit reason');
  A.eq(worker.history.length, 1, 'the partial answer remains single');
  env.W.appendRun(worker.id, 'newer-run', 2000); env.W.noteRunEnd(worker.id, 'newer-run', true, 'done');
  await env.S.reconcile(worker.id);
  A.eq(worker.lastRunReason, 'done', 'an older recovered outcome cannot replace the newest run result');
}
{
  const env = boot({ runs: [{ runId: 'empty-error', streamId: 'failed-worker', sessionTitle: 'Failed worker',
    agentId: 'researcher', reason: 'error', deliveryText: '', ts: 1000 }] });
  const worker = env.W.adopt({ id: 'failed-worker', title: 'Failed worker', worker: true, parentStreamId: env.W.generalId() });
  await call(env, 'station.dispatch_start', { streamId: worker.id, runId: 'empty-error' });
  const ended = await call(env, 'station.dispatch_end', { streamId: worker.id, runId: 'empty-error' });
  A.eq(ended.ok, true, 'dispatch end reconciles the foreground worker record');
  A.eq([ended.result.settled, env.C.isBusy(worker.id)], [true, false], 'dispatch end settles the foreground worker channel');
  A.eq(worker.lastRunReason, 'error', 'a worker that failed without text still retains its actual reason');
  A.eq(worker.history.length, 0, 'recovering an empty failure invents no assistant answer');
  A.eq(worker.runIds[0], 'empty-error', 'the failed run can still be inspected from its card');
  A.eq(env.page.save.workstreams.find(w => w.id === worker.id).lastRunReason, 'error', 'empty failure outcome is persisted');
}

// Execution output is provisional until structured-result validation finalizes delivery.
{
  const runs = [{ runId: 'raw-run', streamId: 'structured-worker', sessionTitle: 'Structured worker',
    agentId: 'researcher', reason: 'done', deliveryText: 'not valid JSON', ts: 1000, dispatchDelivery: { state: 'pending' } },
    { runId: 'repair-run', streamId: 'structured-worker', sessionTitle: 'Structured worker',
    reason: 'done', deliveryText: '{"ok":true}', ts: 2000, dispatchDelivery: { state: 'internal' } }];
  const env = boot({ runs });
  const worker = env.W.adopt({ id: 'structured-worker', title: 'Structured worker', worker: true, parentStreamId: env.W.generalId() });
  await call(env, 'station.dispatch_start', { streamId: worker.id, runId: 'raw-run' });
  A.eq(await env.S.reconcile(worker.id), 0, 'recovery waits for structured repair');
  A.eq(worker.history.length, 0, 'raw and repair execution text is never an accepted answer');
  A.eq(worker.runIds.length, 0, 'provisional records cannot deduplicate final delivery');
  A.eq(env.C.isBusy(worker.id), true, 'provisional recovery cannot settle live dispatch');
  runs[0].dispatchDelivery = { state: 'final', text: '{"ok":true}', reason: 'done', repairRunId: 'repair-run' };
  const out = await call(env, 'station.deliver', { streamId: worker.id, runId: 'raw-run', text: runs[0].dispatchDelivery.text, reason: 'done' });
  A.eq(out.result.folded, true, 'the authoritative repaired result is accepted under the original run');
  A.eq(worker.history.map(m => m.content), ['{"ok":true}'], 'only the validated answer is visible');
  A.eq([worker.history[0].sourceRunId, worker.history[0].streamId], ['raw-run', worker.id], 'folded answer retains exact run and conversation ownership');
  const chatSource = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  const merge = new Function('return (' + require('./helpers/turnmerge').source('mergeCanonicalHistory') + ')')();
  const canonicalFinal = { ...worker.history[0], dispatchState: 'final', dispatchReason: 'done', rowId: 12 };
  A.eq(merge(JSON.parse(JSON.stringify(worker.history)), [canonicalFinal]).length, 1, 'newly folded answer is not duplicated by canonical restoration');
  A.eq(await env.S.reconcile(worker.id), 0, 'final delivery recovery is idempotent');
  // Recreate page storage without the live bridge delivery, as after a missed ACK/restart.
  env.W.init({ generalId: 'general', activeId: 'general', workstreams: [{ id: 'general' },
    { id: worker.id, title: worker.title, worker: true, parentStreamId: 'general' }] });
  A.eq(await env.S.reconcile(), 1, 'restart recovers the validated envelope once');
  A.eq(env.W.get(worker.id).history.map(m => m.content), ['{"ok":true}'], 'restart never replays raw output or a second repair answer');
  runs[0].dispatchDelivery = { state: 'final', text: '', reason: 'invalid-result' };
  env.W.init({ generalId: 'general', activeId: 'general', workstreams: [{ id: 'general' },
    { id: worker.id, title: worker.title, worker: true, parentStreamId: 'general' }] });
  await env.S.reconcile();
  A.eq(env.W.get(worker.id).lastRunReason, 'invalid-result', 'execution done never overrides rejected structured delivery');
  A.eq(env.W.get(worker.id).lastRunOk, false, 'invalid structured delivery is not successful');
  A.eq(env.W.get(worker.id).history.length, 0, 'invalid structured delivery has no raw-text fallback');
}

// A bounded run-index preview must never lock out the complete validated answer.
for (const unavailable of [false, true]) {
  const full = JSON.stringify({ answer: 'validated '.repeat(2600) + 'COMPLETE_TAIL' });
  const opts = { transcriptUnavailable: unavailable, deliveryTurns: [{ role: 'assistant', dispatchState: 'final', streamId: 'long-worker', sourceRunId: 'long-run', content: full }],
    runs: [{ runId: 'long-run', streamId: 'long-worker', sessionTitle: 'Long worker', reason: 'done', deliveryText: 'not valid JSON',
      dispatchDelivery: { state: 'final', text: full.slice(0, 24000), reason: 'done', repairRunId: 'long-repair' } }] };
  const env = boot(opts), worker = env.W.adopt({ id: 'long-worker', title: 'Long worker', worker: true, parentStreamId: env.W.generalId() });
  A.eq(await env.S.reconcile(worker.id), unavailable ? 0 : 1, 'only a complete final projection may be recovered');
  if (unavailable) {
    A.eq(worker.runIds.length, 0, 'unavailable full output cannot reserve delivery deduplication');
    await call(env, 'station.deliver', { streamId: worker.id, runId: 'long-run', text: full, reason: 'done' });
  }
  A.eq(worker.history[0].content, full, 'the entire accepted answer is retained');
  A.eq(JSON.parse(worker.history[0].content).answer.endsWith('COMPLETE_TAIL'), true, 'structured output remains valid and complete');
  A.eq(await env.S.reconcile(worker.id), 0, 'the complete answer remains single');
}

// New final envelopes prove complete content at preview/storage boundaries; failed reads stay retryable.
for (const size of [23999, 24000, 24001, 199999, 200000, 200001, 210026, 1048576]) {
  const full = JSON.stringify({ answer: 'x'.repeat(size - 26) + 'COMPLETE_TAIL' });
  A.eq(full.length, size, 'fixture hits the exact boundary');
  const textSha256 = require('node:crypto').createHash('sha256').update(full).digest('hex');
  const row = { runId: 'boundary-run', streamId: 'boundary-worker', sessionTitle: 'Boundary worker', reason: 'done',
    dispatchDelivery: { state: 'final', text: full.slice(0, 24000), textLength: full.length, textSha256, reason: 'done' } };
  const opts = { runs: [row], deliveryTurns: [{ role: 'assistant', dispatchState: 'final', sourceRunId: row.runId,
    streamId: row.streamId, content: full, textLength: full.length, textSha256 }] };
  const env = boot(opts), w = env.W.adopt({ id: row.streamId, title: row.sessionTitle, worker: true, parentStreamId: env.W.generalId() });
  A.eq(await env.S.reconcile(w.id), 1, 'complete output recovers at ' + size);
  A.eq(w.history[0].content, full, 'full tail and JSON survive at ' + size);
  A.eq(await env.S.reconcile(w.id), 0, 'complete output is idempotent at ' + size);
}
for (const corrupt of ['truncated', 'changed-tail', 'wrong-run', 'wrong-stream', 'raw', 'missing-length', 'wrong-hash', 'legacy-cap', 'short-preview']) {
  const full = JSON.stringify({ answer: 'validated '.repeat(21000) + 'COMPLETE_TAIL' });
  const textSha256 = require('node:crypto').createHash('sha256').update(full).digest('hex');
  const row = { runId: 'integrity-run', streamId: 'integrity-worker', sessionTitle: 'Integrity worker', reason: 'done',
    dispatchDelivery: { state: 'final', text: full.slice(0, 24000), textLength: full.length, textSha256, reason: 'done' } };
  const good = { role: 'assistant', dispatchState: 'final', sourceRunId: row.runId, streamId: row.streamId,
    content: full, textLength: full.length, textSha256 };
  const bad = { ...good };
  if (corrupt === 'short-preview') { row.dispatchDelivery.text = full.slice(0, 23999); bad.content = full.slice(0, 200000); }
  if (corrupt === 'truncated') bad.content = full.slice(0, 200000);
  if (corrupt === 'changed-tail') bad.content = full.slice(0, -3) + 'X"}';
  if (corrupt === 'wrong-run') bad.sourceRunId = 'repair-run';
  if (corrupt === 'wrong-stream') bad.streamId = 'other-worker';
  if (corrupt === 'raw') bad.dispatchState = 'pending';
  if (corrupt === 'missing-length') delete bad.textLength;
  if (corrupt === 'wrong-hash') bad.textSha256 = '0'.repeat(64);
  if (corrupt === 'legacy-cap') { delete row.dispatchDelivery.textLength; delete row.dispatchDelivery.textSha256; bad.content = full.slice(0, 200000); }
  const opts = { runs: [row], deliveryTurns: [bad] }, env = boot(opts);
  const w = env.W.adopt({ id: row.streamId, title: row.sessionTitle, worker: true, parentStreamId: env.W.generalId() });
  A.eq(await env.S.reconcile(w.id), 0, corrupt + ' cannot masquerade as a complete answer');
  A.eq(w.runIds.length, 0, corrupt + ' cannot reserve deduplication');
  A.eq(w.history.length, 0, corrupt + ' never borrows rejected output');
  Object.assign(row.dispatchDelivery, { textLength: full.length, textSha256 }); opts.deliveryTurns = [good];
  A.eq(await env.S.reconcile(w.id), 1, corrupt + ' can retry with the full authoritative payload');
  A.eq(w.history[0].content, full, corrupt + ' retry retains the full answer');
}

// Recovering hidden worker state must not reconstruct the unrelated chat the reader is using.
for (const text of ['', 'Final worker answer.']) {
  const env = boot({ runs: [{ runId: 'hidden-result', streamId: 'hidden-worker', sessionTitle: 'Hidden worker',
    reason: 'error', deliveryText: text, ts: 1000 }] });
  const worker = env.W.adopt({ id: 'hidden-worker', title: 'Hidden worker', worker: true, parentStreamId: env.W.generalId() });
  const reading = env.W.create('Reading another conversation');
  reading.history.push({ role: 'assistant', content: 'Keep this reading position.', ts: 500 });
  await call(env, 'station.dispatch_end', { streamId: worker.id, runId: 'hidden-result' });
  A.eq(env.page.loaded.length, 0, 'hidden worker recovery never reloads the active chat');
  A.eq(env.page.delivered.length, 0, 'hidden worker recovery never appends to an unrelated chat');
  A.eq(env.W.activeId(), reading.id, 'reader focus stays in the unrelated chat');
  A.ok(env.page.repainted > 0 && env.page.persisted > 0, 'worker state and durable save still refresh');
}

// Healing a missed older attempt must never make it the worker's newest result or stop a newer live retry.
for (const text of ['', 'Older partial work.']) {
  const runs = [
    { runId: 'new-result', streamId: 'healed-worker', sessionTitle: 'Healed worker', reason: 'done', deliveryText: 'New result.', ts: 2000 },
    { runId: 'missed-attempt', streamId: 'healed-worker', sessionTitle: 'Healed worker', reason: 'error', deliveryText: text, ts: 1000 }
  ];
  const env = boot({ runs });
  const worker = env.W.adopt({ id: 'healed-worker', title: 'Healed worker', worker: true, parentStreamId: env.W.generalId() });
  await call(env, 'station.deliver', { ...runs[0], text: runs[0].deliveryText });
  await call(env, 'station.dispatch_start', { streamId: worker.id, runId: 'live-retry' });
  const healed = await env.S.reconcile(worker.id);
  A.eq(worker.runIds.join(','), 'missed-attempt,new-result', 'recovered older attempt stays before the known newer result');
  A.eq(worker.lastRunReason, 'done', 'older recovery preserves the newest measured outcome');
  A.eq(worker.lastRunOk, true, 'older recovery preserves the newest success flag');
  A.eq(worker.lastActiveAt, 2000, 'older recovery does not move activity backwards');
  A.eq(env.C.runIdOf(worker.id), 'live-retry', 'older recovery does not clear a newer live channel');
  A.eq(env.C.isBusy(worker.id), true, 'the newer retry remains busy');
  A.eq(healed, text ? 1 : 0, 'only a recovered answer counts as delivered');
  A.eq(worker.history.at(-1).content, 'New result.', 'recovery keeps the newest answer last');
  A.eq(env.page.save.workstreams.find(w => w.id === worker.id).runIds.join(','), 'missed-attempt,new-result', 'recovery persists the corrected run order even for an empty failure');
  const staleEnd = await call(env, 'station.dispatch_end', { streamId: worker.id, runId: 'missed-attempt' });
  A.eq(staleEnd.result.settled, false, 'a delayed old end event does not claim to settle the newer channel');
  A.eq(env.C.runIdOf(worker.id), 'live-retry', 'a delayed old end event cannot clear the retry');
  await call(env, 'station.deliver', { ...runs[0], text: runs[0].deliveryText });
  A.eq(env.C.runIdOf(worker.id), 'live-retry', 'a duplicate prior delivery cannot clear the retry');
}

{
  const env = boot({ runs: [{ runId: 'missed-before-live', streamId: 'active-worker', sessionTitle: 'Active worker', reason: 'error', deliveryText: '', ts: 1000 }] });
  const worker = env.W.adopt({ id: 'active-worker', title: 'Active worker', worker: true, parentStreamId: env.W.generalId() });
  env.W.appendRun(worker.id, 'live-not-recorded-yet', 2000);
  await call(env, 'station.dispatch_start', { streamId: worker.id, runId: 'live-not-recorded-yet' });
  await env.S.reconcile(worker.id);
  A.eq(worker.runIds.join(','), 'missed-before-live,live-not-recorded-yet', 'the current channel anchors recovery before its run reaches the server record');
  A.eq(worker.lastRunReason, '', 'a live unconfirmed outcome stays unknown while an old failure is recovered');
  A.eq(worker.lastRunOk, null, 'a live unconfirmed success flag stays unknown');
}

// ---- task board verbs: canonical kind:'task' Workstreams, durable read-back, and semantic idempotency ----
{
  const env = boot({ agents: () => [{ id: 'builder', name: 'BUILDER' }] });
  const first = await call(env, 'station.new_task', { title: 'Fix release check', agentId: 'builder' });
  A.eq(first.ok, true, 'a board card is durably created');
  A.eq(first.result.durable, true, 'the ack says durability was read back, not merely attempted');
  A.eq(first.result.created, true, 'the first request minted one card');
  const card = env.W.get(first.result.id);
  A.eq(card.kind, 'task', 'the authoritative workstream is explicitly a task');
  A.eq(card.agentId, 'builder', 'assignment is stored on that same card');
  const again = await call(env, 'station.new_task', { title: 'FIX RELEASE CHECK', agentId: 'builder' });
  A.eq(again.ok, true, 'a repeated create is a successful idempotent read-back');
  A.eq(again.result.duplicate, true, 'and reports that it reused the card');
  A.eq(env.W.list({ includeArchived: true }).filter(w => w.kind === 'task').length, 1, 'the mutation happened exactly once');
  const listed = await call(env, 'station.tasks', {});
  A.eq(listed.result.tasks.length, 1, 'task.list projects the canonical board store');

  const moved = await call(env, 'station.manage_task', { task: 'Fix release check', action: 'move', lane: 'active' });
  A.eq(moved.ok, true, 'a task can move lanes');
  A.eq(env.W.get(card.id).lane, 'active', 'the real board state changed');
  const same = await call(env, 'station.manage_task', { task: card.id, action: 'move', lane: 'active' });
  A.eq(same.result.changed, false, 'repeating a state-setting mutation is a no-op');
  const restartSave = JSON.parse(JSON.stringify(env.page.save));
  env.W.reset();
  env.W.init(restartSave);
  A.eq(env.W.get(card.id).lane, 'active', 'a fresh Workstreams boot restores the durable card and lane');
  A.eq((await call(env, 'station.tasks', {})).result.tasks[0].id, card.id, 'the post-restart model read and UI store identify the same card');
  const removed = await call(env, 'station.manage_task', { task: card.id, action: 'remove' });
  A.eq(removed.ok, true, 'remove persists');
  A.ok(env.page.save.deletedIds.indexOf(card.id) >= 0, 'its durable tombstone prevents restart resurrection');
}

{
  const env = boot({ saveFails: true });
  const out = await call(env, 'station.new_task', { title: 'Cannot claim this' });
  A.eq(out.ok, false, 'a refused durable write is never reported as success');
  A.ok(/do not report/.test(out.error), 'the refusal tells the model not to claim completion');
}

// two browser pages can hold different local ids for the SAME named session. Delivery resolves by the stable
// exact title when this page does not know the id chosen by the other page.
{
  const env = boot();
  const local = env.W.create('business research session');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.deliver', {
    streamId: 'ws_other_page', sessionTitle: 'business research session',
    agentId: 'researcher', runId: 'split-1', prompt: 'find three ideas', text: 'three sourced ideas'
  });
  A.eq(out.ok, true, 'split-brain delivery succeeds by stable title');
  A.eq(out.result.resolvedBy, 'title', 'the ack says the id mismatch was healed by title');
  A.eq(env.W.get(local.id).history[1].content, 'three sourced ideas', 'the page the Commander is viewing receives the answer');
  A.ok(env.W.get(local.id).runIds.indexOf('split-1') >= 0, 'the local session records the durable run id');
}

// a real delegated run makes its TARGET session visibly busy without stealing focus; final delivery settles it.
{
  const env = boot();
  const ws = env.W.create('research');
  env.W.switch(env.W.generalId());
  const started = await call(env, 'station.dispatch_start', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-1'
  });
  A.eq(started.ok, true, 'dispatch start is acknowledged');
  A.ok(env.C.isBusy(ws.id), 'the target session is visibly busy');
  A.eq(env.C.runIdOf(ws.id), 'live-1', 'its status is backed by the real worker run id');
  A.eq(env.W.activeId(), env.W.generalId(), 'marking the target busy does not steal the Commander from General');
  const settled = await call(env, 'station.dispatch_end', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-1'
  });
  A.eq(settled.ok, true, 'dispatch end is acknowledged');
  A.ok(!env.C.isBusy(ws.id), 'an errored or stopped worker also settles the target session');
  await call(env, 'station.dispatch_start', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-2'
  });
  await call(env, 'station.deliver', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-2', text: 'done'
  });
  A.ok(!env.C.isBusy(ws.id), 'final delivery settles the target session');
}

// missed delivery heals from the durable /api/runs envelope on boot/open, even when another page minted the id.
{
  const env = boot({ runs: [{
    runId: 'heal-1', agentId: 'researcher', reason: 'done', streamId: 'ws_other_page',
    sessionTitle: 'business research session', deliveryPrompt: 'research it',
    deliveryText: 'durable finished brief', ts: 1234
  }] });
  const local = env.W.create('business research session');
  env.W.switch(env.W.generalId());
  const healed = await env.S.reconcile(local.id);
  A.eq(healed, 1, 'one missed delegated run was healed');
  A.eq(env.W.get(local.id).history[1].content, 'durable finished brief', 'the durable answer appears in the visible session');
  A.eq(await env.S.reconcile(local.id), 0, 'reconciliation is idempotent by runId');
  A.eq(env.W.get(local.id).history.length, 2, 'the healed answer appears exactly once');
}

/* org live walk 2026-10-14: a delegated report that finished while the app was closed showed TWICE. Opening the session
   merged its durable transcript first (the answer as an assistant row with its sourceRunId, ws.runIds untouched); the
   /api/runs recovery then saw no runId and spliced the same answer in again — and the copy was saved. */
{
  const env = boot({ runs: [{
    runId: 'away-1', agentId: 'agent', reason: 'done', streamId: 'ws_general_x',
    sessionTitle: 'General', deliveryPrompt: 'review the crew work',
    deliveryText: 'review complete: ship it', ts: 2000
  }] });
  const g = env.W.get(env.W.generalId());
  env.W.appendRun(g.id, 'earlier-run', 1000);
  // what Chat.reconcileServerHistory leaves behind after merging the durable transcript on open
  g.history.push({ role: 'user', content: 'get the launch ready', ts: 900 },
    { role: 'assistant', content: 'review complete: ship it', sourceRunId: 'away-1', agentId: 'agent', ts: 2000 });
  const before = g.history.length;
  A.eq(await env.S.reconcile(g.id), 0, 'an answer the transcript merge already filed is not folded again');
  A.eq(g.history.length, before, 'the away report renders exactly once');
  A.eq(g.history.filter(m => m.sourceRunId === 'away-1').length, 1, 'one row carries that run');
  A.ok(g.runIds.indexOf('away-1') >= 0, 'the merged run joins the session run list, so its outcome is recorded');
  A.eq(g.lastRunReason, 'done', 'and its real outcome is settled');
  A.eq(await env.S.reconcile(g.id), 0, 'later passes stay idempotent');
  const again = await call(env, 'station.deliver', { streamId: g.id, agentId: 'agent', runId: 'away-1', text: 'review complete: ship it' });
  A.eq(again.result.reason, 'already delivered', 'a late live hand-off of the same run is refused as already delivered');
  A.eq(g.history.length, before, 'still exactly once');
}

// delivering into the session the Commander is WATCHING re-renders it immediately
{
  const env = boot();
  const ws = env.W.create('research');       // create() activates it
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'done' });
  A.eq(env.page.delivered[0].id, ws.id, 'the open session receives the new turns without a reload');
  A.eq(env.page.loaded.length, 0, 'delivery preserves existing reader DOM');
  A.ok(!env.W.unread(ws.id), 'and it is not marked unread — it is on screen');
}

/* ⛔ APPEND, NEVER REPLACE. A targeted session usually already holds the Commander's own conversation. The
   cron auto-session path may replace a history because it OWNS its stream; this one does not, and replacing
   here would silently delete the thread the Commander asked to add work to. */
{
  const env = boot();
  const ws = env.W.create('research');
  ws.history.push({ role: 'user', content: 'my own question' }, { role: 'assistant', content: 'my own answer' });
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'delegated result' });
  const h = env.W.get(ws.id).history;
  A.eq(h.length, 3, 'the existing conversation survives');
  A.eq(h[0].content, 'my own question', 'the Commander\'s first turn is untouched');
  A.eq(h[2].content, 'delegated result', 'the delegated answer is appended after it');
}

// the same run never posts twice (a retry, a duplicate command, a re-delivered background worker)
{
  const env = boot();
  const ws = env.W.create('research');
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'once' });
  const second = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'once' });
  A.eq(second.ok, true, 'a repeat delivery is not an error');
  A.eq(second.result.folded, false, 'but it reports that nothing was folded');
  A.eq(env.W.get(ws.id).history.length, 1, 'and the answer appears exactly once');
}

// ---- refusals: every one is ok:false with a reason, never a quiet success ----
{
  const env = boot();
  const ws = env.W.create('research');
  const gone = await call(env, 'station.deliver', { streamId: 'ws_nope', agentId: 'r', runId: 'x', text: 'hi' });
  A.eq(gone.ok, false, 'delivering to a session that does not exist fails');
  A.ok(/no session with id ws_nope/.test(gone.error), 'and says so precisely');
  const empty = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'r', runId: 'x', text: '   ' });
  A.eq(empty.ok, false, 'an empty answer is refused rather than posting a blank turn');
  A.eq(env.W.get(ws.id).history.length, 0, 'and nothing was written');
  const unknown = await call(env, 'station.nonsense', {});
  A.eq(unknown.ok, false, 'an unknown verb fails instead of resolving true');
  A.ok(/unknown station verb/.test(unknown.error), 'naming the verb it could not run');
}

// station.status refuses honestly when the view is not up yet (rather than inventing an empty station)
{
  const env = boot();
  const out = await call(env, 'station.status', {});
  A.eq(out.ok, false, 'no VoiceLive snapshot yet -> an honest refusal');
  A.ok(/not ready/.test(out.error), 'and it says the view is not ready');
}

// station.crew reports the real roster, and refuses when there is none
{
  const empty = boot({ agents: () => [] });
  A.eq((await call(empty, 'station.crew', {})).ok, false, 'an empty roster is a refusal, not a fake crew');
  const crewed = boot({ agents: () => [{ id: 'researcher', name: 'RESEARCHER', model: 'm1' }] });
  const out = await call(crewed, 'station.crew', {});
  A.eq(out.ok, true, 'a real roster answers');
  A.eq(out.result.crew[0].id, 'researcher', 'with the ids a dispatch has to address');
}

/* ---- station.new_session: the agent can OPEN a session by name — the half "make a session called
   research and have them work in it" was missing (dispatch could target one, nothing could create one) ---- */
{
  const env = boot({ agents: () => [{ id: 'researcher', name: 'RESEARCHER' }] });
  const out = await call(env, 'station.new_session', { title: 'research', agentId: 'researcher' });
  A.eq(out.ok, true, 'a named session is created');
  A.eq(out.result.title, 'research', 'with the title the Commander said');
  A.eq(out.result.agentId, 'researcher', 'bound to the named crew member');
  A.eq(out.result.focused, false, 'not focused unless asked');
  A.ok(env.W.list().some(w => w.title === 'research'), 'and it exists in the real session store');
  A.eq(env.W.activeId(), env.W.generalId(), 'a background create never steals what the Commander is looking at');
  A.ok(env.page.rail > 0 && env.page.persisted > 0, 'the rail re-rendered and the save was written');

  // focus:true is the explicit "open it" ask — active session moves, thread renders
  const f = await call(env, 'station.new_session', { title: 'billing', focus: true });
  A.eq(f.ok, true, 'a focused create succeeds');
  A.eq(env.W.activeId(), f.result.id, 'and the Commander is now looking at it');
  A.eq(env.page.loaded[env.page.loaded.length - 1], f.result.id, 'the thread rendered');
}

// a duplicate title is REFUSED — a twin would make every later name-addressed action ambiguous
{
  const env = boot();
  env.W.create('research');
  const dup = await call(env, 'station.new_session', { title: 'RESEARCH' });
  A.eq(dup.ok, false, 'a case-different duplicate is still a duplicate');
  A.ok(/already exists/.test(dup.error), 'and the refusal says so');
  const gen = await call(env, 'station.new_session', { title: 'General' });
  A.eq(gen.ok, false, 'the untitled home stream\'s display name is reserved too');
  const ghost = await call(env, 'station.new_session', { title: 'ops', agentId: 'nobody' });
  A.eq(ghost.ok, false, 'an unknown agentId is refused, not silently dropped');
  A.ok(/no crew member/.test(ghost.error), 'naming what was wrong');
  A.ok(!env.W.list().some(w => w.title === 'ops'), 'and no session was created');
}

/* ---- station.switch_session: focus by the name the Commander says — same resolution law as dispatch
   (exact id → exact title → unique substring; anything else refuses with the real names) ---- */
{
  const env = boot();
  const r = env.W.create('research');
  env.W.create('Billing rewrite');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.switch_session', { session: 'research' });
  A.eq(out.ok, true, 'an exact title switches');
  A.eq(env.W.activeId(), r.id, 'the Commander is now looking at it');
  A.eq(env.page.loaded[env.page.loaded.length - 1], r.id, 'and the thread rendered');
  const part = await call(env, 'station.switch_session', { session: 'billing' });
  A.eq(part.ok, true, 'a unique substring resolves');
  const gen = await call(env, 'station.switch_session', { session: 'general' });
  A.eq(gen.ok, true, 'the home stream is addressable by the name the UI shows');
  A.eq(env.W.activeId(), env.W.generalId(), 'and focuses General');
}

// the refusals — never a guess, and always the list the model needs to correct itself
{
  const env = boot();
  env.W.create('research plan');
  env.W.create('research notes');
  env.W.switch(env.W.generalId());   // the Commander is looking at General; a refusal must leave them there
  const ambig = await call(env, 'station.switch_session', { session: 'research' });
  A.eq(ambig.ok, false, 'an ambiguous name refuses');
  A.ok(/more than one session matches/.test(ambig.error) && /research plan/.test(ambig.error), 'explaining the ambiguity with the real names');
  A.eq(env.W.activeId(), env.W.generalId(), 'and the focus did NOT move');
  const none = await call(env, 'station.switch_session', { session: 'marketing' });
  A.eq(none.ok, false, 'an unknown name refuses');
  A.ok(/no session called "marketing"/.test(none.error) && /research plan/.test(none.error), 'and lists what does exist');
}

/* ---- station.read_session: the agent's EYES into other sessions. Exists because a lead asked "what did
   the researcher do?" had no way to look, GUESSED, and denied real finished work to the Commander. ---- */
{
  const env = boot();
  const ws = env.W.create('research');
  ws.history.push(
    { role: 'user', content: 'my question' },
    { role: 'system', sys: true, content: '— delegated to researcher: summarise X —' },
    { role: 'assistant', agentId: 'researcher', content: 'Phobos and Deimos, both captured asteroids.' },
    { role: 'assistant', content: 'a hidden one', hidden: true }
  );
  const out = await call(env, 'station.read_session', { session: 'research' });
  A.eq(out.ok, true, 'a named session can be read');
  A.eq(out.result.title, 'research', 'with its real title');
  A.eq(out.result.turns.length, 3, 'visible turns only — hidden/internal rows never leak');
  A.eq(out.result.turns[0].speaker, 'commander', 'the Commander\'s turns are labeled');
  A.eq(out.result.turns[1].speaker, 'station', 'sys markers are labeled as the station, not as speech');
  A.eq(out.result.turns[2].speaker, 'researcher', 'delegated work is attributed to the worker who did it');
  A.ok(/Phobos/.test(out.result.turns[2].text), 'and carries the real content');
  A.eq(out.result.busy, false, 'busy state rides along so "still working" is answerable');

  // an empty session says so — an empty turns array alone reads like "nothing happened", which is a claim
  const blank = env.W.create('empty one');
  const b = await call(env, 'station.read_session', { session: 'empty one' });
  A.eq(b.result.turns.length, 0, 'no visible turns');
  A.ok(/no visible conversation yet/.test(b.result.note), 'stated, not implied');

  // same resolution law as every other name-addressed verb
  const nope = await call(env, 'station.read_session', { session: 'marketing' });
  A.eq(nope.ok, false, 'an unknown name refuses');
  A.ok(/no session called "marketing"/.test(nope.error) && /research/.test(nope.error), 'with the real names');
  // the limit clamps
  const lim = await call(env, 'station.read_session', { session: 'research', limit: 2 });
  A.eq(lim.result.turns.length, 2, 'limit returns the most recent N');
  A.eq(lim.result.turns[1].speaker, 'researcher', 'and they are the LAST turns, not the first');
}

/* ---- station.read_session: a goal-loop step is the STATION's prompt, never the Commander's words (org P29-sys wiring) —
   a lead reading it must not tell the user "you asked me to continue…" ---- */
{
  const env = boot();
  const GL = require('../frontend/app/goalloop.js');
  const ws = env.W.create('launch');
  ws.history.push(
    { role: 'user', content: 'set up the launch' },
    { role: 'user', content: GL.continuationPrompt(GL.create('ship the landing page', { now: 1 })) },
    { role: 'user', content: '[Continuing toward your standing goal]\nGoal: old goal\n\nContinue working toward this goal. ' },
    { role: 'assistant', content: 'Drafted the hero.' }
  );
  const out = await call(env, 'station.read_session', { session: 'launch' });
  A.eq(out.result.turns.map(t => t.speaker), ['commander', 'station', 'station', 'agent'], 'goal steps (current + pre-org-pass head) read as the station');
  A.eq(out.result.turns[1].text, 'Goal step: ship the landing page', '…naming the goal, never the internal prompt');
  A.eq(out.result.turns[1].sys, true, '…flagged as a station line');
  A.eq(out.result.turns[2].text, 'Goal step: old goal', 'an old saved step too');
}

/* ---- the voice-call rebind hook: a switch DURING a live call re-targets the call (it came through the
   call); with no live call the verb must not touch VoiceLive at all ---- */
{
  const env = boot();
  env.W.create('research');
  const rebinds = [];
  // stationcommands probes the VoiceLive global by bare identifier — inject it into the vm context
  env.setVoiceLive({ isActive: () => true, boundSessionId: () => 'call-origin', rebind: id => rebinds.push(id) });
  const out = await call(env, 'station.switch_session', { session: 'research', origin: {streamId:'call-origin',runId:'run'} });
  A.eq(out.ok, true, 'the switch succeeded');
  A.eq(rebinds.length, 1, 'a live call is rebound by a voice-driven switch');
  A.eq(rebinds[0], out.result.id, 'to the session the switch landed on');
  env.setVoiceLive({ isActive: () => false, rebind: id => rebinds.push(id) });
  await call(env, 'station.switch_session', { session: 'General' });
  A.eq(rebinds.length, 1, 'no live call -> no rebind attempted');
}

// A stale/background request is refused before any selection or creation side effect.
{
  const env = boot({canFocusSession: () => false});
  const target = env.W.create('target', {activate:false});
  const original = env.W.activeId(), count = env.W.list().length;
  const switched = await call(env, 'station.switch_session', {session:target.id});
  A.eq(switched.ok, false, 'unattributed focus is refused');
  A.eq(env.W.activeId(), original, 'the selected session stays put');
  A.eq(env.page.loaded.length, 0, 'the visible composer is not rebound');
  const made = await call(env, 'station.new_session', {title:'stale create', focus:true});
  A.eq(made.ok, false, 'stale focused creation is refused');
  A.eq(env.W.list().length, count, 'refusal leaves no partially-created session');
  const background = await call(env, 'station.new_session', {title:'background', focus:false});
  A.eq(background.ok, true, 'background creation remains available');
  A.eq(env.W.activeId(), original, 'background creation does not navigate');
}

// every verb the sidecar can ask for is implemented here (a missing one would fail as "unknown verb" live)
{
  const env = boot();
  const verbs = env.S.verbs();
  for (const v of ['station.status', 'station.crew', 'station.sessions', 'station.deliver', 'station.new_session', 'station.switch_session']) {
    A.ok(verbs.indexOf(v) >= 0, 'the page implements ' + v);
  }
  for (const file of ['orchestration.js', 'station.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', file), 'utf8');
    for (const m of src.match(/(?:station|ask)\('(station\.[^']+)'/g) || []) {
      const verb = /'([^']+)'/.exec(m)[1];
      A.ok(verbs.indexOf(verb) >= 0, file + ' asks for ' + verb + ', and the page can answer it');
    }
  }
}

/* fix round 4 (2026-10-20): A RECONCILE READ THE SIDECAR NEVER ANSWERS ENDS AT ITS DEADLINE. reconcile() is memoized on
   the pass in flight, and its /api/runs and /api/transcript reads had no deadline: one the sidecar accepted and never
   answered held that pass — and every later reconcile, which joined it — for good (the overseer's ledger beat awaited it
   too, so /api/overseer was never asked again). Each read now carries U.timeoutSignal(15 s): the REAL util.js, on a fake
   timer queue (its AbortController fallback, as on older macOS WebKit). */
{
  const timers = [];
  const uctx = vm.createContext({ AbortController, DOMException, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  const realU = vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'util.js'), 'utf8') + '\n;U;', uctx);
  const U = { bus: { on: () => {} }, timeoutSignal: ms => realU.timeoutSignal(ms) };
  const settled = p => Promise.race([p, new Promise(r => setTimeout(() => r('still hung'), 300))]);
  const fire = ms => { const due = timers.filter(t => t.ms === ms && !t.fired); due.forEach(t => { t.fired = true; t.fn(); }); return due.length; };

  // the run index read hangs
  let reads = [], hangRuns = true;
  let env = boot({ U, reads, hang: url => hangRuns && url.indexOf('/api/runs') === 0 });
  const first = env.S.reconcile(), joined = env.S.reconcile();
  A.eq(reads.length, 1, 'fixture: a second reconcile while the first is out joins it');
  A.eq(reads[0].deadline, true, 'the /api/runs read carries a deadline (it had none)');
  A.eq(fire(15000), 1, '…of 15 s');
  A.eq(await settled(first), -1, 'a run index read the sidecar never answers ends at its deadline: the pass settles, folding nothing and saying the list was never read (-1, so the overseer retries)');
  A.eq(await settled(joined), -1, '…and so does every reconcile that joined it');
  hangRuns = false;
  await settled(env.S.reconcile());
  A.eq(reads.length, 2, 'the next reconcile reads again, no longer held by the hung pass');

  // the run index answers; the full-delivery read behind it hangs
  const full = JSON.stringify({ answer: 'y'.repeat(30000) + 'COMPLETE_TAIL' });
  const textSha256 = require('node:crypto').createHash('sha256').update(full).digest('hex');
  const row = { runId: 'hung-run', streamId: 'hung-worker', sessionTitle: 'Hung worker', reason: 'done',
    dispatchDelivery: { state: 'final', text: full.slice(0, 24000), textLength: full.length, textSha256, reason: 'done' } };
  reads = []; let hangTranscript = true;
  env = boot({ U, reads, runs: [row], hang: url => hangTranscript && url.indexOf('/api/transcript') === 0,
    deliveryTurns: [{ role: 'assistant', dispatchState: 'final', sourceRunId: row.runId, streamId: row.streamId, content: full, textLength: full.length, textSha256 }] });
  const w = env.W.adopt({ id: row.streamId, title: row.sessionTitle, worker: true, parentStreamId: env.W.generalId() });
  const pass = env.S.reconcile(w.id);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  A.ok(reads.some(r => r.url.indexOf('/api/transcript') === 0 && r.deadline), 'the full-delivery read carries a deadline too');
  fire(15000);
  A.eq(await settled(pass), 0, 'a full-delivery read the sidecar never answers ends at its deadline: nothing half-folded');
  A.eq(w.history.length, 0, '…and the session holds no truncated answer');
  hangTranscript = false;
  A.eq(await settled(env.S.reconcile(w.id)), 1, 'the next reconcile recovers the complete answer');
}

/* ---- a session whose SAVED history is packed (save v7: it names rows the station holds, the page has not read them back) ----
   station.read_session must read them back before it reads out, station.deliver before it asks whether the answer is filed:
   a lead told "no visible conversation yet" about a session the page simply has not read is the guess these verbs end ---- */
{
  const HR = require('../frontend/app/historyref.js');
  const station = { 1: { rowId: 1, role: 'user', content: 'what did the researcher find?', ts: 1 }, 2: { rowId: 2, role: 'assistant', agentId: 'researcher', content: 'Phobos and Deimos.', sourceRunId: 'run-filed', ts: 2 } };
  // the page's station-backed reader: the real expand over a fake transport that returns what it holds (ids in `lost` are never returned)
  const reader = (lost) => async (ws) => {
    const ref = ws.historyRef, out = await HR.expand(ref, { streamId: ws.id, fetchRows: async (_stream, ids) => ({ turns: ids.filter(id => station[id] && !(lost || []).includes(id)).map(id => Object.assign({}, station[id])) }) });
    env.W.hydrate(ws, out.rows, { ref });
    return { complete: !ws.historyRef };
  };
  let env = boot({ hydrateHistory: (ws) => env.reading(ws) });
  const seed = () => env.W.init({ workstreams: [{ id: 'packed', title: 'research', history: [{ $ref: '1,1' }, { role: 'system', sys: true, content: '— a note —', ts: 3 }], runIds: [], createdAt: 1, lastActiveAt: 1, lastReadAt: 1 }], activeId: 'packed', generalId: 'packed' });

  seed(); env.reading = reader();
  const whole = await call(env, 'station.read_session', { session: 'research' });
  A.eq(whole.ok, true, 'a packed session can be read');
  A.eq(whole.result.turns.map(t => t.speaker + ':' + t.text), ['commander:what did the researcher find?', 'researcher:Phobos and Deimos.', 'station:— a note —'], 'its rows are read back first: the lead is told the whole conversation, in order');
  A.eq([whole.result.incomplete, whole.result.note], [undefined, undefined], 'and nothing is flagged: it is whole');
  A.eq(env.W.needsHydration('packed'), false, 'the page holds the rows now');

  seed(); env.reading = reader([2]);
  const part = await call(env, 'station.read_session', { session: 'research' });
  A.eq(part.ok, true, 'a conversation the station could not return all of is still read out');
  A.eq(part.result.turns.map(t => t.text), ['what did the researcher find?', '— a note —'], 'with the rows that came back');
  A.eq(part.result.incomplete, true, 'and says it is incomplete');
  A.ok(/could not be read back yet/.test(part.result.note) && !/no visible conversation/.test(part.result.note), 'in words that never claim there is nothing to read');

  seed(); env.reading = async () => ({ complete: false });
  env.W.get('packed').history.length = 0;
  const none = await call(env, 'station.read_session', { session: 'research' });
  A.eq(none.result.turns.length, 0, 'a session with no row held at all');
  A.ok(none.result.incomplete === true && !/no visible conversation/.test(none.result.note), 'is never reported as "no visible conversation yet": the rows exist, the page could not read them');

  // station.deliver: the answer this run already filed is in a packed row; it is read back before the filed check, so it is not filed twice
  seed(); env.reading = reader();
  const again = await call(env, 'station.deliver', { streamId: 'packed', agentId: 'researcher', runId: 'run-filed', text: 'Phobos and Deimos.' });
  A.eq([again.ok, again.result.folded, again.result.reason], [true, false, 'already delivered'], 'a run whose answer is in a packed row is recognised as filed once the rows are back');
  A.eq(env.W.get('packed').history.filter(m => m.role === 'assistant').length, 1, 'and the answer is in the conversation once');
  seed(); env.reading = reader();
  const fresh = await call(env, 'station.deliver', { streamId: 'packed', agentId: 'researcher', runId: 'run-new', text: 'A new finding.' });
  A.eq([fresh.ok, fresh.result.folded], [true, true], 'a new answer is filed');
  A.eq(env.W.get('packed').history.map(m => m.content), ['what did the researcher find?', 'Phobos and Deimos.', '— a note —', 'A new finding.'], 'after the whole conversation, not among the few rows the page kept');
}

A.report('station-commands.test');

})().catch(error => { console.error(error); process.exit(1); });
