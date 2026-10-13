#!/usr/bin/env python3
"""Wave 0.7 read-only reconciliation of the Wave 0.6 technical package."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
EXPERIMENT = REPO / "docs" / "experiments" / "au-ucr-ep-000001"
W05 = EXPERIMENT / "wave-0.5"
W06 = EXPERIMENT / "wave-0.6"
TECH = W06 / "technical"
SOURCE_VERIFIER = W06 / "verification" / "final_technical_verify.py"
RESULT = HERE / "W07_TECHNICAL_CHECK_RESULTS.json"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_snapshot(root: Path) -> dict[str, dict[str, Any]]:
    return {
        path.relative_to(root).as_posix(): {
            "bytes": path.stat().st_size,
            "sha256": digest(path),
        }
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def run(*args: str) -> dict[str, Any]:
    completed = subprocess.run(
        list(args),
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )
    return {
        "argv": list(args),
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def load_source_verifier():
    spec = importlib.util.spec_from_file_location("wave06_final_verifier", SOURCE_VERIFIER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SOURCE_VERIFIER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def technical_manifest_evidence() -> dict[str, Any]:
    path = TECH / "W06_TECHNICAL_FREEZE_MANIFEST.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    records = []
    framed = bytearray()
    mismatches = []
    for item in manifest["files"]:
        target = TECH / item["path"]
        actual = {
            "path": item["path"],
            "bytes": target.stat().st_size if target.is_file() else None,
            "sha256": digest(target) if target.is_file() else None,
        }
        records.append(actual)
        if actual["bytes"] != item["bytes"] or actual["sha256"] != item["sha256"]:
            mismatches.append({"declared": item, "actual": actual})
        framed.extend(item["path"].encode("utf-8"))
        framed.extend(b"\0")
        framed.extend(item["sha256"].encode("ascii"))
        framed.extend(b"\n")
    return {
        "manifest_path": path.relative_to(REPO).as_posix(),
        "manifest_bytes": path.stat().st_size,
        "manifest_sha256": digest(path),
        "declared_entries": manifest["normative_file_count"],
        "actual_entries": len(manifest["files"]),
        "unique_paths": len({item["path"] for item in manifest["files"]}),
        "member_mismatches": mismatches,
        "member_identity_aggregate_domain": "sha256(path_utf8 || NUL || declared_member_sha256_ascii || LF), manifest order",
        "member_identity_aggregate_sha256": hashlib.sha256(framed).hexdigest(),
        "members": records,
    }


def main() -> int:
    before = {"wave-0.5": tree_snapshot(W05), "wave-0.6": tree_snapshot(W06)}
    source = load_source_verifier().verify()
    after = {"wave-0.5": tree_snapshot(W05), "wave-0.6": tree_snapshot(W06)}

    branch = run("git", "branch", "--show-current")
    head = run("git", "rev-parse", "HEAD")
    tree = run("git", "show", "-s", "--format=%T", "HEAD")
    status = run("git", "status", "--porcelain=v1", "--untracked-files=all")
    tracked_w05 = run("git", "ls-files", "--", W05.relative_to(REPO).as_posix())
    tracked_w06 = run("git", "ls-files", "--", W06.relative_to(REPO).as_posix())

    status_bytes = status["stdout"].encode("utf-8")
    result = {
        "title": "IMHOTEP Wave 0.7 Technical Reconciliation Results",
        "task": "FOR-ACT-S0-001-W07-TECH",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "classification": "LOCAL_NON_OPERATIONAL_READ_ONLY_RECONCILIATION",
        "overall_status": source["overall_status"],
        "controlling_authority_spelling": "Hakeem Moore",
        "source_verifier": {
            "path": SOURCE_VERIFIER.relative_to(REPO).as_posix(),
            "sha256": digest(SOURCE_VERIFIER),
            "invocation": f"{sys.executable} {Path(__file__).resolve()}",
            "method": "Imported verify() and invoked it without calling its file-writing main().",
        },
        "repository": {
            "branch": branch["stdout"].strip(),
            "head": head["stdout"].strip(),
            "head_tree": tree["stdout"].strip(),
            "git_status_porcelain_sha256": hashlib.sha256(status_bytes).hexdigest(),
            "git_status_line_count": len(status["stdout"].splitlines()),
            "wave_0_5_tracked_file_count": len(tracked_w05["stdout"].splitlines()),
            "wave_0_6_tracked_file_count": len(tracked_w06["stdout"].splitlines()),
            "wave_0_5_file_count": len(after["wave-0.5"]),
            "wave_0_6_file_count": len(after["wave-0.6"]),
            "prior_wave_bytes_unchanged_by_run": before == after,
        },
        "technical_manifest": technical_manifest_evidence(),
        "reproduced_verification": source,
        "reconciled_counts": {
            "technical_manifest_entries": source["summary"]["normative_entries"],
            "schemas": source["summary"]["schemas"],
            "schema_classification": {"concrete": 33, "helpers": 2},
            "local_references": source["summary"]["references"],
            "full_document_outcomes": source["summary"]["full_document_cases"],
            "full_document_negative_outcomes": source["summary"]["full_document_negatives"],
            "subschema_pairs": source["summary"]["subschema_pairs"],
            "subschema_outcomes": source["summary"]["subschema_pairs"] * 2,
            "vectors": source["summary"]["vectors"],
            "positive_vector_schema_instances": source["summary"]["vector_schema_instances"],
            "checks_ran": source["summary"]["checks"],
            "checks_passed": source["summary"]["passed"],
            "checks_failed": source["summary"]["failed"],
            "not_run_classes": source["summary"]["not_run"],
        },
        "source_hashes": {
            "wave_0_5_vector_bundle_sha256": digest(
                W05 / "vectors" / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
            ),
            "wave_0_6_vector_bundle_sha256": digest(
                TECH / "vectors" / "W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json"
            ),
            "wave_0_6_full_document_fixture_catalog_sha256": digest(
                TECH / "schemas" / "fixtures" / "full-document-fixtures.json"
            ),
            "wave_0_6_subschema_fixture_catalog_sha256": digest(
                TECH / "schemas" / "fixtures" / "correction-unit-fixtures.json"
            ),
            "wave_0_6_recorded_final_results_sha256": digest(
                W06 / "verification" / "final_technical_results.json"
            ),
        },
        "effect": {
            "approval": "NONE",
            "authorization": "NONE",
            "adoption": "NONE",
            "publication": "NONE",
            "commit_push_merge": "NONE",
            "operational_enforcement": "NOT_CLAIMED",
        },
    }
    RESULT.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"overall={result['overall_status']}")
    print(
        "checks="
        f"{result['reconciled_counts']['checks_passed']}/"
        f"{result['reconciled_counts']['checks_ran']}"
    )
    print(f"prior_waves_unchanged={result['repository']['prior_wave_bytes_unchanged_by_run']}")
    print(f"result={RESULT}")
    return 0 if result["overall_status"] == "PASS" and before == after else 1


if __name__ == "__main__":
    raise SystemExit(main())
