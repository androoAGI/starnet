'use strict';
/* node test/line-entry-parity.e2e.test.js — ONE JOB, EVERY ENTRY (line-job-runner, invariant I1, first form).

   One floor (INBOX ▸ WRITER ▸ EDITOR ▸ OUTBOX, no WORKING FOLDER) on a REAL sidecar with a scripted custom-provider upstream (no keys,
   no spend). The same job goes in by every door a line has: the dev-hub chat, a scheduled routine fire, that routine's Run Now, a
   webhook trigger, SEND TO from a feeder line, the sample route (RUN ONE REAL JOB) and the step-through test (pause none). What
   stage 2 (EDITOR) is handed is read off the wire: the user's own words of the hop's request (test/helpers/host-notes.js).
     (a) the five entries that take the job verbatim (chat, schedule, Run Now, sample, step test) hand EDITOR the same bytes, and
         those bytes are the shared composer's (Pipeline.handoffPrompt) over the job; the webhook and SEND TO entries hand it the
         composer's bytes over the job THEY received (the trigger's payload frame, the SEND TO frame);
     (d) a second job carries no earlier hand-off — except a real chat's own lineage: the chat's EDITOR keeps the earlier jobs of
         that chat (the channel profile's history), each once.
   The first pass is plain text. The second pass is the same proof for a second job. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const Pipeline = require('../frontend/app/pipeline.js');

const MODEL = 'parity-model';
const S1 = 'Fact one: the moon has no air. Fact two: it drifts a little further away each year.';
const S2 = 'The moon has no air and drifts slowly away.';
const FEED_MARK = 'FEEDER JOB';
const FEED_OUT = 'The feeder line gathered two moon facts.';
const WRITER_BRIEF = 'Write what the job asks for.';
const EDITOR_BRIEF = 'Tighten the work you are handed into one sentence.';
const VERBATIM = ['channel', 'schedule', 'manual', 'sample', 'steptest'];
const ENTRIES = ['channel', 'schedule', 'manual', 'trigger', 'sample', 'steptest', 'sendto'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : '');

(async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: MODEL, context_length: 16000 }] } : { ok: true }));
    }
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const msgs = body.messages || [];
      const users = msgs.filter(m => m && m.role === 'user');
      const words = users.length ? userWords(users[users.length - 1]) : '';
      const kind = words.startsWith('PIPELINE HANDOFF') ? 'hop' : (words.includes(FEED_MARK) && !words.startsWith('[HAND-OFF')) ? 'feeder' : 'entry';
      calls.push({ kind, words, users: users.map(u => userWords(u)), assistants: msgs.filter(m => m && m.role === 'assistant').map(m => text(m.content)) });
      const say = t => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      };
      say(kind === 'hop' ? S2 : kind === 'feeder' ? FEED_OUT : S1);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fx = SidecarFixture.create({ prefix: 'line-parity-', timeoutMs: 30000, env: {
    SKYNET_DEV: '1', STARNET_DEV: '1',
    STARNET_CRON_TICK_MS: '100', SKYNET_CRON_TICK_MS: '100',
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', STARNET_AUX_BUDGET: '0',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1'
  } });
  const until = async (probe, ms, what) => {
    const deadline = Date.now() + (ms || 20000);
    for (;;) {
      const v = await probe();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + what + '\n' + fx.output().slice(-3000));
      await sleep(100);
    }
  };
  try {
    await fx.start();
    const agents = [
      { agentId: 'writer', name: 'Writer', system: 'You write.', provider: 'custom', model: MODEL },
      { agentId: 'editor', name: 'Editor', system: 'You edit.', provider: 'custom', model: MODEL },
      { agentId: 'feeder', name: 'Feeder', system: 'You feed.', provider: 'custom', model: MODEL }
    ];
    assert.equal((await fx.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    const mainProps = [
      { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1, label: 'MAIN' },
      { id: 'p2', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'writer', role: 'WRITER', brief: WRITER_BRIEF },
      { id: 'p3', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'editor', role: 'EDITOR', brief: EDITOR_BRIEF },
      { id: 'p4', t: 'outbox', x: 9, y: 0, w: 1, h: 1 }
    ];
    const mainBelts = [1, 2, 4, 5, 7, 8].map(x => ({ x, y: 0, dir: 'E' }));
    const feederProps = [
      { id: 'p5', t: 'intake', x: 0, y: 4, w: 1, h: 1, label: 'FEED' },
      { id: 'p6', t: 'bay', x: 3, y: 4, w: 1, h: 1, agentId: 'feeder', role: 'WRITER', brief: 'Gather facts.' },
      { id: 'p7', t: 'outbox', x: 6, y: 4, w: 1, h: 1, sendTo: 'p1' }
    ];
    const feederBelts = [1, 2, 4, 5].map(x => ({ x, y: 4, dir: 'E' }));
    const arm = async (withFeeder) => {
      const plan = Pipeline.compileRoutingPlan({ props: mainProps.concat(withFeeder ? feederProps : []), belts: mainBelts.concat(withFeeder ? feederBelts : []) });
      for (const bay of plan.bays.concat(plan.dockBays)) bay.objects = ['computer', 'workbench'];
      const r = await fx.json('POST', '/api/routing', plan);
      assert.equal(r.body.ok, true, JSON.stringify(r.body));
      return plan;
    };
    const plan = await arm(true);
    const MAIN = plan.lineOfProp.p1, FEED = plan.lineOfProp.p5;
    assert.ok(MAIN && FEED && MAIN !== FEED, 'two lines');
    assert.deepEqual(plan.sendTo, { p7: { intakeId: 'p1', fromLine: FEED, toLine: MAIN } }, 'the feeder sends on to MAIN');
    await arm(false);   // the chat entry is unaddressed: one INBOX on the floor, so the chat walks MAIN's door

    const hook = await fx.json('POST', '/api/routing/triggers', { kind: 'webhook', lineId: MAIN, name: 'Parity hook' });
    assert.equal(hook.status, 200, hook.text);
    const hookId = hook.body.trigger.id, hookKey = hook.body.secret;

    /* ---- the seven doors ---- */
    const via = {
      async channel(job) {
        const r = await fx.json('POST', '/api/dev/inbound', { text: job, chatId: 'parity' });
        assert.equal(r.status, 200, r.text);
      },
      async schedule(job, pass) {
        const c = await fx.json('POST', '/api/cron', { name: pass === 1 ? 'Morning moon digest' : 'Harbor tide ledger', prompt: job, schedule: 'in 1s',
          agentId: 'writer', dockId: 'p2', model: MODEL, provider: 'custom', runsLine: true });
        assert.ok(c.body.job && c.body.job.id && !c.body.duplicate, 'a scheduled routine of its own: ' + c.text);
        await fx.json('POST', '/api/cron/arm', { enabled: true });
        try {
          await until(async () => {
            const j = ((await fx.json('GET', '/api/cron')).body.jobs || []).find(x => x.id === c.body.job.id);
            return j && j.lastStatus ? j : null;
          }, 30000, 'the scheduled fire');
        } finally { await fx.json('POST', '/api/cron/arm', { enabled: false }); }
      },
      async manual(job, pass) {
        const c = await fx.json('POST', '/api/cron', { name: pass === 1 ? 'Lunar desk press' : 'Quarry shift button', prompt: job, schedule: 'every 1h',
          agentId: 'writer', dockId: 'p2', model: MODEL, provider: 'custom', runsLine: true });
        assert.ok(c.body.job && c.body.job.id && !c.body.duplicate, 'a Run Now routine of its own: ' + c.text);
        const r = await fx.json('POST', '/api/cron/run', { id: c.body.job.id });
        assert.equal(r.status, 200, r.text.slice(0, 400));
      },
      async trigger(job) {
        const t0 = Date.now();
        const r = await fetch(fx.baseUrl + '/api/hooks/' + hookId, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-StarNet-Hook-Key': hookKey }, body: job });
        assert.equal(r.status, 202, await r.text());
        await until(async () => {
          const t = (((await fx.json('GET', '/api/routing/triggers')).body || {}).triggers || []).find(x => x.id === hookId);
          return t && t.lastOutcome && Date.parse(t.lastOutcome.at) >= t0 - 1000 ? t : null;   // `at` is an ISO time on the view
        }, 30000, 'the webhook fire');
      },
      async sample(job) {
        const r = await fx.json('POST', '/api/routing/sample', { line: MAIN, text: job });
        assert.equal(r.status, 200, r.text.slice(0, 400));
      },
      async steptest(job) {
        const s = await fx.json('POST', '/api/routing/steptest', { line: MAIN, text: job, pause: 'none' });
        assert.ok(s.status === 200 && s.body.ok, s.text.slice(0, 400));
        const done = await until(async () => {
          const g = (await fx.json('GET', '/api/routing/steptest/' + s.body.session.id)).body.session;
          return g && !/^(running|paused)$/.test(g.state) ? g : null;
        }, 30000, 'the step test');
        assert.equal(done.state, 'done', 'the step test reached the end: ' + JSON.stringify({ state: done.state, error: done.error }));
      },
      async sendto(job) {
        await arm(true);
        try {
          const s = await fx.json('POST', '/api/routing/sample', { line: FEED, text: FEED_MARK + ': ' + job, name: 'Feeder' });
          assert.equal(s.status, 200, s.text.slice(0, 400));
          await until(async () => {
            const jobs = (await fx.json('GET', '/api/line-jobs?line=' + encodeURIComponent(MAIN))).body.jobs || [];
            const j = jobs.find(x => x.from && x.from.jobId === s.body.jobId);
            return j && j.status !== 'running' ? j : null;
          }, 30000, 'the SEND TO job on MAIN');
        } finally { await arm(false); }
      }
    };

    // run every door with one job; what EDITOR was handed per door (and what the door's own stage 1 received)
    async function pass(n, job) {
      const got = {};
      for (const e of ENTRIES) {
        const from = calls.length;
        await via[e](job, n);
        await sleep(150);   // nothing more of this door's job is still on the wire
        const mine = calls.slice(from);
        const hops = mine.filter(c => c.kind === 'hop');
        assert.equal(hops.length, 1, 'pass ' + n + ' ' + e + ': the 2-stage line ran stage 2 once: ' + JSON.stringify(mine.map(c => c.kind + ':' + c.words.slice(0, 60))));
        const entry = mine.find(c => c.kind === 'entry');
        assert.ok(entry, 'pass ' + n + ' ' + e + ': stage 1 ran');
        got[e] = { turn: hops[0].words, hop: hops[0], received: entry.words };
      }
      return got;
    }
    const lastStage = true;   // EDITOR's lane ships to the OUTBOX: it is told its reply is the result
    const composed = (received, upstream) => Pipeline.handoffPrompt(received, 'writer', upstream, 1, EDITOR_BRIEF, '', lastStage);
    function parity(n, job, got, upstream) {
      // (a) the five verbatim doors: one byte string, the composer's over the job
      const want = composed(job, upstream);
      for (const e of VERBATIM) {
        assert.equal(got[e].received, job, 'pass ' + n + ' ' + e + ': stage 1 got the job verbatim');
        assert.equal(got[e].turn, want, 'pass ' + n + ' ' + e + ': EDITOR\'s hand-off is the shared composer\'s over the job');
      }
      for (const e of VERBATIM.slice(1)) assert.equal(got[e].turn, got.channel.turn, 'pass ' + n + ': ' + e + ' and the chat hand EDITOR the same bytes');
      // the webhook and SEND TO doors frame the job; their hand-off is the composer's over what THEIR stage 1 received
      assert.ok(got.trigger.received.startsWith('[Line trigger "Parity hook": a webhook was called]') && got.trigger.received.includes(job), 'pass ' + n + ': the webhook framed the job: ' + got.trigger.received.slice(0, 200));
      assert.ok(got.sendto.received.startsWith('[HAND-OFF') && got.sendto.received.includes(FEED_OUT), 'pass ' + n + ': SEND TO handed MAIN the feeder\'s result: ' + got.sendto.received.slice(0, 200));
      for (const e of ['trigger', 'sendto']) assert.equal(got[e].turn, composed(got[e].received, upstream), 'pass ' + n + ' ' + e + ': EDITOR\'s hand-off is the composer\'s over the job this door received');
    }

    const JOB1 = 'Write two short facts about the moon.';
    const one = await pass(1, JOB1);
    parity(1, JOB1, one, S1);
    for (const e of ENTRIES) assert.equal(one[e].hop.users.length, 1, 'pass 1 ' + e + ': EDITOR\'s first job replays nothing');

    const JOB2 = 'Write two short facts about the tides.';
    const two = await pass(2, JOB2);
    parity(2, JOB2, two, S1);
    // (d) a second job carries no earlier hand-off; a real chat keeps its own earlier jobs (the channel profile's history), once each
    for (const e of ENTRIES.filter(x => x !== 'channel')) {
      assert.deepEqual(two[e].hop.users, [two[e].turn], 'pass 2 ' + e + ': EDITOR is handed this job alone, never an earlier hand-off');
    }
    assert.deepEqual(two.channel.hop.users, [one.channel.turn, two.channel.turn], 'the chat\'s EDITOR keeps the chat\'s earlier job once, then this job');
    assert.deepEqual(two.channel.hop.assistants, [S2], '…with what EDITOR answered it');
    console.log('line-entry-parity: OK — 7 entries x 2 jobs: one hand-off composer, no earlier hand-off outside a chat\'s own lineage');
  } finally {
    await fx.dispose();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
