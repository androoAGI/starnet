---
fingerprint: 54564ff9
slug: zoho-mail-bootstrap-tool-reportedly-requires-und
title: Zoho Mail bootstrap tool reportedly requires undiscoverable account
surface: channels
severity: P2
status: open
found: 2026-09-19
lane: agent/reliability-audit-0919
fix:
origin: customer
affected: StarNet 0.11.2 Windows; Ollama gpt-oss:20b; OAuth Zoho MCP
family: connector-schema-projection
report: support-2026-09-17-zoho-bootstrap
installer: unverified
recovery: unconfirmed
---

# Zoho Mail bootstrap tool reportedly requires undiscoverable account

## Symptom

An OAuth-connected Zoho MCP server reportedly advertises 14 tools but its Mail account discovery call requires account:string, preventing discovery of that same account.

## Repro

Compare the authenticated remote tools/list inputSchema, registry definition and emitted provider schema for the bootstrap tool, then call it with the documented empty argument object if allowed.

## Evidence

Fresh September 17 support thread reviewed September 19. sidecar/mcp/translate.js translateSchema preserves remote required fields and adds only a missing root type; sidecar/providers/toolschema.js normalizes provider-specific shapes. No raw remote schema or live Zoho credential was supplied.

## Verdict

Open: the evidence cannot distinguish upstream schema defect from stale connector schema or provider projection. Removing required fields by tool-name guess would weaken unrelated contracts. Obtain sanitized schema at all three boundaries and verify bootstrap against the authorized server.
