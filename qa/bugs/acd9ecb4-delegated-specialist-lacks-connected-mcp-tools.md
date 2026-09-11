---
fingerprint: acd9ecb4
slug: delegated-specialist-lacks-connected-mcp-tools
title: Delegated specialist lacks connected MCP tools
surface: autonomy
severity: P1
status: fixed
found: 2026-09-11
lane: release-0112-finalprep-0911
fix: 44c6b4952cd1e468f7caaf4d7ead804dc280cc40
origin: customer
report: https://github.com/androoAGI/starnet/issues/13
affected: 0.11.1 on Windows
family: delegated-capabilities
installer: verified
installerVersion: 0.11.1 private candidate 6e729e4cb
installerSha256: 5baadbf8483e601db257f2b1ce8855fbc494add5db64493f501a3d93e717efeb
installerEvidence: https://github.com/androoAGI/starnet/actions/runs/34569801784
recovery: unconfirmed
---

# Delegated specialist lacks connected MCP tools

## Symptom

A specialist can read and safely write through Close CRM MCP tools in its direct session, but a lead-delegated task reports that those tools are unavailable despite the saved equipment grants. Browser fallback cannot complete the required interactive sign-in.

## Repro

Reported sequence: connect Close CRM through Abilities Discover with OAuth; grant Maintain Access, Read Data MCP and Write Safe MCP; verify direct specialist reads/writes; ask the lead to delegate equivalent work to that specialist. Compare actual tool definitions and results between both runs. Exact local reproduction is not established.

## Evidence

[GitHub #13](https://github.com/androoAGI/starnet/issues/13), reported September 10, 2026 on Windows 0.11.1; read September 11. No attached diagnostics or follow-up comments.

Investigation anchors: `sidecar/index.js:15046` distinguishes interactive and autonomous run surfaces; `sidecar/index.js:15875` projects run authority; `sidecar/index.js:16345` handles withheld connector tools. These are investigation entry points, not an established root cause. Direct-session connector tests do not prove delegated grant propagation.

## Verdict

Source fixed in 44c6b4952. The worker inherited the lead's consent broker, but autonomous authority removed MCP tools before that broker could run. A host-only MCP bridge now reaches that broker while retaining worker capability/profile filtering, cancellation and live parent authority. Parent taint carries into worker execution; connector mutations after external content need fresh watched confirmation. Shell, physical input and unknown non-MCP effects receive no new authority. Installed execution passed on the signed candidate; actual Close CRM recovery remains unconfirmed.

## Installed verification

Private signed build `6e729e4cb2ca151f2ca7f280d500c86393bf0046`, workflow 34569801784, passed this scenario using the installed Node runtime and source-matched installed sidecar. The executable SHA-256 is `28bca2f1196426eec6f4afaefa5a2f5b67cbafd3b354078e889c9d262ee87366`. Controlled provider/MCP endpoints and isolated stations were used; no customer account was contacted. Exact logs and receipts: `qa/evidence/0.11.2-issues-12-13/installer-verification.json`.

## Regression

Follow-up b4bcdac904f5574ee4541c0cfae5de400592ee69 preserves the lead's live Full Access posture for delegated MCP calls. The HTTP scenario verifies zero prompts with a Full Access lead and an Ask specialist, then returns the lead to Ask and proves denial prevents the write. This authority is host-only, cancellation-aware, and limited to connector tools.

`test/delegated-connectors.e2e.test.js` boots the real sidecar, provider adapter and MCP transport. Before the fix the direct specialist read/wrote the fixture CRM while the real delegated worker lacked both tools. Afterward both paths read/write, fresh permission prompts reach the lead watcher, denied writes never reach MCP, and connector removal revokes access. Delegated execution also passes after restart. `test/inputpolicy.test.js` checks live parent revocation, ungranted unattended leads, and denial of shell/desktop/unknown tools through this bridge. `test/untrusted-taint.test.js` retains temporal-confirmation enforcement.

## Sibling coverage

{"adapters":[{"target":"connected MCP over HTTP","state":"covered","test":"test/delegated-connectors.e2e.test.js","scenario":"actual MCP read/write via direct and delegated runs with watched permission responses","gate":"http"},{"target":"Close CRM OAuth account","state":"blocked","reason":"The controlled MCP server proves delegation wiring; no reporter account or live Close recovery confirmation is available."}],"entrypoints":[{"target":"foreground team.dispatch","state":"covered","test":"test/delegated-connectors.e2e.test.js","scenario":"lead dispatch creates a real specialist run with MCP tools and forwards approval","gate":"http"},{"target":"background dispatch, spawn and resume","state":"blocked","reason":"The host connector options are wired to these siblings, but no dedicated end-to-end MCP scenario exercises each one yet."}],"displays":[{"target":"permission event stream","state":"covered","test":"test/delegated-connectors.e2e.test.js","scenario":"fresh confirmation after MCP read; denied write has no external effect","gate":"http"},{"target":"installed desktop","state":"blocked","reason":"Installed Node/sidecar execution passed; the desktop permission UI was not separately driven visually."}],"lifecycle":[{"target":"restart and connector removal","state":"covered","test":"test/delegated-connectors.e2e.test.js","scenario":"delegated read/write after restart and no effects after removal","gate":"http"},{"target":"authority revocation","state":"covered","test":"test/inputpolicy.test.js","scenario":"prior projection cannot bypass changed parent authority; non-MCP effects remain denied","gate":"fast"}]}
