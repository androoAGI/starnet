# DECISIONS.md — locked decision log

Decisions that are **settled**. Do not re-litigate them in a session; do not "improve" them
in passing. If you believe one is wrong, surface it to Andrew as a question — don't change it.
Each entry: the decision, why, and the date it locked (where known).

Companion files: [BRAIN.md](BRAIN.md) (start here) · [MISTAKES.md](MISTAKES.md) ·
[NEXT.md](NEXT.md). The `.claude/skills/starnet-*` skills are the enforcement layer for
many of these — they win on any wording conflict.

## Product

- **Feedback is critical, and it compounds (Andrew, 2026-10-01).** Every like and dislike the
  Commander gives must persist (survive restarts, no short TTLs, no RAM-only stores) and must reach
  later prompts, so agents converge on exactly how the Commander wants work done over months. A
  feedback signal that is logged but never read back is a bug. Shipped shape (`agent/feedback-learning`):
  a rating + correction becomes one user-confirmed Preference record per rated run
  (`sidecar/feedbackmemory.js`, origin `feedback`), editable/forgettable in the Memory Core; the
  newest feedback rides EVERY run, station-wide (taste is about the Commander, not the rated agent);
  a run rated missed counts as a failure in the track record; rating review packets are durable.
  Respects the personalization pause. Only words that read as feedback on the work become taste.
- **StarNet is for beginners and power users.** It is easier for beginners to use, never
  beginner-limited: sandbox freedom, full power from minute one, and no grind/unlock/usage
  walls. User-work quotas default off; users or deployers may opt into limits. Restricted
  postures enforce their advertised consent/sandbox boundaries. (Locked; see also skills.)
  - **Amendment (2026-09-17, Andrew; `agent/runaway-breaker`): the per-DAY spend cap ships ON at
    $25 as a SOFT rail.** A customer's full-access loop ran 98 overnight passes re-confirming
    files existed and burned ~$98 with every cap at 0. The rail is not a usage wall: hitting it
    ends the run with reason `budget`/`day`, the Budget panel offers one-click RESUME (+$25
    headroom), the value is editable, and saving 0 turns it off. Unmetered (OAuth/subscription)
    runs never touch it. Per-run, per-agent and global caps still default off
    (`sidecar/budgetcaps.js` SHIPPED_DEFAULTS) — **one exception (Andrew, 2026-09-30, GitHub #53):** a run on
    StarNet credits with no per-run cap chosen reserves (and may spend) at most $2 (`managedRunCapUsd`,
    `SKYNET_BUDGET_MANAGED_PER_RUN` overrides it), because one simple prompt drained a $10 wallet. A per-run
    cap the user saves above 0 always wins; own-key and subscription runs are unaffected. Paired with the LOOP stall breaker: a loop whose
    passes change nothing (no file, no commit, no findings, or the same report again) parks
    itself `paused` after 3 — the ledger decides, never the model's mood. **Confirmed for merge by
    Andrew on 2026-09-23** ("merge the runaway breaker"); per-run loop detection in `sidecar/loop-breaker.js`
    (Hermes-gap Step 2) is separate and is not a quota. **Strict vs soft (2026-09-23):** a cap someone CHOSE (env or a saved Budget value) stays fail-closed when spend history is uncertain (test/spend-authority.http.test.js); the shipped $25 default is SOFT — after a crash leaves unsettled spend it cannot be enforced, so it proceeds instead of refusing every paid run, and the Budget panel shows the day spend as unknown (sidecar/budget.js strictScope).
- **FULL POWER MEANS THE WHOLE LOCAL COMPUTER** (2026-08-14, Andrew; supersedes every older
  Full-Access/hard-floor/desktop-lease limitation). Per-agent Full Access and the station-wide
  master bypass are host-minted scopes of one general authority: StarNet must project every
  available capability and must not block host paths (including `.env`/`.git`), arbitrary host
  commands, visible apps, or physical screen/input control. Do not build niche request allowlists;
  the unrestricted host executor is the general route. Schema/input validity, timeouts, output
  caps, checkpoints, truthful telemetry, OS account privileges, elevation prompts, credentials,
  unavailable hardware, and disconnected external services remain real engineering/runtime facts,
  not StarNet permission denials. ASK and narrower execution modes remain restricted as labeled.
- **Truthful telemetry is THE core law.** The app must never assert state the harness can't
  prove. Object = capability: a prop in the world is a real grant, not decoration. Tool
  surface must never exceed wired reality.
- **Eerie-not-cute** tone. A living pixel-art station doing REAL work.
- **Deliverable = OPEN, not read** (2026-07-04). The payoff action on a finished work card is
  opening the runnable artifact, not viewing source. View-source is demoted.
- **Engagement = the daily loop adapting to the user — NEVER a gauge/score UI.** (North Star.)
- **Model is a roster property, never per-chat** (2026-07-03). /model and the model dock act
  on the agent, not the conversation.
- **Specialists own only their desk.** All other props are station-shared via the overseer.
  Never build per-agent prop kits.
- **Skills = HOW, Recipes = WHAT, Routines = WHEN.** Marketplace framing; meter compute, not
  recipes (open-core).
- **The Skill Market is curated, hosted on starnetos.com, originals first** (2026-09-29, Andrew: "all
  recommended"). D1 the catalog is static files on starnetos.com (Cloudflare Pages), never the
  starnet-cloud money server; D2 a catalog skill whose downloaded bytes reproduce the catalog's
  pinned digest installs in ONE click at the curated (`trusted`) tier — the local guard scan still
  runs and a dangerous finding is still refused; D3 installs land in the station SKILL LIBRARY, not
  one agent; D4 StarNet Originals lead the catalog, then credited community picks; D5 the bundled
  library stays, the market is its update channel and the only home for new skills. Community
  publishing waits for a review queue. Plan: https://claude.ai/artifact/HuPtbuXdPrQC3xBVKVf79f
  **Trust (2026-09-29, Andrew: "go for it"):** the catalog and the pulled-skills list are signed
  with an Ed25519 key that lives only on the publisher's machine (never the website, never the
  repo); the app ships the public keys (a working key + an offline backup) and refuses unsigned,
  mis-signed or older-serial documents. The market can PULL a skill (skills-catalog/revoked.json):
  stations with market skills installed re-read the signed pulled list every few minutes and switch
  it off. Market packages are text only — SKILL.md, a license, plain-text references/ — and the app
  enforces that rule itself, not just the build. Serials are tracked per catalog, the app ships a
  minimum official serial (market-floor.json, pinned after each catalog deploy), and bundled
  originals carry their own `version:` so the newer of built-in and market copy is the one used.
  Every skill also downloads from starnetos.com/market.html as a standard Agent Skills .zip.
  **Uploads (2026-10-06, Andrew: "time we allowed uploaded skills"; the plan's recommended options,
  taken as defaults, his to change):** anyone with a (free) StarNet account submits a SKILL.md + up to
  five text references on account.starnetos.com › ACCOUNT › SKILLS, reached from SHARE YOUR SKILL on
  market.html; the author picks MIT or CC BY 4.0 and a plain-text credit; a name belongs to whoever
  first submitted it. Every upload waits for a PERSON in /admin/skills (approve, or send back with a
  note the author sees). Approving publishes nothing: `scripts/pull-skill-submissions.mjs` pulls
  approved packages onto the publisher's PC with its own token (SKILL_REVIEW_TOKEN, never the
  credit-minting ADMIN_TOKEN), the normal catalog build scans and signs them there, and they go live
  with the next website deploy. Uploads sit on the community shelf, marked `uploaded`, so older apps
  read them like any community skill. Runbook: docs/SKILL_MARKET_UPLOADS.md.
- **Connectors OUT > channels IN** (two-axis framing, 2026-07-06). Google Workspace is a
  connector, not a messaging channel. Curated one-click MCP catalog is the chosen path for
  "more connectors"; paste-a-key tier is bearer-only-honest; OAuth 2.1 generic client is live.
- **Monetization:** BYOK free forever + resold-AI (managed-key starter credits) as the single
  revenue rail. One SKU. (Roadmap 2026-07-04.)
- **Growth thesis:** spectacle/watchability is the long-term growth engine (clips, postcards).

## Visual / world (see starnet-frontend-law skill for the full set)

- **Hover = tiny nameplate glance, never a window.** Canvas text = VT323 + phosphor glow.
- **Couch = sofa BACK view + sitter y-sort seatPy+1** (2026-07-03, 8dad4503). Never revert.
- **Sprites:** Pixellab, not Sprite AI. Author chunky ~48px; smooth-downscale the 92px master
  in drawBody — never NN-crush. Foot-shadow anchors agent FEET to the floor line (215132a).
- **Props are on the v3 LOCKED STYLE LAW** (2026-07-02, 7738419).
- **Music is REMOVED by design** (2026-07-04, e6d74bab). audio.js is a sound Director only;
  SFX = one console voice. Never re-add music unasked.
- **CRT look is BOLD not subtle**; iterate via `?crtlab=1` and copy values out.
- **The OS paints NOTHING in StarNet** (2026-07-27, Andrew). The corollaries of the control law
  below, for the other two surfaces the user agent will draw if nobody stops it: **no renderer-native
  dialog** — `window.confirm/alert/prompt` is an OS modal over the phosphor terminal; arm through
  `ArmConfirm` (that helper exists for this) or use a station panel. The sole exception is a
  **host-boundary security confirmation** for a renderer-callable OS launch: the host may show a
  blocking native prompt only when it names the exact canonical target + action, remembers nothing,
  asks on every call, and Cancel cannot fall through to another launch path. Renderer UI cannot mint
  that proof; this exception is never reusable for ordinary product confirmation. **No native tooltip** —
  `frontend/app/tooltip.js` adopts every `[title]` into `[data-tip]`, removes the attribute, and
  draws the station's card; `data-no-tip` opts an element out when it owns a richer tip. Both
  locked by `test/station-tooltip.test.js`.
- **NO white HTML controls, ever** (2026-07-27, Andrew — reported for the third time). A
  control that renders with the browser's own paint (buttonface white, ButtonBorder grey,
  black Arial, OS-blue tick) is a BUG, not a detail. `frontend/css/app.css` carries a
  **CONTROL FLOOR**: element-level rules that repaint every native control from theme vars, so
  forgetting a surface class can no longer ship an OS-chrome control. The floor must STAY a
  floor — element-level selectors only, no geometry on the shared button rule — or it starts
  overriding real skins. Locked by `test/control-floor-theming.test.js`.
- **COMMS beats:** decided cards must `vanish()`; ONE post-run beat at a time; gold-inset
  beat family (no `.reply` for asides).
- **Per-agent spoken voices** (2026-09-06, Andrew). Supersedes the single station-voice
  restriction: the Commander may assign different built-in voices to stable agent IDs in
  Settings → Live Voice. Unassigned agents retain existing station behavior. Assignments
  apply to spoken direct replies and hands-free; each agent's selected identity and serving
  engine remain pinned during a live call. Personality still controls the words independently.
  Voice preferences are local to the app/browser, matching the existing station voice picker.
  PACE-WORD LAW and the /api/tts 200-always contract remain unchanged.

## Engineering / process

- **`npm start` (:8787), never `npm run serve`** (dead, UI-only path).
- **One process, one runOnce loop, U.bus frozen events** (see starnet-backend-law).
  `shared/events.js` + `shared/schema.js` are owned; changes additive-only, by request.
- **Rebrand:** Skynet → StarNet (2026-06-22) on all SHIPPED surfaces; internal `skynet.*`
  keys/schemas/env vars intentionally kept — do not "finish" the rename.
- **the reference harness branding stripped from shipped surface** (2026-07-04); attribution lives in
  NOTICE.md (MIT — keep it). The `ref-proven` QA enum is kept on purpose.
- **Reflection mints FACT/PREFERENCE only, never SKILL.** Asks are WORK-EARNED (3 task-runs
  floor), study 1/session. Never regress the earn gate.
- **Awakening/interview questions must be concrete + targeted** — never "what does good look
  like"; the pain-question is the template.
- **Fill gaps by research, don't ask.** Only genuine product forks go to Andrew.
- **Delegation:** implementation agents run on Opus; the orchestrator session briefs,
  merge-gates, and never shotgun-codes across lanes.
- **Codex branches: merge, never rebase.** Claude is the merge gate; grep symbols after every
  hotfile merge (29-hotfile no-touch set — see starnet-merge-ritual).
- **Desktop architecture truth:** the installed app's webview loads the frontend COMPILED INTO
  THE EXE (tauri.localhost). Folder patches never touch the installed UI; CDP-attach is the
  only installed-UI proof. Updater feeds from GitHub Releases (`starnet-releases`).
- **Open-source validation boundary:** TPM, fixed-VHDX, anti-admin, LocalSystem proof-broker,
  and protected-CAS machinery were never product requirements; W0 identifies exact official,
  reproducible-source, custom, and dirty-dev builds without trying to defeat the machine owner.
- **Release gate order:** gate runs AFTER version bump, BEFORE tag push (v0.2.0/v0.2.1 were
  burned proving this).
- **QA baseline suppression:** known defects live in `qa/KNOWN_ISSUES.md` fingerprints; the
  ledger refuses re-filing. Retire a row only when the fix lands.
- **The READY claim is machine-gated** (2026-07-07, EL-7). No session, report, or doc may claim
  StarNet is "ready", "perfect standing", or "go-public-able" without pasting a fresh
  `npm run qa:ready` receipt alongside the claim. `qa:ready` (`scripts/qa/ready.mjs`) prints ONE
  verdict — `READY` or `NOT READY — <numbered reasons>` + a per-check receipts block — and exits 0
  only when READY. It gates on five real artifacts: ledger open P0/P1 == 0 · Green Guardian last
  cycle GREEN + fresh (≤24h) + on the current trunk head · qa:journeys last run pass · Beginner Run
  not STUCK/FAIL · installed-exe smoke stamp GREEN + fresh (≤7d). No-fake-green: any check that can't
  run (missing/unreadable artifact, git failure) is NOT READY, loudly — never a silent pass.
  **Lane-level done stays lane-level:** an agent may say "lane X verified"; station-wide status is
  whatever `qa:ready` says, nothing more. Why: session after session reported lane-green as
  project-green while the Guardian sat RED with open findings — the aggregate claim was never gated
  on anything. Now it is.
  **Authority clarification (2026-07-10, W0):** `qa:ready` is the limited release-readiness
  aggregate defined by those five checks. A READY receipt does **not** prove that every product
  promise, UI surface, or backend implementation is perfected, and it must never be reported as
  `PRODUCT PERFECT`. That exact terminal verdict is reserved to `npm run qa:product-perfect` after
  every candidate-bound wave W0–W7 passes. Neither verdict authorizes publishing, deployment,
  credential rotation, or any other external release operation; those still require the owner's
  explicit authorization.
