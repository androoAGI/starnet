/* sidecar/usage-receipts.js — USAGE RECEIPTS: one record per model call (W1.1, cost audit 2026-11-08).

   StarNet could not prove what it spent. A run row keeps total tokens and cache reads; per call nothing was kept, cache
   writes never left cost.js, and a subscription's window readings kept only the latest value. So nobody — not the
   user, not an audit — could tell which calls drained a plan window, or which harness did. This is the receipt:

     { v:1, at, ms, provider, account, model, runId?,          model: as it ran (the provider's served model, else the asked one)
       uncachedIn, cacheRead, cacheWrite, out, reasoning,      the call's own usage, through cost.resolveUsage
       cacheWrite5m?, cacheWrite1h?,                           the write's split by cache tier, only when the provider
                                                               reported one that adds up (W1.13: Anthropic, Claude Code)
       usageMissing?: true,                                    no usage ever arrived: the counts are UNKNOWN, never 0
       end: 'done' | 'stopped' | 'error', status?,             how the call ended (an HTTP status, never error text)
       origin?, ref?, start?,                                  W3.1: who started the run this call belongs to, when it was
                                                               unattended work ('nightshift' | 'routine' | 'loop' | 'workshop'),
                                                               which beat/routine/loop (ref) and which start of it (start): the
                                                               unattended rail counts these (unattended-admission.js). Absent
                                                               on everything a person started.
       child?, replay?, replayed?, replayNotes?,               W3.7, Claude Code only: how the call was served (claude-cli.js HOW A
                                                               CALL WAS SERVED). child = 'reuse' (the run's live child took only what
                                                               was new), a fresh child and why ('first', 'warm', 'run', 'history',
                                                               'reply', 'tools', 'model', 'effort', 'system', 'dead', 'empty') or
                                                               'oneshot'. With STARNET_CLI_REPLAY_LEDGER on: replay = the ledger's
                                                               verdict, replayed = the history entries sent as the last run sent
                                                               them, replayNotes = the characters of past notes among them. Beside
                                                               cacheRead / cacheWrite this is what a message's first call cost, and why.
       window?: { seenAt, windows: [{ id, usedPct, resetsAt, minutes, status? }] } }   the plan-window reading this call saw

   Counts and identifiers only: never a word of the prompt, the reply, or an error message.

   ONE SEAM. The provider factory wraps every adapter it builds (providers/factory.js attachUsageReceipts): runs,
   fallbacks, extra sign-ins, aux one-shots, compaction, vision, probes all stream through wrap(), so a seventh
   adapter cannot forget. test/usage-receipts.invariant.test.js locks that no production code builds an adapter
   anywhere else.

   ONE CALL, ONE RECEIPT. The loop keeps the LAST usage event of a call (adapters report cumulative usage), so the
   receipt does too, and is written once, when the call's stream closes — finished, stopped by its reader, or thrown.
   A stream that never produced an event and never threw never reached a provider: no receipt.

   THE WINDOW READING. A subscription says its windows on every call (sub-usage.js: Claude Code's rate_limit_event,
   ChatGPT's x-codex-* headers). The receipt carries the sign-in's reading only when it was seen during this call
   (seenAt at or after the call began): a reading from before the call is not what this call saw.

   FILE. WORKSPACES/.usage/calls.jsonl, beside subscriptions.json in the dotted .usage root (out of every agent's file
   jail), appended through logbound's durable append and rolled to calls.jsonl.1 past maxBytes (disk bounded to about
   twice that). Never read at boot or by history: it is read on demand, by GET /api/usage/providers and by the unattended
   hold (W3.1: index.js unattendedRecords reads it once, at the first check, then onRecord feeds it each new receipt). A
   write that fails is noted and the call goes on: a receipt never breaks a call.

   WHO STARTED IT (W3.1). `scope()` is read when a call STARTS: the host's AsyncLocalStorage around every unattended start
   ({ origin, ref, start }), so a call that start makes — its line hops, workers and reviews included — carries its origin.
   A background pass that follows it runs outside the scope (index.js automaticAux: it keeps its own ceiling). `onRecord(rec)` sees each receipt after it is written (the host's unattended tally).

   makeUsageReceipts({ file?, fs?, path?, clock, readings?, maxBytes?, note?, scope?, onRecord? }) -> {
     wrap(provider, { provider, account }) -> provider   the factory's seam; marks the result [RECEIPTED]
     records() -> receipt[]                             oldest first (the rotated pair, or the in-memory list without a file)
     clear()                                            the in-memory list only (tests)
     windowShare(subscriptions, now) -> { [providerId]: { [account]: { [windowId]: share } } }
       share = { from, tokens, cacheRead, calls, since }: StarNet's own booked tokens on that sign-in since the window
       opened (from = resetsAt - its length). since > from means the receipts begin after the window opened (first
       install, or rotated away): the tokens are a floor, and the reader must say "since <since>". No receipt at all:
       since is null. Never a percentage of the window: the window's % is the provider's word for EVERY client on it.
   }
   Pure apart from the injected fs/clock (lint-determinism). */
'use strict';

const { resolveUsage } = require('./cost.js');
const { appendJsonlDurable, rotateIfLarge, tailLines } = require('./logbound.js');
const { note: failNote } = require('./failopen.js');

const RECEIPTED = Symbol.for('starnet.usageReceipted');
const MEMORY_MAX = 2000;
// a Claude window's length by its id (the stream names the window, not its length); ChatGPT says its own in a header
const KNOWN_MINUTES = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080 };
const acctKey = a => (!a || a === 'primary') ? 'primary' : String(a);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const ident = (v, max) => String(v).replace(/[^\x21-\x7e]/g, '').slice(0, max);   // an id or a model name: printable, bounded

// a window's length in minutes: as said (ChatGPT's header), else by its id (Claude), else by the label sub-usage gave it
function minutesOf(w) {
  if (!w) return null;
  if (isNum(w.minutes) && w.minutes > 0) return w.minutes;
  if (KNOWN_MINUTES[w.id]) return KNOWN_MINUTES[w.id];
  const l = String(w.label || '');
  if (l === '5-hour') return 300;
  if (l === 'week') return 10080;
  const m = l.match(/^(\d+)-(day|hour)$/);
  return m && Number(m[1]) > 0 ? Number(m[1]) * (m[2] === 'day' ? 1440 : 60) : null;
}

function makeUsageReceipts(opts) {
  const o = opts || {};
  const now = (o.clock && typeof o.clock.now === 'function') ? () => o.clock.now() : () => 0;
  const note = typeof o.note === 'function' ? o.note : failNote;
  const maxBytes = isNum(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : 4 * 1024 * 1024;
  const readings = (o.readings && typeof o.readings.get === 'function') ? o.readings : null;
  const scopeOf = typeof o.scope === 'function' ? o.scope : null;
  const onRecord = typeof o.onRecord === 'function' ? o.onRecord : null;
  const file = o.file || '';
  const deps = file ? { fs: o.fs || require('fs'), path: o.path || require('path') } : null;
  const memory = [];
  let dirReady = false;

  function append(rec) {
    if (!deps) { memory.push(rec); if (memory.length > MEMORY_MAX) memory.splice(0, memory.length - MEMORY_MAX); return; }
    try {
      if (!dirReady) { deps.fs.mkdirSync(deps.path.dirname(file), { recursive: true }); dirReady = true; }
      appendJsonlDurable({ fs: deps.fs, note }, file, rec);
      rotateIfLarge({ fs: deps.fs }, file, maxBytes);
    } catch (e) { note('usage-receipts.append', e); }   // a receipt never breaks a call
  }

  // the sign-in's window reading, if it was seen during this call
  function windowSeen(pid, acct, since) {
    if (!readings) return null;
    let e = null;
    try { e = readings.get(pid, acct); } catch (err) { note('usage-receipts.reading', err); return null; }
    if (!e || !Array.isArray(e.windows) || !e.windows.length || !isNum(e.seenAt) || e.seenAt < since) return null;
    return { seenAt: e.seenAt, windows: e.windows.map(w => {
      const out = { id: String(w.id), usedPct: isNum(w.usedPct) ? w.usedPct : null, resetsAt: isNum(w.resetsAt) ? w.resetsAt : null, minutes: minutesOf(w) };
      if (w.status) out.status = String(w.status);
      return out;
    }) };
  }

  // who started the run this call belongs to, read when the call starts (never text: three bounded identifiers)
  function originNow() {
    if (!scopeOf) return null;
    let sc = null;
    try { sc = scopeOf(); } catch (e) { note('usage-receipts.scope', e); return null; }
    if (!sc || !sc.origin) return null;
    const out = { origin: ident(sc.origin, 40) };
    if (sc.ref != null && String(sc.ref)) out.ref = ident(sc.ref, 128);
    if (sc.start != null && String(sc.start)) out.start = ident(sc.start, 128);
    return out;
  }

  // model: the model as it ran — the one the provider said served the call (a usage event's `model`: claude-cli names what
  // an alias such as `haiku` resolved to), else the one the request asked for (W3.5)
  function receipt(meta, req, startedAt, usage, end, status, served, who, cli) {
    const at = now();
    const asked = req && req.model != null ? req.model : '';
    const rec = { v: 1, at, ms: Math.max(0, at - startedAt), provider: meta.pid, account: meta.acct, model: ident(served || asked, 200) };
    if (req && req.runId != null && String(req.runId)) rec.runId = ident(req.runId, 128);
    const c = resolveUsage(usage);
    if (c) Object.assign(rec, c);
    else rec.usageMissing = true;
    rec.end = end;
    if (end === 'error' && Number.isInteger(status)) rec.status = status;
    const w = windowSeen(meta.pid, meta.acct, startedAt);
    if (w) rec.window = w;
    if (who) Object.assign(rec, who);
    // how a Claude Code call was served (a usage event's `cli`): bounded identifiers and whole counts, nothing else
    if (cli && typeof cli === 'object') {
      if (cli.start != null && String(cli.start)) rec.child = ident(cli.start, 24);
      if (cli.replay != null && String(cli.replay)) rec.replay = ident(cli.replay, 24);
      if (Number.isInteger(cli.replayed) && cli.replayed > 0) rec.replayed = cli.replayed;
      if (Number.isInteger(cli.replayNotes) && cli.replayNotes >= 0 && rec.replayed) rec.replayNotes = cli.replayNotes;
    }
    return rec;
  }

  async function* receipted(iterable, req, meta, startedAt, who) {
    let usage = null, events = 0, sawDone = false, threw = false, status = null, served = '', cli = null;
    try {
      for await (const ev of iterable) {
        events++;
        if (ev && ev.type === 'usage' && ev.usage) { usage = ev.usage; if (typeof ev.model === 'string' && ev.model) served = ev.model; if (ev.cli) cli = ev.cli; }   // cumulative: the last one is the call's
        else if (ev && ev.type === 'done') sawDone = true;
        yield ev;
      }
    } catch (e) {
      threw = true;
      status = e && Number.isInteger(e.status) ? e.status : null;
      throw e;
    } finally {
      if (usage || events > 0 || threw) {
        let rec = null;
        try { rec = receipt(meta, req, startedAt, usage, threw ? 'error' : sawDone ? 'done' : 'stopped', status, served, who, cli); append(rec); }
        catch (e) { note('usage-receipts.record', e); rec = null; }
        if (rec && onRecord) { try { onRecord(rec); } catch (e) { note('usage-receipts.onRecord', e); } }
      }
    }
  }

  function wrap(provider, meta) {
    if (!provider || typeof provider.stream !== 'function' || provider[RECEIPTED]) return provider;
    const m = { pid: String((meta && meta.provider) || ''), acct: acctKey(meta && meta.account) };
    const inner = provider.stream;
    const out = Object.assign({}, provider, {
      stream(req) {
        const startedAt = now();
        return receipted(inner.call(provider, req), req, m, startedAt, originNow());
      }
    });
    out[RECEIPTED] = true;
    return out;
  }

  // A line that is not whole JSON (a crash mid-append leaves one; the next append starts a fresh line) is skipped,
  // and the read says so once: a lost receipt is never silent.
  function parse(lines) {
    const out = [];
    let torn = 0;
    for (const l of lines) {
      let r = null;
      try { r = JSON.parse(l); } catch (_) { torn += 1; continue; }
      if (r && r.v === 1 && isNum(r.at)) out.push(r);
    }
    if (torn) note('usage-receipts.torn', new Error(torn + ' unreadable receipt line(s) skipped'));
    return out;
  }
  function records() {
    if (!deps) return memory.slice();
    try {
      const cap = maxBytes * 2;   // a live segment is at most maxBytes plus the one row that rolled it
      return parse(tailLines({ fs: deps.fs }, file + '.1', cap)).concat(parse(tailLines({ fs: deps.fs }, file, cap)));
    } catch (e) { note('usage-receipts.read', e); return []; }
  }
  function clear() { memory.length = 0; }

  function windowShare(subscriptions, at) {
    const out = {};
    const subs = subscriptions && typeof subscriptions === 'object' ? subscriptions : {};
    const t = isNum(at) ? at : now();
    let recs = null;
    for (const pid of Object.keys(subs)) {
      for (const acct of Object.keys(subs[pid] || {})) {
        const entry = subs[pid][acct];
        if (!entry || !Array.isArray(entry.windows)) continue;
        for (const w of entry.windows) {
          const mins = minutesOf(w);
          if (!mins || !isNum(w.resetsAt) || w.resetsAt <= t) continue;   // no known length, or the window has reset since: no start to count from
          const from = w.resetsAt - mins * 60000;
          if (from > t) continue;
          if (!recs) recs = records();
          const since = recs.length ? Math.max(from, recs[0].at) : null;
          let tokens = 0, cacheRead = 0, calls = 0;
          for (const r of recs) {
            if (r.provider !== pid || r.account !== acctKey(acct) || r.at < from || r.at > t || r.usageMissing) continue;
            tokens += (r.uncachedIn || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.out || 0);
            cacheRead += r.cacheRead || 0;
            calls++;
          }
          ((out[pid] = out[pid] || {})[acct] = out[pid][acct] || {})[w.id] = { from, tokens, cacheRead, calls, since };
        }
      }
    }
    return out;
  }

  return { wrap, records, clear, windowShare };
}

module.exports = { makeUsageReceipts, RECEIPTED, minutesOf };
