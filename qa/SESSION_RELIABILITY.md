# Session continuity acceptance

Session reliability is a release requirement. A passing component test alone does not establish a continuous conversation. The required campaign is registered in both `test/fast.list` and `test/customer-journeys.list`; CI and the release train already execute these lists. `test/qa-bug-lifecycle.test.js` prevents removal of the session campaign and installed acceptance registration.

| Guarantee | Executed acceptance |
| --- | --- |
| A submitted message belongs to its captured session | Send while restore is pending, navigate to B, then release A's response; only A receives the turn and request |
| Background results preserve composition | Emit workshop completion during a focused draft; selection and text stay intact |
| History restoration precedes inference | Delay the transcript containing a changed destination; the model-bound request waits and includes it before the new question |
| Older reads cannot overwrite newer state | Controlled response-order permutations; removed sessions and in-flight clears reject stale writeback |
| Unknown is not empty | HTTP failure and malformed success preserve existing history and refuse context-dependent dispatch |
| Saves and replies tell the truth | Failed durable save returns false with retained local data; missing run end retains an interrupted reply |
| Continuity survives losing browser cache | Confirm a durable save, remove the cache, restart the sidecar and compare the full restored conversation |

Run `node test/session-continuity.test.js` for deterministic ownership coverage across both shipped frontend copies, and `node test/session-reliability.e2e.test.js` for the combined browser/sidecar journey. The browser campaign fails if Chrome is missing. Its transports simulate inference and faults, while production UI, save API and process restart are real. It checks the browser's model-bound request, not an external model's subjective recall. Earlier history ordering, save concurrency, voice/upload focus, group API, provider and recovery suites remain required.

The existing COPY DIAGNOSTICS action appends the last 64 continuity transitions. They contain time, a page-local numeric session label and a fixed event name. No message, title, attachment, file path, credential or durable session identifier is collected by this addition. Existing build and save diagnostics remain the source of artifact/durability identity. These traces reset when the page reloads and are support evidence, not a success counter.

## Artifact acceptance and limits

`t0-clean-install-proof.yml` runs this journey through `installed-customer-regressions.cjs` after its public-to-candidate Windows upgrade. The wrapper requires the installed Node runtime, hashes the executable and relevant installed source files, and serves the installed frontend/sidecar against an isolated station. Evidence is collected with the candidate receipts. That campaign uses Chrome with installed assets; it does not establish native WebView behavior or preserve the user's live profile.

For release acceptance, also run the same user sequence in the actual Windows and macOS native renderer, using an isolated profile containing existing sessions. Record exact version, executable/installer hash, upgrade baseline, before/after session identities and restart results. A source result cannot satisfy this requirement. The new lane does not claim native macOS coverage, an installer build, public release, or affected-customer confirmation. Existing clean-install, public-upgrade and packaged lifecycle gates continue to own their separate scopes.

Do not infer that every report has this cause. Correlate build and session events first; preserve the original report separately when its mechanism is still unknown. Add each new escaped lifecycle sequence to the campaign, not only a component assertion. Deliberate clear/undo across a later reopen and multi-device conflict resolution are separate semantics; the in-flight clear test does not claim to prove them.
