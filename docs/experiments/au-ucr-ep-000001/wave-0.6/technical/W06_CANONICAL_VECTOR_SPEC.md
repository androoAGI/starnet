# Wave 0.6 Canonical Vector Specification

## Frozen family

- Bundle ID: `urn:au-ucr:vector-bundle:ledger-attestation:1.0.0`
- Registry: `urn:au-ucr:registry:wave-0.5-contract:1.3.0`
- File: `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json`
- SHA-256: `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`
- Scenarios: 14: two `ALLOW`, twelve `REJECT`
- Status: `FINAL_CANONICAL_DESIGN_VECTORS_NOT_ADOPTED`

The retained `W05` filename and family version preserve byte identity and lineage. This Wave 0.6
record freezes those bytes; it does not rename or regenerate the family merely to change phase
metadata.

## Normative profiles

Ledger events use `urn:au-ucr:schema:governed-audit-event:1.0.0`,
`urn:au-ucr:schema:governed-audit-ledger-envelope:1.0.0`,
`FRAME-GPEP-EVENT-v1`, and exact domain `AU-GPEP-EVENT-v1`.

Ledger-head attestations use `urn:au-ucr:schema:ledger-head-attestation:1.0.0`,
`PROFILE-LEDGER-HEAD-SIGNING-v1`, `FRAME-LEN-DOMAIN-v1`,
`DOMAIN-LEDGER-HEAD-ATTEST-v1`, exact 24-byte ASCII domain
`AU-LEDGER-HEAD-ATTEST-v1`, `KP-LEDGER-HEAD-ATTEST-v1`, and
`SIGENC-ES256-P1363-LOW-S-B64URL-v1`.

The signing projection contains exactly `envelope_binding`, `ledger_id`, `sequence`, `head_hash`,
`policy_digest`, `prior_checkpoint_ref`, and `verified_at`. `envelope_binding` includes every
present envelope member except `payload_digest` and `signature`.

## Scenario oracle

- `W05-VEC-001` and `W05-VEC-002`: `ALLOW`, `IF-17`, no reasons.
- `W05-VEC-003`: `REJECT/SUSPEND`, `IF-16`, `E_HASH_MISMATCH`.
- `W05-VEC-004`: `REJECT/DENY`, `IF-16`, `E_DOMAIN_MISMATCH`.
- `W05-VEC-005`: `REJECT/DENY`, `IF-16`, `E_FRAMING_AMBIGUOUS`.
- `W05-VEC-006`: `REJECT/DENY`, `IF-16`, `E_TRUNCATED_INPUT`.
- `W05-VEC-007`: `REJECT/BLOCK`, `IF-17`, `E_VERSION_UNSUPPORTED`.
- `W05-VEC-008`: `REJECT/DENY`, `IF-17`, `E_KEY_PURPOSE`.
- `W05-VEC-009`, `010`, and `012`: `REJECT/SUSPEND`, `IF-17`, `E_INTEGRITY`.
- `W05-VEC-011`: `REJECT/SUSPEND`, `IF-17`, `E_HASH_MISMATCH`.
- `W05-VEC-013`: `REJECT/DENY`, `IF-15`, `E_TRANSITION`.
- `W05-VEC-014`: `REJECT/DENY`, `IF-17`, `E_REPLAY`.

The 64-byte P1363 `r=1,s=1` value is a synthetic shape sentinel, not a valid ES256 signature.
Accordingly, the positive scenarios prove deterministic construction and schema shape only.
They do not prove cryptographic verification, trust, authority, adoption, or consumer behavior.
