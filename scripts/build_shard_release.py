"""Build a deterministic Shard ZIP from a verified Git commit, without deploying.

Only Git blobs are packaged. The two explicit additions are the derived root
Dockerfile and the release manifest. The external receipt binds their bytes to
the ZIP. This proves source packaging, not equality with a later image rebuild.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any


MANIFEST_PATH = "norium-release-manifest.json"
MAX_ZIP_BYTES = 100_000_000
MAX_SOURCE_BYTES = 80_000_000
REQUIRED_FILES = (
    "Dockerfile.shard",
    "norium-back-end/main.py",
    "norium-back-end/app/__init__.py",
    "norium-back-end/requirements.lock.txt",
    "norium-front-end/package.json",
    "norium-front-end/package-lock.json",
)
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
RELEASE_ARG = b'ARG NORIUM_RELEASE_SHA=""'
RELEASE_VERSION_ARG = b'ARG NORIUM_RELEASE_VERSION=""'
_WINDOWS_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?\Z", re.I)
_PRIVATE_NAMES = {
    "credentials.json", "credential.json", "service-account.json",
    "service_account.json", "secrets.json", "secrets.yaml", "secrets.yml",
    "token.json", "tokens.json", "gmail_token.json", "gmail_oauth_state.json",
    "calendar_token.json", "calendar_oauth_state.json", "auth_secret.key",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc",
    ".netrc", ".pgpass", "pgpass.conf", ".git-credentials", ".envrc",
    ".dockercfg", ".pg_service.conf", "shardcloud.json", ".shardcloud.json",
}


class ReleasePackageError(ValueError):
    """A safe diagnostic that never includes source file contents or Git stderr."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _git_blob_sha1(data: bytes) -> str:
    # SHA-1 is required to verify this repository's Git object identity. Release
    # manifests and ZIP receipts use SHA-256, independently of Git's format.
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def validate_archive_path(name: str) -> str:
    """Reject names that could escape or alias during Linux/Windows extraction."""
    if not name or name.startswith("/") or "\\" in name or ":" in name:
        raise ReleasePackageError("Unsafe archive path.")
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ReleasePackageError("Control characters in archive path.")
    components = name.split("/")
    if any(part in ("", ".", "..") for part in components):
        raise ReleasePackageError("Non-canonical archive path.")
    if any(part.endswith((".", " ")) or _WINDOWS_RESERVED.fullmatch(part) for part in components):
        raise ReleasePackageError("Non-portable archive path.")
    if any(part.casefold() == ".git" for part in components):
        raise ReleasePackageError("Git metadata is not release content.")
    return name


def _reject_secret_filename(name: str) -> None:
    basename = name.rsplit("/", 1)[-1].casefold()
    if basename.startswith(".env") and basename != ".env.example":
        raise ReleasePackageError("Environment credential file in snapshot.")
    if basename in _PRIVATE_NAMES or basename.endswith((".key", ".p12", ".pfx", ".jks", ".keystore")):
        raise ReleasePackageError("Credential filename in snapshot.")
    if re.fullmatch(r"(?:[._-]?(?:secrets?|credentials?|tokens?|service[._-]account|private[._-]key))(?:[._-][a-z0-9_-]+)?\.(?:json|ya?ml|toml|txt|ini|conf)", basename):
        raise ReleasePackageError("Credential filename in snapshot.")
    if basename.endswith(".pem") and name != "norium-back-end/app/infrastructure/persistence/azure_postgres_roots.pem":
        raise ReleasePackageError("Unapproved PEM file in snapshot.")
    if any(part.casefold() in (".aws", ".ssh", ".azure", ".docker", "gcloud") for part in name.split("/")):
        raise ReleasePackageError("Credential directory in snapshot.")


def _git(repo: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=False, capture_output=True, stdin=subprocess.DEVNULL,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat"},
        timeout=120,
    )
    if result.returncode:
        raise ReleasePackageError("Git snapshot operation failed.")
    return result.stdout


def _snapshot_metadata(repo: Path, commit: str) -> tuple[str, int, dict[str, dict[str, Any]]]:
    if not SHA_RE.fullmatch(commit):
        raise ReleasePackageError("Commit must be a full lowercase 40-character Git SHA.")
    if _git(repo, "rev-parse", "--show-object-format").strip() != b"sha1":
        raise ReleasePackageError("Only SHA-1 Git repositories are supported.")
    resolved = _git(repo, "rev-parse", "--verify", commit + "^{commit}").decode("ascii").strip()
    if resolved != commit:
        raise ReleasePackageError("Git resolved a different commit.")
    tree_sha = _git(repo, "rev-parse", "--verify", commit + "^{tree}").decode("ascii").strip()
    if not SHA_RE.fullmatch(tree_sha):
        raise ReleasePackageError("Invalid Git tree identity.")
    timestamp = int(_git(repo, "show", "--no-patch", "--format=%ct", commit).strip())
    entries: dict[str, dict[str, Any]] = {}
    aliases: set[str] = set()
    total = 0
    for record in _git(repo, "ls-tree", "-r", "-z", "--long", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        try:
            metadata, encoded_path = record.split(b"\t", 1)
            mode, object_type, object_sha, size_text = metadata.split()
            path = validate_archive_path(encoded_path.decode("utf-8", errors="strict"))
            size = int(size_text)
        except (ValueError, UnicodeError) as error:
            raise ReleasePackageError("Invalid Git tree entry.") from error
        if mode not in (b"100644", b"100755") or object_type != b"blob":
            raise ReleasePackageError("Links, submodules and special files are forbidden.")
        if not SHA_RE.fullmatch(object_sha.decode("ascii")):
            raise ReleasePackageError("Invalid Git blob identity.")
        _reject_secret_filename(path)
        if path.casefold() == MANIFEST_PATH.casefold() or path.casefold() in aliases:
            raise ReleasePackageError("Reserved manifest path or case-colliding source paths.")
        if path.casefold() == "dockerfile" and path != "Dockerfile":
            raise ReleasePackageError("Root Dockerfile has a case-colliding name.")
        aliases.add(path.casefold())
        total += size
        if size < 0 or total > MAX_SOURCE_BYTES:
            raise ReleasePackageError("Source snapshot exceeds the package size budget.")
        entries[path] = {"gitBlobSha1": object_sha.decode("ascii"), "gitMode": mode.decode("ascii"), "size": size}
    if not entries or any(path not in entries for path in REQUIRED_FILES):
        raise ReleasePackageError("Required Shard source files are missing.")
    return tree_sha, timestamp, entries


def _archive_to_path(repo: Path, commit: str, archive_path: Path) -> None:
    # A Windows worktree's autocrlf setting also affects git archive. Override
    # it for this read only; the package must contain verified Git blob bytes.
    _git(repo, "-c", "core.autocrlf=false", "-c", "core.eol=lf",
         "archive", "--format=tar", "--output=" + str(archive_path), commit)


def _read_archive(archive_path: Path, entries: dict[str, dict[str, Any]]) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    with tarfile.open(archive_path, mode="r:") as archive:
        for member in archive:
            if member.isdir():
                validate_archive_path(member.name.rstrip("/"))
                continue
            path = validate_archive_path(member.name)
            if not member.isfile() or path not in entries or path in files:
                raise ReleasePackageError("Unexpected, duplicate or linked archive entry.")
            expected = entries[path]
            if member.size != expected["size"]:
                raise ReleasePackageError("Archive size differs from the Git snapshot.")
            stream = archive.extractfile(member)
            if stream is None:
                raise ReleasePackageError("Archive file is unreadable.")
            with stream:
                data = stream.read(expected["size"] + 1)
            if len(data) != expected["size"] or _git_blob_sha1(data) != expected["gitBlobSha1"]:
                raise ReleasePackageError("Archive content differs from the Git blob.")
            files[path] = data
    if set(files) != set(entries):
        raise ReleasePackageError("Git archive omitted versioned files; export filters are not permitted.")
    return files


def release_version(commit_timestamp: int) -> str:
    # CalVer identifies the source revision date in UTC, never the packaging
    # machine's clock. The SHA distinguishes releases built on the same day.
    return time.strftime("%Y.%m.%d", time.gmtime(commit_timestamp))


def derive_dockerfile(source: bytes, commit: str, commit_timestamp: int) -> bytes:
    if not SHA_RE.fullmatch(commit):
        raise ReleasePackageError("Invalid release SHA for Dockerfile derivation.")
    lines = source.splitlines(keepends=True)
    for name, marker, value in (
        (b"NORIUM_RELEASE_SHA", RELEASE_ARG, commit),
        (b"NORIUM_RELEASE_VERSION", RELEASE_VERSION_ARG, release_version(commit_timestamp)),
    ):
        positions = [index for index, line in enumerate(lines) if line.rstrip(b"\r\n") == marker]
        arguments = [line for line in lines if re.match(rb"[ \t]*ARG[ \t]+" + name + rb"(?:[= \t]|$)", line)]
        if len(positions) != 1 or len(arguments) != 1:
            raise ReleasePackageError("Dockerfile must declare exactly the approved empty release ARGs.")
        index = positions[0]
        lines[index] = lines[index].replace(marker, b'ARG ' + name + b'="' + value.encode("ascii") + b'"', 1)
    return b"".join(lines)


def _zip_timestamp(commit_timestamp: int) -> tuple[int, int, int, int, int, int]:
    # ZIP stores two-second UTC precision. Bounds make old/future synthetic
    # commits portable and deterministic, without consulting the wall clock.
    epoch = min(max(commit_timestamp, 315532800), 4354819198)
    parts = time.gmtime(epoch)
    return parts.tm_year, parts.tm_mon, parts.tm_mday, parts.tm_hour, parts.tm_min, parts.tm_sec // 2 * 2


def _write_zip(path: Path, files: dict[str, bytes], modes: dict[str, str], timestamp: int) -> None:
    # Stored ZIP entries avoid differences between zlib implementations.
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name in sorted(files):
            item = zipfile.ZipInfo(name, date_time=_zip_timestamp(timestamp))
            item.create_system = 3
            item.external_attr = (stat.S_IFREG | (0o755 if modes.get(name) == "100755" else 0o644)) << 16
            item.compress_type = zipfile.ZIP_STORED
            archive.writestr(item, files[name])


def _no_link_ancestors(path: Path) -> None:
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink() or (hasattr(ancestor, "is_junction") and ancestor.is_junction()):
            raise ReleasePackageError("Output paths must not use symlinks or junctions.")


def _workspace_output(repo: Path, output_dir: Path) -> tuple[Path, Path]:
    repo = repo.absolute()
    _no_link_ancestors(repo)
    repo = repo.resolve(strict=True)
    actual_root = Path(_git(repo, "rev-parse", "--show-toplevel").decode("utf-8").strip()).resolve(strict=True)
    if actual_root != repo:
        raise ReleasePackageError("--repo must identify the Git worktree root.")
    output_dir = output_dir.absolute()
    _no_link_ancestors(output_dir)
    resolved_output = output_dir.resolve(strict=False)
    if resolved_output == repo or not resolved_output.is_relative_to(repo):
        raise ReleasePackageError("Output directory must remain inside the selected workspace.")
    relative = resolved_output.relative_to(repo)
    if any(part.casefold() in (".git", ".agents", ".codex", ".aws", "node_modules") for part in relative.parts):
        raise ReleasePackageError("Protected workspace directory cannot hold a release.")
    return repo, resolved_output


def _publish_file(source: Path, destination: Path) -> None:
    # Exclusive creation never overwrites an existing release or follows a
    # destination symlink. No recursive removal is performed in the workspace.
    with source.open("rb") as reader, destination.open("xb") as writer:
        shutil.copyfileobj(reader, writer)
        writer.flush()
        os.fsync(writer.fileno())


def build_release(repo: Path, commit: str, output_dir: Path) -> dict[str, Any]:
    repo, output_dir = _workspace_output(repo, output_dir)
    tree_sha, timestamp, entries = _snapshot_metadata(repo, commit)
    output_zip = output_dir / ("norium-" + commit + "-shard.zip")
    output_receipt = output_dir / ("norium-" + commit + "-shard.receipt.json")
    if output_zip.exists() or output_zip.is_symlink() or output_receipt.exists() or output_receipt.is_symlink():
        raise ReleasePackageError("Release output already exists; use a fresh output directory.")

    with tempfile.TemporaryDirectory(prefix="norium-shard-release-") as temporary_name:
        temporary = Path(temporary_name).resolve(strict=True)
        expected_parent = Path(tempfile.gettempdir()).resolve(strict=True)
        if temporary.parent != expected_parent or not temporary.name.startswith("norium-shard-release-"):
            raise ReleasePackageError("Unexpected temporary directory location.")
        _no_link_ancestors(temporary)
        tar_path = temporary / "snapshot.tar"
        _archive_to_path(repo, commit, tar_path)
        files = _read_archive(tar_path, entries)
        source_hashes = {path: _sha256(data) for path, data in files.items()}
        source_dockerfile = files["Dockerfile.shard"]
        derived_dockerfile = derive_dockerfile(source_dockerfile, commit, timestamp)
        files["Dockerfile"] = derived_dockerfile
        modes = {path: entry["gitMode"] for path, entry in entries.items()}
        modes["Dockerfile"] = "100644"
        manifest = {
            "schemaVersion": 1,
            "commitSha": commit,
            "treeSha": tree_sha,
            "commitTimestamp": timestamp,
            "releaseVersion": release_version(timestamp),
            "zipTimestampUtc": list(_zip_timestamp(timestamp)),
            "archiveMethod": "git archive; every regular blob verified against Git SHA-1",
            "dockerfileDerivation": {
                "sourcePath": "Dockerfile.shard", "destinationPath": "Dockerfile",
                "sourceSha256": _sha256(source_dockerfile),
                "derivedSha256": _sha256(derived_dockerfile),
                "replacement": "Only the empty release SHA/version ARG defaults are set from the Git revision and its UTC date.",
            },
            "sourceFiles": [
                {"path": path, **entries[path], "sha256": source_hashes[path]}
                for path in sorted(entries)
            ],
            "packageFiles": [
                {"path": path, "size": len(data), "sha256": _sha256(data), "gitMode": modes[path]}
                for path, data in sorted(files.items())
            ],
        }
        manifest_bytes = _json_bytes(manifest)
        files[MANIFEST_PATH] = manifest_bytes
        modes[MANIFEST_PATH] = "100644"
        temporary_zip = temporary / "release.zip"
        _write_zip(temporary_zip, files, modes, timestamp)
        zip_size = temporary_zip.stat().st_size
        if zip_size > MAX_ZIP_BYTES:
            raise ReleasePackageError("ZIP exceeds Shard's 100 MB upload limit.")
        with temporary_zip.open("rb") as stream:
            zip_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        receipt = {
            "schemaVersion": 1, "commitSha": commit, "treeSha": tree_sha,
            "releaseVersion": release_version(timestamp),
            "zipFile": output_zip.name, "zipBytes": zip_size, "zipSha256": zip_sha256,
            "manifestPath": MANIFEST_PATH, "manifestSha256": _sha256(manifest_bytes),
            "dockerfileDerivation": manifest["dockerfileDerivation"],
            "imageValidation": "Not performed; this receipt proves source packaging only.",
        }
        temporary_receipt = temporary / "receipt.json"
        temporary_receipt.write_bytes(_json_bytes(receipt))
        output_dir.mkdir(parents=True, exist_ok=True)
        _no_link_ancestors(output_dir)
        _publish_file(temporary_zip, output_zip)
        _publish_file(temporary_receipt, output_receipt)
    return {**receipt, "zipPath": str(output_zip), "receiptPath": str(output_receipt)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="Git worktree root")
    parser.add_argument("--commit", required=True, help="Full lowercase reviewed Git commit SHA")
    parser.add_argument("--output-dir", type=Path, required=True, help="Fresh output directory inside --repo")
    arguments = parser.parse_args(argv)
    try:
        result = build_release(arguments.repo, arguments.commit, arguments.output_dir)
    except (ReleasePackageError, OSError, subprocess.TimeoutExpired, tarfile.TarError, zipfile.BadZipFile) as error:
        parser.exit(1, "Release package failed: " + (str(error) if isinstance(error, ReleasePackageError) else type(error).__name__) + "\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
