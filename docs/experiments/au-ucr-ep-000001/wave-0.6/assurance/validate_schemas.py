#!/usr/bin/env python3
"""Non-operational Wave 0.5 JSON Schema checks using the installed validator."""

from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    from jsonschema import Draft202012Validator, RefResolver


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCHEMAS = ROOT / "wave-0.5" / "schemas"
FIXTURES = SCHEMAS / "fixtures"
OUT = HERE / "SCHEMA_VALIDATION_RESULTS.json"


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def pointer(document: Any, value: str) -> Any:
    current = document
    for raw in value.lstrip("/").split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def errors_for(validator: Draft202012Validator, instance: Any) -> list[str]:
    return [
        f"{'/'.join(map(str, error.absolute_path)) or '<root>'}: {error.message}"
        for error in sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path))
    ]


def main() -> None:
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    schemas = {path: load(path) for path in schema_paths}
    store: dict[str, Any] = {}
    for path, schema in schemas.items():
        store[path.resolve().as_uri()] = schema
        store[path.name] = schema
        if "$id" in schema:
            store[schema["$id"]] = schema

    metaschema_failures = []
    for path, schema in schemas.items():
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:
            metaschema_failures.append({"schema": path.name, "error": str(exc)})

    manifest = load(FIXTURES / "manifest.json")
    active_results = []
    for case in manifest["active_full_document_cases"]:
        schema_path = (FIXTURES / case["schema"]).resolve()
        schema = schemas[schema_path]
        resolver = RefResolver(base_uri=schema_path.as_uri(), referrer=schema, store=store)
        validator = Draft202012Validator(schema, resolver=resolver)
        validation_errors = errors_for(validator, load(FIXTURES / case["fixture"]))
        observed = "VALID" if not validation_errors else "INVALID"
        active_results.append(
            {
                "schema": schema_path.name,
                "fixture": case["fixture"],
                "expected": case["expected"],
                "observed": observed,
                "expectation_met": observed == case["expected"],
                "errors": validation_errors,
            }
        )

    unit_catalog = load(FIXTURES / "correction-unit-fixtures.json")
    unit_results = []
    for pair in unit_catalog["pairs"]:
        schema_path = (FIXTURES / pair["schema"]).resolve()
        full_schema = schemas[schema_path]
        subschema = pointer(full_schema, pair["target"])
        resolver = RefResolver(base_uri=schema_path.as_uri(), referrer=full_schema, store=store)
        validator = Draft202012Validator(subschema, resolver=resolver)
        positive_errors = errors_for(validator, pair["positive"])
        negative_errors = errors_for(validator, pair["negative"])
        unit_results.append(
            {
                "id": pair["id"],
                "schema": schema_path.name,
                "target": pair["target"],
                "positive_valid": not positive_errors,
                "negative_invalid": bool(negative_errors),
                "pair_pass": not positive_errors and bool(negative_errors),
                "positive_errors": positive_errors,
                "negative_errors": negative_errors,
            }
        )

    retired_results = []
    for fixture_name in manifest["retired_pre_correction_full_document_fixtures"]:
        stem = fixture_name.removesuffix(".positive.json").removesuffix(".negative.json")
        schema_path = (SCHEMAS / f"{stem}.schema.json").resolve()
        if schema_path not in schemas:
            retired_results.append(
                {"fixture": fixture_name, "observed": "NO_MATCHING_SCHEMA", "errors": []}
            )
            continue
        schema = schemas[schema_path]
        resolver = RefResolver(base_uri=schema_path.as_uri(), referrer=schema, store=store)
        validation_errors = errors_for(
            Draft202012Validator(schema, resolver=resolver), load(FIXTURES / fixture_name)
        )
        retired_results.append(
            {
                "fixture": fixture_name,
                "observed": "VALID" if not validation_errors else "INVALID",
                "errors": validation_errors,
            }
        )

    report = {
        "scope": "local non-operational JSON Schema validation; no dependency installation",
        "validator": "python jsonschema Draft202012Validator",
        "metaschema": {
            "checked": len(schema_paths),
            "passed": len(schema_paths) - len(metaschema_failures),
            "failures": metaschema_failures,
        },
        "active_full_documents": {
            "checked": len(active_results),
            "expectations_met": sum(item["expectation_met"] for item in active_results),
            "results": active_results,
        },
        "subschema_unit_pairs": {
            "checked": len(unit_results),
            "passed": sum(item["pair_pass"] for item in unit_results),
            "failures": [item for item in unit_results if not item["pair_pass"]],
        },
        "retired_full_documents_observation_only": retired_results,
        "limitations": [
            "Validation does not prove cross-object identity, ordering, state-machine, replay, hash, or signature semantics.",
            "Subschema unit checks do not establish complete-object validity.",
            "The installed validator and this same-workspace AI checker are not organizationally independent.",
        ],
    }
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"result_file={OUT}")


if __name__ == "__main__":
    main()
