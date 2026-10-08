/* sidecar/slash-actions.js -- server-side execution for slash commands that declare dispatch:'server'.

   WHY THIS EXISTS. Until now a slash command could only reach the sidecar if someone hand-wrote a fetch()
   inside its handler in frontend/app/chat.js. That made every backend-touching command a bespoke wiring job
   (and let /build-away drift out of the server catalog entirely, since nothing but the browser knew it). A
   command declaring dispatch:'server' instead names an action here; POST /api/slash/dispatch awaits it and
   returns a { type:'say' } directive carrying the finished, honest text. The browser only prints it — so the
   channel hub and the external harness can run the identical command and read the identical answer.

   TRUTHFUL TELEMETRY. Every line these actions return must describe what the store ACTUALLY did. A create
   that the mint gate deduped says "that already exists"; a routine created while the scheduler is disarmed
   says so in the same breath, because a routine that cannot fire must never read as armed.

   Deps are injected (same pattern as makeChannelHub) so this module stays testable without a live sidecar. */
'use strict';

const MAX_LIST = 25;                       // a chat readout is a glance, not a database dump
const RESERVED_AWAY = ['on', 'off', 'list', 'status', 'now'];

function makeSlashActions(deps) {
  const d = deps || {};
  const cron = d.cron || {};
  const workshop = d.workshop || {};
  const tools = d.tools || {};
  const budget = d.budget || {};
  const now = typeof d.now === 'function' ? d.now : () => 0;

  const say = (text) => ({ ok: true, text: String(text || '') });
  const card = (title, lines) => ({ ok: true, title: String(title || ''), lines: (lines || []).map(String) });
  const fail = (text) => ({ ok: false, text: String(text || '') });

  // "add every 30m | check the build" -> { verb:'add', rest:'every 30m | check the build' }
  function splitVerb(args) {
    const s = String(args || '').trim();
    if (!s) return { verb: '', rest: '' };
    const sp = s.search(/\s/);
    if (sp === -1) return { verb: s.toLowerCase(), rest: '' };
    return { verb: s.slice(0, sp).toLowerCase(), rest: s.slice(sp + 1).trim() };
  }

  // Resolve "3" (1-based position in the SAME order the list command printed) or a raw job id. Position is what
  // a chat user actually has in hand; ids are uuids nobody retypes. Returns null when it matches neither.
  function pickFrom(list, token) {
    const t = String(token || '').trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) {
      const i = parseInt(t, 10) - 1;
      return (i >= 0 && i < list.length) ? list[i] : null;
    }
    return list.find(j => j && String(j.id) === t) || null;
  }

  // `me` = the agent this chat is bound to. The cron store holds EVERY agent's routines (same as the ROUTINES
  // panel), so a row owned by someone else is named — otherwise a positional /routine rm could delete another
  // agent's routine with nothing on screen to warn you.
  function jobLine(j, i, me) {
    const state = j.enabled === false ? 'paused' : 'scheduled';
    const when = j.enabled === false ? 'paused'
      : (j.nextRunAt ? ('next ' + j.nextRunAt) : 'no next fire');
    const last = j.lastStatus ? ('; last ' + j.lastStatus + (j.lastError ? ' (' + String(j.lastError).slice(0, 60) + ')' : '')) : '';
    const owner = (me && j.agentId && String(j.agentId) !== String(me)) ? ' (' + j.agentId + '’s)' : '';
    return (i + 1) + '. ' + (j.name || '(unnamed)') + owner + ' — ' + (j.scheduleDisplay || 'no schedule')
      + ' [' + state + ', ' + when + ']' + last;
  }

  /* ---------------- /routine ---------------- */

  // The scheduler being DISARMED is the single most confusing state in this subsystem: routines exist, look
  // healthy, and never fire. Every routine readout that could be misread as "this will run" carries this.
  function armedNote() {
    if (typeof cron.halted === 'function' && cron.halted()) return " Routines are STOPPED by the Commander's E-STOP, so nothing will fire — /cron on to resume them.";
    if (typeof cron.armed !== 'function') return '';
    return cron.armed() ? '' : ' Routines are NOT armed right now, so nothing will fire — /cron on to arm them.';
  }

  async function routineAction(args, ctx) {
    if (!cron || typeof cron.jobs !== 'function') return fail('Routines are not available on this station.');
    const { verb, rest } = splitVerb(args);
    const all = (cron.jobs() || []).filter(Boolean);
    // The routine belongs to the agent this workstream is talking to — same rule /away uses. Without this every
    // chat-created routine silently landed on the default 'agent', which may have a different model/credential
    // than the specialist the user was addressing.
    const me = String((ctx && ctx.agentId) || 'agent');

    if (!verb || verb === 'list') {
      if (!all.length) return say('No routines yet. /routine add <schedule> | <task> — e.g. /routine add every 30m | check the build.' + armedNote());
      const shown = all.slice(0, MAX_LIST);
      const lines = shown.map((j, i) => jobLine(j, i, me));
      if (all.length > shown.length) lines.push('… and ' + (all.length - shown.length) + ' more (see the ROUTINES panel).');
      const note = armedNote();
      if (note) lines.push(note.trim());
      return card('Routines (' + all.length + ')', lines);
    }

    if (verb === 'preview') {
      if (!rest) return fail('Usage: /routine preview <schedule> — e.g. /routine preview 0 9 * * *');
      if (typeof cron.preview !== 'function') return fail('Schedule preview is not wired on this station.');
      const p = cron.preview(rest);
      if (!p || p.ok === false) return fail(String((p && p.error) || 'Could not read that schedule.'));
      // nextFireAt returns a one-shot's time even when it has already passed, so a stale timestamp would be
      // printed under the word "next". Drop anything already in the past — a fire that cannot happen is not a
      // schedule preview, it is a wrong answer.
      const t0 = now();
      const upcoming = (p.localNext || []).filter((_, i) => {
        const iso = (p.next || [])[i];
        const at = iso ? Date.parse(iso) : NaN;
        return isNaN(at) || at >= t0;
      });
      const fires = upcoming.map((t, i) => (i + 1) + '. ' + t);
      // count the REAL fire times, not the rows — a placeholder row must never inflate the header into
      // claiming one upcoming fire when there are none.
      const title = (p.display || rest) + (fires.length ? ' — next ' + fires.length : ' — no upcoming fires');
      return card(title, fires.length ? fires : ['(this schedule has already passed — it will never fire)']);
    }

    if (verb === 'add' || verb === 'new') {
      // "<schedule> | <task>" — a pipe, because both halves legitimately contain spaces ("every 30 minutes",
      // "0 9 * * *", and any English task). Refusing the ambiguous no-pipe form beats guessing wrong.
      const bar = rest.indexOf('|');
      if (bar === -1) {
        return fail('Usage: /routine add <schedule> | <task>. The pipe separates them — e.g. '
          + '/routine add every 30m | check whether the build went green. '
          + 'Schedules: "every 30m", "in 2h", "0 9 * * *", or an ISO timestamp.');
      }
      const schedule = rest.slice(0, bar).trim();
      const task = rest.slice(bar + 1).trim();
      if (!schedule) return fail('That routine has no schedule — /routine add <schedule> | <task>.');
      if (!task) return fail('That routine has no task — say what it should do after the pipe.');
      if (typeof cron.create !== 'function') return fail('Creating routines is not wired on this station.');
      const r = await cron.create({ name: task.slice(0, 60), prompt: task, schedule: schedule, agentId: me });
      if (!r || r.ok === false) {
        // The mint ledger's decline is STICKY and has no un-decline API, so "you deleted this before" is a dead
        // end unless we name the way out. Names normalize to lowercase-alphanumeric (mint-ledger normName), so a
        // slightly different wording genuinely mints — say that rather than leaving the user stuck.
        if (r && r.declined) return fail('You deleted a routine by that name before, so the station will not re-create it. Give this one a slightly different name.');
        return fail(String((r && r.error) || 'The station refused that routine.'));
      }
      if (r.duplicate) {
        const j = r.job || {};
        // armedNote here too: this reply NAMES a routine, and the atlas promise is that any reply naming a
        // routine which cannot fire says so. The duplicate branch used to be the one that stayed silent.
        return say('A routine named "' + (j.name || task.slice(0, 60)) + '" already exists (' + (j.scheduleDisplay || 'no schedule') + ') — not creating a second one.' + armedNote());
      }
      const j = r.job || {};
      // Render the first fire in LOCAL wall-clock via the same preview path the panel uses. j.nextRunAt is a raw
      // UTC ISO string; showing that for "0 9 * * *" reads as 13:00 to a New Yorker who asked for 9am (G4.1).
      let first = '';
      if (j.nextRunAt) {
        let local = null;
        try { const p = cron.preview(schedule); if (p && p.ok !== false && p.localNext && p.localNext.length) local = p.localNext[0]; } catch (_) {}
        first = ', first fire ' + (local || j.nextRunAt);
      }
      return say('Routine created: "' + (j.name || task.slice(0, 60)) + '" — ' + (j.scheduleDisplay || schedule)
        + first + '.' + armedNote());
    }

    // NOTE: no `run` verb. Firing a routine on demand streams NDJSON through handleCronRun, which is welded to
    // its response object; a chat-side copy would have to duplicate the whole run/lease/markRun path. The
    // ROUTINES panel already carries Run Now, so the capability HAS a door — it just isn't this one.
    if (verb === 'run') {
      return fail('Run-now lives in the ROUTINES panel (it streams the run live). /routine list to find it there.');
    }

    if (verb === 'pause' || verb === 'resume') {
      const j = pickFrom(all, rest);
      if (!j) return fail(rest ? ('No routine ' + rest + ' — /routine list to see them.') : ('Usage: /routine ' + verb + ' <number>'));
      if (typeof cron.setEnabled !== 'function') return fail('Editing routines is not wired on this station.');
      const want = verb === 'resume';
      const r = await cron.setEnabled(j.id, want);
      if (!r || r.ok === false) return fail('Could not ' + verb + ' "' + (j.name || j.id) + '": ' + String((r && r.error) || 'the write failed') + '.');
      const nj = r.job || {};
      const nm = nj.name || j.name || j.id;
      if (!want) return say('"' + nm + '" is now paused.');
      // A resume only re-arms if the schedule still has a future fire. resumeJob leaves nextRunAt null for an
      // expired one-shot, so "is now scheduled" would assert a run that can never happen — /routine list would
      // immediately contradict it with "no next fire".
      if (!nj.nextRunAt) return say('"' + nm + '" is un-paused, but its schedule has no future fire left, so it will not run. Delete it, or make a new routine with a fresh schedule.');
      return say('"' + nm + '" is now scheduled — next fire ' + nj.nextRunAt + '.' + armedNote());
    }

    if (verb === 'rm' || verb === 'remove' || verb === 'delete') {
      const j = pickFrom(all, rest);
      if (!j) return fail(rest ? ('No routine ' + rest + ' — /routine list to see them.') : 'Usage: /routine rm <number>');
      if (typeof cron.remove !== 'function') return fail('Deleting routines is not wired on this station.');
      const r = await cron.remove(j.id);
      if (!r || r.ok === false) return fail('Could not delete "' + (j.name || j.id) + '": ' + String((r && r.error) || 'the write failed') + '.');
      return say('Deleted routine "' + (j.name || j.id) + '".');
    }

    return fail('Unknown: /routine ' + verb + '. Try list, add, preview, pause, resume, rm.');
  }

  /* ---------------- /away ---------------- */

  // Everything the away workshop does is gated on a per-agent grant. A queued idea with the grant OFF will sit
  // there forever, so the grant state rides every reply that could otherwise read as "this will get built".
  function grantNote(granted) {
    return granted ? '' : ' "Build while away" is OFF for this agent, so nothing will be built yet — /away on to turn it on.';
  }

  // runWorkshopShift reports machine reason codes ('no-capability', 'empty-backlog'). Printing those raw at a
  // beginner is a dead end: true, but unactionable. Translate the known ones and name the next step; an
  // unrecognized code still passes through verbatim rather than being swallowed or guessed at.
  const SHIFT_REASONS = {
    'no-capability': 'this agent has no model credential it can build with yet — add a key in SETTINGS → AI & MODELS',
    'empty-backlog': 'there is nothing queued to build — /away <what to build> adds one',
    'not-granted': '"build while away" is off for this agent — /away on to turn it on',
    'bad-agent': 'that agent id is not one of your station agents',
    // these two come back with fired:TRUE — the shift ran and produced nothing usable. See awayAction.
    'run-failed': 'the build run itself failed',
    'no-manifest': 'the run finished but produced no valid deliverable'
  };
  function shiftReason(code) {
    const c = String(code || '').trim();
    return SHIFT_REASONS[c] || (c || 'nothing was eligible');
  }

  async function awayAction(args, ctx) {
    if (!workshop || typeof workshop.state !== 'function') return fail('The away workshop is not available on this station.');
    const agentId = String((ctx && ctx.agentId) || 'agent');
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    // A reserved verb only counts when it is the WHOLE argument — so "/away on" toggles the grant while
    // "/away on-call dashboard" is still a build request, not a mangled toggle.
    const isReserved = RESERVED_AWAY.indexOf(low) !== -1;

    if (!raw || (isReserved && (low === 'list' || low === 'status'))) {
      const st = await workshop.state(agentId);
      if (!st || st.ok === false) return fail('Could not read the away workshop: ' + String((st && st.error) || 'no answer') + '.');
      const items = (st.backlog || []).slice(0, MAX_LIST);
      // Mark a row "waiting in OUTBOX" ONLY when its manifest still validates on disk — the same proof the
      // OUTBOX panel demands. Keying off builtRunId alone made the rows contradict this card's own count
      // (two rows claiming to wait, above a line saying one is waiting).
      const ready = Array.isArray(st.pendingIds) ? st.pendingIds.map(String) : null;
      const isReady = (it) => it && it.builtRunId && (ready ? ready.indexOf(String(it.builtRunId)) !== -1 : false);
      const lines = items.map((it, i) => (i + 1) + '. ' + String((it && (it.title || it.detail)) || '(untitled)').slice(0, 120)
        + (isReady(it) ? '  [built — waiting in DELIVERABLES › TO REVIEW]'
          : (it && it.builtRunId ? '  [was built, but its files are gone]' : '')));
      if (!items.length) lines.push('(nothing queued — /away <what to build> adds one)');
      if ((st.backlog || []).length > items.length) lines.push('… and ' + ((st.backlog || []).length - items.length) + ' more.');
      if (st.pending) lines.push('' + st.pending + ' finished build' + (st.pending === 1 ? '' : 's') + ' waiting for your keep/discard — open MY WORK › DELIVERABLES (TO REVIEW).');
      lines.push('Build while away: ' + (st.granted ? 'ON' : 'OFF') + '.');
      return card('Away workshop — ' + (st.backlog || []).length + ' queued', lines);
    }

    if (isReserved && (low === 'on' || low === 'off')) {
      const want = low === 'on';
      if (typeof workshop.grant !== 'function') return fail('The away grant is not wired on this station.');
      const r = await workshop.grant(agentId, want);
      if (!r || r.ok === false) return fail('Could not turn "build while away" ' + (want ? 'on' : 'off') + ': ' + String((r && r.error) || 'the write failed') + '.');
      return say(want
        ? '"Build while away" is ON — this agent will work its queue on its next away shift while the station is up.'
        : '"Build while away" is OFF — the queue is kept, but nothing new will be built.');
    }

    if (isReserved && low === 'now') {
      if (typeof workshop.shiftNow !== 'function') return fail('Firing an away shift is not wired on this station.');
      const r = await workshop.shiftNow(agentId);
      if (!r || r.ok === false) return fail('Could not run an away shift: ' + String((r && r.error) || 'the station refused it') + '.');
      if (r.fired === false) return say('No away shift ran — ' + shiftReason(r.reason) + '.');
      // A shift that RAN but produced no valid manifest still returns fired:true (reason 'run-failed' /
      // 'no-manifest'). Reporting that as "finished work waits in OUTBOX" would be a flat lie: nothing landed,
      // and the item may have been PARKED, which means it will never be retried unless it is re-queued.
      if (r.reason && r.reason !== 'built') {
        return fail('An away shift ran but produced nothing usable — ' + shiftReason(r.reason)
          + (r.parked ? '. That item is now parked and will NOT be retried — /away <the same idea> to queue it again.' : '.'));
      }
      const title = (r.manifest && r.manifest.title) ? String(r.manifest.title).slice(0, 80) : '';
      return say('Away shift built' + (title ? ' "' + title + '"' : ' a deliverable') + '. It waits in DELIVERABLES › TO REVIEW for keep or discard.');
    }

    // Anything else is the thing to build.
    if (typeof workshop.queue !== 'function') return fail('Queueing away builds is not wired on this station.');
    const r = await workshop.queue(agentId, raw);
    if (!r || r.ok === false) return fail('Could not queue that: ' + String((r && r.error) || 'the station refused it') + '.');
    return say('Queued for the away workshop: "' + raw.slice(0, 80) + '".' + grantNote(r.granted !== false));
  }

  /* ---------------- /tools ----------------

     WHY THIS IS SERVER-SIDE. The browser used to print a HARDCODED list of tool names ("web (web_search,
     web_fetch)") keyed only on which props were placed. Two ways that lied: the names were a literal that
     drifted from CAP_REGISTRY, and it ignored the TOOLSETS toggle entirely — a family switched OFF still
     read as available, so /tools advertised tools the run would never be given. The registry lives here, so
     the answer is computed here from the same rows the TOOLSETS console renders. */
  async function toolsAction(args, ctx) {
    if (!tools || typeof tools.rows !== 'function') return fail('The tool registry is not available on this station.');
    const placed = Array.isArray(ctx && ctx.placed) ? ctx.placed : [];
    let rows;
    try { rows = tools.rows(placed) || []; } catch (e) { return fail('Could not read the tool registry: ' + ((e && e.message) || e)); }

    const live = rows.filter(r => r.placed && r.enabled !== false);
    const off = rows.filter(r => r.placed && r.enabled === false);
    const unplaced = rows.filter(r => !r.placed);
    const lines = [];
    for (const r of live) lines.push('✓ ' + r.label + ' — ' + (r.tools || []).join(', ') + (r.consentGated ? '  (asks before acting)' : ''));
    // A family whose prop IS placed but whose switch is OFF is the case the old readout got flatly wrong.
    for (const r of off) lines.push('✗ ' + r.label + ' — switched OFF in TOOLSETS, so these will not be offered');
    if (unplaced.length) lines.push('Locked until placed: ' + unplaced.map(r => r.label + (r.object ? ' (' + r.object + ')' : '')).join(', ') + '.');
    // JUKEBOX is a TWO-step unlock: the prop grants the tools, but they are inert until Spotify's OAuth exists.
    const juke = live.find(r => r.id === 'jukebox');
    if (juke && typeof tools.spotifyConnected === 'function') {
      let connected = null;
      try { connected = await tools.spotifyConnected(); } catch (_) { connected = null; }
      if (connected === false) lines.push('Spotify is not connected — the JUKEBOX tools are listed but inert until you connect it in TOOLSETS.');
    }
    // "compute" is the gate to spend a model turn at all, not a callable tool — say so rather than listing it.
    lines.push('Every agent can also think and reply (the compute grant); that is not a callable tool.');
    if (!live.length && !off.length) return say('This agent has no tools yet — place props in BUILD MODE to grant them. ' + lines[lines.length - 2 >= 0 ? lines.length - 2 : 0]);
    return card('Tools for this agent (' + live.length + ' active)', lines);
  }

  /* ---------------- /usage ----------------

     WHY THIS IS SERVER-SIDE. The browser reported Harness.totals() as "lifetime" spend, but that counter only
     accumulates runs THIS BROWSER watched. Every headless run — routines, away shifts, night shift, Telegram —
     spends real money and never touches it, so the number structurally under-reported and disagreed with the
     sidecar's own ledger (the one the budget caps actually enforce against). The ledger is the authority. */
  function usd(n) {
    const v = Number(n) || 0;
    if (v > 0 && v < 0.01) return '<$0.01';
    return '$' + v.toFixed(2);
  }
  async function usageAction(args, ctx) {
    if (!budget || typeof budget.snapshot !== 'function') return fail('Spend tracking is not available on this station.');
    const agentId = String((ctx && ctx.agentId) || 'agent');
    let s;
    try { s = await budget.snapshot(agentId); } catch (e) { return fail('Could not read the spend ledger: ' + ((e && e.message) || e)); }
    if (!s || s.ok === false) return fail('Could not read the spend ledger: ' + String((s && s.error) || 'no answer') + '.');
    const caps = s.caps || {};
    const lines = [];
    const dayCap = Number(caps.perDay) > 0 ? (' of ' + usd(caps.perDay) + ' daily cap') : '';
    lines.push('Today: ' + usd(s.today) + dayCap + '.');
    const tok = Number(s.tokens) > 0 ? (', ~' + Math.round(Number(s.tokens)).toLocaleString('en-US') + ' tokens') : '';
    lines.push('All time: ' + usd(s.lifetime) + ' across ' + (Number(s.runs) || 0) + ' run' + ((Number(s.runs) === 1) ? '' : 's') + tok + '.');
    lines.push('This agent (' + agentId + '): ' + usd(s.agentUsd) + '.');
    const capBits = [];
    if (Number(caps.perRun) > 0) capBits.push('per run ' + usd(caps.perRun));
    if (Number(caps.perDay) > 0) capBits.push('per day ' + usd(caps.perDay));
    if (Number(caps.global) > 0) capBits.push('total ' + usd(caps.global));
    lines.push(capBits.length ? ('Caps: ' + capBits.join(' · ') + '.') : 'No spend caps are set — SETTINGS › SPENDING LIMITS.');
    // The point of moving this server-side: say WHOSE numbers these are, so the figure is not read as
    // "what I watched happen in this window".
    lines.push('From the station ledger — includes routines, away shifts and messaging runs, not just this window.');
    return card('Spend', lines);
  }

  const ACTIONS = { routine: routineAction, away: awayAction, tools: toolsAction, usage: usageAction };

  /* run(action, args, ctx) -> { ok, text? , title?, lines? }. NEVER throws: a broken dep must degrade to an
     honest refusal line, because the caller (an HTTP handler) would otherwise 500 on a typo'd command. */
  async function run(action, args, ctx) {
    const fn = ACTIONS[String(action || '')];
    if (!fn) return { ok: false, status: 404, text: 'That command has no server action.' };
    try { return await fn(String(args == null ? '' : args).trim(), ctx || {}); }
    catch (e) { return { ok: false, text: 'That command failed: ' + ((e && e.message) || String(e)) }; }
  }

  return { run: run, actions: Object.keys(ACTIONS), _internals: { splitVerb, pickFrom, jobLine } };
}

module.exports = { makeSlashActions, MAX_LIST };
