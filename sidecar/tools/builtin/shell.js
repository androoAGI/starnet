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
  // foreground receipts for the boot orphan sweep (procledger.js trackChild); inert when no ledger is injected
  const trackChild = (typeof require === 'function') ? require('../../procledger.js').trackChild : function () { return { exited: function () {}, done: function () {} }; };
  const shellFailNote = (typeof require === 'function') ? require('../../failopen.js').note : function () {};
  // the run's ONE path decision (project root, private workspace, receipt placement, this run's `cd`): sidecar/run-paths.js
  const RunPaths = (typeof require === 'function') ? require('../../run-paths.js') : null;
  // fullOut is bounded (head + tail, output-capture.js): an unbounded `+=` crashed the station at V8's max string length
  const makeFullCapture = (typeof require === 'function') ? require('../../output-capture.js').makeFullCapture
    : function () { let s = ''; return { push: function (t) { s += t; }, value: function () { return s; }, elided: function () { return 0; } }; };
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
     own control siblings. Tuned NOT to trip on git range syntax (main..HEAD) — only `..` as a path segment.
     ONE TABLE (gh#128 family, safe-egress S4, 2026-11-03): each row is a refused form: its text test, the reason the
     refusal gives, and `names`, the words shell.exec's description uses for it ([] = not named there). That clause is
     joined from these names (FLOOR_FORMS), so what the model is told the floor refuses cannot drift from the floor
     again (run-paths-polish P3 had to correct it by hand). Rows run in order and the first match answers, exactly as
     the if-chain they replace. The floor is one text check on every host (test/path-coherence.contract.test.js), so
     the clause is the same bytes on every platform. */
  const FLOOR_RULES = Object.freeze([
    { re: /(^|[\s"'`=(])\.\.([\\/]|$)/, why: 'parent-directory (..) paths are not allowed — commands run inside your own workspace', names: ['`..`'] },
    { re: /(^|[\s"'`=(])[A-Za-z]:[\\/]/, why: 'drive-absolute paths (C:\\…) are not allowed — use paths inside your workspace', names: ['C:\\…'] },
    // unnamed: a \\server path starts with \…, the form the drive-root row names
    { re: /(^|[\s"'`=(])\\\\[^\s\\]/, why: 'UNC paths (\\\\server) are not allowed', names: [] },
    // Windows drive-ROOT-relative paths: a leading BACKSLASH with no drive letter (`type \Users\x`, `cd \`) resolves
    // to the root of the CURRENT drive — i.e. OUTSIDE the workspace, just like C:\. Block a single leading backslash
    // in path position that is NOT the start of a `\\server` UNC (that's caught above). We deliberately do NOT block
    // forward-slash-rooted forms: `/S`, `/c` etc. are overwhelmingly option flags (robocopy /S) and `/c/Users` is a
    // normalized cwd form, so there is no safe way to tell a root path from a flag — backslash-rooted only.
    { re: /(^|[\s"'`=(])\\(?![\\])/, why: 'drive-root paths (\\…) are not allowed — use paths inside your workspace', names: ['\\…'] },
    // unnamed: not a path form; the refusal itself names it
    { re: /\.checkpoints|permissions\.allow|\.notebook\.json|channels[\\/]+secrets|codex[\\/]+tokens|ledger\.jsonl|cron\.jobs\.json/i, why: 'that path is a protected harness control file', names: [] }
  ].map(function (r) { return Object.freeze({ re: r.re, why: r.why, names: Object.freeze(r.names) }); }));
  function escapesWorkspace(cmd) {
    for (const rule of FLOOR_RULES) if (rule.re.test(cmd)) return rule.why;
    return null;
  }
  // "`..`, C:\… and \…": every named form, in the floor's own order
  const FLOOR_FORMS = (function (names) {
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join('');
  })(FLOOR_RULES.reduce(function (all, r) { return all.concat(r.names); }, []));

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
  // Documented short names, matched exactly. Names only pwsh knows and that take a value stay out: Windows PowerShell 5.1
  // does not know them and runs the rest as command text, so skipping a "value" would hide it.
  const PS_CLI_ALIASES = new Map([['ep', true], ['wd', true], ['w', true], ['if', true], ['of', true],
    ['l', false], ['login', false], ['interactive', false]].map(x => [x[0], { name: x[0], takesValue: x[1], kind: 'option' }]));
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
    if (PS_CLI_ALIASES.has(parsed.name)) return PS_CLI_ALIASES.get(parsed.name);
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
    let start = 0, quote = null, groupDepth = 0, argumentParens = 0, redirectAt = -1;
    const emit = end => {
      const raw = c.slice(start, end), part = raw.trim();
      // from / to: where the part sits in the input, so a statement the splitter cut in two can be taken back whole
      if (part) { const from = start + (raw.length - raw.trimStart().length); out.push({ text: part, grouped: groupDepth > 0, from: from, to: from + part.length }); }
    };
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (quote) {
        if (isDialectEscape(ch, dialect, quote, c[i + 1]) && i + 1 < c.length) { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (isDialectEscape(ch, dialect, null, c[i + 1]) && i + 1 < c.length) { i++; continue; }
      // PowerShell comments (# to the end of the line, <# ... #>) hold no statements, and an apostrophe in one opens no quote
      if (dialect === 'powershell' && ch === '#' && (i === 0 || /\s/.test(c[i - 1]))) { while (i + 1 < c.length && c[i + 1] !== '\n' && c[i + 1] !== '\r') i++; continue; }
      if (dialect === 'powershell' && ch === '<' && c[i + 1] === '#') { const end = c.indexOf('#>', i + 2); i = end < 0 ? c.length : end + 1; continue; }
      if (isDialectQuote(ch, dialect)) { quote = ch; continue; }
      if (dialect === 'cmd' && (ch === '<' || ch === '>')) redirectAt = i;
      // Echo suppression precedes cmd group parsing: @(x) is still a group.
      // An escaped or quoted @ remains filename/data, handled above.
      if (dialect === 'cmd' && ch === '@' && !c.slice(start, i).trim()) { start = i + 1; continue; }
      if (dialect === 'cmd' && ch === '(') {
        if (!c.slice(start, i).trim()) { groupDepth++; start = i + 1; continue; }
        if (groupDepth) argumentParens++;
      }
      if (dialect === 'cmd' && ch === ')' && groupDepth) {
        if (argumentParens) { argumentParens--; continue; }
        emit(i); groupDepth--; start = i + 1; continue;
      }
      // Descriptor duplication is redirection, not a command separator. Only
      // the ampersand bound to a redirection operator and one descriptor is
      // consumed; a subsequent `& program` still creates a real head.
      if (dialect === 'cmd' && ch === '&' && redirectAt === i - 1
        && /^[0-9](?=\s|$|[&|<>;)])/.test(c.slice(i + 1))) continue;
      // PowerShell's call operator: an & with nothing before it in its statement is part of the statement it runs, not a separator
      if (dialect === 'powershell' && ch === '&' && c[i + 1] !== '&' && !c.slice(start, i).trim()) continue;
      if (ch === '&' || ch === '|' || ch === ';' || ch === '\r' || ch === '\n') {
        emit(i);
        while (i + 1 < c.length && /[&|;\r\n]/.test(c[i + 1])) i++;
        start = i + 1;
      }
    }
    emit(c.length);
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

  // Native wrappers reconstruct command SOURCE, not inert shell arguments. Cmd
  // may strip the opening/last quote of its /c tail; Windows PowerShell joins
  // native argv after -Command. Keep the proven plain and one-string forms, and
  // refuse mixed native quoting instead of treating its later quotes as data.
  function wrapperCommandArg(raw, outerDialect, innerDialect) {
    raw = String(raw == null ? '' : raw).trim();
    const oneQuoted = raw[0] === '"' && raw[raw.length - 1] === '"' && (raw.match(/"/g) || []).length === 2;
    let opaque = false;
    if (innerDialect === 'cmd' && raw[0] === '"' && !oneQuoted) opaque = true;
    if (innerDialect === 'powershell' && outerDialect === 'cmd' && raw.includes('"') && !oneQuoted) opaque = true;
    return { nested: opaque ? '' : unwrapCommandArg(raw, innerDialect), opaqueWrapper: opaque };
  }

  function parsePowerShellInvocation(segment, tokens, outerDialect) {
    if (tokens.length === 2 && /^--(?:version|help)$/i.test(String(tokens[1].value))) return { nested: '', opaque: false };
    for (let i = 1; i < tokens.length; i++) {
      const parsed = parsePowerShellFlag(tokens[i].value);
      if (!parsed) {
        // powershell.exe's default mode treats the first non-option token and everything after it as -Command.
        return wrapperCommandArg(String(segment).slice(tokens[i].start), outerDialect, 'powershell');
      }
      const opt = resolvePowerShellCliOption(parsed);
      if (!opt) return { nested: '', opaque: true };    // an option this cannot name may still run what follows: not read, so refused
      if (opt.kind === 'encoded') return { nested: '', opaque: true };
      if (opt.name === 'psconsolefile' && i > 1) return { nested: '', opaque: true };   // 5.1 reads it only as the first option
      if (opt.kind === 'command') {
        const rest = afterToken(segment, tokens[i]);
        const raw = parsed.hasInline ? parsed.inline + (rest ? ' ' + rest : '') : rest;
        return wrapperCommandArg(raw, outerDialect, 'powershell');
      }
      if (opt.kind === 'file' || opt.kind === 'help') return { nested: '', opaque: false };
      if (opt.takesValue && !parsed.hasInline) i++;
    }
    return { nested: '', opaque: false };
  }

  // The text as the shell that started cmd hands it on: an unquoted caret is removed and what it escaped stays. `at[n]` is where
  // character n of the result sits in the text given.
  function cmdCaretFree(text, shellIsCmd) {
    let seen = '', at = [], quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') quoted = !quoted;
      if (ch === '^' && !quoted && shellIsCmd && i + 1 < text.length) { i++; seen += text[i]; at.push(i); continue; }
      seen += ch; at.push(i);
    }
    return { seen, at };
  }
  /* cmd READS ITS OWN SWITCHES (read off the real cmd.exe on Windows 11, harmless echo bodies). From the text after its name it takes
     the first "/" followed by c, k or r in any case, through quotes, through junk before it, and with a caret in it written as the
     shell that started it removes it; everything after that letter is the command. So the switch is not a token of its own: /d/c,
     /q/s/c, /e:on/c and /t:07/c fuse it with other switches, /cecho and /c"echo" with what follows it, and /r is /c under another
     name. A switch built by expansion (%VAR%, !VAR!) ahead of the first one cannot be placed; that is refused, never read as
     absent. With no switch at all cmd runs nothing of the line's, and there is nothing nested. */
  function cmdWrapperBody(segment, tokens, outerDialect) {
    const tail = String(segment).slice(tokens[0].end);
    const free = cmdCaretFree(tail, outerDialect === 'cmd'), seen = free.seen, at = free.at;
    const found = /\/[ckr]/i.exec(seen);
    if (/[%!]/.test(found ? seen.slice(0, found.index) : seen)) return { nested: '', opaqueBody: true };
    if (!found) return { nested: '' };
    const invocation = wrapperCommandArg(tail.slice(at[found.index + 1] + 1), outerDialect, 'cmd');
    return { nested: invocation.nested, opaqueWrapper: invocation.opaqueWrapper };
  }

  /* ---- cmd statements whose tail is itself a command: if, for, forfiles ----
     The proof was chosen from the first word of each head, and if and for are cmd's own words, so `if 1==1 probe.exe` was a builtin
     and its program never met the PE header. Read off the real cmd.exe with echo bodies: cmd runs what follows the condition of an
     if (a command or a block, and after a block perhaps an else branch), what follows `do` in a for, the quoted command in the set of
     `for /f`, and the /c command of forfiles (which hands it to CreateProcess, and runs it with cmd.exe from its own folder when it
     names cmd). Each is analysed as the command it is. A header the guard cannot place the body after is refused as unreadable, not
     taken as empty: cmd ends a word at , ; = and at a space of any width, so `if 1==1,probe.exe` runs a body the guard would never
     see. `first` marks a body that runs before anything else the statement does (both branches of an if, the set command of a for),
     which is what lets a console program typed first and by itself keep the proof it always had. */
  const CMD_BLOCK_RE = /^(?:if|for)(?=\s)/i;
  const CMD_COMPARE_OPS = new Set(['equ', 'neq', 'lss', 'leq', 'gtr', 'geq']);
  // net unclosed parentheses in cmd text: a double quote protects, a caret escapes the next character
  function cmdParenBalance(text) {
    let depth = 0, quote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { quote = !quote; continue; }
      if (quote) continue;
      if (ch === '^') { i++; continue; }
      if (ch === '(') depth++; else if (ch === ')') depth--;
    }
    return depth;
  }
  // the index of the ) that closes the ( at `open`, or -1
  function cmdMatchingParen(text, open) {
    let depth = 0, quote = false;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { quote = !quote; continue; }
      if (quote) continue;
      if (ch === '^') { i++; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }
  function unquotedIndex(raw, needle) {
    let quote = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"') { quote = !quote; continue; }
      if (!quote && raw.startsWith(needle, i)) return i;
    }
    return -1;
  }
  // a header word whose end cmd and the guard agree on: outside quotes no comma, semicolon, caret or redirection, and no control
  // character or odd-width space (the word would not end where the guard thinks)
  function cleanHeaderWord(raw) {
    let quote = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') { quote = !quote; continue; }
      if (quote) continue;
      if (/[,;^<>|&]/.test(ch) || /[\p{C}\p{Z}]/u.test(ch)) return false;
    }
    return !quote;
  }
  // what an if runs after its condition: a command, or a block and then what follows it (an else branch)
  function cmdIfTail(rest) {
    rest = String(rest).trim();
    if (!rest) return [];
    if (rest[0] !== '(') return [rest];
    const close = cmdMatchingParen(rest, 0);
    if (close < 0) return [rest];
    const bodies = [rest.slice(0, close + 1)], after = rest.slice(close + 1), otherwise = /^\s*else(?=[\s(]|$)/i.exec(after);
    const other = (otherwise ? after.slice(otherwise[0].length) : after).trim();
    if (other) bodies.push(other);
    return bodies;
  }
  function cmdIfBodies(segment, tokens) {
    const unread = { bodies: [], opaque: true };
    if (tokens.length === 2 && tokens[1].value === '/?') return { bodies: [] };
    const lower = n => tokens[n] ? String(tokens[n].value).toLowerCase() : '';
    let i = 1;
    if (lower(i) === '/i') i++;
    if (lower(i) === 'not') i++;
    const from = i, kind = lower(i);
    let last;
    if (kind === 'exist' || kind === 'defined' || kind === 'errorlevel' || kind === 'cmdextversion') {
      if (!tokens[i + 1]) return unread;
      last = tokens[i + 1]; i += 2;
    } else {
      const a = tokens[i];
      if (!a) return unread;
      const eq = unquotedIndex(a.raw, '==');
      if (eq > 0 && a.raw.slice(eq + 2) !== '') { last = a; i += 1; }
      else if (eq > 0) { if (!tokens[i + 1]) return unread; last = tokens[i + 1]; i += 2; }
      else if (eq < 0) {
        const n = tokens[i + 1], m = tokens[i + 2];
        if (n && n.raw === '==') { if (!m) return unread; last = m; i += 3; }
        else if (n && n.raw.startsWith('==') && n.raw.length > 2) { last = n; i += 2; }
        else if (n && CMD_COMPARE_OPS.has(String(n.value).toLowerCase())) { if (!m) return unread; last = m; i += 3; }
        else return unread;
      } else return unread;
    }
    for (let n = from; n < i; n++) if (!cleanHeaderWord(tokens[n].raw)) return unread;
    return { bodies: cmdIfTail(String(segment).slice(last.end)).map(text => ({ text, first: true })) };
  }
  function cmdForBodies(segment, tokens) {
    const unread = { bodies: [], opaque: true };
    if (tokens.length === 2 && tokens[1].value === '/?') return { bodies: [] };
    const lower = n => tokens[n] ? String(tokens[n].value).toLowerCase() : '';
    const isVariable = t => !!t && /^%%?[^%\s]$/.test(String(t.value));
    let i = 1, fForm = false;
    while (tokens[i] && /^\/[dlfr]$/i.test(tokens[i].value)) {
      const sw = lower(i); i++;
      if (sw === '/f') fForm = true;
      if ((sw === '/f' || sw === '/r') && tokens[i] && !isVariable(tokens[i]) && lower(i) !== 'in') i++;   // its options string or root folder
    }
    if (!isVariable(tokens[i]) || lower(i + 1) !== 'in') return unread;
    for (let n = 1; n <= i + 1; n++) if (!cleanHeaderWord(tokens[n].raw)) return unread;
    const afterIn = String(segment).slice(tokens[i + 1].end).replace(/^\s+/, '');
    if (afterIn[0] !== '(') return unread;
    let close = -1, quote = false;
    for (let n = 1; n < afterIn.length; n++) {
      const ch = afterIn[n];
      if (ch === '"') { quote = !quote; continue; }
      if (quote) continue;
      if (ch === '^') { n++; continue; }
      if (ch === '(') return unread;   // cmd rejects an unquoted parenthesis inside the set
      if (ch === ')') { close = n; break; }
    }
    if (close < 0) return unread;
    const set = afterIn.slice(1, close), after = afterIn.slice(close + 1), doWord = /^\s*do(?=\s|$)/i.exec(after);
    if (!doWord) return unread;
    const bodies = [];
    let opaqueWrapper = false;
    if (fForm) {
      // a command in the set ('...' or `...`) is run first, by cmd /c, after the shell has removed its carets
      let q = false;
      for (let n = 0; n < set.length; n++) {
        const ch = set[n];
        if (ch === '"') { q = !q; continue; }
        if (q) continue;
        if (ch === '^') { n++; continue; }
        if (ch === "'" || ch === '`') {
          const end = set.indexOf(ch, n + 1);
          if (end < 0) return unread;
          const command = wrapperCommandArg(cmdCaretFree(set.slice(n + 1, end), true).seen, 'cmd', 'cmd');
          if (command.opaqueWrapper) opaqueWrapper = true;
          bodies.push({ text: command.nested, first: true });
          n = end;
        }
      }
      if (q) return unread;
    }
    const body = after.slice(doWord[0].length).trim();
    if (body) bodies.push({ text: body, first: !bodies.length });
    return { bodies, opaqueWrapper };
  }
  function forfilesBodies(segment, tokens) {
    const unread = { bodies: [], opaque: true };
    let command = null;
    for (let i = 1; i < tokens.length; i++) {
      const value = String(tokens[i].value), colon = /^\/c:([\s\S]*)$/i.exec(value);
      if (/^\/c$/i.test(value) || colon) {
        if (command !== null) return unread;           // /c once only: forfiles rejects a second, and so does the guard
        if (colon) command = colon[1];
        else { if (!tokens[i + 1]) return unread; command = String(tokens[i + 1].value); i++; }
      } else if (/^\/c/i.test(value)) return unread;   // /c fused with its command: forfiles rejects it, and so does the guard
    }
    if (command === null) return { bodies: [] };      // the default command is `cmd /c echo @file`
    if (/0x[0-9a-f]{2}/i.test(command)) return unread;   // forfiles turns 0xHH into that character, `&` among them
    const words = shellTokens(command, 'cmd');
    if (words.length && /^cmd(?:\.exe)?$/i.test(words[0].value)) {
      // forfiles starts cmd from its own folder, so this one is the real cmd.exe; what it is told to run is what matters
      const inner = cmdWrapperBody(command, words, 'posix');
      return { bodies: inner.nested ? [{ text: inner.nested, first: false }] : [], opaque: !!inner.opaqueBody, opaqueWrapper: !!inner.opaqueWrapper };
    }
    return { bodies: [{ text: command, first: false }] };
  }

  /* ---- PowerShell and sh: what a statement's first word is, and what runs inside it ----
     Read off the real PowerShell 5.1 with hostname.exe only. The command name is the first word with its quotes and backticks
     resolved (`host'name'` is hostname), ending at the first unquoted ( or { (each starts an argument or a block); an & or a . and a
     space in front of it say "run this". A word on its own that starts like a string, a variable or an expression is output, not a
     command; behind & or . it names a program only the running shell knows, and that is refused. The statements inside {...},
     (...), $(...) and @(...) run, so they are read as statements of their own. Start-Process, saps, start, Invoke-Item and ii open
     or launch whatever they are given (a file, a folder, a URL, an app registered under App Paths), which no search of PATH bounds. */
  const PS_WORD_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.\-+]*$/u;
  const PS_LAUNCHERS = new Set(['start-process', 'saps', 'start', 'invoke-item', 'ii']);
  function psCommandWord(raw) {
    let name = '', quote = null, expands = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quote === '"') {
        if (ch === '`') { expands = true; i++; continue; }   // an escape inside double quotes may be a control character
        if (ch === '$') expands = true;
        if (ch === '"') { if (raw[i + 1] === '"') { name += '"'; i++; } else quote = null; continue; }
        name += ch; continue;
      }
      if (quote === "'") {
        if (ch === "'") { if (raw[i + 1] === "'") { name += "'"; i++; } else quote = null; continue; }
        name += ch; continue;
      }
      if (ch === '`' && i + 1 < raw.length) { name += raw[++i]; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '$') expands = true;
      if (ch === '(' || ch === '{') break;
      name += ch;
    }
    return { name, expands };
  }
  // -> { kind: 'word' (a name PATH may hold) | 'path' (a path, unproven) | 'none' (not a program), name, dynamic }
  function foreignCommandKind(token, dialect, callOp) {
    if (dialect === 'powershell') {
      const raw = String(token.raw), first = raw[0];
      if (first === '{') return { kind: 'none' };                                      // a script block: its statements are read on their own
      if ('$([@'.includes(first)) return { kind: 'none', dynamic: callOp };           // a variable or an expression
      if ((first === '"' || first === "'") && !callOp) return { kind: 'none' };         // a string on its own is output
      const word = psCommandWord(raw);
      if (word.expands) return { kind: 'none', dynamic: callOp };
      const name = word.name;
      if (/[\\/]/.test(name)) return /^[\w.]+\\[A-Za-z]+-[A-Za-z]+$/.test(name) ? { kind: 'none' } : { kind: 'path', name };   // Module\Verb-Noun is a cmdlet
      if (/^[A-Za-z]:/.test(name) || name[0] === '~') return { kind: 'path', name };
      return PS_WORD_RE.test(name) ? { kind: 'word', name } : { kind: 'none' };
    }
    const value = String(token.value);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return { kind: 'none' };               // sh: an assignment
    if (/[\\/]/.test(value)) return { kind: 'path', name: value };
    return PS_WORD_RE.test(value) ? { kind: 'word', name: value } : { kind: 'none' };
  }
  // the statements inside the top-level {...}, (...), $(...) and @(...) of PowerShell text; ${name} holds none, a hashtable's values may
  function psInnerStatements(text) {
    const out = [];
    const closeOf = (s, open) => {
      const o = s[open], c = o === '{' ? '}' : ')';
      let depth = 0, quote = null;
      for (let i = open; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
          if (quote === '"' && ch === '`') { i++; continue; }
          if (ch === quote) { if (s[i + 1] === quote) { i++; continue; } quote = null; }
          continue;
        }
        if (ch === '`') { i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === o) depth++;
        else if (ch === c) { depth--; if (depth === 0) return i; }
      }
      return -1;
    };
    const scan = s => {
      let quote = null;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
          if (quote === '"' && ch === '`') { i++; continue; }
          if (ch === quote) { if (s[i + 1] === quote) { i++; continue; } quote = null; }
          continue;
        }
        if (ch === '`') { i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(' || ch === '{') {
          const close = closeOf(s, i), inner = s.slice(i + 1, close < 0 ? s.length : close);
          if (ch === '{' && s[i - 1] === '$') { /* ${variable name} */ }
          else if (ch === '{' && s[i - 1] === '@') scan(inner);
          else out.push(inner);
          if (close < 0) return;
          i = close;
        }
      }
    };
    scan(String(text));
    return out;
  }

  /* `lead`: this text's first head is the first thing the command runs (the whole command's first head, or a body that runs first
     in a statement that does). `inherited`: the text sits inside a group already. */
  function analyzeCommands(cmd, depth, dialect, lead, inherited) {
    dialect = normalizeDialect(dialect);
    const result = { heads: [], opaquePowerShell: false, opaqueWrapper: false, opaqueBody: false };
    const text = String(cmd == null ? '' : cmd);
    // nested deeper than this reads: refused, never left unjudged
    if ((depth || 0) > 8) { if (text.trim()) result.opaqueBody = true; return result; }
    const leadIn = lead === undefined ? !depth : lead === true;
    const parts = splitCommandSegments(text, dialect);
    const take = child => {
      result.heads.push.apply(result.heads, child.heads);
      if (child.opaquePowerShell) result.opaquePowerShell = true;
      if (child.opaqueWrapper) result.opaqueWrapper = true;
      if (child.opaqueBody) result.opaqueBody = true;
    };
    for (let k = 0; k < parts.length; k++) {
      let part = parts[k];
      const firstPart = k === 0;
      // an if / for whose parenthesised body holds a separator reached the splitter in pieces: take the statement back whole
      if (dialect === 'cmd' && CMD_BLOCK_RE.test(part.text.replace(/^(?:@\s*)+/, '')) && cmdParenBalance(part.text) > 0) {
        let to = part.to;
        while (k + 1 < parts.length && cmdParenBalance(text.slice(part.from, to)) > 0) { k++; to = parts[k].to; }
        part = { text: text.slice(part.from, to), grouped: part.grouped, from: part.from, to: to };
      }
      let segment = part.text.replace(dialect === 'cmd' ? /^(?:@\s*)+/ : /$^/, '');
      // PowerShell: an & or a . and a space in front of a statement say "run what follows"; the head is what follows
      let callOp = false;
      if (dialect === 'powershell') {
        const call = /^(?:&|\.(?=\s))\s*/.exec(segment);
        if (call) { callOp = true; segment = segment.slice(call[0].length); }
      }
      const tokens = shellTokens(segment, dialect);
      if (!tokens.length) continue;
      const own = { text: segment, dialect: dialect, grouped: part.grouped || inherited === true, lead: leadIn && firstPart };
      result.heads.push(own);
      if (dialect === 'powershell' || dialect === 'posix') {
        // what kind of word starts the statement, for the PATH proof; a target only the running shell knows is refused
        const kind = foreignCommandKind(tokens[0], dialect, callOp);
        own.psKind = kind.kind; own.psName = kind.name;
        if (kind.dynamic) result.opaqueBody = true;
      }
      const verb = exeName(tokens[0].value);
      if (dialect === 'powershell' && PS_LAUNCHERS.has(verb)) own.launcher = true;
      let nested = '', nestedDialect = dialect, bodies = [];
      if (verb === 'cmd' || verb === 'cmd.exe') {
        const invocation = cmdWrapperBody(segment, tokens, dialect);
        nestedDialect = 'cmd'; nested = invocation.nested;
        if (invocation.opaqueWrapper) result.opaqueWrapper = true;
        if (invocation.opaqueBody) result.opaqueBody = true;
      } else if (dialect === 'cmd' && (verb === 'if' || verb === 'for' || verb === 'forfiles' || verb === 'forfiles.exe')) {
        const parsed = verb === 'if' ? cmdIfBodies(segment, tokens) : verb === 'for' ? cmdForBodies(segment, tokens) : forfilesBodies(segment, tokens);
        bodies = parsed.bodies;
        if (parsed.opaque) result.opaqueBody = true;
        if (parsed.opaqueWrapper) result.opaqueWrapper = true;
      } else if (verb === 'call') {
        nestedDialect = 'cmd'; nested = afterToken(segment, tokens[0]);
      } else if (verb === 'start-process' || verb === 'saps') {
        nestedDialect = dialect === 'powershell' ? 'powershell' : dialect;
        nested = startProcessTarget(segment, tokens);
      } else if (verb === 'powershell' || verb === 'powershell.exe' || verb === 'pwsh' || verb === 'pwsh.exe') {
        const invocation = parsePowerShellInvocation(segment, tokens, dialect);
        nestedDialect = 'powershell'; nested = invocation.nested;
        if (invocation.opaque) result.opaquePowerShell = true;
        if (invocation.opaqueWrapper) result.opaqueWrapper = true;
      } else if (/^(?:sh|bash|zsh|dash|ksh)(?:\.exe)?$/.test(verb)) {
        // -c wherever it sits among the options, alone or in a cluster (-lc, -ec): the next word is the command string
        const i = tokens.findIndex((t, n) => n > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(t.value));
        if (i >= 0) { nestedDialect = 'posix'; nested = unwrapCommandArg(afterToken(segment, tokens[i]), nestedDialect); }
      }
      if (nested) take(analyzeCommands(nested, (depth || 0) + 1, nestedDialect, false, own.grouped));
      if (dialect === 'powershell') for (const inner of psInnerStatements(segment)) take(analyzeCommands(inner, (depth || 0) + 1, 'powershell', false, own.grouped));
      // a body that runs first in a statement that runs first is the first command, and a group makes nothing provable
      for (const body of bodies) take(analyzeCommands(body.text, (depth || 0) + 1, 'cmd', own.lead && body.first, own.grouped));
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
  // Process.Start is how C# and Python reach a launcher; PowerShell spells it [Diagnostics.Process]::Start(...), and reaches the same
  // launchers through COM (WScript.Shell, Shell.Application) and WMI (Win32_Process.Create).
  const OPAQUE_LAUNCH_RE = /\b(?:Invoke-Expression|iex|Invoke-Command|DownloadString|FromBase64String|Reflection\.Assembly|ShellExecute|os\.startfile|Process(?:\]::|\.)Start|WScript\.Shell|Shell\.Application|Invoke-WmiMethod|Invoke-CimMethod|iwmi)\b/i;
  // GUI/native runtimes are judged as PROGRAMS, never as words (issue #50: a `// ...before each write` comment and
  // `process.stdout.write()` both used to refuse a plain Node script). `write`/`calc` are also ordinary English and
  // identifiers, so they count only as a command head or an explicit launch; the distinctive names count anywhere a
  // command token or a quoted launch string starts with them.
  const GUI_PROGRAMS = new Set(['electron', 'nw', 'nwjs', 'rundll32', 'wscript', 'cscript', 'mshta', 'notepad', 'wordpad', 'mspaint', 'calc', 'write']);
  const GUI_AMBIGUOUS = new Set(['calc', 'write', 'nw']);
  const GUI_PAIR_RE = /^(?:cargo(?:\.exe)?\s+run|dotnet(?:\.exe)?\s+run|javaw?(?:\.exe)?\s+-jar)(?:\s|$)/i;
  const GUI_DISTINCT = 'electron|nwjs|rundll32|wscript|cscript|mshta|notepad|wordpad|mspaint';
  // a quoted string whose first word is the program: spawn('notepad'), execSync(`electron .`), ["mshta", ...], 'C:\\x\\notepad.exe'
  const GUI_CODE_STRING_RE = new RegExp('["\'`]\\s*(?:[^"\'`\\s]*[\\\\/])?(?:(?:' + GUI_DISTINCT + ')(?:\\.exe)?|(?:calc|write)\\.exe)(?=["\'`\\s])' +
    '|["\'`]\\s*(?:cargo(?:\\.exe)?\\s+run|dotnet(?:\\.exe)?\\s+run|javaw?(?:\\.exe)?\\s+-jar)\\b', 'i');
  // the ambiguous names only as the direct target of a process-launch call: os.system("calc"), spawn('write', ...)
  const GUI_CODE_CALL_RE = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync|execCommand|system|popen|Popen|call|check_call|check_output|run|Command::new|Command|Start-Process)\s*\(?\s*\[?\s*["'`](?:[^"'`\s]*[\\/])?(?:calc|write)(?:\.exe)?["'`\s]/i;
  const INERT_HEADS = new Set(['echo', 'rem', 'printf', 'write-host', 'write-output', 'write-verbose', 'write-information', 'type', 'cat', 'more', 'less', 'grep', 'rg', 'findstr', 'select-string', 'git']);
  const INLINE_EVAL_HEAD_RE = /^(?:node|python\d*|py|ruby|php|bun|deno|perl)(?:\.exe)?$/i;
  const INLINE_EVAL_FLAG_RE = /^(?:-e|-c|-p|-r|--eval|--print|eval)$/i;
  function bareProgram(value) { return exeName(String(value == null ? '' : value).trim().split(/\s+/)[0]).replace(/\.(?:exe|com|cmd|bat)$/i, ''); }
  function guiRuntimeInCommand(text, dialect) {
    for (const head of commandHeads(text, dialect)) {
      const tokens = headTokens(head);
      if (!tokens.length) continue;
      const verb = bareProgram(tokens[0].value);
      if (INERT_HEADS.has(verb)) continue;
      if (GUI_PROGRAMS.has(verb)) return true;
      const values = tokens.map(t => String(t.value));
      if (GUI_PAIR_RE.test(values.join(' '))) return true;
      // launchers and wrappers put the real program later: `npx electron .`, `cross-env X=1 electron .`,
      // `concurrently "vite" "electron ."`, `wait-on :3000 && cargo run`
      for (let i = 1; i < values.length; i++) {
        const prog = bareProgram(values[i]);
        if (GUI_PROGRAMS.has(prog) && !GUI_AMBIGUOUS.has(prog)) return true;
        if (GUI_PAIR_RE.test(values[i]) || GUI_PAIR_RE.test(values.slice(i).join(' '))) return true;
      }
      // inline interpreter code (`node -e "...exec('notepad')"`) is code, not a list of arguments
      if (INLINE_EVAL_HEAD_RE.test(verb) && tokens.slice(1).some(t => INLINE_EVAL_FLAG_RE.test(t.value)) && guiRuntimeInCode(head.text)) return true;
    }
    return false;
  }
  function guiRuntimeInCode(text) { return GUI_CODE_STRING_RE.test(text) || GUI_CODE_CALL_RE.test(text); }
  const LOCAL_PROGRAM_RE = /^(?:"[^"]*\.exe"(?:\s|$)|'[^']*\.exe'(?:\s|$)|(?:"|')?(?:(?:\.\\|\.\/)[^\s"']+|[^\s"']+\.exe)(?:"|'|\s|$))/i;
  /* A LOCAL PROGRAM IS JUDGED BY WHAT IT IS, NOT HOW IT IS SPELLED (GitHub #167). This floor keeps a task off the
     person's desktop, and it read every head spelled `x.exe` or `.\x` as a GUI runtime: `git.exe status` and
     `python.exe -m py_compile a.py` were refused while `git status` and `python -m py_compile a.py` ran. On Windows the
     file answers for itself: the PE header's subsystem says whether it was built as a console tool.
     - A console program is then judged again under its bare spelling (`tools\python.exe a.py` as `python a.py`), so the
       program, code-file and browser floors read it exactly as they read the bare spelling.
     - A GUI program is refused. Cmd's bare names resolve through cwd/PATHEXT/PATH before the same proof; normalized
       carets and command groups cannot skip it. Cmd builtins remain builtins, and resolved batch shims retain source scans.
     - Everything unproven stays refused: a file we cannot see or read, a store alias, not a PE, a `.\x` not spelled
       .exe, every POSIX `./x`, a network path (reading one would reach the network before consent, and can stall the
       station for seconds), a PATHEXT copy that would run first (`x.exe.cmd`), a head with `/` under cmd (which reads
       it as a switch), a caller that cannot say the folder the command really runs in (typing into a live shell), and
       a program after anything else in a chain, because `cd sub & x.exe` runs a file this check never read, and one
       inside a wrapper, because the wrapper re-reads its text.
     NOT PROVEN by this check: a console program can still open a window itself (the residual the owner accepted on
     2026-11-01), and command-source scans are bounded. This is a guard against accidents, not OS containment. */
  const PE_SUBSYSTEM_GUI = 2, PE_SUBSYSTEM_CONSOLE = 3;
  const EXECUTION_POLICIES = /^(?:restricted|allsigned|remotesigned|unrestricted|bypass|undefined|default)$/i;
  function peSubsystem(file, fs) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const read = (at, n) => { const b = Buffer.alloc(n); return fs.readSync(fd, b, 0, n, at) === n ? b : null; };
      const dos = read(0, 64);
      if (!dos || dos.toString('latin1', 0, 2) !== 'MZ') return null;
      const pe = dos.readUInt32LE(0x3c);
      if (pe < 64 || pe > (1 << 20)) return null;
      // signature (4) + COFF header (20) + the optional header up to and including Subsystem, at 68 in PE32 and PE32+ alike
      const head = read(pe, 4 + 20 + 70);
      if (!head || head.toString('latin1', 0, 4) !== 'PE\0\0') return null;
      const magic = head.readUInt16LE(24);
      if (magic !== 0x10b && magic !== 0x20b) return null;
      return head.readUInt16LE(24 + 68);
    } catch (_) { return null; } finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) { shellFailNote('shell.pe-close', e); } } }
  }
  const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
  /* WHICH ENVIRONMENT, AND HOW IT IS READ. A search is only as true as the environment it reads, so the caller says which one the
     command will run with (opts.env: the local backend's own snapshot, a terminal's PTY env, an injected one) and process.env is
     the answer only when it says nothing. Windows names its variables without regard to case; a copied environment is a plain
     object that does not, so a name is found whatever its case. */
  function envEntry(env, name) {
    if (!env) return undefined;
    if (env[name] != null) return env[name];
    const want = name.toLowerCase();
    for (const k of Object.keys(env)) if (k.toLowerCase() === want && env[k] != null) return env[k];
    return undefined;
  }
  // Read off the real cmd.exe: defined (a value of any length, even none) takes the working folder out of the search for a bare name.
  function cmdSkipsCwd(env) { return envEntry(env, 'NoDefaultCurrentDirectoryInExePath') !== undefined; }
  // These names are cmd's internal commands, not an executable-policy allowlist.
  // In particular, a cwd echo.exe cannot replace cmd's own `echo` command.
  const CMD_BUILTINS = new Set(('assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol').split(' '));
  function isCmdSearchHead(head, value) {
    // Spaces, Unicode and dotted basenames are valid filenames too. There is
    // no lexical exemption for a name the resolver cannot establish.
    return head.dialect === 'cmd' && !!value && !CMD_BUILTINS.has(value.toLowerCase());
  }
  // 'file' | 'absent' | 'unknown'. Only a clear "not there" is absent: a store alias answers EACCES and may be what runs.
  function probeFile(file, fs) {
    try { return fs.statSync(file).isFile() ? 'file' : 'absent'; }
    catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'absent' : 'unknown'; }
  }
  // Resolve the FIRST executable candidate, in cmd's own order: the working folder, then PATH (the working folder is out of the
  // search when the command's environment defines NoDefaultCurrentDirectoryInExePath), each folder in PATHEXT order.
  // An unreadable earlier candidate (or network path) cannot be vouched for by
  // a later console copy. Never stat a network path while deciding consent.
  function cmdProgramFile(value, opts) {
    const P = opts.pathMod, env = opts.env || process.env;
    // Explicit .exe paths keep their existing proof. Other paths or dynamic
    // names cannot silently become an uninspected bare invocation. cmd ends a program name at , ; = ( and at a space of any
    // width or a control character (`probe,x` runs probe.exe with the argument ,x), so a name holding one is not a file whose
    // name can be looked up as it is spelled.
    if (/[\\/:%!"<>|?*,;=(\u0000-\u001f\u007f-\u009f]/.test(value) || /[. ]$/.test(value) || /[\p{Z}\p{Cf}]/u.test(value.replace(/ /g, ''))) return { status: 'unknown' };
    const rawPath = String(envEntry(env, 'PATH') != null ? envEntry(env, 'PATH') : '');
    const exts = String(envEntry(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').map(e => e.trim()).filter(Boolean);
    if (rawPath.includes('"') || !exts.length || exts.some(e => !/^\.[A-Za-z0-9]+$/.test(e))) return { status: 'unknown' };
    const noCwd = cmdSkipsCwd(env);
    // an empty PATH entry reads as the working folder; whether cmd still does with the folder switched off is not known
    return searchFolders(value, opts, (noCwd ? [] : [opts.cwd]).concat(rawPath.split(P.delimiter)), noCwd ? '' : opts.cwd, exts);
  }
  // The walk both searches share: each folder in turn, the name tried exactly when it has an extension and then with each extension.
  // `blank` is what an empty entry stands for ('' = unknown).
  function searchFolders(value, opts, entries, blank, exts) {
    const fs = opts.fs, P = opts.pathMod;
    for (const entry of entries) {
      const dir = String(entry || blank || '').trim();
      if (!dir) return { status: 'unknown' };
      const folder = P.resolve(opts.cwd, dir);
      if (/^[\\/]{2}/.test(folder)) return { status: 'unknown' };
      const file = P.join(folder, value);
      // Native cmd ignores an extensionless raw file in favor of PATHEXT.
      // A dotted filename is tried exactly before appended extensions. The
      // real Windows competing-marker fixture pins both directions.
      const hasExtension = value.includes('.');
      for (const candidate of (hasExtension ? [file] : []).concat(exts.map(ext => file + ext))) {
        const status = probeFile(candidate, fs);
        if (status === 'unknown') return { status };
        if (status === 'file') return { status, file: candidate };
      }
      // A remaining raw extensionless file is not a console proof. Do not
      // infer runnable-file semantics outside the demonstrated search case.
      if (!hasExtension && probeFile(file, fs) !== 'absent') return { status: 'unknown' };
    }
    return { status: 'absent' };
  }
  /* PowerShell (and an sh started from a cmd line) look for a bare command name along PATH only, never in the working folder (read
     off the real PowerShell 5.1: a copy beside the command is "not recognized"). Each folder is tried in PATHEXT order, and a .ps1
     script of that name ahead of them; a relative entry such as `.` is read from the folder the command runs in. The name has been
     read as a plain word already (psKind); an empty PATH holds nothing, an empty entry among others is not known. */
  function pathProgramFile(value, opts, scripts) {
    const env = opts.env || process.env, P = opts.pathMod;
    const rawPath = String(envEntry(env, 'PATH') != null ? envEntry(env, 'PATH') : '');
    const exts = String(envEntry(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').map(e => e.trim()).filter(Boolean);
    if (rawPath.includes('"') || !exts.length || exts.some(e => !/^\.[A-Za-z0-9]+$/.test(e)) || /[. ]$/.test(value)) return { status: 'unknown' };
    if (!rawPath.trim()) return { status: 'absent' };
    return searchFolders(value, opts, rawPath.split(P.delimiter), '', (scripts ? ['.ps1'] : []).concat(exts));
  }
  function commandScript(file, fs) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > (2 << 20)) return null;
      return { text: String(fs.readFileSync(file, 'utf8')) };
    } catch (_) { return null; }
  }
  /* Every file this head could run, or null when that cannot be proven. A bare `git.exe` is cmd's current folder first
     and then PATH, so both are read: one console copy must not vouch for a GUI one beside the command. cmd leaves the
     working folder out when the command's environment defines NoDefaultCurrentDirectoryInExePath, and PowerShell never
     searches it for a bare name, so there only PATH is read. */
  function localProgramFiles(value, opts) {
    const fs = opts.fs, P = opts.pathMod, cwd = opts.cwd, env = opts.env || process.env;
    if (value.includes('/') && opts.dialect !== 'powershell') return null;
    const exts = String(envEntry(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').map(e => e.trim()).filter(Boolean);
    const look = file => {
      if (/^[\\/]{2}/.test(file)) return 'unknown';
      const direct = probeFile(file, fs);
      if (direct === 'unknown') return 'unknown';
      for (const ext of exts) if (probeFile(file + ext, fs) !== 'absent') return 'unknown';
      return direct;
    };
    if (/[\\/:]/.test(value)) { const f = P.resolve(cwd || '.', value); return look(f) === 'file' ? [f] : null; }
    const rawPath = String(envEntry(env, 'PATH') != null ? envEntry(env, 'PATH') : '');
    if (rawPath.includes('"')) return null;
    const out = [], onPath = rawPath.split(P.delimiter);
    const lead = opts.dialect === 'powershell' || cmdSkipsCwd(env) ? 0 : 1;   // 1 when the working folder is searched first
    for (const [i, entry] of (lead ? [cwd] : []).concat(onPath).entries()) {
      const dir = String(entry || '').trim();
      if (!dir) continue;
      // a relative PATH entry is read from the folder the command runs in
      const f = P.join(P.resolve(cwd || '.', dir), value), seen = look(f);
      if (seen === 'unknown') return null;
      if (seen === 'file') { out.push(f); if (i >= lead) break; }
    }
    return out.length ? out : null;
  }
  const GUI_RUNTIME_REFUSAL = 'launches a GUI/native runtime on the user\'s interactive desktop';
  const UNPROVEN_PROGRAM_REFUSAL = 'runs a local program StarNet could not confirm is a console tool, so it may open a window on the user\'s desktop. Use shell.exec with a known working directory and one existing console program as its own command, not after other commands in a chain or inside a shell wrapper/group. A live terminal write cannot prove its current directory; scripts still need readable source, for example `python x.py` or `powershell -File x.ps1`';
  // `^&`, a backtick, `$(...)` or a PowerShell `(...)` argument can run another command this parse does not split out.
  // A caret before anything but an operator or a quote is data: `git.exe show HEAD^`. `^"` flips the quoting a later parse sees.
  // Read in any dialect and inside quotes on purpose: the first head can itself be a wrapper spelled .exe, whose text is
  // re-read. So `git.exe commit -m "a `b`"` is refused where `git commit` with the same words runs. That costs a respelling.
  function mayHideACommand(head) {
    const text = String(head.text);
    if (/\^[&|<>^"]|`|\$\(/.test(text)) return true;
    return head.dialect === 'powershell' && /\(/.test(afterToken(text, headTokens(head)[0] || { end: 0 }));
  }
  /* A head reaches its proof only as the first command, typed directly. No wrapper vouches for one: `cmd /c x` and `powershell -c x`
     re-read their text, so what they run next cannot be proven from here. A program spelled as local stays refused there. */
  function nothingRunsFirst(heads, index) {
    return heads[index].lead === true && !heads[index].grouped && !mayHideACommand(heads[index]);
  }
  /* A bare word PowerShell (or an sh started from a cmd line) runs is found along PATH, wherever in the line it stands: no earlier
     statement of the same line is read to change PATH, and the working folder is not on it. Its file answers for it: a console
     program runs, a GUI one is refused, a batch shim must be readable (and its source is scanned), a .ps1 script, a file that is
     neither, and anything the search cannot establish are unproven. A word PATH does not hold is a cmdlet, an alias or an error:
     nothing runs from a file. */
  function namedProgramRefusal(head, opts) {
    if (!opts.fs || !opts.pathMod || !opts.cwd || !opts.pathMod.isAbsolute(opts.cwd)) return UNPROVEN_PROGRAM_REFUSAL;
    const resolved = pathProgramFile(head.psName, opts, head.dialect === 'powershell');
    if (resolved.status === 'absent') return null;
    if (resolved.status !== 'file') return UNPROVEN_PROGRAM_REFUSAL;
    if (/\.(?:cmd|bat)$/i.test(resolved.file)) return commandScript(resolved.file, opts.fs) ? null : UNPROVEN_PROGRAM_REFUSAL;
    const kind = peSubsystem(resolved.file, opts.fs);
    if (kind === PE_SUBSYSTEM_GUI) return GUI_RUNTIME_REFUSAL;
    return kind === PE_SUBSYSTEM_CONSOLE ? null : UNPROVEN_PROGRAM_REFUSAL;
  }
  function localProgramRefusal(heads, index, opts) {
    const head = heads[index];
    // Start-Process, saps, start, Invoke-Item and ii launch what they are given: a file, a folder, a URL, an app registered under
    // App Paths. No search of PATH bounds that, so whatever they are given is unproven.
    if (head && head.launcher === true) return UNPROVEN_PROGRAM_REFUSAL;
    const text = head && head.text != null ? head.text : String(head || '');
    const isWin = opts.isWin !== undefined ? opts.isWin : process.platform === 'win32';
    const first = headTokens(head)[0] || {};
    const value = String(first.value || '');
    const explicit = LOCAL_PROGRAM_RE.test(text) || /\.exe$/i.test(value);
    const searched = isWin && isCmdSearchHead(head, value);
    // PowerShell, and an sh started from a cmd line, on a Windows host (a whole line in sh is another host's affair)
    const foreign = isWin && !explicit && (head.dialect === 'powershell' || head.dialect === 'posix') && normalizeDialect(opts.dialect) !== 'posix';
    if (foreign && head.psKind === 'path') return UNPROVEN_PROGRAM_REFUSAL;
    if (foreign && head.psKind === 'word') return namedProgramRefusal(head, opts);
    if (!explicit && !searched) return null;
    // counts every head, siblings too: a stand-in for the nesting analyzeCommands reads (depth 8), past which a head goes unjudged
    if (!isWin || opts.exactCwd !== true || opts.dialect === 'posix' || !opts.fs || !opts.pathMod || !opts.cwd || !opts.pathMod.isAbsolute(opts.cwd) || heads.length > 8
      || !nothingRunsFirst(heads, index)) return UNPROVEN_PROGRAM_REFUSAL;
    let found;
    if (!explicit && searched) {
      const resolved = cmdProgramFile(value, opts);
      if (resolved.status === 'absent') return null; // nothing can run under this known search context
      if (resolved.status !== 'file') return UNPROVEN_PROGRAM_REFUSAL;
      if (/\.(?:cmd|bat)$/i.test(resolved.file)) return commandScript(resolved.file, opts.fs) ? null : UNPROVEN_PROGRAM_REFUSAL;
      found = [resolved.file];
    } else {
      if (!/\.exe$/i.test(value)) return UNPROVEN_PROGRAM_REFUSAL;
      found = localProgramFiles(value, Object.assign({}, opts, { dialect: head.dialect || opts.dialect }));
    }
    if (!found) return UNPROVEN_PROGRAM_REFUSAL;
    const kinds = found.map(f => peSubsystem(f, opts.fs));
    if (kinds.some(k => k === PE_SUBSYSTEM_GUI)) return GUI_RUNTIME_REFUSAL;
    if (!kinds.every(k => k === PE_SUBSYSTEM_CONSOLE)) return UNPROVEN_PROGRAM_REFUSAL;
    const bare = exeName(value).replace(/\.exe$/i, '') + ' ' + afterToken(text, first);
    // Only this head's own floors: the caller's loop walks every nested head itself, so this must not prove them again.
    return inputIsolationRisk(bare, Object.assign({}, opts, { dialect: head.dialect || opts.dialect, floorsOnly: true }));
  }
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
  // Each source records what it IS: `shell` text (the command, npm scripts, .cmd/.bat/.sh/.ps1 files) is judged
  // by the programs its command heads launch; `code` text (a referenced .mjs/.py/...) is judged only by launch
  // strings inside it. A word in a code comment is not a process launch (issue #50: "// ...before each write").
  function sourceKindOf(rel) {
    if (/\.(?:cmd|bat)$/i.test(rel)) return { kind: 'shell', dialect: 'cmd' };
    if (/\.ps1$/i.test(rel)) return { kind: 'shell', dialect: 'powershell' };
    if (/\.(?:sh|bash)$/i.test(rel)) return { kind: 'shell', dialect: 'posix' };
    return { kind: 'code', dialect: null };
  }
  function commandSources(cmd, opts) { return commandSourceEntries(cmd, opts).map(e => e.text); }
  function commandSourceEntries(cmd, opts) {
    opts = opts || {};
    const fs = opts.fs, P = opts.pathMod, cwd = opts.cwd, dialect = opts.dialect;
    const queue = [{ text: String(cmd || ''), baseDir: cwd, kind: 'shell', dialect: dialect }], out = [], seen = new Set(), packageCache = new Map();
    function enqueue(text, baseDir, kind, srcDialect) {
      if (text != null && String(text)) queue.push({ text: String(text), baseDir, kind: kind || 'shell', dialect: srcDialect || dialect });
    }
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
      seen.add(seenKey); out.push({ text: text, kind: entry.kind || 'shell', dialect: entry.dialect || dialect });
      // Preserve the established outer-dialect source scan: shell-like text
      // inside referenced code and comments still follows the same bounded
      // queue. The new resolved batch source does not change that contract.
      for (const parsedHead of commandHeads(text, dialect)) {
        const head = (parsedHead && parsedHead.text != null ? parsedHead.text : String(parsedHead || '')).replace(/^\s*@/, '');
        // A bare developer shim is still a script. Resolve its actual first
        // file, then feed its bytes through the existing shell-source scans.
        const firstValue = String((headTokens(parsedHead)[0] || {}).value || '');
        const isWin = opts.isWin !== undefined ? opts.isWin : process.platform === 'win32';
        if (qi === 0 && parsedHead.lead === true && !opts.floorsOnly && isWin && opts.exactCwd === true && fs && P && cwd && P.isAbsolute(cwd)
          && !parsedHead.grouped && isCmdSearchHead(parsedHead, firstValue)) {
          const resolved = cmdProgramFile(firstValue, opts);
          if (resolved.status === 'file' && /\.(?:cmd|bat)$/i.test(resolved.file)) {
            const script = commandScript(resolved.file, fs);
            if (script) enqueue(script.text, baseDir, 'shell', 'cmd');
          }
        }
        // the same for a bare word PowerShell or sh finds along PATH, wherever in the line it stands
        if (qi === 0 && parsedHead.psKind === 'word' && !parsedHead.launcher && !opts.floorsOnly && isWin && fs && P && cwd && P.isAbsolute(cwd)
          && (parsedHead.dialect === 'powershell' || parsedHead.dialect === 'posix') && normalizeDialect(dialect) !== 'posix') {
          const resolved = pathProgramFile(parsedHead.psName, opts, parsedHead.dialect === 'powershell');
          if (resolved.status === 'file' && /\.(?:cmd|bat)$/i.test(resolved.file)) {
            const script = commandScript(resolved.file, fs);
            if (script) enqueue(script.text, baseDir, 'shell', 'cmd');
          }
        }
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
          if (src) { const k = sourceKindOf(rel); enqueue(src, baseDir, k.kind, k.dialect); }
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
    const analysis = analyzeCommands(c, 0, dialect);
    if (analysis.opaqueWrapper || analysis.opaqueBody) return UNPROVEN_PROGRAM_REFUSAL;
    const heads = analysis.heads;
    if (heads.some(h => BROWSER_NAMES.has(exeName((headTokens(h)[0] || {}).value)))) {
      return 'launches a browser outside StarNet\'s synthetic-input CDP sandbox — use browser.test_navigate/browser.test_input';
    }
    const entries = commandSourceEntries(c, opts);
    const sources = entries.map(e => e.text);
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
    if (entries.some(e => e.kind === 'code' ? guiRuntimeInCode(e.text) : guiRuntimeInCommand(e.text, e.dialect))) return GUI_RUNTIME_REFUSAL;
    if (!opts.floorsOnly) for (let i = 0; i < heads.length; i++) { const refusal = localProgramRefusal(heads, i, opts); if (refusal) return refusal; }
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
    { re: /^(?:Stop-Computer|Restart-Computer|Suspend-Computer|Register-ScheduledTask|New-ScheduledTask\w*|Stop-Process|Stop-Service|New-Service|Set-Service|Set-Date|Add-Computer|Set-NetFirewall\w+|Disable-NetAdapter|Set-DisplayResolution|Set-Clipboard)(?=\s|$)/i, why: 'PowerShell cmdlet that alters machine or interactive-session state' }
  ];
  /* The one machine-state exception (GitHub #163). `Set-ExecutionPolicy -Scope Process` lasts only as long as the one
     PowerShell process and writes nothing to the machine, the same reach as `powershell -ExecutionPolicy X -File y`,
     which already runs. Only the plain shape passes, spelled as the cmdlet's own name: another scope, a shortened -Sc,
     a variable, a splat or a parameter this does not know is judged as the persistent form it could be. And the whole
     command must mention the cmdlet exactly as often as plain heads were read: text the lexer did not resolve into a
     head (`"Set-ExecutionPolicy -Scope Process X;" "Set-ExecutionPolicy Y"`) cancels the exception, and so does anything
     that can build or find a command name: a backtick, +, a wildcard, $, a group or block, or Invoke-Expression. */
  function processOnlyExecutionPolicy(head) {
    const tokens = headTokens(head).map(t => String(t.value));
    if (!/^set-executionpolicy$/i.test(tokens[0] || '')) return false;
    let scope = 0, policy = 0;
    for (let i = 1; i < tokens.length; i++) {
      const a = tokens[i];
      if (/^-scope:process$/i.test(a)) scope++;
      else if (/^-scope$/i.test(a) && /^process$/i.test(tokens[i + 1] || '')) { scope++; i++; }
      else if (/^-executionpolicy$/i.test(a) && EXECUTION_POLICIES.test(tokens[i + 1] || '')) { policy++; i++; }
      else if (EXECUTION_POLICIES.test(a)) policy++;
      else if (!/^-force$/i.test(a)) return false;
    }
    return scope === 1 && policy === 1;
  }
  MACHINE_HEAD_RULES.push({ re: /^Set-ExecutionPolicy(?=\s|$)/i, why: 'PowerShell cmdlet that alters machine or interactive-session state' });
  const MACHINE_GLOBAL_RULES = [
    { re: /\bHKEY_|(?:^|[\s"'`=(\\])HK(?:LM|CU|CR|U|CC)[:\\]/i, why: 'references a Windows registry hive' },
    { re: /\bdefaults\s+write\b/i, why: 'changes macOS system preferences' },
    { re: /(?:^|[\s"'`=(])shell:startup\b|Start\s?Menu[\\/]+Programs[\\/]+Startup/i, why: 'writes to the Startup folder (machine persistence that outlives StarNet)' }
  ];
  function breaksMachineState(cmd, dialect) {
    const c = String(cmd == null ? '' : cmd);
    const analysis = analyzeCommands(c, 0, dialect);
    if (analysis.opaqueWrapper) return 'uses native shell-wrapper quoting StarNet could not confirm as command text; use one plainly quoted command string or a script file';
    if (analysis.opaqueBody) return 'runs command text StarNet cannot read with certainty (a cmd switch built by expansion, or a body or target it cannot place), so what it starts cannot be inspected; write the command out plainly or use a script file';
    if (analysis.opaquePowerShell) return 'runs a base64-encoded PowerShell command, or one with an option StarNet does not recognize, so it cannot be inspected — write the script to a file and run it plainly';
    if (analysis.heads.some(h => {
      const first = (headTokens(h)[0] || {}).value || '';
      return /^(?:%[^%\s]+%|![^!\s]+!)$/.test(first);
    })) return 'uses an environment-expanded executable at a command boundary, so the command cannot be inspected safely';
    const plainPolicy = analysis.heads.filter(processOnlyExecutionPolicy);
    const policyExempt = !/[`+$(){}*?\[\]]|\biex\b|invoke-(?:expression|command)/i.test(c)
      && plainPolicy.length === (c.match(/set-executionpolicy/gi) || []).length;
    const heads = analysis.heads.filter(h => !(policyExempt && plainPolicy.includes(h))).map(canonicalHead);
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
     shown output, and keep the cwd on THIS RUN's path object (ctx.paths.setShellCwd; a sandbox backend keeps its
     container cwd per agent, the recorded exception at the call site), clamped to the allowed envelope.
     THE MARKER CANNOT BE FORGED (run-paths review S1, 2026-10-28). The output is whatever the command printed, so a
     file shown with `type README.md` that contained a literal marker line used to BE the marker: it set the run's
     remembered cwd (which verify.run and terminal.start inherit) and the exit code the routine script gate reads. Each
     call now carries a fresh random nonce inside every marker token (__SK_CWD_<nonce>__ …), which printed content
     cannot know, and the parser takes the LAST match: the one the shell appended after the command finished.
     WHAT IT DEFEATS, AND WHAT IT DOES NOT: the nonce defeats PRINTED CONTENT only (a file, a web page, a tool's output
     echoed through the command). Code the command itself runs already has full shell reach in that cwd: it can read the
     nonce off its own command line and print a valid marker, but it could equally just `cd` and do the work there. The
     remembered cwd is still clamped to the allowed envelope afterwards, whoever printed it. */
  const MARK_A = '__SK_CWD__', MARK_EC = '__SK_EC__', MARK_END = '__SK_END__';
  function markTokens(nonce) {
    const n = nonce == null || nonce === '' ? '' : '_' + String(nonce).replace(/[^0-9A-Za-z]/g, '');
    return n ? { a: '__SK_CWD' + n + '__', ec: '__SK_EC' + n + '__', end: '__SK_END' + n + '__' } : { a: MARK_A, ec: MARK_EC, end: MARK_END };
  }
  // a fresh per-call nonce (a rig may inject a deterministic one: makeShellTool deps.markerNonce)
  const nodeCrypto = (typeof require === 'function') ? require('node:crypto') : null;
  function freshNonce() {
    if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') return nodeCrypto.randomBytes(8).toString('hex');
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === 'function') return Array.from(c.getRandomValues(new Uint8Array(8)), b => (b + 256).toString(16).slice(1)).join('');
    throw new Error('no randomness source for the shell marker');
  }
  /* WINDOWS: THE CARET IS LOAD-BEARING (h1 F5, 2026-09-22). cmd.exe expands %VAR% for the WHOLE line when it PARSES it
     — before the user's command runs — so the original `call echo …%CD%…%ERRORLEVEL%` printed the PRE-command cwd and
     errorlevel: every Windows shell.exec reported [exit 0] even when the command failed, and a `cd` never persisted
     (bug since e72ee0b00, 2026-06-23). `%^ERRORLEVEL%` survives the parse-time pass (no variable is named ^ERRORLEVEL),
     the caret is then consumed, and `call` performs a SECOND expansion at run time — after the command finished.
     Proven with Node's own spawn mode (shell:true -> cmd.exe /d /s /c "…"): `cmd /c exit 3 & call echo %^ERRORLEVEL%`
     prints 3 and `cd sub & call echo %^CD%` prints …\sub. Output format unchanged, so parseMarker is untouched.
     nonce: this call's token (freshNonce, S1); omitted, the historic un-nonced marker (helpers and old rigs). */
  function buildMarkedCmd(cmd, isWin, nonce) {
    const t = markTokens(nonce);
    if (isWin) return cmd + ' & call echo ' + t.a + '%^CD%' + t.ec + '%^ERRORLEVEL%' + t.end;
    return cmd + '\n__sk_ec=$?; printf "\\n' + t.a + '%s' + t.ec + '%s' + t.end + '" "$(pwd)" "$__sk_ec"';
  }
  // the LAST marker carrying this call's nonce: the one the shell appended after the command (S1)
  function parseMarker(out, nonce) {
    out = String(out == null ? '' : out);
    const t = markTokens(nonce);
    // the cwd never spans another start token, so a stray earlier one cannot swallow the real marker into its cwd
    const re = new RegExp(t.a + '((?:(?!' + t.a + ')[\\s\\S])*?)' + t.ec + '(-?\\d+)' + t.end, 'g');
    let m = null, hit;
    while ((hit = re.exec(out)) !== null) m = hit;
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
    // BOTH spellings, as pathtrust.js refuses them (run-paths review S2): `//host/share` reached fs.existsSync below,
    // and on Windows that lookup is an outbound SMB connection that hands the host the user's NTLM hash
    if (/^[\\/]{2}/.test(raw)) throw new Error('UNC cwd paths are not allowed');
    raw = normalizeWinCwd(P, raw, isWin);
    if (/^[\\/]{2}/.test(raw)) throw new Error('UNC cwd paths are not allowed');
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
  /* WHERE THIS RUN'S NEXT COMMAND STARTS (run-paths lane, 2026-10-28). shell.exec, verify.run and terminal.start all ask
     this one function: the run's project root when it has one (ctx.paths root, host-minted), else the private
     workspace, then THIS run's remembered `cd` (paths.shellCwd), re-proven on every read. It used to be three hand
     copies: the shell read the run's projectCwd field, else its projectRoot; terminal.start read projectCwd only (a
     project chat's terminal opened in the private workspace), verify.run ignored a `cd`, and an unscoped `cd` was kept per
     AGENT (environment.rememberCwd), so a `cd` in one chat moved every other chat of that agent. RECORDED EXCEPTION
     (owner decision 2026-10-28): a docker/ssh sandbox keeps its container cwd PER AGENT (environment.getCwd, validated by
     the backend against the container root), exactly as before; see the marker read-back in makeShellTool.
     o.confine (verify.run, terminal.start — run-paths review S1): on the host, an INHERITED `cd` is followed only while
     it lies, by its real path, inside the private workspace or the run's project root. The local shell may `cd` (or take
     cwd:) anywhere the local backend allows, but that must not become where an unattended check runs `npm test` or a
     terminal opens without either tool ever being asked for that folder; outside it, they start from the run's base.
     o: { paths, environment, backendId, agentId, jailRoot, pathMod, fs, root, isWin, remoteOwner, confine } */
  function confinedCwd(o, kept) {
    const P = o.pathMod, fs = o.fs, real = fs && typeof fs.realpathSync === 'function' ? (p) => fs.realpathSync(p) : (p) => P.resolve(p);
    try {
      const at = real(kept);
      if (withinJail(P, at, real(o.jailRoot))) return true;
      return !!(o.paths.root && withinJail(P, at, real(o.paths.root)));
    } catch (e) { shellFailNote('shell.cwd.confine', e); return false; }   // cannot prove it: start from the base
  }
  function runShellCwd(o) {
    const P = o.pathMod, paths = o.paths, local = o.backendId === 'local';
    let cwd = o.environment && !local ? o.environment.getCwd(o.agentId) : o.jailRoot;
    if (paths.root) cwd = resolveShellCwd({ pathMod: P, fs: o.fs, requested: paths.root, current: cwd, jailRoot: o.jailRoot, root: o.root, isWin: o.isWin, allowExternal: local });
    let kept = paths.shellCwd();
    if (kept && o.confine && (!o.environment || local) && !confinedCwd(o, kept)) kept = null;
    if (kept) {
      try { cwd = resolveShellCwd({ pathMod: P, fs: o.fs, requested: kept, current: cwd, jailRoot: o.jailRoot, root: o.root, isWin: o.isWin, allowExternal: o.remoteOwner || local, allowProtected: o.remoteOwner }); }
      catch (e) { shellFailNote('shell.cwd.kept', e); }   // a folder deleted since the `cd`: start from the base instead
      if (!o.environment && (o.remoteOwner || withinJail(P, kept, o.jailRoot)) && (!o.fs || !o.fs.existsSync || o.fs.existsSync(kept))) cwd = kept;
    }
    return cwd;
  }

  /* best-effort tree-kill: on Windows taskkill must inspect the live shell root to discover `/T` descendants.
     POSIX (macOS/Linux): `group` is true when the shell was spawned detached, i.e. as the leader of its OWN
     process group, so the group IS the command's tree — one SIGKILL to -pid reaches every child and grandchild.
     Killing only the /bin/sh wrapper (the old POSIX path) orphaned whatever the command started (`sleep 30 &`,
     a dev server, a watcher): they kept running, kept their ports/files, and kept the stdout pipe open, so the
     call did not even settle until they exited on their own. A group that can no longer be signalled (already
     gone / never a leader) falls back to killing the leader directly, exactly as before. */
  function killTree(spawn, child, isWin, group) {
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
    // pid > 1 always: process.kill(-1) would signal EVERY process this user owns
    if (group && Number.isInteger(child.pid) && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch (e) { shellFailNote('shell.killTree.group', e); }
    }
    try { child.kill(); } catch (_) {}
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch (_) {}
  }
  // A real POSIX host (not merely isWin:false injected by a test on Windows, where detached would open a console).
  function posixGroupHost(isWin) {
    return !isWin && typeof process !== 'undefined' && process.platform !== 'win32';
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
     opts = { spawn, cmd, cwd, timeoutMs, maxBytes, signal?, clock?, isWin?, ledger?, ledgerCmd? }
       -> Promise<{ exitCode:int, out:string, ms:int, truncated:bool, timedOut:bool, aborted:bool }>
     opts.ledger (procledger.js): the child is recorded for the NEXT boot's orphan sweep while it runs and released
     when it is over — a sidecar crash mid-command no longer leaves an orphan nothing knows about. ledgerCmd is the
     REDACTED command line to store (the plaintext may carry a secret). */
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
      if (opts.env) spawnOpts.env = opts.env;
      // POSIX: the shell leads its own process group so a timeout/abort can kill the whole tree (see killTree).
      // Stdio stays piped and the child is NOT unref'd — we still await its 'close'.
      const group = posixGroupHost(isWin);
      if (group) spawnOpts.detached = true;
      try { child = spawn(cmd, spawnOpts); }
      catch (e) { return reject(new Error('could not start shell: ' + ((e && e.message) || e))); }
      const receipt = trackChild(opts.ledger || null, child && child.pid, { cmd: opts.ledgerCmd != null ? opts.ledgerCmd : '', kind: 'shell.fg', pinAfterMs: opts.ledgerPinAfterMs, exitStampMs: opts.ledgerExitStampMs });
      if (typeof child.on === 'function') child.on('exit', function () { receipt.exited(); });
      const t0 = now();
      let out = '', total = 0, truncated = false, settled = false, timedOut = false, aborted = false;
      const full = makeFullCapture(opts.fullOutMax);
      const append = function (text) {
        const complete = String(text);
        full.push(complete);
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
      const timer = setTimeout(function () { timedOut = true; killTree(spawn, child, isWin, group); }, timeoutMs);
      const onAbort = function () { aborted = true; killTree(spawn, child, isWin, group); };
      if (sig) { if (sig.aborted) { onAbort(); } else { try { sig.addEventListener('abort', onAbort, { once: true }); } catch (_) {} } }
      function finish(code) {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} }
        receipt.done();
        // Stripped HERE, at the single exit of the shared primitive, so shell.exec and the background tail
        // (shellbg.js reads r.out) are both covered by one strip that cannot drift into two.
        resolve({ exitCode: (typeof code === 'number') ? code : -1, out: stripAnsi(out), fullOut: full.value(stripAnsi), fullOutElided: full.elided(), ms: Math.max(0, now() - t0), truncated: truncated, timedOut: timedOut, aborted: aborted });
      }
      // a spawn failure (no PID) is the only 'error' that ends the command; it has no receipt to keep either way
      child.on('error', function (e) { if (settled) return; settled = true; clearTimeout(timer); if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} } receipt.done(); reject(new Error('shell error: ' + ((e && e.message) || e))); });
      child.on('close', function (code) { finish(timedOut || aborted ? null : code); });
    });
  }

  // Lane C (no silent fallback): when the agent's profile asks for a sandbox the router cannot honor, the
  // router hands back a typed refusal. Ask BEFORE checkpointing or resolving cwd so nothing touches the host.
  function sandboxRefusal(environment, aid) {
    if (!environment || typeof environment.refusalFor !== 'function') return null;
    try { return environment.refusalFor(aid) || null; } catch (_) { return null; }
  }
  /* THE ENVIRONMENT THE COMMAND WILL RUN WITH, for the guard to search in. The local backend answers with the snapshot every
     command it starts begins from (environment.commandEnv); a rig that gives the tool its own (deps.env) is believed; if
     neither speaks the answer is undefined and the guard falls back to the process's own. */
  function commandEnvOf(environment, ownEnv, aid, surface) {
    if (environment && typeof environment.commandEnv === 'function') {
      try { const e = environment.commandEnv({ agentId: aid, surface: surface }); if (e && typeof e === 'object') return e; }
      catch (e) { shellFailNote('shell.commandenv', e); }
    }
    return ownEnv && typeof ownEnv === 'object' ? ownEnv : undefined;
  }
  function makeShellTool(deps) {
    deps = deps || {};
    const environment = deps.environment || null;
    const ownEnv = deps.env && typeof deps.env === 'object' ? deps.env : null;   // the environment a direct (no environment manager) command runs with
    const spawn = deps.spawn, fs = deps.fs || null, P = deps.pathMod || (typeof require === 'function' ? require('node:path') : null), ROOT = deps.root || '';
    const bg = deps.bg || null;   // H2.2: the singleton background-process manager (shellbg.js); null -> bg disabled
    // the marker's per-call nonce (S1): random by default; a deterministic rig may inject its own
    const markerNonce = typeof deps.markerNonce === 'function' ? () => String(deps.markerNonce()) : freshNonce;
    // THE RUN'S PATH OBJECT (sidecar/run-paths.js): its project root, private workspace, receipt placement and THIS
    // run's `cd`. ctx.paths in a real run; a rig without one gets the same object minted from these deps.
    let pathsResolver = null;
    const runPaths = (ctx, aid) => {
      if (!pathsResolver) pathsResolver = RunPaths.makeResolver({ pathMod: P, root: ROOT, environment });
      return RunPaths.pathsFor(ctx, pathsResolver, aid);
    };
    // A spill lives in the agent's jail (.output/…); a project session resolves relative paths in the project, so
    // the pointer the model reads must be absolute there (run-paths placeJail).
    const spillPath = (rel, ctx) => runPaths(ctx, safeAgentId((ctx && ctx.agentId) || 'agent')).placeJail(rel);
    // procledger.js: foreground children are receipted while they run (the environment path does the same in
    // environment.js runProcess — that is the production route; this covers the direct runCommand route)
    const ledger = (deps.ledger && typeof deps.ledger.record === 'function') ? deps.ledger : null;
    if (!environment && (typeof spawn !== 'function' || !fs || !P || !ROOT)) throw new Error('shell.js requires { spawn, fs, pathMod, root } or { environment }');
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.platform != null) ? (deps.platform === 'win32') : WIN;
    // how a command that opens the person's own window leaves the station's job (Windows desktop only; a pass-through elsewhere)
    const breakaway = deps.breakaway || require('../../breakaway.js').makeBreakaway({ platform: isWin ? 'win32' : 'posix' });
    const L = deps.limits || {};
    const MAX_BYTES = L.maxBytes || 64000;
    const DEFAULT_MS = L.defaultTimeoutMs || 30000;
    /* MAX 120s -> 600s (2026-09-02, coding-tools lane). A test suite, a build, or an install routinely runs
       longer than two minutes; at 120s the agent's only options were a KILLED result or background:true plus a
       polling loop through shell.bg.read. Ten minutes matches environment.execute's own ceiling (600000) and
       the reference harness. Still bounded by config (limits.maxTimeoutMs), still killed at the deadline, and
       the registry backstop below stays ABOVE it so the child-kill always runs first. */
    const MAX_MS = L.maxTimeoutMs || 600000;

    const execTool = {
      name: 'shell.exec', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
      timeoutMs: MAX_MS + 10000,   // registry backstop ABOVE our own kill logic, so withTimeout never preempts the child-kill
      /* Trimmed 2026-07-26 (tool-schema cost pass). This text is re-sent on EVERY turn, so it may only
         carry what CHANGES A DECISION. The old version enumerated each refused command class; the guard
         already answers that at call time with the specific reason, and far more accurately than a
         remembered list — so it is stated once as a rule instead of itemised. Same for the Windows path
         normalization note: it altered no choice the model makes.
         #128 (2026-10-17): this string is shared by every agent on every machine, so it names no shell. Which one
         runs (cmd.exe, /bin/sh, sh in Docker or over SSH) is per agent and lives on the [RUNTIME] Shell line
         (runtimeinfo.js shellLine) — "On Windows this uses cmd.exe" here sent Linux models to powershell first.
         run-paths-polish P3: it said "Absolute and `..` paths are refused in cmd", untrue for a /-rooted POSIX path (the
         floor, escapesWorkspace, is a text check for `..`, C:\…, \\server and \… forms) and under Full Power (which skips
         the floor). It now names the forms and the modes, in no more bytes (payload.budget: 315 -> 312).
         gh#128 family (safe-egress S4): those forms are FLOOR_FORMS, joined from the floor's own table, so the two
         cannot drift; same bytes on every platform, because the floor is one text check everywhere. */
      description: 'Run a shell command in the current project folder when this session is project-scoped, otherwise in your private workspace; returns combined stdout/stderr + exit code. '
        + 'Tests, builds, git, scripts: anything you would type in a terminal. Write it for the shell on the [RUNTIME] Shell line. '
        + 'Your working directory PERSISTS across calls (a `cd` carries over); pass cwd to run from a specific existing folder. '
        + FLOOR_FORMS + ' paths in cmd, and commands that would change the user\'s machine or screen, are refused '
        + 'in restricted modes; Full Power may run any host command the current OS user can run. '
        + 'timeoutMs: default 30s, max 10 min (timeout_ms works too). background:true returns a handle '
        + 'at once for long-running processes (dev servers): check shell.bg.status, read its log with '
        + 'shell.bg.read, answer its prompts with shell.bg.write, stop it with shell.bg.kill.',
      schema: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' }, timeout_ms: { type: 'number' }, background: { type: 'boolean' } } },
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
        /* FILES BEFORE THE SHELL (2026-10-25): "use paths inside your workspace" was the whole answer to `type C:\proj\notes.md`,
           so a model holding the file tools told the Commander the file was inaccessible. A path refusal names the route that
           reaches it — only when the host says this run carries the file tools (ctx.fileToolsOnWire), and the cwd route only
           where cwd may leave the workspace (the local backend). */
        if (deny) throw new Error('refused: ' + deny + (/^(parent-directory|drive-absolute|drive-root)/.test(deny) && ctx.fileToolsOnWire === true
          ? '. To read, list or search files there, call fs_read / fs_list / fs_search with the full path instead'
            + (environmentBackendId === 'local' ? '; to run a command there, pass that folder as cwd' : '')
          : ''));
        const jailRoot = environment ? environment.ensureWorkspace(aid) : P.join(ROOT, aid);
        // H2.1 + run-paths: start where THIS run's next command starts (runShellCwd: the run's project root or the
        // private workspace, then this run's own `cd`). The `cd` lives on the run's path object, so two runs of one
        // agent (two chats, two projects, a routine beside a chat) never inherit one another's working directory.
        const paths = runPaths(ctx, aid);
        let cwd = runShellCwd({ paths: paths, environment: environment, backendId: environmentBackendId, agentId: aid, jailRoot: jailRoot, pathMod: P, fs: fs, root: ROOT, isWin: isWin, remoteOwner: remoteOwner });
        if (args && args.cwd != null) {
          if (environment && environmentBackendId !== 'local' && !remoteOwner) throw new Error('cwd is only supported on the local execution backend; use cd inside the container workspace instead');
          cwd = resolveShellCwd({ pathMod: P, fs: fs, requested: args.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: remoteOwner || environmentBackendId === 'local', allowProtected: remoteOwner });
          paths.setShellCwd(cwd);
        }
        const hostCwd = environment && typeof environment.workspaceRoot === 'function' && environmentBackendId !== 'local'
          ? environment.workspaceRoot(aid) : cwd;
        const shellDialect = environment && environmentBackendId !== 'local' ? 'posix' : (isWin ? 'cmd' : 'posix');
        const safetyDeny = remoteOwner ? null : commandSafetyRisk(cmd, { cwd: hostCwd, exactCwd: true, fs: fs, pathMod: P, dialect: shellDialect, isWin, env: commandEnvOf(environment, ownEnv, aid, ctx.surface) });
        if (safetyDeny) throw new Error('refused [' + safetyDeny.kind + ']: this command ' + safetyDeny.reason + '. StarNet task processes preserve the user\'s control of their computer; use browser.test_* for local UI/game verification.');
        if (!environment) { try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {} }
        const checkpoint = typeof ctx.checkpointMutation === 'function'
          ? Promise.resolve().then(function () { return ctx.checkpointMutation(hostCwd, 'shell.exec', { always: true }); }).catch(function () { return null; })
          : Promise.resolve(null);
        // H2.2: a long-running process — hand it to the singleton bg manager (detached, ring-buffered, capped)
        // and return immediately. Inherits this run's cwd. Still consent-gated (this IS shell.exec).
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
        const requestedMs = args && (args.timeoutMs || args.timeout_ms);
        const timeoutMs = clamp(requestedMs || DEFAULT_MS, 1000, MAX_MS);
        /* A CLAMP IS NEVER SILENT (h1 audit 2026-09-22): a model that asked for 30 min and silently got 10 reads the
           kill as its own mistake. The first line of the result names both numbers. It rides the TOP of the content
           so the `[exit N]` receipt stays the last line (the cron script gate parses it). */
        const clampNote = (requestedMs != null && isFinite(Number(requestedMs)) && Number(requestedMs) !== timeoutMs)
          ? '[timeout: requested ' + Number(requestedMs) + 'ms is ' + (Number(requestedMs) > timeoutMs ? 'above the ' + MAX_MS + 'ms ceiling' : 'below the 1000ms minimum')
            + ' — this command ran with an effective timeout of ' + timeoutMs + 'ms]\n'
          : '';
        const markerIsWin = environment && environmentBackendId !== 'local' ? false : isWin;
        /* A full-power command that opens a window on the person's screen (`start`, `explorer`, a headed browser…) opens
           THEIR app: on Windows it runs outside the station's job (sidecar/breakaway.js), so quitting or crashing StarNet
           never closes what it opened. Every other command stays the station's and ends with it. */
        const forPerson = isWin && remoteOwner && (!environment || environmentBackendId === 'local') && !!opensVisibleWindow(cmd, shellDialect);
        const nonce = markerNonce();   // S1: this call's marker token — printed content cannot forge the cwd or exit code (code the command runs could; it already has shell reach)
        const run = checkpoint.then(function () {
          return environment && typeof environment.execute === 'function'
            ? environment.execute({ agentId: aid, cmd: buildMarkedCmd(cmd, markerIsWin, nonce), cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, surface: ctx.surface, ledgerCmd: redact(cmd), breakaway: forPerson })
            : runCommand({ spawn: forPerson ? breakaway.spawnVia(spawn) : spawn, cmd: buildMarkedCmd(cmd, isWin, nonce), cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, isWin: isWin, ledger: ledger, ledgerCmd: ledger ? redact(cmd) : '', env: ownEnv || undefined });
        });
        return run.then(function (res) {
          // recover the final cwd + the REAL exit code from THIS call's marker; keep the cwd only inside the allowed envelope.
          const pm = parseMarker(res.fullOut || res.out, nonce);
          const preview = parseMarker(res.out, nonce);
          /* `cd` STAYS PER RUN (spec), with ONE RECORDED EXCEPTION (owner decision 2026-10-28): a docker/ssh sandbox keeps
             its container cwd PER AGENT (environment.rememberCwd / getCwd). The container is that agent's own, and its
             backend validates the cwd against the container root, so a `cd` inside a sandbox carries across that agent's
             runs. Every host-side `cd` is kept on THIS run's path object, never per agent (where it moved every other chat). */
          if (environment && pm.cwd && environmentBackendId !== 'local') environment.rememberCwd(aid, pm.cwd);
          else if (environment && pm.cwd && withinJail(P, pm.cwd, jailRoot)) paths.setShellCwd(pm.cwd);
          else if (environment && pm.cwd && environmentBackendId === 'local') {
            try { paths.setShellCwd(resolveShellCwd({ pathMod: P, fs: fs, requested: pm.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: true, allowProtected: remoteOwner })); }
            catch (e) { shellFailNote('shell.cwd.remember', e); }   // the command left the allowed envelope: the next call starts from the run's base
          }
          else if (pm.cwd && (remoteOwner || withinJail(P, pm.cwd, jailRoot))) paths.setShellCwd(pm.cwd);
          const exitCode = (pm.ec != null && !res.timedOut && !res.aborted) ? pm.ec : res.exitCode;
          const note = res.timedOut ? ' — KILLED (timed out after ' + timeoutMs + 'ms)' : res.aborted ? ' — KILLED (aborted)' : '';
          const body = redact((res.truncated ? preview.cleanOut : pm.cleanOut) || '(no output)');
          // the bounded capture (output-capture.js) dropped the middle of a huge output: say so, never imply the saved copy is whole
          const elided = Number(res.fullOutElided) > 0 ? Number(res.fullOutElided) : 0;
          const content = clampNote + body + '\n[exit ' + exitCode + (res.truncated ? ', output truncated to ' + Math.round(MAX_BYTES / 1000) + 'KB' : '')
            + (elided ? ', ' + elided + ' characters from the middle of the output were not kept' : '') + note + ']';
          const fullContent = res.truncated
            ? clampNote + redact(pm.cleanOut || '(no output)') + '\n[exit ' + exitCode + note + ']'
            : undefined;
          try {
            if (typeof ctx.emit === 'function') ctx.emit('shell.exec', {
              agentId: aid, runId: ctx.runId || '', callId: ctx.callId || 'call',
              cmdSummary: redact(clip(cmd)), cwd: aid, exitCode: exitCode, ms: res.ms, truncated: res.truncated
            });
          } catch (_) {}
          /* A KILLED COMMAND IS AN ERROR, NOT A RESULT (h1 audit 2026-09-22). A timed-out command used to come back
             ok=true with summary "exit -1 (2288ms)" — the words "timed out" lived only in the body, so the tool card,
             the telemetry and the recovery policy all read a successful call. The tool contract is "THROW on error"
             (tool.js): the registry turns this into an isError result whose summary names the cause. The partial
             output and the `[exit -1 — KILLED …]` receipt are kept verbatim. A plain non-zero exit stays a RESULT. */
          if (res.timedOut || res.aborted) {
            const head = (res.timedOut
              ? 'TIMEOUT: the command did not finish within its ' + timeoutMs + 'ms timeout, so the host KILLED it (the whole process tree).'
              : 'CANCELLED: the command was stopped before it finished, so the host KILLED it (the whole process tree).')
              + ' It did not complete — anything it was doing may be only partly done.'
              + (res.timedOut ? ' For a longer job raise timeoutMs (max ' + MAX_MS + 'ms) or start it with background:true.' : '')
              + ' Output captured before the kill:\n';
            const killed = new Error(head + content);
            killed.toolSummary = res.timedOut ? 'timeout' : 'cancelled';
            if (fullContent) killed.fullContent = head + fullContent;
            if (elided) killed.fullContentElided = elided;
            throw killed;
          }
          const done = { content: content, fullContent: fullContent, summary: 'exit ' + exitCode + ' (' + res.ms + 'ms)' + (res.truncated ? ', truncated' : '') };
          if (elided) done.fullContentElided = elided;
          return done;
        });
      }
    };

    // H2.2: inspect / stop the agent's own background processes (started via shell.exec background:true).
    const bgStatusTool = {
      name: 'shell.bg.status', capability: 'workbench', impact: 'none', scope: 'read', requiresConsent: false,
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
          const saved = v.outputSpillVerified ? '\n[full output: ' + v.outputBytes + ' bytes durably appended to ' + spillPath(v.outputPath, ctx) + ']'
            : v.outputSpillCapped ? '\n[output log: the first ' + v.outputBytes + ' bytes are durably appended to ' + spillPath(v.outputPath, ctx) + '; the log stopped at its cap, later output is only in the memory ring]'
            : (v.outputSpillError ? '\n[full-output spill failed: ' + v.outputSpillError + ']' : '');
          const state = v.running ? 'RUNNING' + killNote(v) : v.lost ? 'LOST — ' + (v.remoteBoundary || 'remote process identity is unconfirmed') : 'exited ' + v.exitCode + (v.killed ? ' (killed)' : '') + killNote(v);
          return { content: '[' + v.bgId + '] ' + state + ' · ' + v.ms + 'ms · ' + v.cmd + saved + '\n--- output tail ---\n' + redact(v.tail || '(none)'), summary: v.running ? 'running' : v.lost ? 'lost' : 'exited ' + v.exitCode };
        }
        const list = await Promise.resolve(source ? source.statusBackground(aid) : bg.status(aid)) || [];
        if (!list.length) return { content: 'No background processes.', summary: '0' };
        return { content: list.map(function (v) { return '[' + v.bgId + '] ' + (v.running ? 'RUNNING' : v.lost ? 'LOST (identity mismatch)' : 'exited ' + v.exitCode) + killNote(v) + ' · ' + v.cmd; }).join('\n'), summary: list.length + ' process(es)' };
      }
    };
    // A kill is reported only as far as it was proven (shellbg.js killState): never "(killed)" for a tree that
    // may still be running.
    function killNote(v) {
      if (!v || !v.killState || v.killState === 'verified') return '';
      if (v.killState === 'pending') return ' (kill in progress — not yet confirmed)';
      if (v.killState === 'incomplete') return ' (kill INCOMPLETE — still running: PID ' + (v.survivors || []).join(', ') + ')';
      return ' (kill sent but NOT confirmed)';
    }

    /* F4 — WAIT. Learning that a background job finished used to mean polling shell.bg.status turn after paid turn.
       This blocks (bounded) until the process exits. A timeout is an ANSWER — "still running" — not an error: the
       process keeps going and the agent decides what to do next. */
    const MAX_WAIT_MS = 600000;
    const bgWaitTool = {
      // impact 'none': it only observes a process this agent already owns (like shell.bg.status/kill), so the
      // run-authority layer must not fail it closed as an unknown external effect
      name: 'shell.bg.wait', capability: 'workbench', impact: 'none', scope: 'read', requiresConsent: false,
      timeoutMs: MAX_WAIT_MS + 10000,   // registry backstop above our own bounded wait
      description: 'Wait for one of your background processes to exit, up to timeoutMs (default 30s, max 10 min). '
        + 'Returns as soon as it exits, with its exit code and output tail. If it is still running when the timeout '
        + 'passes it says so — that is not an error, the process keeps running.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, timeoutMs: { type: 'number' }, timeout_ms: { type: 'number' } } },
      run: async function (args, ctx) {
        ctx = ctx || {};
        const aid = safeAgentId(ctx.agentId || 'agent');
        const id = args && args.id ? String(args.id) : '';
        const requested = args && (args.timeoutMs != null ? args.timeoutMs : args.timeout_ms);
        const timeoutMs = clamp(requested == null ? 30000 : requested, 0, MAX_WAIT_MS);
        const opts = { timeoutMs: timeoutMs, signal: ctx.signal };
        let r = null;
        if (environment && typeof environment.waitBackground === 'function') r = await Promise.resolve(environment.waitBackground(aid, id, opts));
        else if (!environment && bg && typeof bg.wait === 'function') r = await Promise.resolve(bg.wait(aid, id, opts));
        if (r == null) {
          // a backend without an event-driven wait (ssh): poll its status on a slow, bounded cadence
          const source = environment && typeof environment.statusBackground === 'function' ? environment : null;
          if (!source && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
          const t0 = now();
          // timeoutMs 0 = check once, never sleep; the last step is trimmed so the wait never overshoots its budget
          const step = 1000, rounds = Math.ceil(timeoutMs / step);
          let v = await Promise.resolve(source ? source.statusBackground(aid, id) : bg.status(aid, id));
          for (let i = 0; v && v.running && i < rounds && !(ctx.signal && ctx.signal.aborted); i++) {
            const ms = Math.min(step, timeoutMs - i * step);
            await new Promise(function (res) { setTimeout(res, ms); });
            v = await Promise.resolve(source ? source.statusBackground(aid, id) : bg.status(aid, id));
          }
          r = v ? Object.assign({ ok: true, state: v.running ? ((ctx.signal && ctx.signal.aborted) ? 'cancelled' : 'running') : 'exited', waitedMs: Math.max(0, now() - t0) }, v) : { ok: false, error: 'no such background process' };
        }
        if (!r.ok) return { content: 'Could not wait: ' + (r.error || 'no such background process') + (id ? ' ("' + id + '")' : ''), summary: 'not found' };
        const waited = Number(r.waitedMs) || 0;
        const tail = '\n--- output tail ---\n' + redact(r.tail || '(none)');
        if (r.state === 'exited') {
          return { content: '[' + r.bgId + '] exited ' + r.exitCode + (r.killed ? ' (killed)' : '') + killNote(r) + ' · after waiting ' + waited + 'ms · ' + r.cmd + tail, summary: 'exited ' + r.exitCode };
        }
        if (r.state === 'cancelled') {
          return { content: '[' + r.bgId + '] still RUNNING — the wait was cancelled after ' + waited + 'ms · ' + r.cmd + tail, summary: 'wait cancelled' };
        }
        return {
          content: '[' + r.bgId + '] still RUNNING after waiting ' + waited + 'ms (the ' + timeoutMs + 'ms wait timed out — not an error; the process keeps running). '
            + 'Wait again, read its log with shell.bg.read, or stop it with shell.bg.kill. · ' + r.cmd + tail,
          summary: 'still running'
        };
      }
    };
    /* H2.3 — READ PAST THE TAIL. shell.bg.status returns the last ~2000 characters, which is fine for "is it
       up?" and useless for "why did it fail": the stack trace that matters is usually hundreds of lines back,
       and the only way to reach it used to be re-running the whole command in the foreground. */
    const bgReadTool = {
      /* impact external-unknown, DECLARED, and deliberately the lane it always fell into. It pages the whole output log
         of a background process, and those are keyed by AGENT, not by run, so as impact none it was offered, with no
         grant, to every run of that agent whose station holds the WORKBENCH (a delegated worker's kit, a bay room with
         one placed), on any surface and tainted or not, which could then page and repeat the log of a command the
         Commander had that agent start. In this lane a watched run asks an exact per-call confirmation, an unattended
         ASK run is not offered it, a tainted run loses it, and an owner DM or Full Access keeps it. Declaring it none
         (quick win 8) was reverted in review and waits for Andrew's security sign-off. shell.bg.status/wait keep the
         impact none they had in 0.14.1 (each can show a short output tail); that lane is not changed here. briefExempt
         keeps it a read the model may make before the Task Brief settles, as in 0.14.1 (taskbrief-policy canMutate holds
         a scope-read tool only when it DECLARES external-unknown, the rule for MCP reads; undeclared, it passed). */
      name: 'shell.bg.read', capability: 'workbench', impact: 'external-unknown', scope: 'read', requiresConsent: false,
      briefExempt: true,
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
              ? '\n(earlier output left the memory buffer; the full ' + r.outputBytes + '-byte log is saved once at ' + spillPath(r.outputPath, ctx) + ' and can be paged with fs.read)'
              : r.outputSpillCapped
                ? '\n(earlier output left the memory buffer; the log stopped at its cap, so only the first ' + r.outputBytes + ' bytes are saved at ' + spillPath(r.outputPath, ctx) + ' and can be paged with fs.read)'
                : '\n(earlier output was dropped from memory and durable spill is unverified' + (r.outputSpillError ? ': ' + r.outputSpillError : '') + ')')
          : (r.outputSpillVerified ? '\n(full output is durably appended to ' + spillPath(r.outputPath, ctx) + '; ' + r.outputBytes + ' bytes so far)'
            : r.outputSpillCapped ? '\n(the first ' + r.outputBytes + ' bytes are durably appended to ' + spillPath(r.outputPath, ctx) + '; the log stopped at its cap, later output is only in the memory ring)' : '');
        const body = r.returned
          ? r.lines.map(function (ln, i) { return String(r.lineNos[i]).padStart(6, ' ') + '  ' + ln; }).join('\n')
          : (r.grep ? '(no lines match)' : '(no output yet)');
        return { content: head + '\n' + scope + note + '\n--- output ---\n' + redact(body), summary: r.returned + ' line(s)' };
      }
    };

    /* THE CHECKPOINT OF A BACKGROUND WRITE (lane checkpoint-links). The host's generic pre-tool hook snapshotted the
       workspace for every shell.bg.* call before any registry gate ran: a status poll re-hashed the tree, and a refused
       write still snapshotted. shell.bg.write now takes its own restore point of the agent workspace (the root the hook
       used; the backend's host mirror off the local backend) through ctx.checkpointMutation, after its input screen.
       Fail-open, like shell.exec's: a checkpoint is a safety net, never a gate on the write. */
    async function bgWriteCheckpoint(ctx, aid, backendId, jailRoot) {
      if (!ctx || typeof ctx.checkpointMutation !== 'function') return;
      const hostRoot = environment && typeof environment.workspaceRoot === 'function' && backendId && backendId !== 'local'
        ? environment.workspaceRoot(aid) : jailRoot;
      try { await ctx.checkpointMutation(hostRoot, 'shell.bg.write', { always: true }); }
      catch (e) { shellFailNote('shell.bg.checkpoint', e); }
    }

    /* H2.3 — STDIN. A background process was write-only: an installer that asks one question, or a REPL, sat
       wedged until it was killed. The payload is screened with the SAME command-safety guard shell.exec runs,
       because a line typed into a `bash`/`python` REPL executes exactly like a command typed into shell.exec —
       leaving it unscreened would have made background:true a way around the screen. */
    const bgWriteTool = {
      name: 'shell.bg.write', capability: 'workbench', impact: 'workspace-process', scope: 'execute', requiresConsent: true,
      description: 'Send input to a running background process\'s stdin: answer an interactive prompt, drive a REPL, '
        + 'or feed a pipe. A newline is appended (submit:false sends a partial line). eof:true instead of input '
        + 'CLOSES stdin, which many commands wait for before doing their work (unlike shell.bg.kill, which destroys '
        + 'the result). Its stdin is a PIPE, not a terminal: programs that demand a real TTY (password prompts, '
        + 'full-screen menus) will not see your input; re-run those non-interactively (e.g. a --yes flag or an env var).',
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
          const eofBackendId = environment ? (typeof environment.backendIdFor === 'function' ? environment.backendIdFor(aid) : environment.backendId) : null;
          await bgWriteCheckpoint(ctx, aid, eofBackendId, environment ? environment.ensureWorkspace(aid) : P.join(ROOT, aid));   // EOF can start the work too
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
        await bgWriteCheckpoint(ctx, aid, environmentBackendId, jailRoot);   // after the screen: a refused line snapshots nothing
        const r = await Promise.resolve(source ? source.writeBackground(aid, id, { input: input, submit: args && args.submit }) : bg.write(aid, id, { input: input, submit: args && args.submit }));
        return {
          content: r.ok ? ('Sent ' + r.bytes + ' byte(s) to ' + id + '. Read what it printed with shell.bg.read.') : ('Could not write: ' + r.error),
          summary: r.ok ? 'wrote ' + r.bytes + 'b' : 'not written'
        };
      }
    };

    /* The registry's 30s default backstop used to cut off the Windows verify path (snapshot + taskkill + confirm +
       second pass can legitimately take over a minute), turning a kill that was still gathering proof into a bare
       timeout. Sized from the bg manager's own worst case (shellbg.killBudgetMs) plus headroom. */
    const BG_KILL_BUDGET_MS = (bg && Number(bg.killBudgetMs) > 0) ? Number(bg.killBudgetMs)
      : ((typeof require === 'function') ? require('../../shellbg.js').killBudgetMs() : 76500);
    const bgKillTool = {
      name: 'shell.bg.kill', capability: 'workbench', impact: 'none', scope: 'write', requiresConsent: false,
      timeoutMs: BG_KILL_BUDGET_MS + 10000,
      description: 'Stop one of your background processes by id (from shell.bg.status). Kills the whole process tree and confirms it is gone.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const source = environment && typeof environment.killBackground === 'function' ? environment : null;
        if (!source && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
        const id = args && args.id ? String(args.id) : '';
        const r = await Promise.resolve(source ? source.killBackground(aid, id) : bg.kill(aid, id));
        /* F3 — a kill is reported only as far as it was PROVEN. A tree that is confirmed still running is a failed
           action (thrown -> an error result naming the survivors); a kill whose outcome could not be read back says
           exactly that instead of "Killed". Remote backends that report plain ok keep their old wording. */
        if (r && r.incomplete) {
          const err = new Error('Kill INCOMPLETE for background process ' + id + ': ' + (r.error || 'processes are still running')
            + '. Surviving PID(s): ' + (r.survivors || []).join(', ') + '. Its receipt is kept so the next StarNet start reaps them.');
          err.toolSummary = 'kill incomplete';
          throw err;
        }
        if (r && r.unverified) {
          return { content: 'Kill sent to background process ' + id + ' but NOT confirmed: ' + (r.error || 'the process tree could not be read back')
            + (r.rootExited ? ' (its main process did exit).' : '.'), summary: 'kill unconfirmed' };
        }
        /* 'verified' is proof about HOST processes. On a docker/ssh backend the host-side record is the docker exec /
           ssh client, so a verified verdict says nothing about the job inside the container or on the remote host. */
        const backendId = environment
          ? (typeof environment.backendIdFor === 'function' ? environment.backendIdFor(aid) : environment.backendId)
          : null;
        const remote = !!(environment && backendId && backendId !== 'local');
        const proven = remote
          ? ' — the kill was sent through the ' + backendId + ' backend, but the process tree inside it could not be confirmed gone (unverified).'
          : (r && r.verified ? ' — the whole process tree (' + (r.killedPids || []).length + ' process(es)) is confirmed gone.' : '.');
        if (r && r.ok && !r.alreadyExited && remote) return { content: 'Kill sent to background process ' + id + proven, summary: 'kill unconfirmed' };
        return { content: r.ok ? (r.alreadyExited ? 'Process ' + id + ' had already exited.' : 'Killed background process ' + id + proven) : ('Could not kill: ' + r.error), summary: r.ok ? 'killed' : 'not killed' };
      }
    };

    return {
      execTool: execTool, bgStatusTool: bgStatusTool, bgReadTool: bgReadTool, bgWriteTool: bgWriteTool, bgKillTool: bgKillTool, bgWaitTool: bgWaitTool,
      _internals: { escapesWorkspace: escapesWorkspace, opensVisibleWindow: opensVisibleWindow, inputIsolationRisk: inputIsolationRisk, commandSafetyRisk: commandSafetyRisk, workspaceCapturesInput: workspaceCapturesInput, projectScanRoot: projectScanRoot, breaksMachineState: breaksMachineState, exposesNetwork: exposesNetwork, killTree: killTree, safeAgentId: safeAgentId, normalizeWinCwd: normalizeWinCwd, resolveShellCwd: resolveShellCwd, unrestrictedHost: unrestrictedHost },
      register: function (reg) { reg.register(execTool); reg.register(bgStatusTool); reg.register(bgReadTool); reg.register(bgWriteTool); reg.register(bgKillTool); reg.register(bgWaitTool); return reg; }
    };
  }

  return { makeShellTool: makeShellTool, runCommand: runCommand, escapesWorkspace: escapesWorkspace, FLOOR_RULES: FLOOR_RULES, FLOOR_FORMS: FLOOR_FORMS, opensVisibleWindow: opensVisibleWindow, inputIsolationRisk: inputIsolationRisk, commandSafetyRisk: commandSafetyRisk, workspaceCapturesInput: workspaceCapturesInput, projectScanRoot: projectScanRoot, breaksMachineState: breaksMachineState, exposesNetwork: exposesNetwork, safeAgentId: safeAgentId, buildMarkedCmd: buildMarkedCmd, parseMarker: parseMarker, withinJail: withinJail, normalizeWinCwd: normalizeWinCwd, resolveShellCwd: resolveShellCwd, runShellCwd: runShellCwd, unrestrictedHost: unrestrictedHost, sandboxRefusal: sandboxRefusal, commandEnvOf: commandEnvOf };
});
