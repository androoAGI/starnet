---
fingerprint: c543a9c1
slug: custom-routine-refused-with-a-saved-base-url
title: CUSTOM routine refused with a saved base URL
surface: providers
severity: P1
status: fixed
found: 2026-10-31
lane: agent/credential-store-1031
fix: 775f12cda
origin: audit
family: B1-credential-sources
---

# CUSTOM routine refused with a saved base URL

## Symptom

A CUSTOM routine on a station started with `CUSTOM_OPENAI_KEY` and no `CUSTOM_OPENAI_BASE_URL` was refused with "no CUSTOM base URL is saved on this station for this routine", while a key and that URL sat saved under SETTINGS → AI & MODELS. Run Now, the scheduled fire, a line hop, a bot and /v1 all stopped there, before and after a restart. With a URL saved and no key beside it the sentence was the same, and its exit led nowhere, because the URL it asked for was already saved. Related reports: gh#137 (the desktop half is fixed at trunk), gh#113 (a key set in the environment "with nano", the URL in the UI) and channels TODO 4.

## Repro

1. Check out a3af8dafd (or any trunk before this fix), give it a `node_modules` junction, and copy `test/credential-store.endpoint-pair.e2e.test.js` and `test/helpers/outbound-edge.js` from this lane into it. Run `node test/credential-store.endpoint-pair.e2e.test.js`.
2. Row 1 (probe P3b): a headless sidecar with `CUSTOM_OPENAI_KEY=E` and no env URL; a page saves CUSTOM {K, U} through POST /api/providers/engine-key. The answer says `keySource: 'environment'`, `unattendedReady: false`, and Run Now of a CUSTOM routine answers 400 "no CUSTOM base URL is saved on this station for this routine…". The scheduled fire, a line hop and a bot's connect are refused the same way, and /v1 answers 503.
3. Row 2 (probe P3c): the same env key; the page saves CUSTOM {U} with no key. Run Now answers the same 400, beside the URL it says is missing.
4. Table form: copy `test/credential-store.no-crossing.test.js` and `test/helpers/credential-store-sandbox.js` into the same checkout and run the first. Its section 7 runs over trunk's own resolvers, lifted from that tree's index.js.

## Evidence

- Mechanism at a3af8dafd: `providerRuntimeKey` (sidecar/index.js:2984) returned the first layer's key and `providerRuntimeBaseUrl` (sidecar/index.js:3033) the endpoint that key could use, so the station's own pair was two answers. CUSTOM has no default endpoint, so the env key resolved `{E, ''}` with the page's whole pair one layer down. `cronHasCredential` checked the key with an endpoint resolved without it, `engineCredentialError` (sidecar/index.js:3399) read an empty endpoint as "no base URL is saved", and the fire, Run Now and line hops hand the gate's key to `runOnce` as an explicit key (sidecar/cron-driver.js:435, 547), so a rule placed only in the gates would have admitted a run that then went out on E with no endpoint.
- The same resolver had a second fault, which this rule would have made worse: `baseUrl(id, '', undefined, callerKey)`, the shape a hub's `secrets()`, runOnceCore's fallback loop and the catalog use, asked the page copy about the STATION's key, not the caller's. A channel's own key or a fallback's own key went to the page's endpoint, and the page's own key handed back that way, on a station with an env key, missed it.
- Probes P3b and P3c (probe-browser.js in the lane's plan scratch, re-run by the spec critic): Run Now answered 400 "no CUSTOM base URL is saved on this station…" although U is saved. Control P3a, the page's pair alone, passes before and after a restart.
- `test/credential-store.endpoint-pair.e2e.test.js` in a scratch checkout of a3af8dafd: 35 problems, 55 ok. The first failure is the page save's answer (`keySource: 'environment'`, `unattendedReady: false`), then Run Now's 400, the fire's blocked sentence, the hop, the bot and /v1's 503, before and after the restart. In row 2 the sentence says no URL is saved beside a saved URL, and saving the key next to it changes nothing (exit 1). The env URL exit and every guard pass at trunk.
- `test/credential-store.no-crossing.test.js` in the same checkout: section 7 reports 1216 of 33978 rows crossing, in 8 shapes: `custom K:- E:k P:ku` resolves `["en","",false,"environment"]`, and `anthropic K:- E:- P:u` with a caller's key and no run key goes to `http://pg.test/v1`, the page's endpoint.
- The golden: with this fix undone the store reproduces the previous fixture exactly (0 of 1479 rows differ). The pair rule moves 24 rows (`deltas.D3`), all CUSTOM stations trunk refused, each now ready on the page pair, and on each only the station's own run, a keyless body and presence move. The refusal rule changes 35 sentences (`deltas.D4`, 12 in the layers table and 23 in the names table), whose `trunk` values were captured from trunk's own `engineCredentialError` in the scratch checkout.
- Mutations of the fixed store, each caught: PR #141's rule (any key rides the page's endpoint) fails no-crossing with 9 failures, the golden with 7, engine-credential with 9 and channels.station-key with 18. The hub shape read against the station's key again fails no-crossing, engine-credential and channels.station-key. A keyless lower pair replacing the env key (decision 5's rejected alternative) fails all four. A page key outranking a usable env key fails all four.

## Verdict

Fixed by 775f12cda on agent/credential-store-1031 (credential-store lane, step S7; golden deltas D3 and D4; not merged yet). Claims gh#137 and gh#113's workflow half for the env key beside a saved pair, and closes channels TODO 4. PR #141 was read only as the users' spec: it sent E to U, the crossing this lane forbids.

The station's own choice is one pair (sidecar/credential-store.js `stationChoice`): the first layer, in key order, whose key has a usable endpoint, used whole. A provider that needs a base URL looks past a key with no endpoint to the first lower layer with both. Any other provider has its default and keeps its first key, so only runs trunk refused change, and a page key never outranks a usable env key. `key(id, '')` and `baseUrl(id, '')` read that one choice, and so do presence, the readout and `keyPool`, so a gate and the run it admits agree on every surface: each sends K to U, never E. `resolve(id, ctx)` is the whole credential at once, with what is missing. `cronHasCredential` now resolves the endpoint for the key it checks. An env key's pool stays the env key's: step S4 landed first, so it never rotates behind the chosen page pair.

`baseUrl` never hands a key an endpoint saved for another key, except the two station-wide overrides (the keychain endpoint, the env URL): with no run key it now asks about the caller's own key.

Named changes:
- `keySource` reads 'station' and `credentialSource` 'page' on a station that runs the page pair beside an env key, so the page's save line says routines can use the key, which is now true. /api/providers' `currentBaseUrl` is U there.
- A fallback or a catalog read with its own key and no endpoint, on a station with a page pair, no longer goes to the page's endpoint. On CUSTOM it is skipped or refused, as the primary path already was. This is the one run trunk made that now stops, and that run was the crossing.
- `providerCredentialError` keeps "configure the CUSTOM base URL", which the page's error ladder reads, and adds the variable and both exits for an env key with no endpoint. This reaches line hops, bots, /v1 and the Doctor. The plan named only `engineCredentialError`; the same false refusal stood on those surfaces.

States it refuses, each with its exit:
1. An env key beside a URL saved with no key (state 3, decision 5): "CUSTOM_OPENAI_KEY is set in the environment that starts StarNet, but no CUSTOM base URL goes with it: the URL saved under SETTINGS → AI & MODELS was saved without a key, and an environment key is never sent to a URL saved in the page. Save the key next to that URL in Settings, or set CUSTOM_OPENAI_BASE_URL." The sentence names the variable the key is really in.
2. An env key with no URL anywhere and no complete lower pair (state 2): the same head, then "set CUSTOM_OPENAI_BASE_URL, or save the key next to the URL under SETTINGS → AI & MODELS".
3. A key a caller passes, with no usable endpoint: refused, never swapped for the pair the station would have used. Exit: send the endpoint with it, or save the two together.

Tests:
- `test/credential-store.endpoint-pair.e2e.test.js` (http, new): real sidecars, a recording upstream, a fake Bot API. Run Now, the scheduled fire, a line hop on a live roster, a Telegram bot that keeps no key and /v1 each reach U with K before and after a restart with no page, and U never sees E or its pool. P3c is refused with the sentence and U sees no request, and both exits are driven. Guards: a keyless station, an OpenRouter env URL with a page key, the desktop's kept endpoint after a restart, a StarNet routine under stale endpoints, a sign-in's bearer under a stale one. The lane's closing pass added doneMeans 3 as it reads: a routine that came due while the station was down fires in the boot's own catch-up, before anything could connect, at U with K beside the env key (refused at a3af8dafd), and on the page's pair with no env key at all, with the next scheduled fire after it (a guard, P3a). The file then stands at 37 problems, 64 ok at a3af8dafd and 93 assertions here.
- `test/credential-store.no-crossing.test.js` section 7 (fast): 882 stations, 37548 rows: every combination of the layers for five provider classes under every call shape of the wrappers, against an oracle that reads only the station's description, with a gate's pair asked of runOnceCore's own lines, and `resolve()` and index.js's refusal beside them.
- `test/credential-store.golden.test.js` section 8, `test/engine-credential.test.js`, and `test/channels.station-key.test.js` (TODO 4 resolved; a record handing E back is refused and never sent to U).

Not covered here:
- Interactive chat on the P3c station still reads "The station holds no CUSTOM endpoint for its saved key — re-save the base URL", which re-saving does not fix. That line is the page's (friendlyerror.js), and this lane changes no frontend. A follow-up should give it the same exits.
- A channel's own key and endpoint in the channel layer: step S8.
