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
                                          CREDENTIALS count: an entry whose name says so (CREDENTIAL_NAME: X-Api-Key,
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
const CREDENTIAL_NAME = /key|token|secret|pass|auth|bearer|credential|cookie|session|signature|private/i;
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
    if (typeof v === 'object') for (const k of Object.keys(v)) addCredentials(v[k], depth + 1, named || CREDENTIAL_NAME.test(k));
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

module.exports = { collectSecretValues, SECRET_KEY, CREDENTIAL_NAME };
