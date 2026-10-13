"""Verify the Wave 0.7 repository and evidence baseline without mutation."""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess


REPO = pathlib.Path(__file__).resolve().parents[5]
EXPERIMENT = REPO / "docs" / "experiments" / "au-ucr-ep-000001"
QA = REPO / "qa" / "evidence" / "au-ucr-ep-000001-s0" / "star-wr-0001"
OUTPUT = pathlib.Path(__file__).with_name("W07_BASELINE_RESULTS.json")


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def digest(path: pathlib.Path, lf: bool = False) -> str:
    data = path.read_bytes()
    if lf:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def enumerate_root(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(
        (
            path
            for path in root.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        ),
        key=lambda path: path.relative_to(REPO).as_posix().lower(),
    )


def verify_manifest(root: pathlib.Path, manifest_name: str) -> dict:
    manifest_path = root / manifest_name
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mismatches = []
    for entry in manifest["files"]:
        path = root / entry["path"]
        actual = {
            "exists": path.is_file(),
            "bytes": path.stat().st_size if path.is_file() else None,
            "sha256": digest(path) if path.is_file() else None,
        }
        if (
            not actual["exists"]
            or actual["bytes"] != entry["bytes"]
            or actual["sha256"] != entry["sha256"]
        ):
            mismatches.append(
                {"path": entry["path"], "declared": entry, "actual": actual}
            )
    return {
        "path": manifest_path.relative_to(REPO).as_posix(),
        "declared_file_count": manifest["file_count"]
        if "file_count" in manifest
        else manifest["normative_file_count"],
        "entry_count": len(manifest["files"]),
        "aggregate_sha256": manifest.get("aggregate_sha256"),
        "mismatches": mismatches,
    }


def main() -> None:
    tracked = {
        line.replace("\\", "/")
        for line in git("ls-files").splitlines()
        if line.strip()
    }
    roots = {}
    for name in ("wave-0.3", "wave-0.4", "wave-0.5", "wave-0.6"):
        root = EXPERIMENT / name
        paths = enumerate_root(root)
        relative = [path.relative_to(REPO).as_posix() for path in paths]
        roots[name] = {
            "files": len(paths),
            "bytes": sum(path.stat().st_size for path in paths),
            "tracked": sum(path in tracked for path in relative),
            "untracked": sum(path not in tracked for path in relative),
        }
    qa_paths = enumerate_root(QA)
    qa_relative = [path.relative_to(REPO).as_posix() for path in qa_paths]
    roots["qa"] = {
        "files": len(qa_paths),
        "bytes": sum(path.stat().st_size for path in qa_paths),
        "tracked": sum(path in tracked for path in qa_relative),
        "untracked": sum(path not in tracked for path in qa_relative),
    }

    qa_manifest = {}
    for raw_line in (QA / "MANIFEST.sha256").read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        expected, filename = raw_line.split(maxsplit=1)
        filename = filename.lstrip("*")
        qa_manifest[filename] = {
            "expected_lf_sha256": expected,
            "actual_lf_sha256": digest(QA / filename, lf=True),
        }

    result = {
        "project": "AU-UCR-EP-000001",
        "branch": git("branch", "--show-current"),
        "head": git("rev-parse", "HEAD"),
        "roots": roots,
        "qa_manifest": {
            "entries": len(qa_manifest),
            "matches": sum(
                item["expected_lf_sha256"] == item["actual_lf_sha256"]
                for item in qa_manifest.values()
            ),
            "details": qa_manifest,
        },
        "wave06_technical_manifest": verify_manifest(
            EXPERIMENT / "wave-0.6" / "technical",
            "W06_TECHNICAL_FREEZE_MANIFEST.json",
        ),
        "wave06_integrated_manifest": verify_manifest(
            EXPERIMENT / "wave-0.6", "W06_INTEGRATED_DOSSIER_MANIFEST.json"
        ),
    }
    result["status"] = (
        "PASS"
        if result["qa_manifest"]["entries"] == result["qa_manifest"]["matches"] == 9
        and not result["wave06_technical_manifest"]["mismatches"]
        and not result["wave06_integrated_manifest"]["mismatches"]
        else "FAIL"
    )
    OUTPUT.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"status={result['status']}")
    print(f"branch={result['branch']}")
    print(f"head={result['head']}")
    for name, values in roots.items():
        print(
            f"{name}_files={values['files']} "
            f"tracked={values['tracked']} untracked={values['untracked']}"
        )
    print(
        "wave06_integrated_manifest="
        f"{result['wave06_integrated_manifest']['entry_count']} entries, "
        f"{len(result['wave06_integrated_manifest']['mismatches'])} mismatches"
    )


if __name__ == "__main__":
    main()
