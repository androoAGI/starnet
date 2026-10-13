# Wave 0.6 Residual Risk Register

## Control

- Project: `AU-UCR-EP-000001`
- Status: `DECISION_INPUT_NOT_ACCEPTED`
- Human Principal and sole final decision authority: `Hakeem Moore`
- Operational authority effect: `NONE`

## Risks

### `W06-RISK-01` — Mutable local candidate

- Severity: `HIGH`
- Evidence: Wave 0.4–0.6 artifacts are untracked; the 54-entry technical freeze identifies local
  bytes but is not a Git tree, publication receipt or independently retrieved object.
- Treatment: require separately authorized freeze, commit/publication and independent
  remeasurement before candidate-bound acceptance.
- Owner after authorization: Publication Custodian.
- Current disposition: `OPEN — HUMAN DECISION DEPENDENCY`.

### `W06-RISK-02` — Same-environment and same-tool assurance

- Severity: `HIGH`
- Evidence: agents, fixtures and assurance operate in one workspace; JSON Schema checks use one
  installed implementation.
- Treatment: repeat against a frozen candidate with a separately appointed reviewer and a pinned
  second validator.
- Owner after authorization: Independent Reviewer.
- Current disposition: `DISCLOSED — NOT ACCEPTED`.

### `W06-RISK-03` — Synthetic signatures and incomplete trust validation

- Severity: `HIGH`
- Evidence: ephemeral ES256/P1363/low-S mechanics passed, but bundle signatures are intentional
  `r=1,s=1` sentinels; signer authority, custody, trust roots and revocation were not verified.
- Treatment: designated test keys, pinned cryptographic suite, wrong-key/malformed/revoked cases
  and trust-state evidence in an approved isolated environment.
- Current disposition: `OPEN — NEXT-PHASE TEST DEPENDENCY`.

### `W06-RISK-04` — Interfaces remain design-only

- Severity: `HIGH`
- Evidence: `IF-01` through `IF-22` reconcile across registry, schemas and matrix, but no
  implementation or stateful consumer was exercised.
- Treatment: requirement-traced implementation and fail-closed conformance tests after explicit
  authorization.
- Current disposition: `OPEN — IMPLEMENTATION NOT AUTHORIZED`.

### `W06-RISK-05` — Authority identity and appointments are not machine-bound

- Severity: `HIGH`
- Evidence: Hakeem Moore is named, but stable identity proof, acknowledgement/signature,
  candidate-bound mandate and governed role appointments are absent.
- Treatment: Hakeem Moore supplies or declines the human-only fields and issues any scoped
  appointments without backdating.
- Current disposition: `HUMAN DECISION DEPENDENCY`.

### `W06-RISK-06` — Organizational independence is absent

- Severity: `HIGH`
- Evidence: Agent F is a same-workspace AI reviewer and is not formally appointed or separated.
- Treatment: retain Agent F as technical challenge evidence; require a governed independent
  review before acceptance if Hakeem Moore selects that control.
- Current disposition: `DISCLOSED — FORMAL REVIEW ABSENT`.

### `W06-RISK-07` — Operational and rollback behavior is unexecuted

- Severity: `HIGH`
- Evidence: no laboratory, runtime, provider, outbox, WORM, anchor, rollback or reinstatement
  implementation was constructed or tested.
- Treatment: execute only the approved bounded implementation/test plan with stop conditions and
  append-only evidence.
- Current disposition: `NOT_RUN — PROHIBITED PENDING DECISION`.

### `W06-RISK-08` — Canonicalization coverage is bounded

- Severity: `MEDIUM`
- Evidence: selected Python and Node bytes agree and bounded Unicode/number cases passed; a
  complete third-party RFC 8785 corpus was not available.
- Treatment: pin an independent implementation and complete conformance corpus.
- Current disposition: `PARTIALLY VERIFIED`.

### `W06-RISK-09` — Historical evidence gaps remain

- Severity: `MEDIUM`
- Evidence: commit `2ea38d86a19697b80a827d2dfd83a9219e145532` is unresolved; seven Wave
  0.3 file references are unavailable or superseded.
- Treatment: preserve as unsupported/historical-unavailable or supply independent immutable
  proof; never substitute nearby identifiers.
- Current disposition: `OPEN — NON-BLOCKING FOR DESIGN, BLOCKING FOR CLAIMS THAT RELY ON IT`.

### `W06-RISK-10` — Repository line-ending policy is not pinned

- Severity: `MEDIUM`
- Evidence: PRE_A09 hashes match LF/index bytes but raw Windows bytes differ; no applicable
  `.gitattributes` fixes the domain.
- Treatment: adopt an explicit path/hash-domain policy before publication.
- Current disposition: `OPEN — PUBLICATION CONTROL`.

## Decision rule

No risk is silently accepted. `APPROVE` is valid only if Hakeem Moore explicitly binds the exact
dossier and records accepted residual risks, conditions and exclusions. `REVISE` or `REJECT`
accepts none of these risks.
