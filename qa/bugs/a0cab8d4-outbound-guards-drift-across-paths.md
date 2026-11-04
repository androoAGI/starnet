---
fingerprint: a0cab8d4
slug: outbound-guards-drift-across-paths
title: Outbound guards drift across paths
surface: safecell
severity: P1
status: fixed
found: 2026-11-02
lane: agent/safe-egress-module-1103
fix: eec83c9fd
origin: audit
report: safe-egress lane planning probes 2026-11-02 (C:/Users/andro/gen-trees/_logs/lanes-1103/safe-egress-module-plan.json, redProofs)
affected: every outbound path whose destination a model or a remote server picks, v0.14.2 and earlier
family: outbound-transport
---

# Outbound guards drift across paths

## Symptom

The same URL got different verdicts depending on which outbound path asked, because five files each kept their own private-range table and three hand-rolled the pinned connect lookup. The owned browser opened http://metadata.goog/ (the cloud metadata service) that web_fetch refused. Connector sign-in refused every public IPv6 endpoint and every NAT64 endpoint of a public server. Every path allowed a private IPv4 spelled as IPv6 ([::127.0.0.1], NAT64 [64:ff9b::a00:5], 6to4 [2002:a00:5::1]) and 224.0.0.1, 240.0.0.1, 255.255.255.255, 192.0.0.8, fec0::1 and ff02::1. Connector sign-in pinned only the first validated address, so a dead first address (a broken IPv6) failed sign-in that web_fetch completed. The skill, market and community-map fetch validated one DNS answer and then let its connect resolve the name again through the OS, so the address validated was not the address dialed (a DNS-rebinding window). The browser's refusal of the agent's own URL on a private DNS answer was not host-authored, so it tainted the run.

## Repro

1. Check out 0b8441064 and copy in the final `test/safe-egress.conformance.test.js` and `test/safe-egress.real-socket.test.js` with sidecar/net/safe-egress.js (the tests read its table; no base consumer uses it).
2. Run `node test/safe-egress.conformance.test.js`: 985 failures. Among them: browser.navigate allows metadata.goog, oauth.js refuses https://[2606:4700:4700::1111]/, the skill fetch fetches https://127.0.0.1/ with no dispatcher, makeConnectorOauthFetch cannot be built without web.js's guard, and the C11 census finds range tables or hand-rolled lookups in web.js, browser.js, browser-proxy.js, mcp/oauth.js, mcp/oauth-fetch.js and index.js.
3. Run `node test/safe-egress.real-socket.test.js`: 11 failures. The skill fetch makes no connection at the live address (its connect asks the OS resolver and gets ENOTFOUND), and connector OAuth cannot be built the production way.

## Evidence

- The full RED readout at the base, per section: qa/evidence/safe-egress-1103/red-at-base.json. Live proof at e9d823479 on real DNS and TLS under the bundled node v22.23.2 and PATH node v22.23.0: qa/evidence/safe-egress-1103/live-proof.json.
- The copies at the base: sidecar/tools/builtin/web.js:306-387 and 553, sidecar/tools/builtin/browser.js:619-680, sidecar/tools/builtin/browser-proxy.js:67, sidecar/mcp/oauth.js:105-123, sidecar/mcp/oauth-fetch.js:38-45, sidecar/skills/exchange-fetch.js:25-31 (no dispatcher) and the DNS lambdas in sidecar/index.js.
- The fix, one lane: 51d0d3240 (sidecar/net/safe-egress.js: one classifier table, one DNS answer per hop, one pinned dial), 14a397603 (the real-socket test), 4f0c03275 (web), 154404623 (browser), 3144e8ba2 (browser proxy), eec83c9fd (connector OAuth, the skill fetch, index.js and the census), e9d823479 (the live canary).
- What the boundary now refuses, each with its exit in the existing tool result or sign-in message: the new not-public blocks (192.0.0/24, multicast, 240/4 and broadcast, fec0::/10, ff00::/8, 100::/64, 64:ff9b:1::/48), IPv6 forms of a refused IPv4, *.home.arpa and metadata.goog in the browser. A public name answered with a refused address now carries the DNS-filter exit on web_fetch, web_request, connector sign-in and the skill downloads. Kept public on purpose: 198.18.0.0/15 (Clash/Surge fake-IP proxies), the TEST-NETs, 2001:db8::/32 and Teredo.

## Verdict

Fixed in the safe-egress lane: sidecar/net/safe-egress.js owns the outbound trust boundary, and every consumer names its POLICIES row and calls it. `test/safe-egress.conformance.test.js` holds every consumer to one table and its C11 census refuses a new copy anywhere in the sidecar; `test/safe-egress.real-socket.test.js` proves the pinned dial connects on Node 22. Both independent security reviews now pass after repairing skill and OAuth body ownership. All29 affected checks and fresh six-consumer DNS/TLS canaries pass on PATH22.23.0 and bundled22.23.2 at bc80d6ed381742521a14c6e5e11825bbe76e3212 (`qa/evidence/safe-egress-1103/continuation-proof.json`). Not on trunk or in a tag; full combined gates and installed/customer recovery remain separate.

## Regression

Both invariant files fail at 0b8441064 (985 and 11 failures) and pass at e9d823479 (7553 and 65 assertions, the real-socket test under PATH node v22.23.0 and the installed StarNet node v22.23.2).
