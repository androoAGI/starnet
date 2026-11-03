/* node test/channels.first-message-stream.test.js — a NEW chat's FIRST message runs on that chat's own stream.

   THE DEFECT (found live 2026-10-18 on the dev channel). hub.js resolvedStreamId read
   `const bound = rec && String(rec.streamId || '')`. A chat the station has never seen has no record, so `bound` was
   undefined — and RegExp.test(undefined) tests the STRING "undefined", a valid-looking id. The resolver returned
   undefined, so on every hub that binds chats (Telegram, Discord, Slack, Matrix, Signal, the dev channel) the first
   exchange of every new chat ran with NO stream: its run row read streamId '', its transcript was filed under 'global'
   (COMMS General) where TO REVIEW could not read it, its line's hops and hand-off lost the chat too, and its history was
   the agent's SHARED legacy channel file — every other chat that agent talks to. The second message got
   channel_<channel>_<chatId>, because by then a record existed.

   The real channel store in a scratch dir (its getChatRecord answers undefined for an unseen chat, the exact shape that
   tripped the guard), the real hub, and a fake runOnce that records what each run was handed. Red against the old guard. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const History = require('./helpers/channel-history.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-firststream-'));
let clk = 1000;
const clock = { now: () => ++clk };
const openStore = (dir) => makeChannelStore({ fs, pathMod: path, root: dir, clock });
const freshDir = () => fs.mkdtempSync(path.join(ROOT, 'station-'));
const idGen = () => { let i = 0; return () => 'run' + (++i); };
let mid = 0;
const dm = (chatId, text) => ({ channel: 'telegram', chatId, chatType: 'dm', userId: 'u1', text, messageId: String(++mid), ts: 1 });

// a hub whose every run (entry AND hop) is recorded with the stream and the history it was handed
function rig(opts) {
  const runs = [], asked = [];
  const history = History.make(opts.store, { now: clock.now, onView: (name, sid) => { if (name === 'model-replay') asked.push(sid); } }).history;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram',
    runOnce: async (r) => {
      runs.push({ agentId: r.agentId, streamId: r.streamId, said: r.messages.map(m => String(m.content)) });
      r.emit('agent.run.start', { agentId: r.agentId, runId: r.runId, trigger: 'event', model: r.model });
      r.emit('agent.token', { agentId: r.agentId, runId: r.runId, delta: 'ok from ' + r.agentId });
      r.emit('agent.run.end', { agentId: r.agentId, runId: r.runId, reason: 'done', turns: 1, usd: 0 });
    },
    send: () => Promise.resolve({ ok: true }),
    secrets: () => ({ key: 'k', model: 'm', agentId: 'agent' }),   // every chat talks to ONE agent (the app's own, set at connect)
    classify: () => false, newId: idGen(),
    history
  }, opts));
  return { hub, runs, asked };
}

(async () => {
  /* ---- 1. the first message of a chat the station has never seen ---- */
  {
    const dir = freshDir(), store = openStore(dir);
    const { hub, runs, asked } = rig({ store });
    A.eq(store.getChatRecord('555'), undefined, 'fixture: the real store has no record for a chat it has never seen');
    await hub.onInbound(dm('555', 'chat A: the launch slips to Friday'));
    A.eq(runs.length, 1, 'the first message ran once');
    A.eq(runs[0].streamId, 'channel_telegram_555', 'the FIRST message runs on the chat\'s own stream (it ran with none)');
    A.eq(asked, ['channel_telegram_555'], 'its history is read from that chat\'s canonical transcript');
    A.eq(store.getChatRecord('555').streamId, 'channel_telegram_555', 'the first message saves the stream onto the chat record');
    A.eq(openStore(dir).getChatRecord('555').streamId, 'channel_telegram_555', 'and the record holds it on disk (a restart reads it back)');

    /* ---- 2. the second message keeps it ---- */
    await hub.onInbound(dm('555', 'and the budget?'));
    A.eq(runs[1].streamId, 'channel_telegram_555', 'the second message stays on the same stream');
    A.eq(asked[1], 'channel_telegram_555', 'and reads the same transcript');

    /* ---- 3. another new chat gets ITS stream, never the first chat's words ---- */
    // A legacy shared-agent file from an older station must never become this new chat's history.
    A.eq(store.loadHistory('agent'), [], 'bound turns no longer create shared-agent legacy history');
    store.appendTurn('agent', 'user', 'chat A: the launch slips to Friday');
    A.ok(store.loadHistory('agent').some(t => /launch slips to Friday/.test(t.content)), 'fixture: the shared legacy file holds chat A\'s words');
    await hub.onInbound(dm('777', 'hello'));
    A.eq(runs[2].streamId, 'channel_telegram_777', 'a second new chat starts on its own stream');
    A.ok(!runs[2].said.some(s => /launch slips to Friday/.test(s)), 'and is NOT handed chat A\'s conversation as its history');
    A.eq(runs[2].said, ['hello'], 'it sees only its own first message');
  }

  /* ---- 4. a store that answers null (not undefined) for an unseen chat — the same stream ---- */
  {
    const saves = []; let record = null;
    const store = {
      loadHistory: () => [], appendTurn: () => {},
      getChatRecord: () => record,
      saveChatRecord: (chatId, patch) => { saves.push({ chatId: String(chatId), patch }); record = Object.assign({}, record, patch); return record; }
    };
    const { hub, runs } = rig({ store });
    await hub.onInbound(dm('888', 'hi'));
    A.eq(runs[0].streamId, 'channel_telegram_888', 'a null record resolves to the chat\'s own stream too (RegExp.test(null) tests "null")');
    A.eq(saves.filter(s => s.patch.streamId).length, 1, 'one binding save for the new chat, separate from strict import markers');
    A.eq(saves[0].patch.streamId, 'channel_telegram_888', 'and it carries the stream');
  }

  /* ---- 5. a record that names a real stream still wins; an unusable one falls back to the chat's own ---- */
  {
    const recs = {
      desk: { agentId: 'agent', channel: 'telegram', streamId: 'desktop_stream_1' },   // a COMMS conversation handed to this chat
      junk: { agentId: 'agent', channel: 'telegram', streamId: 'not a stream id!' }
    };
    const store = {
      loadHistory: () => [], appendTurn: () => {},
      getChatRecord: (c) => recs[c],
      saveChatRecord: (c, patch) => (recs[c] = Object.assign({}, recs[c], patch))
    };
    const { hub, runs } = rig({ store });
    await hub.onInbound(dm('desk', 'continue here'));
    await hub.onInbound(dm('junk', 'hello'));
    A.eq(runs[0].streamId, 'desktop_stream_1', 'a bound stream (the cross-surface hand-off) is still honoured');
    A.eq(runs[1].streamId, 'channel_telegram_junk', 'an unusable bound id falls back to the chat\'s own stream');
  }

  /* ---- 6. the channel is part of the id: the dev channel and a per-agent bot ---- */
  {
    const dev = rig({ channel: 'dev', store: openStore(freshDir()) });
    await dev.hub.onInbound(Object.assign(dm('probe1', 'hi'), { channel: 'dev' }));
    A.eq(dev.runs[0].streamId, 'channel_dev_probe1', 'the dev channel\'s first message: channel_dev_<chatId>');
    const bot = rig({ channel: 'telegram:bot7', store: openStore(freshDir()) });
    await bot.hub.onInbound(dm('555', 'hi'));
    A.eq(bot.runs[0].streamId, 'channel_telegram_bot7_555', 'a per-agent bot\'s first message: its id is folded in, sanitised');
  }

  /* ---- 7. the line carries it from the first message, without a parallel legacy hop history ---- */
  {
    const store = openStore(freshDir());
    const advanced = [];
    const chain = {
      stopNote: () => '',
      advance: async (o) => {
        advanced.push(o.streamId);
        const e = await o.runAgent({ agentId: 'editor', dockId: 'editor_dock', lineId: 'L1', text: o.text, signal: o.signal });
        return { hops: [{ agentId: 'editor' }], text: e.text, agentId: 'editor', stopped: null };
      }
    };
    const { hub, runs } = rig({ store, chain, lineOriginFor: () => 'L1' });
    await hub.onInbound(dm('555', 'draft the memo'));
    A.eq(runs.map(r => r.agentId + '@' + r.streamId), ['agent@channel_telegram_555', 'editor@channel_telegram_555'],
      'the entry run AND its hop file under the chat\'s stream on the first message (the hop ran under \'global\')');
    A.eq(advanced, ['channel_telegram_555'], 'the line\'s hand-off is told the job\'s stream (SEND TO reads its run rows back by it)');
    const keys1 = (store.getChatRecord('555').hopKeys || []).slice();
    await hub.onInbound(dm('555', 'shorter please'));
    A.eq(keys1, [], 'canonical hop creates no legacy history key');
    A.eq(store.getChatRecord('555').hopKeys || [], keys1, 'the next job continues on canonical history only');
  }

  /* ---- 8. bindChats:false hubs (the sample proof, line triggers) are unchanged ---- */
  {
    // no stream of their own: no stream, on the first message and every one after — even over a stale record
    const saves = [];
    const store = {
      loadHistory: () => [], appendTurn: () => {},
      getChatRecord: (c) => (c === 'sample' ? { agentId: 'agent', channel: 'sample', streamId: 'stale_stream' } : undefined),
      saveChatRecord: (c, patch) => { saves.push(patch); return patch; }
    };
    const plain = rig({ channel: 'sample', bindChats: false, store });
    await plain.hub.onInbound(Object.assign(dm('sample', 'one'), { channel: 'sample' }));
    await plain.hub.onInbound(Object.assign(dm('sample', 'two'), { channel: 'sample' }));
    A.ok(plain.runs.length === 2 && plain.runs.every(r => r.streamId === undefined), 'an unaddressed hub with no stream of its own still runs with none');
    A.eq(plain.asked, [], 'and never reads a canonical transcript');
    A.eq(saves, [], 'and never writes a chat record');

    // the sample route's per-dispatch stream (a function) and a fixed stream (a string): theirs, first message included
    let current = 'sample-abc12345';
    const sample = rig({ channel: 'sample', bindChats: false, store, streamId: () => current });
    await sample.hub.onInbound(Object.assign(dm('sample', 'one'), { channel: 'sample' }));
    current = 'sample-def67890';
    await sample.hub.onInbound(Object.assign(dm('sample', 'two'), { channel: 'sample' }));
    A.eq(sample.runs.map(r => r.streamId), ['sample-abc12345', 'sample-def67890'], 'the sample route\'s own stream, per dispatch');
    const trigger = rig({ channel: 'trigger', bindChats: false, store, streamId: 'trg-1' });
    await trigger.hub.onInbound(Object.assign(dm('trg', '[Line trigger] {"order":7}'), { channel: 'trigger' }));
    A.eq(trigger.runs[0].streamId, 'trg-1', 'a fixed stream rides the first message');
    A.eq(saves, [], 'still no chat record written');
  }

  cleanup();   // before report(): it exits the process
  A.report('channels.first-message-stream.test');
})().catch(e => { cleanup(); console.error(e && e.stack || e); process.exit(1); });

function cleanup() { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} }
