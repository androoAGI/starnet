/* AGENT OS — autojobs.js : the PURE engine for SELF-INITIATION (Slice 2 of the autonomy layer).

   The agent stops only ever waiting for orders: once it knows the Commander and they've turned autonomy on, it
   PROPOSES a few recurring STANDING JOBS grounded in what it knows — the Commander approves the ones they want, and
   each approved job becomes a scheduled cron routine that wakes unattended and leaves a draft on the desk.

   This is the deterministic skeleton; the model fills one narrow reasoning slot (what the jobs actually are). Same
   robustness pattern as the First Pitch (pitch.js): the gate, the directive, the strict parse, the cadence map, and
   the cron-body shape all live here (pure + tested); the live wiring (the model call, the approval beat, the POST to
   /api/cron) lives in autojobstore.js.

   THREE disciplines encoded so they can't rot:
     1. GROUNDING — every proposal MUST cite a specific dossier signal (a real goal / pain / ambition). No grounding,
        no candidate. This is the anti-slop floor: the station never invents busywork.
     2. ACHIEVABLE-NOW envelope — an unattended (autonomous-surface) run is default-denied tools/network/writes until
        a future Reach grant. So a Slice-2 job is REASONING/DRAFTING work the agent can do from what it knows and
        leave on the desk — never "search the web" / "send" / "write files" it can't actually do unattended yet. The
        directive constrains the model to that envelope (the confidence gate: don't propose what you can't deliver).
     3. POSTURE-GATED — proposing is itself a "propose" act, so it only happens when the autonomy Initiative is at
        least 'propose' (never at full wait-for-me). Graduation-first: it follows the one-time First Pitch.

   PURE + node-testable, mirroring pitch.js: an `AutoJobs` global in the browser, module.exports under node. NO
   Date.now / Math.random — proposals are a deterministic function of the dossier + the chosen cadence menu. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AutoJobs = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRE_DIMS = ['goals'];   // can't propose useful standing work without knowing what the Commander wants
  const MIN_KNOWN = 2;              // at least two dossier dimensions filled before the station dares to self-initiate
  const MAX_PROPOSALS = 3;          // never a wall of jobs — a few high-signal proposals, the Commander stays in control
  const MAX_JOBS = 8;              // don't proactively offer more when the Commander already runs this many routines
  const NAME_CHARS = 80;           // cron job name cap (matches the routines form maxlength)

  // THE CADENCE MENU — a small curated set of VALID schedule strings (each parses in sidecar/cron.js: interval or a
  // 5-field numeric cron). The model picks one id per job; the Commander can retune it later in the ROUTINES panel.
  // Kept here (not model-authored) so a routine can never be scheduled with an unparseable expression.
  const CADENCES = [
    { id: 'morning',  label: 'every morning',        schedule: '0 9 * * *', atHour: 9 },
    { id: 'weekly',   label: 'every Monday morning', schedule: '0 9 * * 1', atHour: 9 },
    { id: 'sixhourly',label: 'every 6 hours',        schedule: 'every 6h' },
    { id: 'hourly',   label: 'every hour',           schedule: 'every 1h' }
  ];
  const DEFAULT_CADENCE = 'morning';
  function cadenceById(id) { return CADENCES.filter(c => c.id === id)[0] || CADENCES.filter(c => c.id === DEFAULT_CADENCE)[0]; }

  // TIMEZONE-HONEST CADENCE LABEL. A wall-clock cadence (`0 9 * * *`) fires on the SIDECAR HOST's local wall-clock
  // when scheduled with a tz (sidecar/cron.js: a schedule's own tz wins; a tz-less one falls back to the host tz =
  // UTC-or-SKYNET_CRON_TZ). The old label "every morning" hid BOTH the hour and the zone — a beginner can't tell
  // whether "morning" is 9am here or 9am UTC. So a wall-clock cadence renders "every morning · 9:00 (your local
  // time)" ONLY when we actually persist the device tz alongside it (deviceTz()), which we do in toCronBody. An
  // interval cadence ("every 6 hours") carries no clock time, so it renders its plain label unchanged — never a
  // fabricated hour. `localTz` false → we could not resolve/persist a tz, so we DON'T claim "your local time".
  function cadenceLabel(id, opts) {
    const c = cadenceById(id);
    opts = opts || {};
    if (!Number.isFinite(c.atHour)) return c.label;      // interval cadence — no wall-clock time to name
    const time = (c.atHour | 0) + ':00';                 // 24h, un-padded hour ("9:00"), reads naturally for a beginner
    // only append "(your local time)" when the schedule genuinely carries the device tz (opts.localTz).
    return c.label + ' · ' + time + (opts.localTz ? ' (your local time)' : '');
  }

  // the caller's IANA zone, resolved from the browser at schedule time (pure-safe: guarded, never throws). Absent in
  // node/headless → '' so toCronBody stays tz-less (the host default applies) and the label omits "your local time".
  function deviceTz() {
    try { return (Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) { return ''; }
  }

  // THE GATE — should the station PROACTIVELY offer standing-job proposals right now? Returns { go, reason } (honest
  // telemetry). Order: autonomy-on first, then fire-once, then graduation, then do-we-know-enough, then not-already-
  // -drowning-in-routines. The manual "propose jobs" button bypasses this (an explicit ask is always allowed).
  //   enabled        — autonomy Initiative is at least 'propose' (AutonomyStore.summary().enabled)
  //   alreadyProposed— the one-time proactive offer already happened (fire-once; the button re-opens it after)
  //   firstPitchDone — the one-time First Pitch must precede self-initiation (graduation first)
  //   knownDims      — dossier dims that hold a belief
  //   existingJobCount — how many routines already exist (don't pile on)
  function shouldPropose(state) {
    state = state || {};
    if (!state.enabled) return { go: false, reason: 'autonomy-off' };
    if (state.alreadyProposed) return { go: false, reason: 'already-proposed' };
    if (!state.firstPitchDone) return { go: false, reason: 'no-first-pitch' };
    const known = Array.isArray(state.knownDims) ? state.knownDims : [];
    const require = Array.isArray(state.requireDims) ? state.requireDims : REQUIRE_DIMS;
    const minKnown = Number.isFinite(state.minKnown) ? state.minKnown : MIN_KNOWN;
    for (const d of require) if (known.indexOf(d) < 0) return { go: false, reason: 'missing:' + d };
    if (known.length < minKnown) return { go: false, reason: 'too-cold' };
    const cap = Number.isFinite(state.maxJobs) ? state.maxJobs : MAX_JOBS;
    if ((state.existingJobCount || 0) >= cap) return { go: false, reason: 'enough-jobs' };
    return { go: true, reason: 'ready' };
  }

  // THE DIRECTIVE — the reason-only task the agent runs to GENERATE its proposals. It already carries the COMMANDER
  // dossier block in its live system prompt; this hands it the same beliefs explicitly (so a weak model can't miss
  // them) and hard-constrains the output to grounded, achievable-now, strictly-tagged standing jobs.
  //   beliefs       — { goals:[text], pain:[text], ambition:[text], stack:[text], standing_orders:[text], ... }
  //   existingJobs  — [names] of routines that already exist (so it doesn't propose a duplicate)
  //   max           — cap on proposals (default MAX_PROPOSALS)
  function buildProposalDirective(ctx) {
    ctx = ctx || {};
    const beliefs = (ctx.beliefs && typeof ctx.beliefs === 'object') ? ctx.beliefs : {};
    const existing = (Array.isArray(ctx.existingJobs) ? ctx.existingJobs : []).filter(Boolean);
    const max = Number.isFinite(ctx.max) ? ctx.max : MAX_PROPOSALS;

    const lines = [];
    lines.push('INTERNAL — SELF-INITIATION. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('You now know your Commander. Propose up to ' + max + ' RECURRING STANDING JOBS worth running for them on a schedule — real, useful, recurring work, not generic filler.');
    // hand the model the grounding material explicitly
    const dimLine = (key, label) => {
      const arr = Array.isArray(beliefs[key]) ? beliefs[key].filter(Boolean) : [];
      if (arr.length) lines.push('- ' + label + ': ' + arr.join(' | '));
    };
    lines.push('What you know about them:');
    dimLine('goals', 'Goals');
    dimLine('pain', 'Pain points (work they want gone)');
    dimLine('ambition', 'Ambitions (what they never find time for)');
    dimLine('stack', 'Stack & tools');
    dimLine('standing_orders', 'Standing orders');
    dimLine('people', 'People & audience (who the work is for)');
    dimLine('schedule', 'Schedule & cadence (when work should land)');
    lines.push('Hard rules:');
    lines.push('- GROUNDED: every job must aim at a SPECIFIC thing above (a real goal, pain, or ambition). If you cannot ground it in something you actually know, do not propose it.');
    lines.push('- ACHIEVABLE UNATTENDED: each job runs with NO tools, NO web, NO file writes, NO sending (you will not have permission while they are away). It must be REASONING / DRAFTING / PLANNING work you can do from what you know, leaving a draft for them to review. Never propose searching, fetching, posting, or messaging.');
    lines.push('- RECURRING: it must be worth doing again and again on a cadence (a standing rhythm), not a one-off.');
    lines.push('- Prefer different angles: advancing a goal, chipping at a pain, moving toward an ambition.');
    if (existing.length) lines.push('- Do NOT duplicate jobs they already run: ' + existing.join('; ') + '.');
    lines.push('Cadence — pick ONE id per job from: ' + CADENCES.map(c => c.id + ' (' + c.label + ')').join(', ') + '.');
    lines.push('Reply with one block PER job, in EXACTLY this format, nothing else:');
    lines.push('JOB: <short name, a few words>');
    lines.push('WHY: <one sentence — the specific goal/pain/ambition it serves>');
    lines.push('GROUNDS: <the exact thing you know that grounds it>');
    lines.push('CADENCE: <one id from the list>');
    lines.push('RUN: <the standing instruction the job runs each time — a self-contained reasoning/drafting task that ends by leaving a clear draft for the Commander>');
    return lines.join('\n');
  }

  /* THE GROUNDING VETO (2026-08-05) — the same engine the night shift uses (autopilot.js grounded/flattenBeliefs).

     This parse used to accept ANY non-empty GROUNDS line: presence-only. That is not a grounding gate, it is a
     format gate. A model that invented "you mentioned wanting a weekly competitor digest" cleared it word for
     word, and the proposal did not merely get shown — approving it WRITES A CRON JOB that wakes unattended
     forever, under a beat whose whole copy is "now that i KNOW you". The sibling engine already refuses this:
     autopilot.js vetoes a candidate whose GROUNDS shares no significant token with anything the station knows.
     The evidence pool is the caller's obligation and the whole basis of the check — so, exactly like
     parseCandidates, a caller that supplies NO pool grounds NOTHING and every proposal dies. Fail-closed is the
     point: the failure mode this replaces was inventing standing work, not missing some.
     Resolved LAZILY — index.html loads autojobs.js BEFORE autopilot.js, so a load-time capture would be null. */
  const AUTOPILOT_NODE = (typeof module !== 'undefined' && module.exports)
    ? (() => { try { return require('./autopilot.js'); } catch (_) { return null; } })()
    : null;
  function veto() {
    const A = AUTOPILOT_NODE || ((typeof globalThis !== 'undefined' && globalThis.Autopilot) || null);
    return (A && A.grounded && A.flattenBeliefs) ? A : null;
  }

  // read the agent's reply into proposal objects, tolerantly. Splits on JOB: markers; each block keeps a proposal
  // only if it has a title, a RUN instruction, and a GROUNDS line that is BOTH non-empty AND actually anchored in
  // the evidence pool (opts.beliefs — the {dim: [text]} map the store already holds). CADENCE is validated against
  // the menu (unknown → the default). Returns at most `max` proposals.
  function parseProposals(text, opts) {
    const raw = String(text == null ? '' : text);
    const max = (opts && Number.isFinite(opts.max)) ? opts.max : MAX_PROPOSALS;
    const V = veto();
    // the evidence pool: every belief text the station actually holds, flattened. No engine → no veto is possible,
    // and a parse that cannot check its grounding must not pretend it did (see the fail-closed note above).
    const pool = V ? V.flattenBeliefs(opts && opts.beliefs) : null;
    const grab = (block, label) => {
      const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.+?)\\s*$', 'im').exec(block);
      return m ? m[1].trim() : '';
    };
    // split into per-job blocks at each JOB: tag (case-insensitive), keeping the tag with its block.
    const parts = raw.split(/(?=^\s*JOB\s*:)/im).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const block of parts) {
      const title = grab(block, 'JOB');
      const grounds = grab(block, 'GROUNDS');
      const run = grab(block, 'RUN');
      if (!title || !grounds || !run) continue;   // grounding + a real instruction are mandatory
      if (!V || !V.grounded(grounds, pool)) continue;   // …and INVENTED grounding dies here, not on the schedule
      const cadRaw = grab(block, 'CADENCE').toLowerCase();
      const cad = CADENCES.filter(c => c.id === cadRaw)[0] ? cadRaw : DEFAULT_CADENCE;
      out.push({ title: title.slice(0, NAME_CHARS), why: grab(block, 'WHY'), grounds, cadenceId: cad, prompt: run });
      if (out.length >= max) break;
    }
    return out;
  }

  // the POST /api/cron body for an approved proposal. The RUN instruction becomes the job's prompt (the directive it
  // executes each fire); the cadence id maps to a real schedule string; recurring forever (repeat.times = null).
  function toCronBody(proposal) {
    const p = proposal || {};
    const cad = cadenceById(p.cadenceId);
    const body = {
      name: String(p.title || 'Standing job').slice(0, NAME_CHARS),
      prompt: String(p.prompt || ''),
      schedule: cad.schedule,
      agentId: 'agent',
      enabled: true,
      deliver: 'local',
      repeat: { times: null }
    };
    // TZ HONESTY (cadence item #4): persist the device zone so a wall-clock cadence FIRES on the Commander's local
    // 9:00 (not UTC), matching the "your local time" label. Additive: the sidecar's /api/cron accepts an optional
    // `tz` (IANA); a tz-less body still resolves under the host default, so this never breaks an old caller. Only
    // attach it for a wall-clock cadence (an interval has no local anchor) and only when we could resolve one.
    if (Number.isFinite(cad.atHour)) { const tz = deviceTz(); if (tz) body.tz = tz; }
    return body;
  }

  // ----- presentation helpers (the approval beat copy; one tested home, the awakening's wry-genius lowercase) -----
  function introLine(n) {
    if (!n) return '';
    return n === 1
      ? "now that i know you, here's one standing job i could run for you on a schedule — want it?"
      : "now that i know you, here are a few standing jobs i could run for you on a schedule — pick the ones you want.";
  }
  function proposalLines(p) {
    if (!p || !p.title) return [];
    // tz-honest cadence: for a wall-clock cadence we persist the device tz in toCronBody, so name the local time.
    const label = cadenceLabel(p.cadenceId, { localTz: !!deviceTz() });
    const out = ['▸ ' + p.title + ' — ' + label + '.'];
    if (p.why) out.push(p.why);
    return out;
  }
  function approveChoices() {
    return [
      { label: 'schedule it', value: 'yes' },
      { label: 'skip', value: 'no', skip: true }
    ];
  }

  // ROUTINES-DISARMED TRUTH (item #1). A scheduled routine only fires when the SIDECAR SCHEDULER is armed — that is
  // the real, provable gate (GET /api/cron `.enabled` / cronArmed), NOT the autonomy dial. (Autonomy Initiative
  // gates whether the agent PROPOSES standing jobs — shouldPropose above — it does not gate a routine already on
  // the schedule.) So "saved but won't fire" is an honest claim ONLY when the scheduler is off; asserting anything
  // about Autonomy here would be telemetry the harness can't prove. Returns null when armed (no line to show) and
  // an honest {text, cta} when disarmed, so a render site (ROUTINES list / create confirm) can show it uniformly.
  //   schedulerArmed — GET /api/cron `.enabled` (the live cronArmed). Undefined/false → treat as disarmed.
  function armStateLine(schedulerArmed) {
    if (schedulerArmed) return null;
    return {
      text: 'saved, but the scheduler is off — this won’t run until you turn scheduling on (AUTOMATE › SCHEDULES → ▶ TURN SCHEDULING ON).',
      cta: { label: 'turn scheduling on', panel: 'routines' }
    };
  }

  function doneLine(scheduled, schedulerArmed) {
    if (scheduled <= 0) return "no worries — i'll keep waiting for your word. you can ask me to propose jobs anytime from ROUTINES.";
    // HONEST: don't claim it will run if the scheduler that fires it is off. When armed → the normal line; when off
    // → say it's saved-but-dormant and where to arm it (matches the ROUTINES panel's own disarmed copy).
    const where = " you'll find " + (scheduled === 1 ? 'it' : 'them') + " (and what " + (scheduled === 1 ? 'it produces' : 'they produce') + ") in AUTOMATE › SCHEDULES.";
    if (schedulerArmed === false) {
      return scheduled === 1
        ? "done — it's saved, but scheduling is OFF so it won't run yet. turn scheduling on in AUTOMATE › SCHEDULES to arm it." + where
        : "done — " + scheduled + " jobs are saved, but scheduling is OFF so they won't run yet. turn scheduling on in AUTOMATE › SCHEDULES to arm them." + where;
    }
    return scheduled === 1
      ? "done — it's on the schedule." + where
      : "done — " + scheduled + " jobs are on the schedule now." + where;
  }

  return {
    shouldPropose, buildProposalDirective, parseProposals, toCronBody, cadenceById, cadenceLabel, deviceTz,
    introLine, proposalLines, approveChoices, doneLine, armStateLine,
    CADENCES, DEFAULT_CADENCE, REQUIRE_DIMS, MIN_KNOWN, MAX_PROPOSALS, MAX_JOBS, NAME_CHARS
  };
});
