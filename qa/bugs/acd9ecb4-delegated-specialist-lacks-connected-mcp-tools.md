---
fingerprint: acd9ecb4
slug: delegated-specialist-lacks-connected-mcp-tools
title: Delegated specialist lacks connected MCP tools
surface: autonomy
severity: P1
status: open
found: 2026-09-11
lane: release-0112-finalprep-0911
fix:
origin: customer
report: https://github.com/androoAGI/starnet/issues/13
affected: 0.11.1 on Windows
family: delegated-capabilities
installer: unverified
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

Open pending a direct-versus-delegated reproduction and traced authority/tool projection. Do not blindly inherit interactive consent into background work or weaken grants to make the tools appear. No source fix, installer proof or customer recovery is established. This report was absent from the original seven-report release census.

## Regression

Required: real lead dispatch to the saved specialist using a controlled MCP server, compare direct and worker tool availability, execute an authorized read/safe write, and cover revoked grants, denied effects, reconnect and restart. Actual Close OAuth/account behavior remains separate from a fixture reproduction.

## Sibling coverage

