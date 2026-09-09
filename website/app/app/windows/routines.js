/* STARNET — windows/routines.js : the ROUTINES lane of the AUTOMATION window (extracted from stationui.js).
   Loads AFTER stationui.js and windows/automation.js (see index.html) and registers itself as an
   AutomationWindow LANE — its two sections (ACTIVE ROUTINES · CREATE ROUTINE) mount inside the shared
   AUTOMATION console rather than a window of their own (NAV CONDENSE 2026-08-04). The only stationui
   internals it touches are the enumerated StationUI.h helper surface
   (esc/sfx/notify/fmtRel, consoleSection, and the live present/sel views). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || typeof AutomationWindow === 'undefined') return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, notify = H.notify, fmtRel = H.fmtRel;
  const consoleSection = H.consoleSection;
  let routineAgentId = 'agent'; // selected roster agent for new scheduled routines (window-local state)

  // the browser's IANA zone, or undefined when the runtime won't resolve one (then the host default
  // applies server-side, exactly as before). Sent with every create / preview / reschedule so all three
  // agree about which 9:00 they mean.
  function deviceTz() {
    try { return (Intl.DateTimeFormat().resolvedOptions().timeZone) || undefined; } catch (_) { return undefined; }
  }
  /* an authoritative ISO instant -> the viewer's own wall clock ("Thu, Aug 13, 5:30 PM EDT"). Pure
     display: the instant comes from the server's schedule math, this only decides which clock face it is
     read off. '' when the runtime has no Intl/zone, so callers fall back to the server's own rendering. */
  function wallClock(iso) {
    const t = Date.parse(String(iso || ''));
    if (isNaN(t)) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        hour12: true, timeZoneName: 'short'
      }).format(t);
    } catch (_) { return ''; }
  }
  /* cron.js's display string -> the sentence we actually show ("cron 0 9 * * 2" -> "every Tuesday at
     9:00 AM"). CronHuman falls back to the RAW display for any shape it cannot state exactly, and so do
     we if the module is missing — a schedule label never guesses. */
  function human(display) {
    return (typeof CronHuman !== 'undefined' && CronHuman.describeDisplay)
      ? CronHuman.describeDisplay(display, { tz: deviceTz() })
      : String(display == null ? '' : display);
  }

  /* ============== ROUTINES — scheduled autonomous runs (server-owned cron) ==============
     A routine wakes on a schedule and runs the agent UNATTENDED. The definitions live SERVER-side
     (schedule + boot-frozen secrets never touch the browser), so this panel is a thin CRUD client over
     /api/cron — render from GET, mutate via POST, re-fetch. Honest by construction: it shows a next-fire /
     last-result only from real server data, and says plainly when the scheduler tick is off. */
  function routinesLane(body) {
    const roster = H.present.length ? H.present : [{ id: 'agent', name: 'Agent', color: 'var(--ph)' }];
    const hasSelected = roster.some(a => a && a.id === routineAgentId);
    if (!hasSelected) routineAgentId = (H.present[H.sel] && H.present[H.sel].id) || (roster[0] && roster[0].id) || 'agent';
    function agentFor(id) { return roster.find(a => a && a.id === id) || null; }
    function agentLabel(id) {
      const a = agentFor(id);
      if (!a) return id || 'agent';
      const nm = a.name || a.id;
      return nm === a.id ? nm : (nm + ' [' + a.id + ']');
    }
    function agentButton(a) {
      const id = (a && a.id) || 'agent';
      const nm = (a && (a.name || a.id)) || id;
      const active = id === routineAgentId;
      return '<button type="button" class="rt-agent-btn' + (active ? ' active' : '') + '" data-agent="' + esc(id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" style="--rt-agent-color:' + esc((a && a.color) || 'var(--ph)') + '">' +
        '<span class="rt-agent-dot"></span><span class="rt-agent-name">' + esc(nm) + '</span><span class="rt-agent-id">' + esc(id) + '</span></button>';
    }
    // CONSOLE MODE: two sections — ACTIVE ROUTINES (the state you check: gate badge + suggest CTA + list) and
    // CREATE ROUTINE (the whole form + preview + run-output). A third grouping felt forced, so 2 it is. Every id /
    // data-attr / wiring stays; the markup just moved into panes (mountConsole appends its host to `body`, so the
    // body.querySelector wiring below resolves unchanged).
    const secActive =
      '<div id="rt-gate" class="set-about"></div>' +
      // SELF-INITIATION (autonomy Slice 2): let the agent propose standing jobs grounded in what it knows about you.
      '<button class="bb sm" id="rt-propose" style="margin:2px 0 6px">✦ SUGGEST ROUTINES</button>' +
      '<div id="rt-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      // P0 #11: a RUN NOW result renders HERE, inline under the row the user clicked — never into the hidden CREATE
      // pane. It lives in the ACTIVE pane (sibling of #rt-list) so a list re-render can't destroy it; positionOut()
      // re-slots it under its row after each refresh.
      '<div id="rt-out" class="msg rt-out" hidden></div>';
    const secCreate =
      '<div class="mc-form rt-simple-create">' +
        '<div class="rt-identity"><label class="sn-menu-field">Name<input id="rt-name" class="key-input" placeholder="e.g. Morning research brief" maxlength="80" autocomplete="off"></label>' +
        '<label class="sn-menu-field">Agent<select id="rt-agent-select" class="key-input">' + roster.map(a => '<option value="' + esc(a.id) + '"' + (a.id === routineAgentId ? ' selected' : '') + '>' + esc(a.name || a.id) + '</option>').join('') + '</select></label></div>' +
        '<div hidden><div class="rt-agent-pick">' + roster.map(agentButton).join('') + '</div></div><input id="rt-agent" type="hidden" value="' + esc(routineAgentId) + '">' +
        '<label class="sn-menu-field">What should it do?<textarea id="rt-prompt" class="key-input" rows="2" placeholder="e.g. Find three research updates and summarize them with source links." style="resize:vertical"></textarea></label>' +
        // WHEN — the schedule PICKER (frontend/app/schedpicker.js). It owns the `#rt-sched` text input and
        // types into it, so the preview below, #rt-add, the QA journey and every existing selector are
        // unchanged; without the module we fall back to that same bare input, never to a dead form.
        '<div class="rt-when" id="rt-when"><div class="rt-when-k">When</div>' +
        (typeof SchedPicker !== 'undefined'
          ? SchedPicker.html({ inputId: 'rt-sched', compact: true })
          : '<input id="rt-sched" class="key-input" placeholder="schedule — every 30m · 0 9 * * * · in 2h" autocomplete="off">') +
        '</div>' +
        '<div id="rt-preview" class="dim" style="min-height:1em;font-size:.9em"></div>' +
        '<details class="sn-menu-options"><summary>Access &amp; other options</summary>' +
          '<div class="sn-menu-tabs" role="group" aria-label="Advanced schedule options">' +
          ['Context', 'Execution', 'Delivery', 'Access'].map((label, i) => '<button type="button" data-auto-tab="' + i + '" aria-pressed="' + (i === 0) + '">' + label + '</button>').join('') + '</div>' +
          '<div data-auto-panel="0"><p class="sn-menu-note">Give each run the files and background it needs.</p>' +
            '<label class="sn-menu-field">Project folder<input id="rt-workdir" class="key-input" placeholder="Approved absolute path (optional)"></label>' +
            '<label class="sn-menu-field">Saved skills<input id="rt-skills" class="key-input" placeholder="Skill names, separated by commas"></label>' +
            '<label class="sn-menu-field">Results from other routines<input id="rt-context" class="key-input" placeholder="Routine IDs, separated by commas"></label></div>' +
          '<div data-auto-panel="1" hidden><p class="sn-menu-note">Optional script and tool restrictions for this job.</p>' +
            '<label class="sn-menu-field">Pre-check script<input id="rt-script" class="key-input" placeholder="Path relative to the project"></label>' +
            '<label class="rt-term"><input type="checkbox" id="rt-no-agent"> Run the script only, without a model</label>' +
            '<label class="sn-menu-field">Allowed toolsets<input id="rt-toolsets" class="key-input" placeholder="Comma-separated; blank uses station defaults"></label></div>' +
          '<div data-auto-panel="2" hidden><p class="sn-menu-note">Choose where the result goes.</p>' +
            '<label class="sn-menu-field">Result destination<select id="rt-deliver" class="key-input"><option value="local">Keep in StarNet</option><option value="origin">Return to this conversation</option></select></label>' +
            '<label class="rt-term"><input type="checkbox" id="rt-continue"> Allow follow-up in that conversation</label></div>' +
        '<div data-auto-panel="3" hidden><p class="sn-menu-note">This routine inherits the agent’s existing access. These optional grants allow additional unattended actions.</p>' +
        // UNATTENDED TERMINAL GRANT — default OFF, and it must stay a deliberate tick: this is the one control
        // that lets a scheduled run execute commands with nobody watching. The label states the risk plainly
        // rather than selling the feature (truthful telemetry applies to consent copy too).
        '<label class="rt-term" for="rt-term" style="display:flex;gap:.5em;align-items:flex-start;cursor:pointer">' +
          '<input type="checkbox" id="rt-term" style="margin-top:.25em">' +
          '<span>Let this routine use the <b>terminal</b> ' +
          '<span class="dim">— runs shell commands and tests unattended, with nobody watching. Only for routines you trust.</span></span>' +
        '</label>' +
        // UNATTENDED CONNECTOR GRANT — separate tick from the terminal: an MCP call reaches an outside service
        // but gets no host-process capability, so the two have genuinely different blast radii and must not be
        // bundled behind one consent. Also default OFF.
        '<label class="rt-term" for="rt-conn" style="display:flex;gap:.5em;align-items:flex-start;cursor:pointer">' +
          '<input type="checkbox" id="rt-conn" style="margin-top:.25em">' +
          '<span>Let this routine use your <b>connected tools</b> ' +
          '<span class="dim">— the MCP connectors you set up in ⇄ ABILITIES, called unattended on your behalf. Connectors you switched off stay off.</span></span>' +
        '</label>' +
        '</div>' +
        '</details>' +
        '<div id="rt-create-state" class="set-about" role="status">Checking scheduling status…</div><button class="bb sm" id="rt-add">SAVE SCHEDULE</button>' +
      '</div>' +
      '<div id="rt-msg" class="msg"></div>';
    const frag = h => (el => { el.innerHTML = h; });
    // section ids are namespaced (routines / routines-create) because they share the AUTOMATION console's
    // rail with the loops lane — 'active' alone would collide. wire() runs after mountConsole has appended
    // every pane to `body`, so all the querySelector wiring below resolves exactly as it always did.
    const sections = [
      { id: 'routines', label: 'ACTIVE ROUTINES', glyph: '◷', desc: 'Standing jobs that fire on a schedule — their next run, last result, and whether the scheduler is armed.', build: frag(secActive) },
      { id: 'routines-create', label: 'CREATE ROUTINE', glyph: '✦', desc: 'Put your agent to work on a schedule — a morning brief, a nightly summary, a recurring check.', build: frag(secCreate) }
    ];
    function wire() {
    const listEl = body.querySelector('#rt-list'), gateEl = body.querySelector('#rt-gate');
    const msgEl = body.querySelector('#rt-msg'), outEl = body.querySelector('#rt-out');
    const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    // P0 #11 — run-output placement. lastRunId = the routine whose RUN NOW result #rt-out currently shows.
    // schedulerArmed mirrors GET /api/cron `.enabled` (set in refresh) so the create-confirm can tell the honest
    // armed/disarmed story via AutoJobs.armStateLine. #rt-out lives in the ACTIVE pane (sibling of #rt-list); when a
    // run fires we splice it in right AFTER its row, and after every list re-render positionOut() re-slots it there.
    let lastRunId = null, schedulerArmed = false;
    function showRunOut(rowEl, id) {
      lastRunId = id;
      const nmEl = rowEl && rowEl.querySelector('.mc-top b');
      const nm = (nmEl && nmEl.textContent) || 'routine';
      outEl.hidden = false;
      outEl.innerHTML = '<div class="rt-out-h">▶ RAN <b>' + esc(nm) + '</b><button class="rt-out-x bb xs" type="button" title="dismiss">✕</button></div><div class="rt-out-b">running…</div>';
      if (rowEl) rowEl.insertAdjacentElement('afterend', outEl);
    }
    function positionOut() {
      if (outEl.hidden) return;
      let placed = false;
      if (lastRunId) listEl.querySelectorAll('.mc-row').forEach(r => { if (!placed && r.dataset.id === lastRunId) { r.insertAdjacentElement('afterend', outEl); placed = true; } });
      if (!placed) listEl.insertAdjacentElement('afterend', outEl);   // its row is gone (deleted) → park below the list
    }
    outEl.addEventListener('click', ev => { if (ev.target.closest('.rt-out-x')) { outEl.hidden = true; outEl.innerHTML = ''; lastRunId = null; sfx('click'); } });

    /* WHAT THIS ROUTINE RUNS. A routine whose record carries `runsLine` (minted from a line's INBOX trigger
       zone) fires the WHOLE line from its dock — say so, naming the line and the dock count, read off the
       same compiled plan the sidecar routes by (Build.lineOfAgentInfo). No line resolvable (floor edited,
       REFIT not loaded) -> the plain "runs as" copy: never claim a line the harness can't prove. */
    function runsLine(j) {
      const who = esc(agentLabel(j.agentId || 'agent'));
      if (j.runsLine !== true) return 'runs as ' + who;
      const info = (typeof Build !== 'undefined' && Build.lineOfAgentInfo) ? Build.lineOfAgentInfo(j.agentId) : null;
      if (!info) return 'runs as ' + who;
      return 'runs the <b>' + esc((info.name || 'unnamed').toUpperCase()) + '</b> line from ' + who + ' (' + info.docks + ' dock' + (info.docks === 1 ? '' : 's') + ')';
    }
    /* THE LAST RUN'S SPEND — the routine's own record (`lastUsd`), which for a runsLine routine is the WHOLE
       line's spend (entry run + every hop; cron-driver / Run Now both add the chain's usd before markRun).
       Shown only once a run has settled; $0 is printed honestly when the provider was unmetered. */
    function spendLine(j) {
      if (!j.lastRunAt) return '';
      const usd = Number(j.lastUsd);
      if (!isFinite(usd)) return '';
      const txt = usd >= 0.01 ? ('$' + usd.toFixed(2)) : usd > 0 ? ('$' + usd.toFixed(4)) : '$0';
      return ' · <span class="mc-spend" title="' + (j.runsLine === true ? 'what the whole line spent on its last run (entry + every hop)' : 'what the last run spent') + '">' + txt + (j.runsLine === true ? ' line' : '') + '</span>';
    }
    function lastResult(j) {
      if (!j.lastRunAt) return '<span class="dim">never run</span>';
      const ok = j.lastStatus === 'ok';
      return '<span class="' + (ok ? 'pos' : '') + '"' + (ok ? '' : ' style="color:var(--bad)"') + '>' + (ok ? '✓ ok' : '✕ ' + esc(j.lastReason || 'error')) + '</span> <span class="dim">' + esc(fmtRel(j.lastRunAt)) + '</span>';
    }
    // TICKER HEALTH (scheduler-audit GA-9): armed alone can't prove ticks are completing. GET /api/cron carries a
    // real observed `health` block; render it beside the armed banner. Only meaningful when armed (a disarmed
    // scheduler is honestly idle — the OFF banner already owns that story), so return '' otherwise.
    function tickHealthLine(cron) {
      const hh = cron && cron.health;
      if (!cron || !cron.enabled || !hh) return '';
      // cronHealth timestamps are epoch-ms NUMBERS (Date.now()), not ISO strings like the per-job fields — normalize
      // to ISO so fmtRel (which Date.parse()es a string) reads them instead of falling through to '—'.
      const relOf = t => fmtRel(typeof t === 'number' ? new Date(t).toISOString() : t);
      if (hh.healthy) {
        const age = hh.lastSuccessAt != null ? relOf(hh.lastSuccessAt) : 'just now';
        return ' <span class="dim">· tick healthy — last success ' + esc(age) + '</span>';
      }
      // Armed but not proven healthy: surface WHY, never a fake-green. A real tick error wins; otherwise we honestly
      // say we're still waiting for the first successful tick (no success timestamp yet).
      if (hh.lastTickError) return ' <span style="color:var(--bad)">· tick error — ' + esc(hh.lastTickError) + '</span>';
      return ' <span class="dim">· waiting for first tick…</span>';
    }
    // Per-job DELIVERY OUTCOME (scheduler-audit): a routine can succeed while its channel notification fails — that
    // failure is durable (cron-store markDelivery) and must be visible, never swallowed. Show ONLY a failure (the
    // error string already carries the channel in [brackets]); a success or a never-delivered job shows nothing
    // (honest no-signal — we never invent a "delivered" state the job never attempted).
    function deliveryLine(j) {
      if (!j.lastDeliveryAt || j.lastDeliveryOk !== false) return '';
      return '<div class="mc-detail" style="color:var(--bad)">✕ delivery failed — ' + esc(j.lastDeliveryError || 'notification could not be sent') +
        ' <span class="dim">' + esc(fmtRel(j.lastDeliveryAt)) + '</span></div>';
    }
    // CONSECUTIVE-FAILURE AUTO-PAUSE (routine hardening, 2026-08-21): the store counts terminal failures in a row
    // and disables the job at the ceiling with disabledReason:'consecutive-failures'. Both fields come straight
    // off GET /api/cron (real store state) — a paused-by-failures row says so, and a still-enabled row with a
    // streak shows how close it is to the ceiling. Nothing is rendered for a clean job (honest no-signal).
    let maxConsecutive = 0;   // GET /api/cron .maxConsecutiveFailures (0 = the ceiling is off)
    function failureStreakLine(j) {
      const n = Number(j.consecutiveFailures) || 0;
      if (j.enabled === false && j.disabledReason === 'consecutive-failures') {
        return '<div class="mc-detail" style="color:var(--bad)">paused automatically after ' + n + ' failure' + (n === 1 ? '' : 's') + ' in a row' +
          (j.disabledAt ? ' <span class="dim">' + esc(fmtRel(j.disabledAt)) + '</span>' : '') +
          ' <span class="dim">— fix it, then ENABLE to clear the streak</span></div>';
      }
      if (n > 0 && j.enabled !== false) {
        return '<div class="mc-detail dim">' + n + ' failure' + (n === 1 ? '' : 's') + ' in a row' +
          (maxConsecutive > 0 ? ' — pauses at ' + maxConsecutive : '') + '</div>';
      }
      return '';
    }
    function row(j) {
      const on = j.enabled;
      const autoPaused = !on && j.disabledReason === 'consecutive-failures';
      // A SETTLED ONE-SHOT is DONE, not paused: the backend permanently refuses to re-arm it (planTick's
      // lastRunAt bar), so drawing "○ paused" with an ENABLE button promised a fire that can never happen —
      // ENABLE round-tripped and the row then read "● scheduled · next 3d ago" forever. RESCHEDULE (which
      // genuinely re-arms it with a fresh time) is the honest re-run path and stays.
      const completedOnce = !on && j.state === 'completed' && j.schedule && j.schedule.kind === 'once';
      // real lease state off GET /api/cron (additive `inFlight`) — never synthesized client-side.
      const running = j.inFlight === true;
      const stateBadge = running ? '<span style="color:var(--gold)">● running</span>'
        : completedOnce ? '<span style="color:var(--good,var(--gold))">✓ completed</span>'
        : on ? '<span style="color:var(--gold)">● scheduled</span>'
        : autoPaused ? '<span style="color:var(--bad)">○ paused — failing</span>'
        : '<span class="dim">○ paused</span>';
      // A routine can remain scheduled while E-STOP has durably stood down the global scheduler. Keep the saved
      // scheduled badge, but never run a moving countdown for work the host has proven will not fire.
      const next = on && schedulerArmed && j.nextRunAt ? esc(fmtRel(j.nextRunAt)) : '—';
      // R3 provenance: a routine minted from a recipe (meta.recipeId) shows "from recipe: <name>". Resolve the live
      // recipe name when we can; fall back to the id (never lies — a deleted recipe still shows its id). Tolerates
      // an absent meta (every pre-R3 job) — no badge then.
      const recipeId = j.meta && j.meta.recipeId;
      let fromRecipe = '';
      if (recipeId) {
        const rec = (typeof Recipes !== 'undefined' && Recipes.get) ? Recipes.get(recipeId) : null;
        fromRecipe = ' <span class="mc-from-recipe" title="scheduled from a recipe">❒ from recipe: ' + esc(rec ? rec.name : recipeId) + '</span>';
      }
      // UNATTENDED TERMINAL GRANT — a standing permission to run commands with nobody watching must be VISIBLE
      // on the row that holds it, not buried in the record. Absent/empty on every ungranted routine -> no badge.
      const grantsOf = Array.isArray(j.unattendedGrants) ? j.unattendedGrants : [];
      const grantBadge = (on2, label, title) => on2
        ? ' <span class="mc-term-grant" title="' + esc(title) + '" style="color:var(--warn,var(--gold))">' + label + '</span>'
        : '';
      const termBadge =
        grantBadge(grantsOf.indexOf('workbench') >= 0, '⌘ terminal', 'this routine may run shell commands unattended') +
        grantBadge(grantsOf.indexOf('connectors') >= 0, '⧉ connected tools', 'this routine may call your MCP connectors unattended');
      const skillCount = Array.isArray(j.skills) ? j.skills.length : 0;
      const runtimeBadge =
        grantBadge(!!j.noAgent, '⚙ script only', 'this routine completes without calling a model') +
        grantBadge(!!j.script && !j.noAgent, '⚙ pre-check', 'a script decides whether the agent should wake') +
        // `skills` may be absent on a hand-seeded / older job — an undefined read here threw and the catch painted
        // "sidecar offline" over a perfectly live panel (stranded-user sweep, 2026-08-22). Guard every array read.
        grantBadge(skillCount > 0, '✦ ' + skillCount + ' skill' + (skillCount === 1 ? '' : 's'), 'saved skills preload on every run') +
        grantBadge(!!(j.contextFrom && j.contextFrom.length), '⇢ pipeline', 'uses successful output from upstream routines') +
        grantBadge(j.enabledToolsets != null, '⊣ restricted tools', 'this routine has an explicit per-job toolset intersection') +
        grantBadge(String(j.deliver || 'local') !== 'local', '↗ delivery', 'results are delivered to approved destinations');
      // the cadence in words, with the exact expression kept as the tip — a beginner reads "every Tuesday
      // at 9:00 AM", and the audit string that actually fires the job is one hover away, never hidden.
      const sched = j.scheduleDisplay || '';
      const schedHuman = human(sched);
      return '<div class="mc-row" data-id="' + esc(j.id) + '" data-on="' + (on ? '1' : '0') + '" data-sched="' + esc(sched) + '">' +
        '<div class="mc-top"><b>' + esc(j.name || '(unnamed)') + '</b> <span class="dim"' +
          (schedHuman !== sched ? ' title="' + esc(sched) + '"' : '') + '>' + esc(schedHuman) + '</span> ' + stateBadge + termBadge + runtimeBadge + fromRecipe + '</div>' +
        '<div class="mc-url dim">' + runsLine(j) + ' · next ' + next + ' · last ' + lastResult(j) + spendLine(j) + '</div>' +
        (j.lastError ? '<div class="mc-detail">' + esc(j.lastError === 'schedule-unfireable' ? 'schedule can never fire — reschedule this routine' : j.lastError) + '</div>' : '') +
        failureStreakLine(j) +
        deliveryLine(j) +
        '<div class="mc-acts">' +
          '<button class="bb xs" data-act="run"' + (running ? ' disabled title="already running — one run per routine"' : '') + '>▶ RUN NOW</button>' +
          // RESCHEDULE — the same picker, opened on this routine's current schedule. Before this you could
          // only DELETE and re-create a routine to move it an hour, which also threw away its run history.
          '<button class="bb xs" data-act="resched">◷ RESCHEDULE</button>' +
          // no toggle on a settled one-shot: ENABLE can't re-arm it (see completedOnce above)
          (completedOnce ? '' : '<button class="bb xs" data-act="toggle">' + (on ? '⏸ DISABLE' : '▶ ENABLE') + '</button>') +
          // REVOKE — a standing unattended permission must be withdrawable without deleting the routine.
          // Only rendered when there is something to revoke, so an ordinary routine's action row is unchanged.
          (grantsOf.length ? '<button class="bb xs" data-act="revoke" title="stop this routine using the terminal / your connected tools">⌫ REVOKE ACCESS</button>' : '') +
          '<button class="bb xs danger" data-act="remove">✕ DELETE</button>' +
        '</div></div>';
    }
    async function refresh() {
      try {
        // Publish the same read-back to the widget rail and every scheduler consumer.
        // Otherwise create/arm/pause updates this panel while NEXT ROUTINE lags a full poll.
        const j = typeof QuerySpine !== 'undefined' && QuerySpine.refresh
          ? (await QuerySpine.refresh('cron')).data : await Harness.api.get('/api/cron');
        const jobs = (j && j.jobs) || [];
        // the live cronArmed — feeds the create-confirm's honest arm-state line. A HALTED scheduler is not armed no
        // matter what the intent flag says, or the create-confirm promises a fire that an E-STOP is holding down.
        schedulerArmed = !!(j && j.enabled && !j.halted);
        const createState = body.querySelector('#rt-create-state');
        if (createState) createState.textContent = schedulerArmed ? 'Scheduling is enabled. Saving adds this task to the schedule shown below.' : 'Scheduling is off. You can save a routine, but it will not run automatically until you enable scheduling in Active Routines.';
        maxConsecutive = (j && Number(j.maxConsecutiveFailures)) || 0;
        // DEGRADED STORE (routine hardening, 2026-08-21): GET /api/cron carries `degraded` when cron.jobs.json AND
        // its .bak were both unreadable at boot. The sidecar quarantined the file, froze the scheduler, and refuses
        // to persist an empty list until the Commander accepts the loss. Say so loudly; the one action is explicit.
        const degraded = j && j.degraded;
        const degradedBlock = degraded
          ? '<div class="brief-block" style="border-left-color:var(--bad);margin-bottom:8px">' +
              '<div class="brief-k" style="color:var(--bad)">✕ ROUTINE STORE IS DAMAGED</div>' +
              '<div class="brief-v">The saved routines file could not be read and no backup was usable. It was moved aside, <b>not erased</b>, and ' +
              'routines are frozen so nothing is overwritten.' +
              (degraded.quarantinePath ? '<div class="dim" style="margin-top:4px;font-size:11px;word-break:break-all">quarantined copy: ' + esc(degraded.quarantinePath) + '</div>' : '') +
              '<div class="dim" style="margin-top:4px;font-size:11px">Restore that file as cron.jobs.json and restart, or accept the loss to start over.</div>' +
              '<div style="margin-top:8px"><button class="bb xs danger" id="rt-degraded-clear">✕ ACCEPT LOSS AND CONTINUE</button></div>' +
            '</div></div>'
          : '';
        // HONEST disabled-state + one-click ENABLE (G4.6): when the scheduler is OFF, say plainly that routines
        // will NOT fire and offer a one-click ENABLE that arms the live timer (no env edit / restart). When ON,
        // show the armed state + a DISABLE control. `enabled` comes straight from GET /api/cron (the live
        // cronArmed), so the badge reflects a runtime arm/disarm immediately.
        // G4.6 — when OFF, this is not a whisper: promote it to a .brief-block banner (same vocabulary the quest
        // APPROVE ask uses) with the ENABLE SCHEDULING action inline, so "saved but won't fire" reads loudly and
        // the fix is one click away. When ON, the calm one-liner + DISABLE control is enough. `#rt-arm`/data-arm
        // stay identical so the arm/disarm wiring below binds unchanged.
        // E-STOP WINS OVER `enabled` (bug-sweep P0). GET /api/cron carries `halted` — the durable stand-down written
        // by the emergency stop. `enabled` still records the user's ARM INTENT while halted, so rendering off
        // `enabled` alone printed "● scheduler armed — routines fire automatically" over a frozen timer. Say the
        // truth loudly and offer the one-click lift (POST /api/cron/arm {enabled:true} clears the halt server-side,
        // which is exactly what the existing #rt-arm data-arm="1" handler already does). Mirrors windows/loops.js.
        gateEl.innerHTML = degradedBlock + (j && j.halted
          ? '<div class="brief-block" style="border-left-color:var(--bad);margin-bottom:8px">' +
              '<div class="brief-k" style="color:var(--bad)">✕ SCHEDULING IS STOPPED (E-STOP)</div>' +
              '<div class="brief-v">Your routines are saved but <b>will not fire</b> — an emergency stop is engaged and it survives a restart.' +
              '<div style="margin-top:8px"><button class="bb xs" id="rt-arm" data-arm="1">▶ RESUME SCHEDULING</button></div>' +
            '</div></div>'
          : j && j.enabled
          ? '<span style="color:var(--gold)">● scheduler armed</span> <span class="dim">— routines fire automatically.</span>' + tickHealthLine(j) + ' ' +
            '<button class="bb xs" id="rt-arm" data-arm="0">⏸ DISABLE SCHEDULING</button>'
          : '<div class="brief-block" style="border-left-color:var(--bad);margin-bottom:8px">' +
              '<div class="brief-k" style="color:var(--bad)">○ SCHEDULING IS OFF</div>' +
              '<div class="brief-v">Your routines are saved but <b>will not fire</b> — the scheduler is disarmed. ' +
              'Enable scheduling to arm the live timer now (no restart needed).' +
              '<div style="margin-top:8px"><button class="bb xs" id="rt-arm" data-arm="1">▶ ENABLE SCHEDULING</button></div>' +
            '</div></div>');
        const degradedBtn = gateEl.querySelector('#rt-degraded-clear');
        if (degradedBtn) degradedBtn.addEventListener('click', async () => {
          degradedBtn.disabled = true; degradedBtn.textContent = '… accepting';
          try {
            const r = await (await post('/api/cron/degraded/clear', { confirm: true })).json();
            if (r && r.ok) { notify('routine store reset — the damaged copy stays on disk', 'warn'); sfx('click'); }
            else { notify((r && r.error) || 'could not reset the routine store', 'warn'); sfx('bad'); }
          } catch (_) { notify('could not reach the sidecar', 'warn'); sfx('bad'); }
          refresh();
        });
        const armBtn = gateEl.querySelector('#rt-arm');
        if (armBtn) armBtn.addEventListener('click', async () => {
          const want = armBtn.dataset.arm === '1';
          armBtn.disabled = true; armBtn.textContent = want ? '… enabling' : '… disabling';
          try {
            const r = await (await post('/api/cron/arm', { enabled: want })).json();
            if (r && r.ok) { notify(want ? 'scheduling enabled — routines will now fire' : 'scheduling disabled', want ? 'good' : 'warn'); sfx('click'); }
            else { notify((r && r.error) || 'could not change scheduling', 'warn'); sfx('bad'); }
          } catch (_) { notify('could not reach the sidecar', 'warn'); sfx('bad'); }
          refresh();   // re-render the badge from the authoritative GET /api/cron enabled
        });
        if (jobs.length) { listEl.innerHTML = jobs.map((j, i) => row(j).replace('<div class="mc-row"', '<div class="mc-row" style="--ci:' + i + '"')).join(''); }
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">◷</span>' +
            '<b>NO ROUTINES YET</b><span>Put your agent to work on a schedule — a morning brief, a nightly summary, a recurring check.</span>' +
            '<button class="es-cta" id="rt-empty-cta" type="button">+ ADD A ROUTINE</button></div>';
          const cta = listEl.querySelector('#rt-empty-cta');
          // jump the console to the CREATE section (mirrors buildAgents' CONFIG jump: set the remembered section,
          // then re-activate the console tab) and focus the name field once the pane is visible.
          if (cta) cta.addEventListener('click', () => {
            sfx('click');
            consoleSection['automation'] = 'routines-create';
            const tab = body.querySelector('#con-tab-automation-routines-create');
            if (tab) tab.click();
            const nm = body.querySelector('#rt-name'); if (nm) nm.focus();
          });
        }
        positionOut();   // re-slot a live RUN NOW result under its row after the list re-renders (P0 #11)
      } catch (_) {
        schedulerArmed = false;
        const createState = body.querySelector('#rt-create-state');
        if (createState) createState.textContent = 'Scheduling status could not be checked. Reconnect to the station before relying on an automatic run.';
        listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage routines.</div>';
      }
    }

    // SELF-INITIATION: the agent reasons out a few standing-job proposals from the dossier, the Commander approves
    // the ones they want (a Dialogue beat), and each approved one is created via POST /api/cron — then we refresh
    // the list so the new routines appear inline. An explicit ask, always allowed (it's the manual counterpart to
    // the one-time proactive offer). Falls back gracefully if the engine/store isn't present.
    const propBtn = body.querySelector('#rt-propose');
    if (propBtn) propBtn.addEventListener('click', async () => {
      if (typeof AutoJobStore === 'undefined' || !AutoJobStore.propose) { notify('self-initiation is unavailable', 'warn'); return; }
      propBtn.disabled = true; sfx('click');
      try {
        const r = await AutoJobStore.propose();
        if (r && r.scheduled) { notify(r.scheduled + ' routine' + (r.scheduled === 1 ? '' : 's') + ' scheduled', 'good'); refresh(); }
      } catch (_) {} finally { propBtn.disabled = false; }
    });

    /* live schedule preview (debounced) — the honest "next fires", straight from the server math. Bound
       as a function so the RESCHEDULE editor previews through the IDENTICAL path: two implementations of
       "when does this run" would eventually disagree, and this panel's entire job is to be right about it. */
    function wirePreview(inp, pvEl) {
      let pvTimer = null, previewRevision = 0;
      inp.addEventListener('input', () => {
      clearTimeout(pvTimer);
      const revision = ++previewRevision;
      const v = inp.value.trim();
      if (!v) { pvEl.textContent = ''; return; }
      pvEl.textContent = 'Checking next run…';
      pvTimer = setTimeout(async () => {
        try {
          // tz honesty in the PREVIEW too: the create POST sends the device zone, so a preview computed
          // without it would quote a different 9:00 than the routine will actually keep.
          const r = await (await post('/api/cron/preview', { schedule: v, tz: deviceTz() })).json();
          if (r && r.ok) {
            // show the LOCAL wall-clock time the routine fires (with its tz), not just a relative delta, so a
            // cron schedule reads honestly across DST (e.g. "next: 9:00 AM EDT (in 3h)"). Falls back to the
            // relative-only line when the server didn't supply a localNext (interval/once).
            const ln = Array.isArray(r.localNext) ? r.localNext : [];
            const tzNote = (r.kind === 'cron' && r.tz && r.tz !== 'UTC') ? ' <span class="dim">[' + esc(r.tz) + ']</span>' : '';
            const nxt = r.next.slice(0, 1).map((t, i) => {
              // r.next carries the AUTHORITATIVE instants; r.localNext is the server rendering them in the
              // SCHEDULE's zone, which for an interval or a one-shot is UTC. Rendering the same instant in
              // the VIEWER's zone stops the panel printing "9:30 PM UTC" under a picker that says 5:30 PM —
              // same moment, two clocks, and the beginner has no way to know that. Server text is the
              // fallback whenever the runtime won't give us a zone.
              const local = esc(wallClock(t) || ln[i] || '');
              return local ? (local + ' <span class="dim">(' + esc(fmtRel(t)) + ')</span>') : esc(fmtRel(t));
            }).join(', ');
            pvEl.innerHTML = '<span class="rt-next-label">Next run</span> ' + nxt;
          }
          else pvEl.innerHTML = '<span style="color:var(--bad)">' + esc((r && r.error) || 'unrecognized schedule') + '</span>';
        } catch (_) {}
      }, 300);
      });
    }
    const schedInp = body.querySelector('#rt-sched'), pvEl = body.querySelector('#rt-preview');
    wirePreview(schedInp, pvEl);

    /* Mount the WHEN picker LAST of the create-form wiring, so the seed value it types into #rt-sched
       lands on a preview listener that already exists — the form opens showing a real server-computed
       "next fires" for its default (every day, 9:00 AM) instead of an empty line. */
    const picker = (typeof SchedPicker !== 'undefined')
      ? SchedPicker.mount(body.querySelector('#rt-when'), { onChange: () => sfx('click') })
      : null;

    body.querySelector('#rt-agent-select').addEventListener('change', e => {
      const btn = Array.from(body.querySelectorAll('.rt-agent-btn')).find(b => b.dataset.agent === e.target.value); if (btn) btn.click();
    });
    body.querySelectorAll('.rt-agent-btn').forEach(btn => btn.addEventListener('click', () => {
      routineAgentId = btn.dataset.agent || 'agent';
      body.querySelector('#rt-agent-select').value = routineAgentId;
      const input = body.querySelector('#rt-agent');
      if (input) input.value = routineAgentId;
      body.querySelectorAll('.rt-agent-btn').forEach(b => {
        const on = b.dataset.agent === routineAgentId;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      sfx('click');
    }));

    /* RESCHEDULE — the same WHEN picker, inline under the row, opened on the routine's CURRENT schedule.
       It patches only `schedule` (plus the device tz, which the update route folds onto schedule.tz), so
       the routine keeps its id, its history and its grants — moving a routine an hour used to mean
       deleting it and re-creating it from scratch. */
    function closeResched() {
      listEl.querySelectorAll('.rt-resched').forEach(el => el.remove());
      listEl.querySelectorAll('button[data-act="resched"]').forEach(b => b.classList.remove('on'));
    }
    function openResched(rowEl, id, btn) {
      const host = document.createElement('div');
      host.className = 'rt-resched';
      host.innerHTML =
        '<div class="rt-when-k">MOVE THIS ROUTINE TO…</div>' +
        (typeof SchedPicker !== 'undefined' ? SchedPicker.html({}) : '<input class="key-input" data-sp-input autocomplete="off">') +
        '<div class="rt-resched-pv dim"></div>' +
        '<div class="mc-acts"><button class="bb xs" data-resched="save">✓ SAVE SCHEDULE</button>' +
        '<button class="bb xs" data-resched="cancel">CANCEL</button></div>';
      rowEl.insertAdjacentElement('afterend', host);
      btn.classList.add('on');
      const inp = host.querySelector('[data-sp-input]'), pv = host.querySelector('.rt-resched-pv');
      if (inp && pv) wirePreview(inp, pv);
      const p = (typeof SchedPicker !== 'undefined') ? SchedPicker.mount(host, {}) : null;
      if (p) p.set(rowEl.dataset.sched || '');
      else if (inp) { inp.value = String(rowEl.dataset.sched || '').replace(/^cron /, ''); inp.dispatchEvent(new Event('input', { bubbles: true })); }
      host.addEventListener('click', async ev2 => {
        const b = ev2.target.closest('button[data-resched]'); if (!b) return;
        if (b.dataset.resched === 'cancel') { sfx('click'); closeResched(); return; }
        const value = (p ? p.value() : (inp ? inp.value : '')).trim();
        if (!value) { sfx('bad'); notify('pick a schedule first', 'warn'); return; }
        b.disabled = true; b.textContent = '… saving';
        // A RESCHEDULE CLAIM MUST BE PROVEN: fetch resolves on 4xx, so a rejected schedule would otherwise
        // toast "rescheduled" over a routine still firing on its old time.
        try {
          const r = await (await post('/api/cron/update', { id, patch: { schedule: value, tz: deviceTz() } })).json();
          if (r && r.ok) { notify('rescheduled — ' + human((r.job && r.job.scheduleDisplay) || value), 'good'); sfx('click'); closeResched(); }
          else { notify((r && r.error) || 'could not reschedule — it still runs on its old schedule', 'warn'); sfx('bad'); b.disabled = false; b.textContent = '✓ SAVE SCHEDULE'; return; }
        } catch (_) {
          notify('could not reach the station — the schedule was NOT changed', 'warn'); sfx('bad');
          b.disabled = false; b.textContent = '✓ SAVE SCHEDULE'; return;
        }
        refresh();
      });
    }

    // row actions: run-now (stream + show the reply), toggle enable/disable, delete (two-step arm/confirm).
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const act = btn.dataset.act;
      if (act === 'resched') {
        sfx('click');
        const wasOpen = btn.classList.contains('on');
        closeResched();                       // one editor at a time; the button toggles its own
        if (!wasOpen) openResched(rowEl, id, btn);
        return;
      }
      if (act === 'remove') {
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '✕ CONFIRM'; sfx('bad'); setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '✕ DELETE'; } }, 5000); return; }
        // ⛔ FETCH RESOLVES ON 4xx/5xx. `await post(...)` only rejects on a network failure, so the toast used to
        // announce a delete the sidecar had REFUSED — and then refresh() re-drew the still-present row underneath it.
        sfx('bad');
        try { const r = await post('/api/cron/remove', { id }); notify(r.ok ? 'routine deleted' : 'could not delete this routine', r.ok ? 'good' : 'warn'); }
        catch (_) { notify('could not reach the station — the routine was not deleted', 'warn'); }
        refresh(); return;
      }
      if (act === 'revoke') {
        // withdraw every unattended grant. Immediate and unconfirmed BY DESIGN: revoking a permission is the
        // safe direction, so it must never be harder than granting it was (delete keeps its two-step arm).
        sfx('click');
        // A REVOKE CLAIM MUST BE PROVEN, not assumed: a rejected request left the standing unattended grant in
        // force while the station said "access revoked" — the one lie a permission surface can never tell.
        try { const r = await post('/api/cron/update', { id, patch: { unattendedGrants: [] } }); notify(r.ok ? 'access revoked' : 'could NOT revoke access — the routine still has it', r.ok ? 'good' : 'warn'); }
        catch (_) { notify('could not reach the station — access was NOT revoked', 'warn'); }
        refresh(); return;
      }
      if (act === 'toggle') {
        // A PAUSE/RESUME CLAIM MUST BE PROVEN (same law as delete/revoke above): fetch resolves on 4xx/5xx,
        // and the swallowed catch meant a failed DISABLE clicked, toasted nothing, and left the routine armed
        // while the user walked away believing it was stopped.
        sfx('click'); const on = rowEl.dataset.on === '1';
        try {
          const r = await post('/api/cron/update', { id, patch: { enabled: !on } });
          if (!r.ok) notify(on ? 'could NOT pause — the routine is still armed' : 'could NOT enable this routine', 'warn');
        } catch (_) { notify('could not reach the station — the routine was NOT ' + (on ? 'paused' : 'enabled'), 'warn'); }
        refresh(); return;
      }
      if (act === 'run') {
        sfx('click'); btn.disabled = true; const old = btn.textContent; btn.textContent = '… posting line';
        showRunOut(rowEl, id);   // P0 #11: the result panel opens inline right under THIS row (visible ACTIVE pane)
        const ob = outEl.querySelector('.rt-out-b');
        /* POST THE LINE FIRST (2026-08-22): with REFIT open the world is frozen, so the sidecar still routes by
           the plan posted at the LAST REFIT close. World.syncPlan() recompiles a dirty floor and resolves on the
           server's verdict; only then does the run dispatch. Mid-edit (REFIT open) a floor with blocking errors
           REFUSES — the scheduler would route by a stale line, which is the one lie a RUN NOW can't tell. */
        try {
          const W = (typeof World !== 'undefined') ? World : null;
          const sync = (W && typeof W.syncPlan === 'function') ? await W.syncPlan() : null;
          const editing = (typeof Build !== 'undefined' && Build.isOpen) ? Build.isOpen() : false;
          if (sync && editing && sync.errors && sync.errors.length) {
            ob.innerHTML = '<span style="color:var(--bad)">✕ line not posted — fix the floor first: ' + esc(sync.errors.map(e => (Build && Build.nagLabel) ? Build.nagLabel(e.code) : e.code).filter((v, i, a) => a.indexOf(v) === i).join(' · ')) + '</span>';
            sfx('bad'); btn.disabled = false; btn.textContent = old; return;
          }
          if (sync && (sync.stale || sync.inflight || sync.retryPending)) {
            ob.innerHTML = '<span style="color:var(--bad)">✕ line not posted — sidecar unreachable, the routine was NOT run</span>';
            sfx('bad'); btn.disabled = false; btn.textContent = old; return;
          }
        } catch (_) {}
        btn.textContent = '… running';
        try {
          const resp = await post('/api/cron/run', { id });
          if (!resp.ok || !resp.body) { const e = await resp.json().catch(() => ({})); ob.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.error) || ('http ' + resp.status)) + '</span>'; sfx('bad'); }
          else {
            // latch the run's OWN runId from the first run.start and key everything to it (mirrors
            // harness.js chat): a forwarded CHILD run's error/tokens riding the same stream must never
            // hijack this run's reply or fail its verdict.
            const reader = resp.body.getReader(), dec = new TextDecoder(); let sbuf = '', reply = '', err = '', ownRunId = null;
            const mine = (p) => !p || !p.runId || !ownRunId || p.runId === ownRunId;
            for (;;) {
              const r = await reader.read(); if (r.done) break;
              sbuf += dec.decode(r.value, { stream: true });
              let nl; while ((nl = sbuf.indexOf('\n')) >= 0) { const line = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1); if (!line.trim()) continue; try { const e = JSON.parse(line); const p = e.payload || {}; if (e.name === 'agent.run.start' && !ownRunId && p.runId) ownRunId = p.runId; else if (e.name === 'agent.token' && mine(p)) reply += (p.delta || ''); else if (e.name === 'agent.tool_call' && mine(p)) reply = ''; else if (e.name === 'agent.run.error' && mine(p)) err = p.message || 'run error'; } catch (_) {} }
            }
            ob.innerHTML = err ? ('<span style="color:var(--bad)">✕ ' + esc(err) + '</span>') : esc(reply || '(no output)');
            notify(err ? 'routine run failed' : 'routine ran', err ? 'warn' : 'good');
          }
        } catch (e) { ob.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'run failed') + '</span>'; sfx('bad'); }
        btn.disabled = false; btn.textContent = old; refresh();
      }
    });

    body.querySelector('#rt-add').addEventListener('click', async () => {
      // IN-FLIGHT GUARD (every other async control in this file has one; this was the omission): a
      // double-click created TWO identical routines, both firing on the same schedule forever.
      const addBtn = body.querySelector('#rt-add');
      if (addBtn.disabled) return;
      const name = (body.querySelector('#rt-name').value || '').trim();
      const prompt = (body.querySelector('#rt-prompt').value || '').trim();
      const schedule = (body.querySelector('#rt-sched').value || '').trim();
      const agentId = (body.querySelector('#rt-agent').value || '').trim();
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;
      if (!prompt || !schedule) { sfx('bad'); msgEl.textContent = 'a prompt and a schedule are required'; return; }
      addBtn.disabled = true;
      msgEl.textContent = 'saving…';
      try {
        // tz honesty (G4.1): send the browser's IANA timezone so a wall-clock schedule ("every morning 9:00")
        // fires in the user's LOCAL time, not the server host's. Backend validates + persists it (invalid tz 400s).
        const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (_) { return undefined; } })();
        // UNATTENDED TERMINAL GRANT: send it only when ticked, so an untouched form posts exactly the body it
        // always did. The server whitelists the value and the authority re-filters it at the gate.
        const grants = [];
        if ((body.querySelector('#rt-term') || {}).checked) grants.push('workbench');
        if ((body.querySelector('#rt-conn') || {}).checked) grants.push('connectors');
        const split = id => (body.querySelector(id).value || '').split(',').map(x => x.trim()).filter(Boolean);
        const script = (body.querySelector('#rt-script').value || '').trim();
        const toolsetText = (body.querySelector('#rt-toolsets').value || '').trim();
        const workdir = (body.querySelector('#rt-workdir').value || '').trim();
        const deliveryMode = body.querySelector('#rt-deliver').value;
        const activeSession = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
        const r = await (await post('/api/cron', {
          name, prompt, schedule, agentId: agentId || undefined, provider, tz,
          meta: body.querySelector('#rt-prompt').dataset.widgetId
            ? { widgetId: body.querySelector('#rt-prompt').dataset.widgetId }
            : body.querySelector('#rt-prompt').dataset.workflowTakeoverId
              ? { workflowTakeoverId: body.querySelector('#rt-prompt').dataset.workflowTakeoverId } : undefined,
          unattendedGrants: grants.length ? grants : undefined,
          skills: split('#rt-skills'), contextFrom: split('#rt-context'),
          workdir: workdir || undefined, script: script || undefined,
          noAgent: !!body.querySelector('#rt-no-agent').checked,
          enabledToolsets: toolsetText ? split('#rt-toolsets') : undefined,
          deliver: deliveryMode,
          origin: deliveryMode === 'origin' && activeSession ? { sessionId: activeSession.id, streamId: activeSession.id, sessionTitle: activeSession.title || '' } : undefined,
          attachToSession: !!body.querySelector('#rt-continue').checked
        })).json();
        if (r && r.error) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc(r.error) + '</span>'; sfx('bad'); }
        // THE MINT GATE'S REFUSALS ARE 200s (declined / near-duplicate name): treating "no error key" as
        // success toasted "scheduled", cleared the form, and the list redrew WITHOUT the routine — the
        // user's work silently gone. Say what actually happened and keep their text in the form.
        else if (r && r.declined) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc(r.message || 'a routine with this name was deleted before — pick a different name') + '</span>'; sfx('bad'); }
        else if (r && r.duplicate) { msgEl.innerHTML = '<span style="color:var(--warn,var(--gold))">◈ ' + esc('a similar routine already exists' + (r.job && r.job.name ? (': "' + r.job.name + '"') : '') + ' — nothing new was created') + '</span>'; sfx('bad'); }
        else {
          msgEl.textContent = '';
          // HONEST create-confirm: don't claim "scheduled" if the scheduler that fires it is off. armStateLine
          // returns null when armed (→ the normal "scheduled for <agent>" line) and an honest {text} when disarmed
          // ("saved, but the scheduler is off — this won't run until you enable scheduling"). Built for exactly this.
          const arm = (typeof AutoJobs !== 'undefined' && AutoJobs.armStateLine) ? AutoJobs.armStateLine(schedulerArmed) : null;
          if (arm) notify('routine "' + (name || 'unnamed') + '" ' + arm.text, 'warn');
          else notify('routine "' + (name || 'unnamed') + '" scheduled for ' + agentLabel(agentId || 'agent'), 'good');
          sfx('click');
          ['#rt-name', '#rt-prompt'].forEach(s => { body.querySelector(s).value = ''; });
          delete body.querySelector('#rt-prompt').dataset.workflowTakeoverId;
          ['#rt-term', '#rt-conn'].forEach(s => { const el = body.querySelector(s); if (el) el.checked = false; });   // a grant is never sticky across creates
          // the WHEN selection SURVIVES a create (people add three morning routines in a row) — but a
          // sticky cadence with a cleared field would be a lie, so we re-emit it and let the preview
          // redraw from the server rather than blanking one half of the pair.
          if (picker) picker.refresh(); else { body.querySelector('#rt-sched').value = ''; pvEl.textContent = ''; }
        }
      } catch (e) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'failed to reach the sidecar') + '</span>'; sfx('bad'); }
      addBtn.disabled = false;
      refresh();
    });

    refresh();
    }

    return { sections, wire };
  }

  AutomationWindow.registerLane(routinesLane);
})();
