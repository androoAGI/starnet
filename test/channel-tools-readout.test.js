/* node test/channel-tools-readout.test.js — a channel's /tools lists the room that chat's own run resolves against, and
   decides Full Power with the run's own sender verdict (authority-census lane, review minor; 2026-10-30).

   THE GAP. runSlashForChannel reads its room from ProjectTools.projectStation, the function runOnce asks, so /tools counts
   the FULL POWER objects and the execution profile the run receives (748b0462595 counted neither). Two things were loose:
   - The only lock was a source regex (authority-census.test.js), so dropping FULL POWER or the profile from the readout's
     projectStation call kept every test green.
   - The readout decided Full Power as !ctx.ownerTrusted. The run decides it with run-origin.js hostPowerWithheldFor over
     the hub's host-minted sender flags (channelSender / channelSenderOwner). The two differ wherever a hub names its owner
     without minting ownerTrusted: a paired owner's DM on Discord, Slack, Matrix or Signal (registry.js gives isOwner
     only), and the DEV_MODE local route (ownerSurface, whose runs are not sender-tagged). On a Full Access agent those
     runs got the workbench and the plugin family, and /tools did not list them.

   WHAT IS LOCKED
   1. EXECUTED, NOT GREPPED. runSlashForChannel is cut out of sidecar/index.js and run in a vm over the census host facts
      (test/helpers/authority-census.js readoutPlaced). For each channel origin below, the object types it hands the /tools
      action equal the room THIS tree's runOnceCore (the census cut) resolves for the same origin. Run against
      748b0462595's runSlashForChannel, 7 of the 12 rows fail: the six where Full Power reaches the run (the Telegram owner
      DM under FULL / bypass / approvals, the bay, the registry owner DM, the dev route) and the guest's execution profile.
      That readout composed the office itself and counted neither. Run against this lane before the fix, the
      registry-owner and dev-route FULL POWER rows fail.
   2. THE HUB HANDS THE VERDICT. A real makeChannelHub passes runSlash the same channelSender / channelSenderOwner pair it
      stamps on that chat's runs, on all three slash paths (/tools, a Commander's command, a desktop command).
   3. THE INSTRUMENT BITES. Dropping FULL POWER and the profile from the readout's projectStation call, or reading Full
      Power as !ownerTrusted again, is a non-empty diff.
   Readout only: no run, grant or authority matrix cell changes (test/authority-census.test.js still holds the snapshot).
   A caller with no verdict (runSlashRoutine, a routine's slash line) keeps the old withheld-unless-ownerTrusted reading. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const C = require('./helpers/authority-census.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { hostPowerWithheldFor } = require('../sidecar/run-origin.js');

const ROOT = path.resolve(__dirname, '..');
const O = id => {
  const o = C.ORIGINS.find(x => x.id === id);
  if (!o) throw new Error('no census origin ' + id);
  return o;
};
// the two hub kinds with no ownerTrusted, each copying the run flags its hub stamps (hub.js runChannelSender / Owner)
const REGISTRY_OWNER = { id: 'channel.registry.owner', at: 'channels/registry.js wireChannel hub (isOwner only), paired owner DM',
  o: { surface: 'autonomous', floorless: true, ownerTrusted: false, channelSender: true, channelSenderOwner: true, trigger: 'event', isTask: true }, brief: true };
const DEV_ROUTE = { id: 'channel.dev', at: 'index.js /api/dev/inbound hub (ownerSurface)',
  o: { surface: 'autonomous', floorless: true, ownerTrusted: false, channelSender: false, channelSenderOwner: true, trigger: 'event', isTask: true }, brief: true };
const TG_OWNER = { ownerTrusted: true, channelSender: true, channelSenderOwner: true };
const GUEST = { ownerTrusted: false, channelSender: true, channelSenderOwner: false };

// [label, origin, posture, host facts, the slash ctx that origin's hub hands runSlash]
const ROWS = [
  ['Telegram owner DM, ASK', O('channel.owner'), 'ask', {}, TG_OWNER],
  ['Telegram owner DM, FULL POWER', O('channel.owner'), 'full', {}, TG_OWNER],
  ['Telegram owner DM, station master bypass', O('channel.owner'), 'ask', { bypass: true }, TG_OWNER],
  ['Telegram owner DM, trusted execution profile', O('channel.owner'), 'ask', { profile: 'trusted-project' }, TG_OWNER],
  ['Telegram owner DM with /approvals on, FULL POWER', O('channel.owner.approvals'), 'full', {}, TG_OWNER],
  ['owner DM on a bay agent, FULL POWER', O('channel.bay'), 'full', {}, TG_OWNER],
  ['channel guest, FULL POWER (withheld)', O('channel.guest'), 'full', {}, GUEST],
  ['channel guest, station master bypass (withheld)', O('channel.guest'), 'ask', { bypass: true }, GUEST],
  ['channel guest, trusted execution profile', O('channel.guest'), 'ask', { profile: 'trusted-project' }, GUEST],
  ['paired owner DM on Discord / Slack / Matrix / Signal, ASK', REGISTRY_OWNER, 'ask', {}, { ownerTrusted: false, channelSender: true, channelSenderOwner: true }],
  ['paired owner DM on Discord / Slack / Matrix / Signal, FULL POWER', REGISTRY_OWNER, 'full', {}, { ownerTrusted: false, channelSender: true, channelSenderOwner: true }],
  ['DEV_MODE local route (ownerSurface), FULL POWER', DEV_ROUTE, 'full', {}, { ownerTrusted: false, channelSender: false, channelSenderOwner: true }]
];
const scenarioOf = (label, origin, posture, facts) => ({ id: label, origin, posture, facts: Object.assign({}, origin.facts || {}, facts) });

function fakeStore() {
  return { loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null, saveChatRecord: () => {}, clearHistory: () => 0 };
}
function hubOf(over) {
  const runs = [], slash = [];
  let ids = 0;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram', store: fakeStore(),
    runOnce: async (o) => { runs.push(o); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: () => Promise.resolve({ ok: true }),
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++ids),
    runSlash: async (input, ctx) => { slash.push({ input, ctx }); return { ok: true, text: 'ran ' + input }; },
    userCommandNames: () => ['standup'], desktopCommand: (t) => t === 'version',
    isOwner: (m) => String(m.userId) === 'boss',
    ownerTrusted: (m) => String(m.userId) === 'boss' && m.chatType === 'dm'
  }, over || {}));
  return { hub, runs, slash };
}
let seq = 0;
const msg = (userId, text, chatType) => ({ channel: 'telegram', chatId: chatType === 'group' ? '-100' : 'c-' + userId, chatType: chatType || 'dm', userId, text, messageId: 'm' + (++seq), ts: 1 });
const verdict = (x) => ({ channelSender: x && x.channelSender, channelSenderOwner: x && x.channelSenderOwner });

(async () => {
  // ---- 1. the readout, executed, equals the run's room for every channel origin ----
  const runRoom = {};
  for (const [label, origin, posture, facts, sctx] of ROWS) {
    const s = scenarioOf(label, origin, posture, facts);
    const cap = await C.runOnceMatrix(ROOT, s);
    A.eq(cap.failNotes, [], label + ': the run assembly ran without a fail-open note');
    runRoom[label] = C.roomTypesOf(cap.out.station);
    const r = await C.readoutPlaced(ROOT, s, sctx);
    A.eq(r.failNotes, [], label + ': the readout ran without a fail-open note');
    A.eq(r.placed, runRoom[label], label + ': /tools lists the room this chat\'s run resolves against');
  }
  // the rows that carry the point, named so a reader sees what the equality protects
  A.ok(runRoom['Telegram owner DM, FULL POWER'].indexOf('plugin') >= 0 && runRoom['Telegram owner DM, ASK'].indexOf('plugin') < 0,
    'FULL POWER adds the families the owner DM\'s ASK office lacks (the plugin family here), and /tools counts them');
  A.ok(runRoom['paired owner DM on Discord / Slack / Matrix / Signal, FULL POWER'].indexOf('workbench') >= 0
    && runRoom['paired owner DM on Discord / Slack / Matrix / Signal, ASK'].indexOf('workbench') < 0,
    'a registry channel\'s paired owner DM gets the workbench only through FULL POWER (it is not ownerTrusted), and /tools lists it');
  A.ok(runRoom['DEV_MODE local route (ownerSurface), FULL POWER'].indexOf('workbench') >= 0, 'the dev route keeps FULL POWER (its runs are not sender-tagged), and /tools lists it');
  A.eq(runRoom['channel guest, FULL POWER (withheld)'], runRoom['Telegram owner DM, ASK'].filter(t => t !== 'orchestrator' && t !== 'workbench'),
    'a guest on a Full Access agent gets the plain headless office, and so does its /tools');
  A.ok(runRoom['channel guest, trusted execution profile'].indexOf('workbench') >= 0, 'an execution profile\'s objects reach a guest\'s run, and its /tools');

  // a caller with no sender verdict (runSlashRoutine) keeps the withheld-unless-ownerTrusted reading
  {
    const s = scenarioOf('no verdict', O('channel.guest'), 'full', {});
    A.eq((await C.readoutPlaced(ROOT, s, {})).placed, runRoom['channel guest, FULL POWER (withheld)'], 'a slash line with no sender verdict reads Full Power as withheld');
    A.eq((await C.readoutPlaced(ROOT, s, { ownerTrusted: true })).placed.indexOf('plugin') >= 0, true, '...unless it is ownerTrusted');
  }

  // ---- 3. the instrument bites ----
  {
    const label = 'Telegram owner DM, FULL POWER';
    const [, origin, posture, facts, sctx] = ROWS.find(r => r[0] === label);
    const s = scenarioOf(label, origin, posture, facts);
    const call = '{ connectorIds: connectors.ids(), unrestrictedHost, executionProfile }';
    let anchored = false;
    const dropped = await C.readoutPlaced(ROOT, s, sctx, { mutate: fn => { anchored = fn.indexOf(call) >= 0; return fn.replace(call, '{ connectorIds: connectors.ids() }'); } });
    A.ok(anchored, 'MUTATION 1 anchor: the readout hands projectStation FULL POWER and the execution profile');
    A.ok(JSON.stringify(dropped.placed) !== JSON.stringify(runRoom[label]), 'MUTATION 1 (the readout drops FULL POWER and the profile) is a non-empty diff: ' + dropped.placed.join(','));
    const label2 = 'paired owner DM on Discord / Slack / Matrix / Signal, FULL POWER';
    const row2 = ROWS.find(r => r[0] === label2);
    const s2 = scenarioOf(label2, row2[1], row2[2], row2[3]);
    let anchored2 = false;
    const ownerOnly = await C.readoutPlaced(ROOT, s2, row2[4], { mutate: fn => {
      const m = /const hostPowerWithheld = typeof ctx\.channelSender === 'boolean'[\s\S]*?: !ctx\.ownerTrusted;/.exec(fn);
      anchored2 = !!m;
      return m ? fn.replace(m[0], 'const hostPowerWithheld = !ctx.ownerTrusted;') : fn;
    } });
    A.ok(anchored2, 'MUTATION 2 anchor: the readout reads the hub\'s sender verdict through hostPowerWithheldFor');
    A.ok(JSON.stringify(ownerOnly.placed) !== JSON.stringify(runRoom[label2]), 'MUTATION 2 (Full Power read as !ownerTrusted, the pre-fix predicate) is a non-empty diff on the registry owner DM: ' + ownerOnly.placed.join(','));
  }

  // ---- 2. the hub hands runSlash the sender verdict it stamps on that chat's runs, on every slash path ----
  {
    const cases = [
      ['Telegram-style hub (ownerTrusted + isOwner), owner DM', {}, 'boss', 'dm', ['/tools', '/standup', '/version']],
      ['Telegram-style hub, owner in a group', {}, 'boss', 'group', ['/tools', '/standup', '/version']],
      ['Telegram-style hub, non-owner DM', {}, 'friend', 'dm', ['/tools']],
      ['registry hub (isOwner only), paired owner DM', { ownerTrusted: undefined }, 'boss', 'dm', ['/tools', '/standup', '/version']],
      ['registry hub, non-owner in a group', { ownerTrusted: undefined }, 'stranger', 'group', ['/tools']],
      ['ownerSurface hub (DEV_MODE local route)', { ownerSurface: true, isOwner: undefined, ownerTrusted: undefined }, 'dev', 'dm', ['/tools', '/standup', '/version']]
    ];
    for (const [label, over, user, chatType, lines] of cases) {
      const t = hubOf(over);
      for (const line of lines) await t.hub.onInbound(msg(user, line, chatType));
      await t.hub.onInbound(msg(user, 'do the thing', chatType));
      A.eq(t.slash.map(x => x.input), lines, label + ': each slash path reached the registry (no model run)');
      A.eq(t.runs.length, 1, label + ': the plain message ran once');
      const run = t.runs[0];
      A.eq(typeof run.channelSender, 'boolean', label + ': the run carries a host-minted sender verdict');
      for (const x of t.slash) {
        A.eq(verdict(x.ctx), verdict(run), label + ' ' + x.input + ': runSlash gets the same channelSender / channelSenderOwner the run carries');
        A.eq(hostPowerWithheldFor(verdict(x.ctx)), hostPowerWithheldFor(run), label + ' ' + x.input + ': so its Full Power reading is the run\'s');
      }
    }
  }

  A.report('channel-tools-readout.test');
})().catch(e => { console.error('FAIL: channel-tools-readout.test threw — ' + (e && e.stack || e)); process.exit(1); });
