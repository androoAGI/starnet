/* sidecar/diagnostics.js — assemble a PASTE-READY bug-report block from real harness state (T3.9).

   A public user who hits a wall needs to email a useful report without leaking a secret. This module is
   the PURE assembler: given a plain snapshot of already-collected state (index.js does the collecting from
   its live stores), it returns BOTH a structured object and a plain-text block a beginner can paste into an
   email. It performs ZERO IO and ZERO guessing.

   TWO LAWS this module exists to uphold:
   1. TRUTHFUL TELEMETRY — every field is provable from real state the caller passed in. Anything the caller
      couldn't prove is passed as null/'' and rendered as 'unknown' or omitted — never fabricated.
   2. SANITIZATION — the block must NEVER carry an API key, channel/OAuth token, transcript content, or a
      user prompt. The caller injects the always-on `redact` (sidecar/context.js) and EVERY free-text field
      (error tails especially) is run through it here as a second backstop. Structured fields are shape-only
      booleans / enums / short ids that cannot contain a secret by construction.

   makeDiagnostics({ redact }) -> { assemble(snapshot) -> { report, text } }

     snapshot (all optional; missing => 'unknown'/omitted, never invented):
       version:   { harness, app, node }
       platform:  { os, arch, node }            // os/arch from process; harmless
       mode:      'desktop' | 'browser' | ''     // provable from the request origin
       provider:  string                         // active agent's provider id
       model:     string                         // active agent's model SLUG (never a key)
       keyPresent: bool                          // is a credential configured? (bool ONLY — never the key)
       lastRun:   { runId, status, ts } | null   // newest run outcome (status = the run's reason enum)
       errors:    [{ ts, message }]              // recent error tail (messages are redacted here)
       uptimeMs:  number                         // process uptime
       workspacePresent: bool                    // does the workspaces dir exist? (bool ONLY — never the path)
       agentCount: number                        // roster size (shape only)
       swallowed: { total, tagCount, truncated, tags:[{ tag, count, firstAt, lastAt }] }   // failopen.summary()
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).diagnostics = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ERRORS = 5;        // tail length — enough to see a pattern, bounded so the block stays pasteable
  const MAX_RATE_PROVIDERS = 4; // quota rows — the fallback chain can touch several providers in one session
  const MSG_MAX = 300;         // per-error message cap after redaction
  const MAX_SWALLOWED = 24;    // fail-open tag rows — the loudest seams first; enough to see pressure, bounded so the block stays pasteable
  const IDENT = /* the fields that are shape-only by construction can still be length-clamped for readability */ 200;

  // collapse control chars + whitespace onto one clamped line (a message must not inject blank lines / smuggle
  // a fake field into the plain-text block). Mirrors runtimeinfo.oneLine's intent; kept local so this stays pure.
  function oneLine(v, max) {
    const s = (v == null ? '' : String(v)).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, max || IDENT);
  }
  function bool(v) { return v === true; }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // ms -> a compact human duration ("2h 13m", "47s") for the readout. Pure, no clock.
  function fmtUptime(ms) {
    ms = num(ms);
    if (ms <= 0) return 'unknown';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    if (!d && !h) parts.push(sec + 's');   // only show seconds for short uptimes
    return parts.join(' ') || (sec + 's');
  }

  function makeDiagnostics(opts) {
    opts = opts || {};
    // redact is REQUIRED for the sanitization law; degrade to identity only so a misuse can't crash (tests inject the real one).
    const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const redactStr = (s) => oneLine(redact(String(s == null ? '' : s)), MSG_MAX);
    // clamp AND redact any field to a single line — EVERY string field goes through this so a value the caller
    // wrongly treats as a "slug" (a poisoned provider/model) can never smuggle a secret into the block. redact()
    // is a no-op on a real slug, so honest values pass through unchanged; only key-shaped junk is scrubbed.
    const clean = (s, max) => oneLine(redact(String(s == null ? '' : s)), max);

    function assemble(snapshot) {
      const s = snapshot || {};
      const ver = s.version || {};
      const plat = s.platform || {};
      const lastRun = s.lastRun && typeof s.lastRun === 'object' ? s.lastRun : null;

      // ---- structured report (shape-only fields; free text is redacted) ----
      const report = {
        app: clean(ver.app, 40) || 'unknown',
        harness: clean(ver.harness, 40) || 'unknown',
        node: clean(ver.node || plat.node, 40) || 'unknown',
        platform: (clean(plat.os, 40) || 'unknown') + (plat.arch ? ' (' + clean(plat.arch, 20) + ')' : ''),
        mode: (s.mode === 'desktop' || s.mode === 'browser') ? s.mode : 'unknown',
        provider: clean(s.provider, 60) || 'unknown',
        model: clean(s.model, 120) || 'unknown',          // SLUG only — the caller never passes a key here; redacted anyway
        keyPresent: bool(s.keyPresent),
        buildSha: /^[a-f0-9]{40}$/.test(ver.buildSha || '') ? ver.buildSha : null,
        buildDirty: typeof ver.buildDirty === 'boolean' ? ver.buildDirty : null,
        paidAccount: (() => {
          const p = s.paidAccount;
          if (!p || typeof p !== 'object') return null;
          const choice = (value, allowed) => allowed.includes(value) ? value : 'unknown';
          const n = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
          return {
            configured: bool(p.configured),
            fingerprint: /^[a-f0-9]{16}$/.test(p.fingerprint || '') ? p.fingerprint : null,
            link: choice(p.link, ['unlinked', 'pairing', 'saved', 'recovering', 'missing', 'env']),
            credential: choice(p.credential, ['file', 'injected', 'session', 'none', 'env']),
            auth: choice(p.auth, ['absent', 'unknown', 'valid', 'invalid', 'unavailable']),
            balanceUsd: n(p.balanceUsd), observedAt: n(p.observedAt), capturedAt: n(p.capturedAt),
            balance: choice(p.balance, ['funded', 'zero', 'stale', 'unavailable', 'unknown', 'reconciling']),
            transition: p.transition ? {
              state: choice(p.transition.state, ['pairing_started', 'pairing_saved', 'unlink_requested', 'unlink_failed', 'unlinked', 'keychain_recovered']),
              at: n(p.transition.at)
            } : null
          };
        })(),
        /* PROXY VISIBILITY (2026-07-29). A user's report showed a healthy engine and five bare `fetch failed`
           entries; the sidecar could not reach the provider and we had no way to see why from the report alone.
           A configured proxy is the highest-value invisible cause, because it fails ASYMMETRICALLY and that
           asymmetry looks like a broken app: WebView2 honors the system proxy, so signing into ChatGPT works
           and the whole UI works, while the sidecar's outbound fetch does NOT route through it and dies.
           MEASURED on node v22.23: setting HTTPS_PROXY to a dead address still let fetch reach the network — i.e.
           the proxy env vars are IGNORED outright. (undici IS now a staged runtime dependency — web.js pins DNS
           with it since 2026-09-22 — but no ProxyAgent is wired, so proxies are still not honoured.)
           Shape-only + host-only by construction; see proxySnapshot() in index.js, which strips credentials
           BEFORE this ever sees the value. `configured` false means no proxy env var was set. */
        proxy: s.proxy && typeof s.proxy === 'object' ? {
          configured: bool(s.proxy.configured),
          vars: Array.isArray(s.proxy.vars) ? s.proxy.vars.slice(0, 4).map(v => clean(v, 80)) : [],
          routed: false   // never true today: the engine cannot route through a proxy (see above). Honest constant.
        } : { configured: false, vars: [], routed: false },
        agentCount: num(s.agentCount),
        uptime: fmtUptime(s.uptimeMs),
        workspacePresent: bool(s.workspacePresent),
        lastRun: lastRun ? {
          runId: clean(lastRun.runId, 80) || 'unknown',
          status: clean(lastRun.status, 40) || 'unknown',
          ts: num(lastRun.ts) || null
        } : null,
        /* OBSERVED PROVIDER QUOTA (providers/ratelimits.js). Numbers and slugs only — no header text is
           carried through, so this can never smuggle a value from a response into a pasted bug report.
           An EMPTY array means no call has been observed yet, which is not the same as "quota is fine";
           render() says so in words rather than printing an empty section that reads as an all-clear. */
        rateLimits: (Array.isArray(s.rateLimits) ? s.rateLimits : []).slice(0, MAX_RATE_PROVIDERS).map(p => ({
          provider: clean(p && p.provider, 60) || 'unknown',
          ageMs: num(p && p.ageMs),
          buckets: Object.keys((p && p.buckets) || {}).slice(0, 8).map(k => {
            const b = p.buckets[k];
            return {
              resource: clean(k, 24),
              limit: (b && b.limit != null) ? num(b.limit) : null,
              remaining: (b && b.remaining != null) ? num(b.remaining) : null,
              resetInMs: (b && b.resetInMs != null) ? num(b.resetInMs) : null
            };
          })
        })),
        errors: (Array.isArray(s.errors) ? s.errors : []).slice(-MAX_ERRORS).map(e => ({
          ts: num(e && e.ts) || null,
          runId: clean(e && e.runId, 80) || null,
          message: redactStr(e && e.message)   // SECOND redaction backstop over the caller's already-redacted tail
        })).filter(e => e.message),
        /* PROCESS FAULT (2026-09-03). An uncaught exception this process caught: health is DEGRADED (/api/health
           answers 503) and, outside the test opt-out, the process is exiting so the shell watchdog restarts it.
           null means no fault — a real measurement, not an assumption. Message is redacted like every free-text field. */
        processFault: (s.processFault && typeof s.processFault === 'object') ? {
          kind: clean(s.processFault.kind, 40) || 'uncaughtException',
          message: redactStr(s.processFault.message) || 'unknown error',
          at: num(s.processFault.at) || null,
          exiting: bool(s.processFault.exiting),
          // crash-loop breaker HELD this process (crash-ledger.js): count of fault exits inside the window
          loop: (s.processFault.loop && typeof s.processFault.loop === 'object')
            ? { count: num(s.processFault.loop.count) || 0, windowMs: num(s.processFault.loop.windowMs) || 0 } : null
        } : null,
        /* CRASH-LOOP LEDGER (2026-09-03). Fault exits recorded durably across process lives; `tripped` means this
           process is being held alive degraded instead of exiting again. Summaries are free text → redacted. */
        crashLoop: (s.crashLoop && typeof s.crashLoop === 'object') ? {
          count: num(s.crashLoop.count) || 0,
          threshold: num(s.crashLoop.threshold) || 0,
          windowMs: num(s.crashLoop.windowMs) || 0,
          tripped: bool(s.crashLoop.tripped),
          disabled: bool(s.crashLoop.disabled),
          last: (s.crashLoop.last && typeof s.crashLoop.last === 'object')
            ? { ts: num(s.crashLoop.last.ts) || null, code: num(s.crashLoop.last.code) || 0, summary: redactStr(s.crashLoop.last.summary) || '' } : null
        } : null,
        /* SWALLOWED ERRORS (2026-08-21, reliability item 1). Every fire-and-forget seam in the sidecar goes through
           failopen.swallow(tag): the pass is allowed to fail, but the failure is COUNTED. Those counters used to
           end at console.warn — a probe that misread 100% of the time for weeks (the close-zombie incident) is the
           case this section exists for: silent degradation must be a visible number in the bug report. Tags are
           static code literals (redacted anyway, never a path/secret); counts + epoch timestamps only. `present`
           false means the caller could not read the tally — rendered as "unknown", never as a reassuring zero. */
        swallowed: (() => {
          const sw = s.swallowed && typeof s.swallowed === 'object' ? s.swallowed : null;
          if (!sw) return { present: false, total: 0, tagCount: 0, truncated: false, tags: [] };
          const tags = (Array.isArray(sw.tags) ? sw.tags : []).slice(0, MAX_SWALLOWED).map(t => ({
            tag: clean(t && t.tag, 80) || 'untagged',
            count: num(t && t.count),
            firstAt: num(t && t.firstAt) || null,
            lastAt: num(t && t.lastAt) || null
          })).filter(t => t.count > 0);
          return {
            present: true,
            total: num(sw.total),
            tagCount: num(sw.tagCount) || tags.length,
            truncated: bool(sw.truncated) || (Array.isArray(sw.tags) && sw.tags.length > tags.length),
            tags: tags
          };
        })()
      };

      return { report, text: render(report) };
    }

    // ---- plain-text block: what a user pastes into a bug-report email ----
    function render(r) {
      const iso = (ts) => { try { return ts ? new Date(ts).toISOString() : ''; } catch (_) { return ''; } };
      const lines = [
        '--- Agent OS diagnostics ---',
        'App version:   ' + r.app,
        'Harness:       ' + r.harness,
        'Node:          ' + r.node,
        'Platform:      ' + r.platform,
        'Mode:          ' + r.mode,
        'Provider:      ' + r.provider,
        'Model:         ' + r.model,
        'Credential:    ' + (r.keyPresent ? 'configured' : 'none'),
        // Spelled out rather than left as a flag: whoever reads this report needs to know that a configured proxy
        // is NOT in the engine's path, because that single fact explains "the app works but chat can't connect".
        'Proxy:         ' + (r.proxy.configured
          ? (r.proxy.vars.join(', ') + ' — NOT used by the engine (its outbound calls bypass the proxy; likely cause of provider connection failures)')
          : 'none configured'),
        'Agents:        ' + r.agentCount,
        'Uptime:        ' + r.uptime,
        'Workspace dir: ' + (r.workspacePresent ? 'present' : 'missing')
      ];
      if (r.lastRun) {
        lines.push('Last run:      ' + r.lastRun.runId + ' — ' + r.lastRun.status + (r.lastRun.ts ? ' @ ' + iso(r.lastRun.ts) : ''));
      } else {
        lines.push('Last run:      none yet');
      }
      lines.push('Source commit: ' + (r.buildSha || 'unknown') + (r.buildDirty === true ? ' (dirty)' : ''));
      if (r.paidAccount) {
        const p = r.paidAccount;
        lines.push('Paid account:  ' + (p.fingerprint || 'unknown') + ' · link ' + p.link + ' · auth ' + p.auth);
        lines.push('Token source:  ' + p.credential + ' (presence only; OS durability not rechecked)');
        lines.push('Balance:       ' + p.balance + (p.balanceUsd == null ? '' : ' · $' + p.balanceUsd.toFixed(2))
          + ' · observed ' + (iso(p.observedAt) || 'unknown') + ' · captured ' + (iso(p.capturedAt) || 'unknown'));
        if (p.transition) lines.push('Link change:   ' + p.transition.state + ' @ ' + (iso(p.transition.at) || 'unknown'));
      }
      /* Quota, as last OBSERVED — the counters ride on ordinary successful responses, so this is real state
         and not a guess. "not observed yet" is printed in full rather than left blank: a blank quota section
         in a bug report reads as "quota was fine", which is a claim the harness cannot make. */
      lines.push('Provider quota (last seen):');
      if (r.rateLimits && r.rateLimits.length) {
        for (const p of r.rateLimits) {
          const age = p.ageMs ? ' (' + Math.round(p.ageMs / 1000) + 's ago)' : '';
          const cells = p.buckets.map(b => {
            const amt = (b.remaining == null) ? '?' : (b.limit ? b.remaining + '/' + b.limit : String(b.remaining));
            const rs = (b.resetInMs == null) ? '' : ', resets in ' + Math.round(b.resetInMs / 1000) + 's';
            return b.resource + ' ' + amt + rs;
          });
          lines.push('  · ' + p.provider + age + ': ' + (cells.length ? cells.join(' · ') : 'no counters'));
        }
      } else {
        lines.push('  (not observed yet — no provider call has reported quota headers this session)');
      }
      // A process fault is the loudest line in the block: it explains a 503 health probe / LINK DOWN + restart.
      if (r.processFault) {
        lines.push('Process fault: ' + r.processFault.kind + ' — ' + r.processFault.message
          + (r.processFault.at ? ' @ ' + iso(r.processFault.at) : '')
          + (r.processFault.exiting ? ' (health DEGRADED; process exiting for the shell watchdog to restart)'
            : r.processFault.loop ? ' (health DEGRADED; CRASH LOOP — ' + r.processFault.loop.count + ' fault exits in ' + Math.max(1, Math.round((r.processFault.loop.windowMs || 600000) / 60000)) + 'm, held alive instead of restarting again)'
            : ' (health DEGRADED; kept alive by test opt-out)'));
      }
      if (r.crashLoop && !r.crashLoop.disabled && r.crashLoop.count > 0) {
        lines.push('Crash-loop ledger: ' + r.crashLoop.count + ' fault exit(s) in the last ' + Math.max(1, Math.round((r.crashLoop.windowMs || 600000) / 60000)) + 'm'
          + ' (breaker trips at ' + r.crashLoop.threshold + (r.crashLoop.tripped ? '; TRIPPED)' : ')')
          + (r.crashLoop.last ? ' — last: code ' + r.crashLoop.last.code + (r.crashLoop.last.ts ? ' @ ' + iso(r.crashLoop.last.ts) : '') + ' ' + r.crashLoop.last.summary : ''));
      }
      lines.push('Recent errors:');
      if (r.errors.length) {
        for (const e of r.errors) lines.push('  · ' + (e.ts ? iso(e.ts) + ' ' : '') + (e.runId ? 'run ' + e.runId + ' · ' : '') + e.message);
      } else {
        lines.push('  (none recorded)');   // the error tail persists across restarts (diag.errors.json) — "this session" would undersell it
      }
      /* Fail-open pressure. "(none since boot)" is a real measurement (the tally exists and is zero); "unknown" means
         the tally could not be read — the two must never collapse into one reassuring line. */
      lines.push('Swallowed errors (fail-open seams, since boot):');
      if (!r.swallowed || !r.swallowed.present) {
        lines.push('  (unknown — tally not readable)');
      } else if (r.swallowed.total > 0) {
        lines.push('  total ' + r.swallowed.total + ' across ' + r.swallowed.tagCount + ' tag' + (r.swallowed.tagCount === 1 ? '' : 's'));
        for (const t of r.swallowed.tags) {
          lines.push('  · ' + t.tag + ' ×' + t.count + (t.lastAt ? ' (last ' + iso(t.lastAt) + ')' : ''));
        }
        if (r.swallowed.truncated) lines.push('  · … more tags not shown');
      } else {
        lines.push('  (none since boot)');
      }
      lines.push('--- end diagnostics — contains no keys, tokens, or message content ---');
      return lines.join('\n');
    }

    return { assemble, _internals: { render, fmtUptime, oneLine } };
  }

  /* Reduce a proxy URL to HOST[:PORT] — nothing else ever reaches a bug report. PURE, and it lives here rather
     than beside the env read in index.js precisely so it can be unit-tested: a corporate proxy URL routinely
     carries `user:password@`, and this is the ONLY thing standing between those credentials and a report the user
     pastes into an email. Strips the scheme, then everything up to and including the LAST '@' (a password may
     itself contain '@'), then any path/query. Returns '' for empty input. */
  function proxyHostOnly(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    let rest = s.replace(/^[a-z0-9+.-]+:\/\//i, '');   // scheme
    const at = rest.lastIndexOf('@');                  // LAST, not first — passwords can contain '@'
    if (at >= 0) rest = rest.slice(at + 1);
    return rest.replace(/[/?#].*$/, '').slice(0, 80);
  }

  return { makeDiagnostics, proxyHostOnly };
});
