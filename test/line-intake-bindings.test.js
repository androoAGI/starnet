'use strict';
// Read-only receipts name the INBOX behind the existing decision; they never select another agent or grant a line.
const A = require('./_assert.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const Jobs = require('../sidecar/routing/linejobs.js');
const receipt = (router, facts) => typeof router.intakeReceiptFor === 'function' ? router.intakeReceiptFor(facts) : null;
function plan(inbox = 'in', lineId = 'line-stable') {
  return Pipeline.compileRoutingPlan({ props: [
    { id: inbox, lineId, t: 'intake', x: 0, y: 0, w: 1, h: 1 },
    { id: 'writer', t: 'bay', agentId: 'agent', x: 3, y: 0, w: 1, h: 1 },
    { id: 'out', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
  ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) });
}
const router = makeRouter();
A.eq(receipt(router, { agentId: 'agent', lineId: null }), null, 'unknown floor cannot prove a direct binding');
A.ok(router.setPlan(plan()).ok, 'real compiled line is accepted');
const facts = { agentId: 'agent', dockId: 'writer', lineId: router.lineOriginFor('agent', 'writer') };
const expected = { mode: 'line', agentId: 'agent', dockId: 'writer', lineId: 'line-stable', intakeId: 'in' };
A.eq(receipt(router, facts), expected, 'resolved entry names its existing line and authoritative INBOX');
A.eq(receipt(router, { ...facts, lineId: null }), { mode: 'direct', agentId: 'agent', dockId: 'writer' }, 'an explicitly direct routine stays direct on a crewed line');
A.eq(receipt(router, { ...facts, lineId: 'other' }), null, 'an absent line is unknown, never borrowed from another line');
A.eq(receipt(router, { ...facts, dockId: 'out' }), null, 'an invalid agent/dock pair never earns a receipt');
A.eq(receipt(router, { lineId: 'line-stable', intakeId: 'elsewhere' }), null, 'SEND TO cannot name an INBOX outside its actual line');
A.eq(receipt(router, { lineId: 'line-stable', intakeId: 'in' }), { mode: 'line', lineId: 'line-stable', intakeId: 'in' }, 'actual SEND TO entry preserves its exact INBOX');
const before = JSON.stringify(router.getPlan());
for (let i = 0; i < 5; i++) receipt(router, facts);
A.eq(JSON.stringify(router.getPlan()), before, 'receipt reads do not mutate the compiled plan');
let state = { jobs: [] };
const runner = makeLineRunner({ runOnce: async () => {}, newId: () => 'abcdefgh', now: () => 1,
  intakeReceiptFor: facts => receipt(router, facts), jobs: {
    start: opts => { const result = Jobs.start(state, opts); state = result.state; return result.job; },
    get: id => Jobs.get(state, id)
  } });
const job = runner.open({ line: 'line-stable', entry: 'channel', text: 'one job', streamId: 'shared', intakeId: 'forged' });
A.eq(job.record.intakeId, 'in', 'job admission stamps the host line owner, ignoring caller-supplied intake guesses');
router.setPlan(plan('replacement', 'line-stable'));
A.eq(job.record.intakeId, 'in', 'an existing job retains the INBOX recorded at its admission');
A.eq((receipt(router, facts) || {}).intakeId, 'replacement', 'a later binding observes the changed floor');
A.eq(Jobs.normalizeAll(JSON.parse(JSON.stringify(state))).jobs[0].intakeId, 'in', 'job INBOX identity survives persistence normalization');
router.clearPlan();
A.eq(receipt(router, facts), null, 'unarmed floor produces no receipt');

const Cron = require('../sidecar/cron-store.js');
router.setPlan(plan());
const routines = [false, true].map((runsLine, i) => ({ id: 'routine' + i, agentId: 'agent', dockId: 'writer', runsLine,
  model: 'same-model', provider: 'same-provider', intakeBinding: { mode: 'line', intakeId: 'forged' } }));
const routineSnapshot = JSON.stringify(routines);
const routineReceipt = job => receipt(router, { agentId: job.agentId, dockId: job.dockId,
  lineId: job.runsLine === true ? router.lineOfAgent(job.agentId, job.dockId) : null });
const envelope = Cron.toEnvelope(routines, routineReceipt);
A.eq(envelope.jobs[0].intakeBinding, { mode: 'direct', agentId: 'agent', dockId: 'writer' }, 'existing direct schedule stays direct');
A.eq(envelope.jobs[1].intakeBinding, expected, 'only an opted-in schedule names the line INBOX');
A.eq(JSON.stringify(routines), routineSnapshot, 'routine receipt projection never mutates its input');
A.eq(envelope.jobs.map(j => [j.runsLine, j.model, j.provider]), routines.map(j => [j.runsLine, j.model, j.provider]), 'receipt does not alter opt-in or provider/model pairs');
A.eq(Cron.loadEnvelope(JSON.stringify(envelope)).jobs[1].intakeBinding, expected, 'schedule receipt survives reload');
router.clearPlan();
A.ok(Cron.toEnvelope(envelope.jobs, routineReceipt).jobs.every(j => !j.intakeBinding), 'unknown floor retires stale schedule evidence without claiming direct');
router.setPlan(plan());
const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
const T = require('../sidecar/routing/triggers.js');
let savedTriggers = { triggers: [] }, failSave = false;
const triggerDeps = { now: () => 10, newId: () => 'abcdefgh1234', load: () => savedTriggers,
  save: value => { if (failSave) throw Error('fixture disk full'); savedTriggers = JSON.parse(JSON.stringify(value)); },
  intakeReceiptFor: f => receipt(router, f), plan: () => router.getPlan(), warn() {} };
const trigger = makeTriggerRunner(triggerDeps);
const fields = T.validateInput({ kind: 'webhook', lineId: 'line-stable', intakeId: 'forged' }).fields;
A.ok(!Object.hasOwn(fields, 'intakeId'), 'external trigger input cannot choose a new intake authority');
const created = trigger.create(fields, { secretHash: 'a'.repeat(64) });
A.eq(created.trigger.intakeId, 'in', 'webhook binding records its host-owned INBOX');
A.eq(makeTriggerRunner(triggerDeps).view(created.trigger.id).intakeId, 'in', 'webhook INBOX survives reload');
router.setPlan(plan('replacement'));
failSave = true;
A.eq(trigger.update(created.trigger.id, { name: 'changed' }).ok, false, 'failed receipt write is refused');
A.eq(trigger.view(created.trigger.id).intakeId, 'in', 'failed write never publishes new INBOX evidence');
failSave = false;
A.ok(trigger.update(created.trigger.id, { name: 'changed' }).ok, 'explicit retry writes through the existing owner');
A.eq(trigger.view(created.trigger.id).intakeId, 'replacement', 'later save records the changed floor without changing line identity');

(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { makeChannelStore } = require('../sidecar/channels/store.js');
  const { makeChannelHub } = require('../sidecar/channels/hub.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-bindings-'));
  try {
    const store = () => makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 100 } });
    let resolvedAgent = 'agent', decisions = 0, sequence = 0;
    const runs = [], channelStore = store();
    const hub = makeChannelHub({ channel: 'dev', store: channelStore, send: async () => ({ ok: true }), newId: () => 'receipt-run-' + ++sequence,
      secrets: () => ({ key: 'fixture-key', provider: 'custom', model: 'same-model', agentId: 'agent' }), classify: () => false,
      resolveAgent: () => { decisions++; return resolvedAgent === 'agent' ? { agentId: 'agent', dockId: 'writer' } : resolvedAgent; },
      lineOriginFor: (agentId, dockId) => router.lineOriginFor(agentId, dockId), intakeReceiptFor: f => receipt(router, f),
      runOnce: async o => { runs.push([o.agentId, o.provider, o.model]); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'done' });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); }
    });
    const send = text => hub.onInbound({ chatId: 'receipt-chat', userId: 'fixture-user', text, chatType: 'dm', messageId: text });
    router.setPlan(plan());
    await send('first');
    A.eq(store().getChatRecord('receipt-chat').intakeBinding, expected, 'actual channel store reload retains resolved binding receipt');
    router.setPlan(plan('replacement'));
    await send('second');
    A.eq((store().getChatRecord('receipt-chat').intakeBinding || {}).intakeId, 'replacement', 'next real message refreshes binding from current floor');
    resolvedAgent = 'other';
    await send('hard-lock-changed');
    const changed = store().getChatRecord('receipt-chat');
    A.eq(runs[2][0], 'other', 'hard-locked agent still wins over the old chat binding');
    A.eq(changed.agentId, 'agent', 'receipt cannot overwrite a different explicit chat binding');
    A.eq(changed.intakeBinding, null, 'different resolved agent retires the old receipt');
    resolvedAgent = 'agent'; router.clearPlan();
    await send('unarmed');
    A.eq(store().getChatRecord('receipt-chat').intakeBinding, null, 'unarmed plan never migrates a channel to direct intent');
    A.eq(decisions, 4, 'exactly one routing resolution per message, none from receipt projection');
    A.ok(runs.every(r => r[1] === 'custom' && r[2] === 'same-model'), 'receipt never changes provider/model pairs');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.report('line-intake-bindings');
})().catch(error => { A.ok(false, error.stack); A.report('line-intake-bindings'); });
