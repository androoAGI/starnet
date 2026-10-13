#!/usr/bin/env python3
"""Generate the non-adopted Wave 0.6 technical manifest v1.1 proposal."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
TECH_ROOT = Path("docs/experiments/au-ucr-ep-000001/wave-0.6/technical")
SOURCE_MANIFEST = TECH_ROOT / "W06_TECHNICAL_FREEZE_MANIFEST.json"
DEFAULT_OUTPUT = Path("artifacts/plans/W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json")
PROPOSAL_BASELINE_COMMIT = "01b5e02a84fe260558c4ae66d03df91bb7f66c20"


def git(*args: str, binary: bool = False) -> bytes | str:
    completed = subprocess.run(
        ["git", *args],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=not binary,
    )
    return completed.stdout if binary else completed.stdout.strip()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def line_endings(data: bytes) -> dict[str, int]:
    without_crlf = data.replace(b"\r\n", b"")
    return {
        "crlf_pairs": data.count(b"\r\n"),
        "lone_lf": without_crlf.count(b"\n"),
        "lone_cr": without_crlf.count(b"\r"),
    }


def frame(entry: dict[str, Any]) -> bytes:
    blob = entry["git_blob"]
    normalized = entry["normalized"]
    return b"\0".join(
        [
            entry["path"].encode("utf-8"),
            blob["domain"].encode("ascii"),
            f"{blob['object_format']}:{blob['oid']}".encode("ascii"),
            str(blob["bytes"]).encode("ascii"),
            blob["sha256"].encode("ascii"),
            normalized["domain"].encode("ascii"),
            str(normalized["bytes"]).encode("ascii"),
            normalized["sha256"].encode("ascii"),
        ]
    ) + b"\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--commit",
        default=PROPOSAL_BASELINE_COMMIT,
        help="commit containing the proposed path bindings",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    commit = str(git("rev-parse", "--verify", f"{args.commit}^{{commit}}"))
    tree = str(git("show", "-s", "--format=%T", commit))
    object_format = str(git("rev-parse", "--show-object-format"))

    source_blob = git("show", f"{commit}:{SOURCE_MANIFEST.as_posix()}", binary=True)
    assert isinstance(source_blob, bytes)
    source = json.loads(source_blob)
    source_oid = str(git("rev-parse", f"{commit}:{SOURCE_MANIFEST.as_posix()}"))

    entries: list[dict[str, Any]] = []
    for historical in sorted(source["files"], key=lambda item: item["path"].casefold()):
        relative = historical["path"]
        parts = relative.split("/")
        if (
            not relative
            or "\\" in relative
            or relative.startswith("/")
            or re.match(r"^[A-Za-z]:", relative)
            or any(part in {"", ".", ".."} for part in parts)
            or any(char in relative for char in "\0\r\n")
        ):
            raise ValueError(f"unsafe manifest path: {relative}")
        relative = "/".join(parts)
        repo_path = (TECH_ROOT / relative).as_posix()
        oid = str(git("rev-parse", f"{commit}:{repo_path}"))
        if git("cat-file", "-t", oid) != "blob":
            raise ValueError(f"not a blob: {repo_path}")
        blob = git("cat-file", "blob", oid, binary=True)
        assert isinstance(blob, bytes)
        normalized = blob.replace(b"\r\n", b"\n")
        entries.append(
            {
                "path": relative,
                "repo_path": repo_path,
                "historical_v1_0_0": {
                    "domain": source["hash_domain"],
                    "bytes": historical["bytes"],
                    "sha256": historical["sha256"],
                },
                "git_blob": {
                    "domain": "git-blob-oid-v1",
                    "object_format": object_format,
                    "oid": oid,
                    "bytes": len(blob),
                    "sha256": sha256(blob),
                    "line_endings": line_endings(blob),
                },
                "normalized": {
                    "domain": "crlf-to-lf-sha256-v1",
                    "bytes": len(normalized),
                    "sha256": sha256(normalized),
                    "line_endings": line_endings(normalized),
                },
                "relations": {
                    "git_blob_equals_normalized": blob == normalized,
                    "historical_digest_equals_git_blob": historical["sha256"] == sha256(blob),
                    "historical_digest_equals_normalized": historical["sha256"] == sha256(normalized),
                },
            }
        )

    aggregate = hashlib.sha256(b"".join(frame(entry) for entry in entries)).hexdigest()
    manifest = {
        "schema_id": "urn:au-ucr:manifest:wave-0.6-technical-freeze:1.1.0-proposal",
        "project": "AU-UCR-EP-000001",
        "status": "PROPOSED_NOT_ADOPTED",
        "authorization_effect": "NONE",
        "source_manifest": {
            "path": SOURCE_MANIFEST.as_posix(),
            "schema_id": source["schema_id"],
            "git_blob": f"{object_format}:{source_oid}",
            "blob_sha256": sha256(source_blob),
        },
        "proposed_commit_binding": {
            "domain": "git-commit-path-binding-v1",
            "object_format": object_format,
            "commit_oid": commit,
            "tree_oid": tree,
            "path_root": TECH_ROOT.as_posix(),
        },
        "member_count": len(entries),
        "path_rule": "repository-relative UTF-8 paths with forward slashes; reject absolute, traversal, and duplicate paths",
        "ordering_rule": "ascending case-folded path; duplicate normalized paths prohibited",
        "domains": ["git-blob-oid-v1", "crlf-to-lf-sha256-v1"],
        "aggregate": {
            "algorithm": "sha256",
            "framing": (
                "path_utf8 || NUL || git_domain_ascii || NUL || object_format:oid_ascii || NUL || "
                "decimal_blob_bytes || NUL || blob_sha256_ascii || NUL || normalized_domain_ascii || "
                "NUL || decimal_normalized_bytes || NUL || normalized_sha256_ascii || LF"
            ),
            "sha256": aggregate,
        },
        "entries": entries,
        "effects": {
            "supersession": "PROPOSED_ONLY",
            "adoption": "NONE",
            "acceptance": "NONE",
            "preservation": "NONE",
            "publication": "NONE",
            "gate_p": "NO_CHANGE_BLOCKED_BY_EVIDENCE",
        },
    }

    paths = [entry["path"].casefold() for entry in entries]
    if len(paths) != len(set(paths)):
        raise ValueError("duplicate normalized manifest path")
    if len(entries) != source["normative_file_count"]:
        raise ValueError("source manifest count does not match generated proposal")

    output = args.output if args.output.is_absolute() else REPO / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"status={manifest['status']}")
    print(f"commit={commit}")
    print(f"members={len(entries)}")
    print(f"aggregate_sha256={aggregate}")
    print(f"output={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
