/* node test/cron.chain.test.js — A ROUTINE FIRES A WORK LINE, NOT JUST A RUN.

   A routine fires at ONE dock. If the Commander drew stages downstream of that dock, those stages ARE the
   routine ("every morning research it, then write it up"). This locks the cron-driver's advanceChain seam:
     · the line runs AFTER the job's own run settles but BEFORE finishFire, so the routine's recorded outcome
       and its session transcript carry the LINE's answer, never stage one's raw material;
     · each hop renews the lease — a line that outran the heartbeat would be swept as a zombie and re-fired;
     · A CHAIN FAILURE NEVER CHANGES THE ROUTINE'S OUTCOME (stage one really did run and really did work). */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));

function setup(opts) {
  opts = opts || {};
  const clock = makeClock(T0);
  const schedule = cron.parseSchedule('every 1m', T0);
  let store = [cronStore.makeJob({ id: 'j1', prompt: 'research the thing', agentId: 'researcher', schedule, unattendedGrants: opts.grants, runsLine: opts.runsLine }, { id: 'j1', now: T0 })];
  const events = [], runs = [], chainCalls = [];
  let idN = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => new Promise((resolve, reject) => { runs.push({ opts: o, resolve, reject }); }),
    emit: (name, payload) => events.push({ name, payload }),
    newId: () => 'run-' + (++idN), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000,
    advanceChain: opts.advanceChain ? (o) => { chainCalls.push(o); return opts.advanceChain(o); } : undefined,
    stageBriefFor: opts.stageBriefFor,
    contextFor: opts.contextFor
  });
  return { driver, clock, events, runs, chainCalls, getJob: (id) => cronStore.getJob(store, id) };
}
const lastOf = (events, name) => { const m = events.filter(e => e.name === name); return m.length ? m[m.length - 1].payload : undefined; };
// fire the due job and settle its run with `reply`
async function fireAndSettle(s, reply) {
  s.clock.set(T0 + 60000);
  s.driver.applyTick(s.clock.now());
  A.eq(s.runs.length, 1, 'the routine fired one run');
  s.runs[0].opts.emit('agent.token', { delta: reply });
  s.runs[0].opts.emit('agent.run.end', { reason: 'done' });
  s.runs[0].resolve();
  await flush(); await flush(); await flush();
}

(async function () {

  /* ---- A contextFrom ROUTINE HANDS ITS UPSTREAM CONTEXT DOWN THE LINE (token-burn audit 2026-10-17). Hops no longer replay
         the fire's stream, so the handoff's "original request" is the only place a downstream stage meets the routine's
         upstream material: it must be the ASSEMBLED prompt the entry run was given, not the bare directive. ---- */
  {
    const s = setup({ contextFor: () => 'UPSTREAM DIGEST: three findings from yesterday', advanceChain: async () => ({ text: 'WRITE-UP', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'raw findings');
    const entryText = JSON.stringify(s.runs[0].opts.messages || []);
    A.ok(entryText.indexOf('UPSTREAM DIGEST') >= 0, 'fixture: the entry run was given the upstream context');
    A.ok(s.chainCalls.length === 1 && s.chainCalls[0].originalText.indexOf('UPSTREAM DIGEST: three findings from yesterday') >= 0, 'the line is handed the upstream context as part of the original ask');
    A.ok(s.chainCalls[0].originalText.indexOf('research the thing') > s.chainCalls[0].originalText.indexOf('UPSTREAM DIGEST'), '...with the routine directive after it, exactly as the entry run read it');
    A.eq(s.chainCalls[0].ask, 'research the thing', '...and the bare directive as `ask` (what a SEND TO record carries on)');
  }

  /* ---- the line's answer replaces stage one's, and the routine still settles OK ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: 'THE FINISHED WRITE-UP', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'raw findings about the thing');
    A.eq(s.chainCalls.length, 1, 'the work line was advanced once');
    A.eq(s.chainCalls[0].agentId, 'researcher', "starting at the routine's own dock");
    A.eq(s.chainCalls[0].text, 'raw findings about the thing', "handed stage one's real output");
    A.eq(s.chainCalls[0].originalText, 'research the thing', "and the routine's own prompt as the original ask");
    A.eq(s.chainCalls[0].streamId, 'cron-run-1', "hops ride the ROUTINE's stream so its session shows the whole line");
    A.eq(s.chainCalls[0].runId, 'run-1', 'shipment identity is the exact scheduled entry run');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the routine settles ok');
    A.eq(s.getJob('j1').lastStatus, 'ok', 'and its durable record is clean');
  }

  /* ---- (quick win 25, GitHub #122) a line that STOPPED SHORT says so on the routine's answer and record ----
     The hub has always appended chain.stopNote and handed stopped/unapproved/partial to its outcome hook; the routine
     took only the line's text, so a line that died at stage two delivered stage one's answer as if the line had run. */
  {
    const s = setup({ advanceChain: async () => ({ text: 'THE DRAFT', hops: [{ agentId: 'writer' }], stopped: 'editor failed: provider 500', unapproved: 'the review loop used all 2 passes, so the work went on unapproved', usd: 0.25 }) });
    await fireAndSettle(s, 'raw findings');
    const job = s.getJob('j1');
    A.eq(job.lastStatus, 'ok', 'a line failure still never changes the routine\'s outcome');
    A.ok(/^THE DRAFT\n\n⚠ the work line stopped early — editor failed: provider 500\.$/.test(job.lastOutput), 'the delivered answer says the line stopped early, and why: ' + JSON.stringify(job.lastOutput));
    A.eq(job.lastLine, { stopped: 'editor failed: provider 500', unapproved: 'the review loop used all 2 passes, so the work went on unapproved' }, 'the routine\'s record keeps the line\'s stop facts');
    A.ok(/stopped early/.test((job.finalization && job.finalization.result) || ''), 'and the delivery receipt carries the same words');
    A.eq(job.lastUsd, 0.25, 'the line\'s hop spend is added to the entry run\'s (foldLineIntoFire)');
    const { lineStopNote } = require('../sidecar/routing/line-fire.js');
    const { makeChainRunner } = require('../sidecar/routing/chain.js');
    A.eq(makeChainRunner({ plan: () => null, runAgent: async () => ({}) }).stopNote({ stopped: 'x' }), lineStopNote({ stopped: 'x' }), 'the channel hub and the routine say it in ONE wording (chain.stopNote is lineStopNote)');
  }
  {
    // Run Now (index.js handleCronRun) calls chainRunner.advance itself: it must fold the line through the SAME helper
    const { sidecarTopLevelFunction } = require('./helpers/source.js');
    const runNow = sidecarTopLevelFunction('handleCronRun');
    A.ok(runNow.length > 1000 && /chainRunner\.advance\(/.test(runNow), 'fixture: handleCronRun is sliced and runs the line');
    A.ok(/foldLineIntoFire\(state, line\)/.test(runNow), 'Run Now folds its line through foldLineIntoFire (stop note + stop facts), like the scheduled fire');
    A.ok(!/state\.buf = line\.text/.test(runNow), 'and no longer takes only the line\'s text');
  }
  {
    // a clean line leaves no facts behind (and clears an earlier fire's)
    const s = setup({ advanceChain: async () => ({ text: 'CLEAN', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'raw');
    A.eq(s.getJob('j1').lastLine, null, 'a clean line records no stop facts');
    A.eq(s.getJob('j1').lastOutput, 'CLEAN', 'and adds no note');
  }

  /* ---- a TRUNCATED entry run buys no hops: the line advances only on reason 'done' ---- */
  // max_turns/budget/missing-terminal set no errMsg, yet finishFire records them as failures. The old gate
  // read only errMsg+buf, so a truncated run spent real money on every downstream hop over partial stage-one
  // material — and then the routine was recorded failed anyway.
  {
    const s = setup({ advanceChain: async () => ({ text: 'SHOULD NEVER RUN', hops: [{}], stopped: null }) });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'the routine fired one run');
    s.runs[0].opts.emit('agent.token', { delta: 'partial material before the ceiling' });
    s.runs[0].opts.emit('agent.run.end', { reason: 'max_turns' });
    s.runs[0].resolve();
    await flush(); await flush(); await flush();
    A.eq(s.chainCalls.length, 0, 'a max_turns entry run advances NO downstream hop');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'failed', 'and the routine settles as the failure finishFire already judged it');
  }

  /* ---- the lease is renewed per hop: a long line must not be swept as a zombie ---- */
  {
    let renewed = 0;
    const s = setup({ advanceChain: async (o) => { o.onHop(); o.onHop(); renewed = 2; return { text: 'done', hops: [{}, {}], stopped: null }; } });
    await fireAndSettle(s, 'stage one');
    A.eq(renewed, 2, 'every hop got an onHop callback to renew the lease');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the run settled normally, not as a stale lease');
  }

  /* ---- the driver hands the seam the ENTRY run's reconciled spend (2026-08-10 audit): the chain's $
     ceiling covers the WHOLE line, so advanceChain must know what stage one already cost. ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: 'line done', hops: [{ agentId: 'writer' }], stopped: null }) });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'the routine fired one run');
    s.runs[0].opts.emit('agent.token', { delta: 'stage one work' });
    s.runs[0].opts.emit('agent.run.end', { reason: 'done', usd: 0.42 });
    s.runs[0].resolve();
    await flush(); await flush(); await flush();
    A.eq(s.chainCalls.length, 1, 'the line advanced');
    A.eq(s.chainCalls[0].entryUsd, 0.42, "the seam carries stage one's reconciled spend into the chain's ceiling");
  }

  /* ---- A CHAIN FAILURE NEVER CHANGES THE ROUTINE'S OUTCOME ---- */
  {
    const s = setup({ advanceChain: async () => { throw new Error('downstream exploded'); } });
    await fireAndSettle(s, 'stage one really worked');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'stage one really ran and really produced work — the routine is ok');
    A.eq(s.getJob('j1').lastStatus, 'ok', 'the durable record agrees');
  }

  /* ---- a line that returns nothing leaves stage one's answer alone ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: '   ', hops: [], stopped: 'x' }) });
    await fireAndSettle(s, 'stage one output');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'an empty line never blanks the routine');
  }

  /* ---- GRANTS NEVER FLOW DOWN A LINE (2026-08-04): the unattended grant the Commander recorded names ONE
     agent — the routine's own dock. Stage one runs with it; every downstream hop runs UNGRANTED, so drawing
     a belt to another dock can never silently extend terminal/verify authority onto a different agent. ---- */
  {
    const s = setup({ grants: ['workbench'], advanceChain: async () => ({ text: 'line done', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'stage one output');
    A.eq(s.runs[0].opts.unattendedGrants, ['workbench'], "stage one (the routine's own agent) keeps the recorded grant");
    A.eq(s.chainCalls.length, 1, 'the line still advanced');
    A.eq(s.chainCalls[0].unattendedGrants, [], 'the advanceChain seam is handed an EMPTY grants list — hops never inherit authority');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'and the routine still settles ok');
  }
  // the images grant (2026-10-18) obeys the same law: the routine's own agent may make pictures, a later stage may not
  {
    const s = setup({ grants: ['studio'], advanceChain: async () => ({ text: 'line done', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'stage one output');
    A.eq(s.runs[0].opts.unattendedGrants, ['studio'], "stage one keeps the recorded images grant");
    A.eq(s.chainCalls[0].unattendedGrants, [], 'a downstream hop is handed NO images grant');
  }

  /* ---- THE DOCK'S STANDING BRIEF RIDES A SCHEDULED ENTRY RUN (inbox-trigger, 2026-08-05). A routine's
     fire was the ONE entry-run path that never briefed its dock: the same agent ran WITH its standing brief
     from a routed message (hub.js) and WITHOUT it from a routine. The driver now asks the injected
     stageBriefFor(agentId) — index.js wires router.stageBrief, the same seam the hub and chain handoffs
     read — and appends the brief to the run's SYSTEM under the hub's exact section header. Prompt text
     only: grants/tools/messages are untouched. ---- */
  {
    const s = setup({ stageBriefFor: (aid) => (aid === 'researcher' ? 'Dig three primary sources, cite them.' : null) });
    await fireAndSettle(s, 'stage one output');
    A.eq(s.runs[0].opts.system, 'PERSONA\n\nYOUR STANDING BRIEF FOR THIS STATION:\nDig three primary sources, cite them.',
      "the entry run's system carries the dock's standing brief under the hub's exact section header");
    A.eq(s.runs[0].opts.messages[0].content, 'research the thing', 'the brief rides SYSTEM — the user message is untouched');
    A.eq(s.runs[0].opts.unattendedGrants, [], 'and a brief never smuggles grants');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the routine settles ok');
  }

  /* ---- no seam / no brief -> the exact pre-brief system string (byte-identical) ---- */
  {
    const s = setup({});
    await fireAndSettle(s, 'plain');
    A.eq(s.runs[0].opts.system, 'PERSONA', 'no stageBriefFor seam -> pre-brief system, byte-identical');
  }
  {
    const s = setup({ stageBriefFor: () => null });
    await fireAndSettle(s, 'plain');
    A.eq(s.runs[0].opts.system, 'PERSONA', 'a seam with no brief for this dock -> pre-brief system, byte-identical');
  }

  /* ---- a THROWING brief seam never kills the fire (a brief is an enhancement, not a gate) ---- */
  {
    const s = setup({ stageBriefFor: () => { throw new Error('boom'); } });
    await fireAndSettle(s, 'still works');
    A.eq(s.runs[0].opts.system, 'PERSONA', 'a throwing brief seam degrades to the pre-brief system');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'and the routine still settles ok');
  }

  /* ---- NO advanceChain injected = today's single-run routine, untouched ---- */
  {
    const s = setup({});
    await fireAndSettle(s, 'just the one stage');
    A.eq(s.chainCalls.length, 0, 'no chain seam, no chain');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'and the routine behaves exactly as before');
  }

  /* ---- a FAILED stage-one run never advances a line (nothing real to hand on) ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: 'should never happen', hops: [{}] }) });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    s.runs[0].opts.emit('agent.run.error', { message: 'provider down' });
    s.runs[0].resolve();
    await flush(); await flush(); await flush();
    A.eq(s.chainCalls.length, 0, 'a failed stage one hands nothing downstream');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'failed', 'and the routine reports the failure honestly');
  }

  /* ---- ONLY A ROUTINE THAT BELONGS TO THE LINE RUNS THE LINE ----
     Work belongs to a line (Andrew's ruling, 2026-08-07). Deciding that from the DOCK alone was a money bug:
     a routine created months before the workflow existed started buying a run per drawn stage the instant its
     agent was crewed onto a line — and the text it delivered became the LAST stage's output instead of its own
     answer. So the intent is durable and OPT-IN (`runsLine` on the job record, set only by the INBOX trigger
     zone's create), and its ABSENCE is terminal. Wired here exactly as the composition root does
     (sidecar/index.js: `lineId: o.runsLine === true ? router.lineOfAgent(o.agentId) : null`), over the REAL
     router and the REAL chain runner, so this proves the semantics rather than a mock's opinion of them. */
  {
    const Pipeline = require('../frontend/app/pipeline.js');
    const { makeRouter } = require('../sidecar/routing/router.js');
    const { makeChainRunner } = require('../sidecar/routing/chain.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const router = makeRouter();
    A.ok(router.setPlan(Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E')]
    })).ok, 'the routine floor deploys');

    const hopRuns = [];
    const chain = makeChainRunner({
      nextAgent: (a, ctx) => router.chainNext(a, ctx),
      runAgent: async (h) => { hopRuns.push(h.agentId); return { text: h.agentId + ' output' }; },
      now: () => 0
    });
    // the EXACT shape index.js injects, quoted so the two cannot drift apart unnoticed
    const advanceChain = (o) => chain.advance({
      agentId: o.agentId, text: o.text, originalText: o.originalText, signal: o.signal,
      lineId: o.runsLine === true ? router.lineOfAgent(o.agentId) : null
    });

    /* A PRE-EXISTING ROUTINE AT A DOCKED AGENT SPENDS EXACTLY ONE PROVIDER CALL. This is the money case:
       the job was created before the line was ever drawn, so it carries no marker. Its own run happens; the
       drawn stages downstream do NOT, and the answer delivered is the routine's own. */
    {
      const s = setup({ advanceChain });
      A.eq(s.getJob('j1').runsLine, false, 'a routine created without the marker is TERMINAL by default');
      await fireAndSettle(s, 'raw findings about the thing');
      A.eq(s.runs.length, 1, 'PROVIDER CALLS: exactly ONE — the routine\'s own run');
      A.eq(s.chainCalls[0].runsLine, false, 'the driver hands the seam the durable flag, never a guess from the dock');
      A.eq(hopRuns.length, 0, '…and ZERO downstream: a routine that predates the workflow never buys its stages');
      A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the routine still settles ok');
      A.eq(s.getJob('j1').lastOutput, 'raw findings about the thing', "and DELIVERS ITS OWN answer, not a later stage's");
    }

    /* THE SAME FLOOR, THE SAME DOCK — with the marker the Commander set by creating it from the line's
       INBOX trigger zone. Now the routine IS the line's trigger and the drawn stages run. */
    {
      hopRuns.length = 0;
      const s = setup({ advanceChain, runsLine: true });
      A.eq(s.getJob('j1').runsLine, true, 'the INBOX-created routine carries the durable marker');
      await fireAndSettle(s, 'raw findings about the thing');
      A.eq(s.chainCalls[0].runsLine, true, 'the driver passes it through');
      A.eq(hopRuns, ['writer'], "a routine that BELONGS to the line runs that line's next stage");
      A.eq(s.getJob('j1').lastOutput, 'writer output', "and the line's answer is what the routine delivers");
    }

    // a MARKED routine at an agent that crews NO dock: no line to run, and nothing downstream is bought
    hopRuns.length = 0;
    A.eq(router.lineOfAgent('freelancer'), null, 'an undocked agent belongs to no line');
    const off = await chain.advance({ agentId: 'freelancer', text: 'raw findings', lineId: router.lineOfAgent('freelancer') });
    A.eq(off.hops.length, 0, 'so even a marked routine there is terminal');
    A.eq(hopRuns.length, 0, 'PROVIDER CALLS: zero — a routine can never spend on a line it is not on');
  }

  /* ---- THE MARKER IS DURABLE AND CANNOT BE FAKED BY A TRUTHY VALUE ---- */
  {
    const schedule = cron.parseSchedule('every 1m', T0);
    const mk = v => cronStore.makeJob({ id: 'j', prompt: 'p', agentId: 'a', schedule, runsLine: v }, { id: 'j', now: T0 });
    A.eq(mk(undefined).runsLine, false, 'absent -> false (a routine made anywhere else stays terminal)');
    A.eq(mk('yes').runsLine, false, 'a truthy STRING cannot buy a work line');
    A.eq(mk(1).runsLine, false, 'nor can a truthy number');
    A.eq(mk(true).runsLine, true, 'only a literal true opts in');
    let jobs = [mk(undefined)];
    jobs = cronStore.updateJob(jobs, 'j', { runsLine: true }, { now: T0 });
    A.eq(cronStore.getJob(jobs, 'j').runsLine, true, 'and it is an EDITABLE field, so the console can turn it on');
    jobs = cronStore.updateJob(jobs, 'j', { runsLine: 'nope' }, { now: T0 });
    A.eq(cronStore.getJob(jobs, 'j').runsLine, false, 'a patch is re-normalized through the same === true rule');
  }

  A.report('cron.chain');
})();
