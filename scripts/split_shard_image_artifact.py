"""Split an already audited image artifact; never rebuild or contact the VPS."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


REQUIRED_GATES = {"validate", "postgres-persistence", "team-call-quality",
                  "shard-image-security", "shard-source-artifact"}
IMAGE_FILES = {"image.tar.gz", "image.tar.gz.sha256", "image-provenance.json",
               "image-audit-receipt.json"}
PART_BYTES = 250 * 1024 * 1024


def split_artifact(archive: Path, output: Path, revision: str, run: dict,
                   jobs: dict, artifact: dict, *, part_bytes: int = PART_BYTES) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("A full immutable source revision is required")
    if not 1 <= part_bytes <= PART_BYTES:
        raise ValueError("Transfer parts must stay below the connector size limit")
    if archive.stat().st_size > 3 * part_bytes:
        raise ValueError("This transfer supports up to three bounded parts")
    if (run.get("head_sha") != revision or run.get("status") != "completed"
            or run.get("conclusion") != "success"):
        raise ValueError("The source revision must have a completed successful CI")
    gates = {j["name"]: j for j in jobs.get("jobs", [])}
    if any(gates.get(name, {}).get("status") != "completed"
           or gates.get(name, {}).get("conclusion") != "success" for name in REQUIRED_GATES):
        raise ValueError("Every source promotion gate must pass")
    if (artifact.get("expired") is not False
            or artifact.get("workflow_run", {}).get("id") != run.get("id")
            or artifact.get("workflow_run", {}).get("head_sha") != revision
            or artifact.get("name") != "shard-deploy-image-" + revision):
        raise ValueError("Artifact provenance does not match the validated revision")
    digest = artifact.get("digest", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("A GitHub archive digest is required")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != "sha256:" + actual or archive.stat().st_size != artifact.get("size_in_bytes"):
        raise ValueError("The original GitHub archive failed integrity verification")
    with zipfile.ZipFile(archive) as source:
        if set(source.namelist()) != IMAGE_FILES or len(source.namelist()) != len(IMAGE_FILES):
            raise ValueError("The image archive contains unexpected entries")
        for name in IMAGE_FILES - {"image.tar.gz"}:
            if source.getinfo(name).file_size > 1024 * 1024:
                raise ValueError("Oversized image metadata")
        provenance = json.loads(source.read("image-provenance.json"))
        audit = json.loads(source.read("image-audit-receipt.json"))
        image = provenance.get("dockerImageId", "")
        if (not re.fullmatch(r"sha256:[0-9a-f]{64}", image)
                or provenance.get("commitSha") != revision or audit.get("commitSha") != revision
                or audit.get("dockerImageId") != image or audit.get("complete") is not True
                or audit.get("missingReports") != [] or audit.get("vulnerabilityGatePassed") is not True):
            raise ValueError("The exact image must have a complete successful audit")
        checksum = source.read("image.tar.gz.sha256").decode().strip()
        match = re.fullmatch(r"([0-9a-f]{64})  image\.tar\.gz", checksum)
        if not match:
            raise ValueError("Invalid audited image checksum")
        with source.open("image.tar.gz") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != match[1]:
                raise ValueError("The audited image bytes failed integrity verification")
    output.mkdir(parents=True, exist_ok=False)
    parts = []
    with archive.open("rb") as stream:
        while chunk := stream.read(part_bytes):
            name = "image.part." + str(len(parts) + 1).zfill(3)
            (output / name).write_bytes(chunk)
            parts.append({"name": name, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
    receipt = {"schemaVersion": 1, "sourceRevision": revision, "sourceRunId": run["id"],
               "sourceArtifactId": artifact["id"], "sourceArchiveBytes": archive.stat().st_size,
               "sourceArchiveSha256": actual, "dockerImageId": image,
               "imageArchiveSha256": match[1], "sourceGatesPassed": True, "rebuilt": False,
               "parts": parts}
    (output / "transfer-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    load = lambda path: json.loads(path.read_text())
    print(json.dumps(split_artifact(args.archive, args.output, args.revision,
                                   load(args.run), load(args.jobs), load(args.artifact))))
