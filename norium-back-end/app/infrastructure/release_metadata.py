"""Public release identity, written into the image at build time.

Display metadata never determines authentication or security policy. Runtime
environment variables cannot replace the identity of the built image.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


RELEASE_METADATA_PATH = Path(__file__).resolve().parents[2] / "release.json"
STAGES = frozenset({"local", "homologacao", "producao"})
UNKNOWN_RELEASE = {"environment": "unknown", "version": None, "revision": None}


def validate_release(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("environment") not in STAGES:
        raise ValueError("Invalid release metadata")
    revision = value.get("revision")
    version = value.get("version")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Invalid release metadata")
    if not isinstance(version, str) or not re.fullmatch(r"20[0-9]{2}\.[0-9]{2}\.[0-9]{2}", version):
        raise ValueError("Invalid release metadata")
    try:
        datetime.strptime(version, "%Y.%m.%d")
    except ValueError as exc:
        raise ValueError("Invalid release metadata") from exc
    # Only these three public fields may leave the server.
    return {"environment": value["environment"], "version": version, "revision": revision}


def release_snapshot() -> dict[str, Any]:
    try:
        with RELEASE_METADATA_PATH.open("rb") as handle:
            data = handle.read(1025)
        if len(data) > 1024:
            raise ValueError("Oversized release metadata")
        return validate_release(json.loads(data))
    except (OSError, ValueError, TypeError, UnicodeError):
        return dict(UNKNOWN_RELEASE)


def write_release_metadata(stage: str, version: str, revision: str) -> None:
    payload = validate_release({"environment": stage, "version": version, "revision": revision})
    # Exclusive creation: never overwrite a metadata file from the source tree.
    with RELEASE_METADATA_PATH.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True)
        handle.write("\n")
    RELEASE_METADATA_PATH.chmod(0o644)


if __name__ == "__main__":
    import os

    write_release_metadata(
        os.environ.get("NORIUM_DEPLOYMENT_STAGE", ""),
        os.environ.get("NORIUM_RELEASE_VERSION", ""),
        os.environ.get("NORIUM_RELEASE_SHA", ""),
    )
