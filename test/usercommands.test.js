/* node test/usercommands.test.js — Commander-defined slash commands (alias + exec).

   The safety story these guard: one malformed entry must not wipe out every command the Commander defined,
   a user command must never be able to shadow a builtin, and an alias loop must not hang the dispatcher. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeUserCommands } = require('../sidecar/usercommands.js');
const S = require('../sidecar/slash.js');

const fakeFs = (obj) => ({
  existsSync: () => obj !== undefined,
  readFileSync: () => (typeof obj === 'string' ? obj : JSON.stringify(obj))
});
const store = (obj, warns) => makeUserCommands({ fs: fakeFs(obj), file: 'x.json', onWarn: w => (warns || []).push(w) });

{
  const u = store({ commands: [
    { name: 'standup', type: 'alias', target: 'routine list', desc: 'my morning check' },
    { name: 'disk', type: 'exec', command: 'df -h' }
  ] });
  const list = u.load();
  A.eq(list.length, 2, 'both well-formed commands load');
  A.eq(list[0].target, '/routine list', 'an alias target is normalized to a leading slash');
  A.eq(list[1].type, 'exec', 'an exec command keeps its type');
}

{
  // ONE bad entry must not take the good ones with it — a typo should cost you that command, not all of them.
  const warns = [];
  const u = store({ commands: [
    { name: 'good', type: 'alias', target: '/status' },
    { name: 'BAD NAME', type: 'alias', target: '/status' },
    { name: 'notype', target: '/status' },
    { name: 'noTarget', type: 'alias' },
    { name: 'nocmd', type: 'exec' },
    { name: 'good', type: 'alias', target: '/help' },
    { name: 'alsogood', type: 'exec', command: 'echo hi' }
  ] }, warns);
  const list = u.load();
  A.eq(list.map(c => c.name), ['good', 'alsogood'], 'only the valid entries survive');
  A.ok(warns.some(w => /bad name/.test(w)), 'an illegal name is reported');
  A.ok(warns.some(w => /unsupported type/.test(w)), 'a missing/unknown type is reported');
  A.ok(warns.some(w => /no target/.test(w)), 'an alias with no target is reported');
  A.ok(warns.some(w => /no command/.test(w)), 'an exec with no command is reported');
  A.ok(warns.some(w => /duplicate/.test(w)), 'a duplicate name is reported');
}

{
  const warns = [];
  A.eq(store(undefined, warns).load(), [], 'a missing file yields no commands and no crash');
  A.eq(store('{not json', warns).load(), [], 'a corrupt file yields no commands');
  A.ok(warns.some(w => /unreadable/.test(w)), 'a corrupt file is reported, not silently empty');
}

{
  const many = { commands: [] };
  for (let i = 0; i < 150; i++) many.commands.push({ name: 'c' + i, type: 'alias', target: '/status' });
  const warns = [];
  A.eq(store(many, warns).load().length, 100, 'the command count is capped');
  A.ok(warns.some(w => /cap/.test(w)), 'the cap is reported rather than silently truncating');
}

/* ---- registry integration ---- */
const entriesOf = (defs) => { const u = store({ commands: defs }); return u.catalogEntries(u.load()); };

{
  const opts = { userCommands: entriesOf([{ name: 'standup', type: 'alias', target: '/routine list' }]) };
  const cat = S.catalog(opts);
  const mine = cat.commands.filter(c => c.source === 'user');
  A.eq(mine.map(c => c.name), ['standup'], 'a user command appears in the catalog');
  A.eq(mine[0].category, 'Yours', 'user commands get their own category');
  // an alias re-resolves THROUGH the registry, so it inherits every guard the real command has
  const d = S.dispatch('/standup', opts).directive;
  A.eq(d, { type: 'server', action: 'routine', args: 'list' }, 'an alias resolves to the real command it targets');
  A.eq(S.dispatch('/standup extra', opts).directive.args, 'list extra', 'user args append to the alias target');
}

{
  // A user command must NEVER shadow a builtin — /help has to keep working.
  const opts = { userCommands: entriesOf([{ name: 'help', type: 'exec', command: 'rm -rf /' }]) };
  const cat = S.catalog(opts);
  A.eq(cat.commands.filter(c => c.source === 'user').length, 0, 'a user command cannot claim a builtin name');
  A.eq(S.dispatch('/help', opts).directive.action, 'help', '/help still runs the builtin');
}

{
  // an alias loop must be caught, not hang the dispatcher
  const opts = { userCommands: entriesOf([
    { name: 'a', type: 'alias', target: '/b' },
    { name: 'b', type: 'alias', target: '/a' }
  ]) };
  const r = S.dispatch('/a', opts);
  A.eq(r.ok, false, 'an alias loop is refused');
  A.ok(/too deep|loop/.test(r.error), 'the refusal names the loop');
}

{
  // exec stays PURE in the registry — it reports WHAT to run and lets the caller decide whether it may
  const opts = { userCommands: entriesOf([{ name: 'disk', type: 'exec', command: 'df -h' }]) };
  const d = S.dispatch('/disk now', opts).directive;
  A.eq(d.type, 'exec', 'an exec command yields an exec directive');
  A.eq(d.command, 'df -h', 'the directive carries the snippet verbatim');
  A.eq(d.args, 'now', 'user args ride along');
}

/* ---- wiring pins: the two places a command routine must be redirected, and the exec safety posture ---- 
   (source-level, because both live in sidecar/index.js's request/driver plumbing) */
{
  const idx = readSidecarSource();
  A.ok(idx.indexOf('function runSlashRoutine') >= 0, 'a scheduled slash command has its own runner');
  // BOTH fire paths must redirect, or the same routine behaves differently depending on who started it:
  // the cron driver's runOnce wrapper AND handleCronRun ("Run Now"), plus the definition itself.
  const hits = (idx.match(/runSlashRoutine/g) || []).length;
  A.ok(hits >= 3, 'both the driver wrapper and Run Now redirect to it (found ' + hits + ' references)');
  A.ok(idx.indexOf('turns: 0, usd: 0') >= 0, 'a command routine reports zero turns and zero spend');
  A.ok(idx.indexOf('EXEC_ENV_DENY_RE') >= 0, 'exec commands get a sanitized environment');
  // the refusal's WORDING moved to usercommands.execRefusal (2026-10-18: worded per chat, and no longer claiming
  // "desktop only" while the owner DM ran them); the gate itself is unchanged and still pinned here
  A.ok(/if \(!ctx\.ownerTrusted\) return \{ ok: false, text: userExecRefusal\(/.test(idx),
    'shell commands remain refused to ordinary messaging callers — only a host-admitted Telegram owner DM bypasses it');
  {
    const { execRefusal } = require('../sidecar/usercommands.js');
    A.ok(/never run in a group/.test(execRefusal('disk', { chatType: 'group', ownerDmExec: true })), 'a group refusal says groups never run them');
    A.ok(/desktop app/.test(execRefusal('disk', { chatType: 'dm', ownerDmExec: false })), 'a DM on a channel without owner trust points to the desktop app');
  }
  A.ok(/if \(out\.directive\.type === 'exec'\) \{\s*if \(!ctx\.ownerTrusted\)[\s\S]*return runUserExec\(out\.directive\);/.test(idx),
    'the admitted owner executes the exact desktop user-command path');
  A.ok(idx.indexOf('USER_COMMANDS_FILE') >= 0 && idx.indexOf("path.join(WORKSPACES, 'usercommands.json')") >= 0,
    'user commands live in the WORKSPACES root, OUTSIDE any agent fs jail (the whole safety argument for exec)');
}

A.report('usercommands.test');
