/* STARNET — nightreport.js : the PURE engine for the MORNING REPORT (NS-4).

   THE PROMISE: Andrew must never again wonder "what did you do all night, and if nothing, why?". On the first
   activity after a real absence, the station owes ONE honest digest — the acts it fired AND the honest other half
   (what it DECLINED, and the one plain reason it did nothing at all). This module composes that digest from the
   three truthful-telemetry surfaces the night-shift already serves:

     • GET /api/nightshift/status  → { active, away, beatsUsedToday, leashPerDay, lastBeatAt, nextEligibleAt, binding }
     • GET /api/autonomy/ledger    → recent decisions (source:'nightshift', kind:'act'|'decline'|'note', binding, reason)
     • GET /api/nightshift/drafts  → the acts left on the desk ({ title, archetype, at, body, note })

   EVERY line here maps to one of those provable fields — the report never asserts state the harness can't prove
   (the product's core law). PURE + node-testable, mirroring autonomy.js / autopilot.js: a `NightReport` global in
   the browser, module.exports under node. NO Date.now / Math.random — the report is a deterministic function of the
   three payloads + an explicit `nowMs`. Time formatting takes an explicit tz-offset so LOCAL time is testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.NightReport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The night-shift decision gates, in the order the driver checks them (nightshift.js). Each maps to ONE plain,
  // honest sentence naming why a beat could not fire — so an empty night reads as a reason, never a shrug.
  //   posture: the dial itself forbade acting; present: Andrew was here; the rest are transient runtime gates.
  const BINDING_PHRASE = {
    posture: 'it is set to WAIT or SUGGEST, so it is not allowed to act on its own',
    // "present" confused real users (2026-07-15): "while you're away" read as "while the app is closed". It isn't —
    // away = no clicks/keys for the idle threshold; the app stays open 24/7. Say the actual rule.
    present: 'you were using the station — it waits until you step away (no clicks or keys for a while); the app stays open',
    halt: 'the emergency stop was engaged — press any ON ITS OWN button in SETTINGS › AUTONOMY to lift it',
    leash: 'today’s job limit was already used',
    // NS-2 pre-spend readiness: the station lacks grounded knowledge (a fresh/stale dossier AND too little recent
    // activity) so a beat could not have reached a model call. Honest about what feeds it: real work + answers.
    readiness: 'the station doesn’t know you well enough yet to act unattended — run a few real tasks (or answer its questions) so it learns',
    // NS-2 pre-spend gates the precheck can also bind on (they flow through statusDecision as bindings):
    budget: 'the spending budget is exhausted — raise the cap or resume to let jobs run',
    // NOT an exhausted budget: spend history is uncertain (usually an interrupted run that never recorded its spend), so
    // a limit the Commander chose can't be checked. Raising the cap or resuming changes nothing; SPENDING LIMITS names
    // the cause and its fix (settle that run, or restart after a failed save).
    'spend-unknown': 'StarNet can’t verify past spending (usually a run that was interrupted before it recorded its spend), so your spending limits can’t be checked — see SETTINGS › SPENDING LIMITS',
    // #89: the provider-less form of the station's ONE no-credential sentence (sidecar/engine-credential.js
    // UNATTENDED_REMEDY, locked equal in test/engine-credential.test.js) — a key saved in a browser page now reaches the
    // station when it is saved, so re-saving it is a real way out, and so is the env var on a headless station.
    'no-provider': 'no runnable provider/model is configured for unattended runs — connect or re-save a provider key under SETTINGS → AI & MODELS (or set its API key variable in the environment that starts StarNet) and pick a model',
    cooldown: 'it wasn’t time for the next job yet',
    concurrency: 'the desk was busy with another run',
    'in-flight': 'a job was still running',
    'precheck-error': 'the station could not verify its budget, provider, or readiness checks, so it stood down safely',
    'persist-failed': 'the station couldn’t safely record the work, so it stood down'
  };

  // a stable, HONEST label for a binding we don't recognise (forward-compat: a new gate name renders as itself,
  // never a fabricated reason). Used by both the report's idle sentence and the panel's decision trail.
  function bindingPhrase(binding) {
    if (binding == null || binding === '') return 'nothing is blocking the next job right now';
    return BINDING_PHRASE[binding] || ('held back by the ' + String(binding) + ' gate');
  }

  // ---- LOCAL-TIME formatting (GB-13 timezone honesty) ------------------------------------------------------------
  // Format an epoch-ms as a LOCAL "1:10 AM" clock. tzOffsetMin = minutes to ADD to UTC to reach local (i.e. the
  // NEGATIVE of Date#getTimezoneOffset — the browser store passes -new Date().getTimezoneOffset()). Pure + testable:
  // no Date construction, no ambient zone. 0/invalid ms → '' (a report never prints a fake "12:00 AM" for no data).
  function fmtLocalTime(ms, tzOffsetMin) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const off = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : 0;
    const local = n + off * 60000;
    let mins = Math.floor(local / 60000) % 1440;
    if (mins < 0) mins += 1440;
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  // pluralise a count with its noun ("1 beat" / "2 beats"). Pure helper the headline + lines share.
  function plural(n, noun) { return n + ' ' + noun + (n === 1 ? '' : 's'); }

  // THE AWAY RULE, in plain words (clarity fix 2026-07-15): "away" never meant "app closed" — it means no clicks or
  // keys for status.awayAfterMs. Compose the one sentence that kills that misread, with the REAL threshold when the
  // sidecar sends it (truthful telemetry — the number is the exact enforced knob, never a hardcoded guess). An older
  // sidecar without the field still gets the honest rule, just without the number.
  function awayRuleText(status) {
    const ms = status && Number(status.awayAfterMs);
    const mins = (Number.isFinite(ms) && ms > 0) ? Math.round(ms / 60000) : 0;
    const span = mins > 0 ? (mins + ' min without clicks or keys') : 'a stretch without clicks or keys';
    return 'Leave the app running — “away” just means ' + span + '. Autonomy starts by itself once you stop using the station, and stands down the moment you’re back.';
  }

  // ---- report composition ----------------------------------------------------------------------------------------
  // compose({ status, ledger, drafts, awaySince, nowMs, tzOffsetMin }) → the full morning-report view model, or
  // { hasReport:false } when there is genuinely nothing to say (so the caller shows NO beat — never a nag).
  //
  //   status  : GET /api/nightshift/status payload (or null if unreachable)
  //   ledger  : array of ledger entries (already newest-first); we scope to source:'nightshift' + the away window
  //   drafts  : GET /api/nightshift/drafts payload's drafts array
  //   awaySince: ms epoch the away window opened (only decisions after this belong to THIS absence)
  //
  // hasReport is true iff the night shift ACTED (≥1 draft/act) OR DECLINED at least once in this window — i.e. there
  // is a real decision to report. A window with zero night-shift decisions (the shift never even considered a beat,
  // e.g. the dial was off the whole time) → { hasReport:false }: nothing happened AND nothing was suppressed, so
  // there is nothing honest to announce. (The panel still shows the always-on posture; the BEAT stays silent.)
  function compose(input) {
    input = input || {};
    const status = input.status || null;
    const nowMs = Number(input.nowMs) || 0;
    const awaySince = Number(input.awaySince) || 0;
    const tz = input.tzOffsetMin;

    // ledger: only THIS station's night-shift decisions inside the away window, newest-first as given.
    const rawLedger = Array.isArray(input.ledger) ? input.ledger : [];
    const scoped = rawLedger.filter(e => e && e.source === 'nightshift' && Number(e.ts) >= awaySince && e.kind !== 'note');
    const acts = scoped.filter(e => e.kind === 'act');
    const declines = scoped.filter(e => e.kind === 'decline');

    // drafts are the RICHEST act surface (real titles + bodies); they lead. Fall back to ledger acts for a title
    // when the drafts route was unreachable but the ledger recorded the act (honest, never invented).
    const rawDrafts = Array.isArray(input.drafts) ? input.drafts : [];
    const draftList = rawDrafts
      .filter(d => d && Number(d.at) >= awaySince && d.title)
      .map(d => ({ title: String(d.title), at: Number(d.at) || 0, body: String(d.body || ''), note: String(d.note || ''), archetype: d.archetype || '' }));

    const actCount = Math.max(draftList.length, acts.length);
    const declineCount = declines.length;

    // NOTHING to report: no act, no decline in this window. Caller shows no beat.
    if (actCount === 0 && declineCount === 0) return { hasReport: false, actCount: 0, declineCount: 0 };

    // NS-5b: the report LEADS with the declared night FOCUS + its cited evidence, so a wrong guess is visible and
    // correctable ("actually, focus on Y"). Every claim maps to status.focus (truthful telemetry — never invented).
    const focus = (status && status.focus) || input.focus || null;
    let priorityLine = '';
    if (focus && (focus.label || focus.ref)) {
      const why = Array.isArray(focus.why) ? focus.why.filter(Boolean).join('; ') : '';
      priorityLine = 'priority: ' + String(focus.label || focus.ref) + (focus.source === 'steer' ? ' (you steered this)' : '') + (why ? ' — because ' + why : '');
    }

    // headline — "N jobs done, M drafts on your desk" (plain words: a "job" is one small unattended run).
    const headline = actCount > 0
      ? (plural(actCount, 'job') + ' done' + (draftList.length ? ', ' + plural(draftList.length, 'draft') + ' on your desk' : ''))
      : (plural(declineCount, 'job') + ' skipped — nothing landed on your desk');

    // ACT lines: one per draft (real title). If the drafts route was down but the ledger has acts, list the count.
    const actLines = draftList.length
      ? draftList.map(d => '✓ ' + d.title)
      : (acts.length ? [plural(acts.length, 'job') + ' done (drafts unavailable to list)'] : []);

    // DECLINE lines: the honest other half. Group declines by their binding, name the gate + the time of the last
    // occurrence in LOCAL clock ("2 beats skipped — leash spent by 1:10 AM"). Deterministic ordering by binding.
    const byBinding = {};
    for (const d of declines) {
      const b = (d.binding == null || d.binding === '') ? 'unknown' : String(d.binding);
      if (!byBinding[b]) byBinding[b] = { count: 0, lastTs: 0 };
      byBinding[b].count += 1;
      const ts = Number(d.ts) || 0;
      if (ts > byBinding[b].lastTs) byBinding[b].lastTs = ts;
    }
    const declineLines = Object.keys(byBinding).sort().map(b => {
      const g = byBinding[b];
      const when = fmtLocalTime(g.lastTs, tz);
      return '— ' + plural(g.count, 'job') + ' skipped: ' + bindingPhrase(b) + (when ? ' (by ' + when + ')' : '');
    });

    // THE "DID NOTHING AND WHY" sentence: only when the shift fired zero acts. Derive the dominant reason from the
    // most-common decline binding in the window; if there were no declines either the current live binding (status)
    // explains it. Always ONE plain sentence, always provable.
    let idleReason = '';
    if (actCount === 0) {
      let dominant = null, best = -1;
      for (const b of Object.keys(byBinding)) { if (byBinding[b].count > best) { best = byBinding[b].count; dominant = b; } }
      const bind = dominant || (status && status.binding) || null;
      idleReason = 'Nothing landed on your desk — ' + bindingPhrase(bind === 'unknown' ? null : bind) + '.';
    }

    return {
      hasReport: true,
      actCount: actCount,
      declineCount: declineCount,
      priorityLine: priorityLine,
      headline: headline,
      actLines: actLines,
      declineLines: declineLines,
      idleReason: idleReason,
      drafts: draftList   // the caller reveals full bodies on "show me"
    };
  }

  // ---- the NIGHT SHIFT PANEL view model (item #2) -----------------------------------------------------------------
  // panelModel({ status, tzOffsetMin, nowMs }) → the honest status surface for the dial panel. Every field maps to a
  // status route field; a null status → an explicit unreachable model (never a fake-zero). No decision-trail here —
  // the panel renders that straight from the ledger rows (see trailLine).
  function panelModel(input) {
    input = input || {};
    const s = input.status;
    const tz = input.tzOffsetMin;
    if (!s || typeof s !== 'object') {
      return { reachable: false, stateText: 'station telemetry unreachable', detail: '' };
    }
    const active = !!s.active;
    const away = !!s.away;
    const used = Number(s.beatsUsedToday) || 0;
    // leashPerDay is null when never configured (the status route sends null, not 0). Number(null)===0 is finite, so
    // guard on the RAW value being a real number before trusting it — a null leash must never render as "used/0".
    const leash = (typeof s.leashPerDay === 'number' && Number.isFinite(s.leashPerDay)) ? s.leashPerDay : null;
    const halted = !!s.halted;
    const leashText = leash == null ? (plural(used, 'job') + ' today') : (used + ' of ' + leash + ' jobs today');
    // THE DURABLE E-STOP HALT WINS OVER EVERYTHING (EL-11 FIX 1). status.halted means the shift is stood down
    // until the Commander re-writes the dial (handleAutonomyPosture → clearHalt) — rendering "ACTIVE · standing
    // by / NEXT ELIGIBLE <time>" here affirmatively claimed a run the E-STOP guarantees won't happen. The halted
    // model never shows a next-eligible clock and names WHICH control lifts the halt.
    if (halted) {
      return {
        reachable: true,
        active: active,
        away: away,
        halted: true,
        stateText: '⛔ HALTED — E-STOP engaged',
        why: 'autonomy is stopped and will not run until you re-set the autonomy dial — press any ON ITS OWN button above to lift the halt',
        presence: away ? 'you’re away' : 'you’re present',
        awayRuleText: awayRuleText(s),
        leashText: leashText,
        leashSpent: leash != null && used >= leash,
        lastBeatText: fmtLocalTime(s.lastBeatAt, tz) || 'no job yet',
        nextEligibleText: 'not scheduled — the E-STOP is engaged'
      };
    }
    // STATE: ACTIVE (armed) vs OFF, and the honest WHY when OFF (the live binding names the blocking gate).
    const off = !active;
    const stateText = off ? 'OFF' : (away ? 'ACTIVE · on watch' : 'ACTIVE · standing by');
    const whyOff = off ? bindingPhrase(s.binding) : (s.binding ? bindingPhrase(s.binding) : bindingPhrase(null));
    return {
      reachable: true,
      active: active,
      away: away,
      halted: false,
      stateText: stateText,
      why: whyOff,
      presence: away ? 'you’re away — it can act' : 'you’re at the station — it’s waiting',
      awayRuleText: awayRuleText(s),
      leashText: leashText,
      leashSpent: leash != null && used >= leash,
      lastBeatText: fmtLocalTime(s.lastBeatAt, tz) || 'no job yet',
      nextEligibleText: fmtLocalTime(s.nextEligibleAt, tz) || 'when the next window opens',
      modeText: modeText(s),
      modeWarn: s.buildMode === 'draft' && s.draftReason === 'no-workshop-grant',
      readinessText: readinessText(s.readiness)
    };
  }

  // BUILD-vs-DRAFT honesty (2026-07-13): name which mode the next beat runs in, straight from the status route's
  // buildMode/draftReason (server-proven). An older sidecar without the field → '' (render nothing, never guess).
  function modeText(s) {
    if (!s || (s.buildMode !== 'build' && s.buildMode !== 'draft')) return '';
    if (s.buildMode === 'build') return 'jobs build real deliverables — each arrives as a new ⚒ session in your rail';
    if (s.draftReason === 'no-workshop-grant') return 'drafts only — the away-workshop grant is off, so jobs can only draft';
    return 'drafts only — to let it build real things while you’re away, set REACH to SANDBOX under FINE-TUNE in SETTINGS › AUTONOMY';
  }

  // the cold-start explanation behind a 'readiness' stand-down: how far the station is from EITHER hot bar
  // (dossier breadth or recent-run evidence). '' when already hot / no detail (an empty line is never invented).
  function readinessText(rd) {
    if (!rd || typeof rd !== 'object' || rd.tier === 'hot') return '';
    const dims = Array.isArray(rd.usableDims) ? rd.usableDims.length : 0;
    const dimsBar = Number.isFinite(Number(rd.hotDimsMin)) ? Number(rd.hotDimsMin) : 4;
    const runsBar = Number.isFinite(Number(rd.hotRunsMin)) ? Number(rd.hotRunsMin) : 4;
    const runs = Number(rd.activityCount) || 0;
    return 'still learning you — it knows ' + dims + ' of ' + dimsBar + ' areas and has ' + runs + ' of ' + runsBar + ' recent runs; reaching either lets it act';
  }

  // THE DIAL-RAISE OUTLOOK (NS visibility 2026-07-13): the one honest sentence shown the INSTANT the Commander raises
  // the autonomy dial (the awakening cadence beat / the station panel) — what a beat will ACTUALLY do while they're
  // away (build vs draft) and how far the station still is from being allowed to act (cold-start readiness). Composed
  // straight from a /api/nightshift/status payload via the SAME modeText/readinessText the panel uses — so the dial
  // feedback and the panel can never disagree (truthful telemetry). Returns '' when there is nothing honest to add:
  // an unreachable/absent status, OR a fully-hot build-capable station whose only truthful line ('beats BUILD…') the
  // caller may still choose to show. NEVER invents — every clause maps to a status field. Pure + node-testable.
  function postureOutlook(status) {
    if (!status || typeof status !== 'object') return '';
    const mode = modeText(status);                       // build-vs-draft, straight from status.buildMode/draftReason
    const ready = readinessText(status && status.readiness);   // '' once a hot bar is cleared (nothing to caveat)
    const parts = [];
    if (mode) parts.push(mode);
    if (ready) parts.push(ready);
    if (!parts.length) return '';
    return 'here’s what that means while you’re away: ' + parts.join('; ') + '.';
  }

  // THE UNSEEN-DRAFTS PREDICATE (NS live-session nudge 2026-07-13): the drafts a night-shift beat left on the desk
  // that the Commander has NOT yet been shown — i.e. those stamped AFTER the durable lastSeenDraftAt mark (set when
  // the morning report or the NIGHT SHIFT panel surfaces them). Newest-first order is preserved from the drafts route.
  // Pure: no Date.now — "unseen" is purely (draft.at > lastSeenAt). A missing/invalid stamp (0) → every real draft is
  // unseen (honest: nothing has been surfaced yet). Guards each row so a malformed entry never throws.
  function unseenDrafts(drafts, lastSeenAt) {
    const seen = Number(lastSeenAt) || 0;
    const list = Array.isArray(drafts) ? drafts : [];
    return list.filter(d => d && Number(d.at) > seen && d.title);
  }

  // one decision-trail row for the panel's scrollable ledger: "1:10 AM · declined · leash spent". Pure; a bad row
  // still renders its time + kind (never throws). kindLabel keeps the vocabulary honest (act/decline/note → words).
  function trailLine(entry, tzOffsetMin) {
    const e = entry || {};
    const when = fmtLocalTime(e.ts, tzOffsetMin) || '—';
    const kind = e.kind === 'act' ? 'acted' : (e.kind === 'decline' ? 'declined' : 'noted');
    let tail = '';
    if (e.kind === 'decline') tail = bindingPhrase(e.binding);
    else if (e.kind === 'act') tail = (e.detail && e.detail.title) ? String(e.detail.title) : (e.reason || 'left a draft');
    else tail = e.reason || (e.detail && e.detail.title) || '';
    return when + ' · ' + kind + (tail ? ' · ' + tail : '');
  }

  // COLLAPSE the decision trail (clarity fix 2026-07-15). The driver honestly records a decision EVERY tick
  // (~1/min), so a present/leash-bound hour renders as dozens of IDENTICAL "declined · …" rows — which reads as
  // "this feature is broken". Group CONSECUTIVE rows with the same kind+binding+reason into one entry carrying
  // count + the span's first/last ts. Pure, order-preserving (expects newest-first, works either way), truthful:
  // every collapsed row is derived from real ledger rows, nothing is dropped — only summed.
  function collapseTrail(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const out = [];
    for (const e of list) {
      if (!e) continue;
      const prev = out[out.length - 1];
      const sameRun = prev && prev.kind === e.kind && String(prev.binding || '') === String(e.binding || '') &&
        String(prev.reason || '') === String(e.reason || '') && e.kind !== 'act';   // acts are never collapsed (each is real work)
      if (sameRun) {
        prev.count += 1;
        const ts = Number(e.ts) || 0;
        if (ts < prev.spanFromTs || !prev.spanFromTs) prev.spanFromTs = ts;
        if (ts > prev.ts) prev.ts = ts;   // the row keeps the NEWEST ts (what "when" means for a span)
      } else {
        out.push(Object.assign({}, e, { count: 1, spanFromTs: Number(e.ts) || 0 }));
      }
    }
    return out;
  }

  // the display strings for a collapsed trail: a single row renders exactly like trailLine (locked format); a
  // span renders "4:26–4:37 PM · declined ×12 · <reason>" — one line instead of twelve identical ones.
  function trailLines(entries, tzOffsetMin) {
    return collapseTrail(entries).map(e => {
      if (!e.count || e.count === 1) return trailLine(e, tzOffsetMin);
      const from = fmtLocalTime(e.spanFromTs, tzOffsetMin) || '—';
      const to = fmtLocalTime(e.ts, tzOffsetMin) || '—';
      const kind = e.kind === 'decline' ? 'declined' : (e.kind === 'act' ? 'acted' : 'noted');
      let tail = '';
      if (e.kind === 'decline') tail = bindingPhrase(e.binding);
      else tail = e.reason || (e.detail && e.detail.title) || '';
      return from + '–' + to + ' · ' + kind + ' ×' + e.count + (tail ? ' · ' + tail : '');
    });
  }

  return { compose, panelModel, trailLine, collapseTrail, trailLines, awayRuleText, fmtLocalTime, bindingPhrase, plural, modeText, readinessText, postureOutlook, unseenDrafts, BINDING_PHRASE };
});
