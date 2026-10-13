#!/usr/bin/env python3
"""Non-operational Wave 0.5 validation and reproducibility checks.

This program reads Wave 0.5, writes only in its own Wave 0.6 verification
directory, and performs no network, runtime, lab, signing, or operational test.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path
from typing import Any

warnings.simplefilter("ignore", DeprecationWarning)
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.validators import RefResolver


HERE = Path(__file__).resolve().parent
EXPERIMENT = HERE.parents[1]
WAVE05 = EXPERIMENT / "wave-0.5"
SCHEMAS = WAVE05 / "schemas"
FIXTURES = SCHEMAS / "fixtures"
VECTORS = WAVE05 / "vectors"
RESULT_PATH = HERE / "results.json"
INVENTORY_PATH = HERE / "wave05_inventory.json"
EXPECTED_BUNDLE_SHA256 = "b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52"
EXPECTED_HEAD = "39bade0506b4d5b12bb979ccf6a51bb11944a9ff"


class DuplicateKeyError(ValueError):
    pass


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=strict_object)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pointer_get(document: Any, pointer: str) -> Any:
    if pointer in ("", "/"):
        return document
    current = document
    for raw in pointer.lstrip("/").split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def walk_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        if isinstance(value.get("$ref"), str):
            refs.append(value["$ref"])
        for child in value.values():
            refs.extend(walk_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(walk_refs(child))
    return refs


def resolve_ref(
    ref: str, current_path: Path, documents: dict[Path, Any], ids: dict[str, Path]
) -> Any:
    location, separator, fragment = ref.partition("#")
    if not location:
        target_path = current_path
    elif location in ids:
        target_path = ids[location]
    else:
        candidate = (current_path.parent / location).resolve()
        if candidate not in documents:
            basename = Path(location).name
            matches = [path for path in documents if path.name == basename]
            if len(matches) != 1:
                raise KeyError(f"unresolved reference target: {ref}")
            candidate = matches[0]
        target_path = candidate
    target = documents[target_path]
    return pointer_get(target, fragment) if separator else target


def validator_for(schema_path: Path, schema: Any, store: dict[str, Any]) -> Draft202012Validator:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        resolver = RefResolver.from_schema(schema, store=store)
    return Draft202012Validator(
        schema, resolver=resolver, format_checker=FormatChecker()
    )


def check_validity(
    validator: Draft202012Validator, instance: Any, expected_valid: bool
) -> tuple[bool, list[str]]:
    errors = sorted(validator.iter_errors(instance), key=lambda item: list(item.path))
    actual_valid = not errors
    messages = [error.message for error in errors[:5]]
    return actual_valid == expected_valid, messages


def inventory() -> tuple[list[dict[str, Any]], str]:
    entries = []
    accumulator = hashlib.sha256()
    for path in sorted(item for item in WAVE05.rglob("*") if item.is_file()):
        relative = path.relative_to(WAVE05).as_posix()
        digest = sha256(path)
        size = path.stat().st_size
        entries.append({"path": relative, "bytes": size, "sha256": digest})
        accumulator.update(relative.encode("utf-8"))
        accumulator.update(b"\0")
        accumulator.update(str(size).encode("ascii"))
        accumulator.update(b"\0")
        accumulator.update(digest.encode("ascii"))
        accumulator.update(b"\n")
    return entries, accumulator.hexdigest()


def run() -> dict[str, Any]:
    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    fixture_paths = sorted(FIXTURES.glob("*.json"))
    json_paths = schema_paths + fixture_paths
    parse_failures: list[dict[str, str]] = []
    documents: dict[Path, Any] = {}
    for path in json_paths:
        try:
            documents[path.resolve()] = load_json(path)
        except Exception as exc:
            parse_failures.append({"path": str(path.relative_to(WAVE05)), "error": str(exc)})

    schemas = {path.resolve(): documents[path.resolve()] for path in schema_paths if path.resolve() in documents}
    ids: dict[str, Path] = {}
    duplicate_ids: list[str] = []
    for path, schema in schemas.items():
        schema_id = schema.get("$id")
        if not isinstance(schema_id, str):
            continue
        if schema_id in ids:
            duplicate_ids.append(schema_id)
        ids[schema_id] = path

    reference_total = 0
    reference_failures: list[dict[str, str]] = []
    for path, schema in schemas.items():
        for ref in walk_refs(schema):
            reference_total += 1
            try:
                resolve_ref(ref, path, documents, ids)
            except Exception as exc:
                reference_failures.append(
                    {"schema": path.name, "ref": ref, "error": str(exc)}
                )

    meta_failures: list[dict[str, str]] = []
    for path, schema in schemas.items():
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:
            meta_failures.append({"schema": path.name, "error": str(exc)})

    store: dict[str, Any] = {}
    for path, schema in schemas.items():
        if "$id" in schema:
            store[schema["$id"]] = schema
        store[path.name] = schema
        store[path.as_uri()] = schema
    manifest = documents[(FIXTURES / "manifest.json").resolve()]
    retired_fixtures = manifest["retired_pre_correction_full_document_fixtures"]
    fixture_manifest_consistent = (
        manifest["active_subschema_unit_catalog"]["pair_count"]
        == manifest["active_subschema_unit_catalog"]["positive_case_count"]
        == manifest["active_subschema_unit_catalog"]["negative_case_count"]
        == len(documents[(FIXTURES / "correction-unit-fixtures.json").resolve()]["pairs"])
        == 57
        and len(retired_fixtures) == len(set(retired_fixtures)) == 12
        and all((FIXTURES / name).is_file() for name in retired_fixtures)
        and len(manifest["active_full_document_cases"]) == 2
    )
    full_results = []
    for case in manifest["active_full_document_cases"]:
        schema_path = (FIXTURES / case["schema"]).resolve()
        fixture_path = (FIXTURES / case["fixture"]).resolve()
        expected_valid = case["expected"] == "VALID"
        validator = validator_for(schema_path, documents[schema_path], store)
        passed, messages = check_validity(
            validator, documents[fixture_path], expected_valid
        )
        full_results.append(
            {
                "schema": schema_path.name,
                "fixture": fixture_path.name,
                "expected": case["expected"],
                "passed": passed,
                "validator_messages": messages,
            }
        )

    unit_catalog = documents[(FIXTURES / "correction-unit-fixtures.json").resolve()]
    unit_results = []
    pointer_failures: list[dict[str, str]] = []
    for pair in unit_catalog["pairs"]:
        schema_path = (FIXTURES / pair["schema"]).resolve()
        try:
            subschema = pointer_get(documents[schema_path], pair["target"])
        except Exception as exc:
            pointer_failures.append({"id": pair["id"], "error": str(exc)})
            continue
        validator = validator_for(schema_path, subschema, store)
        positive_passed, positive_messages = check_validity(
            validator, pair["positive"], True
        )
        negative_passed, negative_messages = check_validity(
            validator, pair["negative"], False
        )
        unit_results.append(
            {
                "id": pair["id"],
                "positive_passed": positive_passed,
                "negative_passed": negative_passed,
                "positive_messages": positive_messages,
                "negative_messages": negative_messages,
            }
        )

    bundle_path = VECTORS / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
    bundle = load_json(bundle_path)
    vector_kinds: dict[str, int] = {}
    vector_ids = []
    for vector in bundle["vectors"]:
        vector_ids.append(vector["id"])
        vector_kinds[vector["kind"]] = vector_kinds.get(vector["kind"], 0) + 1

    script_paths = sorted(VECTORS.glob("*.py"))
    script_syntax_failures = []
    for path in script_paths:
        try:
            source = path.read_text(encoding="utf-8")
            ast.parse(source, filename=str(path))
            compile(source, str(path), "exec")
        except Exception as exc:
            script_syntax_failures.append({"script": path.name, "error": str(exc)})

    reproducer = subprocess.run(
        [sys.executable, str(VECTORS / "reproduce_vectors.py")],
        cwd=WAVE05.parents[3],
        text=True,
        capture_output=True,
        check=False,
    )

    with tempfile.TemporaryDirectory(prefix="vector-regeneration-", dir=HERE) as temp_name:
        temp = Path(temp_name)
        for name in ("derive_vectors.py", "derive_vectors_registry_1_2.py"):
            shutil.copy2(VECTORS / name, temp / name)
        regeneration = subprocess.run(
            [sys.executable, str(temp / "derive_vectors.py")],
            cwd=temp,
            text=True,
            capture_output=True,
            check=False,
        )
        regenerated_path = temp / bundle_path.name
        regenerated_sha = sha256(regenerated_path) if regenerated_path.exists() else None
        regenerated_equal = (
            regenerated_path.exists()
            and regenerated_path.read_bytes() == bundle_path.read_bytes()
        )

    direct_instances = []
    for vector_id in ("W05-VEC-001", "W05-VEC-002"):
        vector = next(item for item in bundle["vectors"] if item["id"] == vector_id)
        for index, record in enumerate(vector["ledger_records"]):
            for label, schema_name, instance in (
                (
                    f"{vector_id}/ledger/{index}/payload",
                    "audit-ledger-record.schema.json",
                    record["record_without_hash"],
                ),
                (
                    f"{vector_id}/ledger/{index}/envelope",
                    "governed-audit-ledger-envelope.schema.json",
                    record["ledger_envelope"],
                ),
            ):
                schema_path = (SCHEMAS / schema_name).resolve()
                validator = validator_for(schema_path, documents[schema_path], store)
                passed, messages = check_validity(validator, instance, True)
                direct_instances.append(
                    {"label": label, "schema": schema_name, "passed": passed, "messages": messages}
                )
        schema_name = "ledger-head-attestation.schema.json"
        schema_path = (SCHEMAS / schema_name).resolve()
        validator = validator_for(schema_path, documents[schema_path], store)
        passed, messages = check_validity(
            validator, vector["attestation"]["attestation_object"], True
        )
        direct_instances.append(
            {
                "label": f"{vector_id}/attestation",
                "schema": schema_name,
                "passed": passed,
                "messages": messages,
            }
        )

    registry_text = (WAVE05 / "W05_VERSIONED_REGISTRY.md").read_text(encoding="utf-8")
    contract_text = (WAVE05 / "W05_SHARED_TRUST_AND_STATE_CONTRACT.md").read_text(encoding="utf-8")
    matrix_text = (WAVE05 / "W05_INTERFACE_MATRIX.md").read_text(encoding="utf-8")
    required_literals = {
        "signing_profile": "PROFILE-LEDGER-HEAD-SIGNING-v1",
        "signature_encoding": "SIGENC-ES256-P1363-LOW-S-B64URL-v1",
        "ledger_domain": "AU-GPEP-EVENT-v1",
        "attestation_domain": "AU-LEDGER-HEAD-ATTEST-v1",
    }
    literal_results = {
        name: {
            "registry": literal in registry_text,
            "bundle": literal in bundle_path.read_text(encoding="utf-8"),
        }
        for name, literal in required_literals.items()
    }
    interface_presence = {
        interface: {
            "registry": f"`{interface}`" in registry_text,
            "matrix": f"`{interface}`" in matrix_text,
        }
        for interface in (f"IF-{number:02d}" for number in range(1, 23))
    }

    entries, aggregate = inventory()
    INVENTORY_PATH.write_text(
        json.dumps(
            {
                "scope": "wave-0.5 files",
                "algorithm": "sha256",
                "aggregate_algorithm": "sha256(path_utf8 NUL decimal_size NUL sha256_ascii LF)",
                "aggregate_sha256": aggregate,
                "file_count": len(entries),
                "files": entries,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )

    checks = {
        "strict_json_parse": not parse_failures and len(documents) == len(json_paths),
        "schema_ids_unique": not duplicate_ids and len(ids) == len(schema_paths),
        "schema_ids_canonical": all(
            isinstance(schema.get("$id"), str)
            and schema["$id"].startswith("urn:au-ucr:schema:")
            and schema["$id"].endswith(":1.0.0")
            and schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema"
            for schema in schemas.values()
        ),
        "local_references_resolved": not reference_failures,
        "metaschema_validation": not meta_failures,
        "fixture_manifest_consistency": fixture_manifest_consistent,
        "active_full_document_fixtures": all(item["passed"] for item in full_results),
        "subschema_unit_fixtures": (
            not pointer_failures
            and len(unit_results) == len(unit_catalog["pairs"])
            and all(
                item["positive_passed"] and item["negative_passed"]
                for item in unit_results
            )
        ),
        "vector_bundle_declared_counts": (
            bundle["vector_count"] == len(bundle["vectors"]) == 14
            and vector_kinds == {"positive": 2, "negative": 12}
            and len(set(vector_ids)) == 14
        ),
        "vector_bundle_expected_hash": sha256(bundle_path) == EXPECTED_BUNDLE_SHA256,
        "vector_scripts_syntax": not script_syntax_failures and len(script_paths) == 4,
        "vector_reproducer": (
            reproducer.returncode == 0
            and "result=ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED" in reproducer.stdout
        ),
        "isolated_vector_regeneration": (
            regeneration.returncode == 0
            and regenerated_equal
            and regenerated_sha == EXPECTED_BUNDLE_SHA256
        ),
        "positive_vector_direct_schema_instances": (
            len(direct_instances) == 8 and all(item["passed"] for item in direct_instances)
        ),
        "registry_bundle_literal_alignment": all(
            item["registry"] and item["bundle"]
            for item in literal_results.values()
        )
        and "`urn:au-ucr:registry:wave-0.5-contract`" in registry_text
        and "**Registry version:** `1.3.0`" in registry_text
        and EXPECTED_BUNDLE_SHA256 in registry_text
        and sha256(bundle_path) == EXPECTED_BUNDLE_SHA256
        and bundle["contracts"]["registry_id"] == "urn:au-ucr:registry:wave-0.5-contract"
        and bundle["contracts"]["registry_version"] == "1.3.0",
        "interface_inventory_presence": all(
            item["registry"] and item["matrix"] for item in interface_presence.values()
        ),
        "contract_files_present": all(
            path.is_file()
            for path in (
                WAVE05 / "W05_VERSIONED_REGISTRY.md",
                WAVE05 / "W05_SHARED_TRUST_AND_STATE_CONTRACT.md",
                WAVE05 / "W05_INTERFACE_MATRIX.md",
                WAVE05 / "W05_NESTED_CANDIDATE_MANIFEST_SPEC.md",
                WAVE05 / "W05_IMMUTABLE_REFERENCE_CROSSWALK.md",
                WAVE05 / "W05_PUBLICATION_AND_PROVENANCE_SPEC.md",
            )
        ),
    }

    return {
        "classification": "NON_OPERATIONAL_LOCAL_VALIDATION_AND_REPRODUCIBILITY",
        "environment": {
            "python": sys.version.split()[0],
            "jsonschema": importlib.metadata.version("jsonschema"),
            "expected_baseline_head": EXPECTED_HEAD,
        },
        "summary": {
            "checks_total": len(checks),
            "checks_passed": sum(checks.values()),
            "checks_failed": len(checks) - sum(checks.values()),
            "schema_documents": len(schema_paths),
            "fixture_json_documents": len(fixture_paths),
            "json_documents": len(json_paths),
            "schema_references": reference_total,
            "active_full_document_fixture_cases": len(full_results),
            "subschema_pairs": len(unit_results),
            "subschema_case_outcomes": len(unit_results) * 2,
            "vector_scenarios": len(bundle["vectors"]),
            "positive_vectors": vector_kinds.get("positive", 0),
            "negative_vectors": vector_kinds.get("negative", 0),
            "direct_vector_schema_instances": len(direct_instances),
            "wave05_files_in_inventory": len(entries),
            "wave05_inventory_aggregate_sha256": aggregate,
        },
        "checks": checks,
        "failures": {
            "json_parse": parse_failures,
            "duplicate_schema_ids": duplicate_ids,
            "reference_resolution": reference_failures,
            "metaschema": meta_failures,
            "fixture_pointers": pointer_failures,
            "script_syntax": script_syntax_failures,
        },
        "fixture_validation": {
            "active_full_document": full_results,
            "subschema_units": unit_results,
        },
        "vector_validation": {
            "bundle_bytes": bundle_path.stat().st_size,
            "bundle_sha256": sha256(bundle_path),
            "ids": vector_ids,
            "kinds": vector_kinds,
            "direct_schema_instances": direct_instances,
            "reproducer": {
                "command": f"{sys.executable} {VECTORS / 'reproduce_vectors.py'}",
                "returncode": reproducer.returncode,
                "stdout": reproducer.stdout.strip().splitlines(),
                "stderr": reproducer.stderr.strip().splitlines(),
            },
            "isolated_regeneration": {
                "copied_scripts": [
                    "derive_vectors.py",
                    "derive_vectors_registry_1_2.py",
                ],
                "returncode": regeneration.returncode,
                "stdout": regeneration.stdout.strip().splitlines(),
                "stderr": regeneration.stderr.strip().splitlines(),
                "regenerated_sha256": regenerated_sha,
                "byte_equal_to_source_bundle": regenerated_equal,
            },
        },
        "design_alignment": {
            "required_literals": literal_results,
            "interfaces": interface_presence,
        },
        "not_executed": [
            "general RFC 8785 conformance outside the fixture subset",
            "ES256 signing or verification",
            "trust-root, key-authority, revocation, assignment, or identity verification",
            "stateful consumer rejection, replay, transition, sequence, fork, or rollback behavior",
            "runtime, operational, lab, sandbox, browser, or network tests",
            "dependency installation",
            "candidate freeze, publication, retrieval, commit, push, merge, or approval",
        ],
    }


def main() -> int:
    result = run()
    RESULT_PATH.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    summary = result["summary"]
    print(f"results={RESULT_PATH}")
    print(f"checks={summary['checks_passed']}/{summary['checks_total']}")
    print(f"failed={summary['checks_failed']}")
    print(f"schemas={summary['schema_documents']}")
    print(f"json_documents={summary['json_documents']}")
    print(f"schema_references={summary['schema_references']}")
    print(f"active_fixture_cases={summary['active_full_document_fixture_cases']}")
    print(f"subschema_case_outcomes={summary['subschema_case_outcomes']}")
    print(f"vectors={summary['vector_scenarios']}")
    print(f"direct_vector_schema_instances={summary['direct_vector_schema_instances']}")
    return 0 if summary["checks_failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
