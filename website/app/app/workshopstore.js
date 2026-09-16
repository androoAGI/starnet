/* STARNET — workshopstore.js : the AWAY-WORKSHOP return surface (lane W3, frontend).

   The Commander switched an agent's "build things while I'm away" grant on; while they were gone an
   autonomous shift built a deliverable in that agent's jailed sandbox and wrote a manifest. This store
   is the thin live wiring that, on browser attach, asks the sidecar what's UNDECIDED
   (GET /api/workshop/pending) and surfaces each one.

   SESSION DELIVERY (2026-07-15, per Andrew): an idle-work deliverable must NEVER pop its card into
   whatever session the Commander happens to have open. Every deliverable gets its OWN session — a
   workstream adopted with id 'workshop-<runId>' (the SAME id the sidecar used as the shift's durable
   streamId, so a follow-up message in that session resumes the build's real transcript server-side).

   DELIVERY REVEAL (2026-07-16, per Andrew): a finished build must GREET the Commander, not hide as an
   unread rail row with a one-line stub ("it puts it all on me to prompt and figure out what it even
   is"). When a deliverable lands — live push, attach poll, or genuine return — StarNet OPENS the
   deliverable's OWN session and presents the full return card there (what it built, the honest
   verification line, the summary, the files, the Open-it link, and the decide row). The card still
   renders ONLY inside its own session — never into a random feed — and the reveal stands down (unread
   row + toast fallback) whenever the Commander is mid-something (a streaming reply, the awakening, an
   open dialogue). With several deliverables pending, the NEWEST opens; the rest land unread.

   It also owns the two write paths the rest of the UI calls into:
     • queue(item)   → POST /api/workshop/queue  (the "build this while I'm away" action)
     • decide(...)   → POST /api/workshop/decide  (Keep / Later / Discard on the return card)

   HONESTY RULES (truthful telemetry — the product's core law):
     • A card asserts ONLY what its manifest proves. "tested — N passed" renders solely from a real
       manifest.verified block; otherwise the card says "built, not yet tested". Never invented status.
     • Decided-once: a Keep or Discard drops the manifest from pending server-side; a Later just dismisses
       the card for this session (it may return next session). A locally-seen ledger keeps a single page
       session from re-showing the same card if a poll races. Dismissed = gone, the anti-nag law.
     • UNDECIDED = still owed (2026-07-14): the seen/later ledger is SESSION-scoped, in-memory only. It
       used to persist to localStorage, so a deliverable whose card rendered once — usually to an empty
       room, since night-shift builds land while the Commander is away BY DEFINITION — was filtered out
       of every future attach poll: pending server-side, invisible forever ("it never tells me what it
       did"). Now an undecided deliverable re-presents every session until the Commander DECIDES; only
       Keep/Discard (server-side) or Later (this session) silence it.
     • Fail-open: any fetch error → no beat (never a fabricated card, never a thrown error at attach).

   NO U.bus emits. The ledger is deliberately NOT persisted (see above); reset() still clears the legacy
   key a pre-fix session may have left behind. node-exportable for its test.

   The W1/W2 backend is LIVE on trunk (routes /api/workshop/grant|queue|pending|decide|shift|backlog), so
   this store talks to the real sidecar only — no dev stub. */
'use strict';
const WorkshopStore = (() => {
  const KEY = 'starnet.workshop.v1';
  const ATTACH_DELAY_MS = 1800;   // let the floor + COMMS settle before the return beat (mirrors ReturnStore)
  let state = null;               // { v:1, later:{runId:true}, seen:[runId] } — session-scoped anti-nag
  let fired = false;              // one auto-poll per page session
  let deps = {};                  // { desktopDefault() } injected by app.js (a sensible Keep destination)
  let enabled = true;             // false during the awakening (init enabled:false) — live pushes stay silent
  let wired = false;              // the workshop.built live listener is installed once

  // SESSION-SCOPED by design (2026-07-14): load() never reads a prior session's ledger and save() writes
  // nothing — persisting seen/later was the bug that made undecided deliverables permanently invisible.
  function load() { return null; }
  function save() {}
  function hydrate(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
      v: 1,
      later: (s.later && typeof s.later === 'object') ? s.later : {},   // runIds the Commander said "Later" to THIS session
      seen: Array.isArray(s.seen) ? s.seen.filter(x => typeof x === 'string').slice(-200) : []
    };
  }
  const ready = () => !!state;
  // ---- reads ----
  // undecided manifests the Commander hasn't acted on. Filters out anything they said "Later" to this
  // session (anti-nag) and anything already shown this session (poll-race guard). Fail-open to [].
  // which agents to poll for pending deliverables. The backend keys the backlog per-agent and requires an
  // explicit ?agent=<id>, so we ask for each live agent (the hero + any crew) and flatten. deps.agentIds()
  // is injected by app.js; absent → just the hero.
  function agentIds() { try { const a = deps.agentIds ? deps.agentIds() : null; return (Array.isArray(a) && a.length) ? a : ['agent']; } catch (_) { return ['agent']; } }

  // every agent's undecided manifests, unfiltered — the shared read under fetchPending/presentOnReturn.
  // Sets lastRawOk so callers can tell "the station answered with nothing" (honest empty) apart from
  // "the station never answered" (cold-boot race / down) — only the latter is worth retrying.
  let lastRawOk = false;
  async function fetchRaw() {
    let list = [];
    lastRawOk = false;
    for (const id of agentIds()) {
      try {
        const r = await fetch('/api/workshop/pending?agent=' + encodeURIComponent(id), { cache: 'no-store' });
        if (!r.ok) continue;
        lastRawOk = true;
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j.pending) ? j.pending : []);
        for (const m of arr) { if (m && m.runId) { if (!m.agentId) m.agentId = id; list.push(m); } }
      } catch (_) { /* fail-open: this agent just contributes nothing */ }
    }
    if (!ready()) state = hydrate(load());
    return list;
  }

  async function fetchPending() {
    const list = await fetchRaw();
    return list.filter(m => m && m.runId && !state.later[m.runId] && state.seen.indexOf(m.runId) === -1);
  }

  // ---- away-mode truth (item #2) ----
  // HOW "AWAY" ACTUALLY WORKS (verified against sidecar/index.js, not the audit's guess):
  //   • A queued idea lands in the agent's durable backlog (POST /api/workshop/queue). The queue does NOT check
  //     the grant — it succeeds even with the grant OFF (the item just sits there, never built). That silent
  //     dead-end is the real bug the audit half-saw ("fails quietly"); it doesn't fail, it succeeds-and-stalls.
  //   • The BUILD is a per-agent WORKSHOP SHIFT: a recurring cron routine (~every 6h) that the "build while away"
  //     GRANT arms (handleWorkshopGrant → armWorkshopShift, which also arms the scheduler). It fires on that
  //     cadence while the STATION IS RUNNING — it is NOT gated on the app being closed. So the honest condition is
  //     "grant on + station running", NOT "app closed". The return DIGEST (returnstore.js heartbeat) is the part
  //     that's about the app being closed — a different subsystem the audit conflated with the build.
  // The confirm copy therefore states the grant + recurring-shift truth, and never the false "runs while closed".
  function queueConfirmLine(name) {
    const who = String(name || 'it').trim() || 'it';
    return '◈ queued for the away workshop — ' + who + ' will build this in its private sandbox on its next away shift '
      + '(recurring, roughly every 6 hours while the station is up). the result arrives as a new ⚒ session in your rail — '
      + 'see the build list (and a “build now” button) on the agent’s dossier › CONFIG.';
  }

  // read the agent's live "build while away" grant (GET /api/workshop/backlog returns { granted }). Fail-open to
  // null (unknown) so a render site degrades to neutral copy rather than asserting a grant state it couldn't read.
  async function grantOf(agentId) {
    try {
      const r = await fetch('/api/workshop/backlog?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return j && typeof j.granted === 'boolean' ? j.granted : null;
    } catch (_) { return null; }
  }

  // ---- writes ----
  // queue an idea for an agent to build while away. item: { agentId, text, sourceType, sourceId? }.
  // Returns { ok, error?, warn?, needsGrant?, agentId }. Never throws — the caller shows a one-line notice off the
  // result. On a successful queue we probe the grant: if it's OFF the item will NEVER be built until the Commander
  // turns "build while away" on, so we return a VISIBLE warn + needsGrant so the render site can offer that toggle
  // (openGrant below) — turning the old silent stall into an honest, actionable state.
  async function queue(item) {
    const text = String((item && item.text) || '').trim();
    // PINNED-contract → live backend shape: the sidecar's /api/workshop/queue takes { agentId, title,
    // detail?, source: 'quest'|'queued', id? }. Our callers speak {text, sourceType, sourceId}; map here so
    // the entry points stay simple. 'quest' is the only special source; everything else is a plain queued idea.
    const body = {
      agentId: (item && item.agentId) || 'agent',
      title: text,
      source: ((item && item.sourceType) === 'quest') ? 'quest' : 'queued'
    };
    if (item && item.sourceId) body.id = String(item.sourceId).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    if (!text) return { ok: false, error: 'nothing to build' };
    const aid = body.agentId;
    try {
      const r = await fetch('/api/workshop/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      // ok:true → added/exists (already-queued is a benign success). ok:false → duplicate/discarded:
      // surface the backend's own plain, anti-retry message so we never re-queue the same thing.
      if (r.ok && j && j.ok === true) {
        // GRANT PROBE (item #2): the queue succeeded, but the item only ever BUILDS if the away grant is on. If it's
        // OFF, say so with a way to fix it — never let it stall silently. `granted:null` (couldn't read) → no warn,
        // rather than a maybe-wrong claim.
        const granted = await grantOf(aid);
        if (granted === false) {
          const who = String((item && item.name) || aid || 'this agent');   // display name if the caller passed one, else the id
          return { ok: true, reason: j.reason, agentId: aid, needsGrant: true,
            warn: 'saved to the build list — but “build while away” is OFF for ' + who + ', so it won’t be built yet. turn it on to let the away shift build it.' };
        }
        return { ok: true, reason: j.reason, agentId: aid };
      }
      if (r.ok && j && j.ok === false) return { ok: false, error: j.message || 'already handled' };
      return { ok: false, error: (j && (j.error || j.message)) || 'queue failed' };
    } catch (_) { return { ok: false, error: 'queue error' }; }
  }

  // turn the "build while away" grant ON for an agent (POST /api/workshop/grant) — the action the queue's
  // needsGrant warning offers. Arms the workshop shift server-side. Returns { ok, error? }; never throws.
  async function openGrant(agentId) {
    try {
      const r = await fetch('/api/workshop/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: agentId || 'agent', on: true }) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) return { ok: true };
      return { ok: false, error: (j && (j.error || j.message)) || 'could not enable it' };
    } catch (_) { return { ok: false, error: 'could not reach the station' }; }
  }

  // decide a return card. decision: 'keep' (destPath required) | 'later' | 'discard'.
  // keep → copy the run dir's files to destPath; discard → wipe the run dir + denylist the backlog item;
  // later → just dismiss (server keeps it pending). Returns { ok, destPath?, error? }. Never throws.
  async function decide(agentId, runId, decision, destPath, extra) {
    if (!ready()) state = hydrate(load());
    // record locally FIRST so a poll race can't re-show a card the Commander just acted on.
    if (decision === 'later') { state.later[runId] = true; }
    if (state.seen.indexOf(runId) === -1) { state.seen.push(runId); if (state.seen.length > 200) state.seen = state.seen.slice(-200); }
    save();
    const body = { agentId: agentId || 'agent', runId: runId, decision: decision };
    if (decision === 'keep' && destPath) body.destPath = destPath;   // absent → the sidecar lands it in the default deliverables folder (or applies a patch deliverable to a branch)
    try {
      const r = await fetch('/api/workshop/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok !== false) {
        const keptPath = (j && j.destPath) || body.destPath;
        // Keep is a filesystem copy only. Renderer IPC cannot prove a fresh user
        // gesture, so a run may not launch an OS file manager on the user's desktop.
        // A patch deliverable's keep is an APPLY (new branch in the blessed repo) — pass the server's
        // real result through so the card can report what actually happened, never a guess.
        return { ok: true, destPath: keptPath, opened: false, applied: j && j.applied === true, branch: (j && j.branch) || null, commit: (j && j.commit) || null, root: (j && j.root) || null,
          // PATCH FALLBACK HONESTY: the server says when a patch deliverable could only be SAVED (not applied) —
          // the card's outcome line must never let that read as "implemented into your project".
          savedOnly: j && j.savedOnly === true, patchRefused: (j && j.patchRefused) || null };
      }
      return { ok: false, error: (j && j.error) || 'could not save your decision' };
    } catch (_) { return { ok: false, error: 'decision failed to reach the station' }; }
  }

  /* IMPLEMENT-AS-BUILD (2026-08-14) — POST /api/workshop/implement and run what a PLAN deliverable describes.
     The response is an NDJSON run stream, not a JSON body, so Harness.api.post (which calls r.json() on the whole
     body) cannot read it — every frame is parsed here instead. Each frame is re-emitted onto U.bus exactly like
     harness.js's run reader, so the station animates the build LIVE (floor, COMMS beats, work item) rather than
     the Commander staring at a frozen card for minutes. Resolves the final workshop.implement.result payload.
     Never throws: an unreachable station resolves { fired:false, reason:'unreachable' }. */
  async function implement(agentId, runId, note) {
    const body = { agentId: agentId || 'agent', runId: String(runId) };
    // what the Commander typed on the card — WHICH part of the plan to build. Rides into the build prompt, not
    // the chat stream (see chat.js: on a buildable card the box is a build steer, not a message).
    if (note != null && String(note).trim()) body.note = String(note).trim().slice(0, 2000);
    let res;
    try {
      res = await fetch('/api/workshop/implement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (_) { return { fired: false, reason: 'unreachable' }; }
    if (!res.ok || !res.body) return { fired: false, reason: 'http ' + res.status };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', result = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const s = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!s) continue;
          let ev; try { ev = JSON.parse(s); } catch (_) { continue; }
          if (ev.name === 'workshop.implement.result') { result = ev.payload || {}; continue; }
          if (typeof U !== 'undefined' && U.bus) { try { U.bus.emit(ev.name, ev.payload || {}); } catch (_) {} }
        }
      }
    } catch (_) { /* a dropped stream mid-build: the run continues server-side; report what we latched */ }
    return result || { fired: false, reason: 'no-result' };
  }

  // DELETED SESSION → SERVER-SIDE DISCARD: when the Commander deletes a deliverable's session
  // ('workshop-<runId>'), the deliverable itself must not stay pending server-side — that pending
  // manifest is exactly what re-minted the session on every restart. Only fires when the run is
  // GENUINELY still pending (a kept/discarded deliverable is left alone — no spurious ledger rows).
  // The Workstreams tombstone is the hard guarantee; this is the cleanup that makes "deleted" mean
  // the build is gone server-side too. Fail-open: an unreachable station just leaves the tombstone.
  async function discardIfPending(agentId, runId) {
    const rid = String(runId || '');
    if (!rid) return { ok: false, error: 'no run' };
    try {
      const m = (await fetchRaw()).find(x => x && String(x.runId) === rid) || null;
      if (!m) return { ok: true, pending: false };
      return await decide(m.agentId || agentId || 'agent', rid, 'discard');
    } catch (_) { return { ok: false, error: 'could not reach the station' }; }
  }

  // read a file inside the deliverable for the viewer, via the EXISTING jailed read-only route /api/file
  // (resolveInside proves the path can't escape the agent's workspace). The deliverable's files are relative
  // to the run dir, so we prefix workshop/<runId>/. Auth: the hardened window.fetch (harness.js) attaches the
  // per-launch token header to every /api/ URL, so we don't hand-append ?token= here. Fail-open to '' so a
  // missing/edited file never throws.
  async function readFile(agentId, runId, relPath) {
    try {
      const rel = 'workshop/' + runId + '/' + relPath;
      const url = '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(rel);
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return '';
      return await r.text();
    } catch (_) { return ''; }
  }

  // W7 — the URL that RUNS a workshop file in a browser tab, served from the jailed read-only /workshop-run/ static
  // route. A tab navigation (window.open) can't send the token header, so it rides ?token= exactly like /api/file.
  // The per-launch token is injected synchronously into the page (window.__STARNET_API_TOKEN__), so read it directly
  // (Harness.apiToken() is a promise — not usable in a sync href). Returns '' if the token isn't present yet.
  function runUrl(agentId, runId, relPath) {
    const tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : '';
    if (!tok) return '';
    // Desktop: the page's origin is the Tauri webview (bundled frontend), NOT the sidecar, and the injected
    // fetch shim only rewrites '/api/'-prefixed strings — so this URL must carry the sidecar base explicitly
    // (window.__STARNET_API__ = http://127.0.0.1:<port>). Browser build: __STARNET_API__ is unset → relative.
    const base = (typeof window !== 'undefined' && window.__STARNET_API__) ? String(window.__STARNET_API__) : '';
    const parts = String(relPath || '').split('/').map(encodeURIComponent).join('/');
    return base + '/workshop-run/' + encodeURIComponent(agentId || 'agent') + '/' + encodeURIComponent(runId) + '/' + parts
      + '?token=' + encodeURIComponent(tok);
  }

  // W7 — OS launch is intentionally unavailable: neither loopback API possession nor
  // renderer IPC proves a fresh human gesture. The caller presents manual-open guidance.
  async function openFile(agentId, runId, relPath) {
    return { ok: false, error: 'Open this file manually; StarNet cannot launch desktop applications from a run.' };
  }

  // the sensible default Keep destination (the Commander's Desktop, when the desktop shell knows it).
  function desktopDefault() { try { return deps.desktopDefault ? (deps.desktopDefault() || '') : ''; } catch (_) { return ''; } }

  /* ---- SESSION DELIVERY (the seam that replaced feed injection, 2026-07-15) ---- */
  const SESSION_PREFIX = 'workshop-';   // = the sidecar's shift streamId prefix, so session id ≡ durable stream
  const sessionIdOf = (runId) => SESSION_PREFIX + String(runId);

  // Adopt (idempotent) the deliverable's OWN session: unread in the rail, never focused. A re-offer of a
  // still-undecided deliverable bumps the existing session unread again (Workstreams.markUnread — undecided =
  // still owed), rather than re-rendering a card anywhere. Marks the runId seen (session-scoped poll-race guard).
  function ensureSession(m) {
    if (!m || !m.runId) return null;
    if (typeof Workstreams === 'undefined' || !Workstreams.adopt) return null;
    const runId = String(m.runId);
    if (state && state.seen.indexOf(runId) === -1) { state.seen.push(runId); if (state.seen.length > 200) state.seen = state.seen.slice(-200); save(); }
    const id = sessionIdOf(runId);
    const existing = Workstreams.get ? Workstreams.get(id) : null;
    if (existing) {
      // re-flag unread (undecided = still owed) WITHOUT re-stamping lastActiveAt — touch() here made the
      // rail's "last worked" time read "now" on every boot/return poll even though nothing new happened.
      if (Workstreams.markUnread) Workstreams.markUnread(id);
      else if (Workstreams.touch) Workstreams.touch(id);   // older store without markUnread: keep the unread bump
    } else {
      // DELETED = GONE: the Commander removed this deliverable's session; adopt() refuses the
      // tombstoned id, so the row must not re-form (the delete path also discards server-side).
      const adopted = Workstreams.adopt({
        id: id,
        title: '⚒ ' + (String(m.title || '').trim() || 'built while you were away').slice(0, 70),
        agentId: m.agentId || 'agent', lane: 'active', kind: 'chat',
        history: [{ role: 'system', sys: true, content: '⚒ built while you were away — “' + String(m.title || 'a deliverable') + '”.'
          + (String(m.summary || '').trim() ? ' ' + String(m.summary).trim() : '')
          + ' open this session any time to review and decide.' }],
        // timestamp honesty: the session's "last worked" = when the build actually LANDED (manifest builtAt,
        // server-stamped at validation; the live workshop.built push carries it too). Only a legacy manifest
        // with no stamp falls back to now (first-seen). lastReadAt: 0 = truthful unread (real unseen work).
        lastActiveAt: (Number(m.builtAt) > 0 ? Number(m.builtAt) : Date.now()), lastReadAt: 0
      });
      if (!adopted) return null;
    }
    try { if (typeof App !== 'undefined') { if (App.refreshRail) App.refreshRail(); if (App.persist) App.persist(); } } catch (_) {}
    return id;
  }

  // append an honest, durable one-liner to the deliverable's session after a decision, so the session still
  // tells the story after the live card vanishes (and across reloads).
  function noteDecision(runId, text) {
    try {
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.get) ? Workstreams.get(sessionIdOf(runId)) : null;
      if (ws && Array.isArray(ws.history)) {
        ws.history.push({ role: 'system', sys: true, content: String(text) });
        if (typeof App !== 'undefined' && App.persist) App.persist();
      }
    } catch (_) {}
  }

  // hand ONE manifest to the return card — rendered INSIDE its own session (opts.sessionId makes chat.js
  // refuse to paint it into any other stream). Marks the runId seen (session-scoped).
  function presentCard(m) {
    if (!m || !m.runId) return;
    const runId = String(m.runId);
    if (state.seen.indexOf(runId) === -1) { state.seen.push(runId); if (state.seen.length > 200) state.seen = state.seen.slice(-200); save(); }
    const aid = m.agentId || 'agent';
    Chat.workshopReturn(m, {
      sessionId: sessionIdOf(runId),                             // the card belongs to THIS session only
      readFile: readFile,
      desktopDefault: desktopDefault(),
      runUrl: (relPath) => runUrl(aid, runId, relPath),          // W7: URL that RUNS a web file in a tab
      openFile: (relPath) => openFile(aid, runId, relPath),      // W7: manual-open guidance; never OS-launch
      onDecide: (decision, destPath, extra) => decide(aid, runId, decision, destPath, extra),
      onImplement: (note) => implement(aid, runId, note),        // build what a PLAN deliverable describes
      noteDecision: (text) => noteDecision(runId, text)
    });
  }

  // the Commander is mid-something a focus jump would stomp: a streaming reply, an interview flow, or a
  // focused dialogue panel or composer. A composer probe error preserves focus; the unread delivery
  // remains available in its own session, so uncertainty never justifies stealing an in-progress draft.
  function commanderEngaged() {
    try { if (typeof Chat !== 'undefined' && Chat.isComposerEngaged && Chat.isComposerEngaged()) return true; } catch (_) { return true; }
    try { if (typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy()) return true; } catch (_) {}
    try { if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true; } catch (_) {}
    try { if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true; } catch (_) {}
    try { if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true; } catch (_) {}
    return false;
  }

  // DELIVERY REVEAL (2026-07-16): open the deliverable's OWN session and present the full return card there.
  // Returns true when the reveal happened; false → the caller keeps the unread-row + toast fallback. The
  // direct presentCard makes the card unconditional on the open (chat.js load() → presentFor also fires and
  // re-fetches; its data-wsrun dedupe keeps exactly one live card).
  function reveal(m) {
    if (!m || !m.runId) return false;
    if (commanderEngaged()) return false;
    if (typeof App === 'undefined' || !App.openWorkstream) return false;
    try { App.openWorkstream(sessionIdOf(String(m.runId))); } catch (_) { return false; }
    try { presentCard(m); } catch (_) {}
    return true;
  }

  // THE CARD-ON-OPEN SEAM: chat.js load() calls this with the freshly displayed workstream id. If it is a
  // deliverable session whose run is STILL UNDECIDED server-side (fresh honest read — never a cached claim),
  // render the return card into it. Deliberately ignores the seen AND later ledgers: the Commander explicitly
  // opened this session, which is the opposite of nagging. Fail-open: any fetch error → no card, no throw —
  // but an UNREACHABLE station RETRIES while this session stays on screen (see below), because on desktop the
  // bundled frontend paints before the sidecar answers, and a one-shot probe left the Commander staring at the
  // naked stub line with no card and nothing ever retrying (the "no UI under built-while-away" bug).
  let pfRetryTimer = null;   // one retry chain at a time; each fresh presentFor call supersedes it
  const pfDelays = { fast: 3000, slow: 30000 };   // test-tunable (exported as _pfDelays)
  async function presentFor(wsId, _try) {
    const id = String(wsId || '');
    if (pfRetryTimer) { clearTimeout(pfRetryTimer); pfRetryTimer = null; }
    if (id.indexOf(SESSION_PREFIX) !== 0) return;
    if (typeof Chat === 'undefined' || !Chat.workshopReturn) return;
    const runId = id.slice(SESSION_PREFIX.length);
    // Probe the OWNING agent directly (the session records it), not just the live-roster sweep — a deliverable
    // built by an agent that later left the roster must still resolve when its session is opened.
    const ws = (typeof Workstreams !== 'undefined' && Workstreams.get) ? Workstreams.get(id) : null;
    const aid = (ws && ws.agentId) || 'agent';
    let pending = null;   // null = station unreachable (stay silent); [] = the server ANSWERED
    try {
      const r = await fetch('/api/workshop/pending?agent=' + encodeURIComponent(aid), { cache: 'no-store' });
      if (r.ok) { const j = await r.json().catch(() => null); pending = (j && Array.isArray(j.pending)) ? j.pending : []; }
    } catch (_) { pending = null; }
    if (pending === null) {
      // unreachable/odd response → the old fail-open read across the roster; an error here stays silent
      // (never assert a resolution the server didn't prove).
      const m0 = (await fetchRaw()).find(x => x && String(x.runId) === runId) || null;
      if (m0) { presentCard(m0); return; }
      // STATION UNREACHABLE, nothing rendered: cold-boot race (webview up before the sidecar listens).
      // Keep probing while THIS session is still the one on screen — fast at first, then slow — so the
      // card appears the moment the station answers instead of never. A session switch retires the chain
      // (chat.js load() re-fires presentFor on return), and each real presentFor call supersedes it.
      const t = _try || 0;
      if (t >= 20) return;   // ~5 min of trying; past that the station is genuinely down, stay silent
      pfRetryTimer = setTimeout(() => {
        pfRetryTimer = null;
        try {
          const stillHere = (typeof Workstreams !== 'undefined' && Workstreams.activeId) ? Workstreams.activeId() === id : false;
          if (stillHere) presentFor(id, t + 1).catch(() => {});
        } catch (_) {}
      }, t < 5 ? pfDelays.fast : pfDelays.slow);
      if (pfRetryTimer && pfRetryTimer.unref) pfRetryTimer.unref();   // node (tests): never hold the process open
      return;
    }
    const m = pending.find(x => x && String(x.runId) === runId) || null;
    if (m) { if (!m.agentId) m.agentId = aid; presentCard(m); return; }
    // THE SERVER ANSWERED and this run is NOT pending. The old behavior was total silence — the session kept
    // its stub line promising "open any time to review and decide" with nothing to review or decide (looked
    // like a broken/old UI). Resolve the session honestly, once, from the deliverable library's server truth.
    await noteResolved(aid, runId);
  }

  // RESOLUTION MARKER (2026-07-18): a deliverable session whose run is no longer pending gets ONE durable,
  // honest sys line stating what actually happened — read from GET /api/deliverables (the lifecycle library,
  // server truth), never guessed. Skipped when the session already tells the story (a live-card decision
  // marker ✓/✕/⚠ patch, or a prior resolution line). Fail-open: an unreadable library still yields the
  // honest "no record" line ONLY because the pending probe above already proved the run isn't reviewable.
  const RESOLVED_MARK = '◈ decided — ';
  const GONE_MARK = '◈ nothing left to review — ';
  function historyTellsTheStory(ws) {
    if (!ws || !Array.isArray(ws.history)) return true;   // no history to annotate → nothing to do
    return ws.history.some(x => {
      if (!x || !x.sys || typeof x.content !== 'string') return false;
      const c = x.content;
      return c.indexOf(RESOLVED_MARK) === 0 || c.indexOf(GONE_MARK) === 0
        || c.indexOf('✓') === 0 || c.indexOf('✕') === 0 || c.indexOf('⚠ patch') === 0;
    });
  }
  async function noteResolved(agentId, runId) {
    try {
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.get) ? Workstreams.get(sessionIdOf(runId)) : null;
      if (!ws || historyTellsTheStory(ws)) return;
      let row = null;
      try {
        const r = await fetch('/api/deliverables?query=' + encodeURIComponent(runId), { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          const items = (j && Array.isArray(j.items)) ? j.items : [];
          row = items.find(x => x && String(x.runId) === String(runId) && String(x.agentId) === String(agentId)) || null;
        }
      } catch (_) { row = null; }
      let line;
      if (row && row.status === 'kept') line = RESOLVED_MARK + 'this build was KEPT — its files were implemented/saved. find it in the DELIVERABLES library.';
      else if (row && row.status === 'discarded') line = RESOLVED_MARK + 'this build was DISCARDED — its files were removed and it won’t be rebuilt.';
      else if (row && row.status === 'failed') line = RESOLVED_MARK + 'this build FAILED — it never produced a reviewable deliverable.';
      else line = GONE_MARK + 'this build is no longer awaiting a decision and its files are gone from the agent’s workshop.';
      ws.history.push({ role: 'system', sys: true, content: line });
      try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      // if the Commander is looking at this session right now, repaint it so the truth appears immediately.
      // (Chat.load re-fires presentFor; historyTellsTheStory now stops the chain, so this can't loop.)
      try { if (typeof Chat !== 'undefined' && Chat.load && typeof Workstreams !== 'undefined' && Workstreams.activeId && Workstreams.activeId() === ws.id) Chat.load(ws); } catch (_) {}
    } catch (_) {}
  }

  // auto-poll on attach: give EVERY undecided deliverable its own unread session, then REVEAL the newest
  // (open its session + full return card) so the Commander is greeted with what was built, not a stub row.
  // Once per page session.
  let attachTries = 0;   // maybePresent's unreachable-station retry budget (same shape as presentFor's)
  async function maybePresent() {
    if (fired || !ready()) return;
    const pending = await fetchPending();
    if (!pending.length) {
      // NOTHING surfaced. If the station actually ANSWERED (lastRawOk), that's the honest end — no builds
      // owed. If it never answered (cold-boot race: the bundled frontend paints before the sidecar
      // listens), a one-shot poll here meant a night-shift build stayed invisible until the NEXT restart —
      // so retry, fast then slow, until the station speaks or the budget runs out (~5 min).
      if (!lastRawOk && attachTries < 20) {
        attachTries++;
        const t = setTimeout(() => { maybePresent().catch(() => {}); }, attachTries <= 5 ? pfDelays.fast : pfDelays.slow);
        if (t && t.unref) t.unref();   // node (tests): never hold the process open
      }
      return;
    }
    fired = true;
    // ensureSession returns null for a deliverable whose session the Commander DELETED — never
    // resurrect it, and never reveal it (deleted = gone, the whole point of the tombstone).
    const live = pending.filter(m => ensureSession(m) != null);
    if (live.length) reveal(live[live.length - 1]);   // backlog order: last = newest build
  }

  /* RETURN RE-PRESENT (2026-07-14, reshaped for session delivery 2026-07-15): a night-shift build lands
     while the Commander is away BY DEFINITION, so the live delivery (onBuilt below) plays to an empty room.
     On the Commander's first interaction after a real absence (AutopilotStore's onReturn hook, wired in
     app.js), re-surface every still-UNDECIDED deliverable by bumping its session unread again (undecided =
     still owed). Respects 'later' (an explicit dismissal stays quiet); ignores 'seen' (a session adopted
     to an empty room must not count as told). */
  async function presentOnReturn() {
    if (!enabled) return;
    const list = (await fetchRaw()).filter(m => m && m.runId && !state.later[m.runId]);
    const live = list.filter(m => ensureSession(m) != null);   // deleted sessions stay deleted
    if (live.length) reveal(live[live.length - 1]);   // greet the return with the newest build's card
  }

  /* LIVE PUSH — the attach-time poll above only covers session OPEN, so a deliverable that landed while the
     app sat open (a night-shift act or an away-workshop shift) was invisible until the next restart
     (2026-07-14: "it doesn't notify me anywhere"). The sidecar emits workshop.built the moment a manifest is
     disk-validated; this adopts the deliverable's OWN unread session immediately — never a card into whatever
     stream is on screen — plus a persistent StationUI toast (category 'cronDigest', the Commander-mutable
     autonomous-run class). Anti-nag: the seen/later ledger still guards, so a build already delivered this
     session never re-fires here. */
  function onBuilt(p) {
    if (!enabled || !p || !p.runId || !p.manifest || typeof p.manifest !== 'object') return;
    if (!ready()) state = hydrate(load());
    const runId = String(p.runId);
    if (state.later[runId] || state.seen.indexOf(runId) !== -1) return;
    const aid = String(p.agentId || 'agent');
    const m = Object.assign({}, p.manifest, { agentId: aid, runId: runId });
    if (ensureSession(m) == null) return;   // marks seen; a DELETED session never re-forms or re-toasts
    // DELIVERY REVEAL: the moment the build lands, open its session with the full card. Fallback (the
    // Commander is mid-something, or no App yet): unread row + ONE actionable toast that jumps there.
    const opened = reveal(m);
    if (!opened) try {
      if (typeof StationUI !== 'undefined' && StationUI.notify) {
        const jump = () => { try { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(sessionIdOf(runId)); } catch (_) {} };
        StationUI.notify('✦ built while you were away: ' + String(m.title || 'a deliverable') + ' — click to review it', 'gold', 'cronDigest', { onClick: jump });
      }
    } catch (_) {}
    try { if (typeof World !== 'undefined' && World.say) World.say('✦ finished a build — it’s waiting in its own session'); } catch (_) {}   // ambient in-world cue, same family as the desk-draft delivery
  }

  // init({ enabled, desktopDefault }) — called from enterGame. enabled:false (the awakening) skips the beat.
  function init(opts) {
    opts = opts || {};
    deps = { desktopDefault: opts.desktopDefault, agentIds: opts.agentIds };
    state = hydrate(load());
    enabled = opts.enabled !== false;
    if (!wired && typeof U !== 'undefined' && U.bus) {
      wired = true;
      U.bus.on('workshop.built', p => { try { onBuilt(p); } catch (_) {} });
    }
    if (opts.enabled !== false) setTimeout(() => { maybePresent().catch(() => {}); }, ATTACH_DELAY_MS);
  }

  // S2/new-hero: a fresh Commander inherits no prior "later" list.
  function reset() { state = hydrate(null); fired = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, queue, decide, implement, discardIfPending, readFile, runUrl, openFile, desktopDefault, fetchPending, presentOnReturn, presentFor, ensureSession, reset, queueConfirmLine, grantOf, openGrant, onBuilt, _hydrate: hydrate, _pfDelays: pfDelays, _maybePresent: maybePresent };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { WorkshopStore };
