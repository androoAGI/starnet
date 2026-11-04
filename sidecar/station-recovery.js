/* sidecar/station-recovery.js — portable, verified whole-station recovery bundles.

   This is deliberately an offline/quiescent primitive. The caller must stop the sidecar (or otherwise
   establish a mutation barrier: update-preparation.js) before capture/restore. A successful bundle is one recovery point with
   zero completed mutations lost before that barrier; this module does not pretend that periodic/continuous
   RPO exists when the caller has not established one.

   The bundle holds the files under WORKSPACES plus browser-owned `starnet.*` state supplied by the caller, as readable
   text. It is not encrypted and not signed. The credentials this module can recognize, and approvals made on this
   station, are left out and listed under `reauthentication`. Anything pasted into a conversation or a file still rides.

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
const { isCredentialName } = require('./secret-values.js');
const { LIFECYCLE_FILES } = require('./station-record.js');
const channelSecrets = require('./channels/secrets.js');

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
// .browsers holds downloaded browser builds: hundreds of MB that a reinstall fetches again, never the person's work
const EPHEMERAL_TOP = new Set(['.browser-profile', '.browsers', '.starnet-workspace-owner.json.generations']);
// The workspace's own lifecycle files (its station record and legacy reset marker, station-record.js) are ephemeral too:
// they say what happened to THIS workspace, so a bundle never carries them and a restore never writes one an older bundle
// still holds. The restored station's first boot records it from its own files.
const LIFECYCLE = new Set(LIFECYCLE_FILES);
const EPHEMERAL_FILES = new Set(['cron.lock', 'proc-ledger.json', '.starnet-workspace-owner.json', '.migration-pending'].concat(LIFECYCLE_FILES));
const SYSTEM_SECRET_TOP = new Set(['.secrets', 'codex', 'grok', 'kimi']);

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function slash(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function systemSecretPath(p) { return SYSTEM_SECRET_TOP.has(slash(p).split('/')[0].toLowerCase()); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function stableSort(arr, key) { return arr.sort((a, b) => String(key(a)).localeCompare(String(key(b)))); }
function safeId(v, fallback) { return String(v == null ? fallback || '' : v).slice(0, 200); }

/* A NAME THAT CANNOT LAND SAFELY (#119 review). A bundle is a file someone could hand you, and Windows acts on some names:
   NUL and COM1 are devices, a trailing dot or space is silently stripped (so ".. " is ".."), agent.save.json:ads is an NTFS
   stream on the real file. The same rule refuses them in validate and leaves them out of a capture, so a Linux station
   holding "a:b" still backs up and says so. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
function unsafePathReason(rel) {
  const p = slash(rel);
  if (!p) return 'empty path';
  if (p.charAt(0) === '/') return 'absolute path';
  for (const seg of p.split('/')) {
    if (!seg || seg === '.' || seg === '..') return 'relative segment';
    if (/[\s.]$/.test(seg)) return 'name ends in a dot or space';
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) return 'character Windows cannot store';
    if (DEVICE_NAME.test(seg)) return 'Windows device name';
  }
  return null;
}
/* The names no restore may even consider, because the path itself leaves the station. A name that is merely unstorable here
   (What?.md from a Mac, aux.c, a stream) is not this: it is dropped by restorePlan and named, because that bundle may be
   the only copy. A trailing dot or space is stripped by Windows, so ".. " counts as "..". */
function escapesStation(rel) {
  const p = slash(rel);
  if (!p || p.charAt(0) === '/' || /^[a-z]:(?:\/|$)/i.test(p)) return true;
  return p.split('/').some(seg => !seg || seg === '.' || seg === '..' || /^\.{1,2}\s[\s.]*$/.test(seg));
}
// never in any bundle StarNet writes, and each would change how the restored station boots or who owns it
function plantedPath(rel) {
  const p = slash(rel).toLowerCase();
  const top = p.split('/')[0];
  // .migration-pending is not here: a released capture did not skip it, so an honest old bundle can hold it. restorePlan drops it.
  // Nor are the lifecycle files, for the same reason (a released capture carried the reset marker): restorePlan drops them.
  return top === '.browser-profile' || top === '.starnet-workspace-owner.json.generations' || (EPHEMERAL_FILES.has(p) && p !== '.migration-pending' && !LIFECYCLE.has(p)) || /(?:^|\/)\.owner\.lock$/.test(p);
}

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
  if (/transcript|history\.json$|chatmap\.json$|outbox\.json$|^channels\/delivery\.json$|runs\.jsonl$|\.run-journal\//.test(p)) out.add('conversations');
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

/* WHAT A CREDENTIAL LOOKS LIKE IN A CONNECTOR RECORD (#119 review). A field or header or env name is judged by
   isCredentialName, the same test the prompt scrubber uses (DB_PW, MYSQL_PWD, HUBSPOT_PAT, SENTRY_DSN, X-Admin-Pin,
   X-Api-Sig, botToken, privateKey, signingSecret), and the old substring test stays as a wider net. Under headers, env and
   args a value is judged too, because DATABASE_URL=postgres://u:p@h has a public-looking name. Every rewrite here is
   stable: sanitizing a sanitized record gives the same bytes, which is what lets a restore do it again. */
const REDACTED = '<redacted>';
function tokenShaped(text) {
  for (const m of String(text).match(/[A-Za-z0-9]{20,}/g) || []) if (/[0-9]/.test(m) && /[A-Za-z]/.test(m)) return true;
  return false;
}
function credentialValue(v) { return typeof v === 'string' && (/:\/\/[^/\s:@]+:[^/\s@]+@/.test(v) || tokenShaped(v)); }
// a flag beside a credential is no credential: oauth bookkeeping like hasToken:true and tokenExpires:123 stays readable
function isSecretField(k, v) { return SECRET_FIELD.test(k) || (isCredentialName(k) && v != null && typeof v !== 'boolean' && typeof v !== 'number'); }
function scrubUrl(v, label, redacted) {
  let u;
  try { u = new URL(v); } catch (_) { return null; }
  const before = u.toString();
  u.username = ''; u.password = ''; u.search = ''; u.hash = '';
  u.pathname = u.pathname.split('/').map(seg => tokenShaped(seg) ? 'redacted' : seg).join('/');
  const after = u.toString();
  if (after === before) return v;   // nothing to take out: the text stays as the person wrote it
  redacted.push(label);
  return after;
}
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i;
function scrubArgs(args, parts, redacted) {
  let nextIsSecret = false;
  return args.map((a, i) => {
    const label = parts.concat('args', String(i)).join('.');
    if (typeof a !== 'string') { nextIsSecret = false; return a; }
    if (nextIsSecret) {
      nextIsSecret = false;
      // the next flag is not the value: --token --port 3000 has no value here to hide
      if (!/^(?:--[A-Za-z]|-[A-Za-z]$)/.test(a)) { redacted.push(label); return REDACTED; }
    }
    const flag = /^(-{1,2}[A-Za-z0-9_.-]+)(=.*)?$/.exec(a);
    // --no-auth and --without-token switch something off and carry nothing
    if (flag && !/^--(?:no|without|disable)-/i.test(flag[1]) && isCredentialName(flag[1].replace(/^-+/, ''))) {
      if (flag[2] === undefined) { nextIsSecret = true; return a; }
      redacted.push(label);
      return flag[1] + '=' + REDACTED;
    }
    if (URL_VALUE.test(a)) { const clean = scrubUrl(a, label, redacted); if (clean != null) return clean; }
    if (credentialValue(a)) { redacted.push(label); return REDACTED; }
    return a;
  });
}
function sanitizeObject(value, pathParts, redacted) {
  if (Array.isArray(value)) return value.map((v, i) => sanitizeObject(v, pathParts.concat(String(i)), redacted));
  if (!isObj(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretField(k, v)) { redacted.push(pathParts.concat(k).join('.')); continue; }
    if (/^(?:headers|env)$/i.test(k) && isObj(v)) {
      const child = {};
      for (const [ck, cv] of Object.entries(v)) {
        if (/(?:token|secret|key|password|auth|bearer|cookie|session)/i.test(ck) || isCredentialName(ck) || credentialValue(cv)) redacted.push(pathParts.concat(k, ck).join('.'));
        else child[ck] = sanitizeObject(cv, pathParts.concat(k, ck), redacted);
      }
      out[k] = child;
      continue;
    }
    if (/^args$/i.test(k) && Array.isArray(v)) { out[k] = scrubArgs(v, pathParts, redacted); continue; }
    if (typeof v === 'string' && URL_VALUE.test(v)) {
      const clean = scrubUrl(v, pathParts.concat(k, 'auth').join('.'), redacted);
      out[k] = clean == null ? v : clean;
      continue;
    }
    out[k] = sanitizeObject(v, pathParts.concat(k), redacted);
  }
  return out;
}
// a remote URL's user:token@ and the http.extraheader line actions/checkout leaves behind
function scrubGitConfig(data) {
  const text = data.toString('utf8');
  const clean = text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1').replace(/^[ \t]*extraheader[ \t]*=.*(?:\r?\n|$)/gim, '');
  return clean === text ? data : Buffer.from(clean, 'utf8');
}

/* ROUTINES COME BACK SWITCHED OFF (#119 review). Not absent: with no file, the first routine anyone saves arms the scheduler
   (armOnSaveIfUnset, index.js), which would start every restored routine with it. armed:false is the explicit OFF that a
   save never overrides, and the switch offers itself in SCHEDULES. */
const DISARMED = () => Buffer.from(JSON.stringify({ version: 1, armed: false }, null, 2) + '\n');
function sanitizeManagedJson(rel, raw, options = {}) {
  const p = slash(rel).toLowerCase();
  if (!/^connectors\/(?:state|connectors|oauth|servicekeys)\.json$/.test(p) && p !== 'channels/secrets.json' && p !== 'permissions.allow.json' && p !== 'hooks.json' && p !== 'cron.armed.json') return null;
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); }
  catch (e) {
    // hooks.json is no credential store, so a torn one must not stop every update the way a torn vault does. Its bytes
    // still do not ride, because they may hold what a hook was handed in env.
    if (p === 'hooks.json') return { torn: true, data: Buffer.from('{}\n'), redacted: ['hooks.json'], reauthentication: [{ kind: 'hook', id: 'hooks.json', reason: 'hooks.json could not be read, so it is left out. Add your hooks again.', fields: [] }] };
    if (p === 'cron.armed.json') return { data: DISARMED(), redacted: [], reauthentication: [] };   // a torn flag already reads as off
    throw new Error('credential-bearing state is not valid JSON: ' + rel);
  }
  const redacted = [];
  let value;
  const reauthentication = [];
  if (p === 'permissions.allow.json') {
    const allow = Array.isArray(doc.allow) ? doc.allow.filter(x => typeof x === 'string') : [];
    const machinePaths = allow.filter(x => x.indexOf('path:') === 0);
    // an "always" was a click on this station, and a restored file saying so was never that click: none of them travel
    value = Object.assign({}, doc, { allow: [], meta: {} });
    for (const key of allow) if (key.indexOf('path:') !== 0) reauthentication.push({ kind: 'approval', id: key, reason: 'This "always allow" is off after a restore. StarNet asks again the next time an agent needs it.', fields: ['permissions.allow'] });
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
      if (isObj(clean) && clean.enabled !== false) {
        clean.enabled = false;
        offAfterRestore(reauthentication, 'connector', safeId(cfg && cfg.id, 'connector-' + i), CONNECTOR_OFF);
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
  } else if (p === 'cron.armed.json') {
    if (doc && doc.armed === true) reauthentication.push({ kind: 'approval', id: 'cron.armed.json', reason: 'Routines are off after a restore. Turn them on again in SCHEDULES when you have read them.', fields: ['armed'] });
    return { data: DISARMED(), redacted, reauthentication };
  } else if (p === 'hooks.json') {
    // its commands stay (each is inert until approved again); what a hook was handed in env does not
    value = sanitizeObject(doc, [], redacted);
    if (redacted.length) reauthentication.push({ kind: 'hook', id: 'hooks.json', reason: 'Hook credential values are intentionally excluded.', fields: redacted.slice() });
  } else if (p === 'channels/secrets.json') {
    value = sanitizeObject(doc, [], redacted);
    // A bot's own-key reference is identity, not the excluded secret. Keep only the schema-owned
    // projection on actual channel records so restore cannot silently turn it into a station follower.
    // A recognizable secret or URL masquerading as a bind still fails the existing export security rules.
    const references = {};
    for (const row of channelSecrets.credentialRows(doc)) {
      const reference = channelSecrets.credentialReference(row.credential);
      if (reference && !(reference.ref === 'channel' && (tokenShaped(reference.bind) || URL_VALUE.test(reference.bind)))) references[row.id] = reference;
    }
    value = channelSecrets.withCredentials(value, references);
    for (const id of ['telegram', 'discord', 'slack', 'matrix']) {
      if (doc[id] && (doc[id].token || doc[id].key)) reauthentication.push({ kind: 'channel', id, reason: 'Channel/provider token is intentionally excluded.', fields: ['token', 'key'].filter(k => doc[id][k]) });
    }
    // the token staying out does not keep a bot quiet: desktop tokens live in the OS credential store, which a restore on
    // the same machine still has, and Signal needs no token at all
    for (const id of Object.keys(value)) {
      if (isObj(value[id]) && value[id].enabled) {
        value[id].enabled = false;
        offAfterRestore(reauthentication, 'channel', id, CHANNEL_OFF);
      }
    }
    // a saved bot here starts unless it says enabled:false (index.js boot block), so absent counts as on
    for (const id of Object.keys(isObj(value.telegramBots) ? value.telegramBots : {})) {
      const bot = value.telegramBots[id];
      if (isObj(bot) && bot.enabled !== false) {
        bot.enabled = false;
        offAfterRestore(reauthentication, 'channel', 'telegram:' + id, CHANNEL_OFF);
      }
    }
  } else {
    value = sanitizeObject(doc, [], redacted);
    const rows = Array.isArray(doc.connectors) ? doc.connectors : [];
    for (const row of rows) if (row) reauthentication.push({ kind: 'connector', id: safeId(row.id || row.name, 'connector'), reason: 'Connector secret fields are intentionally excluded.', fields: redacted.slice() });
    for (const row of Array.isArray(value.connectors) ? value.connectors : []) {
      if (isObj(row) && row.enabled !== false) {
        row.enabled = false;
        offAfterRestore(reauthentication, 'connector', safeId(row.id || row.name, 'connector'), CONNECTOR_OFF);
      }
    }
  }
  return { data: Buffer.from(JSON.stringify(value, null, 2) + '\n'), redacted, reauthentication };
}

const CONNECTOR_OFF = 'This connector is off after a restore. Turn it on again in ABILITIES when you have read it.';
const CHANNEL_OFF = 'This bot is off after a restore. Turn it on again in CHANNELS if you want it answering.';
// one row a person reads per thing: a connector that lost its token and was switched off is one thing to do, not two
function offAfterRestore(rows, kind, id, sentence) {
  const row = rows.find(x => x.kind === kind && x.id === id);
  if (row) row.reason += ' ' + sentence;
  else rows.push({ kind, id, reason: sentence, fields: ['enabled'] });
}

/* WHAT A RESTORE SWITCHES OFF (#119 review, same rule as cron.armed.json). These stores act at boot with no click: a
   live loop re-arms (index.js, "LOOPS: no env gate"), an enabled folder trigger polls and fires its work line, a webhook
   trigger accepts calls, a routine's undelivered result is sent, and an overseer report, queued or owed to a worker that
   finished or was still running, is a full lead run with tools. So each one comes back switched off, still listed, with a
   row saying so, and no station-wide halt is left behind. docs/DISASTER_RECOVERY.md says what this does not stop.
   They stay plain 'include' stores so a torn one keeps its .bak promotion and its torn row: a store that does not parse
   is passed through unchanged, because it loads as empty and starts nothing. Returning the same bytes when nothing
   needs changing, and writing no row, is what keeps a second pass identical. */
const QUIET_STORE = /^(?:loops|triggers|overseer|subagents|cron\.jobs)\.json$/i;
const LOOP_ASLEEP = new Set(['stopped', 'done']);
function quietStore(rel, raw) {
  const untouched = { data: raw, reauthentication: [] };
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); } catch (_) { return untouched; }
  if (!isObj(doc)) return untouched;
  const rows = [];
  const name = (row, fallback) => String((row && row.name) || fallback).slice(0, 120);
  const p = slash(rel).toLowerCase();
  if (p === 'loops.json') {
    if (!Array.isArray(doc.loops)) return untouched;
    doc.loops = doc.loops.map((l, i) => {
      if (!isObj(l) || l.enabled === false || LOOP_ASLEEP.has(l.state)) return l;
      const id = safeId(l.id, 'loop-' + i);
      rows.push({ kind: 'loop', id, reason: 'Loop "' + name(l, id) + '" is off after a restore. Resume it in GOAL LOOPS when you have read it.', fields: ['enabled'] });
      return Object.assign({}, l, { enabled: false, state: 'paused', stopReason: 'Paused by a restore. Resume it when you have read it.' });
    });
  } else if (p === 'triggers.json') {
    if (!Array.isArray(doc.triggers)) return untouched;
    doc.triggers = doc.triggers.map((t, i) => {
      if (!isObj(t) || t.enabled === false) return t;   // the store reads a missing flag as on
      const id = safeId(t.id, 'trigger-' + i);
      rows.push({ kind: 'trigger', id, reason: 'Line trigger "' + name(t, id) + '" is off after a restore. Switching it on again only fires on what arrives after that.', fields: ['enabled'] });
      return Object.assign({}, t, { enabled: false });
    });
  } else if (p === 'cron.jobs.json') {
    if (!Array.isArray(doc.jobs)) return untouched;
    // cron.armed.json stops new fires. A result still waiting to be sent goes out at boot unless its routine is paused,
    // the state cron-store.deliveriesHeld already keeps such a result in until a person resumes it.
    const waiting = j => (Array.isArray(j.deliveryBacklog) ? j.deliveryBacklog : []).concat(j.finalization ? [j.finalization] : []).some(f => f && f.state === 'pending');
    doc.jobs = doc.jobs.map((j, i) => {
      if (!isObj(j) || !waiting(j) || (j.enabled === false && j.state === 'paused')) return j;
      const id = safeId(j.id, 'routine-' + i);
      rows.push({ kind: 'routine', id, reason: 'Routine "' + name(j, id) + '" has a result that was not sent. It is paused so nothing goes out after a restore. Resume it in SCHEDULES to send it.', fields: ['enabled'] });
      return Object.assign({}, j, { enabled: false, state: 'paused', disabledReason: 'paused', disabledAt: null });
    });
  } else if (p === 'subagents.json') {
    if (!Array.isArray(doc.records)) return untouched;
    // overseer.collect would queue a report for each of these on its first tick, and a running one counts because boot marks
    // it stale. Only the stamp is added: the worker's own record and its result stay as they were.
    let stamped = 0;
    doc.records = doc.records.map(w => {
      if (!isObj(w) || w.leadId !== 'agent' || w.noReportRun === String(w.runId)) return w;
      stamped++;
      return Object.assign({}, w, { noReportRun: String(w.runId) });
    });
    if (stamped) rows.push({ kind: 'overseer-report', id: 'subagents.json', reason: 'Work your agents handed off before this backup does not report back by itself after a restore. Read each worker\'s result in its conversation.' });
  } else {
    const held = isObj(doc.value) ? doc.value : doc;   // the domain store's envelope is { version, value }
    if (!Array.isArray(held.reviews)) return untouched;
    held.reviews = held.reviews.map(r => {
      if (!isObj(r) || r.status !== 'pending') return r;
      rows.push({ kind: 'overseer-report', id: safeId(r.id, 'report'), reason: 'A report that was waiting to run is not run after a restore. Read the worker\'s result in its conversation.' });
      return Object.assign({}, r, { status: 'interrupted', error: 'Not run after a restore. Read the worker\'s result in its conversation.' });
    });
  }
  return rows.length ? { data: Buffer.from(JSON.stringify(doc, null, 2) + '\n'), reauthentication: rows } : untouched;
}

/* AUTHORITY DOES NOT TRAVEL (#119 review). FULL BYPASS is a click in this station's settings ("the click IS the consent",
   index.js), and the approval files say this person read this code on this machine. A restored file saying so was never
   that click. hooks.json and plugins/ stay, because each is inert until approved again; only the approvals are left out. */
const AUTHORITY_FILES = new Map([
  ['permissions.bypass.json', 'FULL BYPASS is off after a restore. Turn it on again in SETTINGS if you want it.'],
  ['hooks-allowed.json', 'Hooks stay off after a restore until you approve each one again.'],
  ['plugins-allowed.json', 'Plugins stay off after a restore until you approve each one again.'],
  ['skills-allowed.json', 'Skills that needed approval ask again after a restore.'],
  // with no file the dial reads Autonomy.fresh() and the dossier verdict reads not ready: both are the safe default
  ['_commander.autonomy.json', 'How much your agents may do on their own is back at its default after a restore. Set it again if you want more.']
]);
// credential files by their well-known names, wherever they sit: an agent's .env is not a deliverable
const CREDENTIAL_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pfx|p12|ppk))$/i;
const CREDENTIAL_ROW = 'credential file left out by its name';
const credentialReauth = id => ({ kind: 'credential-file', id, reason: 'This file is not in the bundle, so it cannot come back from it. Keep your own copy if you need it.' });
/* .key is also a Keynote deck and .pem also a public cacert.pem, and a backup that loses them by name loses work. These two
   are judged by their bytes: a PEM private key block, and for .key a DER key or one bare token. */
const JUDGED_BY_BYTES = /\.(?:pem|key)$/i;
function holdsPrivateKey(data, rel) {
  const text = data.toString('latin1');
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text)) return true;
  if (!/\.key$/i.test(rel)) return false;
  return (data[0] === 0x30 && data[1] === 0x82) || (data.length <= 4096 && /^[A-Za-z0-9+/=_.:-]{16,}\s*$/.test(text));
}
/* A LINK IS NOT A LOST FILE (#119 review). pnpm and venv stations are full of links into their own folders, and a gate that
   stops on each of those only teaches people to pass the flag. Named in the report either way; it needs the flag only when
   it points out of the station at something with data in it. A runtime binary a venv points at is not that person's data. */
const LEGACY_LINK_ROW = 'symbolic links are not portable or safe to follow';
const LINK_INFO_ROW = 'link not followed: it points inside the station or at nothing';
const LINK_DATA_ROW = 'symbolic links that point outside the station and hold data are not followed';
const RUNTIME_BINARY = /^(?:python|pypy|node|ruby|perl)[0-9.]*(?:\.exe)?$/i;
function linkRow(fs, path, root, abs) {
  try {
    const real = fs.realpathSync(abs);
    const rel = path.relative(fs.realpathSync(root), real);
    if (rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))) return LINK_INFO_ROW;
    const st = fs.statSync(real);
    if (st.isDirectory()) return fs.readdirSync(real).length ? LINK_DATA_ROW : LINK_INFO_ROW;
    return st.size > 0 && !RUNTIME_BINARY.test(path.basename(real)) ? LINK_DATA_ROW : LINK_INFO_ROW;
  } catch (_) { return LINK_INFO_ROW; }
}
const GIT_CONFIG = /(?:^|\/)\.git\/config$|^\.checkpoints\/.*\/config$/i;
const siblingNames = require('./persist/names.js');   // the sibling-file names grammar (temps, backups, forensic copies)
function classifyPolicy(rel, st) {
  const p = slash(rel);
  const parts = p.split('/');
  const top = parts[0].toLowerCase();
  const unsafe = unsafePathReason(p);
  if (unsafe) return { action: 'skip', reason: 'unportable name: ' + unsafe };
  if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return { action: 'skip', reason: LEGACY_LINK_ROW };
  if (EPHEMERAL_TOP.has(top)) return { action: 'skip', reason: 'ephemeral browser/runtime profile; sign-in must be re-established' };
  if (SYSTEM_SECRET_TOP.has(top)) return { action: 'skip', reason: 'system-managed credential material is intentionally excluded', reauth: { kind: top === '.secrets' ? 'credential-store' : 'provider', id: top, reason: 'Reauthentication required on the restored profile.' } };
  if (AUTHORITY_FILES.has(p.toLowerCase())) return { action: 'skip', reason: 'an approval made on this station does not travel', reauth: { kind: 'approval', id: p.toLowerCase(), reason: AUTHORITY_FILES.get(p.toLowerCase()) } };
  if (CREDENTIAL_FILE.test(p)) return { action: 'skip', reason: CREDENTIAL_ROW, reauth: credentialReauth(p) };
  // these names are StarNet's own bookkeeping only among its own stores: agent/thesis.bak and draft.tmp.md are someone's work
  const store = budgetTier(p) < 2;
  if (EPHEMERAL_FILES.has(p.toLowerCase()) || /(?:^|\/)\.owner\.lock$/.test(p.toLowerCase()) || (store && siblingNames.isTemp(p))) return { action: 'skip', reason: 'ephemeral lock/process/temp state' };
  // persist's names grammar (sidecar/persist/names.js) knows every forensic generation, new and legacy: .corrupt-<n>,
  // .unseen-<n>, the bare .corrupt and index.js's old .corrupt-<pid>-<seq> (a quarantined channels/secrets.json was once
  // copied RAW into every pre-update backup). A run journal's damage evidence is not one: it rides with its journal.
  if (store && (siblingNames.isBackup(p) || siblingNames.isForensic(p))) return { action: 'skip', reason: 'superseded recovery/forensic generation; bundle versioning is authoritative' };
  // Any OTHER derivative of a credential store (a stray copy, a future suffix) can only be sanitized under its exact
  // name below; never include one raw.
  if (/^(?:channels\/secrets|connectors\/(?:state|connectors|oauth|servicekeys))\.json./i.test(p)) return { action: 'skip', reason: 'derivative copy of a credential store; only the live store is captured (sanitized)' };
  if (/^connectors\/(?:state|connectors|oauth|servicekeys)\.json$/i.test(p) || /^channels\/secrets\.json$/i.test(p) || /^permissions\.allow\.json$/i.test(p) || /^hooks\.json$/i.test(p) || /^cron\.armed\.json$/i.test(p)) return { action: 'sanitize' };
  if (GIT_CONFIG.test(p)) return { action: 'include', scrub: 'git' };
  if (QUIET_STORE.test(p)) return { action: 'include', quiet: true };
  if (JUDGED_BY_BYTES.test(p)) return { action: 'include', judge: true };
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
    // an empty directory can be load-bearing: a git repo after gc has no working .git/refs without its empty folders
    if (rel && !names.length) { out.push({ abs, rel: slash(rel), st, emptyDir: true }); return; }
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
/* Two sizes of "not exact". Every one of these clears verbatim and is named in the panel. Only the first list asks for
   --allow-incomplete: a station with an .env or a pnpm tree restores to what it should, and a flag it always needed would
   teach everyone to pass it. */
const BLOCKING_GAPS = ['unreadable', 'tooLarge', 'symlinks', 'promotedFromBak', 'unusableBak', 'tornKept', 'omitted', 'unportable'];
const INTEGRITY_GAPS = BLOCKING_GAPS.concat(['linksNotFollowed', 'credentialFiles']);
const GAP_REASON = /^(?:unreadable: |too large for |symbolic links |promoted: |unusable \.bak|torn: |omitted: |unportable name: |link not followed|credential file left out)/;
function integrityOf(report, tornChecked) {
  const r = report || {};
  const counts = { unreadable: 0, tooLarge: 0, symlinks: 0, promotedFromBak: 0, unusableBak: 0, tornKept: 0, omitted: 0, unportable: 0, linksNotFollowed: 0, credentialFiles: 0, excludedByDesign: 0 };
  for (const row of Array.isArray(r.skipped) ? r.skipped : []) {
    const why = String(row && row.reason), n = Number(row && row.files) || 1;
    if (/^unreadable: /.test(why)) counts.unreadable += n;
    else if (/^too large for /.test(why)) counts.tooLarge += n;
    else if (/^symbolic links /.test(why)) counts.symlinks += n;
    else if (/^promoted: /.test(why)) counts.promotedFromBak += n;
    else if (/^unusable \.bak/.test(why)) counts.unusableBak += n;
    else if (/^torn: /.test(why)) counts.tornKept += n;
    else if (/^omitted: /.test(why)) counts.omitted += n;
    else if (/^unportable name: /.test(why)) counts.unportable += n;
    else if (/^link not followed/.test(why)) counts.linksNotFollowed += n;
    else if (/^credential file left out/.test(why)) counts.credentialFiles += n;
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
// the integrity of any bundle, counted from its rows and its files, never read from the summary it carries
function bundleIntegrity(bundle) {
  const report = (bundle && bundle.report) || {};
  return integrityOf({ skipped: report.skipped, requirements: trustedRequirements(bundle) }, !!(report.integrity && report.integrity.tornChecked));
}
/* the rows a person must read, the ones that lost something first and then the largest left out: a panel that can only
   show a dozen must not spend them on the alphabet */
function integrityGaps(report) {
  const rows = (report && Array.isArray(report.skipped) ? report.skipped : []).filter(row => GAP_REASON.test(String(row && row.reason)));
  const sized = row => /^too large for /.test(String(row.reason));
  return rows.sort((a, b) => (sized(a) ? 1 : 0) - (sized(b) ? 1 : 0) || (Number(b.bytes) || 0) - (Number(a.bytes) || 0) || String(a.path).localeCompare(String(b.path)));
}
// what the bundle's FILES prove, not what its report says or what a browser key's name suggests
function trustedRequirements(bundle) {
  const files = bundle && Array.isArray(bundle.files) ? bundle.files : [];
  const rows = completeness(files.map(x => ({ categories: categoriesFor(x.path) })), []);
  const skipped = bundle && bundle.report && Array.isArray(bundle.report.skipped) ? bundle.report.skipped : [];
  const omitted = new Set(skipped.filter(x => /^omitted: /.test(String(x && x.reason))).map(x => x.category));
  for (const row of rows) if (omitted.has(row.category)) row.status = 'omitted';
  return rows;
}
/* WHAT A RESTORE MUST ASK BEFORE IT MOVES A STATION (#119 review). A category with nothing in it is not a problem: a station
   booted once and never given a routine has no routine file. What matters is what was lost and whether there is a station
   here at all, and both are judged from the bytes:
     noAgents  no readable <agent>.save.json: this bundle would replace a station with nothing. --allow-no-agents.
     gaps      something was left out, repaired or torn, or a save does not parse. --allow-incomplete. */
function restoreGate(bundle) {
  const files = bundle && Array.isArray(bundle.files) ? bundle.files : [];
  const saves = files.filter(x => /^[^/]+\.save\.json$/i.test(slash(x && x.path)));
  const tornSaves = [];
  let readable = 0;
  for (const row of saves) {
    let ok = false;
    try { const doc = JSON.parse(Buffer.from(String(row.data || ''), 'base64').toString('utf8')); ok = isObj(doc); } catch (_) { ok = false; }
    if (ok) readable++; else tornSaves.push(slash(row.path));
  }
  const counts = bundleIntegrity(bundle).counts;
  const gapCount = BLOCKING_GAPS.reduce((n, k) => n + (Number(counts[k]) || 0), 0);
  const noAgents = readable === 0;
  // a name a restore cannot write is a file lost now, whatever the bundle's own rows say
  const unportable = files.map(x => slash(x && x.path)).filter(p => unsafePathReason(p));
  const gaps = gapCount > 0 || tornSaves.length > 0 || unportable.length > 0;
  const flags = [];
  if (gaps) flags.push('--allow-incomplete');
  if (noAgents) flags.push('--allow-no-agents');
  return { noAgents, gaps, gapCount, tornSaves, unportable, readableSaves: readable, files: files.length, flags };
}

function completeness(files, browser) {
  const have = new Set();
  for (const f of files) for (const c of f.categories || []) have.add(c);
  for (const e of browser || []) for (const c of e.categories || []) have.add(c);
  return REQUIRED_CATEGORIES.map(category => ({ category, status: have.has(category) ? 'present' : 'missing' }));
}

/* An unkeyed hash: it catches a damaged file, and anyone able to edit the bundle can recompute it. It is not a signature,
   and nothing here may be worded as if it were. directories joins it only when there are some, so every bundle written
   before that field keeps the hash it was written with. */
function manifestOf(bundle) {
  const b = bundle || {};
  const files = Array.isArray(b.files) ? b.files : [], browser = Array.isArray(b.browser) ? b.browser : [];
  const doc = { files: files.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 })), browser: browser.map(x => ({ key: x.key, bytes: x.bytes, sha256: x.sha256 })), recoveryPoint: b.recoveryPoint };
  if (Array.isArray(b.directories) && b.directories.length) doc.directories = b.directories;
  return sha256(Buffer.from(JSON.stringify(doc), 'utf8'));
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
    // this capture already applied every rule restorePlan applies, so a plan must leave its rows exactly as they are
    planKeepsRows: true,
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
  let walked = walkFiles(root, fs, path, walkSkipped).map(item => {
    const policy = classifyPolicy(item.rel, item.st);
    if (policy.reason === LEGACY_LINK_ROW) policy.reason = linkRow(fs, path, root, item.abs);
    return Object.assign(item, { policy });
  });
  // an empty folder rides as its name; one that policy would skip left nothing out, so it earns no row
  const directories = walked.filter(it => it.emptyDir && it.policy.action !== 'skip').map(it => it.rel).sort();
  walked = walked.filter(it => !it.emptyDir);
  let over = null, chars = 0, walkRows = null;
  if (!budgeted) skipped.push(...walkSkipped);
  else {
    // what the bundle costs before any file rides: its skeleton, the browser state, and the rows the walk produced
    // (unreadable entries + policy skips, bounded by compactSkipped) — all known now and charged exactly
    walkRows = compactSkipped(walkSkipped.concat(walked.filter(it => it.policy.action === 'skip').map(it => ({ path: it.rel, reason: it.policy.reason }))));
    chars = rowChars(Object.assign({}, head, {
      files: [], browser: [], directories: [],
      report: { complete: false, requirements: REQUIRED_CATEGORIES.map(category => ({ category, status: 'missing' })), skipped: [], reauthentication: [],
        integrity: { allRequiredPresent: false, verbatim: false, tornChecked: false, counts: { unreadable: BIG, tooLarge: BIG, symlinks: BIG, promotedFromBak: BIG, unusableBak: BIG, tornKept: BIG, omitted: BIG, unportable: BIG, linksNotFollowed: BIG, credentialFiles: BIG, excludedByDesign: BIG } } },
      manifestSha256: HEX64
    }), 0) + 80;   // + an empty array opening up (6 of them) and the trailing newline
    for (const r of walkRows) chars += rowChars(r, 3);
    for (const b of browser) chars += rowChars(b, 2);
    for (const d of directories) chars += rowChars(d, 2);
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
      data = policy.action === 'include' && /\.json$/i.test(item.rel) && budgetTier(item.rel) < 2 ? lastKnownGood(fs, item.abs) : null;
      if (data) notes.push({ row: { path: item.rel + '.bak', reason: 'promoted: unreadable main captured from its last-known-good .bak' } });
    }
    /* LAST-KNOWN-GOOD SUBSTITUTION: savestore keeps <file>.bak precisely so a torn main can be recovered,
       and this bundle intentionally excludes .bak generations — so a bundle captured after a hard kill
       shipped the torn/zero-byte main and DROPPED the only good copy: completeness still read 'present',
       the bundle stamped complete, and restore produced a station whose save quarantines on first load
       with no .bak to fall back to. When an included .json main does not parse and its sibling .bak does,
       the bundle carries the .bak bytes as the file (recorded in skipped as a promotion). */
    if (data && policy.action === 'include' && /\.json$/i.test(item.rel) && budgetTier(item.rel) < 2) {
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
          // a station store that will quarantine on first load earns a row of its own (#119). An agent's own file never
          // reaches here: a tsconfig.json with comments is not torn, and its .bak is that agent's file too.
          notes.push({ row: { path: item.rel, reason: 'torn: does not parse and has no usable .bak; captured as it was' } });
        }
      }
    }
    if (!data) {   // unreadable with no last-known-good: only its receipt rides
      for (const n of notes) skipped.push(n.row);
      if (budgeted) chars += notes.reduce((s, n) => s + rowChars(n.row, 3), 0);
      continue;
    }
    if (policy.judge && holdsPrivateKey(data, item.rel)) {
      const row = { path: item.rel, reason: CREDENTIAL_ROW }, reauthRow = credentialReauth(item.rel);
      if (budgeted && chars + rowChars(row, 3) + rowChars(reauthRow, 3) > maxChars) {
        tooLarge.push({ path: item.rel, reason: budgetReason, bytes: data.length });
        continue;
      }
      if (budgeted) chars += rowChars(row, 3) + rowChars(reauthRow, 3);
      skipped.push(row);
      reauthentication.push(reauthRow);
      continue;
    }
    let redactedFields = [];
    let reauth = [];
    if (policy.scrub === 'git') {
      const clean = scrubGitConfig(data);
      if (clean !== data) {
        data = clean;
        notes.push({ row: { path: item.rel, reason: 'credential removed from a git config' } });
        reauth = [{ kind: 'git-remote', id: item.rel, reason: 'A sign-in saved in this repository\'s remote URL is left out. Sign in again to push.' }];
      }
    }
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
      if (clean.torn) notes.push({ row: { path: item.rel, reason: 'torn: does not parse, and it is left out because it may hold credentials' } });
    }
    if (policy.quiet) {
      const quiet = quietStore(item.rel, data);
      data = quiet.data;
      reauth = quiet.reauthentication;
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
  // browser keys are not evidence: a key named *.save says nothing about the files a restore would land
  const requirements = completeness(files, []);
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
  const bundle = Object.assign({}, head, { files, browser, directories, report });
  bundle.manifestSha256 = manifestOf(bundle);
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
    if (escapesStation(rel)) { errors.push('unsafe bundle path: ' + rel); continue; }
    if (systemSecretPath(rel)) errors.push('bundle contains forbidden system credential path: ' + rel);
    if (plantedPath(rel)) errors.push('bundle contains a path StarNet never writes: ' + rel);
    // exact only: a case-sensitive station can hold Foo and foo. restore() refuses them on a disk that cannot.
    if (seen.has(rel)) errors.push('duplicate bundle path: ' + rel);
    seen.add(rel);
    let data;
    try { data = Buffer.from(String(row.data || ''), 'base64'); } catch (_) { data = Buffer.alloc(0); }
    if (data.length !== Number(row.bytes) || sha256(data) !== row.sha256) errors.push('payload checksum mismatch: ' + rel);
  }
  for (const dir of bundle && Array.isArray(bundle.directories) ? bundle.directories : []) {
    const rel = slash(dir);
    if (typeof dir !== 'string' || escapesStation(rel)) errors.push('unsafe bundle path: ' + rel);
    else if (systemSecretPath(rel) || plantedPath(rel)) errors.push('bundle contains a path StarNet never writes: ' + rel);
  }
  for (const row of browser) {
    const data = Buffer.from(String(row.value == null ? '' : row.value), 'utf8');
    if (data.length !== Number(row.bytes) || sha256(data) !== row.sha256) errors.push('browser payload checksum mismatch: ' + row.key);
    if (browserKeyIsSecret(row.key)) errors.push('bundle contains forbidden browser credential key: ' + row.key);
  }
  if (bundle && bundle.manifestSha256 !== manifestOf(bundle)) errors.push('manifest checksum mismatch');
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
  if (o.noOverwrite && fs.existsSync(file)) throw Object.assign(new Error('a file already exists at ' + file + '. Nothing was changed: choose another name.'), { code: 'EEXIST' });
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

/* WHAT ACTUALLY LANDS (#119 review). The bundle's own report is not a reason to trust its files: every row goes through
   today's capture policy again, so an older bundle (or an edited one) cannot put FULL BYPASS, armed routines, a raw
   credential store or an approval file on disk, and a name this disk cannot hold is dropped and named instead of costing
   the whole bundle. A sanitized store sanitized again comes out the same bytes. A pre-update snapshot takes the same path:
   a restore cannot tell a snapshot from an edited file, and nothing restores one except a person running this tool.
   onRow sees each row's bytes in turn, and none are kept here: this runs over a bundle that may be hundreds of MB. */
function restorePlan(bundle, onRow) {
  const dropped = [], reauth = [];
  for (const row of bundle.files) {
    const rel = slash(row.path);
    // an older bundle may still carry its source workspace's lifecycle files: never restored (see EPHEMERAL_FILES)
    if (LIFECYCLE.has(rel.toLowerCase())) { dropped.push({ path: rel, reason: 'station lifecycle file of the source workspace; the restored station records its own' }); continue; }
    const policy = classifyPolicy(rel, null);
    if (policy.action === 'skip') {
      dropped.push({ path: rel, reason: policy.reason });
      if (policy.reauth) reauth.push(policy.reauth);
      continue;
    }
    let data = Buffer.from(row.data, 'base64');
    if (policy.judge && holdsPrivateKey(data, rel)) {
      dropped.push({ path: rel, reason: CREDENTIAL_ROW });
      reauth.push(credentialReauth(rel));
      continue;
    }
    if (policy.scrub === 'git') data = scrubGitConfig(data);
    if (policy.quiet) {
      const quiet = quietStore(rel, data);
      data = quiet.data;
      reauth.push(...quiet.reauthentication);
    }
    if (policy.action === 'sanitize') {
      try {
        const clean = sanitizeManagedJson(rel, data, {});
        data = clean.data;
        reauth.push(...clean.reauthentication);
        if (clean.torn) dropped.push({ path: rel, reason: 'torn: does not parse, and it is left out because it may hold credentials' });
      } catch (e) {
        dropped.push({ path: rel, reason: 'could not be made credential-free: ' + String((e && e.message) || e).slice(0, 200) });
        reauth.push({ kind: 'credential-store-omitted', id: rel, reason: 'This store was not restored, so its connections are not listed: add them again.' });
        continue;
      }
    }
    if (typeof onRow === 'function') onRow({ rel, data, sha256: sha256(data), categories: row.categories || [] });
  }
  const directories = [];
  for (const dir of Array.isArray(bundle.directories) ? bundle.directories : []) {
    const rel = slash(dir);
    if (classifyPolicy(rel, null).action === 'skip') dropped.push({ path: rel, reason: 'an empty folder this disk cannot hold, or that is never restored' });
    else directories.push(rel);
  }
  return { dropped, reauth, directories };
}
// what a restore of this bundle would leave out, for a verdict printed before anything moves
function restorePreview(bundle) { const plan = restorePlan(bundle); return { dropped: plan.dropped, reauthentication: plan.reauth }; }
// a scanner or sync tool often holds a file for a moment on Windows: wait it out rather than fail a restore half way
const BUSY_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
function renameRetry(fs, from, to, delays) {
  const waits = Array.isArray(delays) ? delays : [100, 250, 500, 1000, 2000, 4000];
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (!e || !BUSY_RENAME.has(e.code) || i >= waits.length) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[i]);
    }
  }
}
function writeFlushed(fs, file, data) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, data);
    if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function restore(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const check = validate(o.bundle);
  if (!check.ok) throw new Error('refusing invalid recovery bundle: ' + check.errors.join('; '));
  const gate = restoreGate(o.bundle);
  // the person's explicit choices: a bundle with a gap may be all they have, and neither is ever the default
  if (gate.noAgents && !o.allowNoAgents) throw new Error('refusing a recovery bundle with no readable agent save');
  if (gate.gaps && !o.allowIncomplete) throw new Error('refusing incomplete recovery bundle');
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
  let plan = null;
  try {
    fs.mkdirSync(stage, { recursive: false });
    // restorePlan leaves out an older bundle's lifecycle files and names them in droppedOnRestore (see EPHEMERAL_FILES)
    plan = restorePlan(o.bundle, row => {
      const dest = path.resolve(stage, ...row.rel.split('/'));
      if (dest !== stage && !dest.startsWith(stage + path.sep)) throw new Error('unsafe restore path: ' + row.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // the stage starts empty, so a name already here differs only by case on a disk that cannot tell them apart
      if (fs.existsSync(dest)) throw new Error('this disk cannot hold two files whose names differ only by case: ' + row.rel);
      writeFlushed(fs, dest, row.data);
      const back = fs.readFileSync(dest);
      if (sha256(back) !== row.sha256) throw new Error('restore read-back mismatch: ' + row.rel);
      restored.push({ path: row.rel, bytes: row.data.length, categories: row.categories });
    });
    for (const dir of plan.directories) {
      const dest = path.resolve(stage, ...dir.split('/'));
      if (dest !== stage && !dest.startsWith(stage + path.sep)) throw new Error('unsafe restore path: ' + dir);
      fs.mkdirSync(dest, { recursive: true });
    }
    if (typeof o.beforeActivate === 'function') o.beforeActivate({ stage, target, rollback });
    if (fs.existsSync(target)) {
      if (!o.replaceExisting) throw new Error('restore target is not clean; pass replaceExisting to retain it as a rollback generation');
      renameRetry(fs, target, rollback, o.retryDelays);
      targetMoved = true;
    }
    renameRetry(fs, stage, target, o.retryDelays);
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
      droppedOnRestore: plan.dropped,
      directories: plan.directories.length,
      reauthentication: uniqueRows(clone((o.bundle.report && o.bundle.report.reauthentication) || []).concat(plan.reauth)),
      requirements: trustedRequirements(o.bundle),
      gate,
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
      try { renameRetry(fs, rollback, target, o.retryDelays); }
      catch (restoreError) { rollbackError = rollbackError || restoreError; }
    }
    if (e && typeof e === 'object') {
      if (rollbackError) e.rollbackError = rollbackError;
      // the one state a person must hear about: their station is not where StarNet will look for it
      if (targetMoved && !fs.existsSync(target) && fs.existsSync(rollback)) e.stationDisplaced = { target, rollback };
    }
    throw e;
  }
}

function uniqueRows(rows) {
  const seen = new Set(), out = [];
  for (const row of rows) {
    const k = [row.kind, row.id, row.reason].join('|');
    if (!seen.has(k)) { seen.add(k); out.push(row); }
  }
  return out;
}

/* The one line a shell runs as written, for the shell it names. PowerShell needs & to run a quoted path, and treats curly
   single quotes as quotes. Single quotes keep $, %, and backticks literal in both. */
function shellName(platform) { return platform === 'win32' ? 'PowerShell' : 'a POSIX shell'; }
function shellCommand(platform, argv) {
  if (platform === 'win32') return '& ' + argv.map(a => "'" + String(a).replace(/['\u2018\u2019\u201a\u201b]/g, m => m + m) + "'").join(' ');
  return argv.map(a => "'" + String(a).replace(/'/g, "'\\''") + "'").join(' ');
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
    const receipt = restore({ bundle: o.bundle, targetRoot: target, browserSink: sink, allowIncomplete: true, allowNoAgents: true, fs, path });
    const again = capture({ workspaceRoot: target, browserStore: sink, now: o.now, appVersion: o.bundle.appVersion, omitUnavailableCredentialStores: true, maxChars: BUNDLE_MAX_CHARS, fs, path });
    // compared with what the plan said would land: an older bundle's raw store is meant to come back cleaned
    const expected = [];
    const planned = new Map();
    const plan = restorePlan(o.bundle, x => { expected.push(x.rel + ':' + x.sha256); planned.set(x.rel, x.sha256); });
    expected.sort();
    // plan and landed both pass through the same rules, so comparing them cannot catch a rule that wipes a store. A bundle
    // from today's capture has had those rules already, so here the plan must also equal the bundle's own rows. The one
    // exception is a lifecycle file: a build from before that rule captured the reset marker with this same marker, and the
    // plan drops it on purpose (restorePlan names it in droppedOnRestore), so it is not a rewrite.
    const rewrittenByPlan = o.bundle.planKeepsRows === true ? o.bundle.files.map(x => slash(x.path)).filter((rel, i) => !LIFECYCLE.has(rel.toLowerCase()) && planned.get(rel) !== o.bundle.files[i].sha256) : [];
    const landed = again.files.map(x => x.path + ':' + x.sha256).sort();
    const dirsExpected = plan.directories.slice().sort();
    const dirsLanded = (again.directories || []).slice().sort();
    const contentMatches = !rewrittenByPlan.length && JSON.stringify(expected) === JSON.stringify(landed) && JSON.stringify(dirsExpected) === JSON.stringify(dirsLanded);
    return { ok: contentMatches, filesRestored: receipt.restored.length, contentMatches, rewrittenByPlan, droppedOnRestore: receipt.droppedOnRestore, gate: receipt.gate, reauthentication: receipt.reauthentication, requirements: receipt.requirements, integrity: receipt.integrity };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = {
  SCHEMA, VERSION, REQUIRED_CATEGORIES, BUDGET_SKIP_REASON, EXPLICIT_BUDGET_REASON, BUNDLE_MAX_CHARS, SKIP_ROWS_LISTED,
  capture, validate, writeBundleAtomic, readBundle, restore, rehearse, semanticFingerprint, bundleIntegrity, integrityGaps, restoreGate, restorePreview, trustedRequirements, shellName, shellCommand,
  browserKeyIsSecret, categoriesFor,
  _internals: { sanitizeManagedJson, restorePlan, classifyPolicy, completeness, sha256, budgetTier, rowChars, compactSkipped, unsafePathReason, renameRetry }
};
