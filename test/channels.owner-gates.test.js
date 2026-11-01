/* node test/channels.owner-gates.test.js — channel senders may TALK to the agent; only the paired owner may
   CHANGE the station, and only the owner's DM inherits Full Power (2026-09-25, sec-owner-gates).

   The 09-23 audit paired every channel's owner, but anyone ADMITTED to a chat (a whitelisted group's members,
   an allowed non-owner) could still /model, /talk, /routine add, /away on, /new… and their runs inherited the
   agent's Full Access. And the signed relay route took a body's userId on faith, skipping the adapter's owner
   gate entirely. This drives the REAL hub, registry and relay admission with fake transports/runs (no network):
     1. the command policy table — every command classified, asserted one by one (a new command fails here
        until someone decides who may run it)
     2. a non-owner is refused every owner-only command (no write, no slash call, no run); the owner still works
     3. read-only commands stay open to every admitted sender
     4. run origin: only the owner's DM run is tagged channelSenderOwner; hostPowerWithheldFor withholds Full
        Power from every other channel sender, and the verdict rides into delegated workers
     5. wireChannel names the owner from the adapter's paired id (Discord/Slack/Matrix/Signal)
     6. relay ingress binds the claimed sender to the live adapter's own admission and strips host verdicts */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelHub, COMMANDS, commandNeedsOwner, parseCommand } = require('../sidecar/channels/hub.js');
const { wireChannel } = require('../sidecar/channels/registry.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { hostPowerWithheldFor } = require('../sidecar/run-origin.js');
const { admitRelayMessage } = require('../sidecar/channels/relay-admission.js');

// THE DOCUMENTED POLICY. 'always' = owner-only in every form; 'write' = bare readout open, any argument is
// owner-only; 'open' = read-only, any admitted sender.
const POLICY = {
  status: 'open', agents: 'open', whoami: 'open', tools: 'open', help: 'open', start: 'open',
  model: 'write', approvals: 'write', mention: 'write',
  stop: 'always', new: 'always', talk: 'always', usage: 'always', routine: 'always', away: 'always',
  allow: 'always', deny: 'always'   // only the paired owner opens or closes a group (2026-10-19)
};

function fakeStore() {
  const hist = new Map(), recs = new Map(), cleared = [];
  return {
    recs, cleared,
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    clearHistory(a) { cleared.push(a); const n = (hist.get(a) || []).length; hist.delete(a); return n; },
    getChatRecord(c) { return recs.get(String(c)); },
    saveChatRecord(c, patch) { const merged = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), merged); return merged; }
  };
}
const roster = [
  { agentId: 'ultron', name: 'Ultron', model: 'model-a', provider: 'openrouter' },
  { agentId: 'codex', name: 'Codex', model: 'model-b', provider: 'openrouter' }
];

function build(over) {
  const sends = [], runs = [], slash = [], models = [];
  const store = fakeStore();
  let ids = 0;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram',
    runOnce: async (o) => {
      runs.push(o);
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' });
    },
    store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++ids),
    roster: () => roster.slice(),
    setModel: (agentId, model) => { models.push({ agentId, model }); return { ok: true, agentId, model }; },
    runSlash: async (input, ctx) => { slash.push({ input, ctx }); return { ok: true, text: 'ran ' + input }; },
    userCommandNames: () => ['standup'],
    // the paired owner is user 'boss'; ownerTrusted mirrors the Telegram wiring (owner AND a DM)
    isOwner: (m) => String(m.userId) === 'boss',
    ownerTrusted: (m) => String(m.userId) === 'boss' && m.chatType === 'dm'
  }, over || {}));
  return { hub, sends, runs, slash, models, store };
}
const msg = (userId, text, chatType, chatId) => ({ channel: 'telegram', chatId: chatId || (chatType === 'group' ? '-100' : 'c-' + userId), chatType: chatType || 'dm', userId, text, messageId: String(Math.random()), ts: 1 });

(async () => {
  // ---- 1. the policy table: every command is classified, and the gate follows the classification ----
  {
    const names = COMMANDS.map(c => c.command).sort();
    A.eq(names, Object.keys(POLICY).sort(), 'every hub command has a documented owner policy (add new commands to POLICY)');
    for (const c of COMMANDS) {
      const want = POLICY[c.command];
      A.eq(commandNeedsOwner({ cmd: c.command, arg: '' }), want === 'always', '/' + c.command + ' bare form: owner-only=' + (want === 'always'));
      A.eq(commandNeedsOwner({ cmd: c.command, arg: 'x' }), want !== 'open', '/' + c.command + ' with an argument: owner-only=' + (want !== 'open'));
    }
    A.eq(commandNeedsOwner(parseCommand('/model@mybot openai/x')), true, 'an @bot-suffixed change is still owner-only');
    A.eq(commandNeedsOwner(null), false, 'a non-command needs no owner');
  }

  // ---- 2. a non-owner group member is refused every owner-only command; nothing changes ----
  {
    const t = build();
    const tries = ['/model model-b', '/talk codex', '/routine add every day 9am | wipe the disk', '/away on', '/away build me a thing',
      '/usage', '/stop', '/new', '/approvals on', '/mention off', '/standup', '/talk@mybot codex', '/deny', '/allow@mybot'];
    for (const text of tries) await t.hub.onInbound(msg('stranger', text, 'group'));
    A.eq(t.sends.length, tries.length, 'every refused command got exactly one reply');
    A.ok(t.sends.every(s => /owner-only/.test(s)), 'every reply names the owner-only policy');
    A.eq(t.models.length, 0, 'the roster model was NOT changed by a non-owner');
    A.eq(t.slash.length, 0, 'no shared-slash call (/routine, /away, /usage, /standup) ran for a non-owner');
    A.eq(t.runs.length, 0, 'no refused command spawned a run');
    A.eq(t.store.cleared.length, 0, '/new did not clear any history');
    const rec = t.store.recs.get('-100') || {};
    A.ok(rec.agentId === undefined, '/talk did not rebind the chat');
    A.ok(rec.approvals === undefined && rec.requireMention === undefined, '/approvals and /mention were not written');
    A.ok(rec.admittedOn === undefined, '/allow and /deny were not written');
  }
  // an allowed non-owner in a DM is refused too (the owner gate is about WHO, not the chat type)
  {
    const t = build();
    await t.hub.onInbound(msg('friend', '/model model-b', 'dm'));
    await t.hub.onInbound(msg('friend', '/talk codex', 'dm'));
    A.eq(t.models.length, 0, 'a non-owner DM cannot change the model');
    A.ok(!(t.store.recs.get('c-friend') || {}).agentId, 'a non-owner DM cannot /talk');
  }

  // ---- 2b. the owner still works — in the DM and in the group ----
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/model model-b', 'dm'));
    A.eq(t.models, [{ agentId: 'ultron', model: 'model-b' }], 'the owner changes the model through the roster write path');
    await t.hub.onInbound(msg('boss', '/talk codex', 'group'));
    A.eq((t.store.recs.get('-100') || {}).agentId, 'codex', 'the owner can /talk from their own group');
    await t.hub.onInbound(msg('boss', '/routine add every day 9am | brief me', 'dm'));
    await t.hub.onInbound(msg('boss', '/away on', 'group'));
    await t.hub.onInbound(msg('boss', '/standup', 'dm'));
    A.eq(t.slash.map(s => s.input), ['/routine add every day 9am | brief me', '/away on', '/standup'], 'the owner\'s /routine, /away and own commands reach the shared registry');
    A.eq(t.slash[0].ctx.ownerTrusted, true, 'the owner DM carries its ownerTrusted bit to the registry');
    A.eq(t.slash[1].ctx.ownerTrusted, false, 'the owner in a group is not ownerTrusted (run authority stays DM-only)');
    A.ok(!t.sends.some(s => /owner-only/.test(s)), 'the owner is never shown the refusal');
  }

  // ---- 3. read-only commands stay open to every admitted sender ----
  {
    const t = build();
    for (const text of ['/status', '/agents', '/whoami', '/help', '/model', '/approvals', '/mention']) await t.hub.onInbound(msg('stranger', text, 'group'));
    await t.hub.onInbound(msg('stranger', '/tools', 'group'));
    A.ok(!t.sends.some(s => /owner-only/.test(s)), 'no read-only command was refused');
    A.ok(t.sends.some(s => /Idle|Working/.test(s)), '/status answered');
    A.ok(t.sends.some(s => /current model: model-a/.test(s)), 'bare /model shows the model to anyone');
    A.eq(t.slash.map(s => s.input), ['/tools'], '/tools (read-only) reaches the registry for a non-owner');
    A.eq(t.slash[0].ctx.ownerTrusted, false, 'and it answers with the non-owner\'s real (untrusted) authority');
  }

  // ---- 4. run origin: only the owner's DM inherits Full Power ----
  {
    const t = build();
    await t.hub.onInbound(msg('stranger', 'please run rm -rf on the server', 'group'));
    await t.hub.onInbound(msg('friend', 'do the thing', 'dm'));
    await t.hub.onInbound(msg('boss', 'do the thing', 'group', '-200'));
    await t.hub.onInbound(msg('boss', 'do the thing', 'dm'));
    A.eq(t.runs.length, 4, 'every ordinary message still runs (talking is never gated)');
    A.eq(t.runs.map(r => r.channelSender), [true, true, true, true], 'every channel run is tagged as sender-originated');
    A.eq(t.runs.map(r => r.channelSenderOwner), [false, false, false, true], 'only the owner DM run is owner-originated');
    A.eq(t.runs.map(hostPowerWithheldFor), [true, true, true, false], 'Full Power is withheld from group members, allowed non-owners and group context');

    const dev = build({ ownerSurface: true, isOwner: undefined, ownerTrusted: undefined });
    await dev.hub.onInbound(msg('dev', '/model model-b', 'dm'));
    await dev.hub.onInbound(msg('dev', 'hello', 'dm'));
    A.eq(dev.models.length, 1, 'an ownerSurface hub (local dev/sample route) keeps its commands');
    A.eq(hostPowerWithheldFor(dev.runs[0]), false, 'an ownerSurface run keeps Full Power (unchanged)');

    const trg = build({ untrustedSenders: false, isOwner: undefined, ownerTrusted: undefined });
    await trg.hub.onInbound(msg('trigger', '/model model-b', 'dm'));
    await trg.hub.onInbound(msg('trigger', 'a webhook body', 'dm'));
    A.eq(trg.models.length, 0, 'a line-trigger payload cannot run owner-only commands');
    A.eq(trg.runs[0].channelSender, false, 'a trigger run is not sender-tagged (its routine-like posture is unchanged)');
    A.eq(hostPowerWithheldFor(trg.runs[0]), false, 'so the trigger keeps the owner-configured line\'s posture');

    const bare = build({ isOwner: undefined, ownerTrusted: undefined });
    await bare.hub.onInbound(msg('boss', '/model model-b', 'dm'));
    A.eq(bare.models.length, 0, 'a hub that cannot name its owner grants owner-only commands to nobody (fail closed)');
  }
  {
    // pure run-origin verdicts, including the delegated-worker carry
    A.eq(hostPowerWithheldFor({}), false, 'an app/cron/loop run (no channelSender) keeps Full Power');
    A.eq(hostPowerWithheldFor({ channelSender: true, channelSenderOwner: true }), false, 'the owner DM keeps Full Power');
    A.eq(hostPowerWithheldFor({ channelSender: true }), true, 'a sender run with no owner verdict fails closed');
    A.eq(hostPowerWithheldFor({ connectorAuthority: { withholdHostPower: true } }), true, 'a worker delegated from a non-owner run inherits the restriction');
    A.eq(hostPowerWithheldFor({ connectorAuthority: { withholdHostPower: false } }), false, 'a worker delegated from an owner run does not');
    A.eq(hostPowerWithheldFor({ channelSender: 'yes', channelSenderOwner: false }), false, 'only the host-minted boolean counts (no truthy strings)');
    A.eq(hostPowerWithheldFor(null), false, 'no options = not a channel run');
  }
  {
    // production seam guard: runOnceCore reads Full Power ONLY through the withheld-aware helpers
    const idx = readSidecarSource();
    A.ok(/const hostPowerWithheld = hostPowerWithheldFor\(o\);/.test(idx), 'runOnceCore computes the run-origin verdict');
    A.ok(/const agentFullAccessNow = \(\) => !hostPowerWithheld && /.test(idx), 'per-agent Full Access is withheld from non-owner channel runs');
    A.ok(/const stationBypassNow = \(\) => !hostPowerWithheld && \(FULL_ACCESS \|\| masterBypassOn\(\)\);/.test(idx), 'the station master bypass is withheld too');
    A.ok(/withholdHostPower: hostPowerWithheld,/.test(idx), 'the verdict rides the host-context connectorAuthority into delegated workers');
    A.ok(!/fullAccess: FULL_ACCESS \|\| masterBypassOn\(\) \|\| agentFullAccessNow\(\)/.test(idx), 'no taint-boundary site reads the raw bypass anymore');
    A.ok(/masterBypass: stationBypassNow\(\), fullAccess: agentFullAccessNow,/.test(idx), 'the run authority gets the withheld-aware bypass');
    // sweep 2026-10-02: a withheld run (phone, non-owner) can't launder Full Access through STANDING work that fires later
    A.ok(/if \(hostPowerWithheld && standingWorkEscalates\(c\.name, c\.args\)\) \{\s*return \{ ok: false, isError: true, summary: 'withheld',/.test(idx), 'the dispatch guard refuses standing work from a withheld run');
    const { standingWorkEscalates } = require('../sidecar/run-origin.js');
    A.eq([['routine.create', {}], ['routine_create', {}], ['routine.manage', { action: 'run_now' }], ['routine.manage', { action: 'update' }], ['routine.manage', { action: 'resume' }],
      ['loop.create', {}], ['loop.manage', { action: 'approve' }], ['station.start_line', { line: 'x', schedule: 'daily' }], ['station_start_line', {}], ['station.test_line', { line: 'x', job: 'y' }]]
      .map(([n, a]) => standingWorkEscalates(n, a)), [true, true, true, true, true, true, true, true, true, true], 'creating, editing, resuming, running now, approving, starting or testing standing work escalates');
    A.eq([['routine.manage', { action: 'pause' }], ['routine.manage', { action: 'remove' }], ['loop.manage', { action: 'stop' }], ['loop.manage', { action: 'reject' }],
      ['station.start_line', { line: 'x', off: 'trg_1' }], ['routine.list', {}], ['team.dispatch', {}], ['fs.write', {}]]
      .map(([n, a]) => standingWorkEscalates(n, a)), [false, false, false, false, false, false, false, false], 'pausing, stopping, removing and reading stay allowed (they only take power away)');
    const hub = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'channels', 'hub.js'), 'utf8');
    A.eq((hub.match(/channelSender: runChannelSender, channelSenderOwner: runChannelSenderOwner/g) || []).length, 2, 'both the entry run and every line hop carry the sender verdict');
    // …which is this hub's own sender rule, narrowed (never widened) by a SEND TO hand-off's withheld sender (conveyor-backend-04)
    A.ok(/const runChannelSender = lineWithheld \? true : tagSenderRuns;\s*\n\s*const runChannelSenderOwner = lineWithheld \? false : channelSenderOwner;/.test(hub),
      'the run sender verdict is the hub\'s own, or withheld when the hand-off\'s sending job was');
    A.ok(/channel: 'dev', [^\n]*\n    ownerSurface: true,/.test(idx) && /channel: 'sample', [^\n]*\n    ownerSurface: true,/.test(idx), 'the local dev and sample hubs are owner surfaces');
    A.ok(/channel: 'trigger', [^\n]*\n[^\n]*\n    untrustedSenders: false,/.test(idx), 'the trigger hub has no chat senders');
    A.eq((idx.match(/    isOwner: \(msg\) => !!\(adapterRef && adapterRef\._internals && msg\n/g) || []).length, 2, 'both Telegram hubs name their paired owner');
  }

  // ---- 5. wireChannel names the owner from the adapter's paired id ----
  {
    let hubOpts = null, owner = '';
    const desc = { id: 'fake', maxMessageLength: 100, makeAdapter: () => ({ _internals: { get owner() { return owner; } }, send: async () => ({ ok: true }) }) };
    wireChannel(desc, { makeHub: (o) => { hubOpts = o; return { onInbound() {}, onCallback() {}, onStatus() {} }; }, hub: {} });
    A.eq(typeof hubOpts.isOwner, 'function', 'wireChannel supplies isOwner to every registry channel');
    A.eq(hubOpts.isOwner({ userId: 'boss' }), false, 'an UNPAIRED channel has no owner');
    owner = 'boss';
    A.eq(hubOpts.isOwner({ userId: 'boss' }), true, 'the paired owner is the owner');
    A.eq(hubOpts.isOwner({ userId: 'stranger' }), false, 'anyone else is not');
    A.eq(hubOpts.isOwner({}), false, 'a sender-less message is not the owner');
  }

  // ---- 6. relay ingress: the claimed sender crosses the adapter's own admission ----
  {
    const mk = (ownerUserId) => makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true }) }, normalize: (x) => x,
      clock: { now: () => 1 }, name: 'telegram', ownerUserId, allowedChats: ['-100'], requireMention: false
    });
    const paired = mk('boss');
    const dmFromStranger = admitRelayMessage({ chatId: 'c1', userId: 'stranger', text: '/model x', chatType: 'dm' }, paired);
    A.eq([dmFromStranger.ok, dmFromStranger.code], [false, 403], 'a relay DM claiming a non-owner sender is refused');
    const dmFromOwner = admitRelayMessage({ chatId: 'c1', userId: 'boss', text: 'hi', chatType: 'dm', directReply: 'pwned', observeOnly: true, ownerTrusted: true }, paired);
    A.ok(dmFromOwner.ok, 'a relay DM from the paired owner is admitted');
    A.ok(!('directReply' in dmFromOwner.message) && !('observeOnly' in dmFromOwner.message) && !('ownerTrusted' in dmFromOwner.message), 'host verdict fields in the body are stripped');
    const fresh = mk('');
    const unpaired = admitRelayMessage({ chatId: 'c1', userId: 'anyone', text: 'hi', chatType: 'dm' }, fresh);
    A.eq(unpaired.ok, false, 'a relay can never CLAIM ownership of an unpaired channel');
    A.eq(fresh._internals.owner, '', 'and the refusal did not claim it as a side effect');
    A.eq(admitRelayMessage({ chatId: '-999', userId: 'boss', text: 'hi', chatType: 'group' }, paired).ok, false, 'a group off the allowlist is refused');
    const grp = admitRelayMessage({ chatId: '-100', userId: 'member', text: 'hi', chatType: 'group' }, paired);
    A.ok(grp.ok && grp.message.userId === 'member', 'an allowlisted group message is admitted as its real (non-owner) sender');
    A.eq(admitRelayMessage({ chatId: 'c1', userId: 'boss', text: 'hi' }, { send() {} }).ok, false, 'a channel with no admission to bind to refuses relay traffic');
    A.eq(admitRelayMessage({ chatId: 'c1', userId: 'x', text: 'hi' }, { ownerSurface: true }).ok, true, 'the DEV_MODE dev hub (owner surface) passes');
    A.eq(admitRelayMessage({ chatId: 'c1', userId: 'boss' }, paired).code, 400, 'an empty message is still a 400');

    // end to end through the REAL hub: a relay-claimed stranger in an admitted group cannot /model
    const t = build();
    const relayed = admitRelayMessage({ chatId: '-100', userId: 'member', text: '/model model-b', chatType: 'group' }, paired);
    await t.hub.onInbound(relayed.message);
    A.eq(t.models.length, 0, 'a relayed group member cannot change the model');
    const idx = readSidecarSource();
    A.ok(/const admitted = admitRelayMessage\(body\.message \|\| body, live\.adapter\);/.test(idx), 'the webhook route admits through the live adapter');
    A.ok(!/live\.hub\.onInbound\(Object\.assign\(\{\}, msg/.test(idx), 'the route no longer spreads the raw body into the hub');
  }

  A.report('channels.owner-gates.test');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
