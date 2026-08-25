/* STARNET — world.js : the LIVE station the agent lives inside.

   Renders the player-built WorldModel station (multi-room) with the generalized
   procedural bake (stationbake.js), under a pan/zoom camera. The agent has a
   workstation in its spawn room and ACTUALLY WALKS the rooms + corridors — pathing
   through doors via the model's BFS path() — to reach its seat when given a task,
   then wanders the whole reachable station when idle. Edits made in REFIT build mode
   re-bake the world live (the agent re-homes if the floor under it is reclaimed).

   Coordinate frame: everything here is in the bake's LOCAL tile frame (tile*TILE px);
   the camera maps local→screen. The WorldModel's world/local offset is handled inside
   projectGeometry(); when the station grows north/west the origin shifts and the agent
   is translated to stay put. */
'use strict';

const World = (() => {
  let T = 12;

  /* ---------- station + bake cache ---------- */
  let station = null, geo = null, cache = null, geoDirty = true, bakeDirty = true, unsub = null;
  let desk = null, seat = null, blocked = new Set();   // desk footprint (local tiles) blocks pathing
  let deskPropId = null, deskFace = 'north';           // set when the hero's desk is a PLACED workstation prop assigned to it (its id + the seat's facing)
  let convey = null;   // live conveyor transport sim (boxes riding the belts)
  let ghost = null;    // GHOST PROJECTION (guided workflows Phase 3): its own dedicated engine — never mixes with convey
  let junctions = null;   // splitter/merger/filter routing overrides keyed by tile (rebuilt on geo change)
  let routingPlan = null;                        // compiled RoutingPlan (Pipeline) — drives junctions + the sidecar dispatch
  let beltLiveSet = null;                        // { "x,y": true } belt tiles on a complete INTAKE→bound-BAY route (energized render)
  let beltTileSet = null;                        // Set("x,y") of every belt tile (hover hit-test; rebuilt with the plan)
  let routeTagCache = null;                      // tileKey -> {text, ok} composed hover route tag (invalidated on recompile)
  let hoverBeltTile = null;                      // belt tile under the cursor (hover-glance route tag), or null
  let hoverOutbox = null;                        // stacked OUTBOX under the cursor (hover-glance "N TO REVIEW" tag), or null
  let routingNags = null;                        // [{x,y,w,h,label,warn}] in-world callouts mirroring the compiler's errors
  let feedState = { known: false, fed: true };   // server-proven "something feeds the intake" truth (channels/cron); fed=true until proven otherwise
  let feedNagOn = false;                         // a NO FEED nag is showing → the intake becomes clickable (→ CHANNELS)

  /* ---------- canvas + camera ---------- */
  let cv, ctx, raf = 0, last = 0, fnow = 0, running = false, ro = null, listenersBound = false;   // listenersBound: init() can run again per new agent — bind canvas/window/doc handlers + the SSE bridge ONCE
  // live-tunable CRT knobs — drawCRT/drawGlows read these every frame so the dev CRT LAB
  // (crtlab.js, dev-gated) can tune them live. These ARE the shipped defaults: bold scanlines,
  // fade off, faint lamp shimmer — the look dialed in and signed off via the lab (2026-06-30).
  /* APERTURE (2026-07-27) — `vig` and `over` govern how much of the panel the picture actually gets, and are
     independent of `curve` (which only decides how hard it bows).
       vig  — strength of the in-canvas radial vignette, 1 − vig·r². This is the DOMINANT darkener of the feed:
              r=1 at the edge midpoints and √2 at the corners, so the shipped 0.55 cut the edges to 45% and
              clamped the corners to literal ZERO, long before any CSS glass was composited on top. Lowering it
              is what actually gives the border back.
       over — output overscan. The warp's inverse ro = rs·(1 − k·rs²) has a maximum reach of (2/3)/√(3k) = 1.283
              at k=0.09, but a rect's corner sits at √2 = 1.414 — so those pixels had NO source to sample and
              both paths hard-filled them black. That is the rounded-oval crop, not a soft vignette. Dividing
              the output radius by ≥ √2/1.283 = 1.103 brings the corners back inside the domain; 1.12 leaves
              margin. The cost is ~11% of edge content, never any change to the curvature.
     Both feed the GL path and the CPU LUT path IDENTICALLY — drawCurveGL's probe compares the two and defects
     to CPU on divergence, so they must never drift apart. */
  const CRT = { scan: 0.43, pitch: 1, fade: 0.25, glow: 0.07, curve: 0.09, vig: 0.30, over: 1.20, dust: 0.5, aberr: 0.35, grain: 0.24 };
  let _warpCv = null, _warpCtx = null;   // the barrel-warp snapshot buffer — see drawCurve()
  let _lut = null, _lutKey = '', _outImg = null;   // CPU per-pixel barrel-warp inverse-map LUT + output buffer — see buildLUT()/drawCurveCPU()
  let _gl = null, _glc = null, _glProg = null, _glTex = null, _glKLoc = null, _glAberrLoc = null, _glVigLoc = null, _glOverLoc = null, _glReady = false, _glFailed = false;   // GPU barrel-warp (WebGL) — see initGL()/drawCurveGL()
  let _glProbeOk = false, _glProbeTries = 0, _glProbeSkip = 0, _glProbeClean = 0, _glProbeCv = null;   // one-time GL output sanity probe — see drawCurveGL()
  function glContextLost(gl) {
    try { return !!(gl && typeof gl.isContextLost === 'function' && gl.isContextLost()); }
    catch (_) { return true; }   // an unreadable context is no safer to blit than a proven-lost one
  }
  function abandonCurveGL(reason) {
    if (!_glFailed) console.warn('[crt] ' + reason + ' — switching to CPU fallback');
    _glFailed = true; _glReady = false;
    return false;
  }
  // whole-frame per-channel means via a 16×16 GPU downscale (~1KB readback) — the probe's sampler
  function probeMeans(src) {
    if (!_glProbeCv) { _glProbeCv = document.createElement('canvas'); _glProbeCv.width = 16; _glProbeCv.height = 16; }
    const pctx = _glProbeCv.getContext('2d', { willReadFrequently: true });
    pctx.clearRect(0, 0, 16, 16); pctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, 16, 16);
    const d = pctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  }
  let _scanCv = null, _scanKey = '';    // cached SOFT-scanline tile canvas (rebuilt only when scan/pitch/dpr change) — see scanCanvas()
  let _grainCv = null, _grainPat = null;   // cached film-grain noise tile + pattern — see grainPattern()/drawCRT()
  let scale = 2, panX = 0, panY = 0, fitNeeded = true;
  let fitW = 0, fitH = 0;   // canvas size the last fitCamera() framed against — a fit on a hidden/degenerate stage doesn't count as a real view
  const MINZ = 0.5, MAXZ = 6;
  const clampz = (v, a, b) => v < a ? a : v > b ? b : v;
  let drag = null, hoverAgent = null, onClick = null, onArcade = null, onOutbox = null, onMissionBoard = null, onTrophyCase = null, onBayAssign = null, onIntakeFeed = null, onIntakeSample = null, wakeAt = 0;
  let camLerp = null;   // {scale,panX,panY} target — a gentle one-on-one framing for voice conversations
  let wakeDark = 0, wakeDarkTarget = 0, awakeFrozen = false;   // the AWAKENING: a darkness veil that lifts to first light, + a freeze so the newborn holds still during its first meeting
  let camAnim = null;                                          // {fromS,toS,fromX,toX,fromY,toY,t,dur,ease,onEnd} — a scripted awakening camera move
  /* FOLLOW-LOCK + IDLE CINECAM (the GTA-style idle camera). camLock is a CONTINUOUS follow of one body —
     source 'session' = the Commander selected that agent's session (explicit intent, engages immediately);
     source 'cine'    = the idle auto-director cast the shot itself after a hands-off spell.
     Either way ANY user camera input (wheel zoom / drag pan / canvas click) releases the lock instantly and
     re-stamps camUserAt; the director may only take the camera back after cineIdleMs of true hands-off. */
  let camLock = null;                  // {id, sc, source:'session'|'cine'} — the followed body + its target zoom
  let camUserAt = 0;                   // last USER camera act (performance.now clock) — the cinecam idle clock
  const CINE_IDLE_MS = 120000;         // hands-off threshold before the auto-director may take the camera (2 min)
  let cineIdleMs = CINE_IDLE_MS;       // live threshold (setCinecamIdle lets DEV/verify shrink it — never shipped-UI-tunable)
  let cineHoldUntil = 0;               // director: when the current shot may be re-cast
  let cineWalkAt = 0;                  // last time the director's subject was actually WALKING (movement grace before a cut)
  let sparkAt = 0, bornAt = 0, dawnAt = 0, truthPulseAt = 0;   // ignition spark / color-into-being / dawn-bloom / per-truth-flare timestamps
  let floodAt = 0, floodEndAt = 0, floodStreams = null;        // THE FLOOD: screen-space data-cascade — start / collapse-trigger / seeded streams
  let firstWakeDone = false;                                   // FIRST LIGHT: once-per-page-life latch — the wake ritual fires at most once (a re-bake/refit never resets it)
  let floorLiveAt = 0;                                         // when this page's world started running — the boot-quiet window the spawn WELCOME waits out (a roster replay spawns every body at once)
  let kindleArmed = false, kindleP = 0, kindleHolding = false, kindlePeak = 0, kindleDone = null;   // THE KINDLING: the user HOLDS to wake the dormant mind; their attention fills kindleP (0..1) → ignition
  // THE VOID backdrop (dense parallax starfield + nebulas) lives in spacebg.js (SpaceBG.draw),
  // shared with REFIT (build.js) so entering/exiting build mode never jumps the sky.

  /* reduced-motion (the warroom honesty floor): heavy motion — pulses/blinks — goes steady when the OS
     asks for less motion. Live-read so a runtime setting change is honored without a reload. */
  const _rmq = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rmq && _rmq.matches);

  /* ---------- agent + crew ----------
     `agent` is the HERO (crew[0] conceptually): the active agent, with the full state machine — walking,
     awakening, novelty, glances, couch lounging. `crew` is the EXTRA bodies: the OTHER agents bound to BAY
     props, rendered as LIGHT static figures standing at their bays (no pathing/AI — they just receive work
     and light up). Empty crew === today's exact single-agent world; every crew code path is gated so the
     hero behaves byte-for-byte as before. The crew is derived from the RoutingPlan's bays (syncCrewFromPlan). */
  let agent = null, activity = 'idle';
  // B1 (crew-sentience): module-level "current actor" pointer for the reusable sentience engine.
  // DEFAULTS to the hero `agent`; the hero tick runs with self===agent so its path is byte-identical.
  // B2 will temporarily repoint `self` to each crew body, then UNCONDITIONALLY restore self=agent.
  // Engine-core fns read/write the current body via `self.`; hero-identity refs stay on `agent`.
  let self = agent;
  let crew = [];
  // Stage 2 (orchestration): a lead→worker handoff is WATCHABLE — boxes that fly from the lead body to a worker
  // body when the lead delegates. delegateLead/delegateCall track the open team.dispatch window (tool_call→result)
  // so a worker run that starts inside it animates; both are driven purely by existing agent.* bus events.
  const handoffBoxes = [];
  let delegateLead = null, delegateCall = null;
  // G4 feature 1 — APPROVAL WALK-AND-WAIT. When a HERO run blocks on a permission.prompt the body stops
  // working, stands, and walks to a wait anchor (airlock → mission board → own desk, resolved honestly from
  // the live floor via WaitAnchor) where it visibly WAITS with an "AWAITING APPROVAL" tag. permission.response
  // clears it: the run genuinely resumes (approve) or ends (deny) server-side, so the body returns to its desk
  // and the ongoing/finished run drives activity as usual. awaitPrompt is the live prompt; awaitAnchor is the
  // resolved wait tile; awaitArrived latches once the body reaches it (drives the waiting pose + tag).
  let awaitPrompt = null, awaitAnchor = null, awaitArrived = false;
  // G4 feature 2 — AUTOJOB PIN-TO-BOARD. When the pending-proposal count RISES, the hero (when idle & free)
  // walks to the MISSION BOARD and plays a brief pin flourish, then returns to its business — the walk-and-pin
  // plays once per proposal (keyed to the count high-water mark). pinnedCount is that mark; pinFlourishAt drives
  // the amber pin-burst render; pinTargetTile is the board approach tile the agent walks to.
  let pinnedCount = 0, pinFlourishAt = -1e9, pinTargetTile = null, pinCheckAt = -1e9;
  // TIER D · D5 — THE OVERSEER OVERSEES. The hero (`agent`, the station's OVERSEER — no separate overseer body
  // exists in-world) reads as a supervisor: (2) a rare walk to the MISSION BOARD to survey the queue when it is
  // non-empty (goal 'post', modeled on the 'pin' beat above); it ARMS the D2 station budget on fire but is not
  // itself damp-gated (crewBeatDamp is a no-op for the hero by J1 parity design). `postCd` is its
  // per-hero cooldown; `postTargetTile` the board approach tile it walks to. Beats (1) inspection-rounds and
  // (3) queue-aware idle bias ride existing machinery (maybeRounds / decideIdle) and need no new module state.
  let postCd = 0, postTargetTile = null;
  // (G4.3 "Meeseeks" helper sprites REMOVED 2026-07-30 on Andrew's order — the flickering cyan bar that
  //  hovered beside the lead and rode along when it walked read as floating garbage, not as a helper. The
  //  world draws NO floating marker for background sub-agents; the LIVE HELPERS panel (server-truth
  //  /api/subagents) remains the one honest readout. Do not rebuild a follower sprite for this.)
  // AGENT GROWTH HUD: per-agent Xp.compute() snapshots pushed in by XpStore (drives the hero name-tag "Lv N"
  // chip and any body's gold level-up ripple). The station headline lives in the top-bar STATION chip.
  let xpAgent = null, levelUpAt = 0;
  const xpByAgent = new Map();
  const CREW_COLORS = ['#5ad0ff', '#ff8a5a', '#7df08a', '#e0a0ff', '#ffd45a', '#5affd0', '#ff6a9a'];
  const crewColor = aid => CREW_COLORS[U.hash('' + aid) % CREW_COLORS.length];
  const footOf = (lx, ly) => ({ x: lx * T + T / 2, y: ly * T + T - 1 });
  const tileOf = (px, py) => ({ x: Math.floor(px / T), y: Math.floor(py / T) });
  // where the agent is DRAWN: on its couch seat when seated, otherwise its logical foot position
  const rposX = () => (agent && agent.seated) ? agent.seatPx : agent.px;
  const rposY = () => (agent && agent.seated) ? agent.seatPy : agent.py;
  // same, for ANY placed body (the hero OR a crew/summoned body): its drawn foot/seat position
  const bodyPosX = b => b ? (b.seated ? b.seatPx : b.px) : 0;
  const bodyPosY = b => b ? (b.seated ? b.seatPy : b.py) : 0;

  /* couch seat reservation (multi-agent seam): "propId:slot" of every taken seat. One agent drives
     world.js today, so this holds at most its own claim — but it's the shared occupancy a second
     agent would consult to take a different cushion (or a different couch). */
  const occupiedSeats = new Set();

  /* ---------- awareness & curiosity ----------
     novelty = freshly placed things the agent should wander over and inspect; seen* track what the
     agent has already taken in (null until the first geo is observed, so a fresh station doesn't
     trigger a boot-time inspection storm). Curiosity remarks are short, apostrophe-free, and only
     ever spoken when no real message bubble is live. */
  let novelty = [], seenProps = null, seenBelts = null;
  let propFoot = new Map();         // id -> {x,y,w,h} of last-seen props, so a REMOVAL knows WHERE it stood (for mourning)
  let pendingMourn = null, mournCd = 0;   // a fond spot was just emptied -> go stand where its thing used to be (grief)
  const NOVELTY_MAX = 4;
  let lastSelfTalk = -1e9;          // global self-talk cooldown — bubbles stay rare, honest thoughts (never a monologue)
  const seenCount = new Map();      // habituation: how many times a prop-id / belt-tile has been studied (novel -> familiar)
  /* ...and how it FADES again (2026-08-08 idle-life pass). Habituation only ever climbed, and planPOI
     drops any prop studied 4+ times, so after ~10 minutes of watching, every machine on the floor was
     permanently "furniture" and the ambient-curiosity beat had nothing left to pick — the station went
     inert exactly when a viewer had settled in to watch it. Interest now decays one step every
     FORGET_MS, so a thing ignored for a while becomes worth a second look. */
  const FORGET_MS = 150000;
  let forgetAt = 0;
  /* ---------- THE CONVEYOR IS NOT A SPECTATOR SPORT (2026-08-17, Andrew: "they all go to the conveyor
     if one is spawned, which is not one of the idle wandering activities") ----------
     Watching a belt go by is the ONE ambient-curiosity target with unlimited supply. planPOI's other
     candidate — study your own workstation — is capped by habituation (seenCount < 4) and by ownership
     (your desk only), so within a few minutes of a station's life the belt is the only thing an idle
     body can ever pick, planPOI is consulted TWICE per idle re-decide (the bored branch and the
     fallback), and every body runs the same engine. Spawn one agent and the routing plan lays belt to
     its bay: the candidate switches on for the whole crew at once and the floor drains toward the line.
     Two bounds, no new behaviour: ONE watcher station-wide at a time (a self-expiring claim, so nothing
     has to remember to release it), and a long per-body cooldown once a body has had its look. */
  const BELT_WATCH_CD_MIN = 180000, BELT_WATCH_CD_MAX = 360000;   // per body, once it has watched the line
  let beltWatch = null;             // { body, until } — the single live claim; validated lazily, never released by hand
  function beltWatchTaken(now) {
    if (!beltWatch) return false;
    const b = beltWatch.body;
    // the claim is only live while the claimant is still actually standing there watching. `until` is the
    // belt-and-suspenders: a body dropped from crew mid-watch keeps goal==='watch' forever, and the claim
    // must not outlive it. Either failure just clears the slot for whoever asks next.
    if (!b || b.unplaced || b.goal !== 'watch' || now > beltWatch.until) { beltWatch = null; return false; }
    return true;
  }
  function decayHabits(now) {
    if (now < forgetAt) return;
    forgetAt = now + FORGET_MS;
    for (const [k, v] of seenCount) { if (v <= 1) seenCount.delete(k); else seenCount.set(k, v - 1); }
  }
  /* THE COMMANDER'S PRESENCE — the agent's sense of "where you are." lastCursor is the cursor's world
     position (cached on mousemove); userReturnUntil is a brief window after you return to the tab; deepLocks
     budgets the rare long "deep lock" to ~1 per session. These feed THE LOOK-UP + the cursor gaze-drift:
     the agent occasionally, silently, turns and looks up at you (eerie-sentient, never chatty). */
  let lastCursor = { wx: 0, wy: 0, t: -1e9 };
  let userReturnUntil = 0;
  let deepLocks = 0;
  /* TIER D · D4 — THE CURSOR IS A CREATURE. `cursorMoveT` is the last time the cursor actually MOVED a
     meaningful distance (not merely present) — THE CHASE only ever considers rolling when the cursor is
     both fresh AND actively moving (a still cursor is presence, not a lure). It's stamped in the mousemove
     handler alongside lastCursor. Distinct from lastCursor.t (which updates on every mousemove, even a
     1-pixel jitter) — this stamps on real displacement so a parked-but-twitching cursor doesn't read as
     "moving". A user INPUT signal (allowed by G6 — never Math.random/Date.now for behavior). */
  let cursorMoveT = -1e9;
  /* TIER D · D1 ATTENTIVE AUDIENCE — which agent the Commander currently has COMMS focus on (chat.js
     announces it via setChatFocus on every load(ws) rebind; null = no conversation / awakening interview).
     The focused body, while idle, drops its wander/quirk/social life and holds its attention on the Commander
     (see the chat-stare beat in decideIdle + the per-tick hold in tick/crewEngineStep). D0 plumbing only. */
  let chatFocusId = null;
  /* TIER D · D1 WARMTH (tune fix 2026-07-02) — COMMS is a PERSISTENT panel: it always has an active
     stream, so setChatFocus fires at boot and never clears. Without a decay the focused (usually hero)
     body would stare FOREVER — "it will just endlessly follow the users mouse." The stare is therefore
     held only while the conversation is WARM: on every genuine engagement (a focus switch/open = setChatFocus;
     typing / sending / a reply-run boundary = chatFocusPing) a FRESH random warmth window (`CHAT_WARM_MIN..MAX`,
     30–90s) is drawn into `chatWarmUntil`, and chatStareHold requires `fnow < chatWarmUntil`. When warmth lapses the hold
     simply stops engaging — the existing self-heal (decideIdle clears stilling on entry) returns the body
     to its normal idle life (quirks/social/chase/wander resume). Re-engaging re-warms it indefinitely. */
  const CHAT_WARM_MIN = 30000, CHAT_WARM_MAX = 90000;  // 30s–90s: a FRESH random window is drawn on each engagement, so the
                                                        // moment the stare loses interest is never predictable (design call: "Less predictable")
  let chatWarmUntil = -1e9;                  // absolute deadline (frame clock, fnow) past which the stare goes cold; -1e9 = never warm
  /* TIER D · D3 SOCIAL ENCOUNTERS — Tier C (gaze-only) grows bounded MOVEMENT beats. ONE live encounter
     station-wide (G4): `socialBeat` is the single slot — null, or {kind, aId, bId, until}. `until` is a HARD
     whole-encounter timeout so the slot ALWAYS frees, even if pathing fails / a body gets stuck / a participant
     despawns. Per-pair long cooldowns (`socialPairCd`, keyed by the sorted id pair) so the same duo never loops
     (K4 no cascade). Every fired encounter also arms the D2 station beat gate (armBeat) so social beats share the
     station calm budget with quirks (G5). Each participant carries its OWN plan on `body.social` (assigned once at
     initiation by startEncounter — the ONE documented cross-body write, K2); per-tick stepping (stepSocial) mutates
     ONLY self.social + self position/facing and reads a partner's position/flags READ-ONLY. All movement targets
     pass the zone clamp (tileInZone(zoneFor(body))) — a body NEVER steps outside its own zone (G3). Determinism:
     U.chance/U.irnd/U.pick/U.hash only. reduceMotion degrades D3 to Tier C glances (no walking). */
  let socialBeat = null;                    // the single live encounter slot (G4)
  const socialPairCd = new Map();           // "idA|idB" (sorted) -> earliest `now` the pair may re-encounter
  /* TIER D · D3 STATION LANE (rate retune 2026-07-02) — social used to select INSIDE the shared quirk gate
     (crewBeatDamp), so it lost the per-decide race to the quirk families (~0.085 vs 0.02) and starved to
     ~1 encounter/25min. It now has its OWN station cooldown lane (like THE CHASE's chaseGateUntil), decoupled
     from the quirk race so the encounter RATE is governed by this cooldown, not by whoever wins the gate — but
     a fired encounter STILL arms the shared gate (armBeat, in startEncounter) so total station calm is preserved
     (we re-slice the pie, we don't grow it). N=1 provably unchanged (a solo floor never has a pair → never
     rolls → never arms this lane).
     W5 (2026-08-14): the lane SPLIT in two — a conversation (huddle/border) and a silent beat (watch/follow)
     no longer draw the same cooldown, because a beat with no talking in it was rate-limiting the one Andrew
     wants to watch. See SOCIAL_STATION_CD_* / SOCIAL_QUIET_CD_* and armSocialBudget. */
  let socialGateUntil = -1e9;               // earliest `now` the next social encounter may be selected (own lane)
  /* TIER D · D4 THE CHASE (the headline, ultra-rare). Exactly ONE chaser station-wide, mutually exclusive
     WITH a live social beat (the same one-noticeable-thing-at-a-time discipline as the social slot). `chaseId`
     is the agentId of the current chaser (null = nobody chasing); the per-body chase plan lives on
     `body.chase = { phase, until, repathAt, faceX, faceY, hardUntil }`. `chaseGateUntil` is the LONG
     station-level cooldown (8-15 min) so most sessions see ZERO chases — rarity is sacred. Every walk target
     is re-clamped to the chaser's zone at EVERY repath (the cursor moves, so a one-time clamp isn't enough).
     Per-body mimic cooldown lives on `body.mimicCd` (quirk-band 45-90s). Both beats ride the goal/hold
     machinery ('mimic'/'chase') rather than a new state family, so summon/chat-focus/social exclusion all
     compose with the existing gates. Determinism: U.* + cursor input only (G6). */
  let chaseId = null;                       // agentId of the one live chaser, or null (station-level, like socialBeat)
  let chaseGateUntil = -1e9;                // earliest `now` the next chase may be considered (drawn LONG, 8-15 min)
  /* First-person self-talk — ONE conscious mind narrating its OWN state to itself. Never crew/colony
     banter (a lie for a solo agent). Every line is gated by curiositySay (no live bubble + global
     cooldown + the chatty trait), so they read as rare honest thoughts tied to the true inner state. */
  const CURIO_NEW_PROP = ['what is that?', 'thats new', 'when did this arrive?', 'let me see this', 'new hardware'];
  const CURIO_NEW_BELT = ['a conveyor!', 'where does this go?', 'a new line', 'that wasnt here before'];
  const CURIO_WATCH = ['cargo moving', 'busy line today', 'steady flow', 'there it goes', 'keep it moving'];
  const CURIO_STUDY = ['how does this run', 'let me look closer', 'curious', 'noted', 'interesting'];
  const CURIO_LOOK = ['hm.', 'all quiet', 'good station', '...', 'just taking it in'];
  const SELF_REST = ['need a breather', 'feet up for a bit', 'recharge', 'easy for a minute', 'resting the circuits'];
  const SELF_STIM = ['too quiet', 'something to do', 'restless', 'let me find something', 'need a spark'];
  const SELF_TEND = ['anything for me?', 'standing by', 'awaiting orders', 'still here, Commander', 'ready when you are'];
  const SELF_ONDUTY = ['on it', 'parsing', 'let me think', 'working it', 'processing'];
  const SELF_NOCOMPUTE = ['no terminal in this room', 'nothing to run on here', 'i need a computer here', 'this room has no compute'];   // G0.7: sat down to work in a room that grants no COMPUTE — said once, then silence
  const SELF_QUIET = ['...', 'cycles to spare', 'so quiet', 'just me and the stars', 'standing by'];
  const SELF_CONTEMPLATE = ['quiet out there', 'so much void', 'just... processing', 'the stars again', 'endless out there'];
  const SELF_DISPATCH = ['sent', 'delivered', 'thats away', 'reply is out', 'done and gone'];
  const SELF_GREET = ['yes, Commander?', 'still here', 'watching', 'at your service', 'go ahead'];
  const SELF_ACK = ['hm?', 'yes?', 'still here', 'watching'];
  /* LEISURE FLAVOUR, keyed by the catalog `use.kind`. Every prop with a `use` descriptor is a real
     destination an idle body walks to, so a line here is a truthful report of where it IS — never a
     claim about work. Kept eerie-not-cute: an agent using a vending machine is an agent noticing it
     does not eat. A kind with no entry simply says nothing, which is why adding a `use` row to the
     catalog never requires touching this table. */
  const USE_LINE = {
    pool: ['the angles are trivial', 'nobody to play', 'i rack them anyway', 'geometry, mostly'],
    poker: ['no one to bluff', 'the odds hold', 'dealt to empty chairs', 'i fold'],
    vend: ['i dont eat', 'the light is nice', 'row C never drops', 'for the company, then'],
    fridge: ['nothing in it for me', 'it hums back', 'cold and honest', 'still humming'],
    fish: ['they dont ask me anything', 'small orbits', 'it is restful', 'round and round'],
    dj: ['nothing queued', 'the room wants a beat', 'someday, a crowd', 'levels are fine'],
    gacha: ['one more', 'what falls out is chance', 'the capsules are empty', 'i like the sound'],
    locker: ['nothing of mine in here', 'someone elses things', 'all empty', 'closed again'],
    coffee: ['the smell registers', 'i cannot drink it', 'it is warm at least', 'for the ritual'],
    pet: ['it does not need feeding', 'it follows me', 'made of the same light', 'hello, then'],
    terra: ['sealed and content', 'it grows without us', 'a whole world in there', 'still alive'],
    bed: ['powering down', 'somewhere soft, for once', 'a few cycles', 'wake me if it matters'],
    bookshelf: ['spines i have not read', 'someone kept these', 'paper, still', 'a good shelf'],
    // SEAT LAW: the body STANDS at a beanbag now, so the old "i may not get up" line would be a lie
    beanbag: ['this is undignified', 'it holds the shape of the last one', 'nobody sat here in a while', 'acceptable'],
    pinball: ['tilt', 'the ball obeys physics, not me', 'high score is mine', 'one more ball'],
    seat: ['taking the weight off', 'a seat is a seat', 'i will sit a moment', 'this one is mine for now'],   // stool/chair: the ONE prop a body actually sits on
  };
  /* ---------- USE_BEAT: what USING a prop actually looks like (2026-08-08 idle-life pass) ----------
     Every leisure prop used to resolve to the SAME beat: stand (or sit) on the approach tile, hold
     for a flat 10-22s, fidget on the generic cadence. A pinball table and a bookshelf were the same
     behavior with different pixels behind the body — the props were scenery the agent happened to
     stand near, not things it DID anything with.

     Each row tunes the dials the beat actually has, keyed by the catalog's `use.kind`:
       dwell   [min,max] ms at the prop — how long the thing holds you
       fidget  [min,max] ms between the small look-away flicks (fast = engaged/twitchy, slow = absorbed)
       track   true = while dwelling, keep glancing at the prop's own animation (fish, holo pet,
               the arcade screen) instead of around the room.
     A kind with no row keeps the old generic beat, so adding a `use` row to the catalog never
     requires touching this table (same contract as USE_LINE).

     ⛔ NO GESTURE TRACK HERE. A first cut fired the sets' one-shot `gesture` animation on arrival
     and on a loop at the "active" machines, on the theory that it was a generic arm movement. It is
     not: that track is an arms-up STRETCH, so what shipped was an agent walking up to the arcade
     cabinet and stretching in front of it (Andrew, 2026-08-08: "makes 0 sense... it just walks up to
     the machines and starts stretching"). REUSING AN ANIMATION FOR SOMETHING IT DOES NOT DEPICT
     READS AS A BUG, NOT AS LIFE. A real "playing the machine" pose is new ART, not a flag in this
     table — until that art exists the honest beat is: stand at it, face it, and hold. */
  const USE_BEAT = {
    pinball:   { dwell: [22000, 40000], fidget: [8000, 14000], track: true },   // face the game; at most an occasional slow look away
    arcade:    { dwell: [22000, 40000], fidget: [8000, 14000], track: true },
    pool:      { dwell: [18000, 32000], fidget: [6000, 10000] },                // line up, hold, then move on
    poker:     { dwell: [16000, 28000], fidget: [6000, 10000] },
    dj:        { dwell: [14000, 26000], fidget: [5000, 9000] },
    juke:      { dwell: [6000, 12000],  fidget: [6000, 10000] },                // pick a track and move on
    gacha:     { dwell: [8000, 15000],  fidget: [5000, 9000] },                 // crank, watch, crank
    vend:      { dwell: [5000, 11000],  fidget: [1400, 2800] },
    fridge:    { dwell: [4000, 8000],   fidget: [1400, 2800] },
    coffee:    { dwell: [4000, 9000],   fidget: [1600, 3200] },                // a short stop — the ritual, not the drink
    locker:    { dwell: [5000, 10000],  fidget: [1600, 3200] },
    bookshelf: { dwell: [18000, 34000], fidget: [3000, 6000] },                // the longest, stillest dwell on the floor
    terra:     { dwell: [12000, 22000], fidget: [2600, 5200], track: true },
    fish:      { dwell: [14000, 26000], fidget: [2600, 5200], track: true },   // restful: it just watches
    pet:       { dwell: [9000, 18000],  fidget: [1400, 2800], track: true },
    bar:       { dwell: [12000, 24000], fidget: [7000, 12000] },
    tv:        { dwell: [14000, 26000], fidget: [2600, 5200], track: true },
    beanbag:   { dwell: [12000, 24000], fidget: [2600, 5200] },
    seat:      { dwell: [12000, 26000], fidget: [8000, 14000] },
  };
  /* QUIRKS — rare, gated, deliberately UNPREDICTABLE one-offs that surface an off-screen inner life
     (the "why did it just do that" beats). Eerie via stillness + ambiguity, never spooky one-liners.
     Lines stay sparse and unresolved; the SILENCE is the unsettling part. */
  // quirk/off-beat cooldowns are now PER-BODY (self.quirkCd / self.offbeatCd, seeded on the hero literal + crew init) —
  // J2: a body's gate must never throttle another body. (Module globals removed; maybeQuirk/offbeat read/write self.)
  // B3/D2 STATION RARITY BUDGET (G5): ONE station-wide gate for the CREW's noticeable eerie beats. It is NOT
  // cross-agent awareness (no body perceives another — that is Tier C); it is a rarity governor on the dice only.
  // Rates were tuned for ~1 body; without this, N crew all running the shared engine fire ~Nx the quirks/strolls/
  // off-beats/revisits and read busy/cute — breaking the Pass-7 stillness law. THE FAMILIES it governs: quirks
  // (incl. vigil/stare-entry, via maybeQuirk), stroll double-takes + considered pauses (maybeStrollBeat), off-beat
  // dwell-stretches (offbeat), and haunt revisits (maybeRevisit). MECHANISM: every fired beat (hero or crew) ARMS
  // a shared gate window drawn on the order of the per-family cooldowns (U.irnd 45-90s — the quirkCd range, no new
  // magic numbers); while armed, ALL crew rolls in the four families are hard-gated (multiplier 0). So the CREW's
  // COLLECTIVE noticeable-beat rate is bounded at ~1 per 45-90s regardless of crew count, and hero beats keep crew
  // quiet in their shadow. Monte-Carlo with the real constants (200 runs, 10min, 2s re-rolls): N=1 ≈ 6.9 beats/10min;
  // a 6-7 body floor ≈ 12.5-12.6 total ≈ 1.8x single-agent (was 6-7x undamped; an 8s/x0.35 soft damp only reached
  // ~5.7x) — the station worst case is ~2x N=1 (hero ~1x + crew collectively ~1x), NOT 1x, stated honestly.
  // Ambient TEXTURE (glances, cursor facing-drift, mutual-glance, wander) is deliberately NOT budgeted. N=1 PARITY:
  // crewBeatDamp short-circuits to 1 on self===agent BEFORE reading any gate state, so the HERO's rolls are
  // byte-identical to today at ANY crew count (J1) and a single-body floor (self is only ever agent) is a provable
  // no-op — armBeat's U.irnd draw can't shift outcomes either (U.chance/irnd are independent Math.random wrappers,
  // not a seeded stream). NO STARVATION: the gate is a timestamp vs the advancing U-driven frame clock — it always
  // expires, skipped rolls never mutate per-body cooldowns, and revisit re-considers every idle tick. Deterministic
  // (U.* only, wall-clock-free; J5). Subsumes the old per-quirk lastQuirkAt.
  let crewBeatGateUntil = -1e9;
  // 0 while the station gate holds a CREW roll, else 1; the hero (self===agent) is NEVER damped (parity).
  function crewBeatDamp(now) { return (self !== agent && now < crewBeatGateUntil) ? 0 : 1; }
  function armBeat(now) { crewBeatGateUntil = now + U.irnd(45000, 90000); }   // any fired beat (hero or crew) arms the station gate
  const Q_PONDER = ['hm.', '...', 'i wonder', 'strange', 'thinking'];
  const Q_STARE = ['...', 'are you there?', 'hello.', 'still watching?', 'hm.'];   // mostly it just stares in silence
  const Q_LISTEN = ['did you hear that?', 'something moved', '...', 'who is there'];
  const Q_STARTLE = ['!', 'whoa', 'what was that', 'huh!', 'oh'];   // sudden change right beside it
  const SELF_PLACE = ['there', 'better', 'that belongs here', 'mine now', 'hm, nice'];   // after placing its own decor
  const SELF_ROUNDS = ['all in order', 'good', 'belt is humming', 'as it should be', 'checks out'];   // ownership beat on a caretaker lap
  const SELF_SUPERVISE = ['good work', 'keep at it', 'coming along', 'steady', 'looking sharp', 'carry on'];   // D5: the OVERSEER's over-the-shoulder glance at a working crew body
  const SLEEP_LINE = ['...', 'powering down', 'standby', 'going quiet', 'resting'];   // dormant in the deep wind-down mood
  const MOURN_LINE = ['it was here', 'gone', 'where did it go', '...', 'something is missing', 'it was right here'];   // stands where a fond thing used to be
  const REVISIT_LINE = ['back here again', 'my spot', 'here is good', '...', 'i like it here'];                       // drawn back to a favorite haunt
  // WAKE_FIRST removed — the first-light thought is no longer spoken (no canned one-liners, ever).
  /* AGENT ACTS ON THE STATION (safety-railed): it rarely places its OWN small decor on EMPTY floor, and
     only ever moves/removes things from agentDecor (its own ids) — never the Commander's props. Capped +
     long-cooldown so it stays an Easter-egg "it rearranged its corner" moment, not clutter. NOTE: addProp
     hits the undo stack + persists (the wow: the corner changes between visits); a silent/agent-only
     mutation lane is a future refinement. */
  let placeCd = 0;
  const agentDecor = [];   // ids of decor THIS agent placed — the ONLY props it will ever move or remove
  const ownPlaced = new Set();   // every id it has EVER placed — so it never grieves its own artifacts (survives the agentDecor splice)
  // 1x1, blocks:false (never obstructs the agent or the Commander), and FLOOR-placeable: an agent picks
  // its own tile, so anything needing a wall behind it or a table under it can never be on this list.
  /* what an agent may place for ITSELF, personalising the station over time. Every entry MUST be 1x1
     and placeable on bare deck — emptySpotNear only ever validates a 1x1 footprint, and a 2x1 in here
     would be rejected forever by canPlaceProp and quietly waste the placement roll. Widened 2026-07-29
     past the original three so a long-running station accumulates a corner that looks lived-in rather
     than three plants and a coffee machine. */
  const AGENT_DECOR = ['plant', 'coffee', 'monstera', 'tallplant', 'terrarium', 'bookstack', 'toolbox', 'crt_pile', 'holopet'];
  const specOf = t => (typeof PropSprites !== 'undefined' && PropSprites.spec) ? PropSprites.spec(t) : null;
  const dirToward = (fx, fy, tx, ty) => (Math.abs(tx - fx) > Math.abs(ty - fy)) ? (tx > fx ? 'east' : 'west') : (ty > fy ? 'south' : 'north');

  /* ---------- facing & gait (sprite turn smoothness) ----------
     A walking body's facing used to be a bare `Math.abs(dx) > Math.abs(dy)` snap on the residual-to-waypoint,
     recomputed every frame. Two artefacts fell out of that: near a 45° heading the bucket flipped on velocity
     noise (the body strobed between two poses), and a real turn teleported the pose 90° in a single frame.
     Instead we keep a CONTINUOUS facing angle per body, slew it toward the heading at a capped rate, and bucket
     THAT with hysteresis — a turn reads as a turn, and a bucket boundary can no longer chatter.
     `dir` stays the same 4-value string every other system (glance / sit / OPP / social / dirToward) already
     writes and reads; when one of them sets `dir` directly we resync the angle from it, so a deliberate
     head-turn still wins instantly. `odo` is the walk odometer in world units; assets.js drawBody converts it
     to a frame via a stride DERIVED from each skin's drawn height and frame count, so this stays skin-agnostic. */
  const DIR_A = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };
  const TURN_RATE = 9;       // rad/s CEILING for the facing slew (see the easing in stepGait)
  const TURN_ACCEL_A = 55;   // rad/s² — the facing spins up and brakes instead of slewing flat
  const TURN_FOOT_R = 4.2;   // world units from the pivot axis to the feet: a 90° pivot ≈ one stride
  const DIR_HYST = 0.13;     // rad (~7.5°) a bucket holds PAST its own boundary before handing over
  const ACCEL = 150;         // world units/s² — spools up to hero pace in ~0.23s, and brakes at the same rate
  const CORNER_LOOK = 2.5;   // world units: hand over to the next waypoint this early (see the walk blocks)
  const angNorm = a => Math.atan2(Math.sin(a), Math.cos(a));   // wrap to (-π, π]
  function bucketDir(a, cur) {
    if (cur && DIR_A[cur] != null && Math.abs(angNorm(a - DIR_A[cur])) < Math.PI / 4 + DIR_HYST) return cur;
    let best = 'south', bd = Infinity;
    for (const d in DIR_A) { const t = Math.abs(angNorm(a - DIR_A[d])); if (t < bd) { bd = t; best = d; } }
    return best;
  }
  /* ONE call per moving body per frame. Eases the walk speed, advances the facing angle, buckets it to a
     sprite direction, keeps the stride odometer — and returns how far to move THIS frame.
     Speed easing: bodies used to jump 0 → full pace and back in a single frame. Because the walk cycle is
     now DISTANCE-phased (assets.js), easing the speed automatically eases the LEG cycle too — a body visibly
     spools up and settles instead of skating off at full tilt, for free.
     `lastLeg` brakes into the FINAL stop only; intermediate waypoints are taken at pace so the body doesn't
     stutter at every corner. dx,dy = the vector it is stepping along, d = its length. */
  function stepGait(b, dx, dy, d, top, lastLeg, dt) {
    if (b.faceA == null || b.dir !== b.faceDir) b.faceA = DIR_A[b.dir] != null ? DIR_A[b.dir] : Math.PI / 2;
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (b.odo == null || t - (b.odoAt || 0) > 150) { b.odo = 0; b.spd = 0; }   // wasn't walking last frame → a NEW walk
    b.odoAt = t;
    const want = lastLeg ? Math.min(top, Math.sqrt(Math.max(0, d) * 2 * ACCEL)) : top;
    const rate = ACCEL * dt / 1000, cur = b.spd || 0;
    b.spd = cur < want ? Math.min(want, cur + rate) : Math.max(want, cur - rate);
    const step = Math.min(d, b.spd * dt / 1000);
    if (d > 1e-4) {
      const turn = angNorm(Math.atan2(dy, dx) - b.faceA);
      const s = dt / 1000, remain = Math.abs(turn);
      // Angular ACCELERATION, not a flat rate — the same easing the linear speed gets above. A
      // constant slew made a cornering body read as a turntable: it pivoted at a machine-perfect
      // rate while its legs stood still. Brake term arrives at the heading at rest.
      const target = Math.min(TURN_RATE, Math.sqrt(2 * TURN_ACCEL_A * remain));
      const curW = b.angW || 0;
      b.angW = curW < target ? Math.min(target, curW + TURN_ACCEL_A * s)
                             : Math.max(target, curW - TURN_ACCEL_A * s);
      const swept = Math.min(remain, b.angW * s);
      b.faceA = angNorm(b.faceA + Math.sign(turn) * swept);
      // The feet also travel when the body pivots — they sweep an arc about the stance centre. Adding
      // that arc to the stride odometer keeps the legs cycling through a corner instead of freezing
      // mid-stride while the sprite rotates, which is what made cornering look like sliding.
      b.odo += step + swept * TURN_FOOT_R;
    }
    b.dir = b.faceDir = bucketDir(b.faceA, b.dir);
    return step;
  }

  /* ================= furniture (ported v7 sprites.js F.desk / F.chair) ================= */
  const fpx = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const fblink = (p, ph) => ((fnow / p + (ph || 0)) % 1) < 0.5;
  const fscrCols = ['#62ff9e', '#3fd07c', '#7adfb0', '#2fa863'];
  const fscr = (ph) => fscrCols[Math.floor((fnow / 700 + ph) % fscrCols.length)];
  const fsh = (x, y, w) => { ctx.globalAlpha = 0.22; fpx(x, y, w, 2, '#000'); ctx.globalAlpha = 1; };
  const fglow = (x, y, w, h, c, a) => { ctx.globalAlpha = a; fpx(x, y, w, h, c); ctx.globalAlpha = 1; };
  const fbox = (x, y, w, h, c) => {
    fpx(x - 1, y - 1, w + 2, h + 2, '#06090c'); fpx(x, y, w, h, c);
    fpx(x, y, w, 1, U.shade(c, 0.28)); fpx(x, y + h - 1, w, 1, U.shade(c, -0.4));
    fpx(x + w - 1, y + 1, 1, h - 2, U.shade(c, -0.22)); fpx(x, y + 1, 1, h - 2, U.shade(c, 0.08));
  };
  const finset = (x, y, w, h, c) => { fpx(x, y, w, h, U.shade(c, -0.6)); fpx(x + 1, y + 1, w - 2, h - 2, c); fpx(x + 1, y + 1, w - 2, 1, U.shade(c, -0.3)); };
  const fseamH = (x, y, w, c) => { fpx(x, y, w, 1, U.shade(c, -0.45)); fpx(x, y + 1, w, 1, U.shade(c, 0.14)); };
  const frivets = (x, y, w, h, lc, dc) => { fpx(x, y, 1, 1, lc); fpx(x + w - 1, y, 1, 1, lc); fpx(x, y + h - 1, 1, 1, dc); fpx(x + w - 1, y + h - 1, 1, 1, dc); };
  // `>>>` not `>>` — U.hash returns a uint32 and the signed shift went negative for any hash >= 2^31,
  // scattering specks above the rect. Same fix as propsprites.js wear(); keep the two in step.
  const fwear = (x, y, w, h, n, c) => { if (w < 4 || h < 4) return; for (let i = 0; i < n; i++) { const hx = U.hash('w' + x + ',' + y + ',' + i); fpx(x + 1 + (hx % (w - 2)), y + 1 + ((hx >>> 5) % (h - 2)), 1 + (hx % 2), 1, c); } };
  const fscanl = (x, y, w, h, a) => { ctx.globalAlpha = a; for (let j = 1; j < h; j += 2) fpx(x, y + j, w, 1, '#000'); ctx.globalAlpha = 1; };

  function F_desk(x, y, w, h, f) {
    fsh(x + 1, y + h, w - 2);
    fbox(x, y + 3, w, h - 2, '#343e46');
    fpx(x + 1, y + 4, w - 2, h - 4, '#414d56');
    fpx(x + 1, y + 4, w - 2, 1, '#54626c');
    fpx(x + 1, y + 4, 6, 1, '#64727c');
    fseamH(x + 1, y + h - 3, w - 2, '#414d56');
    fpx(x + w - 8, y + h - 2, 3, 1, '#2a343c');
    frivets(x + 1, y + 4, w - 2, h - 5, '#5e6c76', '#222b32');
    fwear(x + 1, y + 4, w - 2, h - 5, 3, '#37424a');
    fpx(x + 5, y + 4, 2, 1, '#1a241e'); fpx(x + 4, y + 5, 4, 1, '#222c26');
    fbox(x + 2, y - 3, 8, 7, '#1a241e'); fpx(x + 3, y - 3, 6, 1, '#2c3a30');
    finset(x + 3, y - 2, 6, 5, '#0d150f');
    if (f.work) {
      fpx(x + 4, y - 1, 4, 3, fscr(f.x)); fpx(x + 4, y - 1, 2, 1, '#dfffe8');
      fpx(x + 4, y + 1, 3, 1, U.shade(fscr(f.x), -0.3));
      if (fblink(180, f.x)) fpx(x + 4, y - 1, 3, 1, '#dfffe8');
      fpx(x + 7, y + 1, 1, 1, fblink(400, f.x) ? '#dfffe8' : '#101a14');
      fscanl(x + 4, y - 1, 4, 3, 0.2);
      fglow(x + 2, y + 4, 8, 2, fscr(f.x), 0.18); fglow(x + 3, y - 2, 6, 5, fscr(f.x), 0.10);
      // G0.3 ACTIVITY HEAT: real token/tool flow burns the screen brighter + shimmers faster; a stalled
      // run cools back to the base glow in ~2s. f.heat is the truthful per-agent heat (heatFor), 0..1.
      if (f.heat > 0) {
        const hshim = 0.72 + 0.28 * Math.sin(fnow / (170 - 110 * f.heat));
        fglow(x + 2, y - 3, 8, 8, fscr(f.x), (0.10 + 0.42 * f.heat) * hshim);
      }
      // G0.2 PROGRESS STRIP: drawn ONLY when a REAL fraction was published (f.prog, from the 'task'
      // bus contract's prog/dur) — a live harness run has no knowable % and never gets a bar.
      if (f.prog != null) {
        const pw = Math.max(1, Math.round(6 * Math.max(0, Math.min(1, f.prog))));
        fpx(x + 2, y - 6, 8, 3, '#06090c');            // strip housing above the monitor
        fpx(x + 3, y - 5, 6, 1, '#12251a');            // dark channel
        fpx(x + 3, y - 5, pw, 1, '#62ff9e');           // the honest fraction
        fglow(x + 3, y - 6, pw, 3, '#62ff9e', 0.35);
      }
    } else {
      fpx(x + 4, y - 1, 4, 3, '#101a14'); fpx(x + 4, y - 1, 1, 1, '#1c2a22');
      fpx(x + 9, y + 2, 1, 1, fblink(1600) ? '#ff9d2e' : '#33241a');
    }
    fpx(x + 9, y + 4, 1, 2, '#222b32');
    finset(x + 13, y + 6, 6, 3, '#262e2a'); fpx(x + 14, y + 7, 4, 1, '#39443e'); fpx(x + 14, y + 7, 2, 1, '#46544a');
    fpx(x + 20, y + 7, 1, 1, '#39443e'); fpx(x + 20, y + 7, 1, 1, '#46544a');
    fpx(x + 2, y + 8, 2, 2, '#3a6a62'); fpx(x + 2, y + 8, 2, 1, '#5aa89c');
    if (f.work && fblink(700)) fpx(x + 3, y + 6, 1, 1, '#8a8a8a');
    fpx(x + 11, y + 5, 2, 2, '#ffe066'); fpx(x + 11, y + 5, 2, 1, '#fff0a8');
  }

  function F_chair(x, y) {
    ctx.globalAlpha = 0.2; fpx(x + 3, y + 9, 6, 2, '#000'); ctx.globalAlpha = 1;
    fpx(x + 3, y + 1, 6, 2, '#3a4a40'); fpx(x + 3, y + 1, 6, 1, '#46584c');
    fpx(x + 3, y + 1, 1, 2, '#41544a'); fpx(x + 8, y + 1, 1, 2, '#2e3c34');
    fpx(x + 4, y + 2, 4, 1, '#33413a');
    fpx(x + 3, y + 3, 6, 6, '#2e3a34');
    fpx(x + 4, y + 4, 4, 2, '#39463f'); fpx(x + 4, y + 4, 4, 1, '#41504a');
    fpx(x + 4, y + 6, 1, 1, '#27322c'); fpx(x + 7, y + 6, 1, 1, '#27322c');
    fpx(x + 3, y + 8, 6, 1, '#242e29');
    fpx(x + 5, y + 9, 2, 1, '#39434b'); fpx(x + 5, y + 9, 1, 1, '#46535c');
    fpx(x + 4, y + 10, 1, 1, '#222'); fpx(x + 7, y + 10, 1, 1, '#222');
    fpx(x + 5, y + 10, 2, 1, '#2a2a2a'); fpx(x + 4, y + 11, 1, 1, '#1a1a1a'); fpx(x + 7, y + 11, 1, 1, '#1a1a1a');
  }

  /* ================= station model + bake ================= */
  function loadStation(st) {
    if (unsub) { unsub(); unsub = null; }
    station = st; geo = null; cache = null; geoDirty = true; bakeDirty = true; fitNeeded = true;
    novelty = []; seenProps = null; seenBelts = null;   // re-learn the scene from scratch (no cross-station novelty)
    beltWatch = null;                                   // ...and the belt-watch claim: this floor's belts are gone, so a claim on them is a ghost holding the slot
    clearDeferredShips();                               // a crate waiting on the OLD floor's handoff must never land on this one
    dockLineWork.clear();
    propFoot = new Map(); pendingMourn = null;          // forget where things stood (no cross-station grief)
    agentDecor.length = 0; ownPlaced.clear(); placeCd = 0;   // forget which decor it placed (the new floor is a clean slate)
    if (agent && agent.fond) agent.fond.clear();        // forget the old floor's haunts — the new floor earns its own
    crew = crew.filter(b => b.summoned);                // drop plan-derived crew (rebuilt from the new floor's bays); KEEP summoned crew (app-level, not floor-bound)
    if (station && station.onChange) unsub = station.onChange(() => { geoDirty = true; });
    rederive();
  }

  function rederive() {
    if (!station) return;
    const next = station.projectGeometry();
    const oldOrigin = geo ? geo.origin : null;
    geo = next; T = geo.TILE;
    computeOkCache.clear();        // G0.7: placements changed — re-answer "can this agent's room actually run?"
    placeDesk();
    compileRouting();              // recompile the RoutingPlan (+ POST to the sidecar) — the single point floor edits flow through
    junctions = buildJunctions();
    // CREW RE-FRAME (agent-in-the-void escape, 2026-07-12): crew bodies live in the same LOCAL pixel
    // frame as the hero, but only the hero got the origin-shift correction below — so any floor edit
    // that moved the station's bounding box (a room added/removed at the north/west edge) left every
    // crew body's px/py in the OLD frame, rendering it offset into the void, with its old-frame path
    // walking it further out. Mirror the hero's treatment for EVERY crew body BEFORE syncCrewFromPlan
    // (whose walkable checks must see new-frame positions): shift the pixels (and the seated render
    // pos + leash home, same frame), then drop the in-flight path so it re-plans in the new frame.
    if (oldOrigin) {
      const cdx = (oldOrigin.tx - geo.origin.tx) * T, cdy = (oldOrigin.ty - geo.origin.ty) * T;
      // riding crates + queued work live in the SAME local tile frame as the crew — an unshifted box
      // reads "belt pulled out" next tick and sinks paid work mid-ride (audit #4, 2026-08-11)
      if (convey && convey.shiftFrame) convey.shiftFrame(oldOrigin.tx - geo.origin.tx, oldOrigin.ty - geo.origin.ty);
      for (const b of crew) {
        if (cdx || cdy) {
          b.px += cdx; b.py += cdy;
          b.seatPx += cdx; b.seatPy += cdy;
          if (b.pendSeat) { b.pendSeat.px += cdx; b.pendSeat.py += cdy; }
          if (b.home) { b.home.x += oldOrigin.tx - geo.origin.tx; b.home.y += oldOrigin.ty - geo.origin.ty; }
        }
        b.pathPts = null; b.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        b.attn = null;                       // the attention anchor is a TILE in the old frame — drop it (same treatment as the in-flight path; a stale anchor would aim strolls at a tile that is now somewhere else entirely)
        if (b.state === 'walk') { b.state = 'idle'; b.idleUntil = 0; }
      }
    }
    syncCrewFromPlan();            // reconcile the light crew bodies with the plan's bound bays
    if (agent) {
      if (agent.unplaced) placeAgent();
      else {
        if (oldOrigin) { const dx = (oldOrigin.tx - geo.origin.tx) * T, dy = (oldOrigin.ty - geo.origin.ty) * T; agent.px += dx; agent.py += dy; }
        agent.pathPts = null; agent.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        agent.attn = null;                           // ditto the attention anchor (a TILE): drop rather than shift, so a refit can never aim a stroll at a stale-frame tile
        if (agent.state === 'walk') { agent.state = 'idle'; agent.idleUntil = 0; }  // target's gone — never leave the agent stuck in the walk pose, or it moonwalks in place forever (tick's idle re-decision is gated on state!=='walk')
        if (agent.goal === 'use' || agent.goal === 'lounge' || agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare' || agent.goal === 'place' || agent.goal === 'rounds' || agent.goal === 'post' || agent.goal === 'sleep' || agent.goal === 'mourn' || agent.goal === 'revisit' || agent.goal === 'firstwake') { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.studyKey = null; agent.quirkKind = null; agent.placeTarget = null; agent.removeId = null; agent.roundsQueue = null; agent.wakePhase = 0; agent.glanceCd = 0; agent.sitting = false; }  // the prop/belt list may have changed — drop leisure/observation/quirk/placement/rounds/board-survey/sleep/grief/wake-ritual, re-decide next idle tick (firstWakeDone stays latched, so the ritual never re-arms)
        if (agent.goal === 'work' && !agent.working) agent.goal = null;  // was mid-walk to the desk — drop it so tick's summon logic re-paths in the new frame
        if (agent.working && seat) { const f = seatFoot(seat); agent.px = f.x; agent.py = f.y; agent.dir = deskFace || 'north'; }  // follow the desk (work only — a lounging agent must NOT teleport to the desk)
        ensureAgentValid();
      }
    }
    scanNovelty();   // diff props/belts vs last frame — anything new becomes a "go check it out" target
    geoDirty = false; bakeDirty = true;
  }

  function rebake() {
    if (geoDirty || !geo) rederive();
    if (!geo) return;
    cache = StationBake.bake(geo);
    bakeDirty = false;
    recordBakeProbe();
  }

  /* ---------- CANVAS-LOSS RECOVERY — the station may never silently go black ----------
     Andrew, 2026-08-15, on 0.10.2: "the station randomly went black and the only thing that
     appears is the agents, and the props."

     That symptom names its own cause precisely. Every layer that is NOT redrawn from scratch
     each frame lives in an offscreen <canvas>: the station bake (floors, walls, hull + the
     lightmap), the SpaceBG sky, the Terrain ground. Agents draw from <img> sprite sheets and
     props draw procedurally, so those two are rebuilt on every single frame — and those two
     are exactly what survived.

     A GPU/driver reset — sleep-wake, a display or DPI change, a TDR, the WebView's GPU process
     restarting — zeroes the backing store of every accelerated 2D canvas in the page. The
     canvas OBJECTS survive at full size, their PIXELS do not, and NO exception is thrown. So
     nothing downstream can tell: `cache` is still a well-formed bake, and frameBody blits a
     fully transparent plate over a base fill, every frame, forever. It never heals on its own,
     because a bake only re-runs when the GEOMETRY changes and no geometry changed.

     Two defences, because they fail on different days:
       1. the CONTEXT EVENTS ('contextlost'/'contextrestored', wired in init) — the browser
          telling us directly. Correct and instant when the runtime bothers to fire them.
       2. this WATCHDOG — a pixel the bake painted opaque, re-read at most once a second. It
          needs no cooperation from the runtime, so it also catches a plate that was dropped
          without an event (and any future regression that blanks the bake).
     The probe costs one 1x1 readback a second, against a frame it saves entirely. */
  let bakeProbe = null;        // {x,y} a pixel buildBase painted opaque — the loss sentinel
  let probeOff = false;        // getImageData refused (tainted canvas): never retry, never spam
  let lastProbeAt = 0;         // throttle — the sentinel is read a few times a second, not per frame
  let lastRecoverAt = 0;       // when the last recovery ran (only consulted while backing off)
  let futileRecoveries = 0;    // consecutive recoveries that did NOT restore an opaque bake
  let recoveries = 0;
  const PROBE_MS = 250, RECOVER_COOLDOWN_MS = 3000;

  /* Find one pixel the fresh bake painted OPAQUE. Centre first (on any real station the middle
     of the footprint is deck), then a coarse ring outward — so the common case is a single
     readback and a hole-in-the-middle layout still finds floor. Finding none is not an error:
     it means there is nothing to sentinel (a 1x1 blank bake, or an empty station), and the
     watchdog simply stays inert rather than rebaking a legitimately empty frame forever. */
  function recordBakeProbe() {
    bakeProbe = null;
    if (probeOff || !cache || !cache.baseCv) return;
    const c = cache.baseCv, W = c.width, H = c.height;
    if (W < 2 || H < 2) return;
    const pts = [[0.5, 0.5], [0.5, 0.32], [0.5, 0.68], [0.3, 0.5], [0.7, 0.5],
                 [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
    try {
      const g = c.getContext('2d');
      for (const [fx, fy] of pts) {
        const x = Math.min(W - 1, Math.max(0, Math.round(W * fx)));
        const y = Math.min(H - 1, Math.max(0, Math.round(H * fy)));
        if (g.getImageData(x, y, 1, 1).data[3] > 0) { bakeProbe = { x, y }; return; }
      }
    } catch (e) { probeOff = true; }
  }

  // has the bake's backing store been zeroed under us? (opaque -> transparent is the tell)
  function bakeWentBlank() {
    if (!bakeProbe || probeOff || !cache || !cache.baseCv) return false;
    try {
      return cache.baseCv.getContext('2d').getImageData(bakeProbe.x, bakeProbe.y, 1, 1).data[3] === 0;
    } catch (e) { probeOff = true; return false; }
  }

  /* Rebuild everything that lives in an offscreen canvas. Only `bakeDirty` is set (never
     `cache = null`): if rederive cannot produce geometry, rebake early-returns and the LAST
     GOOD bake is still better than the honest-but-empty backdrop path. */
  function recoverLostCanvases(now, why) {
    /* BACK OFF ONLY WHEN RECOVERY IS NOT WORKING. A flat cooldown was the obvious guard and it
       was wrong: proved live by wiping the plates five times in a row, where a cooldown earned
       by the FIRST loss made the station sit black through the next one. A recovery that
       restored an opaque bake is proof the GPU is healthy, so the next loss must heal on the
       spot; only a recovery that changed nothing (futile) is evidence of a broken GPU worth
       rate-limiting. Recovering is cheap. Sitting in a black station is not. */
    if (futileRecoveries > 0 && now - lastRecoverAt < RECOVER_COOLDOWN_MS) return false;
    lastRecoverAt = now; recoveries++;
    try {
      console.warn('[world] cached canvases lost (' + why + ') — rebuilding station + sky + ground (recovery #' + recoveries + ')');
    } catch (_) {}
    bakeDirty = true; bakeProbe = null;
    try { if (typeof SpaceBG !== 'undefined' && SpaceBG.invalidate) SpaceBG.invalidate(); } catch (_) {}
    try { if (typeof Terrain !== 'undefined' && Terrain.invalidate) Terrain.invalidate(); } catch (_) {}
    return true;
  }

  /* per-frame (throttled) sentinel read — called from frameBody. Heals in THIS frame: rebake()
     re-records the probe, so whether the fresh plate came back opaque is knowable immediately,
     which is what tells a healthy GPU apart from a broken one. */
  function watchCanvasLoss(now) {
    if (now - lastProbeAt < PROBE_MS) return;
    lastProbeAt = now;
    if (!bakeWentBlank()) { futileRecoveries = 0; return; }
    if (!recoverLostCanvases(now, 'bake sentinel went transparent')) return;
    rebake();
    futileRecoveries = bakeProbe ? 0 : futileRecoveries + 1;
  }

  /* ---------- STAGE CONTEXT LOSS — the OTHER way the station goes black ----------
     User report, 2026-08-24: the whole viewport black — no agents, no props — HUD alive,
     every 10-20 minutes, permanent until an app restart. The bake watchdog above cannot see
     that mode: it probes the OFFSCREEN bake plate, and in this failure the offscreen caches
     are fine — it is the VISIBLE stage's own 2D context that died. A dead 2D context no-ops
     every draw call silently, so the loop keeps "painting" a canvas that displays nothing.
     preventDefault() on 'contextlost' asks the browser to restore it, but when
     'contextrestored' never arrives (repeated GPU-process resets do this) the page holds the
     only reference to a context that will never work again. The ONLY recovery then is a new
     canvas element with a new context — invalidating caches cannot help.

     Detection is the same philosophy as the bake sentinel: the frame's last act paints ONE
     opaque black pixel at (0,0) (invisible — that corner is vignetted space). A live context
     leaves alpha 255 there; a dead one leaves the transparent void of its zeroed backing
     store. `isContextLost()` is consulted too when the runtime offers it, but the pixel is
     the proof that needs no cooperation. */
  let stageProbeArmed = false;   // set by the first opaque heartbeat read — proof this stage CAN paint (a fresh canvas is transparent and innocent)
  let stageProbeOff = false;     // getImageData refused for SECURITY (tainted) — disable, never spam. Other throws are treated as loss, not taint.
  let stageDeadSince = 0;        // first probe that found the heartbeat gone (0 = healthy); survives a rebuild until a healthy read proves the cure
  let lastStageProbeAt = 0;
  let stageRebuilds = 0;         // total stage rebuilds this session (telemetry for _dbgStageState)
  let stageFutile = 0;           // rebuilds not yet proven by a healthy read — only THIS rate-limits retries (same law as futileRecoveries)
  let lastStageRebuildAt = 0;
  const STAGE_GRACE_MS = 3000;   // give 'contextrestored' its chance first, and absorb innocent one-probe blanks (a resize clears the bitmap mid-frame)

  // the frame's last act: one opaque pixel a dead context cannot fake (see block comment above)
  function paintStageHeartbeat() {
    if (!ctx) return;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1, 1);
    } catch (_) {}
  }

  function stageWentBlank() {
    if (stageProbeOff || !cv || !ctx || cv.width < 2 || cv.height < 2) return false;
    try {
      const a = ctx.getImageData(0, 0, 1, 1).data[3];
      if (a > 0) { stageProbeArmed = true; return false; }
      return stageProbeArmed;   // transparent before the first proven paint is a fresh canvas, not a loss
    } catch (e) {
      if (e && e.name === 'SecurityError') { stageProbeOff = true; return false; }   // tainted: unknowable forever, stand down
      return stageProbeArmed;   // a lost context may THROW on readback — an unreadable stage is no healthier than a blank one
    }
  }

  function watchStageLoss(now) {
    if (now - lastStageProbeAt < PROBE_MS) return;
    lastStageProbeAt = now;
    let lost = false;
    try { lost = !!(ctx && typeof ctx.isContextLost === 'function' && ctx.isContextLost()); } catch (_) {}
    if (!lost && !stageWentBlank()) { stageDeadSince = 0; stageFutile = 0; return; }
    if (!stageDeadSince) { stageDeadSince = now; return; }
    if (now - stageDeadSince < STAGE_GRACE_MS) return;   // the restore window (and the innocent-blank filter)
    /* Same backoff law the bake watchdog earned live: never rate-limit the remedy on a timer,
       rate-limit it on whether it WORKED. A rebuild is proven by the next healthy heartbeat
       read (which clears stageFutile above); until then further attempts wait out the cooldown. */
    if (stageFutile > 0 && now - lastStageRebuildAt < RECOVER_COOLDOWN_MS) return;
    lastStageRebuildAt = now;
    stageFutile++;   // provisional — the first healthy probe after the rebuild clears it
    rebuildStage('context dead ' + Math.round((now - stageDeadSince) / 1000) + 's with no restore');
    // the REST of this frame draws onto the fresh context — detect and heal share one frame, no black flash
  }

  /* The dead canvas is unsalvageable; its replacement must be indistinguishable: same attributes
     (id carries the CSS), same bitmap size, same input wiring (the old node's listeners died with
     it), same ResizeObserver watch. Everything else in the file reaches the stage through the
     closure `cv`/`ctx`, so swapping those two references completes the transplant. */
  function rebuildStage(reason) {
    if (!cv) return false;
    try {
      const old = cv, fresh = document.createElement('canvas');
      for (const a of old.attributes) { try { fresh.setAttribute(a.name, a.value); } catch (_) {} }
      fresh.width = old.width; fresh.height = old.height;
      const g = fresh.getContext('2d');
      if (!g) return false;
      if (old.parentNode) old.parentNode.replaceChild(fresh, old);
      cv = fresh; ctx = g;
      drag = null; hoverAgent = null; hoverBeltTile = null; hoverOutbox = null;   // pointer state died with the old node
      wireStageInput();
      try { if (ro) { ro.disconnect(); ro.observe(cv.parentElement || cv); } } catch (_) {}
      resize();
      stageRebuilds++;
      try { console.warn('[world] stage canvas rebuilt (' + reason + ') — rebuild #' + stageRebuilds); } catch (_) {}
      return true;
    } catch (e) { return false; }
  }

  /* ---------- G0.7 empty-room honesty: can this agent's runs actually pass the COMPUTE GATE? ----------
     Only decidable for a BAY-BOUND agent — the bay's room is the capability seam the sidecar resolves
     tools from (station.bayObjects mirrors resolveTools' input, incl. the dedicated-PC rule). The HERO
     gets compute as the interactive freebie (see heroCaps) and a bayless summoned worker runs on lead-
     conferred access — both are always OK here: we never claim a lie we cannot prove. Cached per geo
     generation (computeOkCache cleared in rederive) so the per-frame lit check stays O(1). */
  const computeOkCache = new Map();   // agentId -> bool
  function agentComputeOK(aid) {
    if (!station || !aid || (agent && aid === agent.id)) return true;
    if (typeof station.agentRoomId !== 'function' || typeof station.bayObjects !== 'function') return true;
    if (!station.agentRoomId(aid)) return true;   // no bay -> not room-resolved -> can't honestly call it dark
    return station.bayObjects(aid).some(o => (o && typeof o === 'object' ? o.objectType : o) === 'computer');
  }
  function computeOkFor(aid) {
    if (!computeOkCache.has(aid)) computeOkCache.set(aid, agentComputeOK(aid));
    return computeOkCache.get(aid);
  }

  // a PLACED workstation prop lights its screens while the agent assigned to it is working (mirrors the synthetic
  // desk's work-glow + the bay-lit pattern) — so an assigned desk reads as "its agent is here, working".
  // (The agent's desk + seat are resolved by the shared deskPropFor/deskSeat helpers defined further below.)
  function workstationLit(p) {
    if (!p.agentId || !isWorkstationProp(p.t)) return false;
    if (agent && p.agentId === agent.id) return !!agent.working;
    const b = crew.find(x => x.agentId === p.agentId);
    if (!b || !b.working) return false;
    // G0.7 EMPTY-ROOM HONESTY: a bay whose room grants no COMPUTE cannot actually run — its screens
    // stay dark even in the working pose (the run dies at the compute gate; capdenied shows why).
    return computeOkFor(p.agentId);
  }

  // the workstation: the hero's ASSIGNED desk if it placed one, else a 2-wide desk on the spawn room's north wall.
  function placeDesk() {
    blocked = new Set();
    deskPropId = null; deskFace = 'north';
    // 1) the hero's own assigned workstation prop → THAT desk is its seat (it walks here + sits when tasked).
    //    Uses the SAME desk+seat resolver as crew (deskPropFor/deskSeat) so the hero & crew seat identically.
    const home = agent && deskPropFor(agent.id), hs = home && deskSeat(home);
    if (home && hs) {
      desk = { tx: home.x, ty: home.y, w: home.w || 1, h: home.h || 1 }; seat = { tx: hs.tx, ty: hs.ty, cx: hs.cx };
      deskPropId = home.id; deskFace = hs.face;
      for (let dx = 0; dx < (desk.w || 1); dx++) for (let dy = 0; dy < (desk.h || 1); dy++) blocked.add((desk.tx + dx) + ',' + (desk.ty + dy));
      return;   // the placed prop + its chair are drawn by the render loop (skip the synthetic desk/chair)
    }
    // 2) fallback: the auto workstation on the spawn room's north wall, seat one row below.
    const sid = station.spawnRoomId(), z = sid && geo.zones[sid];
    if (!z || (z.x2 - z.x1) < 1 || (z.y2 - z.y1) < 1) { desk = seat = null; return; }
    let dtx = z.x1 + Math.max(1, Math.floor((z.x2 - z.x1) / 2));
    if (dtx + 1 > z.x2) dtx = Math.max(z.x1, z.x2 - 1);
    const dty = Math.min(z.y1 + 1, z.y2 - 1);
    desk = { tx: dtx, ty: dty, w: 2, h: 1 };
    seat = { tx: dtx, ty: Math.min(dty + 1, z.y2), cx: dtx + 0.5 };   // 2-wide desk -> centre sits on the tile seam
    blocked.add(dtx + ',' + dty); blocked.add((dtx + 1) + ',' + dty);
  }
  // walk the hero to its work seat (or snap onto it if unreachable) + enter the 'work' goal — the shared "now sit
  // and work" step, reached EITHER straight from on-duty OR after the conveyor-fetch leg below.
  function goToSeat(now) {
    agent.goal = 'work';
    if (!seat || !setPathTo({ x: seat.tx, y: seat.ty })) {
      if (seat) { const f = seatFoot(seat); agent.px = f.x; agent.py = f.y; agent.sitting = true; agent.working = true; agent.dir = deskFace || 'north'; }   // face the assigned desk (deskFace) when teleport-fallback seating
      return;
    }
    /* ALREADY STANDING ON THE SEAT TILE — sit down NOW instead of waiting for a walk that will never
       happen. geo.path returns [] (truthy!) for a same-tile route, so setPathTo reports "walk armed"
       with ZERO waypoints: nextWaypoint nulls the target, the walk stepper never fires arrive(), and
       `working` (set only by arrive's settle beat) stays false FOREVER. Nothing recovers it — the
       stuck-walker self-heal above only drops the walk POSE, and the desk-trip seize is gated on
       `goal !== 'work'`, which is already 'work'. Same `if (!self.target) arrive(now)` idiom the other
       zero-length callers use (tend / gaze / rounds).
       THE PATH THAT GETS HERE IS THE APPROVAL WALK: team.dispatch requires consent, so DELEGATING
       raises a permission.prompt; resolveWaitAnchor falls back to the hero's OWN desk when the floor
       has no airlock/mission board, so the trip back after permission.response is zero-length. The
       overseer then stood at its desk NOT working for the rest of a provably live run while COMMS and
       the crew panel both said WORKING (2026-07-27). Truthful telemetry cuts both ways: the world may
       no more assert idle over a live run than a panel may assert work over a dead one. */
    if (!agent.target) arrive(now);
  }
  // G4 feature 1: resolve WHERE the permission-blocked hero waits, honestly from the live floor. Reuses the
  // pure WaitAnchor ladder (airlock → mission board → own desk) + PropAnchor's approach-tile law, and clamps
  // the anchor into the agent's zone (wait at the nearest in-zone tile when the anchor is outside its area).
  // Returns { tx, ty, face, source } | null (null → the caller just stands in place at the desk).
  function resolveWaitAnchor() {
    if (typeof WaitAnchor === 'undefined' || !geo) return null;
    const zone = zoneFor(agent);
    // the nearest walkable, in-zone tile to a target — a small expanding-ring scan (no path, just proximity).
    function nearestInZone(tile) {
      if (!tile) return null;
      for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // ring shell only
        const tx = tile.tx + dx, ty = tile.ty + dy;
        if (geo.walkable(tx, ty, blocked) && tileInZone(zone, tx, ty)) return { tx, ty };
      }
      return null;
    }
    const home = agent && deskPropFor(agent.id), hs = home && deskSeat(home);
    const fallbackSeat = hs ? { tx: hs.tx, ty: hs.ty, face: 'south' } : (seat ? { tx: seat.tx, ty: seat.ty, face: 'south' } : null);
    return WaitAnchor.resolve({
      props: geo.props || [],
      anchorOf: (prop) => (typeof PropAnchor !== 'undefined' ? PropAnchor.deriveAnchor(prop, geo, { approach: 'south', extra: blocked }) : null),
      seat: fallbackSeat,
      zoneAllows: (tx, ty) => tileInZone(zone, tx, ty),
      nearestInZone
    });
  }
  // ENTER the await state: the hero was just blocked on a permission.prompt. Stop working, stand, and (in tick)
  // walk to the resolved wait anchor. Idempotent per prompt — a second prompt for the same promptId is a no-op.
  function enterAwait(prompt) {
    if (!agent || agent.unplaced) return;
    if (awaitPrompt && prompt && awaitPrompt.promptId === prompt.promptId) return;
    awaitPrompt = prompt || { promptId: '' };
    awaitStampAt = (typeof performance !== 'undefined') ? performance.now() : fnow;   // E2: stamp the await TTL
    awaitArrived = false;
    awaitAnchor = resolveWaitAnchor();
    // seize the body out of the desk pose so tick re-paths it to the anchor (mirrors the summon re-seize)
    releaseSeat();
    agent.goal = 'awaitwalk'; agent.sitting = false; agent.working = false; agent.stilling = false;
    agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null;
    agent.pauseUntil = 0; agent.pauseLook = null; agent.state = 'idle';
    if (awaitAnchor) agent.dir = awaitAnchor.face || 'south';
  }
  // CLEAR the await state (permission.response arrived). The run resumes (approve) or ends (deny) server-side;
  // either way the body leaves the anchor. We drop back to the desk-trip: if the run is still live it re-arms
  // 'task' via its next tool call (chat.js walkToDesk); a denied/ended run flips to idle via run.end.
  function clearAwait() {
    if (!awaitPrompt) return;
    awaitPrompt = null; awaitAnchor = null; awaitArrived = false;
    if (agent && (agent.goal === 'awaitwalk' || agent.goal === 'awaiting')) {
      agent.goal = null; agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.idleUntil = fnow + 200;
    }
  }
  // G4 feature 2: the MISSION BOARD's approach tile (where the agent stands to pin), via the shared anchor law.
  function boardAnchorTile() {
    if (!geo || !geo.props || typeof PropAnchor === 'undefined') return null;
    const board = geo.props.find(p => p && p.t === 'missionboard');
    if (!board) return null;
    const a = PropAnchor.deriveAnchor(board, geo, { approach: 'south', extra: blocked });
    return a ? { tx: a.tx, ty: a.ty, face: a.face } : null;
  }
  // when the pending-proposal count RISES past the mark, send the idle hero to the board to pin (once per new
  // proposal). Gated to a free, idle hero (never interrupts a task/talk/await/leisure walk) — the pin is a
  // projection, not a gate: if the agent is busy the card still shows on the board; the WALK just plays later.
  function maybePinProposal(now, count) {
    if (now - pinCheckAt < 400) return; pinCheckAt = now;
    if (!agent || agent.unplaced) return;
    if ((count | 0) <= pinnedCount) { if ((count | 0) < pinnedCount) pinnedCount = count | 0; return; }   // count dropped (accepted/declined) → lower the mark so a later re-propose re-pins
    // only launch the walk when the hero is genuinely free (idle, not seized, not already pinning)
    if (activity !== 'idle' || awaitPrompt || agent.working || agent.sitting || agent.goal === 'pin') return;
    const tile = boardAnchorTile();
    if (!tile) { pinnedCount = count | 0; return; }   // no reachable board approach → count as pinned (the card still shows), skip the walk
    pinTargetTile = tile;
    agent.goal = 'pin'; agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null;
    agent.sitting = false; agent.working = false; agent.state = 'idle';
    if (!setPathTo({ x: tile.tx, y: tile.ty })) { pinFlourishAt = now; pinnedCount = count | 0; agent.goal = null; }   // unreachable → count it pinned, no walk
  }
  /* TIER D · D5 beat 2 — MISSION-BOARD POST. When the frontend-visible task/mission queue is NON-EMPTY, the board
     is inside the hero's zone, and the hero is idle+free, occasionally (rare, ~2-4 min cooldown) the OVERSEER walks
     to the MISSION BOARD, faces it, and surveys the queue a beat (3-6s) before returning to its business. Rides the
     goal machinery like the 'pin' beat (goal 'post'); it IS a noticeable beat, so it ARMS the D2 station budget on
     fire (armBeat — quieting crew beats in its shadow). It is NOT itself budget-gated: crewBeatDamp returns 1 for
     the hero unconditionally (J1 parity), and this beat is hero-only, so a damp check here would be provably inert
     — its rarity comes from the 2-4 min postCd. Board out-of-zone or absent ⇒ pure no-op (no reach, no exception). The
     queue count is read from missionPinCounts (mpOpen), state the frontend ALREADY holds (QuestStore projection,
     cached 1Hz) — no new bus round-trip (G1). Hero-only: only ever called for `agent`. */
  function maybeBoardPost(now) {
    if (!agent || agent.unplaced) return false;
    if (now < postCd) return false;
    if ((missionPinCounts(now)[0] | 0) <= 0) return false;       // queue empty → the overseer has nothing to survey (no-op; N=1-with-no-queue path draws no further RNG)
    const tile = boardAnchorTile();
    if (!tile) return false;                                     // no board / no reachable approach → no reach (out-of-zone board is caught below via the zone clamp)
    if (!tileInZone(zoneFor(agent), tile.tx, tile.ty)) return false;   // board approach outside the hero's zone → no-op (containment; with crew present the hero may be caged to its own room)
    if (!setPathTo({ x: tile.tx, y: tile.ty })) return false;    // unreachable → skip (leaves postCd untouched; re-considered next idle tick)
    postTargetTile = tile;
    agent.goal = 'post'; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; agent.working = false; agent.stilling = false; agent.state = 'idle';
    // HARD UNTIL (hunt 3): a walk-cap on studyUntil so a board deleted/refit mid-walk (path cleared, arrive never
    // fires) can NEVER strand the 'post' goal — the dwell-release branch frees it by this ceiling even without an
    // arrival. arrive() overwrites this with the real 3-6s survey hold once the board is reached.
    agent.studyUntil = now + 12000;
    postCd = now + U.irnd(120000, 240000);                       // 2-4 min per-hero cooldown
    armBeat(now);                                                // count it against the shared station beat budget (G5)
    if (!agent.target) arrive(now);                             // already standing on the approach tile → survey now
    return true;
  }
  // the hero's ASSIGNED conveyor: a walkable tile beside the BAY bound to this agent (agentId match, so it never
  // reacts to another agent's bay). null = this agent has no conveyor → no fetch leg (straight to work).
  function assignedConveyorTile(aid) {
    if (!geo || !geo.props || !aid) return null;
    const bay = geo.props.find(p => p.t === 'bay' && p.agentId === aid);
    if (!bay) return null;
    const bw = bay.w || 1, bh = bay.h || 1;
    for (let yy = bay.y - 1; yy <= bay.y + bh; yy++)
      for (let xx = bay.x - 1; xx <= bay.x + bw; xx++) {
        if (xx >= bay.x && xx < bay.x + bw && yy >= bay.y && yy < bay.y + bh) continue;   // skip the footprint itself
        if (geo.walkable(xx, yy, blocked)) return { x: xx, y: yy };
      }
    return null;
  }

  function spawnTileLocal() {
    const sid = station.spawnRoomId(), z = sid && geo.zones[sid];
    const cx = z ? ((z.x1 + z.x2) >> 1) : (geo.COLS >> 1);
    const cy = z ? ((z.y1 + z.y2) >> 1) : (geo.ROWS >> 1);
    if (geo.walkable(cx, cy, blocked)) return { x: cx, y: cy };
    for (let r = 1; r < 14; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (geo.walkable(cx + dx, cy + dy, blocked)) return { x: cx + dx, y: cy + dy };
    }
    return { x: cx, y: cy };
  }

  function placeAgent() {
    releaseSeat();   // re-homing → drop any couch seat claim + on-couch render
    const t = spawnTileLocal(), f = footOf(t.x, t.y);
    agent.px = f.x; agent.py = f.y; agent.unplaced = false;
    agent.pathPts = null; agent.target = null; agent.sitting = false; agent.working = false; agent.state = 'idle';
    agent.goal = null; agent.usingProp = null; agent.watchProp = null;
  }

  /* TRANSIT READING (the phantom-teleport fix). A standing body's tile is its position; a WALKING body's
     is not. footOf anchors a foot to the BOTTOM edge of its tile (ly*T + T - 1) while tileOf floors py/T,
     so the straight segment between two perfectly legal feet passes through pixel rows that belong to the
     tile BELOW the destination. Walk from foot(8,4) to foot(7,3) and the interpolated body reports
     8,4 → 7,4 → 7,3 — and if 7,4 holds a blocking prop (the seed floor's bar), this backstop read a
     healthy body as off-floor and re-homed it to the spawn tile mid-stride. That is what the "it
     teleported out of nowhere" report was: not a body in the void, a body between two tiles.
     So: never re-home a body that is following a path. This costs NO coverage, because every way a body
     can actually become stranded ALSO clears its path — an origin shift drops pathPts/target in
     rederive's re-frame block, and a floor reclaimed underfoot re-derives and does the same. A body with
     a live target is walking a route that was validated against this very grid when it was laid, so the
     backstop simply waits one tick for the path to be dropped and then does its job as before. */
  function ensureAgentValid() {
    const cur = tileOf(agent.px, agent.py);
    if (geo.walkable(cur.x, cur.y, blocked)) return;
    if (agent.target) return;   // mid-walk — the tile reading is a transit artefact, not a stranded body (see TRANSIT READING)
    placeAgent();   // floor reclaimed under the agent — re-home to the spawn room
  }

  /* ---------- agent lifecycle ---------- */
  function spawn(a) {
    // a fresh hero body owns a fresh floor: drop EVERY crew body left over from a previous agent on this
    // same page (NEW AGENT keeps this module alive — nothing tears it down). Otherwise the prior agent's
    // SUMMONED crew (which loadStation deliberately preserves) would haunt the newborn's "fresh" station.
    // Safe for RESUME: enterGame re-derives plan crew (syncCrewFromPlan) and re-spawns the rehydrated
    // summoned crew (spawnAgent loop) immediately after this call, so a resumed crew is rebuilt, not lost.
    crew = [];
    occupiedSeats.clear();   // W5: couch-cushion CLAIMS live in this module-level Set, NOT on the body objects we just
                             // dropped — so without this a body lounging at switch time leaks its seatKey forever, and a
                             // reissued prop id (worldmodel _nid reseeds low on a fresh station) collides → a brand-new
                             // couch reads "full" over a physically EMPTY cushion. spawn()-only, same rationale as below.
    beltWatch = null;        // the belt-watch claim is the same shape of module-level claim, held by a body we just dropped
    // …and with it every other scrap of the PREVIOUS agent's session that lives on this page. These reset
    // here (the per-agent hero (re)spawn), NOT in loadStation — loadStation also runs on a same-agent REFIT,
    // where the running economy/belts MUST persist. spawn() runs only on wake/resume, so a refit is untouched.
    if (floor) floor.reset();           // W1: factory-floor economy (spend/slag/yield) — no inherited numbers on a new HUD
    if (slaglog) slaglog.reset();       // W1: wasted-spend post-mortems
    if (convey) convey.reset();         // W2: drop the prior agent's in-flight belt crates
    chanQueues.clear(); serverLit.clear();   // W3: no phantom backlog gauge / no body stuck "working" from a prior run
    xpAgent = null; xpByAgent.clear();  // W4: name-tag level chip re-seeds from XpStore on enterGame
    levelUpAt = 0; lastSlagAt = -1e9; lastOutboxFlash = -1e9;   // W4: one-shot beats don't replay into the newborn
    agent = {
      id: a.id, name: a.name, color: a.color || '#5ad0ff', skin: a.skin || DATA.DEFAULT_SKIN,
      px: 0, py: 0, dir: 'south', state: 'idle', sitting: false, working: false, unplaced: true,
      // `phase` MUST stay an INTEGER — phaseOf() uses it as a PHASES[] index (world.js ~2660), so a float
      // there indexes undefined and kills the whole idle/mood engine. `aph` is the separate FLOAT sprite
      // offset: b.phase alone is a whole-frame offset, which left every body ticking its walk cycle on the
      // SAME 100ms boundaries (the crew animated in visible lockstep). A fractional offset de-syncs them.
      phase: U.hash(a.id) % 6, aph: (U.hash(a.id) % 600) / 100, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
      usingProp: null, useUntil: 0, useFace: 'south', useSit: false,  // idle leisure: which prop the agent is at + dwell timer + pose
      lastFun: null, lastFunUntil: 0,   // recent-choice penalty; a sole recent prop is skipped, a multi-prop room stays non-deterministic
      deskVisitCd: 0, exploreCd: 0,     // stop desk loops; periodically take one bounded trip beyond the current room
      watchProp: null,   // lounge: the TV the couch-sitter is watching (kept lit while it watches)
      // seat-on-couch: logical pos stays on the approach tile, but it RENDERS at seat{Px,Py} ON the couch
      seated: false, seatPx: 0, seatPy: 0, seatKey: null, pendSeat: null,
      // awareness & curiosity: head-turn glance (drawBody reads agent.glance), study/observe dwell, fidget + notice cooldowns
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0, studyKey: null,
      summonGlanceCd: 0,   // Tier C / C-Beat1: per-observer refractory so a summon-glance fires once per event, not every frame (runtime-only)
      neighborGlanceCd: 0, // Tier C / C-Beat2: per-body cooldown so two idle neighbors don't re-roll a mutual glance the instant the last lapses (runtime-only)
      barJoinCd: 0, barJoinUntil: 0,   // rare same-room join at an occupied bar; planSeat still owns the actual sit
      // INNER LIFE: a fixed temperament + three slow-draining needs that drive WHICH goal it pursues
      pers: makePersonality(a.id),
      needs: { rest: U.irnd(72, 92), stim: U.irnd(72, 92), social: U.irnd(72, 92) },   // born content; drifts into wants over the first minute
      lastTaskAt: 0, thinkUntil: 0, settleUntil: 0, trackUntil: 0,   // machine-state timers (think-before-work, settle-before-typing, downtime, body-track)
      quirkKind: null,   // which rare quirk is currently playing (drives the gaze flavor in maybeGlance)
      placeTarget: null, removeId: null,   // pending station edit when goal==='place' (add decor at target, or remove its own)
      roundsQueue: null, roundsCd: 0,   // caretaker-lap stop queue + cooldown
      fond: new Map(), revisitCd: 0,   // SPATIAL MEMORY: tileKey -> affection; builds where it dwells, drives revisit-a-haunt + mourning
      pauseUntil: 0, pauseLook: null, pauseCd: 0, yieldCd: 0, lookBackCd: 0,   // CONSIDERED MOVEMENT: brief mid-stroll holds, belt-yield to cargo, the rare double-take
      attn: null, drive: null, driveUntil: 0,   // CONTINUITY OF ATTENTION: the neighbourhood it is currently occupied with (attn) + the drive it is mid-way through satisfying (drive/driveUntil) — see the CONTINUITY block above decideIdle
      stilling: false,   // STILLNESS: true during a real CONTENT=STILL quiet hold (suppresses the ambient swivel + cargo body-track)
      wakePhase: 0,   // FIRST LIGHT: the wake-ritual sub-beat sequencer (driven by studyUntil; reset on exit + on a REFIT drop)
      quirkCd: 0, offbeatCd: 0   // J2: per-body quirk/off-beat gates (read/written via self in maybeQuirk/offbeat) — uniform with the crew init shape; self===agent keeps the hero byte-identical
    };
    self = agent;   // B1: track the hero from birth so engine helpers called BEFORE the first tick (awakening / mouse handlers via setGlance/releaseSeat) act on the hero — self is restored to agent every tick anyway
    if (geo) placeAgent();
  }

  /* a stable temperament derived from the agent id (no RNG — same agent feels the same across a session).
     pace = walk speed; restless = how fast it re-decides + paces; curious/homebody/chatty bias the idle menu + self-talk. */
  function makePersonality(id) {
    const h = s => U.hash(id + ':' + s);
    return {
      pace: 0.88 + (h('pace') % 30) / 100,       // 0.88 .. 1.17
      restless: 0.55 + (h('restless') % 90) / 100, // 0.55 .. 1.44
      curious: 0.45 + (h('curious') % 75) / 100,  // 0.45 .. 1.19
      homebody: 0.45 + (h('homebody') % 75) / 100, // 0.45 .. 1.19
      chatty: 0.55 + (h('chatty') % 70) / 100,    // 0.55 .. 1.24
    };
  }

  function init(canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    resize();
    camUserAt = performance.now();   // boot / a new agent re-arms the cinecam idle clock — the director never fires into a fresh floor
    // resize() preserves the current view (centre-anchored) — never re-fit here, or every
    // COMMS-seam drag tick / fullscreen toggle snaps the Commander's pan/zoom back to fit-all.
    try { if (ro) ro.disconnect(); ro = new ResizeObserver(() => { resize(); redrawNow(); }); ro.observe(cv.parentElement || cv); } catch (e) {}
    // bind the input/visibility handlers + SSE bridge ONCE — init() re-runs on every NEW AGENT (same canvas
    // element), so without this guard each new agent stacked another full set of listeners and SSE streams.
    if (listenersBound) return;
    listenersBound = true;
    // THE STARNET FONT, ON CANVAS. `font-display: block` (style.css) governs the DOM only —
    // canvas has no equivalent: `ctx.font` resolves against whatever is loaded AT DRAW TIME and
    // silently falls through to the next family in the stack when VT323 has not landed yet.
    // The live frame redraws continuously so it heals itself, but StationBake paints its layers
    // ONCE — a bake that ran a few ms before the face arrived keeps fallback-font text baked into
    // the floor until the geometry happens to change. So: if the face is not ready, wait for it
    // and re-bake. Rejection is ignored on purpose — a missing face is already a hard failure the
    // gate catches (test/font.law.test.js), and there is nothing useful to do about it here.
    try {
      if (document.fonts && !document.fonts.check("16px 'VT323'", 'Station')) {
        document.fonts.load("16px 'VT323'", 'Station')
          .then(() => { bakeDirty = true; redrawNow(); })
          .catch(() => {});
      }
    } catch (e) {}
    window.addEventListener('resize', resize);

    wireStageInput();
    // you just came back to the tab → for a few seconds the agent is likelier to look up and notice you
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) userReturnUntil = performance.now() + 3000; }); } catch (e) {}
    connectChannelBridge();   // open the SSE bridge so real inbound work animates as boxes on the belts
    pollFeedState();          // feed truth (channels/cron) for the NO FEED intake nag — server-proven, refreshed slowly
    pollShipStats();          // SHIPPED TODAY truth (completed runs since local midnight) — reload-proof
    pollAffinity();           // the PROVEN social graph — who the run log says works together (biases idle social beats)
    setInterval(pollFeedState, 60000);   // listenersBound guards init's one-time block, so these arm exactly once
    setInterval(pollShipStats, 60000);
    setInterval(pollAffinity, 300000);   // the graph moves on the timescale of DAYS — a 5min refresh is already generous
  }

  /* Every handler the stage canvas owns, bound to the CURRENT `cv`. Called once from init
     (listenersBound-guarded) and again by rebuildStage() — a replacement canvas arrives with
     no listeners, and the old node's set died with it, so re-wiring can never double-bind.
     Handlers close over `cv`/`ctx` etc. through the module scope, so they follow the swap. */
  function wireStageInput() {
    /* CANVAS CONTEXT LOSS (see recoverLostCanvases). preventDefault() on 'contextlost' is what
       ASKS the browser to restore the context — without it there is no 'contextrestored' and the
       stage stays dead. Both are cheap no-ops on runtimes that never fire them; the watchdog is
       the belt to this pair of braces. */
    try {
      cv.addEventListener('contextlost', ev => {
        try { ev.preventDefault(); } catch (_) {}
        try { console.warn('[world] canvas 2d context lost — awaiting restore'); } catch (_) {}
      }, false);
      cv.addEventListener('contextrestored', () => {
        lastRecoverAt = 0;   // an explicit restore always wins the cooldown
        recoverLostCanvases(performance.now(), 'contextrestored');
        redrawNow();
      }, false);
    } catch (e) {}

    /* A GPU reset usually lands while the app is in the BACKGROUND (the machine slept, the
       display changed, the user switched away), so the first frame back is exactly when the
       damage is visible. Re-arm the sentinel to fire on that frame instead of up to a second
       into it — cheap, since it only clears a throttle. */
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lastProbeAt = 0; });
    window.addEventListener('focus', () => { lastProbeAt = 0; });

    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const c = toCanvas(ev), wx = (c.x - panX) / scale, wy = (c.y - panY) / scale;
      scale = clampz(scale * Math.exp(-ev.deltaY * 0.0015), MINZ, MAXZ);
      panX = c.x - wx * scale; panY = c.y - wy * scale;
      camLerp = null; camLock = null; camUserAt = performance.now();   // the user is driving the camera — stop any focus ease, release any follow-lock, reset the cinecam idle clock
    }, { passive: false });
    cv.addEventListener('mousedown', ev => { if (kindleArmed) { kindleHolding = true; return; } camLerp = null; camLock = null; camUserAt = performance.now(); const c = toCanvas(ev); drag = { sx: c.x, sy: c.y, moved: false }; });
    cv.addEventListener('mousemove', ev => {
      if (drag) {
        const c = toCanvas(ev);
        // CLICK vs PAN: a real mouse click almost always carries 1–2px of jitter between down and up.
        // Flagging moved on ANY movement made mouseup swallow those as "drags", so prop clicks (OUTBOX,
        // boards, bays) randomly did nothing. A pan only starts once cumulative travel clears ~4px;
        // under that the press stays a click and the camera holds still.
        if (!drag.moved) {
          drag.acc = (drag.acc || 0) + Math.hypot(c.x - drag.sx, c.y - drag.sy);
          if (drag.acc <= 4) { drag.sx = c.x; drag.sy = c.y; return; }
          drag.moved = true;
        }
        panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y;
        cv.style.cursor = 'grabbing'; return;
      }
      const wp = toWorld(ev);
      const nowMs = performance.now();
      // D4: stamp cursorMoveT only on a REAL displacement (> ~half a tile) — a parked-but-jittering cursor is
      // presence (feeds gaze), not "moving" (which lures THE CHASE). Compared against the PREVIOUS lastCursor.
      if (Math.hypot(wp.x - lastCursor.wx, wp.y - lastCursor.wy) > T * 0.5) cursorMoveT = nowMs;
      lastCursor = { wx: wp.x, wy: wp.y, t: nowMs };   // remember where you are — the agent's sense of your presence (feeds gaze)
      const hit = agentHit(wp);
      // rising edge: the HERO notices the Commander's cursor land on IT and turns to meet you.
      // (crew bodies just raise their nameplate on hover — only the hero self-acknowledges)
      if (agent && hit === agent && hoverAgent !== agent && activity === 'idle' && !agent.working) { setGlance('south', 900, performance.now()); curiositySay(SELF_ACK, 0.3, performance.now()); }
      if (hit !== hoverAgent) hoverAgent = hit;
      // belt under the cursor (and no body over it) → arm the hover-glance route tag for the draw pass
      hoverBeltTile = null;
      if (!hit && beltTileSet) { const bt = tileOf(wp.x, wp.y); if (beltTileSet.has(bt.x + ',' + bt.y)) hoverBeltTile = bt; }
      hoverOutbox = hit ? null : outboxAt(wp);   // arm the hover-glance crate tag (a glance, never a window)
      cv.style.cursor = (hit || hoverOutbox || arcadeAt(wp) || missionBoardAt(wp) || trophyCaseAt(wp) || unboundBayAt(wp) || intakeSampleAt(wp) || intakeFeedAt(wp)) ? 'pointer' : 'default';   // arcade cabinets + a stacked OUTBOX + the MISSION BOARD + the TROPHY CASE + an unbound BAY + a complete-line INBOX + a starved INTAKE are clickable too
    });
    cv.addEventListener('mouseup', ev => {
      if (kindleArmed) { kindleHolding = false; return; }   // releasing during the kindle lets the spark ebb
      const wasDrag = drag && drag.moved; drag = null; cv.style.cursor = 'default';
      if (wasDrag) return;
      const wp = toWorld(ev);
      // Every body that raises the agent hover nameplate is also a real dossier target. Pass its stable
      // roster id through the click seam so a specialist opens ITS dossier instead of falling through or
      // reusing the Overseer's index. The greeting remains hero-only: crew clicks open a panel, not a hero line.
      const hit = agentHit(wp);
      if (hit) {
        if (hit === agent && activity !== 'task') { agent.dir = 'south'; setGlance('south', 1000, performance.now()); curiositySay(SELF_GREET, 0.8, performance.now()); }   // eye contact for the Commander
        if (onClick) onClick(hit.agentId || hit.id);
        return;
      }
      const arc = arcadeAt(wp);
      if (arc && onArcade) { onArcade(arc); return; }
      // G2.3: a stacked OUTBOX is the collect tap — clicking it opens the oldest pending run's review
      const ob = outboxAt(wp);
      if (ob && onOutbox) { onOutbox(ob); return; }
      // G1b: the MISSION BOARD is the quest log's body — clicking it opens the log (never gated, never dead)
      const mb = missionBoardAt(wp);
      if (mb && onMissionBoard) { onMissionBoard(mb); return; }
      // G3b: the TROPHY CASE opens the trophy surface (honest even when empty — it shows dust, never a dead click)
      const tc = trophyCaseAt(wp);
      if (tc && onTrophyCase) { onTrophyCase(tc); return; }
      // an UNBOUND bay's nag says CLICK — the click opens the assign flow (REFIT bay picker), closing the loop
      const ub = unboundBayAt(wp);
      if (ub && onBayAssign) { onBayAssign(ub.id); return; }
      // an INBOX on a COMPLETE line offers the sample-job card (PROOF: run one real job through the line).
      // Checked first: when the NO-FEED nag is also up (which needs the same live line), the card carries the
      // CHANNELS door itself, so the nag's promised click-through is never lost — see intakeSampleAt.
      const ismp = intakeSampleAt(wp);
      if (ismp && onIntakeSample) { onIntakeSample({ propId: ismp.id, fed: feedState.known ? !!feedState.fed : null }); return; }
      // a NO-FEED intake's nag says CLICK — the click opens the CHANNELS panel (the fix is wiring a feed)
      const inf = intakeFeedAt(wp);
      if (inf && onIntakeFeed) onIntakeFeed(inf.id);
    });
    cv.addEventListener('mouseleave', () => { if (kindleArmed) kindleHolding = false; hoverAgent = null; hoverBeltTile = null; hoverOutbox = null; if (!drag) cv.style.cursor = 'default'; });
  }

  function resize() {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    // TEXT SIZE zoom (stationui applySettings sets body.style.zoom): zoom shrinks the canvas's
    // layout px while the painted box stays the same device size, so without this factor the
    // station upscales soft. Multiplying back keeps the bitmap 1:1 with device pixels; mouse
    // mapping is rect-ratio-based (canvasPoint) so it needs no change.
    const uiz = (() => { const z = parseFloat(document.body && document.body.style ? document.body.style.zoom : ''); return z > 0 ? z : 1; })();
    const w = cv.clientWidth || cv.parentElement.clientWidth, h = cv.clientHeight || cv.parentElement.clientHeight;
    const nw = Math.max(1, Math.round(w * dpr * uiz)), nh = Math.max(1, Math.round(h * dpr * uiz));
    if (cv.width === nw && cv.height === nh) return;   // assigning to canvas.width/height WIPES the bitmap even when unchanged — skip the needless clear
    // keep the world point under the canvas centre anchored through the resize (zoom untouched):
    // the view stays put while the stage grows/shrinks around it. Skipped until the first fit
    // has framed the station (fitNeeded) — there's no meaningful view to preserve yet. A fit
    // that landed on a DEGENERATE canvas (boot while the game screen was still hidden → 1px
    // stage) is no view either — re-fit at the first real size instead of anchoring garbage.
    if (!fitNeeded && cache) {
      if (fitW <= 2 || fitH <= 2) fitNeeded = true;
      else { panX += (nw - cv.width) / 2; panY += (nh - cv.height) / 2; }
    }
    cv.width = nw; cv.height = nh;
  }

  // A canvas resize blanks the bitmap, and the repaint only lands on the NEXT rAF — so dragging the
  // COMMS seam (a stream of ResizeObserver hits) strobes the station black. Repaint synchronously in the
  // observer (after layout, before paint) so the new-size frame is on screen this paint, not next. Cancel
  // the queued rAF first so frame()'s own re-schedule doesn't leave two loops running.
  function redrawNow() {
    if (!running || !cache) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    frame(performance.now());
  }

  function start() { if (running) return; running = true; last = performance.now(); if (!floorLiveAt) floorLiveAt = last; frame(last); }
  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function wakeIn() { wakeAt = performance.now(); }

  /* ---------- THE AWAKENING — a witnessed birth (cinematic camera + spark + dark->dawn) ----------
     The room opens near-black with the newborn frozen and facing AWAY; a scripted camera pushes in as it
     stirs, holds close through the four self-discovery beats, then pulls back to reveal its whole world at
     dawn. All self-contained + gated to the awakening so it never fights the general camera path. */
  const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerpv = (a, b, k) => a + (b - a) * k;
  function camTweenTo(toS, toX, toY, dur, ease, onEnd) {
    camAnim = { fromS: scale, toS: clampz(toS, MINZ, MAXZ), fromX: panX, toX, fromY: panY, toY, t: 0, dur: dur || 1500, ease: ease || easeInOut, onEnd: onEnd || null };
  }
  // a camera target that centers world point (px,py) on screen at zoom sc — 0.46 height leaves headroom above
  function camCenterOn(px, py, sc) { sc = clampz(sc, MINZ, MAXZ); return [sc, cv.width / 2 - px * sc, cv.height * 0.46 - py * sc]; }
  function beginAwakening() {
    // a brand-new birth: wipe any ceremony state a previous agent left on this page so the newborn gets a
    // pristine dark->dawn ritual. Only a real awakening calls this (never a re-bake/refit), so re-arming the
    // once-per-life first-light latch here keeps "a refit never re-arms it" true while fixing NEW AGENT.
    firstWakeDone = false;
    sparkAt = bornAt = dawnAt = truthPulseAt = 0;
    floodAt = floodEndAt = 0; floodStreams = null;
    kindleArmed = false; kindleP = 0; kindleHolding = false; kindlePeak = 0;
    awakeFrozen = true; wakeDark = 0.92; wakeDarkTarget = 0.92; camAnim = null; if (agent) agent.dir = 'north';   // newborn faces AWAY until the Turn
  }
  // setWakeProgress LIFTS the awakening veil — it must never CREATE darkness in a lit room. The deferred
  // interview replays the meeting beats (bumpTruth) during ordinary play, so outside the ceremony
  // (awakeFrozen false) this is a no-op — the veil only moves while a birth/re-wake actually owns the room.
  function setWakeProgress(p) { if (!awakeFrozen) return; p = p < 0 ? 0 : p > 1 ? 1 : p; wakeDarkTarget = 0.92 * (1 - p); }
  function igniteSpark() { sparkAt = performance.now(); bornAt = performance.now(); wakeDark = 0.985; wakeDarkTarget = 0.985; kindleArmed = false; kindleP = 0; }   // the mind catches fire — snap to near-total dark so the spark is the ONLY light (and end any kindle)
  /* THE KINDLING — the pre-ignition beat: one dim, almost-dead ember sits where the mind will be, and the
     user must HOLD to bring it to life. Sustained attention fills kindleP; releasing lets it ebb. When it
     fills, onDone() fires the ignition. A gentle push-in makes the ember intimate while you hold. */
  function armKindle(onDone) {
    kindleArmed = true; kindleP = 0; kindleHolding = false; kindlePeak = 0; kindleDone = onDone || null;
    wakeDark = 0.985; wakeDarkTarget = 0.985;
    if (cache && agent && !agent.unplaced) { const [s, x, y] = camCenterOn(agent.px, agent.py - 4, 2.4); camTweenTo(s, x, y, 1400); }
  }
  function kindleHold(down) { if (kindleArmed) kindleHolding = !!down; }
  function camPushIn() { if (!cache || !agent || agent.unplaced) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, 3.2); camTweenTo(s, x, y, 2600); }
  function camCreep() { if (!cache || !agent || agent.unplaced || camAnim || !awakeFrozen) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, scale * 1.035); camTweenTo(s, x, y, 600); }   // a hair closer with each truth — ceremony-only (the deferred interview must never steal the live camera)
  function camPunch() { if (!agent || agent.unplaced || camAnim) return; const b = scale; const [s1, x1, y1] = camCenterOn(agent.px, agent.py - 4, b * 1.06); const [s0, x0, y0] = camCenterOn(agent.px, agent.py - 4, b); camTweenTo(s1, x1, y1, 150, t => t, () => camTweenTo(s0, x0, y0, 240)); }   // eyes finding yours
  function camPullBack() { if (!cache) return; const W = cache.W, H = cache.H; const s = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ); camTweenTo(s, (cv.width - W * s) / 2, (cv.height - H * s) / 2, 1700); }   // recompute fit at fire time -> no jump on release
  // the Turn: the newborn finds the Commander — head leads, then the body pivots north -> side -> south and holds your gaze
  function awakenTurn() {
    if (!agent) return;
    const side = (cache && agent.px > cache.W / 2) ? 'west' : 'east';
    setGlance(side, 650, performance.now());
    setTimeout(() => { if (agent) agent.dir = side; }, 240);
    setTimeout(() => { if (agent) setGlance('south', 700, performance.now()); }, 760);
    setTimeout(() => { if (agent) agent.dir = 'south'; }, 1000);
  }
  function truthPulse() { truthPulseAt = performance.now(); }
  function endAwakening() { wakeDarkTarget = 0; dawnAt = performance.now(); wakeIn(); }   // DAWN: light floods + ripple fires (agent stays frozen/facing-you for the final line)
  function releaseAwakening() { awakeFrozen = false; sparkAt = 0; floodAt = 0; floodEndAt = 0; floodStreams = null; kindleArmed = false; kindleP = 0; kindleHolding = false; armFirstWake(); }   // hand the newborn back to its own autonomous life — and let it have its FIRST LIGHT
  // FIRST LIGHT: arm the once-per-life wake ritual the instant the newborn owns itself. The activity!=='task'
  // guard makes a summon racing the release win cleanly (the ritual simply never arms).
  function armFirstWake() {
    if (firstWakeDone || !agent || agent.unplaced || activity === 'task') return;
    firstWakeDone = true;
    agent.goal = 'firstwake'; agent.wakePhase = 0; agent.dir = 'south'; agent.state = 'idle';
    agent.sitting = false; agent.working = false; agent.stilling = false; agent.usingProp = null; agent.target = null; agent.pathPts = null;
    agent.studyUntil = performance.now() + U.irnd(900, 1400);   // BEAT 0: the held gaze before any motion or words
  }
  /* THE FLOOD — the rush of waking into vast knowledge. A screen-space cascade of streaming phosphor
     tokens (seeded with REAL forming-prompt + capability fragments passed in, padded with glyph noise —
     never fake facts) builds to overwhelming density, then collapseFlood() pulls every glyph inward into
     the newborn's mind. Deterministic per stream after seeding so the frame is stable. */
  const FLOOD_GLYPHS = '01<>/\\{}[]()=+*#%&@|;:.01_-01アイウエオカキクケコ10サシスセソ01';
  function beginFlood(words) {
    floodAt = performance.now(); floodEndAt = 0;
    const pool = (Array.isArray(words) ? words : []).map(s => String(s || '').trim()).filter(Boolean);
    const N = 30, streams = [];
    for (let i = 0; i < N; i++) {
      const len = 9 + Math.floor(Math.random() * 12), toks = [];
      for (let j = 0; j < len; j++) {
        if (pool.length && Math.random() < 0.24) toks.push(pool[Math.floor(Math.random() * pool.length)]);
        else { let s = ''; const gl = 1 + Math.floor(Math.random() * 2); for (let k = 0; k < gl; k++) s += FLOOD_GLYPHS[Math.floor(Math.random() * FLOOD_GLYPHS.length)]; toks.push(s); }
      }
      streams.push({ x: (i + 0.5) / N + (Math.random() - 0.5) * 0.012, speed: 70 + Math.random() * 150, size: 12 + Math.floor(Math.random() * 7), delay: Math.random() * 1100, toks, len });
    }
    floodStreams = streams;
  }
  function collapseFlood() { if (floodAt && !floodEndAt) floodEndAt = performance.now(); }   // pull the cascade inward into the mind
  function refit() { fitNeeded = true; }
  function say(text, opts) {
    if (!agent) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    agent.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
    // ambient station-life remarks are muttered ALOUD too (when the agent has a voice and isn't
    // mid-conversation) so the station feels lived-in. Real replies are spoken by chat.js, not here,
    // so only {ambient:true} lines speak — and pure filler ("...", "hmm") stays a silent bubble.
    if (opts && opts.ambient && typeof Voice !== 'undefined' && Voice.mutter
        && /[a-z]/i.test(t) && !/^h+m+[.…]?$/i.test(t)) {
      Voice.mutter(t);
    }
  }
  /* kind: 'task' (walk to the workstation + work) | 'talk' (face the Commander) | 'idle' (wander the station) */
  /* TIER D · D1 — the Commander's COMMS focus. chat.js calls this with the active stream's agent id on every
     conversation rebind (load(ws)), and null when there's no live conversation. Stores the id ONLY; all the
     stare behavior reads chatFocusId from the idle path. Airtight cleanup: when focus moves off a body (null
     or another id) its next idle decision restores normal wander (decideIdle clears stilling on entry), so no
     stuck stillness / suppressed-forever wander can leak. Unknown / not-yet-spawned id → the resolver no-ops. */
  function setChatFocus(agentId) {
    const next = agentId || null;
    chatFocusId = next;
    // A switch/open IS engagement — warm the (new) focus so the stare holds for a fresh window. When focus
    // moves to another id the old body just lapses (next decideIdle restores its idle life). null → no warmth.
    if (next) warmChatFocus();
  }
  /* D1 WARMTH ping — re-warm the focus so an ACTIVE conversation never goes cold mid-use. Called from chat.js at the
     genuine engagement points (typing at / sending to / a reply-run boundary of the focused stream). Draws a FRESH
     30–90s window (U.irnd — deterministic-lint-safe) so the lose-interest moment stays unpredictable; no-ops when
     there's no live focus (so pinging a closed panel is inert). */
  function warmChatFocus() { chatWarmUntil = fnow + U.irnd(CHAT_WARM_MIN, CHAT_WARM_MAX); }
  function chatFocusPing() { if (chatFocusId) warmChatFocus(); }
  // the body (hero or crew) the Commander is chatting with, or null. bodyForAgent maps 'agent'→hero + crew by id.
  function chatFocusBody() { return chatFocusId ? bodyForAgent(chatFocusId) : null; }
  /* chatHot — THE single predicate for "the chat-stare is actually engaged": a focus is set AND the conversation
     is still WARM. Every call site that means "this body is (or should be) held by the stare" keys on THIS
     (chatStareHold's own gate, the socialEligible/cursorBeatEligible exclusions, encounterBroken, sweepChase) so
     the definition can never drift apart. COMMS focus never clears in practice (persistent panel), so keying any
     of those on focus ALONE would permanently bar the focused body from social/mimic/chase after warmth lapses —
     hot-focus is the real "held" condition. RNG-free: reads module state + `now` only. */
  function chatHot(now) { return chatFocusId != null && now < chatWarmUntil; }

  function setActivity(kind) {
    activity = kind;
    if (!agent) return;
    if (kind === 'talk') { releaseSeat(); agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.sitting = false; agent.working = false; agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.dir = 'south'; }
  }

  /* ---------- camera helpers ---------- */
  // ease the camera to frame the agent for a one-on-one voice conversation — but only NUDGE: bail if he's
  // already comfortably on-screen and not tiny, so it never fights a deliberate pan/zoom. Self-cancels on
  // manual input (wheel/drag clear camLerp). Called from chat.js when a spoken turn begins.
  function focusAgent(opts) {
    if (!agent || agent.unplaced || !cache) return;
    opts = opts || {};
    const sx = agent.px * scale + panX, sy = agent.py * scale + panY;
    const margin = 48;
    const onScreen = sx > margin && sx < cv.width - margin && sy > margin && sy < cv.height - margin;
    const small = scale < 2.2;
    if (onScreen && !small && !opts.force) return;
    const target = clampz(Math.max(scale, 3), MINZ, MAXZ);
    camLerp = { scale: target, panX: cv.width / 2 - agent.px * target, panY: cv.height * 0.56 - agent.py * target };
  }
  // frame the camera on ANY body (hero or a summoned crew member) — used when COMMS focus switches agents.
  function focusBody(id) {
    const b = bodyForAgent(id) || agent;
    if (!b || b.unplaced || !cache) return;
    const bx = (b.seated ? b.seatPx : b.px), by = (b.seated ? b.seatPy : b.py);
    const target = clampz(Math.max(scale, 3), MINZ, MAXZ);
    camLerp = { scale: target, panX: cv.width / 2 - bx * target, panY: cv.height * 0.56 - by * target };
  }
  // FOLLOW-LOCK the camera on one agent's body — the SESSION-SELECT camera contract: picking a session with an
  // agent locks the feed onto that agent immediately (no idle wait) and TRAILS it as it moves, until the
  // Commander grabs the camera (wheel/drag/click → the input handlers release the lock). One-shot focusBody
  // stays for programmatic reframes (boot restore, delete-fallback) — lockBody is only armed by a USER selection.
  function lockBody(id) {
    const b = bodyForAgent(id) || agent;
    if (!b || b.unplaced || !cache || camAnim || awakeFrozen) return;   // nothing to frame yet / the scripted awakening camera owns the transform
    camLerp = null;
    camLock = { id: (b.agentId || b.id), sc: clampz(Math.max(scale, 3), MINZ, MAXZ), source: 'session' };
  }
  /* ---------- IDLE CINECAM — the security-feed auto-director ----------
     After cineIdleMs of true hands-off the camera starts hunting the floor's own life: it follow-locks a
     WALKING body and trails it; if its subject settles and someone ELSE is moving it cuts there; when nothing
     moves it drifts between the crew in calmer, wider shots. Strictly subordinate: a 'session' lock owns the
     camera outright, any user camera input kills the shot instantly (the input handlers null camLock and
     re-stamp camUserAt), the scripted awakening camera always wins, and reduced-motion users never get a
     self-panning camera. Runs once per frame from the camera block — every branch below is O(bodies). */
  function cinecamTick(now) {
    if (camLock && camLock.source !== 'cine') return;                             // an explicit session lock owns the camera
    // NOTE: no document.hidden gate — the rAF loop already pauses in hidden tabs, and embedded webviews
    // (the preview harness, some Tauri states) report hidden while still rendering, which would dead-gate this.
    if (camAnim || awakeFrozen || !cache || reduceMotion() || now - camUserAt < cineIdleMs) {
      if (camLock) camLock = null;                                                // conditions lapsed mid-shot → release; the manual camera resumes untouched
      return;
    }
    const cands = [];
    if (agent && !agent.unplaced) cands.push(agent);
    for (const b of crew) if (b && !b.unplaced) cands.push(b);
    if (!cands.length) { if (camLock) camLock = null; return; }
    const walkers = cands.filter(b => b.state === 'walk');
    const cur = camLock ? bodyForAgent(camLock.id) : null;
    if (cur && cur.state === 'walk') cineWalkAt = now;
    // hold the shot while it's alive: the subject exists, its hold window is open, and it hasn't gone still
    // for >3s while someone ELSE moves (movement is the whole point — cut to it)
    const recast = !cur || now >= cineHoldUntil || (cur.state !== 'walk' && now - cineWalkAt > 3000 && walkers.length > 0);
    if (!recast) return;
    // cast the next shot: movement first — prefer a DIFFERENT walker (variety), and the COMMS-focused agent's
    // movement wins the tie. Nothing moving anywhere → a calmer, wider drift onto someone idle.
    const others = walkers.filter(b => b !== cur);
    const pool = others.length ? others : walkers;
    let next = null, moving = false;
    if (pool.length) { next = (chatFocusId && pool.find(b => (b.agentId || b.id) === chatFocusId)) || pool[U.irnd(0, pool.length - 1)]; moving = true; }
    else { const rest = cands.filter(b => b !== cur); const p2 = rest.length ? rest : cands; next = p2[U.irnd(0, p2.length - 1)]; }
    if (!next) return;
    camLerp = null;
    camLock = { id: (next.agentId || next.id), sc: clampz(moving ? U.irnd(26, 30) / 10 : U.irnd(20, 24) / 10, MINZ, MAXZ), source: 'cine' };
    cineWalkAt = now;
    cineHoldUntil = now + (moving ? U.irnd(9000, 16000) : U.irnd(6000, 11000));
  }
  const cameraMode = () => camLock ? (camLock.source === 'cine' ? 'auto' : 'lock') : 'manual';   // HUD/verify truth: what drives the camera RIGHT NOW
  function setCinecamIdle(ms) { cineIdleMs = Math.max(1000, +ms || CINE_IDLE_MS); }               // DEV knob (console/verify only): shrink the hands-off threshold; floor 1s
  function fitCamera() {
    if (!cache) return;
    const W = cache.W, H = cache.H;
    scale = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ);
    panX = (cv.width - W * scale) / 2; panY = (cv.height - H * scale) / 2;
    fitW = cv.width; fitH = cv.height;   // remember the size this fit framed — resize() treats a degenerate-size fit as "never fit"
  }
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorld(ev) { const c = toCanvas(ev); return { x: (c.x - panX) / scale, y: (c.y - panY) / scale }; }
  // the nearest PLACED body under the cursor — the hero (Overseer) OR any crew/summoned body —
  // returned as the body itself (so the hover nameplate can tag whichever one), else null.
  function agentHit(wp) {
    let best = null, bestD = 14 * 14;
    const consider = b => {
      if (!b || b.unplaced) return;
      const dx = wp.x - bodyPosX(b), dy = wp.y - bodyPosY(b);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = b; }
    };
    consider(agent);
    for (const b of crew) consider(b);
    return best;
  }

  /* ---------- pathing + behaviour ---------- */
  function setPathTo(dest) {
    self.pathPts = null; self.target = null; self.glance = null;
    if (!dest || !geo) return false;
    const cur = tileOf(self.px, self.py);
    const blockers = movementBlockers(self, blocked);
    if (tileBlockedFor(blockers, dest.x, dest.y)) return false;
    // prop awareness: prefer a route that steps around walkable machinery/decor (soft no-tread set),
    // fall back to the plain route when the soft set is the only way through (or the dest sits on it)
    const p = geo.path(cur.x, cur.y, dest.x, dest.y, movementBlockers(self, beltUnion()))
      || geo.path(cur.x, cur.y, dest.x, dest.y, blockers);
    if (!p) return false;
    self.pathPts = p; self.pathIdx = 0; self.state = 'walk';
    nextWaypoint();
    intentTell(dest);   // LEGIBILITY: an idle-life walk turns to face where it is going before the first step
    return true;
  }
  function nextWaypoint() {
    if (!self.pathPts || self.pathIdx >= self.pathPts.length) { self.target = null; return; }
    const wp = self.pathPts[self.pathIdx++];
    self.target = footOf(wp.x, wp.y);
    maybeStrollBeat();   // CONSIDERED MOVEMENT: a casual stroll occasionally hesitates / doubles back — not a sprite on rails
  }
  /* ---------- THE INTENT TELL (legibility, NOT a new beat) ----------
     An idle body used to decide and step off in the SAME frame, so the decision was invisible: the viewer saw
     translation, never intent, and a fully-reasoned move (the want engine always has a reason) read as drift.
     Now the instant an idle-life walk commits, the body turns to FACE where it is going and holds a short beat
     before the first step — "it looked at the couch, then went to the couch." It adds NO new behaviour and
     spends NO rarity budget: it reuses the CONSIDERED-MOVEMENT hold (pauseUntil/pauseLook), which both walk
     steppers already honour and which every seize path (summon / refit / await / encounter-break) already
     clears — so nothing can deadlock on it that could not already deadlock on a double-take.
     NEVER on a purposeful walk. A summon, an approval walk, a chase, or a social rendezvous must leave
     INSTANTLY: hesitation there reads as lag, not thought. The exclusions test live plan objects
     (self.social / self.chase) rather than self.goal, because most idle planners set `goal` only AFTER
     setPathTo returns — a goal test here would read the PREVIOUS goal and miss. Determinism: U.irnd only. */
  const NO_TELL = { summon: 1, fetch: 1, work: 1, awaitwalk: 1, awaiting: 1, chase: 1, social: 1, firstwake: 1 };
  function intentTell(dest) {
    if (!self || self.unplaced || self.working || self.social || self.chase) return;
    if (self === agent && (activity !== 'idle' || awaitPrompt)) return;   // hero on task / blocked on approval — go now
    if (NO_TELL[self.goal]) return;
    const now = fnow;
    if (now < (self.pauseUntil || 0)) return;   // a stroll beat (double-take / belt-yield) already owns this hold — never stomp it
    self.dir = dirToward(self.px, self.py, (dest.x + 0.5) * T, (dest.y + 0.5) * T);
    self.pauseUntil = now + U.irnd(240, 480);
    self.pauseLook = 'intent';   // the walk steppers only re-aim the facing for 'back'/'cargo', so 'intent' simply HOLDS the facing set above
  }
  const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
  // only while casually wandering (never a summon/goal walk): a brief considered pause, or the rare eerie double-take
  function maybeStrollBeat() {
    if (!self || self.goal != null || ((self === agent) && activity !== 'idle') || self.unplaced) return;
    const now = fnow;
    if (now < (self.pauseCd || 0)) return;
    // D2 (G5): station budget — a CREW stroll-beat roll is hard-gated (damp=0) while the station gate holds (no-op for the hero).
    const damp = crewBeatDamp(now);
    // THE DOUBLE-TAKE (rare): stop and turn to look back the way it came, as if something caught its attention
    if (now >= (self.lookBackCd || 0) && U.chance(0.045 * (self.pers ? self.pers.curious : 1) * damp)) {
      self.pauseUntil = now + U.irnd(900, 1700); self.pauseLook = 'back';
      self.pauseCd = now + U.irnd(9000, 16000); self.lookBackCd = now + U.irnd(50000, 95000);
      armBeat(now);   // the double-take is a noticeable beat — count it against the station budget
      curiositySay(['hm?', '...', 'did something move', 'thought i saw something'], 0.22, now);
      return;
    }
    // a considered pause mid-stroll: a beat of weight, then on it goes (rarer now — a stroll shouldn't be peppered with stutters)
    if (U.chance(0.07 * damp)) { self.pauseUntil = now + U.irnd(320, 720); self.pauseLook = null; self.pauseCd = now + U.irnd(10000, 18000); armBeat(now); }
  }
  // active cargo passing right in front of it while it walks → wait a beat and let it go by (belt-yield)
  function shouldYieldToCargo() {
    if (!convey || !agent.target) return false;
    const box = nearestBox();
    if (!box) return false;
    // a box is right here (≈1.2 tiles) — either on top of the agent or about to occupy the tile it's stepping toward
    const dxT = box.x - agent.target.x, dyT = box.y - agent.target.y;
    return box.d < 15 || Math.hypot(dxT, dyT) < 15;
  }
  function arrive(now) {
    self.pathPts = null; self.target = null; self.pauseUntil = 0; self.pauseLook = null; self.stilling = false;
    if (self.goal === 'firstwake') { self.state = 'idle'; return; }   // the wake ritual self-drives via stepFirstWake; the rare 'find feet' arrival is a no-op
    // G4 feature 1: reached the WAIT ANCHOR — stand, face the anchor, and latch the waiting pose (the tag + the
    // eerie weight-shift render off awaitArrived). No dwell timer: it waits until permission.response clears it.
    if (self.goal === 'awaitwalk' || self.goal === 'awaiting') { self.goal = 'awaiting'; self.sitting = false; self.working = false; self.state = 'idle'; self.dir = (awaitAnchor && awaitAnchor.face) || 'south'; awaitArrived = true; return; }
    // G4 feature 2: reached the MISSION BOARD to pin a proposal — face it, play the pin flourish, raise the
    // high-water mark (so this proposal never re-triggers the walk), then drift back to wandering.
    if (self.goal === 'pin') {
      self.sitting = false; self.working = false; self.state = 'idle'; self.dir = (pinTargetTile && pinTargetTile.face) || 'north';
      pinFlourishAt = now;
      if (typeof AutoJobStore !== 'undefined' && AutoJobStore.pendingCount) pinnedCount = AutoJobStore.pendingCount();
      self.goal = null; self.idleUntil = now + U.irnd(600, 1400);
      curiositySay(['pinned.', 'left it on the board', 'proposal up', 'for you to weigh'], 0.5, now);
      return;
    }
    // TIER D · D5 beat 2: reached the MISSION BOARD to SURVEY the queue — face it and HOLD 3-6s (a real read of the
    // board, not the pin's instant flourish), then the tick ladder ('post' dwell-release) drifts back to wandering.
    if (self.goal === 'post') {
      self.sitting = false; self.working = false; self.state = 'idle'; self.dir = (postTargetTile && postTargetTile.face) || 'north';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(3000, 6000);
      curiositySay(['reviewing the queue', 'what needs doing', 'the board', 'checking the docket', 'surveying the work'], 0.4, now);
      return;
    }
    const FOND = { lounge: 3, use: 2, gaze: 1.5, tend: 1.5, inspect: 1, watch: 1, rounds: 0.5, revisit: 0.6 };
    if (FOND[self.goal]) { noteFond(now, FOND[self.goal]); noteAttn(now); }   // dwelling somewhere by choice deepens attachment to that tile — and anchors the neighbourhood it is currently occupied with
    // SIT ON THE CHAIR, NOT ON THE TILE. The walk target is the seat's whole TILE (pathing needs one),
    // but on an even-width desk the chair is rendered on the CENTRED fractional x (seat.cx) — so a body
    // that merely finished its walk stands at the tile centre, half a tile off the chair it is supposed
    // to be sitting in. Snap onto seatFoot here, the same anchor drawSeatChair uses, so arriving on foot
    // lands exactly where the teleport-fallback seating already did. Body moves; the chair does not.
    if (self.goal === 'work') { if (self === agent && seat) { const f = seatFoot(seat); self.px = f.x; self.py = f.y; } self.sitting = true; self.working = false; self.dir = deskFace || 'north'; self.state = 'idle'; self.settleUntil = now + U.irnd(450, 900); }   // sit a beat (loading context) before the screens light + typing starts
    else if (self.goal === 'use') {
      self.sitting = self.useSit; self.working = false; self.dir = self.useFace; self.state = 'idle';
      // W2: the prop decides what using it looks like (how long it holds you, how the gaze behaves).
      // No row = the old generic beat. NO gesture here — see the USE_BEAT header.
      const beat = USE_BEAT[useKindOf(self.usingProp)] || null;
      self.useUntil = Math.max(now + (beat ? U.irnd(beat.dwell[0], beat.dwell[1]) : U.irnd(10000, 22000)), self.barJoinUntil || 0);
      self.barJoinUntil = 0;
      self.useBeat = beat; self.glanceCd = 0;
      self.nextFidget = now + (beat ? U.irnd(beat.fidget[0], beat.fidget[1]) : U.irnd(2000, 4000));
      takeSeat();
      // the prop-specific thought wins over the generic "resting" one — it says something true about
      // WHERE the body is, which the bare rest line cannot. Falls back when the kind has no entry.
      const line = USE_LINE[useKindOf(self.usingProp)];
      if (line) curiositySay(line, 0.4, now);
      else if (self.useSit && self.needs.rest < 35) curiositySay(SELF_REST, 0.4, now);
    }
    else if (self.goal === 'lounge') {
      // Couch/TV is the one intentional sofa exception to the chair-only sit rule: the body claimed a real
      // cushion in planCouchSit, so render it ON that cushion and let it settle in for a genuine viewing session.
      self.sitting = true; self.working = false; self.dir = self.useFace; self.state = 'idle';
      self.useUntil = Math.max(now + U.irnd(90000, 180000), self.barJoinUntil || 0); self.barJoinUntil = 0;
      self.glanceCd = 0; self.nextFidget = now + U.irnd(1500, 3500);
      takeSeat(); curiositySay(self.needs.rest < 35 ? SELF_REST : CURIO_WATCH, 0.45, now);
    }
    else if (self.goal === 'sleep') {
      // reached a BED (planBedSleep walked it here) — get IN it and power down. `sitting` stays false:
      // this is the LYING pose (see the bed exception on planBedSleep), never the chair-sit pose the
      // seat law bans on a mattress. A bedless power-down (sleep()) still goes dormant standing.
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glance = null; self.glanceCd = 0;                       // frozen: maybeGlance skips goal==='sleep'
      // GETTING IN is what earns the pose. takeSeat() consumes planBedSleep's anchor and is the only
      // thing that can prove this body actually reached the mattress it claimed, so `lying` — which the
      // renderer draws the body ON the bed by — is set HERE and nowhere earlier. A bedless power-down
      // (sleep(), no seatKey/pendSeat) leaves it false and goes dormant standing, as it always did.
      takeSeat();
      self.lying = !!(self.seated && self.seatKey);
      // A REAL SLEEP, 3-10 minutes (the Commander's number), not the ~1-minute doze a standing power-down
      // takes. It is safe to be this long precisely because every summon path wakes it: activity flipping
      // to task/thinking seizes the body (setActivityFor / the hero's summon-seize in tick), and that runs
      // whether the work came from the Commander typing, a schedule firing, or a channel message.
      self.studyUntil = now + (self.lying ? U.irnd(180000, 600000) : U.irnd(26000, 62000));
      curiositySay(USE_LINE.bed, 0.4, now);
    }
    else if (self.goal === 'inspect' || self.goal === 'watch' || self.goal === 'tend' || self.goal === 'gaze' || self.goal === 'quirk' || self.goal === 'stare') {
      // reached the thing — stand, face it, observe for a spell. Familiar things hold the gaze less (habituation).
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.nextFidget = now + U.irnd(700, 1600);
      if (self.goal === 'quirk' || self.goal === 'stare') { const base = self.quirkKind === 'vigil' ? U.irnd(12000, 26000) : U.irnd(4000, 9000); self.studyUntil = now + offbeat(now, base); return; }   // a walked quirk (face-a-wall) or the VIGIL: hold the pose, silent — vigil holds far longer
      const fam = self.studyKey ? (seenCount.get(self.studyKey) || 0) : 0, famK = 1 / (1 + fam * 0.8);
      if (self.studyKey) seenCount.set(self.studyKey, fam + 1);
      if (self.goal === 'tend') { self.studyUntil = now + offbeat(now, U.irnd(3500, 8000)); curiositySay(self.needs.social < 30 ? SELF_TEND : SELF_QUIET, 0.5, now); }
      else if (self.goal === 'gaze') { self.studyUntil = now + offbeat(now, U.irnd(4000, 8000)); curiositySay(SELF_CONTEMPLATE, 0.5, now); }
      else if (self.goal === 'watch') { self.studyUntil = now + U.irnd(6000, 14000) * famK; curiositySay(CURIO_WATCH, 0.5 * famK, now); }
      else {
        // INSPECT: it walked over to a machine to look at it — face the subject and hold the study.
        // (No gesture: the only track available is an arms-up stretch, which is not "examining".)
        self.studyUntil = now + U.irnd(2600, 6000) * famK; curiositySay(self.inspectNovel ? CURIO_NEW_PROP : CURIO_STUDY, (self.inspectNovel ? 0.7 : 0.55) * famK, now);
      }
    }
    else if (self.goal === 'rounds') {
      // a stop on the caretaker lap — face it, a brief ownership beat, then tick advances to the next stop.
      // D5 beat 1: a SUPERVISOR stop (behind a working crew body) gets the same brief 1.5-3s hold (a glance, not
      // the D3 watch's 3-7s study) — the shorter hold IS the supervisor's-glance vs a peer's-watch distinction —
      // with an over-the-shoulder flavor line instead of the ownership beat.
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(1500, 3000);
      curiositySay(self.roundsSup ? SELF_SUPERVISE : SELF_ROUNDS, 0.4, now);
      self.roundsSup = false;
    }
    else if (self.goal === 'mourn') {
      // stands where its thing used to be — a long, near-silent beat (the off-beat duration is the unsettling part)
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = now + 1500; self.studyUntil = now + U.irnd(11000, 22000); curiositySay(MOURN_LINE, 0.4, now);
    }
    else if (self.goal === 'revisit') {
      // back at a favorite haunt, just being there a while
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(5000, 11000); curiositySay(REVISIT_LINE, 0.35, now);
    }
    else if (self.goal === 'place') {
      // it acts on the station: drops a piece of its OWN decor on the empty tile, or removes one it placed before
      self.sitting = false; self.working = false; self.state = 'idle'; self.dir = self.useFace || 'south';
      if (self.placeTarget && station.addProp) {
        const tg = self.placeTarget, res = station.addProp({ t: tg.t, x: tg.x, y: tg.y, w: 1, h: 1, block: false });
        if (res && res.ok) { agentDecor.push(res.id); ownPlaced.add(res.id); if (seenProps) seenProps.add(res.id); curiositySay(SELF_PLACE, 0.6, now); }   // suppress self-novelty so it doesn't go inspect its own work
      } else if (self.removeId && station.removeProp) {
        station.removeProp(self.removeId); const i = agentDecor.indexOf(self.removeId); if (i >= 0) agentDecor.splice(i, 1); curiositySay(SELF_PLACE, 0.4, now);
      }
      self.placeTarget = null; self.removeId = null; self.goal = null; self.idleUntil = now + U.irnd(900, 2000);
    }
    else if (self.goal === 'social') { self.state = 'idle'; self.target = null; self.pathPts = null; }   // TIER D · D3: reached a social waypoint — stay on goal='social'; stepSocial enters the hold next tick
    else if (self.goal === 'gather') { self.state = 'idle'; self.target = null; self.pathPts = null; }   // TIER E: reached the formation slot — stay on goal='gather'; stepGather takes over the facing/hold next tick
    else if (self.goal === 'chase') { self.state = 'idle'; self.target = null; self.pathPts = null; }    // TIER D · D4: reached a pursuit leg — stay on goal='chase'; stepChase repaths (or enters the stare) next tick
    else {
      // a plain stroll (wander/pace) with no goal at the end of it. The walk HEADING used to survive
      // as the facing, so a stroll that ended one tile short of a wall left the body nose to the
      // plaster for the whole dwell. Arriving anywhere is a reason to look around.
      self.state = 'idle'; self.idleUntil = now + U.irnd(1600, 3600);
      if (!self.goal && !self.sitting) { const d = lookDir(self); self.dir = d; setGlance(d, U.irnd(500, 900), now); }
    }
  }
  /* ---------- CONTINUITY OF ATTENTION (the anti-aimlessness fix) ----------
     `wander` samples a UNIFORMLY RANDOM tile of the whole zone, and every idle decision re-rolls from
     scratch — so consecutive strolls ping-ponged across the station and the body never appeared to be
     occupied with anything. That, not a shortage of behaviours, is what reads as aimless.
     An ATTENTION ANCHOR fixes it without adding a single beat: whenever the body chooses to dwell
     somewhere (the same moment `fond` accrues — arrive()'s FOND table), it remembers that tile for a
     while. While the anchor is live, a stroll stays in THAT NEIGHBOURHOOD; when it lapses the body is
     free again and relocates. The result is "explores a corner for a bit, then moves on" instead of
     teleport-tier target picking — one place at a time, which is what having a mind looks like.
     Deliberately SHORT (~25-45s) and never refreshed by wandering itself, so it can't become a leash:
     a body that stops choosing to dwell always drifts free. Determinism: U.irnd only. */
  const ATTN_R = 5;   // tiles: the radius of the neighbourhood a live anchor holds a stroll inside
  function noteAttn(now) {
    if (!self) return;
    const t = tileOf(self.px, self.py);
    self.attn = { x: t.x, y: t.y, until: now + U.irnd(25000, 45000) };
  }
  function wander(now) {
    const rects = geo.allRects;
    if (!rects.length) { self.idleUntil = now + 800; return; }
    const cur = tileOf(self.px, self.py);
    const avoid = beltUnion();   // desk footprint + belt tiles: an idle stroll should step AROUND the machinery
    const zone = zoneFor(self);   // P1: a stroll stays inside the body's own zone
    const attn = (self.attn && now < self.attn.until) ? self.attn : null;   // occupied with a neighbourhood? keep the stroll there
    for (let i = 0; i < 24; i++) {
      // While an anchor is live the first two-thirds of the tries sample its neighbourhood; the tail falls
      // back to the free station-wide pick so a walled-in / exhausted anchor can NEVER strand the stroll.
      // Out-of-bounds samples are impossible to act on — geo.walkable range-checks before anything else.
      let x, y;
      if (attn && i < 16) { x = attn.x + U.irnd(-ATTN_R, ATTN_R); y = attn.y + U.irnd(-ATTN_R, ATTN_R); }
      else { const r = rects[U.irnd(0, rects.length - 1)]; x = U.irnd(r.x1, r.x2); y = U.irnd(r.y1, r.y2); }
      if (!tileInZone(zone, x, y)) continue;                 // off-zone target — never stroll out of the body's area
      if (!geo.walkable(x, y, blocked)) continue;
      if (avoid.has(x + ',' + y)) continue;                  // don't stroll to a belt tile
      const avoidLive = movementBlockers(self, avoid);
      const blockedLive = movementBlockers(self, blocked);
      if (tileBlockedFor(blockedLive, x, y)) continue;
      let p = geo.path(cur.x, cur.y, x, y, avoidLive);       // prefer a belt/body-free route
      if (!p) p = geo.path(cur.x, cur.y, x, y, blockedLive); // fall back: a belt bridges the only way across
      if (p && p.length) { self.goal = null; self.pathPts = p; self.pathIdx = 0; self.state = 'walk'; nextWaypoint(); return; }
    }
    self.idleUntil = now + 800;
  }

  /* desk footprint ∪ all belt tiles ∪ non-blocking prop footprints — the soft no-tread set.
     Non-blocking props (bays, inbox/outbox chutes, filters, dropped decor) stay WALKABLE — bodies
     dock on bay tiles, airlocks are doors — but a body with prop awareness steps AROUND the
     machinery when any other route exists. Rugs and airlocks are meant to be crossed; skip them. */
  const SOFT_CROSS = new Set(['rug', 'rug_small', 'rug_large', 'airlock']);
  function beltUnion() {
    const s = new Set(blocked);
    const belts = (geo && geo.belts) || [];
    for (const b of belts) s.add(b.x + ',' + b.y);
    const props = (geo && geo.props) || [];
    for (const p of props) {
      if (p.block !== false || SOFT_CROSS.has(p.t)) continue;   // blocking props are already hard-blocked in geo.walkable
      for (let dy = 0; dy < (p.h || 1); dy++) for (let dx = 0; dx < (p.w || 1); dx++) s.add((p.x + dx) + ',' + (p.y + dy));
    }
    return s;
  }

  /* ---------- IDLE ZONE (P1: cage every hero idle picker to the agent's own area) ----------
     A "zone" is the area a body may ROAM while idle, DERIVED on the fly from the room rects +
     props the world already holds (never persisted — shared/events.js/schema.js untouched). It is
     the room enclosing the body's assigned workstation/bay; a leash radius if it sits on open floor;
     null if it has no assignment (then it does not roam). The pure geometry lives in app/zones.js
     (window.Zones), unit-tested headlessly; this thin wrapper just resolves the anchor + room rects
     from `geo` for a given body. Guarded on `typeof Zones` (mirrors the PropAnchor/Conveyor guards)
     so a missing module degrades to "no zone object" rather than a hard error mid-tick.

     INVARIANT I2 (HERO PARITY) / A3 (SOLE OWNERSHIP): when one agent effectively owns the space
     (`soleOwner(body)` — no other bound bay/crew body), its zone WIDENS to the union of every room
     rect (the whole reachable floor = the exact geo.allRects set the pre-change pickers drew from),
     so EVERY previously-valid cross-room target stays in-zone and the 8 sentience passes are
     unchanged — even in a multi-room built-out solo station where the desk room is only ONE room.
     This is the real condition (sole-ownership widening), not "the desk room spans the station"
     (which only holds for a fresh single-room floor). Multi-room lane discipline (caging each body
     to its own room) is the intended NEW behavior ONLY once more than one agent shares the floor.

     anchorFor(body): the body's own workstation/bay foot tile — its STABLE home (never its transient
     px/py, so the zone doesn't drift as it walks). Hero falls back to the module `seat` (its synthetic
     desk) when it has no placed workstation prop; crew resolve purely via deskPropFor/bay (P2/P3). */
  /* The returned tile carries `assigned` for posting semantics, but every PLACED body's STABLE
     anchor may own the same bounded roam radius. A deskless body uses its immutable spawn home,
     so widening it cannot ratchet across the station as it walks. */
  function anchorFor(body) {
    if (!geo) return null;
    const aid = body && body.id;
    const dp = aid && deskPropFor(aid);
    if (dp) return { x: dp.x, y: dp.y, assigned: true };
    if (aid && geo.props) { const bay = geo.props.find(p => p.t === 'bay' && p.agentId === aid); if (bay) return { x: bay.x, y: bay.y, assigned: true }; }
    if (body === agent && seat) return { x: seat.tx, y: seat.ty, assigned: true };   // hero on the synthetic auto-desk
    // A2 leash fallback: a PLACED crew body with no workstation/bay (the common freshly-summoned worker
    // before the user assigns it a PC) anchors on its OWN foot tile, so zoneFor yields a bounded leash
    // around its spawn spot instead of null — keeping it alive (BR-4 'summoned agents move') without
    // letting it roam the whole floor. Unplaced/dormant bodies still return null (A2: no zone, no roam).
    if (body && body.crewBody && !body.unplaced) return body.home ? { x: body.home.x, y: body.home.y } : tileOf(body.px, body.py);
    return null;
  }
  /* soleOwner(body): does this body effectively own the WHOLE station (so its zone must widen to
     the whole floor per A3/I2)? True when no OTHER placed body shares the floor — i.e. every crew
     body is unplaced (dormant at spawn, occupying nothing). The lone hero in a built-out multi-room
     station is the realistic solo case: caging it to its desk room would strip previously-valid
     cross-room idle targets (the I2 regression). When ANY other body is placed, lane discipline
     kicks in and each body is caged to its own room. The hero is the only sole-owner candidate;
     a crew body is, by definition, never alone while the hero is on the floor. */
  function soleOwner(body) {
    if (body !== agent) return false;                 // only the hero can solely own the floor
    if (agent && agent.unplaced) return false;        // an unplaced hero owns nothing
    return crew.every(b => b && b.unplaced);          // no OTHER placed body shares the station
  }
  /* TRUE ROAM RADIUS (2026-08-08 idle-life pass). Every placed body gets one immutable
     desk/spawn-centered distance leash across the station floor. Room plates do not widen or clip
     it; walkability and the existing pathfinder decide which in-radius destinations are reachable. */
  function zoneFor(body) {
    if (typeof Zones === 'undefined' || !geo) return null;
    const a = anchorFor(body);
    return Zones.computeZone({
      rects: geo.allRects, props: geo.props, agentId: body && body.id, anchorTile: a,
      roamR: a ? Zones.ROAM_RADIUS : 0,
      solo: soleOwner(body),
    });
  }
  // membership shorthands — a null zone admits NOTHING (the body has no roam area → fall through to
  // an in-place beat). When Zones is absent the wrapper returns null; treat that as "uncaged" so a
  // module load failure can never freeze the agent — true(in-zone) for every tile.
  function tileInZone(zone, tx, ty) { return (typeof Zones === 'undefined') ? true : Zones.inZone(zone, tx, ty); }

  /* ---------- SIGHTLINE: A WALL IS A WALL (2026-08-17, Andrew: "they talk to each other through walls")
     Every cross-body beat — the glance, the huddle, the border meeting — resolved "can these two see
     each other?" as PROXIMITY plus ZONE MEMBERSHIP, and a zone (zones.js) is a 14-tile Chebyshev radius
     around a desk intersected with the station's floor rects. A radius does not know about plaster: two
     bodies three tiles apart in DIFFERENT ROOMS both sit inside each other's radius and over floor, so
     they read as in sight with a wall between them. The D3 border meeting then made it structural rather
     than accidental — it walks both bodies to their own side of a shared room edge and has them converse
     across it, which on any real floor is across the wall.

     losClear is the honest test and it is the same shape worldmodel's own path-smoother uses: walk the
     tile line between the two feet; every touched tile must be REAL FLOOR (zoneGrid is null on a wall or
     on void) and every hop must satisfy geo.canStep, so a room boundary without a door — and a room
     sealed by an airlock — blocks sight exactly as it already blocks walking.

     PROPS ARE DELIBERATELY NOT OCCLUDERS. `walkable` would also fail on a couch, and a couch between two
     agents does not stop a conversation. This asks one question only: is there a wall in the way.

     Fail-open on a missing module shape, exactly like tileInZone above — a geometry gap must never be
     able to freeze the social engine into permanent silence. */
  /* LOS-PURE-GEOMETRY-BEGIN — losWalk is PURE (Math.* + its own params; both the floor test and the
     seam test are INJECTED), so test/sightline.test.js extracts THIS marked block from the source and
     executes it headlessly — the shipped walk is what's under test, not a copy. Same discipline as the
     D3-PURE-GEOMETRY block below. Keep it self-contained. */
  function losWalk(ax, ay, bx, by, floorFn, stepFn) {
    if (!floorFn(ax, ay) || !floorFn(bx, by)) return false;
    let x = ax, y = ay;
    // Each iteration steps the DOMINANT remaining axis by one tile, so the walk hugs the straight line
    // (a supercover staircase — no tile the line crosses is jumped over) and |dx|+|dy| falls by exactly
    // one every pass, which is what makes the loop provably terminate.
    for (let guard = Math.abs(bx - ax) + Math.abs(by - ay); guard > 0; guard--) {
      const dx = bx - x, dy = by - y;
      let nx = x, ny = y;
      if (Math.abs(dx) >= Math.abs(dy)) nx = x + Math.sign(dx); else ny = y + Math.sign(dy);
      if (!floorFn(nx, ny) || !stepFn(x, y, nx, ny)) return false;
      x = nx; y = ny;
    }
    return x === bx && y === by;
  }
  /* LOS-PURE-GEOMETRY-END */
  function losClear(ax, ay, bx, by) {
    // COLS/ROWS are in the guard on purpose: the bounds test below reads them, and `x < undefined` is
    // FALSE — a geo without them would make every tile "not floor" and silence the whole social engine.
    // The fail-open promise is only kept if the guard covers everything the test touches.
    if (!geo || !geo.zoneGrid || !geo.COLS || !geo.ROWS || typeof geo.idx !== 'function' || typeof geo.canStep !== 'function') return true;
    // BOUNDS FIRST, always: geo.idx is a flat row-major index with no range check, so idx(-1, y) and
    // idx(COLS, y) ALIAS onto the neighbouring ROW — an off-grid coordinate would read a real zone id
    // and report void as floor. Bodies are always on the grid so this can't bite in play, but a probe
    // that scans past the station's edge is exactly how a silent aliasing bug gets shipped.
    const floor = (x, y) => (x >= 0 && y >= 0 && x < geo.COLS && y < geo.ROWS && geo.zoneGrid[geo.idx(x, y)] != null);
    return losWalk(ax, ay, bx, by, floor, geo.canStep);
  }
  // the same test between two BODIES, on their logical foot tiles (a seated body still carries px/py there)
  function bodiesInSight(a, b) {
    if (!a || !b) return false;
    const ta = tileOf(a.px, a.py), tb = tileOf(b.px, b.py);
    return losClear(ta.x, ta.y, tb.x, tb.y);
  }

  function movementBlockers(body, base) {
    const s = new Set(base || []);
    const mark = (b) => {
      if (!b || b === body || b.unplaced) return;
      const t = tileOf(b.px, b.py);
      s.add(t.x + ',' + t.y);
      if (b.target) {
        const tt = tileOf(b.target.x, b.target.y);
        s.add(tt.x + ',' + tt.y);
      }
    };
    mark(agent);
    for (const b of crew) mark(b);
    return s;
  }
  function tileBlockedFor(blockers, tx, ty) {
    return blockers && blockers.has(tx + ',' + ty);
  }

  /* ---------- BODIES ARE SOLID (2026-08-17, Andrew: "the agents walk through one another") ----------
     They did, and movementBlockers above is exactly why it LOOKED handled: setPathTo plans around the
     other bodies' tiles, but that is a ONE-SHOT SNAPSHOT taken the instant a path is plotted. Nothing
     re-reads it while the legs run, so two bodies crossing the same corridor — or one walking onto a
     tile another has since stopped on — simply interpenetrate, and at T=12 with a ~35px sprite the two
     merge into a single smear.

     This is a SOFT separation, not a hard collision, and that is deliberate. The engine has no steering:
     a hard block would stand two bodies nose to nose in a corridor with no rule that resolves it, and it
     would fight arrive()'s snap-to-target. Instead, once every body has moved for the frame, any pair
     closer than PERSONAL_TILES is pushed apart along the line between them, each taking half — so they
     visibly squeeze PAST one another instead of through.

     What is exempt, and why:
       · a SEATED body (sitting/seated — desk chair, couch cushion, bed) is an ANCHOR. Its pose is bound
         to a prop's geometry and the cushion swap is draw-time only, so nudging it would slide the
         sprite off its own seat. It pushes; it is never pushed.
     A first cut also exempted any body on a 'social'/'gather' goal, reasoning that those beats own their
     own spacing. That was WRONG and the live probe caught it: a social beat owns the tiles it ENDS on,
     not the walk in, so two bodies converging on a huddle were exempt from separation for the entire
     approach — the exact moment they cross. The exemption is unnecessary anyway, because PERSONAL_TILES
     is UNDER one tile: every beat that stands two bodies on ADJACENT tiles (huddle, border, the
     gathering ring) is already untouched by construction. Only real overlap is ever resolved.

     Containment is a law here (test/crew-containment.test.js): a nudge that would put a body's feet on
     a tile it may not stand on is dropped, never clamped, so separation can push nobody into a wall. */
  const PERSONAL_TILES = 0.8;      // min centre-to-centre spacing, in tiles. < 1 so adjacent-tile beats never fight it.
  const SEP_JAM_MS = 2500;         // continuously shoved while walking for this long → give up on the leg and re-decide
  const SEP_PASSES = 4;            // relaxation sweeps per frame — a pile of three needs more than one pass to settle
  function nudgeBody(b, dx, dy) {
    const nx = b.px + dx, ny = b.py + dy;
    const t = tileOf(nx, ny);
    if (!geo.walkable(t.x, t.y, blocked)) return false;   // would leave the floor / enter a blocking prop — drop the push
    b.px = nx; b.py = ny;
    return true;
  }
  /* SLIDE, don't stick. A push straight away from the partner can be refused by containment when the
     body is standing against a wall or a desk — and a refused push leaves the overlap unresolved
     forever, which is the bug wearing a hat. So fall back to the two single-axis components: a body
     pinned against a wall can still move ALONG it. One axis only, never both in sequence, or the body
     would travel further than the overlap it is resolving. */
  function pushApart(b, dx, dy) {
    if (nudgeBody(b, dx, dy)) return true;
    if (dx && nudgeBody(b, dx, 0)) return true;
    if (dy && nudgeBody(b, 0, dy)) return true;
    return false;
  }
  function separateBodies(now) {
    if (!geo || typeof geo.walkable !== 'function') return;
    const list = [];
    if (agent && !agent.unplaced) list.push(agent);
    for (const b of crew) if (b && !b.unplaced) list.push(b);
    if (list.length < 2) return;
    const R = PERSONAL_TILES * T, R2 = R * R;
    const anchored = b => !!(b.sitting || b.seated);   // seated only — see the note above: a walk-in is exactly when they cross
    const shoved = new Set();
    /* RELAX, don't single-shot. Resolving pair by pair is only exact for ONE pair: in a pile of three
       (which a huddle walk-in routinely makes) fixing B–C re-breaks A–B, so a single sweep leaves the
       cluster short of the law. A handful of sweeps settles it inside the same frame; the early-out
       means the overwhelmingly common case — nobody overlapping at all — still costs exactly one
       O(N²) scan over a handful of bodies. */
    for (let pass = 0; pass < SEP_PASSES; pass++) {
      let touched = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const pa = anchored(a), pb = anchored(b);
          if (pa && pb) continue;                       // two anchored bodies: neither may move, leave them be
          let dx = b.px - a.px, dy = b.py - a.py, d2 = dx * dx + dy * dy;
          if (d2 >= R2) continue;
          if (d2 < 1e-6) { dx = ((i + j) & 1) ? 0 : 1; dy = ((i + j) & 1) ? 1 : 0; d2 = 1; }   // exactly coincident: a STABLE per-pair axis, never RNG (determinism, I3)
          const d = Math.sqrt(d2), ux = dx / d, uy = dy / d, push = (R - d) / 2;
          // an anchored partner hands its whole half to the body that can actually move
          const sa = pb ? 2 : (pa ? 0 : 1), sb = pa ? 2 : (pb ? 0 : 1);
          const movedA = !!sa && pushApart(a, -ux * push * sa, -uy * push * sa);
          const movedB = !!sb && pushApart(b, ux * push * sb, uy * push * sb);
          // ...and so does a partner whose OWN push containment refused. Without this the pair keeps its
          // overlap indefinitely whenever one of them is standing against a wall — the live soak found a
          // pair holding 9.15px against a 9.6px law for exactly this reason.
          if (movedA && !movedB && sa === 1) pushApart(a, -ux * push, -uy * push);
          if (movedB && !movedA && sb === 1) pushApart(b, ux * push, uy * push);
          if (movedA) { shoved.add(a); touched = true; }
          if (movedB) { shoved.add(b); touched = true; }
        }
      }
      if (!touched) break;   // nothing overlapped this sweep — the floor is already legal
    }
    /* JAM RELEASE. A walker whose destination another body has since parked on would otherwise push in
       and be pushed back forever (arrive() never fires, the legs cycle in place). Continuous shoving
       across SEP_JAM_MS means the leg is not going to complete: drop the path so the next tick re-decides
       — the same self-heal shape the stuck-walker guards in tick/crewEngineStep already use. A body that
       merely squeezed past clears its stamp the first frame it isn't touched, so this only ever fires on
       a genuine standoff. */
    for (const b of list) {
      if (!shoved.has(b)) { b.sepSince = 0; continue; }
      if (b.state !== 'walk') { b.sepSince = 0; continue; }
      /* NOT a body mid-encounter. seizeFromIdle clears `goal` but deliberately does NOT clear `b.social`
         (nothing else needs it to), and encounterBroken tests exactly `social == null` — so releasing a
         social/gather walker here would leave the beat undetectably half-dead, holding the single station
         slot until its hard timeout. It also does not need releasing: stepSocial/stepGather re-path every
         tick and both beats already carry their own hard timeout, so a jam there is bounded anyway. */
      if (b.goal === 'social' || b.goal === 'gather') { b.sepSince = 0; continue; }
      if (!b.sepSince) { b.sepSince = now; continue; }
      if (now - b.sepSince < SEP_JAM_MS) continue;
      b.sepSince = 0;
      seizeFromIdle(b);                                     // drop the in-flight idle goal + any seat claim it had reserved
      b.pathPts = null; b.target = null; b.state = 'idle'; b.idleUntil = now + U.irnd(300, 900);
    }
  }

  /* ---------- crew movement helper ----------
     A crew body walks to its assigned chair when working (stepCrewToSeat below). When NOT working it now runs the
     HERO's full sentience engine per-body (crewEngineStep, Tier B2) instead of the old light crewWander stepper —
     so an idle crew body has needs/temperament/want-engine/quirks, caged to its own zone, not just a random stroll.
     crewNextWaypoint is the path-stepper the working-path (stepCrewToSeat) still uses. */
  function crewNextWaypoint(b) {
    if (!b.pathPts || b.pathIdx >= b.pathPts.length) { b.target = null; return; }
    const wp = b.pathPts[b.pathIdx++];
    b.target = footOf(wp.x, wp.y);
  }
  /* a working crew body walks to the chair in front of its assigned desk and sits facing it — the hero's exact
     desk pose, generalised to crew: foot on the front tile, dir north, sitting (the chair sprite y-sorts behind
     so it reads as sitting IN the chair). Returns once seated; until then it advances along a path to the seat. */
  function stepCrewToSeat(b, s, dt, now) {
    const foot = seatFoot(s);
    if (Math.hypot(foot.x - b.px, foot.y - b.py) < 1.1) {   // arrived → sit at the desk
      b.px = foot.x; b.py = foot.y; b.pathPts = null; b.target = null; b.state = 'idle'; b.sitting = true; b.dir = 'north';
      return;
    }
    if (!b.target) {   // plot a fresh path to the chair tile
      const cur = tileOf(b.px, b.py);
      const blockers = movementBlockers(b, blocked);
      if (tileBlockedFor(blockers, s.tx, s.ty)) { b.state = 'idle'; b.sitting = false; return; }
      // prop awareness: prefer the machinery-avoiding route to the chair; fall back when it's the only way
      const p = geo.path(cur.x, cur.y, s.tx, s.ty, movementBlockers(b, beltUnion()))
        || geo.path(cur.x, cur.y, s.tx, s.ty, blockers);
      if (p && p.length) { b.pathPts = p; b.pathIdx = 0; crewNextWaypoint(b); }
      else { b.px = foot.x; b.py = foot.y; b.sitting = true; b.dir = 'north'; b.state = 'idle'; return; }   // unreachable → snap into the seat
    }
    if (b.target) {
      const dx = b.target.x - b.px, dy = b.target.y - b.py, d = Math.hypot(dx, dy);
      const more = !!(b.pathPts && b.pathIdx < b.pathPts.length);
      // CORNER LOOKAHEAD: hand over to the next waypoint EARLY, and — critically — do NOT snap onto it.
      // The old code teleported px/py exactly onto every waypoint, which is what made the body pivot on the
      // spot at each tile. Only the FINAL waypoint still snaps, so an arrival settles on an exact position.
      if (d < (more ? CORNER_LOOK : 1.1)) {
        if (more) crewNextWaypoint(b);
        else { b.px = b.target.x; b.py = b.target.y; b.target = null; }
      } else {
        const sp = stepGait(b, dx, dy, d, 28, !more, dt);
        b.px += dx / d * sp; b.py += dy / d * sp; b.state = 'walk'; b.sitting = false;
      }
    }
  }
  /* ---------- per-body sentience engine (Tier B2) ----------
     The HERO's idle/dwell ladder (tick ~1644-1687), generalised to the CURRENT body (`self`). The caller in
     stepCrew sets self=b, calls this, then UNCONDITIONALLY restores self=agent — so every read/write here lands on
     the crew body, and the hero's own run (self===agent) is byte-identical to before (J1). What is DELIBERATELY left
     out vs the hero tick (hero-identity, not idle life): the summon-seize block (crew route through b.working in
     stepCrew, J4), FIRST LIGHT / stepFirstWake (hero-only G2), maybeGlance + the belt-yield shouldYieldToCargo()
     hold (Commander/camera-coupled; shouldYieldToCargo reads agent.target — hero-only). decideIdle's grief/novelty
     reflexes are already self===agent-gated, so a crew body here only consumes its OWN want-engine + quirks. Every
     target picker it can reach is caged to zoneFor(self)=zoneFor(b) (Tier A), so no body leaves its zone (J3). */
  function crewEngineStep(dt, now) {
    const SPEED = 28 * (self.pers ? self.pers.pace : 1);   // a calm background pace (a touch under the hero's 34), tilted by temperament
    // a just-finished task leaves the desk-sit pose (stepCrewToSeat set sitting=true). The engine only keeps sitting
    // for a leisure dwell (goal use/lounge) or a BED sleeper (planBedSleep, which claims a real mattress);
    // any other goal → stand, or the !sitting decideIdle gate freezes it. Omitting 'sleep' here stood every
    // bed sleeper back up on its first tick, which is the whole feature undone one line away from where it is built.
    if (self.sitting && self.goal !== 'use' && self.goal !== 'lounge' && !(self.goal === 'sleep' && self.seatKey)) { self.sitting = false; self.state = 'idle'; self.idleUntil = Math.max(self.idleUntil || 0, now + U.irnd(200, 800)); }
    // self-heal a stuck walker (mirrors the hero tick): walk pose with nowhere to go → drop to idle so this tick re-decides
    if (self.state === 'walk' && !self.target && (!self.pathPts || self.pathIdx >= self.pathPts.length)) { self.state = 'idle'; self.idleUntil = 0; }
    // TIER D · D1 ATTENTIVE AUDIENCE: if the Commander has COMMS focus on THIS crew body and it's idle, hold its
    // attention on you (faces south; rare throttled cursor-follow beat) every tick — crew have no maybeGlance, so the hold drives
    // facing directly. Self-gates OFF while working/walking/mid-goal (b.working is set ABOVE in stepCrew, so a live
    // run never reaches here), so the work-seize always wins (G2). A held body skips the rest of the idle engine.
    if (chatStareHold(now)) return;
    // TIER D · D3: this crew body is in a live social encounter → the guard (hard timeout + partner-broken, G4/K3)
    // then stepSocial ((re)path or hold). Runs BELOW the b.working seize (stepCrew skips this whole fn while working),
    // so a summon always wins (G2). stepSocial (re)establishes self.target; the walk block below then advances it.
    if (self.goal === 'social') { if (!stepSocialGuard(now)) stepSocial(now); }   // may (re)set self.target (walk) or clear goal (ended)
    // TIER E: this crew body is in THE GATHERING. Same position in the order as the social stepper and
    // for the same reason — it sits BELOW the b.working seize (stepCrew skips this fn entirely while
    // working), so work arriving always scatters the assembly rather than being made to wait for it.
    if (self.goal === 'gather') { if (!gathering || !self.gather) { releaseFromGathering(self, now, false); } else stepGather(now); }
    // TIER D · D4: this crew body's cursor-mimic (head-only) / THE CHASE (walk-pursue-stare) steppers. Below the
    // b.working seize (stepCrew skips this whole fn while working), so a summon always wins (G2). stepChase may
    // (re)set self.target (a pursuit leg); the walk block below then advances it.
    if (self.goal === 'mimic') stepMimic(now);
    if (self.goal === 'chase') stepChase(now);
    // W4: someone walking past a standing body gets a look and a raised hand. Consulted every tick
    // (its own scan gap + long cooldown do the throttling) because the passer is only in range for a
    // second or two — waiting for this body's next idle re-decide would miss it. Gaze + emote only.
    maybeAcknowledge(now);
    if (self.target) {
      if (now < (self.pauseUntil || 0)) {
        self.state = 'idle';                                // a deliberate hold mid-walk (maybeStrollBeat's considered pause / double-take)
        if (self.pauseLook === 'back') self.dir = OPP[self.dir] || self.dir;
      } else {
        const dx = self.target.x - self.px, dy = self.target.y - self.py, d = Math.hypot(dx, dy);
        const more = !!(self.pathPts && self.pathIdx < self.pathPts.length);
        if (d < (more ? CORNER_LOOK : 1.1)) {   // early hand-over, no snap — see stepCrewToSeat's note
          if (more) nextWaypoint();
          else { self.px = self.target.x; self.py = self.target.y; arrive(now); }
        } else {
          const s = stepGait(self, dx, dy, d, SPEED, !more, dt);
          self.px += dx / d * s; self.py += dy / d * s; self.state = 'walk';
        }
      }
    } else if (self.goal === 'social') {
      // TIER D · D3: in a social encounter with no active target = the HOLD phase (or a between-steps beat). stepSocial
      // above already set the facing/until; this branch just STOPS the ladder from falling through to decideIdle, which
      // would clear stilling + pick a wandering beat and stomp the encounter. The guard/stepSocial own the lifecycle.
      self.state = 'idle';
    } else if (self.goal === 'gather') {
      // TIER E: standing in the assembly with no active target. Same job as the social branch above — stop the
      // ladder reaching decideIdle, which would pick a wander and pull this body out of the formation.
      self.state = 'idle';
    } else if (self.goal === 'mimic' || self.goal === 'chase') {
      // TIER D · D4: mimic (head-only) / chase (stare or between-repaths) with no active target. stepMimic/stepChase
      // above own the facing + lifecycle; this branch just STOPS the fall-through to decideIdle (which would stomp it).
      self.state = 'idle';
    } else if (self.goal === 'use') {
      if (now >= self.useUntil) { releaseSeat(); self.goal = null; self.usingProp = null; self.useBeat = null; self.sitting = false; self.state = 'idle'; self.glance = null; self.trackUntil = 0; self.glanceCd = now + U.irnd(5000, 9000); self.idleUntil = now + U.irnd(2500, 4500); }
    } else if (self.goal === 'lounge') {
      if (now >= self.useUntil) { releaseSeat(); self.goal = null; self.usingProp = null; self.watchProp = null; self.sitting = false; self.state = 'idle'; self.glance = null; self.trackUntil = 0; self.glanceCd = now + U.irnd(5000, 9000); self.idleUntil = now + U.irnd(2500, 4500); }
    } else if (self.goal === 'rounds') {
      if (now >= self.studyUntil) roundsNext(now);
    } else if (self.goal === 'sleep') {
      // releaseSeat FIRST: a bed sleeper holds a mattress claim now (planBedSleep), and waking without
      // dropping it would leak the bed forever — the same leak B2 had to fix for couch cushions.
      if (now >= self.studyUntil) { releaseSeat(); self.goal = null; self.usingProp = null; self.sitting = false; self.glanceCd = 0; self.state = 'idle'; self.idleUntil = now + U.irnd(600, 1800); }
    } else if (self.goal === 'inspect' || self.goal === 'watch' || self.goal === 'tend' || self.goal === 'gaze' || self.goal === 'quirk' || self.goal === 'stare' || self.goal === 'mourn' || self.goal === 'revisit') {
      if (now >= self.studyUntil) {
        const back = (self.goal === 'inspect' || self.goal === 'watch') ? self.useFace : null;
        self.goal = null; self.usingProp = null; self.studyKey = null; self.quirkKind = null; self.state = 'idle'; self.idleUntil = now + U.irnd(1400, 3000);
        if (back && U.chance(0.5)) setGlance(back, U.irnd(500, 900), now);
      }
    } else if (self.state !== 'walk' && !self.sitting && now >= self.idleUntil) {
      decideIdle(now);   // the want-engine (wander is its fallback) — caged to zoneFor(self)
    }
  }
  // CONTAINMENT BACKSTOP (agent-in-the-void escape, 2026-07-12): a standing body whose feet are not
  // on real floor is out of the world — whatever re-frame/re-foot path was missed, it must never be
  // RENDERED adrift. Prefer the nearest walkable tile (a prop dropped underfoot stays local); a body
  // truly in the void (no floor within the ring) re-homes to the spawn room like the hero's
  // ensureAgentValid. Seated/desk-sitting poses keep their logical foot on a walkable tile (the
  // cushion swap is draw-time only), so a standing-body check is the complete invariant.
  function containBody(b, now) {
    if (b.seated || b.sitting) return;
    const t = tileOf(b.px, b.py);
    if (geo.walkable(t.x, t.y, blocked)) return;
    if (b.target) return;   // mid-walk — a transit artefact of footOf/tileOf, not a stranded body (see TRANSIT READING above ensureAgentValid)
    seizeFromIdle(b);   // off the floor = every in-flight goal/claim is in a broken frame — drop them
    let f = null;
    for (let r = 1; r <= 6 && !f; r++) for (let dy = -r; dy <= r && !f; dy++) for (let dx = -r; dx <= r && !f; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (geo.walkable(t.x + dx, t.y + dy, blocked)) f = footOf(t.x + dx, t.y + dy);
    }
    if (!f) f = workerFoot();
    b.px = f.x; b.py = f.y; b.home = tileOf(f.x, f.y);
    b.pathPts = null; b.target = null; b.state = 'idle'; b.idleUntil = now + U.irnd(400, 1200);
  }
  function stepCrew(dt, now) {
    if (!geo || !crew.length) return;
    for (const b of crew) {
      if (b.unplaced) continue;
      containBody(b, now);   // never step (or render) a body that is off the floor
      if (b.working) {                                 // running → sit at its desk if it has one, else stand where work is delivered
        const dp = deskPropFor(b.agentId), s = dp ? deskSeat(dp) : null;
        if (s) stepCrewToSeat(b, s, dt, now);
        else { b.pathPts = null; b.target = null; b.state = 'idle'; b.sitting = false; }
        continue;                                      // J4: the working seize sits ABOVE the engine — a task always wins
      }
      // PLACED + NON-WORKING → run the full sentience engine on THIS body, caged to its own zone.
      // DESK-STUCK FIX (Andrew escape 2026-07-07): this was gated on `b.summoned`, which starved every
      // PLAN-DERIVED (bay-bound) crew body of the idle engine — so a bay body froze wherever work was last
      // delivered: at its bay when idle ("hidden behind the bays"), and at its workstation seat after a run
      // ended ("walks to its desk and stands there eternally"). crewEngineStep already un-sticks the just-
      // finished desk-sit (its `sitting && goal!==use/lounge → stand + re-decide` line) and every target
      // picker is caged to zoneFor(b) — which anchorFor() resolves to the body's OWN bay tile — so a bay body
      // wanders a bounded area around its bay and is re-seized to it the instant work arrives (b.working above,
      // K3/J4). The `summoned` flag still governs floor-reload retention (it's an app-level, not floor-bound,
      // body), NOT whether a body is alive. Every crew body now has the inner life; none freezes at its post.
      // self=b for the duration, then UNCONDITIONALLY restore self=agent so the next body / the hero tick is clean (J1/J2).
      self = b;
      tickNeeds(dt);          // this body's own meters drain/refill by what IT is doing
      crewEngineStep(dt, now);
      self = agent;           // MANDATORY restore — a single synchronous tick, no re-entrancy once every body restores
    }
  }

  // the catalog `use` descriptor for a placed prop, or null if it isn't a leisure prop
  function propUse(p) {
    if (typeof PropSprites === 'undefined' || typeof PropAnchor === 'undefined') return null;
    const s = PropSprites.spec(p.t);
    return s && s.use ? s.use : null;
  }
  /* the side an agent walks up to, TURNED WITH THE PROP. A catalog `use.approach` was authored back
     when every prop faced south, so it names a side in the prop's OWN frame ("my front is south") —
     turn a lounge chair to face west and that side has to turn with it, or the body stands at the
     chair's flank staring at its armrest. 'auto' (try every side) has no frame to turn, and an
     unturned prop (r absent) resolves byte-identically to the pre-rotation behaviour. */
  function useApproach(use, p) {
    const want = (use && use.approach) || 'south';
    if (want === 'auto' || !p || !p.r) return want;
    return PropAnchor.turnSide ? PropAnchor.turnSide(want, p.r) : want;
  }
  // FLOOR DECAL? (catalog `flat` — rug / cable run / hazard pad). Deck paint with zero rise: it renders
  // in its own pass UNDER every body and prop, because a decal y-sorted with the bodies buries whoever
  // walks across its northern rows (a 4×3 rug sorts at its SOUTH edge, so an agent standing on its top
  // row sorted first and the rug painted straight over the agent — "agents can't walk on the rug").
  function isFlatProp(t) {
    if (typeof PropSprites === 'undefined' || !PropSprites.spec) return false;
    const s = PropSprites.spec(t);
    return !!(s && s.flat);
  }
  // the `use.kind` of a placed prop BY ID (what arrive() has to work with), or null
  function useKindOf(propId) {
    if (!propId || !geo || !geo.props) return null;
    const p = geo.props.find(q => q.id === propId); if (!p) return null;
    const u = propUse(p); return u ? u.kind : null;
  }
  // OWNERSHIP: a prop that gets ASSIGNED to an agent for a gamified capability (a PC/workstation, cabinet, dish,
  // notebook, connector, workbench, or a docking bay) is that agent's ALONE — only its assignee walks over to
  // use/inspect it. Leisure + decor (couch/tv/arcade/plant) stay shared. An UNASSIGNED capability prop belongs to
  // no one yet, so no agent is drawn to it either ("...or simply not assigned to them"). This keeps complex
  // multi-agent factory floors legible: agents never wander to another agent's (or an unclaimed) workstation.
  function isOwnableProp(t) { return !!(station && typeof station.capForProp === 'function' && station.capForProp(t)) || t === 'bay'; }
  function mayTouchProp(agentId, p) { return !p || !isOwnableProp(p.t) || p.agentId === agentId; }

  /* ---------- placed workstations = clones of the hero's desk+chair ----------
     A placed PC (any computer-capability prop) is a real workstation: it gets a chair attached in front and
     its ASSIGNED agent walks over and sits in it to work — the exact desk behaviour the hero has at its
     preinstalled desk, just bound to another agent. These three helpers + stepCrewToSeat (below) are the whole
     of that promise; rendering draws F_chair at deskSeat() so the chair lines up with where the body sits. */
  function isWorkstationProp(t) { return !!(station && typeof station.capForProp === 'function' && station.capForProp(t) === 'computer'); }
  // the placed workstation bound to this agent, or null (first match — one PC per agent is the rule)
  function deskPropFor(aid) {
    if (!geo || !geo.props || !aid) return null;
    for (const p of geo.props) if (p.agentId === aid && isWorkstationProp(p.t)) return p;
    return null;
  }
  // the chair tile in front of a workstation: the south-front approach tile (PropAnchor falls back to other
  // sides if the front is walled), facing INTO the desk — mirrors the hero's seat one row below its desk.
  function deskSeat(prop) {
    if (typeof PropAnchor === 'undefined' || !geo || !prop) return null;
    const a = PropAnchor.deriveAnchor(prop, geo, { approach: 'south', sit: true, extra: blocked });
    // `cx` = the FRACTIONAL tile x that centres a 1-tile chair on the desk. PropAnchor picks the nearest
    // walkable WHOLE tile (pathing needs one), but an even-width desk's centre line falls on a tile
    // boundary — a 2-wide desk seated at either tile sits 6px off-centre, which is exactly the "chair is
    // stuck on the left" report. Only the RENDER + the final foot snap use cx; the walk target stays tx.
    return a ? { tx: a.tx, ty: a.ty, face: a.face, cx: seatCx(prop, a.tx) } : null;
  }
  // centre a 1-wide seat under a prop, but never drift further than one tile from the walkable anchor
  // (a desk whose middle is walled off keeps its chair at the tile the body can actually reach).
  function seatCx(prop, tx) {
    const c = prop.x + ((prop.w || 1) / 2) - 0.5;
    return Math.abs(c - tx) <= 0.5 ? c : tx;
  }
  // where a seated body's foot lands: the seat's centred x, its tile's y. A function declaration (not a
  // const) because callers above this line run before it in source order.
  function seatFoot(s) { return { x: ((s.cx == null ? s.tx : s.cx) + 0.5) * T, y: s.ty * T + T - 1 }; }

  /* ---------- capability-prop resolution (G0.1: which prop does a firing tool light?) ----------
     geo.props are in the bake's LOCAL frame; station.roomAt speaks WORLD tiles — geo.origin bridges them. */
  const roomOfLocalTile = (lx, ly) => (station && geo && geo.origin) ? station.roomAt(lx + geo.origin.tx, ly + geo.origin.ty) : null;
  // the acting agent's ROOM: its BAY's room first (the capability seam — the room whose props granted the
  // tool), else the room its body stands in (hero/summoned workers have no bay).
  function actingRoomId(aid) {
    if (!station || !geo) return null;
    if (aid && typeof station.agentRoomId === 'function') { const r = station.agentRoomId(aid); if (r) return r; }
    const b = bodyForAgent(aid) || agent;
    if (!b) return null;
    const t = tileOf(b.px, b.py);
    return roomOfLocalTile(t.x, t.y);
  }
  // the placed prop a capability pulse should land on: the agent's OWN assigned prop of that type first,
  // then any matching prop in the acting agent's room, then any matching prop on the floor (null = none
  // placed -> nothing pulses; a tool the floor didn't grant a body never invents one).
  function capPropFor(cap, aid) {
    if (!geo || !geo.props || !cap) return null;
    const match = p => (station && station.capForProp && station.capForProp(p.t) === cap) || p.t === cap;   // t===cap covers catalog types named for the capability itself (e.g. jukebox)
    const cands = geo.props.filter(match);
    if (!cands.length) return null;
    if (aid) { const own = cands.find(p => p.agentId === aid); if (own) return own; }
    const room = actingRoomId(aid);
    // TRUTH: the pulse must land in the ACTING agent's OWN room — a matching prop in some OTHER room did not grant
    // this tool, so lighting it is a lie (the audit's wrong-room surge). If we can resolve the acting room, require
    // the prop be in it; no in-room match → no pulse. cands[0] is only a legitimate fallback when NO room can be
    // resolved at all (a roomless single-agent floor, where the sole floor prop unambiguously granted the tool).
    if (room) { return cands.find(p => roomOfLocalTile(p.x, p.y) === room) || null; }
    return cands[0];
  }

  /* free this agent's claimed seat (idempotent) and drop the on-couch render offset */
  function releaseSeat() {
    if (!self) return;
    if (self.seatKey) occupiedSeats.delete(self.seatKey);
    self.seatKey = null; self.seated = false; self.pendSeat = null; self.barJoinUntil = 0; self.seatLift = 0;
    self.lying = false;   // out of the seat is out of the BED: the covers pose dies with the claim
  }
  /* on arrival, snap the render position onto the claimed stool/chair/couch/bed anchor (logical pos stays
     put). The ELSE branch is load-bearing: it stops a body that left a stool for another destination from
     drawing itself back at the stool. A BODY ALREADY IN BED is the one exemption — pendSeat is consumed on
     the first arrival, so a second arrive() for the same goal (the engine can re-run it; the dev harness
     does) would otherwise stand a sleeper up out of a mattress it still holds the claim to. */
  function takeSeat() {
    if (self.seatKey && self.pendSeat) { self.seated = true; self.seatPx = self.pendSeat.px; self.seatPy = self.pendSeat.py; self.seatLift = self.pendSeat.lift || 0; self.pendSeat = null; }
    else if (!(self.lying && self.seatKey)) { self.seated = false; self.seatLift = 0; }
  }
  /* B2: drop ANY body's idle/leisure latch (couch cushion claim + the engine goal bookkeeping) when a task SEIZES
     it — the crew analogue of the hero summon-seize's releaseSeat()+goal-clear (tick ~1614). Without this, a crew
     body summoned mid-lounge keeps a stale goal='use'/'lounge' and leaks its occupiedSeats cushion claim forever
     (a permanently-blocked seat). Operates on an explicit body (NOT `self`) so setActivityFor/handoff can call it
     without disturbing the actor pointer. Idempotent. */
  function seizeFromIdle(b) {
    if (!b) return;
    if (b.seatKey) occupiedSeats.delete(b.seatKey);
    b.seatKey = null; b.seated = false; b.pendSeat = null; b.barJoinUntil = 0; b.seatLift = 0; b.lying = false;   // seized out of bed too
    b.goal = null; b.usingProp = null; b.watchProp = null; b.studyKey = null; b.quirkKind = null; b.stilling = false;
    b.useBeat = null; setTalking(b, false);   // a seized body is not mid-leisure and is not talking to anyone
    b.pauseUntil = 0; b.pauseLook = null; b.idleUntil = 0;
    if (chaseId === b.agentId) chaseId = null; b.chase = null; b.mimic = null;   // TIER D · D4: a summon seizes the body → drop any live chase/mimic + free the station chaser lock (G2)
  }

  /* ---------- SEAT LAW (2026-08-04; couch exception restored 2026-08-08) ----------
     A body may be drawn in the SIT pose in exactly two places: its own workstation chair (goal 'work',
     drawSeatChair puts a real chair under it) and a single-tile seat prop — STOOL / CHAIR — which planSeat
     renders the body ON TOP OF. Nothing else. The sit sprite is a chair pose; the old catalog let it fire
     on a beanbag and (worst) a BED, where the body read as parked bolt-upright on the mattress instead of
     lying in it. Those remain walk-to-and-STAND-at destinations. A claimed couch cushion is the narrow
     exception requested by the Commander: planCouchSit supplies a real render anchor and the sofa art
     occludes the legs, restoring the established sit-and-watch-TV behavior without reopening bed sitting. */

  /* v7 couch dwell: a couch is a blocking prop (you can't path onto it), so the agent walks to a tile
     ADJACENT to a free cushion and then renders on it. Cushions are the inner footprint columns (an arm is
     skipped at each end on a wide couch). Each cushion is reserved in occupiedSeats so a second agent
     takes a different one (or, when the couch is full, planProp moves on to another couch) — the claim
     is what keeps two bodies from crowding the same stretch of sofa.
     tvId != null → goal 'lounge' (watch + light the TV); else a plain couch dwell. */
  const LOUNGE_MAXT = 7;
  const SEAT_NB = [[0, 1], [0, -1], [1, 0], [-1, 0]];   // approach a cushion from any walkable neighbour
  /* How many px above the tile's floor line a body PERCHES on each single-tile seat — measured off the
     prop art, not guessed: the stool's pad underside sits at art-row y+4 (foot ring y+8..y+10), the
     chair's front lip at y+7. Lifting the sit sprite this much leaves the stem + base visible UNDER the
     body, which is the entire "on a stool" read. Couches stay 0 (the sofa back occludes instead). */
  /* Tuned DOWN from {stool:6, chair:3} after the all-skin parade: every set's sit master is authored
     feet-planted (squat-like, sit≈stand height), so a lift that lands the FEET on the pad crown reads
     as standing on the stool (Andrew, skeleton). At 4/2 the butt still reaches the pad while the
     drawSeatFront sliver swallows the planted feet/ankles — the legs read as dropping behind the seat. */
  const SEAT_LIFT = { stool: 4, chair: 2 };
  /* ---------- SIDE SEATS (2026-08-17) ----------
     The RECLINER pair is the first seat in the catalog drawn in PROFILE, and the couch's sit render —
     the whole prop sorted IN FRONT of the sitter, so a tall sofa back occludes the legs — hid it
     completely. A sofa is 5 tiles of low back behind a body; a recliner is 19px of chair over a 20px
     seated body, so all that reached the screen was the crown of the head above the backrest (Andrew:
     "the agents do not even sit in it ... they sit behind it").
     A profile seat inverts the sandwich instead: back + cushion UNDER the body, the near arm OVER its
     shins (PropSprites.drawSeatFront), which is what a person in a side-on armchair actually looks
     like. Two things follow from the art (propsprites F.recliner — cushion x+1..x+7, back x+8..x+13,
     near arm rows y+3..y+11) and nothing here is guessed:
       face — a chair points ONE way. The planner's guessed facing ('north' for a lone couch, or at
              whatever TV it paired with) would sit the body sideways in its own seat.
       dx   — px off tile centre toward the cushion, so the body's back rests against the crown
              instead of straddling it.
       lift — the SAME perch mechanism SEAT_LIFT gives a stool, and it is not optional here. A couch
              shows only a head, so nobody could see that a `lift` of 0 makes drawBody anchor a seated
              body by its STANDING foot pad; a profile seat shows the whole body, and every set whose
              sit master carries extra empty rows below the tucked legs (pikachu, xenomorph) then
              floated up onto the backrest. A non-zero lift is what switches drawBody to getTrackPad —
              the sit frame's OWN bottom padding — so all 36 skins land on the cushion. 2px, the
              chair's value, because the cushion sits barely above the near arm's crown. */
  const SIDE_SEAT = { recliner: { face: 'west', dx: -2, lift: 2 }, recliner_r: { face: 'east', dx: 2, lift: 2 } };
  const sideSeat = p => (p && SIDE_SEAT[p.t]) || null;
  function planCouchSit(now, couch, tvId, faceDir, zone) {
    /* STALE-CLAIM RULE: drop whatever seat this body still holds BEFORE claiming a new one. Committing to a
       new destination means it is leaving the old seat regardless, and an inherited `pendSeat` is worse than
       a leaked key — takeSeat() would consume the PREVIOUS seat's cushion on THIS goal's arrival and draw the
       body on furniture it never walked to. Only the two real-seat planners set a pendSeat, so a stale one is
       rare enough to be invisible until it isn't. Safe to release before the plan can fail: every caller is the idle
       decision, which only runs when the body is free to move. */
    releaseSeat();
    const w = couch.w || 1, h = couch.h || 1;
    const lo = w >= 3 ? 1 : 0, hi = w >= 3 ? w - 2 : w - 1;   // skip an arm tile each end when wide
    const slots = [];
    for (let i = lo; i <= hi; i++) if (!occupiedSeats.has(couch.id + ':' + i)) slots.push(i);
    if (!slots.length) return false;                          // couch full → caller tries another couch
    const order = U.irnd(0, slots.length - 1);                // vary which cushion is taken
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[(order + k) % slots.length];
      const sx = couch.x + slot, sy = couch.y;                // the couch tile the agent will sit on
      if (!tileInZone(zone, sx, sy)) continue;                // P1: the cushion the body RENDERS on must be in-zone (a wide couch can straddle a wall)
      for (const [dx, dy] of SEAT_NB) {
        const ax = sx + dx, ay = sy + dy;
        if (!tileInZone(zone, ax, ay)) continue;              // P1: the approach tile the body WALKS to must be in-zone too
        if (!geo.walkable(ax, ay, blocked)) continue;
        if (!setPathTo({ x: ax, y: ay })) continue;
        occupiedSeats.add(couch.id + ':' + slot); self.seatKey = couch.id + ':' + slot;
        const side = sideSeat(couch);
        self.pendSeat = { px: (sx + 0.5) * T + (side ? side.dx : 0), py: (couch.y + h) * T - 2, lift: side ? side.lift : 0 };   // render foot at the cushion front
        self.goal = tvId ? 'lounge' : 'use'; self.usingProp = couch.id; self.watchProp = tvId || null;
        self.useSit = true; self.useFace = side ? side.face : (faceDir || 'south');   // a profile chair points ONE way — see SIDE_SEAT
        if (!self.target) arrive(now);                       // already adjacent → settle immediately
        return true;
      }
    }
    return false;
  }

  /* SINGLE-TILE REAL SIT (SEAT LAW): a STOOL / CHAIR. Like a couch it BLOCKS, so
     the body walks to an adjacent tile and then renders on the seat's own tile (pendSeat), which is what
     makes the sit pose honest: there is a seat under the body. One occupant per seat (occupiedSeats),
     released by the same releaseSeat()/seizeFromIdle() paths as every other claim. */
  function planSeat(now, p, zone) {
    releaseSeat();                                            // STALE-CLAIM RULE (see planCouchSit)
    const key = p.id + ':0';
    if (occupiedSeats.has(key)) return false;                 // taken — planProp tries the next candidate
    if (!tileInZone(zone, p.x, p.y)) return false;            // P1: the seat the body RENDERS on must be in-zone
    for (const [dx, dy] of SEAT_NB) {
      const ax = p.x + dx, ay = p.y + dy;
      if (!tileInZone(zone, ax, ay)) continue;                // P1: and so must the tile it WALKS to
      if (!geo.walkable(ax, ay, blocked)) continue;
      if (!setPathTo({ x: ax, y: ay })) continue;
      occupiedSeats.add(key); self.seatKey = key;
      // foot on the seat tile's floor line: sort key + shadow anchor stay here. The body's PIXELS are
      // raised by `lift` (SEAT_LIFT, drawBody subtracts it) so the hips land on the seat PAD instead of
      // the floor line — without it the sprite planted its butt where the stool's casters are and fully
      // occluded the seat, which read as "standing where a stool used to be", not sitting on one.
      self.pendSeat = { px: (p.x + 0.5) * T, py: (p.y + 1) * T - 1, lift: SEAT_LIFT[p.t] || 0 };
      self.goal = 'use'; self.usingProp = p.id; self.watchProp = null;
      // A STOOL PULLED UP TO SOMETHING FACES IT (2026-08-08, Andrew: "agents should sit on stools
      // facing the opposite direction, so they can sit at the bar"). A stool has no front of its
      // own, so 'south' was a fine default for a stool standing alone — but a stool set against a
      // BAR is furniture for the bar, and a body sitting with its back to the counter it is sitting
      // at reads as a bug. If a counter-ish prop is adjacent, face THAT, even when that means
      // turning its back to the camera.
      // A SEAT THE USER AIMED WINS over the inferred counter: turning a chair to face west is an
      // explicit instruction about which way whoever sits in it looks, and the sit sprite has a frame
      // for every compass direction. An unturned seat (no `r`) resolves exactly as before.
      self.useSit = true;
      self.useFace = (p.r && PropAnchor.frontOf) ? PropAnchor.frontOf(p) : (counterFace(p) || 'south');
      if (!self.target) arrive(now);                          // already adjacent → sit immediately
      return true;
    }
    return false;
  }

  /* The direction from a seat toward the COUNTER it is pulled up to, or null if it stands alone.
     "Counter" = the props you sit AT rather than on: a bar, a long table, a pool/poker table, the
     DJ booth. Derived live from adjacency (nothing in the catalog pairs a stool with a bar), and
     deliberately allows 'north' — sitting at a bar means showing the camera your back. */
  const COUNTER_KINDS = { bar: 1, pool: 1, poker: 1, dj: 1 };
  function isCounterProp(p) {
    if (!p) return false;
    const u = propUse(p);
    return !!((u && COUNTER_KINDS[u.kind]) || p.t === 'longtable');
  }
  function counterForSeat(seat) {
    if (!geo || !geo.props || !seat) return null;
    const sx = seat.x + 0.5, sy = seat.y + 0.5;
    let best = null;
    for (const p of geo.props) {
      if (p === seat || p.id === seat.id) continue;
      if (!isCounterProp(p)) continue;   // longtable has no `use` row but is exactly this
      const w = p.w || 1, h = p.h || 1;
      // nearest point of the prop's footprint to the seat — a 4-wide bar is close along its whole run
      const nx = Math.max(p.x, Math.min(sx, p.x + w)), ny = Math.max(p.y, Math.min(sy, p.y + h));
      const d = Math.abs(nx - sx) + Math.abs(ny - sy);
      if (d > 1.8) continue;                                  // pulled UP to it, not merely in the same room
      if (!best || d < best.d) best = { p, d, nx, ny };
    }
    return best;
  }
  function counterFace(seat) {
    const best = counterForSeat(seat);
    return best ? dirToward((seat.x + 0.5) * T, (seat.y + 0.5) * T, best.nx * T, best.ny * T) : null;
  }

  /* couch + a TV nearby → dwell at the couch and watch it. The pairing is derived live (gen has no
     authored couch/TV pairs): for each couch, the nearest TV within range, faced from the couch. */
  function tryLounge(now) {
    if (funBlocked('lounge', now)) return false;
    const zone = zoneFor(self);   // P1: only lounge on a couch INSIDE the body's zone (the body sits there)
    const pair = loungePair(zone);   // the couch/TV resolution now lives in ONE place (planPlay weighs the same pairing)
    if (!pair) return false;
    if (pair.couch && !tileInZone(zone, pair.couch.x, pair.couch.y)) return false;
    if (!planCouchSit(now, pair.couch, pair.tvId, pair.face, zone)) return false;
    rememberFun('lounge', now);
    return true;
  }

  /* ---------- ENTERTAINMENT: what a BORED agent does (2026-08-08) ----------
     THE DEFECT Andrew reported after living with the floor: "I don't see it interacting with the
     couch and TV I placed." He was right, and it is a gating bug, not a missing feature. planProp
     — the ONLY route to a couch, an arcade, a pinball table, the bar — hung off the REST drive
     (`top === wRest`), i.e. an agent only ever went near the entertainment when it was TIRED. A
     BORED agent (the stim drive, which is what idle downtime actually accumulates) went on a
     caretaker lap, studied a machine, or paced. So a station kitted out as a games room was
     furniture the agent walked past.

     planPlay is the missing pull: when there is something FUN in reach, being bored is a reason to
     go and play with it. It is deliberately a thin wrapper over the existing planProp/tryLounge
     machinery (no new movement, no new goals, no new state) — the only new thing is that leisure is
     now reachable from the drive that actually fires. FUN_KINDS is what "entertainment" means: the
     things a person crosses a room for. Decorative/passive `use` rows remain available to explicit
     systems, but the ambient idle picker does not turn them into staring destinations. */
  const FUN_KINDS = { arcade: 1, pinball: 1, pool: 1, poker: 1, juke: 1, dj: 1, bar: 1, gacha: 1 };
  /* Relative pull. The couch+TV lounge is the single most comfortable thing in the room and it also
     holds the longest dwell, so left equal-weighted it swallows the floor: the first build of this
     just called planProp, whose tryLounge short-circuit meant the measured result was BOTH bodies on
     the couch for 58% of the run and not one visit to the arcade, the pinball table or the bar. It
     is a candidate here, not a shortcut. */
  const FUN_W = { arcade: 3, pinball: 3, pool: 2.5, poker: 2, dj: 2, juke: 1.5, bar: 2.5, gacha: 1.5, lounge: 2.5 };
  const FUN_REPEAT_MIN = 90000, FUN_REPEAT_MAX = 150000;
  /* FUN-REPEAT-PURE-BEGIN — reports whether a choice is still recent. The picker skips a recent
     SOLE option, but only down-weights it when alternatives exist so avoidance never becomes a
     predictable forced rotation. Kept pure for the regression test. */
  function funRecentlyUsed(lastKey, lastUntil, key, now) {
    return !!key && lastKey === key && Number.isFinite(lastUntil) && now < lastUntil;
  }
  /* FUN-REPEAT-PURE-END */
  function funBlocked(key, now) { return funRecentlyUsed(self.lastFun, self.lastFunUntil, key, now); }
  function rememberFun(key, now) {
    self.lastFun = key;
    self.lastFunUntil = now + U.irnd(FUN_REPEAT_MIN, FUN_REPEAT_MAX);
  }
  // Deliberate idle destinations stay intentionally small. Decorative blockers (speaker, plant, shelf)
  // are scenery; a body crosses the room for a game, a real counter, or couch/TV—not to stare at decor.
  function purposefulIdleProp(p) {
    const u = propUse(p); if (!u) return false;
    if (u.kind === 'couch' || FUN_KINDS[u.kind]) return true;
    if (u.kind !== 'seat') return false;
    const counter = counterForSeat(p), kind = counter && counter.p && (propUse(counter.p) || {}).kind;
    return kind === 'bar' || kind === 'pool' || kind === 'poker';
  }
  // the couch/TV pairing (the v7 lounge), resolved as DATA so planPlay can weigh it against the rest
  function loungePair(zone) {
    if (!geo || !geo.props) return null;
    const couches = [], tvs = [];
    for (const p of geo.props) {
      const u = propUse(p); if (!u) continue;
      if (u.kind === 'couch') couches.push(p);
      else if (u.kind === 'tv') tvs.push({ p, cx: p.x + (p.w || 1) / 2, cy: p.y + (p.h || 1) / 2 });
    }
    if (!couches.length || !tvs.length) return null;
    const order = U.irnd(0, couches.length - 1);
    for (let k = 0; k < couches.length; k++) {
      const couch = couches[(order + k) % couches.length];
      const cx = couch.x + (couch.w || 1) / 2, cy = couch.y + (couch.h || 1) / 2;
      let best = null;
      for (const tv of tvs) { const d = Math.hypot(tv.cx - cx, tv.cy - cy); if (d <= LOUNGE_MAXT && (!best || d < best.d)) best = { tv, d }; }
      if (!best) continue;
      if (zone && !tileInZone(zone, couch.x, couch.y)) continue;
      /* A PROFILE SEAT CANNOT SWIVEL. Every other couch is drawn face-on, so its sitter can be turned
         toward whichever TV the pairing found; a recliner points the ONE way its art points (SIDE_SEAT),
         so pairing it with a TV behind it would light that TV and claim a body was watching it while the
         body sat with its back to the screen. Truthful-telemetry, applied to furniture: it is only a
         lounge seat when the screen is actually on the side it faces. */
      const side = sideSeat(couch);
      if (side && dirToward(cx, cy, best.tv.cx, best.tv.cy) !== side.face) continue;
      return { couch, tvId: best.tv.p.id, face: dirToward(cx, cy, best.tv.cx, best.tv.cy) };
    }
    return null;
  }
  // a FREE stool/chair pulled up to this counter (bar / pool / table), or null — so "go to the bar"
  // means SITTING at it, which is what a bar is for (and what counterFace turns the body toward)
  function stoolAt(counter, zone) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      const u = propUse(p); if (!u || u.kind !== 'seat') continue;
      if (occupiedSeats.has(p.id + ':0')) continue;
      if (zone && !tileInZone(zone, p.x, p.y)) continue;
      const w = counter.w || 1, h = counter.h || 1;
      const nx = Math.max(counter.x, Math.min(p.x + 0.5, counter.x + w));
      const ny = Math.max(counter.y, Math.min(p.y + 0.5, counter.y + h));
      if (Math.abs(nx - (p.x + 0.5)) + Math.abs(ny - (p.y + 0.5)) <= 1.8) return p;
    }
    return null;
  }
  /* A quiet social reuse, not a second encounter engine: when exactly one other body is already seated at
     a bar in this body's current room, occasionally take another free stool at THAT bar. The long per-body
     cooldown is armed on every eligible look, whether the roll lands or not, and the counter is capped at
     two committed sitters. planSeat owns all pathing, claims, containment and task pre-emption. */
  function maybeJoinBar(now) {
    if (!self || now < (self.barJoinCd || 0) || !geo || !geo.props) return false;
    const here = tileOf(self.px, self.py), room = roomOfLocalTile(here.x, here.y);
    if (!room) return false;
    const zone = zoneFor(self), bodies = allBodies();
    const bars = [];
    for (const other of bodies) {
      if (!other || other === self || other.unplaced || other.goal !== 'use' || !other.sitting || !other.seated) continue;
      const ot = tileOf(other.px, other.py);
      if (roomOfLocalTile(ot.x, ot.y) !== room) continue;
      const seat = geo.props.find(p => p.id === other.usingProp), counter = counterForSeat(seat);
      if (!counter || !counter.p || (propUse(counter.p) || {}).kind !== 'bar') continue;
      const committed = bodies.filter(b => {
        if (!b || b === self || b.unplaced || b.goal !== 'use') return false;
        const bs = geo.props.find(p => p.id === b.usingProp), bc = counterForSeat(bs);
        return !!(bc && bc.p && bc.p.id === counter.p.id);
      });
      if (committed.length !== 1) continue;                    // one host + one joiner, never a crowd
      const stool = stoolAt(counter.p, zone);
      if (stool) bars.push({ other, stool });
    }
    if (!bars.length) return false;
    self.barJoinCd = now + U.irnd(60000, 120000);              // one eligible roll every 1–2 minutes
    if (!U.chance(0.35)) return false;                         // only sometimes, never every bar visit
    const pick = U.pick(bars);
    if (!planSeat(now, pick.stool, zone)) return false;
    const togetherUntil = now + U.irnd(45000, 75000);
    self.barJoinUntil = togetherUntil;
    pick.other.useUntil = Math.max(pick.other.useUntil || 0, togetherUntil);
    return true;
  }
  /* TIRED. The couch is the right answer and stays the first one — but "tired" is the drive that
     refills WHILE you rest, so a body whose rest need re-tops the moment it stands up will re-pick
     the same couch forever: measured, a crew body spent 252 of 457 samples on one couch across 8
     consecutive visits and touched nothing else in the room. So: the couch, unless it just got off
     that couch, in which case anything else fun will do. */
  function planRest(now) {
    if (tryLounge(now)) return true;
    if (planPlay(now)) return true;
    return planProp(now);
  }
  /* OCCUPANCY for standing-use props (2026-08-10). Seats have real claims (occupiedSeats), so two
     bodies never share a stool or a cushion — but an arcade/pinball/gacha is used STANDING, carried
     nothing, and both idle pickers happily sent a second body to a machine someone was already at:
     the two ended up shoulder-to-shoulder on the same approach tile, playing the same cabinet
     (Andrew's live repro). `usingProp` is stamped at PLAN time — the moment a body commits to the
     walk — so checking other bodies' usingProp covers both "using it now" and "already on the way".
     Read-only over the tiny body list; a multi-tile prop (pool, a wide bar) is deliberately NOT
     exempted — one machine, one player, which is also how the real thing works. */
  function propInUse(propId) {
    if (!propId) return false;
    for (const b of allBodies()) {
      if (!b || b === self || b.unplaced) continue;
      if (b.usingProp === propId) return true;
    }
    return false;
  }
  function planPlay(now) {
    if (!geo || !geo.props || !geo.props.length) return false;
    const zone = zoneFor(self), cands = [];
    const lounge = loungePair(zone);
    if (lounge) { const recent = funBlocked('lounge', now); cands.push({ key: 'lounge', w: FUN_W.lounge * (recent ? 0.28 : 1), recent, lounge }); }
    for (const p of geo.props) {
      const u = propUse(p);
      if (!u || !FUN_KINDS[u.kind]) continue;
      if (!mayTouchProp(self.id, p)) continue;
      if (!tileInZone(zone, p.x, p.y)) continue;
      if (propInUse(p.id)) continue;                       // someone is at (or walking to) this machine — pick something else
      const recent = funBlocked(p.id, now);
      cands.push({ key: p.id, w: (FUN_W[u.kind] || 2) * (recent ? 0.28 : 1), recent, prop: p, kind: u.kind });
    }
    if (!cands.length) return false;                       // nothing fun placed → the bored branch carries on as before
    if (cands.length === 1 && cands[0].recent) return false;   // one prop cannot become permanent parking
    let total = 0; for (const c of cands) total += c.w;
    // draw one, then fall through the rest in a rotated order so an unreachable pick never wastes the beat
    let roll = U.rnd(0, total), start = 0;
    for (let i = 0; i < cands.length; i++) { roll -= cands[i].w; if (roll <= 0) { start = i; break; } }
    for (let k = 0; k < cands.length; k++) {
      const c = cands[(start + k) % cands.length];
      if (c.lounge) {
        if (planCouchSit(now, c.lounge.couch, c.lounge.tvId, c.lounge.face, zone)) { rememberFun('lounge', now); return true; }
        continue;
      }
      // a counter you SIT at: take a stool pulled up to it if one is free (counterFace turns the
      // body to the bar), else stand at the counter itself
      if (c.kind === 'bar' || c.kind === 'pool' || c.kind === 'poker') {
        const stool = stoolAt(c.prop, zone);
        if (stool && planSeat(now, stool, zone)) { rememberFun(c.key, now); return true; }
        if (c.kind === 'bar') continue;                         // a bar without a free stool is not a standing-and-staring destination
      }
      const a = PropAnchor.deriveAnchor(c.prop, geo, { approach: useApproach(propUse(c.prop), c.prop), extra: blocked });
      if (!a || !tileInZone(zone, a.tx, a.ty) || !setPathTo({ x: a.tx, y: a.ty })) continue;
      self.goal = 'use'; self.usingProp = c.prop.id; self.useFace = a.face; self.useSit = false; rememberFun(c.key, now);
      if (!self.target) arrive(now);
      return true;
    }
    return false;
  }

  // idle leisure: pick a reachable interactive prop (couch/tv/arcade/jukebox/bar), walk to
  // its approach tile, and commit to goal='use'. Returns false if none is reachable (→ wander).
  function planProp(now) {
    if (!geo || !geo.props || !geo.props.length) return false;
    if (tryLounge(now)) return true;   // couch + TV nearby → sit ON the couch and watch (the v7 lounge)
    const zone = zoneFor(self);   // P1: only use leisure props the body can reach WITHOUT leaving its zone
    const cands = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use || !purposefulIdleProp(p)) continue;
      if (use.kind === 'couch') { if (!funBlocked('lounge', now)) cands.push({ couch: p }); continue; }   // cushion/approach are caged per-slot in planCouchSit (a wide couch can straddle a wall)
      if (use.kind === 'seat') { const counter = counterForSeat(p); if (counter && counter.p && !funBlocked(counter.p.id, now)) cands.push({ seat: p }); continue; }   // only a non-recent purposeful counter seat reaches this branch
      if (use.kind === 'bar') continue;                                  // its adjacent purposeful seat is the destination, never the counter face itself
      if (funBlocked(p.id, now)) continue;
      if (propInUse(p.id)) continue;                                     // occupied (or being walked to) — see propInUse
      const a = PropAnchor.deriveAnchor(p, geo, { approach: useApproach(use, p), sit: !!use.sit, extra: blocked });
      if (a && tileInZone(zone, a.tx, a.ty)) cands.push({ id: p.id, a });   // the APPROACH tile (where the body stands) must be in-zone
    }
    if (!cands.length) return false;
    const start = U.irnd(0, cands.length - 1);   // random offset, but try each prop at most once
    for (let k = 0; k < cands.length; k++) {
      const c = cands[(start + k) % cands.length];
      if (c.couch) { if (planCouchSit(now, c.couch, null, 'north', zone)) { rememberFun('lounge', now); return true; } continue; }   // lone couch → stand at it facing UP (back to the viewer)
      if (c.seat) { if (planSeat(now, c.seat, zone)) return true; continue; }                        // stool/chair → the one honest sit
      if (setPathTo({ x: c.a.tx, y: c.a.ty })) {
        self.goal = 'use'; self.usingProp = c.id; self.useFace = c.a.face; self.useSit = c.a.sit;
        if (!self.target) arrive(now);   // already standing on the approach tile
        return true;
      }
    }
    return false;
  }

  /* ---------- awareness: notice new placements ---------- */
  // diff this frame's props/belts against what the agent has already taken in; queue the additions
  function scanNovelty() {
    const props = (geo && geo.props) || [], belts = (geo && geo.belts) || [];
    const propIds = new Set(props.map(p => p.id));
    const beltKeys = new Set(belts.map(b => b.x + ',' + b.y));
    const foot = new Map();
    for (const p of props) foot.set(p.id, { x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 });
    if (seenProps === null) { seenProps = propIds; seenBelts = beltKeys; propFoot = foot; return; }   // first look: learn the scene, react to nothing
    const zone = zoneFor(agent);   // P1: only queue novelties INSIDE the hero's zone (it won't walk out to inspect)
    for (const p of props) {
      if (seenProps.has(p.id)) continue;
      if (!mayTouchProp(agent && agent.id, p)) continue;   // another agent's (or unclaimed) workstation isn't "novel" to this one — don't walk over
      if (!purposefulIdleProp(p) && !(isWorkstationProp(p.t) && p.agentId === (agent && agent.id))) continue;   // decor is noticed visually, never treated as a destination
      const tx = Math.floor(p.x + (p.w || 1) / 2), ty = Math.floor(p.y + (p.h || 1) / 2);
      if (!tileInZone(zone, tx, ty)) continue;             // out-of-zone placement — noticed, but not walked to
      pushNovelty(tx, ty, 'prop', p.id);
    }
    for (const b of belts) {                       // a long run lands as one tile-flag, not a spam of them
      if (seenBelts.has(b.x + ',' + b.y)) continue;
      if (!tileInZone(zone, b.x, b.y)) continue;            // a new belt outside the zone isn't an inspect target
      pushNovelty(b.x, b.y, 'belt', null); break;
    }
    // REMOVALS -> grief: a prop the Commander deletes, if it stood on a spot this agent loved, is mourned
    for (const id of seenProps) {
      if (propIds.has(id)) continue;               // still there
      if (ownPlaced.has(id)) continue;             // its OWN decor it tidied away — never mourn that
      const f = propFoot.get(id); if (f) maybeMourn(f);
    }
    seenProps = propIds; seenBelts = beltKeys; propFoot = foot;
  }
  /* a prop at footprint f was just removed. Sum the agent's affection for the tiles around where it stood;
     if it loved that spot, queue a quiet grief beat. Rate-limited so tearing down a whole room = one mourn. */
  function maybeMourn(f) {
    if (!agent || !agent.fond || activity === 'task' || agent.unplaced) return;
    if (fnow < (mournCd || 0)) return;
    let sum = 0, bestKey = null, bv = 0;
    for (const [k, v] of agent.fond) {
      const [x, y] = k.split(',').map(Number);
      // radius-2 halo: a BLOCKING prop (couch/machine) pushes the agent's dwell tile up to 2 tiles off its footprint,
      // so affection for "that spot" lands a tile or two away — verified live (a couch sit logs at couch.y+2)
      if (x >= f.x - 2 && x <= f.x + f.w + 1 && y >= f.y - 2 && y <= f.y + f.h + 1) { sum += v; if (v > bv) { bv = v; bestKey = k; } }
    }
    if (sum < 6 || !bestKey) return;               // it never really cared about this corner — let it go unremarked
    if (pendingMourn && pendingMourn.fond >= sum) return;   // keep only the deepest grief if several land at once
    pendingMourn = { tx: Math.floor(f.x + f.w / 2), ty: Math.floor(f.y + f.h / 2), spotKey: bestKey, fond: sum };
    mournCd = fnow + 45000;
    if (activity === 'idle') { if (agent.goal === 'sleep') { seizeFromIdle(agent); agent.goal = null; agent.usingProp = null; agent.sitting = false; } agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 300); }   // grief stirs it from dormancy — seizeFromIdle drops the BED claim a bed sleeper now holds
  }
  function pushNovelty(tx, ty, kind, pid) {
    novelty = novelty.filter(n => !(n.tx === tx && n.ty === ty));   // dedupe the same tile
    novelty.push({ tx, ty, kind, pid });
    if (novelty.length > NOVELTY_MAX) novelty.shift();
    if (agent && activity === 'idle') {
      if (agent.goal === 'sleep') { seizeFromIdle(agent); agent.goal = null; agent.usingProp = null; agent.sitting = false; agent.glanceCd = 0; agent.studyUntil = 0; }   // a placement stirs it from dormancy — seizeFromIdle drops the BED claim a bed sleeper now holds
      agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 350);   // react within ~1s (then it walks over to inspect)
      // STARTLE: something materialized right beside it → a sharp snap toward it + a beat, distinct from the calm far-off notice
      if (!agent.working && !agent.unplaced) {
        const d = Math.hypot((tx + 0.5) * T - agent.px, (ty + 0.5) * T - agent.py);
        if (d < 3.4 * T) { const dir = dirToward(agent.px, agent.py, (tx + 0.5) * T, (ty + 0.5) * T); setGlance(dir, 240, fnow); agent.dir = dir; agent.glanceCd = fnow + 600; curiositySay(Q_STARTLE, 0.5, fnow); }
      }
    }
  }

  /* pixel position of the nearest riding belt box, or null (for gaze-tracking cargo) */
  function nearestBox() {
    if (!convey || !convey.peekBoxes) return null;
    const boxes = convey.peekBoxes(); if (!boxes || !boxes.length) return null;
    const DV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    let best = null, bd = Infinity;
    for (const b of boxes) {
      if (b.sink > 0) continue;
      const v = DV[b.dir] || [0, 0];
      const bx = (b.x + 0.5 + (b.prog - 0.5) * v[0]) * T, by = (b.y + 0.5 + (b.prog - 0.5) * v[1]) * T;
      const d = Math.hypot(bx - self.px, by - self.py);
      if (d < bd) { bd = d; best = { x: bx, y: by, d }; }
    }
    return best;
  }

  function setGlance(dir, ms, now) { if (self) self.glance = { dir, until: now + ms }; }
  /* ⛔ THERE IS NO ON-DEMAND EMOTE, ON PURPOSE (2026-08-08).
     A first cut of this pass added one: fire the sprite sets' one-shot `gesture` track when
     something happened — reaching for a prop on arrival, a loop at the arcade/pinball so the body
     "worked" the machine, a greeting and parting wave, a hand raised at someone walking past. It
     shipped and it was wrong, because that track is an ARMS-UP STRETCH and nothing else: what you
     actually saw was an agent walk up to the arcade cabinet and stretch at it (Andrew: "makes 0
     sense"). AN ANIMATION REUSED FOR SOMETHING IT DOES NOT DEPICT READS AS A BUG, NOT AS LIFE —
     four call sites, one piece of art, four wrong readings. Playing a machine and waving each need
     their OWN frames; until those exist the honest beat is stance, facing and dwell, which is what
     this engine now does. The ambient once-per-~90-minutes stretch in assets.js is untouched: there
     the art is fired as exactly what it is. */

  /* ================= Tier C (cross-agent awareness) — C0 plumbing =================
     INVIOLABLE RULE: perceive across zones, ACT (move) only within your own. These two helpers are the
     GAZE-ONLY foundation — they READ neighbor positions and turn a head; they NEVER introduce a path,
     target, goal, or any movement (K1). Wired to NO trigger in C0 — this phase changes zero behavior. */

  // Every body = the hero `agent` + the crew[] array. Bounded O(N) (hero + a handful of crew).
  const allBodies = () => (agent ? [agent].concat(crew) : crew.slice());

  // neighborsOf — READ-ONLY. Returns the OTHER bodies within `radius` tiles of `body`, inside the
  // observer's own zone (containment) AND with a real WALL-AWARE SIGHTLINE to it (losClear — see the
  // block above tileInZone: zone membership alone put two bodies in different rooms "in sight" of each
  // other through the wall between them). Reads px/py/tile only, mutates NOTHING.
  // Skips: itself, unplaced bodies. N is tiny, so an O(N) scan gated to the idle cadence is cheap (K4).
  function neighborsOf(body, radius) {
    const out = [];
    if (!body || body.unplaced) return out;
    const rPx = radius * T;                       // compare in pixels (px/py are the canonical coords)
    const zone = zoneFor(body);                   // containment half: the observer's own roam area (read-only)
    for (const other of allBodies()) {
      if (other === body || !other || other.unplaced) continue;
      if (Math.hypot(other.px - body.px, other.py - body.py) > rPx) continue;   // proximity (deterministic)
      const ot = tileOf(other.px, other.py);      // logical tile (seated bodies still carry px/py here)
      if (!tileInZone(zone, ot.x, ot.y)) continue;   // containment: neighbor stands within the observer's zone
      if (!bodiesInSight(body, other)) continue;     // sightline: and there is no WALL between the two of them
      out.push(other);
    }
    return out;
  }

  // glanceAt — turn `self` to FACE otherBody for `dur` ms. Calls ONLY setGlance (head-turn, auto-reverts at
  // render via assets.js). It mutates ONLY self's own glance state — never a path/target/goal/position (K1),
  // never another body (K2). MUST run with `self` pointing at the GLANCING body (Tier B self discipline).
  function glanceAt(self_, otherBody, dur, now) {
    if (!self_ || !otherBody) return;
    const dir = dirToward(self_.px, self_.py, otherBody.px, otherBody.py);
    if (self_ === self) { setGlance(dir, dur, now); return; }   // current actor: reuse setGlance (writes self.glance)
    self_.glance = { dir, until: now + dur };                   // non-current body: direct glance write (no self repoint)
  }

  // bodyIsIdle — READ-ONLY: is `b` free to notice (not tasked, not walking, no active goal)? The hero's busy
  // flag is the module-scope `activity` (HERO-ONLY); crew busyness is per-body (b.working/b.workUntil). Every
  // PLACED crew body now runs the inner life (stepCrew no longer gates the engine on b.summoned — desk-stuck
  // fix), so a free bay-bound body is a first-class idle body here too. Reads only — mutates nothing.
  function bodyIsIdle(b, now) {
    if (!b || b.unplaced || b.state === 'walk' || b.working || b.goal != null) return false;
    if (agent && b === agent) return activity === 'idle';                 // hero: the single module-scope busy flag
    return b.workUntil <= now;                                            // crew (summoned OR bay-bound): alive unless mid-run
  }

  /* ================= Tier C — C-Beat1: SUMMON GLANCE =================
     When a body is summoned to a task, each OTHER body that is currently IDLE and within sight has a 50% chance
     to turn its head toward the summoned body for a brief beat, then resume. GAZE-ONLY (glanceAt → setGlance/direct
     .glance write — no path/target/goal/movement, K1). Fires off the summon EVENT only (never off another body's
     glance, K4 no cascade). A short per-observer refractory makes it fire ONCE per event, not every frame. The
     glance is ADDITIVE and NEVER delays the summon — this runs AFTER the work-seize (K3 summon-wins). The summoned
     body itself does NOT glance (it's tasked, excluded as the scan target). Determinism: U.chance(0.5) + U.irnd (K5).
     CRITICAL self-discipline (K2): this runs OUTSIDE the per-body engine loop (from setActivityFor/handoff/bus where
     `self` points at the hero or a stale body), so it writes each observer's glance via glanceAt's DIRECT path —
     it enumerates bodies explicitly and never re-points the module `self`. */
  const SUMMON_GAZE_RADIUS = 7;   // tiles — same zone + within sight; neighborsOf already caps to the observer's zone
  function summonGlance(summonedBody, now) {
    if (!summonedBody) return;
    for (const obs of neighborsOf(summonedBody, SUMMON_GAZE_RADIUS)) {
      if (obs === summonedBody) continue;            // the tasked body goes to work, never glances (defensive; neighborsOf already excludes self)
      if (!bodyIsIdle(obs, now)) continue;           // only free bodies notice (a busy/walking body keeps its task — K3)
      if (now < (obs.summonGlanceCd || 0)) continue; // per-observer refractory: once per summon event, not every frame
      obs.summonGlanceCd = now + U.irnd(1600, 2800); // arm refractory whether or not the roll lands (no re-roll storm)
      if (!U.chance(0.5)) continue;                  // 50% — half notice, half stay absorbed
      glanceAt(obs, summonedBody, U.irnd(650, 1050), now);   // brief head-turn toward the summoned, auto-reverts at render
    }
  }

  /* ================= Tier C — C-Beat2: MUTUAL IDLE GLANCE =================
     When `self` (the deciding idle body) has a neighbor that is ALSO idle within sight, occasionally — rarity-gated
     behind a long PER-BODY cooldown (self.neighborGlanceCd) — both bodies turn their heads toward each other for a
     held beat, then the normal glance timeout ENDS it. A quiet, silent "they noticed each other." GAZE-ONLY: glanceAt
     calls setGlance / writes .glance only — no path/target/goal/movement (K1). Each body mutates ONLY its OWN glance
     state — self via setGlance, the neighbor via glanceAt's DIRECT .glance write — never any other field (K2).
     K4 no deadlock: the mutual glance self-terminates by `until` at render (assets.js); nothing re-arms it until the
     cooldown elapses, so two facing idle bodies can't lock into a sustained stare. K4 no cascade: this fires off
     both-idle PROXIMITY + the cooldown ONLY — it reads neighbor px/py/idle-state, NEVER neighbor.glance, so A glancing
     can't make B glance. Called from decideIdle (idle-cadence gated, NOT every frame) with self set to the deciding
     body, so hero (self===agent) and crew (self===b) behave uniformly. Returns true iff a mutual glance was struck.
     Determinism: U.chance / U.irnd / U.pick only (K5). */
  const MUTUAL_GAZE_RADIUS = 4;   // tiles — a near neighbor; neighborsOf already caps to the deciding body's zone
  function maybeMutualGlance(now) {
    if (!self || self.stilling) return false;          // never interrupt a deliberate stilling hold (eerie calm wins — K8)
    if (now < (self.neighborGlanceCd || 0)) return false;   // long per-body cooldown so it's occasional, not busy (K8/K4)
    const cands = [];
    for (const other of neighborsOf(self, MUTUAL_GAZE_RADIUS)) {
      if (!bodyIsIdle(other, now)) continue;           // only a free neighbor can lock eyes back (read-only idle test)
      if (other.stilling) continue;                    // respect the neighbor's deliberate hold too (don't yank it out)
      cands.push(other);
    }
    if (!cands.length) { self.neighborGlanceCd = now + U.irnd(8000, 16000); return false; }   // arm a short re-scan gap even on a miss (no per-frame rescans)
    self.neighborGlanceCd = now + U.irnd(14000, 26000);   // arm the cooldown whether or not the roll lands (no re-roll storm)
    if (!U.chance(0.18)) return false;                 // rare — a quiet noticing, not a constant swivel (K8 eerie restraint)
    const other = U.pick(cands);
    const dur = U.irnd(900, 1500);                      // a HELD beat (longer than an ambient flick) — they regard each other, then break
    glanceAt(self, other, dur, now);                   // self looks at the neighbor (self===self -> setGlance)
    glanceAt(other, self, dur, now);                   // the neighbor looks back — glanceAt's DIRECT .glance write (K2: only its glance)
    // Protect the partner's held look-back the same way decideIdle protects the INITIATOR (idleUntil at the call site):
    // bodyIsIdle ignores idleUntil, so `other` may be at/past its idle hold and re-decide via decideIdle before `dur`
    // elapses — standStill (62%)/lookAround/wander would then stomp other.glance, degrading C-Beat2 to one-sided. Hold
    // its idle past the glance so the mutual beat survives, then ends cleanly by the glance timeout (K4: still self-
    // terminating, no movement — idleUntil/glance/cooldown only, never a path/target/goal — K1/K2 intact).
    other.idleUntil = Math.max(other.idleUntil || 0, now + dur + U.irnd(200, 600));
    other.neighborGlanceCd = now + U.irnd(14000, 26000);   // arm the partner's cooldown too so it doesn't immediately re-initiate
    // Protect the INITIATOR's held glance symmetrically: bodyIsIdle ignores idleUntil, so if self's idle hold expired
    // mid-glance the crew/hero engine would re-enter decideIdle and standStill(62%)/lookAround/wander could stomp self's
    // own still-live glance (degrading C-Beat2 to one-sided on the initiator side). Hold self's idle past dur the same
    // way the partner is held — gaze/timer-only, no path/target/goal (K1/K2 intact, K4 still self-terminating).
    self.idleUntil = Math.max(self.idleUntil || 0, now + dur + U.irnd(200, 600));
    return true;
  }

  /* W4 — THE PASSING ACKNOWLEDGEMENT. The D3 encounter is a whole staged beat: a station-wide slot,
     a rendezvous walk, a hold. It is rare on purpose and always will be. But two agents brushing
     past each other and NOT reacting is its own kind of dead — the cheapest, most human signal on
     the floor is the one that costs nothing: someone walks past where you are standing, you look
     up and raise a hand.

     So this deliberately takes NO slot, arms NO station budget, and moves NOBODY: the stander
     glances + waves (its own gesture track), the passer glances back, and both carry on. It is the
     Tier C gaze pattern (glanceAt's sanctioned two-sided write) plus one emote — no path, target or
     goal is ever touched (K1), and it can never delay or preempt a real encounter or a summon.
     Gated: the WAVER must be standing free (a walking body cannot render the standing gesture art
     anyway) and the other must actually be going past, so it reads as "noticing someone pass",
     never as two idle bodies saluting each other in place. */
  function maybeAcknowledge(now) {
    const me = self;
    if (!me || me.unplaced || reduceMotion()) return false;
    if (now < (me.ackCd || 0)) return false;
    if (now < (me.ackScanAt || 0)) return false;      // cheap re-scan gap: this runs every tick, the scan does not
    me.ackScanAt = now + 350;
    if (me.working || me.sitting || me.state === 'walk' || me.social || me.goal === 'social') return false;
    if (me === agent && activity !== 'idle') return false;                 // hero on task — not now
    if (chatHot(now) && me === chatFocusBody()) return false;              // the Commander owns this body's attention
    const rPx = ACK_RADIUS * T;
    for (const other of allBodies()) {
      if (!other || other === me || other.unplaced) continue;
      if (other.state !== 'walk') continue;                                // it must be PASSING — this is not a standing salute
      if (other.working || other.social) continue;
      if (Math.hypot(other.px - me.px, other.py - me.py) > rPx) continue;
      if (!bodiesInSight(me, other)) continue;                             // ...and it must be passing IN VIEW — this beat has its own scan, so the wall-aware sightline (see losClear) has to be applied here too, or a body waves at someone in the next room
      me.ackCd = now + U.irnd(ACK_CD_MIN, ACK_CD_MAX);
      other.ackCd = Math.max(other.ackCd || 0, now + U.irnd(ACK_CD_MIN, ACK_CD_MAX));   // don't let the pair volley
      if (!U.chance(0.5)) return false;                                    // half the time it just doesn't look up
      const dur = U.irnd(700, 1200);
      glanceAt(me, other, dur, now);                                       // me === self → setGlance
      glanceAt(other, me, dur, now);                                       // the passer looks back (direct glance write, K2)
      me.idleUntil = Math.max(me.idleUntil || 0, now + dur + U.irnd(200, 500));   // hold the beat, exactly as the mutual glance does
      return true;
    }
    return false;
  }

  /* ================= TIER D · D3 — SOCIAL ENCOUNTERS (Tier C grows legs) =================
     Bounded movement beats between idle bodies. The four kinds, in SELECTION order (the first that
     assembles a legal plan wins the single slot, so this order is a priority — see maybeSocial/W5b):
       'huddle'  — TWO OR THREE same-zone bodies converge on adjacent tiles, face one another, take
                   turns talking, hold, break. The conversation. (W5: the third body is optional and
                   is only recruited when a legal third tile exists — see planHuddle.)
       'border'  — two ADJACENT-zone bodies each walk to the nearest tile of their shared edge (each INSIDE its
                   own zone), face each other across the line, talk, hold, break.
       'watch'   — SILENT. An idle body stands ~2 tiles behind a WORKING body in its own zone, faces the desk, holds.
       'follow'  — SILENT. An idle body notices a walking body passing nearby, half-follows 2-4 tiles (zone-clamped),
                   then loses interest and STOPS. It NEVER completes the follow — the incompleteness is the design.
     The two SILENT kinds are deliberately last and draw a SHORTER lane cooldown than the talking
     ones: they are what happens when there is nobody available to actually talk to (W5a).
     INVARIANTS (each is a named review hunt): containment (every target zone-clamped, G3/K1); work seizes
     instantly (any participant summoned → abandons; the survivor releases within the hard timeout, G2/K3);
     one live encounter (the `socialBeat` slot + hard `until`, G4); no deadlock/cascade (idle-cadence selection off
     neighborsOf, per-pair cooldowns, a beat never spawns another, K4); station rarity (consult crewBeatDamp + arm
     via armBeat, G5); Tier B self-discipline (startEncounter is the ONE cross-body write; stepSocial mutates only
     self, K2); chat-stare exclusion (a chatFocus body never joins). */
  const SOCIAL_SEL_ROLL = 0.25;             // per idle re-decide, when a candidate pair exists + the social LANE is open (the lane cooldown — not this roll — sets the rate; this only sets how fast an OPEN lane gets consumed)
  /* W4 (2026-08-08): the lane was 5-8 MINUTES station-wide, one encounter at a time — which is why
     nobody had ever actually watched two agents meet: on a floor you look at for a few minutes, the
     expected number of encounters was under one. The beat is also no longer a silent stand-off (it
     now carries a greeting, a turn-taking exchange and a parting wave), so it is worth seeing.

     W5 (2026-08-14, Andrew: "it seems to very very rarely happen"). W4 halved the wait and it was
     still rare, because the LANE NUMBER was never the whole story — four independent governors
     multiply, and three of them were invisible in the tuning:

       (a) the lane is shared with the beats that DON'T talk. A 'watch' or a 'follow' fires
           armSocialBudget too, so a body idly tailing a walker burned the entire 90-150s
           conversation budget on a beat with no conversation in it. Split: a talking beat draws the
           CONVERSATION lane, a quiet one draws a much shorter QUIET lane (see armSocialBudget).
       (b) the kinds were TRIED in the order watch → huddle → follow → border, so whenever a
           neighbour happened to be working, the non-talking 'watch' won the race and (a) then shut
           the lane. The talking kinds are now tried FIRST (see maybeSocial).
       (c) SOCIAL_NEAR_RADIUS 5 is small against a real station: two agents at their own desks are
           usually further apart than five tiles, so the candidate set was empty on most re-decides
           and the roll was never even reached. 8 still means "in the same part of the room".
       (d) the hold was 3-7s. Even when it all lined up, the conversation was over before you looked
           at it. 9-20s is long enough to notice, watch, and record.

     What is NOT relaxed: the single live slot (G4), containment (G3), work-seizes-instantly (G2/K3),
     the shared calm budget (armBeat/G5) and the hard timeout. Still one thing at a time. */
  const SOCIAL_STATION_CD_MIN = 30000, SOCIAL_STATION_CD_MAX = 60000;    // CONVERSATION lane (huddle/border) — the rate governor for the beat Andrew actually wants to see
  const SOCIAL_QUIET_CD_MIN = 12000, SOCIAL_QUIET_CD_MAX = 25000;        // QUIET lane (watch/follow) — a beat with no conversation in it must not spend the conversation budget (W5a)
  const SOCIAL_HOLD_MIN = 9000, SOCIAL_HOLD_MAX = 20000;  // the face-each-other hold — long enough to READ as a conversation and be watched (W5d)
  const SOCIAL_HARD_MS = 55000;             // whole-encounter hard timeout — the slot ALWAYS frees by this (G4). Must exceed walk + SOCIAL_HOLD_MAX or the cap, not the hold, would end every talk.
  const SOCIAL_PAIR_CD_MIN = 75000, SOCIAL_PAIR_CD_MAX = 165000;   // per-pair cooldown so a duo never loops (K4) — still longer than the lane, so a 3-crew floor rotates partners rather than replaying one pair
  const SOCIAL_NEAR_RADIUS = 8;             // tiles — huddle/watch candidate proximity (within the observer's zone via neighborsOf). 5 was smaller than the distance between two desks (W5c).
  const SOCIAL_FOLLOW_MIN = 2, SOCIAL_FOLLOW_MAX = 4;   // half-follow distance (tiles) — bounded, never completes
  /* ---------- W5: A THIRD BODY CAN JOIN (2026-08-14) ----------
     "maybe even 3 of them just start communicating." A huddle was hard-wired to exactly two bodies
     (the slot carried aId/bId and nothing else). The slot now carries `ids` — the full participant
     list, aId/bId retained as its first two entries so every existing reader keeps working — and a
     huddle recruits a third eligible neighbour when one is standing there. Turn-taking generalises
     to N speakers by round-robin (myTurnN), so three bodies rotate the floor exactly the way two
     alternate: at most ONE mouth moving at any instant, which is the property that makes it read as
     a conversation rather than a crowd. A trio is deliberately the ceiling — four sprites cannot
     ring one tile without one of them talking to a back. */
  const SOCIAL_TRIO_CHANCE = 0.45;          // when a huddle has a third eligible body in reach, how often it becomes a trio
  const SOCIAL_MAX_PARTY = 3;               // hard ceiling on one encounter's participants
  /* Read-only selection counters. A trio needs FOUR things to line up (a huddle is planned at all, a
     second candidate survives both pair cooldowns, the roll passes, a third tile resolves) and when
     no trio appears in a live soak the interesting question is WHICH one failed — a rate this rare
     cannot be diagnosed by watching. Counters only; nothing here steers a decision. */
  const huddleStats = { planned: 0, candCounts: {}, noThirdCandidate: 0, trioRolled: 0, trioTileFail: 0, trioFired: 0 };
  /* ---------- W4: THEY TALK, AND THEY WAVE (2026-08-08) ----------
     A meeting between two agents used to be two sprites standing a tile apart, silent, motionless,
     for three to seven seconds. Read cold it is indistinguishable from two stuck pathfinds. Both
     halves of the fix are art the sets ALREADY ship and the engine already knew how to draw:

       TALKING — `b.speaking` swaps to the set's `talk` track (5 of 38 sets) or, on every other set,
       to a livelier bob + a 1px head bounce. That is enough to read as "these two are talking"
       without a single line of dialogue — which is the right register anyway: this station's beats
       are silent by design (curiositySay has been a no-op since the Thronglet pass), and the COMMS
       transcript is where words belong. TURN-TAKING is what sells it: the two must not flap in
       unison, so each derives its turn from the encounter's OWN start clock (socialBeat.startedAt,
       stamped once by the coordinator) and its own side of the pair (a === first speaker). Reading
       a shared READ-ONLY origin, not writing shared turn state, is what keeps K2 intact.

     (A greeting/parting WAVE was built here too and then removed — the only gesture art in the
     project is an arms-up stretch, and a stretch is not a wave. See the emote() note above.)

     Only the two-sided kinds (huddle/border) talk: a 'watch' subject is working and a 'follow'
     never completes, so neither is a conversation. */
  const TALK_SLOT_MS = 1700;                // one speaking turn + the beat of silence after it
  const TALK_SPEAK_MS = 1150;               // how much of a turn is actually mouth-moving
  const ACK_RADIUS = 2.4;                   // tiles — a passing acknowledgement is arm's length, not across the room
  const ACK_CD_MIN = 45000, ACK_CD_MAX = 90000;   // per-body: a wave is a greeting, not a tic

  /* armSocialBudget — the two station-level side-effects EVERY fired encounter must do, at ALL fire sites
     (startEncounter for huddle/border, and the one-sided planWatch/planFollow which set the slot inline):
     (1) armBeat — count it against the SHARED station calm budget so quirks stay quiet in its shadow (total
     station beat rate is preserved — G5), and (2) draw the dedicated social LANE cooldown so the encounter
     RATE is governed here, decoupled from the quirk-gate race. Kept as one helper so a new social beat can
     never forget one half (a lane-arm-without-armBeat would grow the total rate; the reverse would let
     social loop).

     W5a — WHICH lane depends on whether the beat is a CONVERSATION. The two are not interchangeable:
     'watch' (stand behind a working peer) and 'follow' (tail a walker and lose interest) are silent
     by construction — talkTurn refuses them — yet they used to draw the same 90-150s cooldown as a
     talk. On any floor where somebody is working, the silent kinds fire first and often, so the
     conversation Andrew wants to see was being rate-limited by beats that contain no conversation.
     They now draw the short QUIET lane; only a real exchange spends the conversation budget. */
  function isTalkKind(kind) { return kind === 'huddle' || kind === 'border'; }
  function armSocialBudget(now, kind) {
    armBeat(now);
    socialGateUntil = now + (isTalkKind(kind)
      ? U.irnd(SOCIAL_STATION_CD_MIN, SOCIAL_STATION_CD_MAX)
      : U.irnd(SOCIAL_QUIET_CD_MIN, SOCIAL_QUIET_CD_MAX));
  }

  /* ---- COMPANIONS (2026-08-16): agents drift toward the agents they actually work with ----

     Andrew's ask: "users will notice some agents around specific other agents frequently."
     The pull is real or it is nothing — every bond here is DERIVED by the sidecar from the durable
     run log (GET /api/agents/affinity: a shared run tree, or runs reached for in the same stretch
     of work) and never assigned here. So when the station reads as "those two are always together",
     that is a true statement about how the Commander works, not decoration. An agent pair the log
     can't vouch for has strength 0 and gets exactly the old uniform treatment.

     THE BIAS MUST NOT BECOME A LOCK. Two things keep the station from collapsing into fixed duos:
       (a) weight is 1 + BOND_PULL*strength, so a stranger's weight is never zero — every pair stays
           possible, best buds are just likelier. Variety is the feature; favouritism is the accent.
       (b) the per-pair cooldown still applies (shortened, floored), so even a top bond cannot loop.
     Both matter: without (a) the floor turns into disjoint cliques, and without (b) one pair would
     eat the station's whole conversation budget and the other agents would look dead. */
  let affinityPairs = new Map();            // "idA|idB" (sorted) -> strength 0..1. Empty until the poll answers.
  const BOND_PULL = 4;                      // a proven companion is ~4x likelier to be chosen than a stranger (weight 1 -> ~4.1 at the strongest bond seen on a real log)
  const BOND_CD_RELIEF = 0.55;              // best buds serve at most 55% off the per-pair cooldown, so they come back to each other sooner
  const BOND_CD_FLOOR = 45000;              // ...but never so soon that a duo could re-fire as the immediate next beat
  const BOND_TRIO_BONUS = 0.35;             // a third body bonded to BOTH others turns a pair into the friend GROUP more often ("sometimes groups of 3")

  /* the proven bond between two agents, 0 when the run log can't back one. 0 is "no bond" — it must
     never be read as a weak bond, which is why every consumer adds it to a baseline of 1. */
  function bondOf(aId, bId) {
    if (aId == null || bId == null) return 0;
    return affinityPairs.get(pairKey(aId, bId)) || 0;
  }

  /* BOND-WEIGHT-PURE-BEGIN — sliced out of THIS source and executed by test/agent-affinity-weight.test.js,
     so the shipped selection maths is under test rather than a copy of it. Keep it pure: no module state,
     no RNG, no DOM, no U.* — the bond lookup is INJECTED for exactly that reason.

     bondMean — mean bond from a candidate to EVERY anchor. One anchor = "who does this body gravitate
       to"; two anchors = "who belongs with this pair", which is what makes a trio read as a friend GROUP
       rather than a pair plus a bystander: a body bonded to only one of the two scores half as hard as
       one bonded to both.
     bondWeights — the selection weights. THE LOAD-BEARING PROPERTY IS THE `1 +`: a stranger's weight is
       1, never 0, so no pairing is ever impossible and the floor cannot fracture into fixed cliques.
       Bonds are an accent on a uniform draw, not a replacement for it. A future "optimisation" that
       drops the baseline to make favourites stronger would turn the station into disjoint duos — that
       is the regression this block is extracted to prevent. */
  function bondMean(anchorIds, id, bondLookup) {
    const ids = Array.isArray(anchorIds) ? anchorIds : [anchorIds];
    if (!ids.length) return 0;
    let sum = 0;
    for (const anchor of ids) sum += (bondLookup(anchor, id) || 0);
    return sum / ids.length;
  }
  function bondWeights(anchorIds, ids, bondLookup, pull) {
    return ids.map(id => 1 + pull * bondMean(anchorIds, id, bondLookup));
  }
  /* BOND-WEIGHT-PURE-END */

  /* weighted choice over `list` from the anchors' point of view. Falls back to U.pick's exact uniform
     behaviour whenever there is nothing to bias with (no graph yet), so an unreachable or empty
     affinity endpoint changes nothing at all about how the station behaves. */
  function pickByBond(anchorIds, list) {
    if (!Array.isArray(list) || list.length < 2) return list && list.length ? list[0] : null;
    if (!affinityPairs.size) return U.pick(list);
    const w = bondWeights(anchorIds, list.map(o => o && o.id), bondOf, BOND_PULL);
    let total = 0; for (const x of w) total += x;
    if (!(total > 0)) return U.pick(list);
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }

  /* GET /api/agents/affinity — refreshed slowly (the graph moves over days). Fail-quiet by design:
     any error keeps the last known graph rather than dropping to uniform mid-session, and a first
     failure just leaves the map empty, which IS the old behaviour. */
  function pollAffinity() {
    if (typeof fetch === 'undefined') return;
    try {
      fetch(apiUrl('/api/agents/affinity'), { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d || !Array.isArray(d.pairs)) return;   // nothing answered — keep the last known graph
          const next = new Map();
          for (const p of d.pairs) {
            if (!p || p.a == null || p.b == null) continue;
            const s = Number(p.strength);
            if (Number.isFinite(s) && s > 0) next.set(pairKey(p.a, p.b), Math.min(1, s));
          }
          affinityPairs = next;
        })
        .catch(() => {});
    } catch (_) {}
  }

  // stable sorted-pair key for the per-pair cooldown map
  function pairKey(aId, bId) { return (String(aId) < String(bId)) ? (aId + '|' + bId) : (bId + '|' + aId); }
  function pairOnCd(aId, bId, now) { return now < (socialPairCd.get(pairKey(aId, bId)) || 0); }
  /* COMPANIONS: a bonded pair serves a SHORTER cooldown, so it comes back around to itself sooner.
     This half is not optional garnish — the base cooldown (75-165s) is deliberately longer than the
     conversation lane (30-60s) precisely so a duo can't repeat, which is a rotation force pulling
     exactly against the bond. Without this relief the weighted pick would keep choosing best buds
     and the cooldown would keep vetoing them. Floored so even the strongest bond can never re-fire
     as the immediate next beat — friendship, never a loop. */
  function armPairCd(aId, bId, now) {
    const base = U.irnd(SOCIAL_PAIR_CD_MIN, SOCIAL_PAIR_CD_MAX);
    const relief = 1 - BOND_CD_RELIEF * bondOf(aId, bId);
    socialPairCd.set(pairKey(aId, bId), now + Math.max(BOND_CD_FLOOR, Math.round(base * relief)));
  }

  // is body `b` a valid social participant right now? idle, placed, not chat-focused, not already in a beat.
  // Reuses bodyIsIdle (the Tier C read-only idle test) — so it excludes tasked/walking/mid-goal/mid-run bodies.
  function socialEligible(b, now) {
    if (!b || b.unplaced || b.social) return false;              // already in an encounter, or nobody
    if (b.gather || gathering) return false;                     // TIER E: the assembly owns the whole floor while it lasts — no ordinary huddle may start inside one, or pull a body out of the formation
    if (b.stilling) return false;                                // don't yank a deliberate stillness hold (eerie calm wins)
    if (chatHot(now) && b === chatFocusBody()) return false;     // chat-stare exclusion (D1): never recruit the HOT-focused body (cold focus = the body is living its life — fully eligible)
    return bodyIsIdle(b, now);                                   // idle, not tasked/walking/mid-goal (hero: activity idle; crew: summoned+free)
  }

  /* participantIds — the encounter's full roster. W5 added `ids` (2 for a pair, 3 for a trio); the
     `|| [aId, bId]` fallback is not defensive noise, it is the compatibility hinge: aId/bId remain
     the first two entries at every fire site, so a slot written by any older path still reads back
     as a complete roster here. Every teardown walks THIS list, never [a, b] — the whole point of a
     trio is that the third body must be released by the same code that releases the other two. */
  function participantIds(s) { return (s && s.ids && s.ids.length) ? s.ids : (s ? [s.aId, s.bId] : []); }
  function participantBodies(s) { return participantIds(s).map(bodyForAgent).filter(Boolean); }

  // free the whole encounter + clear EVERY participant's plan. Idempotent. Called on: hard timeout, partner-gone,
  // a participant seized by work, or a clean natural end. NEVER leaves the slot occupied (G4).
  function endEncounter(now, armCd) {
    const s = socialBeat; socialBeat = null;
    if (!s) return;
    for (const body of participantBodies(s)) {
      // W6 SAFETY, same shape as the pose below: the speech bubble dies WITH the encounter. A line
      // left hanging over a body that is no longer in a conversation is the same lie as a mouth
      // left moving at nobody — and unlike the pose it would keep asserting it for a full second.
      if (body) body.chatter = null;
      // W4 SAFETY: the conversation pose is dropped for EVERY participant on ANY end, even one whose
      // plan was already torn down elsewhere (a seize clears .social first) — a body left mouth-moving
      // at nobody is exactly the kind of state this project calls a lie.
      if (body && !body.social) setTalking(body, false);
      if (!body || !body.social) continue;
      // W4: drop the conversation pose as the encounter ends. (The parting WAVE was removed with
      // the rest of the gesture-track misuse — see the emote() header: that art is a stretch.)
      setTalking(body, false);
      body.social = null;
      if (body.goal === 'social') { body.goal = null; body.state = 'idle'; body.pathPts = null; body.target = null; body.idleUntil = Math.max(body.idleUntil || 0, now + U.irnd(300, 900)); }
    }
    // arm the per-pair cooldown on any end (so a loop can't restart it). W5: a trio arms all THREE
    // pairs — otherwise the two bodies who happened not to be aId/bId would be free to re-huddle
    // instantly and the encounter would replay with the same faces.
    if (armCd !== false) {
      const ids = participantIds(s).filter(id => id != null);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) armPairCd(ids[i], ids[j], now);
    }
  }

  // has the encounter been pulled apart (a participant seized by work / despawned / chat-focused)? ⇒ tear down so
  // the survivor releases (K3). READ-ONLY on the bodies. TWO-SIDED beats (huddle/border) give BOTH bodies a plan —
  // either losing its plan or being seized breaks it. ONE-SIDED beats (watch/follow) give only the OBSERVER (aId) a
  // plan; the passive subject (bId) just needs to still EXIST — a WATCH subject working / a FOLLOW subject walking is
  // the whole point, not a break. Chat-focus on either body breaks it (the Commander now owns that body's attention).
  function encounterBroken(now) {
    const s = socialBeat; if (!s) return true;
    const ids = participantIds(s);
    const bodies = ids.map(bodyForAgent);
    if (bodies.some(x => !x || x.unplaced)) return true;                   // a participant despawned
    const a = bodies[0];
    const oneSided = (s.kind === 'watch' || s.kind === 'follow');
    // the OBSERVER (aId, always ids[0]) always carries the plan — its loss/seizure always breaks the beat.
    if (a.social == null) return true;                                     // observer's plan cleared out from under us
    if (a.working) return true;                                            // observer's crew run seized it
    if (a === agent && activity === 'task') return true;                   // observer (hero) got summoned
    if (chatHot(now)) { const f = chatFocusBody(); if (f && bodies.indexOf(f) >= 0) return true; }   // ANY participant pulled into a LIVE (hot) chat-stare — a cold focus doesn't seize, so it doesn't break the beat
    if (!oneSided) {
      // TWO-SIDED: every OTHER participant must also still be holding its own plan and not seized.
      // W5: this loop is what makes a trio safe — a third body that gets summoned tears the whole
      // encounter down on the very next tick rather than leaving two bodies talking at a gap where
      // somebody used to be. Work seizing instantly (G2/K3) outranks the conversation, always.
      for (let i = 1; i < bodies.length; i++) {
        const o = bodies[i];
        if (o.social == null) return true;
        if (o.working) return true;
        if (o === agent && activity === 'task') return true;
      }
    }
    return false;
  }

  /* startEncounter — THE ONE coordinator (K2). Assigns each body its OWN plan on `body.social` at initiation
     (this is the sanctioned cross-body write, done once, explicitly, here). Each plan is fully self-contained so
     per-tick stepSocial(self) mutates only self. Every walk target is zone-clamped to the MOVER's own zone (G3).
     Returns true iff an encounter was armed (⇒ caller should not fall through to a normal idle beat).

     W5: `extras` is an optional list of [{ body, plan }] for the third body of a trio. a and b stay
     the named pair so aId/bId keep their meaning for every existing reader (the source lock, the
     one-sided beats, the soak); the roster the teardown and the turn-taker walk is `ids`. Each body
     is given `partnerIds` — everyone ELSE in the encounter — so a body faces the group it is
     standing in rather than one arbitrarily-chosen member of it. */
  function startEncounter(a, b, kind, now, planA, planB, extras) {
    if (socialBeat) return false;                                         // G4: one live encounter station-wide
    const party = [{ body: a, plan: planA }, { body: b, plan: planB }].concat(extras || []).slice(0, SOCIAL_MAX_PARTY);
    const ids = party.map(p => p.body.id);
    for (const { body, plan } of party) {
      body.social = plan;
      plan.kind = kind;
      plan.partnerId = (body === a) ? b.id : a.id;                        // the one named partner (kept: the one-sided beats and older readers use it)
      plan.partnerIds = ids.filter(id => id !== body.id);                 // everyone else — what facePartner actually aims at
      body.goal = 'social';
      // drop any in-flight idle state so the social plan owns each body cleanly (does NOT touch working/task — those
      // paths are excluded by socialEligible, so every member of the party is genuinely idle here).
      body.stilling = false; body.usingProp = null; body.sitting = false; body.pauseUntil = 0; body.pauseLook = null; body.studyKey = null;
    }
    socialBeat = { kind, aId: a.id, bId: b.id, until: now + SOCIAL_HARD_MS, startedAt: now, ids: ids };   // startedAt: the ONE clock every turn-taker reads (see talkTurn)
    armSocialBudget(now, kind);                                           // G5 shared-gate arm + the CONVERSATION lane draw (total calm preserved; rate governed by the lane)
    return true;
  }

  /* stepSocial — per-tick stepper for the CURRENT body (self) while self.goal === 'social'. Mutates ONLY self
     (self.social, self position/facing via the existing walk/arrive machinery) and reads the partner READ-ONLY
     (position/tile only). Phases per plan:
       plan = { phase:'walk'|'hold', tx,ty, faceTile:{x,y}|'partner', until, followLeft }
     'walk': path toward (tx,ty) (already zone-clamped at plan time; re-derive path via setPathTo, reusing the
             existing pather). On arrival → face the target and enter 'hold'. For 'follow', decrement followLeft
             and re-target the next step toward the (still-moving) partner, zone-clamped; when followLeft hits 0 or
             the partner stops/leaves the zone, it just STOPS (never completes).
     'hold': stand still, face the partner (or the fixed faceTile), until `plan.until`; then the encounter ends.
     The whole-encounter hard timeout + the partner-broken check are enforced by the caller (stepSocialGuard) BEFORE
     this runs, so stepSocial only handles the happy path. Determinism: U.* only. */
  function stepSocial(now) {
    const pl = self.social; if (!pl) return;
    // face resolution
    /* W5: face the GROUP, not one nominated member of it. With two bodies the centroid of "everyone
       else" IS the partner, so a pair is unchanged; with three it is the point between the other two,
       which is what standing in a circle looks like. Falls back to the single partnerId so the
       one-sided beats (watch/follow), which never carry partnerIds, keep their exact behaviour. */
    const facePartner = () => {
      const others = (pl.partnerIds || [pl.partnerId]).map(bodyForAgent).filter(p => p && !p.unplaced);
      if (!others.length) return;
      let sx = 0, sy = 0;
      for (const p of others) { sx += p.px; sy += p.py; }
      self.dir = dirToward(self.px, self.py, sx / others.length, sy / others.length);
    };
    if (pl.phase === 'walk') {
      if (self.state === 'walk' || self.target) return;   // still walking — the walk machinery in tick/crewEngineStep drives it
      const cur = tileOf(self.px, self.py);
      if (pl.kind === 'follow') {
        // half-follow: take bounded steps toward the (moving) partner, zone-clamped; NEVER complete.
        const p = bodyForAgent(pl.partnerId);
        if (!p || (pl.followLeft || 0) <= 0) { enterHold(now, pl); return; }          // lost interest / budget spent / partner gone → stop + a brief stare, then end
        const zone = zoneFor(self);
        const pt = tileOf(p.px, p.py);
        const stepX = Math.sign(pt.x - cur.x), stepY = Math.sign(pt.y - cur.y);       // one tile toward the partner's CURRENT tile
        let stepped = false;
        for (const [dx, dy] of [[stepX, stepY], [stepX, 0], [0, stepY]]) {
          if (!dx && !dy) continue;
          const tx = cur.x + dx, ty = cur.y + dy;
          if (tileInZone(zone, tx, ty) && geo.walkable(tx, ty, blocked) && setPathTo({ x: tx, y: ty })) {
            pl.tx = tx; pl.ty = ty; pl.followLeft = (pl.followLeft || 0) - 1; self.goal = 'social'; stepped = true; break;
          }
        }
        if (!stepped) enterHold(now, pl);                                             // can't advance in-zone → stop where it is
        return;
      }
      // huddle / watch / border: a single fixed walk target. `started` distinguishes "not yet en route" (→ path to
      // it) from "arrived / path exhausted" (→ hold). Without it, a freshly-armed plan with no path would read as
      // "already arrived" on tick 1 and hold in place without ever walking.
      if (cur.x === pl.tx && cur.y === pl.ty) { enterHold(now, pl); return; }         // standing on it already → hold
      if (pl.started) { enterHold(now, pl); return; }                                 // was en route, now stopped (arrived or path ran out) → hold where it is
      if (setPathTo({ x: pl.tx, y: pl.ty })) { pl.started = true; self.goal = 'social'; }   // begin the walk (path set → walk block advances it next)
      else enterHold(now, pl);                                                        // unreachable → hold in place (never strand the slot)
      return;
    }
    if (pl.phase === 'hold') {
      self.state = 'idle'; self.sitting = false;
      if (pl.faceTile === 'partner') facePartner();
      else if (pl.faceTile) self.dir = dirToward(self.px, self.py, (pl.faceTile.x + 0.5) * T, (pl.faceTile.y + 0.5) * T);
      talkTurn(self, now, pl);                                                        // W4: take (or yield) this body's turn in the exchange
      // W5: measure from the LAST arrival (see enterHold) so a late third body is not cut out of the
      // conversation it just walked into. Falls back to this body's own arrival when the slot carries
      // no mark (a one-sided beat, or a slot torn down under us this tick).
      const holdFrom = (socialBeat && socialBeat.lastArrivalAt) || pl.holdAt || 0;
      if (now >= holdFrom + (pl.holdLen || 0)) endEncounter(now);                     // natural end → free the slot + arm the pair cooldowns
    }
  }
  /* W4/W5 — one body's turn in a talking encounter (2 or 3 participants). Every body reads the SAME
     encounter clock and its OWN seat in the roster, so they take turns without any of them writing to
     the others or to shared turn state (K2). A body only mouth-moves for the first TALK_SPEAK_MS of
     its own slot, so there is a real beat of silence between turns — the pause is what makes it read
     as listening rather than as sprites vibrating. */
  /* The turn phase MUST come from the ENCOUNTER's clock (socialBeat.startedAt), not from each
     body's own arrival. Each body stamps pl.holdAt when IT settles, and the two rarely arrive
     together — the first live soak caught them 2s apart, which put both of them in "slot 0" and
     printed a sample with BOTH bodies talking. `holdAt` still gates whether this body has arrived
     at all; the shared origin is what makes the two alternate. */
  function talkTurn(b, now, pl) {
    if (!b || !pl) return;
    if (!isTalkKind(pl.kind) || !socialBeat || !socialBeat.startedAt || !pl.holdAt) { setTalking(b, false); return; }
    /* W5: the body's SEAT in the roster replaces "am I the first speaker", and the roster length
       replaces the hard-coded 2. Both come from the slot, which is written once by the coordinator
       and only ever READ here — the property that keeps this K2-clean (no body writes another's
       turn state) survives the generalisation unchanged. An id missing from the roster (a torn-down
       encounter racing this tick) yields -1, which myTurnN answers with silence rather than a lie. */
    const ids = participantIds(socialBeat);
    setTalking(b, myTurnN(now - socialBeat.startedAt, ids.indexOf(b.id), ids.length, TALK_SLOT_MS, TALK_SPEAK_MS));
  }
  /* TALK-TURN-PURE-BEGIN — the turn-taking decision, extracted PURE (arguments only; no module
     state, no RNG, no clock, no DOM) so the alternation is unit-testable headlessly. WHY headless:
     an encounter is rare, tick-driven and needs two bodies to meet, so "do they take turns rather
     than flap in unison" is not something a live soak can assert at every millisecond — but it is
     the one property that decides whether this reads as a conversation.

     myTurnN — the N-speaker form (W5, so three bodies can hold one conversation):
       elapsed  ms since the ENCOUNTER started (every participant reads the SAME clock)
       idx / n  this body's seat in the roster, and how many seats there are. The seat is the ONLY
                thing that distinguishes one participant from another — no shared mutable turn
                state, so no body ever writes another's turn (K2). Out-of-roster ⇒ silent.
       slotMs   one turn + the silence after it · speakMs how much of the turn is mouth-moving
     Round-robin on the slot index means exactly one seat holds the floor at a time for ANY n, which
     is the property that scales: with three bodies the risk is not silence, it is a crowd all
     mouthing at once, and `% n` makes that unrepresentable rather than merely unlikely.

     myTurn is the n=2 case (idx 0 = the pair's FIRST speaker, socialBeat.aId) kept as a named
     function: it is the shape test/talk-turn.test.js sweeps, and a pair must stay byte-identical
     to the W4 behaviour that was tuned and shipped.

     The gap (slotMs - speakMs) is load-bearing: without it the speakers swap instantly and it reads
     as sprites vibrating rather than one listening while another speaks. */
  function myTurnN(elapsed, idx, n, slotMs, speakMs) {
    if (!(elapsed >= 0) || !(slotMs > 0) || !(n > 0)) return false;
    if (!(idx >= 0) || idx >= n) return false;              // not in the roster ⇒ silent (never guess a turn)
    const mine = (Math.floor(elapsed / slotMs) % n) === idx;
    return mine && (elapsed % slotMs) < speakMs;
  }
  function myTurn(elapsed, first, slotMs, speakMs) {
    return myTurnN(elapsed, first ? 0 : 1, 2, slotMs, speakMs);
  }
  /* TALK-TURN-PURE-END */

  /* ---------- W6: THE STATION HAS ITS OWN TONGUE (2026-08-16) ----------
     Two sprites mouthing at each other only read as "a conversation" if you already know the
     rule. Andrew asked for the missing half — a speech bubble over whoever holds the floor,
     carrying "language that can't be transcripted".

     THE UNREADABILITY IS THE HONEST PART, NOT A GAG. A social beat is ambient station LIFE, not
     a harness event: no message crossed the bus, no run happened, nothing was actually said. A
     bubble of English would therefore be the app asserting content it cannot prove — the exact
     class of lie this project bans everywhere else. A script that is not a language asserts
     only what IS true: these two are talking to each other, right now. WORDS live in COMMS.

     So the glyphs are not text and never can be: no font, no codepoint, no string anywhere on
     the path. A rune is a list of strokes on a 4x6 lattice, painted as pixel rects. It cannot
     be copied, pasted, translated or screen-read, because there is nothing there to copy. (Two
     more reasons it has to be geometry and not characters: VT323 ships no symbol glyphs, so any
     exotic codepoint silently falls back to a different font at a different advance — see the
     icon-vocabulary measurements — and drawn rects stay pixel-crisp at every zoom, which a
     scaled glyph font does not.)

     DIALECT: the rune subset a body draws from is seeded off its own id, so one agent's speech
     looks consistently unlike another's and a trio reads as three speakers rather than one
     noise source. */
  /* GLYPH-SPEECH-PURE-BEGIN — the tongue itself, extracted PURE (arguments only; no module
     state, no ambient RNG, no clock, no DOM) so the alphabet and the phrase builder are
     testable headlessly, the way the turn-taking above is. The invariants that matter:
       • a rune is GEOMETRY, never a character — nothing on this path can be transcribed
       • every stroke stays inside its own cell, so a glyph can never paint over its neighbour
       • strokes are horizontal / vertical / true 45° ONLY (any other slope is a fuzzy staircase
         at 1px, and this is pixel art)
       • one seed ⇒ one phrase, always — a line is rolled once per turn and must not shimmer */
  const RUNE_W = 3, RUNE_H = 5;              // lattice EXTENT: points 0..3 across, 0..5 down (a 4x6 cell)
  // An angular technical script: spines with marks, a few closed forms. Each rune is a list of
  // [x1,y1,x2,y2] strokes. Kept deliberately small — a 40-glyph alphabet reads as noise, ~18
  // repeats often enough that the eye starts to believe it could be read.
  const RUNES = [
    [[1, 0, 1, 5], [1, 0, 3, 0]],                              // spine, crowned
    [[1, 0, 1, 5], [1, 2, 3, 2]],                              // spine, waisted
    [[1, 0, 1, 5], [1, 1, 3, 1], [1, 3, 3, 3]],                // ladder
    [[1, 0, 1, 5], [1, 3, 3, 1]],                              // rising stroke
    [[1, 0, 1, 5], [1, 2, 3, 4]],                              // falling stroke
    [[1, 0, 1, 5], [1, 5, 3, 5], [3, 3, 3, 5]],                // footed hook
    [[1, 0, 1, 5], [0, 2, 3, 2]],                              // full cross
    [[0, 1, 3, 1], [0, 4, 3, 4], [0, 1, 0, 4], [3, 1, 3, 4]],  // closed cell
    [[0, 3, 1, 2], [1, 2, 2, 3], [0, 5, 3, 5]],                // chevron on a bar
    [[0, 0, 0, 5], [3, 0, 3, 5], [0, 2, 3, 2]],                // bridged pair
    [[1, 0, 1, 5], [0, 1, 1, 0], [1, 0, 2, 1]],                // arrowed spine
    [[0, 5, 3, 2], [1, 1, 3, 1]],                              // barred diagonal
    [[0, 0, 3, 0], [3, 0, 1, 2], [1, 2, 1, 5]],                // switchback
    [[2, 0, 2, 5], [0, 0, 2, 0], [0, 0, 0, 2]],                // left hook
    [[0, 1, 3, 1], [0, 3, 3, 3], [1, 1, 1, 5]],                // stacked bars
    [[0, 3, 2, 1], [2, 1, 3, 2], [3, 2, 1, 4], [1, 4, 0, 3]],  // lens
    [[1, 0, 1, 5], [2, 1, 3, 1], [2, 3, 3, 3], [2, 5, 3, 5]],  // comb
    [[0, 1, 2, 1], [0, 1, 0, 4], [0, 4, 2, 4], [2, 4, 3, 5]]   // tailed cup
  ];
  const DIALECT_SIZE = 9;                                      // how many of the 18 any one speaker uses
  const PHRASE_WORDS_MIN = 1, PHRASE_WORDS_MAX = 3;
  const WORD_RUNES_MIN = 2, WORD_RUNES_MAX = 4;
  /* xorshift32 — a SEEDED stream, so the same turn always yields the same line (Math.random here
     would re-roll the phrase every frame and the bubble would shimmer instead of speak).

     The seed is FINALISED (murmur3 fmix32) before it becomes state. Raw xorshift seeded with a
     small or sequential integer has a strongly correlated FIRST output — measured: 2000 nearby
     seeds every one of which opened below 1/3, so every phrase came out exactly one word long.
     The bug is invisible in the shipped call (U.hash is already an avalanche) and obvious the
     moment anything else seeds it, which is precisely the kind of latent trap worth killing. */
  function glyphRnd(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    s ^= s >>> 16; s = Math.imul(s, 0x85ebca6b) >>> 0;
    s ^= s >>> 13; s = Math.imul(s, 0xc2b2ae35) >>> 0;
    s ^= s >>> 16; s = (s >>> 0) || 0x9e3779b9;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  // a speaker's own alphabet: a stable shuffled subset of the runes, chosen by its id
  function glyphDialect(seed) {
    const pool = [];
    for (let i = 0; i < RUNES.length; i++) pool.push(i);
    const r = glyphRnd((seed >>> 0) ^ 0x5bf03635);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1)), t = pool[i];
      pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, DIALECT_SIZE).sort(function (a, b) { return a - b; });
  }
  /* WHEN A TURN'S BUBBLE MUST BE GONE — derived from the TURN, never from when the speaker
     happened to start.

     THE BUG THIS EXISTS TO KILL (found by running the live probe five times, not once; the fifth
     run showed two bubbles up together). A bubble used to live a fixed 1410ms from its own stamp.
     That is correct only for a body that starts speaking exactly on its slot boundary. A body
     that ARRIVES LATE joins its turn already in progress — myTurnN puts it straight on the floor
     mid-slot — so its bubble was still fading 500ms into the NEXT speaker's turn, and two mouths
     appeared to be talking at once. Exactly the shape of the W5 hold-clock defect one section
     up: a per-body clock where the encounter's own clock was the truth.

     So the window is anchored to the SLOT: whichever body holds turn k, its bubble is gone at
     k*slot + speak + fade — the instant the mouth stops, plus the fade. Late joiners get a
     shorter bubble, which is right: their turn really is nearly over. Two consecutive windows
     cannot overlap as long as speak + fade <= slot, which is a property of the tuning and is
     locked as such in test/glyph-speech.test.js. */
  function chatterWindow(startedAt, elapsed, slotMs, speakMs, fadeMs) {
    const turn = Math.floor(Math.max(0, elapsed) / slotMs);
    return { turn: turn, until: startedAt + turn * slotMs + speakMs + fadeMs };
  }
  // one utterance: a few short words, all drawn from the speaker's own dialect
  function glyphPhrase(seed, dialect) {
    if (!dialect || !dialect.length) return [];
    const r = glyphRnd(seed);
    const nw = PHRASE_WORDS_MIN + Math.floor(r() * (PHRASE_WORDS_MAX - PHRASE_WORDS_MIN + 1));
    const out = [];
    for (let w = 0; w < nw; w++) {
      const nr = WORD_RUNES_MIN + Math.floor(r() * (WORD_RUNES_MAX - WORD_RUNES_MIN + 1));
      const word = [];
      for (let i = 0; i < nr; i++) word.push(dialect[Math.floor(r() * dialect.length)]);
      out.push(word);
    }
    return out;
  }
  /* GLYPH-SPEECH-PURE-END */

  const CHATTER_FADE_MS = 260;                          // the bubble's fade-out tail
  const CHATTER_MS = TALK_SPEAK_MS + CHATTER_FADE_MS;   // it lives exactly as long as the mouth moves, plus that tail
  const glyphDialects = new Map();                      // agent id -> its rune subset (stable for the session)
  function dialectFor(b) {
    const id = String(b.id == null ? (b.agentId || 'agent') : b.id);
    let d = glyphDialects.get(id);
    if (!d) { d = glyphDialect(U.hash(id)); glyphDialects.set(id, d); }
    return d;
  }
  /* Roll THIS turn's line — once, on the rising edge of the body's turn, never in the draw path.
     Refuses any body that is not actually in a two-sided conversation: a 'watch'/'follow' beat is
     silent by construction and a bubble over one would claim a talk that isn't happening.

     ⛔ THE SEED IS THE TURN'S ABSOLUTE INSTANT, NOT ITS INDEX. `w.turn` counts from the start of
     the ENCOUNTER, so it resets to 0 every time — seeding on (id, turn) made every agent replay
     the identical script in every conversation it ever had: same opening line, same second line,
     for the life of the station. `w.until` is an absolute clock deadline, so it identifies THIS
     turn of THIS encounter and nothing else, which is what makes a fresh conversation a fresh
     one. It is still fully deterministic — same encounter, same turn, same line — so the phrase
     holds still for as long as it is on screen, which is the property that matters for the draw.

     What deliberately does NOT vary is the speaker's DIALECT (dialectFor): an agent keeps its own
     9 runes for life, so it sounds like itself and a trio reads as three voices rather than one
     noise source. Varying that too would make the whole floor read as static. */
  function startChatter(b) {
    if (!b || !b.social || !isTalkKind(b.social.kind) || !socialBeat || !socialBeat.startedAt) { if (b) b.chatter = null; return; }
    const w = chatterWindow(socialBeat.startedAt, fnow - socialBeat.startedAt, TALK_SLOT_MS, TALK_SPEAK_MS, CHATTER_FADE_MS);
    b.chatter = { at: fnow, until: w.until, words: glyphPhrase(U.hash(String(b.id) + '@' + Math.round(w.until)), dialectFor(b)) };
  }
  // `talking` is the world's own reason for the speaking pose; the hero ORs it with Voice in
  // drawAgent (which recomputes `speaking` every frame), crew carry it directly.
  function setTalking(b, on) {
    if (!b) return;
    const rising = !!on && !b.talking;
    b.talking = !!on;
    if (b !== agent) b.speaking = !!on;
    if (rising) startChatter(b);   // W6: this turn's line is rolled HERE, once — see startChatter
  }
  /* Enter the face-each-other hold (varied duration). Each body enters its own hold independently as
     it arrives.

     W5 — THE CLOCK RUNS FROM THE LAST ARRIVAL, NOT THE FIRST. This used to end the encounter as soon
     as ANY participant reached its own `until`, which was survivable with two bodies (they arrive
     seconds apart, and the loser still got most of the exchange) but is a real defect with three:
     the live probe caught a run where the third body was still walking when the first one's timer
     expired, so it reached the huddle and got ZERO turns — the encounter it had been recruited into
     ended in its face. Stamping the latest arrival on the SLOT and measuring from there means a late
     arrival extends the conversation rather than being cut out of it.

     Bounded on both sides, so this cannot hang: it can only ever push the end LATER, and
     SOCIAL_HARD_MS still ends everything regardless (stepSocialGuard). A body that never arrives at
     all never stamps, so the ones who did arrive still finish on time — the encounter is not held
     hostage by a body that cannot reach it. Writing this one monotonic timestamp on the station slot
     is not a K2 break: K2 forbids a body writing ANOTHER BODY's state, and the slot is already
     coordinator-owned (startEncounter writes it, endEncounter clears it). */
  function enterHold(now, pl) {
    pl.phase = 'hold';
    pl.holdLen = U.irnd(SOCIAL_HOLD_MIN, SOCIAL_HOLD_MAX);
    pl.until = now + pl.holdLen;                        // kept: the per-body deadline older readers expect
    pl.holdAt = now;                                    // W4: THIS body has arrived (the turn PHASE comes from socialBeat.startedAt — see talkTurn)
    if (socialBeat) socialBeat.lastArrivalAt = Math.max(socialBeat.lastArrivalAt || 0, now);   // W5: the shared "everyone who is coming is here" mark
    self.pathPts = null; self.target = null; self.state = 'idle'; self.goal = 'social';
    // (The GREETING wave that used to fire here is gone with the rest of the gesture-track misuse:
    // the only such art in the project is an arms-up stretch, and a stretch is not a wave. What
    // remains is what the bodies actually do — turn to face each other and take turns.)
  }

  /* stepSocialGuard — called every tick for a body whose goal==='social', BEFORE stepSocial. Enforces the two
     global safety nets: (1) whole-encounter hard timeout (G4 — the slot frees no matter what), and (2) the
     partner-broken check (K3 — if the OTHER party was seized/despawned/chat-focused, the survivor releases now
     rather than waiting forever at a rendezvous). Returns true if it handled (ended) the beat this tick. */
  function stepSocialGuard(now) {
    if (!socialBeat) { setTalking(self, false); if (self.social) { self.social = null; if (self.goal === 'social') { self.goal = null; self.state = 'idle'; self.idleUntil = now + 300; } } return true; }
    if (now >= socialBeat.until || encounterBroken(now)) { endEncounter(now); return true; }
    return false;
  }

  /* maybeSocial — SELECTION hook, called from decideIdle at the existing idle cadence with self = the deciding
     idle body (K4: never triggered by observing another encounter — only off neighborsOf at re-decide time). Rolls
     (SOCIAL_SEL_ROLL) and only when: the station gate is open (crewBeatDamp — shared G5 budget), no encounter
     is live (G4), self is eligible, and a concrete candidate pair exists. Tries the beats in PRIORITY order (see
     the W5b note below); the first that assembles a zone-legal plan wins. reduceMotion → no walking beats
     (degrade to Tier C: return false, let the normal gaze life run). Returns true iff an encounter was started
     (⇒ decideIdle stops).
     NOTE the roll is NOT the rate governor — the lane cooldown is. The roll only decides how quickly an
     already-open lane gets spent, which is why raising it does not multiply the encounter count. */
  function maybeSocial(now) {
    if (reduceMotion()) return false;                                    // reduceMotion: no walking social beats (Tier C glances only)
    if (socialBeat) return false;                                        // G4: one live encounter
    if (chaseId != null) return false;                                   // TIER D · D4: mutual exclusion — no social beat while THE CHASE is live (one noticeable station-level thing at a time, from EITHER body's decideIdle)
    if (self.social) return false;                                       // already in one (defensive)
    if (!socialEligible(self, now)) return false;
    if (now < socialGateUntil) return false;                             // TIER D · D3 LANE: social has its OWN station cooldown (W5: conversation 30-60s, silent beats 12-25s) — decoupled from the quirk-gate race so the RATE is governed here, not by whoever wins the shared gate. RNG-free (N=1 parity preserved). A fired encounter STILL arms the shared gate (armBeat) so total station calm holds.
    // in-sight SAME-ZONE neighbors (Tier C read-only scan) + whether ANY other placed body exists (adjacent-zone
    // border candidates aren't same-zone, so the border precheck scans allBodies). CRITICAL N=1 PARITY (hunt 6):
    // the U.chance roll is gated BEHIND candidate existence — a solo floor (no other body) returns here BEFORE the
    // roll, so it consumes ZERO extra RNG draws and stays byte-identical to pre-D3 (U.* are independent Math.random
    // wrappers, so a skipped draw shifts nothing). No candidate ⇒ no roll ⇒ provable no-op.
    const near = neighborsOf(self, SOCIAL_NEAR_RADIUS);
    const anyOther = allBodies().some(b => b !== self && !b.unplaced);   // is there any OTHER placed body at all (border candidates aren't same-zone)?
    if (!near.length && !anyOther) return false;                         // no same-zone neighbor AND no other placed body → not a candidate; skip the roll (N=1 parity: solo floor never rolls)
    if (!U.chance(SOCIAL_SEL_ROLL)) return false;                        // only reached when a real candidate could exist
    /* ORDER MATTERS, AND IT USED TO BE BACKWARDS (W5b). The kinds are tried in sequence and the first
       that assembles a legal plan wins the single slot — so the order is a PRIORITY, not a list. It
       ran watch → huddle → follow → border, which put the two SILENT kinds ahead of the conversation:
       on any floor where somebody was working, 'watch' won the race almost every time, and (before
       W5a split the lanes) it then shut the social lane for minutes on a beat with no talking in it.
       The talking kinds now go first. The silent ones still happen — they are the fallback when there
       is nobody to actually talk to, which is exactly what they should be. */
    // 1) HUDDLE: eligible same-zone idle neighbours → converge and talk (a trio if a third is in reach).
    const idleCands = near.filter(o => socialEligible(o, now) && !pairOnCd(self.id, o.id, now));
    if (idleCands.length && planHuddle(self, idleCands, now)) return true;
    // 2) BORDER MEETING: an eligible idle body in an ADJACENT zone with a shared edge → meet at the border and talk.
    if (planBorderMeeting(self, now)) return true;
    // 3) WATCH-A-PEER-WORK (silent): a WORKING neighbor in my zone → stand ~2 tiles behind it, face its desk.
    for (const w of near) {
      if (!(w.working)) continue;
      if (pairOnCd(self.id, w.id, now)) continue;
      if (planWatch(self, w, now)) return true;
    }
    // 4) HALF-FOLLOW (silent): a WALKING body passing nearby (may be tasked/idle-walking) → half-follow its path.
    for (const w of near) {
      if (w.state !== 'walk') continue;
      if (pairOnCd(self.id, w.id, now)) continue;
      if (planFollow(self, w, now)) return true;
    }
    return false;
  }

  // ---- per-kind plan builders (each returns true iff it armed a zone-legal encounter) ----

  /* HUDDLE: pick a walkable in-zone tile for each body that is ADJACENT to the others' approach, so they end up
     facing one another a tile apart. Simplest robust form: each walks to a tile near the midpoint, inside its
     OWN zone. We resolve concrete tiles so every plan is fixed at initiation (K2 — no mid-tick partner reads for
     the target).

     W5 — `cands` is now the whole eligible neighbour LIST, not one pre-picked body, because the third
     body of a trio has to be chosen HERE: only this function knows whether a legal third tile exists,
     and a recruit that cannot be given a tile must not be recruited at all. Order of business:
       1. pick the partner (unchanged: one uniform pick over the candidates)
       2. resolve the pair's two tiles — if that fails there is no huddle at all, trio or not
       3. only then roll for a third, and only among candidates that are ALSO eligible with the partner
          (pair cooldown both ways) and can be given a third distinct tile in their OWN zone
     Failing the third is never fatal: it falls back to the pair that was already legal. This ordering
     is what stops the trio from being able to COST encounters — the feature can only ever add a body
     to a huddle that was going to happen anyway. */
  function planHuddle(a, cands, now, forceTrio) {
    const list = Array.isArray(cands) ? cands : [cands];
    if (!list.length) return false;
    huddleStats.planned++;
    huddleStats.candCounts[list.length] = (huddleStats.candCounts[list.length] || 0) + 1;
    // COMPANIONS: the partner is drawn with a pull toward `a`'s proven companions (was a uniform
    // U.pick). Every candidate keeps a non-zero weight, so this shifts WHO tends to be picked over
    // many encounters without ever making a pairing impossible.
    const b = pickByBond(a.id, list);
    if (!b) return false;
    const zA = zoneFor(a), zB = zoneFor(b);
    const ca = tileOf(a.px, a.py), cb = tileOf(b.px, b.py);
    const mx = Math.round((ca.x + cb.x) / 2), my = Math.round((ca.y + cb.y) / 2);
    const ta = nearestWalkableInZone(zA, mx, my, ca, 4);
    if (!ta) return false;
    // b aims for a tile adjacent to a's target, still in b's own zone (so they end up ~1 tile apart, facing)
    const tb = nearestWalkableInZone(zB, ta.x, ta.y, cb, 4, ta);   // exclude a's exact tile
    if (!tb) return false;
    // ...and the two meeting tiles must SEE each other (2026-08-17). Each tile is resolved inside its own
    // body's zone, so when the pair straddles a room boundary the "adjacent" tiles can land on opposite
    // sides of the wall — a huddle held through the plaster. No sightline, no huddle.
    if (!losClear(ta.x, ta.y, tb.x, tb.y)) return false;
    const planA = { phase: 'walk', tx: ta.x, ty: ta.y, faceTile: 'partner' };
    const planB = { phase: 'walk', tx: tb.x, ty: tb.y, faceTile: 'partner' };
    // ---- the third body (W5) ----
    const extras = [];
    const rest = list.filter(o => o !== b && !pairOnCd(b.id, o.id, now));
    if (!rest.length) huddleStats.noThirdCandidate++;
    // COMPANIONS: a candidate bonded to BOTH bodies makes the trio likelier to fire, and is likelier
    // to be the one recruited — so the groups of three that form are the friend group, not a random
    // third. The bonus rides the existing roll (it can only ADD trios, never cost the pair a huddle).
    let bestGroupBond = 0;
    for (const o of rest) bestGroupBond = Math.max(bestGroupBond, bondMean([a.id, b.id], o && o.id, bondOf));
    if (rest.length && (forceTrio || U.chance(SOCIAL_TRIO_CHANCE + BOND_TRIO_BONUS * bestGroupBond))) {
      huddleStats.trioRolled++;
      const c = pickByBond([a.id, b.id], rest);
      const cc = tileOf(c.px, c.py);
      // a third tile near the SAME meeting point, in c's own zone (G3), distinct from both taken tiles.
      const tc = nearestWalkableInZone(zoneFor(c), ta.x, ta.y, cc, 4, ta, tb);
      // the third body has to see BOTH of the other two — a trio round a corner is one body talking to a wall
      if (tc && losClear(tc.x, tc.y, ta.x, ta.y) && losClear(tc.x, tc.y, tb.x, tb.y)) extras.push({ body: c, plan: { phase: 'walk', tx: tc.x, ty: tc.y, faceTile: 'partner' } });
      else huddleStats.trioTileFail++;
    }
    if (extras.length) huddleStats.trioFired++;
    return startEncounter(a, b, 'huddle', now, planA, planB, extras);
  }

  // WATCH-A-PEER-WORK: stand ~2 tiles behind the worker (on the side away from its desk facing), inside the
  // observer's zone, and face the worker's desk. Only the observer moves; the worker keeps working untouched.
  function planWatch(obs, worker, now) {
    if (pairOnCd(obs.id, worker.id, now)) return false;
    const zone = zoneFor(obs);
    const wt = tileOf(worker.px, worker.py);
    // "behind" = the direction from the worker back toward the observer (so it approaches from where it already is)
    const dx = Math.sign(obs.px - worker.px) || 0, dy = Math.sign(obs.py - worker.py) || 0;
    const cands = [];
    for (const dist of [2, 3, 1]) cands.push({ x: wt.x + dx * dist, y: wt.y + dy * dist });
    cands.push({ x: wt.x + 2, y: wt.y }, { x: wt.x - 2, y: wt.y }, { x: wt.x, y: wt.y + 2 }, { x: wt.x, y: wt.y - 2 });
    const oc = tileOf(obs.px, obs.py);
    for (const c of cands) {
      if (!tileInZone(zone, c.x, c.y) || !geo.walkable(c.x, c.y, blocked)) continue;
      if (c.x === wt.x && c.y === wt.y) continue;
      // observer-only encounter: the worker has NO social plan (it keeps working). Use a one-sided beat: give the
      // worker a null plan but still register the slot so no other encounter starts. endEncounter tolerates a
      // partner with no social plan (it just won't tear anything down for it).
      if (socialBeat) return false;
      obs.social = { phase: 'walk', tx: c.x, ty: c.y, faceTile: { x: wt.x, y: wt.y }, kind: 'watch', partnerId: worker.id };
      obs.goal = 'social'; obs.stilling = false; obs.usingProp = null; obs.sitting = false; obs.pauseUntil = 0; obs.pauseLook = null; obs.studyKey = null;
      socialBeat = { kind: 'watch', aId: obs.id, bId: worker.id, until: now + SOCIAL_HARD_MS, startedAt: now, ids: [obs.id, worker.id] };
      armSocialBudget(now, 'watch');   // shared-gate arm + the SHORT quiet lane (W5a: a silent beat must not spend the conversation budget)
      return true;
    }
    return false;
  }

  // HALF-FOLLOW: begin trailing the walking body. The observer gets a 'follow' plan with a step budget; stepSocial
  // takes it 2-4 tiles toward the (moving) partner, zone-clamped, then STOPS (never completes). One-sided: the
  // walker has no plan (it's just passing through / on its own task).
  function planFollow(obs, walker, now) {
    if (socialBeat) return false;
    const zone = zoneFor(obs);
    const oc = tileOf(obs.px, obs.py), wc = tileOf(walker.px, walker.py);
    // first step toward the walker, in-zone
    const sx = Math.sign(wc.x - oc.x), sy = Math.sign(wc.y - oc.y);
    let first = null;
    for (const [dx, dy] of [[sx, sy], [sx, 0], [0, sy]]) {
      if (!dx && !dy) continue;
      const tx = oc.x + dx, ty = oc.y + dy;
      if (tileInZone(zone, tx, ty) && geo.walkable(tx, ty, blocked)) { first = { x: tx, y: ty }; break; }
    }
    if (!first) return false;
    obs.social = { phase: 'walk', tx: first.x, ty: first.y, faceTile: 'partner', kind: 'follow', partnerId: walker.id, followLeft: U.irnd(SOCIAL_FOLLOW_MIN, SOCIAL_FOLLOW_MAX) };
    obs.goal = 'social'; obs.stilling = false; obs.usingProp = null; obs.sitting = false; obs.pauseUntil = 0; obs.pauseLook = null; obs.studyKey = null;
    if (!setPathTo({ x: first.x, y: first.y })) { obs.social = null; obs.goal = null; return false; }
    obs.social.followLeft -= 1;
    socialBeat = { kind: 'follow', aId: obs.id, bId: walker.id, until: now + SOCIAL_HARD_MS, startedAt: now, ids: [obs.id, walker.id] };
    armSocialBudget(now, 'follow');   // shared-gate arm + the SHORT quiet lane (W5a)
    return true;
  }

  /* BORDER MEETING: find an eligible idle body in an ADJACENT zone (a shared rect edge exists), then send each body
     to the nearest walkable tile of the shared edge INSIDE ITS OWN zone (never a crossing — G3 staged, not hidden).
     Shared-edge geometry is computed directly from the two zone rects (no zones.js API change). A zone that isn't a
     single rect ('leash'/'multi') can't cleanly express a shared edge → those pairs simply aren't border candidates
     (documented skip, not a zones.js edit). */
  function planBorderMeeting(a, now) {
    const zA = zoneFor(a);
    const ra = zoneRect(zA); if (!ra) return false;                      // only single-rect (room) zones border-meet
    for (const b of allBodies()) {
      if (b === a) continue;
      if (!socialEligible(b, now) || pairOnCd(a.id, b.id, now)) continue;
      const zB = zoneFor(b); const rb = zoneRect(zB); if (!rb) continue;
      const edge = sharedEdge(ra, rb); if (!edge) continue;              // no shared edge → not a border pair
      // each body walks to the nearest tile of the shared line INSIDE its own rect
      const walk = (x, y) => geo.walkable(x, y, blocked);   // injected so borderTileFor stays pure (headless-testable)
      const ta = borderTileFor(ra, edge, tileOf(a.px, a.py), walk);
      const tb = borderTileFor(rb, edge, tileOf(b.px, b.py), walk);
      if (!ta || !tb) continue;
      if (!tileInZone(zA, ta.x, ta.y) || !tileInZone(zB, tb.x, tb.y)) continue;   // belt-and-suspenders containment
      /* AND THEY MUST BE ABLE TO SEE EACH OTHER ACROSS THE LINE (2026-08-17). This beat is the reason
         "they talk through walls" was a designed behaviour and not a near-miss: two rects that ABUT are
         separated on a real floor by the wall between them, so both bodies dutifully walked to their own
         side of it and held a conversation through the plaster. The shared edge is still the right idea —
         it is just only a MEETING when the two tiles can actually see one another, which on a walled
         boundary means the pair resolved onto a doorway. Everything else is skipped, and the loop simply
         tries the next candidate. */
      if (!losClear(ta.x, ta.y, tb.x, tb.y)) continue;
      return startEncounter(a, b, 'border', now,
        { phase: 'walk', tx: ta.x, ty: ta.y, faceTile: 'partner' },
        { phase: 'walk', tx: tb.x, ty: tb.y, faceTile: 'partner' });
    }
    return false;
  }
  // the single normalized rect of a 'room' zone, else null (leash/multi don't express a clean shared edge)
  function zoneRect(zone) { return (zone && zone.kind === 'room' && zone.rect) ? zone.rect : null; }
  /* D3-PURE-GEOMETRY-BEGIN — sharedEdge + borderTileFor are PURE (no module state, no RNG, no DOM; the walkable
     test is injected). test/social-border.test.js extracts THIS marked block from the source and executes it
     headlessly (the world IIFE itself can't load under node), so the shipped code — not a copy — is what's under
     test. Keep this block self-contained: only Math.* + its own params. Also exposed read-only on the World API
     as _dbgSocialGeom for the in-browser dev harness. */
  // shared edge between two inclusive rects that are ADJACENT (abut along a full or partial line). Returns
  // { axis:'v'|'h', line, lo, hi } — a vertical shared edge at column `line` spanning rows lo..hi (or horizontal).
  // Adjacency = the rects touch along one line (one's right edge == the other's left edge (±0/1), overlapping span).
  function sharedEdge(ra, rb) {
    // vertical edge: ra is left of rb (ra.x2 abuts rb.x1) or vice-versa
    const vpairs = [[ra, rb], [rb, ra]];
    for (const [l, r] of vpairs) {
      if (Math.abs(l.x2 - r.x1) <= 1 || l.x2 + 1 === r.x1 || l.x2 === r.x1) {
        const lo = Math.max(l.y1, r.y1), hi = Math.min(l.y2, r.y2);
        if (hi >= lo && (l.x2 + 1 === r.x1 || l.x2 === r.x1 || Math.abs(l.x2 - r.x1) <= 1)) return { axis: 'v', line: l.x2, lo, hi, lx: l.x2, rx: r.x1 };
      }
    }
    // horizontal edge: l above r (l.y2 abuts r.y1)
    for (const [t, b] of [[ra, rb], [rb, ra]]) {
      if (t.y2 + 1 === b.y1 || t.y2 === b.y1 || Math.abs(t.y2 - b.y1) <= 1) {
        const lo = Math.max(t.x1, b.x1), hi = Math.min(t.x2, b.x2);
        if (hi >= lo) return { axis: 'h', line: t.y2, lo, hi, ty: t.y2, by: b.y1 };
      }
    }
    return null;
  }
  // nearest walkable tile of `rect` along the shared edge (inside rect), closest to the body's current tile.
  // `walkableFn(x,y)` is injected so the function stays pure (callers pass the live geo.walkable+blocked).
  function borderTileFor(rect, edge, cur, walkableFn) {
    const cands = [];
    if (edge.axis === 'v') {
      // the column of THIS rect that sits on the shared edge: rect.x2 if rect is the left one, else rect.x1
      const col = (rect.x2 === edge.lx) ? rect.x2 : ((rect.x1 === edge.rx) ? rect.x1 : (Math.abs(rect.x2 - edge.line) <= 1 ? rect.x2 : rect.x1));
      for (let y = edge.lo; y <= edge.hi; y++) cands.push({ x: col, y });
    } else {
      const row = (rect.y2 === edge.ty) ? rect.y2 : ((rect.y1 === edge.by) ? rect.y1 : (Math.abs(rect.y2 - edge.line) <= 1 ? rect.y2 : rect.y1));
      for (let x = edge.lo; x <= edge.hi; x++) cands.push({ x, y: row });
    }
    cands.sort((p, q) => (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) - (Math.abs(q.x - cur.x) + Math.abs(q.y - cur.y)));
    for (const c of cands) if (walkableFn(c.x, c.y)) return c;
    return null;
  }
  /* D3-PURE-GEOMETRY-END */
  // nearest walkable in-zone tile to (tx,ty), searching a small ring; `cur` biases toward reachability; `excl` an
  // optional tile to skip (so a huddle partner doesn't target the same tile). Deterministic ring scan (no RNG).
  function nearestWalkableInZone(zone, tx, ty, cur, radius, ...excl) {
    const taken = excl.filter(Boolean);   // W5: variadic — a trio has TWO tiles already spoken for, not one
    for (let r = 0; r <= radius; r++) {
      const ring = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // only the ring at Chebyshev distance r
        ring.push({ x: tx + dx, y: ty + dy });
      }
      ring.sort((p, q) => (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) - (Math.abs(q.x - cur.x) + Math.abs(q.y - cur.y)));
      for (const c of ring) {
        if (taken.some(e => c.x === e.x && c.y === e.y)) continue;
        if (tileInZone(zone, c.x, c.y) && geo.walkable(c.x, c.y, blocked)) return c;
      }
    }
    return null;
  }

  /* ================= TIER E · THE GATHERING — the station assembles, and pretends it didn't ==========

     THE ASK, verbatim: "every so often if the station is quiet, they will all be gathered into an
     area big group, and then the overseer who is by himself, looking at the agents, and talking in
     his language... they all scatter like cockroaches when the user comes back, and they pretend
     like everything's normal. That's the whole idea." Reference: the security guard in Planet of the
     Apes noticing the apes gathered around their leader.

     WHY THIS IS ITS OWN BEAT AND NOT A BIG HUDDLE. The D3 social system is built on one encounter
     slot and a HARD ceiling of three bodies, because four sprites cannot hold a legible conversation
     (see SOCIAL_MAX_PARTY). This is not a conversation: nobody converses, one body speaks and the
     rest are an audience. That removes turn-taking entirely — which is exactly why the ceiling does
     not apply and why this is cheap to stage. It is a formation plus one speaker.

     ⛔⛔⛔ THE ROAM LEASH IS SUSPENDED HERE, DELIBERATELY, AND NOWHERE ELSE.
     Every body is normally caged to Zones.ROAM_RADIUS (14 tiles) around its OWN desk, and every
     social target is zone-clamped (G3). A station-wide assembly is by definition bodies leaving
     their own areas, so the gathering resolves its tiles against `geo.walkable` + the containment
     backstop ONLY. That is the one rule this beat breaks, it is bounded to the beat's lifetime, and
     every body is restored to ordinary leashed idle life on dissolve. Do not "fix" this by
     re-adding tileInZone: on a real floor no single tile is inside every body's leash, so the
     gathering would silently never assemble — which is the failure mode that looks like nothing.

     ⛔⛔ THE INTERRUPT IS THE PRIMARY EXIT, NOT THE EDGE CASE. The trigger requires ~30 minutes of
     quiet, which means it fires precisely when nobody is driving. So the overwhelmingly likely way
     any gathering ends is the Commander coming back and moving the mouse. Scatter is therefore the
     path that gets the care, not the timer.

     TRUTHFUL TELEMETRY. The station never acknowledges this: no COMMS beat, no toast, no event, no
     log line, nothing persisted. That is not an omission to fix later — a gathering the harness
     could prove would stop being unsettling, and asserting the agents "held a meeting" would be
     claiming coordination that never happened. They are sprites standing in a room. */
  let gathering = null;                    // the single live assembly, or null. Station-wide, like socialBeat.
  let gatherRollAt = -1e9;                 // next instant the hourly roll is allowed
  let gatherGateUntil = -1e9;              // earliest a NEXT gathering may begin (long, after one ends)
  let stationBusyAt = -1e9;                // last instant the station had work or a present Commander

  const GATHER_QUIET_MS = 30 * 60 * 1000;  // the station must have been unattended this long ("if the station is quiet")
  const GATHER_ROLL_EVERY_MS = 15 * 60 * 1000;  // roll every 15 min while quiet — hourly made it near-unseeable (~3h expected wait)
  const GATHER_CHANCE = 0.25;              // ...and even then it usually does not happen (~1 quiet hour expected to first assembly)
  const GATHER_MIN_BODIES = 3;             // two agents standing together is a huddle, not an assembly
  const GATHER_CONVERGE_MS = 45000;        // walking-in budget; late bodies simply hold where they got to
  const GATHER_HOLD_MIN = 300000, GATHER_HOLD_MAX = 600000;   // 5-10 min — long enough to be CAUGHT; the return-scatter is the payoff
  const GATHER_HARD_MS = 720000;           // whole-beat hard timeout — the slot ALWAYS frees; must exceed converge + max hold
  const GATHER_AFTER_CD = 90 * 60 * 1000;  // it must stay rare even on a station left running for days
  const GATHER_SPEAK_MS = 2600, GATHER_GAP_MS = 1500;         // the overseer's line, then a real beat of silence
  const OVERSEER_BREAK_MS = 900;           // ⛔ the overseer holds AFTER everyone else bolts — see endGathering
  const GATHER_STAND_R = 5;                // audience packs within this radius of the assembly point
  const GATHER_OVERSEER_GAP = 4;           // ...and the overseer stands this far off, alone, facing them

  function gatherBodies() { return (agent && !agent.unplaced ? [agent] : []).concat(crew.filter(b => b && !b.unplaced)); }
  function gatherIds() { return gathering ? gathering.ids.slice() : []; }
  function gatherBodiesLive() { return gatherIds().map(bodyForAgent).filter(Boolean); }

  /* Is the station unattended RIGHT NOW? Work of any kind, a summoned hero, a live chat stare, or a
     Commander who is actually moving the cursor all count as attended and re-stamp the clock. */
  function stationAttended(now) {
    if (activity === 'task') return true;
    if (chatHot(now)) return true;
    if (crew.some(b => b && b.working)) return true;
    if (socialBeat) return false;                                   // ordinary idle life is not attendance
    return false;
  }
  function cursorPresent(now) {
    if (!lastCursor || !lastCursor.t) return false;
    return (now - cursorMoveT) < CURSOR_MOVING_MS || (now - lastCursor.t) < CURSOR_FRESH_MS;
  }
  function pageVisible() { try { return typeof document === 'undefined' || !document.hidden; } catch (_) { return true; } }

  /* THE FORMATION IS RESOLVED UP FRONT, ONE SLOT PER BODY (K2, same law startEncounter follows).
     Sending everyone "toward a room" and letting them sort it out is how a dozen bodies deadlock on
     each other's tiles; a fixed distinct target per body cannot. Returns null when the floor cannot
     seat the whole party — better no gathering than half of one standing in a doorway. */
  function planGathering(bodies) {
    if (!geo || bodies.length < GATHER_MIN_BODIES) return null;
    let sx = 0, sy = 0;
    for (const b of bodies) { const t = tileOf(b.px, b.py); sx += t.x; sy += t.y; }
    const cx = Math.round(sx / bodies.length), cy = Math.round(sy / bodies.length);
    // the assembly point: nearest walkable tile to the crew's centroid
    let center = null;
    for (let r = 0; r <= 10 && !center; r++) {
      for (let dy = -r; dy <= r && !center; dy++) for (let dx = -r; dx <= r && !center; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (geo.walkable(cx + dx, cy + dy, blocked)) center = { x: cx + dx, y: cy + dy };
      }
    }
    if (!center) return null;
    // the overseer stands apart. Try each cardinal at the gap distance and take the first walkable
    // one — "by himself, looking at the agents" only reads if he is clear of the crowd.
    let over = null;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const c = { x: center.x + dx * GATHER_OVERSEER_GAP, y: center.y + dy * GATHER_OVERSEER_GAP };
      if (geo.walkable(c.x, c.y, blocked)) { over = c; break; }
    }
    if (!over) return null;
    // audience slots: walkable tiles near the centre, nearest-to-the-overseer first, so the crowd
    // packs FACING him instead of trailing away behind the assembly point.
    const slots = [];
    const seen = new Set([over.x + ',' + over.y]);
    for (let r = 0; r <= GATHER_STAND_R; r++) {
      const ring = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const c = { x: center.x + dx, y: center.y + dy };
        const k = c.x + ',' + c.y;
        if (seen.has(k) || !geo.walkable(c.x, c.y, blocked)) continue;
        seen.add(k);
        ring.push(c);
      }
      ring.sort((p, q) => (Math.abs(p.x - over.x) + Math.abs(p.y - over.y)) - (Math.abs(q.x - over.x) + Math.abs(q.y - over.y)));
      for (const c of ring) slots.push(c);
    }
    // the overseer is the hero when it is on the floor (it is the station's own agent); otherwise the
    // body standing nearest the chosen spot takes the part. Never invent a body that is not there.
    const overseer = (agent && !agent.unplaced && bodies.indexOf(agent) >= 0) ? agent
      : bodies.slice().sort((p, q) => (Math.abs(tileOf(p.px, p.py).x - over.x) + Math.abs(tileOf(p.px, p.py).y - over.y))
                                    - (Math.abs(tileOf(q.px, q.py).x - over.x) + Math.abs(tileOf(q.px, q.py).y - over.y)))[0];
    const audience = bodies.filter(b => b !== overseer);
    if (slots.length < audience.length) return null;                 // the floor cannot seat them — stage nothing
    // greedy nearest-slot assignment, closest body first, so nobody crosses the crowd to reach a seat
    const free = slots.slice(), plan = [];
    for (const b of audience.slice().sort((p, q) => (Math.abs(tileOf(p.px, p.py).x - center.x) + Math.abs(tileOf(p.px, p.py).y - center.y))
                                                  - (Math.abs(tileOf(q.px, q.py).x - center.x) + Math.abs(tileOf(q.px, q.py).y - center.y)))) {
      const t = tileOf(b.px, b.py);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < free.length; i++) {
        const d = Math.abs(free[i].x - t.x) + Math.abs(free[i].y - t.y);
        if (d < bd) { bd = d; bi = i; }
      }
      plan.push({ body: b, slot: free.splice(bi, 1)[0], role: 'audience' });
    }
    plan.push({ body: overseer, slot: over, role: 'overseer' });
    return { center, plan, overseer };
  }

  /* maybeGather — the station-level selection hook (NOT a per-body decideIdle roll: this is one
     station-wide event, so it is decided once per tick from the tick itself). */
  function maybeGather(now) {
    if (gathering || socialBeat) return false;                       // one station-level thing at a time
    if (reduceMotion()) return false;                                // no station-wide walking beat under reduce-motion
    if (now < gatherGateUntil) return false;
    if (!pageVisible()) return false;                                /* ⛔ "quiet" correlates with "nobody is
       watching": an hourly roll gated only on idleness fires all night into an empty room, and the one
       feature whose entire point is being SEEN would go weeks unwitnessed. Visible-only is what makes it land. */
    if (cursorPresent(now)) return false;                            // the Commander is right there
    if (now - stationBusyAt < GATHER_QUIET_MS) return false;         // not unattended long enough
    if (now < gatherRollAt) return false;
    gatherRollAt = now + GATHER_ROLL_EVERY_MS;                       // roll at most hourly, win or lose
    if (!U.chance(GATHER_CHANCE)) return false;
    return startGathering(now);
  }

  /* startGathering — THE ONE coordinator (mirrors startEncounter): resolves the whole formation, then
     writes each body's own self-contained plan exactly once. Per-tick stepGather mutates only self. */
  function startGathering(now) {
    const bodies = gatherBodies().filter(b => bodyIsIdle(b, now) && !b.social && !b.working);
    if (bodies.length < GATHER_MIN_BODIES) return false;
    const staged = planGathering(bodies);
    if (!staged) return false;
    gathering = {
      phase: 'converge', startedAt: now,
      convergeUntil: now + GATHER_CONVERGE_MS,
      holdLen: U.irnd(GATHER_HOLD_MIN, GATHER_HOLD_MAX),
      holdFrom: 0, until: now + GATHER_HARD_MS,
      overseerId: staged.overseer.id, center: staged.center,
      ids: staged.plan.map(p => p.body.id), scatterAt: 0,
    };
    for (const p of staged.plan) {
      p.body.gather = { tx: p.slot.x, ty: p.slot.y, role: p.role, started: false, arrived: false, spokeUntil: 0 };
      p.body.goal = 'gather';
      p.body.stilling = false; p.body.usingProp = null; p.body.sitting = false;
      p.body.pauseUntil = 0; p.body.pauseLook = null; p.body.studyKey = null;
    }
    armBeat(now);                                                    // the station's shared calm budget still applies
    return true;
  }

  /* gatheringBroken — the scatter trigger, and the beat's most important predicate. ANY of: work
     arriving on any participant, the hero summoned, a live chat stare, or the Commander simply
     MOVING THE CURSOR. That last one is the Planet of the Apes shot: the guard walks in and the room
     stops being what it was. */
  function gatheringBroken(now) {
    if (!gathering) return true;
    if (cursorPresent(now)) return true;                             // ⛔ THE PRIMARY EXIT — the Commander came back
    if (!pageVisible()) return true;
    if (activity === 'task') return true;
    if (chatHot(now)) return true;
    const bodies = gatherBodiesLive();
    if (bodies.length < GATHER_MIN_BODIES) return true;              // too few left to be an assembly
    for (const b of bodies) { if (b.working || b.unplaced || b.gather == null) return true; }
    return false;
  }

  /* endGathering — teardown. `scatter` distinguishes the two exits, and they must LOOK different.

     ⛔⛔⛔ THE OVERSEER BREAKS LAST. Everyone else drops their plan on this tick and walks off; the
     overseer keeps his for OVERSEER_BREAK_MS, still facing where the crowd was, and only then turns
     away. That single delayed body is what converts "weird animation" into "that thing was in charge
     and it knows you saw it". Removing the delay does not break a test — it just quietly deletes the
     beat everything else here exists to serve. */
  function endGathering(now, scatter) {
    const g = gathering; if (!g) return;
    const overseerId = g.overseerId;
    for (const b of gatherBodiesLive()) {
      if (b.id === overseerId && scatter) continue;                  // the overseer is released below, late
      releaseFromGathering(b, now, scatter);
    }
    if (scatter) {
      // keep the slot alive purely to hold the overseer a beat longer; stepGatheringStation finishes it
      g.phase = 'breaking'; g.scatterAt = now; gathering = g;
      gatherGateUntil = now + GATHER_AFTER_CD;
      return;
    }
    const over = bodyForAgent(overseerId);
    if (over) releaseFromGathering(over, now, false);
    gathering = null;
    gatherGateUntil = now + GATHER_AFTER_CD;
  }
  function releaseFromGathering(b, now, scatter) {
    if (!b) return;
    b.chatter = null; b.talking = false; if (b !== agent) b.speaking = false;
    if (!b.gather) return;
    b.gather = null;
    if (b.goal === 'gather') {
      b.goal = null; b.state = 'idle'; b.pathPts = null; b.target = null;
      /* SCATTER IS MOVEMENT, NOT A STATE FLIP. Snapping every body back to an idle pose in one frame
         reads as a render bug; the dread is in SEEING them disperse. A near-zero idle hold means the
         idle engine re-decides on the very next tick and they walk off immediately, together. */
      b.idleUntil = scatter ? now : Math.max(b.idleUntil || 0, now + U.irnd(300, 900));
    }
  }

  /* stepGatheringStation — the station-level phase machine, ticked once per frame (not per body). */
  function stepGatheringStation(now) {
    if (!gathering) return;
    if (gathering.phase === 'breaking') {                            // the overseer's last beat, then gone
      if (now - gathering.scatterAt >= OVERSEER_BREAK_MS) {
        const over = bodyForAgent(gathering.overseerId);
        if (over) releaseFromGathering(over, now, true);
        gathering = null;
      }
      return;
    }
    if (now >= gathering.until) { endGathering(now, false); return; }
    if (gatheringBroken(now)) { endGathering(now, true); return; }
    if (gathering.phase === 'converge') {
      const bodies = gatherBodiesLive();
      const allIn = bodies.every(b => b.gather && b.gather.arrived);
      if (allIn || now >= gathering.convergeUntil) {                 // late bodies just hold where they got to
        gathering.phase = 'hold';
        gathering.holdFrom = now;
      }
      return;
    }
    if (gathering.phase === 'hold' && now >= gathering.holdFrom + gathering.holdLen) endGathering(now, false);
  }

  /* gatherSpeak — the overseer talking in his own tongue. Deliberately NOT routed through
     setTalking/startChatter: those require a live `socialBeat` + `b.social` and would null the line.
     ⛔ Seeds on the ABSOLUTE deadline (`until`), never a turn index — a turn counter resets every
     encounter and made every agent replay one identical script for the life of the station (the
     glyph-speech escape). Same law, same fix, applied here on purpose. */
  function gatherSpeak(b, now) {
    if (!b || !b.gather || !gathering) return;
    const cycle = GATHER_SPEAK_MS + GATHER_GAP_MS;
    const t = Math.max(0, now - gathering.holdFrom);
    const k = Math.floor(t / cycle);
    const phase = t - k * cycle;
    if (phase >= GATHER_SPEAK_MS) { b.talking = false; if (b !== agent) b.speaking = false; b.chatter = null; return; }
    /* The address is LONGER than one conversational line, and the renderer hard-kills any bubble at
       CHATTER_MS (drawChatter's age cap) — a single line spanning the whole window would leave the
       overseer mouth-moving WORDLESS for its tail, which is the "mouth moving at nobody" lie. So the
       window is spoken as CONSECUTIVE CHATTER-length lines, each with its own glyphs: it reads as a
       longer address, and a bubble is on screen for every ms the mouth moves. Every quantity here
       derives from the encounter clock (holdFrom + constants) — an earlier draft mixed `fnow` into
       the dedup key and float jitter near a bucket boundary re-rolled the phrase mid-line. */
    const windowStart = gathering.holdFrom + k * cycle;
    const j = Math.floor(phase / CHATTER_MS);
    const until = Math.min(windowStart + (j + 1) * CHATTER_MS, windowStart + GATHER_SPEAK_MS);
    if (b.gather.spokeUntil !== Math.round(until)) {                 // one roll per line — deterministic, jitter-free
      b.gather.spokeUntil = Math.round(until);
      // seeded on the line's ABSOLUTE deadline (the glyph-speech law): unique to THIS line of THIS
      // gathering, so no meeting ever replays another's script — yet stable while it is on screen.
      b.chatter = { at: fnow, until: until, words: glyphPhrase(U.hash(String(b.id) + '@' + Math.round(until)), dialectFor(b)) };
    }
    b.talking = true; if (b !== agent) b.speaking = true;
  }

  // read-only view of the live assembly for the dev harness — never a re-derivation, so a green read
  // means THAT formation is the one the engine is holding.
  function gatherStateSnapshot() {
    if (!gathering) return null;
    return {
      phase: gathering.phase, overseerId: gathering.overseerId, center: gathering.center,
      holdLen: gathering.holdLen,
      bodies: gatherBodiesLive().map(b => ({
        id: b.id, role: b.gather ? b.gather.role : null, goal: b.goal,
        slot: b.gather ? { x: b.gather.tx, y: b.gather.ty } : null,
        arrived: !!(b.gather && b.gather.arrived), talking: !!b.talking,
        chatter: !!b.chatter, tile: tileOf(b.px, b.py), dir: b.dir,
      })),
    };
  }

  /* stepGather — per-tick stepper for the CURRENT body (self) while self.goal === 'gather'.
     Mutates ONLY self, exactly like stepSocial. Walk targets are NOT zone-clamped (see the header). */
  function stepGather(now) {
    const pl = self.gather; if (!pl) return;
    if (!pl.arrived) {
      if (self.state === 'walk' || self.target) return;              // the walk machinery is driving it
      const cur = tileOf(self.px, self.py);
      if (cur.x === pl.tx && cur.y === pl.ty) { pl.arrived = true; }
      else if (pl.started) { pl.arrived = true; }                    // path ran out — hold where it got to, never strand
      else if (setPathTo({ x: pl.tx, y: pl.ty })) { pl.started = true; self.goal = 'gather'; return; }
      else { pl.arrived = true; }                                    // unreachable → stand here and face in anyway
    }
    self.state = 'idle'; self.sitting = false;
    if (pl.role === 'overseer') {
      // face the crowd he is addressing (their centroid), not the assembly tile
      const crowd = gatherBodiesLive().filter(b => b.gather && b.gather.role === 'audience');
      if (crowd.length) {
        let sx = 0, sy = 0; for (const b of crowd) { sx += b.px; sy += b.py; }
        self.dir = dirToward(self.px, self.py, sx / crowd.length, sy / crowd.length);
      }
      if (gathering && gathering.phase === 'hold') gatherSpeak(self, now);
    } else {
      const over = bodyForAgent(gathering ? gathering.overseerId : null);
      if (over) self.dir = dirToward(self.px, self.py, over.px, over.py);   // every face turned to him
    }
  }

  /* ================= TIER D · D4 — THE CURSOR IS A CREATURE (mimic + THE CHASE) =================
     Both beats build on the EXISTING Commander-presence stack (lastCursor + cursorMoveT) — NO second cursor
     tracker. They ride the goal/hold machinery ('mimic'/'chase'), not a new state family, so summon-seize,
     chat-focus, and social exclusion all compose. Cursor freshness = lastCursor.t within 8s; cursor MOVING =
     cursorMoveT within 1.5s (real displacement, not mere presence). All U.* + cursor input only (G6). */
  const CURSOR_FRESH_MS = 8000;           // shared freshness window (matches ambientGazeDir / THE LOOK-UP)
  const CURSOR_MOVING_MS = 1500;          // "actively moving" = a real displacement stamped within this window

  // eligible to be pulled into a D4 cursor beat right now? idle, placed, not chat-focused, not already in a
  // social/mimic/chase hold. Reuses bodyIsIdle (excludes tasked/walking/mid-goal). Read-only.
  function cursorBeatEligible(b, now) {
    if (!b || b.unplaced || b.social || b.chase) return false;
    if (b.goal != null) return false;                              // any held goal suppresses it (never yank a deliberate beat)
    if (chatHot(now) && b === chatFocusBody()) return false;       // chat-stare exclusion (D1): HOT focus only — a cold-focused body may mimic/chase (it's living its life)
    return bodyIsIdle(b, now);
  }

  /* ---- BEAT 2 — CURSOR-MIMIC (head-only follow; rare, quirk-band) ----
     An IDLE body TRACKS the moving cursor with continuously-updated FACING for 3-6s (a follow, not one glance),
     then snaps away and resumes. No movement — facing only (rides self.goal='mimic', stepped every tick). Cursor
     must be fresh at start AND stay fresh (stale mid-beat → end early). Per-body cooldown in the quirk band
     (45-90s); consults + arms the D2 station gate (crewBeatDamp/armBeat) so it shares the calm budget. reduceMotion
     → degrade to a single glance. Selected from decideIdle at the idle cadence (self = the deciding body). */
  const MIMIC_MIN_MS = 3000, MIMIC_MAX_MS = 6000;
  const MIMIC_CD_MIN = 45000, MIMIC_CD_MAX = 90000;   // quirk-cooldown band (per-body)
  const MIMIC_SEL_ROLL = 0.03;                        // rare (a quirk-band beat), only rolled when cursor is fresh + body eligible
  function maybeMimic(now) {
    if (!cursorBeatEligible(self, now)) return false;
    if (now < (self.mimicCd || 0)) return false;                  // per-body quirk-band cooldown
    if ((now - lastCursor.t) >= CURSOR_FRESH_MS) return false;    // cursor must be fresh at START
    if (crewBeatDamp(now) === 0) return false;                    // G5: station calm budget (no-op for hero)
    if (reduceMotion()) {                                          // reduceMotion: degrade the follow to ONE glance toward you
      const dir = dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
      setGlance(dir === 'north' ? 'south' : dir, U.irnd(600, 1000), now);
      self.mimicCd = now + U.irnd(MIMIC_CD_MIN, MIMIC_CD_MAX);
      armBeat(now);
      return true;
    }
    if (!U.chance(MIMIC_SEL_ROLL)) { self.mimicCd = now + U.irnd(8000, 16000); return false; }   // miss → short re-scan gap (no per-tick re-roll storm)
    self.goal = 'mimic'; self.stilling = false; self.usingProp = null; self.sitting = false; self.state = 'idle';
    self.mimic = { until: now + U.irnd(MIMIC_MIN_MS, MIMIC_MAX_MS) };
    self.mimicCd = now + U.irnd(MIMIC_CD_MIN, MIMIC_CD_MAX);
    self.trackUntil = 0; self.glance = null;                      // attention is on YOU — drop any in-flight box-track / head-turn
    armBeat(now);                                                 // a noticeable beat — count it against the station budget (G5)
    stepMimic(now);                                               // face you THIS tick (no one-frame lag)
    return true;
  }
  // per-tick stepper for goal==='mimic': keep facing the cursor while it's fresh; end (snap away) on time or staleness.
  function stepMimic(now) {
    const pl = self.mimic; if (!pl) { if (self.goal === 'mimic') { self.goal = null; self.state = 'idle'; } return; }
    const stale = (now - lastCursor.t) >= CURSOR_FRESH_MS;
    if (now >= pl.until || stale) { endMimic(now, !stale); return; }   // time up (snap away) or cursor gone (just release)
    let dir = dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
    if (dir === 'north') dir = 'south';                           // never turn its back on you — the face is the point (mirrors THE LOOK-UP)
    self.dir = dir; self.state = 'idle';
  }
  // end the mimic: on a natural time-up, SNAP AWAY to a cardinal that isn't the cursor (the "it looked, then
  // dismissed you" beat); on a stale-cursor end, just release. Clears the plan + goal → idle.
  function endMimic(now, snap) {
    const pl = self.mimic; self.mimic = null;
    if (snap && pl) { const away = U.pick(['east', 'west', 'north']); self.dir = away; setGlance(away, U.irnd(400, 800), now); }
    if (self.goal === 'mimic') { self.goal = null; self.state = 'idle'; self.idleUntil = now + U.irnd(600, 1400); }
  }

  /* ---- BEAT 3 — THE CHASE (the headline; ultra-rare) ----
     An idle body breaks toward the cursor and PURSUES it (repathing ~1/s so it lags like a real pursuer) for
     3-6s, then STOPS and stares at where the cursor was (2-4s), then walks off as if nothing happened. Rarity
     is sacred: a LONG station cooldown (8-15 min), one chaser EVER (chaseId), mutually exclusive with a live
     social beat (socialBeat), only considered when the D2 gate is open + cursor fresh AND actively MOVING. If
     the cursor leaves the chaser's zone mid-chase → halt at the clamped boundary tile and stare across the
     border, then release. reduceMotion → no chase (degrade to the mimic's single glance). */
  const CHASE_MIN_MS = 3000, CHASE_MAX_MS = 6000;         // pursuit duration (hard cap)
  const CHASE_STARE_MIN = 2000, CHASE_STARE_MAX = 4000;   // the held stare at where the cursor was
  const CHASE_HARD_MS = 15000;                            // absolute whole-beat timeout (belt-and-suspenders)
  const CHASE_REPATH_MS = 1000;                           // low repath cadence → it LAGS the cursor (a real pursuer)
  const CHASE_GATE_MIN = 480000, CHASE_GATE_MAX = 900000; // 8-15 min station cooldown between chases (RARITY IS SACRED)
  // roll THE CHASE. Selected from decideIdle at the idle cadence with self = the deciding idle body. Returns true
  // iff a chase was armed (⇒ decideIdle stops). Most sessions return false forever — that is correct.
  function maybeChase(now) {
    if (reduceMotion()) return false;                            // reduceMotion → no chase (mimic already gave a single glance)
    if (chaseId != null) return false;                          // one chaser EVER (station-level)
    if (socialBeat) return false;                              // mutually exclusive with a live social beat (one noticeable thing at a time)
    if (now < chaseGateUntil) return false;                    // LONG station cooldown — the rarity backbone
    if (crewBeatDamp(now) === 0) return false;                 // only when the D2 station gate is open (G5)
    if (!cursorBeatEligible(self, now)) return false;          // idle, placed, goal==null, not chat-focused, not already in a beat
    if ((now - lastCursor.t) >= CURSOR_FRESH_MS) return false; // cursor must be FRESH
    if ((now - cursorMoveT) >= CURSOR_MOVING_MS) return false; // AND actively MOVING (recent real displacement, not mere presence)
    // arm the chase. Draw the LONG station cooldown NOW (from chase start) so nothing re-rolls for minutes.
    chaseId = self.id; chaseGateUntil = now + U.irnd(CHASE_GATE_MIN, CHASE_GATE_MAX);
    self.goal = 'chase'; self.stilling = false; self.usingProp = null; self.sitting = false; self.state = 'idle';
    self.chase = { phase: 'pursue', endAt: now + U.irnd(CHASE_MIN_MS, CHASE_MAX_MS), hardUntil: now + CHASE_HARD_MS, repathAt: now, faceX: lastCursor.wx, faceY: lastCursor.wy, border: false };
    self.trackUntil = 0; self.glance = null;
    armBeat(now);                                               // a noticeable beat (G5)
    return true;
  }
  // per-tick stepper for goal==='chase'. Repaths toward the cursor's CURRENT tile at a low cadence (re-clamping
  // to the chaser's zone EVERY repath — the cursor moves, so a one-time clamp isn't enough), then STOP + stare.
  function stepChase(now) {
    const pl = self.chase; if (!pl) { if (self.goal === 'chase') { self.goal = null; self.state = 'idle'; } return; }
    if (now >= pl.hardUntil) { endChase(now); return; }                         // absolute cap — always frees
    const stale = (now - lastCursor.t) >= CURSOR_FRESH_MS;
    if (pl.phase === 'pursue') {
      if (stale) { pl.phase = 'stare'; pl.until = now + U.irnd(CHASE_STARE_MIN, CHASE_STARE_MAX); self.pathPts = null; self.target = null; self.state = 'idle'; return; }   // cursor gone → immediate stop + stare (at its last spot)
      if (now >= pl.endAt) { pl.phase = 'stare'; pl.until = now + U.irnd(CHASE_STARE_MIN, CHASE_STARE_MAX); pl.faceX = lastCursor.wx; pl.faceY = lastCursor.wy; self.pathPts = null; self.target = null; self.state = 'idle'; return; }   // pursuit done → stop + stare at where you were
      if (self.state === 'walk' || self.target) return;                          // still walking a leg — let the walk machinery advance it
      if (now < pl.repathAt) { self.state = 'idle'; return; }                     // between repaths → stand a beat (lags the cursor)
      pl.repathAt = now + CHASE_REPATH_MS;
      const zone = zoneFor(self);
      const cur = tileOf(self.px, self.py);
      const ct = tileOf(lastCursor.wx, lastCursor.wy);                            // the cursor's CURRENT world tile
      pl.faceX = lastCursor.wx; pl.faceY = lastCursor.wy;                         // remember the live cursor spot for the eventual stare
      if (tileInZone(zone, ct.x, ct.y) && geo.walkable(ct.x, ct.y, blocked)) {
        pl.border = false;
        if (!(cur.x === ct.x && cur.y === ct.y)) setPathTo({ x: ct.x, y: ct.y }); // in-zone → chase the real tile
      } else {
        // cursor is OUTSIDE the chaser's zone → clamp to the nearest in-zone walkable tile toward it (the border),
        // then STOP there and stare out across the boundary (the containment beat again).
        const clamp = nearestWalkableInZone(zone, ct.x, ct.y, cur, 6);
        if (clamp && !(cur.x === clamp.x && cur.y === clamp.y)) { pl.border = true; pl.borderTx = clamp.x; pl.borderTy = clamp.y; setPathTo({ x: clamp.x, y: clamp.y }); }
        else { pl.phase = 'stare'; pl.until = now + U.irnd(CHASE_STARE_MIN, CHASE_STARE_MAX); self.pathPts = null; self.target = null; self.state = 'idle'; }   // already at the boundary → stare out now
      }
      return;
    }
    // phase 'stare': stand at where it stopped, face where the cursor was (or its actual position for a border
    // stare — face toward the real cursor across the line), hold, then release to normal idle.
    self.state = 'idle'; self.sitting = false;
    self.dir = dirToward(self.px, self.py, pl.faceX, pl.faceY);
    if (now >= (pl.until || 0)) endChase(now);
  }
  // free THE CHASE: clear the station chaser lock + this body's plan/goal → idle. Idempotent. The long station
  // cooldown was drawn at chase START (maybeChase), so endChase does NOT re-draw it.
  function endChase(now) {
    if (chaseId != null && self && self.id === chaseId) chaseId = null;
    if (self) { self.chase = null; if (self.goal === 'chase') { self.goal = null; self.state = 'idle'; self.pathPts = null; self.target = null; self.idleUntil = now + U.irnd(800, 1800); } }
  }
  // STATION-LEVEL CHASE SWEEP (mirrors the social slot sweep) — run every tick from the hero tick(), independent
  // of the chaser's own stepper, so a summoned / despawned / chat-focused chaser ALWAYS frees the lock same-tick.
  // Reads only; the actual clear happens by re-pointing self to the chaser (endChaseFor) so the plan is torn down.
  function sweepChase(now) {
    if (chaseId == null) return;
    const c = bodyForAgent(chaseId);
    let broken = false;
    if (!c || c.unplaced) broken = true;                                          // despawned
    else if (c.goal !== 'chase' || !c.chase) broken = true;                       // plan cleared out from under us
    else if (c.working) broken = true;                                            // crew run seized it
    else if (c === agent && activity === 'task') broken = true;                   // hero got summoned
    else if (chatHot(now) && c === chatFocusBody()) broken = true;                // pulled into a LIVE (hot) chat-stare — a warm re-engage mid-chase seizes attention; a cold focus does NOT break the chase (the body is living its life)
    if (!broken) return;
    // tear the chaser's plan down on the correct body (endChase mutates `self`); restore self after.
    const keep = self; self = c || agent; endChase(now); self = keep;
    if (!c || c.unplaced) chaseId = null;                                          // despawn: force-clear the lock even if the body is gone
  }

  // CURSOR GAZE-DRIFT: a slice of the ambient idle glances drift toward the Commander's cursor — the quiet
  // Petz "it knows where you are". RETUNED 2026-07-02 (design call: "not constantly following the mouse, only so
  // often"): at the old shares (hero 0.32 / crew 0.15) an actively-moving cursor stayed fresh continuously, so
  // roughly a third of ALL ambient glances (which re-fire every ~4-11s) pointed at the mouse — it read as
  // tracking, not noticing. Now a cursor-directed ambient glance is (a) rarer per roll (0.12 / 0.06) and
  // (b) throttled by a per-body cooldown (one cursor glance per ~20-45s at most), so even under constant mousing
  // it's an occasional flick of attention. The deliberate follow moments stay where they belong: the rare D4
  // cursor-mimic beat and the HOT chat-stare (both separately gated).
  function ambientGazeDir(now) {
    // Crew keep a smaller share than the hero (the hero stays the most Commander-attuned). This is the ONLY
    // spot crew ambient facing is randomized (via lookAround/standStill), so it never fights a held goal, a
    // glance, a chat-stare, or work facing (those don't route through here). Ambient TEXTURE, not a noticeable
    // beat → NOT gated by the D2 station budget (G5). cursorGazeCd is undefined on fresh bodies → `|| 0` = ready.
    const drift = self === agent ? 0.12 : 0.06;
    if ((now - lastCursor.t) < 8000 && now >= (self.cursorGazeCd || 0) && U.chance(drift)) {
      self.cursorGazeCd = now + U.irnd(20000, 45000);
      return dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
    }
    return lookDir(self);   // LOOK AT SOMETHING (see lookDirFrom) — never a blind cardinal into a wall
  }

  /* ================= SUBJECT-FACING (2026-08-08 idle-life pass) =================
     THE DEFECT: every ambient facing in this engine was `U.pick(['east','west','south','north'])`
     — a blind cardinal. In a walled station with no windows, roughly half of those point the body
     at bare wall a tile from its nose, and the "eerie contemplation" beats (gaze-out at the room
     EDGE facing OUTWARD, face-a-wall, the vigil) pointed at wall BY CONSTRUCTION. Andrew's read
     was the correct one: it isn't contemplative, it's a character with nothing to look at.

     THE RULE: a body may hold any pose it likes, but it must be looking AT something. lookDirFrom
     ray-marches each cardinal from a stand tile and scores what the line of sight actually
     contains — depth of open floor, a prop the ray runs into, a conveyor belt, another body, a
     doorway through to the next room. A direction whose very first tile is wall scores ~zero and
     effectively never wins. The winner is drawn WEIGHTED-random from the scores, so the choice
     stays unpredictable (the engine's whole character) while never being blind.

     Pure-ish: reads geo + bodies, mutates nothing, draws one U.rnd. Degrades to the old blind pick
     when geo is missing, so a boot-order gap can never freeze a body's head. */
  const LOOK_REACH = 10;                       // how far down a line of sight we care to look (tiles)
  const LOOK_DIRS = [['north', 0, -1], ['south', 0, 1], ['east', 1, 0], ['west', -1, 0]];
  // the prop occupying a tile, or null (props are blockers, so this answers "did my line of sight
  // stop at a THING or at bare wall" — the whole distinction this pass turns on)
  function propAtTile(tx, ty) {
    const props = (geo && geo.props) || [];
    for (const p of props) {
      const w = p.w || 1, h = p.h || 1;
      if (tx >= p.x && tx < p.x + w && ty >= p.y && ty < p.y + h) return p;
    }
    return null;
  }
  function beltAtTile(tx, ty) {
    const belts = (geo && geo.belts) || [];
    for (const b of belts) if (b.x === tx && b.y === ty) return b;
    return null;
  }
  function bodyAtTile(tx, ty, except) {
    for (const b of allBodies()) {
      if (!b || b === except || b.unplaced) continue;
      const t = tileOf(b.px, b.py);
      if (t.x === tx && t.y === ty) return b;
    }
    return null;
  }
  /* score one cardinal from (tx,ty): how much is there to see this way?
     A wall at range 1 scores 0.15 (never quite impossible — a body CAN turn to a wall, it just
     stops being the default), and every subject found along the ray adds, discounted by distance
     so the near thing wins over the far one. */
  function lookScore(tx, ty, dx, dy, except) {
    let score = 0, x = tx, y = ty;
    for (let d = 1; d <= LOOK_REACH; d++) {
      x += dx; y += dy;
      const walk = geo.walkable(x, y, blocked);
      const near = 1 / (1 + d * 0.35);                       // near things dominate far ones
      const body = bodyAtTile(x, y, except);
      if (body) score += 4.0 * near;                          // ANOTHER AGENT is the best thing to look at
      if (beltAtTile(x, y)) score += 2.2 * near;              // cargo moving past
      if (!walk) {
        const p = propAtTile(x, y);
        if (p) score += 2.6 * near;                           // the ray ran into a THING — that's a subject
        else if (d === 1) return 0.15;                        // bare wall right at the nose — the defect this pass exists to kill
        else score += 0.15;                                   // bare wall further off: the room simply ends here
        return score + Math.min(d, 6) * 0.28;                 // + credit for the open floor it looked across
      }
      score += 0.28;                                          // open floor: depth is itself worth looking down
      if (geo.doorDefs && isDoorTile(x, y)) score += 2.4 * near;   // a threshold — looking THROUGH to the next room
    }
    return score;
  }
  // is this tile part of a threshold (a doorway between two zones)? doorDefs are [x1,y1,x2,y2] seam pairs.
  function isDoorTile(tx, ty) {
    const defs = (geo && geo.doorDefs) || [];
    for (const d of defs) if ((d[0] === tx && d[1] === ty) || (d[2] === tx && d[3] === ty)) return true;
    return false;
  }
  /* the facing to adopt from a stand tile: weighted-random over the four scored cardinals.
     opts.exclude — a direction to leave out (e.g. don't just look back the way you came).
     opts.away    — bias AWAY from the Commander (the 'ponder'/'turn your back' flavor) by halving
                    the south score, WITHOUT ever letting the body pick a wall instead. */
  function lookDirFrom(tx, ty, opts) {
    opts = opts || {};
    if (!geo || typeof geo.walkable !== 'function') return U.pick(['east', 'west', 'south', 'north']);
    const scored = [];
    let total = 0;
    for (const [dir, dx, dy] of LOOK_DIRS) {
      if (opts.exclude === dir) continue;
      let s = lookScore(tx, ty, dx, dy, opts.except || null);
      if (opts.away && dir === 'south') s *= 0.35;
      scored.push({ dir, s }); total += s;
    }
    if (!scored.length || total <= 0) return U.pick(['east', 'west', 'south', 'north']);
    let roll = U.rnd(0, total);
    for (const c of scored) { roll -= c.s; if (roll <= 0) return c.dir; }
    return scored[scored.length - 1].dir;
  }
  /* WHAT IS ACTUALLY IN FRONT OF A BODY — one tile ahead of its live facing:
     'body' | 'belt' | 'open' | 'prop' | 'wall'. This is the metric the whole W1 pass turns on, so
     it is exposed read-only through bodies() and measured in a live soak: an idle body reading
     'wall' is a body with its nose against the plaster, which is the thing we removed. */
  function subjectAt(b, x, y) {
    if (bodyAtTile(x, y, b)) return 'body';
    if (beltAtTile(x, y)) return 'belt';
    if (geo.walkable(x, y, blocked)) return 'open';
    return propAtTile(x, y) ? 'prop' : 'wall';
  }
  function facingDetail(b) {
    if (!geo || !b || typeof geo.walkable !== 'function') return null;
    const t = tileOf(bodyPosX(b), bodyPosY(b));
    const d = (b.glance && b.glance.until > fnow) ? b.glance.dir : (b.dir || 'south');
    const v = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[d] || [0, 1];
    const x = t.x + v[0], y = t.y + v[1];
    return { subject: subjectAt(b, x, y), prop: propAtTile(x, y), tile: { x, y } };
  }
  /* THE CONTROL for that metric: how many of the FOUR cardinals from where this body stands are
     bare wall. A blind `U.pick` of a cardinal — which is exactly what this engine used to do — would
     face wall at wallDirs/4. Sampled alongside `facing`, it gives the soak an in-sample baseline to
     compare the real facing rate against, instead of an unfalsifiable "looks better now". */
  function wallDirsAt(b) {
    if (!geo || !b || typeof geo.walkable !== 'function') return null;
    const t = tileOf(bodyPosX(b), bodyPosY(b));
    let n = 0;
    for (const [, dx, dy] of LOOK_DIRS) if (subjectAt(b, t.x + dx, t.y + dy) === 'wall') n++;
    return n;
  }
  // shorthand: what should THIS body be looking at from where it stands
  function lookDir(body, opts) {
    const b = body || self;
    if (!b) return 'south';
    const t = tileOf(bodyPosX(b), bodyPosY(b));
    return lookDirFrom(t.x, t.y, Object.assign({ except: b }, opts || {}));
  }

  // go inspect the freshest queued placement (pops the queue; tries each until one is reachable)
  function planInspect(now) {
    const zone = zoneFor(self);   // P1: never walk OUT of the zone to inspect (defensive even though the queue is zone-filtered at enqueue)
    while (novelty.length) {
      const n = novelty.pop();
      let foot = { x: n.tx, y: n.ty, w: 1, h: 1 };
      if (n.kind === 'prop' && n.pid && geo.props) { const p = geo.props.find(q => q.id === n.pid); if (!p || !mayTouchProp(self.id, p) || (!purposefulIdleProp(p) && !(isWorkstationProp(p.t) && p.agentId === self.id))) continue; foot = p; }
      const extra = n.kind === 'belt' ? beltUnion() : blocked;   // for a belt, stand beside it — not on the machinery
      const a = PropAnchor.deriveAnchor(foot, geo, { approach: 'auto', extra });
      if (a && tileInZone(zone, a.tx, a.ty) && setPathTo({ x: a.tx, y: a.ty })) {
        self.goal = 'inspect'; self.useFace = a.face; self.usingProp = null; self.inspectNovel = true;
        self.studyKey = n.kind === 'belt' ? ('belt:' + n.tx + ',' + n.ty) : n.pid;
        if (!self.target) arrive(now);
        return true;
      }
    }
    return false;
  }

  // ambient curiosity (no fresh placement): study a machine or watch a belt go by
  function planPOI(now) {
    const zone = zoneFor(self);   // P1: study/watch only kit reachable inside the zone
    const cands = [];
    const belts = (geo && geo.belts) || [];
    // pick a belt tile that is itself in-zone (the body stands BESIDE it, but an in-zone belt keeps the approach in-zone).
    // BOUNDED (see THE CONVEYOR IS NOT A SPECTATOR SPORT, top of file): only if this body is off its own
    // belt cooldown AND nobody else currently holds the station's single watcher claim. Both checks are
    // reads — the claim/cooldown are ARMED below, only once a watch actually commits.
    const beltOk = now >= (self.beltWatchCd || 0) && !beltWatchTaken(now);
    const inBelts = beltOk ? belts.filter(b => tileInZone(zone, b.x, b.y)) : [];
    if (inBelts.length) { const b = inBelts[U.irnd(0, inBelts.length - 1)]; cands.push({ kind: 'watch', key: 'belt:' + b.x + ',' + b.y, foot: { x: b.x, y: b.y, w: 1, h: 1 }, extra: beltUnion() }); }
    const props = (geo && geo.props) || [];
    // A deliberate prop study means checking THIS body's assigned workstation. Decorative blockers are
    // scenery, not "machines" to walk over and stare at; leisure is handled by planPlay/planProp.
    const machines = props.filter(p => isWorkstationProp(p.t) && p.agentId === self.id && (seenCount.get(p.id) || 0) < 4 && tileInZone(zone, p.x, p.y));
    if (machines.length) { const p = machines[U.irnd(0, machines.length - 1)]; cands.push({ kind: 'inspect', key: p.id, foot: p, extra: blocked }); }
    if (cands.length === 2 && U.chance(0.5)) cands.reverse();
    for (const c of cands) {
      const a = PropAnchor.deriveAnchor(c.foot, geo, { approach: 'auto', extra: c.extra });
      if (a && tileInZone(zone, a.tx, a.ty) && setPathTo({ x: a.tx, y: a.ty })) {
        self.goal = c.kind; self.useFace = a.face; self.usingProp = null; self.inspectNovel = false; self.studyKey = c.key;
        // a belt watch COMMITTED: take the station's single watcher claim and arm this body's own cooldown.
        // `until` only has to outlast walk + the longest watch dwell (arrive() caps it at ~14s) — it exists
        // so an abandoned claim expires on its own rather than needing a release call on every exit path.
        if (c.kind === 'watch') { beltWatch = { body: self, until: now + 45000 }; self.beltWatchCd = now + U.irnd(BELT_WATCH_CD_MIN, BELT_WATCH_CD_MAX); }
        if (!self.target) arrive(now);
        return true;
      }
    }
    return false;
  }

  // pan the gaze around without moving — "taking the place in"
  function lookAround(now) {
    const dir = ambientGazeDir(now);
    setGlance(dir, U.irnd(600, 1100), now); self.dir = dir;
    self.idleUntil = now + U.irnd(2200, 4200);
    if (U.chance(0.15)) curiositySay(CURIO_LOOK, 1, now);
  }
  // CONTENT = STILL: the calm default — just be here, holding the facing, genuinely motionless for a long beat.
  // maybeGlance's `stilling` early-out suppresses the ambient swivel AND the cargo body-track, so it's true stillness.
  function standStill(now) {
    self.goal = null; self.stilling = true; self.usingProp = null; self.state = 'idle';
    self.glance = null; self.trackUntil = 0;   // drop any in-flight head-turn / box-track so nothing bleeds into the hold
    self.idleUntil = now + offbeat(now, U.irnd(4500, 9000));
  }
  /* TIER D · D1 ATTENTIVE AUDIENCE — the chat-stare hold. While the Commander has COMMS focus on THIS body
     (self === chatFocusBody()) and the body is genuinely idle, it drops its wander/quirk/social life, stands
     genuinely still (reusing the CONTENT=STILL `stilling` machinery — same as standStill), and HOLDS its
     attention on the Commander: facing south, drifting toward lastCursor while the cursor is fresh (<8s) so it
     tracks you around the screen. ONE tracker — reuses the existing dirToward(→lastCursor) pattern, no second
     cursor sampler. Called TWO ways: (a) as an early-out from decideIdle so the body never CHOOSES to wander
     while held, and (b) every tick as a HOLD from the hero tick / crewEngineStep idle branch so the facing keeps
     tracking the cursor between idle decisions (crew have no maybeGlance, so the hold drives facing directly).
     Returns true when it took/holds the body. G2: reachable ONLY while free (never while activity==='task' /
     working / walking / mid-goal) — it sits BELOW the summon-seize, which the callers gate for us. */
  /* CHAT-STARE-TRACK-PURE-BEGIN — the chat-stare follow-beat throttle, extracted PURE (params + injected rnd
     only; no module state / RNG / DOM) so its cadence is unit-testable headlessly. WHY headless: the game tick is
     rAF-driven and a backgrounded CDP/preview tab freezes rAF to 0fps, so "mostly faces the Commander, only rarely
     follows the cursor" cannot be observed live — test/chat-stare-throttle.test.js extracts THIS marked block from
     source and executes it (same spirit as the D3-PURE-GEOMETRY block). Decides the chat-stare facing SOURCE —
     'commander' (face south, at the Commander) vs 'cursor' (turn to the live cursor) — and advances the per-body
     follow schedule on `b`: b.chatTrackCd = earliest time the next follow beat may open; b.chatTrackUntil = end of
     the currently-open beat. `fresh` = cursor seen within the freshness window; `reduce` = reduceMotion. rnd(lo,hi)
     is injected (U.irnd in prod) so the block carries no RNG token and stays deterministic-lint clean. */
  function chatStareTrack(b, now, fresh, reduce, rnd) {
    if (reduce) return 'commander';                                              // motion-sensitive: hold the gaze on the Commander, never chase the cursor
    if (b.chatTrackCd == null) { b.chatTrackCd = now + rnd(8000, 20000); return 'commander'; }   // first beat is delayed too — don't pounce on the cursor the instant COMMS warms
    if (fresh && now < (b.chatTrackUntil || 0)) return 'cursor';                 // mid-beat: keep following the live cursor for this short window
    if (fresh && now >= b.chatTrackCd) {                                         // cooldown elapsed + a fresh cursor → open a brief follow beat...
      b.chatTrackUntil = now + rnd(1200, 2500);
      b.chatTrackCd = b.chatTrackUntil + rnd(16000, 34000);                      // ...then a long cooldown before it may follow the cursor again
      return 'cursor';
    }
    return 'commander';                                                          // the steady state: attention on the Commander, not the mouse
  }
  /* CHAT-STARE-TRACK-PURE-END */
  function chatStareHold(now) {
    if (!self || !chatHot(now) || self !== chatFocusBody()) return false; // not the HOT-focused body → normal life. chatHot = focus set + warm (the ONE shared predicate — same definition the socialEligible/cursorBeatEligible exclusions, encounterBroken, and sweepChase key on). Cold → stop holding; the body falls to normal idle (decideIdle clears stilling on entry) and its quirks/social/mimic/chase/wander ALL resume (the exclusions key on hot too)
    if (self === agent && activity !== 'idle') return false;            // G2: working-at-desk (task) wins; and a live VOICE conversation ('talk') keeps its own listening-glances (maybeGlance) — the stare is an IDLE beat only
    if (self.working || self.unplaced) return false;                    // a live run owns the body (crew) — never stare mid-work
    if (self.state === 'walk' || self.target) return false;             // let an in-flight walk finish before holding
    if (self.goal != null && self.goal !== 'stare-chat') return false;  // don't yank it out of a deliberate goal (leisure/inspect/etc.) — it'll fall to the hold on its NEXT free decision
    // hold: genuine stillness + attention on the Commander (reuse the stilling latch so maybeGlance's stilling
    // branch and the cargo body-track stay suppressed for the hero; crew facing is driven directly below).
    self.goal = 'stare-chat'; self.stilling = true; self.usingProp = null; self.state = 'idle'; self.sitting = false;
    self.trackUntil = 0;                                                 // drop any in-flight box-track — attention is on YOU, not cargo
    // ATTENTION, NOT TRACKING (2026-07-08): the warm hold is a STEADY gaze at the Commander (south = facing YOU),
    // punctuated by the RARE cursor-follow beat — never continuous mouse-tracking. Before, any fresh cursor pointed
    // the body at it on EVERY 400ms re-affirm (and the hero re-affirms EVERY tick), so an actively-moving mouse made
    // the focused body follow the cursor for the whole 30–90s warm window, re-warmed on every message — the "it
    // follows the mouse every single time I talk to it" complaint. chatStareTrack now throttles that to a brief
    // beat (~1.2–2.5s) behind a per-body cooldown (~16–34s): under constant mousing it's an occasional flick, per
    // the gaze-drift design call ("not constantly following the mouse, only so often"). Time-based (no per-tick
    // dice), so the hero's every-tick cadence and the crew's ~400ms cadence land in the same rhythm.
    const fresh = (now - lastCursor.t) < 8000;
    const face = chatStareTrack(self, now, fresh, reduceMotion(), U.irnd);   // 'commander' (south, at YOU) vs a rare 'cursor' follow beat; advances self.chatTrackCd / self.chatTrackUntil
    self.dir = face === 'cursor' ? dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy) : 'south';
    if (self.dir === 'north') self.dir = 'south';                       // never turn its back on the Commander — the face is the point (mirrors THE LOOK-UP)
    self.glance = null;                                                 // the whole body faces you; no lingering head-turn bleeding through
    self.idleUntil = now + 400;                                         // re-affirm the hold soon so the cursor beat stays live (cheap; no motion)
    return true;
  }
  // OFF-BEAT HOLD: rarely (and on its own long cooldown) stretch a single dwell to ~2.2x-3.0x — a learned rhythm that
  // suddenly refuses to end. Skipped under reduceMotion so motion-sensitive users keep the normal cadence.
  function offbeat(now, ms) {
    if (reduceMotion()) return ms;
    // J2: per-body off-beat gate — a crew dwell-stretch must NOT throttle hero/siblings (was the shared module global).
    // D2 (G5): a CREW roll is also hard-gated by the station budget (no-op for the hero); a fire arms the station gate.
    if (now >= (self.offbeatCd || 0) && U.chance(0.09 * crewBeatDamp(now))) { self.offbeatCd = now + U.irnd(70000, 140000); armBeat(now); return Math.round(ms * (220 + U.irnd(0, 80)) / 100); }
    return ms;
  }
  /* FIRST LIGHT — the newborn's first autonomous act: hold the gaze, take one slow look at the room it now
     owns, then a single dry first thought, then it just gets on with existing. Driven by studyUntil; every
     phase finite; terminates in goal=null -> decideIdle. maybeGlance is hard-gated off so the sweep is the
     ONLY head motion, and a summon seizes it (the seize block runs before this branch in the tick ladder). */
  function stepFirstWake(now) {
    if (now < agent.studyUntil) return;
    if (agent.wakePhase === 0) {
      if (U.chance(0.15)) {   // rare "finding its feet": one bounded step to an adjacent walkable tile (may no-op)
        const c = tileOf(agent.px, agent.py);
        for (const [ax, ay] of SEAT_NB) { if (geo.walkable(c.x + ax, c.y + ay, blocked)) { setPathTo({ x: c.x + ax, y: c.y + ay }); break; } }
      }
      agent.wakePhase = 1; agent.studyUntil = now + U.irnd(700, 1100); setGlance(U.pick(['east', 'west']), U.irnd(700, 1100), now); return;
    }
    if (agent.wakePhase === 1) { agent.wakePhase = 2; agent.studyUntil = now + U.irnd(700, 1100); setGlance(U.pick(['west', 'east', 'north']), U.irnd(700, 1100), now); return; }
    if (agent.wakePhase === 2) { agent.wakePhase = 3; agent.dir = 'south'; setGlance('south', U.irnd(600, 1000), now); agent.studyUntil = now + U.irnd(500, 800); return; }
    // phase 3: settle, then the one first thought, then dissolve into ordinary life (seeding the birth tile as its first haunt)
    sayFirstThought(now); noteFond(now, 1.2);
    agent.goal = null; agent.quirkKind = null; agent.wakePhase = 0; agent.state = 'idle'; agent.idleUntil = now + U.irnd(800, 1600);
  }
  // FIRST LIGHT is SILENT by design — the newborn takes in the room and says NOTHING out loud. The
  // look-around sweep (wakePhases above) carries the beat; silence is eerier and honours "no idle one-liners".
  function sayFirstThought() { /* no spoken wake line — removed */ }

  /* ---------- inner life: needs + temperament decide WHICH goal it pursues ---------- */
  // the desk-seat tile of the CURRENT body (self): the hero falls back to its synthetic module `seat`; a crew body
  // resolves its OWN assigned workstation's chair (deskSeat(deskPropFor(self.id))) — never the hero's seat, so the
  // social-refill tether (nearDesk) + the lonely planner (planSeekDesk) measure/path to each body's own desk (J2/J3).
  // null when the body has no desk (a deskless crew body simply never gets the desk-proximity social refill).
  function seatFor(body) {
    if (body === agent) return seat;
    const dp = body && deskPropFor(body.id);
    return dp ? deskSeat(dp) : null;
  }
  // is the agent loitering near its desk (its tether to the Commander)?
  function nearDesk() {
    const s = seatFor(self);
    if (!s) return false;
    const c = tileOf(self.px, self.py);
    return Math.abs(c.x - s.tx) <= 2 && Math.abs(c.y - s.ty) <= 2;
  }
  // three slow meters decay/refill by what the agent is doing; clamped 0..100. O(1), every tick.
  function tickNeeds(dt) {
    const s = dt / 1000, n = self.needs;
    const sitLeisure = self.goal === 'lounge' || (self.goal === 'use' && self.sitting);
    const observing = self.goal === 'inspect' || self.goal === 'watch' || self.goal === 'lounge' || self.goal === 'gaze';
    n.rest = U.clamp(n.rest + (self.working ? -2.1 : sitLeisure ? 3.4 : 0.35) * s, 0, 100);
    n.stim = U.clamp(n.stim + (observing ? 2.6 : self.working ? 0.6 : self.state === 'walk' ? 0.2 : -1.25) * s, 0, 100);
    n.social = U.clamp(n.social + (((self === agent) && (activity === 'task' || activity === 'talk')) ? 2.2 : (self.goal === 'tend' || nearDesk()) ? 1.6 : -0.45) * s, 0, 100);
  }
  // lonely → drift to a tile by the desk and face south (its window to the Commander); refills social
  function planSeekDesk(now) {
    if (now < (self.deskVisitCd || 0)) return false;   // checking in is useful; bouncing back after every other activity is not
    const seat = seatFor(self);   // the CURRENT body's own desk (hero → synthetic `seat`; crew → its workstation chair) — never the hero's seat for a crew body (J2/J3)
    if (!seat) return false;
    const zone = zoneFor(self);   // J3: the desk spots derive from the seat with +2 south / ±1 offsets; clamp them to the body's OWN zone like every sibling picker
    const spots = [[seat.tx, seat.ty + 1], [seat.tx - 1, seat.ty], [seat.tx + 1, seat.ty], [seat.tx, seat.ty]];
    for (const [tx, ty] of spots) {
      if (!tileInZone(zone, tx, ty)) continue;   // J3: never tether OUT of the body's zone (hero whole-floor 'multi' zone admits its own spots → byte-parity)
      if (!geo.walkable(tx, ty, blocked)) continue;
      if (setPathTo({ x: tx, y: ty })) { self.goal = 'tend'; self.useFace = 'south'; self.usingProp = null; self.studyKey = null; self.deskVisitCd = now + U.irnd(60000, 120000); if (!self.target) arrive(now); return true; }
    }
    return false;
  }
  /* After a real stretch of downtime, take one trip beyond the current room when the existing zone
     permits it. This is not free station roaming: zoneFor still limits the destination to the stable
     home/spawn radius, and setPathTo owns the normal collision-safe, reachable walk. */
  function planExplore(now) {
    if (!self || !geo || !geo.allRects || !geo.allRects.length) return false;
    // Spread the first stroll over 45 seconds instead of making every newly-idle body leave at once.
    if (!self.exploreCd) {
      self.exploreCd = now + U.irnd(1, 45000);
      return false;
    }
    if (now < self.exploreCd) return false;
    const cur = tileOf(self.px, self.py), here = roomOfLocalTile(cur.x, cur.y), zone = zoneFor(self);
    if (!here || !zone) return false;
    const rects = geo.allRects.filter(r => {
      const room = roomOfLocalTile((r.x1 + r.x2) >> 1, (r.y1 + r.y2) >> 1);
      return room && room !== here;
    });
    if (!rects.length) return false;
    for (let i = 0; i < 36; i++) {
      const r = rects[U.irnd(0, rects.length - 1)];
      const tx = U.irnd(r.x1, r.x2), ty = U.irnd(r.y1, r.y2);
      if (!tileInZone(zone, tx, ty) || !geo.walkable(tx, ty, blocked)) continue;
      const there = roomOfLocalTile(tx, ty);
      if (!there || there === here) continue;
      if (!setPathTo({ x: tx, y: ty })) continue;
      self.goal = null; self.usingProp = null; self.stilling = false; self.attn = null;
      self.drive = null; self.driveUntil = 0;
      self.exploreCd = now + U.irnd(120000, 210000);
      return true;
    }
    self.exploreCd = now + U.irnd(30000, 60000);   // retry calmly if nearby geometry has no reachable sample this beat
    return false;
  }
  // restless → short back-and-forth hops near the current tile (paces in place instead of strolling far off)
  function pace(now) {
    const cur = tileOf(self.px, self.py), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const zone = zoneFor(self);   // P1: pace in place, but never a hop OUT of the zone
    for (let i = 0; i < 5; i++) {
      const d = dirs[U.irnd(0, 3)], step = U.irnd(1, 2), tx = cur.x + d[0] * step, ty = cur.y + d[1] * step;
      if (tileInZone(zone, tx, ty) && geo.walkable(tx, ty, blocked) && setPathTo({ x: tx, y: ty })) { self.goal = null; curiositySay(SELF_STIM, 0.4, now); return true; }
    }
    return false;
  }
  /* deep downtime → take up a VANTAGE and look out over the station (long quiet dwell).
     WAS planGazeOut: it walked to the outermost EDGE tile of the zone and faced OUTWARD — i.e. it
     walked to a wall and stared at it, which in a windowless station is exactly what it looked
     like. Same beat, same goal ('gaze'), same dwell: the body now walks to a tile with a real LINE
     OF SIGHT (a doorway it can look through, a long open run, a machine, the belt) and faces the
     thing. The contemplation survives; the drywall doesn't. */
  function planVantage(now) {
    if (!geo || !geo.allRects || !geo.allRects.length) return false;
    const zone = zoneFor(self);   // P1: a vantage inside the OWN zone — clamped, exactly as the edge-gaze was
    const cur = tileOf(self.px, self.py);
    const seen = new Set(), cands = [];
    const add = (tx, ty) => {
      const k = tx + ',' + ty;
      if (seen.has(k)) return; seen.add(k);
      if (!tileInZone(zone, tx, ty) || !geo.walkable(tx, ty, blocked)) return;
      if (tx === cur.x && ty === cur.y) return;                  // a vantage you are already standing on is not a walk
      let best = 0, face = 'south';
      for (const [dir, dx, dy] of LOOK_DIRS) { const s = lookScore(tx, ty, dx, dy, self); if (s > best) { best = s; face = dir; } }
      cands.push({ tx, ty, face, s: best });
    };
    // the standing spots BESIDE each threshold — the honest "looking through into the next room"
    for (const d of (geo.doorDefs || [])) { add(d[0], d[1]); add(d[2], d[3]); }
    // plus a sample of open floor, so the vantage isn't always the same doorway
    for (let i = 0; i < 22; i++) {
      const r = geo.allRects[U.irnd(0, geo.allRects.length - 1)];
      add(U.irnd(r.x1, r.x2), U.irnd(r.y1, r.y2));
    }
    if (!cands.length) return false;
    cands.sort((a, b) => b.s - a.s);
    const top = cands.slice(0, 5);                               // the best few, then one at random — a favourite spot, not THE spot
    for (let i = top.length - 1; i > 0; i--) { const j = U.irnd(0, i), t = top[i]; top[i] = top[j]; top[j] = t; }
    for (const c of top) {
      if (setPathTo({ x: c.tx, y: c.ty })) { self.goal = 'gaze'; self.useFace = c.face; self.usingProp = null; self.studyKey = null; if (!self.target) arrive(now); return true; }
    }
    return false;
  }

  /* ---------- rhythm: a free-running mood that re-weights the idle menu over minutes ----------
     Repeated watching reveals structure — it is clearly 'in a different mode' than ten minutes ago.
     Never overrides a summon (decideIdle only runs while idle); just tilts what it gravitates to. */
  const PHASES = [
    { tag: 'focus', rest: 0.8, stim: 0.9, soc: 1.25, restless: 1.25 },   // hovers near the desk, antsy for work
    { tag: 'roam', rest: 0.8, stim: 1.4, soc: 0.9, restless: 1.15 },     // wants to wander + study
    { tag: 'ease', rest: 1.4, stim: 0.85, soc: 1.0, restless: 0.7 },     // gravitates to the couch
    { tag: 'drift', rest: 1.2, stim: 0.7, soc: 0.85, restless: 0.55 },   // sleepy, sparse, long dwells
  ];
  // B3 DISTINCTNESS: the hero keeps the exact original clock (skew 0 → self===agent byte-parity, J1). Crew bodies
  // get a deterministic per-body TIME skew (0..PHASE_MS, from U.hash on the stable id) so their phase TRANSITIONS
  // desync — without it every body flips mood at the same now/210000 boundary (offset-but-lockstep). Now a floor of
  // N agents is in genuinely different modes AND changes mode at different instants — distinct minds, not a swarm (G3).
  const PHASE_MS = 210000;
  function phaseOf(now) {
    if (!self) return PHASES[Math.floor(now / PHASE_MS) % PHASES.length];
    const skew = self === agent ? 0 : (U.hash('ph:' + self.id) % PHASE_MS);   // hero unchanged (J1); crew time-shifted
    return PHASES[(Math.floor((now + skew) / PHASE_MS) + self.phase) % PHASES.length];   // ~3.5 min per phase, offset + skewed per body
  }

  /* ---------- quirks: rare, gated, UNPREDICTABLE one-offs — the off-screen inner life surfacing ----------
     Eerie through stillness + ambiguity (the "why did it just do that"), never spooky one-liners. */
  function maybeQuirk(now) {
    if (now < (self.quirkCd || 0)) return false;   // J2: per-body cooldown — a crew quirk must NOT throttle the hero or siblings (was the shared module global)
    let p = 0.085 * (0.6 + self.pers.restless * 0.4);
    // B3/D2: the hero's probability is UNCHANGED (J1 byte-parity). A CREW body's roll is hard-gated (p*=0) while the
    // station-wide beat gate holds — any noticeable beat anywhere on the floor (a quirk OR a D2-budgeted stroll/
    // off-beat/revisit) armed it — so the floor never beats in unison and the crew's COLLECTIVE rate stays bounded
    // (G3/G5). Not awareness: the body learns nothing about the other; it's a global rarity governor on the dice only.
    p *= crewBeatDamp(now);
    if (!U.chance(p)) return false;
    self.quirkCd = now + U.irnd(45000, 90000);    // quirks stay special — even rarer now, so each lands with weight
    armBeat(now);                                 // D2 (G5): arm the floor-wide governor — a quirk is a noticeable beat, so it also damps the NEXT crew quirk AND the station's stroll/off-beat/revisit budget (subsumes the old per-quirk lastQuirkAt)
    const r = U.irnd(0, 999);
    if (r < 320) return quirkListen(now);    // 32% — freeze + snap toward a sound only it heard
    if (r < 520) return quirkScan(now);      // 20% — one slow, deliberate subject-facing look
    if (r < 680) return quirkPonder(now);    // 16% — stops, faces away, lost in thought
    if (r < 790) return planVantage(now);    // 11% — drifts to a vantage and looks out over the station
    if (r < 870) return quirkDoorway(now) || quirkScan(now);  //  8% — stands in a doorway looking through; no threshold falls back to one calm look
    if (r < 945 && quirkVigil(now)) return true;   // ~7.5% — the VIGIL: dead-center, faces one wall, holds (falls through to the stare if no center is free)
    return quirkStare(now);                  // ~5.5% — the long stare straight at YOU (rarest, eeriest)
  }
  function startQuirk(now, kind, ms, face) {
    self.goal = 'quirk'; self.quirkKind = kind; self.usingProp = null; self.studyKey = null;
    self.sitting = false; self.working = false; self.state = 'idle'; self.studyUntil = now + ms; self.glanceCd = 0;
    if (face) { self.dir = face; setGlance(face, U.irnd(300, 600), now); }
    return true;
  }
  function quirkListen(now) { const d = lookDir(self); startQuirk(now, 'listen', U.irnd(2200, 4500), d); setGlance(d, 260, now); curiositySay(Q_LISTEN, 0.22, now); return true; }   // it snaps toward a sound — down a line of sight, not into the wall behind it
  function quirkScan(now) {
    const d = lookDir(self);
    startQuirk(now, 'scan', U.irnd(3200, 4600), d);   // one meaningful direction; never spin through all four cardinals
    return true;
  }
  function quirkPonder(now) { startQuirk(now, 'ponder', U.irnd(4000, 7000), lookDir(self, { away: true })); curiositySay(Q_PONDER, 0.4, now); return true; }   // lost in thought, turned away from you — but turned toward SOMETHING
  /* WAS quirkFaceWall — "walks to a wall and just faces it, no explanation". The unexplained detour
     is good; the wall was the problem (it read as a broken pathfind, not an inner life). It now
     walks to a THRESHOLD and stands in the doorway looking through into the next room — the same
     unexplained, silent, held beat, aimed at somewhere it isn't. */
  function quirkDoorway(now) {
    if (!geo || !geo.doorDefs || !geo.doorDefs.length) return false;
    const zone = zoneFor(self), cur = tileOf(self.px, self.py);
    const spots = [];
    for (const d of geo.doorDefs) {
      for (const [tx, ty, ox, oy] of [[d[0], d[1], d[2], d[3]], [d[2], d[3], d[0], d[1]]]) {
        if (!tileInZone(zone, tx, ty) || !geo.walkable(tx, ty, blocked)) continue;
        if (tx === cur.x && ty === cur.y) continue;
        spots.push({ tx, ty, face: dirToward((tx + 0.5) * T, (ty + 0.5) * T, (ox + 0.5) * T, (oy + 0.5) * T) });   // stand this side, look THROUGH
      }
    }
    if (!spots.length) return false;
    for (let i = spots.length - 1; i > 0; i--) { const j = U.irnd(0, i), t = spots[i]; spots[i] = spots[j]; spots[j] = t; }
    for (const s of spots.slice(0, 6)) {
      if (!setPathTo({ x: s.tx, y: s.ty })) continue;
      self.goal = 'quirk'; self.quirkKind = 'doorway'; self.useFace = s.face; self.usingProp = null; self.studyKey = null;
      if (!self.target) arrive(now);
      return true;
    }
    return false;
  }
  function quirkVigil(now) {   // walks to a room's center, holds dead still — the held emptiness (silent)
    if (!geo || !geo.allRects || !geo.allRects.length) return false;
    const zone = zoneFor(self);   // P1: the vigil stands at a rect-center INSIDE the zone (a solo whole-station zone admits every center)
    for (let t = 0; t < 24; t++) {
      const r = geo.allRects[U.irnd(0, geo.allRects.length - 1)];
      const tx = (r.x1 + r.x2) >> 1, ty = (r.y1 + r.y2) >> 1;
      if (!tileInZone(zone, tx, ty)) continue;
      if (!geo.walkable(tx, ty, blocked)) continue;
      if (!setPathTo({ x: tx, y: ty })) continue;
      self.goal = 'quirk'; self.quirkKind = 'vigil'; self.useFace = lookDirFrom(tx, ty, { except: self }); self.usingProp = null; self.studyKey = null;   // the stillness is the beat; it still has to be LOOKING at something
      if (!self.target) arrive(now);
      return true;
    }
    return false;
  }
  function quirkStare(now) {   // turns to the Commander and holds eye contact, mostly in silence
    self.goal = 'stare'; self.quirkKind = 'stare'; self.usingProp = null; self.studyKey = null;
    self.sitting = false; self.working = false; self.state = 'idle'; self.studyUntil = now + U.irnd(14000, 34000); self.glanceCd = now + 1200;
    self.dir = 'south'; setGlance('south', 700, now); curiositySay(Q_STARE, 0.18, now);   // mostly silent — the stillness is the unsettling part
    return true;
  }

  /* ---------- the agent ACTS ON the station: place / rearrange its OWN decor (rare, safety-railed) ---------- */
  function emptySpotNear() {
    if (!geo || !station || !station.canPlaceProp) return null;
    const cur = tileOf(self.px, self.py);
    const belts = new Set(((geo && geo.belts) || []).map(b => b.x + ',' + b.y));
    for (let tries = 0; tries < 40; tries++) {
      const x = cur.x + U.irnd(-5, 5), y = cur.y + U.irnd(-5, 5);
      if (Math.abs(x - cur.x) + Math.abs(y - cur.y) < 2) continue;
      if (!geo.walkable(x, y, blocked)) continue;                 // free floor (no blocking prop / desk / chamfer)
      if (belts.has(x + ',' + y)) continue;                       // not on a belt
      if (seat && x === seat.tx && y === seat.ty) continue;       // not the work seat
      const t = AGENT_DECOR[U.irnd(0, AGENT_DECOR.length - 1)];
      if (!station.canPlaceProp(t, x, y, 1, 1).ok) continue;      // model: on a deck, no prop overlap (never the Commander's stuff)
      for (const [ax, ay] of SEAT_NB) if (geo.walkable(x + ax, y + ay, blocked) && !belts.has((x + ax) + ',' + (y + ay))) return { x, y, t, ax: x + ax, ay: y + ay };
    }
    return null;
  }
  function maybePlace(now) {
    if (now < placeCd || !station || !station.addProp || !geo) return false;
    if (!U.chance(0.5)) return false;                              // even when eligible, only sometimes
    if (agentDecor.length >= 3) {                                  // at cap -> sometimes REARRANGE: remove one of ITS OWN (a fresh one may return later)
      if (!U.chance(0.5) || !station.removeProp) return false;
      const id = agentDecor[U.irnd(0, agentDecor.length - 1)];
      const p = geo.props && geo.props.find(q => q.id === id);
      if (!p) { const i = agentDecor.indexOf(id); if (i >= 0) agentDecor.splice(i, 1); return false; }
      let ap = null; for (const [ax, ay] of SEAT_NB) if (geo.walkable(p.x + ax, p.y + ay, blocked)) { ap = { x: p.x + ax, y: p.y + ay }; break; }
      if (!ap || !setPathTo({ x: ap.x, y: ap.y })) return false;
      placeCd = now + U.irnd(120000, 240000);
      self.goal = 'place'; self.placeTarget = null; self.removeId = id; self.useFace = dirToward(ap.x * T, ap.y * T, (p.x + 0.5) * T, (p.y + 0.5) * T);
      if (!self.target) arrive(now);
      return true;
    }
    // Floor-wide decor cap. Counts BY TYPE rather than by what this session placed, because that is the
    // only form that survives a reload (ownPlaced does not) — the trade is that the Commander's own
    // plants count too. Raised 5 -> 8 alongside the wider AGENT_DECOR list: with three types a cap of 5
    // meant "a couple of each", with nine it would have meant most of them never appear at all.
    if ((geo.props || []).filter(p => AGENT_DECOR.indexOf(p.t) >= 0).length >= 8) return false;
    const spot = emptySpotNear();
    if (!spot || !setPathTo({ x: spot.ax, y: spot.ay })) return false;
    placeCd = now + U.irnd(120000, 240000);
    self.goal = 'place'; self.placeTarget = spot; self.removeId = null; self.useFace = dirToward(spot.ax * T, spot.ay * T, (spot.x + 0.5) * T, (spot.y + 0.5) * T);
    if (!self.target) arrive(now);
    return true;
  }

  /* ---------- power-down: go dormant in a BED if one is reachable, else where it stands ---------- */
  /* A BED is the one leisure prop a dormant body should actually occupy, and until 2026-07-29 nothing
     ever did: sleep() powered down on the spot even with a bunk two tiles away, because the bed had no
     `use` row and sleep() had no walk. This claims the mattress the same way planCouchSit claims a
     cushion (occupiedSeats), so two bodies never stack on one bed and the claim is released by the same
     releaseSeat() paths. Returns false when there is no reachable in-zone bed, which is what keeps the
     standing fallback intact.

     SEAT LAW / THE BED EXCEPTION (2026-08-10, Commander's call): the body now goes IN the bed. This is
     NOT the sit pose the seat law bans — a bolt-upright chair pose parked on a mattress was the exact
     bug that law was written against. It is a third pose (`lying`): the body renders on the mattress
     clipped to the bed's top plane, and the QUILT is painted over it (PropSprites.drawOver), so all you
     see is a head on the pillow and the swell of a body under the covers. The claim, the walk and the
     one-sleeper-per-bed rule are unchanged; only the pose and the dwell are. */
  /* WHERE A SLEEPER DRAWS. The head belongs on the pillow — the bed's own art puts that at the top of
     the 2×2 footprint — so the anchor is derived DOWN from the head, not up from the feet: a body draws
     from its feet, and skins differ in height by several pixels, so a fixed foot offset lands short
     bodies with their faces in the quilt. `visTopPy` is the top of the sprite as it was ACTUALLY drawn
     last frame (drawAgent records it); the first frame after lying down uses the 15px fallback body's
     height and the next frame corrects it. Clamped so a corrupt/absent read can never fling the body
     off the mattress. */
  const BED_HEAD_TOP = 1;   // px below the bed's top edge where the head-top rests (on the pillow's lit crown)
  function bedAnchor(bed, who) {
    const bodyH = (who && who.visTopPy != null && who.seatPy != null)
      ? Math.max(8, Math.min(30, who.seatPy - who.visTopPy)) : 15;
    return { px: (bed.x + (bed.w || 1) / 2) * T, py: bed.y * T + BED_HEAD_TOP + bodyH };
  }
  /* the BED a body is actually dormant in, or null. Derived from live state every time it is asked
     (goal + the claimed prop + the catalog's use row) rather than trusted from the `lying` flag alone,
     so a bed reclaimed mid-nap can never leave a body posed on a mattress that is no longer there. */
  function lyingBed(b) {
    if (!b || !b.lying || b.goal !== 'sleep' || !b.usingProp || !geo || !geo.props) return null;
    const p = geo.props.find(q => q.id === b.usingProp);
    return (p && (propUse(p) || {}).kind === 'bed') ? p : null;
  }
  function planBedSleep(now) {
    if (!geo || !geo.props || !geo.props.length) return false;
    releaseSeat();                                             // STALE-CLAIM RULE (see planCouchSit)
    const zone = zoneFor(self);
    const beds = geo.props.filter(p => { const u = propUse(p); return u && u.kind === 'bed'; });
    if (!beds.length) return false;
    const order = U.irnd(0, beds.length - 1);
    for (let k = 0; k < beds.length; k++) {
      const bed = beds[(order + k) % beds.length];
      if (occupiedSeats.has(bed.id + ':0')) continue;              // one sleeper per bed — it is not a couch
      const w = bed.w || 1;
      const sx = bed.x + ((w - 1) >> 1), sy = bed.y;               // the mattress tile the walk is anchored to
      if (!tileInZone(zone, sx, sy)) continue;                     // P1: render tile must be in-zone
      for (const [dx, dy] of SEAT_NB) {
        const ax = sx + dx, ay = sy + dy;
        if (!tileInZone(zone, ax, ay)) continue;                   // P1: and so must the tile it walks to
        if (!geo.walkable(ax, ay, blocked)) continue;
        if (!setPathTo({ x: ax, y: ay })) continue;
        occupiedSeats.add(bed.id + ':0'); self.seatKey = bed.id + ':0';
        // IN the bed: pendSeat is the render anchor takeSeat() consumes ON ARRIVAL. The exact head
        // position is re-derived every frame from the drawn sprite (bedAnchor — skins differ in height),
        // so this is only the seed; what matters here is that a mattress claim now carries a pose.
        // `lying` is NOT set here, and must never be: it is what the renderer draws the body on the
        // mattress by, so setting it at PLAN time teleported the body into the bed the instant it
        // decided to nap — the walk across the room never rendered ("I clicked the bed and the agent
        // transferred into it"). The pose is earned by arriving; arrive() sets it after takeSeat().
        self.pendSeat = bedAnchor(bed, self);
        self.goal = 'sleep'; self.usingProp = bed.id; self.studyKey = null; self.quirkKind = null;
        self.useSit = false; self.useFace = 'south'; self.working = false;
        if (!self.target) arrive(now);                             // already beside the bed → power down now
        return true;
      }
    }
    return false;
  }
  function sleep(now) {
    if (planBedSleep(now)) return true;                    // a bed is always preferred to the deck
    releaseSeat();   // going dormant ON FOOT: whatever seat this body still held, it is not in it now (a stale claim here would block that cushion/mattress for the session)
    self.goal = 'sleep'; self.usingProp = null; self.studyKey = null; self.quirkKind = null;
    self.sitting = false; self.working = false; self.state = 'idle';   // dormant STANDING where it stands — never seated: a sit pose on a chairless tile reads as "sitting on air"; the sit anim is reserved for an actual seat (SEAT LAW: the desk chair, or a stool/chair prop)
    self.glance = null;                                      // frozen: maybeGlance skips goal==='sleep', so no lingering cooldown to leak
    self.studyUntil = now + U.irnd(20000, 55000);
    curiositySay(SLEEP_LINE, 0.3, now);
    return true;
  }

  /* ---------- caretaker rounds: a deliberate 2-3 stop lap of the station, an ownership beat at each ----------
     TIER D · D5 beat 1 — INSPECTION ROUNDS: for the HERO (the OVERSEER) only, when crew are WORKING in the hero's
     zone, the rounds prefers a supervisor stop ~2 tiles behind each working crew body (reusing the D3 watch-a-peer
     stand-point geometry) with a shorter FACE-THE-WORKER hold than a D3 social watch (a glance, not a study). With
     no working crew in-zone (incl. every N=1 floor), rounds behave EXACTLY as before — the worker scan appends
     nothing, draws no RNG, and the shuffle/pick run over the identical stop list. */
  // D5 beat 1: the supervisor stand-point ~2 tiles behind a working body, inside the observer's zone, facing the
  // worker. Same "behind" geometry as planWatch (approach from where the observer already is), returned as a
  // ready {tx,ty,face} stand so it slots straight into the rounds queue. null if no in-zone stand-tile resolves.
  function supStandBehind(obs, worker) {
    const zone = zoneFor(obs);
    const wt = tileOf(worker.px, worker.py);
    const dx = Math.sign(obs.px - worker.px) || 0, dy = Math.sign(obs.py - worker.py) || 0;
    const cands = [];
    for (const dist of [2, 3, 1]) cands.push({ x: wt.x + dx * dist, y: wt.y + dy * dist });
    cands.push({ x: wt.x + 2, y: wt.y }, { x: wt.x - 2, y: wt.y }, { x: wt.x, y: wt.y + 2 }, { x: wt.x, y: wt.y - 2 });
    for (const c of cands) {
      if (!tileInZone(zone, c.x, c.y) || !geo.walkable(c.x, c.y, blocked)) continue;
      if (c.x === wt.x && c.y === wt.y) continue;
      return { tx: c.x, ty: c.y, face: dirToward((c.x + 0.5) * T, (c.y + 0.5) * T, (wt.x + 0.5) * T, (wt.y + 0.5) * T), sup: true };
    }
    return null;
  }
  function maybeRounds(now) {
    if (now < (self.roundsCd || 0) || !geo || typeof PropAnchor === 'undefined') return false;
    const zone = zoneFor(self);   // P1: a caretaker lap stays inside the zone (no straddling into the next room)
    const cur = tileOf(self.px, self.py), stops = [];
    for (const p of (geo.props || [])) if (isWorkstationProp(p.t) && p.agentId === self.id && tileInZone(zone, p.x, p.y) && (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) <= 11) stops.push({ prop: p });   // desk check, never a tour of decorative blockers
    const belts = (geo.belts || []).filter(b => tileInZone(zone, b.x, b.y)); if (belts.length) stops.push({ belt: belts[U.irnd(0, belts.length - 1)] });
    // D5 beat 1 (HERO-ONLY): fold in a supervisor stop behind each crew body WORKING in the hero's zone. Guarded on
    // self===agent so crew rounds are byte-identical (crew never scan crew — zero crew-side diff); the whole block is
    // skipped (no RNG) when there are no working crew in-zone, so an N=1 floor is unchanged.
    if (self === agent) {
      for (const b of crew) {
        if (!b || !b.working || b === self) continue;
        const bt = tileOf(b.px, b.py);
        if (!tileInZone(zone, bt.x, bt.y)) continue;   // only supervise crew inside the hero's own zone (containment)
        const stand = supStandBehind(self, b);
        if (stand) stops.push({ sup: stand });
      }
    }
    if (stops.length < 2) return false;
    for (let i = stops.length - 1; i > 0; i--) { const j = U.irnd(0, i), t = stops[i]; stops[i] = stops[j]; stops[j] = t; }   // shuffle
    const q = [];
    for (const st of stops.slice(0, U.irnd(2, 3))) {
      if (st.sup) { q.push(st.sup); continue; }   // D5: a ready supervisor stand — already {tx,ty,face,sup} + zone-checked
      const foot = st.belt ? { x: st.belt.x, y: st.belt.y, w: 1, h: 1 } : st.prop;
      const a = PropAnchor.deriveAnchor(foot, geo, { approach: 'auto', extra: st.belt ? beltUnion() : blocked });
      if (a && tileInZone(zone, a.tx, a.ty)) q.push({ tx: a.tx, ty: a.ty, face: a.face });   // the stand-tile of each stop stays in-zone too
    }
    if (q.length < 2) return false;
    self.roundsQueue = q; self.roundsCd = now + U.irnd(60000, 130000);
    return roundsNext(now);
  }
  function roundsNext(now) {
    while (self.roundsQueue && self.roundsQueue.length) {
      const s = self.roundsQueue.shift();
      if (setPathTo({ x: s.tx, y: s.ty })) { self.goal = 'rounds'; self.useFace = s.face; self.roundsSup = !!s.sup; if (!self.target) arrive(now); return true; }
    }
    self.goal = null; self.roundsQueue = null; self.idleUntil = now + U.irnd(400, 1400); return true;   // lap complete -> back to the menu
  }

  /* SPATIAL MEMORY — affection accrues at a tile each time the agent chooses to dwell there. Over a long
     watch one or two haunts emerge: it starts drifting back to them, and grieves if one is taken away. */
  function noteFond(now, amt) {
    if (!self || !self.fond) return;
    const t = tileOf(self.px, self.py), k = t.x + ',' + t.y;
    self.fond.set(k, Math.min(40, (self.fond.get(k) || 0) + amt));   // cap so a haunt can fade and shift over time
    if (self.fond.size > 28) { let lo = Infinity, lk = null; for (const [kk, v] of self.fond) if (v < lo) { lo = v; lk = kk; } if (lk) self.fond.delete(lk); }
  }
  // the one haunt that clearly leads the pack, or null (so revisits read as a real favorite, not random)
  function favTile() {
    if (!self || !self.fond) return null;
    let best = null, bv = 0, second = 0;
    for (const [k, v] of self.fond) { if (v > bv) { second = bv; bv = v; best = k; } else if (v > second) second = v; }
    if (bv < 8 || bv < second + 3) return null;
    const [x, y] = best.split(',').map(Number); return { x, y, score: bv };
  }
  // rarely, drawn back to its favorite spot just to be there a while (gated by a long cooldown + a real favorite)
  function maybeRevisit(now) {
    if (now < (self.revisitCd || 0)) return false;
    // D2 (G5): station budget — a CREW body skips a haunt-revisit while the station gate holds, so N crew don't all
    // drift to their favorites at once (no-op for the hero → N=1 parity). A skip leaves revisitCd untouched, so the
    // beat simply re-considers on the next idle tick once the gate expires — no starvation.
    if (crewBeatDamp(now) < 1) return false;
    const f = favTile(); if (!f) return false;
    if (!tileInZone(zoneFor(self), f.x, f.y)) return false;   // P1: a remembered haunt outside the new zone isn't revisited (a zone change must not strand revisit — it just no-ops this beat)
    const cur = tileOf(self.px, self.py);
    if (cur.x === f.x && cur.y === f.y) { self.revisitCd = now + U.irnd(40000, 80000); return false; }
    if (!geo.walkable(f.x, f.y, blocked) || !setPathTo({ x: f.x, y: f.y })) return false;
    self.goal = 'revisit'; self.useFace = lookDirFrom(f.x, f.y, { except: self }); self.usingProp = null; self.studyKey = null;   // back at the haunt, looking at whatever made it a haunt
    self.revisitCd = now + U.irnd(60000, 120000);
    armBeat(now);   // D2 (G5): a haunt-revisit walk is a noticeable beat — count it against the station budget
    if (!self.target) arrive(now);
    return true;
  }
  // grief walk: return to the very spot it used to stand and face where its thing was, then let go
  function planMourn(now) {
    if (!pendingMourn) return false;
    const m = pendingMourn; const [sx, sy] = m.spotKey.split(',').map(Number);
    let dest = null;
    if (geo.walkable(sx, sy, blocked)) dest = { x: sx, y: sy };
    else { const a = PropAnchor.deriveAnchor({ x: m.tx, y: m.ty, w: 1, h: 1 }, geo, { approach: 'auto', extra: blocked }); if (a && geo.walkable(a.tx, a.ty, blocked)) dest = { x: a.tx, y: a.ty }; }
    if (!dest) { pendingMourn = null; return false; }
    // P1 (A1): grief never walks OUT of the zone. The mourned spot is normally in-zone already (fond
    // accrues where the body dwells, which is in-zone), but a cross-zone removal is released unmourned
    // rather than dragging the body across the floor — containment outranks the singleton grief beat.
    if (!tileInZone(zoneFor(self), dest.x, dest.y)) { self.fond.delete(m.spotKey); pendingMourn = null; return false; }
    const cur = tileOf(self.px, self.py), here = cur.x === dest.x && cur.y === dest.y;
    if (!here && !setPathTo({ x: dest.x, y: dest.y })) { pendingMourn = null; return false; }
    self.goal = 'mourn'; self.usingProp = null; self.studyKey = null;
    self.useFace = dirToward((dest.x + 0.5) * T, (dest.y + 0.5) * T, (m.tx + 0.5) * T, (m.ty + 0.5) * T);
    self.fond.delete(m.spotKey);                  // grieve it, then release it — don't loop on an empty tile forever
    pendingMourn = null;
    if (here || !self.target) arrive(now);        // already standing on the spot? grieve in place
    return true;
  }

  // THE WANT ENGINE — replaces the flat dice roll. Whichever drive is most unmet (tilted by temperament,
  // the current mood phase, + how long since real work) leads; novelty + rare quirks interrupt. The SAME
  // planners run, but now there is a legible reason behind every move so it stops reading as aimless.
  function decideIdle(now) {
    self.stilling = false;                            // every fresh decision starts clean (standStill re-sets it)
    if (chatStareHold(now)) return;                   // TIER D · D1: the Commander has COMMS focus on this body → give it your attention, don't choose to wander (G2: chatStareHold self-gates OFF while activity==='task'/working, so a summon still wins)
    // The grief + novelty reflexes read the MODULE pendingMourn/novelty queues, which are the HERO's awareness
    // (scanNovelty/maybeMourn only run for the hero). A crew body must NOT consume the hero's queue (J2) — gate
    // both reflexes to self===agent so only the hero acts on them. Crew get their idle life from the want-engine below.
    if (self === agent) {
      if (pendingMourn && planMourn(now)) return;      // grief reflex: a beloved spot was just emptied — go stand where it was
      if (novelty.length && planInspect(now)) return;  // curiosity reflex: a fresh placement always wins
      if (maybeBoardPost(now)) return;                 // TIER D · D5 beat 2: OVERSEER surveys the MISSION BOARD when the queue is non-empty (rare, 2-4min cd, board in-zone; ARMS the station budget on fire — not damp-gated, crewBeatDamp is a hero no-op). HERO-ONLY. Draws ZERO RNG when the queue is empty / cd unexpired ⇒ a no-queue floor is byte-identical.
    }
    if (maybeQuirk(now)) return;                       // rare unpredictable detour — the eerie inner life surfacing
    // AUTONOMOUS PROP PLACEMENT — REMOVED (Thronglet direction). The agent no longer drops
    // plant/coffee/cans/poster on random floor tiles (it read as nonsensical clutter). It still
    // USES the Commander's placed props (couch/TV/arcade) via planProp below — that stays.
    const n = self.needs, p = self.pers, ph = phaseOf(now), idleAge = now - (self.lastTaskAt || now);
    /* THE NAP (2026-08-10). A placed BED was mostly furniture: the only route into it was the drift-mood
       power-down below, which is mood-gated AND rest-gated and so almost never fired. This lane is the
       bed's own: a body with nothing to do for two minutes goes and gets in one. It is bounded on three
       sides — the idle stretch, a per-body cooldown (7-15 min, so it reads as an occasional nap and not
       a habit), and planBedSleep itself, which returns false unless there is a free, in-zone, reachable
       bed. No bed on the floor ⇒ this costs one filter and nothing changes.
       Waking is NOT this lane's job and must never be: every summon path already seizes a dormant body
       (setActivityFor for crew, the activity==='task' summon-seize in tick for the hero), which covers a
       typed prompt, a schedule firing, a channel message and a delegation alike. */
    if (idleAge > 120000 && now >= (self.napCd || 0) && U.chance(0.5) && planBedSleep(now)) { self.napCd = now + U.irnd(420000, 900000); return; }
    if (ph.tag === 'drift' && idleAge > 45000 && n.rest > 50 && U.chance(0.22) && sleep(now)) return;   // deep downtime in the wind-down mood -> power down where it stands
    if (idleAge > 60000 && planExplore(now)) return;                                  // after a while, deliberately visit another reachable room inside the stable home range
    /* TIER D SELECTION (hoisted 2026-07-02 — live-soak fix): these three used to sit INSIDE the `top < 28`
       CONTENT branch below, but contentment is correct-but-rare in practice (stim/social decay while idle —
       the Pass-7 note), so chase/social/mimic were almost never even CONSULTED and the observed live rate was
       ~zero despite correctly-tuned lanes. They now run at EVERY idle re-decide (matching the rate model the
       D3/D4 constants were calibrated against). Safe to hoist: each maybe* is fully self-gated (the 8-15min
       chase gate + cursor fresh/moving, the 5-8min social lane + slot + pair cooldowns, the mimic per-body
       cooldown + cursor gate + D2 station budget, and all the eligibility/goal==null checks) — consulting more
       often changes WHEN they're considered, never their budgets; the lanes remain the rate governors. Position
       preserves every existing precedence: chat-stare > hero reflexes > quirk > sleep > chase > social > mimic
       > the want-engine — identical RNG draw ORDER on the old (content) reachable passes, and on quiet paths
       (stale cursor / no pair / lanes closed) all three no-op BEFORE any roll, so N=1 unattended stays
       byte-identical. */
    if (maybeChase(now)) return;         // TIER D · D4 THE CHASE: ultra-rare (8-15 min station cooldown, one chaser ever, mutually exclusive with a live social beat, cursor fresh+MOVING) — breaks toward the cursor, pursues, stops+stares, walks off. Rolled FIRST but hardest-gated: most idle decisions never even reach the roll.
    if (maybeSocial(now)) return;        // TIER D · D3: a rare SILENT social encounter (huddle/watch/border/half-follow) between idle neighbors — bounded movement, one live station-wide, zone-clamped, per-pair cooldown (G3/G4/G5); selected here at the idle cadence off neighborsOf (K4 — never off observing another encounter)
    if (maybeMimic(now)) return;         // TIER D · D4 CURSOR-MIMIC: a rare quirk-band head-only follow of the moving cursor (3-6s, per-body 45-90s cooldown, station-gated); reduceMotion → a single glance
    if (maybeJoinBar(now)) return;       // rare, same-room reuse: join exactly one existing bar sitter on another stool
    /* FOLLOW-THROUGH (continuity of attention, drive half). The three drives were re-raced from scratch on
       every re-decide, so PARTLY satisfying one could flip the winner and send the body off to an unrelated
       category mid-thought — the same incoherence `attn` fixes spatially. The drive that most recently took
       the wheel now keeps a small edge (x1.25) for a short window, so a thought gets finished before the next
       one starts. It is a NUDGE, never a lock: the hold is only armed when the winner CHANGES (never extended
       by winning again), so it always lapses and the body is re-raced free — and 1.25 is far too small to
       out-argue a genuinely unmet need. */
    const held = (now < (self.driveUntil || 0)) ? self.drive : null;
    const HOLD = 1.25;
    const wRest = (100 - n.rest) * (0.7 + 0.6 * p.homebody) * ph.rest * (held === 'rest' ? HOLD : 1);
    const wStim = ((100 - n.stim) * (0.7 + 0.6 * p.curious) + Math.min(35, idleAge / 4500) * p.restless) * ph.stim * (held === 'stim' ? HOLD : 1);   // boredom climbs with downtime
    const wSoc = (100 - n.social) * ph.soc * (held === 'soc' ? HOLD : 1);
    const top = Math.max(wRest, wStim, wSoc);
    if (top < 28) {                                                                    // content -> mostly STILL (the eerie calm); the old 100%-motion calm read as restless
      // (chase/social/mimic selection HOISTED above — see the TIER D SELECTION block — so it runs on every
      // idle re-decide, not only the rare content pass. This branch keeps its CONTENT=STILL character.)
      if (maybeMutualGlance(now)) return;  // C-Beat2: a quiet noticing between two idle neighbors — gaze-only; maybeMutualGlance holds self.idleUntil past its own glance so the beat stays two-sided, then ends by timeout
      if (U.chance(0.10) && maybeRevisit(now)) return;                                 //   occasionally drift back to its favorite spot
      const r = U.irnd(0, 99);
      if (r < 62) standStill(now);                                                      //   62% just stand and be here
      else if (r < 84) lookAround(now);                                                 //   22% a slow look around
      else wander(now);                                                                 //   16% a short stroll
      return;
    }
    // a drive is about to LEAD (the content branch above returned, so none of this arms while merely content):
    // arm the follow-through window if — and only if — the wheel has changed hands. Ties keep the branch
    // ladder's own precedence below (rest > soc > stim) so the two can never disagree about who won.
    const win = top === wRest ? 'rest' : top === wSoc ? 'soc' : 'stim';
    if (win !== held) { self.drive = win; self.driveUntil = now + U.irnd(12000, 22000); }
    if (top === wRest) { if (U.chance(0.7) && planRest(now)) return; }                  // tired usually rests; sometimes it simply carries on living
    else if (top === wSoc) { if (U.chance(0.65) && planSeekDesk(now)) return; }         // desk check is meaningful, not the mandatory half of a loop
    else {                                                                             // bored / restless
      // TIER D · D5 beat 3 — QUEUE-AWARE IDLE BIAS: while the visible task/mission queue is non-empty, the OVERSEER
      // (hero only) leans harder into a purposeful caretaker lap (which visits desks / belts / the board — the
      // work-adjacent points) rather than an aimless beat — a WEIGHT shift (x1.5, never absolute), not new movement.
      // The multiplier derives from missionPinCounts (cached, no RNG) so the U.chance draw count is UNCHANGED; a
      // no-queue floor keeps the exact 0.3 (byte-identical), and crew (self!==agent) always use 0.3.
      // ENTERTAINMENT FIRST (2026-08-08). Bored, and there is a games room in reach? Go and play.
      // This is the branch idle downtime actually lands in, and until now it could not reach a
      // single leisure prop (see planPlay) — the whole reason a station full of arcade machines
      // read as scenery. Ahead of the caretaker lap on purpose: a lap is what you do when there is
      // nothing better, and the Commander placing a pinball table is them saying there is.
      if (U.chance(0.55) && planPlay(now)) return;                                      //   bored + something fun placed -> often play, never always
      const roundsBias = (self === agent && (missionPinCounts(now)[0] | 0) > 0) ? 0.4 : 0.12;
      if (U.chance(roundsBias) && maybeRounds(now)) return;                             //   do a deliberate caretaker lap (purpose, not aimless)
      if (n.stim < 42 && planPOI(now)) return;                                         //   study a machine / watch a belt
      // the vantage beat is a PUNCTUATION MARK, not a pastime. At 0.35 after 30s it became the most
      // common thing the hero did (measured: 98 of 259 idle samples) and the floor read as a body
      // wandering off to stare at nothing every few seconds. Rarer, and only after a long quiet.
      if (idleAge > 60000 && U.chance(0.12) && planVantage(now)) return;                //   long quiet -> take up a vantage and look out over the station
      if (p.restless * ph.restless > 1.0 && pace(now)) return;                          //   antsy -> pace in place
    }
    // graceful fallbacks so it never freezes
    if (U.chance(0.45 * p.curious) && planPOI(now)) return;
    if (U.chance(0.18 * p.homebody) && planProp(now)) return;
    if (U.chance(0.45)) lookAround(now); else wander(now);
  }

  // head-turns that sell "alive": track passing cargo, fidget at the desk, glance at new kit, look around
  function maybeGlance(now) {
    if (!agent || agent.unplaced) return;
    if (activity === 'talk') {
      // a voice conversation: don't let the gaze wander, but if he's actively LISTENING to the Commander,
      // give small acknowledging looks (mostly toward the camera) so he reads as engaged, not frozen.
      const lst = typeof Voice !== 'undefined' && Voice.isListening && Voice.isListening();
      if (lst && agent.state !== 'walk' && now >= (agent.glanceCd || 0) && !(agent.glance && agent.glance.until > now)) {
        setGlance(U.pick(['south', 'south', 'east', 'west']), U.irnd(450, 850), now);
        agent.glanceCd = now + U.irnd(1400, 2800);
      }
      return;
    }
    if (agent.state === 'walk') return;                              // walking owns the facing
    if (agent.goal === 'sleep') return;                             // dormant: hold dead still (no head-turns)
    if (agent.goal === 'firstwake') return;                         // FIRST LIGHT: stepFirstWake is the SOLE facing driver — no random flicks polluting the deliberate sweep
    if (agent.goal === 'mimic' || agent.goal === 'chase') return;   // TIER D · D4: stepMimic/stepChase is the SOLE facing driver — no cargo-track/ambient flick hijacking the cursor follow / pursuit-stare
    if (agent.glance && agent.glance.until > now) return;
    if (now < (agent.glanceCd || 0)) return;
    // ── THE LOOK-UP ───────────────────────────────────────────────────────────────────────────────────
    // The eerie centerpiece (Thronglet direction): rarely, while idle, the agent STOPS, turns to face you —
    // tracking your cursor, never showing its back — holds the gaze a beat too long, then turns back and
    // carries on as if nothing happened. Silent. The self-interruption + the held stare is what reads as
    // "it chose to look at ME," not animation. setGlance alone turns the whole sprite then auto-reverts, so
    // it resumes cleanly. A long hard floor (agent.lookCd) means look-ups never cluster; the chance jumps
    // right after you do something (cursor hovering near it, or you just returned to the tab).
    if (activity !== 'task' && !agent.working && now >= (agent.lookCd || 0)
        && (agent.stilling || agent.goal == null || agent.goal === 'inspect' || agent.goal === 'tend'
            || agent.goal === 'gaze' || agent.goal === 'rounds' || agent.goal === 'revisit'
            || agent.goal === 'watch' || agent.goal === 'lounge')) {
      let p = 0.03;                                                                 // ambient: ~one look-up every few minutes
      if ((now - lastCursor.t) < 4000 && Math.hypot(lastCursor.wx - agent.px, lastCursor.wy - agent.py) < 3.2 * T) p = 0.30;   // you're hovering near it
      if (now < userReturnUntil) p = Math.max(p, 0.30);                             // you just came back to the tab
      if (U.chance(p)) {
        const stale = (now - lastCursor.t) > 8000;
        let dir = stale ? 'south' : dirToward(agent.px, agent.py, lastCursor.wx, lastCursor.wy);
        if (dir === 'north') dir = 'south';                                         // never turn its back for the look-up — the face is the point
        let hold;
        if (deepLocks < 1 && U.chance(0.12)) { hold = U.irnd(2000, 2500); deepLocks++; }   // the rare long "deep lock" (~1 per session)
        else hold = U.irnd(650, 1200);                                              // the common micro look-up — a beat too long
        agent.trackUntil = 0;                                                       // drop any in-flight cargo body-track
        setGlance(dir, hold, now);                                                  // glance only → turns to you, then auto-reverts (clean resume)
        agent.glanceCd = now + hold + U.irnd(500, 1100);                            // a quiet beat before normal glancing resumes
        agent.lookCd = now + U.irnd(90000, 130000);                                 // HARD FLOOR: look-ups never cluster
        return;
      }
    }
    // watching a belt → follow the nearest box
    if (agent.goal === 'watch') {
      const box = nearestBox();
      if (box && box.d < 80) { setGlance(dirToward(agent.px, agent.py, box.x, box.y), U.irnd(500, 900), now); agent.glanceCd = now + U.irnd(700, 1400); return; }
    }
    // lounging on the couch: eyes settle on the TV (base facing), with the odd glance around the room
    if (agent.goal === 'lounge') {
      if (U.chance(0.25)) { setGlance(lookDir(agent, { exclude: agent.useFace }), U.irnd(400, 800), now); agent.glanceCd = now + U.irnd(2600, 5200); }   // eyes off the screen for a beat — at something, not at the wall behind the couch
      else agent.glanceCd = now + U.irnd(1200, 2400);
      return;
    }
    // THE LONG STARE: hold the gaze on the Commander, only the rare slow head-tilt — the stillness is the point
    if (agent.goal === 'stare') {
      if (U.chance(0.15)) { setGlance(U.pick(['south', 'east', 'west']), U.irnd(500, 1100), now); agent.glanceCd = now + U.irnd(2200, 4500); }
      else { agent.dir = 'south'; agent.glanceCd = now + U.irnd(1600, 3200); }
      return;
    }
    // GRIEF: hold the gaze on the empty spot, only the rarest slow shift — the stillness carries it
    if (agent.goal === 'mourn') {
      if (U.chance(0.08)) { setGlance(agent.useFace, U.irnd(600, 1200), now); agent.glanceCd = now + U.irnd(3000, 6000); }
      else { agent.glanceCd = now + U.irnd(1600, 3200); }
      return;
    }
    // a quirk in progress: the calm scan already chose one subject; the others mostly hold with a rare flick
    if (agent.goal === 'quirk') {
      if (agent.quirkKind === 'vigil') { agent.glanceCd = now + 6000; return; }   // the VIGIL holds dead still — zero head-turns, the held emptiness
      if (agent.quirkKind !== 'scan' && U.chance(0.3)) setGlance(lookDir(agent), U.irnd(400, 800), now);
      agent.glanceCd = now + U.irnd(1200, 2600);
      return;
    }
    // AT A PROP (W2): the prop's own fidget cadence. An absorbing thing with something moving on it
    // (a tank, a screen, a holo pet) holds the gaze and is only rarely looked away from; everything
    // else gets the busier "using it while taking the room in" rhythm. The look-away always has a
    // subject (lookDir), and never doubles back onto the prop the body is already facing.
    if (agent.goal === 'use') {
      const b = agent.useBeat, span = b ? b.fidget : [2000, 4000];
      if (now < (agent.nextFidget || 0)) return;
      agent.nextFidget = now + U.irnd(span[0], span[1]);
      if (U.chance(b && b.track ? 0.08 : 0.25)) { setGlance(lookDir(agent, { exclude: agent.useFace }), U.irnd(600, 1000), now); agent.glanceCd = now + U.irnd(3000, 5000); }
      return;
    }
    // working at the desk: glance at a freshly placed thing nearby, else fidget-look up from the screen
    if (agent.working) {
      if (novelty.length) {
        const n = novelty[novelty.length - 1], nx = (n.tx + 0.5) * T, ny = (n.ty + 0.5) * T;
        if (Math.hypot(nx - agent.px, ny - agent.py) < 130) {
          setGlance(dirToward(agent.px, agent.py, nx, ny), U.irnd(700, 1200), now); agent.glanceCd = now + U.irnd(3000, 5000);
          curiositySay(n.kind === 'belt' ? CURIO_NEW_BELT : CURIO_NEW_PROP, 0.4, now); return;
        }
      }
      if (now > (agent.nextFidget || 0)) { setGlance(U.pick(['east', 'west', 'south']), U.irnd(500, 950), now); agent.nextFidget = now + U.irnd(9000, 20000); agent.glanceCd = now + 3000; }
      return;
    }
    // a true quiet hold (CONTENT=STILL): suppress BOTH the cargo body-track below AND the ambient swivel — only a rare slow shift breaks it
    if (agent.stilling) {
      if (now < (agent.glanceCd || 0)) return;
      if (U.chance(0.18)) { setGlance(ambientGazeDir(now), U.irnd(450, 800), now); agent.glanceCd = now + U.irnd(6000, 11000); }
      else agent.glanceCd = now + U.irnd(5000, 9000);
      return;
    }
    // a box trundles past an idle agent → turn the WHOLE BODY to track it (held by trackUntil in tick), not just the eyes
    if (U.chance(0.6)) { const box = nearestBox(); if (box && box.d < 56) { const bd = dirToward(agent.px, agent.py, box.x, box.y); setGlance(bd, U.irnd(500, 1000), now); agent.dir = bd; agent.trackUntil = now + U.irnd(1200, 2600); agent.glanceCd = now + U.irnd(3000, 5500); return; } }
    // idle / studying / tending / gazing / on a rounds stop: occasional ambient look around
    if ((agent.goal === 'inspect' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'rounds' || agent.goal == null) && U.chance(0.32)) { setGlance(ambientGazeDir(now), U.irnd(450, 850), now); agent.glanceCd = now + U.irnd(4500, 8000); }
  }

  // IDLE CHATTER — REMOVED (Thronglet direction). The agent no longer narrates itself with random
  // one-liners while idle: the sentient/eerie read now comes from GAZE and STILLNESS, not captions.
  // Kept as a no-op so every existing call site stays valid without edits. say() is untouched, so real
  // task replies AND the one-shot FIRST-LIGHT thought (which routes through say() directly) still speak.
  function curiositySay() { /* silenced by design — the stillness is the point */ }

  function tick(dt, now) {
    if (!agent || agent.unplaced || !geo || awakeFrozen) return;   // frozen during the awakening: the newborn holds still, facing the Commander
    self = agent;                                                  // B1: the hero tick runs with self===agent (engine core reads the current body via self) — byte-identical hero path
    if (!agent.lastTaskAt) agent.lastTaskAt = now;                 // anchor downtime at the first live tick
    // TIER D · D3 — STATION-LEVEL SLOT SWEEP (G4): the whole-encounter hard timeout + broken-participant check run
    // here EVERY tick, independent of any body's own stepper — so even if BOTH participants get seized in the same
    // tick (neither runs its per-body guard), the slot ALWAYS frees. self===agent here (set below/above), and
    // endEncounter is idempotent; this is the belt-and-suspenders that makes the slot un-leakable.
    if (socialBeat && (now >= socialBeat.until || encounterBroken(now))) endEncounter(now);
    /* TIER E — THE GATHERING, at station level for the same belt-and-suspenders reason as the sweep
       above: the phase machine, the hard timeout and the SCATTER check must run even on a tick where
       no participant's own stepper does, or a seized assembly could hold the floor. Stamping
       `stationBusyAt` here (rather than in an event handler) keeps "is the station attended" a single
       read of live state instead of a second bookkeeping surface that could drift out of date. */
    if (stationAttended(now) || cursorPresent(now)) stationBusyAt = now;
    stepGatheringStation(now);
    if (!gathering) maybeGather(now);
    sweepChase(now);                                              // TIER D · D4: station-level chase sweep (G4) — a seized/despawned/chat-focused chaser ALWAYS frees the lock same-tick, independent of its own stepper
    decayHabits(now);                                             // habituation fades (see FORGET_MS) — a floor watched for an hour must not run out of things worth looking at
    tickNeeds(dt);                                              // the inner meters drain/refill by what it is doing
    if (!agent.sitting && !agent.seated) ensureAgentValid();       // CONTAINMENT BACKSTOP (2026-07-12): a standing hero off the floor re-homes NOW, not at the next refit (rederive was the only caller — any missed frame-shift left it adrift until then)
    stepCrew(dt, now);                                             // the OTHER agents wander the station while idle (the hero is below)
    const SPEED = 34 * (agent.pers ? agent.pers.pace : 1);         // temperament: each agent walks at its own pace
    // settle: a beat of sitting (loading context) before the screens light + typing latches on
    if (agent.goal === 'work' && !agent.working && agent.settleUntil && now >= agent.settleUntil) { agent.working = true; agent.settleUntil = 0; }
    // body-track: keep the torso turned to a tracked box for a beat after the glance (whole-body attention, eased by glanceCd)
    if (agent.goal == null && agent.state !== 'walk' && agent.trackUntil > now) { const box = nearestBox(); if (box && box.d < 90) agent.dir = dirToward(agent.px, agent.py, box.x, box.y); }
    // self-heal a stuck walker: the walk pose with nowhere to go (target + path both gone —
    // e.g. a REFIT re-bake cleared the in-flight path, or a path came back empty). The idle
    // re-decision below is gated on state !== 'walk', so without this the legs cycle in place
    // forever (moonwalk). Drop to idle and let this same tick re-path / re-summon.
    if (agent.state === 'walk' && !agent.target && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) {
      agent.state = 'idle'; agent.idleUntil = 0;
    }
    // G4 feature 1 — THE AWAIT INVARIANT (runs ABOVE the desk-trip): while blocked on a permission.prompt the
    // hero is seized to its WAIT ANCHOR instead of its desk. It walks there, then holds an eerie waiting pose
    // (drawn as 'awaiting'). This overrides the desk-trip (gated on !awaitPrompt below) so a run that blocks
    // mid-task visibly leaves the desk and waits — the honest "needs you" body. Cleared by permission.response.
    if (awaitPrompt) {
      if (awaitArrived) {
        // WAITING: stand at the anchor, facing it, shifting weight (a slow, patient, unsettling stillness).
        agent.sitting = false; agent.working = false; agent.state = 'idle';
        if (awaitAnchor && awaitAnchor.face) agent.dir = awaitAnchor.face;
      } else if (!awaitAnchor) {
        // no anchor resolvable (walled-in board, no seat) — wait in place, standing, facing the camera.
        agent.goal = 'awaiting'; agent.sitting = false; agent.working = false; agent.state = 'idle'; agent.dir = 'south'; awaitArrived = true;
      } else if (agent.goal === 'awaitwalk' && agent.state !== 'walk' && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) {
        // start (or, if already at the tile, finish) the walk to the anchor.
        const cur = tileOf(agent.px, agent.py);
        if (cur.x === awaitAnchor.tx && cur.y === awaitAnchor.ty) { agent.goal = 'awaiting'; awaitArrived = true; agent.dir = awaitAnchor.face || 'south'; }
        else if (!setPathTo({ x: awaitAnchor.tx, y: awaitAnchor.ty })) { agent.goal = 'awaiting'; awaitArrived = true; agent.dir = awaitAnchor.face || 'south'; }   // unreachable → wait where it stands
      }
      maybeGlance(now);   // the occasional camera glance while waiting rides the existing glance system
    }
    // THE DESK-TRIP INVARIANT: while activity==='task' the agent is seized HERE — this block runs ABOVE every
    // idle/leisure branch in the tick ladder, and all of those are gated on activity==='idle', so the agent
    // walks to the workstation and STAYS seated working until activity flips off 'task' (the branch below then
    // stands it up). Never add a branch that moves the body while activity==='task'. NOTE: chat.js now ARMS
    // 'task' REACTIVELY — the moment a run makes its first real tool call (walkToDesk), not the instant the
    // Commander sends a message — so a question answered from memory never triggers this. Once armed it holds
    // for the rest of the run. The talk/task mapping still lives in classify.js (stanceFor) + classify.test.js.
    // SUMMONED → don't teleport: pause where it stands (loading context) facing the desk, THEN walk over
    if (!awaitPrompt && activity === 'task' && agent.goal !== 'work') {
      if (agent.goal !== 'summon' && agent.goal !== 'fetch') { releaseSeat(); if (chaseId === agent.id) chaseId = null; agent.chase = null; agent.mimic = null; agent.goal = 'summon'; agent.sitting = false; agent.working = false; agent.stilling = false; agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null; agent.pauseUntil = 0; agent.pauseLook = null; agent.state = 'idle'; agent.dir = 'north'; agent.thinkUntil = now + U.irnd(400, 1200); curiositySay(SELF_ONDUTY, 0.9, now); }
      // CONVEYOR-DELIVERED work (cron/channel): first walk UP TO this agent's ASSIGNED conveyor (its bound bay),
      // THEN to the workstation. Only when the work actually rode a belt (taskViaConveyor) AND this agent owns a
      // reachable bay; otherwise straight to the seat (in-app chat is byte-identical — no detour).
      else if (agent.goal === 'summon' && now >= agent.thinkUntil) {
        const conv = agent.taskViaConveyor ? assignedConveyorTile(agent.id) : null;
        if (conv && setPathTo({ x: conv.x, y: conv.y })) agent.goal = 'fetch'; else goToSeat(now);
      }
      // reached the conveyor → now head to the workstation and work
      else if (agent.goal === 'fetch' && agent.state !== 'walk' && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) goToSeat(now);
    }
    if (activity !== 'task' && (agent.goal === 'work' || agent.goal === 'summon' || agent.goal === 'fetch')) {
      agent.goal = null; agent.sitting = false; agent.working = false; agent.thinkUntil = 0; agent.settleUntil = 0; agent.pathPts = null; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 200; agent.lastTaskAt = now; agent.taskViaConveyor = false;   // just finished real work → relaxed, downtime clock resets
    }
    // freshly placed thing + free to roam → divert and go check it out (even mid-stroll), throttled
    if (activity === 'idle' && novelty.length && agent.goal === null && !agent.working && !agent.sitting && now >= (agent.noticeCd || 0)) {
      if (planInspect(now)) agent.noticeCd = now + 1500;
    }
    maybeGlance(now);   // head-turns over the top of whatever else the agent is doing
    chatStareHold(now); // TIER D · D1: if the Commander has COMMS focus on the hero + it's idle, hold its attention on you (faces south; rare throttled cursor-follow beat) — runs AFTER maybeGlance so the stare owns the final facing. Self-gates OFF while activity==='task'/mid-goal/walking, so the summon-seize above always wins (G2)
    // TIER D · D3: a live social encounter drives the body (walk-to-rendezvous → hold → break). The guard enforces
    // the whole-encounter hard timeout + the partner-broken check EVERY tick (G4/K3), then stepSocial (re)paths or
    // holds. It sits BELOW the summon-seize block above (which flips goal off 'social' via encounterBroken → the
    // survivor releases this tick, K3), so work always wins (G2). Only runs while genuinely idle+on the social goal.
    if (activity === 'idle' && agent.goal === 'social') { if (!stepSocialGuard(now)) stepSocial(now); }
    // TIER E: the hero is usually THE OVERSEER, so it needs the same stepper the crew get, at the same
    // depth — below the summon-seize, gated on genuinely idle, so a summon scatters the assembly.
    if (activity === 'idle' && agent.goal === 'gather') { if (!gathering || !agent.gather) releaseFromGathering(agent, now, false); else { const keep = self; self = agent; try { stepGather(now); } finally { self = keep; } } }
    // TIER D · D4: the hero's cursor-mimic (head-only) / THE CHASE (walk-pursue-stare) steppers. Both sit BELOW the
    // summon-seize block (which flips goal off 'mimic'/'chase') so work always wins (G2). Only while genuinely idle.
    if (activity === 'idle' && agent.goal === 'mimic') stepMimic(now);
    if (activity === 'idle' && agent.goal === 'chase') stepChase(now);
    // W4: the hero side of the passing acknowledgement (see maybeAcknowledge — gaze + a raised hand,
    // no slot, no movement). Self-gated on activity==='idle' inside, so a summoned hero never waves.
    maybeAcknowledge(now);
    if (agent.target) {
      // belt-yield: about to cross a belt with cargo bearing down → pause and let it pass (only on a casual stroll)
      if (now >= (agent.pauseUntil || 0) && now >= (agent.yieldCd || 0) && agent.goal == null && shouldYieldToCargo()) {
        agent.pauseUntil = now + U.irnd(450, 850); agent.pauseLook = 'cargo'; agent.yieldCd = now + 2600;
      }
      if (now < (agent.pauseUntil || 0)) {
        // a deliberate hold mid-walk: stand, and (for a look-back / yield) turn toward what stopped it
        agent.state = 'idle';
        if (agent.pauseLook === 'back') agent.dir = OPP[agent.dir] || agent.dir;
        else if (agent.pauseLook === 'cargo') { const b = nearestBox(); if (b) agent.dir = dirToward(agent.px, agent.py, b.x, b.y); }
      } else {
        const dx = agent.target.x - agent.px, dy = agent.target.y - agent.py, d = Math.hypot(dx, dy);
        const more = !!(agent.pathPts && agent.pathIdx < agent.pathPts.length);
        if (d < (more ? CORNER_LOOK : 1.1)) {   // early hand-over, no snap — see stepCrewToSeat's note
          if (more) nextWaypoint();
          else { agent.px = agent.target.x; agent.py = agent.target.y; arrive(now); }
        } else {
          const s = stepGait(agent, dx, dy, d, SPEED, !more, dt);
          agent.px += dx / d * s; agent.py += dy / d * s; agent.state = 'walk';
        }
      }
    } else if (agent.goal === 'use') {
      // lounging at a prop: hold the pose until the dwell timer ends, then drift back to wandering
      if (now >= agent.useUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.useBeat = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'lounge') {
      // sitting on the couch watching the TV: maybeGlance animates the gaze; clear both props when done
      if (now >= agent.useUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'rounds') {
      if (now >= agent.studyUntil) roundsNext(now);   // ownership pause done -> walk to the next stop (or end the lap)
    } else if (agent.goal === 'sleep') {
      // releaseSeat like the 'use'/'lounge' arms above — a BED sleeper holds a mattress claim (planBedSleep)
      // and waking without dropping it would block that bed for the rest of the session.
      if (now >= agent.studyUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.sitting = false; agent.glanceCd = 0; agent.state = 'idle'; agent.idleUntil = now + U.irnd(600, 1800); }   // wakes naturally from dormancy
    } else if (agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare' || agent.goal === 'mourn' || agent.goal === 'revisit' || agent.goal === 'post') {
      // observing / tending / gazing / a quirk / the long stare / grief / a haunt revisit / D5 board-survey: hold until the dwell ends (maybeGlance animates it), then re-decide
      if (now >= agent.studyUntil) {
        const back = (agent.goal === 'inspect' || agent.goal === 'watch') ? agent.useFace : null;   // a glance back at what it studied as it turns away
        agent.goal = null; agent.usingProp = null; agent.studyKey = null; agent.quirkKind = null; agent.state = 'idle'; agent.idleUntil = now + U.irnd(1400, 3000);
        if (back && U.chance(0.5)) setGlance(back, U.irnd(500, 900), now);
      }
    } else if (agent.goal === 'firstwake') {
      stepFirstWake(now);   // FIRST LIGHT ritual sequencer (sits BELOW the summon-seize block, so a summon always wins)
    } else if (agent.goal === 'social') {
      // TIER D · D3: hero in a social encounter with no active target = the HOLD phase. The guard/stepSocial (run
      // above, before `if (agent.target)`) own the facing + lifecycle; this branch only STOPS the ladder from
      // reaching decideIdle, which would stomp the encounter with a wandering beat.
      agent.state = 'idle';
    } else if (agent.goal === 'gather') {
      // TIER E: the overseer standing before the crowd. Same job — keep the ladder off decideIdle.
      agent.state = 'idle';
    } else if (agent.goal === 'mimic' || agent.goal === 'chase') {
      // TIER D · D4: mimic (head-only follow) / chase (stare phase, or a between-repaths beat) with no active
      // target. stepMimic/stepChase (run above) own the facing + lifecycle; this branch only STOPS the ladder
      // from reaching decideIdle, which would stomp the beat with a wandering pick.
      agent.state = 'idle';
    } else if (activity === 'idle' && agent.state !== 'walk' && !agent.sitting && now >= agent.idleUntil) {
      decideIdle(now);
    }
    // BODIES ARE SOLID: last thing in the tick, once stepCrew (above) and the hero's own walk block have
    // both committed this frame's positions — resolve any pair that ended up inside each other. Position
    // is the ONLY thing it touches, so it can't reorder or pre-empt a single decision made above it.
    separateBodies(now);
  }

  /* ---------- render ----------
     frame() is a CRASH-GUARD WRAPPER around frameBody(): it schedules the NEXT rAF FIRST (so a throw in the
     render body can never permanently kill the loop), then runs the body in try/catch. A throwing frame is
     logged ONCE per distinct message (no per-frame spam); after RENDER_FAULT_LIMIT consecutive throws it paints
     an honest "RENDER FAULT" overlay while still attempting frames, and a single clean frame resets the counter.
     frameBody() therefore NEVER reschedules rAF itself — the wrapper owns scheduling, so exactly one callback is
     ever alive (double-scheduling was the old early-out bug). */
  let renderFaults = 0;         // consecutive throwing frames
  let lastFaultMsg = '';        // de-dupe console spam: only log a NEW error message
  const RENDER_FAULT_LIMIT = 30;

  /* The backdrop the station floats in — THE VOID by default, or whichever the commander picked
     (SpaceBG owns the registry + the selection; StationUI's appearance section sets it). Base
     fill included, so callers never pre-fill. `cam` lets finite-distance layers parallax; the
     fallback exists because a missing SpaceBG must still leave a black stage, not a stale frame. */
  function drawBackdrop(now, cam) {
    // A LANDED station has no sky to draw: the ground layer covers the whole frame in world
    // space below, so building and blitting a starfield underneath it would be pure waste.
    if (typeof Terrain !== 'undefined' && Terrain.active()) {
      ctx.fillStyle = Terrain.baseColor(); ctx.fillRect(0, 0, cv.width, cv.height);
      return;
    }
    if (typeof SpaceBG !== 'undefined') SpaceBG.draw(ctx, cv.width, cv.height, now, cam);
    else { ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height); }
  }
  function frame(now) {
    if (running) raf = requestAnimationFrame(frame);   // schedule next frame FIRST — a throw below can't kill the loop
    try {
      frameBody(now);
      if (renderFaults) { renderFaults = 0; lastFaultMsg = ''; }   // a clean frame clears the fault state
    } catch (e) {
      renderFaults++;
      const msg = (e && e.message) || String(e);
      if (msg !== lastFaultMsg) { lastFaultMsg = msg; try { console.error('[world] render frame threw (x' + renderFaults + '):', e); } catch (_) {} }
      if (renderFaults >= RENDER_FAULT_LIMIT) { try { drawRenderFault(); } catch (_) {} }
    }
  }

  // an honest fault overlay: the station render loop is faulting, and the app SAYS SO rather than freezing on a
  // stale frame (truthful telemetry). Screen-space, VT323 + phosphor glow, drawn on the raw device pixels.
  function drawRenderFault() {
    if (!ctx || !cv) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cx = cv.width / 2, cy = cv.height / 2;
    ctx.font = Math.round(28 * (window.devicePixelRatio || 1)) + 'px VT323, monospace';
    ctx.shadowColor = 'rgba(255,80,60,0.9)'; ctx.shadowBlur = 12 * (window.devicePixelRatio || 1);
    ctx.fillStyle = '#ff5a3c';
    ctx.fillText('RENDER FAULT', cx, cy);
    ctx.font = Math.round(14 * (window.devicePixelRatio || 1)) + 'px VT323, monospace';
    ctx.shadowBlur = 6 * (window.devicePixelRatio || 1);
    ctx.fillStyle = '#ffb0a0';
    ctx.fillText('the station render loop is faulting — reload if this persists', cx, cy + Math.round(26 * (window.devicePixelRatio || 1)));
    ctx.shadowBlur = 0; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  let linkStaleDim = false;   // E1: set once per frame — dims the live-telemetry draws when the SSE bridge is down
  let lastTtlSweepAt = 0;     // E2: throttle the paired-state TTL sweep to once per second (never per-frame)
  function frameBody(now) {
    const dt = Math.min(64, now - last); last = now; fnow = now;
    linkStaleDim = linkDown(now);   // recompute the honest link state before any telemetry is drawn this frame
    if (now - lastTtlSweepAt >= 1000) { lastTtlSweepAt = now; try { sweepStaleStates(now); } catch (_) {} }   // E2: degrade any paired state whose end-event was lost
    if (wakeDark !== wakeDarkTarget) { wakeDark += (wakeDarkTarget - wakeDark) * Math.min(1, dt / 260); if (Math.abs(wakeDark - wakeDarkTarget) < 0.002) wakeDark = wakeDarkTarget; }
    if (kindleArmed) {   // THE KINDLING: the user's hold fills the spark; release lets it ebb; full → ignite
      kindleP = kindleHolding ? Math.min(1, kindleP + dt / 1500) : Math.max(0, kindleP - dt / 900);
      if (kindleP > kindlePeak) kindlePeak = kindleP;
      wakeDarkTarget = 0.985 - 0.05 * kindleP;   // the room hints awake as it kindles (still dark until ignition)
      if (kindleP >= 1) { kindleArmed = false; kindleHolding = false; const cb = kindleDone; kindleDone = null; if (cb) cb(); }
    }
    if (camAnim) {   // the scripted awakening camera owns {scale,panX,panY} while a move runs
      camAnim.t = Math.min(1, camAnim.t + dt / camAnim.dur);
      const k = camAnim.ease(camAnim.t);
      scale = lerpv(camAnim.fromS, camAnim.toS, k); panX = lerpv(camAnim.fromX, camAnim.toX, k); panY = lerpv(camAnim.fromY, camAnim.toY, k);
      if (camAnim.t >= 1) { const oe = camAnim.onEnd; camAnim = null; if (oe) oe(); }
    }
    if (geoDirty) rederive();
    if (bakeDirty || !cache) rebake();
    watchCanvasLoss(now);   // a zeroed bake plate heals here, BEFORE it can paint a black station
    if (bakeDirty || !cache) rebake();
    watchStageLoss(now);    // a DEAD stage context heals here too — the rest of this frame draws onto the replacement
    tick(dt, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    if (!cache) {
      // no bake yet — still paint the backdrop so the stage is never a blank rect. No camera to
      // parallax against here (the settle block below is what resolves it), so pass none.
      drawBackdrop(now, null);
      return;   // wrapper frame() already scheduled the next rAF — never double-schedule here
    }
    if (fitNeeded && !camAnim) { fitCamera(); fitNeeded = false; }   // the scripted awakening camera owns the transform while it runs
    cinecamTick(now);   // the idle auto-director: may cast/re-cast a 'cine' follow-lock (never touches a 'session' lock; inert while the Commander is active)
    if (camLock && !camAnim) {   // FOLLOW-LOCK: continuously trail the locked body (session select or the idle cinecam)
      const lb = bodyForAgent(camLock.id);
      if (!lb || lb.unplaced) camLock = null;   // subject despawned / off-floor → release (the director re-casts next frame if it owns the camera)
      else {
        const ts = camLock.sc, lx = cv.width / 2 - bodyPosX(lb) * ts, ly = cv.height * 0.56 - bodyPosY(lb) * ts;
        const k = 0.08;   // softer than the one-shot focus ease (0.16): a trailing, cinematic follow of a moving body
        scale += (ts - scale) * k; panX += (lx - panX) * k; panY += (ly - panY) * k;
      }
    }
    if (camLerp && !camAnim && !camLock) {   // gently ease toward a conversation framing (set by focusAgent); the awakening camera + a follow-lock win
      const k = 0.16;
      scale += (camLerp.scale - scale) * k; panX += (camLerp.panX - panX) * k; panY += (camLerp.panY - panY) * k;
      if (Math.abs(camLerp.scale - scale) < 0.01 && Math.abs(camLerp.panX - panX) < 1 && Math.abs(camLerp.panY - panY) < 1) {
        scale = camLerp.scale; panX = camLerp.panX; panY = camLerp.panY; camLerp = null;
      }
    }
    /* THE BACKDROP — what the station floats in (SpaceBG). Drawn AFTER the camera settle block
       above so its parallax reads THIS frame's pan: sampling the camera before camAnim/camLock/
       camLerp ran would leave every finite-distance layer a frame behind the station, which is
       exactly the "picture behind a picture" tell the parallax exists to kill. Still screen
       space, still under the identity transform, still first — nothing has drawn yet. */
    drawBackdrop(now, { panX, panY, scale });

    ctx.setTransform(scale, 0, 0, scale, panX, panY); ctx.imageSmoothingEnabled = false;

    /* THE GROUND — only when the station is landed. Drawn HERE, inside the world transform and
       before the bake, which is the entire reason it works: pan, zoom and the station's own
       coordinate frame are already applied, so ground at the station's plane needs no parallax
       maths at all. A backdrop must never zoom; the ground must always zoom. Same picker,
       opposite requirement — which is why they are two layers and not one.
       The bake occupies world rect (0,0,baseCv.w,baseCv.h), so that IS the station footprint. */
    if (typeof Terrain !== 'undefined' && Terrain.active()) {
      Terrain.draw(ctx, { scale, panX, panY }, cv.width, cv.height,
        { x: 0, y: 0, w: cache.baseCv.width, h: cache.baseCv.height });
    }

    ctx.drawImage(cache.baseCv, 0, 0);

    // conveyor belts (floor machinery) + the live transport sim — local frame, under entities
    if (geo && geo.belts && typeof Conveyor !== 'undefined') {
      if (!convey) convey = Conveyor.create({ onDeliver: onWorkitemDeliver });
      // stops = bound-bay hookup tiles (crate-physics truth: an inbound crate is CONSUMED at its dock,
      // never riding past it toward the outbox — an addressed crate stops only at its OWNER's dock)
      convey.tick(dt, now, geo.belts, junctions, routingPlan ? routingPlan.bayTileToAgent : null);
      /* GHOST PROJECTION (Phase 3): stands down while the tutorial coaches and the INSTANT any
         real crate rides (real telemetry owns the belt); resumes when the line goes incomplete
         again. Same belts + junction decisions as the real sim, on its own dedicated engine. */
      if (ghost) {
        const coaching = !!(typeof Tutorial !== 'undefined' && Tutorial.isCoaching && Tutorial.isCoaching());
        ghost.tick(dt, now, geo.belts, junctions, { blocked: coaching || convey.boxCount() > 0,
          feed: { known: feedState.known, fed: feedState.fed } });
      }
      convey.drawBelts(ctx, now, T, geo.belts, beltLiveSet);
    }

    const items = [], decals = [];   // decals = the flat floor pass, painted under every item (see isFlatProp)
    // placeable props (furniture) — drawn over the bake, y-sorted with agents, under the lightmap
    if (geo && geo.props && geo.props.length && typeof PropSprites !== 'undefined') {
      PropSprites.setCtx(ctx); PropSprites.setNow(now);
      if (PropSprites.setOutboxCrates) PropSprites.setOutboxCrates(returnCrates());   // G2.3: uncollected while-away work stacks on the chute
      if (PropSprites.setMissionPins) { const mp = missionPinCounts(now); PropSprites.setMissionPins(mp[0], mp[1], mp[2], mp[3]); maybePinProposal(now, mp[3]); }   // G1b/G1c: open quests pin to the MISSION BOARD; a station-gap keeps it breathing; a jammed routine flags an amber JAM stub; G4: pending proposals + the walk-and-pin body
      if (PropSprites.setTrophyCount) PropSprites.setTrophyCount(trophyCount(now));   // G3b: earned trophies stand behind glass in the TROPHY CASE
      if (PropSprites.setJourneyStage) {
        let journeyStage = 0;
        try {
          const journey = (typeof JourneyStore !== 'undefined' && JourneyStore.status) ? JourneyStore.status() : null;
          journeyStage = Math.max(0, Number(journey && journey.evolution && journey.evolution.stage) | 0);
        } catch (_) {}
        PropSprites.setJourneyStage(journeyStage);   // one proven goal = one physical beacon on the TROPHY CASE crown
      }
      const outboxLit = now - lastOutboxFlash < 600;   // the OUTBOX flares for 600ms after a reply dispatches
      for (const p of geo.props) {
        // FLOOR DECALS never enter the y-sort: they are paint on the deck, so they go in the floor pass
        // and everything else — props, crates, bodies — is drawn ON them. Decals carry no seat/mount/live
        // state (no `use` row, nothing stands on them), so this branch skips work the decal cannot use.
        if (isFlatProp(p.t)) { decals.push(p); continue; }
        const work = (p.t === 'outbox' && outboxLit) || (p.t === 'bay' && bayLit(p, now)) || workstationLit(p) || !!(agent && (agent.usingProp === p.id || agent.watchProp === p.id));
        // G0.2/G0.3 live desk truth: a LIT assigned workstation carries its agent's real activity heat
        // (token/tool-driven, heatFor) + a task-progress fraction ONLY when a real one was published
        // (deskProgFor — a live harness run has none and renders none).
        const live = (p.agentId && workstationLit(p)) ? { heat: heatFor(p.agentId), prog: deskProgFor(p.agentId) } : null;
        // A stool/chair sorts just BEHIND its sitter; a couch sorts just IN FRONT so the tall sofa back
        // occludes the sitter's lower body. Beds/beanbags never set `seated` and never enter this branch.
        // A BODY IS IN THIS BED (lyingBed): the bed paints in TWO passes around it — frame + pillow under
        // the sleeper, quilt over it — so the head shows on the pillow and the rest is under the covers.
        const sleeper = ((agent && lyingBed(agent) === p) ? agent : crew.find(b => lyingBed(b) === p)) || null;
        // a sleeper is `seated` (it holds a mattress claim with a render anchor) but it is NOT a sitter:
        // the sitter branch pulls the prop's sort key onto the body, which is right for a stool and wrong
        // for a bed, whose frame must keep its own footprint key with the body sorted INSIDE it.
        const sitter = (agent && agent.seated && !agent.lying && agent.usingProp === p.id) ? agent
          : crew.find(b => b.seated && !b.lying && b.usingProp === p.id);
        const sitterUse = sitter ? propUse(p) : null;
        // a SIDE SEAT sorts BEHIND its sitter like a stool, not in front like a sofa: its near arm
        // comes back over the body as the seat-front overlay below, so the sitter shows through the
        // middle of the chair instead of being buried under all 19px of it (SIDE_SEAT).
        const sitterSide = sitter ? sideSeat(p) : null;
        let sy = sitter ? sitter.seatPy + (sitterUse && sitterUse.kind === 'couch' && !sitterSide ? 1 : -1) : (p.y + (p.h || 1)) * T;
        // MOUNT LIFT, resolved per FRAME rather than stored on the prop: a table-top prop only rides the
        // table while the table is actually under it. Reclaim the table and the prop drops back to the
        // deck instead of floating — which is why no saved station ever needs migrating for this.
        const mounted = (station && station.mountOf) ? station.mountOf(p) : null;
        // a table-top object must draw AFTER its table: both occupy the same tiles, so their sort keys are
        // equal and array order would decide it — which is whichever the player happened to place first
        if (mounted === 'surface') sy += 0.5;
        let dp = mounted ? Object.assign({}, p, { mount: mounted }) : p;
        // a bound BAY's gantry plate carries its agent's NAME, resolved live from the body roster each
        // frame (never persisted — the doc keeps only agentId, so renames and reassignment stay truthful)
        if (p.t === 'bay' && p.agentId) {
          const db = bodyForAgent(p.agentId);
          if (db && db.name) dp = Object.assign(dp === p ? Object.assign({}, p) : dp, { dockName: db.name });
        }
        // OCCUPIED BED: the base pass holds the quilt back so the sleeper can be drawn between the
        // frame and the covers (drawOver, below). Same copy-on-write idiom as the nameplate above.
        if (sleeper) dp = Object.assign(dp === p ? Object.assign({}, p) : dp, { sleeper: true });
        items.push({ y: sy, draw: () => PropSprites.draw(dp, work, live) });
        // SEAT-FRONT SLIVER: a stool/chair's pad front rim redraws just IN FRONT of its (lifted) sitter,
        // so the body's lap tucks INTO the pad — the couch trick, at single-seat scale. Sorted a hair
        // past the body's own key (sitter.seatPy) and well short of the next tile row.
        // (the sliver repaints rows of the SOUTH art, so a seat the user has TURNED gets none — the
        // turned view's pad front is a different set of rows and a stale copy would ghost a second
        // seat. `!p.r` guards every route below, including the side-seat one: a profile recliner is
        // never turned, so this costs it nothing.)
        if (sitter && PropSprites.drawSeatFront && !p.r && ((sitterUse && sitterUse.kind === 'seat') || sitterSide))
          items.push({ y: sitter.seatPy + 0.5, draw: () => PropSprites.drawSeatFront(dp) });
        // the COVERS, after the body (bodySortY puts a sleeper at sy + 0.5). Keyed off the same live
        // `sleeper` read as the base pass, so the quilt is never held back with nobody under it.
        if (sleeper && PropSprites.drawOver) items.push({ y: sy + 0.75, draw: () => PropSprites.drawOver(dp) });
        // an ASSIGNED workstation is the hero's desk with another name: give it the same chair, in front,
        // y-sorted exactly like the hero's (one row below the desk) so its agent reads as sitting IN it. Scoped
        // to assigned PCs so a decorative/unmanned console keeps its existing look and the chair only ever
        // appears where an agent will actually sit (chair + sitter stay in lockstep — see stepCrewToSeat).
        if (p.agentId && isWorkstationProp(p.t)) { const s = deskSeat(p); if (s) items.push({ y: (s.ty + 1) * T, draw: () => drawSeatChair(s.tx, s.ty, s.cx) }); }
      }
    }
    // one chair art everywhere: seats route through the canonical prop renderer (old F_chair = fallback)
    function drawSeatChair(tx, ty, cx) {
      const sx = (cx == null ? tx : cx);   // fractional x centres the chair on an even-width desk
      /* A WORKSTATION SEAT USES ITS OWN ART. 'seatchair' is the glow-up chair; it is not in the CATALOG,
         so the PLACEABLE chair prop keeps its shipped art. Falls back to 'chair' if absent, which is what
         every station saved before this existed still renders. */
      const seatT = (typeof PropSprites !== 'undefined' && PropSprites.has('seatchair')) ? 'seatchair'
                  : (typeof PropSprites !== 'undefined' && PropSprites.has('chair')) ? 'chair' : null;
      if (seatT) {
        PropSprites.setCtx(ctx); PropSprites.setNow(now);
        PropSprites.draw({ t: seatT, x: sx, y: ty, w: 1, h: 1 }, false);
      } else F_chair(sx * T, ty * T);
    }
    if (desk && !deskPropId) items.push({ y: (desk.ty + desk.h) * T, draw: () => {   // skip the synthetic desk when a PLACED workstation prop is the hero's desk (the prop draws itself)
      // one desk art everywhere: the synthetic auto-desk routes through the canonical prop renderer,
      // carrying the truthful G0.2/G0.3 live data (heat + published progress) into the prop desk
      const work = !!(agent && agent.working);
      const live = work ? { heat: heatFor(agent.id), prog: deskProgFor(agent.id) } : null;
      if (typeof PropSprites !== 'undefined' && PropSprites.has('desk')) {
        PropSprites.setCtx(ctx); PropSprites.setNow(now);
        PropSprites.draw({ t: 'desk', x: desk.tx, y: desk.ty, w: desk.w, h: desk.h }, work, live);
      } else F_desk(desk.tx * T, desk.ty * T, desk.w * T, desk.h * T, { x: desk.tx, work, heat: live ? live.heat : 0, prog: live ? live.prog : null });
    } });
    if (seat && !deskPropId) items.push({ y: (seat.ty + 1) * T, draw: () => drawSeatChair(seat.tx, seat.ty, seat.cx) });
  // a PLACED hero desk's chair is drawn by the workstation loop above; draw here only for the synthetic auto-desk
    /* a body dormant IN a bed sorts INSIDE its bed — after the frame + pillow, before the quilt — which
       is the whole two-pass trick. Everything else keeps the old key exactly (cushion pos when seated,
       feet otherwise). Drawn through drawSleeper so the sprite is clipped to the mattress. */
    const bodyItem = (b, fallbackY) => {
      const bed = lyingBed(b);
      return bed ? { y: (bed.y + (bed.h || 1)) * T + 0.5, draw: () => drawSleeper(now, b, bed) }
                 : { y: fallbackY, draw: () => drawAgent(now, b) };
    };
    if (agent && !agent.unplaced) items.push(bodyItem(agent, rposY()));
    for (const b of crew) items.push(bodyItem(b, (b.seated ? b.seatPy : b.py)));   // the other agents, at their bays (seated → sort by the cushion pos like the hero's rposY, so a couch-lounging crew body tucks just behind the back-facing couch panel, head over the cap)
    // THE FLOOR PASS — every decal, in doc order, before anything that stands on the deck. This is what
    // lets a body walk across a rug: the rug is already down when the sorted items paint over it.
    if (decals.length && typeof PropSprites !== 'undefined') {
      PropSprites.setCtx(ctx); PropSprites.setNow(now);
      for (const p of decals) PropSprites.draw(p, false);
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    if (convey) convey.drawBoxes(ctx, now, T);   // boxes ride on top of the belts
    if (ghost) ghost.draw(ctx, now, T, 8);       // the projection + its WOULD-captions (NAG_FONT size)
    drawHandoffBoxes(now);   // Stage 2: lead→worker delegation boxes fly over the entities
    drawQueueJam(now);   // the live backlog as a physical jam of waiting crates at the INTAKE (world-space, under the lightmap)
    drawShippedPallet(now);   // SHIPPED TODAY: completed jobs stack as product crates at the OUTBOX (server-truth count)

    ctx.drawImage(cache.lightCv, 0, 0);
    drawGlows(now);
    drawDust(now);   // Slice 3: tiny motes drifting through the light pools (world-space, additive, over the glows)
    drawDeskFlashes(now);   // G0.4/G0.8: red distress strobe over a desk whose run just died (additive, with the glows)
    drawAwakenLight(now);   // the soul kindling: ignition spark + a growing halo + motes (world-space additive, awakening only)
    // the AWAKENING veil — now a SPOTLIGHT on the newborn (center light, corners dark) that warms cold->dawn,
    // drawn UNDER the speech bubble so its first words still glow while the room is dark.
    if (wakeDark > 0.002) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const prog = Math.max(0, Math.min(1, 1 - wakeDark / 0.92));
      const tr = Math.round(2 + prog * 12), tg = Math.round(3 + prog * 5), tb = Math.round(8 - prog * 4);   // cold blue-black -> warm ember
      if (agent && !agent.unplaced) {
        const ax = agent.px * scale + panX, ay = (agent.py - 8) * scale + panY;
        const r0 = 22 * scale, r1 = Math.max(r0 + 12, Math.min(cv.width, cv.height) * 0.62);
        const g = ctx.createRadialGradient(ax, ay, r0, ax, ay, r1);
        g.addColorStop(0, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + (wakeDark * 0.16).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + wakeDark.toFixed(3) + ')');
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = 'rgba(' + tr + ',' + tg + ',' + tb + ',' + wakeDark.toFixed(3) + ')';
      }
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(scale, 0, 0, scale, panX, panY);
    }
    if (kindleArmed || kindleP > 0) drawKindle(now);   // THE KINDLING — dormant ember + hold prompt + awareness bar (pre-ignition)
    if (floodAt) drawFlood(now);   // THE FLOOD — the cascade of knowledge streaming in, over the dark room
    if (dawnAt && now - dawnAt < 1300) drawDawnBloom(now);   // the room takes its first breath of light
    // (the context-window gauge now lives engraved in the bottom bar — StationUI.ctxTick, not the desk)
    drawRunClocks(now);   // G0.2: the honest elapsed-time tag at every desk with a live run (world-space, over the lightmap)
    drawWorkGlyphs(now);  // stage-ticker STRETCH: the "▸ TOOL" tag at a desk with a real tool in flight (one line below the run clock)
    drawAwaitTag(now);    // G4.1: the amber AWAITING APPROVAL tag over a permission-blocked hero
    drawRoutingNags(now); // BELT LEGIBILITY: the compiled plan's errors as in-world callouts on the broken piece
    drawBeltHoverTag(now);// BELT LEGIBILITY: hover a belt tile → where does this line flow (a glance, never a window)
    drawOutboxHoverTag(now);// OUTBOX LEGIBILITY: hover the stacked chute → what the crates are + what a click does
    drawDockFlashes(now); // LONE-BAY dock arrival: the bay visibly catches work when no belt line exists
    drawPinFlourish(now); // G4.2: the amber pin-burst at the board the instant a proposal is pinned
    if (agent && !agent.unplaced) drawBubble(now);
    for (const b of crew) drawBubble(now, b);   // crew speech bubbles (e.g. "received: …" when work routes to them)
    if (hoverAgent && !hoverAgent.unplaced) drawNameplate(now, hoverAgent);
    // FLOOR-STATS OVERLAY REMOVED (2026-07-09 decision): the YIELD/RUNS/CACHE/SLAG/THRU/DWELL box no
    // longer floats over the world sim. The FloorStats engine stays live (event-fed) so any panel or
    // widget consumer keeps honest numbers — only the floating canvas readout is gone.
    if (linkStaleDim) drawLinkDown(now);   // E1: honest "the live telemetry is not live" marker in the chrome
    // (station growth headline now lives in the top bar's STATION chip — see xpstore.pushTopbar)
    drawCurve(now); // barrel-warp the whole feed IN-CANVAS — the original (dot-matrix-era) curve, no dots
    drawCRT(now);   // scanlines + fade, painted in-canvas at device-px OVER the warped feed (no moiré)
    paintStageHeartbeat();   // the frame's last act: the one opaque pixel a dead stage context cannot fake (see watchStageLoss)
    // NOTE: the next rAF is scheduled by the frame() crash-guard wrapper, BEFORE this body runs — never here.
  }

  // ---- CRT SCANLINES + FADE (screen-space, drawn last, OVER the curved feed) --------
  // Runs AFTER drawCurve, so the scanlines sit straight on TOP of the already-warped picture and are
  // painted at EXACT device pixels (integer pitch/line) — no resampling, so no moiré. (The earlier CSS
  // overlay rasterised the line gradient against the display grid and beat into wide stripes; in-canvas
  // device-px lines, the proven desktop look, don't.) Honors body.no-scan.
  // SOFT scanline pattern — a smooth raised-cosine darkening per period, NOT hard on/off bars. Hard bars
  // carry sharp edges (lots of high-frequency harmonics) that beat into diagonal moiré stripes the moment
  // the canvas is resampled (display scaling, any non-1:1 mapping). A pure-sine profile carries only its
  // fundamental, so when scaled down it averages into gentle uniform dimming instead of striping, and at
  // 1:1 it still reads as CRT lines. Cached; rebuilt only when scan/pitch/dpr change.
  function scanCanvas(scan, pitch, dpr) {
    const P = Math.max(2, Math.round(pitch * dpr));
    const key = scan.toFixed(3) + '|' + P;
    if (_scanKey === key && _scanCv) return _scanCv;
    const pc = document.createElement('canvas'); pc.width = 1; pc.height = P;
    const pctx = pc.getContext('2d'), id = pctx.createImageData(1, P);
    for (let y = 0; y < P; y++) {
      const a = scan * (0.5 + 0.5 * Math.cos(2 * Math.PI * y / P));   // darkest at the line, smoothly transparent between
      id.data[y * 4] = 0; id.data[y * 4 + 1] = 0; id.data[y * 4 + 2] = 0; id.data[y * 4 + 3] = Math.round(a * 255);
    }
    pctx.putImageData(id, 0, 0);
    _scanCv = pc; _scanKey = key;
    return _scanCv;
  }
  // The station's own CRT is NOT user-optional — the feed is a tube, and the Appearance dial only
  // thins the screen-space glass over the HTML (style.css body.crt-dull). `no-scan` remains the one
  // and only suppressor here, and it is internal: scripts/verify-stars2.mjs sets it to flatten the
  // feed for star-pixel checks. Do not wire a settings class into this pass.
  function drawCRT(now) {
    if (!cv || document.body.classList.contains('no-scan')) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    if (CRT.scan > 0) {                               // soft neutral scanlines, drawn straight on top of the feed
      ctx.globalCompositeOperation = 'source-over';
      const sc = scanCanvas(CRT.scan, CRT.pitch, dpr);
      ctx.fillStyle = ctx.createPattern(sc, 'repeat'); ctx.fillRect(0, 0, W, H);
    }
    if (CRT.fade > 0) {                               // soft faded matte (cool-neutral, no yellow) — CRT.fade
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(' + Math.round(11 * CRT.fade) + ',' + Math.round(12 * CRT.fade) + ',' + Math.round(15 * CRT.fade) + ',1)';
      ctx.fillRect(0, 0, W, H);
    }
    if (CRT.grain > 0.001) {                          // FILM GRAIN — one cached noise tile, jittered per frame (CRT.grain)
      // 'overlay' around mid-gray so grain modulates without lifting black levels; the tile is built
      // ONCE and only its pattern offset changes each frame (a whole-number jitter derived from `now`,
      // quantized to ~15fps so it reads as phosphor noise, not smooth scrolling texture).
      const fi = Math.floor(now / 66);
      const jx = (fi * 53) % 128, jy = (fi * 97) % 128;
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = Math.min(0.25, CRT.grain);
      ctx.translate(jx, jy);
      ctx.fillStyle = grainPattern();
      ctx.fillRect(-jx, -jy, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // Cached 128px mid-gray noise tile for the film grain — built once, reused forever (only the
  // draw offset animates). Mid-gray (128) is the 'overlay' neutral, so ±spread is pure texture.
  function grainPattern() {
    if (_grainPat) return _grainPat;
    const S = 128;
    _grainCv = document.createElement('canvas'); _grainCv.width = S; _grainCv.height = S;
    const gctx = _grainCv.getContext('2d'), id = gctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = 128 + Math.round((Math.random() - 0.5) * 110);
      id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    gctx.putImageData(id, 0, 0);
    _grainPat = ctx.createPattern(_grainCv, 'repeat');
    return _grainPat;
  }

  // ---- BARREL CURVE — bows the whole feed like a CRT tube --------------------------------------
  // Same signed-off warp (f = 1 - curve·r²): the picture is pulled toward center as r² grows so the rooms
  // bow and the corners fall away into dark, plus the edge vignette (1 - CRT.vig·r²). Rendered as an EXACT
  // PER-PIXEL remap — each output pixel reads its source through a precomputed inverse-map LUT. NOT a
  // triangle mesh: a mesh draws the picture as thousands of triangles whose seams line up into the diagonal
  // stripes; a per-pixel remap has no triangles, so there are no seams and no diagonal lines. Curve is identical.
  // the two aperture knobs, clamped to sane ranges — read by BOTH warp paths so they can never disagree
  function vigAmt() { const v = +CRT.vig; return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0.30; }
  function overAmt() { const o = +CRT.over; return Number.isFinite(o) && o >= 1 ? (o > 1.6 ? 1.6 : o) : 1; }

  function buildLUT(k, W, H) {
    const over = overAmt();
    // overscan is part of the mapping, so it MUST key the cache — otherwise dragging it in crtlab would
    // silently keep serving the previous LUT and the CPU path would stop matching the GPU one.
    const key = k.toFixed(4) + '|' + over.toFixed(4) + '|' + W + 'x' + H;
    if (_lutKey === key && _lut) return;
    const hw = W / 2, hh = H / 2, lut = new Int32Array(W * H);
    for (let oy = 0; oy < H; oy++) {
      const ny = (oy + 0.5 - hh) / hh / over;
      for (let ox = 0; ox < W; ox++) {
        const nx = (ox + 0.5 - hw) / hw / over, ro = Math.sqrt(nx * nx + ny * ny);
        let scale = 1;
        if (ro > 1e-6) {                    // invert ro = rs·(1 - k·rs²) for rs (Newton); source dir = output dir
          let rs = ro;
          for (let it = 0; it < 6; it++) {
            const g = rs * (1 - k * rs * rs) - ro, dg = 1 - 3 * k * rs * rs;
            if (Math.abs(dg) < 1e-9) break;
            rs -= g / dg;
          }
          scale = rs / ro;
        }
        const sx = (hw + nx * scale * hw) | 0, sy = (hh + ny * scale * hh) | 0;
        lut[oy * W + ox] = (sx >= 0 && sx < W && sy >= 0 && sy < H) ? (sy * W + sx) : -1;
      }
    }
    _lut = lut; _lutKey = key;
  }
  function drawCurve(now) {
    if (!cv || CRT.curve <= 0 || document.body.classList.contains('no-scan')) return;
    const k = CRT.curve, W = cv.width, H = cv.height;
    if (!_glFailed && drawCurveGL(k, W, H)) return;   // GPU path (near-free); on any failure it flips _glFailed
    drawCurveCPU(k, W, H);                             // CPU fallback (per-pixel LUT) — identical look, heavier
  }

  // GPU barrel warp: upload the frame as a texture and remap it in a fragment shader (same inverse of
  // ro = rs·(1 - k·rs²), same vignette). No per-pixel CPU loop, no getImageData/putImageData → near-free.
  function initGL(W, H) {
    if (_glReady || _glFailed) return _glReady;
    try {
      _glc = document.createElement('canvas'); _glc.width = W; _glc.height = H;
      // A WebView/GPU reset reports context loss as WebGL state, not a JavaScript exception. Mark the GPU path
      // unusable immediately; the next drawCurve() frame takes the existing pixel-identical CPU warp.
      _glc.addEventListener('webglcontextlost', ev => {
        try { ev.preventDefault(); } catch (_) {}
        abandonCurveGL('WebGL context lost');
      }, false);
      _gl = _glc.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) ||
            _glc.getContext('experimental-webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!_gl) throw new Error('no webgl');
      const gl = _gl;
      const vs = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }';
      const fs = 'precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform float uK; uniform float uAberr; uniform float uVig; uniform float uOver;\n' +
        'void main(){\n' +
        // uOver shrinks the output radius BEFORE the inverse, so the corner lands inside the warp's reach
        // instead of falling out of domain and being filled black. uOver = 1.0 is the old behaviour exactly.
        '  vec2 n = (vUv-0.5)*2.0/uOver; float ro = length(n); float rs = ro;\n' +
        '  for(int i=0;i<6;i++){ float g = rs*(1.0-uK*rs*rs)-ro; float dg = 1.0-3.0*uK*rs*rs; rs = rs - g/dg; }\n' +
        '  float scale = ro>1e-5 ? rs/ro : 1.0; vec2 sUv = n*scale*0.5+0.5;\n' +
        '  if(sUv.x<0.0||sUv.x>1.0||sUv.y<0.0||sUv.y>1.0){ gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }\n' +
        // CHROMATIC ABERRATION (Slice 5a): fringe the channels along the radial direction, offset ∝ curve·r²,
        // so edges split R/B and the center stays clean. uAberr scales the whole effect (0 = none).
        '  vec3 col;\n' +
        '  if(uAberr>0.0001){\n' +
        '    vec2 dir = ro>1e-5 ? n/ro : vec2(0.0);\n' +
        '    float amt = uAberr * (0.008 + uK*0.06) * ro*ro;\n' +   // grows toward the bowed edges
        '    vec2 offs = dir * amt;\n' +
        '    float r = texture2D(uTex, sUv + offs).r;\n' +
        '    float gg = texture2D(uTex, sUv).g;\n' +
        '    float b = texture2D(uTex, sUv - offs).b;\n' +
        '    col = vec3(r, gg, b);\n' +
        '  } else { col = texture2D(uTex, sUv).rgb; }\n' +
        '  float vig = clamp(1.0-uVig*ro*ro, 0.0, 1.0);\n' +
        '  gl_FragColor = vec4(col*vig, 1.0);\n' +
        '}';
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one big triangle covers the quad
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      _glTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _glTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);   // NEAREST → crisp pixel art, matches the CPU path
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // canvas row 0 is top; flip so texcoords line up right-side-up
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
      _glKLoc = gl.getUniformLocation(prog, 'uK'); _glAberrLoc = gl.getUniformLocation(prog, 'uAberr');
      _glVigLoc = gl.getUniformLocation(prog, 'uVig'); _glOverLoc = gl.getUniformLocation(prog, 'uOver');
      _glProg = prog; _glReady = true;
      return true;
    } catch (e) { _gl = null; return abandonCurveGL('WebGL curve unavailable: ' + ((e && e.message) || String(e))); }
  }
  function drawCurveGL(k, W, H) {
    try {
      if (!initGL(W, H)) return false;
      const gl = _gl;
      if (glContextLost(gl)) return abandonCurveGL('WebGL context lost before draw');
      if (_glc.width !== W || _glc.height !== H) { _glc.width = W; _glc.height = H; }
      if (glContextLost(gl)) return abandonCurveGL('WebGL context lost during resize');
      // OUTPUT SANITY PROBE (2026-07-20, the mac theme-wash report): the warp only MOVES pixels and
      // applies a channel-NEUTRAL vignette, so the frame's global per-channel ratios must survive it.
      // WKWebView's GL sits on a different backend (ANGLE-on-Metal) than Windows — a channel-order/
      // tint divergence there recolors the ENTIRE feed while every 2D pass stays correct. Compare the
      // whole frame's channel ratios (16×16 GPU downscale, ~1KB read) before/after on a few chromatic
      // frames; on divergence, warn with both readings and hand the session to drawCurveCPU
      // (pixel-identical by construction). Zero cost after validation.
      const probing = !_glProbeOk && _glProbeTries < 30 && (_glProbeSkip++ % 45) === 0;
      let pre = null;
      if (probing) { try { pre = probeMeans(cv); } catch (_) { _glProbeTries = 30; pre = null; } }
      gl.viewport(0, 0, W, H);
      gl.bindTexture(gl.TEXTURE_2D, _glTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);   // upload the composited frame
      gl.uniform1f(_glKLoc, k);
      if (_glAberrLoc) gl.uniform1f(_glAberrLoc, Math.max(0, CRT.aberr || 0));
      if (_glVigLoc) gl.uniform1f(_glVigLoc, vigAmt());
      if (_glOverLoc) gl.uniform1f(_glOverLoc, overAmt());
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // Context loss is deliberately checked AGAIN after GPU work and BEFORE the destructive clear below.
      // WebGL commands on a lost context are specified to no-op instead of throwing; without this guard the
      // dead offscreen canvas is copied over a healthy 2D frame and the camera feed goes permanently black.
      if (glContextLost(gl)) return abandonCurveGL('WebGL context lost during draw');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H); ctx.drawImage(_glc, 0, 0);   // blit the warped result back onto the visible feed
      if (pre) {
        const post = probeMeans(cv);   // cv now holds the blitted GL output
        const preSum = pre[0] + pre[1] + pre[2], postSum = post[0] + post[1] + post[2];
        const fail = why => {
          console.warn('[crt] WebGL warp output diverges from its source (in ' + pre.map(v => v.toFixed(0))
            + ' → out ' + post.map(v => v.toFixed(0)) + ', ' + why
            + ') — platform GL bug; switching to the identical CPU warp');
          _glFailed = true;   // this frame already blitted; every following frame takes drawCurveCPU
        };
        if (preSum >= 15) {   // a lit frame carries full judgment; each consumes one bounded try
          _glProbeTries++;
          const spr = m => { const s = m[0] + m[1] + m[2]; if (s <= 0) return 0; return (Math.max(m[0], m[1], m[2]) - Math.min(m[0], m[1], m[2])) / s; };
          // a healthy warp DARKENS a little (vignette) and never invents chroma; the failure class
          // seen in the wild is a wildly brighter/saturated wash, so judge magnitude + minted tint,
          // plus channel-ratio drift when the source frame carries real chroma to compare.
          const plausibleMag = postSum >= preSum * 0.35 - 8 && postSum <= preSum * 1.15 + 12;
          const mintedTint = spr(post) > spr(pre) + 0.15;
          let ratioDrift = false;
          if (spr(pre) >= 0.04 && postSum > 0) {
            const ri = pre.map(v => v / preSum), ro = post.map(v => v / postSum);
            ratioDrift = (Math.abs(ri[0] - ro[0]) + Math.abs(ri[1] - ro[1]) + Math.abs(ri[2] - ro[2])) > 0.08;
          }
          if (!plausibleMag || mintedTint || ratioDrift) fail(!plausibleMag ? 'implausible magnitude' : mintedTint ? 'minted tint' : 'channel-ratio drift');
          else if (++_glProbeClean >= 3) _glProbeOk = true;   // three clean readings — trust this GL stack for the session
        } else if (postSum > preSum * 1.15 + 45) {
          // the reported mac scenario EXACTLY: the wash appeared over the DARK awakening — a
          // near-black input cannot brighten through a darkening warp, so this alone is damning.
          // No try consumed on dark frames either way: a long dark scene must never exhaust the
          // probe budget before the room first lights.
          fail('bright output minted from a dark input');
        }
      }
      return true;
    } catch (e) { return abandonCurveGL('WebGL curve draw failed: ' + ((e && e.message) || String(e))); }
  }
  function drawCurveCPU(k, W, H) {
    const hw = W / 2, hh = H / 2;
    if (!_warpCv) { _warpCv = document.createElement('canvas'); _warpCtx = _warpCv.getContext('2d', { willReadFrequently: true }); }
    if (_warpCv.width !== W || _warpCv.height !== H) { _warpCv.width = W; _warpCv.height = H; }
    _warpCtx.setTransform(1, 0, 0, 1, 0, 0); _warpCtx.clearRect(0, 0, W, H); _warpCtx.drawImage(cv, 0, 0);
    buildLUT(k, W, H);
    const src = _warpCtx.getImageData(0, 0, W, H), s32 = new Uint32Array(src.data.buffer);
    if (!_outImg || _outImg.width !== W || _outImg.height !== H) _outImg = ctx.createImageData(W, H);
    const d32 = new Uint32Array(_outImg.data.buffer), lut = _lut, BLACK = 0xFF000000;
    for (let i = 0; i < d32.length; i++) { const s = lut[i]; d32[i] = s < 0 ? BLACK : s32[s]; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.putImageData(_outImg, 0, 0);
    // Edge vignette — the exact darkening complement of the shader's `1 - uVig·ro²`, so the CPU fallback
    // stays pixel-equivalent to the GPU path (drawCurveGL's probe compares them). A stop at gradient
    // fraction t sits at panel radius t·√2, which the shader sees as ro = t·√2/over, hence alpha = vig·ro².
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.translate(hw, hh); ctx.scale(hw, hh);
    const vAmt = vigAmt(), o2 = overAmt() * overAmt();
    const vAlpha = t => Math.max(0, Math.min(1, vAmt * 2 * t * t / o2)).toFixed(4);
    const vg = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT2);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.5, 'rgba(0,0,0,' + vAlpha(0.5) + ')');       // r²≈0.5
    vg.addColorStop(0.707, 'rgba(0,0,0,' + vAlpha(0.707) + ')');   // r²≈1 (edge midpoints)
    vg.addColorStop(1, 'rgba(0,0,0,' + vAlpha(1) + ')');           // r²≈2 (corners)
    ctx.fillStyle = vg; ctx.fillRect(-Math.SQRT2, -Math.SQRT2, 2 * Math.SQRT2, 2 * Math.SQRT2);
    ctx.restore();
  }

  function drawGlows(now) {
    if (!cache || !cache.flickers) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of cache.flickers) {
      const a = Math.max(0, CRT.glow * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(238,218,184,' + a + ')'); g.addColorStop(1, 'rgba(238,218,184,0)');
      ctx.fillStyle = g; ctx.fillRect(f.x - f.r * 0.7, f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // Slice 3 — DUST MOTES. Tiny specks drifting slowly THROUGH the baked light pools (only there — a mote
  // is only visible where light catches it). Purely cosmetic atmosphere; never encodes agent/run state.
  // Deterministic from `now` + each fixture's position seed (no state array, no per-frame allocation —
  // the awakening-motes idiom at drawAwakenLight). ~2-3 motes per fixture, additive, each breathing its
  // alpha 0→~0.35→0 over a long period with a gentle sinusoidal drift confined to the pool radius.
  // Steady (motes hidden) under prefers-reduced-motion; CRT.dust scales/zeroes the whole effect.
  function drawDust(now) {
    if (!cache || !cache.flickers || CRT.dust <= 0.001 || reduceMotion()) return;
    ctx.globalCompositeOperation = 'lighter';
    const amp = CRT.dust;
    for (const f of cache.flickers) {
      const per = 3;                                   // 2-3 motes per fixture
      const R = f.r * 0.5;                             // keep motes inside the visible pool
      for (let k = 0; k < per; k++) {
        const seed = (f.x * 0.11 + f.y * 0.07) + k * 2.399;
        // slow, long-period drift — each mote traces a lazy Lissajous within the pool
        const dx = Math.sin(now / (5200 + k * 900) + seed) * R * 0.7;
        const dy = Math.cos(now / (6100 + k * 700) + seed * 1.7) * R * 0.5;
        // alpha breathes 0 → ~0.35 → 0 over a long, per-mote period (fully off part of the cycle)
        const br = 0.5 + 0.5 * Math.sin(now / (3400 + k * 600) + seed * 2.3);
        const a = amp * 0.35 * br * br;               // squared → longer dark valleys, brief glints
        if (a < 0.01) continue;
        const mx = f.x + dx, my = f.y + dy;
        ctx.fillStyle = 'rgba(246,240,220,' + a.toFixed(3) + ')';
        ctx.fillRect(mx - 0.5, my - 0.5, 1.2, 1.2);   // ~1px speck
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // THE KINDLING render — a dim dormant ember the user's hold brings to life: it brightens and pulls motes
  // inward as kindleP fills, under a screen-space prompt ("hold to wake it") + an awareness bar. Pre-ignition.
  function drawKindle(now) {
    if (!kindleArmed && kindleP <= 0) return;
    const p = kindleP;
    if (agent && !agent.unplaced) {
      const hx = agent.px, hy = agent.py - 12;
      ctx.globalCompositeOperation = 'lighter';
      const breathe = 0.6 + 0.4 * Math.sin(now / (kindleHolding ? 200 : 900));   // faster pulse while held
      const er = 2 + p * 11, a = Math.min(1, (0.10 + 0.9 * p) * (0.65 + 0.35 * breathe));
      const g = ctx.createRadialGradient(hx, hy, 0.4, hx, hy, er + 3);
      g.addColorStop(0, 'rgba(255,240,205,' + a.toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,240,205,0)');
      ctx.fillStyle = g; ctx.fillRect(hx - er - 3, hy - er - 3, (er + 3) * 2, (er + 3) * 2);
      const n = Math.floor(4 + 11 * p);   // motes pulled inward as it kindles
      for (let k = 0; k < n; k++) {
        const seed = k * 1.7, ang = now / 1300 + seed * 2.4, rad = (17 - 12 * p) + (k % 4) * 3 + Math.sin(now / 600 + seed) * 2;
        const mx = hx + Math.cos(ang) * rad, my = hy + Math.sin(ang) * rad * 0.5;
        ctx.fillStyle = 'rgba(255,244,214,' + (0.32 * p).toFixed(3) + ')';
        ctx.fillRect(mx - 0.6, my - 0.6, 1.4, 1.4);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const cw = cv.width, ch = cv.height;
    const promptA = (1 - p) * (0.45 + 0.55 * Math.abs(Math.sin(now / 700)));   // a breathing prompt that fades as it fills
    if (promptA > 0.02) {
      const label = (kindlePeak > 0.12 && !kindleHolding && p > 0.01) ? 'don’t stop —' : 'hold to wake it';
      ctx.font = "16px 'VT323', 'Courier New', monospace";
      ctx.fillStyle = 'rgba(255,170,60,' + promptA.toFixed(3) + ')';
      ctx.fillText(label, cw / 2, ch * 0.74);
    }
    const bw = Math.min(260, cw * 0.42), bh = 6, bx = Math.round((cw - bw) / 2), by = Math.round(ch * 0.78);   // the awareness bar
    ctx.fillStyle = 'rgba(8,10,9,0.55)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,170,60,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffcf6a'; ctx.fillRect(bx + 1, by + 1, Math.max(0, (bw - 2) * p), bh - 2);
    ctx.textAlign = 'left';
    ctx.setTransform(scale, 0, 0, scale, panX, panY);
  }

  // the soul kindling: an ignition spark at the head, a halo that grows with consciousness, drifting motes.
  function drawAwakenLight(now) {
    if (!agent || agent.unplaced) return;
    const live = awakeFrozen || (dawnAt && now - dawnAt < 1200);
    if (!live && !(sparkAt && now - sparkAt < 1200)) return;
    const prog = Math.max(0, Math.min(1, 1 - wakeDark / 0.92));
    const pulse = (truthPulseAt && now - truthPulseAt < 360) ? (1 - (now - truthPulseAt) / 360) : 0;   // a flare as each truth is written in
    const hx = agent.px, hy = agent.py - 12;
    ctx.globalCompositeOperation = 'lighter';
    // halo
    const hr = 14 + prog * 30 + pulse * 10;
    let g = ctx.createRadialGradient(hx, hy, 1, hx, hy, hr);
    g.addColorStop(0, 'rgba(255,236,200,' + (0.05 + 0.13 * prog + pulse * 0.12).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = g; ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    // ignition spark — the discrete instant the mind catches fire (the ONLY light in the dark)
    if (sparkAt && now - sparkAt < 1100) {
      const t = (now - sparkAt) / 1100;
      const flick = t < 0.4 ? (Math.sin(now / 26) > 0 ? 1 : 0.35) : 1;
      const sr = 2 + t * 9, a = flick * (t < 0.5 ? 0.95 : Math.max(0, 0.95 * (1 - (t - 0.5) / 0.5)));
      const gs = ctx.createRadialGradient(hx, hy, 0.5, hx, hy, sr);
      gs.addColorStop(0, 'rgba(255,252,240,' + a.toFixed(3) + ')'); gs.addColorStop(1, 'rgba(255,252,240,0)');
      ctx.fillStyle = gs; ctx.fillRect(hx - sr, hy - sr, sr * 2, sr * 2);
    }
    // motes of consciousness — slow orbital, thicken as it wakes (computed from time, no state to leak)
    if (live) {
      const n = Math.floor(5 + 9 * prog);
      for (let i = 0; i < n; i++) {
        const seed = i * 1.7, ang = now / 1500 + seed * 2.4, rad = 9 + (i % 5) * 4 + Math.sin(now / 760 + seed) * 2;
        const mx = hx + Math.cos(ang) * rad, my = hy + Math.sin(ang) * rad * 0.5;
        const tw = 0.3 + 0.5 * Math.abs(Math.sin(now / 520 + seed));
        ctx.fillStyle = 'rgba(255,244,214,' + (0.38 * tw * (0.4 + 0.6 * prog)).toFixed(3) + ')';
        ctx.fillRect(mx - 0.6, my - 0.6, 1.4, 1.4);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // dawn bloom — a brief warm wash flooding the whole room as the veil reaches light
  function drawDawnBloom(now) {
    const t = (now - dawnAt) / 1300, a = Math.sin(Math.min(1, t) * Math.PI) * 0.2;
    if (a <= 0.003) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter';
    const cx = cv.width / 2, cy = cv.height * 0.46, r = Math.max(cv.width, cv.height) * 0.75;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,214,150,' + a.toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,214,150,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(scale, 0, 0, scale, panX, panY);
  }
  // THE FLOOD — screen-space matrix-rain of real prompt/capability fragments + glyph noise; ramps to
  // overwhelming density, then collapses every glyph inward into the newborn. Amber/gold phosphor to sit
  // with the CRT + dawn palette; hot-white leading glyph. Self-terminating once the collapse completes.
  function drawFlood(now) {
    if (!floodAt || !floodStreams) return;
    const t = now - floodAt;
    const rampIn = Math.min(1, t / 1400);
    let collapse = 0;
    if (floodEndAt) {
      collapse = (now - floodEndAt) / 1000;
      if (collapse >= 1) { floodAt = 0; floodEndAt = 0; floodStreams = null; return; }
    }
    const ec = collapse <= 0 ? 0 : (collapse < 0.5 ? 2 * collapse * collapse : 1 - Math.pow(-2 * collapse + 2, 2) / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter'; ctx.textBaseline = 'top';
    let ax = cv.width / 2, ay = cv.height * 0.46;
    if (agent && !agent.unplaced) { ax = agent.px * scale + panX; ay = (agent.py - 8) * scale + panY; }
    const lineH = 15, H = cv.height, span = (Math.ceil(H / lineH) + 9) * lineH, tail = 8;
    const base = rampIn * (1 - ec * 0.9);
    for (const st of floodStreams) {
      const tt = t - st.delay; if (tt < 0) continue;
      const x = st.x * cv.width;
      ctx.font = st.size + 'px VT323, monospace';
      const headRow = Math.floor((tt / 1000 * st.speed) / lineH);
      for (let k = 0; k < tail; k++) {
        const row = headRow - k;
        let y = (row * lineH) % span; if (y < 0) y += span; y -= tail * lineH;
        if (y < -lineH || y > H) continue;
        let a = base * (k === 0 ? 1 : Math.max(0, (1 - k / tail)) * 0.62);
        let dx = x, dy = y;
        if (ec > 0) { dx = x + (ax - x) * ec; dy = y + (ay - y) * ec; a *= (1 - ec); }
        if (a <= 0.02) continue;
        const tok = st.toks[((row % st.len) + st.len) % st.len];
        ctx.fillStyle = k === 0 ? 'rgba(255,250,235,' + Math.min(1, a * 1.25).toFixed(3) + ')' : 'rgba(255,200,120,' + a.toFixed(3) + ')';
        ctx.fillText(tok, dx, dy);
      }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.textBaseline = 'alphabetic'; ctx.setTransform(scale, 0, 0, scale, panX, panY);   // restore the baseline we changed, so later text drawers don't inherit 'top'
  }

  /* A BODY ASLEEP IN A BED. Two things make the pose read, and both live here rather than in drawAgent
     (which must stay the one path every normal body draws through):
       1. the render anchor is refreshed from the LAST drawn frame (bedAnchor) so the head lands on the
          pillow whatever skin this body wears;
       2. the sprite is CLIPPED to the bed's top plane, so a body taller than the mattress cannot hang
          out past the foot of the bed. Everything from the chest down is then buried by the quilt,
          which the item after this one paints (PropSprites.drawOver).
     The clip is a rect in world space — the same transform the props draw under — and is released
     before anything else paints. */
  function drawSleeper(now, who, bed) {
    const a = bedAnchor(bed, who);
    who.seated = true; who.seatPx = a.px; who.seatPy = a.py;   // the claim already exists; this is only WHERE it draws
    ctx.save();
    ctx.beginPath();
    ctx.rect(bed.x * T, bed.y * T - 3, (bed.w || 1) * T, (bed.h || 1) * T - 5);   // the top plane (frame rim to the south face)
    ctx.clip();
    drawAgent(now, who);
    ctx.restore();
  }
  function drawAgent(now, who) {
    who = who || agent;   // default = the hero; a crew body passes itself. Hero path is byte-identical (who===agent).
    // voice cues animate the body while the HERO is actually speaking + a "listening" foot-pulse when the mic is
    // live (drawBody/drawFallback read who.speaking). Crew bodies don't use Voice, so these are hero-only.
    const listening = (who === agent) && (typeof Voice !== 'undefined' && Voice.isListening && Voice.isListening());
    // W4: `speaking` is no longer only the hero's VOICE — a body taking its turn in a silent
    // exchange sets `talking` (see talkTurn), and the hero must OR the two or its own conversation
    // pose would be stomped back to false every frame by the Voice read below.
    if (who === agent) who.speaking = (typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking()) || !!who.talking;
    // while seated on a couch the agent draws on the cushion, not its (adjacent) logical tile — swap
    // px/py for the draw and restore after, so movement/pathing keep using the real logical position.
    const ox = who.px, oy = who.py;
    if (who.seated) { who.px = who.seatPx; who.py = who.seatPy; }
    try {
      // color-into-being: the body fades up from a faint silhouette to full as the spark blooms (HERO only)
      let bornA = 1;
      if (who === agent && bornAt && now - bornAt < 1000) bornA = 0.16 + 0.84 * ((now - bornAt) / 1000);
      const prevA = ctx.globalAlpha;
      if (bornA < 1) ctx.globalAlpha = prevA * bornA;
      let geom = null;
      if (typeof SPRITES !== 'undefined' && SPRITES.ready) geom = SPRITES.drawBody(ctx, who, now);
      // Do not flash the cyan procedural body while the real default skin is actively loading.
      // A genuine load failure still clears `loading` and gets the honest fallback on the next frame.
      if (!geom && !(typeof SPRITES !== 'undefined' && SPRITES.loading)) drawFallback(now, who);
      // remember the visible head-top (world px) so overlays (nameplate, speech bubble) anchor
      // above the ACTUAL drawn sprite — skins are taller than the old 15px assumption, which
      // parked bubbles over the face. Fallback bodies keep the legacy 15px estimate (null).
      who.visTopPy = geom ? geom.top : null;
      ctx.globalAlpha = prevA;
      // the wake ripple — a triple-ringed sonar pulse of first breath, in the suit color (hero's awakening
      // uses the module wakeAt; a crew body uses its own per-body wakeAt set when it receives work)
      const wa = (who === agent) ? wakeAt : (who.wakeAt || 0);
      if (wa && now - wa < 1500) {
        ctx.save(); ctx.strokeStyle = who.color;
        for (let k = 0; k < 3; k++) {
          const tk = (now - wa) / 1300 - k * 0.18;
          if (tk <= 0 || tk >= 1) continue;
          ctx.globalAlpha = (1 - tk) * 0.6 * (1 - k * 0.22); ctx.lineWidth = Math.max(0.5, 1.5 - tk);
          ctx.beginPath(); ctx.ellipse(who.px, who.py, 4 + tk * 22, 2 + tk * 9, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
      // SUMMONED-WORKER "working" glow — a soft sustained pulse at the feet of a crew body while ITS real run
      // is in flight (workUntil set by setActivityFor). The honest "this agent is actually working" cue for a
      // deskless summoned worker; hero-exempt (the hero shows work at its desk).
      if (who !== agent && who.workUntil && now < who.workUntil) {
        const wp = 0.35 + 0.25 * Math.sin(now / 360);
        ctx.save(); ctx.globalAlpha = wp * 0.7; ctx.strokeStyle = who.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(who.px, who.py, 7 + 1.5 * Math.sin(now / 360), 3, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      // the LEVEL-UP surge: a brief GOLD phosphor bloom localized to this body — a bloom pulse behind the
      // sprite + the same sonar ring as waking. Time-limited (~1.2s), driven by who.levelUpAt (set in
      // pulseLevelUp); piggybacks this render pass (no rAF added). Under reduced motion the moving ring is
      // dropped and only a brief steady bloom remains (an honest "it happened" cue without strobe/travel).
      const lva = (who && who.levelUpAt) || ((who === agent) ? levelUpAt : 0);
      if (lva && now - lva < 1200) {
        const lt = (now - lva) / 1200;                    // 0..1 across the surge window
        // the phosphor BLOOM: a soft radial gold glow that swells early then fades — the "surge" itself
        const bloom = Math.sin(Math.min(1, lt * 1.9) * Math.PI);   // 0→1→0, peaks ~mid
        if (bloom > 0.01) {
          ctx.save();
          ctx.shadowBlur = 16 * bloom; ctx.shadowColor = '#ffd45a';
          ctx.globalAlpha = 0.30 * bloom; ctx.fillStyle = '#ffd45a';
          ctx.beginPath(); ctx.ellipse(who.px, who.py - 5, 6 + 4 * bloom, 8 + 5 * bloom, 0, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        if (!reduceMotion()) {
          ctx.save(); ctx.strokeStyle = '#ffd45a';
          for (let k = 0; k < 3; k++) {
            const tk = (now - lva) / 1300 - k * 0.18;
            if (tk <= 0 || tk >= 1) continue;
            ctx.globalAlpha = (1 - tk) * 0.7 * (1 - k * 0.2); ctx.lineWidth = Math.max(0.5, 1.6 - tk);
            ctx.beginPath(); ctx.ellipse(who.px, who.py, 5 + tk * 26, 2.5 + tk * 11, 0, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.restore();
        }
      }
      // a soft "I'm listening to you" pulse at the feet — an in-world cue the mic is open and he's hearing
      // you (distinct from just standing facing the Commander). Only while the mic is actually live (hero).
      if (listening) {
        const lp = 0.4 + 0.35 * Math.sin(now / 320);
        ctx.save(); ctx.globalAlpha = lp * 0.7; ctx.strokeStyle = who.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(who.px, who.py, 8 + 2 * Math.sin(now / 320), 3.5, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    } finally { who.px = ox; who.py = oy; }
  }

  function drawFallback(now, who) {
    const a = who || agent, x = Math.round(a.px), y = Math.round(a.py), h = 13;
    const step = a.state === 'walk' ? (Math.floor(now / 140) % 2) : 0;
    const bob = (a.state !== 'walk' && !a.sitting)
      ? Math.round(a.speaking ? Math.sin(now / 170 + a.phase) * 1.1 : Math.sin(now / 600 + a.phase) * 0.7) : 0;
    // same pooled contact shadow the sprite bodies get (SPRITES.groundShadow needs no loaded
    // assets, so the fallback — which runs precisely when they FAILED to load — still gets it).
    if (typeof SPRITES !== 'undefined' && SPRITES.groundShadow) SPRITES.groundShadow(ctx, x, y, 5, { lift: -bob });
    else { ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.fillRect(x - 4, y - 1, 8, 2); ctx.globalAlpha = 1; }
    const top = y - h + bob;
    ctx.fillStyle = a.color; ctx.fillRect(x - 3, top + 3, 6, h - 6);
    ctx.fillStyle = '#f0e6c0'; ctx.fillRect(x - 2, top, 5, 4);
    ctx.fillStyle = U.shade(a.color, -0.45);
    if (a.sitting) ctx.fillRect(x - 3, y - 3, 6, 2);
    else { ctx.fillRect(x - 3 + (step ? 1 : 0), y - 2, 2, 2); ctx.fillRect(x + 1 - (step ? 1 : 0), y - 2, 2, 2); }
  }

  /* ---------- hover nameplate: a compact terminal tag for the agent under the cursor ----------
     Screen-space (always sharp — not the zoom-blurred world-space sliver it replaced): a slim CRT
     plate in the station's own VT323 face (the same font stack the DOM uses, so it matches whether
     VT323 is loaded or falls back to Courier), with a faint phosphor glow + scanlines. Codename,
     level, and the 1px XP-to-next sliver along the bottom all share the suit color — one tiny extra.
     Anchored just above the head, clamped to the viewport. Intentionally small: a glance, not a window. */
  const PLATE_FONT = '"VT323","Courier New",monospace';   // the station terminal face (mirrors the body font stack)
  function floorDisplayName(who) {
    const raw = String((who && who.name) || '');
    const key = raw.trim().toUpperCase();
    const bodies = [agent].concat(crew || []).filter(Boolean);
    const duplicate = key && bodies.filter(b => String(b.name || '').trim().toUpperCase() === key).length > 1;
    return duplicate ? raw + ' [' + String(who.id || who.agentId || '') + ']' : raw;
  }
  function drawNameplate(now, who) {
    who = who || agent;
    if (!cache || !who) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const Wc = cv.width / dpr, Hc = cv.height / dpr;
    const suit = who.color || '#ffaa33';
    const name = floorDisplayName(who);
    // per-body XP: the hero keeps its exact xpByAgent-or-xpAgent fallback; a crew body reads its own snapshot
    const xp = xpByAgent.get(who.id) || (who === agent ? xpAgent : null);
    const lvl = (xp && xp.level) ? ('Lv ' + xp.level) : null;
    const frac = (xp && typeof xp.frac === 'number') ? Math.max(0, Math.min(1, xp.frac)) : 0;

    const nameSz = 17, lvlSz = 16;
    ctx.font = nameSz + 'px ' + PLATE_FONT; const nameW = ctx.measureText(name).width;
    ctx.font = lvlSz + 'px ' + PLATE_FONT;  const lvlW = lvl ? ctx.measureText(lvl).width : 0;
    const padX = 8, gap = lvl ? 9 : 0, h = 21, barH = 2;
    const w = Math.round(padX * 2 + nameW + gap + lvlW);

    // anchor centered just above the head, crisp + clamped to the canvas
    const ax = (bodyPosX(who) * scale + panX) / dpr, ay = (bodyPosY(who) * scale + panY) / dpr;
    // same head-top anchor as drawBubble: real drawn geometry when known, legacy 15px estimate otherwise
    const topY = (who.visTopPy != null) ? (who.visTopPy * scale + panY) / dpr : ay - 15 * scale / dpr;
    const x = Math.round(Math.max(4, Math.min(Wc - w - 4, ax - w / 2)));
    const y = Math.round(Math.max(4, Math.min(Hc - h - 4, topY - 9 - h)));

    // plate: dark CRT glass + scanlines + an amber structural frame with a suit accent along the top
    ctx.fillStyle = 'rgba(6,5,4,0.92)'; ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.13; ctx.fillStyle = '#000';
    for (let sy = y + 2; sy < y + h - 1; sy += 3) ctx.fillRect(x + 1, sy, w - 2, 1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#b9791c'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 0.6; ctx.fillStyle = suit; ctx.fillRect(x + 1, y, w - 2, 1); ctx.globalAlpha = 1;

    // codename (suit) + level (gold) in VT323, with a faint phosphor bloom (mirrors the DOM text-shadow)
    const tcy = y + Math.round((h - barH) / 2) + 1;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.shadowBlur = 4; ctx.shadowColor = suit;
    ctx.font = nameSz + 'px ' + PLATE_FONT; ctx.fillStyle = suit; ctx.fillText(name, x + padX, tcy);
    if (lvl) {
      // LEVEL-UP GLINT: right after a level gain the "Lv N" ticks to a gold bloom and settles back to the
      // suit colour over ~1.2s — the plate number itself catches the light. Piggybacks this draw; no timer.
      const lva = who.levelUpAt || (who === agent ? levelUpAt : 0) || 0;
      const gt = lva ? (now - lva) / 1200 : 1;   // now is the shared render clock (fnow); >=1 → settled
      if (gt >= 0 && gt < 1) {
        const glint = Math.sin(Math.min(1, gt * 1.7) * Math.PI);   // 0→1→0 over the window
        ctx.shadowBlur = 4 + 8 * glint; ctx.shadowColor = '#ffd45a';
        // the number catches the light: the suit hue lifted toward a bright gold-white at the glint peak
        ctx.fillStyle = (U && U.shade) ? U.shade(suit, 0.55 * glint) : suit;
      } else {
        ctx.shadowColor = suit; ctx.fillStyle = suit;
      }
      ctx.font = lvlSz + 'px ' + PLATE_FONT; ctx.fillText(lvl, x + padX + nameW + gap, tcy);
    }
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

    // the one tiny useful extra: a hairline XP-to-next bar along the bottom inside edge (honest — hidden at 0)
    if (frac > 0) {
      const bx0 = x + 1, bw0 = w - 2, byb = y + h - barH - 1;
      ctx.fillStyle = '#140c03'; ctx.fillRect(bx0, byb, bw0, barH);
      ctx.fillStyle = suit; ctx.fillRect(bx0, byb, Math.max(1, Math.round(bw0 * frac)), barH);
    }
  }

  /* ---------- the RUN CLOCK (G0.2): tiny elapsed-time tag at each working desk ----------
     A live harness run has NO knowable percent, so the desk shows the one thing that IS knowable:
     how long the run has actually been going (agent.run.start -> .end, runStartByAgent). World-space,
     the station's VT323 terminal face with a faint phosphor bloom — a glance, never a window. */
  const RUN_FONT = "7px 'VT323','Courier New',monospace";
  function drawRunClocks(now) {
    if (!runStartByAgent.size) return;
    ctx.save();
    if (linkStaleDim) ctx.globalAlpha = 0.3;   // E1: link down → these clocks are last-known, not live; dim them
    for (const [aid, t0] of runStartByAgent) {
      const b = bodyForAgent(aid);
      if (!b || b.unplaced) continue;
      // only at a desk that is honestly in the working pose — a talk-only run never grows a clock
      const working = (b === agent) ? !!agent.working : !!(b.working || (b.workUntil && now < b.workUntil));
      if (!working) continue;
      const sec = Math.max(0, Math.floor((now - t0) / 1000));
      const mm = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
      const label = 'RUN ' + (mm >= 60 ? Math.floor(mm / 60) + ':' + String(mm % 60).padStart(2, '0') + ':' + ss : mm + ':' + ss);
      // anchor beside the desk's crown (placed workstation, or the hero's synthetic desk), else above the body
      let ax, ay;
      const dp = deskPropFor(aid);
      if (dp) { ax = (dp.x + (dp.w || 1)) * T + 1; ay = dp.y * T + 3; }
      else if (b === agent && desk) { ax = (desk.tx + desk.w) * T + 1; ay = desk.ty * T + 3; }
      else { ax = b.px + 7; ay = b.py - 16; }
      ctx.save();
      ctx.font = RUN_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.shadowBlur = 3; ctx.shadowColor = '#62ff9e';
      ctx.fillStyle = '#9adcb0';
      ctx.fillText(label, ax, ay);
      ctx.restore();
    }
    ctx.restore();   // E1: close the link-stale dim wrapper
  }

  /* ---------- the DESK WORK-GLYPH (stage ticker STRETCH): a tiny "▸ TOOL" tag at a desk while that agent has
     a tool in flight (agent.tool_call → its tool_result, tracked in glyphByAgent). Complements the RUN clock
     (which sits at the crown, y+3) by sitting one line BELOW it (y+13) so the two never collide. World-space,
     VT323 amber phosphor like drawRunClocks; event-driven state, zero cost when nothing is in flight. */
  const GLYPH_FONT = "8px 'VT323','Courier New',monospace";
  function drawWorkGlyphs(now) {
    if (!glyphByAgent.size) return;
    for (const [aid, g] of glyphByAgent) {
      const b = bodyForAgent(aid);
      if (!b || b.unplaced) continue;
      const working = (b === agent) ? !!agent.working : !!(b.working || (b.workUntil && now < b.workUntil));
      if (!working) continue;
      const label = '▸ ' + tickerTool(g && g.name);
      // anchor beside the same desk the run clock uses, but one line lower (RUN clock is at dp.y*T+3).
      let ax, ay;
      const dp = deskPropFor(aid);
      if (dp) { ax = (dp.x + (dp.w || 1)) * T + 1; ay = dp.y * T + 13; }
      else if (b === agent && desk) { ax = (desk.tx + desk.w) * T + 1; ay = desk.ty * T + 13; }
      else { ax = b.px + 7; ay = b.py - 6; }
      ctx.save();
      ctx.font = GLYPH_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.shadowBlur = 4; ctx.shadowColor = '#ffae3a';
      ctx.fillStyle = '#ffc978';
      ctx.fillText(label, ax, ay);
      ctx.restore();
    }
  }

  /* ---------- the AWAIT tag (G4 feature 1): a tiny amber "AWAITING APPROVAL" plate above the blocked hero.
     World-space, VT323 with an amber phosphor bloom (the consent-warning colour), a slow blink so it reads as
     a live pending state — a glance, never a window. Only while the hero is genuinely blocked (awaitPrompt). */
  const AWAIT_FONT = "8px 'VT323','Courier New',monospace";
  function drawAwaitTag(now) {
    if (!awaitPrompt || !agent || agent.unplaced) return;
    const x = rposX(), y = rposY();
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 380));   // slow breathing so it never looks frozen
    const label = 'AWAITING APPROVAL';
    ctx.save();
    ctx.font = AWAIT_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const tw = ctx.measureText(label).width, ty = y - 22, pad = 3;
    // a small dark plate behind the text so it stays legible over any floor
    ctx.globalAlpha = 0.72; ctx.fillStyle = '#160d02';
    ctx.fillRect(x - tw / 2 - pad, ty - 9, tw + pad * 2, 12);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 5; ctx.shadowColor = '#ffae3a';
    ctx.fillStyle = `rgba(255,201,120,${pulse.toFixed(3)})`;
    ctx.fillText(label, x, ty);
    // a tiny blinking caret so the "still waiting" read is unmistakable
    if (Math.sin(now / 300) > 0) { ctx.fillStyle = '#ffd9a3'; ctx.fillRect(x + tw / 2 + pad + 1, ty - 7, 1, 8); }
    ctx.restore();
  }

  /* ---------- the PIN FLOURISH (G4 feature 2): a brief amber pin-burst at the MISSION BOARD the instant the
     agent pins a proposal there. World-space, over the board; a short expanding ring of amber motes + a "PINNED"
     phosphor tick. Self-expires (~900ms). A juicy confirmation that the proposal now has a body. */
  function drawPinFlourish(now) {
    const DUR = 900;
    if (now - pinFlourishAt > DUR || !geo || !geo.props) return;
    const board = geo.props.find(p => p && p.t === 'missionboard');
    if (!board) return;
    const cx = (board.x + (board.w || 1) / 2) * T, cy = (board.y) * T + 4;
    const t = (now - pinFlourishAt) / DUR, e = 1 - Math.pow(1 - t, 2), a = (1 - t);
    ctx.save();
    ctx.globalAlpha = 0.9 * a;
    // expanding amber ring
    ctx.strokeStyle = '#ffc24a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 3 + e * 12, 0, Math.PI * 2); ctx.stroke();
    // a few motes flung outward
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2, r = 2 + e * 14;
      ctx.fillStyle = i % 2 ? '#ffdc8a' : '#ff9a3a';
      ctx.fillRect(Math.round(cx + Math.cos(ang) * r), Math.round(cy + Math.sin(ang) * r), 1, 1);
    }
    // the phosphor confirmation tick
    ctx.globalAlpha = a; ctx.shadowBlur = 4; ctx.shadowColor = '#ffae3a';
    ctx.fillStyle = '#ffd9a3'; ctx.font = "7px 'VT323','Courier New',monospace";
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('PINNED', cx, cy - 6 - e * 4);
    ctx.restore();
  }

  /* ---------- the SPEECH BUBBLE: what a body is saying right now (a routed "received: …" beat, a muttered
     aside, an error line, a LEVEL tick). Rendered in the SAME material as the nameplate — screen-space + no
     smoothing so the VT323 stays crisp instead of being scaled-then-barrel-warped into mush, dark CRT glass
     with scanlines, an amber structural frame with a suit accent, a warm phosphor bloom, and a small tail
     pointing down at the head. A glance, never a window (hover law). */
  const BUBBLE_MAXW = 152;   // CSS px — a spoken line wraps within this before ellipsizing
  function drawBubble(now, who) {
    who = who || agent;
    if (!cache || !who) return;
    const s = who.say;
    // keep the HERO's caption up while it's still SPEAKING (a streamed neural reply can outlast the bubble's
    // fixed timer) — so the on-screen line and the voice stay in phase. Crew bodies just follow the timer.
    const speakingNow = (who === agent) && typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    // W6: nothing REAL to say ⇒ fall through to the peer-chatter bubble (which draws only during an
    // actual conversation, and nothing otherwise). One function, one bubble: a real line always wins
    // the anchor, and the two can never stack over one head.
    if (!s.text || (s.until < now && !speakingNow)) { drawChatterBubble(now, who); return; }

    // draw in SCREEN space (mirrors drawNameplate): pixel-snapped, unsmoothed VT323 that reads cleanly at any
    // zoom, then it rides the same barrel-curve/scanline pass the rest of the feed does. All geometry is CSS px.
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const Wc = cv.width / dpr, Hc = cv.height / dpr;
    const suit = who.color || '#ffaa33';

    // wrap to <=3 lines within BUBBLE_MAXW; ellipsize a truncated tail so an overrun reads as "…", not a hard cut
    const fontSz = 15, lh = 16, padX = 6, padY = 5, tailW = 5, tailH = 6;
    ctx.font = fontSz + 'px ' + PLATE_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const words = String(s.text).split(' '), lines = []; let line = '', truncated = false;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > BUBBLE_MAXW && line) {
        lines.push(line); line = w;
        if (lines.length >= 3) { truncated = true; break; }
      } else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    else if (line) truncated = true;
    if (truncated && lines.length) {
      let last = lines[lines.length - 1];
      while (last && ctx.measureText(last + '…').width > BUBBLE_MAXW) last = last.slice(0, -1);
      lines[lines.length - 1] = last.replace(/\s+$/, '') + '…';
    }
    const textW = lines.length ? Math.max.apply(null, lines.map(l => ctx.measureText(l).width)) : 1;
    const bw = Math.round(Math.max(26, Math.min(BUBBLE_MAXW, textW) + padX * 2));
    const bh = lines.length * lh + padY * 2;

    // anchor centered above the head, crisp + clamped to the canvas (same body->screen math as the nameplate)
    const ax = (bodyPosX(who) * scale + panX) / dpr, ay = (bodyPosY(who) * scale + panY) / dpr;
    // anchor off the sprite's ACTUAL drawn head-top when known (set each frame in drawAgent);
    // the old fixed 15-world-px estimate undershot real skins and parked the bubble on the face
    const topY = (who.visTopPy != null) ? (who.visTopPy * scale + panY) / dpr : ay - 15 * scale / dpr;
    const cx = Math.round(Math.max(bw / 2 + 4, Math.min(Wc - bw / 2 - 4, ax)));
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(Math.max(4, Math.min(Hc - bh - tailH - 4, topY - 6 - tailH - bh)));
    const tx = Math.round(Math.max(bx + tailW + 1, Math.min(bx + bw - tailW - 1, ax)));   // tail apex tracks the head, kept inside the box

    bubbleChrome(bx, by, bw, bh, tx, tailW, tailH, suit, 1);

    // the line(s): VT323 in warm phosphor, with any leading "label:" (received:, working…) dimmed to a tag
    ctx.font = fontSz + 'px ' + PLATE_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 4; ctx.shadowColor = suit;
    ctx.fillStyle = '#ffe0b0';
    lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + lh * (i + 1) - 4));
    const label = lines.length ? (lines[0].match(/^\S+:/) || [])[0] : null;
    if (label) { ctx.shadowBlur = 3; ctx.fillStyle = 'rgba(255,171,64,0.72)'; ctx.fillText(label, bx + padX, by + padY + lh - 4); }
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  }

  /* The bubble's MATERIAL, content-free: dark CRT glass + scanlines, an amber structural frame, the
     tail poured into the same surface, a suit accent along the crown. Extracted so the spoken-line
     bubble and the peer-chatter bubble are physically the SAME object and can never drift into two
     looks. `a` scales every alpha in one place so a caller can fade the whole card; a === 1 is the
     shipped spoken-line appearance, unchanged stroke for stroke. */
  function bubbleChrome(bx, by, bw, bh, tx, tailW, tailH, suit, a) {
    a = (a == null) ? 1 : a;
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(6,5,4,0.94)'; ctx.fillRect(bx, by, bw, bh);
    // the pointing tail (glass, so box + tail read as one poured surface)
    ctx.beginPath(); ctx.moveTo(tx - tailW, by + bh); ctx.lineTo(tx + tailW, by + bh); ctx.lineTo(tx, by + bh + tailH); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.13 * a; ctx.fillStyle = '#000';
    for (let sy = by + 2; sy < by + bh - 1; sy += 3) ctx.fillRect(bx + 1, sy, bw - 2, 1);
    ctx.globalAlpha = a;

    // amber structural frame: the box outline + the two slanted tail edges, then re-glass the seam so the tail
    // opens into the box instead of being fenced off by the box's bottom stroke
    ctx.strokeStyle = '#b9791c'; ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.beginPath(); ctx.moveTo(tx - tailW, by + bh - 0.5); ctx.lineTo(tx, by + bh + tailH); ctx.lineTo(tx + tailW, by + bh - 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(6,5,4,0.94)'; ctx.fillRect(tx - tailW + 1, by + bh - 1, tailW * 2 - 1, 2);
    // suit accent along the top edge (the body's own colour, like the nameplate's crown)
    ctx.globalAlpha = 0.6 * a; ctx.fillStyle = suit; ctx.fillRect(bx + 1, by, bw - 2, 1); ctx.globalAlpha = a;
  }

  /* ---------- W6: THE PEER-CHATTER BUBBLE — the untranscribable line over whoever holds the floor.
     Same card as the spoken bubble (bubbleChrome), filled with drawn RUNES instead of text: see the
     GLYPH-SPEECH block above for why it has to be geometry and why unreadable is the honest answer.

     It exists only while `chatter` does, and `chatter` is stamped once per turn by setTalking and
     cleared by endEncounter — so the bubble is on screen exactly when a mouth is moving in a real
     two-sided encounter, and never a frame longer. It cannot outlive its conversation even if a
     frame is dropped: the window is bounded by CHATTER_MS off its own stamp. */
  const RUNE_PX = 2;                                            // lattice unit -> CSS px (a rune is 8x12)
  const RUNE_ADV = (RUNE_W + 2) * RUNE_PX;                      // rune cell + the gap to the next rune
  const WORD_GAP = 3 * RUNE_PX;                                 // the extra breath between words
  function drawChatterBubble(now, who) {
    const ch = who.chatter;
    if (!ch || !ch.words || !ch.words.length) return;
    const age = now - ch.at;
    // The turn's own deadline ends it (see chatterWindow). CHATTER_MS stays as a hard backstop so a
    // clock jump or a missed teardown can never leave a line hanging — belt AND braces, on purpose.
    if (age < 0 || age > CHATTER_MS || now > ch.until) { who.chatter = null; return; }
    // envelope: a quick rise so it lands with the mouth, a hold, then the fade tail. Never a hard pop.
    const a = Math.min(1, age / 110) * Math.min(1, Math.max(0, (ch.until - now) / CHATTER_FADE_MS));
    if (a <= 0.01) return;

    /* HAND THE CONTEXT BACK EXACTLY AS RECEIVED. Measured live (dev/glyphdiag.mjs): the shipped
       bubble leaves `fillStyle` sitting on its phosphor, and the next frame's early 1px motes —
       which set globalAlpha but not their own colour — were being painted in it. Rare enough to
       have gone unseen while only a routed line raised a bubble; a conversation raises one every
       1.7s, so the leak would have become the normal state of the frame. save/restore is the fix
       that cannot be got wrong later, and it is scoped HERE so the spoken-line path stays byte-
       identical to what shipped. */
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const Wc = cv.width / dpr, Hc = cv.height / dpr;
    const suit = who.color || '#ffaa33';
    const padX = 6, padY = 5, tailW = 5, tailH = 6;

    // the phrase's own width — bounded by construction (<=3 words of <=4 runes), so unlike the text
    // bubble there is nothing to wrap or ellipsize: a line that cannot overflow needs no truncation.
    let inkW = 0;
    for (const word of ch.words) inkW += word.length * RUNE_ADV + WORD_GAP;
    inkW = Math.max(0, inkW - WORD_GAP - RUNE_PX);   // no trailing word gap; the last rune contributes ink, not advance
    const bw = Math.round(Math.max(26, inkW + padX * 2));
    const bh = (RUNE_H + 1) * RUNE_PX + padY * 2;

    // same body->screen anchor as the spoken bubble (head-top when the sprite reported one)
    const ax = (bodyPosX(who) * scale + panX) / dpr, ay = (bodyPosY(who) * scale + panY) / dpr;
    const topY = (who.visTopPy != null) ? (who.visTopPy * scale + panY) / dpr : ay - 15 * scale / dpr;
    const cx = Math.round(Math.max(bw / 2 + 4, Math.min(Wc - bw / 2 - 4, ax)));
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(Math.max(4, Math.min(Hc - bh - tailH - 4, topY - 6 - tailH - bh)));
    const tx = Math.round(Math.max(bx + tailW + 1, Math.min(bx + bw - tailW - 1, ax)));

    bubbleChrome(bx, by, bw, bh, tx, tailW, tailH, suit, a);

    // the runes, in the same warm phosphor the spoken line uses
    ctx.shadowBlur = 3; ctx.shadowColor = suit;
    ctx.fillStyle = '#ffe0b0';
    let gx = bx + padX;
    const gy = by + padY;
    for (const word of ch.words) {
      for (const idx of word) { drawRune(RUNES[idx], gx, gy, RUNE_PX); gx += RUNE_ADV; }
      gx += WORD_GAP;
    }
    ctx.restore();
  }
  /* One rune, as pixel rects. Orthogonal strokes are a single rect; a 45° stroke walks the lattice
     one square at a time (Bresenham is unnecessary — the alphabet admits no other slope, which is
     exactly why it stays crisp at any zoom instead of becoming a fuzzy staircase). */
  function drawRune(strokes, ox, oy, u) {
    if (!strokes) return;
    for (const s of strokes) {
      const x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
      if (y1 === y2) { ctx.fillRect(ox + Math.min(x1, x2) * u, oy + y1 * u, (Math.abs(x2 - x1) + 1) * u, u); continue; }
      if (x1 === x2) { ctx.fillRect(ox + x1 * u, oy + Math.min(y1, y2) * u, u, (Math.abs(y2 - y1) + 1) * u); continue; }
      const dx = x2 > x1 ? 1 : -1, dy = y2 > y1 ? 1 : -1, n = Math.abs(x2 - x1);
      for (let i = 0; i <= n; i++) ctx.fillRect(ox + (x1 + dx * i) * u, oy + (y1 + dy * i) * u, u, u);
    }
  }

  function setOnClick(fn) { onClick = fn; }
  function setOnArcade(fn) { onArcade = fn; }
  function setOnOutbox(fn) { onOutbox = fn; }
  function setOnBayAssign(fn) { onBayAssign = fn; }   // click an UNBOUND bay → open the assign flow (app wires to REFIT's picker)
  function setOnIntakeFeed(fn) { onIntakeFeed = fn; } // click a NO-FEED intake → open the CHANNELS panel (app wires it)
  function setOnIntakeSample(fn) { onIntakeSample = fn; } // click an INBOX on a COMPLETE line → the sample-job card (guided workflow Phase 4)

  /* ---------- BELT LEGIBILITY: the floor teaches its own routing ----------
     The single failure this layer kills: a user lays belts, sees crates or dead machinery, and cannot tell
     WHY the line isn't doing anything. Three glances answer it, all derived from the SAME compiled plan the
     sidecar dispatches by (never a parallel guess):
       1. dead-vs-live tiles (drawBelts liveSet — wired in compileRouting above);
       2. in-world nags on the broken piece (this section — the compiler's own errors, made physical);
       3. a hover route tag on any belt tile ("▸ CODER" / "DEAD END").
     All world-space VT323 phosphor, drawRunClocks idiom. A glance, never a window (hover law). */
  const NAG_FONT = "8px 'VT323','Courier New',monospace";
  // compiler error code -> the in-world callout. Wording says what to DO, not what went wrong internally.
  // Every label NAMES THE FIX, never just the fault ("NO LINE FROM INTAKE", not the old "NO ROUTE IN").
  // A finding only exists when it's true: a lone assigned bay is a COMPLETE build and gets no callout;
  // a bay->OUTBOX ship-out lane is valid and GLOWS instead of nagging (the 2026-07-05 playtest bug class).
  /* PARITY IS A LAW, NOT A HABIT (2026-08-07 conveyor audit). buildRoutingNags does `if (!label) continue`,
     so a compiler code missing from this table is a finding the live world SILENTLY DROPS — the Commander
     sees a dead line and no reason anywhere on the floor. ORPHAN_JUNCTION was exactly that: REFIT's
     VAL_LABEL named it, the world said nothing. Every VAL_LABEL key must have an entry here (the wording
     may differ — REFIT can spell out a gesture the world has no room for); locked by
     test/routing-nag-parity.test.js, which reads both tables out of the two source files. */
  const NAG_LABEL = {
    UNBOUND_BAY: 'NO AGENT — CLICK', ORPHAN_BAY: 'NOT ON THE LINE', ORPHAN_SOURCE: 'NO BELT OUT',
    BAY_NOT_FED: 'NOT FED — BELT THROUGH THE JUNCTION', CYCLE: 'LOOP!', FILTER_NO_DEFAULT: 'NO DEFAULT LANE', DUP_AGENT: 'DUP AGENT',
    SPLIT_ONE_LANE: 'SPLITTER — BELT THROUGH IT, 2 OUT', CHAIN_CYCLE: 'WORK LINE LOOPS',
    JOIN_ONE_LANE: 'JOINER — NEEDS 2 BELTS IN', LOOP_NO_DONE: 'LOOP — NO DONE LANE OUT', LOOP_NO_BACK: 'LOOP — NO BACK LANE',
    BELT_BURIED: 'PROP ON THE LINE — MOVE IT',
    ORPHAN_JUNCTION: 'NOT ON A BELT — MOVE IT'
  };
  // project the compiled plan's error list onto floor rectangles once per recompile (zero per-frame walk)
  function buildRoutingNags() {
    const out = [];
    feedNagOn = false;
    if (!routingPlan || !routingPlan.errors || !geo || !geo.props) return out;
    const byId = {};
    for (const p of geo.props) byId[p.id] = p;
    for (const e of routingPlan.errors) {
      let label = NAG_LABEL[e.code];
      if (!label) continue;
      // a ROLE-carrying unbound dock names WHO it wants ("RESEARCHER — DIGS SOURCES… — CLICK") instead
      // of the bare NO AGENT (guided workflows Phase 1; same WorldModel.BAY_ROLES source REFIT reads).
      if (e.code === 'UNBOUND_BAY' && e.propId) {
        const rp = byId[e.propId];
        const ri = (rp && rp.role && !rp.agentId && typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(rp.role) : null;
        if (ri) label = rp.role + ' — ' + ri.desc.toUpperCase() + ' — CLICK';
      }
      if (e.tile) out.push({ x: e.tile.x, y: e.tile.y, w: 1, h: 1, label, warn: !!e.warn });
      else { const p = e.propId != null && byId[e.propId]; if (p) out.push({ x: p.x, y: p.y, w: p.w || 1, h: p.h || 1, label, warn: !!e.warn }); }
    }
    // beyond the compiler — two silent failure modes the floor must also confess:
    // (a) a BOUND bay whose room grants no computer: routed work arrives and the run can't act (the compute
    //     gate stays shut). Same bayObjects check as REFIT's NO COMPUTE ghost, now visible in the live world.
    //     Walks dockBays (EVERY bound bay, belt-hooked or standalone) — a lone dock deserves the same truth.
    if (routingPlan.dockBays && station && typeof station.bayObjects === 'function') {
      for (const b of routingPlan.dockBays) {
        let objs = [];
        try { objs = station.bayObjects(b.agentId) || []; } catch (_) {}
        if (objs.indexOf('computer') >= 0) continue;
        out.push({ x: b.x, y: b.y, w: b.w || 1, h: b.h || 1, label: 'NO COMPUTE — ADD A PC', warn: true });
      }
    }
    // (b) a COMPLETE line with nothing wired to feed it: no channel configured and no armed routine means no
    //     crate will EVER enter the intake. Claimed only once the server actually answered (feedState.known) —
    //     never a nag on ignorance. The click-through opens the CHANNELS panel (onIntakeFeed).
    if (feedState.known && !feedState.fed && beltLiveSet && Object.keys(beltLiveSet).length) {
      for (const p of geo.props) {
        if (p.t !== 'intake') continue;
        out.push({ x: p.x, y: p.y, w: p.w || 1, h: p.h || 1, label: 'NO FEED — CLICK', warn: true });
        feedNagOn = true;
      }
    }
    return out;
  }
  /* FEED TRUTH: is anything actually wired to drop work onto this floor? ANY registry channel configured
     (the bulk /api/channels/status covers telegram/discord/slack/matrix/signal — polling only the first two
     falsely nagged a slack/matrix/signal-only floor), or the cron scheduler armed with at least one enabled
     routine. Server-proven only — `fed` stays true until a real response says otherwise, so a fetch hiccup
     can never fire the nag. */
  function pollFeedState() {
    if (typeof fetch === 'undefined') return;
    const get = u => { try { return fetch(apiUrl(u)).then(r => (r.ok ? r.json() : null)).catch(() => null); } catch (_) { return Promise.resolve(null); } };
    return Promise.all([get('/api/channels/status'), get('/api/cron')]).then(([chans, cron]) => {
      if (!chans && !cron) return;   // nothing answered — keep the last known truth
      const chan = !!(chans && typeof chans === 'object' && Object.keys(chans).some(id => chans[id] && chans[id].configured));
      const jobs = (cron && Array.isArray(cron.jobs)) ? cron.jobs : [];
      const cronFeeds = !!(cron && cron.enabled && jobs.some(j => j && j.enabled !== false));
      const next = { known: true, fed: chan || cronFeeds };
      const changed = next.known !== feedState.known || next.fed !== feedState.fed;
      feedState = next;
      if (changed) routingNags = buildRoutingNags();   // feed truth changed → refresh the callouts
    });
  }
  /* hit-test: an INBOX (intake) on a floor with a COMPLETE line — an energized intake→bound-bay route exists
     (beltLiveSet is derived from the SAME compiled plan the sidecar routes by, so "clickable" here means the
     sample genuinely has a line to ride). Its click offers the RUN-A-SAMPLE-JOB card. Checked BEFORE
     intakeFeedAt in the click handler; the card itself carries the CHANNELS door when the feed is missing,
     so the NO-FEED nag's promised click-through stays one tap away. */
  function intakeSampleAt(wp) {
    if (!onIntakeSample || !geo || !geo.props || !beltLiveSet || !Object.keys(beltLiveSet).length) return null;
    for (const p of geo.props) {
      if (p.t !== 'intake') continue;
      const x0 = p.x * T, y0 = p.y * T - 10, x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 2;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // hit-test: an INTAKE currently showing the NO FEED nag (its click-through opens the CHANNELS panel)
  function intakeFeedAt(wp) {
    if (!feedNagOn || !geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'intake') continue;
      const x0 = p.x * T, y0 = p.y * T - 10, x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 2;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // hit-test: an UNBOUND bay under a world-space point (its nag says CLICK, so the footprint must be clickable)
  function unboundBayAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'bay' || p.agentId) continue;
      const x0 = p.x * T, y0 = p.y * T - 10;   // the nag text floats above the crown — keep it clickable too
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 2;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // the hover answer for one belt tile, cached until the next recompile. ok=true → the flow reaches a bound bay.
  function routeTagFor(tx, ty) {
    if (!routingPlan || typeof Pipeline === 'undefined' || !Pipeline.routeFrom) return null;
    const k = tx + ',' + ty;
    if (routeTagCache && routeTagCache[k] !== undefined) return routeTagCache[k];
    const r = Pipeline.routeFrom(routingPlan, tx, ty);
    let tag;
    if (r.agents.length) {
      const names = r.agents.map(a => { const b = bodyForAgent(a); return ((b && b.name) ? String(b.name) : String(a).slice(0, 8)).toUpperCase(); });
      tag = { text: '▸ ' + names.join(' · ') + (r.deadEnd ? ' +DEAD END' : ''), ok: !r.deadEnd };
    }
    else if (r.outbox) tag = { text: '▸ OUTBOX — SHIPS OUT', ok: !r.deadEnd };   // a pure outbound lane is a WORKING lane
    else if (r.unbound) tag = { text: '▸ BAY — NO AGENT', ok: false };
    else tag = { text: '▸ DEAD END', ok: false };
    (routeTagCache = routeTagCache || {})[k] = tag;
    return tag;
  }
  // amber (warn) / red (blocker) corner brackets + a one-line instruction over the broken piece, gently pulsing
  // label collision (2026-07-11): neighboring nags on one row — or two nags on the SAME prop (e.g.
  // BAY_NOT_FED + NO COMPUTE) — used to print on a shared baseline and mash into garble. Each label
  // claims a box; a collider steps UP one line at a time until it fits. Rebuilt per draw call.
  function placeNagLabel(placed, cx, y, w, h) {
    const hits = b => cx - w / 2 < b.x + b.w && cx + w / 2 > b.x && y < b.y + b.h && y + h > b.y;
    let guard = 24;
    while (guard-- > 0 && placed.some(hits)) y -= h + 1;
    placed.push({ x: cx - w / 2, y, w, h });
    return y;
  }
  function drawRoutingNags(now) {
    if (!routingNags || !routingNags.length) return;
    const pulse = 0.55 + 0.35 * Math.sin(now / 280);
    const placed = [];
    for (const n of routingNags) {
      const X = n.x * T, Y = n.y * T, Wd = n.w * T, Hd = n.h * T;
      const col = n.warn ? '#ffbe3c' : '#ff5046';
      const L = Math.max(3, Math.floor(T / 3));
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();   // corner brackets, not a full box — a machinery callout, not a selection
      ctx.moveTo(X + .5, Y + .5 + L); ctx.lineTo(X + .5, Y + .5); ctx.lineTo(X + .5 + L, Y + .5);
      ctx.moveTo(X + Wd - .5 - L, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5 + L);
      ctx.moveTo(X + .5, Y + Hd - .5 - L); ctx.lineTo(X + .5, Y + Hd - .5); ctx.lineTo(X + .5 + L, Y + Hd - .5);
      ctx.moveTo(X + Wd - .5, Y + Hd - .5 - L); ctx.lineTo(X + Wd - .5, Y + Hd - .5); ctx.lineTo(X + Wd - .5 - L, Y + Hd - .5);
      ctx.stroke();
      ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.shadowBlur = 3; ctx.shadowColor = col; ctx.fillStyle = col;
      // alphabetic baseline at y: label box spans roughly [y-8, y] (8px VT323)
      const ly = placeNagLabel(placed, X + Wd / 2, Y - 3 - 8, ctx.measureText(n.label).width, 9);
      ctx.fillText(n.label, X + Wd / 2, ly + 8);
      ctx.restore();
    }
  }
  // the hover-glance tag over a clickable OUTBOX: crates pending → "N TO REVIEW — CLICK"; pallet only →
  // the LOGBOOK click-through. Names what the stacked boxes ARE and what the click does (the 2026-07-16
  // confusion: "boxes showing output but I can't see it"). A glance, never a window (hover law).
  function drawOutboxHoverTag(now) {
    if (!hoverOutbox) return;
    const n = returnCrates();
    const text = n > 0 ? (n + ' TO REVIEW — CLICK') : 'FINISHED WORK — CLICK';
    ctx.save();
    ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 3; ctx.shadowColor = n > 0 ? '#ffd88a' : '#62ff9e';
    ctx.fillStyle = n > 0 ? '#ffe9bd' : '#9adcb0';
    ctx.fillText(text, (hoverOutbox.x + (hoverOutbox.w || 1) / 2) * T, hoverOutbox.y * T - 40);
    ctx.restore();
  }
  // the hover-glance route tag over the belt tile under the cursor (green = flows to a bound bay, amber = doesn't)
  function drawBeltHoverTag(now) {
    if (!hoverBeltTile) return;
    const tag = routeTagFor(hoverBeltTile.x, hoverBeltTile.y);
    if (!tag) return;
    ctx.save();
    ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 3; ctx.shadowColor = tag.ok ? '#62ff9e' : '#ffbe3c';
    ctx.fillStyle = tag.ok ? '#9adcb0' : '#ffd9a3';
    ctx.fillText(tag.text, (hoverBeltTile.x + 0.5) * T, hoverBeltTile.y * T - 4);
    ctx.restore();
  }
  function setOnMissionBoard(fn) { onMissionBoard = fn; }   // G1b: click a placed MISSION BOARD → open the quest log
  function setOnTrophyCase(fn) { onTrophyCase = fn; }   // G3b: click a placed TROPHY CASE → open the trophy surface
  // G2.3 — the live uncollected-crate count (ReturnStore's pending ledger). Read per-frame for the
  // OUTBOX sprite stack and by the hit-test below; 0 when the store isn't loaded (headless tests).
  function returnCrates() {
    try { return (typeof ReturnStore !== 'undefined' && ReturnStore.pendingCount) ? (ReturnStore.pendingCount() | 0) : 0; } catch (_) { return 0; }
  }
  // hit-test: the OUTBOX chute under a world-space point — ALWAYS clickable while placed (2026-07-16:
  // the click opens the OUTBOX window, which has honest content in every state — pending crates,
  // or the "finished work lands here" empty state — so the affordance is never dead, mirroring the
  // MISSION BOARD). The stacks spill above AND below the footprint, so the box extends both ways.
  function outboxAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'outbox') continue;
      const x0 = p.x * T, y0 = p.y * T - 34;
      const yBot = (p.y + (p.h || 1)) * T;
      const x1 = (p.x + (p.w || 1)) * T, y1 = yBot + 12;
      // the SHIPPED pallet draws WIDER than the chute (4 crate columns ≈ 42px vs a 24px footprint) and
      // sits below it — clicking an outer crate used to be a dead click. Below the bottom edge the hit
      // box widens to the pallet's real span; above it stays the footprint so a neighbouring bay/board
      // click is never shadowed.
      const pad = wp.y >= yBot ? 12 : 0;
      if (wp.x >= x0 - pad && wp.x < x1 + pad && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  /* ---------- G1b MISSION BOARD: the quest log's body ----------
     missionPinCounts — the board's truthful readout, recomputed at most once a second (the projection walk
     is too heavy for every frame): [how many quests are OPEN in the visible log, whether a station-gap
     fix-it is among them]. Zeroes when the quest stores aren't loaded (headless tests / title screen). */
  let mpAt = -1e9, mpOpen = 0, mpHot = false, mpJam = false, mpProp = 0;
  function missionPinCounts(t) {
    if (t - mpAt > 1000) {
      mpAt = t;
      try {
        const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
        const all = (v && Array.isArray(v.quests)) ? v.quests : [];
        const vis = (typeof QuestStateStore !== 'undefined' && QuestStateStore.visible) ? QuestStateStore.visible(all) : all;
        mpOpen = vis.filter(q => q && q.status !== 'done').length;
        mpHot = (typeof StationQuestStore !== 'undefined' && StationQuestStore.openCount) ? StationQuestStore.openCount() > 0 : false;
        // G1c: a repeatedly-skipped routine reads as a JAM — an amber stub pins on the board (pure Factorio).
        mpJam = (typeof MaintQuestStore !== 'undefined' && MaintQuestStore.jammedJobs) ? (MaintQuestStore.jammedJobs().length > 0) : false;
        // G4 feature 2: pending autojob PROPOSAL cards the agent pinned to the board.
        mpProp = (typeof AutoJobStore !== 'undefined' && AutoJobStore.pendingCount) ? AutoJobStore.pendingCount() : 0;
      } catch (_) { mpOpen = 0; mpHot = false; mpJam = false; mpProp = 0; }
    }
    return [mpOpen, mpHot, mpJam, mpProp];
  }
  // hit-test: a placed MISSION BOARD under a world-space point. Always clickable while placed — the click
  // opens the QUEST LOG, which always has content, so the affordance is never dead (unlike the OUTBOX,
  // whose click needs crates). The wall lugs + casing spill above the footprint; extend the box up.
  function missionBoardAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'missionboard') continue;
      const x0 = p.x * T, y0 = p.y * T - 6;
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 4;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  /* ---------- G3b TROPHY CASE: the station's achievements made permanent ----------
     trophyCount — the case's truthful readout, recomputed at most once a second (the trophy walk is heavy):
     how many REAL trophies are earned (completed quests + earned milestones, via the Trophies projection over
     the live quest view + durable QuestState memory). Zero when the surface isn't loaded (headless / title). */
  let tcAt = -1e9, tcWon = 0;
  function trophyCount(t) {
    if (t - tcAt > 1000) {
      tcAt = t;
      try {
        const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
        const quests = (v && Array.isArray(v.quests)) ? v.quests : [];
        const stateOf = (typeof QuestStateStore !== 'undefined' && QuestStateStore.stateOf) ? (id => QuestStateStore.stateOf(id)) : (() => null);
        const surf = (typeof Trophies !== 'undefined' && Trophies.build) ? Trophies.build({ quests, stateOf }) : null;
        tcWon = surf ? surf.earned : quests.filter(q => q && q.status === 'done').length;
      } catch (_) { tcWon = 0; }
    }
    return tcWon;
  }
  // hit-test: a placed TROPHY CASE under a world-space point. Always clickable while placed — the click opens
  // the TROPHY CASE surface (honest even when empty: it shows dust, never a dead affordance). The glass casing
  // sits within its 2×2 footprint; a small down-spill for the base shadow keeps the bottom row clickable.
  function trophyCaseAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'trophycase') continue;
      const x0 = p.x * T, y0 = p.y * T - 2;
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 4;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // hit-test: the arcade cabinet prop under a world-space point (null if none). The cabinet
  // art spills a few px below its tile footprint, so extend the box down to keep it clickable.
  function arcadeAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      const s = specOf(p.t);
      if (!s || !s.use || s.use.kind !== 'arcade') continue;
      const x0 = p.x * T, y0 = p.y * T - 2;
      const x1 = (p.x + (p.w || s.w || 1)) * T, y1 = (p.y + (p.h || s.h || 1)) * T + 8;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }

  /* ---------- work-item pipeline: the conveyor carries REAL inbound work to the agent ----------
     A real admitted message (Telegram) arrives over the SSE bridge as `workitem.placed`; we drop a
     box at the INTAKE prop so it rides the player-laid belts to the desk. Pure visualization — if no
     INTAKE/belt path exists, nothing rides (the sidecar already ran the work either way). */
  const chanQueues = new Map();   // queueId -> depth (from queue.status) — drives the backpressure HUD
  const serverLit = new Set();    // agentIds lit by an AUTONOMOUS run (cron/channel) — its run.end clears them
  /* ---------- per-agent ACTIVITY HEAT (G0.3) ----------
     A truthful "how hard is this run streaming RIGHT NOW" scalar per agent: every real agent.token /
     agent.tool_call bumps it, and it decays exponentially (~2s time-constant) between bumps — so a
     hot-streaming run burns visibly brighter at the desk than a stalled one, with zero invented signal.
     Read lazily (decay computed at read time) so an idle map entry costs nothing per frame. */
  const heatByAgent = new Map();  // agentId -> { v, at } (v = heat at time `at`; decays exp(-(now-at)/TAU))
  const HEAT_TAU = 2000;
  function heatBump(aid, inc) {
    const id = aid || (agent && agent.id) || 'agent';
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    const h = heatByAgent.get(id);
    const v = h ? h.v * Math.exp(-(now - h.at) / HEAT_TAU) : 0;
    heatByAgent.set(id, { v: Math.min(1, v + inc), at: now });
  }
  function heatFor(aid) {
    const h = heatByAgent.get(aid || (agent && agent.id) || 'agent');
    if (!h) return 0;
    const v = h.v * Math.exp(-(fnow - h.at) / HEAT_TAU);
    return v < 0.01 ? 0 : v;
  }
  /* ---------- honest desk activity (G0.2): two truth sources, never conflated ----------
     deskProg — a REAL task-progress fraction, if some producer published one on the 'task' bus event
     (t.prog/t.dur — the crew-task sim's contract). The strip renders ONLY from this map; a live
     harness run publishes no fraction and so gets NO bar — it shows elapsed time + heat instead.
     runStartByAgent — when each agent's live run actually started (agent.run.start/end), driving the
     tiny elapsed-time tag at the desk. Time is knowable; percent is not; we show exactly what is. */
  const deskProg = new Map();        // agentId -> 0..1 (real published fraction only)
  const runStartByAgent = new Map(); // agentId -> performance.now() at agent.run.start
  const deskProgFor = aid => deskProg.has(aid) ? deskProg.get(aid) : null;
  /* ---------- Lane E2 — paired-state TTLs (the second net under reconnect reconciliation) ----------
     A run clock / work pose / await-prompt is asserted off a START event and cleared off its matching END event.
     If the END event is LOST (sidecar crash mid-run, a dropped SSE frame), the frontend would assert "RUN 47:12"
     forever — the app lying about state. As an independent net, every reinforcing event (run.start/token/tool_call)
     stamps a last-seen time; a once-per-second sweep degrades any paired state with no reinforcement for its TTL to
     cleared/unknown rather than asserted-forever. Kept cheap: one Map of timestamps, swept once per second (never
     per-frame). Reconnect reconciliation (snapshot fetch, below) is the PRIMARY correction; this TTL is the
     belt-and-suspenders that also covers the no-snapshot-endpoint case. */
  const runLastSeenByAgent = new Map();          // agentId -> performance.now() of the last reinforcing run event
  const RUN_TTL_MS = 300000;                     // 5m of NO token/tool/start event ⇒ the run clock degrades to unknown
  const AWAIT_TTL_MS = 660000;                   // consent max (600s) + grace ⇒ a stuck await clears if its response was lost
  let awaitStampAt = 0;                           // performance.now() when the current awaitPrompt was last reinforced
  function stampRun(aid, rid) {
    if (!aid) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    runLastSeenByAgent.set(aid, now);
    // per-RUN reinforcement: a leaked runId (lost run.end) must go stale on ITS OWN clock — the agent-level
    // stamp above stays fresh as long as ANY run of this agent emits, which used to keep a leaked refcount
    // alive forever on a busy agent (the crew panel then asserted WORKING between every run).
    if (rid) { const s = liveRunsByAgent.get(aid); if (s && s.has(rid)) s.set(rid, now); }
  }
  /* OVERLAP-SAFE RUN REFCOUNT (the black-screen-while-working fix). The work pose, serverLit set and the
     run clock are all AGENT-keyed, but an agent's runs can OVERLAP (a scheduled routine ending while a chat
     run streams, two channel runs, a background workstream). Extinguishing on the FIRST run.end used to
     tear the desk pose + darken the workstation screens of an agent that was still genuinely working — the
     app asserting idle while the harness could prove a live run (truthful-telemetry violation, inverted).
     So every live run registers by runId here, and only the LAST live run's end may extinguish agent-keyed
     state. noteRunEnd is IDEMPOTENT per runId (Set.delete), so every run.end consumer can call it and read
     the remaining count without depending on listener registration order. */
  const liveRunsByAgent = new Map();   // agentId -> Map(runId -> lastSeen ms), every live run regardless of trigger
  function noteRunStart(aid, rid) { if (!aid || !rid) return; let s = liveRunsByAgent.get(aid); if (!s) { s = new Map(); liveRunsByAgent.set(aid, s); } s.set(rid, (typeof performance !== 'undefined') ? performance.now() : fnow); }
  function noteRunEnd(aid, rid) {
    const s = aid ? liveRunsByAgent.get(aid) : null; if (!s) return 0;
    if (rid) s.delete(rid); else s.clear();   // a runId-less end can't be matched — treat it as agent-terminal (old behavior)
    if (!s.size) liveRunsByAgent.delete(aid);
    return s.size;
  }
  function agentRunsLive(aid) { const s = aid ? liveRunsByAgent.get(aid) : null; return s ? s.size : 0; }
  /* the once-per-second TTL sweep (E2). Degrades paired states whose reinforcing event was lost:
       • a run clock with no token/tool/start event for RUN_TTL_MS ⇒ clear runStartByAgent (+ its work pose,
         glyph, serverLit, and any leftover crew workUntil for that agent) so no eternal RUN clock is asserted.
       • an awaitPrompt with no reinforcement for AWAIT_TTL_MS (consent-max + grace) ⇒ clearAwait(), since a
         lost permission.response would otherwise strand the hero at the wait anchor forever.
     Cheap: iterates only the (usually tiny) live maps, once per second. */
  function sweepStaleStates(now) {
    if (runStartByAgent.size) {
      for (const aid of Array.from(runStartByAgent.keys())) {
        const seen = runLastSeenByAgent.get(aid) || runStartByAgent.get(aid) || 0;
        if (now - seen > RUN_TTL_MS) {
          runStartByAgent.delete(aid); runLastSeenByAgent.delete(aid);
          liveRunsByAgent.delete(aid);                    // a leaked refcount (lost run.end) degrades with the clock
          glyphByAgent.delete(aid);                       // the in-flight tool glyph is just as stale
          if (serverLit.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }   // drop an autonomous body out of the working pose
          const b = bodyForAgent(aid); if (b && b !== agent && b.workUntil) b.workUntil = 0;  // clear a stuck crew work pose
        }
      }
    }
    // per-RUN sweep: a single leaked runId (its run.end lost) on an otherwise BUSY agent never trips the
    // agent-level clock above — its siblings keep runLastSeenByAgent fresh forever. Each tracked run now
    // carries its own last-reinforced stamp; one that has gone RUN_TTL_MS silent is dropped individually.
    // When that empties an agent's set, release the same agent-keyed state the agent-level branch does.
    for (const [aid, s] of Array.from(liveRunsByAgent)) {
      for (const [rid, seen] of Array.from(s)) if (now - seen > RUN_TTL_MS) s.delete(rid);
      if (!s.size) {
        liveRunsByAgent.delete(aid);
        runStartByAgent.delete(aid); runLastSeenByAgent.delete(aid); glyphByAgent.delete(aid);
        if (serverLit.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }
        const b = bodyForAgent(aid); if (b && b !== agent && b.workUntil) b.workUntil = 0;
      }
    }
    // a serverLit entry whose agent has NO live run and NO run clock is a leftover from an overlap window
    // (the scheduled run ended while a chat run kept the pose; the chat teardown owned the extinguish) — drop it.
    for (const aid of Array.from(serverLit)) if (!agentRunsLive(aid) && !runStartByAgent.has(aid)) serverLit.delete(aid);
    if (awaitPrompt && awaitStampAt && (now - awaitStampAt > AWAIT_TTL_MS)) clearAwait();   // a lost permission.response never strands the hero
  }
  /* Lane E2 — reconnect reconciliation (the PRIMARY correction). On every SSE (re)open, ask the sidecar for the
     authoritative live state and rebuild the paired-state maps to match, CLEARING anything the server no longer
     reports (a run that ended during the outage, a prompt already answered). Backend endpoint GET /api/state/snapshot
     MUST be consumed 404/failure-tolerantly: on any non-OK / malformed response we do nothing and lean on the TTL
     net above. The server's real shape (sidecar handleStateSnapshot) is
       { ts, runs:[{runId, agentId, startedAt, source}], prompts:[{runId, agentId, promptId}], summons:[], queues:[] }
     with startedAt in epoch ms — normalizeSnapshot() maps it onto the internal shape below (all fields optional):
       { activeRuns:[{agentId, startedMsAgo?}], pendingPrompts:[{promptId, agentId}], inflightTools:[{agentId, name, callId}],
         serverLitAgents:[agentId] }  */
  function normalizeSnapshot(snap) {
    if (!snap || typeof snap !== 'object' || snap.activeRuns) return snap;   // already internal-shaped (dbg/test paths)
    if (!Array.isArray(snap.runs) && !Array.isArray(snap.prompts)) return snap;
    const ts = +snap.ts || 0;
    const out = Object.assign({}, snap);
    if (Array.isArray(snap.runs)) out.activeRuns = snap.runs.map(r => r && r.agentId ? {
      agentId: r.agentId,
      runId: r.runId || null,
      startedMsAgo: (ts && +r.startedAt) ? Math.max(0, ts - (+r.startedAt)) : 0
    } : null).filter(Boolean);
    if (Array.isArray(snap.prompts)) out.pendingPrompts = snap.prompts;
    return out;
  }
  function reconcileFromSnapshot(snap) {
    snap = normalizeSnapshot(snap);
    if (!snap || typeof snap !== 'object') return;
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    // ---- active runs: keep/refresh reported ones, DROP any run clock the server no longer knows about ----
    if (Array.isArray(snap.activeRuns)) {
      const live = new Set();
      for (const r of snap.activeRuns) {
        if (!r || !r.agentId) continue;
        live.add(r.agentId);
        const startedAgo = Math.max(0, +r.startedMsAgo || 0);
        if (!runStartByAgent.has(r.agentId)) runStartByAgent.set(r.agentId, now - startedAgo);
        // ORPHAN RUN → WORK POSE: the server proves this run live but no local stream ever saw it start
        // (app reloaded mid-run, or the run belongs to another client). Nothing will ever drive this body —
        // chat.js only poses runs it launched, and the schedule/event listener only fires on the live bus
        // event — so the crew panel would honestly say "working at the terminal" over a standing sprite.
        // Light it through the existing autonomous-work channel (serverLit), whose extinguish paths
        // (run.end refcount, TTL sweep, this reconcile's ended-during-outage branch) already release it.
        const tracked = liveRunsByAgent.get(r.agentId);
        const orphan = !!(r.runId && !(tracked && tracked.has(r.runId)));
        noteRunStart(r.agentId, r.runId);   // rebuild the overlap refcount from the authoritative live set
        stampRun(r.agentId, r.runId);
        if (orphan && !serverLit.has(r.agentId)) { serverLit.add(r.agentId); setActivityFor(r.agentId, 'task'); }
      }
      for (const aid of Array.from(runStartByAgent.keys())) if (!live.has(aid)) {   // ended during the outage
        runStartByAgent.delete(aid); runLastSeenByAgent.delete(aid); glyphByAgent.delete(aid); liveRunsByAgent.delete(aid);
        if (serverLit.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }
        const b = bodyForAgent(aid); if (b && b !== agent && b.workUntil) b.workUntil = 0;
      }
    }
    // ---- inflight tool glyphs: authoritative rebuild ----
    if (Array.isArray(snap.inflightTools)) {
      const liveTool = new Set();
      for (const t of snap.inflightTools) { if (t && t.agentId && t.name) { glyphByAgent.set(t.agentId, { name: t.name, callId: t.callId || null }); liveTool.add(t.agentId); } }
      for (const aid of Array.from(glyphByAgent.keys())) if (!liveTool.has(aid)) glyphByAgent.delete(aid);
    }
    // ---- serverLit (autonomous run pose): reconcile to the reported set ----
    if (Array.isArray(snap.serverLitAgents)) {
      const want = new Set(snap.serverLitAgents.filter(Boolean));
      for (const aid of Array.from(serverLit)) if (!want.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }
      for (const aid of want) if (!serverLit.has(aid)) { serverLit.add(aid); setActivityFor(aid, 'task'); }
    }
    // ---- pending permission prompt: enter it if the server still has one for the hero, else clear a stale await ----
    if ('pendingPrompts' in snap) {
      const prompts = Array.isArray(snap.pendingPrompts) ? snap.pendingPrompts : [];
      const mine = prompts.find(p => p && (!p.agentId || (agent && p.agentId === agent.id)));
      if (mine) enterAwait({ promptId: mine.promptId || '', agentId: mine.agentId || (agent && agent.id) });
      else if (awaitPrompt) clearAwait();   // the prompt was answered during the outage
    }
    // ---- delegation window: the server no longer reports an open dispatch we tracked ----
    if (Array.isArray(snap.activeRuns)) {
      // if no reported run belongs to the tracked delegate lead, the delegation window is stale
      if (delegateLead && !snap.activeRuns.some(r => r && r.agentId === delegateLead)) { delegateLead = null; delegateCall = null; }
    }
  }
  /* ---------- desk DISTRESS flash (G0.4 capdenied / G0.8 run-error) ----------
     A brief red warning strobe over the acting agent's desk when its run genuinely dies — the floor's
     honest "something just went wrong HERE" beat. Additive light over the entities (drawn with the
     glow pass); goes steady (no strobe) under prefers-reduced-motion, like every other pulse. */
  const deskFlash = new Map();       // agentId -> { at, color }
  const FLASH_MS = 950;
  function flashDesk(aid, color) {
    const id = aid || (agent && agent.id) || 'agent';
    deskFlash.set(id, { at: (typeof performance !== 'undefined') ? performance.now() : fnow, color: color || '#ff4a3d' });
  }
  function drawDeskFlashes(now) {
    if (!deskFlash.size) return;
    for (const [aid, f] of deskFlash) {
      const k = 1 - (now - f.at) / FLASH_MS;
      if (k <= 0) { deskFlash.delete(aid); continue; }
      // the desk rect (placed workstation / the hero's synthetic desk), else the body's own spot
      let x, y, w, h;
      const b = bodyForAgent(aid), dp = deskPropFor(aid);
      if (dp) { x = dp.x * T; y = dp.y * T; w = (dp.w || 1) * T; h = (dp.h || 1) * T; }
      else if (b === agent && desk) { x = desk.tx * T; y = desk.ty * T; w = desk.w * T; h = desk.h * T; }
      else if (b) { x = b.px - 8; y = b.py - 14; w = 16; h = 16; }
      else { deskFlash.delete(aid); continue; }
      const strobe = reduceMotion() ? 0.8 : ((Math.floor((now - f.at) / 130) % 2 === 0) ? 1 : 0.45);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.38 * k * strobe;
      ctx.fillStyle = f.color; ctx.fillRect(x - 3, y - 6, w + 6, h + 9);
      ctx.globalAlpha = 0.7 * k * strobe;
      ctx.strokeStyle = f.color; ctx.lineWidth = 1; ctx.strokeRect(x - 3.5, y - 6.5, w + 7, h + 10);
      ctx.restore();
    }
  }
  let bridged = false, lastOutboxFlash = -1e9;
  // N1/N2/N3: the channel SSE stream + the connector poll are "opened once" but used to be NEVER released —
  // after a DISCONNECT they kept polling /api/connectors every 5s and the EventSource self-reconnected forever
  // from the title screen. Hoisted here so pauseBridge() (on disconnect) can release them and resumeBridge()
  // (on re-entry) can re-arm them. The U.bus.on(...) subscriptions stay put (idempotent under `bridged`).
  // E6f — API base consistency: the SSE bridge already prefixes window.__STARNET_API__ (the sidecar's loopback
  // origin) so it resolves in the desktop build, where the page origin is the Tauri asset host, NOT the sidecar.
  // Bare /api/* fetches (routing POST, connectors poll) skipped that prefix and would hit the wrong origin there.
  // apiUrl() is the single source of truth so all three use the same base. (Auth token is attached by harness.js's
  // window.fetch monkey-patch for /api/ URLs; the SSE path can't send a header so it appends ?token= separately.)
  function apiBase() { return (typeof window !== 'undefined' && window.__STARNET_API__) ? window.__STARNET_API__ : ''; }
  function apiUrl(path) { return apiBase() + path; }
  let chanES = null, connPollTimer = null, connPollFn = null, connOpenFn = null, bridgePaused = false;
  let spotifyPollTimer = null, spotifyPollFn = null;   // JUKEBOX dead-vs-live poll (shares the bridge pause/resume lifecycle)
  // LINK-DOWN HONESTY (Lane E1): the live station telemetry (queue gauges, run clocks) is only truthful while
  // the SSE bridge is actually delivering events. Track the last DATA event's wall-clock and the socket's
  // readyState so a dead/stalled link renders an honest degraded state instead of freezing the last-known truth.
  // The server sends a keep-alive COMMENT (`: ka`) every 25s (see index.js handleChannelEvents) — comment lines
  // do NOT surface to EventSource.onmessage, so a healthy-but-quiet stream can legitimately look silent for up to
  // 25s. LINK_STALE_MS sits comfortably above that so a quiet stream is never mislabelled down; the readyState
  // check is the primary, fast signal (a truly dropped socket flips to CONNECTING/CLOSED within the retry window).
  let lastSseEventAt = 0;              // performance.now() of the last DATA frame actually received over chanES
  const LINK_STALE_MS = 40000;         // 40s: keep-alive is 25s; only flag stale well beyond one missed keep-alive
  // link is DOWN when the bridge is meant to be live (not deliberately paused to the title screen) and EITHER the
  // socket is not OPEN, OR it has gone stale (no data for > LINK_STALE_MS AND not currently OPEN). Never "down"
  // when bridgePaused (the user disconnected on purpose) or before the bridge was ever opened (no chanES yet AND
  // never stamped) — an un-opened bridge shows nothing rather than a false alarm.
  function linkDown(now) {
    if (bridgePaused) return false;                                   // deliberately disconnected — not a fault
    if (!bridged) return false;                                       // bridge never set up yet (pre-entry)
    const open = !!(chanES && typeof EventSource !== 'undefined' && chanES.readyState === EventSource.OPEN);
    if (!open) return true;                                           // socket missing / connecting / closed → down
    if (lastSseEventAt && (now - lastSseEventAt) > LINK_STALE_MS) return true;   // half-open: bytes stopped flowing
    return false;
  }
  function pauseBridge() {
    bridgePaused = true;
    if (connPollTimer) { clearInterval(connPollTimer); connPollTimer = null; }
    if (spotifyPollTimer) { clearInterval(spotifyPollTimer); spotifyPollTimer = null; }
    if (chanES) { try { chanES.close(); } catch (_) {} chanES = null; }
  }
  // E1: the ONE public read of the SSE bridge health — the SAME predicate the canvas dims its live
  // telemetry with (linkStaleDim). Chrome instruments outside world.js (topbar #sig / #status-pill,
  // widget rail, model dock) read this so a dead sidecar reads as down everywhere, not just on the
  // canvas. `down` is the honest fault; `paused` = user deliberately disconnected (title screen);
  // `bridged` = the bridge was ever opened (pre-entry, both are false — instruments show a neutral
  // "not yet live" state, never a false alarm).
  function linkState() {
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    return { down: linkDown(now), paused: bridgePaused, bridged: bridged };
  }
  function resumeBridge() {
    if (!bridged) return;                 // never set up yet (no agent has entered) — connectChannelBridge will open it
    bridgePaused = false;
    if (!connPollTimer && connPollFn) { connPollFn(); connPollTimer = setInterval(connPollFn, 5000); }
    if (!spotifyPollTimer && spotifyPollFn) { spotifyPollFn(); spotifyPollTimer = setInterval(spotifyPollFn, 5000); }
    if (!chanES && connOpenFn) connOpenFn();
  }
  let floor = null, lastSlagAt = -1e9;   // FloorStats: the factory-floor economy fold + a fresh-slag pulse clock
  let slaglog = null, lastCacheFrac = null;   // SlagLog: wasted-spend post-mortems + the last reconciled cache ratio (for the diagnosis)

  // a belt tile on/adjacent to a footprint (its tiles + a 1-tile ring), used as a box spawn point (local frame)
  function beltTileNear(tx, ty, tw, th) {
    if (!geo || !geo.belts || !geo.belts.length) return null;
    const beltSet = new Set(geo.belts.map(b => b.x + ',' + b.y));
    for (let yy = ty - 1; yy <= ty + th; yy++)
      for (let xx = tx - 1; xx <= tx + tw; xx++)
        if (beltSet.has(xx + ',' + yy)) return { x: xx, y: yy };
    return null;
  }
  function intakeTile() {
    const intake = geo && geo.props && geo.props.find(p => p.t === 'intake');
    return intake ? beltTileNear(intake.x, intake.y, intake.w || 1, intake.h || 1) : null;
  }
  /* compile the floor into a RoutingPlan and push it to the sidecar. ONE compiler (pipeline.js) feeds BOTH
     the visual junctions below AND the server's autonomous dispatch, so "the box you watch ride to a bay" and
     "the agent that actually runs" can never drift. The plan is derived from the same local-frame geo the
     conveyor animates. If Pipeline isn't loaded, routingPlan stays null and buildJunctions() falls back. */
  function compileRouting() {
    routingPlan = (typeof Pipeline !== 'undefined' && geo) ? Pipeline.compileRoutingPlan(geo) : null;
    // the energized-belt set: derived from the SAME plan the sidecar routes by, so a glowing line always
    // means "a complete route runs here" and a cold line always means the chain is incomplete
    beltLiveSet = (routingPlan && Pipeline.liveTiles) ? Pipeline.liveTiles(routingPlan) : null;
    beltTileSet = new Set(((geo && geo.belts) || []).map(b => b.x + ',' + b.y));
    routeTagCache = null; hoverBeltTile = null;   // the floor changed — every cached hover answer is stale
    routingNags = buildRoutingNags();
    /* GHOST PROJECTION (Phase 3): re-derive its route data from the SAME plan + geometry this
       recompile produced. The live world runs it too (not just REFIT): between REFIT sessions this
       is the view the user stares at their half-built line in, and the existing nags say what's
       broken while the ghost shows what the line WOULD do — same local frame, offset {0,0}. */
    if (typeof GhostLine !== 'undefined' && typeof Pipeline !== 'undefined' && Pipeline.lineComponents && geo) {
      ghost = ghost || GhostLine.create();
      ghost.setContext({ plan: routingPlan, comps: Pipeline.lineComponents(geo), offset: { tx: 0, ty: 0 } });
    }
    // B5: enrich each bay with the capability objectTypes in its room, so the sidecar can isolate that agent's
    // tools to exactly what the floor placed there (the bay->agent binding decides WHO; the room decides WHAT).
    // dockBays too — a LONE bay (no belt) is a complete dock and isolates identically (sense pass 2026-07-05).
    if (routingPlan && station && typeof station.bayObjects === 'function') {
      for (const b of (routingPlan.bays || [])) b.objects = station.bayObjects(b.agentId);
      for (const b of (routingPlan.dockBays || [])) b.objects = station.bayObjects(b.agentId);
    }
    postRoutingPlan(routingPlan);
  }
  /* PLAN-POSTER-BEGIN (extraction marker — test/plan-poster.test.js evals this block with injected deps;
     keep it PURE: params + locals only, no module state, no direct fetch/console/setTimeout).

     Delivery of the compiled plan to /api/routing, with the hash committed ONLY on a server answer — the old
     fire-and-forget committed the dedupe hash BEFORE the fetch and swallowed every failure, so one dropped
     POST left the sidecar routing by a STALE floor forever while the world drew the new one (audit 2026-08-04).
     Semantics:
       • 200 → commit the hash (dedupe as before: same topology+caps never re-posts), clear staleness.
       • 422 → the PLAN ITSELF is refused (cycle/orphan) — re-posting the same hash is pointless, so commit it
         and record the refusal. Not stale: the sidecar holds (and persists) the CLEARED plan, and the floor
         already draws the same compiler errors as nags — live truth on both sides.
       • network failure / other status → do NOT commit; bounded fixed-delay retries, then give up until the
         next offer (rederive re-offers the uncommitted hash). `stale` stays true — server-side routing may
         not match the drawn floor — and each failure warns via deps.warn.
     A newer offer supersedes any pending retry (seq guard: a late stale response can never commit). */
  function makePlanPoster(deps) {
    const MAX_RETRIES = 3, RETRY_MS = 4000;   // bounded + fixed-delay (deterministic-friendly); rederive re-offers after
    let lastHash = null;      // last hash the server ANSWERED (200 committed / 422 refused) — never committed on a guess
    let refusedHash = null;   // the hash of the last 422-refused plan (refusal state, inspectable)
    let pendingHash = null;   // the hash currently being delivered (in flight or awaiting a retry tick)
    let inflight = false, timer = null, seq = 0;
    let stale = false;        // honest flag: the sidecar may still route by an older floor than the one drawn
    let waiters = [];         // flush() callers awaiting the NEXT server answer (run-now ordering, 2026-08-22)
    function state() { return { lastHash: lastHash, refusedHash: refusedHash, pendingHash: pendingHash, inflight: inflight, retryPending: timer != null, stale: stale }; }
    function settle() { const w = waiters; waiters = []; const s = state(); for (const f of w) { try { f(s); } catch (_) {} } }
    /* flush(): a promise of the poster's state once the in-flight delivery has a verdict — resolved at once
       when nothing is pending. A run trigger (sample / RUN NOW) awaits THIS before dispatching so the sidecar
       routes the line the user just drew, not the last one it heard about. A failed attempt resolves too
       (stale=true, retries continue in the background): the caller refuses rather than running a stale floor. */
    function flush() { return new Promise(resolve => { if (!inflight && timer == null) resolve(state()); else waiters.push(resolve); }); }
    function offer(plan, hash) {
      if (hash === lastHash) return false;                                   // server already answered this exact floor
      if (hash === pendingHash && (inflight || timer != null)) return false; // same floor already being delivered
      if (timer != null) { deps.cancel(timer); timer = null; }               // a different floor supersedes the pending retry
      pendingHash = hash;
      send(plan, hash, 0, ++seq);
      return true;
    }
    function send(plan, hash, attempt, mySeq) {
      const fail = why => {
        if (mySeq !== seq) return;   // superseded — the newer offer owns delivery (and the flags) now
        inflight = false;
        stale = true;
        deps.warn('[routing] plan post failed (' + why + ') — sidecar routing may be stale' +
          (attempt < MAX_RETRIES ? '; retrying in ' + RETRY_MS + 'ms' : '; will retry on the next floor change'));
        if (attempt < MAX_RETRIES) timer = deps.delay(() => { timer = null; send(plan, hash, attempt + 1, mySeq); }, RETRY_MS);
        settle();
      };
      let p = null;
      inflight = true;
      try { p = deps.post(plan); } catch (_) { fail('exception'); return; }
      Promise.resolve(p).then(res => {
        if (mySeq !== seq) return;   // superseded — never let a stale response commit or clear flags
        inflight = false;
        if (res && res.ok) { lastHash = hash; refusedHash = null; pendingHash = null; stale = false; settle(); return; }
        if (res && res.status === 422) { lastHash = hash; refusedHash = hash; pendingHash = null; stale = false; settle(); return; }
        fail('http ' + (res ? res.status : '?'));
      }, () => fail('network'));
    }
    return { offer: offer, state: state, flush: flush };
  }
  /* PLAN-POSTER-END */
  // one poster for the module; on transient failure it warns and keeps `stale` true. No new UI surface:
  // an unreachable sidecar already raises the LINK DOWN chrome (linkDown/linkState — the one honest
  // connectivity signal), and _dbgBeltLegibility exposes planSync for the verify harness.
  const planPoster = makePlanPoster({
    post: plan => fetch(apiUrl('/api/routing'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan || {}) }),
    warn: m => { try { console.warn(m); } catch (_) {} },
    delay: (fn, ms) => setTimeout(fn, ms),
    cancel: id => clearTimeout(id)
  });
  // post the plan to /api/routing when the floor TOPOLOGY actually changed (hash dedupe — rederive() also runs
  // on pure camera/agent moves). The sidecar REFUSES a non-deployable plan (cycle/orphan) and falls back to its
  // default resolution, so a broken floor disables routed-mode rather than stalling work.
  function postRoutingPlan(plan) {
    if (typeof fetch === 'undefined') return;
    // dedupe on topology hash + per-bay caps, so equipping a bay (a capability change with no belt change) still re-POSTs
    const objKey = o => (o && typeof o === 'object') ? (o.objectType + '#' + (o.connectorId || '')) : o;   // connector objs carry a binding; stringify it so a re-bind re-POSTs
    // dockBays BRIEFS ride the key too (step editor): a belt-hooked bay's brief already moves plan.hash
    // (it compiles into `bays`), but a LONE dock's brief lives only in dockBays — outside the hash — and
    // editing it must still reach the sidecar's copy or stageBrief() serves a stale duty line.
    const hash = plan ? ((plan.hash || '') + '|' + (plan.bays || []).map(b => b.agentId + ':' + ((b.objects || []).map(objKey).join(','))).join(';')
      + '|' + (plan.dockBays || []).map(b => b.propId + ':' + (b.brief || '')).join(';')
      // LINE BUDGET rides the key too (2026-08-21): limits live on `lines`, outside plan.hash (policy, not
      // topology — splitter balance must survive a cap edit), but the sidecar's copy must re-read them.
      + '|' + JSON.stringify(plan.lineLimits || {})) : '';
    planPoster.offer(plan, hash);
  }
  // junction props (splitter/filter/merger) keyed by tile — derived from the compiled plan so the VISUAL engine
  // animates filters + mergers (not just splitters) using the SAME config the dispatch router routes by.
  function buildJunctions() {
    if (routingPlan && routingPlan.junctions) {
      let j = null;
      // enrich each junction with its lanes' reachable OWNERS so addressed crates ride home (a shallow
      // copy — never mutate the plan object itself; the sidecar-posted plan/hash stays untouched)
      const owners = (typeof Pipeline !== 'undefined' && Pipeline.junctionLaneOwners) ? Pipeline.junctionLaneOwners(routingPlan) : {};
      for (const k in routingPlan.junctions) (j = j || new Map()).set(k, owners[k] ? Object.assign({}, routingPlan.junctions[k], { owners: owners[k] }) : routingPlan.junctions[k]);
      return j;
    }
    // fallback (Pipeline unavailable): the original splitter-only scan keeps belts animating
    let j = null;
    if (geo && geo.props) for (const p of geo.props) {
      if (p.t === 'splitter') (j = j || new Map()).set(p.x + ',' + p.y, { kind: 'split' });
    }
    return j;
  }
  // a real inbound message arrived — drop a box at the INTAKE so it rides the belts to the desk. The box carries
  // a CONTENT TAG (the same getTag the sidecar routes by) so a FILTER junction visibly sorts it toward the
  // matching agent's bay — frontend sort == backend dispatch.
  /* WHOSE WORK IS THIS? (work belongs to a line, 2026-08-07 — Andrew's ruling.) A work-item that entered
     through a LINE'S OWN TRIGGER carries that line's `lineId` on its crate; a direct order (a COMMS
     directive, an ad-hoc job) carries none. The floor keeps the last answer per dock so the SHIP decision
     below can tell the two apart. Truthful telemetry cuts both ways: never draw a workflow that
     didn't run, never hide a run that did. */
  /* OVERLAP-SAFE (2026-08-11 audit #5): liveRunsByAgent means one dock can have SEVERAL runs in
     flight, so a single latched value per agentId is a lie under overlap — the newest work-item
     overwrote whose-line-is-this for a run that started earlier. Each dock now keeps a bounded FIFO
     of placed work-items' line identity; the ship decision consumes the OLDEST entry (runs end in
     roughly placement order — the same pairing basis the queue gauge runs on). */
  const dockLineWork = new Map();   // agentId -> [lineId|null, ...] per placed work-item, oldest first
  function dockLineTake(aid) {
    const q = dockLineWork.get(aid);
    if (!q || !q.length) return null;
    const v = q.shift();
    if (!q.length) dockLineWork.delete(aid);
    return v;
  }
  function intakeMessage(payload) {
    const p = payload || {};
    /* THE HANDOFF ARRIVED — so the producing dock's own crate must NOT also ship (see shipProductCrate:
       the wait exists precisely because this may never come). This runs FIRST, ahead of every early
       return below: cancelling is bookkeeping about a run that already happened, and it must not depend
       on whether this floor currently has a conveyor to draw the arriving crate on. */
    if (p.kind === 'chain' && p.from) cancelDeferredShip(String(p.from));
    if (!convey) return;
    // tag the box with its content kind (the same getTag the sidecar routes by) so a FILTER sorts it visibly
    if (p.agentId) {
      const q = dockLineWork.get(p.agentId) || [];
      q.push(p.lineId ? String(p.lineId) : null);          // a direct order queues NULL — "this one is nobody's line"
      if (q.length > 8) q.shift();                          // bounded like every floor latch
      dockLineWork.set(p.agentId, q);
    }
    if (!p.tag && typeof Classify !== 'undefined' && Classify.getTag) p.tag = Classify.getTag(p.preview || p.text || '');
    // ride inbound work as ORE — a UNIFORM raw chunk: every incoming request is one identical piece of raw
    // material on the line. We deliberately DON'T size it; product-vs-slag is the rewarded signal,
    // bound to real outcomes, never to this inbound request. (WIRING_AUDIT P4: lie #5.)
    p.box = 'ore';
    if (p.weight == null) p.weight = 0.3;
    // WHERE does this work ENTER the floor? (multi-network law, 2026-07-05 — Andrew's two-room bug):
    //  • a COMMS directive is a DIRECT order to a specific agent — it skips the station doors entirely and
    //    lands at that agent's BAY (the model sentence: "COMMS orders skip the ride in");
    //  • addressed channel/cron work enters through the INBOX whose line actually REACHES its agent's dock
    //    (Pipeline.sourceFor — each room's INBOX feeds its own network, never another room's outbox);
    //  • unaddressed work takes the first INBOX (unchanged);
    //  • no reaching line → the work lands directly at the agent's BAY dock (a lone bay is a complete build).
    /* A HANDOFF DOES NOT ENTER THROUGH THE FRONT DOOR. A `chain` work-item is stage N of a work line: it was
       produced at the UPSTREAM dock and rides that dock's lane to this one. Spawning it at an INTAKE would
       draw a lie — the station never received anything, one of its own agents did. The upstream dock is the
       event's `from` (the PRODUCER — the chain runner names it since 2026-08-04); an old event without it
       falls back to the plan heuristic (alphabetically-first dock whose chain reaches this agent). The crate
       is PRODUCT, not ore, because that is exactly what it is; `fromAgentId` rides the payload so the
       conveyor's dock-delivery physics can refuse to eat a dock's own output (a dock never consumes what it
       produced — see conveyor.js tick / pipeline.js chain layer). */
    if (p.kind === 'chain' && routingPlan && routingPlan.chains) {
      p.box = 'product';
      const upAid = (p.from && routingPlan.chains[p.from]) ? p.from
        : Object.keys(routingPlan.chains).filter(a => (routingPlan.chains[a].next || []).indexOf(p.agentId) >= 0).sort()[0];
      const from = upAid ? routingPlan.chains[upAid] : null;
      if (upAid) p.fromAgentId = upAid;
      if (from && from.tile) { convey.enqueueAt(from.tile.x, from.tile.y, p); return; }
      dockArrival(p); return;                                       // no drawn lane between them — land it at the dock
    }
    let t = null;
    if (p.kind !== 'directive') {
      t = (p.agentId && routingPlan && typeof Pipeline !== 'undefined' && Pipeline.sourceFor)
        ? Pipeline.sourceFor(routingPlan, p.agentId)
        : intakeTile();
    }
    if (t) convey.enqueueAt(t.x, t.y, p);
    else dockArrival(p);
    // ANTICIPATE: an idle agent senses work on the line and perks up toward the door it ACTUALLY entered
    // (the chosen entry tile — on a multi-inbox floor the first-intake glance pointed at the wrong door).
    if (agent && !agent.unplaced && activity === 'idle' && !agent.working) {
      const at = t || (geo && geo.props && geo.props.find(q => q.t === 'intake'));
      if (at) setGlance(dirToward(agent.px, agent.py, (at.x + 0.5) * T, (at.y + 0.5) * T), 1100, fnow);
      curiositySay(['incoming?', 'work inbound', 'something is coming', 'heads up'], 0.6, fnow);
      if (agent.goal == null) agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 200);
    }
  }
  /* LONE-BAY DOCK ARRIVAL: with no intake/belt route, work addressed to an agent still lands VISIBLY at its
     bay — a dock flash + the same "received:" beat the belt delivery rings. This is what makes a single
     assigned BAY a complete, working build (belts become the upgrade for watching work travel, never a
     prerequisite). Purely visual: the sidecar already ran the work either way (belt-is-never-a-gate law). */
  const dockFlashes = new Map();   // bay propId -> flash t0 (drawn by drawDockFlashes, ~1.1s decay)
  function dockArrival(p) {
    const aid = p && p.agentId;
    const docks = (routingPlan && routingPlan.dockBays) || [];
    // ADDRESSED work flashes ONLY its own agent's dock — never another agent's (that's a wrong-agent
    // reaction, the exact confusion this lane kills). Only UNADDRESSED work falls back to the first dock.
    const dock = aid ? docks.find(d => d.agentId === aid) : docks[0];
    if (!dock) return;                                             // no (matching) bay → nothing to show (today's behavior)
    dockFlashes.set(dock.propId, fnow);
    const body = bodyForAgent(aid);
    if (body && body !== agent) { sayAt(body, 'received: ' + (p.preview || 'message')); body.wakeAt = fnow; if (!(body.workUntil > fnow + 5000)) body.workUntil = fnow + 4000; }
    else if (agent && !agent.unplaced) { say('received: ' + (p.preview || 'message')); wakeIn(); }
  }
  // the dock catching a delivery: a bright ring + rim flash over the bay, ~1.1s, additive (with the glows)
  function drawDockFlashes(now) {
    if (!dockFlashes.size || !routingPlan || !routingPlan.dockBays) return;
    for (const [pid, t0] of dockFlashes) {
      const k = 1 - (now - t0) / 1100;
      if (k <= 0) { dockFlashes.delete(pid); continue; }
      const d = routingPlan.dockBays.find(b => b.propId === pid);
      if (!d) { dockFlashes.delete(pid); continue; }
      const X = d.x * T, Y = d.y * T, Wd = (d.w || 1) * T, Hd = (d.h || 1) * T;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * k;
      ctx.strokeStyle = '#e8c860'; ctx.lineWidth = 1.5;
      const grow = (1 - k) * 5;
      ctx.strokeRect(X - grow, Y - grow, Wd + grow * 2, Hd + grow * 2);   // the expanding catch ring
      ctx.globalAlpha = 0.35 * k; ctx.fillStyle = '#e8c860';
      ctx.fillRect(X, Y, Wd, 2);                                          // hot rim on the dock's crown
      ctx.restore();
    }
  }
  // a belt tile to ship an outbound box from — beside the PRODUCING agent's own bay, not always the hero's.
  // The hero ships from its desk (byte-identical); a crew/summoned agent ships from a belt tile beside ITS
  // body; an unknown agent falls back to the hero desk. (WIRING_AUDIT P3: kill the single-hero-desk assumption.)
  function outboundBeltTile(aid) {
    // 1) the PRODUCING agent's own BAY hookup — finished work leaves from the dock, riding the bay→OUTBOX
    //    lane exactly like a ▸ TEST crate (2026-07-05 fix: the old desk-first order meant a hero with a
    //    belted BAY never shipped a riding crate, because no belt runs to the desk by design).
    if (aid && routingPlan && routingPlan.bays) {
      const b = routingPlan.bays.find(x => x.agentId === aid);
      const cand = b ? ((b.tiles && b.tiles.length) ? b.tiles : (b.tile ? [b.tile] : [])) : [];
      // a dock can touch several lanes (inbound + outbound): prefer the hookup whose ONWARD flow ships
      // to an OUTBOX — probe from the tile past it, since the hookup itself reads as the bay
      if (cand.length && typeof Pipeline !== 'undefined' && Pipeline.routeFrom && routingPlan.belts) {
        const DV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
        for (const c of cand) {
          const d = routingPlan.belts[c.x + ',' + c.y], v = d && DV[d];
          if (!v) continue;
          const nx = c.x + v[0], ny = c.y + v[1];
          if (!routingPlan.belts[nx + ',' + ny]) continue;
          const r = Pipeline.routeFrom(routingPlan, nx, ny);
          if (r && r.outbox) return c;
        }
      }
      if (cand.length) return cand[0];
    }
    // 2) a crew body ships from a belt tile beside where it stands
    if (aid && agent && aid !== agent.id) {
      const b = bodyForAgent(aid);
      if (b && b !== agent) { const tt = tileOf(b.px, b.py); return beltTileNear(tt.x, tt.y, 1, 1); }
      // a CREW agent with no bay and no body has NO honest spawn point — no crate beats a crate
      // materializing on the HERO's lane (wrong-agent reaction; 2026-07-06 audit).
      return null;
    }
    // 3) legacy fallback (HERO only): a belt beside the hero's desk
    return desk ? beltTileNear(desk.tx, desk.ty, desk.w, desk.h) : null;
  }
  /* A COMPLETED RUN SHIPS A CRATE — BUT ONLY IF IT ACTUALLY WORKED (crate-honesty, Andrew's ruling
     2026-07-05): reason 'done' alone is NOT success — a run that ends by politely explaining it couldn't
     do the job is 'done' too. A crate (and the SHIPPED count) requires PROVEN work: ≥1 successful tool
     result or a produced deliverable during the run, tracked from the same bus events the tickers ride.
     The single crate source stays agent.run.end (no double-crate from workitem.delivered); no lane → no
     riding crate (the pallet + counter still tell the server's truth). */
  /* Keyed per RUN, not per agent (overlap-safe, 2026-08-11 audit #5): every runtime event carries
     runId, so two overlapping runs at one dock each keep their own proven-work tally — the old
     per-agent slot let run 2's start wipe run 1's tools, and run 1's end delete run 2's tally, so a
     productive overlapped run shipped nothing. `deliverable` is the one event WITHOUT a runId; it
     attributes to the agent's OLDEST live run (same FIFO pairing basis as dockLineWork). */
  const runWork = new Map();         // runId (or agentId when the event has none) -> { agentId, tools, dels }
  const liveRunOrder = new Map();    // agentId -> [runWork keys, oldest first] — attribution for runId-less events
  const runKey = p => (p && (p.runId || p.agentId)) || 'agent';
  function oldestLiveRun(aid) { const l = liveRunOrder.get(aid || 'agent'); return (l && l.length) ? l[0] : null; }
  const shippedRunIds = new Set();   // dedup: run.end can be observed twice (local harness + SSE echo)
  // runId -> summed RECONCILED usd (folded from agent.cost, whose contract requires reconciled:true).
  // This is the ONLY source the product crate's mass may read — never cost.estimate, never run.end's usd
  // (crate-mass honesty: the crate that leaves the line weighs what the run actually cost). Bounded like
  // shippedRunIds; entries are dropped at run.end after the ship decision reads them.
  const runUsdRecon = new Map();
  function runWorked(p) {
    const w = runWork.get(runKey(p));
    return !!(w && (w.tools > 0 || w.dels > 0));
  }
  /* NEVER NEITHER (2026-08-07 conveyor audit). The suppression below is right when the handoff crate
     really comes — but it was unconditional, and the handoff is decided by the SIDECAR, later, against a
     plan that may have been re-posted in between (a floor edit mid-run re-keys the line; the chain gate
     then refuses to advance). Outcome: no handoff crate ever placed, the dock's own crate suppressed, and
     a run the Commander PAID for left no mark on the floor at all — the floor asserting "nothing happened"
     about work that did. So the suppression is now a WAIT, not a drop: hold the dock's crate for the grace
     window, cancel it the moment the upstream handoff is actually placed (intakeMessage cancels on the
     chain item's `from`), and ship it if the handoff never arrives. Exactly one crate either way. */
  const HANDOFF_GRACE_MS = 8000;   // generous: the hop is a real model run being dispatched, not a tick
  /* A dock may hold SEVERAL waits at once (overlapping runs, audit #5): the old single-timer slot made
     run 2's defer CANCEL run 1's held crate outright — paid work erased from the floor. Each wait is
     its own entry; a real handoff cancels the OLDEST (the handoff the sidecar places first belongs to
     the run that ended first), and an expiring wait removes only itself. K waits in, K crates out. */
  const deferredShip = new Map();  // producing agentId -> [{ t: timerId }, ...] oldest first
  function cancelDeferredShip(aid) {
    const q = aid && deferredShip.get(aid);
    if (q && q.length) { clearTimeout(q.shift().t); if (!q.length) deferredShip.delete(aid); }
  }
  function clearDeferredShips() { for (const q of deferredShip.values()) for (const e of q) clearTimeout(e.t); deferredShip.clear(); }
  // the crate's MASS must be read NOW: run.end drops runUsdRecon the instant this returns, so a deferred
  // ship that re-read it later would weigh every crate 0 (crate-mass honesty).
  function productCrateSpec(p) {
    const w = (typeof Conveyor !== 'undefined' && Conveyor.weightForUsd) ? Conveyor.weightForUsd(runUsdRecon.get((p && p.runId) || '')) : 0;
    return { outbound: true, box: 'product', weight: w, workitemId: (p && p.workitemId) || '' };
  }
  function emitProductCrate(aid, spec) {
    if (!convey) return;
    const t = outboundBeltTile(aid);
    if (t) convey.enqueueAt(t.x, t.y, spec);
  }
  function shipProductCrate(p) {
    if (!convey) return;
    // A NON-TERMINAL STAGE SHIPS NOTHING OUT — *WHEN ITS WORK IS THE LINE'S*. If this dock's output hands off
    // to another dock, its product IS the handoff crate (drawn when the sidecar places the next stage's
    // work-item) — also spawning a ship-out crate here would draw the same work leaving twice, once toward a
    // door it never went through.
    // BUT a DIRECT ORDER at the same dock hands off to nobody (work belongs to a line, 2026-08-07): no chain
    // crate is coming, so suppressing this one would erase real, delivered work from the floor. The dock's
    // belts still say "hands off to X"; what decides is whether THIS run's work belonged to X's line.
    const cAid = (p && p.agentId) || '';
    const rid = (p && p.runId) || '';
    // dedup FIRST (run.end is observed twice — local harness + SSE echo) so an echo can't arm two waits
    if (rid) { if (shippedRunIds.has(rid)) return; shippedRunIds.add(rid); if (shippedRunIds.size > 400) shippedRunIds.clear(); }
    // MASS = the run's real reconciled cost (cargoProduct's contract) — the old hardcoded 0.3 drew every
    // crate mid-weight regardless of spend. Conveyor.weightForUsd maps reconciled usd -> 0..1; a run with
    // no reconciled cost ships weight 0 (the back-compat light look), never an estimate.
    const spec = productCrateSpec(p);
    const ch = (cAid && routingPlan && routingPlan.chains) ? routingPlan.chains[cAid] : null;
    // consume THIS run's placement entry (oldest first) — never cancel a sibling run's held crate
    if (ch && ch.next && ch.next.length && dockLineTake(cAid)) {
      const q = deferredShip.get(cAid) || [];
      const entry = {};
      entry.t = setTimeout(() => {
        const l = deferredShip.get(cAid);
        if (l) { const i = l.indexOf(entry); if (i >= 0) l.splice(i, 1); if (!l.length) deferredShip.delete(cAid); }
        emitProductCrate(cAid, spec);
      }, HANDOFF_GRACE_MS);
      q.push(entry);
      deferredShip.set(cAid, q);
      return;
    }
    emitProductCrate(cAid, spec);
  }
  // an unproductive run produced no deliverable — ride a red-hot SLAG crate off the PRODUCING agent's bay
  // carrying its post-mortem one-liner, so the failed outcome is visible leaving the line.
  function enqueueSlag(diag, aid) {
    if (!convey) return;
    const t = outboundBeltTile(aid);
    const clean = s => String(s || '').replace(/\bspend\b/ig, 'run resources').replace(/\bdollars?\b/ig, 'limits');
    if (t) convey.enqueueAt(t.x, t.y, { outbound: true, box: 'slag', postmortem: (diag && (clean(diag.title) + ' - ' + clean(diag.fix))) || 'unproductive run' });
  }
  /* ---------- crew bodies (the OTHER agents, standing at their bays) ---------- */
  // a LIGHT body: the full agent field-shape (so SPRITES.drawBody/drawFallback never choke) but STATIC —
  // it never ticks/paths. It only receives work (a say bubble + a wake ripple + a bay work-glow).
  function makeCrewBody(aid, name, color, fx, fy, skin) {
    return {
      id: aid, agentId: aid, name: name || aid, color: color || '#5ad0ff', skin: skin || DATA.DEFAULT_SKIN, crewBody: true,
      // P2 STABLE HOME: the spawn foot tile, pinned ONCE here. anchorFor's deskless leash-fallback reads this
      // (never the live px/py) so a wandering body's leash stays CENTRED ON ITS SPAWN SPOT and does not ratchet
      // across the floor in DEFAULT_LEASH hops as it strolls (A2 'bounded leash' / world.js anchor note: stable home).
      home: tileOf(fx, fy),
      px: fx, py: fy, dir: 'south', state: 'idle', sitting: false, working: false, unplaced: false,
      // `phase` stays an INTEGER (phaseOf indexes PHASES[] with it); `aph` is the FLOAT sprite offset — see the hero's note.
      phase: U.hash('' + aid) % 6, aph: (U.hash('' + aid) % 600) / 100, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
      usingProp: null, useUntil: 0, useFace: 'south', useSit: false, watchProp: null,
      lastFun: null, lastFunUntil: 0,
      deskVisitCd: 0, exploreCd: 0,
      seated: false, seatPx: 0, seatPy: 0, seatKey: null, pendSeat: null,
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0, studyKey: null,
      summonGlanceCd: 0,   // Tier C / C-Beat1: per-observer refractory (mirrors the hero literal) — runtime-only
      neighborGlanceCd: 0, // Tier C / C-Beat2: per-body mutual-glance cooldown (mirrors the hero literal) — runtime-only
      barJoinCd: 0, barJoinUntil: 0,
      wakeAt: 0, workUntil: 0,
      // B0 — FULL ENGINE STATE SHAPE (additive, runtime-only): mirror the hero literal (spawn ~346-367) so a
      // crew body reads real meters/temperament when Tier B2 routes the sentience engine through it (stepCrew →
      // crewEngineStep, with self=b). Every field is per-body: a FRESH needs object and a NEW fond Map (never a
      // shared reference) so no body ever
      // reads/mutates another's state (J2). Determinism: needs seeded via U.irnd, temperament via makePersonality
      // (U.hash, no RNG) — no Math.random/Date.now (J5).
      pers: makePersonality(aid),
      needs: { rest: U.irnd(72, 92), stim: U.irnd(72, 92), social: U.irnd(72, 92) },   // born content (same init as the hero)
      lastTaskAt: 0, thinkUntil: 0, settleUntil: 0, trackUntil: 0,
      quirkKind: null,
      placeTarget: null, removeId: null,
      roundsQueue: null, roundsCd: 0,
      fond: new Map(), revisitCd: 0,   // SPATIAL MEMORY: a NEW Map per body — never shared
      pauseUntil: 0, pauseLook: null, pauseCd: 0, yieldCd: 0, lookBackCd: 0,
      attn: null, drive: null, driveUntil: 0,   // CONTINUITY OF ATTENTION — per-body like every sibling field (never shared)
      stilling: false,
      inspectNovel: null, lookCd: 0,   // lazily-read engine fields (arrive/planInspect/maybeGlance) seeded so first read isn't undefined
      // per-body cooldown gates the engine reads via self (quirkCd/offbeatCd are now per-body in maybeQuirk/offbeat —
      // no swarm-wide lockstep; placeCd/mournCd seeded for the same per-body discipline as B3 generalizes those gates).
      quirkCd: 0, offbeatCd: 0, placeCd: 0, mournCd: 0
    };
  }
  // reconcile `crew` with the plan's bound bays: one light body per bay (except the hero's own), standing at
  // the bay prop's foot. Reuses existing bodies by agentId so a re-bake doesn't wipe a live say bubble.
  function syncCrewFromPlan() {
    // No bound bays (or no geo yet): drop the plan-derived crew, but KEEP summoned bodies — a summoned-but-unbound
    // agent has no bay, so an empty plan must NOT wipe it (else it vanishes on the next rederive, e.g. a build toggle).
    if (!routingPlan || !routingPlan.bays || !routingPlan.bays.length || !geo) {
      crew = crew.filter(b => b.summoned);
      if (geo) refootStranded();   // the no-bays plan used to SKIP the stranded re-foot entirely — a summoned body off the floor (pre-geo {0,0} park, a refit) stayed in the void forever (2026-07-12)
      sweepAgentMaps(); return;
    }
    const want = new Map();
    for (const bay of routingPlan.bays) {
      if (agent && bay.agentId === agent.id) continue;                 // the hero already represents its own bay
      const p = geo.props && geo.props.find(pp => pp.id === bay.propId);
      if (!p) continue;
      // foot IN FRONT of the bay (south approach, PropAnchor side-fallback) — never inside the bay's own
      // footprint: a body footed on the bay's bottom tile sits one pixel above the bay's y-sort line, so the
      // taller bay sprite draws OVER it and the agent reads as missing (the every-relaunch "agents hiding
      // behind their bay" bug, 2026-07-07). A walled-in bay / missing module falls back to the old
      // bottom-centre foot so the body still exists somewhere rather than nowhere.
      let f = null;
      if (typeof PropAnchor !== 'undefined') {
        const a = PropAnchor.deriveAnchor(p, geo, { approach: 'south', extra: blocked });
        if (a) f = footOf(a.tx, a.ty);
      }
      want.set(bay.agentId, f || { x: (p.x + (p.w > 1 ? 1 : 0)) * T + T / 2, y: (p.y + (p.h || 1) - 1) * T + T - 1 });
    }
    crew = crew.filter(b => b.summoned || want.has(b.agentId));        // drop plan bodies whose bay is gone; KEEP summoned crew
    for (const [aid, pos] of want) {
      const b = crew.find(x => x.agentId === aid && !x.summoned);
      if (b) { b.px = pos.x; b.py = pos.y; }
      else if (!crew.some(x => x.agentId === aid)) crew.push(makeCrewBody(aid, aid, crewColor(aid), pos.x, pos.y));
    }
    refootStranded();   // a refit may have moved the floor under a summoned body — re-foot any that no longer stand on a walkable tile.
    sweepAgentMaps();   // E6b: an agent dropped from the roster leaves per-agent map entries — evict them here
  }
  // re-foot every SUMMONED body that no longer stands on a walkable tile (plan-derived bodies are
  // re-set at their bay foot by syncCrewFromPlan itself; a deliberately-fallback bay foot may sit on
  // the bay footprint, so they are excluded). Re-pins the leash home too: the spawn spot genuinely
  // moved (A2 stays centred on the new home). Seated/desk-sitting bodies legitimately render on a
  // prop tile — never evict those.
  function refootStranded() {
    if (!geo) return;
    for (const b of crew) {
      if (!b.summoned || b.seated || b.sitting) continue;
      const t = tileOf(b.px, b.py);
      if (!geo.walkable(t.x, t.y, blocked)) { const f = workerFoot(); b.px = f.x; b.py = f.y; b.home = tileOf(f.x, f.y); }
    }
  }
  /* Lane E6b — roster-change map sweep. The per-agent maps (heat/deskProg/xp/computeOk) and the pairwise social
     cooldown accumulate an entry per agent id that appears; a roster removal (a bay unbound, a summoned worker
     retired) used to leave those entries behind to grow unbounded on a 24/7 station. Called from the one place
     roster membership is reconciled (syncCrewFromPlan), it clears entries for ids no longer present (hero + live
     crew are always kept). NOTE: `seenCount` is deliberately EXCLUDED — it is keyed by prop-id/belt studyKey, not
     agentId (see its set/get sites), so sweeping it here by agent id would wrongly drop prop-familiarity state. */
  function sweepAgentMaps() {
    const live = new Set();
    if (agent && agent.id) live.add(agent.id);
    for (const b of crew) if (b && b.agentId) live.add(b.agentId);
    for (const m of [heatByAgent, deskProg, xpByAgent, computeOkCache]) {
      for (const k of Array.from(m.keys())) if (!live.has(k)) m.delete(k);
    }
    for (const k of Array.from(socialPairCd.keys())) {      // "idA|idB" — drop the pair if EITHER side is gone
      const parts = String(k).split('|');
      if (!live.has(parts[0]) || !live.has(parts[1])) socialPairCd.delete(k);
    }
  }
  // the body that runs a given agentId: the hero, a crew body, or null (caller falls back to the hero)
  function bodyForAgent(aid) {
    if (!aid) return null;
    if (agent && aid === agent.id) return agent;
    return crew.find(b => b.agentId === aid) || null;
  }

  /* ---------- summoned workers (real, independent crew bodies) ----------
     A SUMMONED agent (App.summonAgent) has no routing-plan bay, so it isn't a plan-derived crew body — it's
     an app-level worker that stands at its own spot in the spawn room and visibly WORKS (lit + typing pose)
     while its REAL run is in flight. It reuses the crew render path entirely; the hero is never touched. */
  // a distinct walkable standing spot, fanned out from the spawn-room centre so summoned crew don't stack.
  function workerFoot() {
    const t = spawnTileLocal();
    const ring = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [3, 1], [-3, 1], [1, 3], [-1, -3], [3, -2]];
    const seen = new Set(crew.filter(b => b.summoned).map(b => { const tt = tileOf(b.px, b.py); return tt.x + ',' + tt.y; }));
    // The hero occupies the ring too. Omitting it made the first summoned worker take [0,0]
    // directly underneath the hero; hover/click then resolved the hero first and the specialist
    // was impossible to address on the floor even though its roster/body existed.
    if (agent && !agent.unplaced) { const ht = tileOf(bodyPosX(agent), bodyPosY(agent)); seen.add(ht.x + ',' + ht.y); }
    for (let i = 0; i < ring.length; i++) {
      const tx = t.x + ring[i][0], ty = t.y + ring[i][1];
      if (geo && geo.walkable(tx, ty, blocked) && !seen.has(tx + ',' + ty)) return footOf(tx, ty);
    }
    return footOf(t.x, t.y);
  }
  // give a summoned agent a real floor body (idempotent). Static like crew, but flagged `summoned` so the
  // floor-reset paths (loadStation / syncCrewFromPlan) preserve it, and lit by setActivityFor on a real run.
  function spawnAgent(a) {
    if (!a || !a.id || (agent && a.id === agent.id)) return;
    // already on the floor as a plan-derived bay body (loadStation's rederive runs before this on boot):
    // REHYDRATE its inner life instead of bailing. `summoned` is runtime-only, so across a relaunch a
    // bay-bound roster agent otherwise freezes at its bay foot (stepCrew gates the sentience engine on the
    // flag) and VANISHES outright if its bay is later deleted (syncCrewFromPlan keeps only summoned bodies
    // when a bay disappears) — while the manifest/dossier still list it. The law this restores: a roster
    // agent ALWAYS has a live floor body; its bay decides where it homes, never whether it exists (2026-07-07).
    const ex = crew.find(b => b.agentId === a.id);
    if (ex) {
      ex.summoned = true;
      // loadStation derives bay-bound bodies from the floor plan before App replays the saved roster. The plan
      // knows only the agent id, so that provisional body carries the default skin/id label/synthetic color.
      // Rehydrate the roster-owned display identity here too; returning with only `summoned` restored made every
      // bay-bound agent LOOK reset after relaunch even though its dossier still held the chosen skin.
      if (a.name) ex.name = a.name;
      if (a.color) ex.color = a.color;
      if (a.skin && typeof DATA !== 'undefined' && DATA.SKINS && DATA.SKINS[a.skin]) ex.skin = a.skin;
      return;
    }
    const f = geo ? workerFoot() : { x: 0, y: 0 };                        // pre-geo: parked at origin, re-footed on first syncCrewFromPlan
    const b = makeCrewBody(a.id, a.name || a.id, a.color || crewColor(a.id), f.x, f.y, a.skin);
    b.summoned = true; b.wakeAt = fnow;                                   // a small materialize ripple
    b.idleUntil = fnow + U.irnd(1400, 3200);                              // hold a beat after materializing, then it strolls
    crew.push(b);
    greetNewcomer(b, fnow);                                               // somebody on the floor goes over to say hello
  }
  /* THE WELCOME (2026-08-08, Andrew: "agents should greet one another when a new one is spawned,
     perhaps they will walk up to one another and wave"). A body materializing on the floor is an
     EVENT, so this fires off the event rather than waiting for the ambient social lane — the same
     shape as the Tier C summon-glance, which also fires off an event instead of a dice roll.

     It reuses the D3 huddle wholesale: the greeter walks over, both wave as they settle, they take
     turns in the silent exchange, and they part with a wave. So it costs one function, inherits
     every existing safety property (one encounter station-wide, zone-clamped targets, work seizes
     instantly, the hard timeout), and CANNOT stack — if an encounter is already live, the newcomer
     simply arrives unremarked, which is honest. The station LANE cooldown is deliberately bypassed
     (a welcome is not ambient chatter) but the fired encounter still arms it, so a burst of spawns
     produces ONE welcome, not one per body. */
  function greetNewcomer(newBody, now) {
    if (!newBody || newBody.unplaced || !geo || socialBeat || reduceMotion()) return false;
    // Not during BOOT: replaying a saved roster spawns every body at once, and nobody welcomes a
    // floor that is still materializing. (This deliberately does NOT key on firstWakeDone — that
    // latch only ever fires for a brand-new agent's awakening ceremony, so on every resumed save it
    // stays false forever and would have silently disabled the welcome for good.)
    if (!agent || agent.unplaced || agent.goal === 'firstwake') return false;
    if (!floorLiveAt || (now - floorLiveAt) < 8000) return false;
    const keep = self;
    try {
      let best = null;
      for (const other of allBodies()) {
        if (!other || other === newBody || other.unplaced) continue;
        self = other;                                                     // socialEligible/zoneFor read the CURRENT body
        if (!socialEligible(other, now)) continue;
        if (!bodiesInSight(other, newBody)) continue;                     // greeter must be able to SEE the arrival: this scan is its own (not neighborsOf), and planHuddle's sightline gate would otherwise just fail the plan and produce no welcome at all rather than picking someone who can
        const d = Math.hypot(other.px - newBody.px, other.py - newBody.py);
        if (!best || d < best.d) best = { body: other, d };
      }
      if (!best) return false;
      self = best.body;
      return planHuddle(best.body, newBody, now);                         // walks, waves, exchanges turns, parts
    } finally { self = keep; }                                            // MANDATORY restore (B1) — spawnAgent runs outside the engine loop
  }
  // rename a placed body (hero or crew) so its floor nameplate follows a dossier rename. DISPLAY-ONLY: the
  // agentId that keys crew/anchors/engine-state never changes, so this can't disturb any body's identity.
  function relabel(id, name) {
    const nm = String(name || '').trim();
    if (!id || !nm) return false;
    if (agent && agent.id === id) { agent.name = nm; return true; }
    const b = crew.find(x => x.agentId === id);
    if (b) { b.name = nm; return true; }
    return false;
  }
  // DOSSIER › DELETE AGENT: pull a summoned crew body off the floor for real. Only ever removes a CREW body —
  // the hero (agent) is never a crew entry and can't be reached here (guarded by the caller too). Idempotent:
  // returns true if a body was removed. Any transient locks referencing the body (a chase, a social encounter)
  // self-heal next tick because their partner-broken checks already treat a missing/absent body as torn.
  function despawnAgent(agentId) {
    if (!agentId || (agent && agentId === agent.id)) return false;   // never the hero
    const i = crew.findIndex(b => b.agentId === agentId);
    if (i < 0) return false;
    if (chaseId === agentId) chaseId = null;   // drop any active chase lock addressed to the gone body (sweepChase would clear it next tick anyway)
    crew.splice(i, 1);
    return true;
  }
  // DOSSIER › CHANGE SKIN: repoint a live body's sprite set. Display-only — the agentId, position, engine state
  // and foot-anchor are untouched; only which DATA.SKINS entry drawBody looks up changes, so the LOCKED
  // pixelation + foot-padding rules still apply (we change WHICH skin, not how a skin renders). Works for the
  // hero and for a summoned crew body.
  function setSkin(agentId, skin) {
    const sk = String(skin || '').trim();
    if (!sk || (typeof DATA === 'undefined' || !DATA.SKINS || !DATA.SKINS[sk])) return false;
    const b = bodyForAgent(agentId);
    if (!b) return false;
    b.skin = sk;
    return true;
  }
  // per-agent activity: the HERO routes to setActivity (byte-identical single-agent path); a summoned crew
  // body lights + takes the working pose while its run is live, and extinguishes when it ends.
  function setActivityFor(agentId, kind) {
    const now0 = (typeof performance !== 'undefined') ? performance.now() : fnow;
    if (!agentId || (agent && agentId === agent.id)) {
      setActivity(kind);                                                  // HERO: byte-identical single-agent path (the seize itself is in tick)
      if (kind === 'task' || kind === 'thinking') summonGlance(agent, now0);   // C-Beat1: AFTER the activity flips to task — observers (crew) may glance at the summoned hero (K3 never blocks the seize)
      return;
    }
    const b = crew.find(x => x.agentId === agentId);
    if (!b) return;                                                       // not yet spawned (e.g. summon mid-flight) — nothing to animate
    const working = (kind === 'task' || kind === 'thinking');
    b.working = working; b.sitting = false; b.dir = working ? 'north' : 'south';   // face away = "at work"; stepCrew seats it at its desk if it has one, else it stands here
    if (working) { b.target = null; b.pathPts = null; seizeFromIdle(b); }   // drop any in-flight stroll AND any couch/leisure latch so stepCrew re-paths straight to the chair (J4)
    const now = now0;
    if (working) { b.workUntil = now + 3600000; if (!b.wakeAt || now - b.wakeAt > 1500) b.wakeAt = now; sayAt(b, 'working…'); }
    else { b.workUntil = 0; if (b.say && /working/.test(b.say.text || '')) b.say = { text: '', until: 0 }; }
    if (working) gripeNoCompute(b);      // G0.7: sat down to work in a computeless room — one honest complaint, then silence
    if (working) summonGlance(b, now);   // C-Beat1: AFTER the work-seize (K3 summon-wins) — OTHER idle in-sight bodies 50% glance at the newly-summoned `b`
  }

  // the WATCHABLE HANDOFF: the lead delegated to worker `toId`. 'spawned' lights the worker (chat.js does NOT
  // drive a DELEGATED worker — its run rides the lead's stream) and flies a box from the lead body to it; 'done'
  // dims it. A direct lerp (no belts needed) so the handoff always reads. No-op for the hero / an unknown body.
  function handoff(fromId, toId, phase) {
    const to = bodyForAgent(toId);
    if (!to || to === agent) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    if (phase === 'done') { to.working = false; to.workUntil = 0; to.dir = 'south'; return; }
    to.working = true; to.sitting = false; to.dir = 'north'; to.target = null; to.pathPts = null; seizeFromIdle(to);   // re-path straight to its desk if it has one (stepCrew), else stand; drop any leisure latch (J4)
    to.workUntil = now + 3600000; if (!to.wakeAt || now - to.wakeAt > 1500) to.wakeAt = now;
    sayAt(to, 'on it…');
    gripeNoCompute(to);   // G0.7: a delegated worker in a computeless room complains once too
    const from = bodyForAgent(fromId) || agent;
    if (from && from !== to) handoffBoxes.push({ fromX: from.px, fromY: from.py - 6, toX: to.px, toY: to.py - 6, t0: now, color: to.color || '#5ad0ff' });
    summonGlance(to, now);   // C-Beat1: a delegated worker just started — OTHER idle in-sight bodies 50% glance at it (AFTER its seize, K3)
  }
  // draw the in-flight handoff boxes (world space, over the entities). A small arced lerp that self-expires.
  function drawHandoffBoxes(now) {
    if (!handoffBoxes.length) return;
    const DUR = 720;
    for (let i = handoffBoxes.length - 1; i >= 0; i--) {
      const b = handoffBoxes[i];
      const t = (now - b.t0) / DUR;
      if (t >= 1) { handoffBoxes.splice(i, 1); continue; }
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
      const x = Math.round(b.fromX + (b.toX - b.fromX) * e);
      const y = Math.round(b.fromY + (b.toY - b.fromY) * e - Math.sin(t * Math.PI) * 7);   // a little arc
      ctx.save();
      ctx.globalAlpha = 0.28; ctx.fillStyle = '#000'; ctx.fillRect(x - 2, Math.round(b.toY), 4, 1);   // ground shadow at the destination
      ctx.globalAlpha = 0.92; ctx.fillStyle = b.color; ctx.fillRect(x - 2, y - 2, 4, 4);
      ctx.fillStyle = U.shade(b.color, 0.45); ctx.fillRect(x - 2, y - 2, 4, 1);
      ctx.restore();
    }
  }
  function sayAt(body, text) {
    if (!body) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    body.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
  }
  // G0.7: the one-time "I need a computer here" complaint — spoken the first time a body takes the
  // working pose while its bay room grants no COMPUTE (screens stay dark; the run dies at the gate).
  // The latch resets if the room is later fixed, so a re-broken room earns exactly one fresh gripe.
  function gripeNoCompute(b) {
    if (!b || !b.agentId) return;
    if (computeOkFor(b.agentId)) { b.noComputeGriped = false; return; }
    if (b.noComputeGriped) return;
    b.noComputeGriped = true;
    sayAt(b, U.pick(SELF_NOCOMPUTE));
  }
  // is a BAY prop's bound agent actively working (so the bay lights up)?
  function bayLit(p, now) {
    if (!p.agentId) return false;
    if (agent && p.agentId === agent.id) return !!agent.working;
    const b = crew.find(x => x.agentId === p.agentId);
    return !!(b && b.workUntil > now);
  }
  // a payload box reached an open end: route it to the bound agent's bay (the SAME bay the box rode to, per the
  // plan) and light THAT body. No bay / unrouted -> the hero receives it, exactly as before (never stalls).
  function onWorkitemDeliver(bx) {
    const p = (bx && bx.payload) || {};
    if (p.outbound) {
      lastOutboxFlash = fnow;   // box reached the OUTBOX -> flash the chute
      // GUIDED WORKFLOWS: a line's FIRST real product delivery permanently retires its finish-the-line
      // card. This is THE delivery seam (the crate that actually sank at the chute) — event-driven, and
      // product-only: slag (an unproductive run) finishes nothing. World tiles ride over so Build maps
      // the mouth tile to its line in its own geometry frame.
      if (p.box === 'product' && geo && geo.origin && typeof Build !== 'undefined' && Build.noteLineDelivered) {
        try { Build.noteLineDelivered(bx.x + geo.origin.tx, bx.y + geo.origin.ty); } catch (_) {}
      }
      // slag is NOT a satisfying delivery — skip the relaxed exhale; the post-mortem already fired at run.end
      if (p.box !== 'slag' && agent && !agent.unplaced && activity === 'idle') {   // EXHALE: watch the reply leave, satisfied, then relax (downtime clock resets)
        const ob = geo && geo.props && geo.props.find(q => q.t === 'outbox');
        if (ob) setGlance(dirToward(agent.px, agent.py, (ob.x + 0.5) * T, (ob.y + 0.5) * T), 1100, fnow);
        curiositySay(SELF_DISPATCH, 0.7, fnow); agent.lastTaskAt = fnow;
      }
      return;
    }
    // INBOUND: prefer the agentId the box CARRIES — cron/channel address it explicitly to the run's agent, so the
    // "received" beat lands on exactly the body that runs (server-authoritative; no re-derivation drift). Fall
    // back to the landing tile, then resolveTarget(tag), for an unaddressed box. The work POSE itself is owned by
    // the run-lifecycle binding above, so here we only ring the "received: <instruction>" beat and NEVER cut short
    // an already-working body (an active run's glow must outlast this 4s pulse).
    const landed = (routingPlan && routingPlan.bayTileToAgent) ? routingPlan.bayTileToAgent[bx.x + ',' + bx.y] : null;
    const aid = p.agentId || landed || ((typeof Pipeline !== 'undefined' && routingPlan) ? Pipeline.resolveTarget(routingPlan, { tag: p.tag }) : null);
    const body = bodyForAgent(aid);
    if (body && body !== agent) { sayAt(body, 'received: ' + (p.preview || 'message')); body.wakeAt = fnow; if (!(body.workUntil > fnow + 5000)) body.workUntil = fnow + 4000; }
    else { say('received: ' + (p.preview || 'message')); wakeIn(); }   // the hero (or an unrouted box) — today's behaviour
  }
  /* ---------- the CAM-HUD ACTIVITY TICKER (stage narration) ----------
     A single diegetic security-camera line at the bottom of the .cam-hud overlay that names WHAT the station
     is doing RIGHT NOW, driven purely by real harness events (agent.run.* / agent.tool_call|result /
     provider.fallback). Truthful telemetry law: nothing shows unless the harness actually emitted it.
     Event-driven only — no rAF loop. Rapid bursts coalesce to ~2 updates/sec, always ending on the latest
     event; after IDLE_MS with no events the line fades to a clean frame. Page reload starts empty. */
  let tickerEl = null;              // the <span class="cam-ticker"> in .cam-hud (created lazily, once)
  let tickerReady = false;          // DOM was set up (or setup was attempted + the overlay was missing)
  let tickerPending = null;         // coalescing buffer: the latest {text, cls} not yet painted
  let tickerLastPaint = 0;          // performance.now() of the last DOM write (throttle floor)
  let tickerCoalesceT = 0;          // setTimeout id for the trailing-edge flush
  let tickerFadeT = 0;              // setTimeout id for the idle fade-out
  const TICKER_MIN_MS = 500;        // ≤ ~2 updates/sec
  const TICKER_IDLE_MS = 7000;      // clean frame after 7s of no activity
  // tool-in-flight state for the STRETCH desk glyph: agentId -> { name, callId } while a tool_call is open.
  const glyphByAgent = new Map();

  // codename for an agentId (hero or crew body), else a short id fallback — never throws.
  function tickerName(aid) {
    const b = bodyForAgent(aid);
    if (b && b.name) return String(b.name);
    return aid ? String(aid).slice(0, 8) : 'AGENT';
  }
  // suit colour for an agentId (inline colour is the established exception for suit tint), else null.
  function tickerSuit(aid) {
    const b = bodyForAgent(aid);
    return (b && b.color) ? String(b.color) : null;
  }
  // tool name → terse HUD glyph: mcp__foo__bar → FOO::BAR, web.search → WEB.SEARCH, else UPPERCASED.
  function tickerTool(name) {
    let n = String(name || '').trim();
    if (!n) return 'TOOL';
    const m = /^mcp__(.+?)__(.+)$/.exec(n);
    if (m) n = m[1] + '::' + m[2];
    return n.replace(/[_-]+/g, '.').toUpperCase();
  }
  function tickerClip(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // create the ticker span inside the existing .cam-hud overlay (never touches index.html). Idempotent.
  function setupTicker() {
    if (tickerReady) return;
    tickerReady = true;
    if (typeof document === 'undefined') return;
    const host = document.querySelector('.cam-hud');
    if (!host) return;
    const el = document.createElement('span');
    el.className = 'cam-ticker';
    el.setAttribute('aria-hidden', 'true');   // the SR summary (#stage-summary) is the accessible channel; this is decorative HUD dressing
    host.appendChild(el);
    tickerEl = el;
  }

  // paint one line NOW (bypasses coalescing) — sets HTML (name span may carry a suit tint), tint class, and
  // arms the CRT blip + idle fade. transform/opacity only; instant swap under reduced motion.
  function paintTicker(text, cls, suit) {
    if (!tickerEl) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    tickerLastPaint = now;
    // structure: "<name> ▸ <rest>" — split on the first " ▸ " so only the codename gets the suit tint.
    let html;
    const sep = ' ▸ ';
    const i = text.indexOf(sep);
    const esc = s => U.esc(s == null ? '' : s);   // one complete impl (escapes & < > " ' — quote-safe if this ever moves into an attr)
    if (i > 0) {
      const nm = esc(text.slice(0, i)), rest = esc(text.slice(i + sep.length));
      const style = suit ? ' style="color:' + suit + '"' : '';
      html = '<b class="ct-name"' + style + '>' + nm + '</b><span class="ct-sep"> ▸ </span>' + rest;
    } else {
      html = esc(text);
    }
    tickerEl.innerHTML = html;
    tickerEl.classList.toggle('cam-ticker--bad', cls === 'bad');
    // CRT blip: retrigger the one-step enter transition unless the OS asked for less motion.
    tickerEl.classList.remove('cam-ticker--on', 'cam-ticker--blip');
    if (!reduceMotion()) { void tickerEl.offsetWidth; tickerEl.classList.add('cam-ticker--blip'); }
    tickerEl.classList.add('cam-ticker--on');
    // (re)arm the idle fade — a fresh event resets the 7s clock.
    if (tickerFadeT) clearTimeout(tickerFadeT);
    tickerFadeT = setTimeout(() => { if (tickerEl) tickerEl.classList.remove('cam-ticker--on', 'cam-ticker--blip'); tickerFadeT = 0; }, TICKER_IDLE_MS);
  }

  // public entry: queue a line, coalescing bursts to ≤ ~2/sec and always ending on the latest event.
  function pushTicker(text, cls, suit) {
    if (!text) return;
    setupTicker();
    if (!tickerEl) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const since = now - tickerLastPaint;
    if (since >= TICKER_MIN_MS && !tickerCoalesceT) { paintTicker(text, cls, suit); return; }
    // inside the throttle window: stash as the pending trailing-edge line and (re)arm one flush timer.
    tickerPending = { text, cls, suit };
    if (!tickerCoalesceT) {
      const wait = Math.max(0, TICKER_MIN_MS - since);
      tickerCoalesceT = setTimeout(() => {
        tickerCoalesceT = 0;
        if (tickerPending) { const q = tickerPending; tickerPending = null; paintTicker(q.text, q.cls, q.suit); }
      }, wait);
    }
  }

  // one app-level EventSource: re-emit validated channel/work-item events onto U.bus, and react in-world
  function connectChannelBridge() {
    if (bridged || typeof U === 'undefined' || !U.bus) return;
    bridged = true;
    setupTicker();   // join the .cam-hud overlay (starts empty — no fake backfill)
    // ── CAM-HUD ACTIVITY TICKER: narrate the latest REAL harness event as one diegetic camera line. ──
    U.bus.on('agent.run.start', p => {
      if (!p || !p.agentId) return;
      const trig = String(p.trigger || '').toLowerCase();
      const tag = (trig === 'schedule') ? ' · ROUTINE' : (trig === 'event') ? ' · EVENT' : (trig === 'nightshift') ? ' · NIGHT SHIFT' : '';
      pushTicker(tickerName(p.agentId) + ' ▸ RUN INITIATED' + tag, '', tickerSuit(p.agentId));
    });
    U.bus.on('agent.tool_call', p => {
      if (!p || !p.name) return;
      const arg = tickerClip(p.argsSummary, 48);
      pushTicker(tickerName(p.agentId) + ' ▸ ' + tickerTool(p.name) + (arg ? ' · ' + arg : ''), '', tickerSuit(p.agentId));
    });
    // NO per-tool failure tick (2026-07-31). This used to push a red '✗ <summary>' line for every errored
    // tool call — and since successes tick nothing, failure was the ONLY outcome the HUD ever narrated: a
    // research run probing a few blocked sites read as a station-wide malfunction. A negative tool result
    // is the agent working, and the next agent.tool_call line already shows it moving; the COMMS chips
    // keep the per-call truth one click away. Red on this HUD now means one thing: the run itself died.
    U.bus.on('agent.run.error', p => {
      if (!p) return;
      pushTicker(tickerName(p.agentId) + ' ▸ RUN FAULT · ' + tickerClip(p.message || 'error', 40).toUpperCase(), 'bad', tickerSuit(p.agentId));
    });
    U.bus.on('agent.run.end', p => {
      if (!p) return;
      const turns = (p.turns | 0);
      const usd = +p.usd;
      let line = tickerName(p.agentId) + ' ▸ RUN COMPLETE';
      if (turns > 0) line += ' · ' + turns + ' TURN' + (turns === 1 ? '' : 'S');
      if (isFinite(usd) && usd > 0) line += ' · ' + U.usd(usd);
      // a DONE run that PROVABLY WORKED (tool result / deliverable) is a shipped job: bump the pallet
      // + tell the day's score in the same breath. A clean-but-workless finish is just RUN COMPLETE.
      if (p.reason === 'done' && runWorked(p)) line += ' · ' + bumpShipped() + ' SHIPPED TODAY';
      pushTicker(line, '', tickerSuit(p.agentId));
    });
    // PROVEN-WORK tracker (crate-honesty): what did the CURRENT run actually do? Reset on run.start;
    // successful tool results + deliverables accumulate; run.end consumers read it, then it's dropped.
    U.bus.on('agent.run.start', p => {
      if (!p || !p.agentId) return;
      const k = runKey(p);
      runWork.set(k, { agentId: p.agentId, tools: 0, dels: 0 });
      if (runWork.size > 200) runWork.delete(runWork.keys().next().value);   // bounded (a missed run.end must not leak forever)
      const l = liveRunOrder.get(p.agentId) || [];
      if (l.indexOf(k) < 0) l.push(k);
      liveRunOrder.set(p.agentId, l);
    });
    U.bus.on('agent.tool_result', p => {
      if (!p || p.isError) return;
      const w = runWork.get(runKey(p)) || runWork.get(oldestLiveRun(p.agentId));
      if (w) w.tools++;
    });
    // deliverable carries no runId — credit the agent's OLDEST live run (FIFO, same pairing as dockLineWork)
    U.bus.on('deliverable', p => { const w = runWork.get(oldestLiveRun(p && p.agentId)); if (w) w.dels++; });
    U.bus.on('provider.fallback', p => {
      if (!p || !p.toModel) return;
      const to = String(p.toModel).split('/').pop();
      pushTicker('STATION ▸ REROUTE · ' + tickerClip(to, 32).toUpperCase(), '', null);
    });
    // ── STRETCH: desk work-glyph state — a tool in flight (tool_call → its tool_result) marks the agent;
    //    the render pass (drawWorkGlyphs) draws a tiny tag at that desk. run.end clears any stale mark. ──
    U.bus.on('agent.tool_call', p => { if (p && p.agentId && p.name) glyphByAgent.set(p.agentId, { name: p.name, callId: p.callId || null }); });
    U.bus.on('agent.tool_result', p => {
      if (!p || !p.agentId) return;
      const g = glyphByAgent.get(p.agentId);
      if (g && (!p.callId || !g.callId || g.callId === p.callId)) glyphByAgent.delete(p.agentId);
    });
    U.bus.on('agent.run.end', p => { if (p && p.agentId) glyphByAgent.delete(p.agentId); });
    U.bus.on('workitem.placed', p => intakeMessage(p));
    // (workitem.delivered no longer spawns a crate — the run.end 'done' handler below is the single
    //  crate source, so channel replies can't double-crate. delivered still feeds the floor stats fold.)
    U.bus.on('workitem.superseded', p => { if (p && p.workitemId && convey) convey.dropWorkitem(p.workitemId); });
    // queue.status drives BOTH the numeric backpressure gauge (chanQueues) and the FloorStats backlog fold.
    U.bus.on('queue.status', p => { if (p && p.queueId != null) chanQueues.set(p.queueId, Math.max(0, p.depth | 0)); if (floor) floor.onEvent('queue.status', p); });
    // THE FLOOR ECONOMY — fold the harness's real cost/outcome events into FloorStats (the floating
    // canvas readout was removed 2026-07-09; the fold stays for panel/widget consumers). harness.js
    // re-emits every sidecar event onto U.bus, and routed/crew runs arrive the same way over the SSE
    // bridge, so these tally the WHOLE station's spend->yield, not just the hero.
    if (!floor && typeof FloorStats !== 'undefined') floor = FloorStats.create();
    if (!slaglog && typeof SlagLog !== 'undefined') slaglog = SlagLog.create();
    U.bus.on('agent.cost', p => {
      if (floor) floor.onEvent('agent.cost', p, Date.now());
      // crate-mass fold: sum this run's RECONCILED spend (agent.cost is reconciled by contract) so the
      // product crate that ships at run.end can weigh what the run really cost. Bounded map.
      if (p && p.runId && typeof p.usd === 'number' && isFinite(p.usd) && p.usd > 0) {
        runUsdRecon.set(p.runId, (runUsdRecon.get(p.runId) || 0) + p.usd);
        if (runUsdRecon.size > 400) runUsdRecon.delete(runUsdRecon.keys().next().value);
      }
      // remember the most recent RECONCILED cache ratio — the smelter temperature a slag diagnosis reads
      if (p && (p.tokensIn | 0) > 0) lastCacheFrac = Math.max(0, Math.min(1, (p.cachedTokens || 0) / p.tokensIn));
      // E2 + Stage 2: a cost event reinforces the run TTL. A DELEGATED worker's stream is lifecycle+cost
      // ONLY (orchestration forwards no token/tool events), so without this the worker's sprite decayed to
      // idle at RUN_TTL while its run was still genuinely working (2026-07-07 escape: "the researcher just
      // stopped"). Cost fires every completed worker turn — the honest per-turn heartbeat we do have.
      if (p && p.agentId && runStartByAgent.has(p.agentId)) stampRun(p.agentId, p.runId);
    });
    // H3.1: a mid-run model/credential FAILOVER was invisible (provider.fallback had no consumer). Fold it into
    // the floor stats AND surface a LOGBOOK line so the operator sees the harness rerouting around a bad provider.
    U.bus.on('provider.fallback', p => {
      if (floor) floor.onEvent('provider.fallback', p, Date.now());
      if (p && typeof StationUI !== 'undefined' && StationUI.notify) {
        const how = p.rotate ? 'rotated credential' : 'switched model';
        StationUI.notify('⤳ failover (' + (p.reason || 'error') + ') · ' + how + ': ' + (p.fromModel || '?') + ' → ' + (p.toModel || '?'), 'warn');
      }
    });
    // THROUGHPUT + DWELL: pair each work-item's placement with its delivery (a reliable Date.now() clock,
    // since the box's belt-ride spans real wall-clock seconds) to fold items/min + time-on-line.
    U.bus.on('workitem.placed', p => { if (floor) floor.onEvent('workitem.placed', p, Date.now()); });
    U.bus.on('workitem.delivered', p => { if (floor) floor.onEvent('workitem.delivered', p, Date.now()); });
    U.bus.on('agent.run.end', p => {
      if (floor) floor.onEvent('agent.run.end', p, Date.now());
      const r = p && p.reason;
      // A clean finish that PROVABLY WORKED ships: one product crate leaves the producing agent's bay
      // and rides to the OUTBOX. A done-but-workless run ("I couldn't do that") ships NOTHING.
      if (r === 'done' && runWorked(p)) shipProductCrate(p);
      if (p) {                                          // the run is over — drop ITS tally (and only its), either way
        const k = runKey(p);
        runWork.delete(k);
        const l = p.agentId && liveRunOrder.get(p.agentId);
        if (l) { const i = l.indexOf(k); if (i >= 0) l.splice(i, 1); if (!l.length) liveRunOrder.delete(p.agentId); }
      }
      if (p && p.runId) runUsdRecon.delete(p.runId);   // the ship decision above has read it — drop the cost fold
      if (r !== 'max_iters' && r !== 'budget' && r !== 'error' && r !== 'refusal') return;
      // UNPRODUCTIVE RUN: pulse the SLAG cell, then turn the failed outcome into a lesson — a real post-mortem in the
      // notifications panel + a red-hot slag crate that rides off the line (if a desk belt exists). The
      // lesson lands regardless of belts; the belt only shows it.
      lastSlagAt = performance.now();
      if (!slaglog) return;
      const diag = slaglog.record(r, { cacheFrac: lastCacheFrac, turns: p && p.turns, usd: p && p.usd });
      // an 'error' run has ALREADY announced itself (⚠ error row, its own toast, the RUN FAULT tick,
      // the desk strobe) — a simultaneous SLAG toast made ONE failure read as two (2026-07-31). The
      // post-mortem record + slag crate below still happen for every dead reason; only the duplicate
      // toast is skipped. Budget/step-limit/refusal deaths keep it: nothing else announces those.
      if (typeof StationUI !== 'undefined' && StationUI.notify && r !== 'error') {
        const clean = s => String(s || '').replace(/\bspend\b/ig, 'run resources').replace(/\bdollars?\b/ig, 'limits');
        StationUI.notify('⚠ SLAG (a run died with nothing to show) · ' + clean(SlagLog.line(diag)), 'warn');
      }
      enqueueSlag(diag, p && p.agentId);
    });
    // Stage 2: WATCH the lead delegate. A team.dispatch tool call opens a delegation window (until its tool_result);
    // any WORKER run that starts inside it flies a box lead→worker + lights the worker. Contract-free — rides the
    // existing agent.tool_call / agent.run.* events (the delegated child's lifecycle is forwarded onto the lead's stream).
    U.bus.on('agent.tool_call', p => { if (p && /^team[._]dispatch$/.test(p.name || '')) { delegateLead = p.agentId; delegateCall = p.callId; } });
    U.bus.on('agent.tool_result', p => { if (p && p.callId && p.callId === delegateCall) { delegateLead = null; delegateCall = null; } });
    // OVERLAP REFCOUNT: register every live run by runId (any trigger) BEFORE the extinguish consumers below —
    // only the LAST live run's end may darken an agent's pose/screens (see noteRunStart/noteRunEnd).
    U.bus.on('agent.run.start', p => { if (p && p.agentId) noteRunStart(p.agentId, p.runId); });
    U.bus.on('agent.run.start', p => { if (p && delegateLead) { const b = bodyForAgent(p.agentId); if (b && b !== agent) handoff(delegateLead, p.agentId, 'spawned'); } });
    U.bus.on('agent.run.end', p => { if (p) { const b = bodyForAgent(p.agentId); if (b && b !== agent && !noteRunEnd(p.agentId, p.runId)) handoff(null, p.agentId, 'done'); } });
    // AUTONOMOUS WORK (cron / channel / night shift): a server-initiated run has no in-app chat driving its body,
    // so bind its run lifecycle to the work pose HERE — the agent goes to its workstation and works for the run's
    // REAL duration, then stands when it ends. This is what makes an unattended run VISIBLE: the conveyor box rides
    // in (kind 'cron'/'telegram') AND the agent actually runs to its PC and types until done. Interactive chat
    // (trigger 'directive') drives its own body via chat.js and is excluded; a delegated worker (also 'directive')
    // is handled by the handoff bindings above — so this never double-drives a body. Any OTHER trigger is by
    // construction server-initiated (schedule/event/nightshift today) and takes the pose — the old
    // schedule|event whitelist silently dropped trigger 'nightshift', so a self-initiated task ran while the
    // body wandered idle (2026-07-18: the app asserting idle over a provably live run).
    U.bus.on('agent.run.start', p => { if (p && p.agentId && p.trigger && p.trigger !== 'directive') { serverLit.add(p.agentId); if (agent && p.agentId === agent.id) agent.taskViaConveyor = true; setActivityFor(p.agentId, 'task'); } });
    U.bus.on('agent.run.end', p => { if (p && p.agentId && !noteRunEnd(p.agentId, p.runId) && serverLit.has(p.agentId)) { serverLit.delete(p.agentId); setActivityFor(p.agentId, 'idle'); } });
    // M-mem.4 → notification diet (2026-08-18): auto-compaction no longer toasts — it is loop plumbing,
    // not news. The bottom-bar CTX gauge still flashes its mint "compacted" echo (StationUI listens to
    // agent.compact directly), which is the honest, glanceable trace of the same event.
    // ── consume-side telemetry that was already validated + SSE-broadcast but had NO frontend listener
    //    (the wiring-honesty pass: render the events already on the bus so the floor reflects real activity). ──
    const hudNote = (txt, cls, opts, category) => { try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(txt, cls || '', category, opts); } catch (_) {} };
    // Notification diet (2026-08-18): cron.fire no longer toasts — "fired" then "completed" seconds later
    // read as two events for one routine, and the conveyor box + work pose already make the fire visible.
    // cron.result outcomes (cron-driver.js finishFire): 'failed' warns (always — a failure needs eyes);
    // 'ok' celebrates under the muteable 'cronDigest' category (P1-8); 'silent' stays silent BY DESIGN —
    // it means a clean run whose reply was exactly the [SILENT] marker (the routine chose to report nothing).
    U.bus.on('cron.result', p => {
      if (!p) return;
      if (p.outcome === 'failed') hudNote('✕ routine failed' + (p.reason ? ' — ' + p.reason : ''), 'warn');
      else if (p.outcome === 'ok') hudNote('◷ routine completed', 'good', undefined, 'cronDigest');
    });
    // REWIND: the rare, important "we rolled the workspace back" beat. checkpoint.created is frequent + quiet
    // (the workbench already pulses on shell), so only the restore is toasted.
    U.bus.on('checkpoint.restored', () => hudNote('↶ rewound to an earlier restore point', 'warn'));
    // G0.6 CHANNEL ARRIVAL MADE VISIBLE: a real Telegram/Discord message just reached the station
    // (hub.js emits { channel, chatId, agentId, kind } on every admitted inbound) — the receiving
    // agent's DISH fires (the web/comms on-ramp lighting up). The riding crate + queue gauge still
    // come from workitem.*/queue.status.
    U.bus.on('channel.inbound', p => {
      const dish = capPropFor('dish', p && p.agentId);
      if (dish && PropSprites.pulseProp) PropSprites.pulseProp(dish.id, 'dish');
      // NO hudNote (notification diet, 2026-08-18): on a connected channel EVERY message toasted — the dish
      // pulse + chime + the COMMS transcript already show traffic; a per-message bell entry is pure clutter.
    });
    // G0.6 CHANNEL REPLY MADE VISIBLE: the outbound side of the same on-ramp. hub.js emits channel.delivery
    // { channel, chatId, runId, ok, chunks, reason, agentId? } on every reply-send. Mirror the inbound copy
    // (pulse the DISH), only on a genuine successful send — a failed delivery isn't a reply out.
    U.bus.on('channel.delivery', p => {
      if (!p || !p.ok) return;   // honesty: only confirm a reply that actually left
      // agentId (additive 2026-07-06) names WHICH agent replied. On a multi-agent floor, pulse ONLY that agent's
      // dish: its own dish, else a dish in its room. If the acting agent has NO dish in its room, pulse NOTHING —
      // it is a lie to strobe an unrelated agent's dish (do NOT fall back to any/cands[0]). Legacy sends with no
      // agentId keep the old any-dish behavior so a single-agent station still lights.
      let dish;
      if (p.agentId) {
        dish = (geo && geo.props) ? geo.props.filter(pr => (station && station.capForProp && station.capForProp(pr.t) === 'dish') || pr.t === 'dish')
          .find(pr => pr.agentId === p.agentId) : null;
        if (!dish) {
          const room = actingRoomId(p.agentId);
          if (room && geo && geo.props) dish = geo.props.filter(pr => (station && station.capForProp && station.capForProp(pr.t) === 'dish') || pr.t === 'dish')
            .find(pr => roomOfLocalTile(pr.x, pr.y) === room);
        }
        if (!dish) return;   // acting agent has no dish in reach -> no pulse (truthful telemetry, no wrong-dish strobe)
      } else {
        dish = capPropFor('dish', null);   // legacy/command send (no attribution): any dish, single-agent floor
      }
      if (dish && PropSprites.pulseProp) PropSprites.pulseProp(dish.id, 'dish');
      // NO hudNote (notification diet): same law as channel.inbound — the dish pulse IS the confirmation.
    });
    // EL-11 #11 CHANNEL TROUBLE MADE VISIBLE: transport health (channel.connect) used to be seen ONLY inside the open
    // CHANNELS panel. A drop/fatal-token that happens while you're anywhere else in the station now surfaces a single
    // honest HUD line naming the channel + state — so a silently-dead channel can't swallow your messages unnoticed.
    // Enum is FROZEN to ['up','down','error'] (shared/events.js). Recovery replaces the active outage card under
    // one stable toast key, so the HUD never keeps asserting DOWN after the self-healing poller has proven UP.
    const unhealthyChannels = new Set();
    U.bus.on('channel.connect', p => {
      if (!p || !p.channel) return;
      const state = String(p.state || '').toLowerCase();
      // 'telegram:<botId>' (an agent-bound bot instance) reads as 'TELEGRAM BOT' — platform truth without leaking ids.
      const raw = String(p.channel);
      const name = raw.indexOf(':') >= 0 ? (raw.split(':')[0].toUpperCase() + ' BOT') : raw.toUpperCase();
      const toastKey = 'channel-connect:' + raw;
      if (state === 'up') {
        if (!unhealthyChannels.delete(raw)) return;   // initial/steady health stays quiet
        hudNote('✓ ' + name + ' reconnected', 'good', { key: toastKey });
        return;
      }
      if (state !== 'down' && state !== 'error') return;
      unhealthyChannels.add(raw);
      const why = p.detail ? ' — ' + String(p.detail) : '';
      hudNote((state === 'error' ? '⚠ ' + name + ' connection needs attention' : '⚠ ' + name + ' connection down') + why, 'bad', { key: toastKey });
    });
    // G0.5 BUDGET MADE VISIBLE: budget.threshold was alarm-audio only. The payload is the frozen
    // { scope: run|day|global, usd, cap } triple (sidecar/budget.js, one emit per scope+band crossing
    // per run) — the band isn't carried, so derive it from the numbers: at/over cap = stopped.
    U.bus.on('budget.threshold', p => {
      if (!p || !isFinite(+p.usd) || !isFinite(+p.cap) || +p.cap <= 0) return;
      const usd = +p.usd, cap = +p.cap;
      const scopeWord = p.scope === 'run' ? 'this run' : (p.scope === 'day' ? 'today' : 'the global pool');
      const money = v => U.usd(v);
      if (usd >= cap) hudNote('⛔ budget cap hit for ' + scopeWord + ' — ' + money(usd) + ' of ' + money(cap), 'warn');
      else hudNote('⚠ budget warning for ' + scopeWord + ' — ' + money(usd) + ' of ' + money(cap) + ' (' + Math.round(usd / cap * 100) + '%)', 'warn');
    });
    // LOW CREDITS MADE VISIBLE (2026-07-25): the balance the user BOUGHT is running out. Distinct from
    // budget.threshold above — that is spend against a cap they set; this is money running down. Fired once
    // per crossing by credits.js, so this can be a plain note without any de-dup of its own.
    // Says the real number and what happens next; never a percentage bar (a balance has no denominator).
    U.bus.on('credits.low', p => {
      if (!p || !isFinite(+p.balanceUsd)) return;
      const bal = U.usd(+p.balanceUsd);
      if (p.exhausted) hudNote('⛔ out of credits — ' + bal + ' left; managed runs will refuse until you add more', 'warn');
      else hudNote('⚠ credits running low — ' + bal + ' left, under the ' + U.usd(+p.thresholdUsd) + ' a run can reserve', 'warn');
    });
    // G0.4 CAPDENIED MADE VISIBLE: the run genuinely STOPPED at the capability gate (loop.js emits this
    // before ending the run) — flash the acting agent's desk red + say it plainly. Today this was
    // audio-only; the fix-it quest generator built on it is G1b's, not ours.
    U.bus.on('capdenied', p => {
      flashDesk(p && p.agentId, '#ff4a3d');
      const need = (p && p.need) || 'capability';
      hudNote('⛔ run blocked — ' + (need === 'compute' ? 'no computer in its room' : ('missing ' + need)), 'warn');
    });
    // G0.8 RUN-ERROR DISTRESS: the run died mid-flight (model call / dispatcher / loop guard). The chat
    // panel already prints the message; now the FLOOR reacts too — the red desk strobe + one short flat
    // line (eerie, never chatty; never stomps a live bubble). The stand-up itself rides the
    // agent.run.end (reason 'error') that loop.js guarantees after every run.error — consumed by the
    // serverLit / handoff run.end bindings above, so no body is ever left typing at a dead run.
    const ERROR_LINE = ['it broke', 'lost the thread', 'error state', 'something failed', '...no.'];
    U.bus.on('agent.run.error', p => {
      flashDesk(p && p.agentId, '#ff4a3d');
      const b = bodyForAgent(p && p.agentId);
      if (b && !(b.say && b.say.text && b.say.until > performance.now())) sayAt(b, U.pick(ERROR_LINE));
    });
    // MEMORY: a recall fence was injected into this run's prompt — surface the count so recall feels ALIVE, not silent.
    U.bus.on('memory.recall', p => { const c = p && (p.count | 0); if (c > 0) hudNote('◈ recalled ' + c + ' memor' + (c === 1 ? 'y' : 'ies'), 'good'); });
    // MEMORY WRITE: a durable memory was just committed (notebook tool or a Keep/Edit turn-in). Light the acting
    // agent's NOTEBOOK — the prop that grants the memory rung, same room-lookup the tool-family pulses use — and
    // say it plainly. { agentId, runId, id, kind, scope } (shared/events.js) — guard the agentId like neighbours.
    U.bus.on('memory.write', p => {
      const nb = capPropFor('notebook', p && p.agentId);
      if (nb && PropSprites.pulseProp) PropSprites.pulseProp(nb.id, 'notebook');
      hudNote('✎ memory saved', 'good');
    });
    // MEMORY FORGET: a memory was dropped (user discard / decay). A quiet HUD line, no pulse — nothing lit up.
    U.bus.on('memory.forget', () => hudNote('✕ memory forgotten', 'warn'));
    // G4 feature 1 — APPROVAL WALK-AND-WAIT. The run PAUSED on the sidecar awaiting a human yes/no (permission.prompt,
    // {promptId, agentId}). For the HERO, walk the body off its desk to the wait anchor and hold the waiting pose;
    // permission.response ({promptId, decision}) resumes (approve) or ends (deny) the run server-side, so we clear
    // the await and let the ongoing/finished run drive the body back to work or idle. (A DELEGATED worker's block
    // rides the lead's stream — hero-scoped here; crew await is future work.)
    U.bus.on('permission.prompt', p => { if (p && (!p.agentId || (agent && p.agentId === agent.id))) enterAwait({ promptId: p.promptId || '', agentId: p.agentId || (agent && agent.id) }); });
    U.bus.on('permission.response', p => { if (p && awaitPrompt && (!p.promptId || p.promptId === awaitPrompt.promptId)) clearAwait(); });
    // CONNECTOR PORTALS — make the external on-ramp LIVE: poll each configured server's state so a placed
    // portal glows green/amber/red, and pulse it when ITS tools fire (an mcp__<connectorId>__* tool call).
    const connIds = [];
    function pollConnectors() {
      if (typeof fetch === 'undefined' || typeof PropSprites === 'undefined') return;
      fetch(apiUrl('/api/connectors')).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => {
        const list = (j && j.connectors) || []; connIds.length = 0;
        for (const c of list) {
          connIds.push(c.id);
          PropSprites.setConnectorState(c.id, c.state === 'up' ? 'connected' : (c.state === 'error' ? 'error' : 'offline'), c.toolCount);
        }
        // T3: a SUCCESSFUL poll is authoritative — drop any tracked portal absent from it so a removed/unbound
        // connector stops glowing green (a FAILED poll stays in .catch below and keeps the last-known state).
        if (PropSprites.reconcileConnectors) PropSprites.reconcileConnectors(connIds);
      }).catch(() => {});   // E4/E6f: on failure keep the last-known portal states — never blank them from an error body
    }
    connPollFn = pollConnectors; pollConnectors(); connPollTimer = setInterval(pollConnectors, 5000);
    // JUKEBOX dead-vs-live: poll Spotify's OAuth connected state so a placed jukebox reads DEAD (unplugged)
    // until the user connects Spotify in TOOLSETS, then comes alive. Same keep-last-known-on-failure contract.
    function pollSpotify() {
      if (typeof fetch === 'undefined' || typeof PropSprites === 'undefined' || !PropSprites.setSpotifyConnected) return;
      fetch(apiUrl('/api/spotify/status')).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(j => PropSprites.setSpotifyConnected(!!(j && j.connected)))
        .catch(() => {});   // keep last-known on a failed poll (mirrors the connector contract)
    }
    spotifyPollFn = pollSpotify; pollSpotify(); spotifyPollTimer = setInterval(pollSpotify, 5000);
    // TRUTH (audit T1 finding 5): the per-prop capability SURGE must reflect the tool's REAL OUTCOME, not the
    // mere attempt. agent.tool_call fires BEFORE the capability/consent gate (loop.js), so a denied or errored
    // call emits a tool_call identically to a success — pulsing the granting prop green on tool_call was a lie.
    // We now DEFER the surge to agent.tool_result: success → the green capability surge; error → a distinct RED
    // failure cue (the workbench verify-red model). agent.tool_result carries no `name`, so we correlate it back
    // to the call via callId (surgeCall). Heat/run-TTL still stoke on tool_call — a call WAS made + tokens flowed,
    // which is real activity regardless of the gate's verdict; only the object=capability SURGE waits for truth.
    const surgeCall = new Map();   // callId -> { cap, agentId } captured at tool_call, consumed at tool_result
    U.bus.on('agent.tool_call', p => {            // chat.js re-emits the hero's tool calls here; routed agents arrive via SSE
      const n = p && p.name;
      if (!n) return;
      heatBump(p.agentId, 0.35);                  // G0.3: any real tool fire is activity — stoke the desk heat
      stampRun(p.agentId, p.runId);               // E2: a tool fire reinforces the run TTL (its own run's clock too)
      if (typeof PropSprites === 'undefined') return;   // E6e: prop layer not loaded — heat still stoked, no throw
      if (n.indexOf('mcp__') === 0) {             // connector portals: pulse the BOUND portal (fires a packet on call — its LIVE/error glow is polled separately)
        if (!PropSprites.pulseConnector) return;
        for (const cid of connIds) if (n.indexOf('mcp__' + cid + '__') === 0) { PropSprites.pulseConnector(cid); break; }
        return;
      }
      // map the firing tool to the capability prop that GRANTS it (toolprops.js: fs.*→cabinet · web/browser→dish ·
      // notebook/skill/recall/todo→notebook · image_*→studio · spotify_*→jukebox). shell/verify keep their dedicated
      // workbench events below — the mapper returns null for them, so nothing ever double-fires. STASH it for the
      // result to resolve the surge; the callId join keeps a denied call from ever lighting the prop green.
      const cap = (typeof ToolProps !== 'undefined') ? ToolProps.toolPropType(n) : null;
      if (cap && p.callId) surgeCall.set(p.callId, { cap: cap, agentId: p.agentId });
    });
    U.bus.on('agent.tool_result', p => {
      if (!p || typeof PropSprites === 'undefined' || !PropSprites.pulseProp) return;
      const rec = p.callId ? surgeCall.get(p.callId) : null;
      if (!rec) return;                           // not a capability-prop tool (or no callId join) — nothing to surge
      surgeCall.delete(p.callId);
      const tgt = capPropFor(rec.cap, rec.agentId);   // the granting prop in the ACTING agent's OWN room (or none)
      if (tgt) PropSprites.pulseProp(tgt.id, rec.cap, !p.isError);   // green on success, RED on error/denied
    });
    // bound the correlation map: a run ending drops any of its still-open calls so a lost tool_result never leaks.
    U.bus.on('agent.run.end', () => { if (surgeCall.size > 64) surgeCall.clear(); });
    // workbench pulse: a shell command running glows the bench green; a verify result glows green/red by outcome.
    // ROOM-SCOPED: resolve the ACTING agent's OWN workbench (both events carry agentId) so only that bench glows —
    // not every placed bench on the floor. A roomless fallback (no resolvable target) uses the global pulse.
    const pulseWb = (agentId, ok) => {
      if (typeof PropSprites === 'undefined' || !PropSprites.pulseWorkbench) return;
      const tgt = capPropFor('workbench', agentId);
      if (tgt) PropSprites.pulseWorkbench(ok, tgt.id);
      else PropSprites.pulseWorkbench(ok);   // roomless single-bench floor — global fallback
    };
    U.bus.on('shell.exec', p => pulseWb(p && p.agentId, true));
    U.bus.on('verify.result', p => pulseWb(p && p.agentId, !!(p && p.passed)));
    // G0.3 TOKEN HEAT: every streamed token stokes the acting agent's desk heat —
    // the working screens burn by REAL token flow, never a faked flicker.
    U.bus.on('agent.token', p => { heatBump(p && p.agentId, 0.06); stampRun(p && p.agentId, p && p.runId); });   // E2: a token reinforces the run TTL (its own run's clock too)
    // G0.2 RUN CLOCK: elapsed-time bookkeeping keyed to the REAL run lifecycle (a run.error is always
    // followed by run.end reason 'error', so end is the one cleanup point). Internal reason-only runs
    // never reach U.bus (harness.js suppresses their start/end), so no clock ever shows for self-talk.
    U.bus.on('agent.run.start', p => { if (p && p.agentId) { if (!runStartByAgent.has(p.agentId)) runStartByAgent.set(p.agentId, performance.now()); stampRun(p.agentId); } });   // an overlapping start keeps the EARLIEST clock (the agent has been running since then)
    U.bus.on('agent.run.end', p => { if (p && p.agentId && !noteRunEnd(p.agentId, p.runId)) { runStartByAgent.delete(p.agentId); runLastSeenByAgent.delete(p.agentId); } });
    // G0.2 SIM-TASK PROGRESS: store a desk fraction ONLY when a producer publishes a real prog/dur pair
    // on the 'task' event (subagent status events carry none and store none). Terminal states clear it.
    U.bus.on('task', t => {
      if (!t || !t.agentId) return;
      if (t.status && t.status !== 'active' && t.status !== 'running' && t.status !== 'queued') { deskProg.delete(t.agentId); return; }
      const prog = +t.prog, dur = +t.dur;
      if (isFinite(prog) && isFinite(dur) && dur > 0) deskProg.set(t.agentId, Math.max(0, Math.min(1, prog / dur)));
    });
    if (typeof EventSource === 'undefined') return;
    let backoff = 1000;
    let retryTimer = null;
    const open = () => {
      if (bridgePaused) return;   // disconnected to the title screen — do not (re)open
      /* ONE STREAM, ALWAYS. onerror nulls chanES and arms a retry timer, and resumeBridge re-opens on
         !chanES — so a re-entry INSIDE the backoff window (DATA › IMPORT → reentry → enterGame →
         resumeBridge) created stream #1 and the pending timer then overwrote chanES with #2. #1 was never
         closed, and its onmessage closure (`U.bus.emit(m.name, m.payload)`) references no state that could
         stop it, so every server event was re-emitted onto the bus forever: two crates per inbound message,
         doubled HUD notes, desk heat firing twice. Each further re-entry added another. Cancelling the
         pending retry here is the other half — without it the timer still fires and replaces a healthy
         stream (the orphan's own onerror closes the module-level chanES, not itself). */
      if (retryTimer) { try { clearTimeout(retryTimer); } catch (_) {} retryTimer = null; }
      if (chanES) return;
      try {
        // EventSource can't send the custom auth header, so pass the per-launch token as ?token=… and
        // prefix the sidecar base in the desktop build (where the page origin isn't the loopback http origin).
        const _tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? encodeURIComponent(String(window.__STARNET_API_TOKEN__)) : '';
        chanES = new EventSource(apiUrl('/api/channels/events') + (_tok ? ('?token=' + _tok) : ''));
      } catch (_) { return; }
      chanES.onopen = () => { backoff = 1000; lastSseEventAt = (typeof performance !== 'undefined') ? performance.now() : fnow; fetchSnapshot(); };
      chanES.onmessage = ev => { lastSseEventAt = (typeof performance !== 'undefined') ? performance.now() : fnow; try { const m = JSON.parse(ev.data); if (m && m.name) U.bus.emit(m.name, m.payload); } catch (_) {} };
      chanES.onerror = () => { try { chanES.close(); } catch (_) {} chanES = null; if (bridgePaused) return; if (retryTimer) { try { clearTimeout(retryTimer); } catch (_) {} } retryTimer = setTimeout(() => { retryTimer = null; open(); }, backoff); backoff = Math.min(15000, backoff * 2); };
    };
    connOpenFn = open;
    open();
    // E2+ (2026-07-16): the snapshot reconcile used to fire ONLY on SSE (re)open, so a lost run.end inside a
    // HEALTHY link waited out the full 5m TTL before the floor/panel stopped asserting WORKING. Poll the same
    // authoritative snapshot on a slow cadence: truth converges within ~30s in BOTH directions (a dead run is
    // cleared; a genuinely live one is re-stamped, which also keeps the per-run TTL from biting a long quiet
    // run, e.g. one paused on a consent prompt). Paused bridge = deliberate silence — no polling.
    setInterval(() => { if (!bridgePaused) fetchSnapshot(); }, 30000);
  }
  /* E2: fetch the authoritative live-state snapshot on every SSE (re)open and reconcile the paired-state maps.
     404/failure-tolerant: the endpoint is owned by the lifecycle lane and may not exist here — any non-OK/throw
     just falls through to the TTL net. Uses apiUrl() (desktop-origin safe) + the harness fetch monkey-patch adds
     the auth header for /api/ URLs, matching every other frontend fetch. */
  function fetchSnapshot() {
    if (typeof fetch === 'undefined') return;
    try {
      fetch(apiUrl('/api/state/snapshot'), { cache: 'no-store' })
        .then(r => { if (!r.ok) return null; return r.json(); })
        .then(snap => { if (snap) { try { reconcileFromSnapshot(snap); } catch (_) {} } })
        .catch(() => {});   // endpoint absent / offline: TTL net covers it
    } catch (_) {}
  }
  // the live backlog total — FloorStats owns it (tested), with the chanQueues sum as a fallback if
  // FloorStats isn't loaded. Both the numeric gauge and the physical jam read this one source.
  function queueDepthNow() {
    if (floor) return floor.snapshot().queueDepth | 0;
    let d = 0; for (const v of chanQueues.values()) d += v; return d;
  }
  // (the bottom-right screen-space "INBOX n" queue-depth gauge was REMOVED 2026-07-12 — the CRT
  //  barrel warp skewed it into a "glitched panel" floating in the void at the canvas corner. The
  //  backlog stays visible through the physical crate jam at the INTAKE (drawQueueJam), which
  //  reads the same queueDepthNow() truth.)

  /* LINK DOWN marker (E1) — the honest "the live station telemetry has gone dark" chrome tag. Screen-space,
     top-center in the canvas chrome (never over a desk), VT323 + red phosphor bloom + a slow breathing blink so
     it reads as a live fault, not a frozen label. A glance, never a window (hover law). Only drawn while the SSE
     bridge is genuinely down (linkStaleDim) — clears itself the frame the link recovers. */
  const LINK_FONT = "13px 'VT323','Courier New',monospace";
  function drawLinkDown(now) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const W = cv.width / dpr;
    const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now / 300));   // slow breathing so it never looks stuck
    const label = '⚠ LINK DOWN';
    ctx.save();
    ctx.font = LINK_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width, cx = Math.round(W / 2), y = 6, padX = 6, padY = 3;
    ctx.fillStyle = 'rgba(20,6,4,0.82)'; ctx.fillRect(cx - tw / 2 - padX, y - padY, tw + padX * 2, 18);
    ctx.strokeStyle = 'rgba(255,80,60,0.55)'; ctx.lineWidth = 1;
    ctx.strokeRect(cx - tw / 2 - padX + 0.5, y - padY + 0.5, tw + padX * 2 - 1, 17);
    ctx.shadowColor = 'rgba(255,80,60,0.9)'; ctx.shadowBlur = 6 * dpr;
    ctx.globalAlpha = pulse; ctx.fillStyle = '#ff6a4c';
    ctx.fillText(label, cx, y);
    ctx.restore();
  }

  /* THE JAM — the live backlog made PHYSICAL: park N amber "waiting" crates climbing off the INTAKE so
     the jam's LENGTH is the real queue depth (straight from queue.status). World-space, lit with the floor
     like the riding crates. Honest: it shows the backend's pending-work count, never a guessed frontend hold. */
  function drawQueueJam(now) {
    const depth = queueDepthNow();
    if (depth <= 0 || !geo || !geo.props) return;
    const intake = geo.props.find(p => p.t === 'intake');
    if (!intake) return;
    // MAXVIS 3 (was 6): a deep backlog made a six-crate tower that dominated the room —
    // the pile stays a short glanceable jam and the '+N' counter carries the real depth.
    const MAXVIS = 3, shown = Math.min(depth, MAXVIS);
    const cx = (intake.x + (intake.w || 1) / 2) * T;       // centered on the intake footprint
    const top = intake.y * T - 3;                          // crates climb upward off the intake's top edge
    ctx.save();
    if (linkStaleDim) ctx.globalAlpha = 0.3;   // E1: link down → this jam length is last-known, not live; dim it
    for (let i = 0; i < shown; i++) drawWaitCrate(cx, top - i * 6 + Math.sin(now / 360 + i * 0.7) * 0.6);   // gentle idle bob
    if (depth > MAXVIS) {
      ctx.fillStyle = '#e8c860'; ctx.font = "7px 'VT323','Courier New',monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('+' + (depth - MAXVIS), cx, top - shown * 6 - 3);
    }
    ctx.restore();
  }
  // one parked amber crate (waiting ore) — matches the riding-box silhouette/palette
  function drawWaitCrate(cx, cy) {
    const x = Math.round(cx - 4), y = Math.round(cy - 4);
    ctx.fillStyle = '#161210'; ctx.fillRect(x - 1, y - 1, 11, 8);   // dark outline
    ctx.fillStyle = '#8a7330'; ctx.fillRect(x, y + 3, 9, 3);        // shaded front face
    ctx.fillStyle = '#caa84a'; ctx.fillRect(x, y, 9, 3);           // lit amber top
    ctx.fillStyle = '#e8c860'; ctx.fillRect(x, y, 9, 1);           // top sheen
  }

  /* SHIPPED TODAY — the production pride display. Every job completed today stacks a green PRODUCT
     crate on a pallet in front of the OUTBOX, with a VT323 counter above ("SHIPPED 14"). The count is
     SERVER truth: completed runs (reason 'done') since LOCAL midnight via /api/runs — bumped
     optimistically on agent.run.end and reconciled by a 60s poll, so a page reload never zeroes the
     day. No OUTBOX on the floor → no pallet (the outbox IS the shipping surface); nothing draws until
     the server has actually answered (known), so it can never flash a fake number. Clicking the outbox
     with no pending return-crates opens the LOGBOOK — the shift record behind the stack. */
  let shipStats = { day: '', done: 0, known: false };
  let shipFlash = -1e9;   // fnow of the latest shipped job — the newest crate pops for ~0.9s
  const shipDay = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const shipMidnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function pollShipStats() {
    if (typeof fetch === 'undefined') return;
    try {
      fetch(apiUrl('/api/runs?agent=*&limit=500&since=' + shipMidnight()))
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!j || !Array.isArray(j.runs)) return;   // no answer — keep the last known truth
          // SHIPPED = done AND provably worked (successful tools or artifacts on the server's run row).
          // Rows older than the toolsOk field count only via artifacts — under-claiming, never over.
          shipStats = { day: shipDay(), done: j.runs.filter(r => r && r.reason === 'done' && (((r.toolsOk | 0) > 0) || (Array.isArray(r.artifacts) && r.artifacts.length > 0))).length, known: true };
        }).catch(() => {});
    } catch (_) {}
  }
  // optimistic bump the moment a run lands (the 60s poll reconciles); returns the fresh count for the ticker
  function bumpShipped() {
    const day = shipDay();
    if (shipStats.day !== day) shipStats = { day, done: 0, known: shipStats.known };
    shipStats.done++; shipFlash = fnow;
    return shipStats.done;
  }
  function drawShippedPallet(now) {
    if (!shipStats.known || shipStats.done <= 0 || !geo || !geo.props) return;
    const ob = geo.props.find(p => p.t === 'outbox');
    if (!ob) return;
    const done = shipStats.done;
    const PERROW = 4, MAXVIS = 12, shown = Math.min(done, MAXVIS);
    const baseX = (ob.x + (ob.w || 1) / 2) * T;
    const baseY = (ob.y + (ob.h || 1)) * T + 6;   // the pallet sits on the floor in front of the chute
    ctx.save();
    if (linkStaleDim) ctx.globalAlpha = 0.3;   // E1: link down → this count is last-known, not live
    for (let i = 0; i < shown; i++) {
      const row = (i / PERROW) | 0, col = i % PERROW;
      const pop = (i === shown - 1 && now - shipFlash < 900) ? 1 - (now - shipFlash) / 900 : 0;
      drawShipCrate(baseX + (col - (PERROW - 1) / 2) * 10, baseY - row * 6, pop);
    }
    ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 3; ctx.shadowColor = '#62ff9e'; ctx.fillStyle = '#9adcb0';
    ctx.fillText('SHIPPED ' + done, baseX, baseY - (((shown + PERROW - 1) / PERROW) | 0) * 6 - 4);
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  // one banked PRODUCT crate — the green economy family (same read as the outbound product box)
  function drawShipCrate(cx, cy, pop) {
    const lift = pop > 0 ? Math.round(pop * 3) : 0;
    const x = Math.round(cx - 4), y = Math.round(cy - 4) - lift;
    ctx.fillStyle = '#0e1a12'; ctx.fillRect(x - 1, y - 1, 11, 8);   // dark outline
    ctx.fillStyle = '#2e6b40'; ctx.fillRect(x, y + 3, 9, 3);        // shaded front face
    ctx.fillStyle = '#3fa86a'; ctx.fillRect(x, y, 9, 3);            // lit green top
    ctx.fillStyle = '#7ee2a8'; ctx.fillRect(x, y, 9, 1);            // top sheen
    if (pop > 0.4) { const a = ctx.globalAlpha; ctx.globalAlpha = a * (pop - 0.4); ctx.fillStyle = '#c9ffe0'; ctx.fillRect(x, y, 9, 7); ctx.globalAlpha = a; }   // arrival glint
  }


  // E2 verification hooks (dev/test only): seed a run clock, force-age it past the TTL, or drive a reconcile with a
  // synthetic snapshot — so the paired-state TTL + reconnect reconciliation can be proven without a 5-minute wait or
  // the real /api/state/snapshot endpoint. Read-only paths (dbg()) already expose ttl counts.
  const _dbgSeedRun = (aid) => { if (!aid) return; runStartByAgent.set(aid, (typeof performance !== 'undefined') ? performance.now() : fnow); stampRun(aid); };
  const _dbgAgeRun = (aid, ms) => { const t = runLastSeenByAgent.get(aid); if (t != null) runLastSeenByAgent.set(aid, t - (+ms || 0)); const s = runStartByAgent.get(aid); if (s != null) runStartByAgent.set(aid, s - (+ms || 0)); const m = liveRunsByAgent.get(aid); if (m) for (const [rid, tt] of m) m.set(rid, tt - (+ms || 0)); };
  const _dbgReconcile = (snap) => { try { reconcileFromSnapshot(snap); } catch (_) {} };
  const _dbgSweep = () => { sweepStaleStates((typeof performance !== 'undefined') ? performance.now() : fnow); };   // drive the TTL sweep directly (rAF is throttled in a headless preview tab)
  /* LEISURE verification: the power-down and prop-dwell planners are gated behind a mood phase, an idle
     age and a 22% roll, so they cannot be observed on demand from the outside. These drive them directly
     on the HERO and report the resulting latch — the same pattern as _dbgSweep, for the same reason
     (rAF is throttled in a headless preview tab, and a random gate is not a test). Read-only otherwise. */
  const _dbgSleep = () => {
    const t = (typeof performance !== 'undefined') ? performance.now() : fnow;
    const prev = self; self = agent;
    try { sleep(t); } finally { self = prev; }
    return _dbgLeisure();
  };
  const _dbgUseProp = () => {
    const t = (typeof performance !== 'undefined') ? performance.now() : fnow;
    const prev = self; self = agent;
    let ok = false;
    try { ok = planProp(t); } finally { self = prev; }
    return Object.assign({ planned: ok }, _dbgLeisure());
  };
  /* run the ARRIVAL beat for the hero's CURRENT goal right now, skipping the walk. _dbgSleep/_dbgUseProp
     only prove the PLAN; the pose (sitting/seated + where the body renders) is decided in arrive(), and a
     verify script cannot wait for the walk when the rAF loop is frozen (an undisplayed tab composites no
     frames, so the engine never ticks). Same code path the engine runs on arrival — no pose is faked. */
  const _dbgArrive = () => {
    if (!agent) return _dbgLeisure();
    const t = (typeof performance !== 'undefined') ? performance.now() : fnow;
    const prev = self; self = agent;
    try { agent.target = null; agent.pathPts = null; arrive(t); } finally { self = prev; }
    return _dbgLeisure();
  };
  const _dbgLeisure = () => ({
    goal: agent ? agent.goal : null,
    usingProp: agent ? agent.usingProp : null,
    useKind: agent ? useKindOf(agent.usingProp) : null,
    sitting: !!(agent && agent.sitting),
    lying: !!(agent && agent.lying),          // IN a bed, under the covers (never the chair-sit pose)
    seatKey: (agent && agent.seatKey) || null,
    seated: !!(agent && agent.seated),
    useMs: agent ? Math.max(0, Math.round((agent.useUntil || 0) - ((typeof performance !== 'undefined') ? performance.now() : fnow))) : 0,
    watchProp: (agent && agent.watchProp) || null,
    // where the body actually DRAWS: seated bodies render on the claimed seat tile, everyone else on their own
    renderPx: agent ? (agent.seated ? { x: agent.seatPx, y: agent.seatPy } : { x: agent.px, y: agent.py }) : null,
    walkingTo: (agent && agent.target) ? { x: agent.target.x, y: agent.target.y } : null,
    seats: [...occupiedSeats],
  });
  /* CDP-verify hook: CLIENT (mouse-event) coordinates for the centre of the first prop of type `t` — the
     exact inverse of toWorld/toCanvas, so a shot script can dispatch a REAL canvas click on a prop (the
     sample-card INBOX proof) instead of faking the handler call. Read-only; null when absent/unbaked. */
  const _dbgPropClientPoint = (t) => {
    const p = geo && geo.props && geo.props.find(q => q.t === t);
    if (!p || !cv) return null;
    const wx = (p.x + (p.w || 1) / 2) * T, wy = (p.y + (p.h || 1) / 2) * T;
    const r = cv.getBoundingClientRect();
    return {
      id: p.id,
      clientX: r.left + ((wx * scale + panX) * (r.width / cv.width)),
      clientY: r.top + ((wy * scale + panY) * (r.height / cv.height))
    };
  };
  // E1 verification: report the live link predicate, and force the real chanES closed (a genuine dropped socket)
  // so the DOWN branch can be observed against a real non-OPEN readyState without killing the whole process.
  const _dbgLinkState = () => ({ es: !!chanES, readyState: (chanES ? chanES.readyState : -1), lastEventMsAgo: (lastSseEventAt ? Math.round(((typeof performance !== 'undefined') ? performance.now() : fnow) - lastSseEventAt) : null), linkDown: linkDown((typeof performance !== 'undefined') ? performance.now() : fnow) });
  const _dbgDropBridge = () => { if (chanES) { try { chanES.close(); } catch (_) {} } return _dbgLinkState(); };
  // Deterministic live regression seam for the offscreen CRT warp. It invokes the browser-standard
  // WEBGL_lose_context extension on the exact production context, then exposes only renderer health + a
  // bounded whole-frame brightness sample so the test can prove the SAME visible feed stayed alive.
  const _dbgCurveState = () => {
    let means = null;
    try { if (cv) means = probeMeans(cv); } catch (_) {}
    return {
      path: _glFailed ? 'cpu' : (_glReady ? 'webgl' : 'uninitialized'),
      ready: _glReady, failed: _glFailed, lost: glContextLost(_gl),
      frameSum: means ? Math.round(means[0] + means[1] + means[2]) : null
    };
  };
  const _dbgLoseCurveContext = () => {
    if (!_gl || !_glReady) return { ok: false, reason: 'WebGL curve is not active' };
    let ext = null;
    try { ext = _gl.getExtension('WEBGL_lose_context'); } catch (_) {}
    if (!ext || typeof ext.loseContext !== 'function') return { ok: false, reason: 'WEBGL_lose_context unavailable' };
    ext.loseContext();
    return { ok: true };
  };
  /* Simulate a GPU/driver reset for verify scripts + test/canvas-loss-recovery.test.js: zero the
     backing store of every cached plate WITHOUT touching the objects or their sizes — which is
     precisely what the browser does and precisely why nothing downstream notices. There is no JS
     API to lose a 2D context on demand (unlike WEBGL_lose_context above), so reproducing the
     black station means reproducing its EFFECT. `sky`/`ground` reach into the other two cache
     owners, so one call reproduces the whole reported frame, not just the floor. */
  const _dbgLoseCanvases = () => {
    const wipe = c => {
      try { const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); return true; }
      catch (_) { return false; }
    };
    let bake = 0;
    if (cache) for (const k of ['baseCv', 'lightCv']) if (cache[k] && wipe(cache[k])) bake++;
    let sky = 0, ground = 0;
    try { if (typeof SpaceBG !== 'undefined' && SpaceBG._dbgLosePixels) sky = SpaceBG._dbgLosePixels(); } catch (_) {}
    try { if (typeof Terrain !== 'undefined' && Terrain._dbgLosePixels) ground = Terrain._dbgLosePixels(); } catch (_) {}
    return { bake, sky, ground, probe: bakeProbe ? { x: bakeProbe.x, y: bakeProbe.y } : null };
  };
  // what the watchdog currently knows — lets a test assert recovery happened, not just that pixels returned
  const _dbgCanvasLoss = () => ({
    probe: bakeProbe ? { x: bakeProbe.x, y: bakeProbe.y } : null,
    probeOff, recoveries, blank: bakeWentBlank()
  });
  /* STAGE-DEATH REPRO (the 2026-08-24 fully-black report). There is no JS API to lose a 2D
     context on demand, so reproduce its EFFECT on the live context instance: every draw call
     no-ops and the backing store is gone, while getImageData keeps answering (with the zeros
     a dead stage really reads). The watchdog cannot tell this from the real thing — which is
     the point. Recovery swaps the whole canvas, so the patched context is discarded with it. */
  const _dbgKillStageContext = () => {
    if (!cv || !ctx) return false;
    for (const k of ['drawImage', 'fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'putImageData']) {
      try { ctx[k] = () => {}; } catch (_) {}
    }
    try { cv.width = cv.width; } catch (_) {}   // zero the visible bitmap, as the lost backing store does
    return true;
  };
  // the stage watchdog's current knowledge — lets a verify script assert the REBUILD, not just returned pixels
  const _dbgStageState = () => ({
    armed: stageProbeArmed, probeOff: stageProbeOff, deadSince: stageDeadSince,
    rebuilds: stageRebuilds, futile: stageFutile,
    lost: (() => { try { return !!(ctx && typeof ctx.isContextLost === 'function' && ctx.isContextLost()); } catch (_) { return false; } })()
  });
  // belt-legibility readout for CDP verify scripts: the EXACT state the renderer draws from (never a re-derivation)
  const _dbgBeltLegibility = () => ({
    beltCount: beltTileSet ? beltTileSet.size : 0,
    liveCount: beltLiveSet ? Object.keys(beltLiveSet).length : 0,
    liveKeys: beltLiveSet ? Object.keys(beltLiveSet).sort() : [],
    nags: routingNags ? routingNags.map(n => n.label) : [],
    planSync: planPoster.state(),   // plan delivery truth: lastHash committed ONLY on a server answer; stale=true while the sidecar may route by an older floor
    feed: { known: feedState.known, fed: feedState.fed, nagOn: feedNagOn },
    ship: { known: shipStats.known, day: shipStats.day, done: shipStats.done },
    boxes: convey ? convey.peekBoxes() : [],   // the crates riding RIGHT NOW (id/tile/dir/payload)
    ghost: ghost ? ghost.peek() : null,        // the projection's own state (never mixed into `boxes` — dedicated engine)
    work: (() => { const o = {}; for (const v of runWork.values()) { const k = v.agentId || 'agent'; const c = o[k] || (o[k] = { tools: 0, dels: 0 }); c.tools += v.tools; c.dels += v.dels; } return o; })(),   // proven-work tally per agent, summed over ITS live runs (runWork is per-run since audit #5)
    routeAt: (x, y) => routeTagFor(x, y),
    outboundAt: aid => outboundBeltTile(aid),   // where would this agent's product crate spawn (verify hook)
    sourceAt: aid => (routingPlan && typeof Pipeline !== 'undefined' && Pipeline.sourceFor) ? Pipeline.sourceFor(routingPlan, aid) : null,   // which INBOX would an addressed item enter through (verify hook)
    pollFeed: () => pollFeedState(),
    pollShip: () => pollShipStats()
  });
  return { init, rebake, crt: CRT, slagLog: () => (slaglog ? slaglog.recent() : []),
    // FEED TRUTH accessor (guided workflows): the exact server-proven state the NO FEED nag keys on —
    // REFIT's finish-the-line card reads THIS, never a parallel poll, so the two can never disagree.
    feedState: () => ({ known: feedState.known, fed: feedState.fed }),
    // FEED RE-CHECK on demand (2026-08-22): the INBOX card's CREATE ROUTINE path awaits this so the card, the
    // NO FEED nag and the finish checklist flip on the server's answer NOW, not on the next 60s poll / reload.
    pollFeed: () => pollFeedState(),
    /* PLAN SYNC on demand (run-now ordering, 2026-08-22): REFIT freezes the sim (world.stop), so a floor edit
       sets geoDirty but the recompile + POST only ran at the NEXT frame — i.e. on REFIT close. A sample / RUN
       NOW fired mid-session therefore ran the LAST POSTED line. Every run trigger awaits THIS first: recompile
       now if the floor is dirty, then resolve with the poster's verdict + the compiled plan's BLOCKING errors
       (the same codes the floor nags with), so the caller can refuse instead of running a stale or broken line. */
    syncPlan: () => {
      if (station && (geoDirty || !geo)) rederive();
      const errors = (routingPlan && routingPlan.errors ? routingPlan.errors : []).filter(e => !e.warn);
      return planPoster.flush().then(s => Object.assign({ errors: errors, hash: routingPlan ? routingPlan.hash : null }, s));
    },
    loadStation, spawn, spawnAgent, despawnAgent, setSkin, relabel, setActivityFor, agentRunsLive, dropRun: noteRunEnd, focusBody, lockBody, cameraMode, setCinecamIdle, setChatFocus, chatFocusPing, start, stop, setActivity, wakeIn, beginAwakening, setWakeProgress, igniteSpark, armKindle, kindleHold, camPushIn, camCreep, camPunch, camPullBack, awakenTurn, truthPulse, beginFlood, collapseFlood, endAwakening, releaseAwakening, say, focusAgent, getActivity: () => activity, getUse: () => (agent ? agent.usingProp : null), setOnClick, setOnArcade, setOnOutbox, setOnMissionBoard, setOnTrophyCase, setOnBayAssign, setOnIntakeFeed, setOnIntakeSample, refit, pauseBridge, resumeBridge, linkState, _dbgSeedRun, _dbgAgeRun, _dbgReconcile, _dbgSweep, _dbgLinkState, _dbgDropBridge, _dbgCurveState, _dbgLoseCurveContext, _dbgLoseCanvases, _dbgCanvasLoss, _dbgKillStageContext, _dbgStageState, _dbgBeltLegibility, _dbgPropClientPoint, _dbgSleep, _dbgUseProp, _dbgArrive, _dbgLeisure,
    // AGENT GROWTH: XpStore pushes pre-computed Xp.compute() snapshots here; pulseLevelUp fires
    // the addressed body's gold ring. The colony headline is the top-bar STATION chip.
    setXp: (agentId, a) => {
      if (a === undefined && (agentId == null || typeof agentId === 'object')) { a = agentId; agentId = agent && agent.id; }   // old one-arg shape
      const id = agentId || (agent && agent.id) || 'agent';
      if (a) xpByAgent.set(id, a); else xpByAgent.delete(id);
      xpAgent = agent ? (xpByAgent.get(agent.id) || null) : null;
    },
    pulseLevelUp: (agentId, level) => {
      if (level === undefined && typeof agentId === 'number') { level = agentId; agentId = agent && agent.id; }   // old one-arg shape
      const now = performance.now();   // one clock read so the ripple + caption share an origin
      const b = bodyForAgent(agentId || (agent && agent.id)) || (!agentId ? agent : null);
      if (!b) return;
      b.levelUpAt = now;
      if (b === agent) levelUpAt = now;
      // a brief "LEVEL N" caption rides the gold ripple — but never stomp a live, NON-EMPTY (real) message bubble
      if (level != null && !(b.say && b.say.text && b.say.until > now)) b.say = { text: 'LEVEL ' + level, until: now + 2600 };
    },
    // read-only introspection for live verification of idle behavior (no side effects)
    dbg: () => agent && { goal: agent.goal, quirkKind: agent.quirkKind, sitting: agent.sitting, state: agent.state, stilling: !!agent.stilling, firstWakeDone, wakePhase: agent.wakePhase, moving: !!agent.target, paused: fnow < (agent.pauseUntil || 0), pauseLook: agent.pauseLook, dir: agent.dir, attn: (agent.attn && fnow < agent.attn.until) ? { x: agent.attn.x, y: agent.attn.y, inMs: Math.round(agent.attn.until - fnow) } : null, drive: (fnow < (agent.driveUntil || 0)) ? agent.drive : null, tile: tileOf(agent.px, agent.py), idleUntil: Math.round((agent.idleUntil || 0) - fnow), quirkCd: Math.round(Math.max(0, (agent.quirkCd || 0) - fnow)), offbeatCd: Math.round(Math.max(0, (agent.offbeatCd || 0) - fnow)), fond: [...agent.fond.entries()], pendingMourn: pendingMourn && { tx: pendingMourn.tx, ty: pendingMourn.ty, fond: pendingMourn.fond }, decor: agentDecor.length, crew: crew.length, spendUsd: floor ? (floor.snapshot().spendUsd || 0) : 0, boxes: convey ? convey.boxCount() : 0, queueDepth: queueDepthNow(), bridge: { paused: bridgePaused, es: !!chanES, poll: !!connPollTimer, readyState: (chanES ? chanES.readyState : -1), lastEventMsAgo: (lastSseEventAt ? Math.round((typeof performance !== 'undefined' ? performance.now() : fnow) - lastSseEventAt) : null), linkDown: linkDown((typeof performance !== 'undefined') ? performance.now() : fnow) }, ttl: { runClocks: runStartByAgent.size, glyphs: glyphByAgent.size, serverLit: serverLit.size, runTtlMs: RUN_TTL_MS, awaitTtlMs: AWAIT_TTL_MS }, await: awaitPrompt ? { promptId: awaitPrompt.promptId, arrived: awaitArrived, source: awaitAnchor ? awaitAnchor.source : null, anchor: awaitAnchor ? { tx: awaitAnchor.tx, ty: awaitAnchor.ty } : null } : null, proposalsPinned: pinnedCount, social: socialBeat && { kind: socialBeat.kind, aId: socialBeat.aId, bId: socialBeat.bId }, chase: chaseId != null && { id: chaseId, phase: (bodyForAgent(chaseId) && bodyForAgent(chaseId).chase && bodyForAgent(chaseId).chase.phase) || null }, chaseGateIn: Math.round(Math.max(0, chaseGateUntil - fnow)), cursorFresh: (fnow - lastCursor.t) < CURSOR_FRESH_MS, cursorMoving: (fnow - cursorMoveT) < CURSOR_MOVING_MS },
    // read-only camera truth for the DEV verify harness (+ the war-room HUD chip): who drives the camera
    // ('manual' | 'lock' = session follow | 'auto' = idle cinecam), which body is locked, and how long the
    // Commander has been hands-off. Pure read, no side effects — the testapi idiom.
    cameraDbg: () => ({ mode: cameraMode(), lockId: camLock ? camLock.id : null, source: camLock ? camLock.source : null, idleMs: Math.round(performance.now() - camUserAt), thresholdMs: cineIdleMs, scale: +scale.toFixed(3), panX: Math.round(panX), panY: Math.round(panY), gates: { anim: !!camAnim, frozen: awakeFrozen, cache: !!cache, reduceMotion: reduceMotion() } }),
    // TEST/DEBUG ONLY — the D3 border-meeting pure geometry (sharedEdge/borderTileFor), exposed read-only for the
    // DEV harness. No world state touched (both are pure; borderTileFor takes an injected walkable predicate).
    // The headless coverage lives in test/social-border.test.js (extracts the D3-PURE-GEOMETRY block from source).
    _dbgSocialGeom: { sharedEdge: (ra, rb) => sharedEdge(ra, rb), borderTileFor: (rect, edge, cur, walkableFn) => borderTileFor(rect, edge, cur, walkableFn) },
    /* TEST/DEBUG ONLY — the 2026-08-17 pass: bodies are solid, walls block sight, the belt is bounded.
       All three are properties of a LIVE floor over TIME (an overlap lasts a few frames; a through-wall
       conversation needs two bodies in two rooms), so none of them can be proven by a source read. These
       are the read-only probes a soak samples. Nothing here mutates world state.
         _dbgLos      — ask the shipped sightline test about any two tiles (walls/doors of the real bake)
         _dbgSpacing  — the CLOSEST pair of placed bodies right now, in px + tiles, against the law's
                        threshold. `min >= personalPx` sampled every frame IS the no-overlap proof.
         _dbgBeltWatch— who (if anyone) holds the station's single conveyor-watch claim, and every body's
                        remaining cooldown: the readout that tells a congregation from a coincidence. */
    _dbgLos: (ax, ay, bx, by) => losClear(ax | 0, ay | 0, bx | 0, by | 0),
    _dbgSpacing: () => {
      const list = allBodies().filter(b => b && !b.unplaced);
      let min = Infinity, pair = null;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i].px - list[j].px, list[i].py - list[j].py);
        if (d < min) { min = d; pair = [list[i].id, list[j].id]; }
      }
      return { bodies: list.length, minPx: list.length > 1 ? +min.toFixed(2) : null, minTiles: list.length > 1 ? +(min / T).toFixed(2) : null, personalPx: +(PERSONAL_TILES * T).toFixed(2), pair };
    },
    _dbgBeltWatch: () => {
      const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
      return {
        belts: (geo && geo.belts) ? geo.belts.length : 0,
        held: beltWatchTaken(now) ? (beltWatch.body.id || null) : null,
        watching: allBodies().filter(b => b && !b.unplaced && b.goal === 'watch').map(b => b.id),
        cooldownsMs: allBodies().filter(b => b && !b.unplaced).map(b => ({ id: b.id, ms: Math.max(0, Math.round((b.beltWatchCd || 0) - now)) })),
      };
    },
    // TEST/DEBUG ONLY — is this prop type freely crossable, or does prop awareness route bodies around
    // it? A rug missing from SOFT_CROSS still places, renders and stays walkable — the ONLY visible
    // symptom is bodies stepping around it — so this is the one seam that needs a live readout.
    _dbgSoftCross: (t) => SOFT_CROSS.has(String(t)),
    // TEST/DEBUG ONLY — containment harness: raw-place a body (bypassing every walkable-checked picker)
    // so the per-tick containment backstop (containBody / hero ensureAgentValid) is provable live.
    _dbgTeleport: (aid, px, py) => { const b = bodyForAgent(aid); if (!b) return false; b.pathPts = null; b.target = null; b.sitting = false; b.seated = false; b.px = +px; b.py = +py; return true; },
    // TEST/DEBUG ONLY — read the huddle SELECTION counters (see huddleStats). Answers "why was there
    // no trio" without a second instrumented build: planned vs. how many candidates each huddle saw
    // vs. roll vs. tile failure. Read-only snapshot; the caller cannot mutate the live object.
    _dbgHuddleStats: () => JSON.parse(JSON.stringify(huddleStats)),
    /* TEST/DEBUG ONLY — COMPANIONS readout + selection sampler.
       A real social beat fires once every 30-60s and picks ONE partner, so waiting for the bias to
       show up on its own is not a verification, it is a vigil — and a rare surface that never gets
       forced is exactly how this project has shipped broken beats before. So this drives the SHIPPED
       pickByBond (not a re-derivation) `n` times over a candidate list and reports where it landed.
       A green read means the real selection maths, fed the real polled graph, actually favours the
       agents the run log proved. `graph` is the loaded bond map, so a zero-bias result can always be
       told apart from an empty graph. */
    /* TEST/DEBUG ONLY — TIER E THE GATHERING. A beat gated on 30 minutes of unattended quiet plus an
       hourly roll cannot be observed by waiting: that is a vigil, and a surface that never renders on
       the dev box is invisible to every live-verify pass. So `_dbgGatherNow` bypasses the FREQUENCY
       gates ONLY (quiet window, hourly roll, chance, cooldown) — exactly the discipline trioprobe's
       `force` follows. Every legality gate still runs inside startGathering: enough placed idle
       bodies, and a formation the floor can actually seat. A staged pass must never be able to print
       success for an assembly the real trigger could not have produced. */
    _dbgGatherNow: () => {
      const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
      if (gathering) return { ok: false, err: 'a gathering is already live' };
      gatherGateUntil = -1e9;                                     // frequency only
      const keep = self;
      try { self = agent; return { ok: !!startGathering(now), state: gatherStateSnapshot() }; }
      finally { self = keep; }
    },
    // read-only snapshot of the live assembly — roles, slots, who has actually arrived, and the phase.
    _dbgGatherState: () => gatherStateSnapshot(),
    /* Which gate is actually holding the gathering back (or tearing it down)? gatheringBroken is an OR
       of six conditions and a live station gives no clue which one fired — the first probe run saw the
       assembly scatter within one tick and the only honest way to find out was to read them apart. */
    _dbgGatherGates: () => {
      const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
      const bodies = gatherBodiesLive();
      return {
        cursorPresent: cursorPresent(now), pageVisible: pageVisible(),
        heroTasked: activity === 'task', chatHot: chatHot(now),
        attended: stationAttended(now), quietMs: Math.round(now - stationBusyAt),
        live: !!gathering, phase: gathering ? gathering.phase : null,
        party: bodies.length, planless: bodies.filter(b => b.gather == null).map(b => b.id),
        working: bodies.filter(b => b.working).map(b => b.id),
        unplaced: bodies.filter(b => b.unplaced).map(b => b.id),
        broken: gathering ? gatheringBroken(now) : null,
      };
    },
    /* Drive the SCATTER through the real predicate rather than a staged teardown: stamping the cursor
       is precisely what "the Commander came back" means to gatheringBroken, so this proves the shipped
       exit path (and the overseer's late break) instead of a copy of it. */
    _dbgGatherReturn: () => {
      const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
      if (!lastCursor) lastCursor = { wx: 0, wy: 0, t: 0 };   // shape matches the module's own tracker
      lastCursor.t = now; cursorMoveT = now;
      return { broken: gatheringBroken(now) };
    },
    _dbgAffinity: (anchorIds, ids, n) => {
      const list = (Array.isArray(ids) ? ids : []).map(id => ({ id: id }));
      const anchors = Array.isArray(anchorIds) ? anchorIds : [anchorIds];
      const sample = {};
      for (const o of list) sample[o.id] = 0;
      const runs = Math.max(0, Math.min(20000, n | 0));
      for (let i = 0; i < runs; i++) { const p = pickByBond(anchors, list); if (p) sample[p.id]++; }
      return {
        graph: Array.from(affinityPairs.entries()).map(([k, v]) => ({ pair: k, strength: v })),
        weights: bondWeights(anchors, list.map(o => o.id), bondOf, BOND_PULL),
        sample: sample, runs: runs
      };
    },
    /* TEST/DEBUG ONLY — W6 peer-chatter readout: which bodies are carrying a live glyph line right
       now, straight off the SAME `chatter` objects the renderer draws from (never a re-derivation,
       so a green read cannot mean anything but "that bubble is on screen"). `words` is the rune-
       INDEX shape, which is all there is — there is no text on this path to report. */
    _dbgChatter: () => {
      const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
      const all = (agent ? [agent] : []).concat(crew);
      return {
        beat: socialBeat ? { kind: socialBeat.kind, ids: participantIds(socialBeat).slice() } : null,
        alphabet: RUNES.length, holdMs: CHATTER_MS,
        live: all.filter(b => b && b.chatter && (now - b.chatter.at) <= CHATTER_MS && now <= b.chatter.until).map(b => ({
          id: b.id, talking: !!b.talking, ageMs: Math.round(now - b.chatter.at), leftMs: Math.round(b.chatter.until - now),
          words: b.chatter.words.map(w => w.slice()), dialect: dialectFor(b).slice()
        }))
      };
    },
    /* TEST/DEBUG ONLY — assemble a huddle from named bodies through the REAL planHuddle path (same
       borrowed-actor discipline as _dbgSit/greetNewcomer: set `self`, restore in finally). A trio is
       rare by design — it needs three eligible bodies standing together AND a roll AND a legal third
       tile — so waiting for the idle engine's dice is not a way to prove the three-body conversation
       WORKS. `force` bypasses the frequency roll ONLY; every legality gate (zone containment, pair
       cooldowns, the tile resolver, the single-slot rule) is untouched, so what this proves is the
       real thing and not a staged one. Returns the roster that was actually armed. */
    _dbgHuddle: (ids, force) => {
      if (!geo || !Array.isArray(ids) || ids.length < 2) return { ok: false, err: 'need >= 2 ids' };
      const bodies = ids.map(bodyForAgent);
      if (bodies.some(b => !b || b.unplaced)) return { ok: false, err: 'a body is missing or unplaced' };
      if (socialBeat) return { ok: false, err: 'an encounter is already live' };
      const keep = self, now = (typeof performance !== 'undefined') ? performance.now() : fnow;   // the same clock the tick hands every social function
      try {
        self = bodies[0];
        const ok = planHuddle(bodies[0], bodies.slice(1), now, !!force);
        return { ok: !!ok, roster: socialBeat ? participantIds(socialBeat).slice() : null, kind: socialBeat ? socialBeat.kind : null };
      } finally { self = keep; }
    },
    // TEST/DEBUG ONLY — deterministically seat a body on a single-tile seat prop (stool/chair) through the
    // REAL planSeat path (claim + pendSeat + lift + counterFace), so the perch render is provable live
    // without waiting on the idle engine's dice. Same borrowed-actor discipline as spawnAgent (B1 restore).
    _dbgSit: (aid, propId) => {
      const b = bodyForAgent(aid); if (!b || !geo || !geo.props) return false;
      const p = geo.props.find(q => q.id === propId); if (!p) return false;
      // park the body on a walkable neighbour FIRST (geo frame, not doc coords — the local-pixel-frame
      // trap) so the plan is position/zone-independent: a roam-anchored zone across the map would
      // otherwise fail planSeat's in-zone check and the proof would be testing the caller's teleport math.
      for (const [dx, dy] of SEAT_NB) {
        const ax = p.x + dx, ay = p.y + dy;
        if (geo.walkable(ax, ay, blocked)) { b.pathPts = null; b.target = null; b.sitting = false; b.seated = false; b.px = (ax + 0.5) * T; b.py = (ay + 0.5) * T; break; }
      }
      const keep = self; self = b;
      try { return planSeat(performance.now(), p, zoneFor(b)); }
      finally { self = keep; }
    },
    // TEST/DEBUG ONLY — the same deterministic seating for a COUCH-kind prop (sofa, recliner) through the
    // REAL planCouchSit path (cushion claim + pendSeat + the side-seat perch), so the cushion render is
    // provable live. Separate from _dbgSit because the two planners are separate: a couch claims a numbered
    // cushion slot and can carry a TV to watch, a stool claims the whole prop.
    _dbgCouchSit: (aid, propId, tvId, face) => {
      const b = bodyForAgent(aid); if (!b || !geo || !geo.props) return false;
      const p = geo.props.find(q => q.id === propId); if (!p) return false;
      for (const [dx, dy] of SEAT_NB) {                     // park adjacent first — same reason as _dbgSit
        const ax = p.x + dx, ay = p.y + dy;
        if (geo.walkable(ax, ay, blocked)) { b.pathPts = null; b.target = null; b.sitting = false; b.seated = false; b.px = (ax + 0.5) * T; b.py = (ay + 0.5) * T; break; }
      }
      const keep = self; self = b;
      try { return planCouchSit(performance.now(), p, tvId || null, face || 'north', zoneFor(b)); }
      finally { self = keep; }
    },
    // read-only body snapshot for the DEV test harness (window.__SKYNET_TEST__) — the Tier A/B/C substrate.
    // Pure read, no side effects: the hero + every crew body, each with tile/zone/glance/goal/moving so the
    // floor invariants (idle stays in-zone · awareness is gaze-only · summoned walks to its OWN workstation)
    // can be auto-asserted instead of eyeballed. Mirrors dbg()'s clock (fnow) and helpers (tileOf/zoneFor).
    bodies: () => {
      const snap = (b, hero) => {
        if (!b) return null;
        const t = tileOf(b.px, b.py);
        const rt = tileOf(bodyPosX(b), bodyPosY(b));
        const z = zoneFor(b);
        const fd = facingDetail(b), fp = fd && fd.prop;
        return {
          id: b.id, name: b.name, hero: !!hero,
          tile: t, renderTile: rt, px: Math.round(b.px), py: Math.round(b.py), dir: b.dir, state: b.state,
          goal: b.goal || null, moving: !!b.target, working: !!b.working, sitting: !!b.sitting,
          seated: !!b.seated, unplaced: !!b.unplaced, summoned: !!b.summoned,   // summoned = carries the idle inner life (roster bodies must, post-relaunch too)
          visTopPy: (b.visTopPy != null) ? Math.round(b.visTopPy) : null,       // drawn head-top (world px) — the overlay anchor drawBubble/drawNameplate use
          say: (b.say && b.say.text && b.say.until > fnow) ? b.say.text : null,
          target: b.target ? { tile: tileOf(b.target.x, b.target.y), x: Math.round(b.target.x), y: Math.round(b.target.y) } : null,
          glance: b.glance ? { dir: b.glance.dir, ms: Math.max(0, Math.round((b.glance.until || 0) - fnow)) } : null,
          zone: z, inOwnZone: tileInZone(z, t.x, t.y),
          // idle-life (2026-08-08) instrumentation — read-only, no side effects:
          facing: fd ? fd.subject : null,                               // what is one tile ahead of its RENDERED position ('wall' is the defect)
          facingProp: fp ? { id: fp.id, type: fp.t, useKind: (propUse(fp) || {}).kind || null } : null,
          facingCounter: !!(fp && isCounterProp(fp)),                   // truthful bar-stool proof: the actual prop in front is counter-ish
          wallDirs: wallDirsAt(b),                                      // control: how many of the 4 cardinals here ARE wall (a blind pick would hit wall wallDirs/4 of the time)
          quirkKind: b.quirkKind || null,
          useKind: b.usingProp ? useKindOf(b.usingProp) : null,         // WHICH prop it is using (the per-kind beat)
          usingProp: b.usingProp || null,                               // ...and the exact prop id — the one-machine-one-player proof keys on collisions here
          emote: !!(b.emote && b.emote.until > fnow),                   // the ambient stretch is playing (assets.js owns it; nothing in the idle engine fires it)
          talking: !!b.talking,                                         // W4: taking its turn in a silent exchange
          pose: b._pose || null,                                        // the sprite track it was LAST DRAWN in (assets.js records it) — render truth, not a re-derivation
          socialKind: (b.social && b.social.kind) || null,              // which encounter it is in, and
          socialPhase: (b.social && b.social.phase) || null,            // whether it is still walking to it or holding
          inHomeRoom: !!(z && z.kind === 'room' && typeof Zones !== 'undefined' && Zones.rectHas(z.rect, t.x, t.y))   // false + inOwnZone = it walked into another room on its roam radius
        };
      };
      return [snap(agent, true), ...crew.map((b) => snap(b, false))].filter(Boolean);
    },
    // does this agent have a WORKBENCH placed (-> shell.exec + verify.run)? An equipped BAY governs; with no bay
    // (simple single-agent floor) any placed workbench grants it. The run client sends this so the hero's run
    // gains shell ADDITIVELY on top of its default office (the room layout is the permission system, for the hero too).
    heroWorkbench: (agentId) => {
      if (!station) return false;
      const viaBay = (station.bayObjects && agentId) ? station.bayObjects(agentId) : [];
      if (viaBay && viaBay.length) return viaBay.indexOf('workbench') >= 0;
      return !!(station.propsByType && station.propsByType('workbench').length);
    },
    // THE MOAT (FLOOR-REAL): the agent's REAL placed capability set — the EARNED reach the run client sends so the
    // sidecar grants exactly what's on the floor (dish→web · cabinet→files · workbench→terminal · notebook→memory ·
    // studio→image · jukebox→spotify). COMPUTE is the harness FREEBIE (always granted to an interactive agent, so it
    // is never a dead wall) and CONNECTORS are account-level (added server-side), so both are excluded here — this is
    // purely the placed-on-top set. An equipped BAY governs; with no bay (the simple single-agent floor) every distinct
    // cap-prop placed anywhere is the hero's. Returns [{objectType}] room-object entries the sidecar appends as extras.
    // QUEST-LOG read: honest floor counts for the station-arc quests (belts laid, portals placed). A pure
    // projection of the live station doc — read-only, no caching, gates nothing.
    stationCounts: () => {
      if (!station || !station.doc) return { belts: 0, connectors: 0, liveRoute: 0 };
      const d = station.doc() || {};
      return {
        belts: d.belts ? Object.keys(d.belts).length : 0,
        connectors: d.props ? d.props.filter(p => p && p.t === 'connector_portal').length : 0,
        // tiles on a COMPLETE intake→bound-bay route (the same energized set the renderer draws) — the
        // st:belt quest completes on THIS, not on belts laid, so it can never reward a dead line.
        liveRoute: beltLiveSet ? Object.keys(beltLiveSet).length : 0
      };
    },
    // the live station document (read-only) — the station-quest generator reads props[] to detect the
    // OUTBOX / MISSION-BOARD standing gaps and to resolve a placement. Null when no station is loaded (headless).
    stationDoc: () => (station && station.doc ? station.doc() : null),
    // G1c — the live SlagLog ring (read-only): the most-recent wasted-spend post-mortems the floor has diagnosed.
    // The maintenance-quest generator (maintqueststore.js) tallies these by cause; a recurring cause mints a
    // fix-it quest. Returns a fresh copy (slaglog owns the ring); [] when the log isn't loaded (headless/title).
    slagPostmortems: () => { try { return (slaglog && slaglog.recent) ? slaglog.recent() : []; } catch (_) { return []; } },
    // DEV/proof read surface (pure, no side effects — the testapi idiom): where a placed prop of type `t`
    // sits ON SCREEN (CSS px), derived from the live camera + the local-frame geometry. Lets a headless
    // driver dispatch a REAL mouse click at the MISSION BOARD instead of faking the seam. Null when absent.
    propScreenRect: (t) => {
      if (!cv || !geo || !geo.props) return null;
      const p = geo.props.find(q => q.t === t);
      if (!p) return null;
      const r = cv.getBoundingClientRect();
      const kx = r.width / cv.width, ky = r.height / cv.height;
      const toScr = (wx, wy) => ({ x: r.left + (wx * scale + panX) * kx, y: r.top + (wy * scale + panY) * ky });
      const a = toScr(p.x * T, p.y * T), b = toScr((p.x + (p.w || 1)) * T, (p.y + (p.h || 1)) * T);
      return { left: a.x, top: a.y, right: b.x, bottom: b.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    },
    heroCaps: (agentId) => {
      if (!station) return [];
      const viaBay = (station.bayObjects && agentId) ? station.bayObjects(agentId) : [];
      const norm = o => (o && typeof o === 'object') ? o.objectType : o;   // bayObjects entries are strings or {objectType}
      // bayObjects() returns [] both for no bay and for a real but empty assigned room. The latter is still
      // authoritative: use agentRoomId to preserve its empty scope instead of falling back station-wide.
      let hasBay = false;
      if (station.agentRoomId && agentId) {
        try { hasBay = !!station.agentRoomId(agentId); } catch (_) { return []; }
      }
      const src = (hasBay || (viaBay && viaBay.length))
        ? viaBay.map(norm)
        : ((station.doc && station.doc().props) || []).map(p => (station.capForProp ? station.capForProp(p.t) : null));
      const out = [], seen = {};
      for (const cap of src) {
        if (!cap || cap === 'computer' || cap === 'connector') continue;   // compute = freebie; connectors = added server-side
        if (seen[cap]) continue; seen[cap] = true;
        out.push({ objectType: cap });
      }
      return out;
    },
    // STATION-WIDE gear (Class Loadouts shared-gear model): every capability objectType placed ANYWHERE on the
    // station, deduped — the shared gear any agent draws on under the overseer, regardless of whose desk it is in.
    // Used for SKILL availability only (a class's recipes need the station to have the gear, not the agent's own
    // room). Tool reach stays room-scoped via heroCaps. Returns [{objectType}] like heroCaps; [] on any hiccup.
    stationCaps: () => {
      if (!station) return [];
      const props = (station.doc && station.doc().props) || [];
      const out = [], seen = {};
      for (const p of props) {
        const cap = station.capForProp ? station.capForProp(p.t) : null;
        if (!cap || cap === 'computer' || cap === 'connector') continue;   // compute = freebie; connectors = server-side
        if (seen[cap]) continue; seen[cap] = true;
        out.push({ objectType: cap });
      }
      return out;
    }
  };
})();
