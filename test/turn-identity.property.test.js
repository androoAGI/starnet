'use strict';
/* C5 property fast tier. Same PageModel and oracle as the real-route tier; production storage and run decisions. */
const A = require('./_assert.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PageModel } = require('./helpers/page-model.js');
const { TurnFixture } = require('./helpers/turn-fixture.js');
const { check, checkKinds, mulberry32, key } = require('./helpers/turn-oracle.js');
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
// the 22 operations of the C5 tier, then the three that leave the other canonical row kinds in the stream (commit 10): a run that wrote files
// (kind deliverable), a run a SEND NOW note steered through the real buffer and loop (kind steer), a routine handing its result back to the session
// (kind delivery). Their expectations are declared below from what each op made; the visibility of each kind is read out of TurnKinds.MATRIX.
const OPS = ['send', 'repeatSend', 'sendSecret', 'sendFailRetry', 'idempotentResend', 'reload', 'cacheWipeLocal', 'cacheWipeBoth', 'phoneSend', 'phonePage', 'restart', 'oldClientSend', 'sendAttachImage', 'sendAttachText', 'sendAttachBinary', 'sendAttachMissing', 'captionless', 'goalContinuation', 'deskLineHop', 'routineSeed', 'interruptContinue', 'rekeyedRetry',
  'runWithFiles', 'steerNote', 'routineSessionReturn', 'attachTurn',
  'quoteRead', 'deleteSession'];
const FILE_SETS = [['report · v2.md', 'a · b.png'], ['clip.mp3', 'notes v1.txt'], ['src/a.md'], ['clip.mp4', 'report · v2.md', 'out/chart.png']];
const seedCount = Control.hasPrefix ? 1 : Math.max(1, Math.min(500, Number(process.env.TURNID_SEEDS) || 20));
const stepCount = Control.steps(60);
const initialSeed = Number(process.env.TURN_PROP_SEED) || 17429;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-turn-property-'));
let active = null, assertions = 0;
(async () => {
  try {
    for (const windowMode of Control.windowModes) for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
      const seed = initialSeed + seedIndex * 997, rng = mulberry32(seed), opRng = mulberry32(seed ^ 0x4f5053);
      let now = 1800000000000 + seedIndex * 1000000;
      const clock = () => ++now;
      const fx = active = new TurnFixture(path.join(root, windowMode + '-' + seed), clock, { window: windowMode });
      const page = new PageModel({ streamId: 's', now: clock, rng, read: sid => fx.read(sid),
        dispatch: (body, opts) => fx.dispatch(body, opts), redactAsk: async rows => new Map(rows.map(r => [r.content, redact(r.content)])),
        model: { getModel: () => 'test/model', contextLimitOf: () => 128000 } });
      fx.desk = [page.ws];
      const photo = await fx.upload('photo.png', 'image/png', PNG), notes = await fx.upload('notes.txt', 'text/plain', 'ATTACHMENT-SENTINEL: exactly seven widgets');
      const binary = await fx.upload('data.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 255]));
      const missing = Object.assign({}, notes, { id: 'missing000', path: '.attachments/missing000.txt' });
      await page.send('seed turn'); await page.load(); page.save();
      const trace = [], expected = { files: [], steers: [], returns: [], attachments: [] };   // what the row-kind operations declared they made (checkKinds)
      const reads = [], gone = [];   // quoteRead: { stream, word } a run of 's' read; deleteSession: { word, calls } words that must be in no view and no later provider body
      let serial = 0;
      for (let step = 0; step < stepCount; step++) {
        const op = OPS[step < OPS.length ? step : Math.floor(opRng() * OPS.length)], label = windowMode + '/seed' + seed + '/op' + step + '/' + op;
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
          else if (op === 'phoneSend') {
            const seen = fx.read('s', 50).turns.filter(r => r.kind === 'steer' && r.content), calls = fx.calls.length;
            await fx.phoneSend('s', 'phone says yes');
            const phone = fx.calls.slice(calls).pop().messages;   // what the phone handed the model: no note rides inside the agent's message, and the station's notes ride as user lines
            assert.ok(!phone.some(m => m.role === 'assistant' && /(^|\n)\[steering\] /.test(String(m.content))), label + ': the phone window holds no assistant message with a note inside it');
            if (seen.length) assert.ok(phone.some(m => m.role === 'user' && m.content === '[steering] ' + seen[seen.length - 1].content), label + ': the phone window replays the newest note as a user line');
          }
          else if (op === 'phonePage') {
            const first = await fx.phone.thread({ streamId: 's', limit: 3, page: true });
            // the thread is prose, plus the station's file rows and steer rows as display rows (host.js keeps(true))
            const before = fx.read('s', 2000).turns.filter(r => (['user', 'assistant'].includes(r.role) && !r.sys) || (r.role === 'system' && ((r.kind === 'deliverable' && Merge.deliverableOf(r)) || (r.kind === 'steer' && String(r.content || '').trim()))));
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
          } else if (op === 'runWithFiles') {
            const names = FILE_SETS[Math.floor(opRng() * FILE_SETS.length)];
            const sent = await page.send('make the files', { reply: 'Wrote the files.', files: names.map(p => ({ kind: Kinds.mediaKindOf(p) === 'image' ? 'image' : 'file', path: p })) });
            for (const p of names) expected.files.push({ runId: sent.runId, path: p, turnId: sent.turnId });
          } else if (op === 'steerNote') {
            // two notes while the run works: one sent with an id (the page's SEND NOW), one without (a channel, /steer); the loop's own tokens reach the page
            const n = ++serial, notes = [{ text: 'make it blue ' + n, noteId: 'sn' + seedIndex.toString(36) + 'x' + n.toString(36) }, { text: 'and keep it short ' + n }];
            const tools = 1 + Math.floor(opRng() * 2), sent = await page.send('work on this', { steer: notes, lead: 'On it.', reply: 'Done ' + n, tools });
            for (const note of notes) expected.steers.push({ runId: sent.runId, text: note.text, noteId: note.noteId, turnId: sent.turnId });
            // before the page re-reads the station: with one tool turn the saved reply is the trunk shape (the notes inside it); the window splits it
            const held = page.window();
            assert.ok(!held.some(m => m.role === 'assistant' && /(^|\n)\[steering\] /.test(String(m.content))), label + ': the page window holds no assistant message with a note inside it');
            if (tools === 1) for (const note of notes) assert.ok(held.some(m => m.role === 'user' && m.content === '[steering] ' + note.text), label + ': the saved reply is split at its notes: ' + note.text);
          } else if (op === 'routineSessionReturn') {
            // a routine's result handed back to this session: the row is written first; the page is connected (it folds the row, keyed at once), absent, or the disk refuses
            const n = ++serial, runId = fx.newId(), words = 'Routine result ' + n, shown = '✦ Property routine\n\n' + words, mode = opRng();
            if (mode < 0.15) {
              const real = fx.io.appendDurable;
              fx.io.appendDurable = () => { throw Object.assign(new Error('injected disk failure'), { code: 'EIO' }); };
              let refused; try { refused = await fx.sessionReturn('s', runId, words, args => page.station(args)); } finally { fx.io.appendDurable = real; }
              assert.equal(refused.out.ok, false, label + ': a refused write is a failed delivery');
              assert.equal(refused.asked.length, 0, label + ': and the page is never asked');
              assert.equal(fx.store.view('proof', 's', { complete: true }).filter(r => r.sourceRunId === runId).length, 0, label + ': nothing was written');
            }
            const connected = mode >= 0.15 && mode < 0.65, first = await fx.sessionReturn('s', runId, words, connected ? args => page.station(args) : null);
            assert.equal(first.out.ok, connected, label + ': the delivery succeeds exactly when a page took it');
            assert.equal(first.asked.length, 1, label + ': the page is asked once');
            const rows = fx.store.view('proof', 's', { complete: true }).filter(r => r.kind === 'delivery' && r.sourceRunId === runId);
            assert.equal(rows.length, 1, label + ': the row is written first, once, whether or not a page answered');
            assert.deepEqual([first.asked[0].rowId, first.asked[0].turnId, first.asked[0].text], [rows[0].rowId, rows[0].turnId, shown], label + ': the command names that row');
            if (connected) assert.ok(page.ws.history.some(r => r.rowId === rows[0].rowId && r.streamId === 's'), label + ': a connected page keyed its row at once');
            if (opRng() < 0.4) {   // the cron asks again (the page was away, or its ack was lost): the same row, folded nowhere twice
              const again = await fx.sessionReturn('s', runId, words, args => page.station(args));
              assert.equal(again.asked[0].rowId, rows[0].rowId, label + ': the retry sends the same identity');
              assert.equal(fx.store.view('proof', 's', { complete: true }).filter(r => r.kind === 'delivery' && r.sourceRunId === runId).length, 1, label + ': and writes nothing new');
            }
            expected.returns.push({ runId, text: shown });
          } else if (op === 'attachTurn') {
            // an ATTACHMENT TURN: one run with a file. The station writes the directive (which keeps the file's references) and ONE role-system 'attachment' row per file;
            // the matrix hides that row from GET, the page and both windows, and the proof view holds it (checkKinds, the fourth kind)
            const n = ++serial, up = await fx.upload('turn-' + n + '.txt', 'text/plain', 'attachment turn body ' + n);
            const sent = await page.send('read the file ' + n, { attachments: [up] });
            expected.attachments.push({ runId: sent.runId, id: up.id, path: up.path, turnId: sent.turnId });
          } else if (op === 'quoteRead' || op === 'deleteSession') {
            // quoteRead: another session says a unique word, then a run of this one reads it and says it back (the run's rows carry the quote stamp).
            // deleteSession: the Commander deletes a session that run read (or one this stream never touched); from then on its word is in no page row,
            // no GET /api/transcript row, no model-replay window, no page window and no provider body (turn identity commit 11, I7)
            const read = async () => {
              const n = ++serial, stream = 'q' + seedIndex.toString(36) + 'x' + n.toString(36), word = 'quokka' + seedIndex.toString(36) + 'x' + n.toString(36);
              await fx.run({ agentId: 'agent', streamId: stream, messages: [{ role: 'user', content: 'remember the codeword ' + word }] }, { reply: 'noted ' + word });
              await page.send('what did the other session say?', { reply: 'it said ' + word, quotes: [{ id: stream, at: clock() }] });
              reads.push({ stream, word });
              return reads[reads.length - 1];
            };
            if (op === 'quoteRead') await read();
            else {
              const target = reads.length && opRng() < 0.8 ? reads.splice(Math.floor(opRng() * reads.length), 1)[0] : await (async () => { const r = await read(); reads.pop(); return r; })();
              assert.ok(fx.read('s', 2000).turns.some(r => String(r.content).includes(target.word)), label + ': before the delete the reply that quotes the session is shown');
              fx.deleteSession(target.stream);
              gone.push({ word: target.word, calls: fx.calls.length });
            }
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
          checkKinds(page, response, { station: fx.modelWindow('s'), page: page.window() }, expected, { label, proof: fx.store.history('s', { limit: 10000, proof: true }) });
          const once = JSON.stringify(page.ws.history); await page.load();
          assert.equal(JSON.stringify(page.ws.history), once, label + ': cache reconciliation is idempotent');
          assert.ok(!JSON.stringify(response).includes(SECRET), label + ': raw token never appears in station readback');
          for (const g of gone) {
            // a deleted session's word is in none of the three views the page, the station and the provider share, nor in any provider body made since
            assert.ok(!JSON.stringify(page.ws.history).includes(g.word), label + ': the word of a deleted session is in no page row');
            assert.ok(!JSON.stringify(response).includes(g.word), label + ': ...nor in GET /api/transcript');
            assert.ok(!JSON.stringify(fx.modelWindow('s').messages).includes(g.word) && !JSON.stringify(page.window()).includes(g.word), label + ': ...nor in the station window or the page window');
            assert.ok(!JSON.stringify(fx.calls.slice(g.calls)).includes(g.word), label + ': ...nor in any provider body made after the delete');
          }
          assertions++; A.ok(true, label);
        } catch (e) { throw Object.assign(e, { turnProperty: { seed, windowMode, trace: trace.slice() } }); }
      }
      if (seedIndex === 0 && !Control.hasPrefix) {
        // Boundary classes are forced once per campaign, independently of the random operation distribution.
        const original = { streamId: 'long', agentId: 'agent', turnId: Merge.newTurnId(rng), turnAt: clock(), clientNow: clock(), messages: [{ role: 'user', content: 'original long-run directive' }] };
        const extra = Array.from({ length: 1305 }, (_, i) => ({ role: 'assistant', content: 'long part ' + i }));
        extra.splice(650, 0, Kinds.tag({ role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE\nfixture pixels' }, 'capture'));
        extra.splice(900, 0, { role: 'user', content: '[STRUCTURED RESULT REPAIR] fixture repair' });
        const long = await fx.run(original, { extraMessages: extra });
        fx.restart();
        const explicit = await fx.run(Object.assign({}, original, { turnRowId: long.start.directiveRowId }));
        assert.equal(explicit.start.directiveRowId, long.start.directiveRowId, 'longRunResend: >1300 rows including capture and repair still reuse by bound directive id');
        // C7 separates identity reuse from replacing an attempt: >500 strict targets cannot fit one retract.
        const beforeRetry = fx.store.view('proof', 'long', { complete: true });
        const overcapacity = await fx.run(Object.assign({}, original, { retryOf: original.turnId, turnRowId: long.start.directiveRowId }));
        const afterRetry = fx.store.view('proof', 'long', { complete: true });
        assert.notEqual(overcapacity.turnId, original.turnId, 'overcapacity retry rekeys rather than partially retracting');
        assert.notEqual(overcapacity.start.directiveRowId, long.start.directiveRowId, 'overcapacity retry starts its own directive');
        assert.deepEqual(afterRetry.slice(0, beforeRetry.length), beforeRetry, 'overcapacity retry preserves the complete original durable prefix');
        assert.equal(afterRetry.filter(r => r.kind === 'retract').length, beforeRetry.filter(r => r.kind === 'retract').length, 'overcapacity retry appends zero retract rows');
        const covered = await fx.run(Object.assign({}, original, { clientNow: clock() }));
        assert.equal(covered.start.directiveRowId, long.start.directiveRowId, 'delayedResend: bounded coverage finds the original directive without rowId');
        for (let i = 0; i < 5100; i++) fx.store.appendStrict({ streamId: 'long', agentId: 'agent', role: 'assistant', content: 'later turn ' + i, sourceRunId: 'later-run-' + i, turnId: Kinds.runTurnId('later-run-' + i), kind: 'turn' });
        fx.restart();
        const beyond = await fx.run(Object.assign({}, original, { clientNow: clock() }));
        assert.notEqual(beyond.turnId, original.turnId, 'delayedResend: beyond5000 rows is unknown and re-keyed, never falsely reused');
        const byId = await fx.run(Object.assign({}, original, { turnRowId: long.start.directiveRowId, clientNow: clock() }));
        assert.equal(byId.start.directiveRowId, long.start.directiveRowId, 'delayedResend: explicit rowId still proves original directive beyond coverage horizon');
        const beyondRetry = await fx.run(Object.assign({}, original, { retryOf: original.turnId, turnRowId: long.start.directiveRowId, clientNow: clock() }));
        assert.notEqual(beyondRetry.turnId, original.turnId, 'delayedRetry: explicit directive id cannot bypass the complete-target horizon beyond5000 rows');
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
    A.eq(assertions, seedCount * stepCount * Control.windowModes.length, 'all generated operations reached the oracle in every selected window mode');
  } finally { if (active) active.close(); fs.rmSync(root, { recursive: true, force: true }); }
  A.report('turn-identity.property fast');
})().catch(e => {
  if (e.turnProperty) Control.reportFailure(e, e.turnProperty.seed, e.turnProperty.trace, __filename, e.turnProperty.windowMode);
  console.error(e); process.exit(1);
});
