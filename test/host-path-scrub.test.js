/* node test/host-path-scrub.test.js — a chat is never shown an absolute host path (run-paths lane, review round 3,
   2026-10-28; sidecar/host-path-scrub.js).

   Round 2 cut the workspaces root in three of the hubs only, per chunk AFTER chunking, and only as literally spelled;
   channel.send, a routine delivery and its missed-file note, the notifier, a loop notice, Discord / Slack / Matrix /
   Signal and the trigger hub sent it as written. Every row marked (was: …) below leaked before this fix (scratchpad
   probe rr3-scrub.js). Proves:
     1. the ONE scrub: every spelling of the root (case, separators, JSON escapes, percent-encoding, 8.3, \\?\, the
        Git Bash / WSL / Cygwin forms, its real path) becomes a readable "[workspace]", another folder is left alone,
        it is idempotent, and it fails CLOSED (a throwing prefix list still scrubs the configured root);
     2. the real hub scrubs the WHOLE text before it chunks (deliver and the outbox), so a path cut at a chunk boundary
        never goes out in halves, and a rig's hostPathPrefixes gets the same scrub;
     3. guardOutbound wraps a REAL adapter's send / editMessage / answerCallback in place: the Telegram adapter (as
        index.js startTelegram / startTelegramBot wire it) and the Slack / Matrix / Signal adapters through wireChannel's
        `outbound` (as index.js wires Discord and the generic channels), so a send that never passes a hub (channel.send,
        a routine delivery, the notifier, a loop notice, a step-in nudge) is scrubbed too;
     4. channel.send chunks its body itself: wired as the host wires it, the body is scrubbed whole first;
     5. the host wires every one of those surfaces through the chokepoint (source locks over sidecar/index.js). */
'use strict';
const A = require('./_assert.js');
const { makeHostPathScrub, hostPathForms, guardOutbound, PLACEHOLDER } = require('../sidecar/host-path-scrub.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');
const { makeTelegramAdapter } = require('../sidecar/channels/telegram.js');
const { makeCommsTools } = require('../sidecar/tools/builtin/comms.js');
const { readSidecarIndex, functionSourceIn } = require('./helpers/source');

const WS = 'C:\\Users\\andro\\AppData\\Roaming\\StarNet\\workspaces';
const leaks = (s) => /AppData|andro|Roaming/i.test(String(s));
const scrub = makeHostPathScrub({ fixed: [WS] });

(async () => {
  // ---- 1. the scrub itself ----
  const bypass = [
    ['backslash', 'Saved at ' + WS + '\\alpha\\shots\\x.png.', 'Saved at [workspace]\\alpha\\shots\\x.png.'],
    ['forward slash', 'Saved at C:/Users/andro/AppData/Roaming/StarNet/workspaces/alpha/shots/x.png', 'Saved at [workspace]/alpha/shots/x.png'],
    ['lower case', 'saved at c:\\users\\andro\\appdata\\roaming\\starnet\\workspaces\\alpha\\x.png', 'saved at [workspace]\\alpha\\x.png'],
    ['JSON-escaped', '{"path":"C:\\\\Users\\\\andro\\\\AppData\\\\Roaming\\\\StarNet\\\\workspaces\\\\alpha\\\\x.png"}', '{"path":"[workspace]\\\\alpha\\\\x.png"}'],
    ['file URL', 'open file:///C:/Users/andro/AppData/Roaming/StarNet/workspaces/alpha/x.png', 'open file:///[workspace]/alpha/x.png'],
    ['URL-encoded (was: sent as written)', 'C%3A%5CUsers%5Candro%5CAppData%5CRoaming%5CStarNet%5Cworkspaces%5Calpha%5Cx.png', '[workspace]%5Calpha%5Cx.png'],
    ['partly URL-encoded (was: sent)', 'file:///C:/Users/andro/AppData/Roaming/StarNet/work%73paces/alpha/x.png', 'file:///[workspace]/alpha/x.png'],
    ['lower-case hex, + for a space', 'c%3a%5cusers%5candro%5cappdata%5croaming%5cstarnet%5cworkspaces%2falpha', '[workspace]%2falpha'],
    ['8.3 short form (was: sent)', 'C:\\Users\\andro\\AppData\\Roaming\\StarNet\\WORKSP~1\\alpha\\x.png', '[workspace]\\alpha\\x.png'],
    ['8.3 hashed form (was: sent)', 'C:\\Users\\andro\\AppData\\Roaming\\StarNet\\WO3F2A~1\\alpha\\x.png', '[workspace]\\alpha\\x.png'],
    ['\\\\?\\ prefix', '\\\\?\\C:\\Users\\andro\\AppData\\Roaming\\StarNet\\workspaces\\alpha\\x.png', '\\\\?\\[workspace]\\alpha\\x.png'],
    ['WSL form (was: sent)', '/mnt/c/Users/andro/AppData/Roaming/StarNet/workspaces/alpha/x.png', '[workspace]/alpha/x.png'],
    ['Git Bash form (was: sent)', 'cd /c/Users/andro/AppData/Roaming/StarNet/workspaces/alpha', 'cd [workspace]/alpha'],
    ['Cygwin form', '/cygdrive/c/Users/andro/AppData/Roaming/StarNet/workspaces/alpha/x', '[workspace]/alpha/x'],
    ['mixed separators', 'C:\\Users//andro\\\\AppData/Roaming\\StarNet/workspaces\\alpha/x.png', '[workspace]\\alpha/x.png'],
    ['legible, not deleted (was: `cd  && npm test`)', '`cd ' + WS + '\\alpha && npm test`', '`cd [workspace]\\alpha && npm test`'],
    ['the root then a full stop (was: sent)', 'Your workspaces live in ' + WS + '.', 'Your workspaces live in [workspace].'],
    ['the root then an agent id and a full stop', 'see ' + WS + '\\alpha.', 'see [workspace]\\alpha.']
  ];
  for (const [label, text, want] of bypass) {
    const got = scrub(text);
    A.eq(got, want, 'scrub: ' + label);
    A.ok(!leaks(got), 'scrub: ' + label + ' names no host path');
    A.eq(scrub(got), got, 'scrub: ' + label + ' is idempotent');
  }
  for (const [label, text] of [
    ['another folder beside it', 'Backup in ' + WS + '-old\\alpha\\x'],
    ['another folder with an extension', 'Backup in ' + WS + '.bak\\alpha\\x'],
    ['a longer folder name', 'in ' + WS + 'X\\alpha'],
    ['a project path', 'Wrote C:\\Users\\andro\\code\\proj\\report.md'],
    ['plain prose', 'nothing to see here']
  ]) A.eq(scrub(text), text, 'scrub leaves alone: ' + label);
  A.eq(PLACEHOLDER, '[workspace]', 'the placeholder is the readable "[workspace]"');
  // minor-7 (review round 4): Slack reads <…> as a control sequence (a link or a mention), so the placeholder never uses
  // angle brackets, and it can never recurse: scrubbing it, or a text already scrubbed, changes nothing
  A.ok(!/[<>]/.test(PLACEHOLDER), 'the placeholder carries no angle brackets (was: "<workspace>", a Slack control sequence)');
  for (const t of [PLACEHOLDER, PLACEHOLDER + '\\alpha\\x.png', 'cd ' + PLACEHOLDER + '/alpha && ' + PLACEHOLDER + '.', '[' + PLACEHOLDER + ']']) {
    A.eq(scrub(t), t, 'scrubbing the placeholder is a no-op: ' + JSON.stringify(t));
  }
  {
    const posix = makeHostPathScrub({ fixed: ['/home/me/.config/StarNet/workspaces'] });
    A.eq(posix('wrote /home/me/.config/StarNet/workspaces/alpha/x.md and /home/me/.config/StarNet/workspaces.bak/y'), 'wrote [workspace]/alpha/x.md and /home/me/.config/StarNet/workspaces.bak/y', 'a POSIX root is scrubbed the same way');
  }
  {
    // the real path (a junctioned data folder) by every spelling, and FAIL CLOSED
    const forms = hostPathForms(WS, { realpath: () => 'D:\\Data\\StarNet\\ws' });
    A.ok(forms.indexOf('D:\\Data\\StarNet\\ws') >= 0 && forms.indexOf('/d/Data/StarNet/ws') >= 0 && forms.indexOf('/mnt/c/Users/andro/AppData/Roaming/StarNet/workspaces') >= 0, 'hostPathForms: the root, its real path, and their shell forms (' + forms.join(' | ') + ')');
    const live = makeHostPathScrub({ fixed: [WS], prefixes: () => hostPathForms(WS, { realpath: () => 'D:\\Data\\StarNet\\ws' }) });
    A.eq(live('at D:\\Data\\StarNet\\ws\\alpha\\x and /d/Data/StarNet/ws/alpha'), 'at [workspace]\\alpha\\x and [workspace]/alpha', 'the real path is scrubbed too');
    const throwing = makeHostPathScrub({ fixed: [WS], prefixes: () => { throw new Error('realpath exploded'); } });
    A.eq(throwing('at ' + WS + '\\alpha\\x'), 'at [workspace]\\alpha\\x', 'fail closed: a throwing prefix list still scrubs the configured root');
    const badReal = hostPathForms(WS, { realpath: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } });
    A.ok(badReal.indexOf(WS) === 0 && badReal.length === 4, 'hostPathForms: a realpath that throws still returns the root\'s spellings');
  }

  // ---- 2. the real hub: the WHOLE text before chunking (deliver and the outbox) ----
  const hubWith = (extra, sent) => makeChannelHub(Object.assign({
    runOnce: async () => {}, maxMessageLength: 4096,
    store: { loadHistory: () => [], append: () => {}, getChatRecord: () => null, loadOutbox: () => [], removeOutbox: () => {} },
    send: (c, t) => { sent.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({}), classify: () => true, newId: () => 'x'
  }, extra));
  const atEdge = 'x'.repeat(4096 - 25) + WS + '\\alpha\\shots\\x.png';
  {
    const sent = [];
    const hub = hubWith({ scrubOutbound: scrub }, sent);
    await hub._internals.deliver('chat1', atEdge, 'r1', 'done');
    A.ok(sent.length >= 1 && !sent.some(leaks), 'hub deliver: a path at the chunk boundary never goes out in halves (was: "…C:\\Users\\andro\\AppData\\Ro" + "aming…")');
    A.ok(sent.join('').indexOf('[workspace]\\alpha\\shots\\x') >= 0, 'hub deliver: the placeholder stands where the path was');
  }
  {
    const sent = [];
    const hub = hubWith({ scrubOutbound: scrub, store: { loadHistory: () => [], append: () => {}, getChatRecord: () => null, removeOutbox: () => {}, loadOutbox: () => [{ id: 'o1', chatId: 'chat1', text: atEdge }] } }, sent);
    await hub._internals.flushOutbox();
    A.ok(sent.length >= 1 && !sent.some(leaks), 'hub outbox: a stored reply is scrubbed whole before it is re-chunked');
  }
  {
    const sent = [], edits = [];
    const hub = hubWith({ hostPathPrefixes: () => [WS], editMessage: (c, m, t) => { edits.push(t); return Promise.resolve({ ok: true }); }, deleteMessage: () => Promise.resolve({ ok: true }) }, sent);
    await hub._internals.deliver('chat1', atEdge, 'r2', 'done');
    A.ok(sent.length >= 1 && !sent.some(leaks), 'hub with a rig\'s hostPathPrefixes: the same whole-text scrub');
    await hub._internals.deliver('chat1', 'final at /c/Users/andro/AppData/Roaming/StarNet/workspaces/alpha/x', 'r3', 'done', '', null, 'seed-1');
    A.ok(edits.length === 1 && !leaks(edits[0]) && edits[0].indexOf(PLACEHOLDER + '/alpha/x') >= 0, 'hub editMessage (a streamed reply replaced in place) is scrubbed: ' + JSON.stringify(edits));
  }

  // ---- 3. guardOutbound on REAL adapters: the sends that never pass a hub ----
  {
    // the station / agent Telegram bot, guarded exactly as index.js startTelegram / startTelegramBot do it
    const bodies = [];
    const fetch = async (url, init) => { bodies.push(String(init && init.body || '')); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }; };
    const tg = makeTelegramAdapter({ fetch, token: '1:x', clock: { now: () => 1 }, onInbound: () => {} });
    A.eq(guardOutbound(tg, scrub), tg, 'guardOutbound wraps the adapter IN PLACE (every holder of it is covered)');
    guardOutbound(tg, scrub);   // idempotent: never double-wrapped
    await tg.send('42', 'routine digest: ' + WS + '\\alpha\\report.md');
    await tg.editMessage('42', '7', 'edited: ' + WS + '\\alpha\\x');
    await tg.answerCallback('cb1', 'saved to ' + WS + '\\alpha');
    A.ok(bodies.length === 3 && !bodies.some(leaks), 'telegram: send / editMessage / answerCallback reach the wire scrubbed (' + bodies.map(b => b.slice(0, 80)).join(' || ') + ')');
    A.ok(bodies[0].indexOf('workspace') >= 0, 'telegram: the placeholder reached the wire');
  }
  const reg = makeChannelRegistry();
  for (const id of ['slack', 'matrix', 'signal']) {
    const sent = [];
    const transport = { getUpdates: async () => [], send: async (chatId, text) => { sent.push(text); return { ok: true, messageId: 'm' }; },
      editMessage: async (chatId, mid, text) => { sent.push(text); return { ok: true }; } };
    const { hub, adapter } = wireChannel(reg.get(id), {
      outbound: scrub,
      hub: { runOnce: async () => {}, store: { loadHistory: () => [], append: () => {}, getChatRecord: () => null }, secrets: () => ({}), classify: () => false, newId: () => 'x' },
      adapter: { transport, clock: { now: () => 1 }, sleep: () => Promise.resolve() }
    });
    // channel.send / a routine delivery / the notifier / a loop notice call the LIVE adapter directly
    await adapter.send('c1', 'notifier: ' + WS + '\\alpha\\out.txt');
    if (typeof adapter.editMessage === 'function') await adapter.editMessage('c1', 'm', 'edit: ' + WS + '\\alpha');
    const max = reg.get(id).maxMessageLength;
    await hub._internals.deliver('c1', 'x'.repeat(max - 25) + WS + '\\alpha\\shots\\x.png', 'r', 'done');
    A.ok(sent.length >= 3 && !sent.some(leaks), id + ' (wireChannel outbound): the adapter\'s own sends and the hub\'s chunked reply reach the wire scrubbed');
  }

  // ---- 4. channel.send chunks its own body: the host scrubs it whole first (index.js redact: t => scrubOutbound(redact(t))) ----
  {
    const parts = [];
    const tools = makeCommsTools({
      listTargets: () => [{ target: 't1', channel: 'telegram', chatId: '1', agentId: 'alpha', connected: true }],
      sendTo: async (target, text) => { parts.push(text); return { ok: true }; },
      maxLenFor: () => 300, redact: (t) => scrub(t)
    });
    await tools.sendTool.run({ target: 't1', text: 'y'.repeat(280) + ' ' + WS + '\\alpha\\shots\\x.png done' }, { agentId: 'alpha' });
    A.ok(parts.length >= 2 && !parts.some(leaks), 'channel.send: a path at the part boundary never goes out in halves (' + JSON.stringify(parts.map(p => p.slice(-40))) + ')');
  }

  // ---- 5. the host wires every surface through the ONE chokepoint (sidecar/index.js) ----
  {
    // index.js's own structure is the subject here (which adapters it guards, which calls it routes), so the exact file
    const idx = readSidecarIndex();
    A.eq((idx.match(/const scrubOutbound = HostPathScrub\.makeHostPathScrub\(\{ fixed: \[WORKSPACES\], prefixes: \(\) => HostPathScrub\.hostPathForms\(WORKSPACES, \{ realpath:/g) || []).length, 1, 'one host scrub: the configured root fixed (fail closed), its real path and spellings live');
    A.ok(!/hostPathPrefixes/.test(idx), 'no hub is left on round 2\'s per-hub prefix list');
    for (const fn of ['startTelegram', 'startTelegramBot']) {
      const body = functionSourceIn(idx, fn);
      A.ok(body.length > 1000 && /guardOutbound\(adapter\);[^\n]*\n\s*adapterRef = adapter;/.test(body), fn + ': the bot\'s adapter is guarded before anything holds it');
      A.ok(/scrubOutbound: scrubOutbound/.test(body), fn + ': its hub scrubs the whole text before chunking');
    }
    A.eq((idx.match(/wireChannel\([^\n]*\{\n\s*outbound: scrubOutbound,/g) || []).length, (idx.match(/= wireChannel\(/g) || []).length, 'every wireChannel call (Discord, Slack / Matrix / Signal) passes the outbound scrub');
    A.ok(/discord = \{ adapter: wired\.adapter/.test(idx) && /genericChannels\[id\] = \{ adapter: wired\.adapter/.test(idx), 'the live Discord / generic handles are the wired (guarded) adapters');
    const hubs = idx.split('makeChannelHub({').slice(1).map(s => s.slice(0, s.indexOf('\n  });') > 0 ? s.indexOf('\n  });') : 6000));
    const unscrubbed = hubs.filter(h => !/scrubOutbound: scrubOutbound/.test(h) && !/channel: 'sample'/.test(h));
    A.eq(unscrubbed.length, 0, 'every hub the host builds (station + agent Telegram, DEV, trigger) carries the scrub; only the in-app sample hub does not (' + hubs.length + ' hubs)');
    const cron = functionSourceIn(idx, 'deliverCronResult');
    A.ok(/hubChunkText\(scrubOutbound\(redact\(chatText\)\)/.test(cron), 'a routine delivery scrubs the whole text before it is split');
    A.ok(/live\.adapter\.send\(chatId, RoutineMedia\.missedNote\(/.test(cron), 'its missed-file note goes out on the live (guarded) adapter');
    A.ok(/redact: \(t\) => scrubOutbound\(redact\(t\)\)/.test(idx), 'channel.send\'s body is scrubbed whole before the tool chunks it');
    A.ok(/devCaptureReply\(chatId, scrubOutbound\(text\)\)/.test(idx), 'the DEV channel\'s capture is scrubbed too');
    // every other outbound text goes through a LIVE adapter handle (guarded at its creation above)
    const sends = idx.match(/[\w.]*adapter\.send\(/g) || [];
    const live = sends.filter(s => /^(reach\.live\.adapter|t\.adapter|live\.adapter|adapter|adapterRef)\.send\($/.test(s));
    A.eq(live.length, sends.length, 'every adapter.send in the host is on a live (guarded) handle: ' + sends.join(' '));
    const commsSend = functionSourceIn(idx, 'commsSendTo');
    A.ok(/t\.adapter\.send\(/.test(commsSend) && /commsTargetReach\(target\)/.test(commsSend), 'channel.send resolves to the live adapter (commsTargetReach -> channelReach)');
  }

  A.report('host-path-scrub');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
