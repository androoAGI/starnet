/* AGENT OS — windows/workflows.js : WORK › AUTOMATE › WORKFLOWS (2026-09-30 — Andrew: "the easiest conveyor system we can possibly put together.
   It should be clear as day to the user how to use it").

   ONE PATH, in its own docked window — never inside Build Mode:
     pick a workflow → send it a job → see the step working on it → read the result → NEEDS CHANGES / KEEP THIS STYLE → send it again.
   The opening view lists every workflow on the floor: its name, who works it, an honest status and ONE key — ▶ SEND A JOB when it is
   ready, FINISH SETUP when it is not. NEW WORKFLOW puts a ready-made line on the floor for you — a starter you pick, or one the station
   sets up from what you describe — with an agent on every step (one agent may do every step: no recruiting needed). The diagram's
   editing, step instructions, triggers, budgets and floor work stay one key away: EDIT WORKFLOW opens the full editor (REFIT's
   Workflow panel) on this line.

   TRUTH (the station's first law): every status is WorkflowLine.readiness over the compiled plan with the Workflow panel's own facts
   (the pill an agent reads with station.layout); "now at step N" is the floor's bay lamp (LineWatch: WORKING only once the sidecar
   confirmed the run there); a job, its steps, what came out and what it cost are the job's server record (GET /api/line-jobs — the
   route's own verdict, kept across reloads and restarts); "in the OUTBOX" only while the OUTBOX ledger holds the delivered run. */
'use strict';
const WorkflowsWindow = (() => {
  const UI = () => (typeof StationUI !== 'undefined' ? StationUI : null);
  const H = () => (UI() && UI().h) || null;
  const P = () => (typeof Pipeline !== 'undefined' ? Pipeline : null);
  const W = () => (typeof WorkflowLine !== 'undefined' ? WorkflowLine : null);
  const B = () => (typeof Build !== 'undefined' ? Build : null);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sfx = k => { try { const h = H(); if (h && h.sfx) h.sfx(k); } catch (_) {} };
  const notify = (t, kind) => { try { const h = H(); if (h && h.notify) h.notify(t, kind || ''); } catch (_) {} };
  const api = p => ((typeof window !== 'undefined' && window.__STARNET_API__) ? window.__STARNET_API__ : '') + p;
  const getJSON = p => fetch(api(p), { cache: 'no-store' }).then(r => r.json().catch(() => null).then(j => ({ status: r.status, j })));
  const postJSON = (p, b) => fetch(api(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })
    .then(r => r.json().catch(() => null).then(j => ({ status: r.status, j })));
  const stationOf = () => { try { return (typeof App !== 'undefined' && App.station) ? App.station() : null; } catch (_) { return null; } };
  const roster = () => { const h = H(); const a = h ? h.present : []; return (Array.isArray(a) ? a : []).filter(x => x && x.id); };
  const agentOf = aid => roster().find(a => a.id === aid) || null;
  const nameOf = aid => { const a = agentOf(aid); return String((a && a.name) || aid || 'agent'); };
  const NAME = aid => nameOf(aid).toUpperCase();
  const thumb = (aid, w, h, cls) => (typeof AgentPortraits !== 'undefined' && AgentPortraits.thumbHTML) ? AgentPortraits.thumbHTML(agentOf(aid), w, h, cls) : '';
  const ago = ts => { const s = Math.max(0, Math.round((Date.now() - (+ts || 0)) / 1000)); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  // what it cost: never "$0.0000" for a run that did cost something
  const usd = v => { const n = +v || 0; return n > 0 && n < 0.0001 ? 'under $0.0001' : '$' + n.toFixed(n >= 0.1 ? 2 : 4); };
  const secs = ms => { const s = Math.max(0, Math.round((+ms || 0) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };

  /* ---------- state ---------- */
  const S = {
    view: 'list',       // 'list' | 'new' | 'line'
    line: null,         // the line the 'line' view shows (its key: the line's oldest machine's prop id)
    step: null,         // the step (BAY prop id) opened under the line's diagram
    jobs: null,         // every recent job record summary, newest first (GET /api/line-jobs) — null until read
    jobsErr: false,
    job: null,          // the whole record on screen in the line view (GET /api/line-jobs/<id>), or null: the job box
    out: null,          // a job THIS window is sending: { line, text, retryOf, phase: 'post'|'run', stopping }
    msg: null,          // { text, bad } — one line under the job box (a refusal: nothing was sent)
    fix: null,          // NEEDS CHANGES for S.job: { jobId, open, state, complaint, diagnosis, fixes, usd, model, error }
    stepOut: {},        // runId → 'loading' | { output } | { err } — each step's own reply (its run's transcript)
    prev: {},           // jobId → the record it re-ran (LAST TIME, BEFORE YOUR FIX)
    draft: {},          // what is being typed, by field: 'job:<line>', 'fix:<job>', 'describe', 'name'
    pick: null,         // NEW: { bp, name, agents: [aid per step], briefs: {ROLE: {does, hands}}, job, drafted }
    drafting: null,     // NEW: { state: 'asking'|'error', error } while the station sets a line up from a description
    made: null,         // NEW: { error, needs } when placing a line failed
    watching: null,     // the running job (not sent from here) the window is following, to show its result when it settles
  };
  let body = null, liveTimer = 0, pollTimer = 0, unsub = null, paintQueued = false;

  /* ---------- the floor, read the way the Workflow panel reads it ---------- */
  /* Every workflow on the floor, compiled the way the router routes: one entry per line that has an INBOX and at least one step.
     Its status is WorkflowLine.readiness with the Workflow panel's own facts (build.js wfHost: hasCompute PER BAY, every blocking
     error on the floor, the floor's nag copy, crew membership, a step's instructions) — the same facts station.layout gives the lead
     (stationcommands.js describeLayout), so the window, the panel and the lead never disagree about whether a line can run. */
  function floor() {
    const st = stationOf(), Pp = P(), Wl = W();
    if (!st || !Pp || !Wl || typeof st.projectGeometry !== 'function') return null;
    let geo, plan, comps;
    try { geo = st.projectGeometry(); plan = Pp.compileRoutingPlan(geo) || {}; comps = Pp.lineComponents(geo) || []; } catch (e) { return null; }
    const crew = roster();
    const hasCompute = (aid, pid) => { try { return !!aid && (st.bayObjects(aid, pid) || []).indexOf('computer') >= 0; } catch (_) { return false; } };
    const isCrew = aid => !crew.length || crew.some(a => a.id === aid);
    const labelOf = code => (B() && B().nagWhy) ? B().nagWhy(code) : code;
    const briefOf = pid => { const p = st.propById(pid); return p && (p.brief || p.hands); };
    const lines = [];
    comps.filter(c => (c.intakes || []).length && (c.bays || []).length).forEach((c, i) => {
      let flow, ready;
      try { flow = Wl.lineFlow(plan, c, Pp, geo.props); ready = Wl.readiness(flow, c, { hasCompute, errors: plan.errors || [], labelOf, isCrew, briefOf }); } catch (e) { return; }
      const intake = st.propById(c.intakes[0]) || {};
      const steps = flow.order.map((pid, k) => { const p = st.propById(pid) || {}; return { id: pid, n: k + 1, label: p.label || '', role: p.role || '', agentId: p.agentId || '', brief: p.brief || '', hands: p.hands || '', desk: hasCompute(p.agentId, pid) }; });
      // its name: the first NAMED INBOX's own words (the compiled record's name), else the floor's LINE <letter> (worldmodel.lineName)
      const named = (c.intakes || []).map(id => st.propById(id)).find(p => p && typeof p.label === 'string' && p.label.trim());
      lines.push({ key: c.key, name: named ? named.label.trim() : ((st.lineName && st.lineName(c.key)) || (st.lineLetter ? 'LINE ' + st.lineLetter(intake.id) : 'LINE ' + c.key)), intakeId: c.intakes[0], flow, ready, steps,
        loops: (flow.gates || []).some(g => g.kind === 'loop'), outbox: flow.outbox && flow.outbox.propId, outboxes: (c.outboxes || []).slice(), sends: Object.values(plan.sendTo || {}).filter(s => s.fromLine === c.key) });
    });
    for (const l of lines) { l.sendNames = [...new Set(l.sends.map(s => { const to = lines.find(x => x.key === s.toLine); return Pp.lineWord(to && to.name, (st.lineName && st.lineName(s.toLine)) || 'ANOTHER LINE'); }))]; l.sendsAll = l.outboxes.length > 0 && l.outboxes.length <= l.sends.length; }
    // the lines whose SEND TO feeds this one (org wire AUTO-P15-1): the same sender rule as BUILD's FED BY (Pipeline.lineSenders — a
    // sender counts only if it can run), named the way sendNames are — STARTS says 'when LINE A sends its finished work'
    for (const l of lines) l.senderNames = [...new Set((Pp.lineSenders ? Pp.lineSenders(plan, l.key) : []).map(id => { const from = lines.find(x => x.key === id); return Pp.lineWord(from && from.name, (st.lineName && st.lineName(id)) || 'ANOTHER LINE'); }))];
    return { st, lines };
  }
  const lineOf = (f, key) => (f && f.lines.find(l => l.key === key)) || null;
  // a line's route in words: the hover tip of its row (the description lives in the tip, never as a sentence under the name)
  const routeTip = l => 'INBOX → ' + l.steps.map(s => (s.label || s.role || 'STEP ' + s.n) + (s.agentId ? ' · ' + NAME(s.agentId) : ' · no agent yet')).join(' → ') + (l.loops ? ' (with a review loop)' : '') + ' → OUTBOX' + ((l.sendNames || []).length ? ' → ' + l.sendNames.join(' / ') : '');

  /* ---------- the jobs: the server's records ---------- */
  function loadJobs() {
    return getJSON('/api/line-jobs?limit=100').then(({ status, j }) => {
      S.jobsErr = !(status === 200 && j && Array.isArray(j.jobs));
      if (!S.jobsErr) S.jobs = j.jobs;
      // a job this window was following (not one it sent) has settled: its line's view becomes that job's result
      const was = S.watching, now = runningJob();
      S.watching = now ? now.id : null;
      if (was && (!now || now.id !== was) && !S.out && S.view === 'line' && !S.job) {
        const done = (S.jobs || []).find(x => x.id === was);
        if (done && done.line === S.line) showJob(was);
      }
      watchRunning(); schedule();
    }, () => { S.jobsErr = true; schedule(); });
  }
  const jobsOf = key => (S.jobs || []).filter(j => j.line === key);
  // the start facts (org P15): World's feed poll — the STARTS line repaints once the server has answered
  /* a poll that ENDED with nothing answered (the station down or restarting, a page with no feed API) never leaves STARTS on 'checking…'
     (org wire AUTO-P15-2): S.startsPolled marks that a read was tried, so startsText says what could not be read */
  function pollStarts() {
    const done = () => { S.startsPolled = true; if (S.view === 'line') schedule(); };
    if (typeof World === 'undefined' || !World.pollFeed) { S.startsPolled = true; return; }
    try { Promise.resolve(World.pollFeed()).then(done, done); } catch (e) { done(); }
  }
  /* the job the station's ONE sample slot is riding (this window's SEND / the panel's SEND A JOB). A job another line HANDED
     ON (SEND TO, `from`) is not it: it holds no sample lock, the sample STOP cannot stop it, and it never blocks sending (10-11) */
  const runningJob = () => (S.jobs || []).find(j => j.status === 'running' && !j.from) || null;
  const runningHandoff = key => (S.jobs || []).find(j => j.status === 'running' && j.from && (key == null || j.line === key)) || null;
  /* the words a SEND TO end is said in: the floor's own name for that line (worldmodel.lineName — the plates and this window's
     list say LINE N for an unnamed line), else the name the job recorded. A job end is { line, jobId, name } (linejobs normEnd):
     it never carried a lineId, so every unnamed line read 'another line' here while its plate said LINE N (repair). */
  const lineWord = e => { const st = stationOf(), w = e && e.line != null && st && st.lineName ? st.lineName(e.line) : null; return w || P().lineWord(e && e.name, 'another line'); };
  let paintFloor = null;   // paint() lends its floor here for the length of one render
  function loadJob(id) {
    return getJSON('/api/line-jobs/' + encodeURIComponent(id)).then(({ status, j }) => (status === 200 && j && j.ok && j.job) ? j.job : null, () => null);
  }
  function showJob(id) {
    return loadJob(id).then(job => {
      if (!job) { notify('that job’s record could not be read', 'warn'); return; }
      S.view = 'line'; S.line = job.line; S.job = job; S.fix = null; S.msg = null; S.scrollTo = '.wfw-result';
      if (job.retryOf && !S.prev[job.id]) loadJob(job.retryOf).then(p => { if (p) { S.prev[job.id] = p; schedule(); } });
      (job.runs || []).forEach(r => readStep(r, job.streamId));
      schedule();
    });
  }
  /* a job out on a line that this window did not send (the panel's SEND A JOB, or sent before a reload): its record says
     running — the window follows it on the floor's lamps and re-reads the record until the route settles it */
  function watchRunning() {
    const r = runningJob(), h = runningHandoff();   // (a handed-on job is followed too: its row and its line's view settle when it does)
    if ((r || h) && !pollTimer) pollTimer = setInterval(() => { if (!alive()) return stopTimers(); loadJobs(); }, 2500);
    if (!r && !h && pollTimer && !(S.out)) { clearInterval(pollTimer); pollTimer = 0; }
    if (r || S.out) startLive();
  }

  /* ---------- sending a job ---------- */
  /* THE LINE IS POSTED BEFORE IT RUNS (build.js finPlanGate's rule): the job is sent only once the sidecar holds THIS floor — a
     line with a blocking problem, or a station that did not answer, is refused with the floor's own words and nothing runs. */
  function planGate() {
    if (typeof World === 'undefined' || !World.syncPlan) return Promise.resolve(null);
    let p; try { p = World.syncPlan(); } catch (_) { p = null; }
    return Promise.resolve(p).then(s => {
      if (!s) return null;
      const errs = s.errors || [];
      if (errs.length) return { refuse: 'the floor has something to fix first: ' + errs.map(e => (B() && B().nagWhy) ? B().nagWhy(e.code) : e.code).filter((v, i, a) => a.indexOf(v) === i).join(' · ') };
      if (s.refusedHash && s.refusedHash === s.lastHash) return { refuse: 'the station refused this line — open EDIT WORKFLOW to see what to fix' };
      if (s.stale || s.inflight || s.retryPending) return { refuse: 'the station did not answer, so the job was not sent' };
      return null;
    }, () => ({ refuse: 'the job was not sent: the line could not be saved to the station' }));
  }
  function send(line, text, retryOf) {
    if (S.out || runningJob()) return;
    sfx('click');
    S.out = { line: line.key, text, retryOf: retryOf || null, phase: 'post', at: Date.now() };
    S.job = null; S.msg = null; S.fix = null; S.step = null; S.scrollTo = '.wfw-run';
    paint(); startLive();
    planGate().then(gate => {
      if (gate && gate.refuse) return settle(line, { ok: false, error: gate.refuse }, 409);
      if (S.out) S.out.phase = 'run';
      schedule();
      postJSON('/api/routing/sample', Object.assign({ line: line.key, text, name: line.name }, retryOf ? { retryOf } : {}))
        .then(({ status, j }) => settle(line, j, status), () => settle(line, null, 0));
    });
  }
  function settle(line, j, status) {
    // THE OUTBOX IS TOLD (the panel's rule): a job that delivered clean is folded into the OUTBOX's ledger
    if (j && j.ok && j.delivered && j.delivered.reason === 'done') { try { if (typeof ReturnStore !== 'undefined' && ReturnStore.foldRow) ReturnStore.foldRow(j.delivered); } catch (_) {} }
    S.out = null;
    if (j && j.jobId) {
      sfx(j.ok ? 'chime' : 'bad');
      loadJobs();
      // the result opens where the job was sent from; a Commander who moved on finds it in that line's LAST JOBS (and the list row)
      if (S.view === 'line' && S.line === line.key && !S.job) showJob(j.jobId); else schedule();
      return;
    }
    // nothing was sent down the line (a refusal): say why, the job text stays in the box
    sfx('bad');
    S.msg = { bad: true, text: (j && j.error) ? String(j.error) : status ? 'the station refused the job (HTTP ' + status + ')' : 'the station could not be reached — is it running?' };
    loadJobs(); schedule();
  }
  function stop() {
    sfx('click');
    if (S.out) S.out.stopping = true;
    schedule();
    postJSON('/api/routing/sample/stop', {}).then(({ j }) => {
      if (!(j && j.ok)) { if (S.out) S.out.stopping = false; notify((j && j.error) || 'the stop was not accepted', 'warn'); }
      schedule();
    }, () => { if (S.out) S.out.stopping = false; notify('the station could not be reached — E-STOP stops everything', 'warn'); schedule(); });
  }

  /* ---------- where the job is now: the floor's own bay lamps ---------- */
  function liveNow(line) {
    const order = (line && line.flow && line.flow.order) || [];
    const lamp = id => (typeof World !== 'undefined' && World.bayLive) ? World.bayLive(id) : null;
    if (!order.length || typeof World === 'undefined' || !World.bayLive) return { id: null, text: 'The job is riding the line…' };
    const at = st => { for (let i = 0; i < order.length; i++) { const s = lamp(order[i]); if (s && s.state === st) return { i, s, id: order[i] }; } return null; };
    const w = at('working');
    if (w) { const st = line.steps[w.i] || {}; return { id: w.id, text: 'Now: step ' + (w.i + 1) + ' of ' + order.length + ' · ' + (st.label || st.role || 'STEP') + ' · ' + NAME(w.s.agentId || st.agentId) + ' is working' + (w.s.forMs != null ? ' · ' + secs(w.s.forMs) : '') }; }
    const q = at('waiting');
    if (q) { const st = line.steps[q.i] || {}; return { id: null, text: 'Next: step ' + (q.i + 1) + ' of ' + order.length + ' · ' + (st.label || st.role || 'STEP') + ' · waiting for ' + NAME(st.agentId) }; }
    return { id: null, text: S.out && S.out.phase === 'post' ? 'Sending the job into the line…' : 'Handing the job on…' };
  }
  function tickLive() {
    if (!alive() || !(S.out || runningJob())) { if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; } return; }
    const f = floor(), line = lineOf(f, S.line), n = body.querySelector('#wfw-live');
    if (!line || !n) return;
    const now = liveNow(line);
    n.textContent = now.text;
    body.querySelectorAll('.wfw-map .wf-node[data-step]').forEach(t => t.classList.toggle('working', t.dataset.step === now.id));
  }
  function startLive() { if (!liveTimer) liveTimer = setInterval(tickLive, 1000); }

  /* ---------- each step's own reply (its run's transcript: the OUTBOX's own read) ---------- */
  function readStep(r, streamId) {
    if (!r || !r.runId || S.stepOut[r.runId]) return;
    S.stepOut[r.runId] = 'loading';
    getJSON('/api/transcript?stream=' + encodeURIComponent(streamId || '') + '&agent=' + encodeURIComponent(r.agentId || 'agent') + '&runId=' + encodeURIComponent(r.runId) + '&limit=50')
      .then(({ status, j }) => {
        const turns = status === 200 && j && Array.isArray(j.turns) ? j.turns : null;
        if (!turns) { S.stepOut[r.runId] = { err: 'this step’s reply could not be read' }; return schedule(); }
        const said = turns.filter(m => m && m.role === 'assistant' && String(m.content || '').trim() && String(m.content).trim() !== '[SILENT]');
        S.stepOut[r.runId] = { output: said.length ? String(said[said.length - 1].content) : '' };
        schedule();
      }, () => { S.stepOut[r.runId] = { err: 'this step’s reply could not be read — is the station running?' }; schedule(); });
  }
  // what the line delivered, as the work alone: a reviewer's VERDICT line and a loop's machine note steer the line, they are not the work
  const LOOP_NOTE = /^\[LOOP — (exhausted|escalated): (\d+) pass(?:es)? round the gate[^\n]*\]\s*/gm;
  function workOf(text) {
    const notes = [], Pp = P();
    const rest = String((Pp && Pp.stripVerdictLine) ? Pp.stripVerdictLine(text || '') : (text || '')).replace(LOOP_NOTE, (m, kind, n) => {
      notes.push(kind === 'escalated' ? 'The review loop used all ' + n + ' tries without an approval, so the work went on to the escalation step.'
        : 'The review loop used all ' + n + ' tries without an approval, so the last version came out as it was.');
      return '';
    }).trim();
    return { notes, rest };
  }

  /* ---------- NEEDS CHANGES: say what's wrong → exact changes to the steps → send it again ---------- */
  function askFixes(job, line, complaint) {
    if (!complaint) { sfx('bad'); notify('say what’s wrong with the result first', 'warn'); return; }
    const st = stationOf();
    const byDock = new Map();
    for (const r of (job.runs || []).slice().reverse()) { if (!r.dockId) continue; const got = S.stepOut[r.runId]; byDock.set(r.dockId, got && got.output ? got.output : ''); }
    const steps = [...byDock.entries()].map(([dockId, output]) => { const p = (st && st.propById(dockId)) || {}; return { dockId, role: p.role || '', name: p.label || '', agent: p.agentId ? nameOf(p.agentId) : '', does: p.brief || '', hands: p.hands || '', output }; });
    if (!steps.length) { sfx('bad'); notify('this job’s steps are not on the floor any more', 'warn'); return; }
    S.fix = { jobId: job.id, open: true, state: 'asking', complaint, fixes: [] };
    blurIn('#wfw-fix-in'); schedule();
    postJSON('/api/routing/fix-suggest', { complaint, job: job.text || '', result: job.output || '', steps, jobId: job.id || '' }).then(({ status, j }) => {
      if (!S.fix || S.fix.jobId !== job.id) return;
      if (status === 200 && j && j.ok) {
        Object.assign(S.fix, { state: 'done', diagnosis: j.diagnosis || '', usd: j.usd || 0, model: j.model || '',
          fixes: (j.fixes || []).map(x => Object.assign({}, x, { was: ((st && st.propById(x.dockId)) || {}).brief || '', wasHands: ((st && st.propById(x.dockId)) || {}).hands || '' })) });
        sfx('chime'); S.scrollTo = '[data-fixes]';
      } else { Object.assign(S.fix, { state: 'error', error: (j && j.error) || ('the station refused (HTTP ' + status + ')') }); sfx('bad'); }
      schedule();
    }, () => { if (S.fix && S.fix.jobId === job.id) { Object.assign(S.fix, { state: 'error', error: 'the station could not be reached' }); schedule(); } });
  }
  // a fix is IN USE while the step's instructions say exactly what it suggested (read live: putting it back shows USE THIS again)
  const fixInUse = x => { const st = stationOf(), p = (st && st.propById(x.dockId)) || {}; return (x.does == null || (p.brief || '') === x.does) && (x.hands == null || (p.hands || '') === x.hands); };
  function noteJob(job, n) { if (job && job.id) postJSON('/api/line-jobs/' + encodeURIComponent(job.id) + '/note', n).then(({ j }) => { if (j && j.ok && j.job && S.job && S.job.id === job.id) { S.job = j.job; schedule(); } }, () => {}); }
  function useFix(job, i, back) {
    const x = S.fix && S.fix.fixes[i], st = stationOf(); if (!x || !st) return;
    const p = st.propById(x.dockId);
    if (!p) { sfx('bad'); notify('this step is not on the floor any more', 'warn'); return; }
    let ok = true;
    if (x.does != null) { const r = st.setPropBrief(x.dockId, back ? x.was : x.does); ok = !!(r && r.ok); }
    if (ok && x.hands != null && st.setPropHands) { const r = st.setPropHands(x.dockId, back ? x.wasHands : x.hands); ok = !!(r && r.ok); }
    if (!ok) { sfx('bad'); notify('this step could not be changed', 'warn'); return; }
    sfx(back ? 'click' : 'chime');   // (the card says it: IN USE, or USE THIS again — no toast over the window's keys)
    // one note per field the fix changed, each with ITS OWN before and after (a hand-off put back saved the old instructions)
    for (const [field, now, was] of [['does', x.does, x.was], ['hands', x.hands, x.wasHands]]) {
      if (now == null) continue;
      noteJob(job, { kind: back ? 'putback' : 'fix', dockId: x.dockId, role: p.label || p.role || '', field, text: back ? (was || '') : now, was: back ? now : (was || ''), why: x.why || '' });
    }
    schedule();
  }
  /* ★ KEEP THIS STYLE: the result becomes the example the line's LAST step (the one whose reply came out) matches every time — written
     INTO that step's instructions as one marked block, the Workflow panel's own ★ KEEP THIS STYLE block (EX_HEAD is the same
     words, so the panel and this window both see it), replacing any earlier example. PUT IT BACK restores what the step said before. */
  const EX_HEAD = 'MATCH THIS EXAMPLE of a good result — its format, length and tone, not its facts:';
  function exampleBrief(does, example) {
    const base = String(does || '').replace(/\n*MATCH THIS EXAMPLE of a good result[\s\S]*$/, '').trim();
    const room = 2000 - base.length - EX_HEAD.length - 12;
    if (room < 300) return null;
    return (base ? base + '\n\n' : '') + EX_HEAD + '\n"""\n' + String(example).trim().slice(0, Math.min(1200, room)) + '\n"""';
  }
  const lastDockOf = job => { const r = (job && job.runs || [])[0]; return r && r.dockId ? r.dockId : null; };
  function styleKept(job) {
    const st = stationOf(), d = lastDockOf(job), p = d && st ? st.propById(d) : null;
    if (!p) return false;
    const want = exampleBrief(p.brief, workOf(job.output).rest);
    return !!want && String(p.brief || '') === want;
  }
  function keepStyle(job) {
    const st = stationOf(), d = lastDockOf(job), p = d && st ? st.propById(d) : null;
    if (!p || p.t !== 'bay') { sfx('bad'); notify('the step that made this result is not on the floor any more', 'warn'); return; }
    const text = workOf(job.output).rest;
    if (!text) { sfx('bad'); notify('this result is empty — there is nothing to keep', 'warn'); return; }
    const next = exampleBrief(p.brief, text);
    if (!next) { sfx('bad'); notify('that step’s instructions are too long to hold an example — shorten them in EDIT WORKFLOW first', 'warn'); return; }
    const was = p.brief || '';
    const r = st.setPropBrief(d, next);
    if (!r || !r.ok) { sfx('bad'); notify('the style could not be saved', 'warn'); return; }
    sfx('chime');   // (the key says it: ★ STYLE KEPT)
    noteJob(job, { kind: 'example', dockId: d, role: p.label || p.role || '', field: 'does', text: next, was });
    keptTaste(job, false);
    schedule();
  }
  /* DESIGN ANCHOR (2026-10-11): the step's example is text only that step reads. The same approval also becomes the
     Commander's station-wide taste with the delivered run's REAL reference (its files, palette, fonts, image prompt — the
     sidecar reads them from the run, POST /api/taste/keep-style), so every crew member's next similar work matches it.
     PUT IT BACK takes that approval back too. A failure says so: the key still truthfully reports the step's example. */
  // The keep route captures the reference before writing memory. Wait for the previous operation on this
  // run before sending its next one: a fast PUT IT BACK must not land before its delayed KEEP THIS STYLE.
  // Keep the queue outside the view so closing/changing jobs does not lose the pending withdrawal.
  const tasteWrites = new Map();
  function keptTaste(job, undo) {
    const run = (job && job.runs || [])[0];
    if (!run || !run.runId) return;
    const runId = run.runId;
    const sent = (tasteWrites.get(runId) || Promise.resolve()).then(() =>
      postJSON('/api/taste/keep-style', undo ? { runId, undo: true } : { runId })).then(({ status, j }) => {
      if (status !== 200 || !(j && j.ok)) { notify((undo ? 'the crew still remembers this style: ' : 'kept for this step, but the crew could not learn the style: ') + ((j && j.error) || 'http ' + status), 'warn'); return; }
      const fm = j.feedbackMemory;
      if (!undo && fm && fm.reason === 'personalization-paused') notify('kept for this step — learning is paused, so the rest of the crew will not learn this style', 'warn');
    }, () => notify(undo ? 'the crew’s copy of this style could not be taken back — is the station running?' : 'kept for this step — the crew could not learn the style (is the station running?)', 'warn'));
    tasteWrites.set(runId, sent);
    sent.then(() => { if (tasteWrites.get(runId) === sent) tasteWrites.delete(runId); });
  }
  function putStyleBack(job) {
    const st = stationOf(), d = lastDockOf(job), p = d && st ? st.propById(d) : null;
    const n = (job.notes || []).slice().reverse().find(x => x.kind === 'example' && x.dockId === d);
    if (!p) { sfx('bad'); notify('the step that made this result is not on the floor any more', 'warn'); return; }
    // kept in the Workflow panel (its ★ KEEP THIS STYLE notes no job): putting it back takes the example block out (the key did nothing)
    const was = n ? (n.was || '') : String(p.brief || '').replace(/\n*MATCH THIS EXAMPLE of a good result[\s\S]*$/, '').trim();
    const r = st.setPropBrief(d, was);
    if (!r || !r.ok) { sfx('bad'); return; }
    sfx('click');
    noteJob(job, { kind: 'putback', dockId: d, role: p.label || p.role || '', field: 'does', text: was, was: p.brief || '' });
    keptTaste(job, true);
    schedule();
  }

  /* ---------- setting a line up: who works each step, a desk to work at ---------- */
  function assign(stepId, aid) {
    const st = stationOf(); if (!st) return;
    const r = st.assignPropAgent(stepId, aid);
    if (r && r.ok) { sfx('click'); syncSoon(); schedule(); } else { sfx('bad'); notify('that step could not be given to ' + NAME(aid), 'warn'); }
  }
  function assignAll(line, aid) {
    const st = stationOf(); if (!st) return;
    let ok = true;
    for (const s of line.steps) if (s.agentId !== aid) { const r = st.assignPropAgent(s.id, aid); ok = ok && !!(r && r.ok); }
    sfx(ok ? 'click' : 'bad'); syncSoon(); schedule();
  }
  /* a step's agent needs a workstation in reach (the router's compute gate): the agent's own desk first (worldmodel.ensureWorkstation
     adopts a free one or builds one in the spawn room); else a desk in the step's own room — build.js requisitionPcFor's search */
  function giveDesk(step) {
    const st = stationOf(); if (!st || !step.agentId) return;
    let r = null;
    try { r = st.ensureWorkstation ? st.ensureWorkstation(step.agentId) : null; } catch (_) { r = null; }
    const has = () => { try { return (st.bayObjects(step.agentId, step.id) || []).indexOf('computer') >= 0; } catch (_) { return false; } };
    if (!has()) {
      const p = st.propById(step.id), rid = p && st.roomAt(p.x, p.y), rm = rid && st.roomById(rid);
      outer: for (const rc of ((rm && rm.rects) || [])) for (let y = rc.y1; y <= rc.y2; y++) for (let x = rc.x1; x <= rc.x2; x++) {
        if (!(st.canPlaceProp('desk', x, y, 2, 1) || {}).ok) continue;
        const res = st.addProp({ t: 'desk', x, y, w: 2, h: 1, agentId: step.agentId });
        if (res && res.ok) { r = res; break outer; }
      }
    }
    if (has()) { sfx('chime'); syncSoon(); }   // (the setup list says it: the item is gone)
    else { sfx('bad'); notify('there is no free floor for a desk there — open EDIT WORKFLOW to make room', 'warn'); }
    schedule();
  }
  function syncSoon() { try { if (typeof World !== 'undefined' && World.syncPlan) World.syncPlan(); } catch (_) {} }

  /* ---------- a new workflow ---------- */
  /* THE STARTERS: four lines that cover most work, each a real shelf line (worldmodel BLUEPRINTS), named the way the Build Library
     names it. Every other line is one key away (MORE LINES opens the Build Library's Conveyors tab). (org P18) The Commander's
     FOR YOUR GOAL line (Build.goalLine — the shelf's own pick from their dossier words) leads when it is not one of the four, and
     SET IT UP FOR ME chooses from the WHOLE shelf, not just the tiles shown. */
  const STARTERS = ['research_line', 'revision_loop', 'front_desk', 'build_test'];
  const catalogLines = () => (typeof WorldModel !== 'undefined' && WorldModel.BLUEPRINTS) || [];
  const bpOf = id => catalogLines().find(b => b.id === id) || null;
  function goalStarter() {
    let g = null;
    try { g = B() && B().goalLine ? B().goalLine() : null; } catch (e) { g = null; }   // no dossier read yet: no goal tile (never a guess)
    // a goal the shelf can NAME (the Commander's own words), or no goal shelf at all (org g7 D2)
    return g && g.id && String(g.quote || '').trim() && bpOf(g.id) && STARTERS.indexOf(g.id) < 0 ? g : null;
  }
  const starterOf = id => { const bp = bpOf(id); return bp ? { id, name: plainName(id), purpose: (words().purpose || {})[id] || '', roles: bayRoles(bp) } : null; };
  const words = () => (B() && B().lineWords) ? B().lineWords() : { plain: {}, purpose: {} };
  const plainName = id => { const w = words(); const bp = bpOf(id); return (w.plain && w.plain[id]) || (bp ? bp.label : id); };
  const bayRoles = bp => (bp ? bp.props.filter(p => p.t === 'bay').map(p => p.role || 'STEP') : []);
  const artCache = {};
  function lineArt(id) {
    if (artCache[id] != null) return artCache[id];
    let url = '';
    try { const bp = bpOf(id), c = bp && B() && B().lineSchematic ? B().lineSchematic(bp) : null; url = c && c.toDataURL ? c.toDataURL('image/png') : ''; } catch (_) { url = ''; }
    return (artCache[id] = url);
  }
  // the job box's example, by what the first step does (never a blank box: an example says what kind of job this line takes)
  function exampleJob(line) {
    const r = ((line && line.steps[0]) || {}).role || '';
    return ({ RESEARCHER: 'e.g. the three biggest AI stories this week, kept short', WRITER: 'e.g. a friendly 150-word welcome email for new customers',
      ENGINEER: 'e.g. a script that renames my photos by the date they were taken', BUILDER: 'e.g. a script that renames my photos by the date they were taken',
      ANALYST: 'e.g. what changed in our sales numbers this month, and why' })[r] || 'Describe the job the way you would ask a person';
  }
  function pickStarter(id, drafted) {
    const bp = bpOf(id); if (!bp) return;
    const crew = roster(), first = crew[0] ? crew[0].id : '';
    const roles = bayRoles(bp), Wl = W(), briefs = {};
    for (const r of roles) if (!briefs[r]) { const d = Wl && Wl.defaultBrief ? Wl.defaultBrief(r) : null; briefs[r] = { does: (d && d.does) || '', hands: (d && d.hands) || '' }; }
    const keep = S.pick && S.pick.bp === id ? S.pick : null;
    S.pick = Object.assign({ bp: id, name: plainName(id), agents: roles.map(() => first), briefs, job: '', drafted: false }, keep || {}, drafted || {});
    if (drafted && drafted.briefs) S.pick.briefs = Object.assign({}, briefs, drafted.briefs);
    S.draft.name = S.pick.name; S.made = null;
    sfx('click'); schedule();
    setTimeout(() => { const n = body && body.querySelector('#wfw-picked'); if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30);
  }
  /* SET IT UP FOR ME: the station's own model reads what you want and picks the starter that fits, a short name, each step's
     instructions and a first job (POST /api/routing/line-draft — one billed call; nothing is placed until you press CREATE). */
  function draftIt(want) {
    if (!want) { sfx('bad'); notify('say what you want the workflow to make first', 'warn'); return; }
    S.drafting = { state: 'asking' }; blurIn('#wfw-describe'); schedule();
    // the whole shelf, the four starters first (one billed call either way: the model reads one row per line)
    const ids = STARTERS.concat(catalogLines().map(b => b.id).filter(id => STARTERS.indexOf(id) < 0));
    const starters = ids.map(starterOf).filter(s => s && s.roles.length);
    postJSON('/api/routing/line-draft', { want, starters }).then(({ status, j }) => {
      if (status === 200 && j && j.ok && bpOf(j.starter)) {
        S.drafting = null;
        const briefs = {}; for (const r in (j.briefs || {})) briefs[r] = { does: String(j.briefs[r] || ''), hands: '' };
        pickStarter(j.starter, { name: j.name || plainName(j.starter), briefs, job: j.job || '', drafted: true, usd: j.usd || 0, model: j.model || '' });
        sfx('chime');
      } else { S.drafting = { state: 'error', error: (j && j.error) || ('the station refused (HTTP ' + status + ')') }; sfx('bad'); schedule(); }
    }, () => { S.drafting = { state: 'error', error: 'the station could not be reached' }; schedule(); });
  }
  /* CREATE: the line is laid on the floor by the layout engine (LineEdit.placeBlueprint — the Build Library's own MAKE ROOM-aware
     placement, in the clear floor nearest the middle of the station), each step gets its agent and its instructions, the INBOX
     carries the name, and the agent gets a desk if a step needs one. Then the window opens the new line on its job box. */
  function create() {
    const pk = S.pick, st = stationOf(), bp = pk && bpOf(pk.bp);
    if (!pk || !st || !bp || typeof LineEdit === 'undefined' || !LineEdit.placeBlueprint) { sfx('bad'); return; }
    const base = String(S.draft.name == null ? pk.name : S.draft.name).replace(/\s+/g, ' ').trim().slice(0, 40) || plainName(pk.bp);
    let near = null;
    try { const b = st.bounds(); near = { x: (b.minTx + b.maxTx) >> 1, y: (b.minTy + b.maxTy) >> 1 }; } catch (_) { near = null; }
    const r = LineEdit.placeBlueprint(st, pk.bp, near, { stamp: { briefs: pk.briefs } });
    if (!r || !r.ok) {
      sfx('bad');
      S.made = { error: r && r.error === 'NO_ROOM' ? 'There is no clear floor big enough for this line' + (r.needs ? ' (it needs ' + r.needs.w + ' × ' + r.needs.h + ' tiles)' : '') + '.'
        : 'This line could not be placed: ' + ((r && r.msg) || (r && r.error) || 'no clear floor for it') + '.' };
      schedule(); return;
    }
    const ids = r.ids || [], bays = ids.map(id => st.propById(id)).filter(p => p && p.t === 'bay');
    const intake = ids.map(id => st.propById(id)).find(p => p && p.t === 'intake');
    bays.forEach((p, i) => { const aid = pk.agents[i] || pk.agents[0]; if (aid) st.assignPropAgent(p.id, aid); });
    /* one name per workflow, judged by what the floor SHOWS (worldmodel.lineNameTaken — the key setPropLabel refuses on): a second
       "Research + write" is "Research + write 2", "Line Research" beside "Research" is "Line Research 2", and an unnamed line's
       LINE <letter> is taken too. Then the window says the name the floor STORED, never the one it asked for (final floor lane M18:
       a refused name left the line unnamed while the window said "✓ Line Research is on your floor"). */
    const own = new Set(intake ? [intake.id] : []);
    const taken = v => st.lineNameTaken ? st.lineNameTaken(v, own) : ((floor() || { lines: [] }).lines).some(l => l.name.toLowerCase() === v.toLowerCase());
    let name = base; for (let n = 2; taken(name) && n < 100; n++) name = base.slice(0, 37) + ' ' + n;
    const lr = intake && st.setPropLabel ? st.setPropLabel(intake.id, name) : null;
    const kept = intake && st.propById(intake.id), shown = (kept && kept.label) || (intake && st.lineName ? st.lineName(intake.id) : null) || name;   // (the row's own words: the stored name, else the floor's LINE <letter>)
    // a step with no workstation in reach gets one (the agent's own desk first)
    for (const p of bays) { const q = st.propById(p.id); if (q && q.agentId) { let ok = false; try { ok = (st.bayObjects(q.agentId, q.id) || []).indexOf('computer') >= 0; } catch (_) {} if (!ok) giveDesk({ id: q.id, agentId: q.agentId }); } }
    syncSoon();
    const f = floor(), made = f && intake ? f.lines.find(l => l.intakeId === intake.id || (l.flow && l.flow.trigger && l.flow.trigger.propId === intake.id)) : null;
    sfx('chime');
    if (made && pk.job) S.draft['job:' + made.key] = pk.job;
    S.pick = null; S.drafting = null; S.made = null; S.draft.name = ''; S.draft.describe = '';
    S.view = made ? 'line' : 'list'; S.line = made ? made.key : null; S.job = null; S.step = null;
    // said in the window, under the job box — a toast would sit over the SEND key
    S.msg = made ? { text: '✓ ' + shown + ' is on your floor' + (lr && !lr.ok ? ' (not named ' + name + ' — ' + String(lr.short || lr.msg || 'that name was refused').toLowerCase() + ')' : '') + (pk.job ? ', with a first job written for you' : '') + '. Send a job whenever you like.' } : null;
    paint();
    focusIn('#wfw-job');
  }

  /* ---------- painting ---------- */
  const alive = () => !!(body && body.isConnected);
  // one repaint per burst of changes (a timer, not a frame: a window behind the REFIT overlay or in a hidden tab still catches up)
  function schedule() { if (paintQueued) return; paintQueued = true; setTimeout(() => { paintQueued = false; paint(); }, 0); }
  function blurIn(q) { const n = body && body.querySelector(q); if (n && document.activeElement === n) n.blur(); }
  function focusIn(q) { setTimeout(() => { const n = body && body.querySelector(q); if (n) { n.focus(); try { n.setSelectionRange(n.value.length, n.value.length); } catch (_) {} } }, 0); }
  function paint() {
    if (!alive()) return stopTimers();
    // a field being typed in keeps its cursor through a repaint (the values ride S.draft, so the new field says the same)
    const a = document.activeElement, keep = (a && body.contains(a) && a.id) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd, top: a.scrollTop } : null;
    const scroller = body.closest('.term-body') || body, top = scroller.scrollTop;
    const f = floor();
    let html;
    paintFloor = f;   // (lent for this render only — a render that throws still hands it back)
    try {
      if (!f) { html = '<div class="wfw-empty">The station floor is still loading…</div>'; setTimeout(() => { if (alive() && !floor()) schedule(); else if (alive()) { attachFloor(); schedule(); } }, 1000); }
      else if (S.view === 'new' || (!f.lines.length && S.view !== 'line')) html = newHTML(f);
      else if (S.view === 'line' && lineOf(f, S.line)) html = lineHTML(f, lineOf(f, S.line));
      else { S.view = 'list'; html = listHTML(f); }
    } finally { paintFloor = null; }
    body.innerHTML = '<div class="wfw">' + html + '</div>';
    wire(f);
    scroller.scrollTop = top;
    // a new stage of the job (it went out, its result came back) is brought into view once; every other repaint keeps the scroll
    if (S.scrollTo) { const n = body.querySelector(S.scrollTo); S.scrollTo = null; if (n) { const sr = scroller.getBoundingClientRect(), nr = n.getBoundingClientRect(); scroller.scrollTop += (nr.top - sr.top) - 8; } }
    body.querySelectorAll('[data-md]').forEach(n => { const raw = n.getAttribute('data-md-src') != null ? n.getAttribute('data-md-src') : n.textContent; if (typeof Chat !== 'undefined' && Chat.renderProse) { n.classList.add('wf-md'); Chat.renderProse(n, raw); } });
    if (keep) { const n = body.querySelector('#' + keep.id); if (n) { n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch (_) {} n.scrollTop = keep.top; } }
    if (S.out || runningJob()) { startLive(); tickLive(); }
  }

  /* THE LIST: every workflow, one row each — who works it (their bodies), its name, a short stat, its honest status and ONE key */
  function listHTML(f) {
    const rows = f.lines.map(l => {
      const r = l.ready, last = jobsOf(l.key)[0];
      const crew = [...new Set(l.steps.map(s => s.agentId).filter(Boolean))];
      const stat = l.steps.length + ' step' + (l.steps.length === 1 ? '' : 's') + (last ? ' · last job ' + ago(last.startedAt) + (last.status === 'delivered' ? ' ✓' : last.status === 'running' ? ' · running' : '') : '');
      return '<div class="wfw-row" data-line="' + esc(l.key) + '" role="button" tabindex="0" data-tip="' + esc(routeTip(l)) + '">'
        + '<span class="wfw-crew">' + (crew.length ? crew.slice(0, 3).map(a => thumb(a, 30, 38, 'wfw-av')).join('') : '<span class="wfw-av none">?</span>') + '</span>'
        + '<span class="wfw-rt"><b class="wfw-rname">' + esc(l.name) + '</b><span class="wfw-rstat">' + esc(stat) + '</span></span>'
        + '<span class="wf-pill' + (r.ready ? ' ok' : '') + '">' + esc(r.ready ? 'READY TO RUN' : 'NEEDS SETUP') + '</span>'
        + (r.ready ? '<button type="button" class="bb refit-primary" data-run="' + esc(l.key) + '">▶ SEND A JOB</button>'
          : '<button type="button" class="bb" data-setup="' + esc(l.key) + '">FINISH SETUP</button>')
        + '</div>';
    }).join('');
    return '<header class="wfw-head"><h2 class="wfw-title">Your workflows</h2><span class="wfw-grow"></span><button type="button" class="bb refit-primary" data-act="new">+ NEW WORKFLOW</button></header>'
      + '<div class="wfw-list">' + rows + '</div>';
  }

  /* NEW WORKFLOW: describe it, or pick a starter — then who does each step, a name, CREATE */
  function newHTML(f) {
    const first = !f.lines.length, pk = S.pick, dr = S.drafting;
    // the Build Library's tile: the line's miniature, its name, one small line; what it is for is its tip (the goal tile's tip quotes
    // the Commander's own words first — the shelf's FOR YOUR GOAL tip). (org D2/D3) the goal tile leads on a row of its own above the
    // four, and its small line is the step count like every tile and like CONVEYORS › LINES — the goal it fits is its tip, never a
    // stat that reads as if it matched the still-empty field above
    const goal = goalStarter();
    const tiles = (goal ? [goal.id] : []).concat(STARTERS).map(id => {
      const bp = bpOf(id); if (!bp) return '';
      const roles = bayRoles(bp), art = lineArt(id), on = pk && pk.bp === id, isGoal = !!goal && goal.id === id, purpose = (words().purpose || {})[id] || '';
      const tip = (isGoal ? '“' + goal.quote + '” — ' + goal.why + '\n' : '') + (purpose ? purpose.charAt(0).toUpperCase() + purpose.slice(1) + '.' : plainName(id));
      // (org D2 polish) the stat names the line's shape, not only its count: a SPLITTER's two steps work side by side, so the goal
      // tile no longer reads '2 steps' like Research + write while its picture draws two parallel bays
      const shape = bp.props.some(p => p.t === 'loop') ? ' · reviewed' : bp.props.some(p => p.t === 'splitter') ? ' · side by side' : '';
      // (org g7 D2, final round) the shelf claims a goal only by NAMING it: the Commander's own words (their dossier goal) ride the
      // heading, so FOR YOUR GOAL never reads as a match for the still-empty 'What should it make?' box above it
      return (isGoal ? '<div class="wfw-tgroup wfw-goalhd" data-tip="Your own words: the goal you told the station. This ready-made workflow has its shape.">FOR YOUR GOAL <span class="wfw-goalq">“' + esc(goal.quote) + '”</span></div>' : '')
        + '<button type="button" class="wfw-tile' + (on ? ' on' : '') + (isGoal ? ' wfw-goal' : '') + '" data-starter="' + esc(id) + '" aria-pressed="' + !!on + '" data-tip="' + esc(tip) + '">'
        + '<span class="wfw-tart">' + (art ? '<img alt="" src="' + art + '">' : '') + '</span><b>' + esc(plainName(id)) + '</b><span class="wfw-tstat">' + roles.length + ' step' + (roles.length === 1 ? '' : 's') + shape + '</span></button>'
        // the four starters under the goal tile get the shelf's second heading, so FOR YOUR GOAL heads only its own tile
        + (isGoal ? '<div class="wfw-tgroup">COMMON WORKFLOWS</div>' : '');
    }).join('');
    let h = '<header class="wfw-head">' + (first ? '' : '<button type="button" class="bb sm" data-act="back">‹ ALL WORKFLOWS</button>')
      + '<h2 class="wfw-title">' + (first ? 'Make your first workflow' : 'New workflow') + '</h2></header>'
      + (first ? '<p class="wfw-lead">A workflow is a line of agents: you send it a job, each step works on it in turn, and the result comes back to you.</p>' : '')
      + '<section class="wfw-sec"><h3>What should it make?</h3>'
      + '<textarea id="wfw-describe" class="wfw-field" rows="2" maxlength="600" placeholder="e.g. a weekly digest of AI news for my newsletter">' + esc(S.draft.describe || '') + '</textarea>'
      + '<div class="wf-row"><button type="button" class="bb refit-primary" data-act="draft"' + (dr && dr.state === 'asking' ? ' disabled' : '') + '>' + (dr && dr.state === 'asking' ? 'SETTING IT UP…' : '✦ SET IT UP FOR ME') + '</button>'
      + '<span class="wfw-note">One short model call picks one of ' + catalogLines().length + ' ready-made workflows and writes its steps.</span></div>'   // (org D11) this page's word, workflows; (org D5 polish) short enough for one line
      + (dr && dr.state === 'error' ? '<p class="wfw-bad">✕ ' + esc(dr.error) + '</p>' : '')
      + '</section>'
      + '<section class="wfw-sec"><h3>Or pick one</h3><div class="wfw-tiles">' + tiles + '</div>'
      + '<div class="wf-row"><button type="button" class="wf-link" data-act="more">More ready-made workflows are in the Build Library ›</button></div></section>';
    if (pk) h += pickedHTML(pk);
    return h;
  }
  function pickedHTML(pk) {
    const bp = bpOf(pk.bp), roles = bayRoles(bp), crew = roster();
    const one = crew.length === 1;
    const stepRows = roles.map((role, i) => {
      const cur = pk.agents[i] || '';
      return '<div class="wfw-pstep"><span class="wfw-pn">' + (i + 1) + ' · ' + esc(role) + '</span>'
        + (crew.length ? '<span class="wfw-agents">' + crew.map(a => '<button type="button" class="wfw-agent' + (a.id === cur ? ' on' : '') + '" data-pick-agent="' + i + '" data-aid="' + esc(a.id) + '" aria-pressed="' + (a.id === cur) + '">'
          + thumb(a.id, 26, 32, 'wfw-av') + '<span>' + esc(String(a.name || a.id).toUpperCase()) + '</span></button>').join('') + '</span>'
          : '<span class="wfw-bad">No agents yet — recruit one from CREW first.</span>')
        + (pk.briefs[role] && pk.briefs[role].does ? '<details class="wf-more wfw-pdoes"><summary>What it does</summary><div class="wf-io">' + esc(pk.briefs[role].does) + '</div></details>' : '')
        + '</div>';
    }).join('');
    return '<section class="wfw-sec wfw-picked" id="wfw-picked"><h3>' + esc(plainName(pk.bp)) + (pk.drafted ? ' <span class="wf-tag">SET UP FOR YOU</span>' : '') + '</h3>'
      + (pk.drafted && pk.usd ? '<p class="wfw-note">Set up by ' + esc(pk.model || 'the station’s model') + ' · ' + usd(pk.usd) + '. Nothing is on the floor until you press CREATE.</p>' : '')
      + '<label class="wfw-k" for="wfw-name">Name</label><input id="wfw-name" class="wfw-field" type="text" maxlength="40" value="' + esc(S.draft.name != null ? S.draft.name : pk.name) + '">'
      + '<div class="wfw-k">Who does each step?' + (one ? ' <span class="wfw-note">— one agent can do every step</span>' : '') + '</div>'
      + stepRows
      + (crew.length > 1 && roles.length > 1 ? '<div class="wf-row"><span class="wfw-note">One agent can do every step:</span>' + crew.slice(0, 4).map(a => '<button type="button" class="bb sm" data-pick-all="' + esc(a.id) + '">GIVE ' + esc(String(a.name || a.id).toUpperCase()) + ' EVERY STEP</button>').join('') + '</div>' : '')
      + (S.made && S.made.error ? '<p class="wfw-bad">✕ ' + esc(S.made.error) + ' Clear some space in Build Mode, then press CREATE again.</p><div class="wf-row"><button type="button" class="bb" data-act="more">OPEN BUILD MODE</button></div>' : '')
      + '<div class="wf-row"><button type="button" class="bb refit-primary" data-act="create"' + (crew.length ? '' : ' disabled') + '>✓ CREATE WORKFLOW</button><span class="wfw-note">It is placed on your floor, ready for jobs.</span></div></section>';
  }

  /* ONE WORKFLOW: its line (the floor's own machines), then — setup, the job box, the job riding, or the job's result */
  function mapHTML(l, workingId) {
    const still = t => (B() && B().machineStill) ? B().machineStill(t) : '';
    const art = (t, aid) => { const u = still(t); return '<span class="wf-nart">' + (u ? '<img class="wf-mthumb" alt="" src="' + u + '">' : '') + (aid ? thumb(aid, 28, 36, 'wf-nthumb') : '') + '</span>'; };
    const join = '<span class="wf-belt"><span class="rail"></span></span>';
    const tiles = ['<span class="wf-node" data-tip="INBOX: you send jobs in here.">' + art('intake') + '<span class="wf-nname">INBOX</span><span class="wf-nmeta">jobs go in</span><span class="dot ok"></span></span>'];
    for (const s of l.steps) {
      const okay = !!s.agentId && s.desk;
      tiles.push('<button type="button" class="wf-node' + (S.step === s.id ? ' sel' : '') + (workingId === s.id ? ' working' : '') + '" data-step="' + esc(s.id) + '" aria-pressed="' + (S.step === s.id) + '" data-tip="' + esc('Step ' + s.n + ((s.label || s.role) ? ' · ' + (s.label || s.role) : '') + (s.agentId ? ' · ' + NAME(s.agentId) : '') + (s.brief ? ': ' + s.brief.slice(0, 220) : '')) + '">'
        + '<span class="wf-nbadge' + (okay ? ' ok' : '') + '">' + s.n + '</span>' + art('bay', s.agentId)
        + '<span class="wf-nname">' + esc(s.label || s.role || 'STEP ' + s.n) + '</span><span class="wf-nmeta' + (okay ? '' : ' warn') + '">' + esc(!s.agentId ? 'needs an agent' : !s.desk ? 'needs a desk' : NAME(s.agentId)) + '</span><span class="dot' + (okay ? ' ok' : '') + '"></span></button>');
    }
    tiles.push('<span class="wf-node" data-tip="OUTBOX: the finished result lands here.">' + art('outbox') + '<span class="wf-nname">OUTBOX</span><span class="wf-nmeta">' + esc((l.sendNames || []).length ? 'sends on to ' + l.sendNames.join(' / ') : 'results out') + '</span><span class="dot ok"></span></span>');
    return '<div class="wfw-mapwrap"><div class="wf-strip wfw-map' + (l.ready.ready ? ' live' : '') + '">' + tiles.join(join) + '</div></div>';
  }
  // a step, opened: who does it (one click changes it) and what it does (edited in the full editor)
  function stepHTML(l, s) {
    const crew = roster();
    return '<section class="wfw-sec wfw-stepbox"><h3>Step ' + s.n + ((s.label || s.role) ? ' · ' + esc(s.label || s.role) : '') + '</h3>'
      + '<div class="wfw-k">Who does it?</div><div class="wfw-agents">' + crew.map(a => '<button type="button" class="wfw-agent' + (a.id === s.agentId ? ' on' : '') + '" data-assign="' + esc(s.id) + '" data-aid="' + esc(a.id) + '" aria-pressed="' + (a.id === s.agentId) + '">'
        + thumb(a.id, 26, 32, 'wfw-av') + '<span>' + esc(String(a.name || a.id).toUpperCase()) + '</span></button>').join('') + '</div>'
      + (s.agentId && !s.desk ? '<div class="wf-row"><span class="wfw-bad">' + esc(NAME(s.agentId)) + ' needs a desk to work this step.</span><button type="button" class="bb sm refit-primary" data-desk="' + esc(s.id) + '">⊕ GIVE ' + esc(NAME(s.agentId)) + ' A DESK</button></div>' : '')
      + '<div class="wfw-k">What it does</div><div class="wf-io wfw-does">' + esc(s.brief || '(no instructions — it does what the job asks)') + '</div>'
      + '<div class="wf-row"><span class="wfw-note">Change a step’s instructions with NEEDS CHANGES under a result, or in</span><button type="button" class="wf-link" data-act="edit">EDIT WORKFLOW</button></div></section>';
  }
  function setupHTML(l) {
    const crew = roster(), items = [];
    const missing = l.steps.filter(s => !s.agentId);
    for (const s of missing) items.push('<div class="wfw-fixrow"><div class="wfw-fixh">Who does step ' + s.n + ((s.label || s.role) ? ' · ' + esc(s.label || s.role) : '') + '?</div><div class="wfw-agents">'
      + (crew.length ? crew.map(a => '<button type="button" class="wfw-agent" data-assign="' + esc(s.id) + '" data-aid="' + esc(a.id) + '">' + thumb(a.id, 26, 32, 'wfw-av') + '<span>' + esc(String(a.name || a.id).toUpperCase()) + '</span></button>').join('')
        : '<span class="wfw-bad">No agents yet — recruit one from CREW first.</span>') + '</div></div>');
    for (const s of l.steps.filter(s => s.agentId && !s.desk)) items.push('<div class="wfw-fixrow"><div class="wfw-fixh">' + esc(NAME(s.agentId)) + ' needs a desk to work step ' + s.n + '.</div><div class="wf-row"><button type="button" class="bb sm refit-primary" data-desk="' + esc(s.id) + '">⊕ GIVE ' + esc(NAME(s.agentId)) + ' A DESK</button></div></div>');
    const handled = /needs an agent|needs a workstation/;
    for (const b of l.ready.blocking.filter(b => !handled.test(b.what))) items.push('<div class="wfw-fixrow"><div class="wfw-fixh">' + esc(b.what.charAt(0).toUpperCase() + b.what.slice(1)) + '</div><div class="wf-row"><button type="button" class="bb sm" data-act="edit">FIX IT IN THE EDITOR</button></div></div>');
    return '<section class="wfw-sec wfw-setup"><h3>Finish setting it up</h3><p class="wfw-note">' + (l.ready.blocking.length === 1 ? 'One thing' : l.ready.blocking.length + ' things') + ' before it can take a job:</p>'
      + (missing.length > 1 && crew.length ? '<div class="wf-row">' + crew.slice(0, 4).map(a => '<button type="button" class="bb sm" data-assign-all="' + esc(a.id) + '">GIVE ' + esc(String(a.name || a.id).toUpperCase()) + ' EVERY STEP</button>').join('') + '</div>' : '')
      + items.join('') + '</section>';
  }
  function jobRows(l) {
    const rows = jobsOf(l.key).slice(0, 8);
    if (S.jobsErr && !rows.length) return '<p class="wfw-note">The job history could not be read — is the station running?</p>';
    /* (org P15) a scheduled, channel, folder or webhook run is not a job record yet (only a job you send and a SEND TO hand-off write one:
       the sample route and the handoff runner — trigger-runner.js never does): say where it is filed, never an empty "nothing ran" (org wire AUTO-P15-3) */
    if (!rows.length) return '<p class="wfw-note">No jobs yet. Jobs you send show here; scheduled, channel, folder and webhook runs are filed in DELIVERABLES.</p>';
    const mark = s => ({ delivered: '<span class="wfw-st ok">✓ DELIVERED</span>', running: '<span class="wfw-st run">RUNNING</span>', stopped: '<span class="wfw-st">STOPPED</span>',
      problem: '<span class="wfw-st warn">⚠ PROBLEM</span>', failed: '<span class="wfw-st warn">DIDN’T RUN</span>', interrupted: '<span class="wfw-st warn">INTERRUPTED</span>' })[s] || '';
    // a handed-on job reads as FROM LINE A · the job (its text is the job as it first arrived); a standing refusal says ×N
    // (an older record held the hand-off frame as its text: read the job back out of it)
    const jobOf = j => { const h = j.from && !j.handedIn && P() && P().parseHandoffInput ? P().parseHandoffInput(j.text) : null; return h && h.original ? h.original : String(j.text || ''); };
    const said = j => (j.from ? 'FROM ' + lineWord(j.from) + ' · ' : '') + jobOf(j).replace(/\s+/g, ' ');
    const markOf = j => j.repeats > 1 ? mark(j.status).replace('</span>', ' ×' + esc(j.repeats) + '</span>') : mark(j.status);
    return '<div class="wfw-jobs">' + rows.map(j => '<button type="button" class="wfw-jobrow" data-job="' + esc(j.id) + '">' + markOf(j) + '<span class="wfw-jtext">' + esc(said(j).slice(0, 120) || '(no text)') + '</span><span class="wfw-jmeta">' + esc(ago(j.startedAt) + (j.usd ? ' · ' + usd(j.usd) : '')) + '</span></button>').join('') + '</div>';
  }
  function composeHTML(l) {
    // one job runs at a time (the station's rule): the one this window sent counts before the server's list shows it
    const busy = runningJob() || (S.out ? { line: S.out.line, name: (lineOf(floor(), S.out.line) || {}).name } : null), other = busy && busy.line !== l.key;
    return '<section class="wfw-sec wfw-send"><h3>Send a job</h3>'
      + '<textarea id="wfw-job" class="wfw-field" rows="3" maxlength="2000" aria-label="The job for this workflow" placeholder="' + esc(exampleJob(l)) + '">' + esc(S.draft['job:' + l.key] || '') + '</textarea>'
      + '<div class="wf-row"><button type="button" class="bb refit-primary" data-act="send"' + (busy ? ' disabled' : '') + '>▶ SEND A JOB</button>'
      + '<span class="wfw-note">' + (other ? 'Another workflow (' + esc(busy.name || 'a line') + ') is working on a job — one job runs at a time.' : 'Real agents do the work, at real cost. The result comes back here, lands in this line’s OUTBOX and is also filed in DELIVERABLES.' + ((l.sendNames || []).length ? ' Then it ' + (l.sendsAll ? 'rides on' : 'can ride on') + ' to ' + esc(l.sendNames.join(' / ')) + ' — its crew, at its cost.' : '')) + '</span></div>'
      + (S.msg ? '<p class="' + (S.msg.bad ? 'wfw-bad' : 'wfw-okline') + '">' + (S.msg.bad ? '✕ ' : '') + esc(S.msg.text) + '</p>' : '')
      + '</section>' + startsHTML(l) + '<section class="wfw-sec"><h3>Last jobs</h3>' + jobRows(l) + '</section>';
  }
  /* WHAT STARTS IT (org P15, 2026-10-14): one read-only line — WorkflowLine.lineStarts over the server answers World's feed poll
     read (GET /api/cron, /api/routing/triggers, /api/channels/status): the same composition the Workflow panel, BUILD MODE's
     finish card and the lead's station.layout read, so the four never disagree. A schedule saved while scheduling is off is said
     as off, never as a start. ⊕ MAKE IT AUTOMATIC opens the ONE place starts are made (EDIT WORKFLOW › INBOX › Or start it
     automatically) — never a second trigger editor here; working folder and LINE BUDGET stay there too. */
  function startsText(l) {
    const read = (typeof World !== 'undefined' && World.startFacts) ? World.startFacts() : null;
    // a read that was tried and came back with nothing is UNREAD (every fact unknown), never 'checking…' forever
    const Wl = W(), facts = read || (S.startsPolled ? { chans: null, cron: null, lt: null } : null);
    if (!Wl || !Wl.lineStarts || !l.flow || !facts) return null;
    const human = d => { const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
      return (typeof CronHuman !== 'undefined' && CronHuman.describeDisplay) ? CronHuman.describeDisplay(d, { tz }) : String(d == null ? '' : d); };
    let st;
    try { st = Wl.lineStarts(l.flow, { lt: facts.lt, lineKey: l.key, cron: facts.cron, chans: facts.chans, agents: roster(), human }); } catch (e) { return null; }
    // another line's SEND TO starts this one too (the panel's '✓ FED — LINE A sends its finished work here'; BUILD's FED BY)
    const fed = (l.senderNames || []).map(n => 'when ' + n + ' sends its finished work');
    const auto = [].concat(st.schedules || [], (st.channels || []).map(c => 'when a ' + c + ' message arrives'), st.events || [], fed);
    // a schedule the E-STOP holds is named as the E-STOP (the /cron line and the Workflow panel say 'stopped (E-STOP)'), never as an OFF switch
    const offWhy = facts.cron && facts.cron.halted ? ' (stopped by E-STOP)' : ' (scheduling is off)';
    // …and a folder/webhook trigger or a channel the server holds back (E-STOP, the day cap, not connected) is a start, held, with its reason
    const off = (st.offSchedules || []).map(s => s + offWhy).concat(st.held || []);
    // World keeps a fact only once its endpoint has answered: a fact never read is UNKNOWN, so 'by hand only' would be a claim it can't prove
    const unread = [facts.cron ? '' : 'schedules', facts.chans ? '' : 'channels', facts.lt ? '' : 'folder/webhook triggers'].filter(Boolean);
    const unknown = unread.length ? ' · ' + unread.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' could not be read' : '';
    if (!auto.length && !off.length) return unknown ? 'by hand' + unknown : 'by hand only';
    return ['by hand'].concat(auto, off).join(' · ') + unknown;
  }
  function startsHTML(l) {
    const t = startsText(l);
    // a line that already has a start (on or off) is not offered MAKE IT AUTOMATIC beside it — the key says it changes the starts
    const started = !!t && t.split(' · ').slice(1).some(p => !/could not be read$/.test(p));
    // each start is an alternative, so the line SAYS 'or' ('by hand or every day at 9:00 AM' — a ' · ' read as 'by hand every day');
    // what could not be read stays a separate ' · ' note after them (startsText keeps its composed form for the panel and tests)
    const said = t == null ? 'checking…' : (parts => parts.filter(p => !/could not be read$/.test(p)).join(' or ')
      + parts.filter(p => /could not be read$/.test(p)).map(p => ' · ' + p).join(''))(t.split(' · '));
    return '<section class="wfw-sec wfw-starts"><div class="wf-row"><span class="wfw-k">STARTS:</span><span class="wfw-startsv">' + esc(said) + '</span>'
      + (started
        ? '<button type="button" class="bb sm" data-act="automatic" data-tip="Opens EDIT WORKFLOW at its INBOX’s ‘Or start it automatically’: change these starts, or add a schedule, a channel message, a folder or a webhook.">⊕ CHANGE STARTS</button>'
        : '<button type="button" class="bb sm" data-act="automatic" data-tip="Opens EDIT WORKFLOW at its INBOX’s ‘Or start it automatically’: a schedule, a channel message, a folder or a webhook.">⊕ MAKE IT AUTOMATIC</button>')
      + '</div></section>';
  }
  function runningHTML(l, rec) {
    const text = S.out ? S.out.text : (rec && rec.text) || '';
    const now = liveNow(l);
    const mine = !!S.out;
    return '<section class="wfw-sec wfw-run"><h3>Working on it</h3><div class="wfw-you"><span class="wfw-k">You sent</span><div class="wfw-quote">' + esc(text) + '</div></div>'
      + '<p class="wfw-live" id="wfw-live" role="status">' + esc(now.text) + '</p>'
      + '<div class="wf-row"><button type="button" class="bb" data-act="stop"' + ((mine && (S.out.phase !== 'run' || S.out.stopping)) ? ' disabled' : '') + '>' + (mine && S.out.stopping ? 'STOPPING…' : '■ STOP') + '</button>'
      + '<span class="wfw-note">The result shows here when the last step is done. You can close this window — the job keeps going.</span></div></section>';
  }
  /* a job another line handed on, working right now (SEND TO): the job as it first arrived and where it came from — never "You
     sent", never the sample's STOP (it is not the sample: E-STOP stops it); this line can still be sent a job of its own */
  function handoffRunningHTML(l, rec) {
    return '<section class="wfw-sec wfw-run wfw-hrun"><h3>Working on a job from ' + esc(lineWord(rec.from)) + '</h3>'
      + '<p class="wfw-why wfw-from">' + esc(lineWord(rec.from)) + ' finished its part and sent its result on — this line’s crew is working on it now.'
      + (rec.from.jobId ? ' <button type="button" class="wf-link" data-job="' + esc(rec.from.jobId) + '">OPEN ITS JOB</button>' : '') + '</p>'
      + '<div class="wfw-you"><span class="wfw-k">The job</span><div class="wfw-quote">' + esc(rec.text || '') + '</div></div>'
      + '<p class="wfw-note">The result lands in LAST JOBS and this line’s OUTBOX. E-STOP stops it.</p></section>';
  }
  function resultHTML(l, job) {
    const st = stationOf(), runs = (job.runs || []).slice().reverse(), work = workOf(job.output), ok = job.status === 'delivered';
    const delivered = ok && (job.runs || [])[0];
    // the TO REVIEW row this delivered run still waits on (ReturnStore's ledger) — none once it was rated, or if it was never folded
    const waitRow = delivered && delivered.runId && typeof ReturnStore !== 'undefined' && ReturnStore.pendingRows ? (ReturnStore.pendingRows().find(r => r && r.runId === delivered.runId) || null) : null, waits = !!waitRow;
    // (a refusal counted on one record spans the refusals, not a run: no "took")
    const took = job.endedAt && job.startedAt && !(job.repeats > 1) ? secs(job.endedAt - job.startedAt) : '';
    const bad = runs.find(r => r.reason && r.reason !== 'done');
    // a hand-off the station REFUSED (SEND TO): the line above this says "it was not sent on", so the reason is shown bare — never
    // "not sent on: … — nothing was sent on" after it (wave 2 review, conveyor-backend-09)
    const wasRefused = !!(job.from && job.status === 'failed' && /^not sent on:/.test(String(job.error || '')));
    // a stored reason is a bare clause ("the station hit an internal fault and stopped this job"): the card says it as a sentence
    // (wave 2 repair — the stopped and failed branches opened their paragraph in lowercase)
    const sentence = (t, empty) => { t = String(t == null ? '' : t).trim().replace(/[.\s]+$/, ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) + '.' : empty; };
    const refusedWhy = () => sentence(String(job.error).replace(/^not sent on:\s*/, ''), 'Nothing ran.');
    const END ={ empty: 'gave no final answer', error: 'hit an error', max_iters: 'ran out of turns', budget: 'hit the spending cap', refusal: 'refused the work', interrupted: 'was interrupted', stopped: 'was stopped' };
    const head = ok ? '<b class="ok">✓ DELIVERED</b>' : job.status === 'stopped' ? '<b>■ STOPPED</b>' : job.status === 'interrupted' ? '<b class="warn">⚠ INTERRUPTED</b>' : job.status === 'failed' ? '<b class="warn">✕ IT DIDN’T RUN</b>' : '<b class="warn">⚠ FINISHED WITH A PROBLEM</b>';
    const meta = [runs.length + ' step' + (runs.length === 1 ? '' : 's'), usd(job.usd), took].filter(Boolean).join(' · ');
    // a step goes by its NAME first, then its role — the map's word for it (conveyor-ui-15)
    const why = ok ? '' : job.status === 'problem' && bad ? (() => { const p = bad.dockId && st ? st.propById(bad.dockId) : null, nm = p && (p.label || p.role); return 'The ' + (nm ? nm + ' step' : 'step') + ' (' + NAME(bad.agentId) + ') ' + (END[bad.reason] || String(bad.reason || 'did not finish').replace(/_/g, ' ')) + ', so this job did not finish cleanly. Sending it again often works.'; })()
      // (a stopped record says WHO stopped it — "you stopped this job", E-STOP, or the station's own fault — never "You stopped" for all)
      : job.status === 'stopped' ? sentence(job.error, 'You stopped this job.') + ' What already ran is counted.' : job.status === 'interrupted' ? 'The station stopped while this job was out. Send it again.'
      : (wasRefused ? refusedWhy() : sentence(job.error, 'Nothing ran.')) + (job.repeats > 1 ? ' (' + job.repeats + ' hand-offs from ' + lineWord(job.from) + ' were refused like this — the last ' + ago(job.endedAt) + ')' : '');
    const passes = {};
    const steps = runs.map((r, i) => {
      const p = r.dockId && st ? st.propById(r.dockId) : null, k = r.dockId || r.agentId, pass = passes[k] = (passes[k] || 0) + 1, got = S.stepOut[r.runId];
      const txt = !got || got === 'loading' ? 'reading…' : got.err ? '⚠ ' + got.err : (got.output || 'this step replied with nothing');
      return '<details class="wf-more wf-step-out"><summary><span>' + (i + 1) + ' · ' + esc(((p && (p.label || p.role)) ? (p.label || p.role) + ' · ' : '') + NAME(r.agentId) + (pass > 1 ? ' · pass ' + pass : '')) + '</span><span class="src' + (r.reason !== 'done' ? ' warn' : '') + '">' + (r.reason !== 'done' ? esc(END[r.reason] || r.reason) + ' · ' : '') + usd(r.usd) + '</span></summary>'
        + '<div class="wf-io"' + (got && got.output ? ' data-md data-md-src="' + esc(got.output) + '"' : '') + '>' + esc(txt) + '</div></details>';
    }).join('');
    const prev = S.prev[job.id];
    const kept = ok && styleKept(job);
    const changes = (job.notes || []).map(n => '<li>' + esc(n.kind === 'fix' ? 'You changed the ' + (n.role || 'step') + ' step’s ' + (n.field === 'hands' ? 'hand-off' : 'instructions') + (n.why ? ' — ' + n.why : '')
      : n.kind === 'example' ? 'You kept this result’s style for the ' + (n.role || 'last') + ' step' : 'You put the ' + (n.role || 'step') + ' step back the way it was') + ' · ' + ago(n.at) + '</li>').join('');
    // SEND TO (2026-10-10): where this job came from / went on to — each line's result stays its own, the two records point at each other.
    // (10-11) A REFUSED hand-off is said as NOT sent on, with why — never "sent on" for work the station did not send. A handed-on
    // job's record keeps the job as it first arrived (`text`) and what the sending line handed in (`handedIn`) apart.
    const hin = !job.from ? null : (typeof job.handedIn === 'string' && job.handedIn) ? { original: job.text, output: job.handedIn }
      : (typeof Pipeline !== 'undefined' && Pipeline.parseHandoffInput) ? Pipeline.parseHandoffInput(job.text) : null;
    const prov =(job.from ? '<p class="wfw-why wfw-from">' + (wasRefused ? esc(lineWord(job.from)) + ' tried to send its result on to this line — it was not sent on, so nothing ran here.' : 'From ' + esc(lineWord(job.from)) + ' — that line finished its part and sent its result on to this one.')
        + (job.from.jobId ? ' <button type="button" class="wf-link" data-job="' + esc(job.from.jobId) + '">OPEN ITS JOB</button>' : '') + '</p>' : '')
      + (job.sentTo ? (job.sentTo.refused ? '<p class="wfw-why wfw-sent warn">NOT sent on to ' + esc(lineWord(job.sentTo)) + ' — ' + esc(job.sentTo.refused) + '.'
          : '<p class="wfw-why wfw-sent">Sent on to ' + esc(lineWord(job.sentTo)) + ' — that line works on this result next.')
        + (job.sentTo.jobId ? ' <button type="button" class="wf-link" data-job="' + esc(job.sentTo.jobId) + '">OPEN ITS JOB</button>' : '') + '</p>' : '');
    /* (org P14, final round) a delivered job still waiting for its verdict is rated RIGHT HERE: the same rate control TO REVIEW mounts
       sits under the result, so rating it here clears it there too (Chat.awayRate + ReturnStore.resolve, exactly as windows/outbox.js
       does). This is the view a floor OUTBOX click opens, so it never links on to DELIVERABLES (Andrew 10-03: "the outbox should only
       show output of the specific conveyor system, it should never link back to deliverables") — the result is filed there as well,
       but the OUTBOX's page holds only this line's work. */
    let h = '<section class="wfw-sec wfw-result"><div class="wfw-rhead">' + head + '<span class="wfw-rmeta">' + esc(meta) + '</span></div>'
      + prov
      + (why ? '<p class="wfw-why">' + esc(why) + '</p>' : '')
      + work.notes.map(t => '<p class="wfw-why">⚠ ' + esc(t) + '</p>').join('')
      // a handed-on job: the job as it first arrived (what the Commander asked), and what the sending line handed in beside it
      + (hin ? '<div class="wfw-you"><span class="wfw-k">The job</span><div class="wfw-quote">' + esc(hin.original || job.text) + '</div></div>'
          + '<details class="wf-more wfw-handedin"><summary>What ' + esc(lineWord(job.from)) + ' handed in</summary><div class="wf-io" data-md data-md-src="' + esc(hin.output || '(nothing)') + '">' + esc(hin.output || '(nothing)') + '</div></details>'
        : '<div class="wfw-you"><span class="wfw-k">You asked</span><div class="wfw-quote">' + esc(job.text) + '</div></div>')
      + (ok || work.rest ? '<div class="wfw-k">' + (ok ? 'The result' : 'What came out') + '</div><div class="wf-io out wfw-out" data-md data-md-src="' + esc(work.rest || '(the line delivered an empty reply)') + '">' + esc(work.rest || '(the line delivered an empty reply)') + '</div>' : '')
      + '<div class="wf-row wfw-acts">'
      + (ok || work.rest ? '<button type="button" class="bb' + (S.fix && S.fix.jobId === job.id && S.fix.open ? ' active' : '') + '" data-act="needs" aria-expanded="' + !!(S.fix && S.fix.jobId === job.id && S.fix.open) + '">✎ NEEDS CHANGES</button>' : '')
      + (ok ? (kept ? '<button type="button" class="bb" data-act="unkeep" data-tip="The last step stops copying this result’s format, length and tone, and the crew forgets its style.">★ STYLE KEPT · PUT IT BACK</button>'
        : '<button type="button" class="bb" data-act="keep" data-tip="The step that wrote this result will match its format, length and tone every time, and the whole crew matches its style in similar work.">★ KEEP THIS STYLE</button>') : '')
      // a handed-on job is never re-sent from here: its input is what the sending line delivered, and only that line sends it on
      + (job.from ? '' : '<button type="button" class="bb refit-primary" data-act="again"' + (runningJob() ? ' disabled' : '') + '>↻ SEND IT AGAIN</button>')
      + '<button type="button" class="bb" data-act="newjob">+ NEW JOB</button>'
      + (job.from ? '<span class="wfw-note">To run it again, send ' + esc(lineWord(job.from)) + '’s job again — it hands its result on to this line.</span>' : '') + '</div>'
      + (waits ? '<div class="wfw-rate" data-rate-for="' + esc(waitRow.runId) + '"></div>' : '')
      + (S.fix && S.fix.jobId === job.id && S.fix.open ? fixHTML(job, l) : '')
      + (prev ? '<details class="wf-more wfw-last"><summary>' + ((prev.notes || []).some(n => n.kind === 'fix' || n.kind === 'example') ? 'Last time, before your change' : 'Last time') + '</summary><div class="wf-io" data-md data-md-src="' + esc(workOf(prev.output).rest || '(empty)') + '">' + esc(workOf(prev.output).rest || '(empty)') + '</div></details>' : '')
      + (runs.length ? '<details class="wf-more wfw-steps"><summary>How each step did it</summary><div class="wf-steps">' + steps + '</div></details>' : '')
      + (changes ? '<details class="wf-more"><summary>What you changed after this job</summary><ul class="wfw-changes">' + changes + '</ul></details>' : '')
      + '</section>';
    return h;
  }
  // the rating TO REVIEW asks for, mounted into the delivered result's host (resultHTML draws it only while its run waits there)
  function mountRate() {
    const host = body && body.querySelector('.wfw-rate[data-rate-for]'); if (!host) return;
    const id = host.dataset.rateFor, rw = typeof ReturnStore !== 'undefined' && ReturnStore.pendingRows ? ReturnStore.pendingRows().find(r => r && r.runId === id) : null;
    if (!rw) { host.remove(); return; }
    const clear = () => { if (typeof ReturnStore !== 'undefined' && ReturnStore.resolve) ReturnStore.resolve(rw.runId, 'workflows'); schedule(); };   // (ReturnStore repaints TO REVIEW; this window repaints itself)
    const mounted = (typeof Chat !== 'undefined' && Chat.awayRate) ? Chat.awayRate(host, rw, clear) : false;
    if (!mounted) {   // already judged this session: the plain collect, so the job never waits in TO REVIEW forever
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bb sm'; b.textContent = '✓ MARK REVIEWED';
      b.addEventListener('click', ev => { ev.stopPropagation(); clear(); });
      host.appendChild(b);
    }
  }
  function fixHTML(job, l) {
    const fx = S.fix, asking = fx.state === 'asking';
    let h = '<div class="wfw-fix"><div class="wfw-k">What’s wrong with it?</div>'
      + '<textarea id="wfw-fix-in" class="wfw-field" rows="2" maxlength="1200" placeholder="e.g. too long, no sources, the wrong tone, it missed the main point">' + esc(S.draft['fix:' + job.id] != null ? S.draft['fix:' + job.id] : (fx.complaint || '')) + '</textarea>'
      + '<div class="wf-row"><button type="button" class="bb refit-primary" data-act="suggest"' + (asking ? ' disabled' : '') + '>' + (asking ? 'THINKING…' : 'SUGGEST CHANGES') + '</button><span class="wfw-note">The station reads each step and what it produced, and suggests exact changes. Nothing changes until you use one.</span></div>';
    if (fx.state === 'error') h += '<p class="wfw-bad">✕ ' + esc(fx.error) + '</p>';
    if (fx.state === 'done') {
      const st = stationOf();
      h += '<div class="wfw-fixes" data-fixes>' + (fx.diagnosis ? '<p class="wfw-why">' + esc(fx.diagnosis) + '</p>' : '') + fx.fixes.map((x, i) => {
        const p = (st && st.propById(x.dockId)) || {}, inUse = fixInUse(x), n = l ? l.steps.findIndex(s => s.id === x.dockId) + 1 : 0;
        return '<div class="wf-fix' + (inUse ? ' applied' : '') + '"><div class="wf-fix-h"><b>' + esc((n > 0 ? 'STEP ' + n + ' · ' : '') + (p.label || p.role || 'STEP') + (p.agentId ? ' · ' + NAME(p.agentId) : '')) + '</b>' + (inUse ? '<span class="wf-tag">IN USE</span>' : '') + '</div>'
          + (x.why ? '<p class="wfw-why">' + esc(x.why) + '</p>' : '')
          + (x.does != null ? '<div class="wfw-k">New instructions</div><div class="wf-io edited">' + esc(x.does) + '</div><details class="wf-more"><summary>What it said before</summary><div class="wf-io">' + esc(x.was || '(no instructions)') + '</div></details>' : '')
          + (x.hands != null ? '<div class="wfw-k">New hand-off</div><div class="wf-io edited">' + esc(x.hands) + '</div>' : '')
          + '<div class="wf-row">' + (inUse ? '<button type="button" class="bb sm" data-fix-back="' + i + '">PUT IT BACK</button>' : '<button type="button" class="bb sm refit-primary" data-fix-use="' + i + '">✓ USE THIS</button>') + '</div></div>';
      }).join('')
        + '<div class="wf-row">' + (job.from ? '' : '<button type="button" class="bb' + (fx.fixes.some(fixInUse) ? ' refit-primary' : '') + '" data-act="rerun"' + (runningJob() ? ' disabled' : '') + '>↻ SEND IT AGAIN</button>')
        + '<span class="wfw-note">Suggested by ' + esc(fx.model || 'the station’s model') + (fx.usd ? ' · ' + usd(fx.usd) : '') + '.</span></div></div>';
    }
    return h + '</div>';
  }
  function lineHTML(f, l) {
    const rec = S.out && S.out.line === l.key ? null : (runningJob() && runningJob().line === l.key ? runningJob() : null);
    const riding = (S.out && S.out.line === l.key) || !!rec;
    const workingId = riding ? liveNow(l).id : null;
    const step = S.step ? l.steps.find(s => s.id === S.step) : null;
    let main;
    if (!l.ready.ready && !riding) main = setupHTML(l);
    else if (riding) main = runningHTML(l, rec);
    else if (S.job && S.job.line === l.key) main = resultHTML(l, S.job);
    else main = (runningHandoff(l.key) ? handoffRunningHTML(l, runningHandoff(l.key)) : '') + composeHTML(l);
    return '<header class="wfw-head"><button type="button" class="bb sm" data-act="back">‹ ALL WORKFLOWS</button><h2 class="wfw-title">' + esc(l.name) + '</h2>'
      + '<span class="wf-pill' + (l.ready.ready ? ' ok' : '') + '">' + esc(l.ready.ready ? 'READY TO RUN' : 'NEEDS SETUP') + '</span><span class="wfw-grow"></span>'
      + '<button type="button" class="bb sm" data-act="edit" data-tip="The full editor: the line on the floor, each step’s instructions, what starts it automatically, its budget.">EDIT WORKFLOW</button></header>'
      + mapHTML(l, workingId) + (step ? stepHTML(l, step) : '') + main;
  }

  /* ---------- wiring ---------- */
  function wire(f) {
    const on = (q, fn) => body.querySelectorAll(q).forEach(n => { n.onclick = ev => { ev.stopPropagation(); fn(n, ev); }; });
    const line = () => lineOf(floor(), S.line);
    // drafts: whatever is typed is kept, so a repaint never loses it
    body.querySelectorAll('#wfw-job,#wfw-fix-in,#wfw-describe,#wfw-name').forEach(n => n.addEventListener('input', () => {
      const k = n.id === 'wfw-job' ? 'job:' + S.line : n.id === 'wfw-fix-in' ? 'fix:' + (S.job && S.job.id) : n.id === 'wfw-describe' ? 'describe' : 'name';
      S.draft[k] = n.value;
    }));
    const job = body.querySelector('#wfw-job');
    if (job) job.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); const b = body.querySelector('[data-act="send"]'); if (b && !b.disabled) b.click(); } });
    on('.wfw-row[data-line]', n => { sfx('click'); openLine(n.dataset.line); });
    body.querySelectorAll('.wfw-row[data-line]').forEach(n => n.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLine(n.dataset.line); } }));
    on('[data-run]', n => { sfx('click'); openLine(n.dataset.run); focusIn('#wfw-job'); });
    on('[data-setup]', n => { sfx('click'); openLine(n.dataset.setup); });
    on('[data-act="new"]', () => { sfx('click'); S.view = 'new'; S.pick = null; S.drafting = null; S.made = null; paint(); focusIn('#wfw-describe'); });
    on('[data-act="back"]', () => { sfx('click'); S.view = 'list'; S.job = null; S.step = null; S.msg = null; S.pick = null; paint(); });
    on('[data-act="more"]', () => { sfx('click'); if (B() && B().openWorkflows) B().openWorkflows(); });
    on('[data-act="edit"]', () => { const l = line(); if (!l) return; sfx('click'); if (B() && B().editLine) B().editLine(l.intakeId); });
    // ⊕ MAKE IT AUTOMATIC (org P15): the full editor on this line's INBOX, scrolled to 'Or start it automatically'
    on('[data-act="automatic"]', () => {
      const l = line(); if (!l) return; sfx('click');
      if (!(B() && B().editLine && B().editLine(l.intakeId))) return;
      if (typeof WorkflowPanel !== 'undefined' && WorkflowPanel.revealStarts) setTimeout(() => { try { WorkflowPanel.revealStarts(); } catch (e) { /* the editor is open on the INBOX either way */ } }, 0);
    });
    on('[data-starter]', n => pickStarter(n.dataset.starter));
    on('[data-act="draft"]', () => draftIt(String(S.draft.describe || '').trim()));
    on('[data-pick-agent]', n => { if (!S.pick) return; S.pick.agents[+n.dataset.pickAgent] = n.dataset.aid; sfx('click'); schedule(); });
    on('[data-pick-all]', n => { if (!S.pick) return; S.pick.agents = S.pick.agents.map(() => n.dataset.pickAll); sfx('click'); schedule(); });
    on('[data-act="create"]', () => create());
    on('.wfw-map .wf-node[data-step]', n => { sfx('click'); S.step = S.step === n.dataset.step ? null : n.dataset.step; schedule(); });
    on('[data-assign]', n => assign(n.dataset.assign, n.dataset.aid));
    on('[data-assign-all]', n => { const l = line(); if (l) assignAll(l, n.dataset.assignAll); });
    on('[data-desk]', n => { const l = line(); const s = l && l.steps.find(x => x.id === n.dataset.desk); if (s) giveDesk(s); });
    on('[data-act="send"]', () => {
      const l = line(), n = body.querySelector('#wfw-job'); if (!l || !n) return;
      const t = n.value.trim();
      if (!t) { sfx('bad'); notify('write the job first — what should this workflow work on?', 'warn'); n.focus(); return; }
      n.blur(); S.draft['job:' + l.key] = n.value; send(l, t, null);
    });
    on('[data-act="stop"]', () => stop());
    on('[data-job]', n => { sfx('click'); showJob(n.dataset.job); });
    on('[data-act="newjob"]', () => { sfx('click'); S.job = null; S.fix = null; S.msg = null; paint(); focusIn('#wfw-job'); });
    on('[data-act="again"]', () => { const l = line(); if (!l || !S.job || S.job.from) return; S.draft['job:' + l.key] = S.job.text; send(l, S.job.text, S.job.id); });
    on('[data-act="rerun"]', () => { const l = line(); if (!l || !S.job || S.job.from) return; send(l, S.job.text, S.job.id); });
    on('[data-act="needs"]', () => { if (!S.job) return; sfx('click'); if (S.fix && S.fix.jobId === S.job.id) S.fix.open = !S.fix.open; else S.fix = { jobId: S.job.id, open: true, state: 'idle', fixes: [] }; paint(); if (S.fix.open) focusIn('#wfw-fix-in'); });
    on('[data-act="suggest"]', () => { if (!S.job) return; askFixes(S.job, line(), String(S.draft['fix:' + S.job.id] || '').trim()); });
    on('[data-fix-use]', n => { if (S.job) useFix(S.job, +n.dataset.fixUse, false); });
    on('[data-fix-back]', n => { if (S.job) useFix(S.job, +n.dataset.fixBack, true); });
    on('[data-act="keep"]', () => { if (S.job) keepStyle(S.job); });
    on('[data-act="unkeep"]', () => { if (S.job) putStyleBack(S.job); });
    mountRate();
    // each step's reply, read when its row is opened (and the result's own words drawn as COMMS draws them)
    body.querySelectorAll('.wfw-steps').forEach(d => d.addEventListener('toggle', () => { if (d.open && S.job) (S.job.runs || []).forEach(r => readStep(r, S.job.streamId)); }));
  }
  function openLine(key) {
    S.view = 'line'; S.line = key; S.job = null; S.fix = null; S.msg = null; S.step = null;
    paint();
    pollStarts();
    const sc = body && (body.closest('.term-body') || body); if (sc) sc.scrollTop = 0;
  }
  function stopTimers() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    watchedStation = null;
  }

  /* ---------- the window ---------- */
  // the floor changes (a step re-crewed in REFIT, a line placed or removed): the window repaints with it
  let watchedStation = null;
  function attachFloor() {
    const st = stationOf();
    if (!st || st === watchedStation || typeof st.onChange !== 'function') return;
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    watchedStation = st;
    unsub = st.onChange(() => { if (!alive()) return stopTimers(); schedule(); });
  }
  function build(el) {
    body = el;
    watchedStation = null; attachFloor();
    paint();
    loadJobs();
    if (S.view === 'line') pollStarts();
  }
  function open(view, from) {
    const ui = UI(); if (!ui || !ui.openTerm) return;
    if (view) Object.assign(S, view);
    if (alive()) paint();
    if (S.view === 'line') pollStarts();
    // from another work window (the OUTBOX): that window steps aside and this one keeps a ‹ back to it (StationUI.navigateWork)
    const h = H();
    if (from && h && h.navigateWork) h.navigateWork(from, 'workflows'); else ui.openTerm('workflows');
    // already open under another window: it comes to the top
    const w = document.querySelector('.term.wfw-win');
    if (w && typeof U !== 'undefined' && U.zTop) w.style.zIndex = U.zTop();
  }
  // the OUTBOX's way back: a job record by the run stream it rode (a work line's delivered row carries it)
  function openByStream(streamId, from) {
    return getJSON('/api/line-jobs?stream=' + encodeURIComponent(streamId) + '&limit=1').then(({ status, j }) => {
      const hit = status === 200 && j && Array.isArray(j.jobs) ? j.jobs[0] : null;
      if (!hit) return false;
      open({ view: 'line', line: hit.line }, from);
      return showJob(hit.id).then(() => true);
    }, () => false);
  }
  /* THE FLOOR OUTBOX IS ITS OWN LINE'S (Andrew 10-03: "the outbox should only show output of the specific conveyor system, it
     should never link back to deliverables"): clicking an OUTBOX on the floor opens the workflow that ships into it — its newest
     finished result first (NEW JOB + its last jobs one key away), or the job riding it right now. Never DELIVERABLES, never another
     line's work. An OUTBOX on no workflow ships nothing: it says so and shows the workflows (false = the caller had no window to open). */
  function openOutbox(propId) {
    const f = floor();
    const l = f && propId ? f.lines.find(x => x.outbox === propId || (x.outboxes || []).indexOf(propId) >= 0) : null;
    if (!l) { notify('This OUTBOX isn’t at the end of a workflow yet — nothing ships into it. Belt it to a line in Build Mode.', 'warn'); open({ view: 'list', job: null, step: null }); return false; }
    open({ view: 'line', line: l.key, job: null, step: null, msg: null });
    return getJSON('/api/line-jobs?line=' + encodeURIComponent(l.key) + '&limit=1').then(({ status, j }) => {
      const last = status === 200 && j && Array.isArray(j.jobs) ? j.jobs[0] : null;
      if (last && last.status !== 'running' && S.view === 'line' && S.line === l.key && !S.job) return showJob(last.id).then(() => true);
      return true;
    }, () => true);
  }
  /* CLOSED MEANS LET GO (night-leak, 2026-10-15): `body` is module state, so a closed WORKFLOWS window stayed reachable through it
     (and through every module closure that shares this scope, the bus handlers below included) until the next open. Closing drops
     the body and the floor subscription; every reader already treats a null body as closed (alive()). */
  function closed() { body = null; stopTimers(); }
  if (UI() && UI().registerWindow) UI().registerWindow('workflows', 'WORKFLOWS', build, { className: 'wfw-win', onClose: closed });
  /* SEND TO (2026-10-10): a job another line handed on runs in the background — no window posted it, so nothing folded its
     delivered run into DELIVERABLES › TO REVIEW, and the receiving line's result never reached the Commander's review pile. The
     floor's own events say when one lands in its OUTBOX (workitem.placed kind:'handoff', then workitem.delivered to 'outbox' for
     the same crate); the delivered run is read back from that line's job record (the route's own verdict) — never guessed. */
  // workitemId -> the receiving job's own record id (the crate names it — 10-11: reading "the line's newest" missed a delivered job
  // whenever a queued hand-off or a refusal had already written a newer record on that line)
  const handoffCrates = new Map();
  if (typeof U !== 'undefined' && U.bus) {
    U.bus.on('workitem.placed', p => {
      if (!p || p.kind !== 'handoff' || !p.workitemId || !p.lineId || !p.jobId) return;
      handoffCrates.set(String(p.workitemId), String(p.jobId));
      if (handoffCrates.size > 20) handoffCrates.delete(handoffCrates.keys().next().value);
    });
    U.bus.on('workitem.delivered', p => {
      const jobId = (p && p.finalQueueId === 'outbox') ? handoffCrates.get(String(p.workitemId || '')) : null;
      if (!jobId) return;
      handoffCrates.delete(String(p.workitemId));
      setTimeout(() => {
        loadJob(jobId).then(job => {
          const run = job && job.status === 'delivered' && job.from ? (job.runs || [])[0] : null;
          if (!run || run.reason !== 'done' || typeof ReturnStore === 'undefined' || !ReturnStore.foldRow) return;
          // its title is the job as it first arrived (the record's own text; an older record held the frame)
          const hin = !job.handedIn && P() && P().parseHandoffInput ? P().parseHandoffInput(job.text) : null;
          ReturnStore.foldRow({ runId: run.runId, agentId: run.agentId, usd: job.usd, ts: job.endedAt || Date.now(), streamId: job.streamId, title: (hin ? hin.original : job.text) || job.name || '' });
        }).catch(() => null);
      }, 600);
    });
  }
  /* every workflow and where a schedule would start it (org P16 — SCHEDULES' RUN BY): the line's first routed step with an agent
     (WorkflowLine.entryDocksOf — the same entry the INBOX form's schedule fires at). dockId/agentId are null when no agent works
     its first step yet: the form offers that line disabled, never a guess. */
  function startLines() {
    const f = floor(), Wl = W();
    if (!f || !Wl) return [];
    return f.lines.map(l => {
      const entry = (Wl.entryDocksOf ? Wl.entryDocksOf(l.flow) : [])[0] || null, d = entry && l.flow && l.flow.docks ? l.flow.docks[entry] : null;
      return { key: l.key, name: l.name, dockId: d && d.agentId ? entry : null, agentId: d && d.agentId ? d.agentId : null, ready: !!(l.ready && l.ready.ready) };
    });
  }
  // ReturnStore's nudge when a crate this window may be showing a rate control for is rated elsewhere (no-op while closed). Given the
  // rated run ids it repaints ONLY when the delivered result shows the rate control for one of them (org P14 review): paint() rebuilds
  // the body, which shuts every open <details> drawer, and alive() stays true while the window is minimized.
  const refresh = runIds => {
    if (!alive()) return;
    if (runIds != null) {
      const host = body.querySelector('.wfw-rate[data-rate-for]'), ids = [].concat(runIds).map(String);
      if (!host || ids.indexOf(String(host.getAttribute('data-rate-for'))) < 0) return;
    }
    schedule();
  };
  return { open, refresh, openLine: key => open({ view: 'line', line: key, job: null }), openNew: () => open({ view: 'new' }), openByStream, openOutbox, showJob, startLines,
    _state: S, _body: () => body, _floor: floor, _lineWord: lineWord, _pick: pickStarter, _create: create, _send: send, _useFix: useFix, _styleKept: styleKept, _keepStyle: keepStyle, _putStyleBack: putStyleBack, _exampleBrief: exampleBrief, _resultHTML: resultHTML, _startsText: startsText, _newHTML: newHTML, EX_HEAD };   // (the _ seams are test/eval reads)
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorkflowsWindow;
