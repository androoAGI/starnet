/* node test/channels.owner-pairing-all.test.js — every channel is owner-PAIRED, never first-DM-wins (2026-09-23 audit).

   Before: Discord/Slack/Matrix/Signal fell back to the adapter's trust-on-first-use — the first stranger to DM a
   freshly connected bot (a guild member, anyone in a joined Matrix room) became the owner, with owner-trusted runs.
   Now each wrapper forwards `ownerAdmission`, and the host wires it to the same one-time local pairing code as
   Telegram. Drives the REAL registry descriptors + adapters + hub with fake transports (no network). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const pairing = require('../sidecar/channels/owner-pairing.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');

function fakeStore() {
  const hist = new Map();
  return { loadHistory(a) { return (hist.get(a) || []).slice(); },
           appendTurn(a, r, c) { const arr = hist.get(a) || []; arr.push({ role: r, content: c }); hist.set(a, arr); return arr; },
           getChatRecord() { return null; } };
}

// one raw inbound per platform, from `who` saying `text` (DM shapes; n keeps ids unique)
const RAW = {
  discord: (who, text, n) => ({ id: String(900 + n), channel_id: 'dm-' + who, content: text, author: { id: who, username: who } }),
  slack: (who, text, n) => ({ type: 'message', channel: 'D-' + who, channel_type: 'im', user: who, text: text, ts: '1.' + n }),
  matrix: (who, text, n) => ({ roomId: '!shared:hs', event: { type: 'm.room.message', sender: '@' + who + ':hs', event_id: '$' + n, content: { msgtype: 'm.text', body: text } }, selfId: '@bot:hs' }),
  signal: (who, text, n) => ({ envelope: { sourceNumber: who === 'owner' ? '+15550001' : '+15550002', sourceName: who, dataMessage: { message: text, timestamp: 1000 + n } } })
};

(async () => {
  // ---- 1. the pure admission decision ----
  {
    const iss = pairing.issue({ now: 1000 });
    A.eq(pairing.admission(iss.state, 'hello', 1001), false, 'an ordinary first message claims nothing');
    A.eq(pairing.admission(iss.state, 'pair AAAAA-AAAAA', 1001), false, 'a wrong code claims nothing');
    A.eq(pairing.admission(iss.state, 'pair ' + iss.code, 1001).allow, true, 'slash-less "pair CODE" (Slack-safe) admits');
    A.eq(pairing.admission(iss.state, '/pair ' + iss.code, 1001).allow, true, '"/pair CODE" still admits');
    A.ok(/Discord DM/.test(pairing.admission(iss.state, 'pair ' + iss.code, 1001, 'Discord').reply), 'the acknowledgement names the platform');
    A.eq(pairing.admission(iss.state, 'pair ' + iss.code, iss.state.expiresAt), false, 'an expired code claims nothing');
    A.eq(pairing.admission(null, 'pair ' + iss.code, 1001), false, 'no issued challenge = nobody can claim');
  }

  // ---- 2. host wiring (source guard): both adapter builders pass the admission hook ----
  {
    const idx = readSidecarSource();
    A.ok(/ownerAdmission: \(message\) => channelOwnerAdmission\('discord', message\)/.test(idx), 'Discord adapter is built with the pairing admission');
    A.ok(/ownerAdmission: \(message\) => channelOwnerAdmission\(id, message\)/.test(idx), 'Slack/Matrix/Signal adapters are built with the pairing admission');
    A.ok(/json\(200, withOwnerPairing\('discord'/.test(idx) && /json\(200, withOwnerPairing\(id,/.test(idx), 'connect responses carry a one-time code when no owner is bound');
    A.ok(/const acceptingDms = !!st\.connected && ownerLocked;/.test(idx), 'status never reports an unpaired channel as accepting DMs');
    A.ok(/ownerPair: \/\^\\\/api\\\/channels\\\/\(discord\|slack\|matrix\|signal\)\\\/owner\\\/pair\$\//.test(idx), 'a PAIR OWNER route exists for every non-Telegram channel');
  }

  // ---- 3. behaviour: a stranger cannot claim; the code-holder can; strangers stay out afterwards ----
  for (const id of ['discord', 'slack', 'matrix', 'signal']) {
    const reg = makeChannelRegistry();
    A.ok(reg.has(id), 'registry exposes ' + id);
    const iss = pairing.issue({ now: Date.now() });
    const ran = [], sent = [], claims = [];
    const runOnce = async (o) => {
      ran.push(o);
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' });
    };
    let n = 0;
    const script = [
      RAW[id]('stranger', 'hello bot', ++n),
      RAW[id]('stranger', 'pair ZZZZZ-ZZZZZ', ++n),
      RAW[id]('owner', 'pair ' + iss.code, ++n),
      RAW[id]('owner', 'summarise my inbox', ++n),
      RAW[id]('stranger', 'run whoami', ++n)
    ];
    const transport = {
      getUpdates: async () => script.length ? [script.shift()] : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, messageId: 'm' + sent.length }; }
    };
    let ids = 0;
    const { adapter } = wireChannel(reg.get(id), {
      hub: { runOnce, store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'r' + (++ids) },
      adapter: {
        transport, clock: { now: () => Date.now() }, sleep: () => Promise.resolve(),
        onOwnerClaim: (uid) => claims.push(uid),
        ownerAdmission: (message) => pairing.admission(iss.state, message && message.text, Date.now(), id)
      }
    });
    await adapter.connect();
    for (let i = 0; i < 200 && (script.length || ran.length < 1); i++) await new Promise(r => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    await adapter.disconnect();
    A.eq(claims.length, 1, id + ': exactly one owner claim');
    A.ok(claims.length === 1 && /owner|\+15550001/.test(String(claims[0])), id + ': the claim went to the code-holder, not the first sender');
    A.eq(ran.length, 1, id + ': only the paired owner\'s real message reached a run (strangers and the pair message did not)');
    A.ok(ran.length === 1 && /summarise my inbox/.test(JSON.stringify(ran[0].messages)), id + ': the run carried the owner\'s message');
    A.ok(sent.some(s => /Owner paired/.test(s.text)), id + ': the owner got the pairing acknowledgement');
    A.ok(!sent.some(s => /ZZZZZ|hello bot|whoami/.test(s.text)), id + ': nothing was answered to the stranger');
  }

  A.report('channels.owner-pairing-all.test');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
