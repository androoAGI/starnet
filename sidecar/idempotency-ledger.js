/* sidecar/idempotency-ledger.js — the durable IDEMPOTENCY ledger for external connector WRITES (2026-08-21).

   THE GAP. A run that re-attempts the same work item — a crash-resumed run, a retried scheduled tick, a model that
   repeats a tool call after a transient timeout — re-executes every connector mutation it already performed: the
   invoice is emailed twice, the row is appended twice, the calendar event is created twice. Nothing at the
   connector-write seam remembered that the exact write already SUCCEEDED. The crash-recovery replay barrier
   (run-recovery.js) only blocks fingerprints an operator reviewed; the run journal records intent/result but never
   suppresses a second execution (see run-journal.js: "an intent without a durable result is never replayed").

   THE RULE. Every SUCCESSFUL mutate-role connector call is recorded under
       key = sha256( scope + '\n' + replayFingerprint(toolName, canonicalArgs) )
   and a later call with the SAME key inside the same scope is NOT re-sent: the host returns the recorded result,
   plainly labelled as an idempotent replay, so the model sees what already happened and carries on. Scope is the
   WORK ITEM, never the whole station:
       'cron:<jobId>:<scheduledFor>'  — one scheduled tick (a retry/resume of that tick dedupes; the next tick does not)
       'run:<sourceRunId>'            — a crash-resumed run shares its source run's scope
       'run:<runId>'                  — otherwise the run itself (in-run repeats)
   Only byte-identical writes dedupe (after canonical arg ordering); a write that differs in any argument is a
   different write and executes. Only SUCCESSES are recorded — a failed write changed nothing to protect.

   Honesty: a replay is visible in the tool result ('[idempotent replay]' + summary 'idempotent-replay'), in the
   agent.tool_result telemetry, and in the ledger file — never a silent no-op.

   UNCERTAIN WRITES (h1 audit 2026-09-22). "Only successes" left one hole: a write that TIMED OUT (or was cancelled
   after it was sent) may have landed remotely, yet nothing was recorded — so the model's retry (which the failure-
   recovery nudge encourages) sent it a second time (probe: mcp__crm__create_invoice timed out, the invoice existed,
   the retry created another). The host records such a call as status 'uncertain' under the SAME key, and an
   identical retry in the same scope is HELD (heldResult: not sent, isError, summary 'held-uncertain') until the
   model has made a successful read/observe call on that connector (noteObserved stamps verifiedAt) — verify first,
   then retry only what is really missing. A success recorded later replaces the uncertain row; differing args are a
   different key and are never held; read calls are never recorded.

   Pure + injected-I/O (fs/path/clock), determinism-clean, node-testable against an in-memory fs. The Node host
   composes it with the real fs and the shared durable-store primitives exactly like its sibling stores.

   makeIdempotencyLedger({ fs, path, workspaces, clock, writeDurable?, classify?, onRecover?, onCorrupt?, ttlMs?, maxRows? })
     -> { scopeFor(o), keyFor(scope, name, argsRaw), isWrite(name), isObserve(name), connectorOf(name),
          lookup(key, now?) -> entry|null   (entry.status === 'uncertain' for a held write; verifiedAt once released),
          record(key, entry) -> Promise, recordUncertain(key, entry) -> Promise, noteObserved(scope, connector) -> Promise<n>,
          replayResult(entry) -> tool result, heldResult(entry) -> tool result, size(), file } */
'use strict';

const crypto = require('crypto');
const { makeDurableJsonStore } = require('./durable-store.js');
const { replayFingerprint } = require('./run-recovery.js');

const FILE = 'connector-writes.ledger.json';
const KEY = 'ledger';
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;   // a work item older than a week is not the same work item
const DEFAULT_MAX_ROWS = 2000;                  // bounded: oldest rows fall off first
const CONTENT_MAX = 4000;                       // the replayed result body the model sees (clamped, not the full payload)

// the default classifier: a custom-connector tool (mcp__<connector>__<tool>) whose leaf verb does not read like an
// observation. Mirrors loop.js's verify-on-stop classifier; the host injects that exact function so the two never
// drift (loop._internals.vosExternalRole). Unknown verbs lean conservative — treated as writes.
const OBSERVE_RE = /(^|_)(verify|verification|check|confirm|read|get|list|fetch|status|inspect|search|show|lookup|query|describe|retrieve)(_|$)/i;
function defaultClassify(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  if (!/^mcp__.+__.+$/.test(n)) return '';
  const leaf = n.slice(n.lastIndexOf('__') + 2);
  return OBSERVE_RE.test(leaf) ? 'observe' : 'mutate';
}

// Execution is still consequential for consent/recovery, but its result is not a
// durable write receipt: the same command must run again after its inputs change.
// Keep this separate from the mutation classifier (never relabel execution as a read).
function isCommandExecution(name) {
  const n = String(name || '').toLowerCase();
  if (!/^mcp__.+__.+$/.test(n)) return false;
  const leaf = n.slice(n.lastIndexOf('__') + 2);
  if (/^(create|send|append|delete|update|write|publish|remove|submit|transfer)_/.test(leaf)) return false;
  return /(^|_)(run_command|execute_command|exec_command|shell_exec|terminal_exec|execute_code|run_code)$/.test(leaf)
    || /^(exec|execute|terminal|shell)$/.test(leaf);
}

function connectorOf(name) {
  const n = String(name == null ? '' : name);
  const m = /^mcp__(.+)__[^_].*$/.exec(n);
  if (!m) return '';
  // the connector id is everything between the first and LAST '__'
  const split = n.lastIndexOf('__');
  return n.slice(5, split);
}

// the WORK-ITEM scope for a run (see header). Explicit wins (cron stamps its tick); a recovered run inherits its
// source run's scope; otherwise the run itself. Never the COMMS stream / taskKey — a stream lives for days and a
// later, intentional repeat of the same write on it is a different work item.
// A recovered run inherits the scope its SOURCE ran under (recovery.idempotencyScope — the host reads it from the source's
// journal, never from a request): a routine's run is scoped 'cron:<job>:<fire>', so its continuation looking under
// 'run:<source>' never found the writes the source already made (review of quick win 31). A journal from before the
// scope was recorded carries none, and falls back to the source run, as before.
function scopeFor(o) {
  o = o || {};
  if (o.idempotencyScope != null && String(o.idempotencyScope).trim()) return String(o.idempotencyScope).trim().slice(0, 200);
  if (o.recovery && o.recovery.sourceRunId) {
    const inherited = o.recovery.idempotencyScope != null ? String(o.recovery.idempotencyScope).trim() : '';
    return inherited ? inherited.slice(0, 200) : 'run:' + String(o.recovery.sourceRunId);
  }
  return o.runId ? 'run:' + String(o.runId) : '';
}

function keyFor(scope, name, argsRaw) {
  return crypto.createHash('sha256').update(String(scope || '') + '\n' + replayFingerprint(name, argsRaw)).digest('hex');
}

function makeIdempotencyLedger(deps) {
  deps = deps || {};
  const fs = deps.fs, path = deps.path;
  if (!fs || !path || !deps.workspaces) throw new Error('idempotency-ledger: fs, path and workspaces are required');
  // injected clock (lint-determinism: no ambient Date.now in sidecar modules); the host passes the real one.
  if (typeof deps.clock !== 'function') throw new Error('idempotency-ledger: an injected clock() is required');
  const clock = deps.clock;
  const classify = typeof deps.classify === 'function' ? deps.classify : defaultClassify;
  const ttlMs = Number(deps.ttlMs) > 0 ? Number(deps.ttlMs) : DEFAULT_TTL_MS;
  const maxRows = Number(deps.maxRows) > 0 ? Math.floor(Number(deps.maxRows)) : DEFAULT_MAX_ROWS;
  const file = path.join(deps.workspaces, FILE);
  const durable = makeDurableJsonStore({
    fs, path, fileFor: () => file, writeDurable: deps.writeDurable,
    onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });

  function state() {
    const s = durable.get(KEY);
    return (s && typeof s === 'object' && s.rows && typeof s.rows === 'object') ? s : { v: 1, rows: {} };
  }
  function prune(s, now) {
    const keys = Object.keys(s.rows);
    for (const k of keys) { const e = s.rows[k]; if (!e || !(now - Number(e.at || 0) < ttlMs)) delete s.rows[k]; }
    const left = Object.keys(s.rows);
    if (left.length > maxRows) {
      left.sort((a, b) => Number(s.rows[a].at || 0) - Number(s.rows[b].at || 0));
      for (let i = 0; i < left.length - maxRows; i++) delete s.rows[left[i]];
    }
    return s;
  }

  function isWrite(name) { return !isCommandExecution(name) && classify(name) === 'mutate'; }
  // an observation/read-back on a connector — the evidence that releases a held uncertain write on that connector
  function isObserve(name) { return classify(name) === 'observe'; }

  function lookup(key, now) {
    const s = state();
    const e = s.rows[String(key)];
    if (!e) return null;
    const t = now == null ? clock() : now;
    if (!(t - Number(e.at || 0) < ttlMs)) return null;   // expired: the work item is over
    return Object.assign({}, e);
  }

  // record a SUCCESSFUL write. Serialized per store key; re-reads inside the lock (durable-store discipline).
  function record(key, entry) {
    const now = clock();
    const row = {
      at: now,
      scope: String(entry && entry.scope || ''),
      runId: String(entry && entry.runId || ''),
      tool: String(entry && entry.tool || ''),
      connector: String(entry && entry.connector || connectorOf(entry && entry.tool)),
      summary: String(entry && entry.summary || '').slice(0, 200),
      content: String(entry && entry.content == null ? '' : entry.content).slice(0, CONTENT_MAX)
    };
    // absent status = a SUCCESS (every row written before 2026-09-22 reads exactly as it did)
    if (entry && entry.status === 'uncertain') row.status = 'uncertain';
    return durable.update(KEY, cur => {
      const s = (cur && typeof cur === 'object' && cur.rows && typeof cur.rows === 'object') ? cur : { v: 1, rows: {} };
      s.rows[String(key)] = row;
      return prune(s, now);
    });
  }

  // record a write whose outcome is UNKNOWN (timed out / cancelled after it was sent). Same key, same row shape.
  function recordUncertain(key, entry) {
    return record(key, Object.assign({}, entry || {}, { status: 'uncertain' }));
  }

  // A successful read/observe call on that connector inside that scope is the verification a held write asks for: stamp
  // every still-held uncertain row of that connector+scope so ONE identical retry may go out. No held row = no write.
  function noteObserved(scope, connector) {
    scope = String(scope || ''); connector = String(connector || '');
    if (!scope || !connector) return Promise.resolve(0);
    const held = (s) => Object.keys(s.rows).filter(k => {
      const e = s.rows[k];
      return e && e.status === 'uncertain' && !e.verifiedAt && e.scope === scope && e.connector === connector;
    });
    if (!held(state()).length) return Promise.resolve(0);
    const now = clock();
    let n = 0;
    return durable.update(KEY, cur => {
      const s = (cur && typeof cur === 'object' && cur.rows && typeof cur.rows === 'object') ? cur : null;
      if (!s) return undefined;
      const keys = held(s);
      if (!keys.length) return undefined;
      for (const k of keys) s.rows[k] = Object.assign({}, s.rows[k], { verifiedAt: now });
      n = keys.length;
      return s;
    }).then(() => n);
  }

  // the synthetic tool result the host returns INSTEAD of re-executing. ok:true because the effect DID happen
  // (earlier); the label + summary make the replay unmistakable to the model, the telemetry and a human reader.
  function replayResult(entry) {
    const when = entry && entry.at ? new Date(Number(entry.at)).toISOString() : 'earlier';
    const body = entry && entry.content ? String(entry.content) : '';
    return {
      ok: true, isError: false, summary: 'idempotent-replay',
      content: '[idempotent replay] This exact ' + String(entry && entry.tool || 'connector') + ' write already SUCCEEDED for this work item at '
        + when + (entry && entry.runId ? ' (run ' + entry.runId + ')' : '') + '. The host did not send it again — do not retry it; '
        + 'the effect is already in place. If you genuinely need a second, different action, change its arguments.'
        + (body ? '\n\nPrior result:\n' + body : '')
    };
  }

  // the result for an identical retry of an UNCERTAIN write: NOT sent. isError because nothing executed; the text
  // names the one way forward (verify on this connector, then retry only if the effect is really missing).
  function heldResult(entry) {
    const when = entry && entry.at ? new Date(Number(entry.at)).toISOString() : 'earlier';
    const tool = String(entry && entry.tool || 'connector');
    return {
      ok: false, isError: true, summary: 'held-uncertain',
      content: '[held — effect unknown] This exact ' + tool + ' call already went out for this work item at ' + when
        + (entry && entry.runId ? ' (run ' + entry.runId + ')' : '') + ' and did not come back with a result (it timed out or was cancelled), '
        + 'so it MAY ALREADY HAVE TAKEN EFFECT. The host did NOT send it again. Verify first: use a read/list/get/search tool of the '
        + (entry && entry.connector ? '"' + entry.connector + '" ' : '') + 'connector to check whether the effect is already in place. '
        + 'If it is, do not repeat it. If your check shows it is missing, this exact call will be allowed once more after that check. '
        + 'If there is no way to check, tell the Commander the outcome is unconfirmed instead of repeating it.'
    };
  }

  /* THE DISPATCH SEAM, in one place (index.js calls exactly these two, so the unit test drives the host's real rule):
       before(scope, name, argsRaw) -> gate { scope, key, connector, observe, result }
         result non-null = return it INSTEAD of dispatching (a success replay, or a held uncertain write);
       after(gate, result, { runId, tool }) -> Promise   — AWAITED by the host before the loop advances:
         success of a write -> record; effectUnknown write -> recordUncertain; a successful observe -> noteObserved. */
  function before(scope, name, argsRaw) {
    const gate = { scope: String(scope || ''), key: null, connector: '', observe: false, result: null };
    if (!gate.scope) return gate;
    if (isWrite(name)) {
      gate.key = keyFor(gate.scope, name, argsRaw);
      const prior = lookup(gate.key);
      if (prior && prior.status === 'uncertain') { if (!prior.verifiedAt) gate.result = heldResult(prior); }
      else if (prior) gate.result = replayResult(prior);
    } else if (isObserve(name)) {
      gate.observe = true;
      gate.connector = connectorOf(name);
    }
    return gate;
  }
  async function after(gate, r, meta) {
    if (!gate || !r) return;
    meta = meta || {};
    const entry = { scope: gate.scope, runId: meta.runId, tool: meta.tool, summary: r.summary, content: r.content };
    if (gate.key && r.ok && !r.isError) await record(gate.key, entry);            // only successes protect a replay
    else if (gate.key && r.effectUnknown) await recordUncertain(gate.key, entry);  // may have landed: hold the re-send
    if (gate.observe && gate.connector && r.ok && !r.isError) await noteObserved(gate.scope, gate.connector);
  }

  function size() { return Object.keys(state().rows).length; }

  return { scopeFor, keyFor, isWrite, isObserve, connectorOf, lookup, record, recordUncertain, noteObserved, replayResult, heldResult, before, after, size, file, _internals: { state, prune, ttlMs, maxRows } };
}

module.exports = { makeIdempotencyLedger, scopeFor, keyFor, connectorOf, defaultClassify, _internals: { FILE, DEFAULT_TTL_MS, DEFAULT_MAX_ROWS, CONTENT_MAX } };
