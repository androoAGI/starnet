# Wave 0.6 Schema Full-Document Coverage Matrix

## Classification and totals

- Concrete/instantiable schemas: **33**
- Definition-only abstract/helper schemas: **2**
- Generated full-document cases: **160** (36 valid, 124 invalid)
- Existing governed-event full-document cases retained: **2** (one valid, one invalid)
- Checker total: **162** full-document cases

A concrete schema has a top-level instance contract. `profile-receipt` is concrete and
instantiable, but its required `abstract_only: true` marker makes it non-authorizing.
`common.schema.json` and `authority-object-base.schema.json` contain only reusable `$defs`;
they have no meaningful standalone instance contract and are exercised through concrete
schemas that reference those definitions.

## Matrix

| Schema | Classification | Full-document cases | Boundary keywords |
| --- | --- | ---: | --- |
| `a01-a12-transition-record.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `anchor-checkpoint.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `approved-runtime-manifest.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `assignment-acknowledgement.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `assignment-receipt.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `attestation-evidence.schema.json` | Concrete/instantiable | 7 | `additionalProperties`, `allOf`, `if`, `then` |
| `audit-ledger-record.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `authority-revocation.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `authorization-a09-decision.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `candidate-qa-receipt.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `candidate-review-package.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `effective-configuration-measurement.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `evidence-acceptance-receipt.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `execution-release.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `findings-closure-receipt.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `g3-acceptance.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `governed-audit-ledger-envelope.schema.json` | Concrete/instantiable | 6 | `additionalProperties`, `allOf`, `if`, `then` |
| `independent-review-receipt.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `inference-receipt.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `ledger-head-attestation.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `model-endpoint-statement.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `nested-candidate-manifest.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `outbox-delivery.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `platform-verification-result.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `reconciliation-result.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `reinstatement-receipt.schema.json` | Concrete/instantiable | 6 | `additionalProperties`, `allOf`, `anyOf`, `if`, `then` |
| `revocation-snapshot.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf`, `oneOf` |
| `rollback-plan.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `rollback-receipt.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `separation-conflict-assessment.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `session-binding.schema.json` | Concrete/instantiable | 4 | `additionalProperties` |
| `verifier-challenge.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `verifier-verdict.schema.json` | Concrete/instantiable | 5 | `additionalProperties`, `allOf` |
| `authority-object-base.schema.json` | Definition-only helper | 0 standalone; exercised by 14 concrete dependents | `$defs`, `$ref` |
| `common.schema.json` | Definition-only helper | 0 standalone; exercised by 33 concrete dependents | `$defs`, `$ref` |

## Boundary interpretation

Every concrete schema has a complete valid document, a missing-required negative, an
undeclared-root-property negative, and a targeted constraint negative. Schemas with
`allOf`, `oneOf`, or `anyOf` also have a composition-bound negative where a concrete
composition literal is reachable. The three schemas with `if`/`then` each have a valid
triggered document and a targeted invalid document that violates the active `then`
branch.

These cases establish JSON Schema behavior only. They do not establish cross-object
identity, digest correctness, time ordering, state transitions, replay handling,
signature validity, authority, adoption, or operational enforcement.
