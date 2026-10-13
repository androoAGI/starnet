"""Generate the non-self-referential Wave 0.6 dossier inventory."""

from __future__ import annotations

import hashlib
import json
import pathlib


ROOT = pathlib.Path(__file__).resolve().parent
OUTPUT = ROOT / "W06_INTEGRATED_DOSSIER_MANIFEST.json"
EXCLUDED = {
    OUTPUT.name,
}


def main() -> None:
    files = []
    for path in sorted(ROOT.rglob("*"), key=lambda item: item.as_posix().lower()):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative in EXCLUDED:
            continue
        raw = path.read_bytes()
        files.append(
            {
                "path": relative,
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )
    framed = b"".join(
        (
            item["path"].encode("utf-8")
            + b"\0"
            + str(item["bytes"]).encode("ascii")
            + b"\0"
            + item["sha256"].encode("ascii")
            + b"\n"
        )
        for item in files
    )
    manifest = {
        "schema_id": "urn:au-ucr:manifest:wave-0.6-integrated-dossier:1.0.0",
        "project": "AU-UCR-EP-000001",
        "human_principal_and_sole_final_decision_authority": "Hakeem Moore",
        "status": "LOCAL_EXACT_BYTE_INVENTORY_NOT_PUBLISHED_NOT_ACCEPTED",
        "hash_domain": "raw-working-tree-sha256-v1",
        "aggregate_construction": (
            "SHA256(path_utf8 || NUL || decimal_size || NUL || "
            "file_sha256_ascii || LF), sorted by case-folded forward-slash path"
        ),
        "self_exclusion": OUTPUT.name,
        "file_count": len(files),
        "aggregate_sha256": hashlib.sha256(framed).hexdigest(),
        "files": files,
    }
    OUTPUT.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"files={len(files)}")
    print(f"aggregate_sha256={manifest['aggregate_sha256']}")
    print(f"output={OUTPUT}")


if __name__ == "__main__":
    main()
