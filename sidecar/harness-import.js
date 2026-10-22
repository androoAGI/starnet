/* sidecar/harness-import.js — IMPORT-AN-AGENT read core: turn an on-disk OpenClaw or Hermes agent home into ONE
   normalized preview the frontend can mint a Agent OS agent from. PURE + injected-data only (no fs/path/os/clock/
   env requires) so it is node-testable exactly like configexport.js; index.js does the filesystem work (candidate
   existence, directory enumeration, bounded file reads) and hands this module plain strings.

   Two harnesses, two disk layouts (verified 2026-07-18):
     • OpenClaw — state dir `%USERPROFILE%\.openclaw` (POSIX `~/.openclaw`), workspace `<state>/workspace`
       (default agent) or `<state>/workspace-<agentId>`. Config `<state>/openclaw.json` is JSON5 (comments +
       trailing commas — strict JSON.parse fails; scrubJson5 below tolerates it). Persona markdown lives in the
       WORKSPACE: SOUL.md / IDENTITY.md / AGENTS.md / USER.md / MEMORY.md + memory/YYYY-MM-DD.md daily notes.
     • Hermes — home `%LOCALAPPDATA%\hermes` (POSIX `~/.hermes`), env override HERMES_HOME; profiles at
       `<home>/profiles/<name>/` (each a full home). Config `<home>/config.yaml` (YAML — minimal line-based model
       extraction, no YAML dep). Persona `<home>/SOUL.md`; `<home>/AGENTS.md`; `<home>/memories/MEMORY.md`;
       `<home>/memories/USER.md`.

   SECURITY LAW (mirrors configexport's philosophy — non-negotiable): this module NEVER sees or emits a secret.
   It extracts only the MODEL id from a config; if that config carries any key-shaped field (an `env` section,
   `api_key`, or a key matching /(token|secret|key|password|auth|bearer|credential)/i) it pushes ONE warning
   ("API keys never transfer — re-enter them in ABILITIES › INSTALLED › SAVED API CONNECTIONS") and drops it on the floor — no secret value ever
   enters the returned object. Fail-soft everywhere: a missing/unparseable file is skipped + noted, never thrown.

   filesWanted(harness) returns [{ rel, base:'root'|'state' }] so index.js knows which directory each rel resolves
   against: base:'root' = the chosen agent dir (the scan `root`); base:'state' = its PARENT (OpenClaw's state dir,
   where openclaw.json lives one level above the workspace). Daily-note COUNT is not a whitelist entry — index.js
   enumerates memory/*.md itself and passes it as `dailyCount`. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).harnessImport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // clamp caps (mirror configexport's discipline: bounded strings, never an unbounded blob into the preview).
  const TEXT_MAX = 16000;   // persona / instructions / userContext / memory.curated
  const NAME_MAX = 40;
  const MODEL_MAX = 120;

  // key-name secrets: the SAME family configexport redacts. `env` is caught explicitly (a whole section of secrets).
  const SECRET_KEY_RE = /(token|secret|key|password|passwd|pwd|auth|bearer|credential)/i;
  const SECRET_WARNING = 'API keys never transfer — re-enter them in ABILITIES › INSTALLED › SAVED API CONNECTIONS';

  function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
  function clampStr(s, max) { return String(s == null ? '' : s).slice(0, max || TEXT_MAX); }
  function nonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }

  // ---- path building (pure — no `path` module). We only ever JOIN known-good segments with the platform sep. ----
  function sepFor(platform) { return platform === 'win32' ? '\\' : '/'; }
  function joinPath(platform, base, seg) {
    if (!base) return null;
    const sep = sepFor(platform);
    const b = String(base).replace(/[\\/]+$/, '');
    const s = String(seg).replace(/^[\\/]+/, '');
    return b + sep + s;
  }

  /* ---- nonLocalPathReason(raw) — '' for a path that names THIS machine's filesystem, else why not (audit
     2026-09-25 #19). A UNC root (\\server\share, //host/share) makes even a stat() an SMB connection that can leak
     the user's NTLM hash to whoever runs the server; device-namespace forms (\\?\, \\.\, \??\) bypass Win32 path
     normalization. Checked on the RAW string, before path.resolve can reshape it. ---- */
  function nonLocalPathReason(raw) {
    const s = String(raw == null ? '' : raw);
    if (s.indexOf('\0') >= 0) return 'the path contains a NUL byte';
    if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(s) || /^[\\/]\?\?[\\/]/.test(s)) return 'device paths (\\\\?\\, \\\\.\\) are not accepted here — use an ordinary local folder path';
    if (/^[\\/]{2}/.test(s)) return 'network (UNC) paths are not accepted here — use a folder on this computer';
    return '';
  }

  /* ---- detectCandidates({ platform, env }) — build the BASE candidate roots purely from env. No existence checks
     and no per-agent enumeration here (index.js does that with fs); this only says "here is where each harness
     would live on this machine". Returns [{ harness, root, kind:'state'|'home', label }]. A candidate whose env
     inputs are missing is simply omitted (honest — nothing to point at). ---- */
  function detectCandidates(o) {
    o = o || {};
    const platform = o.platform || 'unknown';
    const env = isObj(o.env) ? o.env : {};
    const win = platform === 'win32';
    const out = [];

    // OpenClaw state dir: explicit override wins; else ~/.openclaw (USERPROFILE on win32, HOME on posix).
    let ocState = env.OPENCLAW_STATE_DIR || null;
    if (!ocState) {
      const home = win ? env.USERPROFILE : (env.HOME || env.USERPROFILE);
      if (home) ocState = joinPath(platform, home, '.openclaw');
    }
    if (ocState) out.push({ harness: 'openclaw', root: ocState, kind: 'state', label: 'OpenClaw' });

    // Hermes home: HERMES_HOME override wins; else LOCALAPPDATA\hermes (win32) / ~/.hermes (posix).
    let hmHome = env.HERMES_HOME || null;
    if (!hmHome) {
      if (win) { if (env.LOCALAPPDATA) hmHome = joinPath(platform, env.LOCALAPPDATA, 'hermes'); }
      else if (env.HOME) hmHome = joinPath(platform, env.HOME, '.hermes');
    }
    if (hmHome) out.push({ harness: 'hermes', root: hmHome, kind: 'home', label: 'Hermes' });

    return out;
  }

  /* ---- filesWanted(harness) — the READ whitelist. base tells index.js which directory the rel resolves against.
     OpenClaw: persona files sit in the WORKSPACE (base:'root'); openclaw.json sits one level up in the STATE dir
     (base:'state'). Hermes: everything is under the home (base:'root'). ---- */
  function filesWanted(harness) {
    if (harness === 'openclaw') {
      return [
        { rel: 'openclaw.json', base: 'state' },
        { rel: 'SOUL.md', base: 'root' },
        { rel: 'IDENTITY.md', base: 'root' },
        { rel: 'AGENTS.md', base: 'root' },
        { rel: 'USER.md', base: 'root' },
        { rel: 'MEMORY.md', base: 'root' }
      ];
    }
    if (harness === 'hermes') {
      return [
        { rel: 'config.yaml', base: 'root' },
        { rel: 'SOUL.md', base: 'root' },
        { rel: 'AGENTS.md', base: 'root' },
        { rel: 'memories/MEMORY.md', base: 'root' },
        { rel: 'memories/USER.md', base: 'root' }
      ];
    }
    return [];
  }

  /* ---- JSON5 scrubber: rewrite the JSON5 dialect openclaw.json actually uses into strict JSON, in ONE
     string-aware walk: strip // and /* *​/ comments, quote BARE identifier keys ({ agents: ... }), convert
     single-quoted strings to double-quoted (escaping inner " / unescaping \'), then drop trailing commas.
     NOT a full JSON5 parser — best effort, and parseJson5 stays fail-soft when it still can't read the file. ---- */
  function scrubJson5(text) {
    const s = String(text == null ? '' : text);
    let out = '';
    let inLine = false, inBlock = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i], n = i + 1 < s.length ? s[i + 1] : '';
      if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
      if (c === '/' && n === '/') { inLine = true; i++; continue; }
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      if (c === '"') {
        // double-quoted string: copy verbatim through its closing quote (escapes honored).
        out += c;
        let esc = false;
        for (i++; i < s.length; i++) {
          const d = s[i]; out += d;
          if (esc) { esc = false; continue; }
          if (d === '\\') { esc = true; continue; }
          if (d === '"') break;
        }
        continue;
      }
      if (c === '\'') {
        // single-quoted string (JSON5): re-emit as a double-quoted one. \' becomes ', a bare " becomes \".
        out += '"';
        let esc = false;
        for (i++; i < s.length; i++) {
          const d = s[i];
          if (esc) { esc = false; out += (d === '\'') ? '\'' : ('\\' + d); continue; }
          if (d === '\\') { esc = true; continue; }
          if (d === '\'') break;
          out += (d === '"') ? '\\"' : d;
        }
        out += '"';
        continue;
      }
      // bare identifier KEY (JSON5): an identifier whose next non-space char is ':' gets quoted.
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
        const word = s.slice(i, j);
        let k = j;
        while (k < s.length && /[ \t\r\n]/.test(s[k])) k++;
        if (s[k] === ':') { out += '"' + word + '"'; i = j - 1; continue; }
        out += word; i = j - 1;   // a bare VALUE word (true/false/null/numbers-with-e) passes through untouched
        continue;
      }
      out += c;
    }
    // trailing commas — STRING-AWARE second pass (a naive regex would eat a comma inside a string literal, e.g.
    // {a:"x,]"}). After the first pass every string is double-quoted, so walk those spans and only drop a ','
    // whose next significant char OUTSIDE a string is } or ].
    let res = '';
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (c === '"') {
        res += c;
        let esc = false;
        for (i++; i < out.length; i++) { const d = out[i]; res += d; if (esc) { esc = false; continue; } if (d === '\\') { esc = true; continue; } if (d === '"') break; }
        continue;
      }
      if (c === ',') {
        let k = i + 1;
        while (k < out.length && /[ \t\r\n]/.test(out[k])) k++;
        if (out[k] === '}' || out[k] === ']') continue;   // trailing comma — drop it (the whitespace stays)
      }
      res += c;
    }
    return res;
  }

  // parseJson5(text) -> object|null. Fail-soft: an unparseable config yields null (caller notes it, never throws).
  function parseJson5(text) {
    if (!nonEmpty(text)) return null;
    try { return JSON.parse(scrubJson5(text)); } catch (_) { return null; }
  }

  // does a parsed config object carry ANY secret-shaped field (recursively)? An `env` section or an api_key/token/
  // secret/... key anywhere = true. We never read the VALUES — presence alone drives the "re-enter your key" warning.
  function configHasSecret(obj, depth) {
    if (depth == null) depth = 0;
    if (depth > 8 || !isObj(obj)) return false;
    for (const k of Object.keys(obj)) {
      if (k === 'env' || SECRET_KEY_RE.test(k)) return true;
      const v = obj[k];
      if (isObj(v) && configHasSecret(v, depth + 1)) return true;
      if (Array.isArray(v)) { for (const it of v) { if (isObj(it) && configHasSecret(it, depth + 1)) return true; } }
    }
    return false;
  }

  // split a "provider/model" id (OpenClaw's agents.defaults.model.primary). No slash -> the whole string is the model.
  function splitModelId(raw) {
    const r = nonEmpty(raw) ? String(raw).trim() : null;
    if (!r) return { raw: null, model: null, provider: null };
    const i = r.indexOf('/');
    if (i > 0) return { raw: clampStr(r, MODEL_MAX), provider: clampStr(r.slice(0, i), MODEL_MAX), model: clampStr(r.slice(i + 1), MODEL_MAX) };
    return { raw: clampStr(r, MODEL_MAX), model: clampStr(r, MODEL_MAX), provider: null };
  }

  // OpenClaw model: agents.defaults.model.primary = "provider/model".
  function openclawModel(config) {
    if (!isObj(config)) return { raw: null, model: null, provider: null };
    let primary = null;
    try {
      const a = config.agents;
      if (isObj(a) && isObj(a.defaults) && isObj(a.defaults.model)) primary = a.defaults.model.primary;
    } catch (_) { /* fail-soft */ }
    return splitModelId(primary);
  }

  // OpenClaw agent roster: agents.list = [{ id, default?, workspace? }]. index.js enumerates workspaces from this.
  // Fail-soft default: no list -> the single default agent (so the default workspace is still discoverable).
  function openclawAgents(config) {
    const list = isObj(config) && isObj(config.agents) && Array.isArray(config.agents.list) ? config.agents.list : null;
    if (!list || !list.length) return [{ id: 'default', default: true, workspace: null }];
    const out = [];
    for (const a of list) {
      if (!isObj(a)) continue;
      const id = nonEmpty(a.id) ? String(a.id).trim() : (a.default ? 'default' : null);
      if (!id) continue;
      out.push({ id: id, default: !!a.default, workspace: nonEmpty(a.workspace) ? String(a.workspace).trim() : null });
    }
    return out.length ? out : [{ id: 'default', default: true, workspace: null }];
  }

  // strip one layer of surrounding quotes; else drop a trailing ` # comment` and trim (YAML scalar, best effort).
  function unquoteYaml(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const q = s[0];
    if ((q === '"' || q === '\'') && s.length > 1) {
      const end = s.indexOf(q, 1);
      if (end > 0) return s.slice(1, end);
      return s.slice(1);
    }
    const hash = s.indexOf(' #');
    if (hash >= 0) s = s.slice(0, hash).trim();
    return s;
  }

  /* Hermes model: minimal line-based read of the `model:` block's default/model/provider scalars (no YAML dep).
       model:
         default: "anthropic/claude-3"
         provider: anthropic
     Tolerant of quotes and an inline `model: foo`. If provider is absent but the id is "provider/model" shaped we
     split it (matching OpenClaw's shape) so the preview always has a provider when the id carries one. */
  function hermesModel(text) {
    if (!nonEmpty(text)) return { raw: null, model: null, provider: null };
    const lines = String(text).split(/\r?\n/);
    let inBlock = false, blockIndent = -1;
    const got = {};
    for (const rawLine of lines) {
      if (!rawLine.trim()) continue;
      const indent = rawLine.length - rawLine.replace(/^\s*/, '').length;
      const line = rawLine.trim();
      if (!inBlock) {
        const m = line.match(/^model:\s*(.*)$/);
        if (m) {
          if (nonEmpty(m[1])) { got.default = unquoteYaml(m[1]); }   // inline form: model: <id>
          else { inBlock = true; blockIndent = indent; }
        }
        continue;
      }
      if (indent <= blockIndent) { inBlock = false; continue; }      // block ended (dedent)
      const kv = line.match(/^(default|model|provider):\s*(.*)$/);
      if (kv) got[kv[1]] = unquoteYaml(kv[2]);
    }
    const id = nonEmpty(got.default) ? got.default : (nonEmpty(got.model) ? got.model : null);
    const provider = nonEmpty(got.provider) ? got.provider : null;
    if (id && !provider && id.indexOf('/') > 0) return splitModelId(id);
    return { raw: id ? clampStr(id, MODEL_MAX) : null, model: id ? clampStr(id, MODEL_MAX) : null, provider: provider ? clampStr(provider, MODEL_MAX) : null };
  }

  // first heading line of a markdown doc, ANY level (# .. ######) — a SOUL.md that opens with '## Nyx' still names
  // the agent. Returns the heading text, null if none.
  function firstHeading(md) {
    if (!nonEmpty(md)) return null;
    const lines = String(md).split(/\r?\n/);
    for (const l of lines) {
      const m = l.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (m && nonEmpty(m[1])) return clampStr(m[1].trim(), NAME_MAX);
    }
    return null;
  }

  // OpenClaw IDENTITY.md name: first `# ` heading, else a `Name:` line. best effort, null if neither.
  function nameFromIdentity(md) {
    const h = firstHeading(md);
    if (h) return h;
    if (!nonEmpty(md)) return null;
    const lines = String(md).split(/\r?\n/);
    for (const l of lines) {
      const m = l.match(/^\s*name\s*[:=]\s*(.+?)\s*$/i);
      if (m && nonEmpty(m[1])) return clampStr(m[1].trim().replace(/^["']|["']$/g, ''), NAME_MAX);
    }
    return null;
  }

  /* ---- scanProfile({ harness, files, dailyCount, warnings }) — the normalizer. `files` is a map of rel-path ->
     string content (a missing file is simply absent). `dailyCount` is index.js's count of memory/*.md daily notes
     (falls back to counting memory/ keys present in `files` if omitted). `warnings` seeds the returned warning list
     (e.g. per-file read notes index.js already collected). Returns the preview described in the header, or
     { ok:false, reason:'nothing-found' } when nothing usable was present. NEVER throws. ---- */
  function scanProfile(o) {
    o = o || {};
    const harness = o.harness === 'hermes' ? 'hermes' : (o.harness === 'openclaw' ? 'openclaw' : null);
    const files = isObj(o.files) ? o.files : {};
    const warnings = Array.isArray(o.warnings) ? o.warnings.slice() : [];
    let secretWarned = false;
    const addSecretWarning = () => { if (!secretWarned) { warnings.push(SECRET_WARNING); secretWarned = true; } };

    if (!harness) return { ok: false, reason: 'unknown-harness' };

    // pick the right rel keys per harness.
    const personaRaw = files['SOUL.md'];
    const instructionsRaw = files['AGENTS.md'];
    const userRaw = harness === 'openclaw' ? files['USER.md'] : files['memories/USER.md'];
    const curatedRaw = harness === 'openclaw' ? files['MEMORY.md'] : files['memories/MEMORY.md'];
    const configRaw = harness === 'openclaw' ? files['openclaw.json'] : files['config.yaml'];

    const sources = [];
    const persona = nonEmpty(personaRaw) ? clampStr(personaRaw, TEXT_MAX) : '';
    if (persona) sources.push('SOUL.md');
    const instructions = nonEmpty(instructionsRaw) ? clampStr(instructionsRaw, TEXT_MAX) : '';
    if (instructions) sources.push('AGENTS.md');
    const userContext = nonEmpty(userRaw) ? clampStr(userRaw, TEXT_MAX) : '';
    if (userContext) sources.push(harness === 'openclaw' ? 'USER.md' : 'memories/USER.md');
    const curated = nonEmpty(curatedRaw) ? clampStr(curatedRaw, TEXT_MAX) : '';
    if (curated) sources.push(harness === 'openclaw' ? 'MEMORY.md' : 'memories/MEMORY.md');

    // name: OpenClaw parses IDENTITY.md; Hermes takes the SOUL.md heading.
    let name = null;
    if (harness === 'openclaw') {
      name = nameFromIdentity(files['IDENTITY.md']);
      if (name && sources.indexOf('IDENTITY.md') < 0) sources.push('IDENTITY.md');
    } else {
      name = firstHeading(personaRaw);
    }

    // model + secret sweep from the config (values never emitted; presence drives the warning).
    let model = { raw: null, model: null, provider: null };
    if (nonEmpty(configRaw)) {
      if (harness === 'openclaw') {
        const cfg = parseJson5(configRaw);
        if (cfg == null) warnings.push('openclaw.json could not be parsed — model not imported');
        else {
          model = openclawModel(cfg);
          if (configHasSecret(cfg)) addSecretWarning();
        }
      } else {
        model = hermesModel(configRaw);
        if (/api_key/i.test(configRaw) || SECRET_KEY_RE.test(configRaw)) addSecretWarning();
      }
      if (model.raw) sources.push(harness === 'openclaw' ? 'openclaw.json' : 'config.yaml');
    }

    // daily-note count: prefer index.js's explicit count; else count memory/*.md keys present in `files`.
    let dailyCount = (typeof o.dailyCount === 'number' && o.dailyCount >= 0) ? (o.dailyCount | 0) : 0;
    if (!(typeof o.dailyCount === 'number')) {
      for (const k of Object.keys(files)) { if (/^memor(y|ies)\/.*\.md$/i.test(k) && !/\/(MEMORY|USER)\.md$/i.test(k)) dailyCount++; }
    }

    // nothing usable? honest empty answer (matches configexport's fail-soft posture).
    if (!sources.length && !name && !model.raw) return { ok: false, reason: 'nothing-found' };

    return {
      ok: true,
      harness: harness,
      name: name || null,
      persona: persona,
      instructions: instructions,
      userContext: userContext,
      memory: { curated: curated, dailyCount: dailyCount },
      model: model,
      sources: sources,
      warnings: warnings
    };
  }

  return {
    TEXT_MAX,
    detectCandidates, filesWanted, scanProfile, nonLocalPathReason,
    // parseJson5 + openclawAgents power index.js's detect enumeration; openclawModel/hermesModel ride along for
    // the pure tests. Everything else stays internal.
    parseJson5, openclawAgents, openclawModel, hermesModel
  };
});
