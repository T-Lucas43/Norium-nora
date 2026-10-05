from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.infrastructure import release_metadata as release
from app.modules.system.router import router


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="norium-release-metadata-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "release.json"
        active = patch.object(release, "RELEASE_METADATA_PATH", self.path)
        active.start()
        self.addCleanup(active.stop)
        self.payload = {"environment": "homologacao", "version": "2026.10.05", "revision": "a" * 40}

    def test_build_metadata_roundtrip(self):
        release.write_release_metadata(**{
            "stage": "homologacao", "version": "2026.10.05", "revision": "a" * 40,
        })
        self.assertEqual(self.payload, release.release_snapshot())

    def test_never_overwrites_existing_metadata(self):
        self.path.write_text("existing", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            release.write_release_metadata("homologacao", "2026.10.05", "a" * 40)
        self.assertEqual("existing", self.path.read_text(encoding="utf-8"))

    def test_missing_metadata_is_unknown_even_with_runtime_environment_overrides(self):
        with patch.dict("os.environ", {"NORIUM_RELEASE_SHA": "b" * 40, "NORIUM_RELEASE_VERSION": "2026.10.06",
                                      "NORIUM_DEPLOYMENT_STAGE": "producao", "ENVIRONMENT": "production"}):
            self.assertEqual(release.UNKNOWN_RELEASE, release.release_snapshot())

    def test_image_identity_ignores_runtime_environment_overrides(self):
        self.path.write_text(json.dumps(self.payload), encoding="utf-8")
        with patch.dict("os.environ", {"NORIUM_RELEASE_SHA": "b" * 40, "NORIUM_DEPLOYMENT_STAGE": "producao"}):
            self.assertEqual(self.payload, release.release_snapshot())

    def test_invalid_values_are_never_exposed(self):
        for field, value in (("environment", "private-value"), ("environment", []),
                             ("revision", "private-value"), ("revision", "a" * 41),
                             ("version", "2026.02.30"), ("version", "2026.1.05"),
                             ("version", "private-value")):
            with self.subTest(field=field, value=value):
                self.path.write_text(json.dumps({**self.payload, field: value}), encoding="utf-8")
                self.assertEqual(release.UNKNOWN_RELEASE, release.release_snapshot())

    def test_corrupt_oversized_or_non_object_metadata_is_unknown(self):
        for value in (b"\xff", b"{", b"null", b"[]", b" " * 1025):
            self.path.write_bytes(value)
            self.assertEqual(release.UNKNOWN_RELEASE, release.release_snapshot())

    def test_ignores_non_public_fields(self):
        self.path.write_text(json.dumps({**self.payload, "private": "synthetic-private-value"}), encoding="utf-8")
        self.assertEqual(self.payload, release.release_snapshot())

    def test_endpoint_is_minimal_and_never_cached(self):
        self.path.write_text(json.dumps(self.payload), encoding="utf-8")
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client:
            response = client.get("/api/system/release")
        self.assertEqual(200, response.status_code)
        self.assertEqual(self.payload, response.json())
        self.assertEqual("no-store", response.headers["cache-control"])

    def test_writer_rejects_invalid_build_identity(self):
        with self.assertRaises(ValueError):
            release.write_release_metadata("homologacao", "2026.10.05", "")
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
