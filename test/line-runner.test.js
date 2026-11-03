/* node test/line-runner.test.js — ONE SUCCESS RULE through the ONE hop executor (line-job-runner, invariant I5).

   Every entry's later stages run through sidecar/routing/line-runner.js. Built here exactly as the host builds it — the REAL
   makeChannelHub (the factory every chat, sample, webhook and SEND TO hub comes from), makeLineRunner and the production profile
   factories (channel, schedule, manual, steptest) — with a fake runOnce at the transport edge: it emits on the run's sink and returns
   what runOnceCore returns (its terminal text, and the lead's outcome stamp).
     A. THE HUB'S LINE: the hand-off a stage passes on is its returned TERMINAL text, never its token deltas (a narration before a
        tool call, a steer echo, the host's private-files note); a loop-back pass at a dock carries the draft once — a real chat's
        history is its EARLIER jobs only, and a one-job hub (bindChats:false) carries none at all. RED before the lane: the hub built
        the hand-off from deltas and its hop history replayed the first pass on the loop-back (token-burn 10-17, "the hub loop-back
        sends the draft twice").
     B. THE SUCCESS TABLE: runOnce's return (reason, stamped outcome, finishReason, text — or nothing at all) x the hop's own end on
        the sink (none, 'cancelled', 'clarifying') gives ok and stopCode, the same through every profile.
     C. BY CONSTRUCTION: resumeSeed false, the hop's ceilingUsd, initialTaint 'upstream agent output', unattendedGrants [], isTask and
        surface 'autonomous' whatever a profile's own options say; trigger per profile (schedule 'schedule', Run Now 'manual', the
        rest 'event'); history none unless the profile carries one.
     D. LIVE RUNS: a routine hop's add / remove in the host's run registry is balanced on every exit, a throw included. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const Pipeline = require('../frontend/app/pipeline.js');

const HOST_NOTE = '[StarNet] Saved in this agent\'s private workspace, not a project folder: notes.md. Other agents cannot read it there.';
function memStore() {
  const hist = new Map(), recs = new Map();
  return {
    loadHistory: a => (hist.get(a) || []).slice(),
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord: c => recs.get(c), saveChatRecord: (c, p) => { recs.set(c, Object.assign({}, recs.get(c) || {}, p)); }
  };
}
// a run as runOnceCore drives it: streamed narration, a tool call, the answer, the host's closing note — and the RETURNED result
function realisticRun(answer) {
  return (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Let me look at that first. ' });
    o.emit('agent.tool_call', { agentId: o.agentId, runId: o.runId, callId: 'c1', name: 'fs_write' });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: answer });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: '\n\n' + HOST_NOTE + '\n' });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', outcome: 'succeeded', turns: 2, usd: 0 });
    return { reason: 'done', outcome: 'succeeded', failureCode: '', clarifying: false, text: answer, turns: 2, usd: 0 };
  };
}

(async () => {
  /* ---- A. the hub's own line, through the REAL makeChannelHub and the REAL chain runner (a self-loop at the reviewing dock) ---- */
  async function hubJobs(bindChats, jobs) {
    const store = memStore();
    const seen = [];   // every hop run: { agentId, pass, messages }
    const runOnce = async (o) => {
      if (o.agentId !== 'writer') seen.push({ agentId: o.agentId, users: o.messages.filter(m => m.role === 'user').map(m => m.content), assistants: o.messages.filter(m => m.role === 'assistant').map(m => m.content) });
      return realisticRun(o.agentId === 'writer' ? 'THE DRAFT' : 'THE EDIT')(o);
    };
    // writer ▸ editor ▸ a LOOP gate whose back lane re-enters the editor once, then out
    const chain = makeChainRunner({
      nextAgent: () => null,
      stepAgent: (agentId) => agentId === 'writer' ? { agentId: 'editor' } : agentId === 'editor' ? { loop: 'gate1', backTo: 'editor', max: 1, next: null } : null
    });
    const handed = [];
    const hub = makeChannelHub({
      channel: 'telegram', agentPrefix: 'tg_', textBatchWaitMs: 0, bindChats, ownerSurface: true,
      runOnce, store, chain, lineOriginFor: () => 'L1', classify: () => true,
      resolveRunConfig: () => ({ key: 'k', model: 'm' }), resolveEntryRunConfig: () => ({ key: 'k', model: 'm', agentId: 'writer' }),
      resolveAgent: () => ({ agentId: 'writer', dockId: null }),
      onLineOutcome: (lo) => handed.push(lo),
      send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }),
      newId: (() => { let i = 0; return () => 'id-' + (++i); })(), now: () => 1
    });
    for (let j = 1; j <= jobs; j++) await hub.onInbound({ channel: 'telegram', chatId: '42', chatType: 'dm', userId: 'u', text: 'job ' + j, messageId: 'm' + j, ts: j });
    hub.close();
    return seen;
  }
  {
    const chat = await hubJobs(true, 2);
    A.eq(chat.length, 4, 'fixture: each job ran the editor twice (its pass, then the loop-back)');
    // the hand-off is the stage's TERMINAL text, byte for byte: the composer's turn over THE DRAFT (the entry) and over the loop frame
    // around THE EDIT — never the narration before a tool call, the host's note, or the blank lines a note cut out of a turn leaves
    const firstTurn = chat[0].users[chat[0].users.length - 1];
    A.eq(firstTurn, Pipeline.handoffPrompt('job 1', 'writer', 'THE DRAFT', 1, null, '', false), 'stage 2 is handed the entry\'s terminal text');
    const loopTurn = chat[1].users[chat[1].users.length - 1];
    A.eq(loopTurn, Pipeline.handoffPrompt('job 1', 'editor', '[LOOP — pass 1 of 1 round the gate at gate1]\nTHE EDIT', 2, null, '', false), 'the loop-back is handed the editor\'s terminal text, never its deltas');
    // a real chat's history is its EARLIER jobs: the loop-back pass replays nothing of this job, the next job replays the earlier one once
    A.eq(chat[1].users.length, 1, 'the loop-back pass carries the draft once (no replay of this job\'s own first pass): ' + JSON.stringify(chat[1].users.map(u => u.slice(0, 40))));
    A.eq(chat[2].users.length, 3, 'the chat\'s next job replays the earlier job\'s two editor turns, once each');
    A.eq(chat[2].assistants, ['THE EDIT', 'THE EDIT'], '…with what the editor handed on (its terminal text)');
    A.eq(chat[3].users.length, 3, '…and its own loop-back still adds nothing of its own job');
    // a one-job hub (the sample, a trigger fire, a SEND TO hand-off): no hop history at all, even over the bare channel store
    const oneJob = await hubJobs(false, 2);
    A.ok(oneJob.length === 4 && oneJob.every(r => r.users.length === 1 && !r.assistants.length), 'a one-job hub\'s hops carry no history at all: ' + JSON.stringify(oneJob.map(r => r.users.length)));
  }

  /* ---- B, C, D: the executor itself, through the production profile factories ---- */
  let LR = null;
  try { LR = require('../sidecar/routing/line-runner.js'); } catch (e) { A.ok(false, 'the one hop executor exists (sidecar/routing/line-runner.js): ' + e.message); }
  if (LR) {
    const { makeLineRunner, profiles } = LR;
    const routine = (extra) => Object.assign({ config: () => ({ key: 'k', model: 'm' }), system: () => 'S', station: () => null }, extra || {});
    const kinds = () => ({
      channel: profiles.channel({ channel: 'telegram', chatId: '42', config: () => ({ key: 'k', model: 'm' }), persona: () => 'P' }),
      schedule: profiles.schedule(routine()), manual: profiles.manual(routine()),
      steptest: profiles.steptest({ config: () => ({ model: 'm', key: 'k' }), persona: 'P', brief: () => null, dockSystem: p => p, station: () => null, emit: () => {} })
    });
    // A known host admission cap is typed data, not provider prose or a missing terminal row.
    const cap = { code: 'day_limit', why: 'The line reached its $1.00 daily limit - raise its LINE BUDGET or try again tomorrow.' };
    for (const [kind, profile] of Object.entries(kinds())) {
      const host = async o => {
        o.emit('agent.run.error', { runId: o.runId, message: cap.why });
        o.emit('agent.run.end', { runId: o.runId, reason: 'budget' });
        return { text: '', reason: 'budget', outcome: 'out_of_budget', lineStop: cap };
      };
      const runner = makeLineRunner({ runOnce: host, newId: () => 'cap-run', now: () => 1, runRow: () => null });
      const hop = await runner.hopRunner(profile)({ agentId: 'writer', text: 'work', lineId: 'L1' });
      const stop = require('../sidecar/routing/line-fire.js').hopStop;
      A.eq([hop.stopCode, hop.error], ['day_limit', cap.why], kind + ': hop keeps host admission cause despite error event');
      A.eq(typeof stop === 'function' ? stop(hop, { agent: 'writer' }) : null, cap, kind + ': full cap survives chain/step wording');
      const job = runner.open({ line: 'L1', entry: kind, streamId: kind });
      runner.track(job, hop.runId, hop);
      const result = runner.settle(job, { stop: cap });
      A.eq([result.outcome, result.stop.code, result.runs.length], ['stopped_short', 'day_limit', 0], kind + ': known admission refusal invents no run row');
      A.eq(runner.outcomeOf({ stop: cap, stopped: true }).stop.code, 'stopped', kind + ': later STOP wins over admission cap');
      A.eq(runner.outcomeOf({ stop: cap, stopCause: 'fault' }).stop.code, 'station_fault', kind + ': later fault wins over admission cap');
    }
    A.eq(LR.hopVerdict({ reason: 'budget', outcome: 'out_of_budget', lineStop: cap }, { stopped: true, errMsg: cap.why }).stopCode, 'stopped', 'a cancelled cap hop keeps STOP precedence');
    A.eq(LR.hopVerdict({ reason: 'done', outcome: 'succeeded', text: JSON.stringify({ lineStop: cap }) }, {}).ok, true, 'provider text cannot author a host admission stop');

    // B. the table: runOnce's RETURN x the hop's own END on its sink
    const DONE = { reason: 'done' };
    const rows = [
      ['succeeded, with text', { reason: 'done', outcome: 'succeeded', text: 'Work.' }, DONE, true, null],
      ['an older station\'s unstamped done', { reason: 'done', text: 'Work.' }, DONE, true, null],
      ['cut short by the provider', { reason: 'done', outcome: 'cut_short', finishReason: 'length', text: 'Wor' }, { reason: 'done', finishReason: 'length' }, false, 'stage_incomplete'],
      ['a Task Brief question (done return, clarifying end)', { reason: 'done', outcome: 'asked', clarifying: true, text: 'Which one?' }, { reason: 'clarifying' }, false, 'stage_incomplete'],
      ['an unstamped done whose end says clarifying', { reason: 'done', text: 'Which one?' }, { reason: 'clarifying' }, false, 'stage_incomplete'],
      ['a spending limit', { reason: 'budget', outcome: 'out_of_budget', text: 'half' }, { reason: 'budget' }, false, 'stage_incomplete'],
      ['the step limit', { reason: 'max_iters', outcome: 'step_limit', text: '' }, { reason: 'max_iters' }, false, 'stage_incomplete'],
      ['succeeded with no text', { reason: 'done', outcome: 'succeeded', text: '   ' }, DONE, false, 'stage_empty'],
      ['an empty reply', { reason: 'empty', outcome: 'empty', text: '' }, { reason: 'empty' }, false, 'stage_empty'],
      ['a failed run', { reason: 'error', outcome: 'failed', failureCode: 'rate_limit', text: '' }, { reason: 'error' }, false, 'stage_failed'],
      ['a refusal', { reason: 'refusal', outcome: 'refused', failureCode: 'model_refusal', text: '' }, { reason: 'refusal' }, false, 'stage_failed'],
      ['stopped (returned)', { reason: 'cancelled', outcome: 'stopped', text: 'half' }, { reason: 'cancelled' }, false, 'stopped'],
      ['nothing returned, cancelled end (stopped while queued)', undefined, { reason: 'cancelled' }, false, 'stopped'],
      ['nothing returned, a done end and streamed text', undefined, DONE, false, 'stage_incomplete'],
      ['nothing returned, no end at all', undefined, null, false, 'stage_incomplete'],
      ['a done return whose own end says cancelled', { reason: 'done', outcome: 'succeeded', text: 'Work.' }, { reason: 'cancelled' }, false, 'stopped']
    ];
    for (const [why, ret, end, ok, stopCode] of rows) {
      for (const [kind, p] of Object.entries(kinds())) {
        const runner = makeLineRunner({ runOnce: async (o) => {
          o.emit('agent.token', { runId: o.runId, delta: 'streamed words' });
          if (end) o.emit('agent.run.end', Object.assign({ runId: o.runId, turns: 1, usd: 0 }, end));
          return ret === undefined ? undefined : Object.assign({}, ret);
        } });
        const r = await runner.hopRunner(p)({ agentId: 'editor', text: 'hand-off', ceilingUsd: 1 });
        const got = { ok: !r.error && !!String(r.text || '').trim(), stopCode: r.stopCode || null };
        A.eq(got, { ok, stopCode }, kind + ' / ' + why + ' (error ' + JSON.stringify(r.error) + ')');
        if (ok) A.eq(r.text, ret.text, kind + ' / ' + why + ': the hand-off is the returned terminal text');
        else A.eq(r.text, '', kind + ' / ' + why + ': an unfinished stage hands nothing on');
      }
    }
    // the stage's own error and a throw stop it as failed; the hand-off is never the streamed words
    {
      const errRun = makeLineRunner({ runOnce: async (o) => { o.emit('agent.run.error', { runId: o.runId, message: 'provider 500' }); o.emit('agent.run.end', { runId: o.runId, reason: 'error' }); return { reason: 'error', outcome: 'failed', text: '' }; } });
      const r = await errRun.hopRunner(kinds().schedule)({ agentId: 'editor', text: 'x' });
      A.ok(r.error === 'provider 500' && r.stopCode === 'stage_failed', 'the hop\'s own error: stage_failed, in its words: ' + JSON.stringify(r));
      const threw = makeLineRunner({ runOnce: async () => { throw new Error('boom'); } });
      const t = await threw.hopRunner(kinds().channel)({ agentId: 'editor', text: 'x' });
      A.ok(t.error === 'run failed: boom' && t.stopCode === 'stage_failed', 'a throw: stage_failed: ' + JSON.stringify(t));
    }
    // C. by construction: whatever a profile's own options say
    {
      const got = [];
      const runner = makeLineRunner({ runOnce: async (o) => { got.push(o); o.emit('agent.run.end', { runId: o.runId, reason: 'done' }); return { reason: 'done', outcome: 'succeeded', text: 'ok' }; } });
      for (const [kind, p] of Object.entries(kinds())) await runner.hopRunner(p)({ agentId: 'editor', text: 'hand-off', ceilingUsd: 0.4, lineId: 'L1', dockId: 'd2' });
      A.eq(got.map(o => o.trigger), ['event', 'schedule', 'manual', 'event'], 'trigger per profile: a chat / sample / webhook / SEND TO hop and a step are events, a scheduled fire\'s hop "schedule", Run Now\'s "manual"');
      for (const o of got) {
        A.ok(o.resumeSeed === false && o.ceilingUsd === 0.4 && o.initialTaint === 'upstream agent output' && Array.isArray(o.unattendedGrants) && !o.unattendedGrants.length
          && o.isTask === true && o.surface === 'autonomous' && o.lineId === 'L1' && o.dockId === 'd2', o.trigger + ': resumeSeed false, the hop\'s ceiling, upstream taint, no grant, a task on the autonomous surface, its line and bay');
        A.eq(o.messages.length, 1, o.trigger + ': no history unless the profile carries one');
      }
      // a profile cannot override them, even one built by hand
      const forged = { trigger: 'manual', options: () => ({ resumeSeed: true, ceilingUsd: 99, initialTaint: null, unattendedGrants: ['workbench'], isTask: false, surface: 'interactive' }) };
      got.length = 0;
      await runner.hopRunner(forged)({ agentId: 'editor', text: 'hand-off', ceilingUsd: 0.4 });
      A.ok(got[0].resumeSeed === false && got[0].ceilingUsd === 0.4 && got[0].initialTaint === 'upstream agent output' && !got[0].unattendedGrants.length && got[0].isTask === true && got[0].surface === 'autonomous',
        'a profile\'s own options never override what every hop runs under');
      // a step test's ENTRY step is stage one: it starts clean
      got.length = 0;
      await runner.hopRunner(kinds().steptest)({ agentId: 'writer', entry: true, text: 'the job', sessionId: 's1' });
      A.eq(got[0].initialTaint, null, 'a step test\'s entry step starts untainted (it is stage one)');
    }
    // D. a routine hop is live in the host's registry exactly while it runs, on every exit
    {
      const live = new Map();
      const registry = { add: (id, rec) => live.set(id, rec), remove: (id) => live.delete(id) };
      const during = [];
      const mk = (fn) => makeLineRunner({ runOnce: fn, liveRuns: registry, now: () => 5 });
      const clean = mk(async (o) => { during.push(live.has(o.runId) && live.get(o.runId).source); o.emit('agent.run.end', { runId: o.runId, reason: 'done' }); return { reason: 'done', outcome: 'succeeded', text: 'ok' }; });
      const thrown = mk(async (o) => { during.push(live.has(o.runId) && live.get(o.runId).source); throw new Error('boom'); });
      const stopped = mk(async (o) => { during.push(live.has(o.runId) && live.get(o.runId).source); o.emit('agent.run.end', { runId: o.runId, reason: 'cancelled' }); });
      for (const r of [clean, thrown, stopped]) for (const p of [kinds().schedule, kinds().manual]) await r.hopRunner(p)({ agentId: 'editor', text: 'x' });
      A.eq(during, ['cron', 'cron', 'cron', 'cron', 'cron', 'cron'], 'a routine hop is live in the registry while it runs');
      A.eq(live.size, 0, '…and gone after every exit: a clean end, a throw, a stop');
      await mk(async () => { throw new Error('never'); }).hopRunner(profiles.schedule(routine({ config: () => ({ ok: false, error: 'no key' }) })))({ agentId: 'editor', text: 'x' });
      A.eq(live.size, 0, 'a hop refused before it runs (no config) never enters it');
    }
  }

  /* ---- E. a ROUTINE seeds its line with stage one's terminal text (cron-driver, Run Now), and folds the line back (line-fire.js
         foldLineIntoFire, handed = that seed): a line that ran no hop and left the seed as it was keeps the reply stage one STREAMED
         (its host note was said to the person); a line that ran hops, or a gate that changed the text, delivers the line's ---- */
  {
    const { foldLineIntoFire } = require('../sidecar/routing/line-fire.js');
    const streamed = 'THE DRAFT\n\n' + HOST_NOTE + '\n';
    const fold = (line, handed) => foldLineIntoFire({ buf: streamed, usd: 0 }, Object.assign({ usd: 0, stopped: null, hops: [] }, line), handed).buf;
    A.eq(fold({ text: 'THE DRAFT' }, 'THE DRAFT'), streamed, 'a line that changed nothing keeps the reply stage one streamed');
    A.eq(fold({ text: 'THE EDIT', hops: [{ agentId: 'editor' }] }, 'THE DRAFT'), 'THE EDIT', 'a line that ran a hop delivers the line\'s answer');
    A.eq(fold({ text: 'THE DRAFT, approved' }, 'THE DRAFT'), 'THE DRAFT, approved', 'a gate that changed the text with no hop delivers the line\'s text');
    A.eq(fold({ text: 'THE DRAFT' }), 'THE DRAFT', 'a caller that names no seed folds exactly as before');
  }

  A.report('line-runner.test');
})().catch(e => { console.error(e); process.exit(1); });
