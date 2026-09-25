/* sidecar/tools/builtin/shell.js — the WORKBENCH capability: shell.exec, run a command in the agent's workspace.

   This is the harness's real code-execution capability (execution-spine Commit 3) — the single most dangerous
   tool, so it ships behind every safety control at once:
     - CAPABILITY-GATED: appears only when a "workbench" object is placed in the agent's room (CAP_REGISTRY).
     - CONSENT-GATED (scope 'execute', requiresConsent): walks the existing ladder. Interactive prompts live;
       AUTONOMOUS (cron/headless) is denied by the broker's exec-lockout — un-pre-blessable, no "approve all".
     - AUTO-CHECKPOINT: the host snapshots the workspace BEFORE dispatching a shell call (index.js dispatch hook,
       unconditional for shell.*), so any command is one rollback away.
     - cwd PINNED to the per-agent fs jail; a best-effort floor refuses obvious workspace escapes.
     - Its OWN timeout + abort that KILL the child tree (the registry's withTimeout only rejects, never kills),
       and a hard output cap + secret redaction before stdout reaches the model/bus.

   `runCommand` (the spawn → capture → timeout/abort-kill core) is exported so verify.run reuses it verbatim —
   one battle-tested execution primitive, not two. Every ambient dependency is INJECTED (spawn, fs, path, redact,
   clock) so it is headless-testable and determinism-clean (no Date.now / Math.random / new Date(); ms via clock).

   makeShellTool({ spawn, fs, pathMod, root, redact?, clock?, limits? }) -> { execTool, register(reg) } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).shell = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  function safeAgentId(id) { if (!AID_RE.test(id || '')) throw new Error('bad agentId'); return id; }
  function clip(s, n) { s = String(s == null ? '' : s); n = n || 200; return s.length > n ? s.slice(0, n) + '…' : s; }
  function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); }
  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  function unrestrictedHost(ctx) {
    ctx = ctx || {};
    return ctx.unrestrictedHost === true ||
      (ctx.remoteDesktopAuthorized === true && ctx.ownerTrusted === true && ctx.inputMode === 'remote-owner');
  }

  /* best-effort blast wall (true confinement needs a container — a deferred backend). A command confined to its
     own workspace never needs to escape it, so refuse obvious filesystem escapes + references to the harness's
     own control siblings. Tuned NOT to trip on git range syntax (main..HEAD) — only `..` as a path segment. */
  function escapesWorkspace(cmd) {
    if (/(^|[\s"'`=(])\.\.([\\/]|$)/.test(cmd)) return 'parent-directory (..) paths are not allowed — commands run inside your own workspace';
    if (/(^|[\s"'`=(])[A-Za-z]:[\\/]/.test(cmd)) return 'drive-absolute paths (C:\\…) are not allowed — use paths inside your workspace';
    if (/(^|[\s"'`=(])\\\\[^\s\\]/.test(cmd)) return 'UNC paths (\\\\server) are not allowed';
    // Windows drive-ROOT-relative paths: a leading BACKSLASH with no drive letter (`type \Users\x`, `cd \`) resolves
    // to the root of the CURRENT drive — i.e. OUTSIDE the workspace, just like C:\. Block a single leading backslash
    // in path position that is NOT the start of a `\\server` UNC (that's caught above). We deliberately do NOT block
    // forward-slash-rooted forms: `/S`, `/c` etc. are overwhelmingly option flags (robocopy /S) and `/c/Users` is a
    // normalized cwd form, so there is no safe way to tell a root path from a flag — backslash-rooted only.
    if (/(^|[\s"'`=(])\\(?![\\])/.test(cmd)) return 'drive-root paths (\\…) are not allowed — use paths inside your workspace';
    if (/\.checkpoints|permissions\.allow|\.notebook\.json|channels[\\/]+secrets|codex[\\/]+tokens|ledger\.jsonl|cron\.jobs\.json/i.test(cmd)) return 'that path is a protected harness control file';
    return null;
  }

  /* BUILDS ARE INVISIBLE / THE MACHINE IS NOT THE WORKSPACE (mouse-confinement incident + follow-up, 2026-07-12,
     hardened after code-review 2026-07-12). Agent work must never put a window on the user's screen, touch their
     input, kill processes it doesn't own, install machine persistence, or rewrite machine config.

     ALTITUDE NOTE (honest): this is a denylist, and a denylist can never win an arms race against a determined
     prompt-injection (a renamed binary, a novel launcher). The DURABLE fix is OS containment — running shell.exec
     children under a restricted token / Win32 Job Object so `shutdown`/`reg`/`sc` fail regardless of spelling
     (tracked in docs/NEXT.md). What this floor MUST do well is catch the forms a NORMAL agent reaches for and the
     OBVIOUS injection forms — so instead of matching the raw string (which a newline, `Start-Process`, or
     `powershell -Command "…"` trivially defeats), we split the command into its COMMAND HEADS and test the verb
     at the start of each head. That closes the whole class of "dangerous verb hidden behind a launcher/separator"
     in one place. */

  // Every point where a NEW command begins: the whole string, plus after each separator (& | ; newline), cmd
  // /c|/k, cmd `call`, PowerShell `Start-Process [-FilePath]`, and an interpreter's -Command/-c STRING
  // (powershell/pwsh -Command "…", sh/bash -c "…"). The interpreter alternatives REQUIRE the interpreter name so
  // a bare `-c` compile/count flag (gcc -c, grep -c) is never a command boundary.
  const PS_COMMAND_FLAGS = new Set(['-c', '-co', '-com', '-comm', '-comma', '-comman', '-command']);
  const PS_ENCODED_FLAGS = new Set(['-e', '-ec', '-en', '-enc', '-enco', '-encod', '-encode', '-encoded',
    '-encodedc', '-encodedco', '-encodedcom', '-encodedcomm', '-encodedcomma', '-encodedcomman', '-encodedcommand']);
  const PS_CLI_OPTIONS = [
    ['psconsolefile', true, 'option'], ['version', true, 'option'], ['nologo', false, 'option'],
    ['noexit', false, 'option'], ['sta', false, 'option'], ['mta', false, 'option'],
    ['noprofile', false, 'option'], ['noninteractive', false, 'option'], ['inputformat', true, 'option'],
    ['outputformat', true, 'option'], ['windowstyle', true, 'option'], ['configurationname', true, 'option'],
    ['executionpolicy', true, 'option'], ['workingdirectory', true, 'option'],
    // -File makes the remaining argv script arguments, not an implicit command string.
    ['file', true, 'file'], ['help', false, 'help'], ['?', false, 'help']
  ].map(x => ({ name: x[0], takesValue: x[1], kind: x[2] }));
  function parsePowerShellFlag(value) {
    value = String(value == null ? '' : value);
    if (value[0] !== '-' && value[0] !== '/') return null;
    const body = value.slice(1);
    const splitAt = body.search(/[:=]/);
    const name = (splitAt >= 0 ? body.slice(0, splitAt) : body).toLowerCase();
    return { flag: '-' + name, name, hasInline: splitAt >= 0, inline: splitAt >= 0 ? body.slice(splitAt + 1) : '' };
  }
  function resolvePowerShellCliOption(parsed) {
    if (!parsed) return null;
    if (PS_COMMAND_FLAGS.has(parsed.flag)) return { name: parsed.name, takesValue: true, kind: 'command' };
    if (PS_ENCODED_FLAGS.has(parsed.flag)) return { name: parsed.name, takesValue: true, kind: 'encoded' };
    const exact = PS_CLI_OPTIONS.find(o => o.name === parsed.name);
    if (exact) return exact;
    const matches = PS_CLI_OPTIONS.filter(o => o.name.indexOf(parsed.name) === 0);
    return matches.length === 1 ? matches[0] : null;
  }

  // Split only on REAL shell separators. A launcher name inside `echo ...`, a commit message, or another quoted
  // argument is data, not a command boundary. This is intentionally a small lexer instead of a raw substring regex.
  function normalizeDialect(dialect) {
    return dialect === 'cmd' || dialect === 'powershell' || dialect === 'posix' ? dialect : (WIN ? 'cmd' : 'posix');
  }
  function isDialectQuote(ch, dialect) { return ch === '"' || (ch === "'" && dialect !== 'cmd'); }
  function isDialectEscape(ch, dialect, activeQuote, nextCh) {
    // cmd.exe: caret escapes metacharacters only outside double quotes; inside, it is ordinary data.
    if (dialect === 'cmd') return ch === '^' && activeQuote == null;
    // PowerShell: backtick escapes outside/double-quoted text, but is literal inside single-quoted text.
    if (dialect === 'powershell') return ch === '`' && activeQuote !== "'";
    if (dialect === 'posix' && ch === '\\') {
      if (activeQuote === "'") return false;   // everything is literal inside POSIX single quotes
      if (activeQuote === '"') return nextCh === '$' || nextCh === '`' || nextCh === '"' || nextCh === '\\' || nextCh === '\n';
      return true;
    }
    return false;
  }
  function splitCommandSegments(input, dialect) {
    const c = String(input == null ? '' : input);
    dialect = normalizeDialect(dialect);
    const out = [];
    let start = 0, quote = null;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (quote) {
        if (isDialectEscape(ch, dialect, quote, c[i + 1]) && i + 1 < c.length) { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (isDialectEscape(ch, dialect, null, c[i + 1]) && i + 1 < c.length) { i++; continue; }
      if (isDialectQuote(ch, dialect)) { quote = ch; continue; }
      if (ch === '&' || ch === '|' || ch === ';' || ch === '\r' || ch === '\n') {
        const part = c.slice(start, i).trim();
        if (part) out.push(part);
        while (i + 1 < c.length && /[&|;\r\n]/.test(c[i + 1])) i++;
        start = i + 1;
      }
    }
    const tail = c.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  function shellTokens(input, dialect) {
    const c = String(input == null ? '' : input);
    dialect = normalizeDialect(dialect);
    const out = [];
    let i = 0;
    while (i < c.length) {
      while (i < c.length && /\s/.test(c[i])) i++;
      if (i >= c.length) break;
      const start = i;
      let quote = null, value = '';
      while (i < c.length) {
        const ch = c[i];
        if (quote) {
          if (isDialectEscape(ch, dialect, quote, c[i + 1]) && i + 1 < c.length) { value += c[i + 1]; i += 2; continue; }
          if (ch === quote) { quote = null; i++; continue; }
          value += ch; i++; continue;
        }
        if (isDialectEscape(ch, dialect, null, c[i + 1]) && i + 1 < c.length) { value += c[i + 1]; i += 2; continue; }
        if (isDialectQuote(ch, dialect)) { quote = ch; i++; continue; }
        if (/\s/.test(ch)) break;
        value += ch; i++;
      }
      out.push({ value, raw: c.slice(start, i), start, end: i });
    }
    return out;
  }

  function exeName(value) {
    const bits = String(value == null ? '' : value).split(/[\\/]/);
    return (bits[bits.length - 1] || '').toLowerCase();
  }
  function afterToken(segment, token) { return String(segment).slice(token.end).trim(); }
  function unwrapCommandArg(raw, dialect) {
    raw = String(raw == null ? '' : raw).trim();
    dialect = normalizeDialect(dialect);
    if (raw.length >= 2 && isDialectQuote(raw[0], dialect) && raw[raw.length - 1] === raw[0]) return raw.slice(1, -1);
    return raw;
  }
  const START_PROCESS_OPTIONS = [
    ['argumentlist', true], ['credential', true], ['environment', true], ['filepath', true],
    ['loaduserprofile', false], ['nonewwindow', false], ['passthru', false],
    ['redirectstandarderror', true], ['redirectstandardinput', true], ['redirectstandardoutput', true],
    ['usenewenvironment', false], ['verb', true], ['wait', false], ['windowstyle', true], ['workingdirectory', true],
    // Common PowerShell parameters are valid between Start-Process and its positional FilePath too.
    ['confirm', false], ['debug', false], ['erroraction', true], ['errorvariable', true],
    ['informationaction', true], ['informationvariable', true], ['outbuffer', true], ['outvariable', true],
    ['pipelinevariable', true], ['progressaction', true], ['verbose', false], ['warningaction', true],
    ['warningvariable', true], ['whatif', false]
  ].map(x => ({ name: x[0], takesValue: x[1] }));
  function resolveStartProcessOption(value) {
    value = String(value == null ? '' : value).toLowerCase();
    if (value[0] !== '-') return null;
    const body = value.slice(1);
    const splitAt = body.search(/[:=]/);
    const name = splitAt >= 0 ? body.slice(0, splitAt) : body;
    const inline = splitAt >= 0 ? body.slice(splitAt + 1) : '';
    const decorate = (o) => o && Object.assign({}, o, { hasInline: splitAt >= 0, inline: inline });
    const exact = START_PROCESS_OPTIONS.find(o => o.name === name);
    if (exact) return decorate(exact);
    const matches = START_PROCESS_OPTIONS.filter(o => o.name.indexOf(name) === 0);
    if (matches.length === 1) return decorate(matches[0]);
    // The supported PowerShell generations expose slightly different common parameters. If a prefix is
    // unambiguous on the running host but ambiguous in this union, consuming a possible value is fail-closed:
    // we inspect the following positional executable too. A genuinely ambiguous host invocation does not run.
    if (matches.length > 1) return decorate({ name: '', takesValue: matches.some(o => o.takesValue) });
    return null;
  }
  function quoteCommandToken(value) {
    value = String(value == null ? '' : value);
    return /[\s&|;]/.test(value) ? '"' + value.replace(/"/g, '`"') + '"' : value;
  }
  function startProcessTarget(segment, tokens) {
    let target = -1;
    for (let i = 1; i < tokens.length; i++) {
      const opt = resolveStartProcessOption(tokens[i].value);
      if (opt && opt.name === 'filepath') {
        if (opt.hasInline) {
          if (!opt.inline) return '';
          const rest = afterToken(segment, tokens[i]);
          return quoteCommandToken(opt.inline) + (rest ? ' ' + rest : '');
        }
        target = i + 1; break;
      }
    }
    if (target < 0) {
      for (let i = 1; i < tokens.length; i++) {
        const v = String(tokens[i].value).toLowerCase();
        if (v[0] !== '-') { target = i; break; }
        const opt = resolveStartProcessOption(v);
        if (opt && opt.takesValue && !opt.hasInline) i++;
      }
    }
    if (target < 1 || target >= tokens.length) return '';
    const rest = afterToken(segment, tokens[target]);
    return tokens[target].raw + (rest ? ' ' + rest : '');
  }

  function parsePowerShellInvocation(segment, tokens) {
    for (let i = 1; i < tokens.length; i++) {
      const parsed = parsePowerShellFlag(tokens[i].value);
      if (!parsed) {
        // powershell.exe's default mode treats the first non-option token and everything after it as -Command.
        return { nested: unwrapCommandArg(String(segment).slice(tokens[i].start), 'powershell'), opaque: false };
      }
      const opt = resolvePowerShellCliOption(parsed);
      if (!opt) return { nested: '', opaque: false };   // unknown/ambiguous CLI option: PowerShell rejects it
      if (opt.kind === 'encoded') return { nested: '', opaque: true };
      if (opt.kind === 'command') {
        const rest = afterToken(segment, tokens[i]);
        const raw = parsed.hasInline ? parsed.inline + (rest ? ' ' + rest : '') : rest;
        return { nested: unwrapCommandArg(raw, 'powershell'), opaque: false };
      }
      if (opt.kind === 'file' || opt.kind === 'help') return { nested: '', opaque: false };
      if (opt.takesValue && !parsed.hasInline) i++;
    }
    return { nested: '', opaque: false };
  }

  function analyzeCommands(cmd, depth, dialect) {
    dialect = normalizeDialect(dialect);
    const result = { heads: [], opaquePowerShell: false };
    if ((depth || 0) > 8) return result;
    for (const segment of splitCommandSegments(cmd, dialect)) {
      const tokens = shellTokens(segment, dialect);
      if (!tokens.length) continue;
      result.heads.push({ text: segment, dialect: dialect });
      const verb = exeName(tokens[0].value);
      let nested = '', nestedDialect = dialect;
      if (verb === 'cmd' || verb === 'cmd.exe') {
        const i = tokens.findIndex((t, n) => n > 0 && /^\/[ck]$/i.test(t.value));
        if (i >= 0) { nestedDialect = 'cmd'; nested = unwrapCommandArg(afterToken(segment, tokens[i]), nestedDialect); }
      } else if (verb === 'call') {
        nestedDialect = 'cmd'; nested = afterToken(segment, tokens[0]);
      } else if (verb === 'start-process' || verb === 'saps') {
        nestedDialect = dialect === 'powershell' ? 'powershell' : dialect;
        nested = startProcessTarget(segment, tokens);
      } else if (verb === 'powershell' || verb === 'powershell.exe' || verb === 'pwsh' || verb === 'pwsh.exe') {
        const invocation = parsePowerShellInvocation(segment, tokens);
        nestedDialect = 'powershell'; nested = invocation.nested;
        if (invocation.opaque) result.opaquePowerShell = true;
      } else if (/^(?:sh|bash|zsh|dash|ksh)(?:\.exe)?$/.test(verb)) {
        const i = tokens.findIndex((t, n) => n > 0 && t.value === '-c');
        if (i >= 0) { nestedDialect = 'posix'; nested = unwrapCommandArg(afterToken(segment, tokens[i]), nestedDialect); }
      }
      if (nested) {
        const child = analyzeCommands(nested, (depth || 0) + 1, nestedDialect);
        result.heads.push.apply(result.heads, child.heads);
        if (child.opaquePowerShell) result.opaquePowerShell = true;
      }
    }
    return result;
  }

  function commandHeads(cmd, dialect) { return analyzeCommands(cmd, 0, dialect).heads; }
  function headTokens(head) { return shellTokens(head && head.text != null ? head.text : head, head && head.dialect); }
  function canonicalHead(head) {
    const tokens = headTokens(head);
    if (!tokens.length) return '';
    return [exeName(tokens[0].value)].concat(tokens.slice(1).map(t => t.value)).join(' ');
  }

  // --- visible-window / input-capture floor ---
  const BROWSER_NAMES = new Set(['msedge', 'msedge.exe', 'chrome', 'chrome.exe', 'chromium', 'chromium.exe',
    'chromium-browser', 'chromium-browser.exe', 'firefox', 'firefox.exe', 'brave', 'brave.exe', 'opera', 'opera.exe',
    'iexplore', 'iexplore.exe', 'safari', 'safari.exe']);
  function opensVisibleWindow(cmd, dialect) {
    dialect = normalizeDialect(dialect);
    const heads = commandHeads(cmd, dialect);
    if (heads.some(h => /^(?:start|start\.exe)$/.test(exeName((headTokens(h)[0] || {}).value)))) return 'cmd `start` opens a visible window on the user\'s screen';
    if (heads.some(h => /^(?:explorer|explorer\.exe)$/.test(exeName((headTokens(h)[0] || {}).value)))) return '`explorer` opens a visible window on the user\'s screen';
    if (heads.some(h => {
      const tokens = headTokens(h); return /^(?:rundll32|rundll32\.exe)$/.test(exeName((tokens[0] || {}).value)) && tokens.slice(1).some(t => /url\.dll/i.test(t.value));
    })) return 'rundll32 url.dll opens the user\'s default browser';
    if (dialect === 'posix' && heads.some(h => /^(?:open|xdg-open)$/.test(exeName((headTokens(h)[0] || {}).value)))) return '`open`/`xdg-open` opens a visible window on the user\'s screen';
    const browserHeads = heads.filter(h => BROWSER_NAMES.has(exeName((headTokens(h)[0] || {}).value)));
    for (const h of browserHeads) {
      const args = headTokens(h).slice(1).map(t => String(t.value).toLowerCase());
      // whole-token flag tests: `--headlessx` is NOT --headless (Chrome ignores it and opens a headed window)
      if (!args.some(v => /^--headless(?:=|$)/.test(v))) {
        return 'launching a browser without --headless opens a visible window (and a page can capture the user\'s mouse via pointer lock)';
      }
      // a headless browser still renders AUDIO to the user's speakers (the phantom-gunfire half of the incident)
      if (!args.some(v => v === '--mute-audio' || v.indexOf('--mute-audio=') === 0)) {
        return 'a headless browser still plays sound on the user\'s speakers — add --mute-audio';
      }
    }
    return null;
  }

  // A headless browser can still acquire native pointer/keyboard lock. Agent UI and
  // game verification therefore runs only through browser.test_* where those APIs are
  // emulated before navigation and input is dispatched synthetically over owned CDP.
  const INPUT_CAPTURE_RE = /requestPointerLock|webkitRequestPointerLock|PointerLockControls|\bcontrols\s*\.\s*lock\s*\(|keyboard\s*\.\s*lock\s*\(|requestFullscreen|webkitRequestFullscreen|mozRequestFullScreen|ClipCursor|SetCursorPos|SendInput|BlockInput|SetCapture|SetWindowsHookEx|RegisterHotKey|RegisterRawInputDevices|SetForegroundWindow|SwitchToThisWindow|AttachThreadInput|HWND_TOPMOST|SetSystemCursor|ChangeDisplaySettings|SetDisplayConfig|SetMonitorBrightness|LockWorkStation|ExitWindowsEx|InitiateSystemShutdown|CGEventPost|CGAssociateMouseAndMouseCursorPosition|XTestFake|XGrabPointer|XGrabKeyboard|XWarpPointer|SDL_SetRelativeMouseMode|GLFW_CURSOR_DISABLED/i;
  const BROWSER_AUTOMATION_RE = /\b(?:puppeteer(?:-core)?|playwright|selenium|webdriver|chromedriver|geckodriver|chrome-remote-interface)\b|webSocketDebuggerUrl|Input\.dispatch(?:Mouse|Key)|--remote-debugging-port\b/i;
  const NATIVE_INPUT_RE = /\b(?:SetCursorPos|mouse_event|SendInput|keybd_event|ClipCursor|BlockInput|SetCapture|SetWindowsHookEx|RegisterHotKey|RegisterRawInputDevices|SetForegroundWindow|SwitchToThisWindow|AttachThreadInput|SetWindowPos|SetSystemCursor|SendKeys(?:\.SendWait)?|pyautogui|pynput|robotjs|nut\.js|xdotool|ydotool|xte|evemu|uinput|CGEventPost|CGWarpMouseCursorPosition|XTestFake|XGrabPointer|XGrabKeyboard|XWarpPointer)\b|\/dev\/uinput/i;
  const USER_SESSION_RE = /\b(?:LockWorkStation|ExitWindowsEx|InitiateSystemShutdown|SetSuspendState|ChangeDisplaySettings|SetDisplayConfig|SetMonitorBrightness|WmiMonitorBrightnessMethods|SystemParametersInfo|SetClipboardData|OpenClipboard|Set-Clipboard|pbcopy|xclip|xsel|DisplaySwitch|xrandr|xinput|xset|chvt|loginctl|ddcutil|pactl|amixer|osascript)\b/i;
  const OPAQUE_LAUNCH_RE = /\b(?:Invoke-Expression|iex|Invoke-Command|DownloadString|FromBase64String|Reflection\.Assembly|ShellExecute|os\.startfile|Process\.Start)\b/i;
  const GUI_RUNTIME_RE = /\b(?:electron|nwjs|cargo\s+run|dotnet\s+run|java\s+-jar|rundll32|wscript|cscript|mshta|notepad|wordpad|mspaint|calc|write)\b/i;
  const LOCAL_PROGRAM_RE = /^(?:"|')?(?:(?:\.\\|\.\/)[^\s"']+|[^\s"']+\.exe)(?:"|'|\s|$)/i;
  const CODE_FILE_RE = /\.(?:[cm]?js|ts|tsx|jsx|ps1|py|rb|php|sh|bash|cmd|bat|rs|cs|c|cc|cpp)$/i;
  const SCAN_SKIP_RE = /^(?:node_modules|\.git|dist|build|coverage|\.cache|\.vite|target)$/i;

  function readSmall(fs, p, max) {
    if (!fs || !p) return '';
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > (max || (1 << 20))) return '';
      return String(fs.readFileSync(p, 'utf8') || '');
    } catch (_) { return ''; }
  }
  function unquoteToken(s) {
    s = String(s || '').trim();
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) return s.slice(1, -1);
    return s;
  }
  function commandSources(cmd, opts) {
    opts = opts || {};
    const fs = opts.fs, P = opts.pathMod, cwd = opts.cwd, dialect = opts.dialect;
    const queue = [{ text: String(cmd || ''), baseDir: cwd }], out = [], seen = new Set(), packageCache = new Map();
    function enqueue(text, baseDir) { if (text != null && String(text)) queue.push({ text: String(text), baseDir }); }
    function packageAt(baseDir) {
      const projectRoot = projectScanRoot(baseDir, fs, P);
      const key = String(projectRoot || '');
      if (packageCache.has(key)) return { root: projectRoot, scripts: packageCache.get(key) };
      let doc = {};
      try { doc = JSON.parse(readSmall(fs, P && projectRoot ? P.join(projectRoot, 'package.json') : '', 1 << 20) || '{}').scripts || {}; }
      catch (_) { doc = {}; }
      packageCache.set(key, doc);
      return { root: projectRoot, scripts: doc };
    }
    for (let qi = 0; qi < queue.length && qi < 30; qi++) {
      const entry = queue[qi] || {};
      const text = String(entry.text || ''), baseDir = entry.baseDir || cwd;
      const seenKey = String(baseDir || '') + '\0' + text;
      if (!text || seen.has(seenKey)) continue;
      seen.add(seenKey); out.push(text);
      for (const parsedHead of commandHeads(text, dialect)) {
        const head = (parsedHead && parsedHead.text != null ? parsedHead.text : String(parsedHead || '')).replace(/^\s*@/, '');
        let m = head.match(/^(?:npm|npm\.cmd)\s+(?:--[A-Za-z0-9_-]+(?:=[^\s]+)?\s+)*(?:run\s+)?([A-Za-z0-9:_-]+)\b/i);
        if (m) {
          const pkg = packageAt(baseDir);
          const name = /^(?:test|start|stop|restart)$/i.test(m[1]) ? m[1].toLowerCase() : m[1];
          enqueue(pkg.scripts['pre' + name], pkg.root);
          enqueue(pkg.scripts[name], pkg.root);
          enqueue(pkg.scripts['post' + name], pkg.root);
        }
        m = head.match(/^(?:pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/i);
        if (m) { const pkg = packageAt(baseDir); enqueue(pkg.scripts[m[1]], pkg.root); }

        const refs = [];
        const interpreted = head.match(/^(?:(?:node|node\.exe|python|python\d*(?:\.exe)?|py(?:\.exe)?|ruby|php|tsx|ts-node|bun|deno|bash|sh)(?:\s+run)?)(?:\s+--?[A-Za-z0-9_-]+(?:=[^\s]+)?)*\s+(?!-[eEpP]\b)("[^"]+"|'[^']+'|[^\s&|;]+)/i);
        if (interpreted) refs.push(interpreted[1]);
        const ps = head.match(/^(?:powershell|pwsh)(?:\.exe)?\b[^&|;]*?\s-(?:file|f)\s+("[^"]+"|'[^']+'|[^\s&|;]+)/i);
        if (ps) refs.push(ps[1]);
        const direct = head.match(/^("[^"]+"|'[^']+'|[^\s&|;]+)/);
        if (direct && CODE_FILE_RE.test(unquoteToken(direct[1]))) refs.push(direct[1]);
        for (const raw of refs) {
          const rel = unquoteToken(raw);
          if (!CODE_FILE_RE.test(rel) || !P || !baseDir || P.isAbsolute(rel) || /(^|[\\/])\.\.([\\/]|$)/.test(rel)) continue;
          let src = readSmall(fs, P.resolve(baseDir, rel), 2 << 20);
          // command text may spell the path Windows-style (scripts\smoke.mjs — normal inside .cmd files).
          // On a posix host that backslash is a filename CHARACTER, the literal path never exists, and the
          // nested scan silently goes blind to the referenced script (CI-linux gate escape, 2026-07-20).
          // Retry with separators normalized so the isolation floor sees the same files on every host.
          if (!src && rel.indexOf('\\') >= 0) src = readSmall(fs, P.resolve(baseDir, rel.replace(/\\/g, '/')), 2 << 20);
          if (src) enqueue(src, baseDir);
        }
      }
    }
    return out;
  }
  function workspaceCapturesInput(cwd, fs, P) {
    if (!cwd || !fs || !P) return false;
    const stack = [cwd];
    let files = 0, bytes = 0;
    while (stack.length && files < 2000 && bytes < (8 << 20)) {
      const dir = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of ents) {
        if (SCAN_SKIP_RE.test(ent.name)) continue;
        const p = P.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(p); continue; }
        if (!/\.(?:html?|[cm]?js|ts|tsx|jsx|vue|svelte|py|ps1|rs|cs|c|cc|cpp)$/i.test(ent.name)) continue;
        const src = readSmall(fs, p, 1 << 20); files++; bytes += src.length;
        if (INPUT_CAPTURE_RE.test(src)) return true;
      }
    }
    return false;
  }
  function projectScanRoot(cwd, fs, P) {
    if (!cwd || !fs || !P) return cwd;
    let cur;
    try { cur = P.resolve(cwd); } catch (_) { return cwd; }
    for (let i = 0; i < 12; i++) {
      try {
        if (fs.existsSync(P.join(cur, 'package.json')) || fs.existsSync(P.join(cur, 'Cargo.toml')) || fs.existsSync(P.join(cur, '.git'))) return cur;
      } catch (_) {}
      const parent = P.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    return cwd;
  }
  function inputIsolationRisk(cmd, opts) {
    opts = opts || {};
    const c = String(cmd == null ? '' : cmd), dialect = opts.dialect;
    const heads = commandHeads(c, dialect);
    if (heads.some(h => BROWSER_NAMES.has(exeName((headTokens(h)[0] || {}).value)))) {
      return 'launches a browser outside StarNet\'s synthetic-input CDP sandbox — use browser.test_navigate/browser.test_input';
    }
    const sources = commandSources(c, opts);
    const expanded = sources.join('\n');
    const activeHead = heads.some(h => {
      const text = canonicalHead(h);
      return !/^echo(?:\.exe)?\b/i.test(text) && (NATIVE_INPUT_RE.test(text) || USER_SESSION_RE.test(text) || OPAQUE_LAUNCH_RE.test(text));
    });
    if (activeHead || sources.slice(1).some(s => NATIVE_INPUT_RE.test(s) || USER_SESSION_RE.test(s) || OPAQUE_LAUNCH_RE.test(s))) {
      return 'can inject/capture input, launch opaque code, or alter the user\'s interactive session';
    }
    if (sources.some(s => /(?:^|\s)--open(?:[=\s]|$)/i.test(s))) return 'opens a framework/browser window on the user\'s screen — keep dev servers headless';
    if (BROWSER_AUTOMATION_RE.test(expanded)) return 'runs browser automation outside StarNet\'s owned pointer-lock emulator — use browser.test_*';
    if (GUI_RUNTIME_RE.test(expanded) || heads.some(h => LOCAL_PROGRAM_RE.test(h && h.text != null ? h.text : String(h || '')))) return 'launches a GUI/native runtime on the user\'s interactive desktop';
    return null;
  }

  // --- machine-state floor --- head-anchored rules (verb at the start of a command head) + a few whole-string
  // rules for signatures that are distinctive enough to match anywhere (registry hive refs, PS cmdlet names).
  // Command names end at whitespace/EOS, not at a regex word boundary. PowerShell's harmless `Format-List`
  // has a word boundary after "Format" (the hyphen is non-word), so `format\b` used to reject read-only hardware
  // inventory. Exact command-token boundaries also prevent future Verb-Noun cmdlets from colliding with shorter
  // executable names in this table.
  const MACHINE_HEAD_RULES = [
    { re: /^(?:shutdown|logoff|reboot|halt|poweroff|tsdiscon|rwinsta)(?:\.(?:exe|com))?(?=\s|$)/i, why: 'shuts down, reboots, disconnects, or logs the user out of their machine' },
    { re: /^(?:taskkill|tskill|pskill|kill|pkill|killall)(?:\.(?:exe|com))?(?=\s|$)/i, why: 'kills processes the agent does not own — stop your OWN background processes with shell.bg.kill' },
    { re: /^schtasks(?:\.(?:exe|com))?(?=\s|$)[\s\S]*?\s\/(?:create|change|delete|run)\b/i, why: 'creates or changes a Windows scheduled task (machine persistence that outlives StarNet)' },
    { re: /^reg(?:\.exe)?\s+(?:add|delete|import|load|unload|copy)\b/i, why: 'writes the Windows registry' },
    { re: /^regedit(?:\.(?:exe|com))?(?=\s|$)/i, why: 'opens or imports into the Windows registry' },
    { re: /^sc(?:\.exe)?\s+(?:create|config|delete|start|stop|failure|sdset)\b/i, why: 'creates or changes Windows services' },
    { re: /^netsh(?:\.(?:exe|com))?(?=\s|$)/i, why: 'changes network / firewall configuration' },
    { re: /^net(?:\.exe)?\s+(?:user|localgroup|accounts|share|start|stop)\b/i, why: 'changes accounts, shares, or services' },
    { re: /^(?:setx|assoc|ftype)(?:\.(?:exe|com))?(?=\s|$)/i, why: 'permanently changes environment variables or file associations' },
    { re: /^(?:bcdedit|diskpart|format|chkdsk|cipher|vssadmin|wevtutil|powercfg|tzutil|w32tm|msg|mshta|wmic|displayswitch|xrandr|xinput|xset|chvt|ddcutil|pactl|amixer)(?:\.(?:exe|com))?(?=\s|$)/i, why: 'system/display/input/audio tool that alters or disrupts the machine' },
    { re: /^(?:sudo|su|systemctl|loginctl|launchctl|crontab|nvram|csrutil|diskutil|pmset|osascript)(?=\s|$)/i, why: 'system administration or interactive-session command' },
    // machine-altering PowerShell cmdlets — head-anchored so `echo restart-computer` (the word as an arg) is not a
    // trip, but `Restart-Computer`, `foo | Stop-Computer`, and `powershell -Command "Stop-Computer"` all are.
    { re: /^(?:Stop-Computer|Restart-Computer|Suspend-Computer|Register-ScheduledTask|New-ScheduledTask\w*|Stop-Process|Stop-Service|New-Service|Set-Service|Set-Date|Add-Computer|Set-ExecutionPolicy|Set-NetFirewall\w+|Disable-NetAdapter|Set-DisplayResolution|Set-Clipboard)(?=\s|$)/i, why: 'PowerShell cmdlet that alters machine or interactive-session state' }
  ];
  const MACHINE_GLOBAL_RULES = [
    { re: /\bHKEY_|(?:^|[\s"'`=(\\])HK(?:LM|CU|CR|U|CC)[:\\]/i, why: 'references a Windows registry hive' },
    { re: /\bdefaults\s+write\b/i, why: 'changes macOS system preferences' },
    { re: /(?:^|[\s"'`=(])shell:startup\b|Start\s?Menu[\\/]+Programs[\\/]+Startup/i, why: 'writes to the Startup folder (machine persistence that outlives StarNet)' }
  ];
  function breaksMachineState(cmd, dialect) {
    const c = String(cmd == null ? '' : cmd);
    const analysis = analyzeCommands(c, 0, dialect);
    if (analysis.opaquePowerShell) return 'runs a base64-encoded PowerShell command that cannot be inspected — write the script to a file and run it plainly';
    if (analysis.heads.some(h => {
      const first = (headTokens(h)[0] || {}).value || '';
      return /^(?:%[^%\s]+%|![^!\s]+!)$/.test(first);
    })) return 'uses an environment-expanded executable at a command boundary, so the command cannot be inspected safely';
    const heads = analysis.heads.map(canonicalHead);
    for (const r of MACHINE_HEAD_RULES) if (heads.some(h => r.re.test(h))) return r.why;
    for (const r of MACHINE_GLOBAL_RULES) if (r.re.test(c)) return r.why;
    return null;
  }

  // Binding a dev server to all interfaces exposes it to the user's WHOLE network (the 2026-07-12 game server did
  // this). Match an explicit all-interfaces BIND FLAG (so `curl http://0.0.0.0` — 0.0.0.0 as a client target,
  // which resolves to loopback — is NOT refused), plus a bare `--host` (vite/webpack treat it as 0.0.0.0). NOTE:
  // a framework whose DEFAULT bind is 0.0.0.0 with no flag (python -m http.server) still slips this string check —
  // the OS-containment layer (docs/NEXT.md) is the real closure; here we catch the explicit forms honestly.
  const ALL_IFACES = '0\\.0\\.0\\.0|::(?![0-9a-f])|\\[::\\]';
  function exposesNetwork(cmd) {
    const c = String(cmd == null ? '' : cmd);
    if (new RegExp('(?:--host|--bind|--address|-b|-H)[=\\s:]+["\']?(?:' + ALL_IFACES + ')', 'i').test(c)
      || new RegExp('\\bhost["\']?\\s*[:=]\\s*["\']?(?:' + ALL_IFACES + ')', 'i').test(c)
      || /--host(?:\s+--|\s*$)/i.test(c)) {
      return 'binds to ALL network interfaces — every device on the user\'s network could reach it; bind to 127.0.0.1';
    }
    return null;
  }

  // One decision seam for every agent-controlled command runner. shell.exec and
  // verify.run must stay in parity as new user-control floors are added.
  function commandSafetyRisk(cmd, opts) {
    opts = opts || {};
    const dialect = opts.dialect || (opts.isWin === false ? 'posix' : undefined);
    const visible = opensVisibleWindow(cmd, dialect);
    if (visible) return { kind: 'visible-desktop', reason: visible };
    const machine = breaksMachineState(cmd, dialect);
    if (machine) return { kind: 'machine-state', reason: machine };
    const network = exposesNetwork(cmd);
    if (network) return { kind: 'network-exposure', reason: network };
    const input = inputIsolationRisk(cmd, Object.assign({}, opts, { dialect }));
    if (input) return { kind: 'user-control', reason: input };
    return null;
  }

  /* H2.1 — persistent session cwd. A command runs in one shell invocation, so a `cd` only survives if we
     RECOVER the final cwd from that same invocation. We append a marker that prints the working dir + the real
     exit code (captured BEFORE the marker so the appended echo can't mask it), parse it back, strip it from the
     shown output, and persist the cwd PER AGENT — clamped to the fs jail so it can never drift outside. */
  const MARK_A = '__SK_CWD__', MARK_EC = '__SK_EC__', MARK_END = '__SK_END__';
  function buildMarkedCmd(cmd, isWin) {
    if (isWin) return cmd + ' & call echo ' + MARK_A + '%CD%' + MARK_EC + '%ERRORLEVEL%' + MARK_END;   // `call echo` re-expands %ERRORLEVEL% at runtime
    return cmd + '\n__sk_ec=$?; printf "\\n' + MARK_A + '%s' + MARK_EC + '%s' + MARK_END + '" "$(pwd)" "$__sk_ec"';
  }
  function parseMarker(out) {
    out = String(out == null ? '' : out);
    const re = new RegExp(MARK_A + '([\\s\\S]*?)' + MARK_EC + '(-?\\d+)' + MARK_END);
    const m = out.match(re);
    if (!m) return { cwd: null, ec: null, cleanOut: out };
    const ec = parseInt(m[2], 10);
    const cleanOut = (out.slice(0, m.index).replace(/\n$/, '')) + out.slice(m.index + m[0].length);
    return { cwd: m[1].trim(), ec: isFinite(ec) ? ec : null, cleanOut: cleanOut };
  }
  // is `cwd` the jail root or strictly inside it? (resolve both so .. / symlinks can't sneak past)
  // CASE-FOLD ON WINDOWS, exactly like pathInside three lines down. NTFS is case-insensitive, and the cwd
  // compared here is routinely recovered from `%CD%` (buildMarkedCmd) rather than constructed by us — so a
  // path that IS inside the jail but spells a segment differently read as OUTSIDE, and the whole point of
  // H2.1's persistent session cwd (`cd` surviving between shell.exec calls) silently stopped working on the
  // project's primary platform. Fail-closed, so it was never a security hole — just a broken feature.
  function withinJail(P, cwd, jailRoot) {
    try {
      let r = P.resolve(cwd), j = P.resolve(jailRoot);
      if (P.sep === '\\') { r = r.toLowerCase(); j = j.toLowerCase(); }
      return r === j || r.indexOf(j + P.sep) === 0;
    } catch (_) { return false; }
  }
  function pathInside(P, child, parent) {
    try {
      let c = P.resolve(child), p = P.resolve(parent);
      if (P.sep === '\\') { c = c.toLowerCase(); p = p.toLowerCase(); }
      return c === p || c.indexOf(p + P.sep) === 0;
    } catch (_) { return false; }
  }
  function normalizeWinCwd(P, cwd, isWin) {
    cwd = String(cwd == null ? '' : cwd).trim();
    if (!isWin) return cwd;
    const m = cwd.match(/^\/([a-zA-Z])(?:\/|$)(.*)$/);
    if (!m) return cwd;
    const tail = m[2] ? m[2].replace(/[\\/]+/g, '\\') : '';
    return m[1].toUpperCase() + ':\\' + tail;
  }
  function resolveShellCwd(opts) {
    opts = opts || {};
    const P = opts.pathMod, fs = opts.fs, requested = opts.requested;
    const current = opts.current, jailRoot = opts.jailRoot, root = opts.root;
    const isWin = !!opts.isWin, allowExternal = !!opts.allowExternal, allowProtected = !!opts.allowProtected;
    let raw = String(requested == null ? '' : requested).trim();
    if (!raw) return current;
    if (/[\0\r\n]/.test(raw)) throw new Error('cwd contains a control character');
    if (/^\\\\[^\s\\]/.test(raw)) throw new Error('UNC cwd paths are not allowed');
    raw = normalizeWinCwd(P, raw, isWin);
    const abs = P.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? P.resolve(raw) : P.resolve(current, raw);
    if (!withinJail(P, abs, jailRoot) && !allowExternal) throw new Error('cwd must stay inside your workspace');
    if (!allowProtected && !withinJail(P, abs, jailRoot) && root && pathInside(P, abs, root))
      throw new Error('cwd cannot point at another agent or protected StarNet workspace sibling');
    if (fs && fs.existsSync && !fs.existsSync(abs)) throw new Error('cwd does not exist: ' + raw);
    if (fs && fs.statSync) {
      try { if (!fs.statSync(abs).isDirectory()) throw new Error('cwd is not a directory: ' + raw); }
      catch (e) { if (e && /^cwd is not a directory/.test(e.message || '')) throw e; throw new Error('cwd is not accessible: ' + raw); }
    }
    return abs;
  }

  // best-effort tree-kill: on Windows taskkill must inspect the live shell root to discover `/T` descendants.
  function killTree(spawn, child, isWin) {
    if (isWin && child.pid) {
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        try { child.kill(); } catch (_) {}
      };
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        if (killer && typeof killer.on === 'function') {
          killer.on('error', fallback);
          killer.on('close', (code) => { if (code !== 0) fallback(); });
        }
        try { if (killer && typeof killer.unref === 'function') killer.unref(); } catch (_) {}
        return;
      } catch (_) {
        fallback();
        return;
      }
    }
    // POSIX foreground commands own a process group (see detached below).
    // Killing only /bin/sh leaves descendants holding stdout open and running
    // after cancellation. Signal only this command's group, never our own.
    if (!isWin && Number.isInteger(child.pid) && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch (_) {}
    }
    try { child.kill(); } catch (_) {}
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch (_) {}
  }

  /* ANSI/VT control sequences, stripped before any shell output reaches the model (ref-parity: the reference
     harness has an ansi_strip; StarNet had nothing, so escapes arrived raw). npm, git, cargo, pytest and friends emit colour
     whenever they believe a TTY is attached, and the model reads the control bytes as TOKENS — '[32m'
     is billed content that means "green" to nobody, and on a long build log it is a large fraction of the
     output. Three shapes are handled: OSC strings (window titles, hyperlinks — ESC ] … BEL or ST), CSI
     sequences (colour and cursor motion — ESC [ … final byte), and lone two-character escapes.

     Applied HERE, in the shared primitive, so shell.exec and the background tail (shellbg.js reads r.out)
     are both covered by one strip rather than two that can drift.

     Applied at finish() rather than per chunk on purpose: an escape sequence can straddle a chunk boundary,
     and a per-chunk strip would leave the halves behind. The trailing-fragment rule catches the one case the
     whole-string pass cannot — the byte cap slicing through a sequence at the very end. */
  // Every control byte AND the regex-escaping backslash come from String.fromCharCode, so this source line
  // contains no backslash and no invisible ESC at all. Both bite here: a literal ESC in a regex literal is
  // invisible in review, and a backslash makes the meaning depend on how many escaping layers a tool applied
  // (this block silently compiled to an unterminated group twice before being written this way).
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7), BS = String.fromCharCode(92);
  const ANSI_RE = new RegExp(
    ESC + BS + '[[0-?]*[ -/]*[@-~]'                    // CSI: colour and cursor motion, the 99% case
    + '|' + ESC + BS + '][^' + BEL + ']*' + BEL + '?'  // OSC: window titles / hyperlinks, up to BEL
    + '|' + ESC + '.', 'g');                           // any other two-char escape, including an ST
  const ANSI_TAIL_RE = new RegExp(ESC + BS + '[?[0-?]*[ -/]*$');
  function stripAnsi(s) {
    return String(s == null ? '' : s).replace(ANSI_RE, '').replace(ANSI_TAIL_RE, '');
  }

  /* runCommand — the shared execution primitive: spawn `cmd` in `cwd` (shell:true), capture combined stdout/stderr
     up to maxBytes, enforce the per-call timeout + abort signal by KILLING the child tree, and resolve a plain
     result. Never rejects on a non-zero exit (that is a RESULT); rejects ONLY if the process can't be started.
     opts = { spawn, cmd, cwd, timeoutMs, maxBytes, signal?, clock?, isWin? }
       -> Promise<{ exitCode:int, out:string, ms:int, truncated:bool, timedOut:bool, aborted:bool }> */
  function runCommand(opts) {
    const spawn = opts.spawn, cmd = opts.cmd, cwd = opts.cwd;
    const timeoutMs = opts.timeoutMs, maxBytes = opts.maxBytes || 64000;
    const now = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock.now : () => 0;
    const isWin = (opts.isWin != null) ? opts.isWin : WIN;
    const sig = opts.signal;
    return new Promise(function (resolve, reject) {
      let child;
      // opts.env is ADDITIVE and optional: omitted (every existing caller) the child inherits this process's
      // environment exactly as before. Commander-defined exec commands pass a sanitized copy, because the
      // sidecar's env holds provider keys and a user snippet has no business reading them.
      const spawnOpts = { cwd: cwd, shell: true, windowsHide: true };
      if (!isWin) spawnOpts.detached = true; // Own a group for timeout/abort; pipes remain attached.
      if (opts.env) spawnOpts.env = opts.env;
      try { child = spawn(cmd, spawnOpts); }
      catch (e) { return reject(new Error('could not start shell: ' + ((e && e.message) || e))); }
      const t0 = now();
      let out = '', fullOut = '', total = 0, truncated = false, settled = false, timedOut = false, aborted = false;
      const append = function (text) {
        const complete = String(text);
        fullOut += complete;
        if (total >= maxBytes) { truncated = true; return; }
        let s = complete;
        if (total + s.length > maxBytes) { s = s.slice(0, maxBytes - total); truncated = true; }
        out += s; total += s.length;
      };
      // per-stream StringDecoder: a multi-byte UTF-8 char straddling a pipe chunk boundary must not
      // become U+FFFD in the output the model reads (same fix as environment.js).
      const { StringDecoder } = require('node:string_decoder');
      const mkDecoded = function () {
        const dec = new StringDecoder('utf8');
        return function (buf) { append(typeof buf === 'string' ? buf : dec.write(buf)); };
      };
      if (child.stdout) child.stdout.on('data', mkDecoded());
      if (child.stderr) child.stderr.on('data', mkDecoded());
      const timer = setTimeout(function () { timedOut = true; killTree(spawn, child, isWin); }, timeoutMs);
      const onAbort = function () { aborted = true; killTree(spawn, child, isWin); };
      if (sig) { if (sig.aborted) { onAbort(); } else { try { sig.addEventListener('abort', onAbort, { once: true }); } catch (_) {} } }
      function finish(code) {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} }
        // Stripped HERE, at the single exit of the shared primitive, so shell.exec and the background tail
        // (shellbg.js reads r.out) are both covered by one strip that cannot drift into two.
        resolve({ exitCode: (typeof code === 'number') ? code : -1, out: stripAnsi(out), fullOut: stripAnsi(fullOut), ms: Math.max(0, now() - t0), truncated: truncated, timedOut: timedOut, aborted: aborted });
      }
      child.on('error', function (e) { if (settled) return; settled = true; clearTimeout(timer); if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} } reject(new Error('shell error: ' + ((e && e.message) || e))); });
      child.on('close', function (code) { finish(timedOut || aborted ? null : code); });
    });
  }

  // Lane C (no silent fallback): when the agent's profile asks for a sandbox the router cannot honor, the
  // router hands back a typed refusal. Ask BEFORE checkpointing or resolving cwd so nothing touches the host.
  function sandboxRefusal(environment, aid) {
    if (!environment || typeof environment.refusalFor !== 'function') return null;
    try { return environment.refusalFor(aid) || null; } catch (_) { return null; }
  }
  function makeShellTool(deps) {
    deps = deps || {};
    const environment = deps.environment || null;
    const spawn = deps.spawn, fs = deps.fs || null, P = deps.pathMod || (typeof require === 'function' ? require('node:path') : null), ROOT = deps.root || '';
    const bg = deps.bg || null;   // H2.2: the singleton background-process manager (shellbg.js); null -> bg disabled
    if (!environment && (typeof spawn !== 'function' || !fs || !P || !ROOT)) throw new Error('shell.js requires { spawn, fs, pathMod, root } or { environment }');
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.platform != null) ? (deps.platform === 'win32') : WIN;
    const L = deps.limits || {};
    const MAX_BYTES = L.maxBytes || 64000;
    const DEFAULT_MS = L.defaultTimeoutMs || 30000;
    const MAX_MS = L.maxTimeoutMs || 120000;
    const sessions = new Map();   // H2.1: unscoped aid or run-scoped project key -> { cwd }

    const execTool = {
      name: 'shell.exec', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
      timeoutMs: MAX_MS + 10000,   // registry backstop ABOVE our own kill logic, so withTimeout never preempts the child-kill
      /* Trimmed 2026-07-26 (tool-schema cost pass). This text is re-sent on EVERY turn, so it may only
         carry what CHANGES A DECISION. The old version enumerated each refused command class; the guard
         already answers that at call time with the specific reason, and far more accurately than a
         remembered list — so it is stated once as a rule instead of itemised. Same for the Windows path
         normalization note: it altered no choice the model makes. */
      description: 'Run a shell command in the current project folder when this session is project-scoped, otherwise in your private workspace; returns combined stdout/stderr + exit code. '
        + 'Tests, builds, git, scripts — anything you would type in a terminal. On Windows this uses cmd.exe; wrap PowerShell cmdlets with `powershell -NoProfile -NonInteractive -Command "..."`. '
        + 'Your working directory PERSISTS across calls (a `cd` carries over). Absolute and `..` paths are '
        + 'refused in cmd — pass cwd to run from a specific existing folder. Commands that would change the '
        + 'user\'s machine or screen are refused in restricted modes; Full Power may run any host command the '
        + 'current OS user can run. Optional timeoutMs (default 30s, max 120s). background:true returns a handle '
        + 'immediately for long-running processes (dev servers) — check shell.bg.status, read its log with '
        + 'shell.bg.read, answer its prompts with shell.bg.write, stop it with shell.bg.kill.',
      schema: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' }, background: { type: 'boolean' } } },
      run: function (args, ctx) {
        ctx = ctx || {};
        // Host-minted at Telegram ingress: this is the paired Commander at the physical desktop, not a prompt
        // claim or a cached capability. It is the one path allowed to leave the agent workspace and use host tools.
        const remoteOwner = unrestrictedHost(ctx);
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const environmentBackendId = environment
          ? (typeof environment.backendIdFor === 'function' ? environment.backendIdFor(aid) : environment.backendId)
          : null;
        const cmd = String((args && args.cmd) || '').trim();
        if (!cmd) throw new Error('empty command');
        const refusal = sandboxRefusal(environment, aid);
        if (refusal) throw refusal;
        const deny = remoteOwner ? null : escapesWorkspace(cmd);
        if (deny) throw new Error('refused: ' + deny);
        const jailRoot = environment ? environment.ensureWorkspace(aid) : P.join(ROOT, aid);
        // A project root is host-minted from the session's still-live blessing. Keep its shell cwd run-scoped:
        // two concurrent projects owned by the same agent must never inherit one another's `cd` state.
        const runProjectCwd = String(ctx.projectCwd || ctx.projectRoot || '').trim();
        const sessionKey = runProjectCwd ? (aid + '\0project:' + String(ctx.runId || runProjectCwd)) : aid;
        // H2.1: start in this scope's persisted cwd (default = project root or jail root). Defensive: only
        // honor a stored cwd that still resolves under the allowed local envelope and still exists.
        const sess = sessions.get(sessionKey);
        let cwd = environment ? environment.getCwd(aid) : jailRoot;
        if (runProjectCwd) cwd = resolveShellCwd({ pathMod: P, fs: fs, requested: runProjectCwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: environmentBackendId === 'local' });
        if (sess && sess.cwd) {
          try { cwd = resolveShellCwd({ pathMod: P, fs: fs, requested: sess.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: remoteOwner || environmentBackendId === 'local', allowProtected: remoteOwner }); }
          catch (_) {}
        }
        if (!environment && sess && sess.cwd && (remoteOwner || withinJail(P, sess.cwd, jailRoot)) && (!fs.existsSync || fs.existsSync(sess.cwd))) cwd = sess.cwd;
        if (args && args.cwd != null) {
          if (environment && environmentBackendId !== 'local' && !remoteOwner) throw new Error('cwd is only supported on the local execution backend; use cd inside the container workspace instead');
          cwd = resolveShellCwd({ pathMod: P, fs: fs, requested: args.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: remoteOwner || environmentBackendId === 'local', allowProtected: remoteOwner });
          sessions.set(sessionKey, { cwd: cwd });
        }
        const hostCwd = environment && typeof environment.workspaceRoot === 'function' && environmentBackendId !== 'local'
          ? environment.workspaceRoot(aid) : cwd;
        const shellDialect = environment && environmentBackendId !== 'local' ? 'posix' : (isWin ? 'cmd' : 'posix');
        const safetyDeny = remoteOwner ? null : commandSafetyRisk(cmd, { cwd: hostCwd, fs: fs, pathMod: P, dialect: shellDialect, isWin });
        if (safetyDeny) throw new Error('refused [' + safetyDeny.kind + ']: this command ' + safetyDeny.reason + '. StarNet task processes preserve the user\'s control of their computer; use browser.test_* for local UI/game verification.');
        if (!environment) { try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {} }
        const checkpoint = typeof ctx.checkpointMutation === 'function'
          ? Promise.resolve().then(function () { return ctx.checkpointMutation(hostCwd, 'shell.exec', { always: true }); }).catch(function () { return null; })
          : Promise.resolve(null);
        // H2.2: a long-running process — hand it to the singleton bg manager (detached, ring-buffered, capped)
        // and return immediately. Inherits the persisted cwd. Still consent-gated (this IS shell.exec).
        if (args && args.background) return checkpoint.then(function () {
          if (!environment && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
          const started = environment && typeof environment.startBackground === 'function'
            // ctx.surface (host authority, from runInputContext) rides along so the backend hands this child only
            // the service keys the Commander granted for unattended use — see servicekeys.runEnv.
            ? environment.startBackground({ agentId: aid, cmd: cmd, cwd: cwd, isWin: isWin, surface: ctx.surface })
            : bg.start({ agentId: aid, cmd: cmd, cwd: cwd, isWin: isWin });
          return Promise.resolve(started).then(function (r) {
          const content = r.ok
            ? 'Started background process ' + r.bgId + ' in your workspace. It keeps running while you work — check it with shell.bg.status (id "' + r.bgId + '"), read its full log with shell.bg.read, send it input with shell.bg.write, stop it with shell.bg.kill.'
            : 'Could not start a background process: ' + r.error;
          return { content: content, summary: r.ok ? ('bg started ' + r.bgId) : 'bg refused' };
          });
        });
        const timeoutMs = clamp((args && args.timeoutMs) || DEFAULT_MS, 1000, MAX_MS);
        const markerIsWin = environment && environmentBackendId !== 'local' ? false : isWin;
        const run = checkpoint.then(function () {
          return environment && typeof environment.execute === 'function'
            ? environment.execute({ agentId: aid, cmd: buildMarkedCmd(cmd, markerIsWin), cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, surface: ctx.surface })
            : runCommand({ spawn: spawn, cmd: buildMarkedCmd(cmd, isWin), cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, isWin: isWin });
        });
        return run.then(function (res) {
          // recover the final cwd + the REAL exit code from the marker; persist the cwd only if it stayed in-jail.
          const pm = parseMarker(res.fullOut || res.out);
          const preview = parseMarker(res.out);
          if (environment && pm.cwd && environmentBackendId !== 'local') environment.rememberCwd(aid, pm.cwd);
          else if (environment && pm.cwd && withinJail(P, pm.cwd, jailRoot)) environment.rememberCwd(aid, pm.cwd);
          else if (environment && pm.cwd && environmentBackendId === 'local') {
            try { sessions.set(sessionKey, { cwd: resolveShellCwd({ pathMod: P, fs: fs, requested: pm.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: true, allowProtected: remoteOwner }) }); } catch (_) {}
          }
          else if (pm.cwd && (remoteOwner || withinJail(P, pm.cwd, jailRoot))) sessions.set(sessionKey, { cwd: pm.cwd });
          const exitCode = (pm.ec != null && !res.timedOut && !res.aborted) ? pm.ec : res.exitCode;
          const note = res.timedOut ? ' — KILLED (timed out after ' + timeoutMs + 'ms)' : res.aborted ? ' — KILLED (aborted)' : '';
          const body = redact((res.truncated ? preview.cleanOut : pm.cleanOut) || '(no output)');
          const content = body + '\n[exit ' + exitCode + (res.truncated ? ', output truncated to ' + Math.round(MAX_BYTES / 1000) + 'KB' : '') + note + ']';
          const fullContent = res.truncated
            ? redact(pm.cleanOut || '(no output)') + '\n[exit ' + exitCode + note + ']'
            : undefined;
          try {
            if (typeof ctx.emit === 'function') ctx.emit('shell.exec', {
              agentId: aid, runId: ctx.runId || '', callId: ctx.callId || 'call',
              cmdSummary: redact(clip(cmd)), cwd: aid, exitCode: exitCode, ms: res.ms, truncated: res.truncated
            });
          } catch (_) {}
          return { content: content, fullContent: fullContent, summary: 'exit ' + exitCode + ' (' + res.ms + 'ms)' + (res.truncated ? ', truncated' : '') };
        });
      }
    };

    // H2.2: inspect / stop the agent's own background processes (started via shell.exec background:true).
    const bgStatusTool = {
      name: 'shell.bg.status', capability: 'workbench', scope: 'read', requiresConsent: false,
      description: 'List your running/finished background processes (from shell.exec background:true), or pass an id '
        + 'for one process — shows whether it is still running, its exit code if done, and a tail of its output.',
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      run: async function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const source = environment && typeof environment.statusBackground === 'function' ? environment : null;
        if (!source && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
        const id = args && args.id ? String(args.id) : null;
        if (id) {
          const v = await Promise.resolve(source ? source.statusBackground(aid, id) : bg.status(aid, id));
          if (!v) return { content: 'No background process "' + id + '".', summary: 'not found' };
          const saved = v.outputSpillVerified ? '\n[full output: ' + v.outputBytes + ' bytes durably appended to ' + v.outputPath + ']' : (v.outputSpillError ? '\n[full-output spill failed: ' + v.outputSpillError + ']' : '');
          const state = v.running ? 'RUNNING' : v.lost ? 'LOST — ' + (v.remoteBoundary || 'remote process identity is unconfirmed') : 'exited ' + v.exitCode + (v.killed ? ' (killed)' : '');
          return { content: '[' + v.bgId + '] ' + state + ' · ' + v.ms + 'ms · ' + v.cmd + saved + '\n--- output tail ---\n' + redact(v.tail || '(none)'), summary: v.running ? 'running' : v.lost ? 'lost' : 'exited ' + v.exitCode };
        }
        const list = await Promise.resolve(source ? source.statusBackground(aid) : bg.status(aid)) || [];
        if (!list.length) return { content: 'No background processes.', summary: '0' };
        return { content: list.map(function (v) { return '[' + v.bgId + '] ' + (v.running ? 'RUNNING' : v.lost ? 'LOST (identity mismatch)' : 'exited ' + v.exitCode) + ' · ' + v.cmd; }).join('\n'), summary: list.length + ' process(es)' };
      }
    };
    /* H2.3 — READ PAST THE TAIL. shell.bg.status returns the last ~2000 characters, which is fine for "is it
       up?" and useless for "why did it fail": the stack trace that matters is usually hundreds of lines back,
       and the only way to reach it used to be re-running the whole command in the foreground. */
    const bgReadTool = {
      name: 'shell.bg.read', capability: 'workbench', scope: 'read', requiresConsent: false,
      description: 'Read the output log of one of your background processes by line, instead of the short tail that '
        + 'shell.bg.status shows. Defaults to the LAST 200 lines. Pass offset (0-based; negative counts back from the '
        + 'end) and limit to page, or grep to return only lines containing a string — use grep to find an error, then '
        + 'offset to read around it.',
      schema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, grep: { type: 'string' } }
      },
      run: async function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const source = environment && typeof environment.readBackground === 'function' ? environment : null;
        if (!source && (!bg || typeof bg.read !== 'function')) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
        const id = args && args.id ? String(args.id) : '';
        const opts = { offset: args && args.offset, limit: args && args.limit, grep: args && args.grep };
        const r = await Promise.resolve(source ? source.readBackground(aid, id, opts) : bg.read(aid, id, opts));
        if (!r || !r.ok) return { content: 'Could not read: ' + ((r && r.error) || 'unknown error'), summary: 'not read' };
        const head = '[' + r.bgId + '] ' + (r.running ? 'RUNNING' : 'exited ' + r.exitCode + (r.killed ? ' (killed)' : '')) + ' · ' + r.cmd;
        const scope = r.grep
          ? (r.matchedLines + ' line(s) match "' + r.grep + '" of ' + r.totalLines + ' held; showing ' + r.returned + ' from match ' + (r.offset + 1))
          : ('lines ' + (r.returned ? r.firstLineNo : 0) + '–' + (r.returned ? r.firstLineNo + r.returned - 1 : 0) + ' of ' + r.totalLines + ' held');
        /* Say it when the ring has lapped. Line 1 is then NOT the first line the process printed, and an agent
           that assumes it is will conclude a failure started somewhere it did not. */
        const note = r.truncatedStart
          ? (r.outputSpillVerified
              ? '\n(earlier output left the memory buffer; the full ' + r.outputBytes + '-byte log is saved once at ' + r.outputPath + ' and can be paged with fs.read)'
              : '\n(earlier output was dropped from memory and durable spill is unverified' + (r.outputSpillError ? ': ' + r.outputSpillError : '') + ')')
          : (r.outputSpillVerified ? '\n(full output is durably appended to ' + r.outputPath + '; ' + r.outputBytes + ' bytes so far)' : '');
        const body = r.returned
          ? r.lines.map(function (ln, i) { return String(r.lineNos[i]).padStart(6, ' ') + '  ' + ln; }).join('\n')
          : (r.grep ? '(no lines match)' : '(no output yet)');
        return { content: head + '\n' + scope + note + '\n--- output ---\n' + redact(body), summary: r.returned + ' line(s)' };
      }
    };

    /* H2.3 — STDIN. A background process was write-only: an installer that asks one question, or a REPL, sat
       wedged until it was killed. The payload is screened with the SAME command-safety guard shell.exec runs,
       because a line typed into a `bash`/`python` REPL executes exactly like a command typed into shell.exec —
       leaving it unscreened would have made background:true a way around the screen. */
    const bgWriteTool = {
      name: 'shell.bg.write', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
      description: 'Send input to a running background process\'s stdin — answer an interactive prompt, drive a REPL, '
        + 'or feed a pipe. A newline is appended (set submit:false to send a partial line). Pass eof:true instead of '
        + 'input to CLOSE stdin, which is what many commands wait for before doing their work — that is different '
        + 'from shell.bg.kill, which destroys the result. Its stdin is a PIPE, not a terminal: programs that '
        + 'demand a real TTY (password prompts, full-screen menus) will not see your input — re-run those '
        + 'non-interactively (e.g. a --yes flag or an env var) instead.',
      schema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string' }, input: { type: 'string' }, submit: { type: 'boolean' }, eof: { type: 'boolean' } }
      },
      run: async function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const id = args && args.id ? String(args.id) : '';
        const wantEof = !!(args && args.eof);
        const source = environment && typeof environment.writeBackground === 'function' ? environment : null;
        if (!source && (!bg || typeof bg.write !== 'function')) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };

        if (wantEof) {
          const c = await Promise.resolve(source && typeof source.closeBackgroundStdin === 'function' ? source.closeBackgroundStdin(aid, id) : bg.closeStdin(aid, id));
          return { content: c.ok ? (c.alreadyClosed ? 'stdin for ' + id + ' was already closed.' : 'Closed stdin for ' + id + ' (EOF sent).') : ('Could not close stdin: ' + c.error), summary: c.ok ? 'eof' : 'not closed' };
        }
        const input = String((args && args.input) || '');
        if (!input) throw new Error('input is required (or pass eof:true to close stdin)');
        const jailRoot = environment ? environment.ensureWorkspace(aid) : P.join(ROOT, aid);
        const environmentBackendId = environment
          ? (typeof environment.backendIdFor === 'function' ? environment.backendIdFor(aid) : environment.backendId)
          : null;
        const dialect = environment && environmentBackendId !== 'local' ? 'posix' : (isWin ? 'cmd' : 'posix');
        const remoteOwner = unrestrictedHost(ctx);
        const risk = remoteOwner ? null : commandSafetyRisk(input, { cwd: jailRoot, fs: fs, pathMod: P, dialect: dialect, isWin: isWin });
        if (risk) throw new Error('refused [' + risk.kind + ']: this input ' + risk.reason + '. A line sent to a shell or REPL runs like a command, so it is screened the same way.');
        const r = await Promise.resolve(source ? source.writeBackground(aid, id, { input: input, submit: args && args.submit }) : bg.write(aid, id, { input: input, submit: args && args.submit }));
        return {
          content: r.ok ? ('Sent ' + r.bytes + ' byte(s) to ' + id + '. Read what it printed with shell.bg.read.') : ('Could not write: ' + r.error),
          summary: r.ok ? 'wrote ' + r.bytes + 'b' : 'not written'
        };
      }
    };

    const bgKillTool = {
      name: 'shell.bg.kill', capability: 'workbench', scope: 'write', requiresConsent: false,
      description: 'Stop one of your background processes by id (from shell.bg.status). Kills the whole process tree.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const source = environment && typeof environment.killBackground === 'function' ? environment : null;
        if (!source && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
        const id = args && args.id ? String(args.id) : '';
        const r = await Promise.resolve(source ? source.killBackground(aid, id) : bg.kill(aid, id));
        return { content: r.ok ? (r.alreadyExited ? 'Process ' + id + ' had already exited.' : 'Killed background process ' + id + '.') : ('Could not kill: ' + r.error), summary: r.ok ? 'killed' : 'not killed' };
      }
    };

    return {
      execTool: execTool, bgStatusTool: bgStatusTool, bgReadTool: bgReadTool, bgWriteTool: bgWriteTool, bgKillTool: bgKillTool,
      _internals: { escapesWorkspace: escapesWorkspace, opensVisibleWindow: opensVisibleWindow, inputIsolationRisk: inputIsolationRisk, commandSafetyRisk: commandSafetyRisk, workspaceCapturesInput: workspaceCapturesInput, projectScanRoot: projectScanRoot, breaksMachineState: breaksMachineState, exposesNetwork: exposesNetwork, killTree: killTree, safeAgentId: safeAgentId, normalizeWinCwd: normalizeWinCwd, resolveShellCwd: resolveShellCwd, unrestrictedHost: unrestrictedHost },
      register: function (reg) { reg.register(execTool); reg.register(bgStatusTool); reg.register(bgReadTool); reg.register(bgWriteTool); reg.register(bgKillTool); return reg; }
    };
  }

  return { makeShellTool: makeShellTool, runCommand: runCommand, escapesWorkspace: escapesWorkspace, opensVisibleWindow: opensVisibleWindow, inputIsolationRisk: inputIsolationRisk, commandSafetyRisk: commandSafetyRisk, workspaceCapturesInput: workspaceCapturesInput, projectScanRoot: projectScanRoot, breaksMachineState: breaksMachineState, exposesNetwork: exposesNetwork, safeAgentId: safeAgentId, buildMarkedCmd: buildMarkedCmd, parseMarker: parseMarker, withinJail: withinJail, normalizeWinCwd: normalizeWinCwd, resolveShellCwd: resolveShellCwd, unrestrictedHost: unrestrictedHost, sandboxRefusal: sandboxRefusal };
});
