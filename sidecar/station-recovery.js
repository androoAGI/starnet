/* sidecar/station-recovery.js — portable, verified whole-station recovery bundles.

   This is deliberately an offline/quiescent primitive. The caller must stop the sidecar (or otherwise
   establish a mutation barrier) before capture/restore. A successful bundle is one recovery point with
   zero completed mutations lost before that barrier; this module does not pretend that periodic/continuous
   RPO exists when the caller has not established one.

   The bundle contains every non-ephemeral file under WORKSPACES plus browser-owned `starnet.*` state supplied
   by the caller. System-managed credentials are never exported: connector/channel identities and non-secret
   configuration survive, while OAuth/token/key material is removed and listed under `reauthentication`.

   Capture and restore are fail-closed:
     * every payload is SHA-256 bound;
     * backup files commit through temp -> fsync -> rename;
     * restore writes and verifies a sibling staging directory before activation;
     * corrupt/incomplete bundles never mutate the destination;
     * replacing an existing profile retains the previous directory as a rollback generation.
*/
'use strict';

const crypto = require('crypto');
const fsNative = require('fs');
const pathNative = require('path');

const SCHEMA = 'starnet.station-recovery';
const VERSION = 1;
const REQUIRED_CATEGORIES = [
  'agents', 'rooms_props', 'conversations', 'memories', 'routines', 'loops', 'tasks',
  'projects', 'deliverables', 'permissions', 'connector_references'
];

const SAFE_BROWSER_SECRET_KEYS = new Set([
  'starnet.byok.model', 'starnet.byok.prov', 'starnet.byok.reasoningEffort'
]);
const BROWSER_SECRET_NAMESPACE = /^(?:starnet|skynet)\.(?:channels?|oauth|auth|credentials?|secrets?)(?:[._:-]|$)/i;
const BROWSER_SECRET_SEGMENT = /(?:^|[._:-])(?:api[-_]?key|apikey|key|keys|token|tokens|secret|secrets|credential|credentials|password|passwd|pwd|authorization|bearer)(?:$|[._:-])/i;
const SECRET_FIELD = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|key|api[_-]?key|secret|client[_-]?secret|password|passwd|pwd|authorization|bearer|cookie|session)$/i;
const EPHEMERAL_TOP = new Set(['.browser-profile', '.starnet-workspace-owner.json.generations']);
const EPHEMERAL_FILES = new Set(['cron.lock', 'proc-ledger.json', '.starnet-workspace-owner.json']);
const SYSTEM_SECRET_TOP = new Set(['.secrets', 'codex', 'grok', 'kimi']);

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function slash(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function systemSecretPath(p) { return SYSTEM_SECRET_TOP.has(slash(p).split('/')[0].toLowerCase()); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function stableSort(arr, key) { return arr.sort((a, b) => String(key(a)).localeCompare(String(key(b)))); }
function safeId(v, fallback) { return String(v == null ? fallback || '' : v).slice(0, 200); }

function browserKeyIsSecret(raw) {
  const key = String(raw || '').replace(/^skynet\./i, 'starnet.');
  if (SAFE_BROWSER_SECRET_KEYS.has(key)) return false;
  if (/^starnet\.byok\./i.test(key)) return true;
  return BROWSER_SECRET_NAMESPACE.test(key) || BROWSER_SECRET_SEGMENT.test(key);
}

function categoriesFor(rel) {
  const p = slash(rel).toLowerCase();
  const out = new Set();
  if (p === 'agent.roster.json' || /(^|\/)[a-z0-9_-]+\.save\.json$/.test(p)) out.add('agents');
  if (/\.save\.json$/.test(p) || p === 'station.widgets.json') out.add('rooms_props');
  if (/transcript|history\.json$|chatmap\.json$|outbox\.json$|runs\.jsonl$|\.run-journal\//.test(p)) out.add('conversations');
  if (/notebook|memory|personalization|dossier|goals|declined|threads/.test(p)) out.add('memories');
  if (/^cron\.|usercommands|routine/.test(p)) out.add('routines');
  if (/^loops(?:\.|\/)|loopjob/.test(p)) out.add('loops');
  if (/todo|taskbrief|quest|workshop|nightshift|scout/.test(p)) out.add('tasks');
  if (/^projects\.json$|project/.test(p)) out.add('projects');
  if (/deliverable|artifact|workshop|\.attachments\//.test(p)) out.add('deliverables');
  if (/permissions|allowed\.json$|skills-allowed|plugins-allowed|hooks-allowed/.test(p)) out.add('permissions');
  if (/^connectors\//.test(p) || /^channels\/(?:secrets|chatmap)\.json$/.test(p)) out.add('connector_references');
  // Agent workspace files are user-owned deliverables even when their names are novel.
  const top = p.split('/')[0];
  if (/^[a-z0-9_-]{1,40}$/.test(top) && p.indexOf('/') >= 0 && top !== 'channels' && top !== 'connectors') out.add('deliverables');
  return Array.from(out).sort();
}

function browserCategories(key) {
  const k = String(key || '').toLowerCase();
  const out = new Set();
  if (/\.save$/.test(k)) { out.add('agents'); out.add('rooms_props'); out.add('conversations'); }
  if (/station|prop|room|layout|skin/.test(k)) out.add('rooms_props');
  if (/memory|profile|dossier|interest|curiosity|return|pride/.test(k)) out.add('memories');
  if (/quest|task|todo|work/.test(k)) out.add('tasks');
  return Array.from(out).sort();
}

function sanitizeObject(value, pathParts, redacted) {
  if (Array.isArray(value)) return value.map((v, i) => sanitizeObject(v, pathParts.concat(String(i)), redacted));
  if (!isObj(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELD.test(k)) { redacted.push(pathParts.concat(k).join('.')); continue; }
    if (/^(?:headers|env)$/i.test(k) && isObj(v)) {
      const child = {};
      for (const [ck, cv] of Object.entries(v)) {
        if (/(?:token|secret|key|password|auth|bearer|cookie|session)/i.test(ck)) redacted.push(pathParts.concat(k, ck).join('.'));
        else child[ck] = sanitizeObject(cv, pathParts.concat(k, ck), redacted);
      }
      out[k] = child;
      continue;
    }
    if (/^(?:url|endpoint)$/i.test(k) && typeof v === 'string') {
      try {
        const u = new URL(v);
        if (u.username || u.password || u.search) redacted.push(pathParts.concat(k, 'auth').join('.'));
        u.username = ''; u.password = ''; u.search = '';
        out[k] = u.toString();
      } catch (_) { out[k] = v; }
      continue;
    }
    out[k] = sanitizeObject(v, pathParts.concat(k), redacted);
  }
  return out;
}

function sanitizeManagedJson(rel, raw, options = {}) {
  const p = slash(rel).toLowerCase();
  if (!/^connectors\/(?:state|connectors|oauth|servicekeys)\.json$/.test(p) && p !== 'channels/secrets.json' && p !== 'permissions.allow.json') return null;
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); }
  catch (e) { throw new Error('credential-bearing state is not valid JSON: ' + rel); }
  const redacted = [];
  let value;
  const reauthentication = [];
  if (p === 'permissions.allow.json') {
    const allow = Array.isArray(doc.allow) ? doc.allow.filter(x => typeof x === 'string') : [];
    const machinePaths = allow.filter(x => x.indexOf('path:') === 0);
    const meta = isObj(doc.meta) ? doc.meta : {};
    const keptMeta = {};
    for (const [key, row] of Object.entries(meta)) if (machinePaths.indexOf(key) < 0) keptMeta[key] = row;
    value = Object.assign({}, doc, { allow: allow.filter(x => x.indexOf('path:') !== 0), meta: keptMeta });
    for (const key of machinePaths) reauthentication.push({ kind: 'project-path', id: key.slice(5), reason: 'Machine-specific path authority is not transferable; restore or relocate the project, then re-authorize it.', fields: ['permissions.allow'] });
  } else if (p === 'connectors/state.json') {
    if (typeof doc.format === 'string' && doc.format.startsWith('starnet.connector-vault.')) {
      if (typeof options.readConnectorState !== 'function') throw new Error('Encrypted connector export requires the running StarNet app and its unlocked OS credential store.');
      doc = options.readConnectorState();
      if (!doc || doc.version !== 2 || !Array.isArray(doc.configs) || !isObj(doc.oauth)) throw new Error('Encrypted connector export could not verify the original settings.');
    }
    const configs = Array.isArray(doc.configs) ? doc.configs.map((cfg, i) => {
      const fields = [];
      const clean = sanitizeObject(cfg, ['configs', String(i)], fields);
      if (fields.length || (doc.oauth && doc.oauth.byId && doc.oauth.byId[cfg && cfg.id])) {
        reauthentication.push({ kind: 'connector', id: safeId(cfg && cfg.id, 'connector-' + i), reason: 'OAuth/token material is intentionally excluded.', fields });
      }
      return clean;
    }) : [];
    for (const id of Object.keys((doc.oauth && doc.oauth.byId) || {})) {
      if (!reauthentication.some(x => x.kind === 'connector' && x.id === id)) reauthentication.push({ kind: 'connector', id, reason: 'OAuth authorization is intentionally excluded.', fields: ['oauth.byId.' + id] });
    }
    value = { version: Number(doc.version) || 2, configs, oauth: { byId: {}, clients: {} } };
  } else if (p === 'connectors/oauth.json') {
    value = { byId: {}, clients: {} };
    for (const id of Object.keys(doc.byId || {})) reauthentication.push({ kind: 'connector', id, reason: 'Legacy OAuth authorization is intentionally excluded.', fields: ['byId.' + id] });
  } else if (p === 'connectors/servicekeys.json') {
    const keys = Array.isArray(doc.keys) ? doc.keys : [];
    value = { version: Number(doc.version) || 1, keys: keys.map((row, i) => {
      const clean = sanitizeObject(row, ['keys', String(i)], redacted);
      clean.enabled = false;
      clean.configured = true;
      return clean;
    }) };
    for (const row of keys) reauthentication.push({ kind: 'service-key', id: safeId(row && (row.id || row.env || row.name), 'custom-service'), reason: 'Service API key is intentionally excluded.', fields: ['key'] });
  } else if (p === 'channels/secrets.json') {
    value = sanitizeObject(doc, [], redacted);
    for (const id of ['telegram', 'discord', 'slack', 'matrix']) {
      if (doc[id] && (doc[id].token || doc[id].key)) reauthentication.push({ kind: 'channel', id, reason: 'Channel/provider token is intentionally excluded.', fields: ['token', 'key'].filter(k => doc[id][k]) });
    }
  } else {
    value = sanitizeObject(doc, [], redacted);
    const rows = Array.isArray(doc.connectors) ? doc.connectors : [];
    for (const row of rows) if (row) reauthentication.push({ kind: 'connector', id: safeId(row.id || row.name, 'connector'), reason: 'Connector secret fields are intentionally excluded.', fields: redacted.slice() });
  }
  return { data: Buffer.from(JSON.stringify(value, null, 2) + '\n'), redacted, reauthentication };
}

function classifyPolicy(rel, st) {
  const p = slash(rel);
  const parts = p.split('/');
  const top = parts[0].toLowerCase();
  if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return { action: 'skip', reason: 'symbolic links are not portable or safe to follow' };
  if (EPHEMERAL_TOP.has(top)) return { action: 'skip', reason: 'ephemeral browser/runtime profile; sign-in must be re-established' };
  if (SYSTEM_SECRET_TOP.has(top)) return { action: 'skip', reason: 'system-managed credential material is intentionally excluded', reauth: { kind: top === '.secrets' ? 'credential-store' : 'provider', id: top, reason: 'Reauthentication required on the restored profile.' } };
  if (EPHEMERAL_FILES.has(p.toLowerCase()) || /(?:^|\/)\.owner\.lock$/.test(p.toLowerCase()) || /\.tmp(?:$|\.)/.test(p.toLowerCase())) return { action: 'skip', reason: 'ephemeral lock/process/temp state' };
  if (/\.bak$/.test(p.toLowerCase()) || /\.corrupt-\d+$/.test(p.toLowerCase())) return { action: 'skip', reason: 'superseded recovery/forensic generation; bundle versioning is authoritative' };
  if (/^connectors\/(?:state|connectors|oauth|servicekeys)\.json$/i.test(p) || /^channels\/secrets\.json$/i.test(p) || /^permissions\.allow\.json$/i.test(p)) return { action: 'sanitize' };
  return { action: 'include' };
}

function walkFiles(root, fs, path) {
  const out = [];
  function visit(abs, rel) {
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      const names = fs.readdirSync(abs).slice().sort();
      for (const name of names) visit(path.join(abs, name), rel ? path.join(rel, name) : name);
    } else out.push({ abs, rel: slash(rel), st });
  }
  if (fs.existsSync(root)) visit(root, '');
  return out;
}

function completeness(files, browser) {
  const have = new Set();
  for (const f of files) for (const c of f.categories || []) have.add(c);
  for (const e of browser || []) for (const c of e.categories || []) have.add(c);
  return REQUIRED_CATEGORIES.map(category => ({ category, status: have.has(category) ? 'present' : 'missing' }));
}

function capture(opts) {
  const o = opts || {};
  const fs = o.fs || fsNative;
  const path = o.path || pathNative;
  const root = path.resolve(String(o.workspaceRoot || ''));
  if (!o.workspaceRoot || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('capture requires an existing workspaceRoot directory');
  if (!Number.isFinite(o.now)) throw new Error('capture requires an injected numeric now');
  const files = [];
  const skipped = [];
  const reauthentication = [];
  for (const item of walkFiles(root, fs, path)) {
    const policy = classifyPolicy(item.rel, item.st);
    if (policy.action === 'skip') {
      skipped.push({ path: item.rel, reason: policy.reason });
      if (policy.reauth) reauthentication.push(policy.reauth);
      continue;
    }
    let data = fs.readFileSync(item.abs);
    /* LAST-KNOWN-GOOD SUBSTITUTION: savestore keeps <file>.bak precisely so a torn main can be recovered,
       and this bundle intentionally excludes .bak generations — so a bundle captured after a hard kill
       shipped the torn/zero-byte main and DROPPED the only good copy: completeness still read 'present',
       the bundle stamped complete, and restore produced a station whose save quarantines on first load
       with no .bak to fall back to. When an included .json main does not parse and its sibling .bak does,
       the bundle carries the .bak bytes as the file (recorded in skipped as a promotion). */
    if (policy.action === 'include' && /\.json$/i.test(item.rel)) {
      let mainOk = data.length > 0;
      if (mainOk) { try { JSON.parse(data.toString('utf8')); } catch (_) { mainOk = false; } }
      if (!mainOk) {
        try {
          const bak = fs.readFileSync(item.abs + '.bak');
          JSON.parse(bak.toString('utf8'));
          data = bak;
          skipped.push({ path: item.rel + '.bak', reason: 'promoted: torn main captured from its last-known-good .bak' });
        } catch (bakErr) {
          // No usable .bak — the torn main rides as-is (forensic truth). A MISSING sibling is the normal
          // case; an existing-but-unusable one earns a receipt on the report so the gap is visible.
          if (bakErr && bakErr.code !== 'ENOENT') skipped.push({ path: item.rel + '.bak', reason: 'unusable .bak: ' + ((bakErr && bakErr.message) || bakErr) });
        }
      }
    }
    let redactedFields = [];
    if (policy.action === 'sanitize') {
      const clean = sanitizeManagedJson(item.rel, data, o);
      data = clean.data;
      redactedFields = clean.redacted;
      reauthentication.push(...clean.reauthentication);
    }
    files.push({ path: item.rel, bytes: data.length, sha256: sha256(data), encoding: 'base64', data: data.toString('base64'), categories: categoriesFor(item.rel), redactedFields });
  }

  const browser = [];
  const browserStore = isObj(o.browserStore) ? o.browserStore : {};
  for (const key of Object.keys(browserStore).sort()) {
    if (!/^(?:starnet|skynet)\./i.test(key)) { skipped.push({ path: 'browser:' + key, reason: 'foreign browser key' }); continue; }
    if (browserKeyIsSecret(key)) {
      skipped.push({ path: 'browser:' + key, reason: 'browser credential material is intentionally excluded' });
      reauthentication.push({ kind: 'browser-credential', id: key, reason: 'Credential value is intentionally excluded.' });
      continue;
    }
    const value = String(browserStore[key]);
    const data = Buffer.from(value, 'utf8');
    browser.push({ key, bytes: data.length, sha256: sha256(data), value, categories: browserCategories(key) });
  }

  stableSort(files, x => x.path); stableSort(skipped, x => x.path); stableSort(browser, x => x.key);
  const requirements = completeness(files, browser);
  const complete = requirements.every(x => x.status === 'present');
  const uniqueReauth = [];
  const seenReauth = new Set();
  for (const row of reauthentication) {
    const k = [row.kind, row.id, row.reason].join('|');
    if (!seenReauth.has(k)) { seenReauth.add(k); uniqueReauth.push(row); }
  }
  const bundle = {
    schema: SCHEMA,
    version: VERSION,
    createdAt: o.now,
    appVersion: safeId(o.appVersion, 'unknown'),
    source: { workspaceName: path.basename(root), platform: safeId(o.platform, process.platform) },
    recoveryPoint: {
      mode: 'quiescent-snapshot',
      lastCompletedMutation: o.lastCompletedMutation == null ? null : o.lastCompletedMutation,
      completedMutationsLostAtPoint: 0,
      continuousRpoCompletedMutations: null,
      note: 'Zero loss is guaranteed through this successful quiescent snapshot; mutations after it require another recovery point.'
    },
    files,
    browser,
    report: { complete, requirements, skipped, reauthentication: uniqueReauth }
  };
  bundle.manifestSha256 = sha256(Buffer.from(JSON.stringify({ files: files.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 })), browser: browser.map(x => ({ key: x.key, bytes: x.bytes, sha256: x.sha256 })), recoveryPoint: bundle.recoveryPoint }), 'utf8'));
  return bundle;
}

function validate(bundle) {
  const errors = [];
  if (!bundle || bundle.schema !== SCHEMA) errors.push('not a StarNet station recovery bundle');
  if (bundle && Number(bundle.version) > VERSION) errors.push('bundle was created by a newer StarNet recovery format');
  const files = bundle && Array.isArray(bundle.files) ? bundle.files : [];
  const browser = bundle && Array.isArray(bundle.browser) ? bundle.browser : [];
  const seen = new Set();
  for (const row of files) {
    const rel = slash(row && row.path);
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) { errors.push('unsafe bundle path: ' + rel); continue; }
    if (systemSecretPath(rel)) errors.push('bundle contains forbidden system credential path: ' + rel);
    if (seen.has(rel.toLowerCase())) errors.push('duplicate bundle path: ' + rel);
    seen.add(rel.toLowerCase());
    let data;
    try { data = Buffer.from(String(row.data || ''), 'base64'); } catch (_) { data = Buffer.alloc(0); }
    if (data.length !== Number(row.bytes) || sha256(data) !== row.sha256) errors.push('payload checksum mismatch: ' + rel);
  }
  for (const row of browser) {
    const data = Buffer.from(String(row.value == null ? '' : row.value), 'utf8');
    if (data.length !== Number(row.bytes) || sha256(data) !== row.sha256) errors.push('browser payload checksum mismatch: ' + row.key);
    if (browserKeyIsSecret(row.key)) errors.push('bundle contains forbidden browser credential key: ' + row.key);
  }
  const expectedManifest = sha256(Buffer.from(JSON.stringify({ files: files.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 })), browser: browser.map(x => ({ key: x.key, bytes: x.bytes, sha256: x.sha256 })), recoveryPoint: bundle && bundle.recoveryPoint }), 'utf8'));
  if (bundle && bundle.manifestSha256 !== expectedManifest) errors.push('manifest checksum mismatch');
  const requirements = completeness(files, browser);
  if (bundle && bundle.report && bundle.report.complete && requirements.some(x => x.status !== 'present')) errors.push('bundle claims completeness but required categories are missing');
  return { ok: errors.length === 0, errors, requirements };
}

function writeBundleAtomic(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const check = validate(o.bundle);
  if (!check.ok) throw new Error('refusing invalid recovery bundle: ' + check.errors.join('; '));
  if ((!o.bundle.report || !o.bundle.report.complete) && !o.allowIncomplete) throw new Error('refusing incomplete recovery bundle');
  const file = path.resolve(String(o.file || ''));
  if (!o.file) throw new Error('writeBundleAtomic requires file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + String(o.nonce || o.bundle.manifestSha256.slice(0, 16));
  const raw = Buffer.from(JSON.stringify(o.bundle, null, 2) + '\n', 'utf8');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, raw);
    if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (typeof o.beforeCommit === 'function') o.beforeCommit({ temp, file, bytes: raw.length });
    fs.renameSync(temp, file);
    return { ok: true, file, bytes: raw.length, sha256: sha256(raw), manifestSha256: o.bundle.manifestSha256 };
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
    throw e;
  }
}

function readBundle(file, deps) {
  const fs = deps && deps.fs || fsNative;
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  const check = validate(bundle);
  if (!check.ok) throw new Error('invalid recovery bundle: ' + check.errors.join('; '));
  return bundle;
}

function safeTarget(target, path) {
  const resolved = path.resolve(String(target || ''));
  const parsed = path.parse(resolved);
  if (!target || resolved === parsed.root || resolved.length < parsed.root.length + 3) throw new Error('unsafe recovery target');
  return resolved;
}

function restore(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const check = validate(o.bundle);
  if (!check.ok) throw new Error('refusing invalid recovery bundle: ' + check.errors.join('; '));
  if (!o.bundle.report || !o.bundle.report.complete) throw new Error('refusing incomplete recovery bundle');
  const target = safeTarget(o.targetRoot, path);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const stage = target + '.restore-stage-' + process.pid + '-' + String(o.nonce || o.bundle.manifestSha256.slice(0, 16));
  const rollback = target + '.rollback-' + String(o.rollbackId || o.bundle.createdAt);
  if (fs.existsSync(stage)) throw new Error('restore staging directory already exists: ' + stage);
  if (fs.existsSync(target) && !o.replaceExisting) throw new Error('restore target is not clean; pass replaceExisting to retain it as a rollback generation');
  if (fs.existsSync(rollback)) throw new Error('rollback generation already exists: ' + rollback);
  const restored = [];
  let targetMoved = false;
  let activated = false;
  try {
    fs.mkdirSync(stage, { recursive: false });
    for (const row of o.bundle.files) {
      const rel = slash(row.path);
      const dest = path.resolve(stage, ...rel.split('/'));
      if (dest !== stage && !dest.startsWith(stage + path.sep)) throw new Error('unsafe restore path: ' + rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const data = Buffer.from(row.data, 'base64');
      fs.writeFileSync(dest, data);
      const back = fs.readFileSync(dest);
      if (sha256(back) !== row.sha256) throw new Error('restore read-back mismatch: ' + rel);
      restored.push({ path: rel, bytes: data.length, categories: row.categories || [] });
    }
    if (typeof o.beforeActivate === 'function') o.beforeActivate({ stage, target, rollback });
    if (fs.existsSync(target)) { fs.renameSync(target, rollback); targetMoved = true; }
    fs.renameSync(stage, target);
    activated = true;
    if (isObj(o.browserSink)) {
      for (const row of o.bundle.browser) o.browserSink[row.key] = row.value;
    } else if (typeof o.browserSink === 'function') {
      for (const row of o.bundle.browser) o.browserSink(row.key, row.value);
    }
    return {
      ok: true, target, rollback: targetMoved ? rollback : null,
      restored,
      skipped: clone((o.bundle.report && o.bundle.report.skipped) || []),
      reauthentication: clone((o.bundle.report && o.bundle.report.reauthentication) || []),
      requirements: check.requirements,
      recoveryPoint: clone(o.bundle.recoveryPoint),
      browserKeysRestored: o.bundle.browser.length
    };
  } catch (e) {
    try { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
    let rollbackError = null;
    if (activated && fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch (restoreError) { rollbackError = restoreError; }
    }
    if (targetMoved && !fs.existsSync(target) && fs.existsSync(rollback)) {
      try { fs.renameSync(rollback, target); }
      catch (restoreError) { rollbackError = rollbackError || restoreError; }
    }
    if (rollbackError && e && typeof e === 'object') e.rollbackError = rollbackError;
    throw e;
  }
}

function semanticFingerprint(bundle) {
  const check = validate(bundle);
  if (!check.ok) throw new Error(check.errors.join('; '));
  const byCategory = {};
  for (const c of REQUIRED_CATEGORIES) byCategory[c] = [];
  for (const row of bundle.files) for (const c of row.categories || []) (byCategory[c] || (byCategory[c] = [])).push(row.path + ':' + row.sha256);
  for (const row of bundle.browser) for (const c of row.categories || []) (byCategory[c] || (byCategory[c] = [])).push('browser:' + row.key + ':' + row.sha256);
  const out = {};
  for (const [c, rows] of Object.entries(byCategory)) out[c] = { entries: rows.length, sha256: sha256(Buffer.from(rows.sort().join('\n'))) };
  return out;
}

module.exports = {
  SCHEMA, VERSION, REQUIRED_CATEGORIES,
  capture, validate, writeBundleAtomic, readBundle, restore, semanticFingerprint,
  browserKeyIsSecret, categoriesFor,
  _internals: { sanitizeManagedJson, classifyPolicy, completeness, sha256 }
};
