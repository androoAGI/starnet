---
fingerprint: 432df352
slug: saved-equipment-omitted-from-interactive-tool-pr
title: Saved equipment omitted from interactive tool projection and toolset diagnostics
surface: providers
severity: P1
status: fixed
found: 2026-09-09
lane: agent/tool-projection-0909
fix: 3c95b184fd28c5eacac8821ca2231d85da5b3395
origin: customer
report: Sanitized owner-forwarded email dated 2026-09-09
affected: 0.11.0 Windows x64; reported source 58dc520de6db835c0cf917908ee9e6a5501cba81
family: capability-projection
installer: unverified
recovery: unconfirmed
---

## September 11 engineering disposition

Engineering work closed for reproduced saved-equipment grant loss and misleading toolset diagnostics. The pre-fix qwen3:14b compatible-wire test omitted fs_write; ten real sidecar runs after repair projected the tools, wrote actual files and retained Last run/restart correlation. Installed-sidecar protocol checks and real installed file tasks passed. Actual Qwen inference and the original Trusted Project configuration remain unconfirmed. Customer confirmation is not a prerequisite for this source closure. `recovery: unconfirmed` remains unchanged, and no new installer-specific outcome is inferred. Earlier open/pending statements below are historical and are superseded by this engineering decision. See `docs/releases/0.11.2/PUBLIC_RELEASE.md`.


# Saved equipment omitted from interactive tool projection and toolset diagnostics

## Symptom

Customer reports only orchestration tools despite an available cabinet/Trusted Project UI, all-false toolset diagnostics with agentId query, and missing Last run after completed runs.

## Repro

1. Persist a station containing an INTEL CAB and an ASK agent using Station Gear.
2. Send a tool-capable /api/run request without a placed field (older or partial client).
3. Capture the Ollama-compatible request: before repair fs_write is absent despite the saved cabinet.
4. GET /api/toolsets or /api/toolsets?agentId=agent: before repair the selected profile/floor are omitted and even lead orchestration reads unavailable.

The exact reported Trusted Project failure is not reproduced: an explicitly persisted Trusted Project profile projects files in both before/after source. The saved-floor omission is a confirmed related grant-loss path, not proof of the customer's precise runtime state.

## Evidence

Before edit, test/tool-projection.e2e.test.js failed with 'qwen3:14b file projection: false !== true'. After repair it completes ten real sidecar runs with captured tool names, real fs_write results, final run IDs and restart correlation. The upstream is a local protocol simulator, not actual Qwen inference.

Anchor: sidecar/capability/saved-placement.js; test/tool-projection.e2e.test.js.

## Verdict

Current disposition: Engineering work closed for reproduced saved-equipment grant loss and misleading toolset diagnostics. The pre-fix qwen3:14b compatible-wire test omitted fs_write; ten real sidecar runs after repair projected the tools, wrote actual files and retained Last run/restart correlation. Installed-sidecar protocol checks and real installed file tasks passed. Actual Qwen inference and the original Trusted Project configuration remain unconfirmed.

Historical investigation notes (superseded for engineering closure):

Confirmed grant-loss and misleading disclosure paths repaired in 3c95b184fd28c5eacac8821ca2231d85da5b3395. Keep this customer report open pending confirmation of the original Trusted Project/Last run symptoms. No installer or customer recovery claim.

## Regression

Missing client placement now derives the saved assigned room (or the established whole-station fallback for an unassigned agent). Explicit empty placement still revokes gear and is preserved by the frontend transport. Profile grants and Full Access remain independent; disabled families still apply to ASK. Toolsets accepts both agent query spellings, rejects conflicting identities, defaults to the primary agent, uses the same saved floor fallback and names lead orchestration as a runtime grant.

## Sibling coverage

{"adapters":[{"target":"Ollama compatible wire, both reported model IDs","state":"covered","test":"test/tool-projection.e2e.test.js","scenario":"saved cabinet and trusted profile project fs_write and create a real file","gate":"http"},{"target":"actual Qwen model inference","state":"blocked","reason":"Local protocol simulator proves transmitted tools; actual model behavior was not exercised."}],"entrypoints":[{"target":"interactive /api/run with missing or explicit placement","state":"covered","test":"test/tool-projection.e2e.test.js","scenario":"omitted snapshot inherits saved floor; explicit empty revokes; profile and override remain effective","gate":"http"},{"target":"frontend Harness.chat","state":"covered","test":"test/harness-placement.test.js","scenario":"empty, populated, absent and legacy workbench payloads","gate":"fast"},{"target":"headless/delegated/routed entrypoints","state":"not-applicable","reason":"Fallback is limited to interactive handleRun; their explicit station and office composition is unchanged."}],"displays":[{"target":"toolset API and equipment explanation","state":"covered","test":"test/effective-toolsets.test.js","scenario":"saved room matches equipment scope; lead grant provenance and disabled family","gate":"fast"},{"target":"installed desktop","state":"blocked","reason":"Actual Qwen inference and affected-station UI recovery remain untested; rebuilt installed-sidecar protocol checks are recorded below."}],"lifecycle":[{"target":"restart, cabinet removal and family switch","state":"covered","test":"test/tool-projection.e2e.test.js","scenario":"persisted floor and Last run survive restart; saved removal and disabled family revoke","gate":"http"}]}

## September 10 release follow-through

Real installed file tasks used granted temporary project roots, wrote/read actual HTML files, completed and retained projectRoot/lastRunOk/run IDs across updates. The deliverables opened and their Verify buttons worked. One proposed shell command was explicitly denied and no shell execution is claimed. The affected station's equipment selection/Qwen trace remains unavailable; current-path proof does not establish that customer's recovery.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.

## September 11 packaged-sidecar check

The installed Windows 7f6c7b005 executable hash was verified. Its bundled Node and installed sidecar completed the ten-run tool-projection campaign in an isolated profile: both reported Qwen model IDs, saved cabinet fallback, explicit revocation, Trusted Project/ASK grants, actual fs_write results, Last run IDs and restart correlation passed. The upstream was a protocol simulator, so this does not assert actual Qwen inference or customer recovery. Logs: release preparation worktree `.dogfood/customer-execution/bundled-tool-projection.log`.
