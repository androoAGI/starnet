/* node test/channels.group-readd.test.js — a group that removed the bot is no longer admitted.
   Kicking the bot (or it leaving) kept the room admitted, so any admin who added it back re-opened the owner's
   station to every member without a fresh /allow. Real adapter + real hub; fakes only, no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

const OWNER = '5';
function mkAdapter(opts) {
  const got = [], sent = [];
  const ad = makeChannelAdapter(Object.assign({
    transport: { getUpdates: async () => [], send: async (chatId, text, o) => { sent.push({ chatId, text, o }); return { ok: true, messageId: 'm' + sent.length }; } },
    normalize: (r) => r, name: 'telegram', clock: { now: () => 1000 },
    botUsername: 'halcyonbot', ownerUserId: OWNER,
    onInbound: (im) => got.push(im)
  }, opts || {}));
  return { ad, got, sent };
}
const group = (extra) => Object.assign({ chatId: '-1001', chatType: 'group', userId: '9', userName: 'Ana', text: 'hello', messageId: String(Math.random()) }, extra);
const flush = () => new Promise(r => setTimeout(r, 0));
function fakeStore() {
  const recs = new Map();
  return {
    recs, loadHistory: () => [], appendTurn: () => [],
    getChatRecord: (c) => recs.get(String(c)),
    saveChatRecord: (c, patch) => { const m = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), m); return m; }
  };
}
function mkHub(over) {
  const sends = [], runs = [];
  const store = (over && over.store) || fakeStore();
  let n = 0;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram', store,
    runOnce: async (o) => { runs.push(o); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: (c, t) => { sends.push({ chatId: String(c), text: t }); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++n),
    isOwner: (m) => String(m.userId) === OWNER
  }, over || {}));
  return { hub, sends, runs, store };
}
const inbound = (userId, text, extra) => Object.assign({ channel: 'telegram', chatId: '-1001', chatType: 'group', userId, text, messageId: String(Math.random()), ts: 1 }, extra || {});

(async () => {
  // ---- 2. removed from a group = no longer admitted; a re-add needs the owner's fresh /allow ----
  {
    const t = mkHub();
    t.store.saveChatRecord('-1001', { admittedOn: 'telegram', requireMention: true });
    t.hub.onMembership({ channel: 'telegram', chatId: '-1001', chatType: 'group', status: 'kicked', byUserId: '77' });
    A.eq(t.store.getChatRecord('-1001').admittedOn, '', 'kicked: the admission is withdrawn');
    A.ok(!!t.hub._internals.ledger.chat('telegram|-1001').dead, 'and the chat is marked dead, in the delivery ledger (channel-delivery-ledger S2)');
    A.eq(t.store.getChatRecord('-1001').unreachable, undefined, 'the shared chat record\'s old unreachable flag is no longer written');
    A.eq(t.store.getChatRecord('-1001').requireMention, true, 'its other settings are kept');
    A.eq(t.hub.chatAdmitted('-1001'), false, 'the adapter\'s per-message read now says closed');

    t.store.saveChatRecord('-2002', { admittedOn: 'telegram' });
    t.hub.onMembership({ channel: 'telegram', chatId: '-2002', chatType: 'group', status: 'left' });
    A.eq(t.hub.chatAdmitted('-2002'), false, 'left: withdrawn too');
    t.store.saveChatRecord('-3003', { admittedOn: 'telegram' });
    t.hub.onMembership({ channel: 'telegram', chatId: '-3003', chatType: 'group', status: 'member' });
    A.eq(t.hub.chatAdmitted('-3003'), true, 'being added or promoted changes nothing');
    // a chat admitted on ANOTHER platform that happens to share the id is not this channel's to withdraw
    t.store.saveChatRecord('-4004', { admittedOn: 'discord' });
    t.hub.onMembership({ channel: 'telegram', chatId: '-4004', chatType: 'group', status: 'kicked' });
    A.eq(t.store.getChatRecord('-4004').admittedOn, 'discord', 'another channel\'s admission is untouched');
    // a DM block never had an admission to withdraw
    t.hub.onMembership({ channel: 'telegram', chatId: 'c5', chatType: 'dm', status: 'kicked' });
    A.ok(!Object.prototype.hasOwnProperty.call(t.store.getChatRecord('c5') || {}, 'admittedOn'), 'a blocked DM writes no admission field');

    // the whole path: the adapter's allow-list reads the hub, so after a re-add the room is closed to members
    const { ad } = mkAdapter({ allowedChats: (id) => t.hub.chatAdmitted(id) });
    A.eq(ad._internals.admission(group({ text: '@halcyonbot hi', mentions: ['halcyonbot'] })), 'drop', 'a member in the re-added room is not answered');
    A.eq(ad._internals.admission(group({ userId: OWNER, text: '/allow' })), 'admit', 'until the owner admits it again');
  }

  A.report('channels.group-readd');
})().catch(e => { console.error(e); process.exit(1); });
