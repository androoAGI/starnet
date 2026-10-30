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
  const liveRunRoots = new Map();   // workstreamId -> the project root its in-flight run was sent with (null = none): a switch-back replays its files there
  const interrupted = new Set();   // wsIds the Commander deliberately STOPPED this turn — send()'s catch reads this as a
                                   // graceful stop (keep the partial reply, log no error) rather than a disconnect. Consumed in finally.
  const interruptedStreams = new Set();   // wsIds whose in-flight run lost its stream; durable recovery decides
  const stopSource = new Map();   // wsId -> 'esc' | 'you': HOW the Commander stopped it (the card names it); consumed with `interrupted`
                                   // whether work resumes automatically or stops for explicit review.
  const recoveryClaims = new Set();       // source run ids already being recovered by this page
  const recoveryNotices = new Set();      // review-required run ids already explained on this page
  let reconnectTimer = 0;          // the single reconnect health-probe poll (armed only while interruptedStreams is non-empty)
  const queued = new Map();        // TYPE-AHEAD: wsId -> [text,…] follow-ups typed while the stream was busy; auto-sent in order as it frees
  const sentNow = new Map();       // SEND NOW: wsId -> [{ id, text, wire, runId, accepted, landed }] queued lines handed to the live run (sendQueuedNow) — kept until that run ends, so a STOP can give back any its transcript never showed landing (and on disk until settled: keepSentNow)
  const heldBack = new Map();      // wsId -> [{ texts, line, ids }] words a confirmed STOP gave back while ANOTHER session was on screen: they go into the message box when you return (returnHeld)
  const sentNowChecks = new Map(); // wsId -> the in-flight ask about its leftover sent-now lines (reconcileSentNow): one per conversation at a time
  const sentNowRetry = new Map();  // noteId -> the retry armed for it (askSentNow): one chain per line, however many asks find it still waiting
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
  /* memory-truth (2026-10-11): receipts are tracked per SAVE, not per run. A run can save mid-run (notebook.write) AND
     after it ends (reflection); the old once-per-run gate showed the first batch and then hid every later save of the
     same run. receiptShown: runId -> keys already rendered; receiptFetching: runIds with a fetch already scheduled. */
  const receiptShown = new Map();
  const receiptFetching = new Set();
  // the saves of this batch not yet shown for its run — marked shown as they are handed back (renders exactly once)
  function unshownReceipts(runId, saved) {
    let seen = receiptShown.get(runId);
    if (!seen) { seen = new Set(); receiptShown.set(runId, seen); if (receiptShown.size > 200) receiptShown.delete(receiptShown.keys().next().value); }
    return saved.filter(p => { const k = String(p.key || p.id || p.content || ''); if (seen.has(k)) return false; seen.add(k); return true; });
  }
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
  let revealKey = '';   // selector of the last explicit reveal (revealHistory); a fresh load or the reader's own gesture forgets it
  let userScrollHeld = false;
  let userScrollAt = 0;   // last real scroll GESTURE on the log (wheel/touch/scrollbar/keys) — only a gesture can unstick
  /* A PRESS IS NOT A SCROLL (live walk 10-14: the approval card and the MY READ card landed below the fold under a NEW
     MESSAGES pill). Every pointer release in the WINDOW stamped a gesture — the click on the composer or the send key —
     and so did a press on a key inside the log (Approve once, a brief chip). Content landing in the next 1.2 s then read
     as "they scrolled up" and the follow stopped mid-exchange. Only a scroll gesture on the log counts: wheel, touch, the
     scrollbar or text drag (a hold that began ON the log), or a key that moves the reader. */
  const PRESS_SEL = 'button, a[href], input, textarea, select, label, summary, [role="button"], [contenteditable="true"]';
  function isPress(ev) { const t = ev && ev.target; return !!(t && t.closest && t.closest(PRESS_SEL)); }
  /* A KEY THAT MOVES THE READER IS A GESTURE WHEREVER FOCUS SITS (review 10-14: with focus left on a message's copy key, PageUp
     and ArrowUp were read as layout moving under a follower and pulled straight back down — the reader could not move and no
     pill showed). Only a key that ACTS on a control is a press: Enter or Space on a key, link or chip, and typing or caret keys
     in a field. PageUp / PageDown / Tab move the reader even from a field (Tab scrolls the next key into view). */
  const READ_KEYS = ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab', ' ', 'Spacebar'];
  const FIELD_SEL = 'input, textarea, select, [contenteditable="true"]';
  function keyMovesReader(ev) {
    const k = ev.key, t = ev.target, on = sel => !!(t && t.closest && t.closest(sel));
    if (READ_KEYS.indexOf(k) < 0) return !on(PRESS_SEL);   // any other key: on the log itself as ever; on a key or in a field it acts there
    if (k === 'PageUp' || k === 'PageDown' || k === 'Tab') return true;
    if (on(FIELD_SEL)) return false;   // arrows / Home / End / Space move a caret or type a space
    return !((k === ' ' || k === 'Spacebar') && on(PRESS_SEL));   // Space presses a key; arrows / Home / End on a key scroll the log
  }
  function logGesture(ev) { if (ev && ev.type === 'keydown' ? keyMovesReader(ev) : !isPress(ev)) userScrollAt = Date.now(); }
  function logHold(ev) { if (!isPress(ev)) userScrollHeld = true; }
  function endLogHold() { if (!userScrollHeld) return; userScrollHeld = false; userScrollAt = Date.now(); }   // a release ends a hold begun on the log, never stamps one begun elsewhere
  function nearBottom() { return !log || (log.scrollHeight - log.scrollTop - log.clientHeight < 40); }
  function autoscroll() { if (stick && log) log.scrollTop = log.scrollHeight; else if (log) showNewPill(true); }   // content landed while unstuck → "new messages"
  /* A QUESTION OR APPROVAL CARD follows the bottom like any row — unless that cuts its TOP off (who asks and what): then it
     shows from its top and the follow waits until it is answered (2026-10-13 review). One card is held at a time: a second
     one waits its turn (no jump, no focus) and is shown from its top once the first is answered. A live card carries
     data-live-ask until it is settled, so a session load re-holds it after its history pin. */
  let heldCard = null, heldScrollTop = 0;
  const heldQueue = [];
  // the log's offset of a node in LAYOUT px: TEXT SIZE is a body zoom, so a rect delta is scaled (deliverTurns does the same)
  function topInLog(el) { const k = log.offsetHeight ? (log.getBoundingClientRect().height / log.offsetHeight) || 1 : 1; return (el.getBoundingClientRect().top - log.getBoundingClientRect().top) / k; }
  function holdCard(el) { log.scrollTop += topInLog(el) - 8; stick = false; heldCard = el; heldScrollTop = log.scrollTop; hideNewPill(); }
  function revealCard(el) {
    noteAskLanding();   // a live question / approval card is on screen: an offer panel over COMMS steps aside for its keys
    if (!log || !el || !el.getBoundingClientRect || !log.clientHeight) { autoscroll(); return; }   // COMMS has no layout (behind CREW / ACTIVITY / cinema): nothing to reveal
    if (heldCard && heldCard !== el && log.contains(heldCard)) { if (!heldQueue.includes(el)) heldQueue.push(el); return 'queued'; }
    if (!stick) { autoscroll(); return; }
    log.scrollTop = log.scrollHeight;
    // the presence line lands under the card right after this (~50px) and the follow goes with it: leave it the room
    if (topInLog(el) < 0 || el.offsetHeight + 90 > log.clientHeight) holdCard(el);
  }
  // answered (here or elsewhere): the run goes on, so the transcript follows it again — or shows the next waiting card
  function releaseCard(el) {
    if (!el) return;
    if (el.dataset) delete el.dataset.liveAsk;
    const queued = heldQueue.indexOf(el); if (queued >= 0) heldQueue.splice(queued, 1);
    if (heldCard !== el) return;
    heldCard = null;
    if (!log || !log.contains(el)) { heldQueue.length = 0; return; }   // another session's card: never move the transcript being read
    let next = null;
    while (heldQueue.length && !next) { const c = heldQueue.shift(); if (log.contains(c) && c.dataset && c.dataset.liveAsk) next = c; }
    if (Math.abs(log.scrollTop - heldScrollTop) > 40) { if (!stick) showNewPill(false); return; }   // they scrolled away: leave them there
    stick = true;
    if (next) { revealCard(next); try { next.focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ } return; }
    log.scrollTop = log.scrollHeight; hideNewPill();
  }
  // a pressed key is removed with its row: keep the keyboard on the card instead of dropping it to <body>
  function keepFocus(el) { try { const a = document.activeElement; if (!a || a === document.body) el.focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ } }

  /* COMMS-PREMIUM · the jump-to-bottom pill. Two states over ONE control (stick machinery, no new scroll state):
     • scrolled UP to re-read (stick=false) → a dim, PERSISTENT "↓ latest" affordance (so a keyboard/AT user
       always has a way back to the newest line, not only when new content happens to land);
     • fresh content lands while unstuck → it brightens to "new messages ↓".
     Anchored to #chat-log's bottom EDGE (just above the composer) by measuring the composer height each show,
     so it rides a one- or multi-line composer instead of a magic offset. Click jumps down + re-arms stickiness. */
  function jumpToBottom() { if (log) { log.scrollTop = log.scrollHeight; stick = true; hideNewPill(); } }
  function cancelHistoryPin() { historyPinPending = 0; }
  // An explicit search/attention/result jump is reading intent, including when a session load still owes its pin.
  function revealHistory(target) {
    if (!log || !target || !log.contains(target)) return false;
    cancelHistoryPin(); stick = false; userScrollAt = Date.now();
    if (target.offsetHeight + 16 > log.clientHeight) log.scrollTop += topInLog(target) - 8; else target.scrollIntoView({ block: 'center' });
    showNewPill(false);
    revealKey = revealSelector(target);
    return true;
  }
  // The revealed row as a selector, so the load's server-history repaint (which rebuilds every row) can find it again.
  function revealSelector(target) {
    const sel = attr => (target.hasAttribute && target.hasAttribute(attr)) ? '[' + attr + '="' + String(target.getAttribute(attr)).replace(/["\\]/g, '\\$&') + '"]' : '';
    return sel('data-dg-row') || sel('data-clarify-prompt') || sel('data-consent-prompt');   // an approval card too (NEEDS YOU › Review)
  }
  function forgetReveal() { revealKey = ''; }
  // ONE HOP TO A QUESTION (2026-10-13 review: from NEEDS YOU it took Answer → the worker's row → Answer → the card). A
  // question is answered on its own question card; the row's Answer key and NEEDS YOU both land there. If the card is not
  // in the transcript, draw it again from the conversation's open ask, so the key is never dead.
  // AN APPROVAL TOO (live walk 10-14): NEEDS YOU › Review on an approval re-opened the session and left its card below
  // the fold. Review lands on the approval card the same way (a delegated worker's ask lives on its delegation card:
  // permissionRow draws nothing for it, and NEEDS YOU unfolds that worker's row instead).
  function revealAsk(promptId) {
    if (!log || promptId == null) return false;
    const id = String(promptId);
    const find = () => Array.from(log.querySelectorAll('[data-clarify-prompt], [data-consent-prompt]')).find(n => (n.dataset.clarifyPrompt || n.dataset.consentPrompt) === id);
    let card = find();
    if (!card && activeWs && typeof Channels !== 'undefined' && Channels.pendingAllOf) {
      const p = Channels.pendingAllOf(activeWs.id).find(x => x && String(x.promptId) === id);
      if (p) { permissionRow(p, activeWs); card = find(); }
    }
    if (!card) return false;
    noteAskLanding();   // NEEDS YOU › Review / Answer: the card it lands on is never under an offer panel
    revealHistory(card);
    if (card.dataset.liveAsk) { heldCard = card; heldScrollTop = log.scrollTop; heldQueue.length = 0; hideNewPill(); }   // answering it resumes the follow
    try { card.focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy: the card is already in view */ }
    return true;
  }
  function pinLoadedHistoryAfterLayout(seq) {
    const pin = () => {
      if (!log || historyPinPending !== seq) return;
      log.scrollTop = log.scrollHeight;
      historyPinPending = 0;
      const live = Array.from(log.querySelectorAll('[data-live-ask]'));
      if (live.length) { heldCard = null; heldQueue.length = 0; stick = true; for (const c of live) revealCard(c); if (heldCard) return; }
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
    // a card held from its top is what you are reading: no "latest" key on top of it (only real new content brings one)
    if (!hasNew && heldCard && log && log.contains(heldCard)) return;
    let pill = el('comms-newpill');
    if (!pill) {
      pill = document.createElement('button'); pill.id = 'comms-newpill'; pill.type = 'button'; pill.className = 'comms-newpill';
      pill.onclick = () => { if (typeof SFX !== 'undefined' && SFX.press) SFX.press(); jumpToBottom(); };
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
  // the ask THIS conversation's live run is paused on. A background worker's ask (filed on the same conversation) never
  // pauses it: the run keeps working, so its presence card must not read AWAITING APPROVAL for someone else's wait
  function runPendingOf(ws) {
    if (!ws || typeof Channels === 'undefined') return null;
    return Channels.runPendingOf ? Channels.runPendingOf(ws.id) : Channels.pendingOf(ws.id);
  }
  // derive the presence VERB from the same real state syncStatus() reads (pending approval > working > thinking)
  function presenceVerb() {
    const p = runPendingOf(activeWs);
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
    const pend = runPendingOf(activeWs);
    const paused = !!pend;
    card.classList.toggle('paused', paused);
    const verb = card.querySelector('.cp-verb'); if (verb) verb.textContent = presenceVerb();
    const tool = card.querySelector('.cp-tool');
    if (tool) {
      if (paused) {
        // e.g. "paused — waiting for your approval to change notes.md" (the card's own words, never a raw tool id like
        // fs.write — 2026-10-13); a clarify question is an ANSWER, not a grant
        const t = pend.tool === 'brief.ask' ? 'see the question above' : 'to ' + glance(actionPhrase(pend), 70);
        if (tool.textContent !== t) tool.textContent = t;
        tool.classList.add('has'); tool.classList.add('paused-note'); tool.classList.remove('wait-note');
      } else {
        tool.classList.remove('paused-note');
        // the running tool wins; with none, the sidecar's own word on a slow/retrying model call (LIVE WAIT LINE)
        const t = presenceCurTool ? shortName(presenceCurTool) : waitNoteText(presenceWaitNote());
        if (tool.textContent !== t) paintToolLine(tool, t, presenceCurTool ? null : presenceWaitNote());
        tool.classList.toggle('has', !!t);
        tool.classList.toggle('wait-note', !presenceCurTool && !!t);   // the wait line WRAPS: its numbers never clip
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
  /* LIVE WAIT LINE (2026-09-23, live-events lane). The retry ladder (~105 s) and a slow model (up to minutes before a
     first byte) used to leave this card reading THINKING and nothing else. The sidecar now says so itself —
     provider.retry before each backoff, agent.waiting on a ~15 s heartbeat while a model call shows nothing — and the
     card's .cp-tool slot (the same transient line that names the running tool) renders exactly that:
     "retry 3/6 in 30s (overloaded) — <model>" · "waiting for 45s on <model>". Truthful telemetry: every
     number is read off the latest event for the DISPLAYED run (no local countdown, no guessed state), and the line
     clears the moment the run shows output (a token, a tool call), fails over, or ends. */
  const waitNotes = new Map();   // runId -> the latest wait note (see foldWaitNote)
  // PURE: the next wait note for a run given one bus event (null = no wait to show). Locked by comms-wait-line.test.js.
  function foldWaitNote(prev, name, p) {
    p = p || {};
    if (name === 'provider.retry') {
      return { model: String(p.model || (prev && prev.model) || ''), phase: 'retry_backoff', sinceMs: 0,
        retry: { attempt: p.attempt, maxAttempts: p.maxAttempts, reason: String(p.reason || ''), delayMs: p.delayMs } };
    }
    if (name === 'agent.waiting') {
      // a beat during the backoff keeps the retry it belongs to; any other phase means the retry already went out.
      // `note` = the sidecar's own facts about this wait, as the beat states them (#99: where Ollama has the model); a beat
      // without one means there is none now, so it is never carried over from an earlier beat.
      return { model: String(p.model || (prev && prev.model) || ''), phase: String(p.phase || ''), sinceMs: p.sinceMs,
        note: String(p.note || '').slice(0, 240),
        retry: (p.phase === 'retry_backoff' && prev && prev.retry) ? prev.retry : null };
    }
    if (name === 'agent.token') return p.delta ? null : prev;   // an empty delta shows the Commander nothing
    if (name === 'agent.tool_call' || name === 'agent.tool_result' || name === 'provider.fallback'
      || name === 'agent.run.end' || name === 'agent.run.error') return null;   // output, a failover or the end: the wait is over
    return prev;
  }
  /* PURE: the text for a wait note ('' = nothing to show). FACTS FIRST, MODEL LAST (live browser proof, 2026-09-24): the
     line used to lead with "waiting on <model>", so the default 520 px panel clipped every retry line's reason and a
     300 px panel showed "· waiting on anthropic…" and nothing else. The rung, countdown, reason and duration now lead;
     the model id (the least new fact — it is the agent's roster model) trails, and the slot wraps (.wait-note). No
     trailing "…": it read exactly like the clip ellipsis. */
  // PURE: the model as the wait line names it — the bare id without its vendor path ("anthropic/claude-sonnet-4.6" ->
  // "claude-sonnet-4.6"; still the model, in a third of a 300 px line), capped at 48 chars.
  function waitModelLabel(n) {
    const model = String((n && n.model) || '').trim();
    const bare = model.slice(model.lastIndexOf('/') + 1) || model;
    return bare ? (bare.length > 48 ? bare.slice(0, 47) + '…' : bare) : 'the model';
  }
  function waitNoteText(n) {
    if (!n) return '';
    const name = waitModelLabel(n);
    const since = Math.max(0, Number(n.sinceMs) || 0);
    const r = n.retry;
    if (r) {
      // "in Ns" rounds UP: a 400 ms rung reads "in 1s", never "in 0s"
      const left = Math.max(0, (Number(r.delayMs) || 0) - since);
      const of = Number(r.maxAttempts) > 0 ? '/' + r.maxAttempts : '';
      const why = String(r.reason || '').replace(/_/g, ' ').trim();
      return 'retry ' + r.attempt + of + (left > 0 ? ' in ' + fmtElapsed(Math.ceil(left / 1000) * 1000) : ' now') + (why ? ' (' + why + ')' : '') + ' — ' + name;
    }
    if (n.phase === 'retry_backoff') return 'retry backoff' + (since >= 1000 ? ', ' + fmtElapsed(since) + ' so far' : '') + ' — ' + name;
    const dur = since >= 1000 ? ' for ' + fmtElapsed(since) : '';
    // the sidecar's facts about the wait (#99, a local Ollama: prompt size, GPU/CPU share, window) follow the duration
    if (n.note) return 'waiting' + dur + ' · ' + n.note + ' — ' + name;
    if (n.phase === 'connect') return 'connecting' + dur + ' to ' + name;   // (the model id is always LAST: renderPresence splits it off)
    return 'waiting' + dur + (n.phase === 'streaming' ? ' (stream open)' : '') + ' on ' + name;
  }
  // the model id closes every wait line as ONE token (.cp-model): it wraps whole and clips only itself, never mid-id
  function paintToolLine(tool, t, note) {
    const m = note ? waitModelLabel(note) : '';
    if (m && t.endsWith(m)) {
      tool.textContent = t.slice(0, t.length - m.length);
      const s = document.createElement('span'); s.className = 'cp-model'; s.textContent = m; tool.appendChild(s);
    } else tool.textContent = t;
  }
  function presenceWaitNote() {
    const rid = (activeWs && typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(activeWs.id) : null;
    return rid ? (waitNotes.get(rid) || null) : null;
  }
  /* VOICE CHAT MODEL NOTICE (Hermes parity): a spoken turn that could NOT use SETTINGS › Models › VOICE CHAT MODEL ran
     on the agent's own model — say so ONCE per model+reason, in the stream it happened in, from the sidecar's own
     agent.run.start voiceRoute (never inferred here). A turn the voice model answered needs no line: its receipt
     already names the model that answered. PURE text builder, test-locked in test/voice-chat-route.test.js. */
  const VOICE_ROUTE_REASONS = { not_configured: 'its provider is not connected', too_large: 'this conversation is larger than its context window' };
  function voiceRouteNoticeText(vr) {
    if (!vr || vr.used || !vr.reason || !VOICE_ROUTE_REASONS[vr.reason] || !vr.wanted || !vr.wanted.model) return '';
    return 'VOICE MODEL ' + vr.wanted.model + ' not used — ' + VOICE_ROUTE_REASONS[vr.reason] + '; spoken replies use ' + (vr.model || 'the agent’s model');
  }
  const voiceRouteNoticed = new Set();
  let voiceRouteWired = false;
  function wireVoiceRouteNotice() {
    if (voiceRouteWired || typeof U === 'undefined' || !U.bus) return;
    voiceRouteWired = true;
    U.bus.on('agent.run.start', p => {
      const text = voiceRouteNoticeText(p && p.voiceRoute);
      if (!text) return;
      if (!activeWs || !p.streamId || String(p.streamId) !== String(activeWs.id)) return;
      const once = p.voiceRoute.reason + '|' + p.voiceRoute.wanted.model;
      if (voiceRouteNoticed.has(once)) return;
      voiceRouteNoticed.add(once);
      broadcast(text, { highlight: p.voiceRoute.wanted.model });
    });
  }
  let waitWired = false;
  function wireWaitNotes() {
    if (waitWired || typeof U === 'undefined' || !U.bus) return;
    waitWired = true;
    ['provider.retry', 'agent.waiting', 'agent.token', 'agent.tool_call', 'agent.tool_result', 'provider.fallback', 'agent.run.end', 'agent.run.error'].forEach(name => {
      U.bus.on(name, p => {
        const rid = p && p.runId;
        if (!rid) return;
        const prev = waitNotes.get(rid) || null;
        if (!prev && name !== 'provider.retry' && name !== 'agent.waiting') return;   // hot path: a token for a run with no wait
        const next = foldWaitNote(prev, name, p);
        if (next === prev) return;
        waitNotes.delete(rid);
        if (next) { waitNotes.set(rid, next); if (waitNotes.size > 24) waitNotes.delete(waitNotes.keys().next().value); }
        const shown = (activeWs && typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(activeWs.id) : null;
        if (shown && shown === rid) renderPresence();   // only the displayed stream's own run draws here
      });
    });
  }
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
    // the honest machine time rides the card, so the later telemetry hydration can never swap in wall-clock time
    if (started) card.dataset.ms = String(Math.max(0, Math.round(Channels.elapsedOf(ws.id, Date.now()) || 0)));
    card.classList.remove('cp-live');
    presenceCurTool = null;
    const isErr = !!opts.error, needsVerify = !!opts.verificationRequired, isStop = needsVerify || !!opts.stopped || (opts.endReason && opts.endReason !== 'done') || !!opts.cutShort;
    card.classList.add('resolved'); if (isErr) card.classList.add('err'); else if (isStop) card.classList.add('stopped');
    // WHO stopped it (2026-10-11): the Commander's own Stop/Esc says so on the card — a bare "RUN STOPPED" after Esc
    // read as the run quitting on its own. opts.stoppedBy: 'esc' | 'you' (stopActive's record); absent = not proven.
    const byYou = opts.stoppedBy === 'esc' ? '■ STOPPED BY YOU (ESC)' : opts.stoppedBy === 'you' ? '■ STOPPED BY YOU' : '';
    let label = isErr ? '■ RUN FAILED' : needsVerify ? '■ VERIFICATION REQUIRED' : opts.cutShort ? '■ CUT SHORT' : (isStop && byYou) ? byYou : isStop ? '■ RUN STOPPED' : '■ RUN COMPLETE';
    const bits = [];
    if (dur) bits.push(dur);
    if (typeof opts.steps === 'number' && opts.steps > 0) bits.push(opts.steps + (opts.steps === 1 ? ' step' : ' steps'));
    if (typeof opts.cost === 'number' && opts.cost > 0) bits.push(U.usd(opts.cost));
    // TWO-TIER TRANSCRIPT: the run's tool rails FOLD under this resolved line so the machinery recedes
    // and the speech stays contiguous. The rails are MOVED, never deleted — the full work log is one
    // click away (truthful telemetry intact, just collapsed).
    const rails = runRails.filter(r => r && r.isConnected && railChips(r).length > 0);
    runRails = [];
    const tools = rails.reduce((n, r) => n + railChips(r).length, 0);   // the chips only: a folded rail's summary row is not a tool
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
    settleSummaryUnderReply(card);
    autoscroll();
  }
  /* THE SUMMARY IS THE REPLY'S FOOTER. The live card re-pins itself to the bottom on each elapsed tick, so where it
     resolved depended on timing: a quick run left "■ RUN COMPLETE" wedged between the Commander's question and the
     answer, a slow one left it under the answer. It now always settles directly under this run's last prose row
     (with its fold), so a turn reads question → answer → quiet footer. Stops at the next Commander turn; a run
     that spoke no prose leaves the card where it is. */
  function settleSummaryUnderReply(card) {
    if (!card || !card.parentNode) return;
    const fold = card.nextElementSibling && card.nextElementSibling.classList.contains('run-fold') ? card.nextElementSibling : null;
    let anchor = null;
    for (let n = (fold || card).nextElementSibling; n; n = n.nextElementSibling) {
      // a note the Commander sent mid-run belongs to this run's stretch; only their next real turn ends it
      if (!n.classList.contains('steer-echo') && n.classList.contains('user')) break;
      if (n.classList.contains('cmsg') && n.classList.contains('agent') && !n.matches('.nudge,.consent,.turnin,.tool,.deliverable')) anchor = n;
    }
    if (anchor) {
      anchor.after(card);
      if (fold) card.after(fold);
    }
    // the rails that split the answer into paragraphs just folded away, so its rows are ADJACENT now — a follow-up row
    // stamped the same minute as the one above becomes one message (same rule row() applies at creation). Every pair in
    // this run's stretch, back to the turn that started it: a mid-run note or a station line between two paragraphs no
    // longer ends the walk (10-26: "8:23 PM" stood alone between two paragraphs of one reply). Same speaker only.
    const prose = n => !!(n && n.classList && n.classList.contains('agent') && n.classList.contains('cmsg') && !n.matches('.nudge,.consent,.turnin,.tool,.deliverable'));
    const headOf = n => { const w = n.querySelector(':scope > .cmsg-head > .who'), t = n.querySelector(':scope > .cmsg-head > .cmsg-ts'); return w && t ? w.textContent + '|' + t.textContent : ''; };
    for (let n = anchor || card.previousElementSibling; n; n = n.previousElementSibling) {
      if (!n.classList.contains('steer-echo') && n.classList.contains('user')) break;
      const p = n.previousElementSibling;
      if (prose(n) && prose(p) && headOf(n) && headOf(n) === headOf(p)) n.classList.add('ts-repeat');
    }
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
    try { rows = await Harness.runRecoveries({ streamId: ws.id, agentId: ws.agentId || 'agent' }); } catch (_) { return 'unavailable'; }
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
    let recovery;
    try { recovery = await Harness.prepareAutomaticRecovery(safe); }
    catch (_) { recoveryClaims.delete(safe.runId); return 'unavailable'; }
    // Preparation is durable and idempotent. If focus changed while it was in flight, leave it ready for the
    // next load instead of crossing conversations.
    if (!isActiveWs(ws) || Channels.isBusy(ws.id)) { recoveryClaims.delete(safe.runId); return 'deferred'; }
    if (announce) toolLine('recovery prepared — requesting continuation from the last durable step.');
    await send(String(safe.userTitle || 'Continue the interrupted task.'), {
      retry: true, recoveryResume: true, recovery
    });
    return 'started';
  }

  let lastDegradedLine = '';   // the degraded reason already named in COMMS (once per reason, reset when the service answers)
  let reconnectProbeInFlight = false;
  async function probeReconnect() {
    if (reconnectProbeInFlight) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (!interruptedStreams.size) return;
    reconnectProbeInFlight = true;
    let alive = false, degraded = '';
    let deadlineTimer = 0, response = null, expired = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    // A timed-out answer's body is dropped unread. Cancel runs a tick later so it can never throw into the
    // deadline; a refused cancel (the stream is already locked or closed) changes nothing about the probe.
    const cancelBody = () => {
      const body = response && response.body;
      if (body && typeof body.cancel === 'function') Promise.resolve().then(() => body.cancel()).catch(() => {});
    };
    try {
      // Same 4s local-health budget as Harness.engineState, including the 503 body. Do not use that
      // helper's broader HTTP success rule or its separate desktop-status lookup here.
      const deadline = new Promise(resolve => {
        deadlineTimer = setTimeout(() => {
          expired = true;
          resolve({ alive: false, degraded: '' });   // settle first: nothing below can keep the poll from re-arming
          if (controller) controller.abort();
          cancelBody();
        }, 4000);
      });
      const answer = (async () => {
        const r = response = await fetch('/api/health', Object.assign({ cache: 'no-store' }, controller ? { signal: controller.signal } : {}));
        if (expired) { cancelBody(); return { alive: false, degraded: '' }; }
        let reason = '';
        // Only the existing 503 degraded prefix is eligible for the unchanged once-per-reason notice.
        if (r && r.status === 503) { const t = String(await r.text() || '').trim(); if (/^degraded/i.test(t)) reason = t; }
        if (expired) return { alive: false, degraded: '' };
        return { alive: !!(r && r.ok), degraded: reason };
      })();
      ({ alive, degraded } = await Promise.race([answer, deadline]));
    } catch (_) { alive = false; }
    finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      reconnectProbeInFlight = false; // only health is single-flight; recovery preparation may remain pending
    }
    if (alive) {
      lastDegradedLine = '';
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
      if (degraded && degraded !== lastDegradedLine && activeWs && interruptedStreams.has(activeWs.id)) {
        lastDegradedLine = degraded;
        toolLine('station service ' + degraded + (Harness.canRestartEngine && Harness.canRestartEngine() ? ' — restart it from LINK DOWN at the top.' : ''), true);
      }
      if (interruptedStreams.size) reconnectTimer = setTimeout(probeReconnect, 3000);   // still down — keep watching
    }
  }
  function armReconnectWatch() {
    if (reconnectTimer || reconnectProbeInFlight) return;
    // if the browser signals it's back online, probe immediately; otherwise poll on a slow cadence.
    reconnectTimer = setTimeout(probeReconnect, 2000);
    try { if (typeof window !== 'undefined' && !window.__runtruthOnlineHook) { window.__runtruthOnlineHook = true; window.addEventListener('online', () => { if (interruptedStreams.size && !reconnectTimer && !reconnectProbeInFlight) probeReconnect(); }); } } catch (_) {}
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
  // 12-hour clock (Andrew 10-03: "military time is NONSENSE"). A stamp from an earlier day carries its date —
  // "Yesterday 9:14 PM" / "Oct 1, 9:14 PM" — so an old turn's bare clock is never read as today's.
  const CLOCK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtClock(d, nowMs) {
    d = d || new Date();
    if (isNaN(d.getTime())) return '';
    const h = d.getHours(), m = d.getMinutes();
    const clock = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
    const now = new Date(nowMs == null ? Date.now() : nowMs);
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const daysAgo = Math.round((day(now) - day(d)) / 86400000);
    if (daysAgo === 0) return clock;
    if (daysAgo === 1) return 'Yesterday ' + clock;
    return CLOCK_MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ', ' + clock;
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
      // a ')' that CLOSES a '(' inside the URL is part of it (https://en.wikipedia.org/wiki/Foo_(bar) linked to …Foo_(bar, a 404 —
      // QA 2026-10-02); only an unbalanced ')' is sentence punctuation
      while (m[0].charAt(url.length) === ')' && (url.split('(').length - 1) > (url.split(')').length - 1)) url += ')';
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
  const MD_MARKERS = /\||^\s*>|^\s*\d+[.)]\s|\*\*|\*[^\s*][^*\n]*\*|`|^#{1,6}\s|^[ \t]*[-*+]\s|\r?\n[ \t]*\r?\n|\]\(/m;   // plain paragraph breaks need the same spacing as formatted prose; *italic* too
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
  /* A LABEL THAT IS AN ADDRESS SHOWS WHERE IT REALLY GOES (QA 2026-10-02). [https://bank.com](https://evil.com) read as
     bank.com and opened evil.com — agent output can be steered by a page the agent read, and the desktop window has no
     status bar to show a link's target. When the label names a host the target does not have, the target's host follows. */
  function hostOf(u) {
    const t = String(u || '').trim();
    const m = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,24}))(?=[\/:?#]|$)/i.exec(t);
    if (!m) return '';
    // a bare dotted word is a host only when it ends like one: never a version (v0.12.5) or a file name (README.md, app.js)
    if (!/^(?:https?:\/\/|www\.)/i.test(t) && /^(?:md|txt|js|mjs|cjs|ts|tsx|jsx|json|py|rb|go|rs|java|kt|c|h|cpp|cs|php|html?|css|scss|xml|ya?ml|toml|ini|cfg|conf|lock|log|csv|tsv|pdf|png|jpe?g|gif|svg|webp|mp[34]|wav|zip|tar|gz|exe|dll|sh|ps1|bat|env|sql|db)$/i.test(m[2])) return '';
    return m[1].toLowerCase();
  }
  function linkHostNote(label, href) {
    const shown = hostOf(label), real = hostOf(href);
    return (shown && real && shown !== real) ? ' <span class="md-host">(' + escapeHtml(real) + ')</span>' : '';
  }
  /* FILES THE AGENT NAMES (2026-10-10, Andrew's screenshot: "[Review the original…](review/x/index.html)" and "![…](…/final.jpg)"
     sat in the transcript as raw markdown). Agents point at the files they made with RELATIVE paths — their workspace (or, in
     a group, a shared file). A link becomes a real file link; an image becomes the picture, opened in the lightbox on click.
     Escaping law unchanged: the path and the label are escaped into OUR markup; renderProse hydrates them afterwards through
     a resolver (the jailed /api/file seams by default — the server refuses any escape). A target that is neither a web
     address nor a plain relative path (an anchor, an absolute or '..' path, a scheme) keeps just its readable label. */
  const REL_PATH = /^(?![\/\\#])(?!.*\.\.)[^\s:<>"'()]+$/;
  /* THE APP'S OWN FILE ADDRESS (user report 10-20: asked twice for the design boards, saw raw markdown, then bare labels).
     image_generate and the browser tools hand the agent its viewer address, '/api/file?agent=<id>&path=<rel>[&project=<root>]',
     so a model showing the picture writes ![…](/api/file?…): an absolute target, which kept only its label. Read it back into
     the same jailed seam — the path inside must still be a plain relative path, and the server's jail refuses the rest. */
  function appFileRef(target) {
    const m = /^\/api\/file\?([^#\s]*)$/.exec(target);
    if (!m) return null;
    const q = new URLSearchParams(m[1].replace(/&amp;/g, '&')), path = q.get('path') || '', agent = q.get('agent') || '';
    if (!REL_PATH.test(path) || !/^[\w.-]{1,80}$/.test(agent)) return null;
    return { path, attrs: ' data-md-agent="' + escapeHtml(agent) + '"' + (q.get('project') ? ' data-md-project="' + escapeHtml(q.get('project')) + '"' : '') };
  }
  function fileRefLink(label, target) {
    const app = appFileRef(target);
    if (!app && !REL_PATH.test(target)) return escapeHtml(label);
    // a link to a picture IS the picture (user reports 10-20: "my agent can't show me the slides" — it linked its JPGs, and a
    // link only opened a tab; the model had no way to know an image needs the '!'), still a click away from the lightbox
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(app ? app.path : target)) return fileRefImage(label, target);
    return '<a class="md-file" href="#" data-md-path="' + escapeHtml(app ? app.path : target) + '"' + (app ? app.attrs : '') + '>' + escapeHtml(label) + '</a>';
  }
  function fileRefImage(alt, target) {
    if (/^https?:\/\//i.test(target)) { const name = alt || target.split('/').pop(); return '<a href="' + escapeHtml(target) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(name) + '</a>' + linkHostNote(name, target); }
    const app = appFileRef(target), path = app ? app.path : target, name = alt || path.split('/').pop();
    if (!app && !REL_PATH.test(target)) return escapeHtml(name);
    return '<span class="md-img" data-md-path="' + escapeHtml(path) + '" data-md-alt="' + escapeHtml(name) + '"' + (app ? app.attrs : '') + '><span class="md-img-alt">' + escapeHtml(name) + '</span></span>';
  }
  // the default resolver: the speaking agent's workspace, through the same open/preview/lightbox seams as every deliverable
  const fileRefCache = new Map();   // message|agent|path -> Promise<blob url>; failures stay cached for that message too
  let fileRefScope = 0;
  function cachedBlob(key, load) {
    if (fileRefCache.has(key)) return fileRefCache.get(key);
    const p = load();   // a missing file is stable within one message; a later message gets a fresh read
    fileRefCache.set(key, p);
    if (fileRefCache.size > 60) { const [old, op] = fileRefCache.entries().next().value; fileRefCache.delete(old); op.then(u => { try { URL.revokeObjectURL(u); } catch (_) {} }, () => {}); }
    return p;
  }
  // fetch an image for an <img>: the file routes serve .svg as a download (application/octet-stream / text/plain, so it can
  // never run as a page) — an <img> never runs script, so the blob is retyped to image/svg+xml purely so it decodes
  function imageBlobUrl(url, path) {
    return fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('file HTTP ' + r.status); return r.blob(); })
      .then(b => URL.createObjectURL(/\.svg$/i.test(String(path || '')) && b.type !== 'image/svg+xml' ? new Blob([b], { type: 'image/svg+xml' }) : b));
  }
  function workspaceFileRefs(agentId, messageKey, projectRoot) {
    const scope = messageKey == null ? 'body:' + (++fileRefScope) : String(messageKey);
    return {
      wire: (a, path) => wireFileOpen(a, path, agentId || attachAgentId(), projectRoot),
      image: path => { const aid = agentId || attachAgentId(); return cachedBlob(scope + '|' + aid + '|' + (projectRoot || '') + '|' + path, () => imageBlobUrl(fileUrl(path, aid, projectRoot), path)); }
    };
  }
  /* WHERE A COMMS REPLY'S FILES LIVE: where the run that wrote them put them. A run sent with a project root wrote its
     relative files AT that root; a run sent without one wrote them in its agent's own workspace. A session can join a
     project mid-conversation (a path.trust ALWAYS anchors it), so the session's CURRENT root says nothing about an
     earlier reply: send() stamps every reply it persists with the root its run was sent with (projectRoot: string, or
     null for none), and a WORK LINE stage is stamped null (the hop's Harness.chat sends no root) whoever ran it.
     turn = a history turn, or a live reply's { agentId, projectRoot }. agentId = the stamped speaker (none = session agent). */
  function turnFileRefs(turn) {
    const t = turn || {};
    const sessionAgent = (activeWs && activeWs.agentId) || null;
    const own = !t.agentId || t.agentId === (sessionAgent || 'agent');
    return workspaceFileRefs(own ? sessionAgent : t.agentId, null, turnProjectRoot(t, own) || undefined);
  }
  function turnProjectRoot(t, own) {
    if (t.projectRoot !== undefined) return t.projectRoot || '';   // the turn's own record of its run
    if (!own) return '';   // an older work-line stage of another agent: a hop never ran with the root
    // An unstamped reply (an older build, or a turn the server filled in): the session root only when the reply is
    // newer than the moment the session joined that project; with no record of that moment, the agent's workspace.
    const root = activeWs && activeWs.projectRoot, at = Number(activeWs && activeWs.projectRootAt);
    return root && at > 0 && Number(t.ts) >= at ? root : '';
  }
  // roots (optional) = the nodes to hydrate instead of the whole body: a live reply's re-drawn blocks (renderProseLive) — its
  // kept blocks were wired when they were drawn, and wiring a link twice would open it twice
  function hydrateFileRefs(bodyEl, roots) {
    const within = roots || [bodyEl];
    if (!within.some(r => r.querySelector && r.querySelector('.md-file, .md-img'))) return;
    const bodyRefs = bodyEl.__fileRefs || (bodyEl.__fileRefs = workspaceFileRefs(null));
    // a ref read from the app's own /api/file address names its agent (and project): it resolves there, not in the body's
    const refsOf = n => n.hasAttribute('data-md-agent') ? workspaceFileRefs(n.getAttribute('data-md-agent'), null, n.getAttribute('data-md-project') || undefined) : bodyRefs;
    const all = sel => within.reduce((out, r) => (r.querySelectorAll ? out.concat(Array.from(r.querySelectorAll(sel))) : out), []);
    all('a.md-file').forEach(a => { try { refsOf(a).wire(a, a.getAttribute('data-md-path')); } catch (_) {} });
    all('.md-img:not([data-ready])').forEach(box => {
      const path = box.getAttribute('data-md-path'), alt = box.getAttribute('data-md-alt') || path, refs = refsOf(box);
      box.setAttribute('data-ready', 'loading');   // carry pending and failed slots across streaming re-renders too
      const link = document.createElement('a'); link.className = 'thumb md-thumb'; link.href = '#'; link.setAttribute('aria-label', 'Enlarge ' + alt);
      const img = document.createElement('img'); img.alt = alt; img.decoding = 'async';
      link.appendChild(img);
      link.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); openLightbox(() => refs.image(path), alt, { revoke: false }); });
      /* An image that decodes AFTER the transcript pinned itself to the bottom grows the log; the browser's scroll anchoring
         then holds the old offset, the reader drifts off the bottom and the "new messages" pill lies about them scrolling up.
         If the reader was following the conversation, follow the image too. */
      // (the transcript is looked up when it matters, not at render time: a replayed or streaming body may not be attached yet)
      const hostOf = n => (n && n.closest) ? n.closest('#chat-log, #gc-log') : null;
      img.addEventListener('load', () => {
        const host = hostOf(link); if (!host) return;
        const following = host === log ? (stick || historyPinPending) : host.__mdWasAtBottom;
        if (following) { host.scrollTop = host.scrollHeight; if (host === log) hideNewPill(); }
      });
      Promise.resolve().then(() => refs.image(path)).then(u => {
        const host = hostOf(box);
        if (host) host.__mdWasAtBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
        img.src = u; box.replaceChildren(link); box.setAttribute('data-ready', '1');
      }, () => {
        box.setAttribute('data-ready', 'missing');
        box.classList.add('md-img-missing');   // not on disk (or not shared): say so instead of a broken frame
        box.querySelector('.md-img-alt').textContent = alt + ' — image not found';
      });
    });
  }
  function reportInline(raw) {
    // Tokenize raw text before escaping; generated markup never enters another pass.
    const re = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s<>"']+)\)|\*\*([^*\n]+)\*\*|!\[([^\]\n]*)\]\(([^)\s<>"']+)\)|\[([^\]\n]+)\]\(([^)\s<>"']+)\)|\*(?![\s*])([^*\n]*?[^\s*\\])\*(?![*\w])|https?:\/\/[^\s<>"']+/g;
    let out='',last=0,m;
    while((m=re.exec(raw))) {
      // *italic* opens only where a word does not (no lookbehind — older macOS WebKit cannot parse one): "2*3*4" and
      // "file*name*" keep their asterisks; the scan resumes one character on so a real *italic* later still matches
      if(m[9]!==undefined && m.index>0 && /[\w*]/.test(raw[m.index-1])){re.lastIndex=m.index+1;continue;}
      out+=escapeHtml(raw.slice(last,m.index));
      // A code span that IS a URL (`http://localhost:8765`) stays code-styled but clickable: models
      // backtick server addresses constantly, and a dead address costs the user a copy-paste.
      if(m[1]!==undefined){const code='<code class="md-code">'+escapeHtml(m[1])+'</code>';out+=/^https?:\/\/[^\s<>"'`]+$/.test(m[1])?'<a href="'+escapeHtml(m[1])+'" target="_blank" rel="noopener noreferrer">'+code+'</a>':code;}
      else if(m[2]!==undefined)out+='<a href="'+escapeHtml(m[3])+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(m[2])+'</a>'+linkHostNote(m[2],m[3]);
      // bold holds no '*', so its inside can be read again for code, [label](url) and bare links (QA 2026-10-02: **`npm run dev`**
      // showed its backticks, **[docs](url)** showed '[docs](' around a bare link); reportInline escapes everything it emits
      else if(m[4]!==undefined)out+='<span class="md-b">'+reportInline(m[4])+'</span>';
      else if(m[6]!==undefined)out+=fileRefImage(m[5],m[6]);
      else if(m[8]!==undefined)out+=fileRefLink(m[7],m[8]);
      // *italic* (rc walk 2026-10-14: "*speed*", "*does*" sat in replies with their asterisks) — like bold, its inside holds no
      // '*' and is read again for code and links
      else if(m[9]!==undefined)out+='<span class="md-i">'+reportInline(m[9])+'</span>';
      else out+=linkify(m[0]);
      last=re.lastIndex;
    }
    return out+escapeHtml(raw.slice(last));
  }
  /* A STREAMING REPLY RE-PARSES ONLY ITS OPEN END (perf p5, 2026-10-20: "eats my PC's resources"). The live paragraph was
     re-parsed whole and rebuilt through innerHTML on every frame — O(n) per frame, O(n²) per answer, and a 20 KB reply cost
     ~2 ms of parsing alone each frame before the DOM rebuild. Every line the parse reads, and every "is there a line here?"
     check, raises `seen`; at each top-level step with no paragraph open the parse leaves a mark {i, n: blocks so far, seen}.
     Everything before a mark was decided by lines 0..seen alone, so on the next frame (live = { prev }) the parse resumes
     from the last mark whose lines are unchanged and keeps the blocks before it: the same HTML, block for block, as a full
     parse (locked by test/live-markdown-incremental.test.js). live.next carries this frame's parse, live.kept the number of
     blocks that stayed. Without `live` this is the plain renderer it always was. */
  function renderMarkdown(raw, live) {
    const norm=String(raw).replace(/\r\n?/g,'\n'), lines=norm.split('\n');
    let seen=-1;
    const at=x=>{if(x>seen)seen=x;return lines[x];};
    const has=(x,to)=>{if(x>seen)seen=x;return x<to;};
    // Older macOS WebKit cannot PARSE lookbehind, even in a function not yet called.
    // Consume escaped pipes before splitting; retain the existing immediate-backslash semantics.
    const cells = line => {
      const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      const result = []; let cell = '';
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; }
        else if (text[i] === '|') { result.push(cell.trim()); cell = ''; }
        else cell += text[i];
      }
      result.push(cell.trim());
      return result;
    };
    const listMatch=line=>/^([ \t]*)([-*+][ \t]+|\d+[.)][ \t]+)(.*)$/.exec(line);
    // marks (top level of a live parse only): where the parse may resume; out: the blocks so far (a resumed parse's kept ones)
    function blocks(from,to,depth,marks,out) {
      const parts=out||[],paragraph=[];let i=from;
      const flushParagraph=()=>{
        if(paragraph.length)parts.push('<span class="md-p">'+paragraph.splice(0).join('\n')+'</span>');
      };
      for(;;) {
        if(marks && !paragraph.length)marks.push({i,n:parts.length,seen});
        if(!has(i,to))break;
        const ln=at(i);
        if(!ln.trim()){flushParagraph();i++;continue;}
        if(/^[ \t]*```/.test(ln)) {
          flushParagraph();
          const code=[];i++;
          while(has(i,to) && !/^[ \t]*```/.test(at(i)))code.push(at(i++));
          if(has(i,to))i++;parts.push(renderFence(code));continue;
        }
        const h=/^(#{1,6})\s+(.*)$/.exec(ln);
        if(h){flushParagraph();parts.push('<span class="md-h" role="heading" aria-level="'+h[1].length+'">'+reportInline(h[2])+'</span>');i++;continue;}
        if(/^\s*>/.test(ln)) {
          flushParagraph();
          const quote=[];
          while(has(i,to) && /^\s*>/.test(at(i)))quote.push(reportInline(at(i++).replace(/^\s*> ?/,'')));
          parts.push('<blockquote class="md-quote">'+quote.join('<br>')+'</blockquote>');continue;
        }
        if(has(i+1,to) && ln.includes('|') && cells(at(i+1)).length>1 && cells(at(i+1)).every(c=>/^:?-{3,}:?$/.test(c))) {
          flushParagraph();
          const headers=cells(ln);i+=2;
          let table='<div class="md-table-scroll" tabindex="0" role="region" aria-label="Report table"><table class="md-table"><thead><tr>'+headers.map(c=>'<th scope="col">'+reportInline(c)+'</th>').join('')+'</tr></thead><tbody>';
          while(has(i,to) && at(i).includes('|') && at(i).trim())table+='<tr>'+cells(at(i++)).map(c=>'<td>'+reportInline(c)+'</td>').join('')+'</tr>';
          parts.push(table+'</tbody></table></div>');continue;
        }
        const first=listMatch(ln);
        if(first && depth<16) {
          flushParagraph();
          const indent=first[1].replace(/\t/g,'    ').length;
          const ordered=/\d/.test(first[2]),tag=ordered?'ol':'ul';
          let list='<'+tag+' class="md-list"'+(ordered?' start="'+parseInt(first[2],10)+'"':'')+'>';
          while(has(i,to)) {
            // Loose Markdown lists remain one list; blank separators are not visible rows.
            let next=i;
            while(has(next,to) && !at(next).trim())next++;
            const following=has(next,to) && listMatch(at(next));
            if(following && following[1].replace(/\t/g,'    ').length===indent && /\d/.test(following[2])===ordered)i=next;
            const item=listMatch(at(i));
            if(!item || item[1].replace(/\t/g,'    ').length!==indent || /\d/.test(item[2])!==ordered)break;
            list+='<li>'+reportInline(item[3]);i++;
            const begin=i;
            while(has(i,to)) {
              let continuation=i;
              while(has(continuation,to) && !at(continuation).trim())continuation++;
              if(!has(continuation,to) || !/^[ \t]/.test(at(continuation)) || at(continuation).match(/^[ \t]*/)[0].replace(/\t/g,'    ').length<=indent)break;
              i=continuation+1;
            }
            if(i>begin)list+=blocks(begin,i,depth+1);
            list+='</li>';
          }
          parts.push(list+'</'+tag+'>');continue;
        }
        paragraph.push(reportInline(depth ? ln.trimStart() : ln));i++;
      }
      flushParagraph();
      return parts.join('');
    }
    if(!live)return blocks(0,lines.length,0);
    // the first line that differs from the previous frame's (a streamed token only ever touches the last one)
    const prev=live.prev;let mark={i:0,n:0,seen:-1},marks=[],kept=[];
    if(prev) {
      let d=0;
      if(norm.startsWith(prev.norm))d=(norm.length===prev.norm.length||norm.charCodeAt(prev.norm.length)===10)?prev.lines.length:prev.lines.length-1;
      else{const end=Math.min(prev.lines.length,lines.length);while(d<end&&prev.lines[d]===lines[d])d++;}
      for(let k=prev.marks.length-1;k>=0;k--)if(prev.marks[k].seen<d){mark=prev.marks[k];marks=prev.marks.slice(0,k);kept=prev.parts.slice(0,mark.n);break;}
    }
    seen=mark.seen;
    const html=blocks(mark.i,lines.length,0,marks,kept);
    live.next={norm,lines,marks,parts:kept};live.kept=mark.n;
    return html;
  }
  // render agent prose into a body span. Fast textContent path when there's no URL AND no markdown marker (the
  // common streamed token) — no per-token HTML reparse; otherwise the escaped+linkified+markdown pipeline.
  function renderProse(bodyEl, raw, opts) {
    if (!bodyEl) return;
    raw = String(raw == null ? '' : raw);
    bodyEl.__proseSource = raw;
    if (opts && opts.files) bodyEl.__fileRefs = opts.files;   // where this body's relative file links resolve (kept across re-renders)
    const prior = bodyEl.__mdLive; bodyEl.__mdLive = null;   // a streaming reply's previous frame (renderProseLive), kept only while it streams
    if (raw.indexOf('http') === -1 && !MD_MARKERS.test(raw)) { bodyEl.textContent = raw; return; }
    if ((opts && opts.live) || prior) { renderProseLive(bodyEl, raw, prior, !!(opts && opts.live)); return; }
    // a streaming reply re-renders every frame: carry an image that already loaded into the new markup instead of
    // rebuilding it (a rebuilt <img> collapses and re-grows each frame — flicker, and the log jumps under the reader)
    const shown = new Map();
    if (bodyEl.querySelectorAll) bodyEl.querySelectorAll('.md-img[data-ready]').forEach(n => { const k = n.getAttribute('data-md-path'); if (!shown.has(k)) shown.set(k, n); });
    bodyEl.innerHTML = renderMarkdown(raw);
    if (shown.size) bodyEl.querySelectorAll('.md-img:not([data-ready])').forEach(n => { const k = n.getAttribute('data-md-path'), old = shown.get(k); if (old) { n.replaceWith(old); shown.delete(k); } });
    hydrateFileRefs(bodyEl);
  }
  /* A LIVE REPLY'S FRAME (renderProse with opts.live — the streaming paragraph). The blocks renderMarkdown kept (live.kept) keep
     their DOM nodes, so a link, a loaded picture or a selection in an earlier block survives the next token; only the blocks
     after them are drawn again, from the same markup a full render makes. Every block is one element, so the body's children
     map one to one onto the parse's blocks. prior = the previous frame's { md, nodes }, good only while the body still holds
     exactly those nodes (anything else drew into it: draw it all). keep = hold this frame for the next (false on the closing
     render, which frees it). */
  function renderProseLive(bodyEl, raw, prior, keep) {
    const kids = bodyEl.childNodes;
    const ok = !!prior && prior.nodes.length === kids.length && prior.nodes.every((n, k) => n === kids[k]);
    const live = { prev: ok ? prior.md : null };
    renderMarkdown(raw, live);
    const md = live.next, from = ok ? live.kept : 0;
    const gone = ok ? prior.nodes.slice(from) : Array.from(kids);
    // an image that already loaded keeps its node when its block is drawn again (the full render's carry-over, above)
    const shown = new Map();
    for (const r of (ok ? gone : [bodyEl])) if (r.querySelectorAll) r.querySelectorAll('.md-img[data-ready]').forEach(n => { const k = n.getAttribute('data-md-path'); if (!shown.has(k)) shown.set(k, n); });
    for (const n of gone) bodyEl.removeChild(n);
    const before = kids.length;
    bodyEl.insertAdjacentHTML('beforeend', md.parts.slice(from).join(''));
    const added = Array.from(kids).slice(before);
    if (shown.size) for (const r of added) if (r.querySelectorAll) r.querySelectorAll('.md-img:not([data-ready])').forEach(n => { const k = n.getAttribute('data-md-path'), old = shown.get(k); if (old) { n.replaceWith(old); shown.delete(k); } });
    hydrateFileRefs(bodyEl, added);
    if (keep && added.length === md.parts.length - from) bodyEl.__mdLive = { md, nodes: (ok ? prior.nodes.slice(0, from) : []).concat(added) };
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
    receiptShown.clear(); receiptFetching.clear(); clearChoices(); turninQueue.length = 0; activeTurnin = null; wiQDepth.clear(); queued.clear(); sentNow.clear(); heldBack.clear(); interrupted.clear();   // C2: per-session run-tracking + the queue gauge + turn-control state start clean for each agent (listeners stay once-registered)
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
        /* ONLY THE COMMANDER UNSTICKS (2026-10-10). A scroll event also fires when the BROWSER moves the log — a reply
           image decoding, a row re-rendering, scroll anchoring holding an old offset — and reading every one of those as
           "they scrolled up" stopped the follow mid-reply and lit "new messages" over a conversation nobody had left.
           Now: at the bottom = following; off the bottom right after a real gesture (wheel/touch/scrollbar/keys) =
           reading history; off the bottom with NO gesture = layout moved under a follower, so follow it back down. */
        const near = nearBottom();
        if (near) stick = true;
        else if (userScrollHeld || Date.now() - userScrollAt < 1200) stick = false;
        else if (stick) log.scrollTop = log.scrollHeight;
        // …and the same inside the near band: an approval card shrinking as its keys leave moved a follower ~34 px up and left
        // the working line cut off under the fold (live walk 10-14). No gesture, still following: back to the newest line.
        if (near && stick && !userScrollHeld && Date.now() - userScrollAt >= 1200 && log.scrollHeight - log.scrollTop - log.clientHeight > 1) log.scrollTop = log.scrollHeight;
        if (stick) hideNewPill(); else showNewPill(false);
      });   // at the bottom → retire the pill; scrolled up → a persistent "↓ latest" affordance
      // A real attempt to inspect history wins even during the two-frame settle window.
      ['wheel', 'touchstart', 'pointerdown'].forEach(type => log.addEventListener(type, cancelHistoryPin, { passive: true }));
      ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(type => log.addEventListener(type, forgetReveal, { passive: true }));   // …and their own reading (keys too: PageUp/arrows) wins over an earlier reveal
      ['wheel', 'touchmove'].forEach(type => log.addEventListener(type, () => { userScrollAt = Date.now(); }, { passive: true }));
      ['touchstart', 'pointerdown', 'keydown'].forEach(type => log.addEventListener(type, logGesture, { passive: true }));   // a press on a key in the log is not reading history
      log.addEventListener('pointerdown', logHold, { passive: true });
      if (!window.__chatScrollReleaseWired) {
        window.__chatScrollReleaseWired = true;
        ['pointerup', 'pointercancel', 'blur'].forEach(type => window.addEventListener(type, endLogHold, { passive: true }));
      }
    }
    // LINKS OUTSIDE COMMS (QA 2026-10-02): group chats, a group's .md file preview and the WORKFLOWS results render through
    // this same renderProse, but the OS-browser hand-off below lives on #chat-log only — so on desktop those links were dead
    // (a target=_blank <a> goes nowhere under the Tauri window policy). One document-level handler, wired once, covers them.
    if (typeof document !== 'undefined' && !document.__proseLinksWired) {
      document.__proseLinksWired = true;
      document.addEventListener('click', e => {
        if (e.defaultPrevented || !e.target || !e.target.closest) return;
        const link = e.target.closest('#gc-log a, #gc-preview a, .wf-md a');
        if (!link || !/^https?:\/\//i.test(link.getAttribute('href') || '')) return;
        if (window.getSelection && String(window.getSelection())) { e.preventDefault(); return; }   // ending a text selection never opens a link
        const invoke = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core.invoke : null;
        if (!invoke) return;   // a plain browser: target=_blank works as is
        e.preventDefault();
        invoke('open_external_url', { url: link.href }).catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open your browser for that link', 'warn'); });
      });
    }
    // CODE BLOCKS OUTSIDE COMMS (walk 10-14): the WORKFLOWS results, the Workflow panel and DELIVERABLES draw replies through this
    // renderProse too (.wf-md), and a fenced block's ⧉ key there copies that block exactly as it does in COMMS — wired once.
    if (typeof document !== 'undefined' && !document.__proseCopyWired) {
      document.__proseCopyWired = true;
      document.addEventListener('click', e => {
        const codeBtn = (e.target && e.target.closest) ? e.target.closest('.wf-md .md-copy') : null;
        if (!codeBtn) return;
        const wrap = codeBtn.closest('.md-pre-wrap'), codeEl = wrap && wrap.querySelector('.md-pre');
        if (codeEl) copyText(codeEl.textContent || '').then(ok => showCopyResult(codeBtn, ok));
      });
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
        if (chipHead) { if (selecting) return; toggleChip(chipHead); if (typeof SFX !== 'undefined' && SFX.press) SFX.press(); return; }
        // FENCED CODE: each block owns a copy control. Resolve the text from that exact wrapper so one click
        // never sweeps up the surrounding prose or a neighboring block in the same response.
        const codeBtn = e.target.closest('.md-copy');
        if (codeBtn) {
          const wrap = codeBtn.closest('.md-pre-wrap');
          const codeEl = wrap && wrap.querySelector('.md-pre');
          if (!codeEl) return;
          copyText(codeEl.textContent || '').then(ok => {
            showCopyResult(codeBtn, ok);
            if (ok && typeof SFX !== 'undefined' && SFX.press) SFX.press();
          });
          return;
        }
        const btn = e.target.closest('.cmsg-copy'); if (!btn) return;
        const bodyEl = btn.closest('.cmsg') && btn.closest('.cmsg').querySelector('.body');
        const txt = messageCopyText(bodyEl);
        if (!txt) return;
        copyText(txt).then(ok => {
          showCopyResult(btn, ok);
          if (ok && typeof SFX !== 'undefined' && SFX.press) SFX.press();
        });
      });
    }
    input.value = '';
    autoGrowInput();   // COMPOSER: settle the textarea at its resting one-line height
    warmSlashCatalog();
    wireProposals();   // Cortex turn-in beat: listen for reflection's memory.proposed (registers once)
    wireStudy();       // GROWTH Tier 1: after a salient run, offer ≤1 dossier belief-update at turn-in priority (registers once)
    wireBriefRead();   // TASTE EXTRACTION: the announce-and-act READ card (taskbrief.settled → correctable assumptions; registers once)
    wireVoiceRouteNotice();   // a spoken turn that could not use the VOICE CHAT MODEL says so once
    wireWaitNotes();   // LIVE WAIT LINE: provider.retry / agent.waiting → the presence card's transient line (registers once)
    wireTrust();       // GROWTH Tier 3: after a clean run, offer ONE earned-autonomy raise at the LOWEST beat priority — below the arc (registers once)
    wireThreads();     // NS-6: after a mined task run, offer ONE thread turn-in (Keep/Edit/Discard) at the lowest beat priority — study wins the moment first (registers once)
    wireCrewCapture(); // P3.2: record each dispatched worker's forwarded run-end spend so a 👍 on a crew run splits XP honestly (registers once)
    wireCuriosity();   // Commander Dossier: one gentle "tell me about X" nudge after a clean run (registers once)
    wireConnectorRequired();   // beginner seam Lane 1: a run that hit an unwired connector earns the ⇄ CONNECT chip
    wireKeySaved();    // keys.save: a key pasted into chat now lives in KEYS — its bubble + saved history show the placeholder (registers once)
    wireBgExit();     // E6: surface shell.bg.exit (a background dev-server/watcher ended) as a terse COMMS system line — was a zero-listener event (registers once)
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
      // @ MENU (group-chat.js) owns ↑ ↓ Enter Tab Esc while it lists agents over the message box
      if (typeof GroupChat !== 'undefined' && GroupChat.mentionKey && GroupChat.mentionKey(e)) return;
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
        stopActive('esc');   // the card then says STOPPED BY YOU (ESC) — an Esc stop must never read as the run quitting
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
    // "@finn take a look" from a DIRECT chat reaches FINN: the chat becomes a group with them first (General stays
    // General — a fresh group opens beside it), then the message goes to that group. A refusal (the agent here is
    // still mid-run, the backend said no) keeps the words in the box and says why.
    const pulled = activeWs && activeWs.conversationMode !== 'group' && t && typeof GroupChat !== 'undefined' && GroupChat.mentionTargets ? GroupChat.mentionTargets(t, activeWs) : [];
    if (pulled.length) {
      const g = await GroupChat.startWith(pulled);
      const ws = g && Workstreams.get(g.id);
      if (!ws || activeWs?.id !== ws.id) return;
      if (hasStaged) await settleAttachments();
      if (activeWs?.id !== ws.id) return;   // you moved on while the files uploaded: the message stays in the box
      const atts = pendingAtts.filter(entry => entry.status === 'ready' && entry.ref).map(entry => entry.ref);
      stepOfferAside('turn');   // a turn typed here never reaches send(): it steps an offer aside the same way (review 10-27)
      const sent = await GroupChat.sendText(t, { attachments: atts, attachmentAgent: ws.agentId });
      if (sent) typedTaskCompletesHandoff(t, ws);
      if (sent && activeWs?.id === ws.id) { takeAttachments(); if (input.value.trim() === t) input.value = ''; closeSlash(); autoGrowInput(); }
      return;
    }
    if (activeWs?.conversationMode === 'group' && typeof GroupChat !== 'undefined') {
      const ws = activeWs;
      if (hasStaged) await settleAttachments();
      if (activeWs?.id !== ws.id || focusVersion !== submissionFocusVersion) return;
      const atts = pendingAtts.filter(entry => entry.status === 'ready' && entry.ref).map(entry => entry.ref);
      stepOfferAside('turn');   // a group turn never reaches send(): it steps an offer aside the same way (review 10-27)
      const sent = await GroupChat.sendText(t, { attachments: atts, attachmentAgent: ws.agentId });
      if (sent) typedTaskCompletesHandoff(t, ws);
      if (sent && activeWs?.id === ws.id) { takeAttachments(); if (input.value.trim() === t) input.value = ''; closeSlash(); autoGrowInput(); }
      return;
    }
    // ANSWER, NOT QUEUE: the run is waiting on one question of its lead's in this conversation — this text is the
    // answer (askAnswerers). Files still wait for the next send; a failed answer keeps the words in the box.
    if (isBusy() && t && !hasStaged && pendingAskFor(activeWs)) {
      const ws = activeWs;
      input.value = ''; closeSlash(); autoGrowInput();
      if (!(await answerPendingAsk(ws, t)) && activeWs === ws && !input.value.trim()) { input.value = t; autoGrowInput(); }
      return;
    }
    // BUSY: type-ahead queues TEXT; staged files wait in the strip for the next idle send (one run per stream).
    // a typed task queued here is the Commander's all the same: it completes a pending first-task hand-off now (the queue later
    // sends it with no composer mark, so send() could not tell it was typed)
    if (isBusy()) { if (t) { input.value = ''; closeSlash(); autoGrowInput(); enqueue(t); stepOfferAside('turn'); typedTaskCompletesHandoff(t, activeWs); } return; }
    // SETTLE UPLOADS: a staged attachment still uploading must not be silently dropped — uploads to the local
    // sidecar are near-instant, so we AWAIT them before snapshotting. A failed one already notified per-file.
    if (hasStaged) await settleAttachments();
    if (activeWs !== submissionWs || focusVersion !== submissionFocusVersion) return;
    const atts = takeAttachments();   // snapshot the READY refs + clear the composer strip
    if (!t && !atts.length) return;   // everything failed to upload and there's no text → nothing to send
    input.value = ''; closeSlash(); autoGrowInput();   // COMPOSER: collapse back to one line after a send
    send(t, { attachments: atts, composer: true });   // composer: the Commander typed this turn (a pending first task reads it)
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
    wireChatDropTarget();
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
  }
  function wireChatDropTarget() {
    const panel = el('chat-panel');
    if (!panel) return;
    if (panel.__resetFileDrop) { panel.__resetFileDrop(); return; }
    const hint = document.createElement('div');
    hint.className = 'chat-drop-hint'; hint.hidden = true;
    hint.textContent = 'Drop files to attach';
    hint.setAttribute('role', 'status');
    panel.appendChild(hint);
    let depth = 0;
    const reset = () => { depth = 0; hint.hidden = true; panel.classList.remove('attach-dragover'); };
    panel.__resetFileDrop = reset;
    // During dragover browsers protect file bytes; inspect types, not just files.length.
    const hasFiles = e => !!(e.dataTransfer && (
      Array.from(e.dataTransfer.types || []).includes('Files') ||
      Array.from(e.dataTransfer.items || []).some(item => item.kind === 'file') ||
      (e.dataTransfer.files && e.dataTransfer.files.length)));
    const available = () => !!(activeWs && input && !input.disabled);
    const show = e => {
      if (!hasFiles(e) || !available()) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      hint.hidden = false; panel.classList.add('attach-dragover');
    };
    panel.addEventListener('dragenter', e => { if (hasFiles(e) && available()) { depth++; show(e); } });
    panel.addEventListener('dragover', show);
    panel.addEventListener('dragleave', e => {
      depth = Math.max(0, depth - 1);
      if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
      if (!depth || (e.relatedTarget && !panel.contains(e.relatedTarget))) reset();
    });
    panel.addEventListener('drop', e => {
      reset();
      if (!hasFiles(e)) return; // Text and links retain normal editing behavior.
      e.preventDefault();
      if (!available()) return;
      const items = Array.from(e.dataTransfer.items || []).filter(item => item.kind === 'file');
      let directories = false;
      const files = items.length ? items.flatMap(item => {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry && entry.isDirectory) { directories = true; return []; }
        const file = item.getAsFile(); return file ? [file] : [];
      }) : Array.from(e.dataTransfer.files || []);
      if (directories && typeof StationUI !== 'undefined' && StationUI.notify) {
        StationUI.notify('Drop individual files; folders cannot be attached.', 'warn');
      }
      if (files.length) { handleFiles(files); input.focus({ preventScroll: true }); }
    });
    // A missed file drop must never navigate away from the station. Capture does not
    // stop propagation, so other file targets can still handle their own drops.
    document.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!panel.contains(e.target) || !available()) { e.dataTransfer.dropEffect = 'none'; reset(); }
    }, true);
    document.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); reset(); }, true);
    document.addEventListener('dragend', reset, true);
    document.addEventListener('dragleave', e => { if (!e.relatedTarget && (e.target === document || e.target === document.documentElement)) reset(); }, true);
    window.addEventListener('blur', reset);
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
      if (typeof SFX !== 'undefined' && SFX.press) SFX.press();
      if (typeof App !== 'undefined' && App.selectAgent) App.selectAgent(id);
      // App.selectAgent → switchWorkstream → Chat.load → renderIdBar, so the model readout follows the switch.
    });
  }

  function mergeCanonicalHistory(local, turns) {
    // Only the canonical final row can supersede saved prose, and only by explicit run identity.
    const finals = new Map(), finalSlots = new Map();
    const sameRun = (a, b) => !!a.sourceRunId && String(a.sourceRunId) === String(b.sourceRunId)
      && (!a.agentId || !b.agentId || a.agentId === b.agentId)
      && (!a.streamId || !b.streamId || a.streamId === b.streamId);
    const withFinal = (prior, canonical) => {
      const row = Object.assign({}, prior, canonical);
      // A rejected attempt's failure flags are evidence, not the accepted answer's status.
      // In particular, error:true would exclude this accepted answer from the next model turn.
      const supersededStatus = Object.assign({}, prior.supersededStatus, canonical.supersededStatus);
      for (const key of ['error', 'stopped', 'stopNote']) {
        if (prior[key] != null) supersededStatus[key] = prior[key];
        delete row[key];
        if (Object.prototype.hasOwnProperty.call(canonical, key)) row[key] = canonical[key];
      }
      if (Object.keys(supersededStatus).length) row.supersededStatus = supersededStatus;
      if (canonical.taint || prior.taint) row.taint = canonical.taint || prior.taint;
      const attachments = [], seen = new Set();
      for (const item of [].concat(prior.attachments || [], canonical.attachments || [])) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) { seen.add(key); attachments.push(item); }
      }
      if (attachments.length) row.attachments = attachments;
      return row;
    };
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (turn && !turn.sys && turn.role === 'assistant' && turn.dispatchState === 'final'
          && turn.sourceRunId && String(turn.content || '').trim() && !finals.has(String(turn.sourceRunId))) finals.set(String(turn.sourceRunId), turn);
    }
    const runParts = new Map();
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!turn || turn.role !== 'assistant' || !turn.sourceRunId) continue;
      const text = String(turn.content || '');
      if (!text.trim()) continue;
      const parts = runParts.get(String(turn.sourceRunId)) || [];
      parts.push(text); runParts.set(String(turn.sourceRunId), parts);
    }
    /* EXPLICIT RUN IDENTITY, HARNESS BYTES ASIDE (rc walk 2026-10-14: a reload showed a reply twice — its durable turns AND
       the page's saved aggregate). The page's aggregate of a run differs from that run's durable turns only by what the
       harness itself adds or removes: the paragraph break streamed after a hidden Task Brief step (loop.js TURN BREAK) and
       the choice marker the chat strips before saving. Only for a row that names its run (an unattributed one stays exact).
       Self-contained (the phone runs this same function): the marker rule is fork.js's — a list number, keyword (MARKER_KEY's
       one case rule), colon, `||` options. */
    const squash = s => String(s == null ? '' : s).replace(/(?:\d{1,2}[.)][ \t]*)?[*_`~]*(?:\bF(?:ORK|ork)|[Tt][Aa][Ss][Kk]_[Qq][Uu][Ee][Ss][Tt][Ii][Oo][Nn])[*_`~]*[ \t]*:[^\n]*\|\|[^\n]*/g, '').replace(/\s+/g, '');
    // A steering note folded mid-run streams into the local reply as a '\n[steering] …\n' line, but the durable
    // transcript stores only the model's own turns. Twins are matched WITHOUT those lines; the local row (which
    // still carries them, so a reload can redraw the note) is the one that survives.
    const steerless = text => String(text || '').replace(/(?:^|\n)\[steering\] [^\n]*\n?/g, '');
    const hasSteer = text => /(?:^|\n)\[steering\] /.test(String(text || ''));
    // the [start, end] run of contiguous parts that joins to exactly `text`, or null
    const joinsTo = (parts, text) => {
      for (let start = 0; start < parts.length - 1; start++) {
        if (!text.startsWith(parts[start])) continue;
        let joined = parts[start];
        for (let end = start + 1; end < parts.length; end++) {
          joined += parts[end];
          if (joined === text) return [start, end];
          if (joined.length >= text.length) break;
        }
      }
      return null;
    };
    // the durable parts this saved aggregate already shows (so a steered row can be enriched by them), or null.
    // A rowId marks a durable row — except on a steered row: the merge that kept it lent it its first part's rowId, and that
    // save is the next load's input (the desk's next open, the phone's every read), so it must find its span again each load.
    const committedAggregate = (row, runId, explicit) => {
      if (row.role !== 'assistant' || (row.rowId && !hasSteer(row.content)) || row.stopped || row.error || (row.attachments && row.attachments.length)) return null;
      const parts = runParts.get(runId) || [], text = steerless(row.content);
      let span = joinsTo(parts, text);
      if (!span && explicit) { const target = squash(text); span = target ? joinsTo(parts.map(squash), target) : null; }
      return span ? parts.slice(span[0], span[1] + 1) : null;
    };
    const kept = [], buckets = new Map();
    let userRunId = '';
    for (let row of Array.isArray(local) ? local : []) {
      if (row && row.sys) { if (!row.transcriptPending) kept.push({ row, key: null }); continue; }
      if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
      const final = row.role === 'assistant' && finals.get(String(row.sourceRunId || ''));
      if (final && sameRun(row, final)) {
        const id = String(final.sourceRunId);
        if (finalSlots.has(id)) {
          const keptRow = kept[finalSlots.get(id)];
          keptRow.row = withFinal(row, keptRow.row);
          continue;
        }
        row = withFinal(row, final);
        finalSlots.set(id, kept.length);
      }
      if (row.role === 'user') userRunId = String(row.sourceRunId || '');
      const aggregate = committedAggregate(row, String(row.sourceRunId || userRunId), !!row.sourceRunId);
      if (aggregate && !hasSteer(row.content)) continue;
      if (aggregate) {   // keep the steered row: each durable part it already shows enriches it instead of re-inserting
        for (const part of aggregate) { const k = 'assistant\u0000' + part, q = buckets.get(k) || []; q.push(kept.length); buckets.set(k, q); }
        kept.push({ row, key: null });
        continue;
      }
      if (row.role === 'assistant' && !String(row.content == null ? '' : row.content).trim()) continue;
      const key = row.role + '\u0000' + (row.role === 'assistant' ? steerless(row.content) : String(row.content || ''));
      const q = buckets.get(key) || []; q.push(kept.length); buckets.set(key, q);
      kept.push({ row, key });
    }
    const internalTranscriptPrompt = text => /^Shared conversation context \(/.test(text) || /^\[BEGIN EXTERNAL SCREEN CAPTURE/.test(text);
    const inserts = new Map();
    let anchor = -1;
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      const content = String(turn.content == null ? '' : turn.content);
      if (turn.role === 'assistant' && !content.trim()) continue;
      const key = turn.role + '\u0000' + content;
      const q = buckets.get(key), authoritative = turn.role === 'assistant' && turn.dispatchState === 'final' && finals.get(String(turn.sourceRunId || '')) === turn;
      // A matching sentence from another run must never acquire this dispatch's identity.
      const at = q ? q.findIndex(i => authoritative ? sameRun(kept[i].row, turn)
        : finalSlots.get(String(kept[i].row.sourceRunId || '')) !== i) : -1;
      const idx = at >= 0 ? q.splice(at, 1)[0] : -1;
      if (idx >= 0) {
        const prior = kept[idx].row;
        kept[idx].row = authoritative ? withFinal(prior, turn) : Object.assign({}, turn, prior, { role: turn.role, content: hasSteer(prior.content) ? prior.content : content, ts: turn.ts != null ? turn.ts : prior.ts });
        anchor = idx;
        continue;
      }
      if (turn.role === 'user' && internalTranscriptPrompt(content)) continue;
      const list = inserts.get(anchor) || []; list.push(Object.assign({}, turn, { role: turn.role, content })); inserts.set(anchor, list);
    }
    const merged = [];
    for (const turn of inserts.get(-1) || []) merged.push(turn);
    for (let i = 0; i < kept.length; i++) {
      merged.push(kept[i].row);
      const list = inserts.get(i) || [], run = String(kept[i].row.sourceRunId || '');
      /* A RUN KEEPS ITS OWN STATION ROWS (SEND NOW reload lane, 2026-10-14): a reload mid-run saves no copy of that run's
         directive, so the transcript inserts it here, after the last row it matched — which put the NEXT run's directive
         between an earlier run and the steer echo filed for it. This row's run gets its own inserted turns first, then
         the station rows of the same run that follow it, then everyone else's. */
      let k = 0;
      if (run) while (k < list.length && String(list[k].sourceRunId || '') === run) merged.push(list[k++]);
      while (run && k < list.length && i + 1 < kept.length && kept[i + 1].row.sys && String(kept[i + 1].row.sourceRunId || '') === run && !(inserts.get(i + 1) || []).length) merged.push(kept[++i].row);
      for (; k < list.length; k++) merged.push(list[k]);
    }
    return merged;
  }

  // One owner per session read. Scroll pin lifetime is not history-load lifetime:
  // the pin settles after a frame, while a transcript may arrive seconds later.
  const historyLoads = new WeakMap();
  const continuityEvents = [];
  const continuitySessions = new WeakMap();
  let continuitySessionSeq = 0;
  function noteContinuity(ws, event) {
    if (!ws) return;
    if (!continuitySessions.has(ws)) continuitySessions.set(ws, ++continuitySessionSeq);
    // Page-local numeric identities only: never titles, messages, paths or credentials.
    continuityEvents.push({ at: Date.now(), session: continuitySessions.get(ws), event });
    if (continuityEvents.length > 64) continuityEvents.shift();
  }
  function continuityDiagnostics() { return continuityEvents.map(e => ({ ...e })); }
  function loadServerHistory(ws, loadToken, timeoutMs) {
    if (!ws || !ws.id) return Promise.resolve(false);
    const read = { history: ws.history, promise: null, timeoutMs: timeoutMs > 0 ? timeoutMs : 0, retryable: false, serverFailed: false };   // 0 = the open-time 8 s window
    historyLoads.set(ws, read);
    noteContinuity(ws, 'history-loading');
    read.promise = reconcileServerHistory(ws, loadToken, read);
    return read.promise;
  }

  /* THE FIRST MESSAGE AFTER A RESTART (soak S2, 2026-10-15). Opening a conversation reads its history once, in an 8 s
     window. Right after a station restart the sidecar can take longer than that to answer (the soak's own API calls
     took 5-11 s in the first seconds after boot, 0.5 s once warm), so that read can time out — and the FIRST send then
     awaited the already-settled failure and refused ("history could not be restored") without asking the station
     again; no run started. A send now asks again while the station has not answered: a fresh read, a longer window
     per read (a busy boot answers late, not never), short backoff between unanswered reads, all inside one bounded
     wait. The message is admitted only once a read REALLY answered (never on a guess), exactly once (admission
     happens before the run is requested, so a retry can never double-send). STOP or a removed conversation ends the
     wait at once; a station that never answers still ends in the same honest refusal, message kept; a refusal the
     station answered on purpose (4xx) is final. The COMMS status stays 'connecting…' throughout — no run exists yet.
     A SERVER ERROR IS AN ANSWER (night-sr-fix, 2026-10-15): a station that answers every read at once with a 5xx (a
     degraded station's 503, a broken transcript store's 500) is not silent, and asking it again every 1-4 s only held
     the message at 'connecting…' for the whole 45 s bound against identical answers (test/session-reliability.e2e
     hung its 30 s page evaluate on that wait). It gets ONE fresh ask — the failure this send found may predate it —
     and then the same honest refusal at once, message kept; the backoff stays for reads that got no answer at all. */
  const HISTORY_SEND_READ_MS = 20000;    // one send-time read's window (an open-time read keeps 8 s: reconcileServerHistory)
  const HISTORY_SEND_WAIT_MS = 45000;    // the whole wait a send gives an unanswered history before it refuses
  function changedBeforeSending() { return new Error('Conversation changed before sending.'); }
  // Wait for a promise, but let the send's own abort (STOP) end the wait at once. The read itself is shared with the
  // open-time load and keeps its own owner rules; only this send stops waiting on it.
  function untilAborted(promise, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(changedBeforeSending()); return; }
      const changed = () => reject(changedBeforeSending());
      signal.addEventListener('abort', changed, { once: true });
      promise.then(v => { signal.removeEventListener('abort', changed); resolve(v); },
        e => { signal.removeEventListener('abort', changed); reject(e); });
    });
  }

  async function ensureHistoryReady(ws, signal) {
    const deadline = Date.now() + HISTORY_SEND_WAIT_MS;
    let asked = 0, read = null;
    for (;;) {
      read = historyLoads.get(ws);
      if (!read || !read.promise) {
        loadServerHistory(ws, historyPinSeq, Math.max(1000, Math.min(HISTORY_SEND_READ_MS, deadline - Date.now())));
        read = historyLoads.get(ws); asked++;
      }
      let ready = await untilAborted(read.promise, signal);
      // A second open can supersede the request while this turn waits. Follow the
      // latest owner, never admit inference on a previous visit's settled promise.
      while (historyLoads.get(ws) !== read) {
        if (signal.aborted) throw changedBeforeSending();
        read = historyLoads.get(ws);
        ready = await untilAborted(read.promise, signal);
      }
      if (ready) break;
      if (historyLoads.get(ws) === read) read.promise = null;
      if (signal.aborted || (typeof Workstreams !== 'undefined' && Workstreams.get(ws.id) !== ws)) throw changedBeforeSending();
      // a settled failure from before this send (the open-time read) is asked again at once; this send's own
      // unanswered reads back off 1 s, 2 s, then 4 s. A server error answering this send's own read is final.
      const pause = asked ? Math.min(4000, 500 * Math.pow(2, asked)) : 0;
      const askAgain = read.retryable || (read.serverFailed && !asked);
      if (!askAgain || Date.now() + pause >= deadline) {
        noteContinuity(ws, 'send-held-history-unavailable');
        throw Object.assign(new Error('Conversation history could not be restored. Your message is kept; try again when the connection returns.'), { code: 'HISTORY_UNAVAILABLE' });
      }
      noteContinuity(ws, 'send-history-retry');
      if (pause) await untilAborted(new Promise(resolve => setTimeout(resolve, pause)), signal);
    }
    if (signal.aborted || (typeof Workstreams !== 'undefined' && Workstreams.get(ws.id) !== ws)) throw changedBeforeSending();
    noteContinuity(ws, 'send-history-ready');
    return read;
  }

  /* THE DESK REDACTS ITS COPY BEFORE IT MERGES, as the phone does (remote/host.js mergedTurns; wave 1 qw18, 10-27). The
     save is raw and the station redacts each row it writes, so a turn holding a secret never keyed equal: it showed twice,
     raw copy kept. When the station's rows carry a redaction, the station redacts this copy's turn texts with the store's
     own redact (the page has none). A row it holds then merges as ONE turn, redacted; a row it does not hold (this send's
     own turn) stays as typed.
     TYPED FIRST (review, 10-27): a station row keeps the redaction of its day, so a value held only later is raw there
     and today's redaction of the copy missed it (twice, then once more per open). The copy merges as typed first; only
     rows left unmatched are asked and keyed redacted, so a row that matched as typed (a steered reply holding its parts
     included) is never re-keyed. At most REDACT_ASK_MAX texts go, newest first, within REDACT_ASK_CHARS of JSON (the
     route takes 500 and 8 MB); a row past that merges as typed. THE RETRY TARGET (the newest directive with no answer
     after it) keeps the Commander's words, as one row, since retryLast re-sends it; the next open after an answer
     redacts it. */
  const REDACT_ASK_MAX = 400;          // a station read returns at most 200 turns
  const REDACT_ASK_CHARS = 2000000;    // at most 6 MB of UTF-8
  function redactAsk(rows) {
    const texts = [], seen = new Set();
    let chars = 0;
    for (let i = rows.length - 1; i >= 0 && texts.length < REDACT_ASK_MAX; i--) {
      const t = rows[i].content, size = JSON.stringify(t).length + 1;
      if (seen.has(t) || chars + size > REDACT_ASK_CHARS) continue;
      seen.add(t); chars += size; texts.push(t);
    }
    return texts;
  }
  // -> Map(raw -> redacted), or false (no answer in the window: the merge runs on the raw copy, as before)
  async function redactedTexts(texts, ms) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), ms);
    try {
      const r = await fetch('/api/transcript/redact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts }), cache: 'no-store', signal: controller.signal });
      const j = r.ok ? await r.json() : null;
      return !!j && Array.isArray(j.texts) && j.texts.length === texts.length && new Map(texts.map((t, i) => [t, String(j.texts[i])]));
    } catch (_) { return false; } finally { clearTimeout(timeout); }
  }

  async function reconcileServerHistory(ws, loadToken, read) {
    if (!ws || !ws.id) return;
    const cronSession = String(ws.id).indexOf('cron-') === 0;
    const startedAt = Date.now(), windowMs = read.timeoutMs > 0 ? read.timeoutMs : 8000;   // a send's read may wait longer (ensureHistoryReady)
    let busy = false;
    try { busy = typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(ws.id); } catch (_) {}
    const waits = cronSession && !busy ? [120, 400] : [];
    let turns = [], reachable = false, refused = false, failed = false;
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), windowMs);
      try {
        const r = await fetch('/api/transcript?agent=' + encodeURIComponent(ws.agentId || 'agent') + '&stream=' + encodeURIComponent(ws.id) + '&limit=200', { cache: 'no-store', signal: controller.signal });
        refused = !r.ok && r.status >= 400 && r.status < 500;   // the station answered "no": asking again cannot change it
        failed = !r.ok && r.status >= 500;                       // the station answered "broken": an answer, not silence
        if (r.ok) {
          const j = (await r.json()) || {};
          if (!Array.isArray(j.turns)) break; // malformed is unknown, never an empty transcript
          turns = j.turns;
          reachable = true;
          if (!cronSession || turns.some(t => t && t.role === 'assistant' && String(t.content == null ? '' : t.content).trim())) break;
        }
      } catch (_) { refused = failed = false; /* no answer (timeout / connection): retry the bounded cron persistence window below */ }
      finally { clearTimeout(timeout); }
      if (attempt < waits.length) await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
    read.retryable = !reachable && !refused && !failed;   // unanswered (or unreadable) — a send may keep asking (ensureHistoryReady)
    read.serverFailed = !reachable && failed;              // answered 5xx — a send asks once more, then refuses (ensureHistoryReady)
    // A superseded read, removed session or deliberate clear cannot write back.
    const stale = () => historyLoads.get(ws) !== read || (typeof Workstreams !== 'undefined' && Workstreams.get(ws.id) !== ws)
      || (read.history.length && !ws.history.length);
    if (stale()) { noteContinuity(ws, 'history-stale-discarded'); return false; }
    noteContinuity(ws, reachable ? 'history-loaded' : 'history-unavailable');
    if (!reachable && !cronSession) return false;
    // the typed merge, and the turn rows it left unmatched (a row that comes back as itself matched nothing)
    const typedMerge = () => { const merged = mergeCanonicalHistory(ws.history, turns), out = new Set(merged);
      return { merged, left: ws.history.filter(r => out.has(r) && r && !r.sys && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string') }; };
    const ask = turns.some(t => t && /\[redacted-/.test(String(t.content))) ? redactAsk(typedMerge().left) : [];
    // what is left of this read's own window, never a fresh one: a send's wait stays bounded
    const clean = ask.length ? await redactedTexts(ask, Math.max(1000, windowMs - (Date.now() - startedAt))) : null;
    if (clean !== null && stale()) { noteContinuity(ws, 'history-stale-discarded'); return false; }
    if (clean === false) noteContinuity(ws, 'history-redact-unavailable');
    const first = typedMerge();   // again: the copy may have grown while the redaction was out
    let merged = first.merged;
    if (clean) {
      // TYPED: the row as typed (the merge carries a matched copy's own fields, this one too)
      const TYPED = Symbol('typed'), left = new Set(first.left), copies = new Set();
      const local = ws.history.map(r => {
        const t = left.has(r) ? clean.get(r.content) : undefined;
        if (t === undefined || t === r.content) return r;
        const copy = Object.assign({}, r, { content: t, [TYPED]: r }); copies.add(copy); return copy;
      });
      if (copies.size) {
        const keyed = mergeCanonicalHistory(local, turns);
        const lastUser = keyed.map(m => m && m.role).lastIndexOf('user');
        const answered = keyed.slice(lastUser + 1).some(m => m && m.role === 'assistant' && !m.error && !m.stopped && String(m.content == null ? '' : m.content).trim());
        merged = keyed.map((m, i) => {
          const row = m && m[TYPED];
          if (!row) return m;
          if (copies.has(m)) return row;   // a copy the station did not match goes back as it was
          const out = Object.assign({}, m, i === lastUser && !answered && m.role === 'user' ? { content: row.content } : null);   // the retry target
          delete out[TYPED];
          return out;
        });
      }
    }
    const next = placeSteerNotes(merged);
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
    if (JSON.stringify(next) === JSON.stringify(ws.history || [])) return reachable;
    ws.history = next;
    read.repaint = true;
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
    if (!activeWs || activeWs.id !== ws.id || historyPinSeq !== loadToken || Channels.isBusy(ws.id)) return reachable;
    if (log) log.innerHTML = '';
    renderHistory(); replayChannel(); syncStatus(); maybeEmptyState();
    read.repaint = false;
    if (typeof Briefing !== 'undefined' && Briefing.presentFor) { try { Briefing.presentFor(ws.id).catch(() => {}); } catch (_) {} }   // the repaint wiped the chips
    if (typeof Delegated !== 'undefined' && Delegated.presentFor) { try { Delegated.presentFor(ws.id).catch(() => {}); } catch (_) {} }   // …and the delegated cards
    // An explicit reveal made before this repaint (NEEDS YOU Open, a search hit) keeps its place: the repaint rebuilt
    // every row, so find the same one again rather than leave the reader at the top of the conversation.
    if (revealKey && !stick && log) { const again = log.querySelector(revealKey); if (again) revealHistory(again); }
    pinLoadedHistoryAfterLayout(loadToken);
    return reachable;
  }

  // swap the rendered conversation to a workstream (its history). Used on enter/resume and when the
  // Commander clicks another stream in the rail — re-renders without re-wiring the input row.
  function loadGroupConversation(ws) {
    GroupChat.bind(ws);
    clearNudge(); clearChoices();
    if (typeof Channels !== 'undefined') Channels.setComposeTarget(ws.id);
    updateControls(); autoGrowInput();
  }
  /* ORG P26 — THE OPEN SESSION IN THE COMMS TITLE ('COMMS · <session>'). ONE writer for #comms-title: Chat.load and the
     rail's repaint (renames, a first message's auto-title, group membership) call paintTitle. Two owners borrow it and
     hand it back: a PROJECT HOME (project-home.js) while it is shown, and the HUD's ACTIVITY view (hudmode.js titleWas)
     — on exit each calls paintTitle again. A title names WHICH conversation, never run state (comms-header-no-run-state).
     An untitled group reads like its rail row ('ULTRON, CYPHER +3'); every other name is Workstreams.titleOf. */
  function sessionTitleText(ws) {
    if (!ws) return '';
    // 'Group chat' is the server's placeholder for an untitled group (group-sessions.js create), not a name anyone gave it
    if ((!ws.title || ws.title === 'Group chat') && ws.conversationMode === 'group' && typeof GroupChat !== 'undefined' && GroupChat.membersOf) {
      const members = GroupChat.membersOf(ws.id) || [];
      if (members.length >= 2) {
        const ids = [ws.agentId].concat(members.filter(id => id !== ws.agentId)).filter(id => members.includes(id));
        const nm = id => (typeof App !== 'undefined' && App.agentName && App.agentName(id)) || id;
        const more = ids.length - 2;
        return ids.slice(0, 2).map(nm).join(', ') + (more > 0 ? ' +' + more : '');
      }
    }
    return shownName(ws);
  }
  // the name the RAIL prints for a session (App.sessionDisplayName: D12's "New session · NOVA" / "… 2" included), else
  // streamLabel — so the COMMS title and the busy row never name a session the rail no longer shows by that name
  function shownName(w) {
    const n = (w && typeof App !== 'undefined' && App.sessionDisplayName) ? App.sessionDisplayName(w) : '';
    return n || streamLabel(w);
  }
  function paintTitle() {
    const t = el('comms-title'); if (!t) return;
    if (typeof ProjectHome !== 'undefined' && ProjectHome.owns && ProjectHome.owns()) return;   // the project home names the panel while shown
    if (document.body && document.body.classList.contains('hud-view-activity')) return;          // the HUD's ▮ ACTIVITY view owns it
    const ws = activeWs || (typeof Workstreams !== 'undefined' ? Workstreams.active() : null);
    const name = ws ? sessionTitleText(ws) : '';
    const painted = name ? (t.dataset.session === name && !!t.querySelector('.comms-session')) : t.textContent === 'COMMS';
    if (painted) return;
    t.dataset.session = name;
    if (!name) { t.textContent = 'COMMS'; t.removeAttribute('data-tip'); return; }
    t.textContent = 'COMMS';
    const s = document.createElement('span'); s.className = 'comms-session'; s.textContent = ' · ' + name;
    t.appendChild(s);
    t.setAttribute('data-tip', 'This conversation: ' + name);   // the whole name when the panel clamps it
  }
  function load(ws) {
    const historyPin = ++historyPinSeq;
    historyPinPending = historyPin;
    revealKey = '';   // a reveal into this conversation runs after load(); this only drops a stale one
    const nextWs = ws || (typeof Workstreams !== 'undefined' ? Workstreams.active() : null);
    const prevWs = activeWs;
    if (activeWs?.id !== nextWs?.id) focusVersion++;
    activeWs = nextWs;
    paintTitle();
    // ANOTHER CONVERSATION IS ON SCREEN (gh#158): an offer panel over COMMS (the first-task hand-off included) steps aside,
    // unanswered, so COMMS shows the conversation now open and its message box. A re-sync of the same one never does.
    if (prevWs && nextWs && prevWs.id !== nextWs.id) stepOfferAside('session');
    noteContinuity(activeWs, 'session-selected');
    heldCard = null; heldQueue.length = 0;
    if (activeWs && activeWs.conversationMode === 'group' && typeof GroupChat !== 'undefined') {
      hideNewPill();
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
    // once its history is merged, the conversation's leftover SEND NOW lines (a reload, close, crash or reconnect lost the page
    // that held them) are asked about: shown as read, or back in this message box (reconcileSentNow)
    { const w = activeWs; Promise.resolve(loadServerHistory(activeWs, historyPin)).catch(() => false).then(() => { if (w) reconcileSentNow(w); }); }
    if (activeWs) { returnHeld(activeWs.id); flushQueued(activeWs.id); }   // returned: what its confirmed STOP held goes back in the box; an idle stream's queued follow-up sends now
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
    // THE ONE RETURN REPORT: opening the briefing session offers each briefed item's own session as a chip
    if (activeWs && typeof Briefing !== 'undefined' && Briefing.presentFor) {
      try { Briefing.presentFor(activeWs.id).catch(() => {}); } catch (_) {}
    }
    // DELEGATED WORK: a conversation that handed work to the crew shows one live card per dispatch (delegated.js)
    if (activeWs && typeof Delegated !== 'undefined' && Delegated.presentFor) {
      try { Delegated.presentFor(activeWs.id).catch(() => {}); } catch (_) {}
    }
    pinLoadedHistoryAfterLayout(historyPin);
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
    // …and the ⚠ error/stop rows COMMS writes when a run fails (error:true): the Commander keeps seeing the reason after a
    // reload, but the model must never be shown "Something went wrong…" as if it had said it (2026-10-11).
    const real = history.filter(m => !(m && (m.truncated || m.sys || m.error)));
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
  /* A retry re-runs the LAST user turn, so nothing after it may ride the wire. retryLast() trims the local rows,
     but load() then re-syncs the thread from the server transcript, which puts the replaced attempt's replies back
     before send() builds the request — and current Claude models refuse a conversation that ends on an assistant
     message ("This model does not support assistant message prefill"): every Try again / retry failed in ~1.5s
     with "Provider returned error" (first-hour walk 2026-09-28, re-proven live on the fix branch). */
  function endOnUserTurn(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const at = list.map(m => m && m.role).lastIndexOf('user');
    return at >= 0 ? list.slice(0, at + 1) : list;
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
  /* THE GAUGE READS A MEMO (idle CPU piece 3, 2026-10-20). The 1 s station tick asks for this every second, and
     historyWindow re-serialized the whole conversation three or four times per call (JSON.stringify + TextEncoder per
     message for the byte cap, again per message for the token fit, and again for the calibrated refit) — on a long chat,
     every second, with nothing changed. Its answer can only move when one of these does: the conversation and its agent,
     the history array (replaced, appended, popped or spliced — chat.js never edits a kept message's content in place, and a
     streaming reply's growing content is in the key), the selected model or its catalog limit, or a context reading
     (Harness.contextRevision, bumped on every write to the readings). A 15 s ceiling re-derives it anyway, so an edit none
     of these can see is never stale for long. Without contextRevision (an older harness) nothing is memoized. */
  const CTX_MEMO_TTL_MS = 15000;
  let ctxMemo = null;
  function contextRef() {
    if (!activeWs) return null;
    let key = null;
    try {
      if (typeof Harness !== 'undefined' && Harness.contextRevision) {
        const h = Array.isArray(activeWs.history) ? activeWs.history : null;
        const last = h && h.length ? h[h.length - 1] : null;
        const model = Harness.getModel ? (Harness.getModel() || '') : '';
        key = [activeWs.id, activeWs.agentId, h, h ? h.length : -1, last, last ? String(last.content == null ? '' : last.content).length : -1,
          model, Harness.contextLimitOf ? Harness.contextLimitOf(model) : 0, Harness.contextRevision()];
      }
    } catch (_) { key = null; }
    const now = Date.now(), age = ctxMemo ? now - ctxMemo.at : -1;   // a negative age (the wall clock stepped back) cannot be measured: re-derive
    if (key && ctxMemo && age >= 0 && age < CTX_MEMO_TTL_MS && ctxMemo.key.every((v, i) => v === key[i])) return ctxMemo.ref;
    const ref = { agentId: activeWs.agentId || 'agent', streamId: activeWs.id, messages: historyWindow(activeWs) };
    ctxMemo = key ? { key, at: now, ref } : null;
    return ref;
  }
  // A streamed fragment is real assistant output even when the transport dies before a clean result envelope.
  // Persist it as its own turn before the failure marker so switch/reload cannot erase what was already visible.
  // The turn records the project root its in-flight run was sent with (send's liveRunRoots; null = none), so its file
  // links resolve where that run wrote them.
  function persistPartial(ws, text) {
    if (!ws || !ws.history) return false;
    const content = String(text == null ? '' : text);
    if (!content.trim()) return false;
    const last = ws.history[ws.history.length - 1];
    if (last && last.role === 'assistant' && !last.error && last.content === content) return false;
    ws.history.push({ role: 'assistant', content: content, ts: Date.now(), projectRoot: liveRunRoots.get(ws.id) });
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
    const list = Workstreams.list ? Workstreams.list({ includeArchived: true, includeWorkers: true }) : (Workstreams.all ? Workstreams.all() : []);
    const peer = list.find(w => w && w.id !== ws.id && (w.agentId || 'agent') === aid && Channels.isBusy(w.id)) || null;
    // busy on delegated work: name the conversation that asked (the worker's own thread is not a place you go)
    const home = peer && Workstreams.isHidden && Workstreams.isHidden(peer) ? Workstreams.get(peer.parentStreamId) : null;
    return home && home.id !== ws.id ? home : (home ? null : peer);
  }
  function renderAgentBusy(peer, detail) {
    if (!log) return;
    const old = log.querySelector('#comms-agent-busy');
    if (!peer && !detail) { if (old) old.remove(); return; }
    const rowEl = old || document.createElement('div');
    rowEl.id = 'comms-agent-busy'; rowEl.className = 'choice-row comms-agent-busy'; rowEl.textContent = '';
    const label = document.createElement('span'); label.className = 'dim';
    // ORG P25: say WHO is busy and WHERE — it explains why a first message here queues (kept visible in an empty session)
    const busyName = peer ? ((typeof App !== 'undefined' && App.agentName && App.agentName(peer.agentId || 'agent')) || name || 'This agent') : '';
    label.textContent = peer ? (String(busyName).toUpperCase() + ' IS BUSY IN ' + shownName(peer).toUpperCase()) : String(detail || 'AGENT BUSY');
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
    statusEl.classList.remove('status-thinking', 'status-working', 'status-approval', 'status-stopping', 'status-connecting', 'status-online', 'status-down', 'status-idle');
    // NO RUN STATE IN THE COMMS HEADER (Andrew, asked 5x; locked 10-03): 'awaiting your answer…' / 'awaiting your context…'
    // are the same pause as an approval (the card + presence line say it), and 'waking…' is a run state too — every one
    // lands on a class the header hides. Faults (unreachable, voice errors) still show.
    statusEl.classList.add(low.indexOf('approval') >= 0 || low.indexOf('awaiting') >= 0 ? 'status-approval'
      : /^waking\b/.test(low.trim()) ? 'status-thinking'
      : low.indexOf('stopping') >= 0 ? 'status-stopping'
      : low.indexOf('working') >= 0 ? 'status-working'
      : low.indexOf('thinking') >= 0 ? 'status-thinking'
      : low.indexOf('connecting') >= 0 ? 'status-connecting'
      : low.indexOf('unreachable') >= 0 ? 'status-down'
      : 'status-online');
    // a plain idle 'online' is hidden in the header (css); every run-state and fault still shows.
    if (low.trim() === 'online') statusEl.classList.add('status-idle');
  }
  // derive the DISPLAYED stream's status from real state, so a low-priority write (a finishing turn) can't
  // clobber the high-priority 'awaiting your approval…' after a switch-back. One source of truth.
  function syncStatus() {
    if (interview) { status('waking…'); stopElapsedTimer(); return; }
    // a working run reads its OWN ask (a background worker waiting does not pause it); an idle one reads any ask filed here
    const p = isBusy() ? runPendingOf(activeWs) : ((activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null);
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
    status(p ? 'awaiting your approval…' : (isBusy() ? (channelStatus || 'thinking…') : (down ? 'station unreachable' : 'online')));
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
  // Whose ideas a shown generation is: personalization on or paused, and the agent. Drift keeps them; a change here rebuilds.
  function starterOwner(ctx) { return (ctx && ctx.enabled === false ? 'paused' : 'on') + ':' + String((ctx && ctx.agentId) || 'agent'); }
  function refreshStarters() {
    if (!log || !activeWs || activeWs.history.length || isBusy() || interview || (input && input.value.trim())) return;
    const d = log.querySelector('.cmsg-empty');
    if (!d) { maybeEmptyState(); return; }
    const ctxNow = starterContext();
    const key = JSON.stringify([ctxNow, starterOptions()]);
    if (d.starterKey === key && !(d.retryAt && Date.now() >= d.retryAt) && Date.now() < d.expiresAt) return;
    // Keep focus stable during keyboard selection. The next idle tick can refresh it.
    if (d.contains(document.activeElement)) return;
    if (d.starterKey === key && d.retryAt && Date.now() >= d.retryAt && d.forcePending) {
      requestStarterIdeas(d, d.querySelector('.cmsg-empty-hint'), starterContext(), starterOptions(), true); return;
    }
    // PERSONALIZED ideas from a finished generation stay up while the context drifts (a crew run elsewhere, a busy flag
    // flipping): every click re-validates its evidence and destination (openStarter), and REFRESH SUGGESTIONS asks again.
    // Rebuilding on each drift asked the model once a minute while an empty session sat open. Pausing personalization or
    // another agent is not drift: the owner changed, so it rebuilds (test/starter-drift.test.js).
    if (d.keptOwner && d.keptOwner === starterOwner(ctxNow) && Date.now() < d.expiresAt) return;
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
    } else {
      // ORG P25: a starter picked on a BLANK open session fills THAT session instead of minting another empty row
      // beside it. Blank = Workstreams.isUntouched (the same test +NEW uses: a plain untitled chat with no messages,
      // runs, deliverables or spend, not pinned / a task card / a room / a goal loop), not a worker, not busy, same
      // agent and project. A titled TO DO card or a pinned empty session keeps today's create.
      const cur = Workstreams.active ? Workstreams.active() : null;
      const blank = !!cur && Workstreams.isUntouched(cur) && cur.worker !== true && !Channels.isBusy(cur.id)
        && (cur.agentId || 'agent') === (ctx.agentId || 'agent') && (cur.projectRoot || '') === (ctx.projectRoot || '');
      ws = blank ? cur : Workstreams.create(st.label, { agentId: ctx.agentId, projectRoot: ctx.projectRoot || undefined });
    }
    if (!ws) return;
    load(ws);
    prefill(Starters.launchPrompt(st));
    // a starter's prompt is longer than the composer's max height: show where it STARTS (the caret stays at its end,
    // so typing still adds to it) instead of leaving the box scrolled to its last lines
    input.scrollTop = 0; if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { input.scrollTop = 0; });
    if (!st.general) StarterStore.prepare(st, ws.id, input.value);
    clearEmptyState(); refreshWorkflowViews();
  }
  // ctx: the context `result` was generated for (absent = the loading or generic state, never kept through drift)
  function renderStarterIdeas(d, hint, result, ctx) {
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
    d.keptOwner = (result.status === 'ready' && personalized.length && ctx) ? starterOwner(ctx) : '';   // the refresh tick keeps these through drift
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
      b.title = st.description + (st.general ? '' : ' Result: ' + st.deliverable);   // cabinet-clean.css shows the title only; the detail is the tip
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
      // a paid generation of personalized ideas that finished after the context drifted is still shown, for the same owner
      // (its ideas re-validate on click); anything else re-evaluates against the new context, as before
      const now = starterContext();
      const keep = result.status === 'ready' && (result.ideas || []).length && starterOwner(now) === starterOwner(ctx);
      if (!keep && JSON.stringify([now, starterOptions()]) !== key) { clearEmptyState(); maybeEmptyState(); return; }
      if (result.status !== 'cancelled') renderStarterIdeas(d, hint, result, ctx);
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
    else renderStarterIdeas(d, hint, result, ctx);
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
  // BUILD MODE can satisfy the prompt while this stream remains open. Its text is a derived floor claim, not history,
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
    // the chip is the whole point: it opens BUILD MODE already armed on the WORKSTATIONS palette, so the next floor
    // click drops the desk. 'later' just dismisses this view of it — the step is still owed, so the next open
    // of this session says so again (it stops for good the moment the desk exists).
    const chips = choices([{ label: '▤ PLACE ITS DESK', value: 'desk' }, { label: 'later', value: 'later', skip: true }], item => {
      if (item && item.value === 'desk' && App.openDeskPlacement) App.openDeskPlacement(id);
    });
    if (chips) chips.classList.add('comms-desk-prompt');
  }

  // opts.live === true marks the streaming reply row, which always pins to the BOTTOM. Every other row (tool
  // ▶/◀ lines, deliverables, consent, turn-in) inserts ABOVE the pinned reply while one is live — so the work
  // log stacks above and the message the agent is actually saying stays at the bottom, never scrolled away.
  let insertingDelivery = false;
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
    if (!log || !stick || insertingDelivery) return;
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
    who.textContent = role === 'user' ? ((opts && opts.brief) || 'COMMANDER') : role === 'system' ? 'SYSTEM' : ((opts && opts.who) || name);
    const body = document.createElement('span'); body.className = 'body';
    // TIMESTAMP TRUTH (P0): opts.stamp is `true` for a row created LIVE (real wall-clock now), a number/Date for a
    // stored turn's REAL recorded time, or falsy for a legacy turn that carries no time — in which case we render
    // NO stamp rather than fabricate the current clock (the module's own rule + truthful telemetry).
    const stampVal = opts && opts.stamp;
    if (stampVal && (stampVal === true || !isNaN(new Date(stampVal).getTime()))) {
      const at = stampVal === true ? new Date() : new Date(stampVal);
      const head = document.createElement('span'); head.className = 'cmsg-head';
      const ts = document.createElement('span'); ts.className = 'cmsg-ts';
      ts.textContent = fmtClock(at);
      d.dataset.ts = String(at.getTime());
      // A CONTINUATION (same speaker, adjacent) whose stamp reads the same as the row right above says nothing new:
      // CSS drops its slim stamp line so a run of turns reads as one message. A different minute keeps it.
      const prev = log.lastElementChild;
      if (prev && prev.classList && prev.classList.contains(role) && prev.classList.contains('cmsg')) {
        const pts = prev.querySelector(':scope > .cmsg-head > .cmsg-ts');
        if (pts && pts.textContent === ts.textContent) d.classList.add('ts-repeat');
      }
      timeBreak(at);
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
  /* TIME BREAKS — "when did I send that?" (Andrew 10-03: hard to see when you sent things). The first stamped turn in
     the log, a new calendar day, or a silence of TIME_BREAK_MS gets a centered divider naming the day + clock, the way
     a messenger marks a conversation picking back up. Reads only REAL stamps (data-ts), so a legacy turn with no
     recorded time never invents one. */
  const TIME_BREAK_MS = 30 * 60 * 1000;
  function lastStampMs() {
    let n = log && log.lastElementChild, hops = 0;
    while (n && hops++ < 80) { if (n.dataset && n.dataset.ts) return +n.dataset.ts; n = n.previousElementSibling; }
    return 0;
  }
  function fmtBreak(at) {
    const now = new Date();
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const daysAgo = Math.round((day(now) - day(at)) / 86400000);
    const h = at.getHours(), m = at.getMinutes();
    const clock = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
    const dayName = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday'
      : CLOCK_MONTHS[at.getMonth()] + ' ' + at.getDate() + (at.getFullYear() !== now.getFullYear() ? ', ' + at.getFullYear() : '');
    return dayName + ' · ' + clock;
  }
  function timeBreak(at) {
    if (!log || insertingDelivery || isNaN(at.getTime())) return;
    const prev = lastStampMs();
    const sameDay = prev && new Date(prev).toDateString() === at.toDateString();
    if (prev && sameDay && at.getTime() - prev < TIME_BREAK_MS) return;
    const d = document.createElement('div'); d.className = 'cmsg-timebreak'; d.setAttribute('role', 'separator');
    const t = document.createElement('span'); t.className = 'tb-when'; t.textContent = fmtBreak(at);
    d.appendChild(t); log.appendChild(d);
  }
  // Recovery can insert earlier turns. Recompute separator ownership without replacing message nodes.
  function syncTimeBreaks() {
    if (!log) return;
    let prev = 0;
    const keep = new Set();
    for (const n of Array.from(log.children)) {
      const stamp = Number(n.dataset.ts);
      if (!stamp) continue;
      const at = new Date(stamp), sameDay = prev && new Date(prev).toDateString() === at.toDateString();
      if (!prev || !sameDay || stamp - prev >= TIME_BREAK_MS) {
        let divider = n.previousElementSibling;
        if (!divider || !divider.classList.contains('cmsg-timebreak')) {
          divider = document.createElement('div'); divider.className = 'cmsg-timebreak'; divider.setAttribute('role', 'separator');
          const label = document.createElement('span'); label.className = 'tb-when'; divider.appendChild(label);
          log.insertBefore(divider, n);
        }
        const label = divider.querySelector('.tb-when'), text = fmtBreak(at);
        if (label.textContent !== text) label.textContent = text;
        keep.add(divider);
      }
      prev = stamp;
    }
    for (const n of Array.from(log.children)) if (n.classList.contains('cmsg-timebreak') && !keep.has(n)) n.remove();
  }
  // stamp: omitted → live now (real); a number/Date → the turn's stored real time; false → no stamp (replay of a
  // legacy turn that carries no time — never fabricate the current clock).
  // brief: the agent that delegated this turn (a worker thread's directive) — named as the speaker, never COMMANDER
  function addUser(t, atts, stamp, brief) {
    const r = row('user', { stamp: stamp === undefined ? true : stamp, brief: brief ? briefLabel(brief) : '' });
    if (brief) r.d.classList.add('brief');
    if (t) r.body.textContent = t;
    if (atts && atts.length) renderUserAttachments(r.d, atts);   // ATTACHMENTS: thumbnails/file-chips under the message text
    autoscroll();
  }
  function briefLabel(id) {
    const nm = (typeof App !== 'undefined' && App.agentName && App.agentName(id)) || String(id || 'agent').toUpperCase();
    return String(nm).toUpperCase() + ' · BRIEF';
  }
  /* A NOTE SENT MID-RUN IS THE COMMANDER'S OWN MESSAGE (Andrew 10-26: "[steering] u seem to be adding just new rooms…" sat
     under ULTRON's name, so the agent read as saying it). The run's '[steering] …' echo is drawn on the Commander's side,
     labelled MID-RUN, the wire marker stripped. One row for the live echo and every replay of it. */
  function steerRow(text, stamp) {
    const r = row('user', { stamp: stamp, brief: 'COMMANDER · MID-RUN' });
    r.d.classList.add('steer-echo');
    r.body.textContent = String(text == null ? '' : text).replace(/^\[steering\] /, '');
    return r;
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
  function localLine(t) {
    const r = row('system'); r.body.textContent = t; autoscroll();
    if (typeof Systems !== 'undefined' && Systems.noticeReply) { try { Systems.noticeReply(t); } catch (_) {} }   // door law: a station line naming a system brings it online
    return r.d;
  }
  /* A SAVED station line (a history `sys` turn) replays in the same SYSTEM register the live line drew, so a note reads
     the same before and after a reload. It used to replay through toolLine — an agent row — and came back as a block of
     the agent's prose (old-UI review 10-26 #3, Andrew's "built while you were away" screenshot). A build session's older
     saves are re-worded on the way to the screen (WorkshopStore.sessionLine). */
  function sysLine(text, isErr) {
    const workshop = activeWs && String(activeWs.id || '').indexOf('workshop-') === 0;
    const shown = workshop && typeof WorkshopStore !== 'undefined' && WorkshopStore.sessionLine ? WorkshopStore.sessionLine(text) : text;
    const r = row('system'); r.body.textContent = shown; if (isErr) r.d.classList.add('err');
    autoscroll();
    return r.d;
  }
  /* A GOAL STEP IS THE STATION'S WORDS (org P29-sys, 2026-10-14). The goal loop sends each continuation as a user-role turn
     (GoalLoop.continuationPrompt — that wire text is unchanged), but the Commander never typed it: COMMS shows the step as ONE
     compact system line naming the goal — live (send) and on every replay (renderHistory) — never the station's internal prompt
     as the Commander's speech. goalStepOf reads the stored turn's own text — GoalLoop.continuationGoal accepts the current head
     AND the pre-org-pass "standing goal" head — so history written before this change replays the same way. */
  function goalStepOf(text) {
    return (typeof GoalLoop !== 'undefined' && GoalLoop.continuationGoal) ? GoalLoop.continuationGoal(text) : null;
  }
  function goalStepLine(goal) {
    if (!log) return null;
    const g = String(goal || '').replace(/\s+/g, ' ').trim();
    const r = row('system'); r.d.classList.add('goal-step');
    r.body.textContent = '↻ Continuing toward your session goal' + (g ? ' — ' + (g.length > 160 ? g.slice(0, 159) + '…' : g) : '');
    autoscroll();
    return r.d;
  }
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
    // the SYSTEM tag a plain station line carries (CSS shows it only on the first line of a run), so a run that opens on
    // a card is headed like any other (org P29-sys, 2026-10-14)
    const who = document.createElement('span'); who.className = 'who'; who.textContent = 'SYSTEM';
    d.appendChild(who);
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
      if (typeof SFX !== 'undefined') ((open ? SFX.press : SFX.close) || SFX.press)();   // fold = close(), like a dock going back
    });
    if (open0) d.classList.add('open');
    d.appendChild(head); d.appendChild(bodyWrap);
    log.appendChild(d); autoscroll();
    return d;
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
  let lastTrophyLine = null, lastTrophyAt = 0;   // the moment's trophy line (see ONE MOMENT, ONE TROPHY LINE)
  let lastQuestLine = null, lastQuestAt = 0;     // the moment's quest line (see ONE MOMENT, ONE QUEST LINE)
  const QUEST_DONE = 'QUEST COMPLETE · ';
  // the quest line a new QUEST COMPLETE folds into: one that landed in the last 10s (a different moment opens a new line)
  function questMoment(raw) {
    const l = lastQuestLine;
    return String(raw).indexOf(QUEST_DONE) === 0 && l && l.isConnected && l.dataset && l.dataset.quests && Date.now() - lastQuestAt < 10000 ? l : null;
  }
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
    if (questMoment(text)) return renderBroadcast(text, opts);   // it folds into a line already there: no new row to rate-limit
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
    const raw = String(text == null ? '' : text);
    // ONE MOMENT, ONE TROPHY LINE (first-hour walk 2026-09-28: three TROPHY EARNED rows landed back to back after the
    // first good answer). A trophy that joins a block whose last line is already a trophy line folds into it —
    // "◆ 3 trophies — FIRST LIGHT · PACK RAT · NIGHT SHIFT (see GROWTH)". Every name still shows; one row, not three.
    const TROPHY = 'TROPHY EARNED · ';
    // the moment's trophy line: the last trophy line, if it landed in the last 10s — even when a card (a REMEMBERED
    // fact landed between them in the walk) started a new block since. An older trophy line is a different moment.
    const prevLine = (lastTrophyLine && lastTrophyLine.isConnected && Date.now() - lastTrophyAt < 10000) ? lastTrophyLine : null;
    if (raw.indexOf(TROPHY) === 0 && prevLine && prevLine.dataset && prevLine.dataset.trophies) {
      let names = [];
      try { names = JSON.parse(prevLine.dataset.trophies) || []; } catch (_) { names = []; }
      const nm = raw.slice(TROPHY.length).trim();
      if (nm && names.indexOf(nm) < 0) names.push(nm);
      prevLine.dataset.trophies = JSON.stringify(names);
      prevLine.textContent = '';
      const g = document.createElement('span'); g.className = 'bc-glyph'; g.textContent = '▸ ';
      const em = document.createElement('span'); em.className = 'bc-name'; em.textContent = names.join(' · ');
      prevLine.appendChild(g);
      prevLine.appendChild(document.createTextNode('◆ ' + names.length + ' trophies — '));
      prevLine.appendChild(em);
      prevLine.appendChild(document.createTextNode(' (see GROWTH)'));
      lastTrophyAt = Date.now();
      autoscroll();
      return true;
    }
    /* ONE MOMENT, ONE QUEST LINE (Andrew 10-26: five "QUEST COMPLETE · … CAN REACH … NOW" rows stacked mid-run). Placing gear
       finishes several reach quests at once; they fold into the moment's line the way trophies do — "3 QUESTS COMPLETE ·
       NOVA CAN REACH WEB NOW · SAM ALTMAN CAN REACH WEB NOW +1 (see QUEST LOG)". Two titles show, the rest are counted; the
       QUEST LOG lists every one. */
    const qLine = questMoment(raw);
    if (qLine) {
      let names = [];
      try { names = JSON.parse(qLine.dataset.quests) || []; } catch (_) { names = []; }
      const nm = raw.slice(QUEST_DONE.length).trim();
      if (nm && names.indexOf(nm) < 0) names.push(nm);
      qLine.dataset.quests = JSON.stringify(names);
      qLine.textContent = '';
      const g = document.createElement('span'); g.className = 'bc-glyph'; g.textContent = '▸ ';
      const em = document.createElement('span'); em.className = 'bc-name'; em.textContent = names.slice(0, 2).join(' · ');
      qLine.appendChild(g);
      qLine.appendChild(document.createTextNode(names.length + ' QUESTS COMPLETE · '));
      qLine.appendChild(em);
      qLine.appendChild(document.createTextNode((names.length > 2 ? ' +' + (names.length - 2) : '') + ' (see QUEST LOG)'));
      lastQuestAt = Date.now();
      autoscroll();
      return true;
    }
    // the block is only opened once we KNOW a new line will land in it. It used to be appended before the trophy fold
    // above, so a second trophy folding into an earlier block left an EMPTY block behind — a blank box in the transcript.
    // THE LIVE CARD IS NOT A ROW (10-26): while a run is live its working card is pinned as the log's last child, so "the last
    // row" was always the card and no line ever joined the block above it. Look past the live card, and open a new block
    // ABOVE it so the card stays pinned at the bottom.
    let d = null, stack = null;
    const liveCard = log.querySelector('#comms-presence:not(.resolved)');
    let last = log.lastElementChild;
    if (last && last === liveCard) last = last.previousElementSibling;
    if (last && last.classList && last.classList.contains('broadcast')) { d = last; stack = d.querySelector('.bc-stack'); }
    if (!d || !stack) {
      d = document.createElement('div');
      d.className = 'cmsg broadcast' + (opts.tone === 'gold' ? ' broadcast-gold' : '');
      d.setAttribute('role', 'status');   // a live-region system line for AT (it renders no speaker chip)
      stack = document.createElement('span'); stack.className = 'bc-stack';
      d.appendChild(stack);
      if (liveCard && liveCard === log.lastElementChild) log.insertBefore(d, liveCard); else log.appendChild(d);
    }
    const line = document.createElement('span');
    line.className = 'bc-line' + (opts.tone === 'gold' ? ' bc-gold' : '');   // tone rides the LINE (a shared block can mix tones)
    if (raw.indexOf(TROPHY) === 0) { line.dataset.trophies = JSON.stringify([raw.slice(TROPHY.length).trim()]); lastTrophyLine = line; lastTrophyAt = Date.now(); }
    if (raw.indexOf(QUEST_DONE) === 0) { line.dataset.quests = JSON.stringify([raw.slice(QUEST_DONE.length).trim()]); lastQuestLine = line; lastQuestAt = Date.now(); }
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
  // NOTIFICATIONS THAT MEAN SOMETHING (10-02): a kept entry names WHO and WHAT, and opens the session it's about.
  const whoOf = ws => (typeof App !== 'undefined' && App.agentName && App.agentName((ws && ws.agentId) || 'agent')) || (ws && ws.agentId) || 'an agent';
  const sessionNote = ws => { const t = ws && String(ws.title || '').trim(); return t ? ' — ' + brief(t) : ''; };
  const notedRuns = new Set();   // a background run that already announced a deliverable doesn't announce 'finished' again
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
  const shortName = n => {
    const s = String(n || 'tool');
    const pm = /^plugin__(.+?)__(.+)$/.exec(s);   // a PLUGIN tool reads as "<plugin> › <tool>" (whose code, then what)
    if (pm) return pm[1] + ' › ' + pm[2];
    return s.replace(/^mcp__/, '').replace(/_/g, '.');   // mcp__x__y → x.y, readable
  };
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
  function argDigest(argsSummary, tool) {
    const raw = String(argsSummary == null ? '' : argsSummary).trim();
    if (!raw) return '';
    // A HAND-OFF READS AS WHO (review 10-14: the team.dispatch row above the approval card showed
    // '{"background":true,"workers":[{"agentId":"copywrit…'). Ids by pattern (the summary is capped), shown by name.
    if (/^team\.dispatch$/.test(shortName(tool))) {
      const ids = [...new Set([...raw.matchAll(/"agentId"\s*:\s*"([^"]+)"/g)].map(m => m[1]))];
      // a capped summary may hold more workers than it shows: mark the cut ("LENS …") — never imply LENS was the only one,
      // and never invent a second one either (", …" read as more workers on a one-worker hand-off, live 10-14)
      let whole = true; try { JSON.parse(raw); } catch (_) { whole = false; }
      if (ids.length) return brief(ids.map(id => (typeof App !== 'undefined' && App.agentName && App.agentName(id)) || id).join(', ') + (whole ? '' : ' …') + (/"background"\s*:\s*true/.test(raw) ? ' · background' : ''));
    }
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
  /* ONE LINE PER BURST OF WORK (Andrew 10-26: "SO many tool calls clutter up the chat and they never disappear"). A rail of
     two or more calls shows ONE summary row until it is opened: the call it is on while it runs ("▸ 4 steps · fs.read
     notes.md"), what it used once it is done ("✓ 5 steps · fs.list, fs.read  0.2s"). A single call keeps its own row. Every
     chip stays in its rail, unchanged: one click on the summary lists them all, and the run-end fold still moves the
     rails under RUN COMPLETE. Nothing is hidden that a click cannot show; the summary only reads the chips' own state. */
  function railChips(rail) { return rail ? Array.from(rail.children).filter(n => n.classList && n.classList.contains('tool-chip')) : []; }
  function syncRail(rail) {
    if (!rail || !rail.classList || !rail.classList.contains('tool-rail')) return;
    const chips = railChips(rail);
    let sum = rail.querySelector(':scope > .tr-sum');
    if (chips.length < 2) { if (sum) sum.hidden = true; rail.classList.remove('tr-multi'); return; }
    if (!sum) {
      sum = document.createElement('button'); sum.type = 'button'; sum.className = 'tr-sum';
      sum.setAttribute('aria-expanded', 'false');
      for (const c of ['tr-glyph', 'tr-count', 'tr-names', 'tr-stat', 'tr-exp']) { const s = document.createElement('span'); s.className = c; sum.appendChild(s); }
      sum.querySelector('.tr-exp').setAttribute('aria-hidden', 'true');
      sum.addEventListener('click', () => { const open = rail.classList.toggle('open'); sum.setAttribute('aria-expanded', open ? 'true' : 'false'); });
      rail.insertBefore(sum, rail.firstChild);
    }
    sum.hidden = false; rail.classList.add('tr-multi');
    const text = (c, sel) => { const n = c.querySelector(sel); return n ? n.textContent : ''; };
    const live = chips.filter(c => c.classList.contains('pending')).pop();
    const errs = chips.filter(c => c.classList.contains('err')).length;
    // a burst where SOME steps failed finished all the same: a plain check, and the stat says how many failed. Only a burst
    // where every step failed wears the red ✗ (an agent probing for a missing file is ordinary work, not an alarm)
    const allFailed = !live && errs === chips.length;
    sum.classList.toggle('pending', !!live); sum.classList.toggle('err', allFailed); sum.classList.toggle('mixed', !live && errs > 0 && !allFailed);
    sum.classList.toggle('ok', !live && !errs);
    sum.querySelector('.tr-glyph').textContent = live ? '▸' : allFailed ? '✗' : '✓';
    sum.querySelector('.tr-count').textContent = chips.length + ' steps';
    let names = '', stat = '';
    if (live) {
      names = text(live, '.tc-name') + (text(live, '.tc-args') ? ' ' + text(live, '.tc-args') : '');
      stat = text(live, '.tc-stat');   // a browser call's "Waiting for browser session…" still shows while the rail is folded
    } else {
      const seen = [];
      for (const c of chips) { const n = text(c, '.tc-name'); if (n && seen.indexOf(n) < 0) seen.push(n); }
      names = seen.join(', ');
      const ms = chips.reduce((t, c) => t + (Number(c.dataset && c.dataset.ms) || 0), 0);
      stat = errs ? errs + ' failed' : ms ? fmtMs(ms) : '';
    }
    sum.querySelector('.tr-names').textContent = names;
    sum.querySelector('.tr-stat').textContent = stat;
    sum.setAttribute('aria-label', chips.length + ' steps' + (names ? ': ' + names : '') + (stat ? ', ' + stat : ''));
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
  // the chip's DOM for one tool CALL: head (glyph · name · short args · stat · chevron) + its expandable detail. Shared by the
  // live one-on-one rail (toolChip) and a transcript this file does not own (toolRailOf — the group chat).
  function chipNode(ev) {
    const flav = skillFlavor(ev);   // A1: skill.* tools re-labelled in the agent's voice
    const chip = document.createElement('div'); chip.className = 'tool-chip pending' + (flav ? ' skill' : '');
    const head = document.createElement('button'); head.type = 'button'; head.className = 'tc-head';
    head.setAttribute('aria-expanded', 'false');   // the head IS the disclosure control (detail = its region)
    const glyph = document.createElement('span'); glyph.className = 'tc-glyph'; glyph.textContent = flav ? flav.glyph : '▸';
    const nm = document.createElement('span'); nm.className = 'tc-name'; nm.textContent = flav ? flav.label : shortName(ev.name);
    // for a flavored skill chip the human phrase already carries the skill name, so the raw args stay in the
    // expand detail only (kept below) — the chip head is clean.
    const args = document.createElement('span'); args.className = 'tc-args'; args.textContent = flav ? '' : argDigest(ev.argsSummary, ev.name);
    const stat = document.createElement('span'); stat.className = 'tc-stat'; stat.textContent = '';   // filled by resolveChip
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
    return chip;
  }
  // render a tool CALL as a chip; returns the chip element. ev: { callId, name, argsSummary }
  function toolChip(ev) {
    const rail = ensureToolRail();
    const chip = chipNode(ev);
    const stat = chip.querySelector('.tc-stat');
    if (/^browser\./.test(ev.name || '') && ev.runId) {
      stat.setAttribute('aria-live', 'polite');
      /* AN ORPHANED CHIP STOPS ASKING (idle CPU piece 3, 2026-10-20). This loop read /api/connectors every second until
         the chip resolved or left the DOM. A run that ended without this call's result (stopped, failed) leaves the chip
         'pending' inside its folded but still connected .run-fold, so it polled once a second until the session was
         switched. Once the conversation's run is over nothing can still be waiting on this call: the loop ends and the
         chip keeps the look it has. */
      const wsId = activeWs && activeWs.id;
      const runOver = () => typeof Channels === 'undefined' || !Channels.isBusy || !wsId || !Channels.isBusy(wsId);
      const checkWait = async () => {
        if (!chip.isConnected || !chip.classList.contains('pending')) return;
        if (runOver()) { stat.textContent = ''; return; }
        // nobody is looking (PollGate): keep the beat, skip the read; the first beat back on screen reads again
        if (typeof PollGate !== 'undefined' && PollGate.away && PollGate.away()) { setTimeout(checkWait, 1000); return; }
        try {
          const j = await Harness.api.get('/api/connectors');
          if (!chip.isConnected || !chip.classList.contains('pending')) return;
          stat.textContent = (j.browserSession?.waitingRunIds || []).includes(ev.runId) ? 'Waiting for browser session…' : '';
          syncRail(chip.parentElement);
        } catch (_) { if (chip.classList.contains('pending')) stat.textContent = ''; }
        if (chip.isConnected && chip.classList.contains('pending')) setTimeout(checkWait, 1000);
      };
      setTimeout(checkWait, 500);
    }
    rail.appendChild(chip);
    syncRail(rail);
    if (ev.callId != null) { pendingChips.set(ev.callId, chip); if (pendingChips.size > 200) pendingChips.delete(pendingChips.keys().next().value); }
    autoscroll();
    return chip;
  }
  /* AN APPROVAL NOT GIVEN IS NOT A FAILURE (releases#9, 2026-10-17). The consent broker answers a call nobody approved —
     a Deny on its card, an unanswered card, an unattended default-deny — with the one summary 'denied' (tools/registry.js).
     The call did not run and nothing broke: the agent carries on and the run ends on its own terms. It drew the red ✗ and
     "failed" an error draws, so the Commander's own No read as a fault in COMMS and in the run's history. */
  const deniedResult = ev => !!(ev && ev.isError && ev.summary === 'denied');
  // fold a tool RESULT into a chip (✓/✗ + duration + result summary). ev: { summary, isError, ms }
  function foldChipResult(chip, ev) {
    chip.classList.remove('pending');
    // A call the Task Brief gate HELD did not run and did not fail: the model settles the brief and makes it again (a new
    // chip). Neutral, never the red ✗ "failed" an error draws (rc walk 2026-10-14) — and never a ✓ either.
    const heldCall = typeof TaskIntent !== 'undefined' && TaskIntent.isGateHeld && TaskIntent.isGateHeld(ev);
    const deniedCall = !heldCall && deniedResult(ev);   // not approved, so not run: the same neutral, saying "denied"
    chip.classList.add(heldCall ? 'held' : deniedCall ? 'denied' : ev.isError ? 'err' : 'ok');
    const glyph = chip.querySelector('.tc-glyph'); if (glyph) glyph.textContent = (heldCall || deniedCall) ? '▸' : ev.isError ? '✗' : '✓';
    const stat = chip.querySelector('.tc-stat');
    if (stat) stat.textContent = heldCall ? 'not run yet' : deniedCall ? 'denied' : ev.ms ? fmtMs(ev.ms) : (ev.isError ? 'failed' : '');
    if (chip.dataset && ev.ms > 0) chip.dataset.ms = String(ev.ms);   // the rail's folded summary adds these up
    const detail = chip.querySelector('.tc-detail');
    if (detail) {
      const dRes = document.createElement('div'); dRes.className = 'tc-d-res' + (heldCall ? ' held' : deniedCall ? ' denied' : ev.isError ? ' err' : '');
      dRes.textContent = heldCall ? cap(ev.summary) : deniedCall ? 'denied · not run' : (ev.isError ? '✗ ' : '✓ ') + cap(ev.summary || (ev.isError ? 'error' : 'ok'));
      detail.appendChild(dRes);
    }
    return chip;
  }
  // fold a tool RESULT into its paired chip. ev: { callId, summary, isError, ms }
  function resolveChip(ev, fallbackName) {
    let chip = (ev.callId != null) ? pendingChips.get(ev.callId) : null;
    if (chip) pendingChips.delete(ev.callId);
    if (!chip) {
      // ORPHAN result (no paired call — e.g. switched-to mid-run): render a standalone resolved chip
      chip = toolChip({ callId: null, name: fallbackName || 'tool', argsSummary: '' });
    }
    foldChipResult(chip, ev);
    syncRail(chip.parentElement);
    autoscroll();
    return chip;
  }
  /* THE SAME CHIPS IN THE GROUP CHAT (rc walk 2026-10-14: a group transcript showed none of the lead's calls). One rail of
     a reply's tool calls — steps: [{ name, args, done, isError, summary, ms }] — built exactly like the one-on-one rail.
     #gc-log has no delegated chip handler, so each head toggles its own detail. */
  function toolRailOf(steps) {
    const rail = document.createElement('div'); rail.className = 'tool-rail';
    for (const s of (Array.isArray(steps) ? steps : [])) {
      const chip = chipNode({ name: s && s.name, argsSummary: (s && s.args) || '' });
      if (s && s.callId) chip.dataset.callId = String(s.callId);   // a re-rendered draft keeps an opened chip open (group-chat renderFlow)
      if (s && s.done) foldChipResult(chip, { isError: !!s.isError, summary: s.summary || '', ms: s.ms || 0 });
      const head = chip.querySelector('.tc-head');
      if (head) head.addEventListener('click', () => toggleChip(head));
      rail.appendChild(chip);
    }
    syncRail(rail);   // the group chat folds a burst to one line too
    return rail;
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
  /* THE READABLE DOCUMENT VIEW (live walk 10-14: OPEN on a worker's tagline.md landed on raw text in a white, unstyled
     tab). A TEXT deliverable opened in a browser asks the jailed file route for its station reading page (?view=doc,
     sidecar/file-response.js — the same list of formats, locked by test/file-open-readable.test.js). Media keep their
     players, pages the BROWSER window, binaries the plain bytes; on desktop the OS app opens the file itself. */
  const TEXT_DOC_RE = /\.(md|markdown|txt|text|csv|tsv|log|json|ya?ml|toml|ini|cfg|conf|py|tsx?|jsx|s?css|sh|ps1|bat|sql|rb|go|rs|java|kt|c|h|cpp|cs|php)$/i;
  function readableUrl(url, filePath) { return TEXT_DOC_RE.test(String(filePath || '').split(/[?#]/)[0]) ? url + '&view=doc' : url; }
  function wireFileOpen(a, title, agentId, projectRoot) {
    a.href = readableUrl(fileUrl(title, agentId, projectRoot), title);
    a.target = '_blank'; a.rel = 'noopener';
    // the rendered ticket lives minutes, the row lives forever: re-mint right before any use of the href
    // (capture-phase listeners run before the native navigation / the context menu's copy-link reads it).
    const refresh = () => { try { a.href = readableUrl(fileUrl(title, agentId, projectRoot), title); } catch (_) {} };
    a.addEventListener('click', refresh, true); a.addEventListener('auxclick', refresh, true);
    a.addEventListener('contextmenu', refresh, true); a.addEventListener('focus', refresh, true);
    // Project-relative worker links use the same canonical project/host routing as their receipt's Open key.
    if (projectRoot) {
      a.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (window.getSelection && String(window.getSelection())) return;
        openFile(title, agentId, projectRoot);
      });
      return;
    }
    // A web page opens RUNNING, in the station's BROWSER window (the window has OPEN OUTSIDE for the OS browser).
    // /api/file would hand the same .html over as an inert download.
    if (typeof OutputBrowser !== 'undefined' && OutputBrowser.isHtml && OutputBrowser.isHtml(title)) {
      a.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (window.getSelection && String(window.getSelection())) return;   // a drag-selection release is not an open
        OutputBrowser.open({ agentId: agentId || 'agent', path: String(title || '') });
      });
      return;
    }
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
            return Promise.resolve(core.invoke('open_external_url', { url: readableUrl(fileUrl(title, agentId), title) }))
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
    // closing is the docks' close() (the same sample pitched down), so direction still reads
    if (typeof SFX !== 'undefined') (SFX.close || SFX.press)();
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
    if (typeof SFX !== 'undefined' && SFX.press) SFX.press();
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
    // header auth only: the hardened window.fetch (harness.js) attaches X-StarNet-Token to every /api/ URL
    const p = fetch('/api/workspace/dir?agent=' + encodeURIComponent(aid), { cache: 'no-store' })
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
    const desktop = !!tauriCore();
    // the folder glyph only where the key really opens a folder: a browser's key copies the path, so it wears copy path's ⧉
    b.appendChild(desktop ? glyphSpan(SVG_FOLDER) : document.createTextNode('⧉'));
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
    noteDeliveryLanding();
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
    noteDeliveryLanding();
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
  // Base: on desktop the page runs
  // on the tauri.localhost origin and the shell rewrites ONLY window.fetch to the sidecar — a relative
  // href would navigate into the bundled-asset protocol and vanish (the same trap cloudsave's unload
  // beacon hit), so native loads carry the ABSOLUTE loopback base (window.__STARNET_API__); in a
  // browser the base is '' and the URL stays same-origin relative.
  // Auth (2026-09-25): a FILE-SCOPED 5-minute ticket (ApiTicket.fileUrl), never the master token — this href reaches
  // OS-browser history, Referer and copied links. wireFileOpen re-mints it right before any use.
  /* open a file a run produced from any surface (the delegation card's receipts): the same doors as a COMMS file row —
     a web page in the station BROWSER, the desktop host's own open (with its confirm), else a ticketed tab. A file a
     worker wrote into a trusted project is addressed inside that project (&project=, absolute for the host). */
  function openFile(path, agentId, projectRoot) {
    const rel = String(path || ''), aid = agentId || 'agent';
    if (!rel) return;
    const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(rel), root = projectRoot && !isAbs ? String(projectRoot).replace(/[\\/]+$/, '') : '';
    if (!root && typeof OutputBrowser !== 'undefined' && OutputBrowser.isHtml && OutputBrowser.isHtml(rel)) { OutputBrowser.open({ agentId: aid, path: rel }); return; }
    const url = readableUrl(fileUrl(rel, aid, root), rel);   // a text deliverable opens as the readable document, never raw text
    const core = tauriCore();
    if (core && core.invoke) {
      Promise.resolve(core.invoke('starnet_open_artifact', { path: root ? root + '/' + rel : rel, agentId: aid }))
        .catch(err => {
          if (/declined at the host/i.test(String(err || ''))) return;   // the host's own confirm said no: an answer, not a failure
          return Promise.resolve(core.invoke('open_external_url', { url }))
            .catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open that file — use folder or copy path to find it on disk', 'warn'); });
        });
      return;
    }
    try { window.open(url, '_blank', 'noopener'); } catch (e) { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open that file: ' + ((e && e.message) || e), 'warn'); }
  }
  function fileUrl(title, agentId, projectRoot) {
    const project = projectRoot && !/^([A-Za-z]:[\\/]|[\\/])/.test(String(title)) ? '&project=' + encodeURIComponent(String(projectRoot).replace(/[\\/]+$/, '')) : '';
    if (typeof ApiTicket !== 'undefined' && ApiTicket.fileUrl) return ApiTicket.fileUrl(agentId || 'agent', String(title)) + project;
    let base = '';
    try { base = (typeof window !== 'undefined' && window.__STARNET_API__) ? String(window.__STARNET_API__) : ''; } catch (_) {}
    return base + '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(title) + project;
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
    // SAY IT ONCE (10-19): the RUN COMPLETE footer right above already tells this run's honest time and its model (its
    // telemetry hydrates before this card): the foot keeps what the footer does not say, the cost ("907ms" over "922ms")
    const said = !!(log && Array.from(log.querySelectorAll('.comms-presence.resolved[data-run-id]')).some(c => c.dataset.runId === runId && c.dataset.telemetry === '1'));
    foot.textContent = [fmtRecapCost(entry), !said && durMs > 0 ? fmtMs(durMs) : '', !said && entry.model && entry.model !== '(unknown)' ? entry.model : ''].filter(Boolean).join(' · ');
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
  // who ran a recorded run, by NAME (the record holds the id: the hero's is "agent")
  const runWho = id => (id && typeof App !== 'undefined' && App.agentName && App.agentName(id)) || id || '';
  function telemetryRun(entry, role, skipTools) {
    const wrap = document.createElement('div'); wrap.className = 'rt-run';
    const calls = runCallCount(entry);
    const head = document.createElement('div'); head.className = 'rt-run-head';
    head.textContent = [role, runWho(entry.agentId), entry.model && entry.model !== '(unknown)' ? entry.model : '', (entry.reasoningEffort && entry.reasoningEffort !== 'none') ? entry.reasoningEffort : '', Number(entry.durationMs) > 0 ? fmtMs(Number(entry.durationMs)) : '', Number(entry.waitedMs) > 0 ? fmtMs(Number(entry.waitedMs)) + ' waiting on you' : '', calls + (calls === 1 ? ' call' : ' calls')].filter(Boolean).join(' · ');
    wrap.appendChild(head);
    for (const t of (skipTools ? [] : (Array.isArray(entry.toolTrace) ? entry.toolTrace : []))) {
      // a call the Task Brief held did not run: "not run yet", never "failed" (TaskIntent.GATE_HELD on its record)
      const held = typeof TaskIntent !== 'undefined' && TaskIntent.isGateHeld && TaskIntent.isGateHeld(t);
      const denied = !held && deniedResult(t);   // an approval not given: "denied", never "failed" (deniedResult above)
      const line = document.createElement('div'); line.className = 'rt-tool' + (held ? ' held' : denied ? ' denied' : t.isError ? ' err' : '');
      line.textContent = '↳ ' + String(t.name || 'unknown') + ' · ' + fmtMs(Math.max(0, Number(t.ms) || 0)) + ' · ' + (held ? 'not run yet' : denied ? 'denied' : t.isError ? 'failed' : 'ok');
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
    // ONE run, ONE duration (live walkthrough 2026-10-13: "RUN COMPLETE · 89.1s" above a receipt reading 49.3s). The
    // card shows machine time — approval waits excluded, the same number as the receipt — and names the wait apart.
    const honest = Number(card.dataset.ms) || 0, wall = Number(entry.durationMs) || 0;
    if (sum) {
      const label = String(sum.textContent || '').split(' · ')[0];
      const bits = [];
      if (honest > 0) {
        bits.push(fmtMs(honest));
        if (wall - honest > 1500) bits.push(fmtMs(wall - honest) + ' waiting on you');
      } else if (wall > 0) bits.push(fmtMs(wall));
      bits.push(leadCalls + ' tool ' + (leadCalls === 1 ? 'call' : 'calls'));   // the LEAD's tool calls (runCallCount = toolTrace) — not model calls
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
    // the lead's line tells the footer's time (its record's durationMs is the wall clock, the approval waits inside it)
    const leadRow = honest > 0 ? Object.assign({}, entry, { durationMs: honest, waitedMs: wall - honest > 1500 ? wall - honest : 0 }) : entry;
    detail.appendChild(telemetryRun(leadRow, 'lead', hasChips));
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
  /* THE GLANCE LINE (user report 10-08). argsSummary is the WHOLE request now (consentSummary stopped clipping it at
     77 chars, which hid a long command's tail), so it never goes into a phrase, a toast or a notification raw: those
     get one short line, and the card carries the whole thing in INSPECT COMPLETE REQUEST (permissionRow). */
  // "Show the whole question" shows exactly while the question is clamped — re-measured when COMMS changes size (width,
  // TEXT SIZE, shown after being hidden); a question that cannot be measured (hidden) keeps its key
  const wholeFitObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(list => { const hit = list.map(e => e.target); requestAnimationFrame(() => { for (const t of hit) if (t._fitWhole) t._fitWhole(); }); }) : null;
  function fitWhole(text, key, isOpen) {
    text._fitWhole = () => { if (isOpen() || !text.isConnected) return; key.hidden = text.clientHeight > 0 && text.scrollHeight <= text.clientHeight + 2; };
    if (wholeFitObserver) wholeFitObserver.observe(text);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(text._fitWhole);
  }
  function glance(s, n) { const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); n = n || 96; return one.length > n ? one.slice(0, n - 1) + '…' : one; }
  function requestArgs(s) { try { const o = JSON.parse(String(s || '')); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; } }
  // what a consent card's INSPECT panel holds: { label, text } or null. A file change shows the mutation, a routine what
  // it runs each time; any other request shows its arguments in full. Cards the sidecar words itself (station build /
  // control, folder trust, a login host, a question) and a bare short value the phrase already shows get no panel.
  function consentInspect(p) {
    const t = String((p && p.tool) || ''), raw = String((p && p.argsSummary) || '');
    if (/^fs[._](?:write|append|edit|patch)$/.test(t)) {
      // read as a file, not as JSON: the path, then the text exactly as it will be written (real line breaks, no \n)
      const label = 'Inspect the change (secrets redacted)', o = requestArgs(raw);
      if (!o) return { label, text: raw || '(payload unavailable)' };
      const heads = { content: '', find: 'Find:\n', replace: 'Replace with:\n', patch: 'Patch:\n' };
      const parts = typeof o.path === 'string' ? ['File: ' + o.path] : [];
      for (const k of Object.keys(o)) if (k !== 'path') parts.push((k in heads ? heads[k] : k + ': ') + (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k], null, 2)));
      return { label, text: parts.join('\n\n') || raw };
    }
    if (/^routine[._](?:create|manage)$/.test(t)) { const o = requestArgs(raw); return { label: 'What it will do each run', text: (o && o.prompt) ? String(o.prompt) : raw || '(payload unavailable)' }; }
    if (!raw.trim() || /^station[._]/.test(t) || /^(?:path\.trust|browser\.login(?:\.done)?|brief\.ask)$/.test(t)) return null;
    const o = requestArgs(raw), label = 'Inspect the full request (secrets redacted)';
    if (!o) return glance(raw) === raw.trim() ? null : { label, text: raw };
    // read as written, not as JSON: a Windows path shows C:\Users, never C:\\Users, and a command is the exact text
    // that will run — so COPY COMMAND hands over something you can paste into a terminal
    const text = Object.keys(o).map(k => k + ': ' + (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k], null, 2))).join('\n');
    const command = /^(?:shell|terminal)[._]/.test(t) ? [o.cmd, o.command, o.input, o.data].find(v => typeof v === 'string' && v) : '';
    return command ? { label, text, copy: command, copyLabel: 'COPY COMMAND' } : { label, text };
  }
  // Shared by ordinary approvals and delegated rows; all disclose the same redacted request and build steps.
  function appendConsentDetails(host, p, part) {   // part: 'inspect' | 'plan' | (both)
    // INSPECT: an approval carries the request it approves, every character of it, one click away (user report 10-08:
    // a long shell command showed 77 chars and a "…", and nothing on the card held the rest)
    const inspect = part === 'plan' ? null : consentInspect(p);
    if (inspect) {
      const detail = document.createElement('details'); detail.className = 'consent-payload';
      const label = document.createElement('summary'); label.textContent = inspect.label;
      const payload = document.createElement('pre'); payload.textContent = inspect.text;
      const idle = inspect.copyLabel || 'COPY';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'consent-btn quiet consent-copy'; copy.textContent = idle;
      copy.onclick = () => copyText(inspect.copy || inspect.text).then(ok => {
        copy.textContent = ok ? '✓ COPIED' : 'COPY FAILED: select the text above';
        clearTimeout(copy.__t); copy.__t = setTimeout(() => { copy.textContent = idle; }, 1400);
      });
      detail.appendChild(label); detail.appendChild(payload); detail.appendChild(copy); host.appendChild(detail);
    }
    if (part === 'inspect') return;
    // the station builder's card: every step's instructions, one click away (the summary line is in the phrase above)
    if (/^station[._]build$/.test(String(p.tool || '')) && String(p.argsSummary || '').indexOf('\n') > 0) {
      const detail = document.createElement('details'); detail.className = 'consent-payload';
      const label = document.createElement('summary'); label.textContent = 'What each step will be told';
      const payload = document.createElement('pre'); payload.textContent = String(p.argsSummary).split('\n').slice(1).join('\n');
      detail.appendChild(label); detail.appendChild(payload); host.appendChild(detail);
    }
    // …and draws the plan: where it goes and what goes where, before anything is built (the page's own parked plan)
    if (/^station[._]build$/.test(String(p.tool || '')) && typeof StationCommands !== 'undefined' && StationCommands.previewFor && typeof PlanPreview !== 'undefined') {
      const fig = PlanPreview.el(StationCommands.previewFor(String(p.argsSummary || '').split('\n')[0]));
      if (fig) host.appendChild(fig);
    }
  }
  function actionPhrase(ev, detail) {   // detail: the approval card itself (room for what each worker is handed)
    const t = ev.tool || 'act';
    // a PLUGIN tool (plugin__<id>__<tool>): say whose code it is before what it does — checked first, so a plugin
    // tool that happens to be named like a built-in (edit_*, *notebook*) can never borrow a built-in's phrasing
    const pm = /^plugin__(.+?)__(.+)$/.exec(t);
    if (pm) {
      const host = typeof PluginHost !== 'undefined' ? PluginHost : null;
      const san = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');   // plugin-tools.js sanitizePart
      const p = host && host.list ? host.list().find(x => x.id === pm[1] || san(x.id) === pm[1]) : null;
      return 'use the ' + ((p && p.name) || pm[1]) + ' plugin tool “' + pm[2] + '”' + leadText(ev.argsSummary, ': ');
    }
    // the crew INSTALLING a plugin it wrote: say that it stays off until the Commander's own approval
    if (/^plugin[._]submit$/.test(t)) {
      let id = '';
      try { id = JSON.parse(ev.argsSummary || '{}').id || ''; } catch (_) {}
      return 'install the plugin it built' + (id ? ' “' + id + '”' : '') + ' — it stays OFF until you approve its code in ABILITIES → EXTENSIONS';
    }
    if (/notebook/.test(t)) return 'save a note to its memory';
    // a hire reads as a hire: "hire RESEARCH (researcher) onto the crew", never the raw JSON args (live walkthrough 2026-10-13);
    // anything else it names comes from leadText (a capped summary gives nothing — the card's INSPECT holds every character)
    if (/summon/.test(t)) {
      const o = requestArgs(ev.argsSummary) || {};
      const nm = String(o.name || '').trim(), spec = String(o.specId || o.class || o.role || '').trim();
      if (nm || spec) return 'hire ' + (nm ? nm.toUpperCase() + (spec && spec.toLowerCase() !== nm.toLowerCase() ? ' (' + spec + ')' : '') : 'a ' + spec) + ' onto the crew';
      return 'hire a new agent onto the crew' + leadText(ev.argsSummary, ': ');
    }
    // a command: name it in words, its text clipped to a glance; the card's inspect panel holds every character of it
    if (/^(?:shell|terminal)[._]/.test(t)) {
      const o = requestArgs(ev.argsSummary) || {};
      const typed = /write$/.test(t), text = o.cmd || o.command || o.input || o.data;
      return (typed ? 'type into a running process' : 'run a command') + (typeof text === 'string' && text ? ': ' + glance(text) : leadText(ev.argsSummary, ': '));
    }
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
    // code the agent runs: name it as the command it is (the card's INSPECT holds every character)
    if (/^(?:verify[._]run|code[._]run|browser[._]eval)$/.test(t)) {
      const o = requestArgs(ev.argsSummary) || {}, text = [o.cmd, o.code, o.expression].find(v => typeof v === 'string' && v.trim());
      return ({ v: 'run a check', c: 'run code', b: 'run a script in the browser page' })[t[0]] + (text ? ': ' + glance(text, 80) : '');
    }
    if (/^browser[._]upload$/.test(t)) { const o = requestArgs(ev.argsSummary) || {}, files = Array.isArray(o.paths) ? o.paths.filter(x => typeof x === 'string') : []; return 'upload ' + (files.length ? glance(files.join(', '), 80) : 'files') + ' to the page'; }
    if (/^channel[._]send$/.test(t)) {
      const o = requestArgs(ev.argsSummary) || {}, n = Array.isArray(o.files) ? o.files.length : 0;
      return 'send a message' + (typeof o.target === 'string' && o.target ? ' to ' + glance(o.target, 40) : '') + (n ? ' with ' + n + (n > 1 ? ' files' : ' file') : '') + (typeof o.text === 'string' && o.text ? ': ' + glance(o.text, 70) : '');
    }
    // "write a file" only for the tools that write files (a connector's write_values or a credit_* tool never says that)
    if (!/^mcp__/.test(t) && /(?:^|[._])(?:write|append|edit)(?:$|[._])/.test(t)) { const o = requestArgs(ev.argsSummary); return 'write ' + (o ? (typeof o.path === 'string' && o.path ? glance(o.path, 80) : 'a file') : leadText(ev.argsSummary, '') || 'a file'); }
    if (t === 'web_request') { const o = requestArgs(ev.argsSummary) || {}; return 'send a ' + String(o.method || 'web').toUpperCase().replace(/^WEB$/, 'web') + ' request' + (typeof o.url === 'string' && o.url ? ' to ' + glance(o.url, 80) : ''); }
    if (t === 'image_generate') { const o = requestArgs(ev.argsSummary) || {}; return 'make an image' + (typeof o.prompt === 'string' && o.prompt ? ': ' + glance(o.prompt, 80) : ''); }
    if (t === 'brief.ask') return 'ask you a quick question about the task';   // clarify card renders its own body
    // ROUTINES: say WHAT will run and WHEN, never the raw JSON (argsSummary may be clipped mid-object, so read fields
    // by pattern rather than JSON.parse). "Always" here lets the agent add and change routines without asking.
    if (/^routine[._](?:create|manage)$/.test(t)) {
      const s = String(ev.argsSummary || '');
      const pick = k => { const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(s); return m ? m[1].replace(/\\(["\\\\])/g, '$1') : ''; };
      const nm = pick('name'), when = pick('schedule');
      if (/create$/.test(t)) return 'schedule a routine' + (nm ? ' “' + nm + '”' : '') + (when ? ' — ' + when : '') + ' (results come back here)';
      const act = pick('action'), ref = pick('id');
      return (act || 'change') + ' the routine' + (ref ? ' “' + ref + '”' : '') + (when ? ' — ' + when : '');
    }
    // DELEGATION (2026-10-11): say WHO gets the work, by name, never the raw worker JSON (the inspect panel holds it).
    // Read the ids by pattern: argsSummary may be clipped mid-object.
    if (/^team[._](?:dispatch|spawn)$/.test(t)) {
      const s = String(ev.argsSummary || ''), ids = [...new Set([...s.matchAll(/"agentId"\s*:\s*"([^"]+)"/g)].map(m => m[1]))];
      const nameOf = id => (typeof App !== 'undefined' && App.agentName && App.agentName(id)) || id;
      const and = list => list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1] : list[0] || '';
      const bg = /"background"\s*:\s*true/.test(s) ? ' (in the background)' : '';
      /* THE CARD SAYS WHO GETS WHAT (rc walk 10-14: "NOVA wants to hand work to COPY and STRATEGY" — the tasks were raw JSON
         under Inspect). On the card itself (`detail`) each worker's task rides beside its name, its first sentence at a
         glance — the shorter the more workers; the toast, the bell and NEEDS YOU keep the short line. The whole request is
         still one click away in INSPECT. A summary that does not parse (capped) falls back to the names. */
      const o = detail ? requestArgs(s) : null;
      const jobs = o ? (Array.isArray(o.workers) ? o.workers : Array.isArray(o.tasks) ? o.tasks : []).filter(w => w && typeof w.prompt === 'string' && w.prompt.trim()) : [];
      if (jobs.length) {
        const n = Math.max(36, Math.floor(140 / Math.min(jobs.length, 3)));
        // its first sentence when that fits, else cut at a word (never "statio…")
        // …and the file a task names is its deliverable: when the cut would lose it, the middle goes instead (review 10-14:
        // "…into a file called…" lost tagline.md)
        const FILE = /(?:[\w-]+[\\/])*[\w-][\w.-]*\.(?:md|markdown|txt|html?|css|m?js|cjs|tsx?|jsx|json|ya?ml|csv|tsv|py|rb|go|rs|java|sh|ps1|sql|xml|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|mp3|wav|mp4|zip)(?![\w-])/i;
        const task = p => {
          const one = p.replace(/\s+/g, ' ').trim(), cut = one.search(/[.!?](?:\s|$)/), s = cut > 12 && cut < n ? one.slice(0, cut) : one;
          if (s.length <= n) return '“' + s + '”';
          const file = (one.match(FILE) || [''])[0], room = file && file.length < n / 2 ? n - file.length - 2 : n;
          const sp = s.lastIndexOf(' ', room - 1);
          const head = s.slice(0, sp > room * 0.6 ? sp : room - 1).replace(/[\s,;:]+$/, '');
          return '“' + head + (room < n && head.indexOf(file) < 0 ? ' … ' + file : '…') + '”';
        };
        const shown = jobs.slice(0, 3), more = jobs.length - shown.length;
        if (/spawn$/.test(t)) return 'run ' + (jobs.length > 1 ? jobs.length + ' copies' : 'a copy') + ' of itself on ' + and(shown.map(w => task(w.prompt)).concat(more ? [more + ' more'] : [])) + bg;
        return 'hand ' + and(shown.map(w => nameOf(String(w.agentId || 'the crew')) + ' ' + task(w.prompt)).concat(more ? [more + ' more'] : [])) + bg;
      }
      return 'hand work to ' + (and(ids.map(nameOf)) || 'the crew') + bg;
    }
    // A GOAL LOOP (rc walk 10-14: the card read "use loop create: Write and refine…"): what it repeats toward, in words
    if (/^loop[._]create$/.test(t)) {
      const o = requestArgs(ev.argsSummary) || {}, what = [o.objective, o.name].find(v => typeof v === 'string' && v.trim());
      return 'start a goal loop' + (typeof o.agentId === 'string' && o.agentId.trim() ? ' for ' + ((typeof App !== 'undefined' && App.agentName && App.agentName(o.agentId)) || o.agentId) : '') + (what ? ': ' + glance(what, 90) : '');
    }
    // THE STATION BUILDER (2026-09-29): the card IS the plan — what gets built, where, who works each step. The sidecar
    // sends the plan's own summary (its dry run on a copy of the station), never the model's words.
    if (/^station[._]build$/.test(t)) { const plan = String(ev.argsSummary || '').split('\n')[0] || 'a planned change'; return 'build this on your station: ' + plan + (/\bUNDO\b/.test(plan) ? '' : ' One UNDO in Build mode takes it back.'); }
    // MAKE A PROP (2026-10-01): the card names the object and what it costs in StarNet credits (the sidecar's own words)
    if (/^station[._]make_prop$/.test(t)) return 'make a new prop: ' + (String(ev.argsSummary || '').split('\n')[0] || 'a new prop');
    // TEST A LINE (2026-10-01): the card names the line and the job it will send (the sidecar's own words)
    if (/^station[._]test_line$/.test(t)) return 'test ' + (String(ev.argsSummary || '').split('\n')[0] || 'a workflow line');
    if (/^station[._]start_line$/.test(t)) return 'set what starts ' + (String(ev.argsSummary || '').split('\n')[0] || 'a workflow line');
    // STATION CONTROL (2026-10-02): a settings change asked for in chat — the sidecar's catalog sentence, never raw JSON
    if (/^station[._](?:control|power)$/.test(t)) return String(ev.argsSummary || 'change a station setting').split('\n')[0];
    // ANY OTHER TOOL: its name in words and the one argument that says what it acts on — never raw JSON on the card or in a
    // toast (the card's inspect panel holds every character of the request)
    const mcp = /^mcp__(.+?)__(.+)$/.exec(t);   // a connector tool: say whose (google sheets write values: Sheet1!A1:C3)
    const words = (mcp ? mcp[1] + ' ' + mcp[2] : t).replace(/[._]+/g, ' ').trim();
    const o = requestArgs(ev.argsSummary);
    // a *.manage tool says its action first: "remove task Buy milk", never "use task manage"
    if (o && typeof o.action === 'string' && o.action.trim() && !mcp && /[._]manage$/.test(t)) return glance(o.action, 30) + ' ' + words.replace(/ manage$/, '') + leadText(Object.assign({}, o, { action: undefined }), ' ');
    return 'use ' + words + leadText(ev.argsSummary, ': ');
  }
  // the one argument that says what a request acts on, in words; else its first one or two short values ("key: value");
  // a summary that does not parse (a capped one) gives nothing — the card's INSPECT holds every character. A bare value the
  // sidecar sends whole (consentSummary: a read's path) IS what is approved: it is named, never dropped from the card
  const LEAD_KEYS = ['url', 'path', 'paths', 'query', 'cmd', 'command', 'code', 'expression', 'prompt', 'objective', 'text', 'task', 'name', 'title', 'to', 'target', 'range', 'key', 'uri', 'id'];
  function leadText(src, sep) {
    const o = typeof src === 'string' ? requestArgs(src) : src;
    if (!o && typeof src === 'string' && src.trim() && !/^\s*[[{]/.test(src)) return sep + glance(src, 80);
    if (!o || typeof o !== 'object') return '';
    for (const k of LEAD_KEYS) {
      const v = Array.isArray(o[k]) ? o[k].filter(x => typeof x === 'string').join(', ') : o[k];
      if (typeof v === 'string' && v.trim()) return sep + glance(v, 80);
    }
    const pairs = Object.keys(o).filter(k => (typeof o[k] === 'string' && o[k].trim()) || typeof o[k] === 'number' || typeof o[k] === 'boolean').slice(0, 2).map(k => k + ': ' + glance(String(o[k]), 40));
    return pairs.length ? sep + pairs.join(', ') : '';
  }

  /* IN-TURN CLARIFY CARD (2026-07-31, Hermes-parity). A brief.ask prompt rides the consent transport but is
     a QUESTION, not a permission grade — approve/deny buttons would be a lie. Renders the question with the
     same one-tap choice chips the end-run TASK_QUESTION card uses (★ = the agent's recommended option, plus
     the standing "use your judgment" skip), and answers via POST /api/consent/answer so the SAME turn
     resumes with the decision — the run never ends. Ignoring the card is safe: the sidecar's fail-closed
     timer falls back to today's durable end-run question. Joins the consent card's lifecycle contract:
     decided chips vanish into a verdict tag, pending-span bookkeeping excludes the wait from run time, and
     focus is never stolen from a mid-typing Commander. */
  /* THE COMPOSER ANSWERS THE QUESTION (live walkthrough 2026-10-13). NOVA asked "what are you launching?"; the
     Commander typed the answer in the COMMS box like any chat — and it became a queued chip, the run sat on
     "awaiting your answer", and ~15 min later the chip fired as a NEW message that restarted the whole job. While the
     open conversation waits on exactly ONE of its lead's questions, a composer send is that question's answer.
     promptId -> { wsId, answer(text) -> Promise<bool> } — registered by clarifyRow, removed once answered. */
  const askAnswerers = new Map();
  function pendingAskFor(ws) {
    if (!ws) return null;
    const live = [];
    for (const [id, a] of askAnswerers) { if (a.wsId === ws.id && !(a.isDone && a.isDone())) live.push(id); else if (a.isDone && a.isDone()) askAnswerers.delete(id); }
    return live.length === 1 ? askAnswerers.get(live[0]) : null;
  }
  async function answerPendingAsk(ws, text) {
    const a = pendingAskFor(ws);
    if (!a) return false;
    let ok = false;
    try { ok = (await a.answer(text)) === true; } catch (e) { ok = false; }
    return ok;
  }
  function clarifyRow(p, ws) {
    let q = { question: '', options: [], recommended: '', reason: '', multiSelect: false, ordinal: 0, total: 0 };
    try { q = Object.assign(q, JSON.parse(p.argsSummary || '{}')); } catch (_) {}
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent');
    r.d.dataset.clarifyPrompt = String(p.promptId || ''); r.d.tabIndex = -1; r.d.dataset.liveAsk = '1';
    if(q.mode==='conversation' && typeof TaskConversation!=='undefined') {
      // the ask's own run id first, like the choice and approval cards: a background worker's question outlives the reply that started it
      const rid=p.runId || (ws && Channels.runIdOf(ws.id));
      let answeredHere=false;
      const tc=TaskConversation.mount(r.body,Object.assign({},q,{asker:askerName(p,ws)}),async text=>{
        const result=await Harness.consentAnswer(rid,p.promptId,text,true);
        if(!result || !result.ok)return false;
        answeredHere=true;
        // the question is answered: say so on the bus like the approval card does, or the CREW card and the world pose stay "needs your OK"
        // via:'desk': a confirmed local answer names its surface, so no other card reads it as "from your phone"
        try{if(typeof U!=='undefined'&&U.bus)U.bus.emit('permission.response',{promptId:p.promptId,decision:'once',via:'desk'});}catch(_){}
        if(ws)Channels.clearPending(ws.id,Date.now(),p.promptId);
        if(isActiveWs(ws)){renderPresence();syncStatus();}
        releaseCard(r.d);
        askAnswerers.delete(String(p.promptId||''));
        return true;
      });
      // a worker's question is answered on its own row; the lead's is answerable from the composer
      if(ws && p.promptId && !p.workerStreamId && tc && typeof tc.submit==='function')
        askAnswerers.set(String(p.promptId),{wsId:ws.id,answer:tc.submit,isDone:tc.isDone});
      // answered from the phone, timed out, or the run stopped: the card says so, stops taking input, and the follow resumes
      if(typeof U!=='undefined'&&U.bus&&U.bus.on&&U.bus.off){
        const onElsewhere=(resp)=>{
          if(!resp||resp.promptId!==p.promptId)return;
          U.bus.off('permission.response',onElsewhere);
          askAnswerers.delete(String(p.promptId||''));
          if(answeredHere){releaseCard(r.d);return;}
          if(ws&&typeof Channels!=='undefined')Channels.clearPending(ws.id,Date.now(),p.promptId);
          if(isActiveWs(ws))renderPresence();
          if(tc&&tc.settle)tc.settle(resp.stopped?askerName(p,ws)+' stopped before an answer':resp.expired?'No answer in time — '+askerName(p,ws)+' used its judgment':resp.decision==='deny'?'Declined'+settledWhere(resp):'Answered'+settledWhere(resp));
          releaseCard(r.d);syncStatus();
        };
        U.bus.on('permission.response',onElsewhere);
      }
      status('awaiting your context…');revealCard(r.d);return;
    }
    // A batched ask shows its place ("asks (2 of 3)") so the Commander knows one more tap ends it —
    // three unannounced sequential cards would read as an interrogation with no visible bottom.
    const seq = (Number(q.total) > 1 && Number(q.ordinal) > 0) ? ' (' + q.ordinal + ' of ' + q.total + ')' : '';
    // WHO asks on its own line, the question at reading size (Andrew 2026-10-13: "▣ NOVA asks: …" ran the asker into a
    // long question, and the reason sat open under it as a wall of text)
    /* READING ORDER (Andrew 2026-10-13: "tiny … unorganized and long"): who asks · the question, three lines at most (the
       whole of it one tap away) · the answers as keys · one plain line on how to answer · the reason, folded. */
    const askedBy = askerName(p, ws);
    const who = document.createElement('div'); who.className = 'cq-who'; who.textContent = askedBy + ' asks' + seq;
    const qText = document.createElement('p'); qText.className = 'cq-text'; qText.textContent = q.question || 'Which way should this go?';
    r.body.appendChild(who); r.body.appendChild(qText);
    const whole = document.createElement('button'); whole.type = 'button'; whole.className = 'cq-whole'; whole.textContent = '▸ Show the whole question';
    whole.onclick = () => { const open = !r.d.classList.contains('cq-open'); r.d.classList.toggle('cq-open', open); whole.textContent = open ? '▾ Show less' : '▸ Show the whole question'; };
    r.body.appendChild(whole);
    // measured after layout and again whenever COMMS changes size: the key shows exactly while the question is clamped
    fitWhole(qText, whole, () => r.d.classList.contains('cq-open'));
    // TWO KINDS of suggestion, and the same law the end-run card obeys: GROUNDED comes from the
    // Commander's own answered history (>=2 times) and is PROVABLE, so it outranks the model's guess and
    // states its count; `recommended` is a guess with a rationale and stands only when nothing was observed.
    const gOpts = (q.grounded && Array.isArray(q.grounded.options)) ? q.grounded.options.filter(o => (q.options || []).indexOf(o) >= 0) : [];
    const gCount = Number(q.grounded && q.grounded.count) || 0;
    const useGrounded = gOpts.length > 0 && gCount >= 2;
    const starred = useGrounded ? gOpts : ((q.recommended && (q.options || []).indexOf(q.recommended) >= 0) ? [q.recommended] : []);
    const isStar = (opt) => starred.indexOf(opt) >= 0;
    // one plain line on how to answer, and what the ★ is (a grounded ★ states its real count); it goes once answered
    const hint = document.createElement('div'); hint.className = 'cq-hint';
    const howTo = ((q.multiSelect === true && (q.options || []).length > 1) ? 'Pick all that apply, then confirm.' : 'Tap an answer.')
      + (useGrounded ? (gOpts.length > 1 ? ' ★ are your usual picks (chosen ' + gCount + '+ times before).' : ' ★ is your usual pick (chosen ' + gCount + ' times before).')
        : starred.length ? ' ★ is ' + askedBy + '\'s suggestion.' : '');
    hint.textContent = howTo;
    // the model's reason is kept, one tap away — never a paragraph between the question and its answers
    let why = null;
    if (q.reason) {
      why = document.createElement('details'); why.className = 'cq-why';
      const sum = document.createElement('summary'); sum.textContent = 'Why ' + askedBy + ' is asking';
      const body = document.createElement('p'); body.textContent = q.reason;
      why.appendChild(sum); why.appendChild(body);
    }
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false, submitting = false, received = null, applyElsewhere = null;
    async function answer(text, doneLabel, key) {
      if (decided || submitting) return false;
      submitting = true;
      const buttons = Array.from(btns.querySelectorAll('button')), disabled = buttons.map(b => b.disabled);
      buttons.forEach(b => { b.disabled = true; });
      // the pressed key stays lit and the hint says it is on its way (one answer; a refusal frees the keys again)
      if (key) key.classList.add('sel'); hint.textContent = 'Sending your answer…';
      const rid = p.runId || ((ws && typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : null);
      try {
        const result = await Harness.consentAnswer(rid, p.promptId, text, true);
        if (!(result && result.ok)) throw new Error('The station did not confirm your answer. Please try again.');
      } catch (e) {
        submitting = false;
        if (received && applyElsewhere) { applyElsewhere(received); return; }
        if (key) key.classList.remove('sel'); hint.textContent = howTo;
        buttons.forEach((b, i) => { b.disabled = disabled[i]; });
        if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Could not answer: ' + ((e && e.message) || e), 'warn');
        return false;
      }
      submitting = false; decided = true;
      askAnswerers.delete(String(p.promptId || ''));
      if (received && applyElsewhere) applyElsewhere(received);
      if (ws) settlePromptNotice(ws.id, p.promptId);
      // answered: tell the bus, as the approval card does — the CREW card's "needs your OK" frame and the world's
      // AWAITING pose clear on permission.response, and a question never emitted one (sweep 2026-10-02)
      try { if (typeof U !== 'undefined' && U.bus) U.bus.emit('permission.response', { promptId: p.promptId, decision: 'once', via: 'desk' }); } catch (_) {}
      if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now(), p.promptId);   // the wait never counts as run time
      if (isActiveWs(ws)) renderPresence();
      btns.remove(); hint.remove(); keepFocus(r.d); releaseCard(r.d);
      const tag = document.createElement('span'); tag.className = 'consent-result'; tag.textContent = doneLabel;
      r.body.appendChild(tag); if (why) r.body.appendChild(why);
      syncStatus();
      return true;
    }
    if (ws && p.promptId && !p.workerStreamId) askAnswerers.set(String(p.promptId), { wsId: ws.id, answer: (text) => answer(text, '✓ ' + glance(text, 60)), isDone: () => decided });
    const opts = Array.isArray(q.options) ? q.options.slice(0, 6) : [];
    if (q.multiSelect === true && opts.length > 1) {
      // NON-EXCLUSIVE options: chips toggle, a confirm chip fires. The answer is the Commander's picks
      // joined as plain text — a typed multi-answer was always legal downstream, so the store and the
      // model see exactly what free text would have said.
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
        b.className = 'consent-btn' + (isStar(opt) ? ' primary' : '');   // the suggested answer is the lit key
        b.textContent = (isStar(opt) ? '★ ' : '') + opt;
        b.onclick = () => answer(opt, '✓ ' + opt, b);
        btns.appendChild(b);
      }
    }
    const skip = document.createElement('button');
    skip.className = 'consent-btn quiet';
    skip.textContent = 'Use your judgment';   // the answer it sends stays 'use your judgment' (the host matches it)
    skip.onclick = () => answer('use your judgment', '✓ your call');
    btns.appendChild(skip);
    // BATCH-WIDE ESCAPE: opting out of a 3-question batch cost 3 taps, which is the wrong ratio for the
    // person the batch exists to spare. One tap hands back every remaining decision. Only offered while
    // questions actually remain — on the last one it would be a second button meaning the same thing.
    if (Number(q.total) > 1 && Number(q.ordinal) > 0 && Number(q.ordinal) < Number(q.total)) {
      const rest = document.createElement('button');
      rest.className = 'consent-btn quiet';
      const left = Number(q.total) - Number(q.ordinal) + 1;
      rest.textContent = 'Use your judgment for the rest (' + left + ')';
      rest.title = 'decide this and the remaining ' + (left - 1) + ' yourself — the run keeps going';
      rest.onclick = () => answer('use your judgment for the rest', '✓ your call on all ' + left);
      btns.appendChild(rest);
    }
    r.body.appendChild(btns); r.body.appendChild(hint); if (why) r.body.appendChild(why);
    // STARNET REMOTE: a paired phone can answer this question too (the sidecar then puts permission.response on this
    // run's stream, as for an approval). Settle the card to what happened — it used to keep live options and "awaiting
    // your answer…" after the run had moved on, and a tap then did nothing while the card claimed it answered.
    if (typeof U !== 'undefined' && U.bus && U.bus.on && U.bus.off) {
      const onElsewhere = applyElsewhere = (resp) => {
        if (!resp || resp.promptId !== p.promptId) return;
        if (submitting) { received = resp; return; }
        U.bus.off('permission.response', onElsewhere);
        if (decided) return;
        decided = true;
        if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now(), p.promptId);
        if (isActiveWs(ws)) renderPresence();
        btns.remove(); hint.remove(); releaseCard(r.d);
        const tag = document.createElement('span');
        tag.className = 'consent-result' + (resp.decision === 'deny' ? ' err' : '');
        tag.textContent = resp.stopped ? '■ ' + askerName(p, ws) + ' stopped before an answer' : resp.expired ? '✕ no answer in time — the agent used its judgment' : resp.decision === 'deny' ? '✕ declined' + settledWhere(resp) : '✓ answered' + settledWhere(resp);
        r.body.appendChild(tag); if (why) r.body.appendChild(why);
        syncStatus();
      };
      U.bus.on('permission.response', onElsewhere);
    }
    // Esc = "use your judgment": the reflexive dismiss defers the decision rather than silently denying a
    // question (a deny makes no sense here), matching the end-run card's skip chip semantics.
    r.d.tabIndex = -1;
    r.d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); answer('use your judgment', '✓ your call'); } });
    status('awaiting your answer…');
    const asker = (p && p.workerAgentId) ? askerName(p, ws) : name;   // a delegated worker's question names the worker, like its card
    if (ws && !announcedPrompt(p.promptId, ws) && typeof StationUI !== 'undefined') StationUI.notify(asker + ' has a quick question for you' + sessionNote(ws), 'warn', 'needsApproval', { kind: 'needs', go: { ws: ws.id }, key: 'needs:' + ws.id, prompt: p.promptId });
    else if (!ws && typeof StationUI !== 'undefined') StationUI.notify(asker + ' has a quick question for you' + sessionNote(ws), 'warn', 'needsApproval');
    const waitsItsTurn = revealCard(r.d) === 'queued';   // a card behind a held one takes focus only when its turn comes
    const composerBusy = !!(input && (document.activeElement === input || (input.value && input.value.trim())));
    if (!composerBusy && !waitsItsTurn) { try { r.d.focus({ preventScroll: true }); } catch (_) { try { r.d.focus(); } catch (_) {} } }
  }
  // p = a consent payload { promptId, tool, argsSummary } — works for both a live onPermission event and a
  // Channels snapshot.pending (re-rendered after a switch). ws is the origin stream, so the answer routes to
  // THAT stream's run (per-channel runId), not a single global one.
  /* ANSWER AN APPROVAL from any surface — this card, a delegated worker's row on its delegation card, the NEEDS YOU list
     (2026-10-11): one path. The sidecar's consent route (the lead's run is the one that holds the ask, also for a worker's),
     the bus (every rendered card of that ask settles), the channel (THIS ask only: a crewmate's open ask stays open), NEEDS
     YOU and the presence card. Returns what the sidecar actually applied (fullSaved: a "full" that really persisted). */
  const settledPromptNotices = new Set();
  function settlePromptNotice(wsId, promptId) {
    if (!wsId || typeof StationUI === 'undefined') return;
    const id = String(promptId || '');
    if (id && settledPromptNotices.has(id)) return;
    if (id) { settledPromptNotices.add(id); if (settledPromptNotices.size > 200) settledPromptNotices.delete(settledPromptNotices.values().next().value); }
    const pending = typeof Channels !== 'undefined' && Channels.pendingAllOf ? Channels.pendingAllOf(wsId).filter(p => String(p.promptId) !== id) : [];
    keepNeeds(wsId, pending);
  }
  // the conversation's one bell entry moves to the first ask still waiting, or settles once none is left
  function keepNeeds(wsId, pending) {
    if (pending.length) {
      const next = pending[0], ws = (typeof Workstreams !== 'undefined' && Workstreams.get && Workstreams.get(wsId)) || { id: wsId, agentId: next.agentId };
      // quiet: the sibling was already announced; its bell entry moves to it without a second toast and chime
      if (StationUI.notify) StationUI.notify(askerName(next, ws) + (next.tool === 'brief.ask' ? ' still needs your answer' : ' still wants to ' + actionPhrase(next)), 'warn', 'needsApproval', { kind: 'needs', go: { ws: wsId }, key: 'needs:' + wsId, prompt: next.promptId, quiet: true });
    } else if (StationUI.settleNotifs) StationUI.settleNotifs('needs:' + wsId);
  }
  /* A RUN'S END SETTLES ITS OWN WAITS, NEVER A BACKGROUND WORKER'S (2026-10-14): such a worker files under the same key, often
     mid-turn, and the end's blanket settle read "Handled" while NEEDS YOU and its row still waited. Its ask keeps the entry. */
  function settleRunNeeds(wsId) {
    if (!wsId || typeof StationUI === 'undefined') return;
    keepNeeds(wsId, typeof Channels !== 'undefined' && Channels.pendingAllOf ? Channels.pendingAllOf(wsId).filter(p => p && p.background === true) : []);
  }
  // what settled a card it did not submit itself, in words. The sidecar's remote answer (a phone) carries no `via`; this
  // page's other surfaces (a worker's row, NEEDS YOU, voice) answer through answerConsent, which says which on the bus —
  // and the label names what was APPLIED ('always' is not 'once'; review app-shell-ui-02 / 2026-10-13: a spoken "always
  // allow" read "approved once from your phone").
  function settledWhere(resp) { return resp.via === 'voice' ? ' by voice' : resp.via === 'needs-you' ? ' from NEEDS YOU' : resp.via ? '' : ' from your phone'; }
  // `own` = a card's own receipts (decision -> its done label): a card with no Always key (station.power, plugin.submit,
  // the login window) grants this one call whatever grade another surface sent, so it settles in its own yes/no words
  function settledLabel(resp, own) {
    if (resp.decision === 'deny') return ((own && own.deny) || '✕ denied') + settledWhere(resp);
    const words = { always: '✓ always allowed', session: '✓ approved for this session', full: '✓ full access' };
    const grade = own ? own[resp.decision] || (resp.decision === 'session' && own.always ? words.session : own.once) : words[resp.decision];
    return (grade || '✓ approved once') + settledWhere(resp);
  }
  async function answerConsent(p, ws, decision, via) {
    const rid = (p && p.runId) || ((ws && typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : null);
    const answer = await Harness.consent(rid, p.promptId, decision);
    if (answer && !answer.ok && answer.gone === true) {
      letGoneAskGo(p.promptId);
      const gone = new Error('that approval is no longer waiting, so your answer was not applied'); gone.gone = true;
      throw gone;
    }
    if (!(answer && answer.ok)) throw new Error((answer && answer.error) || 'The station did not confirm that answer. Please try again.');
    if (ws) settlePromptNotice(ws.id, p.promptId);
    const appliedDecision = (answer && answer.decision) || 'deny';
    let fullSaved = true;
    if (decision === 'full') {
      const saved = !!(answer && answer.ok && answer.approvalMode === 'full');
      const adopted = saved && typeof App !== 'undefined' && App.setApproval
        ? App.setApproval((answer && answer.agentId) || p.agentId || (ws && ws.agentId), 'full', { recorded: true })
        : false;
      fullSaved = saved && adopted;
    }
    // surface the decision on the bus (schema: permission.response) so listeners — e.g. the first-run tutorial —
    // can tell an approve from a deny and narrate the consent loop honestly. Additive; the run resumes via Harness.consent.
    try { if (typeof U !== 'undefined' && U.bus) U.bus.emit('permission.response', { promptId: p.promptId, decision: appliedDecision, via: via || 'desk' }); } catch (_) {}
    // NS conversational anchor: "Always" — and now "Full access" — on a path.trust card IS the project bless
    // (a standing path grant + known-projects row land on the sidecar). Stamp the origin session's projectRoot
    // with the SAME proposed root so the PROJECTS rail lists this session under its project — the identical
    // anchor "Work here" stamps. Both standing grades, never "once" (it grants nothing standing, so there is
    // no project row to attach to), and never overwrite an anchor the session already has.
    if (p.tool === 'path.trust' && (appliedDecision === 'always' || appliedDecision === 'full') && ws && typeof Workstreams !== 'undefined' && Workstreams.setProjectRoot) {
      try { if (p.argsSummary && !(Workstreams.get(ws.id) || {}).projectRoot) Workstreams.setProjectRoot(ws.id, p.argsSummary); } catch (_) {}
    }
    if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now(), p.promptId);   // closes the paused span once none remain — approval wait never counts as run time
    if (ws && isActiveWs(ws)) renderPresence();   // drop the paused styling the instant the run resumes
    syncStatus();
    return { answer, appliedDecision, fullSaved };
  }
  // the channel's record of an ask — a delegated worker's says who asked (sidecar attributeAsks): its row on the
  // delegation card answers it; askedAt gives the NEEDS YOU list its age
  function pendingFrom(ev, ws) {
    return { promptId: ev.promptId, agentId: ev.agentId || ws.agentId, tool: ev.tool, argsSummary: ev.argsSummary, runId: Channels.runIdOf(ws.id),
      workerAgentId: ev.workerAgentId || '', workerRunId: ev.workerRunId || '', workerStreamId: ev.workerStreamId || '', askedAt: ev.askedAt || Date.now() };
  }
  // who is asking: a delegated worker's ask names the worker (the sidecar stamps workerAgentId), never the lead
  function askerName(p, ws) {
    const id = (p && p.workerAgentId) || (ws && ws.agentId) || 'agent';
    return (typeof App !== 'undefined' && App.agentName && App.agentName(id)) || id;
  }
  /* A STOPPED RUN TAKES ITS OPEN CARDS WITH IT (live walkthrough 2026-10-13): after STOP the run's approval card kept
     live Approve once / Always / Full access / Deny keys while NEEDS YOU and the toast had already cleared — a key that
     answers nothing. promptId -> { wsId, runId, worker, background, retire(text) }; retireOpenConsents runs at the run's
     end. A BACKGROUND worker's ask (background:true — the station keeps it open past the lead's turn, and its runId IS the
     lead's) is never retired by a run's end: it settles through its own permission.response, or retireConsentCard when the
     reconnect snapshot no longer lists it (2026-10-14 review: such a card read "nothing was approved" with the ask live). */
  const openConsentCards = new Map();
  /* THE REPEAT-ASK LINE (org P02): on the SECOND ask for the same tool in the same direct chat, the card's keys row carries
     one quiet line saying what Always does — the only hint an approval card has (no auto-deny line: Andrew 10-14, "the
     approval key doesn't have to mention the auto denies"). Always is a standing grant across the station (permissions.js
     grantsPermanent), so the line says "from now on", never "here"; the tool is named in the card title's own words
     ("fs read", never "fs.read"). A first ask, a worker's ask and a background ask get no line.
     wsId -> Map(tool -> Set(promptId)): a re-render of the same ask never counts as a second ask. */
  const askedTools = new Map();
  // the tool in the card title's words (actionPhrase's ANY OTHER TOOL line): a connector tool says whose
  const toolWordsOf = t => { const mcp = /^mcp__(.+?)__(.+)$/.exec(t); return (mcp ? mcp[1] + ' ' + mcp[2] : t).replace(/[._]+/g, ' ').trim(); };
  function consentHintFor(p, ws) {
    const tool = String((p && p.tool) || '');
    if (!tool || !ws || !p || p.promptId == null || p.workerAgentId || p.workerRunId || p.background === true) return '';
    const byTool = askedTools.get(ws.id) || new Map(); askedTools.set(ws.id, byTool);
    const ids = byTool.get(tool) || new Set(); byTool.set(tool, ids);
    ids.add(String(p.promptId)); if (ids.size > 20) ids.delete(ids.values().next().value);
    return ids.size > 1 ? 'Always stops asking for ' + toolWordsOf(tool) + ' from now on' : '';
  }
  function retireOpenConsents(wsId, runId) {
    for (const [id, c] of openConsentCards) {
      if (c.wsId !== wsId || c.background) continue;
      // a delegated worker's ask can outlive its lead's run — only this run's own cards (or unattributed lead cards) retire
      if (c.runId ? c.runId !== runId : c.worker) continue;
      retireConsentCard(id, '■ the run ended before an answer — nothing was approved');
    }
    for (const [id, a] of askAnswerers) if (a.wsId === wsId) askAnswerers.delete(id);   // its questions are gone with it
  }
  function retireConsentCard(promptId, text) {
    const id = String(promptId || ''), c = openConsentCards.get(id);
    if (!c) return false;
    openConsentCards.delete(id);
    try { c.retire(text); } catch (e) { if (typeof console !== 'undefined') console.warn('[comms] retire card failed', e); }
    return true;
  }
  /* AN ASK THE STATION NO LONGER HOLDS (soak 10-15). The consent route says `gone` when no such ask waits anywhere: it was
     answered on a surface whose word never reached this page, it expired, or it was withdrawn (a restart). Retrying can never
     land, so this page lets go of it everywhere it shows — its record, its bell entry, its card and the worker's row — in
     neutral words: nothing is claimed about what settled it. */
  function letGoneAskGo(promptId) {
    const id = String(promptId);
    if (typeof Channels !== 'undefined' && Channels.allPending) {
      for (const { wsId, p } of Channels.allPending()) {
        if (!p || String(p.promptId) !== id) continue;
        Channels.clearPending(wsId, Date.now(), p.promptId);
        settlePromptNotice(wsId, id);
        if (typeof Workstreams !== 'undefined' && Workstreams.get && isActiveWs(Workstreams.get(wsId))) renderPresence();
      }
    }
    retireConsentCard(id, '■ no longer waiting on you');
    if (typeof Delegated !== 'undefined' && Delegated.repaint) Delegated.repaint();
    if (typeof NeedsYou !== 'undefined' && NeedsYou.render) NeedsYou.render();
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (e) { console.warn('[comms] rail refresh after a gone ask failed', e); }
    syncStatus();
  }
  function permissionRow(p, ws) {
    if (p && p.tool === 'brief.ask') return clarifyRow(p, ws);   // a question, not a grade — its own card
    // ONE PLACE PER STATUS: a delegated worker's ask is answered on that worker's row of the delegation card
    if (p && (p.workerStreamId || p.workerRunId) && typeof Delegated !== 'undefined' && Delegated.hosts && Delegated.hosts(p)) {
      Delegated.repaint();
      // the same one bell entry the lead's own ask gets, naming the worker (re-renders never re-toast: announcedPrompt)
      if (ws && !announcedPrompt(p.promptId, ws) && typeof StationUI !== 'undefined') StationUI.notify(askerName(p, ws) + ' wants to ' + actionPhrase(p), 'warn', 'needsApproval', { kind: 'needs', go: { ws: ws.id }, key: 'needs:' + ws.id, prompt: p.promptId });
      return null;
    }
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent'); r.d.dataset.liveAsk = '1';
    r.d.dataset.consentPrompt = String((p && p.promptId) || '');   // NEEDS YOU › Review lands here (revealAsk)
    r.body.appendChild(document.createTextNode('▣ ' + ((p && p.workerAgentId) ? askerName(p, ws) : name) + ' wants to ' + actionPhrase(p, true) + ' '));
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false, submitting = false, received = null, applyElsewhere = null;
    async function decide(decision, doneLabel, isDeny) {
      if (decided || submitting) return; submitting = true;
      for (const b of btns.querySelectorAll('button')) b.disabled = true;
      let res;
      try { res = await answerConsent(p, ws, decision); }
      catch (e) {
        submitting = false;
        // the station no longer holds this ask: answerConsent retired this card in neutral words (or this card does it here)
        if (e && e.gone) {
          if (!decided) { decided = true; btns.remove(); releaseCard(r.d); const tag = document.createElement('span'); tag.className = 'consent-result err'; tag.textContent = '■ no longer waiting on you'; r.body.appendChild(tag); syncStatus(); }
          return;
        }
        if (received && applyElsewhere) { applyElsewhere(received); return; }
        for (const b of btns.querySelectorAll('button')) b.disabled = false;
        if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Could not answer: ' + ((e && e.message) || e), 'warn');
        return;
      }
      submitting = false; decided = true;
      if (received && applyElsewhere) applyElsewhere(received);
      if (decision === 'full' && !res.fullSaved) { doneLabel = '✕ full access was not saved'; isDeny = true; }
      else if (decision !== 'full' && res.appliedDecision === 'deny' && decision !== 'deny') { doneLabel = '✕ approval was not applied'; isDeny = true; }
      btns.remove(); keepFocus(r.d); releaseCard(r.d);
      const tag = document.createElement('span');
      tag.className = 'consent-result' + (isDeny ? ' err' : '');
      tag.textContent = doneLabel;
      r.body.appendChild(tag);
      syncStatus();
    }
    const labels = {};   // decision -> this card's own receipt: an answer from another surface settles in the card's words
    const mk = (text, decision, cls, doneLabel, isDeny, title) => {
      labels[decision] = doneLabel;
      const b = document.createElement('button');
      b.className = 'consent-btn' + (cls ? ' ' + cls : '');
      b.textContent = text;
      if (title) b.title = title;
      b.onclick = () => decide(decision, doneLabel, isDeny);
      btns.appendChild(b); return b;
    };
    // ATTENDED BROWSER LOGIN cards get purpose-built buttons: "Always"/"Full access" make no sense for a
    // one-shot window open, and the done-wait card is a completion signal, not a permission grade.
    if (p.tool === 'browser.login') {
      mk('Open login window', 'once', 'primary', '✓ window opened', false);
      mk('Deny', 'deny', 'deny', '✕ denied', true);
    } else if (p.tool === 'browser.login.done') {
      mk('Done — I\'ve logged in', 'once', 'primary', '✓ done', false);
      mk('Cancel', 'deny', 'deny', '✕ cancelled', true);
    } else if (p.tool === 'station.power' || p.tool === 'plugin.submit') {
      // widening the station's leash and installing a plugin are answered fresh every time (freshConsent tools,
      // permissions.js tier 1.5): the station grants any yes once, so no Always and no Full access
      mk('Approve once', 'once', 'primary', '✓ approved once', false);
      mk('Deny', 'deny', 'deny', '✕ denied', true);
    } else {
      const agentName = (p && p.workerAgentId) ? askerName(p, ws) : name;
      mk('Approve once', 'once', 'primary', '✓ approved once', false, 'Allow just this one');
      mk('Always', 'always', '', '✓ always allowed', false, 'Allow this kind of action from now on, without asking');
      mk('Full access', 'full', 'danger', '✓ full access', false, 'Give ' + agentName + ' full access: it stops asking before most actions, until you change it back');
      mk('Deny', 'deny', 'deny', '✕ denied', true);
      // a repeat ask's one line (what Always does), inside the keys' row so it leaves with them once the card is answered
      const hintText = consentHintFor(p, ws);
      if (hintText) { const hint = document.createElement('span'); hint.className = 'consent-hint'; hint.textContent = hintText; btns.appendChild(hint); }
    }
    appendConsentDetails(r.body, p, 'plan');   // a station build's steps and drawing are read before deciding
    r.body.appendChild(btns);
    appendConsentDetails(r.body, p, 'inspect');
    // STARNET REMOTE: a paired phone can answer this same prompt. The sidecar then puts permission.response on
    // this run's own stream (harness re-emits it on U.bus). Settle the card to what actually happened, so the
    // desk never keeps live buttons on a question that was already answered elsewhere. The desk's own answer
    // also emits permission.response, but by then `decided` is set and this listener just unsubscribes. An answer from
    // another surface on this page (voice, a worker's row, NEEDS YOU) arrives the same way, its surface named in `via`
    // by answerConsent.
    if (typeof U !== 'undefined' && U.bus && U.bus.on && U.bus.off) {
      const onElsewhere = applyElsewhere = (resp) => {
        if (!resp || resp.promptId !== p.promptId) return;
        if (submitting) { received = resp; return; }
        U.bus.off('permission.response', onElsewhere);
        if (decided) return;
        decided = true;
        const denied = resp.decision === 'deny';
        if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now(), p.promptId);
        if (isActiveWs(ws)) renderPresence();
        btns.remove(); releaseCard(r.d);
        const tag = document.createElement('span');
        tag.className = 'consent-result' + (denied ? ' err' : '');
        // the grade the station applied, in this card's own words: a card with no Always key (station.power,
        // plugin.submit, the login window) grants this one call whatever grade another surface sent. An answer given
        // on this page (voice, a worker's row, NEEDS YOU) names its own surface, not the phone
        // stopped: a background worker stopped while its ask waited (the station says so) — it was never left unanswered
        tag.textContent = resp.stopped ? '■ ' + askerName(p, ws) + ' stopped before an answer — nothing was approved' : resp.expired ? '✕ no answer in time — denied' : settledLabel(resp, labels);
        r.body.appendChild(tag);
        syncStatus();
      };
      U.bus.on('permission.response', onElsewhere);
    }
    if (ws && p && p.promptId) openConsentCards.set(String(p.promptId), { wsId: ws.id, runId: String(p.runId || ''), worker: !!(p.workerAgentId || p.workerRunId), background: p.background === true,
      retire: (text) => {
        if (decided) return;
        decided = true;
        try { if (applyElsewhere && typeof U !== 'undefined' && U.bus && U.bus.off) U.bus.off('permission.response', applyElsewhere); } catch (e) { applyElsewhere = null; }
        btns.remove(); releaseCard(r.d);   // no longer a live ask: a held card lets the follow (and the next card) go
        const tag = document.createElement('span'); tag.className = 'consent-result err'; tag.textContent = text;
        r.body.appendChild(tag);
      } });
    // a blocking, run-pausing prompt: make it keyboard-operable. Esc on the focused CONTAINER = Deny (the row,
    // not a button — so a reflexive Enter never lands on Approve and greenlights a write the user didn't read).
    r.d.tabIndex = -1;
    r.d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); decide('deny', '✕ denied', true); } });
    status('awaiting your approval…');
    const asker = (p && p.workerAgentId) ? askerName(p, ws) : name;   // a delegated worker's ask names the worker
    // ONE APPROVAL, ONE PLACE YOU ARE LOOKING (live walkthrough 2026-10-13: one file write was announced in 7 places). The
    // Commander already has this card in front of them when its conversation is open and the page is visible: the bell
    // still files it (NEEDS YOU, the SYSTEM badge) but quietly — no corner toast, no chime. BUILD MODE hides COMMS, so
    // there (and in any other conversation, or a hidden window) it still toasts.
    const seenHere = !!(ws && isActiveWs(ws) && typeof document !== 'undefined' && !document.hidden && log && log.getClientRects && log.getClientRects().length);
    if (ws && !announcedPrompt(p.promptId, ws) && typeof StationUI !== 'undefined') StationUI.notify(asker + ' wants to ' + actionPhrase(p), 'warn', 'needsApproval', { kind: 'needs', go: { ws: ws.id }, key: 'needs:' + ws.id, prompt: p.promptId, quiet: seenHere });
    else if (!ws && typeof StationUI !== 'undefined') StationUI.notify(asker + ' wants to ' + actionPhrase(p), 'warn', 'needsApproval');   // P1-8 category: consent prompt
    // FOCUS-STEAL GUARD (P0): a consent prompt must NEVER hijack focus from a Commander who is mid-typing or holds
    // a draft — a stolen focus + a reflexive Enter could approve a file write they never read. Only follow the
    // scroll when they were already at the bottom (honor stick), and only take focus (onto the row CONTAINER, so
    // Esc=deny works but Enter can't approve) when the composer is idle. Esc still denies either way: an idle
    // composer gets the row's Esc handler; a busy composer's own Esc handler stops the paused run (also a deny).
    const waitsItsTurn = revealCard(r.d) === 'queued';   // honors stick; a tall card shows from its top; one card held at a time
    const composerBusy = !!(input && (document.activeElement === input || (input.value && input.value.trim())));
    if (!composerBusy && !waitsItsTurn) { try { r.d.focus({ preventScroll: true }); } catch (_) { try { r.d.focus(); } catch (_) {} } }
  }

  // EL-11 FIX 1a: a consent prompt on a NON-displayed session used to be invisible — permissionRow (and its
  // notify) render for the active stream only, so a background prompt's run silently auto-denied on the sidecar's
  // consent timeout. A deny nobody saw is a consent violation. This is the GLOBAL surface: the moment a background
  // session gains a pending consent, fire a clickable toast naming the AGENT + the action; clicking it opens THAT
  // session via the same restore path as a rail-row click (Chat.load re-renders the consent card from the Channels
  // snapshot). Also refresh the rail immediately so the row's NEEDS-YOU marker lands without waiting for the ticker.
  /* ONE bell entry per prompt, settled wherever the prompt is answered. The desk card settled its own entry, but an answer
     from the phone, Telegram or voice (permission.response on the bus) left NEEDS YOU "waiting" for good; and re-rendering a
     pending card (reopening the session) toasted and re-filed the same prompt every time. */
  const promptNeeds = new Map();   // promptId -> the bell key it was filed under
  function announcedPrompt(promptId, ws) {
    if (!promptId || !ws) return false;
    const id = String(promptId);
    if (promptNeeds.has(id)) return true;
    promptNeeds.set(id, 'needs:' + ws.id);
    if (promptNeeds.size > 200) promptNeeds.delete(promptNeeds.keys().next().value);
    return false;
  }
  if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('permission.response', (resp) => {
    const key = resp && resp.promptId != null ? promptNeeds.get(String(resp.promptId)) : null;
    if (!key) return; // an unknown response cannot claim another conversation's pending state
    const wsId = key.slice('needs:'.length);
    // Background/delegated asks may have no mounted card to clear their channel record.
    // Remove only this confirmed response before choosing the sibling that still needs attention.
    if (typeof Channels !== 'undefined' && Channels.clearPending) Channels.clearPending(wsId, Date.now(), resp.promptId);
    settlePromptNotice(wsId, resp.promptId);
  });
  function backgroundPermissionNotify(ev, ws) {
    // the AGENT that asks — a delegated worker's ask names the worker, never the lead it rode in on
    const who = (typeof App !== 'undefined' && App.agentName && App.agentName((ev && ev.workerAgentId) || ws.agentId || 'agent')) || ws.agentId || 'an agent';
    if (!announcedPrompt(ev && ev.promptId, ws) && typeof StationUI !== 'undefined' && StationUI.notify) {
      StationUI.notify(who + ' wants to ' + actionPhrase(ev) + sessionNote(ws), 'warn', 'needsApproval',
        { kind: 'needs', go: { ws: ws.id }, key: 'needs:' + ws.id, prompt: ev && ev.promptId });
    }
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
  }

  /* A BACKGROUND WORKER'S ASK (2026-10-13). A worker handed off in the background (team.dispatch background:true) runs on
     after the reply that started it ended, so its approvals can never ride that reply's stream: the sidecar announces them
     on the station bus (background:true, stamped with the conversation that handed the work off and the run id to answer
     with — index.js askHuman), and the reconnect snapshot lists them while they wait. File each one under that
     conversation exactly like a live run's own ask (Channels → its worker row's Approve once / Deny + Inspect, NEEDS YOU,
     the bell) and attest it is on screen (consentAck → the one bounded extension). The answer goes through answerConsent
     → POST /api/consent with that runId; its permission.response (here or from any other surface) clears it. */
  function backgroundAskHome(ev) {
    if (typeof Workstreams === 'undefined' || !Workstreams.get) return null;
    const direct = ev.streamId ? Workstreams.get(ev.streamId) : null;
    if (direct) return direct;
    const thread = ev.workerStreamId ? Workstreams.get(ev.workerStreamId) : null;
    return (thread && thread.parentStreamId && Workstreams.get(thread.parentStreamId)) || null;
  }
  function fileBackgroundAsk(ev) {
    if (!ev || ev.background !== true || !ev.promptId || !ev.runId || typeof Channels === 'undefined') return false;
    const ws = backgroundAskHome(ev);
    if (!ws) return false;   // no conversation on this page handed this work off: the surface that did answers it
    if (Channels.pendingAllOf(ws.id).some(x => x && String(x.promptId) === String(ev.promptId))) return true;   // already filed
    Channels.setPending(ws.id, Object.assign(pendingFrom(ev, ws), { runId: String(ev.runId), agentId: ev.leadAgentId || ev.agentId || ws.agentId, background: true }));
    if (isActiveWs(ws)) { permissionRow(ev, ws); syncStatus(); } else backgroundPermissionNotify(ev, ws);
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (e) { console.warn('[comms] rail refresh after a background ask failed', e); }
    try {
      Promise.resolve(Harness.consentAck(ev.runId, ev.promptId)).then(v => { if (!(v && v.ok)) consentAckFailed(ws, ev, v); },
        e => consentAckFailed(ws, ev, { ok: false, error: (e && e.message) || String(e) }));
    } catch (e) { consentAckFailed(ws, ev, { ok: false, error: (e && e.message) || String(e) }); }
    return true;
  }
  if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('permission.prompt', fileBackgroundAsk);
  /* The reconnect snapshot (world.js fetchSnapshot: every bridge (re)open, then every 30 s) is the station's own list of
     open asks. A background ask this page never heard (it reloaded, or the bridge was down) is announced on the page bus
     the way the bridge would have — so the worker's row, NEEDS YOU, the bell, CREW and the floor all learn it at once. A
     filed background ask the station no longer lists, and that is older than the snapshot, was settled while this page
     was not listening: it is withdrawn here (no decision is claimed for it — its fallback card says only that it no longer
     waits). Each ask is announced ONCE per page life (`reannounced`, pruned when the station stops listing it): one this
     page cannot file (its conversation is not here yet) is filed quietly by a later snapshot once it can be, never
     re-announced to every listener every 30 s. An ask this page already settled is never revived by a snapshot taken
     just before that answer landed. */
  const reannounced = new Set();
  function reconcileBackgroundAsks(snap) {
    if (!snap || !Array.isArray(snap.prompts) || typeof Channels === 'undefined' || !Channels.allPending) return;
    const open = new Set();
    let filedLate = 0;
    for (const row of snap.prompts) {
      if (!row || row.background !== true || !row.promptId) continue;
      const id = String(row.promptId);
      open.add(id);
      if (settledPromptNotices.has(id) || Channels.allPending().some(x => x.p && String(x.p.promptId) === id)) continue;
      const ev = { promptId: row.promptId, agentId: row.leadAgentId || 'agent', tool: row.tool, scope: row.scope, argsSummary: row.argsSummary || '',
        workerAgentId: row.workerAgentId || '', workerRunId: row.workerRunId || '', workerStreamId: row.workerStreamId || '', askedAt: row.askedAt || Date.now(),
        background: true, runId: row.runId, streamId: row.streamId || '' };
      if (reannounced.has(id)) { if (fileBackgroundAsk(ev)) filedLate++; continue; }
      reannounced.add(id);
      if (typeof U !== 'undefined' && U.bus && U.bus.emit) U.bus.emit('permission.prompt', ev); else fileBackgroundAsk(ev);
    }
    for (const id of reannounced) if (!open.has(id)) reannounced.delete(id);
    const asOf = Number(snap.ts) || 0;
    let withdrawn = 0;
    for (const { wsId, p } of Channels.allPending()) {
      if (!p || p.background !== true || open.has(String(p.promptId)) || !asOf || !(Number(p.askedAt) < asOf - 5000)) continue;
      Channels.clearPending(wsId, Date.now(), p.promptId);
      settlePromptNotice(wsId, p.promptId);
      retireConsentCard(p.promptId, '■ no longer waiting on you');
      withdrawn++;
    }
    if (!withdrawn && !filedLate) return;
    if (typeof Delegated !== 'undefined' && Delegated.repaint) Delegated.repaint();
    if (typeof NeedsYou !== 'undefined' && NeedsYou.render) NeedsYou.render();
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (e) { console.warn('[comms] rail refresh after a settled background ask failed', e); }
    syncStatus();
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
    if (saved && saved.ok && !saved.duplicate && (verdict === 'ok' || verdict === 'miss')) lastShortVerdict = { runId: runId, agentId: agentId || 'agent', streamId: ((runMeta(runId) || {}).streamId) || awayStreams.get(runId) || null, at: Date.now() };
    return saved;
  }
  let lastShortVerdict = null;   // { runId, agentId, streamId, at } — the run whose next message (in ITS session) is its correction
  const awayStreams = new Map();   // runId -> streamId for runs this page did not start (seedAwayWork)
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
    // (2026-10-02, Andrew: "we dont want it to be an eye sore") the explainer no longer prints as a line; it is the
    // thumbs-up's tooltip on every render, so the card stays one summary line + one row of two thumbs.
    const lbl = document.createElement('span'); lbl.className = 'work-rate-label';
    // name the RUN's agent, not whoever the active chat happens to be bound to — the OUTBOX window
    // (and any multi-agent surface) rates crew runs while a different agent is on screen. The verdict
    // already routes by the agentId param; the label must agree with it (truthful telemetry).
    let ratee = name;
    try { if (typeof App !== 'undefined' && App.agentName) ratee = App.agentName(agentId || 'agent') || name; } catch (_) {}
    const ratedMeta = runMeta(runId);
    const ratedWork = runWork.get(runId);
    const ratedTask = String((ratedMeta && ratedMeta.directive) || (ratedWork && ratedWork.title) || '').replace(/\s+/g, ' ').trim();
    lbl.textContent = 'rate ' + ratee + '’s work';
    // one short line: what was asked + a short, stable run reference (the full task and run id are its tooltip).
    // (org D1) no task text → no line: a bare 'run 3f9a2c1b' tells the reader nothing, so the id rides the label's tip.
    if (ratedTask) {
      const ref = document.createElement('div'); ref.className = 'work-rate-reference';
      ref.textContent = ratedTask.slice(0, 90) + (ratedTask.length > 90 ? '…' : '') + ' · run ' + String(runId).slice(0, 8);
      ref.title = ratedTask + ' · run ' + runId;
      host.appendChild(ref);
    } else lbl.title = 'run ' + runId;
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
    function mk(label, cls, verdict, flash, isDeny, icon, tip) {
      const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : '');
      if (icon) { b.innerHTML = icon; b.setAttribute('aria-label', label); b.title = tip || label; }
      else b.textContent = label;
      b.onclick = () => settle(verdict, flash, isDeny); btns.appendChild(b);
    }
    // THUMBS (2026-10-02, Andrew: "it should just be thumbs up or thumbs down but with the terminal ASCII style"):
    // two pixel-grid thumbs drawn on a 16-cell grid (crisp edges, phosphor via currentColor). Up = the top mark
    // (verdict 'great': size-weighted XP + trust), down = 'miss'. The middle 'ok' verdict is no longer offered here;
    // the server and XpStore still accept it, so older ratings and other callers are unaffected.
    const THUMB = '<svg class="thumb-px" viewBox="0 0 16 16" width="18" height="18" shape-rendering="crispEdges" aria-hidden="true" fill="currentColor">'
      + '<rect x="7" y="1" width="2" height="5"/><rect x="6" y="4" width="1" height="2"/>'
      + '<rect x="6" y="6" width="8" height="2"/><rect x="6" y="9" width="7" height="2"/><rect x="6" y="12" width="6" height="2"/>'
      + '<rect x="2" y="6" width="3" height="8"/></svg>';
    mk('nailed it', 'primary thumb thumb-up', 'great', '★ +XP', false, THUMB, 'nailed it — earns XP and builds trust');
    mk('missed', 'deny thumb thumb-down', 'miss', 'noted', true, THUMB, 'missed — tell me what to fix next time');
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
    // INLINE (Andrew 10-03: "i dont like that its big and centered, shouldnt even pop up in such a big box make it
    // smaller"): the standalone ask is one slim row under the run it rates — label + two small thumbs. It lands right
    // under that run's footer, so the "task · run id" line moves into the row's hover tip instead of printing.
    r.d.classList.add('rate-inline');
    const ref = r.body.querySelector('.work-rate-reference');
    if (ref && ref.title) r.body.setAttribute('data-tip', ref.title);
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
    // an away run's SESSION (OUTBOX rows, routines, runs from before a reload): runMeta only knows this page's own runs,
    // so a thumbs-down here must still know which session its correction belongs to (sweep 2026-10-02)
    if (rw && rw.runId && rw.streamId) { awayStreams.set(rw.runId, String(rw.streamId)); if (awayStreams.size > 120) awayStreams.delete(awayStreams.keys().next().value); }
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
      const ob = document.createElement('button'); ob.className = 'consent-btn'; ob.textContent = '▸ open TO REVIEW';
      ob.onclick = () => StationUI.openTerm('outbox');
      foot.appendChild(ob);
    }
    const dis = document.createElement('button'); dis.className = 'consent-btn deny'; dis.textContent = 'dismiss';
    dis.onclick = () => vanish(r.d);
    foot.appendChild(dis);
    // ADOPTION (Lane F): a dim line so dismissing doesn't read as LOSING the runs — they wait in TO REVIEW. A plain aside on a
    // line of its own (org pass 10-14, P12 polish): boxed as a .turnin-queue chip it read as one more key beside the real ones.
    if (typeof ReturnStore !== 'undefined' && ReturnStore.outboxLine) {
      const keep = document.createElement('span'); keep.className = 'turnin-evidence turnin-keep'; keep.textContent = ReturnStore.outboxLine();
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
    title.textContent = '◈ finished while you were away:';
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
  /* the glance of a reply quoted on a card: plain words, the library's own markdown → one line (Deliverables.plainLine) — walk
     10-14: the delivered card quoted '“## Findings - **Item one:** … `code`”' while every other place reads the reply rendered */
  function plainQuote(raw, max) {
    const t = (typeof Deliverables !== 'undefined' && Deliverables.plainLine) ? Deliverables.plainLine(raw) : String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    return t ? '“' + (t.length > max ? t.slice(0, max).trimEnd() + '…' : t) + '”' : '';
  }
  function sampleCard(opts) {
    opts = opts || {};
    if (!log) return;
    // the Commander asked for this card by clicking the INBOX: a quick tour covering COMMS steps aside so it is not posted unseen
    try { if (typeof Dialogue !== 'undefined' && Dialogue.yieldTour && Dialogue.isOpen && Dialogue.isOpen()) Dialogue.yieldTour(); } catch (_) {}
    /* …any OTHER open conversation is the Commander's to answer — never answered for them (its "not now" is a real decline
       the learning loop records). The card still posts below it, so SAY where it went: a silent click read as a dead INBOX
       (2026-09-28 retest, the goal-path question covering COMMS). */
    const covered = () => { try { return typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen(); } catch (_) { return false; } };
    const sayCovered = () => { if (covered() && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('The INBOX card is in COMMS, under the question your agent is asking. Answer it, and the card is right there.', 'info', undefined, { transient: true }); };
    if (sampleCardEl && sampleCardEl.isConnected) { autoscroll(); sayCovered(); return; }   // one live card at a time
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('sample-card');
    sampleCardEl = r.d;
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ INBOX — prove the line: send one small, real job through it, end to end.';   // (org D6) 'send', like its ▸ SEND A REAL JOB key
    r.body.appendChild(title);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const text = document.createElement('span'); text.className = 'turnin-text';
    const job = (typeof Build !== 'undefined' && Build.testJobForProp) ? Build.testJobForProp(opts.propId) : null;
    text.textContent = (job && job.text
      ? 'your test job (“' + (job.text.length > 70 ? job.text.slice(0, 70) + '…' : job.text) + '”) rides the real belts'
      : 'a labeled test crate (“SAMPLE JOB…”) rides the real belts — write your own test job in the INBOX’s Workflow panel —')
      + ' — the router picks the dock, the run spends real budget, and the reply lands in this line’s OUTBOX and is also filed in DELIVERABLES.';
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(text); item.appendChild(btns);
    r.body.appendChild(item);
    const note = document.createElement('div');   // refusal / result area (below the action row)
    r.body.appendChild(note);
    const run = document.createElement('button'); run.className = 'consent-btn primary'; run.textContent = '▸ SEND A REAL JOB';
    const later = document.createElement('button'); later.className = 'consent-btn deny'; later.textContent = 'not now';
    later.onclick = () => vanish(r.d);
    btns.appendChild(run); btns.appendChild(later);
    if (opts.schedOff) {
      // a schedule IS saved; the station's scheduling is off — the fix is one click, right here (R3)
      const arm = document.createElement('button'); arm.className = 'consent-btn'; arm.textContent = '▶ TURN SCHEDULING ON';
      arm.onclick = () => {
        arm.disabled = true; arm.textContent = '… turning on';
        Harness.api.post('/api/cron/arm', { enabled: true }).then(res => {
          const ok = !!(res && res.ok && res.j && res.j.ok);
          arm.textContent = ok ? '✓ scheduling is on' : 'could not turn scheduling on';
          if (!ok) arm.disabled = false;
          if (ok && typeof World !== 'undefined' && World.pollFeed) { try { World.pollFeed(); } catch (_) {} }
        }).catch(() => { arm.disabled = false; arm.textContent = '▶ TURN SCHEDULING ON'; });
      };
      btns.appendChild(arm);
    }
    if (opts.fed === false && !opts.schedOff && typeof StationUI !== 'undefined' && StationUI.openTerm) {
      // the floor PROVABLY has no feed wired (server-answered, never guessed) — keep the promised door here
      const feed = document.createElement('button'); feed.className = 'consent-btn'; feed.textContent = '▸ WIRE A REAL FEED — CHANNELS';
      feed.onclick = () => StationUI.openTerm('messaging');
      btns.appendChild(feed);
    }
    const fail = (msg) => {
      const err = document.createElement('span'); err.className = 'consent-result err';
      err.textContent = msg;
      note.textContent = ''; note.appendChild(err);
      run.disabled = false; later.disabled = false; run.textContent = '▸ SEND A REAL JOB';
      autoscroll();
    };
    run.onclick = () => {
      run.disabled = true; later.disabled = true;
      run.textContent = '⌛ the job is riding the line…';   // honest: the POST is genuinely open until the line delivers
      note.textContent = '';
      Harness.api.post('/api/routing/sample', job ? Object.assign({}, job.text ? { text: job.text } : {}, job.line ? { line: job.line } : {}) : {}).then(res => {
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
        const whoId = (j.delivered && j.delivered.agentId) || j.agentId || 'agent';
        // the agent's NAME, not its internal id (the seeded hero's id is literally "agent")
        const whoRec = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []).find(a => a && a.id === whoId) : null;
        const who = String((whoRec && whoRec.name) || whoId).toUpperCase();
        const cost = (+j.totalUsd > 0 && typeof U !== 'undefined' && U.usd) ? (' · ' + U.usd(+j.totalUsd)) : '';
        text.textContent = clean
          ? ('✔ job delivered — ' + who + ' finished the last step' + cost + '.' + (folded ? ' the result waits in TO REVIEW.' : ''))
          : ('⚠ the job rode the line, but the run did not finish clean — the reply below says why.');
        // a long answer reaches the line's channel in chunks: a clean job is quoted from its OPENING words (where TO REVIEW's glance
        // starts), never whichever chunk came last ('“All done.”' for a 5k answer, review 10-14); a job that did not finish clean
        // is quoted by its last word — the reason the text above promises
        const said = (j.replies && j.replies.length) ? (clean ? j.replies.join('\n') : j.replies[j.replies.length - 1]) : '';
        const reply = said ? plainQuote(said, 220) : '';
        if (reply) {
          const out = document.createElement('div'); out.className = 'turnin-text';
          out.textContent = reply;
          note.appendChild(out);
        }
        const acts = document.createElement('div'); acts.className = 'turnin-rate';
        if (folded && typeof StationUI !== 'undefined' && StationUI.openTerm) {
          const ob = document.createElement('button'); ob.className = 'consent-btn'; ob.textContent = '▸ open TO REVIEW';
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
    sayCovered();
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
      // a web page runs in the station's BROWSER window (same sandboxed /workshop-run/ bytes, OPEN OUTSIDE there)
      if (typeof OutputBrowser !== 'undefined' && OutputBrowser.isHtml && OutputBrowser.isHtml(relPath)) {
        OutputBrowser.open({ agentId, runId: m.runId, path: relPath, source: 'workshop' });
        return;
      }
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
        warn.textContent = 'Heads up: it captures your mouse and keyboard when opened (pointer lock). Press Esc to release it.';
        r.body.appendChild(warn);
      }
      if (m.usesMedia) {
        const warn = document.createElement('div'); warn.className = 'ws-line ws-capture-warn';
        warn.textContent = 'Heads up: it may ask to use your camera, microphone, or screen when opened.';
        r.body.appendChild(warn);
      }
      const tryRow = document.createElement('div'); tryRow.className = 'turnin-rate ws-try';
      const openItBtn = document.createElement('button'); openItBtn.className = 'consent-btn ws-openit'; openItBtn.textContent = 'Open it — try it in a tab';
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
      pl.textContent = 'This patch can’t be applied automatically (' + (plan.patchRefused || 'no valid target') + '). '
        + 'The button below only saves the .patch file — add the target project in PROJECTS to enable auto-apply.';
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
            if (nRemoved && !nMissing) done = 'Keep undone — removed ' + nRemoved + ' file' + (nRemoved === 1 ? '' : 's') + ' from ' + (j.destPath || destPath) + '. This build is pending again.';
            else if (nRemoved && nMissing) done = 'Keep undone — removed ' + nRemoved + ', but ' + nMissing + ' file' + (nMissing === 1 ? ' was' : 's were') + ' already moved or gone. This build is pending again.';
            else done = 'Nothing to remove — those files were already moved or deleted' + (j.restored ? '. This build is pending again.' : '.');
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
    // final = the line is the build's outcome (kept, saved, built, discarded): it tells the session's story from here on
    const decideNote = (label, final) => { try { if (opts.noteDecision) opts.noteDecision(label, { decided: !!final }); } catch (_) {} };

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
        const starting = who + ' is building ' + (steer ? '“' + steer + '”' : 'this') + ' now. The finished build arrives as its own card.';
        decideNote(starting);
        // start the build IMMEDIATELY, but only report its outcome after the card has settled into its feed line —
        // otherwise an instant refusal (no key, discarded) prints its "didn't finish" line ABOVE the line it answers.
        let buildP = null; try { buildP = Promise.resolve(opts.onImplement(steer)).catch(() => null); } catch (_) { buildP = Promise.resolve(null); }
        await settle(starting, false, '');
        const br = await buildP;
        if (br && br.reason === 'built') {
          const okLine = 'Built — “' + String((br.manifest && br.manifest.title) || 'the build') + '” is waiting in your rail.';
          decideNote(okLine, true); localLine(okLine);
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
        ? ('Implemented — applied to branch ' + (res.branch || '?') + (res.root ? (' in ' + res.root) : '') + '.')
        : res.savedOnly
          ? ('Patch file saved to ' + (res.destPath || 'your StarNet deliverables folder') + ' — not applied to your project.')
          : ('Implemented — files saved to ' + (res.destPath || 'your StarNet deliverables folder') + '.');
      decideNote(saved, true); sendNote(); settle(saved, false, res.applied ? '' : (res.destPath || ''));
    };
    acts.appendChild(implBtn);

    // LATER — dismiss; the session stays in the rail and the card returns next time this session opens.
    const laterBtn = document.createElement('button'); laterBtn.className = 'consent-btn'; laterBtn.textContent = 'Later';
    laterBtn.onclick = async () => { try { await onDecide('later'); } catch (_) {} sendNote(); settle('Left in the workshop — reopen this session any time to decide.', false); };
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
      if (res && res.ok) { const done = 'Discarded — this idea won’t be rebuilt or re-proposed.'; decideNote(done, true); sendNote(); settle(done, true); }
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
      const text = document.createElement('span'); text.className = 'turnin-text';
      text.textContent = prop.replaceId ? 'Update remembered preference: “' + prop.previousBody + '” → “' + prop.content + '”' : prop.content;
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(kind); item.appendChild(text);
      // releases#7: a proposal says when the run that raised it FAILED (the sidecar carries the run's outcome). The deck's own
      // evidence line (a full grid row under the belief), never a third pill in the kind/text grid: that crushes the text column
      if (prop.outcome === 'failed') { const f = document.createElement('div'); f.className = 'turnin-evidence'; f.textContent = '↳ ⚠ from a failed run'; item.appendChild(f); }
      item.appendChild(btns);
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
      // the deck path owns a run once memory.proposed claimed it (it renders receipts + deck together). Deliberately
      // NOT added to proposalRunsSeen: a passive receipt is not a review DECK, so it must not suppress the run's
      // curiosity/suggestion nudge (the wireCuriosity guard keys on proposalRunsSeen = "a deck owns the moment").
      if (!runId || (beatCards && beatCards.hasSeen('memory', runId)) || receiptFetching.has(runId)) return;
      receiptFetching.add(runId);
      // NO slot reservation — receipts are passive log lines. A tiny debounce lets a burst of memory.write events
      // + the server-side batch settle into ONE fetch; a save after that fetch schedules the next one, and only
      // the saves not yet shown for the run render (unshownReceipts) — a later save is never swallowed.
      setTimeout(() => { receiptFetching.delete(runId); routeProposalBatch(runId, agentId, false); }, 350);
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
    const saved = unshownReceipts(runId, items.filter(p => p && p.saved));   // only this run's saves not shown yet
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
    // (2026-10-02, Andrew: "remembered should just show up collapsed") — a toggle header; the list opens on click.
    const cap = document.createElement('button'); cap.type = 'button'; cap.className = 'receipt-head';
    cap.setAttribute('aria-expanded', 'false');
    // the count is what is STILL remembered: a forgotten line leaves it (QA 2026-10-02 — "remembered · 3" stood after a forget)
    let forgotten = 0;
    const capText = () => { const kept = batch.proposals.length - forgotten; cap.textContent = 'remembered · ' + kept + (forgotten ? ' (' + forgotten + ' forgotten)' : ''); };
    capText();
    const list = document.createElement('div'); list.className = 'receipt-items'; list.hidden = true;
    cap.onclick = () => { const open = list.hidden; list.hidden = !open; cap.setAttribute('aria-expanded', String(open)); head.d.classList.toggle('open', open); };
    head.body.appendChild(cap);
    head.body.appendChild(list);
    for (const prop of batch.proposals) {
      const item = document.createElement('div'); item.className = 'receipt-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'receipt-text'; text.textContent = prop.content;
      // an UPDATE replaced an existing memory's text (its old text is archived): say so, and offer no ✕ — forgetting
      // would delete the whole memory, not undo the update (Memory Core edits it)
      // a SUPERSESSION names what it retired (memory-truth-1027): the older belief left active recall, so the receipt says which
      if (prop.revised) {
        const was = (Array.isArray(prop.superseded) ? prop.superseded : []).map(s => '“' + String((s && s.previous) || '').replace(/\s+/g, ' ').slice(0, 120) + '”').filter(t => t.length > 2);
        text.textContent = 'updated: ' + prop.content + (was.length ? ' (replaced ' + was.join(', ') + ')' : '');
        item.appendChild(kind); item.appendChild(text); list.appendChild(item); continue;
      }
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
          forgotten += 1; capText();
        } else {
          busy = false; veto.disabled = false;
          if (typeof StationUI !== 'undefined') StationUI.notify('could not forget that ' + (prop.kind === 'skill' ? 'skill' : 'memory') + ' - try again', 'warn');
        }
      };
      item.appendChild(kind); item.appendChild(text); item.appendChild(veto);
      list.appendChild(item);
    }
    autoscroll();
  }

  // R1 MID-TASK FORK — the answer that IS work: render the agent's preference fork as one-tap chips. The
  // pick does double duty — it banks as a Commander-authored STYLE belief (full confidence weight: given in
  // context, about a real decision, immediately acted on; + the R4 receipt proves it stuck) AND continues
  // the conversation as the Commander's next message so the task proceeds with it. "you decide" banks
  // nothing and hands the choice back. One fork per reply by construction (parse reads the first marker).
  function offerFork(fk, runId) {
    clearNudge();   // same law as offerTaskQuestion: the fork claims the moment; a live nudge leaves WITH its chips
    const items = fk.options.map(o => ({ label: o, value: o }));
    items.push({ label: 'you decide', value: '', skip: true });
    const q = row('agent'); q.d.classList.add('nudge');
    q.body.textContent = '⌖ ' + fk.question;
    taskQuestionDoor(q.body, runId);   // the fork's chips replace this run's connect chip in the one slot — the card carries the door
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
    noteAskLanding();   // …and an offer panel over COMMS steps aside, so the question's answer chips are never under it
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
      taskQuestionDoor(r.body, tq.runId);
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
    taskQuestionDoor(q.body, tq.runId);
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
    // the note is CONSEQUENCE, not evidence ("raises ON ITS OWN to FREE") — a dim aside between the
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
    // USER-STUDY LOOP — WHAT THE STATION LEARNED WHILE YOU WERE AWAY. Study also runs after cron, channel and
    // night-shift runs, but this lane only ever asked about the run it had just watched end, so those batches
    // were never offered and aged out of the stash. On open and on return, queue every undecided batch through
    // the SAME consent card (FIFO, deduped by run, one card per moment, the session cap still binds): nothing
    // reaches the dossier without the Commander's Keep.
    setTimeout(lookForAwayStudy, AWAY_STUDY_FIRST_LOOK_MS);
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        lookForAwayStudy();
      });
    } catch (_) {}
  }
  const AWAY_STUDY_FIRST_LOOK_MS = 8000;     // after boot settles (the return digest takes the first beat)
  const AWAY_STUDY_LOOK_GAP_MS = 10 * 60000; // a tab flicker is not a return — at most one look per 10 minutes
  let awayStudyLookAt = 0;
  async function lookForAwayStudy() {
    const t = Date.now();
    if (awayStudyLookAt && t - awayStudyLookAt < AWAY_STUDY_LOOK_GAP_MS) return;
    awayStudyLookAt = t;
    if (typeof Harness === 'undefined' || !Harness.studyPending || !beatCards) return;
    const batches = await Harness.studyPending();
    let queued = 0;
    for (const b of batches) {
      if (!b || !b.runId || beatCards.hasSeen('study', b.runId)) continue;
      queueStudy(b.runId, b.agentId || 'agent'); queued++;
    }
    if (queued) flushStudyPending();
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
    if (askWaiting()) return true;   // the panel would stand over that ask's keys (soak 2026-10-15)
    // the SAME stand-down set the study beat honors (a confirm panel must never render mid-awakening/interview/
    // tutorial-panel or while the next run streams). Reuses studyBlocked for one home for the guard set.
    if (typeof studyBlocked === 'function') return studyBlocked();
    return isBusy() || interview;
  }
  // does an ask wait on the Commander — an approval / question card live in COMMS, a run that ended on a question, or any ask
  // the station holds open (a background worker's approval outlives the run that handed the work off)?
  function askWaiting() {
    if (taskQuestionLive()) return true;
    if (log && log.querySelector && log.querySelector('[data-live-ask]')) return true;
    return !!(typeof Channels !== 'undefined' && Channels.allPending && Channels.allPending().length);
  }
  /* AN ASK OWNS COMMS OVER AN OFFER PANEL (soak 2026-10-15). The goal-path panel opened over COMMS at a run end and stayed: the
     Commander's next message went out from the box it covered, the run asked for a team.dispatch approval, and the card landed
     UNDER the panel — 19 approve clicks hit the panel's line. An offer panel (Dialogue.open({ offer })) now steps aside,
     unanswered, the moment an approval or question reaches the Commander — asked-for or not, since a paused run is waiting on
     them — and when they send a turn of their own (its reply would stream under it). Never a decline: it is offered again. */
  // the arbiter (Dialogue.preempt / OWNER_RULES) decides who yields: an offer always does, the quick tour yields a session pick,
  // the awakening never — COMMS never decides that per call site
  function stepOfferAside(why) {
    if (typeof Dialogue === 'undefined') return false;
    if (Dialogue.preempt) return !!Dialogue.preempt(why);
    return !!(Dialogue.stepAside && Dialogue.stepAside(why));
  }
  function noteAskLanding() { return stepOfferAside('ask'); }
  /* A TASK THE COMMANDER TYPED COMPLETES A PENDING FIRST-TASK HAND-OFF (gh#158), on the composer paths that never reach send()'s
     own check: a group conversation (GroupChat.sendText) and the busy type-ahead queue. Same classifier as send() (the agent's
     last reply as context), and PitchStore.noteCommsTask keeps the first task pending on a station that cannot run it. */
  function typedTaskCompletesHandoff(t, ws) {
    if (!t || typeof PitchStore === 'undefined' || !PitchStore.noteCommsTask || !PitchStore.handoffPending || !PitchStore.handoffPending()) return false;
    const h = (ws && Array.isArray(ws.history)) ? ws.history : [];
    let prior = '';
    for (let i = h.length - 1; i >= 0; i--) { const m = h[i]; if (m && m.role === 'assistant') { prior = typeof m.content === 'string' ? m.content : ''; break; } if (m && m.role === 'user') break; }
    if (!(typeof Classify !== 'undefined' && Classify.isTaskDirective && Classify.isTaskDirective(t, { priorAgentTurn: prior }))) return false;
    try { return !!PitchStore.noteCommsTask(t); } catch (_) { return false; }
  }
  // ANY approval or question raised for the Commander (a run's own, a delegated worker's, a group's, a background one) steps an
  // offer panel aside before its card draws: "defer while an ask waits" (askWaiting keeps it from re-opening meanwhile)
  if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('permission.prompt', noteAskLanding);
  /* A DELIVERY LANDING OWNS COMMS OVER THE ARC (rc review 2026-10-14). deliveryLanding() stands the arc down at offer time, but
     the offer then waits seconds on the decomposition call, and the panel stays up until it is answered: a worker's hand-back
     (deliverTurns) or a saved file that lands in that window was hidden behind it. Every landing bumps deliveryLandSeq; an
     offer in flight stands down when it moved, and an open panel steps aside — unanswered, never a decline, so the arc is
     offered again at a later run end. A panel the Commander opened themselves (PLAN A PATH) stays until they answer it. */
  let deliveryLandSeq = 0, arcYield = null;
  const STEPPED_ASIDE = { steppedAside: true }, NOT_NOW = { notNow: true };
  function noteDeliveryLanding() {
    deliveryLandSeq++;
    if (arcYield) arcYield();
  }
  async function offerArc(runId) {
    let opened = false;
    if (typeof GoalStore === 'undefined' || typeof Dialogue === 'undefined') return;
    if (!GoalStore.willOfferDecomposition || !GoalStore.willOfferDecomposition()) return;
    if (slotCanArc() !== 'free' || arcBlocked()) return;   // the LOWEST priority: a taken/blocked moment just drops (re-offers next run end)
    if (GoalStore.isFiring && GoalStore.isFiring()) return;
    const lifecycle = beatCards, lifecycleGeneration = lifecycle && lifecycle.generation();
    const askedFor = /^manual:/.test(String(runId || '')), landSeq = deliveryLandSeq;
    GoalStore.setFiring && GoalStore.setFiring(true);
    try {
      const res = await GoalStore.proposeDecomposition();   // the aux model call (reason-only) + parse
      if (!lifecycle || beatCards !== lifecycle || lifecycle.generation() !== lifecycleGeneration) return;
      if (!res || !res.belief || !Array.isArray(res.texts) || res.texts.length < 3) return;   // no usable path — stay un-offered so a later belief change retries
      // re-check the moment after the async model round-trip — memory/study may have claimed it meanwhile.
      if (slotCanArc() !== 'free' || arcBlocked()) return;
      if (!askedFor && deliveryLandSeq !== landSeq) return;   // a delivery landed during the call: it owns COMMS now
      clearNudge();                 // claim the one post-run beat, retiring any gentle nudge
      const arcBeat = beatCards && beatCards.claim({
        kind: 'arc', runId: runId,
        handoff: () => turninQueue.length > 0 ? 'memory' : null,
        onGone: () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); }
      });
      if (!arcBeat) return;
      let path = res.texts.slice();
      /* the panel's ways out besides its own keys — `left` resolves the wait it is in: it STEPS ASIDE, unanswered, for an ask
         reaching the Commander or their own turn (Dialogue.stepAside, see noteAskLanding) and — an unasked panel only — for a
         delivery landing (noteDeliveryLanding); Esc answers it NOT NOW, exactly like its key. It is an offer, so it ends above
         the message box (Dialogue armOffer). */
      let leave = null;
      const left = new Promise(r => { leave = r; });
      const unlessLeft = p => Promise.race([p, left]);
      if (!askedFor) arcYield = () => leave(STEPPED_ASIDE);
      try {
        Dialogue.open({ name: (name || 'AGENT'), offer: { notNow: () => leave(NOT_NOW), stepAside: () => leave(STEPPED_ASIDE) } });
        opened = true;
        const heard = await unlessLeft(Dialogue.say('i think i see the path to that goal — here’s how i’d break it down. does this look right?'));
        if (heard === STEPPED_ASIDE) return opened;
        const linesOf = ts => ts.map((t, i) => (i + 1) + '. ' + t).join('\n');
        // Confirm / Not-now + an ✎ EDIT custom path (allowCustom): typing a revised path (steps separated by a
        // newline OR a semicolon) replaces it, then re-applies the pure floor/cap on Confirm. The custom text is
        // user-typed (never model markup); Dialogue renders it via textContent only.
        let choice = heard === NOT_NOW ? NOT_NOW : await unlessLeft(Dialogue.node({
          lines: linesOf(path),
          options: [ { label: 'confirm the path', value: 'confirm' }, { label: 'not now', value: 'other', skip: true } ],
          allowCustom: true, customLabel: 'edit the milestones', customPlaceholder: 'your milestones, separated by ; …'   // Dialogue draws the ✎ itself (it read "✎✎")
        }));
        if (choice === STEPPED_ASIDE) return opened;   // unanswered: no confirm, no decline, no learning signal
        if (choice === NOT_NOW) choice = { value: 'other', label: 'not now', skip: true };   // Esc = the panel's own NOT NOW key
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
        arcYield = null;
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
  /* THE ARC NEVER TAKES OVER COMMS WHILE A DELIVERY LANDS (rc walk 2026-10-14). The goal-arc Dialogue replaces the whole COMMS
     panel; it opened right as a background worker's file landed ("COPY finished: tagline.md is saved…") and hid it. A run end
     carries a delivery when this page did not start the run (a worker's hand-back, a channel or routine run lands its result
     now), when the run delivered a file, or when it handed work to crew and got their results back. The arc stands down for
     that run end WITHOUT spending its once-token, so it is offered again at the next run end that has nothing new to show. */
  function deliveryLanding(runId) {
    const meta = runMeta(runId);
    if (!meta) return true;
    const w = runWork.get(runId);
    return !!(meta.delegated || (w && (w.delivered || 0) > 0));
  }
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
    // the rung by the name the ON ITS OWN dial renders (SMALL JOBS, FREE…), never the stored id ('leash') — call #57
    const rung = (typeof StationUI !== 'undefined' && StationUI.initiativeLabel) ? StationUI.initiativeLabel(offer.to) : String(offer.to || '').toUpperCase();
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
      note: offer.kind === 'grant' ? 'writes stay jailed + reversible' : 'raises ON ITS OWN to ' + rung
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
          settle(offer.kind === 'grant' ? '✓ granted' : '✓ raised to ' + rung.toLowerCase(), false);
          recAccept('trust', '', false);   // recorded only on the VERIFIED apply — never on an attempt
          if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
          if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(offer.kind === 'grant' ? '◈ earned — it may write files on its own now (revoke any time in Settings)' : '◈ ON ITS OWN raised to ' + rung + ' (adjust any time in SETTINGS › AUTONOMY)', 'gold');
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
      note: 'kept threads feed autonomy'
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
          // the digest of the version this card announced: a package changed on disk since then is refused (409), and approved only in the panel, which shows its bytes
          if (item.value === 'allow') { const res = await Harness.agentSkillAllow({ agentId: agentId || 'agent', id: skillId, digest: String(sk.contentDigest || ''), allow: true }); ok = !!(res && res.ok); flash = ok ? '✔ in every briefing from now on' : 'could not approve — open ABILITIES › SKILLS'; }
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
    // A DELIVERY IS LANDING: the confirm panel takes over the whole COMMS panel, so it waits for a moment with nothing new on it.
    if (deliveryLanding(runId)) return null;
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

  /* DELIVERABLE REPLAY (2026-09-16 — customer: "can't send clickable files anymore, it sends a text path").
     The ▤ saved / ▤ made rows were painted LIVE from the `deliverable` event only; renderHistory replayed
     user / assistant / sys turns, so any reload, stream switch or Try Again dropped every clickable file row
     and left the model's prose path as the only trace. Workstreams.recordDeliverable already files every shown
     deliverable ({title, kind, runId, t}) on its stream — replay those in time order, each row landing where
     the live run painted it: before the reply that followed it, leftovers after the last turn. Background
     streams (never on screen when their run produced a file) gain their rows the first time they are opened. */
  function replayableDeliverables(ws) {
    const list = ws && Array.isArray(ws.deliverables) ? ws.deliverables : [];
    return list
      .filter(d => d && String(d.title || '').trim() && (d.kind === 'file' || d.kind === 'image' || d.kind === 'video' || d.kind === 'audio'))
      .slice()
      .sort((a, b) => (+a.t || 0) - (+b.t || 0));
  }
  function replayDeliverableRow(d, agentId) {
    const mk = d.kind === 'file' ? mediaKindOf(d.title) : d.kind;   // the recorded kind IS the rendered kind (see onDeliverable)
    if (mk === 'image') imageDeliverableLine(d.title, agentId);
    else if (mk === 'video' || mk === 'audio') mediaPlayerLine(d.title, agentId, mk);
    else deliverableLine(d.title, agentId);
  }
  function renderHistory(onlyTurns) {
    const h = onlyTurns || (activeWs ? activeWs.history : []);
    let lastReal = null;   // the trailing dialogue turn (for the error-recovery re-offer below)
    renderingHistory = true;   // suppress the per-row entrance animation across this bulk replay (restored below)
    const delivs = onlyTurns ? [] : replayableDeliverables(activeWs);
    const delivAgent = (activeWs && activeWs.agentId) || 'agent';
    let di = 0;
    // every recorded deliverable stamped at/before `ts` lands now (ts == null flushes the rest)
    const flushDeliverablesBefore = (ts) => { while (di < delivs.length && (ts == null || (+delivs[di].t || 0) <= ts)) replayDeliverableRow(delivs[di++], delivAgent); };
    try {
    for (const m of h) {
      if (m && m.truncated) {   // E3: the local history-cap marker — render it as a dim centered SYSTEM line (not a dropped record)
        if ((m.content || '').trim()) trimMarkerLine(m.content);
        continue;
      }
      // TIMESTAMP TRUTH (P0): pass the turn's STORED real time (m.ts), or `false` when a legacy turn carries none —
      // never `true` here (that would re-stamp replayed history with the current clock, the fabrication we're killing).
      const stamp = (m && m.ts != null) ? m.ts : false;
      if (m.role === 'user') {
        const step = m.from ? null : goalStepOf(m.content);   // a goal-loop continuation replays as the station's line, not the Commander's
        if (step != null) goalStepLine(step); else addUser(m.content, m.attachments, stamp, m.from);
        lastReal = m; continue;
      }
      // a SYSTEM STATUS marker (sys — e.g. an autosessions run-outcome framing line) renders as a system-styled
      // line, NOT as agent speech; it never seeds the model (historyWindow drops it) and it stays visible in-thread.
      // a SEND NOW line the station says its run read, filed after a reload lost the reply that showed it (showSentNowRead):
      // the same mid-run Commander row the live stream drew
      if (m && m.sys && m.steerEcho) { steerRow(m.content, stamp); continue; }
      if (m && m.sys) { if ((m.content || '').trim()) sysLine(m.content, !!m.error); continue; }
      if (m.role !== 'assistant') continue;   // only dialogue turns render (a stray system marker never shows as an agent reply)
      if (!(m.content || '').trim()) { if (m.stopped) { lastReal = m; if (m.stopNote) toolLine('⏹ ' + m.stopNote); } continue; }   // zero-token stop: durable recovery truth, never a blank speech row (its reason line survives the reload)
      // rows re-synced from the server transcript still carry their FORK:/TASK_QUESTION: machine lines — they are
      // chip data, never speech (a reload used to print them raw, first-hour walk 2026-09-28)
      const shownText = (typeof Fork !== 'undefined' && Fork.stripMarkers) ? Fork.stripMarkers(m.content) : m.content;
      if (!shownText.trim()) { lastReal = m; continue; }   // a reply that was ONLY a marker has no prose to show
      // a turn produced by a WORK LINE stage carries its own agentId — replay names that agent, not the focused
      // one, or a reload would silently re-attribute two other agents' work to whoever owns the stream now.
      const spoke = (m && m.agentId && typeof App !== 'undefined' && App.agentName) ? App.agentName(m.agentId) : null;
      if (stamp !== false) flushDeliverablesBefore(stamp);   // the files this reply's run produced were shown BEFORE the reply landed
      // a steering note folded mid-run is saved inside the reply as a '[steering] …' line (the token stream carried it):
      // replay it as the same mid-run Commander row the live stream drew, never as a line of the agent's own prose
      const parts = /(^|\n)\[steering\] /.test(shownText) ? shownText.split(/(?:^|\n)\[steering\] ([^\n]*)\n?/) : [shownText];
      const files = turnFileRefs(m);   // one resolver per reply, like the live stream: every paragraph came from the same run
      for (let pi = 0; pi < parts.length; pi++) {
        if (pi % 2 === 1) { steerRow(parts[pi], stamp); continue; }
        if (!parts[pi].trim()) continue;
        const r = row('agent', { stamp: stamp, who: spoke });   // past turns render as plain GROUPED messages; only the LIVE reply is the lit headline
        if (m.error) r.d.classList.add('err');
        renderProse(r.body, parts[pi], { files });   // same linkify path as live tokens, so replayed history matches
      }
      if (m.stopped && m.stopNote) toolLine('⏹ ' + m.stopNote);   // WHY it stopped survives the reload
      lastReal = m;
    }
    flushDeliverablesBefore(null);   // files newer than the last stored turn (or from turns without a stamp)
    } finally { renderingHistory = false; }   // future LIVE rows animate again
    // STRANDED-USER LAW: a reload/switch onto a stream whose LAST turn failed (error:true) must not leave the
    // Commander with a dead thread and no way out — load() wiped the live recovery chips. Re-offer a plain retry
    // (offerRetry's context-aware verdict isn't stored per-turn, so the safe universal recovery is a re-run).
    if (!onlyTurns && lastReal && lastReal.role === 'assistant' && (lastReal.error || lastReal.stopped) && !isBusy()) {
      if (lastReal.stopped) offerTryAgain();
      else offerRetry(null);
    }
  }

  // A delivered/recovered answer updates this conversation in place. Existing disclosures, selection,
  // live channels and the composer remain mounted; a reader above the bottom keeps the same visible row.
  function deliverTurns(ws, turns) {
    if (!log || !isActiveWs(ws) || ws.conversationMode === 'group' || !Array.isArray(turns) || !turns.length) return false;
    const pinned = stick, top = log.scrollTop;
    const viewport = log.getBoundingClientRect();
    const scale = viewport.height / log.offsetHeight || 1;
    const anchor = !pinned && Array.from(log.children).find(n => !n.classList.contains('cmsg-timebreak') && n.getBoundingClientRect().bottom > viewport.top);
    const anchorTop = anchor && anchor.getBoundingClientRect().top;
    if (!pinned) cancelHistoryPin();
    insertingDelivery = true;
    try { for (const turn of turns) {
      const existing = new Set(log.children);
      const before = Number(turn.ts) > 0 && Array.from(log.children).find(n => Number(n.dataset.ts) > Number(turn.ts));
      renderHistory([turn]);
      if (before) for (const n of Array.from(log.children)) if (!existing.has(n)) {
        n.classList.remove('ts-repeat'); log.insertBefore(n, before);
      }
    } } finally { insertingDelivery = false; }
    syncTimeBreaks();
    pruneLog();
    if (!pinned) log.scrollTop = anchor && log.contains(anchor) ? log.scrollTop + (anchor.getBoundingClientRect().top - anchorTop) / scale : top;
    autoscroll();
    noteDeliveryLanding();   // a hand-back just landed in the open conversation: a goal-arc panel steps aside for it
    return true;
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
      const o = streamingAgent(undefined, undefined, liveRunRoots.get(activeWs.id)); if (s.acc) o.append(s.acc);
      if (s.busy) activeLiveRow = o; else o.done();   // a still-running stream keeps its live row so new tokens flow into it
    }
    for (const p of (s.pendings && s.pendings.length ? s.pendings : (s.pending ? [s.pending] : []))) permissionRow(p, activeWs);
  }

  // A streaming turn's PROSE controller. The agent's text streams into an open paragraph row with a blinking
  // caret; when an action happens (tool call/result, deliverable, approval) the caller breaks the current
  // paragraph so the action row lands BELOW it, and the next tokens open a fresh paragraph under the action —
  // so a turn reads top-to-bottom as "said this → did that → said this", classic-harness style.
  // whoName (optional) = the speaker to stamp on every row this controller opens. Passed by a WORK LINE stage so
  // the transcript names the agent that actually produced the text; omitted everywhere else = the focused agent.
  // whoAgentId (optional) = that stage agent's id, so its file links resolve in ITS workspace (turnFileRefs).
  // runRoot (optional) = the project root this reply's run was sent with (null = none, as for every work-line stage);
  // omitted = the session's current root for the session's own reply (a scripted line, or a run this page did not start).
  function streamingAgent(whoName, whoAgentId, runRoot) {
    let seg = null, caret = null, raw = '';   // seg: the currently-open agent row; raw: its accumulated prose (so URLs can be linkified as they complete)
    // one resolver per reply: every paragraph of it came from the same run
    const files = turnFileRefs({ agentId: whoAgentId || undefined,
      projectRoot: runRoot !== undefined ? runRoot : whoAgentId ? undefined : ((activeWs && activeWs.projectRoot) || null) });
    /* PER-FRAME RENDER COALESCING (2026-08-26 lag fix). Once a paragraph contains any markdown
       marker or URL, renderProse re-parses and rebuilds the WHOLE accumulated paragraph — doing
       that on every streamed token is O(n²) per answer and is a real "COMMS gets slower the
       longer it streams" degradation. raw still accumulates per token (state stays truthful);
       the DOM render + autoscroll fire at most once per animation frame. Everything that needs
       the DOM current RIGHT NOW (closeSeg's empty-stub check, error, cleanTaskIntent, a hidden
       tab where rAF never fires) goes through flushProse() synchronously. */
    let renderQueued = false;
    // a still-open paragraph renders its LIVE text (Fork.liveText: no choice marker — complete or still being typed — ever
    // shows raw); a paragraph that is closing renders its final text (complete markers removed, every prose line kept).
    function shownProse(final) {
      if (typeof Fork === 'undefined') return raw;
      return final ? (Fork.stripMarkers ? Fork.stripMarkers(raw) : raw) : (Fork.liveText ? Fork.liveText(raw) : raw);
    }
    let lastShown = null;   // the text the open paragraph last rendered (a close re-renders only when its final text differs)
    // a still-open paragraph redraws only its open end (renderProseLive); the closing render frees that state
    function flushProse(final) { renderQueued = false; if (seg) { lastShown = shownProse(final); renderProse(seg.body, lastShown, { files, live: !final }); } }
    function queueProse() {
      if (renderQueued) return;
      if (typeof requestAnimationFrame !== 'function' || (typeof document !== 'undefined' && document.hidden)) { flushProse(); autoscroll(); return; }
      renderQueued = true;
      requestAnimationFrame(() => { if (!renderQueued || held) return; flushProse(); autoscroll(); });
    }
    /* A POINTER DOWN ON THE LIVE REPLY HOLDS ITS RE-RENDER (QA 2026-10-02). Every frame rebuilt the paragraph, replacing the
       <a> between mousedown and mouseup — the click landed on .body and a link in a still-streaming reply never opened (and a
       text selection inside it was wiped). Held until the click has been dispatched, then the queued text lands at once. */
    let held = false;
    function holdWhilePressed() {
      held = true;
      let safety = null;   // a release outside the window never strands the live reply: the text comes back after 4 s
      const up = () => {
        clearTimeout(safety);
        document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true);
        setTimeout(() => { held = false; if (renderQueued) { flushProse(); autoscroll(); } }, 0);   // after the click event, never before it
      };
      document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', up, true);
      safety = setTimeout(up, 4000);
    }
    function open() {
      endToolRail();   // a fresh prose paragraph opening below a rail closes it, so the next tool call starts a NEW rail under this prose (keeps chronological "said → did → said → did")
      seg = row('agent', { stamp: true, who: whoName || null }); raw = ''; lastShown = null;
      if (seg.body && seg.body.addEventListener) seg.body.addEventListener('pointerdown', holdWhilePressed);
      caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▮';
      seg.d.appendChild(caret);   // caret is a sibling of .body, so re-rendering .body's content never disturbs it
    }
    function closeSeg() {   // drop the caret, discard an empty stub, and arm the next token to start fresh
      if (seg && (renderQueued || shownProse(true) !== lastShown)) flushProse(true);   // pending tokens land — and a line the live render held back shows — before the empty-stub check reads textContent
      if (seg && seg.body) seg.body.__mdLive = null;   // a closed paragraph never redraws: free its live parse
      if (caret) { caret.remove(); caret = null; }
      if (seg && !seg.body.textContent.trim()) seg.d.remove();
      seg = null; raw = '';
    }
    // A folded /steer note echoes back from the sidecar as a '\n[steering] …\n' token delta. It is the
    // Commander's note, not agent prose — render it as the Commander's own mid-run row and CLOSE the paragraph
    // around it, so it never sits in a caret'd row that reads as the agent typing it.
    function steerNote(text) {
      endToolRail();
      steerRow(text, true);
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
      cleanTaskIntent() {   // every choice marker (FORK + TASK_QUESTION) leaves the live row once the chips take over
        if (!seg) return;
        if (typeof Fork !== 'undefined' && Fork.stripMarkers) { raw = Fork.stripMarkers(raw); flushProse(); }
        else if (typeof TaskIntent !== 'undefined' && TaskIntent.strip) { raw = TaskIntent.strip(raw); flushProse(); }
      },
      done() { closeSeg(); },
      // m = the plain-language headline to LEAD with; rawDetail (optional) = the original technical text, kept
      // accessible as a dim sub-line + a title tooltip so debugging info isn't lost, just de-emphasized.
      error(m, rawDetail) {
        if (!seg) open();
        seg.d.classList.add('err');
        raw += (raw ? '\n' : '') + '⚠ ' + m; flushProse(true);
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
  // catch keeps what already streamed instead of logging an error, and take that stream's type-ahead queue off the
  // belt — a deliberate stop means "I'm taking over", not "now run my backlog" — and back into the box (restoreQueued).
  function stopActive(how) {
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
    // how: 'esc' from the composer key; the STOP button passes its click event, voice barge-in passes nothing — all YOU
    stopSource.set(id, how === 'esc' ? 'esc' : 'you');
    restoreQueued(id);
    // GOAL LOOP: a deliberate Stop means "I'm taking over" — pause any active loop so the teardown's judge doesn't
    // fire the next continuation. (The user resumes it explicitly with /goal resume.)
    if (typeof GoalLoop !== 'undefined') { const g = goalOf(activeWs); if (g && GoalLoop.isActive(g)) { GoalLoop.pause(g, 'you stopped the run'); persistGoal(); } }
    // what this run itself is paused on, read before the bulk clear (a background worker's ask outlives the run: not one of them)
    const ownAsks = (typeof Channels !== 'undefined' && Channels.pendingAllOf) ? Channels.pendingAllOf(id).filter(p => p && p.promptId && p.background !== true) : [];
    if (typeof Channels !== 'undefined' && Channels.clearPending) Channels.clearPending(id, Date.now());   // a pending approval is moot once stopped
    status('stopping…'); updateControls();
    if (typeof SFX !== 'undefined') (SFX.close || SFX.press)();   // STOP winds a run down: the docks' close() cue
    // runs only once the stop is CONFIRMED (or there was no run id to kill): the run's open approval cards go dead with it,
    // and every other surface holding one of its asks (the bell, CREW, the floor) is told it is over
    const localAbort = () => { retireOpenConsents(id, (typeof Channels !== 'undefined' && Channels.runIdOf(id)) || ''); settleStoppedAsks(ownAsks); if (rid) restoreSentNow(id, rid); const ac = aborters.get(id); if (ac) { try { ac.abort(); } catch (_) {} } };   // aborts the fetch → reader throws → send()'s catch
    const rid = (typeof Channels !== 'undefined') ? Channels.runIdOf(id) : null;
    // STOP MEANS STOP (2026-09-04): the local fetch is torn down only AFTER the sidecar confirmed the kill. A
    // swallowed /api/cancel failure used to render a clean "RUN STOPPED" while the run kept burning server-side;
    // now a refused/unreachable cancel keeps this stream live and un-stopped and SAYS so (stopFailed). No run id
    // yet (the run.start beat has not landed) = nothing to kill server-side, so the local abort stands alone.
    if (rid && typeof Harness !== 'undefined' && Harness.cancel) {
      Promise.resolve(Harness.cancel(rid)).then(v => { if (v && v.ok) localAbort(); else stopFailed(id, v); }, e => stopFailed(id, { ok: false, error: (e && e.message) || String(e), transport: true }));
    } else { if (!rid) stopReportHolding(id); localAbort(); }
  }
  /* A SEND STILL WAITING FOR ITS TURN IS NEVER LEFT ON "CONNECTING" (stall report 2026-10-13). A message with no run id yet
     waits in the station behind whatever holds this conversation, and the one holder this page never started is the
     overseer's automatic report on delegated work (it takes the same per-conversation turn). STOP never reached that
     report, so every new message sat on "connecting" until it finished. STOP on such a send now also stops it, by the run
     id the station lists for it (read fresh, never from a stale poll), and says so only when the station answers that a
     live report was there to stop (stopped:true): a report that finished in between, or a row left from a restart, says nothing. */
  function stopReportHolding(id) {
    if (typeof Harness === 'undefined' || !Harness.cancel || !Harness.api || !Harness.api.get) return;
    Promise.resolve(Harness.api.get('/api/overseer')).then(j => {
      const holding = ((j && j.reviews) || []).filter(r => r && r.status === 'reviewing' && r.parentStreamId === id && r.reviewRunId);
      return Promise.all(holding.map(r => Harness.cancel(r.reviewRunId)));   // Harness.cancel answers { ok, stopped? }, never throws
    }).then(answers => {
      // said only for a stop the STATION proves: /api/cancel answers 200 even for a report that already finished
      if ((answers || []).some(v => v && v.ok && v.stopped === true) && activeWs && activeWs.id === id) localLine('STOP also ended the report on your delegated work that was holding this conversation.');
    }, e => console.warn('[stop] could not read the station\'s reports to stop:', (e && e.message) || e));   // this send is stopped either way
  }
  /* QUEUED WORDS ARE NEVER LOST ON STOP (live walk 2026-10-14): a message typed while the run worked became a queued pill,
     and STOP deleted it — not sent, not in the box, no notice. The stop still takes the backlog off the belt (nothing
     auto-sends behind your back), but the words go back into the message box, ahead of whatever is typed there, unsent,
     and one line says so — the same "give the typed text back" a refused /skill command does. */
  function restoreQueued(id) {
    const arr = queued.get(id) || [];
    queued.delete(id);
    renderQueued();
    if (!arr.length || !input) return;
    const typed = String(input.value || '').trim();
    input.value = arr.concat(typed ? [typed] : []).join('\n');
    autoGrowInput();
    localLine(arr.length === 1 ? 'Your queued message was not sent — it is back in the message box.'
      : 'Your ' + arr.length + ' queued messages were not sent — they are back in the message box.');
  }
  /* A STOPPED RUN'S ASKS LEAVE EVERY SURFACE (live walk 2026-10-14). The station denies a killed run's open prompts, but the
     page drops the stream right after the kill is confirmed, so that permission.response never arrived: the bell kept
     "NEEDS YOU — 2 waiting" while the rail said 1, CREW kept its gold "needs your OK" and the floor kept AWAITING APPROVAL
     over an idle agent, until a reload. Once the stop is CONFIRMED each of the run's own asks is announced settled in the
     station's own words for a stopped wait — decision 'deny', stopped:true: nothing was approved. */
  function settleStoppedAsks(asks) {
    if (typeof U === 'undefined' || !U.bus) return;
    for (const p of asks) U.bus.emit('permission.response', { promptId: p.promptId, decision: 'deny', stopped: true });
  }

  // The sidecar did NOT confirm the stop: un-flag the stream (never mark it stopped on a claim the harness can't
  // back), leave the run streaming, and print the friendly transport verdict measured the same way send()'s catch
  // does (Harness.pingEngine → Friendly.friendlyError), so a dead service reads LINK DOWN and a refused stop names
  // its status. STOP stays available — the Commander can press it again.
  function stopFailed(id, v) {
    interrupted.delete(id);
    stopSource.delete(id);
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
    if (typeof SFX !== 'undefined' && SFX.press) SFX.press();
  }
  function sendOrQueue(text) {
    const value = String(text == null ? '' : text).trim();
    if (!value || !activeWs) return { ok: false, state: 'empty' };
    if (activeWs.conversationMode === 'group' && typeof GroupChat !== 'undefined') {
      send(value);
      return { ok: true, state: 'started', workstreamId: activeWs.id };
    }
    if (isBusy() && pendingAskFor(activeWs)) {
      const ws = activeWs;
      answerPendingAsk(ws, value).then(ok => { if (!ok) enqueue(value); });
      return { ok: true, state: 'answered', workstreamId: ws.id };
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
    /* THE QUEUE NEVER HIDES THE LIVE LINE (live walk 2026-10-14): the strip sits between the log and the message box, so a
       new pill shrinks the log from its bottom — and with an approval card held (no follow) the presence line under it was
       cut in half. A log showing its end keeps showing it: it moves up by what the strip grew (never past a held card's top). */
    const atEnd = !!log && nearBottom(), h0 = strip.offsetHeight;
    const arr = (activeWs && queued.get(activeWs.id)) || [];
    strip.innerHTML = '';
    arr.forEach((t, i) => {
      const pill = document.createElement('span'); pill.className = 'queued-pill';
      // the pill clips the text (.queued-text max-width), so its tip carries the whole message — then what the pill DOES: it
      // sends after this run, or its send now key hands it to the run working now. The tip card keeps 400 chars (tooltip.js
      // MAX_LEN): the message gives way, the hint never does. (Same shape as the org pass P27 tip, naming SEND NOW.)
      const QHINT = 'sends after this run · send now hands it to the running task', room = 400 - QHINT.length - 5;
      pill.setAttribute('data-tip', '“' + (t.length > room ? t.slice(0, room - 1) + '…' : t) + '” · ' + QHINT);
      const label = document.createElement('span'); label.className = 'queued-text'; label.textContent = t;
      const x = document.createElement('button'); x.className = 'queued-x'; x.type = 'button'; x.textContent = '✕';
      x.setAttribute('aria-label', 'Cancel queued message');
      x.onclick = () => { const a = queued.get(activeWs.id) || []; a.splice(i, 1); a.length ? queued.set(activeWs.id, a) : queued.delete(activeWs.id); renderQueued(); };
      const now = document.createElement('button'); now.className = 'queued-now'; now.type = 'button'; now.textContent = 'send now';
      now.setAttribute('data-tip', 'Hand this to the run that is working now: the agent reads it before its next step, instead of after the run finishes');
      now.onclick = () => sendQueuedNow(activeWs.id, i, t);
      const tag = document.createElement('span'); tag.className = 'queued-tag'; tag.textContent = 'next';
      pill.appendChild(tag); pill.appendChild(label); pill.appendChild(now); pill.appendChild(x);
      strip.appendChild(pill);
    });
    /* SENT, NOT READ YET (Andrew 10-26: a SYSTEM line announced every send-now, then the note showed up under the agent's
       name). A line the run holds stays in the strip, keyless, until the run's echo shows the agent read it; the transcript
       then shows it as the Commander's own MID-RUN message. A 200 proves only that the run holds it, so that is all it says. */
    const held = (typeof sentNow !== 'undefined' && activeWs && sentNow.get(activeWs.id)) || [];
    for (const n of held) {
      if (!n.accepted || n.landed) continue;
      const pill = document.createElement('span'); pill.className = 'queued-pill sent';
      pill.setAttribute('data-tip', 'Sent into the live run — the agent reads it before its next step');
      const tag = document.createElement('span'); tag.className = 'queued-tag'; tag.textContent = 'sent';
      const label = document.createElement('span'); label.className = 'queued-text'; label.textContent = n.text;
      const when = document.createElement('span'); when.className = 'queued-when'; when.textContent = 'read at its next step';
      pill.appendChild(tag); pill.appendChild(label); pill.appendChild(when);
      strip.appendChild(pill);
    }
    const grew = strip.offsetHeight - h0;
    if (atEnd && grew > 0) log.scrollTop += (heldCard && log.contains(heldCard)) ? Math.min(grew, Math.max(0, topInLog(heldCard) - 8)) : grew;
  }
  /* SEND NOW — a queued follow-up STEERS the live run instead of waiting for it to end (Andrew 2026-10-14). The
     pill leaves the queue while the POST is in flight (so flushQueued can't also send it as a new turn); it goes
     back to the FRONT of the queue on any refusal — run not confirmed yet (no runId), the loop already closed its
     buffer (409), buffer full (429), network — and the line says why. A 200 only means the sidecar holds it: the
     transcript's own '[steering] …' row is the proof it landed, so the strip shows it SENT ("read at its next step") and
     nothing more — no SYSTEM line (Andrew 10-26: the success line cluttered the chat above a note it then repeated).
     STOP OUTRANKS IT (0.13.5 merge): the line stays in sentNow until its run ends; a STOP the station confirms gives back
     every one the transcript never showed landing (restoreSentNow), and an answer arriving after that changes nothing —
     no "sent" line, and never a re-queue that would auto-send it behind the stop.
     ONE LINE ON THE WIRE (0.13.5 review): the loop echoes a note as '\n[steering] <note>\n', and every reader of that echo
     (the live row, renderHistory, both history merges, markSentNowLanded) reads ONE line — a second line rendered as the
     agent's own prose and doubled the reply on reload. The run gets the note on one line (steerWire); a STOP gives back
     what was typed. A pill past the sidecar's 2,000-char note clamp is never posted: the buffer would cut it and still
     say ok. Every line it prints goes to ITS session's log only — an answer can land after you switched away. */
  function sendQueuedNow(id, i, text) {
    let note = null;   // this line's sentNow entry, once it is handed to the run
    const say = t => { if (activeWs && activeWs.id === id) localLine(t); };
    const requeue = () => { const q = queued.get(id) || []; q.unshift(text); queued.set(id, q); renderQueued(); };
    const back = (why) => {
      if (note && !forgetSentNow(id, note)) return;   // STOP already gave it back to the message box
      requeue();
      say(why + ' — it stays queued as your next message.');
      flushQueued(id);   // the run may have ended while we asked → the queue drains now
    };
    const a = queued.get(id) || [];
    const at = a[i] === text ? i : a.indexOf(text);
    if (at < 0) return;   // already sent / cancelled
    a.splice(at, 1); a.length ? queued.set(id, a) : queued.delete(id); renderQueued();
    const wire = steerWire(text);
    if (wire.length > 2000) return back('It is longer than a steering note can carry (2,000 characters)');   // sidecar/steer-buffer.js maxNoteChars
    const rid = (typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(id) : null;
    if (!rid && typeof Channels !== 'undefined' && Channels.isBusy && !Channels.isBusy(id)) {
      // the run just ended: its teardown's deferred flush (which waits for crew joining first) sends the queue — not this click
      requeue();
      return say('The run just finished — it goes as your next message.');
    }
    if (!rid || typeof fetch === 'undefined') return back('The run has not started yet, so there is nothing to steer');
    note = { id: 'sn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10), text: text, wire: wire, runId: rid, accepted: false, landed: false };
    sentNow.set(id, (sentNow.get(id) || []).concat([note]));
    keepSentNow(id, note);   // on disk from the moment it is posted: a reload mid-POST still finds it (the station knows it by noteId)
    fetch('/api/run/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: rid, text: wire, noteId: note.id }) })
      .then(r => r.json().catch(() => null).then(j => ({ status: r.status, j: j })))
      .then(({ status, j }) => {
        if (j && j.ok) {
          if (!(sentNow.get(id) || []).includes(note)) return;   // a STOP already gave it back to the message box
          note.accepted = true;
          if (Channels.runIdOf(id) === rid) return renderQueued();   // the strip shows it SENT until the run reads it — no SYSTEM line
          // its run ended while we asked: read = settled; never read = it goes as the next message (the loop said NOT applied)
          forgetSentNow(id, note);
          if (note.landed) return;
          requeue();
          say('The run ended before the agent read your send-now message — it goes as your next message.');
          flushQueued(id);
          return;
        }
        back(status === 409 || status === 404 ? 'The run had already finished its work' : status === 429 ? 'The run is holding too many notes already' : 'The station did not take it');
      })
      .catch(() => back('The station did not answer'));
  }
  // take one sent-now line off its stream's list; false = it was no longer there (a STOP gave it back already, or the page let
  // go of it — then its disk copy is the station's to decide). true = this page decides it now (a queued pill again, or read).
  function forgetSentNow(id, note) {
    const list = sentNow.get(id) || [], k = list.indexOf(note);
    if (k < 0) return false;
    list.splice(k, 1); list.length ? sentNow.set(id, list) : sentNow.delete(id);
    dropSentNow(id, [note.id]);
    return true;
  }
  /* A SEND-NOW LINE OUTLIVES THE PAGE (live walk on the 0.13.5 candidate, 2026-10-14). sentNow is page memory: a line the
     station accepted while the lead was inside a ~35 s hand-off was gone after a page reload (which also cancels the run) —
     not in the message box, not in the history. So every line handed to a run is ALSO kept in this browser (localStorage,
     per conversation) from the moment it is posted until the page settles it: read, given back into the message box, or
     a queued pill again. Whatever is still there after the page lost its memory — a reload, a closed window, a crash,
     DISCONNECT and re-entry, a stream that died — is decided by the STATION on that conversation's next load
     (reconcileSentNow → GET /api/run/steer, which knows which noteIds the run read), never guessed. Storage that throws
     (a private window, blocked or cleared site data) leaves SEND NOW exactly as it was: memory only. */
  function sentNowDisk(edit) {
    let all = {};
    try { const raw = typeof localStorage !== 'undefined' && localStorage ? localStorage.getItem('starnet.sentNow.v1') : null; all = raw ? JSON.parse(raw) : {}; } catch (_) { all = {}; }
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    if (!edit) return all;
    edit(all);
    for (const k of Object.keys(all)) if (!Array.isArray(all[k]) || !all[k].length) delete all[k];
    try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem('starnet.sentNow.v1', JSON.stringify(all)); } catch (_) { /* memory still holds it: SEND NOW works as it did before */ }
    return all;
  }
  function keepSentNow(id, note) {
    sentNowDisk(all => {
      const list = (Array.isArray(all[id]) ? all[id] : []).filter(e => e && e.id !== note.id);
      list.push({ id: note.id, runId: note.runId, text: note.text, wire: note.wire, at: Date.now() });
      all[id] = list;   // never trimmed here: a line past the cap goes back in the message box (sentNowOverdue)
    });
    sentNowOverdue(id);
  }
  /* A BOUNDED DISK, NOTHING DROPPED UNSEEN (SEND NOW review, 2026-10-15). A conversation keeps at most 16 undecided lines on
     disk. Past that, the oldest ones this page is not holding itself (a live run's own lines are never pushed out) go back
     in the message box — and so does a line the station still cannot decide a day after it was sent (`stale`, from
     askSentNow) — with a line that says only what is known: no answer came. A line is never deleted unseen. */
  function sentNowOverdue(id, stale) {
    const held = new Set();
    for (const n of sentNow.get(id) || []) held.add(n.id);
    for (const h of heldBack.get(id) || []) for (const k of h.ids || []) held.add(k);
    const disk = (sentNowDisk()[id] || []).filter(e => e && e.id);
    const loose = disk.filter(e => !held.has(e.id));   // oldest first: the disk keeps send order
    const out = new Set((stale || []).map(e => e && e.id).filter(k => loose.some(e => e.id === k)));
    let over = disk.length - out.size - 16;            // still past the cap once the stale ones leave
    for (const e of loose) { if (over <= 0) break; if (!out.has(e.id)) { out.add(e.id); over--; } }
    const back = loose.filter(e => out.has(e.id));
    if (!back.length) return;
    const texts = back.map(e => (typeof e.text === 'string' ? e.text : '')).filter(t => t.trim()), n = texts.length;
    if (!n) return dropSentNow(id, back.map(e => e.id));   // no words to give back (a damaged entry): nothing a person typed is lost
    giveBack(id, texts, n === 1 ? 'The station never said whether the agent read your send-now message — it is back in the message box.'
      : 'The station never said whether the agent read ' + n + ' of your send-now messages — they are back in the message box.', back.map(e => e.id));
  }
  function dropSentNow(id, ids) {
    const gone = new Set((ids || []).filter(Boolean));
    if (!gone.size) return;
    sentNowDisk(all => { if (Array.isArray(all[id])) all[id] = all[id].filter(e => e && !gone.has(e.id)); });
  }
  /* the page lets go of lines WITHOUT settling them: the run's stream died (network) or the page is tearing down (DISCONNECT
     → re-entry wipes the queue). It cannot know what the run read — and a re-queue would auto-send behind the reconnect, or
     be wiped by it — so the station decides each one (reconcileSentNow). A line whose echo this page saw IS read: off the
     disk now. runId omitted = every run's lines on that stream. */
  function releaseSentNow(id, runId, acc) {
    const list = sentNow.get(id) || [], ran = String(acc || '');
    const mine = list.filter(n => runId == null || n.runId === runId), rest = list.filter(n => mine.indexOf(n) < 0);
    rest.length ? sentNow.set(id, rest) : sentNow.delete(id);
    if (mine.length && activeWs && activeWs.id === id) renderQueued();   // the page let go of them: no SENT pill stays behind
    dropSentNow(id, mine.filter(n => n.landed || ran.indexOf('[steering] ' + n.wire + '\n') >= 0).map(n => n.id));
  }
  // the note as the run gets it: one line (the loop echoes it as '\n[steering] <note>\n' and the page reads one line back)
  function steerWire(text) { return String(text == null ? '' : text).replace(/\s*\r?\n\s*/g, ' ').trim(); }
  // every steering line a token delta carries ('\n[steering] <note>\n' → '<note>')
  function steerEchoesOf(delta) {
    const out = [], re = /(?:^|\n)\[steering\] ([^\n]*)/g;
    let m;
    while ((m = re.exec(String(delta || '')))) if (m[1].trim()) out.push(m[1]);
    return out;
  }
  /* A NOTE THE RUN READ STAYS IN THE CONVERSATION (Andrew 10-26: the MID-RUN line was gone after a reload). Its echo rides
     the token stream, but the page saves only the reply's last stretch (every tool call starts it over) and the station's
     transcript never records the note (the loop hands it to the model as a system line). So when the run ends, each note it
     streamed is filed as ONE station row — the shape showSentNowRead files after a reload, which never seeds the model —
     unless the saved reply already shows it. placeSteerNotes puts it back after the turn it followed, by time. */
  function fileRunSteers(ws, notes, runId, savedText) {
    if (!ws || !runId || !Array.isArray(notes) || !notes.length) return 0;
    const h = Array.isArray(ws.history) ? ws.history : (ws.history = []);
    const shown = '\n' + String(savedText || '') + '\n';
    let added = 0;
    for (const n of notes) {
      const echo = '[steering] ' + n.text;
      if (shown.indexOf('\n' + echo + '\n') >= 0) continue;   // the saved reply shows it: renderHistory draws it from there
      if (h.some(m => m && m.steerEcho && String(m.sourceRunId || '') === String(runId) && String(m.content || '') === echo)) continue;
      h.push({ role: 'system', sys: true, steerEcho: true, content: echo, sourceRunId: runId, ts: n.ts });
      added++;
    }
    return added;
  }
  /* A NOTE SITS WHERE THE AGENT READ IT. A filed note lands at its run's end, ahead of the turns the station's transcript
     adds when the conversation is read back, so the merge leaves it after the agent's reply to it. Each note moves to just
     after the last row of its own run stamped no later than the note (the run's middle turns carry the station's time of
     writing, the note the time it was read). A run with no stamped row before it leaves it where it is. Pure. */
  function placeSteerNotes(rows) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const tsOf = r => Number(r && r.ts) || 0;
    for (const note of list.filter(r => r && r.steerEcho && r.sourceRunId && tsOf(r) > 0)) {
      const from = list.indexOf(note);
      list.splice(from, 1);
      let at = -1;
      for (let j = 0; j < list.length; j++) {
        const r = list[j];
        if (r && String(r.sourceRunId || '') === String(note.sourceRunId) && tsOf(r) > 0 && tsOf(r) <= tsOf(note)) at = j;
      }
      list.splice(at >= 0 ? at + 1 : from, 0, note);
    }
    return list;
  }
  // that echo on this stream's own run is the proof the agent has it — a STOP no longer gives it back
  function markSentNowLanded(id, runId, delta) {
    const list = sentNow.get(id); if (!list || !list.length) return;
    const re = /(?:^|\n)\[steering\] ([^\n]*)/g; let m, read = false;
    while ((m = re.exec(String(delta || '')))) {
      const n = list.find(x => !x.landed && x.runId === runId && x.wire === m[1]);
      if (n) { n.landed = true; read = true; }
    }
    if (read && activeWs && activeWs.id === id) renderQueued();   // its SENT pill leaves: the transcript shows it now
  }
  /* A SENT-NOW LINE IS NEVER LOST ON STOP EITHER. The station took it (200) but the run was stopped before its next step
     folded it in: the note died with the run. Once the stop is CONFIRMED, every sent-now line of that run whose
     '[steering]' echo never showed goes back into the message box — ahead of what is there, unsent — with one line. */
  function restoreSentNow(id, runId) {
    const list = sentNow.get(id) || [];
    const acc = (typeof Channels !== 'undefined' && Channels.peek && Channels.peek(id)) ? String(Channels.peek(id).acc || '') : '';
    const mine = list.filter(n => n.runId === runId);
    const lost = mine.filter(n => !n.landed && acc.indexOf('[steering] ' + n.wire + '\n') < 0);
    const rest = list.filter(n => n.runId !== runId);
    rest.length ? sentNow.set(id, rest) : sentNow.delete(id);
    if (activeWs && activeWs.id === id) renderQueued();   // its SENT pills leave the strip with the run
    dropSentNow(id, mine.filter(n => lost.indexOf(n) < 0).map(n => n.id));   // read: settled with the stopped turn
    if (!lost.length) return;
    giveBack(id, lost.map(n => n.text), lost.length === 1 ? 'The run stopped before the agent read your send-now message — it is back in the message box.'
      : 'The run stopped before the agent read ' + lost.length + ' of your send-now messages — they are back in the message box.', lost.map(n => n.id));
  }
  // words a stop gives back go into THEIR session's message box: now if it is on screen, else when you return (returnHeld).
  // Never into the queue — a return would auto-send them behind the stop. ids = their sent-now lines: on disk until they
  // land in the box (an unsent draft from there on), so a reload before you return still gives them back — once.
  function giveBack(id, texts, line, ids) {
    if (!(activeWs && activeWs.id === id)) { heldBack.set(id, (heldBack.get(id) || []).concat([{ texts: texts, line: line, ids: ids || [] }])); return; }
    if (!input) return;
    const typed = String(input.value || '').trim();
    input.value = texts.concat(typed ? [typed] : []).join('\n');
    autoGrowInput();
    localLine(line);
    dropSentNow(id, ids);
  }
  function returnHeld(id) {
    const held = heldBack.get(id); if (!held || !held.length) return;
    heldBack.delete(id);
    for (const h of held.slice().reverse()) giveBack(id, h.texts, h.line, h.ids);   // oldest ends up first in the box
  }
  /* the run is over: a sent-now line it showed landing is settled; one the station took that the run never read (a run
     error, a budget or loop-guard stop, a phone STOP, the gap after the loop's last drain — its own line says "NOT applied,
     send it as a new message") goes back to the FRONT of the queue and the teardown's deferred flush sends it, as a refusal
     would. One still in flight stays until its answer. (A desktop STOP the station confirmed already settled its run.) */
  function settleSentNow(id, runId, acc) {
    const list = sentNow.get(id) || [], ran = String(acc || '');
    const unread = list.filter(n => n.runId === runId && n.accepted && !n.landed && ran.indexOf('[steering] ' + n.wire + '\n') < 0);
    const rest = list.filter(n => n.runId !== runId || !n.accepted);
    rest.length ? sentNow.set(id, rest) : sentNow.delete(id);
    dropSentNow(id, list.filter(n => rest.indexOf(n) < 0).map(n => n.id));   // settled here: read, or a queued pill again
    if (activeWs && activeWs.id === id) renderQueued();   // a SENT pill of the ended run never outlives it
    if (!unread.length) return;
    queued.set(id, unread.map(n => n.text).concat(queued.get(id) || []));
    renderQueued();
    if (activeWs && activeWs.id === id) localLine(unread.length === 1 ? 'The run ended before the agent read your send-now message — it goes as your next message.'
      : 'The run ended before the agent read ' + unread.length + ' of your send-now messages — they go as your next messages.');
  }
  /* THE STATION DECIDES WHAT THE PAGE COULD NOT (live walk 2026-10-14). On a conversation's load (once its history merged)
     and when a run whose stream died ends, every line still on disk that this page is not holding itself is asked about:
       · read (the run folded it in)            → shown as read: one steer-echo row after that run's dialogue (showSentNowRead),
                                                   unless the saved history already shows its echo
       · never read (the run ended first, or the station never took it) → back in THIS conversation's message box, ahead of
                                                   what is typed, unsent, with one line
       · no record (a restart lost the run and no run record was written) → read only if this run's saved reply shows its
                                                   echo; else back in the box with a line that says the station cannot tell
       · the run is still going / no answer      → asked again later (bounded); never dropped, never guessed.
     Never auto-sent. Each line is decided once: the disk is re-read after the answer (this page's own flow or another page
     may have settled one meanwhile) and a line leaves the disk as it lands. */
  function reconcileSentNow(ws, attempt) {
    const id = ws && ws.id;
    if (!id || typeof fetch === 'undefined') return Promise.resolve();
    if (sentNowChecks.has(id)) return sentNowChecks.get(id);
    const p = askSentNow(ws, attempt || 0).catch(() => {}).then(() => { sentNowChecks.delete(id); });
    sentNowChecks.set(id, p);
    return p;
  }
  async function askSentNow(ws, attempt) {
    const id = ws.id;
    const pick = () => {
      const own = new Set();
      for (const n of sentNow.get(id) || []) own.add(n.id);
      for (const h of heldBack.get(id) || []) for (const k of h.ids || []) own.add(k);
      const liveRun = (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(id) && Channels.runIdOf) ? Channels.runIdOf(id) : null;
      return (sentNowDisk()[id] || []).filter(e => e && e.id && e.runId && !own.has(e.id) && e.runId !== liveRun);
    };
    const lines = pick();
    if (!lines.length) return;
    const answers = new Map();
    for (const rid of new Set(lines.map(e => e.runId))) {
      let st = null;
      try {
        const r = await fetch('/api/run/steer?runId=' + encodeURIComponent(rid), { cache: 'no-store' });
        st = r && r.ok ? await r.json() : null;
      } catch (_) { st = null; }   // no answer is not an answer: the line waits
      answers.set(rid, st);
    }
    const cur = (typeof Workstreams !== 'undefined' && Workstreams.get && Workstreams.get(id)) || ws;
    const still = new Set(pick().map(e => e.id));
    const by = { read: [], back: [], unsure: [], wait: [] };
    for (const e of lines) if (still.has(e.id)) by[sentNowVerdict(e, answers.get(e.runId), cur.history)].push(e);
    if (by.read.length) { dropSentNow(id, by.read.map(e => e.id)); showSentNowRead(cur, by.read); }
    const n = by.back.length, u = by.unsure.length;
    if (n) giveBack(id, by.back.map(e => e.text), n === 1 ? 'The run ended before the agent read your send-now message — it is back in the message box.'
      : 'The run ended before the agent read ' + n + ' of your send-now messages — they are back in the message box.', by.back.map(e => e.id));
    if (u) giveBack(id, by.unsure.map(e => e.text), u === 1 ? 'The station has no record that the agent read your send-now message before its run ended — it is back in the message box.'
      : 'The station has no record that the agent read ' + u + ' of your send-now messages before their run ended — they are back in the message box.', by.unsure.map(e => e.id));
    // a line the station still cannot decide a day after it was sent stops waiting: back in the box, saying no answer came
    const stale = by.wait.filter(e => Date.now() - Number(e.at) > 24 * 3600 * 1000);
    if (stale.length) sentNowOverdue(id, stale);
    // ONE retry chain per line (SEND NOW review, 2026-10-15): a load or a run's end that finds a line still waiting while its
    // retry is already armed arms no second one — only the in-flight ask was de-duped before, so every ask added a chain
    const unarmed = by.wait.filter(e => stale.indexOf(e) < 0 && !sentNowRetry.has(e.id));
    if (unarmed.length && attempt < 40) {
      const armed = {};
      for (const e of unarmed) sentNowRetry.set(e.id, armed);
      setTimeout(() => {
        for (const e of unarmed) if (sentNowRetry.get(e.id) === armed) sentNowRetry.delete(e.id);
        return reconcileSentNow((typeof Workstreams !== 'undefined' && Workstreams.get && Workstreams.get(id)) || ws, attempt + 1);
      }, Math.min(15000, Math.round(1500 * Math.pow(1.4, attempt))));
    }
  }
  // one line's fate from the station's answer (GET /api/run/steer → { live, ended, source, notes: { noteId: state } })
  function sentNowVerdict(e, st, history) {
    if (!st || typeof st !== 'object' || !st.notes || typeof st.notes !== 'object') return 'wait';
    const s = st.notes[e.id];
    if (s === 'applied') return 'read';
    if (s === 'unapplied') return 'back';
    if (st.source === 'none') return st.live ? 'wait' : (shownSteer(history, e, true) ? 'read' : 'unsure');
    // still pending, or a line the station never took (refused, or its POST never arrived): decided once the run can no
    // longer read it — an aborted loop never drains again, so a run that is not in flight reads nothing more
    return (st.ended || !st.live) ? 'back' : 'wait';
  }
  // does the saved history show this line's echo? strict = only a row of ITS run proves it (an older run may have read the
  // same words); loose (dedupe before filing a row) also counts a row saved without its run id (a stopped partial) — but
  // never a row of ANOTHER run, a filed echo row included: the same words read by an earlier run are not this line's proof
  function shownSteer(history, e, strict) {
    const echo = '[steering] ' + e.wire;
    const ofRun = m => (strict ? m.sourceRunId === e.runId : (!m.sourceRunId || m.sourceRunId === e.runId));
    return (Array.isArray(history) ? history : []).some(m => m && ofRun(m) && (
      (m.steerEcho && String(m.content || '') === echo)
      || (m.role === 'assistant' && !m.sys && ('\n' + String(m.content || '') + '\n').indexOf('\n' + echo + '\n') >= 0)));
  }
  // a line the run read, filed as ONE station row after that run's dialogue (before the station's own lines about it);
  // renderHistory draws it as the live stream's steer-echo row. The station-row shape every other station row uses (role
  // 'system' + sys): it never seeds the model (historyWindow drops sys rows), and nothing that reads the agent's last turn
  // (copy last reply, the next send's prior-turn hint, /history, the starter suggestions) takes the Commander's note for the agent's words.
  function showSentNowRead(ws, read) {
    if (!ws) return;
    const h = Array.isArray(ws.history) ? ws.history : (ws.history = []);
    let added = 0;
    for (const e of read) {
      if (shownSteer(h, e, false)) continue;   // the saved reply already shows it: never twice
      let at = -1;
      for (let i = h.length - 1; i >= 0 && at < 0; i--) if (h[i] && !h[i].sys && String(h[i].sourceRunId || '') === e.runId) at = i + 1;
      if (at < 0) { at = h.findIndex(m => m && m.sys && String(m.sourceRunId || '') === e.runId); if (at < 0) at = h.length; }
      // after the lines of the same run filed before it: several read lines keep the order they were sent in
      while (at < h.length && h[at] && h[at].steerEcho && String(h[at].sourceRunId || '') === e.runId) at++;
      h.splice(at, 0, { role: 'system', sys: true, steerEcho: true, content: '[steering] ' + e.wire, sourceRunId: e.runId, ts: Number(e.at) || Date.now() });
      added++;
    }
    if (!added) return;
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) { /* the row is in memory; the next save writes it */ }
    if (log && activeWs && activeWs.id === ws.id && !(typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(ws.id))) {
      log.innerHTML = ''; renderHistory(); replayChannel(); syncStatus();
    }
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
    ws.history.push({ role: 'assistant', content: text, stopped: true, ts: Date.now(), projectRoot: liveRunRoots.get(ws.id) });   // the in-flight run's root (persistPartial)
  }
  // WHY it stopped, kept on the stopped turn itself (2026-10-11): the ⏹ work-log line was DOM-only, so after a reload the
  // thread showed a cut-off reply with no reason. renderHistory replays it as the same ⏹ line. Metadata only — the
  // model's wire carries role/content, never this field.
  function stoppedByLine(by) { return by === 'esc' ? 'stopped by you (Esc)' : by ? 'stopped by you' : ''; }
  // The run id settles the STREAM's outcome too: a stopped run is neither FINISHED nor FAILED (task-board truth — with
  // nothing recorded the board read it as done). A deliberate Stop is 'stopped'; an in-band stop keeps its own reason.
  function noteStopReason(ws, note, runId, reason) {
    if (runId && ws && typeof Workstreams !== 'undefined' && Workstreams.noteRunEnd) Workstreams.noteRunEnd(ws.id, runId, null, reason && reason !== 'cancelled' ? reason : 'stopped');
    const n = String(note || '').trim();
    if (!n || !ws || !Array.isArray(ws.history)) return;
    const last = ws.history[ws.history.length - 1];
    if (last && last.role === 'assistant' && last.stopped) last.stopNote = n.slice(0, 400);
  }
  // RETRY — re-run the last turn after an outage / connection drop / in-band error. Discard the trailing failed
  // reply, re-render the thread (dropping the ⚠ row), then resend the last user message WITHOUT echoing it again.
  function retryLast() {
    // A command that returns in silence is indistinguishable from a broken app — say why nothing happened.
    // (Both guards below are reachable from the /retry command AND the error-recovery "try again" chip.)
    if (!activeWs) return localLine('No active workstream to retry in.');
    if (isBusy()) return localLine('This stream is still running — stop it first, then /retry.');
    const h = activeWs.history;
    /* A retry re-runs the LAST user turn, so every row after it is the attempt being replaced — drop all of them,
       not just the ⚠ row. A failed run that streamed several replies ("The tool needs the required objective
       field." …) used to leave them after the user turn, the retry request then ENDED ON AN ASSISTANT MESSAGE, and
       current Claude models refuse that outright ("This model does not support assistant message prefill") — every
       Try again failed in ~1.5s with "Provider returned error" (first-hour walk 2026-09-28). */
    const lastUser = h.map(m => m && m.role).lastIndexOf('user');
    if (lastUser >= 0) h.length = lastUser + 1;
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
  /* A KEY PASTED INTO CHAT, SAVED (keys.save, 2026-10-25). The agent stored a key the Commander pasted here in KEYS. The
     page holds the paste in two places the sidecar's redaction never reaches: the bubble on screen and this
     workstream's history (the desk save, and what the next turn re-sends to the model). On keys.save's OK result (the
     contract's own agent.tool_call + agent.tool_result, paired by callId — no new event) the sidecar swaps every saved
     key for its placeholder (POST /api/servicekeys/scrub), and only a turn that came back changed is rewritten, so
     nothing is claimed for a paste the sidecar did not find. */
  const KEY_SAVE_CALLS = new Map();   // callId -> runId of an in-flight keys.save (bounded)
  let keySavedWired = false;
  function wireKeySaved() {
    if (keySavedWired || typeof U === 'undefined' || !U.bus) return;
    keySavedWired = true;
    U.bus.on('agent.tool_call', p => {
      if (!p || !p.callId || !p.runId || !/^keys[._]save$/.test(String(p.name || ''))) return;
      KEY_SAVE_CALLS.set(p.callId, p.runId);
      if (KEY_SAVE_CALLS.size > 40) KEY_SAVE_CALLS.delete(KEY_SAVE_CALLS.keys().next().value);
    });
    U.bus.on('agent.tool_result', p => {
      const runId = p && p.callId ? KEY_SAVE_CALLS.get(p.callId) : null;
      if (!runId) return;
      KEY_SAVE_CALLS.delete(p.callId);
      if (p.ok && !p.isError) scrubSavedKeys(runId).catch(() => {});
    });
  }
  // returns how many of the Commander's turns now show the placeholder (the number aids testing)
  async function scrubSavedKeys(runId) {
    let ws = null;
    if (typeof Workstreams !== 'undefined' && Workstreams.all) { try { ws = Workstreams.all().find(w => (w.runIds || []).indexOf(runId) >= 0) || null; } catch (_) {} }
    ws = ws || activeWs;
    const turns = ws && Array.isArray(ws.history) ? ws.history.filter(m => m && m.role === 'user' && typeof m.content === 'string' && m.content) : [];
    if (!turns.length || typeof Harness === 'undefined' || !Harness.api) return 0;
    const raw = turns.map(m => m.content);
    const r = await Harness.api.post('/api/servicekeys/scrub', { texts: raw });
    const out = r && r.ok && r.j && Array.isArray(r.j.texts) && r.j.texts.length === raw.length ? r.j.texts : null;
    if (!out) return 0;
    const keys = [];
    out.forEach((t, i) => {
      if (typeof t !== 'string' || t === raw[i]) return;
      turns[i].content = t;
      for (const k of swappedKeys(raw[i], t)) if (!keys.some(x => x.value === k.value)) keys.push(k);
    });
    if (!keys.length) return 0;
    // the run's directive also rides RUN_META (the rate card's reference line) and may have titled the thread
    for (const meta of RUN_META.values()) { if (meta && typeof meta.directive === 'string') meta.directive = nameKeys(meta.directive, keys); }
    if (typeof ws.title === 'string') ws.title = nameKeys(ws.title, keys);
    try { App.persist(); } catch (_) {}
    if (log && isActiveWs(ws)) {
      const walker = document.createTreeWalker(log, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) { const v = nameKeys(n.nodeValue, keys); if (v !== n.nodeValue) n.nodeValue = v; continue; }
        for (const a of ['title', 'data-tip', 'aria-label']) {
          const v = n.getAttribute(a);
          if (v) { const s = nameKeys(v, keys); if (s !== v) n.setAttribute(a, s); }
        }
      }
    }
    return keys.length;
  }
  // The values the sidecar swapped, read back out of one (raw, scrubbed) pair: the scrubbed text is the raw text with
  // each saved key replaced by its placeholder, so the raw text between the literal pieces IS the key. The page
  // already held these values (the Commander typed them); nothing secret comes back from the sidecar. [] on any doubt.
  function swappedKeys(raw, scrubbed) {
    const re = /\[[A-Z][A-Z0-9_]* saved in (?:API )?KEYS\]/g;   // "API KEYS" since R15; the older "KEYS" still reads back
    const names = scrubbed.match(re) || [], parts = scrubbed.split(re), out = [];
    let at = 0;
    for (let i = 0; i < names.length; i++) {
      const s = raw.indexOf(parts[i], at); if (s < 0) return [];
      const start = s + parts[i].length;
      const last = i === names.length - 1;
      if (!last && !parts[i + 1]) return [];   // two placeholders side by side: no seam to cut at
      const end = last && !parts[i + 1] ? raw.length : raw.indexOf(parts[i + 1], start);
      if (end <= start) return [];
      out.push({ value: raw.slice(start, end), placeholder: names[i] });
      at = end;
    }
    return out;
  }
  // every whole saved key -> its placeholder; a key cut short by a clipped label ("4e7b2c9d1a0f…") too
  function nameKeys(text, keys) {
    let s = String(text == null ? '' : text);
    for (const k of keys) {
      if (k.value.length < 16) continue;
      if (s.indexOf(k.value) >= 0) s = s.split(k.value).join(k.placeholder);
      const head = k.value.slice(0, 12);
      for (let at = s.indexOf(head); at >= 0; at = s.indexOf(head, at + 1)) {
        let end = at + head.length;
        while (end < s.length && k.value.charAt(end - at) === s.charAt(end)) end++;
        if (s.charAt(end) === '…') { s = s.slice(0, at) + k.placeholder + s.slice(end); }
      }
    }
    return s;
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
  /* A run that ends on a TASK_QUESTION owns the one post-run slot, so the connect chip cannot take a row of its own —
     but connectors.list has already told the model "the Commander now has a ⇄ CONNECT chip", and the model tells
     the Commander to tap it (first-hour walk 2026-09-28: said three times, no chip anywhere). Record the handoff
     exactly as offerConnectorDoor would; offerTaskQuestion then draws the door INSIDE the question card. */
  function holdConnectorDoor(runId, originWs) {
    const ev = runId ? CONNECTOR_NEEDED.get(runId) : null;
    if (!ev) return false;
    CONNECTOR_NEEDED.delete(runId);
    const ws = originWs || activeWs;
    if (!ws || typeof Workstreams === 'undefined') return false;
    // awaitingAnswer: the question is still open, so ABILITIES offers RETURN TO TASK, never CONTINUE TASK — that
    // sends a continuation prompt, which send() would route in as the question's ANSWER (review 2026-09-28).
    Workstreams.setConnectorHandoff(ws.id, Object.assign({}, ev, { agentId: ws.agentId || 'agent', awaitingAnswer: true }));
    App.persist();
    return true;
  }
  // The door for the displayed stream's durable connector handoff, drawn inside a question card — a task question
  // or a FORK, fresh or restored after a reload. Opening the connect screen does NOT answer the question. A fresh
  // card passes its runId so an older run's handoff never rides along on every later question in the stream.
  function taskQuestionDoor(body, runId) {
    const h = (activeWs && typeof Workstreams !== 'undefined') ? Workstreams.connectorHandoff(activeWs.id) : null;
    if (h && runId && h.runId && h.runId !== runId) return null;
    const door = (h && typeof Friendly !== 'undefined' && Friendly.connectorDoor) ? Friendly.connectorDoor(h) : null;
    if (!door || !body) return null;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'choice tq-door'; b.textContent = door.label;
    b.onclick = () => door.run();
    body.appendChild(b);
    return b;
  }
  // An explicit continuation carries existing history, unlike retryLast(), which repeats the user turn.
  // The connector is re-read on click; no OAuth callback can start work or change the originating agent.
  const connectorContinuing = new Set();
  async function continueConnectorTask(streamId) {
    const ws = Workstreams.get(streamId), h = Workstreams.connectorHandoff(streamId);
    if (!ws || !h || connectorContinuing.has(streamId) || Channels.isBusy(streamId)) return false;
    // The run that raised this door ended on a question that is still open: a continuation prompt would be taken
    // as its answer. Take the Commander back to the question instead; answering it continues with the connection.
    if (h.awaitingAnswer) {
      App.openWorkstream(streamId);
      if (typeof StationUI !== 'undefined') StationUI.notify('Answer the open question in this task to continue with ' + h.connectorId + '.', 'info');
      return false;
    }
    const continuationFocusVersion = focusVersion;
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
      // Checking/refreshing a connection yields to the Commander. A later response must not
      // override new navigation, typing, or an attachment; leave the handoff available to retry.
      if (focusVersion !== continuationFocusVersion || isComposerEngaged() || Workstreams.get(streamId) !== ws) {
        if (typeof StationUI !== 'undefined') StationUI.notify('Connection checked. Continue the task when you are ready.', 'info');
        return false;
      }
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
  // The ⚠ row a failed run leaves in the transcript (it survives a reload; historyWindowFrom keeps error rows off the
  // model's wire). A specific verdict already names the cause; the generic "Something went wrong" keeps the real
  // reason beside it, so a reload never loses WHY the run stopped (2026-10-11).
  function errorHistoryLine(v) {
    const msg = String((v && v.userMessage) || 'Something went wrong on that turn.');
    const raw = String((v && v.raw) || '').replace(/\s+/g, ' ').trim();
    const keepRaw = !!(v && v.kind === 'unknown' && raw && raw !== msg);
    return '⚠ ' + msg + (keepRaw ? ' (' + (raw.length > 240 ? raw.slice(0, 237) + '…' : raw) + ')' : '');
  }
  function offerTryAgain() {
    choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast());
  }
  // Budget-stop legibility (2026-07-23): a 'budget' stop names WHICH spend cap fired and how big it is, in money
  // words — the old "reached this run's limit" read as a runtime setting and sent users hunting in the wrong
  // panel. Scope/cap ride the additive agent.run.end fields; an old sidecar omits them and gets the generic line.
  // Issue #135: the unpriced ceiling's own lever is its Runtime limits row; a save applies from the next run.
  function budgetStopLine(scope, capUsd, atBalance, unpriced, subscription, projected) {
    /* THE UNPRICED-MODEL TOKEN CEILING IS NOT A $ CAP (2026-10-11). A model with no known price is bounded per run in
       TOKENS (loop.js maxUnpricedTokens, 2,000,000 by default); the $ settings never read it, so "hit the per-run spend
       cap — raise it" sent the user to a lever that changes nothing. unpriced = { model, capTokens } from the additive
       agent.run.end fields. Name the real limit and the real ways out. */
    if (unpriced && unpriced.model) {
      const n = Number(unpriced.capTokens) > 0 ? Number(unpriced.capTokens).toLocaleString('en-US') + '-token' : 'token';
      return 'hit the ' + n + ' safety ceiling for ' + unpriced.model + ', a model StarNet has no price for — raising the $ spending limit does not change this; raise UNPRICED MODEL TOKEN CEILING in SETTINGS › APP & BACKUP › Runtime limits (0 = no ceiling), or pick a priced model to keep going';
    }
    // nor is the SUBSCRIPTION-token ceiling (loop.js maxSubscriptionTokens): a Claude Code sign-in books $0 per turn
    if (subscription && subscription.model) {
      const n = Number(subscription.capTokens) > 0 ? Number(subscription.capTokens).toLocaleString('en-US') + '-token' : 'token';
      return 'used the ' + n + ' per-run ceiling on your Claude subscription (' + subscription.model + ') — say "continue" to keep going, or change the ceiling in SETTINGS › APP & BACKUP › Runtime limits';
    }
    // only show the $ figure when it renders honestly at cent precision (a sub-cent test cap would read "$0.00")
    const cap = (typeof capUsd === 'number' && isFinite(capUsd) && capUsd >= 0.01) ? '$' + capUsd.toFixed(2).replace(/\.00$/, '') + ' ' : '';
    // projected (agent.run.end budgetProjected): a run and its workers share one PER RUN cap; this run stopped BEFORE it
    // (calls in flight took what was left) — never "hit" a cap it did not reach (d3a76db3)
    if (scope === 'run' && projected === true) {
      if (atBalance === true) return (cap ? 'stopped before it would spend more than the ' + cap + 'left on your StarNet balance' : 'stopped before it would spend more than what is left on your StarNet balance') + ' — add credits under SETTINGS → AI & MODELS to keep going';
      return 'stopped before it would pass the ' + cap + 'per-run spend cap — raise it in SETTINGS › SPENDING LIMITS';
    }
    // atBalance (agent.run.end budgetCapIsBalance, additive): admission clamped this StarNet run's ceiling to the
    // reported balance, so the run spent the wallet, not a cap the user chose — raising PER RUN would do nothing.
    if (scope === 'run' && atBalance === true) return (cap ? 'used the ' + cap + 'left on your StarNet balance' : 'used what was left on your StarNet balance') + ' — add credits under SETTINGS → AI & MODELS to keep going';
    const what = scope === 'run' ? 'hit the ' + cap + 'per-run spend cap'
      : scope === 'agent' ? 'this agent hit its ' + cap + 'lifetime spend cap'
      : scope === 'day' ? 'hit the ' + cap + 'daily spend cap'
      : scope === 'global' ? 'hit the ' + cap + 'all-time spend cap'
      : 'hit a spend cap';
    // A per-RUN stop says "raise", never "remove": a StarNet-credit run with PER RUN at 0 still stops at the
    // managed default (issue #53), so "remove it" would be an instruction that does nothing there.
    // the caps live in SETTINGS › SPENDING LIMITS (MISSION CONTROL is only a room label; there is no BUDGET tab)
    return what + (scope === 'run' ? ' — raise it' : ' — raise or remove it') + ' in SETTINGS › SPENDING LIMITS';
  }
  // the budget stop's door: open SETTINGS straight on the SPENDING LIMITS section (the same openTerm(key, section)
  // mechanism friendlyerror's doors use), with retry alongside for after the user has raised the cap. A stop at the
  // StarNet balance gets the top-up door instead — Friendly's 'store' door, the one managed_credit already opens.
  function offerBudgetDoor(atBalance) {
    const topUp = (atBalance === true && typeof Friendly !== 'undefined' && Friendly.actionButton) ? Friendly.actionButton({ action: 'store' }) : null;
    choices([
      topUp ? { label: topUp.label, value: 'store' } : { label: '$ OPEN SPENDING LIMITS', value: 'budget' },
      { label: '↻ Try again', value: 'retry', quiet: true }
    ], it => {
      if (it && it.value === 'retry') { retryLast(); return; }
      if (topUp) { topUp.run(); return; }
      try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('settings', 'budget'); } catch (_) {}
    });
  }
  // the unpriced-model token ceiling's door: a DIFFERENT (priced) model — the model dock, the same ▸ PICK A MODEL door
  // friendlyerror owns — never SPENDING LIMITS, where no setting governs this ceiling. Retry rides alongside.
  function offerUnpricedDoor() {
    const pick = (typeof Friendly !== 'undefined' && Friendly.actionButton) ? Friendly.actionButton({ action: 'settings', kind: 'model_not_found' }) : null;
    if (!pick) { offerTryAgain(); return; }
    choices([
      { label: pick.label, value: 'model' },
      { label: '↻ Try again', value: 'retry', quiet: true }
    ], it => {
      if (it && it.value === 'retry') { retryLast(); return; }
      pick.run();
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
    // verdict to { label, run } — capdenied -> BUILD MODE (with the named capability), auth/no-key -> the real key
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
      // onDone carries the report text: when the clipboard refuses (WebKit after the fetch), the report renders
      // in this row as selectable text with its own in-gesture "copy again" — a retry of this button would only
      // repeat the refusal, so it stays disabled and says where the report went.
      Diag.copy({ notify: false, context: context, onDone: (ok, text) => {
        b.textContent = ok ? '✓ diagnostics copied — paste into your report' : (text ? 'copy blocked — report shown below' : 'could not read diagnostics');
        if (!ok && !text) { b.disabled = false; return; }   // nothing was read — a later retry can still succeed
        if (!ok) { if (Diag.showBlock) { Diag.showBlock(rowEl, { text: text }); autoscroll(); } return; }
        if (typeof SFX !== 'undefined' && SFX.press) SFX.press();
        setTimeout(() => { try { rowEl.remove(); } catch (_) {} }, 2600);
      } });
    });
    rowEl.appendChild(b);
    log.appendChild(rowEl); autoscroll();
  }

  // show the Stop control + the queued pills for whatever stream is on screen. Called from syncStatus (covers
  // switch + turn-end) and at send() start (status goes 'thinking…' without a syncStatus).
  function updateControls() {
    const stop = el('chat-stop');
    if (stop) {
      stop.hidden = !isBusy();
      // in a group ■ is stop-all (GroupChat.stop), so its tip says it stops every agent, not one turn
      const groupStop = activeWs?.conversationMode === 'group';
      stop.setAttribute('data-tip', groupStop ? 'Stop every agent in this chat (Esc)' : 'Stop the running turn (Esc)');
      stop.setAttribute('aria-label', groupStop ? 'Stop every agent in this chat' : 'Stop the running turn');
    }
    // CONCURRENT SESSIONS: a peer run on this agent no longer disables the composer — the backend admits
    // concurrent same-agent runs (workspace lease guards the real collision). The peer surfaces as the soft
    // status row + a tooltip; send stays live.
    const peer = !isBusy() ? busyPeerFor(activeWs) : null;
    if (input) { input.disabled = false; input.title = peer ? ('This agent is also running in ' + shownName(peer)) : ''; }
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
    Object.freeze({ name: 'goal', desc: 'set a goal this session works toward (status/pause/resume/clear)', argsHint: '[text|status|pause|resume|clear]', action: 'goal' }),
    Object.freeze({ name: 'subgoal', desc: 'add a criterion the session goal must also satisfy', argsHint: '[text|remove N|clear]', action: 'subgoal' }),
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
  function streamLabel(w) { return (w && (typeof Workstreams !== 'undefined' && Workstreams.titleOf ? Workstreams.titleOf(w) : (w.title || 'New session'))) || 'current stream'; }
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
    if (typeof GoalLoop === 'undefined') return localLine('Session goals are not available in this build.');
    if (!activeWs) return localLine('Open a workstream first.');
    const cur = goalOf(activeWs);
    if (!raw || low === 'status') return localLine(GoalLoop.statusLine(cur));
    if (low === 'pause') {
      if (!cur || cur.status === 'cleared') return localLine('No session goal to pause.');
      GoalLoop.pause(cur, 'you paused it'); persistGoal();
      return localLine((typeof isBusy === 'function' && isBusy())
        ? '⏸ session goal paused — the step already running finishes, and no next step starts. /goal resume to continue.'
        : '⏸ session goal paused. /goal resume to continue.');
    }
    if (low === 'resume') {
      if (!cur || cur.status !== 'paused') return localLine('No paused session goal to resume.');
      GoalLoop.resume(cur); persistGoal();
      localLine('▶ session goal resumed (' + cur.turnsUsed + '/' + cur.maxTurns + '). Kicking off the next step…');
      return kickGoal(activeWs);   // resume immediately fires the next continuation if the stream is free
    }
    if (low === 'clear') {
      if (!cur || cur.status === 'cleared') return localLine('No session goal to clear.');
      GoalLoop.clear(cur); activeWs.goalLoop = undefined; persistGoal();
      return localLine('Cleared the session goal.');
    }
    // /goal <text> — set (or replace) the standing goal and start working toward it
    const s = GoalLoop.create(raw, { now: Date.now() });
    if (!s) return localLine('Usage: /goal <what you want done>');
    activeWs.goalLoop = s; persistGoal();
    /* ONE MEANING FOR 'GOAL LOOP' (org pass 10-14, P29): /goal is a loop on THIS session only — not an AUTOMATE › GOAL LOOPS
       entry. Say so, and hand over a real door key (never a menu path) to where lasting goal loops live. A reload does not end
       the session, so the line says the goal stays WITH this session through one (P29 polish 2: 'session only … a reload keeps it'
       read as a contradiction). */
    const set = localLine('⊙ goal set for this session only: ' + s.goal + ' (budget ' + s.maxTurns + ' turns). It works while StarNet is open and stays with this session through a reload. Working toward it…');
    if (set && typeof StationUI !== 'undefined' && StationUI.openTerm) {
      systemDoor(set, '▸ AUTOMATE › GOAL LOOPS', () => StationUI.openTerm('automation', 'loops'), { cls: 'goal-loops-door', lead: 'Lasting goal loops:', dest: 'automation:loops' });
    }
    // an untitled session is named from its goal NOW (no-op when it already has a name): the first step may wait on a busy
    // stream or a pending card, and the rail row + COMMS title must never wear the continuation prompt meanwhile
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle && Workstreams.autoTitle(activeWs.id, s.goal)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      paintTitle();
    }
    kickGoal(activeWs);
  }
  // /subgoal <text>          — append a criterion the loop must ALSO satisfy before it's done
  // /subgoal (bare)          — list the criteria; /subgoal clear wipes them
  function subgoalCommand(args) {
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    if (typeof GoalLoop === 'undefined') return localLine('Session goals are not available in this build.');
    const cur = activeWs && goalOf(activeWs);
    if (!raw) {
      const subs = (cur && cur.subgoals) || [];
      return localLine(subs.length ? ('Subgoals: ' + subs.map((t, i) => (i + 1) + '. ' + t).join(' | ')) : 'No subgoals set. Use /subgoal <text> once a session goal is set.');
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
     the human must decide the tool call before we pile on the next turn.
     A GENTLE NUDGE IS NOT A DECISION (live walk 10-14): an optional curiosity/suggestion aside ('✦ one curious thing … SURE /
     NOT NOW') owes no answer and never takes typed text, so it no longer holds the loop — /goal said 'Working toward it…' and
     then sat silent for as long as the aside stayed up. Only a nudge that must be decided (keepUntilDecision) still waits.
     goalWaitReason() names what the loop waits for, so a wait is SAID (kickGoal), never a silent stall. */
  function goalWaitReason(ws) {
    if (interview) return 'the interview to finish';
    if (activeTurnin) return 'your decision on the memory card above';
    if (activeNudge && activeNudge.keepUntilDecision) return 'your choice on the card above';
    if (studyBusy() || threadBusy()) return 'your decision on the card above';
    if (taskQuestionLive()) return 'your answer to the question above';   // the human decides it before the loop piles on
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return 'the open dialogue to close';
    if (ws && typeof Channels !== 'undefined' && Channels.pendingOf && Channels.pendingOf(ws.id)) return 'your approval on the card above';
    return '';
  }
  function goalBlocked(ws) { return !!goalWaitReason(ws); }
  // kick the loop forward on `ws`: if the stream is free + unblocked and the loop is active, send the next
  // continuation as a real turn (routed through send(), so it walks the desk / bills / streams like any turn).
  // Called after a set/resume and after each judged turn. Idempotent + safe when there's no active loop.
  const goalRetry = new Set();   // wsIds with a blocked-moment retry armed (one pending re-check per stream, never stacked)
  const goalWaitSaid = new WeakMap();   // goal object → the wait reasons already said for it (each said once per goal, never repeated)
  function kickGoal(ws) {
    const s = goalOf(ws);
    if (!s || !GoalLoop.isActive(s)) return;
    if (!isActiveWs(ws)) return;                 // the continuation drives the DISPLAYED stream (send()'s DOM writes)
    if (isBusy()) return;                        // a run is already in flight — the teardown judge re-drives the loop
    const wait = goalWaitReason(ws);
    if (wait) {
      // a beat/consent card owns the moment — "deferred" must not become "stalled": re-check on a slow cadence
      // (one armed retry per stream; gives up silently when the loop is paused/cleared meanwhile) and SAY what it waits for
      const said = goalWaitSaid.get(s) || new Set();
      if (!said.has(wait)) { said.add(wait); goalWaitSaid.set(s, said); localLine('⏸ session goal waiting for ' + wait + ' — the next step starts once that is settled.'); }
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
  async function judgeGoalTurn(ws, reply, wasContinuation, stall) {
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
    if (!reply || !String(reply).trim()) {
      /* NO SILENT STALL (2026-10-11). This step stopped, failed, was cut short or asked a question, so there is nothing
         to judge — and the loop used to stay "active" with nothing ever firing the next step. Pause it and SAY why;
         /goal resume (the existing control) picks it up once the cause is handled. */
      const why = String(stall || 'the last step ended without a reply').trim();
      GoalLoop.pause(s, why); persistGoal();
      if (isActiveWs(ws)) localLine('⏸ session goal paused: ' + why + ' — /goal resume to continue.');
      return;
    }
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
        // keepEffort: a verdict that ends the Commander's loop runs on their reasoning effort, never the cheap aux one
        const res = await Harness.chat({ system: sys, messages: [{ role: 'user', content: usr }], agentId: ws.agentId || 'agent', isTask: false, placed: [], internal: true, keepEffort: true });
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
    const title = String(args || '').trim() || (Workstreams.titleOf(src) + ' branch');
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
      const st = localLine('Loop: every ' + cur.label + ', ' + cur.fired + '/' + LOOP_MAX_ITERS + ' runs done'
        + (cur.skipped ? ', ' + cur.skipped + ' tick' + (cur.skipped === 1 ? '' : 's') + ' skipped (a run, a question or another stream had the floor)' : '')
        + ' — "' + String(cur.prompt).slice(0, 60) + '". It stops if you close StarNet; /routine makes it permanent.');
      automateDoor(st, '▸ AUTOMATE › SCHEDULES › NEW', 'routines-create');   // org P19: the lasting form of a loop is a schedule (its own label: it opens the New schedule form, not the list)
      return st;
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
      // a run on a model that bills a dearer rate past a prompt size works in a window stopped at it (the sidecar's
      // runWindow, context-cost-1023): measure against THAT window, the one a run folds in, never the 1M it could hold
      const run = (typeof Harness !== 'undefined' && Harness.runWindowOf) ? (Number(Harness.runWindowOf(cs.model)) || 0) : 0;
      const tier = run > 0 && run < cs.limit;
      const win = tier ? run : cs.limit;
      const pct = Math.round(((cs.used || 0) / win) * 100);
      localLine('Chat memory: ' + (cs.used || 0) + ' / ' + win + ' tokens used (' + pct + '% — a token is roughly ¾ of a word). '
        + (tier ? 'The model can hold ' + cs.limit + ', but it bills a higher rate for a prompt over ' + run + ' tokens, so a run works in ' + run + '. ' : '')
        + 'When it nears full, older turns are folded into a summary automatically during the next run; there is nothing you need to do.');
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
    const lines = slice.map(m => {
      const step = m.role === 'user' && !m.from ? goalStepOf(m.content) : null;   // a goal-loop step is the station's, not "You"
      return step != null ? ('Goal step: ' + step.replace(/\s+/g, ' ')).slice(0, 166)
        : (m.role === 'user' ? 'You' : 'Agent') + ': ' + String(m.content).replace(/\s+/g, ' ').slice(0, 160);
    });
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
        // a subscription or unpriced model has no proven $: its fold label, never a bare "$0.00" (sweep/providers 2026-10-20)
        const models = Array.isArray(j.byModel) ? j.byModel.slice(0, 3).map(m => (m.model || '?') + ' (' + (m.spendLabel && !(m.usd > 0) ? m.spendLabel : U.usd(m.usd || 0) + (m.spendLabel ? ', ' + m.spendLabel : '')) + ')') : [];
        const succ = (j.successPct == null) ? '' : ', ' + j.successPct + '% completed';
        return localLine('Insights (lifetime run history for ' + agentId + '): ' + (j.totalRuns || 0) + ' run' + (j.totalRuns === 1 ? '' : 's')
          + ', ' + (j.usageMissingRuns ? 'at least ' : '') + U.usd(j.totalUsd || 0) + (j.unpricedRuns ? ' (+ ' + j.unpricedRuns + ' run' + (j.unpricedRuns === 1 ? '' : 's') + ' with no published price)' : '')
          + (j.usageMissingRuns ? ' (' + j.usageMissingRuns + ' run' + (j.usageMissingRuns === 1 ? '' : 's') + ' stopped mid-answer before usage arrived)' : '')
          + (j.spendUnknownRuns ? ' (+ ' + j.spendUnknownRuns + ' run' + (j.spendUnknownRuns === 1 ? '' : 's') + ' with spend unknown)' : '') + ', ' + (j.totalTokens || 0) + ' tokens'
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
    // org P19: /cron runs HERE (a client action, not a server 'say'), so its reply carries the SCHEDULES door itself
    const reply = t => { const n = localLine(t); automateDoor(n, '▸ AUTOMATE › SCHEDULES', 'routines'); return n; };
    try {
      if (/^(on|enable|enabled|arm)$/.test(raw) || /^(off|disable|disabled|disarm)$/.test(raw)) {
        const want = /^(on|enable|enabled|arm)$/.test(raw);
        const r = await fetch('/api/cron/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: want }) });
        const j = await r.json().catch(() => null);
        return reply(r.ok && j ? ('Routines scheduler ' + (j.enabled ? 'enabled' : 'disabled') + '.') : 'Could not update the routines scheduler.');
      }
      const r = await fetch('/api/cron', { cache: 'no-store' });
      // an errored read is NOT "scheduler off, 0 jobs" — that reassuring line is exactly the lie to avoid.
      if (!r.ok) return reply('Could not read the routines scheduler (HTTP ' + r.status + ') — its real state is unknown.');
      const j = await r.json();
      const jobs = (j && Array.isArray(j.jobs)) ? j.jobs : [];
      const bits = jobs.slice(0, 5).map((job, i) => (i + 1) + '. ' + (job.name || job.id || 'routine') + (job.enabled === false ? ' [paused]' : ''));
      const schedulerLine = j && j.halted ? 'stopped (E-STOP)' : (j && j.enabled ? 'on' : 'off');
      reply('Routines: scheduler ' + schedulerLine + ', ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's')
        + (bits.length ? ' - ' + bits.join(' | ') : '.') + (j && j.halted ? ' Use /cron on to resume.' : ' Use /cron on or /cron off to arm/disarm.'));
    } catch (_) { reply('Could not load routines from the sidecar.'); }
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
      // the agent's own room PLUS shared station gear — the same reading SKILL LIBRARY makes, so a skill that
      // library shows READY is also offered here (profile / Full Access grants still need /api/toolsets)
      const caps = (World.heroCaps((activeWs && activeWs.agentId) || 'agent') || [])
        .concat(World.stationCaps ? (World.stationCaps() || []) : []);
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
  // the palette's list depends on the gear AND the agent (its profile / Full Access grants count as gear server-side)
  function slashAgentId() { return (activeWs && activeWs.agentId) || 'agent'; }
  function warmSlashCatalog() {
    const placedKey = slashCatalogKey();
    const key = slashAgentId() + '|' + placedKey;
    if (slashCatalogLoaded === key) return;
    if (slashCatalogLoading === key || typeof fetch === 'undefined') return;
    slashCatalogLoading = key;
    fetch('/api/slash/catalog?placed=' + encodeURIComponent(placedKey) + '&agent=' + encodeURIComponent(slashAgentId()), { cache: 'no-store' })
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
      // a skill draft ends "Task: {task}" AFTER the recipe body, and a recipe body can contain braces of its own
      // (a JSON example); select the draft's own {task} slot so typing never overwrites the recipe
      const task = directive.lastIndexOf('{task}');
      const m = task >= 0 ? { index: task, 0: '{task}' } : /\{[^}]+\}/.exec(directive);
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
      lastSaid = lines.length ? systemCard(directive.title || 'Result', lines) : localLine(String(directive.text || '').trim() || 'Done.');
      return true;
    }
    return false;
  }
  /* SYSTEM-LINE DOORS (org P29-sys, 2026-10-14 — Andrew: system messages "look ugly and unaligned"). A station line's door keys
     sit in ONE compact row under that line's own text (.sys-doors), on the same text edge, in the approval cards' glass key —
     never a key bigger than the message it belongs to. A run of consecutive system lines never shows the same door twice: the
     key moves down to the newest line that offers it, so it sits under the last thing it answers.
     node = a system row (localLine / systemCard); onOpen = what the key opens; opts.cls = an extra class (automate-door …);
     opts.lead = a short label in front of the key ("Lasting goal loops:"); opts.dest = where the key goes ('automation:routines').
     A door is the SAME door only when it goes to the same place (live walk 10-14: /loop status's key to New schedule and
     /routine's key to Scheduled jobs shared one label, and the label-only match dropped the loop's door): the de-dupe reads
     the destination, never the label alone. */
  function systemDoor(node, label, onOpen, opts) {
    if (!node || !node.appendChild) return null;
    opts = opts || {};
    const dest = opts.dest || ('label:' + label);
    for (let p = node.previousElementSibling; p && p.classList && p.classList.contains('system'); p = p.previousElementSibling) {
      const dup = Array.from(p.querySelectorAll('.sys-door')).find(k => k.dataset && k.dataset.door === dest);
      if (!dup) continue;
      const was = dup.parentNode; dup.remove();
      if (was && !was.querySelector('.sys-door')) was.remove();   // its lead label leaves with it
      break;
    }
    let doors = Array.from(node.children || []).find(c => c.classList && c.classList.contains('sys-doors'));
    if (!doors) { doors = document.createElement('div'); doors.className = 'sys-doors'; node.appendChild(doors); }
    if (opts.lead) { const k = document.createElement('span'); k.className = 'sys-doors-lead'; k.textContent = opts.lead; doors.appendChild(k); }
    const key = document.createElement('button'); key.type = 'button';
    key.className = 'sys-door' + (opts.cls ? ' ' + opts.cls : ''); key.textContent = label;
    key.dataset.door = dest;
    key.onclick = onOpen;
    doors.appendChild(key);
    return key;
  }
  /* ONE DOOR KEY on an automation slash reply (org P19, 2026-10-14): a key on the reply itself — never a new card — into the
     AUTOMATE tab where that command's lasting form lives. section = the AUTOMATE console section (automation.js: routines /
     routines-create / loops / away). */
  function automateDoor(node, label, section) {
    if (!node || typeof StationUI === 'undefined' || !StationUI.openTerm) return null;
    return systemDoor(node, label, () => StationUI.openTerm('automation', section), { cls: 'automate-door', dest: 'automation:' + section });
  }
  // the server ran /routine or /away and printed its reply: the reply carries the door to the tab that holds that work
  // (/cron is a CLIENT action — cronCommand attaches its own door)
  // (client-side only — sidecar/slash.js and its reply text are unchanged)
  const SERVER_SLASH_DOORS = { routine: ['▸ AUTOMATE › SCHEDULES', 'routines'], away: ['▸ AUTOMATE › AWAY WORK', 'away'] };
  let lastSaid = null;
  async function dispatchSlash(item, rawInput) {
    lastSaid = null;
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
      // the station ANSWERED no (a skill that was removed or pulled, gear not placed): remember its words, so the
      // caller reports what the station said instead of blaming the connection
      slashDispatchRefusal = (!r.ok || !j || !j.ok) && j && j.error ? { status: r.status, error: String(j.error) } : null;
      const ok = !!(r.ok && j && j.ok && applySlashDirective(j.directive));
      const door = ok && lastSaid && item && Object.prototype.hasOwnProperty.call(SERVER_SLASH_DOORS, item.name) ? SERVER_SLASH_DOORS[item.name] : null;
      if (door) automateDoor(lastSaid, door[0], door[1]);
      lastSaid = null;
      return ok;
    } catch (_) { slashDispatchRefusal = null; return false; }
  }
  let slashDispatchRefusal = null;
  // the palette's command list is cached per gear set; installing, removing or switching a skill changes it, so the
  // ABILITIES window announces the change and the next "/" re-reads the station
  function invalidateSlashCatalog() { slashServerCommands = null; slashCatalogLoaded = null; slashCatalogLoading = null; }
  try { window.addEventListener('starnet:skills-changed', () => { invalidateSlashCatalog(); warmSlashCatalog(); }); } catch (_) {}
  async function runSlash(item) {
    if (!item) { closeSlash(); return; }
    const rawInput = input ? input.value : '';
    input.value = ''; closeSlash(); autoGrowInput();   // consume the "/query"; a recipe's run() then refills the input
    if (typeof SFX !== 'undefined' && SFX.press) SFX.press();
    // Try the sidecar for anything server-backed OR anything with no local action at all. The second half
    // matters on a cold start: before the catalog fetch lands, /away and /routine are only known from the
    // FALLBACK list (serverBacked === false) and have no handler — without this they would refuse without ever
    // having asked the station, which is a claim the browser cannot make honestly.
    const needsServer = item.serverBacked || typeof item.run !== 'function';
    if (needsServer && await dispatchSlash(item, rawInput)) return;
    if (needsServer && slashDispatchRefusal && item.source === 'skill') {
      // a skill command the station no longer offers: it was removed, pulled, or its gear isn't placed. Say that,
      // give the typed text back, and refresh the palette so the stale entry disappears.
      const why = slashDispatchRefusal.status === 409 ? 'its gear isn\'t placed for this agent right now' : 'that skill is no longer installed on this station';
      localLine('/' + item.name + ' can\'t be used: ' + why + '. Type "/" to see the skills you have.');
      if (input && rawInput) { input.value = rawInput; autoGrowInput(); }
      invalidateSlashCatalog(); warmSlashCatalog();
      return;
    }
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
  // (multi-bay, 2026-09-22) dockId = WHICH bay the asking stage ran at; the answer names the next bay (nextDock)
  async function nextStageOf(agentId, tag, lineId, dockId) {
    try {
      const h = {}, tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) || '';
      if (tok) h['X-StarNet-Token'] = String(tok);
      // `lineId` = the line this work ENTERED on (work belongs to a line, 2026-08-07). The sidecar's plan is
      // still the decider — it refuses any id that is not this dock's own line — so this only ever narrows.
      const r = await fetch('/api/routing/chain?agentId=' + encodeURIComponent(agentId) + '&tag=' + encodeURIComponent(tag || '')
        + '&lineId=' + encodeURIComponent(lineId || '') + (dockId ? '&dockId=' + encodeURIComponent(dockId) : ''), { cache: 'no-store', headers: h });
      if (!r || !r.ok) return null;
      const j = await r.json();
      return (j && j.next) ? { next: String(j.next), nextDock: (typeof j.nextDock === 'string' && j.nextDock) ? j.nextDock : null, brief: (typeof j.brief === 'string' && j.brief) ? j.brief : null,
        verdict: (typeof j.verdict === 'string' && j.verdict) ? j.verdict : '', last: j.last === true } : null;
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
    // NEVER RUN A DOCK TWICE (multi-bay): visited keys on the bay when the sidecar names one — a writer crewing
    // two bays of this line runs at each — else on the agent (an older sidecar answers no nextDock)
    const visited = {}; visited[seed.fromDock || seed.fromAgentId] = true;
    let cur = seed.fromAgentId, curDock = seed.fromDock || null;
    // LINE BUDGET (2026-08-21): the sidecar answers each /api/routing/chain ask with the EFFECTIVE ceilings
    // for this line (its INBOX's limits, clamped to the global pool) — the browser bounds itself by the same
    // numbers the sidecar executor would. An older sidecar answers none: the mirrored constants hold.
    let maxHops = LINE_MAX_HOPS, maxUsd = LINE_MAX_USD, maxUsdPerDay = null, spentToday = 0;
    for (let hop = 1; hop <= maxHops + 1; hop++) {   // +1 so a stage PAST the ceiling is named, as the sidecar names it
      if (seed.signal && seed.signal.aborted) return out;
      if (interrupted.has(ws.id)) return out;                       // the Commander pressed Stop — the line stops
      const nxr = await nextStageOf(cur, lineTag(out.text), seed.lineId, curDock);
      const nx = nxr && nxr.next, nxDock = (nxr && nxr.nextDock) || null;
      if (!nx || visited[nxDock || nx]) return out;                 // terminal stage, or a loop the plan let through
      const lim = nxr && nxr.limits;
      if (lim && typeof lim === 'object') {
        if (typeof lim.maxHops === 'number' && lim.maxHops >= 0) maxHops = lim.maxHops;
        if (typeof lim.maxUsd === 'number' && lim.maxUsd > 0) maxUsd = lim.maxUsd;
        maxUsdPerDay = (typeof lim.maxUsdPerDay === 'number' && lim.maxUsdPerDay > 0) ? lim.maxUsdPerDay : null;
        spentToday = (typeof lim.spentToday === 'number' && lim.spentToday > 0) ? lim.spentToday : 0;
      }
      if (hop > maxHops) {
        if (isActiveWs(ws)) toolLine('⚠ the work line stopped early — the line is longer than ' + maxHops + ' stages — raise max stages in the INBOX’s LINE BUDGET.', true);
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
      visited[nxDock || nx] = true;

      const who = (typeof App !== 'undefined' && App.agentName && App.agentName(nx)) || nx;
      const wiHop = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('wi-' + Date.now() + '-' + (++wiSeq));
      const hopStart = Date.now();
      // the floor draws the handoff exactly like a channel line's: a crate leaves this dock for the next.
      // `from` = the PRODUCER dock (mirrors chain.js's placed event — must not drift): world.js spawns the
      // crate at THIS dock instead of guessing the upstream dock from the compiled plan.
      const placed = { workitemId: wiHop, queueId: nx, agentId: nx, kind: 'chain', from: cur, lineId: seed.lineId, preview: String(out.text).replace(/\s+/g, ' ').slice(0, 40), ts: hopStart };
      if (nxDock) placed.dockId = nxDock;          // additive (multi-bay): the bay the crate lands at…
      if (curDock) placed.fromDock = curDock;      // …and the bay it left
      wiEmit('workitem.placed', placed);
      if (isActiveWs(ws)) { breakLive(); toolLine('▸ ' + who + ' — stage ' + (hop + 1) + ' of the work line'); }

      // the RECEIVING dock's standing brief rides the shared handoff turn — the same 5th param the sidecar's
      // chain runner passes (sidecar/routing/chain.js) — so the same floor composes the same run here too.
      const prompt = (typeof Pipeline !== 'undefined' && Pipeline.handoffPrompt)
        ? Pipeline.handoffPrompt(seed.originalText, cur, out.text, hop, nxr.brief, nxr.verdict, nxr.last) : out.text;   // + the VERDICT / LAST-stage parts hopTurn adds (sweep 2026-10-01)
      const hopRow = isActiveWs(ws) ? streamingAgent(who, nx, null) : null;   // null: the hop runs without the project root, even as the session's own agent
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
      ws.history.push({ role: 'assistant', content: hopText, agentId: nx, projectRoot: null, ts: Date.now() });   // agentId = the ACTUAL speaker (renderHistory names it); projectRoot null = its files are in nx's workspace
      capHistory(ws);
      out.text = hopText; out.agentId = nx; out.hops++;
      cur = nx; curDock = nxDock;
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
    // STATION SYSTEMS: asking for something on a schedule, or to be reached on a phone/chat app, is the moment
    // AUTOMATION / CHANNELS join a growing dock (a real user turn only — never a retry or a loop continuation)
    if (!retry && !goalContinuation && typeof Systems !== 'undefined' && Systems.noticeText) { try { Systems.noticeText(text); } catch (_) {} }
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
    stepOfferAside('turn');   // the Commander's own turn: an offer panel over COMMS steps aside so the exchange shows
    stick = true;   // sending a message means you want to watch the exchange — re-follow the bottom
    // TIMESTAMP TRUTH (P0): stamp the turn with its REAL wall-clock time at push, and render the same instant on
    // screen — so a later replay/switch shows this turn's actual time, never the reload clock.
    // a goal-loop continuation shows as ONE station line (goalStepLine); its history turn — what the model receives — is unchanged
    if (!retry) { const uts = Date.now(); if (goalContinuation) goalStepLine(goalStepOf(text) || ((goalOf(ws) || {}).goal) || ''); else addUser(text, attsIn, uts); ws.history.push(attsIn.length ? { role: 'user', content: text, attachments: attsIn, ts: uts } : { role: 'user', content: text, ts: uts }); capHistory(ws); }   // on RETRY the user turn is already in the thread + on screen
    const retryDirectiveTurn = ws.history.slice().reverse().find(m => m.role === 'user');
    // name an untitled stream from its first real message (no-op on General / already-titled) — a goal step names it from
    // its GOAL, never the station's continuation prompt (the rail row and the COMMS title both show this name)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, goalContinuation ? (goalStepOf(text) || (goalOf(ws) || {}).goal || '') : text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    // "YES" TO AN OFFER IS A GO: when the agent's last reply offered to do work ("want me to draft it?") a bare
    // "yes" / "sure" / "do it" is the directive itself — classified as chat it ran tool-less and could only promise.
    const priorAgentTurn = (() => { for (let i = ws.history.length - 2; i >= 0; i--) { const m = ws.history[i]; if (m && m.role === 'assistant') return typeof m.content === 'string' ? m.content : ''; if (m && m.role === 'user') return ''; } return ''; })();
    const isTask = recoveryResume || !!pending || Classify.isTaskDirective(text, { priorAgentTurn });
    // the WORDS of a "yes" are not the work: the task is the agent's offer it accepted. So an accepted offer runs WITH
    // tools, but never feeds what reads the Commander's own wording (the profile, the recurring-job miner, the intent
    // offer) — two "yes please" acceptances must not look like a recurring job called "yes please".
    const acceptedOffer = !!(isTask && Classify.isAffirmation && Classify.isAffirmation(text));
    // a task the Commander typed into the message box completes a pending first-task hand-off (gh#158). Never a retry, a goal
    // step, or a send made for them (the tour's file example, a recipe launch, a hand-off Start): those carry no `composer`.
    if (opts && opts.composer && isTask && !retry && !goalContinuation && typeof PitchStore !== 'undefined' && PitchStore.noteCommsTask) { try { PitchStore.noteCommsTask(text); } catch (_) {} }
    // INTENT OFFER: a real, fresh directive is the one moment the Commander has stated what they want in their
    // own words — the only honest place to say "there is a class built for exactly this". Gated to genuine new
    // work: never a retry (already offered on the original), never a recipe launch (they came FROM the library),
    // never a goal-loop continuation (the station wrote that text, not the Commander), never a reply to a
    // pending task question. Stage it on this run's metadata so concurrent sessions can never consume each
    // other's offer; the slow post-run arm reads and clears it after the answer and its own choice rows settle.
    const intentOfferText = (isTask && !acceptedOffer && !retry && !fromRecipe && !goalContinuation && !pending) ? String(text || '') : null;
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
    if (!retry && isTask && !acceptedOffer && !pending && typeof ProfileStore !== 'undefined') ProfileStore.observeMessage(text);
    if (!retry && isTask && !acceptedOffer && !pending && typeof MintStore !== 'undefined') MintStore.observe(text);   // notice recurring jobs → propose minting them as one-tap missions
    // CORRECTION CAPTURE (slice 2): the first message to this agent after a short-of-the-mark verdict IS the
    // correction of that run — hand it to the held skill review in the Commander's words (final: fires now) and
    // stamp the new run as correctionOf so the runs ledger can relate them. One message per verdict; a stale
    // window (>10 min) is just a new task. Never on retry (the same text re-sent is not a second correction).
    let correctionOf = null;
    // the correction is the next message IN THE RATED RUN'S SESSION: matched by agent alone, a new request typed in
    // another session to that agent within the window was saved station-wide as a DISLIKED correction (sweep 2026-10-02)
    if (!retry && !pending && lastShortVerdict && (ws.agentId || 'agent') === lastShortVerdict.agentId && lastShortVerdict.streamId && lastShortVerdict.streamId === ws.id && Date.now() - lastShortVerdict.at < CORRECTION_WINDOW_MS) {
      correctionOf = lastShortVerdict.runId; lastShortVerdict = null;
      postCorrection(correctionOf, text, true, 'message');
    }
    // SALIENCE (decision 3): has this task SHAPE recurred? Read AFTER observe so it counts this run (the read itself is
    // safe on retry — it doesn't mutate the count). Passed to the run so the server fires the memory turn-in on
    // recurring work even when a terse exchange otherwise wouldn't, while a basic one-off is left to reflect()'s floor.
    const recurring = !!(isTask && !acceptedOffer && typeof MintStore !== 'undefined' && MintStore.recurringNow && MintStore.recurringNow(text));
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
      // agents told users "this chat can't show my workspace images" and linked them instead (user reports 10-20): say how
      + (willSpeak ? '' : ' To show the Commander an image file (a PNG, JPG, GIF, WebP or SVG you saved), put ![short caption](path) in your reply, using the relative path you saved it under — this chat shows it as the picture.')
      + (willSpeak ? voiceModeRules() : '');

    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton) so the per-stream diff is real
    const ac = new AbortController();
    aborters.set(ws.id, ac);
    const callNames = {};   // callId -> tool name (the frozen agent.tool_result has no name field)
    const seenDeliv = {};   // title -> true (one openable row per produced file)
    let runToolsOk = 0, runDeliv = 0, thisRunId = null, streamLost = false;   // streamLost: the reply stream threw without a STOP — this page never saw its run end   // per-run work tally → the "rate the work" beat's size + delivery gate
    // this run's own station.control estop.engage came back OK (its result names the action): the halt it scheduled is what
    // cancels it a moment later, so its stop line says so and offers no TRY AGAIN (a retry would press the E-STOP again)
    let runPressedEstop = false;
    let runStartedAt = 0;   // P3.2: this lead run's start wall-clock → the window claimCrew uses to attribute forwarded worker spend
    // the project root THIS run is sent with, captured once: the body, the live reply and every turn it persists use the
    // same value, so a session that joins a project mid-run (path.trust ALWAYS) never re-homes this run's files
    const runRoot = ws.projectRoot || null;
    liveRunRoots.set(ws.id, runRoot);
    activeLiveRow = streamingAgent(undefined, undefined, runRoot);
    let acc = '';
    const runSteers = [];   // every '[steering] …' note this run streamed, with when it arrived (fileRunSteers)
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
    let goalStall = null;        // GOAL LOOP: WHY this step is not judgeable (stopped/failed/cut short/asked) — the loop pauses and says it
    let presenceStoppedBy = null;   // 'esc' | 'you' when the Commander's own Stop ended this run cleanly (the card names it)
    // VOICE-AWARE CHOICES: never let TTS read the FORK:/TASK_QUESTION: choice markers (they render as
    // one-tap chips; spoken aloud they come out as "TASK QUESTION … pipe pipe …" + every option verbatim).
    // speakSafe truncates the spoken view at the first marker LINE, and holds back a still-streaming
    // partial prefix at the buffer tail ("TASK_QU…" hasn't matched yet but must not be flushed).
    const SPEAK_MARKER = /(^|\n)\s*(?:FORK|TASK_QUESTION)\s*:/i;
    const SPEAK_STEER = /(?:^|\n)\[steering\] [^\n]*/g;   // a folded steering note's echo is the Commander's words, never the agent's (it arrives whole, so offsets hold)
    const speakSafe = (s) => {
      s = String(s == null ? '' : s).replace(SPEAK_STEER, '');
      const m = SPEAK_MARKER.exec(s);
      if (m) return s.slice(0, m.index);
      const nl = s.lastIndexOf('\n');
      const tail = s.slice(nl + 1).replace(/^\s+/, '').toUpperCase();
      if (tail && tail.length <= 14 && ('TASK_QUESTION:'.startsWith(tail) || 'FORK:'.startsWith(tail))) return s.slice(0, nl + 1);
      return s;
    };
    const speechToken = typeof Voice !== 'undefined' && Voice.replyToken ? Voice.replyToken() : undefined;
    const speechOpts = { replyToken: speechToken, agentId: ws.agentId };
    speechOpts.owner = speechOpts;   // Voice closes a reply only for the producer that owns it
    // Close THIS run's spoken reply exactly once. If the Commander switches sessions mid-reply, the run stops
    // feeding speech — but the reply it opened must still close, or Voice reads "speaking" forever (hands-free
    // never re-opens, the next reply inherits its failures).
    let speechClosed = false;
    const closeSpeech = () => {
      if (speechClosed || !willSpeak || typeof Voice === 'undefined' || !Voice.endReply) return;
      speechClosed = true; Voice.endReply(undefined, speechOpts);
    };
    let speechTimer = null, speechPendingSince = 0;
    const pushSpeech = (finalize, finalText) => {
      clearTimeout(speechTimer); speechTimer = null;
      // Ownership is checked again for every chunk. A voice-commanded rebind can happen while an
      // older run is still streaming; none of its late words may leak into the new call owner.
      if (typeof Voice === 'undefined' || !willSpeak || !Voice.speakChunk) return;
      if (!speechOwner()) { closeSpeech(); return; }
      // Once closed (the Commander switched away mid-reply), this run never re-opens speech — coming back would
      // re-open a reply nothing closes again (the finally skips a closed reply), wedging hands-free on 'speaking'.
      if (speechClosed) return;
      // spokenIdx is an offset into what was STREAMED. A final text that isn't a continuation of it (a work line's
      // result replaced the reply) would be sliced mid-word — finish the streamed reply instead.
      const fin = finalize && finalText && speakSafe(finalText).startsWith(speakSafe(acc).slice(0, spokenIdx)) ? finalText : acc;
      const src = speakSafe(finalize ? fin : acc);
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
      // Capture the session, admit its turn, then wait for that session's restore
      // before constructing model context. A focus change cannot retarget this send.
      const historyRead = await ensureHistoryReady(ws, ac.signal);
      if (historyRead.repaint && isActiveWs(ws)) {
        if (log) log.innerHTML = '';
        renderHistory(); syncStatus();
        activeLiveRow = streamingAgent(undefined, undefined, runRoot); historyRead.repaint = false;
      }
      const { text: reply, error, endReason, finishReason, completionVerdict, effectVerdict, budgetScope, budgetCapUsd, budgetCapIsBalance, unpricedModel, unpricedCapTokens, subscriptionModel, subscriptionCapTokens, budgetProjected } = await Harness.chat({
        system: sys, messages: retry ? endOnUserTurn(historyWindow(ws)) : historyWindow(ws), agentId: ws.agentId || 'agent', isTask, recurring, signal: ac.signal, streamId: ws.id,
        // a SPOKEN reply may run on SETTINGS › Models › VOICE CHAT MODEL — never a live call's delegated work, which the
        // live voice layer already answers fast and hands to the agent's own model on purpose
        voiceTurn: (willSpeak && !liveVoiceCall()) || undefined,
        taskAction: taskAction || undefined,
        postconditions: opts && opts.postconditions != null ? opts.postconditions : undefined,
        recovery: recoveryResume ? opts.recovery : undefined,
        retryUserRunId: retry ? ((opts && opts.retryUserRunId) || (retryDirectiveTurn && retryDirectiveTurn.sourceRunId)) : undefined,
        connectorContinuationOf: opts && opts.connectorContinuationOf,
        recipeId: recipeId || undefined,   // provenance spine: the launching recipe rides to the durable run row (undefined for non-recipe runs)
        projectRoot: runRoot || undefined,   // project-anchored session: the sidecar injects the folder context ONLY if the root is still a standing blessed grant (truthful)
        placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(ws.agentId || 'agent') : [],   // THE MOAT: this run's TOOL reach = the agent's REAL placed props (dish→web · cabinet→files · workbench→terminal · …); compute is the freebie
        stationPlaced: (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [],   // Class Loadouts (shared-gear): station-wide gear for SKILL availability — a desk-only specialist still gets its class skills when the STATION has the gear (tools stay room-scoped via `placed`)
        onRunId: id => { retirePriorRatings(ws.id); thisRunId = id; if (retryDirectiveTurn && !retryDirectiveTurn.sourceRunId) retryDirectiveTurn.sourceRunId = id; if (starterId) StarterStore.started(starterId, id); runStartedAt = Date.now(); try { RUN_META.set(id, { streamId: ws.id, focusVersion: runFocusVersion, isTask: !!isTask, title: (ws && ws.title) || '', directive: String(text || ''), correctionOf: correctionOf, intentOfferText: intentOfferText, fromRecipe: fromRecipe, recipeId: recipeId, agentId: ws.agentId || 'agent', rec: recClaimRun(id, ws.agentId || 'agent') }); if (RUN_META.size > 60) RUN_META.delete(RUN_META.keys().next().value); } catch (_) {} Channels.setRunId(ws.id, id, Date.now()); if (walkedToDesk && Channels.setStatus) Channels.setStatus(ws.id, 'working…'); if (isActiveWs(ws)) { syncStatus(); renderPresence(); } if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (d && d.indexOf('[steering] ') >= 0) { for (const t of steerEchoesOf(d)) runSteers.push({ text: t, ts: Date.now() }); if (thisRunId) markSentNowLanded(ws.id, thisRunId, d); } if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
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
        onToolResult: ev => { if (!ev.isError) runToolsOk++; const nm = callNames[ev.callId] || 'tool'; if (!ev.isError && /^(?:team[._]dispatch|group[._]handoff)$/.test(nm)) { const rm = runMeta(thisRunId); if (rm) rm.delegated = true; } /* crew results land in this run (deliveryLanding) */ if (!ev.isError && /^station[._]control$/.test(nm) && ev.summary === 'estop.engage') runPressedEstop = true; Channels.addToolResult(ws.id, { callId: ev.callId, name: nm, summary: ev.summary, isError: ev.isError, ms: ev.ms }); presenceToolResult(ws); if (isActiveWs(ws)) resolveChip(ev, nm); if (typeof U !== 'undefined' && U.bus && ev.callId) U.bus.emit('agent.tool_result', { name: nm, agentId: ws.agentId, runId: ev.runId, callId: ev.callId, ok: !ev.isError, isError: !!ev.isError, held: !!(typeof TaskIntent !== 'undefined' && TaskIntent.isGateHeld && TaskIntent.isGateHeld(ev)), summary: ev.summary, ms: ev.ms }); },   // runId rides along: a runId-less copy reset xp.js's per-run buffer (freshRun(undefined)) and wiped buffered memory-reuse credit
        onDeliverable: ev => {
          // BROWSER window: every write (not just the first per run) — it live-reloads the page on screen and, with
          // FOLLOW on, shows a new web page as it's made. Before the per-run dedupe on purpose.
          if (typeof OutputBrowser !== 'undefined' && OutputBrowser.noteOutput) { try { OutputBrowser.noteOutput(ev); } catch (_) {} }
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
            if (!isActiveWs(ws) && typeof StationUI !== 'undefined') { if (thisRunId) notedRuns.add(thisRunId); StationUI.notify(whoOf(ws) + (mk === 'file' ? ' saved ' : ' made ') + ev.title, 'gold', 'runComplete', { kind: 'result', go: { ws: ws.id } }); }   // P1-8 category: run produced a deliverable
          }
        },
        // EL-11: EVERY prompt now reaches a human surface — the active stream renders the inline consent card;
        // a background stream fires the global clickable toast + rail marker (backgroundPermissionNotify). Both
        // paths then ACK the sidecar (consentAck) that the prompt is human-visible, earning the paused run its
        // one bounded extension of the fail-closed auto-deny timer.
        onPermission: ev => { Channels.setPending(ws.id, { ...pendingFrom(ev, ws) }, Date.now()); walkToDesk(); if (isActiveWs(ws)) { breakLive(); permissionRow(ev, ws); renderPresence(); } else { backgroundPermissionNotify(ev, ws); } try { Promise.resolve(Harness.consentAck(Channels.runIdOf(ws.id), ev.promptId)).then(v => { if (!(v && v.ok)) consentAckFailed(ws, ev, v); }, e => consentAckFailed(ws, ev, { ok: false, error: (e && e.message) || String(e) })); } catch (e) { consentAckFailed(ws, ev, { ok: false, error: (e && e.message) || String(e) }); } },
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
      // the run is over: every note it read is filed before its reply (a note the saved reply already shows stays in it)
      fileRunSteers(ws, runSteers, thisRunId, error ? '' : (reply || acc));
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
        // NO RECONNECT WATCH HERE, whatever the words (night N2, 2026-10-15). This error is IN-BAND: the sidecar
        // composed and streamed it, so this page's connection never dropped, and the run's journal was retired on
        // this end. A provider's "terminated"/"network error" used to read as network, arm the probe, and print
        // "connection restored" about a connection that was never lost. A real drop THROWS (marked at Harness's
        // transport throw site) and the catch below arms the watch on verdict.transport.
        persistPartial(ws, acc);
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); }
        ws.history.push({ role: 'assistant', content: errorHistoryLine(v), error: true, ts: Date.now(), projectRoot: runRoot });   // so the failure (and its real reason) survives a switch-back/reload — error:true keeps it off the model's wire
        goalStall = v.userMessage;
        // the run DIED in flight — settle its outcome (task-board truth: a dead run can never wear the DONE
        // chip). Guarded on thisRunId: no run started → nothing was filed, nothing to settle.
        if (thisRunId && typeof Workstreams !== 'undefined' && Workstreams.noteRunEnd) Workstreams.noteRunEnd(ws.id, thisRunId, false);
        if (typeof StationUI !== 'undefined') StationUI.notify(isActiveWs(ws) ? brief(v.userMessage) : whoOf(ws) + ' hit a problem' + sessionNote(ws) + ': ' + brief(v.userMessage), 'warn', undefined, isActiveWs(ws) ? undefined : { kind: 'alert', go: { ws: ws.id } });
        settleRunNeeds(ws.id);   // the run is over: its own asks are no longer waiting on you (a background worker's still is)
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
          goalStall = 'it asked you a question — answer it first';
        }
        // FORK is parsed from the RAW reply, then every choice marker (FORK and any leftover TASK_QUESTION) leaves the
        // displayed + saved text: nothing used to strip a FORK line, so it always printed raw under its own chips.
        const forkAsked = (replyText && typeof Fork !== 'undefined' && Fork.parse) ? Fork.parse(replyText) : null;
        if (typeof Fork !== 'undefined' && Fork.stripMarkers) {
          const shown = Fork.stripMarkers(replyText);
          if (shown !== replyText) {
            replyText = shown;
            if (isActiveWs(ws) && activeLiveRow && activeLiveRow.cleanTaskIntent) activeLiveRow.cleanTaskIntent();
          }
        }
        finalReply = replyText;
        titleOk = !!replyText.trim();   // a real, non-empty reply landed → this stream is eligible for a summary title
        if (replyText.trim()) ws.history.push({ role: 'assistant', content: replyText, ts: Date.now(), sourceRunId: thisRunId || undefined, projectRoot: runRoot });   // never persist an empty turn
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
          // EVERY STOP SAYS WHY (2026-10-11): "stopped (empty)" / "run cancelled" / "run stopped: empty" read as the run
          // quitting for no reason. Friendly.stopLine names what happened + the next step; your own Stop says it was you.
          const unpriced = (endReason === 'budget' && unpricedModel) ? { model: unpricedModel, capTokens: unpricedCapTokens } : null;
          const subscription = (endReason === 'budget' && subscriptionModel) ? { model: subscriptionModel, capTokens: subscriptionCapTokens } : null;
          const stoppedBy = (endReason === 'cancelled' && interrupted.has(ws.id)) ? (stopSource.get(ws.id) || 'you') : null;
          const stopLine = endReason === 'budget' ? budgetStopLine(budgetScope, budgetCapUsd, budgetCapIsBalance, unpriced, subscription, budgetProjected)
            : stoppedBy ? stoppedByLine(stoppedBy)
            // toolsRan: this run's tool calls (callNames), so an empty end after real steps never reads "nothing was done"
            : (typeof Friendly !== 'undefined' && Friendly.stopLine) ? Friendly.stopLine(endReason, { cancelSource: runPressedEstop ? 'estop_by_run' : '', toolsRan: Object.keys(callNames).length })
            : 'stopped (' + endReason + ')';
          // the card already says STOPPED BY YOU — the work log only repeats a reason the card can't carry
          if (isActiveWs(ws)) { breakLive(); if (stopLine && !stoppedBy) toolLine('⏹ ' + stopLine); }
          markStoppedTurn(ws, replyText);
          noteStopReason(ws, stopLine, thisRunId, endReason);
          if (stoppedBy) presenceStoppedBy = stoppedBy;
          // GOAL LOOP: a stopped step is not judgeable — the loop pauses and SAYS why (judgeGoalTurn), never stalls silently
          goalStall = stopLine || ('the step stopped (' + endReason + ')');
          // a budget stop's honest door is SETTINGS › SPENDING LIMITS (the top-up door when the ceiling was the StarNet
          // balance), not a doomed retry (the same cap fires again immediately); every other stop keeps the plain retry chip.
          // The UNPRICED-model token ceiling is not a $ cap at all: its door is a different model (raising $ does nothing).
          if (isActiveWs(ws) && !(endReason === 'cancelled' && runPressedEstop)) { if (endReason === 'budget' && unpriced) offerUnpricedDoor(); else if (endReason === 'budget' && !subscription) offerBudgetDoor(budgetCapIsBalance); else offerTryAgain(); }
          if (typeof StationUI !== 'undefined') StationUI.notify(isActiveWs(ws) ? (stoppedBy ? 'stopped by you' : 'run stopped: ' + brief(stopLine || endReason))
            : whoOf(ws) + ' stopped' + sessionNote(ws) + ' — ' + (endReason === 'budget' ? (unpriced ? 'hit the token ceiling for a model with no price' : subscription ? 'used its per-run Claude subscription ceiling; say "continue" to keep going' : budgetProjected === true ? (budgetCapIsBalance === true ? 'stopped before it would spend the rest of your StarNet balance' : 'stopped before it would pass a spending limit') : budgetCapIsBalance === true ? 'used the rest of your StarNet balance' : 'hit a spending limit') : endReason === 'max_iters' ? 'reached the step limit; say "continue" to keep going' : brief(stopLine || endReason)),
            'warn', undefined, isActiveWs(ws) || endReason === 'cancelled' ? undefined : { kind: 'alert', go: { ws: ws.id } });
        } else if (cutShort) {
          // distinct honest "cut short" recap: the reply is truncated/filtered, not a clean delivery.
          goalStall = finishReason === 'content_filter' ? 'the model’s output was filtered' : 'the reply was cut short by the output limit';
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (finishReason === 'content_filter'
            ? 'reply cut short — the model\'s output was filtered'
            : 'reply cut short — hit the response length limit; say "continue" for the rest'));
          if (typeof StationUI !== 'undefined') StationUI.notify('reply cut short: ' + finishReason, 'warn');
        } else if (postconditionUnmet) {
          goalStall = 'completion was not proven';
          if (isActiveWs(ws)) breakLive(), toolLine('⚠ completion was not proven — typed postconditions returned ' + (completionVerdict || 'not_assessed') + ' (' + (effectVerdict || 'no effect evidence') + ')');
          if (typeof StationUI !== 'undefined') StationUI.notify(isActiveWs(ws) ? 'completion needs verification' : whoOf(ws) + ' finished but couldn’t prove it worked' + sessionNote(ws) + ' — check it', 'warn', undefined, isActiveWs(ws) ? undefined : { kind: 'alert', go: { ws: ws.id } });
        // (a run that already announced a file still says it has a QUESTION: "made X" alone never told you it waits on you)
        } else if (!isActiveWs(ws) && (!endReason || endReason === 'done' || endReason === 'clarifying') && replyText.trim() && !(thisRunId && notedRuns.has(thisRunId) && !taskQuestion && endReason !== 'clarifying') && typeof StationUI !== 'undefined') {
          const asks = !!taskQuestion || endReason === 'clarifying';
          // a BACKGROUND session finished (you were elsewhere) — the one beat you'd otherwise miss; the entry opens it
          StationUI.notify(whoOf(ws) + (asks ? ' has a question for you' : ' finished') + sessionNote(ws), asks ? 'warn' : 'good', asks ? 'needsApproval' : 'runComplete',
            asks ? { kind: 'needs', go: { ws: ws.id }, key: 'needs:' + ws.id } : { kind: 'result', go: { ws: ws.id } });
        }
        // a CLEAN end that hit an unwired connector mid-run: the reply already says "not connected" — the chip is
        // the door. Only on a clean end: a stopped run owns the slot with its retry/budget chip above.
        if (thisRunId) notedRuns.delete(thisRunId);
        if (!taskQuestion && endReason !== 'clarifying') settleRunNeeds(ws.id);   // the run is over: its approvals/questions are no longer waiting (a background worker's still is)
        retireOpenConsents(ws.id, thisRunId || '');   // ...and its open approval cards say so instead of keeping live keys
        if (!taskQuestion && (!endReason || endReason === 'done')) offerConnectorDoor(thisRunId, ws);
        if (taskQuestion || endReason === 'clarifying') holdConnectorDoor(thisRunId, ws);   // the question owns the slot (parsed here, or restored from the store below); its card carries the door
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
                StationUI.notify('⚠ recipe drift: ' + name + ' — ' + (first ? first.detail : 'this run differs from its last ' + drift.baselineRuns), 'bad', undefined, { kind: 'alert', go: { ws: ws.id } });
              })
              .catch(() => {});
          }, 1500);
        }
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        if (isActiveWs(ws) && taskQuestion) presentTaskQuestion(ws, Object.assign({ runId: thisRunId }, taskQuestion));   // enriches with the stored recommendation, then renders
        // Belt-and-braces (live-caught 2026-07-16): a run can end 'clarifying' with the marker unparseable
        // client-side (e.g. a malformed/glued reply line) while the DURABLE brief holds the real validated
        // question — re-present from the store so the Commander is never left with a question-less pause.
        else if (isActiveWs(ws) && endReason === 'clarifying') restoreTaskQuestion(ws);
        // R1 MID-TASK FORK: the agent may have ended this reply with one FORK marker (earned only while the
        // style model's confidence is low — the directive isn't even in the prompt otherwise). Render the
        // one-tap chips at the run boundary; a malformed marker parses null and stays plain text.
        if (isActiveWs(ws) && forkAsked) {
          const fk = forkAsked;   // parsed before the marker left the displayed text (above)
          offerFork(fk, thisRunId); if (!voiceQuestion && fk.question) voiceQuestion = fk.question;
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
        if (isActiveWs(ws)) resolvePresence(ws, { endReason: taskQuestion ? 'done' : endReason, cutShort: cutShort, verificationRequired: postconditionUnmet, steps: runToolsOk, cost: runCost, stoppedBy: presenceStoppedBy });
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
        const by = stopSource.get(ws.id);
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.done(); resolvePresence(ws, { stopped: true, steps: runToolsOk, stoppedBy: by }); }
        markStoppedTurn(ws, acc);
        noteStopReason(ws, stoppedByLine(by), thisRunId);
        if (isActiveWs(ws)) offerTryAgain();
        if (!isTask && isActiveWs(ws) && acc.trim()) World.say(acc);
      } else {
        // A throw that is NOT a deliberate Stop: an unexpected disconnect or a hard fetch/network error. Persist
        // whatever streamed FIRST — before the await below (ordering locked by test/comms-presence.test.js).
        // NEVER synthesize 'cannot reach the STARNET sidecar' here again (2026-07-29): it forced the "restart the
        // app" copy onto every abort, including a dead PROVIDER stream on a healthy install. Say only what we
        // witnessed and let Harness.pingEngine measure the rest — full rationale in harness.js + friendlyerror.js.
        persistPartial(ws, acc);
        streamLost = true;   // its run's end never arrived (see finally)
        let engineAlive = null;
        if (typeof Harness !== 'undefined' && Harness.pingEngine) {
          try { engineAlive = await Harness.pingEngine(); } catch (_) { engineAlive = null; }
        }
        const v = e && e.code === 'HISTORY_UNAVAILABLE'
          ? { userMessage: e.message, retryable: true, action: null, raw: e.message }
          : (typeof Friendly !== 'undefined')
          ? Friendly.friendlyError(aborted ? new Error('connection dropped mid-reply') : e, null, { engineAlive: engineAlive })
          : { userMessage: aborted ? 'Lost the connection — try again.' : (e.message || String(e)), retryable: true, action: null, raw: (e && e.message) || String(e) };
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); resolvePresence(ws, { error: true }); }
        ws.history.push({ role: 'assistant', content: errorHistoryLine(v), error: true, ts: Date.now(), projectRoot: runRoot });   // keep a readable trace of the failure (never replayed to the model)
        goalStall = v.userMessage;
        // This response stream died: the durable journal — not this error — decides whether the task resumes safely
        // or pauses for mutation review once the sidecar answers again. Armed on PROVENANCE (verdict.transport: the
        // error was marked at Harness's own transport throw site), never on words — Chromium/WebView2's bare
        // "network error" body-read rejection now arms it, and a sidecar-written "sidecar HTTP 502 — … terminated" does not.
        if (v.transport === true && thisRunId) { interruptedStreams.add(ws.id); armReconnectWatch(); }
        if (thisRunId && typeof Workstreams !== 'undefined' && Workstreams.noteRunEnd) Workstreams.noteRunEnd(ws.id, thisRunId, false);
        if (isActiveWs(ws)) offerRetry(v);   // RETRY: context-aware recovery chip (a dropped connection is retryable)
      }
      // a THROWN teardown (abort/cancel/disconnect/network drop) means agent.run.end was LOST on the bus, so the
      // crew HUD would stick at WORKING — clear this run's count here. Normal + in-band-error completions deliver
      // run.end (decremented by the bus listener), so we must NOT clear there or a concurrent sibling under-counts.
      if (typeof StationUI !== 'undefined' && StationUI.clearRunning) StationUI.clearRunning(ws.agentId || 'agent');
      // ...and its waits on you end with it, exactly as an in-band end settles them: the bell drops this run's asks
      // (a background worker's keeps its entry), so it never reads "NEEDS YOU — 2 waiting" beside a rail that says 1
      settleRunNeeds(ws.id);
    } finally {
      aborters.delete(ws.id);
      liveRunRoots.delete(ws.id);
      const stoppedHere = interrupted.has(ws.id);   // read before it is consumed: a join this reply asked for is dropped on a stop
      interrupted.delete(ws.id);   // consume the stop flag (whether or not it fired)
      stopSource.delete(ws.id);
      Channels.end(ws.id);
      if (thisRunId) { if (streamLost || interruptedStreams.has(ws.id)) releaseSentNow(ws.id, thisRunId, acc); else settleSentNow(ws.id, thisRunId, acc); }   // SEND NOW lines this run took are settled with it; one it never read goes next (a STOP already gave back the unread ones). A stream that DIED cannot know what its run read: it lets go of them and the station decides
      reconcileSentNow(ws);   // any line on disk this page no longer holds (released just now, or by a teardown) is asked about now
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
      if (willSpeak && speechOwner() && !speechClosed && typeof Voice !== 'undefined' && Voice.endReply) {
        pushSpeech(true, finalReply);
        // VOICE-AWARE CHOICES: the choice itself is spoken as a natural question — question text only;
        // the 2-3 options are on-screen chips (reading them out was the "reads every option" glitch).
        if (voiceQuestion && Voice.speakChunk) Voice.speakChunk('Quick question. ' + voiceQuestion, name, speechOpts);
      }
      closeSpeech();
      // hands-free voice mode: the run is done — let Voice re-open the mic for the next turn.
      if ((!liveVoiceCall() || liveVoiceOwns(ws)) && typeof Voice !== 'undefined' && Voice.onTurnEnd) Voice.onTurnEnd();
      // CREW THIS REPLY ASKED FOR (station.control group.add): they join now — the reply is saved in the history and the
      // channel has ended — and BEFORE a queued follow-up is sent, so that message goes to the new group, not a new reply
      const joining = typeof GroupChat !== 'undefined' && GroupChat.drainAfterRun ? GroupChat.drainAfterRun(ws.id, thisRunId, { stopped: stoppedHere }) : null;
      // TYPE-AHEAD: the stream just freed — send its next queued follow-up (after this call fully unwinds).
      setTimeout(() => { Promise.resolve(joining).catch(() => null).then(() => flushQueued(ws.id)); }, 0);
      // GOAL LOOP: after the teardown, judge this turn against the standing goal and maybe fire the next continuation.
      // A QUEUED user follow-up wins first — it's the human steering, so let it drain (it will preempt/pause the loop
      // when IT is judged as a non-continuation). Only judge when nothing is queued. Deferred (setTimeout) so it runs
      // after this call fully unwinds and after flushQueued, and re-checks busy/blocked inside judgeGoalTurn/kickGoal.
      const hasQueued = (queued.get(ws.id) || []).length > 0;
      if (typeof GoalLoop !== 'undefined' && goalOf(ws) && !hasQueued) {
        const reply = goalJudgeReply, wasCont = goalContinuation;
        if (wasCont || goalActiveAtStart) {
          // a continuation turn → judge it; a REAL user turn that ran while the loop was already active → preempt.
          const stall = goalStall;
          setTimeout(() => { judgeGoalTurn(ws, reply, wasCont, stall); }, 0);
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
    // drop hands-free on disconnect — Live Voice included (its own microphone loop stayed hot behind DISCONNECT)
    if (typeof VoiceLive !== 'undefined' && VoiceLive.isActive && VoiceLive.isActive() && VoiceLive.end) VoiceLive.end();
    if (typeof Voice !== 'undefined' && Voice.stopConvo) Voice.stopConvo();
    // teardown is a DELIBERATE interrupt, not a dropped connection: flag every in-flight stream interrupted BEFORE
    // aborting so send()'s catch reads `stopped` and stays silent — otherwise the AbortError gets reclassified as a
    // network fault and a spurious "can't reach the sidecar" row is pushed into ws.history + persisted. (A reader
    // that aborts WITHOUT going through here = a genuine dropped connection → still a network error + retry.)
    for (const id of aborters.keys()) interrupted.add(id);
    // the re-entry wipes the queue, so a SEND NOW line must not be re-queued by the aborted run's teardown: let go of every
    // one — on disk, the station decides each on the conversation's next load (reconcileSentNow)
    for (const id of Array.from(sentNow.keys())) releaseSentNow(id);
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
          if (typeof SFX !== 'undefined') SFX.press();
          syncConfirm();
          return;
        }
        done = true; activeChoiceRows.delete(rowEl); rowEl.remove(); if (typeof SFX !== 'undefined') SFX.press();
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
    // DOOR LAW (systems.js): a scripted station line (the tour, the awakening) that names a dock system in capitals
    // brings it online as it is said — the station never tells a newcomer to open a button it is still hiding
    if (typeof Systems !== 'undefined' && Systems.noticeReply) { try { Systems.noticeReply(segments.map(s => (s && s.text) || '').join(' ')); } catch (_) {} }
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

  // Background navigation must not steal the caret, an unsent draft (including whitespace),
  // or files that are staged/uploading. Explicit session clicks keep their existing behavior.
  function isComposerEngaged() {
    return !!(pendingAtts.length || (input && (input.value.length ||
      (typeof document !== 'undefined' && document.activeElement === input))));
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

  return { init, load, paintTitle, deliverTurns, send, consentInspect, appendConsentDetails, revealHistory, revealAsk, copyText, continuityDiagnostics, refreshStarters, sendOrQueue, continueConnectorTask, stopActive, status, localLine, broadcast, renderProse, toolRailOf, openFile, answerConsent, consentPhrase: actionPhrase, reconcileBackgroundAsks, setSystem, getHistory, contextRef, abort, isBusy, beatBusy: skillBeatBusy, beginInterview, endInterview, echoUser, prefill, rememberSent: recordSent, autoGrowInput, choices, clearChoices, retireDeskPrompt, typeLine, nudge, clearNudge, offerCuriosity, offerFork, planGoalPath, briefingReceipt, isComposerEngaged, canFocusSession, runMeta, runDidWork, awayDigest, awayReview, awayRate, sampleCard, workshopReturn, refreshIdBar: renderIdBar, refreshGroupControls: updateControls, refreshAgentIdentity, setRosterStatus, askBudgetSpent, spendAsk, clockLabel: fmtClock, breakLabel: fmtBreak, workspaceFileRefs, imageBlobUrl, readableUrl,
    // the COMMS '▤ saved' row's folder / copy-path keys and their path resolver, shared with MY WORK › DELIVERABLES' FILES rows (org pass 10-14, P24)
    folderButton, copyPathButton, fullSavedPath: absoluteArtifactPath };
})();
