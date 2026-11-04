/* node test/routing.saved-floor-authority.e2e.test.js — THE SAVED FLOOR IS THE ROUTING AUTHORITY, over a REAL sidecar with NO page
   (invariant saved-floor-is-routing-authority; the default: there is no switch).

   A station with INBOX > alpha > beta > OUTBOX is SAVED with the real save owner before the sidecar boots, and a mock provider records
   every request on the wire. No page ever connects and no plan is ever posted:
     1. a dev-channel job rides the saved line: alpha's call, then beta's, one job, delivered, and the reply is beta's;
     2. a POST /api/routing is only a question about the saved floor. A hint of another floor, a bare legacy plan body, a plan of
        another line and an empty body all answer 409 pending and change NOTHING: the next job still rides alpha > beta, no
        routing.plan.json is written, and the one an older version left behind is neither read nor rewritten nor deleted;
     3. the exact hint answers 200 with the SAVED floor's identity (saved-plan-v1:<sha256>) and echoes nothing it was sent;
     4. a restart with no page repeats all of it, with the same identity;
     5. INVARIANT: for every held saved floor (corrupt, future, unvouched, migration-required, a primary gone beside its backup)
        nothing runs and the provider is never called: the hub replies in words, the hint answers 503, the sample route, the step
        test and Run Now answer 409 in the same words, a scheduled fire is blocked in the routine's own row, and line stats say why
        they are empty. Restoring the file routes again, with no restart;
     6. a saved floor the compiler refuses (a belt loop) answers its exact hint 422 unroutable and routes nothing: the job
        runs as the unrouted fallback agent, never through alpha or beta; saving the line again routes it again.
   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { lineStation, seedSavedFloor, hintFor, savePath, clone } = require('./helpers/saved-floor.js');

const HOST = '127.0.0.1';
const IDENTITY = /^saved-plan-v1:[a-f0-9]{64}$/;
const HELD_SAID = /the saved floor is .+; routing is held until it is readable/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startMockProvider(calls) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
        const users = (body.messages || []).filter(m => m && m.role === 'user');
        const words = users.length ? userWords(users[users.length - 1]) : '';
        const kind = words.startsWith('PIPELINE HANDOFF') ? 'hop' : 'entry';
        calls.push({ kind, words });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: kind === 'hop' ? 'BETA-FINAL the haiku is done.' : 'ALPHA-DRAFT a first haiku.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const calls = [];
  const mock = await startMockProvider(calls);
  const fx = SidecarFixture.create({ prefix: 'sk-saved-floor-authority-', timeoutMs: 30000, env: {
    SKYNET_DEV: '1', STARNET_DEV: '1',
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-saved-floor-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_CRON_TICK_MS: '100', SKYNET_CRON_TICK_MS: '100', SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '',
    // no background learning pass spends a model call of its own between the doors (an aux budget of 0 is UNLIMITED)
    SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_SCOUT: '0', SKYNET_QUEST_REFRESH: '0'
  } });
  let n = 0;
  const ws = fx.workspace, primary = savePath(ws), oldPlanFile = path.join(ws, 'routing.plan.json');
  let mtime = 1800000000;
  // an edit from OUTSIDE the sidecar (a restore, a sync client, an editor), given its own mtime so the stamp always moves
  const outside = bytes => { fs.writeFileSync(primary, bytes); mtime += 2; fs.utimesSync(primary, mtime, mtime); };
  const post = (body) => fx.json('POST', '/api/routing', body);
  // one dev-channel job: the same hub, router and runOnce a Telegram message takes
  async function job(label) {
    const chatId = 'saved' + (++n), before = calls.length;
    const r = await fx.json('POST', '/api/dev/inbound', { chatId, text: 'please run a task: write a haiku (' + label + ')' });
    A.eq(r.status, 200, label + ': the dev inbound answers (' + String(r.text).slice(0, 200) + ')');
    return { chatId, body: r.body, replies: r.body.replies || [], calls: calls.slice(before) };
  }
  const delivered = async (r, label) => {
    A.eq(r.body.agentId, 'alpha', label + ': the saved floor named alpha, with no page and no posted plan');
    A.eq(r.calls.map(c => c.kind), ['entry', 'hop'], label + ': the provider was called for alpha, then for beta');
    A.ok(r.body.jobId && r.body.outcome === 'delivered', label + ': one job, delivered (' + JSON.stringify([r.body.jobId, r.body.outcome, r.body.stop]) + ')');
    const rec = (await fx.json('GET', '/api/line-jobs/' + r.body.jobId)).body.job;
    A.eq((rec.runs || []).map(x => x.agentId).sort(), ['alpha', 'beta'], label + ': the job record holds the run of alpha and the run of beta, once each');
    A.ok(r.replies.some(t => t.indexOf('BETA-FINAL') >= 0), label + ': the reply that left the line is beta\'s');
  };
  const refused = (r, label, status) => {
    A.eq(r.calls.length, 0, label + ': the provider was never called');
    A.eq(r.body.agentId, null, label + ': nothing was resolved, so nothing was placed on a belt');
    A.eq([r.body.held, r.body.status, r.body.isTask, r.body.jobId, HELD_SAID.test(r.body.why || '')], [true, status, false, null, true], label + ': and the answer says held, typed (' + JSON.stringify([r.body.status, r.body.why]) + ')');
    A.ok(r.replies.length === 1 && HELD_SAID.test(r.replies[0]) && r.replies[0].indexOf('did not run') >= 0, label + ': the chat is told, in words (' + r.replies.join(' | ').slice(0, 200) + ')');
  };
  try {
    const station = lineStation(), hint = hintFor(station);
    const LINE = hint.plan.lineOfProp.i1;
    seedSavedFloor(ws, station);
    // what an older version posted and persisted: a plan routing to other agents. It must be neither read nor rewritten nor deleted.
    const oldPlan = hintFor(lineStation({ agents: ['gamma', 'delta'] })).plan;
    const oldPlanBytes = JSON.stringify(oldPlan);
    fs.writeFileSync(oldPlanFile, oldPlanBytes);
    await fx.start();
    A.ok(/routing\.plan\.json is ignored/.test(fx.output()), 'boot says the old routing.plan.json is ignored');
    A.eq((await fx.json('POST', '/api/roster', { agents: [{ agentId: 'alpha', name: 'Alpha', system: 'You write.' }, { agentId: 'beta', name: 'Beta', system: 'You edit.' }], updatedAt: Date.now() })).status, 200, 'alpha and beta are on the roster');
    A.eq((await fx.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false })).status, 200, 'no memory pass spends a call of its own');

    // ---- 1. no page, no posted plan: the saved line routes ----
    await delivered(await job('first'), '1 saved line');

    // ---- 2. a POST is a question, never an order ----
    const before = calls.length;
    const mismatch = clone(hint); mismatch.plan.hash = '00000000';
    const bare = clone(hint.plan);
    const foreign = hintFor(lineStation({ agents: ['gamma', 'delta'] }));
    const asks = [['a hint whose hash is wrong', mismatch], ['a bare legacy plan body', bare], ['the hint of another floor', foreign], ['a bare plan of another floor', clone(foreign.plan)], ['an empty body', {}]];
    for (const [what, body] of asks) {
      const r = await post(body);
      A.eq([r.status, r.body.ok, r.body.pending === true], [409, false, true], what + ' answers 409 pending (' + r.text.slice(0, 160) + ')');
      A.ok(!('hash' in r.body) && !('plan' in r.body) && !('identity' in r.body), what + ': nothing it sent comes back, and no identity is claimed');
    }
    A.eq(fs.readFileSync(oldPlanFile, 'utf8'), oldPlanBytes, 'the old routing.plan.json is byte-identical: not read, not rewritten, not deleted');
    await delivered(await job('after unmatched posts'), '2 after 409s');
    A.eq(calls.length, before + 2, 'the posts spent nothing; the one job spent two calls');

    // ---- 3. the exact hint ----
    const ok1 = await post(hint);
    A.eq([ok1.status, ok1.body.ok, ok1.body.matched], [200, true, true], 'the exact hint of the saved floor answers 200 (' + ok1.text.slice(0, 200) + ')');
    A.ok(IDENTITY.test(ok1.body.identity) && Number.isSafeInteger(ok1.body.revision), 'with the saved floor\'s own identity and revision');
    A.ok(!('hash' in ok1.body) && !('plan' in ok1.body), 'and echoes nothing it was sent');
    const ok2 = await post(hint);
    A.eq(ok2.body.identity, ok1.body.identity, 'asked again: the same identity');
    A.eq(fs.readFileSync(oldPlanFile, 'utf8'), oldPlanBytes, 'a matched hint persisted nothing either');

    // ---- 4. a restart with no page repeats all of it ----
    await fx.restart();
    await delivered(await job('after restart'), '4 after restart');
    for (const [what, body] of asks) A.eq((await post(body)).status, 409, 'after a restart ' + what + ' still answers 409');
    const reborn = await post(hint);
    A.eq([reborn.status, reborn.body.identity], [200, ok1.body.identity], 'after a restart the same hint proves the same identity');
    A.eq(fs.readFileSync(oldPlanFile, 'utf8'), oldPlanBytes, 'and the old routing.plan.json is still untouched');
    await delivered(await job('after restart, after posts'), '4 posts after restart');

    // ---- 5. INVARIANT: a held saved floor runs nothing ----
    const good = fs.readFileSync(primary);
    const wrapper = JSON.parse(good.toString('utf8'));
    const edited = fn => { const w = clone(wrapper); fn(w); return Buffer.from(JSON.stringify(w)); };
    const rt = await fx.json('POST', '/api/cron', { name: 'Held press', prompt: 'write a haiku', schedule: 'every 1h', agentId: 'alpha', dockId: 'b1', model: 'test/model', provider: 'openrouter', runsLine: true });
    A.ok(rt.body && rt.body.job && rt.body.job.id, 'a routine at alpha\'s bay exists for Run Now: ' + rt.text.slice(0, 200));
    const table = [
      ['corrupt', () => outside('{ not a save'), 'corrupt'],
      ['future wrapper', () => outside(edited(w => { w.version = 2; })), 'future'],
      ['unvouched writer', () => outside(edited(w => { w.client = 'another-window'; })), 'unvouched'],
      ['legacy station', () => outside(edited(w => { w.doc.station.version = 1; })), 'migration-required'],
      ['primary gone beside its backup', () => { fs.writeFileSync(primary + '.bak', good); fs.unlinkSync(primary); }, 'absent']
    ];
    let scheduled = false;
    for (const [label, spoil, status] of table) {
      spoil();
      const mark = calls.length;
      refused(await job(label), label, status);
      const h = await post(hint);
      A.eq([h.status, h.body.held, h.body.status], [503, true, status], label + ': the hint answers 503 held, ' + status + ' (' + h.text.slice(0, 160) + ')');
      A.ok(HELD_SAID.test(h.body.why || ''), label + ': in the same words');
      const smp = await fx.json('POST', '/api/routing/sample', { line: LINE, text: 'a sample' });
      A.eq([smp.status, smp.body.ok, smp.body.held], [409, false, true], label + ': the sample route refuses (' + smp.text.slice(0, 160) + ')');
      A.ok(HELD_SAID.test(smp.body.error || ''), label + ': in the same words');
      const stp = await fx.json('POST', '/api/routing/steptest', { line: LINE, text: 'a step', pause: 'none' });
      A.eq([stp.status, stp.body.ok], [409, false], label + ': the step test refuses (' + stp.text.slice(0, 160) + ')');
      A.ok(HELD_SAID.test(stp.body.error || ''), label + ': in the same words');
      const now = await fx.json('POST', '/api/cron/run', { id: rt.body.job.id });
      A.eq([now.status, now.body.held, now.body.status], [409, true, status], label + ': Run Now refuses (' + now.text.slice(0, 160) + ')');
      A.ok(HELD_SAID.test(now.body.error || ''), label + ': in the same words');
      const stats = await fx.json('GET', '/api/routing/lines/stats');
      A.eq([stats.status, stats.body.routing && stats.body.routing.state, stats.body.routing && stats.body.routing.status, (stats.body.lines || []).length],
        [200, 'held', status, 0], label + ': line stats say why they are empty, never a guess (' + stats.text.slice(0, 160) + ')');
      if (!scheduled) {   // one scheduled fire through the real driver: blocked in the routine's own row before anything is spent
        scheduled = true;
        const sc = await fx.json('POST', '/api/cron', { name: 'Held fire', prompt: 'write a haiku', schedule: 'in 1s', agentId: 'alpha', dockId: 'b1', model: 'test/model', provider: 'openrouter', runsLine: true });
        A.ok(sc.body && sc.body.job && sc.body.job.id, 'a routine due in a second exists: ' + sc.text.slice(0, 200));
        await fx.json('POST', '/api/cron/arm', { enabled: true });
        try {
          let row = null;
          for (let i = 0; i < 100 && !row; i++) {
            const j = ((await fx.json('GET', '/api/cron')).body.jobs || []).find(x => x.id === sc.body.job.id);
            if (j && (j.blockedConfig || j.lastStatus)) row = j;
            else await sleep(100);
          }
          A.ok(row && row.blockedConfig && HELD_SAID.test(row.blockedConfig.reason || ''), label + ': a scheduled fire is blocked in the routine\'s own row, in the same words (' + JSON.stringify(row && { s: row.state, b: row.blockedConfig, e: row.lastError }).slice(0, 240) + ')');
        } finally { await fx.json('POST', '/api/cron/arm', { enabled: false }); }
      }
      A.eq(calls.length, mark, label + ': NOTHING in the whole table reached the provider');
      // the file comes back: routing comes back with it, with no restart
      outside(good); try { fs.unlinkSync(primary + '.bak'); } catch (_) { /* only the absent row has one */ }
      await delivered(await job('after ' + label), 'restored after ' + label);
    }

    // ---- 6. a saved floor the compiler refuses routes nothing ----
    const cyclic = lineStation({ cyclic: true }), cyclicHint = hintFor(cyclic);
    const saveFloor = async (doc, label) => {
      const rev = ((await fx.json('GET', '/api/save?agent=agent')).body || {}).save;
      const r = await fx.json('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, _saveRevision: (rev && rev._saveRevision) || 0, updatedAt: Date.now(), _saveClient: 'e2e-page', agent: { id: 'agent' }, station: doc });
      A.ok(r.status === 200 && r.body && r.body.ok === true, label + ' saves (' + String(r.text).slice(0, 200) + ')');
    };
    await saveFloor(cyclic, 'the looped line');
    const loop = await post(cyclicHint);
    A.eq([loop.status, loop.body.ok, loop.body.unroutable], [422, false, true], 'the exact hint of a floor the compiler refuses answers 422 unroutable (' + loop.text.slice(0, 200) + ')');
    A.ok(IDENTITY.test(loop.body.identity) && loop.body.identity !== ok1.body.identity, 'with that floor\'s own identity');
    const nowhere = await job('looped floor');
    A.eq([nowhere.body.agentId, nowhere.body.jobId, nowhere.calls.map(c => c.kind)], ['dev_' + nowhere.chatId, null, ['entry']], 'it routes nothing: the job runs as the unrouted fallback agent, one call, never alpha and never beta');
    A.eq((await post(hint)).status, 409, 'and the good floor\'s hint is now only pending: it is not what is saved');
    await saveFloor(station, 'the line again');
    A.eq([(await post(hint)).status, (await post(cyclicHint)).status], [200, 409], 'saving the line again: its hint matches, the loop\'s is pending');
    await delivered(await job('line again'), '6 line saved again');
    A.eq(fs.readFileSync(oldPlanFile, 'utf8'), oldPlanBytes, 'through all of it the old routing.plan.json was never touched');
  } finally {
    try { await fx.json('POST', '/api/cron/arm', { enabled: false }); } catch (_) { /* the sidecar may already be down */ }
    await fx.dispose().catch(() => {});
    await new Promise(r => mock.server.close(r));
  }
  A.report('routing.saved-floor-authority.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
