/* AGENT OS — windows/outbox.js : the OUTBOX — FINISHED WORK window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (esc/sfx/fmtRel/notify/openTerm, the WS/persistWS workstream seam, and the live present view). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, fmtRel = H.fmtRel, notify = H.notify, openTerm = H.openTerm;
  const WS = H.WS, persistWS = H.persistWS;
  /* a job's FROM / SENT ON TO end by the floor's own line name (worldmodel.lineName — LINE N for an unnamed line, as its plate
     says), else the name the job recorded. A job end is { line, jobId, name } (linejobs normEnd): it never carried a lineId, so
     every unnamed line read 'ANOTHER LINE' here (repair). */
  function lineOfEnd(e) {
    let st = null; try { st = (typeof App !== 'undefined' && App.station) ? App.station() : null; } catch (_) { st = null; }
    const w = e && e.line != null && st && typeof st.lineName === 'function' ? st.lineName(e.line) : null;
    return w || Pipeline.lineWord(e && e.name, 'ANOTHER LINE');
  }

  /* ============== OUTBOX — the finished-work window (accordion redesign, 2026-07-16 round 4) ==============
     Andrew's spec, exactly: an EXTREMELY simple list. Collapsed row = the task's TITLE + a small
     description that is what the agent ACTUALLY DID (its real recorded output — never the prompt,
     never a paraphrase). Click the row → it expands into the full breakdown: the ask, the complete
     output readable right there, and a few genuinely relevant actions — ↗ OPEN (jump into the run's
     session to test the output), ⊕ NEW SESSION (dedicate a fresh chat to expanding on it), and the
     rate control (collecting the crate). One row open at a time; no buttons on collapsed rows.
     TRUTHFUL: title/description derive from the run's durable transcript (routine name wins for the
     title); a missing transcript says so; rows come only from ReturnStore's pending ledger.
     ONE GRAMMAR (2026-08-13): the drawer speaks the DELIVERABLES drawer's exact language — what you
     asked for, what came back, the files — so the OUTBOX reads as the "awaiting your verdict" door
     into the same library, not a second system. The files are the LIBRARY's rows for this runId
     (the one backend index), rendered with the library's own markup and opened through its one
     open/preview seam; a run the index doesn't know (a plain conversation) simply shows no FILES
     section — we never invent one. */
  /* ONE PLACE FOR FINISHED WORK (Andrew 10-02: 'get rid of the outbox as an actual section … it should just be in
     deliverables and all organized output'): this list is DELIVERABLES' TO REVIEW section — finished runs waiting for
     your verdict — not a window of its own. openTerm('outbox') / the floor OUTBOX / every old door land there
     (TERM_ALIAS outbox → deliverables § review). Empty = the section hides; the library below is always there. */
  /* ONE READING OF AN ANSWER (walk 10-14 — TO REVIEW printed '## Findings', '- **Item one:**', '`code`' raw while the library below,
     the WORKFLOWS job view and the Workflow panel drew the same reply): WHAT CAME BACK is drawn by COMMS' own renderer
     (Chat.renderProse — escape-first, so a reply's markup never runs) on the panel scale (wf-md); plain text where it is not loaded.
     The collapsed glance is the library's own markdown → one plain line (Deliverables.plainLine): no '## ', no list dashes, and a
     stripped `code` leaves no stray space ('with code .'). */
  function answerInto(out, text, files) {
    if (typeof Chat !== 'undefined' && Chat.renderProse) { out.classList.add('wf-md'); Chat.renderProse(out, text, files ? { files } : undefined); }
    else out.textContent = text;
  }
  /* WHERE THIS RUN'S FILES LIVE (review 10-14): a reply's relative file link or image opens where the run that wrote it put it —
     the RUN's agent, at the root its run record says it ran with (none = that agent's own workspace) — never the agent open in
     COMMS, which is renderProse's default when no refs ride along. COMMS' own rule for a reply (turnFileRefs), read off the run row. */
  function runFileRefs(agentId, projectRoot) {
    return (typeof Chat !== 'undefined' && Chat.workspaceFileRefs) ? Chat.workspaceFileRefs(String(agentId || 'agent'), null, projectRoot || undefined) : undefined;
  }
  // the run's own row (runs.jsonl via /api/runs — the record ReturnStore.openWork reads too); null when it is unreachable or aged out
  function runRecord(rw) {
    if (!rw || !rw.runId || typeof Harness === 'undefined' || !Harness.api) return Promise.resolve(null);
    return Promise.resolve().then(() => Harness.api.get('/api/runs?agent=' + encodeURIComponent(rw.agentId || 'agent') + '&runId=' + encodeURIComponent(rw.runId)))
      .then(j => ((j && j.runs) || []).find(x => x && x.runId === rw.runId) || null, () => null);
  }
  // a cut reply says so BELOW the answer, never inside it: a cut that lands in a fenced block would draw the note as code (and ⧉ would copy it)
  const ANSWER_MAX = 4000;
  function answerCut(out, text) {
    if (String(text).length <= ANSWER_MAX) return;
    const n = document.createElement('div'); n.className = 'ob-cut';
    n.textContent = '… output truncated — ↗ OPEN SESSION opens the conversation.';
    out.appendChild(n);
  }
  function plain(s) {
    return (typeof Deliverables !== 'undefined' && Deliverables.plainLine) ? Deliverables.plainLine(s) : String(s || '').replace(/\s+/g, ' ').trim();
  }
  const mounted = new Set();
  function buildOutbox(body) {
    // what TO REVIEW really holds (org pass 10-14, P12): ReturnStore.pendingRows = runs that finished while you were away
    // (schedules too) plus folded line jobs, workflow samples and SEND TO hand-offs — never an attended chat, which is
    // rated in COMMS. This list is only the rating reminder: what a run made is filed in the library below, and every row keeps
    // its session. A run that made no files is NOT in the library (sidecar deliverableRows drops it), so the copy never says
    // every row is (org live walk 10-14: the note, MARK ALL's tip and its toast all claimed library filing for 3 of 4 rows).
    /* ONE CLEAN HEADING (org pass 10-14, P12 polish): '▾ TO REVIEW 3' on one line, like every other section heading — the count
       is its own number, not buried mid-sentence — and what the list holds is a dim note UNDER it, never a hanging paragraph */
    const reviewNote = 'Away runs and workflow jobs waiting for your rating. Files they made are in the library below; each one keeps its session (↗ OPEN SESSION). Chats are rated in COMMS.';
    // the count sits after ALL, idle and armed alike ('✓ MARK ALL 3 REVIEWED' → 'MARK ALL 3 REVIEWED — SURE?'), the way the
    // toolbar's CLEAR ALL 3 carries its own (P12 polish 2)
    const markLabel = n => '✓ MARK ALL ' + n + ' REVIEWED';
    const RS = (typeof ReturnStore !== 'undefined') ? ReturnStore : null;
    const rows = (RS && RS.pendingRows) ? RS.pendingRows() : [];
    for (const el of mounted) if (el !== body && !el.isConnected) mounted.delete(el);   // a replaced copy never outlives its window
    mounted.add(body);
    body.hidden = !rows.length;
    body.innerHTML =
      '<h4 class="ms-h dlv-review-h"><button type="button" class="dlv-review-tog" aria-expanded="true"><span class="ob-caret-all" aria-hidden="true">▾</span> <span class="dlv-review-lbl">TO REVIEW</span> <span class="dlv-review-n">' + rows.length + '</span></button>' +
        '<button type="button" class="bb sm ob-clearall" data-tip="Takes every run off this list without a rating. Nothing is deleted: files stay in your library, each run in its session.">' + markLabel(rows.length) + '</button></h4>' +
      '<p class="dim dlv-review-note">' + reviewNote + '</p>' +
      '<div id="ob-list" class="ob-list"></div>' +
      '<button type="button" class="bb sm ob-showall" hidden></button>' +
      '<div class="row ob-doors" style="margin-top:10px;gap:8px"><button class="bb sm" id="ob-logbook">AGENT RECORD · run history</button></div>';
    const list = body.querySelector('#ob-list');
    const lb = body.querySelector('#ob-logbook');
    if (lb) lb.addEventListener('click', () => H.navigateWork('deliverables', 'logbook'));
    // (ONE MENU: DELIVERABLES is this window's neighbouring MY WORK tab — no second door to it here)
    function renderEmpty() { list.innerHTML = ''; body.hidden = true; }   // nothing waiting: the section steps aside
    if (!rows.length) { renderEmpty(); return; }
    /* A LIST THAT CAN'T BURY THE LIBRARY (2026-10-10): a routine left running overnight used to stack 30+ tall cards here,
       pushing the library thousands of pixels down with no way to fold them. Now the heading folds the whole section (the
       choice is remembered), only the first FEW rows show until SHOW ALL, and CLEAR ALL collects every crate in one go —
       nothing is deleted (files stay in the library below, each run in its session); only the "waiting for your verdict" reminder goes. */
    const FOLD_KEY = 'starnet.dlv.review.open', FEW = 3;
    let sectionOpen = true; try { sectionOpen = localStorage.getItem(FOLD_KEY) !== '0'; } catch (_) {}
    let showAll = false;
    const tog = body.querySelector('.dlv-review-tog'), more = body.querySelector('.ob-showall'), clearAll = body.querySelector('.ob-clearall');
    const doors = body.querySelector('.ob-doors');
    const paintFold = () => {
      tog.setAttribute('aria-expanded', sectionOpen ? 'true' : 'false');
      tog.querySelector('.ob-caret-all').textContent = sectionOpen ? '▾' : '▸';
      list.hidden = !sectionOpen; if (doors) doors.hidden = !sectionOpen; clearAll.hidden = !sectionOpen;
      const note = body.querySelector('.dlv-review-note'); if (note) note.hidden = !sectionOpen;
      const live = Array.from(list.children);
      live.forEach((r, i) => { r.hidden = !showAll && i >= FEW; });
      more.hidden = !sectionOpen || live.length <= FEW;
      more.textContent = showAll ? 'SHOW FEWER ▴' : 'SHOW ALL ' + live.length + ' ▾';
      // the counts follow the live list as crates are collected one by one
      const n = tog.querySelector('.dlv-review-n'); if (n) n.textContent = String(live.length);
      if (clearAll.dataset.armed !== '1') clearAll.textContent = markLabel(live.length);
    };
    tog.addEventListener('click', () => { sectionOpen = !sectionOpen; try { localStorage.setItem(FOLD_KEY, sectionOpen ? '1' : '0'); } catch (_) {} paintFold(); });
    more.addEventListener('click', () => { showAll = !showAll; paintFold(); });
    const clearEvery = () => {
      const ids = Array.from(list.children).filter(r => r.dataset.collected !== '1').map(r => r.dataset.runId).filter(Boolean);
      if (RS && RS.resolveAll) RS.resolveAll(ids); else if (RS && RS.resolve) ids.forEach(id => RS.resolve(id));
      notify('Marked ' + ids.length + ' reviewed. Nothing was deleted.', '');
      renderEmpty();
    };
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) ArmConfirm.wire(clearAll, { armedLabel: 'MARK ALL REVIEWED — SURE?', onArm: b => { b.textContent = 'MARK ALL ' + list.children.length + ' REVIEWED — SURE?'; }, onDisarm: paintFold, onConfirm: clearEvery });
    else clearAll.addEventListener('click', clearEvery);
    // agent id → display name via the live roster (raw ids read as debug output)
    const agentName = id => { const a = (Array.isArray(H.present) ? H.present.find(x => x && x.id === id) : null); return (a && a.name) || id || 'agent'; };
    const firstLine = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
    // legacy crates (persisted before streamId rode the rows) — fill their transcript join once, best-effort.
    const fillStreams = (async () => {
      if (rows.every(r => r.streamId)) return;
      try {
        const j = await Harness.api.get('/api/runs?agent=*&limit=200');
        const by = {}; for (const r of ((j && j.runs) || [])) if (r && r.runId) by[r.runId] = String(r.streamId || '');
        for (const rw of rows) if (!rw.streamId && by[rw.runId]) rw.streamId = by[rw.runId];
      } catch (_) {}
    })();
    /* THE FILES JOIN — one fetch of the library's own index (/api/deliverables), folded to runId.
       An unnamed run makes one library row per artifact, so files concatenate across rows (deduped
       by path). This is a read of the ONE backend index the DELIVERABLES window renders — never a
       second bookkeeping of what a run produced. */
    const DLV = (typeof Deliverables !== 'undefined') ? Deliverables : null;
    const dlvRows = [];                                   // card-shaped rows for Deliverables.handleOpenClick (indexed by data-i)
    const openState = { blobUrl: '', previewHost: null }; // the library's own preview-blob lifecycle state
    const dlvJoin = (async () => {
      const byRun = new Map();
      try {
        const j = await Harness.api.get('/api/deliverables?includeCleared=1');   // a crate whose library card was cleared keeps its files
        for (const it of ((j && j.items) || [])) {
          if (!it || !it.runId) continue;
          const cur = byRun.get(it.runId) || { agentId: it.agentId, runId: it.runId, files: [], main: '', summary: '' };
          for (const f of (it.files || [])) if (f && f.path && !cur.files.some(x => x.path === f.path)) cur.files.push(f);
          if (it.main && !cur.main) cur.main = it.main;
          if (it.summary && !cur.summary) cur.summary = String(it.summary);   // the agent's own one-line note for the glance
          byRun.set(it.runId, cur);
        }
      } catch (_) {}                                      // library unreachable → drawers simply omit FILES (never invented)
      return byRun;
    })();
    // OPEN rides the library's one open/preview seam (desktop confirm + safe in-card preview parity).
    list.addEventListener('click', ev => {
      const a = ev.target.closest && ev.target.closest('a[data-file]');
      if (!a || !DLV || !DLV.handleOpenClick) return;
      ev.stopPropagation();
      DLV.handleOpenClick(ev, dlvRows, openState, (s, bad) => notify(s, bad ? 'warn' : ''));
    });
    let open = rows.length;
    const collected = (row) => { row.dataset.collected = '1'; row.style.transition = 'opacity .25s ease'; row.style.opacity = '0'; setTimeout(() => { row.remove(); if (--open <= 0) renderEmpty(); else paintFold(); }, 300); };
    const closeOthers = (except) => { list.querySelectorAll('.ob-row.open').forEach(r => { if (r !== except) { r.classList.remove('open'); const b = r.querySelector('.ob-body'); if (b) b.hidden = true; r.querySelector('.ob-head').setAttribute('aria-expanded', 'false'); r.querySelector('.ob-caret').textContent = '▸'; } }); };
    for (const rw of rows) {
      const row = document.createElement('div'); row.className = 'ob-row'; row.dataset.runId = rw.runId;
      const when = rw.ts ? esc(fmtRel(new Date(rw.ts).toISOString())) : '';
      const usd = (+rw.usd > 0 && typeof U !== 'undefined' && U.usd) ? ' · ' + esc(U.usd(+rw.usd)) : '';
      // title: routine name wins (it's the human name of the job); else the run title until the
      // transcript's real ask replaces it (stored run titles can be prompt+reply mush).
      const lineTitle = /^PIPELINE HANDOFF — /.test(String(rw.title || ''));   // a work line's later stage (its stored title is the machine prompt)
      const provisionalTitle = rw.routine ? ('“' + rw.routine + '”') : lineTitle ? 'work line result' : firstLine(rw.title || 'an unnamed run', 64);
      const jobStream = /^(sample|handoff)-/.test(String(rw.streamId || ''));   // a WORKFLOWS job's run (its record holds where it came from / went)
      row.innerHTML =
        '<div class="ob-head" role="button" tabindex="0" aria-expanded="false">' +
          '<div class="ob-title">◷ <b></b><span class="ob-caret">▸</span></div>' +
          // (P11 polish 2) no filler under the title: every card read 'Open to read this run’s result.', three copies of one
          // sentence. The line stays empty (and takes no room) until the library's own summary for this run — or, once
          // opened, the run's reply — fills it.
          '<div class="ob-desc"></div>' +
          '<div class="ob-meta">' + esc(agentName(rw.agentId)) + ' · ' + when + usd + '</div>' +
        '</div>' +
        '<div class="ob-body" hidden>' +
          // a WORKFLOWS job (2026-09-30) opens its own record there: the result, what each step did, NEEDS CHANGES, send it again
          // (…and a job one line SENT ON to another — SEND TO, 2026-10-10 — is a WORKFLOWS job of its own line: handoff-<id>)
          '<div class="ob-primary">' + (jobStream ? '<button type="button" class="consent-btn ob-wf">OPEN IN WORKFLOWS</button>' : '') + '<button type="button" class="consent-btn ob-open">↗ OPEN SESSION</button>' +
            '<button type="button" class="consent-btn ob-fork">⊕ NEW SESSION</button></div>' +
          '<div class="ob-sec ob-prov" hidden></div>' +
          '<details class="ob-request"><summary class="ob-sec">WHAT YOU ASKED FOR</summary><div class="ob-ask"><span class="loading">loading…</span></div></details>' +
          '<div class="ob-sec">WHAT CAME BACK</div><div class="ob-out"><span class="loading">loading…</span></div>' +
          '<div class="ob-files"></div>' +
          '<div class="ob-acts"><span class="ob-rate"></span></div>' +
          '<div class="deliverable-preview" data-preview aria-live="polite"></div>' +
        '</div>';
      row.querySelector('.ob-title b').textContent = provisionalTitle;
      list.appendChild(row);
      // the glance line: the library's summary of this run, when it filed one (never invented)
      dlvJoin.then(m => { const d = m.get(rw.runId); const el = row.querySelector('.ob-desc'); if (d && d.summary && el && !el.textContent) el.textContent = firstLine(plain(d.summary), 150); }, () => {});
      // Load expanded work only, scoped by durable run identity before the transcript page limit.
      let reading = false, loaded = false;
      const readResult = async () => {
        if (reading || loaded) return;
        reading = true;
        const desc = row.querySelector('.ob-desc'), ask = row.querySelector('.ob-ask'), out = row.querySelector('.ob-out');
        const runRec = runRecord(rw);   // read beside the transcript: where the answer's file links resolve
        await fillStreams;
        let turns = null;
        if (rw.streamId) {
          try {
            const t = await Harness.api.get('/api/transcript?stream=' + encodeURIComponent(rw.streamId) + '&agent=' + encodeURIComponent(rw.agentId || 'agent') + '&runId=' + encodeURIComponent(rw.runId) + '&limit=50');
            turns = (t && t.turns) || [];
          } catch (_) { turns = null; }   // null = fetch FAILED (say so); [] = genuinely empty
        }
        const users = (turns || []).filter(m => m && m.role === 'user' && String(m.content || '').trim());
        const replies = (turns || []).filter(m => m && m.role === 'assistant' && String(m.content || '').trim() && String(m.content).trim() !== '[SILENT]');
        // a work line's later stage was HANDED a machine prompt; the Commander asked for the ORIGINAL request (R2)
        const hand0 = (users.length && typeof Pipeline !== 'undefined' && Pipeline.parseHandoff) ? Pipeline.parseHandoff(users[0].content) : null;
        // SEND TO: a job another line handed on opens with that line's frame — title it by the job as it first arrived
        const inner = hand0 && Pipeline.parseHandoffInput ? Pipeline.parseHandoffInput(hand0.original) : null;
        const sent = inner && inner.original ? inner : ((!hand0 && users.length && typeof Pipeline !== 'undefined' && Pipeline.parseHandoffInput) ? Pipeline.parseHandoffInput(users[0].content) : null);
        const hand = inner && inner.original ? { original: inner.original, stage: hand0.stage, from: hand0.from, sent: inner } : hand0 || (sent && sent.original ? { original: sent.original, stage: 1, from: '', sent } : null);
        // …and a reviewer's trailing "VERDICT: approved" is the loop gate's control signal, not part of the work (R1) — shown without it
        const rawReply = replies.length ? String(replies[replies.length - 1].content) : '';
        const lastReply = (hand && Pipeline.stripVerdictLine) ? Pipeline.stripVerdictLine(rawReply) : rawReply;
        if (!rw.routine && users.length) row.querySelector('.ob-title b').textContent = firstLine(hand ? hand.original : users[0].content, 64);
        desc.textContent = lastReply ? firstLine(plain(lastReply), 150)
          : (turns === null ? 'couldn’t read the result — is the station running?'
            : (turns && turns.length ? 'the run finished with nothing to report.' : 'no transcript recorded for this run. Open the session for older work without run attribution.'));
        // the line a handed-on job came FROM — said in the floor's words once the job's record is read (below); the frame's own
        // name only when there is no record (an unnamed line's frame carries none: it read 'another line' beside FROM LINE N)
        let fromWord = hand && hand.sent ? Pipeline.lineWord(hand.sent.fromName, 'another line') : '';
        // where this job came from / went on to (SEND TO) — the job's own record says, never a guess from the text
        if (jobStream) {
          try {
            const lj = await Harness.api.get('/api/line-jobs?stream=' + encodeURIComponent(rw.streamId) + '&limit=1');
            const sj = lj && Array.isArray(lj.jobs) ? lj.jobs[0] : null, word = e => lineOfEnd(e);
            if (sj && sj.from && hand && hand.sent) fromWord = word(sj.from);
            // (a REFUSED hand-off is NOT SENT ON, with why — never "sent on" for work the station did not send, 10-11)
            const bits = sj ? [sj.from ? 'FROM ' + word(sj.from) : '', sj.sentTo ? (sj.sentTo.refused ? 'NOT SENT ON TO ' + word(sj.sentTo) + ' — ' + sj.sentTo.refused : 'SENT ON TO ' + word(sj.sentTo)) : ''].filter(Boolean) : [];
            const pv = row.querySelector('.ob-prov');
            if (pv && bits.length) { pv.textContent = bits.join(' · '); pv.hidden = false; }
          } catch (_) { /* the provenance line is extra: the result itself is already on screen */ }
        }
        const askFull = hand && hand.sent ? String(hand.original) + '\n\n— handed on from ' + fromWord + ': this reply is this line’s work on what that line delivered.'
          : hand ? String(hand.original) + '\n\n— the result of a work line: this reply is from step ' + hand.stage + ', after ' + String(agentName(hand.from)).toUpperCase() + '.'
          : users.length ? String(users[0].content) : '';
        ask.textContent = askFull ? (askFull.length > 1500 ? askFull.slice(0, 1500) + ' …' : askFull) : (rw.title || '—');
        if (lastReply) {
          const rec = await runRec;
          answerInto(out, lastReply.slice(0, ANSWER_MAX), runFileRefs(rw.agentId, rec && rec.projectRoot));
          answerCut(out, lastReply);
        } else out.textContent = turns === null ? '⚠ couldn’t load the output — the run’s transcript wasn’t reachable.'
          : 'this run recorded no readable output.';
        // FILES — the library's rows for this run, in the library's own markup (dlv-files), sized off
        // disk by the backend. Only rendered when the index proves the run produced something; a plain
        // conversation gets no section (an every-row "no files" line would be noise, not honesty).
        try {
          const d = (await dlvJoin).get(rw.runId);
          if (d && d.files.length && DLV && DLV.fileHref) {
            const idx = dlvRows.push(d) - 1;
            row.dataset.i = String(idx);   // the join handleOpenClick reads: this row → its library files
            row.querySelector('.ob-files').innerHTML =
              '<div class="ob-sec">FILES</div><ul class="dlv-files">' + d.files.map((f, fi) => f.openUrl
                ? '<li><a class="bb sm' + (d.main && f.path === d.main ? ' dlv-hero' : '') + '" data-file="' + fi + '" href="' + esc(DLV.fileHref(f)) + '" target="_blank" rel="noopener">OPEN</a><span class="dlv-fname">' + esc(f.path) + '</span><span class="dlv-fsize">' + esc(DLV.fmtSize(f.bytes)) + '</span>' + (d.main && f.path === d.main ? '<span class="dlv-fmain">the main one</span>' : '') + '</li>'
                : '<li><span class="dlv-fname off">' + esc(f.path) + '</span><span class="dlv-fsize">no longer available</span></li>').join('') + '</ul>';
          }
        } catch (_) {}
        loaded = turns !== null;
        reading = false;
      };
      // the row IS the toggle (accordion: one open at a time; collapsed rows stay clean)
      const head = row.querySelector('.ob-head'), bodyEl = row.querySelector('.ob-body'), caret = row.querySelector('.ob-caret');
      const toggle = () => {
        const opening = bodyEl.hidden;
        if (opening) { closeOthers(row); readResult(); }
        bodyEl.hidden = !opening;
        row.classList.toggle('open', opening);
        head.setAttribute('aria-expanded', opening ? 'true' : 'false');
        caret.textContent = opening ? '▾' : '▸';
      };
      head.addEventListener('click', () => { const s = (window.getSelection && window.getSelection().toString()) || ''; if (!s.trim()) toggle(); });
      head.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
      // ↗ OPEN — jump into the run's own session (full conversation; test the output there)
      row.querySelector('.ob-open').addEventListener('click', async ev => {
        ev.stopPropagation();
        const b = ev.currentTarget; b.disabled = true;
        const ok = (RS && RS.openWork) ? await RS.openWork(rw) : false;
        b.disabled = false;
        if (!ok) notify('transcript unreachable for that run', 'warn');
        else H.workConversation('deliverables');
      });
      // OPEN IN WORKFLOWS — a job sent down a work line opens the WORKFLOWS window on its own record (GET /api/line-jobs?stream=)
      const wfb = row.querySelector('.ob-wf');
      if (wfb) wfb.addEventListener('click', async ev => {
        ev.stopPropagation();
        wfb.disabled = true;
        const ok = (typeof WorkflowsWindow !== 'undefined' && WorkflowsWindow.openByStream) ? await WorkflowsWindow.openByStream(rw.streamId, 'deliverables') : false;
        wfb.disabled = false;
        if (!ok) notify('this job’s workflow record is not on the station any more — ↗ OPEN SESSION still reads it', 'warn');
      });
      // ⊕ NEW SESSION — dedicate a fresh chat (same agent) to expanding on this work; the composer
      // is prefilled naming the task so the follow-up ask writes itself. No fabricated turns.
      row.querySelector('.ob-fork').addEventListener('click', ev => {
        ev.stopPropagation();
        const w = WS(); if (!w) return;
        const title = (row.querySelector('.ob-title b').textContent || 'finished run').replace(/^[“”"]+|[“”"]+$/g, '');
        const ws = w.create(('follow-up: ' + title).slice(0, 80), { activate: false, agentId: rw.agentId });
        persistWS();
        if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(ws.id);
        if (typeof Chat !== 'undefined' && Chat.prefill) Chat.prefill('About the finished “' + title + '” run — ');
        H.workConversation('deliverables');
        sfx('click');
      });
      const rateHost = row.querySelector('.ob-rate');
      const mounted = (typeof Chat !== 'undefined' && Chat.awayRate)
        ? Chat.awayRate(rateHost, rw, () => { if (RS && RS.resolve) RS.resolve(rw.runId, 'outbox'); collected(row); })
        : false;
      if (!mounted) {   // already judged this session — offer the plain collect so the crate never wedges
        const b = document.createElement('button'); b.type = 'button'; b.className = 'consent-btn'; b.textContent = '✓ mark reviewed';
        b.addEventListener('click', ev => { ev.stopPropagation(); if (RS && RS.resolve) RS.resolve(rw.runId, 'outbox'); collected(row); });
        rateHost.appendChild(b);
      }
    }
    paintFold();
  }

  // DELIVERABLES mounts this as its TO REVIEW section; ReturnStore refreshes every mounted copy when crates change
  window.OutboxView = {
    build: buildOutbox,
    refresh() { mounted.forEach(el => { if (!el.isConnected) { mounted.delete(el); return; } buildOutbox(el); }); },
    // DELIVERABLES' close: every copy inside the closing window goes now, not at the next crate change (night-leak 10-15: a
    // closed MY WORK stayed alive through `mounted` for minutes, until a refresh happened to prune it)
    unmount(root) { mounted.forEach(el => { if (!el.isConnected || (root && (el === root || (root.contains && root.contains(el))))) mounted.delete(el); }); },
    _mountedCount: () => mounted.size
  };
})();
