/* sidecar/engine-credential.js — the station's OWN copy of a provider key saved in a browser page, and the ONE
   sentence every unattended surface says when the station has no credential to run on (#89).

   THE GAP: in the browser/source build (npm start + a browser on :8787 — every Linux install) the page keeps the
   BYOK key in localStorage and sends it inside each interactive /api/run body, so chat works. Everything that runs
   with no page attached — a scheduled routine, Run Now, the night shift, the quest refresh, a line hop, a phone
   task — resolves its key on the station (index.js providerRuntimeKey), which only ever knew the operator's env vars
   and the desktop shell's keychain push. So routines answered "no usable credential" while chat worked.

   THE FIX: the page hands the station a copy when the Commander saves or removes a key (and once per page boot for
   keys it already holds) — POST /api/providers/engine-key, gated like every other /api/* mutation. This module is
   the store behind that route: one record per provider { key, keyPool, baseUrl }, kept in
   WORKSPACES/.secrets/provider-keys.json (the protected sibling of the fs jail that pre-update backups skip).

     makeEngineKeys({ load, persist }) -> store
       load()            -> the parsed file, or undefined (absent/unreadable/corrupt = nothing saved)
       persist(envelope) -> bool  ok ONLY when a read-back proved the write reached disk
       store.get(id)            -> { key, keyPool, baseUrl } | null
       store.put(id, input)     -> { ok, changed, invalid?, error? }  input = the page's FULL config for that provider;
                                   all-empty removes the record. Memory changes ONLY after persist() proved the
                                   write: what the station runs on is always exactly what survives a restart, and a
                                   failed save leaves the old state in place (the route says so; chat still works).
       store.secretValues()     -> every saved key (the known-value redaction source)
     credentialError(o)  -> the ONE refusal sentence (o = { id, label, kind, env, baseUrlEnv, what })
     UNATTENDED_REMEDY   -> its provider-less remedy clause (the night-shift report reuses it verbatim)

   Precedence (index.js): an explicit per-run key > the desktop keychain push / an operator env var
   (OPENROUTER_API_KEY …) > this page copy. A deployment that set an env var keeps it; the page copy only fills a gap.
   Pure — no clock, no fs; the host injects both. */
'use strict';

const WHERE = 'SETTINGS → AI & MODELS';
const ENV_HOME = 'the environment that starts StarNet';
const UNATTENDED_REMEDY = 'connect or re-save a provider key under ' + WHERE + ' (or set its API key variable in ' + ENV_HOME + ') and pick a model';
const FILE_VERSION = 1;
const MAX_KEY = 4096, MAX_POOL = 8, MAX_URL = 2048;

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
  }
  if (!key && !pool.length && !baseUrl) return { ok: true, record: null };
  const record = {};
  if (key) record.key = key;
  if (pool.length) record.keyPool = pool;
  if (baseUrl) record.baseUrl = baseUrl;
  return { ok: true, record };
}

// read the file shape back, keeping only well-formed provider records (a hand-edited or torn entry never loads as a key)
function readProviders(raw) {
  const out = Object.create(null);
  const src = raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers) ? raw.providers : {};
  for (const id of Object.keys(src)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) continue;
    const n = normalizeInput(src[id]);
    if (n.ok && n.record) out[id] = n.record;
  }
  return out;
}
function toEnvelope(map) {
  const providers = {};
  for (const id of Object.keys(map).sort()) providers[id] = map[id];
  return { version: FILE_VERSION, providers };
}

function makeEngineKeys(deps) {
  const d = deps || {};
  let map = Object.create(null);
  try { map = readProviders(typeof d.load === 'function' ? d.load() : undefined); } catch (_) { map = Object.create(null); }
  function get(id) { const r = map[String(id || '')]; return r ? Object.assign({}, r, r.keyPool ? { keyPool: r.keyPool.slice() } : {}) : null; }
  function put(id, input) {
    id = String(id || '');
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) return { ok: false, invalid: true, error: 'unknown provider' };
    const n = normalizeInput(input);
    if (!n.ok) return { ok: false, invalid: true, error: n.error };
    const next = Object.create(null);
    for (const k of Object.keys(map)) if (k !== id) next[k] = map[k];
    if (n.record) next[id] = n.record;
    if (JSON.stringify(toEnvelope(next)) === JSON.stringify(toEnvelope(map))) return { ok: true, changed: false };
    let proven = false;
    try { proven = typeof d.persist === 'function' && d.persist(toEnvelope(next)) === true; } catch (_) { proven = false; }
    if (!proven) return { ok: false, changed: false, error: 'persist' };
    map = next;
    return { ok: true, changed: true };
  }
  function secretValues() {
    const out = [];
    for (const id of Object.keys(map)) { const r = map[id]; if (r.key) out.push(r.key); for (const k of (r.keyPool || [])) out.push(k); }
    return out;
  }
  return { get, put, secretValues };
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
