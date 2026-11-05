/* node test/turn-merge.family.test.js — every page dialogue writer names its turn (turn identity, commit 3: the send side).

   The desk page holds no id logic of its own: frontend/app/turnmerge.js mints, sends and binds, and chat.js makes one call
   to it at each site. This file proves
     A. TurnMerge's send side (pendingRow, newTurnId, sendIds, bindStart, ofTurn) as a pure module
     B. chat.js: the optimistic user row, the ids Harness.chat posts (none on a recovery continuation), the run.start bind,
        the reply, partial, stopped and work-line hop rows, and retryLast — each through TurnMerge; persistPartial and
        markStoppedTurn are RUN in a sandbox and their rows carry the in-flight turn
     C. harness.js posts the ids, and hands the lead's FIRST agent.run.start payload to onRunId inside the existing guard
     D. autosessions.js: a routine session's seed row names the fire's directive ('r' + runId) and the run that answered it
     E. the channel hub (real hub, real channel store, in-memory disk): a chat message's run names its turn by its durable
        receipt ('ch' + 16 hex chars) and the receipt's station time; the recovered second go after a restart names the
        SAME turn; a different message names a different one */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pathMod = require('path');
const TurnKinds = require('../frontend/app/turnkinds.js');
const TurnMerge = require('../frontend/app/turnmerge.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const chat = read('frontend/app/chat.js');
const harness = read('frontend/app/harness.js');
const autos = read('frontend/app/autosessions.js');
const commands = read('frontend/app/stationcommands.js');
const phone = read('sidecar/remote/host.js');
let seed = 7;
const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ---------------------------------------------------------------- A. the module
{
  const row = { role: 'user', content: 'plan the trip', ts: 1700 };
  const named = TurnMerge.pendingRow(row, rng);
  A.ok(TurnKinds.isTurnId(named.turnId) && /^t[0-9a-z]{24}$/.test(named.turnId), 'pendingRow mints a desk turnId (t + 24 base36): ' + named.turnId);
  A.eq(named.turnAt, 1700, 'pendingRow stamps the page-only turnAt from the row\'s own ts');
  A.ok(!('turnId' in row), 'pendingRow never mutates the row it was handed');
  A.eq(TurnMerge.pendingRow(named, rng), named, 'a row that already holds a turnId is returned as is');
  A.ok(TurnMerge.newTurnId(rng) !== TurnMerge.newTurnId(rng), 'newTurnId draws a fresh id each call');

  const hist = [{ role: 'user', content: 'old', turnId: 'tOLDOLDOLDOLDOLDOLD00000', turnAt: 10, rowId: 3 }, { role: 'assistant', content: 'a' }, named];
  A.eq(TurnMerge.sendIds(hist, { now: 2000 }), { turnId: named.turnId, turnAt: 1700, clientNow: 2000 }, 'a send names the newest user row\'s turn and its time pair');
  A.eq(TurnMerge.sendIds(hist, { retry: true, retryRow: hist[0], now: 2000 }), { turnId: hist[0].turnId, retryOf: hist[0].turnId, turnAt: 10, clientNow: 2000, turnRowId: 3 }, 'a retry names the retried row, retryOf, and its bound rowId');
  A.eq(TurnMerge.sendIds([{ role: 'user', content: 'legacy', ts: 5 }], { now: 9 }), {}, 'a row without a turnId sends no ids (the legacy retry path)');
  A.eq(TurnMerge.sendIds([{ role: 'user', content: 'x', turnId: named.turnId, turnAt: -1 }], { now: 9 }), { turnId: named.turnId }, 'a bad turnAt sends no time pair');
  A.eq(TurnMerge.sendIds([{ role: 'user', content: 'x', turnId: named.turnId, turnAt: 4 }], {}), { turnId: named.turnId }, 'no client now: no time pair');

  // bindStart: the echo binds the row this send named
  const rows = [{ role: 'user', content: 'u1', turnId: named.turnId }];
  let b = TurnMerge.bindStart(rows, { runId: 'run1', turnId: named.turnId, directiveRowId: 12 }, 'run1', { turnId: named.turnId });
  A.eq(b, { index: 0, rekeyed: false, turnId: named.turnId }, 'bindStart finds the named row');
  A.eq([rows[0].sourceRunId, rows[0].rowId], ['run1', 12], 'and binds its run and directive rowId');
  // re-key: the station answered the send as another turn
  const R2 = TurnKinds.runTurnId('run-0002-abcdef'), R3 = TurnKinds.runTurnId('run-0003-abcdef'), RS = TurnKinds.runTurnId('source-run-0001');
  A.ok([R2, R3, RS].every(TurnKinds.isTurnId), 'fixture: the station mints are valid turnIds');
  const rk = [{ role: 'user', content: 'u2', turnId: 'tAAAAAAAAAAAAAAAAAAAAAAAA' }];
  b = TurnMerge.bindStart(rk, { turnId: R2, directiveRowId: 20 }, 'run-0002-abcdef', { turnId: 'tAAAAAAAAAAAAAAAAAAAAAAAA' });
  A.eq([b.rekeyed, b.turnId, rk[0].turnId, rk[0].rowId], [true, R2, R2, 20], 'a differing echo re-keys an unbound row and binds the new directive');
  // a bound row keeps its id; the run answers the echoed turn
  const bound = [{ role: 'user', content: 'u3', turnId: 'tBBBBBBBBBBBBBBBBBBBBBBBB', rowId: 7, sourceRunId: 'run0' }];
  b = TurnMerge.bindStart(bound, { turnId: R3, directiveRowId: 30 }, 'run-0003-abcdef', { turnId: 'tBBBBBBBBBBBBBBBBBBBBBBBB' });
  A.eq([b.rekeyed, b.turnId, bound[0].turnId, bound[0].rowId, bound[0].sourceRunId], [false, R3, 'tBBBBBBBBBBBBBBBBBBBBBBBB', 7, 'run0'], 'a row bound to a directive keeps its turn, rowId and run');
  // a recovery continuation named no turn: nothing is bound
  const rec = [{ role: 'user', content: 'later turn', turnId: 'tCCCCCCCCCCCCCCCCCCCCCCCC' }];
  b = TurnMerge.bindStart(rec, { turnId: RS, directiveRowId: 5 }, 'run-0004-abcdef', {});
  A.eq([b.index, b.turnId, rec[0].turnId, 'rowId' in rec[0], 'sourceRunId' in rec[0]], [-1, RS, 'tCCCCCCCCCCCCCCCCCCCCCCCC', false, false], 'a send that named no turn binds nothing; the run answers the echoed turn');
  A.eq(TurnMerge.bindStart(rows, undefined, 'run5', { turnId: named.turnId }).turnId, named.turnId, 'an older station (no echo): the run answers the sent turn');

  A.eq(TurnMerge.ofTurn({ role: 'assistant', content: 'r' }, { turnId: named.turnId, sourceRunId: 'run1' }), { role: 'assistant', content: 'r', turnId: named.turnId, sourceRunId: 'run1' }, 'ofTurn names a reply\'s turn and run');
  A.eq(TurnMerge.ofTurn({ role: 'assistant', content: 'r', sourceRunId: 'own' }, { turnId: 'bad id', sourceRunId: 'x' }), { role: 'assistant', content: 'r', sourceRunId: 'own' }, 'ofTurn keeps the row\'s own run and drops a bad turnId');
  A.eq(TurnMerge.ofTurn({ role: 'assistant', content: 'r' }, undefined), { role: 'assistant', content: 'r' }, 'ofTurn with no ids is a plain copy');
}

// ---------------------------------------------------------------- B. chat.js
{
  const reconcile = A.fnBody(chat, 'async function reconcileServerHistory(');
  A.eq((reconcile.match(/TurnMerge\.reconcile\(/g) || []).length, 1, 'the page has exactly one shared reconciliation call');
  A.ok(!/const TYPED|const typedMerge|const finals = new Map/.test(chat), 'the page owns no duplicate content/identity merge');
  A.ok(/TurnMerge\.merge\(/.test(phone) && !/const finals = new Map/.test(phone), 'phone delegates to the same shared merge');
  // the one allowance (commit 10): the extension rule for a file chip's media moved to TurnKinds, and the page keeps a one-line delegate to it
  const MEDIA_DELEGATE = 'function mediaKindOf(title) { return TurnKinds.mediaKindOf(title); }';
  A.ok(chat.split(MEDIA_DELEGATE).length === 2 && !/TurnKinds\./.test(chat.replace(MEDIA_DELEGATE, '')), 'chat.js holds no id logic of its own (no direct TurnKinds call but the media-kind delegate; every id goes through TurnMerge)');
  const send = A.fnBody(chat, 'async function send(text, opts) {');
  A.ok(send.length > 5000 && send.length < chat.length / 2, 'send() sliced');
  A.ok(/ws\.history\.push\(TurnMerge\.pendingRow\(attsIn\.length \? \{[^}]*\} : \{[^}]*\}, turnRng\)\)/.test(send), 'the optimistic user row is pushed through TurnMerge.pendingRow');
  A.ok(/const plan = HistoryFit\.sendPlan\(ws\.history, \{ ids: TurnMerge\.sendIds\(ws\.history, \{ retry, retryRow: retryDirectiveTurn, now: Date\.now\(\) \}\), retry, recovery: recoveryResume, historyRead, model: windowModelOf\(ws\) \}\);/.test(send) && /const turnIds = plan\.post;/.test(send), 'the send names its ids through TurnMerge.sendIds and the single recovery-aware window plan');
  const chatCall = send.slice(send.indexOf('await Harness.chat({'), send.indexOf('await Harness.chat({') + 4000);
  A.ok(/\n\s+\.\.\.turnIds,\n/.test(chatCall), 'Harness.chat posts those ids');
  A.ok(/onRunId: \(id, start\) => \{ thisTurnId = TurnMerge\.bindStart\(ws\.history, start, id, turnIds\)\.turnId; liveRunTurns\.set\(ws\.id, \{ turnId: thisTurnId, sourceRunId: id \}\);/.test(send), 'the lead\'s run.start echo binds the named row and the in-flight turn');
  A.ok(/ws\.history\.push\(TurnMerge\.ofTurn\(\{ role: 'assistant', content: replyText, [^}]*\}, \{ turnId: thisTurnId, sourceRunId: thisRunId \}\)\)/.test(send), 'the reply row names its turn and run');
  // (send's finally lies past fnBody's reach: a quote inside a regex class ends the slice early, so this lock reads the file)
  A.eq((chat.match(/aborters\.delete\(ws\.id\);\s+liveRunRoots\.delete\(ws\.id\);\s+liveRunTurns\.delete\(ws\.id\);/g) || []).length, 1, 'the in-flight turn is forgotten with the in-flight root');
  A.ok(!/function runWorkLine\(/.test(chat), 'retired browser hop executor stays absent; host line runner owns later stages');
  const retryLast = A.fnBody(chat, 'function retryLast(');
  A.ok(/h\[i\]\.typedText != null \? h\[i\]\.typedText : h\[i\]\.content/.test(retryLast), 'retry sends the preserved words when the station holds a scrubbed or expanded directive');
  const retryWindow = new Function('HistoryFit', 'return (' + A.fnBody(chat, 'function endOnUserTurn(') + ')')(require('../frontend/app/historyfit.js'));
  const retryRow = { role: 'user', content: '[redacted-key]', typedText: 'typed words', rowId: 3 };
  A.eq(retryWindow([retryRow, { role: 'assistant', content: 'old reply' }]), [Object.assign({}, retryRow, { content: 'typed words' })], 'actual outbound retry window re-sends raw retry words and drops the old reply');
  A.eq(retryRow.content, '[redacted-key]', 'outbound retry leaves canonical cached bytes unchanged');
  A.eq((chat.match(/ws\.history\.push\(TurnMerge\.ofTurn\(\{ role: 'assistant', content: errorHistoryLine\(v\)/g) || []).length, 2, 'both error writers retain their turn/run owner for later healing');
  A.ok(!/replyText = (TaskIntent\.strip|shown)/.test(send), 'saving the reply preserves its recorded marker bytes');
  const render = A.fnBody(chat, 'function renderHistory(');
  A.ok(/TaskIntent\.strip\(m\.content\)/.test(render) && /Fork\.stripMarkers\(taskText\)/.test(render), 'render owns both kinds of marker stripping');
  A.ok(retryLast.length > 100 && retryLast.length < 4000, 'retryLast sliced');
  A.ok(/retryUserRunId: \(userTurn && userTurn\.sourceRunId\) \|\| \(userTurn && userTurn\.turnId \? undefined : activeWs\.runIds\[activeWs\.runIds\.length - 1\]\)/.test(retryLast), 'retryLast never guesses a run for a row that names its turn (the station finds it by turnId)');

  // persistPartial and markStoppedTurn, RUN: their rows carry the in-flight turn and run
  const part = (a, b) => { const i = chat.indexOf(a); const j = chat.indexOf(b, i + a.length); return chat.slice(i, j); };
  const src = part('  function persistPartial(', '  function isBusy(') + part('  function markStoppedTurn(', '  // WHY it stopped');
  A.ok(src.length > 200 && src.length < 20000, 'persistPartial + markStoppedTurn sliced');
  const ctx = vm.createContext({ Date, capHistory() {}, TurnMerge, liveRunRoots: new Map([['w', null]]), liveRunTurns: new Map([['w', { turnId: 'tDDDDDDDDDDDDDDDDDDDDDDDD', sourceRunId: 'run-live' }]]) });
  vm.runInContext(src + '\n;this.persistPartial = persistPartial; this.markStoppedTurn = markStoppedTurn;', ctx);
  const ws = { id: 'w', history: [] };
  ctx.persistPartial(ws, 'half a reply');
  ctx.markStoppedTurn(ws, 'stopped reply');
  A.eq(ws.history.map(r => [r.turnId, r.sourceRunId]), [['tDDDDDDDDDDDDDDDDDDDDDDDD', 'run-live'], ['tDDDDDDDDDDDDDDDDDDDDDDDD', 'run-live']], 'a partial and a stopped row name the in-flight turn and run');
  const idle = { id: 'other', history: [] };
  ctx.persistPartial(idle, 'no run');
  A.ok(!('turnId' in idle.history[0]) && !('sourceRunId' in idle.history[0]), 'with no run in flight the row names nothing');
}

// ---------------------------------------------------------------- C. harness.js
{
  // the body, not the destructured parameter list (whose `{` comes first)
  const fn = A.fnBody(harness, 'voiceTurn, turnId, retryOf, turnAt, clientNow, turnRowId, windowTokens, windowFrom })');
  A.ok(fn.length > 5000 && fn.length < harness.length / 2, 'Harness.chat sliced');
  A.ok(/retryUserRunId, voiceTurn, turnId, retryOf, turnAt, clientNow, turnRowId, windowTokens, windowFrom \}\) \{/.test(harness), 'Harness.chat takes the turn ids and window metadata');
  A.ok(/if \(turnId\) reqBody\.turnId = String\(turnId\);/.test(fn) && /if \(retryOf\) reqBody\.retryOf = String\(retryOf\);/.test(fn), 'it posts turnId and retryOf');
  A.ok(/if \(Number\.isSafeInteger\(turnAt\) && Number\.isSafeInteger\(clientNow\)\) \{ reqBody\.turnAt = turnAt; reqBody\.clientNow = clientNow; \}/.test(fn), 'it posts the time pair only as a pair');
  A.ok(/if \(Number\.isSafeInteger\(turnRowId\) && turnRowId > 0\) reqBody\.turnRowId = turnRowId;/.test(fn), 'it posts a bound rowId');
  A.eq((fn.match(/onRunId && onRunId\(/g) || []).length, 1, 'one onRunId call site');
  A.ok(/if \(!runId\) \{ runId = payload\.runId; onRunId && onRunId\(runId, payload\); \}/.test(fn), 'the lead\'s FIRST run.start payload reaches onRunId, inside the existing guard (never a forwarded worker\'s)');
}

// ---------------------------------------------------------------- D. autosessions.js
{
  const fold = A.fnBody(autos, 'function foldTurns(');
  const ctx = vm.createContext({ TurnMerge, recordOutcome() {}, failedMarker: () => ({ role: 'system', sys: true, error: true }) });
  vm.runInContext(fold + '\nthis.fold = foldTurns;', ctx);
  const row = { role: 'assistant', content: 'routine output', rowId: 8, streamId: 's', turnId: TurnKinds.runTurnId('routine'), kind: 'routine', sourceRunId: 'routine' };
  const ws = { history: [] }; ctx.fold(ws, [row], 'ok', 'done', true, 10);
  A.eq(ws.history[0], row, 'routine fold preserves station row, turn, stream, run and kind identity');
  A.ok(/TurnMerge\.idsOf\(\{ rowId: a\.rowId, turnId: a\.turnId \}\)/.test(commands), 'station delivery copies the station-provided row and turn ids through the shared grammar');
  const sb = { TurnKinds, seedRow: () => ({}) };
  vm.createContext(sb);
  const seedSrc = A.fnBody(autos, 'function seedRow(');
  A.ok(seedSrc.length > 50 && seedSrc.length < 2000, 'seedRow sliced');
  if (seedSrc) vm.runInContext(seedSrc + '\n;this.seedRow = seedRow;', sb);
  A.eq(sb.seedRow('7f3c2a10-1b2c-4d5e-8f90-123456789abc', 'check the inbox'), { role: 'user', content: 'check the inbox', sourceRunId: '7f3c2a10-1b2c-4d5e-8f90-123456789abc', turnId: 'r7f3c2a10-1b2c-4d5e-8f90-123456789abc' }, 'a routine seed row names the fire\'s directive turn and its run');
  A.ok(/const seed = \(job && job\.prompt\) \? \[seedRow\(runId, job\.prompt\)\] : \[\];/.test(autos), 'beginSession seeds through seedRow');
  A.ok(/push\(seedRow\(p\.runId, j\.prompt\)\)/.test(autos), 'onFire seeds through seedRow');
}

// ---------------------------------------------------------------- E. the channel hub
function memFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}
let clk = 50000;
const clock = { now: () => clk++ };
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(pred, n) { for (let i = 0; i < (n || 80) && !pred(); i++) await tick(); }
let bootN = 0;
function boot(disk, script) {
  const tag = 'p' + (++bootN);
  const store = makeChannelStore({ fs: disk, pathMod, root: '/ws/channels', clock });
  const runs = [];
  const hub = makeChannelHub({
    channel: 'telegram', store,
    runOnce: async (o) => { runs.push(o); return script(o); },
    send: async () => ({ ok: true, messageId: tag + '-m' }),
    secrets: () => ({ key: 'k', model: 'm', configured: true }),
    emit: () => {},
    newId: (() => { let n = 0; return () => tag + '-run-' + (++n); })(),
    sleep: () => Promise.resolve(), outboxRetryMs: 5
  });
  return { store, hub, runs };
}
(async () => {
  const disk = memFs();
  const p1 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); await new Promise(() => {}); });   // killed mid-thought
  p1.hub.onInbound({ chatId: '77', chatType: 'dm', userId: 'u1', text: 'what is the tide today', messageId: '1201', ts: 1 });
  await waitFor(() => p1.runs.length === 1);
  const receipt = p1.store.ledger.receipt('telegram|77|1201') || {};
  const first = p1.runs[0] || {};
  A.ok(/^ch[0-9a-f]{16}$/.test(String(first.turnId)) && TurnKinds.isTurnId(first.turnId), 'a chat message\'s run names its turn by its receipt: ' + first.turnId);
  A.ok(Number.isSafeInteger(receipt.ts) && first.turnAt === receipt.ts, 'and the receipt\'s station time as the turn\'s time (' + first.turnAt + ' / ' + receipt.ts + ')');
  p1.hub.close(); p1.store.ledger.close();
  const p2 = boot(disk, async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'High at noon.' }); o.emit('agent.run.end', { reason: 'done' }); });
  p2.hub.onStatus({ state: 'up' });
  await waitFor(() => p2.runs.length === 1 && !p2.store.ledger.receipt('telegram|77|1201'));
  A.eq(p2.runs.length, 1, 'fixture: the receipt runs again once after the restart');
  const again = p2.runs[0] || {};
  A.ok(TurnKinds.isTurnId(again.turnId) && again.turnId === first.turnId, 'the recovered second go names the SAME turn (' + again.turnId + ')');
  A.ok(Number.isSafeInteger(again.turnAt) && again.turnAt === first.turnAt, 'with the same turn time (' + again.turnAt + ')');
  await p2.hub.onInbound({ chatId: '77', chatType: 'dm', userId: 'u1', text: 'and tomorrow', messageId: '1202', ts: 2 });
  A.eq(p2.runs.length, 2, 'fixture: a new message runs');
  A.ok(/^ch[0-9a-f]{16}$/.test(String(p2.runs[1].turnId)) && p2.runs[1].turnId !== first.turnId, 'a different message names a different turn');
  p2.hub.close(); p2.store.ledger.close();
  // The moved script-only routine delivery owner stamps the same run/turn/kind pair exactly once.
  const rows = [];
  const { makeRoutineDelivery } = require('../sidecar/routine-delivery.js');
  const routine = makeRoutineDelivery({ channelStore: {}, channelOutbound: { provide() {} }, channelReach: () => ({}), channelRegistry: {},
    redact: x => x, runStore: {}, egressReader: {}, stationBridge: {}, now: () => clk++,
    transcriptStore: { view: (name, stream) => { A.eq(name, 'proof', 'routine retry reads durable proof'); return rows.filter(row => row.streamId === stream); }, append: row => rows.push(row) } });
  const job = { noAgent: true, agentId: 'agent', prompt: 'collect the report', deliver: 'local' };
  const result = { runId: 'routine-identity-001', outcome: 'ok', text: 'script report' };
  await routine.deliverCronResult(job, result);
  await routine.deliverCronResult(job, result);
  A.eq(rows.length, 2, 'script delivery retry retains one user/assistant pair');
  A.eq(rows.map(r => [r.role, r.kind, r.sourceRunId, r.turnId]), ['user', 'assistant'].map(role =>
    [role, 'routine', result.runId, TurnKinds.runTurnId(result.runId)]), 'both script rows carry the actual routine identity');
  A.eq(rows.map(r => r.taint), [null, 'scheduled script output'], 'script identity retains the owner/output trust boundary');
  A.report('turn-merge.family');
})().catch(e => { A.ok(false, 'threw: ' + ((e && e.stack) || e)); A.report('turn-merge.family'); });
