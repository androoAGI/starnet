/* sidecar/configexport.js — STATION BACKUP (P1-7): serialize the station's persisted config/state to ONE
   portable JSON file, import it back, and reset a section to its defaults. Pure + injected-deps (no IO / clock /
   env) so it is node-testable; index.js wires the live stores (budget/fallback/roster/dossier/connectors/
   permissions/autonomy/notify prefs) into the collectors below and persists what applyImport returns.

   SECURITY LAW (non-negotiable): secrets NEVER leave the machine. Provider keys, bot tokens and OAuth sessions
   are exported as a `configured: true` marker ONLY — the raw secret is never read into the envelope. On import
   those markers surface a "re-enter your key" state; the import never fabricates a secret it doesn't have.

   FORMAT: a schema-versioned envelope { starnetExport: 1, exportedAt, app, sections: {...} }. `starnetExport`
   is the migration pivot: a future importer can branch on it. Every section is OPTIONAL — a partial export (or a
   partial import selecting only some sections) round-trips cleanly. Unknown sections are ignored on import (never
   a hard failure), so a newer export can still be read by an older build (forward-tolerant).

   This module owns ONLY the shape + validation + redaction. It performs no IO: index.js reads the live values in,
   and writes applyImport's result back through the SAME durable stores the app already persists to. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).configexport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the Permissions panel's curated grant catalog — the only standing approvals an imported file may carry
  const GRANTABLE = (typeof module !== 'undefined' && module.exports) ? require('./permgrants.js').GRANTABLE
    : (((typeof globalThis !== 'undefined' ? globalThis : {}).SK || {}).permgrants || { GRANTABLE: [] }).GRANTABLE;
  const SCHEMA = 1;
  const MAX_CONNECTOR_ARGS = 128;
  const MAX_CONNECTOR_ARG_LENGTH = 4096;
  const MAX_REDACTED_FIELDS = 512;
  const MAX_CONNECTOR_MAP_FIELDS = 256;
  const MAX_CONNECTOR_VALUE_LENGTH = 8192;

  // the sections a station backup carries. Order is stable so an exported file diffs cleanly across versions.
  // Each key maps to a live collector (export) + a live applier (import) wired in index.js. `secret:true` marks
  // a section that carries a configured-marker ONLY (never the raw secret).
  const SECTIONS = [
    'settings',       // theme/display/audio + notification prefs (browser-owned UI state, passed in by the app)
    'budget',         // USD caps (budget.json overrides)
    'fallback',       // ordered fallback model chain (fallback.json)
    'autonomy',       // initiative/reach knobs (browser-owned; passed in by the app)
    'roster',         // agent roster metadata: name/model/provider/role (agent.roster.json) — NO system secrets
    'dossier',        // the Commander dossier block (_commander.dossier.json)
    'permissions',    // standing capability grants (permissions.allow.json)
    'connectors',     // MCP connector configs — REDACTED (headers/env/url auth stripped; configured marker kept)
    'notifyPrefs'     // per-category notification toggles (browser-owned; passed in by the app)
  ];

  function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
  function clampStr(s, max) { return String(s == null ? '' : s).slice(0, max || 4096); }
  function validConnectorField(field) {
    if (field === 'token' || field === 'oauth' || field === 'url:auth') return true;
    let m = /^args:(0|[1-9]\d*)$/.exec(field);
    if (m) return Number(m[1]) < MAX_CONNECTOR_ARGS;
    m = /^(env|header):([^\r\n]{1,256})$/.exec(field);
    return !!m && m[2] !== '__proto__' && m[2] !== 'prototype' && m[2] !== 'constructor';
  }
  function validConnectorMapKeys(obj) {
    if (!isObj(obj)) return false;
    const keys = Object.keys(obj);
    return keys.length <= MAX_CONNECTOR_MAP_FIELDS && keys.every(k => k.length > 0 && k.length <= 256 &&
      k !== '__proto__' && k !== 'prototype' && k !== 'constructor' && !/[\r\n]/.test(k));
  }
  function validConnectorMap(obj) {
    return validConnectorMapKeys(obj) && Object.keys(obj).every(k =>
      String(obj[k] == null ? '' : obj[k]).length <= MAX_CONNECTOR_VALUE_LENGTH);
  }
  function copyConnectorMap(obj) {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = String(obj[k] == null ? '' : obj[k]);
    return out;
  }

  /* ---- REDACTION helpers: strip anything secret-shaped from a value before it enters the envelope. ---- */
  // keys whose VALUES are secrets (case-insensitive substring match). Used to scrub connector headers/env.
  const SECRET_KEY_RE = /(token|secret|key|password|passwd|pwd|auth|bearer|credential|cookie|session)/i;
  function redactMap(obj) {
    // returns { keys: [...names...], count } — we keep the NAMES of configured fields (so import can say
    // "re-enter AUTHORIZATION") but never the values. Non-secret-looking keys keep their value.
    const out = {}; const redacted = [];
    if (!isObj(obj)) return { value: {}, redacted: [] };
    for (const k of Object.keys(obj)) {
      if (SECRET_KEY_RE.test(k)) { redacted.push(k); continue; }   // drop the value entirely
      const v = obj[k];
      out[k] = (typeof v === 'string') ? clampStr(v, 2048) : v;
    }
    return { value: out, redacted };
  }

  // Connector header/env values are an open-ended credential surface. Names such as ACCESS or X-CUSTOM do not
  // reliably reveal whether the value is a secret, so a portable "secrets excluded" export keeps names only.
  function redactAllMap(obj, prefix) {
    const redacted = [];
    if (!isObj(obj)) return { value: {}, redacted };
    if (!validConnectorMapKeys(obj)) throw new RangeError('connector headers or environment exceed supported limits');
    for (const k of Object.keys(obj)) redacted.push((prefix || '') + k);
    return { value: {}, redacted };
  }

  function redactArgs(args) {
    // CLI values are an open-ended secret surface: `-H 'Authorization: ...'`, JSON blobs, positional API keys,
    // and vendor-specific names cannot be classified safely from spelling. Keep only positional re-entry markers.
    // The live importer can restore them from the protected local row when the stdio execution identity is exact;
    // a portable restore stays disabled until the values are re-entered.
    const src = Array.isArray(args) ? args : [];
    if (src.length > MAX_CONNECTOR_ARGS) throw new RangeError('connector arguments exceed the supported limit of ' + MAX_CONNECTOR_ARGS);
    const value = src.map(() => '<redacted>');
    const redacted = src.map((_, index) => 'args:' + index);
    return { value, redacted };
  }

  // sanitize ONE connector config for export: keep identity/shape, drop every secret field + any auth in the url.
  function redactConnector(c) {
    if (!isObj(c)) return null;
    const hdr = redactAllMap(c.headers || {}, 'header:');
    const env = redactAllMap(c.env || {}, 'env:');
    const args = redactArgs(c.args);
    // a url can carry a token in the query/userinfo — keep only origin+path, note if auth was present.
    let url = clampStr(c.url || c.endpoint || '', 1024);
    let urlHadAuth = false;
    if (url) {
      try {
        const u = new URL(url);
        if (u.username || u.password || u.searchParams.toString() || u.hash) urlHadAuth = true;
        u.username = ''; u.password = ''; u.search = '';
        u.hash = '';
        url = u.toString();
      } catch (_) {
        // An invalid URL cannot be separated safely into public routing data and private auth material.
        // Fail closed: keep a re-entry marker, never copy the opaque value into a portable backup.
        url = '<redacted>'; urlHadAuth = true;
      }
    }
    const redactedFields = hdr.redacted.concat(env.redacted, args.redacted)
      .concat(urlHadAuth ? ['url:auth'] : [])
      .concat(c.hasToken ? ['token'] : [])
      .concat(c.oauth === true ? ['oauth'] : [])
      .concat(Array.isArray(c.missingFields) ? c.missingFields : []);
    const uniqueRedactedFields = Array.from(new Set(redactedFields.filter(x => typeof x === 'string')));
    if (uniqueRedactedFields.length > MAX_REDACTED_FIELDS) throw new RangeError('connector redacted fields exceed the supported limit of ' + MAX_REDACTED_FIELDS);
    if (uniqueRedactedFields.some(field => !validConnectorField(field))) throw new RangeError('connector contains an invalid redacted field marker');
    const configured = uniqueRedactedFields.length > 0;
    return {
      id: clampStr(c.id || c.name || '', 40),
      transport: (c.transport === 'stdio') ? 'stdio' : 'http',
      url: url,
      command: clampStr(c.command || '', 512),         // stdio command (executable) — not a secret
      args: args.value,
      cwd: clampStr(c.cwd || '', 1024),
      agentId: clampStr(c.agentId || '', 40),
      label: clampStr(c.label || c.id || '', 120),
      enabled: c.enabled !== false,
      oauth: c.oauth === true,
      headers: hdr.value,
      env: env.value,
      timeoutMs: (typeof c.timeoutMs === 'number' && c.timeoutMs >= 0) ? c.timeoutMs : undefined,
      // the honest "you'll need to re-enter this" markers — NAMES only, never values.
      configured: configured,
      redactedFields: uniqueRedactedFields,
      missingFields: Array.isArray(c.missingFields) ? Array.from(new Set(c.missingFields.filter(x => typeof x === 'string'))) : []
    };
  }

  /* ---- BUILD the export envelope from a live snapshot. `src` is the plain-data snapshot index.js reads off its
     live stores (no IO here). Only the sections present in `src` are emitted; `only` optionally narrows further. */
  function buildExport(src, opts) {
    const s = isObj(src) ? src : {};
    const o = isObj(opts) ? opts : {};
    const only = Array.isArray(o.only) && o.only.length ? new Set(o.only) : null;
    const want = (name) => (!only || only.has(name)) && Object.prototype.hasOwnProperty.call(s, name);
    const sections = {};

    if (want('settings') && isObj(s.settings)) sections.settings = s.settings;
    if (want('budget')) sections.budget = isObj(s.budget) ? s.budget : {};
    if (want('fallback')) sections.fallback = { models: Array.isArray(s.fallback) ? s.fallback.map(m => clampStr(m, 200)) : [] };
    if (want('autonomy') && isObj(s.autonomy)) sections.autonomy = s.autonomy;
    if (want('roster') && Array.isArray(s.roster)) {
      // roster metadata only — model/provider/name/role. NEVER the composed system prompt (may embed dossier/secrets)
      // beyond a length note; NEVER a key. This is the marketplace-shareable slice.
      sections.roster = s.roster.map(a => ({
        agentId: clampStr(a && a.agentId, 40),
        name: clampStr(a && a.name, 40),
        model: a && a.model ? clampStr(a.model, 200) : null,
        provider: a && a.provider ? clampStr(a.provider, 40) : null,
        role: clampStr(a && a.role, 120),
        hasSystem: !!(a && a.system)
      })).filter(a => a.agentId);
    }
    if (want('dossier')) sections.dossier = { block: clampStr(s.dossier, 4096) };
    if (want('permissions')) sections.permissions = { allow: Array.isArray(s.permissions) ? s.permissions.filter(x => typeof x === 'string').slice(0, 256) : [] };
    if (want('connectors') && Array.isArray(s.connectors)) sections.connectors = s.connectors.map(redactConnector).filter(Boolean);
    if (want('notifyPrefs') && isObj(s.notifyPrefs)) sections.notifyPrefs = s.notifyPrefs;

    return {
      starnetExport: SCHEMA,
      exportedAt: (typeof o.now === 'number') ? o.now : null,
      app: clampStr(o.app || 'Agent OS', 40),
      sections
    };
  }

  /* ---- VALIDATE + NORMALIZE an imported envelope. Forward-tolerant: unknown sections are dropped (with a note),
     a future schema is accepted with a migration note, a malformed section is skipped (never a hard 500). Returns
     { ok, error?, schema, sections:{...cleaned...}, notes:[...], secretsNeeded:[...] }. secretsNeeded is the list
     of "re-enter your key" prompts the UI must surface. ---- */
  function parseImport(env) {
    if (!isObj(env)) return { ok: false, error: 'not a JSON object' };
    const schema = env.starnetExport;
    if (typeof schema !== 'number' || schema < 1) return { ok: false, error: 'missing or invalid "starnetExport" version marker' };
    const notes = [];
    if (schema > SCHEMA) notes.push('file is from a newer Agent OS (schema ' + schema + '); importing what this build understands');
    const inSec = isObj(env.sections) ? env.sections : {};
    const out = {};
    const secretsNeeded = [];

    // known-section cleaners — each fail-soft (a bad section is skipped, not fatal).
    if (isObj(inSec.settings)) out.settings = inSec.settings;
    if (isObj(inSec.budget)) {
      const b = {};
      for (const k of ['perRun', 'perAgent', 'perDay', 'global']) {
        const v = inSec.budget[k];
        if (typeof v === 'number' && isFinite(v) && v >= 0) b[k] = v;
      }
      out.budget = b;
    }
    if (isObj(inSec.fallback) && Array.isArray(inSec.fallback.models)) {
      out.fallback = { models: inSec.fallback.models.filter(m => typeof m === 'string' && m.trim()).map(m => clampStr(m, 200)).slice(0, 8) };
    }
    if (isObj(inSec.autonomy)) out.autonomy = inSec.autonomy;
    if (Array.isArray(inSec.roster)) {
      out.roster = inSec.roster.map(a => isObj(a) ? {
        agentId: clampStr(a.agentId, 40),
        name: clampStr(a.name, 40),
        model: a.model ? clampStr(a.model, 200) : null,
        provider: a.provider ? clampStr(a.provider, 40) : null,
        role: clampStr(a.role, 120)
      } : null).filter(a => a && /^[A-Za-z0-9_-]{1,40}$/.test(a.agentId));
    }
    if (isObj(inSec.dossier)) out.dossier = { block: clampStr(inSec.dossier.block, 4096) };
    if (isObj(inSec.permissions) && Array.isArray(inSec.permissions.allow)) {
      // A 'path:<root>' grant is machine-specific AUTHORITY, not a preference: it blesses a folder for agent file
      // reads (pathtrust) and checkpoint restores. A config file from another machine — or one crafted to carry
      // 'path:C:\' — must not widen this station's reach just by being imported. Same rule as station-recovery.js,
      // which strips path grants from backups: re-authorize the folder from a watched session instead.
      const allow = inSec.permissions.allow.filter(x => typeof x === 'string').slice(0, 256);
      const machinePaths = allow.filter(x => /^path:/i.test(x));
      // Any OTHER standing grant ("Always" on a shell card = workbench:execute, send, spend…) is authority too: a
      // shared or crafted file must not hand an agent unprompted execute just by being imported (2026-10-10). Only
      // the curated local-only catalog the Permissions panel itself may grant survives; the rest re-ask once.
      const grantable = new Set(GRANTABLE);
      const capability = allow.filter(x => !/^path:/i.test(x));
      out.permissions = { allow: capability.filter(x => grantable.has(x)) };
      const reask = capability.length - out.permissions.allow.length;
      if (machinePaths.length) notes.push('skipped ' + machinePaths.length + ' project folder grant' + (machinePaths.length === 1 ? '' : 's') + ' (path:…) — folder access is machine-specific; approve the folder again the first time an agent needs it');
      if (reask) notes.push('skipped ' + reask + ' standing approval' + (reask === 1 ? '' : 's') + ' (run commands, send, spend…) — an imported file never grants them; approve again the first time an agent asks');
    }
    if (Array.isArray(inSec.connectors)) {
      for (const c of inSec.connectors) {
        if (!isObj(c)) return { ok: false, error: 'connector entries must be JSON objects' };
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(c.id || ''))) return { ok: false, error: 'connector id must be 1-40 chars of [A-Za-z0-9_-]' };
        if (c.transport !== 'http' && c.transport !== 'stdio') return { ok: false, error: 'connector transport must be "http" or "stdio"' };
        if (c.transport === 'http') {
          let parsedUrl = null;
          try { parsedUrl = new URL(String(c.url || '')); } catch (_) { parsedUrl = null; }
          const urlRedacted = String(c.url || '') === '<redacted>' && [].concat(c.redactedFields || [], c.missingFields || []).indexOf('url:auth') >= 0;
          if (!urlRedacted && (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:'))) return { ok: false, error: 'connector "' + c.id + '" URL must start with http:// or https://' };
          if (c.oauth === true && !urlRedacted && (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password)) return { ok: false, error: 'connector "' + c.id + '" OAuth URL must use https:// without embedded credentials' };
        }
        if (c.transport === 'stdio' && !String(c.command || '').trim()) return { ok: false, error: 'connector "' + c.id + '" requires a stdio command' };
        if (Object.prototype.hasOwnProperty.call(c, 'args') && !Array.isArray(c.args)) return { ok: false, error: 'connector "' + c.id + '" args must be an array' };
        if (Array.isArray(c.args) && c.args.length > MAX_CONNECTOR_ARGS) return { ok: false, error: 'connector "' + c.id + '" has more than ' + MAX_CONNECTOR_ARGS + ' arguments' };
        if (Array.isArray(c.args) && c.args.some(a => String(a == null ? '' : a).length > MAX_CONNECTOR_ARG_LENGTH)) return { ok: false, error: 'connector "' + c.id + '" has an argument longer than ' + MAX_CONNECTOR_ARG_LENGTH + ' characters' };
        if (Object.prototype.hasOwnProperty.call(c, 'headers') && !validConnectorMap(c.headers)) return { ok: false, error: 'connector "' + c.id + '" headers are invalid or exceed supported limits' };
        if (Object.prototype.hasOwnProperty.call(c, 'env') && !validConnectorMap(c.env)) return { ok: false, error: 'connector "' + c.id + '" environment is invalid or exceeds supported limits' };
        if (Object.prototype.hasOwnProperty.call(c, 'redactedFields') && !Array.isArray(c.redactedFields)) return { ok: false, error: 'connector "' + c.id + '" redacted fields must be an array' };
        if (Object.prototype.hasOwnProperty.call(c, 'missingFields') && !Array.isArray(c.missingFields)) return { ok: false, error: 'connector "' + c.id + '" missing fields must be an array' };
        if (Array.isArray(c.redactedFields) && c.redactedFields.length > MAX_REDACTED_FIELDS) return { ok: false, error: 'connector "' + c.id + '" has too many redacted fields' };
        if (Array.isArray(c.missingFields) && c.missingFields.length > MAX_REDACTED_FIELDS) return { ok: false, error: 'connector "' + c.id + '" has too many missing fields' };
        if (new Set([].concat(c.redactedFields || [], c.missingFields || [])).size > MAX_REDACTED_FIELDS) return { ok: false, error: 'connector "' + c.id + '" has too many combined redacted fields' };
        if ([].concat(c.redactedFields || [], c.missingFields || []).some(field => typeof field !== 'string' || !validConnectorField(field))) return { ok: false, error: 'connector "' + c.id + '" has an invalid redacted field marker' };
      }
      const connectorIds = inSec.connectors.map(c => c.id);
      if (new Set(connectorIds).size !== connectorIds.length) return { ok: false, error: 'connector ids must be unique within an import' };
      out.connectors = inSec.connectors.map(c => {
        const row = {
          id: clampStr(c.id, 40),
          transport: c.transport,
          url: clampStr(c.url, 1024),
          command: clampStr(c.command, 512),
          args: Array.isArray(c.args) ? c.args.map(a => clampStr(a, MAX_CONNECTOR_ARG_LENGTH)) : [],
          headers: isObj(c.headers) ? copyConnectorMap(c.headers) : {},
          env: isObj(c.env) ? copyConnectorMap(c.env) : {},
          timeoutMs: (typeof c.timeoutMs === 'number' && c.timeoutMs >= 0) ? c.timeoutMs : undefined,
          redactedFields: Array.isArray(c.redactedFields) ? c.redactedFields.filter(x => typeof x === 'string').slice(0, MAX_REDACTED_FIELDS) : [],
          missingFields: Array.isArray(c.missingFields) ? c.missingFields.filter(x => typeof x === 'string').slice(0, MAX_REDACTED_FIELDS) : []
        };
        // These fields were absent from schema-1 exports before 0.10.13. Preserve absence here so the live
        // importer can use an existing row's value, or choose the safe disabled default for a new old-format row.
        if (typeof c.enabled === 'boolean') row.enabled = c.enabled;
        if (typeof c.oauth === 'boolean') row.oauth = c.oauth;
        if (typeof c.agentId === 'string') row.agentId = clampStr(c.agentId, 40);
        if (typeof c.cwd === 'string') row.cwd = clampStr(c.cwd, 1024);
        if (typeof c.label === 'string') row.label = clampStr(c.label, 120);
        return row;
      }).filter(c => c && c.id);
      // any connector that carried redacted secrets needs re-entry after import.
      for (const c of out.connectors) {
        if (c.redactedFields && c.redactedFields.length) secretsNeeded.push({ kind: 'connector', id: c.id, fields: c.redactedFields });
      }
    }
    if (isObj(inSec.notifyPrefs)) out.notifyPrefs = inSec.notifyPrefs;

    // note any sections we didn't recognize (forward-tolerance signal, not an error).
    for (const k of Object.keys(inSec)) { if (SECTIONS.indexOf(k) < 0) notes.push('ignored unknown section "' + k + '"'); }

    return { ok: true, schema, sections: out, notes, secretsNeeded };
  }

  return {
    SCHEMA, SECTIONS, MAX_CONNECTOR_ARGS, MAX_CONNECTOR_ARG_LENGTH, MAX_REDACTED_FIELDS,
    MAX_CONNECTOR_MAP_FIELDS, MAX_CONNECTOR_VALUE_LENGTH,
    buildExport, parseImport, validConnectorMap,
    redactConnector, _redactMap: redactMap
  };
});
