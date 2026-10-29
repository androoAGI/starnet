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
    const badReal = hostPathForms(WS, { realpath: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }, env: {} });
    A.eq(badReal, [WS, '/c/Users/andro/AppData/Roaming/StarNet/workspaces', '/mnt/c/Users/andro/AppData/Roaming/StarNet/workspaces', '/cygdrive/c/Users/andro/AppData/Roaming/StarNet/workspaces',
      '//localhost/c:/Users/andro/AppData/Roaming/StarNet/workspaces', '//127.0.0.1/c:/Users/andro/AppData/Roaming/StarNet/workspaces'], 'hostPathForms: a realpath that throws still returns the root\'s spellings');
  }

  // ---- 1b. LINEAR TIME (review round 4, MAJOR-1; scratchpad rr4-redos.js, rr4-redos-big.js) ----
  // The /c/, /mnt/c/ and /cygdrive/c/ forms start with a separator run, so on a long run of separators every start
  // inside it re-scanned the rest of it: 64,000 '/' blocked the event loop for 17 s through hub.deliver, and again on
  // every outbox retry. Built as index.js builds it: the root fixed, its spellings live.
  const built = makeHostPathScrub({ fixed: [WS], prefixes: () => hostPathForms(WS, { realpath: (p) => p }) });
  {
    const timed = (t) => { const t0 = process.hrtime.bigint(); const out = built(t); return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };
    built('warm the pattern up');
    for (const [label, unit] of [['/', '/'], ['\\', '\\'], ['%2F', '%2F']]) {
      const t = unit.repeat(64000);
      const r = timed(t);
      A.ok(r.ms < 50, 'scrub(' + JSON.stringify(label) + ' x 64,000) runs in linear time: ' + r.ms.toFixed(1) + ' ms (was: 17 s for the slashes)');
      A.eq(r.out, t, 'scrub(' + JSON.stringify(label) + ' x 64,000) names nothing and changes nothing');
    }
    // the bypass samples come out exactly as before the lookbehind (rr4-redos-fix.js), and so do the separator-led forms
    for (const [label, text] of bypass) A.eq(built(text), scrub(text), 'linear-time pattern, same answer: ' + label);
    for (const [text, want] of [
      ['/c/Users/andro/AppData/Roaming/StarNet/workspaces/alpha', '[workspace]/alpha'],
      ['//c/Users/andro/AppData/Roaming/StarNet/workspaces/a', '[workspace]/a'],
      ['x//c/Users/andro/AppData/Roaming/StarNet/workspaces//alpha', 'x[workspace]//alpha'],
      ['/mnt/c/Users/andro/AppData/Roaming/StarNet/workspaces/', '[workspace]/'],
      ['file:///C:/Users/andro/AppData/Roaming/StarNet/workspaces/a', 'file:///[workspace]/a'],
      ['C%3A%5CUsers%5Candro%5CAppData%5CRoaming%5CStarNet%5Cworkspaces%5Ca', '[workspace]%5Ca'],
      ['\\\\' + WS + '\\a', '\\\\[workspace]\\a'],
      // the separators after the root are no longer swallowed, so a second spelling right behind it is cut too
      [WS + '/c/Users/andro/AppData/Roaming/StarNet/workspaces/b', '[workspace][workspace]/b']
    ]) A.eq(built(text), want, 'separator-led and drive forms: ' + JSON.stringify(text));
    // the length guard: a text longer than the long-text bound is scrubbed in windows that overlap by the longest
    // spelling, so a path across a window's edge is still cut whole and another folder there is still left alone
    const small = makeHostPathScrub({ fixed: [WS], prefixes: () => hostPathForms(WS, { realpath: (p) => p }), longText: 1000, chunk: 300 });
    const rows = [WS + '\\alpha\\x.png', WS + '-old\\alpha', WS + '.bak', 'c%3a%5cusers%5candro%5cappdata%5croaming%5cstarnet%5cworkspaces%2fa', '/c/Users/andro/AppData/Roaming/StarNet/workspaces', WS + '/'.repeat(40) + 'c/Users/andro'];
    const differ = [];
    for (const row of rows) {
      for (let at = 200; at < 340; at++) {
        const t = 'y'.repeat(at) + row + ' and ' + row + '\n' + 'z'.repeat(1200);
        if (small(t) !== built(t)) differ.push(at + ': ' + row.slice(0, 30));
      }
    }
    A.eq(differ, [], 'windowed scrub = whole-text scrub for a path at every offset across a window edge');
    const long = ('done: ' + WS + '\\alpha\\x.png and ' + WS + '-old\\y\n').repeat(3000);
    A.ok(long.length > 200000, 'the long text is over the default bound (' + long.length + ' chars)');
    const lr = timed(long);
    A.eq(lr.out, ('done: [workspace]\\alpha\\x.png and ' + WS + '-old\\y\n').repeat(3000), 'a ' + long.length + '-char text is scrubbed whole, line for line');
    const slashes = timed('/'.repeat(300000));
    A.ok(slashes.ms < 250 && slashes.out.length === 300000, '300,000 slashes (over the bound): ' + slashes.ms.toFixed(1) + ' ms');
  }

  // ---- 1c. THE SPELLINGS A CHAT STILL RECEIVED (review round 4, minor-3; scratchpad rr4-scrub.js, rr4-scrub-locale.js) ----
  // Built as index.js builds it, over a fixed environment (hostPathForms reads process.env when none is given).
  {
    const env = { APPDATA: 'C:\\Users\\andro\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\andro\\AppData\\Local', USERPROFILE: 'C:\\Users\\andro',
      HOME: '/c/Users/andro', SystemDrive: 'C:', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\andro', COMPUTERNAME: 'DESKTOP-7Q2K', TEMP: 'C:\\Users\\andro\\AppData\\Local\\Temp',
      ProgramData: 'C:\\ProgramData', Path: 'C:\\Windows;C:\\Users\\andro\\AppData\\Roaming', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', '=C:': 'C:\\Users\\andro' };
    const sc = makeHostPathScrub({ fixed: [WS], prefixes: () => hostPathForms(WS, { realpath: (p) => p, env }), env });
    const segs = ['C:', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces'];
    const j = (...a) => a.join('\\');
    const rows = [];
    // the separators a localized Windows SHOWS for '\' (the yen sign on a Japanese code page, the won sign on a Korean
    // one, their fullwidth forms) and the look-alikes a model writes: every one of these was sent as written
    for (const sep of ['\u00A5', '\u20A9', '\uFFE5', '\uFFE6', '\uFF3C', '\uFF0F', '\u2216', '\u29F5', '\uFE68']) {
      rows.push(['separator U+' + sep.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'), 'ファイルは ' + segs.concat(['alpha', 'x.png']).join(sep) + ' に保存しました', 'ファイルは [workspace]' + sep + 'alpha' + sep + 'x.png に保存しました']);
    }
    rows.push(
      // the machine's own admin share, and the drive segment as ':' / '$' / '|' (written or encoded)
      ['admin share \\\\localhost\\c$', j('', '', 'localhost', 'c$', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'alpha', 'x.png'), '[workspace]\\alpha\\x.png'],
      ['admin share \\\\127.0.0.1\\C$', j('', '', '127.0.0.1', 'C$', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'alpha'), '[workspace]\\alpha'],
      ['admin share by the machine name', j('', '', 'desktop-7q2k', 'c$', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a'), '[workspace]\\a'],
      ['\\\\?\\UNC\\localhost\\c$', j('', '', '?', 'UNC', 'localhost', 'c$', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a'), '\\\\?\\UNC[workspace]\\a'],
      ['admin share, percent-encoded $', '%5C%5Clocalhost%5Cc%24%5CUsers%5Candro%5CAppData%5CRoaming%5CStarNet%5Cworkspaces%5Ca', '[workspace]%5Ca'],
      ['file:///C| (the legacy pipe)', 'file:///C|/Users/andro/AppData/Roaming/StarNet/workspaces/a', 'file:///[workspace]/a'],
      ['file:///C%7C', 'file:///C%7C/Users/andro/AppData/Roaming/StarNet/workspaces/a', 'file:///[workspace]/a'],
      ['file:///%43: (an encoded drive letter)', 'file:///%43:/Users/andro/AppData/Roaming/StarNet/workspaces/a', 'file:///[workspace]/a'],
      // the environment-variable and tilde forms of the variables that really prefix the root
      ['%APPDATA%', j('%APPDATA%', 'StarNet', 'workspaces', 'alpha', 'x.png'), '[workspace]\\alpha\\x.png'],
      ['$env:APPDATA', j('$env:APPDATA', 'StarNet', 'workspaces', 'alpha'), '[workspace]\\alpha'],
      ['${env:APPDATA}', j('${env:APPDATA}', 'StarNet', 'workspaces'), '[workspace]'],
      ['$APPDATA (a POSIX shell)', '$APPDATA/StarNet/workspaces/alpha', '[workspace]/alpha'],
      ['%USERPROFILE%', j('%USERPROFILE%', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a'), '[workspace]\\a'],
      ['%userprofile% in lower case', j('%userprofile%', 'appdata', 'roaming', 'starnet', 'workspaces', 'a'), '[workspace]\\a'],
      ['$HOME (Git Bash: /c/Users/andro)', '$HOME/AppData/Roaming/StarNet/workspaces/alpha', '[workspace]/alpha'],
      ['%HOMEDRIVE%%HOMEPATH%', j('%HOMEDRIVE%%HOMEPATH%', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a'), '[workspace]\\a'],
      ['%HOMEPATH% (drive-relative)', j('%HOMEPATH%', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a'), '[workspace]\\a'],
      ['%SystemDrive%', j('%SystemDrive%', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a'), '[workspace]\\a'],
      ['~/ (the home folder)', 'Saved under ~/AppData/Roaming/StarNet/workspaces/alpha/x.png', 'Saved under [workspace]/alpha/x.png'],
      ['~\\ (the home folder)', j('~', 'AppData', 'Roaming', 'StarNet', 'workspaces'), '[workspace]']
    );
    for (const [label, text, want] of rows) {
      const got = sc(text);
      A.eq(got, want, 'minor-3 spelling: ' + label);
      A.eq(sc(got), got, 'minor-3 spelling: ' + label + ' is idempotent');
    }
    // only the variables that really prefix the root become spellings
    const forms = hostPathForms(WS, { env });
    A.ok(forms.indexOf('%APPDATA%/StarNet/workspaces') >= 0 && forms.indexOf('~/AppData/Roaming/StarNet/workspaces') >= 0 && forms.indexOf('//localhost/c:/Users/andro/AppData/Roaming/StarNet/workspaces') >= 0, 'hostPathForms: the env, tilde and admin-share forms (' + forms.length + ')');
    A.ok(!forms.some(f => /LOCALAPPDATA|TEMP|ProgramData|ProgramFiles|=C|[%:{$]Path[%}/]/.test(f)), 'hostPathForms: no form from a variable that does not prefix the root (' + forms.filter(f => /LOCALAPPDATA|TEMP|ProgramData|ProgramFiles|=C|[%:{$]Path[%}/]/.test(f)).join(' | ') + ')');
    A.eq(hostPathForms(WS, { env: {} }).filter(f => /[%$~]/.test(f)), [], 'hostPathForms with an empty environment: no env forms');
    // the round-3 legitimate content is left alone by every new form, and so is prose with the new separator characters
    for (const [label, text] of [
      ['another folder beside it', 'Backup in ' + WS + '-old\\alpha\\x'],
      ['another folder with an extension', 'Backup in ' + WS + '.bak\\alpha\\x'],
      ['a longer folder name', 'in ' + WS + 'X\\alpha'],
      ['a project path', 'Wrote C:\\Users\\andro\\code\\proj\\report.md'],
      ['plain prose', 'nothing to see here'],
      ['npm workspaces in code', '```json\n{ "workspaces": ["packages/*"] }\n```'],
      ['a URL with workspaces', 'https://github.com/org/repo/tree/main/workspaces/alpha and https://app.slack.com/workspaces'],
      ['yarn workspaces', 'run `yarn workspaces foreach run build`'],
      ['a relative path', 'see workspaces/alpha/x.png'],
      ['another user', j('C:', 'Users', 'bob', 'AppData', 'Roaming', 'StarNet', 'workspaces', 'a')],
      ['another variable', j('%LOCALAPPDATA%', 'StarNet', 'workspaces', 'alpha') + ' and ~/AppData/Local/StarNet/workspaces'],
      ['another share', j('', '', 'localhost', 'd$', 'Users', 'andro', 'AppData', 'Roaming', 'StarNet', 'workspaces')],
      ['a price in yen and won', 'it costs ¥500 (₩6,000), and C:¥Users is a Japanese drive'],
      ['$env and tilde prose', 'set $env:Path, then cd ~/projects and run it; 50% of %USERPROFILE% users']
    ]) A.eq(sc(text), text, 'minor-3 forms leave alone: ' + label);
    // MAJOR-1 holds for every new form: a long run of any new separator or form lead stays linear
    sc('warm');
    for (const unit of ['\uFF3C', '\u00A5', '%5C', '%', '$', '~', '~/', '\\\\localhost', 'c$\\', '%APPDATA%\\']) {
      const t = unit.repeat(Math.ceil(64000 / unit.length));
      const t0 = process.hrtime.bigint(); const out = sc(t); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      A.ok(ms < 50 && out === t, 'linear with the new forms: ' + JSON.stringify(unit) + ' x ' + Math.ceil(64000 / unit.length) + ' in ' + ms.toFixed(1) + ' ms');
    }
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
    // MAJOR-1 through the hub (rr4-redos-big.js): a 96,000-slash divider in a reply blocked the event loop for minutes
    const sent = [];
    const hub = hubWith({ scrubOutbound: built }, sent);
    const t0 = process.hrtime.bigint();
    await hub._internals.deliver('chat1', 'Here is the divider you asked for:\n' + '/'.repeat(96000) + '\nDone.', 'r-div', 'done');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    A.ok(ms < 1000 && sent.length >= 2, 'hub deliver of a 96,000-slash reply: ' + ms.toFixed(0) + ' ms, ' + sent.length + ' chunks');
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
  {
    // minor-4 (review round 4, scratchpad rr4-scrub.js): the guard missed the text that is not the message body. An
    // inline keyboard's labels (send and edit), an album's captions, the bot's status line and a file's name all reached
    // the wire as written. The fake fetch records every Bot API call, multipart bodies included.
    const calls = [];
    const fetch = async (url, init) => {
      let body = init && init.body;
      if (body && typeof body !== 'string') body = Buffer.isBuffer(body) ? body.toString('latin1') : String(body);
      calls.push({ method: String(url).split('/').pop(), body: String(body || '') });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    };
    const tg = makeTelegramAdapter({ fetch, token: '1:abc', apiBase: 'http://x', clock: { now: () => 0 } });
    guardOutbound(tg, scrub);
    const P = WS + '\\alpha\\x.png';
    const kb = () => ({ reply_markup: { inline_keyboard: [[{ text: '1. ' + P, callback_data: 'c:1' }], [{ text: 'open', url: 'file:///' + P.replace(/\\/g, '/') }]] } });
    const asked = kb();
    const wire = (s) => { try { return decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')); } catch (e) { return s; } };
    const probes = [
      ['send: an inline keyboard label', () => tg.send('1', 'pick one', asked)],
      ['editMessage: an inline keyboard label', () => tg.editMessage('1', '7', 'pick', kb())],
      ['editMessage: a keyboard sent as a JSON string', () => tg.editMessage('1', '7', 'pick', { reply_markup: JSON.stringify(kb().reply_markup) })],
      ['sendMedia: the caption', () => tg.sendMedia('1', { kind: 'document', buffer: Buffer.from('x'), filename: 'x.txt', caption: 'saved ' + P })],
      ['sendMedia: the file name', () => tg.sendMedia('1', { kind: 'document', buffer: Buffer.from('x'), filename: 'C%3A%5CUsers%5Candro%5CAppData%5CRoaming%5CStarNet%5Cworkspaces%5Cx.txt', caption: '' })],
      ['sendMedia: a keyboard under the file', () => tg.sendMedia('1', { kind: 'document', buffer: Buffer.from('x'), filename: 'x.txt' }, kb())],
      ['sendMediaGroup: the captions and file names', () => tg.sendMediaGroup('1', [{ kind: 'photo', buffer: Buffer.from('x'), filename: 'a.png', caption: 'saved ' + P }, { kind: 'photo', buffer: Buffer.from('y'), filename: WS + '\\b.png' }])],
      ['setShortDescription: the bot\'s status line', () => tg.setShortDescription('status ' + P)]
    ];
    for (const [label, f] of probes) {
      calls.length = 0;
      await f();
      const all = calls.map(c => c.body).join(' | ');
      A.ok(calls.length >= 1 && !leaks(all) && !leaks(wire(all)), 'telegram ' + label + ' reaches the wire scrubbed (' + (calls.map(c => c.method).join(',') || 'no call') + ': ' + all.slice(0, 160) + ')');
    }
    A.ok(JSON.stringify(asked).indexOf(WS.replace(/\\/g, '\\\\')) >= 0, 'the caller\'s keyboard object is copied, never rewritten in place');
    calls.length = 0;
    await tg.send('1', 'pick one', { reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'ok:1' }]] } });
    A.ok(/"callback_data":"ok:1"/.test(wire(calls[0].body)) && /Approve/.test(calls[0].body), 'a keyboard that names no host path goes as it was');
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
