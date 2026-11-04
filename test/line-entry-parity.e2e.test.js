'use strict';
/* I1: one real sidecar, real filesystem tools and event bus; only the custom model transport is scripted.
   Every entry (channel, schedule, Run Now, webhook, sample, step test, SEND TO) runs clean, host-note/file,
   step-limit-with-partial-text, no-OUTBOX and terse-review-approval jobs. Assert the durable record, typed
   outcome/stop, exact OUTBOX count, one line-output receipt per delivered chain, and composer bytes at stage 2.
   The file pass reads the producer's actual private fs_write output at stage 2 and at a SEND TO target's entry.
   A second job carries no previous handoff except the channel's canonical own-chat replay: a real (bound) chat's stage remembers the
   chat, so EDITOR replays the finished entry job, the earlier job and its hand-off, once each and in order, but never the entry agent's
   tool traffic (the provider is not told EDITOR made a write only WRITER made). The six per-job doors replay nothing.
   The step test emits its final crate directly; it does not execute a chain or mint a chain authority receipt. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const Verdict = require('../sidecar/routing/verdict.js');

const MODEL = 'parity-model';
const S1 = 'Fact one: the moon has no air. Fact two: it drifts a little further away each year.';
const S2 = 'The moon has no air and drifts slowly away.';
const FEED_MARK = 'FEEDER JOB';
const FEED_OUT = 'The feeder line gathered two moon facts.';
const WRITER_BRIEF = 'Write what the job asks for.';
const EDITOR_BRIEF = 'Tighten the work you are handed into one sentence.';
const PUBLISHER_BRIEF = 'Publish the approved draft without changing its facts.';
const VERBATIM = ['channel', 'schedule', 'manual', 'sample', 'steptest'];
const ENTRIES = ['channel', 'schedule', 'manual', 'trigger', 'sample', 'steptest', 'sendto'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : '');
// what a stage's first request replayed, in order: the own words of each user turn, each assistant turn's words (and the tools it called), each tool result
const replayOf = call => call.request.messages.filter(m => m && m.role !== 'system').map(m => m.role === 'user' ? 'user: ' + userWords(m)
  : m.role === 'tool' ? 'tool: ' + text(m.content)
  : 'assistant: ' + text(m.content) + (Array.isArray(m.tool_calls) && m.tool_calls.length ? ' [calls ' + m.tool_calls.map(t => (t.function && t.function.name) || '?').join(',') + ']' : ''));

async function startSseCollector(url) {
  const ac = new AbortController(), events = [];
  const res = await fetch(url, { signal: ac.signal });
  assert.equal(res.status, 200, 'the real station event feed opens');
  const reader = res.body.getReader();
  const reading = (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, end).trim(); buf = buf.slice(end + 1);
          if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5).trim()));
        }
      }
    } catch (error) { if (!ac.signal.aborted) throw error; }
  })();
  return { events, async close() { ac.abort(); await reading; } };
}

(async () => {
  const calls = [];
  let hostNote = false;   // the second pass: stage 1 saves notes.md before it answers
  let scenario = 'clean', partialCall = 0;
  let notes = '', feederNotes = '', sse = null, lastRecord = null;
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('/models') ? { data: [{ id: MODEL, context_length: 16000, supported_parameters: ['tools'] }] } : { ok: true }));
    }
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const msgs = body.messages || [];
      const users = msgs.filter(m => m && m.role === 'user');
      // The OpenAI-compatible adapter may move the non-leading system grace note to role=user.
      // It is still a host limit notice, not a new job: this scripted model must keep calling tools past it.
      const jobUsers = users.filter(m => !userWords(m).startsWith('<iteration_limit>'));
      const words = jobUsers.length ? userWords(jobUsers[jobUsers.length - 1]) : '';
      const kind = words.startsWith('PIPELINE HANDOFF') ? 'hop' : (words.includes(FEED_MARK) && !words.startsWith('[HAND-OFF')) ? 'feeder' : 'entry';
      const publisher = kind === 'hop' && words.includes(PUBLISHER_BRIEF);
      calls.push({ kind, words, request: body, users: users.map(u => userWords(u)), assistants: msgs.filter(m => m && m.role === 'assistant').map(m => text(m.content)),
        tools: [].concat(...msgs.filter(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls)).map(m => m.tool_calls.map(t => (t.function && t.function.name) || '?'))),
        publisher, results: msgs.filter(m => m && m.role === 'tool').map(m => text(m.content)) });
      const say = t => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      };
      const call = (id, name, args, partial) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { ...(partial ? { content: partial } : {}), tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      };
      // Read distinct offsets in a real file until the host's opted-in step ceiling stops the run. Partial tokens must never ship.
      if (scenario === 'stage_incomplete' && kind === 'hop') return call('partial-' + (++partialCall), 'fs_read', { path: 'ceiling-input.txt', offset: partialCall, limit: 1 }, 'UNFINISHED DRAFT ' + partialCall);
      // THE HOST-NOTE SCENARIO: stage 1 settles its Task Brief, saves notes.md in its own workspace, then answers
      if (hostNote && Array.isArray(body.tools) && body.tools.length) {
        const asked = new Set([].concat(...msgs.filter(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls)).map(m => m.tool_calls.map(t => t.function && t.function.name))));
        if (kind !== 'hop') {
          if (!asked.has('brief_proceed')) return call('brief-1', 'brief_proceed', { objective: 'Save notes.md, then answer', deliverable: 'the facts and the saved notes', success: 'notes.md holds the findings' });
          if (!asked.has('fs_write')) return call('write-1', 'fs_write', { path: 'notes.md', content: kind === 'feeder' ? 'feeder findings' : 'three findings' });
          if (words.startsWith('[HAND-OFF') && !asked.has('fs_read')) return call('read-feeder', 'fs_read', { path: feederNotes });
        } else if (!asked.has('fs_read')) return call('read-writer', 'fs_read', { path: notes });
      }
      say(kind === 'hop' ? (scenario === 'terse_approval' && !publisher ? 'VERDICT: approved' : S2) : kind === 'feeder' ? FEED_OUT : S1);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fx = SidecarFixture.create({ prefix: 'line-parity-', timeoutMs: 30000, env: {
    SKYNET_DEV: '1', STARNET_DEV: '1',
    STARNET_CRON_TICK_MS: '100', SKYNET_CRON_TICK_MS: '100',
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1',
    SKYNET_MAX_ITERS: '5', STARNET_MAX_ITERS: '5',
    // no background learning passes: they would spend model calls of their own between the doors (an aux budget of 0 is UNLIMITED)
    SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_SCOUT: '0', SKYNET_QUEST_REFRESH: '0',
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
    notes = path.join(fx.workspace, 'writer', 'notes.md');
    feederNotes = path.join(fx.workspace, 'feeder', 'notes.md');
    sse = await startSseCollector(fx.baseUrl + '/api/channels/events?' + require('./_httpToken.js').sseQuery(fx.token));
    // the memory passes a finished run starts (reflection, study, failure review) would spend model calls between the doors too
    assert.equal((await fx.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false })).status, 200);
    const agents = [
      { agentId: 'writer', name: 'Writer', system: 'You write.', provider: 'custom', model: MODEL },
      { agentId: 'editor', name: 'Editor', system: 'You edit.', provider: 'custom', model: MODEL },
      { agentId: 'publisher', name: 'Publisher', system: 'You publish.', provider: 'custom', model: MODEL },
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
      { id: 'p5', t: 'intake', x: 0, y: 10, w: 1, h: 1, label: 'FEED' },
      { id: 'p6', t: 'bay', x: 3, y: 10, w: 1, h: 1, agentId: 'feeder', role: 'WRITER', brief: 'Gather facts.' },
      { id: 'p7', t: 'outbox', x: 6, y: 10, w: 1, h: 1, sendTo: 'p1' }
    ];
    const feederBelts = [1, 2, 4, 5].map(x => ({ x, y: 10, dir: 'E' }));
    const loopProps = [
      { ...mainProps[0], x: 0, y: 4 }, { ...mainProps[1], x: 3, y: 3, w: 2, h: 2 },
      { ...mainProps[2], x: 8, y: 3, w: 2, h: 2 },
      { id: 'review-gate', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 3 },
      { id: 'publisher-dock', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher', role: 'PUBLISHER', brief: PUBLISHER_BRIEF },
      { ...mainProps[3], x: 19, y: 4 }
    ];
    const belt = (x, y, dir) => ({ x, y, dir });
    const loopBelts = [1, 2, 5, 6, 7, 10, 11, 12, 13, 14, 17, 18].map(x => belt(x, 4, 'E'))
      .concat([belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')], [11, 10, 9, 8, 7, 6].map(x => belt(x, 1, 'W')), [belt(5, 1, 'S'), belt(5, 2, 'S')]);
    const arm = async (withFeeder) => {
      const props = scenario === 'terse_approval' ? loopProps : scenario === 'no_outbox' ? mainProps.filter(p => p.id !== 'p4') : mainProps;
      const belts = scenario === 'terse_approval' ? loopBelts : scenario === 'no_outbox' ? mainBelts.filter(b => b.x < 7) : mainBelts;
      // each floor is SAVED, then the page's hint of it is published: the station routes by what it saved
      const floor = floorOf({ props: props.concat(withFeeder ? feederProps : []), belts: belts.concat(withFeeder ? feederBelts : []) }, { equip: ['computer', 'workbench'] });
      return (await publishFloor(fx, floor, { label: 'the ' + scenario + (withFeeder ? ' floor with its feeder' : ' floor') })).plan;
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
        // Clean + file jobs deliberately share history (asserted below). Other scenarios are independent jobs,
        // so a small model's context compaction does not merge earlier scenario prompts into this byte-parity probe.
        const r = await fx.json('POST', '/api/dev/inbound', { text: job, chatId: scenario === 'clean' ? 'parity' : 'parity-' + scenario });
        assert.equal(r.status, 200, r.text);
      },
      async schedule(job, pass) {
        const c = await fx.json('POST', '/api/cron', { name: ['Morning moon digest', 'Harbor tide ledger', 'Cedar canopy survey', 'Basalt cavern census', 'Orchard blossom review'][pass - 1], prompt: job, schedule: 'in 1s',
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
        const c = await fx.json('POST', '/api/cron', { name: ['Lunar desk press', 'Quarry shift button', 'Kestrel wing records', 'Copper furnace report', 'Glacier runoff archive'][pass - 1], prompt: job, schedule: 'every 1h',
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
        const stopped = /^(stage_incomplete|no_outbox)$/.test(scenario);
        assert.equal(r.status, stopped ? 502 : 200, r.text.slice(0, 400));
        assert.equal(r.body.ok, !stopped, 'the sample route keeps its established proof status');
        assert.equal(r.body.outcome, stopped ? 'stopped_short' : 'delivered', 'the response and durable job share the typed outcome');
      },
      async steptest(job) {
        const s = await fx.json('POST', '/api/routing/steptest', { line: MAIN, text: job, pause: 'none' });
        assert.ok(s.status === 200 && s.body.ok, s.text.slice(0, 400));
        const done = await until(async () => {
          const g = (await fx.json('GET', '/api/routing/steptest/' + s.body.session.id)).body.session;
          return g && !/^(running|paused)$/.test(g.state) ? g : null;
        }, 30000, 'the step test');
        assert.equal(done.outcome, /^(stage_incomplete|no_outbox)$/.test(scenario) ? 'stopped_short' : 'delivered', 'the step test reports its actual outcome: ' + JSON.stringify({ state: done.state, outcome: done.outcome, error: done.error }));
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
    const listJobs = async () => (await fx.json('GET', '/api/line-jobs?line=' + encodeURIComponent(MAIN))).body.jobs || [];
    async function pass(n, job) {
      const got = {};
      for (const e of (process.env.LJR_PARITY_DIAG === '1' ? ['channel'] : ENTRIES)) {
        const from = calls.length, eventFrom = sse.events.length, previousJobs = new Set((await listJobs()).map(j => j.id));
        try { fs.rmSync(notes, { force: true }); } catch (_) { /* absent */ }
        await via[e](job, n);
        const summaries = await until(async () => {
          const found = (await listJobs()).filter(j => !previousJobs.has(j.id));
          return found.length && found.every(j => !/^(running|paused)$/.test(j.status)) ? found : null;
        }, 30000, e + ' durable job settlement');
        assert.equal(summaries.length, 1, scenario + ' ' + e + ': one job record on MAIN');
        const record = (await fx.json('GET', '/api/line-jobs/' + summaries[0].id)).body.job;
        lastRecord = record;
        const stopped = /^(stage_incomplete|no_outbox)$/.test(scenario);
        assert.equal(record.entry, e, scenario + ' ' + e + ': the durable job names its door');
        assert.equal(record.outcome, stopped ? 'stopped_short' : 'delivered', scenario + ' ' + e + ': shared job outcome');
        assert.equal(record.status, stopped ? 'problem' : 'delivered', scenario + ' ' + e + ': shared status');
        assert.equal(record.stop && record.stop.code || null, stopped ? scenario : null, scenario + ' ' + e + ': exact typed stop');
        assert.equal(record.runs.filter(r => r.agentId === 'editor').length, 1, scenario + ' ' + e + ': EDITOR ran once, even across tool rounds');
        if (scenario === 'stage_incomplete') assert.ok(record.runs.some(r => r.agentId === 'editor' && r.reason === 'max_iters'), e + ': the real step ceiling, with partial text, caused the stop');
        await sleep(150);   // nothing more of this door's job is still on the wire
        const delivered = sse.events.slice(eventFrom).filter(ev => ev.name === 'workitem.delivered').map(ev => ev.payload || {});
        assert.equal(delivered.filter(p => p.finalQueueId === 'outbox' && p.box === '' && p.agentId !== 'feeder').length, stopped ? 0 : 1, scenario + ' ' + e + ': exactly one OUTBOX crate iff delivered');
        assert.equal(delivered.filter(p => p.box === 'line-output' && p.lineId === MAIN).length, !stopped && e !== 'steptest' ? 1 : 0, scenario + ' ' + e + ': one terminal authority receipt per delivered chain job');
        const mine = calls.slice(from);
        const hops = mine.filter(c => c.kind === 'hop' && !c.publisher);
        assert.ok(hops.length, 'pass ' + n + ' ' + e + ': stage 2 reached the real provider');
        // stage 1's own request (a background pass a run leaves behind is a model call too: it never reads as a door's job)
        const entry = mine.find(c => c.kind === 'entry' && (e === 'trigger' ? c.words.startsWith('[Line trigger') : e === 'sendto' ? c.words.startsWith('[HAND-OFF') : c.words === job));
        assert.ok(entry, 'pass ' + n + ' ' + e + ': stage 1 ran on the job this door received: ' + JSON.stringify(mine.map(c => c.kind + ':' + c.words.slice(0, 60))));
        // the host-note scenario is real: stage 1 saved its file in its private workspace (so the host closed its reply with the note)
        if (hostNote) {
          assert.ok(fs.existsSync(notes), e + ': stage 1 saved its real private file');
          assert.ok(hops.some(h => h.tools.includes('fs_read') && h.results.some(r => r.includes('three findings'))), e + ': stage 2 actually read stage 1\'s file through the tool guard');
          if (e === 'sendto') assert.ok(mine.some(c => c.kind === 'entry' && c.tools.includes('fs_read') && c.results.some(r => r.includes('feeder findings'))), 'SEND TO\'s entry actually read its sender\'s file');
        }
        if (scenario === 'terse_approval') {
          const publisher = mine.filter(c => c.publisher);
          assert.equal(publisher.length, 1, e + ': approval continued once to the publisher');
          assert.ok(publisher[0].words.includes(S1), e + ': terse approval handed on the draft, not only its control word');
          assert.equal(record.runs.filter(r => r.agentId === 'publisher').length, 1, e + ': the publisher is in the same job');
        }
        got[e] = { turn: hops[0].words, hop: hops[0], received: entry.words, files: hostNote ? (e === 'sendto' ? [fs.realpathSync(feederNotes), fs.realpathSync(notes)] : [fs.realpathSync(notes)]) : [] };
        console.log('line-entry-parity: ' + scenario + (hostNote ? '+files' : '') + ' / ' + e + ' passed');
      }
      return got;
    }
    const composed = (received, upstream, files) => Pipeline.handoffPrompt(received, 'writer', upstream, 1, EDITOR_BRIEF,
      scenario === 'terse_approval' ? Verdict.verdictBrief('approved', true) : '', !/^(no_outbox|terse_approval)$/.test(scenario), files);
    function parity(n, job, got, upstream) {
      // (a) the five verbatim doors: one byte string, the composer's over the job
      const want = composed(job, upstream, got.channel.files);
      for (const e of VERBATIM) {
        assert.equal(got[e].received, job, 'pass ' + n + ' ' + e + ': stage 1 got the job verbatim');
        assert.equal(got[e].turn, want, 'pass ' + n + ' ' + e + ': EDITOR\'s hand-off is the shared composer\'s over the job');
      }
      for (const e of VERBATIM.slice(1)) assert.equal(got[e].turn, got.channel.turn, 'pass ' + n + ': ' + e + ' and the chat hand EDITOR the same bytes');
      // the webhook and SEND TO doors frame the job; their hand-off is the composer's over what THEIR stage 1 received
      assert.ok(got.trigger.received.startsWith('[Line trigger "Parity hook": a webhook was called]') && got.trigger.received.includes(job), 'pass ' + n + ': the webhook framed the job: ' + got.trigger.received.slice(0, 200));
      assert.ok(got.sendto.received.startsWith('[HAND-OFF') && got.sendto.received.includes(FEED_OUT), 'pass ' + n + ': SEND TO handed MAIN the feeder\'s result: ' + got.sendto.received.slice(0, 200));
      for (const e of ['trigger', 'sendto']) assert.equal(got[e].turn, composed(got[e].received, upstream, got[e].files), 'pass ' + n + ' ' + e + ': EDITOR\'s hand-off is the composer\'s over the job this door received');
    }

    if (process.env.LJR_PARITY_DIAG === '1') {
      scenario = 'stage_incomplete';
      fs.mkdirSync(path.join(fx.workspace, 'editor'), { recursive: true });
      fs.writeFileSync(path.join(fx.workspace, 'editor', 'ceiling-input.txt'), 'x'.repeat(10000));
      await pass(3, 'Parity stage_incomplete: write two short moon facts.');
      return;
    }
    const JOB1 = 'Write two short facts about the moon.';
    const one = await pass(1, JOB1);
    parity(1, JOB1, one, S1);
    // the six per-job doors (a one-job hub, no bound chat) replay nothing: EDITOR is handed the hand-off alone
    for (const e of ENTRIES.filter(x => x !== 'channel')) {
      assert.equal(one[e].hop.users.length, 1, 'pass 1 ' + e + ': EDITOR\'s first job replays nothing');
      assert.deepEqual(replayOf(one[e].hop), ['user: ' + one[e].turn], 'pass 1 ' + e + ': EDITOR\'s request is the hand-off and nothing else');
    }
    // a real chat's stage remembers the chat (turn-identity C9): this job's finished entry job is in front of the hand-off, in order
    assert.deepEqual(replayOf(one.channel.hop), ['user: ' + JOB1, 'assistant: ' + S1, 'user: ' + one.channel.turn],
      'pass 1 channel: EDITOR replays the chat\'s finished entry job (the ask, WRITER\'s answer) once, then the hand-off');
    assert.deepEqual([one.channel.hop.tools, one.channel.hop.results], [[], []], 'pass 1 channel: no tool call or result rides the replay');

    // THE HOST-NOTE SCENARIO: stage 1 saves notes.md first; what EDITOR is handed is still the composer's over S1, its terminal text
    hostNote = true;
    const JOB2 = 'Write two short facts about the tides.';
    const two = await pass(2, JOB2);
    for (const e of ENTRIES) assert.ok(two[e].turn.indexOf('[StarNet] Saved in this agent') < 0, 'pass 2 ' + e + ': the host\'s private-files note never rides the hand-off');
    parity(2, JOB2, two, S1);
    // (d) a second job carries no earlier hand-off; a real chat keeps its own earlier jobs (the channel profile's canonical replay), once each
    for (const e of ENTRIES.filter(x => x !== 'channel')) {
      assert.deepEqual(two[e].hop.users, [two[e].turn], 'pass 2 ' + e + ': EDITOR is handed this job alone, never an earlier hand-off');
      assert.deepEqual(replayOf(two[e].hop), ['user: ' + two[e].turn], 'pass 2 ' + e + ': EDITOR\'s request is the hand-off and nothing else');
    }
    // WRITER really called tools on the second job (brief_proceed, fs_write: its private notes.md was saved, asserted by the pass) and the chat
    // holds them; they are WRITER's, not EDITOR's, so no tool-call turn and no tool result of WRITER's reaches EDITOR (EDITOR's own first
    // request precedes any call of its own)
    assert.deepEqual([two.channel.hop.tools, two.channel.hop.results], [[], []], 'EDITOR is not told it called WRITER\'s brief_proceed or fs_write, nor handed their receipts');
    assert.ok(!two.channel.hop.request.messages.some(m => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length))), 'no WRITER tool-call turn or tool-result pair is in EDITOR\'s request');
    assert.deepEqual(replayOf(two.channel.hop), ['user: ' + JOB1, 'assistant: ' + S1, 'user: ' + one.channel.turn, 'assistant: ' + S2, 'user: ' + JOB2, 'assistant: ' + S1, 'user: ' + two.channel.turn],
      'the chat\'s EDITOR keeps the chat in order: the earlier job, WRITER\'s answer to it, its hand-off and EDITOR\'s answer once, then this job, WRITER\'s answer to it, and this job\'s hand-off');
    hostNote = false;
    for (const [n, mode] of [[3, 'stage_incomplete'], [4, 'no_outbox'], [5, 'terse_approval']]) {
      scenario = mode;
      if (mode === 'stage_incomplete') {
        fs.mkdirSync(path.join(fx.workspace, 'editor'), { recursive: true });
        fs.writeFileSync(path.join(fx.workspace, 'editor', 'ceiling-input.txt'), 'x'.repeat(10000));
      }
      await arm(false);
      const job = 'Parity ' + mode + ': write two short moon facts.';
      const got = await pass(n, job);
      parity(n, job, got, S1);
    }
    console.log('line-entry-parity: OK — 7 entries x 5 jobs: clean, files/host-note, step limit, no OUTBOX, terse review approval; one durable outcome and delivery rule');
  } catch (error) {
    // stdout preserves the exact JSON on PowerShell too (native stderr gets wrapped as an ErrorRecord).
    console.log('PARITY FAILURE TRACE ' + JSON.stringify({ scenario, lastRecord, calls }));
    throw error;
  } finally {
    if (sse) await sse.close();
    await fx.dispose();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
