/* node test/governor.every-call.test.js — ONE GOVERNOR ADMITS EVERY PAID CALL (spend-governor S2). On test/http.list (child-process boots).

   Every paid call path used to decide its own admission: nine budget.check call sites in sidecar/index.js with three readings of
   a check that throws (proceed, refuse, note and proceed), a dollar cap applied to calls that spend no dollars, and none at all
   for the skill curator. They now ask billing-class.js makeGovernor, which routes by the route's payer.

   SOURCE: no budget.check( call is left outside makeGovernor and the run's own check (loop.js asks runBudget).
   THE REAL SIDECAR, a stored ChatGPT sign-in and an OpenRouter key, both pushed to one local fake at the transport edge (the
   desktop's runtime push; the subscription-stacking-oauth.e2e pattern; every other outbound fetch refused, and the autonomy
   dial at WAIT so every quest refresh is a press), a chosen $1 day cap (STARNET_BUDGET_PER_DAY):
     - on the key: a one-shot (POST /api/routing/line-draft) runs under the cap; a run whose call costs $2 then reaches it, and
       from there no metered call path reaches the transport: not the run-end passes, not another run, not the one-shot, not
       REFRESH QUESTS;
     - on the ChatGPT plan the same reached cap refuses none of them (they spend no dollars): the one-shot, REFRESH QUESTS, a run
       and its run-end passes all reach the fake. At the 24-hour background token ceiling the automatic passes stop while the
       Commander's one-shot and REFRESH QUESTS still run;
     - every row these calls booked names its payer: metered on the key, subscription on the plan.
   A CHECK THAT THROWS (a sidecar booted with a budget whose side-effect-free check throws) refuses the one-shot with its exit
   named and stops the run-end passes, where both used to proceed; REFRESH QUESTS keeps its refusal.
   RED at base: the plan's one-shot answers 409 "the station's spending cap is reached"; the booked aux, one-shot and quest rows
   name no payer; a throwing check lets the one-shot and the run-end passes through; 9 direct budget.check call sites. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { sidecarSourceFiles } = require('./helpers/source.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const IPC = 'governor-every-call-ipc-token-0123456789';
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/profile': { email: 'plan@example.test' } })).toString('base64url') + '.fixture';
const LONG = ('I rebuilt the staging rollback path end to end. Here is the write-up with the reasoning, the tradeoffs and the follow-ups worth remembering. ').repeat(45);
const DRAFT = JSON.stringify({ starter: 'research_line', name: 'Trip Planner', steps: { RESEARCHER: 'Find the facts the job needs.', WRITER: 'Write the finished plan.' }, job: 'Plan a weekend trip' });
const LINE = { want: 'a line that plans trips', starters: [{ id: 'research_line', name: 'Research', purpose: 'find and write', roles: ['RESEARCHER', 'WRITER'] }] };
const PASS_KINDS = ['reflection', 'failure-review', 'study', 'threadmine', 'scout'];

// ---- SOURCE: one admission ----
{
  const offenders = [];
  for (const f of sidecarSourceFiles()) {
    const lines = f.text.split('\n');
    const runGuard = lines.findIndex(l => /^    function stopForSpend\(/.test(l));
    const runGuardEnd = lines.findIndex((l, i) => i > runGuard && /^    \}$/.test(l));
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '');
      if (!/\bbudget\.check\(/.test(code) || /^\s*(\*|\/\*)/.test(l)) return;
      const allowed = (f.rel === 'sidecar/billing-class.js') || (f.rel === 'sidecar/loop.js' && runGuard >= 0 && i > runGuard && i < runGuardEnd
        && /const b = budget\.check\(spentUsd, callBound\);/.test(code));
      if (!allowed) offenders.push(f.rel + ':' + (i + 1) + ': ' + l.trim().slice(0, 100));
    });
  }
  A.eq(offenders, [], 'no budget.check( call outside makeGovernor and the run\'s own check (loop.js asks runBudget)');
  const gov = sidecarSourceFiles().find(f => f.rel === 'sidecar/billing-class.js');
  A.ok(!!gov && /function makeGovernor\(/.test(gov.text) && /budget\.check\(/.test(gov.text.slice(gov.text.indexOf('function makeGovernor('))), 'billing-class.js makeGovernor holds the one dollar check');
}

// ---- the fake: OpenRouter and the ChatGPT plan's Codex endpoint at the transport edge, every call counted by kind ----
function startFake() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const route = req.url.split('/')[1];
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const id = route === 'codex' ? 'gpt-5.5' : 'or/model';
        res.end(JSON.stringify({ data: [{ id, context_length: 400000, supported_parameters: ['tools'] }], models: [] }));
        return;
      }
      const kind = raw.indexOf('You set up a work line for someone') >= 0 ? 'linedraft' : raw.indexOf('quest master') >= 0 ? 'quest' : raw.indexOf('[RUNTIME]') >= 0 ? 'run' : 'aux';
      calls.push({ route, kind });
      const text = kind === 'linedraft' ? DRAFT : kind === 'quest' ? 'NONE' : kind === 'run' ? LONG : 'nothing durable.';
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (route === 'codex') {
        send({ type: 'response.output_text.delta', delta: text });
        send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3000, output_tokens: 500 } } });
      } else {
        const cost = kind === 'run' ? 2 : kind === 'linedraft' ? 0.3 : 0.001;
        send({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost } });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port })));
}

const ENV = { STARNET_IPC_TOKEN: IPC, STARNET_BUDGET_PER_DAY: '1', SKYNET_AUX_BUDGET: '0', STARNET_DEBUG_CHANNELS: '1',
  STARNET_WORKER_STALL_MS: '450000.9', STARNET_WORKER_STALL_IN_TOOL_MS: '100', STARNET_WORKER_MAX_ITERS: '3.5',
  STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', STARNET_DEFAULT_MODEL: 'or/model', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '' };
for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'CREDITS_API_KEY', 'AUX_MODEL', 'REFLECT_MODEL', 'MAX_ITERS', 'MAX_SUBSCRIPTION_TOKENS']) { ENV[name] = ''; ENV['STARNET_' + name] = ''; ENV['SKYNET_' + name] = ''; }

function seed(workspace) {
  fs.mkdirSync(path.join(workspace, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'codex', 'tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'Bearer' }));
  // quest evidence, and the dial at WAIT, so no automatic look fires on its own (a new station's PROPOSE looks at boot, before
  // the sign-in's endpoint is pushed): every refresh here is REFRESH QUESTS
  fs.writeFileSync(path.join(workspace, '_commander.dossier.json'), JSON.stringify({ block: 'COMMANDER DOSSIER\n- Goals: plan the spring trip' }));
  fs.writeFileSync(path.join(workspace, '_commander.autonomy.json'), JSON.stringify({ v: 1, posture: { v: 1, initiative: 'wait', reach: 'observe', leashPerDay: 3 }, beliefs: null }));
}
/* the boot entry: the real sidecar with every fetch to a host that is not loopback refused (nothing here may reach a real
   provider; a fixture sign-in sent to the real ChatGPT endpoint comes back dead), and optionally a budget whose
   side-effect-free check throws */
const NETLESS = "const real = globalThis.fetch;\n" +
  "globalThis.fetch = function (url) { const u = String((url && url.url) || url); return /^https?:[/][/](127[.]0[.]0[.]1|localhost)[:/]/.test(u) ? real.apply(this, arguments) : Promise.reject(new Error('governor.every-call: no network in this test (' + u + ')')); };\n";
function bootEntry(dir, budgetFault) {
  const entry = path.join(dir, 'boot.js');
  const budgetJs = path.resolve(__dirname, '..', 'sidecar', 'budget.js'), indexJs = path.resolve(__dirname, '..', 'sidecar', 'index.js');
  fs.writeFileSync(entry, "'use strict';\n" + NETLESS + (budgetFault ? 'const b = require(' + JSON.stringify(budgetJs) + '), mk = b.makeBudget;\n' +
    'b.makeBudget = (...a) => { const v = mk(...a), check = v.check; v.check = (runId, ...rest) => { if (runId == null) throw new Error("injected spend check fault"); return check(runId, ...rest); }; return v; };\n' : '') +
    'require(' + JSON.stringify(indexJs) + ');\n');
  return entry;
}
function rig(fixture, fake) {
  const rows = () => { try { return fs.readFileSync(path.join(fixture.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
  const count = (route, kind) => fake.calls.filter(c => (!route || c.route === route) && (!kind || c.kind === kind)).length;
  async function settle() {
    let last = '', since = Date.now();
    for (const until = Date.now() + 20000; Date.now() < until; await sleep(250)) {
      const now = fake.calls.length + ':' + rows().length;
      if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= 1500) return;
    }
  }
  async function push(provider, key) {
    const res = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider, key, baseUrl: fake.base + '/' + provider }) });
    A.eq(res.status, 200, provider + ': its endpoint is pushed to the fake');
  }
  async function roster(stationProvider) {
    const agents = [{ agentId: 'agent', name: 'NOVA', provider: stationProvider, model: stationProvider === 'codex' ? 'gpt-5.5' : 'or/model' },
      { agentId: 'gov-or', name: 'KEY', provider: 'openrouter', model: 'or/model' }, { agentId: 'gov-cx', name: 'PLAN', provider: 'codex', model: 'gpt-5.5' }];
    A.eq((await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents })).status, 200, 'the station default runs on ' + stationProvider);
  }
  async function run(agentId, provider) {
    const res = await fixture.json('POST', '/api/run', { agentId, provider, model: provider === 'codex' ? 'gpt-5.5' : 'or/model', isTask: true,
      messages: [{ role: 'user', content: 'Rebuild the staging rollback path and write up what changed and why.' }] });
    const events = String(res.text || '').split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
    const start = events.find(e => e.name === 'agent.run.start');
    const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
    await settle();
    return { runId: start && start.payload.runId, end, errors: events.filter(e => e.name === 'agent.run.error').map(e => e.payload.message) };
  }
  const lineDraft = () => fixture.json('POST', '/api/routing/line-draft', LINE);
  async function refreshQuests() {
    const before = ((await fixture.json('GET', '/api/quests/refresh')).body.ledger || []).length;
    A.eq((await fixture.json('POST', '/api/quests/refresh/run', {})).body.started, true, 'REFRESH QUESTS starts a cycle');
    for (const until = Date.now() + 20000; Date.now() < until; await sleep(250)) {
      const s = (await fixture.json('GET', '/api/quests/refresh')).body;
      if (!s.inFlight && (s.ledger || []).length > before) { await settle(); return s.ledger[s.ledger.length - 1]; }
    }
    return null;
  }
  const passRows = (route, from) => rows().slice(from).filter(r => PASS_KINDS.includes(r.aux) && r.provider === route);
  return { rows, count, settle, push, roster, run, lineDraft, refreshQuests, passRows };
}

async function capArm(fake, shim) {
  const fixture = SidecarFixture.create({ prefix: 'gov-every-call-', timeoutMs: 30000, entry: bootEntry(fs.mkdtempSync(path.join(shim, 'cap-')), false), env: ENV });
  const t = rig(fixture, fake);
  try {
    seed(fixture.workspace);
    await fixture.start();
    await t.push('openrouter', 'or-fixture-key');
    await t.push('codex', '');
    await t.roster('openrouter');

    // Readback comes from enforcing owners and actual station routes. Saving a restart-only choice must
    // not advertise it as active, while the sign-in ceiling applies to the next run immediately.
    const inventory = (await fixture.json('GET', '/api/budget/status')).body.effective;
    A.ok(inventory && inventory.classes.includes('metered') && inventory.classes.includes('subscription'), 'effective inventory includes both configured payer routes');
    const effectiveRow = (value, key) => value && value.rows.find(r => r.key === key);
    const day = effectiveRow(inventory, 'perDay');
    A.eq(day && [day.value, day.source], [1, 'env'], 'effective day rail is the actual configured cap');
    A.eq([effectiveRow(inventory, 'workerStallMs').value, effectiveRow(inventory, 'workerStallInToolMs').value], [450000, 450000], 'liveness readback uses owner normalization and the tool-silence floor');
    A.eq(effectiveRow(inventory, 'workerIters').value, 3, 'worker turn readback matches the whole-turn ceiling');
    A.eq(effectiveRow(inventory, 'perRun').inUse, ['metered'], 'the plan route has no dollar-run cap');
    const knobs = (await fixture.json('GET', '/api/runtime/knobs')).body;
    A.eq(knobs.definitions.map(d => d.key), require('../sidecar/limits-registry.js').keys('runtime'), 'real API supplies the editor definitions');
    const pending = await fixture.json('POST', '/api/runtime/knobs', { maxIters: 2, maxSubscriptionTokens: 3000000 });
    A.eq(pending.status, 200, 'runtime limit choices saved through real handler');
    A.ok(/next run/.test(pending.body.appliesMessage) && /restart/.test(pending.body.appliesMessage), 'save distinguishes the two application times');
    const changed = (await fixture.json('GET', '/api/budget/status')).body.effective;
    A.eq([effectiveRow(changed, 'maxIters').value, effectiveRow(changed, 'maxIters').nextValue], [0, 2], 'restart-only value remains pending');
    A.eq([effectiveRow(changed, 'maxSubscriptionTokens').value, effectiveRow(changed, 'maxSubscriptionTokens').source], [3000000, 'saved'], 'next-run sign-in ceiling is active and saved');
    A.eq((await fixture.json('POST', '/api/runtime/knobs', { maxIters: null, maxSubscriptionTokens: null })).status, 200, 'restore fixture defaults before paid-path proofs');

    // ===== ON THE KEY: under the cap the one-shot runs; a $2 run reaches the cap, and from there no metered call goes out =====
    const draft = await t.lineDraft();
    A.eq([draft.status, draft.body && draft.body.starter], [200, 'research_line'], 'key, under the cap: the one-shot runs: ' + draft.text.slice(0, 200));
    const keyed = await t.run('gov-or', 'openrouter');
    A.eq([keyed.end.reason, t.count('openrouter', 'run')], ['done', 1], 'key: the $2 run finished (the $1 day cap is reached by it): ' + JSON.stringify(keyed.errors));
    A.eq(t.count('openrouter', 'aux'), 0, 'key, cap reached: no run-end pass reaches the transport');
    const capped = t.count('openrouter');
    const again = await t.run('gov-or', 'openrouter');
    A.eq(again.end.reason, 'budget', 'key, cap reached: the next run stops before its first call');
    const draft2 = await t.lineDraft();
    A.eq([draft2.status, /spending cap is reached/.test(draft2.body && draft2.body.error)], [409, true], 'key, cap reached: the one-shot is refused: ' + draft2.text.slice(0, 200));
    const quest = await t.refreshQuests();
    A.ok(!!quest && quest.outcome === 'skipped' && /spending cap reached \(day\)/.test(quest.reason || ''), 'key, cap reached: REFRESH QUESTS stands down: ' + JSON.stringify(quest));
    A.eq(t.count('openrouter') - capped, 0, 'key, cap reached: no metered call path reached the transport (run, one-shot, quest refresh, run-end passes)');

    // ===== ON THE CHATGPT PLAN: the same reached cap refuses none of them =====
    await t.roster('codex');
    const planDraft = await t.lineDraft();
    A.eq([planDraft.status, planDraft.body && planDraft.body.starter, t.count('codex', 'linedraft')], [200, 'research_line', 1], 'plan, cap reached: the one-shot runs (it spends no dollars): ' + planDraft.text.slice(0, 200));
    const planQuest = await t.refreshQuests();
    A.eq([planQuest && planQuest.outcome, t.count('codex', 'quest')], ['none', 1], 'plan, cap reached: REFRESH QUESTS runs: ' + JSON.stringify(planQuest));
    const before = t.rows().length;
    const plan = await t.run('gov-cx', 'codex');
    A.eq([plan.end.reason, t.count('codex', 'run')], ['done', 1], 'plan, cap reached: the run runs: ' + JSON.stringify(plan.errors));
    A.ok(t.count('codex', 'aux') >= 1 && t.passRows('codex', before).length >= 1, 'plan, cap reached: its run-end passes run: ' + JSON.stringify(t.passRows('codex', before).map(r => r.aux)));

    // ===== the 24-hour background token ceiling: the automatic passes stop on the plan; a press does not =====
    A.eq((await fixture.json('POST', '/api/memory/config', { auxTokenCeiling: 1 })).status, 200, 'the background token ceiling is set below what the plan has used');
    const from = t.rows().length, auxBefore = t.count('codex', 'aux');
    const at = fixture.output().length;
    const ceilingRun = await t.run('gov-cx', 'codex');
    A.eq(ceilingRun.end.reason, 'done', 'plan, token ceiling: the Commander\'s run still runs');
    A.eq([t.passRows('codex', from).length, t.count('codex', 'aux') - auxBefore], [0, 0], 'plan, token ceiling: its run-end passes do not');
    A.ok(/\[aux-governor\][^\n]*token ceiling reached/.test(fixture.output().slice(at)), 'plan, token ceiling: the run-end says the ceiling stopped them');
    const ceilingDraft = await t.lineDraft();
    A.eq([ceilingDraft.status, t.count('codex', 'linedraft')], [200, 2], 'plan, token ceiling: the one-shot is a press, so the ceiling does not stop it: ' + ceilingDraft.text.slice(0, 200));
    const ceilingQuest = await t.refreshQuests();
    A.eq([ceilingQuest && ceilingQuest.outcome, t.count('codex', 'quest')], ['none', 2], 'plan, token ceiling: REFRESH QUESTS is the Commander\'s, so it runs past it');

    // ===== every booked row names its payer: what its call was =====
    const rows = t.rows().filter(r => r.ts && r.runId !== 'seed');
    const byKind = (aux, provider) => rows.filter(r => (aux ? r.aux === aux : !r.aux) && (!provider || r.provider === provider || (!r.provider && provider === 'run')));
    const keyRun = rows.find(r => r.runId === keyed.runId), planRun = rows.find(r => r.runId === plan.runId);
    A.eq([keyRun && keyRun.billingClass, planRun && planRun.billingClass], ['metered', 'subscription'], 'the run rows: metered on the key, subscription on the plan');
    const oneShots = rows.filter(r => r.aux === 'oneshot-linedraft');
    A.eq(oneShots.map(r => [r.billingClass, r.unmetered]), [['metered', false], ['subscription', true], ['subscription', true]], 'the one-shot rows name their payer: the key\'s, then the plan\'s');
    const quests = byKind('quest-refresh', 'codex');
    A.ok(quests.length === 2 && quests.every(r => r.billingClass === 'subscription' && r.unmetered === true), 'the plan\'s quest refresh rows are subscription rows: ' + JSON.stringify(quests.map(r => r.billingClass)));
    const passes = rows.filter(r => PASS_KINDS.includes(r.aux));
    A.ok(passes.length >= 1 && passes.every(r => r.provider === 'codex' && r.billingClass === 'subscription' && r.unmetered === true), 'every run-end pass row is the plan\'s, a subscription row: ' + JSON.stringify(passes.map(r => [r.aux, r.provider, r.billingClass])));
  } finally { await fixture.dispose(); }
}

// ===== A CHECK THAT THROWS refuses, with its exit named: the station's side-effect-free spend check fails =====
async function throwArm(fake, shim) {
  const fixture = SidecarFixture.create({ prefix: 'gov-every-call-throw-', timeoutMs: 30000, entry: bootEntry(fs.mkdtempSync(path.join(shim, 'throw-')), true), env: Object.assign({}, ENV, { STARNET_BUDGET_PER_DAY: '' }) });
  const t = rig(fixture, fake);
  const start = fake.calls.length;
  try {
    seed(fixture.workspace);
    await fixture.start();
    await t.push('openrouter', 'or-fixture-key');
    await t.roster('openrouter');
    const draft = await t.lineDraft();
    A.eq(draft.status, 409, 'a throwing check: the one-shot is refused (it used to read as "not blocked" and spend): ' + draft.text.slice(0, 240));
    A.ok(/spending check failed/.test(draft.body && draft.body.error) && /restart StarNet/.test(draft.body.error) && /SPENDING LIMITS/.test(draft.body.error), 'and its refusal names the exit: ' + (draft.body && draft.body.error));
    const at = fixture.output().length;
    const ran = await t.run('gov-or', 'openrouter');
    A.eq(ran.end.reason, 'done', 'fixture: the run itself checks with its run id, so it runs');
    A.eq(fake.calls.slice(start).filter(c => c.kind === 'aux').length, 0, 'a throwing check: no run-end pass reaches the transport (they used to be noted and let through)');
    A.ok(/\[aux-governor\][^\n]*spending check failed[^\n]*restart StarNet/.test(fixture.output().slice(at)), 'and the run-end says so with the exit');
    const quest = await t.refreshQuests();
    A.ok(!!quest && quest.outcome === 'skipped' && /spend history is unavailable/.test(quest.reason || ''), 'a throwing check: REFRESH QUESTS keeps its refusal and its words: ' + JSON.stringify(quest));
    A.eq(fake.calls.slice(start).filter(c => c.kind === 'linedraft' || c.kind === 'quest').length, 0, 'a throwing check: neither the one-shot nor the quest refresh reached the transport');
  } finally { await fixture.dispose(); }
}

(async () => {
  const fake = await startFake();
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-every-call-shim-'));
  try {
    await capArm(fake, shim);
    await throwArm(fake, shim);
  } finally {
    await new Promise(r => fake.server.close(r));
    try { fs.rmSync(shim, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('governor.every-call.test');
})().catch(e => { console.log('FAIL: governor.every-call.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
