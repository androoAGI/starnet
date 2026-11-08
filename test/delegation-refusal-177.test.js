/* node test/delegation-refusal-177.test.js — A WORKER THAT COULD NOT START SAYS WHY (#177).

   "Atlas delegation to existing agent fails with generic worker startup error": every up-front refusal in the run host
   (sidecar/index.js runOnceCore: a full concurrency gate, an agent being deleted, a StarNet balance, a sign-in, a model
   that cannot run tasks, an image route, a key let go of, a recovery journal that could not be saved, a run stopped while
   queued) ends with RunTable.refuseRun's receipt and returns nothing, and every empty return read "the concurrent-agent
   cap was full, or a provider sign-in is needed" and was retried. Locked here with the host's own receipt function:
     · team.dispatch: the row carries the host's sentence, its failureCode and its transient flag, never the old guess;
       only a refusal that can pass (transient) is retried; a run stopped while queued is a stop, not a refusal;
       a host that leaves no receipt keeps the old row (and its one retry);
     · a background worker's ledger record keeps the code, and the DELEGATED card and NEEDS YOU word the real cause;
     · team.spawn and team.resume carry the same typed refusal;
     · every refusal in runOnceCore names its failureCode, so the row always has one. */
'use strict';
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sidecarTopLevelFunction } = require('./helpers/source');
const { refuseRun } = require('../sidecar/run-table.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');

function fakeRunOnce(impl) {
  const calls = [];
  const fn = async (o) => { calls.push(o); return impl(o, calls.length); };
  fn.calls = calls;
  return fn;
}
// the run host's own refusal: its one balanced receipt through the run's emit, then nothing (runOnceCore `refuse(...); return;`)
const refuses = (r) => (o) => { refuseRun(o.emit, { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' }, r); return undefined; };
const answers = (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: 'out:' + o.agentId }], usd: 0 });
const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const roster = new Map([['atlas', { system: 'A' }], ['researcher', { system: 'R' }]]);

const NO_TOOLS = 'The model "m" does not support tool calls, so it can\'t run tasks. Pick a tool-capable model (e.g. anthropic/claude-sonnet-4.6 or openai/gpt-4o) on the connect screen.';
const CAP = 'Too many agents are working at once (limit 3). Wait for one to finish, or raise STARNET_MAX_CONCURRENT_AGENTS.';
const RELOGIN = 'ChatGPT sign-in needed: the refresh token was revoked — sign in again';
const BROKE = 'Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).';

async function dispatch(impl, extra) {
  const ro = fakeRunOnce(impl), seen = [];
  const { dispatchTool } = makeOrchestrationTools(Object.assign({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() }, extra));
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'look into it' }] }, { agentId: 'atlas', emit: (n, p) => seen.push({ n, p }) });
  return { row: JSON.parse(out.content)[0], calls: ro.calls.length, seen };
}

(async () => {
  // ---- 1. team.dispatch: the host's own words, code and flag; no retry for a refusal that will come back -------------------
  {
    const { row, calls, seen } = await dispatch(refuses({ message: NO_TOOLS, failureCode: 'model_no_tools' }));
    A.eq([row.reason, row.failureCode, row.transient], ['refused', 'model_no_tools', false], 'a model that cannot run tasks: a typed refusal');
    A.ok(row.result.startsWith('worker could not start: ' + NO_TOOLS), 'the row says the host\'s own reason: ' + row.result);
    A.ok(!/concurrent-agent cap|sign-in is needed/.test(row.result), 'never the old guess (cap full, or a sign-in)');
    A.ok(/will not help until that is fixed/.test(row.result), 'and tells the lead a retry will not help');
    A.eq(calls, 1, 'a refusal that is not transient is never retried');
    A.ok(row.retried !== true, 'and is not marked retried');
    A.ok(seen.some(e => e.n === 'agent.run.error' && e.p.failureCode === 'model_no_tools'), 'the lead stream still gets the worker\'s own receipt');
  }
  {
    const { row, calls } = await dispatch(refuses({ message: RELOGIN, failureCode: 'auth', transient: false }));
    A.ok(row.reason === 'refused' && row.failureCode === 'auth' && row.result.includes(RELOGIN) && calls === 1,
      'a sign-in that needs the Commander names itself and is not retried (' + calls + ' calls)');
  }
  {
    const { row, calls } = await dispatch(refuses({ message: CAP, failureCode: 'concurrency_limit', transient: true }));
    A.eq(calls, 2, 'a transient refusal (a full gate) is retried once');
    A.ok(row.reason === 'refused' && row.retried === true && row.transient === true && row.failureCode === 'concurrency_limit', 'and, refused again, says so');
    A.ok(row.result.includes('Too many agents are working at once (limit 3)') && /can pass on its own/.test(row.result), 'with the gate\'s own sentence: ' + row.result);
  }
  {
    const { row, calls } = await dispatch((o, n) => n === 1 ? refuses({ message: 'ChatGPT sign-in needed: the token endpoint did not answer', failureCode: 'auth', transient: true })(o) : answers(o));
    A.ok(calls === 2 && row.reason === 'done', 'a transient sign-in refusal is retried, and the retry\'s work is the row (' + row.reason + ')');
  }
  {
    const { row, calls } = await dispatch(refuses({ reason: 'cancelled' }));
    A.ok(row.reason === 'cancelled' && /stopped while it waited/.test(row.result) && calls === 1, 'a run stopped while queued is a stop, never a refusal, and never retried: ' + row.result);
  }
  {
    const { row, calls } = await dispatch(() => undefined);
    A.ok(row.reason === 'refused' && /concurrent-agent cap/.test(row.result) && row.retried === true && calls === 2, 'a host that leaves no receipt keeps the old row and its one retry');
  }

  // ---- 2. a background worker: the ledger keeps the code, the card and NEEDS YOU say the real cause ------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-refusal-177-'));
  try {
    const file = path.join(root, 'subagents.json');
    const subagents = makeSubagentManager({ fs, pathMod: path, file, clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce(refuses({ message: BROKE, failureCode: 'managed_credit', transient: false, errorExtra: { reason: 'billing' } }));
    const tools = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents });
    await tools.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'look into it' }], background: true }, { agentId: 'atlas', runId: 'lead1', emit: () => {} });
    for (let i = 0; i < 6; i++) await tick();
    const rec = subagents.list({ agentId: 'researcher' })[0] || {};
    A.ok(rec.status === 'error' && rec.reason === 'refused' && rec.failureCode === 'managed_credit', 'the ledger record keeps the host\'s code: ' + JSON.stringify([rec.status, rec.reason, rec.failureCode]));
    A.ok(String(rec.result).includes(BROKE), 'and its sentence');
    const again = makeSubagentManager({ fs, pathMod: path, file, clock: { now: () => 2000 }, emit: () => {}, newId: counter() });
    A.eq((again.list({ agentId: 'researcher' })[0] || {}).failureCode, 'managed_credit', 'the code survives a restart');

    // a restart of that worker the host refuses again names its own cause, and a new generation never keeps an old code
    const resumeRo = fakeRunOnce(refuses({ message: RELOGIN, failureCode: 'auth', transient: false }));
    const resumer = makeOrchestrationTools({ runOnce: resumeRo, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents: again });
    await resumer.resumeTool.run({ id: rec.id }, { agentId: 'atlas', runId: 'lead2', emit: () => {} });
    for (let i = 0; i < 6; i++) await tick();
    const resumed = again.list({ agentId: 'researcher' })[0] || {};
    A.ok(resumed.reason === 'refused' && resumed.failureCode === 'auth' && /^worker could not restart: ChatGPT sign-in needed/.test(resumed.result),
      'team.resume: a refused restart says the host\'s cause: ' + resumed.result);
    const okRo = fakeRunOnce(answers);
    await makeOrchestrationTools({ runOnce: okRo, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents: again }).resumeTool.run({ id: rec.id }, { agentId: 'atlas', runId: 'lead3', emit: () => {} });
    for (let i = 0; i < 6; i++) await tick();
    const fine = again.list({ agentId: 'researcher' })[0] || {};
    A.ok(fine.status === 'done' && fine.failureCode === '', 'a later generation that ran keeps no old refusal code');

    // the card and NEEDS YOU read /api/overseer's projection of that record (failure + failureCode)
    global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
    global.document = undefined;
    const D = require('../frontend/app/delegated.js');
    const projected = { status: rec.status, reason: rec.reason, failure: String(rec.result).slice(0, 400), failureCode: rec.failureCode, runId: rec.runId };
    const st = D.stateOf({ ws: { id: 'k', history: [], runIds: [] }, worker: projected }, 'home', 'lead1');
    A.ok(/^failed · couldn't start: Out of managed credit — add credits in the STORE/.test(st.live), 'the card says the real cause: ' + st.live);
    A.ok(!/too many running|sign-in is needed/.test(st.live), 'never the old guess');
    A.eq(st.tip, projected.failure, 'the whole sentence stays the row\'s tip');
    A.eq(D.whyOfWorker({ reason: 'refused', failureCode: 'concurrency_limit', failure: 'worker could not start: ' + CAP + ' (this can pass on its own; dispatching it again later may work)' }),
      'couldn\'t start: Too many agents are working at once (limit 3)', 'a full gate reads as one, in its own words');
    A.eq(D.stateOf({ ws: { id: 'k', history: [], runIds: [] }, worker: { status: 'error', reason: 'refused', failure: 'subagent could not start — the concurrency cap is full' } }, 'home', 'lead1').live,
      'failed · couldn\'t start (too many running, or a sign-in is needed)', 'a record filed without a code keeps the old words');
    global.localStorage = { getItem: () => null, setItem: () => {} };
    const home = { id: 'home', title: null, agentId: 'atlas', history: [] };
    global.Workstreams = { get: id => (id === 'home' ? home : null), list: () => [home], unread: () => false, generalId: () => 'home', markRead: () => {} };
    global.Channels = { allPending: () => new Map() };
    global.GroupChat = { attentionIds: () => [], stateOf: () => null, membersOf: () => null };
    global.App = { agentName: id => id };
    global.Delegated = D;
    global.Overseer = { snapshot: () => ({ workers: [Object.assign({ agentId: 'researcher', parentStreamId: 'home', completedAt: 9000 }, projected)] }), fresh: () => true };
    const NY = require('../frontend/app/needsyou.js');
    const item = NY.items(10000).find(i => i.key === 'worker:' + rec.runId);
    A.ok(!!item && /^failed: couldn't start: Out of managed credit/.test(item.what), 'NEEDS YOU says the real cause too: ' + (item && item.what));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---- 3. team.spawn: the same typed refusal ---------------------------------------------------------------------------------
  {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-refusal-177-spawn-'));
    try {
      const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root2, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
      const ro = fakeRunOnce(refuses({ message: NO_TOOLS, failureCode: 'model_no_tools' }));
      const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
      const out = await spawnTool.run({ tasks: [{ prompt: 'summarize the notes' }] }, { agentId: 'atlas', emit: () => {} });
      const row = JSON.parse(out.content)[0] || {};
      A.ok(row.reason === 'refused' && row.failureCode === 'model_no_tools' && row.result.startsWith('subagent could not start: ' + NO_TOOLS),
        'team.spawn: a refused clone says the host\'s cause: ' + row.result);
      for (let i = 0; i < 4; i++) await tick();
      A.eq((subagents.list()[0] || {}).failureCode, 'model_no_tools', 'and its record keeps the code');
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  }

  // ---- 4. the host side: every up-front refusal in runOnceCore names its code ---------------------------------------------------
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    A.ok(core.length > 10000, 'runOnceCore found');
    const calls = [];
    for (const m of core.matchAll(/\brefuse\(\{/g)) {
      let depth = 0, i = m.index + 'refuse('.length, end = i;
      for (; i < core.length; i++) { const c = core[i]; if (c === '(' || c === '{') depth++; else if (c === ')' || c === '}') { if (--depth < 0) { end = i; break; } } }
      calls.push(core.slice(m.index, end + 1));
    }
    A.ok(calls.length >= 15, 'every refusal site is read (' + calls.length + ')');
    const bare = calls.filter(c => !/failureCode/.test(c) && !/reason: '(?:done|budget)'/.test(c));
    A.eq(bare, [], 'each refusal names a failureCode (a script-only done and the line budget are not refusals)');
    A.ok(/const endUnstarted = \(message, transient\) => refuse\(\{ message, transient, failureCode: 'auth' \}\)/.test(core), 'a run that ends before its first call names its code too');
    A.ok(/refuse\(\{ transient: refusal\.transient, errorExtra: \{ reason: 'billing' \}, message: refusal\.message, failureCode: refusal\.code \}\)/.test(core), 'and a StarNet balance refusal its own');
  }
  A.report('delegation-refusal-177');
})().catch(error => { A.ok(false, error.stack); A.report('delegation-refusal-177'); });
