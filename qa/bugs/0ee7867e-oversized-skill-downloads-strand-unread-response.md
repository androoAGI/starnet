---
fingerprint: 0ee7867e
slug: oversized-skill-downloads-strand-unread-response
title: Oversized skill downloads strand unread response sockets
surface: safecell
severity: P1
status: fixed
found: 2026-11-03
lane: agent/safe-egress-module-1103
fix: dd74251f7e58453ad1d8e46375ea3e38157cf830
origin: audit
installer: unverified
recovery: unconfirmed
---

# Oversized skill downloads strand unread response sockets

## Symptom

A skill download whose declared size exceeds the allowed limit can wait until the request timeout before reporting its already-known size refusal. A package import can remain waiting indefinitely after its own request timers have been cleared.

## Repro

1. Use the actual socket fixture `test/skill-exchange.body-close.test.js` with `sidecar/skills/exchange-fetch.js` from `448c99d2a6ca16d79b23fdf7c9930ae1818dac92` loaded through its `SKILL_EXCHANGE_FETCH_SOURCE` control seam.
2. Its allocated HTTP server advertises a 300000-byte response, sends one byte, and leaves the response open. The actual public-host validator, pinned undici Agent and response body run; only the transport address and TLS edge are replaced with the owned local server.
3. Observe the standalone fetch, explicit package session, generic package and GitHub package first-file refusal. The response objects remain strongly reachable so garbage collection cannot mask missing caller cleanup.
4. The old standalone request waits for an abort; each old package path requires the fixture's external watchdog to free the socket. Current source cancels the unread response and closes every owned dispatcher before the caller settles.

## Evidence

`qa/evidence/safe-egress-1103/body-close-1103.json` records the final exact-source control and repair. Original control PID51540 exited1 with 4 intended failures and 80 passing assertions; current PID62448 exited0 with all84 assertions passing. The failed assertions name `document/declared`, `session/declared`, `package/declared` and `github/declared`.

The same fixture covers streamed oversize cancellation and complete small responses for all four owners. It checks the original size error, no deadline abort, no watchdog cleanup, actual socket closure, every dispatcher closed, one DNS validation per host, and preserved Host names. An earlier recursive Agent.close instrumentation attempt was invalid and is excluded; the final fixture wraps the Agent without overriding its internal close method.

Root logs are retained at `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/safe-egress-body-2113-{old,current}.{log,json}`. Independent source finding M1 is in `safe-egress-round1-independent-review.md` in the same directory.

## Verdict

Fixed in source by dd74251f7e58453ad1d8e46375ea3e38157cf830. The focused repair cancels a response rejected before a reader owns its body, before yielding to per-hop or package graceful close. Size limits, deadlines, redirect checks, DNS validation and package authority are unchanged. Both security reviews, all29 combined affected checks and six-consumer live DNS/TLS checks on both Node22 runtimes pass at bc80d6ed381742521a14c6e5e11825bbe76e3212; see `qa/evidence/safe-egress-1103/continuation-proof.json`. Full combined gates and installed/customer recovery remain separate.
