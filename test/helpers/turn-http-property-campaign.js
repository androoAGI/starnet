'use strict';
/* The C5 operation classes through real sidecar HTTP and the actual sealed phone gateway.
   Later commits extend this same driver/oracle with their view, undo, carry and deletion operations. */
const A = require('../_assert.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fnBody } = require('../_fnbody.js');
const { TurnHttpFixture, eventsOf } = require('./turn-http-fixture.js');
const { mulberry32, key, dialogue } = require('./turn-oracle.js');
const Control = require('./turn-property-control.js');
const Merge = require('../../frontend/app/turnmerge.js');
const Kinds = require('../../frontend/app/turnkinds.js');
const RunOutcome = require('../../frontend/app/runoutcome.js');
const Pipeline = require('../../frontend/app/pipeline.js');
const autosSource = fs.readFileSync(require.resolve('../../frontend/app/autosessions.js'), 'utf8');
const chatSource = fs.readFileSync(require.resolve('../../frontend/app/chat.js'), 'utf8');
const autos = vm.createContext({ TurnMerge: Merge, TurnKinds: Kinds, recordOutcome() {}, failedMarker: () => ({ role: 'system', sys: true, error: true }) });
vm.runInContext(fnBody(autosSource, 'function seedRow(') + '\n' + fnBody(autosSource, 'function foldTurns(') + '\nthis.api={seedRow,foldTurns};', autos);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'ghp_' + 'AbCd1234'.repeat(5);
const WORDS = ['yes', 'yes', 'Done.', '日本語 🌟 café', 'use ' + SECRET, 'https://user:pass@example.test/', '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----'];
const OPS = ['send', 'repeatSend', 'sendSecret', 'sendFailRetry', 'idempotentResend', 'reload', 'cacheWipeLocal', 'cacheWipeBoth', 'phoneSend', 'phonePage', 'restart', 'oldClientSend', 'sendAttachImage', 'sendAttachText', 'sendAttachBinary', 'sendAttachMissing', 'captionless', 'goalContinuation', 'deskLineHop', 'routineSeed', 'interruptContinue', 'rekeyedRetry'];
const seeds = [17429, 18426, 19423, 20420];
// Canonical wrappers supply an immutable case; environment repro controls are diagnostic-only.
const modes = ['shadow', 'id'];
function canonicalCase(seed, windowMode) {
  if (!seeds.includes(seed) || !modes.includes(windowMode)) throw Error('invalid canonical HTTP property case');
  return Object.freeze({ seed, windowMode, stepCount: 40, boundaries: seed === seeds[0] });
}
let active;

// LJR retired the browser's private runWorkLine. Exercise its replacement executor over real HTTP,
// then consume the real start/terminal stream through the page identity owner. Entry-route parity is a separate 35-entry test.
async function deskLineHop(fx) {
  const { makeLineRunner, profiles } = require('../../sidecar/routing/line-runner.js');
  assert.ok(!chatSource.includes('function runWorkLine('), 'the retired browser executor stays absent');
  let started;
  const runner = makeLineRunner({ runOnce: async options => {
    const wire = await fx.dispatch(options);
    const consumed = fx.page.consume(wire, options);
    started = consumed;
    for (const event of consumed.events) options.emit(event.name, event.payload);
    return Object.assign({ text: consumed.reply, runId: consumed.runId }, consumed.ended || {}, RunOutcome.ofEnd(consumed.ended));
  } });
  const p = profiles.channel({ channel: 'dev', chatId: 'c1', streamId: fx.page.ws.id,
    config: () => ({ key: 'sk-or-v1-turn-property-fixture', provider: 'openrouter', model: 'test/model' }), persona: () => 'Reply briefly.' });
  const out = await runner.hopRunner(p)({ agentId: 'turnpeer', text: Pipeline.handoffPrompt('hello', 'agent', 'first stage answer', 1) });
  assert.ok(out.text && !out.error, 'central line executor completed one real HTTP run: ' + JSON.stringify(out));
  assert.ok(started && Kinds.isTurnId(started.turnId) && started.runId, 'station start names the hop turn and run');
  const row = fx.page.ws.history.find(r => r.sourceRunId === started.runId && r.role === 'assistant');
  assert.ok(row && row.turnId === started.turnId, 'page reply retains the actual hop identity');
}
async function routine(fx) {
  if (!fx.routineJob) {
    const created = await fx.json('POST', '/api/cron', { name: 'Turn identity routine', prompt: 'hello from the routine', schedule: 'every 1h', agentId: 'agent', model: 'test/model', provider: 'openrouter', runsLine: false });
    assert.ok(created.job && created.job.id, 'fixture created an unarmed routine: ' + JSON.stringify(created));
    fx.routineJob = created.job;
  }
  const result = await fx.fx.json('POST', '/api/cron/run', { id: fx.routineJob.id });
  assert.equal(result.status, 200, 'actual Run Now route');
  const events = eventsOf(result.text), start = events.find(e => e.name === 'agent.run.start').payload;
  const terminal = events.find(e => e.name === 'agent.run.end' && e.payload.runId === start.runId);
  const outcome = RunOutcome.ofEnd(terminal && terminal.payload);
  assert.ok(outcome.ok, 'actual Run Now terminal succeeded');
  const ws = { history: [autos.api.seedRow(start.runId, fx.routineJob.prompt)] };
  const response = await fx.read('cron-' + start.runId);
  autos.api.foldTurns(ws, response.turns, outcome.outcome, RunOutcome.reasonOf(terminal.payload), true, Date.now());
  assert.ok(ws.history.some(r => r.role === 'assistant'), 'Run Now transcript was folded');
  assert.ok(ws.history.filter(dialogue).every(r => key(r) && Kinds.isTurnId(r.turnId)), 'actual routine folds preserve stable identity');
}

async function boundaries(fx) {
  const startOf = wire => eventsOf(wire).find(e => e.name === 'agent.run.start').payload;
  const now = Date.now(), turnId = Merge.newTurnId(fx.rng);
  const request = { agentId: 'agent', streamId: 'long', turnId, turnAt: now, clientNow: now, messages: [{ role: 'user', content: 'hello original long directive' }] };
  const first = startOf(await fx.dispatch(request));
  const extra = Array.from({ length: 1305 }, (_, i) => ({ streamId: 'long', agentId: 'agent', sourceRunId: first.runId, turnId, role: 'assistant', content: 'long part ' + i, ts: now + i }));
  extra.splice(650, 0, { streamId: 'long', agentId: 'agent', sourceRunId: first.runId, turnId, role: 'user', kind: 'capture', content: '[BEGIN EXTERNAL SCREEN CAPTURE\nfixture pixels', ts: now + 650 });
  extra.splice(900, 0, { streamId: 'long', agentId: 'agent', sourceRunId: first.runId, turnId, role: 'user', content: '[STRUCTURED RESULT REPAIR] fixture repair', ts: now + 900 });
  await fx.seedRows(extra);
  const explicit = startOf(await fx.dispatch(Object.assign({}, request, { turnRowId: first.directiveRowId, clientNow: Date.now() })));
  assert.equal(explicit.directiveRowId, first.directiveRowId, 'HTTP long resend reuses directive beyond1300 rows with capture and repair');
  const beforeRetry = fx.diskRows().filter(r => r.streamId === 'long');
  const overcapacity = startOf(await fx.dispatch(Object.assign({}, request, { retryOf: turnId, turnRowId: first.directiveRowId, clientNow: Date.now() })));
  const afterRetry = fx.diskRows().filter(r => r.streamId === 'long');
  assert.notEqual(overcapacity.turnId, turnId, 'HTTP overcapacity retry rekeys rather than partially retracting');
  assert.notEqual(overcapacity.directiveRowId, first.directiveRowId, 'HTTP overcapacity retry starts its own directive');
  assert.deepEqual(afterRetry.slice(0, beforeRetry.length), beforeRetry, 'HTTP overcapacity retry leaves the complete original durable prefix unchanged');
  assert.equal(afterRetry.filter(r => r.kind === 'retract').length, beforeRetry.filter(r => r.kind === 'retract').length, 'HTTP overcapacity retry appends zero retract rows');
  const covered = startOf(await fx.dispatch(Object.assign({}, request, { clientNow: Date.now() })));
  assert.equal(covered.directiveRowId, first.directiveRowId, 'HTTP delayed resend finds directive within vouched coverage');
  await fx.seedRows(Array.from({ length: 5100 }, (_, i) => ({ streamId: 'long', agentId: 'agent', sourceRunId: 'later-run-' + i, turnId: Kinds.runTurnId('later-run-' + i), role: 'assistant', content: 'later turn ' + i, ts: Date.now() })));
  const unknown = startOf(await fx.dispatch(Object.assign({}, request, { clientNow: Date.now() })));
  assert.notEqual(unknown.turnId, turnId, 'HTTP horizon over5000 rows re-keys unknown turn');
  const byId = startOf(await fx.dispatch(Object.assign({}, request, { turnRowId: first.directiveRowId, clientNow: Date.now() })));
  assert.equal(byId.directiveRowId, first.directiveRowId, 'HTTP explicit rowId still proves old directive');
  const oldAt = Date.now() - 20 * 60 * 1000;
  await fx.seedRows(Array.from({ length: 6005 }, (_, i) => ({ streamId: 'fresh', agentId: 'agent', sourceRunId: 'old-run-' + i, turnId: Kinds.runTurnId('old-run-' + i), role: 'assistant', content: 'old part ' + i, ts: oldAt })));
  const freshId = Merge.newTurnId(fx.rng), fresh = startOf(await fx.dispatch({ agentId: 'agent', streamId: 'fresh', turnId: freshId, turnAt: Date.now(), clientNow: Date.now(), messages: [{ role: 'user', content: 'hello fresh turn' }] }));
  assert.equal(fresh.turnId, freshId, 'HTTP new turn on6000 old rows does not falsely re-key');
  const day = 24 * 60 * 60 * 1000, clock = { agentId: 'agent', streamId: 'clock', turnId: Merge.newTurnId(fx.rng), turnAt: Date.now() + day, clientNow: Date.now() + day, messages: [{ role: 'user', content: 'hello clock ahead' }] };
  const clockFirst = startOf(await fx.dispatch(clock)); await fx.restart();
  const clockNext = startOf(await fx.dispatch(Object.assign({}, clock, { clientNow: Date.now() + day })));
  assert.equal(clockNext.directiveRowId, clockFirst.directiveRowId, 'HTTP client24h offset cancels after restart without rowId');
  await fx.restartDegraded();
  const degraded = startOf(await fx.dispatch(Object.assign({}, clock, { clientNow: Date.now() + day })));
  assert.notEqual(degraded.turnId, clock.turnId, 'HTTP degraded init does not claim old turn coverage');
  await fx.restart();
  const large = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024 - PNG.length)]);
  const bigA = await fx.upload('large-a.png', 'image/png', large), bigB = await fx.upload('large-b.png', 'image/png', large);
  const before = fx.requests.length;
  const budget = startOf(await fx.dispatch({ agentId: 'agent', streamId: 'budget', turnId: Merge.newTurnId(fx.rng), turnAt: Date.now(), clientNow: Date.now(), messages: [{ role: 'user', content: '', attachments: [bigA, bigB] }] }));
  const wire = fx.requests.slice(before).find(r => r.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')));
  assert.ok(wire, 'HTTP over-budget images reached actual provider wire');
  assert.equal(wire.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image_url').length, 1, 'HTTP12MiB expansion budget permits only one7MiB image');
  const run = (await fx.json('GET', '/api/runs?agent=agent&runId=' + budget.runId)).runs.find(r => r.runId === budget.runId);
  assert.equal(run.title, '[image: large-a.png], [image: large-b.png]', 'HTTP over-budget captionless title keeps both captured labels');
  A.ok(true, 'HTTP forced long-history, clock, degraded-restart and image-budget boundaries');
}

async function runCases(cases, title) {
  try {
    for (const fixtureCase of cases) {
      const { seed, windowMode, stepCount } = fixtureCase, rng = mulberry32(seed), opRng = mulberry32(seed ^ 0x4f5053);
      const fx = active = new TurnHttpFixture(seed, rng); await fx.start();
      await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode: windowMode });
      const page = fx.page;
      const photo = await fx.upload('photo.png', 'image/png', PNG);
      const notes = await fx.upload('notes.txt', 'text/plain', 'ATTACHMENT-SENTINEL: exactly seven widgets');
      const binary = await fx.upload('data.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 255]));
      const missing = Object.assign({}, notes, { id: 'missing000', path: '.attachments/missing000.txt' });
      await page.send('hello seed'); await fx.verify('seed ' + seed);
      const trace = [];
      for (let step = 0; step < stepCount; step++) {
        const op = OPS[step < OPS.length ? step : Math.floor(opRng() * OPS.length)], label = windowMode + '/' + seed + '/' + step + '/' + op;
        trace.push(op);
        try {
          if (op === 'send' || op === 'repeatSend' || op === 'sendSecret') await page.send(op === 'repeatSend' ? 'yes' : op === 'sendSecret' ? 'use ' + SECRET : WORDS[Math.floor(opRng() * WORDS.length)]);
          else if (op === 'sendFailRetry') {
            fx.failNext = true; const failed = await page.send('hello retry this message');
            assert.ok(failed.ended && RunOutcome.ofEnd(failed.ended).outcome !== 'succeeded', 'controlled upstream failure reached real terminal outcome');
            await page.load(); const retry = await page.send('', { retry: true }); assert.equal(retry.turnId, failed.turnId, 'retry retains admitted turn');
          } else if (op === 'idempotentResend') {
            const sent = page.lastRequest; page.consume(await fx.dispatch(sent), sent);
          } else if (op === 'reload') { page.save(); await page.reload(); }
          else if (op === 'cacheWipeLocal') await page.reload(true);
          else if (op === 'cacheWipeBoth') { page.saved = '[]'; await page.reload(true); }
          else if (op === 'phoneSend') await fx.phoneSend('hello from the phone');
          else if (op === 'phonePage') {
            const first = await fx.phoneCall('thread', { streamId: 's', limit: 3, page: true });
            const snapshot = (await fx.read()).turns.filter(dialogue);
            // The real phone thread is prose-only; assistant tool-call envelopes with empty content
            // remain in the station's rows but are never a phone page member.
            const before = snapshot.filter(r => typeof r.content === 'string' && r.content.trim());
            assert.ok(snapshot.filter(r => !before.includes(r)).every(r => !String(r.content || '').trim()), 'phone projection omits only empty prose here');
            await fx.phoneSend('hello between phone pages');
            const older = await fx.phoneCall('thread', { streamId: 's', limit: 200, beforeRowId: first.beforeRowId, before: first.turns.length, page: true });
            const joined = older.turns.concat(first.turns).map(key);
            assert.deepEqual(joined, before.slice(-joined.length).map(key), 'actual gateway paging survives append');
          } else if (op === 'restart') await fx.restart();
          else if (op === 'oldClientSend') await fx.dispatch({ agentId: 'agent', streamId: 's', messages: [{ role: 'user', content: 'hello old client' }] });
          else if (op.startsWith('sendAttach') || op === 'captionless') {
            const attachment = op === 'sendAttachText' ? notes : op === 'sendAttachBinary' ? binary : op === 'sendAttachMissing' ? missing : photo;
            const result = await page.send(op === 'captionless' ? '' : 'hello read the attachment', { attachments: [attachment] });
            const records = await fx.json('GET', '/api/runs?agent=agent&runId=' + result.runId), record = records.runs.find(r => r.runId === result.runId);
            assert.ok(record && record.title, 'actual run has a title');
            assert.ok(!record.title.includes('ATTACHMENT-SENTINEL'), 'attachment bytes never become run title');
            if (op === 'captionless') assert.ok(record.title.includes('photo.png'), 'captionless title names image label');
          } else if (op === 'goalContinuation') await page.send('hello continue the goal', { post: { goalContinuation: true } });
          else if (op === 'deskLineHop') await deskLineHop(fx);
          else if (op === 'routineSeed') await routine(fx);
          else if (op === 'interruptContinue') await fx.interruptAndContinue();
          else if (op === 'rekeyedRetry') {
            const initial = await page.send('hello original input'); await page.load();
            const request = Object.assign({}, page.lastRequest, { messages: [{ role: 'user', content: 'hello conflicting input' }], retryOf: initial.turnId });
            const next = page.consume(await fx.dispatch(request), request);
            assert.notEqual(next.turnId, initial.turnId, 'conflicting posted retry is re-keyed at the real route');
          }
          await fx.verify(label); A.ok(true, label);
        } catch (error) { throw Object.assign(error, { turnProperty: { seed, windowMode, trace: trace.slice() } }); }
      }
      if (fixtureCase.boundaries) await boundaries(fx);
      await fx.dispose(); active = null;
    }
  } catch (error) {
    if (active) { await active.dispose(); active = null; }
    if (error.turnProperty) Control.reportFailure(error, error.turnProperty.seed, error.turnProperty.trace, __filename, error.turnProperty.windowMode);
    A.ok(false, error.stack || String(error));
  }
  finally { if (active) { await active.dispose(); active = null; } }
  A.report(title || 'turn-identity.property HTTP');
}

function runCanonical(seed, windowMode) {
  return runCases([canonicalCase(seed, windowMode)], 'turn-identity.property HTTP ' + windowMode + '/' + seed);
}
function runDiagnostic() {
  const count = Control.hasPrefix ? 1 : Math.max(1, Math.min(4, Number(process.env.TURN_HTTP_SEEDS) || 4));
  const stepCount = Control.steps(40), override = Number(process.env.TURN_PROP_SEED);
  const cases = [];
  for (const windowMode of Control.windowModes) for (let seedIndex = 0; seedIndex < count; seedIndex++) {
    cases.push({ seed: override ? override + seedIndex * 997 : seeds[seedIndex], windowMode, stepCount, boundaries: seedIndex === 0 && !Control.hasPrefix });
  }
  return runCases(cases, 'turn-identity.property HTTP diagnostic');
}
module.exports = { runCanonical, canonicalCase };
if (require.main === module) runDiagnostic();
