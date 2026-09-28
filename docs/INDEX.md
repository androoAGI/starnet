# docs/ index

A map of the ~95 files in `docs/`. They fall into four buckets: **living reference**,
**plans & roadmaps**, **audits & QA reports**, and **release/runbooks**.

> **Code is the source of truth.** The dated audit and plan docs below capture a moment in a
> fast-moving repo — many go stale within *hours* of being written. Before acting on any claim
> that something "is missing" or "is broken," grep the current code and re-prove it. Treat these
> as history and intent, not as the current state of the build.

---

## Living architecture / subsystem reference

The docs closest to "how the thing is shaped." Still dated in spirit, but these describe
durable structure rather than a one-time task.

- **BRAIN.md** — 5-minute orientation for any session opening the repo; the fastest on-ramp to
  StarNet's core concept (local-first AI-agent harness rendered as a pixel-art station).
- **HARNESS_ARCHITECTURE.md** — engineering reference for the sidecar/backend: the target
  module map and the event contract each build step works toward.
- **harness-runtime-spec.md** — the build spec for the sidecar runtime, layered on the frozen
  event bus.
- **DECISIONS.md** — the locked decision log: settled product/architecture choices that should
  not be re-litigated.
- **MISTAKES.md** — recurring failure patterns and hard-won gotchas specific to this project.
- **EXECUTION_BACKENDS.md** — how workbench tools execute through a single environment boundary
  (local vs sandbox modes).
- **CLAUDE_CLI_PROVIDER.md** — the `claude-cli` brain: how the local Claude Code CLI runs a turn with its own
  tools off, how Stop/timeouts work, and how its cost is booked.
- **MEMORY_AND_CONTEXT_PLAN.md** — the layered design of Cortex, the agent memory + context
  engine (plan, but the reference for how memory is shaped).
- **v7-subsystem-analysis.md** — auto-generated audit of the v7 codebase to decide what to
  reuse vs rebuild (dated 2026-06-13); explains the lineage of the ported engine.
- **NEXT.md** — the living task queue, reconciled against trunk (updated as items land or are
  invalidated).

Other reference/design docs (subsystem analyses and design proposals):

- `builder-pillar-designs.md`, `design-proposals.md`, `rpg-layer-design.md` — design proposals.
- `BUILD_SYSTEM_V2.md`, `DOWNLOAD_PAGE.md` — build-system notes and the product landing copy.
- `raw-builder-foundation-output.json`, `raw-harness-runtime-output.json` — raw generation
  outputs kept for provenance. (`raw-workflow-output.json` was removed: it was an unreviewed
  224KB dump that quoted a specific credit markup rate, which does not belong in a public repo.)

## Plans & roadmaps

Forward-looking design + build-order docs. Each states intent for a subsystem or a sprint; grep
trunk before building any item — half- or fully-shipped versions often already exist.

Subsystem / feature plans:

- `MESSAGING_INTEGRATION_PLAN.md`, `MESSAGING_POLISH_BACKLOG.md`, `CRON_INTEGRATION_PLAN.md`,
  `CONNECTORS_MCP_PLAN.md`, `VOICE_CHAT_PLAN.md`, `VOICE_PHASE2_PLAN.md`,
  `RECIPE_MARKETPLACE_PLAN.md`, `SKILL_PARITY_PLAN.md`, `CLASS_LOADOUTS_PLAN.md`,
  `PERSONALIZATION_PLAN.md`, `TUTORIAL_ONBOARDING_PLAN.md`, `MEESEEKS_SWARM_PLAN.md`,
  `PROPS_PERIPHERY_PLAN.md`, `COMMANDER_DOSSIER_PLAN.md`, `SELF_TEST_STATION_PLAN.md`,
  `SUMMON_FIXES_PLAN.md`, `WARROOM_BUILD_PLAN.md`.
- Autonomy / crew / world plans: `AUTONOMY_DRIVER_PLAN.md`, `AGENT_SENTIENCE_ROADMAP.md`,
  `WORKFORCE_SENTIENCE_PLAN.md`, `WORKFORCE_ZONES_PLAN.md`, `TIER_D_LIVING_CREW_PLAN.md`,
  `CREW_AWARENESS_PLAN.md`, `ORCHESTRATOR_CONTROL_PLAN.md`, `GROWTH_LOOP_PLAN.md`,
  `NORTH_STAR_UNDERSTANDING_PLAN.md`, `GAME_SESSION_PLAN.md`, `EXECUTION_SPINE_PLAN.md`,
  `CONVEYOR_PIPELINE_PLAN.md`, `CONVEYOR_PHASE_B_STATE.md`.
- ref-parity program (design + loop workflow): `REF_HARNESS_INTEGRATION_PLAN.md`,
  `REF_HARNESS_PARITY_PLAN.md`, `REF_HARNESS_PARITY_LOOP_WORKFLOW.md`,
  `STARNET_REF_REPLACEMENT_LOOPS.md`, `STARNET_REF_REPLACEMENT_PHASE2.md`,
  `STARNET_REF_REPLACEMENT_PHASE3.md`, `STARNET_REF_REPLACEMENT_PHASE3_SEAL.md`,
  `STARNET_REF_REPLACEMENT_PHASE4.md`.
- Hardening / release-train plans: `ROBUSTNESS_HARDENING_PLAN_2026-07-04.md`,
  `INSTALLER_REBUILD_0.1.0_PLAN.md`, `RELEASE_TRAIN_BUILD_PLAN_2026-07-06.md`,
  `FULL_RELEASE_POLISH_PLAN.md`, `POLISH_SPRINT_2026-07-06.md`, `ROADMAP_2026-07-04_BRUTAL.md`,
  `FABLE_MARCHING_ORDERS_2026-07-03.md`, `AWAY_WORKSHOP_PLAN.md`.
- Session/loop & task packs: `STARNET_SESSION_LOOPS_1_6.md`, `STARNET_BUG_FINDING_LOOPS.md`,
  `STARNET_DOGFOOD_TASK_PACK.md`, `STARNET_PHASE5_REF_WORKLOADS.md`.

## Audits & QA reports (dated, historical)

Point-in-time findings. **These go stale fastest** — read for what was found and how it was
reasoned, never as the current state.

- **GROUND_UP_AUDIT_2026-07-06.md** — a full ground-up audit (most recent broad sweep).
- `HOSTILE_QA_2026-07-04.md`, `UX_CONFUSION_AUDIT_2026-07-04.md`, `UX_FIX_PLAN_2026-07-04.md`,
  `SETTINGS_GAP_AUDIT_2026-07-01.md`, `SHIP_READINESS_2026-07-02.md`,
  `GAME_WIRING_AUDIT_2026-07-01.md`, `SAFE_CELL_AUDIT.md`, `UPDATE_PIPELINE_AUDIT_2026-07-06.md`,
  `UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md` — dated audits.
- Hardening trackers (fix logs with threat models / adversarial tests):
  `SECURITY_HARDENING.md`, `PERSISTENCE_HARDENING.md`,
  `LAUNCH_HARDENING_CHECKLIST_2026-07-04.md`.
- Phase-proof evidence, baselines & templates: `STARNET_PHASE4_BASELINE.md`,
  `STARNET_PHASE4_REF_BASELINE.md`, `STARNET_PHASE4_ATTENDED_EVIDENCE_TEMPLATE.md`,
  `STARNET_PHASE5_EVIDENCE_TEMPLATE.md`, `STARNET_T0_CLEAN_INSTALL_PROOF.md`,
  `STARNET_T1_SIGNING_LOOP.md`, `STARNET_T3_RELEASE_SMOKE.md`, `STARNET_T4_UPDATE_DELIVERY.md`,
  `STARNET_T5_PUBLIC_DISTRIBUTION.md`, `PLAYTEST_SCRIPT_GATE5.md`, `GATE_HANDOFF.md`.
- Contract requests: `SKILL_EVENTS_CONTRACT_REQUEST.md`.

## Release / runbooks

Operational procedures for cutting and shipping a build.

- **RELEASE_RUNBOOK.md** — the solo release procedure, step-by-step commands and clicks.
- **LAUNCH_CHECKLIST.md** — one-page status tracker of public-facing artifacts and release-day
  readiness.
- **STARNET_UPDATES.md** — how the Tauri signed-update mechanism works and the user update loop.
- `LAUNCH_CHECKLIST.md`, `INSTALLER_REBUILD_0.1.0_PLAN.md` also touch release readiness.
