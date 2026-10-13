#!/usr/bin/env python3
"""Read-only, standard-library assurance checks over Waves 0.3-0.5.

This checker intentionally performs no network, laboratory, runtime, signing,
or operational activity. It writes only the requested assurance result file.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import unquote


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WAVES = [ROOT / f"wave-0.{number}" for number in (3, 4, 5)]
SCHEMAS = ROOT / "wave-0.5" / "schemas"
FIXTURES = SCHEMAS / "fixtures"
VECTORS = ROOT / "wave-0.5" / "vectors"
OUT = HERE / "PRELIMINARY_CHECK_RESULTS.json"


class DuplicateKeyError(ValueError):
    pass


def load_json(path: Path) -> Any:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise DuplicateKeyError(f"{path}: duplicate key {key!r}")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=reject_duplicates)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def walk_refs(value: Any, source: Path, pointer: str = ""):
    if isinstance(value, dict):
        for key, child in value.items():
            child_pointer = pointer + "/" + key.replace("~", "~0").replace("/", "~1")
            if key == "$ref" and isinstance(child, str):
                yield source, child_pointer, child
            yield from walk_refs(child, source, child_pointer)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_refs(child, source, f"{pointer}/{index}")


def resolve_pointer(document: Any, fragment: str) -> Any:
    if fragment in ("", "#"):
        return document
    if fragment.startswith("#"):
        fragment = fragment[1:]
    fragment = unquote(fragment)
    if not fragment.startswith("/"):
        raise ValueError(f"unsupported non-pointer fragment {fragment!r}")
    current = document
    for raw_token in fragment[1:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def classify_vector(vector: dict[str, Any]) -> str:
    return vector.get("expected", {}).get("result", "MISSING")


def main() -> None:
    all_files = sorted(
        (path for wave in WAVES for path in wave.rglob("*") if path.is_file()),
        key=lambda path: path.as_posix(),
    )
    inventory = []
    for path in all_files:
        inventory.append(
            {
                "path": path.relative_to(ROOT).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )

    json_paths = [path for path in all_files if path.suffix.lower() == ".json"]
    parsed: dict[Path, Any] = {}
    parse_errors = []
    for path in json_paths:
        try:
            parsed[path] = load_json(path)
        except Exception as exc:  # exact errors are evidence
            parse_errors.append({"path": str(path.relative_to(ROOT)), "error": str(exc)})

    schema_paths = sorted(SCHEMAS.glob("*.schema.json"))
    schema_ids: dict[str, str] = {}
    duplicate_ids = []
    schema_shape_issues = []
    for path in schema_paths:
        document = parsed.get(path)
        if not isinstance(document, dict):
            continue
        schema_id = document.get("$id")
        if schema_id in schema_ids:
            duplicate_ids.append([schema_ids[schema_id], path.name, schema_id])
        elif isinstance(schema_id, str):
            schema_ids[schema_id] = path.name
        if document.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            schema_shape_issues.append([path.name, "unexpected_or_missing_$schema"])
        if not isinstance(schema_id, str) or not re.fullmatch(
            r"urn:au-ucr:schema:[a-z0-9-]+:1\.0\.0", schema_id
        ):
            schema_shape_issues.append([path.name, "noncanonical_$id", schema_id])

    ref_total = 0
    local_ref_total = 0
    ref_errors = []
    for path in schema_paths:
        document = parsed.get(path)
        if document is None:
            continue
        for source, location, ref in walk_refs(document, path):
            ref_total += 1
            if ref.startswith(("http://", "https://", "urn:")):
                continue
            local_ref_total += 1
            file_part, separator, fragment = ref.partition("#")
            target_path = (source.parent / file_part).resolve() if file_part else source.resolve()
            try:
                target = parsed.get(target_path)
                if target is None:
                    target = load_json(target_path)
                    parsed[target_path] = target
                if separator:
                    resolve_pointer(target, fragment)
            except Exception as exc:
                ref_errors.append(
                    {
                        "source": source.name,
                        "location": location,
                        "ref": ref,
                        "error": str(exc),
                    }
                )

    manifest_path = FIXTURES / "manifest.json"
    manifest = parsed.get(manifest_path, {})
    unit_path = FIXTURES / "correction-unit-fixtures.json"
    unit = parsed.get(unit_path, {})
    pairs = unit.get("pairs", []) if isinstance(unit, dict) else []
    pointer_errors = []
    duplicate_pair_ids = [
        pair_id for pair_id, count in Counter(pair.get("id") for pair in pairs).items() if count > 1
    ]
    identical_unit_values = []
    for pair in pairs:
        try:
            target_path = (FIXTURES / pair["schema"]).resolve()
            target_document = parsed.get(target_path) or load_json(target_path)
            resolve_pointer(target_document, pair["target"])
            if pair.get("positive") == pair.get("negative"):
                identical_unit_values.append(pair.get("id"))
        except Exception as exc:
            pointer_errors.append({"id": pair.get("id"), "error": str(exc)})

    active_docs = manifest.get("active_full_document_cases", []) if isinstance(manifest, dict) else []
    active_missing = []
    for case in active_docs:
        for field in ("schema", "fixture"):
            candidate = (FIXTURES / case[field]).resolve()
            if not candidate.is_file():
                active_missing.append({"case": case, "missing": field})

    bundle_path = VECTORS / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
    bundle = parsed.get(bundle_path, {})
    vectors = bundle.get("vectors", []) if isinstance(bundle, dict) else []
    vector_ids = [vector.get("id") for vector in vectors]
    duplicate_vector_ids = [
        vector_id for vector_id, count in Counter(vector_ids).items() if count > 1
    ]
    results = Counter(classify_vector(vector) for vector in vectors)
    vector_files = sorted(path.name for path in VECTORS.iterdir() if path.is_file())

    markdown_paths = [path for path in all_files if path.suffix.lower() == ".md"]
    authority_terms = {
        "not_adopted": 0,
        "not_authorized": 0,
        "unassigned": 0,
        "independent": 0,
    }
    stale_baseline_mentions = []
    for path in markdown_paths:
        text = path.read_text(encoding="utf-8-sig")
        folded = text.lower()
        for key, token in (
            ("not_adopted", "not_adopted"),
            ("not_authorized", "not authorized"),
            ("unassigned", "unassigned"),
            ("independent", "independent"),
        ):
            authority_terms[key] += folded.count(token)
        for line_number, line in enumerate(text.splitlines(), 1):
            if "39bade0506b4d5b12bb979ccf6a51bb11944a9ff" in line:
                stale_baseline_mentions.append(
                    {"path": path.relative_to(ROOT).as_posix(), "line": line_number}
                )

    repo_root = ROOT.parents[2]
    explicit_reference_count = 0
    missing_explicit_references = []
    for path in markdown_paths:
        text = path.read_text(encoding="utf-8-sig")
        candidates = set(
            re.findall(
                r"`((?:docs/experiments/au-ucr-ep-000001/)?[A-Za-z0-9_./-]+\.(?:md|json|py|yaml))`",
                text,
            )
        )
        for candidate in sorted(candidates):
            explicit_reference_count += 1
            possible_targets = [
                repo_root / candidate,
                path.parent / candidate,
                ROOT / candidate,
                ROOT / "wave-0.3" / candidate,
                ROOT / "wave-0.4" / candidate,
                ROOT / "wave-0.5" / candidate,
                SCHEMAS / candidate,
                FIXTURES / candidate,
                VECTORS / candidate,
                repo_root / "qa" / "evidence" / "au-ucr-ep-000001-s0" / "star-wr-0001" / candidate,
                repo_root / "qa" / "evidence" / "au-ucr-ep-000001-s0" / "receipts" / candidate,
            ]
            if not any(target.is_file() for target in possible_targets):
                missing_explicit_references.append(
                    {"source": path.relative_to(ROOT).as_posix(), "reference": candidate}
                )

    matrix_text = (ROOT / "wave-0.5" / "W05_INTERFACE_MATRIX.md").read_text(encoding="utf-8-sig")
    registry_text = (ROOT / "wave-0.5" / "W05_VERSIONED_REGISTRY.md").read_text(encoding="utf-8-sig")
    objection_text = (ROOT / "wave-0.5" / "W05_NINE_OBJECTION_CLOSURE_MATRIX.md").read_text(
        encoding="utf-8-sig"
    )
    authority_text = (ROOT / "wave-0.5" / "W05_AUTHORITY_SCHEMA_REQUIREMENTS.md").read_text(
        encoding="utf-8-sig"
    )
    expected_interfaces = {f"IF-{number:02d}" for number in range(1, 23)}
    expected_objections = {f"W05-OBJ-{number:02d}" for number in range(1, 10)}
    matrix_interfaces = set(re.findall(r"\bIF-\d{2}\b", matrix_text))
    registry_interfaces = set(re.findall(r"\bIF-\d{2}\b", registry_text))
    objections = set(re.findall(r"\bW05-OBJ-\d{2}\b", objection_text))
    authority_requirement_numbers = {
        int(number) for number in re.findall(r"^###\s+(\d+)\.", authority_text, re.MULTILINE)
    }

    report = {
        "scope": "read-only non-operational checks over existing Wave 0.3-0.5 files",
        "checker": "AI subagent in same workspace; not organizationally independent",
        "inventory": {
            "file_count": len(all_files),
            "by_wave": {
                wave.name: sum(1 for path in all_files if wave in path.parents) for wave in WAVES
            },
            "by_extension": dict(sorted(Counter(path.suffix.lower() or "<none>" for path in all_files).items())),
            "files": inventory,
        },
        "json": {
            "file_count": len(json_paths),
            "strict_parse_successes": len(json_paths) - len(parse_errors),
            "parse_errors": parse_errors,
        },
        "schemas": {
            "schema_file_count": len(schema_paths),
            "unique_id_count": len(schema_ids),
            "duplicate_ids": duplicate_ids,
            "shape_issues": schema_shape_issues,
            "all_ref_occurrences": ref_total,
            "local_ref_occurrences": local_ref_total,
            "ref_errors": ref_errors,
        },
        "fixtures": {
            "active_full_document_cases": len(active_docs),
            "active_missing_files": active_missing,
            "declared_pair_count": manifest.get("active_subschema_unit_catalog", {}).get("pair_count"),
            "actual_pair_count": len(pairs),
            "duplicate_pair_ids": duplicate_pair_ids,
            "pointer_errors": pointer_errors,
            "identical_positive_negative_values": identical_unit_values,
            "active_case_total": len(active_docs) + 2 * len(pairs),
        },
        "vectors": {
            "bundle_sha256": sha256(bundle_path),
            "declared_count": bundle.get("vector_count"),
            "actual_count": len(vectors),
            "unique_id_count": len(set(vector_ids)),
            "duplicate_ids": duplicate_vector_ids,
            "result_counts": dict(sorted(results.items())),
            "directory_file_count": len(vector_files),
            "directory_files": vector_files,
        },
        "claims_scan": {
            "authority_limitation_term_occurrences": authority_terms,
            "baseline_39bade_mentions": stale_baseline_mentions,
            "baseline_39bade_mention_count": len(stale_baseline_mentions),
        },
        "cross_references": {
            "explicit_file_reference_occurrences": explicit_reference_count,
            "missing_explicit_references": missing_explicit_references,
        },
        "closed_set_checks": {
            "matrix_interface_ids": sorted(matrix_interfaces),
            "matrix_missing": sorted(expected_interfaces - matrix_interfaces),
            "matrix_unexpected": sorted(matrix_interfaces - expected_interfaces),
            "registry_interface_ids": sorted(registry_interfaces),
            "registry_missing": sorted(expected_interfaces - registry_interfaces),
            "registry_unexpected": sorted(registry_interfaces - expected_interfaces),
            "objection_ids": sorted(objections),
            "objection_missing": sorted(expected_objections - objections),
            "objection_unexpected": sorted(objections - expected_objections),
            "authority_requirement_numbers": sorted(authority_requirement_numbers),
            "authority_missing_numbers": sorted(set(range(1, 13)) - authority_requirement_numbers),
            "authority_unexpected_numbers": sorted(authority_requirement_numbers - set(range(1, 13))),
        },
    }
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "inventory"}, indent=2))
    print(f"result_file={OUT}")


if __name__ == "__main__":
    main()
