#!/usr/bin/env python3
"""Derive current registry-aligned Wave 0.5 design vectors.

Standard library only. This generates proposed schema-shaped objects and exact
bytes/digests; it does not execute JSON Schema validators or ES256 operations.
The filename is retained for append-only path compatibility.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any


REGISTRY_ID = "urn:au-ucr:registry:wave-0.5-contract"
REGISTRY_VERSION = "1.3.0"
BUNDLE_VERSION = "urn:au-ucr:vector-bundle:ledger-attestation:1.0.0"
EVENT_SCHEMA_ID = "urn:au-ucr:schema:governed-audit-event:1.0.0"
EVENT_ENVELOPE_SCHEMA_ID = "urn:au-ucr:schema:governed-audit-ledger-envelope:1.0.0"
ATTESTATION_SCHEMA_ID = "urn:au-ucr:schema:ledger-head-attestation:1.0.0"
SCHEMA_VERSION = "1.0.0"
CANON_ID = "CANON-JCS-RFC8785-v1"
HASH_ALGORITHM_ID = "ALG-HASH-SHA256-v1"
SIGNATURE_ALGORITHM_ID = "ALG-SIG-ES256-v1"
LEDGER_FRAMING_ID = "FRAME-GPEP-EVENT-v1"
SIGNATURE_FRAMING_ID = "FRAME-LEN-DOMAIN-v1"
LEDGER_DOMAIN = b"AU-GPEP-EVENT-v1"
ATTESTATION_DOMAIN_ID = "DOMAIN-LEDGER-HEAD-ATTEST-v1"
ATTESTATION_DOMAIN = b"AU-LEDGER-HEAD-ATTEST-v1"
ATTESTATION_KEY_PURPOSE = "KP-LEDGER-HEAD-ATTEST-v1"
SIGNING_PROFILE_ID = "PROFILE-LEDGER-HEAD-SIGNING-v1"
SIGNATURE_ENCODING_ID = "SIGENC-ES256-P1363-LOW-S-B64URL-v1"
LEDGER_ID = b"urn:uuid:11111111-1111-4111-8111-111111111111"
ZERO_HASH = bytes(32)
# Structurally valid P1363/low-S/base64url encoding of r=1,s=1. It is
# deliberately not an ES256 signature over these fixtures.
SYNTHETIC_SIGNATURE_RAW = bytes(31) + b"\x01" + bytes(31) + b"\x01"
SYNTHETIC_SIGNATURE = base64.urlsafe_b64encode(SYNTHETIC_SIGNATURE_RAW).rstrip(b"=").decode("ascii")


def u32(value: int) -> bytes:
    return value.to_bytes(4, "big", signed=False)


def u64(value: int) -> bytes:
    return value.to_bytes(8, "big", signed=False)


def jcs_subset(value: Any) -> bytes:
    """RFC 8785-compatible encoding for this restricted ASCII/integer subset."""
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def ledger_frame(domain: bytes, sequence: int, prev_hash: bytes, record_bytes: bytes) -> bytes:
    return (
        u32(len(domain))
        + domain
        + u32(len(LEDGER_ID))
        + LEDGER_ID
        + u64(sequence)
        + u32(len(prev_hash))
        + prev_hash
        + u64(len(record_bytes))
        + record_bytes
    )


def signature_frame(domain: bytes, payload: bytes) -> bytes:
    return u32(len(domain)) + domain + u64(len(payload)) + payload


def digest_ref(object_id: str, schema_id: str, fill: str) -> dict[str, Any]:
    return {
        "digest": fill * 64,
        "hash_domain": "rfc8785-jcs-utf8-sha256-v1",
        "object_id": object_id,
        "schema_id": schema_id,
    }


def governed_event(
    *,
    event_id: str,
    prior_version: int,
    new_version: int,
    requested_transition: str,
    from_status: str,
    to_status: str,
    idempotency_key: str,
    correlation_id: str,
    trusted_receipt_time: str,
) -> dict[str, Any]:
    """Exact Registry 1.2.0 Section 6 record_without_hash projection."""
    return {
        "actor_id": "urn:example:actor:synthetic",
        "algorithm_registry_digest": "c" * 64,
        "correlation_id": correlation_id,
        "decision": "ALLOW",
        "dependency_registry_digest": "d" * 64,
        "event_id": event_id,
        "evidence_bundle_digest": "f" * 64,
        "from_status": from_status,
        "idempotency_key": idempotency_key,
        "interface_id": "IF-15",
        "interface_inventory_id": "urn:example:interface:synthetic-api",
        "new_object_version": new_version,
        "object_id": "urn:example:object:synthetic",
        "policy_digest": "a" * 64,
        "prior_object_version": prior_version,
        "reason_codes": [],
        "reason_registry_digest": "e" * 64,
        "requested_transition": requested_transition,
        "schema_bundle_digest": "b" * 64,
        "schema_id": EVENT_SCHEMA_ID,
        "schema_version": SCHEMA_VERSION,
        "to_status": to_status,
        "transaction_outcome": "COMMITTED",
        "trusted_receipt_time": trusted_receipt_time,
        "workload_identity": "urn:example:service:gpep-synthetic",
    }


def ledger_material(
    record: dict[str, Any],
    sequence: int,
    prev_hash: bytes,
    *,
    domain: bytes = LEDGER_DOMAIN,
) -> dict[str, Any]:
    record_bytes = jcs_subset(record)
    preimage = ledger_frame(domain, sequence, prev_hash, record_bytes)
    record_hash = sha256_hex(preimage)
    envelope = {
        "contract_status": "PROPOSED_NOT_ADOPTED",
        "domain_ascii": domain.decode("ascii"),
        "framing_id": LEDGER_FRAMING_ID,
        "ledger_id": LEDGER_ID.decode("ascii"),
        "prev_hash": prev_hash.hex(),
        "record_hash": record_hash,
        "record_without_hash": record,
        "sequence": sequence,
    }
    return {
        "encoded_lengths_hex": {
            "domain_len32": u32(len(domain)).hex(),
            "ledger_id_len32": u32(len(LEDGER_ID)).hex(),
            "prev_hash_len32": u32(len(prev_hash)).hex(),
            "record_len64": u64(len(record_bytes)).hex(),
        },
        "framed_preimage_hex": preimage.hex(),
        "framed_preimage_length": len(preimage),
        "ledger_envelope": envelope,
        "prev_hash_raw_hex": prev_hash.hex(),
        "record_hash": record_hash,
        "record_jcs_utf8_hex": record_bytes.hex(),
        "record_length": len(record_bytes),
        "record_without_hash": record,
        "sequence": sequence,
        "sequence_uint64be_hex": u64(sequence).hex(),
    }


def attestation_material(
    *,
    sequence: int,
    head_hash: str,
    object_suffix: str,
    schema_id: str = ATTESTATION_SCHEMA_ID,
    schema_version: str = SCHEMA_VERSION,
    key_purpose: str = ATTESTATION_KEY_PURPOSE,
) -> dict[str, Any]:
    envelope_binding = {
        "algorithm_id": SIGNATURE_ALGORITHM_ID,
        "algorithm_registry_digest": "3" * 64,
        "audience": "urn:au-ucr:audience:ledger-chain-verifier",
        "authority_counter": sequence + 1,
        "candidate_commit": "39bade0506b4d5b12bb979ccf6a51bb11944a9ff",
        "canonicalization_id": CANON_ID,
        "contract_status": "PROPOSED_NOT_ADOPTED",
        "dependency_registry_digest": "4" * 64,
        "domain_id": ATTESTATION_DOMAIN_ID,
        "environment": "DESIGN",
        "event_id": f"urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb{object_suffix}",
        "expires_at": "2026-10-12T10:40:00Z",
        "framing_id": SIGNATURE_FRAMING_ID,
        "interface_id": "IF-17",
        "issued_at": "2026-10-12T10:32:00Z",
        "key_purpose_id": key_purpose,
        "nonce": "8" * 64,
        "not_before": "2026-10-12T10:32:00Z",
        "object_id": f"urn:uuid:cccccccc-cccc-4ccc-8ccc-ccccccccccc{object_suffix}",
        "object_type": "LEDGER_HEAD_ATTESTATION",
        "policy_digest": "a" * 64,
        "previous_event_digest": "0" * 64,
        "producer_assignment_ref": digest_ref(
            "urn:example:assignment:ledger-head-attestor",
            "urn:au-ucr:schema:assignment-receipt:1.0.0",
            "1",
        ),
        "producer_id": "urn:example:service:ledger-head-attestor",
        "producer_role": "LEDGER_HEAD_ATTESTOR",
        "publication_manifest_digest": "2" * 64,
        "reason_registry_digest": "5" * 64,
        "repository_id": "mrrobot787/starnet",
        "revocation_epoch": 0,
        "schema_bundle_digest": "b" * 64,
        "schema_id": schema_id,
        "schema_version": schema_version,
        "signing_profile_id": SIGNING_PROFILE_ID,
    }
    body = {
        "head_hash": head_hash,
        "ledger_id": LEDGER_ID.decode("ascii"),
        "policy_digest": "a" * 64,
        "prior_checkpoint_ref": digest_ref(
            "urn:example:checkpoint:prior",
            "urn:au-ucr:schema:anchor-checkpoint:1.0.0",
            "6",
        ),
        "sequence": sequence,
        "verified_at": "2026-10-12T10:32:01Z",
    }
    # Vector-local, explicitly documented signing projection. The corrected
    # schemas require payload_digest/signature but do not define how to exclude
    # those fields from their own digest, so this projection remains a stated
    # verification limit rather than an adopted rule.
    signing_payload = {"envelope_binding": envelope_binding, **body}
    payload_bytes = jcs_subset(signing_payload)
    payload_digest = sha256_hex(payload_bytes)
    signature_input = signature_frame(ATTESTATION_DOMAIN, payload_bytes)
    envelope = {
        **envelope_binding,
        "payload_digest": payload_digest,
        "signature": {
            "algorithm_id": SIGNATURE_ALGORITHM_ID,
            "key_id": "urn:example:key:ledger-head-attestor",
            "key_purpose_id": key_purpose,
            "key_status_digest": "7" * 64,
            "payload_digest": payload_digest,
            "signature_encoding_id": SIGNATURE_ENCODING_ID,
            "signature_value": SYNTHETIC_SIGNATURE,
            "trust_chain_digest": "9" * 64,
        },
    }
    attestation_object = {"envelope": envelope, **body}
    return {
        "attestation_object": attestation_object,
        "domain_ascii": ATTESTATION_DOMAIN.decode("ascii"),
        "domain_hex": ATTESTATION_DOMAIN.hex(),
        "domain_id": ATTESTATION_DOMAIN_ID,
        "encoded_lengths_hex": {
            "domain_len32": u32(len(ATTESTATION_DOMAIN)).hex(),
            "payload_len64": u64(len(payload_bytes)).hex(),
        },
        "signature_input_hex": signature_input.hex(),
        "signature_input_length": len(signature_input),
        "signature_input_sha256": sha256_hex(signature_input),
        "signing_payload": signing_payload,
        "signing_payload_jcs_utf8_hex": payload_bytes.hex(),
        "signing_payload_length": len(payload_bytes),
        "signing_projection_status": "AUTHORITATIVE_PROPOSED_DESIGN_REGISTRY_1_3",
    }


def expected(result: str, decision: str, detector: str, reasons: list[str]) -> dict[str, Any]:
    return {
        "consumer_decision": decision,
        "detector_interface": detector,
        "reason_codes": reasons,
        "result": result,
    }


def main() -> None:
    genesis_record = governed_event(
        event_id="urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0",
        prior_version=0,
        new_version=1,
        requested_transition="A01:NOT_STARTED->IN_PROGRESS",
        from_status="NOT_STARTED",
        to_status="IN_PROGRESS",
        idempotency_key="synthetic-idempotency-1",
        correlation_id="synthetic-correlation-1",
        trusted_receipt_time="2026-10-12T10:30:00Z",
    )
    genesis = ledger_material(genesis_record, 0, ZERO_HASH)

    successor_record = governed_event(
        event_id="urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        prior_version=1,
        new_version=2,
        requested_transition="A01:IN_PROGRESS->READY",
        from_status="IN_PROGRESS",
        to_status="READY",
        idempotency_key="synthetic-idempotency-2",
        correlation_id="synthetic-correlation-2",
        trusted_receipt_time="2026-10-12T10:31:00Z",
    )
    successor = ledger_material(successor_record, 1, bytes.fromhex(genesis["record_hash"]))

    single_attestation = attestation_material(
        sequence=0, head_hash=genesis["record_hash"], object_suffix="0"
    )
    chain_attestation = attestation_material(
        sequence=1, head_hash=successor["record_hash"], object_suffix="1"
    )

    changed_record = dict(genesis_record)
    changed_record["correlation_id"] = "synthetic-correlation-tampered"
    changed = ledger_material(changed_record, 0, ZERO_HASH)
    supplied_changed_envelope = dict(changed["ledger_envelope"])
    supplied_changed_envelope["record_hash"] = genesis["record_hash"]

    wrong_domain = b"AU-GPEP-EVENT-v2"
    wrong_domain_material = ledger_material(genesis_record, 0, ZERO_HASH, domain=wrong_domain)
    genesis_record_bytes = bytes.fromhex(genesis["record_jcs_utf8_hex"])
    ambiguous = LEDGER_DOMAIN + LEDGER_ID + u64(0) + ZERO_HASH + genesis_record_bytes
    truncated = bytes.fromhex(genesis["framed_preimage_hex"])[:-1]

    version_mismatch = attestation_material(
        sequence=0,
        head_hash=genesis["record_hash"],
        object_suffix="2",
        schema_id="urn:au-ucr:schema:ledger-head-attestation:2.0.0",
        schema_version="2.0.0",
    )
    unauthorized = attestation_material(
        sequence=0,
        head_hash=genesis["record_hash"],
        object_suffix="3",
        key_purpose="KP-TMC-RUNTIME-v1",
    )
    sequence_gap = ledger_material(
        successor_record, 2, bytes.fromhex(genesis["record_hash"])
    )
    fork_record = dict(successor_record)
    fork_record["event_id"] = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
    fork_record["correlation_id"] = "synthetic-correlation-fork"
    fork = ledger_material(fork_record, 1, bytes.fromhex(genesis["record_hash"]))
    wrong_predecessor = ledger_material(successor_record, 1, bytes.fromhex("1" * 64))
    duplicate_record = governed_event(
        event_id="urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        prior_version=2,
        new_version=3,
        requested_transition="A01:READY->PASSED",
        from_status="READY",
        to_status="PASSED",
        idempotency_key="synthetic-idempotency-3",
        correlation_id="synthetic-correlation-duplicate-sequence",
        trusted_receipt_time="2026-10-12T10:32:00Z",
    )
    duplicate_sequence = ledger_material(
        duplicate_record, 1, bytes.fromhex(successor["record_hash"])
    )
    unauthorized_transition_record = governed_event(
        event_id="urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        prior_version=2,
        new_version=3,
        requested_transition="A01:SUPERSEDED->IN_PROGRESS",
        from_status="SUPERSEDED",
        to_status="IN_PROGRESS",
        idempotency_key="synthetic-idempotency-unauthorized-transition",
        correlation_id="synthetic-correlation-unauthorized-transition",
        trusted_receipt_time="2026-10-12T10:32:00Z",
    )
    unauthorized_transition = ledger_material(
        unauthorized_transition_record, 2, bytes.fromhex(successor["record_hash"])
    )

    bundle = {
        "algorithms": {
            "canonicalization_id": CANON_ID,
            "hash_algorithm_id": HASH_ALGORITHM_ID,
            "signature_algorithm_id": SIGNATURE_ALGORITHM_ID,
        },
        "bundle_version": BUNDLE_VERSION,
        "classification": "PROPOSED_DESIGN_VECTORS_NOT_VALIDATOR_OR_CRYPTO_VERIFIED",
        "contracts": {
            "attestation_domain_ascii": ATTESTATION_DOMAIN.decode("ascii"),
            "attestation_domain_hex": ATTESTATION_DOMAIN.hex(),
            "attestation_domain_id": ATTESTATION_DOMAIN_ID,
            "attestation_key_purpose_id": ATTESTATION_KEY_PURPOSE,
            "attestation_signing_profile_id": SIGNING_PROFILE_ID,
            "attestation_signature_encoding_id": SIGNATURE_ENCODING_ID,
            "attestation_schema_id": ATTESTATION_SCHEMA_ID,
            "event_envelope_schema_id": EVENT_ENVELOPE_SCHEMA_ID,
            "event_schema_id": EVENT_SCHEMA_ID,
            "ledger_domain_ascii": LEDGER_DOMAIN.decode("ascii"),
            "ledger_domain_hex": LEDGER_DOMAIN.hex(),
            "ledger_framing_id": LEDGER_FRAMING_ID,
            "ledger_id_ascii": LEDGER_ID.decode("ascii"),
            "ledger_input": "len32(domain)||domain||len32(ledger_id)||ledger_id||uint64be(sequence)||len32(prev_hash)||prev_hash||len64(record_bytes)||record_bytes",
            "registry_id": REGISTRY_ID,
            "registry_version": REGISTRY_VERSION,
            "schema_version": SCHEMA_VERSION,
            "signature_coverage": "AUTHORITATIVE_SEVEN_FIELD_PROJECTION_SYNTHETIC_P1363_VALUE_NOT_ES256_VERIFIED",
            "signature_framing_id": SIGNATURE_FRAMING_ID,
            "signature_input": "len32(domain)||domain||len64(signing_payload_bytes)||signing_payload_bytes",
            "verification_order": [
                "1_FRAMING_BOUNDS",
                "2_STRICT_PARSE_SCHEMA_PROFILE_VERSION",
                "3_INTERFACE_KIND_ALGORITHM_DOMAIN_PURPOSE",
                "4_SEVEN_FIELD_PROJECTION_AND_PAYLOAD_DIGEST",
                "5_SIGNATURE_ENCODING_KEY_AUTHORITY_REPLAY",
                "6_ES256_OVER_EXACT_FRAMED_INPUT",
                "7_LEDGER_CHAIN_POLICY_CHECKPOINT_FRESHNESS",
            ],
        },
        "direct_schema_instance_design_mapping": {
            "direct_schema_instance_occurrences": 8,
            "families": 3,
            "valid_logical_object_occurrences": 5,
            "note": "Three logical ledger records each map to a governed-event payload schema and an external ledger-envelope schema; two ledger-head attestations map to their schema. No validator was run.",
        },
        "vector_count": 14,
        "vectors": [
            {
                "attestation": single_attestation,
                "expected": expected("ALLOW", "ALLOW", "IF-17", []),
                "id": "W05-VEC-001",
                "kind": "positive",
                "ledger_records": [genesis],
                "title": "valid single genesis record and ledger-head attestation",
            },
            {
                "attestation": chain_attestation,
                "expected": expected("ALLOW", "ALLOW", "IF-17", []),
                "id": "W05-VEC-002",
                "kind": "positive",
                "ledger_records": [genesis, successor],
                "title": "valid two-record chain and ledger-head attestation",
            },
            {
                "claimed_record_hash": genesis["record_hash"],
                "derived_record_hash": changed["record_hash"],
                "expected": expected("REJECT", "SUSPEND", "IF-16", ["E_HASH_MISMATCH"]),
                "id": "W05-VEC-003",
                "kind": "negative",
                "ledger_record": changed,
                "supplied_ledger_envelope": supplied_changed_envelope,
                "title": "changed schema-shaped payload with stale claimed hash",
            },
            {
                "expected": expected("REJECT", "DENY", "IF-16", ["E_DOMAIN_MISMATCH"]),
                "id": "W05-VEC-004",
                "kind": "negative",
                "ledger_record": wrong_domain_material,
                "title": "wrong registered ledger domain",
            },
            {
                "expected": expected("REJECT", "DENY", "IF-16", ["E_FRAMING_AMBIGUOUS"]),
                "id": "W05-VEC-005",
                "input_hex": ambiguous.hex(),
                "input_length": len(ambiguous),
                "input_sha256": sha256_hex(ambiguous),
                "kind": "negative",
                "title": "ambiguous unframed field concatenation",
            },
            {
                "available_record_length": genesis["record_length"] - 1,
                "declared_record_length": genesis["record_length"],
                "expected": expected("REJECT", "DENY", "IF-16", ["E_TRUNCATED_INPUT"]),
                "id": "W05-VEC-006",
                "input_hex": truncated.hex(),
                "input_length": len(truncated),
                "input_sha256": sha256_hex(truncated),
                "kind": "negative",
                "title": "truncated framed ledger input",
            },
            {
                "attestation": version_mismatch,
                "expected": expected("REJECT", "BLOCK", "IF-17", ["E_VERSION_UNSUPPORTED"]),
                "id": "W05-VEC-007",
                "kind": "negative",
                "title": "unsupported ledger-head attestation major version",
            },
            {
                "attestation": unauthorized,
                "expected": expected("REJECT", "DENY", "IF-17", ["E_KEY_PURPOSE"]),
                "id": "W05-VEC-008",
                "kind": "negative",
                "title": "registered but unauthorized signature key purpose",
            },
            {
                "expected": expected("REJECT", "SUSPEND", "IF-17", ["E_INTEGRITY"]),
                "id": "W05-VEC-009",
                "kind": "negative",
                "ledger_record": sequence_gap,
                "predecessor_sequence": 0,
                "title": "sequence gap after genesis",
            },
            {
                "branch_a_record_hash": successor["record_hash"],
                "expected": expected("REJECT", "SUSPEND", "IF-17", ["E_INTEGRITY"]),
                "id": "W05-VEC-010",
                "kind": "negative",
                "ledger_record": fork,
                "title": "competing fork at the same predecessor and sequence",
            },
            {
                "expected_predecessor_hash": genesis["record_hash"],
                "expected": expected("REJECT", "SUSPEND", "IF-17", ["E_HASH_MISMATCH"]),
                "id": "W05-VEC-011",
                "kind": "negative",
                "ledger_record": wrong_predecessor,
                "title": "wrong raw predecessor hash",
            },
            {
                "expected": expected("REJECT", "SUSPEND", "IF-17", ["E_INTEGRITY"]),
                "id": "W05-VEC-012",
                "kind": "negative",
                "ledger_record": duplicate_sequence,
                "prior_accepted_sequence": 1,
                "title": "duplicate sequence on attempted continuation",
            },
            {
                "expected": expected("REJECT", "DENY", "IF-15", ["E_TRANSITION"]),
                "id": "W05-VEC-013",
                "kind": "negative",
                "ledger_record": unauthorized_transition,
                "title": "schema-shaped but unauthorized state transition",
            },
            {
                "attestation": single_attestation,
                "expected": expected("REJECT", "DENY", "IF-17", ["E_REPLAY"]),
                "id": "W05-VEC-014",
                "kind": "negative",
                "replay_of": "W05-VEC-001/attestation",
                "title": "exact ledger-head attestation nonce and object replay",
            },
        ],
    }

    output = Path(__file__).with_name("W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json")
    output.write_text(
        json.dumps(bundle, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    raw = output.read_bytes()
    print(f"output={output.name}")
    print(f"vectors={bundle['vector_count']}")
    print(f"direct_schema_instance_design_mappings={bundle['direct_schema_instance_design_mapping']['direct_schema_instance_occurrences']}")
    print(f"bytes={len(raw)}")
    print(f"sha256={sha256_hex(raw)}")
    print(f"genesis_record_hash={genesis['record_hash']}")
    print(f"successor_record_hash={successor['record_hash']}")
    print(f"single_attestation_input_sha256={single_attestation['signature_input_sha256']}")
    print(f"chain_attestation_input_sha256={chain_attestation['signature_input_sha256']}")


if __name__ == "__main__":
    main()
