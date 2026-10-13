"""Read-only preliminary checks for IMHOTEP Wave 0.7 assurance preparation."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import subprocess
from datetime import datetime, timezone
from typing import Any


HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[4]
EXPERIMENT = REPO / "docs" / "experiments" / "au-ucr-ep-000001"
W06 = EXPERIMENT / "wave-0.6"
W07 = EXPERIMENT / "wave-0.7"
OUTPUT = HERE / "PRELIMINARY_W07_CHECK_RESULTS.json"


def git(*args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=REPO, text=True, encoding="utf-8"
    ).strip()


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def paths_under(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(
        (
            path
            for path in root.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        ),
        key=lambda path: path.relative_to(REPO).as_posix().casefold(),
    )


def inventory(root: pathlib.Path, tracked: set[str]) -> dict[str, Any]:
    entries = []
    aggregate = hashlib.sha256()
    for path in paths_under(root):
        relative = path.relative_to(REPO).as_posix()
        size = path.stat().st_size
        digest = sha256(path)
        state = "tracked" if relative in tracked else "untracked"
        line = f"{relative}\0{size}\0{digest}\0{state}\n".encode()
        aggregate.update(line)
        entries.append(
            {
                "path": relative,
                "bytes": size,
                "sha256": digest,
                "state": state,
            }
        )
    return {
        "root": root.relative_to(REPO).as_posix(),
        "file_count": len(entries),
        "bytes": sum(entry["bytes"] for entry in entries),
        "tracked": sum(entry["state"] == "tracked" for entry in entries),
        "untracked": sum(entry["state"] == "untracked" for entry in entries),
        "aggregate_sha256": aggregate.hexdigest(),
        "aggregate_construction": "SHA256(repo_path || NUL || decimal_size || NUL || raw_sha256 || NUL || state || LF), case-folded path order",
        "files": entries,
    }


def verify_manifest(root: pathlib.Path, name: str) -> dict[str, Any]:
    path = root / name
    document = json.loads(path.read_text(encoding="utf-8"))
    mismatches = []
    aggregate = hashlib.sha256()
    listed: set[str] = set()
    duplicate_paths = []
    for entry in document["files"]:
        relative = entry["path"].replace("\\", "/")
        if relative.casefold() in listed:
            duplicate_paths.append(relative)
        listed.add(relative.casefold())
        candidate = root / pathlib.PurePosixPath(relative)
        actual = {
            "exists": candidate.is_file(),
            "bytes": candidate.stat().st_size if candidate.is_file() else None,
            "sha256": sha256(candidate) if candidate.is_file() else None,
        }
        if (
            not actual["exists"]
            or actual["bytes"] != entry["bytes"]
            or actual["sha256"] != entry["sha256"]
        ):
            mismatches.append(
                {"path": relative, "declared": entry, "actual": actual}
            )
        aggregate.update(
            (
                relative.encode("utf-8")
                + b"\0"
                + str(entry["bytes"]).encode("ascii")
                + b"\0"
                + entry["sha256"].encode("ascii")
                + b"\n"
            )
        )
    self_name = name.casefold()
    actual_nonself = {
        candidate.relative_to(root).as_posix()
        for candidate in paths_under(root)
        if candidate.relative_to(root).as_posix().casefold() != self_name
    }
    unlisted = sorted(
        path for path in actual_nonself if path.casefold() not in listed
    )
    declared_count = document.get(
        "file_count", document.get("normative_file_count")
    )
    declared_aggregate = document.get("aggregate_sha256")
    computed_aggregate = aggregate.hexdigest()
    return {
        "path": path.relative_to(REPO).as_posix(),
        "declared_count": declared_count,
        "entry_count": len(document["files"]),
        "duplicate_paths": duplicate_paths,
        "identity_mismatches": mismatches,
        "declared_aggregate_sha256": declared_aggregate,
        "recomputed_aggregate_sha256": computed_aggregate,
        "aggregate_match": (
            declared_aggregate == computed_aggregate
            if declared_aggregate is not None
            else None
        ),
        "actual_nonself_files": len(actual_nonself),
        "unlisted_current_files": unlisted,
        "status": (
            "PASS"
            if declared_count == len(document["files"])
            and not duplicate_paths
            and not mismatches
            and (
                declared_aggregate is None
                or declared_aggregate == computed_aggregate
            )
            else "FAIL"
        ),
    }


def strict_json_check(root: pathlib.Path) -> dict[str, Any]:
    failures = []

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result

    paths = [path for path in paths_under(root) if path.suffix.lower() == ".json"]
    for path in paths:
        try:
            json.loads(
                path.read_text(encoding="utf-8"),
                object_pairs_hook=reject_duplicates,
            )
        except Exception as exc:  # evidence capture, not recovery
            failures.append(
                {
                    "path": path.relative_to(REPO).as_posix(),
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return {
        "documents": len(paths),
        "failures": failures,
        "status": "PASS" if not failures else "FAIL",
    }


def rerun_final_technical_verifier() -> dict[str, Any]:
    script = W06 / "verification" / "final_technical_verify.py"
    spec = importlib.util.spec_from_file_location("w06_final_verify", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.verify()
    return {
        "status": result["overall_status"],
        "summary": result["summary"],
        "checks": result["checks"],
        "not_run": result["not_run"],
        "limitations": result["limitations"],
        "execution_mode": "Imported verify() only; did not call report/result writers.",
    }


def text(path: str) -> str:
    return (W06 / path).read_text(encoding="utf-8")


def challenge_claims() -> dict[str, Any]:
    dossier = text("W06_FINAL_DECISION_DOSSIER.md")
    decision = text("governance/W06_FINAL_DECISION_REQUEST_AND_RECEIPTS.md")
    authority = text("governance/W06_AUTHORITY_IDENTITY_AND_MANDATE.md")
    scrum = text("scrum/W06_AUTHORITATIVE_SCRUM_CLOSURE.md")
    assurance = text("assurance/FINAL_ASSURANCE_AMENDMENT_1_DOSSIER_OVERLAY.md")
    final_results = json.loads(
        text("verification/final_technical_results.json")
    )
    findings = [
        {
            "id": "W07-PRELIM-01",
            "severity": "HIGH",
            "title": "Immutable approval prerequisite is unmet",
            "evidence": {
                "dossier_mutable_uncommitted": "The package remains local, mutable and uncommitted."
                in dossier,
                "approve_requires_immutable_categories": "every required dossier category is present, immutable"
                in decision,
                "missing_or_mutable_makes_approve_ineligible": "A missing category, mutable reference"
                in decision,
            },
            "required_correction": "Classify the current candidate as ineligible for APPROVE until the separately authorized immutable identity and required receipts exist, or amend the governing eligibility rule through valid authority.",
        },
        {
            "id": "W07-PRELIM-02",
            "severity": "HIGH",
            "title": "Named authority is not authenticated or appointed",
            "evidence": {
                "stable_identity_absent": "Stable machine identity: `NOT PROVIDED`"
                in authority,
                "acknowledgement_absent": "Signature or acknowledgement: `NOT PROVIDED`"
                in authority,
                "mandate_fields_blank": "Root mandate or self-attested principal basis: ``"
                in authority,
                "formal_appointment_absent": "not organizationally independent or formally appointed"
                in assurance,
            },
            "required_correction": "Keep Hakeem Moore as the named routing authority only; do not claim institutionally effective authority, appointment, independence, acceptance, or risk disposition without authenticated human-issued records.",
        },
        {
            "id": "W07-PRELIM-03",
            "severity": "MEDIUM",
            "title": "Verification classification overstates independence",
            "evidence": {
                "result_classification": final_results.get("classification"),
                "same_workspace_disclosed": "same workspace" in assurance.lower(),
            },
            "required_correction": "Rename or qualify INDEPENDENT_LOCAL_NON_OPERATIONAL_VERIFICATION as a separate same-workspace technical pass; reserve independent for governed organizational separation.",
        },
        {
            "id": "W07-PRELIM-04",
            "severity": "MEDIUM",
            "title": "Scrum verified counts mix heterogeneous evidence",
            "evidence": {
                "prior_verified_23": "Prior-wave task lines with at least one bounded `VERIFIED` executed check: **23**"
                in scrum,
                "design_trace_used_as_verified": "`VERIFIED` design trace only"
                in scrum,
                "operational_verified_zero": "Prior-wave task lines with operational/runtime verification: **0**"
                in scrum,
            },
            "required_correction": "Preserve completion, documentary review, executed technical verification, operational verification, acceptance, and human dependency as separately counted dimensions; do not aggregate them into an unqualified verified total.",
        },
        {
            "id": "W07-PRELIM-05",
            "severity": "HIGH",
            "title": "Current assurance is not final over Wave 0.7",
            "evidence": {
                "wave06_only": "Wave 0.6" in assurance,
                "same_workspace_ai": "AI subagent in the same workspace" in assurance,
            },
            "required_correction": "After Agents A-D integrate, rerun exact membership, hashes, claims, authority, Scrum, and verification checks against the fixed Wave 0.7 candidate. This preliminary report cannot assure concurrent outputs.",
        },
    ]
    return {
        "findings": findings,
        "finding_count": len(findings),
        "high": sum(item["severity"] == "HIGH" for item in findings),
        "medium": sum(item["severity"] == "MEDIUM" for item in findings),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, default=OUTPUT)
    args = parser.parse_args()
    tracked = {
        line.replace("\\", "/")
        for line in git("ls-files").splitlines()
        if line.strip()
    }
    wave_inventories = {
        name: inventory(EXPERIMENT / name, tracked)
        for name in ("wave-0.3", "wave-0.4", "wave-0.5", "wave-0.6")
    }
    external_w07 = [
        path
        for path in paths_under(W07)
        if HERE not in path.parents and path.parent != HERE
    ]
    w07_external_aggregate = hashlib.sha256()
    w07_external_entries = []
    for path in external_w07:
        relative = path.relative_to(REPO).as_posix()
        size = path.stat().st_size
        digest = sha256(path)
        state = "tracked" if relative in tracked else "untracked"
        w07_external_aggregate.update(
            f"{relative}\0{size}\0{digest}\0{state}\n".encode()
        )
        w07_external_entries.append(
            {
                "path": relative,
                "bytes": size,
                "sha256": digest,
                "state": state,
            }
        )
    result = {
        "schema_id": "urn:au-ucr:assurance:wave-0.7-preliminary-checks:1.0.0",
        "project": "AU-UCR-EP-000001",
        "task": "FOR-ACT-S0-001-W07-ASSURE",
        "reviewer_name": "Hakeem Moore",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "classification": "SAME_WORKSPACE_AI_PRELIMINARY_ASSURANCE_NOT_FORMALLY_APPOINTED",
        "independence_disclosure": "Agent E is an AI operating in the same workspace. It has no formal institutional appointment, identity proof, organizational independence, approval authority, or risk-acceptance authority.",
        "scope": "Wave 0.6 final package and current repository state; concurrent Wave 0.7 Agents A-D outputs are not finally assured.",
        "repository": {
            "branch": git("branch", "--show-current"),
            "head": git("rev-parse", "HEAD"),
            "status_porcelain_v1": git("status", "--porcelain=v1"),
        },
        "inventories": wave_inventories,
        "wave_0_7_external_snapshot": {
            "scope_note": "Wave 0.7 files outside this assurance directory at execution time.",
            "file_count": len(w07_external_entries),
            "aggregate_sha256": w07_external_aggregate.hexdigest(),
            "files": w07_external_entries,
        },
        "manifests": {
            "integrated": verify_manifest(
                W06, "W06_INTEGRATED_DOSSIER_MANIFEST.json"
            ),
            "technical": verify_manifest(
                W06 / "technical", "W06_TECHNICAL_FREEZE_MANIFEST.json"
            ),
        },
        "strict_json": strict_json_check(W06),
        "technical_verifier_rerun": rerun_final_technical_verifier(),
        "claim_challenges": challenge_claims(),
        "prohibited_actions": {
            "operational_or_lab": "NOT_RUN",
            "network_or_publication": "NOT_RUN",
            "commit_push_merge": "NOT_RUN",
            "approval_or_acceptance": "NONE",
        },
    }
    result["preliminary_status"] = (
        "CORRECTION_REQUIRED_BEFORE_FINAL_W07_REVIEW"
        if result["claim_challenges"]["high"]
        else "PRELIMINARY_PASS_WITH_LIMITS"
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"preliminary_status={result['preliminary_status']}")
    print(
        "w06_inventory="
        f"{wave_inventories['wave-0.6']['file_count']} files, "
        f"{wave_inventories['wave-0.6']['tracked']} tracked, "
        f"{wave_inventories['wave-0.6']['untracked']} untracked"
    )
    print(
        "integrated_manifest="
        f"{result['manifests']['integrated']['entry_count']} entries, "
        f"{len(result['manifests']['integrated']['identity_mismatches'])} mismatches"
    )
    summary = result["technical_verifier_rerun"]["summary"]
    print(f"technical_verifier={summary['passed']}/{summary['checks']} PASS")
    print(
        "findings="
        f"{result['claim_challenges']['high']} high, "
        f"{result['claim_challenges']['medium']} medium"
    )


if __name__ == "__main__":
    main()
