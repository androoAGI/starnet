/* node test/channels.group-user-commands.test.js — the Commander's OWN commands (usercommands.json) in a bot's
   groups and on every channel (2026-10-18: "custom commands cannot be created for botted groups").

   Five breaks, each reproduced against the real adapter + hub + slash registry before the fix:
     1. '/standup@starnetbot' — the form Telegram autocompletes in a group — answered "Unknown command.": the hub
        handed the raw text to the registry, which refuses an '@'. The built-ins had always stripped it.
     2. The Telegram "/" menu listed none of them (setMyCommands published only the hub's own table).
     3. A dashed name ('/disk-usage') was dropped by the group mention gate before the hub saw it — and Telegram's
        command grammar has no '-', so it could never be listed or tapped either. '/disk_usage' now runs it.
     4. Discord / Slack / Matrix / Signal hubs were never given the registry, so '/standup' went to the MODEL.
     5. A shell command typed in a group was refused with "only run in the StarNet desktop app" — false: the
        owner's Telegram DM runs them. Groups still refuse them (the output would post to the room); the reply now
        says where they DO run.
   Fakes only: no network, no sidecar boot (requiring sidecar/index.js would boot a real one). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub, parseUserCommand, COMMANDS } = require('../sidecar/channels/hub.js');
const slash = require('../sidecar/slash.js');
const { makeUserCommands, menuEntries, execRefusal } = require('../sidecar/usercommands.js');

const FILE = { commands: [
  { name: 'standup', type: 'alias', target: '/routine list' },
  { name: 'disk', type: 'exec', command: 'echo disk-ok' },
  { name: 'disk-usage', type: 'alias', target: '/usage', desc: 'How much the station spent' }
] };
const store = makeUserCommands({ fs: { existsSync: () => true, readFileSync: () => JSON.stringify(FILE) }, file: 'usercommands.json' });
const userList = store.load();
const userEntries = store.catalogEntries(userList);
const NAMES = userEntries.map(c => c.name);

function fakeStore() {
  return { loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null, saveChatRecord: () => {}, clearHistory: () => 0 };
}
function build(over) {
  const sends = [], runs = [], slashCalls = [];
  let ids = 0;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram', store: fakeStore(),
    runOnce: async (o) => { runs.push(o); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++ids),
    // the REAL registry resolves what the hub hands it — the same call runSlashForChannel makes first
    runSlash: async (input, ctx) => {
      slashCalls.push({ input, ctx });
      const out = slash.dispatch(input, { userCommands: userEntries });
      if (!out || !out.ok || !out.directive) return { ok: false, text: 'Unknown command.' };
      if (out.directive.type === 'exec') return ctx.ownerTrusted ? { ok: true, text: 'exec ran' } : { ok: false, text: execRefusal(out.directive.name, ctx) };
      return { ok: true, text: 'ran ' + out.directive.action };
    },
    userCommandNames: () => NAMES,
    isOwner: (m) => String(m.userId) === 'boss',
    ownerTrusted: (m) => String(m.userId) === 'boss' && m.chatType === 'dm'
  }, over || {}));
  return { hub, sends, runs, slashCalls };
}
const msg = (userId, text, chatType) => ({ channel: 'telegram', chatId: chatType === 'group' ? '-100' : 'c-' + userId, chatType: chatType || 'dm', userId, text, messageId: String(Math.random()), ts: 1 });
const settle = () => new Promise(r => setTimeout(r, 10));

(async () => {
  // ---- 1. parseUserCommand: the two forms a messenger produces, and what must stay a message ----
  {
    A.eq(parseUserCommand('/standup@starnetbot', NAMES), { name: 'standup', line: '/standup' }, '@bot suffix is stripped');
    A.eq(parseUserCommand('/standup@starnetbot  today please', NAMES), { name: 'standup', line: '/standup today please' }, 'arguments survive the strip');
    A.eq(parseUserCommand('/StandUp', NAMES), { name: 'standup', line: '/standup' }, 'case-insensitive like the registry');
    A.eq(parseUserCommand('/disk_usage', NAMES), { name: 'disk-usage', line: '/disk-usage' }, "'_' reads back as the dashed name Telegram cannot list");
    A.eq(parseUserCommand('/disk_usage@starnetbot', NAMES), { name: 'disk-usage', line: '/disk-usage' }, 'both forms together');
    A.eq(parseUserCommand('/disk_usage', ['disk_usage', 'disk-usage']), { name: 'disk_usage', line: '/disk_usage' }, 'an exact name always wins over the dash reading');
    A.eq(parseUserCommand('/standup/notes.md', NAMES), null, 'a path that starts with a command name is still a message');
    A.eq(parseUserCommand('/nope', NAMES), null, 'an unknown name is not a command');
    A.eq(parseUserCommand('standup', NAMES), null, 'no slash, no command');
  }

  // ---- 2. through the REAL hub + registry, as the paired owner in a GROUP ----
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/standup@starnetbot', 'group'));
    await settle();
    A.eq(t.slashCalls[0] && t.slashCalls[0].input, '/standup', 'the registry gets the canonical line, not "/standup@starnetbot"');
    A.ok(/ran routine/.test(t.sends[0] || ''), '/standup@bot runs the alias in a group (was "Unknown command.")');
    A.eq(t.runs.length, 0, 'no model run');
  }
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/disk_usage', 'group'));
    await settle();
    A.ok(/ran usage/.test(t.sends[0] || ''), '/disk_usage runs the /disk-usage alias');
  }
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/disk', 'group'));
    await settle();
    const ctx = t.slashCalls[0] && t.slashCalls[0].ctx;
    A.eq(ctx && ctx.chatType, 'group', 'the registry is told this is a group');
    A.eq(ctx && ctx.ownerTrusted, false, 'a group is never owner-trusted: shell commands stay refused there');
    A.eq(ctx && ctx.ownerDmExec, true, 'a hub that mints ownerTrusted has an owner DM where they run');
    A.ok(/never run in a group/.test(t.sends[0] || '') && /DM/.test(t.sends[0] || ''), 'the refusal says why, and to use the DM');
    A.ok(!/only run in the StarNet desktop app, not over messaging/.test(t.sends[0] || ''), 'the false "desktop only" line is gone');
  }
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/disk', 'dm'));
    await settle();
    A.eq(t.sends[0], 'exec ran', 'the owner DM still runs a shell command');
  }
  {
    const t = build();
    await t.hub.onInbound(msg('stranger', '/standup@starnetbot', 'group'));
    await t.hub.onInbound(msg('stranger', '/disk_usage', 'group'));
    await settle();
    A.ok(t.sends.length === 2 && t.sends.every(s => /owner-only/.test(s)), 'a group member is still refused both new forms');
    A.eq(t.slashCalls.length, 0, 'and nothing reached the registry for them');
  }
  {
    // a hub with no ownerTrusted minting (Discord, Slack, Matrix, Signal) words the refusal for itself
    const t = build({ channel: 'discord', ownerTrusted: undefined });
    await t.hub.onInbound(msg('boss', '/disk', 'group'));
    await t.hub.onInbound(msg('boss', '/disk', 'dm'));
    await settle();
    A.ok(/never run in a group/.test(t.sends[0] || '') && /desktop app/.test(t.sends[0] || '') && !/our DM/.test(t.sends[0] || ''), 'no "DM me" on a channel whose DM cannot run one');
    A.ok(/Telegram bot/.test(t.sends[1] || ''), 'a non-Telegram DM is told where they do run');
  }

  // ---- 3. the group mention gate admits a dashed command name ----
  {
    const got = [];
    const ad = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true }) },
      normalize: (r) => r, name: 'telegram', clock: { now: () => 1 },
      allowedChats: ['-1001'], ownerUserId: 'boss', botUsername: 'starnetbot',
      onInbound: (im) => got.push(im)
    });
    const g = (text) => ({ offset: 1, message: { chatId: -1001, chatType: 'group', userId: 'boss', userName: 'andro', text, messageId: String(Math.random()) } });
    ad._internals.dispatch(g('/disk-usage'));
    A.eq(got.length, 1, 'a bare /disk-usage reaches the hub in a group (was dropped)');
    ad._internals.dispatch(g('just chatting'));
    A.eq(got.length, 1, 'an unaddressed message is still dropped');
  }

  // ---- 4. the "/" menu rows ----
  {
    const reserved = COMMANDS.map(c => c.command);
    for (const c of slash.BUILTIN_COMMANDS) { reserved.push(c.name); for (const a of (c.aliases || [])) reserved.push(a); }
    const rows = menuEntries(userList, reserved);
    A.eq(rows.map(r => r.command), ['standup', 'disk', 'disk_usage'], 'every command is listed, dashes as underscores');
    A.ok(rows.every(r => /^[a-z0-9_]{1,32}$/.test(r.command) && r.description.length >= 1 && r.description.length <= 256), 'every row fits Telegram\'s grammar');
    A.eq(rows[0].description, 'Runs /routine list', 'an alias without a description names its target');
    A.eq(rows[2].description, 'How much the station spent', 'the Commander\'s own description wins');
    A.ok(!/echo/.test(rows[1].description), 'an exec row never publishes its shell snippet to the group');
    const clash = menuEntries([{ name: 'status', type: 'alias', target: '/usage' }, { name: 'copy', type: 'alias', target: '/usage' }], reserved);
    A.eq(clash, [], 'a name a built-in owns is never listed (the built-in would run)');
    A.eq(menuEntries([{ name: 'a'.repeat(33), type: 'alias', target: '/usage' }], []), [], 'a name over 32 characters is typeable but not listed');
    const both = menuEntries([{ name: 'disk-usage', type: 'alias', target: '/usage' }, { name: 'disk_usage', type: 'alias', target: '/tools' }], []);
    A.eq(both.map(r => r.description), ['Runs /tools'], 'a dashed name whose _ form is another command defers to that exact command');
  }

  // ---- 5. wiring: every channel control-surface hub carries the registry + the Commander's names ----
  {
    const idx = readSidecarSource();
    const starts = [];
    // a construction (`= makeChannelHub({` / `return makeChannelHub({`), never the signature quoted in hub.js's header
    const re = /(?:=|\breturn)\s*makeChannelHub\(\{|wireChannel\([^\n]*\{\s*\n\s*hub: \{/g;
    let m;
    while ((m = re.exec(idx))) starts.push(m.index);
    // every messenger hub — not the sample-crate route or a line trigger, which have no chat senders to type one
    const surfaces = starts.map(i => idx.slice(i, idx.indexOf('\n  });', i))).filter(b => !/channel: '(sample|trigger)'/.test(b));
    A.ok(surfaces.length >= 5, 'found the Telegram, multi-bot, Discord, generic and dev hubs (' + surfaces.length + ')');
    A.ok(surfaces.every(b => /runSlash:/.test(b) && /userCommandNames:/.test(b)), 'every one is handed runSlash + userCommandNames');
    A.ok(/function publishCommandMenu[\s\S]{0,700}channelMenuCommands\(\)/.test(idx), 'the published menu includes the Commander\'s commands');
    A.ok(/userExecRefusal\(out\.directive\.name, \{ chatType: ctx\.chatType/.test(idx), 'runSlashForChannel words its refusal per chat');
  }

  A.report('channels.group-user-commands.test');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
