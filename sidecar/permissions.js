/* sidecar/permissions.js — the informed-consent broker (roadmap P1.5a).

   A PURE, injected-dependency decision function that the host dispatch pipeline consumes as
   `ctx.consent(call, tool)` (registry.js:76). It performs NO IO, never reads the wall clock, and
   never touches process.env: the frozen Full-Access bypass, the session/permanent grant stores, the
   persist() sink, the per-tool network hint, and the interactive prompt() channel are all injected by
   the sidecar edge (index.js) so the same module is deterministic and headless-testable.

   makeConsentBroker({ bypass, hardline, sessionKey, grantsSession, grantsPermanent, persist,
                       networkOf, surface, prompt }) -> consent
     consent(call, tool)              -> { allow, reason, scope } | Promise<…>   // the four-tier ladder
     consent.grant(decision,call,tool)-> { allow, reason, scope }   // record a human once/session/always/full decision
     consent.snapshot()               -> { permanent:[...], session:{...} }   // read-only, for tests/telemetry

   The ladder, in FIXED order (each tier short-circuits):
     1. HARDLINE — an injected, unconditional deny floor; checked FIRST so no flag can reach past it.
                   Its reason carries an anti-retry suffix so the model stops re-attempting it.
     2. BYPASS   — Full Access: allow anything NOT on the hardline floor. The host injects a live predicate
                   so persisted per-agent approval changes and revocations take effect on the next call.
     3. CACHE    — allow if this dangerKey was previously granted for THIS session or permanently.
     4. RESOLVE  — a read-only, non-network call auto-allows; a mutation with no grant DEFAULT-DENIES
                   under an autonomous surface ('silence is not consent'). Under an INTERACTIVE surface
                   with a wired prompt(), it asks the human and routes the answer back through grant();
                   with no prompt wired, it fails closed. Only this branch is async — tiers 1–3 and the
                   read-only/autonomous paths stay synchronous, so direct-result callers are unaffected.

   dangerKey = (tool.capability || tool.name) + ':' + tool.scope — the danger CLASS, never args/paths/keys.
   (The makeTool object carries no `network` flag — that lives in resolved.networkCaps — so the read-only
    tier asks the injected networkOf(); index.js wires it to (call)=>!!resolved.networkCaps[call.name].) */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).permissions = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // appended to every hardline denial: stop the model from burning turns re-attempting a floor-blocked action.
  const ANTI_RETRY = ' — do this yourself outside the agent; do not retry or rephrase.';
  // returned when an autonomous run reaches an ungranted mutation: the absence of a human yes is a NO.
  // The trailing hint is model-facing: line runs used to open their delivered result with "This is an unattended run,
  // so file saves require explicit approval…" (live walkthrough 2026-10-13) — the Commander needs the content, not the rule.
  const SILENCE = 'autonomous run cannot self-approve this action — silence is not consent. Put the content in your reply instead, and do not explain approval rules to the Commander.';

  function scopeOf(tool) { return (tool && tool.scope) || 'read'; }

  // consentKey lets a tool keep its OWN consent class instead of sharing its capability's: autonomy.set rides the
  // orchestrator capability for projection, but an "always" given to routine.create must never pre-approve it.
  function dangerKey(tool) {
    const cls = (tool && (tool.consentKey || tool.capability || tool.name)) || 'unknown';
    return cls + ':' + scopeOf(tool);
  }

  // The makeTool object has no network flag; the sidecar edge injects networkOf when wiring. The
  // default consults tool/call hints so the read-only tier is still correct in isolation.
  function defaultNetworkOf(call, tool) {
    return !!(tool && tool.network) || !!(call && call.network);
  }

  function makeConsentBroker(opts) {
    opts = opts || {};
    /* `bypass` accepts a boolean (the boot-frozen env flag — unchanged) OR a function re-read on every call
       (MASTER BYPASS, 2026-08-05): the user's runtime FULL BYPASS switch must take effect — and, more
       importantly, REVOKE — on the very next tool call without a sidecar restart. The function is host-injected
       from a persisted, token-gated store; nothing the model emits can reach it, so the frozen-at-boot
       injection-safety property is preserved (the model still cannot flip the flag — only the /api route can). */
    const bypassFn = typeof opts.bypass === 'function' ? opts.bypass : null;
    const bypass = bypassFn ? false : !!opts.bypass;
    const bypassNow = () => { if (bypassFn) { try { return bypassFn() === true; } catch (_) { return false; } } return bypass; };
    // FULL POWER is stronger than the ordinary no-prompt bypass: the host explicitly authorizes the
    // whole local computer, including paths that restricted postures reserve for the human. This predicate
    // is injected from host-owned state and re-read for every call so revocation is immediate.
    const unrestrictedFn = typeof opts.unrestrictedHost === 'function' ? opts.unrestrictedHost : null;
    const unrestricted = unrestrictedFn ? false : opts.unrestrictedHost === true;
    const unrestrictedNow = () => { if (unrestrictedFn) { try { return unrestrictedFn() === true; } catch (_) { return false; } } return unrestricted; };
    const hardline = typeof opts.hardline === 'function' ? opts.hardline : null;
    const sessionKey = opts.sessionKey || 'default';
    const grantsSession = opts.grantsSession instanceof Map ? opts.grantsSession : new Map();
    const grantsPermanent = opts.grantsPermanent instanceof Set ? opts.grantsPermanent : new Set(opts.grantsPermanent || []);
    const persist = typeof opts.persist === 'function' ? opts.persist : null;
    const networkOf = typeof opts.networkOf === 'function' ? opts.networkOf : defaultNetworkOf;
    const surface = opts.surface || 'autonomous';
    const prompt = typeof opts.prompt === 'function' ? opts.prompt : null;                     // (call,tool) -> Promise<decision>
    // AWAY WORKSHOP (W1): an injected predicate — the Commander's recorded "build things while I'm away" grant for
    // THIS agent. When present and true, an AUTONOMOUS run may WRITE, but ONLY inside its own jail: the tool must be
    // a jail-scoped capability (cabinet = files, notebook = memory). This is a per-agent recorded consent, wired in
    // index.js (workshopOf), NOT a self-approval — the exec lockout below is UNTOUCHED, so an away run still can
    // never run a command. Pure: like hardline/networkOf, all state comes from the injected function. Default: none.
    const workshop = typeof opts.workshop === 'function' ? opts.workshop : null;
    const credentialed = typeof opts.credentialed === 'function' ? opts.credentialed : null;
    // UNATTENDED TERMINAL GRANT (2026-07-25): the Commander's recorded per-ROUTINE "may use the terminal"
    // approval for THIS run. Injected like workshop/credentialed; index.js derives it from the durable cron job
    // record only. Default: none -> the exec lockout below is untouched and this file behaves exactly as before.
    const terminalGrant = typeof opts.terminalGrant === 'function' ? opts.terminalGrant : null;
    // the capability the terminal grant may unlock. 'workbench' = shell.exec + verify.run. Overridable for tests.
    const TERMINAL_CAP = opts.terminalCap || 'workbench';
    // UNATTENDED CONNECTOR GRANT (2026-07-25): the Commander's recorded per-ROUTINE "may use my connected
    // tools" approval. Same injection shape and same host-only sourcing as terminalGrant. Default: none.
    const connectorGrant = typeof opts.connectorGrant === 'function' ? opts.connectorGrant : null;
    // MCP connector tools are stamped capability 'mcp:<connectorId>' by sidecar/mcp/translate.js. Matching the
    // PREFIX (not a fixed name) is what lets one grant cover every server the Commander has connected, while
    // still refusing every non-connector capability. Overridable for tests.
    const CONNECTOR_CAP_RE = opts.connectorCapRe || /^mcp:/;
    // the jail-scoped capabilities the workshop grant may unlock a WRITE for (never execute, never a non-jail tool).
    // The plan calls these "cabinet | notebook"; in the live tool registry the FILE capability is `cabinet`
    // (sidecar/tools/builtin/fs.js — fs.write/append/edit/patch, realpath-jailed to workspaces/<agentId>/) and the
    // memory/notebook capability is `memory` (notebook.write, persisted to the agent's OWN sibling KV store). Both
    // are per-agent-scoped, so both are safe to unlock for a granted away run; the injected `workshop` predicate is
    // the recorded consent. Overridable via opts.workshopCaps for tests / a future capability rename.
    const JAIL_WRITE_CAPS = (opts.workshopCaps && typeof opts.workshopCaps === 'object')
      ? opts.workshopCaps : { cabinet: true, memory: true };
    // OWN-key lookup: a bare `JAIL_WRITE_CAPS[cap]` walks the prototype chain, so capability 'constructor' /
    // 'toString' would read as granted. No such capability exists today — this is the allowlist being an
    // allowlist rather than a near-miss, matching the same repair in channels/store.js and shared/schema.js.
    const jailWritableCap = (cap) => Object.prototype.hasOwnProperty.call(JAIL_WRITE_CAPS, cap) && !!JAIL_WRITE_CAPS[cap];
    function workshopWritable(call, tool) {
      if (!workshop) return false;
      if (surface !== 'autonomous') return false;               // interactive already asks a live human
      if (scopeOf(tool) !== 'write') return false;              // ONLY write; read auto-allows, execute stays locked
      const cap = tool && tool.capability;
      if (!jailWritableCap(cap)) return false;                  // must be a jail-scoped capability (files/memory)
      try { return workshop(call, tool) === true; } catch (_) { return false; }
    }

    /* UNATTENDED CREDENTIAL GRANT — an autonomous network call (web_request) that spends a platform key the
       Commander explicitly approved for unattended use in TOOLSETS & CONNECTORS → KEYS. Same shape as the
       workshop tier above: a recorded, revocable, per-key approval IS consent, so this is not the "silence"
       the default-deny protects against. Deliberately narrow:
         • autonomous only (interactive already asks a live human)
         • NEVER scope 'execute', so it can never reach shell — it sits below the exec lockout by construction
         • only impact 'external-credentialed' (no host-process capability exists on this path)
         • the injected predicate must confirm EVERY key the call references carries the grant
       No grant on the specific key -> falls through to the default deny, unchanged. */
    function credentialedAutonomy(call, tool) {
      if (!credentialed) return false;
      if (surface !== 'autonomous') return false;
      if (scopeOf(tool) === 'execute') return false;
      if (!tool || tool.impact !== 'external-credentialed') return false;
      try { return credentialed(call, tool) === true; } catch (_) { return false; }
    }

    /* UNATTENDED TERMINAL GRANT — the ONLY key that opens the exec lockout (tier 2.5) for an unattended run.
       Deliberately the narrowest carve-out in this file:
         • autonomous only (interactive already asks a live human)
         • the tool's capability must be exactly TERMINAL_CAP ('workbench' = shell.exec / verify.run) — no
           other family, no wildcard
         • the injected predicate must confirm THIS RUN carries the Commander's recorded per-routine grant
       Unlike every other allow-tier this one is NOT reachable by a cached/permanent `always` grant, by prompt
       text, or by anything the model emits — index.js sources it from the persisted cron job alone. That is
       In ASK mode this is the explicit route for a routine to use shell. Full Access is evaluated earlier by
       the host-injected bypass predicate. No grant -> false -> the lockout stands. */
    function terminalAutonomy(call, tool) {
      if (!terminalGrant) return false;
      if (surface !== 'autonomous') return false;
      if (!tool || tool.capability !== TERMINAL_CAP) return false;
      try { return terminalGrant(call, tool) === true; } catch (_) { return false; }
    }

    /* UNATTENDED CONNECTOR GRANT — lets a granted routine call the Commander's OWN connected MCP servers with
       nobody watching. Narrowed exactly like terminalAutonomy:
         • autonomous only (interactive keeps its exact per-call confirmation, unchanged)
         • the capability must match CONNECTOR_CAP_RE ('mcp:…') — a tool that merely fell through to the
           external-unknown default is NOT a connector and gets nothing from this grant
         • the injected predicate must confirm THIS RUN carries the recorded per-routine grant
       Sits above the exec lockout for the same reason as the terminal tier: a non-read MCP tool is scope
       'execute', so below the lockout this would be dead code. */
    function connectorAutonomy(call, tool) {
      if (!connectorGrant) return false;
      if (surface !== 'autonomous') return false;
      if (!tool || !CONNECTOR_CAP_RE.test(String(tool.capability || ''))) return false;
      try { return connectorGrant(call, tool) === true; } catch (_) { return false; }
    }

    function sessionSet(create) {
      let s = grantsSession.get(sessionKey);
      if (!s && create) { s = new Set(); grantsSession.set(sessionKey, s); }
      return s;
    }
    function granted(key) {
      if (grantsPermanent.has(key)) return true;
      const s = grantsSession.get(sessionKey);
      return !!(s && s.has(key));
    }

    function consent(call, tool) {
      const scope = scopeOf(tool);
      // FULL POWER: the Commander's explicit host-wide authority outranks Agent OS policy floors.
      // Input/schema validity, OS permissions and downstream service prerequisites still report normally.
      if (unrestrictedNow()) return { allow: true, scope: scope, reason: 'full-power' };
      // 1. HARDLINE — unreachable past any flag.
      const hr = hardline ? hardline(call, tool) : null;
      if (hr) return { allow: false, scope: scope, hardline: true, reason: String(hr) + ANTI_RETRY };
      // 2. BYPASS — boot Full Access, live master bypass, or persisted per-agent Full Access.
      if (bypassNow()) return { allow: true, scope: scope, reason: 'full-access' };
      // 2.4 UNATTENDED TERMINAL GRANT — checked BEFORE the exec lockout because opening that lockout for exactly
      // this case IS the feature (see terminalAutonomy). Ordering is load-bearing: below tier 2.5 it would be
      // dead code. Still below the hardline floor (tier 1), so protected paths remain unwritable.
      if (terminalAutonomy(call, tool)) return { allow: true, scope: scope, reason: 'per-routine unattended terminal grant' };
      if (connectorAutonomy(call, tool)) return { allow: true, scope: scope, reason: 'per-routine unattended connector grant' };
      // 2.5 EXEC LOCKOUT — an UNATTENDED run may NEVER execute a command off a cached/pre-blessed grant: only a
      // live human (interactive surface), or the explicit per-routine grant in tier 2.4, can approve shell. This
      // keeps "no autonomous shell" un-pre-blessable — a permanent `always` grant a human gave once does NOT
      // silently enable cron/headless command execution. Frozen FULL_ACCESS (tier 2) remains the other
      // deliberate machine-wide exception.
      if (surface === 'autonomous' && scope === 'execute') return { allow: false, scope: scope, reason: SILENCE };
      // 2.6 AWAY WORKSHOP — an autonomous, jail-scoped WRITE by an agent the Commander granted "build things while
      // I'm away" is allowed. Sits ABOVE the cache tier (so it doesn't need a pre-seeded danger key) but BELOW the
      // exec lockout (execute is filtered out in workshopWritable, so this NEVER reaches shell) and BELOW the
      // hardline floor (tier 1, checked first — .env/.git stay unwritable). The fs-jail (realpath-scoped to
      // workspaces/<agentId>/) is the real boundary; this only clears the "silence is not consent" default-deny
      // for exactly cabinet:write / notebook:write on a granted agent. No grant → the tiers below run unchanged.
      if (workshopWritable(call, tool)) return { allow: true, scope: scope, reason: 'workshop grant — build things while away' };
      if (credentialedAutonomy(call, tool)) return { allow: true, scope: scope, reason: 'unattended grant on this platform key' };
      // 3. CACHE — a prior session/permanent grant for this danger class. Never for a FRESH-CONSENT tool (sweep 2026-10-03):
      // widening the station's own leash (station.power: Full Power, FULL agents, caps, trusted folders, hook code) is a
      // card the Commander answers per call when they are in ASK — one "always" used to approve every later escalation.
      // Full Access (tier 2) is the Commander's zero-prompt posture and still covers it; taint.js keeps the lock on it.
      if (!(tool && tool.freshConsent === true) && granted(dangerKey(tool))) return { allow: true, scope: scope, reason: 'previously granted' };
      // 4. RESOLVE.
      if (scope === 'read' && !networkOf(call, tool)) return { allow: true, scope: scope, reason: 'read-only, non-network' };
      if (surface === 'autonomous') return { allow: false, scope: scope, reason: SILENCE };
      // INTERACTIVE: ask the human. dispatch awaits consent(), so returning this Promise PAUSES the run until a
      // decision arrives; the answer routes back through the SAME grant() ladder (once/always/full/deny). This is
      // the ONLY async branch — every tier above already returned a plain object.
      if (prompt) return Promise.resolve(prompt(call, tool)).then(function (d) { return consent.grant(d, call, tool); });
      // no channel wired -> fail closed.
      return { allow: false, scope: scope, reason: 'no consent channel — interactive prompt not wired' };
    }

    // Record a human decision (from the future interactive prompt, or seeded in tests). NEVER called
    // automatically by consent() in autonomous mode — a default-deny stands until a real yes arrives.
    consent.grant = function (decision, call, tool) {
      const scope = scopeOf(tool);
      const key = dangerKey(tool);
      if (decision === 'once') return { allow: true, scope: scope, reason: 'granted once' };
      // nobody answered before the fail-closed timer (consentwait timeoutDecision): still NOT allowed, but marked so the
      // tool result says "timed out", never "the Commander declined" — the model used to tell users they had refused
      if (decision === 'timeout') return { allow: false, scope: scope, timedOut: true, reason: 'approval timed out — nobody answered in time' };
      // the ask was withdrawn before anyone answered (its run stopped: consentwait abortDecision) — CLOSED, and not a No
      if (decision === 'cancelled') return { allow: false, scope: scope, cancelled: true, reason: 'approval withdrawn — the request ended before anyone answered' };
      // a fresh-consent tool never leaves a standing grant behind: any yes approves this one call only
      if (tool && tool.freshConsent === true) {
        return /^(?:session|always|full)$/.test(String(decision)) ? { allow: true, scope: scope, reason: 'granted once' } : { allow: false, scope: scope, reason: 'denied' };
      }
      if (decision === 'session') { sessionSet(true).add(key); return { allow: true, scope: scope, reason: 'granted for session' }; }
      if (decision === 'always') {
        // fail-closed: commit the grant ONLY if it durably persisted (a thrown persist denies).
        if (persist) {
          const next = Array.from(grantsPermanent); if (!grantsPermanent.has(key)) next.push(key);
          try { persist(next); }
          catch (e) { return { allow: false, scope: scope, reason: 'could not persist grant — denied' }; }
        }
        grantsPermanent.add(key);
        return { allow: true, scope: scope, reason: 'granted permanently' };
      }
      if (decision === 'full') {
        // The host persists this agent posture before completing the pending prompt. This pure broker resolves
        // the current call; every later call observes the host-injected live bypass predicate.
        return { allow: true, scope: scope, reason: 'full access granted' };
      }
      return { allow: false, scope: scope, reason: 'denied' };
    };

    consent.snapshot = function () {
      const session = {};
      grantsSession.forEach((set, k) => { session[k] = Array.from(set).sort(); });
      return { permanent: Array.from(grantsPermanent).sort(), session: session };
    };

    return consent;
  }

  return { makeConsentBroker, ANTI_RETRY, SILENCE };
});
