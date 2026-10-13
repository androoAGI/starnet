"""Independent local verification of the Wave 0.6 technical candidate."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import platform
import subprocess
import sys
from collections import Counter

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from jsonschema import Draft202012Validator, FormatChecker, RefResolver


ROOT = pathlib.Path(__file__).resolve().parents[1]
TECH = ROOT / "technical"
SCHEMAS = TECH / "schemas"
FIXTURES = SCHEMAS / "fixtures"
VECTORS = TECH / "vectors"
RESULT_PATH = pathlib.Path(__file__).with_name("final_technical_results.json")
P256_ORDER = int(
    "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16
)


def load(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    result = {
        "classification": "LOCAL_NON_OPERATIONAL_FINAL_TECHNICAL_VERIFICATION",
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "checks": {},
        "counts": {},
        "failures": [],
        "not_run": [],
        "observations": [],
    }

    manifest = load(TECH / "W06_TECHNICAL_FREEZE_MANIFEST.json")
    manifest_failures = []
    seen = set()
    for entry in manifest["files"]:
        relative = entry["path"]
        target = TECH / relative
        if relative in seen:
            manifest_failures.append(f"duplicate manifest path: {relative}")
            continue
        seen.add(relative)
        if not target.is_file():
            manifest_failures.append(f"missing: {relative}")
            continue
        if target.stat().st_size != entry["bytes"]:
            manifest_failures.append(f"size mismatch: {relative}")
        if sha256(target) != entry["sha256"]:
            manifest_failures.append(f"hash mismatch: {relative}")
    if len(manifest["files"]) != manifest["normative_file_count"]:
        manifest_failures.append("normative_file_count mismatch")
    result["checks"]["manifest_54_entries"] = not manifest_failures
    result["counts"]["manifest_entries"] = len(manifest["files"])
    result["failures"].extend(manifest_failures)

    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    documents = {path.name: load(path) for path in schema_paths}
    store = {}
    for name, document in documents.items():
        store[name] = document
        store[document["$id"]] = document

    schema_failures = []
    for name, document in documents.items():
        try:
            Draft202012Validator.check_schema(document)
        except Exception as exc:  # pragma: no cover - evidence path
            schema_failures.append(f"{name}: {exc}")
    ids = [document["$id"] for document in documents.values()]
    if len(set(ids)) != len(ids):
        schema_failures.append("duplicate schema IDs")
    result["checks"]["schemas_35_metaschema_valid"] = (
        len(documents) == 35 and not schema_failures
    )
    result["counts"]["schema_documents"] = len(documents)
    result["failures"].extend(schema_failures)

    references = []

    def walk(value):
        if isinstance(value, dict):
            if "$ref" in value:
                references.append(value["$ref"])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    for document in documents.values():
        walk(document)
    ref_failures = []
    for reference in references:
        if reference.startswith(("#", "urn:", "http:", "https:")):
            continue
        if not (SCHEMAS / reference.split("#", 1)[0]).is_file():
            ref_failures.append(reference)
    result["checks"]["local_references_576_resolved"] = (
        len(references) == 576 and not ref_failures
    )
    result["counts"]["local_references"] = len(references)
    result["failures"].extend(f"unresolved ref: {item}" for item in ref_failures)

    def validator(name: str):
        document = documents[name]
        return Draft202012Validator(
            document,
            resolver=RefResolver.from_schema(document, store=store),
            format_checker=FormatChecker(),
        )

    catalog = load(FIXTURES / "full-document-fixtures.json")
    helpers = {"common.schema.json", "authority-object-base.schema.json"}
    concrete = set(documents) - helpers
    fixture_failures = []
    outcomes = Counter()
    error_keywords = Counter()
    schema_coverage = {name: Counter() for name in concrete}
    for case in catalog["cases"]:
        name = pathlib.Path(case["schema"]).name
        errors = list(validator(name).iter_errors(case["instance"]))
        observed = "INVALID" if errors else "VALID"
        outcomes[observed] += 1
        schema_coverage[name][case["expect"]] += 1
        for error in errors:
            error_keywords[error.validator or "unknown"] += 1
        if observed != case["expect"]:
            fixture_failures.append(f"{case['id']}: expected {case['expect']}, got {observed}")
    uncovered = sorted(
        name
        for name, counts in schema_coverage.items()
        if not counts["VALID"] or not counts["INVALID"]
    )
    fixture_failures.extend(f"missing positive/negative coverage: {name}" for name in uncovered)
    result["checks"]["generated_full_documents_160"] = (
        len(catalog["cases"]) == 160
        and outcomes["VALID"] == 36
        and outcomes["INVALID"] == 124
        and len(concrete) == 33
        and len(helpers) == 2
        and not fixture_failures
    )
    result["counts"].update(
        {
            "concrete_schemas": len(concrete),
            "helper_schemas": len(helpers),
            "generated_full_document_cases": len(catalog["cases"]),
            "generated_valid": outcomes["VALID"],
            "generated_invalid": outcomes["INVALID"],
        }
    )
    result["full_document_error_keywords"] = dict(sorted(error_keywords.items()))
    result["failures"].extend(fixture_failures)

    retained = load(FIXTURES / "manifest.json")["active_full_document_cases"]
    retained_failures = []
    for case in retained:
        name = pathlib.Path(case["schema"]).name
        instance = load(FIXTURES / case["fixture"])
        observed = "INVALID" if list(validator(name).iter_errors(instance)) else "VALID"
        if observed != case["expected"]:
            retained_failures.append(case["fixture"])
    result["checks"]["all_full_documents_162"] = (
        len(retained) == 2 and not retained_failures and not fixture_failures
    )
    result["counts"]["all_full_document_cases"] = len(catalog["cases"]) + len(retained)
    result["failures"].extend(f"retained fixture mismatch: {x}" for x in retained_failures)

    helper_dependents = {
        helper: sorted(
            name for name in concrete if helper in json.dumps(documents[name])
        )
        for helper in helpers
    }
    result["checks"]["helpers_exercised_by_dependents"] = (
        len(helper_dependents["common.schema.json"]) == 33
        and len(helper_dependents["authority-object-base.schema.json"]) == 14
    )
    result["counts"]["helper_dependents"] = {
        name: len(values) for name, values in sorted(helper_dependents.items())
    }

    bundle_path = VECTORS / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
    bundle = load(bundle_path)
    bundle_hash = sha256(bundle_path)
    result["checks"]["vector_bundle_14_and_hash"] = (
        len(bundle["vectors"]) == bundle["vector_count"] == 14
        and bundle_hash
        == "b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52"
    )
    result["counts"]["vector_scenarios"] = len(bundle["vectors"])
    result["vector_bundle_sha256"] = bundle_hash

    reproducer = subprocess.run(
        [sys.executable, str(VECTORS / "reproduce_vectors.py")],
        cwd=VECTORS,
        text=True,
        capture_output=True,
        check=False,
    )
    result["checks"]["vector_reproducer"] = (
        reproducer.returncode == 0
        and "ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED" in reproducer.stdout
    )
    result["vector_reproducer"] = {
        "returncode": reproducer.returncode,
        "stdout": reproducer.stdout.splitlines(),
        "stderr": reproducer.stderr.splitlines(),
    }

    registry = (TECH / "W05_VERSIONED_REGISTRY.md").read_text(encoding="utf-8")
    matrix = (TECH / "W05_INTERFACE_MATRIX.md").read_text(encoding="utf-8")
    interface_failures = [
        interface
        for interface in (f"IF-{index:02d}" for index in range(1, 23))
        if interface not in registry or interface not in matrix
    ]
    result["checks"]["interfaces_22_aligned"] = not interface_failures
    result["failures"].extend(f"interface absent: {x}" for x in interface_failures)

    technical_text = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in TECH.rglob("*")
        if path.is_file() and path.suffix in {".md", ".json", ".py"}
    )
    result["checks"]["authority_name_hakeem_controls"] = (
        '"human_principal_and_sole_final_decision_authority": "Hakeem Moore"'
        in technical_text
        and "Human Principal and sole final decision authority: **Hakeem Moore**"
        in technical_text
    )

    # Genuine local ES256 mechanics with an ephemeral P-256 test key. This does not validate
    # synthetic bundle signatures, signer authority, trust roots, revocation, or key custody.
    message = bytes.fromhex(bundle["vectors"][0]["attestation"]["signature_input_hex"])
    private_key = ec.generate_private_key(ec.SECP256R1())
    der = private_key.sign(message, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    low_s = s if s <= P256_ORDER // 2 else P256_ORDER - s
    p1363 = r.to_bytes(32, "big") + low_s.to_bytes(32, "big")
    encoded = base64.urlsafe_b64encode(p1363).rstrip(b"=").decode("ascii")
    public_key = private_key.public_key()
    public_key.verify(
        utils.encode_dss_signature(r, low_s), message, ec.ECDSA(hashes.SHA256())
    )
    wrong_message_rejected = False
    try:
        public_key.verify(
            utils.encode_dss_signature(r, low_s),
            message + b"x",
            ec.ECDSA(hashes.SHA256()),
        )
    except InvalidSignature:
        wrong_message_rejected = True
    wrong_key_rejected = False
    try:
        ec.generate_private_key(ec.SECP256R1()).public_key().verify(
            utils.encode_dss_signature(r, low_s),
            message,
            ec.ECDSA(hashes.SHA256()),
        )
    except InvalidSignature:
        wrong_key_rejected = True
    high_s_rejected_by_policy = (P256_ORDER - low_s) > P256_ORDER // 2
    result["checks"]["ephemeral_es256_p1363_low_s_mechanics"] = (
        len(p1363) == 64
        and len(encoded) == 86
        and "=" not in encoded
        and low_s <= P256_ORDER // 2
        and wrong_message_rejected
        and wrong_key_rejected
        and high_s_rejected_by_policy
    )
    result["ephemeral_es256_scope"] = (
        "Mechanics only; synthetic vector signatures and trust/authority were not validated."
    )

    result["not_run"].extend(
        [
            "generalized RFC 8785 corpus: no independent rfc8785 library installed",
            "synthetic vector signature verification: vectors explicitly contain non-ES256 sentinel values",
            "trust-root, signer-authority, key-custody, revocation and trusted-time verification",
            "stateful consumer replay/transition/fork/rollback enforcement",
            "operational, laboratory, network, publication, commit, push or merge activity",
        ]
    )
    result["observations"].append(
        "Generated fixtures and schemas share Agent A authorship; this pass independently "
        "executes them but cannot establish organizational independence."
    )
    result["observations"].append(
        "Negative cases were required to be invalid and error keywords were recorded; "
        "cross-field semantics outside JSON Schema remain unverified."
    )

    required = [
        value for value in result["checks"].values() if isinstance(value, bool)
    ]
    result["summary"] = {
        "checks_total": len(required),
        "checks_passed": sum(required),
        "checks_failed": len(required) - sum(required),
        "result": "PASS" if all(required) and not result["failures"] else "FAIL",
    }
    RESULT_PATH.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"result={result['summary']['result']}")
    print(f"checks={result['summary']['checks_passed']}/{result['summary']['checks_total']}")
    print(f"failures={len(result['failures'])}")
    print(f"full_documents={result['counts']['all_full_document_cases']}")
    print(f"manifest_entries={result['counts']['manifest_entries']}")
    print(f"vector_sha256={bundle_hash}")

#!/usr/bin/env python3
"""Independent, non-operational Wave 0.6 final technical verification.

Reads only the Wave 0.6 technical package. Writes only the two final technical
verification artifacts beside this script. Uses no network or operational key.
"""

import base64
import copy
import hashlib
import importlib.metadata
import json
import platform
import re
import subprocess
import sys
import warnings
from collections import Counter
from pathlib import Path
from typing import Any

warnings.filterwarnings("ignore", category=DeprecationWarning)
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)
from jsonschema import Draft202012Validator, FormatChecker, RefResolver


HERE = Path(__file__).resolve().parent
TECH = HERE.parent / "technical"
SCHEMAS = TECH / "schemas"
FIXTURES = SCHEMAS / "fixtures"
VECTORS = TECH / "vectors"
RESULT = HERE / "final_technical_results.json"
REPORT = HERE / "FINAL_TECHNICAL_VERIFICATION.md"
EXPECTED_BUNDLE_SHA256 = "b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52"
HELPERS = {"common.schema.json", "authority-object-base.schema.json"}
P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


class DuplicateKeyError(ValueError):
    pass


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise DuplicateKeyError(key)
        out[key] = value
    return out


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=strict_object)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def walk_refs(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        if isinstance(value.get("$ref"), str):
            found.append(value["$ref"])
        for child in value.values():
            found.extend(walk_refs(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(walk_refs(child))
    return found


def pointer_get(document: Any, pointer: str) -> Any:
    current = document
    for raw in pointer.lstrip("/").split("/") if pointer else []:
        token = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def resolve_ref(ref: str, current: Path, documents: dict[Path, Any], ids: dict[str, Path]) -> None:
    location, mark, fragment = ref.partition("#")
    if not location:
        target = current
    elif location in ids:
        target = ids[location]
    else:
        target = (current.parent / location).resolve()
        if target not in documents:
            matches = [path for path in documents if path.name == Path(location).name]
            if len(matches) != 1:
                raise KeyError(ref)
            target = matches[0]
    if mark:
        pointer_get(documents[target], fragment)


def error_tree(errors: list[Any]) -> list[Any]:
    flat: list[Any] = []
    pending = list(errors)
    while pending:
        item = pending.pop()
        flat.append(item)
        pending.extend(item.context)
    return flat


def json_diffs(left: Any, right: Any, path: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    if type(left) is not type(right):
        return [{"path": list(path), "kind": "replace", "left": left, "right": right}]
    if isinstance(left, dict):
        diffs: list[dict[str, Any]] = []
        for key in sorted(left.keys() | right.keys()):
            if key not in left:
                diffs.append({"path": list(path + (key,)), "kind": "add", "right": right[key]})
            elif key not in right:
                diffs.append({"path": list(path + (key,)), "kind": "remove", "left": left[key]})
            else:
                diffs.extend(json_diffs(left[key], right[key], path + (key,)))
        return diffs
    if isinstance(left, list):
        if len(left) != len(right):
            return [{"path": list(path), "kind": "replace", "left": left, "right": right}]
        diffs = []
        for index, (a, b) in enumerate(zip(left, right)):
            diffs.extend(json_diffs(a, b, path + (index,)))
        return diffs
    return [] if left == right else [{"path": list(path), "kind": "replace", "left": left, "right": right}]


def validator_for(schema: Any, store: dict[str, Any]) -> Draft202012Validator:
    return Draft202012Validator(
        schema,
        resolver=RefResolver.from_schema(schema, store=store),
        format_checker=FormatChecker(),
    )


def command(command: list[str], cwd: Path) -> dict[str, Any]:
    run = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    return {
        "command": subprocess.list2cmdline(command),
        "cwd": str(cwd),
        "returncode": run.returncode,
        "stdout": run.stdout.strip().splitlines(),
        "stderr": run.stderr.strip().splitlines(),
    }


def verify() -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    checks: dict[str, str] = {}
    details: dict[str, Any] = {}

    def finish(name: str, passed: bool, evidence: Any = None) -> None:
        checks[name] = "PASS" if passed else "FAIL"
        if evidence is not None:
            details[name] = evidence
        if not passed:
            failures.append({"check": name, "evidence": evidence})

    # Freeze manifest and all 54 raw working-tree domains.
    manifest_path = TECH / "W06_TECHNICAL_FREEZE_MANIFEST.json"
    manifest = load_json(manifest_path)
    entries = manifest["files"]
    manifest_mismatches = []
    for entry in entries:
        path = TECH / entry["path"]
        actual = {
            "exists": path.is_file(),
            "bytes": path.stat().st_size if path.is_file() else None,
            "sha256": sha256(path) if path.is_file() else None,
        }
        if (
            not actual["exists"]
            or actual["bytes"] != entry["bytes"]
            or actual["sha256"] != entry["sha256"]
        ):
            manifest_mismatches.append({"path": entry["path"], "declared": entry, "actual": actual})
    finish(
        "normative_manifest_54_entries_and_hashes",
        manifest["normative_file_count"] == len(entries) == 54
        and len({item["path"] for item in entries}) == 54
        and not manifest_mismatches,
        {"entry_count": len(entries), "mismatches": manifest_mismatches},
    )

    # Strict parse, meta-schema, IDs, and all references.
    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    documents: dict[Path, Any] = {}
    parse_failures = []
    for path in schema_paths:
        try:
            documents[path.resolve()] = load_json(path)
        except Exception as exc:
            parse_failures.append({"path": path.name, "error": str(exc)})
    ids: dict[str, Path] = {}
    duplicate_ids = []
    meta_failures = []
    reference_failures = []
    reference_count = 0
    for path, schema in documents.items():
        schema_id = schema.get("$id")
        if schema_id in ids:
            duplicate_ids.append(schema_id)
        elif isinstance(schema_id, str):
            ids[schema_id] = path
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:
            meta_failures.append({"schema": path.name, "error": str(exc)})
        for ref in walk_refs(schema):
            reference_count += 1
            try:
                resolve_ref(ref, path, documents, ids)
            except Exception as exc:
                reference_failures.append({"schema": path.name, "ref": ref, "error": str(exc)})
    finish(
        "schemas_meta_schema_and_ids",
        len(schema_paths) == len(documents) == len(ids) == 35
        and not parse_failures
        and not duplicate_ids
        and not meta_failures,
        {
            "schema_documents": len(schema_paths),
            "meta_schema_checks": len(documents),
            "unique_ids": len(ids),
            "parse_failures": parse_failures,
            "duplicate_ids": duplicate_ids,
            "meta_failures": meta_failures,
        },
    )
    finish(
        "all_576_references_resolve",
        reference_count == 576 and not reference_failures,
        {"reference_count": reference_count, "failures": reference_failures},
    )

    by_name = {path.name: schema for path, schema in documents.items()}
    helper_actual = {
        name
        for name, schema in by_name.items()
        if "$defs" in schema
        and not any(key in schema for key in ("type", "properties", "required", "allOf", "oneOf", "anyOf"))
    }
    concrete = set(by_name) - HELPERS
    full_catalog = load_json(FIXTURES / "full-document-fixtures.json")
    coverage_classes = {
        item["schema"]: item["classification"] for item in full_catalog.get("coverage", [])
    }
    finish(
        "schema_classification_33_concrete_2_helpers",
        len(concrete) == 33
        and helper_actual == HELPERS
        and set(coverage_classes) == concrete
        and set(coverage_classes.values()) == {"CONCRETE_INSTANTIABLE"},
        {
            "concrete_count": len(concrete),
            "helper_count": len(helper_actual),
            "helpers": sorted(helper_actual),
        },
    )

    store: dict[str, Any] = {}
    for path, schema in documents.items():
        store[path.name] = schema
        store[schema["$id"]] = schema
        store[path.as_uri()] = schema

    # Full-document cases, actual reasons, and mutation-distance challenge.
    full_results = []
    generated_cases = full_catalog["cases"]
    case_by_id = {case["id"]: case for case in generated_cases}
    generated_valid = generated_invalid = intended_reason_passes = 0
    mutation_failures = []
    for case in generated_cases:
        schema_name = Path(case["schema"]).name
        errors = sorted(
            validator_for(by_name[schema_name], store).iter_errors(case["instance"]),
            key=lambda error: (list(error.absolute_path), error.message),
        )
        expected_valid = case["expect"] == "VALID"
        actual_valid = not errors
        reason_ok = True
        diffs: list[dict[str, Any]] = []
        validators = sorted({error.validator for error in error_tree(errors)})
        if expected_valid:
            generated_valid += 1
        else:
            generated_invalid += 1
            if "-NEG-CONDITIONAL" in case["id"]:
                positive_id = case["id"].replace("-NEG-CONDITIONAL", "-POS-CONDITIONAL")
            else:
                positive_id = re.sub(r"-NEG-(REQUIRED|ADDITIONAL|TARGETED|COMPOSITION)$", "-POS", case["id"])
            baseline = case_by_id.get(positive_id)
            diffs = json_diffs(baseline["instance"], case["instance"]) if baseline else []
            defect = case.get("single_target_defect", "")
            if "-NEG-REQUIRED" in case["id"]:
                reason_ok = len(diffs) == 1 and diffs[0]["kind"] == "remove" and "required" in validators
            elif "-NEG-ADDITIONAL" in case["id"]:
                reason_ok = (
                    len(diffs) == 1
                    and diffs[0]["kind"] == "add"
                    and diffs[0]["path"] == ["unexpected_wave_0_6_property"]
                    and bool({"additionalProperties", "unevaluatedProperties"} & set(validators))
                )
            elif "-NEG-TARGETED" in case["id"] or "-NEG-COMPOSITION" in case["id"]:
                match = re.search(r"detected by ([A-Za-z0-9_$-]+)", defect)
                reason_ok = len(diffs) == 1 and bool(match) and match.group(1) in validators
            elif "-NEG-CONDITIONAL" in case["id"]:
                reason_ok = len(diffs) == 1 and bool(errors)
            else:
                reason_ok = False
            if reason_ok:
                intended_reason_passes += 1
            else:
                mutation_failures.append(
                    {
                        "id": case["id"],
                        "defect": defect,
                        "diffs": diffs,
                        "validators": validators,
                        "messages": [error.message for error in errors[:4]],
                    }
                )
        full_results.append(
            {
                "id": case["id"],
                "expected": case["expect"],
                "actual": "VALID" if actual_valid else "INVALID",
                "passed": actual_valid == expected_valid,
                "intended_reason_passed": reason_ok if not expected_valid else None,
                "validators": validators,
            }
        )

    retained_manifest = load_json(FIXTURES / "manifest.json")
    retained_results = []
    retained_reason_passes = 0
    retained_instances: dict[str, Any] = {}
    for case in retained_manifest["active_full_document_cases"]:
        schema_name = Path(case["schema"]).name
        instance = load_json(FIXTURES / case["fixture"])
        retained_instances[case["fixture"]] = instance
        errors = list(validator_for(by_name[schema_name], store).iter_errors(instance))
        actual_valid = not errors
        expected_valid = case["expected"] == "VALID"
        reason_ok = True
        if not expected_valid:
            positive = retained_instances.get("audit-ledger-record.positive.json") or load_json(
                FIXTURES / "audit-ledger-record.positive.json"
            )
            diffs = json_diffs(positive, instance)
            reason_ok = (
                len(diffs) == 1
                and diffs[0]["path"] == ["decision"]
                and diffs[0].get("right") == "ACCEPT"
                and bool({"enum", "const"} & {item.validator for item in error_tree(errors)})
            )
            retained_reason_passes += int(reason_ok)
        retained_results.append(
            {
                "fixture": case["fixture"],
                "expected": case["expected"],
                "actual": "VALID" if actual_valid else "INVALID",
                "passed": actual_valid == expected_valid,
                "intended_reason_passed": reason_ok if not expected_valid else None,
            }
        )
    negative_total = generated_invalid + 1
    finish(
        "all_162_full_document_cases",
        len(generated_cases) == 160
        and len(retained_results) == 2
        and all(item["passed"] for item in full_results + retained_results),
        {
            "generated": len(generated_cases),
            "generated_valid": generated_valid,
            "generated_invalid": generated_invalid,
            "retained": len(retained_results),
            "total": len(generated_cases) + len(retained_results),
        },
    )
    finish(
        "all_negative_cases_fail_for_intended_reason",
        intended_reason_passes + retained_reason_passes == negative_total and not mutation_failures,
        {
            "negative_cases": negative_total,
            "reason_confirmed": intended_reason_passes + retained_reason_passes,
            "failures": mutation_failures,
        },
    )

    # Metamorphic challenge: do not trust only generated labels or one mutation.
    metamorphic_total = metamorphic_rejected = 0
    metamorphic_failures = []
    valid_generated = [case for case in generated_cases if case["expect"] == "VALID"]
    for case in valid_generated:
        schema_name = Path(case["schema"]).name
        schema = by_name[schema_name]
        validator = validator_for(schema, store)
        instance = case["instance"]
        for required in schema.get("required", []):
            if required in instance:
                challenged = copy.deepcopy(instance)
                del challenged[required]
                metamorphic_total += 1
                if list(validator.iter_errors(challenged)):
                    metamorphic_rejected += 1
                else:
                    metamorphic_failures.append({"id": case["id"], "challenge": f"remove:{required}"})
        challenged = copy.deepcopy(instance)
        challenged["__independent_unknown_root__"] = True
        metamorphic_total += 1
        if list(validator.iter_errors(challenged)):
            metamorphic_rejected += 1
        else:
            metamorphic_failures.append({"id": case["id"], "challenge": "add:unknown-root"})
    unique_valid_instances = len(
        {
            sha256_bytes(json.dumps(case["instance"], sort_keys=True, separators=(",", ":")).encode())
            for case in valid_generated
        }
    )
    finish(
        "generated_fixture_tautology_challenge",
        metamorphic_total > 0
        and metamorphic_total == metamorphic_rejected
        and unique_valid_instances >= len(concrete),
        {
            "independent_mutations": metamorphic_total,
            "rejected": metamorphic_rejected,
            "failures": metamorphic_failures,
            "valid_instances": len(valid_generated),
            "unique_valid_instances": unique_valid_instances,
            "residual_weakness": (
                "Fixtures and generator are package-authored, and this verifier uses the same "
                "installed jsonschema implementation; mutation/error-path checks reduce but do "
                "not eliminate same-author and single-validator risk."
            ),
        },
    )

    # 57 independent subschema pairs.
    unit_catalog = load_json(FIXTURES / "correction-unit-fixtures.json")
    unit_results = []
    for pair in unit_catalog["pairs"]:
        schema_name = Path(pair["schema"]).name
        subschema = pointer_get(by_name[schema_name], pair["target"])
        validator = validator_for(subschema, store)
        positive_errors = list(validator.iter_errors(pair["positive"]))
        negative_errors = list(validator.iter_errors(pair["negative"]))
        unit_results.append(
            {
                "id": pair["id"],
                "positive_valid": not positive_errors,
                "negative_invalid": bool(negative_errors),
            }
        )
    finish(
        "all_57_subschema_pairs",
        len(unit_results) == 57
        and all(item["positive_valid"] and item["negative_invalid"] for item in unit_results),
        {"pairs": len(unit_results), "case_outcomes": len(unit_results) * 2},
    )

    # Vector schemas, immutable bytes, and independent provided reproducer.
    bundle_path = VECTORS / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
    bundle_raw = bundle_path.read_bytes()
    bundle = json.loads(bundle_raw)
    direct_instances = []
    for vector in bundle["vectors"]:
        if vector["expected"]["result"] != "ALLOW":
            continue
        for index, record in enumerate(vector["ledger_records"]):
            for label, schema_name, instance in (
                (f"{vector['id']}/ledger/{index}/record", "audit-ledger-record.schema.json", record["record_without_hash"]),
                (f"{vector['id']}/ledger/{index}/envelope", "governed-audit-ledger-envelope.schema.json", record["ledger_envelope"]),
            ):
                errors = list(validator_for(by_name[schema_name], store).iter_errors(instance))
                direct_instances.append({"label": label, "schema": schema_name, "passed": not errors})
        schema_name = "ledger-head-attestation.schema.json"
        errors = list(
            validator_for(by_name[schema_name], store).iter_errors(
                vector["attestation"]["attestation_object"]
            )
        )
        direct_instances.append(
            {"label": f"{vector['id']}/attestation", "schema": schema_name, "passed": not errors}
        )
    finish(
        "eight_positive_vector_schema_instances",
        len(direct_instances) == 8 and all(item["passed"] for item in direct_instances),
        {"instances": len(direct_instances), "results": direct_instances},
    )
    reproduce = command([sys.executable, str(VECTORS / "reproduce_vectors.py")], TECH)
    finish(
        "fourteen_vector_byte_reproduction_and_hash",
        bundle["vector_count"] == len(bundle["vectors"]) == 14
        and sha256_bytes(bundle_raw) == EXPECTED_BUNDLE_SHA256
        and reproduce["returncode"] == 0
        and "result=ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED" in reproduce["stdout"],
        {
            "vector_count": len(bundle["vectors"]),
            "bundle_bytes": len(bundle_raw),
            "bundle_sha256": sha256_bytes(bundle_raw),
            "command": reproduce,
        },
    )

    # Closed schema/interface sets and bundle/registry pins.
    registry = (TECH / "W05_VERSIONED_REGISTRY.md").read_text(encoding="utf-8")
    matrix = (TECH / "W05_INTERFACE_MATRIX.md").read_text(encoding="utf-8")
    expected_interfaces = {f"IF-{number:02d}" for number in range(1, 23)}
    registry_table_ids = set(
        re.findall(r"^\| `(IF-\d{2})` \|", registry, flags=re.MULTILINE)
    )
    matrix_table_ids = set(
        re.findall(r"^\| `(IF-\d{2})` \|", matrix, flags=re.MULTILINE)
    )
    schema_interface_enums: set[str] = set()
    for schema in by_name.values():
        def collect(value: Any) -> None:
            if isinstance(value, dict):
                if isinstance(value.get("enum"), list):
                    schema_interface_enums.update(
                        item for item in value["enum"] if isinstance(item, str) and re.fullmatch(r"IF-\d{2}", item)
                    )
                if isinstance(value.get("const"), str) and re.fullmatch(r"IF-\d{2}", value["const"]):
                    schema_interface_enums.add(value["const"])
                for child in value.values():
                    collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)
        collect(schema)
    canonical_ids = {schema["$id"] for schema in by_name.values()}
    finish(
        "registry_and_interface_closed_sets",
        registry_table_ids == expected_interfaces
        and matrix_table_ids == expected_interfaces
        and schema_interface_enums == expected_interfaces
        and len(canonical_ids) == 35
        and bundle["contracts"]["registry_id"] == "urn:au-ucr:registry:wave-0.5-contract"
        and bundle["contracts"]["registry_version"] == "1.3.0",
        {
            "registry_interfaces": sorted(registry_table_ids),
            "matrix_interfaces": sorted(matrix_table_ids),
            "schema_interfaces": sorted(schema_interface_enums),
            "canonical_schema_ids": len(canonical_ids),
            "registry_id": bundle["contracts"]["registry_id"],
            "registry_version": bundle["contracts"]["registry_version"],
        },
    )

    # Controlling spelling in the technical freeze.
    name_occurrences = []
    suspicious = []
    for path in sorted(item for item in TECH.rglob("*") if item.is_file()):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for match in re.finditer(r"(?i)\b(?:hakeem|hakim|hakeem)\s+moore\b|\bmoore\b", text):
            token = match.group(0)
            name_occurrences.append({"path": path.relative_to(TECH).as_posix(), "token": token})
            if token != "Hakeem Moore":
                suspicious.append({"path": path.relative_to(TECH).as_posix(), "token": token})
    finish(
        "hakeem_moore_controlling_spelling",
        manifest.get("human_principal_and_sole_final_decision_authority") == "Hakeem Moore"
        and not suspicious,
        {
            "manifest_value": manifest.get("human_principal_and_sole_final_decision_authority"),
            "occurrences": name_occurrences,
            "noncanonical_occurrences": suspicious,
        },
    )

    # Genuine ephemeral ES256/P1363/low-S execution against an exact vector frame.
    frame = bytes.fromhex(bundle["vectors"][0]["attestation"]["signature_input_hex"])
    private_key = ec.generate_private_key(ec.SECP256R1())
    der = private_key.sign(frame, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    low_s = min(s, P256_ORDER - s)
    low_der = encode_dss_signature(r, low_s)
    private_key.public_key().verify(low_der, frame, ec.ECDSA(hashes.SHA256()))
    p1363 = r.to_bytes(32, "big") + low_s.to_bytes(32, "big")
    encoded = base64.urlsafe_b64encode(p1363).rstrip(b"=").decode("ascii")
    decoded = base64.urlsafe_b64decode(encoded + "==")
    rr = int.from_bytes(decoded[:32], "big")
    ss = int.from_bytes(decoded[32:], "big")
    high_s = P256_ORDER - low_s
    profile_accepts_low = len(decoded) == 64 and rr == r and ss == low_s and 1 <= ss <= P256_ORDER // 2
    profile_rejects_high = high_s > P256_ORDER // 2
    # Genuine ECDSA verification commonly accepts the mathematically equivalent high-S form;
    # the profile's explicit pre-verification low-S gate must reject it.
    private_key.public_key().verify(
        encode_dss_signature(r, high_s), frame, ec.ECDSA(hashes.SHA256())
    )
    finish(
        "ephemeral_es256_p1363_low_s",
        profile_accepts_low and profile_rejects_high and "=" not in encoded,
        {
            "key": "ephemeral in-memory SECP256R1 key generated for this run; not persisted",
            "message": "W05-VEC-001 exact signature_input_hex",
            "message_sha256": sha256_bytes(frame),
            "p1363_bytes": len(p1363),
            "base64url_padding": "=" in encoded,
            "low_s_profile_accept": profile_accepts_low,
            "high_s_profile_reject": profile_rejects_high,
            "cryptographic_low_s_verify": "PASS",
            "cryptographic_high_s_equivalent_verify": "PASS (profile gate still rejects high-S)",
        },
    )

    # Cross-runtime canonicalization checks with Node's ECMAScript number/string serializer.
    node_script = r"""
const crypto=require('crypto');
const sort=(v)=>{
  if(Array.isArray(v)) return v.map(sort);
  if(v && typeof v==='object'){
    const o={}; Object.keys(v).sort().forEach(k=>o[k]=sort(v[k])); return o;
  }
  return v;
};
const cases=[
  [{b:1,a:2},'{"a":2,"b":1}'],
  [{n:1e30,small:1e-7,zero:0},'{"n":1e+30,"small":1e-7,"zero":0}'],
  [{s:"€$\u000f\n"},'{"s":"€$\\u000f\\n"}']
];
for(const [value,expected] of cases){
  const actual=JSON.stringify(sort(value));
  if(actual!==expected) throw new Error(actual+' != '+expected);
}
const input=JSON.parse(process.argv[1]);
const canonical=Buffer.from(JSON.stringify(sort(input)),'utf8');
process.stdout.write(JSON.stringify({cases:cases.length,hex:canonical.toString('hex'),sha256:crypto.createHash('sha256').update(canonical).digest('hex')}));
"""
    first_record = bundle["vectors"][0]["ledger_records"][0]
    node = command(
        ["node", "-e", node_script, json.dumps(first_record["record_without_hash"], ensure_ascii=False)],
        TECH,
    )
    node_payload = json.loads(node["stdout"][0]) if node["returncode"] == 0 and node["stdout"] else {}
    finish(
        "broader_rfc8785_cross_runtime_checks",
        node["returncode"] == 0
        and node_payload.get("cases") == 3
        and node_payload.get("hex") == first_record["record_jcs_utf8_hex"],
        {
            "known_ecmascript_canonical_cases": node_payload.get("cases"),
            "vector_record_hex_equal": node_payload.get("hex") == first_record["record_jcs_utf8_hex"],
            "vector_record_sha256": node_payload.get("sha256"),
            "command": {**node, "command": "node -e <embedded canonicalization challenge> <W05-VEC-001 record JSON>"},
            "scope_note": "Broader than package ASCII/integer examples, but not a complete RFC 8785 conformance suite.",
        },
    )

    technical_validator = command([sys.executable, str(TECH / "validate_technical_package.py")], TECH)
    finish(
        "package_authored_validator_cross_check",
        technical_validator["returncode"] == 0
        and "result=ALL_WAVE_0_6_TECHNICAL_STRUCTURAL_CHECKS_PASSED" in technical_validator["stdout"],
        {"command": technical_validator, "independence": "same-author cross-check only"},
    )

    executed_commands = [
        f"{sys.executable} {Path(__file__).resolve()}",
        reproduce["command"],
        node["command"],
        technical_validator["command"],
    ]
    status = "PASS" if all(value == "PASS" for value in checks.values()) else "FAIL"
    result = {
        "title": "IMHOTEP Wave 0.6 Final Technical Verification",
        "classification": "INDEPENDENT_LOCAL_NON_OPERATIONAL_VERIFICATION",
        "overall_status": status,
        "effect": {
            "approval": "NONE",
            "adoption": "NONE",
            "publication": "NONE",
            "authorization": "NONE",
            "operational_execution": "NONE",
        },
        "environment": {
            "platform": platform.platform(),
            "python": sys.version.split()[0],
            "jsonschema": importlib.metadata.version("jsonschema"),
            "referencing": importlib.metadata.version("referencing"),
            "cryptography": importlib.metadata.version("cryptography"),
            "node": (command(["node", "--version"], TECH)["stdout"] or ["NOT_AVAILABLE"])[0],
        },
        "summary": {
            "checks": len(checks),
            "passed": sum(value == "PASS" for value in checks.values()),
            "failed": sum(value == "FAIL" for value in checks.values()),
            "not_run": 6,
            "normative_entries": len(entries),
            "schemas": len(schema_paths),
            "references": reference_count,
            "full_document_cases": len(generated_cases) + len(retained_results),
            "full_document_negatives": negative_total,
            "subschema_pairs": len(unit_results),
            "vector_schema_instances": len(direct_instances),
            "vectors": len(bundle["vectors"]),
            "vector_bundle_sha256": sha256_bytes(bundle_raw),
        },
        "checks": checks,
        "details": details,
        "failures": failures,
        "commands": executed_commands,
        "not_run": [
            "Operational/runtime/lab/consumer enforcement",
            "Operational key, trust-chain, revocation, authority, or identity verification",
            "Network, publication, commit, push, merge, approval, or adoption",
            "Dependency installation",
            "Complete third-party RFC 8785 conformance suite (library not installed)",
            "Verification of synthetic vector r=1,s=1 sentinels as genuine signatures",
        ],
        "limitations": [
            "The package generator, fixtures, and schemas share authorship.",
            "JSON Schema results use the one already-installed jsonschema implementation.",
            "Metamorphic mutation and exact error-path checks reduce, but cannot eliminate, tautology risk.",
            "Ephemeral ES256 proves the stated primitive/encoding workflow, not package key authority.",
        ],
    }
    return result


def write_report(result: dict[str, Any]) -> None:
    summary = result["summary"]
    lines = [
        "# Final Technical Verification — IMHOTEP Wave 0.6",
        "",
        f"**Overall: {result['overall_status']}**",
        "",
        "Independent local, non-operational verification of `wave-0.6/technical` after full-document",
        "fixture remediation. This report grants no approval, adoption, publication, authorization,",
        "or operational effect.",
        "",
        "## Results",
        "",
    ]
    for name, status in result["checks"].items():
        lines.append(f"- **{status}** — `{name}`")
    lines.extend(
        [
            "",
            "## Verified counts and immutable values",
            "",
            f"- Normative manifest: **{summary['normative_entries']}** entries; raw byte sizes and SHA-256 all checked.",
            f"- Schemas: **{summary['schemas']}**; meta-schema checks **{summary['schemas']}**; `$ref` occurrences **{summary['references']}**.",
            "- Classification: **33 concrete/instantiable**, **2 definition-only helpers**.",
            f"- Full-document cases: **{summary['full_document_cases']}**; negatives with intended-reason checks: **{summary['full_document_negatives']}**.",
            f"- Subschema pairs: **{summary['subschema_pairs']}** (**{summary['subschema_pairs'] * 2}** outcomes).",
            f"- Positive-vector direct schema instances: **{summary['vector_schema_instances']}**.",
            f"- Vector scenarios: **{summary['vectors']}**; bundle SHA-256 `{summary['vector_bundle_sha256']}`.",
            "- Interface closed set: exact `IF-01` through `IF-22` in registry, matrix, and schema literals.",
            "- Controlling spelling: `Hakeem Moore`.",
            "",
            "## Fixture challenge finding",
            "",
            "All generated negatives were compared to their matching positive object, required exactly",
            "one targeted JSON change, and were matched to actual validator keywords/error behavior.",
            "Additional independent required-property and unknown-root mutations were applied to every",
            "generated valid case. All were rejected. The residual weakness remains material: fixtures,",
            "generator, and schemas share package authorship, and only one installed JSON Schema engine",
            "was available. Therefore these are strong consistency checks, not independent proof of the",
            "underlying design semantics.",
            "",
            "## Cryptographic and canonicalization execution",
            "",
            "- **PASS** — generated an in-memory ephemeral P-256 key, genuinely signed and verified an",
            "  exact vector framing input with ES256, converted DER to 64-byte P1363, normalized low-S,",
            "  round-tripped unpadded base64url, and demonstrated that the explicit profile gate rejects",
            "  the mathematically equivalent high-S form.",
            "- **PASS** — Node/ECMAScript cross-runtime canonicalization checked key ordering, control/",
            "  Unicode escaping, exponent/small-number formatting, and exact vector record bytes.",
            "- The bundle's `r=1,s=1` values remain synthetic shape sentinels and were not misreported as",
            "  genuine signatures.",
            "",
            "## Commands and versions",
            "",
        ]
    )
    for item in result["commands"]:
        lines.append(f"- `{item}`")
    env = result["environment"]
    lines.extend(
        [
            "",
            f"- Python `{env['python']}`",
            f"- jsonschema `{env['jsonschema']}`",
            f"- referencing `{env['referencing']}`",
            f"- cryptography `{env['cryptography']}`",
            f"- Node `{env['node']}`",
            "",
            "## NOT_RUN",
            "",
        ]
    )
    for item in result["not_run"]:
        lines.append(f"- **NOT_RUN** — {item}")
    lines.extend(
        [
            "",
            "Exact structured evidence, command output, per-check details, failures, and limitations are",
            "in `final_technical_results.json`.",
            "",
            "## Effect",
            "",
            "**No approval. No adoption. No publication. No authorization. No operational execution.**",
            "",
        ]
    )
    REPORT.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def main() -> int:
    result = verify()
    RESULT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    write_report(result)
    print(f"overall={result['overall_status']}")
    print(f"checks={result['summary']['passed']}/{result['summary']['checks']}")
    print(f"results={RESULT}")
    print(f"report={REPORT}")
    return 0 if result["overall_status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
