---
fingerprint: 678ac951
slug: ollama-task-runs-finish-without-reported-filesys
title: Ollama task runs finish without reported filesystem tool calls
surface: providers
severity: P2
status: open
found: 2026-09-19
lane: agent/reliability-audit-0919
fix:
origin: customer
affected: StarNet 0.12.3 Windows; llama3.1:8b and qwen3:8b; reported source 3ba5b84922f3b62caa4e159999ef3acc82af2a3e
family: local-provider-tool-projection
report: https://github.com/androoAGI/starnet/issues/20
installer: unverified
recovery: unconfirmed
---

# Ollama task runs finish without reported filesystem tool calls

## Symptom

On StarNet 0.12.3 Windows, llama3.1:8b and qwen3:8b reportedly finish file creation requests with zero tool calls despite visible File Cabinet tools. Direct Ollama structured calls reportedly work.

## Repro

Reproduce the exact station and model with a sanitized tool-definition/request capture; compare normal interactive, task-promoted, delegated and direct adapter paths. Separate prose resembling a function call from actual structured tool_calls.

## Evidence

Fresh read of GitHub issue #20 on 2026-09-19. sidecar/providers/openai-compatible.js forwards req.tools and parses structured calls; sidecar/index.js checks tool capability only when explicitly false. test/provider.openai-compatible.test.js covers structured chunks and refuses silent tool removal. test/casual-response-safety.e2e.test.js proves real Ollama-profile task promotion emits tools to a controlled endpoint. Neither substitutes for the affected model/station.

## Verdict

Open: no affected wire capture or actual Ollama models available. Do not force every answer to call a tool or execute function-like prose. Capture selection, classification, effective tool set and response before changing the provider contract.
