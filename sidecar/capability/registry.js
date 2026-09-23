/* sidecar/capability/registry.js — CAP_REGISTRY: objectType -> grant[].
   THE static map that makes "room objects = capability grants" real. The builder UI edits
   rows here (data), never code. A grant is a policy triple, not a boolean.

   grant = { capId, tool, scope:'read'|'write'|'execute', requiresConsent, network, paramConstraints? }

   'computer' grants the special capId 'compute' — the precondition to spend a model turn at all
   (the COMPUTE GATE), not a tool the model invokes. Other objects grant callable tools. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.capability = root.SK.capability || {}).registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAP_REGISTRY = {
    computer: [
      { capId: 'compute', tool: 'model.chat', scope: 'execute', requiresConsent: false, network: true },
      // QUEST V2 §B: quest.update rides the `computer` object — the ONE object in BOTH the interactive baseline
      // (compute-only) office AND fullOffice, so EVERY task surface gets it (the interactive surface has no placed
      // notebook, which is why granting this under `notebook` left the tool ABSENT while the STATION QUESTS prompt
      // commanded its use — a truthful-telemetry break). A quest is the agent's OWN standing objective: knowing and
      // updating it is part of being able to think at all — the same freebie class as compute — with no outward
      // mutation until the Commander confirms an attest. capId is 'quest', NOT 'compute': resolve.js treats a
      // 'compute' grant as the COMPUTE GATE (sets hasCompute and `continue`s — never a callable tool), so 'compute'
      // would make quest.update permanently absent. A distinct 'quest' capId surfaces as a real tool and stays honest
      // in every consumer — it has no TOOLSETS_META row (toolsets.js) so it is never a toggleable family (correct: a
      // freebie, like compute), it is not in capsummary's CAPS list so it is never advertised/nagged, and capdrift
      // keys on objectTypes (unchanged) so the prop⇄cap seam is intact. (see tools/builtin/quests.js)
      { capId: 'quest', tool: 'quest.update', scope: 'write', requiresConsent: false, network: false },
      // DELIVERABLE NOTE: the agent's own plain-English name for the files it just made. Rides `computer` for
      // exactly the reason quest.update does — it is the ONE object in both the compute-only interactive office
      // and fullOffice, so the runs MOST in need of a readable name (a plain chat that wrote one file, with no
      // cabinet on the floor) are not the ones that can never supply one. capId is 'deliverable', NOT 'compute':
      // resolve.js treats a 'compute' grant as the COMPUTE GATE and never emits it as a callable tool, which is
      // the trap quest.update documents directly above. It writes no file, reaches no network and has no outward
      // effect — it only labels work the run already did — so it is the same freebie class as compute and quest,
      // with no TOOLSETS_META row (never a toggleable family) and no capsummary CAPS row (never advertised or
      // nagged). It can NEVER assert status, crew or byte counts: the tool takes a four-key allowlist and drops
      // everything else, because those facts are the harness's to derive. (see tools/builtin/deliverable.js)
      { capId: 'deliverable', tool: 'deliverable_note', scope: 'write', requiresConsent: false, network: false },
      // TOOL SEARCH: how the agent reaches a DEFERRED tool. Rides `computer` for the same reason quest.update
      // does — it is the ONE object in both the compute-only interactive office and fullOffice, so a deferred
      // tool is never stranded on a surface that cannot look it up. capId is 'toolsearch', NOT 'compute'
      // (resolve.js treats a 'compute' grant as the COMPUTE GATE and never emits it as a callable tool, which
      // would make this permanently absent — the exact trap quest.update hit). No TOOLSETS_META row, so it is
      // not a toggleable family: switching it off would strand every deferred tool behind a tool that no
      // longer exists. It is never itself deferred — the finder cannot be the thing that must be found.
      { capId: 'toolsearch', tool: 'tool.search', scope: 'read', requiresConsent: false, network: false },
      { capId: 'code', tool: 'code.run', scope: 'read', requiresConsent: false, network: false },
      // HARNESS SELF-KNOWLEDGE: reading the station's own secret-free status is part of being able to
      // operate at all, not a power the Commander should have to unlock with a DISH, CABINET or WORKBENCH.
      // A distinct capId is required because `compute` is the non-callable model gate in resolve.js.
      { capId: 'stationinfo', tool: 'station.inspect', scope: 'read', requiresConsent: false, network: false },
      // Host-scoped scheduled scratchpad: the computer is present on every runnable station, while the tool
      // itself refuses any run without a host-minted cronJobId. This does not grant general notebook access.
      { capId: 'routinescratch', tool: 'routine.notepad', scope: 'write', requiresConsent: false, network: false },
      // TASK PLAN: the agent's in-session todo list — MOVED here from `notebook` (memory) 2026-08-17. Tracking
      // your own multi-step plan is part of being able to think at all, the same freebie class as quest.update
      // directly above and for the same mechanical reason: `computer` is the ONE object in BOTH the
      // compute-only interactive office and fullOffice, so a station without a placed NOTEBOOK no longer
      // silently has NO task-list mechanism (and loop.js's post-compaction todo re-injection was dead on
      // exactly those stations). capId is 'taskplan', NOT 'compute' (resolve.js treats a 'compute' grant as
      // the COMPUTE GATE and never emits it as a callable tool — the trap quest.update documents). No
      // TOOLSETS_META row (never a toggleable family), no capsummary CAPS row (never advertised or nagged).
      // The plan itself still persists through the notebook STORE — this grant is about tool AVAILABILITY,
      // not where the bytes live. (see tools/builtin/todo.js)
      { capId: 'taskplan', tool: 'todo', scope: 'write', requiresConsent: false, network: false }
    ],
    notebook: [
      { capId: 'memory', tool: 'notebook.write', scope: 'write', requiresConsent: false, network: false },   // private sandboxed memory — no consent gate (see notebook.js)
      { capId: 'memory', tool: 'notebook.read', scope: 'read', requiresConsent: false, network: false },
      { capId: 'memory', tool: 'notebook.feedback', scope: 'write', requiresConsent: false, network: false }, // rate a recalled memory helpful/unhelpful — trust nudge only (see notebook.js)
      // `todo` was MOVED to the `computer` object (above, capId 'taskplan') 2026-08-17 — a station without a
      // placed notebook had no task-list mechanism at all, silently. See the note there.
      { capId: 'memory', tool: 'recall_conversation', scope: 'read', requiresConsent: false, network: false }, // H1.3: search your own past dialogue (transcriptstore) — read-only, no consent (see recall.js)
      { capId: 'memory', tool: 'skill.write', scope: 'write', requiresConsent: false, network: false },        // H4: save/edit a reusable procedure (see skills.js)
      { capId: 'memory', tool: 'skill.manage', scope: 'write', requiresConsent: false, network: false },       // H4: create/patch/archive saved skills
      { capId: 'memory', tool: 'skill.list', scope: 'read', requiresConsent: false, network: false },          // H4: list saved skills (metadata only)
      { capId: 'memory', tool: 'skill.view', scope: 'read', requiresConsent: false, network: false },          // H4: load a saved skill's full body
      { capId: 'memory', tool: 'widget.get', scope: 'read', requiresConsent: false, network: false },
      { capId: 'memory', tool: 'widget.set', scope: 'write', requiresConsent: false, network: false }          // User-defined widgets: read the current definition, then publish a sourced reading.
      // QUEST V2 §B: quest.update was MOVED to the `computer` object (above) — see the note there. It rode `notebook`
      // (memory) originally, but the interactive office has no placed notebook, so the tool was absent while the prompt
      // demanded it. It belongs with compute (the always-present freebie), not with placeable memory.
    ],
    // M5: object = capability made real — placing these grants the agent real-world reach.
    cabinet: [
      { capId: 'cabinet', tool: 'fs.read', scope: 'read', requiresConsent: false, network: false },
      { capId: 'cabinet', tool: 'fs.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'cabinet', tool: 'fs.search', scope: 'read', requiresConsent: false, network: false },
      { capId: 'cabinet', tool: 'fs.write', scope: 'write', requiresConsent: true, network: false },
      { capId: 'cabinet', tool: 'fs.append', scope: 'write', requiresConsent: true, network: false },
      { capId: 'cabinet', tool: 'fs.edit', scope: 'write', requiresConsent: true, network: false },
      { capId: 'cabinet', tool: 'fs.patch', scope: 'write', requiresConsent: true, network: false }
    ],
    dish: [
      { capId: 'web', tool: 'web_search', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'web_fetch', scope: 'read', requiresConsent: false, network: true },
      // web_request calls a third-party API AS the Commander (it spends a stored key), so unlike the two
      // keyless readers above it always asks. Its unattended use is additionally gated per-key.
      { capId: 'web', tool: 'web_request', scope: 'execute', requiresConsent: true, network: true },
      // The INTEGRATION readout that keeps web_request honest: which connectors/keys are live, and which vetted
      // ones the Commander could add but has not. Rides `dish` because web_request is the route a key is actually
      // spent through — a station with no dish has no reach to advertise. Local read, no network, no consent, no
      // secret (names and env-var names only). NOT deferred: it is the cure for not knowing what exists, so it
      // cannot itself be a tool the agent must already suspect exists to find. (see tools/builtin/connectors.js)
      { capId: 'web', tool: 'connectors.list', scope: 'read', requiresConsent: false, network: false },
      // DEFERRED (`deferred: true`) — still GRANTED, just not advertised in every request. The browser family
      // alone is 29 tools / ~10.2KB of the 37.7KB of schemas re-sent on EVERY turn (measured at the wire), and
      // an agent needs about six of them to drive a page. A deferred tool stays fully dispatchable; the model
      // finds it with tool.search, which reveals it for the rest of the run. Deferral is NOT a capability
      // decision — resolveTools still returns it in `tools`, so the gate, consent, and toolset kill-switch all
      // behave exactly as before. Core is the DEFAULT: omitting the flag advertises the tool, so a new tool can
      // never go silently unreachable, only make requests slightly fatter.
      { capId: 'web', tool: 'browser.navigate', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.snapshot', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.get_text', scope: 'read', requiresConsent: false, network: true },
      /* NOT deferred, for the same measured reason browser.screenshot is not: a waiting tool the model
         cannot see is a waiting tool it replaces with a guess, and the guess is the flake. It has to be
         in the front row next to snapshot or it does not get used at the moment it is needed. */
      { capId: 'web', tool: 'browser.wait', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.find', scope: 'read', requiresConsent: false, network: true },
      /* Deferred: browser.attach is a specialist door, not part of the ordinary browsing loop, and every
         tool in the front row costs prompt weight on every single request. An agent that needs the
         Commander's real signed-in browser will find it through tool.search when the task calls for it —
         which is also the moment a human is around to answer its consent card. */
      { capId: 'web', tool: 'browser.attach', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      { capId: 'web', tool: 'browser.detach', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      /* Deferred, same reasoning as attach: specialist moves, not the ordinary browse loop. pdf is a
         READ (render what is already on screen into the jail); intercept/emulate reshape only the
         STATION browser and both refuse in attached mode (ownership — the Commander's own Chrome is
         not the station's to reconfigure). */
      { capId: 'web', tool: 'browser.pdf', scope: 'read', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.intercept', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.emulate', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.console', scope: 'read', requiresConsent: false, network: true, deferred: true },
      // NOT deferred, and this was measured rather than reasoned. "Show me the page" is a headline request,
      // and a model that cannot see the tool does not always go looking: with browser.screenshot deferred,
      // gpt-4.1-mini never searched and then REPORTED TAKING A SCREENSHOT IT NEVER TOOK; with the same tool
      // advertised it called it and reported honestly. A byte saving that buys a fabricated result is not a
      // saving. vision rides the same rule — it is the other half of "look at the page".
      // The line: defer SPECIALIST tools, never a headline capability the model may claim it performed.
      { capId: 'web', tool: 'browser.vision', scope: 'read', requiresConsent: false, network: true },
      // requiresConsent:false is NOT a free pass — browser.login runs its OWN two-phase live consent
      // (open-window ask + done-wait) inside the tool; the generic broker card would double-prompt.
      { capId: 'web', tool: 'browser.login', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.click', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.type', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.press', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.dialog', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      { capId: 'web', tool: 'browser.scroll', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.back', scope: 'execute', requiresConsent: false, network: true },
      // A tool that exists in browser.js but is absent HERE is withheld from every real agent, however
      // well it is tested elsewhere — this list, not the tool module, is what resolveTools grants.
      // browser.tool-parity.test.js pins the two together so the next addition cannot go dark.
      { capId: 'web', tool: 'browser.forward', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.hover', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.viewport', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.screenshot', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.network', scope: 'read', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.inspect', scope: 'read', requiresConsent: false, network: true, deferred: true },
      // Page eval is consent-gated AND refused outright on the signed-in station profile (see browser.js).
      { capId: 'web', tool: 'browser.eval', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      { capId: 'web', tool: 'browser.tabs', scope: 'read', requiresConsent: false, network: true, deferred: true },
      { capId: 'web', tool: 'browser.tab_select', scope: 'execute', requiresConsent: false, network: true, deferred: true },
      // consent-gated: these change page/form state, post a file, or destroy a tab.
      { capId: 'web', tool: 'browser.select', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      { capId: 'web', tool: 'browser.drag', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      { capId: 'web', tool: 'browser.upload', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      { capId: 'web', tool: 'browser.tab_close', scope: 'execute', requiresConsent: true, network: true, deferred: true },
      // Real-screen desktop.open is not an ordinary run capability. The implementation remains
      // registered inertly for a future separate attended host channel, never a placed dish.
      // ---- COMMS: OUTBOUND messaging reach (see tools/builtin/comms.js) ----
      // The dish is the station's antenna: it already means "this agent can reach OUT past the station walls".
      // Fetching a page and transmitting a message are the same physical claim on that prop, so outbound
      // messaging hangs here rather than on a new object type. It is its OWN capId — NOT 'web' — precisely so a
      // Commander who wants search-and-browse without letting an agent message people can switch COMMS off
      // alone in the TOOLSETS console (a shared capId would make that impossible; see toolsets.js).
      { capId: 'comms', tool: 'channel.targets', scope: 'read', requiresConsent: false, network: false },
      // channel.send carries content OUT to a third party under the Commander's own bot identity — the single
      // most consequential outward action in the tool surface and the obvious prompt-injection exfiltration
      // target. execute + consent, like web_request and the Spotify controls: it asks every time until the
      // Commander grants it, and an autonomous run therefore cannot spend it off a cached grant.
      { capId: 'comms', tool: 'channel.send', scope: 'execute', requiresConsent: true, network: true }
    ],
    // CONNECTORS: a 'connector' object is a DYNAMIC capability — its grants are the tools its configured MCP
    // server reports at runtime (tools/list), which can't be statically listed here. The connector manager
    // (sidecar/mcp/manager.js) unions those live tool names into the agent's resolved set per run; the placed
    // instance's binding ({ connectorId }) selects WHICH server. This empty marker just declares 'connector' a
    // known, placeable capability object so the builder/world can treat it like any other room object.
    connector: [],
    // WORKBENCH: real code execution (shell.exec). Opt-in per agent by PLACING this object — no object, no shell,
    // exactly like cabinet=files. scope 'execute' so the consent broker's exec-lockout binds it: an autonomous
    // run can NEVER execute off a cached grant (only an interactive human, or frozen FULL_ACCESS, may approve).
    // The host auto-checkpoints the workspace before every shell call (execution-spine Commit 1), so a command
    // is one rollback away. (Container/job-object OS sandboxing is a deferred backend behind the same tool seam.)
    workbench: [
      { capId: 'workbench', tool: 'shell.exec', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'workbench', tool: 'verify.run', scope: 'execute', requiresConsent: true, network: true },
      // Local UI/game verification stays inside StarNet's headless CDP session. Pointer/keyboard
      // lock is emulated in-page, and coordinate/key input is synthetic — never Win32 input.
      // Deferred: a run that places the workbench is usually there to run shell, not to drive the local UI
      // harness. Still granted and dispatchable — tool.search reveals the set when a UI check is what's needed.
      { capId: 'workbench', tool: 'browser.test_navigate', scope: 'read', requiresConsent: false, network: true, deferred: true },
      { capId: 'workbench', tool: 'browser.test_snapshot', scope: 'read', requiresConsent: false, network: false, deferred: true },
      { capId: 'workbench', tool: 'browser.test_input', scope: 'execute', requiresConsent: false, network: false, deferred: true },
      { capId: 'workbench', tool: 'browser.test_state', scope: 'read', requiresConsent: false, network: false, deferred: true },
      { capId: 'workbench', tool: 'shell.bg.status', scope: 'read', requiresConsent: false, network: false },   // H2.2: inspect your background processes
      { capId: 'workbench', tool: 'shell.bg.read', scope: 'read', requiresConsent: false, network: false },     // H2.3: page/search its output past the short tail
      // H2.3: stdin. CONSENT-GATED unlike its bg siblings — a line sent to a shell or REPL executes like a
      // command, so it carries shell.exec's gate, not shell.bg.status's.
      { capId: 'workbench', tool: 'shell.bg.write', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'workbench', tool: 'shell.bg.kill', scope: 'write', requiresConsent: false, network: false },     // H2.2: stop a background process you started
      // A real PTY/ConPTY rail for interactive programs. Start + input carry the same execution/consent posture
      // as shell.exec; observation, resize, Ctrl-C and stop remain agent-owned control operations.
      { capId: 'workbench', tool: 'terminal.start', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'workbench', tool: 'terminal.status', scope: 'read', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'terminal.read', scope: 'read', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'terminal.write', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'workbench', tool: 'terminal.resize', scope: 'write', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'terminal.interrupt', scope: 'write', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'terminal.stop', scope: 'write', requiresConsent: false, network: false }
    ],
    // ORCHESTRATOR (Stage 2): grants team.dispatch — the LEAD delegates subtasks to summoned worker agents,
    // each of which runs its OWN real agent loop. dispatch/spawn are CONSENT-GATED (2026-07-14, closes the parked
    // P1 prompt-injection fork): fanning out autonomous budget-spending loops off text in the lead's context needs
    // a human moment in 'ask' mode (session grants stop per-call fatigue; Full Access bypasses) — same semantics
    // as team.summon. The LEAD-ONLY conferral still caps depth at one (the host adds this object ONLY to the
    // watched browser-commanded run), plus the per-worker/day/global budget caps and the concurrency ceiling.
    orchestrator: [
      { capId: 'orchestrator', tool: 'team.dispatch', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'orchestrator', tool: 'team.spawn', scope: 'execute', requiresConsent: true, network: true },
      // team.summon CREATES a new crew member — a stronger, outward-visible mutation than delegating to existing
      // crew, so unlike team.dispatch it IS consent-gated (the APPROVAL-mode confirm beat). Lead-only by the same
      // orchestrator conferral; a delegated worker never gets the orchestrator object and so can never summon.
      { capId: 'orchestrator', tool: 'team.summon', scope: 'write', requiresConsent: true, network: false },
      { capId: 'orchestrator', tool: 'team.subagents', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'team.steer', scope: 'write', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'team.interrupt', scope: 'write', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'team.resume', scope: 'execute', requiresConsent: false, network: true },
      // ROUTINES: create StarNet scheduled jobs through the built-in cron store (the same surface as the
      // ROUTINES panel), never through OS crontab / Windows Task Scheduler. Lead-only like the rest of
      // orchestration; creation is consent-gated because it persists autonomous future work.
      { capId: 'orchestrator', tool: 'routine.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'routine.create', scope: 'write', requiresConsent: true, network: false },
      // routine.manage — edit/pause/resume/delete/queue-a-fire on an EXISTING routine. Consent-gated for the
      // same reason create is: an edit is the same surface as a create (a clean routine can be patched into a
      // standing payload), and pausing or deleting changes what the station does unattended. One action-shaped
      // tool rather than five verbs, because every schema here is re-sent on every turn (see the tool file).
      { capId: 'orchestrator', tool: 'routine.manage', scope: 'write', requiresConsent: true, network: false },
      // SESSIONS (2026-07-30): the lead's session verbs over the station bridge — list/create/focus a
      // workstream by the name the Commander says, completing "make a session called X and have them work
      // in it" (team.dispatch's `session` targets one; these are how it comes to exist). No consent: a
      // session spends nothing and is reversible, and every unresolvable name REFUSES rather than guessing.
      // ⛔ This registry is an ALLOWLIST — a tool registered but not declared here is exposed to NOBODY
      // (that is how these three shipped invisible on the first pass; a live model probe caught it).
      { capId: 'orchestrator', tool: 'session.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'session.create', scope: 'write', requiresConsent: false, network: false },
      // session.peek reads another session's recent turns — the anti-guessing verb: without it a lead asked
      // "what did the researcher do?" answered from assumption and denied real finished work (2026-07-30).
      { capId: 'orchestrator', tool: 'session.peek', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'session.focus', scope: 'write', requiresConsent: false, network: false },
      // TASK BOARD: cards are the page's canonical kind:'task' Workstreams and are persisted through the same
      // agent save the board renders. Creation is reversible and spends nothing; management is consent-gated
      // because its action set includes shipping, archiving, reassignment, and deletion.
      { capId: 'orchestrator', tool: 'task.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'task.create', scope: 'write', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'task.manage', scope: 'write', requiresConsent: true, network: false },
      { capId: 'orchestrator', tool: 'team.config', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'team.configure', scope: 'write', requiresConsent: true, network: false },
      // LOOPS: standing objective iteration through loops.json. Both mutations require consent because they
      // create or alter future autonomous work. Model tools never accept the host-run check command.
      { capId: 'orchestrator', tool: 'loop.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'loop.create', scope: 'write', requiresConsent: true, network: false },
      { capId: 'orchestrator', tool: 'loop.manage', scope: 'write', requiresConsent: true, network: false }
    ],
    // STUDIO (media skills): text->image generation + image vision analysis, both on the SAME BYOK OpenRouter
    // key the agent already uses (no new provider). image_generate WRITES a file into the agent's workspace, so
    // it is consent-gated like fs.write; image_analyze only READS an image and returns text (consent-free).
    studio: [
      { capId: 'studio', tool: 'image_generate', scope: 'write', requiresConsent: true, network: true },
      { capId: 'studio', tool: 'image_analyze', scope: 'read', requiresConsent: false, network: true },
      // voice_generate SPEAKS to a file — the studio's third skill. Consent-gated for the same reason
      // image_generate is: it writes into the workspace. It rides the station's existing TTS ladder (the keyed
      // neural chain, then the free keyless Edge floor), so it needs no studio-specific credential — but it
      // does reach the network on the keyed legs. (see tools/builtin/voice.js)
      { capId: 'studio', tool: 'voice_generate', scope: 'write', requiresConsent: true, network: true }
    ],
    // JUKEBOX (Spotify): querying playback/library is consent-free (read); CONTROLLING playback is an outward
    // action on the user's account/device, so it is execute + consent-gated. The OAuth session (PKCE, no secret)
    // lives in sidecar/spotify/store.js; an unconnected Spotify makes each tool fail with a "connect it" message.
    jukebox: [
      { capId: 'jukebox', tool: 'spotify_search', scope: 'read', requiresConsent: false, network: true },
      { capId: 'jukebox', tool: 'spotify_now_playing', scope: 'read', requiresConsent: false, network: true },
      { capId: 'jukebox', tool: 'spotify_playlists', scope: 'read', requiresConsent: false, network: true },
      { capId: 'jukebox', tool: 'spotify_play', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_pause', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_next', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_previous', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_queue', scope: 'execute', requiresConsent: true, network: true }
    ]
  };

  function deepFreeze(o) {
    Object.freeze(o);
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }
    return o;
  }
  deepFreeze(CAP_REGISTRY);

  return { CAP_REGISTRY };
});
