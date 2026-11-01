/* sidecar/sub-usage.js — how much of each SUBSCRIPTION sign-in is used, as the provider itself last said it.

   A subscription (Claude Code, ChatGPT) is not metered in dollars: it is metered in windows — "12% of your 5-hour
   limit, resets at 4pm; 7% of the week". The station never knew those numbers; it learned a limit only by hitting it.
   Both providers SAY them on every call, and this store keeps what they last said, per sign-in (subscription
   stacking: account 1 is the provider's own sign-in, then each extra account):

     Claude Code  every stream-json run carries a `rate_limit_event` line:
                    rate_limit_info.unifiedWindows = { five_hour: { utilization: 0.12, resetsAt: <epoch s>, status },
                                                       seven_day: { … } }   (utilization is a 0–1 fraction)
                  (seen live 10-27 on claude 2.1.310; an older CLI without unifiedWindows says only the binding one:
                   rate_limit_info.{ rateLimitType, resetsAt, status } and no utilization — kept as such, no number made up)
     ChatGPT      every chatgpt.com/backend-api/codex response carries headers (the names the codex CLI reads; its own
                  session log showed the same window, 10-27):
                    x-codex-primary-used-percent / -window-minutes / -reset-at   (and -secondary-…)
                    x-codex-credits-has-credits / -unlimited / -balance

   Nothing here is estimated. A sign-in no call has run on since this store began says nothing (no entry), and every
   entry carries when it was seen, so a reader can say "as of the last run, 2 hours ago".

   makeSubUsage({ clock?, file?, fs?, path?, saveMs? }) -> {
     observeClaude(account, info)               a rate_limit_event's rate_limit_info ('' or 'primary' = account 1)
     observeHeaders(providerId, account, headers)
     wrapFetch(providerId, account, fetch) -> fetch   reads the headers of every response, changes nothing
     get(providerId, account) -> entry | null    { windows: [{ id, label, usedPct|null, resetsAt|null, status }], credits?, seenAt }
     snapshot() -> { [providerId]: { [account]: entry } }
     flush()
   }
   Persisted (file) so "as of the last run" survives a restart: written at most every saveMs, through the resilient
   JSON writer (durable + last-known-good). No credential is ever in it — numbers and times only. */
'use strict';

const { readJsonResilient, writeJsonResilient } = require('./durable-store.js');
const { note: failNote } = require('./failopen.js');

const LABELS = { five_hour: '5-hour', seven_day: 'week', seven_day_opus: 'week · Opus', seven_day_sonnet: 'week · Sonnet' };
const acctKey = a => (!a || a === 'primary') ? 'primary' : String(a);
const num = v => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };   // absent is unknown, never 0
const toMs = v => { const n = num(v); return n == null ? null : n < 1e12 ? n * 1000 : n; };   // epoch s or ms
function windowLabel(minutes) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'week';
  if (minutes >= 1440 && minutes % 1440 === 0) return (minutes / 1440) + '-day';
  return minutes >= 60 ? Math.round(minutes / 60) + '-hour' : minutes + '-minute';
}
function header(h, name) {
  if (!h) return null;
  try {
    if (typeof h.get === 'function') return h.get(name);
    for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
  } catch (e) { failNote('subusage.header', e); }   // a headers object that throws says nothing
  return null;
}

function makeSubUsage(opts) {
  const o = opts || {};
  // Clock is INJECTED (lint-determinism), as in providers/ratelimits.js
  const now = (o.clock && typeof o.clock.now === 'function') ? () => o.clock.now() : () => 0;
  const saveMs = typeof o.saveMs === 'number' ? o.saveMs : 1000;   // a hard kill (no shutdown hook) loses at most this much
  const store = new Map();   // providerId -> Map(account -> entry)
  const deps = o.file ? { fs: o.fs || require('fs'), path: o.path || require('path') } : null;
  if (deps) {
    try {
      const r = readJsonResilient(deps, o.file);
      const v = r && r.value && r.value.providers;
      if (v && typeof v === 'object') for (const pid of Object.keys(v)) for (const acct of Object.keys(v[pid] || {})) put(pid, acct, v[pid][acct], true);
    } catch (e) { failNote('subusage.load', e); }   // an unreadable file: start empty — a cache of what providers said, never the only copy of anything
  }
  let timer = null, dirty = false;
  function persist() {
    timer = null;
    if (!dirty || !deps) return;
    dirty = false;
    try { deps.fs.mkdirSync(deps.path.dirname(o.file), { recursive: true }); writeJsonResilient(deps, o.file, { v: 1, providers: snapshot() }); } catch (e) { dirty = true; failNote('subusage.save', e); }
  }
  function put(pid, acct, entry, loading) {
    if (!entry || !Array.isArray(entry.windows)) return;
    if (!store.has(pid)) store.set(pid, new Map());
    store.get(pid).set(acctKey(acct), entry);
    if (loading || !deps) return;
    dirty = true;
    if (!timer) { timer = setTimeout(persist, saveMs); if (timer.unref) timer.unref(); }
  }

  function observeClaude(account, info) {
    if (!info || typeof info !== 'object') return;
    const windows = [];
    const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
    if (uw) {
      for (const id of Object.keys(uw)) {
        const w = uw[id] || {};
        const u = num(w.utilization);
        windows.push({ id, label: LABELS[id] || id.replace(/_/g, ' '), usedPct: u == null ? null : Math.round(u * 1000) / 10, resetsAt: toMs(w.resetsAt), status: String(w.status || '') });
      }
    } else if (info.rateLimitType) {
      windows.push({ id: String(info.rateLimitType), label: LABELS[info.rateLimitType] || String(info.rateLimitType).replace(/_/g, ' '), usedPct: null, resetsAt: toMs(info.resetsAt), status: String(info.status || '') });
    }
    if (!windows.length) return;
    const entry = { windows, seenAt: now() };
    if (info.overageStatus) entry.overage = { status: String(info.overageStatus), using: !!info.isUsingOverage, why: String(info.overageDisabledReason || '') };
    put('claude-cli', account, entry);
  }

  function observeHeaders(providerId, account, h) {
    const windows = [];
    for (const slot of ['primary', 'secondary']) {
      const used = num(header(h, 'x-codex-' + slot + '-used-percent'));
      const mins = num(header(h, 'x-codex-' + slot + '-window-minutes'));
      if (used == null && mins == null) continue;
      const resetAt = toMs(header(h, 'x-codex-' + slot + '-reset-at'));
      const after = num(header(h, 'x-codex-' + slot + '-reset-after-seconds'));
      windows.push({ id: slot, label: mins != null ? windowLabel(mins) : slot, usedPct: used, resetsAt: resetAt != null ? resetAt : after != null ? now() + after * 1000 : null, status: '' });
    }
    if (!windows.length) return;
    const entry = { windows, seenAt: now() };
    const has = header(h, 'x-codex-credits-has-credits'), unl = header(h, 'x-codex-credits-unlimited'), bal = header(h, 'x-codex-credits-balance');
    if (has != null || unl != null || bal != null) entry.credits = { has: String(has) === 'true', unlimited: String(unl) === 'true', balance: num(bal) };
    put(providerId, account, entry);
  }

  function wrapFetch(providerId, account, fetchImpl) {
    if (typeof fetchImpl !== 'function') return fetchImpl;
    return async function (...args) {
      const res = await fetchImpl(...args);
      try { if (res && res.headers) observeHeaders(providerId, account, res.headers); } catch (e) { failNote('subusage.headers', e); }   // reading headers never fails a call
      return res;
    };
  }

  function get(pid, account) { const m = store.get(pid); return (m && m.get(acctKey(account))) || null; }
  function snapshot() {
    const out = {};
    for (const [pid, m] of store) { out[pid] = {}; for (const [a, e] of m) out[pid][a] = e; }
    return out;
  }
  function flush() { if (timer) { clearTimeout(timer); timer = null; } persist(); }
  return { observeClaude, observeHeaders, wrapFetch, get, snapshot, flush };
}

module.exports = { makeSubUsage, windowLabel };
