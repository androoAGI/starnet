---
fingerprint: d6645716
slug: native-web-request-fails-before-http
title: Native web_request fails before HTTP while external clients succeed
surface: providers
severity: P1
status: fixed
found: 2026-10-03
lane: agent/safe-egress-module-1103
fix: d1e3d43f3
origin: customer
report: email E22 (qa/evidence/customer-release-1011/email-intake.json) and https://github.com/androoAGI/starnet/issues/82
affected: StarNet 0.12.5-0.13.0 on Windows and Apple Silicon (3 email reporters; gh#82)
family: outbound-transport
installer: unverified
recovery: unconfirmed
---

# Native web_request fails before HTTP while external clients succeed

## Symptom

Every web_request and web_fetch an agent made failed before any HTTP response with a bare "fetch failed", while a browser, curl and other clients on the same machine and network reached the same URLs. Three email reporters (E22, Windows and Apple Silicon, 0.12.5 to 0.13.0) and GitHub issue #82 describe it; E22 recorded the failure as persisting across restarts.

## Repro

1. Check out a tree before d1e3d43f3 (for example v0.13.0) and run it with Node 20 or later (the bundled runtime is v22.23.2).
2. Run `node test/web.pinned-dispatcher.test.js` from that tree's d1e3d43f3 version: the pinned dispatcher's `connect.lookup` is called by Node's autoSelectFamily connect with `{ all: true }` and answers `(address, family)`, so Node reads `undefined` as the address list and the request dies as `fetch failed`, cause `ERR_INVALID_IP_ADDRESS` ("Invalid IP address: undefined").
3. Or, with normal DNS and network access, call `makeWebTools({}).webFetch('https://example.com')` from sidecar/tools/builtin/web.js at that tree: it fails, while `fetch('https://example.com')` in the same process answers HTTP 200.

## Evidence

- Root cause: sidecar/tools/builtin/web.js's pinned lookup (introduced by 7bab4b448 "pin outbound DNS for web and browser tools", first tag v0.12.5) always called `callback(null, address.address, address.family)`. Node 20+ connects with autoSelectFamily and asks the lookup for `{ all: true }`, expecting an array. Isolated on 2026-10-03 by the Mac fetch investigation (archived audit record 051f8c3b, commit 17c3aeb92) with bundled Node v22.23.2 and undici 6.28.1: native fetch and plain undici answered 200, StarNet's web_fetch failed with `ERR_INVALID_IP_ADDRESS`, and the instrumented `connect.lookup` options were `{hints:0,all:true}`.
- Fix: d1e3d43f3 (2026-10-04) answers `all: true` with the list of every validated address, so a network without working IPv6 still reaches IPv4, and names a transport failure's cause code and host instead of bare "fetch failed". Verified by `git merge-base --is-ancestor`: first tag v0.13.1; v0.13.0 does not contain it.
- The class: each outbound path hand-rolled its own pinned connect lookup, and the copies disagreed (the gh#82 reporter pointed at sidecar/mcp/oauth-fetch.js, which already answered `all: true`). The safe-egress lane (agent/safe-egress-module-1103) closed the family: sidecar/net/safe-egress.js `pinnedLookup` is the one implementation, and test/safe-egress.conformance.test.js C11 refuses any other sidecar file that answers a connect-time lookup.
- Live proof 2026-11-03 at e9d823479: scripts/canary/egress-floor.mjs passed under the installed bundled node v22.23.2 and PATH node v22.23.0 (web_request, web_fetch, connector OAuth, skill document and package fetches, browser proxy against https://example.com/): qa/evidence/safe-egress-1103/live-proof.json.
- Customer E22 carried no fingerprint (record_action "add customer incident record"); this record is that record. Not the macOS TLS decode report 1d3ac09a, whose signature differs and which stays open.

## Verdict

Source-fixed by d1e3d43f3, first in v0.13.1, and the class closed in the safe-egress lane. No installed-build retest on the reporters' machines and no reporter confirmation: installer unverified, recovery unconfirmed. When a reporter answers after v0.13.1, record it in recovery and recoveryEvidence.

## Regression

Before d1e3d43f3, `test/web.pinned-dispatcher.test.js` (added by that commit, real undici and real net.connect) fails: the pinned request dies as fetch failed with ERR_INVALID_IP_ADDRESS. After it, the request connects, Node asking `{ all: true }` gets the validated list, and a transport failure names its cause. `test/safe-egress.real-socket.test.js` (Node 22, real sockets) now pins the class for every pinning consumer: validated [dead IPv6, live IPv4], each consumer connects at the live address with one DNS question and none at connect time; it is red at 0b8441064 for connector OAuth and the skill fetch (qa/evidence/safe-egress-1103/red-at-base.json).

## Sibling coverage

{
  "adapters": [
    {"target":"web_request and web_fetch through npm undici.fetch","state":"covered","test":"test/web.pinned-dispatcher.test.js","scenario":"Real undici and net.connect: Node's all:true connect gets the validated list and connects; a transport failure names its cause code and host","gate":"fast"},
    {"target":"every pinning consumer on Node 22 real sockets (web tools, browser proxy, connector OAuth, skill fetch and package session)","state":"covered","test":"test/safe-egress.real-socket.test.js","scenario":"Validated [dead IPv6, live IPv4]: each connects at the live address, one DNS question, none at connect time, SNI or Host the requested name","gate":"fast"},
    {"target":"the dial shape of each consumer built as index.js builds it","state":"covered","test":"test/safe-egress.conformance.test.js","scenario":"Each pinning consumer's dispatcher answers every validated address in order for all:true and the first for the single shape, and is closed","gate":"fast"}
  ],
  "entrypoints": [
    {"target":"agent tool calls of web_request and web_fetch","state":"covered","test":"test/safe-egress.conformance.test.js","scenario":"C1-C3 dispatch both tools through the tool registry over every host row, DNS row and redirect hop","gate":"fast"},
    {"target":"connector sign-in through the real sidecar routes","state":"covered","test":"test/connector-reset-runtime.http.test.js","scenario":"OAuth discovery, client registration and token exchange through connectorOauthFetch with the preload rig's DNS and fetch","gate":"http"},
    {"target":"an installed desktop build on Windows and Apple Silicon","state":"blocked","reason":"No installed build's web_request was exercised; the live canary ran the sidecar modules under the bundled node, not the packaged app."}
  ],
  "displays": [
    {"target":"the tool result of a failed request","state":"covered","test":"test/web.pinned-dispatcher.test.js","scenario":"A transport failure reads fetch failed (CODE host) instead of a bare fetch failed","gate":"fast"},
    {"target":"the reporters' COMMS tool rows","state":"blocked","reason":"The reporters' own tool results and machines were not available; no affected-installer UI was inspected."}
  ],
  "lifecycle": [
    {"target":"dispatcher close after each hop and at a package's end","state":"covered","test":"test/safe-egress.real-socket.test.js","scenario":"withPinned closes its Agent once the body is read; a skill package session closes its Agent at the end, a failed package too","gate":"fast"},
    {"target":"restart, sleep and network change on the reporters' machines","state":"blocked","reason":"Reporter machines unavailable; recovery stays unconfirmed until a reporter answers after v0.13.1."}
  ]
}
