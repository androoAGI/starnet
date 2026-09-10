/* STARNET — chat.js : the in-game COMMS panel.
   Talking to your agent is a REAL streaming model call (via Harness). While a reply
   the agent walks to its workstation and types (World.setActivity('task')).
   Supports: preloaded history (resume), and an "awaiting purpose" first-message mode. */
'use strict';

// VOICE MODE augmentation — appended to the system prompt (per-turn, ephemeral) only when the
// agent is about to SPEAK a conversational reply. Forces a short, spoken-style answer; the paired
// text/task turns get NO augmentation, so written replies keep full structure (the whole "voice =
// laid-back back-and-forth, type = detailed" split is produced by the presence/absence of this block).
function voiceModeRules() {
  const hint = 'Keep the same effective personality, language preference and custom style as the system prompt';
  return "\n\n[VOICE MODE — you're talking out loud, not typing.] Reply the way you'd actually SAY it:"
    + " 1-3 short sentences, max. Use natural spoken phrasing consistent with your formality setting. Plain spoken words only —"
    + " absolutely NO markdown, asterisks, bullet points, numbered lists, headers, code blocks, emoji, or links;"
    + " those can't be heard. Don't read out URLs or file paths character-by-character — just say what you did."
    + " No throat-clearing, no 'As an AI', no 'I'd be happy to', no recapping the question. " + hint + "."
    + " If the real answer is long, give the one-line version out loud and offer to drop the details in chat.";
}

const Chat = (() => {
  let log, input, statusEl;
  let attachInput = null, attachStrip = null;   // ATTACHMENTS: the hidden <input type=file> + the composer preview strip
  let pendingAtts = [];   // ATTACHMENTS: files staged in the composer for the NEXT send — { name, kind, localUrl, status, ref }
  let system = '', name = 'AGENT', activeWs = null;
  let focusVersion = 0;   // invalidates run-owned navigation after the Commander leaves a session
  // TIER D · D1 WARMTH (2026-07-02): COMMS is a persistent panel, so setChatFocus never clears — the focused
  // body would otherwise chat-stare (track your cursor) forever. world.js decays the stare after a random
  // 30-90s warmth window (drawn fresh per engagement — unpredictable by design); this re-warms it on the genuine
  // engagement moments (typing / sending / run-end return-to-stare of the focused stream) so an ACTIVE
  // conversation holds the stare, an idle one lets go. O(1); no-ops when no focus is set. Engagement points only.
  function warmChat() { if (typeof World !== 'undefined' && World.chatFocusPing) World.chatFocusPing(); }
  let onTurn = null, interview = null;   // interview: the AWAKENING answer handler — while set, COMMS input feeds onboarding, not the model
  // THE GATE: per-workstream run-state (busy / runId / in-flight text / tool lines / pending approval) lives in
  // Channels (channels.js) so streams are isolated and survive a switch — chat.js is the DOM view over it. The
  // one thing that can't live in the pure model is the live AbortController (not serializable), so it stays here.
  const aborters = new Map();   // workstreamId -> AbortController for that stream's in-flight run
  const interrupted = new Set();   // wsIds the Commander deliberately STOPPED this turn — send()'s catch reads this as a
                                   // graceful stop (keep the partial reply, log no error) rather than a disconnect. Consumed in finally.
  const interruptedStreams = new Set();   // wsIds whose in-flight run lost its stream; durable recovery decides
                                   // whether work resumes automatically or stops for explicit review.
  const recoveryClaims = new Set();       // source run ids already being recovered by this page
  const recoveryNotices = new Set();      // review-required run ids already explained on this page
  let reconnectTimer = 0;          // the single reconnect health-probe poll (armed only while interruptedStreams is non-empty)
  const queued = new Map();        // TYPE-AHEAD: wsId -> [text,…] follow-ups typed while the stream was busy; auto-sent in order as it frees
  let activeLiveRow = null;     // streaming text controller for the DISPLAYED stream's in-flight run; rebound by replayChannel on switch
                                // CLASSIC HARNESS FLOW: prose and the agent's actions (tool ▶/◀ lines, deliverables, approval
                                // prompts) render CHRONOLOGICALLY — newest at the bottom — instead of pinning one reply block to
                                // the bottom with work floating above it. streamingAgent() segments the prose so an action drops
                                // in BETWEEN text blocks, exactly where it happened.
  let proposalsWired = false;   // the memory.proposed (turn-in) U.bus listener is registered exactly once
  let studyWired = false;       // the agent.run.end STUDY (dossier Phase B) listener is registered exactly once
  let curiosityWired = false;   // the agent.run.end curiosity-nudge listener is registered exactly once
  let arcRunsSeen = new Set();  // GROWTH Tier 2: runIds already arc-offered (agent.run.end can re-fire; offer once per run)
  /* RE-CONFIRM DEFERRALS, THIS SESSION ONLY (fixed 2026-08-04). "Not now" on a "still true?" card used to call
     GoalStore.markOffered — but that same offered-fingerprint ALSO gates pendingDecomposition, so deferring the
     STALENESS QUESTION permanently withdrew the unrelated MILESTONE-DECOMPOSITION offer for that belief until its
     text changed. Two different asks, one kill switch. A deferral is a statement about the MOMENT, so it lives
     here: in memory, keyed by the belief fingerprint, gone on reload — which is exactly what "i'll ask again
     later" promises. The durable "never ask this again" answer is still the deny chip (RecQualityStore.denyBelief). */
  const reconfirmDeferred = new Set();
  let skillAsideWired = false;  // the deliverable(kind:skill) background-review aside listener is registered exactly once
  let skillDelivSeen = new Set();   // deliverable ids already asided → the background review re-firing never double-asides
  let recentInRunSkill = 0;     // ts of the last IN-RUN skill.* tool call — suppresses the aside for a save the A1 chip already showed
  let trustWired = false;       // GROWTH Tier 3: the agent.run.end earned-autonomy offer-beat listener (registers once)
  let threadWired = false;      // NS-6: the agent.run.end THREAD turn-in beat listener is registered exactly once
  let activeNudge = null;       // the live curiosity nudge { row, choiceRow, dim } — retired if a turn-in claims the post-run beat
  let recruitShown = false;     // adaptive recruitment: the ONE recruit beat is offered at most once per session (in-memory, resets each app run)
  let activeTurnin = null;      // the single visible memory-review deck; later batches queue behind it
  const turninQueue = [];       // memory-review batches waiting for the visible deck to finish
  const activeChoiceRows = new Set();   // one-shot chip rows; cleared when a typed answer supersedes them
  const receiptRunsSeen = new Set();    // runIds whose SILENT auto-saved receipts already rendered (memory.write triggers once per run)
  const clarificationRuns = new Set();  // an intent-question turn is a continuation, not completed work
  /* Deliverable titles this run ALREADY announced inline, as they happened. The recap card is the run's
     ledger and must stay complete, but on a short run the same filename landed three times in a row — the
     live "▤ saved x.md [folder]" line, the reply's prose, then the recap's own "▤ wrote x.md [⧉][folder]".
     The ledger row keeps the name and the size; it drops the duplicate ACTIONS, because the affordance was
     already offered a few lines up. FIFO-capped like runWork. */
  const runShownDeliv = new Map();   // runId -> Set(title)
  function noteShownDeliverable(runId, title) {
    if (!runId || !title) return;
    if (!runShownDeliv.has(runId)) runShownDeliv.set(runId, new Set());
    runShownDeliv.get(runId).add(String(title));
    if (runShownDeliv.size > 60) runShownDeliv.delete(runShownDeliv.keys().next().value);
  }
  function deliverableAlreadyShown(runId, path) {
    const set = runId ? runShownDeliv.get(runId) : null;
    return !!(set && set.has(String(path || '')));
  }
  const runWork = new Map();    // runId -> { toolsOk, delivered, cost, agentId } captured at run end → the "rate the work"
                                // beat's HONEST, un-farmable size + the delivery gate (real tools/deliverables only). FIFO-capped.
  // P3.2 CREW ATTRIBUTION: a lead run that dispatched crew gets each worker's PROVABLE spend so a 👍 on the run
  // can split its XP mint honestly. Fed by wireCrewCapture (below): every forwarded worker agent.run.end lands in
  // a rolling buffer keyed by the worker's OWN runId; at the lead's run.end we CLAIM the workers whose run fell
  // inside this lead run's live window (start→end). Only NAMED roster workers (team.dispatch) are attributable —
  // ephemeral team.spawn clones (sub-* ids, no persistent identity) are filtered out (crediting a vanished clone
  // would be a lie). runCrew: leadRunId -> [{ agentId, usd }]. crewSeen: the rolling worker buffer.
  const crewSeen = [];          // [{ agentId, usd, runId, at }] — recent forwarded worker run-ends (FIFO, time-windowed)
  const runCrew = new Map();    // leadRunId -> [{ agentId, usd }] claimed at lead run.end. FIFO-capped alongside runWork.
  const workRatedRuns = new Set();   // runIds already given a 👍/👌/👎 work verdict → one rating per run, never double-mint
  const workRatingsPending = new Set(); // concurrent controls wait on the server's first-verdict-wins boundary
  const RUN_META = new Map();   // runId -> { isTask, title } recorded at run START. The bus agent.run.end payload
                                // carries neither flag, so the post-run advice beats (the First Pitch graduation gate)
                                // read this to tell a real TASK from casual chat AND to name the run that actually just
                                // finished. Capped FIFO so a long session can't leak runIds.

  const el = id => document.getElementById(id);
  let stick = true;   // STICKY-BOTTOM: auto-scroll only fires when the Commander is already at/near the bottom,
                      // so scrolling UP to re-read history mid-stream isn't yanked back down by every token.
  let historyPinSeq = 0, historyPinPending = 0;   // a load owns one final post-layout pin; a real user gesture cancels it
  function nearBottom() { return !log || (log.scrollHeight - log.scrollTop - log.clientHeight < 40); }
  function autoscroll() { if (stick && log) log.scrollTop = log.scrollHeight; else if (log) showNewPill(true); }   // content landed while unstuck → "new messages"

  /* COMMS-PREMIUM · the jump-to-bottom pill. Two states over ONE control (stick machinery, no new scroll state):
     • scrolled UP to re-read (stick=false) → a dim, PERSISTENT "↓ latest" affordance (so a keyboard/AT user
       always has a way back to the newest line, not only when new content happens to land);
     • fresh content lands while unstuck → it brightens to "new messages ↓".
     Anchored to #chat-log's bottom EDGE (just above the composer) by measuring the composer height each show,
     so it rides a one- or multi-line composer instead of a magic offset. Click jumps down + re-arms stickiness. */
  function jumpToBottom() { if (log) { log.scrollTop = log.scrollHeight; stick = true; hideNewPill(); } }
  function cancelHistoryPin() { historyPinPending = 0; }
  function pinLoadedHistoryAfterLayout(seq) {
    const pin = () => {
      if (!log || historyPinPending !== seq) return;
      log.scrollTop = log.scrollHeight;
      historyPinPending = 0;
      stick = nearBottom();
      if (stick) hideNewPill();
    };
    // Bulk history rows can grow after their synchronous append as markdown/font layout settles. Two paint
    // frames make the final scroll use the rendered height, not the transient height seen by row().
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(pin));
    else setTimeout(pin, 0);
  }
  function positionNewPill(pill) {
    // sit the pill just above the composer: distance from the panel's bottom = the composer stack's height.
    const composer = el('chat-inputrow'), queuedEl = el('chat-queued');
    const h = (composer ? composer.offsetHeight : 0) + (queuedEl ? queuedEl.offsetHeight : 0) + 8;
    pill.style.bottom = h + 'px';
  }
  function showNewPill(hasNew) {
    const panel = el('chat-panel'); if (!panel || stick) return;
    let pill = el('comms-newpill');
    if (!pill) {
      pill = document.createElement('button'); pill.id = 'comms-newpill'; pill.type = 'button'; pill.className = 'comms-newpill';
      pill.onclick = () => { if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); jumpToBottom(); };
      panel.appendChild(pill);
    }
    if (hasNew) pill.classList.add('hasnew');
    const isNew = pill.classList.contains('hasnew');
    pill.textContent = isNew ? 'new messages' : 'latest';   // the ▾ chevron is drawn by CSS (::after), not a font glyph
    pill.setAttribute('aria-label', isNew ? 'Jump to newest messages' : 'Scroll to latest');
    positionNewPill(pill);
    pill.classList.add('show');
    if (log) log.classList.add('pill-clear');   // reserve the pill's height at the foot of the scroll so it never covers the newest line
  }
  function hideNewPill() {
    const p = el('comms-newpill'); if (p) { p.classList.remove('show'); p.classList.remove('hasnew'); }
    if (log) log.classList.remove('pill-clear');
  }

  /* COMMS PROCESSING TIMER — a live wall-clock readout in the header (▸ thinking · 3s) that counts how long
     the DISPLAYED stream's turn has been running. The start instant lives on the channel (Channels.startedAt),
     so the count is per-stream and survives a switch: jump to a background run and the timer shows ITS elapsed,
     not a reset. Honest by construction — it reads real wall-clock, never a fabricated number, and is empty
     (→ hidden) the moment the shown stream isn't running. */
  let elapsedTimer = 0;
  function fmtElapsed(ms) {
    const s = Math.floor((ms < 0 ? 0 : ms) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;   // 3s · 42s · 1:05 · 12:30
  }
  function renderElapsed() {
    const ce = el('chat-elapsed'); if (!ce) return;
    const started = (activeWs && typeof Channels !== 'undefined') ? Channels.startedAtOf(activeWs.id) : 0;
    if (!isBusy() || !started) { if (ce.firstChild) ce.textContent = ''; return; }   // empty → CSS hides it
    const txt = fmtElapsed(Channels.elapsedOf(activeWs.id, Date.now()));   // honest elapsed: re-stamped to the confirmed run start, approval pauses excluded
    let num = ce.querySelector('.ce-num');
    if (!num) { ce.textContent = ''; num = document.createElement('span'); num.className = 'ce-num'; ce.appendChild(num); }
    if (num.textContent !== txt) num.textContent = txt;   // only the digits change → the pulsing dot never restarts
    renderPresence();   // the presence card rides the same tick (single source of the elapsed wall-clock)
  }
  function ensureElapsedTimer() {
    renderElapsed();
    if (elapsedTimer) return;
    elapsedTimer = setInterval(() => { renderElapsed(); if (!isBusy()) stopElapsedTimer(); }, 250);   // sub-second tick so seconds land on time
  }
  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = 0; }
    const ce = el('chat-elapsed'); if (ce && ce.firstChild) ce.textContent = '';
  }

  /* ── COMMS-PREMIUM · LIVE WORKING-PRESENCE CARD ─────────────────────────────────────────────────────
     While a run is in flight ONE presence card is pinned at the transcript bottom (a real last-child of
     #chat-log, so it sits above the composer and scrolls with the feed): a blinking ▮, the current status
     VERB (THINKING / WORKING / AWAITING APPROVAL — derived from the SAME state that drives #chat-status),
     the CURRENT tool (latest onToolCall name, cleared on its result), and the elapsed time (reuses the
     existing per-stream wall-clock — Channels.startedAtOf — never a second counter). It appears on run
     start, updates IN PLACE via the elapsed tick (no transcript spam), and on run end resolves into a
     compact one-line summary (■ RUN COMPLETE · 2:14 [· N steps][· $x]); on error it resolves red. Truthful
     telemetry only: turns/cost are shown ONLY when a real value is handed in, never invented. */
  let presenceCurTool = null;   // the DISPLAYED stream's latest un-resolved tool name (or null)
  function presenceCard() {
    if (!log) return null;
    let card = log.querySelector('#comms-presence');
    // a RESOLVED card is transcript history ("■ RUN COMPLETE · …"), not the live indicator. Resurrecting it
    // by id broke every run after a stream's first: its children were destroyed by the summary write, so the
    // live verb/tool/time could never render again, and the re-pin below dragged the old summary under the
    // new turn. Strip its id (it stays in place as history) and build a fresh live card.
    if (card && card.classList.contains('resolved')) { card.removeAttribute('id'); card = null; }
    if (!card) {
      clearEmptyState();
      card = document.createElement('div'); card.id = 'comms-presence'; card.className = 'comms-presence';
      card.setAttribute('aria-live', 'polite');
      const dot = document.createElement('span'); dot.className = 'cp-dot'; dot.textContent = '▮';
      const verb = document.createElement('span'); verb.className = 'cp-verb';
      const tool = document.createElement('span'); tool.className = 'cp-tool';
      const time = document.createElement('span'); time.className = 'cp-time';
      card.appendChild(dot); card.appendChild(verb); card.appendChild(tool); card.appendChild(time);
      log.appendChild(card);   // last child → pinned at the transcript bottom
    } else if (card !== log.lastElementChild) {
      log.appendChild(card);   // a row landed after it (tool chip / prose) → re-pin to the bottom
    }
    return card;
  }
  // derive the presence VERB from the same real state syncStatus() reads (pending approval > working > thinking)
  function presenceVerb() {
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    // A clarify question rides the SAME consent transport as a permission grant, but it is not one:
    // "AWAITING APPROVAL / approve brief.ask" told the Commander to approve an internal tool name when
    // the run is simply waiting for them to answer a question (caught in shot review, 2026-08-14).
    if (p) return p.tool === 'brief.ask' ? 'AWAITING YOUR ANSWER' : 'AWAITING APPROVAL';
    const cs = (activeWs && typeof Channels !== 'undefined' && Channels.statusOf) ? Channels.statusOf(activeWs.id) : '';
    // TRUTHFUL TELEMETRY: until the sidecar's agent.run.start lands the card says CONNECTING — it never
    // claims the agent is thinking/working on the strength of a click alone (a downed sidecar would
    // otherwise show "THINKING" forever).
    if (cs && /connect/i.test(cs)) return 'CONNECTING';
    return (cs && /work/i.test(cs)) ? 'WORKING' : 'THINKING';
  }
  function renderPresence() {
    if (!log) return;
    const started = (activeWs && typeof Channels !== 'undefined') ? Channels.startedAtOf(activeWs.id) : 0;
    if (!isBusy() || !started) return;   // teardown resolves/removes it; never draw an idle presence card
    const card = presenceCard(); if (!card) return;
    // PAUSED-ON-APPROVAL: the run is stopped on the sidecar waiting for the Commander. Restyle the card so it
    // reads as a deliberate pause (no working pulse) and NAME the pending action — truth source is the same
    // Channels.pendingOf payload that renders the approval prompt, so this can never claim a pause that isn't real.
    const pend = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    const paused = !!pend;
    card.classList.toggle('paused', paused);
    const verb = card.querySelector('.cp-verb'); if (verb) verb.textContent = presenceVerb();
    const tool = card.querySelector('.cp-tool');
    if (tool) {
      if (paused) {
        // e.g. "paused — waiting for you to approve fs.write"; a clarify question is an ANSWER, not a grant
        const t = pend.tool === 'brief.ask'
          ? 'paused — waiting for your answer to the question above'
          : 'paused — waiting for you to approve ' + shortName(pend.tool);
        if (tool.textContent !== t) tool.textContent = t;
        tool.classList.add('has'); tool.classList.add('paused-note');
      } else {
        tool.classList.remove('paused-note');
        const t = presenceCurTool ? shortName(presenceCurTool) : '';
        if (tool.textContent !== t) tool.textContent = t; tool.classList.toggle('has', !!t);
      }
    }
    const time = card.querySelector('.cp-time'); const txt = fmtElapsed(Channels.elapsedOf(activeWs.id, Date.now()));
    if (time && time.textContent !== txt) time.textContent = txt;
  }
  function startPresence(ws) {
    presenceCurTool = null;
    runRails = [];   // a fresh run folds only ITS OWN rails — never an earlier run's history
    /* A RUN, not a rail, is the lifetime of a pending tool call. endToolRail() used to clear this map,
       which conflated "stop adding chips to that rail" with "forget which calls are still awaiting a
       result" — see the note there. A new run is the honest place to drop stale pairings: its callIds
       are fresh, so nothing from the previous run can ever resolve into it. */
    pendingChips.clear();
    if (isActiveWs(ws)) { renderPresence(); ensureElapsedTimer(); }   // the elapsed tick also drives the presence update
  }
  function presenceToolCall(ws, name) { presenceCurTool = name || null; if (isActiveWs(ws)) renderPresence(); }
  function presenceToolResult(ws) { presenceCurTool = null; if (isActiveWs(ws)) renderPresence(); }
  // remove any live presence card without a summary (used when switching away / re-rendering a stream)
  function clearPresence() { const c = log && log.querySelector('#comms-presence'); if (c) { if (c.classList.contains('resolved')) c.removeAttribute('id'); else c.remove(); } presenceCurTool = null; }   // a resolved summary is history — keep it, only live cards are torn down
  function bindPresenceFold(card, fold) {
    if (!card || !fold) return;
    card.classList.add('has-fold');
    card.setAttribute('role', 'button'); card.tabIndex = 0; card.setAttribute('aria-expanded', 'false');
    if (card.dataset.foldBound === '1') return;
    card.dataset.foldBound = '1';
    const toggle = () => {
      const open = card.classList.toggle('open');
      fold.hidden = !open;
      card.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  }
  // resolve the live card into a compact one-line summary that STAYS in the transcript. opts: { error, raw,
  // stopped, endReason, steps, cost }. Truthful: steps/cost only appear when a real number is supplied.
  function resolvePresence(ws, opts) {
    foldBriefCards();   // the run is over → any "my read" contract for it can no longer steer; retire + fold it (before the early-out, so the registry can't hold a stale card)
    if (!isActiveWs(ws)) { clearPresence(); return; }
    opts = opts || {};
    const started = (typeof Channels !== 'undefined') ? Channels.startedAtOf(ws.id) : 0;
    const dur = started ? fmtElapsed(Channels.elapsedOf(ws.id, Date.now())) : '';   // machine time only — approval pauses excluded
    const card = log && log.querySelector('#comms-presence');
    if (!card) return;
    const presenceRunId = (typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : '';
    if (presenceRunId) card.dataset.runId = presenceRunId;
    card.classList.remove('cp-live');
    presenceCurTool = null;
    const isErr = !!opts.error, needsVerify = !!opts.verificationRequired, isStop = needsVerify || !!opts.stopped || (opts.endReason && opts.endReason !== 'done') || !!opts.cutShort;
    card.classList.add('resolved'); if (isErr) card.classList.add('err'); else if (isStop) card.classList.add('stopped');
    let label = isErr ? '■ RUN FAILED' : needsVerify ? '■ VERIFICATION REQUIRED' : opts.cutShort ? '■ CUT SHORT' : isStop ? '■ RUN STOPPED' : '■ RUN COMPLETE';
    const bits = [];
    if (dur) bits.push(dur);
    if (typeof opts.steps === 'number' && opts.steps > 0) bits.push(opts.steps + (opts.steps === 1 ? ' step' : ' steps'));
    if (typeof opts.cost === 'number' && opts.cost > 0) bits.push(U.usd(opts.cost));
    // TWO-TIER TRANSCRIPT: the run's tool rails FOLD under this resolved line so the machinery recedes
    // and the speech stays contiguous. The rails are MOVED, never deleted — the full work log is one
    // click away (truthful telemetry intact, just collapsed).
    const rails = runRails.filter(r => r && r.isConnected && r.childElementCount > 0);
    runRails = [];
    const tools = rails.reduce((n, r) => n + r.childElementCount, 0);
    if (tools > 0) bits.push(tools + (tools === 1 ? ' tool' : ' tools'));
    card.textContent = '';
    const sum = document.createElement('span'); sum.className = 'cp-sum';
    sum.textContent = label + (bits.length ? ' · ' + bits.join(' · ') : '');
    card.appendChild(sum);
    if (rails.length) {
      const chev = document.createElement('span'); chev.className = 'cp-chev'; chev.setAttribute('aria-hidden', 'true'); chev.textContent = '▸';
      card.appendChild(chev);
      const fold = document.createElement('div'); fold.className = 'run-fold'; fold.hidden = true;
      rails.forEach(r => fold.appendChild(r));
      card.parentNode.insertBefore(fold, card.nextSibling);
      bindPresenceFold(card, fold);
      // A FAILED run keeps its fold CLOSED like any other (2026-07-31). The old rule auto-expanded
      // every chip "for honesty" — but the failure's evidence is already IN the transcript (the ⚠ error
      // row, its raw .err-detail line, the diagnostics chip), and dumping the whole rail open painted a
      // wall of machinery that read as fifty failures when one thing failed. One click still shows it all.
    } else {
      card.setAttribute('role', 'note');
    }
    autoscroll();
  }
  // POST-RUN DEDUPE: when a recap card is about to render (it owns cost · duration · model + the artifact list),
  // strip the metrics from the already-resolved presence line above it so the two don't print the same numbers.
  // Keeps just the terse status label (the part before the first ' · '). No-op if there's no resolved card.
  function foldPresenceIntoRecap() {
    const card = log && log.querySelector('#comms-presence.resolved');
    if (!card) return;
    if (card.dataset.telemetry === '1') return;   // persisted hierarchy owns these non-duplicate lead/worker facts
    const tgt = card.querySelector('.cp-sum') || card;   // metrics live in the summary span (the fold chevron survives)
    const label = String(tgt.textContent || '').split(' · ')[0];
    if (label && tgt.textContent !== label) tgt.textContent = label;
  }

  // CRASH HONESTY (Theme 2) — after a run stream died on a network drop, poll /api/health until the sidecar is
  // PROVABLY back, then tell the Commander their interrupted run can't resume. Truthful telemetry: the
  // "connection restored" line renders ONLY after a real 200 from the respawned sidecar, never on hope. The
  // probe self-arms on the drop and self-clears once every interrupted stream has been reported.
  async function offerRecoveryReview(row, ws) {
    if (!row || !ws || !isActiveWs(ws) || Channels.isBusy(ws.id)
      || !Harness.resolveRunRecovery || !Harness.prepareReviewedRecovery) return;
    const continueResolved = async resolved => {
      if (!resolved || !resolved.canContinue) {
        toolLine('recovery remains paused — the outcome is still unknown. Check it directly, then start a new turn with what you found.', true);
        return;
      }
      try {
        const recovery = await Harness.prepareReviewedRecovery(resolved);
        if (!isActiveWs(ws) || Channels.isBusy(ws.id)) return;
        toolLine('outcome recorded — continuing without replaying the reviewed action.');
        await send(String(row.userTitle || 'Continue the interrupted task.'), { retry: true, recoveryResume: true, recovery });
      } catch (_) { toolLine('the recovery decision was saved, but continuation could not start yet. Reopen this session to retry safely.', true); }
    };
    if (row.canContinue) { await continueResolved(row); return; }
    const calls = Array.isArray(row.uncertain) ? row.uncertain.slice() : [];
    const outcomes = [];
    const ask = index => {
      if (!isActiveWs(ws) || index >= calls.length) return;
      const call = calls[index];
      toolLine('before the restart, did ' + String(call.name || 'this action') + ' actually happen? StarNet will not run it again while the answer is uncertain.', true);
      choices([
        { label: 'It happened', value: 'happened' },
        { label: 'It did not happen', value: 'did_not_happen' },
        { label: 'I am not sure', value: 'unknown', quiet: true }
      ], async picked => {
        outcomes.push({ callId: String(call.callId || ''), outcome: String((picked && picked.value) || 'unknown') });
        if (index + 1 < calls.length) { ask(index + 1); return; }
        try { await continueResolved(await Harness.resolveRunRecovery(row, outcomes)); }
        catch (_) { toolLine('the recovery answer could not be saved. No action was replayed; reopen this session and try again.', true); }
      });
    };
    if (calls.length) ask(0);
  }

  async function recoverSafeRun(ws, announce) {
    if (!ws || !ws.id || Channels.isBusy(ws.id) || typeof Harness === 'undefined'
      || !Harness.runRecoveries || !Harness.prepareAutomaticRecovery) return 'deferred';
    try {
      const r = await fetch('/api/task-briefs?key=' + encodeURIComponent('stream:' + ws.id) + '&limit=1', {cache:'no-store'});
      if (!r.ok) return 'unavailable';
      const j = await r.json(), brief = j && j.briefs && j.briefs[0];
      if (brief && brief.status === 'clarifying' && brief.questions.some(q => !q.answer)) return 'deferred';
    } catch (_) { return 'unavailable'; }
    let rows;
    try { rows = await Harness.runRecoveries(); } catch (_) { return 'unavailable'; }
    const owned = rows.filter(r => r && r.streamId === ws.id && r.agentId === (ws.agentId || 'agent'))
      .sort((a, b) => (+b.startedAt || 0) - (+a.startedAt || 0));
    const safe = owned.find(r => r.canAutoContinue && !recoveryClaims.has(r.runId));
    if (!safe) {
      const review = owned.find(r => r.operationalState === 'needs_review');
      if (review && announce && isActiveWs(ws) && !recoveryNotices.has(review.runId)) {
        recoveryNotices.add(review.runId);
        const names = (review.uncertain || []).map(x => x.name || 'action').join(', ');
        toolLine('recovery paused — ' + (names || 'an action') + ' may already have happened. StarNet will not repeat it; verify the outcome before continuing.', true);
        offerRecoveryReview(review, ws);
      }
      return review ? 'review' : 'none';
    }
    recoveryClaims.add(safe.runId);
    if (announce && isActiveWs(ws)) toolLine('connection restored — safely continuing from the last durable step.');
    let recovery;
    try { recovery = await Harness.prepareAutomaticRecovery(safe); }
    catch (_) { recoveryClaims.delete(safe.runId); return 'unavailable'; }
    // Preparation is durable and idempotent. If focus changed while it was in flight, leave it ready for the
    // next load instead of crossing conversations.
    if (!isActiveWs(ws) || Channels.isBusy(ws.id)) { recoveryClaims.delete(safe.runId); return 'deferred'; }
    await send(String(safe.userTitle || 'Continue the interrupted task.'), {
      retry: true, recoveryResume: true, recovery
    });
    return 'started';
  }

  async function probeReconnect() {
    if (!interruptedStreams.size) { reconnectTimer = 0; return; }
    let alive = false;
    try { const r = await fetch('/api/health', { cache: 'no-store' }); alive = !!(r && r.ok); } catch (_) { alive = false; }
    if (alive) {
      // report each interrupted stream once. Only the DISPLAYED stream draws a line (same rule as tool/error
      // lines); a background stream's flag is cleared quietly — its error row already recorded the failure.
      const wasActive = activeWs && interruptedStreams.has(activeWs.id);
      const active = wasActive ? activeWs : null;
      interruptedStreams.clear();
      reconnectTimer = 0;
      if (active) {
        const outcome = await recoverSafeRun(active, true);
        if (outcome === 'none' || outcome === 'unavailable') toolLine('connection restored — no safe automatic continuation was available; use Try again.', true);
      }
    } else {
      reconnectTimer = setTimeout(probeReconnect, 3000);   // still down — keep watching
    }
  }
  function armReconnectWatch() {
    if (reconnectTimer) return;
    // if the browser signals it's back online, probe immediately; otherwise poll on a slow cadence.
    reconnectTimer = setTimeout(probeReconnect, 2000);
    try { if (typeof window !== 'undefined' && !window.__runtruthOnlineHook) { window.__runtruthOnlineHook = true; window.addEventListener('online', () => { if (interruptedStreams.size && !reconnectTimer) probeReconnect(); }); } } catch (_) {}
  }

  // RETIRE A SETTLED BEAT: a decided memory card / answered nudge fades + collapses, then drops out of the
  // DOM so the feed never accumulates dead cards (the "discarded cards don't disappear" bug). Pure view —
  // the decision was already committed by the caller. onGone fires once, after removal. Resilient: a missed
  // transitionend can't leave a ghost (fallback timer), and a double-call is a no-op.
  function vanish(node, onGone) {
    if (!node) { if (onGone) onGone(); return; }
    if (node.__vanishing) return;
    node.__vanishing = true;
    node.style.maxHeight = node.scrollHeight + 'px';                 // pin current height so the collapse can animate from it
    requestAnimationFrame(() => { node.classList.add('beat-vanish'); node.style.maxHeight = '0px'; });
    let done = false;
    const finish = () => { if (done) return; done = true; if (node.parentNode) node.remove(); if (onGone) onGone(); };
    node.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 460);   // fallback: a dropped transitionend (engine quirk / not displayed) still clears the card
  }

  const KIND_TAG = { profile: 'PREFERENCE', fact: 'FACT', skill: 'SKILL', note: 'NOTE' };

  // COMMS GLYPHS — small currentColor SVGs that replace color emoji (📁/📄/🖼/📋) so they inherit the phosphor
  // theme instead of puncturing the CRT look with an OS-coloured emoji. Static developer markup (no model/user
  // text) → assigning via innerHTML on a fresh element is XSS-safe. Sized in em so they ride the text they sit in.
  const SVG_FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 3.6h4l1.2 1.5h7.6v7.8H1.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const SVG_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.6h5l3 3v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.6v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const SVG_IMAGE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.7" cy="6.3" r="1" fill="currentColor"/><path d="M2.8 12l3.6-3.6 2.3 2.3L11 8.6l2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const SVG_CLIP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 8.2 8.5 4.3a2.2 2.2 0 0 1 3.1 3.1l-4.8 4.8a3.4 3.4 0 0 1-4.8-4.8l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // build a span carrying one of the static SVGs above (a leading COMMS glyph before a text label)
  function glyphSpan(svg, cls) { const s = document.createElement('span'); s.className = 'comms-glyph' + (cls ? ' ' + cls : ''); s.setAttribute('aria-hidden', 'true'); s.innerHTML = svg; return s; }

  // COMMS-PREMIUM — a subtle HH:MM stamp for a transmission-card header. The stored history carries no
  // per-message time, so replayed history gets NO stamp (never fabricate one); only rows created live at
  // render time get a real wall-clock stamp. Pure presentation, dim + right-aligned in the header row.
  function fmtClock(d) {
    d = d || new Date();
    const h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // LINKIFY (XSS-safe): model output is untrusted, so we NEVER assign raw model text to innerHTML. Instead we
  // HTML-escape the WHOLE string first, then wrap only matched http(s) URL substrings in anchors. Escaping before
  // matching means the resulting markup can contain nothing the model authored as live HTML — only our own <a>
  // tags around escaped text. Used identically for live-streamed tokens, the final reply, and replayed history.
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => HTML_ESC[c]); }
  function linkify(text) {
    const s = String(text == null ? '' : text);
    const re = /https?:\/\/[^\s<>"']+/g;   // a run of non-space, non-markup chars after the scheme
    let out = '', last = 0, m;
    while ((m = re.exec(s)) !== null) {
      let url = m[0];
      const trail = /[.,;:!?'")\]}>*`]+$/.exec(url); // don't swallow sentence punctuation OR markdown markers (**url**, `url`) trailing the URL
      if (trail) url = url.slice(0, url.length - trail[0].length);
      if (!url) continue;                            // pathological match (scheme only) — let escape handle it
      out += escapeHtml(s.slice(last, m.index));     // escaped text before the URL
      const safe = escapeHtml(url);                  // escape the URL too (its href + visible text are both safe)
      out += '<a href="' + safe + '" target="_blank" rel="noopener">' + safe + '</a>';
      last = m.index + url.length;                   // trailing punctuation (if trimmed) re-enters as escaped text
    }
    out += escapeHtml(s.slice(last));
    return out;
  }
  /* MINIMAL TERMINAL-MARKDOWN (XSS-SAFE) — model prose often carries light markdown (**bold**, `code`, fenced
     blocks, - lists, # headers). We render a SMALL subset as phosphor spans, NEVER as heavy web type. The XSS
     invariant is inviolate: every model substring is HTML-ESCAPED first (escapeHtml / linkify both escape), and
     we only ever wrap ALREADY-ESCAPED text in our OWN tags — model output never reaches innerHTML raw. `code`
     spans are pulled to placeholders before the bold pass so a ** inside code stays literal. */
  const MD_MARKERS = /\||^\s*>|^\s*\d+[.)]\s|\*\*|`|^#{1,6}\s|^[ \t]*[-*]\s/m;   // cheap gate: does this text carry any markdown we render?
  function mdInline(safe) {
    // `safe` is escaped-and-linkified HTML. Pull `inline code` to placeholders, bold the rest, restore code.
    const codes = [];
    let s = safe.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '' + (codes.length - 1) + ''; });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<span class="md-b">$1</span>');
    s = s.replace(/(\d+)/g, (m, i) => '<code class="md-code">' + codes[+i] + '</code>');
    return s;
  }
  function renderFence(lines) {
    return '<span class="md-pre-wrap">' +
      '<button class="md-copy" type="button" data-copy-label="Copy code block" data-tip="copy code" aria-label="Copy code block">⧉</button>' +
      '<span class="md-pre">' + escapeHtml(lines.join('\n')) + '</span>' +
      '</span>';
  }
  function reportInline(raw) {
    // Tokenize raw text before escaping; generated markup never enters another pass.
    const re = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s<>"']+)\)|\*\*([^*\n]+)\*\*|https?:\/\/[^\s<>"']+/g;
    let out='',last=0,m;
    while((m=re.exec(raw))) {
      out+=escapeHtml(raw.slice(last,m.index));
      if(m[1]!==undefined)out+='<code class="md-code">'+escapeHtml(m[1])+'</code>';
      else if(m[2]!==undefined)out+='<a href="'+escapeHtml(m[3])+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(m[2])+'</a>';
      else if(m[4]!==undefined)out+='<span class="md-b">'+escapeHtml(m[4])+'</span>';
      else out+=linkify(m[0]);
      last=re.lastIndex;
    }
    return out+escapeHtml(raw.slice(last));
  }
  function renderMarkdown(raw) {
    const lines=String(raw).split('\n');
    const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim().replace(/\\\|/g,'|'));
    const listMatch=line=>/^([ \t]*)([-*+] |\d+[.)] )(.*)$/.exec(line);
    function blocks(from,to,depth) {
      const parts=[];let i=from;
      while(i<to) {
        const ln=lines[i];
        if(/^[ \t]*```/.test(ln)) {
          const code=[];i++;
          while(i<to && !/^[ \t]*```/.test(lines[i]))code.push(lines[i++]);
          if(i<to)i++;parts.push(renderFence(code));continue;
        }
        const h=/^(#{1,6})\s+(.*)$/.exec(ln);
        if(h){parts.push('<span class="md-h" role="heading" aria-level="'+h[1].length+'">'+reportInline(h[2])+'</span>');i++;continue;}
        if(/^\s*>/.test(ln)) {
          const quote=[];
          while(i<to && /^\s*>/.test(lines[i]))quote.push(reportInline(lines[i++].replace(/^\s*> ?/,'')));
          parts.push('<blockquote class="md-quote">'+quote.join('<br>')+'</blockquote>');continue;
        }
        if(i+1<to && ln.includes('|') && cells(lines[i+1]).length>1 && cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))) {
          const headers=cells(ln);i+=2;
          let table='<div class="md-table-scroll" tabindex="0" role="region" aria-label="Report table"><table class="md-table"><thead><tr>'+headers.map(c=>'<th scope="col">'+reportInline(c)+'</th>').join('')+'</tr></thead><tbody>';
          while(i<to && lines[i].includes('|') && lines[i].trim())table+='<tr>'+cells(lines[i++]).map(c=>'<td>'+reportInline(c)+'</td>').join('')+'</tr>';
          parts.push(table+'</tbody></table></div>');continue;
        }
        const first=listMatch(ln);
        if(first && depth<16) {
          const indent=first[1].replace(/\t/g,'    ').length;
          const ordered=/\d/.test(first[2]),tag=ordered?'ol':'ul';
          let list='<'+tag+' class="md-list"'+(ordered?' start="'+parseInt(first[2],10)+'"':'')+'>';
          while(i<to) {
            const item=listMatch(lines[i]);
            if(!item || item[1].replace(/\t/g,'    ').length!==indent || /\d/.test(item[2])!==ordered)break;
            list+='<li>'+reportInline(item[3]);i++;
            const begin=i;
            while(i<to && lines[i].trim() && /^\s/.test(lines[i]) && (lines[i].match(/^\s*/)[0].replace(/\t/g,'    ').length>indent))i++;
            if(i>begin)list+=blocks(begin,i,depth+1);
            list+='</li>';
          }
          parts.push(list+'</'+tag+'>');continue;
        }
        parts.push(reportInline(ln));i++;
      }
      return parts.join('\n');
    }
    return blocks(0,lines.length,0);
  }
  // render agent prose into a body span. Fast textContent path when there's no URL AND no markdown marker (the
  // common streamed token) — no per-token HTML reparse; otherwise the escaped+linkified+markdown pipeline.
  function renderProse(bodyEl, raw) {
    if (!bodyEl) return;
    raw = String(raw == null ? '' : raw);
    bodyEl.__proseSource = raw;
    if (raw.indexOf('http') === -1 && !MD_MARKERS.test(raw)) { bodyEl.textContent = raw; return; }
    bodyEl.innerHTML = renderMarkdown(raw);
  }

  function messageCopyText(bodyEl) {
    if (!bodyEl) return '';
    return typeof bodyEl.__proseSource === 'string' ? bodyEl.__proseSource : bodyEl.textContent;
  }

  // COPY-TO-CLIPBOARD: the async Clipboard API (works on localhost, a secure context), with a hidden-textarea
  // execCommand fallback for any context where it's unavailable. Resolves true on success so the button can confirm.
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    } catch (_) {}
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea'); ta.value = text;
      ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }
  function showCopyResult(btn, ok) {
    if (!btn) return;
    const idleLabel = btn.getAttribute('data-copy-label') || 'Copy';
    if (btn.__copyResultTimer) clearTimeout(btn.__copyResultTimer);
    btn.classList.toggle('copied', !!ok);
    btn.classList.toggle('copy-failed', !ok);
    btn.textContent = ok ? '✓' : '!';
    btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed');
    btn.setAttribute('data-tip', ok ? 'copied' : 'copy failed — select manually');
    btn.__copyResultTimer = setTimeout(() => {
      btn.classList.remove('copied', 'copy-failed'); btn.textContent = '⧉';
      btn.setAttribute('aria-label', idleLabel);
      btn.setAttribute('data-tip', idleLabel === 'Copy code block' ? 'copy code' : 'copy message');
      btn.__copyResultTimer = null;
    }, 1100);
  }

  // INPUT HISTORY — terminal-style recall of what the Commander already sent this session. ArrowUp in an
  // EMPTY composer (or while already recalling) walks back; ArrowDown walks forward and lands back on the
  // in-progress draft. Typing anything exits recall mode (the 'input' listener resets histIdx), so a
  // multiline draft is never hijacked mid-edit. Session-scoped, never persisted.
  const sentHistory = []; let histIdx = -1, histDraft = '';
  const HIST_CAP = 100;
  function recordSent(t) { if (!t) return; if (sentHistory[sentHistory.length - 1] !== t) { sentHistory.push(t); if (sentHistory.length > HIST_CAP) sentHistory.shift(); } histIdx = -1; histDraft = ''; }
  function recallInto(v) { input.value = v; autoGrowInput(); try { input.setSelectionRange(v.length, v.length); } catch (_) {} }

  function init(opts) {
    focusVersion++;   // reinitialization cannot revive a focus request from the previous UI lifetime
    system = opts.system || ''; name = opts.name || 'AGENT';
    sentHistory.length = 0; histIdx = -1; histDraft = '';   // recall never crosses a session/agent switch
    onTurn = opts.onTurn || null; interview = null;
    receiptRunsSeen.clear(); clearChoices(); turninQueue.length = 0; activeTurnin = null; wiQDepth.clear(); queued.clear(); interrupted.clear();   // C2: per-session run-tracking + the queue gauge + turn-control state start clean for each agent (listeners stay once-registered)
    // GROWTH Tier 1: the study side starts clean per session too — a prior hero's deferred study/taste beats must
    // never flush into a new session (same law as turninQueue above). A fresh beat-slot arbiter matches the DOM.
    arcRunsSeen.clear();   // GROWTH Tier 2: the arc side starts clean per session (a prior hero's arc offers never carry over)
    reconfirmDeferred.clear();   // quality loop Q3: a deferred "still true?" is per-session like every sibling above — an agent switch starts clean
    clearNudge();
    if (beatCards) beatCards.reset();
    beatCards = (typeof BeatCard !== 'undefined' && BeatCard.create) ? BeatCard.create({ vanish: vanish }) : null;
    beatSlot = beatCards ? beatCards.slot : null;
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    if (typeof window !== 'undefined' && !window.__chatStarterTimer && typeof StarterStore !== 'undefined') {
      StarterStore.init();
      window.__chatStarterTimer = setInterval(() => { try { refreshStarters(); } catch (_) {} }, 15000);
    }
    // F2: re-derive the idle status on the same cadence the topbar repaints #sig (3s) so a link that dies with
    // NO run in flight still downgrades 'online' → 'station unreachable'. Once-armed (init re-runs per session).
    if (typeof window !== 'undefined' && !window.__chatLinkStatusTimer) {
      window.__chatLinkStatusTimer = setInterval(() => { try { if (!isBusy()) syncStatus(); } catch (_) {} }, 3000);
    }
    attachInput = el('chat-attach-input'); attachStrip = el('chat-attach-strip');
    clearAttachments();   // a fresh agent session starts with no staged attachments (matches the clean-slate init above)
    if (log) {
      log.addEventListener('scroll', () => {
        if (historyPinPending) return;   // row()-driven replay scroll events cannot cancel the load's final pin
        stick = nearBottom(); if (stick) hideNewPill(); else showNewPill(false);
      });   // at the bottom → retire the pill; scrolled up → a persistent "↓ latest" affordance
      // A real attempt to inspect history wins even during the two-frame settle window.
      ['wheel', 'touchstart', 'pointerdown'].forEach(type => log.addEventListener(type, cancelHistoryPin, { passive: true }));
    }
    // COPY: one delegated click handler for every (current + future) message row's ⧉ button — copies the
    // row's prose, then flashes a ✓ confirm. Wired once per log element so a re-init can't stack handlers.
    if (log && !log.__copyWired) {
      log.__copyWired = true;
      log.addEventListener('click', e => {
        // SELECTION GUARD: the transcript is selectable text — a mouse-up that ENDS a drag-selection must
        // never also fire a click action (chip toggle), or selecting inside a chip snaps it shut.
        const selecting = !!(window.getSelection && String(window.getSelection()));
        // LINKS (desktop): a linkified <a target=_blank> is silently dead under the Tauri window policy
        // (same law as openSignIn / the workshop Open-it action) — hand real http(s) hrefs to the OS
        // browser. In a plain browser the default target=_blank behavior stands.
        const link = e.target.closest('a');
        if (link && /^https?:\/\//i.test(link.getAttribute('href') || '')) {
          if (selecting) { e.preventDefault(); return; }
          const invoke = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core.invoke : null;
          if (invoke) {
            e.preventDefault();
            invoke('open_external_url', { url: link.href }).catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open your browser for that link', 'warn'); });
          }
          return;
        }
        // TOOL CHIP: clicking a chip's head toggles its expanded detail (checked before the copy button)
        const chipHead = e.target.closest('.tc-head');
        if (chipHead) { if (selecting) return; toggleChip(chipHead); if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); return; }
        // FENCED CODE: each block owns a copy control. Resolve the text from that exact wrapper so one click
        // never sweeps up the surrounding prose or a neighboring block in the same response.
        const codeBtn = e.target.closest('.md-copy');
        if (codeBtn) {
          const wrap = codeBtn.closest('.md-pre-wrap');
          const codeEl = wrap && wrap.querySelector('.md-pre');
          if (!codeEl) return;
          copyText(codeEl.textContent || '').then(ok => {
            showCopyResult(codeBtn, ok);
            if (ok && typeof SFX !== 'undefined' && SFX.click) SFX.click();
          });
          return;
        }
        const btn = e.target.closest('.cmsg-copy'); if (!btn) return;
        const bodyEl = btn.closest('.cmsg') && btn.closest('.cmsg').querySelector('.body');
        const txt = messageCopyText(bodyEl);
        if (!txt) return;
        copyText(txt).then(ok => {
          showCopyResult(btn, ok);
          if (ok && typeof SFX !== 'undefined' && SFX.click) SFX.click();
        });
      });
    }
    input.value = '';
    autoGrowInput();   // COMPOSER: settle the textarea at its resting one-line height
    warmSlashCatalog();
    wireProposals();   // Cortex turn-in beat: listen for reflection's memory.proposed (registers once)
    wireStudy();       // GROWTH Tier 1: after a salient run, offer ≤1 dossier belief-update at turn-in priority (registers once)
    wireBriefRead();   // TASTE EXTRACTION: the announce-and-act READ card (taskbrief.settled → correctable assumptions; registers once)
    wireTrust();       // GROWTH Tier 3: after a clean run, offer ONE earned-autonomy raise at the LOWEST beat priority — below the arc (registers once)
    wireThreads();     // NS-6: after a mined task run, offer ONE thread turn-in (Keep/Edit/Discard) at the lowest beat priority — study wins the moment first (registers once)
    wireCrewCapture(); // P3.2: record each dispatched worker's forwarded run-end spend so a 👍 on a crew run splits XP honestly (registers once)
    wireCuriosity();   // Commander Dossier: one gentle "tell me about X" nudge after a clean run (registers once)
    wireConnectorRequired();   // beginner seam Lane 1: a run that hit an unwired connector earns the ⇄ CONNECT chip
    wireBgExit();      // E6: surface shell.bg.exit (a background dev-server/watcher ended) as a terse COMMS system line — was a zero-listener event (registers once)
    wireSkillAside();  // A2: after a background review distills a skill, ONE quiet "distilled this run…" aside (registers once)
    wireIdBar();       // COMMS agent selector: a change switches to (or mints) a workstream bound to that agent (registers once)
    load(opts.ws);
    input.onkeydown = e => {
      // SLASH PALETTE owns the nav keys while open (a "/command" menu over the input)
      if (isSlashOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1); return; }
        // TAB completes an argument VALUE when the palette is offering values; otherwise it runs the
        // highlighted command exactly as before.
        if (e.key === 'Tab' && slashValueMode) { e.preventDefault(); completeSlashValue(slashItems[slashSel]); return; }
        // ENTER ALWAYS DISPATCHES THE COMMAND — never a value. In value mode the highlighted row is an
        // argument, not something runnable, so resolve the command off the typed line instead. Keeping Enter
        // on this contract is what stops "/personality direct" being fired at the model as chat (2026-07-05).
        if (e.key === 'Enter' && slashValueMode) {
          e.preventDefault();
          const cmd = commandFromLine(input.value);
          closeSlash();
          if (cmd) runSlash(cmd); else submitComposer();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slashItems[slashSel]); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
        // any other key falls through to normal typing → the 'input' listener re-filters the palette
      }
      // INPUT HISTORY — recall starts only from an EMPTY box (a draft in progress is never hijacked);
      // once recalling, ArrowUp/ArrowDown walk the sent list, ArrowDown past the newest restores the draft.
      if (e.key === 'ArrowUp' && sentHistory.length && (histIdx >= 0 || input.value === '')) {
        e.preventDefault();
        if (histIdx < 0) { histDraft = input.value; histIdx = sentHistory.length; }
        if (histIdx > 0) { histIdx--; recallInto(sentHistory[histIdx]); }
        return;
      }
      if (e.key === 'ArrowDown' && histIdx >= 0) {
        e.preventDefault();
        histIdx++;
        if (histIdx >= sentHistory.length) { histIdx = -1; recallInto(histDraft); histDraft = ''; }
        else recallInto(sentHistory[histIdx]);
        return;
      }
      if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {   // Shift+Enter falls through → newline in the textarea
        e.preventDefault();
        submitComposer();
      } else if (e.key === 'Escape' && isBusy()) {
        e.preventDefault(); e.stopPropagation();   // INTERRUPT: beat navdock's global Esc-closes-menus while a run is live
        stopActive();
      }
    };
    // SLASH PALETTE: a leading "/" opens the command menu and filters it live as you type past it.
    // Once-guarded like every other wiring in this block: Chat.init re-runs per session entry
    // (DISCONNECT -> resume), and #chat-input is a persistent node — an unguarded addEventListener
    // stacked one more handler per re-entry.
    if (!input.__inputWired) {
      input.__inputWired = true;
      input.addEventListener('input', () => { autoGrowInput(); warmChat(); histIdx = -1; const v = input.value; if (v[0] === '/') openSlash(v.slice(1)); else closeSlash(); });   // real typing exits history-recall mode
    }
    const stopBtn = el('chat-stop'); if (stopBtn) stopBtn.onclick = stopActive;
    const sendBtn = el('chat-send'); if (sendBtn) sendBtn.onclick = () => { submitComposer(); input.focus(); };   // SEND chip: same path as Enter, keep the caret
    wireComposerAttachments();   // ATTACHMENTS: paperclip · paste · drag-drop -> stage files in the composer
  }

  // THE ONE SEND PATH — shared by Enter and the SEND chip. Handles: attachment-only sends, session history recall,
  // typo'd/unknown slash commands (a LOCAL system line, never a paid model turn), type-ahead queueing while busy,
  // and settling in-flight uploads so a staged file is never silently dropped.
  async function submitComposer() {
    const submissionWs = activeWs, submissionFocusVersion = focusVersion;
    const t = input.value.trim();
    const hasStaged = pendingAtts.length > 0;   // ANY staged file (uploading or ready) makes this a valid send
    if (!t && !hasStaged) return;
    // SLASH: a "/name …" line dispatches as a command, never chat. A recognised command runs; an UNKNOWN one
    // (a typo like "/hlep") gets a local "unknown command" line — NOT sent to the agent as a paid model turn.
    // Gate on a command-SHAPED first token (letters/digits/hyphen) so a real message that starts with a path
    // ("/etc/hosts is broken") still goes to the agent instead of tripping the unknown-command line.
    if (t && /^\/[a-z][\w-]*(?:\s|$)/i.test(t)) {
      recordSent(t);   // history records commands too, like a shell
      const cmd = commandFromLine(t);
      closeSlash();
      if (cmd) { runSlash(cmd); return; }
      input.value = ''; autoGrowInput();
      const nm = (t.match(/^\/(\S+)/) || ['', ''])[1];
      localLine('Unknown command: /' + nm + '. Type "/" to browse commands, or /help.');
      return;
    }
    // LARGE-PASTE CONTEXT GUARD: the 100K composer ceiling is a transport allowance, not a promise that every
    // model has room for 100K characters plus StarNet's system/tool context. When the live catalog or an honest
    // per-conversation projection proves the selected model is too small, keep the paste byte-for-byte in the
    // composer and explain the remedy instead of clearing it into a provider context-overflow failure.
    const contextIssue = t ? composerContextIssue(activeWs, t) : null;
    if (contextIssue) {
      const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : 'this model';
      const limit = (typeof U !== 'undefined' && U.tokens) ? U.tokens(contextIssue.limit) : contextIssue.limit;
      const note = 'Paste kept — it may exceed ' + model + '\'s ' + limit + '-token context once StarNet\'s working context is included. Choose a larger-context model or split the text; nothing was sent.';
      localLine(note);
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('paste kept — selected model context is too small', 'warn');
      return;
    }
    if (t) recordSent(t);
    if (activeWs?.conversationMode === 'group' && typeof GroupChat !== 'undefined') {
      const ws = activeWs;
      if (hasStaged) await settleAttachments();
      if (activeWs?.id !== ws.id || focusVersion !== submissionFocusVersion) return;
      const atts = pendingAtts.filter(entry => entry.status === 'ready' && entry.ref).map(entry => entry.ref);
      const sent = await GroupChat.sendText(t, { attachments: atts, attachmentAgent: ws.agentId });
      if (sent && activeWs?.id === ws.id) { takeAttachments(); if (input.value.trim() === t) input.value = ''; closeSlash(); autoGrowInput(); }
      return;
    }
    // BUSY: type-ahead queues TEXT; staged files wait in the strip for the next idle send (one run per stream).
    if (isBusy()) { if (t) { input.value = ''; closeSlash(); autoGrowInput(); enqueue(t); } return; }
    // SETTLE UPLOADS: a staged attachment still uploading must not be silently dropped — uploads to the local
    // sidecar are near-instant, so we AWAIT them before snapshotting. A failed one already notified per-file.
    if (hasStaged) await settleAttachments();
    if (activeWs !== submissionWs || focusVersion !== submissionFocusVersion) return;
    const atts = takeAttachments();   // snapshot the READY refs + clear the composer strip
    if (!t && !atts.length) return;   // everything failed to upload and there's no text → nothing to send
    input.value = ''; closeSlash(); autoGrowInput();   // COMPOSER: collapse back to one line after a send
    send(t, { attachments: atts });
  }

  /* ── ATTACHMENTS ────────────────────────────────────────────────────────────────────────────────────
     Photos/files the Commander attaches to a message (like Claude Code / Codex). Three ways in: the 📎
     button (file picker), paste from the clipboard, and drag-drop onto the composer. Each file is uploaded
     to the sidecar (POST /api/attachments -> saved in the agent's workspace, jailed) and staged as a chip;
     on send, the READY refs ride the user turn as lightweight { id,name,path,mediaType,kind } records (never
     base64 — localStorage stays tiny), and the sidecar re-expands them into image/text content at run time. */
  const ATTACH_IMG_EXT = { png:1, jpg:1, jpeg:1, gif:1, webp:1 };   // types the model can actually SEE as images
  const ATTACH_MAX_FILE_BYTES = 8 * 1024 * 1024;
  function attachAgentId() { return (activeWs && activeWs.agentId) || 'agent'; }
  function fileKind(file) {
    const ext = String(file && file.name || '').split('.').pop().toLowerCase();
    if (ATTACH_IMG_EXT[ext] || /^image\/(png|jpeg|gif|webp)$/.test(String(file && file.type || ''))) return 'image';
    return 'file';
  }
  function wireComposerAttachments() {
    const btn = el('chat-attach');
    if (btn) btn.onclick = () => { if (attachInput) attachInput.click(); };   // property assignments are idempotent — safe to re-run
    if (attachInput) attachInput.onchange = () => { handleFiles(attachInput.files); attachInput.value = ''; };
    // The addEventListener wiring below targets PERSISTENT nodes (#chat-input, #chat-inputrow) and
    // Chat.init re-runs per session entry: unguarded, every DISCONNECT/resume cycle stacked another
    // paste + drop handler, so one pasted screenshot staged (and uploaded, and billed) N times.
    if (input.__attachWired) return;
    input.__attachWired = true;
    // PASTE: a screenshot or copied file pasted into the message box becomes an attachment (text still types normally)
    input.addEventListener('paste', ev => {
      const items = ev.clipboardData && ev.clipboardData.files;
      if (items && items.length) { ev.preventDefault(); handleFiles(items); }
    });
    // DRAG-DROP onto the whole composer. preventDefault on dragover is what enables the drop.
    const row = el('chat-inputrow');
    if (row) {
      const show = e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; row.classList.add('attach-dragover'); };
      row.addEventListener('dragenter', show);
      row.addEventListener('dragover', show);
      row.addEventListener('dragleave', e => { if (e.target === row) row.classList.remove('attach-dragover'); });
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('attach-dragover'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    }
  }
  const ATTACH_VIDEO_EXT = { mp4: 1, mov: 1, webm: 1, m4v: 1, mkv: 1, avi: 1, ogv: 1 };
  function isVideoFile(f) {
    if (/^video\//.test(String(f && f.type || ''))) return true;
    return !!ATTACH_VIDEO_EXT[String(f && f.name || '').split('.').pop().toLowerCase()];
  }
  // VIDEO SIGHT: the model can't watch a video, but it CAN see stills. Decode the clip right here in the
  // browser (a <video> + canvas — no server dependency, no extra key) and pull a few spread-out frames as
  // JPEG images that ride along as ordinary image attachments. Resolves [] on any decode failure (codec the
  // browser can't play, corrupt file) — the video file itself still attaches, nothing breaks.
  function extractVideoFrames(file, frameCount) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      const done = frames => { try { URL.revokeObjectURL(url); } catch (_) {} v.removeAttribute('src'); resolve(frames); };
      const bail = () => done([]);
      const timer = setTimeout(bail, 15000);   // a codec the browser can't decode must not hang the composer
      v.muted = true; v.preload = 'auto'; v.src = url;
      v.onerror = () => { clearTimeout(timer); bail(); };
      v.onloadedmetadata = async () => {
        try {
          let dur = Number(v.duration);
          // Chrome reports duration=Infinity for streamed/recorded webm (no duration header). The standard fix:
          // seek far past the end, wait for the clamp, and read the REAL duration back.
          if (!isFinite(dur)) {
            await new Promise((res) => { const t2 = setTimeout(res, 3000); v.onseeked = () => { clearTimeout(t2); res(); }; v.currentTime = 1e9; });
            dur = Number(v.duration);
          }
          if (!isFinite(dur) || dur <= 0 || !v.videoWidth || !v.videoHeight) { clearTimeout(timer); return bail(); }
          const n = Math.max(1, Math.min(frameCount || 3, 4));
          // spread through the clip, skipping the very edges (black lead-ins / end cards)
          const times = n === 1 ? [dur / 2] : Array.from({ length: n }, (_, i) => dur * (0.1 + 0.8 * i / (n - 1)));
          const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));   // cap frame size; vision needs no 4K
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(v.videoWidth * scale));
          c.height = Math.max(1, Math.round(v.videoHeight * scale));
          const ctx = c.getContext('2d');
          const base = String(file.name || 'video').replace(/\.[a-z0-9]+$/i, '');
          const frames = [];
          for (let i = 0; i < times.length; i++) {
            await new Promise((res, rej) => { v.onseeked = res; v.onerror = rej; v.currentTime = times[i]; });
            ctx.drawImage(v, 0, 0, c.width, c.height);
            const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
            if (blob && blob.size) frames.push(new File([blob], base + '-frame-' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
          }
          clearTimeout(timer); done(frames);
        } catch (_) { clearTimeout(timer); bail(); }
      };
    });
  }
  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (!f) continue;
      const oversized = f.size > ATTACH_MAX_FILE_BYTES;
      if (oversized && !isVideoFile(f)) { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('“' + f.name + '” is too large to attach (max 8MB)', 'warn'); continue; }
      if (!oversized) stageFile(f);
      if (isVideoFile(f)) {
        // even an over-limit video still contributes SIGHT: its frames are small JPEGs and attach fine
        if (oversized && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('“' + f.name + '” is over 8MB — attaching still frames only', 'warn');
        extractVideoFrames(f, 3).then(frames => {
          if (!frames.length && oversized && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not decode “' + f.name + '” for frames', 'warn');
          for (const fr of frames) stageFile(fr);
          if (frames.length) renderAttachStrip();
        });
      }
    }
    renderAttachStrip();
  }
  // stage one file: show a chip immediately (local thumbnail for images), then upload it in the background.
  // The upload promise is kept on the entry (entry.p) so a send can AWAIT an in-flight upload instead of dropping it.
  function stageFile(file) {
    const kind = fileKind(file);
    const entry = { name: file.name || 'file', kind, localUrl: (kind === 'image') ? URL.createObjectURL(file) : '', status: 'uploading', ref: null, p: null };
    pendingAtts.push(entry);
    entry.p = uploadAttachment(file).then(ref => {
      entry.status = 'ready'; entry.ref = ref;
    }).catch(() => {
      entry.status = 'error';
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not attach “' + entry.name + '”', 'warn');
    }).then(() => renderAttachStrip());
  }
  // wait for every still-uploading staged file to settle (resolve or fail) so a send never silently drops one
  // that was mid-flight. Local-sidecar uploads are near-instant; this is a very short await in practice.
  async function settleAttachments() {
    const inflight = pendingAtts.filter(e => e && e.status === 'uploading' && e.p).map(e => e.p);
    if (inflight.length) { try { await Promise.allSettled(inflight); } catch (_) {} }
  }
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(file);
    });
  }
  async function uploadAttachment(file) {
    const dataUrl = await readAsDataUrl(file);
    const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers['X-StarNet-Token'] = tok;
    const res = await fetch('/api/attachments', { method: 'POST', headers, body: JSON.stringify({ agent: attachAgentId(), name: file.name || 'file', dataUrl }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || ('upload HTTP ' + res.status));
    return { id: j.id, name: j.name, path: j.path, mediaType: j.mediaType, kind: j.kind };
  }
  // render the composer preview strip from pendingAtts (thumbnails for images, a glyph + name for files).
  function renderAttachStrip() {
    if (!attachStrip) return;
    attachStrip.textContent = '';
    if (!pendingAtts.length) { attachStrip.hidden = true; return; }
    attachStrip.hidden = false;
    pendingAtts.forEach((entry, i) => {
      const chip = document.createElement('span');
      chip.className = 'chat-attach-chip' + (entry.status === 'uploading' ? ' uploading' : '') + (entry.status === 'error' ? ' err' : '');
      if (entry.kind === 'image' && entry.localUrl) {
        const img = document.createElement('img'); img.className = 'thumb'; img.src = entry.localUrl; img.alt = entry.name;
        img.title = 'click to enlarge';
        // enlarge the STAGED image before sending it — the strip still owns entry.localUrl, so no revoke here
        img.addEventListener('click', () => openLightbox(() => entry.localUrl, entry.name, { revoke: false }));
        chip.appendChild(img);
      } else {
        const g = document.createElement('span'); g.className = 'glyph'; g.setAttribute('aria-hidden', 'true');
        g.innerHTML = entry.kind === 'image' ? SVG_IMAGE : SVG_FILE;   // themed glyph, not a color emoji
        chip.appendChild(g);
      }
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = entry.name; nm.title = entry.name;
      chip.appendChild(nm);
      const rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '×';
      rm.title = 'remove'; rm.setAttribute('aria-label', 'Remove ' + entry.name);
      rm.onclick = () => removePending(i);
      chip.appendChild(rm);
      attachStrip.appendChild(chip);
    });
  }
  function removePending(i) {
    const entry = pendingAtts[i];
    if (!entry) return;
    if (entry.localUrl) { try { URL.revokeObjectURL(entry.localUrl); } catch (_) {} }
    // best-effort: prune the uploaded bytes so an attach-then-remove doesn't orphan a file in the workspace
    if (entry.ref && entry.ref.path) {
      const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
      const headers = { 'Content-Type': 'application/json' }; if (tok) headers['X-StarNet-Token'] = tok;
      fetch('/api/attachments', { method: 'POST', headers, body: JSON.stringify({ op: 'delete', agent: attachAgentId(), path: entry.ref.path }) }).catch(() => {});
    }
    pendingAtts.splice(i, 1);
    renderAttachStrip();
  }
  // snapshot the READY refs for a send, then clear the strip. (submitComposer awaits settleAttachments first, so
  // an upload that was in flight is settled — not dropped — before this snapshot runs.)
  function takeAttachments() {
    const ready = pendingAtts.filter(e => e.status === 'ready' && e.ref).map(e => e.ref);
    clearAttachments();
    return ready;
  }
  function hasStagedAttachments() { return pendingAtts.some(e => e.status === 'ready' && e.ref); }
  function clearAttachments() {
    for (const e of pendingAtts) { if (e.localUrl) { try { URL.revokeObjectURL(e.localUrl); } catch (_) {} } }
    pendingAtts = [];
    renderAttachStrip();
  }

  // COMPOSER auto-grow: the message field is a <textarea>, so keep its rendered height matched to its
  // content — one line at rest, growing with the message up to comms.css's max-height, then it scrolls.
  // This is what lets the Commander SEE a whole long message being typed at any COMMS width (the old
  // single-line <input> could only ever show a sliver). Called on every edit (typed, dictated, or
  // programmatically filled) and after a send resets the box. Cheap: height:'auto' lets scrollHeight
  // report the true wrapped content height before we pin it.
  function autoGrowInput() {
    if (!input) return;
    input.style.height = 'auto';
    // An EMPTY box rests at the CSS one-line min-height. We must NOT pin it to scrollHeight when empty:
    // a long placeholder wraps to 2 lines on a narrow panel, and its wrapped height would puff the
    // resting box up. Only a real value grows the box.
    if (input.value) input.style.height = input.scrollHeight + 'px';
    updateCharCount();   // the char counter rides every value change (typed, recalled, recipe-filled, send-reset)
  }
  // COMPOSER CAP READOUT — the textarea maxlength is 100,000; a dim counter appears only as the message NEARS the
  // cap (so it never nags a normal message) and turns --warn at the very edge. Truthful: it reads the real length.
  const COMPOSER_MAX = 100000, COMPOSER_WARN_AT = 90000, COMPOSER_WARN_CHARS = 1000;
  function updateCharCount() {
    const cc = el('chat-charcount'); if (!cc) return;
    const n = input ? input.value.length : 0;
    if (n < COMPOSER_WARN_AT) { if (!cc.hidden) { cc.hidden = true; cc.textContent = ''; cc.classList.remove('warn'); } return; }
    cc.hidden = false;
    cc.textContent = n + ' / ' + COMPOSER_MAX;
    cc.classList.toggle('warn', n >= COMPOSER_MAX - COMPOSER_WARN_CHARS);
  }

  /* ── COMMS AGENT LINE ────────────────────────────────────────────────────────────────────────────────
     The top-of-panel identity row: a <select> of every live roster agent (so the Commander picks who's on
     the line) + a truthful readout of THAT agent's model. Both are filled from App.agents() — never
     hardcoded — so the header can only ever assert a real roster identity (truthful telemetry). Selecting
     an agent hands off to App.selectAgent, which switches to (or mints) a workstream bound to that agentId;
     it never rebinds the current conversation to a different agent. Re-rendered on every load()/switch so the
     selection + model always match the displayed stream (including changes made in the footer dock/dossier). */
  function agentModelText(a) {
    if (!a) return '';
    const model = a.model ? String(a.model) : '';
    if (!model) return 'follows station default';
    // reuse the dock's short-label vocabulary when present; else the last path segment (never invent a name)
    return (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.short)
      ? ModelDock.labels.short(model)
      : ((model.split('/').pop() || model).toUpperCase());
  }
  // The COMMS header's model slot, de-duplicated against the composer's model-dock chip (see renderIdBar).
  // Never invents a name: every branch reads the same real roster/localStorage state agentModelText does.
  function pinReadout(a) {
    const mine = agentModelText(a);
    if (!a.model) return mine;                                    // unpinned — "follows station default", no bogus "pin:" prefix
    const station = (typeof Harness !== 'undefined' && Harness.getModel) ? String(Harness.getModel() || '') : '';
    const stationShort = (station && typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.short)
      ? ModelDock.labels.short(station) : '';
    return (stationShort && mine === stationShort) ? 'pinned' : ('pin: ' + mine);
  }
  // P1.2 (UPDATE_STATE_SAFETY_AUDIT) — an honest one-line notice shown in the COMMS header's model slot when the
  // focused agent id is NOT in the live registry (roster out of sync). focusAgent sets it instead of silently
  // rebinding to the overseer; a subsequent focus onto a REAL agent clears it (''). No new window, no .reply beat —
  // it reuses the existing aria-live model-readout element + a modifier class, per frontend law.
  let rosterStatusMsg = '';
  function setRosterStatus(msg) {
    rosterStatusMsg = String(msg == null ? '' : msg);
    const modelEl = el('comms-agent-model');
    if (modelEl && rosterStatusMsg) { modelEl.textContent = rosterStatusMsg; modelEl.classList.add('comms-agent-warn'); }
    else if (modelEl) { modelEl.classList.remove('comms-agent-warn'); renderIdBar(); }
  }
  function renderIdBar() {
    if (typeof GroupChat !== 'undefined') GroupChat.bind(activeWs);
    const sel = el('comms-agent-select'); const modelEl = el('comms-agent-model'); const bar = el('comms-idbar');
    if (!sel) return;
    // an active roster-out-of-sync notice wins the model slot: don't overwrite the honest state with a stale
    // model readout while the focused id can't be resolved (focusAgent clears it once a real agent is focused).
    if (rosterStatusMsg) { if (modelEl) { modelEl.textContent = rosterStatusMsg; modelEl.classList.add('comms-agent-warn'); } if (bar) bar.hidden = false; return; }
    if (modelEl) modelEl.classList.remove('comms-agent-warn');
    const list = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
    const duplicateAgentName = a => {
      const key = String((a && a.name) || '').trim().toUpperCase();
      return !!key && list.filter(x => String((x && x.name) || '').trim().toUpperCase() === key).length > 1;
    };
    const activeId = activeWs ? (activeWs.agentId || 'agent') : null;
    // rebuild the <option> set only when the roster (ids+names) or selection changed, so a redundant re-render
    // never collapses a mid-open native dropdown.
    const key = list.map(a => a.id + ':' + (a.name || a.id)).join('|') + '#' + (activeId == null ? '' : activeId);
    if (sel.__idKey !== key) {
      sel.__idKey = key;
      sel.innerHTML = '';
      for (const a of list) { const o = document.createElement('option'); o.value = a.id; o.textContent = (a.name || a.id) + (duplicateAgentName(a) ? ' [' + a.id + ']' : ''); sel.appendChild(o); }
      if (activeId != null) sel.value = activeId;
    }
    const cur = list.find(a => a.id === activeId) || null;
    const portrait = el('comms-agent-portrait');
    if (typeof AgentPortraits !== 'undefined') AgentPortraits.paint(portrait, cur);
    // "pin:" prefix so this per-agent PINNED model readout can't be misread as the dock's active-model chip.
    // DEDUPE (2026-07-27): the composer's dock chip already names the active model a few rows below. When an
    // agent's pin resolves to that SAME model, spelling the name twice in one panel adds nothing — collapse to
    // the one fact the dock chip genuinely can't carry ("this agent is pinned, it won't follow the default").
    // The full name stays whenever the two actually differ, which is the case worth reading. And an UNPINNED
    // agent no longer prints the self-contradicting "pin: follows station default".
    if (modelEl) modelEl.textContent = cur ? pinReadout(cur) : '';
    if (bar) bar.hidden = !list.length;   // no roster yet (pre-wake) → hide the row rather than show an empty selector
  }
  // DOSSIER RENAME INVALIDATION: setAgentName mutates App's live roster without switching workstreams, so the
  // top identity row's option-key cache and Chat's focused speaker-name cache would otherwise retain the old
  // label. Re-resolve both from the authoritative live roster. This is deliberately lighter than load(ws): a
  // display-name edit must not clear/replay the transcript, reset beat queues, or disturb an in-flight stream.
  function refreshAgentIdentity() {
    if (activeWs && typeof App !== 'undefined' && App.agentName) {
      const nm = App.agentName(activeWs.agentId || 'agent');
      if (nm) name = nm;
    }
    renderIdBar();
  }
  // wire the agent <select> once: a change hands off to App.selectAgent (switch/mint a stream bound to that
  // agent). Registered from init() so a re-init can't stack handlers.
  function wireIdBar() {
    const sel = el('comms-agent-select');
    if (!sel || sel.__wired) return;
    sel.__wired = true;
    sel.addEventListener('change', () => {
      const id = sel.value;
      if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
      if (typeof App !== 'undefined' && App.selectAgent) App.selectAgent(id);
      // App.selectAgent → switchWorkstream → Chat.load → renderIdBar, so the model readout follows the switch.
    });
  }

  function mergeCanonicalHistory(local, turns) {
    const buckets = new Map();
    const status = [];
    for (const row of Array.isArray(local) ? local : []) {
      if (row && row.sys) { if (!row.transcriptPending) status.push(row); continue; }
      if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
      if (row.role === 'assistant' && !String(row.content == null ? '' : row.content).trim()) continue;
      const key = row.role + '\u0000' + String(row.content || '');
      const q = buckets.get(key) || []; q.push(row); buckets.set(key, q);
    }
    const merged = [];
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      if (turn.role === 'assistant' && !String(turn.content == null ? '' : turn.content).trim()) continue;
      const key = turn.role + '\u0000' + String(turn.content || '');
      const q = buckets.get(key) || [], prior = q.shift();
      merged.push(Object.assign({}, turn, prior || {}, { role: turn.role, content: String(turn.content || ''), ts: turn.ts != null ? turn.ts : (prior && prior.ts) }));
    }
    // Preserve genuinely local/in-flight rows the sidecar has not committed yet. Occurrence queues, rather than
    // a Set, keep two identical user turns distinct while still preventing a duplicate final answer.
    for (const q of buckets.values()) for (const row of q) merged.push(row);
    // Keep settled local status lines (failed / silent / nothing-to-report). A pending transcript warning is rebuilt
    // from the latest read below, so it disappears automatically as soon as canonical prose becomes available.
    for (const row of status) merged.push(row);
    return merged;
  }

  async function reconcileServerHistory(ws, loadToken) {
    if (!ws || !ws.id) return;
    const cronSession = String(ws.id).indexOf('cron-') === 0;
    let busy = false;
    try { busy = typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(ws.id); } catch (_) {}
    const waits = cronSession && !busy ? [120, 400] : [];
    let turns = [], reachable = false;
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      try {
        const r = await fetch('/api/transcript?agent=' + encodeURIComponent(ws.agentId || 'agent') + '&stream=' + encodeURIComponent(ws.id) + '&limit=200', { cache: 'no-store' });
        if (r.ok) {
          const j = (await r.json()) || {};
          turns = Array.isArray(j.turns) ? j.turns : [];
          reachable = true;
          if (!cronSession || turns.some(t => t && t.role === 'assistant' && String(t.content == null ? '' : t.content).trim())) break;
        }
      } catch (_) { /* retry the bounded cron persistence window below */ }
      if (attempt < waits.length) await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
    const next = mergeCanonicalHistory(ws.history, turns);
    const readable = next.some(m => m && (
      (m.role === 'assistant' && String(m.content == null ? '' : m.content).trim()) ||
      (m.sys && !m.transcriptPending && String(m.content == null ? '' : m.content).trim())
    ));
    if (cronSession && !busy && !readable) next.push({
      role: 'system', sys: true, error: true, transcriptPending: true,
      content: reachable
        ? '⚠ output has not arrived yet — StarNet will retry automatically when this session opens'
        : '⚠ couldn\'t load the output yet — StarNet will retry automatically when this session opens'
    });
    if (JSON.stringify(next) === JSON.stringify(ws.history || [])) return;
    ws.history = next;
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
    if (!activeWs || activeWs.id !== ws.id || historyPinPending !== loadToken) return;
    if (log) log.innerHTML = '';
    renderHistory(); replayChannel(); syncStatus(); maybeEmptyState();
    pinLoadedHistoryAfterLayout(loadToken);
  }

  // swap the rendered conversation to a workstream (its history). Used on enter/resume and when the
  // Commander clicks another stream in the rail — re-renders without re-wiring the input row.
  function loadGroupConversation(ws) {
    GroupChat.bind(ws);
    clearNudge(); clearChoices();
    if (typeof Channels !== 'undefined') Channels.setComposeTarget(ws.id);
    updateControls(); autoGrowInput();
  }
  function load(ws) {
    const historyPin = ++historyPinSeq;
    historyPinPending = historyPin;
    const nextWs = ws || (typeof Workstreams !== 'undefined' ? Workstreams.active() : null);
    if (activeWs?.id !== nextWs?.id) focusVersion++;
    activeWs = nextWs;
    if (activeWs && activeWs.conversationMode === 'group' && typeof GroupChat !== 'undefined') {
      loadGroupConversation(activeWs);
      return; // Group history/recovery is backend-owned; never auto-resume it through the direct-run path.
    }
    // SPEAKER IDENTITY: re-resolve `name` (the reply-chip + agent-beat speaker, else stuck at init's hero) from the
    // displayed stream's agent, so switching agents relabels replies. Guard: an unknown id keeps the current name.
    if (activeWs && typeof App !== 'undefined' && App.agentName) { const nm = App.agentName(activeWs.agentId || 'agent'); if (nm) name = nm; }
    activeTurnin = null; turninQueue.length = 0; clearNudge(); clearChoices();   // visible review/choice layers belong to the current COMMS DOM
    if (beatCards) beatCards.reset({ seen: false, queues: false });   // every stream switch invalidates stale async results from the outgoing COMMS generation
    endToolRail(); presenceCurTool = null;   // COMMS-PREMIUM: the tool rail + live-tool state belong to the OUTGOING stream's DOM
    // typing targets the displayed stream (war-room D2: the compose target is decoupled from any camera jump)
    if (activeWs && typeof Channels !== 'undefined') Channels.setComposeTarget(activeWs.id);
    if (log) log.innerHTML = '';
    stick = true; hideNewPill();   // a freshly-loaded / switched-to stream starts pinned to its latest line
    renderHistory();
    restoreTaskQuestion(activeWs);   // restart/switch continuity: re-present a real still-unanswered durable brief
    if (activeWs && !taskQuestionLive() && typeof Workstreams !== 'undefined' && Workstreams.connectorHandoff(activeWs.id)) {
      const h = Workstreams.connectorHandoff(activeWs.id);
      const door = Friendly.connectorDoor(h);
      if (door) choices([{ label: '⇄ CONNECT / CONTINUE TASK', value: 'connect' }], () => door.run());
    }
    replayChannel();   // re-render an in-flight stream we left running: tool lines / partial reply / pending approval
    syncStatus();      // also paints the Stop control + this stream's queued pills (updateControls)
    maybeEmptyState();   // brand-new / empty + idle stream → a one-line hint instead of a blank void
    maybeDeskPrompt();   // …and if this stream's agent still has nowhere to sit, the required next step + its door
    if (activeWs) flushQueued(activeWs.id);   // returned to an idle stream that has a queued follow-up → send it now
    // GOAL LOOP: returned to an idle stream with an ACTIVE standing goal (its moment was blocked / it was
    // backgrounded mid-loop) → continue it. kickGoal no-ops when busy/blocked/paused, so this is always safe.
    if (activeWs && typeof GoalLoop !== 'undefined' && goalOf(activeWs)) { const w = activeWs; setTimeout(() => { if (isActiveWs(w)) kickGoal(w); }, 0); }
    // TIER D · D1 ATTENTIVE AUDIENCE: announce which agent the Commander now has COMMS focus on. load(ws) is the
    // sole conversation-rebind boundary (open + every switch), and the persistent COMMS panel has no separate
    // close — so this one hook covers focus on/switch, and null when there's no active stream. world.js owns all
    // behavior: the focused body, while idle, stops wandering and holds its attention on you (faces you, tracks the
    // cursor); it yields instantly to a reply run and resumes after. This is the ONLY chat.js change for D1 (G7).
    if (typeof World !== 'undefined' && World.setChatFocus) World.setChatFocus(activeWs ? (activeWs.agentId || 'agent') : null);
    renderIdBar();   // the agent selector + model readout follow the displayed stream's agent
    // SESSION DELIVERY (2026-07-15): opening a deliverable's own session ('workshop-<runId>') is what renders
    // its return card — never a pop-up into whichever stream happened to be selected. presentFor no-ops fast on
    // every other id, re-checks the server (undecided only), and the card itself is pinned to this session.
    if (activeWs && typeof WorkshopStore !== 'undefined' && WorkshopStore.presentFor) {
      try { WorkshopStore.presentFor(activeWs.id).catch(() => {}); } catch (_) {}
    }
    pinLoadedHistoryAfterLayout(historyPin);
    reconcileServerHistory(activeWs, historyPin);
    // Reconcile a run that died while this page was closed or the sidecar restarted. Only the server's durable
    // safe verdict can start work; uncertain mutations remain paused and visible.
    if (activeWs) { const w = activeWs; setTimeout(() => { if (isActiveWs(w)) recoverSafeRun(w, true); }, 0); }
  }

  async function restoreTaskQuestion(ws) {
    if (!ws || !ws.id) return;
    const id = String(ws.id), key = 'stream:' + id;
    try {
      const r = await fetch('/api/task-briefs?key=' + encodeURIComponent(key) + '&status=clarifying&limit=1', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!activeWs || activeWs.id !== id || isBusy()) return;
      const b = j && Array.isArray(j.briefs) && j.briefs[0];
      const q = b && Array.isArray(b.questions) && b.questions[b.questions.length - 1];
      if (q && !q.answer && Array.isArray(q.options) && (q.options.length >= 2 || q.mode==='conversation')) offerTaskQuestion({ question: q.text, options: q.options, mode:q.mode, sample:q.sample, context:b.context, recommended: q.recommended || '', reason: q.reason || '', grounded: (j && j.grounded) || null });
    } catch (_) { /* a missing/offline sidecar leaves history readable; the next load retries */ }
  }

  function setSystem(s) { system = s; }
  // HISTORY CAP (Lane E3): ws.history grew unbounded across a session, and the WHOLE array was POSTed as `messages`
  // on every run — memory + payload both climbing forever on a 24/7 station. Cap the STORED history and send only a
  // capped window. Chosen to preserve behavior for any normal session:
  //   • The sidecar (index.js) only auto-seeds from the durable transcript when the client sends ≤1 non-system
  //     message, and its own resume horizon is transcriptStore.reconstruct(streamId,{limit:100}) — the server
  //     already treats ~100 turns as the memory horizon.
  //   • Within a run, loop.js token-auto-compacts the working array, so older turns beyond the model's context are
  //     summarized away server-side regardless of how many the client sends.
  // So capping at 120 kept turns (> the server's 100 resume horizon) is byte-identical for normal sessions and only
  // bites pathologically long ones — exactly where the server would have compacted anyway. A single truncation
  // marker object (role:'system', truncated:true) records the drop honestly for readers of the array.
  const HISTORY_CAP = 120;
  // `/api/run` accepts a 2 MiB JSON body. Reserve half for the system prompt, capability metadata, project
  // context, and JSON envelope; the dialogue gets one UTF-8-measured MiB. This keeps repeated 100K pastes from
  // turning a later send into HTTP 413 while preserving the newest message intact and retaining local history.
  const HISTORY_WIRE_MAX_BYTES = 1 << 20;
  function capHistory(ws) {
    if (!ws || !Array.isArray(ws.history)) return;
    // count only real dialogue turns (skip a prior truncation marker) so the marker never inflates the count
    const real = ws.history.filter(m => !(m && m.truncated));
    if (real.length <= HISTORY_CAP) { if (real.length !== ws.history.length) ws.history = real; return; }
    const dropped = real.length - HISTORY_CAP;
    const kept = real.slice(-HISTORY_CAP);
    ws.history = [{ role: 'system', truncated: true, content: '…(' + dropped + ' earlier turn' + (dropped === 1 ? '' : 's') + ' trimmed from local history)' }].concat(kept);
  }
  function utf8Bytes(s) {
    s = String(s == null ? '' : s);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n++;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function fitHistoryBytes(messages, maxBytes) {
    const src = Array.isArray(messages) ? messages : [];
    const limit = Math.max(1, Number(maxBytes) || HISTORY_WIRE_MAX_BYTES);
    const kept = [];
    let used = 2;   // `[]`
    for (let i = src.length - 1; i >= 0; i--) {
      const bytes = utf8Bytes(JSON.stringify(src[i])) + (kept.length ? 1 : 0);   // comma between array items
      // The newest turn is sacred: the composer already bounds it below this byte budget. Older history is the
      // expendable part, and we keep a contiguous suffix so the model never sees a temporally disjoint thread.
      if (kept.length && used + bytes > limit) break;
      kept.unshift(src[i]); used += bytes;
    }
    return kept;
  }
  // char/4 is StarNet's calibrated dialogue estimate, but it can undercount dense Unicode. Half the real UTF-8
  // bytes is a deliberately cautious second lens that still lets a full 100K English paste fit a 128K model.
  function contextEstimateMessages(messages) {
    const src = Array.isArray(messages) ? messages : [];
    const dialogue = (typeof CtxGauge !== 'undefined' && CtxGauge.estimateMessages) ? CtxGauge.estimateMessages(src) : 0;
    return Math.max(dialogue, Math.ceil(utf8Bytes(JSON.stringify(src)) / 2));
  }
  // the outbound window: the messages actually POSTed as `messages`. Drops local-only markers, caps turns, then
  // caps UTF-8 bytes. The local transcript is untouched; only stale wire history yields to a giant new paste.
  function historyWindowFrom(history) {
    if (!Array.isArray(history)) return [];
    // drop LOCAL markers that are records, not dialogue: the history-cap marker (truncated) and any system status
    // line (sys — e.g. an autosessions "routine ran, nothing to report" / "couldn't load the output" framing line).
    // These must NEVER be replayed to the model as prior turns (a frontend-authored string is not the agent's word).
    const real = history.filter(m => !(m && (m.truncated || m.sys)));
    const turnCapped = real.length > HISTORY_CAP ? real.slice(-HISTORY_CAP) : real;
    return fitHistoryBytes(turnCapped, HISTORY_WIRE_MAX_BYTES);
  }
  function fitHistoryTokens(messages, maxTokens) {
    const src = Array.isArray(messages) ? messages : [];
    const limit = Math.max(1, Number(maxTokens) || 1);
    const kept = [];
    let used = 0;
    for (let i = src.length - 1; i >= 0; i--) {
      const tokens = contextEstimateMessages([src[i]]);
      if (kept.length && used + tokens > limit) break;
      kept.unshift(src[i]); used += tokens;
    }
    return kept;
  }
  function modelFitHistory(history, ws) {
    const base = historyWindowFrom(history);
    if (!ws || typeof Harness === 'undefined' || typeof CtxGauge === 'undefined') return base;
    let limit = 0, selectedModel = '';
    try {
      if (Harness.getModel) selectedModel = Harness.getModel() || '';
      if (Harness.contextLimitOf) limit = Harness.contextLimitOf(selectedModel);
    } catch (_) {}
    if (!limit) return base;   // unknown catalog => byte-safe only; never invent a token ceiling
    const reserve = Math.min(16000, Math.floor(limit / 2));
    let budget = Math.max(1, Math.floor(limit * 0.85) - reserve);
    let fitted = fitHistoryTokens(base, budget);
    // Once this conversation has a real calibrated projection, replace the conservative 16K reserve with its
    // measured overhead and fit again. Older turns yield; the newest Commander message remains sacred.
    try {
      const state = Harness.contextState && Harness.contextState(ws.agentId || 'agent', ws.id, fitted);
      // A settled conversation may have been measured on a model the Commander has since switched away from.
      // That old model's limit/projection cannot govern the next request; use it only when model identities match.
      if (state && (!state.model || state.model === selectedModel) && state.limit) limit = state.limit;
      if (state && (!state.model || state.model === selectedModel) && state.used > 0 && (state.measured || state.projected)) {
        const dialogue = contextEstimateMessages(fitted);
        const overhead = Math.max(0, state.used - dialogue);
        budget = Math.max(1, Math.floor(limit * 0.85) - overhead);
        fitted = fitHistoryTokens(base, budget);
      }
    } catch (_) {}
    return fitted;
  }
  function historyWindow(ws) {
    return ws ? modelFitHistory(ws.history, ws) : [];
  }
  function contextIssueFor(messages, limit, projectedUsed) {
    limit = Math.max(0, Number(limit) || 0);
    if (!limit) return null;   // unknown catalog => never invent a ceiling
    const projected = Math.max(0, Number(projectedUsed) || 0);
    if (projected >= limit * 0.9) return { limit, used: projected, projected: true };
    // No calibrated overhead yet. Reserve up to 16K tokens (and never more than half the window) for the real
    // system/tool prompt, then apply the Unicode-aware dialogue estimate. Keep this second check even when a
    // calibrated char/4 projection exists: dense Unicode is exactly where that projection can be too optimistic.
    const dialogue = contextEstimateMessages(messages);
    const reserve = Math.min(16000, Math.floor(limit / 2));
    const dialogueBudget = Math.max(1, Math.floor(limit * 0.85) - reserve);
    return dialogue > dialogueBudget ? { limit, used: Math.max(projected, dialogue + reserve), projected: !!projected } : null;
  }
  function composerContextIssue(ws, text) {
    if (!ws || typeof Harness === 'undefined') return null;
    const proposed = modelFitHistory((Array.isArray(ws.history) ? ws.history : []).concat([{ role: 'user', content: String(text || '') }]), ws);
    let state = null, selectedModel = '', selectedLimit = 0;
    try {
      if (Harness.getModel) selectedModel = Harness.getModel() || '';
      if (Harness.contextLimitOf) selectedLimit = Harness.contextLimitOf(selectedModel);
      if (Harness.contextState) state = Harness.contextState(ws.agentId || 'agent', ws.id, proposed);
    } catch (_) {}
    const currentState = state && (!state.model || state.model === selectedModel) ? state : null;
    const limit = (currentState && currentState.limit) || selectedLimit;
    const projected = currentState && currentState.used > 0 && (currentState.measured || currentState.projected) ? currentState.used : 0;
    return contextIssueFor(proposed, limit, projected);
  }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  /* What the CONTEXT gauge needs to answer "how full is THIS chat?" — which conversation is on screen
     and the exact array its next request would carry. Deliberately routed through historyWindow (not
     raw ws.history) so the gauge estimates the same bytes the send path actually puts on the wire:
     local markers the model never sees must not inflate the reading. Returns null with no active
     stream, which the gauge reads as "nothing to measure yet". */
  function contextRef() {
    if (!activeWs) return null;
    return { agentId: activeWs.agentId || 'agent', streamId: activeWs.id, messages: historyWindow(activeWs) };
  }
  // A streamed fragment is real assistant output even when the transport dies before a clean result envelope.
  // Persist it as its own turn before the failure marker so switch/reload cannot erase what was already visible.
  function persistPartial(ws, text) {
    if (!ws || !ws.history) return false;
    const content = String(text == null ? '' : text);
    if (!content.trim()) return false;
    const last = ws.history[ws.history.length - 1];
    if (last && last.role === 'assistant' && !last.error && last.content === content) return false;
    ws.history.push({ role: 'assistant', content: content, ts: Date.now() });
    capHistory(ws);
    return true;
  }
  function isBusy() {
    if (activeWs?.conversationMode === 'group' && typeof GroupChat !== 'undefined') return GroupChat.isBusy();
    return !!(activeWs && typeof Channels !== 'undefined' && Channels.isBusy(activeWs.id));
  }
  function isActiveWs(ws) { return !!(ws && activeWs && activeWs.id === ws.id); }   // is THIS stream the one on screen right now?
  // CONCURRENT SESSIONS (2026-07-18): the backend now ADMITS concurrent runs of one agent (the workspace is
  // guarded by a run-scoped lease sidecar-side; the world's overlap refcount keeps the desk pose truthful).
  // This resolver survives as the SOFT indicator's source — "this agent is also running in <session>" — and
  // must never re-become a send gate: a peer run is information, not a refusal.
  function busyPeerFor(ws) {
    if (!ws || typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return null;
    const aid = ws.agentId || 'agent';
    const list = Workstreams.list ? Workstreams.list({ includeArchived: true }) : (Workstreams.all ? Workstreams.all() : []);
    return list.find(w => w && w.id !== ws.id && (w.agentId || 'agent') === aid && Channels.isBusy(w.id)) || null;
  }
  function renderAgentBusy(peer, detail) {
    if (!log) return;
    const old = log.querySelector('#comms-agent-busy');
    if (!peer && !detail) { if (old) old.remove(); return; }
    const rowEl = old || document.createElement('div');
    rowEl.id = 'comms-agent-busy'; rowEl.className = 'choice-row comms-agent-busy'; rowEl.textContent = '';
    const label = document.createElement('span'); label.className = 'dim';
    label.textContent = peer ? ('ALSO RUNNING IN ' + streamLabel(peer).toUpperCase()) : String(detail || 'AGENT BUSY');
    rowEl.appendChild(label);
    if (peer) {
      const view = document.createElement('button'); view.type = 'button'; view.className = 'choice'; view.textContent = 'VIEW ACTIVE RUN';
      view.onclick = () => { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(peer.id); };
      rowEl.appendChild(view);
    }
    if (!old) log.appendChild(rowEl);
  }
  function status(s) {
    if (!statusEl) return;
    statusEl.textContent = s;
    const low = String(s || '').toLowerCase();
    statusEl.classList.remove('status-thinking', 'status-working', 'status-approval', 'status-stopping', 'status-connecting', 'status-online', 'status-down');
    statusEl.classList.add(low.indexOf('approval') >= 0 ? 'status-approval'
      : low.indexOf('stopping') >= 0 ? 'status-stopping'
      : low.indexOf('working') >= 0 ? 'status-working'
      : low.indexOf('thinking') >= 0 ? 'status-thinking'
      : low.indexOf('connecting') >= 0 ? 'status-connecting'
      : low.indexOf('unreachable') >= 0 ? 'status-down'
      : 'status-online');
  }
  // derive the DISPLAYED stream's status from real state, so a low-priority write (a finishing turn) can't
  // clobber the high-priority 'awaiting your approval…' after a switch-back. One source of truth.
  function syncStatus() {
    if (interview) { status('waking…'); stopElapsedTimer(); return; }
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    const channelStatus = (activeWs && typeof Channels !== 'undefined' && Channels.statusOf) ? Channels.statusOf(activeWs.id) : '';
    // F2 (2026-07-14 adversarial sweep): the idle claim folds the REAL bridge health (World.linkState — the
    // same E1 predicate the topbar #sig / canvas LINK DOWN already read). A dead sidecar kept this label
    // asserting 'online' indefinitely — connectivity the harness (being gone) provably couldn't back. Only a
    // genuinely bridged-but-dead link downgrades; pre-entry and a deliberate pause still read as before.
    let down = false;
    try { const ls = (typeof World !== 'undefined' && World.linkState) ? World.linkState() : null; down = !!(ls && ls.bridged && !ls.paused && ls.down); } catch (_) {}
    const peer = !isBusy() ? busyPeerFor(activeWs) : null;
    // a peer run no longer blocks THIS session — the status stays an honest 'online' (send is allowed) with
    // the peer named beside it; the soft #comms-agent-busy row below carries the VIEW ACTIVE RUN route.
    // ('running', not 'busy'/'working': status() classifies by substring and this session is NOT the one working.)
    status(p ? 'awaiting your approval…' : (isBusy() ? (channelStatus || 'thinking…') : (peer ? ('online · also running in ' + streamLabel(peer)) : (down ? 'station unreachable' : 'online'))));
    renderAgentBusy(peer);
    // keep the elapsed readout matched to the DISPLAYED stream — switching to a busy stream picks up its
    // live count, switching to an idle one clears it. (send() also starts it the instant a run begins.)
    if (isBusy()) ensureElapsedTimer(); else stopElapsedTimer();
    updateControls();   // Stop button visibility + queued pills follow the displayed stream too
  }
  function clearEmptyState() { const e = log && log.querySelector('.cmsg-empty'); if (e) e.remove(); }
  function starterContext() {
    const agentId = (activeWs && activeWs.agentId) || 'agent', beliefs = {}, preferences = {};
    for (const dim of ['goals', 'pain', 'ambition', 'standing_orders', 'style', 'stack', 'people', 'schedule', 'identity']) {
      beliefs[dim] = typeof DossierStore !== 'undefined' ? DossierStore.beliefs(dim) : [];
    }
    for (const kind of ['build', 'research', 'analyze', 'automate', 'continue']) {
      // An impression changes the ledger's weight denominator, not the user's direction.
      // Cache on direction so merely showing an idea cannot trigger another paid generation.
      preferences[kind] = typeof RecLedger !== 'undefined' ? Math.sign(RecLedger.preferenceOf(kind, [kind])) : 0;
    }
    return Starters.context({ now: Date.now(), agentId, projectRoot: activeWs && activeWs.projectRoot,
      sessions: Workstreams.list().map(w => ({ ...w, busy: typeof Channels !== 'undefined' && Channels.isBusy(w.id) })),
      beliefs, preferences, goal: typeof GoalStore !== 'undefined' ? GoalStore.activeGoal() : null,
      capabilities: typeof World !== 'undefined' && World.heroCaps ? World.heroCaps(agentId) : [],
      enabled: typeof ProfileStore === 'undefined' || ProfileStore.enabled() });
  }
  function starterOptions() {
    return { system, modelKey: typeof Harness !== 'undefined' ? Harness.getProv() + ':' + Harness.getModel() : '' };
  }
  function refreshStarters() {
    if (!log || !activeWs || activeWs.history.length || isBusy() || interview || (input && input.value.trim())) return;
    const d = log.querySelector('.cmsg-empty');
    if (!d) { maybeEmptyState(); return; }
    const key = JSON.stringify([starterContext(), starterOptions()]);
    if (d.starterKey === key && !(d.retryAt && Date.now() >= d.retryAt) && Date.now() < d.expiresAt) return;
    // Keep focus stable during keyboard selection. The next idle tick can refresh it.
    if (d.contains(document.activeElement)) return;
    if (d.starterKey === key && d.retryAt && Date.now() >= d.retryAt && d.forcePending) {
      requestStarterIdeas(d, d.querySelector('.cmsg-empty-hint'), starterContext(), starterOptions(), true); return;
    }
    clearEmptyState(); maybeEmptyState();
  }
  function openStarter(st, hint) {
    if (input.value.trim()) { hint.textContent = 'Send or clear your current draft before choosing a session.'; input.focus(); return; }
    const ctx = starterContext();
    // Revalidate both evidence and destination at click time: work can finish in another session.
    const sameEvidence = st.evidence.every(s => ctx.sources.some(current => current.id === s.id && current.text === s.text));
    const valid = st.general || (sameEvidence && Starters.parse(JSON.stringify({ suggestions: [{ title: st.label, why: st.description, ...st }] }), ctx, StarterStore.exclusions()).length);
    if ((!st.general && !ctx.enabled) || !valid) { clearEmptyState(); maybeEmptyState(); return; }
    let ws;
    if (st.sessionId) {
      const target = Workstreams.get(st.sessionId);
      if (!target || target.archived || Channels.isBusy(target.id)) return;
      ws = Workstreams.switch(target.id);
    } else ws = Workstreams.create(st.label, { agentId: ctx.agentId, projectRoot: ctx.projectRoot || undefined });
    if (!ws) return;
    load(ws);
    prefill(Starters.launchPrompt(st));
    if (!st.general) StarterStore.prepare(st, ws.id, input.value);
    clearEmptyState(); refreshWorkflowViews();
  }
  function renderStarterIdeas(d, hint, result) {
    const old = d.querySelector('.cmsg-empty-chips'); if (old) old.remove();
    const chips = document.createElement('div'); chips.className = 'cmsg-empty-chips';
    const personalized = result.ideas || [], ideas = personalized.length ? personalized : Starters.defaults();
    const messages = {
      cold: 'Three ways to put ' + name + ' to work. Suggestions will become specific as we work together.',
      paused: 'Personalization is paused. These starting points are available to everyone.',
      loading: 'Finding ideas from your work. These starting points are available meanwhile.',
      cooldown: 'Updating ideas from your latest context. Or start with one of these.',
      error: 'Personalized ideas are unavailable right now. Try one of these starting points.',
      ready: personalized.length ? 'Based on your work and goals. Choose a session to review its brief.' : 'Three substantial starting points. Your own requests will shape future suggestions.'
    };
    hint.textContent = messages[result.status] || messages.ready;
    d.retryAt = result.status === 'cooldown' ? result.retryAt : 0;
    for (const st of ideas) {
      if (!st.general) StarterStore.shown(st);
      const row = document.createElement('div'); row.className = 'cmsg-starter-row';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'choice cmsg-starter';
      const title = document.createElement('span'); title.className = 'cmsg-starter-title'; title.textContent = st.label;
      const detail = document.createElement('span'); detail.className = 'cmsg-starter-detail'; detail.textContent = st.description;
      const output = document.createElement('span'); output.className = 'cmsg-starter-output'; output.textContent = 'Result: ' + st.deliverable;
      const arrow = document.createElement('span'); arrow.className = 'cmsg-starter-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
      b.append(title, detail); if (!st.general) b.appendChild(output); b.appendChild(arrow);
      b.addEventListener('click', () => openStarter(st, hint));
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'choice cmsg-starter-dismiss';
      dismiss.textContent = 'Not relevant'; dismiss.setAttribute('aria-label', 'Not relevant: ' + st.label);
      dismiss.addEventListener('click', () => { StarterStore.dismiss(st); row.remove(); if (!chips.querySelector('.cmsg-starter-row')) renderStarterIdeas(d, hint, { status: 'ready', ideas: [] }); });
      row.appendChild(b); if (!st.general) row.appendChild(dismiss); chips.appendChild(row);
    }
    if (['ready', 'error'].includes(result.status)) {
      const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'choice cmsg-starter-refresh'; refresh.textContent = 'Refresh suggestions';
      refresh.addEventListener('click', () => requestStarterIdeas(d, hint, starterContext(), starterOptions(), true)); chips.appendChild(refresh);
    }
    d.appendChild(chips);
  }
  async function requestStarterIdeas(d, hint, ctx, options, force) {
    d.forcePending = !!force;
    renderStarterIdeas(d, hint, { status: 'loading', ideas: [] });
    // Hydrate durable feedback before spending a generation on boot's temporary zero weights.
    try { if (typeof RecLedger !== 'undefined') await RecLedger.refresh(); } catch (_) {}
    if (!d.isConnected) return;
    ctx = starterContext(); options = starterOptions();
    d.starterKey = JSON.stringify([ctx, options]);
    const origin = activeWs && activeWs.id, key = JSON.stringify([ctx, options]);
    StarterStore.request(ctx, { ...options, force: !!force }).then(result => {
      if (!d.isConnected || !activeWs || activeWs.id !== origin || activeWs.history.length || isBusy()) return;
      if (JSON.stringify([starterContext(), starterOptions()]) !== key) { clearEmptyState(); maybeEmptyState(); return; }
      if (result.status !== 'cancelled') renderStarterIdeas(d, hint, result);
    });
  }
  function maybeEmptyState() {
    if (!log || interview || log.querySelector('.cmsg-empty')) return;
    if (activeWs && activeWs.history && activeWs.history.length) return;
    if (busyPeerFor(activeWs)) return;   // the ALSO RUNNING IN row owns an empty busy-peer session — starter chips would fight it for attention
    if (isBusy() || log.querySelector('.cmsg')) return;
    const s = (typeof Channels !== 'undefined' && activeWs) ? Channels.snapshot(activeWs.id) : null;
    if (s && ((s.toolEvents && s.toolEvents.length) || s.tools.length || s.acc || s.pending)) return;
    const d = document.createElement('div'); d.className = 'cmsg-empty';
    const line = document.createElement('div'); line.className = 'cmsg-empty-line';
    line.textContent = 'What would you like to work on?';
    d.appendChild(line);
    const hint = document.createElement('div'); hint.className = 'cmsg-empty-hint';
    d.appendChild(hint);
    log.appendChild(d);
    const ctx = starterContext(), options = starterOptions(), result = StarterStore.peek(ctx, options);
    d.starterKey = JSON.stringify([ctx, options]); d.expiresAt = Date.now() + StarterStore.TTL;
    if (result.status === 'empty' || result.status === 'loading') requestStarterIdeas(d, hint, ctx, options);
    else renderStarterIdeas(d, hint, result);
  }

  /* THE ONE STEP A HAND-SUMMONED AGENT LEAVES TO THE COMMANDER (2026-08-03).
     A specialist summoned from the Recruitment Bay arrives with NO desk — deliberately, so the Commander chooses
     where it sits — and until it has one it cannot take floor work. That required step used to be printed ONCE by
     summonAgent: a DOM-only line, so the first stream switch or reload erased the only place it was ever stated
     (load() rebuilds the log from ws.history, and a local line is not history), and any live beat dropped it
     outright. A brand-new agent's session was then indistinguishable from any other empty stream.
     It is now a property of the STREAM: every open of a deskless specialist's session states the step and offers
     the door. The claim is re-derived from the live floor (App.needsWorkstation) on every load, never stored — so
     it cannot outlive the desk it asks for, and cannot assert a floor state the station can't prove.
     Anti-nag: it is one system line + the chip row that answers it, in the session that owes the desk, and it is
     silent while that stream is mid-run (the run owns its own DOM; the prompt returns on the next open). */
  // REFIT can satisfy the prompt while this stream remains open. Its text is a derived floor claim, not history,
  // so retire both of its DOM rows as soon as the live floor proves the desk now exists. Keep every unrelated
  // system/choice row intact; a broad clearChoices() here would erase whichever real question owns COMMS.
  function retireDeskPrompt() {
    if (!log || !activeWs || typeof App === 'undefined' || !App.needsWorkstation) return false;
    const rows = Array.from(log.querySelectorAll('.comms-desk-prompt'));
    if (!rows.length || App.needsWorkstation(activeWs.agentId || 'agent')) return false;
    for (const r of rows) { activeChoiceRows.delete(r); r.remove(); }
    maybeEmptyState();   // the desk prompt can be the empty stream's only content; restore its normal starter state
    return true;
  }
  function maybeDeskPrompt() {
    if (!log || interview || !activeWs || isBusy()) return;
    const id = activeWs.agentId || 'agent';
    if (typeof App === 'undefined' || !App.needsWorkstation || !App.needsWorkstation(id)) return;
    const who = (App.agentName && App.agentName(id)) || name;
    const prompt = row('system'); prompt.d.classList.add('comms-desk-prompt');
    prompt.body.textContent = who + ' has nowhere to sit yet — it needs a desk of its own before it can take floor work. want to place one?';
    autoscroll();
    // the chip is the whole point: it opens REFIT already armed on the WORKSTATIONS palette, so the next floor
    // click drops the desk. 'later' just dismisses this view of it — the step is still owed, so the next open
    // of this session says so again (it stops for good the moment the desk exists).
    const chips = choices([{ label: '▤ PLACE ITS DESK', value: 'desk' }, { label: 'later', value: 'later', skip: true }], item => {
      if (item && item.value === 'desk' && App.openDeskPlacement) App.openDeskPlacement();
    });
    if (chips) chips.classList.add('comms-desk-prompt');
  }

  // opts.live === true marks the streaming reply row, which always pins to the BOTTOM. Every other row (tool
  // ▶/◀ lines, deliverables, consent, turn-in) inserts ABOVE the pinned reply while one is live — so the work
  // log stacks above and the message the agent is actually saying stays at the bottom, never scrolled away.
  let renderingHistory = false;   // true only during renderHistory: mark rows .no-anim so a full replay doesn't fire up to 120 entrance animations at once
  /* TRANSCRIPT DOM CAP (2026-08-26 lag fix). HISTORY_CAP bounds only the WIRE payload — the
     rendered #chat-log grew unpruned all session, and every autoscroll() reads scrollHeight
     (a forced layout of the whole transcript), so a long session got monotonically slower.
     Past LOG_DOM_CAP rows the oldest DOM rows are shed; the turns themselves stay in
     ws.history (already capped) and re-render on the next load(). Pruning only runs while
     stick=true (Commander at the bottom): a reader scrolled up into old rows never has the
     content shifted out from under them. The live presence card halts the sweep as a
     belt-and-braces guard (it is always among the newest rows anyway). */
  const LOG_DOM_CAP = 400;
  function pruneLog() {
    if (!log || !stick) return;
    while (log.children.length > LOG_DOM_CAP) {
      const n = log.firstElementChild;
      if (!n || n.id === 'comms-presence' || (n.querySelector && n.querySelector('#comms-presence'))) break;
      n.remove();
    }
  }
  function row(role, opts) {
    clearEmptyState();   // any real row supersedes the first-run hint
    const d = document.createElement('div'); d.className = 'cmsg ' + role + (renderingHistory ? ' no-anim' : '');
    // COMMS-PREMIUM: the speaker chip + a dim HH:MM stamp share one header row (a flex .cmsg-head).
    const who = document.createElement('span'); who.className = 'who';
    // opts.who NAMES THE ACTUAL SPEAKER. Every agent row used to be stamped with the FOCUSED agent's name,
    // which was true while one agent owned every turn — a work line breaks that: stages 2..N are other agents
    // and labelling their work with the entry dock's name is a fabricated attribution (the same law that
    // stopped the hub writing a downstream stage's reply into the entry dock's transcript).
    who.textContent = role === 'user' ? 'COMMANDER' : role === 'system' ? 'SYSTEM' : ((opts && opts.who) || name);
    const body = document.createElement('span'); body.className = 'body';
    // TIMESTAMP TRUTH (P0): opts.stamp is `true` for a row created LIVE (real wall-clock now), a number/Date for a
    // stored turn's REAL recorded time, or falsy for a legacy turn that carries no time — in which case we render
    // NO stamp rather than fabricate the current clock (the module's own rule + truthful telemetry).
    const stampVal = opts && opts.stamp;
    if (stampVal) {
      const head = document.createElement('span'); head.className = 'cmsg-head';
      const ts = document.createElement('span'); ts.className = 'cmsg-ts';
      ts.textContent = fmtClock(stampVal === true ? null : new Date(stampVal));
      head.appendChild(who); head.appendChild(ts);
      d.appendChild(head); d.appendChild(body);
    } else {
      d.appendChild(who); d.appendChild(body);
    }
    // COPY: a hover-revealed copy button on MESSAGE rows (agent + Commander). CSS hides it on the work-log beats
    // (tool / consent / turn-in / nudge / deliverable) — those aren't prose to copy. One delegated handler
    // in init() reads the row's .body text, so a streamed reply gains the button the moment its row exists.
    if (role === 'agent' || role === 'user') {
      const cp = document.createElement('button'); cp.className = 'cmsg-copy'; cp.type = 'button';
      cp.setAttribute('data-copy-label', 'Copy message'); cp.setAttribute('data-tip', 'copy message');
      cp.setAttribute('aria-label', 'Copy message'); cp.textContent = '⧉';
      d.appendChild(cp);
    }
    log.appendChild(d);   // CHRONOLOGICAL: every row lands at the bottom, in the order it happened (classic chat)
    pruneLog();
    autoscroll();
    return { d, body };
  }
  // stamp: omitted → live now (real); a number/Date → the turn's stored real time; false → no stamp (replay of a
  // legacy turn that carries no time — never fabricate the current clock).
  function addUser(t, atts, stamp) {
    const r = row('user', { stamp: stamp === undefined ? true : stamp });
    if (t) r.body.textContent = t;
    if (atts && atts.length) renderUserAttachments(r.d, atts);   // ATTACHMENTS: thumbnails/file-chips under the message text
    autoscroll();
  }
  // render a SENT user turn's attachments: images as clickable thumbnails, other files as openable chips — both
  // served by the sidecar's jailed /api/file route (so they survive a reload, exactly like agent deliverables).
  function renderUserAttachments(rowEl, atts) {
    const aid = attachAgentId();
    const view = document.createElement('div'); view.className = 'chat-attach-view';
    for (const att of atts) {
      const a = att || {};
      const name = String(a.name || 'file');
      const rel = String(a.path || '');
      if (!rel) continue;
      if (a.kind === 'image') {
        const link = document.createElement('a'); link.className = 'thumb'; link.title = name;
        wireLightbox(link, rel, aid, name);   // click enlarges in-app (Esc / click-out / × to leave)
        const img = document.createElement('img'); img.loading = 'lazy'; img.alt = name;
        link.appendChild(img); view.appendChild(link);
        // fetch->blob->objectURL (NOT a direct <img src=/api/file>): a native image GET sends no Origin header,
        // which the API-auth gate rejects — the fetch path carries same-origin auth. Mirrors imageDeliverableLine,
        // including revoking the object URL once the bitmap has decoded so a 24/7 station never leaks one per image.
        fileBlobUrl(rel, aid).then(u => {
          img.src = u;
          const free = () => { try { URL.revokeObjectURL(u); } catch (_) {} };
          img.addEventListener('load', free, { once: true });
          img.addEventListener('error', free, { once: true });
        }).catch(() => {});
      } else {
        const chip = document.createElement('a'); chip.className = 'filechip'; chip.title = name;
        wireFileOpen(chip, rel, aid);
        chip.appendChild(glyphSpan(SVG_FILE));   // themed file glyph, not 📄
        chip.appendChild(document.createTextNode(' ' + (name.split(/[\\/]/).pop() || name)));
        view.appendChild(chip);
      }
    }
    if (view.childNodes.length) rowEl.appendChild(view);
  }
  // command / client-side output (/help, /whoami, version, unknown-command, …). A SYSTEM register — dim, no
  // speaker chip, never copyable — so the station's own words are never mistaken for the agent's speech.
  function localLine(t) { const r = row('system'); r.body.textContent = t; autoscroll(); return r.d; }
  // the history-cap marker ("…N earlier turns trimmed …") as a dim, centered, hairline-flanked system line —
  // a scrollback boundary, not a dropped record. Reuses the broadcast register's chrome (theme tokens only).
  function trimMarkerLine(t) {
    if (!log) return;
    clearEmptyState();
    const d = document.createElement('div'); d.className = 'cmsg trim-marker'; d.setAttribute('role', 'separator');
    const line = document.createElement('span'); line.className = 'tm-line'; line.textContent = String(t || '').replace(/^…?\(?/, '').replace(/\)$/, '');
    d.appendChild(line); log.appendChild(d); autoscroll();
  }
  // a COLLAPSED SYSTEM CARD for verbose command output (/history, /help) — one dim header row that expands its
  // body of lines on click, so a 30-row dump doesn't flood the transcript. Header is a real <button> (keyboard-
  // operable, aria-expanded). `lines` are plain strings (textContent — never innerHTML, so no injection).
  function systemCard(title, lines, opts) {
    if (!log) return;
    clearEmptyState();
    opts = opts || {};
    const d = document.createElement('div'); d.className = 'cmsg system syscard';
    const head = document.createElement('button'); head.type = 'button'; head.className = 'syscard-head';
    const open0 = !!opts.open;
    head.setAttribute('aria-expanded', open0 ? 'true' : 'false');
    const chev = document.createElement('span'); chev.className = 'syscard-chev'; chev.setAttribute('aria-hidden', 'true'); chev.textContent = '▸';
    const ttl = document.createElement('span'); ttl.className = 'syscard-title'; ttl.textContent = title;
    head.appendChild(chev); head.appendChild(ttl);
    const bodyWrap = document.createElement('div'); bodyWrap.className = 'syscard-body'; bodyWrap.hidden = !open0;
    for (const ln of (lines || [])) { const r = document.createElement('div'); r.className = 'syscard-row'; r.textContent = String(ln); bodyWrap.appendChild(r); }
    head.addEventListener('click', () => {
      const open = bodyWrap.hidden; bodyWrap.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      d.classList.toggle('open', open);
      if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    });
    if (open0) d.classList.add('open');
    d.appendChild(head); d.appendChild(bodyWrap);
    log.appendChild(d); autoscroll();
  }

  /* ---------- CELEBRATION broadcast: a terse station system line (level-up / quest / trophy) ----------
     NOT a beat-slot card: it never touches activeNudge/the post-run precedence chain (turn-in→suggestion→
     seed→curiosity), so it can never compete with or suppress a real ask. It's an ambient system line —
     dim, letter-spaced, centered, hairline rules either side — appended to the transcript exactly where it
     happened (so it slots UNDER a live presence card, never over it). The eerie register: a terse broadcast,
     never a party. `tint` (an agent suit colour) is the ONE established colour exception, applied to a
     highlighted span only. RESTRAINT enforced here: fires only in-game (never on the create/onboarding
     screens), and rate-limits — two broadcasts inside ~3s never stack. But a broadcast caught inside the
     window is QUEUED (small bounded FIFO), not dropped, and drained in order once the window elapses: a
     quest COMMS line sharing this path with a level-up/trophy must never be silently lost. */
  const BROADCAST_COALESCE_MS = 3000;
  const BROADCAST_QUEUE_CAP = 8;   // bounded FIFO: a celebration flood drops the OLDEST queued line, never grows unbounded
  let lastBroadcastAt = 0;
  const broadcastQueue = [];       // {text, opts} coalesced inside the window — drained in order, one per window slot
  let broadcastDrainTimer = null;
  function broadcastBlocked() {
    // never during the create/onboarding/interview flows — a celebration must land only on the live station
    const game = el('screen-game');
    if (!game || !game.classList.contains('active')) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    return false;
  }
  // drain ONE queued broadcast (oldest first) then reschedule until the queue empties — each drained line still
  // respects the one-per-window rate limit, so a burst plays out as an ordered trickle instead of stacking. A
  // queued line that turned invalid mid-wait (Commander left the station) is dropped, but the rest keep draining.
  function drainBroadcasts() {
    broadcastDrainTimer = null;
    if (!broadcastQueue.length) return;
    const item = broadcastQueue.shift();
    if (!broadcastBlocked()) renderBroadcast(item.text, item.opts);
    if (broadcastQueue.length) broadcastDrainTimer = setTimeout(drainBroadcasts, BROADCAST_COALESCE_MS);
  }
  // text: the terse line WITHOUT the leading ▸ (added here). opts.highlight: the substring to tint (the agent
  // name); opts.tint: the suit colour for that span; opts.tone: 'gold' brightens the whole line (trophies).
  function broadcast(text, opts) {
    if (!log) return false;
    opts = opts || {};
    if (broadcastBlocked()) return false;   // blocked (onboarding/interview/offscreen) → dropped, never queued
    const now = Date.now();
    // inside the rate-limit window, OR a drain is already in flight: QUEUE (preserving order) rather than drop.
    // Bounded — at the cap the oldest queued line is discarded so the queue can never grow without limit.
    if (broadcastDrainTimer || now - lastBroadcastAt < BROADCAST_COALESCE_MS) {
      broadcastQueue.push({ text, opts });
      while (broadcastQueue.length > BROADCAST_QUEUE_CAP) broadcastQueue.shift();
      if (!broadcastDrainTimer) broadcastDrainTimer = setTimeout(drainBroadcasts, Math.max(0, BROADCAST_COALESCE_MS - (now - lastBroadcastAt)));
      return true;
    }
    return renderBroadcast(text, opts);
  }
  // the actual render: append the terse system line + stamp the rate-limit clock. Shared by the live path and
  // the queue drainer (ONE renderer). Returns false only when there's no log node to append to.
  function renderBroadcast(text, opts) {
    if (!log) return false;
    opts = opts || {};
    lastBroadcastAt = Date.now();
    clearEmptyState();
    // COALESCE INTO ONE BLOCK: consecutive station lines share a single broadcast row (a centered stack
    // inside the same hairline chrome) instead of each claiming a full transcript row — four trophies
    // land as one quiet moment, not four rows wedged between the Commander and their agent.
    let d = null, stack = null;
    const last = log.lastElementChild;
    if (last && last.classList && last.classList.contains('broadcast')) { d = last; stack = d.querySelector('.bc-stack'); }
    if (!d || !stack) {
      d = document.createElement('div');
      d.className = 'cmsg broadcast' + (opts.tone === 'gold' ? ' broadcast-gold' : '');
      d.setAttribute('role', 'status');   // a live-region system line for AT (it renders no speaker chip)
      stack = document.createElement('span'); stack.className = 'bc-stack';
      d.appendChild(stack);
      log.appendChild(d);
    }
    const line = document.createElement('span');
    line.className = 'bc-line' + (opts.tone === 'gold' ? ' bc-gold' : '');   // tone rides the LINE (a shared block can mix tones)
    const raw = String(text == null ? '' : text);
    const hi = opts.highlight ? String(opts.highlight) : '';
    const ix = hi ? raw.indexOf(hi) : -1;
    // prefix glyph
    const pre = document.createElement('span'); pre.className = 'bc-glyph'; pre.textContent = '▸ ';
    line.appendChild(pre);
    if (ix >= 0) {
      if (ix > 0) line.appendChild(document.createTextNode(raw.slice(0, ix)));
      const em = document.createElement('span'); em.className = 'bc-name'; em.textContent = hi;
      if (opts.tint) { em.style.color = opts.tint; em.style.textShadow = '0 0 6px ' + opts.tint; }
      line.appendChild(em);
      line.appendChild(document.createTextNode(raw.slice(ix + hi.length)));
    } else {
      line.appendChild(document.createTextNode(raw));
    }
    stack.appendChild(line);
    autoscroll();
    // ASCII-motion (asciifx.js): the station line DECODES out of glyph-static — the eerie register the
    // broadcast asks for (a signal resolving, never a party). scramble walks leaf text nodes only, so the
    // tinted agent-name span keeps its colour; it restores the exact text on completion; reduced-motion no-op.
    try { if (typeof AsciiFX !== 'undefined') AsciiFX.scramble(line, { duration: 700 }); } catch (_) {}
    return true;
  }
  // a compact tool-activity line in COMMS (▶ call / ◀ result) — the agent's real work, visible. Kept for
  // REPLAY (Channels stores pre-formatted strings) and for the ⏹ stop-reason line; the LIVE call/result path
  // now renders structured tool CHIPS (toolChip / resolveChip) instead. Ends any open chip rail first so the
  // stored line lands after the rail, not glued into it.
  function toolLine(text, isErr) {
    endToolRail();
    const r = row('agent'); r.d.classList.add('tool'); if (isErr) r.d.classList.add('err');
    r.body.textContent = text; autoscroll();
  }
  function brief(s) { s = String(s || ''); return s.length > 56 ? s.slice(0, 53) + '…' : s; }
  function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'; }   // 8423 → '8.4s'

  /* ── COMMS-PREMIUM · TOOL CHIPS ──────────────────────────────────────────────────────────────────────
     The agent's real actions render as compact one-line chips (glyph · tool name · short args) instead of
     the old "▶ toolname args" text lines. Consecutive chips in the same run group tightly into ONE thin
     activity rail (.tool-rail). When the result callback pairs to the call (by callId), the result FOLDS
     back into the same chip (✓/✗ + duration) rather than emitting a second line. Click toggles an expanded
     view (full args + result summary, length-capped). Cheap by design: a one-time fade-in per chip, no
     per-chip looping animation, and the expanded text is capped so a long run stays DOM-lean. */
  let toolRail = null;                 // the currently-open .tool-rail container (consecutive chips join it)
  let runRails = [];                   // every rail this run opened — folded under the resolved summary on run end
  const pendingChips = new Map();      // callId -> chip element awaiting its result (for call→result folding)
  const CHIP_CAP = 600;                // cap on stored expand text length — a long run must not bloat the DOM
  const cap = s => { s = String(s == null ? '' : s); return s.length > CHIP_CAP ? s.slice(0, CHIP_CAP) + '…' : s; };
  const shortName = n => String(n || 'tool').replace(/^mcp__/, '').replace(/_/g, '.');   // mcp__x__y → x.y, readable
  // A1: skill-flavored tool beats. The skill.* tools ride the ordinary agent.tool_call chip, but a raw
  // "skill.view {name:…}" reads as noise. Re-label them in the agent's own voice so the Commander SEES the
  // agent consulting/writing its skillbase — pure rendering over the existing event (no new bus traffic).
  //   skill.view  → consulting skill: <name>      skill.list   → scanning skill index
  //   skill.manage(create/edit/patch) → wrote skill <name> → SKILLS menu   (write actions only)
  // Returns { label, glyph } to override the chip head, or null for a non-skill / read-shaped call.
  function skillFlavor(ev) {
    const canon = shortName(ev && ev.name);   // skill_view / skill.view → skill.view
    if (canon.indexOf('skill.') !== 0) return null;
    const kind = canon.slice('skill.'.length);
    let args = {}; try { args = JSON.parse(ev.argsSummary || '{}') || {}; } catch (_) { args = {}; }
    const nm = String(args.name || args.target || '').trim();
    const nmTail = nm ? (': ' + brief(nm)) : '';
    if (kind === 'view' || kind === 'write' && !nm) return { label: 'consulting skill' + nmTail, glyph: '▤' };
    if (kind === 'list') return { label: 'scanning skill index', glyph: '▤' };
    if (kind === 'write') return { label: 'wrote skill' + (nm ? ' ' + brief(nm) : '') + ' → SKILLS menu', glyph: '✎' };
    if (kind === 'manage') {
      const action = String(args.action || '').toLowerCase();
      const WRITE = { create: 1, edit: 1, patch: 1, archive: 1, restore: 1, pin: 1, unpin: 1, write_file: 1, remove_file: 1 };
      if (WRITE[action]) {
        const verb = action === 'create' || action === 'edit' || action === 'patch' ? 'wrote skill' : action.replace(/_/g, ' ') + ' skill';
        return { label: verb + (nm ? ' ' + brief(nm) : '') + ' → SKILLS menu', glyph: '✎' };
      }
      return { label: 'tending the skillbase' + nmTail, glyph: '▤' };   // delete has no returned name; still legible
    }
    return null;
  }
  /* THE CHIP HEAD IS A LABEL, NOT A DUMP. It used to print `brief(argsSummary)` — the raw JSON the tool was
     called with, truncated at 56 characters, so a file write read
     `fs.write {"path":"q3-summary.md","content":"# Q3 summary\n\nTh…`: cut mid-token, mid-escape, and with the
     one word that matters (the filename) buried behind punctuation. This lifts the SALIENT argument instead.
     Nothing is hidden — the complete arguments are still one click away in .tc-d-args, verbatim. Purely a
     display digest: it never invents a value, and an unrecognised shape falls back to the old brief(). */
  const ARG_KEYS = ['path', 'file', 'filename', 'query', 'q', 'url', 'pattern', 'name', 'target', 'title', 'command', 'cmd', 'text', 'id'];
  /* SCAN, DON'T PARSE. The sidecar CAPS argsSummary (80 chars on the wire today), so what arrives is
     usually a truncated JSON prefix that no parser will accept — `JSON.parse` throwing is the common case,
     not the edge case. This walks the string for COMPLETE `"key": value` pairs instead: the value regex
     requires its closing quote, so a field the cap cut in half can never be shown as if it were whole. */
  const ARG_PAIR = /"([A-Za-z0-9_.-]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?|true|false))/g;
  function argPairs(raw) {
    const out = new Map();
    ARG_PAIR.lastIndex = 0;
    let m;
    while ((m = ARG_PAIR.exec(raw))) {
      const v = (m[2] !== undefined ? m[2] : m[3]);
      if (v == null) continue;
      // JSON escapes are display noise in a one-line chip head; a real newline would break the row.
      const clean = String(v).replace(/\\[nrt]/g, ' ').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
      if (clean && !out.has(m[1])) out.set(m[1], clean);
    }
    return out;
  }
  function argDigest(argsSummary) {
    const raw = String(argsSummary == null ? '' : argsSummary).trim();
    if (!raw) return '';
    const pairs = argPairs(raw);
    for (const k of ARG_KEYS) { const v = pairs.get(k); if (v) return brief(v); }
    if (pairs.size === 1) { const v = pairs.values().next().value; if (v) return brief(v); }
    return brief(raw);                                   // unrecognised shape → exactly the old behaviour
  }
  function ensureToolRail() {
    if (toolRail && toolRail.isConnected) return toolRail;
    clearEmptyState();
    toolRail = document.createElement('div'); toolRail.className = 'tool-rail';
    runRails.push(toolRail);   // remembered so resolvePresence can fold this run's machinery away
    log.appendChild(toolRail); autoscroll();
    return toolRail;
  }
  /* A BREAK CLOSES THE RAIL, IT DOES NOT ORPHAN THE CALLS IN FLIGHT (fixed 2026-08-05).
     This used to also `pendingChips.clear()`, and that quietly double-listed the work trail of every run
     that wrote a file. Order of events for one `fs.write`: the CALL opens a rail and registers its chip →
     the sidecar's `deliverable` event fires and calls breakLive() → endToolRail() wiped the map → the tool
     RESULT arrives, finds no pending chip, and takes resolveChip's ORPHAN path. The Commander was left
     with the same single call rendered twice, in two different rails: a `pending` chip stuck forever
     holding the raw arguments, and a second resolved chip that had lost them. Closing the rail only means
     "the next chip starts a new one"; a call stays pairable until its result lands or the next run
     starts (startPresence clears the map). */
  function endToolRail() { toolRail = null; }
  // one delegated toggle handler for the whole log's chips (wired once alongside the copy handler)
  function toggleChip(head) {
    const chip = head && head.closest && head.closest('.tool-chip'); if (!chip) return;
    const body = chip.querySelector('.tc-detail'); if (!body) return;
    const open = chip.classList.toggle('open');
    // aria-expanded lives on the .tc-head BUTTON (the operable control), not the wrapper div — AT reads the
    // disclosure state from the thing it can activate.
    const btn = chip.querySelector('.tc-head'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // render a tool CALL as a chip; returns the chip element. ev: { callId, name, argsSummary }
  function toolChip(ev) {
    const rail = ensureToolRail();
    const flav = skillFlavor(ev);   // A1: skill.* tools re-labelled in the agent's voice
    const chip = document.createElement('div'); chip.className = 'tool-chip pending' + (flav ? ' skill' : '');
    const head = document.createElement('button'); head.type = 'button'; head.className = 'tc-head';
    head.setAttribute('aria-expanded', 'false');   // the head IS the disclosure control (detail = its region)
    const glyph = document.createElement('span'); glyph.className = 'tc-glyph'; glyph.textContent = flav ? flav.glyph : '▸';
    const nm = document.createElement('span'); nm.className = 'tc-name'; nm.textContent = flav ? flav.label : shortName(ev.name);
    // for a flavored skill chip the human phrase already carries the skill name, so the raw args stay in the
    // expand detail only (kept below) — the chip head is clean.
    const args = document.createElement('span'); args.className = 'tc-args'; args.textContent = flav ? '' : argDigest(ev.argsSummary);
    const stat = document.createElement('span'); stat.className = 'tc-stat'; stat.textContent = '';   // filled by resolveChip
    if (/^browser\./.test(ev.name || '') && ev.runId) {
      stat.setAttribute('aria-live', 'polite');
      const checkWait = async () => {
        if (!chip.isConnected || !chip.classList.contains('pending')) return;
        try {
          const j = await Harness.api.get('/api/connectors');
          if (!chip.isConnected || !chip.classList.contains('pending')) return;
          stat.textContent = (j.browserSession?.waitingRunIds || []).includes(ev.runId) ? 'Waiting for browser session…' : '';
        } catch (_) { if (chip.classList.contains('pending')) stat.textContent = ''; }
        if (chip.isConnected && chip.classList.contains('pending')) setTimeout(checkWait, 1000);
      };
      setTimeout(checkWait, 500);
    }
    const exp = document.createElement('span'); exp.className = 'tc-exp'; exp.setAttribute('aria-hidden', 'true'); exp.textContent = '▸';   // disclosure chevron (rotates when open)
    head.appendChild(glyph); head.appendChild(nm); if (args.textContent) head.appendChild(args); head.appendChild(stat); head.appendChild(exp);
    const detail = document.createElement('div'); detail.className = 'tc-detail';
    const dArgs = document.createElement('div'); dArgs.className = 'tc-d-args';
    /* TRUTHFUL TELEMETRY: the sidecar caps argsSummary on the wire, so the expand was never showing the
       "full" arguments — it was showing a JSON prefix chopped mid-token, which reads as a malformed call
       the agent supposedly made. Say when the record is cut instead of letting the reader assume it isn't. */
    const argsCut = !!(ev.argsSummary && !(function () { try { JSON.parse(ev.argsSummary); return true; } catch (_) { return false; } })());
    dArgs.textContent = ev.argsSummary
      ? (cap(ev.argsSummary) + (argsCut ? '  … (arguments truncated in the run record)' : ''))
      : '(no arguments)';
    detail.appendChild(dArgs);
    chip.appendChild(head); chip.appendChild(detail);
    rail.appendChild(chip);
    if (ev.callId != null) { pendingChips.set(ev.callId, chip); if (pendingChips.size > 200) pendingChips.delete(pendingChips.keys().next().value); }
    autoscroll();
    return chip;
  }
  // fold a tool RESULT into its paired chip (✓/✗ + duration + result summary). ev: { callId, summary, isError, ms }
  function resolveChip(ev, fallbackName) {
    let chip = (ev.callId != null) ? pendingChips.get(ev.callId) : null;
    if (chip) pendingChips.delete(ev.callId);
    if (!chip) {
      // ORPHAN result (no paired call — e.g. switched-to mid-run): render a standalone resolved chip
      chip = toolChip({ callId: null, name: fallbackName || 'tool', argsSummary: '' });
    }
    chip.classList.remove('pending');
    chip.classList.add(ev.isError ? 'err' : 'ok');
    const glyph = chip.querySelector('.tc-glyph'); if (glyph) glyph.textContent = ev.isError ? '✗' : '✓';
    const stat = chip.querySelector('.tc-stat');
    if (stat) stat.textContent = ev.ms ? fmtMs(ev.ms) : (ev.isError ? 'failed' : '');
    const detail = chip.querySelector('.tc-detail');
    if (detail) {
      const dRes = document.createElement('div'); dRes.className = 'tc-d-res' + (ev.isError ? ' err' : '');
      dRes.textContent = (ev.isError ? '✗ ' : '✓ ') + cap(ev.summary || (ev.isError ? 'error' : 'ok'));
      detail.appendChild(dRes);
    }
    autoscroll();
    return chip;
  }
  // a clickable COMMS row for a file the agent produced — opens it via the sidecar's jailed /api/file route
  function fileBlobUrl(title, agentId) {
    const url = fileUrl(title, agentId);
    return fetch(url, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error('file HTTP ' + r.status);
      return r.blob();
    }).then(b => URL.createObjectURL(b));
  }
  // Wire an anchor to OPEN a workspace file. The href IS the real jailed /api/file URL (query-token
  // auth — apiauth's documented native-load escape hatch, since a link navigation cannot attach the
  // custom header), so in a browser this is a TRUE link: left-click opens the tab natively and
  // right-click → open-in-new-tab / copy-link-address work. The old wiring (href='#' + fetch→blob→
  // window.open AFTER an async fetch) was a silent no-op everywhere it mattered: popup blockers kill a
  // post-async window.open, the desktop Tauri window policy kills it always, and right-click opened '#'.
  // On desktop a _blank navigation is equally dead under that policy (the same law as the delegated
  // prose-link handler in init), so hand the saved path to the OS default app. If native opening rejects
  // the path or file type, the jailed browser preview remains a safe fallback. stopPropagation prevents
  // the delegated prose-link handler from opening it a second time.
  function wireFileOpen(a, title, agentId) {
    a.href = fileUrl(title, agentId);
    a.target = '_blank'; a.rel = 'noopener';
    const core = tauriCore();
    if (core && core.invoke) {
      a.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (window.getSelection && String(window.getSelection())) return;   // a drag-selection release is not an open (the delegated handler's SELECTION GUARD law)
        Promise.resolve(core.invoke('starnet_open_artifact', { path: String(title || ''), agentId: agentId || 'agent' }))
          .catch(err => {
            // The host shows a native confirm before any OS launch (renderer clicks are not host
            // gestures). Cancel there is an ANSWER, not a failure — never fall back around it.
            if (/declined at the host/i.test(String(err || ''))) return;
            return Promise.resolve(core.invoke('open_external_url', { url: a.href }))
              .catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open that file — use folder or copy path to find it on disk', 'warn'); });
          });
      });
    }
  }

  /* ── IMAGE LIGHTBOX ─ clicking any COMMS image (sent attachment, staged composer attachment, agent image
     deliverable) enlarges it IN-APP over everything else; click the backdrop, the ×, or Esc to leave. One
     instance at a time. Esc is caught on document CAPTURE with stopPropagation so it dismisses the lightbox
     only — it must never fall through to the window-level Esc handler and close COMMS underneath the viewer. */
  let lightbox = null;   // { root, onKey, revokeUrl } while open
  function closeLightbox() {
    if (!lightbox) return;
    const lb = lightbox; lightbox = null;
    document.removeEventListener('keydown', lb.onKey, true);
    // blob URLs fetched FOR the lightbox are freed with it (the decoded thumbnail elsewhere keeps its own)
    if (lb.revokeUrl) { try { URL.revokeObjectURL(lb.revokeUrl); } catch (_) {} }
    lb.root.remove();
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
  }
  // `load` -> Promise<objectURL>; opts.revoke says the URL is ours to free on close (false for a staged
  // attachment's localUrl, which renderAttachStrip still owns and revokes on remove/clear).
  function openLightbox(load, name, opts) {
    closeLightbox();
    const root = document.createElement('div'); root.className = 'comms-lightbox';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Enlarged image: ' + name);
    const fig = document.createElement('figure'); fig.className = 'lb-frame loading';
    const img = document.createElement('img'); img.alt = name; img.decoding = 'async';
    const cap = document.createElement('figcaption'); cap.className = 'lb-name'; cap.textContent = name; cap.title = name;
    fig.appendChild(img); fig.appendChild(cap);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'lb-close';
    x.textContent = '×'; x.title = 'close'; x.setAttribute('aria-label', 'Close enlarged image');
    root.appendChild(fig); root.appendChild(x);
    // click-OUT closes; clicks on the image/caption/frame do not (so a viewer can't lose it by mis-clicking)
    root.addEventListener('click', ev => { if (ev.target === root) closeLightbox(); });
    x.onclick = closeLightbox;
    const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeLightbox(); } };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    x.focus();
    lightbox = { root, onKey, revokeUrl: '' };
    const mine = lightbox;
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    Promise.resolve().then(load).then(u => {
      if (lightbox !== mine) {   // closed (or replaced) before the bytes arrived — free a URL we now own
        if (opts && opts.revoke) { try { URL.revokeObjectURL(u); } catch (_) {} }
        return;
      }
      if (opts && opts.revoke) mine.revokeUrl = u;
      img.addEventListener('load', () => fig.classList.remove('loading'), { once: true });
      img.addEventListener('error', () => { if (lightbox === mine) closeLightbox(); }, { once: true });
      img.src = u;
    }).catch(() => {
      if (lightbox === mine) closeLightbox();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not load that image — the sidecar may be unreachable', 'warn');
    });
  }
  // wire an image thumb in the transcript: click enlarges via the jailed /api/file route (fresh blob each
  // view — the thumbnail's own object URL was already revoked after its bitmap decoded).
  function wireLightbox(a, rel, aid, name) {
    a.href = '#';
    a.addEventListener('click', ev => { ev.preventDefault(); openLightbox(() => fileBlobUrl(rel, aid), name, { revoke: true }); });
  }

  // ── "OPEN FOLDER" AFFORDANCE (Theme 4: outputs are findable) ──────────────────────────────────
  // A deliverable landed on disk in the agent's workspace; a beginner needs to be able to FIND it.
  // The absolute per-agent dir comes from the additive /api/workspace/dir route (the frontend otherwise
  // only knows the relative filename). Desktop reveals the exact artifact through the native shell and
  // falls back to copying that exact path if the shell refuses it. A plain browser cannot reveal a local
  // folder, so its button says and does "copy path". Truthful: the button does exactly what
  // its label says — it never claims to open a folder it can't.
  const _wsDirCache = new Map();   // agentId -> Promise<absolute dir | ''>
  function workspaceDir(agentId) {
    const aid = agentId || 'agent';
    if (_wsDirCache.has(aid)) return _wsDirCache.get(aid);
    const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
    const p = fetch('/api/workspace/dir?agent=' + encodeURIComponent(aid) + (tok ? '&token=' + encodeURIComponent(tok) : ''), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(j => (j && j.dir) ? String(j.dir) : '').catch(() => '');
    _wsDirCache.set(aid, p);
    return p;
  }
  function tauriCore() {
    return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  }
  function isAbsoluteArtifactPath(p) {
    return /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(String(p || ''));
  }
  function absoluteArtifactPath(agentId, artifactPath) {
    const raw = String(artifactPath || '');
    if (isAbsoluteArtifactPath(raw)) return Promise.resolve(raw);
    return workspaceDir(agentId).then(dir => {
      if (!dir) return '';
      const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
      return dir.replace(/[\\/]+$/, '') + sep + raw.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
    });
  }
  function resetFeedbackLabel(btn) {
    const lbl = btn.querySelector('.fb-label');
    if (lbl) lbl.textContent = btn.getAttribute('data-default-label') || 'folder';
  }
  function copyArtifactPath(btn, agentId, artifactPath) {
    return absoluteArtifactPath(agentId, artifactPath).then(abs => {
      const lbl = btn.querySelector('.fb-label');
      if (!abs) {
        if (lbl) lbl.textContent = 'no path';
        setTimeout(() => resetFeedbackLabel(btn), 1600);
        return false;
      }
      return copyText(abs).then(ok => {
        if (lbl) lbl.textContent = ok ? 'path copied' : abs;
        setTimeout(() => resetFeedbackLabel(btn), 1600);
        return ok;
      });
    });
  }
  function copyPathButton(agentId, artifactPath) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deliverable-folder deliverable-copy-path';
    b.setAttribute('data-default-label', 'copy path');
    b.appendChild(document.createTextNode('⧉'));
    const lbl = document.createElement('span'); lbl.className = 'fb-label'; lbl.textContent = 'copy path'; b.appendChild(lbl);
    b.title = 'copy the full saved path';
    b.addEventListener('click', () => copyArtifactPath(b, agentId, artifactPath));
    return b;
  }
  // Resolve from the deliverable's own path so an authorized custom output location reveals correctly.
  function folderButton(agentId, relPath) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deliverable-folder';
    b.appendChild(glyphSpan(SVG_FOLDER));
    const desktop = !!tauriCore();
    const defaultLabel = desktop ? 'folder' : 'copy path';
    b.setAttribute('data-default-label', defaultLabel);
    const lbl = document.createElement('span'); lbl.className = 'fb-label'; lbl.textContent = defaultLabel; b.appendChild(lbl);
    b.title = desktop ? 'reveal this saved file in its folder' : 'copy the full saved path';
    b.addEventListener('click', () => {
      const core = tauriCore();
      if (core && core.invoke) {
        Promise.resolve(core.invoke('starnet_reveal_path', { path: String(relPath || ''), agentId: agentId || 'agent' })).then(() => {
          lbl.textContent = 'opened'; setTimeout(() => resetFeedbackLabel(b), 1400);
        }).catch(err => {
          if (/declined at the host/i.test(String(err || ''))) { resetFeedbackLabel(b); return; }   // native-prompt Cancel: no reveal, no clipboard fallback
          copyArtifactPath(b, agentId, relPath);
        });
      } else copyArtifactPath(b, agentId, relPath);
    });
    return b;
  }
  function deliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable');
    r.body.appendChild(document.createTextNode('▤ saved '));
    const a = document.createElement('a');
    wireFileOpen(a, title, agentId);
    a.textContent = String(title).split(/[\\/]/).pop() || title;   // show the filename, not the whole path
    a.title = title;                                               // full path on hover
    a.className = 'deliverable-link';
    r.body.appendChild(a);
    r.body.appendChild(folderButton(agentId, title));             // reveal the exact saved location
    if (tauriCore()) r.body.appendChild(copyPathButton(agentId, title));
    autoscroll();
  }
  // an image the agent generated (image_generate / the `studio` capability) — render it INLINE as a small
  // thumbnail (src = the sidecar's jailed /api/file viewer URL, served with an image content-type); clicking
  // opens the full image in a new tab. Built with DOM nodes (never innerHTML) so the title can't inject markup.
  function imageDeliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable'); r.d.classList.add('image');
    r.body.appendChild(document.createTextNode('▤ made '));
    const a = document.createElement('a');
    const shortName = String(title).split(/[\\/]/).pop() || title;
    wireLightbox(a, title, agentId, shortName);   // click enlarges in-app (Esc / click-out / × to leave)
    a.className = 'deliverable-thumb';
    a.title = title;                                               // full path on hover
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = shortName;
    a.appendChild(img);
    r.body.appendChild(a);
    fileBlobUrl(title, agentId).then(u => {
      img.src = u;
      // once the <img> has decoded (or failed) it no longer needs the object URL — the decoded bitmap
      // survives revocation, so the thumbnail keeps rendering. Revoke to avoid leaking one URL per image
      // deliverable on a long-running station (mirrors voice.js freeing its audio blob after use).
      const free = () => { try { URL.revokeObjectURL(u); } catch (_) {} };
      img.addEventListener('load', free, { once: true });
      img.addEventListener('error', free, { once: true });
    }).catch(() => {});
    autoscroll();
  }
  // CLIENT-SIDE MEDIA KIND, keyed off the file extension (the reference harness's extension-keyed media model): the backend doesn't
  // declare "this is a video" — we decide from the path, so any .mp4 an agent writes/downloads renders as a
  // player with zero backend wiring. Unknown extensions fall through to 'file' (the plain clickable row).
  const MEDIA_KIND_BY_EXT = {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
    mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
    mp3: 'audio', m4a: 'audio', ogg: 'audio', wav: 'audio', flac: 'audio', opus: 'audio'
  };
  function mediaKindOf(title) {
    const ext = String(title || '').split(/[?#]/, 1)[0].split('.').pop().toLowerCase();
    return MEDIA_KIND_BY_EXT[ext] || 'file';
  }
  // The jailed /api/file URL for a workspace file — usable as a REAL href/src, not just inside fetch().
  // Token: the SYNC injected global (the same value Harness.apiToken() RESOLVES to — apiToken() itself
  // returns a Promise, and the old String(promise) baked `token=[object Promise]` into the query, a
  // guaranteed 403 on any native load that can't ride the header shim). Base: on desktop the page runs
  // on the tauri.localhost origin and the shell rewrites ONLY window.fetch to the sidecar — a relative
  // href would navigate into the bundled-asset protocol and vanish (the same trap cloudsave's unload
  // beacon hit), so native loads carry the ABSOLUTE loopback base (window.__STARNET_API__); in a
  // browser the base is '' and the URL stays same-origin relative.
  function fileUrl(title, agentId) {
    let base = '', tok = '';
    try { base = (typeof window !== 'undefined' && window.__STARNET_API__) ? String(window.__STARNET_API__) : ''; } catch (_) {}
    try { tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : ''; } catch (_) {}
    return base + '/api/file?agent=' + encodeURIComponent(agentId || 'agent') +
      '&path=' + encodeURIComponent(title) +
      (tok ? '&token=' + encodeURIComponent(tok) : '');
  }
  // append a small "open in a new tab" fallback link — shown when an inline player can't decode the file
  // (e.g. an .mkv/.avi the browser won't play), mirroring the reference harness's OpenMediaButton.
  // Always a real /api/file link (re-served with Range support), never the player's blob URL: a blob href
  // is dead on desktop (the Tauri window policy) and dies with the page.
  function openFallback(parent, label, title, agentId) {
    if (parent.querySelector('.media-fallback')) return;   // once
    const a = document.createElement('a');
    a.className = 'deliverable-link media-fallback';
    wireFileOpen(a, title, agentId);
    a.textContent = label; a.title = title;
    parent.appendChild(a);
  }
  // a media deliverable rendered INLINE as a seekable player. The src is the jailed /api/file route, which
  // now streams with HTTP Range so <video>/<audio> can seek without loading the whole file. preload=metadata
  // fetches just enough for a duration + scrubber. On a decode error we drop in an open-externally link.
  function mediaPlayerLine(title, agentId, kind) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable'); r.d.classList.add(kind);
    const name = String(title).split(/[\\/]/).pop() || title;
    r.body.appendChild(document.createTextNode('▤ made '));
    const cap = document.createElement('span'); cap.className = 'media-name'; cap.textContent = name; cap.title = title;
    r.body.appendChild(cap);
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.controls = true; el.preload = 'metadata'; el.className = 'deliverable-' + kind;
    let blobUrl = '';
    el.addEventListener('error', () => openFallback(r.body, 'open ' + kind, title, agentId), { once: true });
    r.body.appendChild(el);
    // a <video>/<audio> keeps needing its object URL for the WHOLE row lifetime (seek/replay re-read it, and
    // the error fallback links to it), so we don't revoke on load here. But free any prior URL before we
    // replace it (defensive against a double-resolve leaking the first one) — the general revoke-before-
    // replace discipline every other createObjectURL site follows.
    fileBlobUrl(title, agentId).then(u => {
      if (blobUrl && blobUrl !== u) { try { URL.revokeObjectURL(blobUrl); } catch (_) {} }
      blobUrl = u; el.src = u;
    }).catch(() => openFallback(r.body, 'open ' + kind, title, agentId));
    autoscroll();
  }

  /* ── END-OF-RUN RECAP (work-visibility slice 1) — a passive REPORT card in the run's own message flow.
     On run end we fetch the run's recorded outcome (GET /api/runs?agent=&runId= — the sidecar's append-only
     artifacts ledger, recorded by runOnce) and, ONLY when the run produced artifacts or ended abnormally,
     render ONE compact work-log card: an outcome line (title/reason), the artifact list, and cost + duration
     + model. It is NOT an ask: it never touches the single post-run beat slot (no clearNudge, no .turnin /
     .nudge class, nothing the beat guards match) and it stays in the log like tool lines do — no vanish().
     A quiet artifact-less clean finish renders nothing: the existing reply/⏹ flow already said everything. */
  function fmtRecapCost(entry) {
    if (entry.unmetered) return 'subscription';
    const v = Number(entry.usd) || 0;
    if (v <= 0) return '';                                   // a free/unpriced run shows no fake $0
    return U.usd(v);                                         // canonical spend formatter (util.js)
  }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function recapArtifactLine(a, agentId, runId) {
    const d = document.createElement('div'); d.className = 'recap-line';
    if (a.kind === 'message') { d.textContent = '✉ sent to ' + (a.target || 'a channel'); return d; }
    const path = String(a.path || '');
    // already announced inline a few lines up → this is the LEDGER entry, not a second action row.
    const echo = deliverableAlreadyShown(runId, path);
    d.appendChild(document.createTextNode(a.kind === 'image' ? '▤ made ' : '▤ wrote '));
    const link = document.createElement('a');
    wireFileOpen(link, path, agentId);                       // the same jailed /api/file open every deliverable row uses
    link.className = 'deliverable-link';
    link.textContent = path.split(/[\\/]/).pop() || path;    // filename shown, full path on hover
    link.title = path;
    d.appendChild(link);
    if (typeof a.bytes === 'number' && a.bytes >= 0) d.appendChild(document.createTextNode(' — ' + fmtBytes(a.bytes)));
    if (echo) return d;   // the copy + folder buttons are already on the inline row above — one set, not two
    // Copy the authoritative absolute path, not the model-facing relative workspace path.
    d.appendChild(copyPathButton(agentId, path));
    // Reveal the exact artifact so a custom output path selects the right file instead of opening the
    // default AppData workspace root.
    if (a.kind !== 'message') d.appendChild(folderButton(agentId, path));
    return d;
  }
  const RECAP_MAX_ROWS = 12;   // a monster run lists the first dozen + a "+N more" note (the RUNS panel has the rest)
  function recapCard(entry, arts, agentId, durMs, runId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('recap');
    const done = (entry.reason || 'done') === 'done';
    const head = document.createElement('div'); head.className = 'recap-line recap-head';
    head.textContent = (done ? '◈ delivered' : '◈ ended: ' + entry.reason) + (entry.title ? ' — ' + brief(entry.title) : '');
    r.body.appendChild(head);
    for (const a of arts.slice(0, RECAP_MAX_ROWS)) r.body.appendChild(recapArtifactLine(a, agentId, runId));
    if (arts.length > RECAP_MAX_ROWS) {
      const more = document.createElement('div'); more.className = 'recap-line';
      more.textContent = '… +' + (arts.length - RECAP_MAX_ROWS) + ' more';
      r.body.appendChild(more);
    }
    const foot = document.createElement('div'); foot.className = 'recap-line recap-foot';
    foot.textContent = [fmtRecapCost(entry), durMs > 0 ? fmtMs(durMs) : '', (entry.model && entry.model !== '(unknown)') ? entry.model : ''].filter(Boolean).join(' · ');
    if (foot.textContent) r.body.appendChild(foot);
    autoscroll();
  }

  function runCallCount(entry) {
    return Array.isArray(entry && entry.toolTrace) ? entry.toolTrace.length : Math.max(0, Number(entry && entry.toolsOk) || 0);
  }
  /* SAY IT ONCE. The fold already holds this run's tool CHIPS — the same calls, with their arguments, their
     result summaries and an expand. Emitting the persisted ↳ rows next to them listed every call a second
     time, in a third vocabulary (the persisted `fs_write` beside the chip's `fs.write`), so a one-call run
     read as a busy machine log. When chips are present the LEAD block keeps only its header — the identity,
     duration and call count, which the chips genuinely do not carry. WORKER blocks always keep their rows:
     a dispatched worker's calls never produced chips on this stream, so those lines are the only record of
     them. The suppression is conditioned on chips ACTUALLY being in this fold rather than assumed: today
     hydrateRunTelemetry only ever runs at run end on the displayed stream, so in practice the lead rows are
     always the duplicate — but a fold without chips still gets the full listing rather than losing the
     record. (Do not read this as a reload guarantee: the fold and its telemetry are DOM-only and do not
     survive a reload or a stream switch at all — replayChannel rebuilds the chips, nothing rebuilds these.) */
  function telemetryRun(entry, role, skipTools) {
    const wrap = document.createElement('div'); wrap.className = 'rt-run';
    const calls = runCallCount(entry);
    const head = document.createElement('div'); head.className = 'rt-run-head';
    head.textContent = [role, entry.agentId || '', entry.model && entry.model !== '(unknown)' ? entry.model : '', (entry.reasoningEffort && entry.reasoningEffort !== 'none') ? entry.reasoningEffort : '', Number(entry.durationMs) > 0 ? fmtMs(Number(entry.durationMs)) : '', calls + (calls === 1 ? ' call' : ' calls')].filter(Boolean).join(' · ');
    wrap.appendChild(head);
    for (const t of (skipTools ? [] : (Array.isArray(entry.toolTrace) ? entry.toolTrace : []))) {
      const line = document.createElement('div'); line.className = 'rt-tool' + (t.isError ? ' err' : '');
      line.textContent = '↳ ' + String(t.name || 'unknown') + ' · ' + fmtMs(Math.max(0, Number(t.ms) || 0)) + ' · ' + (t.isError ? 'failed' : 'ok');
      if (t.summary) line.title = String(t.summary);
      wrap.appendChild(line);
    }
    return wrap;
  }
  function hydrateRunTelemetry(ws, entry, runId) {
    if (!isActiveWs(ws) || !log) return;
    const card = Array.from(log.querySelectorAll('.comms-presence.resolved[data-run-id]')).find(c => c.dataset.runId === runId);
    if (!card) return;
    const children = Array.isArray(entry.children) ? entry.children : [];
    const leadCalls = runCallCount(entry);
    const workerCalls = children.reduce((n, child) => n + runCallCount(child), 0);
    const sum = card.querySelector('.cp-sum');
    if (sum) {
      const label = String(sum.textContent || '').split(' · ')[0];
      const bits = [];
      if (Number(entry.durationMs) > 0) bits.push(fmtMs(Number(entry.durationMs)));
      bits.push(leadCalls + ' lead ' + (leadCalls === 1 ? 'call' : 'calls'));
      if (children.length) bits.push(workerCalls + ' worker ' + (workerCalls === 1 ? 'call' : 'calls'));
      const identity = [entry.model && entry.model !== '(unknown)' ? entry.model : '', (entry.reasoningEffort && entry.reasoningEffort !== 'none') ? entry.reasoningEffort : ''].filter(Boolean).join(' ');
      if (identity) bits.push(identity);
      sum.textContent = label + (bits.length ? ' · ' + bits.join(' · ') : '');
    }
    let fold = card.nextElementSibling;
    if (!fold || !fold.classList.contains('run-fold')) {
      fold = document.createElement('div'); fold.className = 'run-fold'; fold.hidden = true;
      card.parentNode.insertBefore(fold, card.nextSibling);
    }
    const old = fold.querySelector('.run-telemetry'); if (old) old.remove();
    const detail = document.createElement('div'); detail.className = 'run-telemetry';
    // chips for THIS run already in the fold? then the lead's per-tool rows would just repeat them.
    const hasChips = !!fold.querySelector('.tool-chip');
    detail.appendChild(telemetryRun(entry, 'lead', hasChips));
    children.forEach(child => detail.appendChild(telemetryRun(child, 'worker')));
    fold.appendChild(detail);
    if (!card.querySelector('.cp-chev')) {
      const chev = document.createElement('span'); chev.className = 'cp-chev'; chev.setAttribute('aria-hidden', 'true'); chev.textContent = '▸'; card.appendChild(chev);
    }
    bindPresenceFold(card, fold);
    card.dataset.telemetry = '1';
    autoscroll();
  }

  async function renderRunRecap(ws, runId, durMs) {
    try {
      const agentId = ws.agentId || 'agent';
      const res = await fetch('/api/runs?agent=' + encodeURIComponent(agentId) + '&runId=' + encodeURIComponent(runId), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      const entry = (j && Array.isArray(j.runs)) ? j.runs.find(x => x && x.runId === runId) : null;
      if (!entry) return;                                              // truthful: no recorded entry, no recap
      hydrateRunTelemetry(ws, entry, runId);                            // clean runs still expose persisted lead + worker facts
      const arts = Array.isArray(entry.artifacts) ? entry.artifacts : [];   // a legacy row fails open to []
      if (!arts.length && (entry.reason || 'done') === 'done') return;      // quiet clean finish — leave the flow untouched
      if (!isActiveWs(ws)) return;   // the work-log register renders on the on-screen stream only, same as tool lines
      // POST-RUN DEDUPE: this recap card IS the run's ledger — its foot carries cost · duration · model and its
      // rows carry the artifacts. So the resolved presence line above it should stop repeating those numbers:
      // collapse it to just its terse status label (■ RUN COMPLETE), letting the recap own the metrics.
      foldPresenceIntoRecap();
      recapCard(entry, arts, agentId, durMs, runId);
    } catch (_) { /* the recap is best-effort — it must never disturb the turn teardown */ }
  }

  // a live consent prompt: the agent wants to do something that needs approval (a file write today). The run is
  // PAUSED on the sidecar until the Commander answers — once / always (this kind) / full access (everything this
  // session) / deny. Answering resumes the stream automatically.
  function actionPhrase(ev) {
    const t = ev.tool || 'act';
    if (/notebook/.test(t)) return 'save a note to its memory';
    if (/summon/.test(t)) return 'summon a new agent onto the crew' + (ev.argsSummary ? ' (' + ev.argsSummary + ')' : '');
    // NS-5 conversational path trust: a file was referenced OUTSIDE the agent's workspace — "Always" blesses
    // the whole project folder for future reads (revocable in Permissions); argsSummary is the proposed root.
    if (t === 'path.trust') return 'work with files in ' + (ev.argsSummary || 'a project folder') + ' (reads; "Always" or "Full access" trusts it for later)';
    // ATTENDED BROWSER LOGIN: two-phase takeover. Phase 1 asks to open a visible Chrome window the COMMANDER
    // drives; phase 2 holds the run until they click Done. Password honesty is part of the card copy.
    if (t === 'browser.login') return 'open a browser window so YOU can log in to ' + (ev.argsSummary || 'a website') + ' (you type your password in that window — the agent never sees it)';
    if (t === 'browser.login.done') return 'wait while you log in to ' + (ev.argsSummary || 'the website') + ' in the browser window — click Done here when you\'ve finished';
    if (/^fs[._](?:write|append|edit|patch)$/.test(t)) {
      let target = ev.argsSummary || 'a file';
      try { target = JSON.parse(target).path || 'a file'; } catch (_) {}
      return 'change ' + target;
    }
    if (/write|append|edit/.test(t)) return 'write ' + (ev.argsSummary || 'a file');
    if (t === 'brief.ask') return 'ask you a quick question about the task';   // clarify card renders its own body
    return t.replace(/_/g, '.') + (ev.argsSummary ? ' ' + ev.argsSummary : '');
  }

  /* IN-TURN CLARIFY CARD (2026-07-31, Hermes-parity). A brief.ask prompt rides the consent transport but is
     a QUESTION, not a permission grade — approve/deny buttons would be a lie. Renders the question with the
     same one-tap choice chips the end-run TASK_QUESTION card uses (★ = the agent's recommended option, plus
     the standing "use your judgment" skip), and answers via POST /api/consent/answer so the SAME turn
     resumes with the decision — the run never ends. Ignoring the card is safe: the sidecar's fail-closed
     timer falls back to today's durable end-run question. Joins the consent card's lifecycle contract:
     decided chips vanish into a verdict tag, pending-span bookkeeping excludes the wait from run time, and
     focus is never stolen from a mid-typing Commander. */
  function clarifyRow(p, ws) {
    let q = { question: '', options: [], recommended: '', reason: '', multiSelect: false, ordinal: 0, total: 0 };
    try { q = Object.assign(q, JSON.parse(p.argsSummary || '{}')); } catch (_) {}
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent');
    if(q.mode==='conversation' && typeof TaskConversation!=='undefined') {
      const rid=ws && Channels.runIdOf(ws.id);
      TaskConversation.mount(r.body,q,async text=>{
        const result=await Harness.consentAnswer(rid,p.promptId,text,true);
        if(!result || !result.ok)return false;
        if(ws)Channels.clearPending(ws.id,Date.now());
        if(isActiveWs(ws)){renderPresence();syncStatus();}
        return true;
      });
      status('awaiting your context…');autoscroll();return;
    }
    // A batched ask shows its place ("asks (2 of 3)") so the Commander knows one more tap ends it —
    // three unannounced sequential cards would read as an interrogation with no visible bottom.
    const seq = (Number(q.total) > 1 && Number(q.ordinal) > 0) ? ' (' + q.ordinal + ' of ' + q.total + ')' : '';
    r.body.appendChild(document.createTextNode('▣ ' + name + ' asks' + seq + ': ' + (q.question || 'which way should this go?') + ' '));
    // TWO KINDS of suggestion, and the same law the end-run card obeys: GROUNDED comes from the
    // Commander's own answered history (>=2 times) and is PROVABLE, so it outranks the model's guess and
    // states its count; `recommended` is a guess with a rationale and stands only when nothing was observed.
    const gOpts = (q.grounded && Array.isArray(q.grounded.options)) ? q.grounded.options.filter(o => (q.options || []).indexOf(o) >= 0) : [];
    const gCount = Number(q.grounded && q.grounded.count) || 0;
    const useGrounded = gOpts.length > 0 && gCount >= 2;
    const starred = useGrounded ? gOpts : ((q.recommended && (q.options || []).indexOf(q.recommended) >= 0) ? [q.recommended] : []);
    if (useGrounded) {
      const g = document.createElement('div'); g.className = 'tq-reason grounded';
      g.textContent = gOpts.length > 1
        ? '★ you usually pick these — ' + gOpts.join(', ') + ' (chosen ' + gCount + '+ times before)'
        : '★ suggested: ' + gOpts[0] + ' — you chose this ' + gCount + ' times before';
      r.body.appendChild(g);
    } else if (q.reason) {
      const why = document.createElement('div'); why.className = 'dim'; why.textContent = q.reason;
      r.body.appendChild(why);
    }
    const isStar = (opt) => starred.indexOf(opt) >= 0;
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false;
    function answer(text, doneLabel) {
      if (decided) return; decided = true;
      const rid = (ws && typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : null;
      Harness.consentAnswer(rid, p.promptId, text);
      if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now());   // the wait never counts as run time
      if (isActiveWs(ws)) renderPresence();
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result'; tag.textContent = doneLabel;
      r.body.appendChild(tag);
      syncStatus();
    }
    const opts = Array.isArray(q.options) ? q.options.slice(0, 6) : [];
    if (q.multiSelect === true && opts.length > 1) {
      // NON-EXCLUSIVE options: chips toggle, a confirm chip fires. The answer is the Commander's picks
      // joined as plain text — a typed multi-answer was always legal downstream, so the store and the
      // model see exactly what free text would have said.
      const hint = document.createElement('div'); hint.className = 'dim';
      hint.textContent = 'pick all that apply, then confirm';
      r.body.appendChild(hint);
      const picked = new Set();
      const done = document.createElement('button');
      const syncDone = () => { done.textContent = picked.size ? ('✔ confirm ' + picked.size + ' pick' + (picked.size > 1 ? 's' : '')) : '✔ confirm'; done.disabled = !picked.size; };
      for (const opt of opts) {
        const b = document.createElement('button');
        b.className = 'consent-btn';
        b.textContent = (isStar(opt) ? '★ ' : '') + opt;
        b.setAttribute('aria-pressed', 'false');
        // The fill alone did not read as ON against this card's own gradient (caught in the shot review) —
        // a toggle must be legible as state, not as a hover. The ✓ carries it in every theme.
        const face = (on) => { b.textContent = (on ? '✓ ' : '') + (isStar(opt) ? '★ ' : '') + opt; };
        b.onclick = () => {
          const on = !picked.has(opt);
          if (on) picked.add(opt); else picked.delete(opt);
          b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
          face(on); syncDone();
        };
        btns.appendChild(b);
      }
      done.className = 'consent-btn consent-confirm';
      syncDone();
      done.onclick = () => { if (!picked.size) return; const list = opts.filter(o => picked.has(o)); answer(list.join(', '), '✓ ' + list.join(', ')); };
      btns.appendChild(done);
    } else {
      for (const opt of opts) {
        const b = document.createElement('button');
        b.className = 'consent-btn';
        b.textContent = (isStar(opt) ? '★ ' : '') + opt;
        b.onclick = () => answer(opt, '✓ ' + opt);
        btns.appendChild(b);
      }
    }
    const skip = document.createElement('button');
    skip.className = 'consent-btn';
    skip.textContent = 'use your judgment';
    skip.onclick = () => answer('use your judgment', '✓ your call');
    btns.appendChild(skip);
    // BATCH-WIDE ESCAPE: opting out of a 3-question batch cost 3 taps, which is the wrong ratio for the
    // person the batch exists to spare. One tap hands back every remaining decision. Only offered while
    // questions actually remain — on the last one it would be a second button meaning the same thing.
    if (Number(q.total) > 1 && Number(q.ordinal) > 0 && Number(q.ordinal) < Number(q.total)) {
      const rest = document.createElement('button');
      rest.className = 'consent-btn quiet';
      const left = Number(q.total) - Number(q.ordinal) + 1;
      rest.textContent = 'use your judgment for the rest (' + left + ')';
      rest.title = 'decide this and the remaining ' + (left - 1) + ' yourself — the run keeps going';
      rest.onclick = () => answer('use your judgment for the rest', '✓ your call on all ' + left);
      btns.appendChild(rest);
    }
    r.body.appendChild(btns);
    // Esc = "use your judgment": the reflexive dismiss defers the decision rather than silently denying a
    // question (a deny makes no sense here), matching the end-run card's skip chip semantics.
    r.d.tabIndex = -1;
    r.d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); answer('use your judgment', '✓ your call'); } });
    status('awaiting your answer…');
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' has a quick question for you', 'warn', 'needsApproval');
    autoscroll();
    const composerBusy = !!(input && (document.activeElement === input || (input.value && input.value.trim())));
    if (!composerBusy) { try { r.d.focus({ preventScroll: true }); } catch (_) { try { r.d.focus(); } catch (_) {} } }
  }
  // p = a consent payload { promptId, tool, argsSummary } — works for both a live onPermission event and a
  // Channels snapshot.pending (re-rendered after a switch). ws is the origin stream, so the answer routes to
  // THAT stream's run (per-channel runId), not a single global one.
  function permissionRow(p, ws) {
    if (p && p.tool === 'brief.ask') return clarifyRow(p, ws);   // a question, not a grade — its own card
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent');
    r.body.appendChild(document.createTextNode('▣ ' + name + ' wants to ' + actionPhrase(p) + ' '));
    if (/^fs[._](?:write|append|edit|patch)$/.test(String(p.tool || ''))) {
      const detail = document.createElement('details'); detail.className = 'consent-payload';
      const label = document.createElement('summary'); label.textContent = 'Inspect proposed change (secret patterns redacted)';
      const payload = document.createElement('pre'); payload.textContent = p.argsSummary || '(payload unavailable)';
      detail.appendChild(label); detail.appendChild(payload); r.body.appendChild(detail);
    }
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false;
    async function decide(decision, doneLabel, isDeny) {
      if (decided) return; decided = true;
      for (const b of btns.querySelectorAll('button')) b.disabled = true;
      const rid = (ws && typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : null;
      const answer = await Harness.consent(rid, p.promptId, decision);
      const appliedDecision = (answer && answer.decision) || 'deny';
      if (decision === 'full') {
        const saved = !!(answer && answer.ok && answer.approvalMode === 'full');
        const adopted = saved && typeof App !== 'undefined' && App.setApproval
          ? App.setApproval((answer && answer.agentId) || p.agentId || (ws && ws.agentId), 'full')
          : false;
        if (!saved || !adopted) { doneLabel = '✕ full access was not saved'; isDeny = true; }
      } else if (appliedDecision === 'deny' && decision !== 'deny') {
        doneLabel = '✕ approval was not applied'; isDeny = true;
      }
      // surface the decision on the bus (schema: permission.response) so listeners — e.g. the first-run tutorial —
      // can tell an approve from a deny and narrate the consent loop honestly. Additive; the run resumes via Harness.consent.
      try { if (typeof U !== 'undefined' && U.bus) U.bus.emit('permission.response', { promptId: p.promptId, decision: appliedDecision }); } catch (_) {}
      // NS conversational anchor: "Always" — and now "Full access" — on a path.trust card IS the project bless
      // (a standing path grant + known-projects row land on the sidecar). Stamp the origin session's projectRoot
      // with the SAME proposed root so the PROJECTS rail lists this session under its project — the identical
      // anchor "Work here" stamps. Both standing grades, never "once" (it grants nothing standing, so there is
      // no project row to attach to), and never overwrite an anchor the session already has.
      if (p.tool === 'path.trust' && (appliedDecision === 'always' || appliedDecision === 'full') && ws && typeof Workstreams !== 'undefined' && Workstreams.setProjectRoot) {
        try { if (p.argsSummary && !(Workstreams.get(ws.id) || {}).projectRoot) Workstreams.setProjectRoot(ws.id, p.argsSummary); } catch (_) {}
      }
      if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now());   // closes the paused span — approval wait never counts as run time
      if (isActiveWs(ws)) renderPresence();   // drop the paused styling the instant the run resumes
      btns.remove();
      const tag = document.createElement('span');
      tag.className = 'consent-result' + (isDeny ? ' err' : '');
      tag.textContent = doneLabel;
      r.body.appendChild(tag);
      syncStatus();
    }
    const mk = (text, decision, cls, doneLabel, isDeny) => {
      const b = document.createElement('button');
      b.className = 'consent-btn' + (cls ? ' ' + cls : '');
      b.textContent = text;
      b.onclick = () => decide(decision, doneLabel, isDeny);
      btns.appendChild(b); return b;
    };
    // ATTENDED BROWSER LOGIN cards get purpose-built buttons: "Always"/"Full access" make no sense for a
    // one-shot window open, and the done-wait card is a completion signal, not a permission grade.
    if (p.tool === 'browser.login') {
      mk('Open login window', 'once', '', '✓ window opened', false);
      mk('Deny', 'deny', 'deny', '✕ denied', true);
    } else if (p.tool === 'browser.login.done') {
      mk('Done — I\'ve logged in', 'once', '', '✓ done', false);
      mk('Cancel', 'deny', 'deny', '✕ cancelled', true);
    } else {
      mk('Approve once', 'once', '', '✓ approved once', false);
      mk('Always', 'always', '', '✓ always allowed', false);
      mk('Full access', 'full', 'danger', '✓ full access', false);
      mk('Deny', 'deny', 'deny', '✕ denied', true);
    }
    r.body.appendChild(btns);
    // a blocking, run-pausing prompt: make it keyboard-operable. Esc on the focused CONTAINER = Deny (the row,
    // not a button — so a reflexive Enter never lands on Approve and greenlights a write the user didn't read).
    r.d.tabIndex = -1;
    r.d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); decide('deny', '✕ denied', true); } });
    status('awaiting your approval…');
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' needs approval to ' + actionPhrase(p), 'warn', 'needsApproval');   // P1-8 category: consent prompt
    // FOCUS-STEAL GUARD (P0): a consent prompt must NEVER hijack focus from a Commander who is mid-typing or holds
    // a draft — a stolen focus + a reflexive Enter could approve a file write they never read. Only follow the
    // scroll when they were already at the bottom (honor stick), and only take focus (onto the row CONTAINER, so
    // Esc=deny works but Enter can't approve) when the composer is idle. Esc still denies either way: an idle
    // composer gets the row's Esc handler; a busy composer's own Esc handler stops the paused run (also a deny).
    autoscroll();   // honors stick — never yanks a reader who scrolled up
    const composerBusy = !!(input && (document.activeElement === input || (input.value && input.value.trim())));
    if (!composerBusy) { try { r.d.focus({ preventScroll: true }); } catch (_) { try { r.d.focus(); } catch (_) {} } }
  }

  // EL-11 FIX 1a: a consent prompt on a NON-displayed session used to be invisible — permissionRow (and its
  // notify) render for the active stream only, so a background prompt's run silently auto-denied on the sidecar's
  // consent timeout. A deny nobody saw is a consent violation. This is the GLOBAL surface: the moment a background
  // session gains a pending consent, fire a clickable toast naming the AGENT + the action; clicking it opens THAT
  // session via the same restore path as a rail-row click (Chat.load re-renders the consent card from the Channels
  // snapshot). Also refresh the rail immediately so the row's NEEDS-YOU marker lands without waiting for the ticker.
  function backgroundPermissionNotify(ev, ws) {
    const who = (typeof App !== 'undefined' && App.agentName && App.agentName(ws.agentId || 'agent')) || ws.agentId || 'an agent';
    if (typeof StationUI !== 'undefined' && StationUI.notify) {
      StationUI.notify(who + ' needs approval to ' + actionPhrase(ev) + ' — click here to answer', 'warn', 'needsApproval',
        { onClick: () => { try { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(ws.id); } catch (_) {} } });
    }
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
  }

  // ── "RATE THE WORK" — the PRIMARY leveling beat. After a run that actually DID work, the Commander gives a
  //    one-tap verdict on the OUTPUT (👍 nailed it / 👌 close / 👎 missed). 👍 mints size-weighted XP; 👌/👎 only
  //    nudge the satisfaction meter (never a penalty, never XP). The server durably records one verdict per run,
  //    then XpStore folds its canonical synthetic feedback entries — never the bus/memory store, so memory trust is untouched.
  function workSizeDelta(w) {
    if (!w) return 1;
    const tools = Math.min(Math.max(0, w.toolsOk || 0), 8);
    const deliv = Math.min(Math.max(0, w.delivered || 0), 3);
    const usd = Math.max(0, w.cost || 0);
    // honest + un-farmable: real successful tool calls + produced files + a little for spend, bucketed 1..10.
    const raw = Math.log2(1 + tools) * 2.2 + deliv * 1.2 + Math.min(usd * 6, 3);
    return Math.max(1, Math.min(10, Math.round(raw) || 1));
  }
  async function rateWork(agentId, runId, verdict) {
    if (!runId || workRatedRuns.has(runId)) return { ok: true, duplicate: true, applied: false };
    if (workRatingsPending.has(runId)) return { ok: false, pending: true, error: 'rating already saving' };
    workRatingsPending.add(runId);
    const reason = verdict === 'great' ? 'work_great' : verdict === 'ok' ? 'work_ok' : 'work_miss';
    const w = runWork.get(runId);
    const delta = 3;   // one explicit verdict has one value; the server independently fixes this canonical delta
    // The size bucket survives as legacy receipt telemetry only. It does not scale XP.
    const size = (typeof Xp !== 'undefined' && Xp.workSize) ? Xp.workSize({ tools: (w && w.toolsOk) || 0, usd: (w && w.cost) || 0 }) : undefined;
    // One durable rating-ledger write — never U.bus.emit / never /api/memory/turnin. The server returns
    // canonical feedback entries; XpStore folds those only after fsync acknowledgement.
    const entries = [{ agentId: agentId || 'agent', id: 'work:' + runId, runId: runId, delta: delta, reason: reason, size: size }];
    // P3.2 CREW-RUN RATEABILITY — named worker run-end receipts prove participation. Every proven persistent
    // contributor receives the same Commander verdict value; cost/tool volume never weights it. The sidecar
    // rebuilds the canonical list from durable child runs, so these entries remain hints only. Only hero-lead runs
    // carry crew (runCrew is populated only for agentId 'agent'). Fail-open — a missing split never blocks the rating.
    try {
      const crew = (agentId || 'agent') === 'agent' ? runCrew.get(runId) : null;
      if (crew && crew.length && typeof Xp !== 'undefined' && Xp.crewSplit) {
        const split = Xp.crewSplit({ leadDelta: delta, leadCost: (w && w.cost) || 0, workers: crew });
        for (const wk of split.workers) {
          if (!wk || !wk.agentId) continue;
          // a worker's share rides the SAME synthetic-id mint path — its own agentId resolves to its roster stats.
          entries.push({ agentId: wk.agentId, id: 'work:' + runId + ':' + wk.agentId, runId: runId, delta: wk.delta, reason: reason, size: wk.size });
        }
      }
    } catch (_) {}
    let saved;
    try {
      saved = (typeof XpStore !== 'undefined' && XpStore.recordWorkRating)
        ? await XpStore.recordWorkRating({ runId: runId, verdict: verdict, entries: entries })
        : { ok: false, error: 'rating service unavailable' };
    } catch (_) { saved = { ok: false, error: 'rating was not saved' }; }
    finally { workRatingsPending.delete(runId); }
    if (!saved || !saved.ok) return saved || { ok: false, error: 'rating was not saved' };
    workRatedRuns.add(runId);
    if (workRatedRuns.size > 120) workRatedRuns.delete(workRatedRuns.values().next().value);
    if (saved.duplicate) return saved;
    if (!saved.applied) return { ok: false, error: 'rating could not be applied' };
    // G3a confidence narrative: the same durable hand-off (this verdict never rides the bus, so the fire-once
    // calibration/TRUSTED beats must be told here, AFTER the meter folded). Speaks at most twice, ever; mints nothing.
    if (typeof ConfBeats !== 'undefined' && ConfBeats.onFeedback) { try { ConfBeats.onFeedback({ agentId: agentId || 'agent', id: 'work:' + runId, delta: delta, reason: reason }); } catch (_) {} }
    // GROWTH Tier 1 §4 — RATINGS → TASTE: fold this verdict into the per-archetype streak; a fresh 3-streak mints
    // ONE style-dim study proposal (Commander consistently likes/dislikes <archetype> work), surfaced at the same
    // one beat. The archetype is classified from the run's directive (RUN_META.title). Fail-open.
    try { const rm = runMeta(runId); maybeTasteBeat(agentId, runId, rm && rm.title, verdict); } catch (_) {}
    // R2: same DIRECT hand-off; 👍 corroborates / 👎 counter-evidences the style-model confidence (re-aims the VOI ask).
    if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.noteRating) { try { UnderstandingStore.noteRating(verdict); } catch (_) {} }
    // R5 "BOTTLE A RUN": a 👍 ('great') verdict on a real interactive run (not recipe-launched, not cron) may earn a
    // one-time "bottle it as a recipe?" offer — SAME direct hand-off (this verdict never rides the bus). BottleStore
    // gates on the run's honest info (via App.runBottleInfo → RUN_META) and defers behind the shared beat slot; it
    // mints nothing here (the editor confirm does that). Fail-open — a bottle offer is never load-bearing. Placed
    // AFTER the taste beat so this verdict's other one-beat consumers keep their precedence; BottleStore's own slot
    // guards (busy / a live rate|turn-in control) already stop it from stacking on any beat still on screen.
    let takeoverReady = false;
    if (verdict === 'great' && typeof WorkflowTakeoverStore !== 'undefined') {
      await WorkflowTakeoverStore.refresh();
      takeoverReady = !!WorkflowTakeoverStore.candidate(agentId || 'agent');
    }
    if (!takeoverReady && typeof BottleStore !== 'undefined' && BottleStore.onVerdict) { try { BottleStore.onVerdict(runId, verdict, agentId || 'agent'); } catch (_) {} }
    // P3.1 RE-SUMMON SIGNAL: a 👍 on a real interactive run may earn a one-time "run it again?" beat — SAME direct
    // hand-off, SAME shared gold-inset slot + defer-not-stack discipline as BottleStore. Bottle and re-summon are
    // BOTH 👍-triggered offers competing for the ONE post-run beat, so they must be MUTUALLY EXCLUSIVE per run:
    // BottleStore keeps priority (the marketplace-growth signal). We fire re-summon ONLY when bottle will NOT offer
    // for this run — computed synchronously via BottleStore's pure gate on the run's honest info — so a given 👍
    // run shows at most ONE of the two (never a bottle→re-summon double-ask, never a slot clobber). A recipe-launched
    // run (bottle stands down: it already IS a recipe) is exactly where re-summon shines. Fail-open.
    if (typeof ResummonStore !== 'undefined' && ResummonStore.onVerdict) {
      try {
        let bottleWillOffer = false;
        if (typeof BottleStore !== 'undefined' && BottleStore.shouldOffer && typeof App !== 'undefined' && App.runBottleInfo && BottleStore.isDecided && BottleStore._state) {
          const bs = BottleStore._state(); const bi = App.runBottleInfo(runId);
          bottleWillOffer = !!(bi && !BottleStore.isDecided(bs, runId) && BottleStore.shouldOffer(bs, verdict, bi));
        }
        if (!takeoverReady && !bottleWillOffer) ResummonStore.onVerdict(runId, verdict, agentId || 'agent');
      } catch (_) {}
    }
    // OUTCOME LOOP (recipe lane B): if THIS run was launched from a recipe (RUN_META provenance spine), fold the
    // verdict onto that recipe's own counters — what actually HELPED ranks the FOR-YOU shelf, not just what was
    // clicked. Missing meta (ledger evicted / page reloaded) → no rating recorded, never guessed. Fail-open.
    try { const rmp = runMeta(runId); if (rmp && rmp.recipeId && typeof ProspectStore !== 'undefined' && ProspectStore.noteRated) ProspectStore.noteRated(rmp.recipeId, verdict); } catch (_) {}
    // THE OUTCOME LOOP (quality loop, Q2): if THIS run was spawned by an accepted recommendation (the `rec` stamp
    // written onto RUN_META at run start), the Commander's verdict on the work is the strongest honest evidence
    // there is about whether that channel's offers are worth making. Unattributed runs say nothing. Fail-open.
    try { if (typeof RecQualityStore !== 'undefined' && RecQualityStore.noteVerdict) RecQualityStore.noteVerdict(runId, verdict); } catch (_) {}
    try { if (typeof StarterStore !== 'undefined') StarterStore.rated(runId, verdict); } catch (_) {}
    // CORRECTION CAPTURE (consistency loop, slice 2): a short-of-the-mark verdict opens a window in which the
    // Commander's next message to this agent is treated as the CORRECTION of that run and handed to the held
    // skill review in their own words (POST /api/growth/ratings/correction). Praise opens nothing.
    if (saved && saved.ok && !saved.duplicate && (verdict === 'ok' || verdict === 'miss')) lastShortVerdict = { runId: runId, agentId: agentId || 'agent', at: Date.now() };
    return saved;
  }
  let lastShortVerdict = null;   // { runId, agentId, at } — the run whose next message is its correction
  const CORRECTION_WINDOW_MS = 10 * 60 * 1000;
  function postCorrection(runId, text, final, source) {
    try {
      return fetch('/api/growth/ratings/correction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: runId, text: String(text || '').slice(0, 600), final: !!final, source: source || '' }) })
        .then(r => r.ok ? r.json().catch(() => null) : null).catch(() => null);
    } catch (_) { return Promise.resolve(null); }
  }
  // render the rate-the-work control into `host` (a span/div). onSettle fires after the verdict flashes.
  const WORKRATE_COACH_KEY = 'starnet.workrate.seen';
  function workRateControl(host, agentId, runId, onSettle) {
    host.setAttribute('data-rate-run', runId);
    // one-time explainer: the FIRST rate surface a Commander ever sees gets one honest line about what a
    // verdict does (👍 mints size-weighted XP + raises satisfaction/trust; 👌/👎 only move the satisfaction
    // meter, never XP, never a penalty — see xp.js scoreEvent/verdictQuality). Retired permanently after one
    // render via the house one-shot pattern (cf. navcoach.seen / modeldock.seen). Fail-open — a storage
    // block just shows the line again next time, never breaks the control.
    let coached = false;
    try { coached = localStorage.getItem(WORKRATE_COACH_KEY) === '1'; } catch (_) {}
    if (!coached) {
      const hint = document.createElement('span'); hint.className = 'work-rate-hint';
      hint.textContent = 'rating trains your agent — the top mark earns XP and builds trust';
      host.appendChild(hint);
      try { localStorage.setItem(WORKRATE_COACH_KEY, '1'); } catch (_) {}
    }
    const lbl = document.createElement('span'); lbl.className = 'work-rate-label';
    // name the RUN's agent, not whoever the active chat happens to be bound to — the OUTBOX window
    // (and any multi-agent surface) rates crew runs while a different agent is on screen. The verdict
    // already routes by the agentId param; the label must agree with it (truthful telemetry).
    let ratee = name;
    try { if (typeof App !== 'undefined' && App.agentName) ratee = App.agentName(agentId || 'agent') || name; } catch (_) {}
    const ratedMeta = runMeta(runId);
    const ratedWork = runWork.get(runId);
    const ratedTask = String((ratedMeta && ratedMeta.directive) || (ratedWork && ratedWork.title) || '').replace(/\s+/g, ' ').trim();
    lbl.textContent = '◈ rate ' + ratee + '’s work — ';
    const ref = document.createElement('div'); ref.className = 'work-rate-reference';
    ref.textContent = (ratedTask ? ratedTask.slice(0, 240) + (ratedTask.length > 240 ? '…' : '') + ' · ' : '') + 'run ' + runId;
    host.appendChild(ref);
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    host.appendChild(lbl); host.appendChild(btns);
    let done = false;
    async function settle(verdict, flash, isDeny) {
      if (done) return; done = true;
      const buttons = Array.from(btns.querySelectorAll('button'));
      buttons.forEach(b => { b.disabled = true; });
      const accepted = await rateWork(agentId, runId, verdict);
      if (!accepted || !accepted.ok) {
        done = false;
        buttons.forEach(b => { b.disabled = false; });
        try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((accepted && accepted.error) || 'Rating was not saved — try again.', 'bad'); } catch (_) {}
        return;
      }
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = accepted.duplicate ? 'already rated' : flash;
      host.appendChild(tag);
      // flash the verdict, let the caller fade the beat, THEN (momentum loop) give a short-of-the-mark verdict its
      // consequence: the follow-up beat asks what missed and writes the answer into the dossier. Rides every
      // rate path (standalone beat, turn-in card, outbox) because it hangs off settle, not off any one caller.
      setTimeout(() => { try { if (onSettle) onSettle(verdict); } finally { verdictFollowupBeat(agentId, runId, verdict); } }, 700);
      // Rejoin the same arbiter after the rating fades; do not bank work twice or rerun other offers.
      if (verdict === 'great') setTimeout(() => { recommendPass({ agentId, runId }, 'takeover'); }, 2200);
    }
    function mk(label, cls, verdict, flash, isDeny) {
      const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = label;
      b.onclick = () => settle(verdict, flash, isDeny); btns.appendChild(b);
    }
    // CRT glyphs, not color emoji: ▲ nailed it · ◆ close · ▼ missed (semantics preserved, phosphor-themed)
    mk('▲ nailed it', 'primary', 'great', '★ +XP', false);
    mk('◆ close', '', 'ok', 'noted', false);
    mk('▼ missed', 'deny', 'miss', 'noted', true);
  }
  // STANDALONE rate-the-work beat (when a run produced NO memory proposal) — its own gold-inset row in the ONE
  // post-run slot. Hero-only, mirroring the curiosity/suggestion beats.
  function retirePriorRatings(streamId) {
    if (!log) return;
    for (const host of log.querySelectorAll('[data-rate-run]')) {
      const meta = runMeta(host.getAttribute('data-rate-run'));
      if (!meta || meta.streamId !== streamId) continue;
      const standalone = host.closest('.work-rate');
      if (standalone && beatCards) beatCards.expire('rate');
      // Retire only the rating controls; a memory proposal keeps its own lifecycle.
      host.remove();
    }
  }
  function workRateBeat(agentId, runId) {
    if (!log) return false;
    clearNudge();   // claim the one post-run beat slot, retiring any prior gentle nudge
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('work-rate');
    const beat = beatCards && beatCards.claim({ kind: 'rate', runId: runId, node: r.d });
    if (!beat) { if (r.d && r.d.parentNode) r.d.remove(); return false; }
    workRateControl(r.body, agentId, runId, () => { beat.decide(); beat.finish(); });
    autoscroll();
    return true;
  }

  /* G2.4 — CLOSE THE RATE-STARVE HOLE. The rate control used to reach the Commander on exactly two
     paths: embedded in a turn-in card, or the standalone beat — and the standalone beat stood down the
     moment memory.proposed fired (proposalRunsSeen). Three ways that starved rating forever:
       1. reflection proposed but the batch fetch came back EMPTY -> no card, no control;
       2. the turn-in deck rendered WITH the embedded control, but the Commander decided every memory
          without rating -> finishBatch vanished the whole card, control and all;
       3. the batch landed on a NON-displayed stream -> a soft notify, no card, no control.
       4. a focused panel (the tutorial's Dialogue on the FIRST command, an intake interview) held the
          post-run slot at the 650ms moment -> every beat stood down with no retry, ever.
     Every hole now funnels into maybeStandaloneRate; armRateFallback (armed per run at run end)
     re-attempts on a 5s cadence until the beat fires or the run is permanently ineligible. */
  // one attempt at the standalone rate beat. Returns:
  //   'fired'   — the beat rendered (this hero run did real work, was unrated, and the moment was free)
  //   'blocked' — TRANSIENT: a run is live / a focused panel (tutorial Dialogue, intake) is up / a
  //               review deck or another rate control is on screen — worth retrying later
  //   'never'   — PERMANENT: rated already, not the hero, or no real work — stop asking
  function maybeStandaloneRate(agentId, runId) {
    const status = rateStatus(agentId, runId);
    if (status !== 'ready') return status;
    return workRateBeat(agentId || 'agent', runId) ? 'fired' : 'blocked';
  }
  /* the SYNC, side-effect-free half of the rate beat, split out so the recommendation pass can offer rating
     as a scored candidate instead of racing it in on an arm delay. Same three verdicts as
     maybeStandaloneRate, except the free moment answers 'ready' instead of rendering — every gate below is
     byte-identical to the pre-spine ladder. */
  function ratingRunSuperseded(runId) {
    const origin = runMeta(runId);
    const stream = origin && origin.streamId && typeof Workstreams !== 'undefined' ? Workstreams.get(origin.streamId) : null;
    return !!(stream && stream.runIds && stream.runIds.length && stream.runIds[stream.runIds.length - 1] !== runId);
  }
  function rateStatus(agentId, runId) {
    if (!log || !runId || workRatedRuns.has(runId)) return 'never';
    if (ratingRunSuperseded(runId)) return 'never';
    const origin = runMeta(runId);
    if (origin && origin.streamId && activeWs && activeWs.id !== origin.streamId) return 'blocked';
    // S1 SPECIALIST RATE-STARVE FIX. This was hero-only, which starved every summoned specialist of the PRIMARY
    // leveling beat: an interactive run in a specialist-bound workstream could only ever be rated if it happened
    // to also produce a memory turn-in card (the one other control that routes by the run's own agentId). So a
    // specialist stayed Lv 1 forever while the hero collected the whole roster's growth.
    // The beat renders into the ONE shared #chat-log, so the honest predicate is not "is this the hero" but
    // "is this run's agent the one whose stream is ON SCREEN" (the activeWs idiom used by the skill aside).
    // Deliberately ADDITIVE: the hero keeps its exact prior behavior (it may fire while another stream is
    // displayed); only the non-hero case is new, and it waits for its own stream rather than rendering a
    // specialist's rating into somebody else's transcript. 'blocked' (not 'never') so armRateFallback keeps
    // retrying — switching to that stream within the fallback window still lands the beat.
    // A dispatched WORKER's forwarded run.end never reaches here: it has no runWork stash (only the local stream
    // loop sets one), so the real-work gate below returns 'never' — its credit rides the lead's crewSplit instead.
    if ((agentId || 'agent') !== 'agent' && !(activeWs && (activeWs.agentId || 'agent') === (agentId || 'agent'))) return 'blocked';
    const w = runWork.get(runId);
    if (!w || ((w.toolsOk || 0) < 1 && (w.delivered || 0) < 1)) return 'never';   // real work only — pure chat is never rate-prompted
    if (isBusy() || interview) return 'blocked';                        // never mid-run / mid-awakening
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return 'blocked';
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return 'blocked';
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return 'blocked';   // a focused panel is up (e.g. the tutorial) — retry after it closes
    if (beatCards && beatCards.visibleBeat() && beatCards.visibleBeat() !== 'nudge') return 'blocked';
    if (activeTurnin && activeTurnin.node && activeTurnin.node.isConnected) return 'blocked';   // a review deck is up (it carries its own control)
    if (log.querySelector('.cmsg.work-rate') || log.querySelector('.turnin-rate')) return 'blocked';   // a rate control is already live somewhere (one ask at a time)
    return 'ready';
  }
  // the self-retrying fallback: armed once per completed task run at run end, it keeps re-attempting
  // (5s cadence, bounded ~5min) until the beat fires or the run is permanently ineligible — so a
  // tutorial panel, a live turn-in deck, or a busy stream can DELAY the rating but never STARVE it.
  // Its first attempt is DEFERRED: the post-run slot's own inline attempt owns the immediate moment.
  const armedRateRuns = new Set();
  function armRateFallback(agentId, runId, tries) {
    if (!runId || armedRateRuns.has(runId)) return;
    armedRateRuns.add(runId);
    if (armedRateRuns.size > 120) armedRateRuns.delete(armedRateRuns.values().next().value);
    (function attempt(left) {
      setTimeout(() => {
        // Marker parsing happens as the stream closes, before this delayed post-run beat. A question turn did
        // not ship work and must not bank curiosity credit, earn a rating, or trigger another proactive ask.
        if (runId && clarificationRuns.has(runId)) { clarificationRuns.delete(runId); return; }
        const r = maybeStandaloneRate(agentId, runId);
        if (r === 'blocked' && left > 0) attempt(left - 1);
      }, 5000);
    })(typeof tries === 'number' ? tries : 60);
  }

  /* ── G2 RETURN RITUAL — the "while you were away" digest + the per-run collect beat. ──
     A SESSION-OPEN beat (fired once by ReturnStore after app open), distinct from the post-run slot:
     it lists the REAL unattended runs the sidecar's run history recorded since the app was last
     attended, each with a review (rate-the-work) affordance. Rating a row IS the collect tap — it
     rides the same direct rateWork path (XP law: only user feedback on real work mints), and clears
     that run's OUTBOX crate via onRated. Gold-inset family; decided rows vanish(); dismissed = the
     whole beat vanishes and never re-fires (the crates stay collectable from the OUTBOX). */
  // an away run has no live runWork stash — seed one from its HONEST history row so the rating's
  // size derives from real recorded turns/spend (turns-1 ≈ tool rounds: each loop turn past the
  // first was a tool round; conservative, never farmable — the row is server-recorded).
  function seedAwayWork(rw) {
    if (!rw || !rw.runId || runWork.has(rw.runId)) return;
    runWork.set(rw.runId, { toolsOk: Math.max(0, (rw.turns | 0) - 1), delivered: 0, cost: Math.max(0, +rw.usd || 0), agentId: rw.agentId || 'agent' });
    if (runWork.size > 60) runWork.delete(runWork.keys().next().value);
  }
  function awayRowLabel(rw) {
    const name = rw.routine ? ('“' + rw.routine + '” ran on its own') : (rw.title || 'an unnamed run');
    const who = (rw.agentId && rw.agentId !== 'agent') ? (' · ' + String(rw.agentId).slice(0, 12)) : '';
    const usd = (+rw.usd > 0) ? (' · ' + U.usd(+rw.usd)) : '';
    // G3a seed callout: an unattended run that reuses a Commander-saved seed credits it inline (rw.seed is
    // annotated by ReturnStore via SeedCredit — provenance-matched, never guessed). A credit line, not a beat.
    const seed = rw.seed ? (' · from the seed you saved — “' + rw.seed + '”') : '';
    return '◷ ' + name + who + usd + seed;
  }
  // the "↗ read the work" affordance (2026-07-16 UX fix): every review surface must let the Commander SEE
  // the run's actual output before rating it — the old beat showed only the raw prompt title and a rate
  // control, which read as a context-free popup ("what is this? where's the work?"). opts.openWork(rw)
  // (ReturnStore.openWork) opens the run's transcript session in COMMS; an unreachable transcript says so
  // honestly in place — never a dead click.
  function openWorkBtn(host, rw, openWork) {
    if (!openWork) return;
    const b = document.createElement('button'); b.className = 'consent-btn primary'; b.textContent = '↗ read the work';
    b.onclick = () => {
      b.disabled = true; b.textContent = 'opening…';
      Promise.resolve().then(() => openWork(rw)).then(ok => {
        if (ok) { b.disabled = false; b.textContent = '↗ read the work'; return; }   // reusable — the beat stays for rating
        const note = document.createElement('span'); note.className = 'consent-result err'; note.textContent = 'transcript unreachable';
        b.replaceWith(note);
      }).catch(() => { b.disabled = false; b.textContent = '↗ read the work'; });
    };
    host.appendChild(b);
  }
  // ONE digest per session (ReturnStore owns the budget + the row data). opts.onRated(runId) clears the crate.
  function awayDigest(rows, opts, _try) {
    if (!log || !rows || !rows.length) return;
    const onRated = (opts && opts.onRated) || (() => {});
    // session-open coordination: never collide with a live run, the awakening/interview, a focused
    // panel, an open turn-in deck, or a live gentle beat (incl. the autopilot welcome-back nudge).
    const blocked = isBusy() || interview || activeTurnin || activeNudge || taskQuestionLive()
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) {   // defer — a gate is up (interview / focused panel / live turn-in / welcome-back nudge / unanswered task question).
      // "deferred" must NEVER become "lost": the crates are already pending in the OUTBOX (ReturnStore
      // folded them before this beat), but the digest beat itself keeps waiting for a free moment.
      // Fast cadence (7s) while the moment is likely to free soon, then a low-frequency retry (60s) that
      // never gives up — same DELAY-but-never-STARVE law as armRateFallback. Fires exactly once (anti-nag:
      // once it renders below, it returns and there is no re-fire path).
      const t = (_try || 0);
      const delay = t < 25 ? 7000 : 60000;
      setTimeout(() => awayDigest(rows, opts, t + 1), delay);
      return;
    }
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('away-digest');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ while you were away — ' + rows.length + (rows.length > 1 ? ' runs' : ' run') + ' finished. read each one, then rate it:';
    r.body.appendChild(title);
    let open = rows.length;
    const settleRow = (item) => { vanish(item); if (--open <= 0) vanish(r.d); };
    for (const rw of rows) {
      const item = document.createElement('div'); item.className = 'turnin-item';
      const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = awayRowLabel(rw);
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(text); item.appendChild(btns);
      openWorkBtn(btns, rw, opts && opts.openWork);   // SEE the output first — rating blind was the confusion
      const b = document.createElement('button'); b.className = 'consent-btn quiet'; b.textContent = 'rate it';
      b.onclick = () => {   // swap the review affordance for the real rate control, in place
        btns.remove();
        const rate = document.createElement('div'); rate.className = 'turnin-rate';
        item.appendChild(rate);
        seedAwayWork(rw);
        workRateControl(rate, rw.agentId || 'agent', rw.runId, () => { try { onRated(rw.runId); } catch (_) {} settleRow(item); });
        autoscroll();
      };
      btns.appendChild(b);
      r.body.appendChild(item);
    }
    // dismissed = gone (anti-nag law). Uncollected crates remain on the OUTBOX — evidence, not nagging.
    const foot = document.createElement('div'); foot.className = 'turnin-rate';
    // the ONE door that always works, prop or no prop on the floor: open the OUTBOX window — every listed
    // run readable + rateable in one place (2026-07-16; a floor with no OUTBOX placed had no other path).
    if (typeof StationUI !== 'undefined' && StationUI.openTerm) {
      const ob = document.createElement('button'); ob.className = 'consent-btn'; ob.textContent = '▸ open the OUTBOX';
      ob.onclick = () => StationUI.openTerm('outbox');
      foot.appendChild(ob);
    }
    const dis = document.createElement('button'); dis.className = 'consent-btn deny'; dis.textContent = 'dismiss';
    dis.onclick = () => vanish(r.d);
    foot.appendChild(dis);
    // ADOPTION (Lane F): a dim line so dismissing doesn't read as LOSING the runs — they wait on the OUTBOX crate.
    if (typeof ReturnStore !== 'undefined' && ReturnStore.outboxLine) {
      const keep = document.createElement('span'); keep.className = 'turnin-queue'; keep.textContent = ReturnStore.outboxLine();
      foot.appendChild(keep);
    }
    r.body.appendChild(foot);
    autoscroll();
  }
  // awayRate(host, rw, onSettle) — mount the real rate-the-work control for an away run into any DOM host
  // (the OUTBOX window uses this). Same XP-law path as every attended run (seedAwayWork → workRateControl →
  // rateWork). Returns false when the run was already judged this session (the caller just collects the crate).
  function awayRate(host, rw, onSettle) {
    if (!host || !rw || !rw.runId) return false;
    if (workRatedRuns.has(rw.runId)) return false;   // already judged — nothing to mount, crate is collectable
    seedAwayWork(rw);
    workRateControl(host, rw.agentId || 'agent', rw.runId, onSettle);
    return true;
  }
  // the OUTBOX collect beat: clicking the chute (or a stacked crate) reviews ONE pending away run.
  // Same gold-inset family; rating clears the crate (onRated) and the beat vanishes.
  // Reshaped 2026-07-16: the beat now SAYS what it is (a run that finished while you were away), offers
  // "↗ read the work" (open the run's transcript session) BEFORE asking for a verdict, and has a "later"
  // out that keeps the crate on the chute — the old shape was a bare prompt-title + rate control, which
  // read as a context-free popup with no way to see the work it asked you to judge.
  function awayReview(rw, opts) {
    if (!log || !rw || !rw.runId) return;
    const onRated = (opts && opts.onRated) || (() => {});
    if (workRatedRuns.has(rw.runId)) { try { onRated(rw.runId); } catch (_) {} return; }   // already judged — just clear the crate
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('work-rate');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ OUTBOX crate — this run finished while you were away:';
    r.body.appendChild(title);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = awayRowLabel(rw);
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(text); item.appendChild(btns);
    openWorkBtn(btns, rw, opts && opts.openWork);
    const later = document.createElement('button'); later.className = 'consent-btn deny'; later.textContent = 'later';
    later.onclick = () => vanish(r.d);   // the crate STAYS on the chute — deferring never loses the work
    btns.appendChild(later);
    r.body.appendChild(item);
    const rate = document.createElement('div'); rate.className = 'turnin-rate';
    r.body.appendChild(rate);
    seedAwayWork(rw);
    workRateControl(rate, rw.agentId || 'agent', rw.runId, () => { try { onRated(rw.runId); } catch (_) {} vanish(r.d); });
    autoscroll();
  }

  /* THE INBOX SAMPLE CARD (guided workflow Phase 4 — PROOF: "does my system work?"). Opened by clicking the
     INBOX prop on a floor whose drawn line is COMPLETE (world.js intakeSampleAt → app.js wiring). Offers ONE
     real, clearly-labeled sample job through the REAL dispatch path (POST /api/routing/sample): the router
     picks the dock, the run spends real budget through runOnce, the shared chain runner walks the drawn line,
     and the reply lands on the OUTBOX as a collectable crate (ReturnStore.foldRow of the sidecar's real
     recorded run row — never synthesized). Same Commander-initiated gold-inset card family as awayReview —
     it renders immediately (the click asked for it) and never touches the shared post-run beat slot.
     Honest states only: in-flight reads "riding the line…" while the request is genuinely open; a refusal
     shows the SERVER's reason verbatim; success shows who delivered, the real cost, and a glance of the reply.
     opts.fed === false (world feedState, server-proven) adds the CHANNELS door, so the NO-FEED nag's promised
     click-through survives this card owning the intake click. */
  let sampleCardEl = null;
  function sampleCard(opts) {
    opts = opts || {};
    if (!log) return;
    if (sampleCardEl && sampleCardEl.isConnected) { autoscroll(); return; }   // one live card at a time
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('sample-card');
    sampleCardEl = r.d;
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ INBOX — prove the line: run one small, real job through it, end to end.';
    r.body.appendChild(title);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const text = document.createElement('span'); text.className = 'turnin-text';
    text.textContent = 'a labeled test crate (“SAMPLE JOB…”) rides the real belts — the router picks the dock, the run spends real budget, and the reply lands on the OUTBOX.';
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(text); item.appendChild(btns);
    r.body.appendChild(item);
    const note = document.createElement('div');   // refusal / result area (below the action row)
    r.body.appendChild(note);
    const run = document.createElement('button'); run.className = 'consent-btn primary'; run.textContent = '▸ RUN A SAMPLE JOB';
    const later = document.createElement('button'); later.className = 'consent-btn deny'; later.textContent = 'not now';
    later.onclick = () => vanish(r.d);
    btns.appendChild(run); btns.appendChild(later);
    if (opts.fed === false && typeof StationUI !== 'undefined' && StationUI.openTerm) {
      // the floor PROVABLY has no feed wired (server-answered, never guessed) — keep the promised door here
      const feed = document.createElement('button'); feed.className = 'consent-btn'; feed.textContent = '▸ WIRE A REAL FEED — CHANNELS';
      feed.onclick = () => StationUI.openTerm('messaging');
      btns.appendChild(feed);
    }
    const fail = (msg) => {
      const err = document.createElement('span'); err.className = 'consent-result err';
      err.textContent = msg;
      note.textContent = ''; note.appendChild(err);
      run.disabled = false; later.disabled = false; run.textContent = '▸ RUN A SAMPLE JOB';
      autoscroll();
    };
    run.onclick = () => {
      run.disabled = true; later.disabled = true;
      run.textContent = '⌛ the sample is riding the line…';   // honest: the POST is genuinely open until the line delivers
      note.textContent = '';
      Harness.api.post('/api/routing/sample', {}).then(res => {
        if (!res.ok) return fail(String((res.j && res.j.error) || ('the station refused (http ' + res.status + ')')));   // the server's reason, VERBATIM
        const j = res.j || {};
        btns.remove();
        // TRUTHFUL VERDICT: "delivered" may only be claimed for a run that finished clean ('done' is the
        // recorded reason in runs.jsonl). An errored stage still replies honestly (the ⚠ text below), but the
        // card must not stamp a checkmark on it — and no OUTBOX crate: the finished-work ledger is 'done'-only
        // (the same SLAG rule the away digest applies).
        const clean = !!(j.delivered && j.delivered.reason === 'done');
        let folded = false;
        if (clean) { try { if (typeof ReturnStore !== 'undefined' && ReturnStore.foldRow) folded = ReturnStore.foldRow(j.delivered); } catch (_) {} }
        const who = (j.delivered && j.delivered.agentId) || j.agentId || 'agent';
        const cost = (+j.totalUsd > 0 && typeof U !== 'undefined' && U.usd) ? (' · ' + U.usd(+j.totalUsd)) : '';
        text.textContent = clean
          ? ('✔ sample delivered — ' + who + ' shipped it' + cost + '.' + (folded ? ' the crate is on the OUTBOX.' : ''))
          : ('⚠ the sample rode the line, but the run did not finish clean — the reply below says why.');
        const reply = (j.replies && j.replies.length) ? String(j.replies[j.replies.length - 1]).replace(/\s+/g, ' ').trim() : '';
        if (reply) {
          const out = document.createElement('div'); out.className = 'turnin-text';
          out.textContent = '“' + (reply.length > 220 ? reply.slice(0, 220).trimEnd() + '…' : reply) + '”';
          note.appendChild(out);
        }
        const acts = document.createElement('div'); acts.className = 'turnin-rate';
        if (folded && typeof StationUI !== 'undefined' && StationUI.openTerm) {
          const ob = document.createElement('button'); ob.className = 'consent-btn'; ob.textContent = '▸ open the OUTBOX — read it all';
          ob.onclick = () => StationUI.openTerm('outbox');
          acts.appendChild(ob);
        }
        const done = document.createElement('button'); done.className = 'consent-btn quiet'; done.textContent = 'done';
        done.onclick = () => vanish(r.d);
        acts.appendChild(done);
        note.appendChild(acts);
        autoscroll();
      }).catch(() => fail('the station didn’t answer — is the sidecar running?'));
    };
    autoscroll();
  }

  /* W3 — THE DELIVERY CARD (reshaped 2026-07-15). WorkshopStore adopts one SESSION per idle-work
     deliverable ('workshop-<runId>', unread in the rail) and calls this ONLY when the Commander opens that
     session — opts.sessionId pins the card to it, so a delivery can never paint into an unrelated stream.
     Simple by design: the headline, the honest verification line, the link that RUNS it FIRST (when a
     web entry exists — open-not-read law), then WHAT it did / WHY / check-yourself, the files, and ONE action row — an optional message to the agent plus three one-click
     decisions: Implement (decide keep — the sidecar applies a patch deliverable to a new branch, or lands
     files in the default deliverables folder; and when the deliverable is a PLAN rather than the finished thing,
     it then RUNS the build that does the work — see `buildable` below), Later (dismiss; the session stays), Discard (single confirm →
     wipe + denylist). A typed message rides the decision as a REAL user turn in this same session — the
     session id IS the shift's durable streamId, so the agent replies with the build's actual transcript
     behind it. Decided cards vanish(); the outcome persists as a sys marker (opts.noteDecision).
     TRUTHFUL TELEMETRY: the verification line renders "tested — N passed" ONLY from a real manifest.verified
     block; absent → honest not-tested copy. The card never asserts status the manifest doesn't prove.
     opts: { sessionId, onDecide(decision, destPath?, extra?) -> Promise<{ok,destPath?,applied?,branch?,root?,error?}>,
             onImplement(note) -> Promise<{fired,reason,runId?,manifest?}> (absent → Implement stays a plain keep;
                                  note = the Commander's typed build instruction, which part of the plan to build),
             readFile(agentId,runId,path) -> Promise<string>, runUrl(relPath), openFile(relPath),
             noteDecision(text) }. */
  function workshopReturn(m, opts, _try) {
    if (!log || !m || !m.runId) return;
    opts = opts || {};
    const onDecide = opts.onDecide || (() => Promise.resolve({ ok: true }));
    // SESSION PIN: render only while the card's OWN delivery session is on screen. Switched away → just
    // stop (no retry) — chat.js load() re-fires WorkshopStore.presentFor when the Commander comes back.
    const inOwnSession = () => !opts.sessionId || !!(activeWs && activeWs.id === opts.sessionId);
    if (!inOwnSession()) return;
    const blocked = isBusy() || interview || activeTurnin || activeNudge || taskQuestionLive()
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) {   // defer — DELAY but never STARVE (same law as awayDigest): fast retry, then slow; the session pin above retires a stale retry chain.
      const t = (_try || 0);
      setTimeout(() => workshopReturn(m, opts, t + 1), t < 25 ? 7000 : 60000);
      return;
    }
    // ONE LIVE CARD PER DELIVERABLE (2026-07-14): an undecided card may be RE-offered (return-from-away,
    // next-session attach) until decided — drop the stale instance first so the feed never holds two live
    // cards for the same runId (deciding one would strand a dead twin whose decide can only fail).
    try { const stale = log.querySelector('.workshop-return[data-wsrun="' + String(m.runId).replace(/["\\]/g, '') + '"]'); if (stale) stale.remove(); } catch (_) {}
    const agentId = m.agentId || 'agent';
    const who = (agentId === 'agent') ? name : agentId;
    // W7 — the Commander receives a TOOL, not a repo. If the deliverable has a web entry point (index.html
    // preferred, else the first .html), the PRIMARY action becomes "Open it": it opens the RUNNING tool in a
    // browser tab from the jailed /workshop-run/ static route. No html → no runnable entry, so Keep stays primary.
    const files = Array.isArray(m.files) ? m.files.filter(f => f && f.path) : [];
    const htmlFiles = files.filter(f => /\.html?$/i.test(f.path));
    const htmlEntry = htmlFiles.length
      ? ((htmlFiles.find(f => /(^|\/)index\.html?$/i.test(f.path)) || htmlFiles[0]).path)
      : '';
    const openRunTab = (relPath) => {
      const url = opts.runUrl ? opts.runUrl(relPath) : '';
      const warn = (msg) => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(msg, 'warn'); };
      if (!url) { warn('could not open that — the station may be unreachable'); return; }
      // Desktop (Tauri): a raw window.open silently fails under the window policy — hand the absolute
      // sidecar URL to the OS default browser and report a real failure if it doesn't open (same law as
      // stationui.js openSignIn: never pretend a tab exists). Browser: window.open, where null = popup-blocked.
      const invoke = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core.invoke : null;
      if (invoke) {
        invoke('open_external_url', { url }).catch(() => warn('could not open your browser — open this in one yourself: ' + url));
        return;
      }
      let win = null;
      try { win = window.open(url, '_blank', 'noopener'); } catch (_) {}
      if (!win) warn('your browser blocked the new tab — allow popups for the station, then try again');
    };
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('workshop-return');
    try { r.d.setAttribute('data-wsrun', String(m.runId)); } catch (_) {}   // the re-present dedupe key (above)

    /* ── headline (+ an honest kind chip straight off the validated manifest) ──
       THE VERB MUST MATCH WHAT THE SHIFT ACTUALLY DID. Every card used to say "built", including the ones that
       merely wrote a document — and once the headline claims a plan was BUILT, the action offering to build it
       reads as a contradiction ("it built X… now it will build X?"). Andrew hit exactly that. The verb comes from
       DECLARED manifest fields (planOnly, kind), never from a guess about the content. */
    // ONE past-tense word, reused by the headline AND the verification line below — they sat next to each other
    // saying "wrote:" and "built —" about the same deliverable.
    const didWord = (m.planOnly === true) ? 'drafted' : (m.kind === 'doc') ? 'written' : (m.kind === 'draft') ? 'drafted' : 'built';
    const didVerb = (m.planOnly === true) ? 'drafted a plan:'
      : (m.kind === 'doc') ? 'wrote:'
      : (m.kind === 'draft') ? 'drafted:'
      : (m.kind === 'patch') ? 'prepared a patch:'
      : 'built:';
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ while you were away — ' + who + ' ' + didVerb + ' ' + String(m.title || 'a deliverable');
    // a declared plan is labelled 'plan' — more use than its raw kind ('doc'), which says nothing about the
    // decision in front of the Commander.
    const chipText = (m.planOnly === true) ? 'plan' : ((m.kind && m.kind !== 'other') ? String(m.kind) : '');
    if (chipText) {
      const chip = document.createElement('span'); chip.className = 'ws-kindchip'; chip.textContent = chipText;
      title.appendChild(chip);
    }
    r.body.appendChild(title);

    // HONEST verification line — proves off the manifest ONLY. Three truthful states:
    //   1. the manifest recorded verify commands  → "tested — N of M passed" (+ per-command detail in the pane)
    //   2. the agent flagged things a human must check (notVerified) → say so, don't imply failure
    //   3. neither                                → "built — no test commands were defined"
    // NOTE: today's workshop agent cannot run commands (it is told so in workshopPrompt), so a real manifest
    // carries no verified.commands — the notVerified path is the common case. State 1 is future-proofing for
    // when a shift can run tests; it never fabricates a result the manifest doesn't hold.
    const ver = document.createElement('span'); ver.className = 'ws-verline';
    const vcmds = (m.verified && Array.isArray(m.verified.commands)) ? m.verified.commands.filter(c => c && c.cmd) : null;
    const notVer = Array.isArray(m.notVerified) ? m.notVerified.filter(Boolean) : [];
    if (vcmds && vcmds.length) {
      const passed = vcmds.filter(c => Number(c.exit) === 0).length;
      ver.textContent = 'tested — ' + passed + ' of ' + vcmds.length + ' command' + (vcmds.length > 1 ? 's' : '') + ' passed';
      ver.classList.add(passed === vcmds.length ? 'ok' : 'dim');
    } else if (notVer.length) {
      // same verb as the headline, and no "couldn't test here" on a deliverable with nothing to run — that
      // sentence exists to excuse an untested TOOL, and reads as a failure report on a document.
      const runnable = !(m.planOnly === true || m.kind === 'doc' || m.kind === 'draft');
      ver.textContent = didWord + ' — ' + (runnable ? 'the agent couldn’t test here; ' : '')
        + notVer.length + ' thing' + (notVer.length > 1 ? 's' : '') + ' for you to check';
      ver.classList.add('dim');
    } else {
      ver.textContent = (m.planOnly === true) ? 'drafted — nothing has been built from this yet'
        : (didWord + ' — no test commands were defined');
      ver.classList.add('dim');
    }
    r.body.appendChild(ver);

    // ── TRY IT FIRST (2026-07-17, deliverable = open-not-read law) — when a web entry exists, the RUN
    // action leads the card: the Commander opens the thing, the prose below is supporting context, not a
    // gate in front of the click. Jailed /workshop-run/ route, same as before — only the position moved.
    if (htmlEntry) {
      // disk-proven by validateWorkshopManifest (never the model's claim): this deliverable requests pointer
      // lock / fullscreen, i.e. opening it will capture the Commander's REAL mouse. Say so BEFORE the click.
      if (m.capturesInput) {
        const warn = document.createElement('div'); warn.className = 'ws-line ws-capture-warn';
        warn.textContent = '⚠ captures your mouse/keyboard when opened (pointer lock) — press Esc to release it';
        r.body.appendChild(warn);
      }
      if (m.usesMedia) {
        const warn = document.createElement('div'); warn.className = 'ws-line ws-capture-warn';
        warn.textContent = '⚠ may ask to use your camera, microphone, or screen when opened';
        r.body.appendChild(warn);
      }
      const tryRow = document.createElement('div'); tryRow.className = 'turnin-rate ws-try';
      const openItBtn = document.createElement('button'); openItBtn.className = 'consent-btn ws-openit'; openItBtn.textContent = '▶ Open it — try it in a tab';
      openItBtn.title = m.capturesInput
        ? 'run this tool in a new browser tab — it will capture your mouse; Esc releases it'
        : 'run this tool in a new browser tab';
      openItBtn.onclick = () => openRunTab(htmlEntry);
      tryRow.appendChild(openItBtn);
      r.body.appendChild(tryRow);
    }

    // labeled section rows — the premium dossier grammar (gold uppercase micro-label over a bright value),
    // same ws-k/ws-v vocabulary the old summary pane and the config cards speak.
    const mkSection = (label, value, cls) => {
      const d = document.createElement('div'); d.className = 'ws-line ' + cls;
      const kk = document.createElement('span'); kk.className = 'ws-k'; kk.textContent = label;
      const vv = document.createElement('span'); vv.className = 'ws-v'; vv.textContent = value;
      d.appendChild(kk); d.appendChild(vv); r.body.appendChild(d);
    };
    // ── WHAT it did — the agent's plain summary. Both away-work personas (sidecar workshopPrompt +
    // autopilot buildDoDirectiveV2) now cap this to 2-3 short sentences; a verbose legacy manifest folds
    // at a sentence boundary behind a one-tap "more" instead of painting a wall of prose. Nothing is
    // hidden for good — expand shows the agent's full paragraph verbatim.
    if (m.summary) {
      const full = String(m.summary).replace(/\s+/g, ' ').trim();
      if (full && full.length <= 360) mkSection('what it did', full, 'ws-what');
      else if (full) {
        const win = full.slice(0, 340);
        const sentEnd = Math.max(win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
        // prefer a sentence boundary; a boundary-free run-on breaks at a WORD boundary with an honest ellipsis
        const short = sentEnd > 120 ? full.slice(0, sentEnd + 1) : full.slice(0, win.lastIndexOf(' ') > 120 ? win.lastIndexOf(' ') : 300).trim() + '…';
        const d = document.createElement('div'); d.className = 'ws-line ws-what';
        const kk = document.createElement('span'); kk.className = 'ws-k'; kk.textContent = 'what it did';
        const vv = document.createElement('span'); vv.className = 'ws-v'; vv.textContent = short + ' ';
        const more = document.createElement('button'); more.type = 'button'; more.className = 'ws-more'; more.textContent = '+ more';
        more.onclick = () => { vv.textContent = full; autoscroll(); };   // one-way expand; replacing textContent drops the button
        vv.appendChild(more);
        d.appendChild(kk); d.appendChild(vv); r.body.appendChild(d);
      }
    }
    // ── why this — server-stamped provenance (workshopBecause): the grounds quote or the Commander's own
    // ask that queued the build. Real recorded data only; absent → no line. This is the adaptation made
    // visible: the card says WHY in your terms, not just WHAT in the agent's.
    if (m.because) {
      const because = String(m.because).replace(/\s+/g, ' ').trim();
      if (because) mkSection('why this', because.length > 300 ? because.slice(0, 300) + '…' : because, 'ws-because');
    }
    // ── how to use — ONE short line, and ONLY when there is no Open button (an html entry's how-to-use IS
    // the ▶ Open it action above; repeating "open index.html" under it was dead weight). A verbose legacy
    // manifest is clamped rather than dumped as a wall of instructions (the old confusing card).
    if (m.howToUse && !htmlEntry) {
      const one = String(m.howToUse).replace(/\s+/g, ' ').trim();
      if (one) mkSection('how to use', one.length > 200 ? one.slice(0, 200) + '…' : one, 'ws-how');
    }
    // what a human still needs to check — honest, compact (never implied failure, never hidden). One short
    // row per item (the old semicolon join painted a wall); past the fourth, items fold behind "+N more".
    if (Array.isArray(m.notVerified) && m.notVerified.length) {
      const items = m.notVerified.filter(Boolean)
        .map(s => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > 200 ? t.slice(0, 200) + '…' : t; })
        .filter(Boolean);
      if (items.length === 1) mkSection('check yourself', items[0], 'ws-notver');
      else if (items.length) {
        const d = document.createElement('div'); d.className = 'ws-line ws-notver';
        const kk = document.createElement('span'); kk.className = 'ws-k'; kk.textContent = 'check yourself';
        const vv = document.createElement('span'); vv.className = 'ws-v';
        const addItem = (t) => { const li = document.createElement('div'); li.className = 'ws-nvitem'; li.textContent = t; vv.appendChild(li); };
        items.slice(0, 4).forEach(addItem);
        if (items.length > 4) {
          const more = document.createElement('button'); more.type = 'button'; more.className = 'ws-more';
          more.textContent = '+ ' + (items.length - 4) + ' more';
          more.onclick = () => { more.remove(); items.slice(4).forEach(addItem); autoscroll(); };
          vv.appendChild(more);
        }
        d.appendChild(kk); d.appendChild(vv); r.body.appendChild(d);
      }
    }
    // per-command verification detail: the ACTUAL commands run + each one's pass/fail from the manifest
    // (renders only when the manifest actually recorded them — never invents a command or a result).
    if (vcmds && vcmds.length) {
      const vd = document.createElement('div'); vd.className = 'ws-verdetail';
      vcmds.forEach(c => {
        const ok = Number(c.exit) === 0;
        const line = document.createElement('div'); line.className = 'ws-vcmd ' + (ok ? 'ok' : 'bad');
        const mark = document.createElement('span'); mark.className = 'ws-vmark'; mark.textContent = ok ? '✓' : '✕';
        const cmd = document.createElement('code'); cmd.className = 'ws-vcmdtext'; cmd.textContent = String(c.cmd);
        line.appendChild(mark); line.appendChild(cmd);
        if (!ok && c.exit != null) { const ex = document.createElement('span'); ex.className = 'ws-vexit'; ex.textContent = 'exit ' + c.exit; line.appendChild(ex); }
        vd.appendChild(line);
      });
      r.body.appendChild(vd);
    }

    // ── the files — every row's click ACTUALLY WORKS (2026-07-15 UX audit: the old "open in your default
    // app" affordance was a guaranteed dead end — OS-launch is deliberately impossible from a run). Now:
    //   .html and browser-renderable media → the jailed /workshop-run/ tab (runs/renders read-only);
    //   everything else → the inline reader, right here in the card. No promise the station can't keep.
    const TAB_RE = /\.(html?|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav|txt|csv|log|json)$/i;
    const fb = document.createElement('div'); fb.className = 'ws-pane ws-files';
    const fhead = document.createElement('div'); fhead.className = 'ws-fhead'; fhead.textContent = 'files' + (files.length ? ' · ' + files.length : '');
    fb.appendChild(fhead);
    const list = document.createElement('div'); list.className = 'ws-flist';
    const view = document.createElement('pre'); view.className = 'ws-fview'; view.hidden = true;   // hidden until a file is viewed inline
    if (!files.length) { const e = document.createElement('div'); e.className = 'dim'; e.textContent = '(no files listed)'; list.appendChild(e); }
    const viewInline = async (b, relPath) => {
      list.querySelectorAll('.ws-file.sel').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      view.hidden = false; view.textContent = 'loading…';
      let content = '';
      try { content = opts.readFile ? await opts.readFile(agentId, m.runId, relPath) : ''; } catch (_) { content = ''; }
      view.textContent = content || '(no preview available)';
      autoscroll();
    };
    files.forEach(f => {
      if (!f || !f.path) return;
      const inTab = TAB_RE.test(f.path);
      const rowEl = document.createElement('div'); rowEl.className = 'ws-filerow';
      const b = document.createElement('button'); b.className = 'ws-file'; b.type = 'button';
      b.textContent = f.path + (f.bytes != null ? '  ·  ' + f.bytes + 'B' : '');
      b.title = inTab ? 'open this file in a new tab' : 'read this file here';
      b.onclick = () => { if (inTab) openRunTab(f.path); else viewInline(b, f.path); };
      rowEl.appendChild(b);
      if (inTab) {   // a tab-openable file keeps the inline reader as the opt-in secondary (read the code without leaving)
        const src = document.createElement('button'); src.className = 'ws-viewsrc'; src.type = 'button'; src.textContent = 'view source';
        src.title = 'show this file’s contents inline';
        src.onclick = () => viewInline(b, f.path);
        rowEl.appendChild(src);
      }
      list.appendChild(rowEl);
    });
    fb.appendChild(list); fb.appendChild(view);
    r.body.appendChild(fb);

    // ── WHAT IMPLEMENT WILL DO — the server-resolved plan (current blessed roots), stated BEFORE the click.
    // A patch that can't auto-apply is the loudest case: the old card let "files saved" read as an apply.
    const plan = (m.implementPlan && typeof m.implementPlan === 'object') ? m.implementPlan : null;
    /* IMPLEMENT-AS-BUILD (2026-08-14): a deliverable that DESCRIBES work (a backlog, spec, plan) used to make
       Implement a pure file copy — press it on a backlog and a .md appeared in a folder, nothing else happened.
       For those, Implement now also RUNS the build that does the work. Three conditions, all required:
         • not already an implementation (m.implementOf) — otherwise plan→build→"build it again" recurses forever;
         • not a patch — a patch's implement is the apply, which really does change the project;
         • the shift declared planOnly:true … or, for a build from BEFORE that field existed (planOnly absent,
           never false), the conservative guess: an inert doc/other with no runnable entry point. A build that
           says planOnly:false is taken at its word — the guess never overrides a declaration. */
    const buildable = !!opts.onImplement && !m.implementOf && m.kind !== 'patch'
      && (m.planOnly === true
        || (m.planOnly === undefined && (m.kind === 'doc' || m.kind === 'other') && !htmlEntry));
    if (plan && plan.action === 'apply') {
      const pl = document.createElement('div'); pl.className = 'ws-line ws-plan';
      pl.textContent = 'implement → applies this patch to a NEW branch in ' + plan.root + ' (your current branch is untouched)';
      r.body.appendChild(pl);
    } else if (plan && m.kind === 'patch') {
      const pl = document.createElement('div'); pl.className = 'ws-line ws-capture-warn';
      pl.textContent = '⚠ this patch can’t be auto-applied (' + (plan.patchRefused || 'no valid target') + '). '
        + 'The button below only SAVES the .patch file — bless the target project in PROJECTS to enable auto-apply.';
      r.body.appendChild(pl);
    } else if (buildable) {
      // A PLAN is not the deliverable — copying its .md into a folder is the "regular save button" outcome this
      // action exists to replace, and the file is already archived AND readable from the list above. So say what
      // actually happens: a build runs. Nothing is copied. ("this plan" only when the shift DECLARED it one.)
      const pl = document.createElement('div'); pl.className = 'ws-line ws-plan';
      pl.textContent = '→ ' + who + ' builds ' + (m.planOnly === true ? 'this plan' : 'what this describes')
        + '. Nothing is copied to a folder — the result arrives as its own card.';
      r.body.appendChild(pl);
    } else if (plan && plan.dest) {
      const pl = document.createElement('div'); pl.className = 'ws-line ws-plan';
      pl.textContent = 'implement → saves the files to ' + plan.dest;
      r.body.appendChild(pl);
    }

    // ── decide: one optional input + Implement / Later / Discard ──
    const acts = document.createElement('div'); acts.className = 'turnin-rate ws-acts';
    /* THE INPUT HAS TWO MEANINGS, and the card must not lie about which one is live:
         • ordinary card  → a MESSAGE. It rides the decision as a REAL user turn in this session (the session id is
           the shift's durable streamId, so the agent replies with the build's actual transcript behind it).
         • buildable card → a BUILD STEER. A plan usually lists several things and this is the Commander's ONLY
           chance to say WHICH, so the text goes into the implement prompt instead of the chat stream.
       Why not both (2026-08-14): sending it as a chat turn AND starting a build fires TWO model runs at once — the
       agent answers in COMMS while the build that needed the instruction never hears it. The steer path wins. */
    const msgInput = document.createElement('input'); msgInput.className = 'turnin-edit ws-msg'; msgInput.type = 'text';
    // the placeholder must FIT: at the card's own type scale the long form clipped mid-word in a
    // COMMS column, which reads as a broken field rather than an optional one.
    msgInput.placeholder = buildable ? ('what should ' + who + ' build first? (optional)') : ('message ' + who + ' (optional)');
    msgInput.setAttribute('aria-label', buildable
      ? 'Optional instruction telling the agent which part of this plan to build'
      : 'Optional message to the agent, sent with your decision');
    acts.appendChild(msgInput);

    let settled = false;
    // settle: flash the outcome on the card, then the card leaves and ONE honest line stays in the feed.
    // destPath (when the decision landed files) adds copy-path / reveal-folder chips to that line — the old
    // flow stranded the user with a long un-clickable path (2026-07-15 UX audit).
    // returns a promise that resolves once the card has VANISHED and its one honest line is in the feed — an
    // implement-as-build appends its outcome after that, so a fast failure can never print before the
    // "…is building it now" line it is the outcome of (live DOM check, 2026-08-14).
    const settle = (label, isDeny, destPath) => {
      if (settled) return Promise.resolve(); settled = true;
      acts.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      r.body.appendChild(tag);
      return new Promise((resolveSettled) => setTimeout(() => {
        vanish(r.d);
        if (!inOwnSession()) { resolveSettled(); return; }
        const lr = row('system'); lr.body.textContent = label;
        if (destPath) {
          const chips = document.createElement('span'); chips.className = 'consent-btns ws-destchips';
          const cp = document.createElement('button'); cp.className = 'consent-btn'; cp.textContent = 'copy path';
          cp.onclick = () => {
            const done = () => { cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy path'; }, 1400); };
            try { navigator.clipboard.writeText(destPath).then(done, done); } catch (_) { done(); }
          };
          chips.appendChild(cp);
          const core = tauriCore();   // desktop shell only — a real Explorer/Finder reveal exists there
          if (core && core.invoke) {
            const rv = document.createElement('button'); rv.className = 'consent-btn'; rv.textContent = '📂 open folder';
            rv.onclick = () => { Promise.resolve(core.invoke('starnet_reveal_path', { path: destPath })).catch(err => { if (/declined at the host/i.test(String(err || ''))) return; rv.textContent = 'could not open'; setTimeout(() => { rv.textContent = '📂 open folder'; }, 1600); }); };
            chips.appendChild(rv);
          }
          // UNDO KEEP (EL-11 #8) — reverse the copy-out: delete exactly the files Implement wrote to destPath and
          // return the build to pending. DESTRUCTIVE-CONTROLS LAW: the chip names its target folder AND its effect,
          // and single-arms (click to arm, click again to confirm) so it's never a one-tap accident. The resulting
          // line is driven by the SERVER's honest {removed, missing} — a file the user already moved reads as such,
          // never as a phantom removal.
          const un = document.createElement('button'); un.className = 'consent-btn deny'; un.textContent = 'undo keep';
          un.title = 'UNDO KEEP — removes the copied files from ' + destPath + ' and returns this build to pending';
          let unArmed = false;
          un.onclick = async () => {
            if (un.disabled) return;
            if (!unArmed) { unArmed = true; un.textContent = 'undo — remove these files?'; setTimeout(() => { if (!un.disabled) { unArmed = false; un.textContent = 'undo keep'; } }, 4000); return; }
            un.disabled = true; un.textContent = 'undoing…';
            let j = null;
            try {
              const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
              const headers = { 'Content-Type': 'application/json' }; if (tok) headers['X-StarNet-Token'] = tok;
              const rr = await fetch('/api/workshop/undo', { method: 'POST', headers, body: JSON.stringify({ agentId: agentId, runId: m.runId, destPath: destPath }) });
              j = await rr.json().catch(() => null);
              if (!rr.ok || !j || j.ok === false) j = null;
            } catch (_) { j = null; }
            if (!j) { un.disabled = false; unArmed = false; un.textContent = 'undo keep'; localLine('Could not undo this keep: the station kept the files.'); return; }
            // honest resulting state, straight from server truth.
            const nRemoved = (j.removed || []).length, nMissing = (j.missing || []).length;
            let done;
            if (nRemoved && !nMissing) done = '↩ keep undone — removed ' + nRemoved + ' file' + (nRemoved === 1 ? '' : 's') + ' from ' + (j.destPath || destPath) + '. This build is pending again.';
            else if (nRemoved && nMissing) done = '↩ keep undone — removed ' + nRemoved + ', but ' + nMissing + ' file' + (nMissing === 1 ? ' was' : 's were') + ' already moved or gone. This build is pending again.';
            else done = '↩ nothing to remove — those files were already moved or deleted' + (j.restored ? '. This build is pending again.' : '.');
            lr.body.textContent = done;   // replaces the label + chips (the destPath is gone, so its chips are moot)
            try { decideNote(done); } catch (_) {}
            autoscroll();
          };
          chips.appendChild(un);
          lr.body.appendChild(chips);
        }
        autoscroll();
        resolveSettled();
      }, 900));
    };
    const sendNote = () => {   // the optional typed message → a REAL user turn in this session
      // on a BUILDABLE card the input is a build steer, not a message: Implement consumes it into the prompt, and
      // Later/Discard must not quietly re-post "do the PowerShell one first" into COMMS as if it were chat.
      if (buildable) return;
      const msg = String(msgInput.value || '').trim();
      if (!msg || !inOwnSession()) return;
      send('About the “' + String(m.title || 'away build') + '” build you delivered: ' + msg);
    };
    const decideNote = (label) => { try { if (opts.noteDecision) opts.noteDecision(label); } catch (_) {} };

    // IMPLEMENT — decide keep. The label states the plan's REAL consequence (apply vs save), and the outcome
    // line is driven by the server's response: an apply says branch+repo; a patch that could only be SAVED
    // never reads as "implemented" (res.savedOnly — the fallback-honesty fields from handleWorkshopDecide).
    const patchSaveOnly = !!(plan && m.kind === 'patch' && plan.action !== 'apply');
    // gold PRIMARY when the click really implements; a fallback save stays neutral so the gold always means "accept"
    const implBtn = document.createElement('button'); implBtn.className = 'consent-btn' + (patchSaveOnly ? '' : ' ws-primary');
    // THE LABEL STATES THE CONSEQUENCE. One word "Implement" covered three different outcomes (apply a patch,
    // save files, run a build), so the button taught the Commander nothing and the explanatory line below had to
    // carry all of it. On a plan the action IS a build — say so.
    const implLabel = buildable ? 'Build it' : patchSaveOnly ? 'Save patch file' : 'Implement';
    implBtn.textContent = implLabel;
    implBtn.title = (plan && plan.action === 'apply') ? ('applies this patch to a new branch in ' + plan.root)
      : patchSaveOnly ? 'saves the .patch file only — it will NOT be applied to your project'
      : buildable ? ('has ' + who + ' BUILD what this describes — nothing is copied to a folder')
      : ('saves the files to ' + ((plan && plan.dest) || 'your StarNet deliverables folder'));
    // why a build can be refused, in the Commander's words — never a raw reason code.
    const implFailCopy = (reason) => {
      const r = String(reason || '');
      if (r === 'no-capability') return 'no model or key is available for unattended runs — set one in KEYS, then press ' + implLabel + ' again';
      if (r === 'source-gone') return 'this deliverable’s files are no longer on disk';
      if (r === 'queue-refused') return 'this work was discarded before, so the station won’t rebuild it';
      if (r === 'already-implemented') return 'this plan has already been built — its build is in your rail';
      if (r === 'already-an-implementation') return 'this build IS an implementation already — there is nothing further to build from it';
      if (r === 'no-manifest' || r === 'run-failed') return 'the build ran but produced nothing reviewable';
      if (r === 'manifest-stamp-failed') return 'the files landed, but the station could not durably prove their link to this plan';
      if (r === 'registration-failed') return 'the files landed, but the station could not durably register a reviewable build';
      if (r === 'built-source-retire-failed') return 'the build landed, but the station could not durably retire this source plan';
      if (r === 'unreachable' || r.indexOf('http') === 0) return 'the station couldn’t be reached';
      return r || 'the station refused';
    };
    implBtn.onclick = async () => {
      if (implBtn.disabled) return;
      implBtn.disabled = true; implBtn.textContent = buildable ? 'building…' : patchSaveOnly ? 'saving…' : 'implementing…';

      /* IMPLEMENT-AS-BUILD — a plan is NOT the deliverable, so this path never keeps: no file copy, and NO
         DECISION IS RECORDED YET. That second part is the important one. Keeping first retired the backlog item
         BEFORE the build ran, so a build that failed left the Commander with the plan already decided and the
         card gone — while the failure line told them to "press Implement again" at a card that no longer existed.
         Now the plan stays PENDING until a build actually lands; the SERVER retires it on success (it is the only
         side that knows the build landed). Failure leaves the card to try again, which is what the copy promises. */
      if (buildable) {
        // the typed text is this build's INSTRUCTION, not a chat message — it rides into the prompt (see msgInput).
        const steer = String(msgInput.value || '').trim();
        const starting = '▶ ' + who + ' is building ' + (steer ? '“' + steer + '”' : 'this') + ' now. The finished build arrives as its own card.';
        decideNote(starting);
        // start the build IMMEDIATELY, but only report its outcome after the card has settled into its feed line —
        // otherwise an instant refusal (no key, discarded) prints its "didn't finish" line ABOVE the line it answers.
        let buildP = null; try { buildP = Promise.resolve(opts.onImplement(steer)).catch(() => null); } catch (_) { buildP = Promise.resolve(null); }
        await settle(starting, false, '');
        const br = await buildP;
        if (br && br.reason === 'built') {
          const okLine = '✓ built — “' + String((br.manifest && br.manifest.title) || 'the build') + '” is waiting in your rail.';
          decideNote(okLine); localLine(okLine);
        } else {
          const bad = 'The build didn’t finish: ' + implFailCopy(br && br.reason)
            + '. This plan is still waiting — reopen this session to try again.';
          decideNote(bad); localLine(bad);
        }
        return;
      }

      // PLAIN KEEP (a patch apply, or an artifact that IS the deliverable) — the files landing is the whole action.
      let res = null; try { res = await onDecide('keep'); } catch (_) { res = { ok: false }; }
      if (!(res && res.ok)) {
        implBtn.disabled = false; implBtn.textContent = implLabel;
        localLine('Could not implement this: ' + ((res && res.error) || 'the station refused') + '.');
        return;
      }
      const saved = res.applied
        ? ('✓ implemented — applied to branch ' + (res.branch || '?') + (res.root ? (' in ' + res.root) : ''))
        : res.savedOnly
          ? ('⚠ patch file saved to ' + (res.destPath || 'your StarNet deliverables folder') + ' — NOT applied to your project')
          : ('✓ implemented — files saved to ' + (res.destPath || 'your StarNet deliverables folder'));
      decideNote(saved); sendNote(); settle(saved, false, res.applied ? '' : (res.destPath || ''));
    };
    acts.appendChild(implBtn);

    // LATER — dismiss; the session stays in the rail and the card returns next time this session opens.
    const laterBtn = document.createElement('button'); laterBtn.className = 'consent-btn'; laterBtn.textContent = 'Later';
    laterBtn.onclick = async () => { try { await onDecide('later'); } catch (_) {} sendNote(); settle('↩ left in the workshop — reopen this session any time to decide', false); };
    acts.appendChild(laterBtn);

    // DISCARD — the ONE confirm (single click to arm, second to confirm). Honest about its weight: discard
    // wipes the files AND denylists the idea so it is never rebuilt or re-proposed (UX audit: the old confirm
    // undersold a permanent decision).
    const discardBtn = document.createElement('button'); discardBtn.className = 'consent-btn deny'; discardBtn.textContent = 'Discard';
    discardBtn.title = 'delete these files and never rebuild or re-propose this idea';
    let armed = false;
    discardBtn.onclick = async () => {
      if (!armed) { armed = true; discardBtn.textContent = 'Discard forever?'; setTimeout(() => { if (!settled) { armed = false; discardBtn.textContent = 'Discard'; } }, 4000); return; }
      discardBtn.disabled = true;
      let res = null; try { res = await onDecide('discard'); } catch (_) { res = { ok: false }; }
      if (res && res.ok) { const done = '✕ discarded — this idea won’t be rebuilt or re-proposed'; decideNote(done); sendNote(); settle(done, true); }
      else { discardBtn.disabled = false; armed = false; discardBtn.textContent = 'Discard'; localLine('Could not discard this: ' + ((res && res.error) || 'the station kept it') + '.'); }
    };
    acts.appendChild(discardBtn);

    r.body.appendChild(acts);
    autoscroll();
  }

  // Cortex (M-mem.5b) — THE TURN-IN BEAT. After a run, reflection proposes durable memories; the Commander
  // decides Keep / Edit / Discard. Keep/Edit commit a real memory (the click IS the consent, §5.6); every
  // verdict feeds the agent's confidence. This is the gamified formation loop — the agent learns, you approve.
  function proposalCard(batch, ws) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    clearNudge();   // ONE post-run beat at a time: the turn-in owns the moment, so retire any curiosity nudge that beat it here
    if (activeTurnin && (!activeTurnin.node || !activeTurnin.node.isConnected)) activeTurnin = null;
    // one visible consent beat, EVER: a deck arriving over another deck OR over a live STUDY card queues (the
    // beat-slot arbiter is consulted so a memory deck can never stack on a study card — it renders the moment
    // the card resolves; memory keeps priority via the queue-first drain in the study card's done()). A deck
    // arriving over a FOCUSED FLOW (awakening/intake question, Dialogue panel) queues too — memory wins the
    // post-run moment, but never by stacking on top of a question the Commander is mid-answering.
    if (activeTurnin || turninBlocked() || slotMemoryDeck() === 'queue') {
      turninQueue.push(batch);
      updateTurninQueueNote();
      autoscroll();
      armTurninDrain();
      return;
    }
    renderTurninBatch(batch);
  }

  function updateTurninQueueNote() {
    if (!activeTurnin || !activeTurnin.queueNote) return;
    const waiting = turninQueue.length;
    // A passive counter (NOT a second beat — one-beat-at-a-time is untouched): naming that another
    // follow-up is queued keeps the ~1-2s inter-beat gap from reading as a hang/crash to a beginner.
    activeTurnin.queueNote.textContent = waiting
      ? (waiting === 1 ? '1 more follow-up after this…' : waiting + ' more follow-ups after this…')
      : '';
    activeTurnin.queueNote.hidden = !waiting;
  }

  // the FOCUSED-FLOW gate for the memory deck: an interview question (awakening/intake) or a focused Dialogue
  // panel owns the input AND the moment — the deck queues behind it. Mirrors studyBlocked MINUS isBusy: the
  // turn-in deliberately still renders while the next run streams (memory wins the post-run moment).
  function turninBlocked() {
    if (interview) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    return false;
  }
  // bounded re-drain for a deck queued behind a focused flow: endInterview kicks the queue immediately; this
  // retry covers the Dialogue-close and onboarding-end paths (delayed, never starved — armRateFallback-style).
  let turninDrainTimer = null;
  function armTurninDrain(tries) {
    if (turninDrainTimer) return;
    const t = (tries == null) ? 200 : tries;   // ~5min at 1.5s cadence
    if (t <= 0) return;
    turninDrainTimer = setTimeout(() => { turninDrainTimer = null; showNextTurnin(t - 1); }, 1500);
  }
  function showNextTurnin(drainTries) {
    if (activeTurnin) return;
    if (!turninQueue.length) return;
    if (turninBlocked()) { armTurninDrain(drainTries); return; }
    const next = turninQueue.shift();
    if (next) renderTurninBatch(next);
  }

  function renderTurninBatch(batch) {
    if (beatSlot) beatSlot.memoryShown();   // hard-claim the beat slot on EVERY deck-render path (idempotent)
    const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin');
    const beatHandle = beatCards && beatCards.claim({
      kind: 'memory', runId: batch.runId, node: head.d, data: batch, preclaimed: true,
      handoff: () => turninQueue.length > 0 ? 'memory' : null,
      onRelease: () => { if (beatCards) beatCards.releaseReservation('memory', batch.runId); }
    });
    if (!beatHandle) { if (head.d && head.d.parentNode) head.d.remove(); return; }
    const n = batch.proposals.length;
    const title = document.createElement('span'); title.className = 'turnin-title';
    const queueNote = document.createElement('span'); queueNote.className = 'turnin-queue'; queueNote.hidden = true;
    const slot = document.createElement('span'); slot.className = 'turnin-slot';
    head.body.appendChild(title);
    head.body.appendChild(queueNote);
    head.body.appendChild(slot);
    // RATE THE WORK first (the primary leveling beat), THEN curate memories below — two honest judgments, one card.
    if (batch.runId && !workRatedRuns.has(batch.runId) && !ratingRunSuperseded(batch.runId)) {
      const rate = document.createElement('div'); rate.className = 'turnin-rate';
      head.body.insertBefore(rate, slot);
      workRateControl(rate, batch.agentId || 'agent', batch.runId, () => vanish(rate));
    }

    const state = { node: head.d, queueNote, index: 0, beat: beatHandle };
    activeTurnin = state;
    updateTurninQueueNote();

    function finishBatch() {
      activeTurnin = null;
      beatHandle.decide();
      beatHandle.finish({ onGone: () => {
        showNextTurnin();
        // G2.4 starve hole 2: the deck (and its embedded control) just vanished — if the Commander
        // curated the memories but never rated the WORK, the standalone beat picks the rating up.
        if (batch.runId) maybeStandaloneRate(batch.agentId || 'agent', batch.runId);
      } });
    }
    function updateTitle() {
      title.textContent = '◈ ' + name + ' picked up ' + n + (n > 1 ? ' things' : ' thing') + ' worth remembering — review ' + (state.index + 1) + ' of ' + n;
    }
    function renderCurrent() {
      const prop = batch.proposals[state.index];
      if (!prop) { finishBatch(); return; }
      updateTitle();
      slot.innerHTML = '';
      const item = document.createElement('div'); item.className = 'turnin-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = prop.content;
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(kind); item.appendChild(text); item.appendChild(btns);
      slot.appendChild(item);

      let decided = false;
      function settle(label, isDeny) {
        decided = true; btns.remove();
        const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
        item.appendChild(tag);
        setTimeout(() => vanish(item, () => {
          state.index += 1;
          if (state.index >= n) finishBatch();
          else { renderCurrent(); autoscroll(); }
        }), 600);   // flash the verdict, then advance the deck instead of stacking more cards
      }
      async function submit(verdict, content, label, isDeny) {
        if (decided) return; decided = true;
        const r = await Harness.memoryTurnin({ agentId: batch.agentId, runId: batch.runId, id: prop.id, verdict, content });
        if (r && r.ok) settle(label, isDeny);
        else { decided = false; if (typeof StationUI !== 'undefined') StationUI.notify('could not save that ' + (prop.kind === 'skill' ? 'skill' : 'memory') + ' - try again', 'warn'); }
      }
      function mkBtn(label, cls, onClick) {
        const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = onClick; btns.appendChild(b); return b;
      }
      function renderChoices() {
        btns.innerHTML = '';
        mkBtn(prop.kind === 'skill' ? 'Save skill' : 'Keep', 'primary', () => submit('keep', null, prop.kind === 'skill' ? 'saved as skill' : 'kept in memory', false));
        mkBtn('Edit', '', enterEdit);
        mkBtn('Discard', 'deny', () => submit('discard', null, '✕ discarded', true));
      }
      // inline edit: swap the belief into an input; Save commits the edited text (verdict 'edit'), Cancel restores.
      function enterEdit() {
        if (decided) return;
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'turnin-edit'; inp.value = prop.content;
        item.replaceChild(inp, text); inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
        const commit = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } text.textContent = v; item.replaceChild(text, inp); submit('edit', v, prop.kind === 'skill' ? 'saved skill (edited)' : 'saved (edited)', false); };
        const cancel = () => { item.replaceChild(text, inp); renderChoices(); };
        btns.innerHTML = '';
        mkBtn('Save', '', commit);
        mkBtn('Cancel', '', cancel);
        inp.onkeydown = e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); };
      }
      renderChoices();
    }
    renderCurrent();
    autoscroll();   // the inline card IS the prompt — no extra toast (it just doubled the noise the card already shows)
  }

  // register ONCE: reflection announces proposals via the memory.proposed SSE event (re-emitted on U.bus). It
  // fires once per proposal, so debounce per-run, then fetch the full batch (with content) and render the beat
  // in the active stream when it's the proposing agent (else a soft notify — the agent learned something).
  function wireProposals() {
    if (proposalsWired || typeof U === 'undefined' || !U.bus) return;
    proposalsWired = true;
    // TWO triggers, ONE fetch+route (deduped per-run by proposalRunsSeen):
    //  - memory.proposed fires ONLY for HIGH-STAKES proposals (the rare-confirm deck). It reserves the beat slot
    //    BEFORE the fetch so study/arc/trust cede across the proposed→fetch→deck window (the fetch-gap race).
    //  - memory.write fires for the SILENTLY AUTO-SAVED memories (the common case). Those render a PASSIVE receipt
    //    that must NOT claim the beat slot — so this trigger reserves nothing.
    // A MIXED batch (some high-stakes) fires both; the shared guard renders it once (receipts + deck together).
    U.bus.on('memory.proposed', p => {
      const runId = p && p.runId; const agentId = (p && p.agentId) || 'agent';
      if (!runId || !beatCards || !beatCards.once('memory', runId)) return;
      slotMemoryProposed(runId);   // reserve the slot for the coming confirm deck (released if the fetch is deck-empty)
      setTimeout(() => routeProposalBatch(runId, agentId, true), 350);
    });
    U.bus.on('memory.write', p => {
      const runId = p && p.runId; const agentId = (p && p.agentId) || 'agent';
      // dedup vs BOTH the deck path (proposalRunsSeen, set by memory.proposed) and this receipt path. Deliberately
      // NOT added to proposalRunsSeen: a passive receipt is not a review DECK, so it must not suppress the run's
      // curiosity/suggestion nudge (the wireCuriosity guard keys on proposalRunsSeen = "a deck owns the moment").
      if (!runId || (beatCards && beatCards.hasSeen('memory', runId)) || receiptRunsSeen.has(runId)) return;
      receiptRunsSeen.add(runId);
      if (receiptRunsSeen.size > 200) receiptRunsSeen.delete(receiptRunsSeen.values().next().value);
      // NO slot reservation — receipts are passive log lines. A tiny debounce lets the per-record memory.write
      // events + the server-side batch stash settle before the single fetch (mirrors the proposed path's 350ms).
      setTimeout(() => routeProposalBatch(runId, agentId, false), 350);
    });
  }

  // fetch the run's batch and route it: SAVED items (saved:true) render passive receipts; PENDING items (the
  // high-stakes fallback) render the Keep/Edit/Discard confirm deck. `reservedSlot` = memory.proposed already
  // claimed the beat slot for a deck; if the fetch yields no deck items, release it.
  async function routeProposalBatch(runId, agentId, reservedSlot) {
    // MIXED-BATCH RACE: the server emits memory.write (auto-saves) BEFORE memory.proposed (high-stakes) for the
    // same run, so both triggers can schedule a route before either fires. At fire time the deck route owns the
    // whole render (receipts + deck together); the receipt-only route bails so nothing draws twice.
    if (!reservedSlot && beatCards && beatCards.hasSeen('memory', runId)) return;
    const lifecycle = beatCards, lifecycleGeneration = lifecycle && lifecycle.generation();
    const items = await Harness.memoryProposals(runId, agentId);
    if (!lifecycle || beatCards !== lifecycle || lifecycle.generation() !== lifecycleGeneration) return;
    const saved = items.filter(p => p && p.saved);
    const pending = items.filter(p => p && !p.saved);
    // route to the ORIGIN stream (many streams share agentId 'agent', so agentId-gating can drop the card into
    // the wrong COMMS after a mid-window switch).
    let originWs = null;
    if (typeof Workstreams !== 'undefined' && Workstreams.all) { try { originWs = Workstreams.all().find(w => (w.runIds || []).indexOf(runId) >= 0) || null; } catch (_) {} }
    const onActive = originWs ? (activeWs && activeWs.id === originWs.id) : (activeWs && (activeWs.agentId || 'agent') === agentId);

    if (onActive && saved.length) renderReceipts({ runId, agentId, proposals: saved });   // passive — no beat slot
    else if (saved.length && typeof StationUI !== 'undefined') {
      // origin stream not displayed (or gone): don't lose the transparency signal — the memories ARE saved, so
      // surface a soft notify instead of a receipt (Memory Core shows the records; ✕ undo lives there too).
      StationUI.notify('an agent remembered ' + saved.length + ' ' + (saved.length > 1 ? 'things' : 'thing'), 'gold');
    }
    if (pending.length) {
      const deck = { runId, agentId, proposals: pending };
      if (onActive) proposalCard(deck, activeWs);
      else {
        slotMemoryEmpty(runId);   // release the reserved claim — no deck renders on a non-displayed stream
        if (typeof StationUI !== 'undefined') StationUI.notify('an agent has ' + pending.length + ' ' + (pending.length > 1 ? 'memories' : 'memory') + ' to review', 'gold');
        maybeStandaloneRate(agentId, runId);
      }
    } else {
      // no deck will render. Release any reserved slot so study/arc/trust aren't wedged, and make sure the run's
      // rating still fires (the receipt carries no rate control — that lives on the standalone beat / deck).
      if (reservedSlot) slotMemoryEmpty(runId);
      maybeStandaloneRate(agentId, runId);
    }
  }

  // PASSIVE RECEIPT (silent-save UX): one compact non-blocking line per auto-saved memory — "◈ remembered: <text>"
  // + kind tag + a small ✕ veto. It does NOT claim the one-beat slot, does not wait for input, and stays in the
  // stream as a quiet log line (no auto-collapse). The ✕ UNDOES the save (record removed + text denylisted); the
  // line then shows a muted "✕ forgotten" (Memory Core Restore is the undo-for-the-undo). Reuses the gold-inset
  // turn-in visual family. Receipts render even during a focused flow (interview/onboarding) — they're passive
  // and carry no input to compete with, so unlike the confirm deck they don't gate behind turninBlocked().
  function renderReceipts(batch) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin'); head.d.classList.add('receipts');
    // ONE header owns the "remembered" claim; each line below is just the memory itself (repeating
    // "◈ remembered:" per line + a bordered box per line is what made the post-run feed read as stacked popups).
    const cap = document.createElement('div'); cap.className = 'receipt-head';
    cap.textContent = '◈ remembered · ' + batch.proposals.length;
    head.body.appendChild(cap);
    for (const prop of batch.proposals) {
      const item = document.createElement('div'); item.className = 'receipt-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'receipt-text'; text.textContent = prop.content;
      const veto = document.createElement('button'); veto.className = 'receipt-veto'; veto.type = 'button';
      veto.textContent = '✕'; veto.title = 'forget this — undo the save';
      veto.setAttribute('aria-label', 'forget this memory');
      let busy = false;
      veto.onclick = async () => {
        if (busy) return; busy = true; veto.disabled = true;
        const r = await Harness.memoryVeto({ agentId: batch.agentId, id: prop.id, kind: prop.kind, content: prop.content });
        if (r && r.ok) {
          veto.remove();
          item.classList.add('vetoed');
          text.textContent = 'forgotten: ' + prop.content;   // muted state; stays denylisted (Memory Core Restore is the undo)
        } else {
          busy = false; veto.disabled = false;
          if (typeof StationUI !== 'undefined') StationUI.notify('could not forget that ' + (prop.kind === 'skill' ? 'skill' : 'memory') + ' - try again', 'warn');
        }
      };
      item.appendChild(kind); item.appendChild(text); item.appendChild(veto);
      head.body.appendChild(item);
    }
    autoscroll();
  }

  // R1 MID-TASK FORK — the answer that IS work: render the agent's preference fork as one-tap chips. The
  // pick does double duty — it banks as a Commander-authored STYLE belief (full confidence weight: given in
  // context, about a real decision, immediately acted on; + the R4 receipt proves it stuck) AND continues
  // the conversation as the Commander's next message so the task proceeds with it. "you decide" banks
  // nothing and hands the choice back. One fork per reply by construction (parse reads the first marker).
  function offerFork(fk) {
    clearNudge();   // same law as offerTaskQuestion: the fork claims the moment; a live nudge leaves WITH its chips
    const items = fk.options.map(o => ({ label: o, value: o }));
    items.push({ label: 'you decide', value: '', skip: true });
    const q = row('agent'); q.d.classList.add('nudge');
    q.body.textContent = '⌖ ' + fk.question;
    autoscroll();
    choices(items, item => {
      vanish(q.d);
      const ans = (item && !item.skip) ? String(item.value || '').trim() : '';
      if (ans) {
        try {
          const bt = Fork.beliefText ? Fork.beliefText(fk.question, ans) : ans;
          if (bt && typeof DossierStore !== 'undefined' && DossierStore.upsert) {
            DossierStore.upsert('style', { text: bt, source: 'commander' });
            briefingReceipt('style');
            // re-read NOW so the gate re-evaluates before the continuation run composes its prompt —
            // one banked answer usually grounds the style model and retires the fork directive.
            if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.refresh) { try { UnderstandingStore.refresh(false); } catch (_) {} }
          }
        } catch (_) {}
      }
      const msg = ans || 'either works — your call.';
      if (!isBusy()) send(msg); else echoUser(msg);   // continue the task with the answer (busy = a rare race; the echo still records it)
    });
  }

  // A task-specific decision resumes the sidecar-owned brief. It is deliberately NOT banked into the global dossier.
  let pendingTaskQuestion = null;
  // Is an unanswered Task Brief question up on the DISPLAYED stream? The run itself stopped to ask it, so it
  // OWNS the COMMS moment: no gentle beat (curiosity / suggestion / north-star / quest-attest nudge) may claim
  // the slot while it waits — nudge()'s choices() would clearChoices() the question's own answer chips, leaving
  // the question as dead text and forcing the Commander to re-ask the task (live-caught 2026-07-19). Cleared by
  // the next send() on that stream (answering OR typing anything releases the moment).
  function taskQuestionLive() {
    return !!(pendingTaskQuestion && activeWs && pendingTaskQuestion.streamId === activeWs.id);
  }
  function offerTaskQuestion(tq) {
    clearNudge();   // the question CLAIMS the moment: a live gentle nudge leaves whole (prompt + chips) — its chip
                    // row would be wiped by choices() below anyway, and a stuck activeNudge would mute beats forever
    pendingTaskQuestion = Object.assign({}, tq, { streamId: activeWs && activeWs.id });
    if(tq.mode==='conversation' && typeof TaskConversation!=='undefined') {
      clearChoices(); // Retire a stale retry action: the next user input answers this saved question.
      const ws=activeWs, r=row('agent');r.d.classList.add('nudge');
      TaskConversation.mount(r.body,tq,async text=>{
        if(!isActiveWs(ws) || isBusy())return false;
        // send() routes this whole answer back into the same durable brief.
        send(text);vanish(r.d);return true;
      });
      autoscroll();return;
    }
    // TWO KINDS of suggestion, and they must never be confused. GROUNDED comes from the Commander's own
    // answered history (taskBriefStore.groundedFor: same question, same option, >=2 times, no tie) — provable,
    // so it outranks the model's assertion and states its count. The model's brief_ask recommendation is a
    // guess with a rationale; it stands only when nothing was actually observed.
    // NOTE: a marker-path question stores no `recommended`, but it CAN still carry a grounded suggestion —
    // that one is derived from the Commander's answers, not from the unvalidated question, so it stays honest.
    // Only the model's own guess is gated on the validated path.
    const g = (tq.grounded && tq.grounded.option && Number(tq.grounded.count) >= 2) ? tq.grounded : null;
    const has = v => !!v && tq.options.some(o => o.toLowerCase() === String(v).trim().toLowerCase());
    // A multi-select question's grounded suggestion is a SET, so several options can be starred at once;
    // an exclusive one still stars exactly the single observed favourite.
    const gSet = (g && Array.isArray(g.options) ? g.options : (g ? [g.option] : [])).filter(has);
    const useGrounded = gSet.length > 0;
    // Fall back to the model's guess if the grounded option is not among the rendered choices (stale history,
    // edited options) — otherwise a mismatch would silently cost BOTH the chip and the model's rationale.
    const starSet = useGrounded ? gSet.map(o => o.toLowerCase())
      : (has(tq.recommended) ? [String(tq.recommended).trim().toLowerCase()] : []);
    const items = tq.options.map(o => {
      const suggested = starSet.indexOf(o.toLowerCase()) >= 0;
      return { label: suggested ? '★ ' + o : o, value: o, suggested };
    });
    const isMulti = tq.multiSelect === true;
    if (isMulti) items.push({ label: '✔ confirm picks', value: '', confirm: true });
    items.push({ label: 'use your judgment', value: '', skip: true });
    const q = row('agent'); q.d.classList.add('nudge');
    q.body.textContent = '⌖ ' + tq.question;
    const marked = items.some(it => it.suggested);
    const why = marked ? (useGrounded
      ? (gSet.length > 1
        ? '★ you usually pick these — ' + gSet.join(', ') + ' (chosen ' + g.count + '+ times before)'
        : '★ suggested: ' + gSet[0] + ' — you chose this ' + g.count + ' times before')
      : (String(tq.reason || '').trim() ? '★ suggested: ' + tq.recommended + ' — ' + String(tq.reason).trim() : '')) : '';
    if (why) {
      const el = document.createElement('div'); el.className = 'tq-reason' + (useGrounded ? ' grounded' : '');
      el.textContent = why;
      q.body.appendChild(el);
    }
    // The chips read as "pick exactly one", but a TYPED reply has always been a first-class answer here: while
    // a question is pending, free text routes through TaskIntent.routeReply and is stored verbatim as the
    // answer. So "both operators and executives" already worked — nothing said so. This is the same escape
    // hatch the channels spell out in text, and it covers "more than one" and "none of these" alike.
    // Worded without a direction: this line sits ABOVE the chip row (choices() appends that to the log after
    // this body), so "below" would have pointed at the composer past the very options it is an alternative to.
    const hint = document.createElement('div'); hint.className = 'tq-hint';
    hint.textContent = isMulti
      ? 'these aren\'t exclusive — tap all that apply, then confirm; or type your own answer'
      : 'or ignore these and type your own answer — more than one is fine';
    q.body.appendChild(hint);
    autoscroll();
    choices(items, item => {
      vanish(q.d);
      const ans = (item && item.confirm) ? (item.values || []).join(', ')
        : (item && !item.skip) ? String(item.value || '').trim() : '';
      const msg = (typeof TaskIntent !== 'undefined' && TaskIntent.answerMessage)
        ? TaskIntent.answerMessage(tq.question, ans)
        : (ans || 'Use your judgment and continue the original task.');
      if (!isBusy()) send(msg, { taskAction: 'answer' }); else echoUser(msg);
    }, { multi: isMulti });
  }

  // TASTE EXTRACTION (announce-and-act): the model settled its Task Brief mid-run — surface its READ
  // (objective + correctable assumptions, incl. taste guesses) as a NON-BLOCKING card while the run keeps
  // working. A typed correction folds into the LIVE run via /api/run/steer; when the run has already ended
  // the card says so honestly instead of pretending to steer. Registers exactly once.
  let readWired = false;
  function wireBriefRead() {
    if (readWired || typeof U === 'undefined' || !U.bus) return;
    readWired = true;
    U.bus.on('taskbrief.settled', p => {
      const ws = activeWs;
      if (!ws || !isActiveWs(ws)) return;
      const rid = (typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(ws.id) : null;
      if (!rid || rid !== p.runId) return;   // only the displayed stream's own live run announces here
      briefReadCard(ws, p);
    });
  }
  /* SPENT-BRIEF FOLD (2026-07-27). The "my read" card is a PRE-RUN contract: its meta rows, its assumption
     chips and its steer box all exist so the Commander can argue with the read BEFORE the work happens. Once
     the run it describes has resolved, none of that can act any more — but the card kept its full height
     forever, so a finished run left ~40% of the visible transcript occupied by a control surface that no
     longer controls anything (and whose chips still said "tap to correct", a promise only send() ever
     retracted). At run end each live card retires its own affordances and folds to its headline, keeping the
     same click-to-expand vocabulary as the resolved run line above it. Nothing is deleted — one click and the
     whole read is back, so the transcript stays a complete record. */
  let briefCards = [];
  function foldBriefCards() {
    const cards = briefCards; briefCards = [];
    for (const close of cards) { try { close(); } catch (_) { /* a detached card must never break run teardown */ } }
  }
  /* ⛔ LIVE VOICE RENDERS NO CLICKABLE PROMPTS (Andrew, 2026-07-30: "it should not give the same clickable
     popups, it should just directly ask the user — live mode is different from regular session mode").
     While a call is live, the interactive beats — the tap-to-correct brief card and choice-chip rows — are
     SUPPRESSED, not narrated: the agent's own spoken words are the ask, and the Commander's spoken words
     are the answer. The consent/approval card is deliberately NOT suppressed: it is the durable record of a
     permission decision, and live mode asks it aloud (voice-live announceWaits) and answers it by voice. */
  function liveVoiceCall() {
    try { return typeof VoiceLive !== 'undefined' && VoiceLive.isActive && VoiceLive.isActive(); } catch (_) { return false; }
  }
  function liveVoiceOwns(ws) {
    if (!liveVoiceCall()) return true;
    // Fail closed during a live call: only the session captured when the call opened may use the
    // shared speaker/coordinator. A rail click changes the visible session, never call ownership.
    try {
      const bound = VoiceLive.boundSessionId && VoiceLive.boundSessionId();
      return !!(bound && ws && String(ws.id) === String(bound));
    } catch (_) { return false; }
  }
  function briefReadCard(ws, p) {
    if (liveVoiceCall()) return;   // in a call the read is not a form — the agent says what it heard, or asks
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('tb-read');
    // The label is its own small caption, NOT a prefix on the objective: "▸ my read: " used to eat the front of
    // the one line that matters, so the objective started mid-sentence at caption size. Caption above, objective
    // as the card's headline.
    const cap = document.createElement('div'); cap.className = 'tb-read-cap';
    cap.textContent = 'my read';
    // the fold handle — inert (and invisible) until the run ends and closeCard() arms it
    const chev = document.createElement('span'); chev.className = 'tb-read-chev'; chev.setAttribute('aria-hidden', 'true'); chev.textContent = '▸';
    cap.appendChild(chev);
    r.body.appendChild(cap);
    const head = document.createElement('div'); head.className = 'tb-read-head';
    head.textContent = p.objective;
    r.body.appendChild(head);
    // Key/value ROWS, not a ' · '-joined run-on: these three answer different questions (what comes out / who it's
    // for / when it's done) and each value is a full clause, so a single wrapped line made them unscannable.
    const meta = [];
    if (p.deliverable) meta.push(['deliverable', p.deliverable]);
    if (p.audience) meta.push(['for', p.audience]);
    if (p.success) meta.push(['done when', p.success]);
    if (meta.length) {
      const m = document.createElement('div'); m.className = 'tb-read-meta';
      for (const [k, v] of meta) {
        const mr = document.createElement('div'); mr.className = 'tb-read-mrow';
        const mk = document.createElement('span'); mk.className = 'tb-read-mk'; mk.textContent = k + ' — ';   // separator lives in REAL text, not a ::after — #chat-log is a selectable transcript and generated content doesn't copy
        const mv = document.createElement('span'); mv.className = 'tb-read-mv'; mv.textContent = v;
        mr.appendChild(mk); mr.appendChild(mv); m.appendChild(mr);
      }
      r.body.appendChild(m);
    }
    const line = document.createElement('div'); line.className = 'tb-read-fix';
    const input = document.createElement('input'); input.className = 'tb-read-in';
    input.placeholder = 'correct anything — it folds straight into the run';
    const chips = [];
    const asum = (Array.isArray(p.assumptions) ? p.assumptions : []).filter(Boolean);
    if (asum.length) {
      // The chips carried no affordance copy — a dim '~ …' row reads as decoration, not as "tap this to argue".
      const acap = document.createElement('div'); acap.className = 'tb-read-cap tb-read-cap2';
      acap.textContent = 'assuming — tap to correct';
      r.body.appendChild(acap);
      const wrap = document.createElement('div'); wrap.className = 'tb-read-assumps';
      for (const a of asum) {
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'tb-read-assump'; chip.textContent = a;
        chip.onclick = () => { input.value = 'Not "' + a + '" — '; input.focus(); };   // tap = start the correction; the user's own words ARE the taste signal
        wrap.appendChild(chip);
        chips.push(chip);
      }
      r.body.appendChild(wrap);
    }
    // Once the card can no longer steer, the chips must stop LOOKING like they can. They live on r.body while
    // the input lives on `line`, so replacing the line's contents used to detach the input and leave every chip
    // still lit — tapping one then wrote into a detached node and focused nothing, a promise the copy made
    // ("tap to correct") and the card silently broke.
    const retire = () => { for (const c of chips) { c.disabled = true; c.title = 'this read is closed — say it in chat instead'; } };
    const send = () => {
      const text = input.value.trim(); if (!text) return;
      const rid = (typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(ws.id) : null;
      if (!rid) { input.value = ''; input.placeholder = 'run already finished — say it in chat instead'; retire(); return; }
      fetch('/api/run/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: rid, text: text }) })
        .then(res => res.ok ? res.json() : null)
        .then(d => {
          const ok = d && d.ok === true;
          line.innerHTML = '';
          const tag = document.createElement('span'); tag.className = 'tb-read-ack' + (ok ? '' : ' err');
          tag.textContent = ok ? '✔ folded into the run — ' + text : '✕ the run already ended — say it in chat instead';
          line.appendChild(tag);
          retire();
        })
        .catch(() => { input.placeholder = 'could not reach the run — say it in chat'; });
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    line.appendChild(input);
    r.body.appendChild(line);
    // Run over → retire what can no longer act, then fold to the headline. The steer box is replaced only when
    // it's still the live input: a send() that already landed owns `line` and its ✔/✕ receipt must survive.
    const closeCard = () => {
      retire();
      if (input.isConnected) {
        line.textContent = '';
        const t = document.createElement('span'); t.className = 'tb-read-ack closed';
        t.textContent = 'this read is closed — say it in chat instead';
        line.appendChild(t);
      }
      r.d.classList.add('tb-read-spent', 'folded');
      cap.setAttribute('role', 'button'); cap.tabIndex = 0; cap.setAttribute('aria-expanded', 'false');
      cap.title = 'show the full read';
      const toggle = () => {
        const open = !r.d.classList.toggle('folded');
        cap.setAttribute('aria-expanded', open ? 'true' : 'false');
        cap.title = open ? 'fold this read away' : 'show the full read';
      };
      cap.addEventListener('click', toggle);
      cap.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    };
    briefCards.push(closeCard);
    autoscroll();
  }

  // TASK BRIEF v2: enrich a run-end marker question with the durable brief's host-validated recommendation
  // before rendering the chips. Safe ordering: the sidecar persists the question BEFORE it emits the buffered
  // task run-end, so one fetch here always sees the stored row. Fail-open on every path — offline sidecar,
  // mismatched text, or a marker-path question (no MODEL recommendation stored) renders exactly the plain
  // chips — though a marker question may still carry a grounded suggestion, which comes from the Commander's
  // own answered history rather than from the unvalidated question.
  async function presentTaskQuestion(ws, tq) {
    let recommended = '', reason = '', grounded = null, multiSelect = false, options = null, conversation = {};
    try {
      const r = await fetch('/api/task-briefs?key=' + encodeURIComponent('stream:' + ws.id) + '&status=clarifying&limit=1', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const b = j && Array.isArray(j.briefs) && j.briefs[0];
        // FIRST unanswered, not last: a batched ask's durable fallback re-asks the earliest open question,
        // so that is the stored row this marker corresponds to (identical for single-question briefs).
        const qs = (b && Array.isArray(b.questions)) ? b.questions : [];
        const q = qs.find(x => x && !x.answer) || qs[qs.length - 1];
        if (q && !q.answer && q.text === tq.question) {
          recommended = q.recommended || ''; reason = q.reason || '';
          conversation={mode:q.mode,sample:q.sample,context:b.context};
          multiSelect = q.multiSelect === true;
          grounded = j.grounded || null;   // this response always carried it; the client used to drop it
          // The MARKER line is capped at 3 options (it is the unvalidated last-resort format), so a
          // 6-option multi-select arrived here already truncated. The stored question is authoritative.
          if (Array.isArray(q.options) && q.options.length > (tq.options || []).length) options = q.options.slice();
        }
      }
    } catch (_) { /* enrichment only — the question itself never depends on this fetch */ }
    if (!isActiveWs(ws)) return;   // the Commander switched away mid-fetch; restoreTaskQuestion re-presents on return
    offerTaskQuestion(Object.assign({}, tq, { recommended, reason, grounded, multiSelect }, options ? { options } : {},conversation));
  }

  // R4 PAYOFF RECEIPT: one provable line at the exact moment an answer/observation lands in the dossier, so
  // feeding the station visibly pays off. Truthful by construction: the dossier block folds into EVERY agent's
  // system prompt (DossierStore.composeBlock), so "every agent now knows" states the wiring, not a wish. Same
  // passive gold-inset receipt family as renderReceipts — never claims the beat slot, carries no input. No veto:
  // the dossier belief it points at is edited/forgotten in the COMMANDER panel, which stays the one owner of undo.
  function briefingReceipt(dim) {
    try {
      const d = (typeof Dossier !== 'undefined' && Dossier.DIMS) ? Dossier.DIMS.find(x => x.key === dim) : null;
      const label = d ? String(d.label).toLowerCase() : 'profile';
      const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin'); head.d.classList.add('receipts');
      const item = document.createElement('div'); item.className = 'receipt-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = 'BRIEFING';
      const text = document.createElement('span'); text.className = 'receipt-text';
      text.textContent = '◈ briefing updated — every agent on this station now knows your ' + label + '.';
      item.appendChild(kind); item.appendChild(text);
      head.body.appendChild(item);
      autoscroll();
    } catch (_) {}
  }

  /* GROWTH Tier 1 — THE STUDY BEAT (dossier Phase B: work → understanding). After a salient run the sidecar
     studies the transcript and stashes DOSSIER belief-update proposals; here we fetch them and — at TURN-IN
     PRIORITY but NEVER stacking a second beat — offer ONE for Keep / Edit / Discard. Keep folds the belief into
     the dossier (source:'study'); Discard denylists it forever; leaving it undecided tallies an ignore (2× =
     stop). ONE-BEAT DISCIPLINE: the memory turn-in and the study card arrive on different clocks (memory.proposed
     lands only after reflection's LLM round-trip), so both sides route every render/queue decision through the
     PURE beat-slot arbiter (Study.makeBeatSlot — behaviorally tested in study.test.js). MEMORY WINS: while any
     reflection is proposed-but-unresolved study cedes; a memory deck arriving over a visible study card QUEUES
     and renders the moment the card resolves; a deferred study re-offers at the next task end. */
  let beatCards = null;              // shared lifecycle: one slot, dedupe, expiry/vanish, stale-async guard
  let beatSlot = null;               // compatibility view used by the arc lane while it migrates
  function studyBusy() { return !!(beatCards && beatCards.busy('study')); }
  // null-safe slot wrappers (Study may be absent under old bundles — memory then behaves exactly as before).
  function slotMemoryProposed(runId) { if (beatSlot) beatSlot.memoryProposed(runId); }
  function slotMemoryDeck() { return beatSlot ? beatSlot.memoryDeck() : 'render'; }
  function slotMemoryEmpty(runId) { if (beatSlot) beatSlot.memoryEmpty(runId); }
  /* Every slot predicate takes an OPTIONAL self-key (the collection pass's runId). A pass that RESERVES its own
     fetch-backed kinds across an await must not then be told by its own reservation that it may not speak — that
     self-veto is what killed the thread channel outright (beatcard.js can(), 2026-08-04). Called with no key
     (every non-pass caller) the behavior is byte-identical to before. */
  function slotCanStudy(selfKey) { return beatSlot ? beatSlot.canStudy(selfKey) : 'busy'; }   // no arbiter -> study stands down
  // GROWTH Tier 2 — the goal-arc confirm beat: the LOWEST-priority participant (memory turn-in + study both win
  // first). null arbiter OR an older bundle without canArc -> arc stands down (byte-identical pre-Tier-2 behavior).
  function slotCanArc(selfKey) { return (beatSlot && beatSlot.canArc) ? beatSlot.canArc(selfKey) : 'busy'; }
  // GROWTH Tier 3 — the earned-autonomy offer beat: the LOWEST-priority participant (memory + study + arc all win
  // first). null arbiter OR an older bundle without canTrust -> trust stands down (byte-identical pre-Tier-3 behavior).
  function slotCanTrust(selfKey) { return (beatSlot && beatSlot.canTrust) ? beatSlot.canTrust(selfKey) : 'busy'; }
  // NS-6 — the THREAD turn-in beat: the LOWEST-priority participant (memory > study > arc > trust > thread —
  // study always wins the moment first). null arbiter OR an older bundle without canThread -> thread stands down.
  function slotCanThread(selfKey) { return (beatSlot && beatSlot.canThread) ? beatSlot.canThread(selfKey) : 'busy'; }
  // the same stand-down guards the curiosity slot honors (First Pitch lesson): a study card must never render
  // mid-awakening/interview/tutorial-panel or while the next run is already streaming. Blocked = queue, not drop.
  function studyBlocked() {
    if (isBusy() || interview) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    return false;
  }
  /* THE ONE STAND-DOWN SET (recommendation spine, S3). The five old post-run listeners each carried a
     near-duplicate guard set (studyBlocked / arcBlocked / the wireCuriosity ladder's preamble). This is
     their union and the single gate the recommendation pass consults: the study/arc/trust/thread guards
     verbatim, PLUS the unanswered-task-question rule the gentle beats already honored inside nudge() /
     curiosityNudge() — a proactive card must never steal a live question's answer chips. */
  function momentBlocked() { return studyBlocked() || taskQuestionLive(); }
  /* the EXTRA floor the gentle + rate half has always carried (and the turn-in beats never did): this run
     produced a memory turn-in, or a real turn-in deck is still sitting in the feed. Scoped to REAL decks —
     the away-digest reuses .turnin-item for styling and must not suppress a fresh run's ask (G2.4). */
  function turninOwnsMoment(runId) {
    if (runId && beatCards && beatCards.hasSeen('memory', runId)) return true;
    return !!(log && log.querySelector('.cmsg.turnin:not(.away-digest) .turnin-item'));
  }
  // defer a study offer for a later moment — SINGLE queue path, FIFO, deduped by runId (no double-queue).
  function queueStudy(runId, agentId) {
    if (!runId || !beatCards) return;
    beatCards.enqueue('study', runId, { runId: runId, agentId: agentId });
  }
  /* ══ THE ONE OFFER CARD (recommendation spine, S4) ═══════════════════════════════════════════════════
     Seven proactive channels grew seven card shapes. Every proactive CONSENT offer now reads the same way,
     in this order, so the Commander learns the grammar once:

        ◈ NOTICED               the eyebrow — the station SAW something; it is not making this up
        because you said “…”    the EVIDENCE, in the Commander's own words (Recommend.whyLine — the exact
                                grammar the FOR YOU shelf speaks, so COMMS and the shelf never disagree)
        <the proposal>          what it wants to do about it, tagged with its KIND
        [ do it ]  [ no ]       one tap either way

     Presentation ONLY: the caller keeps its own consent handlers, its own store writes and its own
     beat-slot claim. Extends the established .turnin gold-inset family (no new visual language) — the
     named friction Andrew called out was the seven inconsistent SHAPES, not the material.
     Returns { row, item, kind, text, btns } or null when COMMS isn't up. */
  function recCard(spec) {
    spec = spec || {};
    if (!log) return null;
    const r = row('agent');
    r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('rec');
    if (spec.kind) r.d.classList.add(spec.kind);
    // VT323 has no ◈ — it renders from the fallback font, so it is BOX-centred in its own span and never
    // sized off the label's font metrics (the symbol-glyph law).
    const title = document.createElement('span'); title.className = 'turnin-title rec-eyebrow';
    const glyph = document.createElement('span'); glyph.className = 'rec-glyph'; glyph.textContent = '◈';
    title.appendChild(glyph);
    // the eyebrow NAMES THE NOTICER. Every caller passes no eyebrow, so all seven cards read a flat "◈ NOTICED"
    // — the agent's own name (which the old per-channel card titles carried) had been dropped on the floor. It is
    // derived exactly as the rest of the card's copy derives it: the live hero name, upper-cased.
    const who = String(spec.eyebrow || (name ? String(name).toUpperCase() + ' NOTICED' : 'NOTICED'));
    // THE KIND LEADS. It used to sit below the evidence as a chip in the item grid's first column, which
    // both hid what kind of decision this was until line four AND squeezed the proposal into a narrow
    // second column. In the eyebrow it identifies the card immediately and frees the full width below.
    const kind = document.createElement('span'); kind.className = 'rec-kind';
    kind.textContent = String(spec.label == null ? '' : spec.label).toUpperCase();
    if (kind.textContent) {
      title.appendChild(kind);
      title.appendChild(document.createTextNode('·'));
    }
    const whoEl = document.createElement('span'); whoEl.className = 'rec-who'; whoEl.textContent = who;
    title.appendChild(whoEl);
    const slotEl = document.createElement('span'); slotEl.className = 'turnin-slot';
    r.body.appendChild(title); r.body.appendChild(slotEl);
    const item = document.createElement('div'); item.className = 'turnin-item rec-item';
    const ev = String(spec.evidence == null ? '' : spec.evidence).trim();
    if (ev) { const e = document.createElement('div'); e.className = 'rec-evidence'; e.textContent = ev; item.appendChild(e); }
    const text = document.createElement('span'); text.className = 'turnin-text';
    text.textContent = String(spec.proposal == null ? '' : spec.proposal);
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(text);
    // the note is CONSEQUENCE, not evidence ("raises the dial to FREE") — a dim aside between the
    // proposal and the buttons, so the card still ENDS on the two taps.
    const note = String(spec.note == null ? '' : spec.note).trim();
    if (note) { const n = document.createElement('div'); n.className = 'turnin-evidence'; n.textContent = '↳ ' + note; item.appendChild(n); }
    item.appendChild(btns);
    slotEl.appendChild(item);
    return { row: r.d, item: item, kind: kind, text: text, btns: btns };
  }
  // the ONE "because …" grammar, shared with the FOR YOU shelf. Falls back to the raw citation if the pure
  // spine isn't loaded (never invents text, never renders an empty evidence line).
  function recWhy(why) {
    const raw = String(why == null ? '' : why).trim();
    if (!raw) return '';
    if (typeof Recommend !== 'undefined' && Recommend.whyLine) return Recommend.whyLine({ why: raw });
    return raw;
  }
  // FINDING-4 lifecycle: an undecided study card from a PRIOR task end EXPIRES when a new task ends — that is the
  // "ignored" verdict (2× = stop proposing that belief) — and releases the slot so queued beats can't starve.
  // render ONE study proposal as a gold-inset turn-in card (Keep / Edit / Discard). Mirrors renderTurninBatch's
  // family but routes consent to StudyStore (the dossier write is client-side; the server batch is consumed via
  // /api/study/resolve inside StudyStore). Returns true iff the card actually rendered.
  function studyCard(prop, agentId, runId) {
    if (!log || !prop || typeof StudyStore === 'undefined') return false;
    // a RETIRE card must show the Commander the ACTUAL belief it will delete — re-resolve the (never-pinned)
    // target at render time; if the dossier changed and nothing (unpinned) matches anymore, there is no card.
    let target = null;
    if (prop.kind === 'retire') {
      target = (typeof StudyStore.retireTarget === 'function') ? StudyStore.retireTarget(prop) : null;
      if (!target) return false;
    }
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    if (typeof StudyStore.markShown === 'function') StudyStore.markShown(prop, agentId);   // spend one session-cap slot + record the shown recommendation
    const dimName = (typeof Dossier !== 'undefined' && Dossier.DIMS) ? ((Dossier.DIMS.find(d => d.key === prop.dim) || {}).label || prop.dim) : prop.dim;
    // the EVIDENCE is the Commander's own words — the verbatim directive this belief was observed from. A
    // retire's grounding is the model's reasoning about the stored belief instead.
    const evLine = prop.evidence ? recWhy(recCite(prop.evidence, prop.evidenceRef && prop.evidenceRef.kind))
      : (prop.kind === 'retire' ? recWhy(prop.text) : '');
    // the card's main text is what will actually happen: the belief to be ADDED, or (retire) the EXACT stored
    // belief that would be deleted — never just the model's paraphrase of it.
    const card0 = recCard({
      kind: 'study', evidence: evLine,
      label: prop.kind === 'retire' ? 'RETIRE' : String(dimName),
      proposal: prop.kind === 'retire' ? target.text : prop.text,
      note: prop.kind === 'retire' ? 'this belief would be removed from every agent’s briefing'
        : (name + ' would remember this about your ' + String(dimName).toLowerCase())
    });
    if (!card0) return false;
    const r = { d: card0.row };
    const item = card0.item, text = card0.text, btns = card0.btns;
    const card = beatCards && beatCards.claim({
      kind: 'study', runId: runId, node: r.d, data: prop,
      handoff: () => turninQueue.length > 0 ? 'memory' : null,
      onExpire: () => { if (typeof StudyStore.ignore === 'function') StudyStore.ignore(prop); },
      onGone: () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); }
    });
    if (!card) { if (r.d && r.d.parentNode) r.d.remove(); return false; }
    function settle(label, isDeny) {
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      card.finish({ delay: 600 });
    }
    function commit(verdict, editedText) {
      if (!card.decide()) return;
      if (verdict === 'keep') {
        const ok = StudyStore.accept(prop, editedText, agentId);
        if (!ok) { settle('✕ couldn’t apply — it changed', true); return; }   // honest: never flash "✓ retired" on a failed write
        settle(prop.kind === 'retire' ? '✓ retired' : (editedText != null ? 'saved (edited)' : 'kept'), false);
        recAccept('study', prop.dim, false);   // a kept belief spawns no run — the accept IS the outcome
        if (prop.kind !== 'retire') briefingReceipt(prop.dim);   // R4: a KEPT observation visibly propagates ("now in every agent's briefing"); a retire removes knowledge — nothing new to announce
        return;
      }
      StudyStore.discard(prop, agentId); settle('✕ discarded', true);
      recDecline('study', prop.dim, false);
    }
    function renderChoices() {
      btns.innerHTML = '';
      const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk(prop.kind === 'retire' ? 'Retire it' : 'Keep', 'primary', () => commit('keep'));
      if (prop.kind !== 'retire') mk('Edit', '', enterEdit);
      mk('Discard', 'deny', () => commit('discard'));
    }
    function enterEdit() {
      if (card.isDecided()) return;
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'turnin-edit'; inp.value = prop.text;
      item.replaceChild(inp, text); inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
      const commitEdit = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } text.textContent = v; item.replaceChild(text, inp); commit('keep', v); };
      const cancel = () => { item.replaceChild(text, inp); renderChoices(); };
      btns.innerHTML = '';
      const mk = (lbl, fn) => { const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk('Save', commitEdit); mk('Cancel', cancel);
      inp.onkeydown = e => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') cancel(); };
    }
    renderChoices();
    autoscroll();
    return true;
  }
  // try to place ONE deferred beat (a ready taste proposal first, else the OLDEST deferred study — FIFO) now
  // that a new task end may have freed the moment. Never chains: one card per flush.
  function flushStudyPending() {
    if (typeof StudyStore === 'undefined' || studyBusy() || slotCanStudy() !== 'free' || studyBlocked()) return;
    if (!StudyStore.canShow || !StudyStore.canShow()) return;
    const taste = beatCards && beatCards.shift('taste'); if (taste && studyCard(taste, 'agent', null)) return;
    const next = beatCards && beatCards.shift('study'); if (next) offerStudy(next.runId, next.agentId);
  }
  // fetch + offer ONE live study proposal for a run, obeying the one-beat arbiter + stand-down guards + session
  // cap. Any blocked moment QUEUES (single path, FIFO, deduped) — deferred, never starved, never stacked.
  async function offerStudy(runId, agentId) {
    if (typeof StudyStore === 'undefined') return;
    if (studyBusy() || slotCanStudy() !== 'free' || studyBlocked()) { queueStudy(runId, agentId); return; }
    if (!StudyStore.canShow || !StudyStore.canShow()) return;                    // session cap spent (per-session, not deferrable)
    const lifecycle = beatCards, lifecycleGeneration = lifecycle && lifecycle.generation();
    const proposals = await StudyStore.fetchProposals(runId, agentId);
    if (!lifecycle || beatCards !== lifecycle || lifecycle.generation() !== lifecycleGeneration) return;
    const prop = StudyStore.nextLive(proposals);   // drops resolved/declined/ignored + unmatchable retires
    if (!prop) return;
    // re-check the moment after the async fetch — reflection's memory.proposed may have claimed it meanwhile.
    if (studyBusy() || slotCanStudy() !== 'free' || studyBlocked()) { queueStudy(runId, agentId); return; }
    if (beatCards && !beatCards.once('study', runId)) return;   // this run already got its one study card
    studyCard(prop, agentId, runId);
  }
  /* THE STUDY LANE'S LIFECYCLE (recommendation spine, S3): this listener no longer ARMS an offer — the one
     collection pass (recommendPass, below) does that for every channel at once, so the study card wins the
     moment on PRIORITY instead of on a 12s head start. What stays here is the finding-4 lifecycle the study
     lane owns: a new task end expires the PREVIOUS task's undecided card (the "ignored" verdict) and then
     drains ONE deferred beat, so a queued offer can never starve behind an unanswered one. */
  function wireStudy() {
    if (studyWired || typeof U === 'undefined' || !U.bus) return;
    studyWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only (a summoned worker never study-nudges)
      // a new task ended: the PREVIOUS task's undecided card expires as an "ignore" (finding-4 lifecycle),
      // then one deferred beat may take the freed moment (anti-starve). Short delay = after the reply renders.
      if (beatCards) beatCards.scheduleExpire('study', 900);
      setTimeout(flushStudyPending, 900);
    });
  }

  /* GROWTH Tier 2 — THE GOAL-ARC CONFIRM BEAT (understanding → direction). When a goals-dim belief exists with no
     goal tree, the station proposes a decomposition (3-5 milestones) and asks the Commander to Confirm / Edit /
     Not-now — a focused Dialogue panel, exactly like the First Pitch. It is staged as an 'arc' CANDIDATE by the
     one collection pass (recommendPass) and speaks only if the spine ranks it first (memory > study > arc), and
     only into a WHOLLY FREE beat slot (slotCanArc() === 'free'), obeying the SAME stand-down guards as the
     study/curiosity beats (studyBlocked). Its citation is the Commander's OWN goal belief, read synchronously —
     the paid decomposition call happens only after the arc has actually won the moment. Confirm persists the tree (GoalStore.confirm); Not-now re-offers only when the belief
     changes (GoalStore.declineDecomposition). One confirm per task end, never stacked (the shared arbiter). */
  function arcBlocked() {
    // the SAME stand-down set the study beat honors (a confirm panel must never render mid-awakening/interview/
    // tutorial-panel or while the next run streams). Reuses studyBlocked for one home for the guard set.
    if (typeof studyBlocked === 'function') return studyBlocked();
    return isBusy() || interview;
  }
  async function offerArc(runId) {
    let opened = false;
    if (typeof GoalStore === 'undefined' || typeof Dialogue === 'undefined') return;
    if (!GoalStore.willOfferDecomposition || !GoalStore.willOfferDecomposition()) return;
    if (slotCanArc() !== 'free' || arcBlocked()) return;   // the LOWEST priority: a taken/blocked moment just drops (re-offers next run end)
    if (GoalStore.isFiring && GoalStore.isFiring()) return;
    const lifecycle = beatCards, lifecycleGeneration = lifecycle && lifecycle.generation();
    GoalStore.setFiring && GoalStore.setFiring(true);
    try {
      const res = await GoalStore.proposeDecomposition();   // the aux model call (reason-only) + parse
      if (!lifecycle || beatCards !== lifecycle || lifecycle.generation() !== lifecycleGeneration) return;
      if (!res || !res.belief || !Array.isArray(res.texts) || res.texts.length < 3) return;   // no usable path — stay un-offered so a later belief change retries
      // re-check the moment after the async model round-trip — memory/study may have claimed it meanwhile.
      if (slotCanArc() !== 'free' || arcBlocked()) return;
      clearNudge();                 // claim the one post-run beat, retiring any gentle nudge
      const arcBeat = beatCards && beatCards.claim({
        kind: 'arc', runId: runId,
        handoff: () => turninQueue.length > 0 ? 'memory' : null,
        onGone: () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); }
      });
      if (!arcBeat) return;
      let path = res.texts.slice();
      try {
        Dialogue.open({ name: (name || 'AGENT') });
        opened = true;
        await Dialogue.say('i think i see the path to that goal — here’s how i’d break it down. does this look right?');
        const linesOf = ts => ts.map((t, i) => (i + 1) + '. ' + t).join('\n');
        // Confirm / Not-now + an ✎ EDIT custom path (allowCustom): typing a revised path (steps separated by a
        // newline OR a semicolon) replaces it, then re-applies the pure floor/cap on Confirm. The custom text is
        // user-typed (never model markup); Dialogue renders it via textContent only.
        const choice = await Dialogue.node({
          lines: linesOf(path),
          options: [ { label: 'confirm the path', value: 'confirm' }, { label: 'not now', value: 'other', skip: true } ],
          allowCustom: true, customLabel: '✎ edit the milestones', customPlaceholder: 'your milestones, separated by ; …'
        });
        if (Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();
        // route the choice through the PURE resolver (Goals.resolveConfirmChoice, behaviorally tested): an explicit
        // Confirm or a VALID edit (≥3 steps) persists; a too-short edit is a REJECTION of the model tree and
        // declines — the unedited path is never silently persisted. Not-now declines (re-offer only on belief change).
        const decision = (typeof Goals !== 'undefined' && Goals.resolveConfirmChoice)
          ? Goals.resolveConfirmChoice(choice, path)
          : { action: (choice && choice.value === 'confirm') ? 'confirm' : 'decline', path: path };
        /* THE ARC CHANNEL LEARNS FROM ITS REAL OFFER (2026-08-04). Only the re-confirm card used to train this
           channel — the arc's own confirm panel, which IS the channel's flagship offer, recorded nothing at all.
           A confirmed path spawns quests rather than a run, so the accept IS the outcome; a not-now is a timing
           signal, the mildest thing the loop records. */
        if (decision.action === 'confirm') {
          const g = GoalStore.confirm(res.belief, decision.path);
          /* THE FOLD IS GATED ON THE REAL RESULT. GoalStore.confirm returns null when the path was edited down to
             something Goals.makeGoal will not build — no goal tree was created, so recording an ACCEPT would be
             the loop crediting this channel for an offer that produced nothing. It is not a decline either (the
             Commander did not refuse; their edit was unusable), so it folds NOTHING at all — the same silence the
             loop keeps for every outcome the harness cannot name. */
          if (g) {
            if (typeof SFX !== 'undefined' && SFX.quest) { try { SFX.quest(); } catch (_) {} }
            // NO StationUI.notify (notification diet): the Commander just SET this path in a card they were
            // reading — the sting confirms; the goal tree is where they were told it lives (⚑ QUESTS).
            recAccept('arc', 'goals', false);
          }
        } else {
          GoalStore.declineDecomposition(res.belief);   // not-now / rejected edit: re-offer only when the belief changes (never nag)
          recDecline('arc', 'goals', true);
        }
      } finally {
        // release the moment — and if a memory deck QUEUED behind this panel (a late memory.proposed during a
        // minutes-long confirm), HAND it the slot and render it now (mirrors studyCard's done()): the consent deck
        // must never sit invisible while its pendingMemory claim freezes the study/arc lanes.
        arcBeat.decide();
        arcBeat.finish();
        try { if (Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close(); } catch (_) {}
      }
    } catch (_) {
    } finally {
      GoalStore.setFiring && GoalStore.setFiring(false);
    }
    return opened;
  }
  function planGoalPath() { return offerArc('manual:' + Date.now()); }
  // one arc confirm per run: the collection pass consults this before staging the arc candidate (the offer
  // itself, including the paid decomposition call, only happens if the arc actually WINS the moment).
  function arcSeen(runId) { return !!runId && arcRunsSeen.has(runId); }
  function arcOnce(runId) {
    if (!runId) return true;
    if (arcRunsSeen.has(runId)) return false;
    arcRunsSeen.add(runId);
    if (arcRunsSeen.size > 200) arcRunsSeen.delete(arcRunsSeen.values().next().value);
    return true;
  }

  /* GROWTH Tier 3 — THE EARNED-AUTONOMY OFFER BEAT (track record → trust). After a clean run, if the demonstrated
     track record has crossed the thresholds (TrustStore/trust.js), the station offers to raise the autonomy dial
     ONE rung (or pre-bless a GRANTABLE capability) — a one-tap consent card, NEVER a silent escalation. It is staged
     as a 'trust' CANDIDATE by the one collection pass (recommendPass), cited by the REAL track record, and takes
     only a WHOLLY FREE beat slot (slotCanTrust() === 'free' — memory, study and the arc all outrank it), obeying
     the SAME stand-down guards as the other beats (studyBlocked). Accept applies the earned rung with provenance (TrustStore.accept →
     the existing AutonomyStore/permgrants plumbing); Not-yet declines (stop offering that rung this level band);
     leaving it undecided tallies an ignore (2× in a band = stop). One trust offer per session (TrustStore cap). */
  function trustBusy() { return !!(beatCards && beatCards.busy('trust')); }
  // an undecided trust card from a PRIOR task end EXPIRES when a new task ends — that's the "ignored" verdict
  // (2× in a band = stop) — and releases the slot so queued beats can't starve (mirrors expireActiveStudy).
  // render ONE trust offer as a gold-inset beat card (Accept / Not yet). Mirrors studyCard's family + lifecycle
  // discipline exactly (the finally-hands-off-to-queued-memory pattern both prior review rounds hit). textContent
  // only for the dynamic copy. Returns true iff the card actually rendered.
  function trustCard(offer, runId) {
    if (!log || !offer || typeof TrustStore === 'undefined') return false;
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    if (typeof TrustStore.markShown === 'function') TrustStore.markShown();   // spend the one session-cap slot
    // the ask, composed from the REAL track record (task count + satisfaction %) — never fabricated.
    const pv = offer.provenance || {};
    const ask = offer.kind === 'grant'
      ? 'trust me to write files on my own?'
      : 'grant me free rein on small jobs?';
    // the EVIDENCE is the honest track record the offer was computed from — a streak if there is one, else
    // the raw task/satisfaction counters. Never a claim the harness can't prove.
    const evLine = recWhy(pv.streak
      ? (pv.streak + ' approvals in a row')
      : ((pv.runs || 0) + ' tasks at ' + (pv.confidence || 0) + '% satisfaction'));
    const card0 = recCard({
      kind: 'trust', evidence: evLine,
      label: offer.kind === 'grant' ? 'GRANT' : 'AUTONOMY',
      proposal: ask,
      note: offer.kind === 'grant' ? 'writes stay jailed + reversible' : 'raises the dial to ' + String(offer.to).toUpperCase()
    });
    if (!card0) return false;
    const r = { d: card0.row };
    const item = card0.item, btns = card0.btns;
    const card = beatCards && beatCards.claim({
      kind: 'trust', runId: runId, node: r.d, data: offer,
      handoff: () => turninQueue.length > 0 ? 'memory' : null,
      onExpire: () => { if (typeof TrustStore.ignore === 'function') TrustStore.ignore(offer); },
      onGone: () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); }
    });
    if (!card) { if (r.d && r.d.parentNode) r.d.remove(); return false; }
    function settle(label, isDeny) {
      if (!card.isCurrent()) return;
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      card.finish({ delay: 600 });
    }
    function commit(verdict) {
      if (!card.decide()) return;
      if (verdict === 'accept') {
        // ASYNC-SAFE ACCEPT (review fix 2): a grant accept resolves against the server — disable the buttons while
        // pending (no double-tap, no decline-during-apply) and mark the card decided NOW (the user answered; an
        // expiry sweep must not tally an "ignore" under an in-flight accept). Settle only on the VERIFIED result.
        btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
        Promise.resolve(TrustStore.accept(offer)).then(ok => {
          if (!card.isCurrent()) return;
          if (!ok) { settle('✕ couldn’t apply', true); return; }   // honest: never flash "✓ granted" on a failed/unverified apply
          settle(offer.kind === 'grant' ? '✓ granted' : '✓ ' + String(offer.to).toLowerCase(), false);
          recAccept('trust', '', false);   // recorded only on the VERIFIED apply — never on an attempt
          if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
          if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(offer.kind === 'grant' ? '◈ earned — it may write files on its own now (revoke any time in Settings)' : '◈ earned — autonomy raised to ' + String(offer.to).toUpperCase() + ' (adjust any time in Settings)', 'gold');
          // if the Settings AUTONOMY panel is open, repaint its EARNED badge live (fail-open no-op otherwise).
          if (typeof StationUI !== 'undefined' && StationUI.repaintAutonomy) { try { StationUI.repaintAutonomy(); } catch (_) {} }
        }).catch(() => { if (card.isCurrent()) settle('✕ couldn’t apply', true); });
        return;
      }
      TrustStore.decline(offer); settle('✕ not yet', true);
      recDecline('trust', '', true);   // "not yet" is about TIMING — the mildest signal the loop records
    }
    const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
    mk('Accept', 'primary', () => commit('accept'));
    mk('Not yet', 'deny', () => commit('decline'));
    autoscroll();
    return true;
  }
  // fetch + offer ONE live trust offer for a run, obeying the one-beat arbiter + stand-down guards + session cap.
  // The LOWEST priority: a taken/blocked moment just DROPS (it re-offers at the next task end — a rung offer is
  // rare by construction, so it need not queue like study/taste; anti-nag).
  function offerTrust(runId) {
    if (typeof TrustStore === 'undefined') return;
    if (trustBusy() || slotCanTrust() !== 'free' || studyBlocked()) return;
    if (!TrustStore.canShow || !TrustStore.canShow()) return;        // session cap spent
    const offer = TrustStore.currentOffer ? TrustStore.currentOffer() : null;
    if (!offer) return;
    trustCard(offer, runId);
  }
  // the trust lane's lifecycle only (spine S3 — the offer itself is staged by the one collection pass): a new
  // task end expires the PREVIOUS task's undecided trust card as an "ignore" and frees the slot.
  function wireTrust() {
    if (trustWired || typeof U === 'undefined' || !U.bus) return;
    trustWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only (a summoned worker never trust-offers)
      if (beatCards) beatCards.scheduleExpire('trust', 900);
    });
  }
  /* NS-6 — THE THREAD TURN-IN BEAT (mined ideas → the durable thread ledger). After a salient task run the
     sidecar MINES "threads" — ideas the Commander floated but never acted on, each grounded by a VERBATIM quote —
     and STASHES the candidates (/api/threads/proposals; never auto-commits). Here we fetch them on agent.run.end
     and offer ONE for Keep / Edit / Discard: the click IS the consent — keep/edit commits an OPEN thread on the
     ledger (POST /api/threads/turnin; the night shift's propose step draws open threads FIRST), discard
     PERMANENTLY denylists the idea's fingerprint. It is staged as a 'thread' CANDIDATE by the one collection pass
     (recommendPass) — cited by that verbatim quote — and it is the LOWEST-ranked turn-in (memory, study, arc and
     trust all outrank it, so study & thread proposals take turns, study first). It takes only a WHOLLY FREE beat
     slot through the SAME arbiter (slotCanThread), obeying the SAME stand-down guards (studyBlocked). Blocked moments QUEUE (FIFO, deduped) —
     deferred, never starved, never stacked. Leaving a card undecided tallies an ignore (2× = stop offering). */
  function threadBusy() { return !!(beatCards && beatCards.busy('thread')); }
  // defer a thread offer for a later moment — SINGLE queue path, FIFO, deduped by runId (mirrors queueStudy).
  function queueThread(runId, agentId) {
    if (!runId || !beatCards) return;
    beatCards.enqueue('thread', runId, { runId: runId, agentId: agentId });
  }
  // an undecided thread card from a PRIOR task end EXPIRES when a new task ends — the "ignored" verdict
  // (2× = stop offering that idea) — and releases the slot so queued beats can't starve (mirrors expireActiveStudy).
  // render ONE mined thread candidate as a gold-inset turn-in card (Keep / Edit / Discard). Mirrors studyCard's
  // family + lifecycle discipline exactly; consent routes to ThreadStore → POST /api/threads/turnin (awaited —
  // the card only claims what the ledger verified: truthful telemetry). Returns true iff the card rendered.
  function threadCard(prop, agentId, batchRunId) {
    if (!log || !prop || typeof ThreadStore === 'undefined') return false;
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    if (typeof ThreadStore.markShown === 'function') ThreadStore.markShown();   // spend the one session-cap slot
    // the EVIDENCE is the VERBATIM quote the mine grounded this idea in — never a paraphrase.
    const card0 = recCard({
      kind: 'thread', evidence: prop.spec ? recWhy(recCite(prop.spec, threadCiteKind(prop))) : '',
      label: 'THREAD', proposal: prop.title,
      note: 'kept threads feed the night shift'
    });
    if (!card0) return false;
    const r = { d: card0.row };
    const item = card0.item, text = card0.text, btns = card0.btns;
    const card = beatCards && beatCards.claim({
      kind: 'thread', runId: batchRunId, node: r.d, data: prop,
      handoff: () => turninQueue.length > 0 ? 'memory' : null,
      onExpire: () => { if (typeof ThreadStore.ignore === 'function') ThreadStore.ignore(prop); },
      onGone: () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); }
    });
    if (!card) { if (r.d && r.d.parentNode) r.d.remove(); return false; }
    function settle(label, isDeny) {
      if (!card.isCurrent()) return;
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      card.finish({ delay: 600 });
    }
    // ASYNC-SAFE VERDICTS (the trustCard accept pattern): every verdict resolves against the server — disable the
    // buttons while pending + mark the card decided NOW (the user answered; an expiry sweep must not tally an
    // "ignore" under an in-flight verdict). Settle only on the VERIFIED result — never flash "kept" on a refusal.
    function commit(verdict, edits) {
      if (!card.decide()) return;
      btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
      if (verdict === 'keep') {
        Promise.resolve(ThreadStore.keep(prop, batchRunId, agentId, edits || null)).then(res => {
          if (!card.isCurrent()) return;
          if (!res || res.ok !== true) { settle('✕ couldn’t reach the ledger', true); return; }
          if (res.reason === 'added') { settle(edits ? '✓ kept (edited) — on the ledger' : '✓ kept — on the ledger', false); recAccept('thread', '', false); }
          else if (res.reason === 'duplicate') settle('✓ already on the ledger', false);
          else if (res.reason === 'declined') settle('✕ you discarded this idea before', true);   // the permanent denylist refused it — honest
          else settle('✕ the ledger refused it', true);   // 'unknown'/stale — nothing was committed
        }).catch(() => { if (card.isCurrent()) settle('✕ couldn’t reach the ledger', true); });
        return;
      }
      Promise.resolve(ThreadStore.discard(prop, batchRunId, agentId)).then(res => {
        if (!card.isCurrent()) return;
        settle((res && res.ok === true) ? '✕ discarded — never again' : '✕ couldn’t reach the ledger', true);
        if (res && res.ok === true) recDecline('thread', '', false);
      }).catch(() => { if (card.isCurrent()) settle('✕ couldn’t reach the ledger', true); });
    }
    function renderChoices() {
      btns.innerHTML = '';
      const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk('Keep', 'primary', () => commit('keep'));
      mk('Edit', '', enterEdit);
      mk('Discard', 'deny', () => commit('discard'));
    }
    function enterEdit() {
      if (card.isDecided()) return;
      // inline title + spec tweak, then keep (verdict 'edit' carries both to the ledger).
      const wrap = document.createElement('span'); wrap.style.display = 'grid'; wrap.style.gap = '4px'; wrap.style.minWidth = '0';
      const inpTitle = document.createElement('input'); inpTitle.type = 'text'; inpTitle.className = 'turnin-edit'; inpTitle.value = prop.title;
      const inpSpec = document.createElement('input'); inpSpec.type = 'text'; inpSpec.className = 'turnin-edit'; inpSpec.value = prop.spec || '';
      wrap.appendChild(inpTitle); wrap.appendChild(inpSpec);
      item.replaceChild(wrap, text); inpTitle.focus(); try { inpTitle.setSelectionRange(inpTitle.value.length, inpTitle.value.length); } catch (_) {}
      const commitEdit = () => {
        const t = inpTitle.value.trim(); if (!t) { inpTitle.focus(); return; }
        text.textContent = t; item.replaceChild(text, wrap);
        commit('keep', { title: t, spec: inpSpec.value.trim() });
      };
      const cancel = () => { item.replaceChild(text, wrap); renderChoices(); };
      btns.innerHTML = '';
      const mk = (lbl, fn) => { const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk('Save', commitEdit); mk('Cancel', cancel);
      const keydown = e => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') cancel(); };
      inpTitle.onkeydown = keydown; inpSpec.onkeydown = keydown;
    }
    renderChoices();
    autoscroll();
    return true;
  }
  // try to place the OLDEST deferred thread offer (FIFO) now that a new task end may have freed the moment.
  // Never chains: one card per flush (mirrors flushStudyPending).
  function flushThreadPending() {
    if (typeof ThreadStore === 'undefined' || threadBusy() || slotCanThread() !== 'free' || studyBlocked()) return;
    if (!ThreadStore.canShow || !ThreadStore.canShow()) return;
    const next = beatCards && beatCards.shift('thread'); if (next) offerThread(next.runId, next.agentId);
  }
  // fetch + offer ONE live mined thread candidate for a run, obeying the one-beat arbiter + stand-down guards +
  // session cap. Any blocked moment QUEUES (single path, FIFO, deduped) — deferred, never starved, never stacked.
  async function offerThread(runId, agentId) {
    if (typeof ThreadStore === 'undefined') return;
    if (threadBusy() || slotCanThread() !== 'free' || studyBlocked()) { queueThread(runId, agentId); return; }
    if (!ThreadStore.canShow || !ThreadStore.canShow()) return;                    // session cap spent (per-session, not deferrable)
    const lifecycle = beatCards, lifecycleGeneration = lifecycle && lifecycle.generation();
    const batch = await ThreadStore.fetchProposals(runId, agentId);
    if (!lifecycle || beatCards !== lifecycle || lifecycle.generation() !== lifecycleGeneration) return;
    const prop = ThreadStore.nextLive(batch.proposals);   // drops resolved/ignored candidates
    if (!prop) return;
    // re-check the moment after the async fetch — a higher-priority beat may have claimed it meanwhile.
    if (threadBusy() || slotCanThread() !== 'free' || studyBlocked()) { queueThread(runId, agentId); return; }
    if (beatCards && !beatCards.once('thread', runId)) return;   // this run already got its one thread card
    threadCard(prop, agentId, batch.runId || runId);
  }
  function wireThreads() {
    if (threadWired || typeof U === 'undefined' || !U.bus) return;
    threadWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only (a summoned worker never turns in threads)
      // a new task ended: the PREVIOUS task's undecided thread card expires as an "ignore", then one deferred
      // offer may take the freed moment (anti-starve). Short delay = after the reply renders. The offer itself
      // is staged by the one collection pass (spine S3), not by an arm delay of its own.
      if (beatCards) beatCards.scheduleExpire('thread', 900);
      setTimeout(flushThreadPending, 900);
    });
  }

  // GROWTH Tier 1 §4 — RATINGS → TASTE: after a work verdict folds, a 3-streak on one archetype may mint a
  // style-dim taste proposal. Surfaced through the SAME study card (one beat), obeying the same gates. Called
  // from rateWork with the run's directive (for the archetype) + the verdict.
  function maybeTasteBeat(agentId, runId, directive, verdict) {
    if (typeof StudyStore === 'undefined' || typeof Study === 'undefined') return;
    const arch = Study.classifyArchetype(directive || '');
    const prop = StudyStore.noteRating(arch, verdict);   // persists the streak; returns a proposal only on a fresh 3-streak
    if (!prop) return;
    // ride the one-beat discipline: if the moment is taken/blocked, queue it (FIFO; drained at the next task end).
    setTimeout(() => {
      if (studyBusy() || slotCanStudy() !== 'free' || studyBlocked() || !StudyStore.canShow()) { if (beatCards) beatCards.enqueue('taste', null, prop); return; }
      studyCard(prop, agentId || 'agent', runId);
    }, 300);
  }

  /* JUST-IN-TIME CURIOSITY (Commander Dossier, Phase B slice 2): after a clean run, the station may ask
     about ONE thing it still doesn't know about its Commander — gentle, budgeted (curiosity.js caps it at
     one per session), never after a stop/error. Mirrors the wireProposals turn-in beat. A "sure" launches a
     one-question intake interview for just that dimension; "not now" dismisses it for good. */
  function dimLabel(dim) {
    if (typeof Dossier !== 'undefined' && Dossier.DIMS) { const d = Dossier.DIMS.find(x => x.key === dim); if (d) return d.label; }
    return String(dim);
  }
  // retire the live curiosity nudge (its prompt row AND its choice chips) — called when it's answered or when a
  // turn-in beat supersedes it. Both halves fade out together so no orphan chip row is left behind.
  function clearNudge() {
    if (!activeNudge) return;
    const a = activeNudge; activeNudge = null;
    if (a.choiceRow) activeChoiceRows.delete(a.choiceRow);
    vanish(a.choiceRow);
    if (a.beat && a.beat.isCurrent()) { a.beat.decide(); a.beat.finish(); }
    else vanish(a.row);
  }
  /* VERDICT FOLLOW-UP (momentum loop, 2026-08-21). `◆ close` / `▼ missed` used to end in the word "noted" — the
     Commander said the work fell short and nothing changed. Now the beat asks ONE thing — what missed? — and every
     chip is a Commander Dossier belief (VerdictFollowup.belief), so the answer rides into every later agent's
     briefing. Popup law: never on `▲ nailed it`, never twice for one run, skip writes nothing. Same gold-inset
     post-run slot + one-beat-at-a-time discipline as the curiosity nudge (it IS a nudge, keyed to a run). */
  const followedUp = new Set();   // runIds already asked — one follow-up per run, ever (page lifetime)
  function verdictFollowupBeat(agentId, runId, verdict) {
    try {
      if (!log || typeof VerdictFollowup === 'undefined' || !VerdictFollowup.shouldAsk(verdict)) return false;
      if (!runId || followedUp.has(runId)) return false;
      if (typeof DossierStore === 'undefined' || !DossierStore.upsert) return false;   // nowhere to write → no question (a question with no consequence is the bug)
      if (taskQuestionLive()) return false;
      followedUp.add(runId);
      clearNudge();
      const r = row('agent'); r.d.classList.add('nudge');
      r.body.textContent = (verdict === 'miss' ? '▼ what missed?' : '◆ what would have made it a hit?') + ' — feedback for run ' + runId + '. One tap updates the briefing for future runs.';
      autoscroll();
      const meta = runMeta(runId);
      const choiceRow = choices(VerdictFollowup.chips(verdict), item => {
        const a = activeNudge; activeNudge = null;
        if (a && a.beat && a.beat.isCurrent()) { a.beat.decide(); a.beat.finish(); }
        else if (a) vanish(a.row);
        const b = VerdictFollowup.belief(item.value, { directive: meta && meta.directive, now: Date.now() });
        if (!b) return;   // skip → nothing written, nothing claimed
        postCorrection(runId, item.label, false, 'chip');   // the chip rides into the held skill review too (non-final: the typed message may still follow)
        DossierStore.upsert(b.dim, { text: b.text, source: b.source, weight: b.weight, observedAt: b.observedAt, sourceRunId: String(runId) });
        briefingReceipt(b.dim);   // the answer visibly pays off — the same receipt the curiosity path earns
        try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('commander'); } catch (_) {}
      });
      const beat = beatCards && beatCards.claim({ kind: 'nudge', node: r.d, data: { verdictFollowup: runId } });
      if (!beat) { if (choiceRow) { activeChoiceRows.delete(choiceRow); choiceRow.remove(); } vanish(r.d); return false; }
      activeNudge = { row: r.d, choiceRow: choiceRow, dim: null, beat: beat };
      return true;
    } catch (e) { try { console.warn('[comms] verdict follow-up failed', e); } catch (_) {} return false; }
  }

  function curiosityNudge(dim) {
    if (!log) return;
    if (taskQuestionLive()) return;   // an unanswered task question owns the moment — never steal its answer chips
    clearNudge();   // one gentle beat at a time: retire any prior unanswered nudge before this one (no cross-run stacking)
    const r = row('agent'); r.d.classList.add('nudge');   // a quiet aside, NOT the lit headline (.reply) — it was reading as a 2nd reply
    r.body.textContent = '✦ one curious thing — i still don’t know your ' + dimLabel(dim).toLowerCase() + '. want to tell me? it sharpens how every agent here works for you.';
    autoscroll();
    const choiceRow = choices([{ label: 'sure — ask me', value: 'yes' }, { label: 'not now', value: 'no', skip: true }], item => {
      const a = activeNudge; activeNudge = null;   // answered → release the post-run beat slot (the choice row removes itself)
      if (a && a.beat && a.beat.isCurrent()) { a.beat.decide(); a.beat.finish(); }
      else if (a) vanish(a.row);   // decided beats LEAVE: the prompt goes with its chips, never lingers over what follows
      if (item.value === 'yes' && typeof Intake !== 'undefined' && typeof Dossier !== 'undefined') {
        recAccept('curiosity', dim, false);   // an answered question spawns no run — the accept IS the outcome
        const skip = Dossier.DIM_KEYS.filter(k => k !== dim);   // ask ONLY this dimension (plan() returns just its question)
        Intake.start({
          skip: skip,
          onCommit: b => { if (typeof DossierStore !== 'undefined') DossierStore.upsert(b.dim, { text: b.text, source: 'curiosity', weight: b.weight }); if (typeof CuriosityStore !== 'undefined' && CuriosityStore.markAnswered) CuriosityStore.markAnswered(b.dim); briefingReceipt(b.dim); },   // R4: the answer visibly pays off — one provable "now in every agent's briefing" line (this was the ONE commit path with zero acknowledgment). V3: b.weight rides through (a canned chip stays 'seed' — never opens the readiness gate)
          onDone: () => { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('commander'); },
          // LEAVING the curiosity-launched interview = the same "not now" wave-off: mark the dimension dismissed so it
          // isn't raised again this session (existing store, no new persistence — mirrors the choice-row "not now").
          onLeave: () => { if (typeof CuriosityStore !== 'undefined') CuriosityStore.markDismissed(dim); }
        });
      } else if (typeof CuriosityStore !== 'undefined') {
        CuriosityStore.markDismissed(dim);   // waved off → never raise this dimension again
        recDecline('curiosity', dim, true);  // "not now" is a timing signal, not a verdict on the channel
      }
    });
    const beat = beatCards && beatCards.claim({ kind: 'nudge', node: r.d, data: { dim: dim } });
    if (!beat) { if (choiceRow) { activeChoiceRows.delete(choiceRow); choiceRow.remove(); } vanish(r.d); return false; }
    activeNudge = { row: r.d, choiceRow: choiceRow, dim: dim, beat: beat };   // track both halves so a turn-in can retire the whole nudge
    return true;
  }

  // V3 §7 HUNT MODE — the session-opener probe chip. Tapping it IS the consent, so it goes straight into
  // the one-question intake for the next live dimension (no second "want to tell me?" ask). Shares every
  // curiosity budget/anti-nag mark: the shown dim is tallied, an answer clears it, leaving marks it dismissed.
  function startHuntAsk() {
    if (typeof CuriosityStore === 'undefined' || typeof Intake === 'undefined' || typeof Dossier === 'undefined') return;
    const dim = CuriosityStore.consider();
    if (!dim) return;
    CuriosityStore.markShown(dim);
    Intake.start({
      skip: Dossier.DIM_KEYS.filter(k => k !== dim),   // exactly this one question
      onCommit: b => { if (typeof DossierStore !== 'undefined') DossierStore.upsert(b.dim, { text: b.text, source: 'curiosity', weight: b.weight }); if (typeof CuriosityStore !== 'undefined' && CuriosityStore.markAnswered) CuriosityStore.markAnswered(b.dim); briefingReceipt(b.dim); },
      onDone: () => { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('commander'); },
      onLeave: () => { if (typeof CuriosityStore !== 'undefined') CuriosityStore.markDismissed(dim); }
    });
  }
  /* A MULTI-LINE NUDGE IS A LIST, NOT A PARAGRAPH (2026-08-04).
     The night-shift report composes a real ledger — a headline, the acts that fired, the acts it DECLINED, the
     builds waiting — hands it to nudge() as one '\n'-joined string, and `white-space: pre-wrap` turned it into a
     wall. Two things broke. Every wrapped continuation fell back to the left margin, so "✓ drafted the note —
     waiting in your outbox" read as two separate items; and the sub-items' leading spaces were the only thing
     expressing nesting, which a narrow COMMS column eats. Worse for a truthfulness surface: a DECLINED act
     rendered identically to a completed one.
     Each marked line now gets its own row — marker in its own box (the symbol-glyph law: ✓ ✗ ⚒ come from the
     fallback face, so they are BOX-centred and never sized off the text's metrics) and the prose in a
     minmax(0,1fr) column, which is what buys the hanging indent. A refusal is its own rank. A single-line nudge
     — every other caller — still renders as plain text, unchanged. */
  const NUDGE_MARK = { '✓': 'yes', '✗': 'no', '✘': 'no', '×': 'no', '⚒': 'build', '▤': 'file', '·': 'sub', '✦': 'head', '◈': 'head' };
  function renderNudgeBody(host, text) {
    const raw = String(text == null ? '' : text);
    if (!host) return;
    host.textContent = '';
    const lines = raw.split('\n');
    if (lines.length < 2) { host.textContent = raw; return; }
    const wrap = document.createElement('div'); wrap.className = 'nudge-lines';
    lines.forEach((line, i) => {
      const sub = /^\s+/.test(line);                       // a leading-space row is nested under the one above
      const body = line.trim();
      if (!body) return;
      const mark = NUDGE_MARK[body.charAt(0)] ? body.charAt(0) : '';
      const rest = mark ? body.slice(1).trim() : body;
      const el = document.createElement('div');
      el.className = 'nudge-line' + (mark ? ' nl-mk nl-' + NUDGE_MARK[mark] : '') + (sub ? ' nl-sub' : '') + (i === 0 ? ' nl-first' : '');
      if (mark) { const m = document.createElement('span'); m.className = 'nl-m'; m.textContent = mark; el.appendChild(m); }
      const t = document.createElement('span'); t.className = 'nl-t'; t.textContent = rest;
      el.appendChild(t);
      wrap.appendChild(el);
    });
    host.appendChild(wrap);
  }
  // a reusable GENTLE post-run beat (used by the ongoing-suggestion engine, suggeststore.js) — the same quiet
  // register as the curiosity nudge: a .nudge aside, never the lit .reply headline. text = the line; options =
  // [{label,value,skip}]; onPick(item) fires on a choice (the choice row removes itself on pick).
  function nudge(text, options, onPick, opts) {
    if (!log) return null;
    if (taskQuestionLive()) return null;   // a pending task question owns the moment
    if (activeNudge && activeNudge.keepUntilDecision) return null;
    clearNudge();   // one gentle beat at a time: retire any prior unanswered nudge before this one (no cross-run stacking)
    const r = row('agent'); r.d.classList.add('nudge');
    renderNudgeBody(r.body, text);
    autoscroll();
    const choiceRow = choices(options || [], item => {
      const a = activeNudge; activeNudge = null;
      if (a && a.beat && a.beat.isCurrent()) { a.beat.decide(); a.beat.finish(); }
      else if (a) vanish(a.row);   // decided beats LEAVE (same law as the curiosity nudge — no stacked residue)
      try { if (onPick) onPick(item); } catch (_) {}
    });
    const beat = beatCards && beatCards.claim({ kind: 'nudge', node: r.d, data: { text: text } });
    if (!beat) { if (choiceRow) { activeChoiceRows.delete(choiceRow); choiceRow.remove(); } vanish(r.d); return null; }
    activeNudge = { row: r.d, choiceRow: choiceRow, dim: null, beat: beat };   // share the curiosity-nudge lifecycle so a turn-in's clearNudge() retires a suggestion beat too (keeps "one beat at a time")
    activeNudge.keepUntilDecision = !!(opts && opts.keepUntilDecision);
    return { row: r.d, choiceRow: choiceRow };
  }

  // ADAPTIVE RECRUITMENT beat: propose the single NEW teammate the Commander's real workflow points to, ONCE per
  // session, through the shared gentle nudge (so it rides the same one-beat-at-a-time lifecycle + vanish()). The
  // WHY is the exact same honest, counter-derived line the bay's CURATED shelf shows (both read RecruiterStore) —
  // so the beat and the shelf can never disagree. Accepting deep-links into the recruitment bay's summon flow.
  // Returns true iff a beat was actually shown (so the caller can claim the slot). Never fabricates: a cold/thin
  // signal → RecruiterStore.topPick() is null → this is a no-op and the chain falls through to curiosity.
  function maybeRecruit() {
    if (recruitShown) return false;                                        // one recruit offer per session (anti-nag)
    if (typeof RecruiterStore === 'undefined' || !RecruiterStore.topPick) return false;
    if (typeof App === 'undefined' || !App.openSummonBay) return false;    // no deep-link target → don't offer
    let pick = null; try { pick = RecruiterStore.topPick(); } catch (_) { return false; }
    if (!pick || !pick.spec) return false;                                 // not warm / nobody to recommend honestly
    const name = pick.spec.name || pick.classId;
    // the line: name the class + its honest, real-counter why. Lower-cased why joins mid-sentence cleanly.
    const line = '✦ your crew could use a ' + name + ' — ' + String(pick.why || '').replace(/^./, c => c.toLowerCase());
    recruitShown = true;                                                   // spend the session's single recruit offer (even on dismiss — never re-ask this session)
    if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // same soft chime as the idea beat
    nudge(line, [{ label: 'meet them', value: 'go' }, { label: 'not now', value: 'no', skip: true }], choice => {
      // THE OUTCOME LOOP: recruitment had a real accept path and recorded nothing, so it drifted down against
      // every channel that does record. Opening the bay spawns no run — the accept IS the outcome; "not now" is
      // a timing signal, the mildest negative the loop keeps.
      if (choice && choice.value === 'go') { try { App.openSummonBay(); } catch (_) {} recAccept('recruit', '', false); }
      else recDecline('recruit', '', true);
    });
    return true;
  }

  /* INTENT OFFER — the discovery seam. The bay holds 38 preconfigured classes and the library ~50 ready-made
     jobs, and BOTH live two clicks deep inside a bottom-bar popover, so most Commanders never learn they exist.
     Rather than move those doors, the station answers from the side the Commander is already on: when what they
     just typed is plainly a class's or a recipe's job, it says so ONCE, inline, and the accept deep-links
     straight to it.

     Three things keep this from becoming a nag:
       • it only fires on a REAL TASK directive (the same Classify gate the belt uses) — never on chatter;
       • the match must survive intentoffer.js's precision gates (distinctive terms, corroboration, a clear
         winner) — a vague match produces silence, which is the honest answer;
       • it rides the SHARED gentle nudge, so it obeys one-beat-at-a-time, decided beats vanish(), and it stands
         down for a live task question. Capped at OFFER_CAP per session, and never the same thing twice.
     Never offers a class the crew already has — that is not discovery, it is noise about what they own. */
  const OFFER_CAP = 2;                 // at most two intent offers per session (in-memory; resets each app run)
  let offersShown = 0;
  const offeredIds = new Set();        // never re-offer the same class/recipe in one session, accepted or not

  // the matchable surface, built from the LIVE catalogs (never a hardcoded keyword list — a class added
  // tomorrow is matchable today). `text` deliberately excludes purpose/manual: their shared vocabulary blurs
  // every class into every other. Mirrored by test/intent-offer.test.js.
  function offerCandidates() {
    const out = [];
    const taken = new Set();
    try {
      const mine = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
      for (const a of mine) if (a && a.specialtyId) taken.add(a.specialtyId);
    } catch (_) {}
    try {
      if (typeof Specialties !== 'undefined' && Specialties.builtins) {
        const archs = Specialties.archetypes ? (Specialties.archetypes() || []) : [];
        for (const c of (Specialties.builtins() || []).concat(archs)) {
          if (!c || !c.id || taken.has(c.id)) continue;      // already on the crew → nothing to discover
          out.push({
            kind: 'class', id: c.id, name: c.name, label: c.tagline,
            headline: c.name + ' ' + c.tagline,
            text: [c.name, c.tagline, c.blurb, (c.starters || []).join(' ')].join(' ')
          });
        }
      }
    } catch (_) {}
    try {
      if (typeof Recipes !== 'undefined' && Recipes.list) {
        for (const r of (Recipes.list() || [])) {
          if (!r || !r.id) continue;
          out.push({
            kind: 'recipe', id: r.id, name: r.name, label: r.tagline || '',
            headline: r.name + ' ' + (r.tagline || ''),
            text: [r.name, r.tagline, r.blurb, r.task].join(' ')
          });
        }
      }
    } catch (_) {}
    return out;
  }

  // Returns true iff an offer was actually shown. Silent (and cheap) on every guard.
  function maybeIntentOffer(text) {
    if (offersShown >= OFFER_CAP) return false;
    if (typeof IntentOffer === 'undefined' || !IntentOffer.match) return false;
    if (typeof App === 'undefined') return false;
    if (taskQuestionLive()) return false;                    // a pending task question owns the moment
    let m = null;
    try { m = IntentOffer.match(text, offerCandidates()); } catch (_) { return false; }
    if (!m || offeredIds.has(m.kind + ':' + m.id)) return false;
    // the accept must have a real destination — never offer a door that does not open.
    const isClass = m.kind === 'class';
    if (isClass && !App.openClassDossier) return false;
    if (!isClass && !App.openRecipeLaunch) return false;

    offersShown++;                                           // spend the slot even on dismiss (never re-ask)
    offeredIds.add(m.kind + ':' + m.id);
    const line = isClass
      ? '✦ there is a class built for this — ' + m.name + ', ' + String(m.label || '').replace(/^./, c => c.toLowerCase()) + '. want to look?'
      : '❒ there is a ready-made job for this — ' + m.name + '. want it loaded?';
    if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }
    const shown = nudge(line, [{ label: isClass ? 'show me' : 'load it', value: 'go' }, { label: 'not now', value: 'no', skip: true }], choice => {
      if (!choice || choice.value !== 'go') return;
      try { if (isClass) App.openClassDossier(m.id); else App.openRecipeLaunch(m.id, 'run'); } catch (_) {}
    });
    if (!shown) { offersShown--; offeredIds.delete(m.kind + ':' + m.id); return false; }   // the beat slot was busy — do not burn the offer
    return true;
  }

  /* A2 — THE SKILL ASIDE. When the quiet background review distills a completed run into a saved skill it fires
     the EXISTING `deliverable` (kind:'skill') event (see skillreview.makeReviewObserver). Here we surface ONE
     gentle, NON-interactive gold-inset aside — "◈ <agent> distilled this run into skill: <name>" — so the
     Commander SEES the agent grow its own skillbase. HARD anti-nag / one-beat discipline:
       • it is INFORMATIONAL (no choice row), so it never claims the post-run ask slot; if a real beat
         (memory turn-in / study card / suggestion / curiosity nudge) is live or in flight, the aside is DROPPED
         — never queued, never stacked over another beat (COMMS beat rules).
       • deduped by deliverable id (the review can re-fire), and suppressed when an IN-RUN skill.* tool call just
         rendered its own A1 chip for the same save — no double surface.
     The aside auto-vanishes so it leaves no residue in the feed. */
  function skillBeatBusy() {
    // any live/in-flight ask beat owns the moment — the aside must stand down (drop).
    if (isBusy() || interview) return true;
    if (activeNudge) return true;                                   // a gentle suggestion/curiosity beat is up
    if (taskQuestionLive()) return true;                            // an unanswered task question owns the moment (its chips are live)
    if (activeTurnin || turninQueue.length) return true;            // a memory-review deck is live/queued
    if (typeof studyBusy === 'function' && studyBusy()) return true;// a study card is visible
    if (beatSlot && beatSlot.visibleBeat()) return true;            // the arbiter says a beat holds the slot
    if (beatSlot && beatSlot.canStudy && beatSlot.canStudy() !== 'free') return true;   // reflection in flight → memory wins
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    return false;
  }
  function skillAside(skillName, agentId, skillId) {
    if (!log) return false;
    const who = name || 'the agent';   // the module's live agent name — the aside only renders on this agent's own stream
    const r = row('agent'); r.d.classList.add('nudge'); r.d.classList.add('skill-aside');
    r.body.textContent = '◈ ' + who + ' distilled this run into skill: ' + brief(String(skillName || 'a new skill'));
    autoscroll();
    /* SKILL TURN-IN (consistency loop, slice 3, 2026-08-22). A version the background/verdict review wrote is
       WITHHELD by the sidecar (skillstore provenance ask) until the Commander approves those bytes — so this aside
       is no longer a fleeting FYI: when the sidecar reports the skill as approvable-and-unapproved, the card
       carries the decision (use it / discard), exactly like the memory turn-in card. Popup law: the chips
       appear only when a real decision is pending, and each tap changes station state (gate or archive).
       When nothing is pending (an in-run agent write, already approved) the aside stays the old fleeting line. */
    let decided = false;
    const fade = () => { if (!decided) { decided = true; try { vanish(r.d); } catch (_) {} } };
    (async () => {
      try {
        if (!skillId || typeof Harness === 'undefined' || !Harness.agentSkills) { setTimeout(fade, 9000); return; }
        const skills = await Harness.agentSkills(agentId || 'agent');
        const sk = (skills || []).find(x => x && String(x.id) === String(skillId));
        const pending = !!(sk && sk.withheld && sk.guardApprovable);   // sidecar gate annotate(): withheld + approvable = a decision is pending (a block is never approvable)
        if (!pending) { setTimeout(fade, 9000); return; }
        r.body.textContent = '◈ ' + who + ' wants to change how this class of task is done — skill “' + brief(String(sk.name || skillName)) + '”. It stays out of every briefing until you decide.';
        const choiceRow = choices([
          { label: '✔ use it', value: 'allow' },
          { label: '✖ discard', value: 'discard', skip: true },
          { label: 'read it first', value: 'read', quiet: true }
        ], async item => {
          if (item.value === 'read') { try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('skills'); } catch (_) {} return; }   // 'skills' aliases into ABILITIES ▸ SKILL LIBRARY, where the body + approve controls live
          decided = true;
          let ok = false, flash = '';
          if (item.value === 'allow') { const res = await Harness.agentSkillAllow({ agentId: agentId || 'agent', id: skillId, allow: true }); ok = !!(res && res.ok); flash = ok ? '✔ in every briefing from now on' : 'could not approve — open ABILITIES › SKILLS'; }
          else { const res = Harness.agentSkillManage ? await Harness.agentSkillManage({ agentId: agentId || 'agent', action: 'archive', target: skillId, force: true }) : null; ok = !!(res && res.ok); flash = ok ? 'discarded' : 'could not discard — open ABILITIES › SKILLS'; }
          r.body.textContent = '◈ skill “' + brief(String(sk.name || skillName)) + '” — ' + flash;
          if (!ok) { try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(flash, 'warn'); } catch (_) {} }
          setTimeout(() => { try { vanish(r.d); } catch (_) {} }, 2500);
        });
        void choiceRow;
      } catch (_) { setTimeout(fade, 9000); }
    })();
    return true;
  }
  function wireSkillAside() {
    if (skillAsideWired || typeof U === 'undefined' || !U.bus) return;
    skillAsideWired = true;
    U.bus.on('deliverable', p => {
      if (!p || p.kind !== 'skill') return;                         // only skill deliverables get the aside
      const id = String(p.id || p.title || '');
      if (!id || skillDelivSeen.has(id)) return;                    // dedup: the review can re-fire the same skill
      skillDelivSeen.add(id);
      if (skillDelivSeen.size > 200) skillDelivSeen = new Set(Array.from(skillDelivSeen).slice(-100));
      // an in-run save already showed its A1 chip a moment ago → the flavored chip IS the surface; no aside.
      if (Date.now() - recentInRunSkill < 8000) return;
      // only aside into the agent's OWN visible stream, and only when the moment is free (else drop — anti-nag).
      const agentId = p.agentId || 'agent';
      const onAgent = activeWs && (activeWs.agentId || 'agent') === agentId;
      if (!onAgent || skillBeatBusy()) return;
      skillAside(p.title, agentId, p.id);
    });
  }
  // P3.2 — CAPTURE FORWARDED CREW SPEND. A team.dispatch worker runs its own agent loop and its agent.run.end is
  // forwarded onto the lead's stream (orchestration.js FORWARD) → it reaches U.bus with the worker's OWN runId,
  // agentId, and reconciled usd. We record every such worker end into a rolling, time-stamped buffer; the lead's
  // own run.end (handled in the Harness.chat block) CLAIMS the workers that fired inside its live window. Only a
  // NAMED roster worker is attributable: an ephemeral team.spawn clone (sub-* id, no persistent identity) vanishes,
  // so crediting it would be a lie — filtered here. Hero self-runs (agentId 'agent') are never crew. Read-only.
  let crewCaptureWired = false;
  function wireCrewCapture() {
    if (crewCaptureWired || typeof U === 'undefined' || !U.bus) return;
    crewCaptureWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p) return;
      const aid = String(p.agentId || 'agent');
      if (aid === 'agent') return;                      // the hero's own run, not a delegated worker
      if (/^sub-/.test(aid)) return;                    // ephemeral team.spawn clone — no persistent XP identity, never credited
      const usd = Math.max(0, (typeof p.usd === 'number' && isFinite(p.usd)) ? p.usd : 0);
      crewSeen.push({ agentId: aid, usd: usd, runId: String(p.runId || p.id || ''), at: Date.now() });
      if (crewSeen.length > 80) crewSeen.shift();       // rolling window — a long session can't grow it forever
    });
  }
  // claim the crew workers that ran inside a lead run's live window [startedAt, now]. Returns [{ agentId, usd }],
  // aggregated per worker (a worker dispatched twice in one run sums its spend). Consumes matched entries so a
  // later lead run can't re-claim them. Pure-ish (mutates crewSeen); the honest attribution list for crewSplit.
  function claimCrew(startedAt) {
    if (!(startedAt > 0) || !crewSeen.length) return [];
    const lo = startedAt - 250;   // small slop: a worker's forwarded end can arrive a beat before the lead's onRunId lands
    const byAgent = new Map();
    for (let i = crewSeen.length - 1; i >= 0; i--) {
      const e = crewSeen[i];
      if (e.at < lo) break;        // buffer is time-ordered; older than this window → stop scanning
      byAgent.set(e.agentId, { agentId: e.agentId, usd: (byAgent.get(e.agentId) || { usd: 0 }).usd + e.usd });
      crewSeen.splice(i, 1);       // consumed — never double-attributed to a second lead run
    }
    return Array.from(byAgent.values());
  }
  /* E6 — shell.bg.exit consumer. The sidecar announces when a background/long-running shell process
     (shell.exec background:true — a dev server, a watcher) ends, riding the durable SSE bus. That event
     existed SOLELY for the UI yet had zero listeners, so a crashed dev server kept reading as alive with
     no surface anywhere. Give it a minimal honest system line in COMMS: a terse station broadcast (not a
     beat-slot card — never competes for the post-run slot). Renders directly (no coalesce/screen gate),
     because a process fault must never be silently dropped. Scoped to the owning agent's name when
     resolvable. Truthful telemetry: it states what the harness proved — the process exited, with its code. */
  let bgExitWired = false;
  function wireBgExit() {
    if (bgExitWired || typeof U === 'undefined' || !U.bus) return;
    bgExitWired = true;
    U.bus.on('shell.bg.exit', p => {
      try {
        if (!p || !p.bgId || !log) return;
        const code = (typeof p.exitCode === 'number') ? p.exitCode : null;
        const killed = !!p.killed;
        const nm = (typeof App !== 'undefined' && App.agentName) ? (App.agentName(p.agentId || 'agent') || '') : '';
        // terse, honest: WHO (if known) · WHAT · the proven exit code / killed state
        const verb = killed ? 'was stopped' : (code === 0 ? 'exited cleanly' : 'exited');
        const codeStr = killed ? '' : (code == null ? '' : ' (code ' + code + ')');
        const who = nm ? nm + '’s ' : '';
        const line = who + 'background process ' + String(p.bgId) + ' ' + verb + codeStr;
        // render as a station system line (broadcast register) — dim, centered, hairline; NOT a card.
        const d = document.createElement('div');
        d.className = 'cmsg broadcast' + (killed || code === 0 ? '' : ' broadcast-warn');
        d.setAttribute('role', 'status');
        const span = document.createElement('span'); span.className = 'bc-line';
        const pre = document.createElement('span'); pre.className = 'bc-glyph'; pre.textContent = '▸ ';
        span.appendChild(pre);
        span.appendChild(document.createTextNode(line));
        d.appendChild(span);
        if (typeof clearEmptyState === 'function') clearEmptyState();
        log.appendChild(d);
        autoscroll();
      } catch (_) {}
    });
  }
  /* ══ THE RECOMMENDATION PASS — one listener, one arm point, one arbiter (spine S3) ═══════════════════
     Every proactive channel used to own an `agent.run.end` listener and win the single post-run beat by
     ARMING EARLIEST (nudge/rate 650ms, study 12s, arc 14s, trust 16s, thread 18s), so the priority order
     baked into beatcard.js was inert and the least valuable ask usually spoke. Now every channel offers a
     CANDIDATE built from its existing SYNC predicate, the pure spine (recommend.js) ranks them, and exactly
     ONE fires through its existing render path.

     A candidate must carry two things or it does not exist:
       • kind — its place in the one priority order (Recommend.PRIORITY).
       • why  — its evidence, derived from REAL state: the Commander's own words, a real persisted counter,
                or the dimension actually being targeted. Recommend.pick() DROPS anything that can't cite.
                A channel that cannot say WHY stays silent — truthful telemetry, applied to recommendations.

     Nothing about the per-channel floors moved: every session cap, denylist, dedup and stand-down still
     lives in that channel's own store and is spent by its own fire path. The spine only decides WHO speaks.
     A channel that LOSES the moment is not consumed — study/thread go back on their FIFO queues, and every
     other channel's predicate simply reads true again at the next task end. */
  /* ── TWO ARMS, ONE ARBITER ──────────────────────────────────────────────────────────────────────────
     A single 1.6s arm was WRONG for half the channels, in a way that silently broke two of them:

       · MEMORY WINS was a fiction. memory.proposed is emitted only after the sidecar's reflection aux call
         returns — SECONDS after the run ends. At 1.6s the slot was still free, a turn-in claimed it, and the
         consent deck the Commander actually cares about queued behind a lower-value card, invisible.
       · THE STUDY STASH WASN'T WRITTEN YET. /api/study/proposals falls back to the agent's PREVIOUS batch
         when this run's isn't stashed, so at 1.6s every study card offered the LAST run's belief and each
         run's own batch never got offered at its own moment. Same for the thread mine.

     So the pass runs TWICE per run end, and each channel collects at the arm where its evidence is real:

       FAST (1.6s) — the RATE beat only. It needs nothing but the run's own work counters, which are already
         on hand, and it is the beat the Commander is waiting for; this also restores the precedence the old
         650ms ladder gave it, without letting it win by being early (it is still ranked, not raced).
       SLOW (12s)  — everything the run must first PRODUCE: the fetch-backed turn-ins (study, thread), the
         arc and trust offers, and the gentle channels. 12s is the old STUDY_ARM_MS reality — by then
         reflection has landed (or reserved the slot) and both stashes are written. The arc gets its focused
         Dialogue at this arm too, rather than popping 1.6s after the reply.

     memory is unchanged and needs no arm: memory.proposed RESERVES the slot the instant it fires, so a turn-in
     that hasn't rendered yet stands down, and one that HAS already rendered is queued behind — never replaced. */
  const BEAT_ARM_MS = 1600;          // FAST arm — the rate beat (nothing to wait for)
  const BEAT_SLOW_ARM_MS = 12000;    // SLOW arm — reflection has landed and both stashes are written

  /* the SESSION ASK BUDGET (Recommend.SESSION_ASK_MAX): the spine-level ceiling on proactive CONSENT cards for
     this browser session. Per-channel caps remain the second floor; this bounds their SUM, because five
     channels each spending their own one-per-session cap is still five interruptions. memory and rate are
     exempt (Recommend.asksBudget) — the run itself earns those. */
  let sessionAsks = 0;
  function askBudgetSpent() {
    const cap = (typeof Recommend !== 'undefined' && Number.isFinite(Recommend.SESSION_ASK_MAX)) ? Recommend.SESSION_ASK_MAX : 4;
    return sessionAsks >= cap;
  }
  /* ONE BUDGET FOR EVERY PROACTIVE ASK (one-memory lane, 2026-08-05). The spine's cap bounded only the spine's
     own ten channels; the OFF-SPINE proactive consent beats — the First Pitch, the north-star confirm, the
     night-shift "review?" nudge — each kept a private anti-nag and their SUM was unbounded on top of the spine's
     four. spendAsk/askBudgetSpent are exported so those beats spend the SAME budget: five polite systems are
     still one loud station. What does NOT spend it, stated: the reports (morning night report, the away digest)
     — an absence's work earns its summary the same way a run earns its rating — and each beat's own once-ever /
     per-session floors remain untouched underneath. */
  function spendAsk() { sessionAsks += 1; }

  // the understanding read the spine scores value-of-information against. Fail-open: a cold/absent store
  // means no VOI bonus at all (pure priority order) — never a fabricated one.
  function recUnderstanding() {
    try { if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.read) return UnderstandingStore.read(); } catch (_) {}
    return null;
  }
  /* ── EVIDENCE STRENGTH (quality loop, Q1) ────────────────────────────────────────────────────────────
     The spine asks "can this candidate cite?". These ask "how STRONG is that citation?" — read from state the
     station already holds (recquality.js: dimension confidence, belief freshness, a real repeat counter), never
     computed fresh and never fabricated. recommend.js turns the reading into a bounded WITHIN-TIER discount, so
     thin evidence speaks later — it can never move a candidate across a priority band.

     Fail-open at every step: no module / no store / nothing to read → null → NO adjustment at all, and the
     station ranks exactly as it did before the quality loop existed.

     WHO REPORTS, AND WHY THAT MATTERS. Strength only ever SUBTRACTS, so a channel that reports one is the only
     kind that can be down-ranked by it — silence is a relative advantage. Every channel with honest data to read
     therefore reads it:
       · ARC     — its cited goal belief's freshness × the goals dimension's corroboration.
       · SEED / ROUTINE — the real repeat / hand-launch counter behind the citation.
       · STUDY   — the CONFIDENCE of the dimension the proposal targets. (Deliberately not the belief's AGE: a
                   RETIRE proposal is most valuable exactly when the belief it targets is oldest, and its
                   directive citation is fresh by construction — this is the dimension read, not a freshness one.)
       · TRUST   — the offer's own provenance confidence, the real satisfaction percentage it cites, 0..100 → 0..1.
     And the ones that genuinely have nothing to read, stated rather than left implicit:
       · CURIOSITY asks ABOUT a dimension rather than asserting one, so a blank dim is a high-VALUE question, not
         weak evidence — precisely what the spine's VOI term already scores. A strength read here would double-count
         the same blankness with the opposite sign.
       · THREAD has no dim at all (a mined idea is not aimed at a dossier dimension) and its quote is located in
         the run that just ended, so there is no age and no confidence to read. Neutral is the honest reading.
       · The RE-CONFIRM ask carries none by design: strength discounts a weak ASSERTION, and an ask asserts nothing.
     The residual tradeoff is real and is not papered over: suggest / recruit / thread / curiosity and the
     re-confirm ask cannot be discounted for thin evidence, so within a band they hold a small structural edge over
     the reporters at their weakest. That is the price of never fabricating a reading, and it is bounded by
     STRENGTH_MAX (recommend.js) — never a band crossing.

     Fail-open at every step: no module / no store / nothing to read → null → NO adjustment at all, and the
     station ranks exactly as it did before the quality loop existed. */
  function recStrengthOfBelief(belief, dim) {
    try {
      if (typeof RecQuality !== 'undefined' && RecQuality.beliefStrength) return RecQuality.beliefStrength(belief, Date.now(), recUnderstanding(), dim);
    } catch (_) {}
    return null;
  }
  function recStrengthOfCount(n) {
    try { if (typeof RecQuality !== 'undefined' && RecQuality.countStrength) return RecQuality.countStrength(n); } catch (_) {}
    return null;
  }
  // the confidence the understanding engine already holds for a dimension — the right reading for an offer that
  // ASSERTS something about it (study). Absent dim / absent read → null → neutral.
  function recStrengthOfDim(dim) {
    try { if (typeof RecQuality !== 'undefined' && RecQuality.dimStrength) return RecQuality.dimStrength(recUnderstanding(), dim); } catch (_) {}
    return null;
  }
  // a 0..100 PERCENTAGE the station already computed (trust's provenance confidence) as a 0..1 strength. A
  // non-numeric / absent percentage is no reading at all — never 0, which would be the full thin-evidence penalty.
  function recStrengthOfPercent(pct) {
    const n = Number(pct);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 100 ? 1 : n / 100;
  }
  /* ── THE OUTCOME LOOP (quality loop, Q2) ─────────────────────────────────────────────────────────────
     The station's own suggestions are held to the standard everything else here is: what did they actually
     PRODUCE? recQualityOf reads the channel's earned weight (recqualitystore.js) for the scorer; recAccept /
     recDecline record what the Commander really did with the card. An accept that spawns a run records
     NOTHING yet — the run's own outcome is the evidence, and a click is not a result. Fail-open everywhere:
     no store → null → the spine treats the channel as neutral. */
  function recQualityOf(kind, dim) {
    try { if (typeof RecQualityStore !== 'undefined' && RecQualityStore.weightFor) return RecQualityStore.weightFor(kind, dim); } catch (_) {}
    return null;
  }
  /* ── THE ONE MEMORY (one-memory lane, 2026-08-05; stated honestly, dead-wires lane 2026-08-28) ───────
     A verdict below lands in BOTH places, and they answer different questions:
       · RecQualityStore — "how well does THIS CHANNEL do?" Browser-local, an EWMA over outcomes, read only here.
       · RecLedger       — "did the Commander already answer THIS THING, anywhere?" The durable cross-surface
                           ledger the bay, the scout, the night shift, the quest minter and reflection all
                           already write and read. Until this lane it had never heard a single COMMS verdict, so
                           an idea waved off at a card could be built overnight and shelved the next morning.
     THE STATED EXCEPTIONS (this comment used to claim "every verdict lands in both", which was never true):
     study and suggest verdicts reach the quality store here but their LEDGER rows are minted and verdicted by
     their own stores (RecLedger.OWN_LEDGER — note() refuses them, so the ledger call below is a deliberate
     no-op for those two); seed and routine answer their spine rows from their own stores (seedstore.js /
     routinenudgestore.js), which call the ledger beside their quality-store writes.
     Both stores are fail-open and neither is load-bearing for the card itself: a station with no ledger
     reachable keeps behaving exactly as it did. recAccept/recDecline stay the ONE choke point for the rest. */
  function recAccept(channel, dim, spawnsWork, id) {
    try { if (typeof RecQualityStore !== 'undefined' && RecQualityStore.noteAccept) RecQualityStore.noteAccept({ channel: channel, dim: dim || '', spawnsWork: !!spawnsWork, id: id || '' }); } catch (_) {}
    try { if (typeof RecLedger !== 'undefined' && RecLedger.accepted) RecLedger.accepted(channel); } catch (_) {}
  }
  /* THE SESSION DECLINE COUNT (dead-wires lane, 2026-08-28). recommend.js has carried a `declines` term —
     −15 per recent decline, capped at −45 — since the band redesign, and NOTHING ever populated it. This is its
     writer, and its scope is deliberately the SESSION, in memory only: the long-horizon record already lives in
     the quality EWMA (declines fold it down) and the ledger preference weight (declines fold it negative), so a
     durable third copy of the same events would triple-count them. What neither carries is "you already waved
     this channel off TODAY" — the short-horizon anti-nag the term was documented as. Deferrals ("not now") are
     timing signals and do not count; a reload honestly forgets, exactly like RUN_META. */
  const sessionDeclines = new Map();   // channel → real declines this session (never deferrals)
  function recDeclinesOf(kind) { return sessionDeclines.get(String(kind || '')) || 0; }
  function recDecline(channel, dim, deferred) {
    if (!deferred) { const k = String(channel || ''); if (k) sessionDeclines.set(k, (sessionDeclines.get(k) || 0) + 1); }
    try { if (typeof RecQualityStore !== 'undefined' && RecQualityStore.noteDecline) RecQualityStore.noteDecline({ channel: channel, dim: dim || '' }, !!deferred); } catch (_) {}
    try {
      if (typeof RecLedger !== 'undefined' && RecLedger.declined) {
        // a REAL decline changes what the whole station may propose next, so re-read the shared memory; a
        // deferral ("not now") changes nothing about what is allowed and earns no request.
        if (RecLedger.declined(channel, !!deferred) && !deferred && RecLedger.refresh) RecLedger.refresh(true);
      }
    } catch (_) {}
  }
  // the ledger's learned weight for a candidate — the Commander's own decayed accept/decline history for this
  // kind, across every surface. Absent module / cold ledger / personalization paused → 0 → no adjustment at all.
  function recPreferenceOf(kind, dim) {
    try {
      if (typeof RecLedger !== 'undefined' && RecLedger.preferenceOf) {
        return RecLedger.preferenceOf(kind, [String(kind || '')].concat(dim ? ['dim:' + String(dim)] : []));
      }
    } catch (_) {}
    return 0;
  }
  /* THE SHARED DECLINED READ, applied to the spine's own candidates. Exact normalized-title match only — the same
     bar sidecar/declinedindex.js sets for the six server-side propose filters, and for the same stated reason: a
     false suppression is worse than an occasional duplicate. A candidate with no title is never suppressed (there
     is nothing to match), and an unreachable ledger suppresses nothing at all. */
  function recAlreadyDeclined(candidate) {
    try {
      if (typeof RecLedger === 'undefined' || !RecLedger.isDeclined) return false;
      const t = candidate && candidate.title;
      return !!t && RecLedger.isDeclined(t);
    } catch (_) { return false; }
  }
  /* ── THE STALENESS GUARD (quality loop, Q3) ──────────────────────────────────────────────────────────
     A belief that is OLD and UNCORROBORATED may not be ASSERTED in an offer ("because you said X") — the
     station would be claiming something the Commander last confirmed a season ago as if it were current. But
     it is a perfectly good QUESTION ("still true that X?"). These read the state; the transformation happens
     in the candidate builder, and the ask rides the SAME slot, the same session budget and the same card
     grammar as the offer it replaces — no new surface, no new concept. Fail-open: no module, no reading, no
     claim of staleness (a station that cannot prove a belief is stale treats it as fresh). */
  function recStale(belief, dim) {
    try { if (typeof RecQuality !== 'undefined' && RecQuality.staleness) return RecQuality.staleness(belief, Date.now(), recUnderstanding(), dim); } catch (_) {}
    return null;
  }
  function recBeliefFp(dim, belief) {
    try { if (typeof RecQuality !== 'undefined' && RecQuality.beliefFingerprint) return RecQuality.beliefFingerprint(dim, belief); } catch (_) {}
    return '';
  }
  // a re-confirm answered "no" is never asked again until the belief itself changes (goalstore's offered-set
  // discipline). Fail-open the SAFE way here: an unreadable denial set means we do NOT re-ask.
  function recReconfirmDenied(fp) {
    try { if (typeof RecQualityStore !== 'undefined' && RecQualityStore.isBeliefDenied) return !!RecQualityStore.isBeliefDenied(fp); } catch (_) {}
    return false;
  }
  /* THE RE-CONFIRM CARD. The same recCard grammar every other offer uses — eyebrow → evidence, cited by the
     belief's OWN provenance → proposal → taps — with the proposal phrased as a QUESTION instead of a proposal,
     because that is the only honest thing this card can say. Consent writes through the EXISTING store paths:
       still true  → the belief is re-stamped COMMANDER-STATED through DossierStore.upsert (they just said so,
                     out loud, in answer to a direct question — that is exactly what 'stated' evidence is) plus
                     one unit of positive evidence on its dimension. Re-stamping the WEIGHT is what ends the
                     re-ask loop: a seed-weighted belief contributes 0 confidence by design (understanding.js
                     EVIDENCE_WEIGHT.seed = 0), so touching only updatedAt left the dimension reading exactly as
                     under-confirmed as before and the same question came back every three weeks, forever.
       not now     → THIS QUESTION goes quiet for the rest of the session (an in-memory fingerprint set, local to
                     this module). It must NOT route through GoalStore.markOffered: that set also gates
                     pendingDecomposition, so deferring the staleness question used to withdraw the belief's
                     milestone-decomposition offer permanently too — two different asks sharing one kill switch.
                     Nothing is folded onto the channel either: a deferral is a signal about timing, and this card
                     already has an honest way to say that — the other two chips.
       not anymore → one unit of counter-evidence, the belief is forgotten through the store's own forget path
                     (which ALSO permanently denylists its text against being re-learned from work — the same
                     path a study RETIRE takes, and the note says so), and the QUESTION is fingerprinted so it
                     is never asked again for this belief state.
     Returns true iff the card actually rendered. */
  function reconfirmCard(belief, dim, weeks, fp, runId) {
    if (!log || !belief || typeof DossierStore === 'undefined') return false;
    const text = String(belief.text || '').trim();
    if (!text) return false;
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    const card0 = recCard({
      kind: 'arc', evidence: recWhy(recCite(text, beliefCiteKind(belief))),
      // the sibling labels (RETIRE · GRANT · AUTONOMY · THREAD) carry no punctuation; neither does this one.
      label: 'STILL TRUE',
      proposal: 'is that still where you’re heading?',
      /* the CONSEQUENCE line: a real measured age (never a vague "a while back") and the ACTUAL cost of "no".
         Deny does not merely stop the station treating it as a goal — DossierStore.forget denylists the text so
         the study loop can never re-learn it from work. That is the honest thing to disclose, in one aside. */
      note: 'unconfirmed for ~' + weeks + ' week' + (weeks === 1 ? '' : 's') + ' — drop it and i won’t re-learn it from your work'
    });
    if (!card0) return false;
    const r = { d: card0.row }, item = card0.item, btns = card0.btns;
    const card = beatCards && beatCards.claim({
      kind: 'arc', runId: runId, node: r.d, data: { dim: dim, belief: belief.id },
      handoff: () => turninQueue.length > 0 ? 'memory' : null,
      onGone: () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); }
    });
    if (!card) { if (r.d && r.d.parentNode) r.d.remove(); return false; }
    function settle(label, isDeny) {
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      card.finish({ delay: 600 });
    }
    // the belief AS IT STANDS RIGHT NOW. The card can sit in the feed for minutes; the dossier does not freeze
    // while it does. Every write below re-reads it first (see commit()).
    function liveBelief() {
      try { return (DossierStore.beliefs(dim) || []).find(b => b && b.id === belief.id) || null; } catch (_) { return null; }
    }
    function commit(answer) {
      if (!card.decide()) return;
      if (answer === 'defer') {
        /* NOT NOW — a statement about the MOMENT, and nothing else. This used to route through
           GoalStore.markOffered, whose offered-fingerprint ALSO gates pendingDecomposition: deferring the
           staleness QUESTION therefore withdrew the belief's MILESTONE-DECOMPOSITION offer too, permanently,
           until its text changed. The session-scoped set silences only this ask, only this session; the arc's own
           offer is untouched. No fold either — a "later" says nothing about whether this channel's offers are
           any good. The copy says exactly what now happens. */
        if (fp) reconfirmDeferred.add(fp);
        settle('✓ i’ll ask again later', false);
        return;
      }
      /* THE RESURRECT GUARD. If the belief was retired or deleted between render and click, DossierStore.upsert
         with an unknown id does NOT update anything — it PUSHES A BRAND-NEW belief, stamped commander/stated,
         inventing a Commander assertion that never happened. (forget on a gone id is a harmless no-op, but the
         -1 evidence would still land on a dimension for a belief that no longer exists.) Settle quietly instead:
         the question was overtaken by events, and the station has nothing honest to record about it. */
      const live = liveBelief();
      if (!live) { settle('✓ already handled', false); return; }
      const confirmed = answer === 'confirm';
      // A PINNED belief is Commander-asserted-durable; this card may never forget one. (staleness() never marks a
      // pinned belief stale, so this only fires when it was pinned AFTER the card rendered — but the card must
      // not be the one path that quietly overrides a pin.)
      if (!confirmed && live.pinned) { settle('✕ it’s pinned — kept', true); return; }
      try {
        if (confirmed) {
          /* CONFIRMED OUT LOUD → the belief IS now Commander-stated evidence, and is recorded as such. Without the
             weight re-stamp a seed-weighted belief stays at confidence 0 and this exact question returns forever.
             THE TEXT WRITTEN BACK IS THE LIVE ONE, NEVER THE RENDER-TIME CAPTURE (fixed 2026-08-04). This card can
             sit in the feed for minutes, and the COMMANDER panel is editable the whole time. Writing the captured
             `text` silently REVERTED an edit the Commander made after the card rendered — and then stamped the
             reverted wording commander/stated, i.e. recorded a sentence they had just replaced as one they had
             just said. `live` is the belief as it stands at CLICK time; its text is the only honest thing to
             re-affirm. (The card's own citation still quotes what it SHOWED — that part is history.)
             THE WEIGHT UPGRADE IS DELIBERATE, INCLUDING THE seed→stated JUMP: answering "still true?" with "still
             true" IS a statement of the CONTENT, not merely of the paraphrase, so 'stated' is the truthful weight
             and it is the only thing that ends the three-weekly re-ask. What it is NOT is a claim that these were
             the Commander's WORDS — a station-authored belief was paraphrased by the station. So the confirmation
             also stamps evidenceRef.kind='confirmed', and beliefCiteKind reads that FIRST, so every later card
             cites it as `you confirmed "…"` rather than `you said "…"`. Affirmation and authorship, kept apart. */
          DossierStore.upsert(dim, { id: belief.id, text: live.text, source: 'commander', weight: 'stated', evidenceRef: { kind: 'confirmed' } });
          if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.noteEvidence) UnderstandingStore.noteEvidence(dim, +1);
        } else {
          if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.noteEvidence) UnderstandingStore.noteEvidence(dim, -1);
          DossierStore.forget(dim, belief.id);
          if (typeof RecQualityStore !== 'undefined' && RecQualityStore.denyBelief) RecQualityStore.denyBelief(fp);
        }
      } catch (_) {}
      /* THE CHANNEL LEARNS THE REAL ANSWER. This used to fold 'engaged' (a positive) on BOTH answers, on the
         theory that any answer is the ask doing its job — which made the arc channel a one-way ratchet that could
         only ever rate itself up. A "no" here means the station built an ask on a belief that was not true: that
         is a decline, and the loop is worth nothing if it cannot hear one. */
      if (confirmed) recAccept('arc', dim, false); else recDecline('arc', dim, false);
      settle(confirmed ? '✓ still true' : '✕ dropped it', !confirmed);
      if (typeof StationUI !== 'undefined' && StationUI.rerender) { try { StationUI.rerender('commander'); } catch (_) {} }
    }
    const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
    mk('Still true', '', () => commit('confirm'));
    mk('Not now', '', () => commit('defer'));
    mk('Not anymore', 'deny', () => commit('deny'));
    autoscroll();
    return true;
  }
  /* THE ATTRIBUTION STAMP. A run started right after an accepted offer IS that offer's work — so the stamp is
     written where every other piece of a run's provenance is written: RUN_META, at run start (`rec`). It rides
     the same ledger the recipe spine and rateWork already read, which is what makes the loop's outcome
     attributable at all. null for every ordinary run — the overwhelming majority. */
  function recClaimRun(runId, agentId) {
    try { if (typeof RecQualityStore !== 'undefined' && RecQualityStore.claimForRun) return RecQualityStore.claimForRun(runId, agentId); } catch (_) {}
    return null;
  }
  /* ONE citation grammar, DISCRIMINATED BY WHERE THE WORDS CAME FROM (truthful telemetry, 2026-08-04).
     The card used to say `because you said "…"` about every citation it had. But a study proposal falls back to
     the run's DIRECTIVE when the model returns no QUOTE line (study.js stamps evidenceRef.kind='directive'), and a
     directive is very often machine-composed — a routine, a recipe, a scheduled brief. Presenting that as the
     Commander's own speech is the app asserting something the harness cannot prove. So each source gets its own
     honest phrasing, and anything unlabelled falls back to a neutral quote that claims nothing about who spoke.
       verbatim     — words the Commander really typed (a located, grounded quote)
       confirmed    — the station's OWN wording, which the Commander then affirmed out loud (the re-confirm card).
                      Affirming a paraphrase is real evidence about the CONTENT and no evidence at all about the
                      authorship, so it gets its own verb: `you confirmed "…"`, never `you said "…"`.
       directive    — the task text that drove the run; it may have been composed for them
       conversation — somewhere in the exchange, speaker not established */
  function recCite(text, kind) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return '';
    if (kind === 'verbatim') return 'you said “' + t + '”';
    if (kind === 'confirmed') return 'you confirmed “' + t + '”';
    if (kind === 'directive') return 'from the task you gave me: “' + t + '”';
    if (kind === 'conversation') return 'from the conversation: “' + t + '”';
    return 'from “' + t + '”';
  }
  /* A DOSSIER BELIEF'S OWN CITATION KIND (truthful telemetry, 2026-08-04). The arc and the re-confirm card cited
     every goals belief as `you said "…"` — but the dossier holds beliefs the STATION observed from work (study
     writes source:'study', weight:'observed') and beliefs synthesised during onboarding, and quoting those back as
     the Commander's speech is the card asserting something the harness cannot prove. So the belief's OWN recorded
     provenance picks the phrasing recCite already has: only Commander-authored evidence may be rendered as speech;
     an observed belief cites the work it was observed from; anything unlabelled claims no speaker at all. */
  function beliefCiteKind(b) {
    const ref = String((b && b.evidenceRef && b.evidenceRef.kind) || '');
    /* CONFIRMED BEATS STATED, AND IS CHECKED FIRST (2026-08-04). The re-confirm card upgrades a station-authored
       belief to commander/stated — truthfully, because affirming "still true?" IS a statement of the content. But
       the WORDS are still the station's paraphrase, so falling through to the 'stated' clause below would have
       every later card quote the Commander saying something they never said. The confirmation stamp is the more
       specific fact, so it wins. */
    if (ref === 'confirmed') return 'confirmed';
    const w = String((b && b.weight) || '');
    const src = String((b && b.source) || '');
    // NB: NOT source:'curiosity'. A curiosity answer is 'stated' when the Commander TYPED it (caught by the weight
    // clause) and 'seed' when they tapped a canned chip (interview.js beliefFromAnswer) — and a canned chip is the
    // station's own sentence, which this clause was rendering back at them as `you said "…"`.
    if (w === 'stated' || src === 'commander') return 'verbatim';
    if (ref === 'verbatim' || ref === 'directive' || ref === 'conversation') return ref;
    return '';   // observed / study / onboarding-synth / seed → the neutral 'from "…"' quote (claims no speaker)
  }
  // a mined thread's quote is located in the whole exchange, which includes the AGENT's turns — threadmine
  // stamps speaker:'user' only when it also matched the Commander's own turns. Anything else is softened.
  function threadCiteKind(prop) { return (prop && prop.speaker === 'user') ? 'verbatim' : 'conversation'; }

  /* ── the candidate builders. Each is side-effect-free — it may only READ its store. The two fetch-backed
        turn-ins additionally GET a stash the sidecar already wrote during the run (a local read, no spend).

        THE ONCE LAW (fixed 2026-08-04). Every per-run token — arcOnce, and beatCards.once() for trust /
        study / thread — used to be SPENT here, at collection. A candidate that lost the moment (or a pass
        that stood down after building it) therefore burned the run's only chance to offer that channel,
        and a re-fired agent.run.end — which really does happen — found every token spent with nothing ever
        shown. Collection now only ASKS (hasSeen / arcSeen); the token is consumed inside fire(), so it
        means exactly one thing: "a card for this run was actually rendered." The deferred queue paths
        (offerStudy / offerThread) consume the SAME token before rendering, so a run can never be offered
        twice by the queue and the pass racing each other. ── */

  // ARC — the goal-arc confirm. Cited by the Commander's OWN goal belief, read synchronously; the paid
  // decomposition call inside offerArc happens only if the arc actually wins the moment.
  function arcCandidate(runId) {
    if (typeof GoalStore === 'undefined' || typeof Dialogue === 'undefined') return null;
    if (!GoalStore.willOfferDecomposition || !GoalStore.willOfferDecomposition()) return null;
    if (slotCanArc(runId) !== 'free') return null;
    let belief = null;
    try { belief = GoalStore.pendingDecomposition ? GoalStore.pendingDecomposition() : null; } catch (_) {}
    const text = belief && belief.text ? String(belief.text).trim() : '';
    if (!text) return null;                                  // nothing to cite → the arc stays silent
    if (arcSeen(runId)) return null;                         // one confirm per run — READ only (see the once law below)
    /* THE STALENESS GUARD (quality loop, Q3). Before building an arc on this belief, is it still true? A goal
       the Commander stated a month ago that nothing since has corroborated is not something the station may
       ASSERT ("because you said X") — decomposing it into a milestone tree would be building a plan on a memory
       we cannot stand behind. So the SAME slot carries a QUESTION instead: "still true?". Confirm re-stamps the
       belief (and the arc proposal returns naturally at a later run, now grounded); deny retires it and is
       never asked again for this belief state. A stale belief thereby becomes a good question rather than a
       confident bad recommendation. */
    const stale = recStale(belief, 'goals');
    if (stale && stale.stale) {
      const fp = recBeliefFp('goals', belief);
      if (recReconfirmDenied(fp)) return null;               // asked, answered "no" — silence until the belief changes
      /* asked, answered "not now" — silence for the rest of THIS session. KNOWN AND ACCEPTED CONSEQUENCE:
         pendingDecomposition returns the FIRST un-offered goals belief, so a deferred one keeps the arc lane
         quiet for every belief behind it until the session ends. That is the same shape the DENY path above has
         always had, and it is the better half of the trade — the alternative (markOffered) bought one more ask
         by permanently withdrawing this belief's milestone-decomposition offer, which is the bug being fixed. */
      if (fp && reconfirmDeferred.has(fp)) return null;
      const weeks = Math.max(1, Math.round(stale.ageDays / 7));
      // NO strength reading on an ASK: strength discounts a weak ASSERTION, and this card asserts nothing.
      // The citation is phrased by the belief's OWN provenance — a study-observed goal was never "said".
      return { kind: 'arc', dim: 'goals', reconfirm: true, why: recCite(text, beliefCiteKind(belief)), title: text,
               fire: () => { if (arcOnce(runId)) reconfirmCard(belief, 'goals', weeks, fp, runId); } };
    }
    // STRENGTH: the cited goal belief's OWN freshness × how well the goals dimension is corroborated. A goal the
    // Commander stated last season, with nothing since to confirm it, is a weaker thing to build an arc on.
    return { kind: 'arc', dim: 'goals', why: recCite(text, beliefCiteKind(belief)), strength: recStrengthOfBelief(belief, 'goals'),
             title: text, fire: () => { if (arcOnce(runId)) offerArc(runId); } };
  }

  // TRUST — the earned-autonomy offer. Cited by the REAL track record the offer was computed from.
  function trustCandidate(runId) {
    if (typeof TrustStore === 'undefined') return null;
    if (trustBusy() || slotCanTrust(runId) !== 'free') return null;
    if (!TrustStore.canShow || !TrustStore.canShow()) return null;          // session cap spent
    const offer = TrustStore.currentOffer ? TrustStore.currentOffer() : null;
    if (!offer) return null;
    const pv = offer.provenance || {};
    const streak = Math.max(0, Number(pv.streak) || 0);
    const runs = Math.max(0, Number(pv.runs) || 0);
    const why = streak ? (streak + ' approvals in a row')
      : (runs ? (runs + ' tasks at ' + (Number(pv.confidence) || 0) + '% satisfaction') : '');
    if (!why) return null;                                   // no provable track record → no offer
    if (!runId || !beatCards || beatCards.hasSeen('trust', runId)) return null;   // one offer per run — READ only
    // STRENGTH: the offer's OWN provenance confidence — the same satisfaction percentage the citation quotes,
    // read as 0..1. An offer computed from a 60%-satisfaction record is a thinner thing to propose autonomy on
    // than one computed from 95%, and now says so. Absent/unreadable → null → neutral (never a fabricated 0).
    return { kind: 'trust', why: why, streak: streak, strength: recStrengthOfPercent(pv.confidence),
             // the ledger title names the CONFIGURATION CHANGE being offered, not an idea — this channel proposes
             // a permission, so it can never collide with a proposal title in the shared declined memory.
             title: offer.kind === 'grant' ? 'grant unattended file writes' : ('raise autonomy to ' + String(offer.to || '').toUpperCase()),
             fire: () => { if (beatCards.once('trust', runId)) trustCard(offer, runId); } };
  }

  // RATE THE WORK — the primary leveling beat. Cited by the run's OWN recorded work (never fabricated: the
  // counters come from the live run stash, which is also what gates it).
  function rateCandidate(agentId, runId) {
    if (!runId || rateStatus(agentId, runId) !== 'ready') return null;
    const w = runWork.get(runId) || {};
    const tools = Math.max(0, Number(w.toolsOk) || 0), made = Math.max(0, Number(w.delivered) || 0);
    const bits = [];
    if (tools > 0) bits.push(tools + ' tool step' + (tools === 1 ? '' : 's'));
    if (made > 0) bits.push(made + ' deliverable' + (made === 1 ? '' : 's'));
    if (!bits.length) return null;
    return { kind: 'rate', why: 'this run did real work — ' + bits.join(' and ') + ' — and you haven’t rated it',
             fire: () => { maybeStandaloneRate(agentId, runId); } };
  }

  // ONGOING SUGGESTION — cited by what the Commander has actually told the station about themselves. An
  // idea with nothing learned behind it cannot cite, so it stays quiet.
  function suggestCandidate() {
    if (typeof SuggestStore === 'undefined' || !SuggestStore.willSuggest || !SuggestStore.fire) return null;
    if (!SuggestStore.willSuggest()) return null;
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    const known = (sum && Array.isArray(sum.known)) ? sum.known.slice(-2) : [];
    if (!known.length) return null;
    const labels = known.map(k => String(dimLabel(k)).toLowerCase());
    return { kind: 'suggest', why: 'you’ve told me about your ' + labels.join(' and '),
             fire: () => { SuggestStore.fire(); } };
  }

  // SELF-GROWING SEED — cited by the real repeat counter behind the shape.
  function seedCandidate() {
    if (typeof SeedStore === 'undefined' || !SeedStore.willPropose || !SeedStore.propose) return null;
    if (!SeedStore.willPropose()) return null;
    let s = null; try { s = SeedStore._pick ? SeedStore._pick() : null; } catch (_) {}
    const title = (s && s.title) ? String(s.title).trim() : '';
    if (!title) return null;
    const n = Math.max(0, Math.floor(Number(s.count) || 0));
    // STRENGTH: the REAL repeat count behind the shape — a shape asked for four times is corroborated; one seen
    // once is real but thin, and says so by speaking later rather than by claiming less.
    return { kind: 'seed', why: 'you keep asking me to “' + title.toLowerCase() + '”' + (n > 1 ? ' (' + n + '×)' : ''),
             strength: recStrengthOfCount(n), title: title, fire: () => { SeedStore.propose(); } };
  }

  // ROUTINE NUDGE — cited by the real hand-launch count.
  function routineCandidate() {
    if (typeof RoutineNudgeStore === 'undefined' || !RoutineNudgeStore.willPropose || !RoutineNudgeStore.propose) return null;
    if (!RoutineNudgeStore.willPropose()) return null;
    let c = null; try { c = RoutineNudgeStore._pick ? RoutineNudgeStore._pick() : null; } catch (_) {}
    const nm = (c && c.name) ? String(c.name).trim() : '';
    const n = Math.max(0, Math.floor(Number(c && c.n) || 0));
    if (!nm || n < 1) return null;
    // STRENGTH: the same real hand-launch count the citation quotes (corroboration, saturating).
    return { kind: 'routine', why: 'you’ve launched ' + nm + ' ' + n + ' times by hand',
             strength: recStrengthOfCount(n), title: nm, fire: () => { RoutineNudgeStore.propose(); } };
  }

  // ADAPTIVE RECRUITMENT — cited by the recruiter's own counter-derived why (the SAME string the bay's
  // curated shelf shows, so the beat and the shelf can never disagree).
  function recruitCandidate() {
    if (recruitShown) return null;                                          // one recruit offer per session
    if (typeof RecruiterStore === 'undefined' || !RecruiterStore.topPick) return null;
    if (typeof App === 'undefined' || !App.openSummonBay) return null;      // no deep-link target → don't offer
    let pick = null; try { pick = RecruiterStore.topPick(); } catch (_) { return null; }
    const why = (pick && pick.spec) ? String(pick.why || '').trim() : '';
    if (!why) return null;                                                  // cold/thin signal → silence
    // STRENGTH: the recruiter ALREADY computes one — recruiter.js derives it from EVIDENCE VOLUME (the share of
    // the Commander's real work this class's kit captures, lifted toward 1 as the sample count clears the floor)
    // and recruiterstore.topPick carries it the whole way here. This beat then dropped it, so a pick standing on
    // three samples entered the spine indistinguishable from one standing on forty. recommend.js is explicit
    // that abstaining is a small RELATIVE ADVANTAGE over reporting a low reading honestly, and equally explicit
    // that the channels which abstain do so because there is nothing to read. This one has something to read.
    const conf = Number(pick.confidence);
    const strength = (Number.isFinite(conf) && conf > 0) ? (conf > 1 ? 1 : conf) : null;
    // the class the bay would summon — the same noun the curated shelf shows, so a "no thanks" here and a
    // dismissal there are the same fact in the one memory.
    const cls = String((pick.spec && (pick.spec.name || pick.spec.title)) || '').trim();
    return { kind: 'recruit', why: why, strength: strength, title: cls ? ('recruit a ' + cls) : '',
             fire: () => { maybeRecruit(); } };
  }

  // JUST-IN-TIME CURIOSITY — cited by the dimension it is actually targeting, phrased plainly.
  function curiosityCandidate() {
    if (typeof CuriosityStore === 'undefined') return null;
    const dim = CuriosityStore.consider();
    if (!dim) return null;
    return { kind: 'curiosity', dim: dim, why: 'i still don’t know your ' + String(dimLabel(dim)).toLowerCase(),
             title: 'learn your ' + String(dimLabel(dim)).toLowerCase(),
             fire: () => { CuriosityStore.markShown(dim); curiosityNudge(dim); } };
  }

  // STUDY — the belief turn-in. Its evidence is the VERBATIM directive the belief was observed from, which
  // only arrives with the proposal, so the stash (already written by the sidecar during the run — a local
  // read, no model spend) is fetched before the spine decides. A proposal with no verbatim grounding is
  // dropped here rather than surfaced with an empty provenance line.
  async function studyCandidate(runId, agentId) {
    if (typeof StudyStore === 'undefined') return null;
    if (studyBusy() || slotCanStudy(runId) !== 'free') return null;   // runId = the SELF-KEY: the pass's own reservation must not veto it
    if (!runId || !beatCards || beatCards.hasSeen('study', runId)) return null;   // one offer per run — READ only
    if (!StudyStore.canShow || !StudyStore.canShow()) return null;          // session cap (per-session, not deferrable)
    const proposals = await StudyStore.fetchProposals(runId, agentId);
    const prop = StudyStore.nextLive(proposals);   // drops resolved/declined/ignored + unmatchable retires
    if (!prop) return null;
    const why = prop.evidence ? recCite(prop.evidence, prop.evidenceRef && prop.evidenceRef.kind)
      : (prop.kind === 'retire' ? String(prop.text || '').trim() : '');
    if (!why) return null;
    // STRENGTH: the CONFIDENCE the understanding engine already holds for the dimension this proposal targets —
    // an assertion aimed at a dimension the station barely understands is a thinner thing to raise. Not a
    // freshness read: a RETIRE proposal is most valuable exactly when its belief is oldest.
    return { kind: 'study', dim: prop.dim, why: why, strength: recStrengthOfDim(prop.dim),
             fire: () => { if (beatCards.once('study', runId)) studyCard(prop, agentId, runId); } };
  }

  // THREAD — the mined-idea turn-in. Its evidence is the verbatim quote the mine grounded the idea in.
  async function threadCandidate(runId, agentId) {
    if (typeof ThreadStore === 'undefined') return null;
    if (threadBusy() || slotCanThread(runId) !== 'free') return null;  // runId = the SELF-KEY (see slotCanStudy)
    if (!runId || !beatCards || beatCards.hasSeen('thread', runId)) return null;  // one offer per run — READ only
    if (!ThreadStore.canShow || !ThreadStore.canShow()) return null;        // session cap
    const batch = await ThreadStore.fetchProposals(runId, agentId);
    const prop = ThreadStore.nextLive(batch.proposals);   // drops resolved/ignored candidates
    if (!prop) return null;
    const why = recCite(prop.spec, threadCiteKind(prop));
    if (!why) return null;
    // NO STRENGTH, and not for a convenient reason: a mined idea targets no dossier dimension (no dim → no
    // confidence to read) and its quote comes from the run that just ended (no age to read). There is nothing
    // here the station holds, and inventing a reading would be worse than the small structural edge neutrality
    // buys it — see the strength block above, which states that residual tradeoff rather than hiding it.
    return { kind: 'thread', why: why, title: String(prop.spec || '').trim(),
             fire: () => { if (beatCards.once('thread', runId)) threadCard(prop, agentId, batch.runId || runId); } };
  }

  /* THE PASS. Runs TWICE per clean run end — once at the FAST arm (phase !== 'slow': the rate beat, which
     needs nothing the run has yet to produce) and once at the SLOW arm ('slow': every channel whose evidence
     the run must first WRITE). Both phases share the one arbiter and fire at most one candidate between them. */
  async function recommendPass(p, phase) {
    const takeoverOnly = phase === 'takeover';
    const slow = phase !== 'fast';
    const agentId = (p && p.agentId) || 'agent';
    const isHeroRun = agentId === 'agent';
    const runId = (p && (p.runId || p.id)) || null;
    // G2.4: arm the self-retrying rate fallback FIRST, before any stand-down guard — a focused tutorial
    // panel / busy stream / open deck may block THIS moment, but the rating for a run that did real work
    // must eventually fire (permanent ineligibility stops it inside). Armed once, on the fast arm.
    if (!slow && runId) armRateFallback(agentId, runId);
    if (momentBlocked()) {
      /* A BLOCKED MOMENT MUST NOT DROP THE RUN'S TURN-INS. Returning here discarded this run's study and
         thread offers FOREVER (the pre-spine listeners queued them). Enqueue the markers instead — the
         existing FIFO flush paths re-fetch and re-offer them at a later, free moment. */
      if (slow && !takeoverOnly && isHeroRun && runId) { queueStudy(runId, agentId); queueThread(runId, agentId); }
      return;
    }
    if (typeof Recommend === 'undefined' || !Recommend.pick) return;        // no spine → no proactive beat
    const lifecycle = beatCards, gen = lifecycle ? lifecycle.generation() : 0;
    const stale = () => !lifecycle || beatCards !== lifecycle || lifecycle.generation() !== gen;

    const cands = [];
    let study = null, thread = null;
    /* ── THE FAST ARM: the rating, and only the rating. It carries one floor the turn-ins never did: this
          run's memory turn-in owns the moment, and a real turn-in deck still sitting in the feed suppresses
          a fresh ask (the visible dogpile). Standing down cannot STARVE it — armRateFallback ran above. ── */
    if (!slow) {
      if (turninOwnsMoment(runId)) return;
      const rate = rateCandidate(agentId, runId); if (rate) cands.push(rate);
    } else if (askBudgetSpent()) {
      return;   // the session's proactive-ask budget is spent: the station stays quiet for every consent channel
    } else if (takeoverOnly) {
      if (!isHeroRun || turninOwnsMoment(runId) || typeof WorkflowTakeoverStore === 'undefined') return;
      await WorkflowTakeoverStore.refresh();
      if (stale() || momentBlocked()) return;
      const takeover = WorkflowTakeoverStore.candidate(agentId);
      if (takeover) cands.push(takeover);
    } else {
      // ── the TURN-IN half: hero-only, gated by the shared arbiter + the stand-down guards ──
      if (isHeroRun) {
        const arc = arcCandidate(runId); if (arc) cands.push(arc);
        const trust = trustCandidate(runId); if (trust) cands.push(trust);
      }
      // the GENTLE half — same visible-dogpile floor the rating honors, and HERO-ONLY: a summoned worker's
      // clean run must never fire a suggestion / seed / routine / recruitment / curiosity ask against the
      // hero's dossier.
      if (!turninOwnsMoment(runId) && isHeroRun) {
        // FIRE ON SALIENCE: a basic conversational turn (not a task) earns NO gentle beat — mirrors the
        // server's reflection gate (isTask) so chatter never triggers an ask. Fail-open if meta is unknown.
        const meta = runId ? runMeta(runId) : null;
        if (!meta || meta.isTask) {
          // An intent offer is earned by the Commander's just-finished directive, so it is allowed before
          // the accumulated-work floor. Consume the staged text exactly once on the slow post-run arm.
          const staged = meta && meta.intentOfferText; if (meta) meta.intentOfferText = null;
          // WORK-EARNED ASK FLOOR: a real task-run banks toward the session's ask budget, and no gentle
          // unsolicited beat fires until the station has completed Curiosity.MIN_WORK task-runs this session.
          if (typeof CuriosityStore !== 'undefined' && CuriosityStore.noteWork) CuriosityStore.noteWork();
          const earned = !(typeof CuriosityStore !== 'undefined' && CuriosityStore.earned && !CuriosityStore.earned());
          // Three separate completed requests earn this specific offer even across browser sessions.
          let takeover = null;
          if (typeof WorkflowTakeoverStore !== 'undefined') {
            await WorkflowTakeoverStore.refresh();
            if (stale() || momentBlocked()) return;
            takeover = WorkflowTakeoverStore.candidate(agentId);
          }
          if (takeover) cands.push(takeover);
          if (!takeover && staged && maybeIntentOffer(staged)) return;
          if (earned && !takeover) {
            const s = suggestCandidate(); if (s) cands.push(s);                 // SuggestStore.willSuggest()
            const sd = seedCandidate(); if (sd) cands.push(sd);                 // SeedStore.willPropose()
            if (typeof RoutineNudgeStore !== 'undefined' && RoutineNudgeStore.onRunEnd) { try { RoutineNudgeStore.onRunEnd(); } catch (_) {} }
            const rt = routineCandidate(); if (rt) cands.push(rt);              // RoutineNudgeStore.willPropose()
            const rc = recruitCandidate(); if (rc) cands.push(rc);              // RecruiterStore.topPick()
            const cu = curiosityCandidate(); if (cu) cands.push(cu);            // CuriosityStore.consider()
          }
        }
      }

      /* ── the FETCH-BACKED turn-ins. They outrank everything below memory, so their REAL evidence has to be
            on the table before the spine decides. Both are local reads of a stash the sidecar wrote during the
            run (no model spend) — and at THIS arm that stash is the run's OWN batch, not the previous run's.
            Their kinds are RESERVED across the await so nothing lower can take the slot mid-fetch; the pass
            passes its own runId as the self-key everywhere so those reservations never veto its own
            candidates (beatcard.js can()), and they are released the moment the fetch resolves. ── */
      if (isHeroRun && runId && !stale()) {
        lifecycle.reserve('study', runId); lifecycle.reserve('thread', runId);
        try {
          const both = await Promise.all([studyCandidate(runId, agentId), threadCandidate(runId, agentId)]);
          study = both[0]; thread = both[1];
        } catch (_) {}
        if (!stale()) { lifecycle.releaseReservation('study', runId); lifecycle.releaseReservation('thread', runId); }
      }
      if (stale()) return;                  // the COMMS generation turned over mid-fetch (stream switch / new session)
      if (study) cands.push(study);
      if (thread) cands.push(thread);
      // re-check the moment after the awaits — reflection's memory deck may have claimed it meanwhile.
      if (momentBlocked()) { queueStudy(runId, agentId); queueThread(runId, agentId); return; }
    }

    /* THE EARNED WEIGHT (quality loop, Q2). Each candidate carries its channel's REAL outcome history into the
       scorer — read here, once, rather than in ten builders. A channel whose accepted offers produced 👎 work
       ranks lower within its band; one that produced 👍 work ranks a little higher. It can never cross a band,
       and the floor means it can never be silenced by quality alone: priority and the per-channel caps remain
       the law. A never-rated channel reads neutral, so nothing changes until real outcomes exist. */
    for (const c of cands) { if (c && c.quality == null) c.quality = recQualityOf(c.kind, c.dim); }
    /* THE LEARNED PREFERENCE (one-memory lane). The same read, in the same place, from the OTHER memory: the
       durable ledger's decayed tally of what the Commander has actually accepted and declined on every surface.
       Two-sided and bounded (recommend.js PREF_MAX) — see that module for why this modifier, alone, may promote. */
    for (const c of cands) { if (c && c.preference == null) c.preference = recPreferenceOf(c.kind, c.dim); }
    /* THE SESSION DECLINE COUNT (dead-wires lane): the third read, same place — a channel the Commander already
       waved off this session gets structurally quieter for the rest of it (recommend.js DECLINE_STEP/DECLINE_MAX,
       populated for the first time here). Per-channel caps and the declined memory remain the real floor. */
    for (const c of cands) { if (c && c.declines == null) c.declines = recDeclinesOf(c.kind); }

    /* AND THE HARD HALF OF THAT MEMORY: an offer whose exact proposal the Commander has already declined ANYWHERE
       is not re-ranked, it is REMOVED. That is the discipline every server-side propose filter already holds, and
       the spine was the last surface still able to re-raise a thing that had been explicitly waved off — the most
       visible place in the product to do it, since this one interrupts. A losing candidate is dropped BEFORE the
       queue decision below, so a suppressed turn-in is not re-queued to be suppressed again at the next run. */
    const live = [];
    for (const c of cands) {
      if (recAlreadyDeclined(c)) { if (c === study) study = null; if (c === thread) thread = null; continue; }
      live.push(c);
    }

    const winner = Recommend.pick(live, recUnderstanding());
    // DEFERRED, NEVER STARVED: a fetched turn-in that lost the moment goes back on its FIFO queue and
    // re-offers at the next task end (the pre-spine queue path, unchanged).
    if (study && winner !== study) queueStudy(runId, agentId);
    if (thread && winner !== thread) queueThread(runId, agentId);
    if (!winner) return;                    // evidence or silence
    // the shared slot still has the last word: a deferred beat drained at the sweep may already hold it.
    if (lifecycle.canOffer(Recommend.slotKindOf(winner.kind)) !== 'free') return;
    try { winner.fire(); } catch (_) {}
    /* THE IMPRESSION GOES ON THE ONE LEDGER — after fire(), never before: a row that says "shown" for a card that
       threw on the way to the screen is the app asserting something the harness cannot prove. Channels that mint
       their own rows (study, suggest) and the two that are not offers at all (rate, memory) are refused inside
       RecLedger.note, so this call is unconditional here and correct for every channel. */
    try { if (typeof RecLedger !== 'undefined' && RecLedger.note) RecLedger.note(winner); } catch (_) {}
    // spend one unit of the session ask budget — but only for a card the station CHOSE to raise.
    if (Recommend.asksBudget && Recommend.asksBudget(winner.kind)) sessionAsks += 1;
  }

  function wireCuriosity() {
    if (curiosityWired || typeof U === 'undefined' || !U.bus) return;
    curiosityWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;   // only after a clean, successful run — never nag after a stop/limit/error
      // TWO arms, ONE arbiter (see BEAT_ARM_MS / BEAT_SLOW_ARM_MS): the rating collects the moment the reply
      // has rendered; every channel whose evidence the run must first WRITE collects once it exists.
      setTimeout(() => { recommendPass(p, 'fast'); }, BEAT_ARM_MS);
      setTimeout(() => { recommendPass(p, 'slow'); }, BEAT_SLOW_ARM_MS);
    });
  }
  // IDLE-DRIVEN curiosity (the autopilot EARN-CONTEXT branch, autonomy Slice A): the SAME gentle get-to-know-you
  // ask the post-run slot makes, but triggered when the Commander goes IDLE with autonomy enabled — so turning the
  // dial up makes the station proactively LEARN about them between tasks. Shares the curiosity anti-nag (the
  // per-session CAP in CuriosityStore + the single activeNudge), so it can never stack with, or double-ask
  // alongside, the post-run nudge. Defined AFTER wireCuriosity so the post-run slot stays the first occurrence of
  // the suggestion→seed→curiosity precedence (beat-coordination.test locks that ordering by position). Returns
  // true iff a nudge was actually shown (the bool just aids testing).
  function offerCuriosity() {
    if (!log) return false;
    if (isBusy() || interview) return false;                                                       // mid-run / mid-interview
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return false;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return false;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return false;     // a focused panel is up
    if (activeNudge) return false;                                                                  // a gentle beat is already live — one at a time
    if (taskQuestionLive()) return false;   // a pending task question owns the moment
    if (typeof CuriosityStore === 'undefined') return false;
    const dim = CuriosityStore.consider();                                                          // null once the session cap is spent / nothing live to ask
    if (!dim) return false;
    CuriosityStore.markShown(dim);                                                                  // spend the session nudge + durably tally the ask (shared with the post-run path)
    curiosityNudge(dim);
    return true;
  }

  function renderHistory() {
    const h = activeWs ? activeWs.history : [];
    let lastReal = null;   // the trailing dialogue turn (for the error-recovery re-offer below)
    renderingHistory = true;   // suppress the per-row entrance animation across this bulk replay (restored below)
    try {
    for (const m of h) {
      if (m && m.truncated) {   // E3: the local history-cap marker — render it as a dim centered SYSTEM line (not a dropped record)
        if ((m.content || '').trim()) trimMarkerLine(m.content);
        continue;
      }
      // TIMESTAMP TRUTH (P0): pass the turn's STORED real time (m.ts), or `false` when a legacy turn carries none —
      // never `true` here (that would re-stamp replayed history with the current clock, the fabrication we're killing).
      const stamp = (m && m.ts != null) ? m.ts : false;
      if (m.role === 'user') { addUser(m.content, m.attachments, stamp); lastReal = m; continue; }
      // a SYSTEM STATUS marker (sys — e.g. an autosessions run-outcome framing line) renders as a system-styled
      // line, NOT as agent speech; it never seeds the model (historyWindow drops it) and it stays visible in-thread.
      if (m && m.sys) { if ((m.content || '').trim()) toolLine(m.content, !!m.error); continue; }
      if (m.role !== 'assistant') continue;   // only dialogue turns render (a stray system marker never shows as an agent reply)
      if (!(m.content || '').trim()) { if (m.stopped) lastReal = m; continue; }   // zero-token stop: durable recovery truth, never a blank speech row
      // a turn produced by a WORK LINE stage carries its own agentId — replay names that agent, not the focused
      // one, or a reload would silently re-attribute two other agents' work to whoever owns the stream now.
      const spoke = (m && m.agentId && typeof App !== 'undefined' && App.agentName) ? App.agentName(m.agentId) : null;
      const r = row('agent', { stamp: stamp, who: spoke });   // past turns render as plain GROUPED messages; only the LIVE reply is the lit headline
      if (m.error) r.d.classList.add('err');
      renderProse(r.body, m.content);   // same linkify path as live tokens, so replayed history matches
      lastReal = m;
    }
    } finally { renderingHistory = false; }   // future LIVE rows animate again
    // STRANDED-USER LAW: a reload/switch onto a stream whose LAST turn failed (error:true) must not leave the
    // Commander with a dead thread and no way out — load() wiped the live recovery chips. Re-offer a plain retry
    // (offerRetry's context-aware verdict isn't stored per-turn, so the safe universal recovery is a re-run).
    if (lastReal && lastReal.role === 'assistant' && (lastReal.error || lastReal.stopped) && !isBusy()) {
      if (lastReal.stopped) offerTryAgain();
      else offerRetry(null);
    }
  }

  // SWITCH-SURVIVAL: re-render whatever in-flight run we left on the now-displayed stream — its streamed
  // tool lines, its partial reply, and any pending approval — from the Channels snapshot. For an idle stream
  // the snapshot is empty and this is a no-op. (Live token re-binding for a stream switched-to MID-run lands
  // with the frontend-hud change that lifts the "can't switch while busy" guard — see the GATE handoff note.)
  function replayChannel() {
    activeLiveRow = null;   // log was just cleared by load(); drop any stale live controller before re-rendering
    /* …and drop stale call→result pairings for the same reason: load() has just emptied the log, so every
       chip this map points at is now DETACHED. It used to be cleared as a side effect of endToolRail(),
       which is no longer that function's job (see there). Without this, a snapshot holding a RESULT whose
       call was trimmed away would resolve the previous replay's orphaned node — invisibly — and leave the
       chip actually on screen pending forever. Same law as startPresence: a fresh render, a fresh map. */
    pendingChips.clear();
    if (!activeWs || typeof Channels === 'undefined') return;
    const s = Channels.snapshot(activeWs.id);
    if (!s) return;
    // TOOL-RENDER UNIFICATION: re-draw the run's tool activity as the SAME premium chips a live run shows
    // (call → pending chip; result → folds into it by callId), instead of the old dim toolLine downgrade.
    // Fall back to the legacy string lines only if this snapshot predates structured events (older bundle).
    if (s.toolEvents && s.toolEvents.length) {
      for (const e of s.toolEvents) {
        if (e.t === 'result') resolveChip({ callId: e.callId, summary: e.summary, isError: e.isError, ms: e.ms }, e.name);
        else toolChip({ callId: e.callId, name: e.name, argsSummary: e.argsSummary });
      }
      endToolRail();   // close the rail so the partial reply below opens a fresh paragraph, not glued into the chips
    } else {
      for (const t of s.tools) toolLine(t.text, t.isErr);
    }
    if (s.busy || s.acc) {
      const o = streamingAgent(); if (s.acc) o.append(s.acc);
      if (s.busy) activeLiveRow = o; else o.done();   // a still-running stream keeps its live row so new tokens flow into it
    }
    if (s.pending) permissionRow(s.pending, activeWs);
  }

  // A streaming turn's PROSE controller. The agent's text streams into an open paragraph row with a blinking
  // caret; when an action happens (tool call/result, deliverable, approval) the caller breaks the current
  // paragraph so the action row lands BELOW it, and the next tokens open a fresh paragraph under the action —
  // so a turn reads top-to-bottom as "said this → did that → said this", classic-harness style.
  // whoName (optional) = the speaker to stamp on every row this controller opens. Passed by a WORK LINE stage so
  // the transcript names the agent that actually produced the text; omitted everywhere else = the focused agent.
  function streamingAgent(whoName) {
    let seg = null, caret = null, raw = '';   // seg: the currently-open agent row; raw: its accumulated prose (so URLs can be linkified as they complete)
    /* PER-FRAME RENDER COALESCING (2026-08-26 lag fix). Once a paragraph contains any markdown
       marker or URL, renderProse re-parses and rebuilds the WHOLE accumulated paragraph — doing
       that on every streamed token is O(n²) per answer and is a real "COMMS gets slower the
       longer it streams" degradation. raw still accumulates per token (state stays truthful);
       the DOM render + autoscroll fire at most once per animation frame. Everything that needs
       the DOM current RIGHT NOW (closeSeg's empty-stub check, error, cleanTaskIntent, a hidden
       tab where rAF never fires) goes through flushProse() synchronously. */
    let renderQueued = false;
    function flushProse() { renderQueued = false; if (seg) renderProse(seg.body, raw); }
    function queueProse() {
      if (renderQueued) return;
      if (typeof requestAnimationFrame !== 'function' || (typeof document !== 'undefined' && document.hidden)) { flushProse(); autoscroll(); return; }
      renderQueued = true;
      requestAnimationFrame(() => { if (!renderQueued) return; flushProse(); autoscroll(); });
    }
    function open() {
      endToolRail();   // a fresh prose paragraph opening below a rail closes it, so the next tool call starts a NEW rail under this prose (keeps chronological "said → did → said → did")
      seg = row('agent', { stamp: true, who: whoName || null }); raw = '';
      caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▮';
      seg.d.appendChild(caret);   // caret is a sibling of .body, so re-rendering .body's content never disturbs it
    }
    function closeSeg() {   // drop the caret, discard an empty stub, and arm the next token to start fresh
      if (renderQueued) flushProse();   // pending tokens must land before the empty-stub check reads textContent
      if (caret) { caret.remove(); caret = null; }
      if (seg && !seg.body.textContent.trim()) seg.d.remove();
      seg = null; raw = '';
    }
    // A folded /steer note echoes back from the sidecar as a '\n[steering] …\n' token delta. It is the
    // Commander's note, not agent prose — render it as its own dim note row and CLOSE the paragraph around
    // it, so it never sits in a caret'd row that reads as the agent typing it.
    function steerNote(text) {
      endToolRail();
      const r = row('agent', { stamp: true, who: whoName || null });
      r.d.classList.add('tool', 'steer-echo');
      r.body.textContent = '[steering] ' + text;
      autoscroll();
    }
    function plain(t) { if (!t) return; if (!seg) open(); raw += t; queueProse(); }
    return {
      append(t) {
        if (!t) return;
        if (!/(^|\n)\[steering\] /.test(t)) return plain(t);
        // split-with-capture: odd indices are the steering lines, even indices the surrounding prose
        const parts = t.split(/(?:^|\n)\[steering\] ([^\n]*)\n?/);
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 1) { closeSeg(); steerNote(parts[i]); }
          else plain(parts[i]);
        }
      },
      breakSeg() { closeSeg(); },   // an inline action is about to render below — end this paragraph
      cleanTaskIntent() { if (seg && typeof TaskIntent !== 'undefined' && TaskIntent.strip) { raw = TaskIntent.strip(raw); flushProse(); } },
      done() { closeSeg(); },
      // m = the plain-language headline to LEAD with; rawDetail (optional) = the original technical text, kept
      // accessible as a dim sub-line + a title tooltip so debugging info isn't lost, just de-emphasized.
      error(m, rawDetail) {
        if (!seg) open();
        seg.d.classList.add('err');
        raw += (raw ? '\n' : '') + '⚠ ' + m; flushProse();
        if (rawDetail && String(rawDetail).trim() && String(rawDetail).trim() !== String(m).trim()) {
          const sub = document.createElement('span'); sub.className = 'err-detail dim';
          sub.textContent = String(rawDetail).trim();
          sub.title = String(rawDetail).trim();
          seg.d.appendChild(sub);
        }
        if (caret) { caret.remove(); caret = null; } seg = null; raw = '';
      }
    };
  }
  // close the live paragraph (if any) so the action about to render lands BELOW the prose, in order.
  // Also closes any open tool-chip rail — prose resuming means the next tool call starts a fresh rail
  // below the new paragraph, so the feed reads "said → did (rail) → said → did (rail)" in order.
  function breakLive() { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); endToolRail(); }

  // task-vs-chat classification lives in app/classify.js (pure + unit-tested); see Classify.isTaskDirective.

  // ── in-app WORK-ITEM lifecycle (WIRING_AUDIT P1, slice 1): make the directive the Commander sends RIDE A
  //    BELT the same way an admitted Telegram message does. workitem.placed / queue.status / workitem.delivered
  //    have NO NDJSON twin (harness.js streams only agent.* / token / tool / deliverable), so emitting them
  //    locally on U.bus animates the inbound box + the outbound product crate and folds INTAKE/THRU/DWELL/QUEUE
  //    — with zero double-render (U.bus is the only consumer surface; nothing re-broadcasts these back).
  const wiQDepth = new Map();   // agentId -> directive runs in flight (the honest QUEUE gauge for the in-app loop)
  let wiSeq = 0;
  function wiBump(aid, d) { const n = Math.max(0, (wiQDepth.get(aid) || 0) + d); wiQDepth.set(aid, n); return n; }
  function wiEmit(name, payload) { try { if (typeof U !== 'undefined' && U.bus) U.bus.emit(name, payload); } catch (_) {} }

  /* ---------- TURN CONTROLS (harness-standard): interrupt + type-ahead ---------- */
  // INTERRUPT — a per-stream stop. It cancels
  // only the DISPLAYED stream's in-flight run; the plumbing already exists (each stream owns an AbortController
  // here + a server runId) so this just exposes a ⏹ button / Esc for it. Flag the stream interrupted so send()'s
  // catch keeps what already streamed instead of logging an error, and drop that stream's type-ahead queue — a
  // deliberate stop means "I'm taking over", not "now run my backlog".
  function stopActive() {
    if (activeWs?.conversationMode === 'group' && typeof GroupChat !== 'undefined') return GroupChat.stop();
    // /loop: Stop ends the interval watcher too, or the next tick fires a run the user just said they didn't
    // want. Checked BEFORE the isBusy() guard on purpose — a loop is usually WAITING between ticks when you
    // reach for Stop, and an idle-but-armed loop must still be stoppable. Worded "you stopped it" rather than
    // "you stopped the run", because there may well be no run in flight to stop.
    const endedLoop = activeWs ? loopStop(activeWs.id, 'you stopped it') : false;
    if (!activeWs || !isBusy()) {
      // Nothing was running and no loop was armed: Stop did nothing, so SAY nothing-happened rather than
      // returning in silence, which reads as a dead button / broken command.
      if (!endedLoop) localLine('Nothing is running to stop.');
      return;
    }
    const id = activeWs.id;
    interrupted.add(id);
    queued.delete(id);
    // GOAL LOOP: a deliberate Stop means "I'm taking over" — pause any active loop so the teardown's judge doesn't
    // fire the next continuation. (The user resumes it explicitly with /goal resume.)
    if (typeof GoalLoop !== 'undefined') { const g = goalOf(activeWs); if (g && GoalLoop.isActive(g)) { GoalLoop.pause(g, 'you stopped the run'); persistGoal(); } }
    if (typeof Channels !== 'undefined' && Channels.clearPending) Channels.clearPending(id, Date.now());   // a pending approval is moot once stopped
    status('stopping…'); updateControls();
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    const localAbort = () => { const ac = aborters.get(id); if (ac) { try { ac.abort(); } catch (_) {} } };   // aborts the fetch → reader throws → send()'s catch
    const rid = (typeof Channels !== 'undefined') ? Channels.runIdOf(id) : null;
    // STOP MEANS STOP (2026-09-04): the local fetch is torn down only AFTER the sidecar confirmed the kill. A
    // swallowed /api/cancel failure used to render a clean "RUN STOPPED" while the run kept burning server-side;
    // now a refused/unreachable cancel keeps this stream live and un-stopped and SAYS so (stopFailed). No run id
    // yet (the run.start beat has not landed) = nothing to kill server-side, so the local abort stands alone.
    if (rid && typeof Harness !== 'undefined' && Harness.cancel) {
      Promise.resolve(Harness.cancel(rid)).then(v => { if (v && v.ok) localAbort(); else stopFailed(id, v); }, e => stopFailed(id, { ok: false, error: (e && e.message) || String(e), transport: true }));
    } else localAbort();
  }

  // The sidecar did NOT confirm the stop: un-flag the stream (never mark it stopped on a claim the harness can't
  // back), leave the run streaming, and print the friendly transport verdict measured the same way send()'s catch
  // does (Harness.pingEngine → Friendly.friendlyError), so a dead service reads LINK DOWN and a refused stop names
  // its status. STOP stays available — the Commander can press it again.
  function stopFailed(id, v) {
    interrupted.delete(id);
    const alive = (typeof Harness !== 'undefined' && Harness.pingEngine) ? Promise.resolve(Harness.pingEngine()).catch(() => null) : Promise.resolve(null);
    alive.then(engineAlive => {
      const reason = (v && v.error) || 'no answer from the station';
      const verdict = (v && v.transport && typeof Friendly !== 'undefined')
        ? Friendly.friendlyError(new Error(reason), null, { engineAlive: engineAlive }).userMessage
        : reason;
      if (activeWs && activeWs.id === id) {
        localLine('⚠ STOP was not confirmed by the station — the run may still be working. ' + verdict);
        status(isBusy() ? 'stopping… not confirmed' : 'online'); updateControls();
      }
    });
  }

  // The sidecar did NOT record that this approval card is on screen: the fail-closed auto-deny timer keeps
  // running against a prompt it cannot prove anyone saw. Keep the card pending (it IS pending) and warn the
  // Commander to answer now rather than let it silently deny.
  function consentAckFailed(ws, ev, v) {
    if (!isActiveWs(ws)) return;
    localLine('⚠ The station did not confirm it saw this approval card (' + ((v && v.error) || 'no answer') + '). Answer it now — an unseen prompt auto-denies on a timer.');
  }

  // TYPE-AHEAD — a message typed while the stream is busy is QUEUED, not dropped, and auto-sent in order as the
  // stream frees. (A concurrent run on a DIFFERENT stream is still one switch away — this is the same-stream
  // follow-up case.) The pills above the input show what's pending; ✕ cancels one before it sends.
  function enqueue(text) {
    if (!activeWs) return;
    const id = activeWs.id;
    const arr = queued.get(id) || []; arr.push(text); queued.set(id, arr);
    renderQueued();
    if (typeof SFX !== 'undefined' && SFX.type) SFX.type();
  }
  function sendOrQueue(text) {
    const value = String(text == null ? '' : text).trim();
    if (!value || !activeWs) return { ok: false, state: 'empty' };
    if (activeWs.conversationMode === 'group' && typeof GroupChat !== 'undefined') {
      send(value);
      return { ok: true, state: 'started', workstreamId: activeWs.id };
    }
    if (isBusy()) {
      enqueue(value);
      return { ok: true, state: 'queued', workstreamId: activeWs.id };
    }
    send(value);
    return { ok: true, state: 'started', workstreamId: activeWs.id };
  }
  function renderQueued() {
    const strip = el('chat-queued'); if (!strip) return;
    const arr = (activeWs && queued.get(activeWs.id)) || [];
    strip.innerHTML = '';
    arr.forEach((t, i) => {
      const pill = document.createElement('span'); pill.className = 'queued-pill'; pill.title = t;
      const label = document.createElement('span'); label.className = 'queued-text'; label.textContent = t;
      const x = document.createElement('button'); x.className = 'queued-x'; x.type = 'button'; x.textContent = '✕';
      x.setAttribute('aria-label', 'Cancel queued message');
      x.onclick = () => { const a = queued.get(activeWs.id) || []; a.splice(i, 1); a.length ? queued.set(activeWs.id, a) : queued.delete(activeWs.id); renderQueued(); };
      pill.appendChild(document.createTextNode('⤷ ')); pill.appendChild(label); pill.appendChild(x);
      strip.appendChild(pill);
    });
  }
  // a stream just freed (or was switched back to while idle) — send its next queued follow-up. Guarded to the
  // DISPLAYED stream so send()'s DOM writes always target the visible log; a backgrounded queue waits for return.
  function flushQueued(id) {
    if (!id || !activeWs || activeWs.id !== id) return;
    if (isBusy()) return;
    const arr = queued.get(id); if (!arr || !arr.length) return;
    const next = arr.shift(); arr.length ? queued.set(id, arr) : queued.delete(id);
    renderQueued();
    send(next);
  }
  // Persist the truthful tail of a non-clean run. Normal envelopes may already have appended their partial
  // assistant prose; thrown aborts have not. Mark the matching tail or add one durable marker (including empty
  // output), so reload restores recovery without ever rendering a synthetic blank assistant message.
  function markStoppedTurn(ws, content) {
    if (!ws || !Array.isArray(ws.history)) return;
    const text = String(content || '');
    const last = ws.history[ws.history.length - 1];
    if (last && last.role === 'assistant' && !last.error && String(last.content || '') === text) {
      last.stopped = true;
      return;
    }
    ws.history.push({ role: 'assistant', content: text, stopped: true, ts: Date.now() });
  }
  // RETRY — re-run the last turn after an outage / connection drop / in-band error. Discard the trailing failed
  // reply, re-render the thread (dropping the ⚠ row), then resend the last user message WITHOUT echoing it again.
  function retryLast() {
    // A command that returns in silence is indistinguishable from a broken app — say why nothing happened.
    // (Both guards below are reachable from the /retry command AND the error-recovery "try again" chip.)
    if (!activeWs) return localLine('No active workstream to retry in.');
    if (isBusy()) return localLine('This stream is still running — stop it first, then /retry.');
    const h = activeWs.history;
    if (h.length && h[h.length - 1].role === 'assistant' && (h[h.length - 1].error || h[h.length - 1].stopped)) h.pop();   // drop the failed/stopped partial reply
    let text = null;
    for (let i = h.length - 1; i >= 0; i--) { if (h[i].role === 'user') { text = h[i].content; break; } }
    if (text == null) return localLine('Nothing to retry yet — send a message first.');
    load(activeWs);                 // re-render the thread cleanly (the popped ⚠ row is gone)
    const userTurn = h.slice().reverse().find(m => m.role === 'user');
    send(text, { retry: true, retryUserRunId: (userTurn && userTurn.sourceRunId) || activeWs.runIds[activeWs.runIds.length - 1] });    // re-run it; the user turn is already present, so don't echo it
  }
  // The shared plain recovery action for an intentional Stop and unknown retryable faults. It delegates to the
  // same guarded retryLast path as `/retry`, so an inactive/busy stream cannot start a duplicate run.
  /* connector_required (beginner seam Lane 1, 2026-08-22). The MCP manager emits this on the run stream ALONGSIDE
     its "connector X is not connected" throw — the model narrates the error as before, and the station ALSO
     drops one chip under the reply that opens ABILITIES pre-routed at that connector (Friendly.connectorDoor).
     Collected per run here; OFFERED at the run's end from send() (one post-run beat, the same choices() row
     offerRetry uses) — never mid-run, so it can't collide with a live tool rail or a task question. First
     event per run wins: a retried tool call names the same connector twice. */
  const CONNECTOR_NEEDED = new Map();   // runId -> connector_required payload (bounded; cleared on offer)
  let connectorRequiredWired = false;
  function wireConnectorRequired() {
    if (connectorRequiredWired || typeof U === 'undefined' || !U.bus) return;
    connectorRequiredWired = true;
    U.bus.on('connector_required', p => {
      if (!p || !p.runId || !p.connectorId || CONNECTOR_NEEDED.has(p.runId)) return;
      CONNECTOR_NEEDED.set(p.runId, p);
      if (CONNECTOR_NEEDED.size > 40) CONNECTOR_NEEDED.delete(CONNECTOR_NEEDED.keys().next().value);
    });
  }
  // returns true iff a chip was rendered (the bool aids testing)
  function offerConnectorDoor(runId, originWs) {
    if (!runId) return false;
    const ev = CONNECTOR_NEEDED.get(runId); if (!ev) return false;
    CONNECTOR_NEEDED.delete(runId);
    const ws = originWs || activeWs;
    if (ws && typeof Workstreams !== 'undefined') {
      Workstreams.setConnectorHandoff(ws.id, Object.assign({}, ev, { agentId: ws.agentId || 'agent' }));
      App.persist();
    }
    if (!log || !isActiveWs(ws)) return false;
    const door = (typeof Friendly !== 'undefined' && Friendly.connectorDoor) ? Friendly.connectorDoor(ev) : null;
    if (!door) return false;
    choices([{ label: door.label, value: 'connect' }], () => door.run());
    return true;
  }
  // An explicit continuation carries existing history, unlike retryLast(), which repeats the user turn.
  // The connector is re-read on click; no OAuth callback can start work or change the originating agent.
  const connectorContinuing = new Set();
  async function continueConnectorTask(streamId) {
    const ws = Workstreams.get(streamId), h = Workstreams.connectorHandoff(streamId);
    if (!ws || !h || connectorContinuing.has(streamId) || Channels.isBusy(streamId)) return false;
    connectorContinuing.add(streamId);
    try {
      let j = await Harness.api.get('/api/connectors');
      let c = (j.connectors || []).find(x => x.id === h.connectorId);
      if (c && c.enabled && c.state === 'cached' && !c.authRequired) {
        await Harness.api.post('/api/connectors/refresh', { id: h.connectorId });
        j = await Harness.api.get('/api/connectors');
        c = (j.connectors || []).find(x => x.id === h.connectorId);
      }
      if (!c || c.state !== 'up' || !c.enabled || c.authRequired) throw new Error('Connect ' + h.connectorId + ' before continuing.');
      if (h.toolName && !(c.tools || []).includes(h.toolName)) throw new Error('This connection does not offer the operation the task requested. Inspect its tools in ABILITIES.');
      if (Workstreams.connectorHandoff(streamId) !== h || Channels.isBusy(streamId)) return false;
      App.openWorkstream(streamId);
      Workstreams.setConnectorHandoff(streamId, null);
      App.persist();
      await send('Continue the task above using the connected ' + h.connectorId + ' service. Check the account and available operations first. Use the existing results and do not repeat completed actions.', { connectorContinuationOf: h.runId });
      if (ws.runIds[ws.runIds.length - 1] === h.runId) {
        Workstreams.setConnectorHandoff(streamId, h); App.persist();
        return false;   // request never started; keep the user's return path
      }
      return true;
    } catch (e) {
      if (ws.runIds[ws.runIds.length - 1] === h.runId && !Channels.isBusy(streamId) && !Workstreams.connectorHandoff(streamId)) {
        Workstreams.setConnectorHandoff(streamId, h); App.persist();
      }
      if (typeof StationUI !== 'undefined') StationUI.notify(e.message || 'Could not verify the connection. Try again.', 'warn');
      return false;
    } finally { connectorContinuing.delete(streamId); }
  }
  function offerTryAgain() {
    choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast());
  }
  // Budget-stop legibility (2026-07-23): a 'budget' stop names WHICH spend cap fired and how big it is, in money
  // words — the old "reached this run's limit" read as a runtime setting and sent users hunting in the wrong
  // panel. Scope/cap ride the additive agent.run.end fields; an old sidecar omits them and gets the generic line.
  function budgetStopLine(scope, capUsd) {
    // only show the $ figure when it renders honestly at cent precision (a sub-cent test cap would read "$0.00")
    const cap = (typeof capUsd === 'number' && isFinite(capUsd) && capUsd >= 0.01) ? '$' + capUsd.toFixed(2).replace(/\.00$/, '') + ' ' : '';
    const what = scope === 'run' ? 'hit the ' + cap + 'per-run spend cap'
      : scope === 'agent' ? 'this agent hit its ' + cap + 'lifetime spend cap'
      : scope === 'day' ? 'hit the ' + cap + 'daily spend cap'
      : scope === 'global' ? 'hit the ' + cap + 'all-time spend cap'
      : 'hit a spend cap';
    return what + ' — raise or remove it in MISSION CONTROL → BUDGET';
  }
  // the budget stop's door: open SETTINGS straight on the BUDGET section (the same openTerm(key, section)
  // mechanism friendlyerror's doors use), with retry alongside for after the user has raised the cap.
  function offerBudgetDoor() {
    choices([
      { label: '$ OPEN BUDGET SETTINGS', value: 'budget' },
      { label: '↻ Try again', value: 'retry', quiet: true }
    ], it => {
      if (it && it.value === 'retry') { retryLast(); return; }
      try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('settings', 'budget'); } catch (_) {}
    });
  }
  // a one-tap recovery chip dropped under a failed turn (reuses the suggestion-pill row, which self-removes on
  // tap). CONTEXT-AWARE on the classified verdict: a retryable fault offers "↻ Try again"; an auth/billing
  // fault points at SETTINGS (fix the key) instead of a doomed retry; a capability denial points at SKILLS;
  // a non-retryable, non-actionable fault offers nothing (no blind retry). Falls back to a plain retry chip
  // when called without a verdict (legacy callers / unknowns), preserving the old behavior + value:'retry'.
  function offerRetry(verdict) {
    if (!log) return;
    if (!verdict) { offerTryAgain(); diagAffordance(); return; }
    // ADOPTION (Lane A): every error names its DOOR and opens the exact one. Friendly.actionButton maps the
    // verdict to { label, run } — capdenied -> REFIT (with the named capability), auth/no-key -> the real key
    // field or "reconnect ChatGPT", model-not-found -> models. One source of truth; no local per-action ladder.
    const btn = (typeof Friendly !== 'undefined' && Friendly.actionButton) ? Friendly.actionButton(verdict) : null;
    if (btn) { choices([{ label: btn.label, value: verdict.action }], () => btn.run()); diagAffordance(verdict); return; }
    if (verdict.retryable) { offerTryAgain(); diagAffordance(verdict); return; }
    // non-retryable with no destination: leave no primary chip rather than inviting a doomed re-run — but a stuck
    // user still gets the quiet bug-report affordance so they can grab a diagnostic readout in place.
    diagAffordance(verdict);
  }
  // T3.9 — a SECONDARY, quiet "copy diagnostics for a bug report" affordance dropped under a failed turn, alongside
  // whatever recovery chip offerRetry rendered. Kept low-key (a subdued pill) so it never competes with the primary
  // action; one tap copies the sidecar-assembled, SECRET-FREE report (Diag.copy) so a user in a failure state can
  // email a useful report without leaving the moment. Appends its OWN row so picking the primary chip doesn't wipe it.
  // `verdict` (optional) rides into Diag.copy as opts.context so the PAGE-SIDE fallback report — the one that
  // renders when the sidecar itself can't be read — carries the failure text, its classified kind, and the
  // measured engine-liveness verdict. Without it a dead-engine report would say "something failed" and nothing
  // more, which is the same dead end as the screenshot-only bug reports this whole change exists to end.
  function diagAffordance(verdict) {
    if (!log || typeof Diag === 'undefined' || !Diag.copy) return;
    const context = verdict ? { error: verdict.raw, kind: verdict.kind, engineAlive: verdict.engineAlive } : null;
    const rowEl = document.createElement('div'); rowEl.className = 'choice-row';
    const b = document.createElement('button'); b.className = 'choice quiet'; b.type = 'button';
    b.textContent = '⧉ copy diagnostics for a bug report';   // ⧉ = the house copy glyph (not the 📋 emoji)
    b.addEventListener('click', () => {
      b.disabled = true;
      Diag.copy({ notify: false, context: context }).then(ok => {
        b.textContent = ok ? '✓ diagnostics copied — paste into your report' : 'copy failed — try again';
        if (!ok) { b.disabled = false; return; }
        if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
        setTimeout(() => { try { rowEl.remove(); } catch (_) {} }, 2600);
      });
    });
    rowEl.appendChild(b);
    log.appendChild(rowEl); autoscroll();
  }

  // show the Stop control + the queued pills for whatever stream is on screen. Called from syncStatus (covers
  // switch + turn-end) and at send() start (status goes 'thinking…' without a syncStatus).
  function updateControls() {
    const stop = el('chat-stop'); if (stop) stop.hidden = !isBusy();
    // CONCURRENT SESSIONS: a peer run on this agent no longer disables the composer — the backend admits
    // concurrent same-agent runs (workspace lease guards the real collision). The peer surfaces as the soft
    // status row + a tooltip; send stays live.
    const peer = !isBusy() ? busyPeerFor(activeWs) : null;
    if (input) { input.disabled = false; input.title = peer ? ('This agent is also running in ' + streamLabel(peer)) : ''; }
    const sendBtn = el('chat-send'); if (sendBtn) sendBtn.disabled = false;
    const attachBtn = el('chat-attach'); if (attachBtn) attachBtn.disabled = false;
    renderQueued();
  }

  /* ---------- SLASH COMMANDS: a "/command" palette over the input (harness-standard) ----------
     A leading "/" opens a filterable menu of built-in turn-control commands PLUS the whole recipe
     library — so the missions that live in the dock are one keystroke away in chat too. Selecting a
     recipe drops its directive into the input (first {blank} pre-selected) to fill + send; a built-in
     runs immediately. ↑/↓ move, Enter/Tab run, Esc closes. */
  let slashItems = [], slashSel = 0;
  let slashServerCommands = null, slashCatalogLoading = null, slashCatalogLoaded = null;
  /* ---------- /goal AUTONOMOUS LOOP (StarNet's "Ralph loop") ----------
     The loop STATE (goal / status / turnsUsed / subgoals / …) rides on the workstream record as ws.goalLoop, so a
     standing goal survives a reload/switch exactly like the thread history (workstreams.js carries the field through
     serialize()). GoalLoop (goalloop.js) owns the PURE parse + state machine; here we own the aux JUDGE model call
     (the same internal:true Harness.chat path goalstore/pitchstore use), queueing the continuation into the existing
     type-ahead queue, and honoring the one-beat discipline. `goalJudging` guards against a second judge round-trip
     racing the first for one stream. */
  const goalJudging = new Set();       // wsIds with a judge round-trip in flight (one at a time per stream)
  function goalOf(ws) {                 // the live loop state for a stream (re-normalized from its persisted row)
    if (!ws) return null;
    if (ws.goalLoop && typeof GoalLoop !== 'undefined') { const n = GoalLoop.normalize(ws.goalLoop); ws.goalLoop = n || undefined; return ws.goalLoop || null; }
    return null;
  }
  function persistGoal() { if (onTurn) onTurn(); }   // the loop state is part of the ws record → App.persist writes it
  const FALLBACK_SLASH_COMMANDS = Object.freeze([
    Object.freeze({ name: 'retry', desc: 're-run the last turn', action: 'retry' }),
    Object.freeze({ name: 'stop', desc: 'interrupt the running turn', action: 'stop' }),
    Object.freeze({ name: 'copy', desc: "copy the agent's last reply", action: 'copy' }),
    Object.freeze({ name: 'help', desc: 'list available commands', action: 'help' }),
    Object.freeze({ name: 'new', aliases: ['reset'], desc: 'start a fresh workstream', argsHint: '[title]', action: 'new' }),
    Object.freeze({ name: 'clear', aliases: ['cls'], desc: 'clear COMMS and start a fresh workstream', argsHint: '[title]', action: 'clear' }),
    Object.freeze({ name: 'history', aliases: ['hist'], desc: 'show recent turns of this workstream', argsHint: '[n]', action: 'history' }),
    Object.freeze({ name: 'whoami', desc: 'show the current agent identity', action: 'whoami' }),
    Object.freeze({ name: 'insights', desc: 'usage rollup from the run history', action: 'insights' }),
    Object.freeze({ name: 'branch', aliases: ['fork'], desc: 'fork this conversation into a new workstream', argsHint: '[title]', action: 'branch' }),
    Object.freeze({ name: 'status', desc: 'show current stream and run state', action: 'status' }),
    // no local action by design — the sidecar owns the spend ledger (dispatch:'server')
    Object.freeze({ name: 'usage', desc: 'show real spend from the station ledger', action: 'usage' }),
    Object.freeze({ name: 'queue', aliases: ['q'], desc: 'show or add queued follow-up text', argsHint: '[message]', action: 'queue' }),
    Object.freeze({ name: 'steer', desc: 'steer the running turn (nothing to steer when idle)', argsHint: '<guidance>', action: 'steer' }),
    Object.freeze({ name: 'undo', desc: 'remove the last local exchange', action: 'undo' }),
    Object.freeze({ name: 'compress', desc: 'show context compaction status', action: 'compress' }),
    Object.freeze({ name: 'title', desc: 'show or rename the current workstream', argsHint: '[name]', action: 'title' }),
    Object.freeze({ name: 'resume', aliases: ['sessions', 'switch'], desc: 'list or switch workstreams', argsHint: '[name|number]', action: 'resume' }),
    Object.freeze({ name: 'save', desc: 'save the current station state', action: 'save' }),
    Object.freeze({ name: 'agents', aliases: ['tasks'], desc: 'show active agents and running streams', action: 'agents' }),
    Object.freeze({ name: 'background', aliases: ['bg', 'btw'], desc: 'run a prompt in a new background workstream', argsHint: '<prompt>', action: 'background' }),
    // /away and /routine are dispatch:'server' commands — the sidecar executes them and returns the text. They
    // are listed here so the palette knows them before the catalog fetch lands; with no sidecar they honestly
    // refuse (runSlash) rather than silently doing nothing.
    Object.freeze({ name: 'away', aliases: ['build-away', 'buildaway'], desc: 'queue work for this agent to build on its own away shift', argsHint: '[<what to build> | list | on | off | now]', action: 'away' }),
    Object.freeze({ name: 'routine', aliases: ['routines'], desc: 'list, create, preview, pause or delete a scheduled routine', argsHint: '[list | add <schedule> | <task> | preview <schedule> | pause N | resume N | rm N]', action: 'routine' }),
    Object.freeze({ name: 'loop', desc: 'repeat a prompt on an interval in this workstream', argsHint: '<interval> <prompt> | status | off', action: 'loop' }),
    Object.freeze({ name: 'goal', desc: 'set an autonomous standing goal (status/pause/resume/clear)', argsHint: '[text|status|pause|resume|clear]', action: 'goal' }),
    Object.freeze({ name: 'subgoal', desc: 'add a criterion the goal loop must also satisfy', argsHint: '[text|remove N|clear]', action: 'subgoal' }),
    Object.freeze({ name: 'model', desc: 'show or set the active model', argsHint: '[model-id]', action: 'model' }),
    Object.freeze({ name: 'personality', desc: 'show or set the active personality', argsHint: '[personality]', action: 'personality' }),
    Object.freeze({ name: 'yolo', desc: 'toggle full-access approval mode', argsHint: '[on|off]', action: 'yolo' }),
    Object.freeze({ name: 'reasoning', desc: 'show or set how hard the model thinks before answering', argsHint: '[none|minimal|low|medium|high|xhigh]', action: 'reasoning' }),
    Object.freeze({ name: 'fast', desc: 'drop reasoning effort to minimal for quicker, cheaper replies', action: 'fast' }),
    Object.freeze({ name: 'voice', desc: 'show or toggle spoken replies', argsHint: '[on|off|handsfree|status]', action: 'voice' }),
    // no local action by design — the sidecar owns CAP_REGISTRY + the toolset switches (dispatch:'server')
    Object.freeze({ name: 'tools', desc: 'show the tools this agent can actually call', action: 'tools' }),
    Object.freeze({ name: 'skills', desc: 'show installed skill recipes', action: 'skills' }),
    Object.freeze({ name: 'memory', desc: 'show the active agent memory records', argsHint: '[query]', action: 'memory' }),
    Object.freeze({ name: 'bundles', desc: 'list recipe and skill slash bundles', action: 'bundles' }),
    Object.freeze({ name: 'cron', desc: 'show or arm scheduled routines', argsHint: '[on|off|status]', action: 'cron' }),
    Object.freeze({ name: 'suggestions', aliases: ['suggest'], desc: 'review recurring-task recipe suggestions', argsHint: '[accept N|dismiss N|clear]', action: 'suggestions' }),
    Object.freeze({ name: 'blueprint', aliases: ['bp'], desc: 'load a recipe blueprint into the composer', argsHint: '[recipe]', action: 'blueprint' }),
    Object.freeze({ name: 'reload-mcp', aliases: ['reload_mcp'], desc: 'refresh configured MCP connectors', argsHint: '[connector-id]', action: 'reload-mcp' }),
    Object.freeze({ name: 'reload-skills', aliases: ['reload_skills'], desc: 'refresh the slash skill catalog', action: 'reload-skills' }),
    Object.freeze({ name: 'debug', desc: 'show chat and slash debug state', action: 'debug' }),
    Object.freeze({ name: 'version', aliases: ['v'], desc: 'show StarNet version information', action: 'version' })
  ]);
  function isSlashOpen() { const p = el('chat-slash'); return !!(p && !p.hidden); }
  function copyLastReply() {
    if (!activeWs) return;
    const h = activeWs.history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'assistant' && !h[i].error && (h[i].content || '').trim()) {
        copyText(h[i].content).then(ok => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(ok ? 'copied the last reply' : 'copy failed', ok ? 'good' : 'warn', undefined, { transient: true }); });
        return;
      }
    }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('no reply to copy yet', '', undefined, { transient: true });
  }
  function refreshWorkflowViews() {
    try { if (typeof App !== 'undefined' && App.refreshUsage) App.refreshUsage(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
  }
  function streamLabel(w) { return (w && (w.title || (w.id === (typeof Workstreams !== 'undefined' && Workstreams.generalId && Workstreams.generalId()) ? 'General' : 'Untitled'))) || 'current stream'; }
  function workstreamList() {
    try { return (typeof Workstreams !== 'undefined' && Workstreams.list) ? Workstreams.list() : []; } catch (_) { return []; }
  }
  function findWorkstreamRef(args) {
    const raw = String(args || '').trim();
    const list = workstreamList();
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
    const q = raw.toLowerCase();
    return list.find(w => String(w.id || '').toLowerCase() === q)
      || list.find(w => String(streamLabel(w)).toLowerCase() === q)
      || list.find(w => String(streamLabel(w)).toLowerCase().indexOf(q) >= 0)
      || null;
  }
  function summarizeStreams() {
    const list = workstreamList();
    if (!list.length) return 'No saved workstreams.';
    const bits = list.slice(0, 8).map((w, i) => {
      const busy = (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(w.id)) ? '*' : '';
      const here = activeWs && w.id === activeWs.id ? '>' : '';
      const turns = (w.history && w.history.length) || 0;
      return here + (i + 1) + '. ' + streamLabel(w) + busy + ' (' + turns + ')';
    });
    return 'Workstreams: ' + bits.join(' | ') + (list.length > 8 ? ' | +' + (list.length - 8) + ' more' : '') + '. Use /resume <number|title>.';
  }
  function titleCommand(args) {
    if (!activeWs || typeof Workstreams === 'undefined' || !Workstreams.rename) return localLine('No active workstream to rename.');
    const title = String(args || '').trim();
    if (!title) return localLine('Title: ' + streamLabel(activeWs) + '. Use /title <name> to rename this workstream.');
    Workstreams.rename(activeWs.id, title);
    refreshWorkflowViews();
    localLine('Renamed this workstream to ' + streamLabel(activeWs) + '.');
  }
  function resumeCommand(args) {
    if (typeof Workstreams === 'undefined' || !Workstreams.switch) return localLine('Workstreams are not available yet.');
    const target = findWorkstreamRef(args);
    if (!String(args || '').trim()) return localLine(summarizeStreams());
    if (!target) return localLine('No workstream matched "' + String(args || '').trim() + '". ' + summarizeStreams());
    const ws = Workstreams.switch(target.id);
    if (!ws) return localLine('Could not switch workstreams.');
    load(ws); refreshWorkflowViews();
    localLine('Resumed ' + streamLabel(ws) + '.');
  }
  function saveCommand() {
    try { if (typeof App !== 'undefined' && App.persist) { App.persist(); localLine('Saved the current station state.'); return; } } catch (_) {}
    localLine('Save is not available yet.');
  }
  function appAgents() {
    try {
      if (typeof App !== 'undefined' && App.agents) return App.agents() || [];
      const a = activeAgent();
      return a ? [a] : [];
    } catch (_) { return []; }
  }
  function agentsCommand() {
    const agents = appAgents();
    const streams = workstreamList();
    const busy = streams.filter(w => typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(w.id));
    const names = agents.map(a => (a.name || a.id || 'agent') + ((a.id && a.id !== 'agent') ? ' [' + a.id + ']' : '')).slice(0, 6);
    localLine('Agents: ' + (names.length ? names.join(', ') : 'none loaded') + '. Streams: ' + streams.length + '; running: '
      + (busy.length ? busy.map(streamLabel).join(', ') : 'none') + '.');
  }
  function backgroundCommand(args) {
    const text = String(args || '').trim();
    if (!text) return localLine('Usage: /background <prompt>');
    if (typeof Workstreams === 'undefined' || !Workstreams.create) return localLine('Workstreams are not available yet.');
    const prev = activeWs;
    const title = Workstreams.deriveTitle ? (Workstreams.deriveTitle(text) || 'Background task') : 'Background task';
    const ws = Workstreams.create(title, { agentId: (activeWs && activeWs.agentId) || 'agent', kind: 'task' });   // /background is a directive → a board task
    load(ws);
    send(text);
    if (prev && Workstreams.switch) {
      const back = Workstreams.switch(prev.id);
      if (back) load(back);
    }
    refreshWorkflowViews();
    localLine('Started background workstream: ' + streamLabel(ws) + '.');
  }
  // /goal <text>            — set + kick off an autonomous loop toward <text> on this stream
  // /goal (or /goal status)  — show the loop status
  // /goal pause|resume|clear — control it
  function goalCommand(args) {
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    if (typeof GoalLoop === 'undefined') return localLine('The goal loop is not available in this build.');
    if (!activeWs) return localLine('Open a workstream first.');
    const cur = goalOf(activeWs);
    if (!raw || low === 'status') return localLine(GoalLoop.statusLine(cur));
    if (low === 'pause') {
      if (!cur || cur.status === 'cleared') return localLine('No goal loop to pause.');
      GoalLoop.pause(cur, 'you paused it'); persistGoal();
      return localLine('⏸ goal loop paused. /goal resume to continue.');
    }
    if (low === 'resume') {
      if (!cur || cur.status !== 'paused') return localLine('No paused goal loop to resume.');
      GoalLoop.resume(cur); persistGoal();
      localLine('▶ goal loop resumed (' + cur.turnsUsed + '/' + cur.maxTurns + '). Kicking off the next step…');
      return kickGoal(activeWs);   // resume immediately fires the next continuation if the stream is free
    }
    if (low === 'clear') {
      if (!cur || cur.status === 'cleared') return localLine('No goal loop to clear.');
      GoalLoop.clear(cur); activeWs.goalLoop = undefined; persistGoal();
      return localLine('Cleared the goal loop.');
    }
    // /goal <text> — set (or replace) the standing goal and start working toward it
    const s = GoalLoop.create(raw, { now: Date.now() });
    if (!s) return localLine('Usage: /goal <what you want done>');
    activeWs.goalLoop = s; persistGoal();
    localLine('⊙ goal loop set: ' + s.goal + '  (budget ' + s.maxTurns + ' turns). Working toward it…');
    kickGoal(activeWs);
  }
  // /subgoal <text>          — append a criterion the loop must ALSO satisfy before it's done
  // /subgoal (bare)          — list the criteria; /subgoal clear wipes them
  function subgoalCommand(args) {
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    if (typeof GoalLoop === 'undefined') return localLine('The goal loop is not available in this build.');
    const cur = activeWs && goalOf(activeWs);
    if (!raw) {
      const subs = (cur && cur.subgoals) || [];
      return localLine(subs.length ? ('Subgoals: ' + subs.map((t, i) => (i + 1) + '. ' + t).join(' | ')) : 'No subgoals set. Use /subgoal <text> once a goal loop is running.');
    }
    if (!cur || !GoalLoop.hasGoal(cur)) return localLine('Set a goal first with /goal <text>, then add criteria with /subgoal.');
    if (low === 'clear') { cur.subgoals = []; persistGoal(); return localLine('Cleared subgoals.'); }
    const rm = /^remove\s+(\d+)$/i.exec(raw);
    if (rm) {
      const i = Number(rm[1]) - 1;
      if (i >= 0 && i < cur.subgoals.length) { const old = cur.subgoals.splice(i, 1)[0]; persistGoal(); return localLine('Removed subgoal: ' + old); }
      return localLine('No subgoal #' + rm[1] + '.');
    }
    const added = GoalLoop.addSubgoal(cur, raw); persistGoal();
    localLine(added ? ('Added subgoal #' + cur.subgoals.length + '. The loop will now require: ' + added) : 'Could not add that subgoal.');
  }

  /* THE GOAL LOOP ENGINE.
     goalBlocked() — never drive a continuation while a beat / consent card is pending approval (the one-beat
     discipline) or while an interview owns the input; the continuation waits for a free moment (it re-fires from
     the next send() teardown, or from /goal resume). A pending permission approval on THIS stream also blocks —
     the human must decide the tool call before we pile on the next turn. */
  function goalBlocked(ws) {
    if (interview) return true;
    if (activeTurnin || activeNudge || studyBusy() || threadBusy()) return true;   // a visible review/beat is up
    if (taskQuestionLive()) return true;   // an unanswered task question is up — the human decides it before the loop piles on
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    if (ws && typeof Channels !== 'undefined' && Channels.pendingOf && Channels.pendingOf(ws.id)) return true;   // a tool approval is pending
    return false;
  }
  // kick the loop forward on `ws`: if the stream is free + unblocked and the loop is active, send the next
  // continuation as a real turn (routed through send(), so it walks the desk / bills / streams like any turn).
  // Called after a set/resume and after each judged turn. Idempotent + safe when there's no active loop.
  const goalRetry = new Set();   // wsIds with a blocked-moment retry armed (one pending re-check per stream, never stacked)
  function kickGoal(ws) {
    const s = goalOf(ws);
    if (!s || !GoalLoop.isActive(s)) return;
    if (!isActiveWs(ws)) return;                 // the continuation drives the DISPLAYED stream (send()'s DOM writes)
    if (isBusy()) return;                        // a run is already in flight — the teardown judge re-drives the loop
    if (goalBlocked(ws)) {
      // a beat/consent card owns the moment — "deferred" must not become "stalled": re-check on a slow cadence
      // (one armed retry per stream; gives up silently when the loop is paused/cleared meanwhile).
      if (!goalRetry.has(ws.id)) { goalRetry.add(ws.id); setTimeout(() => { goalRetry.delete(ws.id); kickGoal(ws); }, 7000); }
      return;
    }
    const prompt = GoalLoop.continuationPrompt(s);
    if (!prompt) return;
    send(prompt, { goalContinuation: true });    // flag it so send() knows this turn IS the loop (not a user preempt)
  }
  // after a turn on `ws` completes, judge it against the standing goal and decide whether to fire another turn.
  // `wasContinuation` = this turn WAS a loop-driven continuation (vs a real user message). A real user message
  // PREEMPTS: it pauses the loop for this turn (their message wins) — we don't judge, we don't queue. reply is the
  // agent's last assistant text (what the judge evaluates).
  async function judgeGoalTurn(ws, reply, wasContinuation) {
    const s = goalOf(ws);
    if (!s || !GoalLoop.isActive(s)) return;
    // a REAL user message mid-loop preempts: pause, judge nothing, queue nothing (they took over). Checked BEFORE
    // the goalJudging guard: even while a judge round-trip is in flight the pause must land — the in-flight judge
    // re-reads the state after its await and sees the loop inactive, so it can never fire over the human's head.
    if (!wasContinuation) {
      const d = GoalLoop.evaluate(s, null, { preempt: true }); persistGoal();
      if (d.message && isActiveWs(ws)) localLine(d.message);
      return;
    }
    if (goalJudging.has(ws.id)) return;          // a judge is already deciding this stream — don't double-fire
    // a continuation turn that produced NO clean reply (errored / stopped mid-thought) is not judgeable — leave the
    // loop as-is (it advances no turn); a later free moment or /goal resume continues it. Don't claim done on nothing.
    if (!reply || !String(reply).trim()) return;
    goalJudging.add(ws.id);
    let judged;
    try {
      // the aux JUDGE call — reason-only, internal (no floor/telemetry/tool reach), same path pitchstore/goalstore
      // use. Fail-open: any error → a CONTINUE parse-failure verdict (the state machine's budget + parse-fail guard
      // are the backstops; a broken judge must never wedge or falsely claim done).
      let raw = '';
      try {
        const sys = GoalLoop.judgeSystem();
        const usr = GoalLoop.judgeUser(s, reply, { now: new Date().toISOString() });
        const res = await Harness.chat({ system: sys, messages: [{ role: 'user', content: usr }], agentId: ws.agentId || 'agent', isTask: false, placed: [], internal: true });
        raw = (res && !res.error) ? (res.text || '') : '';
      } catch (_) { raw = ''; }
      judged = GoalLoop.parseVerdict(raw);
    } finally {
      goalJudging.delete(ws.id);
    }
    // re-read state: a /goal pause|clear or a user message may have landed during the async judge round-trip.
    const s2 = goalOf(ws);
    if (!s2 || !GoalLoop.isActive(s2)) return;
    const d = GoalLoop.evaluate(s2, judged, { now: Date.now() });
    persistGoal();
    if (d.message && isActiveWs(ws)) localLine(d.message);
    if (d.shouldContinue) kickGoal(ws);          // fire the next continuation (guards for busy/blocked inside)
  }
  function newWorkstreamCommand(args) {
    if (typeof Workstreams === 'undefined' || !Workstreams.create) return localLine('Workstreams are not available yet.');
    const title = String(args || '').trim() || null;
    const ws = Workstreams.create(title, { agentId: (activeWs && activeWs.agentId) || 'agent' });
    load(ws); refreshWorkflowViews();
    localLine('Started a fresh workstream' + (title ? ': ' + title : '.') );
  }
  function branchWorkstreamCommand(args) {
    if (!activeWs || typeof Workstreams === 'undefined' || !Workstreams.create) return localLine('No active workstream to branch.');
    const src = activeWs;
    const title = String(args || '').trim() || ((src.title || 'General') + ' branch');
    const ws = Workstreams.create(title, { agentId: src.agentId || 'agent', kind: src.kind === 'task' ? 'task' : 'chat' });   // a branch inherits the SOURCE stream's kind
    ws.history = (src.history || []).map(m => Object.assign({}, m));
    ws.lane = 'todo';
    load(ws); refreshWorkflowViews();
    localLine('Branched from ' + streamLabel(src) + '.');
  }
  function statusCommand() {
    const q = (activeWs && queued.get(activeWs.id)) || [];
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '';
    const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : '';
    const state = isBusy() ? 'working' : 'idle';
    const turns = activeWs && activeWs.history ? activeWs.history.length : 0;
    const g = (typeof GoalLoop !== 'undefined') ? goalOf(activeWs) : null;
    localLine('Status: ' + state + ' on ' + streamLabel(activeWs) + ' (' + turns + ' turn' + (turns === 1 ? '' : 's') + ', ' + q.length + ' queued)'
      + (model ? '; model ' + model + (provider ? ' via ' + provider : '') : '') + '.'
      + (g && g.status !== 'cleared' ? (' ' + GoalLoop.statusLine(g)) : ''));
  }
  // NOTE: /usage moved to the sidecar (dispatch:'server'). It read Harness.totals(), which only accumulates runs
  // THIS BROWSER watched — every routine, away shift, night-shift beat and Telegram run spends real money and
  // never touched it, so the figure it labelled "lifetime" structurally under-reported and disagreed with the
  // ledger the budget caps enforce against. The ledger is the authority; see sidecar/slash-actions.js.
  function queueCommand(args) {
    if (!activeWs) return localLine('No active workstream.');
    const text = String(args || '').trim();
    if (text) {
      if (isBusy()) { enqueue(text); localLine('Queued one follow-up for this stream.'); }
      else send(text);
      return;
    }
    const arr = queued.get(activeWs.id) || [];
    localLine(arr.length ? ('Queue: ' + arr.length + ' pending - ' + arr.map((t, i) => (i + 1) + '. ' + String(t).slice(0, 80)).join(' | ')) : 'Queue is empty for this stream.');
  }
  /* ---- /loop — an in-session interval WATCHER.
     Deliberately a THIRD shape, not a duplicate of the two that already exist:
       /goal    — judge-driven; keeps going until an objective is judged met (goalloop.js).
       /routine — persisted + cron-scheduled; runs headless and survives a restart.
       /loop    — the same prompt, on a clock, in THIS workstream, visible in COMMS: "keep checking X".
     It lives in memory ONLY and dies with the tab. That is a feature, and the status line says so out loud —
     a loop that silently resurrected after a restart would spend real money nobody asked for. Every tick is a
     real model turn, so it carries a hard iteration budget and refuses sub-minute cadence. */
  const LOOP_MIN_MS = 60 * 1000;        // one real model turn per tick — sub-minute cadence is a spend trap
  const LOOP_MAX_ITERS = 20;            // budget backstop; re-issue /loop to extend deliberately
  const LOOP_MAX_SKIPS = 20;            // a loop that can never fire must not re-arm forever (see loopTick)
  const loops = new Map();              // wsId -> { ms, label, prompt, fired, skipped, skipStreak, timer, startedAt }
  const loopEnded = new Map();          // wsId -> one-shot explanation for a loop that died while you were away

  function loopParseInterval(tok) {
    const m = String(tok || '').trim().toLowerCase().match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!(n > 0)) return null;
    const u = (m[2] || 'm')[0];
    return n * (u === 's' ? 1000 : u === 'h' ? 3600000 : 60000);
  }
  function loopLabel(ms) {
    if (ms % 3600000 === 0) return (ms / 3600000) + 'h';
    if (ms % 60000 === 0) return (ms / 60000) + 'm';
    return Math.round(ms / 1000) + 's';
  }
  // why  = printed NOW into the live transcript (only safe when the loop's own stream is focused).
  // note = remembered instead, so a loop that had to die while you were elsewhere can still explain itself the
  //        next time you ask /loop status. A watcher that vanishes with no account of itself is the failure
  //        mode here: the user armed it and would otherwise never learn it stopped.
  function loopStop(wsId, why, note) {
    const rec = loops.get(wsId);
    if (!rec) return false;
    try { clearTimeout(rec.timer); } catch (_) {}
    loops.delete(wsId);
    const ran = ' (ran ' + rec.fired + ' time' + (rec.fired === 1 ? '' : 's') + ')';
    if (why) localLine('Loop stopped — ' + why + ran + '.');
    else if (note) {
      loopEnded.set(wsId, 'Your loop stopped — ' + note + ran + '.');
      if (loopEnded.size > 20) loopEnded.delete(loopEnded.keys().next().value);   // bounded: this is a courtesy note, not a log
    }
    return true;
  }
  function loopArm(rec) {
    try { clearTimeout(rec.timer); } catch (_) {}
    rec.timer = setTimeout(() => loopTick(rec), rec.ms);
  }
  function loopTick(rec) {
    if (!loops.has(rec.wsId)) return;                                  // stopped while we were waiting
    // The stream this loop belongs to is GONE (deleted with the workstream, or with its agent) — there is
    // nothing left to watch, and re-arming would leave a timer running for the life of the tab that /loop off
    // can never reach (it keys off the ACTIVE stream). End it, and leave a note for /loop status.
    const alive = (typeof Workstreams !== 'undefined' && Workstreams.get) ? !!Workstreams.get(rec.wsId) : true;
    if (!alive) return void loopStop(rec.wsId, null, 'its workstream was deleted');
    const focused = !!activeWs && activeWs.id === rec.wsId;
    // BUDGET: checked only while focused, because loopStop's line goes to the ONE live transcript element —
    // announcing "your loop hit its budget" into whatever stream you happen to be reading blames an unrelated
    // conversation. Unfocused, it waits and announces when you come back.
    if (rec.fired >= LOOP_MAX_ITERS) {
      if (focused) return void loopStop(rec.wsId, 'it hit its ' + LOOP_MAX_ITERS + '-run budget');
      return void loopArm(rec);
    }
    // Fire ONLY into the stream this loop belongs to: send() targets the ACTIVE workstream, so a tick while the
    // user reads another stream would inject the prompt into the wrong conversation.
    // goalBlocked() is the SAME discipline the goal loop obeys: an interview, a live beat, an unanswered task
    // question, an open dialogue or a pending tool approval all own the input. Without it, send() routes the
    // tick's text into interview(text)/TaskIntent.routeReply — the loop would answer the station's own question
    // with "check the build" and count it as a run.
    if (!focused || isBusy() || goalBlocked(activeWs)) {
      rec.skipped++;
      // Only an UNFOCUSED tick counts toward the death streak. Being busy or mid-approval is a legitimate,
      // self-clearing wait — killing a watcher because one long run overlapped it would be a surprise.
      if (!focused) {
        rec.skipStreak++;
        if (rec.skipStreak >= LOOP_MAX_SKIPS) return void loopStop(rec.wsId, null, 'it went ' + LOOP_MAX_SKIPS + ' turns without its workstream being open');
      }
      return void loopArm(rec);
    }
    rec.fired++; rec.skipStreak = 0;
    loopArm(rec);
    send(rec.prompt);
  }
  function loopCommand(args) {
    if (!activeWs) return localLine('No active workstream to loop in.');
    const raw = String(args || '').trim();
    const wsId = activeWs.id;
    const cur = loops.get(wsId);
    const low = raw.toLowerCase();

    if (low === 'off' || low === 'stop' || low === 'clear') {
      if (!loopStop(wsId, 'you stopped it')) localLine('No loop is running in this workstream.');
      return;
    }
    if (!raw || low === 'status') {
      if (!cur) {
        // if this stream's loop died while the user was elsewhere, account for it once, then forget it
        const ended = loopEnded.get(wsId);
        if (ended) { loopEnded.delete(wsId); return localLine(ended + ' /loop <interval> <prompt> to start another.'); }
        return localLine('No loop in this workstream. /loop <interval> <prompt> — e.g. /loop 5m check whether the build went green.');
      }
      return localLine('Loop: every ' + cur.label + ', ' + cur.fired + '/' + LOOP_MAX_ITERS + ' runs done'
        + (cur.skipped ? ', ' + cur.skipped + ' tick' + (cur.skipped === 1 ? '' : 's') + ' skipped (a run, a question or another stream had the floor)' : '')
        + ' — "' + String(cur.prompt).slice(0, 60) + '". It stops if you close StarNet; /routine makes it permanent.');
    }

    const sp = raw.search(/\s/);
    const ms = sp === -1 ? null : loopParseInterval(raw.slice(0, sp));
    const prompt = sp === -1 ? '' : raw.slice(sp + 1).trim();
    if (ms == null || !prompt) {
      return localLine('Usage: /loop <interval> <prompt> — e.g. /loop 5m check whether the deploy went green. '
        + 'Also: /loop status, /loop off.');
    }
    if (ms < LOOP_MIN_MS) return localLine('Minimum loop interval is 1 minute — every run costs a real model turn.');
    if (cur) loopStop(wsId, null);                                     // replace, don't stack two loops on one stream
    const rec = { wsId: wsId, ms: ms, label: loopLabel(ms), prompt: prompt, fired: 0, skipped: 0, skipStreak: 0, timer: null, startedAt: Date.now() };
    loops.set(wsId, rec);
    loopArm(rec);
    localLine('Looping every ' + rec.label + ' (up to ' + LOOP_MAX_ITERS + ' runs): "' + prompt.slice(0, 60) + '". '
      + 'First run in ' + rec.label + '. Each run costs a real model turn — /loop off to stop, /stop also ends it.');
  }
  function steerCommand(args) {
    if (!activeWs) return localLine('No active workstream.');
    const text = String(args || '').trim();
    if (!text) return localLine('Usage: /steer <guidance>');
    const note = 'Steering note for the current task: ' + text;
    if (isBusy()) {
      // LIVE MID-RUN STEERING: if the running turn has a known runId, POST it to the sidecar's per-run steer
      // buffer; the loop folds it in before its NEXT model call (after the current tool result). Fall back to the
      // queue only when there is no live runId (e.g. a run whose id we never captured) or the POST fails — so a
      // steer is NEVER silently dropped and NEVER injected into a run we can't address.
      const rid = (typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(activeWs.id) : null;
      if (rid && typeof fetch !== 'undefined') {
        fetch('/api/run/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: rid, text: text }) })
          .then(r => r.ok ? r.json().catch(() => null) : null)
          .then(j => {
            if (j && j.ok) localLine('Steering the live run — it will fold your note in on its next step.');
            else steerQueueFallback(note);   // run already ended / buffer full → queue it
          })
          .catch(() => steerQueueFallback(note));
        return;
      }
      return steerQueueFallback(note);
    }
    // F3 (2026-07-14 adversarial sweep): with NOTHING running there is nothing to steer — refuse honestly.
    // The old fallthrough send(note) silently minted a FULL model run out of a steering note (real-provider
    // spend for a no-op; the sidecar's own /api/run/steer honestly 404s in this state and was never asked).
    localLine('Nothing is running to steer. Start a task first, or /queue <text> to stage it for the next run.');
  }
  function steerQueueFallback(note) {
    if (!activeWs) return;
    const arr = queued.get(activeWs.id) || [];
    arr.unshift(note); queued.set(activeWs.id, arr); renderQueued();
    localLine('Steering note queued to run next.');
  }
  function undoCommand() {
    if (!activeWs) return localLine('No active workstream.');
    if (isBusy()) return localLine('Stop the running turn before undoing history.');
    const h = activeWs.history || [];
    if (!h.length) return localLine('Nothing to undo.');
    let removed = 0;
    if (h[h.length - 1] && h[h.length - 1].role === 'assistant') { h.pop(); removed++; }
    if (h[h.length - 1] && h[h.length - 1].role === 'user') { h.pop(); removed++; }
    if (!removed && h.length) { h.pop(); removed++; }
    load(activeWs); refreshWorkflowViews();
    localLine('Undid ' + removed + ' message' + (removed === 1 ? '' : 's') + '.');
  }
  function compressCommand() {
    const ref = contextRef();
    const cs = (typeof Harness !== 'undefined' && Harness.contextState)
      ? Harness.contextState(ref ? ref.agentId : ((activeWs && activeWs.agentId) || 'agent'), ref && ref.streamId, ref && ref.messages)
      : null;
    // The run host is STATELESS — the conversation lives in the browser and is sent per call — so there is no
    // persistent server-side context to fold on demand between runs. Auto-compaction runs INSIDE a run when the
    // live prompt crosses the threshold. This is the honest status; see the slash-parity report for the rationale.
    if (cs && cs.limit) {
      const pct = Math.round(((cs.used || 0) / cs.limit) * 100);
      localLine('Chat memory: ' + (cs.used || 0) + ' / ' + cs.limit + ' tokens used (' + pct + '% — a token is roughly ¾ of a word). When it nears full, older turns are folded into a summary automatically during the next run; there is nothing you need to do.');
    } else {
      localLine('Chat memory is managed automatically: when a conversation grows past what the model can hold, older turns are folded into a summary during the next run. There is nothing you need to do.');
    }
  }
  // /clear — wipe the rendered COMMS panel and start a fresh workstream. Shares newWorkstreamCommand's create+load
  // (which itself clears the log via load()), so it can NEVER touch another stream's in-flight run: it only ever
  // spins up a brand-new stream and rebinds the panel to it. Purely additive over /new (aliased for parity with the reference harness).
  function clearCommand(args) {
    newWorkstreamCommand(args);
    if (log) log.innerHTML = '';   // belt-and-suspenders: guarantee a clean panel even if load() left an empty-state hint
    localLine('Cleared COMMS and started a fresh workstream.');
  }
  // /history [n] — print the last n turns (default 10) of the ACTIVE workstream from ws.history, role-prefixed and
  // truncated. Read-only; never mutates history or touches any run.
  function historyCommand(args) {
    if (!activeWs) return localLine('No active workstream.');
    const h = (activeWs.history || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim());
    if (!h.length) return localLine('No conversation history in this workstream yet.');
    let n = parseInt(String(args || '').trim(), 10);
    if (!Number.isInteger(n) || n <= 0) n = 10;
    n = Math.min(n, 30);
    const slice = h.slice(-n);
    // ONE collapsed card instead of up to 31 flooding rows — click to expand the turns.
    const lines = slice.map(m => (m.role === 'user' ? 'You' : 'Agent') + ': ' + String(m.content).replace(/\s+/g, ' ').slice(0, 160));
    systemCard('History — last ' + slice.length + ' of ' + h.length + ' turn' + (h.length === 1 ? '' : 's') + ' (click to expand)', lines);
  }
  // /whoami — the current agent identity: id/name, role/class, level + XP (Xp.compute), model + provider, and the
  // capabilities placed on the floor (slashPlacedTypes). Read-only.
  function whoamiCommand() {
    const a = activeAgent() || {};
    const id = (activeWs && activeWs.agentId) || a.id || 'agent';
    const name = a.name || id;
    const spec = (a.specialtyId && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(a.specialtyId) : null;
    const klass = (spec && (spec.name || spec.id)) || a.role || (id === 'agent' ? 'orchestrator' : 'specialist');
    let lvl = '';
    try { if (typeof Xp !== 'undefined' && Xp.compute && a.stats) { const g = Xp.compute(a.stats); lvl = ', Lv ' + g.level + ' (' + (g.xp != null ? g.xp + ' XP, ' : '') + g.pct + '% to Lv ' + (g.level + 1) + ')'; } } catch (_) {}
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : (a.model || '');
    const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : (a.provider || '');
    const placed = slashPlacedTypes();
    localLine('You are ' + name + ' [' + id + '] — ' + klass + lvl + '. Model: ' + (model || 'not selected') + (provider ? ' via ' + provider : '')
      + '. Placed capabilities: ' + (placed.length ? placed.join(', ') : 'none on the floor yet') + '.');
  }
  // /insights — a usage rollup from the DURABLE run history (GET /api/insights): total runs, spend, tokens,
  // success rate, and top models. This is the persisted lifetime ledger for this agent — honestly labelled as such
  // (the run store keeps every run, so it is not windowed to 30 days). A per-session fallback uses Harness.totals()
  // when the sidecar is offline, clearly marked session-only so no number is ever faked.
  async function insightsCommand() {
    const agentId = (activeWs && activeWs.agentId) || (activeAgent() && activeAgent().id) || 'agent';
    try {
      const r = await fetch('/api/insights?agent=' + encodeURIComponent(agentId), { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j && (j.totalRuns != null)) {
        const models = Array.isArray(j.byModel) ? j.byModel.slice(0, 3).map(m => (m.model || '?') + ' (' + U.usd(m.usd || 0) + ')') : [];
        const succ = (j.successPct == null) ? '' : ', ' + j.successPct + '% completed';
        return localLine('Insights (lifetime run history for ' + agentId + '): ' + (j.totalRuns || 0) + ' run' + (j.totalRuns === 1 ? '' : 's')
          + ', ' + U.usd(j.totalUsd || 0) + ', ' + (j.totalTokens || 0) + ' tokens'
          + (j.avgUsdPerRun ? ', ' + U.usd(j.avgUsdPerRun) + '/run' : '') + succ
          + (models.length ? '. Top models: ' + models.join(', ') : '') + '.');
      }
    } catch (_) {}
    // sidecar offline / no fold — honest session-only fallback, never fabricated.
    const t = (typeof Harness !== 'undefined' && Harness.totals) ? Harness.totals() : { tokens: 0, cost: 0, calls: 0 };
    localLine('Insights: the durable run history is unavailable (sidecar offline). This SESSION only: ' + (t.tokens || 0) + ' tokens, '
      + U.usd(t.cost || 0) + ', ' + (t.calls || 0) + ' calls.');
  }
  function activeAgent() {
    try { return (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null; } catch (_) { return null; }
  }
  function applyAgentPatch(patch) {
    try { if (typeof App !== 'undefined' && App.applyConfig) { App.applyConfig(patch); return true; } } catch (_) {}
    return false;
  }
  // F4 (adversarial sweep 2026-07-14): /model used to ack ANY id with a confident success line —
  // a garbage id then 404s every real-provider run while /whoami reports it as live. Warn-not-block
  // at the ack seam (sandbox law: the id stays set — custom endpoints can serve ids the catalog
  // doesn't know); an EMPTY catalog is honest uncertainty (offline / cold warm-up), never an alarm.
  function modelAckWarning(id, list) {
    const models = Array.isArray(list) ? list.filter(m => m && m.id) : [];
    if (!models.length) return '';
    if (models.some(m => m.id === id)) return '';
    return 'Warning: "' + id + '" is not in the current model catalog (' + models.length
      + ' known ids) — runs may fail with model-not-found. It stays set; /model <id> to change, /model to inspect.';
  }
  async function warnUnknownModel(id) {
    try {
      if (typeof Harness === 'undefined' || !Harness.listModels) return;
      const warn = modelAckWarning(id, await Harness.listModels());
      if (warn) localLine(warn);
    } catch (_) {}
  }
  function modelCommand(args) {
    const next = String(args || '').trim();
    if (next) {
      let set = false;
      if (applyAgentPatch({ model: next })) { localLine('Model set to ' + next + ' for future runs.'); set = true; }
      else if (typeof Harness !== 'undefined' && Harness.setModel) { Harness.setModel(next); localLine('Model set to ' + next + ' for this harness session.'); set = true; }
      else localLine('Model setting is not available yet.');
      if (set) warnUnknownModel(next);
      refreshWorkflowViews();
      return;
    }
    const a = activeAgent();
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : ((a && a.model) || '');
    const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : '';
    localLine('Model: ' + (model || 'not selected') + (provider ? ' via ' + provider : '') + '. Use /model <model-id> to switch.');
  }
  function personalityCommand(args) {
    const raw = String(args || '').trim();
    const key = raw.toLowerCase();
    if (key && typeof Personas !== 'undefined' && Personas.exists && Personas.exists(key)) {
      const id = Personas.resolve ? Personas.resolve(key) : key;
      if (applyAgentPatch({ personaId: id })) {
        // slash-set skips the create screen's two-press confirm, so the honesty note rides the confirmation line
        localLine('Personality set to ' + Personas.get(id).name + '.' + (id === 'unhinged' && Personas.effective(id, (activeAgent() || {}).voiceTraits).profanity > 0 ? ' Heads up: this one swears — for real.' : ''));
      }
      else localLine('Personality setting is not available yet.');
      return;
    }
    const list = (typeof Personas !== 'undefined' && Personas.list) ? Personas.list() : [];
    const currentId = (activeAgent() && activeAgent().personaId) || (typeof Voice !== 'undefined' && Voice.personaId ? Voice.personaId() : '');
    const current = (typeof Personas !== 'undefined' && Personas.get) ? Personas.get(currentId) : null;
    localLine((raw ? 'Unknown personality "' + raw + '". ' : '') + 'Personality: ' + ((current && current.name) || currentId || 'unknown')
      + (list.length ? '. Options: ' + list.map(p => p.id).join(', ') + '.' : '.'));
  }
  function yoloCommand(args) {
    const a = activeAgent();
    if (!a) return localLine('Approval mode is not available yet.');
    const raw = String(args || '').trim().toLowerCase();
    const was = a.approvalMode === 'full' ? 'run without prompts' : 'ask first';
    const want = raw ? /^(1|true|yes|on|full|yolo)$/i.test(raw) : a.approvalMode !== 'full';
    if (applyAgentPatch({ approvalMode: want ? 'full' : 'ask' })) {
      // State the TRANSITION, not just the resulting state. A bare /yolo TOGGLES, so the old wording
      // ("Approval mode: full access…") read like a status report when it had in fact just switched the
      // approval gate off — the one setting where mistaking a change for a readout actually matters.
      const now = want ? 'run without prompts' : 'ask first';
      localLine(was === now
        ? ('Approval mode unchanged: ' + now + '.')
        : ('Approval mode: ' + was + ' → ' + now + '. ' + (want
          ? 'The agent will NOT pause for approval prompts — /yolo off to restore them.'
          : 'The agent will pause before gated actions.')));
    } else localLine('Could not change approval mode.');
  }
  /* ---- reasoning effort — a REAL dial, not a status readout.
     The old handler answered "Reasoning effort is not a separate StarNet toggle yet", which was simply false:
     Harness stores it per PROVIDER, persists it, the model dock sets it alongside model+provider, and every run
     payload carries it (harness.js chat()). The command just never reached any of that. */
  const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  // normalizeReasoningEffort maps ANY unknown token to 'medium'. These are the inputs that legitimately mean
  // medium, so a typo can be told apart from a real request instead of silently applying a level nobody asked for.
  const MEDIUM_ALIASES = ['med', 'mid', 'medium'];
  function reasoningLevelOf(raw) {
    if (typeof Harness === 'undefined' || !Harness.normalizeReasoningEffort) return null;
    const n = Harness.normalizeReasoningEffort(raw);
    if (n === 'medium' && MEDIUM_ALIASES.indexOf(raw) === -1) return null;   // hit the silent default => unknown token
    return n;
  }
  // WARN-not-block (same precedent as /model against the warmed catalog): if the selected model has no reasoning
  // dial, setting one is a no-op — say so rather than letting the confirmation imply an effect it won't have.
  function reasoningModelNote() {
    try {
      if (typeof ModelDock === 'undefined' || !ModelDock._internals || !ModelDock._internals.supportsReasoning) return '';
      const model = (Harness.getModel && Harness.getModel()) || '';
      if (!model) return '';
      const ok = ModelDock._internals.supportsReasoning({ id: model, provider: (Harness.getProv && Harness.getProv()) || '' });
      return ok ? '' : ' Note: ' + model + " doesn't appear to expose a reasoning dial, so this may have no effect until you pick a model that does.";
    } catch (_) { return ''; }
  }
  function reasoningCommand(args) {
    if (typeof Harness === 'undefined' || !Harness.getReasoningEffort) return localLine('Reasoning controls are not available in this surface.');
    const raw = String(args || '').trim().toLowerCase();
    const prov = (Harness.getProv && Harness.getProv()) || '';
    const cur = Harness.getReasoningEffort(prov);
    if (!raw || raw === 'status') {
      return localLine('Reasoning effort: ' + cur + (prov ? ' (for ' + prov + ')' : '') + '. Set it with /reasoning '
        + REASONING_LEVELS.join('|') + ' — lower answers faster and cheaper, higher thinks longer first.' + reasoningModelNote());
    }
    const want = reasoningLevelOf(raw);
    if (!want) return localLine('"' + raw + '" is not a reasoning level. Pick one of: ' + REASONING_LEVELS.join(', ') + '.');
    if (want === cur) return localLine('Reasoning effort is already ' + cur + '.' + reasoningModelNote());
    if (typeof App === 'undefined' || !App.applyConfig) return localLine('Reasoning effort could not be changed on this surface.');
    App.applyConfig({ reasoningEffort: want });
    // READ BACK before claiming it: only the store's own answer proves the write landed (truthful telemetry).
    const now = Harness.getReasoningEffort((Harness.getProv && Harness.getProv()) || prov);
    if (now !== want) return localLine('Could not set reasoning effort to ' + want + ' — it is still ' + now + '.');
    localLine('Reasoning effort: ' + cur + ' → ' + want + (prov ? ' (for ' + prov + ')' : '')
      + '. Takes effect on your next message.' + reasoningModelNote());
  }
  /* ---- /fast — a shortcut onto that SAME dial.
     StarNet has no separate "fast mode", and inventing one would be a lie — the old handler admitted as much and
     then did nothing at all. Minimal reasoning effort IS what makes replies come back quickly and cheaply, so
     /fast drives the real control instead of pretending to be its own switch. */
  function fastCommand() {
    if (typeof Harness === 'undefined' || !Harness.getReasoningEffort) return localLine('Reasoning controls are not available in this surface.');
    const prov = (Harness.getProv && Harness.getProv()) || '';
    const cur = Harness.getReasoningEffort(prov);
    if (cur === 'minimal' || cur === 'none') {
      return localLine('Already as fast as it gets — reasoning effort is ' + cur + '. /reasoning medium to let it think longer.');
    }
    if (typeof App === 'undefined' || !App.applyConfig) return localLine('Reasoning effort could not be changed on this surface.');
    App.applyConfig({ reasoningEffort: 'minimal' });
    const now = Harness.getReasoningEffort((Harness.getProv && Harness.getProv()) || prov);
    if (now !== 'minimal') return localLine('Could not switch to minimal reasoning — effort is still ' + now + '.');
    localLine('Reasoning effort: ' + cur + ' → minimal — quicker, cheaper replies. /reasoning ' + cur + ' to put it back.' + reasoningModelNote());
  }
  function voiceCommand(args) {
    if (typeof Voice === 'undefined') return localLine('Voice controls are not available in this surface.');
    const raw = String(args || '').trim().toLowerCase();
    if (!raw || raw === 'status') {
      return localLine('Voice: replies ' + (Voice.isOn && Voice.isOn() ? 'on' : 'off')
        + ', Local Live ' + (typeof VoiceLive !== 'undefined' && VoiceLive.isActive && VoiceLive.isActive() ? 'on' : 'off')
        + ', listening support ' + (Voice.canListen && Voice.canListen() ? 'yes' : 'no')
        + ', speech support ' + (Voice.canSpeak && Voice.canSpeak() ? 'yes' : 'no') + '.');
    }
    if (/^(on|true|yes|speak|tts)$/.test(raw)) {
      if (Voice.setSpeakReplies) Voice.setSpeakReplies(true);
      return localLine('Voice replies are on.');
    }
    if (/^(off|false|no|mute)$/.test(raw)) {
      if (typeof VoiceLive !== 'undefined' && VoiceLive.end) VoiceLive.end();
      if (Voice.stopConvo) Voice.stopConvo();
      if (Voice.setSpeakReplies) Voice.setSpeakReplies(false);
      return localLine('Voice replies are off.');
    }
    if (/^(handsfree|hands-free|convo|conversation|live)$/.test(raw)) {
      if (typeof VoiceLive === 'undefined' || !VoiceLive.start || !VoiceLive.end) {
        return localLine('Local Live voice is not available in this surface.');
      }
      if (VoiceLive.isActive && VoiceLive.isActive()) {
        VoiceLive.end();
        return localLine('Local Live voice stopped.');
      }
      VoiceLive.start(false);
      return localLine('Local Live voice is opening.');
    }
    localLine('Usage: /voice [on|off|status|live]');
  }
  // /tools and /usage are dispatch:'server' — the sidecar owns CAP_REGISTRY and the spend ledger, so it answers
  // them (see sidecar/slash-actions.js). The browser versions were removed rather than kept as a fallback: a
  // hardcoded tool list and a browser-only spend counter are exactly the two things that were lying.
  async function skillsCommand() {
    try {
      const key = slashCatalogKey();
      const r = await fetch('/api/skills?placed=' + encodeURIComponent(key), { cache: 'no-store' });
      // ⛔ AN ERRORED ENDPOINT IS NOT AN EMPTY ONE. A non-2xx used to collapse to `[]` and print the confirmed
      // "No skill recipes are installed." — a station that could not be asked, reported as a station with none.
      if (!r.ok) return localLine('Could not load skills from the sidecar (HTTP ' + r.status + ') — this is not a claim that you have none.');
      const j = await r.json();
      const skills = (j && Array.isArray(j.skills)) ? j.skills : [];
      if (!skills.length) return localLine('No skill recipes are installed.');
      const active = skills.filter(s => s.enabled && s.available).map(s => s.slug);
      const locked = skills.filter(s => s.enabled && !s.available).map(s => s.slug);
      const off = skills.filter(s => !s.enabled).length;
      localLine('Skills: ' + active.length + ' active' + (active.length ? ' (' + active.slice(0, 8).join(', ') + ')' : '')
        + (locked.length ? '; ' + locked.length + ' enabled but locked (' + locked.slice(0, 5).join(', ') + ')' : '')
        + (off ? '; ' + off + ' off' : '') + '. Use /<skill-slug> to draft with an available skill.');
    } catch (_) { localLine('Could not load skills from the sidecar.'); }
  }
  async function memoryCommand(args) {
    if (typeof Harness === 'undefined' || !Harness.memoryRecords) return localLine('Memory records are not available yet.');
    const agentId = (activeWs && activeWs.agentId) || (activeAgent() && activeAgent().id) || 'agent';
    const q = String(args || '').trim().toLowerCase();
    try {
      let recs = await Harness.memoryRecords(agentId);
      recs = Array.isArray(recs) ? recs : [];
      const shown = q ? recs.filter(r => String((r && (r.content || r.text || r.kind)) || '').toLowerCase().indexOf(q) >= 0) : recs;
      const top = shown.slice(0, 4).map(r => String((r && (r.content || r.text)) || '').replace(/\s+/g, ' ').slice(0, 56));
      localLine('Memory: ' + recs.length + ' record' + (recs.length === 1 ? '' : 's')
        + (q ? ', ' + shown.length + ' matching "' + q + '"' : '')
        + (top.length ? ' - ' + top.join(' | ') : '.'));
    } catch (_) { localLine('Could not load memory records from the sidecar.'); }
  }
  async function bundlesCommand() {
    const recipes = (typeof Recipes !== 'undefined' && Recipes.list) ? Recipes.list() : [];
    let skillCount = 0, activeSkills = [];
    try {
      const r = await fetch('/api/skills?placed=' + encodeURIComponent(slashCatalogKey()), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const skills = (j && Array.isArray(j.skills)) ? j.skills : [];
      skillCount = skills.length;
      activeSkills = skills.filter(s => s.enabled && s.available).map(s => s.slug);
    } catch (_) { skillCount = null; }   // null = COULD NOT ASK, never "you have zero" (see skillsCommand)
    localLine('Bundles: ' + recipes.length + ' recipe blueprint' + (recipes.length === 1 ? '' : 's')
      + (recipes.length ? ' (' + recipes.slice(0, 6).map(r => r.id).join(', ') + ')' : '')
      + (skillCount == null
        ? '; skill recipes could not be read from the sidecar'
        : '; ' + skillCount + ' skill recipe' + (skillCount === 1 ? '' : 's')
          + (activeSkills.length ? ', active: ' + activeSkills.slice(0, 6).join(', ') : '')) + '.');
  }
  function recipeByRef(raw) {
    const q = String(raw || '').trim().toLowerCase();
    const list = (typeof Recipes !== 'undefined' && Recipes.list) ? Recipes.list() : [];
    if (!q) return null;
    return list.find(r => String(r.id || '').toLowerCase() === q)
      || list.find(r => String(r.name || '').toLowerCase() === q)
      || list.find(r => String(r.id || '').toLowerCase().indexOf(q) >= 0 || String(r.name || '').toLowerCase().indexOf(q) >= 0)
      || null;
  }
  function blueprintCommand(args) {
    const raw = String(args || '').trim();
    const list = (typeof Recipes !== 'undefined' && Recipes.list) ? Recipes.list() : [];
    if (!raw) return localLine('Blueprints: ' + (list.length ? list.slice(0, 10).map(r => '/' + r.id).join(', ') : 'none') + '. Use /blueprint <name> to load one.');
    const r = recipeByRef(raw);
    if (!r) return localLine('No blueprint matched "' + raw + '".');
    insertRecipe(r);
    localLine('Loaded blueprint ' + (r.name || r.id) + ' into the composer.');
  }
  function suggestionsCommand(args) {
    if (typeof MintStore === 'undefined' || !MintStore.candidates) return localLine('Suggestions are not available yet.');
    const raw = String(args || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const action = (parts[0] || '').toLowerCase();
    const candidates = MintStore.candidates() || [];
    if (!raw || action === 'catalog' || action === 'list') {
      if (!candidates.length) return localLine('No recurring-task suggestions are ready yet.');
      return localLine('Suggestions: ' + candidates.map((c, i) => (i + 1) + '. ' + String(c.template || c.lastText || c.key).slice(0, 70)).join(' | ')
        + '. Use /suggestions accept N or /suggestions dismiss N.');
    }
    if (action === 'clear') { if (MintStore.forget) MintStore.forget(); return localLine('Cleared recurring-task suggestion history.'); }
    const n = Number(parts[1] || parts[0]);
    const c = Number.isInteger(n) ? candidates[n - 1] : null;
    if (!c) return localLine('Pick a suggestion number from /suggestions.');
    if (action === 'dismiss' || action === 'reject') {
      MintStore.markDismissed(c.key);
      return localLine('Dismissed suggestion #' + n + '.');
    }
    if (action === 'accept' || action === 'save' || action === 'approve') {
      if (typeof Recipes !== 'undefined' && Recipes.saveCustom && Recipes.draft) {
        const rec = Recipes.saveCustom(Recipes.draft({ name: 'Suggested Mission', tagline: 'learned from recurring tasks', task: c.template || c.lastText || '' }));
        MintStore.markMinted(c.key);
        warmSlashCatalog();
        return localLine('Saved suggestion #' + n + ' as /' + rec.id + '.');
      }
      MintStore.markMinted(c.key);
      return localLine('Marked suggestion #' + n + ' accepted.');
    }
    localLine('Usage: /suggestions [accept N|dismiss N|clear]');
  }
  async function cronCommand(args) {
    const raw = String(args || '').trim().toLowerCase();
    try {
      if (/^(on|enable|enabled|arm)$/.test(raw) || /^(off|disable|disabled|disarm)$/.test(raw)) {
        const want = /^(on|enable|enabled|arm)$/.test(raw);
        const r = await fetch('/api/cron/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: want }) });
        const j = await r.json().catch(() => null);
        return localLine(r.ok && j ? ('Routines scheduler ' + (j.enabled ? 'enabled' : 'disabled') + '.') : 'Could not update the routines scheduler.');
      }
      const r = await fetch('/api/cron', { cache: 'no-store' });
      // an errored read is NOT "scheduler off, 0 jobs" — that reassuring line is exactly the lie to avoid.
      if (!r.ok) return localLine('Could not read the routines scheduler (HTTP ' + r.status + ') — its real state is unknown.');
      const j = await r.json();
      const jobs = (j && Array.isArray(j.jobs)) ? j.jobs : [];
      const bits = jobs.slice(0, 5).map((job, i) => (i + 1) + '. ' + (job.name || job.id || 'routine') + (job.enabled === false ? ' [paused]' : ''));
      const schedulerLine = j && j.halted ? 'stopped (E-STOP)' : (j && j.enabled ? 'on' : 'off');
      localLine('Routines: scheduler ' + schedulerLine + ', ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's')
        + (bits.length ? ' - ' + bits.join(' | ') : '.') + (j && j.halted ? ' Use /cron on to resume.' : ' Use /cron on or /cron off to arm/disarm.'));
    } catch (_) { localLine('Could not load routines from the sidecar.'); }
  }
  async function reloadMcpCommand(args) {
    const target = String(args || '').trim();
    try {
      const r = await fetch('/api/connectors', { cache: 'no-store' });
      // an errored read is NOT "no connectors are configured" — say which one it is.
      if (!r.ok) return localLine('Could not read your MCP connectors (HTTP ' + r.status + ') — this is not a claim that you have none.');
      const j = await r.json();
      let conns = (j && Array.isArray(j.connectors)) ? j.connectors : [];
      if (target) conns = conns.filter(c => String(c.id || '').toLowerCase() === target.toLowerCase());
      if (!conns.length) return localLine(target ? ('No MCP connector matched "' + target + '".') : 'No MCP connectors are configured.');
      const results = [];
      for (const c of conns) {
        const rr = await fetch('/api/connectors/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) });
        const jj = await rr.json().catch(() => null);
        const st = (jj && (jj.status || jj));
        results.push(String(c.id) + ':' + ((st && st.state) || (rr.ok ? 'refreshed' : 'error')) + ((st && st.toolCount != null) ? '/' + st.toolCount + ' tools' : ''));
      }
      localLine('MCP refresh: ' + results.join(', ') + '.');
    } catch (_) { localLine('Could not refresh MCP connectors.'); }
  }
  function reloadSkillsCommand() {
    slashServerCommands = null; slashCatalogLoaded = null; slashCatalogLoading = null;
    warmSlashCatalog();
    localLine('Refreshing slash skills and command catalog for this workstation.');
  }
  async function versionCommand() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j) {
        const bits = [];
        if (j.app) bits.push('StarNet ' + j.app);
        if (j.harness && j.harness !== j.app) bits.push('harness ' + j.harness);
        if (j.node) bits.push('Node ' + j.node);
        return localLine('Version: ' + (bits.length ? bits.join(', ') : 'unknown') + '.');
      }
    } catch (_) {}
    localLine('Version: could not reach the sidecar (/api/version). It is likely offline.');
  }
  function debugCommand() {
    const ws = activeWs || {};
    const rid = (typeof Channels !== 'undefined' && Channels.runIdOf && ws.id) ? Channels.runIdOf(ws.id) : '';
    const pending = (ws.id && queued.get(ws.id)) || [];
    const a = activeAgent();
    localLine('Debug: stream=' + (ws.id || 'none') + ', agent=' + ((ws.agentId || (a && a.id)) || 'agent')
      + ', run=' + (rid || 'none') + ', busy=' + (isBusy() ? 'yes' : 'no') + ', queued=' + pending.length
      + ', slashCatalog=' + (slashServerCommands ? slashServerCommands.length : 0) + ', model=' + ((typeof Harness !== 'undefined' && Harness.getModel && Harness.getModel()) || 'unset') + '.');
  }
  function localSlashActions() {
    return {
      retry: retryLast, stop: stopActive, copy: copyLastReply, help: showHelp,
      new: newWorkstreamCommand, branch: branchWorkstreamCommand, status: statusCommand,
      queue: queueCommand, steer: steerCommand, undo: undoCommand,
      compress: compressCommand, title: titleCommand, resume: resumeCommand,
      save: saveCommand, agents: agentsCommand, background: backgroundCommand,
      goal: goalCommand, subgoal: subgoalCommand, loop: loopCommand,
      clear: clearCommand, history: historyCommand, whoami: whoamiCommand, insights: insightsCommand,
      model: modelCommand, personality: personalityCommand, yolo: yoloCommand,
      reasoning: reasoningCommand, fast: fastCommand, voice: voiceCommand,
      skills: skillsCommand, memory: memoryCommand,
      bundles: bundlesCommand, cron: cronCommand, suggestions: suggestionsCommand,
      blueprint: blueprintCommand, 'reload-mcp': reloadMcpCommand,
      'reload-skills': reloadSkillsCommand, debug: debugCommand, version: versionCommand
    };
  }
  function showHelp() {
    const cmds = buildCommands().filter(c => c.source !== 'recipe');
    const recipes = buildCommands().filter(c => c.source === 'recipe').length;
    // group by the existing `category` field so the command surface reads by area, not one flat blob
    const groups = new Map();
    for (const c of cmds) { const cat = c.category || 'General'; if (!groups.has(cat)) groups.set(cat, []); groups.get(cat).push('/' + c.name); }
    const lines = [];
    for (const [cat, names] of groups) lines.push(cat + ' — ' + names.join(', '));
    if (recipes) lines.push('Recipes — ' + recipes + ' available (type "/" to browse)');
    lines.push('Tip: press ↑ in an empty box to recall your last message.');   // ArrowUp recall hint
    systemCard('Commands (' + cmds.length + ') — click to expand', lines);
  }
  function slashPlacedTypes() {
    try {
      if (typeof World === 'undefined' || !World.heroCaps) return [];
      const caps = World.heroCaps((activeWs && activeWs.agentId) || 'agent') || [];
      const out = [], seen = {};
      for (const c of caps) {
        const t = String((c && c.objectType) || c || '').trim();
        if (!t || seen[t]) continue;
        seen[t] = true; out.push(t);
      }
      out.sort();
      return out;
    } catch (_) { return []; }
  }
  function slashCatalogKey() {
    return slashPlacedTypes().join(',');
  }
  function warmSlashCatalog() {
    const key = slashCatalogKey();
    if (slashCatalogLoaded === key) return;
    if (slashCatalogLoading === key || typeof fetch === 'undefined') return;
    slashCatalogLoading = key;
    fetch('/api/slash/catalog?placed=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        slashServerCommands = (j && Array.isArray(j.commands)) ? j.commands : null;
        slashCatalogLoaded = key;
      })
      // A FAILED fetch must not be remembered as "loaded": marking it done pinned the tab into catalog-less mode
      // for that placed-key forever, and server-executed commands (/away, /routine) have no local action to fall
      // back to — they would refuse for the rest of the session even though the sidecar was healthy and never
      // asked again. Leaving `loaded` unset lets the next keystroke retry.
      .catch(() => { slashServerCommands = null; })
      .then(() => {
        slashCatalogLoading = null;
        if (input && input.value && input.value[0] === '/') openSlash(input.value.slice(1));
      });
  }
  // drop a recipe's directive into the input: apply each OPTIONAL param's default, but leave REQUIRED blanks
  // visible as {tokens} so the Commander can see what to fill — and pre-select the first one to type over.
  function insertRecipe(r, values) {
    if (!input) return;
    let directive = (r && r.task) || (r && r.name) || '';
    for (const p of (r && r.params) || []) {
      if (!p || !p.key) continue;
      // last-used inputs (confirm-by-sight: they land visibly in the composer) beat catalog defaults.
      const remembered = values && typeof values[p.key] === 'string' && values[p.key].trim() ? values[p.key] : null;
      const v = remembered != null ? remembered : ((p.default != null && p.default !== '') ? p.default : null);
      if (v != null) directive = directive.split('{' + p.key + '}').join(v);
    }
    input.value = directive; input.focus();
    const m = /\{[^}]+\}/.exec(directive);   // select the first remaining blank to type over (else cursor at end)
    try { if (m) input.setSelectionRange(m.index, m.index + m[0].length); else input.setSelectionRange(directive.length, directive.length); } catch (_) {}
    autoGrowInput();   // COMPOSER: a filled recipe directive can be multi-line — grow to show it
  }
  function normalizeSlashCommand(raw, source) {
    const c = raw || {};
    const name = String(c.name || '').replace(/^\//, '').trim();
    if (!name) return null;
    const action = String(c.action || name).trim();
    return {
      name: name,
      aliases: Array.isArray(c.aliases) ? c.aliases.slice() : [],
      desc: c.desc || c.description || '',
      category: c.category || 'General',
      // the registry has always published argsHint; it was dropped here, so the palette could never show that
      // a command TAKES an argument (/steer <guidance> read as a no-arg command). Carry it through.
      argsHint: c.argsHint || '',
      action: action,
      source: c.source || source || 'server',
      serverBacked: source === 'server',
      run: localSlashActions()[action] || null
    };
  }
  function buildCommands() {
    const cmds = [], seen = {};
    const add = c => {
      if (!c || seen[c.name]) return;
      seen[c.name] = true; cmds.push(c);
    };
    if (slashServerCommands && slashServerCommands.length) {
      for (const c of slashServerCommands) add(normalizeSlashCommand(c, 'server'));
    }
    for (const c of FALLBACK_SLASH_COMMANDS) add(normalizeSlashCommand(c, 'builtin'));
    if (typeof Recipes !== 'undefined' && Recipes.list) {
      for (const r of Recipes.list()) add({ name: r.id, aliases: [], desc: (r.emoji ? r.emoji + ' ' : '') + (r.name || r.id) + (r.tagline ? ' - ' + r.tagline : ''), source: 'recipe', run: () => insertRecipe(r) });
    }
    return cmds;
  }
  function matchCommands(q) {
    q = (q || '').toLowerCase().trim();
    const all = buildCommands();
    if (!q) return all.slice(0, 8);
    const pref = [], sub = [];
    for (const c of all) {
      const n = c.name.toLowerCase();
      const aliases = (c.aliases || []).map(a => String(a || '').toLowerCase());
      if (n.indexOf(q) === 0 || aliases.some(a => a.indexOf(q) === 0)) pref.push(c);
      else if (n.indexOf(q) >= 0 || aliases.some(a => a.indexOf(q) >= 0) || (c.desc || '').toLowerCase().indexOf(q) >= 0) sub.push(c);
    }
    return pref.concat(sub).slice(0, 8);
  }
  /* ---- ARGUMENT-VALUE COMPLETION -------------------------------------------------------------------
     The palette completed command NAMES but never argument VALUES, so `/model ` offered nothing of the 345
     warmed ids and `/personality ` never named the seven options — you had to run the bare command, read the
     list, then retype.

     The derivation trick is taken from the reference harness (© 2025 Nous Research, MIT — see NOTICE.md):
     it builds a static completion list straight out of each command's args_hint by pulling the
     pipe-separated pattern out of it, so a command declaring "[on|off|status]" gets completion for free with
     no per-command wiring. We do the same against our own `argsHint`, then layer live providers over the top
     for the sets only a running station knows (models, personalities, workstreams, recipes).

     ENTER STILL DISPATCHES THE COMMAND. Completion is bound to TAB only. The palette's Enter contract is
     load-bearing — a regressed Enter is exactly what fired "/personality direct" at the model as chat
     (2026-07-05), and test/slash.palette.test.js + the J7 journey guard it. */
  const PIPE_VALUES_RE = /[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+/;
  let slashValueMode = null;      // { name } while completing an ARGUMENT; null while matching command names
  let slashModelIds = null;       // warmed model ids, fetched once per session for /model completion

  function staticValuesFor(cmd) {
    const m = PIPE_VALUES_RE.exec((cmd && cmd.argsHint) || '');
    return m ? m[0].split('|') : [];
  }
  function warmModelValues() {
    if (slashModelIds || typeof Harness === 'undefined' || !Harness.listModels) return;
    slashModelIds = [];   // claim the slot so a slow catalog can't fire a fetch per keystroke
    Harness.listModels().then(list => {
      slashModelIds = (Array.isArray(list) ? list : []).map(m => (m && m.id) || '').filter(Boolean);
      if (input && input.value && input.value[0] === '/') openSlash(input.value.slice(1));
    }).catch(() => { slashModelIds = []; });
  }
  // Live value sets. Each returns [{value, hint}] and NEVER throws — a missing module just means no
  // completion for that command, never a broken palette.
  function liveValuesFor(name) {
    try {
      if (name === 'personality' && typeof Personas !== 'undefined' && Personas.list)
        return Personas.list().map(p => ({ value: p.id, hint: p.name || '' }));
      if (name === 'blueprint' && typeof Recipes !== 'undefined' && Recipes.list)
        return Recipes.list().map(r => ({ value: r.id, hint: r.name || '' }));
      if (name === 'resume' && typeof Workstreams !== 'undefined' && Workstreams.list)
        return Workstreams.list().map(w => ({ value: w.title || w.id, hint: ((w.history || []).length) + ' turns' }));
      if (name === 'model') { warmModelValues(); return (slashModelIds || []).map(id => ({ value: id, hint: '' })); }
    } catch (_) {}
    return [];
  }
  function valueSuggestions(cmd, partial) {
    const live = liveValuesFor(cmd.name);
    const all = live.length ? live : staticValuesFor(cmd).map(v => ({ value: v, hint: '' }));
    const q = String(partial || '').toLowerCase();
    const pre = [], sub = [];
    for (const o of all) {
      const v = String(o.value).toLowerCase();
      if (!q) pre.push(o);
      else if (v.indexOf(q) === 0) pre.push(o);
      else if (v.indexOf(q) >= 0 || String(o.hint || '').toLowerCase().indexOf(q) >= 0) sub.push(o);
    }
    return pre.concat(sub).slice(0, 8);
  }
  // Put the highlighted value into the composer, keeping "/name " intact, then re-open so the list narrows.
  function completeSlashValue(item) {
    if (!item || !input) return false;
    const raw = String(input.value || '');
    const sp = raw.search(/\s/);
    if (sp < 0) return false;
    input.value = raw.slice(0, sp + 1) + item.name;
    input.focus();
    autoGrowInput();
    openSlash(input.value.replace(/^\//, ''));
    return true;
  }

  function openSlash(query) {
    const pop = el('chat-slash'); if (!pop) return;
    warmSlashCatalog();
    const raw = String(query || '');
    const sp = raw.search(/\s/);
    slashValueMode = null;
    if (sp > 0) {
      // An argument is being typed — offer VALUES for this command rather than re-listing its name.
      const token = raw.slice(0, sp).toLowerCase();
      const cmd = buildCommands().find(c => c.name.toLowerCase() === token
        || (c.aliases || []).some(a => String(a || '').toLowerCase() === token));
      if (cmd) {
        const vals = valueSuggestions(cmd, raw.slice(sp + 1));
        if (vals.length) {
          slashValueMode = { name: cmd.name };
          slashItems = vals.map(v => ({ name: String(v.value), desc: String(v.hint || ''), isValue: true }));
          if (slashSel >= slashItems.length) slashSel = 0;
          renderSlash(); pop.hidden = false; return;
        }
      }
    }
    // Match on the command NAME only (the first token). Once the user types a space into the arguments
    // ("/personality direct"), the full string stops prefix-matching any command name and the palette used
    // to CLOSE — which dropped Enter through to send(), firing the whole "/cmd args" line at the agent as a
    // chat message instead of running the command. Matching the first token keeps the command shown so Enter
    // dispatches it (with its args parsed off input.value in runSlash).
    slashItems = matchCommands(raw.split(/\s+/)[0]);
    if (!slashItems.length) { closeSlash(); return; }
    if (slashSel >= slashItems.length) slashSel = 0;
    renderSlash(); pop.hidden = false;
  }
  // resolve a "/name …" line to its command by exact name/alias (first token) — the belt-and-suspenders path
  // for Enter when the palette isn't open (e.g. the server catalog is still loading), so an arg-taking command
  // still dispatches instead of being sent to the agent as plain text.
  function commandFromLine(raw) {
    const m = String(raw || '').match(/^\/(\S+)/);
    if (!m) return null;
    const name = m[1].toLowerCase();
    return buildCommands().find(c => c.name.toLowerCase() === name || (c.aliases || []).some(a => String(a || '').toLowerCase() === name)) || null;
  }
  function closeSlash() {
    const pop = el('chat-slash'); if (pop) pop.hidden = true; slashItems = []; slashSel = 0; slashValueMode = null;
    if (input) { input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false'); }
  }
  function moveSlash(d) { if (!slashItems.length) return; slashSel = (slashSel + d + slashItems.length) % slashItems.length; renderSlash(); }
  const SLASH_OPT_ID = i => 'slash-opt-' + i;   // stable per-position option id for aria-activedescendant
  function renderSlash() {
    const pop = el('chat-slash'); if (!pop) return;
    pop.innerHTML = '';
    const head = document.createElement('div'); head.className = 'slash-head';
    // name the mode: completing an argument is a different act from picking a command, and TAB (not Enter)
    // is what accepts a value — say so rather than leaving the user to guess.
    head.textContent = slashValueMode ? ('/' + slashValueMode.name + ' — TAB to fill') : '/ COMMANDS';
    pop.appendChild(head);
    slashItems.forEach((c, i) => {
      const it = document.createElement('div'); it.className = 'slash-item' + (i === slashSel ? ' sel' : ''); it.setAttribute('role', 'option');
      it.id = SLASH_OPT_ID(i); it.setAttribute('aria-selected', i === slashSel ? 'true' : 'false');
      // show the ARGUMENT SHAPE next to the name ("/loop <interval> <prompt>") — without it the palette reads
      // as if every command were arg-less, which is exactly how arg-taking commands went unused.
      const nm = document.createElement('span'); nm.className = 'slash-name';
      // a VALUE row is an argument, not a command — no leading slash, no argsHint
      nm.textContent = c.isValue ? c.name : ('/' + c.name + (c.argsHint ? ' ' + c.argsHint : ''));
      const ds = document.createElement('span'); ds.className = 'slash-desc'; ds.textContent = c.desc || '';
      it.appendChild(nm); it.appendChild(ds);
      // reveal the command SURFACE: a dim category tag (the existing `category` field) so the palette groups
      // legibly by area without reordering the relevance-ranked matches.
      if (c.category && c.category !== 'General') { const tag = document.createElement('span'); tag.className = 'slash-cat'; tag.textContent = c.category; it.appendChild(tag); }
      it.onmouseenter = () => { slashSel = i; renderSlash(); };
      // mousedown keeps input focus. A VALUE row fills the argument (it is not runnable); a command row runs.
      it.onmousedown = e => { e.preventDefault(); if (c.isValue) completeSlashValue(c); else runSlash(c); };
      pop.appendChild(it);
    });
    // AT: point the focused composer at the active option (the listbox is separate, so activedescendant lives on
    // the input) + mark the palette open. Keyboard nav (moveSlash) re-renders → this follows the selection.
    if (input) { input.setAttribute('aria-expanded', 'true'); if (slashItems[slashSel]) input.setAttribute('aria-activedescendant', SLASH_OPT_ID(slashSel)); }
  }
  function insertSlashText(text, select) {
    if (!input) return false;
    const directive = String(text || '');
    input.value = directive; input.focus();
    if (select === 'first-placeholder') {
      const m = /\{[^}]+\}/.exec(directive);
      try { if (m) input.setSelectionRange(m.index, m.index + m[0].length); else input.setSelectionRange(directive.length, directive.length); } catch (_) {}
    }
    autoGrowInput();   // COMPOSER: match the box to the inserted directive's height
    return true;
  }
  function applySlashDirective(directive) {
    if (!directive) return false;
    if (directive.type === 'client') {
      const fn = localSlashActions()[directive.action];
      if (!fn) return false;
      fn(directive.args || '');
      return true;
    }
    if (directive.type === 'insert') return insertSlashText(directive.text, directive.select);
    // SAY — the sidecar already EXECUTED this command (dispatch:'server') and handed back the finished text.
    // The browser's only job is to print it: a multi-line readout becomes a collapsible card, one line stays a
    // line. Nothing here re-derives or re-formats state, so this surface cannot disagree with the sidecar's.
    if (directive.type === 'say') {
      const lines = Array.isArray(directive.lines) ? directive.lines.filter(s => String(s || '').trim()) : [];
      if (lines.length) systemCard(directive.title || 'Result', lines);
      else localLine(String(directive.text || '').trim() || 'Done.');
      return true;
    }
    return false;
  }
  async function dispatchSlash(item, rawInput) {
    try {
      const r = await fetch('/api/slash/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // agentId rides the dispatch so a server action acts on the agent this stream is actually talking to
        // (the away workshop is per-agent) rather than guessing a default.
        body: JSON.stringify({
          input: rawInput || ('/' + item.name),
          placed: slashPlacedTypes(),
          agentId: (activeWs && activeWs.agentId) || 'agent'
        })
      });
      const j = await r.json().catch(() => null);
      return !!(r.ok && j && j.ok && applySlashDirective(j.directive));
    } catch (_) { return false; }
  }
  async function runSlash(item) {
    if (!item) { closeSlash(); return; }
    const rawInput = input ? input.value : '';
    input.value = ''; closeSlash(); autoGrowInput();   // consume the "/query"; a recipe's run() then refills the input
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    // Try the sidecar for anything server-backed OR anything with no local action at all. The second half
    // matters on a cold start: before the catalog fetch lands, /away and /routine are only known from the
    // FALLBACK list (serverBacked === false) and have no handler — without this they would refuse without ever
    // having asked the station, which is a claim the browser cannot make honestly.
    const needsServer = item.serverBacked || typeof item.run !== 'function';
    if (needsServer && await dispatchSlash(item, rawInput)) return;
    // FALLBACK path (command not resolved by the server dispatcher): parse the trailing text off the raw
    // "/name rest…" input and hand it to the local action, so an arg-taking builtin still gets its argument
    // even when the server slash catalog doesn't know it. Arg-less actions ignore it.
    const args = String(rawInput || '').replace(/^\/\S+\s*/, '');
    // A dispatch:'server' command has NO local action by design. When the sidecar can't be reached it used to
    // throw on a null run() inside a bare catch — the command silently did nothing at all. Say so instead.
    if (typeof item.run !== 'function') {
      localLine('/' + item.name + ' runs on the station, and the station did not answer just now — check the UPLINK indicator, then try again.');
      return;
    }
    try { item.run(args); } catch (_) {}
  }

  /* ═══════════════ WORK LINES IN COMMS (agentic graphs) ═══════════════════════════════════════════════
     A directive typed here lands at ONE dock. If the Commander drew belts PAST that dock, those stages are
     the work — and until this existed they were scenery on this surface while channel and cron work ran the
     whole line. The sidecar advances its own lines because it owns those turns; a COMMS turn streams through
     /api/run to the BROWSER, which owns it, so the browser asks the SAME router the same question
     (/api/routing/chain) and runs the same hops with the SAME shared handoff prompt. One floor, one answer,
     whoever started it.

     Every stage renders as its OWN agent turn under its own name. That is not decoration: the line really is
     three agents doing three pieces of work, and collapsing it to one reply would hide who wrote what. The
     LAST stage's text is the answer (returned to the caller, which re-points voice/title at it).

     Bounded exactly like the sidecar executor: LINE_MAX_HOPS, a $ ceiling on the whole line, an agent never
     runs twice, and a stop / stream switch / empty stage ends the line keeping the last good text. */
  const LINE_MAX_HOPS = 6;    // mirrors MAX_HOPS in sidecar/routing/chain.js — these two must not drift
  const LINE_MAX_USD = 2.00;  // mirrors MAX_CHAIN_USD in sidecar/routing/chain.js — these two must not drift

  function lineTag(t) { return (typeof Classify !== 'undefined' && Classify.getTag) ? Classify.getTag(t) : 'general'; }

  // WHERE DOES THIS DOCK'S OUTPUT GO? Asked of the router, never re-derived here — the browser holds a plan for
  // drawing, but the SIDECAR's plan is the one that authorizes spend, so it is the one that decides. Returns
  // { next, brief } — `brief` is the NEXT dock's standing job brief (step editor; the same router fact the
  // sidecar's chain runner injects), so both surfaces compose one handoff turn. null = terminal stage.
  async function nextStageOf(agentId, tag, lineId) {
    try {
      const h = {}, tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) || '';
      if (tok) h['X-StarNet-Token'] = String(tok);
      // `lineId` = the line this work ENTERED on (work belongs to a line, 2026-08-07). The sidecar's plan is
      // still the decider — it refuses any id that is not this dock's own line — so this only ever narrows.
      const r = await fetch('/api/routing/chain?agentId=' + encodeURIComponent(agentId) + '&tag=' + encodeURIComponent(tag || '')
        + '&lineId=' + encodeURIComponent(lineId || ''), { cache: 'no-store', headers: h });
      if (!r || !r.ok) return null;
      const j = await r.json();
      return (j && j.next) ? { next: String(j.next), brief: (typeof j.brief === 'string' && j.brief) ? j.brief : null } : null;
    } catch (_) { return null; }   // no floor, no sidecar, no line — the single-stage reply already stands
  }

  /* Run every stage downstream of `fromAgentId`. Returns { text, agentId, hops } — text is the LINE's answer
     (the seed text unchanged when no stage ran). Never throws: a work line is an enhancement to a reply the
     caller already has, exactly like the sidecar's. */
  async function runWorkLine(ws, seed) {
    const out = { text: seed.text, agentId: seed.fromAgentId, hops: 0, usd: 0 };
    if (!seed.fromAgentId || !String(seed.text || '').trim()) return out;
    // WORK BELONGS TO A LINE (2026-08-07): a line advances only for work that entered through ITS OWN
    // trigger. `seed.lineId` is that origin; without one this dock is terminal and nothing downstream runs.
    if (!seed.lineId) return out;
    const visited = {}; visited[seed.fromAgentId] = true;
    let cur = seed.fromAgentId;
    // LINE BUDGET (2026-08-21): the sidecar answers each /api/routing/chain ask with the EFFECTIVE ceilings
    // for this line (its INBOX's limits, clamped to the global pool) — the browser bounds itself by the same
    // numbers the sidecar executor would. An older sidecar answers none: the mirrored constants hold.
    let maxHops = LINE_MAX_HOPS, maxUsd = LINE_MAX_USD, maxUsdPerDay = null, spentToday = 0;
    for (let hop = 1; hop <= maxHops + 1; hop++) {   // +1 so a stage PAST the ceiling is named, as the sidecar names it
      if (seed.signal && seed.signal.aborted) return out;
      if (interrupted.has(ws.id)) return out;                       // the Commander pressed Stop — the line stops
      const nxr = await nextStageOf(cur, lineTag(out.text), seed.lineId);
      const nx = nxr && nxr.next;
      if (!nx || visited[nx]) return out;                           // terminal stage, or a loop the plan let through
      const lim = nxr && nxr.limits;
      if (lim && typeof lim === 'object') {
        if (typeof lim.maxHops === 'number' && lim.maxHops >= 0) maxHops = lim.maxHops;
        if (typeof lim.maxUsd === 'number' && lim.maxUsd > 0) maxUsd = lim.maxUsd;
        maxUsdPerDay = (typeof lim.maxUsdPerDay === 'number' && lim.maxUsdPerDay > 0) ? lim.maxUsdPerDay : null;
        spentToday = (typeof lim.spentToday === 'number' && lim.spentToday > 0) ? lim.spentToday : 0;
      }
      if (hop > maxHops) {
        if (isActiveWs(ws)) toolLine('⚠ the work line stopped early — the line is longer than ' + maxHops + ' stages.', true);
        return out;
      }
      // THE LINE'S SPEND CEILING — the same pre-hop check as the sidecar executor (chain.js: out.usd >= maxUsd
      // before the next stage buys a run). out.usd is REAL reconciled spend: each hop's agent.run.end carries
      // the run's reconciled total (loop.js), never an estimate — so this cap measures what was actually billed.
      if (out.usd >= maxUsd) {
        if (isActiveWs(ws)) toolLine('⚠ the work line stopped early — the line reached its $' + maxUsd.toFixed(2) + ' limit.', true);
        return out;
      }
      // THE DAILY CAP — the sidecar's durable per-line day ledger (line-spend.json) plus what this line spent
      // so far; the sidecar is the only one that can prove the day, so this only ever repeats its number.
      if (maxUsdPerDay != null && spentToday + out.usd >= maxUsdPerDay) {
        if (isActiveWs(ws)) toolLine('⚠ the work line stopped early — the line reached its $' + maxUsdPerDay.toFixed(2) + ' daily limit.', true);
        return out;
      }
      const sys = (typeof App !== 'undefined' && App.systemFor) ? App.systemFor(nx) : null;
      if (!sys) return out;                                         // a dock bound to an agent this roster doesn't have
      visited[nx] = true;

      const who = (typeof App !== 'undefined' && App.agentName && App.agentName(nx)) || nx;
      const wiHop = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('wi-' + Date.now() + '-' + (++wiSeq));
      const hopStart = Date.now();
      // the floor draws the handoff exactly like a channel line's: a crate leaves this dock for the next.
      // `from` = the PRODUCER dock (mirrors chain.js's placed event — must not drift): world.js spawns the
      // crate at THIS dock instead of guessing the upstream dock from the compiled plan.
      wiEmit('workitem.placed', { workitemId: wiHop, queueId: nx, agentId: nx, kind: 'chain', from: cur, lineId: seed.lineId, preview: String(out.text).replace(/\s+/g, ' ').slice(0, 40), ts: hopStart });
      if (isActiveWs(ws)) { breakLive(); toolLine('▸ ' + who + ' — stage ' + (hop + 1) + ' of the work line'); }

      // the RECEIVING dock's standing brief rides the shared handoff turn — the same 5th param the sidecar's
      // chain runner passes (sidecar/routing/chain.js) — so the same floor composes the same run here too.
      const prompt = (typeof Pipeline !== 'undefined' && Pipeline.handoffPrompt)
        ? Pipeline.handoffPrompt(seed.originalText, cur, out.text, hop, nxr.brief) : out.text;
      const hopRow = isActiveWs(ws) ? streamingAgent(who) : null;
      if (hopRow) activeLiveRow = hopRow;
      let hopAcc = '';
      let res = null;
      // THIS HOP'S REAL COST: the sidecar's agent.run.end carries the run's reconciled usd total (the same
      // number the channel hub's hop sink reads) and Harness re-emits every stream event onto U.bus before
      // chat() resolves — latch it by the hop's own runId so a forwarded worker's end can't be mistaken for it.
      let hopUsd = 0, hopRunId = null;
      const onHopEnd = p => { if (p && hopRunId && p.runId === hopRunId && typeof p.usd === 'number' && isFinite(p.usd) && p.usd > 0) hopUsd = p.usd; };
      const busOk = (typeof U !== 'undefined' && U.bus && U.bus.on && U.bus.off);
      if (busOk) { try { U.bus.on('agent.run.end', onHopEnd); } catch (_) {} }
      try {
        res = await Harness.chat({
          system: sys, messages: [{ role: 'user', content: prompt }], agentId: nx, isTask: true,
          signal: seed.signal, streamId: ws.id,
          placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(nx) : [],
          stationPlaced: (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [],
          onRunId: id => { hopRunId = id; },
          onToken: d => { hopAcc += d; if (hopRow) hopRow.append(d); App.refreshUsage(); },
          onTerminalReset: () => { hopAcc = ''; },
          onToolCall: ev => { if (isActiveWs(ws)) { if (hopRow && hopRow.breakSeg) hopRow.breakSeg(); toolChip(ev); } }
        });
      } catch (e) { res = { error: e }; }
      if (busOk) { try { U.bus.off('agent.run.end', onHopEnd); } catch (_) {} }
      out.usd += hopUsd;   // billed whether the stage's text survives or not — a failed hop still spent it
      if (hopRow) hopRow.done();
      const hopText = String((res && res.text) || hopAcc || '').trim();

      // A STAGE THAT FAILED OR SAID NOTHING ENDS THE LINE WITH THE LAST GOOD ANSWER — the belt is never a gate.
      if (!hopText || (res && res.error)) {
        wiEmit('workitem.superseded', { workitemId: wiHop, agentId: nx, ts: Date.now() });
        if (isActiveWs(ws)) toolLine('⚠ the work line stopped at ' + who + ' — showing ' + ((typeof App !== 'undefined' && App.agentName && App.agentName(cur)) || cur) + '’s answer above', true);
        return out;
      }
      wiEmit('workitem.delivered', { workitemId: wiHop, finalQueueId: nx, agentId: nx, box: '', ms: Date.now() - hopStart, ts: Date.now() });
      ws.history.push({ role: 'assistant', content: hopText, agentId: nx, ts: Date.now() });   // agentId = the ACTUAL speaker (renderHistory names it)
      capHistory(ws);
      out.text = hopText; out.agentId = nx; out.hops++;
      cur = nx;
    }
    return out;
  }

  async function send(text, opts) {
    if (activeWs && activeWs.conversationMode === 'group' && typeof GroupChat !== 'undefined') return GroupChat.sendText(text, { ...opts, attachmentAgent: activeWs.agentId });
    const retry = !!(opts && opts.retry);   // retry/recovery reuses a durable user turn — don't echo it again
    const recoveryResume = !!(opts && opts.recoveryResume && opts.recovery);
    // ATTACHMENTS: photos/files staged in the composer, snapshotted by the Enter handler into opts.attachments as
    // lightweight refs { id,name,path,mediaType,kind }. They ride the user turn (history + /api/run) and the
    // sidecar expands them into image/text content blocks at run time. Empty on a plain text turn / a RETRY.
    const attsIn = (opts && Array.isArray(opts.attachments)) ? opts.attachments : [];
    // R5 "Bottle a run": did THIS directive come from a recipe launch? launchRecipe() passes fromRecipe:true. A
    // recipe-launched run must NEVER be offered for bottling (it already IS a recipe) — recorded in RUN_META below.
    const fromRecipe = !!(opts && opts.fromRecipe);
    // provenance SPINE: WHICH recipe launched this run (null for everything else). Rides RUN_META (so rateWork can
    // attribute the verdict to the recipe) and the /api/run body (so the durable run row carries it).
    const recipeId = (opts && opts.recipeId != null && String(opts.recipeId).trim()) ? String(opts.recipeId).slice(0, 60) : null;
    // GOAL LOOP: is THIS turn a loop-driven continuation (kickGoal) rather than a real user message? A real user
    // message mid-loop PREEMPTS the loop; a continuation is judged and may fire the next one. Captured here so the
    // teardown routes correctly even if the active loop is paused/cleared mid-run.
    const goalContinuation = !!(opts && opts.goalContinuation);
    // capture whether an active loop already existed WHEN this turn began: only THEN does a real (non-continuation)
    // user message count as a mid-loop preemption. A /goal set DURING this turn must not be preempt-paused by its
    // own triggering turn — that loop simply wasn't running yet when the turn started.
    const goalActiveAtStart = !goalContinuation && typeof GoalLoop !== 'undefined' && (() => { const g = goalOf(activeWs); return !!(g && GoalLoop.isActive(g)); })();
    if (interview) { clearChoices(); interview(text); return; }   // THE AWAKENING owns the input: typed answers retire any stale chip row
    const runFocusVersion = focusVersion;
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    // CONCURRENT SESSIONS: no agent-global preflight refusal — a peer run on this agent is allowed to coexist
    // with this turn (the sidecar admits it; the workspace lease guards the one real collision). The peer stays
    // visible via the soft status row, and the per-STREAM gate below still holds.
    const pending = pendingTaskQuestion && pendingTaskQuestion.streamId === ws.id ? pendingTaskQuestion : null;
    const routedTaskReply = pending && typeof TaskIntent !== 'undefined' && TaskIntent.routeReply ? TaskIntent.routeReply(text) : null;
    const taskAction = (opts && opts.taskAction) || (routedTaskReply && routedTaskReply.action) || '';
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
    const starterId = !retry && !goalContinuation && typeof StarterStore !== 'undefined' ? StarterStore.claimDraft(ws.id, text) : null;
    if (typeof Workstreams !== 'undefined' && Workstreams.connectorHandoff(ws.id)) Workstreams.setConnectorHandoff(ws.id, null);
    warmChat();   // D1 WARMTH: sending to the focused stream is real engagement — keep the chat-stare alive
    // FIRST-TURN TITLE UPGRADE: is THIS the stream's first user turn (still on its machine-derived placeholder)?
    // Captured BEFORE we push this message, so after the run lands we can replace the truncated first-sentence
    // title with a model-written summary. General is excluded — it stays the untitled chat home.
    if (pending) pendingTaskQuestion = null;
    const firstTurn = (typeof Workstreams !== 'undefined') && ws.id !== Workstreams.generalId()
      && !ws.history.some(m => m && m.role === 'user');
    Channels.begin(ws.id, Date.now());   // stamp the run start so the COMMS elapsed timer counts real wall-clock
    const wiAid = ws.agentId || 'agent';
    const wiId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('wi-' + Date.now() + '-' + (++wiSeq));
    const wiPlacedTs = Date.now();
    let wiPlaced = false;   // set below iff a crate actually rode — every wi* beat downstream gates on it
    stick = true;   // sending a message means you want to watch the exchange — re-follow the bottom
    // TIMESTAMP TRUTH (P0): stamp the turn with its REAL wall-clock time at push, and render the same instant on
    // screen — so a later replay/switch shows this turn's actual time, never the reload clock.
    if (!retry) { const uts = Date.now(); addUser(text, attsIn, uts); ws.history.push(attsIn.length ? { role: 'user', content: text, attachments: attsIn, ts: uts } : { role: 'user', content: text, ts: uts }); capHistory(ws); }   // on RETRY the user turn is already in the thread + on screen
    const retryDirectiveTurn = ws.history.slice().reverse().find(m => m.role === 'user');
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = recoveryResume || !!pending || Classify.isTaskDirective(text);
    // INTENT OFFER: a real, fresh directive is the one moment the Commander has stated what they want in their
    // own words — the only honest place to say "there is a class built for exactly this". Gated to genuine new
    // work: never a retry (already offered on the original), never a recipe launch (they came FROM the library),
    // never a goal-loop continuation (the station wrote that text, not the Commander), never a reply to a
    // pending task question. Stage it on this run's metadata so concurrent sessions can never consume each
    // other's offer; the slow post-run arm reads and clears it after the answer and its own choice rows settle.
    const intentOfferText = (isTask && !retry && !fromRecipe && !goalContinuation && !pending) ? String(text || '') : null;
    // P1 + BELT IS WORK-ONLY (Andrew's ruling 2026-07-05): only a real TASK directive drops an INTAKE ore box
    // on the belt / bumps the queue gauge (mirrors the Telegram admit shape — the sidecar gates on the SAME
    // classifier). Pure chat ("hello") gets its reply with NOTHING on the floor.
    if (isTask) {
      wiPlaced = true;
      const depth = wiBump(wiAid, 1);
      wiEmit('workitem.placed', { workitemId: wiId, queueId: wiAid, agentId: wiAid, kind: 'directive', preview: String(text || '').replace(/\s+/g, ' ').slice(0, 40), queueDepth: depth, ts: wiPlacedTs });
      wiEmit('queue.status', { queueId: wiAid, depth: depth, maxCapacity: 64, nextAdvanceAt: 0 });
    }
    // fold the interest tag of a real task into the local user-affinity profile (the signal classify.js
    // already computes here and otherwise discards). Captures only a derived {code|research|general}
    // count — never the message text. Gated on the user's learning flag inside the store.
    // observe ONLY a genuine new directive — never on RETRY (re-running the same text must not double-count the
    // shape, which would inflate the recurrence signal and let a true one-off wrongly fire the memory beat).
    if (!retry && isTask && !pending && typeof ProfileStore !== 'undefined') ProfileStore.observeMessage(text);
    if (!retry && isTask && !pending && typeof MintStore !== 'undefined') MintStore.observe(text);   // notice recurring jobs → propose minting them as one-tap missions
    // CORRECTION CAPTURE (slice 2): the first message to this agent after a short-of-the-mark verdict IS the
    // correction of that run — hand it to the held skill review in the Commander's words (final: fires now) and
    // stamp the new run as correctionOf so the runs ledger can relate them. One message per verdict; a stale
    // window (>10 min) is just a new task. Never on retry (the same text re-sent is not a second correction).
    let correctionOf = null;
    if (!retry && !pending && lastShortVerdict && (ws.agentId || 'agent') === lastShortVerdict.agentId && Date.now() - lastShortVerdict.at < CORRECTION_WINDOW_MS) {
      correctionOf = lastShortVerdict.runId; lastShortVerdict = null;
      postCorrection(correctionOf, text, true, 'message');
    }
    // SALIENCE (decision 3): has this task SHAPE recurred? Read AFTER observe so it counts this run (the read itself is
    // safe on retry — it doesn't mutate the count). Passed to the run so the server fires the memory turn-in on
    // recurring work even when a terse exchange otherwise wouldn't, while a basic one-off is left to reflect()'s floor.
    const recurring = !!(isTask && typeof MintStore !== 'undefined' && MintStore.recurringNow && MintStore.recurringNow(text));
    // VOICE: the speaker toggle (🔊) controls whether the agent SPEAKS its reply (and in the short,
    // spoken style — voiceModeRules appended below). It does NOT control the desk trip: the walk is driven
    // by REAL tool use (walkToDesk, below), so the speaker setting can't suppress it. When voice is on, a
    // task's result is also spoken — it's just no longer answered "on the spot" in place of the desk trip.
    // Direct conversations can speak as any agent. Background sessions must not interrupt
    // the conversation in view; a live call continues to own its explicitly bound session.
    const speechOwner = () => liveVoiceCall() ? liveVoiceOwns(ws) : Workstreams.activeId() === ws.id;
    const willSpeak = speechOwner()
      && typeof Voice !== 'undefined' && Voice.isOn && Voice.isOn();
    // REACTIVE DESK TRIP — the honest signal. We no longer pre-commit the walk on the classifier's GUESS:
    // every turn the agent first turns to face the Commander (listen), and it only gets up and walks to its
    // workstation the instant it ACTUALLY reaches for a tool (web / files / terminal) — see walkToDesk(),
    // fired from onToolCall / onPermission below. So a basic question, an opinion, or a one-word answer the
    // agent handles from its own knowledge NEVER runs to the PC; the desk trip now means "real tool-work is
    // happening", not "the Commander typed something". isTask still gates TOOL AVAILABILITY (so a genuine
    // task is never left tool-less) — it just no longer forces the walk. Voice/speaker state can't touch it.
    const turnAgentId = ws.agentId || 'agent';
    let walkedToDesk = false;
    function walkToDesk() {   // idempotent: the FIRST real tool action of the turn sends THIS agent to its station
      if (walkedToDesk) return; walkedToDesk = true;
      if (World.setActivityFor) World.setActivityFor(turnAgentId, 'task'); else World.setActivity('task');
      // TRUTHFUL TELEMETRY: 'working…' is only claimed once the sidecar has confirmed the run (runId set).
      // The eager isTask walk fires before that — the walk happens, but the status stays 'connecting…' until
      // agent.run.start lands (onRunId then upgrades it, honoring the task ruling: a confirmed task = working).
      if (typeof Channels !== 'undefined' && Channels.setStatus && Channels.runIdOf(ws.id)) Channels.setStatus(ws.id, 'working…');
      if (isActiveWs(ws)) syncStatus();
    }
    // turn to face the Commander and listen (no camera yank); a spoken CHAT also softly frames the agent.
    if (World.setActivityFor) World.setActivityFor(turnAgentId, 'talk'); else World.setActivity('talk');
    // A TASK ALWAYS WORKS AT THE WORKSTATION (Andrew's ruling, 2026-07-05, supersedes the reactive-only
    // rule): a turn the classifier reads as a task sends the agent to its desk IMMEDIATELY — even if the
    // model ends up answering without a tool. Pure chat still stays in place; walkToDesk stays idempotent
    // and still also fires on the first real tool call / permission prompt (covers a misclassified task).
    if (isTask) walkToDesk();
    if (!isTask && willSpeak && World.focusAgent) World.focusAgent({ soft: true });
    syncStatus();           // header reads the channel truth: 'connecting…' until the sidecar confirms the run
    ensureElapsedTimer();   // start the live wall-clock the instant the turn begins (before the first token)
    if (isActiveWs(ws)) startPresence(ws);   // COMMS-PREMIUM: pin the live working-presence card at the transcript bottom
    updateControls();       // reveal the ⏹ Stop control for this run
    // for a task the agent works at the computer (lit screen) and the result streams to this panel;
    // for talk it speaks the reply as a bubble in the room. The voice rule is appended LAST so it
    // wins on format; it's never baked into the saved prompt.
    const sys = system
      + (isTask ? ' If this needs real work — searching the web, reading or writing files, running a tool — do it and report the result clearly. If you can answer it directly from what you already know, just answer; don\'t reach for tools you don\'t need.' : '')
      + (willSpeak ? voiceModeRules() : '');

    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton) so the per-stream diff is real
    const ac = new AbortController();
    aborters.set(ws.id, ac);
    const callNames = {};   // callId -> tool name (the frozen agent.tool_result has no name field)
    const seenDeliv = {};   // title -> true (one openable row per produced file)
    let runToolsOk = 0, runDeliv = 0, thisRunId = null;   // per-run work tally → the "rate the work" beat's size + delivery gate
    let runStartedAt = 0;   // P3.2: this lead run's start wall-clock → the window claimCrew uses to attribute forwarded worker spend
    activeLiveRow = streamingAgent();
    let acc = '';
    // the model the SIDECAR reported for this run's usage — captured from the usage payload rather than
    // read off the agent's config, so the SESSIONS rail's INBOX receipt names what actually answered.
    // Last write wins: a run that hopped models is honestly labelled by the one that finished it.
    let ranModel = '';
    // VOICE STREAMING: when the agent will speak (🔊 on), hand each COMPLETE sentence to Voice as it
    // streams — so it starts talking while the rest is still generating, instead of after the whole reply
    // is done + synthesized. spokenIdx tracks how much of `acc` we've already queued.
    let spokenIdx = 0, finalReply = '', titleOk = false;
    let voiceQuestion = '';   // VOICE-AWARE CHOICES: the parsed FORK/TASK_QUESTION question — spoken naturally at reply end (options stay on-screen chips, never read aloud)
    let busyRefusal = null;   // race-time server mutex refusal: restore the directive instead of minting failed turns
    let goalJudgeReply = null;   // GOAL LOOP: set to the clean assistant reply when a turn should be judged; fired in finally
    // VOICE-AWARE CHOICES: never let TTS read the FORK:/TASK_QUESTION: choice markers (they render as
    // one-tap chips; spoken aloud they come out as "TASK QUESTION … pipe pipe …" + every option verbatim).
    // speakSafe truncates the spoken view at the first marker LINE, and holds back a still-streaming
    // partial prefix at the buffer tail ("TASK_QU…" hasn't matched yet but must not be flushed).
    const SPEAK_MARKER = /(^|\n)\s*(?:FORK|TASK_QUESTION)\s*:/i;
    const speakSafe = (s) => {
      const m = SPEAK_MARKER.exec(s);
      if (m) return s.slice(0, m.index);
      const nl = s.lastIndexOf('\n');
      const tail = s.slice(nl + 1).replace(/^\s+/, '').toUpperCase();
      if (tail && tail.length <= 14 && ('TASK_QUESTION:'.startsWith(tail) || 'FORK:'.startsWith(tail))) return s.slice(0, nl + 1);
      return s;
    };
    const speechToken = typeof Voice !== 'undefined' && Voice.replyToken ? Voice.replyToken() : undefined;
    const speechOpts = { replyToken: speechToken, agentId: ws.agentId };
    let speechTimer = null, speechPendingSince = 0;
    const pushSpeech = (finalize, finalText) => {
      clearTimeout(speechTimer); speechTimer = null;
      // Ownership is checked again for every chunk. A voice-commanded rebind can happen while an
      // older run is still streaming; none of its late words may leak into the new call owner.
      if (typeof Voice === 'undefined' || !willSpeak || !speechOwner() || !Voice.speakChunk) return;
      const src = speakSafe(finalize ? (finalText || acc) : acc);
      const pending = src.slice(spokenIdx);
      if (!pending) return;
      if (finalize) { if (pending.trim()) { Voice.speakChunk(pending, name, speechOpts); spokenIdx = src.length; } return; }
      if (!speechPendingSince) speechPendingSince = Date.now();
      let cut = -1;
      // Prefer complete sentences. A timer also flushes a substantial clause when token delivery stalls.
      const sentence = /[.!?…]+["')\]]?\s/g; let match;
      while ((match = sentence.exec(pending)) !== null) {
        const prefix = pending.slice(0, match.index + 1);
        if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$/i.test(prefix) || /\b[A-Z]\.$/.test(prefix)) continue;
        cut = sentence.lastIndex;
      }
      const remainingWait = 1200 - (Date.now() - speechPendingSince);
      if (cut < 0 && (remainingWait <= 0 || pending.length >= 700)) {
        const clause = /[,;:—–]\s/g;
        while ((match = clause.exec(pending)) !== null) { if (match.index >= 60) cut = clause.lastIndex; }
        if (cut < 0 && pending.length >= 100) cut = pending.lastIndexOf(' ');
      }
      if (cut < 1) {
        if (remainingWait > 0) speechTimer = setTimeout(() => pushSpeech(false), remainingWait);
        return;
      }
      const chunk = pending.slice(0, cut);
      if (chunk.trim()) { Voice.speakChunk(chunk, name, speechOpts); spokenIdx += cut; }
      speechPendingSince = 0;
      if (src.slice(spokenIdx).trim()) speechTimer = setTimeout(() => pushSpeech(false), 0);
    };
    try {
      const { text: reply, error, endReason, finishReason, completionVerdict, effectVerdict, budgetScope, budgetCapUsd } = await Harness.chat({
        system: sys, messages: historyWindow(ws), agentId: ws.agentId || 'agent', isTask, recurring, signal: ac.signal, streamId: ws.id,
        taskAction: taskAction || undefined,
        postconditions: opts && opts.postconditions != null ? opts.postconditions : undefined,
        recovery: recoveryResume ? opts.recovery : undefined,
        retryUserRunId: retry ? ((opts && opts.retryUserRunId) || (retryDirectiveTurn && retryDirectiveTurn.sourceRunId)) : undefined,
        connectorContinuationOf: opts && opts.connectorContinuationOf,
        recipeId: recipeId || undefined,   // provenance spine: the launching recipe rides to the durable run row (undefined for non-recipe runs)
        projectRoot: ws.projectRoot || undefined,   // project-anchored session: the sidecar injects the folder context ONLY if the root is still a standing blessed grant (truthful)
        placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(ws.agentId || 'agent') : [],   // THE MOAT: this run's TOOL reach = the agent's REAL placed props (dish→web · cabinet→files · workbench→terminal · …); compute is the freebie
        stationPlaced: (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [],   // Class Loadouts (shared-gear): station-wide gear for SKILL availability — a desk-only specialist still gets its class skills when the STATION has the gear (tools stay room-scoped via `placed`)
        onRunId: id => { retirePriorRatings(ws.id); thisRunId = id; if (retryDirectiveTurn && !retryDirectiveTurn.sourceRunId) retryDirectiveTurn.sourceRunId = id; if (starterId) StarterStore.started(starterId, id); runStartedAt = Date.now(); try { RUN_META.set(id, { streamId: ws.id, focusVersion: runFocusVersion, isTask: !!isTask, title: (ws && ws.title) || '', directive: String(text || ''), correctionOf: correctionOf, intentOfferText: intentOfferText, fromRecipe: fromRecipe, recipeId: recipeId, agentId: ws.agentId || 'agent', rec: recClaimRun(id, ws.agentId || 'agent') }); if (RUN_META.size > 60) RUN_META.delete(RUN_META.keys().next().value); } catch (_) {} Channels.setRunId(ws.id, id, Date.now()); if (walkedToDesk && Channels.setStatus) Channels.setStatus(ws.id, 'working…'); if (isActiveWs(ws)) { syncStatus(); renderPresence(); } if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onTerminalReset: () => { clearTimeout(speechTimer); speechTimer = null; speechPendingSince = 0; acc = ''; spokenIdx = 0; Channels.setAcc(ws.id, ''); },
        onUsage: (u) => { if (u && u.model) ranModel = u.model; App.refreshUsage(); },
        // COMMS-PREMIUM: the Channels store still records the pre-formatted STRING (replay/switch-survival is
        // unchanged — replayChannel renders those via toolLine), but the LIVE surface renders a structured CHIP.
        // breakLive() closes the prose paragraph AND the prior chip rail only when it's a *call after prose*; a
        // run of consecutive calls shares one rail because onToolResult below never breaks it.
        // NOTE (truthful telemetry, audit 0.4): this callback RENDERS only — it must NOT re-emit agent.tool_call.
        // harness.js already emits the AUTHORITATIVE agent.tool_call onto U.bus for EVERY hero tool step (the full
        // frozen shape { agentId, runId, callId, name, argsSummary }) before invoking this onToolCall. A synthetic
        // copy here double-counted worksignalstore's EWMA (recruiter signal) + printed duplicate ticker lines, and
        // its name-only `{ name }` variant was schema-invalid. The world/worksignal/quest listeners consume the
        // harness emit; this handler owns the transcript chips + desk walk + presence only.
        onToolCall: ev => { callNames[ev.callId] = ev.name; Channels.addToolCall(ws.id, { callId: ev.callId, name: ev.name, argsSummary: ev.argsSummary }); walkToDesk(); presenceToolCall(ws, ev.name); if (skillFlavor(ev)) recentInRunSkill = Date.now(); if (isActiveWs(ws)) { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); toolChip(ev); } },
        // Re-emit the hero's tool RESULT onto U.bus so the world's per-prop capability surge fires on the REAL
        // outcome. (The station SSE tee DOES carry tool_result now, but outcome-only and without `summary` —
        // sse.js:runTeeView — so the in-band stream stays the richest source for the page that started the run.)
        // callId joins it to its tool_call; isError drives the success-vs-failure surge. `summary`/`ms` ride
        // along per the frozen event shape so any consumer sees the result's own words, never a bare 'error'.
        onToolResult: ev => { if (!ev.isError) runToolsOk++; const nm = callNames[ev.callId] || 'tool'; Channels.addToolResult(ws.id, { callId: ev.callId, name: nm, summary: ev.summary, isError: ev.isError, ms: ev.ms }); presenceToolResult(ws); if (isActiveWs(ws)) resolveChip(ev, nm); if (typeof U !== 'undefined' && U.bus && ev.callId) U.bus.emit('agent.tool_result', { name: nm, agentId: ws.agentId, runId: ev.runId, callId: ev.callId, ok: !ev.isError, isError: !!ev.isError, summary: ev.summary, ms: ev.ms }); },   // runId rides along: a runId-less copy reset xp.js's per-run buffer (freshRun(undefined)) and wiped buffered memory-reuse credit
        onDeliverable: ev => {
          // Any produced file is an openable product (image_generate emits kind:'image', fs.write emits
          // kind:'file'). How we RENDER it is decided client-side from the EXTENSION (the reference harness's model), not
          // from the backend's kind — so a .mp4/.webm the agent writes becomes an inline player and a .png a
          // thumbnail, with no backend change. Unknown extensions fall back to the plain clickable row.
          if ((ev.kind === 'file' || ev.kind === 'image') && !seenDeliv[ev.title]) {
            seenDeliv[ev.title] = true; runDeliv++;
            const mk = mediaKindOf(ev.title);
            if (isActiveWs(ws)) {
              breakLive();
              if (mk === 'image') imageDeliverableLine(ev.title, ev.agentId);
              else if (mk === 'video' || mk === 'audio') mediaPlayerLine(ev.title, ev.agentId, mk);
              else deliverableLine(ev.title, ev.agentId);
              noteShownDeliverable(Channels.runIdOf(ws.id), ev.title);
            }
            // the frozen 'deliverable' event carries no runId/time — synthesize from the live run + clock.
            // record the rendered media kind so a future history/replay surface can re-render the same way.
            if (typeof Workstreams !== 'undefined') Workstreams.recordDeliverable(ws.id, { title: ev.title, kind: mk === 'file' ? ev.kind : mk, runId: Channels.runIdOf(ws.id), t: Date.now() });
            // POST-RUN DEDUPE: the recap card is the single artifact ledger. When the deliverable is ALREADY
            // visible in the on-screen transcript (inline row above + recap card below), the toast is a third
            // copy that also parks over the composer — suppress it. A BACKGROUND-stream deliverable isn't shown
            // anywhere on screen, so its toast is the only signal → keep it.
            if (!isActiveWs(ws) && typeof StationUI !== 'undefined') StationUI.notify((mk === 'file' ? 'saved ' : 'made ') + ev.title, 'gold', 'runComplete');   // P1-8 category: run produced a deliverable
          }
        },
        // EL-11: EVERY prompt now reaches a human surface — the active stream renders the inline consent card;
        // a background stream fires the global clickable toast + rail marker (backgroundPermissionNotify). Both
        // paths then ACK the sidecar (consentAck) that the prompt is human-visible, earning the paused run its
        // one bounded extension of the fail-closed auto-deny timer.
        onPermission: ev => { Channels.setPending(ws.id, { promptId: ev.promptId, agentId: ev.agentId || ws.agentId, tool: ev.tool, argsSummary: ev.argsSummary, runId: Channels.runIdOf(ws.id) }, Date.now()); walkToDesk(); if (isActiveWs(ws)) { breakLive(); permissionRow(ev, ws); renderPresence(); } else { backgroundPermissionNotify(ev, ws); } try { Promise.resolve(Harness.consentAck(Channels.runIdOf(ws.id), ev.promptId)).then(v => { if (!(v && v.ok)) consentAckFailed(ws, ev, v); }, e => consentAckFailed(ws, ev, { ok: false, error: (e && e.message) || String(e) })); } catch (e) { consentAckFailed(ws, ev, { ok: false, error: (e && e.message) || String(e) }); } },
        // the lead's team.summon tool asked the station to create a worker: run the REAL summon (App.summonForRequest
        // → the Recruitment Bay's own summonAgent), then ack with the new id so the lead can delegate to it. The id
        // resolves only after the roster POST lands (App awaits it), so the lead's next team.dispatch finds the worker.
        onSummon: ev => {
          const rid = Channels.runIdOf(ws.id);
          Promise.resolve((typeof App !== 'undefined' && App.summonForRequest) ? App.summonForRequest(ev) : null)
            // summonForRequest resolves { agentId, desk } — desk = where the new worker's seeded workstation
            // landed (blank if none). A legacy plain-id resolution still acks correctly.
            .then(r => { const o = (r && typeof r === 'object') ? r : { agentId: r || null, desk: '' }; return Harness.summonAck(rid, ev.requestId, o.agentId, o.desk); })
            .catch(() => Harness.summonAck(rid, ev.requestId, null));
        }
      });
      if (error) {
        // PLAIN-LANGUAGE: lead with the beginner-facing message, keep the raw error as a dim sub-line; persist
        // the friendly text (not the plumbing) so a switch-back / replay shows the same readable failure.
        // engineAlive:true is PROVEN, not assumed: `error` is IN-BAND, so the sidecar composed and streamed it —
        // it was alive serving this request. Matters because a forwarded upstream stream failure reads as
        // `terminated`/`premature close`, so this path used to tell healthy users to restart. (2026-07-29)
        const v =(typeof Friendly !== 'undefined') ? Friendly.friendlyError(error, null, { engineAlive: true }) : { userMessage: error, retryable: true, action: null, raw: error };
        // A mutex race can still happen after the local preflight. The sidecar is authoritative, but this is an
        // availability state — not an assistant turn. Undo the optimistic user row, restore its directive to the
        // composer, and let the existing run remain the only durable conversation activity.
        if (v.kind === 'agent_busy') {
          busyRefusal = v.userMessage;
          if (!retry) {
            const last = ws.history[ws.history.length - 1];
            if (last && last.role === 'user' && last.content === text) ws.history.pop();
            if (isActiveWs(ws) && input) { input.value = text; autoGrowInput(); }
          }
        } else {
        // A network-kind failure means this response stream died. The durable journal—not this transport error—
        // decides whether the task resumes safely or pauses for mutation review after the sidecar reconnects.
        if (v.kind === 'network' && thisRunId) { interruptedStreams.add(ws.id); armReconnectWatch(); }
        persistPartial(ws, acc);
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + v.userMessage, error: true, ts: Date.now() });   // so the failure survives a switch-back, not just a transient notify
        // the run DIED in flight — settle its outcome (task-board truth: a dead run can never wear the DONE
        // chip). Guarded on thisRunId: no run started → nothing was filed, nothing to settle.
        if (thisRunId && typeof Workstreams !== 'undefined' && Workstreams.noteRunEnd) Workstreams.noteRunEnd(ws.id, thisRunId, false);
        if (typeof StationUI !== 'undefined') StationUI.notify(brief(v.userMessage), 'warn');
        if (isActiveWs(ws)) resolvePresence(ws, { error: true });   // COMMS-PREMIUM: presence card resolves red
        if (isActiveWs(ws)) offerRetry(v);   // RETRY: context-aware recovery chip (retry / Settings / SKILLS / none)
        }
      } else {
        // the run COMPLETED (cleanly, or via a stop / cut-short — either way the stream did not die):
        // settle the outcome so the board's DONE chip is anchored to a real finished run.
        if (thisRunId && typeof Workstreams !== 'undefined' && Workstreams.noteRunEnd) Workstreams.noteRunEnd(ws.id, thisRunId, true);
        let replyText = reply || acc;
        const taskQuestion = (isTask && typeof TaskIntent !== 'undefined' && TaskIntent.parse) ? TaskIntent.parse(replyText) : null;
        if (taskQuestion) {
          if (thisRunId) {
            clarificationRuns.add(thisRunId);
            if (clarificationRuns.size > 60) clarificationRuns.delete(clarificationRuns.values().next().value);
          }
          replyText = TaskIntent.strip(replyText);
          if (taskQuestion.question) voiceQuestion = taskQuestion.question;   // spoken (question only, no options) at reply end
          if (isActiveWs(ws) && activeLiveRow && activeLiveRow.cleanTaskIntent) activeLiveRow.cleanTaskIntent();
        }
        finalReply = replyText;
        titleOk = !!replyText.trim();   // a real, non-empty reply landed → this stream is eligible for a summary title
        if (replyText.trim()) ws.history.push({ role: 'assistant', content: replyText, ts: Date.now() });   // never persist an empty turn
        // Lane 5 (truthful telemetry): a reply the PROVIDER cut off — finishReason 'length' (hit max_tokens
        // mid-thought) or 'content_filter' (output filtered) — is an AMPUTATED turn even though endReason==='done'.
        // It must NOT ship a "◈ delivered" crate / XP / workitem.delivered as if it were complete. Treat it like a
        // non-clean stop for the delivery decision (but keep the partial text above — it's real, just incomplete).
        const cutShort = finishReason === 'length' || finishReason === 'content_filter';
        const postconditionUnmet = !!(opts && opts.postconditions != null && completionVerdict !== 'completed_verified');
        // GOAL LOOP: a clean turn (done / no endReason) with a real reply is judgeable. A max_iters/budget/refusal
        // stop — or a provider-truncated reply — is NOT — the agent didn't get to finish its thought, so re-judging
        // would be premature. The judge runs in the finally (after teardown) so it never delays this turn's unwind.
        if (!taskQuestion && (!endReason || endReason === 'done') && !cutShort && !postconditionUnmet && replyText.trim() && typeof GoalLoop !== 'undefined' && goalOf(ws)) goalJudgeReply = replyText;
        // the stop-reason is part of the WORK log → close the live paragraph, then drop it in chronologically.
        if (endReason && endReason !== 'done' && endReason !== 'clarifying' && !taskQuestion) {
          // NO ECHO OF THE HEADLINE (2026-07-27): resolvePresence already prints "■ RUN STOPPED" for every one
          // of these reasons, so a work-log line that only says "stopped" restated the card verbatim one row
          // below it. Emit this line only when it carries something the card can't: what to do next (step limit,
          // budget door) or a reason the label doesn't name. Your own interrupt → the card alone tells the truth.
          const stopLine = endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? budgetStopLine(budgetScope, budgetCapUsd)
            : endReason === 'cancelled' ? (interrupted.has(ws.id) ? '' : 'run cancelled')
            : 'stopped (' + endReason + ')';
          if (isActiveWs(ws)) { breakLive(); if (stopLine) toolLine('⏹ ' + stopLine); }
          markStoppedTurn(ws, replyText);
          // a budget stop's honest door is the BUDGET settings section, not a doomed retry (the same cap fires
          // again immediately); every other stop keeps the plain retry chip.
          if (isActiveWs(ws)) { if (endReason === 'budget') offerBudgetDoor(); else offerTryAgain(); }
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        } else if (cutShort) {
          // distinct honest "cut short" recap: the reply is truncated/filtered, not a clean delivery.
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (finishReason === 'content_filter'
            ? 'reply cut short — the model\'s output was filtered'
            : 'reply cut short — hit the response length limit; say "continue" for the rest'));
          if (typeof StationUI !== 'undefined') StationUI.notify('reply cut short: ' + finishReason, 'warn');
        } else if (postconditionUnmet) {
          if (isActiveWs(ws)) breakLive(), toolLine('⚠ completion was not proven — typed postconditions returned ' + (completionVerdict || 'not_assessed') + ' (' + (effectVerdict || 'no effect evidence') + ')');
          if (typeof StationUI !== 'undefined') StationUI.notify('completion needs verification', 'warn');
        }
        // a CLEAN end that hit an unwired connector mid-run: the reply already says "not connected" — the chip is
        // the door. Only on a clean end: a stopped run owns the slot with its retry/budget chip above.
        if (!taskQuestion && (!endReason || endReason === 'done')) offerConnectorDoor(thisRunId, ws);
        // GOLDEN-RUN DRIFT (2026-08-22): a recipe-launched run is compared by the sidecar against that recipe's own
        // good history; a drifted run is a failure class, so it earns the bell ONCE (keyed by the run). The durable
        // row lands a beat after run end, so the read waits; it is advisory and never blocks the turn.
        if (opts && opts.recipeId && typeof StationUI !== 'undefined') {
          const rid = String(opts.recipeId);
          setTimeout(() => {
            fetch('/api/recipes/drift?recipeId=' + encodeURIComponent(rid), { cache: 'no-store' })
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                const drift = d && d.drift;
                if (!drift || drift.status !== 'drift' || !drift.latestRunId) return;
                let seen = []; try { seen = JSON.parse(localStorage.getItem('starnet.recipeDrift.notified') || '[]'); } catch (_) { seen = []; }
                if (seen.indexOf(drift.latestRunId) >= 0) return;
                seen.push(drift.latestRunId); try { localStorage.setItem('starnet.recipeDrift.notified', JSON.stringify(seen.slice(-50))); } catch (_) {}
                const name = (typeof Recipes !== 'undefined' && Recipes.get && Recipes.get(rid)) ? Recipes.get(rid).name : rid;
                const first = drift.signals[0];
                StationUI.notify('⚠ recipe drift: ' + name + ' — ' + (first ? first.detail : 'this run differs from its last ' + drift.baselineRuns), 'bad');
              })
              .catch(() => {});
          }, 1500);
        }
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        if (isActiveWs(ws) && taskQuestion) presentTaskQuestion(ws, taskQuestion);   // enriches with the stored recommendation, then renders
        // Belt-and-braces (live-caught 2026-07-16): a run can end 'clarifying' with the marker unparseable
        // client-side (e.g. a malformed/glued reply line) while the DURABLE brief holds the real validated
        // question — re-present from the store so the Commander is never left with a question-less pause.
        else if (isActiveWs(ws) && endReason === 'clarifying') restoreTaskQuestion(ws);
        // R1 MID-TASK FORK: the agent may have ended this reply with one FORK marker (earned only while the
        // style model's confidence is low — the directive isn't even in the prompt otherwise). Render the
        // one-tap chips at the run boundary; a malformed marker parses null and stays plain text.
        if (isActiveWs(ws) && replyText && typeof Fork !== 'undefined' && Fork.parse) {
          const fk = Fork.parse(replyText);
          if (fk) { offerFork(fk); if (!voiceQuestion && fk.question) voiceQuestion = fk.question; }
        }
        /* THE WORK LINE. This dock has answered; if the Commander drew stages past it, run them now — still
           INSIDE the run's try, so the stream stays busy and Stop/E-STOP reach the whole line rather than a
           transcript that goes quiet while three more agents keep spending. Gated on a real TASK directive
           (the belt is work-only — "hello" never rides), on a clean finish, and never on a run that ended by
           ASKING something: a question is the turn's answer, and handing it downstream would answer it on the
           Commander's behalf. finalReply is re-pointed at the line's last stage so voice speaks, and the
           session titles from, the answer that actually leaves.

           AND — WORK BELONGS TO A LINE (Andrew's ruling, 2026-08-07): "each conveyor system built has a
           purpose and a different workflow — the conveyor system should visually run ONLY when the specific
           workflow is running." A COMMS directive is a DIRECT ORDER handed to an agent in person; it did not
           arrive through any line's trigger, so it is TERMINAL at the dock that answers it — no downstream
           stage runs, nothing is spent past this agent, and the floor draws no handoff. `wsLineOrigin` is
           the origin line a turn entered on: today only line-triggered work carries one, and every such
           trigger (a channel message routed down the belts, a routine, the sample job, a crate at an INBOX)
           runs its line INSIDE the sidecar, where the origin is provable. The sidecar applies the identical
           gate on the compiled plan, so this surface cannot disagree with that one. */
        const wsLineOrigin = (opts && opts.lineId) ? String(opts.lineId) : null;
        if (wsLineOrigin && isTask && !taskQuestion && !cutShort && !postconditionUnmet && (!endReason || endReason === 'done') && replyText.trim()) {
          const line = await runWorkLine(ws, { fromAgentId: turnAgentId, text: replyText, originalText: text, signal: ac.signal, lineId: wsLineOrigin });
          if (line.hops) { finalReply = line.text; replyText = line.text; titleOk = !!line.text.trim(); }
        }
        // a talk reply shows as a room bubble; the spoken reply itself is STREAMED sentence-by-sentence as
        // it arrives (onToken → pushSpeech) and flushed in the finally.
        if (!isTask && isActiveWs(ws)) World.say(replyText);
        // SHIPPED (P1): a clean finish delivers the work-item → the ONE outbound product crate + the weight-3
        // profile/XP ship-signal + the "tasks shipped" milestone. Only on done/undefined — a max_iters/budget/
        // error/refusal stop is an unproductive run (the agent.run.end SLAG path owns that); abort/hard-error never
        // reach this branch. (Not gated on isActiveWs: a background stream's work still ships.)
        if (wiPlaced && !taskQuestion && (!endReason || endReason === 'done') && !cutShort && !postconditionUnmet) wiEmit('workitem.delivered', { workitemId: wiId, finalQueueId: 'outbox', agentId: wiAid, box: '', ms: Date.now() - wiPlacedTs, ts: Date.now() });
        // stash this run's REAL work so the post-run "rate the work" beat can size the XP honestly + gate on real work.
        // Lane 5: a cut-short run (provider truncated/filtered) is NOT rateable work — leaving no runWork stash makes
        // maybeStandaloneRate return 'never', so no XP is ever minted for an amputated reply. runCost is still computed
        // for the honest presence/recap readout.
        let runCost = 0;
        if (thisRunId) { runCost = Math.max(0, (Harness.totals().cost || 0) - (before.cost || 0)); if (!cutShort && !taskQuestion && !postconditionUnmet) { runWork.set(thisRunId, { toolsOk: runToolsOk, delivered: runDeliv, cost: runCost, agentId: ws.agentId || 'agent' }); if (runWork.size > 60) runWork.delete(runWork.keys().next().value); } }
        // P3.2 — CLAIM this lead run's dispatched crew (workers whose forwarded run.end fell inside its live window)
        // so a 👍 verdict can split its XP mint honestly. A run that dispatched no crew records nothing (empty list),
        // and the split falls back to lead-only — no fabricated attribution. Only a HERO lead run has crew to claim.
        if (thisRunId && (ws.agentId || 'agent') === 'agent') { const crew = claimCrew(runStartedAt); if (crew.length) { runCrew.set(thisRunId, crew); if (runCrew.size > 60) runCrew.delete(runCrew.keys().next().value); } }
        // COMMS-PREMIUM: resolve the presence card into a compact summary. steps = real successful tool rounds,
        // cost = this run's REAL usd delta — both truthful (shown only when > 0), never fabricated.
        if (isActiveWs(ws)) resolvePresence(ws, { endReason: taskQuestion ? 'done' : endReason, cutShort: cutShort, verificationRequired: postconditionUnmet, steps: runToolsOk, cost: runCost });
        // WORK VISIBILITY: a passive recap of what this run PRODUCED, fetched from the run's recorded
        // artifacts ledger. A report, not an ask — it never claims the post-run beat slot. Fire-and-forget.
        // DURATION HONESTY (2026-07-19): the recap's "RUN COMPLETE · M:SS" reads Channels.elapsedOf — the
        // same confirmed-start, approval-pauses-excluded clock the live COMMS timer shows — never the raw
        // send-click→teardown span (which silently counted connect latency + time paused waiting on YOU).
        // Read before the finally's Channels.end tears the channel down; 0/absent → the old span fallback.
        if (thisRunId) {
          const honestMs = (typeof Channels !== 'undefined' && Channels.elapsedOf) ? Channels.elapsedOf(ws.id, Date.now()) : 0;
          renderRunRecap(ws, thisRunId, honestMs > 0 ? honestMs : (Date.now() - wiPlacedTs));
        }
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
      const stopped = interrupted.has(ws.id);   // the Commander pressed Stop on THIS stream — a graceful interrupt, not a fault
      if (stopped) {
        // keep whatever already streamed, mark it stopped, and log NO error (the stop was intentional).
        // No toolLine (2026-07-27): resolvePresence already prints "■ RUN STOPPED · …" — `⏹ stopped` echoed it.
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.done(); resolvePresence(ws, { stopped: true, steps: runToolsOk }); }
        markStoppedTurn(ws, acc);
        if (isActiveWs(ws)) offerTryAgain();
        if (!isTask && isActiveWs(ws) && acc.trim()) World.say(acc);
      } else {
        // A throw that is NOT a deliberate Stop: an unexpected disconnect or a hard fetch/network error. Persist
        // whatever streamed FIRST — before the await below (ordering locked by test/comms-presence.test.js).
        // NEVER synthesize 'cannot reach the STARNET sidecar' here again (2026-07-29): it forced the "restart the
        // app" copy onto every abort, including a dead PROVIDER stream on a healthy install. Say only what we
        // witnessed and let Harness.pingEngine measure the rest — full rationale in harness.js + friendlyerror.js.
        persistPartial(ws, acc);
        let engineAlive = null;
        if (typeof Harness !== 'undefined' && Harness.pingEngine) {
          try { engineAlive = await Harness.pingEngine(); } catch (_) { engineAlive = null; }
        }
        const v = (typeof Friendly !== 'undefined')
          ? Friendly.friendlyError(aborted ? new Error('connection dropped mid-reply') : e, null, { engineAlive: engineAlive })
          : { userMessage: aborted ? 'Lost the connection — try again.' : (e.message || String(e)), retryable: true, action: null, raw: (e && e.message) || String(e) };
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); resolvePresence(ws, { error: true }); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + v.userMessage, error: true, ts: Date.now() });   // keep a readable trace of the failure
        if (isActiveWs(ws)) offerRetry(v);   // RETRY: context-aware recovery chip (a dropped connection is retryable)
      }
      // a THROWN teardown (abort/cancel/disconnect/network drop) means agent.run.end was LOST on the bus, so the
      // crew HUD would stick at WORKING — clear this run's count here. Normal + in-band-error completions deliver
      // run.end (decremented by the bus listener), so we must NOT clear there or a concurrent sibling under-counts.
      if (typeof StationUI !== 'undefined' && StationUI.clearRunning) StationUI.clearRunning(ws.agentId || 'agent');
    } finally {
      aborters.delete(ws.id);
      interrupted.delete(ws.id);   // consume the stop flag (whether or not it fired)
      Channels.end(ws.id);
      // P1: drain this directive from the QUEUE gauge on ANY teardown (shipped, in-band error, or abort) —
      // the backlog is "runs in flight", independent of whether the work shipped.
      if (wiPlaced) { const depth = wiBump(wiAid, -1); wiEmit('queue.status', { queueId: wiAid, depth: depth, maxCapacity: 64, nextAdvanceAt: 0 }); }
      if (isActiveWs(ws)) {
        activeLiveRow = null;
        if (busyRefusal) { load(ws); renderAgentBusy(busyPeerFor(ws), busyRefusal); }
        else syncStatus();
      }
      // after a turn: in a hands-free voice conversation keep him facing you (one-on-one, no wandering off
      // between turns); otherwise he stands up and goes back to idle. Only steer the world if THIS finished
      // stream is the one on screen — a background stream finishing must not move the view.
      const stayFacing = typeof Voice !== 'undefined' && Voice.inVoiceMode && Voice.inVoiceMode();
      // OVERLAP GUARD (the black-screen fix): this stream's run is over, but the SAME agent may still be
      // working another live run (a scheduled routine, a channel run, another workstream). Extinguishing the
      // pose then darkens the workstation screens of an agent that is provably still working. dropRun retires
      // THIS run from World's refcount (idempotent — the bus run.end usually already did; an aborted stream's
      // run.end was LOST so this is its cleanup) and the pose is only released when NO run remains live.
      const othersLive = (World.dropRun && World.agentRunsLive)
        ? (World.dropRun(ws.agentId || 'agent', thisRunId), World.agentRunsLive(ws.agentId || 'agent') > 0) : false;
      // a summoned crew body extinguishes the moment its LAST live run ends — even if it finished off-screen
      // (a background crew run must stop "working").
      if ((ws.agentId || 'agent') !== 'agent') { if (!othersLive && World.setActivityFor) World.setActivityFor(ws.agentId, 'idle'); }
      else if (othersLive) { /* the hero is still mid-run elsewhere — leave the working pose alone (work wins) */ }
      else {
        // HERO: split the two concerns the old single gate conflated. (1) POSE — a hero run that finished in a
        // BACKGROUND workstream must ALSO stop "working" (the tick tears it out of the desk pose the instant
        // activity flips off 'task'); setActivity('idle') does that WITHOUT touching the camera. (2) VIEW — only
        // steer the world (voice-facing talk pose + soft focus) when THIS finished stream is the one on screen,
        // so a background run finishing never moves the camera. (Lane 5 truth-run-lifecycle: was gated entirely on
        // isActiveWs, leaving a background hero run stuck in the working pose forever.)
        if (isActiveWs(ws)) { World.setActivity(stayFacing ? 'talk' : 'idle'); if (stayFacing && World.focusAgent) World.focusAgent({ soft: true }); }
        else World.setActivity('idle');
      }
      // D1 WARMTH: a run for the on-screen stream just ended → the focused agent returns to the chat-stare per the
      // D1 loop; re-warm so the stare holds for a fresh window after it answers (the "watch you type ↔ work the
      // answer" beat), instead of the reply-run wall-clock counting against warmth. Only the visible stream re-warms.
      if (isActiveWs(ws)) warmChat();
      // fold this run's REAL usage delta into the origin stream's per-conversation cost — no double-count:
      // the same deltas already minted the lifetime total inside Harness.
      if (typeof Workstreams !== 'undefined') {
        const a = Harness.totals();
        Workstreams.addCost(ws.id, { tokens: a.tokens - before.tokens, usd: a.cost - before.cost, calls: a.calls - before.calls });
        // file the measured model alongside the measured spend — same truthful-telemetry path. noteModel
        // refuses an empty value, so a run whose usage omitted the field leaves the prior reading intact.
        if (Workstreams.noteModel) Workstreams.noteModel(ws.id, ranModel);
        Workstreams.touch(ws.id);
      }
      App.refreshUsage();
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      capHistory(ws);   // E3: bound the stored thread AFTER this turn's assistant reply landed, before it persists
      if (onTurn) onTurn();
      // TITLE UPGRADE: replace the instant first-sentence placeholder with a model-written summary. Quiet
      // (internal call, off the floor/telemetry) and fire-and-forget so it never delays this turn's teardown.
      // Not first-turn-only: a stream still wearing its machine placeholder (first attempt hiccuped, or the
      // session was saved by a pre-upgrade build) retries on this completed turn (needsModelTitle gates it).
      if (titleOk && (firstTurn || (typeof Workstreams !== 'undefined' && Workstreams.needsModelTitle && Workstreams.needsModelTitle(ws.id)))) maybeRetitle(ws, text, finalReply);
      // flush any trailing spoken text and CLOSE the speech stream — the last chunk's end re-arms the
      // hands-free mic (this is the heartbeat for spoken turns; onTurnEnd covers silent/no-speech turns).
      clearTimeout(speechTimer); speechTimer = null;
      if (willSpeak && speechOwner() && typeof Voice !== 'undefined' && Voice.endReply) {
        pushSpeech(true, finalReply);
        // VOICE-AWARE CHOICES: the choice itself is spoken as a natural question — question text only;
        // the 2-3 options are on-screen chips (reading them out was the "reads every option" glitch).
        if (voiceQuestion && Voice.speakChunk) Voice.speakChunk('Quick question. ' + voiceQuestion, name, speechOpts);
        Voice.endReply();
      }
      // hands-free voice mode: the run is done — let Voice re-open the mic for the next turn.
      if ((!liveVoiceCall() || liveVoiceOwns(ws)) && typeof Voice !== 'undefined' && Voice.onTurnEnd) Voice.onTurnEnd();
      // TYPE-AHEAD: the stream just freed — send its next queued follow-up (after this call fully unwinds).
      setTimeout(() => flushQueued(ws.id), 0);
      // GOAL LOOP: after the teardown, judge this turn against the standing goal and maybe fire the next continuation.
      // A QUEUED user follow-up wins first — it's the human steering, so let it drain (it will preempt/pause the loop
      // when IT is judged as a non-continuation). Only judge when nothing is queued. Deferred (setTimeout) so it runs
      // after this call fully unwinds and after flushQueued, and re-checks busy/blocked inside judgeGoalTurn/kickGoal.
      const hasQueued = (queued.get(ws.id) || []).length > 0;
      if (typeof GoalLoop !== 'undefined' && goalOf(ws) && !hasQueued) {
        const reply = goalJudgeReply, wasCont = goalContinuation;
        if (wasCont || goalActiveAtStart) {
          // a continuation turn → judge it; a REAL user turn that ran while the loop was already active → preempt.
          setTimeout(() => { judgeGoalTurn(ws, reply, wasCont); }, 0);
        } else {
          // the loop was SET during this very turn (/goal <text> while the stream was busy): this turn isn't a
          // preemption — it's the turn that triggered the loop. Kick the first continuation now the stream freed.
          setTimeout(() => { kickGoal(ws); }, 0);
        }
      }
    }
  }

  /* QUIET TITLE SUMMARY — one tiny internal model call (no tools, suppressed from the floor + telemetry exactly
     like the pitch/suggest self-talk: internal:true drops its run.start/run.end so it never counts as a delivered
     task, walks a sprite, or earns XP) that turns a stream's substantive messages into a 3-6 word title. Best-effort:
     any failure or an unparseable reply silently leaves the instant first-sentence placeholder in place. The tiny
     usage delta is folded into THIS stream's per-conversation cost so the telemetry stays truthful. */
  async function maybeRetitle(ws, userText, replyText) {
    if (typeof Harness === 'undefined' || typeof Workstreams === 'undefined' || !ws) return;
    const cur = Workstreams.get(ws.id);
    if (!cur || cur.titleAuto === false || ws.id === Workstreams.generalId()) return;   // never stomp a manual rename / title General
    const sys = 'You generate a terse title for a work session. Reply with ONLY a 3 to 6 word title that names'
      + ' the concrete task or topic in the messages — never the greetings around it. Use Title Case. No'
      + ' surrounding quotes, no trailing punctuation, no preamble — output the title and nothing else.';
    // summarize what the session actually IS: a digest of its SUBSTANTIVE user messages (founding directive
    // + latest turns; small-talk filler skipped). null = the session holds no substance yet — spend NO model
    // call and keep the honest placeholder ("hey") instead of minting a "Casual Greeting Exchange" that a
    // session opened with small talk would otherwise wear forever. needsModelTitle keeps such a stream
    // eligible, so the upgrade simply waits for the first turn with real content.
    const basis = (Workstreams.titleBasis ? Workstreams.titleBasis(ws.id, userText) : null);
    if (basis == null) return;
    const prompt = basis
      + (replyText ? ('\n\nAssistant reply (context only): ' + String(replyText).replace(/\s+/g, ' ').slice(0, 200)) : '');
    if (!prompt.trim()) return;
    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton)
    let res;
    try {
      res = await Harness.chat({ system: sys, messages: [{ role: 'user', content: prompt }], agentId: ws.agentId || 'agent', isTask: false, placed: [], internal: true });
    } catch (_) { return; }   // network/hiccup → keep the placeholder, no noise
    // fold the quiet call's REAL usage into the origin stream (same truthful-telemetry path as a normal turn)
    try { const a = Harness.totals(); Workstreams.addCost(ws.id, { tokens: a.tokens - before.tokens, usd: a.cost - before.cost, calls: a.calls - before.calls }); } catch (_) {}
    if (!res || res.error) return;
    const t = cleanTitle(res.text);
    // strong: this title was written from substantive content — the auto-title ladder ends here
    if (t && Workstreams.retitle(ws.id, t, true)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      if (onTurn) onTurn();   // persist the upgraded title
    }
  }
  /* scrub a model title reply to a clean short label: first non-empty line, strip wrapping quotes/asterisks, drop
     trailing punctuation, collapse whitespace, length-cap, and reject an obvious non-title (a refusal or a whole
     sentence) so a bad reply leaves the placeholder rather than writing garbage into the rail. */
  function cleanTitle(raw) {
    let t = String(raw == null ? '' : raw).trim();
    if (!t) return '';
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();    // a reasoning model's leaked think block is never the title
    t = (t.split(/\r?\n/).find(l => l.trim()) || '').trim();   // first non-empty line only
    t = t.replace(/^#+\s*/, '').replace(/^title\s*[:\-—]\s*/i, '');   // drop a markdown heading / "Title:" label wrapper
    t = t.replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/[\s.:;,—–-]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 64) return '';                        // empty or a paragraph came back → keep placeholder
    if (/\b(sorry|cannot|can't|unable|as an ai|here(?:'s| is)|i (?:can|am|will|would))\b/i.test(t)) return '';   // refusal / chatty
    return t;
  }

  /* DISCONNECT (or any teardown) cancels the in-flight billable run: abort the fetch (the sidecar's
     req.on('close') then stops the loop) AND tell the sidecar to kill the run by id — belt-and-suspenders. */
  function abort() {
    if (typeof Voice !== 'undefined' && Voice.stopConvo) Voice.stopConvo();   // drop hands-free on disconnect
    // teardown is a DELIBERATE interrupt, not a dropped connection: flag every in-flight stream interrupted BEFORE
    // aborting so send()'s catch reads `stopped` and stays silent — otherwise the AbortError gets reclassified as a
    // network fault and a spurious "can't reach the sidecar" row is pushed into ws.history + persisted. (A reader
    // that aborts WITHOUT going through here = a genuine dropped connection → still a network error + retry.)
    for (const id of aborters.keys()) interrupted.add(id);
    // cancel EVERY in-flight run (not just one global): abort each fetch + tell the sidecar to kill the run by id
    for (const ac of aborters.values()) { try { ac.abort(); } catch (_) {} }
    if (typeof Channels !== 'undefined') for (const id of Channels.busyIds()) { const rid = Channels.runIdOf(id); if (rid) Harness.cancel(rid); }
    aborters.clear();
  }

  /* ---------- THE AWAKENING (onboarding) interview ----------
     While an interview handler is set, the COMMS input feeds the onboarding script (Onboarding) instead
     of the model: typed answers AND tappable suggestion chips both author config docs — no model call. */
  function beginInterview(onAnswer, opts) {
    interview = onAnswer || null;
    opts = opts || {};
    clearChoices();
    if (input) input.placeholder = opts.placeholder || 'answer to wake your agent…';
    status(opts.status || 'waking…');
  }
  function endInterview() {
    interview = null;
    clearChoices();
    if (input) input.placeholder = 'speak to your agent · / commands';   // must stay byte-identical to index.html's attribute (see PLACEHOLDER WIDTH LAW there)
    status('online');
    // a memory deck that arrived MID-interview queued behind the focused flow — drain it now that the
    // question is answered (short hold so the interview's closing line lands first, not under the deck).
    setTimeout(() => showNextTurnin(), 700);
  }
  function echoUser(text) { addUser(text); }
  // scaffold the COMMS input with a starter the Commander finishes typing (the awakening's open CONTEXT
  // question uses this so a chip seeds "what i'm building: …" instead of committing a half-empty answer).
  function prefill(t) {
    if (!input) return;
    const add = String(t == null ? '' : t);
    const cur = input.value;
    // APPEND, never replace: tapping a 2nd facet chip must not wipe what the 1st started (or what the Commander
    // already typed). Separate with "; " unless the line already ends on a separator or is empty.
    if (cur.trim()) input.value = /[;:,]\s*$/.test(cur) ? cur.replace(/\s+$/, '') + ' ' + add : cur.replace(/\s+$/, '') + '; ' + add;
    else input.value = add;
    input.focus();
    try { const n = input.value.length; input.setSelectionRange(n, n); } catch (_) {}
    autoGrowInput();   // COMPOSER: appended facets can push the message to multiple lines — grow to fit
  }
  // a row of tappable suggestion pills in COMMS; picking one (or typing) is an answer. onPick gets the item.
  function clearChoices() {
    for (const r of Array.from(activeChoiceRows)) { if (r && r.parentNode) r.remove(); }
    activeChoiceRows.clear();
  }
  function choices(items, onPick, opts) {
    if (!log) return;
    // in a live voice call, chips never render (see liveVoiceCall) — no pick means the producer's optional
    // beat simply goes unanswered, exactly as if the Commander never clicked, which every caller tolerates
    if (liveVoiceCall()) return;
    clearEmptyState();
    clearChoices();   // chips are a focused prompt, never a background layer behind the next question
    const rowEl = document.createElement('div'); rowEl.className = 'choice-row';
    activeChoiceRows.add(rowEl);
    let done = false;
    // A producer may retire its own obsolete setup prompt without clearing another prompt's choices.
    rowEl.dismiss = () => { done = true; activeChoiceRows.delete(rowEl); rowEl.remove(); };
    // MULTI-SELECT (2026-08-14): opts.multi turns the plain option chips into toggles; only a chip marked
    // it.confirm (or it.skip) fires onPick — the confirm chip carries the picked values. Single-select
    // callers pass nothing and get byte-identical behavior.
    const multi = !!(opts && opts.multi);
    const picked = new Set();
    let confirmBtn = null;
    // same face as the live clarify card's confirm chip — the count is the receipt for what a tap will send
    const syncConfirm = () => {
      if (!confirmBtn) return;
      confirmBtn.disabled = !picked.size;
      confirmBtn.textContent = picked.size ? ('✔ confirm ' + picked.size + ' pick' + (picked.size > 1 ? 's' : '')) : '✔ confirm picks';
    };
    (items || []).forEach(it => {
      const b = document.createElement('button'); b.className = 'choice' + (it.quiet ? ' quiet' : '') + (it.suggested ? ' suggested' : ''); b.textContent = it.label;   // .quiet = subdued secondary chip; .suggested = the task brief's host-validated recommended default (gold)
      const pick = () => {
        if (done) return;
        if (multi && !it.skip && !it.confirm) {   // a toggle, not an answer — the confirm chip fires
          const on = !picked.has(it.value);
          if (on) picked.add(it.value); else picked.delete(it.value);
          b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.textContent = (on ? '✓ ' : '') + it.label;   // the fill alone does not read as ON
          if (typeof SFX !== 'undefined') SFX.click();
          syncConfirm();
          return;
        }
        done = true; activeChoiceRows.delete(rowEl); rowEl.remove(); if (typeof SFX !== 'undefined') SFX.click();
        onPick(it.confirm ? Object.assign({}, it, { values: (items || []).filter(x => !x.skip && !x.confirm && picked.has(x.value)).map(x => x.value) }) : it);
      };
      if (multi && it.confirm) { confirmBtn = b; b.classList.add('confirm'); syncConfirm(); }
      if (multi && !it.skip && !it.confirm) b.setAttribute('aria-pressed', 'false');
      // activate on POINTERDOWN, not click: a document-level activity listener (autopilotstore's welcome-back
      // digest) can fire during the capture phase of this same press and remove this row mid-dispatch. The event
      // path is fixed at dispatch start, so this listener still runs on the detached button — whereas the later
      // `click` (press+release) never fires on a removed element and the answer was silently eaten.
      // In multi mode a toggle does NOT flip `done`, so the click that follows the same press would
      // immediately un-toggle it — swallow the click that belongs to that press. Bounded by TIME, not by a
      // sticky flag: a press that never produces a click (drag off the button, pointercancel) would
      // otherwise leave the flag armed and silently eat the NEXT keyboard activation.
      let pressedAt = 0;
      b.addEventListener('pointerdown', e => { if (e.button === 0) { pressedAt = (typeof performance !== 'undefined' ? performance.now() : 0); pick(); } });
      b.onclick = () => {   // keyboard activation (Enter/Space synthesizes click, no pointerdown)
        const now = (typeof performance !== 'undefined' ? performance.now() : 0);
        if (pressedAt && now - pressedAt < 700) { pressedAt = 0; return; }
        pressedAt = 0; pick();
      };
      rowEl.appendChild(b);
    });
    log.appendChild(rowEl); autoscroll();
    return rowEl;   // caller (curiosity nudge) keeps a handle so the chip row can be retired with its prompt
  }

  // THE AWAKENING typewriter: reveals fixed text char-by-char (with per-segment speed + holds) through the
  // streaming caret, so the newborn is SEEN assembling its first broken sentence rather than printing it.
  // Pass a string or an array of {text, cps, holdAfter} segments. onDone ALWAYS fires (try/finally) so a
  // missed timer can never leave the awakening stuck. Returns a force-finish handle.
  /* opts.silent — type the line WITHOUT the keystroke sound. Live voice needs this: the agent's words are
     already being spoken aloud, so clacking a keyboard under them is a second, contradictory performance of
     the same sentence. Default stays noisy; only a caller that owns the delivery turns it off. */
  function typeLine(segments, onDone, opts) {
    const silent = !!(opts && opts.silent);
    if (typeof segments === 'string') segments = [{ text: segments }];
    if (!log || !Array.isArray(segments)) { if (onDone) onDone(); return () => {}; }
    const out = streamingAgent();
    let si = 0, ci = 0, finished = false, killed = false;
    function finish() {
      if (finished) return; finished = true;
      try { out.done(); } catch (_) {}
      try { if (onDone) onDone(); } catch (_) {}
    }
    function stepOne() {
      if (killed || si >= segments.length) { finish(); return; }
      const seg = segments[si] || {};
      const text = String(seg.text || '');
      if (ci >= text.length) { si++; ci = 0; setTimeout(stepOne, seg.holdAfter != null ? seg.holdAfter : 0); return; }
      const ch = text[ci++];
      try { out.append(ch); } catch (_) { finish(); return; }
      if (!silent && typeof SFX !== 'undefined' && SFX.type && ch !== ' ' && (ci % 2 === 0)) SFX.type();
      const cps = seg.cps || 40;
      setTimeout(stepOne, (1000 / cps) * (0.6 + Math.random() * 0.8));
    }
    stepOne();
    return () => { killed = true; };
  }

  // Only a still-current foreground run may honor model-driven navigation. Tool arguments alone
  // cannot establish that the Commander is still looking at the conversation that asked for it.
  function canFocusSession(origin) {
    if (!origin || !activeWs || origin.streamId !== activeWs.id || !origin.runId) return false;
    const meta = RUN_META.get(origin.runId);
    return !!meta && meta.streamId === activeWs.id && meta.focusVersion === focusVersion
      && Channels.isBusy(activeWs.id) && Channels.runIdOf(activeWs.id) === origin.runId
      && !(input && input.value.trim()) && !pendingAtts.length;
  }
  // Read-only run metadata for advice stores and task attribution.
  function runMeta(id) { return (id && RUN_META.has(id)) ? RUN_META.get(id) : null; }
  // read-only: did this run do REAL work (>=1 successful tool call OR >=1 delivered product)? The same "real work
  // only" gate maybeStandaloneRate uses — so a pure-chat run is never bottle-offered. Used by App.runBottleInfo (R5).
  function runDidWork(id) { const w = id ? runWork.get(id) : null; return !!(w && ((w.toolsOk || 0) >= 1 || (w.delivered || 0) >= 1)); }

  return { init, load, send, refreshStarters, sendOrQueue, continueConnectorTask, stopActive, status, localLine, broadcast, renderProse, setSystem, getHistory, contextRef, abort, isBusy, beatBusy: skillBeatBusy, beginInterview, endInterview, echoUser, prefill, autoGrowInput, choices, clearChoices, retireDeskPrompt, typeLine, nudge, clearNudge, offerCuriosity, offerFork, planGoalPath, briefingReceipt, canFocusSession, runMeta, runDidWork, awayDigest, awayReview, awayRate, sampleCard, workshopReturn, refreshIdBar: renderIdBar, refreshGroupControls: updateControls, refreshAgentIdentity, setRosterStatus, askBudgetSpent, spendAsk };
})();
