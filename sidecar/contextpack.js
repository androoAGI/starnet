/* sidecar/contextpack.js — the RECENCY-WEIGHTED CONTEXT PACK for the night-shift PROPOSE step (autonomy layer, NS-2).

   WHY THIS EXISTS — the whole soul of the night shift. Until NS-2, an unattended beat grounded its candidate ideas
   in SIX STATIC dossier strings (goals/pain/ambition/stack/standing_orders/style) synced read-only from the frontend.
   That is a personality sketch, not a work log: it never changes as the Commander actually works, so overnight the
   agent proposed generic dossier-shaped ideas and once titled its own output "Busywork". The product promise is that
   the night shift feels like MAGIC — "it should almost know what to do before the user even says it." Magic needs
   grounding in what the Commander ACTUALLY did recently: the runs he kicked off, what he asked in chat, the goal arc
   he's on, the deliverables that landed. This module assembles that real activity into a bounded, dated digest the
   propose directive can aim at ("continue / unblock / extend what they're actually doing").

   DETERMINISM SPLIT (mirrors nightshift.js / cron-store.js / runstore.js): the pure core here is a transform over
   INJECTED inputs — NO Date.now / new Date() / Math.random / fs / crypto — so it passes lint-determinism.js and is
   headless-testable with fixed inputs + a fake `now`. The AMBIENT half (reading runStore / transcriptStore /
   commanderGoals / the ledger / the drafts + learn stores) lives ONLY in sidecar/index.js, which hands this module
   already-fetched arrays. `now` is injected so recency windows are deterministic.

   THE SECTIONS (each newest-first, each independently capped; the pack composes only the ones with substance):
     · WORKED RECENTLY — user-initiated run TITLES from the last ~7 days (literally "what the Commander is working
       on"). Internal runs (night-shift / cron / workshop) are EXCLUDED by streamId prefix — they are the station's
       own noise, not the Commander's work. This is the highest-signal grounding evidence.
     · ASKED RECENTLY  — recent user chat messages (first-line only, bounded), the topics on his mind. Internal
       streams excluded. Content is redacted again on the way in (defense in depth; the transcript store already
       redacts on write) so no secret can reach the model prompt.
     · GOAL ARC        — the single active goal-arc summary the cron persona also uses (text + progress + next step).
     · LANDED / DIDN'T — recent night-shift deliverables the Commander KEPT vs DISCARDED (what kind of work lands).
     · KNOWN ABOUT THEM — the stable dossier belief base layer (unchanged; still the floor when activity is thin).
     · LEARNED PREFS   — a one-line summary of which archetypes the Commander up/down-voted (the compounding bias).

   THE EVIDENCE POOL — the load-bearing output. `activityLines` is the flat array of dated, human-readable activity
   lines (runs + chats + goal + landed work). It is fed to the GROUNDING VETO alongside the dossier beliefs, so a
   candidate may honestly ground itself in a real recent RUN or CHAT — not just a static belief — and invented
   grounding still dies (autopilot.js extends its evidence pool = beliefs + activityLines). NEVER fabricated: every
   line traces to a real record the caller fetched. An empty night yields an empty pool (honest — nothing to cite).

   HARD BOUNDS: total pack text capped (DEFAULT_MAX_CHARS); each section capped in item count + per-line length;
   deterministic given (inputs, now). A pathological history can never bloat the prompt or leak an unbounded blob. */
'use strict';
(function (root, factory) {
  // SECRETS (context-key-redact, 2026-10-28): under node the pack scrubs every stored line through prompt-scrub by
  // DEFAULT, not by caller injection — run titles, goals and landed titles used to pass raw while only briefs and chats
  // got the caller's redact, so a key typed once rode every later RECENT ACTIVITY line.
  const node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const api = factory(node ? require('./prompt-scrub.js').scrubStored : null);
  if (node) module.exports = api;
  else { (root.SK = root.SK || {}).contextpack = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultScrub) {
  'use strict';

  const DAY_MS = 86400000;
  const DEFAULT_WINDOW_DAYS = 7;          // "recently" = the last week of activity
  const DEFAULT_MAX_CHARS = 2400;         // hard ceiling on the whole pack text (keeps the propose prompt bounded)
  const MAX_RUNS = 8;                     // newest user-run titles to carry
  const MAX_BRIEFS = 6;                   // newest completed directives; richer evidence than a generated title
  const MAX_CHATS = 6;                    // newest user chat first-lines to carry
  const MAX_LANDED = 5;                   // newest kept/discarded deliverables to carry
  const LINE_MAX = 140;                   // per activity line (a title/first-line is a label, not a document)
  const ACTIVITY_POOL_MAX = 24;           // the veto evidence pool is bounded too (matches beliefs' order of size)

  // the internal streamId prefixes whose runs/chats are the STATION's own noise, never the Commander's work.
  // A run/chat on one of these streams is excluded from "what they worked on / asked". Kept as a prefix list so a
  // new internal surface (a future 'foo-'+runId) is one entry away from being excluded, not a scattered edit.
  const INTERNAL_STREAM_PREFIXES = ['nightshift-', 'nightshift-act-', 'cron-', 'workshop-'];

  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => ((typeof v === 'number' && isFinite(v)) ? v : 0);
  // collapse whitespace + clamp to a single legible line. Pure.
  function oneLine(s, max) {
    const t = str(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const m = num(max) || LINE_MAX;
    return t.length > m ? (t.slice(0, m - 1).trimEnd() + '…') : t;
  }
  // is this streamId one of the station's own internal surfaces? (prefix match, case-sensitive — streamIds are
  // machine-generated, never user text). An empty/absent streamId is the DEFAULT global browser workstream = a
  // real user run, so it is NOT internal.
  function isInternalStream(streamId) {
    const s = str(streamId);
    if (!s) return false;
    for (let i = 0; i < INTERNAL_STREAM_PREFIXES.length; i++) if (s.indexOf(INTERNAL_STREAM_PREFIXES[i]) === 0) return true;
    return false;
  }

  // a compact, human-legible relative-day tag for a timestamp, given `now` (injected). "today" / "yesterday" /
  // "Nd ago". Deterministic — pure arithmetic over the two ms values, no Date object. 0/unknown ts → '' (undated).
  function dayTag(ts, now) {
    const t = num(ts), n = num(now);
    if (!t || !n || n < t) return '';
    const days = Math.floor((n - t) / DAY_MS);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  }

  /* assemble — THE pure transform. Given already-fetched inputs + `now` + opts, returns:
       {
         sections: [{ label, lines:[string] }],   // only the sections that had substance, newest-first within each
         text: string,                             // the composed, char-bounded prompt block (or '' when empty)
         activityLines: [string],                  // the flat EVIDENCE POOL for the grounding veto (runs+chats+goal+landed)
         counts: { runs, chats, landed, beliefs }  // small telemetry for the status route / honesty
       }
     inputs (each optional; a missing one degrades to an empty section — an honest thin pack, never a throw):
       inputs.runs     : [{ title, ts, streamId, reason, internal }]   (runStore.list order-agnostic; we sort + filter;
                                                             internal runs are excluded AND their directive rows drop from chats)
       inputs.chats    : [{ role, content, ts, streamId }]   (transcriptStore.all(); we filter role:'user' + internal)
       inputs.goal     : { text, done, total, next } | null  (commanderGoals.get())
       inputs.landed   : [{ title, verdict, ts }]            (verdict ∈ 'kept'|'discarded'; recent decided deliverables)
       inputs.beliefs  : { goals:[t], pain:[t], ... }        (nightshiftBeliefMap(): the stable dossier base layer)
       inputs.learn    : { archetype:{up,down} }             (the LEARN store; summarized to one line)
       inputs.trackRecord : [string]                         (outcomes.js lines(); pre-composed literal-count lines)
       inputs.redact   : fn(string)->string                  (an EXTRA scrubber, applied before the default one)
       inputs.matchRedact : fn(string)->string               (the transcript's redaction: only for the self-talk join)
     opts: { now, windowDays, maxChars }
     Every stored string (run titles, internal heads, briefs, chats, goal, landed titles, beliefs, track record) is
     scrubbed BEFORE oneLine clips it: prompt-scrub's scrubStored by default, after inputs.redact when one is given —
     an injected scrubber can add to the default, never weaken it. */
  function assemble(inputs, opts) {
    inputs = inputs || {}; opts = opts || {};
    const now = num(opts.now);
    const windowMs = (num(opts.windowDays) || DEFAULT_WINDOW_DAYS) * DAY_MS;
    const maxChars = num(opts.maxChars) || DEFAULT_MAX_CHARS;
    const injected = (typeof inputs.redact === 'function') ? inputs.redact : null;
    const redact = (s) => {
      const t = injected ? injected(s) : s;
      return typeof defaultScrub === 'function' ? defaultScrub(str(t)) : str(t);
    };
    const withinWindow = (ts) => { const t = num(ts); return !now || !t || (now - t) <= windowMs; };
    /* THE STATION'S OWN SELF-TALK IS NOT THE COMMANDER'S ACTIVITY (USER-STUDY LOOP, 2026-09-28). A reason-only
       internal call (goal decomposition, the first-meeting prompts, session recommendations…) is recorded as a run
       flagged `internal`, AND its directive lands in the transcript as a 'user' row on the Commander's own stream —
       so it read as "what they asked recently" and the planners studied the station instead of the person. The run
       flag is the authority: its directive head identifies the matching transcript row. */
    // both sides scrubbed: a title holding a key still matches the (redacted-on-write) transcript row it came from.
    // inputs.matchRedact = the transcript's OWN redaction (the host's context.redact): it scrubs more than the prompt
    // resolver (every connector header/env string), so a title is put through it too before the heads are compared.
    const matchRedact = (typeof inputs.matchRedact === 'function') ? inputs.matchRedact : null;
    const headOf = s => oneLine(redact(matchRedact ? matchRedact(str(s)) : s), 400).replace(/…$/, '').slice(0, 48).toLowerCase();
    const internalHeads = (Array.isArray(inputs.runs) ? inputs.runs : [])
      .filter(r => r && r.internal).map(r => headOf(r.title)).filter(h => h.length >= 12);
    const isSelfTalk = text => { if (!internalHeads.length) return false; const h = headOf(text); return h.length >= 12 && internalHeads.some(x => h.indexOf(x) === 0 || x.indexOf(h) === 0); };

    const sections = [];
    const activityLines = [];
    const counts = { runs: 0, briefs: 0, chats: 0, landed: 0, beliefs: 0 };

    // ── WORKED RECENTLY — user-initiated run titles, newest-first, windowed, internal excluded, de-duped by title.
    const runLines = [];
    {
      const rows = (Array.isArray(inputs.runs) ? inputs.runs : [])
        .filter(r => r && !r.internal && str(r.title).trim() && !isInternalStream(r.streamId) && withinWindow(r.ts))
        .slice()
        .sort((a, b) => num(b.ts) - num(a.ts));   // newest-first (deterministic; ties keep input order via stable-ish sort input)
      const seen = {};
      for (const r of rows) {
        if (runLines.length >= MAX_RUNS) break;
        const title = oneLine(redact(r.title), LINE_MAX);
        const key = title.toLowerCase();
        if (!title || seen[key]) continue;         // a repeated run title is one thing they're working on, not N
        seen[key] = 1;
        const tag = dayTag(r.ts, now);
        runLines.push(tag ? (title + ' (' + tag + ')') : title);
      }
    }
    counts.runs = runLines.length;
    if (runLines.length) { sections.push({ label: 'What they worked on recently', lines: runLines.slice() }); for (const l of runLines) activityLines.push(l); }

    // Completed task briefs preserve the Commander's full request, collapsed to one bounded line. Unlike run
    // titles and chat openings, this can retain evidence that appeared after a newline in a multi-part directive.
    const briefLines = [];
    {
      const rows = (Array.isArray(inputs.briefs) ? inputs.briefs : [])
        .filter(b => b && str(b.originalDirective).trim() && withinWindow(b.ts))
        .slice().sort((a, b) => num(b.ts) - num(a.ts));
      const seen = {};
      for (const b of rows) {
        if (briefLines.length >= MAX_BRIEFS) break;
        const directive = oneLine(redact(b.originalDirective), 220);
        const key = directive.toLowerCase();
        if (!directive || seen[key]) continue;
        seen[key] = 1;
        const tag = dayTag(b.ts, now);
        briefLines.push(tag ? (directive + ' (' + tag + ')') : directive);
      }
    }
    counts.briefs = briefLines.length;
    if (briefLines.length) { sections.push({ label: 'Completed task evidence', lines: briefLines.slice() }); for (const l of briefLines) activityLines.push(l); }

    // ── ASKED RECENTLY — user chat first-lines, newest-first, windowed, internal excluded, de-duped, redacted.
    const chatLines = [];
    {
      const rows = (Array.isArray(inputs.chats) ? inputs.chats : [])
        .filter(m => m && m.role === 'user' && str(m.content).trim() && !isInternalStream(m.streamId) && withinWindow(m.ts)
          && !isSelfTalk(str(m.content).split(/\r?\n/)[0] || ''))
        .slice()
        .sort((a, b) => num(b.ts) - num(a.ts));
      const seen = {};
      for (const m of rows) {
        if (chatLines.length >= MAX_CHATS) break;
        // FIRST LINE only, redacted again (defense in depth), clamped — never a full body, never a secret.
        const first = oneLine(redact(str(m.content).split(/\r?\n/)[0] || ''), LINE_MAX);
        const key = first.toLowerCase();
        if (!first || seen[key]) continue;
        seen[key] = 1;
        const tag = dayTag(m.ts, now);
        chatLines.push(tag ? ('"' + first + '" (' + tag + ')') : ('"' + first + '"'));
      }
    }
    counts.chats = chatLines.length;
    if (chatLines.length) { sections.push({ label: 'What they asked recently', lines: chatLines.slice() }); for (const l of chatLines) activityLines.push(l); }

    // ── GOAL ARC — the single active goal-arc line (text + progress + next). Feeds the pool too (it IS current work).
    {
      const g = inputs.goal;
      if (g && str(g.text).trim()) {
        let line = oneLine(redact(g.text), LINE_MAX);
        const done = num(g.done), total = num(g.total);
        if (total > 0) line += ' (' + done + '/' + total + ' done)';
        if (str(g.next).trim()) line += ' — next: ' + oneLine(redact(g.next), 80);
        sections.push({ label: 'Their current goal', lines: [line] });
        activityLines.push(line);
      }
    }

    // ── LANDED / DIDN'T — recent kept vs discarded deliverables (what kind of work lands well). Newest-first.
    const landedLines = [];
    {
      const rows = (Array.isArray(inputs.landed) ? inputs.landed : [])
        .filter(d => d && str(d.title).trim() && withinWindow(d.ts))
        .slice()
        .sort((a, b) => num(b.ts) - num(a.ts));
      for (const d of rows) {
        if (landedLines.length >= MAX_LANDED) break;
        const kept = (str(d.verdict) === 'kept');
        const mark = kept ? '✓ kept' : '✗ discarded';
        landedLines.push(oneLine(redact(d.title), LINE_MAX) + ' — ' + mark);
      }
    }
    counts.landed = landedLines.length;
    if (landedLines.length) { sections.push({ label: 'Recent work they kept vs discarded', lines: landedLines.slice() }); for (const l of landedLines) activityLines.push(l); }

    // ── KNOWN ABOUT THEM — the stable dossier base layer (NOT added to the activity pool; beliefs are their own veto
    //    evidence pool in autopilot.js). Kept for the prompt so a thin-activity night still has the personality floor.
    const beliefLines = [];
    {
      const b = (inputs.beliefs && typeof inputs.beliefs === 'object') ? inputs.beliefs : {};
      const dim = (key, label) => { const arr = Array.isArray(b[key]) ? b[key].filter(Boolean) : []; if (arr.length) beliefLines.push(label + ': ' + oneLine(arr.map(redact).join(' | '), LINE_MAX)); };
      dim('goals', 'Goals'); dim('pain', 'Pain'); dim('ambition', 'Ambition'); dim('stack', 'Stack'); dim('standing_orders', 'Standing orders'); dim('style', 'Style'); dim('people', 'People / audience'); dim('schedule', 'Schedule');
    }
    counts.beliefs = beliefLines.length;
    if (beliefLines.length) sections.push({ label: 'What they told you about themselves', lines: beliefLines.slice() });

    // ── LEARNED PREFS — one line: the archetypes the Commander leans toward / away from (from up/down verdicts).
    {
      const L = (inputs.learn && typeof inputs.learn === 'object') ? inputs.learn : {};
      const up = [], down = [];
      for (const k in L) { const e = L[k] || {}; const net = num(e.up) - num(e.down); if (net > 0) up.push(k); else if (net < 0) down.push(k); }
      if (up.length || down.length) {
        const parts = [];
        if (up.length) parts.push('leans toward: ' + up.slice(0, 4).join(', '));
        if (down.length) parts.push('away from: ' + down.slice(0, 4).join(', '));
        sections.push({ label: 'What they tend to keep', lines: [oneLine(parts.join('; '), LINE_MAX)] });
      }
    }

    // ── TRACK RECORD (outcome learning, 2026-08-30) — what this station's runs actually PRODUCE, folded by
    //    outcomes.js from the run history (literal window counts, support-gated). The night shift should build
    //    with the shapes that finish and treat the ones that keep failing as evidence AGAINST proposing more of
    //    the same. Lines arrive pre-composed (every number in them is a countable run) — this section only
    //    bounds and labels them. NOT added to the activity pool: a statistic is context, never grounding a
    //    candidate may cite as the Commander's own activity.
    {
      const track = (Array.isArray(inputs.trackRecord) ? inputs.trackRecord : []).map(l => oneLine(redact(l), LINE_MAX)).filter(Boolean).slice(0, 4);
      if (track.length) sections.push({ label: 'What keeps working vs failing here', lines: track });
    }

    // bound the evidence pool (defense in depth — the section caps already bound it, but the pool is consumed by the
    // veto and must never grow unbounded even if the caps are later loosened). Newest sources first (runs, chats).
    const pool = activityLines.slice(0, ACTIVITY_POOL_MAX);

    // compose the char-bounded text. Sections drop whole (never mid-section) once the budget is hit, so the text is
    // always a coherent prefix of the sections — the highest-signal sections (runs, chats) come first, so a tight
    // budget keeps the most valuable grounding.
    const text = composeText(sections, maxChars);

    return { sections, text, activityLines: pool, counts };
  }

  // compose the section list into one bounded text block. Deterministic. Adds WHOLE sections while they fit under
  // maxChars (a partial section is never emitted at the section boundary), then stops. As a HARD backstop, the final
  // string is clamped to maxChars — so even a single pathological first section (e.g. 8 long run lines) can never
  // exceed the cap. The highest-signal sections (runs, chats) come first, so a tight budget keeps the best grounding.
  // Empty → ''.
  function composeText(sections, maxChars) {
    const cap = num(maxChars) || DEFAULT_MAX_CHARS;
    const out = [];
    let used = 0;
    for (const sec of (Array.isArray(sections) ? sections : [])) {
      const body = [sec.label + ':'].concat((sec.lines || []).map(l => '- ' + l)).join('\n');
      const add = (out.length ? 2 : 0) + body.length;   // +2 for the blank-line join between sections
      if (out.length && used + add > cap) break;         // stop before overflowing (but always try at least one)
      out.push(body);
      used += add;
      if (used >= cap) break;
    }
    const text = out.join('\n\n');
    return text.length > cap ? text.slice(0, cap) : text;   // hard backstop: never exceed the cap
  }

  return {
    assemble, composeText, isInternalStream, dayTag, oneLine,
    DAY_MS, DEFAULT_WINDOW_DAYS, DEFAULT_MAX_CHARS, MAX_RUNS, MAX_BRIEFS, MAX_CHATS, MAX_LANDED, LINE_MAX,
    ACTIVITY_POOL_MAX, INTERNAL_STREAM_PREFIXES
  };
});
