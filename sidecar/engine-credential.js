/* sidecar/engine-credential.js — the station's OWN copy of a provider key saved in a browser page, and the ONE
   sentence every unattended surface says when the station has no credential to run on (#89).

   THE GAP: in the browser/source build (npm start + a browser on :8787 — every Linux install) the page keeps the
   BYOK key in localStorage and sends it inside each interactive /api/run body, so chat works. Everything that runs
   with no page attached — a scheduled routine, Run Now, the night shift, the quest refresh, a line hop, a phone
   task — resolves its key on the station (index.js providerRuntimeKey), which only ever knew the operator's env vars
   and the desktop shell's keychain push. So routines answered "no usable credential" while chat worked.

   THE FIX: the page hands the station a copy when the Commander saves or removes a key (and once per page boot for
   keys it already holds) — POST /api/providers/engine-key, gated like every other /api/* mutation. This module is
   the store behind that route: one record per provider { key, keyPool, baseUrl, rev }, kept in
   WORKSPACES/.secrets/provider-keys.json (the protected sibling of the fs jail that pre-update backups skip).

     makeEngineKeys({ load, persist, verify?, newRev? }) -> store
       load()            -> the parsed file, or undefined (absent/unreadable/corrupt = nothing saved)
       persist(envelope) -> bool  ok ONLY when a read-back proved the write reached disk
       verify(envelope)  -> bool  whether the files on disk hold exactly this envelope (an unchanged push re-checks
                                  it, so a file deleted behind the station's back is rewritten, not reported saved)
       store.get(id)            -> { key, keyPool, baseUrl } | null
       store.revOf(id)          -> the record's revision ('' = the station holds nothing for this provider)
       store.put(id, input, o)  -> { ok, changed, applied, stale?, removing?, held?, invalid?, error? }
                                   input = the page's FULL config for that provider; all-empty is REMOVE.
                                   Memory changes ONLY after persist() proved the write: what the station runs on is
                                   always exactly what survives a restart, and a failed save (or a failed REMOVE —
                                   `removing` says which; `held` says the station still holds a copy it will keep
                                   using) leaves the old state in place and on disk.
                                   o.boot + o.ifRev: a page BOOT re-hand-over. It applies only when the station holds
                                   nothing for that provider, or still holds the revision this page itself last saw
                                   (ifRev) — so an older origin's localStorage (localhost vs 127.0.0.1 are separate
                                   stores) can never put back a key the Commander rotated or removed in another page.
                                   An explicit save / REMOVE (no o.boot) is last-write-wins.
       store.secretValues()     -> every saved key (the known-value redaction source)
     credentialError(o)  -> the ONE refusal sentence (o = { id, label, kind, env, baseUrlEnv, what })
     UNATTENDED_REMEDY   -> its provider-less remedy clause (the night-shift report reuses it verbatim)

   A REMOVE leaves a tombstone { rev, removed: true } (no key): it is what lets a later boot hand-over from a page that
   still holds the removed key see that the Commander's newer choice was "none".

   Precedence (index.js): an explicit per-run key > the desktop keychain push / an operator env var
   (OPENROUTER_API_KEY …) > this page copy. A deployment that set an env var keeps it; the page copy only fills a gap.
   The page copy's endpoint and backup keys ride only with the page copy's own key (never with an env key or another
   page's per-run key). Scope: the page copy is the station's key for that provider, exactly as the desktop keychain
   push is — so besides unattended runs it also serves the station-held-key features (cross-provider dispatch workers,
   the image tools' station OpenAI key, the /v1 OpenAI-compatible ingress, overseer reviews, the provider doctor).
   Pure — no clock, no fs; the host injects both. */
'use strict';

const WHERE = 'SETTINGS → AI & MODELS';
const ENV_HOME = 'the environment that starts StarNet';
const UNATTENDED_REMEDY = 'connect or re-save a provider key under ' + WHERE + ' (or set its API key variable in ' + ENV_HOME + ') and pick a model';
const FILE_VERSION = 1;
const MAX_KEY = 4096, MAX_POOL = 8, MAX_URL = 2048;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const REV_RE = /^[a-z0-9]{1,32}$/;

// no provider key contains whitespace: strip a wrap / zero-width char from the middle too (same as cleanProviderKey)
function cleanKey(v) { return String(v == null ? '' : v).replace(/[\s​-‍⁠﻿]+/g, ''); }

/* normalizeInput(input) -> { ok, record|null, error } — the page's config for one provider, cleaned. */
function normalizeInput(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const key = cleanKey(o.key);
  if (key.length > MAX_KEY) return { ok: false, error: 'that key is too long to be a provider key' };
  const pool = [];
  for (const raw of (Array.isArray(o.keyPool) ? o.keyPool : [])) {
    const k = cleanKey(raw);
    if (!k || pool.indexOf(k) >= 0) continue;
    if (k.length > MAX_KEY) return { ok: false, error: 'a backup key is too long to be a provider key' };
    pool.push(k);
    if (pool.length >= MAX_POOL) break;
  }
  const baseUrl = String(o.baseUrl == null ? '' : o.baseUrl).trim();
  if (baseUrl) {
    let u = null; try { u = new URL(baseUrl); } catch (_) { u = null; }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || baseUrl.length > MAX_URL) return { ok: false, error: 'the base URL must be an http(s) address' };
    // a credential belongs in the key field: a user:token@ URL would be stored, and answered back as an endpoint
    if (u.username || u.password) return { ok: false, error: 'the base URL must not carry a user name or password — put the key in the key field' };
  }
  if (!key && !pool.length && !baseUrl) return { ok: true, record: null };
  const record = {};
  if (key) record.key = key;
  if (pool.length) record.keyPool = pool;
  if (baseUrl) record.baseUrl = baseUrl;
  return { ok: true, record };
}

// read the file shape back, keeping only well-formed provider records (a hand-edited or torn entry never loads as a
// key). A record written before revisions existed loads as rev '0', which no page holds.
function readProviders(raw) {
  const out = Object.create(null);
  const src = raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers) ? raw.providers : {};
  for (const id of Object.keys(src)) {
    const s = src[id];
    if (!ID_RE.test(id) || !s || typeof s !== 'object' || Array.isArray(s)) continue;
    const n = normalizeInput(s);
    if (!n.ok) continue;
    const rev = REV_RE.test(String(s.rev || '')) ? String(s.rev) : '0';
    if (n.record) out[id] = Object.assign(n.record, { rev });
    else if (s.removed === true) out[id] = { rev, removed: true };
  }
  return out;
}
function toEnvelope(map) {
  const providers = {};
  for (const id of Object.keys(map).sort()) providers[id] = map[id];
  return { version: FILE_VERSION, providers };
}
// what a record means, revision aside: 'none' (never saved) / 'removed' (a tombstone) / the config itself
function contentOf(rec) {
  if (!rec) return 'none';
  if (rec.removed) return 'removed';
  return JSON.stringify({ key: rec.key || '', keyPool: rec.keyPool || [], baseUrl: rec.baseUrl || '' });
}

function makeEngineKeys(deps) {
  const d = deps || {};
  const newRev = typeof d.newRev === 'function' ? d.newRev : () => require('crypto').randomBytes(6).toString('hex');
  let map = Object.create(null);
  try { map = readProviders(typeof d.load === 'function' ? d.load() : undefined); } catch (_) { map = Object.create(null); }
  function get(id) {
    const r = map[String(id || '')];
    if (!r || r.removed) return null;
    const out = {};
    if (r.key) out.key = r.key;
    if (r.keyPool) out.keyPool = r.keyPool.slice();
    if (r.baseUrl) out.baseUrl = r.baseUrl;
    return out;
  }
  function revOf(id) { const r = map[String(id || '')]; return r ? r.rev : ''; }
  function persistProven(envelope) {
    try { return typeof d.persist === 'function' && d.persist(envelope) === true; } catch (_) { return false; }
  }
  // an unchanged push still proves the disk: a file deleted or torn behind the station's back is rewritten here
  // instead of being answered "saved" while a restart would lose it
  function onDisk() {
    const env = toEnvelope(map);
    let held = false;
    try {
      held = typeof d.verify === 'function' ? d.verify(env) === true
        : JSON.stringify(toEnvelope(readProviders(typeof d.load === 'function' ? d.load() : undefined))) === JSON.stringify(env);
    } catch (_) { held = false; }
    return held || persistProven(env);
  }
  function put(id, input, opts) {
    id = String(id || '');
    if (!ID_RE.test(id)) return { ok: false, invalid: true, error: 'unknown provider' };
    const n = normalizeInput(input);
    if (!n.ok) return { ok: false, invalid: true, error: n.error };
    const o = opts || {};
    const cur = map[id] || null;
    // a boot hand-over never overwrites a change made since this page last saw the station's copy
    if (o.boot && cur && cur.rev !== String(o.ifRev || '')) return { ok: true, changed: false, applied: false, stale: true };
    const want = n.record || { removed: true };
    if (contentOf(want) === contentOf(cur)) {
      return onDisk() ? { ok: true, changed: false, applied: true } : { ok: false, changed: false, applied: false, removing: !n.record, held: !!(cur && !cur.removed), error: 'persist' };
    }
    const next = Object.create(null);
    for (const k of Object.keys(map)) if (k !== id) next[k] = map[k];
    next[id] = n.record ? Object.assign({}, n.record, { rev: newRev() }) : { rev: newRev(), removed: true };   // the field order readProviders loads
    if (!persistProven(toEnvelope(next))) {
      // a half-landed write (main replaced, .bak not) would make the next boot load what this answer says was NOT
      // adopted: put the files back to what the station runs on (best effort — the route reports the failure either way)
      persistProven(toEnvelope(map));
      return { ok: false, changed: false, applied: false, removing: !n.record, held: !!(cur && !cur.removed), error: 'persist' };
    }
    map = next;
    return { ok: true, changed: true, applied: true };
  }
  function secretValues() {
    const out = [];
    for (const id of Object.keys(map)) { const r = map[id]; if (r.key) out.push(r.key); for (const k of (r.keyPool || [])) out.push(k); }
    return out;
  }
  return { get, revOf, put, secretValues };
}

/* credentialError({ id, label, kind, env, baseUrlEnv, what }) — why this unattended run cannot start, and the two real
   ways out: the page (which now hands the station its copy on save) or the operator's environment. `kind` is the
   provider's credential shape: key | baseUrl | codex | oauth | starnet | other. */
function credentialError(o) {
  o = o || {};
  const label = String(o.label || o.id || 'this provider');
  const what = String(o.what || 'this routine');
  switch (o.kind) {
    case 'codex': return 'ChatGPT is not signed in on this station, so ' + what + ' can\'t run — sign in under ' + WHERE;
    case 'oauth': return label + ' is not signed in on this station, so ' + what + ' can\'t run — sign in under ' + WHERE;
    case 'starnet': return 'this station is not linked to a StarNet account, so ' + what + ' can\'t run on credits — link it under ' + WHERE + ' → STARNET MANAGED';
    case 'baseUrl': return 'no ' + label + ' base URL is saved on this station for ' + what + ' — set it under ' + WHERE +
      (o.baseUrlEnv ? ', or set ' + o.baseUrlEnv + ' in ' + ENV_HOME : '');
    case 'key': return 'no ' + label + ' API key is saved on this station for ' + what + ' — connect or re-save it under ' + WHERE +
      (o.env ? ', or set ' + o.env + ' in ' + ENV_HOME : '');
    default: return label + ' is not set up on this station for ' + what + ' — set it up under ' + WHERE;
  }
}

module.exports = { makeEngineKeys, credentialError, normalizeInput, cleanKey, UNATTENDED_REMEDY, WHERE, FILE_VERSION };
