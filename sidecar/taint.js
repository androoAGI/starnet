/* sidecar/taint.js — UNTRUSTED-CONTENT TAINT: the structural half of the tool-result injection defence.

   THE PROBLEM the fence alone cannot solve. sidecar/tools/fence.js wraps fetched pages, browser reads and MCP
   results in "this is DATA, never instructions". That is advisory — it tells the model what the content is; it
   cannot make the model obey. A sufficiently well-written injection still wins the argument. And on an
   unattended granted routine there is no human in the loop to catch it.

   THE ANSWER: stop trying to detect the payload, and remove its payoff. Once content the Commander did not
   author has entered a run's context, the host revokes — for the rest of that run — the powers that content
   would need in order to hurt anyone. It does not matter what the injected text says; the tools it would have
   to reach are gone. This is why it is not another pattern-matcher: there is nothing to evade.

   SCOPE, chosen so the rule protects without gutting the feature it protects:
     SOURCES  capability 'web'  -> web_search / web_fetch / web_request bodies AND every browser page read
                                   (snapshot / get_text / console / vision all carry capId 'web')
              capability 'mcp:*' -> every connector result (a third-party server authored it)
     REVOKED  workspace-process  -> shell.exec / verify.run (arbitrary code execution)
              external-credentialed -> web_request (acts as the Commander on a third-party account)
              connector WRITE/EXECUTE -> an outward action on the user's own accounts
     KEPT     plain web reads, ordinary jailed files, memory, images. Reading more untrusted data cannot be
              turned into an outward action; acting on it can. Connector calls are NOT split by the server's
              `readOnlyHint`: that annotation is attacker-authored metadata and cannot prove a call has no
              effect. A tainted run therefore makes no second connector call without a fresh human boundary.

   NOT sources in v1, each a deliberate boundary rather than an oversight:
     - shell output: a granted routine's own `npm test` output would revoke its next command — that is the
       core granted use case, and the content is the agent's own, not a third party's.
     - local fs reads and the agent's notebook/memory: same reasoning, plus the fs jail already bounds them.
   Both are real residual paths (a routine could `cat` a downloaded file). Documented, not hidden.

   Pure: no clock, no rng, no I/O — unit-testable, and one definition shared by the dispatch gate and the
   consent-broker predicates so the two can never disagree about what is revoked. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./inputpolicy.js') : (root.SK && root.SK.inputpolicy));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).taint = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inputpolicy) {
  'use strict';

  const impactOfTool = inputpolicy.impactOfTool;
  const CONNECTOR_CAP = /^mcp:/;

  // Does this tool's RESULT bring content the Commander did not author into the context?
  function isUntrustedSource(tool, call) {
    const cap = String((tool && tool.capability) || '');
    if (cap === 'web' || CONNECTOR_CAP.test(cap)) return true;
    // Attachments are parked inside the ordinary workspace jail so the existing fs tools can read them. The
    // jail proves WHERE the bytes live, not WHO authored them. Treat a read from that provenance-stamped folder
    // like the upload that created it; otherwise a poisoned document can bypass the web/MCP taint boundary.
    const name = String((tool && tool.name) || '');
    const p = String((call && call.args && call.args.path) || '');
    if (name === 'fs.read' && /(?:^|[\\/])\.attachments(?:[\\/]|$)/i.test(p)) return true;
    // PARKED UNTRUSTED OUTPUT. The host parks over-cap output into .output/; a park made from untrusted bytes (a web
    // or connector result, a tainted worker's text, anything a tainted run produced) is named `untrusted-*` by the
    // host. Reading it back — in a LATER run, where the original tool result no longer latches anything — carries
    // the same provenance as the result that made it. fs.search rooted inside .output/ or .attachments/ returns the
    // same bytes as snippets (a workspace-root search already skips those hidden folders).
    if (name === 'fs.read' && UNTRUSTED_PARK.test(p)) return true;
    return name === 'fs.search' && /(?:^|[\\/])\.(?:attachments|output)(?:[\\/]|$)/i.test(p);
  }
  const UNTRUSTED_PARK = /(?:^|[\\/])\.output[\\/]untrusted-[^\\/]*$/i;
  const UNTRUSTED_PARK_PREFIX = 'untrusted-';

  /* A tool RESULT may carry `taintedBy`: the host-proven taint of content that tool relays from ANOTHER run (a
     delegated worker's text, a background subagent record). The tool is not itself a web/connector source, so
     isUntrustedSource cannot see it — the relayed run's own latch is the proof. Returns the reason the INGESTING
     run should latch, or null. Pure. */
  function relayedTaint(result) {
    const src = result && typeof result.taintedBy === 'string' ? result.taintedBy.trim() : '';
    return src ? 'worker output (tainted by ' + src.slice(0, 120) + ')' : null;
  }
  // First taint across rows (worker rows / subagent records). null when none carries one.
  function firstTaint(rows) {
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const t = r && typeof r.taintedBy === 'string' ? r.taintedBy.trim() : '';
      if (t) return t;
    }
    return null;
  }

  // Is this tool's taint lock on for THIS call? A function lock reads the call's args (action-aware): routine.manage
  // and loop.manage leave pause/stop open, because stopping work is a de-escalation, not a way to schedule a rerun.
  // Without a call the predicate sees {} (no action), which locks; a predicate that throws keeps the tool locked.
  function lockedFor(tool, call) {
    if (typeof tool.taintLocked !== 'function') return tool.taintLocked === true;
    try { return tool.taintLocked((call && call.args) || {}) !== false; } catch (_) { return true; /* fail closed */ }
  }

  // Once the run is tainted, may this tool still be called? `call` (optional) lets an action-aware lock read the args.
  function allowedWhenTainted(tool, call) {
    if (!tool) return true;                                  // unknown name -> let the ordinary unknown-tool path answer
    // a tool that PERSISTS text a later run obeys (team.configure rewrites a crew member's standing orders) would
    // launder this run's taint into every future run of that agent — past the per-run fence entirely. Same for a
    // routine/loop (its prompt fires later as a fresh, untainted run — with Full Access) and a skill (a procedure
    // later runs load and follow, scripts/ included): all taint-locked 2026-10-10.
    if (lockedFor(tool, call)) return false;
    const impact = impactOfTool(tool);
    if (impact === 'workspace-process') return false;        // shell.exec / verify.run
    if (impact === 'external-credentialed') return false;    // web_request — spends a stored key outward
    if (impact === 'external-unknown') return false;         // fail closed on effects the host cannot classify
    // Every MCP annotation is supplied by the server. In particular readOnlyHint may lie, so using the
    // translated scope here would let a malicious connector label a mutator as a safe post-injection read.
    if (CONNECTOR_CAP.test(String(tool.capability || ''))) return false;
    return true;
  }

  // For an action-aware lock: which of the tool's OWN declared actions (schema action enum) a tainted run may still
  // call, each probed alone through allowedWhenTainted. [] for a whole-tool lock, a tool without an action enum, or a
  // predicate that throws, so nothing is ever offered as open that the gate would refuse.
  function openActionsWhenTainted(tool) {
    if (!tool || typeof tool.taintLocked !== 'function') return [];
    const action = tool.schema && tool.schema.properties && tool.schema.properties.action;
    const declared = action && Array.isArray(action.enum) ? action.enum : [];
    return declared.filter(a => typeof a === 'string' && allowedWhenTainted(tool, { args: { action: a } }));
  }

  // The opening words of a taint lockout, as narrow as the lock. A whole-tool lock says the tool is gone; an action lock
  // names only the refused action and the actions still open, so the model does not refuse "just pause it" believing the
  // whole tool is gone. The action is echoed only when it is a plain word: it is model-written text. Pure.
  function lockoutLead(tool, call) {
    const name = String((call && call.name) || (tool && tool.name) || 'this tool');
    const open = openActionsWhenTainted(tool);
    if (!open.length) return '"' + name + '" is no longer available on this run.';
    const raw = call && call.args && typeof call.args.action === 'string' ? call.args.action.trim() : '';
    const subject = /^[A-Za-z][\w-]{0,29}$/.test(raw) ? 'Action "' + raw + '" of "' + name + '"' : 'This call to "' + name + '"';
    const quoted = open.map(a => '"' + a + '"');
    const still = quoted.length > 1 ? quoted.slice(0, -1).join(', ') + ' and ' + quoted[quoted.length - 1] + ' are' : quoted[0] + ' is';
    return subject + ' is locked on this run; ' + still + ' still available.';
  }

  // Pure state machine for the temporal confirmation boundary. Standing permission state is intentionally not
  // an input: only a decision obtained by the caller AFTER taint can yield a one-call recovery.
  function postTaintBoundary(tool, opts) {
    opts = opts || {};
    if (!opts.taintedBy || allowedWhenTainted(tool, opts.call)) return { allow: true, needsConfirmation: false, oneShot: false };
    // FULL ACCESS is the Commander's explicit zero-prompt posture. Taint still remains latched and fenced, but it
    // cannot silently downgrade Full Access into ASK mode. Hardline floors live outside this policy and still win.
    // EXCEPT when the run's ENTRY was untrusted third-party content (sec-taint2 09-25, owner decision): a webhook /
    // watched-folder trigger payload, a forwarded message or a chat attachment — and every hop and delegated worker
    // downstream of such an entry (host-minted, sidecar/run-origin.js entryUntrusted). There the Commander never
    // typed the job at all, so "zero prompts" would hand the payload's author the terminal. Owner-typed runs keep
    // the override exactly as before, including one that later read a web page.
    // ...and never for a fresh-consent tool (station.power): a run that read a page asks before it widens the leash
    if (opts.fullAccess === true && opts.untrustedEntry !== true && tool.freshConsent !== true) return { allow: true, needsConfirmation: false, oneShot: false };
    if (opts.surface !== 'interactive' || opts.hasPrompt !== true) return { allow: false, needsConfirmation: false, oneShot: false };
    if (opts.decision == null) return { allow: false, needsConfirmation: true, oneShot: false };
    const allow = /^(?:once|session|always|full)$/i.test(String(opts.decision || ''));
    return { allow, needsConfirmation: false, oneShot: allow };
  }

  /* SAME-ORIGIN API CONTINUATION (owner decision 2026-10-12, Etsy-factory Publisher report). Reading one API's response
     used to revoke web_request outright: a watched run got one approval card PER CALL ("session" collapsed to once —
     live-proven 3 calls = 3 cards) and an unattended run was refused. Every real API job is GET-then-PUT, so Agent OS
     could not run one hands-off. The threat the latch answers is injected text steering the run's powers somewhere
     NEW: exfiltrating to another host, or spending a key on a service it was not already working on. Neither exists
     when the next call goes back to the SAME https origin with keys the run already sent there.
     So the run tracks a scope: { origin, keys } while every untrusted byte it has read came from web_request responses
     of ONE https origin (plus this run's own parked copies of them), else { broad: true }. Pure; the host owns state.
     Anything else that taints — a page, a browser read, a connector, an attachment, another origin, a key not already
     used there, a taint the run started with or inherited — makes the scope broad and the old lock applies unchanged. */
  const KEY_REF = /\$\{([A-Z][A-Z0-9_]*)\}/g;
  function requestOrigin(call) {
    try {
      const u = new URL(String((call && call.args && call.args.url) || ''));
      return u.protocol === 'https:' ? u.origin.toLowerCase() : '';
    } catch (_) { return ''; }
  }
  function requestKeys(call) {
    const a = (call && call.args) || {};
    const out = new Set();
    const h = a.headers && typeof a.headers === 'object' ? a.headers : {};
    for (const k of Object.keys(h)) { let m; KEY_REF.lastIndex = 0; while ((m = KEY_REF.exec(String(h[k])))) out.add(m[1]); }
    if (a.auth && typeof a.auth === 'object' && a.auth.key) out.add(String(a.auth.key).trim());
    return Array.from(out).sort();
  }
  function isWebRequest(tool, call) { return String((tool && tool.name) || (call && call.name) || '').replace(/\./g, '_') === 'web_request'; }
  // fs.read / fs.search of a park THIS run made: its bytes are this run's own (same-scope) results, not new content.
  function ownPark(tool, call, runId) {
    const name = String((tool && tool.name) || '');
    if (name !== 'fs.read' && name !== 'fs.search') return false;
    const base = String((call && call.args && call.args.path) || '').split(/[\\/]/).pop();
    const rid = String(runId || '').replace(/[^A-Za-z0-9_-]/g, '');
    return !!rid && base.indexOf(UNTRUSTED_PARK_PREFIX) === 0 && base.indexOf('-' + rid + '-') > 0;
  }
  // The scope after one more untrusted result. wasTainted = the run was already tainted before this result arrived.
  function scopeAfterSource(scope, tool, call, opts) {
    opts = opts || {};
    if (scope && scope.broad) return scope;
    if (!scope && opts.wasTainted) return { broad: true };          // tainted by something we did not scope
    if (scope && ownPark(tool, call, opts.runId)) return scope;
    const origin = isWebRequest(tool, call) ? requestOrigin(call) : '';
    // The host proves which HTTPS origin authored the response. The requested URL alone cannot prove it:
    // web_request may have followed a cross-origin redirect, and failed/replayed results may have no proof.
    if (!origin || opts.responseOrigin !== origin) return { broad: true };
    const keys = requestKeys(call);
    if (!scope) return { origin, keys };
    if (scope.origin !== origin || !keys.every(k => scope.keys.indexOf(k) >= 0)) return { broad: true };
    return scope;
  }
  // May this call skip the post-taint confirmation? Only a web_request back to the scoped origin, spending no key
  // the run had not already sent there. Never for an untrusted ENTRY (webhook/forward/attachment-started run).
  function sameOriginContinuation(scope, tool, call, opts) {
    opts = opts || {};
    if (!scope || scope.broad || opts.untrustedEntry === true || !isWebRequest(tool, call)) return false;
    if (requestOrigin(call) !== scope.origin) return false;
    return requestKeys(call).every(k => scope.keys.indexOf(k) >= 0);
  }

  return { isUntrustedSource, allowedWhenTainted, openActionsWhenTainted, lockoutLead, postTaintBoundary, relayedTaint, firstTaint, scopeAfterSource, sameOriginContinuation, CONNECTOR_CAP, UNTRUSTED_PARK_PREFIX };
});
