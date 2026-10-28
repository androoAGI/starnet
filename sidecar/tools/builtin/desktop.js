/* sidecar/tools/builtin/desktop.js - open-on-the-user's-real-screen tool.

   desktop.open is the legacy implementation that can surface a VISIBLE window on the user's
   actual screen: it hands a URL (or an app name) to the OS default handler
   (Windows Start-Process, macOS `open`, Linux `xdg-open`) so the human SEES it.
   This is deliberately distinct from browser.* — that family drives a HEADLESS
   Chromium the user cannot see. It is for when the user wants to SEE a window
   ("show me", "open it on my screen") — never a step in completing a task the
   agent has quieter tools for (dedicated service tools, browser.*, shell.exec). It is not
   granted by any ordinary capability/run; a future attended host channel may reuse it.

   SECURITY:
   - URLs reuse browser.js assertSafeUrl (http(s) only; private/loopback/intranet
     refused) so this can't be used to reach the user's LAN or localhost services.
   - App launches are limited to a bare program name (a single token: letters,
     digits, dot, dash, underscore) — no path separators, no arguments, no shell
     metacharacters — and are handed to the opener as a discrete argv token, never
     interpolated into a shell string. That keeps "open notepad" working while
     making "open <arbitrary command line>" impossible.

   makeDesktopTools({ opener?, assertSafeUrl?, platform? }) -> { tools, register, _internals }
     opener({ kind:'url'|'app', target }) -> Promise<string>   (injected in tests)
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).desktop = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CP = require('../../child-env.js').guardChildProcess(require('node:child_process'));   // no station secrets in the launched app's env
  const browser = require('./browser.js');
  const defaultAssertSafeUrl = browser._internals.assertSafeUrl;

  // A launchable app name: one token, no path/args/shell metacharacters. This is
  // NOT a path — the OS resolves it against PATH / registered app names.
  const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  // Anything that looks like a URL should go through the URL path, not the app path.
  const LOOKS_URLISH = /:\/\/|^[a-z][a-z0-9+.-]*:/i;

  function classify(target) {
    const t = String(target == null ? '' : target).trim();
    if (!t) throw new Error('desktop.open needs a url or app name');
    // Bare host like "youtube.com" or "www.youtube.com" -> assume https.
    const looksHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(t) && !/\s/.test(t);
    if (LOOKS_URLISH.test(t) || looksHost) {
      const withScheme = LOOKS_URLISH.test(t) ? t : 'https://' + t;
      return { kind: 'url', target: withScheme };
    }
    if (APP_NAME_RE.test(t)) return { kind: 'app', target: t };
    throw new Error('desktop.open: not a valid url or a bare app name: ' + t);
  }

  function makeShellOpener(deps) {
    deps = deps || {};
    const platform = deps.platform || process.platform;
    const timeoutMs = deps.timeoutMs || 15000;
    // ASYNC by default: an OS "open" hands off to the default handler and returns fast, but a wedged handler
    // could block the whole sidecar event loop for the full timeout under the old spawnSync. execFile runs it
    // off-thread so /api/health and every other run stay responsive. A test may still inject a SYNCHRONOUS
    // spawnSync stub (deps.spawnSync) — we adapt its {status,stdout,stderr,error} return into the same async
    // result so the injected-opener contract is unchanged.
    const spawnSyncStub = deps.spawnSync;
    function runViaSpawnSync(cmd, args) {
      const res = spawnSyncStub(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      if (res && res.error) throw res.error;
      if (res && res.status != null && res.status !== 0) {
        throw new Error((res.stderr || res.stdout || (cmd + ' exited ' + res.status)).toString().trim());
      }
      return 'launched';
    }
    // Windows: the opener runs outside the station's job (sidecar/breakaway.js), so the window it opens for the person
    // is theirs — closing or crashing StarNet never closes it. A pass-through everywhere else.
    const breakaway = deps.breakaway || require('../../breakaway.js').makeBreakaway({ platform });
    const execFile = typeof deps.execFile === 'function' ? deps.execFile : CP.execFile.bind(CP);
    function runViaExecFile(cmd, args) {
      return new Promise((resolve, reject) => {
        const w = breakaway.wrap(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
        execFile(w.file, w.args, w.options, (err, stdout, stderr) => {
          if (err) {
            // execFile surfaces a non-zero exit / spawn failure / timeout as err; mirror the old error text shape.
            return reject(new Error((stderr || stdout || (err && err.message) || (cmd + ' failed')).toString().trim()));
          }
          resolve('launched');
        });
      });
    }
    const run = spawnSyncStub ? (cmd, args) => Promise.resolve().then(() => runViaSpawnSync(cmd, args)) : runViaExecFile;
    return async ({ kind, target }) => {
      if (platform === 'win32') {
        // Start-Process resolves both URLs (default browser) and app names (PATH /
        // App Paths). target is passed as a discrete argv token via -ArgumentList-free
        // form; PowerShell receives it as the -FilePath value, not a shell string.
        const psExe = process.env.SystemRoot
          ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
          : 'powershell.exe';
        // Single-quote-escape for the literal PowerShell string; target is already
        // validated (safe URL or bare app name) so this is defense in depth.
        const lit = "'" + String(target).replace(/'/g, "''") + "'";
        return run(psExe, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath ' + lit]);
      }
      if (platform === 'darwin') {
        return kind === 'app' ? run('open', ['-a', target]) : run('open', [target]);
      }
      // linux / other posix
      if (kind === 'app') return run(target, []);
      return run('xdg-open', [target]);
    };
  }

  function makeDesktopTools(deps) {
    deps = deps || {};
    const assertSafeUrl = deps.assertSafeUrl || defaultAssertSafeUrl;
    const opener = deps.opener || makeShellOpener(deps);

    async function open(target, ctx) {
      const c = classify(target);
      if (c.kind === 'url') {
        if (!(ctx && ctx.unrestrictedHost === true)) {
          const u = assertSafeUrl(c.target);   // restricted modes refuse private/loopback/intranet targets
          c.target = u.href;
        }
      }
      const result = await opener(c);
      return { kind: c.kind, target: c.target, result: result || 'launched' };
    }

    function remoteDesktopAllowed(ctx) {
      ctx = ctx || {};
      if (deps.allowRemoteDesktop !== true) return false;
      if (ctx.unrestrictedHost === true && ctx.inputMode === 'full-power') return true;
      return ctx.remoteDesktopAuthorized === true && ctx.ownerTrusted === true
        && ctx.surface === 'interactive' && ctx.inputMode === 'remote-owner';
    }

    const openTool = {
      name: 'desktop.open',
      // Separate danger class: a cached web click/type grant must never authorize a real
      // OS window. Ordinary runOnce flows strip this tool entirely in inputpolicy.js.
      capability: 'visible-desktop',
      impact: 'visible-desktop',
      scope: 'execute',
      requiresConsent: true,
      timeoutMs: 20000,
      description: 'Open a URL or a desktop app in a VISIBLE window on the USER\'S REAL SCREEN (OS default handler). Use ONLY when the user explicitly wants to SEE it themselves ("show me", "open it on my screen") — NEVER as a step in completing a task: to read or automate the web use the headless browser tools, and to control an installed app prefer its dedicated tools or a quiet shell path (app URI schemes, CLI) first. Only public http(s) URLs (private/loopback/intranet refused) or a bare app name (e.g. "notepad"); no paths, arguments, or shell commands.',
      schema: {
        type: 'object',
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'A public http(s) URL (or bare host like youtube.com), or a bare app name like "notepad".' }
        }
      },
      run: async (args, ctx) => {
        if (!remoteDesktopAllowed(ctx)) throw new Error('visible desktop launch is disabled: Full Power or an authenticated remote-owner desktop lease is required');
        const out = await open(args && args.target, ctx);
        return { content: 'desktop.open ok: ' + out.target, summary: 'opened ' + out.target };
      }
    };

    const tools = [openTool];
    return {
      tools,
      register(reg) { tools.forEach(t => reg.register(t)); return reg; },
      _internals: { classify, makeShellOpener, open, remoteDesktopAllowed, APP_NAME_RE }
    };
  }

  return { makeDesktopTools, _internals: { classify, makeShellOpener, APP_NAME_RE } };
});
