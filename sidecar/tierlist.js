/* sidecar/tierlist.js — Agent OS's editorial model tier list, fetched from the linked cloud for the model picker.

   SOURCE: GET {cloudBase}/v1/tierlist (public, no auth) →
     { updated, boards: [ { key, title, tiers: [ { tier: 'S'|'A'|'B'|'C', models: [ { id, note } ] } ] } ] }
   Model ids are OpenRouter ids (the same ids the starnet provider's catalog uses).

   TRUTHFUL-TELEMETRY POSTURE: the placements are the cloud's opinion, never ours to invent. The payload is
   validated (unknown tiers/boards dropped, strings bounded); a fetch that fails or returns junk yields an EMPTY
   list plus a reason — never a guessed or built-in list. A previously fetched list keeps being served (marked
   stale, with the refresh failure named) until it is older than MAX_STALE_MS.

   CACHE: a good list is fresh for TTL_MS (10 min, matching the cloud's max-age=600); a failure is remembered
   for FAIL_TTL_MS so an offline station does not re-dial the cloud on every picker open. Concurrent callers
   share one in-flight fetch; the fetch is bounded by TIMEOUT_MS so the picker never waits on a slow cloud. */
'use strict';

const TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
const TIERS = ['S', 'A', 'B', 'C'];
const MAX_BYTES = 256 * 1024;

function clip(v, n) { return String(v == null ? '' : v).replace(/[\0-\x1f\x7f]+/g, ' ').trim().slice(0, n); }

/* Validate + normalize the cloud payload. Returns null when it is not shaped like a tier list at all. */
function normalize(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.boards)) return null;
  const boards = [];
  for (const b of payload.boards.slice(0, 12)) {
    if (!b || typeof b !== 'object') continue;
    const key = clip(b.key, 32).toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) continue;
    const tiers = [];
    for (const t of Array.isArray(b.tiers) ? b.tiers.slice(0, 8) : []) {
      const tier = clip(t && t.tier, 2).toUpperCase();
      if (TIERS.indexOf(tier) < 0) continue;
      const models = [];
      for (const m of Array.isArray(t.models) ? t.models.slice(0, 64) : []) {
        const id = clip(m && m.id, 200);
        if (!id || /\s/.test(id)) continue;
        models.push({ id, note: clip(m.note, 280) });
      }
      if (models.length) tiers.push({ tier, models });
    }
    if (tiers.length) boards.push({ key, title: clip(b.title, 80) || key, tiers });
  }
  return { updated: clip(payload.updated, 40), boards };
}

function makeTierList(deps) {
  deps = deps || {};
  const doFetch = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  // the clock is INJECTED (determinism lint: no ambient time in backend logic) — index.js passes the real one
  if (typeof deps.now !== 'function') throw new Error('makeTierList requires deps.now (the injected clock)');
  const now = deps.now;
  const baseUrl = typeof deps.baseUrl === 'function' ? deps.baseUrl : () => String(deps.baseUrl || '');
  const ttlMs = deps.ttlMs > 0 ? deps.ttlMs : TTL_MS;
  const failTtlMs = deps.failTtlMs > 0 ? deps.failTtlMs : FAIL_TTL_MS;
  const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : TIMEOUT_MS;
  let good = null;        // { base, list, fetchedAt }
  let failure = null;     // { base, reason, at }
  let inflight = null;

  async function fetchOnce(base) {
    if (!doFetch) throw new Error('no fetch available');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(base + '/v1/tierlist', { headers: { Accept: 'application/json' }, signal: ac.signal });
      if (!res || !res.ok) throw new Error('cloud answered http ' + (res ? res.status : '?'));
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('tier list payload too large');
      let json;
      try { json = JSON.parse(text); } catch (_) { throw new Error('cloud sent a non-JSON tier list'); }
      const list = normalize(json);
      if (!list) throw new Error('cloud sent a malformed tier list');
      return list;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('cloud did not answer within ' + Math.round(timeoutMs / 1000) + 's');
      throw e;
    } finally { clearTimeout(timer); }
  }

  function view(base, extra) {
    const t = now();
    if (good && good.base === base && t - good.fetchedAt <= MAX_STALE_MS) {
      return Object.assign({ ok: true, source: base + '/v1/tierlist', fetchedAt: good.fetchedAt, stale: t - good.fetchedAt > ttlMs,
        updated: good.list.updated, boards: good.list.boards }, extra || {});
    }
    return Object.assign({ ok: false, source: base ? base + '/v1/tierlist' : '', fetchedAt: 0, stale: false, updated: '', boards: [] }, extra || {});
  }

  async function get(opts) {
    const force = !!(opts && opts.force);
    const base = String(baseUrl() || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return view('', { reason: 'no Agent OS cloud is configured on this station' });
    const t = now();
    if (!force && good && good.base === base && t - good.fetchedAt < ttlMs) return view(base);
    if (!force && failure && failure.base === base && t - failure.at < failTtlMs) return view(base, { reason: failure.reason });
    if (!inflight) {
      inflight = fetchOnce(base).then(list => {
        good = { base, list, fetchedAt: now() }; failure = null;
      }, e => {
        failure = { base, reason: 'tier list unavailable: ' + clip((e && e.message) || e, 200), at: now() };
      }).finally(() => { inflight = null; });
    }
    await inflight;
    return failure && failure.base === base ? view(base, { reason: failure.reason }) : view(base);
  }

  return { get, _normalize: normalize };
}

module.exports = { makeTierList, normalize, TTL_MS, TIMEOUT_MS };
