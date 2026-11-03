'use strict';
/* C5 property fast tier. Same PageModel and oracle as the real-route tier; production storage and run decisions. */
const A = require('./_assert.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PageModel } = require('./helpers/page-model.js');
const { TurnFixture } = require('./helpers/turn-fixture.js');
const { check, mulberry32, key } = require('./helpers/turn-oracle.js');
const Control = require('./helpers/turn-property-control.js');
const Merge = require('../frontend/app/turnmerge.js');
const Kinds = require('../frontend/app/turnkinds.js');
const { redact } = require('../sidecar/context.js');
const { fnBody } = require('./_fnbody.js');
const vm = require('node:vm');
const autos = fs.readFileSync(require.resolve('../frontend/app/autosessions.js'), 'utf8');
const auto = vm.createContext({ TurnKinds: Kinds, TurnMerge: Merge, recordOutcome() {}, failedMarker: () => ({ role: 'system', sys: true, error: true }) });
vm.runInContext(fnBody(autos, 'function seedRow(') + '\n' + fnBody(autos, 'function foldTurns(') + '\nthis.api={seedRow,foldTurns};', auto);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'ghp_' + 'AbCd1234'.repeat(5);
const TEXTS = ['yes', 'yes', 'Done.', '日本語 🌟 café', 'use ' + SECRET, 'https://user:pass@example.test/', '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----', 'pick a path'];
const OPS = ['send', 'repeatSend', 'sendSecret', 'sendFailRetry', 'idempotentResend', 'reload', 'cacheWipeLocal', 'cacheWipeBoth', 'phoneSend', 'phonePage', 'restart', 'oldClientSend', 'sendAttachImage', 'sendAttachText', 'sendAttachBinary', 'sendAttachMissing', 'captionless', 'goalContinuation', 'deskLineHop', 'routineSeed', 'interruptContinue', 'rekeyedRetry'];
const seedCount = Control.hasPrefix ? 1 : Math.max(1, Math.min(500, Number(process.env.TURNID_SEEDS) || 20));
const stepCount = Control.steps(60);
const initialSeed = Number(process.env.TURN_PROP_SEED) || 17429;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-turn-property-'));
let active = null, assertions = 0;
(async () => {
  try {
    for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
      const seed = initialSeed + seedIndex * 997, rng = mulberry32(seed), opRng = mulberry32(seed ^ 0x4f5053);
      let now = 1800000000000 + seedIndex * 1000000;
      const clock = () => ++now;
      const fx = active = new TurnFixture(path.join(root, String(seed)), clock);
      const page = new PageModel({ streamId: 's', now: clock, rng, read: sid => fx.read(sid),
        dispatch: (body, opts) => fx.dispatch(body, opts), redactAsk: async rows => new Map(rows.map(r => [r.content, redact(r.content)])) });
      fx.desk = [page.ws];
      const photo = await fx.upload('photo.png', 'image/png', PNG), notes = await fx.upload('notes.txt', 'text/plain', 'ATTACHMENT-SENTINEL: exactly seven widgets');
      const binary = await fx.upload('data.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 255]));
      const missing = Object.assign({}, notes, { id: 'missing000', path: '.attachments/missing000.txt' });
      await page.send('seed turn'); await page.load(); page.save();
      const trace = [];
      for (let step = 0; step < stepCount; step++) {
        const op = OPS[step < OPS.length ? step : Math.floor(opRng() * OPS.length)], label = 'seed' + seed + '/op' + step + '/' + op;
        trace.push(op);
        try {
          if (op === 'send' || op === 'repeatSend' || op === 'sendSecret') await page.send(op === 'repeatSend' ? 'yes' : op === 'sendSecret' ? 'use ' + SECRET : TEXTS[Math.floor(opRng() * TEXTS.length)]);
          else if (op === 'sendFailRetry') {
            await page.send('retry the unfinished work', { fail: true, reply: 'partial before failure' }); await page.load();
            assert.ok(page.ws.history.some(r => r.content === 'partial before failure'), label + ': no station answer preserves partial');
            await page.send('', { retry: true, reply: 'finished after retry' });
          } else if (op === 'idempotentResend') {
            const request = page.lastRequest; const wire = await fx.dispatch(request, { reply: 'resend answer' }); page.consume(wire, request);
          } else if (op === 'reload') { page.save(); await page.reload(); }
          else if (op === 'cacheWipeLocal') await page.reload(true);
          else if (op === 'cacheWipeBoth') { page.saved = '[]'; await page.reload(true); }
          else if (op === 'restart') { page.save(); fx.restart(); await page.reload(); }
          else if (op === 'phoneSend') await fx.phoneSend('s', 'phone says yes');
          else if (op === 'phonePage') {
            const first = await fx.phone.thread({ streamId: 's', limit: 3, page: true });
            const before = fx.read('s', 2000).turns.filter(r => ['user', 'assistant'].includes(r.role) && !r.sys);
            await fx.phoneSend('s', 'new turn between phone pages');
            const older = await fx.phone.thread({ streamId: 's', limit: 200, page: true, beforeRowId: first.beforeRowId, before: first.turns.length });
            const joined = older.turns.concat(first.turns).map(key);
            assert.deepEqual(joined, before.slice(-joined.length).map(key), label + ': phone page seam neither skips nor duplicates after append');
          } else if (op === 'oldClientSend') await fx.run({ agentId: 'agent', streamId: 's', messages: [{ role: 'user', content: 'old client yes' }] });
          else if (op.startsWith('sendAttach') || op === 'captionless') {
            const attachment = op === 'sendAttachText' ? notes : op === 'sendAttachBinary' ? binary : op === 'sendAttachMissing' ? missing : photo;
            await page.send(op === 'captionless' ? '' : 'read the attachment', { attachments: [attachment] });
            const title = fx.titles[fx.titles.length - 1];
            assert.ok(!/ATTACHMENT-SENTINEL/.test(title.title), label + ': title uses capture before expansion');
          } else if (op === 'goalContinuation') await page.send('continue the stated goal', { post: { goalContinuation: true } });
          else if (op === 'deskLineHop') {
            const turnId = Merge.newTurnId(rng), body = { agentId: 'agent', streamId: 's', turnId, lineHop: true, lineId: 'line', dockId: 'dock', messages: [{ role: 'user', content: 'continue the handoff' }] };
            page.consume(await fx.dispatch(body, { reply: 'hop finished' }), { turnId });
          } else if (op === 'routineSeed') {
            const runId = fx.newId(), streamId = 'cron-' + runId, seedRow = auto.api.seedRow(runId, 'routine prompt');
            assert.ok(Kinds.isTurnId(seedRow.turnId) && seedRow.sourceRunId === runId, label + ': routine seed identity');
            await fx.run({ runId, streamId, agentId: 'agent', trigger: 'manual', messages: [seedRow] });
            const ws = { history: [seedRow] }; auto.api.foldTurns(ws, fx.read(streamId).turns, 'ok', 'done', true, clock());
            assert.ok(ws.history.filter(r => !r.sys).every(r => r.rowId && Kinds.isTurnId(r.turnId)), label + ': routine folds retain recorded ids');
          } else if (op === 'interruptContinue') {
            const first = await page.send('recover this exact turn', { interrupt: true, reply: 'interrupted partial' }); fx.restart();
            const body = { agentId: 'agent', streamId: 's', turnId: Merge.newTurnId(rng), retryOf: Merge.newTurnId(rng),
              recovery: { sourceRunId: first.runId, sourceTurnId: first.turnId, title: 'recover this exact turn', base: 1 }, messages: [{ role: 'user', content: 'recover this exact turn' }] };
            const next = await fx.run(body, { reply: 'continued answer' });
            assert.equal(next.turnId, first.turnId, label + ': recovery ignores conflicting posted ids');
            page.consume(next.events.map(e => JSON.stringify(e)).join('\n'), {});
          } else if (op === 'rekeyedRetry') {
            const sent = await page.send('original input'); await page.load();
            const request = Object.assign({}, page.lastRequest, { messages: [{ role: 'user', content: 'different input conflicts' }], retryOf: sent.turnId });
            const result = await fx.run(request);
            assert.notEqual(result.turnId, sent.turnId, label + ': conflicting retry is re-keyed');
            const repeated = await fx.run(Object.assign({}, request, { turnId: result.turnId, retryOf: result.turnId }));
            assert.equal(repeated.turnId, result.turnId, label + ': subsequent retry keeps the re-keyed turn');
          }
          await page.load(); page.save();
          const response = fx.read('s');
          check(page, response, fx.store.history('s', { limit: 10000, proof: true }), { label });
          const once = JSON.stringify(page.ws.history); await page.load();
          assert.equal(JSON.stringify(page.ws.history), once, label + ': cache reconciliation is idempotent');
          assert.ok(!JSON.stringify(response).includes(SECRET), label + ': raw token never appears in station readback');
          assertions++; A.ok(true, label);
        } catch (e) { throw Object.assign(e, { turnProperty: { seed, trace: trace.slice() } }); }
      }
      if (seedIndex === 0 && !Control.hasPrefix) {
        // Boundary classes are forced once per campaign, independently of the random operation distribution.
        const original = { streamId: 'long', agentId: 'agent', turnId: Merge.newTurnId(rng), turnAt: clock(), clientNow: clock(), messages: [{ role: 'user', content: 'original long-run directive' }] };
        const extra = Array.from({ length: 1305 }, (_, i) => ({ role: 'assistant', content: 'long part ' + i }));
        extra.splice(650, 0, Kinds.tag({ role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE\nfixture pixels' }, 'capture'));
        extra.splice(900, 0, { role: 'user', content: '[STRUCTURED RESULT REPAIR] fixture repair' });
        const long = await fx.run(original, { extraMessages: extra });
        fx.restart();
        const explicit = await fx.run(Object.assign({}, original, { retryOf: original.turnId, turnRowId: long.start.directiveRowId }));
        assert.notEqual(explicit.turnId, original.turnId, 'longRunRetry: an oversized target set re-keys instead of partially retracting the old turn');
        assert.notEqual(explicit.start.directiveRowId, long.start.directiveRowId, 'longRunRetry: the new run owns a new directive identity');
        const covered = await fx.run(Object.assign({}, original, { retryOf: original.turnId, clientNow: clock() }));
        assert.notEqual(covered.turnId, original.turnId, 'delayedResend: finding a directive does not authorize an unproved whole-turn retraction');
        assert.equal(fx.store.history('long', { limit: 5000, proof: true }).some(row => row.kind === 'retract'), false, 'oversized retry never appends a partial retract');
        for (let i = 0; i < 5100; i++) fx.store.appendStrict({ streamId: 'long', agentId: 'agent', role: 'assistant', content: 'later turn ' + i, sourceRunId: 'later-run-' + i, turnId: Kinds.runTurnId('later-run-' + i), kind: 'turn' });
        fx.restart();
        const beyond = await fx.run(Object.assign({}, original, { retryOf: original.turnId, clientNow: clock() }));
        assert.notEqual(beyond.turnId, original.turnId, 'delayedResend: beyond5000 rows is unknown and re-keyed, never falsely reused');
        const byId = await fx.run(Object.assign({}, original, { retryOf: original.turnId, turnRowId: long.start.directiveRowId, clientNow: clock() }));
        assert.notEqual(byId.turnId, original.turnId, 'delayedResend: an explicit directive id cannot bypass the complete-target horizon');
        now += 20 * 60 * 1000;
        const freshId = Merge.newTurnId(rng), fresh = await fx.run({ streamId: 'long', agentId: 'agent', turnId: freshId, turnAt: clock(), clientNow: clock(), messages: [{ role: 'user', content: 'fresh turn after long idle history' }] });
        assert.equal(fresh.turnId, freshId, 'freshTurnLongStream: >6000 rows older than ten minutes do not force a false re-key');
        const DAY = 24 * 60 * 60 * 1000;
        const clockRequest = { streamId: 'clock', agentId: 'agent', turnId: Merge.newTurnId(rng), turnAt: clock() + DAY, clientNow: clock() + DAY, messages: [{ role: 'user', content: 'client clock is ahead' }] };
        const clockFirst = await fx.run(clockRequest); fx.restart();
        const clockAgain = await fx.run(Object.assign({}, clockRequest, { clientNow: clock() + DAY }));
        assert.equal(clockAgain.start.directiveRowId, clockFirst.start.directiveRowId, 'delayedResend:24h client clock offset cancels after restart without a rowId');
        const failingFs = Object.create(fs); let firstMkdir = true;
        failingFs.mkdirSync = (...args) => { if (firstMkdir) { firstMkdir = false; throw Object.assign(Error('fixture init fault'), { code: 'EIO' }); } return fs.mkdirSync(...args); };
        fx.restart({ fs: failingFs });
        assert.ok(fx.io.status().degraded, 'degraded delayed-resend fixture actually degraded');
        const degraded = await fx.run(Object.assign({}, clockRequest, { clientNow: clock() + DAY }));
        assert.notEqual(degraded.turnId, clockRequest.turnId, 'delayedResend: unvouched degraded history re-keys instead of claiming absence or reuse');
        fx.restart();
        const large = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024 - PNG.length)]);
        const bigA = await fx.upload('large-a.png', 'image/png', large), bigB = await fx.upload('large-b.png', 'image/png', large);
        const budget = await fx.run({ streamId: 'budget', agentId: 'agent', turnId: Merge.newTurnId(rng), turnAt: clock(), clientNow: clock(), messages: [{ role: 'user', content: '', attachments: [bigA, bigB] }] });
        const expanded = budget.messages.find(m => m.role === 'user').content;
        assert.equal(expanded.filter(b => b.type === 'image_url').length, 1, 'sendAttach over budget: real expander admits only one7MiB image');
        assert.equal(fx.titles[fx.titles.length - 1].title, '[image: large-a.png], [image: large-b.png]', 'over-budget captionless title still comes from both captured refs');
        A.ok(true, 'forced long-run, horizon, fresh-window, clock-offset, degraded-restart and image-budget boundary classes');
      }
      fx.close(); active = null;
    }
    A.eq(assertions, seedCount * stepCount, 'all generated operations reached the oracle');
  } finally { if (active) active.close(); fs.rmSync(root, { recursive: true, force: true }); }
  A.report('turn-identity.property fast');
})().catch(e => {
  if (e.turnProperty) Control.reportFailure(e, e.turnProperty.seed, e.turnProperty.trace, __filename);
  console.error(e); process.exit(1);
});
