#!/usr/bin/env python3
"""Compatibility entry point for current registry-aligned vector derivation.

Direct execution delegates to the current implementation module (whose
filename is retained for append-only path compatibility). The definitions below
are superseded design history and are not executed by this entry point.
"""

from __future__ import annotations

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(
        str(Path(__file__).with_name("derive_vectors_registry_1_2.py")),
        run_name="__main__",
    )
    raise SystemExit

import hashlib
import json
from pathlib import Path
from typing import Any


BUNDLE_VERSION = "urn:au-ucr:gpep:vectors:1.0"
LEDGER_FRAMING_VERSION = "urn:au-ucr:gpep:ledger-framing:1.0"
EVENT_SCHEMA_VERSION = "urn:au-ucr:gpep:event:1.0"
ATTESTATION_SCHEMA_VERSION = "urn:au-ucr:runtime:attestation:1.0"
SIGNATURE_FRAMING_VERSION = "urn:au-ucr:signature-framing:1.0"
LEDGER_DOMAIN = b"AU-GPEP-EVENT-v1"
# Provisional until the Agent C shared cryptographic/domain registry adopts it.
ATTESTATION_DOMAIN = b"AU-RUNTIME-ATTEST-v1"
LEDGER_ID = b"urn:uuid:11111111-1111-4111-8111-111111111111"
ZERO_HASH = bytes(32)


def u32(value: int) -> bytes:
    return value.to_bytes(4, "big", signed=False)


def u64(value: int) -> bytes:
    return value.to_bytes(8, "big", signed=False)


def jcs_subset(value: Any) -> bytes:
    """RFC 8785-compatible encoding for these ASCII/string/integer fixtures."""
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def signature_frame(domain: bytes, payload: bytes) -> bytes:
    return u32(len(domain)) + domain + u64(len(payload)) + payload


def ledger_frame(sequence: int, prev_hash: bytes, record_bytes: bytes, *,
                 domain: bytes = LEDGER_DOMAIN) -> bytes:
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


def ledger_material(record: dict[str, Any], sequence: int, prev_hash: bytes) -> dict[str, Any]:
    record_bytes = jcs_subset(record)
    preimage = ledger_frame(sequence, prev_hash, record_bytes)
    return {
        "sequence": sequence,
        "record_without_hash": record,
        "record_jcs_utf8_hex": record_bytes.hex(),
        "record_length": len(record_bytes),
        "prev_hash_raw_hex": prev_hash.hex(),
        "framed_preimage_hex": preimage.hex(),
        "framed_preimage_length": len(preimage),
        "record_hash": sha256_hex(preimage),
        "encoded_lengths_hex": {
            "domain_len32": u32(len(LEDGER_DOMAIN)).hex(),
            "ledger_id_len32": u32(len(LEDGER_ID)).hex(),
            "prev_hash_len32": u32(len(prev_hash)).hex(),
            "record_len64": u64(len(record_bytes)).hex(),
        },
        "sequence_uint64be_hex": u64(sequence).hex(),
    }


def attestation_material(payload: dict[str, Any], *, domain: bytes = ATTESTATION_DOMAIN) -> dict[str, Any]:
    payload_bytes = jcs_subset(payload)
    framed = signature_frame(domain, payload_bytes)
    return {
        "domain_ascii": domain.decode("ascii"),
        "domain_hex": domain.hex(),
        "payload": payload,
        "payload_jcs_utf8_hex": payload_bytes.hex(),
        "payload_length": len(payload_bytes),
        "encoded_lengths_hex": {
            "domain_len32": u32(len(domain)).hex(),
            "payload_len64": u64(len(payload_bytes)).hex(),
        },
        "signature_input_hex": framed.hex(),
        "signature_input_length": len(framed),
        "signature_input_sha256": sha256_hex(framed),
    }


def main() -> None:
    genesis_record = {
        "decision": "ACCEPT",
        "event_id": "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0",
        "ledger_framing_version": LEDGER_FRAMING_VERSION,
        "object_id": "urn:uuid:22222222-2222-4222-8222-222222222222",
        "object_version": 1,
        "schema": EVENT_SCHEMA_VERSION,
        "timestamp": "2026-10-12T10:30:00Z",
        "transition": {"from": "NOT_STARTED", "to": "IN_PROGRESS"},
    }
    genesis = ledger_material(genesis_record, 0, ZERO_HASH)

    successor_record = {
        "decision": "ACCEPT",
        "event_id": "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        "ledger_framing_version": LEDGER_FRAMING_VERSION,
        "object_id": "urn:uuid:22222222-2222-4222-8222-222222222222",
        "object_version": 2,
        "schema": EVENT_SCHEMA_VERSION,
        "timestamp": "2026-10-12T10:31:00Z",
        "transition": {"from": "IN_PROGRESS", "to": "READY"},
    }
    successor = ledger_material(successor_record, 1, bytes.fromhex(genesis["record_hash"]))

    single_attestation_payload = {
        "algorithm": "ES256",
        "audience": "urn:au-ucr:gpep:verifier",
        "head_hash": genesis["record_hash"],
        "key_id": "urn:au-ucr:key:runtime-attestation:example-01",
        "key_purpose": "runtime-attestation",
        "ledger_id": LEDGER_ID.decode("ascii"),
        "schema": ATTESTATION_SCHEMA_VERSION,
        "sequence": 0,
        "signature_framing_version": SIGNATURE_FRAMING_VERSION,
    }
    chain_attestation_payload = dict(single_attestation_payload)
    chain_attestation_payload.update({"head_hash": successor["record_hash"], "sequence": 1})

    changed_record = json.loads(json.dumps(genesis_record))
    changed_record["transition"]["to"] = "READY"
    changed = ledger_material(changed_record, 0, ZERO_HASH)

    wrong_domain = b"AU-GPEP-EVENT-v2"
    wrong_domain_record_bytes = bytes.fromhex(genesis["record_jcs_utf8_hex"])
    wrong_domain_preimage = ledger_frame(0, ZERO_HASH, wrong_domain_record_bytes, domain=wrong_domain)

    # Deliberately invalid: field concatenation without any length prefixes.
    ambiguous = LEDGER_DOMAIN + LEDGER_ID + u64(0) + ZERO_HASH + wrong_domain_record_bytes
    truncated = bytes.fromhex(genesis["framed_preimage_hex"])[:-1]

    version_mismatch_payload = dict(single_attestation_payload)
    version_mismatch_payload["schema"] = "urn:au-ucr:runtime:attestation:2.0"
    version_mismatch = attestation_material(version_mismatch_payload)

    unauthorized_payload = dict(single_attestation_payload)
    unauthorized_payload.update({
        "key_id": "urn:au-ucr:key:general-signing:example-99",
        "key_purpose": "general-signing",
    })
    unauthorized = attestation_material(unauthorized_payload)

    bundle = {
        "bundle_version": BUNDLE_VERSION,
        "classification": "PROPOSED_DESIGN_FIXTURES_DERIVED_NOT_INDEPENDENTLY_VERIFIED",
        "algorithms": {
            "canonicalization": "RFC8785-JCS",
            "hash": "SHA-256",
            "signature": "ES256",
        },
        "contracts": {
            "ledger_domain_ascii": LEDGER_DOMAIN.decode("ascii"),
            "ledger_domain_hex": LEDGER_DOMAIN.hex(),
            "ledger_domain_length": len(LEDGER_DOMAIN),
            "ledger_framing_version": LEDGER_FRAMING_VERSION,
            "event_schema_version": EVENT_SCHEMA_VERSION,
            "attestation_domain_ascii": ATTESTATION_DOMAIN.decode("ascii"),
            "attestation_domain_hex": ATTESTATION_DOMAIN.hex(),
            "attestation_domain_length": len(ATTESTATION_DOMAIN),
            "attestation_domain_status": "SPECIFIED_PROVISIONAL_PENDING_AGENT_C_ADOPTION",
            "attestation_schema_version": ATTESTATION_SCHEMA_VERSION,
            "signature_framing_version": SIGNATURE_FRAMING_VERSION,
            "signature_coverage": "INPUT_BYTES_AND_DIGEST_ONLY_NO_ES256_SIGNATURE_VALUES",
            "ledger_id_ascii": LEDGER_ID.decode("ascii"),
            "ledger_id_hex": LEDGER_ID.hex(),
            "ledger_id_length": len(LEDGER_ID),
            "ledger_input": "len32(domain)||domain||len32(ledger_id)||ledger_id||uint64be(sequence)||len32(prev_hash)||prev_hash||len64(record_bytes)||record_bytes",
            "signature_input": "len32(domain)||domain||len64(payload_bytes)||payload_bytes",
        },
        "vector_count": 8,
        "vectors": [
            {
                "id": "W05-VEC-001",
                "title": "valid single genesis record",
                "kind": "positive",
                "ledger_records": [genesis],
                "attestation": attestation_material(single_attestation_payload),
                "expected": {
                    "result": "ACCEPT",
                    "scope": "LEDGER_AND_SIGNATURE_INPUT_CONSTRUCTION_ONLY",
                },
            },
            {
                "id": "W05-VEC-002",
                "title": "valid two-record chain",
                "kind": "positive",
                "ledger_records": [genesis, successor],
                "attestation": attestation_material(chain_attestation_payload),
                "expected": {
                    "result": "ACCEPT",
                    "scope": "LEDGER_AND_SIGNATURE_INPUT_CONSTRUCTION_ONLY",
                },
            },
            {
                "id": "W05-VEC-003",
                "title": "changed payload with stale claimed hash",
                "kind": "negative",
                "ledger_record": changed,
                "claimed_record_hash": genesis["record_hash"],
                "expected": {
                    "result": "REJECT",
                    "reason": "E_HASH_MISMATCH",
                    "derived_hash": changed["record_hash"],
                },
            },
            {
                "id": "W05-VEC-004",
                "title": "wrong ledger domain",
                "kind": "negative",
                "supplied_domain_ascii": wrong_domain.decode("ascii"),
                "framed_preimage_hex": wrong_domain_preimage.hex(),
                "framed_preimage_sha256": sha256_hex(wrong_domain_preimage),
                "expected": {"result": "REJECT", "reason": "E_DOMAIN_MISMATCH"},
            },
            {
                "id": "W05-VEC-005",
                "title": "ambiguous unframed field concatenation",
                "kind": "negative",
                "input_hex": ambiguous.hex(),
                "input_length": len(ambiguous),
                "input_sha256": sha256_hex(ambiguous),
                "expected": {"result": "REJECT", "reason": "E_FRAMING_AMBIGUOUS"},
            },
            {
                "id": "W05-VEC-006",
                "title": "truncated framed ledger input",
                "kind": "negative",
                "input_hex": truncated.hex(),
                "input_length": len(truncated),
                "declared_record_length": genesis["record_length"],
                "available_record_length": genesis["record_length"] - 1,
                "input_sha256": sha256_hex(truncated),
                "expected": {"result": "REJECT", "reason": "E_TRUNCATED_INPUT"},
            },
            {
                "id": "W05-VEC-007",
                "title": "unsupported attestation schema version",
                "kind": "negative",
                "attestation": version_mismatch,
                "expected": {"result": "REJECT", "reason": "E_VERSION_UNSUPPORTED"},
            },
            {
                "id": "W05-VEC-008",
                "title": "unauthorized attestation key purpose",
                "kind": "negative",
                "attestation": unauthorized,
                "signature_bytes": None,
                "signature_bytes_note": "Not needed: reject key purpose before cryptographic verification.",
                "expected": {"result": "REJECT", "reason": "E_KEY_PURPOSE"},
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
    print(f"bytes={len(raw)}")
    print(f"sha256={sha256_hex(raw)}")
    print(f"genesis_record_hash={genesis['record_hash']}")
    print(f"successor_record_hash={successor['record_hash']}")
    print(f"single_attestation_input_sha256={attestation_material(single_attestation_payload)['signature_input_sha256']}")
    print(f"chain_attestation_input_sha256={attestation_material(chain_attestation_payload)['signature_input_sha256']}")


if __name__ == "__main__":
    main()
