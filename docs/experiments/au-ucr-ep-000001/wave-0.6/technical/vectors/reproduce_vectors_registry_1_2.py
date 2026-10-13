#!/usr/bin/env python3
"""Reproduce current registry-aligned vector bytes with Python stdlib.

Does not import the generator. This is a same-author design consistency check,
not JSON Schema validation, ES256 verification, or independent assurance.
The filename is retained for append-only path compatibility.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any


EVENT_KEYS = {
    "actor_id",
    "algorithm_registry_digest",
    "correlation_id",
    "decision",
    "dependency_registry_digest",
    "event_id",
    "evidence_bundle_digest",
    "from_status",
    "idempotency_key",
    "interface_id",
    "interface_inventory_id",
    "new_object_version",
    "object_id",
    "policy_digest",
    "prior_object_version",
    "reason_codes",
    "reason_registry_digest",
    "requested_transition",
    "schema_bundle_digest",
    "schema_id",
    "schema_version",
    "to_status",
    "transaction_outcome",
    "trusted_receipt_time",
    "workload_identity",
}
LEDGER_ENVELOPE_KEYS = {
    "contract_status",
    "domain_ascii",
    "framing_id",
    "ledger_id",
    "prev_hash",
    "record_hash",
    "record_without_hash",
    "sequence",
}
ATTESTATION_KEYS = {
    "envelope",
    "head_hash",
    "ledger_id",
    "policy_digest",
    "prior_checkpoint_ref",
    "sequence",
    "verified_at",
}
LEDGER_DOMAIN = b"AU-GPEP-EVENT-v1"
ATTESTATION_DOMAIN = b"AU-LEDGER-HEAD-ATTEST-v1"
P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def jcs_subset(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def u32(value: int) -> bytes:
    return value.to_bytes(4, "big", signed=False)


def u64(value: int) -> bytes:
    return value.to_bytes(8, "big", signed=False)


def h(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def ledger_frame(domain: bytes, ledger_id: bytes, sequence: int,
                 prev_hash: bytes, record_bytes: bytes) -> bytes:
    return (
        u32(len(domain))
        + domain
        + u32(len(ledger_id))
        + ledger_id
        + u64(sequence)
        + u32(len(prev_hash))
        + prev_hash
        + u64(len(record_bytes))
        + record_bytes
    )


def signature_frame(domain: bytes, payload: bytes) -> bytes:
    return u32(len(domain)) + domain + u64(len(payload)) + payload


path = Path(__file__).with_name("W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json")
raw = path.read_bytes()
bundle = json.loads(raw)
vectors = {item["id"]: item for item in bundle["vectors"]}
contracts = bundle["contracts"]

if len(vectors) != 14 or bundle["vector_count"] != 14:
    raise SystemExit("MISMATCH vector count")
if contracts["registry_version"] != "1.3.0":
    raise SystemExit("MISMATCH registry version")
if contracts["ledger_domain_ascii"].encode("ascii") != LEDGER_DOMAIN:
    raise SystemExit("MISMATCH ledger domain")
if contracts["attestation_domain_ascii"].encode("ascii") != ATTESTATION_DOMAIN:
    raise SystemExit("MISMATCH attestation domain")
if (
    contracts["attestation_signing_profile_id"] != "PROFILE-LEDGER-HEAD-SIGNING-v1"
    or contracts["attestation_signature_encoding_id"]
    != "SIGENC-ES256-P1363-LOW-S-B64URL-v1"
):
    raise SystemExit("MISMATCH signing profile metadata")
if contracts["verification_order"] != [
    "1_FRAMING_BOUNDS",
    "2_STRICT_PARSE_SCHEMA_PROFILE_VERSION",
    "3_INTERFACE_KIND_ALGORITHM_DOMAIN_PURPOSE",
    "4_SEVEN_FIELD_PROJECTION_AND_PAYLOAD_DIGEST",
    "5_SIGNATURE_ENCODING_KEY_AUTHORITY_REPLAY",
    "6_ES256_OVER_EXACT_FRAMED_INPUT",
    "7_LEDGER_CHAIN_POLICY_CHECKPOINT_FRESHNESS",
]:
    raise SystemExit("MISMATCH verification order")

semantic_byte_checks = 0
digest_checks = 0
schema_design_mapping_checks = 0
signature_profile_checks = 0


def check_ledger(label: str, material: dict[str, Any], *,
                 expected_domain: bytes = LEDGER_DOMAIN,
                 direct_schema_design: bool = False) -> None:
    global semantic_byte_checks, digest_checks, schema_design_mapping_checks
    record = material["record_without_hash"]
    envelope = material["ledger_envelope"]
    if set(record) != EVENT_KEYS:
        raise SystemExit(f"MISMATCH {label}: governed-event projection")
    if set(envelope) != LEDGER_ENVELOPE_KEYS:
        raise SystemExit(f"MISMATCH {label}: ledger envelope projection")
    if envelope["record_without_hash"] != record:
        raise SystemExit(f"MISMATCH {label}: nested record")
    if record["schema_id"] != "urn:au-ucr:schema:governed-audit-event:1.0.0":
        raise SystemExit(f"MISMATCH {label}: event schema ID")
    if record["schema_version"] != "1.0.0":
        raise SystemExit(f"MISMATCH {label}: event schema version")
    if record["decision"] != "ALLOW" or record["reason_codes"] != []:
        raise SystemExit(f"MISMATCH {label}: event decision")
    if record["interface_id"] != "IF-15" or record["transaction_outcome"] != "COMMITTED":
        raise SystemExit(f"MISMATCH {label}: event interface/outcome")
    record_bytes = jcs_subset(record)
    ledger_id = envelope["ledger_id"].encode("ascii")
    prev_hash = bytes.fromhex(envelope["prev_hash"])
    domain = envelope["domain_ascii"].encode("ascii")
    preimage = ledger_frame(domain, ledger_id, envelope["sequence"], prev_hash, record_bytes)
    if domain != expected_domain:
        raise SystemExit(f"MISMATCH {label}: supplied domain")
    if record_bytes.hex() != material["record_jcs_utf8_hex"]:
        raise SystemExit(f"MISMATCH {label}: record bytes")
    if preimage.hex() != material["framed_preimage_hex"]:
        raise SystemExit(f"MISMATCH {label}: framed bytes")
    if h(preimage) != material["record_hash"]:
        raise SystemExit(f"MISMATCH {label}: record hash")
    if envelope["record_hash"] != material["record_hash"]:
        raise SystemExit(f"MISMATCH {label}: envelope hash")
    semantic_byte_checks += 1
    digest_checks += 1
    if direct_schema_design:
        if (
            envelope["contract_status"] != "PROPOSED_NOT_ADOPTED"
            or envelope["framing_id"] != "FRAME-GPEP-EVENT-v1"
            or envelope["domain_ascii"] != "AU-GPEP-EVENT-v1"
        ):
            raise SystemExit(f"MISMATCH {label}: envelope registered identifiers")
        # The canonical payload and its external ledger envelope are separate
        # direct schema instances.
        schema_design_mapping_checks += 2


def check_attestation(label: str, material: dict[str, Any], *,
                      direct_schema_design: bool = False) -> None:
    global semantic_byte_checks, digest_checks, schema_design_mapping_checks, signature_profile_checks
    obj = material["attestation_object"]
    envelope = obj["envelope"]
    if set(obj) != ATTESTATION_KEYS:
        raise SystemExit(f"MISMATCH {label}: attestation object projection")
    payload = material["signing_payload"]
    if set(payload) != {
        "envelope_binding",
        "ledger_id",
        "sequence",
        "head_hash",
        "policy_digest",
        "prior_checkpoint_ref",
        "verified_at",
    }:
        raise SystemExit(f"MISMATCH {label}: authoritative seven-field signing projection")
    expected_binding = {
        key: value
        for key, value in envelope.items()
        if key not in {"payload_digest", "signature"}
    }
    if payload["envelope_binding"] != expected_binding:
        raise SystemExit(f"MISMATCH {label}: envelope binding inclusion/exclusion")
    payload_bytes = jcs_subset(payload)
    framed = signature_frame(material["domain_ascii"].encode("ascii"), payload_bytes)
    payload_digest = h(payload_bytes)
    if payload_bytes.hex() != material["signing_payload_jcs_utf8_hex"]:
        raise SystemExit(f"MISMATCH {label}: signing payload bytes")
    if framed.hex() != material["signature_input_hex"]:
        raise SystemExit(f"MISMATCH {label}: signature input bytes")
    if h(framed) != material["signature_input_sha256"]:
        raise SystemExit(f"MISMATCH {label}: signature input digest")
    if envelope["payload_digest"] != payload_digest:
        raise SystemExit(f"MISMATCH {label}: envelope payload digest")
    if envelope["signature"]["payload_digest"] != payload_digest:
        raise SystemExit(f"MISMATCH {label}: nested payload digest")
    if envelope["key_purpose_id"] != envelope["signature"]["key_purpose_id"]:
        raise SystemExit(f"MISMATCH {label}: purpose disagreement")
    if envelope["signing_profile_id"] != "PROFILE-LEDGER-HEAD-SIGNING-v1":
        raise SystemExit(f"MISMATCH {label}: signing profile")
    signature = envelope["signature"]
    if signature["signature_encoding_id"] != "SIGENC-ES256-P1363-LOW-S-B64URL-v1":
        raise SystemExit(f"MISMATCH {label}: signature encoding ID")
    encoded = signature["signature_value"]
    if "=" in encoded:
        raise SystemExit(f"MISMATCH {label}: padded signature encoding")
    raw_signature = base64.urlsafe_b64decode(encoded + "==")
    if len(raw_signature) != 64:
        raise SystemExit(f"MISMATCH {label}: P1363 signature width")
    r = int.from_bytes(raw_signature[:32], "big")
    s = int.from_bytes(raw_signature[32:], "big")
    if not (1 <= r < P256_ORDER and 1 <= s <= P256_ORDER // 2):
        raise SystemExit(f"MISMATCH {label}: P1363 range/low-S shape")
    semantic_byte_checks += 1
    digest_checks += 2
    signature_profile_checks += 1
    if direct_schema_design:
        required = {
            "contract_status",
            "schema_id",
            "schema_version",
            "object_type",
            "object_id",
            "event_id",
            "interface_id",
            "producer_id",
            "producer_role",
            "producer_assignment_ref",
            "algorithm_id",
            "key_purpose_id",
            "canonicalization_id",
            "framing_id",
            "signing_profile_id",
            "domain_id",
            "issued_at",
            "not_before",
            "expires_at",
            "authority_counter",
            "previous_event_digest",
            "audience",
            "environment",
            "repository_id",
            "candidate_commit",
            "publication_manifest_digest",
            "policy_digest",
            "schema_bundle_digest",
            "algorithm_registry_digest",
            "dependency_registry_digest",
            "reason_registry_digest",
            "revocation_epoch",
            "nonce",
            "payload_digest",
            "signature",
        }
        if set(envelope) != required:
            raise SystemExit(f"MISMATCH {label}: signed envelope projection")
        if (
            envelope["schema_id"] != "urn:au-ucr:schema:ledger-head-attestation:1.0.0"
            or envelope["schema_version"] != "1.0.0"
            or envelope["object_type"] != "LEDGER_HEAD_ATTESTATION"
            or envelope["interface_id"] != "IF-17"
            or envelope["canonicalization_id"] != "CANON-JCS-RFC8785-v1"
            or envelope["framing_id"] != "FRAME-LEN-DOMAIN-v1"
            or envelope["domain_id"] != "DOMAIN-LEDGER-HEAD-ATTEST-v1"
            or envelope["signing_profile_id"] != "PROFILE-LEDGER-HEAD-SIGNING-v1"
            or envelope["key_purpose_id"] != "KP-LEDGER-HEAD-ATTEST-v1"
        ):
            raise SystemExit(f"MISMATCH {label}: registered attestation identifiers")
        schema_design_mapping_checks += 1


for vector_id in ("W05-VEC-001", "W05-VEC-002"):
    vector = vectors[vector_id]
    for index, record in enumerate(vector["ledger_records"]):
        check_ledger(f"{vector_id}/ledger/{index}", record, direct_schema_design=True)
    check_attestation(f"{vector_id}/attestation", vector["attestation"], direct_schema_design=True)
    if vector["expected"] != {
        "consumer_decision": "ALLOW",
        "detector_interface": "IF-17",
        "reason_codes": [],
        "result": "ALLOW",
    }:
        raise SystemExit(f"MISMATCH {vector_id}: positive expectation")

changed = vectors["W05-VEC-003"]
check_ledger("W05-VEC-003/changed", changed["ledger_record"])
if changed["derived_record_hash"] == changed["claimed_record_hash"]:
    raise SystemExit("MISMATCH W05-VEC-003: hash must change")
if changed["supplied_ledger_envelope"]["record_hash"] != changed["claimed_record_hash"]:
    raise SystemExit("MISMATCH W05-VEC-003: stale supplied hash")

wrong_domain = vectors["W05-VEC-004"]
check_ledger(
    "W05-VEC-004/wrong-domain",
    wrong_domain["ledger_record"],
    expected_domain=b"AU-GPEP-EVENT-v2",
)

for vector_id in ("W05-VEC-005", "W05-VEC-006"):
    vector = vectors[vector_id]
    if h(bytes.fromhex(vector["input_hex"])) != vector["input_sha256"]:
        raise SystemExit(f"MISMATCH {vector_id}: raw input digest")
    digest_checks += 1

version = vectors["W05-VEC-007"]
check_attestation("W05-VEC-007/version", version["attestation"])
if (
    version["attestation"]["attestation_object"]["envelope"]["schema_id"]
    != "urn:au-ucr:schema:ledger-head-attestation:2.0.0"
    or version["expected"]["reason_codes"] != ["E_VERSION_UNSUPPORTED"]
    or version["expected"]["consumer_decision"] != "BLOCK"
):
    raise SystemExit("MISMATCH W05-VEC-007 oracle")

unauthorized = vectors["W05-VEC-008"]
check_attestation("W05-VEC-008/purpose", unauthorized["attestation"])
if (
    unauthorized["attestation"]["attestation_object"]["envelope"]["key_purpose_id"]
    != "KP-TMC-RUNTIME-v1"
    or unauthorized["expected"]["reason_codes"] != ["E_KEY_PURPOSE"]
    or unauthorized["expected"]["consumer_decision"] != "DENY"
):
    raise SystemExit("MISMATCH W05-VEC-008 oracle")

sequence_gap = vectors["W05-VEC-009"]
check_ledger("W05-VEC-009/sequence-gap", sequence_gap["ledger_record"])
if (
    sequence_gap["predecessor_sequence"] != 0
    or sequence_gap["ledger_record"]["sequence"] != 2
):
    raise SystemExit("MISMATCH W05-VEC-009 sequence gap")

fork = vectors["W05-VEC-010"]
check_ledger("W05-VEC-010/fork", fork["ledger_record"])
if (
    fork["ledger_record"]["sequence"] != 1
    or fork["ledger_record"]["prev_hash_raw_hex"]
    != vectors["W05-VEC-002"]["ledger_records"][1]["prev_hash_raw_hex"]
    or fork["ledger_record"]["record_hash"] == fork["branch_a_record_hash"]
):
    raise SystemExit("MISMATCH W05-VEC-010 fork")

wrong_predecessor = vectors["W05-VEC-011"]
check_ledger("W05-VEC-011/wrong-predecessor", wrong_predecessor["ledger_record"])
if (
    wrong_predecessor["ledger_record"]["prev_hash_raw_hex"]
    == wrong_predecessor["expected_predecessor_hash"]
):
    raise SystemExit("MISMATCH W05-VEC-011 predecessor")

duplicate_sequence = vectors["W05-VEC-012"]
check_ledger("W05-VEC-012/duplicate-sequence", duplicate_sequence["ledger_record"])
if (
    duplicate_sequence["ledger_record"]["sequence"]
    != duplicate_sequence["prior_accepted_sequence"]
):
    raise SystemExit("MISMATCH W05-VEC-012 duplicate sequence")

unauthorized_transition = vectors["W05-VEC-013"]
check_ledger("W05-VEC-013/unauthorized-transition", unauthorized_transition["ledger_record"])
transition_record = unauthorized_transition["ledger_record"]["record_without_hash"]
if (
    transition_record["from_status"] != "SUPERSEDED"
    or transition_record["to_status"] != "IN_PROGRESS"
):
    raise SystemExit("MISMATCH W05-VEC-013 unauthorized transition")

replay = vectors["W05-VEC-014"]
check_attestation("W05-VEC-014/replay", replay["attestation"])
if (
    replay["replay_of"] != "W05-VEC-001/attestation"
    or replay["attestation"] != vectors["W05-VEC-001"]["attestation"]
):
    raise SystemExit("MISMATCH W05-VEC-014 exact replay")

expected_negative_oracles = {
    "W05-VEC-003": ("IF-16", "SUSPEND", ["E_HASH_MISMATCH"]),
    "W05-VEC-004": ("IF-16", "DENY", ["E_DOMAIN_MISMATCH"]),
    "W05-VEC-005": ("IF-16", "DENY", ["E_FRAMING_AMBIGUOUS"]),
    "W05-VEC-006": ("IF-16", "DENY", ["E_TRUNCATED_INPUT"]),
    "W05-VEC-007": ("IF-17", "BLOCK", ["E_VERSION_UNSUPPORTED"]),
    "W05-VEC-008": ("IF-17", "DENY", ["E_KEY_PURPOSE"]),
    "W05-VEC-009": ("IF-17", "SUSPEND", ["E_INTEGRITY"]),
    "W05-VEC-010": ("IF-17", "SUSPEND", ["E_INTEGRITY"]),
    "W05-VEC-011": ("IF-17", "SUSPEND", ["E_HASH_MISMATCH"]),
    "W05-VEC-012": ("IF-17", "SUSPEND", ["E_INTEGRITY"]),
    "W05-VEC-013": ("IF-15", "DENY", ["E_TRANSITION"]),
    "W05-VEC-014": ("IF-17", "DENY", ["E_REPLAY"]),
}
for vector_id, (interface, decision, reasons) in expected_negative_oracles.items():
    oracle = vectors[vector_id]["expected"]
    if (
        oracle["result"] != "REJECT"
        or oracle["detector_interface"] != interface
        or oracle["consumer_decision"] != decision
        or oracle["reason_codes"] != reasons
    ):
        raise SystemExit(f"MISMATCH {vector_id}: registered oracle")

if schema_design_mapping_checks != 8:
    raise SystemExit("MISMATCH direct-schema-instance design mapping count")

print(f"bundle_sha256={h(raw)}")
print(f"vectors={len(vectors)}")
print(f"direct_schema_instance_design_mappings={schema_design_mapping_checks}")
print(f"semantic_byte_checks={semantic_byte_checks}")
print(f"digest_checks={digest_checks}")
print(f"signature_profile_checks={signature_profile_checks}")
print(f"oracle_checks={len(expected_negative_oracles) + 2}")
print("result=ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED")
