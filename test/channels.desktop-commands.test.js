/* node test/channels.desktop-commands.test.js — desktop slash names typed on a messenger (bug 6cd531b1).
   "/routines", "/reset", "/tasks", "/buildaway" are the shared registry's own aliases of commands the hub DOES have,
   and "/version", "/v", "/q", "/retry" are registry built-ins the hub has no row for. Every one of them fell through
   parseCommand to the MODEL: a paid run whose answer was a guess at what the command means. Now an alias parses to
   its canonical hub command (so the owner gate reads one rule) and any other registry built-in is answered by the
   registry itself, for free. Real hub + the REAL slash registry; no network, no sidecar boot. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelHub, parseCommand, COMMANDS } = require('../sidecar/channels/hub.js');
const slash = require('../sidecar/slash.js');

const DESKTOP_ONLY = 'That command only works in the StarNet desktop app.';
function build(over) {
  const sends = [], runs = [], slashCalls = [], cleared = [];
  let ids = 0;
  const store = {
    loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null, saveChatRecord: () => {},
    clearHistory: (a) => { cleared.push(a); return 2; }
  };
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram', store,
    runOnce: async (o) => { runs.push(o.messages[o.messages.length - 1].content); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++ids),
    roster: () => [{ agentId: 'ultron', name: 'Ultron', model: 'm' }],
    // runSlashForChannel's own shape: the registry resolves, a non-server directive is refused as desktop-only
    runSlash: async (input, ctx) => {
      slashCalls.push(input);
      const out = slash.dispatch(input, {});
      if (!out || !out.ok || !out.directive) return { ok: false, text: 'Unknown command.' };
      if (out.directive.type !== 'server') return { ok: false, text: DESKTOP_ONLY };
      return { ok: true, text: 'ran ' + out.directive.action };
    },
    desktopCommand: (t) => !!slash.resolve('/' + t),
    isOwner: (m) => String(m.userId) === 'boss',
    ownerTrusted: (m) => String(m.userId) === 'boss' && m.chatType === 'dm'
  }, over || {}));
  return { hub, sends, runs, slashCalls, cleared };
}
const msg = (userId, text, chatType) => ({ channel: 'telegram', chatId: chatType === 'group' ? '-100' : 'c-' + userId, chatType: chatType || 'dm', userId, text, messageId: String(Math.random()), ts: 1 });

(async () => {
  // ---- 1. parity: every registry alias of a command the hub has parses to that command; the hub invents none ----
  {
    for (const row of COMMANDS) {
      const hit = slash.resolve('/' + row.command);
      const regAliases = (hit && hit.command.name === row.command) ? (hit.command.aliases || []) : [];
      for (const a of regAliases) {
        const p = parseCommand('/' + a + ' x');
        A.eq(p && p.cmd, row.command, 'registry alias /' + a + ' parses to the hub command /' + row.command);
      }
      for (const a of (row.aliases || [])) {
        const r = slash.resolve('/' + a);
        A.ok(r && r.command.name === row.command, 'hub alias /' + a + ' is the registry\'s own alias of /' + row.command);
      }
    }
    A.eq(parseCommand('/routines@starnetbot list'), { cmd: 'routine', arg: 'list' }, '@suffix and argument survive the alias');
    A.eq(parseCommand('/reset'), { cmd: 'new', arg: '' }, '/reset is /new');
    // the note commands' table names exactly the registry's steer / queue / background and every alias of them
    const NOTE = require('../sidecar/channels/hub.js')._internals.NOTE_CMDS;
    for (const canon of ['steer', 'queue', 'background']) {
      const hit = slash.resolve('/' + canon);
      for (const t of [canon].concat((hit && hit.command.aliases) || [])) A.eq(NOTE[t], canon, 'the hub reads /' + t + ' as the registry\'s /' + canon);
    }
    for (const t of Object.keys(NOTE)) { const r = slash.resolve('/' + t); A.ok(r && r.command.name === NOTE[t], '/' + t + ' is the registry\'s own name for /' + NOTE[t]); }
  }

  // ---- 2. the owner's DM: aliases run their command, desktop built-ins answer from the registry — zero model runs ----
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/routines'));
    await t.hub.onInbound(msg('boss', '/buildaway'));
    await t.hub.onInbound(msg('boss', '/tasks'));
    await t.hub.onInbound(msg('boss', '/reset'));
    await t.hub.onInbound(msg('boss', '/version'));
    await t.hub.onInbound(msg('boss', '/v'));
    await t.hub.onInbound(msg('boss', '/debug now'));
    await t.hub.onInbound(msg('boss', '/retry'));
    A.eq(t.runs, [], 'no desktop command name became a paid model run: ' + JSON.stringify(t.runs));
    A.eq(t.slashCalls.slice(0, 2), ['/routine', '/away'], 'the aliases reach the registry under their canonical names');
    A.ok(/Ultron/.test(t.sends[2]), '/tasks lists the agents like /agents: ' + JSON.stringify(t.sends[2]));
    A.eq(t.cleared.length, 1, '/reset cleared this chat like /new');
    A.eq(t.slashCalls.slice(2), ['/version', '/v', '/debug now', '/retry'], 'desktop built-ins are handed to the registry as typed');
    A.eq(t.sends.slice(4), [DESKTOP_ONLY, DESKTOP_ONLY, DESKTOP_ONLY, DESKTOP_ONLY], 'and answered with the registry\'s desktop-only line');
  }

  // ---- 3. a non-owner in a group: the alias inherits the owner gate; a desktop command is refused for free ----
  {
    const t = build();
    await t.hub.onInbound(msg('guest', '/reset', 'group'));
    await t.hub.onInbound(msg('guest', '/version', 'group'));
    A.eq(t.runs, [], 'no model run');
    A.eq(t.cleared, [], '/reset from a non-owner clears nothing');
    A.eq(t.slashCalls, [], 'the registry is never asked on a non-owner\'s behalf');
    A.ok(/\/new is owner-only/.test(t.sends[0]) && /\/version is owner-only/.test(t.sends[1]), 'both refused as owner-only: ' + JSON.stringify(t.sends));
  }

  // ---- 4. what is NOT a registry built-in still reaches the agent untouched ----
  {
    const t = build();
    await t.hub.onInbound(msg('boss', '/summarize the meeting'));
    await t.hub.onInbound(msg('boss', '/tmp/build.log is huge'));
    A.eq(t.runs, ['/summarize the meeting', '/tmp/build.log is huge'], 'an unknown head and a path are ordinary messages');
  }

  // ---- 5. a hub built without the registry check keeps the old fall-through (other wire-ups, tests) ----
  {
    const t = build({ desktopCommand: undefined });
    await t.hub.onInbound(msg('boss', '/version'));
    A.eq(t.runs, ['/version'], 'no desktopCommand -> unchanged');
  }

  // ---- 6. THE NOTE COMMANDS (/steer, /queue /q, /background /bg /btw): the words after them are the owner's own, and
  //         this hub HAS a way to act on them — a follow-up joins the running task (the live steer), or starts one. They
  //         used to reach that path; the desktop-only refusal must never swallow the note. ----
  {
    let release, n = 0;
    const gate = new Promise(r => { release = r; });
    const steers = [];
    const t = build({
      runOnce: async (o) => {
        t.runs.push(o.messages[o.messages.length - 1].content);
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
        if (t.runs.length === 1) await gate;
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'done' });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' });
      },
      steerRun: async (runId, text) => { steers.push(text); return { ok: true }; },
      newId: () => 'n' + (++n)
    });
    const first = t.hub.onInbound(msg('boss', 'write me a poem'));
    await new Promise(r => setTimeout(r, 30));
    await t.hub.onInbound(msg('boss', '/steer make it about the sea'));
    await t.hub.onInbound(msg('boss', '/q also cover the costs'));
    await t.hub.onInbound(msg('boss', '/btw@starnetbot and the risks'));
    A.eq(steers, ['make it about the sea', 'also cover the costs', 'and the risks'], 'mid-run, each note joins the running task, command word stripped');
    A.ok(t.sends.length === 3 && t.sends.every(s => /^↪ Added to the task/.test(s)), 'and says so: ' + JSON.stringify(t.sends));
    A.eq(t.slashCalls, [], 'the registry is never asked: nothing answers "desktop app only"');
    release(); await first;
    A.eq(t.runs, ['write me a poem'], 'no note became a run of its own while the task was working');

    // idle: /steer has nothing to steer (the desktop's own rule — a note never mints a paid run); /q and /btw send it now
    const before = t.sends.length;
    await t.hub.onInbound(msg('boss', '/steer make it blue'));
    A.ok(/Nothing is running here to steer/.test(t.sends[before] || ''), 'idle /steer says so, for free: ' + JSON.stringify(t.sends[before]));
    A.eq(t.runs.length, 1, 'and runs nothing');
    await t.hub.onInbound(msg('boss', '/q check the weather'));
    await t.hub.onInbound(msg('boss', '/background summarize the meeting'));
    A.eq(t.runs.slice(1), ['check the weather', 'summarize the meeting'], 'idle /q and /background run the owner\'s words, never the command word');

    // no note at all: a messenger-true line, never "only works in the desktop app"
    const at = t.sends.length;
    await t.hub.onInbound(msg('boss', '/steer'));
    await t.hub.onInbound(msg('boss', '/q'));
    A.ok(/\/steer needs your note after it/.test(t.sends[at] || '') && /\/q needs your note after it/.test(t.sends[at + 1] || ''), 'bare note commands explain themselves: ' + JSON.stringify(t.sends.slice(at)));
    A.ok(t.sends.slice(at).every(s => s !== DESKTOP_ONLY), 'never the desktop-only refusal');
    A.eq(t.slashCalls, [], 'still no registry call');
  }

  // ---- 7. every production hub that has the registry also has the check (source pin; index.js is never required) ----
  {
    const idx = readSidecarSource();
    const runSlashSites = (idx.match(/runSlash: \(input, sctx\) => runSlashForChannel\(input, sctx\)/g) || []).length;
    const deskSites = (idx.match(/desktopCommand: isDesktopSlashCommand/g) || []).length;
    A.ok(runSlashSites >= 5, 'found the hub wire-ups (' + runSlashSites + ')');
    A.eq(deskSites, runSlashSites, 'each runSlash wire-up passes desktopCommand');
    A.ok(/function isDesktopSlashCommand\(token\) \{\s*try \{ return !!slash\.resolve\(/.test(idx), 'the check reads the BUILT-IN table only (slash.resolve), never skills or recipes');
  }

  A.report('channels.desktop-commands');
})().catch(e => { console.error(e); process.exit(1); });
