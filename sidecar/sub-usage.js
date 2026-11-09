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
     get(providerId, account) -> entry | null    { windows: [{ id, label, usedPct|null, resetsAt|null, status, minutes|null }], credits?, seenAt }
                                                  (minutes: the window's length — where it opened is resetsAt minus it)
     snapshot() -> { [providerId]: { [account]: entry } }
     flush()
   }
   Persisted (file) so "as of the last run" survives a restart: written at most every saveMs, through the resilient
   JSON writer (durable + last-known-good). No credential is ever in it — numbers and times only. */
'use strict';

const { readJsonResilient, writeJsonResilient } = require('./durable-store.js');
const { note: failNote } = require('./failopen.js');

const LABELS = { five_hour: '5-hour', seven_day: 'week', seven_day_opus: 'week · Opus', seven_day_sonnet: 'week · Sonnet' };
// each Claude window's LENGTH, by its id (the stream names a window, not its length): where a window opened = resetsAt
// minus this. ChatGPT says its own length in a header. Unknown = null, never guessed.
const MINUTES = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080 };
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

/* THE PHANTOM WINDOW (cost audit 2026-11-08). For an account with one window, ChatGPT still sends the secondary
   headers, zero-valued: 0% used, a 0-minute length, a reset 0 seconds away. Codex's own client reads that as no window
   (secondary: null); this store kept it as a "0-minute" window that reset the moment it was seen, and the terminal's
   /usage printed "0-minute reset since". A slot is a window only when it says something: some use, a real length, or a
   reset still ahead. An entry saved before this rule loses its 0-minute window when it is loaded. */
function isPhantom(w) { return !!w && (w.minutes === 0 || w.label === '0-minute'); }
function withoutPhantoms(entry) {
  if (!entry || !Array.isArray(entry.windows) || !entry.windows.some(isPhantom)) return entry;
  const windows = entry.windows.filter(w => !isPhantom(w));
  return windows.length ? Object.assign({}, entry, { windows }) : null;
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
      if (v && typeof v === 'object') for (const pid of Object.keys(v)) for (const acct of Object.keys(v[pid] || {})) put(pid, acct, withoutPhantoms(v[pid][acct]), true);
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
        windows.push({ id, label: LABELS[id] || id.replace(/_/g, ' '), usedPct: u == null ? null : Math.round(u * 1000) / 10, resetsAt: toMs(w.resetsAt), status: String(w.status || ''), minutes: MINUTES[id] || null });
      }
    } else if (info.rateLimitType) {
      const id = String(info.rateLimitType);
      windows.push({ id, label: LABELS[id] || id.replace(/_/g, ' '), usedPct: null, resetsAt: toMs(info.resetsAt), status: String(info.status || ''), minutes: MINUTES[id] || null });
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
      const length = mins != null && mins > 0 ? mins : null;   // a 0-minute window is no window length at all
      const resetsAt = resetAt != null ? resetAt : after != null ? now() + after * 1000 : null;
      if (!(used || length || (resetsAt != null && resetsAt > now()))) continue;   // the zero-valued phantom: no window (see isPhantom)
      windows.push({ id: slot, label: length != null ? windowLabel(length) : slot, usedPct: used, resetsAt, status: '', minutes: length });
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

// where a provider's reading comes from — the two observers above, by the provider that said it. A hold that cites a
// reading names this source with it (W3.1, unattended-admission.js).
function readingSource(providerId) {
  return providerId === 'claude-cli' ? 'Claude Code rate_limit_event' : 'x-codex-* response headers';
}

module.exports = { makeSubUsage, windowLabel, readingSource };
