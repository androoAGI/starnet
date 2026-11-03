---
fingerprint: d6d27580
slug: oauth-discovery-and-header-probes-abandon-unread
title: OAuth discovery and header probes abandon unread response bodies
surface: safecell
severity: P1
status: open
found: 2026-11-03
lane: agent/safe-egress-oauth-close-1103
fix:
origin: audit
family: outbound-response-ownership
report: Safe-egress independent security review round 1 at immutable 448c99d2a6ca16d79b23fdf7c9930ae1818dac92
affected: Connector OAuth metadata errors and the header-only initialize authorization probe; inherited before safe-egress extraction
installer: unverified
recovery: unconfirmed
---

# OAuth discovery and header probes abandon unread response bodies

## Symptom

Connector sign-in can report a metadata failure or move beyond its authorization probe while the discarded server response still holds an open connection. A server that keeps its body open can retain that connection beyond the sign-in leg's deadline.

## Repro

1. Use the real OAuth fetch wrapper against an allocated synthetic server, preserving the validated hostname and pinned dispatcher at the local socket transport edge.
2. For discovery, send a non-2xx metadata response (404 or 302) and keep its body open. For the actual initialize probe, send a usable WWW-Authenticate pointer with a 401 or streaming 200 body that remains open.
3. Observe that the caller refuses or reads the pointer, then verify whether its owned socket and dispatcher close before fixture teardown or deadline abort. Retain the actual Response object so garbage collection cannot conceal abandonment.
4. `test/mcp.oauth-body-close.test.js` drives the real discovery function and exact extracted host probe block. `OAUTH_BODY_CONTROL` and `OAUTH_PROBE_CONTROL` select preserved original source for the comparison; no shared fetch implementation is replaced by a handwritten consumer.

## Evidence

- Source finding: `sidecar/mcp/oauth.js:getJson` rejected non-2xx responses without releasing their bodies. `sidecar/index.js:handleConnectorOauthStart` read only probe headers. `withDeadline` cleared the abort timer after either caller returned; `sidecar/mcp/oauth-fetch.js` had already started a graceful dispatcher close dependent on the unread body.
- Independent source report: `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/safe-egress-round1-independent-review.md`, M2. This is inherited consumer ownership debt, not a newly introduced SSRF bypass.
- Exact pre-repair source and frozen repair manifest: `egress-oauth-pre-close.js`, `egress-oauth-pre-close-index.js`, and `egress-oauth-close-source-02.json` under that same log directory.
- Sole narrow lease SE-OAUTH-2115: `egress-oauth-2115-control.log` completes with 4 problems /47 assertions (43 positive), PID68836 exit1; `egress-oauth-2115-current.log` completes with 47 green, PID50768 exit0. Per-child JSON receipts contain exact commands, source-control environment paths, times and exits. All three syntax checks pass. The original four responses remain strongly referenced: each reaches request/close-start but never the owned closure assertion; current closes both socket and dispatcher with no deadline abort. Actual Host and one-request/manual-redirect predicates pass, and normal JSON plus streaming positives remain readable.

## Verdict

Paired actual socket control/current and independent bounded source review pass. Status remains open until the repair commit is recorded. The change releases bodies only at consumers that are done with them; the shared fetch wrapper continues returning readable JSON and streaming responses. Combined affected readers and the second full security review remain separate. Installer verification and live customer recovery remain unconfirmed.

## Regression

`test/mcp.oauth-body-close.test.js` with the exact saved original OAuth module and host probe has 4 intended failures /47, one socket-closure failure for each 404/302 metadata and 401/streaming header-only probe. Current source passes all47, including no followed redirect, original Host, no timeout-dependent cleanup, real JSON consumption and a later streaming chunk. This is allocated local-socket proof with explicit HTTP/loopback transport substitution after public-HTTPS validation, not installed TLS or live provider verification.
