/* sidecar/child-env.js — the ONE place a helper process's environment is built.

   Security audit 2026-09-25 (#13): every process the sidecar spawned without an explicit `env` inherited the
   sidecar's whole process.env — the per-launch API/IPC tokens, the desktop-injected provider keys and key pools,
   channel bot tokens, the credits token, the connector vault key, and the KEYS-tab service keys the sidecar itself
   exports. That reached git (whose hooks and fsmonitor run in USER repos during a project scan), shell hooks,
   PowerShell helpers, Chrome, project-loop checks and PTY terminals.

   THE RULE — strip what the STATION put there, keep what the USER put there:
     1. Every STARNET_* / SKYNET_* variable. That is Agent OS's own namespace: the desktop shell injects every
        secret it hands the sidecar under these names (src-tauri main.rs sidecar_command: SKYNET_API_TOKEN,
        SKYNET_IPC_TOKEN, SKYNET_<PROVIDER>_API_KEY, SKYNET_KEY_POOL_*, SKYNET_TELEGRAM/DISCORD_TOKEN,
        SKYNET_TELEGRAM_BOT_TOKENS, STARNET_CREDITS_TOKEN, STARNET_CONNECTOR_ENCRYPTION_KEY, …, each in both
        spellings), and the sidecar reads its own secrets only through them (ENV()).
     2. Every name the sidecar itself exported into process.env (the KEYS-tab service keys — servicekeys.applyEnv
        tracks exactly which names it owns). A helper never needs them; the agent shell gets them back explicitly
        through environment.mergeServiceEnv, which is the one surface they were pasted for.
     3. Any variable whose VALUE is a secret the station currently holds (the same live collector that feeds
        redact()'s known-value layer): a station credential re-exported under an innocent name is still stripped.
   A variable the user exported in their own shell (NPM_TOKEN, GITHUB_TOKEN, a bare OPENAI_API_KEY) is THEIRS and
   is kept for host helpers — unless its value is one the station holds (rule 3). Agent-driven commands
   (shell.exec, background jobs, terminals, code.run) are stricter still: environment.sanitizeChildEnv runs this
   builder and then strips every secret-SHAPED name as well. MCP stdio servers and LSP servers keep their own
   allowlist builders (a handful of runtime vars + the connector's explicit config env), which is stricter again.

   stationChildEnv(base?, extra?) -> env       base defaults to process.env; extra (explicit config) is layered last
   setStationSecretSource({ names?, values? })  both are functions returning iterables, read live on every call
   guardChildProcess(cp) -> cp-like            spawn/execFile/exec/execSync/execFileSync/spawnSync/fork default
                                                a missing `env` option to stationChildEnv(process.env); an explicit
                                                `env` is the caller's decision and is passed through untouched. */
'use strict';
const { note: failNote } = require('./failopen.js');

const STATION_NAME_RE = /^(?:AGENT OS|SKYNET)_/i;
// Never stripped by the value rule: a process without these cannot even start, and a connector env value that
// happened to equal a path must not take PATH down with it.
const NEVER_STRIP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
  'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'SHELL', 'LANG', 'LC_ALL', 'USER', 'USERNAME', 'LOGNAME', 'PWD']);
const VALUE_MIN = 8;   // same floor as context.js KNOWN_MIN: shorter strings collide with ordinary values

let source = { names: null, values: null };
function setStationSecretSource(s) {
  s = s || {};
  source = {
    names: typeof s.names === 'function' ? s.names : null,
    values: typeof s.values === 'function' ? s.values : null
  };
}
function readSet(fn, upper) {
  const out = new Set();
  if (!fn) return out;
  let raw;
  try { raw = fn(); } catch (e) { failNote('child-env.source', e); return out; }
  if (!raw || typeof raw[Symbol.iterator] !== 'function') return out;
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    if (upper) out.add(t.toUpperCase());
    else if (t.length >= VALUE_MIN) out.add(t);
  }
  return out;
}

function stationChildEnv(base, extra) {
  const src = base || process.env || {};
  const ownedNames = readSet(source.names, true);
  const heldValues = readSet(source.values, false);
  const out = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v == null) continue;
    const K = k.toUpperCase();
    if (STATION_NAME_RE.test(k)) continue;                                   // rule 1
    if (ownedNames.has(K)) continue;                                        // rule 2
    const s = String(v);
    if (!NEVER_STRIP.has(K) && heldValues.size && heldValues.has(s.trim())) continue;   // rule 3
    out[k] = s;
  }
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const v = extra[k];
      if (v != null) out[k] = String(v);
    }
  }
  return out;
}

function isOptionsObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
/* Fill a missing `env` in a child_process argument list (any of the spawn/exec/execFile call shapes). */
function withStationEnv(args) {
  const a = Array.prototype.slice.call(args);
  for (let i = 1; i < a.length; i++) {
    if (isOptionsObject(a[i])) {
      if (Object.prototype.hasOwnProperty.call(a[i], 'env') && a[i].env) return a;
      a[i] = Object.assign({}, a[i], { env: stationChildEnv(process.env) });
      return a;
    }
  }
  const opts = { env: stationChildEnv(process.env) };
  let at = a.length;
  for (let i = 1; i < a.length; i++) if (typeof a[i] === 'function') { at = i; break; }
  // execFile(file, undefined|null, opts?) — collapse an explicit empty slot rather than shifting the callback
  if (at > 1 && a[at - 1] == null && at - 1 >= 1 && !Array.isArray(a[at - 1])) { a[at - 1] = opts; return a; }
  a.splice(at, 0, opts);
  return a;
}
const GUARDED = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
function guardChildProcess(cp) {
  const out = Object.create(cp);
  for (const name of GUARDED) {
    if (typeof cp[name] !== 'function') continue;
    const orig = cp[name];
    out[name] = function guardedChildProcessCall() { return orig.apply(cp, withStationEnv(arguments)); };
  }
  return out;
}

module.exports = { stationChildEnv, setStationSecretSource, guardChildProcess, withStationEnv, STATION_NAME_RE };
