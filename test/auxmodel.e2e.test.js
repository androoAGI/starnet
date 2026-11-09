/* node test/auxmodel.e2e.test.js — TRUE end-to-end proof of the AUX MODEL/EFFORT TIER (aux-tier lane).

   WHAT THIS LOCKS: STARNET_AUX_MODEL points every auxiliary LLM pass at a cheap model while the MAIN run keeps
   its own. Three arms against the REAL sidecar + a mock OpenRouter that records every model call:

     ARM A — routing: with STARNET_AUX_MODEL=aux/cheap (declared reasoning-capable but NOT tool-capable in the
             catalog) and the governor off, one substantial task run fires the aux passes. The single-shot
             passes (reflection · study · thread-mine · scout) must ride aux/cheap with per-request reasoning
             effort 'low'; the SKILL REVIEW fork — a nested TOOL loop — must FALL BACK to the run model because
             aux/cheap is verifiably tool-less. The main run stays on run/model.
     ARM B — compaction: a tiny-context model forces a mid-run fold. Run 1 proves the summarizer rides the aux
             model. Run 2 makes the aux-model summary fail (400) and proves the fold RETRIES ONCE on the run's
             own model and the run still compacts + completes — the tier never makes compaction less reliable.
     ARM C — control: with NO aux env set, every provider request carries the run model and no request grows a
             `reasoning` field — the unconfigured install is byte-identical to before the tier existed.

     ARM D — the aux EFFORT default (10-14): run/model declared reasoning-capable, still NO aux env. The main run keeps
             the Commander's effort; every single-shot aux pass and an INTERNAL self-talk run carry reasoning effort
             'none' (the lowest the model offers) — hidden thinking on a strict-format extraction was most of the
             measured aux spend (test/aux-effort.test.js).
     ARM E — a model whose reasoning cannot be turned off (OpenRouter 400 "Reasoning is mandatory…" on every effort-none
             request, as gpt-5-mini / gemini-2.5-pro / claude-opus-5.5 answer live). The WAKE preflight (keepEffort) is
             sent once on the Commander's effort; an internal self-talk run and every post-run learning pass (reflection
             included) still complete — the adapter learns the refusal and resends at minimal
             (test/openrouter-effort-heal.test.js).

   ZERO network, zero real key (the fake key routes to the mock). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RUN_MODEL = 'run/model';
const AUX_MODEL = 'aux/cheap';

// a ~6 KB plain-text assistant reply: clears reflect/study/threadmine salience (>=200 chars) so every single-shot
// aux pass qualifies on a fresh workspace (the skill review qualifies through ARM A's nudge bar of 1).
const LONG_REPLY = ('I dug through the deploy pipeline and rebuilt the staging rollback path end to end. ' +
  'Here is the substantive write-up with the reasoning, the tradeoffs, and the follow-ups worth remembering. ')
  .repeat(40);

function sse(res, deltas, usage, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* mock OpenRouter. Catalog: run/model = tool-capable, NO reasoning; aux/cheap = reasoning-capable, NO tools.
   Records {model, sys, main, summary, reasoning} per /chat/completions call. opts.runContext shrinks the run
   model's window to force compaction; state.failAuxSummary 400s a summary request on the aux model. */
function startMock(opts) {
  const state = { calls: [], failAuxSummary: false };
  const runContext = (opts && opts.runContext) || 8000;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { id: RUN_MODEL, context_length: runContext, pricing: { prompt: '0', completion: '0' }, supported_parameters: (opts && opts.runReasoning) ? ['tools', 'reasoning'] : ['tools'] },
          { id: AUX_MODEL, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'] }
        ] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
          const body = JSON.parse(raw);
          const messages = body.messages || [];
          const sysMsg = messages.find(m => m && m.role === 'system');
          // applyCacheControl never structures non-anthropic models, but stay defensive about content shape.
          const sys = sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content)) : '';
          const rec = {
            model: body.model,
            sys: sys.slice(0, 200),
            // the MAIN task run is the ONLY call carrying the full '[RUNTIME]' agent system prompt (the aux
            // passes and the summarizer all build their own short system prompts).
            main: raw.indexOf('[RUNTIME]') >= 0,
            summary: messages.some(m => String((m && typeof m.content === 'string') ? m.content : '').indexOf('Summarize this earlier part of the conversation') >= 0),
            reasoning: body.reasoning || null,
            selfTalk: raw.indexOf('INTERNAL — AUXMODEL TITLE CHECK') >= 0,
            draft: raw.indexOf('INTERNAL — AUXMODEL DRAFT CHECK') >= 0,
            tools: Array.isArray(body.tools) ? body.tools.length : 0
          };
          rec.wake = raw.indexOf('INTERNAL — AUXMODEL WAKE CHECK') >= 0;
          state.calls.push(rec);
          // ARM E: OpenRouter's own refusal for a model whose reasoning cannot be turned off (gpt-5-mini, gemini-2.5-pro,
          // claude-opus-5.5 … measured live 10-14) — every request that asks for effort none is a 400, nothing billed
          if (opts && opts.mandatoryReasoning && rec.reasoning && rec.reasoning.effort === 'none') {
            rec.refused = true;
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400, metadata: { provider_name: null } } }));
            return;
          }
          if (state.failAuxSummary && rec.summary && rec.model === AUX_MODEL) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'aux summary rejected (test fault injection)', code: 400 } }));
            return;
          }
          if (rec.summary) { sse(res, [{ content: 'Earlier turns folded into a safe summary.' }], { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'stop'); return; }
          if (rec.main) {
            // compaction arm: first main call returns ONE tool call so the run has a second turn to fold before
            if ((opts && opts.toolTurn) && !messages.some(m => m && m.role === 'tool')) {
              sse(res, [{ tool_calls: [{ index: 0, id: 'inspect_once', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }],
                { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, 'tool_calls');
              return;
            }
            sse(res, [{ content: LONG_REPLY }], { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }, 'stop');
            return;
          }
          sse(res, [{ content: 'ok, done.' }], { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, 'stop');
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function driveRun(fixture, agentId, text, history) {
  const messages = (Array.isArray(history) ? history : []).concat([{ role: 'user', content: text }]);
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-auxmodel-fake', model: RUN_MODEL, agentId, isTask: true, messages })
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const raw = await r.text();
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// wait for the fire-and-forget aux passes to settle: poll the recorded-call counter until stable.
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 12000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1500)) break;
    await sleep(200);
  }
}

const COMMON = { SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1' };

(async () => {
  // ---- ARM A — aux routing + effort + skill-review tool-capability fallback --------------------------------
  {
    const mock = await startMock({});
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-a-',
      // SKYNET_SKILL_REVIEW_EVERY 1: the skill review rides the skill nudge (turns since the skillbase last changed),
      // so a bar of 1 makes this one-turn run DUE and the review fork fires for the routing assertions below. Since W3.2 a due
      // count fires it only on a run that gives it something to learn from (skillreview.js reviewCause): this run's message
      // carries a correction in the Commander's own words.
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_MODEL: AUX_MODEL, SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW_EVERY: '1' }, COMMON)
    });
    await fixture.start();
    try {
      await driveRun(fixture, 'auxmodel-route', 'Rebuild the staging deploy rollback path and write up what changed and why. Next time, write up what changed before you start.');
      await settle(mock.state);
      const calls = mock.state.calls;
      if (process.env.AUXDEBUG) calls.forEach((c, i) => console.error('  #' + i + ' model=' + c.model + ' main=' + c.main + ' reasoning=' + JSON.stringify(c.reasoning) + ' sys=' + c.sys.replace(/\s+/g, ' ').slice(0, 90)));
      const main = calls.filter(c => c.main);
      const review = calls.filter(c => c.sys.indexOf('skillbase maintenance worker') >= 0);
      const reflection = calls.filter(c => c.sys.indexOf('reflecting right after finishing a task') >= 0);
      const singleShots = calls.filter(c => !c.main && review.indexOf(c) < 0);
      A.ok(main.length >= 1 && main.every(c => c.model === RUN_MODEL), 'the MAIN run stayed on the run model');
      A.ok(reflection.length === 1, 'the reflection pass fired exactly once');
      A.eq(reflection[0] && reflection[0].model, AUX_MODEL, 'reflection rode the configured aux model');
      A.eq(reflection[0] && reflection[0].reasoning && reflection[0].reasoning.effort, 'low', 'reflection carried per-request reasoning effort low (the aux-tier default)');
      A.ok(singleShots.length >= 2, 'more than one single-shot aux pass fired (governor off, salient run) — non-vacuous');
      A.ok(singleShots.every(c => c.model === AUX_MODEL), 'EVERY single-shot aux pass rode the aux model (got: ' + singleShots.map(c => c.model + '|' + c.sys.slice(0, 40)).join(', ') + ')');
      A.ok(singleShots.every(c => c.reasoning && c.reasoning.effort === 'low'), 'every single-shot aux pass carried effort low');
      A.ok(review.length >= 1, 'the skill-review fork fired (nudge bar 1 reached, a correction to learn from, governor off)');
      A.ok(review.every(c => c.model === RUN_MODEL), 'skill review FELL BACK to the run model — aux/cheap is verifiably tool-less and a tool loop must never ride it');
      A.ok(review.every(c => c.tools > 0), 'the skill-review call really was a tool loop (tools on the wire)');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- ARM B — compaction on the aux model, with the one-retry reliability floor ---------------------------
  {
    const mock = await startMock({ runContext: 10, toolTurn: true });
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-b-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_MODEL: AUX_MODEL }, COMMON)
    });
    await fixture.start();
    try {
      await sleep(600);   // let the mocked model catalog warm — contextLimit is 0 (never compacts) until it does
      // enough foldable history that planCompaction has an `older` slice beyond the kept tail
      const history = [];
      for (let i = 0; i < 10; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: 'historical turn ' + i + ' with enough text to fold safely' });
      // Run 1 — the healthy path: the fold rides the aux model.
      const ev1 = await driveRun(fixture, 'auxmodel-fold', 'Inspect once, compact, then finish.', history);
      const sum1 = mock.state.calls.filter(c => c.summary);
      A.ok(sum1.length >= 1, 'run 1 produced a real summarizer call');
      A.ok(sum1.every(c => c.model === AUX_MODEL), 'the compaction summarizer rode the configured aux model');
      A.ok(sum1.every(c => c.reasoning && c.reasoning.effort === 'low'), 'the fold carried per-request effort low');
      // a 10-token window folds before the first call (preflight) and again after the tool turn: one truthful
      // compaction event per successful aux-model fold
      A.eq(ev1.filter(e => e.name === 'agent.compact').length, sum1.length, 'run 1 emitted one truthful compaction event per aux fold (' + sum1.length + ')');
      const end1 = ev1.filter(e => e.name === 'agent.run.end').pop();
      A.eq(end1 && end1.payload.reason, 'done', 'run 1 completed after the aux-model fold');

      // Run 2 — fault injection: the aux-model summary 400s; the fold must retry ONCE on the run model.
      const before = mock.state.calls.length;
      mock.state.failAuxSummary = true;
      const ev2 = await driveRun(fixture, 'auxmodel-fold-retry', 'Inspect once, compact under a failing aux model, then finish.', history);
      const sum2 = mock.state.calls.slice(before).filter(c => c.summary);
      A.ok(sum2.some(c => c.model === AUX_MODEL), 'run 2 first attempted the fold on the aux model');
      A.ok(sum2.some(c => c.model === RUN_MODEL), 'the failed aux fold RETRIED on the run\'s own model');
      const retried2 = sum2.filter(c => c.model === RUN_MODEL).length;
      A.ok(retried2 >= 1 && ev2.filter(e => e.name === 'agent.compact').length === retried2, 'run 2 still compacted once per fold — every failed aux fold was saved by its run-model retry (' + retried2 + ')');
      const end2 = ev2.filter(e => e.name === 'agent.run.end').pop();
      A.eq(end2 && end2.payload.reason, 'done', 'run 2 completed despite the aux-model summary failure');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- ARM C — control: no aux env => run model everywhere, no reasoning field appears ---------------------
  {
    const mock = await startMock({});
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-c-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, SKYNET_AUX_BUDGET: '0' }, COMMON)
    });
    await fixture.start();
    try {
      await driveRun(fixture, 'auxmodel-control', 'Rebuild the staging deploy rollback path and write up what changed and why');
      await settle(mock.state);
      const calls = mock.state.calls;
      A.ok(calls.length >= 3, 'the control run fired the main call plus aux passes (' + calls.length + ' calls)');
      A.ok(calls.every(c => c.model === RUN_MODEL), 'with NO aux env, every call — main and aux — used the run model');
      A.ok(calls.every(c => !c.reasoning), 'with NO aux env, no request grew a reasoning field (requests byte-identical to before the tier)');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- ARM D — the aux effort default: a reasoning-capable run model, no aux env ----------------------------
  {
    const mock = await startMock({ runReasoning: true });
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-d-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, SKYNET_AUX_BUDGET: '0' }, COMMON)
    });
    await fixture.start();
    try {
      await driveRun(fixture, 'auxmodel-effort', 'Rebuild the staging deploy rollback path and write up what changed and why');
      const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-or-v1-auxmodel-fake', model: RUN_MODEL, agentId: 'auxmodel-effort', internal: true, isTask: false, placed: [], reasoningEffort: 'high',
          messages: [{ role: 'user', content: 'INTERNAL — AUXMODEL TITLE CHECK. Reply with a 3 word title.' }] }) });
      A.eq(r.status, 200, 'the internal self-talk run opened'); await r.text();
      // an internal run whose reply IS work the Commander reads (the autopilot draft) keeps the effort it asked for
      const w = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-or-v1-auxmodel-fake', model: RUN_MODEL, agentId: 'auxmodel-effort', internal: true, keepEffort: true, isTask: false, placed: [], reasoningEffort: 'high',
          messages: [{ role: 'user', content: 'INTERNAL — AUXMODEL DRAFT CHECK. Write the draft.' }] }) });
      A.eq(w.status, 200, 'the work-product internal run opened'); await w.text();
      await settle(mock.state);
      const calls = mock.state.calls;
      const main = calls.filter(c => c.main), aux = calls.filter(c => !c.main && !c.summary && !c.selfTalk && !c.draft), self = calls.filter(c => c.selfTalk), draft = calls.filter(c => c.draft);
      A.ok(draft.length === 1 && draft[0].reasoning && draft[0].reasoning.effort === 'high', 'a work-product internal run keeps the effort it asked for (' + JSON.stringify(draft.map(c => c.reasoning)) + ')');
      A.ok(main.length >= 1 && main.every(c => c.reasoning && c.reasoning.effort === 'medium'), 'the main run keeps the Commander effort (medium default)');
      A.ok(aux.length >= 3, 'the single-shot aux passes fired (' + aux.length + ' calls)');
      A.ok(aux.every(c => c.reasoning && c.reasoning.effort === 'none'), 'every aux pass rides effort none — no hidden thinking (' + JSON.stringify(aux.map(c => c.reasoning)) + ')');
      A.ok(self.length === 1 && self[0].reasoning && self[0].reasoning.effort === 'none', 'an INTERNAL self-talk run rides effort none even when the page asked for high');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- ARM E — a model whose reasoning cannot be turned off: every effort-none request is a 400 ---------------
  {
    const mock = await startMock({ runReasoning: true, mandatoryReasoning: true });
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-e-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, SKYNET_AUX_BUDGET: '0' }, COMMON)
    });
    await fixture.start();
    try {
      await sleep(600);   // the mocked catalog warms: run/model reads as reasoning-capable, so the guessed ladder (none..max) applies
      const ends = async (r) => (await r.text()).split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(e => e && e.name === 'agent.run.end').pop();
      const evMain = await driveRun(fixture, 'auxmodel-mandatory', 'Rebuild the staging deploy rollback path and write up what changed and why');
      const endMain = evMain.filter(e => e.name === 'agent.run.end').pop();
      A.eq(endMain && endMain.payload.reason, 'done', 'the main run completes (it rides the Commander effort, never none)');
      await settle(mock.state);
      // the WAKE preflight: app.js preflightWire marks keepEffort, so it proves the effort the awakening runs on
      const w = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-or-v1-auxmodel-fake', model: RUN_MODEL, agentId: 'auxmodel-mandatory', internal: true, keepEffort: true, isTask: false, placed: [], system: '', reasoningEffort: 'high',
          messages: [{ role: 'user', content: 'INTERNAL — AUXMODEL WAKE CHECK. Reply with exactly: OK' }] }) });
      const endWake = await ends(w);
      // an internal self-talk run (a session title): aux effort, refused at none, must still complete
      const t = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-or-v1-auxmodel-fake', model: RUN_MODEL, agentId: 'auxmodel-mandatory', internal: true, isTask: false, placed: [], reasoningEffort: 'high',
          messages: [{ role: 'user', content: 'INTERNAL — AUXMODEL TITLE CHECK. Reply with a 3 word title.' }] }) });
      const endTitle = await ends(t);
      await settle(mock.state);
      const calls = mock.state.calls;
      if (process.env.AUXDEBUG) calls.forEach((c, i) => console.error('  E#' + i + ' main=' + c.main + ' refused=' + !!c.refused + ' reasoning=' + JSON.stringify(c.reasoning) + ' sys=' + c.sys.replace(/\s+/g, ' ').slice(0, 70)));
      const wake = calls.filter(c => c.wake), title = calls.filter(c => c.selfTalk);
      const reflection = calls.filter(c => c.sys.indexOf('reflecting right after finishing a task') >= 0);
      const aux = calls.filter(c => !c.main && !c.summary && !c.selfTalk && !c.wake);
      A.eq(endWake && endWake.payload.reason, 'done', 'the WAKE preflight completes on a model that refuses reasoning off');
      A.ok(wake.length === 1 && wake[0].reasoning && wake[0].reasoning.effort === 'high' && !wake[0].refused, 'the preflight is sent once, on the Commander effort it asked for (' + JSON.stringify(wake.map(c => c.reasoning)) + ')');
      A.eq(endTitle && endTitle.payload.reason, 'done', 'an internal self-talk run still completes (' + JSON.stringify(endTitle && endTitle.payload) + ')');
      A.ok(title.some(c => !c.refused && c.reasoning && c.reasoning.effort === 'minimal'), 'the self-talk run reached the model at the next rung, minimal (' + JSON.stringify(title.map(c => [c.reasoning, !!c.refused])) + ')');
      A.ok(reflection.length >= 1 && reflection.some(c => !c.refused), 'REFLECTION still reaches the model and gets its answer (' + JSON.stringify(reflection.map(c => [c.reasoning, !!c.refused])) + ')');
      // every distinct aux pass that was refused was answered on its resend: no learning pass dies on the refusal
      const kinds = Array.from(new Set(aux.map(c => c.sys.slice(0, 60))));
      A.ok(kinds.length >= 3, 'the post-run learning passes fired (' + kinds.length + ' kinds)');
      A.ok(kinds.every(k => aux.some(c => c.sys.slice(0, 60) === k && !c.refused)), 'every learning pass got a real answer after the refusal');
      A.ok(calls.filter(c => c.refused).length <= aux.length, 'refusals are bounded (one per in-flight call at most)');
      A.ok(!title.some(c => c.refused) || title.length === 2, 'the title run took at most one refusal (learned from the passes before it, or healed once)');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  A.report('auxmodel.e2e.test');
})().catch(e => { console.log('FAIL: auxmodel.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
