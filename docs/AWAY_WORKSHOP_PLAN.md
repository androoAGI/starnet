# Away Workshop — real work while the Commander is gone

**Status:** PLAN (2026-07-03, Fable). Not started.
**Product goal:** when the user returns after being away, an agent has *actually built
something* — a script, a tool, a fix, a polished artifact — in its own quarantined space,
and presents it as a reviewable deliverable the user can accept, copy out, or discard.
Not more brainstorm text. Nothing is ever auto-applied to the user's real projects.

---

## 0. Ground truth (verified on trunk 2026-07-03 — re-grep before building, docs go stale in hours)

What already exists and MUST be reused, not rebuilt:

| Substrate | Where | State |
|---|---|---|
| Per-agent jailed workspace | `sidecar/tools/builtin/fs.js` — every fs tool realpath-jailed to `workspaces/<agentId>/` (`resolveInside`, fs.js:69-81) | SHIPPED |
| Environment manager w/ local + **Docker** backends | `sidecar/environment.js` (backend selected via config/env, :142, :319-333; per-agent workspaceRoot; auto-checkpoint before execution) | SHIPPED |
| Consent ladder ("silence is not consent") | `sidecar/permissions.js:81-104` — autonomous writes default-deny (:97), autonomous execute HARDCODED deny (:92, tier 2.5) | SHIPPED |
| Danger-key grant store (session/permanent/blanket) | `permissions.js` + `sidecar/permgrants.js` | SHIPPED |
| Autonomous full-office runs (cron) | `sidecar/cron-driver.js:157-161` — `runOnce` with `isTask:true, surface:'autonomous'`, full tool registry | SHIPPED |
| Goal-arc injection into autonomous personas | `sidecar/index.js:643-670` (`dossierWithGoals`) + CRON_PERSONA (index.js:300) | SHIPPED |
| `placeWorkitem` conveyor scaffold (dormant) | `sidecar/cron-driver.js:31-44` | SCAFFOLD, not wired |
| Post-run beat slot / quest log / seed shelf | frontend COMMS (one shared post-run beat slot — see comms-beat-rules) | SHIPPED |
| Work-earned ask floor (3 task-runs before proactive beats) | beat gating on trunk (beat-fat trim, 2026-07-03) | SHIPPED — never regress |

**The gap is exactly two things:**
1. No consent path lets an unattended run *write* even inside its own jail, and no path
   ever lets it *execute* — so "build" is impossible away-time.
2. No driver picks up real work during away time, and no surface presents a built
   deliverable for accept/discard on return.

---

## 1. Design principles (non-negotiable)

- **The jail is the permission.** New freedom applies ONLY inside `workspaces/<agentId>/`,
  which fs tools already provably enforce. Anything outside the jail keeps today's exact
  ladder. `.env`/`.git` hardline floor untouched.
- **User-granted, not self-granted.** The workshop is switched on per-agent by an explicit
  Commander decision ("let this agent build in its workshop while I'm away"). Silence is
  still not consent — this is a *recorded yes*, same grant machinery as today.
  It is NOT an XP grind-unlock (sandbox law: no gating walls) — it's a consent toggle,
  available from minute one.
- **Execute stays locked on the local backend. Period.** permissions.js:92 is not relaxed
  for local. Autonomous exec becomes possible ONLY under the Docker backend (already
  written in environment.js), where commands run inside a container mounted on the
  workshop dir. No Docker → workshop runs are write+review only (still hugely useful:
  code, docs, configs, drafts — just not self-tested).
- **Truthful telemetry.** The return-card may only assert what fs/run events prove:
  files written, commands run (if dockered), tokens spent. Never "I finished X" without
  a manifest pointing at real files.
- **Nothing auto-applies.** Accept = user-driven copy-out/commit. Discard = wipe the
  workshop output dir. The user's repos are never touched by the away run.

## 2. The lane, in five slices

### W1 — Workshop grant tier (backend, small)
A new per-agent flag `workshop: true` (Settings + agent dossier), wired into the consent
broker as a surface refinement: when `surface === 'autonomous'` AND the tool is
jail-scoped (`capability: 'cabinet'` or `'notebook'`) AND the agent has the workshop
grant → allow `write`. Implementation choice for the Opus lane: either
(a) pre-seed the danger keys `cabinet:write` / `notebook:write` into the agent's grant
store when the toggle flips (smallest diff, uses existing cache tier), or
(b) add an explicit `workshopOf(agentId)` injected check beside the exec lockout
(clearer intent, more honest telemetry). Prefer (b); decide in-worktree, document why.
**Done means:** a cron run for a workshop-granted agent successfully `fs.write`s into its
workspace with no human present; the same run still gets denied on `shell.exec` and on
any non-jail tool; a non-granted agent still denies everything. `test:fast` green with
new permissions tests.

### W2 — Away-work driver (backend, medium)
What does the agent build? Wire the dormant conveyor: a **workshop backlog** per agent —
sources, in priority order: (1) items the user explicitly queued ("build me X sometime"),
(2) accepted-but-unbuilt pitches/quests from the quest log, (3) the active goal arc's next
milestone when it's buildable. An away trigger (reuse cron: a per-agent "workshop shift"
routine, default OFF, armed when workshop granted) pops the top item and fires a
`runOnce` with a WORKSHOP persona: build the deliverable in `workshop/<runId>/` inside
the jail, and REQUIRE a `deliverable.json` manifest (title, what it is, files list, how
to use it, what was NOT verified). No backlog item → the shift no-ops silently (no toast
spam — away-work toasts are fallbacks, never duplicates).
**Done means:** queue an item, arm the shift, walk away; return to find
`workspaces/<agent>/workshop/<runId>/` containing real files + a valid manifest.

### W3 — Return-card deliverable surface (frontend, medium)
On next browser attach after a workshop run completed: ONE post-run beat card (gold-inset
family, shared slot, decided cards vanish) — "While you were away, <agent> built:
<manifest.title>". Expands to a two-pane viewer: manifest summary + jailed file browser
(read via existing fs read routes). Actions: **Keep** (user picks a destination folder;
sidecar copies out — interactive surface, normal consent), **Leave in workshop**, and
**Discard** (deletes `workshop/<runId>/`, records the rejection so the backlog item isn't
silently retried — reuse the denylist pattern from memory-question-overhaul).
**Done means:** live DOM round-trip — card appears exactly once, viewer shows the real
files, Keep lands them at the chosen path, Discard removes the dir and the card.

### W4 — Dockered self-testing (backend, medium/hard, SEPARATE lane, ships after W1-W3)
When `environment.js` backend is `docker`, permit `execute` scope for workshop-granted
autonomous runs — the container is already mounted on the per-agent workspace only.
Gate in permissions.js as a tier-2.5 refinement: `autonomous + execute` allowed IFF
(workshop grant AND backendId === 'docker'). Local backend behavior is byte-identical to
today. The manifest gains a `verified` block (commands run + exit codes) so the
return-card can honestly say "built AND tested" vs "built, untested".
**Done means:** with Docker running, a workshop run writes code, runs its tests in the
container, and the card shows real exit codes; with Docker absent, exec is denied exactly
as today (prove with the existing permissions test corpus extended).

### W6 — Mint ledger: agents must never re-create what already exists (backend+frontend, medium — SHIPS WITH W1-W3, separate lane)
**Bug (Andrew, 2026-07-03):** while idle, an agent minted TWO near-identical "ULTRON daily
operating loop" routines. Traced root cause: `routine.create`
(sidecar/tools/builtin/routines.js:173-240) and `POST /api/cron` dedup only on job UUID
(cron-store.js:140) — never on name; autojobs (frontend/app/autojobstore.js:122) fetches
existing jobs only to INFORM the model, never to BLOCK a duplicate POST; work quests
(workqueststore.js:36-64) have zero dedup. Same disease the memory-question overhaul cured
for memory proposals (declined ledger in memory-store.js:18-87, Jaccard near-dup guard in
reflect.js:78-142) — those patterns are the reference implementation.

Fix, three layers (server is the authority — frontend checks are UX, not the gate):
1. **Server mint gate at the choke points.** Before creating: normalize the name
   (lowercase, trim, collapse whitespace) and reject/return-the-existing-job when a live
   job for the same agent has the same normalized name (exact fp) or is a near-dup
   (reuse the Jaccard ≥0.6 guard). Apply in BOTH `routine.create` and `POST /api/cron`
   so every path funnels through it. The tool's duplicate response must tell the model
   plainly: "this routine already exists — do not recreate it" (anti-retry, like
   permissions ANTI_RETRY).
2. **Per-agent mint ledger** (persist via memory-store pattern, `minted:<agentId>`):
   every agent-initiated creation (routines, quests, workshop backlog items) records
   `{ fp, kind, title, status: created|declined, at }`, FIFO-capped. Checked before
   minting; `declined` entries never re-mint (deleting a routine the agent made marks it
   declined — the agent must not resurrect it). Ledger summary injected into
   propose-style prompts ("you already maintain: …") so the model KNOWS what exists.
3. **Frontend:** autojobstore checks the live job list before POST (skip + mark pinned
   proposal decided); workqueststore dedups on normalized title at accept.
Plus a **one-time sweep** on cron-store load: collapse jobs identical in (agentId,
normalized name, prompt) keeping the OLDEST, log what was removed — cleans up Andrew's
existing duplicates honestly.
**Done means:** force the propose flow twice → exactly one routine exists; call
routine.create twice with the same name via a scripted run → second call returns the
existing job + anti-retry message, no new store entry; boot with a hand-made duplicate
pair → sweep removes one and logs it; `test:fast` green with ledger tests.

### W7 — OPEN the deliverable, don't display its code (frontend+backend, LOCKED direction — Andrew 2026-07-04)
**The misunderstanding W3 shipped with:** the return card's file browser shows the SOURCE
of what the agent built. Wrong product. The Commander receives a TOOL — clicking it must
OPEN and RUN it, the way you'd hand someone an app, not a repo. Nobody reviewing an
away-build wants a code listing by default.

Design (ease-of-use law applies to every touchpoint):
1. **Primary card action: "Open it".** For a web deliverable (an index.html or any .html
   in the manifest) this opens the RUNNING tool in a browser tab, served from a new
   jailed static route: `GET /workshop-run/<agentId>/<runId>/<path>` — read-only,
   jail-checked via the existing fs `resolveInside`, correct content-types, accepts the
   per-launch `?token=` on GET exactly like `/api/file` (browser navigation can't send
   the header). This makes "serve the folder over localhost" (what the manifests
   themselves instruct!) a one-click built-in instead of homework for the user.
2. **Clicking a file in the list OPENS it** — .html → the served URL in a new tab;
   anything else → `POST /api/workshop/open { agentId, runId, path }`, a new
   interactive-only route that shell-opens the REAL file with the OS default app
   (Notepad/VS Code/whatever the user has). Jail-checked path; refuse on the
   autonomous surface (this is a user-click action by definition).
3. **Source view demoted, not deleted**: a small "view source" affordance per file keeps
   the existing inline reader for the users who want it. Default = open.
4. **After Keep**, offer/perform "open the folder" (shell-open Explorer at destPath) so
   the kept files are immediately in hand.
5. Workshop persona nudge: prefer self-contained, double-click-runnable deliverables
   (single-file HTML tools, scripts with a README one-liner) so "Open it" usually works
   with zero setup.
**Done means:** live proof — a real built HTML tool opens RUNNING in a browser tab from
the card's Open button; clicking a .md/.py file opens it in the OS default app; view
source still available; the open routes refuse traversal + autonomous callers; gates green.

### W5 — Polish + safety soak (last)
Budget cap per shift (token ceiling), max one shift per away period, workshop disk quota,
kill-switch in Settings, and a 24h soak with the CDP harness proving: no writes outside
the jail (fs event audit), no exec on local, no beat spam.

## 3. What this deliberately does NOT do

- No auto-commit, no auto-PR, no touching `Desktop\gen` or any user repo.
- No relaxation of the exec lockout on the local backend, ever.
- No new grind/unlock ladder — one consent toggle.
- No second beat channel — rides the existing shared post-run slot.

## 4. Cross-lane contract (PINNED by Fable 2026-07-03 — both lanes build to this)

**Ease-of-use law (Andrew, 2026-07-03):** every user-facing touchpoint must be one
obvious action. One plainly-worded toggle ("Build things while I'm away") in agent
settings — no jargon like "autonomous write grant". Queueing = a single "Build this
while I'm away" action on pitches/quests/free text. The return card = one glance to
understand, one click to Keep or Discard. No config screens, no multi-step wizards.

**Manifest** — `workspaces/<agentId>/workshop/<runId>/deliverable.json`:
```json
{ "v": 1, "runId": "...", "agentId": "...", "backlogId": "...",
  "title": "...", "kind": "tool|fix|draft|doc|other", "summary": "...",
  "files": [{ "path": "relative/to/run/dir", "bytes": 123 }],
  "howToUse": "...", "notVerified": ["..."],
  "verified": { "commands": [{ "cmd": "...", "exit": 0 }] } }
```
`verified` present only when commands truly ran (W4+); absence = card says "untested".

**Events (additive-only to shared/events.js — request via owner protocol):**
- `workshop.built`   `{ agentId, runId, manifest }` — emitted when a shift completes with a valid manifest.
- `workshop.decided` `{ agentId, runId, decision: 'keep'|'discard'|'later', destPath? }`

**Routes:**
- `GET  /api/workshop/pending` → `[manifest, …]` (undecided deliverables)
- `POST /api/workshop/decide` `{ agentId, runId, decision, destPath? }` — `keep` copies
  the run dir's files to `destPath` (interactive surface, normal consent), `discard`
  deletes the run dir + denylists the backlogId, `later` just dismisses the card.
- File contents for the viewer: reuse existing jailed fs read routes.

**Backlog (W2, per Q2 default until Andrew overrides):** explicit queue + accepted
quests only; goal-arc milestones opt-in. Store per-agent, persisted, with denylist.

## 5. Open questions for Andrew (product forks only)

1. W4 Docker: is Docker Desktop acceptable/installed on the target machine? If not,
   W4 waits — do NOT substitute an allowlisted local exec; that's the exact hole the
   lockout exists to close.
2. Default backlog source: should accepted pitches auto-enter the workshop backlog, or
   only items explicitly queued with a "build this while I'm away" action? (Plan assumes
   explicit queue + accepted quests; goal-arc milestones opt-in.)
