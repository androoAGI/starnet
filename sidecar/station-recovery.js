/* sidecar/station-recovery.js — portable, verified whole-station recovery bundles.

   This is deliberately an offline/quiescent primitive. The caller must stop the sidecar (or otherwise
   establish a mutation barrier: update-preparation.js) before capture/restore. A successful bundle is one recovery point with
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
  // quarantineCorrupt (index.js) names a torn store <file>.corrupt-<pid>-<seq>: the old \d+$ never matched that, so a
  // quarantined channels/secrets.json or connectors/servicekeys.json was copied RAW into every pre-update backup.
  if (/\.bak$/.test(p.toLowerCase()) || /\.corrupt-[\d-]+$/.test(p.toLowerCase())) return { action: 'skip', reason: 'superseded recovery/forensic generation; bundle versioning is authoritative' };
  // Any OTHER derivative of a credential store (a stray copy, a future suffix) can only be sanitized under its exact
  // name below; never include one raw.
  if (/^(?:channels\/secrets|connectors\/(?:state|connectors|oauth|servicekeys))\.json./i.test(p)) return { action: 'skip', reason: 'derivative copy of a credential store; only the live store is captured (sanitized)' };
  if (/^connectors\/(?:state|connectors|oauth|servicekeys)\.json$/i.test(p) || /^channels\/secrets\.json$/i.test(p) || /^permissions\.allow\.json$/i.test(p)) return { action: 'sanitize' };
  return { action: 'include' };
}

/* ONE UNREADABLE ENTRY NEVER ABORTS THE STATION (#91). Windows handed a shadow-Git checkpoint an entry that
   directory enumeration lists but lstat/readlink/realpath all answer ENOENT (a zero-length reparse point); the
   unguarded lstat threw, the capture aborted, and every in-app update stopped at "no verified recovery point".
   These codes mean THIS entry cannot be read right now (vanished mid-walk, locked, denied, an unresolvable
   reparse point) — it is listed in skipped as 'unreadable: <CODE>' and the walk goes on. The capture ROOT stays
   fail-closed, and any other error (EIO, EMFILE, a code-less bug) still aborts. */
const UNREADABLE_ENTRY = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES', 'EBUSY', 'ELOOP', 'EINVAL', 'UNKNOWN']);
function unreadableCode(e) { return e && UNREADABLE_ENTRY.has(e.code) ? e.code : null; }
// savestore's last-known-good generation of a JSON store: the <file>.bak bytes when they read AND parse, else null
function lastKnownGood(fs, abs) {
  try { const bak = fs.readFileSync(abs + '.bak'); JSON.parse(bak.toString('utf8')); return bak; }
  catch (_) { return null; }
}

// classifyPolicy skips every file under these top-level directories anyway, so they are skipped WHOLE before
// descending: walking a live Chrome profile (files vanishing mid-walk) or a provider token dir only risked the walk.
function skippedWholeTop(rel) {
  const p = slash(rel).toLowerCase();
  return p.indexOf('/') < 0 && (EPHEMERAL_TOP.has(p) || SYSTEM_SECRET_TOP.has(p));
}

function walkFiles(root, fs, path, unreadable) {
  const out = [];
  function visit(abs, rel) {
    let st, names;
    // the ROOT is stat'ed, not lstat'ed: a WORKSPACES reached through a junction/symlink IS the station (capture() validated
    // it with stat), and lstat made the whole root one symlink skip — a recovery point with zero files
    try { st = rel ? fs.lstatSync(abs) : fs.statSync(abs); }
    catch (e) {
      if (!rel || !unreadableCode(e)) throw e;
      // a credential/runtime dir is excluded by policy either way: keep its skip + reauth receipt (classifyPolicy takes a null st)
      if (skippedWholeTop(rel)) out.push({ abs, rel: slash(rel), st: null });
      else unreadable.push({ path: slash(rel), reason: 'unreadable: ' + e.code });
      return;
    }
    if (!st.isDirectory()) { out.push({ abs, rel: slash(rel), st }); return; }
    try { names = fs.readdirSync(abs).slice().sort(); }
    catch (e) {
      if (!rel || !unreadableCode(e)) throw e;
      // an unlistable credential/runtime dir is still excluded by policy (with its reauth receipt), not "unreadable"
      if (skippedWholeTop(rel)) out.push({ abs, rel: slash(rel), st });
      else unreadable.push({ path: slash(rel), reason: 'unreadable: ' + e.code });
      return;
    }
    // an empty one excluded nothing, so it earns no receipt (same as when its files were classified one by one)
    if (rel && skippedWholeTop(rel)) { if (names.length) out.push({ abs, rel: slash(rel), st }); return; }
    for (const name of names) visit(path.join(abs, name), rel ? path.join(rel, name) : name);
  }
  if (fs.existsSync(root)) visit(root, '');
  return out;
}

/* THE PRE-UPDATE BUDGET (update-path 10-23). A bundle is ONE JSON string, every payload base64 inside it, and V8 caps
   a string at ~536.8M chars: a station holding more than ~400 MB of included files threw RangeError in JSON.stringify,
   so every in-app update stopped at "no verified recovery point" with no way past it. capture({ maxBytes }) — passed by
   the pre-update preparation only; an explicit export still takes everything — fills the budget in priority order and
   NEVER reads a file that does not fit:
     0  the saves + the roster (the station itself)
     1  every other station store: top-level files, dot-state (.run-journal, .spend-pending …), station directories
        (channels, connectors, transcript-history-v2, skill-packages …)
     2  agents' own workspace files, shadow-Git checkpoints and archived workspaces
   smallest first inside a tier, so what is left out is the LARGEST files of the lowest tier. Each one is listed in
   report.skipped as BUDGET_SKIP_REASON with its size: the bundle never implies a byte-complete station.

   The budget is TWO limits. maxBytes bounds the file contents (memory). maxChars (default BUNDLE_MAX_CHARS, under the
   string cap) bounds the bundle's JSON text: every file row costs its base64 PLUS its JSON framing (path, sha256,
   categories, indentation: ~330 chars a row), so 500k small node_modules files overflowed the cap while their bytes
   fitted. Every row is charged the exact text JSON.stringify(bundle, null, 2) gives it (rowChars), the left-out list is
   bounded (SKIP_ROWS_LISTED rows by name per reason, the rest one row per folder, its largest possible size reserved
   before any file is admitted), and so are the rows the walk itself produces. What is guaranteed: the written bundle
   is at most maxChars characters. What is NOT: that every file rides — the saves + roster are admitted first, but a
   station whose saves alone exceed the budget gets a recovery point without them (report.complete says so). */
const BUDGET_SKIP_REASON = 'too large for the pre-update recovery point';
const BUNDLE_MAX_CHARS = Math.min(448 * 1024 * 1024, Math.floor(require('buffer').constants.MAX_STRING_LENGTH * 0.85));
const SKIP_ROWS_LISTED = 1000;
// the same limit met by a bundle a person asked for (no shorter pre-update budget: only the one-string cap applies)
const EXPLICIT_BUDGET_REASON = 'too large for one recovery bundle';
const CREDENTIAL_STORE_HOW_TO_GET = 'Open StarNet with this OS account and create the bundle from SETTINGS > APP & BACKUP > RECOVERY BUNDLE: the running app can read its own encrypted store and keeps the connector list without its credentials. Otherwise add these connectors again after restoring.';
const HEX64 = '0'.repeat(64);
const BIG = Number.MAX_SAFE_INTEGER;   // stands in for any size/count when a row's largest possible text is reserved
// the characters one array element adds to JSON.stringify(bundle, null, 2) at `depth` (files/browser rows 2, report
// rows 3): its own text, its indentation on every line, and the ",\n" that separates it
function rowChars(row, depth) {
  const s = JSON.stringify(row, null, 2);
  let lines = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) lines++;
  return s.length + lines * 2 * depth + 2;
}
// a file row's text before its payload is known (sha256 is fixed-width; base64 never needs escaping)
function fileRowChars(rel, bytes, categories, redactedFields) {
  return rowChars({ path: rel, bytes: bytes, sha256: HEX64, encoding: 'base64', data: '', categories: categories, redactedFields: redactedFields || [] }, 2) + 4 * Math.ceil(bytes / 3);
}
// left-out rows past SKIP_ROWS_LISTED collapse into one row per folder: the first two segments of the parent directory
function skipGroup(rel) { const parts = slash(rel).split('/'); parts.pop(); return parts.slice(0, 2).join('/'); }
function groupPath(group) { return group ? group + '/**' : '*'; }
// bounds report.skipped: per reason, the SKIP_ROWS_LISTED largest (then by name) stay; the rest are counted per folder
function compactSkipped(rows) {
  const byReason = new Map();
  for (const r of rows) { const k = String(r.reason); if (!byReason.has(k)) byReason.set(k, []); byReason.get(k).push(r); }
  const out = [];
  for (const group of byReason.values()) {
    if (group.length <= SKIP_ROWS_LISTED) { out.push(...group); continue; }
    const order = group.slice().sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0) || String(a.path).localeCompare(String(b.path)));
    out.push(...order.slice(0, SKIP_ROWS_LISTED));
    const folded = new Map();
    for (const r of order.slice(SKIP_ROWS_LISTED)) {
      const key = skipGroup(r.path);
      let agg = folded.get(key);
      if (!agg) { agg = { path: groupPath(key), reason: r.reason, files: 0 }; if (r.bytes != null) agg.bytes = 0; folded.set(key, agg); }
      agg.files += Number(r.files) || 1;
      if (agg.bytes != null) agg.bytes += Number(r.bytes) || 0;
    }
    out.push(...folded.values());
  }
  return out;
}
const STATION_DIRS = new Set(require('./workspace-reserved.js').STATION_DIRS.map(x => x.toLowerCase()));
function budgetTier(rel) {
  const p = slash(rel).toLowerCase();
  if (p === 'agent.roster.json' || /^[^/]+\.save\.json$/.test(p)) return 0;
  if (p.indexOf('/') < 0) return 1;
  const top = p.split('/')[0];
  if (top === '.checkpoints' || top === '_archive') return 2;
  if (top.charAt(0) === '.' || STATION_DIRS.has(top)) return 1;
  return 2;
}
// the set of rels that do NOT fit `maxBytes` / `maxChars` (sizes from the walk's lstat; nothing is read here). `chars`
// is what the rest of the bundle already costs; `base` adds the left-out list's reserve to it (the text before any
// file rides), and each admitted item carries its planned text in item.charge.
function budgetPlan(items, maxBytes, maxChars, chars) {
  const size = it => (it.st && Number(it.st.size)) || 0;
  const order = items.slice().sort((a, b) => budgetTier(a.rel) - budgetTier(b.rel) || size(a) - size(b) || String(a.rel).localeCompare(String(b.rel)));
  // the left-out list's largest possible text, whichever items end up in it (compactSkipped bounds its rows)
  let longestRow = 0;
  const groups = new Map();
  for (const it of order) {
    longestRow = Math.max(longestRow, rowChars({ path: it.rel, reason: BUDGET_SKIP_REASON, bytes: BIG }, 3));
    const g = skipGroup(it.rel);
    if (!groups.has(g)) groups.set(g, rowChars({ path: groupPath(g), reason: BUDGET_SKIP_REASON, files: BIG, bytes: BIG }, 3));
  }
  const folded = Array.from(groups.values()).sort((a, b) => b - a).slice(0, Math.max(0, order.length - SKIP_ROWS_LISTED));
  let used = 0;
  chars += Math.min(order.length, SKIP_ROWS_LISTED) * longestRow + folded.reduce((n, c) => n + c, 0);
  const base = chars;
  const over = new Set();
  for (const it of order) {
    const n = size(it);
    const c = fileRowChars(it.rel, n, it.categories);
    if (used + n <= maxBytes && chars + c <= maxChars) { used += n; chars += c; it.charge = c; }
    else over.add(it.rel);
  }
  return { over, order, base };
}

/* WHAT "COMPLETE" DOES NOT SAY (#119). report.complete answers one question: does every required category have evidence
   in this bundle. It says nothing about what happened to the files on the way in, so report.integrity answers the other
   one: verbatim is true only when nothing the person might want was left out, nothing was replaced from a .bak and no
   torn store rides as it was. What policy always leaves out (credentials, locks, browser profiles, superseded .bak
   generations) is excludedByDesign: listed, and never a gap. Only counts live here, so its text has a fixed bound (the
   budget reserves it); the rows themselves stay in report.skipped. A bundle made before this field has no torn-file
   evidence, so it can never read as verbatim (tornChecked false). */
const INTEGRITY_GAPS = ['unreadable', 'tooLarge', 'symlinks', 'promotedFromBak', 'unusableBak', 'tornKept', 'omitted'];
const GAP_REASON = /^(?:unreadable: |too large for |symbolic links |promoted: |unusable \.bak|torn: |omitted: )/;
function integrityOf(report, tornChecked) {
  const r = report || {};
  const counts = { unreadable: 0, tooLarge: 0, symlinks: 0, promotedFromBak: 0, unusableBak: 0, tornKept: 0, omitted: 0, excludedByDesign: 0 };
  for (const row of Array.isArray(r.skipped) ? r.skipped : []) {
    const why = String(row && row.reason), n = Number(row && row.files) || 1;
    if (/^unreadable: /.test(why)) counts.unreadable += n;
    else if (/^too large for /.test(why)) counts.tooLarge += n;
    else if (/^symbolic links /.test(why)) counts.symlinks += n;
    else if (/^promoted: /.test(why)) counts.promotedFromBak += n;
    else if (/^unusable \.bak/.test(why)) counts.unusableBak += n;
    else if (/^torn: /.test(why)) counts.tornKept += n;
    else if (/^omitted: /.test(why)) counts.omitted += n;
    else counts.excludedByDesign += n;
  }
  const requirements = Array.isArray(r.requirements) ? r.requirements : [];
  return {
    allRequiredPresent: requirements.length > 0 && requirements.every(x => x && x.status === 'present'),
    verbatim: !!tornChecked && INTEGRITY_GAPS.every(k => counts[k] === 0),
    tornChecked: !!tornChecked,
    counts
  };
}
// the integrity of any bundle: its own when it carries one, else what its rows prove
function bundleIntegrity(bundle) {
  const report = bundle && bundle.report;
  return report && report.integrity ? report.integrity : integrityOf(report, false);
}
// the rows a person must read: every report.skipped row that is not excluded by design
function integrityGaps(report) {
  return (report && Array.isArray(report.skipped) ? report.skipped : []).filter(row => GAP_REASON.test(String(row && row.reason)));
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
  const browserStore = isObj(o.browserStore) ? o.browserStore : {};
  const budgeted = (Number.isFinite(o.maxBytes) && o.maxBytes >= 0) || (Number.isFinite(o.maxChars) && o.maxChars > 0);
  let budget = null, maxChars = null;
  if (budgeted) {
    // the browser-owned state rides in the same JSON string, so it is taken out of the file budget first
    budget = Number.isFinite(o.maxBytes) && o.maxBytes >= 0 ? o.maxBytes : Infinity;
    for (const key of Object.keys(browserStore)) budget -= Buffer.byteLength(String(browserStore[key]), 'utf8');
    budget = Math.max(0, budget);
    maxChars = Number.isFinite(o.maxChars) && o.maxChars > 0 ? Math.min(o.maxChars, BUNDLE_MAX_CHARS) : BUNDLE_MAX_CHARS;
  }

  // browser-owned state (pure: no disk), first so a budget can charge it; its report rows join after the files' as before
  const browser = [], browserSkipped = [], browserReauth = [];
  for (const key of Object.keys(browserStore).sort()) {
    if (!/^(?:starnet|skynet)\./i.test(key)) { browserSkipped.push({ path: 'browser:' + key, reason: 'foreign browser key' }); continue; }
    if (browserKeyIsSecret(key)) {
      browserSkipped.push({ path: 'browser:' + key, reason: 'browser credential material is intentionally excluded' });
      browserReauth.push({ kind: 'browser-credential', id: key, reason: 'Credential value is intentionally excluded.' });
      continue;
    }
    const value = String(browserStore[key]);
    const data = Buffer.from(value, 'utf8');
    browser.push({ key, bytes: data.length, sha256: sha256(data), value, categories: browserCategories(key) });
  }

  const head = {
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
    }
  };

  const walkSkipped = [];
  let walked = walkFiles(root, fs, path, walkSkipped).map(item => Object.assign(item, { policy: classifyPolicy(item.rel, item.st) }));
  let over = null, chars = 0, walkRows = null;
  if (!budgeted) skipped.push(...walkSkipped);
  else {
    // what the bundle costs before any file rides: its skeleton, the browser state, and the rows the walk produced
    // (unreadable entries + policy skips, bounded by compactSkipped) — all known now and charged exactly
    walkRows = compactSkipped(walkSkipped.concat(walked.filter(it => it.policy.action === 'skip').map(it => ({ path: it.rel, reason: it.policy.reason }))));
    chars = rowChars(Object.assign({}, head, {
      files: [], browser: [],
      report: { complete: false, requirements: REQUIRED_CATEGORIES.map(category => ({ category, status: 'missing' })), skipped: [], reauthentication: [],
        integrity: { allRequiredPresent: false, verbatim: false, tornChecked: false, counts: { unreadable: BIG, tooLarge: BIG, symlinks: BIG, promotedFromBak: BIG, unusableBak: BIG, tornKept: BIG, omitted: BIG, excludedByDesign: BIG } } },
      manifestSha256: HEX64
    }), 0) + 64;   // + an empty array opening up (5 of them) and the trailing newline
    for (const r of walkRows) chars += rowChars(r, 3);
    for (const b of browser) chars += rowChars(b, 2);
    for (const r of browserSkipped.concat(browserReauth)) chars += rowChars(r, 3);
    for (const it of walked) if (it.policy.reauth) chars += rowChars(it.policy.reauth, 3);
    const candidates = walked.filter(it => it.policy.action !== 'skip');
    for (const it of candidates) it.categories = categoriesFor(it.rel);
    const plan = budgetPlan(candidates, budget, maxChars, chars);
    // only the list of what is left out can get here (~a million folders, or a tiny maxChars): say so instead of V8's 'Invalid string length'
    if (plan.base > maxChars) throw new Error('the station has too many files to list within a pre-update recovery point');
    over = plan.over;
    chars = plan.base;   // from here: the text of what has actually been admitted, in priority order
    // read in priority order, so the guard below (a .bak promotion can differ in size) only ever drops the LOWER rows
    walked = walked.filter(it => it.policy.action === 'skip').concat(plan.order);
  }
  const tooLarge = [];
  // an explicit recovery bundle names its own limit; never longer than the reason budgetPlan reserved room for
  const budgetReason = typeof o.budgetReason === 'string' && o.budgetReason.length <= BUDGET_SKIP_REASON.length ? o.budgetReason : BUDGET_SKIP_REASON;
  let used = 0;
  for (const item of walked) {
    const policy = item.policy;
    if (policy.action === 'skip') {
      if (!budgeted) skipped.push({ path: item.rel, reason: policy.reason });   // budgeted: already in walkRows
      if (policy.reauth) reauthentication.push(policy.reauth);
      continue;
    }
    if (over && over.has(item.rel)) { tooLarge.push({ path: item.rel, reason: budgetReason, bytes: Number(item.st && item.st.size) || 0 }); continue; }
    // a HIGHER row that grew when read (a .bak promotion, a re-printed sanitized store) can take this one's room: it is
    // then left out unread. Passing here also covers its 'unreadable' row below, which is always shorter than its charge.
    if (budgeted && (used + ((item.st && Number(item.st.size)) || 0) > budget || chars + item.charge > maxChars)) {
      tooLarge.push({ path: item.rel, reason: budgetReason, bytes: Number(item.st && item.st.size) || 0 });
      continue;
    }
    // this file's own report rows. Only 'unreadable' is true whether or not the file rides: a "promoted" row for a
    // file the budget then leaves out would claim a capture that never happened.
    const notes = [];
    let data;
    try { data = fs.readFileSync(item.abs); }
    catch (e) {
      if (!unreadableCode(e)) throw e;
      notes.push({ row: { path: item.rel, reason: 'unreadable: ' + e.code }, stays: true });
      // a locked/denied store falls back to its last-known-good .bak exactly like a torn one (below) — dropping it
      // dropped the .bak too, and another file of its category kept the bundle reading complete
      data = policy.action === 'include' && /\.json$/i.test(item.rel) ? lastKnownGood(fs, item.abs) : null;
      if (data) notes.push({ row: { path: item.rel + '.bak', reason: 'promoted: unreadable main captured from its last-known-good .bak' } });
    }
    /* LAST-KNOWN-GOOD SUBSTITUTION: savestore keeps <file>.bak precisely so a torn main can be recovered,
       and this bundle intentionally excludes .bak generations — so a bundle captured after a hard kill
       shipped the torn/zero-byte main and DROPPED the only good copy: completeness still read 'present',
       the bundle stamped complete, and restore produced a station whose save quarantines on first load
       with no .bak to fall back to. When an included .json main does not parse and its sibling .bak does,
       the bundle carries the .bak bytes as the file (recorded in skipped as a promotion). */
    if (data && policy.action === 'include' && /\.json$/i.test(item.rel)) {
      let mainOk = data.length > 0;
      if (mainOk) { try { JSON.parse(data.toString('utf8')); } catch (_) { mainOk = false; } }
      if (!mainOk) {
        try {
          const bak = fs.readFileSync(item.abs + '.bak');
          JSON.parse(bak.toString('utf8'));
          data = bak;
          notes.push({ row: { path: item.rel + '.bak', reason: 'promoted: torn main captured from its last-known-good .bak' } });
        } catch (bakErr) {
          // No usable .bak — the torn main rides as-is (forensic truth). A MISSING sibling is the normal
          // case; an existing-but-unusable one earns a receipt on the report so the gap is visible.
          if (bakErr && bakErr.code !== 'ENOENT') notes.push({ row: { path: item.rel + '.bak', reason: 'unusable .bak: ' + ((bakErr && bakErr.message) || bakErr) } });
          // a station store that will quarantine on first load earns a row of its own (#119). An agent's own file is not
          // a store: a tsconfig.json with comments is not torn, it was never strict JSON.
          if (budgetTier(item.rel) < 2) notes.push({ row: { path: item.rel, reason: 'torn: does not parse and has no usable .bak; captured as it was' } });
        }
      }
    }
    if (!data) {   // unreadable with no last-known-good: only its receipt rides
      for (const n of notes) skipped.push(n.row);
      if (budgeted) chars += notes.reduce((s, n) => s + rowChars(n.row, 3), 0);
      continue;
    }
    let redactedFields = [];
    let reauth = [];
    if (policy.action === 'sanitize') {
      let clean;
      try { clean = sanitizeManagedJson(item.rel, data, o); }
      catch (e) {
        /* #119: a caller that would rather have the rest of the station than nothing (the offline CLI, which has no key;
           the in-app backup, when the store is locked) gets this store left out and said so. Its bytes never ride: the
           exclusion is the same one a throw protected. A pre-update capture does not ask for this and still fails closed. */
        if (!o.omitUnavailableCredentialStores) throw e;
        const row = { path: item.rel, reason: 'omitted: ' + String((e && e.message) || e).slice(0, 240), category: 'connector_references', howToGet: CREDENTIAL_STORE_HOW_TO_GET };
        const reauthRow = { kind: 'credential-store-omitted', id: item.rel, reason: 'This store is not in the bundle, so its connections are not listed after a restore: add them again.' };
        if (budgeted && chars + rowChars(row, 3) + rowChars(reauthRow, 3) > maxChars) {
          tooLarge.push({ path: item.rel, reason: budgetReason, bytes: data.length });
          continue;
        }
        if (budgeted) chars += rowChars(row, 3) + rowChars(reauthRow, 3);
        skipped.push(row);
        reauthentication.push(reauthRow);
        continue;
      }
      data = clean.data;
      redactedFields = clean.redacted;
      reauth = clean.reauthentication;
    }
    if (budgeted) {
      // the exact text this file adds now that its bytes are known (a .bak promotion or a sanitized store can differ
      // from the walk's size); past either limit it is left out like any other, with only its 'unreadable' row kept
      const cost = fileRowChars(item.rel, data.length, item.categories, redactedFields)
        + notes.reduce((s, n) => s + rowChars(n.row, 3), 0) + reauth.reduce((s, r) => s + rowChars(r, 3), 0);
      if (used + data.length > budget || chars + cost > maxChars) {
        const kept = notes.filter(n => n.stays).map(n => n.row);
        skipped.push(...kept);
        chars += kept.reduce((s, r) => s + rowChars(r, 3), 0);
        tooLarge.push({ path: item.rel, reason: budgetReason, bytes: data.length });
        continue;
      }
      chars += cost;
    }
    for (const n of notes) skipped.push(n.row);
    reauthentication.push(...reauth);
    used += data.length;
    files.push({ path: item.rel, bytes: data.length, sha256: sha256(data), encoding: 'base64', data: data.toString('base64'), categories: item.categories || categoriesFor(item.rel), redactedFields });
  }
  if (budgeted) skipped.push(...walkRows, ...compactSkipped(tooLarge));
  skipped.push(...browserSkipped);
  reauthentication.push(...browserReauth);

  stableSort(files, x => x.path); stableSort(skipped, x => x.path); stableSort(browser, x => x.key);
  const requirements = completeness(files, browser);
  // a store left out of a category is not evidence of that category, even when another file of it rode
  const omittedCategories = new Set(skipped.filter(x => /^omitted: /.test(String(x.reason))).map(x => x.category));
  for (const row of requirements) if (omittedCategories.has(row.category)) row.status = 'omitted';
  const complete = requirements.every(x => x.status === 'present');
  const uniqueReauth = [];
  const seenReauth = new Set();
  for (const row of reauthentication) {
    const k = [row.kind, row.id, row.reason].join('|');
    if (!seenReauth.has(k)) { seenReauth.add(k); uniqueReauth.push(row); }
  }
  const report = { complete, requirements, skipped, reauthentication: uniqueReauth };
  report.integrity = integrityOf(report, true);
  const bundle = Object.assign({}, head, { files, browser, report });
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
  if (bundle && bundle.report && bundle.report.integrity && bundle.report.integrity.verbatim && integrityGaps(bundle.report).length) errors.push('bundle claims nothing was left out or repaired but its report lists gaps');
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
  // the person's explicit choice: a bundle with a gap may be all they have (never the default)
  if ((!o.bundle.report || !o.bundle.report.complete) && !o.allowIncomplete) throw new Error('refusing incomplete recovery bundle');
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
      requirements: clone((o.bundle.report && o.bundle.report.requirements) || check.requirements),
      integrity: clone(bundleIntegrity(o.bundle)),
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

/* A REHEARSAL NEVER TOUCHES A STATION (#119). The bundle is restored into a folder the caller made for this and nothing
   else, captured again the way a backup is, and compared by content; the folder is removed whatever happens. What it
   proves: this bundle restores, and what lands is what was captured. What it cannot prove: that a StarNet opens it. */
function rehearse(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  if (!o.scratchRoot) throw new Error('rehearse requires scratchRoot');
  if (!Number.isFinite(o.now)) throw new Error('rehearse requires an injected numeric now');
  const scratch = path.resolve(String(o.scratchRoot));
  const target = path.join(scratch, 'workspaces');
  const sink = {};
  try {
    const receipt = restore({ bundle: o.bundle, targetRoot: target, browserSink: sink, allowIncomplete: true, fs, path });
    const again = capture({ workspaceRoot: target, browserStore: sink, now: o.now, appVersion: o.bundle.appVersion, omitUnavailableCredentialStores: true, maxChars: BUNDLE_MAX_CHARS, fs, path });
    const before = JSON.stringify(semanticFingerprint(o.bundle));
    const after = JSON.stringify(semanticFingerprint(again));
    return { ok: before === after, filesRestored: receipt.restored.length, contentMatches: before === after, reauthentication: receipt.reauthentication, requirements: receipt.requirements, integrity: receipt.integrity };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = {
  SCHEMA, VERSION, REQUIRED_CATEGORIES, BUDGET_SKIP_REASON, EXPLICIT_BUDGET_REASON, BUNDLE_MAX_CHARS, SKIP_ROWS_LISTED,
  capture, validate, writeBundleAtomic, readBundle, restore, rehearse, semanticFingerprint, bundleIntegrity, integrityGaps,
  browserKeyIsSecret, categoriesFor,
  _internals: { sanitizeManagedJson, classifyPolicy, completeness, sha256, budgetTier, rowChars, compactSkipped }
};
