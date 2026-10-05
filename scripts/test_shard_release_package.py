"""Synthetic Git/archive tests; no remote account, credential or deployment."""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from scripts import build_shard_release as release


class ShardReleasePackageTests(unittest.TestCase):
    def test_worktree_crlf_configuration_does_not_transform_git_blob_bytes(self) -> None:
        commit = self.commit
        baseline = release.build_release(self.repo, commit, self.repo / "output" / "lf")
        self._git("config", "core.autocrlf", "true")
        self._git("config", "core.eol", "crlf")
        actual = release.build_release(self.repo, commit, self.repo / "output" / "crlf")
        self.assertEqual(baseline["zipSha256"], actual["zipSha256"])
        self.assertEqual(b"true", self._git("config", "--get", "core.autocrlf").strip())

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="norium-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name) / "repo"
        self.repo.mkdir()
        self.git_env = {
            **os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_DATE": "2026-10-04T10:00:00+00:00",
            "GIT_COMMITTER_DATE": "2026-10-04T10:00:00+00:00",
        }
        self._git("init", "--quiet", "--object-format=sha1", "--template=")
        self._git("config", "user.name", "Synthetic Release")
        self._git("config", "user.email", "release@example.invalid")
        self._git("config", "core.autocrlf", "false")
        for path in release.REQUIRED_FILES:
            target = self.repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            content = b"synthetic\n"
            if path == "Dockerfile.shard":
                content = b'FROM scratch\nARG NORIUM_RELEASE_SHA=""\nARG NORIUM_RELEASE_VERSION=""\nENV NORIUM_RELEASE_SHA=${NORIUM_RELEASE_SHA}\n'
            target.write_bytes(content)
        (self.repo / "Dockerfile").write_bytes(b"old root Dockerfile\n")
        (self.repo / "executable.sh").write_bytes(b"#!/bin/sh\nexit 0\n")
        (self.repo / ".env.example").write_bytes(b"SYNTHETIC_SETTING=\n")
        self._git("add", ".")
        self._git("update-index", "--chmod=+x", "executable.sh")
        self._git("commit", "--quiet", "-m", "synthetic release")
        self.commit = self._git("rev-parse", "HEAD").decode().strip()

    def _git(self, *arguments: str, data: bytes | None = None) -> bytes:
        result = subprocess.run(
            ["git", "-C", str(self.repo), *arguments], input=data,
            capture_output=True, check=True, env=self.git_env, timeout=30,
        )
        return result.stdout

    def _commit_file(self, path: str, content: bytes) -> str:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        self._git("add", path)
        self._git("commit", "--quiet", "-m", "synthetic additional file")
        return self._git("rev-parse", "HEAD").decode().strip()

    def _archive(self, members: list[tuple[str, bytes, bytes]]) -> Path:
        path = Path(self.temporary.name) / "synthetic.tar"
        with tarfile.open(path, "w") as archive:
            for name, data, member_type in members:
                item = tarfile.TarInfo(name)
                item.type = member_type
                if member_type == tarfile.REGTYPE:
                    item.size = len(data)
                    archive.addfile(item, io.BytesIO(data))
                else:
                    item.linkname = "../outside"
                    archive.addfile(item)
        return path

    def test_two_builds_are_identical_and_manifest_binds_snapshot(self) -> None:
        first = release.build_release(self.repo, self.commit, self.repo / "output/first")
        second = release.build_release(self.repo, self.commit, self.repo / "output/second")
        self.assertEqual(first["zipSha256"], second["zipSha256"])
        self.assertEqual(Path(first["zipPath"]).read_bytes(), Path(second["zipPath"]).read_bytes())
        self.assertEqual(Path(first["receiptPath"]).read_bytes(), Path(second["receiptPath"]).read_bytes())
        with zipfile.ZipFile(first["zipPath"]) as archive:
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            manifest_data = archive.read(release.MANIFEST_PATH)
            manifest = json.loads(manifest_data)
            self.assertEqual(manifest["commitSha"], self.commit)
            self.assertEqual(manifest["treeSha"], self._git("rev-parse", "HEAD^{tree}").decode().strip())
            self.assertEqual(first["manifestSha256"], hashlib.sha256(manifest_data).hexdigest())
            source = archive.read("Dockerfile.shard")
            derived = archive.read("Dockerfile")
            self.assertEqual(derived, source
                .replace(release.RELEASE_ARG, b'ARG NORIUM_RELEASE_SHA="' + self.commit.encode() + b'"')
                .replace(release.RELEASE_VERSION_ARG, b'ARG NORIUM_RELEASE_VERSION="2026.10.04"'))
            self.assertEqual(manifest["releaseVersion"], "2026.10.04")
            self.assertEqual(first["releaseVersion"], "2026.10.04")
            self.assertEqual(manifest["dockerfileDerivation"]["sourceSha256"], hashlib.sha256(source).hexdigest())
            self.assertEqual(manifest["dockerfileDerivation"]["derivedSha256"], hashlib.sha256(derived).hexdigest())
            source_root = next(row for row in manifest["sourceFiles"] if row["path"] == "Dockerfile")
            self.assertEqual(source_root["sha256"], hashlib.sha256(b"old root Dockerfile\n").hexdigest())
            for row in manifest["packageFiles"]:
                data = archive.read(row["path"])
                self.assertEqual(row["size"], len(data))
                self.assertEqual(row["sha256"], hashlib.sha256(data).hexdigest())
            mode = archive.getinfo("executable.sh").external_attr >> 16
            self.assertTrue(stat.S_ISREG(mode))
            self.assertEqual(stat.S_IMODE(mode), 0o755)
            self.assertEqual(archive.getinfo("Dockerfile").external_attr >> 16 & 0o777, 0o644)
            self.assertEqual(len({item.date_time for item in archive.infolist()}), 1)

    def test_dirty_and_untracked_worktree_content_is_not_packaged(self) -> None:
        (self.repo / "norium-back-end/main.py").write_bytes(b"dirty local content\n")
        (self.repo / "untracked.secret").write_bytes(b"synthetic untracked\n")
        result = release.build_release(self.repo, self.commit, self.repo / "output/dirty")
        with zipfile.ZipFile(result["zipPath"]) as archive:
            self.assertEqual(archive.read("norium-back-end/main.py"), b"synthetic\n")
            self.assertNotIn("untracked.secret", archive.namelist())

    def test_short_nonhex_uppercase_and_unresolved_sha_are_rejected(self) -> None:
        for value in (self.commit[:7], "HEAD", "f" * 39, "G" * 40, self.commit.upper(), "0" * 40):
            with self.subTest(value=value), self.assertRaises(release.ReleasePackageError):
                release.build_release(self.repo, value, self.repo / "output/invalid")

    def test_missing_required_file_is_rejected(self) -> None:
        self._git("rm", "norium-front-end/package-lock.json")
        self._git("commit", "--quiet", "-m", "synthetic missing lock")
        commit = self._git("rev-parse", "HEAD").decode().strip()
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, commit, self.repo / "output/missing")

    def test_secret_filenames_are_rejected(self) -> None:
        for path in (".env", "nested/.env.production", "nested/id_rsa", "nested/credentials.json", "private.key", ".aws/config"):
            with self.subTest(path=path), self.assertRaises(release.ReleasePackageError):
                release._reject_secret_filename(path)
        release._reject_secret_filename(".env.example")
        release._reject_secret_filename("app/services/oauth_credentials.py")
        release._reject_secret_filename("norium-back-end/app/infrastructure/persistence/azure_postgres_roots.pem")
        commit = self._commit_file("nested/.env", b"SYNTHETIC_ONLY=fixture\n")
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, commit, self.repo / "output/secret")

    def test_git_symlink_and_submodule_are_rejected_without_os_symlinks(self) -> None:
        blob = self._git("hash-object", "-w", "--stdin", data=b"../outside").decode().strip()
        self._git("update-index", "--add", "--cacheinfo", "120000," + blob + ",synthetic-link")
        self._git("commit", "--quiet", "-m", "synthetic git symlink")
        commit = self._git("rev-parse", "HEAD").decode().strip()
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, commit, self.repo / "output/link")
        self._git("update-index", "--force-remove", "synthetic-link")
        self._git("update-index", "--add", "--cacheinfo", "160000," + self.commit + ",synthetic-submodule")
        self._git("commit", "--quiet", "-m", "synthetic git submodule")
        commit = self._git("rev-parse", "HEAD").decode().strip()
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, commit, self.repo / "output/submodule")

    def test_unsafe_portable_archive_paths_are_rejected(self) -> None:
        for value in ("../escape", "/absolute", "C:/drive", "a\\b", "a//b", "a/./b", "a/../b", "a\0b", "a/NUL", "a/trailing.", ".git/config"):
            with self.subTest(path=repr(value)), self.assertRaises(release.ReleasePackageError):
                release.validate_archive_path(value)

    def test_tar_tamper_duplicate_traversal_and_link_are_rejected(self) -> None:
        data = b"safe"
        entries = {"safe.py": {"size": len(data), "gitBlobSha1": release._git_blob_sha1(data), "gitMode": "100644"}}
        cases = (
            [("safe.py", b"evil", tarfile.REGTYPE)],
            [("safe.py", data, tarfile.REGTYPE), ("safe.py", data, tarfile.REGTYPE)],
            [("../outside", data, tarfile.REGTYPE)],
            [("safe.py", b"", tarfile.SYMTYPE)],
            [("safe.py", b"", tarfile.LNKTYPE)],
        )
        for members in cases:
            with self.subTest(members=members), self.assertRaises(release.ReleasePackageError):
                release._read_archive(self._archive(members), entries)

    def test_export_filters_and_case_collisions_are_rejected(self) -> None:
        commit = self._commit_file(".gitattributes", b"executable.sh export-ignore\n")
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, commit, self.repo / "output/export")
        # Case-collision detection is tested through the tree adapter so it is
        # deterministic even on Windows volumes that cannot create both names.
        original_git = release._git
        tree = original_git(self.repo, "ls-tree", "-r", "-z", "--long", "--full-tree", self.commit)
        collision = tree + b"100644 blob " + release._git_blob_sha1(b"synthetic\n").encode() + b" 10\tNORIUM-BACK-END/MAIN.PY\0"
        def changed_tree(repo: Path, *arguments: str) -> bytes:
            return collision if arguments[0] == "ls-tree" else original_git(repo, *arguments)
        with mock.patch.object(release, "_git", side_effect=changed_tree), self.assertRaises(release.ReleasePackageError):
            release._snapshot_metadata(self.repo, self.commit)

    def test_manifest_collision_and_output_escape_are_rejected(self) -> None:
        commit = self._commit_file(release.MANIFEST_PATH, b"{}\n")
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, commit, self.repo / "output/collision")
        for output in (self.repo, self.repo.parent / "outside", self.repo / ".git/release", self.repo / "node_modules/release"):
            with self.subTest(output=output), self.assertRaises(release.ReleasePackageError):
                release.build_release(self.repo, self.commit, output)

    def test_existing_release_is_not_overwritten(self) -> None:
        result = release.build_release(self.repo, self.commit, self.repo / "output/existing")
        old_bytes = Path(result["zipPath"]).read_bytes()
        with self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, self.commit, self.repo / "output/existing")
        self.assertEqual(Path(result["zipPath"]).read_bytes(), old_bytes)

    def test_output_symlink_ancestor_is_rejected(self) -> None:
        output = self.repo / "output/linked"
        with mock.patch.object(Path, "is_symlink", autospec=True, side_effect=lambda path: path == output):
            with self.assertRaises(release.ReleasePackageError):
                release.build_release(self.repo, self.commit, output)

    def test_source_and_zip_size_limits_are_enforced(self) -> None:
        with mock.patch.object(release, "MAX_SOURCE_BYTES", 1), self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, self.commit, self.repo / "output/source-budget")
        with mock.patch.object(release, "MAX_ZIP_BYTES", 1), self.assertRaises(release.ReleasePackageError):
            release.build_release(self.repo, self.commit, self.repo / "output/zip-budget")
        self.assertFalse((self.repo / "output/zip-budget").exists())

    def test_dockerfile_derivation_preserves_crlf_and_rejects_extra_arg(self) -> None:
        source = b'FROM scratch\r\nARG NORIUM_RELEASE_SHA=""\r\nARG NORIUM_RELEASE_VERSION=""\r\nENV X=unchanged\r\n'
        timestamp = 1791108000
        derived = release.derive_dockerfile(source, self.commit, timestamp)
        self.assertEqual(derived.replace(self.commit.encode(), b"").replace(b"2026.10.04", b""), source)
        for bad in (b"FROM scratch\n", source + source,
                    source.replace(release.RELEASE_ARG, b"ARG NORIUM_RELEASE_SHA=other"),
                    source.replace(release.RELEASE_VERSION_ARG, b"ARG NORIUM_RELEASE_VERSION=other"),
                    source.replace(release.RELEASE_VERSION_ARG, b"")):
            with self.assertRaises(release.ReleasePackageError):
                release.derive_dockerfile(bad, self.commit, timestamp)

    def test_release_version_is_utc_and_independent_of_local_packaging_clock(self) -> None:
        self.assertEqual(release.release_version(1791158400), "2026.10.05")
        with mock.patch.object(release.time, "time", return_value=0):
            self.assertEqual(release.release_version(1791108000), "2026.10.04")


if __name__ == "__main__":
    unittest.main()
