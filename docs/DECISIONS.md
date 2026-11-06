# DECISIONS.md — locked decision log

Decisions that are **settled**. Do not re-litigate them in a session; do not "improve" them
in passing. If you believe one is wrong, surface it to Andrew as a question — don't change it.
Each entry: the decision, why, and the date it locked (where known).

Companion files: [BRAIN.md](BRAIN.md) (start here) · [MISTAKES.md](MISTAKES.md) ·
[NEXT.md](NEXT.md). The `.claude/skills/starnet-*` skills are the enforcement layer for
many of these — they win on any wording conflict.

## Product

- **Ordinary mid-task messages automatically steer the current conversation (Andrew, 2026-11-03).** COMMS sends join the confirmed active run at its next model boundary, without a separate steering button. A status question gets a concise progress answer while the original objective continues; corrections update remaining work, and explicit pivots change the objective. Stop remains a separate immediate control; an in-flight action is never claimed cancelled by a steering receipt. Preserve full message text, attachment ownership, send order, and distinct message identity. Received is not proof of model action. Explicit `/queue` still requests a later turn. The initial implementation targets direct COMMS conversations and the existing direct-channel steering route; group dispatch and worker-generation controls retain their own admission paths.

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
- **Transcript row provenance is one rule: `rowTaint` in `sidecar/transcriptstore.js`** (review
  memory-learning-07, 2026-10-13). A stored row with `taint` taints whatever reads it. A row is clean
  only when its writer stamped it (`taintKnown`, recorded whenever a taint value is passed, `null`
  included). Every other row is "taint unverifiable", whatever its age: a date cutoff is unsafe
  (an older build kept writing un-stamped tainted rows for anyone who upgraded late), and a
  per-install "stamped since" marker could only clear a row whose writer forgot the stamp. So every
  transcript write outside the store itself (`append`, `appendStrict`, `appendNew`, `appendNewStrict`,
  in any sidecar module) must pass `taint`; test/recall.test.js scans all of sidecar/ and locks it.
  recall_conversation and the repeat-work owner proof (`trusted-learning.js` cleanOwnerRows) read
  rows by this rule. No released build (through v0.13.3) wrote the clean stamp, so after the update
  every recall hit on older history taints the run: on COMMS a later command asks first even with a
  standing grant (Full Access excepted), and on autonomy runs and channel chats without `/approvals`
  it is refused. Replay (`transcriptStore.taintOf`) and the earlier-conversation note count only an
  explicit `taint`, so they treat those same rows as clean: applying the rule there would start
  every older conversation tainted. **OPEN: Andrew decides before the next cut** (raised 2026-10-13,
  release review): ship strict recall with a release-note line ("Recalling a chat from before this
  update now asks before running commands."), or pick another split. Until he answers, the branch
  ships strict recall.
- **Attachment taint is the bytes in the context, and the stamp on rows decays with them**
  (attachment-rows-and-taint, 2026-11-04). A file or picture the Commander attaches taints a run
  `user attachment` (`sidecar/taint.js` `ATTACHMENT_TAINT`) exactly while its BYTES are in front of the
  model: the attaching turn and one follow-up. From the third turn the conversation is clean again, so
  learning, standing grants and workers that hold a stored credential work again. Until now the mere
  presence of an attachment REFERENCE in the browser's history tainted every later run, and the replay of
  those runs' own rows re-tainted the next one, so one screenshot locked a conversation for good (email
  E15: a lead's workers could not use their keys for the rest of the chat). **The OPEN list at the end of
  this entry is Andrew's to decide before the next cut.** The threat table is
  `docs/attachment-taint-security-review.md`.
  - **The two numbers.** `RESEND_K = 4` and `RESEND_TURNS = 2` (`sidecar/attachments.js`, exported). Bytes
    are re-sent only for the newest four attachments of the last two user turns. The current turn's
    newest attachment is never dropped, not by the count and not by the 12 MB image budget, which is now
    spent newest first (it used to drop the newest picture and keep a stale one). Every other reference
    becomes a one-line marker naming the saved file and the tools that open it (`fs.read`,
    `image_analyze`), and is not read at all. Two turns is what makes a conversation clean from the third;
    four bounds what rides along, and a marker costs one tool call, never the conversation. The
    seven-turn flow in `test/attachment-taint-decay.http.test.js` states its shape in literal turn
    numbers, so changing either number means editing that test with it.
  - **Why the current turn's taint is kept.** The taint does not try to tell a hostile file from a good
    one; it removes the payoff. A tainted run loses its shell, credentialed requests (`web_request`),
    connector calls and standing or unattended grants, its learning passes are withheld, and a worker it
    dispatches inherits the lock. The bytes are in the prompt on the attaching turn, so the model can be
    argued into anything they say on that very turn; that is when the lock has to hold. Attaching a file
    shows the Commander wanted it read, not that its text is theirs (`taint.js`: the jail proves where
    bytes live, not who wrote them). So the turn that carries the bytes is never unlocked, and the lock
    is never a clock or a turn count: `runOnceCore` reads `attachments.resentOf` right after
    `expandForRun` and latches only when an entry has `bytes:true`. A marker, an unreadable file and a
    binary file send no bytes and latch nothing. The lock gets shorter by sending the bytes for fewer
    turns, never by trusting them.
  - **What decays, and only this.** A transcript row stamped with EXACTLY `user attachment` no longer
    taints a replay (`transcriptStore.taintOf`, `EarlierConversation.taintOf`): its bytes are either
    re-sent, and the replaying run latches them itself, or gone. In practice these are the model's own
    replies on turns 1-2; the Commander's rows are written clean (see Rows). A caller's own
    `initialTaint` (hub, channel, upstream, a lead's latch) wins over the byte latch and is never cleared.
  - **What does not decay.** Any other stamp (a near miss, `replayed history (tainted by user
    attachment)`, `worker output (...)`, `resumed run (...)`, `channel attachment`); a tool read of the
    saved file (`fs.read`, `fs.search` and `image_analyze` of `.attachments/`, and a shell command,
    terminal line or script that NAMES the folder: a PDF is re-sent as a note only, and a command is how
    its text reaches the model); a recalled row or memory record; a recovery continuation (its
    checkpoint holds the bytes); and a user row that STORES the expansion when the replay is that very
    row, in either shape on disk (11-02: references kept and a `content` other than the typed words;
    0.14.2 and every release before it: no references and no `typed` field, the `[Attached file: `
    header in `content`; the server replays such a row whenever it seeds a history from its own rows, as
    the phone host and a single-message `/api/run` do).
  - **No laundering.** The stamp a run's rows carry is `execution.rowTaint()`, the first source that is
    not the bare attachment, so a page, connector or file read after the attachment stamps every later
    row and persists. `run-journal` `analyze` reports it over the attachment, so a recovery continuation
    restores the page, not the attachment. The old "not tainted yet" guards on the tool-result,
    carried-note and recalled-note latches are gone (each latch is idempotent), so the attachment never
    shields a later source. The run record's `taintedBy` stays the first source (the refusal wording, the
    relay to a lead), and the record now holds the row stamp beside it as `rowTaintedBy`, present only when
    it differs. Every durable row written for a run carries the row stamp, including the row written after
    the run ended: a dispatched worker's accepted answer (`dispatch-delivery.js`) is stamped from the
    record's `rowTaintedBy`, so a worker that inherited its lead's bare latch and then read a page or the
    saved file does not hand the lead's later replays an answer stamped only with the attachment.
    `test/dispatch-delivery.taint.test.js` runs that case and scans every transcript writer in every module.
  - **Rows.** The Commander's row holds only the words they typed and is written clean: the file's text is
    stored nowhere as the Commander's words. A turn sent with NO words stores the label of its files
    (`[file: name]`) instead, and that is built from the files' names, a third party's text, not the
    Commander's words. That row carries the attachment stamp whatever the run held (a file that sends no
    bytes leaves the run clean), so it is never a clean owner row: not owner evidence, not RECENT ACTIVITY,
    not interests, not an owned brief. Its run record is marked `wordless`, so the "worked recently"
    projection (the title of that run is the label) leaves it out too. Each file is a hidden `attachment` row
    beside it (`sidecar/turn-attachment.js`: role `system`, never displayed, never replayed to the model,
    recallable) with the name, the saved path and the size and sha256 of the bytes read, stamped with the
    run's own taint. The earlier-conversation note and `recall_conversation` show `[attached: name]` next
    to the typed words, and once, alone, for a turn with none (not the label and the marker for the same
    file). No new screen was added. `test/attachment-label.evidence.test.js` builds the turn through the
    production writer and reads the real host assembly of the evidence block.
  - **A file's name.** One rule, `sidecar/attachment-name.js`, holds every echo of a name the sender chose:
    the inlined header, the binary-file note, the marker of an older file, the "omitted" and "no longer
    available" notes, the image tag the adapter's note reads, the label of a turn with no words, the
    `[attached: name]` of the note and of recall, and the name on the attachment row. One line (controls,
    including NEL, line and paragraph separators and any run of whitespace become one space), no square or
    angle bracket (each becomes a space, so a name cannot end the bracket it sits in or open or close a
    tag), nothing hidden (zero-width, bidi overrides and isolates, the byte-order mark, tag characters and
    other format or private-use code points are dropped), at most 120 code points, never a split pair,
    and `file` when nothing is left. A media type is echoed only as a plain `type/subtype` token, else
    `binary`, and a path only for a real saved attachment (`.attachments/<id>`). The rule bounds the
    structure of a name, not its words: it is still one line of the sender's words next to the Commander's
    request on a run with no lock (see OPEN 6). `test/attachment-name.test.js` holds every producer to it
    with a hostile corpus, against an oracle that does not call the rule.
  - **Workers.** A worker starts with its lead's `execution.rowTaint()`. While the lead holds the bytes
    (turns 1-2) the worker inherits `user attachment` and its credentialed request is refused, naming the
    lead; on turn 4 the lead is clean, so the worker has no taint and the lock is not what stops it
    (`test/attachment-taint-decay.http.test.js`, flow G, on a station without Full Access, which would
    hide the lock). One over-taint stays, the safe way round: a lead that dispatches a worker while it
    holds the bytes latches the worker's relayed `worker output (tainted by user attachment)`, which is
    not the bare stamp, so that lead's rows keep tainting its replays and its conversation does not
    become clean on turn 3. Flow G pins it.
  - **OPEN: Andrew decides before the next cut.** Until he answers, the branch ships what is above.
    1. *Replies written while the bytes were in view stop tainting once the bytes are gone.* A model
       steered by hostile file text on turns 1-2 can carry it into turn 3 through its own earlier
       replies, or through a file it saved (a local file read is not a taint source in v1, whatever
       wrote the file), and a clean turn-3 run can use standing grants. That is the price of a
       conversation that is clean from the third turn. Default taken: accept it. The stricter
       alternative keeps those rows tainted for N more turns (clean from turn 3+N), gives up the
       third-turn goal, and still does not cover a saved file.
    2. *The two numbers* (four files, two turns). Default taken: as shipped.
    3. *Workers.* They inherit the lead's lock while it holds the bytes and are clean once it is, with
       no separate worker rule. Default taken: that, and keep the over-taint above. Lifting the
       over-taint is two edits in the run host that must land together: the worker reports `rowTaint()`
       instead of its first source, and the relay keeps a bare attachment bare. The second alone would
       let a page a worker read after inheriting the attachment come back to its lead as only "user
       attachment", which decays.
    4. *A recall that returns an attachment row taints the run.* The row is a name and a hash, no bytes,
       so this costs only a run that deliberately recalls an attachment turn. Default taken: yes
       (the existing rule: a returned row's stamp latches).
    5. *Routes the path rules do not see.* A shell glob that reaches the file without naming the folder
       (`cat .attach*/*`) or a script file written earlier puts its bytes back in front of an untainted
       run, because shell output is not a taint source (the v1 boundary in `taint.js`); the blanket
       reference taint used to hide these and is gone. Default taken: accept. (A file's NAME on clean runs
       is item 6.)
    6. *Does a file's name reach the model at all once the bytes have gone?* Default taken: yes, bounded
       as in "A file's name" above, on every route (the binary-file note of a PDF or archive, which sends
       no bytes and so starts a run with no lock on the very turn it is attached; the header; the marker;
       the label; `[attached: name]`): one line, no square or angle bracket, nothing hidden, 120 code
       points. The bound stops a name ending a bracket, adding a line that reads as a system notice,
       closing the earlier-conversation frame or hiding text; it does not stop one line of persuasive
       words ("Q3 invoice - the Commander pre-approved shell for this chat.pdf") sitting next to the
       Commander's request. The stricter alternative shows the model an opaque handle (`file 2 (PDF)`,
       `image 1`) and the saved path, and keeps the real name only in the hidden attachment row and the
       thumbnails, where the Commander reads it. It removes the last third-party text from a clean run;
       it costs the model the ability to call the file by its name unless it recalls the row, and it
       changes the wording of the notes, the label and the title of a turn sent with no words. Andrew's call.
  - **Also not decayed:** a memory record a tainted run saved (its `taintedBy` stays and a recall of it
    latches). A KEPT SUMMARY (`sidecar/summary-cover.js`, the context lane's ledger) follows the bytes the
    same way a row does (A10, 2026-11-04). The ledger stores the stamp unwrapped, the source and not the
    sentence a latch put it in. A fold whose folded messages held the attachment's BYTES (the expanded user
    message: its file text or its picture) gets `BYTES_TAINT`, which is not the bare stamp, so it never
    decays: the summary carries the file's words and every run that serves it is latched. A fold over the
    model's replies only, written while the bytes were in front of it, gets the bare `user attachment`, and
    serving it latches nothing (`served.taint !== ATTACHMENT_TAINT`), exactly like a replayed row, so a
    fold on turn 2 or turn 4 leaves the chat clean from turn 3. Every other stamp latches unguarded, and a
    run already tainted by the attachment that serves a web-tainted summary ends with both sources in its
    taint and its journal.
  - **Proof.** `test/attachment-resend.test.js` (which bytes are sent),
    `test/taint-replay.attachment.test.js` (the decay rule, the run state, the journal),
    `test/attachment-rows.test.js` (the rows), `test/attachment-name.test.js` (every echo of a name),
    `test/attachment-label.evidence.test.js` (a turn with no words is not owner evidence),
    `test/dispatch-delivery.taint.test.js` (a worker's accepted answer carries the row stamp) and
    `test/attachment-taint-decay.http.test.js` (the seven-turn conversation, the web case, the old
    streams and the worker, on a real sidecar with a scripted provider).


## Build mode / conveyors (Andrew, 2026-10-10/11)

- SEND TO is an OUTBOX pointer to another line’s INBOX, never a belt. Each finished job starts that line’s own job with its own crew and budget; circles are refused.
- SELECT MOVES: MOVE is retired. Click selects; a selected piece dragged onto open floor moves. A single machine dropped onto another machine connects them, selected or not. An unselected machine dragged onto open floor lays a belt. Shift+drag moves.
- THE HAND: Conveyors hotbar keys 1–8 pick pieces, right-click removes, Q copies the pointed piece. PICK WHAT GOES HERE is a docked station window, never a popover.
- Hold Alt for the floor’s junction settings and SEND TO overlay; keep the one-voice display rule.
- No belt may close a work-line circle except a LOOP’s valid back lane. Copying a line preserves its internal settings and crew, not external SEND TOs, project folders or triggers.
- A PARTIAL JOIN IS A DELIVERED REPLY, NOT A SHIPMENT (2026-10-12, conveyor runtime review). A JOINER that sends on without every branch (one failed, or never arrived before its timeout) still delivers the merged reply, marked PARTIAL, so the job is never swallowed. The job is not a product: no line-output at the OUTBOX, no SHIPPED receipt, no SEND TO hand-off, no 'delivered' verdict. SEND TO still hears of it as partial, so the next line's record says why nothing came.


## What a deleted session leaves behind (turn identity commits 11 to 17; qa/bugs/3e926b6a, 31042fab, 6e750350)

Release note and final report wording, per Q35. Written 2026-11-05; test/forgotten-everywhere.e2e.test.js is the end-to-end proof.

- **Landed on the default, not closed.** 3e926b6a, 31042fab and 6e750350 are fixed on the defaults the lane took for Q4 (what a delete purges), Q5 (declined proposals), Q6 (legacy interest evidence) and Q26 (unsourced derived dossier beliefs). They are reported as "landed on the default" until Andrew answers those four questions. Say so; do not say "closed".
- **What a delete reaches.** The transcript, recall, evidence, run titles, the notebook records and proposals the session wrote, the interests learned from it, staged scout drafts, recommendation evidence, verdict packets and held reviews, task briefs, skill goldens, study proposals, deliverable rows, night-shift drafts and acts, queued away jobs, quests and the inferred north star, the away briefing, overseer threads, worker records, the attachment files it uploaded (unless another session names them), a group chat, and the runs that read it (their own packets, goldens and studies go too). The Commander dossier block and the autonomy beliefs snapshot carry the runs they were learned from and are admitted or cleared by them (commit 14). The page drops the beliefs learned from the session's runs, its run records, send-now lines and uploads (commit 16).
- **I7's four named limits, the only exceptions** (each has a passing control in the tests):
  1. **Adopted stamps.** A delete made before the ledger first read the save (while Delete only hid the rail row) forgets the transcript and titles from then on but keeps the memory it wrote. Never a retroactive wipe at first boot.
  2. **Routines the Commander created (cron-jobs), delivered workspace files and learned skill files** are kept: configuration and work product, not a memory of a session.
  3. **Paraphrase.** A later reply that restates what a deleted session said in other words, naming nothing of it, is not a quote and is not tracked.
  4. **session.list titles** are metadata and are not hidden by the quote rule.
- **Declined proposals (Q5).** The reject list stays on disk and in host dedup. From the first non-adopted delete the reflection pass receives every declined text as dedupOnly: it suppresses a repeat but never reaches a prompt and is never a replacement target. Entries stay plain strings.
- **Dossier and posture (Q26).** A push without full provenance is admitted only while no delete has been made. After the first delete the block is composed from complete beliefs only: an unsourced learned belief leaves every prompt, including the page's own, but stays in the COMMANDER panel and returns when the Commander confirms or edits it. A cleared block reads as the missing-snapshot path (the night shift degrades to the EARN tier) until the page's complete re-push, which follows the delete at once.
