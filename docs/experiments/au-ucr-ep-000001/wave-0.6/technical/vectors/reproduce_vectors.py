#!/usr/bin/env python3
"""Compatibility entry point for current registry-aligned vector reproduction.

Direct execution delegates to the current implementation module (whose
filename is retained for append-only path compatibility). The definitions
below are retained only as superseded design history.
"""

import hashlib
import json
from pathlib import Path
from typing import Any

if __name__ == "__main__":
    import runpy

    runpy.run_path(
        str(Path(__file__).with_name("reproduce_vectors_registry_1_2.py")),
        run_name="__main__",
    )
    raise SystemExit


def h(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def jcs_subset(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def u32(value: int) -> bytes:
    return value.to_bytes(4, "big", signed=False)


def u64(value: int) -> bytes:
    return value.to_bytes(8, "big", signed=False)


path = Path(__file__).with_name("W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json")
raw = path.read_bytes()
bundle = json.loads(raw)
vectors = {item["id"]: item for item in bundle["vectors"]}
contracts = bundle["contracts"]
ledger_domain = contracts["ledger_domain_ascii"].encode("ascii")
ledger_id = contracts["ledger_id_ascii"].encode("ascii")

checks = []
byte_checks = 0
for vector_id in ("W05-VEC-001", "W05-VEC-002"):
    for record in vectors[vector_id]["ledger_records"]:
        record_bytes = jcs_subset(record["record_without_hash"])
        preimage = (
            u32(len(ledger_domain))
            + ledger_domain
            + u32(len(ledger_id))
            + ledger_id
            + u64(record["sequence"])
            + u32(32)
            + bytes.fromhex(record["prev_hash_raw_hex"])
            + u64(len(record_bytes))
            + record_bytes
        )
        if record_bytes.hex() != record["record_jcs_utf8_hex"]:
            raise SystemExit(f"MISMATCH {vector_id}: independently serialized record bytes")
        if preimage.hex() != record["framed_preimage_hex"]:
            raise SystemExit(f"MISMATCH {vector_id}: independently framed ledger bytes")
        byte_checks += 1
        checks.append(
            (
                f"{vector_id}/ledger/{record['sequence']}",
                h(preimage),
                record["record_hash"],
            )
        )
    attestation = vectors[vector_id]["attestation"]
    attestation_domain = attestation["domain_ascii"].encode("ascii")
    payload_bytes = jcs_subset(attestation["payload"])
    signature_input = (
        u32(len(attestation_domain))
        + attestation_domain
        + u64(len(payload_bytes))
        + payload_bytes
    )
    if payload_bytes.hex() != attestation["payload_jcs_utf8_hex"]:
        raise SystemExit(f"MISMATCH {vector_id}: independently serialized attestation bytes")
    if signature_input.hex() != attestation["signature_input_hex"]:
        raise SystemExit(f"MISMATCH {vector_id}: independently framed signature input")
    byte_checks += 1
    checks.append(
        (
            f"{vector_id}/attestation",
            h(signature_input),
            attestation["signature_input_sha256"],
        )
    )

changed = vectors["W05-VEC-003"]
changed_record = changed["ledger_record"]
changed_bytes = jcs_subset(changed_record["record_without_hash"])
changed_preimage = (
    u32(len(ledger_domain))
    + ledger_domain
    + u32(len(ledger_id))
    + ledger_id
    + u64(changed_record["sequence"])
    + u32(32)
    + bytes.fromhex(changed_record["prev_hash_raw_hex"])
    + u64(len(changed_bytes))
    + changed_bytes
)
if changed_preimage.hex() != changed_record["framed_preimage_hex"]:
    raise SystemExit("MISMATCH W05-VEC-003: independently framed ledger bytes")
byte_checks += 1
checks.append(
    (
        "W05-VEC-003/changed",
        h(changed_preimage),
        changed["expected"]["derived_hash"],
    )
)
for vector_id, bytes_field, digest_field in (
    ("W05-VEC-004", "framed_preimage_hex", "framed_preimage_sha256"),
    ("W05-VEC-005", "input_hex", "input_sha256"),
    ("W05-VEC-006", "input_hex", "input_sha256"),
):
    vector = vectors[vector_id]
    checks.append((vector_id, h(bytes.fromhex(vector[bytes_field])), vector[digest_field]))

for vector_id in ("W05-VEC-007", "W05-VEC-008"):
    attestation = vectors[vector_id]["attestation"]
    domain = attestation["domain_ascii"].encode("ascii")
    payload = jcs_subset(attestation["payload"])
    signature_input = u32(len(domain)) + domain + u64(len(payload)) + payload
    if signature_input.hex() != attestation["signature_input_hex"]:
        raise SystemExit(f"MISMATCH {vector_id}: independently framed signature input")
    byte_checks += 1
    checks.append(
        (
            f"{vector_id}/attestation",
            h(signature_input),
            attestation["signature_input_sha256"],
        )
    )

for label, actual, expected in checks:
    if actual != expected:
        raise SystemExit(f"MISMATCH {label}: {actual} != {expected}")

print(f"bundle_sha256={h(raw)}")
print(f"vectors={len(bundle['vectors'])}")
print(f"semantic_byte_checks={byte_checks}")
print(f"digest_checks={len(checks)}")
print("result=ALL_DERIVED_DIGESTS_REPRODUCED")
