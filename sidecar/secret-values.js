/* sidecar/secret-values.js — collect the secret VALUES the sidecar currently holds, for known-value redaction.

   context.js redact() scrubs vendor-SHAPED secrets; this feeds its known-value layer (setKnownSecretSource) with
   the exact strings that have no shape: service keys, custom connector tokens/headers/env, OAuth access/refresh
   tokens and client secrets, channel bot tokens, provider keys from vendors without a prefix.

   collectSecretValues(sources) -> string[]
     sources: array of
       { values: [...] }                  every string (or array of strings) in the list is a secret
       { keyed: obj|array, allUnder? }    walk the tree; a string under a SECRET_KEY field is a secret, and every
                                          string anywhere beneath a field named in allUnder (e.g. headers, env) is too
       { keyed, credentialUnder? }        the same walk, but beneath a field named in credentialUnder only the
                                          CREDENTIALS count: an entry whose name says so (isCredentialName: X-Api-Key,
                                          Authorization, OPENAI_API_KEY, DB_PASSWORD …) or a value shaped like a token
                                          (a 20+ letter/digit run holding both). prompt-scrub.js reads this narrower list:
                                          a connector's NODE_ENV=production or Content-Type: application/json is not a
                                          secret to scrub out of the Commander's own words.
   Whitespace-separated parts of a value are added as well: a Slack channel token is stored as the combined
   "xoxb-… xapp-…" pair and either half can surface alone. Short strings are filtered by context.js (KNOWN_MIN).
   Pure, bounded (depth + count caps), never throws on odd input. */
'use strict';
const { note: failNote } = require('./failopen.js');

const SECRET_KEY = /^(?:key|apikey|api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|app[_-]?token|device[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|secret|password|passwd|bearer|authorization)$/i;
/* CREDENTIAL NAMES (review r2, 2026-10-28). A header/env name is a credential by its WHOLE SEGMENTS (split on _ - . and
   camelCase), never a substring: the old /key|token|secret|pass|auth|…/ held KEYCLOAK_REALM, MONKEY_*, TOKENIZER,
   COMPASS_PROJECT and OAUTH_REDIRECT_URI values (and cut 'production' out of the Commander's own words), yet missed
   MYSQL_PWD, DB_PW, ADMIN_PIN, X-Admin-Pin, HMAC_SALT, X-Api-Sig, SENTRY_DSN, LICENSE and HUBSPOT_PAT, whose values
   then rode every prompt raw. A name is a credential when:
     · two segments say so together (access code, auth code, session id, connection string), or
     · its LAST segment is not a plainly public attribute (url, domain, realm, id, region, host, user, email, path …)
       and any segment is a credential word, or ends in one (pgpassword, mysqlpwd, clientsecret, authtoken). */
const CRED_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'secrets', 'pass', 'password', 'passwd', 'passphrase', 'pwd', 'pw', 'pin',
  'pat', 'auth', 'authorization', 'bearer', 'credential', 'credentials', 'cred', 'creds', 'cookie', 'cookies', 'session', 'sessionid',
  'signature', 'sig', 'signing', 'private', 'privatekey', 'salt', 'hmac', 'dsn', 'license', 'licence', 'otp', 'totp', 'hotp', 'mfa', 'seed',
  'connectionstring', 'connstr', 'connstring']);
const CRED_SUFFIX = /(?:password|passwd|passphrase|pwd|secret|token|apikey|accesskey|secretkey|privatekey|signingkey|authkey|licensekey|cookie|credentials?)$/;
const CRED_PAIRS = [['access', 'code'], ['auth', 'code'], ['verification', 'code'], ['session', 'id'], ['connection', 'string'], ['conn', 'string']];
const PUBLIC_TAIL = new Set(['url', 'uri', 'domain', 'realm', 'id', 'ids', 'scope', 'scopes', 'endpoint', 'region', 'mode', 'type', 'host',
  'hostname', 'port', 'name', 'user', 'username', 'login', 'email', 'path', 'dir', 'file', 'version', 'level', 'timeout', 'ttl', 'count',
  'size', 'format', 'enabled', 'algorithm', 'alg', 'prefix']);
function nameSegments(name) {
  return String(name == null ? '' : name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/* GLUED COMPOUNDS (review r3): a name written as one word ending in 'key' or 'pass' is a credential too — MASTERKEY,
   MEILI_MASTERKEY, APPKEY, DEPLOYKEY, ENCRYPTIONKEY, HMACKEY, PASSKEY, CLIENTKEY, SUBSCRIPTIONKEY, CONSUMERKEY, DBPASS,
   SMTPPASS — minus the ordinary words and public keys that end the same way (monkey, hotkey, publickey, partitionkey,
   bypass, compass). So is a segment that STARTS secretkey (Rails' SECRETKEYBASE). Round 1's substring rule held these;
   r2's whole-segment rule dropped them from the prompt held list. */
const GLUED_KEY = /^[a-z]{2,}key$/, GLUED_PASS = /^[a-z]{2,}pass$/;
const NOT_KEY = new Set(['monkey', 'donkey', 'turkey', 'whiskey', 'jockey', 'hockey', 'lackey', 'malarkey', 'hotkey', 'turnkey', 'shortcutkey',
  'publickey', 'pubkey', 'sortkey', 'partitionkey', 'rangekey', 'hashkey', 'cachekey', 'foreignkey']);
const NOT_PASS = new Set(['bypass', 'compass', 'overpass', 'underpass', 'surpass', 'trespass', 'encompass', 'impass', 'firstpass', 'multipass']);
function gluedCredential(s) {
  return (GLUED_KEY.test(s) && !NOT_KEY.has(s)) || (GLUED_PASS.test(s) && !NOT_PASS.has(s)) || s.startsWith('secretkey');
}
function isCredentialName(name) {
  const seg = nameSegments(name);
  if (!seg.length) return false;
  for (const [a, b] of CRED_PAIRS) { const i = seg.indexOf(a); if (i >= 0 && seg[i + 1] === b) return true; }
  if (PUBLIC_TAIL.has(seg[seg.length - 1])) return false;
  return seg.some(s => CRED_WORDS.has(s) || CRED_SUFFIX.test(s) || gluedCredential(s));
}
const CREDENTIAL_NAME = { test: isCredentialName };   // the old export's .test(name) interface
const TOKEN_LIKE = /[A-Za-z0-9]{20,}/;
const MAX_DEPTH = 8;
const MAX_VALUES = 2000;

function collectSecretValues(sources) {
  const out = new Set();
  function add(v) {
    if (out.size >= MAX_VALUES || typeof v !== 'string') return;
    const t = v.trim();
    if (!t) return;
    out.add(t);
    const parts = t.split(/\s+/);
    if (parts.length > 1) for (const p of parts) if (p) out.add(p);
  }
  function addAll(v, depth) {
    if (depth > MAX_DEPTH || v == null) return;
    if (typeof v === 'string') return add(v);
    if (Array.isArray(v)) { for (const x of v) addAll(x, depth + 1); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) addAll(v[k], depth + 1);
  }
  // beneath a credentialUnder field: named credentials whole, anything else only when it is shaped like a token
  function addCredentials(v, depth, named) {
    if (depth > MAX_DEPTH || v == null) return;
    if (typeof v === 'string') {
      if (named) return add(v);
      for (const m of v.match(new RegExp(TOKEN_LIKE.source, 'g')) || []) if (/[0-9]/.test(m) && /[A-Za-z]/.test(m)) return add(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) addCredentials(x, depth + 1, named); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) addCredentials(v[k], depth + 1, named || isCredentialName(k));
  }
  function walk(v, depth, allUnder, credUnder) {
    if (depth > MAX_DEPTH || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1, allUnder, credUnder); return; }
    for (const k of Object.keys(v)) {
      const child = v[k];
      if (allUnder && allUnder.has(k)) addAll(child, depth + 1);
      else if (credUnder && credUnder.has(k)) addCredentials(child, depth + 1, false);
      else if (typeof child === 'string') { if (SECRET_KEY.test(k)) add(child); }
      else if (Array.isArray(child) && SECRET_KEY.test(k)) addAll(child, depth + 1);
      else walk(child, depth + 1, allUnder, credUnder);
    }
  }
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s !== 'object') continue;
    try {
      if ('values' in s) addAll(s.values, 0);
      if ('keyed' in s) walk(s.keyed, 0, Array.isArray(s.allUnder) ? new Set(s.allUnder) : null, Array.isArray(s.credentialUnder) ? new Set(s.credentialUnder) : null);
    } catch (e) { failNote('secret-values.source', e); }   // one malformed source must not blind the others
  }
  return Array.from(out);
}

module.exports = { collectSecretValues, SECRET_KEY, CREDENTIAL_NAME, isCredentialName };
