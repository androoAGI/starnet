"""Non-operational structural checks for the Wave 0.6 technical freeze."""

from __future__ import annotations

import hashlib
import json
import pathlib
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

from jsonschema import Draft202012Validator, FormatChecker, RefResolver


ROOT = pathlib.Path(__file__).resolve().parent
SCHEMAS = ROOT / "schemas"
VECTORS = ROOT / "vectors"


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def pointer(document, value: str):
    current = document
    for token in value.lstrip("/").split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def main() -> None:
    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    documents = {path.name: load_json(path) for path in schema_paths}
    store = {}
    for name, document in documents.items():
        store[name] = document
        store[document["$id"]] = document

    assert len(documents) == 35, f"expected 35 schemas, found {len(documents)}"
    assert len({doc["$id"] for doc in documents.values()}) == 35

    references = []
    for name, document in documents.items():
        Draft202012Validator.check_schema(document)

        def walk(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    references.append((name, value["$ref"]))
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(document)

    for name, reference in references:
        if reference.startswith(("#", "urn:", "http:", "https:")):
            continue
        target = SCHEMAS / reference.split("#", 1)[0]
        assert target.is_file(), f"{name}: unresolved local reference {reference}"

    def validator(schema_name: str) -> Draft202012Validator:
        document = documents[schema_name]
        return Draft202012Validator(
            document,
            resolver=RefResolver.from_schema(document, store=store),
            format_checker=FormatChecker(),
        )

    fixture_manifest = load_json(SCHEMAS / "fixtures" / "manifest.json")
    legacy_full_cases = 0
    for case in fixture_manifest["active_full_document_cases"]:
        schema_name = pathlib.Path(case["schema"]).name
        instance = load_json(SCHEMAS / "fixtures" / case["fixture"])
        observed_valid = not list(validator(schema_name).iter_errors(instance))
        expected_valid = case["expected"] == "VALID"
        assert observed_valid == expected_valid, case["fixture"]
        legacy_full_cases += 1

    full_catalog = load_json(
        SCHEMAS / "fixtures" / "full-document-fixtures.json"
    )
    helpers = {"common.schema.json", "authority-object-base.schema.json"}
    concrete = set(documents) - helpers
    assert full_catalog["concrete_schema_count"] == len(concrete) == 33
    assert full_catalog["abstract_helper_schema_count"] == len(helpers) == 2

    full_cases = 0
    full_valid = 0
    full_invalid = 0
    covered = {name: {"VALID": 0, "INVALID": 0} for name in concrete}
    requirement_counts = {}
    for case in full_catalog["cases"]:
        schema_name = pathlib.Path(case["schema"]).name
        assert schema_name in concrete, case["id"]
        errors = list(validator(schema_name).iter_errors(case["instance"]))
        observed_valid = not errors
        expected_valid = case["expect"] == "VALID"
        assert observed_valid == expected_valid, (
            case["id"],
            [error.message for error in errors[:3]],
        )
        covered[schema_name][case["expect"]] += 1
        requirement_counts[case["requirement"]] = (
            requirement_counts.get(case["requirement"], 0) + 1
        )
        full_valid += expected_valid
        full_invalid += not expected_valid
        full_cases += 1

    assert all(counts["VALID"] >= 1 and counts["INVALID"] >= 1 for counts in covered.values())
    assert requirement_counts["F-PRELIM-02:COMPLETE-OBJECT-POSITIVE"] == 33
    assert requirement_counts["F-PRELIM-02:REQUIRED-BOUNDARY"] == 33
    assert (
        requirement_counts[
            "F-PRELIM-02:ADDITIONAL-OR-UNEVALUATED-PROPERTY-BOUNDARY"
        ]
        == 33
    )
    assert requirement_counts["F-PRELIM-02:CONDITIONAL-THEN-POSITIVE"] == 3
    assert requirement_counts["F-PRELIM-02:CONDITIONAL-THEN-NEGATIVE"] == 3

    helper_dependents = {}
    for helper in helpers:
        helper_dependents[helper] = {
            name
            for name, document in documents.items()
            if name in concrete and helper in json.dumps(document)
        }
        assert helper_dependents[helper], helper

    catalog = load_json(SCHEMAS / "fixtures" / "correction-unit-fixtures.json")
    unit_pairs = 0
    for case in catalog["pairs"]:
        schema_name = pathlib.Path(case["schema"]).name
        subschema = pointer(documents[schema_name], case["target"])
        check = Draft202012Validator(
            subschema,
            resolver=RefResolver.from_schema(documents[schema_name], store=store),
            format_checker=FormatChecker(),
        )
        assert not list(check.iter_errors(case["positive"])), case["id"]
        assert list(check.iter_errors(case["negative"])), case["id"]
        unit_pairs += 1

    bundle_path = VECTORS / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
    bundle_bytes = bundle_path.read_bytes()
    bundle = json.loads(bundle_bytes)
    assert hashlib.sha256(bundle_bytes).hexdigest() == (
        "b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52"
    )
    assert bundle["vector_count"] == len(bundle["vectors"]) == 14
    assert sum(v["expected"]["result"] == "ALLOW" for v in bundle["vectors"]) == 2
    assert sum(v["expected"]["result"] == "REJECT" for v in bundle["vectors"]) == 12

    vector_instances = 0
    for vector in bundle["vectors"]:
        if vector["expected"]["result"] != "ALLOW":
            continue
        for record in vector["ledger_records"]:
            assert not list(
                validator("audit-ledger-record.schema.json").iter_errors(
                    record["record_without_hash"]
                )
            ), vector["id"]
            assert not list(
                validator("governed-audit-ledger-envelope.schema.json").iter_errors(
                    record["ledger_envelope"]
                )
            ), vector["id"]
            vector_instances += 2
        assert not list(
            validator("ledger-head-attestation.schema.json").iter_errors(
                vector["attestation"]["attestation_object"]
            )
        ), vector["id"]
        vector_instances += 1

    print(f"schema_documents={len(documents)}")
    print(f"unique_schema_ids={len(documents)}")
    print(f"metaschema_checks={len(documents)}")
    print(f"local_references={len(references)}")
    print(f"concrete_schemas={len(concrete)}")
    print(f"abstract_helper_schemas={len(helpers)}")
    print(f"generated_full_document_cases={full_cases}")
    print(f"generated_full_document_valid={full_valid}")
    print(f"generated_full_document_invalid={full_invalid}")
    print(f"retained_full_document_cases={legacy_full_cases}")
    print(f"all_current_full_document_cases={full_cases + legacy_full_cases}")
    print(
        "helper_concrete_dependents="
        + ",".join(
            f"{name}:{len(dependents)}"
            for name, dependents in sorted(helper_dependents.items())
        )
    )
    print(f"subschema_unit_pairs={unit_pairs}")
    print(f"positive_vector_schema_instances={vector_instances}")
    print("vector_scenarios=14")
    print("result=ALL_WAVE_0_6_TECHNICAL_STRUCTURAL_CHECKS_PASSED")


if __name__ == "__main__":
    main()
