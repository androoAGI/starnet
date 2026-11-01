/* node test/channels.routine-add-origin.test.js — "/routine add" typed in a chat reports back to that chat (bug 3b958e41).
   The agent's routine.create tool takes its delivery from the run's deliveryOrigin ('origin' + { channel, chatId,
   threadId }); the slash door passed no origin at all, so the same request typed as a command made a station-only
   routine whose results never reached the phone that asked for it — and the reply did not say where they would go.
   Covers the three seams that carry it: the hub hands the chat's origin to the registry, runSlashForChannel forwards
   it (source pin — index.js is never required), and routineAction creates with it and says so. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeSlashActions } = require('../sidecar/slash-actions.js');

function cronDeps(created) {
  return {
    now: () => 1000,
    cron: {
      jobs: () => [], armed: () => true, halted: () => false,
      preview: () => ({ ok: true, display: 'every day at 9:00', localNext: ['Fri, Oct 23, 9:00 AM EDT'] }),
      create: async (spec) => {
        created.push(spec);
        // the store keeps what it was given (cron-store makeJob: deliver defaults to 'local')
        return { ok: true, job: { id: 'j' + created.length, name: spec.name, scheduleDisplay: 'every day at 9:00', nextRunAt: '2026-10-24T13:00:00.000Z', deliver: spec.deliver || 'local', origin: spec.origin || null } };
      }
    },
    workshop: {}
  };
}

(async () => {
  // ---- 1. routineAction: an origin makes an origin-delivering routine, and the reply says where results go ----
  {
    const created = [];
    const S = makeSlashActions(cronDeps(created));
    const r = await S.run('routine', 'add every day at 9am | long routine report', { agentId: 'ultron', deliveryOrigin: { channel: 'telegram', chatId: '4242', threadId: null } });
    A.ok(r.ok !== false, 'created: ' + JSON.stringify(r));
    A.eq(created[0].deliver, 'origin', 'the routine delivers to its origin');
    A.eq(created[0].origin, { channel: 'telegram', chatId: '4242', threadId: null }, 'the origin is the chat that asked');
    A.eq(created[0].agentId, 'ultron', 'still the agent this chat talks to');
    A.ok(/Results will come back to this chat\./.test(r.text), 'the reply says where results go: ' + r.text);

    // the desktop palette (no origin) is byte-identical to before: no deliver/origin keys, no new sentence
    const S2 = makeSlashActions(cronDeps(created));
    const d = await S2.run('routine', 'add every 30m | check the build', { agentId: 'ultron' });
    A.eq(Object.keys(created[1]).sort(), ['agentId', 'name', 'prompt', 'schedule'], 'a desktop /routine add carries no delivery fields');
    A.ok(!/come back to this chat/.test(d.text), 'and never claims a chat delivery');
  }

  // ---- 2. the hub hands the chat's origin to the registry on /routine (and its thread, in a forum topic) ----
  {
    const slashCalls = [];
    const hub = makeChannelHub({
      channel: 'telegram', store: { loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null, saveChatRecord: () => {} },
      runOnce: async () => { throw new Error('a command must never run the model'); },
      send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false,
      runSlash: async (input, ctx) => { slashCalls.push({ input, ctx }); return { ok: true, text: 'Routine created.' }; },
      isOwner: () => true
    });
    await hub.onInbound({ channel: 'telegram', chatId: '4242', chatType: 'dm', userId: 'boss', text: '/routine add every day at 9am | long routine report', messageId: '7', ts: 1 });
    await hub.onInbound({ channel: 'telegram', chatId: '-100', chatType: 'group', userId: 'boss', threadId: '55', text: '/routine list', messageId: '8', ts: 1 });
    A.eq(slashCalls.length, 2, 'both reached the registry');
    A.eq(slashCalls[0].ctx.deliveryOrigin, { channel: 'telegram', chatId: '4242', threadId: null }, 'a DM\'s origin rides the slash call');
    A.eq(slashCalls[1].ctx.deliveryOrigin, { channel: 'telegram', chatId: '-100', threadId: '55' }, 'a forum topic\'s thread rides it too');
  }

  // ---- 3. runSlashForChannel forwards it into the server action's ctx (and only a well-formed one) ----
  {
    const idx = readSidecarSource();
    const at = idx.indexOf('async function runSlashForChannel(');
    const body = idx.slice(at, idx.indexOf('\nasync function handleSlashDispatch', at));
    A.ok(at > 0 && body.length > 100, 'found runSlashForChannel');
    A.ok(/ctx\.deliveryOrigin\.channel && ctx\.deliveryOrigin\.chatId/.test(body), 'only an origin naming a channel AND a chat is forwarded');
    A.ok(/slashActions\.run\([^;]*deliveryOrigin: dOrigin/.test(body), 'the server action receives deliveryOrigin');
  }

  A.report('channels.routine-add-origin');
})().catch(e => { console.error(e); process.exit(1); });
