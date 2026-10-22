/* sidecar/providers/liveprices.js — LIVE model pricing from the models.dev aggregate.

   WHY (2026-07-31, Hermes-parity pass): prices.js is a hand-maintained snapshot of published rates.
   It goes stale on every model release, and its family fallbacks then price a new model at the old
   family rate — the seatbelt still works, but the estimate drifts. Hermes aggregates models.dev
   (agent/models_dev.py); this is the Agent OS-shaped equivalent: a small disk-cached fetcher the host
   wires into prices.setLiveLookup() at boot.

   SHAPE OF THE SOURCE (probed live 2026-07-31): https://models.dev/api.json →
     { <provider>: { models: { <id>: { cost: { input, output, cache_read?, cache_write? }, ... } } } }
   with cost in USD per MILLION tokens — the exact unit prices.js speaks.

   SAFETY POSTURE (this feeds the SPEND SEATBELT — treat the payload as hostile):
     · every number is validated (finite, 0..10000 $/Mtok); a bad entry is dropped, never guessed at.
     · the fetch is time-bounded, background, and NEVER blocks a run; priceOf reads only the in-memory
       table loaded from the disk cache.
     · on any failure the last-good disk cache stays; with no cache at all, prices.js's built-in
       snapshot answers exactly as before this file existed.
     · refresh cadence 24h; the file lives in the workspace dir beside the other stores. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_URL = 'https://models.dev/api.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
// our price family -> models.dev provider key. Keys probed against https://models.dev/api.json on
// 2026-08-21: the aggregate has NO `together` or `fireworks` key — Together is `togetherai` and Fireworks is
// `fireworks-ai` (ids there carry the accounts/fireworks/models/ prefix, same as the wire). The extractor and
// the disk-cache revalidation both iterate THIS map, so adding a family here is the whole change.
const FAMILY_TO_PROVIDER = {
  anthropic: 'anthropic', gemini: 'google',
  openai: 'openai', xai: 'xai', groq: 'groq', mistral: 'mistral', deepseek: 'deepseek',
  together: 'togetherai', fireworks: 'fireworks-ai'
};

function saneRate(n) { return Number.isFinite(n) && n >= 0 && n <= 10000; }

/* Flatten the payload to { <family>: { <lower-model-id>: { in, out } } }, dropping anything that
   does not validate. Returns null when the payload is not even shaped like models.dev. */
function extract(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  let kept = 0;
  for (const family of Object.keys(FAMILY_TO_PROVIDER)) {
    const prov = payload[FAMILY_TO_PROVIDER[family]];
    const models = prov && prov.models;
    if (!models || typeof models !== 'object') continue;
    const table = {};
    for (const id of Object.keys(models)) {
      const cost = models[id] && models[id].cost;
      if (!cost) continue;
      const i = Number(cost.input), o = Number(cost.output);
      if (!saneRate(i) || !saneRate(o)) continue;
      table[String(id).toLowerCase()] = { in: i, out: o };
      kept++;
    }
    if (Object.keys(table).length) out[family] = table;
  }
  return kept ? out : null;
}

function makeLivePrices(deps) {
  deps = deps || {};
  const file = deps.file || null;
  const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  // the clock is INJECTED (determinism lint: no ambient Date.now in providers). Without one, cadence
  // tracking degrades to "refresh only when forced or never-fetched" — the host always passes a real clock.
  const now = deps.now || (() => 0);

  let byFamily = null;   // { family: { id: {in,out} } }
  let fetchedAt = 0;
  let refreshing = false;

  // boot: last-good disk cache, synchronously — cheap (a few KB) and makes lookup warm from turn one
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.byFamily && typeof raw.byFamily === 'object') {
        // re-validate what we ourselves wrote — a corrupted cache must not poison the seatbelt
        const clean = {};
        for (const fam of Object.keys(FAMILY_TO_PROVIDER)) {
          const t = raw.byFamily[fam];
          if (!t || typeof t !== 'object') continue;
          const ct = {};
          for (const id of Object.keys(t)) {
            const v = t[id];
            if (v && saneRate(Number(v.in)) && saneRate(Number(v.out))) ct[id] = { in: Number(v.in), out: Number(v.out) };
          }
          if (Object.keys(ct).length) clean[fam] = ct;
        }
        if (Object.keys(clean).length) { byFamily = clean; fetchedAt = Number(raw.fetchedAt) || 0; }
      }
    } catch (_) { /* no cache yet, or garbage — built-ins answer until a refresh lands */ }
  }

  /* lookup(family, id) -> { in, out } | null — exact id first, then longest prefix (a dated or
     suffixed local id still matches its base entry). Case-insensitive; gemini's `models/` prefix
     is stripped because Google's API ids carry it while models.dev's do not. */
  function lookup(family, id) {
    const table = byFamily && byFamily[family];
    if (!table) return null;
    let key = String(id == null ? '' : id).trim().toLowerCase();
    if (!key) return null;
    if (key.indexOf('models/') === 0) key = key.slice(7);
    if (table[key]) return table[key];
    let best = null, bestLen = 0;
    for (const k of Object.keys(table)) {
      if (key.indexOf(k) === 0 && k.length > bestLen) { best = table[k]; bestLen = k.length; }
    }
    return best;
  }

  /* refresh() — background, self-throttled to the 24h cadence, never throws. Fire-and-forget from
     the host; also safe to call on an interval. */
  async function refresh(force) {
    if (!doFetch || refreshing) return false;
    if (!force && fetchedAt && (now() - fetchedAt) < REFRESH_MS) return false;
    refreshing = true;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, FETCH_TIMEOUT_MS);
      if (t.unref) t.unref();
      let payload;
      try { payload = await (await doFetch(SOURCE_URL, { signal: ctrl.signal })).json(); }
      finally { clearTimeout(t); }
      const table = extract(payload);
      if (!table) return false;             // shape drifted — keep last-good, try again next cadence
      byFamily = table;
      fetchedAt = now();
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ fetchedAt, byFamily }, null, 2));
        } catch (_) { /* a failed cache write only costs the next boot a refetch */ }
      }
      return true;
    } catch (_) { return false; }
    finally { refreshing = false; }
  }

  function state() { return { loaded: !!byFamily, fetchedAt }; }

  return { lookup, refresh, state, _internals: { extract, saneRate, FAMILY_TO_PROVIDER } };
}

module.exports = { makeLivePrices };
