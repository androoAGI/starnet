/* sidecar/hooks.js — THE HOOK SPINE. The one place the station lets a Commander put their own code in the
   agent's path.

   Agent OS had no extension point of this kind at all. Skills add INSTRUCTIONS, MCP adds TOOLS, routines add a
   SCHEDULE — none of them let the Commander say "whenever the agent edits a file, run prettier" or "never let
   it run this command" or "before every model call, tell it today's on-call rota". That is what a hook is, and
   its absence was the single largest hole in Agent OS's extensibility.

   ONE SPINE, TWO FRONT DOORS — copied deliberately from the reference harness, where shell hooks register on
   the same manager the in-process plugins use. A shell script and a JS plugin are the same thing to this file:
   a handler on an event. That is what keeps the two from drifting into different semantics, different
   ordering, and different blocking rules — the bug class you get from bolting a second mechanism on later.

   THE LAW THAT GOVERNS EVERYTHING HERE: **A HOOK MAY DENY, NEVER GRANT.** A pre_* hook can block a call the
   agent was otherwise allowed to make. Nothing a hook returns can widen authority — it cannot approve what the
   capability gate refused, cannot pre-consent a dangerous tool, cannot add a capability. Hooks run INSIDE the
   existing gates, never in front of them. If that ever inverts, a single user script becomes a privilege
   escalation and the whole consent model is decoration.

   Aggregation:
     · BLOCK WINS. One blocking handler blocks, regardless of how many allowed. The first block's reason is
       the one reported, so the message a Commander sees names the handler that actually stopped it.
     · CONTEXT CONCATENATES, in registration order, so composing two context-injecting hooks is predictable.
     · A handler that THROWS or TIMES OUT is skipped and logged, never fatal. A broken hook script must not be
       able to take a run down — it is the Commander's code running in our loop, and it will be broken
       sometimes. Note this is deliberately the OPPOSITE of fail-closed: a hook that dies does not block. A
       hook that wants to deny has to say so.
     · Handlers fire in REGISTRATION order and the caller controls that order (index.js registers plugins
       before shell hooks, matching the reference harness, so plugin decisions win ties).

   PURE + INJECTED: no fs, no child_process, no clock of its own. The shell-hook bridge and the plugin loader
   are the ambient halves; this file is the contract they share, so it is headless-testable end to end.

   makeHooks({ clock?, onError?, timeoutMs? }) -> { register, invoke, count, events, EVENTS } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).hooks = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* THE EVENT NAMES ARE THE REFERENCE HARNESS'S, VERBATIM. Not a style choice: it means a Commander arriving
     with hook scripts already written for that harness can drop them in and they fire on the same events with
     the same payload keys. An event we rename is an event their script silently never runs on. */
  const EVENTS = Object.freeze([
    'pre_tool_call',      // blockable. Fires INSIDE the capability + consent gates, never before them.
    'post_tool_call',     // observe only: the result is already the agent's.
    'pre_llm_call',       // blockable, and may inject `context` for the upcoming turn.
    'post_llm_call',      // observe only.
    'on_session_start',
    'on_session_end',
    'subagent_stop',      // a delegated worker finished — the parent's chance to react to a child's result.
    'on_pre_compress',    // history is about to be folded away; last chance to save or inject something.
    'on_memory_write'     // observe only. NOT blockable BY DESIGN: memory is the Commander's own, and a
                          // script that could veto their notes would be a foot-gun with no upside.
  ]);
  const BLOCKABLE = Object.freeze(new Set(['pre_tool_call', 'pre_llm_call']));
  const DEFAULT_TIMEOUT_MS = 5000;
  const MAX_CONTEXT_CHARS = 8000;    // injected context rides the prompt; a runaway hook must not own the window
  const MAX_REASON_CHARS = 500;

  // Normalize the two decision shapes the reference harness accepts, so a script written for either works
  // here unchanged: {decision:'block', reason} (Claude-Code style) and {action:'block', message}.
  function readDecision(out) {
    if (!out || typeof out !== 'object') return null;
    const verdict = String(out.decision || out.action || '').toLowerCase();
    if (verdict !== 'block' && verdict !== 'deny') return null;
    const reason = String(out.reason || out.message || '').slice(0, MAX_REASON_CHARS).trim();
    return { reason: reason || 'blocked by a hook' };
  }
  function readContext(out) {
    if (!out || typeof out !== 'object') return '';
    const c = out.context;
    return (typeof c === 'string' && c.trim()) ? c.slice(0, MAX_CONTEXT_CHARS) : '';
  }

  function makeHooks(opts) {
    opts = opts || {};
    const onError = (typeof opts.onError === 'function') ? opts.onError : (() => {});
    const defaultTimeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const registry = new Map();   // event -> [{ fn, name, timeoutMs }]
    for (const e of EVENTS) registry.set(e, []);

    /* register(event, fn, meta) -> unregister()
       `fn(payload)` may return, or resolve to, { decision|action, reason|message, context } — or nothing at
       all, which is the common case and means "I looked, carry on". */
    function register(event, fn, meta) {
      if (!registry.has(event)) throw new Error('unknown hook event: ' + event);
      if (typeof fn !== 'function') throw new Error('hook handler must be a function');
      const entry = { fn, name: String((meta && meta.name) || 'hook'), timeoutMs: Number(meta && meta.timeoutMs) > 0 ? Number(meta.timeoutMs) : defaultTimeout };
      registry.get(event).push(entry);
      return function unregister() {
        const list = registry.get(event);
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
      };
    }

    // A handler is bounded so one wedged script cannot hang the run it is observing. The timer is always
    // cleared; a late resolution after the timeout is discarded rather than applied out of order.
    function bounded(entry, payload) {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          onError({ hook: entry.name, event: payload && payload.hook_event_name, error: 'timeout after ' + entry.timeoutMs + 'ms' });
          resolve(null);
        }, entry.timeoutMs);
        Promise.resolve().then(() => entry.fn(payload)).then(
          (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
          (e) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            onError({ hook: entry.name, event: payload && payload.hook_event_name, error: (e && e.message) || String(e) });
            resolve(null);   // a broken hook is skipped, never fatal
          }
        );
      });
    }

    /* invoke(event, payload) -> { blocked, reason, context, ran }
       SEQUENTIAL, not concurrent: hooks are the Commander's own code and they compose by order (hook B may
       legitimately depend on what hook A just did on disk). Determinism is worth more here than the few ms
       a parallel fan-out would save, and the handler count is small by construction. */
    async function invoke(event, payload) {
      const list = registry.get(event);
      const empty = { blocked: false, reason: '', context: '', ran: 0 };
      if (!list || !list.length) return empty;   // the overwhelmingly common case: nothing registered, no cost
      const base = Object.assign({ hook_event_name: event }, payload || {});
      let blocked = null;
      const contexts = [];
      let ran = 0;
      for (const entry of list) {
        const out = await bounded(entry, base);
        ran++;
        const ctx = readContext(out);
        if (ctx) contexts.push(ctx);
        if (blocked) continue;                             // first block already owns the reason
        if (!BLOCKABLE.has(event)) continue;               // post_* / observe-only events cannot block
        const dec = readDecision(out);
        if (dec) blocked = { reason: dec.reason, by: entry.name };
      }
      return {
        blocked: !!blocked,
        reason: blocked ? blocked.reason : '',
        by: blocked ? blocked.by : '',
        context: contexts.join('\n\n').slice(0, MAX_CONTEXT_CHARS),
        ran
      };
    }

    const count = (event) => (registry.get(event) || []).length;
    const events = () => EVENTS.slice();

    /* clear() — detach every handler, in place. This exists so a live reload (the Commander approves a hook,
       or edits hooks.json) can rebuild the set on the SAME spine object. That matters because the spine is
       captured by reference at boot — by the dispatch ctx and by every in-flight run — so swapping in a new
       object would leave those holding the old one and the reload would appear to do nothing. */
    function clear(event) {
      if (event) { if (registry.has(event)) registry.set(event, []); return; }
      for (const e of EVENTS) registry.set(e, []);
    }

    return { register, invoke, count, events, clear, EVENTS };
  }

  return { makeHooks, EVENTS, BLOCKABLE, _internals: { readDecision, readContext } };
});
