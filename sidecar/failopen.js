'use strict';
/* failopen.js — the ONE way to swallow an error on a fire-and-forget seam.

   Why this exists: reflection was silently dead on trunk for weeks because its caller's bare
   empty catch handler hid a 100% failure rate (see the runReflection note in index.js). A background
   pass is ALLOWED to fail — it must never hurt the run — but it is not allowed to fail invisibly.
   `swallow(tag)` keeps the fail-open contract (never rethrows, never blocks) while leaving a trace:
   a tagged console.warn plus a per-tag counter that tests and diagnostics can read. A liveness test
   can now prove an envelope fires by rejecting into it and reading counts().

   Usage:  somePass().catch(swallow('aux.reflection.envelope'))
           await store.claim(id).catch(swallow('workshop.claim', null))   // value-default form

   Warn throttle: the first WARN_EVERY_HEAD hits per tag always warn (a one-off failure is fully
   visible), then every WARN_EVERY_TAILth — so a 60s maintenance loop that breaks permanently keeps
   saying so without drowning the log. The counter always increments. */

const { redact } = require('./context.js');

const WARN_EVERY_HEAD = 5;
const WARN_EVERY_TAIL = 50;

const tally = new Map();   // tag -> { n, firstAt, lastAt } since boot
const MAX_TAGS = 64;       // summary() bound — a hostile/dynamic tag explosion must not grow a diagnostics report unboundedly

// Injected clock (lint-determinism: backend logic never reads ambient time). The composition root calls
// setClock(Date.now) at boot; until then first/last-seen stamps are null — counts are never affected.
let clock = null;
function setClock(fn) { clock = typeof fn === 'function' ? fn : null; }
function stamp() { try { const t = clock ? Number(clock()) : NaN; return Number.isFinite(t) ? t : null; } catch (_) { return null; } }

function swallow(tag, rv) {
  const t = redact(String(tag || 'untagged')).slice(0, 80);
  return (e) => {
    const now = stamp();
    let row = tally.get(t);
    if (!row) { row = { n: 0, firstAt: now, lastAt: now }; tally.set(t, row); }
    row.n += 1; if (now !== null) { row.lastAt = now; if (row.firstAt === null) row.firstAt = now; }
    const n = row.n;
    if (n <= WARN_EVERY_HEAD || n % WARN_EVERY_TAIL === 0) {
      try { console.warn('[failopen] ' + t + ' (x' + n + '):', redact(String((e && e.message) || e))); } catch (_) {}
    }
    return rv;
  };
}

/* note(tag, err) — the SYNC counterpart for `try { ... } catch (e) { note('tag', e); }`.
   Same contract as swallow: never throws, same throttled warn, same per-tag tally, same counts() snapshot —
   so a silent sync catch becomes provable the same way (trip the body, read counts()). Returns undefined.
   Use it wherever an empty `catch (_) {}` hides a failure someone would want to know about; a catch whose
   silence is the DESIGN (value default, best-effort teardown, self-re-arming retry) may stay bare. */
function note(tag, err) { return swallow(tag)(err); }

// read-only copy for tests / diagnostics; never expose the live Map (a caller clearing it would blind the trace)
function counts() { const o = {}; for (const [k, v] of tally) o[k] = v.n; return o; }

/* Bounded, secret-free pressure summary for /api/diagnostics + station.inspect (2026-08-21). Tags are static
   code literals (never user text, never paths); timestamps are epoch ms. Sorted by count desc so the loudest
   seam leads; capped at MAX_TAGS with `truncated` set honestly when more exist. Fresh objects every call —
   mutating the result cannot blind the trace. */
function summary() {
  const rows = [];
  let total = 0;
  for (const [tag, v] of tally) { total += v.n; rows.push({ tag, count: v.n, firstAt: v.firstAt, lastAt: v.lastAt }); }
  rows.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { total, tagCount: rows.length, truncated: rows.length > MAX_TAGS, tags: rows.slice(0, MAX_TAGS) };
}
function resetForTests() { tally.clear(); }

module.exports = { swallow, note, counts, summary, setClock, resetForTests };
